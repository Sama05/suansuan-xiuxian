/**
 * app · page-rebirth —— 渡劫与兵解：成功率面板、转生面板、确认弹窗、服务端渡劫轮询。
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

  /** 境界名（核心层没有导出 realmName，这里直接从配置取，避免再造一份表） */
  A.realmNameOf = function realmNameOf(idx) {
    const r = GAME.realms[idx];
    return r ? r.name : ('境界 ' + idx);
  }

  /**
   * 渡劫面板。
   *
   * 成功率必须**拆开显示**：只给一个总数，玩家不知道「再堆一点算力能不能换 3 个点」，
   * 也就无从准备 —— 而「准备」是这个系统唯一的玩法。四项里有三项是玩家能主动提的：
   * 算力冗余（买设备）、功法造诣（修满功法）、道行底蕴（累计转生）。
   */
  A.renderTribulationPage = function renderTribulationPage() {
    const cfg = GAME.tribulation;
    if (!cfg || !cfg.implemented) return;
    const s = Core.tribulationSummary(A.state);
    if (!s) return;

    const maxLv = s.maxLevel || 40;
    A.setText('ui-tb-level', String(s.level));
    A.setText('ui-tb-max', ' / ' + maxLv + ' 层');
    A.setText('ui-tb-attempts', A.fmtCount(s.attempts));
    A.setText('ui-tb-failures', A.fmtCount(s.failures));

    const chk = A.$('chk-auto-tribulation');
    if (chk && document.activeElement !== chk) chk.checked = s.auto !== false;

    const atMax = s.atMax;
    const ready = s.ready;
    A.setText('ui-tb-rate', atMax ? '已至最高境界' : (s.odds.rate * 100).toFixed(1) + '%');
    A.setText('ui-tb-hint', atMax
      ? '已至元婴 —— 本作最高境界；再往前只能兵解重来'
      : (ready ? '灵气已满 —— 可以渡劫了' : '灵气满格之后，须渡劫方能升境'));

    const btn = A.$('btn-tribulation');
    if (btn) {
      btn.disabled = !ready;
      btn.textContent = atMax ? '无劫可渡'
        : (ready ? ('渡劫 → ' + A.realmNameOf(s.odds.nextRealm)) : '渡劫（灵气未满）');
    }

    // ---------- 成功率构成 ----------
    const o = s.odds;
    const P = cfg.prepare || {};
    const rows = [
      ['境界基础', o.base, 1],
      ['算力冗余', o.computeAdd, P.computeCap || 0.15],
      ['功法造诣', o.perfectAdd, P.perfectCap || 0.1],
      ['道行底蕴', o.daoAdd, P.daoCap || 0.08],
    ];
    let html = rows.map((r) => {
      const k = r[0], v = r[1], cap = r[2];
      const w = cap > 0 ? Math.min(1, v / cap) : 0;
      return '<div class="tb-odd-row">' +
        '<span class="k">' + A.esc(k) + '</span>' +
        '<span class="v ' + (v > 0 ? 'pos' : 'zero') + '">' +
          (v > 0 ? '+' + (v * 100).toFixed(1) + '%' : '—') + '</span>' +
        '<span class="bar"><i style="width:' + Math.round(w * 100) + '%"></i></span>' +
      '</div>';
    }).join('');
    html += '<div class="tb-odd-row total">' +
      '<span class="k">合计成功率</span>' +
      '<span class="v">' + (o.rate * 100).toFixed(1) + '%</span>' +
      '<span class="bar"><i style="width:' + Math.round(o.rate * 100) + '%"></i></span>' +
    '</div>';
    html += '<div class="dim" style="font-size:11px;margin-top:7px">' +
      '算力冗余基准 ' + Core.fmtBig(o.computeBase) +
      '（当前实际算力是它的 10^' + o.decades.toFixed(2) + ' 倍，每高 10 倍 +' +
      ((P.computePerDecade || 0.03) * 100).toFixed(0) + '%）' +
      '　已修满功法 ' + o.perfectCount + ' 本（上限 +' +
      ((P.perfectCap || 0.1) * 100).toFixed(0) + '%）' +
      '　累计道行 ' + A.fmtCount(o.daoTotal) +
    '</div>';
    if (A.$('ui-tb-odds').innerHTML !== html) A.$('ui-tb-odds').innerHTML = html;

    // ---------- 渡劫淬体加成 ----------
    const bl = s.boons.map((b) =>
      '<span class="tb-boon">' + A.esc(b.name) +
        ' <b>+' + (b.value * 100).toFixed(0) + '%</b>' +
        '<span class="dim">（每层 +' + (b.per * 100).toFixed(0) + '%）</span></span>'
    ).join('');
    if (A.$('ui-tb-boons').innerHTML !== bl) A.$('ui-tb-boons').innerHTML = bl;
  }

  /**
   * 下一次兵解之后的转生折扣。
   * 界面文案与确认弹窗共用，避免两处各算一遍导致数字不一致。
   */
  A.nextRebirthFactor = function nextRebirthFactor() {
    return Core.rebirthFactorAt(Core.rebirthCount(A.state) + 1);
  }

  /** 当前有效设备算力（已应用转生衰减）—— 用于把「压掉几个数量级」讲成人话 */
  A.effectiveDeviceCompute = function effectiveDeviceCompute() {
    return Core.deviceComputeEffective(A.state);
  }

  /**
   * 转生面板。
   *
   * 关键约定：这里**不自己算**道行、折扣、升级成本 —— 全部走 Core 的同名函数。
   * 界面、引擎、服务端共用同一份口径，否则会出现「界面说能拿 100，服务端只给 60」
   * 这类对不上账的问题（与市场价、股市报价同一条纪律）。
   */
  A.renderRebirthPage = function renderRebirthPage() {
    const rbCfg = GAME.rebirth;
    if (!rbCfg || !rbCfg.implemented) return;

    const unlocked = Core.rebirthUnlocked(A.state);
    // 面板显示条件放宽：已兵解过就展开（兵解后境界会掉回凡人，
    // 若面板跟着锁上，玩家既看不到道行也花不掉它）。
    const visible = unlocked || Core.rebirthCount(A.state) > 0;
    A.$('rb-lock').classList.toggle('hidden', visible);
    A.$('rb-main').classList.toggle('hidden', !visible);

    if (!visible) {
      A.$('ui-rb-lock').textContent = Core.rebirthLockedReason(A.state) || '尚未达到兵解条件';
      A.$('ui-rb-hint').textContent = '元婴之后，才有资格谈重塑';
      return;
    }

    // 按钮：达不到门槛时禁用并说明原因（面板仍然展开，道行照花）
    const rbBtnEl = A.$('btn-rebirth');
    if (rbBtnEl) {
      rbBtnEl.disabled = !unlocked;
      rbBtnEl.textContent = unlocked ? '兵解转生' : (Core.rebirthLockedReason(A.state) || '尚不可兵解');
    }

    const st = Core.rebirthState(A.state);
    const count = Core.rebirthCount(A.state);
    const disc = Core.rebirthDiscount(A.state);
    const dao = Math.floor(st.dao || 0);
    const daoTotal = Math.floor(st.daoTotal || 0);
    const gain = Core.rebirthDaoGain(A.state, 'active');
    const gainPassive = Core.rebirthDaoGain(A.state, 'passive');

    const discTxt = disc >= 1 ? '原值' : '^' + disc.toFixed(2);
    A.setText('ui-rb-hint', '已兵解 ' + count + ' 次 · 设备算力衰减 ' + discTxt);
    A.setText('ui-rb-count', String(count));
    A.setText('ui-rb-dao', A.fmtCount(dao));
    A.setText('ui-rb-daototal', A.fmtCount(daoTotal));
    A.setText('ui-rb-disc', discTxt);
    A.setText('ui-rb-gain', String(gain));
    A.setText('ui-rb-gain-passive', String(gainPassive));

    const nextGain = Math.floor((rbCfg.daoBase || 100) * (1 + (rbCfg.daoPerRun || 0.6) * (count + 1)));
    A.setText('ui-rb-nextline',
      '本次兵解后：设备算力被压至 ^' + A.nextRebirthFactor().toFixed(2) +
      '，之后每次兵解可得 ' + nextGain + ' 道行以上');

    // ---- 道行加成 ----
    const dl = (rbCfg.perks || []).map((p) => {
      const lv = Core.perkLevel(A.state, p.id);
      const maxLv = p.maxLevel || 0;
      const maxed = lv >= maxLv;
      const cost = Core.perkCost(A.state, p.id);
      const cur = lv * (p.per || 0);
      const curTxt = p.unit === '%'
        ? '+' + (cur * 100).toFixed(0) + '%'
        : '+' + A.fmtNum(cur) + (p.unit || '');
      return '<div class="rb-perk' + (maxed ? ' maxed' : '') + '">' +
        '<div class="rb-perk-top">' +
          '<span class="rb-perk-name">' + A.esc(p.name) + '</span>' +
          '<span class="rb-perk-lv">Lv ' + lv + ' / ' + maxLv + '</span>' +
        '</div>' +
        '<div class="rb-perk-desc">' + A.esc(p.desc || '') + '</div>' +
        '<div class="rb-perk-now">' + (lv > 0 ? '当前 ' + curTxt : '尚未激活') + '</div>' +
        '<div class="rb-perk-bar"><i style="width:' +
          (maxLv ? Math.round(lv / maxLv * 100) : 0) + '%"></i></div>' +
        '<div class="rb-perk-foot">' +
          '<span class="rb-perk-cost">' +
            (maxed ? '已满级' : '升级需 ' + A.fmtCount(cost) + ' 道行') + '</span>' +
          '<button class="btn" data-perk="' + p.id + '"' +
            (maxed || dao < cost ? ' disabled' : '') + '>' + (maxed ? '满级' : '升级') + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
    if (A.$('rb-perk-list').innerHTML !== dl) A.$('rb-perk-list').innerHTML = dl;

    // ---- 兵解记录 ----
    const hist = (st.history || []).slice(-8).reverse();
    const hl = hist.map((h) =>
      '<div class="rb-hist">' +
        '<span class="n">#' + h.n + '</span>' +
        '<span class="r">' + A.esc(h.realmName || ('境界 ' + h.realm)) + '</span>' +
        (h.mode === 'passive' ? '<span class="mode">渡劫失败</span>' : '') +
        '<span class="d">+' + A.fmtCount(h.dao || 0) + ' 道行</span>' +
        '<span class="m">' + A.esc(Core.fmtGameDate(h.gameSeconds || 0)) + '</span>' +
      '</div>').join('');
    if (A.$('rb-history').innerHTML !== hl) {
      A.$('rb-history').innerHTML = hl || '<div class="dim" style="font-size:12px">尚未兵解过</div>';
    }
  }

  /** 打开兵解确认弹窗 —— 必须列清「失去 / 保留 / 获得」三栏，这是不可撤销的操作 */
  A.openRebirthModal = function openRebirthModal() {
    if (!A.state) return;
    if (!Core.rebirthUnlocked(A.state)) {
      A.toast(Core.rebirthLockedReason(A.state) || '尚未达到兵解条件', 'err');
      return;
    }
    const disc = Core.rebirthDiscount(A.state);
    const gain = Core.rebirthDaoGain(A.state, 'active');

    const lost = [
      '境界与灵气 —— 退回 <b>凡人</b>，灵气清零、境界进度清零',
      '金钱与灵石 —— 归零（回到起手 ' + A.fmtNum(GAME.base.startMoney) + ' 金钱）',
      '投向配置与累计产出 —— 回到「全修仙」，累计统计清零',
      '本世攒下的算力加成（AI 投向逐 tick 累出来的部分）',
      '公司 —— 注册状态、生产线、仓库、库存与全部经营统计一并清空',
      '股市 —— 持仓、成本与全部成交统计一并清空',
      '功法熟练度进度 —— 段位与已修满的常驻被动保留',
      '精力上限 —— 由 ' + A.fmtNum(Math.round(Core.maxEnergy(A.state))) + ' 回落',
      '时间流速 —— 回落到档 1（渡劫成功后会自动跟上）',
    ];
    const keep = [
      '功法 —— 本体、熟练度段位、已修满的常驻被动全保留（只清熟练度进度）',
      '工作履历 —— 已完成次数保留，升职链不用重跑',
      '设备 —— 全部保留，但算力被压至 <b>' + A.fmt(A.effectiveDeviceCompute()) +
        '</b>（衰减指数 ' + (disc >= 1 ? '^1.00 原值' : '^' + disc.toFixed(2)) + '）',
      '渡劫淬体 —— <b>' + Core.tribulationLevel(A.state) + ' 层</b>全项永久加成，跨兵解不丢',
      '道行与所有永久加成',
      '游戏内日期与行情时钟 —— 不会倒流',
    ];
    const gainList = [
      '<b>' + gain + '</b> 道行（可累积，用于购买永久加成）',
      '设备算力衰减下次放宽至 <b>^' + A.nextRebirthFactor().toFixed(2) + '</b>',
      '此后每一世都以更高的境界基础神识与灵气速度起步',
    ];

    A.$('rb-lost-list').innerHTML = lost.map((t) => '<li>' + t + '</li>').join('');
    A.$('rb-keep-list').innerHTML = keep.map((t) => '<li>' + t + '</li>').join('');
    A.$('rb-gain-list').innerHTML = gainList.map((t) => '<li>' + t + '</li>').join('');
    A.$('rebirth-modal').classList.remove('hidden');
  }

  A.closeRebirthModal = function closeRebirthModal() {
    A.$('rebirth-modal').classList.add('hidden');
  }

  /** 执行兵解（服务端权威） */
  A.doRebirthNow = async function doRebirthNow() {
    A.closeRebirthModal();
    const r = await A.serverAction('rebirth', { mode: 'active' });
    if (!r) return;
    A.toast('兵解完成：第 ' + r.count + ' 世 · 获得 ' + A.fmtCount(r.dao) +
      ' 道行 · 设备算力衰减 ^' + r.discount.toFixed(2));
  }

  /** 用道行升一级加成（服务端权威） */
  A.buyRebirthPerk = async function buyRebirthPerk(id) {
    const r = await A.serverAction('buyPerk', { perkId: id });
    if (!r) return;
    A.toast('「' + r.name + '」升至 Lv' + r.level + '，消耗 ' + A.fmtCount(r.cost) + ' 道行');
  }

  A.tryTribulation = async function tryTribulation() {
    if (!A.state || A.tribulating) return;
    const now = Date.now();
    if (now - A.lastTribulationAt < 1200) return;
    A.lastTribulationAt = now;
    A.tribulating = true;
    try {
      // 先把本地进度推上去，避免服务端手里的灵气还差一点点而拒收
      await A.syncNow(true);
      const r = await A.serverAction('tribulation', {});
      if (r && r.ok) A.announceTribulation(r);
    } catch (e) {
      A.toast(e.message || '渡劫失败', 'err');
    } finally {
      A.tribulating = false;
    }
  }

  /** 渡劫结果的一次性提示 —— 成功/失败都要说清楚发生了什么 */
  A.announceTribulation = function announceTribulation(r) {
    if (r.success) {
      A.toast('渡劫成功：境界 → ' + (r.realmName || '') +
        '　渡劫淬体 ' + r.level + ' 层（全项基础加成提升）', 'ok');
      A.pushEvent('渡劫成功 → ' + (r.realmName || '') +
        '　渡劫淬体 ' + r.level + ' 层，全项基础加成永久提升', 'good');
      return;
    }
    let msg = '渡劫失败：' + (r.lostRealmName || '') + ' 境界崩解，被迫兵解';
    if (r.fullWipe) msg += ' · 未及元婴，一切归零';
    msg += '（+' + A.fmtCount(r.dao) + ' 道行）';
    A.toast(msg, 'err');
    A.pushEvent('渡劫失败：' + (r.lostRealmName || '') + ' → 被动兵解' +
      (r.fullWipe ? '（未及元婴，设备与功法一并清空）' : '') +
      '，获得 ' + A.fmtCount(r.dao) + ' 道行', 'err');
  }
})(typeof window !== 'undefined' ? window : globalThis);
