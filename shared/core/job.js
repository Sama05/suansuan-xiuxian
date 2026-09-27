/**
 * game-core · job —— 工作（职业）：解锁链、推进与结算、催工。收益乘区（被动/神识/淬体）由 tick 统一施加，此处只算原始收益。
 *
 * 本文件属于 shared/core 模块群：所有模块共享同一个命名空间对象 C（函数在
 * 调用期经 C.xxx 惰性解析，因此模块间互相引用无需关心加载顺序）。请勿直接
 * 引用本文件，统一走 shared/game-core.js 聚合出口（Node）或 index.html 里
 * 按序加载的 <script>（浏览器）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory;
  } else {
    (root.__gcMods = root.__gcMods || []).push(factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (C, root) {
  const Decimal = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('../decimal.js') : root.Decimal;
  const GAME = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('../game-config.js') : root.GAME;
  const D = Decimal;

  // ============================================================
  // 工作系统
  // ============================================================

  C.jobById = function jobById(id) {
    if (!id) return null;
    return GAME.jobs.find((j) => j.id === id) || null;
  }

  /** 单次耗时（游戏秒） */
  C.jobDurationSeconds = function jobDurationSeconds(job) {
    return (job.hours || 0) * C.SEC_PER_HOUR;
  }

  /** 某工作已完成次数 */
  C.jobDoneCount = function jobDoneCount(s, id) {
    return s.jobDone[id] || 0;
  }

  /** 工作是否已解锁 */
  C.jobUnlocked = function jobUnlocked(s, job) {
    if (!job) return false;
    const u = job.unlock || {};
    if (s.realm < (u.realm || 0)) return false;
    if (u.after && C.jobDoneCount(s, u.after.id) < u.after.times) return false;
    return true;
  }

  /** 未解锁的原因（用于前端显示） */
  C.lockedReason = function lockedReason(s, job) {
    if (!job) return '';
    const u = job.unlock || {};
    if (s.realm < (u.realm || 0)) {
      return '需达到「' + C.realmName(u.realm) + '」';
    }
    if (u.after && C.jobDoneCount(s, u.after.id) < u.after.times) {
      const prev = C.jobById(u.after.id);
      return '需先完成「' + (prev ? prev.name : u.after.id) + '」'
        + u.after.times + ' 次（当前 ' + C.jobDoneCount(s, u.after.id) + '/' + u.after.times + '）';
    }
    return '';
  }

  /** 单次工作的收益（不含各种被动/神识乘区，那些在 tick 里统一施加） */
  C.jobIncome = function jobIncome(job) {
    return {
      money: new D(job.money || 0),
      spirit: new D(job.spirit || 0),
      stone: new D(job.stone || 0),
    };
  }

  /** 选择工作；切到不同工作会清空当前进度 */
  C.setJob = function setJob(s, jobId) {
    const job = C.jobById(jobId);
    if (!job) return { ok: false, msg: '工作不存在' };
    if (!C.jobUnlocked(s, job)) return { ok: false, msg: C.lockedReason(s, job) || '尚未解锁' };
    if (s.jobId !== jobId) {
      s.jobId = jobId;
      s.jobProgress = 0;
    }
    s.working = true;
    return { ok: true, jobId: jobId };
  }

  /** 暂停 / 恢复自动工作 */
  C.setWorking = function setWorking(s, on) {
    s.working = !!on;
    return { ok: true, working: s.working };
  }

  /**
   * 手动催工 —— 立即完成当前工作的若干份。
   * 会清空当前未完成的进度（那一份已经被你手动干完了），避免与自动结算重复计数。
   */
  C.rushJob = function rushJob(s, times) {
    if (!GAME.rush.enabled) return { ok: false, msg: '手动催工未开放' };
    const job = C.jobById(s.jobId);
    if (!job) return { ok: false, msg: '尚未选择工作' };
    if (!s.working) s.working = true;

    const n = Math.max(1, Math.min(Math.floor(times || 1), 1000));
    let done = 0;
    let money = new D(0);
    let spirit = new D(0);
    let stone = new D(0);

    for (let i = 0; i < n; i++) {
      if (s.energy < job.energy) break;
      s.energy -= job.energy;
      money = money.add(new D(job.money || 0));
      if (job.spirit) spirit = spirit.add(new D(job.spirit));
      if (job.stone) stone = stone.add(new D(job.stone));
      s.jobDone[job.id] = (s.jobDone[job.id] || 0) + 1;
      s.totalJobs += 1;
      done += 1;
    }

    if (done === 0) return { ok: false, msg: '精力不足' };

    const moneyMul = (1 + C.passiveBonus(s, 'money')) * (1 + C.passiveBonus(s, 'allOutput'));
    const qiMul = C.qiMultiplier(s);
    const allOut = 1 + C.passiveBonus(s, 'allOutput');

    s.rushCount += done;
    s.jobProgress = 0;
    s.money = s.money.add(money.mul(moneyMul));
    if (qiMul > 0 && spirit.gt(0)) s.qi = s.qi.add(spirit.mul(qiMul));
    if (allOut > 0 && stone.gt(0)) s.spiritStone = s.spiritStone.add(stone.mul(allOut));

    return { ok: true, done: done, money: money.mul(moneyMul), spirit: spirit.mul(qiMul), stone: stone.mul(allOut) };
  }

  /**
   * 推进工作进度并结算完成的份数。
   * 精力不足时进度会停在满格等待恢复，而不是丢弃进度。
   * 注意：此处只算「原始收益」，乘区（被动 / 神识 / 功法）由 tick 统一施加。
   */
  C.advanceWork = function advanceWork(s, dtGame) {
    const job = C.jobById(s.jobId);
    const empty = { money: new D(0), spirit: new D(0), stone: new D(0), done: 0 };
    if (!job || !s.working || dtGame <= 0) return empty;

    const dur = C.jobDurationSeconds(job);
    if (dur <= 0) return empty;

    s.jobProgress += dtGame;

    let done = 0;
    let money = new D(0);
    let spirit = new D(0);
    let stone = new D(0);
    let guard = 0;

    while (s.jobProgress >= dur && guard < 100000) {
      if (s.energy < job.energy) {
        // 精力不够完成这一份：进度停在满格，恢复后继续
        s.jobProgress = dur;
        break;
      }
      s.energy -= job.energy;
      money = money.add(new D(job.money || 0));
      if (job.spirit) spirit = spirit.add(new D(job.spirit));
      if (job.stone) stone = stone.add(new D(job.stone));
      s.jobProgress -= dur;
      s.jobDone[job.id] = (s.jobDone[job.id] || 0) + 1;
      s.totalJobs += 1;
      done += 1;
      guard += 1;
    }

    if (guard >= 100000) s.jobProgress = s.jobProgress % dur;
    if (s.jobProgress > dur) s.jobProgress = dur;

    return { money: money, spirit: spirit, stone: stone, done: done };
  }


  return C;
});
