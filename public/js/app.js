/**
 * app · main —— 主入口。
 *
 * 职责：网络层（api/token）、登录与进入游戏、切页、顶栏渲染、renderAll、
 * 主循环（100ms tick + 15 秒同步节流）与 boot。页面级渲染与操作在 app/page-*.js。
 *
 * 模块装载：浏览器按 index.html 的脚本序（本文件最后）；Node（测试 / 预览）
 * 在下方 require 全部模块后再执行本文件——它们都只往 root.App 挂函数，
 * 真正的执行从文件尾部的 boot 开始。
 */
if (typeof require !== 'undefined' && typeof module !== 'undefined') {
  require('./app/state.js'); require('./app/ui.js'); require('./app/format.js');
  require('./app/charts.js'); require('./app/events.js'); require('./app/res-tip.js');
  require('./app/page-realm.js'); require('./app/page-work.js'); require('./app/page-tech.js');
  require('./app/page-invest.js'); require('./app/page-company.js'); require('./app/page-market.js');
  require('./app/page-stock.js'); require('./app/page-technique.js'); require('./app/page-rebirth.js');
}

(function (root) {
  const A = (root.App = root.App || {});
  const D = root.Decimal;
  const GAME = root.GAME;
  const Core = root.GameCore;
  'use strict';

  // 每次「页面加载」（浏览器刷新 / Node 重新 require）都重置瞬态缓存 ——
  // 这些缓存与当次 DOM 同生命周期；测试环境会多次重新加载入口，不清零的话
  // 旧签名会让新 DOM 跳过回填。可变游戏状态（A.state 等）由 state.js 归属，
  // 会被 boot 的 hydrate 整体覆盖，不在此列。
  A.textCache = Object.create(null);
  A.stockQuoteCache = Object.create(null);
  A.stockSparkCache = new Map();
  A.stockQty = Object.create(null);
  A.techListSig = ''; A.mktSortSig = ''; A.mktSortCheckedAt = 0;
  A.firstRenderDone = false;
  A.chartGood = null; A.chartStock = null; A.showAllStocks = false;
  A.currentTab = 'realm';
  A.mktFolded = new Set(); A.mktFoldInit = new Set();
  A.lineFolded = new Set(); A.lineFoldInit = new Set();
  A.events = []; A.evSnap = { realm: -1, techTiers: {}, techLevels: {}, learnedSet: null, revenue: null, autoSold: 0, alloc: {} };
  A.sellAccum = new D(0); A.sellAccumSince = 0; A.evSeq = 0; A.lastEventAt = Date.now();

  A.api = async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (A.token) headers['x-token'] = A.token;

    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error('服务端返回异常 (HTTP ' + res.status + ')');
    }

    if (res.status === 401) {
      A.clearToken();
      A.showLogin();
      throw new Error(data.msg || '登录已失效，请重新登入');
    }
    if (!res.ok || data.ok === false) {
      const err = new Error(data.msg || ('请求失败 (HTTP ' + res.status + ')'));
      err.data = data;
      throw err;
    }
    return data;
  }

  A.saveToken = function saveToken(t, u) {
    A.token = t;
    A.username = u;
    try { localStorage.setItem(A.STORAGE_KEY, JSON.stringify({ token: t, username: u })); } catch (e) {}
  }

  A.clearToken = function clearToken() {
    A.token = null;
    A.username = '';
    try { localStorage.removeItem(A.STORAGE_KEY); } catch (e) {}
  }

  A.readToken = function readToken() {
    try {
      const raw = localStorage.getItem(A.STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  A.showLogin = function showLogin() {
    A.$('login-screen').classList.remove('hidden');
    A.$('game-screen').classList.add('hidden');
    A.stopLoop();
  }

  A.showGame = function showGame() {
    A.$('login-screen').classList.add('hidden');
    A.$('game-screen').classList.remove('hidden');
  }

  A.setLoginMsg = function setLoginMsg(msg, isErr) {
    const el = A.$('login-msg');
    el.textContent = msg || '';
    el.style.color = isErr ? 'var(--red)' : 'var(--text-dim)';
  }

  A.doAuth = async function doAuth(kind) {
    const u = A.$('in-username').value.trim();
    const p = A.$('in-password').value;

    if (!u || !p) return A.setLoginMsg('请填写道号与密令', true);
    if (kind === 'register' && u.length < 2) return A.setLoginMsg('道号至少 2 个字符', true);
    if (p.length < 4) return A.setLoginMsg('密令至少 4 位', true);

    A.setLoginMsg(kind === 'login' ? '正在登入…' : '正在开辟道途…');

    try {
      const data = await A.api('/api/' + kind, { method: 'POST', body: { username: u, password: p } });
      A.saveToken(data.token, data.username);
      A.setLoginMsg('');
      A.$('in-password').value = '';
      await A.enterGame();
    } catch (e) {
      A.setLoginMsg(e.message, true);
    }
  }

  A.enterGame = async function enterGame() {
    const data = await A.api('/api/load');

    A.state = Core.hydrate(data.state);
    A.lastLocalTick = Date.now();
    A.lastServerSave = Date.now();

    A.$('ui-username').textContent = A.username;
    A.showGame();
    A.renderStatic();
    A.renderAll();

    if (data.offline && data.offline.seconds >= 5) {
      A.showOfflineModal(data.offline);
    } else if (data.isNew) {
      A.toast('道途已开，去「工作」页选一份活干', 'ok');
      A.switchTab('work');
    }

    A.startLoop();
  }

  A.showOfflineModal = function showOfflineModal(o) {
    const capped = o.cappedOut;
    const rows = [
      ['离线时长', A.fmtRealDuration(o.seconds) + (capped ? '（已达上限）' : '')],
      ['结算效率', A.pct(o.ratio)],
      ['获得金钱', '+' + A.fmt(D.fromJSON(o.money))],
      ['获得灵气', '+' + A.fmt(D.fromJSON(o.spirit))],
    ];
    if (o.stone && !D.fromJSON(o.stone).isZero()) {
      rows.push(['获得灵石', '+' + A.fmt(D.fromJSON(o.stone))]);
    }
    if (o.learned && o.learned.length) {
      rows.push(['新习得功法', o.learned.length + ' 本']);
    }
    if (o.company && o.company.cycles > 0) {
      rows.push(['公司生产', o.company.cycles + ' 个周期']);
      const coNet = D.fromJSON(o.company.revenue).sub(D.fromJSON(o.company.upkeep));
      rows.push(['公司净收益', A.fmt(coNet)]);
      if (o.company.overflow > 0) {
        rows.push(['仓库溢出', A.fmtCount(o.company.overflow) + ' 件未入库']);
      }
      if (o.company.starved > 0) {
        rows.push(['停产周期', o.company.starved + ' 个（维护费不足）']);
      }
    }
    if (o.jobDone) rows.splice(2, 0, ['完成工作', A.fmtCount(o.jobDone) + ' 次']);
    if (typeof o.gameSeconds === 'number') {
      rows.splice(1, 0, ['游戏内时间', Core.fmtGameDate(o.gameSeconds)]);
    }

    A.buildModal({
      title: '闭关归来',
      rows: rows,
      note: capped
        ? '离线最多累计 ' + GAME.offline.maxHours + ' 小时，超出部分不再结算。'
        : '离线结算按 ' + A.pct(GAME.offline.ratio) + ' 效率折算，最长累计 ' + GAME.offline.maxHours + ' 小时。',
      okText: '继 续 修 行',
    });
  }

  A.switchTab = function switchTab(name) {
    A.currentTab = name;
    const tabs = document.querySelectorAll('#tabs .tab');
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].dataset.tab === name);
    }
    const pages = document.querySelectorAll('.page');
    for (let i = 0; i < pages.length; i++) {
      pages[i].classList.toggle('active', pages[i].dataset.page === name);
    }
    // 市场页 / 股市页平时不参与每帧重绘，切过去的这一帧必须补画一次
    if (name === 'market' || name === 'stock') A.renderAll();
  }

  A.renderStatic = function renderStatic() {
    // 时间档位不再铺成列表 —— 顶栏的四键（◀ / ▶⏸ / ▶▶ / ▶▶▶）就是全部入口，
    // 具体倍率看 clock-tier 上的数字。列表形式会让人以为那是「四套并存的档」。

    // ---- 顶栏资源悬停明细（金钱/算力/灵气/灵石/神识/境界）----
    A.bindResTips();

    // ---- 时间流速四键（顶栏）----
    A.$('btn-tc-slower').addEventListener('click', A.tcSlower);
    A.$('btn-tc-play').addEventListener('click', A.tcPlayPause);
    A.$('btn-tc-faster').addEventListener('click', A.tcFaster);
    A.$('btn-tc-max').addEventListener('click', A.tcMax);

    // ---- 事件通知栏：点击展开 / 收起历史 ----
    const evBar = A.$('event-bar');
    if (evBar) {
      evBar.addEventListener('click', () => {
        const box = A.$('ev-history');
        const willOpen = box.classList.contains('hidden');
        if (willOpen) A.renderEventHistory();
        A.slideToggle(box, willOpen, null, 'hidden');
      });
    }

    // ---- 工作列表 ----
    A.$('job-list').innerHTML = GAME.jobs.map((job, i) => {
      return '<div class="job-item" data-job="' + job.id + '">' +
        '<div class="job-badge">' + A.pad2(i + 1) + '</div>' +
        '<div class="job-main">' +
          '<div class="job-title">' + A.esc(job.name) +
            '<span class="job-tag">' + A.esc(job.real) + '</span>' +
          '</div>' +
          '<div class="job-desc">' + A.esc(job.desc) + '</div>' +
          '<div class="job-lock hidden" data-role="lock"></div>' +
          '<div class="job-stats">' +
            '<span data-role="jstat"></span>' +
            '<span data-role="jdone"></span>' +
          '</div>' +
        '</div>' +
        '<div class="job-reward">' +
          '<div class="money" data-role="jmoney">—</div>' +
          '<div class="spirit hidden" data-role="jspirit"></div>' +
          '<div class="stone hidden" data-role="jstone"></div>' +
        '</div>' +
      '</div>';
    }).join('');

    A.$('job-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-job]');
      if (!item || item.classList.contains('locked')) return;
      A.selectJob(item.dataset.job);
    });

    // ---- 设备列表 ----
    A.$('dev-list').innerHTML = GAME.devices.map((dev) => {
      const myth = (dev.stoneCost || 0) > 0;
      return '<div class="dev-item' + (myth ? ' myth' : '') + '" data-dev="' + dev.id + '">' +
        '<div class="dev-icon">' + A.esc(A.DEV_ICONS[dev.id] || '?') + '</div>' +
        '<div class="dev-info">' +
          '<div class="dev-name">' + A.esc(dev.name) +
            (myth ? '<span class="dev-tag-myth">修仙 × 科技</span>' : '') +
            '<span class="dev-owned" data-role="owned">×0</span></div>' +
          '<div class="dev-stat" data-role="stat"></div>' +
        '</div>' +
        '<div class="dev-cost">' +
          '<div class="price" data-role="price">—</div>' +
          '<div class="stone hidden" data-role="stone"></div>' +
          '<div class="disc hidden" data-role="disc"></div>' +
          '<button class="btn sm" data-role="buy" style="margin-top:5px">购买</button>' +
        '</div>' +
      '</div>';
    }).join('');

    A.$('dev-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role="buy"]');
      if (!btn) return;
      const item = btn.closest('[data-dev]');
      if (item) A.buyDevice(item.dataset.dev);
    });

    // ---- 投向列表 ----
    // 注意：这里**不能**用配置里的 `inv.locked` 决定置灰 —— 那只是「这一类需要条件」
    // 的初始标记，真正的可用性由 Core.investmentAvailable 判定（功法算力投入要习得功法、
    // 工业产能要成立公司），而且会在游戏过程中变化。锁定文案也要跟着变：
    // 早先写死成「未习得功法」，工业产能未成立公司时也显示「未习得功法」，
    // 玩家会以为自己做错了什么。两者都在 A.renderInvestPage 里逐帧校正。
    A.$('inv-list').innerHTML = GAME.investments.map((inv) => {
      return '<div class="inv-item" data-inv="' + inv.id + '">' +
        '<div class="inv-top">' +
          '<span class="inv-name">' + A.esc(inv.name) +
            '<span class="inv-lock-tag" data-role="locktag" hidden></span></span>' +
          '<span class="inv-pct" data-role="pct">0%</span>' +
        '</div>' +
        '<div class="inv-desc">' + A.esc(inv.desc) + '　<span style="color:var(--text-faint)">' +
          A.esc(inv.period) + '</span></div>' +
        '<div class="inv-controls">' +
          '<input type="range" min="0" max="100" step="5" value="0" data-role="range">' +
        '</div>' +
        '<div class="inv-out">' +
          '<span><span data-role="outlabel">产出</span>：' +
            '<span class="gain" data-role="out">0</span></span>' +
          '<span data-role="total">累计 0</span>' +
        '</div>' +
      '</div>';
    }).join('');

    A.$('inv-list').addEventListener('input', (e) => {
      const range = e.target.closest('[data-role="range"]');
      if (!range || range.disabled) return;
      const item = range.closest('[data-inv]');
      if (item) A.onAllocDrag(item.dataset.inv, parseInt(range.value, 10));
    });

    // ---- 功法阁列表 ----
    // v3.4：列表只显示**已拥有**的功法，且随习得动态重建（见 A.renderTechniquePage）。
    // 静态阶段不写内容 —— boot 时 A.state 已有，但之后每学会一本都要补行，
    // 与其两头维护，不如把构建收敛到一个函数、按签名缓存。
    A.$('tech-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-tech]');
      if (!item || item.classList.contains('locked')) return;
      A.selectTechnique(item.dataset.tech);
    });

    // ---- 已得 / 图鉴 视图切换 ----
    const ownBtn = A.$('btn-tech-owned');
    const codexBtn = A.$('btn-tech-codex');
    if (ownBtn && codexBtn) {
      const setView = (v) => {
        A.techView = v;
        A.techListSig = '';          // 强制下一帧重建
        ownBtn.classList.toggle('ghost', v === 'codex');
        codexBtn.classList.toggle('ghost', v === 'owned');
        A.$('tech-list').classList.toggle('hidden', v === 'codex');
        A.$('tech-codex').classList.toggle('hidden', v !== 'codex');
        A.renderAll();
      };
      ownBtn.addEventListener('click', () => setView('owned'));
      codexBtn.addEventListener('click', () => setView('codex'));
    }

    // ---- 功法图鉴：全部功法按稀有度分组，缺哪本、条件是什么一眼看全 ----
    A.$('tech-codex').innerHTML = GAME.techniques.rarities.map((r) => {
      const rows = GAME.techniques.list.filter((t) => t.rarity === r.id);
      if (!rows.length) return '';
      return '<div class="codex-group">' +
        '<div class="codex-group-head">' +
          '<span class="tech-rarity" data-rarity="' + A.esc(r.id) + '">' + A.esc(r.name) + '</span>' +
          '<span class="codex-group-meta">主属性基值 ×' + r.mainQiSpeed + ' · 共 ' +
            rows.length + ' 本</span>' +
        '</div>' +
        rows.map((t) => {
          const pl = Object.keys(t.passive || {}).map((k) =>
            A.esc(A.PASSIVE_LABEL[k] || k) + ' ' + A.fmtSignedPct(t.passive[k])).join('　');
          // 解锁条件是配置派生的静态文案，直接嵌进 HTML —— 图鉴一切就有内容，
          // owned 态由 CSS（.codex-item.owned .codex-cond）隐藏。
          let cond;
          if (t.cond) {
            cond = '解锁：' + A.esc(Core.techCondText(t) || '未知条件');
          } else if (t.realm || t.compute) {
            const parts = [];
            if (t.realm) parts.push('境界 · ' + A.esc(A.realmNameOf(t.realm)));
            if (t.compute) parts.push('算力 ≥ ' + A.esc(Core.fmtBig(t.compute)));
            cond = '解锁：' + parts.join('　+　');
          } else {
            cond = '解锁：拥有第一台个人电脑';   // 九章算经（firstUnlock）
          }
          return '<div class="codex-item" data-codex="' + t.id + '">' +
            '<div class="tech-item-main">' +
              '<div class="tech-item-title">' + A.esc(t.name) +
                '<span class="tech-item-school">' + A.esc(t.school) + '</span></div>' +
              '<div class="tech-item-desc">' + A.esc(t.desc) + '</div>' +
              '<div class="codex-cond" data-role="ccond">' + cond + '</div>' +
              '<div class="codex-passive">' + (pl || '<span class="off">无被动</span>') + '</div>' +
            '</div>' +
            '<div class="codex-state" data-role="cstate"></div>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');

    // ---- 公司：生产线（每条线买下后，每一台都能单独选产物、调产能）----
    A.buildCompanyLineGroups();

    // v3.7：行业组头折叠 / 展开统一走 A.bindCollapse（带高度动画）
    A.bindCollapse(A.$('co-line-list'), {
      onToggle: function (head, group, folded) {
        const gid = group.dataset.industry;
        if (!gid) return;
        if (folded) A.lineFolded.add(gid); else A.lineFolded.delete(gid);
      },
    });

    A.$('co-line-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role="lbuy"]');
      if (btn) {
        const item = btn.closest('[data-line]');
        if (item) A.buyLine(item.dataset.line);
        return;
      }
      // 行业批量：一键满速 / 一键停工（该行业全部产线的每一台一起改）
      const runBtn = e.target.closest('[data-role="lrun"]');
      if (runBtn) { A.setIndustryRate(runBtn.dataset.industry, 1); return; }
      const stopBtn = e.target.closest('[data-role="lstop"]');
      if (stopBtn) { A.setIndustryRate(stopBtn.dataset.industry, 0); return; }
      // 「优先生产」开关（整条线一个开关）
      const prioBtn = e.target.closest('[data-role="lprio"]');
      if (prioBtn) {
        const item = prioBtn.closest('[data-line]');
        if (item) A.setLinePriority(item.dataset.line, !item.classList.contains('prio'));
        return;
      }
      // 「全部套用」：把这台的产品 / 产能复制到这条线的每一台
      const apply = e.target.closest('[data-role="uapplyall"]');
      if (apply) {
        const lineEl = apply.closest('[data-line]');
        const unitEl = apply.closest('[data-unit]');
        if (lineEl && unitEl) {
          const sel = unitEl.querySelector('[data-role="uproduct"]');
          const rng = unitEl.querySelector('[data-role="urate"]');
          A.setLineUnit(lineEl.dataset.line, 'all',
            { product: sel ? sel.value : undefined, rate: rng ? Number(rng.value) / 100 : undefined });
        }
      }
    });

    // 产物 / 产能：松手（change）才提交，拖动过程中只改显示，避免每帧打接口
    A.$('co-line-list').addEventListener('change', (e) => {
      const lineEl = e.target.closest('[data-line]');
      if (!lineEl) return;
      const unitEl = e.target.closest('[data-unit]');
      if (!unitEl) return;
      const idx = Number(unitEl.dataset.unit);
      const patch = {};
      if (e.target.closest('[data-role="uproduct"]')) patch.product = e.target.value;
      else if (e.target.closest('[data-role="urate"]')) patch.rate = Number(e.target.value) / 100;
      else return;
      A.setLineUnit(lineEl.dataset.line, idx, patch);
    });

    A.$('co-line-list').addEventListener('input', (e) => {
      if (!e.target.closest('[data-role="urate"]')) return;
      const unitEl = e.target.closest('[data-unit]');
      if (!unitEl) return;
      const txt = unitEl.querySelector('[data-role="uratetxt"]');
      if (txt) txt.textContent = Math.round(Number(e.target.value)) + '%';
    });

    // ---- 市场：商品行情按行业分组 ----
    A.buildMarketGroups();

    // v3.8：四个互斥排序按钮（行业 / 价格 / 涨幅 / 跌幅）
    const sortBar = A.$('mk-sortbar');
    if (sortBar) {
      sortBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-sort]');
        if (!btn) return;
        const f = btn.dataset.sort;
        if (f === A.mktSort.field) {
          if (f === 'industry') return;          // 分组模式只有一个状态
          A.mktSort.dir = -A.mktSort.dir;            // 再点一次：升 ↔ 降
        } else {
          A.mktSort.field = f;
          A.mktSort.dir = 1;                       // 换字段一律从升序开始
        }
        A.applyMarketSort(true);
      });
      A.syncSortButtons();
    }

    // v3.6：快捷算力投向（境界页=修仙 / 设备页=AI）。拖动只改显示，松手提交。
    document.querySelectorAll('[data-qa]').forEach((bar) => {
      const id = bar.dataset.qa;
      const range = bar.querySelector('[data-role="qarange"]');
      const pctEl = bar.querySelector('[data-role="qapct"]');
      if (!range) return;
      range.addEventListener('input', () => {
        if (pctEl) pctEl.textContent = range.value + '%';
      });
      range.addEventListener('change', () => {
        if (A.state) A.commitQuickAlloc(id, Number(range.value));
      });
    });

    // v3.7：行业组头折叠 / 展开统一走 A.bindCollapse（带高度动画）
    A.bindCollapse(A.$('mk-good-list'), {
      onToggle: function (head, group, folded) {
        const gid = group.dataset.industry;
        if (!gid) return;
        if (folded) A.mktFolded.add(gid); else A.mktFolded.delete(gid);
      },
    });

    A.$('mk-good-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-good]');
      if (!item) return;
      // 「卖出」是行内子操作，点了不该把上方的走势图切走
      if (e.target.closest('[data-role="gsell"]')) {
        A.sellGood(item.dataset.good);
        return;
      }
      A.chartGood = item.dataset.good;
      A.renderMarketPage();
    });

    // ---- 市场：行业景气 ----
    A.$('mk-ind-list').innerHTML = GAME.company.industries.map((ind) => {
      const kind = A.marketKindOf(ind.id);
      const ups = (ind.upstream || []).map((u) => A.indName(u)).join(' + ');
      return '<div class="mk-ind ' + kind + '" data-industry="' + ind.id + '">' +
        '<div class="mk-ind-top">' +
          '<span class="mk-ind-icon">' + A.esc(A.indIcon(ind.id)) + '</span>' +
          '<span class="mk-ind-name">' + A.esc(ind.name) + '</span>' +
          '<span class="mk-ind-up">' + (ups ? ('← ' + A.esc(ups)) : '最上游') + '</span>' +
        '</div>' +
        '<div class="mk-ind-nums">' +
          '<span class="mk-ind-num" data-role="icost"></span>' +
          '<span class="mk-ind-num" data-role="iprice"></span>' +
          '<span class="mk-ind-num faint" data-role="imargin"></span>' +
        '</div>' +
      '</div>';
    }).join('');

    // ---- 股市：行情 + 交易 ----
    if (GAME.stock && GAME.stock.implemented) {
      A.$('st-list').innerHTML = GAME.stock.stocks.map((st) => {
        const linked = !!st.link;
        const good = linked ? GAME.company.goods.find((g) => g.id === st.link) : null;
        const kind = A.kindTag(st.kind);
        return '<div class="st-row' + (linked ? ' linked' : '') + ' ' + kind + '" data-stock="' + st.id + '">' +
          '<div class="st-icon">' + A.esc((st.name || '股').slice(0, 2)) + '</div>' +
          '<div class="st-main">' +
            '<div class="st-title">' + A.esc(st.name) +
              '<span class="st-code">' + A.esc(st.code) + '</span>' +
              '<span class="co-line-tag ' + kind + '">' + (kind === 'xiuxian' ? '修仙宗门' : (kind === 'fusion' ? '融合赛道' : '科技')) + '</span>' +
              (good ? '<span class="co-line-tag">联动 · ' + A.esc(good.name) + '</span>' : '') +
            '</div>' +
            // 主营业务 —— 行情一动就能看出波及的是哪家公司
            '<div class="st-biz">主营：' + A.esc(st.business || '—') + '</div>' +
            '<div class="st-meta" data-role="stmeta"></div>' +
            '<div class="co-press st-impact hidden" data-role="stimp">' +
              '<span class="co-press-label">冲击</span>' +
              '<span class="co-press-bar"><i data-role="stimpbar" style="width:0%"></i></span>' +
              '<span class="co-press-txt" data-role="stimptxt"></span>' +
            '</div>' +
          '</div>' +
          '<div class="st-spark" data-role="stspark"></div>' +
          '<div class="st-price">' +
            '<div class="now" data-role="stprice">—</div>' +
            '<div class="trend flat" data-role="sttrend"></div>' +
          '</div>' +
          '<div class="st-hold">' +
            '<div class="n zero" data-role="stshares">0 股</div>' +
            '<div class="v" data-role="stvalue">未持仓</div>' +
            '<div class="pnl" data-role="stpnl"></div>' +
          '</div>' +
          '<div class="st-trade">' +
            '<div class="st-trade-row">' +
              '<input type="number" min="1" step="1" data-role="stqty" aria-label="交易股数">' +
              '<button class="btn sm" data-role="stmax">最大</button>' +
            '</div>' +
            '<div class="st-trade-cost" data-role="stcost"></div>' +
            '<div class="st-trade-cost" data-role="stnet"></div>' +
            '<div class="st-trade-btns">' +
              '<button class="btn sm primary" data-role="stbuy">买入</button>' +
              '<button class="btn sm" data-role="stsell">卖出</button>' +
              '<button class="btn sm ghost" data-role="stclose">清仓</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');

      A.$('st-list').addEventListener('click', (e) => {
        const item = e.target.closest('[data-stock]');
        if (!item) return;
        const id = item.dataset.stock;
        // 交易控件是行内子操作，点了不该把上方的走势图切走
        if (e.target.closest('[data-role="stbuy"]')) { A.stockTrade('buy', id); return; }
        if (e.target.closest('[data-role="stsell"]')) { A.stockTrade('sell', id); return; }
        if (e.target.closest('[data-role="stclose"]')) { A.stockTrade('sell', id, true); return; }
        if (e.target.closest('[data-role="stmax"]')) { A.stockFillMax(id); return; }
        if (e.target.closest('.st-trade')) return;
        A.chartStock = id;
        A.renderStockPage();
      });

      // 输入框里的数字必须实时进缓存 —— 否则下一次重绘就把它抹掉了
      A.$('st-list').addEventListener('input', (e) => {
        const inp = e.target.closest('[data-role="stqty"]');
        if (!inp) return;
        const item = inp.closest('[data-stock]');
        if (!item) return;
        A.stockQty[item.dataset.stock] = inp.value;
        A.renderStockPage();
      });
    }

    // ---- 功法页解锁条件 ----
    A.$('ui-tech-unlock').textContent = '拥有第一台个人电脑';
  }

  /**
   * 渲染分两档：
   *   renderAll —— 全量（boot 首帧 / 操作反馈 / 切页）。市场与股市两页的重列表
   *                （288 行 + 100 行，每行还带迷你走势）只在**首帧**或「当前页就是
   *                它」时才画：切页由 switchTab 补画，其余时刻画了也看不见。
   *   renderFrame —— 主循环每 100ms 一帧：只画顶栏 + 当前页。这是常态路径，
   *                早期版本每帧全量九个页面，多 DOM 下的无效重绘都在这里省掉。
   */
  const PAGE_RENDERERS = {
    realm: function () {
      A.renderTiers(); A.renderRealmPage(); A.renderTribulationPage();
      A.renderRebirthPage(); A.renderQuickAlloc();
    },
    work: function () { A.renderWorkPage(); },
    tech: function () { A.renderTechPage(); A.renderQuickAlloc(); },
    invest: function () { A.renderInvestPage(); A.renderQuickAlloc(); },
    technique: function () { A.renderTechniquePage(); },
    company: function () { A.renderCompanyPage(); },
    market: function () { A.renderMarketPage(); },
    stock: function () { A.renderStockPage(); },
  };

  A.renderFrame = function renderFrame() {
    if (!A.state) return;
    A.renderTop();
    const draw = PAGE_RENDERERS[A.currentTab];
    if (draw) draw();
  }

  A.renderAll = function renderAll() {
    if (!A.state) return;
    const first = !A.firstRenderDone;
    A.renderTop();
    A.renderTiers();
    A.renderRealmPage();
    A.renderTribulationPage();
    A.renderWorkPage();
    A.renderTechPage();
    A.renderQuickAlloc();
    A.renderInvestPage();
    A.renderCompanyPage();
    // 市场页与股市页的重列表只在首帧或当前页时渲染 ——
    // 首帧必须铺满（测试与首屏都依赖），其余时刻切页会补画。
    if (A.currentTab === 'market' || first) A.renderMarketPage();
    if (A.currentTab === 'stock' || first) A.renderStockPage();
    A.renderTechniquePage();
    A.renderRebirthPage();
    A.firstRenderDone = true;
  }

  A.renderTop = function renderTop() {
    // 金钱的每秒入账：工作折算 + 设备被动 + 金融投向 + 公司净收益。
    // 与「金钱」悬停明细（app/res-tip.js 的 moneyIncomeParts）同一段代码口径，
    // 顶栏数字 = 明细合计，玩家悬停能逐项对上账。
    // （早先这里只有 设备被动 + 公司净收益 两项，金融投向在每帧入账却不显示。）
    const incomeParts = A.moneyIncomeParts();
    const income = incomeParts.total;
    const info = Core.realmInfo(A.state);
    const target = Core.nextRealm(A.state);

    A.setText('ui-money',   A.fmt(A.state.money));
    A.setText('ui-income',  A.fmtRate(income));
    A.setText('ui-compute', A.fmt(A.state.realCompute));
    A.setText('ui-qi',      A.fmt(A.state.qi));
    A.setText('ui-spirit',  A.fmt(A.state.spiritStone));
    A.setText('ui-shenshi', A.fmtNum(Core.totalShenshi(A.state)));

    // 算力拆解必须**能自己对上账**：标题上的数 = (设备 + AI) × 乘区。
    // 早先这里写的是 `总设备算力 + AI`，既没扣兵解衰减也没乘乘区，
    // 后期两者合计 1e20 而标题 2.27e23，玩家会以为数字算错了。
    const cb = Core.computeBreakdown(A.state);
    if (cb.ai.gt(0)) {
      A.setText('ui-compute-sub', '设备 ' + A.fmt(cb.device) + ' + AI ' + A.fmt(cb.ai) +
        '　乘区 ×' + A.fmtNum(cb.mul));
    } else {
      A.setText('ui-compute-sub', '设备 ' + A.fmt(cb.device) + '　乘区 ×' + A.fmtNum(cb.mul));
    }

    // 灵气副标题带每秒产出（未习得功法时恒为 0，保持原提示）
    const spiritOk = Core.spiritAllowed(A.state);
    const qiRate = A.qiRateParts().total;
    A.setText('ui-qi-sub', !spiritOk ? '需习得功法'
      : (qiRate.gt(0) ? A.fmtRate(qiRate) + ' · 突破境界用' : '突破境界用'));

    const stoneRate = Core.deviceStoneOutput(A.state);
    A.setText('ui-spirit-sub', stoneRate.gt(0) ? A.fmtRate(stoneRate) : '购修仙设备');

    // 神识对算力的加成显示「实际乘区」而不是「总量 × 固定系数」——
    // 后者在后期会明显偏大（分层阻尼后神识总量与实际乘区已经不是一个口径）
    const shBonusPct = (Core.shenshiComputeMultiplier(A.state) - 1) * 100;
    A.setText('ui-shenshi-sub', '算力 +' + shBonusPct.toFixed(1) + '%');

    A.setText('ui-realm-top',  info.name);
    A.setText('ui-realm-prog', target.need ? A.pct(A.state.realmProgress) : '圆满');

    // 游戏内时钟 + 时间流速四键状态
    A.setText('ui-clock', Core.fmtGameDate(A.state.gameSeconds));
    A.setText('ui-clock-tier', A.state.timePaused ? '已暂停' : Core.tierInfo(A.state.timeTier).label);
    A.renderClockControls();

    // 资源悬停明细跟随 tick 实时刷新（没悬停时内部直接返回）
    A.refreshResTip();
  }

  /**
   * 通用服务端操作（POST /api/action 的唯一通道）。
   *
   * 渡劫 / 兵解 / 买加成（服务端权威，防篡改）、公司经营（一次性付费 + 单向状态，
   * 注册 / 买线 / 扩仓都要真金白银扣钱且不可撤销）、股市买卖（直接扣钱加钱，
   * 成交价必须由服务端按自己的报价裁决）—— 三类操作走的原来是三份逐字相同的
   * 函数，现收敛到这一处：响应带回 A.state 就替换本地并重绘，被拒绝也用服务端
   * 回传的 A.state 把本地纠正回来。
   */
  A.serverAction = async function serverAction(action, payload) {
    if (!A.state) return null;
    try {
      const data = await A.api('/api/action', {
        method: 'POST',
        body: { action: action, payload: payload || {} },
      });
      if (data.state) {
        A.state = Core.hydrate(data.state);
        A.lastLocalTick = Date.now();
        A.lastServerSave = Date.now();
        A.dirty = true;   // 之后本地还会继续 tick，交给下一次自动同步推上去
      }
      A.renderAll();
      return data.result || {};
    } catch (e) {
      if (e.data && e.data.state) {
        A.state = Core.hydrate(e.data.state);
        A.lastLocalTick = Date.now();
      }
      A.toast(e.message, 'err');
      A.renderAll();
      return null;
    }
  }

  A.startLoop = function startLoop() {
    A.stopLoop();
    A.lastLocalTick = Date.now();

    A.tickTimer = setInterval(() => {
      const now = Date.now();
      let dt = (now - A.lastLocalTick) / 1000;
      A.lastLocalTick = now;

      // 本地 tick **刻意关掉自动渡劫**（tribulation:false）。
      // 渡劫失败会触发被动兵解、连设备与功法一起清空，而这两样在服务端的
      // /api/save 里是「只增不减」的 —— 本地先失败再回写，会被服务端原样补回来，
      // 变成「界面归零、服务器还留着元婴」。所以渡劫统一走 /api/action 的服务端权威路径。
      if (dt > GAME.offline.thresholdSeconds) {
        Core.tick(A.state, dt, { offline: true, tribulation: false });
        A.toast('检测到长时间未操作，按离线规则结算', 'ok');
      } else if (dt > 0) {
        Core.tick(A.state, dt, { offline: false, tribulation: false });
      }

      // 常态路径只画「顶栏 + 当前页」—— 其余页面保持上次内容，切页时重画
      A.renderFrame();
      // 事件观察器抛错不能拖垮主循环 —— 播报是锦上添花，不是主流程
      try { A.observeEvents(); } catch (e) { console.warn('[事件栏]', e); }
      // 不做的话挂机会永久停在满格进度条上，主线等于断了。
      if (A.state.autoTribulation !== false && Core.tribulationReady(A.state)) {
        A.tryTribulation();
      }

      if (now - A.lastServerSave >= GAME.save.intervalMs) {
        A.syncNow();
      }
    }, GAME.ui.tickMs);
  }

  A.stopLoop = function stopLoop() {
    if (A.tickTimer) { clearInterval(A.tickTimer); A.tickTimer = null; }
  }

  A.setSaveStatus = function setSaveStatus(text, cls) {
    const el = A.$('save-status');
    el.textContent = text;
    el.className = cls || '';
  }

  A.syncNow = async function syncNow(force) {
    if (!A.state || !A.token || A.syncing) return;
    if (!A.dirty && !force) {
      A.lastServerSave = Date.now();
      return;
    }

    A.syncing = true;
    A.setSaveStatus('同步中…');

    try {
      await A.api('/api/save', {
        method: 'POST',
        body: { state: Core.serialize(A.state) },
      });
      A.dirty = false;
      A.lastServerSave = Date.now();
      A.setSaveStatus('已同步', 'ok');
    } catch (e) {
      // 服务端判定「客户端手里是过期存档」时会回传最新存档（典型场景：
      // 另一个标签页已经兵解过，而这一页还拿着兵解前的 A.state 在定时回写）。
      // 这种情况必须直接采用服务端版本，否则两边的公司 / 股市状态会互相覆盖。
      if (e.data && e.data.state) {
        A.state = Core.hydrate(e.data.state);
        A.lastLocalTick = Date.now();
        A.dirty = false;
        A.setSaveStatus('已改用服务端存档', 'ok');
        A.renderAll();
        if (e.message) A.toast(e.message, 'err');
        return;
      }
      A.setSaveStatus('同步失败', 'err');
      console.warn('[存档失败]', e.message);
    } finally {
      A.syncing = false;
    }
  }

  // ============================================================
  // 事件绑定
  // ============================================================

  A.$('btn-login').addEventListener('click', () => A.doAuth('login'));
  A.$('btn-register').addEventListener('click', () => A.doAuth('register'));

  A.$('in-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') A.doAuth('login');
  });
  A.$('in-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') A.$('in-password').focus();
  });

  // ---- 子页面切换 ----
  A.$('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) A.switchTab(tab.dataset.tab);
  });

  // ---- 工作页 ----
  A.$('btn-rush').addEventListener('click', A.rushJob);
  A.$('btn-toggle-work').addEventListener('click', A.toggleWork);

  // ---- 功法页 ----
  A.$('btn-comprehend').addEventListener('click', A.comprehend);
  A.$('btn-toggle-cultivate').addEventListener('click', A.toggleCultivate);

  // ---- 公司页 ----
  A.$('btn-found-company').addEventListener('click', A.foundCompany);
  A.$('btn-co-warehouse').addEventListener('click', A.upgradeWarehouse);
  A.$('chk-co-autosell').addEventListener('change', (e) => A.toggleAutoSell(e.target.checked));
  // 「去调投向份额」—— 工业算力不足时最直接的出口
  const cpGoto = A.$('btn-co-cp-goto');
  if (cpGoto) cpGoto.addEventListener('click', () => A.switchTab('invest'));

  // ---- 渡劫 ----
  const tbBtn = A.$('btn-tribulation');
  if (tbBtn) {
    tbBtn.addEventListener('click', () => {
      if (!A.state || !Core.tribulationReady(A.state)) {
        A.toast('灵气未满，还引不动天劫', 'err');
        return;
      }
      // 手动渡劫是玩家主动按下的高风险动作 —— 确认一次，避免误触
      if (!window.confirm('确认渡劫？\n\n成功：境界提升，渡劫淬体 +1 层（全项永久加成）\n失败：被动兵解，这一世作废' +
        (A.state.realm < ((GAME.tribulation.passiveRules || {}).belowRealm || 4)
          ? '（未及元婴，设备与功法一并清空）' : '（道行打三折）'))) {
        return;
      }
      A.lastTribulationAt = 0;   // 手动点击不受节流限制
      A.tryTribulation();
    });
  }
  const tbChk = A.$('chk-auto-tribulation');
  if (tbChk) {
    tbChk.addEventListener('change', async (e) => {
      const on = !!e.target.checked;
      if (A.state) A.state.autoTribulation = on;
      A.dirty = true;
      try {
        await A.serverAction('setAutoTribulation', { on: on });
      } catch (err) {
        /* 服务端不可用时也让本地开关生效，下次保存会带上去 */
      }
      A.toast(on ? '已开启自动渡劫：灵气一满就硬闯' : '已关闭自动渡劫：灵气满格后等你手动渡', 'ok');
      A.renderAll();
    });
  }

  // ---- 兵解 · 转生 ----
  const rbBtn = A.$('btn-rebirth');
  if (rbBtn) rbBtn.addEventListener('click', A.openRebirthModal);
  const rbCancel = A.$('btn-rebirth-cancel');
  if (rbCancel) rbCancel.addEventListener('click', A.closeRebirthModal);
  const rbConfirm = A.$('btn-rebirth-confirm');
  if (rbConfirm) rbConfirm.addEventListener('click', A.doRebirthNow);
  // 点遮罩关闭，点弹窗本体不关
  const rbMask = A.$('rebirth-modal');
  if (rbMask) {
    rbMask.addEventListener('click', (e) => {
      if (e.target === rbMask) A.closeRebirthModal();
    });
  }
  // 道行加成列表是动态重绘的，用事件委托绑升级按钮
  const rbPerks = A.$('rb-perk-list');
  if (rbPerks) {
    rbPerks.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-perk]');
      if (btn && !btn.disabled) A.buyRebirthPerk(btn.dataset.perk);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = A.$('rebirth-modal');
    if (m && !m.classList.contains('hidden')) A.closeRebirthModal();
  });

  // ---- 市场页（商品行情独立页，与公司页共用同一套卖出逻辑）----
  const mkSellAll = A.$('btn-mk-sell-all');
  if (mkSellAll) mkSellAll.addEventListener('click', A.sellAllGoods);

  // ---- 股市页 ----
  const boardBtn = A.$('btn-st-board-all');
  if (boardBtn) {
    boardBtn.addEventListener('click', () => {
      A.showAllStocks = !A.showAllStocks;
      A.renderAll();
    });
  }

  // 空格键也能催工
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (A.$('game-screen').classList.contains('hidden')) return;
    if (A.currentTab !== 'work') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'button' || tag === 'textarea') return;
    e.preventDefault();
    A.rushJob();
  });

  A.$('btn-save-now').addEventListener('click', () => {
    A.syncNow(true);
    A.toast('已存档', 'ok');
  });

  A.$('btn-alloc-reset').addEventListener('click', () => A.setAllocPreset('reset'));
  A.$('btn-alloc-main').addEventListener('click', () => A.setAllocPreset('main'));
  A.$('btn-alloc-even').addEventListener('click', () => A.setAllocPreset('even'));

  A.$('btn-logout').addEventListener('click', async () => {
    await A.syncNow(true);
    try { await A.api('/api/logout', { method: 'POST' }); } catch (e) {}
    A.clearToken();
    A.state = null;
    A.showLogin();
    A.setLoginMsg('已登出');
  });

  // 关页面前尽力存一次
  window.addEventListener('beforeunload', () => {
    if (!A.state || !A.token) return;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/save', false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('x-token', A.token);
      xhr.send(JSON.stringify({ state: Core.serialize(A.state) }));
    } catch (e) {}
  });

  // 切回标签页时校正时间
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      A.lastLocalTick = Date.now();
    }
  });

  // ============================================================
  // 启动
  // ============================================================

  (async function boot() {
    const saved = A.readToken();
    if (!saved || !saved.token) {
      A.showLogin();
      return;
    }

    A.token = saved.token;
    A.username = saved.username || '';
    A.setLoginMsg('正在恢复道途…');

    try {
      const me = await A.api('/api/me');
      A.username = me.username;
      A.$('ui-username').textContent = A.username;
      A.setLoginMsg('');
      await A.enterGame();
    } catch (e) {
      A.showLogin();
      A.setLoginMsg('登录已失效，请重新登入', true);
    }
  })();

})(typeof window !== 'undefined' ? window : globalThis);
