/**
 * 算力修仙 —— 前端主逻辑
 *
 * 架构：
 *   - 本地持有完整游戏状态，用 game-core 的 tick() 以 100ms 为步长实时推进
 *   - 每 15 秒向服务端同步一次（服务端也会推进，但以本地为准做防作弊合并）
 *   - 刷新页面 / 重新登录时，服务端做离线结算
 *
 * 这样做的原因：同一个 tick 函数两端共用，进度不会对不上。
 */

(function () {
  'use strict';

  const D = window.Decimal;
  const GAME = window.GAME;
  const Core = window.GameCore;

  // ---------- 全局状态 ----------
  let state = null;
  let token = null;
  let username = '';
  // 市场走势图当前选中的商品（点击商品行可切换）
  let chartGood = null;
  // 股市走势图当前选中的股票（同上）
  let chartStock = null;
  // 行情列表是否展开全部 50 家（默认只列市值前 10）
  let showAllStocks = false;
  // 每只股票的交易数量。必须缓存下来：列表每 100ms 重绘一次，
  // 若每次都用配置里的默认值回写输入框，玩家刚敲进去的数字会被冲掉。
  const stockQty = Object.create(null);
  let lastLocalTick = 0;
  let lastServerSave = 0;
  let saveTimer = null;
  let tickTimer = null;
  let dirty = false;
  let currentTab = 'realm';

  const STORAGE_KEY = 'suansuan-xiuxian-token';

  // ============================================================
  // 数字格式化
  // ============================================================

  /**
   * 把 Decimal 格式化成人类可读的短字符串。
   * < 1000        → 保留最多 2 位小数，如 12.34
   * < 1e6         → 千分位，如 1,234
   * < 1e15        → 万/亿/兆/京 中文单位
   * >= 1e15       → 科学计数法 1.23e18
   */
  function fmt(dec) {
    if (!dec) return '0';
    if (!(dec instanceof D)) dec = D.fromJSON(dec);

    const neg = dec.m < 0;
    dec = new D(Math.abs(dec.m), dec.e);
    let out;

    if (dec.m === 0) {
      out = '0';
    } else if (dec.e < 3) {
      const n = dec.toNumber();
      if (n < 10)       out = n.toFixed(n % 1 === 0 ? 0 : 2);
      else if (n < 100) out = n.toFixed(n % 1 === 0 ? 0 : 1);
      else              out = Math.floor(n).toLocaleString('en-US');
    } else if (dec.e < 6) {
      out = Math.floor(dec.toNumber()).toLocaleString('en-US');
    } else if (dec.e < 15) {
      out = chineseUnit(dec);
    } else {
      out = dec.m.toFixed(2) + 'e' + dec.e;
    }

    return (neg ? '-' : '') + out;
  }

  const CN_UNITS = [
    { e: 12, s: '兆' },
    { e: 8,  s: '亿' },
    { e: 4,  s: '万' },
  ];

  function chineseUnit(dec) {
    for (const u of CN_UNITS) {
      if (dec.e >= u.e) {
        const v = D.div(dec, new D(1, u.e)).toNumber();
        return v.toFixed(v < 100 ? 2 : 1) + u.s;
      }
    }
    return Math.floor(dec.toNumber()).toLocaleString('en-US');
  }

  /** 速率显示：+1.23万 / 秒 */
  function fmtRate(dec) {
    return '+' + fmt(dec) + ' / 秒';
  }

  /** 百分比 */
  function pct(v) {
    const n = (v instanceof D) ? v.toNumber() : v;
    if (!isFinite(n)) return '100.00%';
    const p = n * 100;
    if (p >= 100) return '100.00%';
    if (p === 0) return '0.00%';
    if (p < 0.01) return p.toFixed(4) + '%';
    return p.toFixed(2) + '%';
  }

  /** 现实时长（秒）—— 用于「还剩多久完成」 */
  function fmtRealDuration(sec) {
    sec = Math.max(0, Math.ceil(sec));
    if (sec < 60) return sec + ' 秒';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h + ' 时 ' + m + ' 分';
  }

  function fmtCount(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  // ============================================================
  // 网络
  // ============================================================

  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-token'] = token;

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
      clearToken();
      showLogin();
      throw new Error(data.msg || '登录已失效，请重新登入');
    }
    if (!res.ok || data.ok === false) {
      const err = new Error(data.msg || ('请求失败 (HTTP ' + res.status + ')'));
      err.data = data;
      throw err;
    }
    return data;
  }

  function saveToken(t, u) {
    token = t;
    username = u;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: t, username: u })); } catch (e) {}
  }

  function clearToken() {
    token = null;
    username = '';
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function readToken() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  // ============================================================
  // 提示
  // ============================================================

  function toast(msg, type) {
    const zone = document.getElementById('toast-zone');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    zone.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(22px)';
      setTimeout(() => el.remove(), 320);
    }, 2200);
  }

  const $ = (id) => document.getElementById(id);

  // 只在文本真正变化时才写 DOM。
  // renderTop 每 100ms 跑一次，无条件重写 textContent 会让浏览器反复做
  // 「replace data → 重新测量文本宽度 → 重排」，是顶栏细微抖动感的来源之一。
  // 加一层值缓存后，稳定不变的文本（如「突破境界用」）完全不再碰 DOM。
  const textCache = Object.create(null);
  function setText(id, value) {
    const txt = String(value);
    if (textCache[id] === txt) return;
    const el = $(id);
    if (!el) return;
    textCache[id] = txt;
    el.textContent = txt;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ============================================================
  // 市场价格走势图
  //
  // 价格是「期数」的确定性函数（core 的 goodsSeries），所以历史段和未来段都能
  // 直接算出来：实线 = 已经走过的期，虚线 = 按当前规律推演的后几期。
  //
  // 画法上有两个约束：
  //   1. 宽度要自适应，所以用 preserveAspectRatio="none" 拉伸 viewBox；
  //      非等比缩放下 <circle> 会被拉成椭圆，因此「当前价」用一个竖线标记，
  //      <line>/<polyline> 拉伸后仍然是直线，不会变形。
  //   2. 描边统一加 vector-effect="non-scaling-stroke"，否则线宽会随容器宽度变。
  // ============================================================

  const CHART_W = 320;   // viewBox 宽度，实际显示宽度由 CSS 决定
  const CHART_EDGE = 5;  // viewBox 内的四周留白

  function trendStroke(trend) {
    if (trend === 'up') return 'var(--red)';      // 涨红
    if (trend === 'down') return 'var(--jade)';   // 跌绿
    return 'var(--text-faint)';
  }

  /**
   * 生成一段价格走势 SVG。
   * @param {object} good        商品配置
   * @param {number} gameSeconds 当前游戏内时间
   * @param {string} trend       'up' | 'down' | 'flat'（决定线条颜色，涨红跌绿）
   * @param {number} past        往前取几期
   * @param {number} future      往后推演几期（0 = 只画已发生）
   * @param {number} height      viewBox 高度
   */
  function priceChartSVG(good, gameSeconds, trend, past, future, height) {
    const series = Core.goodsWindowWith(state, good, past, future);
    if (!series || series.length < 2) return '';

    const curPeriod = Core.goodsPeriod(good, gameSeconds);
    const vals = series.map((p) => p.price.toNumber());
    const baseVal = Number(good.basePrice) || vals[0];

    // 抛压生效时，把「不受抛压的自然价」也画出来做参照：
    // 玩家能直接看到「本来值这么多，是我自己砸下来的」。
    const pressured = Core.pressureOf(state, good.id) > 0;
    const natural = pressured ? Core.goodsSeries(good, series[0].period, series[series.length - 1].period) : null;
    if (natural) for (const p of natural) vals.push(p.price.toNumber());

    // 纵轴范围：把基准价也纳入，保证参考线永远在可见区域内
    let lo = Math.min.apply(Math, vals.concat([baseVal]));
    let hi = Math.max.apply(Math, vals.concat([baseVal]));
    if (hi - lo < 1e-9) {
      const d = Math.max(1, Math.abs(hi) * 0.2);
      lo -= d; hi += d;
    }
    const pad = (hi - lo) * 0.14;
    lo -= pad; hi += pad;
    if (lo < 0) lo = 0;

    const span = height - CHART_EDGE * 2;
    const x = (i) => CHART_EDGE + (i * (CHART_W - CHART_EDGE * 2)) / (series.length - 1);
    const y = (v) => height - CHART_EDGE - ((v - lo) / (hi - lo)) * span;

    // 当前期在序列里的下标（序列升序，最后一个 period <= curPeriod 的就是它）
    let ci = 0;
    for (let i = 0; i < series.length; i++) if (series[i].period <= curPeriod) ci = i;

    const pts = (from, to) => {
      const a = [];
      for (let i = from; i <= to; i++) {
        a.push(x(i).toFixed(2) + ',' + y(series[i].price.toNumber()).toFixed(2));
      }
      return a.join(' ');
    };

    const stroke = trendStroke(trend);
    let svg = '<svg class="co-chart" viewBox="0 0 ' + CHART_W + ' ' + height + '" '
      + 'preserveAspectRatio="none" role="img" aria-label="价格走势">';

    // 基准价参考线
    svg += '<line x1="0" y1="' + y(baseVal).toFixed(2) + '" x2="' + CHART_W + '" y2="'
      + y(baseVal).toFixed(2) + '" stroke="var(--border)" stroke-width="1" '
      + 'stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>';

    // 自然价参考线（仅在被抛压压低时出现）
    if (natural) {
      const npts = natural.map((p, i) => x(i).toFixed(2) + ',' + y(p.price.toNumber()).toFixed(2)).join(' ');
      svg += '<polyline points="' + npts + '" fill="none" stroke="var(--text-faint)" '
        + 'stroke-width="1" stroke-dasharray="2 3" opacity="0.55" '
        + 'vector-effect="non-scaling-stroke"/>';
    }

    // 已发生：实线
    svg += '<polyline points="' + pts(0, ci) + '" fill="none" stroke="' + stroke + '" '
      + 'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" '
      + 'vector-effect="non-scaling-stroke"/>';

    // 推演：虚线
    if (ci < series.length - 1) {
      svg += '<polyline points="' + pts(ci, series.length - 1) + '" fill="none" stroke="'
        + stroke + '" stroke-width="2" stroke-dasharray="4 3" stroke-linejoin="round" '
        + 'stroke-linecap="round" opacity="0.5" vector-effect="non-scaling-stroke"/>';
    }

    // 当前期标记：贯穿的淡竖线 + 从当前价到底部的实竖线
    const cx = x(ci).toFixed(2);
    const cy = y(series[ci].price.toNumber()).toFixed(2);
    svg += '<line x1="' + cx + '" y1="' + CHART_EDGE + '" x2="' + cx + '" y2="'
      + (height - CHART_EDGE) + '" stroke="' + stroke
      + '" stroke-width="1" opacity="0.22" vector-effect="non-scaling-stroke"/>';
    svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + cx + '" y2="'
      + (height - CHART_EDGE) + '" stroke="' + stroke
      + '" stroke-width="2" vector-effect="non-scaling-stroke"/>';

    return svg + '</svg>';
  }

  /**
   * 股票走势图。与商品走势图同构（同样的 viewBox / 拉伸 / 竖线标记约束），
   * 唯一多出来的是一条「自然价」参考线：
   *   过去期不受冲击影响（history 里冲击按 1 算，即已经拿不回来了），
   *   当前期与未来期按 flowDecay 逐期回到自然价 —— 于是玩家能一眼看出
   *   「行情本应值多少」以及「是我自己的买卖把它推歪了多少」。
   */
  function stockChartSVG(stock, gameSeconds, trend, past, future, height) {
    const series = Core.stockWindow(state, stock, past, future);
    if (!series || series.length < 2) return '';

    const curPeriod = Core.stockPeriod(stock, gameSeconds);
    const vals = series.map((p) => p.price.toNumber());
    const baseVal = Number(stock.basePrice) || vals[0];

    const impacted = Core.stockFlow(state, stock.id) !== 0;
    const natVals = impacted ? series.map((p) => p.natural.toNumber()) : null;
    if (natVals) for (const v of natVals) vals.push(v);

    let lo = Math.min.apply(Math, vals.concat([baseVal]));
    let hi = Math.max.apply(Math, vals.concat([baseVal]));
    if (hi - lo < 1e-9) {
      const d = Math.max(1, Math.abs(hi) * 0.2);
      lo -= d; hi += d;
    }
    const pad = (hi - lo) * 0.14;
    lo -= pad; hi += pad;
    if (lo < 0) lo = 0;

    const span = height - CHART_EDGE * 2;
    const x = (i) => CHART_EDGE + (i * (CHART_W - CHART_EDGE * 2)) / (series.length - 1);
    const y = (v) => height - CHART_EDGE - ((v - lo) / (hi - lo)) * span;

    let ci = 0;
    for (let i = 0; i < series.length; i++) if (series[i].period <= curPeriod) ci = i;

    const pts = (from, to) => {
      const a = [];
      for (let i = from; i <= to; i++) {
        a.push(x(i).toFixed(2) + ',' + y(series[i].price.toNumber()).toFixed(2));
      }
      return a.join(' ');
    };

    const stroke = trendStroke(trend);
    let svg = '<svg class="co-chart" viewBox="0 0 ' + CHART_W + ' ' + height + '" '
      + 'preserveAspectRatio="none" role="img" aria-label="股价走势">';

    // 基准价参考线
    svg += '<line x1="0" y1="' + y(baseVal).toFixed(2) + '" x2="' + CHART_W + '" y2="'
      + y(baseVal).toFixed(2) + '" stroke="var(--border)" stroke-width="1" '
      + 'stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>';

    // 自然价参考线（仅在自己造出冲击时出现）
    if (natVals) {
      const npts = natVals.map((v, i) => x(i).toFixed(2) + ',' + y(v).toFixed(2)).join(' ');
      svg += '<polyline points="' + npts + '" fill="none" stroke="var(--text-faint)" '
        + 'stroke-width="1" stroke-dasharray="2 3" opacity="0.55" '
        + 'vector-effect="non-scaling-stroke"/>';
    }

    // 已发生：实线
    svg += '<polyline points="' + pts(0, ci) + '" fill="none" stroke="' + stroke + '" '
      + 'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" '
      + 'vector-effect="non-scaling-stroke"/>';

    // 推演：虚线
    if (ci < series.length - 1) {
      svg += '<polyline points="' + pts(ci, series.length - 1) + '" fill="none" stroke="'
        + stroke + '" stroke-width="2" stroke-dasharray="4 3" stroke-linejoin="round" '
        + 'stroke-linecap="round" opacity="0.5" vector-effect="non-scaling-stroke"/>';
    }

    // 当前期标记：贯穿淡竖线 + 从成交价到底部的实竖线
    const cx = x(ci).toFixed(2);
    const cy = y(series[ci].price.toNumber()).toFixed(2);
    svg += '<line x1="' + cx + '" y1="' + CHART_EDGE + '" x2="' + cx + '" y2="'
      + (height - CHART_EDGE) + '" stroke="' + stroke
      + '" stroke-width="1" opacity="0.22" vector-effect="non-scaling-stroke"/>';
    svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + cx + '" y2="'
      + (height - CHART_EDGE) + '" stroke="' + stroke
      + '" stroke-width="2" vector-effect="non-scaling-stroke"/>';

    return svg + '</svg>';
  }

  // ============================================================
  // 登录界面
  // ============================================================

  function showLogin() {
    $('login-screen').classList.remove('hidden');
    $('game-screen').classList.add('hidden');
    stopLoop();
  }

  function showGame() {
    $('login-screen').classList.add('hidden');
    $('game-screen').classList.remove('hidden');
  }

  function setLoginMsg(msg, isErr) {
    const el = $('login-msg');
    el.textContent = msg || '';
    el.style.color = isErr ? 'var(--red)' : 'var(--text-dim)';
  }

  async function doAuth(kind) {
    const u = $('in-username').value.trim();
    const p = $('in-password').value;

    if (!u || !p) return setLoginMsg('请填写道号与密令', true);
    if (kind === 'register' && u.length < 2) return setLoginMsg('道号至少 2 个字符', true);
    if (p.length < 4) return setLoginMsg('密令至少 4 位', true);

    setLoginMsg(kind === 'login' ? '正在登入…' : '正在开辟道途…');

    try {
      const data = await api('/api/' + kind, { method: 'POST', body: { username: u, password: p } });
      saveToken(data.token, data.username);
      setLoginMsg('');
      $('in-password').value = '';
      await enterGame();
    } catch (e) {
      setLoginMsg(e.message, true);
    }
  }

  // ============================================================
  // 进入游戏
  // ============================================================

  async function enterGame() {
    const data = await api('/api/load');

    state = Core.hydrate(data.state);
    lastLocalTick = Date.now();
    lastServerSave = Date.now();

    $('ui-username').textContent = username;
    showGame();
    renderStatic();
    renderAll();

    if (data.offline && data.offline.seconds >= 5) {
      showOfflineModal(data.offline);
    } else if (data.isNew) {
      toast('道途已开，去「工作」页选一份活干', 'ok');
      switchTab('work');
    }

    startLoop();
  }

  function showOfflineModal(o) {
    const capped = o.cappedOut;
    const rows = [
      ['离线时长', fmtRealDuration(o.seconds) + (capped ? '（已达上限）' : '')],
      ['结算效率', pct(o.ratio)],
      ['获得金钱', '+' + fmt(D.fromJSON(o.money))],
      ['获得灵气', '+' + fmt(D.fromJSON(o.spirit))],
    ];
    if (o.stone && !D.fromJSON(o.stone).isZero()) {
      rows.push(['获得灵石', '+' + fmt(D.fromJSON(o.stone))]);
    }
    if (o.learned && o.learned.length) {
      rows.push(['新习得功法', o.learned.length + ' 本']);
    }
    if (o.company && o.company.cycles > 0) {
      rows.push(['公司生产', o.company.cycles + ' 个周期']);
      const coNet = D.fromJSON(o.company.revenue).sub(D.fromJSON(o.company.upkeep));
      rows.push(['公司净收益', fmt(coNet)]);
      if (o.company.overflow > 0) {
        rows.push(['仓库溢出', fmtCount(o.company.overflow) + ' 件未入库']);
      }
      if (o.company.starved > 0) {
        rows.push(['停产周期', o.company.starved + ' 个（维护费不足）']);
      }
    }
    if (o.jobDone) rows.splice(2, 0, ['完成工作', fmtCount(o.jobDone) + ' 次']);
    if (typeof o.gameSeconds === 'number') {
      rows.splice(1, 0, ['游戏内时间', Core.fmtGameDate(o.gameSeconds)]);
    }

    buildModal({
      title: '闭关归来',
      rows: rows,
      note: capped
        ? '离线最多累计 ' + GAME.offline.maxHours + ' 小时，超出部分不再结算。'
        : '离线结算按 ' + pct(GAME.offline.ratio) + ' 效率折算，最长累计 ' + GAME.offline.maxHours + ' 小时。',
      okText: '继 续 修 行',
    });
  }

  function buildModal(cfg) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';

    const rows = (cfg.rows || []).map(([k, v]) =>
      '<div class="modal-row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'
    ).join('');

    mask.innerHTML =
      '<div class="modal">' +
        '<div class="modal-head">' + esc(cfg.title) + '</div>' +
        '<div class="modal-body">' + rows +
          (cfg.note ? '<div class="modal-note">' + esc(cfg.note) + '</div>' : '') +
        '</div>' +
        '<div class="modal-foot"><button class="btn primary" id="modal-ok">' +
          esc(cfg.okText || '确定') + '</button></div>' +
      '</div>';

    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('#modal-ok').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  }

  // ============================================================
  // 子页面切换
  // ============================================================

  function switchTab(name) {
    currentTab = name;
    const tabs = document.querySelectorAll('#tabs .tab');
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].dataset.tab === name);
    }
    const pages = document.querySelectorAll('.page');
    for (let i = 0; i < pages.length; i++) {
      pages[i].classList.toggle('active', pages[i].dataset.page === name);
    }
    // 市场页 / 股市页平时不参与每帧重绘，切过去的这一帧必须补画一次
    if (name === 'market' || name === 'stock') renderAll();
  }

  // ============================================================
  // 静态结构渲染（只做一次）
  // ============================================================

  const DEV_ICONS = {
    pc: 'PC', workstation: 'WS', cluster: 'CL',
    datacenter: 'DC', megacenter: 'MC',
    spiritrack: '灵电', leyline: '脉', array: '阵',
    cavecenter: '洞天', voidlattice: '太虚',
  };

  /** 生产线图标（与算力设备刻意用不同风格，强调这是另一条线） */
  const CO_LINE_ICON = {
    mine: '矿井', smelter: '炼钢', chemplant: '化工', precision: '精密',
    elecplant: '电子', assembly: '装配',
    herbfield: '灵田', talismanry: '符箓', alchemy: '丹房', refine: '炼器',
    arrayforge: '阵盘', cave: '洞天',
  };

  /** 行业图标 —— 商品行与行业条共用同一套单字标记 */
  const IND_ICON = {
    mining: '矿', smelt: '冶', chem: '化', precision: '精', electron: '电', assembly: '装',
    herb: '植', alchemy: '丹', talisman: '符', refine: '器', array: '阵', cave: '洞',
  };

  function indIcon(id) { return IND_ICON[id] || '产'; }
  function indName(id) {
    const ind = (GAME.company.industries || []).find((x) => x.id === id);
    return ind ? ind.name : (id || '其他');
  }

  /** 单个商品行情行的静态结构（市场页按行业分组塞进去） */
  function goodRowHTML(g, kind) {
    const kindName = kind === 'xiuxian' ? '修仙类' : '科技类';
    return '<div class="co-good ' + kind + '" data-good="' + g.id + '">' +
      '<div class="co-good-icon">' + esc(indIcon(g.industry)) + '</div>' +
      '<div class="co-good-main">' +
        '<div class="co-good-title">' + esc(g.name) +
          '<span class="co-line-tag ' + kind + '">' + kindName + '</span>' +
          '<span class="co-line-tag">每 ' + g.periodYears + ' 年变价</span>' +
        '</div>' +
        '<div class="co-good-meta" data-role="gmeta"></div>' +
        '<div class="co-press hidden" data-role="gpress">' +
          '<span class="co-press-label">抛压</span>' +
          '<span class="co-press-bar"><i data-role="gpressbar" style="width:0%"></i></span>' +
          '<span class="co-press-txt" data-role="gpresstxt"></span>' +
        '</div>' +
        '<div class="co-good-spark" data-role="gspark"></div>' +
      '</div>' +
      '<div class="co-good-price">' +
        '<div class="now" data-role="gprice">—</div>' +
        '<div class="trend flat" data-role="gtrend"></div>' +
      '</div>' +
      '<div class="co-good-stock">' +
        '<div class="n zero" data-role="gstock">0 件</div>' +
        '<div class="v" data-role="gvalue">市值 0</div>' +
      '</div>' +
      '<div class="co-good-sell">' +
        '<button class="btn sm" data-role="gsell">卖出</button>' +
      '</div>' +
    '</div>';
  }

  /** 功法被动属性的中文名 */
  const PASSIVE_LABEL = {
    money: '工作金钱',
    energyMax: '精力上限',
    compute: '算力',
    deviceCost: '设备成本',
    shenshi: '神识',
    allOutput: '全部产出',
  };

  const PASSIVE_KEYS = ['money', 'energyMax', 'compute', 'deviceCost', 'shenshi', 'allOutput'];

  /** 带符号百分比：0.05 → +5%，-0.15 → -15% */
  function fmtSignedPct(v) {
    const n = Number(v) || 0;
    const p = n * 100;
    const sign = p >= 0 ? '+' : '';
    return sign + (Math.abs(p) < 1 ? p.toFixed(2) : p.toFixed(1)) + '%';
  }

  /** 普通数值（神识这类可能是很大的整数） */
  function fmtNum(n) {
    if (!isFinite(n)) return '∞';
    const a = Math.abs(n);
    if (a < 1000) return (Math.round(n * 100) / 100).toString();
    if (a < 1e8) return Math.round(n).toLocaleString('en-US');
    return n.toExponential(2).replace('e+', 'e');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function renderStatic() {
    // ---- 时间档位 ----
    $('tier-list').innerHTML = GAME.time.tiers.map((t) => {
      const locked = state.realm < t.unlockRealm;
      const needName = (GAME.realms[t.unlockRealm] || {}).name || '?';
      return '<div class="tier-item' + (locked ? ' locked' : '') + '" data-tier="' + t.tier + '">' +
        '<span class="t-name">' + esc(t.name) + '</span>' +
        '<span class="t-label">' + esc(t.label) + '</span>' +
        '<span class="t-lock">' + (locked ? esc(needName + '解锁') : '　') + '</span>' +
      '</div>';
    }).join('');

    $('tier-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-tier]');
      if (!item) return;
      pickTier(parseInt(item.dataset.tier, 10));
    });

    $('chk-auto-tier').addEventListener('change', (e) => {
      setAutoTier(e.target.checked);
    });

    // ---- 工作列表 ----
    $('job-list').innerHTML = GAME.jobs.map((job, i) => {
      return '<div class="job-item" data-job="' + job.id + '">' +
        '<div class="job-badge">' + pad2(i + 1) + '</div>' +
        '<div class="job-main">' +
          '<div class="job-title">' + esc(job.name) +
            '<span class="job-tag">' + esc(job.real) + '</span>' +
          '</div>' +
          '<div class="job-desc">' + esc(job.desc) + '</div>' +
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

    $('job-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-job]');
      if (!item || item.classList.contains('locked')) return;
      selectJob(item.dataset.job);
    });

    // ---- 设备列表 ----
    $('dev-list').innerHTML = GAME.devices.map((dev) => {
      const myth = (dev.stoneCost || 0) > 0;
      return '<div class="dev-item' + (myth ? ' myth' : '') + '" data-dev="' + dev.id + '">' +
        '<div class="dev-icon">' + esc(DEV_ICONS[dev.id] || '?') + '</div>' +
        '<div class="dev-info">' +
          '<div class="dev-name">' + esc(dev.name) +
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

    $('dev-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role="buy"]');
      if (!btn) return;
      const item = btn.closest('[data-dev]');
      if (item) buyDevice(item.dataset.dev);
    });

    // ---- 投向列表 ----
    $('inv-list').innerHTML = GAME.investments.map((inv) => {
      const locked = !!inv.locked;
      return '<div class="inv-item' + (locked ? ' disabled' : '') + '" data-inv="' + inv.id + '">' +
        '<div class="inv-top">' +
          '<span class="inv-name">' + esc(inv.name) +
            (locked ? '<span class="inv-lock-tag">未习得功法</span>' : '') + '</span>' +
          '<span class="inv-pct" data-role="pct">0%</span>' +
        '</div>' +
        '<div class="inv-desc">' + esc(inv.desc) + '　<span style="color:var(--text-faint)">' +
          esc(inv.period) + '</span></div>' +
        '<div class="inv-controls">' +
          '<input type="range" min="0" max="100" step="5" value="0" data-role="range"' +
            (locked ? ' disabled' : '') + '>' +
        '</div>' +
        '<div class="inv-out">' +
          '<span>产出：<span class="gain" data-role="out">0</span></span>' +
          '<span data-role="total">累计 0</span>' +
        '</div>' +
      '</div>';
    }).join('');

    $('inv-list').addEventListener('input', (e) => {
      const range = e.target.closest('[data-role="range"]');
      if (!range || range.disabled) return;
      const item = range.closest('[data-inv]');
      if (item) onAllocDrag(item.dataset.inv, parseInt(range.value, 10));
    });

    // ---- 功法阁列表 ----
    $('tech-list').innerHTML = GAME.techniques.list.map((t) => {
      const r = GAME.techniques.rarities.find((x) => x.id === t.rarity) || {};
      return '<div class="tech-item" data-tech="' + t.id + '">' +
        '<span class="tech-rarity" data-rarity="' + esc(t.rarity) + '">' +
          esc(r.name || '?') + '</span>' +
        '<div class="tech-item-main">' +
          '<div class="tech-item-title">' + esc(t.name) +
            '<span class="tech-item-school">' + esc(t.school) + '</span></div>' +
          '<div class="tech-item-desc">' + esc(t.desc) + '</div>' +
          '<div class="tech-item-stats" data-role="tstats"></div>' +
        '</div>' +
        '<div class="tech-item-right" data-role="tright"></div>' +
      '</div>';
    }).join('');

    $('tech-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-tech]');
      if (!item || item.classList.contains('locked')) return;
      selectTechnique(item.dataset.tech);
    });

    // ---- 公司：生产线（每条线买下后，每一台都能单独选产物、调产能）----
    $('co-line-list').innerHTML = GAME.company.lines.map((l) => {
      // 门类挂在行业上（产线本身不带 kind），别写成 l.kind —— 那永远是 undefined
      const ind = GAME.company.industries.find((x) => x.id === l.industry);
      const kind = (ind && ind.kind === 'xiuxian') ? 'xiuxian' : 'tech';
      const kindName = kind === 'xiuxian' ? '修仙' : '科技';
      return '<div class="co-line ' + kind + '" data-line="' + l.id + '">' +
        '<div class="co-line-icon">' + esc(indIcon(l.industry)) + '</div>' +
        '<div class="co-line-main">' +
          '<div class="co-line-title">' + esc(l.name) +
            '<span class="co-line-tag ' + kind + '">' + kindName + ' · ' + esc(indName(l.industry)) + '</span>' +
            '<span class="co-line-tag" data-role="lowned">×0</span>' +
          '</div>' +
          '<div class="co-line-desc">' + esc(l.desc) + '</div>' +
          '<div class="co-line-stats" data-role="lstats"></div>' +
          // 每一台的配置行在这里动态回填（台数会变，不能写死在静态结构里）
          '<div class="co-line-units" data-role="lunits"></div>' +
          '<div class="co-line-lock hidden" data-role="llock"></div>' +
        '</div>' +
        '<div class="co-line-right">' +
          '<div class="co-line-owned" data-role="lcap">已拥有 0 条</div>' +
          '<div class="co-line-price" data-role="lprice">—</div>' +
          '<button class="btn sm" data-role="lbuy">购入</button>' +
        '</div>' +
      '</div>';
    }).join('');

    $('co-line-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role="lbuy"]');
      if (btn) {
        const item = btn.closest('[data-line]');
        if (item) buyLine(item.dataset.line);
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
          setLineUnit(lineEl.dataset.line, 'all',
            { product: sel ? sel.value : undefined, rate: rng ? Number(rng.value) / 100 : undefined });
        }
      }
    });

    // 产物 / 产能：松手（change）才提交，拖动过程中只改显示，避免每帧打接口
    $('co-line-list').addEventListener('change', (e) => {
      const lineEl = e.target.closest('[data-line]');
      if (!lineEl) return;
      const unitEl = e.target.closest('[data-unit]');
      if (!unitEl) return;
      const idx = Number(unitEl.dataset.unit);
      const patch = {};
      if (e.target.closest('[data-role="uproduct"]')) patch.product = e.target.value;
      else if (e.target.closest('[data-role="urate"]')) patch.rate = Number(e.target.value) / 100;
      else return;
      setLineUnit(lineEl.dataset.line, idx, patch);
    });

    $('co-line-list').addEventListener('input', (e) => {
      if (!e.target.closest('[data-role="urate"]')) return;
      const unitEl = e.target.closest('[data-unit]');
      if (!unitEl) return;
      const txt = unitEl.querySelector('[data-role="uratetxt"]');
      if (txt) txt.textContent = Math.round(Number(e.target.value)) + '%';
    });

    // ---- 市场：商品行情按行业分组 ----
    $('mk-good-list').innerHTML = GAME.company.industries.map((ind) => {
      const goods = GAME.company.goods.filter((g) => g.industry === ind.id);
      if (!goods.length) return '';
      const kind = ind.kind === 'xiuxian' ? 'xiuxian' : 'tech';
      const ups = (ind.upstream || []).map((u) => indName(u)).join(' + ');
      return '<div class="mk-group ' + kind + '" data-industry="' + ind.id + '">' +
        '<div class="mk-group-head" data-role="ghead">' +
          '<span class="mk-group-icon">' + esc(indIcon(ind.id)) + '</span>' +
          '<span class="mk-group-name">' + esc(ind.name) + '</span>' +
          '<span class="mk-group-tag">' + (ups ? ('上游 · ' + esc(ups)) : '最上游 · 无原料依赖') + '</span>' +
          '<span class="mk-group-idx" data-role="gidx"></span>' +
        '</div>' +
        '<div class="mk-group-body">' + goods.map((g) => goodRowHTML(g, kind)).join('') + '</div>' +
      '</div>';
    }).join('');

    $('mk-good-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-good]');
      if (!item) return;
      // 「卖出」是行内子操作，点了不该把上方的走势图切走
      if (e.target.closest('[data-role="gsell"]')) {
        sellGood(item.dataset.good);
        return;
      }
      chartGood = item.dataset.good;
      renderMarketPage();
    });

    // ---- 市场：行业景气 ----
    $('mk-ind-list').innerHTML = GAME.company.industries.map((ind) => {
      const kind = ind.kind === 'xiuxian' ? 'xiuxian' : 'tech';
      const ups = (ind.upstream || []).map((u) => indName(u)).join(' + ');
      return '<div class="mk-ind ' + kind + '" data-industry="' + ind.id + '">' +
        '<div class="mk-ind-top">' +
          '<span class="mk-ind-icon">' + esc(indIcon(ind.id)) + '</span>' +
          '<span class="mk-ind-name">' + esc(ind.name) + '</span>' +
          '<span class="mk-ind-up">' + (ups ? ('← ' + esc(ups)) : '最上游') + '</span>' +
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
      $('st-list').innerHTML = GAME.stock.stocks.map((st) => {
        const linked = !!st.link;
        const good = linked ? GAME.company.goods.find((g) => g.id === st.link) : null;
        const kind = st.kind === 'xiuxian' ? 'xiuxian' : 'tech';
        return '<div class="st-row' + (linked ? ' linked' : '') + ' ' + kind + '" data-stock="' + st.id + '">' +
          '<div class="st-icon">' + esc((st.name || '股').slice(0, 2)) + '</div>' +
          '<div class="st-main">' +
            '<div class="st-title">' + esc(st.name) +
              '<span class="st-code">' + esc(st.code) + '</span>' +
              '<span class="co-line-tag ' + kind + '">' + (kind === 'xiuxian' ? '修仙宗门' : '科技') + '</span>' +
              (good ? '<span class="co-line-tag">联动 · ' + esc(good.name) + '</span>' : '') +
            '</div>' +
            // 主营业务 —— 行情一动就能看出波及的是哪家公司
            '<div class="st-biz">主营：' + esc(st.business || '—') + '</div>' +
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

      $('st-list').addEventListener('click', (e) => {
        const item = e.target.closest('[data-stock]');
        if (!item) return;
        const id = item.dataset.stock;
        // 交易控件是行内子操作，点了不该把上方的走势图切走
        if (e.target.closest('[data-role="stbuy"]')) { stockTrade('buy', id); return; }
        if (e.target.closest('[data-role="stsell"]')) { stockTrade('sell', id); return; }
        if (e.target.closest('[data-role="stclose"]')) { stockTrade('sell', id, true); return; }
        if (e.target.closest('[data-role="stmax"]')) { stockFillMax(id); return; }
        if (e.target.closest('.st-trade')) return;
        chartStock = id;
        renderStockPage();
      });

      // 输入框里的数字必须实时进缓存 —— 否则下一次重绘就把它抹掉了
      $('st-list').addEventListener('input', (e) => {
        const inp = e.target.closest('[data-role="stqty"]');
        if (!inp) return;
        const item = inp.closest('[data-stock]');
        if (!item) return;
        stockQty[item.dataset.stock] = inp.value;
        renderStockPage();
      });
    }

    // ---- 功法页解锁条件 ----
    $('ui-tech-unlock').textContent = '拥有第一台个人电脑';
  }

  // ============================================================
  // 动态渲染
  // ============================================================

  function renderAll() {
    if (!state) return;
    renderTop();
    renderTiers();
    renderRealmPage();
    renderWorkPage();
    renderTechPage();
    renderInvestPage();
    renderCompanyPage();
    // 市场页与股市页平时不参与每帧重绘：商品 72 种、股票 50 家，
    // 每行还带一张迷你走势图，后台页没必要每 100ms 全画一遍。
    // 但**首次渲染必须铺满** —— 否则切过去之前这两页是空的（测试与首屏都依赖它）。
    if (currentTab === 'market' || !firstRenderDone) renderMarketPage();
    if (currentTab === 'stock' || !firstRenderDone) renderStockPage();
    renderTechniquePage();
    firstRenderDone = true;
  }
  let firstRenderDone = false;

  function renderTop() {
    // 被动金钱速率 = 设备被动收益 + 公司净收益（两者都与精力/工作无关）
    const income = Core.autoIncome(state).add(Core.companyIncomePerSecond(state));
    const info = Core.realmInfo(state);
    const target = Core.nextRealm(state);

    setText('ui-money',   fmt(state.money));
    setText('ui-income',  fmtRate(income));
    setText('ui-compute', fmt(state.realCompute));
    setText('ui-qi',      fmt(state.qi));
    setText('ui-spirit',  fmt(state.spiritStone));
    setText('ui-shenshi', fmtNum(Core.totalShenshi(state)));

    const devCompute = Core.totalCompute(state);
    if (state.aiBonus && state.aiBonus.gt(0)) {
      setText('ui-compute-sub', '设备 ' + fmt(devCompute) + ' + AI ' + fmt(state.aiBonus));
    } else {
      setText('ui-compute-sub', '设备提供');
    }

    const spiritOk = Core.spiritAllowed(state);
    setText('ui-qi-sub', spiritOk ? '突破境界用' : '需习得功法');

    const stoneRate = Core.deviceStoneOutput(state);
    setText('ui-spirit-sub', stoneRate.gt(0) ? fmtRate(stoneRate) : '购修仙设备');

    const shBonusPct = Core.totalShenshi(state) * GAME.shenshi.computeBonusPerPoint * 100;
    setText('ui-shenshi-sub', '算力 +' + shBonusPct.toFixed(1) + '%');

    setText('ui-realm-top',  info.name);
    setText('ui-realm-prog', target.need ? pct(state.realmProgress) : '圆满');

    // 游戏内时钟
    setText('ui-clock', Core.fmtGameDate(state.gameSeconds));
    setText('ui-clock-tier', Core.tierInfo(state.timeTier).label);
  }

  function renderTiers() {
    const items = $('tier-list').querySelectorAll('.tier-item');
    for (let i = 0; i < items.length; i++) {
      const t = parseInt(items[i].dataset.tier, 10);
      const locked = state.realm < (GAME.time.tiers.find((x) => x.tier === t) || {}).unlockRealm;
      items[i].classList.toggle('locked', locked);
      items[i].classList.toggle('active', state.timeTier === t);
    }

    $('chk-auto-tier').checked = !!state.autoTier;
    $('ui-tier-current').textContent = Core.tierInfo(state.timeTier).label;

    const maxT = Core.maxUnlockedTier(state);
    const cur = Core.tierInfo(state.timeTier);
    if (state.realm >= GAME.realms.length - 1) {
      $('ui-tier-hint').textContent = '已是最高档';
    } else {
      const nextLocked = GAME.time.tiers.find((x) => x.tier === maxT + 1);
      $('ui-tier-hint').textContent = nextLocked
        ? ('下一档：' + nextLocked.label + '（' + (GAME.realms[nextLocked.unlockRealm] || {}).name + '解锁）')
        : '已是最高档';
    }
  }

  function renderRealmPage() {
    const info = Core.realmInfo(state);
    const target = Core.nextRealm(state);

    $('ui-realm').textContent = info.name;
    $('ui-realm-tier').textContent = 'TIER ' + state.realm;
    $('ui-realm-bar').style.width = (target.need
      ? Math.min(100, Math.max(0, state.realmProgress.toNumber() * 100))
      : 100) + '%';

    if (target.need) {
      $('ui-realm-need').textContent = '灵气 ' + fmt(state.qi) + ' / ' + fmt(target.need);
      $('ui-realm-next').textContent = '下一境：' + target.next.name;
    } else {
      $('ui-realm-need').textContent = '灵气 ' + fmt(state.qi);
      $('ui-realm-next').textContent = '已至此境巅峰';
    }

    const tech = Core.currentTech(state);
    $('ui-stat-shenshi').textContent = fmtNum(Core.totalShenshi(state));
    $('ui-stat-qimul').textContent = '×' + Core.qiMultiplier(state).toFixed(2);
    $('ui-stat-tech').textContent = tech ? tech.name : (Core.techniqueUnlocked(state) ? '无' : '未习得');

    $('ui-totaljobs').textContent = fmtCount(state.totalJobs) + ' 次';
    $('ui-rushcount').textContent = fmtCount(state.rushCount) + ' 次';
    $('ui-playtime').textContent = fmtRealDuration(state.playTime);
  }

  function renderWorkPage() {
    const job = Core.jobById(state.jobId);
    const maxE = Core.maxEnergy(state);
    const regen = GAME.energy.regenPerSecond;

    // ---- 精力 ----
    const eRatio = maxE > 0 ? Math.max(0, Math.min(1, state.energy / maxE)) : 0;
    const fill = $('ui-energy-bar');
    fill.style.width = (eRatio * 100).toFixed(1) + '%';
    fill.classList.toggle('low', eRatio <= GAME.energy.lowRatio);
    $('ui-energy-val').textContent = Math.floor(state.energy) + ' / ' + maxE;
    $('ui-energy-rate').textContent = '+' + regen.toFixed(1) + ' / 秒';

    if (job) {
      $('ui-energy-next').textContent = '每份工作消耗 ' + job.energy + ' 点';
      if (state.energy < job.energy) {
        const wait = (job.energy - state.energy) / regen;
        $('ui-energy-wait').innerHTML = '<span class="warn">还需 ' + fmtRealDuration(wait) + ' 恢复</span>';
      } else {
        $('ui-energy-wait').textContent = '';
      }
    } else {
      $('ui-energy-next').textContent = '尚未选择工作';
      $('ui-energy-wait').textContent = '';
    }

    // ---- 当前工作 ----
    if (!job) {
      $('ui-job-name').textContent = '—';
      $('ui-job-real').textContent = '';
      $('ui-job-bar').style.width = '0%';
      $('ui-job-time').textContent = '未选择工作';
      $('ui-job-eta').textContent = '';
      $('ui-job-money').textContent = '+0';
      $('ui-job-spirit').classList.add('hidden');
      $('ui-job-stone').classList.add('hidden');
      $('btn-rush').disabled = true;
      $('ui-job-status').textContent = '空闲';
    } else {
      const dur = Core.jobDurationSeconds(job);
      const prog = dur > 0 ? Math.max(0, Math.min(1, state.jobProgress / dur)) : 0;
      const remainGame = Math.max(0, dur - state.jobProgress);
      const speed = Core.gameSecondsPerRealSecond(state);
      const remainReal = speed > 0 ? remainGame / speed : 0;
      const enough = state.energy >= job.energy;

      $('ui-job-name').textContent = job.name;
      $('ui-job-real').textContent = job.real;
      $('ui-job-bar').style.width = (prog * 100).toFixed(2) + '%';
      $('ui-job-time').textContent =
        Core.fmtGameDuration(state.jobProgress) + ' / ' + Core.fmtGameDuration(dur);

      if (!state.working) {
        $('ui-job-eta').textContent = '已暂停';
      } else if (!enough) {
        $('ui-job-eta').textContent = '精力不足，等待中';
      } else {
        $('ui-job-eta').textContent = '约 ' + fmtRealDuration(remainReal) + ' 后完成';
      }

      const inc = Core.jobIncome(job);
      $('ui-job-money').textContent = '+' + fmt(inc.money);
      const sp = $('ui-job-spirit');
      if (job.spirit) {
        sp.classList.remove('hidden');
        sp.textContent = '+' + fmt(inc.spirit) + ' 灵气';
      } else {
        sp.classList.add('hidden');
      }
      const st = $('ui-job-stone');
      if (job.stone) {
        st.classList.remove('hidden');
        st.textContent = '+' + fmt(inc.stone) + ' 灵石';
      } else {
        st.classList.add('hidden');
      }

      $('btn-rush').disabled = !enough;
      $('btn-toggle-work').textContent = state.working ? '暂停' : '继续';
      $('ui-job-status').textContent = !state.working
        ? '已暂停'
        : (enough ? '进行中' : '精力不足');
    }

    // ---- 工作列表 ----
    const items = $('job-list').querySelectorAll('.job-item');
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const j = Core.jobById(el.dataset.job);
      if (!j) continue;
      const unlocked = Core.jobUnlocked(state, j);
      const done = Core.jobDoneCount(state, j.id);
      const dur = Core.jobDurationSeconds(j);

      el.classList.toggle('locked', !unlocked);
      el.classList.toggle('active', state.jobId === j.id);

      const lockEl = el.querySelector('[data-role="lock"]');
      if (unlocked) {
        lockEl.classList.add('hidden');
      } else {
        lockEl.classList.remove('hidden');
        lockEl.textContent = '未解锁 · ' + Core.lockedReason(state, j);
      }

      el.querySelector('[data-role="jstat"]').textContent =
        '耗时 ' + Core.fmtGameDuration(dur) + '　精力 ' + j.energy;
      el.querySelector('[data-role="jdone"]').textContent =
        '已完成 ' + fmtCount(done) + ' 次';

      el.querySelector('[data-role="jmoney"]').textContent =
        unlocked ? ('+' + fmt(new D(j.money))) : '—';

      const spEl = el.querySelector('[data-role="jspirit"]');
      if (j.spirit) {
        spEl.classList.remove('hidden');
        spEl.textContent = '+' + fmt(new D(j.spirit)) + ' 灵气';
      } else {
        spEl.classList.add('hidden');
      }

      const stEl = el.querySelector('[data-role="jstone"]');
      if (j.stone) {
        stEl.classList.remove('hidden');
        stEl.textContent = '+' + fmt(new D(j.stone)) + ' 灵石';
      } else {
        stEl.classList.add('hidden');
      }
    }
  }

  function renderTechPage() {
    for (const dev of GAME.devices) {
      const el = document.querySelector('[data-dev="' + dev.id + '"]');
      if (!el) continue;

      const owned = state.devices[dev.id] || 0;
      const cost  = Core.deviceCost(state, dev);
      const stoneCost = Core.deviceStoneCost(state, dev);
      const canMoney = state.money.gte(cost);
      const canStone = !stoneCost.gt(0) || state.spiritStone.gte(stoneCost);
      const can   = canMoney && canStone;

      el.querySelector('[data-role="owned"]').textContent = '×' + owned;

      // 设备属性说明
      const bits = ['算力 +' + fmt(new D(dev.compute))];
      if (dev.shenshiBonus) bits.push('神识 +' + dev.shenshiBonus);
      if (dev.stonePerSecond) bits.push('灵石 +' + dev.stonePerSecond + '/秒');
      el.querySelector('[data-role="stat"]').textContent = bits.join('　');

      const priceEl = el.querySelector('[data-role="price"]');
      priceEl.textContent = fmt(cost);
      priceEl.classList.toggle('no', !canMoney);

      const stoneEl = el.querySelector('[data-role="stone"]');
      if (stoneCost.gt(0)) {
        stoneEl.classList.remove('hidden');
        stoneEl.textContent = '+ ' + fmt(stoneCost) + ' 灵石';
        stoneEl.classList.toggle('no', !canStone);
      } else {
        stoneEl.classList.add('hidden');
      }

      const discEl = el.querySelector('[data-role="disc"]');
      if (state.costDiscount < 0.999) {
        discEl.classList.remove('hidden');
        discEl.textContent = '折 ' + (state.costDiscount * 100).toFixed(0) + '%';
      } else {
        discEl.classList.add('hidden');
      }

      const buyBtn = el.querySelector('[data-role="buy"]');
      buyBtn.disabled = !can;
      el.classList.toggle('locked', owned === 0 && !can);
    }
  }

  function renderInvestPage() {
    let allocSum = 0;

    for (const inv of GAME.investments) {
      const el = document.querySelector('[data-inv="' + inv.id + '"]');
      if (!el) continue;

      const available = Core.investmentAvailable(state, inv);
      el.classList.toggle('disabled', !available);

      const a = state.alloc[inv.id] || 0;
      if (available) allocSum += a;

      const range = el.querySelector('[data-role="range"]');
      range.disabled = !available;
      if (document.activeElement !== range) {
        range.value = Math.round(a * 100);
      }

      el.querySelector('[data-role="pct"]').textContent = available
        ? Math.round(a * 100) + '%' : '锁定';
      el.querySelector('[data-role="out"]').textContent =
        fmt(Core.investOutput(state, inv)) + ' / 秒';
      el.querySelector('[data-role="total"]').textContent =
        '累计 ' + fmt(state.produced[inv.id]);
    }

    const sumEl = $('ui-alloc-sum');
    const sumPct = Math.round(allocSum * 100);
    sumEl.textContent = '合计 ' + sumPct + '%';
    sumEl.className = 'hint alloc-sum ' + (sumPct > 100 ? 'over' : 'ok');

    const xiuxianPct = Math.round((state.alloc.xiuxian || 0) * 100);
    $('ui-alloc-warn').classList.toggle('hidden', xiuxianPct > 0);
  }

  function renderCompanyPage() {
    const C = GAME.company;
    if (!C || !C.implemented) return;

    const founded = Core.companyFounded(state);
    $('company-panel').classList.toggle('hidden', founded);
    $('company-main').classList.toggle('hidden', !founded);
    $('tab-company').classList.toggle('locked', !founded);
    $('tab-company-badge').textContent = founded ? '经营中' : '未成立';

    // ---------- 未成立：注册门槛 ----------
    if (!founded) {
      const cost = new D(C.foundCost);
      const need = C.unlock || {};
      const realmOk = Core.companyUnlocked(state);
      $('ui-co-found-cost').textContent = fmt(cost);
      $('ui-co-found-lock').textContent = realmOk
        ? (state.money.lt(cost) ? '（金钱不足）' : '')
        : ('（需达到「' + ((GAME.realms[need.realm] || {}).name || '?') + '」）');

      const btn = $('btn-found-company');
      btn.disabled = !realmOk || state.money.lt(cost);
      btn.textContent = realmOk ? '注册成立' : '尚未解锁';
      return;
    }

    // ---------- 已成立 ----------
    const cyc = C.cycleRealSeconds;
    const up = Core.companyUpkeep(state);
    const gross = Core.companyCycleGross(state);
    const net = Core.companyCycleNet(state);
    const cap = Core.warehouseCapacity(state);
    const used = Core.stockTotal(state);

    // 周期进度
    const prog = cyc > 0 ? Math.max(0, Math.min(1, state.company.cycleProgress / cyc)) : 0;
    $('ui-co-cycle-bar').style.width = (prog * 100).toFixed(1) + '%';
    $('ui-co-cycle-label').textContent =
      '下个周期 ' + fmtRealDuration(Math.max(0, cyc - state.company.cycleProgress)) + ' 后';
    $('ui-co-cycle-count').textContent =
      '已完成 ' + fmtCount(state.company.cycles) + ' 个周期';

    // 经营状态
    const statusEl = $('ui-co-status');
    if (state.money.lt(up.total) && up.total.gt(0)) {
      statusEl.textContent = '资金不足 · 停产';
      statusEl.className = 'hint err';
    } else if (used >= cap && cap > 0) {
      statusEl.textContent = '仓库已满 · 停产';
      statusEl.className = 'hint err';
    } else {
      statusEl.textContent = '运转中';
      statusEl.className = 'hint ok';
    }

    // 收支
    $('ui-co-gross').textContent = '+' + fmt(gross);
    $('ui-co-upkeep').textContent = '-' + fmt(up.total);
    const netEl = $('ui-co-net');
    netEl.textContent = (net.isNeg() ? '' : '+') + fmt(net);
    netEl.className = 'v ' + (net.isNeg() ? 'red' : 'jade');
    $('ui-co-netps').textContent = fmtRate(Core.companyIncomePerSecond(state));
    $('ui-co-revenue').textContent = fmt(state.company.totalRevenue);
    $('ui-co-upkeep-total').textContent = fmt(state.company.totalUpkeep);

    // 仓库
    const lv = Core.warehouseLevel(state);
    const maxLv = C.warehouse.maxLevel;
    const atMax = lv >= maxLv;
    const cost = Core.warehouseCost(state);
    $('ui-co-wh-level').textContent = 'Lv.' + lv;
    $('ui-co-wh-bar').style.width =
      (cap > 0 ? Math.min(100, used / cap * 100) : 0).toFixed(1) + '%';
    $('ui-co-wh-val').textContent = fmtCount(used) + ' / ' + fmtCount(cap);

    const whBtn = $('btn-co-warehouse');
    whBtn.textContent = atMax ? '已满级' : ('扩容 ' + fmt(cost));
    whBtn.disabled = atMax || state.money.lt(cost);
    $('ui-co-wh-cost').textContent = atMax
      ? ('仓库已至最高等级 Lv.' + maxLv + '，容量 ' +
         fmtCount(C.warehouse.baseCapacity + maxLv * C.warehouse.perLevel) + ' 件')
      : ('下一级容量 ' + fmtCount(C.warehouse.baseCapacity + (lv + 1) * C.warehouse.perLevel) +
         ' 件　需 ' + fmt(cost) + ' 金钱');

    $('chk-co-autosell').checked = !!state.company.autoSell;

    // ---------- 工业算力 ----------
    // 买线只拿到「产能上限」，真正转起来要靠工业算力。供给不足时全厂按比例削减，
    // 所以多买线不会凭空增产 —— 这是「工业产能」这条投向的全部意义。
    const pool = Core.industrialComputePool(state);
    const demand = Core.companyComputeDemand(state);
    const scale = Core.companyComputeScale(state);
    const share = state.alloc.industry || 0;

    setText('ui-co-cp-pool', fmt(pool));
    setText('ui-co-cp-demand', fmt(demand));
    setText('ui-co-cp-share', (share * 100).toFixed(1) + '%');
    setText('ui-co-cp-val', fmt(demand) + ' / ' + fmt(pool));

    // 进度条画的是「吃掉了多少供给」，满格 = 刚好吃满
    const useRatio = demand.gt(0)
      ? demand.div(pool.gt(0) ? pool : new D(1)).toNumber()
      : 0;
    $('ui-co-cp-bar').style.width =
      Math.round(Math.max(0, Math.min(1, useRatio)) * 100) + '%';

    const cpScale = $('ui-co-cp-scale');
    if (demand.lte(0)) {
      cpScale.className = 'hint';
      cpScale.textContent = '无产线开工';
    } else if (scale >= 0.999) {
      cpScale.className = 'hint ok';
      cpScale.textContent = '算力充足 · 满负荷';
    } else {
      cpScale.className = 'hint ' + (scale < 0.5 ? 'err' : 'warn');
      cpScale.textContent = '算力不足 · 全厂按 ' + (scale * 100).toFixed(0) + '% 运转';
    }
    setText('ui-co-cp-tip', share <= 0
      ? '「工业产能」份额为 0 —— 产线买再多也不会转。去「投向」页把算力拨过来。'
      : '提高「工业产能」份额 = 提高全厂产能；它会和境界修行抢同一份算力。');

    // ---------- 生产线（每台可单独选产物、调产能）----------
    let lineCount = 0;
    const lineItems = $('co-line-list').querySelectorAll('.co-line');
    for (let i = 0; i < lineItems.length; i++) {
      const el = lineItems[i];
      const line = GAME.company.lines.find((x) => x.id === el.dataset.line);
      if (!line) continue;

      const units = Core.lineUnits(state, line.id);
      const owned = units.length;
      const unlocked = Core.lineUnlocked(state, line);
      const price = Core.lineCost(state, line);
      const prods = Core.lineProducts(line);
      lineCount += owned;

      el.classList.toggle('locked', !unlocked && owned === 0);
      el.querySelector('[data-role="lowned"]').textContent = '×' + fmtCount(owned);
      el.querySelector('[data-role="lcap"]').textContent = '已拥有 ' + fmtCount(owned) + ' 条';

      el.querySelector('[data-role="lstats"]').innerHTML =
        '产能上限 ' + esc(fmt(new D(line.maxCompute))) + ' 算力 / 台' +
        '　可选产物 ' + prods.length + ' 种' +
        '　<span class="faint">满负荷基准 ' + esc(fmtNum(line.baseOutput)) + ' 件 / 台 · 周期</span>';

      const lockEl = el.querySelector('[data-role="llock"]');
      if (unlocked) {
        lockEl.classList.add('hidden');
      } else {
        lockEl.classList.remove('hidden');
        lockEl.textContent = '未解锁 · ' + Core.lineLockedReason(state, line);
      }

      const priceEl = el.querySelector('[data-role="lprice"]');
      priceEl.textContent = fmt(price);
      priceEl.classList.toggle('no', state.money.lt(price));

      const buyBtn = el.querySelector('[data-role="lbuy"]');
      buyBtn.disabled = !unlocked || state.money.lt(price);

      renderLineUnits(el, line, units, prods, scale);
    }
    $('ui-co-line-hint').textContent = lineCount > 0
      ? ('共 ' + fmtCount(lineCount) + ' 条生产线 · 每台可单独换产物')
      : '买下一条线只是拿到产能上限，转起来要靠工业算力';
  }

  /**
   * 回填一条产线下「每一台」的配置行。
   *
   * 结构只在**台数或产物**变化时重建 —— 产能是拖动条，玩家正拖着的时候
   * 如果把 DOM 整个换掉，拖动会被打断。所以产能只回写显示值，且焦点在它上面时不回写。
   */
  const unitSigCache = Object.create(null);
  function renderLineUnits(el, line, units, prods, scale) {
    const box = el.querySelector('[data-role="lunits"]');
    if (!box) return;
    const key = el.dataset.line;
    const sig = units.length + '|' + units.map((u) => u.p).join(',');

    if (unitSigCache[key] !== sig) {
      unitSigCache[key] = sig;
      box.innerHTML = units.map((u, idx) => {
        const opts = prods.map((g) =>
          '<option value="' + esc(g.id) + '"' + (g.id === u.p ? ' selected' : '') + '>' +
          esc(g.name) + '</option>').join('');
        return '<div class="co-unit" data-unit="' + idx + '">' +
          '<span class="co-unit-idx">#' + (idx + 1) + '</span>' +
          '<select class="co-unit-sel" data-role="uproduct" aria-label="第 ' + (idx + 1) + ' 台的产物">' +
            opts +
          '</select>' +
          '<input type="range" min="0" max="100" step="5" value="' + Math.round(u.r * 100) + '" ' +
            'class="co-unit-range" data-role="urate" aria-label="第 ' + (idx + 1) + ' 台的产能">' +
          '<span class="co-unit-rate" data-role="uratetxt">' + Math.round(u.r * 100) + '%</span>' +
          '<span class="co-unit-out" data-role="uout"></span>' +
          '<button class="btn sm ghost" data-role="uapplyall" title="把这台的配置套用到整条线">全部套用</button>' +
        '</div>';
      }).join('');
    }

    // 只回写数值与产能显示（不重建 DOM，避免打断拖动）
    const rows = box.querySelectorAll('.co-unit');
    for (let i = 0; i < rows.length; i++) {
      const u = units[i];
      if (!u) continue;
      const outEl = rows[i].querySelector('[data-role="uout"]');
      const good = Core.goodById(u.p);
      if (outEl) {
        if (!good || !Core.unitActive(u)) {
          outEl.className = 'co-unit-out off';
          outEl.textContent = '停机';
        } else {
          outEl.className = 'co-unit-out';
          const perCycle = Core.unitOutput(state, line, u, scale);
          const unitPrice = Core.goodsPriceWith(state, good);
          outEl.textContent = fmtNum(perCycle) + ' 件 / 周期　毛 ' + fmt(unitPrice.mul(perCycle));
        }
      }
      const rng = rows[i].querySelector('[data-role="urate"]');
      if (rng && document.activeElement !== rng) {
        const want = String(Math.round(u.r * 100));
        if (rng.value !== want) rng.value = want;
      }
      const txt = rows[i].querySelector('[data-role="uratetxt"]');
      if (txt) txt.textContent = Math.round(u.r * 100) + '%';
    }
  }

  /**
   * 市场页 —— 商品行情独立成页。
   *
   * 价格是公开信息，未成立公司也能看；库存与卖出要公司成立后才可用。
   * 商品按**行业**分组：上游涨价会顺着产业链传导（下游成本涨、售价跟涨但毛利被压缩），
   * 所以分组头会把这个行业的成本 / 售价指数显示出来。
   */
  function renderMarketPage() {
    if (!GAME.company || !GAME.company.implemented) return;
    const founded = Core.companyFounded(state);

    // 走势图选中的商品：为空或已失效（配置改过）时回落到第一个
    if (!GAME.company.goods.some((g) => g.id === chartGood)) {
      chartGood = GAME.company.goods.length ? GAME.company.goods[0].id : null;
    }

    // ---------- 行业景气 ----------
    let worstMargin = 1;
    const indItems = $('mk-ind-list').querySelectorAll('.mk-ind');
    for (let i = 0; i < indItems.length; i++) {
      const el = indItems[i];
      const id = el.dataset.industry;
      const cost = Core.industryCostIndex(state, id);
      const price = Core.industryPriceIndex(state, id);
      const up = Core.industryUpstreamRatio(state, id);
      // 毛利空间 ≈ 售价指数 / 成本指数：上游涨得比售价快，这个值就掉下来
      const margin = cost > 0 ? price / cost : 1;
      if (margin < worstMargin) worstMargin = margin;

      const cEl = el.querySelector('[data-role="icost"]');
      cEl.textContent = '成本 ×' + cost.toFixed(3);
      cEl.className = 'mk-ind-num ' + (cost > 1.001 ? 'red' : (cost < 0.999 ? 'jade' : ''));

      const pEl = el.querySelector('[data-role="iprice"]');
      pEl.textContent = '售价 ×' + price.toFixed(3);
      pEl.className = 'mk-ind-num ' + (price > 1.001 ? 'red' : (price < 0.999 ? 'jade' : ''));

      const mEl = el.querySelector('[data-role="imargin"]');
      mEl.textContent = '毛利 ×' + margin.toFixed(3) +
        '　上游 ×' + up.toFixed(3);
      mEl.className = 'mk-ind-num ' + (margin < 0.97 ? 'red' : (margin > 1.03 ? 'jade' : 'faint'));
    }
    const indHint = $('ui-mk-ind-hint');
    if (indHint) {
      if (worstMargin >= 0.999) {
        indHint.className = 'hint';
        indHint.textContent = '全产业链平价　·　上游原料涨 → 下游成本涨、售价跟涨，但毛利被压缩';
      } else {
        indHint.className = 'hint ' + (worstMargin < 0.9 ? 'err' : 'warn');
        indHint.textContent = '最紧的行业毛利 ×' + worstMargin.toFixed(3) +
          '　·　上游涨价会吃掉下游利润';
      }
    }

    // ---------- 商品行情 ----------
    let stockValue = new D(0);
    let peakPressure = 0;
    let pressuredGoods = 0;

    const groups = $('mk-good-list').querySelectorAll('.mk-group');
    for (let gi = 0; gi < groups.length; gi++) {
      const gid = groups[gi].dataset.industry;
      const idxEl = groups[gi].querySelector('[data-role="gidx"]');
      if (idxEl) {
        const c = Core.industryCostIndex(state, gid);
        const p = Core.industryPriceIndex(state, gid);
        idxEl.textContent = '成本 ×' + c.toFixed(2) + '　售价 ×' + p.toFixed(2);
      }

      const items = groups[gi].querySelectorAll('.co-good');
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const good = GAME.company.goods.find((x) => x.id === el.dataset.good);
        if (!good) continue;

        // 价格一律用带抛压的版本 —— 界面上看到的钱必须就是卖出能拿到的钱
        const price = Core.goodsPriceWith(state, good);
        const trend = Core.goodsTrend(good, state.gameSeconds);
        const pressure = Core.pressureOf(state, good.id);
        const drop = Core.marketDropRatio(state, good);
        if (pressure > peakPressure) peakPressure = pressure;
        if (pressure > 0) pressuredGoods += 1;

        const stock = Core.stockOf(state, good.id);
        const value = price.mul(stock);
        stockValue = stockValue.add(value);

        el.querySelector('[data-role="gprice"]').textContent = fmt(price);

        // 涨红跌绿（中国习惯）
        const tEl = el.querySelector('[data-role="gtrend"]');
        const arrow = trend === 'up' ? '▲ 涨' : (trend === 'down' ? '▼ 跌' : '— 平');
        tEl.className = 'trend ' + trend;
        tEl.textContent = arrow + '　基准 ' + fmt(new D(good.basePrice));

        el.querySelector('[data-role="gmeta"]').innerHTML =
          '距下次变价 ' + esc(Core.fmtGameDuration(Core.goodsNextChangeIn(good, state.gameSeconds))) +
          '　累计卖出 ' + fmtCount(state.company.goodsSold[good.id] || 0) + ' 件';

        // ---------- 抛压条 ----------
        const pressEl = el.querySelector('[data-role="gpress"]');
        if (pressEl) {
          pressEl.classList.toggle('hidden', pressure <= 0);
          const barEl = el.querySelector('[data-role="gpressbar"]');
          if (barEl) barEl.style.width = Math.round(pressure * 100) + '%';
          const txtEl = el.querySelector('[data-role="gpresstxt"]');
          if (txtEl) {
            txtEl.innerHTML = '已被压 −' + esc((drop * 100).toFixed(1)) + '%' +
              '<span class="faint">　本应 ' + esc(fmt(Core.naturalPrice(good, state.gameSeconds, state))) +
              '　卖出后下一期起跳</span>';
          }
          pressEl.classList.toggle('warn', pressure >= ((GAME.company.market || {}).warnAt || 0.45));
        }

        el.classList.toggle('selected', good.id === chartGood);

        // 行内迷你走势：只看已发生的期，不推演
        const sparkEl = el.querySelector('[data-role="gspark"]');
        if (sparkEl) sparkEl.innerHTML = priceChartSVG(good, state.gameSeconds, trend, 8, 0, 34);

        const nEl = el.querySelector('[data-role="gstock"]');
        nEl.textContent = fmtCount(stock) + ' 件';
        nEl.classList.toggle('zero', stock === 0);
        el.querySelector('[data-role="gvalue"]').textContent = '市值 ' + fmt(value);

        el.querySelector('[data-role="gsell"]').disabled = !founded || stock <= 0;
      }
    }

    // ---------- 底部：库存与清仓（要公司成立）----------
    const used = Core.stockTotal(state);
    setText('ui-mk-stock-value', fmt(stockValue));
    setText('ui-mk-stock-count', fmtCount(used));
    const foot = $('mk-foot');
    if (foot) foot.classList.toggle('hidden', !founded);
    const sellAllBtn = $('btn-mk-sell-all');
    if (sellAllBtn) sellAllBtn.disabled = !founded || used <= 0;

    const mktHint = $('ui-mk-market-hint');
    if (mktHint) {
      if (!founded) {
        mktHint.className = 'hint';
        mktHint.textContent = '行情公开可看　·　成立公司后才能在市场里卖货';
      } else if (peakPressure <= 0) {
        mktHint.className = 'hint';
        mktHint.textContent = '科技类逐年变价 · 修仙类每 10 年变价　·　无抛压';
      } else {
        const warnAt = (GAME.company.market || {}).warnAt || 0.45;
        mktHint.className = 'hint ' + (peakPressure >= warnAt ? 'err' : 'warn');
        mktHint.textContent = '抛压最高 ' + (peakPressure * 100).toFixed(0) + '%' +
          '（' + fmtCount(pressuredGoods) + ' 种商品被压价）　·　正常清仓不压价，砸库存才会';
      }
    }

    // ---------- 走势图（跟随选中的商品）----------
    const cg = GAME.company.goods.find((g) => g.id === chartGood) || GAME.company.goods[0];
    const chartBody = $('mk-chart-body');
    if (cg && chartBody) {
      const span = 12;
      const cTrend = Core.goodsTrend(cg, state.gameSeconds);
      const cPeriod = Core.goodsPeriod(cg, state.gameSeconds);
      const per = cg.periodYears || 1;
      const yearOf = (n) => GAME.time.startYear + n * per;

      chartBody.innerHTML = priceChartSVG(cg, state.gameSeconds, cTrend, span, 8, 118);
      setText('ui-mk-chart-name', cg.name);
      setText('ui-mk-chart-tag',
        esc(indName(cg.industry)) + ' · 每 ' + per + ' 年变价');

      const cPrice = Core.goodsPriceWith(state, cg);
      const cNatural = Core.naturalPrice(cg, state.gameSeconds, state);
      const cDrop = Core.marketDropRatio(state, cg);
      const cCost = Core.industryCostIndex(state, cg.industry);
      setText('ui-mk-chart-foot',
        '时间轴 ' + yearOf(Math.max(0, cPeriod - span)) + ' ~ ' + yearOf(cPeriod + 8) +
        ' 年（当前 ' + yearOf(cPeriod) + ' 年）　现价 ' + fmt(cPrice) +
        (cDrop > 0.0005 ? '（自然价 ' + fmt(cNatural) + '，被抛压压低 ' + (cDrop * 100).toFixed(1) + '%）' : '') +
        '　基准 ' + fmt(new D(cg.basePrice)) +
        '　' + indName(cg.industry) + '成本 ×' + cCost.toFixed(2) +
        '　距下次变价 ' + Core.fmtGameDuration(Core.goodsNextChangeIn(cg, state.gameSeconds)));
    }
  }

  function renderStockPage() {
    const S = GAME.stock;
    if (!S || !S.implemented) return;

    const unlocked = Core.stockUnlocked(state);
    $('stock-panel').classList.toggle('hidden', unlocked);
    $('stock-main').classList.toggle('hidden', !unlocked);
    $('tab-stock').classList.toggle('locked', !unlocked);

    // ---------- 未开户 ----------
    if (!unlocked) {
      $('tab-stock-badge').textContent = '未开户';
      $('ui-st-lock').textContent = Core.stockLockedReason(state) || '尚未开放';
      return;
    }

    const sum = Core.stockSummary(state);
    if (!sum) return;

    const held = sum.stocks.filter((x) => x.shares > 0).length;
    $('tab-stock-badge').textContent = held > 0 ? ('持 ' + held + ' 只') : '已开户';

    // ---------- 账户概览 ----------
    // 盈亏一律按「可变现」口径：市值里含着自己买出来的冲击溢价，
    // 而那份溢价在卖出时会被自己砸回去，不算真赚到的钱。
    $('ui-st-value').textContent = fmt(sum.totalValue);
    $('ui-st-cost').textContent = fmt(sum.totalCost);

    const pnlEl = $('ui-st-pnl');
    pnlEl.textContent = (sum.pnl.isNeg() ? '' : '+') + fmt(sum.pnl);
    pnlEl.className = 'v ' + (sum.pnl.isNeg() ? 'jade' : 'red');

    $('ui-st-liq').textContent = fmt(sum.liquidateValue);
    const lpEl = $('ui-st-liqpnl');
    lpEl.textContent = (sum.liquidatePnl.isNeg() ? '' : '+') + fmt(sum.liquidatePnl);
    lpEl.className = 'v ' + (sum.liquidatePnl.isNeg() ? 'jade' : 'red');

    $('ui-st-cash').textContent = fmt(state.money);

    const rEl = $('ui-st-realized');
    rEl.textContent = (sum.realized.isNeg() ? '' : '+') + fmt(sum.realized);
    rEl.className = 'v ' + (sum.realized.isNeg() ? 'jade' : 'red');

    $('ui-st-fee').textContent = '-' + fmt(sum.totalFee);
    $('ui-st-trades').textContent = fmtCount(sum.totalTrades) + ' 笔';

    const ratioEl = $('ui-st-pnlratio');
    ratioEl.className = 'hint';
    ratioEl.textContent = sum.totalCost.gt(0)
      ? ('可变现收益率 ' + fmtSignedPct(sum.liquidatePnlRatio))
      : '暂无持仓';

    // ---------- 选中股票（走势图 + 行情时钟都跟着它）----------
    if (!GAME.stock.stocks.some((x) => x.id === chartStock)) {
      const withHold = sum.stocks.find((x) => x.shares > 0);
      chartStock = (withHold || sum.stocks[0] || {}).id || null;
    }
    const sel = sum.stocks.find((x) => x.id === chartStock) || sum.stocks[0];

    if (sel) {
      const st = Core.stockById(sel.id);
      const len = Core.stockPeriodSeconds(st);
      const prog = len > 0 ? ((state.gameSeconds % len) / len) : 0;
      $('ui-st-periodbar').style.width = (prog * 100).toFixed(1) + '%';
      $('ui-st-period-label').textContent =
        '距离下次变价 ' + Core.fmtGameDuration(Core.stockNextChangeIn(st, state.gameSeconds));
      $('ui-st-period').textContent = '第 ' + sel.period + ' 期 · ' +
        (GAME.time.startYear + sel.period * (st.periodYears || 1)) + ' 年';
    }

    const peakEl = $('ui-st-peak');
    if (sum.peak <= 1e-9) {
      peakEl.className = 'hint';
      peakEl.textContent = '无冲击';
    } else {
      const sev = sum.peak / Math.max(1e-9, Number(sum.maxRise) || 0.6);
      peakEl.className = 'hint ' + (sev >= 0.6 ? 'err' : 'warn');
      peakEl.textContent = '冲击峰值 ' + (sum.peak * 100).toFixed(2) + '%';
    }

    $('ui-st-rules').innerHTML =
      '<div>成交价 = 自然价 × 冲击系数　自然价 = 基准 × 行情 × 公司联动 ' +
        (sum.linkWeight * 100).toFixed(0) + '%</div>' +
      '<div>单边手续费 ' + (sum.fee * 100).toFixed(2) + '%　单笔成交额 ≥ ' +
        esc(fmt(new D(sum.minOrder))) + '</div>' +
      '<div>净买入流每期衰减至 ' + (sum.flowDecay * 100).toFixed(0) +
        '%　买入最多推高 ' + (sum.maxRise * 100).toFixed(0) +
        '%、卖出最多压低 ' + (sum.maxDrop * 100).toFixed(0) + '%</div>' +
      '<div>成交按「成交之后」的冲击价结算 —— 同一轮买卖必亏掉溢价 + 双边手续费</div>';

    // ---------- 行情列表 ----------
    // 池子 50 家，界面默认只列市值前 N 家；榜外公司照样能交易，
    // 只是不占版面 —— 榜单随行情换人，涨起来的公司会自己挤进来。
    const boardRank = Object.create(null);
    for (let i = 0; i < sum.board.length; i++) boardRank[sum.board[i].id] = i + 1;

    const boardTxt = $('ui-st-board-txt');
    const boardBtn = $('btn-st-board-all');
    if (boardTxt) {
      boardTxt.textContent = showAllStocks
        ? ('全部 ' + sum.stocks.length + ' 家')
        : ('市值榜 · 前 ' + sum.board.length + ' 家（共 ' + sum.stocks.length + ' 家）');
    }
    if (boardBtn) {
      boardBtn.textContent = showAllStocks ? '只看市值前 10' : '显示全部 ' + sum.stocks.length + ' 家';
    }

    const rows = $('st-list').querySelectorAll('.st-row');
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i];
      const row = sum.stocks.find((x) => x.id === el.dataset.stock);
      if (!row) continue;
      const st = Core.stockById(row.id);

      // 榜外公司：默认隐藏，点「显示全部」才铺开
      const rank = boardRank[row.id] || 0;
      el.classList.toggle('hidden', !showAllStocks && rank === 0);
      if (!showAllStocks && rank === 0) continue;

      el.classList.toggle('selected', row.id === chartStock);
      el.classList.toggle('locked', !row.unlocked);

      const trend = row.trend;
      const tEl = el.querySelector('[data-role="sttrend"]');
      tEl.className = 'trend ' + trend;
      tEl.textContent = (trend === 'up' ? '▲ 涨' : (trend === 'down' ? '▼ 跌' : '— 平')) +
        '　基准 ' + fmt(new D(row.basePrice));

      el.querySelector('[data-role="stprice"]').textContent = fmt(row.price);

      el.querySelector('[data-role="stmeta"]').innerHTML =
        '距变价 ' + esc(Core.fmtGameDuration(row.nextChangeIn)) +
        '　流通盘 ' + fmtCount(row.depth) + ' 股' +
        (rank > 0 ? '　市值 ' + esc(fmt(row.marketCap)) + ' · 第 ' + rank + ' 名' : '') +
        '　持仓占比 ' + esc(pct(row.heldRatio)) +
        '　净买入流 ' + (row.flow > 0 ? '+' : '') + fmtCount(row.flow) + ' 股';

      // ---------- 冲击条 ----------
      const impEl = el.querySelector('[data-role="stimp"]');
      if (impEl) {
        const pctv = row.impactPct;
        const on = Math.abs(pctv) > 1e-6;
        impEl.classList.toggle('hidden', !on);
        impEl.classList.toggle('down', pctv < 0);
        impEl.classList.toggle('warn', pctv > 0);
        const barEl = el.querySelector('[data-role="stimpbar"]');
        if (barEl) {
          const full = pctv >= 0 ? (Number(sum.maxRise) || 1) : (Number(sum.maxDrop) || 1);
          barEl.style.width = Math.round(Math.min(1, Math.abs(pctv) / full) * 100) + '%';
        }
        const txtEl = el.querySelector('[data-role="stimptxt"]');
        if (txtEl) {
          txtEl.innerHTML = (pctv >= 0 ? '买盘推高 +' : '卖盘压低 −') +
            esc((Math.abs(pctv) * 100).toFixed(2)) + '%' +
            '<span class="faint">　自然价 ' + esc(fmt(row.naturalPrice)) +
            '　逐期衰减回去</span>';
        }
      }

      // ---------- 持仓 ----------
      const sEl = el.querySelector('[data-role="stshares"]');
      sEl.textContent = fmtCount(row.shares) + ' 股';
      sEl.classList.toggle('zero', row.shares <= 0);
      el.querySelector('[data-role="stvalue"]').textContent = row.shares > 0
        ? ('市值 ' + fmt(row.value)) : '未持仓';

      const pEl = el.querySelector('[data-role="stpnl"]');
      if (row.shares > 0) {
        pEl.className = 'pnl ' + (row.liquidatePnl.isNeg() ? 'down' : 'up');
        pEl.textContent = '可变现 ' + fmt(row.liquidateValue) + '　' +
          (row.liquidatePnl.isNeg() ? '' : '+') + fmt(row.liquidatePnl) +
          '（' + fmtSignedPct(row.liquidatePnlRatio) + '）';
      } else {
        pEl.className = 'pnl';
        pEl.textContent = '';
      }

      // ---------- 交易 ----------
      // 首次渲染给一个「够得着最小成交额」的默认手数；之后完全由玩家决定
      if (stockQty[row.id] === undefined) {
        const px = row.price.toNumber() || 1;
        stockQty[row.id] = Math.max(1, Math.ceil((Number(sum.minOrder) || 0) / px));
      }
      const qty = Math.max(0, Math.floor(Number(stockQty[row.id]) || 0));

      const qtyEl = el.querySelector('[data-role="stqty"]');
      if (qtyEl) {
        const want = String(stockQty[row.id]);
        if (qtyEl.value !== want) qtyEl.value = want;
        qtyEl.max = String(Math.max(1, row.depth));
      }

      // 买入预览
      const bq = Core.stockBuyQuote(state, st, qty);
      const costEl = el.querySelector('[data-role="stcost"]');
      let buyOk = false;
      if (qty <= 0) {
        costEl.className = 'st-trade-cost';
        costEl.textContent = '输入股数';
      } else if (!bq.ok) {
        costEl.className = 'st-trade-cost no';
        costEl.textContent = bq.msg;
      } else if (bq.tooSmall) {
        costEl.className = 'st-trade-cost no';
        costEl.textContent = '买额需 ≥ ' + fmt(new D(sum.minOrder));
      } else if (bq.total.gt(state.money)) {
        costEl.className = 'st-trade-cost no';
        costEl.textContent = '买需 ' + fmt(bq.total) + ' · 金钱不足';
      } else {
        costEl.className = 'st-trade-cost';
        costEl.textContent = '买需 ' + fmt(bq.total) + ' · 均价 ' + fmt(bq.unitPrice);
        buyOk = true;
      }

      // 卖出预览（数量超过持仓时按持仓算，与内核的 clamp 一致）
      const sellable = Math.min(qty, row.shares);
      const sq = sellable > 0 ? Core.stockSellQuote(state, st, sellable) : null;
      const netEl = el.querySelector('[data-role="stnet"]');
      let sellOk = false;
      if (row.shares <= 0) {
        netEl.className = 'st-trade-cost';
        netEl.textContent = '未持仓';
      } else if (qty <= 0) {
        netEl.className = 'st-trade-cost';
        netEl.textContent = '输入股数';
      } else if (!sq || !sq.ok) {
        netEl.className = 'st-trade-cost no';
        netEl.textContent = (sq && sq.msg) || '无法卖出';
      } else if (sq.tooSmall) {
        netEl.className = 'st-trade-cost no';
        netEl.textContent = '卖额需 ≥ ' + fmt(new D(sum.minOrder));
      } else {
        netEl.className = 'st-trade-cost';
        netEl.textContent = '卖得 ' + fmt(sq.net) +
          (sellable < qty ? '（按 ' + fmtCount(sellable) + ' 股）' : '') +
          ' · 均价 ' + fmt(sq.unitPrice);
        sellOk = true;
      }

      el.querySelector('[data-role="stbuy"]').disabled = !buyOk;
      el.querySelector('[data-role="stsell"]').disabled = !sellOk;
      el.querySelector('[data-role="stclose"]').disabled = row.shares <= 0;
      el.querySelector('[data-role="stmax"]').disabled = row.maxBuy <= 0;

      // 行内迷你走势：只看已发生的期，不推演
      const sparkEl = el.querySelector('[data-role="stspark"]');
      if (sparkEl) sparkEl.innerHTML = stockChartSVG(st, state.gameSeconds, trend, 8, 0, 34);
    }

    // ---------- 行情概览提示 ----------
    const hintEl = $('ui-st-market-hint');
    if (sum.peak <= 1e-9) {
      hintEl.className = 'hint';
      hintEl.textContent = '无冲击　·　所有股票都在按自然价成交';
    } else {
      const sev = sum.peak / Math.max(1e-9, Number(sum.maxRise) || 0.6);
      hintEl.className = 'hint ' + (sev >= 0.6 ? 'err' : 'warn');
      hintEl.textContent = '冲击峰值 ' + (sum.peak * 100).toFixed(2) +
        '%　·　净买入流每期衰减至 ' + (sum.flowDecay * 100).toFixed(0) + '%';
    }

    // ---------- 走势图（跟随选中的股票）----------
    const chartBody = $('st-chart-body');
    if (sel && chartBody) {
      const st = Core.stockById(sel.id);
      chartBody.innerHTML = stockChartSVG(st, state.gameSeconds, sel.trend, 12, 8, 118);

      setText('ui-st-chart-name', sel.name + '　' + sel.code);
      const good = sel.link ? Core.goodById(sel.link) : null;
      setText('ui-st-chart-tag',
        (good ? '联动 · ' + good.name : '独立行情') + ' · 每 ' + (sel.periodYears || 1) + ' 年变价');

      let foot = '第 ' + Math.max(0, sel.period - 12) + ' ~ ' + (sel.period + 8) +
        ' 期（当前第 ' + sel.period + ' 期）　成交价 ' + fmt(sel.price) +
        '　自然价 ' + fmt(sel.naturalPrice) +
        '　基准 ' + fmt(new D(sel.basePrice)) +
        '　距变价 ' + Core.fmtGameDuration(sel.nextChangeIn);
      if (Math.abs(sel.impactPct) > 1e-6) {
        foot += '　' + (sel.impactPct > 0 ? '你的买盘把成交价推高 ' : '你的卖盘把成交价压低 ') +
          (Math.abs(sel.impactPct) * 100).toFixed(2) + '%（会逐期衰减回去）';
      }
      setText('ui-st-chart-foot', foot);
    }
  }

  function renderTechniquePage() {
    const has = Core.techniqueUnlocked(state);

    $('technique-panel').classList.toggle('hidden', has);
    $('technique-main').classList.toggle('hidden', !has);
    $('tab-technique').classList.toggle('locked', !has);
    $('tab-technique-badge').textContent = has ? '已习得' : '未习得';

    if (!has) return;

    const tech = Core.currentTech(state);
    const list = Core.techniqueList(state);
    const learnedCount = list.filter((t) => t.learned).length;
    $('ui-tech-count').textContent = learnedCount + ' / ' + list.length + ' 已得';

    // ---- 当前修炼 ----
    if (tech) {
      const info = list.find((t) => t.id === tech.id);
      const rec = state.learned[tech.id];
      const rarity = GAME.techniques.rarities.find((r) => r.id === tech.rarity) || {};

      const rEl = $('ui-tech-rarity');
      rEl.textContent = rarity.name || '?';
      rEl.dataset.rarity = tech.rarity;

      $('ui-tech-name').textContent = tech.name;
      $('ui-tech-school').textContent = tech.school;
      $('ui-tech-desc').textContent = tech.desc;
      $('ui-tech-level').textContent = info ? info.level : 0;
      $('ui-tech-main').textContent = '+' + pct(info ? info.mainQiSpeed : 0);

      // 熟练度（按当前段位内的进度显示，圆满后满格）
      const M = GAME.techniques.mastery;
      const PERFECT = M.length - 1;
      const perfect = info.masteryTier >= PERFECT;
      const segStart = M[Math.min(info.masteryTier, PERFECT)].need;
      const segEnd = perfect ? M[PERFECT].need : M[info.masteryTier + 1].need;
      const segLen = Math.max(1, segEnd - segStart);
      const segProg = perfect ? 1 : Math.max(0, Math.min(1,
        (rec.mastery - segStart) / segLen));

      $('ui-tech-mastery-tier').textContent = info.masteryTierName;
      $('ui-tech-mastery-bar').style.width = (segProg * 100).toFixed(1) + '%';
      $('ui-tech-mastery-val').textContent = perfect
        ? '圆满 · 被动已常驻'
        : (Math.floor(rec.mastery) + ' / ' + segEnd);
      $('ui-tech-cultivate').textContent = '+' + Core.cultivateSpeed(state).toFixed(2) + ' / 秒';

      // 被动属性
      const pbox = $('ui-tech-passive');
      const keys = Object.keys(tech.passive || {});
      if (!keys.length) {
        pbox.innerHTML = '<span class="off">本功法没有被动属性</span>';
      } else {
        pbox.innerHTML = keys.map((k) => {
          const on = rec.passive;
          return '<div class="row"><span class="' + (on ? 'on' : 'off') + '">' +
            (on ? '● ' : '○ ') + esc(PASSIVE_LABEL[k] || k) + ' ' + fmtSignedPct(tech.passive[k]) +
            '　—　' + (on ? '已常驻，切换功法不消失' : '熟练度修满后转为常驻') +
            '</span></div>';
        }).join('');
      }

      // 参悟
      const cost = Core.comprehendCost(state);
      const enough = state.qi.gte(cost);
      $('btn-comprehend').disabled = perfect || !enough;
      $('ui-comprehend-hint').textContent = perfect
        ? '熟练度已至圆满，继续参悟不再有意义。'
        : ('参悟：消耗 ' + fmt(cost) + ' 灵气，立即获得一笔熟练度'
           + (enough ? '' : '（灵气不足）'));
      $('btn-toggle-cultivate').textContent = state.cultivating ? '停止修炼' : '继续修炼';
    }

    // ---- 功法阁 ----
    const items = $('tech-list').querySelectorAll('.tech-item');
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const t = list.find((x) => x.id === el.dataset.tech);
      if (!t) continue;

      el.classList.toggle('locked', !t.learned);
      el.classList.toggle('active', t.active);

      const statsEl = el.querySelector('[data-role="tstats"]');
      if (t.learned) {
        const pl = Object.keys(t.passive || {}).map((k) =>
          esc(PASSIVE_LABEL[k] || k) + ' ' + fmtSignedPct(t.passive[k])).join('　');
        statsEl.innerHTML =
          '<span class="jade">灵气吸收 +' + (t.mainQiSpeed * 100).toFixed(1) + '%</span>' +
          '<span>等级 ' + t.level + '</span>' +
          '<span>熟练度 ' + esc(t.masteryTierName) + '</span>' +
          (pl ? '<span>被动 ' + pl + '</span>' : '');
      } else {
        statsEl.innerHTML = '<span class="lock">' + esc(t.lockedReason || '尚未解锁') + '</span>';
      }

      const rightEl = el.querySelector('[data-role="tright"]');
      let right = t.learned
        ? '<div class="lv">Lv.' + t.level + '</div>'
        : '<div class="lv">—</div>';
      if (t.active) right += '<span class="tag active">修炼中</span>';
      else if (t.passiveActive) right += '<span class="tag passive-on">被动常驻</span>';
      else if (t.learned) right += '<span class="tag">可切换</span>';
      else right += '<span class="tag">未习得</span>';
      rightEl.innerHTML = right;
    }

    // ---- 神识面板 ----
    const sh = Core.totalShenshi(state);
    $('ui-sh-total').textContent = fmtNum(sh);
    $('ui-sh-base').textContent = fmtNum(Core.shenshiBase(state));
    $('ui-sh-dev').textContent = '×' + fmtNum(Core.shenshiDeviceMultiplier(state));
    $('ui-sh-compute').textContent =
      '+' + (sh * GAME.shenshi.computeBonusPerPoint * 100).toFixed(1) + '%';
    $('ui-sh-cultivate').textContent =
      '+' + (sh * GAME.techniques.cultivate.shenshiBonusPerPoint * 100).toFixed(1) + '%';

    // ---- 常驻被动汇总 ----
    $('passive-list').innerHTML = PASSIVE_KEYS.map((k) => {
      const v = Core.passiveBonus(state, k);
      return '<div class="passive-row"><span class="k">' + esc(PASSIVE_LABEL[k]) + '</span>' +
        '<span class="v' + (v ? '' : ' off') + '">' + (v ? fmtSignedPct(v) : '—') + '</span></div>';
    }).join('');
  }

  // ============================================================
  // 操作
  // ============================================================

  async function selectJob(jobId) {
    if (!state) return;
    const r = Core.setJob(state, jobId);
    if (!r.ok) {
      toast(r.msg || '无法选择该工作', 'err');
      return;
    }
    dirty = true;
    const job = Core.jobById(jobId);
    toast('已开始「' + job.name + '」', 'ok');
    renderAll();
    syncNow();
  }

  async function rushJob() {
    if (!state) return;
    const r = Core.rushJob(state, 1);
    if (!r.ok) {
      toast(r.msg, 'err');
      return;
    }
    dirty = true;
    let msg = '+' + fmt(r.money);
    if (r.spirit.gt(0)) msg += '　+' + fmt(r.spirit) + ' 灵气';
    if (r.stone.gt(0)) msg += '　+' + fmt(r.stone) + ' 灵石';
    toast('催工完成　' + msg, 'ok');
    renderAll();
    syncNow();
  }

  async function toggleWork() {
    if (!state) return;
    Core.setWorking(state, !state.working);
    dirty = true;
    renderAll();
    syncNow();
  }

  async function pickTier(tier) {
    if (!state) return;
    const r = Core.setTimeTier(state, tier);
    if (!r.ok) {
      toast(r.msg, 'err');
      return;
    }
    dirty = true;
    toast('时间流速：' + Core.tierInfo(tier).label, 'ok');
    renderAll();
    syncNow();
  }

  async function setAutoTier(on) {
    if (!state) return;
    Core.setAutoTier(state, on);
    dirty = true;
    renderAll();
    syncNow();
  }

  async function buyDevice(deviceId) {
    const beforeIds = new Set(Object.keys(state.learned));
    const r = Core.buyDevice(state, deviceId);
    if (!r.ok) {
      toast(r.msg, 'err');
      return;
    }
    dirty = true;
    const dev = GAME.devices.find((d) => d.id === deviceId);
    let msg = '已购买 ' + dev.name + '（共 ' + r.owned + ' 台）';
    if (r.stoneCost.gt(0)) msg += '　耗灵石 ' + fmt(r.stoneCost);
    toast(msg, 'ok');

    // 买到个人电脑触发了第一本功法 —— 这是本作最重要的一次解锁，必须说清楚
    const newIds = Object.keys(state.learned).filter((id) => !beforeIds.has(id));
    if (newIds.length) {
      const names = newIds.map((id) => {
        const t = Core.techById(id);
        return t ? '《' + t.name + '》' : id;
      }).join('、');
      setTimeout(() => {
        toast('习得功法 ' + names + '　—　灵气、神识、功法增幅已解锁', 'ok');
      }, 380);
    }

    renderAll();
    syncNow();
  }

  async function selectTechnique(techId) {
    if (!state) return;
    const r = Core.setTechnique(state, techId);
    if (!r.ok) {
      toast(r.msg || '无法修炼该功法', 'err');
      return;
    }
    dirty = true;
    const t = Core.techById(techId);
    toast('已开始修炼《' + t.name + '》', 'ok');
    renderAll();
    syncNow();
  }

  async function toggleCultivate() {
    if (!state) return;
    Core.setCultivating(state, !state.cultivating);
    dirty = true;
    renderAll();
    syncNow();
  }

  async function comprehend() {
    if (!state) return;
    const beforePassive = Object.keys(state.learned)
      .filter((id) => state.learned[id].passive).length;

    const r = Core.comprehend(state, 1);
    if (!r.ok) {
      toast(r.msg, 'err');
      return;
    }
    dirty = true;

    const afterPassive = Object.keys(state.learned)
      .filter((id) => state.learned[id].passive).length;

    toast('参悟 +熟练度 ' + Math.round(r.gain) + '　耗灵气 ' + fmt(r.cost), 'ok');
    if (afterPassive > beforePassive) {
      setTimeout(() => {
        toast('熟练度圆满 —— 被动属性已转为常驻', 'ok');
      }, 380);
    }
    renderAll();
    syncNow();
  }

  function onAllocDrag(invId, pctVal) {
    const inv = GAME.investments.find((i) => i.id === invId);
    if (!inv || !Core.investmentAvailable(state, inv)) return;

    const want = Math.max(0, Math.min(100, pctVal)) / 100;
    const others = Core.allocatableInvestments(state).filter((i) => i.id !== invId);
    const remain = Math.max(0, 1 - want);

    const alloc = {};
    alloc[invId] = want;

    let otherSum = 0;
    for (const o of others) otherSum += (state.alloc[o.id] || 0);

    if (otherSum <= 0) {
      const share = others.length ? remain / others.length : 0;
      for (const o of others) alloc[o.id] = share;
    } else {
      const scale = remain / otherSum;
      for (const o of others) alloc[o.id] = (state.alloc[o.id] || 0) * scale;
    }

    Core.setAllocation(state, alloc);
    dirty = true;
    renderAll();
  }

  function setAllocPreset(kind) {
    const usable = Core.allocatableInvestments(state);
    const alloc = {};
    if (kind === 'reset') {
      for (const inv of GAME.investments) alloc[inv.id] = inv.id === 'xiuxian' ? 1 : 0;
    } else {
      const share = usable.length ? 1 / usable.length : 0;
      for (const inv of GAME.investments) {
        alloc[inv.id] = Core.investmentAvailable(state, inv) ? share : 0;
      }
    }
    Core.setAllocation(state, alloc);
    dirty = true;
    renderAll();
  }

  // ============================================================
  // 公司（产业）操作
  // ============================================================

  /**
   * 公司相关操作统一走服务端（/api/action），不走「本地先改、再同步」的老路。
   *
   * 原因：公司是「一次性付费 + 单向状态」的经济系统 —— 注册、买生产线、扩仓都要
   * 真金白银扣钱，成立之后不可撤销。让服务端裁决比前端直接改数稳妥得多；
   * 而响应里会带回完整 state，前端直接拿它替换本地状态即可保持一致。
   */
  async function companyAction(action, payload) {
    if (!state) return null;
    try {
      const data = await api('/api/action', {
        method: 'POST',
        body: { action: action, payload: payload || {} },
      });
      if (data.state) {
        state = Core.hydrate(data.state);
        lastLocalTick = Date.now();
        lastServerSave = Date.now();
        dirty = true;   // 之后本地还会继续 tick，交给下一次自动同步推上去
      }
      renderAll();
      return data.result || {};
    } catch (e) {
      // 服务端拒绝时也会回传当前 state，用它把本地状态纠正回来
      if (e.data && e.data.state) {
        state = Core.hydrate(e.data.state);
        lastLocalTick = Date.now();
      }
      toast(e.message, 'err');
      renderAll();
      return null;
    }
  }

  async function foundCompany() {
    const r = await companyAction('foundCompany');
    if (!r) return;
    toast('公司已成立　—　去「生产线」买下第一条产线', 'ok');
  }

  async function buyLine(lineId) {
    const r = await companyAction('buyLine', { lineId: lineId });
    if (!r) return;
    const line = GAME.company.lines.find((l) => l.id === lineId);
    toast('已购入「' + (line ? line.name : lineId) + '」（共 ' + r.owned + ' 条）', 'ok');
  }

  /**
   * 调整一台（或一整条线的全部台）产线的产物 / 产能。
   * 与买线不同：这是纯粹的配置变更，本地内核先改、下次同步推上去即可；
   * 但走服务端能保证「产物必须是这条线能造的」这层校验不被绕过。
   */
  async function setLineUnit(lineId, index, patch) {
    const r = await companyAction('setLineUnit', {
      lineId: lineId, index: index, product: patch.product, rate: patch.rate,
    });
    if (!r) return;
    // index === 'all' 时服务端返回 all=true，提示语要说清楚改了几台
    toast('已更新产线配置' + (r.all ? '（整条线 ' + r.count + ' 台）' : ''), 'ok');
  }

  async function upgradeWarehouse() {
    const r = await companyAction('upgradeWarehouse');
    if (!r) return;
    toast('仓库扩容至 Lv.' + r.level + '　容量 ' + fmtCount(r.capacity) + ' 件', 'ok');
  }

  async function sellGood(goodId) {
    const r = await companyAction('sellGoods', { goodId: goodId });
    if (!r) return;
    const g = GAME.company.goods.find((x) => x.id === goodId);
    toast('卖出 ' + (g ? g.name : goodId) + ' ×' + fmtCount(r.count) +
      '　+' + fmt(new D(D.fromJSON(r.revenue))), 'ok');
  }

  async function sellAllGoods() {
    const r = await companyAction('sellGoods', { goodId: 'all' });
    if (!r) return;
    toast('清仓完成　+' + fmt(D.fromJSON(r.revenue)), 'ok');
  }

  async function toggleAutoSell(on) {
    const r = await companyAction('setAutoSell', { autoSell: on });
    if (!r) return;
    toast(on
      ? '已开启自动卖出：每个周期结束自动清仓'
      : '已关闭自动卖出：产物留在仓库里等价格，注意别爆仓', 'ok');
  }

  // ============================================================
  // 股市（证券账户）操作
  // ============================================================

  /**
   * 与公司同理：买卖直接扣钱 / 加钱，是不可逆的经济行为，统一交给服务端裁决。
   * 前端只用同一份内核报价做「预演」，报价不合规就当场说清楚，不必白跑一趟。
   */
  async function stockAction(action, payload) {
    if (!state) return null;
    try {
      const data = await api('/api/action', {
        method: 'POST',
        body: { action: action, payload: payload || {} },
      });
      if (data.state) {
        state = Core.hydrate(data.state);
        lastLocalTick = Date.now();
        lastServerSave = Date.now();
        dirty = true;
      }
      renderAll();
      return data.result || {};
    } catch (e) {
      if (e.data && e.data.state) {
        state = Core.hydrate(e.data.state);
        lastLocalTick = Date.now();
      }
      toast(e.message, 'err');
      renderAll();
      return null;
    }
  }

  function stockQtyValue(id) {
    return Math.max(0, Math.floor(Number(stockQty[id]) || 0));
  }

  /** all = true 时无视输入框，直接按全部持仓卖出（「清仓」按钮） */
  async function stockTrade(side, stockId, all) {
    if (!state) return;
    const stock = Core.stockById(stockId);
    if (!stock) return;

    let shares = all ? Core.stockShares(state, stockId) : stockQtyValue(stockId);
    if (!(shares > 0)) {
      toast(all ? '该股票没有持仓' : '请输入交易股数', 'err');
      return;
    }

    // 本地预演：把「金钱不足 / 超过流通盘 / 不足最小成交额」这类
    // 一定能提前判断的拒绝挡在这里，避免无谓的往返
    const quote = side === 'buy'
      ? Core.stockBuyQuote(state, stock, shares)
      : Core.stockSellQuote(state, stock, shares);
    if (!quote.ok) { toast(quote.msg, 'err'); return; }
    if (quote.tooSmall) {
      toast('单笔成交额不足 ' + Core.fmtBig(Core.stockCfg().minOrder || 0), 'err');
      return;
    }
    if (side === 'buy' && quote.total.gt(state.money)) { toast('金钱不足', 'err'); return; }

    const r = await stockAction(side === 'buy' ? 'buyStock' : 'sellStock',
      { stockId: stockId, shares: shares });
    if (!r) return;

    if (side === 'buy') {
      toast('买入 ' + stock.name + ' ×' + fmtCount(r.shares) +
        '　均价 ' + fmt(D.fromJSON(r.unitPrice)) +
        '　支出 -' + fmt(D.fromJSON(r.total)), 'ok');
      stockQty[stockId] = r.shares;   // 手数保持，方便接着买
    } else {
      const profit = D.fromJSON(r.profit);
      toast('卖出 ' + stock.name + ' ×' + fmtCount(r.shares) +
        '　均价 ' + fmt(D.fromJSON(r.unitPrice)) +
        '　净得 +' + fmt(D.fromJSON(r.net)) +
        '　本笔盈亏 ' + (profit.isNeg() ? '' : '+') + fmt(profit), 'ok');
      // 清仓后把数量还原成默认手数，下次开仓不用自己再填
      if (r.sharesAfter === 0) delete stockQty[stockId];
    }
  }

  function stockFillMax(stockId) {
    if (!state) return;
    const stock = Core.stockById(stockId);
    if (!stock) return;
    const max = Core.stockMaxBuy(state, stock);
    if (max <= 0) {
      toast('金钱不足以买入最小成交额（' +
        Core.fmtBig(Core.stockCfg().minOrder || 0) + '）', 'err');
      return;
    }
    stockQty[stockId] = max;
    renderStockPage();
  }

  // ============================================================
  // 主循环
  // ============================================================

  function startLoop() {
    stopLoop();
    lastLocalTick = Date.now();

    tickTimer = setInterval(() => {
      const now = Date.now();
      let dt = (now - lastLocalTick) / 1000;
      lastLocalTick = now;

      // 切后台久了再回来：按离线规则结算
      if (dt > GAME.offline.thresholdSeconds) {
        Core.tick(state, dt, { offline: true });
        toast('检测到长时间未操作，按离线规则结算', 'ok');
      } else if (dt > 0) {
        Core.tick(state, dt, { offline: false });
      }

      renderAll();

      if (now - lastServerSave >= GAME.save.intervalMs) {
        syncNow();
      }
    }, GAME.ui.tickMs);
  }

  function stopLoop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function setSaveStatus(text, cls) {
    const el = $('save-status');
    el.textContent = text;
    el.className = cls || '';
  }

  let syncing = false;

  async function syncNow(force) {
    if (!state || !token || syncing) return;
    if (!dirty && !force) {
      lastServerSave = Date.now();
      return;
    }

    syncing = true;
    setSaveStatus('同步中…');

    try {
      await api('/api/save', {
        method: 'POST',
        body: { state: Core.serialize(state) },
      });
      dirty = false;
      lastServerSave = Date.now();
      setSaveStatus('已同步', 'ok');
    } catch (e) {
      setSaveStatus('同步失败', 'err');
      console.warn('[存档失败]', e.message);
    } finally {
      syncing = false;
    }
  }

  // ============================================================
  // 事件绑定
  // ============================================================

  $('btn-login').addEventListener('click', () => doAuth('login'));
  $('btn-register').addEventListener('click', () => doAuth('register'));

  $('in-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAuth('login');
  });
  $('in-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('in-password').focus();
  });

  // ---- 子页面切换 ----
  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });

  // ---- 工作页 ----
  $('btn-rush').addEventListener('click', rushJob);
  $('btn-toggle-work').addEventListener('click', toggleWork);

  // ---- 功法页 ----
  $('btn-comprehend').addEventListener('click', comprehend);
  $('btn-toggle-cultivate').addEventListener('click', toggleCultivate);

  // ---- 公司页 ----
  $('btn-found-company').addEventListener('click', foundCompany);
  $('btn-co-warehouse').addEventListener('click', upgradeWarehouse);
  $('chk-co-autosell').addEventListener('change', (e) => toggleAutoSell(e.target.checked));
  // 「去调投向份额」—— 工业算力不足时最直接的出口
  const cpGoto = $('btn-co-cp-goto');
  if (cpGoto) cpGoto.addEventListener('click', () => switchTab('invest'));

  // ---- 市场页（商品行情独立页，与公司页共用同一套卖出逻辑）----
  const mkSellAll = $('btn-mk-sell-all');
  if (mkSellAll) mkSellAll.addEventListener('click', sellAllGoods);

  // ---- 股市页 ----
  const boardBtn = $('btn-st-board-all');
  if (boardBtn) {
    boardBtn.addEventListener('click', () => {
      showAllStocks = !showAllStocks;
      renderAll();
    });
  }

  // 空格键也能催工
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if ($('game-screen').classList.contains('hidden')) return;
    if (currentTab !== 'work') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'button' || tag === 'textarea') return;
    e.preventDefault();
    rushJob();
  });

  $('btn-save-now').addEventListener('click', () => {
    syncNow(true);
    toast('已存档', 'ok');
  });

  $('btn-alloc-reset').addEventListener('click', () => setAllocPreset('reset'));
  $('btn-alloc-even').addEventListener('click', () => setAllocPreset('even'));

  $('btn-logout').addEventListener('click', async () => {
    await syncNow(true);
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    clearToken();
    state = null;
    showLogin();
    setLoginMsg('已登出');
  });

  // 关页面前尽力存一次
  window.addEventListener('beforeunload', () => {
    if (!state || !token) return;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/save', false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('x-token', token);
      xhr.send(JSON.stringify({ state: Core.serialize(state) }));
    } catch (e) {}
  });

  // 切回标签页时校正时间
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastLocalTick = Date.now();
    }
  });

  // ============================================================
  // 启动
  // ============================================================

  (async function boot() {
    const saved = readToken();
    if (!saved || !saved.token) {
      showLogin();
      return;
    }

    token = saved.token;
    username = saved.username || '';
    setLoginMsg('正在恢复道途…');

    try {
      const me = await api('/api/me');
      username = me.username;
      $('ui-username').textContent = username;
      setLoginMsg('');
      await enterGame();
    } catch (e) {
      showLogin();
      setLoginMsg('登录已失效，请重新登入', true);
    }
  })();

})();
