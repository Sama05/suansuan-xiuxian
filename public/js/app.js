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
  // 市场行业折叠（v3.6）：folded 集合 + 初始化哨兵 + 签名缓存
  const mktFolded = new Set();
  const mktFoldInit = new Set();
  let mktFoldSig = '';
  // 生产线折叠（v3.6）
  const lineFolded = new Set();
  const lineFoldInit = new Set();
  let lineFoldSig = '';
  // 功法阁视图：'owned' 只显示已拥有（默认）| 'codex' 图鉴（全部 + 解锁条件）
  let techView = 'owned';
  // 功法列表 DOM 的重建签名 = 已拥有 id 串。变化才重建，其余帧只改数值。
  let techListSig = '';
  // 每只股票的交易数量。必须缓存下来：列表每 100ms 重绘一次，
  // 若每次都用配置里的默认值回写输入框，玩家刚敲进去的数字会被冲掉。
  const stockQty = Object.create(null);
  /**
   * 买卖报价缓存。key = (期数 | 净买入流 | 持仓 | 手数 | 最小成交额)，
   * 报价只由这几项决定；金钱只影响「够不够买」那一次比较，不进 key。
   * 行情不动就一帧都不用重算 —— 报价要走行业传导链，50 只股票全量重算每帧要几毫秒。
   */
  const stockQuoteCache = Object.create(null);
  /** 迷你走势图缓存。价格按「期」变，期内 SVG 是静止的，没换期就不重建。 */
  const stockSparkCache = new Map();

  /**
   * 只在值变化时才写 DOM。
   * 100ms 一帧的重绘里，绝大多数字段的值根本没变 —— 直接赋值也会让浏览器
   * 把对应节点标记为脏、重新做样式与布局。先比对再写，是这里最便宜的一档优化。
   */
  function setT(el, prop, value) {
    if (!el) return;
    if (el[prop] !== value) el[prop] = value;
  }
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

  /** 变价周期（现实秒）→ 简洁文案："60 秒" / "10 分钟" / "1 小时" */
  function fmtPeriod(sec) {
    sec = Math.max(1, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + ' 秒';
    if (sec % 3600 === 0) return (sec / 3600) + ' 小时';
    if (sec % 60 === 0) return (sec / 60) + ' 分钟';
    return fmtRealDuration(sec);
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
   * @param {number} realClock   行情时钟（现实秒累计 = state.playTime）
   * @param {string} trend       'up' | 'down' | 'flat'（决定线条颜色，涨红跌绿）
   * @param {number} past        往前取几期
   * @param {number} future      往后推演几期（0 = 只画已发生）
   * @param {number} height      viewBox 高度
   */
  function priceChartSVG(good, realClock, trend, past, future, height) {
    const series = Core.goodsWindowWith(state, good, past, future);
    if (!series || series.length < 2) return '';

    const curPeriod = Core.goodsPeriod(good, realClock);
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
  function stockChartSVG(stock, realClock, trend, past, future, height) {
    const series = Core.stockWindow(state, stock, past, future);
    if (!series || series.length < 2) return '';

    const curPeriod = Core.stockPeriod(stock, realClock);
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
  // 事件通知栏
  // ============================================================

  /**
   * 页面最上方的播报条。
   *
   * 设计取舍：**事件在客户端生成，不进存档。**
   * 所有事件的来源（自动卖出入账、投向调整、功法突破、渡劫、境界突破）
   * 都能在两次渲染之间从 state 的差值里读出来 —— 公司收入看 totalRevenue 的增量、
   * 段位看 learned[id].tier、境界看 realm。做成客户端观察器，就完全不用动
   * 存档结构与后端防作弊清单（那些字段每一个都要配套「只增 / 夹取」逻辑）。
   * 代价是刷新页面后历史清空 —— 通知本来就是「现在正在发生什么」，不是账本。
   */
  const EV_MAX = 40;
  const events = [];
  let lastEventAt = Date.now();
  let evSeq = 0;
  /** 观察快照：与上一帧比较用 */
  const evSnap = {
    realm: -1, techTiers: {}, techLevels: {}, learnedSet: null, revenue: null, autoSold: 0, alloc: {},
  };
  /** 自动卖出入账的聚合窗口：攒 6 秒报一次，不然每个生产周期（20s 内多次）都刷屏 */
  let sellAccum = new (window.Decimal || Object)();
  let sellAccumSince = 0;
  const SELL_WINDOW_MS = 6000;
  /** 多久没有新事件就开始播行情前瞻 */
  const IDLE_FORECAST_MS = 20000;

  function pushEvent(text, kind) {
    const now = Date.now();
    events.unshift({
      id: ++evSeq, text: text, kind: kind || 'info',
      at: now, game: Core.fmtGameDate(state.gameSeconds),
    });
    if (events.length > EV_MAX) events.length = EV_MAX;
    lastEventAt = now;
    renderEventBar();
  }

  function renderEventBar() {
    const e = events[0];
    if (!e) return;
    const txtEl = $('ui-ev-text');
    if (txtEl) txtEl.textContent = e.text;
    const dot = $('ui-ev-dot');
    if (dot) dot.className = 'ev-dot ' + (e.kind || 'info');
    const cnt = $('ui-ev-count');
    if (cnt) {
      cnt.hidden = events.length <= 1;
      cnt.textContent = events.length > 1 ? ('+' + (events.length - 1)) : '';
    }
  }

  function renderEventHistory() {
    const box = $('ev-history');
    if (!box) return;
    if (!events.length) {
      box.innerHTML = '<div class="ev-row dim">还没有消息</div>';
      return;
    }
    box.innerHTML = events.slice(0, 12).map((e) =>
      '<div class="ev-row"><span class="ev-t">' + esc(e.game) + '</span>' +
      '<span class="ev-m ' + (e.kind || 'info') + '">' + esc(e.text) + '</span></div>'
    ).join('');
  }

  /**
   * 两次渲染之间观察 state 的差值，生成事件。
   * 在 tick 循环里每帧调用 —— 所有比较都是 O(小常数)。
   */
  function observeEvents() {
    if (!state) return;
    // 诊断计数器（保留）：播报不工作时，先看这三个数 —— 调用了多少帧、
    // 距上次事件多久、前瞻函数给出什么。不用再猜「是不是没接线」。
    window.__evDbg = window.__evDbg || { frames: 0, since: 0, forecast: null };
    window.__evDbg.frames += 1;
    window.__evDbg.since = Date.now() - lastEventAt;

    // ---- 境界突破 ----
    if (evSnap.realm >= 0 && state.realm > evSnap.realm) {
      pushEvent('境界突破 → ' + realmNameOf(state.realm) +
        '（全项基础加成提升，精力上限与恢复速度提高）', 'good');
    }
    evSnap.realm = state.realm;

    // ---- 习得新功法（v3.4：功法扩到 41 本，习得值得播一条）----
    {
      const keys = Object.keys(state.learned || {});
      if (evSnap.learnedSet) {
        for (const id of keys) {
          if (!evSnap.learnedSet[id]) {
            const t = Core.techById(id);
            if (t) pushEvent('习得功法：《' + t.name + '》（' + t.school + '）', 'good');
          }
        }
      }
      evSnap.learnedSet = {};
      for (const id of keys) evSnap.learnedSet[id] = true;
    }

    // ---- 功法突破（熟练度段位提升）----
    for (const id of Object.keys(state.learned || {})) {
      const rec = state.learned[id];
      if (!rec) continue;
      const prev = evSnap.techTiers[id];
      if (prev === undefined) { evSnap.techTiers[id] = rec.tier; continue; }
      if (rec.tier > prev) {
        const t = Core.techById(id);
        const seg = Core.masteryInfo(rec.tier);
        if (t) pushEvent('功法突破：《' + t.name + '》熟练度达到「' + seg.name + '」'
          + (rec.passive ? '，被动已常驻' : ''), 'good');
      }
      evSnap.techTiers[id] = rec.tier;
    }

    // ---- 功法升级（v3.5 独立经验制，升级值得播一条）----
    for (const id of Object.keys(state.learned || {})) {
      const rec = state.learned[id];
      if (!rec) continue;
      const prev = evSnap.techLevels[id];
      if (prev === undefined) { evSnap.techLevels[id] = rec.level || 0; continue; }
      if ((rec.level || 0) > prev) {
        const t = Core.techById(id);
        if (t) pushEvent('功法升级：《' + t.name + '》→ Lv.' + rec.level, 'good');
      }
      evSnap.techLevels[id] = rec.level || 0;
    }

    // ---- 公司自动卖出入账（按窗口聚合）----
    const rev = state.company && state.company.totalRevenue;
    if (rev && rev.gt && evSnap.revenue && rev.gt(evSnap.revenue)) {
      const d = rev.sub(evSnap.revenue);
      sellAccum = sellAccum.add(d);
      if (!sellAccumSince) sellAccumSince = Date.now();
    }
    evSnap.revenue = (state.company && state.company.totalRevenue) || null;
    if (sellAccumSince && Date.now() - sellAccumSince >= SELL_WINDOW_MS) {
      if (sellAccum.gt(0)) {
        pushEvent('货物售出：入账 ' + fmt(sellAccum) + ' 金钱', 'money');
      }
      sellAccum = new (window.Decimal || Object)(0);
      sellAccumSince = 0;
    }

    // ---- 投向比例调整 ----
    const alloc = state.alloc || {};
    for (const k of Object.keys(alloc)) {
      const prev = evSnap.alloc[k];
      const cur = alloc[k];
      if (prev === undefined) { evSnap.alloc[k] = cur; continue; }
      if (Math.abs(cur - prev) >= 0.005) {   // 变动 ≥ 0.5 个百分点才报
        const inv = GAME.investments.find((i) => i.id === k);
        if (inv) {
          pushEvent('投向调整：' + inv.name + ' ' +
            (cur > prev ? '+' : '−') + Math.abs((cur - prev) * 100).toFixed(0) +
            '%（现为 ' + Math.round(cur * 100) + '%）', 'info');
        }
      }
      evSnap.alloc[k] = cur;
    }

    // ---- 空闲播报：一段时间没有新事件，随机挑一家公司播下期预计涨跌 ----
    if (Date.now() - lastEventAt >= IDLE_FORECAST_MS && GAME.stock &&
        GAME.stock.implemented && GAME.stock.stocks.length) {
      const st = GAME.stock.stocks[Math.floor(Math.random() * GAME.stock.stocks.length)];
      const f = Core.stockForecastPct(state, st);
      window.__evDbg.forecast = f;
      if (f !== null) {
        pushEvent('行情前瞻：' + st.name + '（' + st.code + '）下期预计 ' +
          (f > 0 ? '+' : '') + f.toFixed(1) + '%', f > 0 ? 'good' : 'jade');
      }
    }
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
    const kindName = kind === 'xiuxian' ? '修仙类' : (kind === 'fusion' ? '融合类' : '科技类');
    return '<div class="co-good ' + kind + '" data-good="' + g.id + '">' +
      '<div class="co-good-icon">' + esc(indIcon(g.industry)) + '</div>' +
      '<div class="co-good-main">' +
        '<div class="co-good-title">' + esc(g.name) +
          '<span class="co-line-tag ' + kind + '">' + kindName + '</span>' +
          '<span class="co-line-tag">每 ' + fmtPeriod(g.periodSeconds) + '变价</span>' +
          (kind !== 'tech' ? '<span class="co-line-tag cur">售 → 灵石</span>' : '') +
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
    // 时间档位不再铺成列表 —— 顶栏的四键（◀ / ▶⏸ / ▶▶ / ▶▶▶）就是全部入口，
    // 具体倍率看 clock-tier 上的数字。列表形式会让人以为那是「四套并存的档」。

    // ---- 时间流速四键（顶栏）----
    $('btn-tc-slower').addEventListener('click', tcSlower);
    $('btn-tc-play').addEventListener('click', tcPlayPause);
    $('btn-tc-faster').addEventListener('click', tcFaster);
    $('btn-tc-max').addEventListener('click', tcMax);

    // ---- 事件通知栏：点击展开 / 收起历史 ----
    const evBar = $('event-bar');
    if (evBar) {
      evBar.addEventListener('click', () => {
        const box = $('ev-history');
        const open = box.classList.toggle('hidden');
        if (!open) renderEventHistory();
      });
    }

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
    // 注意：这里**不能**用配置里的 `inv.locked` 决定置灰 —— 那只是「这一类需要条件」
    // 的初始标记，真正的可用性由 Core.investmentAvailable 判定（功法算力投入要习得功法、
    // 工业产能要成立公司），而且会在游戏过程中变化。锁定文案也要跟着变：
    // 早先写死成「未习得功法」，工业产能未成立公司时也显示「未习得功法」，
    // 玩家会以为自己做错了什么。两者都在 renderInvestPage 里逐帧校正。
    $('inv-list').innerHTML = GAME.investments.map((inv) => {
      return '<div class="inv-item" data-inv="' + inv.id + '">' +
        '<div class="inv-top">' +
          '<span class="inv-name">' + esc(inv.name) +
            '<span class="inv-lock-tag" data-role="locktag" hidden></span></span>' +
          '<span class="inv-pct" data-role="pct">0%</span>' +
        '</div>' +
        '<div class="inv-desc">' + esc(inv.desc) + '　<span style="color:var(--text-faint)">' +
          esc(inv.period) + '</span></div>' +
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

    $('inv-list').addEventListener('input', (e) => {
      const range = e.target.closest('[data-role="range"]');
      if (!range || range.disabled) return;
      const item = range.closest('[data-inv]');
      if (item) onAllocDrag(item.dataset.inv, parseInt(range.value, 10));
    });

    // ---- 功法阁列表 ----
    // v3.4：列表只显示**已拥有**的功法，且随习得动态重建（见 renderTechniquePage）。
    // 静态阶段不写内容 —— boot 时 state 已有，但之后每学会一本都要补行，
    // 与其两头维护，不如把构建收敛到一个函数、按签名缓存。
    $('tech-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-tech]');
      if (!item || item.classList.contains('locked')) return;
      selectTechnique(item.dataset.tech);
    });

    // ---- 已得 / 图鉴 视图切换 ----
    const ownBtn = $('btn-tech-owned');
    const codexBtn = $('btn-tech-codex');
    if (ownBtn && codexBtn) {
      const setView = (v) => {
        techView = v;
        techListSig = '';          // 强制下一帧重建
        ownBtn.classList.toggle('ghost', v === 'codex');
        codexBtn.classList.toggle('ghost', v === 'owned');
        $('tech-list').classList.toggle('hidden', v === 'codex');
        $('tech-codex').classList.toggle('hidden', v !== 'codex');
        renderAll();
      };
      ownBtn.addEventListener('click', () => setView('owned'));
      codexBtn.addEventListener('click', () => setView('codex'));
    }

    // ---- 功法图鉴：全部功法按稀有度分组，缺哪本、条件是什么一眼看全 ----
    $('tech-codex').innerHTML = GAME.techniques.rarities.map((r) => {
      const rows = GAME.techniques.list.filter((t) => t.rarity === r.id);
      if (!rows.length) return '';
      return '<div class="codex-group">' +
        '<div class="codex-group-head">' +
          '<span class="tech-rarity" data-rarity="' + esc(r.id) + '">' + esc(r.name) + '</span>' +
          '<span class="codex-group-meta">主属性基值 ×' + r.mainQiSpeed + ' · 共 ' +
            rows.length + ' 本</span>' +
        '</div>' +
        rows.map((t) => {
          const pl = Object.keys(t.passive || {}).map((k) =>
            esc(PASSIVE_LABEL[k] || k) + ' ' + fmtSignedPct(t.passive[k])).join('　');
          // 解锁条件是配置派生的静态文案，直接嵌进 HTML —— 图鉴一切就有内容，
          // owned 态由 CSS（.codex-item.owned .codex-cond）隐藏。
          let cond;
          if (t.cond) {
            cond = '解锁：' + esc(Core.techCondText(t) || '未知条件');
          } else if (t.realm || t.compute) {
            const parts = [];
            if (t.realm) parts.push('境界 · ' + esc(realmNameOf(t.realm)));
            if (t.compute) parts.push('算力 ≥ ' + esc(Core.fmtBig(t.compute)));
            cond = '解锁：' + parts.join('　+　');
          } else {
            cond = '解锁：拥有第一台个人电脑';   // 九章算经（firstUnlock）
          }
          return '<div class="codex-item" data-codex="' + t.id + '">' +
            '<div class="tech-item-main">' +
              '<div class="tech-item-title">' + esc(t.name) +
                '<span class="tech-item-school">' + esc(t.school) + '</span></div>' +
              '<div class="tech-item-desc">' + esc(t.desc) + '</div>' +
              '<div class="codex-cond" data-role="ccond">' + cond + '</div>' +
              '<div class="codex-passive">' + (pl || '<span class="off">无被动</span>') + '</div>' +
            '</div>' +
            '<div class="codex-state" data-role="cstate"></div>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');

    // ---- 公司：生产线（每条线买下后，每一台都能单独选产物、调产能）----
    buildCompanyLineGroups();

    $('co-line-list').addEventListener('click', (e) => {
      // v3.6：点击行业组头折叠 / 展开该组生产线
      const lhead = e.target.closest('[data-role="lgrouphead"]');
      if (lhead) {
        const grp = lhead.closest('.co-line-group');
        const gid = grp ? grp.dataset.industry : null;
        if (gid) {
          if (lineFolded.has(gid)) lineFolded.delete(gid); else lineFolded.add(gid);
          grp.classList.toggle('folded', lineFolded.has(gid));
          const f = grp.querySelector('.mk-fold');
          if (f) f.textContent = lineFolded.has(gid) ? '▸' : '▾';
        }
        return;
      }
    });

    /**
     * v3.6：生产线按行业分组骨架（折叠 + fusion kind）。
     * 行内容（lstats / lunits / lprice）仍由 renderCompanyPage 逐帧回填。
     */
    function buildCompanyLineGroups() {
      $('co-line-list').innerHTML = GAME.company.industries.map((ind) => {
        const ls = GAME.company.lines.filter((l) => l.industry === ind.id);
        if (!ls.length) return '';
        const kind = ind.kind === 'xiuxian' ? 'xiuxian' : (ind.kind === 'fusion' ? 'fusion' : 'tech');
        if (kind === 'fusion' && !lineFoldInit.has(ind.id)) { lineFoldInit.add(ind.id); lineFolded.add(ind.id); }
        const rows = ls.map((l) => {
          return '<div class="co-line ' + kind + '" data-line="' + l.id + '">' +
            '<div class="co-line-icon">' + esc(indIcon(l.industry)) + '</div>' +
            '<div class="co-line-main">' +
              '<div class="co-line-title">' + esc(l.name) +
                '<span class="co-line-tag ' + kind + '">' + esc(indName(l.industry)) + '</span>' +
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
        return '<div class="co-line-group ' + (lineFolded.has(ind.id) ? 'folded' : '') + '" data-industry="' + ind.id + '">' +
          '<div class="mk-group-head" data-role="lgrouphead" title="点击折叠 / 展开该行业生产线">' +
            '<span class="mk-fold">' + (lineFolded.has(ind.id) ? '▸' : '▾') + '</span>' +
            '<span class="mk-group-icon">' + esc(indIcon(ind.id)) + '</span>' +
            '<span class="mk-group-name">' + esc(ind.name) + '</span>' +
            '<span class="mk-group-tag">' + (kind === 'fusion' ? '融合 · 元婴解锁' : (kind === 'xiuxian' ? '修仙 · 产业' : '科技 · 产业')) + '</span>' +
            '<span class="mk-group-idx">' + ls.length + ' 条线</span>' +
          '</div>' +
          '<div class="mk-group-body">' + rows + '</div>' +
        '</div>';
      }).join('');
    }

    function lineBuyQty() {
      const el = document.getElementById('line-buy-qty');
      const v = el ? Math.floor(Number(el.value) || 1) : 1;
      return Math.max(1, Math.min(100, v));
    }

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

    /** v3.6：市场分组骨架（fusion kind + 折叠箭头），折叠态变化时整体重建 */
    function buildMarketGroups() {
      $('mk-good-list').innerHTML = GAME.company.industries.map((ind) => {
        const goods = GAME.company.goods.filter((g) => g.industry === ind.id);
        if (!goods.length) return '';
        const kind = ind.kind === 'xiuxian' ? 'xiuxian' : (ind.kind === 'fusion' ? 'fusion' : 'tech');
        const ups = (ind.upstream || []).map((u) => indName(u)).join(' + ');
        // 融合行业默认折叠（48 个组全展开页面太长），点击组头切换
        if (kind === 'fusion' && !mktFoldInit.has(ind.id)) { mktFoldInit.add(ind.id); mktFolded.add(ind.id); }
        return '<div class="mk-group ' + kind + (mktFolded.has(ind.id) ? ' folded' : '') + '" data-industry="' + ind.id + '">' +
          '<div class="mk-group-head" data-role="ghead" title="点击折叠 / 展开该行业产品">' +
            '<span class="mk-fold">' + (mktFolded.has(ind.id) ? '▸' : '▾') + '</span>' +
            '<span class="mk-group-icon">' + esc(indIcon(ind.id)) + '</span>' +
            '<span class="mk-group-name">' + esc(ind.name) + '</span>' +
            '<span class="mk-group-tag">' + (kind === 'fusion' ? '融合 · ' : '') + (ups ? ('上游 · ' + esc(ups)) : '最上游 · 无原料依赖') + '</span>' +
            '<span class="mk-group-idx" data-role="gidx"></span>' +
          '</div>' +
          '<div class="mk-group-body">' + goods.map((g) => goodRowHTML(g, kind)).join('') + '</div>' +
        '</div>';
      }).join('');
    }

    // ---- 市场：商品行情按行业分组 ----
    buildMarketGroups();

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
        if (state) commitQuickAlloc(id, Number(range.value));
      });
    });

    $('mk-good-list').addEventListener('click', (e) => {
      // v3.6：点击组头折叠 / 展开该行业
      const ghead = e.target.closest('[data-role="ghead"]');
      if (ghead) {
        const grp = ghead.closest('.mk-group');
        const gid = grp ? grp.dataset.industry : null;
        if (gid) {
          if (mktFolded.has(gid)) mktFolded.delete(gid); else mktFolded.add(gid);
          grp.classList.toggle('folded', mktFolded.has(gid));
          const f = grp.querySelector('.mk-fold');
          if (f) f.textContent = mktFolded.has(gid) ? '▸' : '▾';
        }
        return;
      }
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
      const kind = ind.kind === 'xiuxian' ? 'xiuxian' : (ind.kind === 'fusion' ? 'fusion' : 'tech');
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
        const kind = st.kind === 'xiuxian' ? 'xiuxian' : (st.kind === 'fusion' ? 'fusion' : 'tech');
        return '<div class="st-row' + (linked ? ' linked' : '') + ' ' + kind + '" data-stock="' + st.id + '">' +
          '<div class="st-icon">' + esc((st.name || '股').slice(0, 2)) + '</div>' +
          '<div class="st-main">' +
            '<div class="st-title">' + esc(st.name) +
              '<span class="st-code">' + esc(st.code) + '</span>' +
              '<span class="co-line-tag ' + kind + '">' + (kind === 'xiuxian' ? '修仙宗门' : (kind === 'fusion' ? '融合赛道' : '科技')) + '</span>' +
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

  /** v3.6：快捷算力投向模块（境界页=修仙 / 设备页=AI），改动按比例让位其余方向 */
  function renderQuickAlloc() {
    const bars = document.querySelectorAll('[data-qa]');
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const id = bar.dataset.qa;
      const inv = GAME.investments.find((x) => x.id === id);
      if (!inv) continue;
      const available = Core.investmentAvailable(state, inv);
      const range = bar.querySelector('[data-role="qarange"]');
      const pctEl = bar.querySelector('[data-role="qapct"]');
      const v = Math.round((state.alloc[id] || 0) * 100);
      if (pctEl) pctEl.textContent = available ? (v + '%') : '锁定';
      if (range) {
        range.disabled = !available;
        if (document.activeElement !== range && Number(range.value) !== v) range.value = String(v);
      }
    }
  }

  function commitQuickAlloc(id, pct) {
    const r = Core.setAllocationShare(state, id, pct / 100);
    if (!r.ok) {
      toast(r.msg || '调整失败', 'err');
      renderQuickAlloc();
      return;
    }
    dirty = true;
    renderAll();
    syncNow();
  }

  function renderAll() {
    if (!state) return;
    renderTop();
    renderTiers();
    renderRealmPage();
    renderTribulationPage();
    renderWorkPage();
    renderTechPage();
    renderQuickAlloc();
    renderInvestPage();
    renderCompanyPage();
    // 市场页与股市页平时不参与每帧重绘：商品 72 种、股票 50 家，
    // 每行还带一张迷你走势图，后台页没必要每 100ms 全画一遍。
    // 但**首次渲染必须铺满** —— 否则切过去之前这两页是空的（测试与首屏都依赖它）。
    if (currentTab === 'market' || !firstRenderDone) renderMarketPage();
    if (currentTab === 'stock' || !firstRenderDone) renderStockPage();
    renderTechniquePage();
    renderRebirthPage();
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

    // 神识对算力的加成显示「实际乘区」而不是「总量 × 固定系数」——
    // 后者在后期会明显偏大（分层阻尼后神识总量与实际乘区已经不是一个口径）
    const shBonusPct = (Core.shenshiComputeMultiplier(state) - 1) * 100;
    setText('ui-shenshi-sub', '算力 +' + shBonusPct.toFixed(1) + '%');

    setText('ui-realm-top',  info.name);
    setText('ui-realm-prog', target.need ? pct(state.realmProgress) : '圆满');

    // 游戏内时钟 + 时间流速四键状态
    setText('ui-clock', Core.fmtGameDate(state.gameSeconds));
    setText('ui-clock-tier', state.timePaused ? '已暂停' : Core.tierInfo(state.timeTier).label);
    renderClockControls();
  }

  /** 时间流速说明（境界页）—— 四键已搬到顶栏，这里只留当前档位与解锁提示 */
  function renderTiers() {
    setText('ui-tier-current',
      (state.timePaused ? '已暂停' : Core.tierInfo(state.timeTier).label));
    const maxT = Core.maxUnlockedTier(state);
    const nextLocked = GAME.time.tiers.find((x) => x.tier === maxT + 1);
    setText('ui-tier-hint', nextLocked
      ? ('下一档：' + nextLocked.label + '（' + realmNameOf(nextLocked.unlockRealm) + '解锁）')
      : '已解锁全部档位');
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
    // 精力一律按整数显示：上限带功法被动 / 渡劫淬体的百分比乘区，会出现 660.0000001
    // 这类浮点尾巴，显示成小数只会让人困惑。计算照旧用全精度，只在显示层取整。
    const maxE = Math.round(Core.maxEnergy(state));
    const regen = Core.energyRegen(state);

    // ---- 精力 ----
    const eRatio = maxE > 0 ? Math.max(0, Math.min(1, state.energy / maxE)) : 0;
    const fill = $('ui-energy-bar');
    fill.style.width = (eRatio * 100).toFixed(1) + '%';
    fill.classList.toggle('low', eRatio <= GAME.energy.lowRatio);
    $('ui-energy-val').textContent = Math.floor(state.energy) + ' / ' + maxE;
    const regenTxt = regen % 1 === 0 ? String(regen) : regen.toFixed(1);
    $('ui-energy-rate').textContent = '+' + regenTxt + ' / 秒';

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
      const costFactor = Core.hardwareCostFactor(state, dev);
      if (costFactor < 0.999) {
        discEl.classList.remove('hidden');
        discEl.textContent = '折 ' + ((1 - costFactor) * 100).toFixed(0) + '%';
      } else {
        discEl.classList.add('hidden');
      }

      const buyBtn = el.querySelector('[data-role="buy"]');
      buyBtn.disabled = !can;
      el.classList.toggle('locked', owned === 0 && !can);
    }
  }

  /**
   * 投向的显示口径。
   *
   * 每个方向的产出量纲都不一样，必须**换成本方向的单位**再显示：
   * 直接显示 investOutput（中间量）会让玩家以为「修仙方向每秒只给几十点灵气」，
   * 而实际入账还要乘灵气倍率（功法主属性 × 神识 × 功法投向），能差一两个数量级。
   */
  function investDisplay(inv) {
    const unit = inv.unit || '';
    const rate = Core.investOutputRate(state, inv);
    if (unit === 'qi') {
      // 灵气是硬门槛：没有功法就没有灵气。这时显示「需先习得功法」比显示 0 更有用。
      if (!Core.spiritAllowed(state)) return { label: '灵气 / 秒', text: '需先习得功法' };
      return { label: '灵气 / 秒', text: fmt(new D(rate)) };
    }
    if (unit === 'compute') return { label: '算力 / 秒', text: '+' + fmt(new D(rate)) };
    if (unit === 'money') return { label: '金钱 / 秒', text: '+' + fmt(new D(rate)) };
    if (unit === 'discount') {
      // v3.5：累积制 —— 显示「累积值 + 每秒增长」，折扣本身按设备逐台算（设备页「折 X%」）
      const X = Core.investedHardwareOf(state);
      return { label: '议价累积', text: fmt(X) + '（+' + fmt(new D(rate)) + ' / 秒）' };
    }
    if (unit === 'techexp') {
      // 功法算力投入 → 经验/秒，只喂当前修炼的那本
      const cur = Core.currentTech(state);
      return cur
        ? { label: '功法经验 / 秒', text: '+' + rate.toFixed(2) + ' → ' + cur.name }
        : { label: '功法经验 / 秒', text: '0' };
    }
    return { label: '产出', text: fmt(new D(rate)) };
  }

  /** 这些投向的「产出」不是每秒资源，累计值没有意义，不显示 */
  const INVEST_NO_TOTAL = { industrial: 1 };

  function renderInvestPage() {
    let allocSum = 0;

    for (const inv of GAME.investments) {
      const el = document.querySelector('[data-inv="' + inv.id + '"]');
      if (!el) continue;

      const available = Core.investmentAvailable(state, inv);
      el.classList.toggle('disabled', !available);

      // 锁定标签：文案由核心层给出（功法算力投入 = 未习得功法 / 工业产能 = 未成立公司），
      // 条件满足后就地消失 —— 不能只在首次渲染时写死。
      const tag = el.querySelector('[data-role="locktag"]');
      if (tag) {
        const reason = Core.investmentLockReason(state, inv);
        tag.textContent = reason;
        tag.hidden = !reason;
      }

      const a = state.alloc[inv.id] || 0;
      if (available) allocSum += a;

      const range = el.querySelector('[data-role="range"]');
      range.disabled = !available;
      if (document.activeElement !== range) {
        range.value = Math.round(a * 100);
      }

      el.querySelector('[data-role="pct"]').textContent = available
        ? Math.round(a * 100) + '%' : '锁定';

      const disp = investDisplay(inv);
      el.querySelector('[data-role="outlabel"]').textContent = disp.label;
      el.querySelector('[data-role="out"]').textContent = disp.text;

      const totalEl = el.querySelector('[data-role="total"]');
      if (INVEST_NO_TOTAL[inv.unit]) {
        totalEl.textContent = '';
      } else {
        totalEl.textContent = '累计 ' + fmt(state.produced[inv.id]);
      }
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
    // v3.6：折叠/展开变化时重建分组骨架（数值仍逐帧回填）
    const lFoldSig = Array.from(lineFolded).sort().join(',');
    if (lFoldSig !== lineFoldSig) {
      lineFoldSig = lFoldSig;
      buildCompanyLineGroups();
    }
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
    // id -> 商品配置。72 件商品逐行 find 是 O(n²)，每帧白扫五千多次 —— 用 Map 一次到位
    const goodByIdMap = Object.create(null);
    for (const g of GAME.company.goods) goodByIdMap[g.id] = g;

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

    // v3.6：折叠状态变化时重建分组骨架（数值仍逐帧刷新）
    const foldSig = Array.from(mktFolded).sort().join(',');
    if (foldSig !== mktFoldSig) {
      mktFoldSig = foldSig;
      buildMarketGroups();
    }
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
        const good = goodByIdMap[el.dataset.good];
        if (!good) continue;

        // 价格一律用带抛压的版本 —— 界面上看到的钱必须就是卖出能拿到的钱
        const price = Core.goodsPriceWith(state, good);
        const trend = Core.goodsTrend(good, state.playTime);
        const pressure = Core.pressureOf(state, good.id);
        const drop = Core.marketDropRatio(state, good);
        if (pressure > peakPressure) peakPressure = pressure;
        if (pressure > 0) pressuredGoods += 1;

        const stock = Core.stockOf(state, good.id);
        const value = price.mul(stock);
        stockValue = stockValue.add(value);

        const period = Core.goodsPeriod(good, state.playTime);

        setT(el.querySelector('[data-role="gprice"]'), 'textContent', fmt(price));

        // 涨红跌绿（中国习惯）
        const tEl = el.querySelector('[data-role="gtrend"]');
        const arrow = trend === 'up' ? '▲ 涨' : (trend === 'down' ? '▼ 跌' : '— 平');
        setT(tEl, 'className', 'trend ' + trend);
        setT(tEl, 'textContent', arrow + '　基准 ' + fmt(new D(good.basePrice)));

        setT(el.querySelector('[data-role="gmeta"]'), 'innerHTML',
          '距下次变价 ' + esc(fmtRealDuration(Core.goodsNextChangeIn(good, state.playTime))) +
          '　累计卖出 ' + fmtCount(state.company.goodsSold[good.id] || 0) + ' 件');

        // ---------- 抛压条 ----------
        const pressEl = el.querySelector('[data-role="gpress"]');
        if (pressEl) {
          pressEl.classList.toggle('hidden', pressure <= 0);
          const barEl = el.querySelector('[data-role="gpressbar"]');
          if (barEl) {
            const w = Math.round(pressure * 100) + '%';
            if (barEl.style.width !== w) barEl.style.width = w;
          }
          const txtEl = el.querySelector('[data-role="gpresstxt"]');
          if (txtEl) {
            setT(txtEl, 'innerHTML', '已被压 −' + esc((drop * 100).toFixed(1)) + '%' +
              '<span class="faint">　本应 ' + esc(fmt(Core.naturalPrice(good, state.playTime, state))) +
              '　卖出后下一期起跳</span>');
          }
          pressEl.classList.toggle('warn', pressure >= ((GAME.company.market || {}).warnAt || 0.45));
        }

        el.classList.toggle('selected', good.id === chartGood);

        // 行内迷你走势：只看已发生的期，不推演。
        // 72 件商品各一张 SVG，期内静止 —— 按 (商品, 期, 有无抛压) 缓存，
        // 没换期就不重建字符串、不让浏览器重新解析。
        const sparkEl = el.querySelector('[data-role="gspark"]');
        if (sparkEl) {
          const sKey = good.id + ':' + period + ':' + (pressure > 0 ? 1 : 0);
          let svg = stockSparkCache.get(sKey);
          if (svg === undefined) {
            svg = priceChartSVG(good, state.playTime, trend, 8, 0, 34);
            if (stockSparkCache.size > 300) stockSparkCache.clear();
            stockSparkCache.set(sKey, svg);
          }
          if (sparkEl.innerHTML !== svg) sparkEl.innerHTML = svg;
        }

        const nEl = el.querySelector('[data-role="gstock"]');
        setT(nEl, 'textContent', fmtCount(stock) + ' 件');
        nEl.classList.toggle('zero', stock === 0);
        setT(el.querySelector('[data-role="gvalue"]'), 'textContent', '市值 ' + fmt(value));

        const gs = el.querySelector('[data-role="gsell"]');
        const gsd = !founded || stock <= 0;
        if (gs.disabled !== gsd) gs.disabled = gsd;
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
        const gp = (k) => fmtPeriod(((GAME.company.goods.find((x) => x.kind === k) || {}).periodSeconds) || 60);
        mktHint.textContent = '科技类每 ' + gp('tech') + '变价 · 修仙类每 ' + gp('xiuxian') + '变价　·　无抛压';
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
      const cTrend = Core.goodsTrend(cg, state.playTime);
      const cPeriod = Core.goodsPeriod(cg, state.playTime);
      const perSec = cg.periodSeconds || 60;

      chartBody.innerHTML = priceChartSVG(cg, state.playTime, cTrend, span, 8, 118);
      setText('ui-mk-chart-name', cg.name);
      setText('ui-mk-chart-tag',
        esc(indName(cg.industry)) + ' · 每 ' + fmtPeriod(perSec) + '变价');

      const cPrice = Core.goodsPriceWith(state, cg);
      const cNatural = Core.naturalPrice(cg, state.playTime, state);
      const cDrop = Core.marketDropRatio(state, cg);
      const cCost = Core.industryCostIndex(state, cg.industry);
      setText('ui-mk-chart-foot',
        '第 ' + Math.max(0, cPeriod - span) + ' ~ ' + (cPeriod + 8) +
        ' 期（当前第 ' + cPeriod + ' 期）　现价 ' + fmt(cPrice) +
        (cDrop > 0.0005 ? '（自然价 ' + fmt(cNatural) + '，被抛压压低 ' + (cDrop * 100).toFixed(1) + '%）' : '') +
        '　基准 ' + fmt(new D(cg.basePrice)) +
        '　' + indName(cg.industry) + '成本 ×' + cCost.toFixed(2) +
        '　距下次变价 ' + fmtRealDuration(Core.goodsNextChangeIn(cg, state.playTime)));
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
      const prog = len > 0 ? ((state.playTime % len) / len) : 0;
      $('ui-st-periodbar').style.width = (prog * 100).toFixed(1) + '%';
      $('ui-st-period-label').textContent =
        '距离下次变价 ' + fmtRealDuration(Core.stockNextChangeIn(st, state.playTime));
      $('ui-st-period').textContent = '第 ' + sel.period + ' 期 · 每期 ' + fmtPeriod(len);
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

    // id -> 行对象。别用 Array.find：50 行 × 50 家的 O(n²) 每帧白扫两千多次。
    const rowById = Object.create(null);
    for (const x of sum.stocks) rowById[x.id] = x;

    const rows = $('st-list').querySelectorAll('.st-row');
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i];
      const row = rowById[el.dataset.stock];
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
      setT(tEl, 'className', 'trend ' + trend);
      setT(tEl, 'textContent', (trend === 'up' ? '▲ 涨' : (trend === 'down' ? '▼ 跌' : '— 平')) +
        '　基准 ' + fmt(new D(row.basePrice)));

      setT(el.querySelector('[data-role="stprice"]'), 'textContent', fmt(row.price));

      setT(el.querySelector('[data-role="stmeta"]'), 'innerHTML',
        '距变价 ' + esc(fmtRealDuration(row.nextChangeIn)) +
        '　流通盘 ' + fmtCount(row.depth) + ' 股' +
        (rank > 0 ? '　市值 ' + esc(fmt(row.marketCap)) + ' · 第 ' + rank + ' 名' : '') +
        '　持仓占比 ' + esc(pct(row.heldRatio)) +
        '　净买入流 ' + (row.flow > 0 ? '+' : '') + fmtCount(row.flow) + ' 股');

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
          const w = Math.round(Math.min(1, Math.abs(pctv) / full) * 100) + '%';
          if (barEl.style.width !== w) barEl.style.width = w;
        }
        const txtEl = el.querySelector('[data-role="stimptxt"]');
        if (txtEl) {
          setT(txtEl, 'innerHTML', (pctv >= 0 ? '买盘推高 +' : '卖盘压低 −') +
            esc((Math.abs(pctv) * 100).toFixed(2)) + '%' +
            '<span class="faint">　自然价 ' + esc(fmt(row.naturalPrice)) +
            '　逐期衰减回去</span>');
        }
      }

      // ---------- 持仓 ----------
      const sEl = el.querySelector('[data-role="stshares"]');
      setT(sEl, 'textContent', fmtCount(row.shares) + ' 股');
      sEl.classList.toggle('zero', row.shares <= 0);
      setT(el.querySelector('[data-role="stvalue"]'), 'textContent', row.shares > 0
        ? ('市值 ' + fmt(row.value)) : '未持仓');

      const pEl = el.querySelector('[data-role="stpnl"]');
      if (row.shares > 0) {
        setT(pEl, 'className', 'pnl ' + (row.liquidatePnl.isNeg() ? 'down' : 'up'));
        setT(pEl, 'textContent', '可变现 ' + fmt(row.liquidateValue) + '　' +
          (row.liquidatePnl.isNeg() ? '' : '+') + fmt(row.liquidatePnl) +
          '（' + fmtSignedPct(row.liquidatePnlRatio) + '）');
      } else {
        setT(pEl, 'className', 'pnl');
        setT(pEl, 'textContent', '');
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

      // 买卖报价的输入只有「期数 / 净买入流 / 持仓 / 手数 / 最小成交额」。
      // 报价要走行业传导链（不便宜），而这几项在绝大多数帧里根本不变 ——
      // 按 key 缓存，行情没动就一帧都不用重算。（金钱只影响「够不够买」的判断，
      // 那是后面一次比较，不进缓存键。）
      const qKey = row.period + '|' + row.flow + '|' + row.shares + '|' + qty +
        '|' + row.impactPct + '|' + sum.minOrder;
      let qc = stockQuoteCache[row.id];
      if (!qc || qc.key !== qKey) {
        qc = {
          key: qKey,
          buy: Core.stockBuyQuote(state, st, qty),
          sell: row.shares > 0
            ? Core.stockSellQuote(state, st, Math.min(qty, row.shares)) : null,
        };
        stockQuoteCache[row.id] = qc;
      }
      const bq = qc.buy;
      const costEl = el.querySelector('[data-role="stcost"]');
      let buyOk = false;
      if (qty <= 0) {
        setT(costEl, 'className', 'st-trade-cost');
        setT(costEl, 'textContent', '输入股数');
      } else if (!bq.ok) {
        setT(costEl, 'className', 'st-trade-cost no');
        setT(costEl, 'textContent', bq.msg);
      } else if (bq.tooSmall) {
        setT(costEl, 'className', 'st-trade-cost no');
        setT(costEl, 'textContent', '买额需 ≥ ' + fmt(new D(sum.minOrder)));
      } else if (bq.total.gt(state.money)) {
        setT(costEl, 'className', 'st-trade-cost no');
        setT(costEl, 'textContent', '买需 ' + fmt(bq.total) + ' · 金钱不足');
      } else {
        setT(costEl, 'className', 'st-trade-cost');
        setT(costEl, 'textContent', '买需 ' + fmt(bq.total) + ' · 均价 ' + fmt(bq.unitPrice));
        buyOk = true;
      }

      // 卖出预览（数量超过持仓时按持仓算，与内核的 clamp 一致）
      const sellable = Math.min(qty, row.shares);
      const sq = qc.sell;
      const netEl = el.querySelector('[data-role="stnet"]');
      let sellOk = false;
      if (row.shares <= 0) {
        setT(netEl, 'className', 'st-trade-cost');
        setT(netEl, 'textContent', '未持仓');
      } else if (qty <= 0) {
        setT(netEl, 'className', 'st-trade-cost');
        setT(netEl, 'textContent', '输入股数');
      } else if (!sq || !sq.ok) {
        setT(netEl, 'className', 'st-trade-cost no');
        setT(netEl, 'textContent', (sq && sq.msg) || '无法卖出');
      } else if (sq.tooSmall) {
        setT(netEl, 'className', 'st-trade-cost no');
        setT(netEl, 'textContent', '卖额需 ≥ ' + fmt(new D(sum.minOrder)));
      } else {
        setT(netEl, 'className', 'st-trade-cost');
        setT(netEl, 'textContent', '卖得 ' + fmt(sq.net) +
          (sellable < qty ? '（按 ' + fmtCount(sellable) + ' 股）' : '') +
          ' · 均价 ' + fmt(sq.unitPrice));
        sellOk = true;
      }

      // v3.6：未解锁个股（融合赛道 50 家 = 元婴解锁）禁交易并标注原因
      if (!row.unlocked) {
        const reason = Core.stockAccessReason(state, st) || '元婴解锁';
        setT(costEl, 'className', 'st-trade-cost no');
        setT(costEl, 'textContent', '🔒 ' + reason);
        setT(netEl, 'className', 'st-trade-cost');
        setT(netEl, 'textContent', '');
        buyOk = false; sellOk = false;
      }

      const bb = el.querySelector('[data-role="stbuy"]');
      if (bb.disabled !== !buyOk) bb.disabled = !buyOk;
      const bs = el.querySelector('[data-role="stsell"]');
      if (bs.disabled !== !sellOk) bs.disabled = !sellOk;
      const bc = el.querySelector('[data-role="stclose"]');
      if (bc.disabled !== (row.shares <= 0)) bc.disabled = row.shares <= 0;
      const bm = el.querySelector('[data-role="stmax"]');
      if (bm.disabled !== (row.maxBuy <= 0)) bm.disabled = row.maxBuy <= 0;

      // 行内迷你走势：只看已发生的期，不推演。
      // 走势在「期」内是静止的（价格按期变），所以按 (股票, 期数, 有无冲击) 缓存 ——
      // 没换期就完全不用重建 SVG 字符串，更不用让浏览器重新解析 50 段 SVG。
      const sparkEl = el.querySelector('[data-role="stspark"]');
      if (sparkEl) {
        const sKey = row.id + ':' + row.period + ':' + (row.flow !== 0 ? 1 : 0);
        let svg = stockSparkCache.get(sKey);
        if (svg === undefined) {
          svg = stockChartSVG(st, state.playTime, trend, 8, 0, 34);
          if (stockSparkCache.size > 300) stockSparkCache.clear();
          stockSparkCache.set(sKey, svg);
        }
        if (sparkEl.innerHTML !== svg) sparkEl.innerHTML = svg;
      }
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
      // 大图与迷你图同一条缓存思路：期内静止，按 (股票, 期, 净买入流, 持仓) 缓存。
      // 这张图有 20 个期点 + 自然价虚线，是整页最贵的一段 SVG，不缓存会每帧重建。
      const cKey = sel.id + ':' + sel.period + ':' + sel.flow + ':' + sel.shares;
      let csvg = stockSparkCache.get(cKey);
      if (csvg === undefined) {
        csvg = stockChartSVG(st, state.playTime, sel.trend, 12, 8, 118);
        if (stockSparkCache.size > 300) stockSparkCache.clear();
        stockSparkCache.set(cKey, csvg);
      }
      if (chartBody.innerHTML !== csvg) chartBody.innerHTML = csvg;

      setText('ui-st-chart-name', sel.name + '　' + sel.code);
      const good = sel.link ? Core.goodById(sel.link) : null;
      setText('ui-st-chart-tag',
        (good ? '联动 · ' + good.name : '独立行情') + ' · 每 ' + fmtPeriod(sel.periodSeconds) + '变价');

      let foot = '第 ' + Math.max(0, sel.period - 12) + ' ~ ' + (sel.period + 8) +
        ' 期（当前第 ' + sel.period + ' 期）　成交价 ' + fmt(sel.price) +
        '　自然价 ' + fmt(sel.naturalPrice) +
        '　基准 ' + fmt(new D(sel.basePrice)) +
        '　距变价 ' + fmtRealDuration(sel.nextChangeIn);
      if (Math.abs(sel.impactPct) > 1e-6) {
        foot += '　' + (sel.impactPct > 0 ? '你的买盘把成交价推高 ' : '你的卖盘把成交价压低 ') +
          (Math.abs(sel.impactPct) * 100).toFixed(2) + '%（会逐期衰减回去）';
      }
      setText('ui-st-chart-foot', foot);
    }
  }

  // ============================================================
  // 渡劫
  // ============================================================

  /** 境界名（核心层没有导出 realmName，这里直接从配置取，避免再造一份表） */
  function realmNameOf(idx) {
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
  function renderTribulationPage() {
    const cfg = GAME.tribulation;
    if (!cfg || !cfg.implemented) return;
    const s = Core.tribulationSummary(state);
    if (!s) return;

    const maxLv = s.maxLevel || 40;
    setText('ui-tb-level', String(s.level));
    setText('ui-tb-max', ' / ' + maxLv + ' 层');
    setText('ui-tb-attempts', fmtCount(s.attempts));
    setText('ui-tb-failures', fmtCount(s.failures));

    const chk = $('chk-auto-tribulation');
    if (chk && document.activeElement !== chk) chk.checked = s.auto !== false;

    const atMax = s.atMax;
    const ready = s.ready;
    setText('ui-tb-rate', atMax ? '已至最高境界' : (s.odds.rate * 100).toFixed(1) + '%');
    setText('ui-tb-hint', atMax
      ? '已至元婴 —— 本作最高境界；再往前只能兵解重来'
      : (ready ? '灵气已满 —— 可以渡劫了' : '灵气满格之后，须渡劫方能升境'));

    const btn = $('btn-tribulation');
    if (btn) {
      btn.disabled = !ready;
      btn.textContent = atMax ? '无劫可渡'
        : (ready ? ('渡劫 → ' + realmNameOf(s.odds.nextRealm)) : '渡劫（灵气未满）');
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
        '<span class="k">' + esc(k) + '</span>' +
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
      '　累计道行 ' + fmtCount(o.daoTotal) +
    '</div>';
    if ($('ui-tb-odds').innerHTML !== html) $('ui-tb-odds').innerHTML = html;

    // ---------- 渡劫淬体加成 ----------
    const bl = s.boons.map((b) =>
      '<span class="tb-boon">' + esc(b.name) +
        ' <b>+' + (b.value * 100).toFixed(0) + '%</b>' +
        '<span class="dim">（每层 +' + (b.per * 100).toFixed(0) + '%）</span></span>'
    ).join('');
    if ($('ui-tb-boons').innerHTML !== bl) $('ui-tb-boons').innerHTML = bl;
  }

  // ============================================================
  // 兵解 · 转生
  // ============================================================

  /**
   * 下一次兵解之后的转生折扣。
   * 界面文案与确认弹窗共用，避免两处各算一遍导致数字不一致。
   */
  function nextRebirthFactor() {
    return Core.rebirthFactorAt(Core.rebirthCount(state) + 1);
  }

  /** 当前有效设备算力（已应用转生衰减）—— 用于把「压掉几个数量级」讲成人话 */
  function effectiveDeviceCompute() {
    return Core.deviceComputeEffective(state);
  }

  /**
   * 转生面板。
   *
   * 关键约定：这里**不自己算**道行、折扣、升级成本 —— 全部走 Core 的同名函数。
   * 界面、引擎、服务端共用同一份口径，否则会出现「界面说能拿 100，服务端只给 60」
   * 这类对不上账的问题（与市场价、股市报价同一条纪律）。
   */
  function renderRebirthPage() {
    const rbCfg = GAME.rebirth;
    if (!rbCfg || !rbCfg.implemented) return;

    const unlocked = Core.rebirthUnlocked(state);
    // 面板显示条件放宽：已兵解过就展开（兵解后境界会掉回凡人，
    // 若面板跟着锁上，玩家既看不到道行也花不掉它）。
    const visible = unlocked || Core.rebirthCount(state) > 0;
    $('rb-lock').classList.toggle('hidden', visible);
    $('rb-main').classList.toggle('hidden', !visible);

    if (!visible) {
      $('ui-rb-lock').textContent = Core.rebirthLockedReason(state) || '尚未达到兵解条件';
      $('ui-rb-hint').textContent = '元婴之后，才有资格谈重塑';
      return;
    }

    // 按钮：达不到门槛时禁用并说明原因（面板仍然展开，道行照花）
    const rbBtnEl = $('btn-rebirth');
    if (rbBtnEl) {
      rbBtnEl.disabled = !unlocked;
      rbBtnEl.textContent = unlocked ? '兵解转生' : (Core.rebirthLockedReason(state) || '尚不可兵解');
    }

    const st = Core.rebirthState(state);
    const count = Core.rebirthCount(state);
    const disc = Core.rebirthDiscount(state);
    const dao = Math.floor(st.dao || 0);
    const daoTotal = Math.floor(st.daoTotal || 0);
    const gain = Core.rebirthDaoGain(state, 'active');
    const gainPassive = Core.rebirthDaoGain(state, 'passive');

    const discTxt = disc >= 1 ? '原值' : '^' + disc.toFixed(2);
    setText('ui-rb-hint', '已兵解 ' + count + ' 次 · 设备算力衰减 ' + discTxt);
    setText('ui-rb-count', String(count));
    setText('ui-rb-dao', fmtCount(dao));
    setText('ui-rb-daototal', fmtCount(daoTotal));
    setText('ui-rb-disc', discTxt);
    setText('ui-rb-gain', String(gain));
    setText('ui-rb-gain-passive', String(gainPassive));

    const nextGain = Math.floor((rbCfg.daoBase || 100) * (1 + (rbCfg.daoPerRun || 0.6) * (count + 1)));
    setText('ui-rb-nextline',
      '本次兵解后：设备算力被压至 ^' + nextRebirthFactor().toFixed(2) +
      '，之后每次兵解可得 ' + nextGain + ' 道行以上');

    // ---- 道行加成 ----
    const dl = (rbCfg.perks || []).map((p) => {
      const lv = Core.perkLevel(state, p.id);
      const maxLv = p.maxLevel || 0;
      const maxed = lv >= maxLv;
      const cost = Core.perkCost(state, p.id);
      const cur = lv * (p.per || 0);
      const curTxt = p.unit === '%'
        ? '+' + (cur * 100).toFixed(0) + '%'
        : '+' + fmtNum(cur) + (p.unit || '');
      return '<div class="rb-perk' + (maxed ? ' maxed' : '') + '">' +
        '<div class="rb-perk-top">' +
          '<span class="rb-perk-name">' + esc(p.name) + '</span>' +
          '<span class="rb-perk-lv">Lv ' + lv + ' / ' + maxLv + '</span>' +
        '</div>' +
        '<div class="rb-perk-desc">' + esc(p.desc || '') + '</div>' +
        '<div class="rb-perk-now">' + (lv > 0 ? '当前 ' + curTxt : '尚未激活') + '</div>' +
        '<div class="rb-perk-bar"><i style="width:' +
          (maxLv ? Math.round(lv / maxLv * 100) : 0) + '%"></i></div>' +
        '<div class="rb-perk-foot">' +
          '<span class="rb-perk-cost">' +
            (maxed ? '已满级' : '升级需 ' + fmtCount(cost) + ' 道行') + '</span>' +
          '<button class="btn" data-perk="' + p.id + '"' +
            (maxed || dao < cost ? ' disabled' : '') + '>' + (maxed ? '满级' : '升级') + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
    if ($('rb-perk-list').innerHTML !== dl) $('rb-perk-list').innerHTML = dl;

    // ---- 兵解记录 ----
    const hist = (st.history || []).slice(-8).reverse();
    const hl = hist.map((h) =>
      '<div class="rb-hist">' +
        '<span class="n">#' + h.n + '</span>' +
        '<span class="r">' + esc(h.realmName || ('境界 ' + h.realm)) + '</span>' +
        (h.mode === 'passive' ? '<span class="mode">渡劫失败</span>' : '') +
        '<span class="d">+' + fmtCount(h.dao || 0) + ' 道行</span>' +
        '<span class="m">' + esc(Core.fmtGameDate(h.gameSeconds || 0)) + '</span>' +
      '</div>').join('');
    if ($('rb-history').innerHTML !== hl) {
      $('rb-history').innerHTML = hl || '<div class="dim" style="font-size:12px">尚未兵解过</div>';
    }
  }

  /**
   * 通用服务端操作（与 stockAction 走同一条 POST /api/action 通道）。
   * 兵解与「买加成」都不属于股市操作，所以这里单独起一个中性的名字，
   * 顺便避免以后有人误改 stockAction 时把兵解一起带坏。
   */
  async function rebirthAction(action, payload) {
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

  /** 打开兵解确认弹窗 —— 必须列清「失去 / 保留 / 获得」三栏，这是不可撤销的操作 */
  function openRebirthModal() {
    if (!state) return;
    if (!Core.rebirthUnlocked(state)) {
      toast(Core.rebirthLockedReason(state) || '尚未达到兵解条件', 'err');
      return;
    }
    const disc = Core.rebirthDiscount(state);
    const gain = Core.rebirthDaoGain(state, 'active');

    const lost = [
      '境界与灵气 —— 退回 <b>凡人</b>，灵气清零、境界进度清零',
      '金钱与灵石 —— 归零（回到起手 ' + fmtNum(GAME.base.startMoney) + ' 金钱）',
      '投向配置与累计产出 —— 回到「全修仙」，累计统计清零',
      '本世攒下的算力加成（AI 投向逐 tick 累出来的部分）',
      '公司 —— 注册状态、生产线、仓库、库存与全部经营统计一并清空',
      '股市 —— 持仓、成本与全部成交统计一并清空',
      '功法熟练度进度 —— 段位与已修满的常驻被动保留',
      '精力上限 —— 由 ' + fmtNum(Math.round(Core.maxEnergy(state))) + ' 回落',
      '时间流速 —— 回落到档 1（渡劫成功后会自动跟上）',
    ];
    const keep = [
      '功法 —— 本体、熟练度段位、已修满的常驻被动全保留（只清熟练度进度）',
      '工作履历 —— 已完成次数保留，升职链不用重跑',
      '设备 —— 全部保留，但算力被压至 <b>' + fmt(effectiveDeviceCompute()) +
        '</b>（衰减指数 ' + (disc >= 1 ? '^1.00 原值' : '^' + disc.toFixed(2)) + '）',
      '渡劫淬体 —— <b>' + Core.tribulationLevel(state) + ' 层</b>全项永久加成，跨兵解不丢',
      '道行与所有永久加成',
      '游戏内日期与行情时钟 —— 不会倒流',
    ];
    const gainList = [
      '<b>' + gain + '</b> 道行（可累积，用于购买永久加成）',
      '设备算力衰减下次放宽至 <b>^' + nextRebirthFactor().toFixed(2) + '</b>',
      '此后每一世都以更高的境界基础神识与灵气速度起步',
    ];

    $('rb-lost-list').innerHTML = lost.map((t) => '<li>' + t + '</li>').join('');
    $('rb-keep-list').innerHTML = keep.map((t) => '<li>' + t + '</li>').join('');
    $('rb-gain-list').innerHTML = gainList.map((t) => '<li>' + t + '</li>').join('');
    $('rebirth-modal').classList.remove('hidden');
  }

  function closeRebirthModal() {
    $('rebirth-modal').classList.add('hidden');
  }

  /** 执行兵解（服务端权威） */
  async function doRebirthNow() {
    closeRebirthModal();
    const r = await rebirthAction('rebirth', { mode: 'active' });
    if (!r) return;
    toast('兵解完成：第 ' + r.count + ' 世 · 获得 ' + fmtCount(r.dao) +
      ' 道行 · 设备算力衰减 ^' + r.discount.toFixed(2));
  }

  /** 用道行升一级加成（服务端权威） */
  async function buyRebirthPerk(id) {
    const r = await rebirthAction('buyPerk', { perkId: id });
    if (!r) return;
    toast('「' + r.name + '」升至 Lv' + r.level + '，消耗 ' + fmtCount(r.cost) + ' 道行');
  }

  /**
   * 刷新图鉴每一项的「已得 / 未得」与解锁条件文案。
   * 静态构建后调用一次（默认视图也填好，图鉴切过去就有内容），
   * 之后仅在已拥有集合变化时随 renderTechniquePage 再刷。
   */
  function refreshCodexStates(list) {
    const els = $('tech-codex').querySelectorAll('[data-codex]');
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
          ? '（' + (p.need >= 10000 ? Core.fmtBig(Math.min(p.cur, p.need)) : fmtCount(Math.min(p.cur, p.need))) +
            '/' + (p.need >= 10000 ? Core.fmtBig(p.need) : fmtCount(p.need)) + '）'
          : '';
        condEl.textContent = '解锁：' + (t.unlockText || '未知条件') + prog;
        stateEl.textContent = '未得';
        stateEl.className = 'codex-state not';
      }
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

      // 功法经验（v3.5）：独立等级，挂机 + 投向持续喂经验
      setText('ui-tech-exp-lv', 'Lv.' + (info ? info.level : 0));
      const expNeed = info ? info.expNeed : 0;
      const expProg = expNeed > 0 ? Math.max(0, Math.min(1, (rec.exp || 0) / expNeed)) : 0;
      const expBar = $('ui-tech-exp-bar');
      expBar.style.width = (expProg * 100).toFixed(1) + '%';
      setText('ui-tech-exp-val', Math.floor(rec.exp || 0) + ' / ' + fmtCount(Math.ceil(expNeed)));
      setText('ui-tech-exp-rate', '+' + (info ? info.expRate : 0).toFixed(2) + ' / 秒');

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

    // ---- 功法阁（只显示已拥有） / 图鉴 ----
    // 列表按「已拥有 id 签名」缓存：学会新功法才重建 DOM，其余帧只刷新数值。
    const ownedIds = list.filter((t) => t.learned).map((t) => t.id);
    const ownedSig = ownedIds.join(',');
    setText('ui-tech-count', ownedIds.length + ' / ' + list.length + ' 已得');

    if (techView === 'owned') {
      if (ownedSig !== techListSig) {
        techListSig = ownedSig;
        const R = GAME.techniques.rarities;
        $('tech-list').innerHTML = ownedIds.map((id) => {
          const t = GAME.techniques.list.find((x) => x.id === id);
          const r = R.find((x) => x.id === t.rarity) || {};
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
      }
      const items = $('tech-list').querySelectorAll('.tech-item');
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const t = list.find((x) => x.id === el.dataset.tech);
        if (!t) continue;

        el.classList.toggle('active', t.active);

        const statsEl = el.querySelector('[data-role="tstats"]');
        const pl = Object.keys(t.passive || {}).map((k) =>
          esc(PASSIVE_LABEL[k] || k) + ' ' + fmtSignedPct(t.passive[k])).join('　');
        statsEl.innerHTML =
          '<span class="jade">灵气吸收 +' + (t.mainQiSpeed * 100).toFixed(1) + '%</span>' +
          '<span>等级 ' + t.level + '</span>' +
          '<span>熟练度 ' + esc(t.masteryTierName) + '</span>' +
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
      refreshCodexStates(list);
    }

    // ---- 神识面板 ----
    const sh = Core.totalShenshi(state);
    $('ui-sh-total').textContent = fmtNum(sh);
    $('ui-sh-base').textContent = fmtNum(Core.shenshiBase(state));
    $('ui-sh-dev').textContent = '×' + fmtNum(Core.shenshiDeviceMultiplier(state));
    $('ui-sh-compute').textContent =
      '+' + ((Core.shenshiComputeMultiplier(state) - 1) * 100).toFixed(1) + '%';
    $('ui-sh-cultivate').textContent =
      '+' + ((Core.shenshiCultivateMultiplier(state) - 1) * 100).toFixed(1) + '%';

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

  // ============================================================
  // 时间流速四键（顶栏 · 游戏时间旁）
  // ============================================================
  //
  //   ◀    减速一档
  //   ▶    常速（1 秒 = 1 小时）→ 再点变 ⏸ 暂停
  //   ▶▶   加速一档
  //   ▶▶▶  直接跳到已解锁的最高档（化神后是 1 秒 = 1 游戏年）
  //
  // 刻意不用「缓 / 常 / 疾」这类字当按钮文案 —— 速度用形状表达（箭头数），
  // 具体倍率在旁边的 clock-tier 里看数字。

  /** 已解锁档位按 tier 升序 */
  function sortedTiers() {
    return GAME.time.tiers.slice().sort((a, b) => a.tier - b.tier);
  }

  async function tcSlower() {
    if (!state) return;
    const tiers = sortedTiers().filter((t) => Core.tierUnlocked(state, t.tier));
    const idx = tiers.findIndex((t) => t.tier === state.timeTier);
    if (idx <= 0) {
      toast('已经是最低速了', 'err');
      return;
    }
    if (state.timePaused) {
      state.timePaused = false;
      dirty = true;
    }
    await pickTier(tiers[idx - 1].tier);
  }

  async function tcFaster() {
    if (!state) return;
    if (state.timePaused) {
      state.timePaused = false;
      dirty = true;
      renderAll();
      syncNow();
      return;
    }
    const tiers = sortedTiers().filter((t) => Core.tierUnlocked(state, t.tier));
    const idx = tiers.findIndex((t) => t.tier === state.timeTier);
    const next = tiers[idx + 1];
    if (!next) {
      toast('已是当前境界的最高速', 'err');
      return;
    }
    await pickTier(next.tier);
  }

  async function tcPlayPause() {
    if (!state) return;
    if (state.timePaused) {
      // 恢复 → 回到常速
      state.timePaused = false;
      dirty = true;
      const normal = GAME.time.normalTier || 2;
      if (Core.tierUnlocked(state, normal)) {
        await pickTier(normal);
      } else {
        toast('时间已恢复', 'ok');
        renderAll();
        syncNow();
      }
      return;
    }
    state.timePaused = true;
    dirty = true;
    toast('游戏时间已暂停（精力 / 投向 / 公司 / 修炼照常）', 'ok');
    renderAll();
    syncNow();
  }

  async function tcMax() {
    if (!state) return;
    if (state.timePaused) {
      state.timePaused = false;
      dirty = true;
    }
    const maxT = Core.maxUnlockedTier(state);
    if (state.timeTier === maxT && !state.timePaused) {
      toast('已是最高速：' + Core.tierInfo(maxT).label, 'ok');
      return;
    }
    await pickTier(maxT);
  }

  function renderClockControls() {
    const play = $('btn-tc-play');
    if (play) {
      const paused = !!state.timePaused;
      const want = paused ? '⏸' : '▶';
      if (play.textContent !== want) play.textContent = want;
      play.classList.toggle('paused', paused);
      play.title = paused ? '恢复常速（1 秒 = 1 小时）' : '暂停游戏时间';
    }
    const maxT = Core.maxUnlockedTier(state);
    const maxBtn = $('btn-tc-max');
    if (maxBtn) {
      maxBtn.classList.toggle('top', state.timeTier === maxT && !state.timePaused);
      maxBtn.title = '最大速度：' + Core.tierInfo(maxT).label;
    }
    const faster = $('btn-tc-faster');
    if (faster) {
      const atTop = state.timeTier >= maxT && !state.timePaused;
      faster.disabled = atTop;
    }
    const slower = $('btn-tc-slower');
    if (slower) {
      const tiers = sortedTiers().filter((t) => Core.tierUnlocked(state, t.tier));
      slower.disabled = tiers.length < 2 || tiers[0].tier === state.timeTier;
    }
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
        toast('习得功法 ' + names + '　—　灵气、神识、功法算力投入已解锁', 'ok');
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

  function lineBuyQty() {
    const el = document.getElementById('line-buy-qty');
    const v = el ? Math.floor(Number(el.value) || 1) : 1;
    return Math.max(1, Math.min(100, v));
  }

  async function buyLine(lineId) {
    const qty = lineBuyQty();
    const r = await companyAction('buyLine', { lineId: lineId, count: qty });
    if (!r) return;
    const line = GAME.company.lines.find((l) => l.id === lineId);
    const bought = r.bought || 1;
    toast('已购入「' + (line ? line.name : lineId) + '」×' + bought +
      (r.asked > bought ? '（想买 ' + r.asked + ' 台，金钱只够 ' + bought + ' 台）' : '') +
      '（共 ' + r.owned + ' 条）', 'ok');
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
      // 大单才上通知栏：成交额 ≥ 100 万 或 ≥ 手头金钱的一成，小额进出不刷屏
      const total = D.fromJSON(r.total);
      if (total.gte(1e6) || total.gte(state.money.mul(0.1))) {
        pushEvent('股市大单：买入 ' + stock.name + '（' + stock.code + '）' +
          fmtCount(r.shares) + ' 股 · 支出 ' + fmt(total), 'money');
      }
    } else {
      const profit = D.fromJSON(r.profit);
      toast('卖出 ' + stock.name + ' ×' + fmtCount(r.shares) +
        '　均价 ' + fmt(D.fromJSON(r.unitPrice)) +
        '　净得 +' + fmt(D.fromJSON(r.net)) +
        '　本笔盈亏 ' + (profit.isNeg() ? '' : '+') + fmt(profit), 'ok');
      // 清仓后把数量还原成默认手数，下次开仓不用自己再填
      if (r.sharesAfter === 0) delete stockQty[stockId];
      const big = D.fromJSON(r.net).gte(1e6);
      if (big) {
        pushEvent('股市大单：清出 ' + stock.name + '（' + stock.code + '）' +
          fmtCount(r.shares) + ' 股 · 净得 ' + fmt(D.fromJSON(r.net)) +
          '（' + (profit.isNeg() ? '亏 ' : '盈 ') + fmt(profit) + '）', 'money');
      }
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

      // 本地 tick **刻意关掉自动渡劫**（tribulation:false）。
      // 渡劫失败会触发被动兵解、连设备与功法一起清空，而这两样在服务端的
      // /api/save 里是「只增不减」的 —— 本地先失败再回写，会被服务端原样补回来，
      // 变成「界面归零、服务器还留着元婴」。所以渡劫统一走 /api/action 的服务端权威路径。
      if (dt > GAME.offline.thresholdSeconds) {
        Core.tick(state, dt, { offline: true, tribulation: false });
        toast('检测到长时间未操作，按离线规则结算', 'ok');
      } else if (dt > 0) {
        Core.tick(state, dt, { offline: false, tribulation: false });
      }

      renderAll();
      // 事件观察器抛错不能拖垮主循环 —— 播报是锦上添花，不是主流程
      try { observeEvents(); } catch (e) { console.warn('[事件栏]', e); }
      // 不做的话挂机会永久停在满格进度条上，主线等于断了。
      if (state.autoTribulation !== false && Core.tribulationReady(state)) {
        tryTribulation();
      }

      if (now - lastServerSave >= GAME.save.intervalMs) {
        syncNow();
      }
    }, GAME.ui.tickMs);
  }

  /**
   * 请求服务端执行一次渡劫。节流 1.2 秒，避免「灵气刚好压在阈值上」时
   * 每 100ms 发一次请求（失败会重置状态，成功的下一境也要等一小会儿）。
   */
  let lastTribulationAt = 0;
  let tribulating = false;
  async function tryTribulation() {
    if (!state || tribulating) return;
    const now = Date.now();
    if (now - lastTribulationAt < 1200) return;
    lastTribulationAt = now;
    tribulating = true;
    try {
      // 先把本地进度推上去，避免服务端手里的灵气还差一点点而拒收
      await syncNow(true);
      const r = await rebirthAction('tribulation', {});
      if (r && r.ok) announceTribulation(r);
    } catch (e) {
      toast(e.message || '渡劫失败', 'err');
    } finally {
      tribulating = false;
    }
  }

  /** 渡劫结果的一次性提示 —— 成功/失败都要说清楚发生了什么 */
  function announceTribulation(r) {
    if (r.success) {
      toast('渡劫成功：境界 → ' + (r.realmName || '') +
        '　渡劫淬体 ' + r.level + ' 层（全项基础加成提升）', 'ok');
      pushEvent('渡劫成功 → ' + (r.realmName || '') +
        '　渡劫淬体 ' + r.level + ' 层，全项基础加成永久提升', 'good');
      return;
    }
    let msg = '渡劫失败：' + (r.lostRealmName || '') + ' 境界崩解，被迫兵解';
    if (r.fullWipe) msg += ' · 未及元婴，一切归零';
    msg += '（+' + fmtCount(r.dao) + ' 道行）';
    toast(msg, 'err');
    pushEvent('渡劫失败：' + (r.lostRealmName || '') + ' → 被动兵解' +
      (r.fullWipe ? '（未及元婴，设备与功法一并清空）' : '') +
      '，获得 ' + fmtCount(r.dao) + ' 道行', 'err');
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
      // 服务端判定「客户端手里是过期存档」时会回传最新存档（典型场景：
      // 另一个标签页已经兵解过，而这一页还拿着兵解前的 state 在定时回写）。
      // 这种情况必须直接采用服务端版本，否则两边的公司 / 股市状态会互相覆盖。
      if (e.data && e.data.state) {
        state = Core.hydrate(e.data.state);
        lastLocalTick = Date.now();
        dirty = false;
        setSaveStatus('已改用服务端存档', 'ok');
        renderAll();
        if (e.message) toast(e.message, 'err');
        return;
      }
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

  // ---- 渡劫 ----
  const tbBtn = $('btn-tribulation');
  if (tbBtn) {
    tbBtn.addEventListener('click', () => {
      if (!state || !Core.tribulationReady(state)) {
        toast('灵气未满，还引不动天劫', 'err');
        return;
      }
      // 手动渡劫是玩家主动按下的高风险动作 —— 确认一次，避免误触
      if (!window.confirm('确认渡劫？\n\n成功：境界提升，渡劫淬体 +1 层（全项永久加成）\n失败：被动兵解，这一世作废' +
        (state.realm < ((GAME.tribulation.passiveRules || {}).belowRealm || 4)
          ? '（未及元婴，设备与功法一并清空）' : '（道行打三折）'))) {
        return;
      }
      lastTribulationAt = 0;   // 手动点击不受节流限制
      tryTribulation();
    });
  }
  const tbChk = $('chk-auto-tribulation');
  if (tbChk) {
    tbChk.addEventListener('change', async (e) => {
      const on = !!e.target.checked;
      if (state) state.autoTribulation = on;
      dirty = true;
      try {
        await rebirthAction('setAutoTribulation', { on: on });
      } catch (err) {
        /* 服务端不可用时也让本地开关生效，下次保存会带上去 */
      }
      toast(on ? '已开启自动渡劫：灵气一满就硬闯' : '已关闭自动渡劫：灵气满格后等你手动渡', 'ok');
      renderAll();
    });
  }

  // ---- 兵解 · 转生 ----
  const rbBtn = $('btn-rebirth');
  if (rbBtn) rbBtn.addEventListener('click', openRebirthModal);
  const rbCancel = $('btn-rebirth-cancel');
  if (rbCancel) rbCancel.addEventListener('click', closeRebirthModal);
  const rbConfirm = $('btn-rebirth-confirm');
  if (rbConfirm) rbConfirm.addEventListener('click', doRebirthNow);
  // 点遮罩关闭，点弹窗本体不关
  const rbMask = $('rebirth-modal');
  if (rbMask) {
    rbMask.addEventListener('click', (e) => {
      if (e.target === rbMask) closeRebirthModal();
    });
  }
  // 道行加成列表是动态重绘的，用事件委托绑升级按钮
  const rbPerks = $('rb-perk-list');
  if (rbPerks) {
    rbPerks.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-perk]');
      if (btn && !btn.disabled) buyRebirthPerk(btn.dataset.perk);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = $('rebirth-modal');
    if (m && !m.classList.contains('hidden')) closeRebirthModal();
  });

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
