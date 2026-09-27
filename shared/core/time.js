/**
 * game-core · time —— 时间与境界：档位解锁/切换、游戏日历、精力上限与恢复、境界信息。档位完全手动（顶栏四键），autoTier 仅为旧存档兼容。
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
  // 时间系统
  // ============================================================

  /** 取档位配置（非法档位回落到第一档） */
  C.tierInfo = function tierInfo(tier) {
    return GAME.time.tiers.find((t) => t.tier === tier) || GAME.time.tiers[0];
  }

  /** 当前境界下已解锁的最高档位 */
  C.maxUnlockedTier = function maxUnlockedTier(s) {
    let best = GAME.time.tiers.length ? GAME.time.tiers[0].tier : 1;
    for (const t of GAME.time.tiers) {
      if (s.realm >= t.unlockRealm) best = Math.max(best, t.tier);
    }
    return best;
  }

  C.tierUnlocked = function tierUnlocked(s, tier) {
    return tier <= C.maxUnlockedTier(s);
  }

  /** 切档；未解锁的档位会被拒绝。手动选档会关闭「自动跟随」。 */
  C.setTimeTier = function setTimeTier(s, tier) {
    tier = Math.floor(tier);
    const t = GAME.time.tiers.find((x) => x.tier === tier);
    if (!t) return { ok: false, msg: '不存在的档位' };
    if (!C.tierUnlocked(s, tier)) return { ok: false, msg: '该档位需 ' + C.realmName(t.unlockRealm) + ' 解锁' };
    s.timeTier = tier;
    s.autoTier = false;
    return { ok: true, tier: tier, auto: false };
  }

  /** 打开/关闭「自动跟随最高已解锁档位」 */
  C.setAutoTier = function setAutoTier(s, on) {
    s.autoTier = !!on;
    if (s.autoTier) s.timeTier = C.maxUnlockedTier(s);
    return { ok: true, auto: s.autoTier, tier: s.timeTier };
  }

  C.realmName = function realmName(idx) {
    const r = GAME.realms[idx];
    return r ? r.name : ('境界 ' + idx);
  }

  /**
   * 精力恢复速度（点 / 现实秒）—— **随境界提升**。
   *
   * 为什么不能恒为 1：工作的单次精力消耗随境界涨（15 → 38 → 80 → 200 → 520），
   * 恢复恒为 1 意味着元婴期做一份工作要干等 8 分钟以上，纯耗时间不产生决策。
   * 恢复速度按 ~×1.45 / 境抬升，把等待压回一分钟上下。
   *
   * 为什么这不会让收入失控：高档位下工作收益的瓶颈会自动从「精力」切到
   * 「游戏时间」（advanceWork 取两者较小值）—— 元婴档 1 秒 = 1 游戏月时，
   * 一份 86400 游戏小时的工作时间下限就是 120 现实秒，恢复再快也加不了钱，
   * 只是把「干等」变成「接着干」。
   */
  C.energyRegen = function energyRegen(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const v = (r && typeof r.regen === 'number') ? r.regen : GAME.energy.regenPerSecond;
    return C.num(v, 1);
  }

  /** 当前档位：1 现实秒 = 多少游戏秒 */
  C.gameSecondsPerRealSecond = function gameSecondsPerRealSecond(s) {
    // 暂停档：游戏时间停走，精力恢复 / 投向 / 公司 / 修炼照常（它们走现实时间）
    if (s.timePaused) return 0;
    return C.tierInfo(s.timeTier).gameSecondsPerRealSecond;
  }

  /** 游戏秒 → 日历 */
  C.gameDate = function gameDate(gs) {
    gs = Math.max(0, gs || 0);
    const days = Math.floor(gs / C.SEC_PER_DAY);
    const years = Math.floor(days / C.DAYS_PER_YEAR);
    const remDays = days % C.DAYS_PER_YEAR;
    return {
      year: GAME.time.startYear + years,
      month: Math.floor(remDays / C.DAYS_PER_MONTH) + 1,
      day: (remDays % C.DAYS_PER_MONTH) + 1,
      hour: Math.floor((gs % C.SEC_PER_DAY) / C.SEC_PER_HOUR),
      minute: Math.floor((gs % C.SEC_PER_HOUR) / C.SEC_PER_MIN),
      /** 自游戏起点起经过的整年数 */
      years: years,
      /** 自游戏起点起经过的整天数 */
      days: days,
    };
  }

  C.pad2 = function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** 游戏内时间显示：2000年1月1日 00:00 */
  C.fmtGameDate = function fmtGameDate(gs) {
    const d = C.gameDate(gs);
    return d.year + '年' + d.month + '月' + d.day + '日 ' + C.pad2(d.hour) + ':' + C.pad2(d.minute);
  }

  /** 游戏时长显示：用游戏内单位表述一段时长（秒） */
  C.fmtGameDuration = function fmtGameDuration(sec) {
    // 0 必须显示为 0 —— 否则进度条归零时会显示成「1 分钟」，看着像没结算干净
    if (!(sec > 0)) return '0';
    if (sec < C.SEC_PER_HOUR) return Math.max(1, Math.round(sec / C.SEC_PER_MIN)) + ' 分钟';
    if (sec < C.SEC_PER_DAY) return (sec / C.SEC_PER_HOUR).toFixed(sec < 10 * C.SEC_PER_HOUR ? 1 : 0) + ' 小时';
    if (sec < C.SEC_PER_MONTH) return (sec / C.SEC_PER_DAY).toFixed(sec < 10 * C.SEC_PER_DAY ? 1 : 0) + ' 天';
    if (sec < C.SEC_PER_YEAR) return (sec / C.SEC_PER_MONTH).toFixed(sec < 10 * C.SEC_PER_MONTH ? 1 : 0) + ' 个月';
    return (sec / C.SEC_PER_YEAR).toFixed(sec < 10 * C.SEC_PER_YEAR ? 1 : 0) + ' 年';
  }

  // ============================================================
  // 精力
  // ============================================================

  /**
   * 当前精力上限 = 境界基础 ×(1 + 功法被动) ×(1 + 道行 · 精力淬炼)。
   * 精力是与时间档位解耦的产能硬上限，所以这条加成的实际影响比它看起来大。
   */
  C.maxEnergy = function maxEnergy(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const base = (r && r.maxEnergy) || (GAME.realms[0] && GAME.realms[0].maxEnergy) || 100;
    return base
      * (1 + C.passiveBonus(s, 'energyMax'))
      * (1 + C.perkValue(s, 'energyMax'))
      * (1 + C.tribulationBonus(s, 'energyMax'));
  }

  // ============================================================
  // 修仙线
  // ============================================================

  /** 获取当前境界信息 */
  C.realmInfo = function realmInfo(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    return r || GAME.realms[0];
  }

  /**
   * 当前境界的升级目标信息
   * 语义：realms[i].need 表示「从 realms[i] 突破到 realms[i+1] 所需的灵气」
   * 返回 { current, next, need }；已至最高境界时 next 为 null、need 为 null
   */
  C.nextRealm = function nextRealm(s) {
    const current = C.realmInfo(s);
    const next = GAME.realms[s.realm + 1] || null;
    if (!next) return { current: current, next: null, need: null };
    return { current: current, next: next, need: new D(current.need) };
  }

  /** 是否已习得功法 */
  C.techniqueUnlocked = function techniqueUnlocked(s) {
    return !!s.technique;
  }

  /** 当前是否允许产出灵气 —— 没功法就不允许（用户要求） */
  C.spiritAllowed = function spiritAllowed(s) {
    if (!GAME.techniques.requireForSpirit) return true;
    return C.techniqueUnlocked(s);
  }



  return C;
});
