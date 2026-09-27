/**
 * app · events —— 事件通知栏：客户端差值观察器（不进存档），入账聚合窗口与空闲行情前瞻。
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

  /**
   * 页面最上方的播报条。
   *
   * 设计取舍：**事件在客户端生成，不进存档。**
   * 所有事件的来源（自动卖出入账、投向调整、功法突破、渡劫、境界突破）
   * 都能在两次渲染之间从 A.state 的差值里读出来 —— 公司收入看 totalRevenue 的增量、
   * 段位看 learned[id].tier、境界看 realm。做成客户端观察器，就完全不用动
   * 存档结构与后端防作弊清单（那些字段每一个都要配套「只增 / 夹取」逻辑）。
   * 代价是刷新页面后历史清空 —— 通知本来就是「现在正在发生什么」，不是账本。
   */
  A.EV_MAX = 40;

  A.events = [];

  A.lastEventAt = Date.now();

  A.evSeq = 0;

  /** 观察快照：与上一帧比较用 */
  A.evSnap = {
    realm: -1, techTiers: {}, techLevels: {}, learnedSet: null, revenue: null, autoSold: 0, alloc: {},
  };

  /** 自动卖出入账的聚合窗口：攒 6 秒报一次，不然每个生产周期（20s 内多次）都刷屏 */
  A.sellAccum = new D(0);

  A.sellAccumSince = 0;

  A.SELL_WINDOW_MS = 6000;

  /** 多久没有新事件就开始播行情前瞻 */
  A.IDLE_FORECAST_MS = 20000;

  A.pushEvent = function pushEvent(text, kind) {
    const now = Date.now();
    A.events.unshift({
      id: ++A.evSeq, text: text, kind: kind || 'info',
      at: now, game: Core.fmtGameDate(A.state.gameSeconds),
    });
    if (A.events.length > A.EV_MAX) A.events.length = A.EV_MAX;
    A.lastEventAt = now;
    A.renderEventBar();
  }

  A.renderEventBar = function renderEventBar() {
    const e = A.events[0];
    if (!e) return;
    const txtEl = A.$('ui-ev-text');
    if (txtEl) txtEl.textContent = e.text;
    const dot = A.$('ui-ev-dot');
    if (dot) dot.className = 'ev-dot ' + (e.kind || 'info');
    const cnt = A.$('ui-ev-count');
    if (cnt) {
      cnt.hidden = A.events.length <= 1;
      cnt.textContent = A.events.length > 1 ? ('+' + (A.events.length - 1)) : '';
    }
  }

  A.renderEventHistory = function renderEventHistory() {
    const box = A.$('ev-history');
    if (!box) return;
    if (!A.events.length) {
      box.innerHTML = '<div class="ev-row dim">还没有消息</div>';
      return;
    }
    box.innerHTML = A.events.slice(0, 12).map((e) =>
      '<div class="ev-row"><span class="ev-t">' + A.esc(e.game) + '</span>' +
      '<span class="ev-m ' + (e.kind || 'info') + '">' + A.esc(e.text) + '</span></div>'
    ).join('');
  }

  /**
   * 两次渲染之间观察 A.state 的差值，生成事件。
   * 在 tick 循环里每帧调用 —— 所有比较都是 O(小常数)。
   */
  A.observeEvents = function observeEvents() {
    if (!A.state) return;
    // 诊断计数器（保留）：播报不工作时，先看这三个数 —— 调用了多少帧、
    // 距上次事件多久、前瞻函数给出什么。不用再猜「是不是没接线」。
    window.__evDbg = window.__evDbg || { frames: 0, since: 0, forecast: null };
    window.__evDbg.frames += 1;
    window.__evDbg.since = Date.now() - A.lastEventAt;

    // ---- 境界突破 ----
    if (A.evSnap.realm >= 0 && A.state.realm > A.evSnap.realm) {
      A.pushEvent('境界突破 → ' + A.realmNameOf(A.state.realm) +
        '（全项基础加成提升，精力上限与恢复速度提高）', 'good');
    }
    A.evSnap.realm = A.state.realm;

    // ---- 习得新功法（v3.4：功法扩到 41 本，习得值得播一条）----
    {
      const keys = Object.keys(A.state.learned || {});
      if (A.evSnap.learnedSet) {
        for (const id of keys) {
          if (!A.evSnap.learnedSet[id]) {
            const t = Core.techById(id);
            if (t) A.pushEvent('习得功法：《' + t.name + '》（' + t.school + '）', 'good');
          }
        }
      }
      A.evSnap.learnedSet = {};
      for (const id of keys) A.evSnap.learnedSet[id] = true;
    }

    // ---- 功法突破（熟练度段位提升）----
    for (const id of Object.keys(A.state.learned || {})) {
      const rec = A.state.learned[id];
      if (!rec) continue;
      const prev = A.evSnap.techTiers[id];
      if (prev === undefined) { A.evSnap.techTiers[id] = rec.tier; continue; }
      if (rec.tier > prev) {
        const t = Core.techById(id);
        const seg = Core.masteryInfo(rec.tier);
        if (t) A.pushEvent('功法突破：《' + t.name + '》熟练度达到「' + seg.name + '」'
          + (rec.passive ? '，被动已常驻' : ''), 'good');
      }
      A.evSnap.techTiers[id] = rec.tier;
    }

    // ---- 功法升级（v3.5 独立经验制，升级值得播一条）----
    for (const id of Object.keys(A.state.learned || {})) {
      const rec = A.state.learned[id];
      if (!rec) continue;
      const prev = A.evSnap.techLevels[id];
      if (prev === undefined) { A.evSnap.techLevels[id] = rec.level || 0; continue; }
      if ((rec.level || 0) > prev) {
        const t = Core.techById(id);
        if (t) A.pushEvent('功法升级：《' + t.name + '》→ Lv.' + rec.level, 'good');
      }
      A.evSnap.techLevels[id] = rec.level || 0;
    }

    // ---- 公司自动卖出入账（按窗口聚合）----
    const rev = A.state.company && A.state.company.totalRevenue;
    if (rev && rev.gt && A.evSnap.revenue && rev.gt(A.evSnap.revenue)) {
      const d = rev.sub(A.evSnap.revenue);
      A.sellAccum = A.sellAccum.add(d);
      if (!A.sellAccumSince) A.sellAccumSince = Date.now();
    }
    A.evSnap.revenue = (A.state.company && A.state.company.totalRevenue) || null;
    if (A.sellAccumSince && Date.now() - A.sellAccumSince >= A.SELL_WINDOW_MS) {
      if (A.sellAccum.gt(0)) {
        A.pushEvent('货物售出：入账 ' + A.fmt(A.sellAccum) + ' 金钱', 'money');
      }
      A.sellAccum = new D(0);
      A.sellAccumSince = 0;
    }

    // ---- 投向比例调整 ----
    const alloc = A.state.alloc || {};
    for (const k of Object.keys(alloc)) {
      const prev = A.evSnap.alloc[k];
      const cur = alloc[k];
      if (prev === undefined) { A.evSnap.alloc[k] = cur; continue; }
      if (Math.abs(cur - prev) >= 0.005) {   // 变动 ≥ 0.5 个百分点才报
        const inv = GAME.investments.find((i) => i.id === k);
        if (inv) {
          A.pushEvent('投向调整：' + inv.name + ' ' +
            (cur > prev ? '+' : '−') + Math.abs((cur - prev) * 100).toFixed(0) +
            '%（现为 ' + Math.round(cur * 100) + '%）', 'info');
        }
      }
      A.evSnap.alloc[k] = cur;
    }

    // ---- 空闲播报：一段时间没有新事件，随机挑一家公司播下期预计涨跌 ----
    if (Date.now() - A.lastEventAt >= A.IDLE_FORECAST_MS && GAME.stock &&
        GAME.stock.implemented && GAME.stock.stocks.length) {
      const st = GAME.stock.stocks[Math.floor(Math.random() * GAME.stock.stocks.length)];
      const f = Core.stockForecastPct(A.state, st);
      window.__evDbg.forecast = f;
      if (f !== null) {
        A.pushEvent('行情前瞻：' + st.name + '（' + st.code + '）下期预计 ' +
          (f > 0 ? '+' : '') + f.toFixed(1) + '%', f > 0 ? 'good' : 'jade');
      }
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
