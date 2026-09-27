/**
 * app · page-market —— 市场页：行情分组与四键排序、抛压条、迷你走势、卖货操作。
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

  // 市场行业折叠（v3.7）：folded 集合 + 初始化哨兵。只记状态，不再据此重建 DOM
  A.mktFolded = new Set();

  A.mktFoldInit = new Set();

    /** v3.6：市场分组骨架（fusion kind + 折叠箭头），折叠态变化时整体重建 */
  A.buildMarketGroups = function buildMarketGroups() {
      A.$('mk-good-list').innerHTML = GAME.company.industries.map((ind) => {
        const goods = GAME.company.goods.filter((g) => g.industry === ind.id);
        if (!goods.length) return '';
        const kind = A.marketKindOf(ind.id);
        const ups = (ind.upstream || []).map((u) => A.indName(u)).join(' + ');
        // 融合行业默认折叠（48 个组全展开页面太长），点击组头切换
        if (kind === 'fusion' && !A.mktFoldInit.has(ind.id)) { A.mktFoldInit.add(ind.id); A.mktFolded.add(ind.id); }
        return '<div class="mk-group ' + kind + (A.mktFolded.has(ind.id) ? ' folded' : '') + '" data-industry="' + ind.id + '">' +
          '<div class="mk-group-head" data-role="ghead" data-collapse="next" ' +
            'aria-expanded="' + (A.mktFolded.has(ind.id) ? 'false' : 'true') + '" ' +
            'title="点击折叠 / 展开该行业产品">' +
            '<span class="mk-fold">▾</span>' +
            '<span class="mk-group-icon">' + A.esc(A.indIcon(ind.id)) + '</span>' +
            '<span class="mk-group-name">' + A.esc(ind.name) + '</span>' +
            '<span class="mk-group-tag">' + (kind === 'fusion' ? '融合 · ' : '') + (ups ? ('上游 · ' + A.esc(ups)) : '最上游 · 无原料依赖') + '</span>' +
            '<span class="mk-group-idx" data-role="gidx"></span>' +
          '</div>' +
          '<div class="mk-group-body">' + goods.map((g) => A.goodRowHTML(g, kind)).join('') + '</div>' +
        '</div>';
      }).join('');
    }

  /** 行业图标 —— 商品行与行业条共用同一套单字标记 */
  A.IND_ICON = {
    mining: '矿', smelt: '冶', chem: '化', precision: '精', electron: '电', assembly: '装',
    herb: '植', alchemy: '丹', talisman: '符', refine: '器', array: '阵', cave: '洞',
  };

  A.indIcon = function indIcon(id) { return A.IND_ICON[id] || '产'; }

  A.indName = function indName(id) {
    const ind = (GAME.company.industries || []).find((x) => x.id === id);
    return ind ? ind.name : (id || '其他');
  }

  /** 单个商品行情行的静态结构（市场页按行业分组塞进去） */
  A.goodRowHTML = function goodRowHTML(g, kind) {
    const kindName = kind === 'xiuxian' ? '修仙类' : (kind === 'fusion' ? '融合类' : '科技类');
    return '<div class="co-good ' + kind + '" data-good="' + g.id + '">' +
      '<div class="co-good-icon">' + A.esc(A.indIcon(g.industry)) + '</div>' +
      '<div class="co-good-main">' +
        '<div class="co-good-title">' + A.esc(g.name) +
          '<span class="co-line-tag ' + kind + '">' + kindName + '</span>' +
          '<span class="co-line-tag">每 ' + A.fmtPeriod(g.periodSeconds) + '变价</span>' +
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

  // ============================================================
  // 商品列表排序（v3.8）
  // ============================================================
  /*
   * 四个互斥按钮：行业（回到分组）/ 价格 / 涨幅 / 跌幅。
   * 后三个是「打散分组、全表统一排序」，首次点击升序（↓），再点降序（↑）。
   *
   * 排序状态只有一个 { field, dir }，所以「切换时重置其他按钮」是天然的 ——
   * 不存在两个字段同时生效的可能。
   *
   * 数据每帧刷新，但**排序不每帧重排**：价格只在换期 / 抛压变化时动，每帧重排
   * 会让 288 行在眼前乱跳。这里做的是「节流 + 顺序签名比对」—— 顺序真变了才动 DOM，
   * 且只移动已有节点（appendChild），不重建，于是迷你走势图缓存、选中态都不丢。
   */
  A.mktSort = { field: 'industry', dir: 1 };

  A.mktSortSig = '';

  A.mktSortCheckedAt = 0;

  A.MKT_RESORT_MS = 1200;

  A.MKT_SORT_LABEL = { industry: '行业', price: '价格', gain: '涨幅', drop: '跌幅' };

  /** kind 字段 → 展示标签（tech / xiuxian / fusion），行业与股票共用同一映射 */
  A.kindTag = function kindTag(kind) {
    return kind === 'xiuxian' ? 'xiuxian' : (kind === 'fusion' ? 'fusion' : 'tech');
  }

  A.marketKindOf = function marketKindOf(industryId) {
    const ind = (GAME.company.industries || []).find((x) => x.id === industryId);
    return A.kindTag(ind ? ind.kind : '');
  }

  /** 涨跌幅（相对基准价）：涨为正、跌为负。drop 字段取相反数，于是「跌得越狠」值越大 */
  A.marketChangePct = function marketChangePct(good) {
    const base = Number(good.basePrice) || 1;
    const cur = Core.goodsPriceWith(A.state, good);
    const b = new D(base);
    if (b.eq(0)) return 0;
    return cur.div(b).toNumber() - 1;
  }

  A.marketSortCmp = function marketSortCmp(a, b) {
    if (A.mktSort.field === 'price') {
      const c = Core.goodsPriceWith(A.state, a).cmp(Core.goodsPriceWith(A.state, b));
      return A.mktSort.dir === 1 ? c : -c;
    }
    const ga = A.mktSort.field === 'gain' ? A.marketChangePct(a) : -A.marketChangePct(a);
    const gb = A.mktSort.field === 'gain' ? A.marketChangePct(b) : -A.marketChangePct(b);
    const d = ga - gb;
    if (d !== 0) return A.mktSort.dir === 1 ? d : -d;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  /** 按当前字段排好序的商品列表 */
  A.marketSortedGoods = function marketSortedGoods() {
    const list = GAME.company.goods.slice();
    list.sort(A.marketSortCmp);
    return list;
  }

  /** 同步四个按钮的高亮与箭头（箭头用文本 ↓ / ↑，方向一眼可见） */
  A.syncSortButtons = function syncSortButtons() {
    const bar = A.$('mk-sortbar');
    if (!bar) return;
    const btns = bar.querySelectorAll('[data-sort]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const on = b.dataset.sort === A.mktSort.field;
      b.classList.toggle('on', on);
      b.classList.toggle('asc', on && A.mktSort.dir === 1);
      b.classList.toggle('desc', on && A.mktSort.dir === -1);
      const ar = b.querySelector('.ar');
      if (ar) ar.textContent = on ? (A.mktSort.dir === 1 ? '↓' : '↑') : '';
    }
    const hint = A.$('ui-mk-sort-hint');
    if (hint) {
      // 升序 / 降序具体到「从什么排到什么」—— 「涨幅升序」= 跌最多 → 涨最多，
      // 光写「升序」会让人以为是在看涨幅榜。
      const RANGE = {
        price: ['低价 → 高价', '高价 → 低价'],
        gain: ['跌最多 → 涨最多', '涨最多 → 跌最多'],
        drop: ['涨最多 → 跌最多', '跌最多 → 涨最多'],
      };
      const r = RANGE[A.mktSort.field];
      hint.textContent = A.mktSort.field === 'industry'
        ? '按行业分组展示 · 点组头折叠 / 展开'
        : ('全表按' + A.MKT_SORT_LABEL[A.mktSort.field] + (A.mktSort.dir === 1 ? '升序' : '降序') +
           (r ? '（' + r[A.mktSort.dir === 1 ? 0 : 1] + '）' : '') + '　点「行业」回到分组');
    }
  }

  /**
   * 把排序状态落到 DOM。
   * @param {boolean} force true = 无条件重建（用户刚点按钮）；false = 顺序变了才动
   */
  A.applyMarketSort = function applyMarketSort(force) {
    const list = A.$('mk-good-list');
    if (!list) return;
    if (A.mktSort.field === 'industry') {
      A.buildMarketGroups();
      A.mktSortSig = 'industry';
      A.syncSortButtons();
      return;
    }
    const order = A.marketSortedGoods();
    const sig = order.map((g) => g.id).join(',');
    if (!force && sig === A.mktSortSig) return;

    const rows = list.querySelectorAll('.co-good');
    if (rows.length !== order.length || list.querySelector('.mk-group')) {
      // 结构不匹配（刚从分组切过来 / 首次进入）→ 整体重建
      list.innerHTML = order.map((g) => A.goodRowHTML(g, A.marketKindOf(g.industry))).join('');
    } else {
      // 已有一批行：按新顺序移动节点（appendChild 即移动，元素身份与事件都保留）
      const byId = Object.create(null);
      for (let i = 0; i < rows.length; i++) byId[rows[i].dataset.good] = rows[i];
      const frag = document.createDocumentFragment();
      for (const g of order) {
        const el = byId[g.id];
        if (el) frag.appendChild(el);
      }
      list.appendChild(frag);
    }
    A.mktSortSig = sig;
    A.syncSortButtons();
  }

  /** 刷新后仍按当前字段排序 —— 节流，别让列表每帧乱跳 */
  A.maybeResortMarket = function maybeResortMarket() {
    if (A.mktSort.field === 'industry') return;
    const now = Date.now();
    if (now - A.mktSortCheckedAt < A.MKT_RESORT_MS) return;
    A.mktSortCheckedAt = now;
    A.applyMarketSort(false);
  }

  /**
   * 市场页 —— 商品行情独立成页。
   *
   * 价格是公开信息，未成立公司也能看；库存与卖出要公司成立后才可用。
   * 商品按**行业**分组：上游涨价会顺着产业链传导（下游成本涨、售价跟涨但毛利被压缩），
   * 所以分组头会把这个行业的成本 / 售价指数显示出来。
   */
  A.renderMarketPage = function renderMarketPage() {
    if (!GAME.company || !GAME.company.implemented) return;
    const founded = Core.companyFounded(A.state);
    // id -> 商品配置。72 件商品逐行 find 是 O(n²)，每帧白扫五千多次 —— 用 Map 一次到位
    const goodByIdMap = Object.create(null);
    for (const g of GAME.company.goods) goodByIdMap[g.id] = g;

    // 走势图选中的商品：为空或已失效（配置改过）时回落到第一个
    if (!GAME.company.goods.some((g) => g.id === A.chartGood)) {
      A.chartGood = GAME.company.goods.length ? GAME.company.goods[0].id : null;
    }

    // ---------- 行业景气 ----------
    let worstMargin = 1;
    const indItems = A.$('mk-ind-list').querySelectorAll('.mk-ind');
    for (let i = 0; i < indItems.length; i++) {
      const el = indItems[i];
      const id = el.dataset.industry;
      const cost = Core.industryCostIndex(A.state, id);
      const price = Core.industryPriceIndex(A.state, id);
      const up = Core.industryUpstreamRatio(A.state, id);
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
    const indHint = A.$('ui-mk-ind-hint');
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

    // v3.8：排序可能把分组打散成平铺列表 —— 行一律从整个列表里取，
    // 不假设自己一定在 .mk-group 里；组头的指数只在分组模式下回填。
    A.maybeResortMarket();

    const groups = A.$('mk-good-list').querySelectorAll('.mk-group');
    for (let gi = 0; gi < groups.length; gi++) {
      const gid = groups[gi].dataset.industry;
      const idxEl = groups[gi].querySelector('[data-role="gidx"]');
      if (idxEl) {
        const c = Core.industryCostIndex(A.state, gid);
        const p = Core.industryPriceIndex(A.state, gid);
        idxEl.textContent = '成本 ×' + c.toFixed(2) + '　售价 ×' + p.toFixed(2);
      }
    }

    {
      const items = A.$('mk-good-list').querySelectorAll('.co-good');
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const good = goodByIdMap[el.dataset.good];
        if (!good) continue;

        // 价格一律用带抛压的版本 —— 界面上看到的钱必须就是卖出能拿到的钱
        const price = Core.goodsPriceWith(A.state, good);
        const trend = Core.goodsTrend(good, A.state.playTime);
        const pressure = Core.pressureOf(A.state, good.id);
        const drop = Core.marketDropRatio(A.state, good);
        if (pressure > peakPressure) peakPressure = pressure;
        if (pressure > 0) pressuredGoods += 1;

        const stock = Core.stockOf(A.state, good.id);
        const value = price.mul(stock);
        stockValue = stockValue.add(value);

        const period = Core.goodsPeriod(good, A.state.playTime);

        A.setT(el.querySelector('[data-role="gprice"]'), 'textContent', A.fmt(price));

        // 涨红跌绿（中国习惯）
        const tEl = el.querySelector('[data-role="gtrend"]');
        const arrow = trend === 'up' ? '▲ 涨' : (trend === 'down' ? '▼ 跌' : '— 平');
        A.setT(tEl, 'className', 'trend ' + trend);
        A.setT(tEl, 'textContent', arrow + '　基准 ' + A.fmt(new D(good.basePrice)));

        A.setT(el.querySelector('[data-role="gmeta"]'), 'innerHTML',
          '距下次变价 ' + A.esc(A.fmtRealDuration(Core.goodsNextChangeIn(good, A.state.playTime))) +
          '　累计卖出 ' + A.fmtCount(A.state.company.goodsSold[good.id] || 0) + ' 件');

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
            A.setT(txtEl, 'innerHTML', '已被压 −' + A.esc((drop * 100).toFixed(1)) + '%' +
              '<span class="faint">　本应 ' + A.esc(A.fmt(Core.naturalPrice(good, A.state.playTime, A.state))) +
              '　卖出后下一期起跳</span>');
          }
          pressEl.classList.toggle('warn', pressure >= ((GAME.company.market || {}).warnAt || 0.45));
        }

        el.classList.toggle('selected', good.id === A.chartGood);

        // 行内迷你走势：只看已发生的期，不推演。
        // 72 件商品各一张 SVG，期内静止 —— 按 (商品, 期, 有无抛压) 缓存，
        // 没换期就不重建字符串、不让浏览器重新解析。
        const sparkEl = el.querySelector('[data-role="gspark"]');
        if (sparkEl) {
          const sKey = good.id + ':' + period + ':' + (pressure > 0 ? 1 : 0);
          let svg = A.stockSparkCache.get(sKey);
          if (svg === undefined) {
            svg = A.priceChartSVG(good, A.state.playTime, trend, 8, 0, 34);
            if (A.stockSparkCache.size > 300) A.stockSparkCache.clear();
            A.stockSparkCache.set(sKey, svg);
          }
          if (sparkEl.innerHTML !== svg) sparkEl.innerHTML = svg;
        }

        const nEl = el.querySelector('[data-role="gstock"]');
        A.setT(nEl, 'textContent', A.fmtCount(stock) + ' 件');
        nEl.classList.toggle('zero', stock === 0);
        A.setT(el.querySelector('[data-role="gvalue"]'), 'textContent', '市值 ' + A.fmt(value));

        const gs = el.querySelector('[data-role="gsell"]');
        const gsd = !founded || stock <= 0;
        if (gs.disabled !== gsd) gs.disabled = gsd;
      }
    }

    // ---------- 底部：库存与清仓（要公司成立）----------
    const used = Core.stockTotal(A.state);
    A.setText('ui-mk-stock-value', A.fmt(stockValue));
    A.setText('ui-mk-stock-count', A.fmtCount(used));
    const foot = A.$('mk-foot');
    if (foot) foot.classList.toggle('hidden', !founded);
    const sellAllBtn = A.$('btn-mk-sell-all');
    if (sellAllBtn) sellAllBtn.disabled = !founded || used <= 0;

    const mktHint = A.$('ui-mk-market-hint');
    if (mktHint) {
      if (!founded) {
        mktHint.className = 'hint';
        mktHint.textContent = '行情公开可看　·　成立公司后才能在市场里卖货';
      } else if (peakPressure <= 0) {
        mktHint.className = 'hint';
        const gp = (k) => A.fmtPeriod(((GAME.company.goods.find((x) => x.kind === k) || {}).periodSeconds) || 60);
        mktHint.textContent = '科技类每 ' + gp('tech') + '变价 · 修仙类每 ' + gp('xiuxian') + '变价　·　无抛压';
      } else {
        const warnAt = (GAME.company.market || {}).warnAt || 0.45;
        mktHint.className = 'hint ' + (peakPressure >= warnAt ? 'err' : 'warn');
        mktHint.textContent = '抛压最高 ' + (peakPressure * 100).toFixed(0) + '%' +
          '（' + A.fmtCount(pressuredGoods) + ' 种商品被压价）　·　正常清仓不压价，砸库存才会';
      }
    }

    // ---------- 走势图（跟随选中的商品）----------
    const cg = GAME.company.goods.find((g) => g.id === A.chartGood) || GAME.company.goods[0];
    const chartBody = A.$('mk-chart-body');
    if (cg && chartBody) {
      const span = 12;
      const cTrend = Core.goodsTrend(cg, A.state.playTime);
      const cPeriod = Core.goodsPeriod(cg, A.state.playTime);
      const perSec = cg.periodSeconds || 60;

      chartBody.innerHTML = A.priceChartSVG(cg, A.state.playTime, cTrend, span, 8, 118);
      A.setText('ui-mk-chart-name', cg.name);
      A.setText('ui-mk-chart-tag',
        A.esc(A.indName(cg.industry)) + ' · 每 ' + A.fmtPeriod(perSec) + '变价');

      const cPrice = Core.goodsPriceWith(A.state, cg);
      const cNatural = Core.naturalPrice(cg, A.state.playTime, A.state);
      const cDrop = Core.marketDropRatio(A.state, cg);
      const cCost = Core.industryCostIndex(A.state, cg.industry);
      A.setText('ui-mk-chart-foot',
        '第 ' + Math.max(0, cPeriod - span) + ' ~ ' + (cPeriod + 8) +
        ' 期（当前第 ' + cPeriod + ' 期）　现价 ' + A.fmt(cPrice) +
        (cDrop > 0.0005 ? '（自然价 ' + A.fmt(cNatural) + '，被抛压压低 ' + (cDrop * 100).toFixed(1) + '%）' : '') +
        '　基准 ' + A.fmt(new D(cg.basePrice)) +
        '　' + A.indName(cg.industry) + '成本 ×' + cCost.toFixed(2) +
        '　距下次变价 ' + A.fmtRealDuration(Core.goodsNextChangeIn(cg, A.state.playTime)));
    }
  }

  A.sellGood = async function sellGood(goodId) {
    const r = await A.serverAction('sellGoods', { goodId: goodId });
    if (!r) return;
    const g = GAME.company.goods.find((x) => x.id === goodId);
    A.toast('卖出 ' + (g ? g.name : goodId) + ' ×' + A.fmtCount(r.count) +
      '　+' + A.fmt(D.fromJSON(r.revenue)), 'ok');
  }

  A.sellAllGoods = async function sellAllGoods() {
    const r = await A.serverAction('sellGoods', { goodId: 'all' });
    if (!r) return;
    A.toast('清仓完成　+' + A.fmt(D.fromJSON(r.revenue)), 'ok');
  }

  A.toggleAutoSell = async function toggleAutoSell(on) {
    const r = await A.serverAction('setAutoSell', { autoSell: on });
    if (!r) return;
    A.toast(on
      ? '已开启自动卖出：每个周期结束自动清仓'
      : '已关闭自动卖出：产物留在仓库里等价格，注意别爆仓', 'ok');
  }
})(typeof window !== 'undefined' ? window : globalThis);
