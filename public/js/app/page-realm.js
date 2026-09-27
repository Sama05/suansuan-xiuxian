/**
 * app · page-realm —— 境界页：境界/档位/渡劫进度渲染 + 顶栏时间四键逻辑。
 *
 * 本文件是 public/js/app 模块群的一员：全部模块共享入口注入的命名空间 A，
 * 函数在调用期经 A.xxx 解析（新增模块只需挂到 A 上并加入 index.html 脚本序）。
 * 可变状态统一由 state.js 初始化；请勿直接引用本文件，浏览器从 /js/app.js 进入。
 */
(function (root) {
  const A = (root.App = root.App || {});
  const D = root.Decimal;
  const GAME = root.GAME;
  const Core = root.GameCore;
  'use strict';

  /** 时间流速说明（境界页）—— 四键已搬到顶栏，这里只留当前档位与解锁提示 */
  A.renderTiers = function renderTiers() {
    A.setText('ui-tier-current',
      (A.state.timePaused ? '已暂停' : Core.tierInfo(A.state.timeTier).label));
    const maxT = Core.maxUnlockedTier(A.state);
    const nextLocked = GAME.time.tiers.find((x) => x.tier === maxT + 1);
    A.setText('ui-tier-hint', nextLocked
      ? ('下一档：' + nextLocked.label + '（' + A.realmNameOf(nextLocked.unlockRealm) + '解锁）')
      : '已解锁全部档位');
  }

  A.renderRealmPage = function renderRealmPage() {
    const info = Core.realmInfo(A.state);
    const target = Core.nextRealm(A.state);

    A.$('ui-realm').textContent = info.name;
    A.$('ui-realm-tier').textContent = 'TIER ' + A.state.realm;
    A.$('ui-realm-bar').style.width = (target.need
      ? Math.min(100, Math.max(0, A.state.realmProgress.toNumber() * 100))
      : 100) + '%';

    if (target.need) {
      A.$('ui-realm-need').textContent = '灵气 ' + A.fmt(A.state.qi) + ' / ' + A.fmt(target.need);
      A.$('ui-realm-next').textContent = '下一境：' + target.next.name;
    } else {
      A.$('ui-realm-need').textContent = '灵气 ' + A.fmt(A.state.qi);
      A.$('ui-realm-next').textContent = '已至此境巅峰';
    }

    const tech = Core.currentTech(A.state);
    A.$('ui-stat-shenshi').textContent = A.fmtNum(Core.totalShenshi(A.state));
    A.$('ui-stat-qimul').textContent = '×' + Core.qiMultiplier(A.state).toFixed(2);
    A.$('ui-stat-tech').textContent = tech ? tech.name : (Core.techniqueUnlocked(A.state) ? '无' : '未习得');

    A.$('ui-totaljobs').textContent = A.fmtCount(A.state.totalJobs) + ' 次';
    A.$('ui-rushcount').textContent = A.fmtCount(A.state.rushCount) + ' 次';
    A.$('ui-playtime').textContent = A.fmtRealDuration(A.state.playTime);
  }

  A.pickTier = async function pickTier(tier) {
    if (!A.state) return;
    const r = Core.setTimeTier(A.state, tier);
    if (!r.ok) {
      A.toast(r.msg, 'err');
      return;
    }
    A.dirty = true;
    A.toast('时间流速：' + Core.tierInfo(tier).label, 'ok');
    A.renderAll();
    A.syncNow();
  }

  /** 已解锁档位按 tier 升序 */
  A.sortedTiers = function sortedTiers() {
    return GAME.time.tiers.slice().sort((a, b) => a.tier - b.tier);
  }

  A.tcSlower = async function tcSlower() {
    if (!A.state) return;
    const tiers = A.sortedTiers().filter((t) => Core.tierUnlocked(A.state, t.tier));
    const idx = tiers.findIndex((t) => t.tier === A.state.timeTier);
    if (idx <= 0) {
      A.toast('已经是最低速了', 'err');
      return;
    }
    if (A.state.timePaused) {
      A.state.timePaused = false;
      A.dirty = true;
    }
    await A.pickTier(tiers[idx - 1].tier);
  }

  A.tcFaster = async function tcFaster() {
    if (!A.state) return;
    if (A.state.timePaused) {
      A.state.timePaused = false;
      A.dirty = true;
      A.renderAll();
      A.syncNow();
      return;
    }
    const tiers = A.sortedTiers().filter((t) => Core.tierUnlocked(A.state, t.tier));
    const idx = tiers.findIndex((t) => t.tier === A.state.timeTier);
    const next = tiers[idx + 1];
    if (!next) {
      A.toast('已是当前境界的最高速', 'err');
      return;
    }
    await A.pickTier(next.tier);
  }

  A.tcPlayPause = async function tcPlayPause() {
    if (!A.state) return;
    if (A.state.timePaused) {
      // 恢复 → 回到常速
      A.state.timePaused = false;
      A.dirty = true;
      const normal = GAME.time.normalTier || 2;
      if (Core.tierUnlocked(A.state, normal)) {
        await A.pickTier(normal);
      } else {
        A.toast('时间已恢复', 'ok');
        A.renderAll();
        A.syncNow();
      }
      return;
    }
    A.state.timePaused = true;
    A.dirty = true;
    A.toast('游戏时间已暂停（精力 / 投向 / 公司 / 修炼照常）', 'ok');
    A.renderAll();
    A.syncNow();
  }

  A.tcMax = async function tcMax() {
    if (!A.state) return;
    if (A.state.timePaused) {
      A.state.timePaused = false;
      A.dirty = true;
    }
    const maxT = Core.maxUnlockedTier(A.state);
    if (A.state.timeTier === maxT && !A.state.timePaused) {
      A.toast('已是最高速：' + Core.tierInfo(maxT).label, 'ok');
      return;
    }
    await A.pickTier(maxT);
  }

  A.renderClockControls = function renderClockControls() {
    const play = A.$('btn-tc-play');
    if (play) {
      const paused = !!A.state.timePaused;
      const want = paused ? '⏸' : '▶';
      if (play.textContent !== want) play.textContent = want;
      play.classList.toggle('paused', paused);
      play.title = paused ? '恢复常速（1 秒 = 1 小时）' : '暂停游戏时间';
    }
    const maxT = Core.maxUnlockedTier(A.state);
    const maxBtn = A.$('btn-tc-max');
    if (maxBtn) {
      maxBtn.classList.toggle('top', A.state.timeTier === maxT && !A.state.timePaused);
      maxBtn.title = '最大速度：' + Core.tierInfo(maxT).label;
    }
    const faster = A.$('btn-tc-faster');
    if (faster) {
      const atTop = A.state.timeTier >= maxT && !A.state.timePaused;
      faster.disabled = atTop;
    }
    const slower = A.$('btn-tc-slower');
    if (slower) {
      const tiers = A.sortedTiers().filter((t) => Core.tierUnlocked(A.state, t.tier));
      slower.disabled = tiers.length < 2 || tiers[0].tier === A.state.timeTier;
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
