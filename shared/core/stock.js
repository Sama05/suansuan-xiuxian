/**
 * game-core · stock —— 股市：三层价格（行情 × 公司联动 × 持仓冲击）、按成交后冲击价结算的买卖报价、逐期衰减。价格纯确定性，前后端一致。
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
  // 股市（证券账户）
  // ============================================================
  //
  // 与公司市场同样是**纯确定性**的：价格只依赖 (股票序号, 期数) 与存档里的
  // 成交流/持仓，不使用随机数。前端 tick 与后端离线结算必须算出同一个价格。
  //
  // 三层价格：
  //   波动因子   ← hash(股票序号, 期数)                 （行情本身）
  //   联动因子   ← 关联公司商品的价格与抛压             （与市场经济挂钩）
  //   冲击系数   ← 玩家自己的本期净买入与持仓集中度     （反作用，永远不利）
  //
  // 冲击为什么永远对玩家不利：成交按**成交后**的冲击价结算 —— 买入把 flow 推大、
  // 成交价被自己顶高；卖出把 flow 压小、成交价被自己砸低。而 flow 每期按
  // flowDecay 衰减，也就是「你买出来的溢价会自己退回去」，等它涨了再卖是拿不到的。
  // 唯一的盈利来源是赌对自然价的方向。

  C.stockCfg = function stockCfg() { return GAME.stock || {}; }

  C.stockFlowDecay = function stockFlowDecay() {
    const d = C.stockCfg().flowDecay;
    return (typeof d === 'number' && d >= 0 && d <= 1) ? d : 0.5;
  }

  // 配置查表缓存：股票池加载后不可变（100 家，行情列表每帧逐行按 id 查）
  let _stockMap = null;
  let _stockIdx = null;
  function stockMap() {
    if (!_stockMap) {
      _stockMap = new Map();
      _stockIdx = new Map();
      GAME.stock.stocks.forEach((x, i) => { _stockMap.set(x.id, x); _stockIdx.set(x.id, i); });
    }
    return _stockMap;
  }

  C.stockById = function stockById(id) {
    if (!id) return null;
    return stockMap().get(id) || null;
  }

  C.stockIndex = function stockIndex(id) {
    if (!id) return -1;
    stockMap();
    return _stockIdx.has(id) ? _stockIdx.get(id) : -1;
  }

  /** 股票是否已解锁（境界门槛） */
  C.stockUnlocked = function stockUnlocked(s) {
    if (!C.stockCfg().implemented) return false;
    const need = C.stockCfg().unlock || {};
    return (s ? s.realm : 0) >= (need.realm || 0);
  }

  /**
   * **单只**股票是否可交易（v3.6）：系统级开户之外，
   * 个股还可以有自己的 unlockRealm（融合赛道 50 家 = 元婴解锁）。
   */
  C.stockAccessible = function stockAccessible(s, stock) {
    if (!C.stockUnlocked(s)) return false;
    if (!stock) return false;
    const need = stock.unlockRealm || 0;
    return (s ? s.realm : 0) >= need;
  }

  /** 逐股锁定原因（界面直接显示） */
  C.stockAccessReason = function stockAccessReason(s, stock) {
    if (C.stockUnlocked(s) && stock && (stock.unlockRealm || 0) > (s ? s.realm : 0)) {
      return '需达到「' + C.realmName(stock.unlockRealm) + '」解锁';
    }
    return '';
  }

  C.stockLockedReason = function stockLockedReason(s) {
    if (!C.stockCfg().implemented) return '股市系统未开放';
    if (C.stockUnlocked(s)) return '';
    const need = C.stockCfg().unlock || {};
    return '需达到「' + C.realmName(need.realm) + '」才能开户';
  }

  /** 流通盘（股）—— 冲击公式的分母，也是单只股票的持仓上限 */
  C.stockDepth = function stockDepth(stock) {
    if (!stock) return 1;
    return Math.max(1, Math.floor(stock.depth || 1));
  }

  /** 股票的变价周期（**现实秒**，与商品市场同一套口径） */
  C.stockPeriodSeconds = function stockPeriodSeconds(stock) {
    return Math.max(1, stock.periodSeconds || 60);
  }

  /** 股票当前处于第几期（按现实时间推进，与时间档位无关） */
  C.stockPeriod = function stockPeriod(stock, realSeconds) {
    return Math.floor(Math.max(0, realSeconds || 0) / C.stockPeriodSeconds(stock));
  }

  /**
   * 某只股票在指定期数下的「行情波动倍数」。
   *
   * 用 exp 而不是线性式：股票的摆动本来就该是**乘性**的（翻倍 / 腰斩），
   * 线性式在 v < 1 时最多只能摆动到 [1−v, 1+v]，做不出「妖股翻几倍」的效果。
   * v 的取值让区间约为 [e^−v, e^v]，再由 minFactor / maxFactor 兜住两端。
   *
   * 注意 exp 是超越函数，与 goodsPriceFactor 里的 Math.sin 同理 ——
   * 前后端都是 V8（Node 服务端 + Chromium 客户端），实现一致，可以复现。
   */
  C.stockFactor = function stockFactor(stock, period) {
    // 第 0 期 = 上市首日，按基准价挂牌，方便对着配置调数值
    if (period <= 0) return 1;
    const i = C.stockIndex(stock.id);
    const k = 0.45 * (C.hash01(period * 2.3 + i * 5.7 + 11.3) * 2 - 1)
      + 0.35 * Math.sin((period + i * 3.7) * 0.75)
      + 0.20 * (C.hash01(period * 0.41 + i * 9.1 + 3.3) * 2 - 1);
    let f = Math.exp((stock.volatility || 0) * k);
    const lo = stock.minFactor || 0.1;
    const hi = stock.maxFactor || 5;
    if (!Number.isFinite(f) || f <= 0) f = lo;
    if (f < lo) f = lo;
    if (f > hi) f = hi;
    return f;
  }

  /**
   * 与公司市场的联动因子。
   *
   * 联动的是「关联商品那一期的实际价格水平 / 基准价」—— 所以你在公司砸某商品的
   * 价格，对应股票也会跟着跌（抛压通过 marketImpactAt 传进来）。
   * linkWeight 把联动调成部分的：完全联动会让股票退化成商品的影子。
   */
  C.stockLinkFactor = function stockLinkFactor(s, stock, period) {
    if (!stock || !stock.link) return 1;
    const g = C.goodById(stock.link);
    if (!g) return 1;
    const w = C.stockCfg().linkWeight;
    if (!(w > 0)) return 1;
    const t = period * C.stockPeriodSeconds(stock);
    const gp = C.goodsPeriod(g, t);
    // 与 naturalPrice 同一口径：行情波动 × 行业传导 × 抛压冲击。
    // 少了传导这一项，股票联动的幅度会跟商品自己的涨跌对不上。
    const ratio = C.goodsPriceFactor(g, gp)
      * C.industryPriceIndex(s, g.industry)
      * C.marketImpactAt(s, g, gp);
    return 1 + (ratio - 1) * w;
  }

  // ---------- 账户读数 ----------

  C.stockShares = function stockShares(s, id) {
    const v = s && s.stock && s.stock.shares && s.stock.shares[id];
    const n = Math.floor(Number(v) || 0);
    return n > 0 ? n : 0;
  }

  /** 本期净买入股数（正 = 净买入，负 = 净卖出） */
  C.stockFlow = function stockFlow(s, id) {
    const v = s && s.stock && s.stock.flow && s.stock.flow[id];
    const n = Math.trunc(Number(v) || 0);
    return Number.isFinite(n) ? n : 0;
  }

  /** 持仓成本（含手续费） */
  C.stockCost = function stockCost(s, id) {
    const v = s && s.stock && s.stock.cost && s.stock.cost[id];
    if (!v) return new D(0);
    return (v instanceof D) ? v : D.fromJSON(v);
  }

  /** 含费持仓均价 */
  C.stockAvgCost = function stockAvgCost(s, id) {
    const n = C.stockShares(s, id);
    if (n <= 0) return new D(0);
    return C.stockCost(s, id).div(n);
  }

  /** 持仓占流通盘的比例（0 ~ 1）—— 越高越「重仓难出」，冲击被放大 */
  C.stockHeldRatio = function stockHeldRatio(s, stock) {
    const r = C.stockShares(s, stock.id) / C.stockDepth(stock);
    return r > 1 ? 1 : r;
  }

  /**
   * 冲击系数（1 = 不受影响）。
   * @param {number} sharesAfter 成交之后的持股数（用于算持仓集中度）
   * @param {number} flowAfter   成交之后的净买入流
   */
  C.stockImpactAt = function stockImpactAt(s, stock, sharesAfter, flowAfter) {
    const cfg = C.stockCfg();
    const depth = C.stockDepth(stock);
    const liq = 1 + Math.max(0, Number(sharesAfter) || 0) / depth * (cfg.illiquidity || 0);
    let raw = ((Number(flowAfter) || 0) / depth) * liq;
    if (!Number.isFinite(raw)) raw = 0;
    const hi = Number(cfg.maxRise) || 0;
    const lo = -(Number(cfg.maxDrop) || 0);
    if (raw > hi) raw = hi;
    if (raw < lo) raw = lo;
    return 1 + raw;
  }

  /** 当前时点的冲击系数（用玩家此刻真实持仓与本期的净买入流） */
  C.stockImpact = function stockImpact(s, stock) {
    return C.stockImpactAt(s, stock, C.stockShares(s, stock.id), C.stockFlow(s, stock.id));
  }

  // ---------- 价格 ----------

  C.stockNaturalAtPeriod = function stockNaturalAtPeriod(s, stock, period) {
    return new D(stock.basePrice)
      .mul(C.stockFactor(stock, period))
      .mul(C.stockLinkFactor(s, stock, period));
  }

  /** 不受玩家成交影响的「自然价」 */
  C.stockNaturalPrice = function stockNaturalPrice(s, stock, realSeconds) {
    if (!stock) return new D(0);
    const t = (realSeconds === undefined || realSeconds === null)
      ? C.marketClock(s) : realSeconds;
    return C.stockNaturalAtPeriod(s, stock, C.stockPeriod(stock, t));
  }

  /** 指定期数的冲击衰减：过去期按 1（历史价不可考），未来期按 flowDecay 逐期恢复 */
  C.stockImpactAtPeriod = function stockImpactAtPeriod(s, stock, period) {
    const flow = C.stockFlow(s, stock.id);
    if (flow === 0) return 1;
    const cur = C.stockPeriod(stock, C.marketClock(s));
    if (period < cur) return 1;
    const dec = Math.pow(C.stockFlowDecay(), period - cur);
    return C.stockImpactAt(s, stock, C.stockShares(s, stock.id), flow * dec);
  }

  /** 当前成交价 = 自然价 × 冲击系数，并兜一道绝对下限 */
  /**
   * 股价缓存：s -> { key, map }。
   *
   * 股价是纯函数，只由这几项决定：期数（自然价）、抛压版本号（联动因子）、
   * 玩家持仓与本期净买入流（冲击系数）。行情不动的那一帧里，100 只股票的报价
   * 其实一模一样 —— 但走一遍完整链路要几毫秒，而界面 100ms 就重绘一次。
   * key 变了整张作废，不会无限增长。
   */
  const _stockPxMemo = new WeakMap();
  C.stockPxMemo = function stockPxMemo(s) {
    let e = (s && typeof s === 'object') ? _stockPxMemo.get(s) : null;
    if (!e) {
      e = { key: '', map: new Map() };
      if (s && typeof s === 'object') _stockPxMemo.set(s, e);
    }
    return e;
  }

  C.stockPrice = function stockPrice(s, stock, realSeconds) {
    if (!stock) return new D(0);
    // 只在「取当前时点」这条路上缓存：显式传 realSeconds 是回看历史价，
    // 那种调用本来就少，不做缓存也无所谓。
    const memoable = !!(s && typeof s === 'object') &&
      (realSeconds === undefined || realSeconds === null);
    const t = memoable ? C.marketClock(s) : (realSeconds || 0);

    let store = null;
    let mKey = null;
    if (memoable) {
      store = C.stockPxMemo(s);
      const key = C.stockPeriod(stock, t) + '|' + C.mktVer();
      if (store.key !== key) { store.key = key; store.map.clear(); }
      mKey = stock.id + '|' + C.stockShares(s, stock.id) + '|' + C.stockFlow(s, stock.id);
      const hit = store.map.get(mKey);
      if (hit) return hit;
    }

    const nat = C.stockNaturalAtPeriod(s, stock, C.stockPeriod(stock, t));
    const px = nat.mul(C.stockImpact(s, stock));
    const fl = nat.mul(C.stockCfg().floor || 0);
    const v = px.lt(fl) ? fl : px;
    if (store) store.map.set(mKey, v);
    return v;
  }

  /** 相对上一期的行情涨跌：'up' / 'down' / 'flat'（只看自然价，不看自己的冲击） */
  C.stockTrend = function stockTrend(s, stock) {
    const p = C.stockPeriod(stock, C.marketClock(s));
    if (p <= 0) return 'flat';
    const cur = C.stockNaturalAtPeriod(s, stock, p).toNumber();
    const prev = C.stockNaturalAtPeriod(s, stock, p - 1).toNumber();
    if (cur > prev * 1.004) return 'up';
    if (cur < prev * 0.996) return 'down';
    return 'flat';
  }

  /**
   * 下一期的预计涨跌幅（%），给事件通知栏的「行情前瞻」用。
   *
   * 价格是确定性的（由「股票序号 + 期数」散列推导），所以下一期**能算出来** ——
   * 这不是预测，是把已经定好的未来念出来。返回 null 表示算不出（新上市 / 配置缺失）。
   *
   * 刻意只看自然价、不含玩家自己的冲击：前瞻播报的是「行情」，不是「你的仓位」。
   */
  C.stockForecastPct = function stockForecastPct(s, stock) {
    if (!stock || !s || !C.stockCfg().implemented) return null;
    const p = C.stockPeriod(stock, C.marketClock(s));
    const cur = C.stockNaturalAtPeriod(s, stock, p).toNumber();
    if (!(cur > 0)) return null;
    const next = C.stockNaturalAtPeriod(s, stock, p + 1).toNumber();
    if (!Number.isFinite(next)) return null;
    return (next / cur - 1) * 100;
  }

  /** 距下次变价还剩多少现实秒 */
  C.stockNextChangeIn = function stockNextChangeIn(stock, realSeconds) {
    const len = C.stockPeriodSeconds(stock);
    const rem = Math.max(0, realSeconds || 0) % len;
    return len - rem;
  }

  /** [fromPeriod, toPeriod] 内每一期的价格（含冲击衰减），折线图用 */
  C.stockSeries = function stockSeries(s, stock, fromPeriod, toPeriod) {
    if (!stock) return [];
    const a = Math.max(0, Math.floor(fromPeriod));
    const b = Math.max(a, Math.floor(toPeriod));
    const len = C.stockPeriodSeconds(stock);
    const out = [];
    for (let p = a; p <= b; p++) {
      const nat = C.stockNaturalAtPeriod(s, stock, p);
      const impact = C.stockImpactAtPeriod(s, stock, p);
      let price = nat.mul(impact);
      const fl = nat.mul(C.stockCfg().floor || 0);
      if (price.lt(fl)) price = fl;
      out.push({ period: p, price: price, natural: nat, t: p * len, impact: impact });
    }
    return out;
  }

  /** 以当前期为基准、前后各若干期的走势（含当前期） */
  C.stockWindow = function stockWindow(s, stock, past, future) {
    const w = C.windowRange(C.stockPeriod(stock, C.marketClock(s)), past, future);
    return C.stockSeries(s, stock, w.from, w.to);
  }

  /** 当前持仓市值 */
  C.stockHoldingValue = function stockHoldingValue(s, stock) {
    return C.stockPrice(s, stock).mul(C.stockShares(s, stock.id));
  }

  /** 当前浮动盈亏（市值 − 含费成本） */
  C.stockHoldingPnl = function stockHoldingPnl(s, stock) {
    const n = C.stockShares(s, stock.id);
    if (n <= 0) return new D(0);
    return C.stockHoldingValue(s, stock).sub(C.stockCost(s, stock.id));
  }

  // ---------- 报价（前端预览与服务端结算共用同一份，保证数字一致）----------

  /**
   * 买入报价：按**成交后**的冲击价结算。
   * @returns {object} { ok, msg, shares, unitPrice, gross, fee, total, impact, natural, tooSmall }
   */
  C.stockBuyQuote = function stockBuyQuote(s, stock, shares) {
    if (!stock) return { ok: false, msg: '股票不存在' };
    return C.stockBuyQuoteWith(s, stock, shares,
      C.stockNaturalPrice(s, stock), C.stockFee(s), C.stockCfg());
  }

  /**
   * stockBuyQuote 的实际实现：`nat` / `fee` 由调用方传入。
   *
   * 为什么要拆出来：`stockMaxBuy` 是一次二分查找（最多几十次迭代），
   * 而自然价与手续费在整个查找过程中**完全不变**。早先每次迭代都重新推导
   * 一遍自然价 —— 那是一条「行情因子 × 行业传导 × 公司联动」的链，
   * 单次就要几十微秒，乘上迭代数就是毫秒级。股市页每帧要对 50 只股票各来一次，
   * 每帧 30ms+ —— 这是「股市页卡顿」的第二个根因（第一个是行业传导的自引用）。
   */
  C.stockBuyQuoteWith = function stockBuyQuoteWith(s, stock, shares, nat, feeRate, cfg) {
    if (!stock) return { ok: false, msg: '股票不存在' };
    const want = Math.floor(Number(shares) || 0);
    if (!(want > 0)) return { ok: false, msg: '数量必须大于 0' };

    const depth = C.stockDepth(stock);
    const have = C.stockShares(s, stock.id);
    if (have + want > depth) {
      return { ok: false, msg: '超过流通盘上限（最多持有 ' + depth + ' 股）' };
    }

    const impact = C.stockImpactAt(s, stock, have + want, C.stockFlow(s, stock.id) + want);
    const unitPrice = nat.mul(impact);
    const gross = unitPrice.mul(want);
    const fee = gross.mul(feeRate);
    const total = gross.add(fee);
    return {
      ok: true, shares: want, unitPrice: unitPrice, gross: gross, fee: fee, total: total,
      impact: impact, natural: nat,
      tooSmall: gross.lt(new D(cfg.minOrder || 0)),
    };
  }

  /**
   * 卖出报价：同样按**成交后**的冲击价结算（卖得越多，均价越低）。
   * shares 省略或 <= 0 表示全部卖出。
   */
  C.stockSellQuote = function stockSellQuote(s, stock, shares) {
    const cfg = C.stockCfg();
    if (!stock) return { ok: false, msg: '股票不存在' };
    const have = C.stockShares(s, stock.id);
    if (have <= 0) return { ok: false, msg: '该股票没有持仓' };
    const want = (!shares || shares <= 0) ? have : Math.min(have, Math.floor(Number(shares) || 0));
    if (!(want > 0)) return { ok: false, msg: '数量必须大于 0' };

    const nat = C.stockNaturalPrice(s, stock);
    const impact = C.stockImpactAt(s, stock, have - want, C.stockFlow(s, stock.id) - want);
    const unitPrice = nat.mul(impact);
    const gross = unitPrice.mul(want);
    const fee = gross.mul(C.stockFee(s));
    return {
      ok: true, shares: want, unitPrice: unitPrice, gross: gross, fee: fee,
      net: gross.sub(fee), impact: impact, natural: nat,
      tooSmall: gross.lt(new D(cfg.minOrder || 0)),
    };
  }

  /**
   * 当前金钱最多能买多少股（0 = 一股都买不起）。
   *
   * 报价对股数是单调不减的（冲击有上限，涨到顶后就变成线性），所以用二分查找。
   * 查完再往回退几步兜住浮点边界，保证「最大」按钮给出的数字一定真的买得起。
   */
  C.stockMaxBuy = function stockMaxBuy(s, stock) {
    if (!stock) return 0;
    const depth = C.stockDepth(stock);
    const have = C.stockShares(s, stock.id);
    let lo = 0;
    let hi = Math.max(0, depth - have);
    if (hi <= 0) return 0;
    // 自然价与手续费在整个二分过程中不变 —— 提出来，别在每次迭代里重算
    const nat = C.stockNaturalPrice(s, stock);
    const feeRate = C.stockFee(s);
    const cfg = C.stockCfg();
    const q1 = C.stockBuyQuoteWith(s, stock, 1, nat, feeRate, cfg);
    if (!q1.ok || q1.total.gt(s.money)) return 0;

    let guard = 0;
    while (lo < hi && guard++ < 64) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const q = C.stockBuyQuoteWith(s, stock, mid, nat, feeRate, cfg);
      if (q.ok && q.total.lte(s.money)) lo = mid;
      else hi = mid - 1;
    }
    guard = 0;
    while (lo > 0 && guard++ < 8) {
      const q = C.stockBuyQuoteWith(s, stock, lo, nat, feeRate, cfg);
      if (q.ok && q.total.lte(s.money)) break;
      lo -= 1;
    }
    return lo;
  }

  // ---------- 成交 ----------

  C.buyStock = function buyStock(s, stockId, shares) {
    const stock = C.stockById(stockId);
    if (!stock) return { ok: false, msg: '股票不存在' };
    if (!C.stockUnlocked(s)) return { ok: false, msg: C.stockLockedReason(s) };
    if (!C.stockAccessible(s, stock)) return { ok: false, msg: C.stockAccessReason(s, stock) };

    const q = C.stockBuyQuote(s, stock, shares);
    if (!q.ok) return q;
    if (q.tooSmall) {
      return { ok: false, msg: '单笔成交额不足 ' + C.fmtBig(C.stockCfg().minOrder || 0) };
    }
    if (q.total.gt(s.money)) return { ok: false, msg: '金钱不足' };

    const c = s.stock;
    s.money = s.money.sub(q.total);
    c.shares[stock.id] = C.stockShares(s, stock.id) + q.shares;
    c.flow[stock.id] = C.stockFlow(s, stock.id) + q.shares;
    c.cost[stock.id] = C.stockCost(s, stock.id).add(q.total);
    c.totalFee = c.totalFee.add(q.fee);
    c.totalTrades += 1;

    return {
      ok: true, stockId: stock.id, shares: q.shares, unitPrice: q.unitPrice,
      gross: q.gross, fee: q.fee, total: q.total, impact: q.impact,
      sharesAfter: c.shares[stock.id],
    };
  }

  C.sellStock = function sellStock(s, stockId, shares) {
    const stock = C.stockById(stockId);
    if (!stock) return { ok: false, msg: '股票不存在' };
    const have = C.stockShares(s, stock.id);
    if (have <= 0) return { ok: false, msg: '该股票没有持仓' };

    const q = C.stockSellQuote(s, stock, shares);
    if (!q.ok) return q;
    if (q.tooSmall) {
      return { ok: false, msg: '单笔成交额不足 ' + C.fmtBig(C.stockCfg().minOrder || 0) };
    }

    const c = s.stock;
    const avg = C.stockAvgCost(s, stock.id);
    const costOut = avg.mul(q.shares);
    const left = have - q.shares;

    s.money = s.money.add(q.net);
    c.shares[stock.id] = left;
    c.flow[stock.id] = C.stockFlow(s, stock.id) - q.shares;
    // 清仓时成本必须精确归零，否则残留的零头会让下次开仓的均价算歪
    c.cost[stock.id] = left > 0 ? C.stockCost(s, stock.id).sub(costOut) : new D(0);
    if (c.cost[stock.id].isNeg()) c.cost[stock.id] = new D(0);
    c.totalFee = c.totalFee.add(q.fee);
    c.totalTrades += 1;
    c.realized = c.realized.add(q.net.sub(costOut));

    return {
      ok: true, stockId: stock.id, shares: q.shares, unitPrice: q.unitPrice,
      gross: q.gross, fee: q.fee, net: q.net, impact: q.impact,
      costOut: costOut, profit: q.net.sub(costOut), sharesAfter: left,
    };
  }

  /**
   * 股市结算 —— 只在股票跨越「期」边界时执行：把上期的净买入流按 flowDecay 衰减。
   *
   * 为什么必须衰减：冲击是「你自己把价格推歪了多少」的度量。如果它永不消退，
   * 那么「买入 → 等价格维持在高位 → 卖出」就能白赚一笔冲击溢价。每期衰减保证了
   * 这笔溢价一定会退回去，于是任何一轮买→卖都只会亏掉溢价 + 双边手续费。
   *
   * @returns {object|null} 本次结算的汇总
   */
  C.syncStocks = function syncStocks(s) {
    const cfg = C.stockCfg();
    if (!cfg.implemented) return null;
    if (!s || !s.stock) return null;

    const c = s.stock;
    const d = C.stockFlowDecay();
    const acc = { stocks: 0, peak: 0, settled: {} };

    for (const st of GAME.stock.stocks) {
      const cur = C.stockPeriod(st, C.marketClock(s));
      const last = Math.max(0, Math.floor((c.lastPeriod && c.lastPeriod[st.id]) || 0));
      if (cur <= last) continue;

      const n = cur - last;
      const depth = C.stockDepth(st);
      let f = C.stockFlow(s, st.id) * Math.pow(d, n);
      if (!Number.isFinite(f)) f = 0;
      // 股数取整：flow 是「多少股」的计数，小数股没有意义，也会留下永不消失的尾巴
      f = Math.trunc(f);
      if (f > depth) f = depth;
      if (f < -depth) f = -depth;

      c.flow[st.id] = f;
      c.lastPeriod[st.id] = cur;

      acc.stocks += 1;
      const im = C.stockImpact(s, st);
      acc.settled[st.id] = { flow: f, impact: im, periods: n };
      const dev = Math.abs(im - 1);
      if (dev > acc.peak) acc.peak = dev;
    }
    return acc;
  }

  /** 股市概览（前端与接口层共用），尽量返回可直接序列化的普通值 */
  C.stockSummary = function stockSummary(s) {
    const cfg = C.stockCfg();
    if (!cfg.implemented) return null;
    if (!s || !s.stock) return null;

    const c = s.stock;
    let peak = 0;
    const list = GAME.stock.stocks.map((st) => {
      const price = C.stockPrice(s, st);
      const natural = C.stockNaturalPrice(s, st);
      const impact = C.stockImpact(s, st);
      const dev = Math.abs(impact - 1);
      if (dev > peak) peak = dev;

      const shares = C.stockShares(s, st.id);
      const cost = C.stockCost(s, st.id);
      const value = price.mul(shares);
      const pnl = shares > 0 ? value.sub(cost) : new D(0);
      const period = C.stockPeriod(st, C.marketClock(s));

      // 「清仓可变现」——按真实卖出的报价算（含冲击与手续费）。
      // 它一定小于等于按现价算的市值：市值里含着你自己的买入冲击溢价，
      // 而这份溢价在你卖的时候会被自己砸回去，拿不到手。所以盈亏要按可变现口径看。
      const liq = shares > 0 ? C.stockSellQuote(s, st, shares) : null;

      return {
        id: st.id, name: st.name, code: st.code, link: st.link || null,
        kind: st.kind || 'tech', sector: st.sector || null, business: st.business || '',
        basePrice: st.basePrice, depth: C.stockDepth(st),
        periodSeconds: C.stockPeriodSeconds(st),
        period: period, nextPeriod: period + 1,
        price: price, naturalPrice: natural,
        /** 市值 = 现价 × 流通盘 —— 榜单排序的依据 */
        marketCap: price.mul(C.stockDepth(st)),
        impact: impact, impactPct: impact - 1,
        shares: shares, heldRatio: C.stockHeldRatio(s, st),
        cost: cost, avgCost: C.stockAvgCost(s, st.id),
        value: value, pnl: pnl,
        pnlRatio: (shares > 0 && cost.gt(0)) ? pnl.div(cost).toNumber() : 0,
        liquidateValue: liq ? liq.net : new D(0),
        liquidatePnl: liq ? liq.net.sub(cost) : new D(0),
        liquidateImpact: liq ? liq.impact : 1,
        flow: C.stockFlow(s, st.id),
        trend: C.stockTrend(s, st),
        nextChangeIn: C.stockNextChangeIn(st, C.marketClock(s)),
        maxBuy: C.stockMaxBuy(s, st),
        unlocked: C.stockAccessible(s, st),
      };
    });

    let totalValue = new D(0);
    let totalCost = new D(0);
    let liquidateValue = new D(0);
    for (const x of list) {
      totalValue = totalValue.add(x.value);
      totalCost = totalCost.add(x.cost);
      liquidateValue = liquidateValue.add(x.liquidateValue);
    }
    const pnlAll = totalValue.sub(totalCost);
    const liquidatePnl = liquidateValue.sub(totalCost);

    // 榜单：按市值降序取前 N 家。界面只列这 10 家 ——
    // 但**交易对全部开放**（接口按 id 找，不在榜上也能买），
    // 否则「想买的刚好掉出前十」会变成硬性阻断，而榜单本就该随行情换人。
    // v3.6：**未解锁的个股不进榜**（融合赛道 50 家元婴后才上板），
    // 锁定行在列表里灰显展示、标注解锁条件。
    const boardSize = Math.max(1, Math.floor(cfg.boardSize || 10));
    const board = list.filter((x) => x.unlocked).slice().sort((a, b) => {
      if (b.marketCap.gt(a.marketCap)) return 1;
      if (b.marketCap.lt(a.marketCap)) return -1;
      return a.id < b.id ? -1 : 1;
    }).slice(0, boardSize);

    return {
      fee: C.stockFee(s),
      minOrder: cfg.minOrder || 0,
      flowDecay: C.stockFlowDecay(),
      maxRise: cfg.maxRise || 0,
      maxDrop: cfg.maxDrop || 0,
      illiquidity: cfg.illiquidity || 0,
      floor: cfg.floor || 0,
      linkWeight: cfg.linkWeight || 0,
      peak: peak,
      boardSize: boardSize,
      totalListed: list.length,
      totalValue: totalValue,
      totalCost: totalCost,
      pnl: pnlAll,
      pnlRatio: totalCost.gt(0) ? pnlAll.div(totalCost).toNumber() : 0,
      liquidateValue: liquidateValue,
      liquidatePnl: liquidatePnl,
      liquidatePnlRatio: totalCost.gt(0) ? liquidatePnl.div(totalCost).toNumber() : 0,
      realized: c.realized,
      totalFee: c.totalFee,
      totalTrades: c.totalTrades,
      /** 全部上市公司（交易用，前端可从这里做搜索/详情） */
      stocks: list,
      /** 市值前 N 家（界面列表用） */
      board: board,
      unlocked: C.stockUnlocked(s),
      lockedReason: C.stockLockedReason(s),
    };
  }

  /** 股市单边手续费 = 基础 0.5% − 道行 · 市场人脉（保底 0.01%） */
  C.stockFee = function stockFee(s) {
    const base = C.num(C.stockCfg().fee, 0.005);
    const v = base - C.perkValue(s, 'marketFee');
    return v > 0.0001 ? v : 0.0001;
  }

  return C;
});
