/**
 * app · page-technique —— 功法页：功法阁/图鉴、修炼与参悟、被动汇总。
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

  // 功法阁视图：'owned' 只显示已拥有（默认）| 'codex' 图鉴（全部 + 解锁条件）
  A.techView = 'owned';

  // 功法列表 DOM 的重建签名 = 已拥有 id 串。变化才重建，其余帧只改数值。
  A.techListSig = '';

  /** 功法被动属性的中文名 */
  A.PASSIVE_LABEL = {
    money: '工作金钱',
    energyMax: '精力上限',
    compute: '算力',
    deviceCost: '设备成本',
    shenshi: '神识',
    allOutput: '全部产出',
  };

  A.PASSIVE_KEYS = ['money', 'energyMax', 'compute', 'deviceCost', 'shenshi', 'allOutput'];

  A.selectTechnique = async function selectTechnique(techId) {
    if (!A.state) return;
    const r = Core.setTechnique(A.state, techId);
    if (!r.ok) {
      A.toast(r.msg || '无法修炼该功法', 'err');
      return;
    }
    A.dirty = true;
    const t = Core.techById(techId);
    A.toast('已开始修炼《' + t.name + '》', 'ok');
    A.renderAll();
    A.syncNow();
  }

  A.toggleCultivate = async function toggleCultivate() {
    if (!A.state) return;
    Core.setCultivating(A.state, !A.state.cultivating);
    A.dirty = true;
    A.renderAll();
    A.syncNow();
  }

  A.comprehend = async function comprehend() {
    if (!A.state) return;
    const beforePassive = Object.keys(A.state.learned)
      .filter((id) => A.state.learned[id].passive).length;

    const r = Core.comprehend(A.state, 1);
    if (!r.ok) {
      A.toast(r.msg, 'err');
      return;
    }
    A.dirty = true;

    const afterPassive = Object.keys(A.state.learned)
      .filter((id) => A.state.learned[id].passive).length;

    A.toast('参悟 +熟练度 ' + Math.round(r.gain) + '　耗灵气 ' + A.fmt(r.cost), 'ok');
    if (afterPassive > beforePassive) {
      setTimeout(() => {
        A.toast('熟练度圆满 —— 被动属性已转为常驻', 'ok');
      }, 380);
    }
    A.renderAll();
    A.syncNow();
  }

  /**
   * 刷新图鉴每一项的「已得 / 未得」与解锁条件文案。
   * 静态构建后调用一次（默认视图也填好，图鉴切过去就有内容），
   * 之后仅在已拥有集合变化时随 A.renderTechniquePage 再刷。
   */
  A.refreshCodexStates = function refreshCodexStates(list) {
    const els = A.$('tech-codex').querySelectorAll('[data-codex]');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const t = list.find((x) => x.id === el.dataset.codex);
      if (!t) continue;
      el.classList.toggle('owned', t.learned);
      const condEl = el.querySelector('[data-role="ccond"]');
      const stateEl = el.querySelector('[data-role="cstate"]');
      if (t.learned) {
        condEl.textContent = '';
        stateEl.textContent = '已得';
        stateEl.className = 'codex-state got';
      } else {
        // v3.6：条件后附当前进度（如「完成工作 ≥ 15 次（12/15）」）
        const p = t.condProgress;
        const prog = (p && p.need > 0)
          ? '（' + (p.need >= 10000 ? Core.fmtBig(Math.min(p.cur, p.need)) : A.fmtCount(Math.min(p.cur, p.need))) +
            '/' + (p.need >= 10000 ? Core.fmtBig(p.need) : A.fmtCount(p.need)) + '）'
          : '';
        condEl.textContent = '解锁：' + (t.unlockText || '未知条件') + prog;
        stateEl.textContent = '未得';
        stateEl.className = 'codex-state not';
      }
    }
  }

  A.renderTechniquePage = function renderTechniquePage() {
    const has = Core.techniqueUnlocked(A.state);

    A.$('technique-panel').classList.toggle('hidden', has);
    A.$('technique-main').classList.toggle('hidden', !has);
    A.$('tab-technique').classList.toggle('locked', !has);
    A.$('tab-technique-badge').textContent = has ? '已习得' : '未习得';

    if (!has) return;

    const tech = Core.currentTech(A.state);
    const list = Core.techniqueList(A.state);
    const learnedCount = list.filter((t) => t.learned).length;
    A.$('ui-tech-count').textContent = learnedCount + ' / ' + list.length + ' 已得';

    // ---- 当前修炼 ----
    if (tech) {
      const info = list.find((t) => t.id === tech.id);
      const rec = A.state.learned[tech.id];
      const rarity = GAME.techniques.rarities.find((r) => r.id === tech.rarity) || {};

      const rEl = A.$('ui-tech-rarity');
      rEl.textContent = rarity.name || '?';
      rEl.dataset.rarity = tech.rarity;

      A.$('ui-tech-name').textContent = tech.name;
      A.$('ui-tech-school').textContent = tech.school;
      A.$('ui-tech-desc').textContent = tech.desc;
      A.$('ui-tech-level').textContent = info ? info.level : 0;
      A.$('ui-tech-main').textContent = '+' + A.pct(info ? info.mainQiSpeed : 0);

      // 功法经验（v3.5）：独立等级，挂机 + 投向持续喂经验
      A.setText('ui-tech-exp-lv', 'Lv.' + (info ? info.level : 0));
      const expNeed = info ? info.expNeed : 0;
      const expProg = expNeed > 0 ? Math.max(0, Math.min(1, (rec.exp || 0) / expNeed)) : 0;
      const expBar = A.$('ui-tech-exp-bar');
      expBar.style.width = (expProg * 100).toFixed(1) + '%';
      A.setText('ui-tech-exp-val', Math.floor(rec.exp || 0) + ' / ' + A.fmtCount(Math.ceil(expNeed)));
      A.setText('ui-tech-exp-rate', '+' + (info ? info.expRate : 0).toFixed(2) + ' / 秒');

      // 熟练度（按当前段位内的进度显示，圆满后满格）
      const M = GAME.techniques.mastery;
      const PERFECT = M.length - 1;
      const perfect = info.masteryTier >= PERFECT;
      const segStart = M[Math.min(info.masteryTier, PERFECT)].need;
      const segEnd = perfect ? M[PERFECT].need : M[info.masteryTier + 1].need;
      const segLen = Math.max(1, segEnd - segStart);
      const segProg = perfect ? 1 : Math.max(0, Math.min(1,
        (rec.mastery - segStart) / segLen));

      A.$('ui-tech-mastery-tier').textContent = info.masteryTierName;
      A.$('ui-tech-mastery-bar').style.width = (segProg * 100).toFixed(1) + '%';
      A.$('ui-tech-mastery-val').textContent = perfect
        ? '圆满 · 被动已常驻'
        : (Math.floor(rec.mastery) + ' / ' + segEnd);
      A.$('ui-tech-cultivate').textContent = '+' + Core.cultivateSpeed(A.state).toFixed(2) + ' / 秒';

      // 被动属性
      const pbox = A.$('ui-tech-passive');
      const keys = Object.keys(tech.passive || {});
      if (!keys.length) {
        pbox.innerHTML = '<span class="off">本功法没有被动属性</span>';
      } else {
        pbox.innerHTML = keys.map((k) => {
          const on = rec.passive;
          return '<div class="row"><span class="' + (on ? 'on' : 'off') + '">' +
            (on ? '● ' : '○ ') + A.esc(A.PASSIVE_LABEL[k] || k) + ' ' + A.fmtSignedPct(tech.passive[k]) +
            '　—　' + (on ? '已常驻，切换功法不消失' : '熟练度修满后转为常驻') +
            '</span></div>';
        }).join('');
      }

      // 参悟
      const cost = Core.comprehendCost(A.state);
      const enough = A.state.qi.gte(cost);
      A.$('btn-comprehend').disabled = perfect || !enough;
      A.$('ui-comprehend-hint').textContent = perfect
        ? '熟练度已至圆满，继续参悟不再有意义。'
        : ('参悟：消耗 ' + A.fmt(cost) + ' 灵气，立即获得一笔熟练度'
           + (enough ? '' : '（灵气不足）'));
      A.$('btn-toggle-cultivate').textContent = A.state.cultivating ? '停止修炼' : '继续修炼';
    }

    // ---- 功法阁（只显示已拥有） / 图鉴 ----
    // 列表按「已拥有 id 签名」缓存：学会新功法才重建 DOM，其余帧只刷新数值。
    const ownedIds = list.filter((t) => t.learned).map((t) => t.id);
    const ownedSig = ownedIds.join(',');
    A.setText('ui-tech-count', ownedIds.length + ' / ' + list.length + ' 已得');

    if (A.techView === 'owned') {
      if (ownedSig !== A.techListSig) {
        A.techListSig = ownedSig;
        const R = GAME.techniques.rarities;
        A.$('tech-list').innerHTML = ownedIds.map((id) => {
          const t = GAME.techniques.list.find((x) => x.id === id);
          const r = R.find((x) => x.id === t.rarity) || {};
          return '<div class="tech-item" data-tech="' + t.id + '">' +
            '<span class="tech-rarity" data-rarity="' + A.esc(t.rarity) + '">' +
              A.esc(r.name || '?') + '</span>' +
            '<div class="tech-item-main">' +
              '<div class="tech-item-title">' + A.esc(t.name) +
                '<span class="tech-item-school">' + A.esc(t.school) + '</span></div>' +
              '<div class="tech-item-desc">' + A.esc(t.desc) + '</div>' +
              '<div class="tech-item-stats" data-role="tstats"></div>' +
            '</div>' +
            '<div class="tech-item-right" data-role="tright"></div>' +
          '</div>';
        }).join('');
      }
      const items = A.$('tech-list').querySelectorAll('.tech-item');
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const t = list.find((x) => x.id === el.dataset.tech);
        if (!t) continue;

        el.classList.toggle('active', t.active);

        const statsEl = el.querySelector('[data-role="tstats"]');
        const pl = Object.keys(t.passive || {}).map((k) =>
          A.esc(A.PASSIVE_LABEL[k] || k) + ' ' + A.fmtSignedPct(t.passive[k])).join('　');
        statsEl.innerHTML =
          '<span class="jade">灵气吸收 +' + (t.mainQiSpeed * 100).toFixed(1) + '%</span>' +
          '<span>等级 ' + t.level + '</span>' +
          '<span>熟练度 ' + A.esc(t.masteryTierName) + '</span>' +
          (pl ? '<span>被动 ' + pl + '</span>' : '');

        const rightEl = el.querySelector('[data-role="tright"]');
        let right = '<div class="lv">Lv.' + t.level + '</div>';
        if (t.active) right += '<span class="tag active">修炼中</span>';
        else if (t.passiveActive) right += '<span class="tag passive-on">被动常驻</span>';
        else right += '<span class="tag">可切换</span>';
        rightEl.innerHTML = right;
      }
    } else {
      // 图鉴：进度数字随状态实时变，每帧刷新（41 行纯文本，开销可忽略）
      A.refreshCodexStates(list);
    }

    // ---- 神识面板 ----
    const sh = Core.totalShenshi(A.state);
    A.$('ui-sh-total').textContent = A.fmtNum(sh);
    A.$('ui-sh-base').textContent = A.fmtNum(Core.shenshiBase(A.state));
    A.$('ui-sh-dev').textContent = '×' + A.fmtNum(Core.shenshiDeviceMultiplier(A.state));
    A.$('ui-sh-compute').textContent =
      '+' + ((Core.shenshiComputeMultiplier(A.state) - 1) * 100).toFixed(1) + '%';
    A.$('ui-sh-cultivate').textContent =
      '+' + ((Core.shenshiCultivateMultiplier(A.state) - 1) * 100).toFixed(1) + '%';

    // ---- 常驻被动汇总（每帧重拼但极少变化，写前比对省掉子树解析）----
    A.setHTML(A.$('passive-list'), A.PASSIVE_KEYS.map((k) => {
      const v = Core.passiveBonus(A.state, k);
      return '<div class="passive-row"><span class="k">' + A.esc(A.PASSIVE_LABEL[k]) + '</span>' +
        '<span class="v' + (v ? '' : ' off') + '">' + (v ? A.fmtSignedPct(v) : '—') + '</span></div>';
    }).join(''));
  }
})(typeof window !== 'undefined' ? window : globalThis);
