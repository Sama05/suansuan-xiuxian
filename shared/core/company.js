/**
 * game-core · company —— 公司与市场：确定性价格、行业上下游传导（记忆化）、市场抛压、生产线（每台独立配置 + 优先生产 + 工业算力两级分配）、周期结算。
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
  // 公司（产业）系统
  // ============================================================
  //
  // 与「工作」的分工：
  //   工作 = 职业 → 别人雇你，单次收益固定，消耗精力，随游戏内时间推进。
  //   公司 = 产业 → 自己生产商品、自己卖，收益随市价浮动，**不消耗精力**，
  //                但每周期扣维护费（原料 + 人工），仓库满了会压货停产。
  //
  // 生产周期挂在**现实时间**上（与精力同理），因此它是一条与时间档位解耦的
  // 产能上限：拉满档位不会让公司多产一分钱，只会让工作更强。
  //
  // 市价的关键约束：**必须可确定性复现**。
  // 前端每 100ms tick 一次、后端离线一次性结算 48 小时，两边都要算出同一个价格，
  // 否则「屏幕上看到的钱」和「服务器存的钱」就会对不上。所以这里不用 Math.random，
  // 而是把 (商品序号, 期数) 喂进一个散列函数 —— 同一个输入永远得到同一个价格。

  C.companyCfg = function companyCfg() { return GAME.company; }

  C.lineById = function lineById(id) {
    if (!id) return null;
    return GAME.company.lines.find((l) => l.id === id) || null;
  }

  // 配置查表缓存：goods / industries 在加载后不可变，Map 一次建好。
  // goodById / goodIndex 在最热的路径上（每个 unitOutput、每次 goodsPriceFactor
  // 都要按 id 查表），线性 find 在 288 件商品下是 O(n²) 的隐形大头。
  let _goodMap = null;
  let _goodIdx = null;
  function goodMap() {
    if (!_goodMap) {
      _goodMap = new Map();
      _goodIdx = new Map();
      GAME.company.goods.forEach((g, i) => { _goodMap.set(g.id, g); _goodIdx.set(g.id, i); });
    }
    return _goodMap;
  }

  C.goodById = function goodById(id) {
    if (!id) return null;
    return goodMap().get(id) || null;
  }

  C.goodIndex = function goodIndex(id) {
    if (!id) return -1;
    goodMap();
    return _goodIdx.has(id) ? _goodIdx.get(id) : -1;
  }


  /** 商品在指定期数下的「相对基准价倍数」 */
  C.goodsPriceFactor = function goodsPriceFactor(good, period) {
    // 第 0 期 = 开市，直接按基准价挂牌 —— 否则配置里的 basePrice 就不是玩家
    // 第一眼看到的价格，调数值时会失去参照。
    if (period <= 0) return 1;
    const i = C.goodIndex(good.id);
    const noise = C.hash01(period * 1.7 + i * 3.1 + 0.5) * 2 - 1;  // 当期噪声
    const drift = C.hash01(period * 0.37 + i * 7.3) * 2 - 1;       // 慢漂移
    const wave = Math.sin((period + i * 2.4) * 0.9);             // 周期波动
    let f = 1 + good.volatility * (0.5 * noise + 0.3 * wave + 0.2 * drift);
    const lo = good.minFactor || 0.2;
    const hi = good.maxFactor || 5;
    if (f < lo) f = lo;
    if (f > hi) f = hi;
    return f;
  }


  /** 商品的变价周期（**现实秒**）：科技类 60 秒，修仙类 600 秒 */
  C.goodsPeriodSeconds = function goodsPeriodSeconds(good) {
    return Math.max(1, good.periodSeconds || 60);
  }

  /** 商品当前处于第几期（按现实时间推进，与时间档位无关） */
  C.goodsPeriod = function goodsPeriod(good, realSeconds) {
    return Math.floor(Math.max(0, realSeconds || 0) / C.goodsPeriodSeconds(good));
  }

  /** 商品当前市价 */
  C.goodsPrice = function goodsPrice(good, realSeconds) {
    if (!good) return new D(0);
    return new D(good.basePrice).mul(C.goodsPriceFactor(good, C.goodsPeriod(good, realSeconds)));
  }

  /** 相对上一期的涨跌：'up' / 'down' / 'flat' */
  C.goodsTrend = function goodsTrend(good, realSeconds) {
    const p = C.goodsPeriod(good, realSeconds);
    if (p <= 0) return 'flat';
    const cur = C.goodsPriceFactor(good, p);
    const prev = C.goodsPriceFactor(good, p - 1);
    if (cur > prev * 1.004) return 'up';
    if (cur < prev * 0.996) return 'down';
    return 'flat';
  }

  /** 距下次变价还剩多少现实秒 */
  C.goodsNextChangeIn = function goodsNextChangeIn(good, realSeconds) {
    const len = C.goodsPeriodSeconds(good);
    const rem = Math.max(0, realSeconds || 0) % len;
    return len - rem;
  }

  /**
   * 取商品在 [fromPeriod, toPeriod] 内每一期的挂牌价。
   *
   * 价格是「期数」的确定性函数（goodsPriceFactor 不含随机数），所以历史和未来
   * 都能直接算出来 —— 前端画走势图不需要另存任何历史数据，也不会因为刷新而
   * 出现线条断档。第 0 期固定为基准价（开市）。
   *
   * @returns {Array<{period:number, price:Decimal, t:number}>} 按时间升序，含首尾
   */
  C.goodsSeries = function goodsSeries(good, fromPeriod, toPeriod) {
    if (!good) return [];
    const a = Math.max(0, Math.floor(fromPeriod));
    const b = Math.max(a, Math.floor(toPeriod));
    const len = C.goodsPeriodSeconds(good);
    const out = [];
    for (let p = a; p <= b; p++) {
      out.push({
        period: p,
        price: new D(good.basePrice).mul(C.goodsPriceFactor(good, p)),
        /** 该期起点的时间戳（现实秒，与 marketClock 同口径） */
        t: p * len,
      });
    }
    return out;
  }

  /**
   * 走势窗口的期数范围：以 cur 为中心、向前 past 期、向后 future 期。
   *
   * 「窗口退化成单期时向后补一期」是开局边界的关键：修仙类商品每 600 现实秒
   * 才变一次价，游戏刚开始时序列里只有「第 0 期」一个点，连不成线，折线图会
   * 整个空白 —— 补一期才有从基准价出发的线段。商品与股票的窗口共用这一个函数。
   */
  C.windowRange = function windowRange(cur, past, future) {
    const from = Math.max(0, cur - (past || 0));
    let to = cur + (future || 0);
    if (to <= from) to = from + 1;
    return { from: from, to: to };
  }

  /**
   * 以当前时间为基准，取前 past 期 ~ 后 future 期的走势（含当前期）。
   */
  C.goodsWindow = function goodsWindow(good, realSeconds, past, future) {
    const w = C.windowRange(C.goodsPeriod(good, realSeconds), past, future);
    return C.goodsSeries(good, w.from, w.to);
  }

  // ============================================================
  // 市场抛压 —— 「卖得多，价格被压低」的反噬
  // ============================================================
  //
  // 与 goodsPriceFactor 一样是**纯确定性**的：只读存档里的卖出/产出计数，
  // 不使用随机数。前端 tick 与后端离线结算必须算出同一个价格。
  //
  // 语义链：
  //   本期卖出 > 本期产出  →  差额是「净抛售」（动用库存 / 停售囤货后集中出货）
  //   净抛售 ÷ 参考成交量  →  本期新增压力 add
  //   压力在**期切换时**结算   →  当期卖出的货，影响的是**下一期**的开市价
  //   之后每期按 decay 衰减   →  砸盘的影响会过去，价格会爬回来

  C.marketCfg = function marketCfg() { return GAME.company.market || {}; }

  C.marketDecay = function marketDecay() {
    const d = C.marketCfg().decay;
    return (typeof d === 'number' && d >= 0 && d <= 1) ? d : 0.5;
  }

  /** 某商品当前生效的抛压（0 ~ 1） */
  C.pressureOf = function pressureOf(s, goodId) {
    const m = (s && s.company && s.company.pressure) || {};
    const v = Number(m[goodId]);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v > 1 ? 1 : v;
  }

  /** 本期净抛售件数 = max(0, 本期卖出 − 本期产出)。正常清仓时为 0。 */
  C.excessSold = function excessSold(s, goodId) {
    const c = (s && s.company) || {};
    const sold = (c.soldThisPeriod && c.soldThisPeriod[goodId]) || 0;
    const prod = (c.producedThisPeriod && c.producedThisPeriod[goodId]) || 0;
    return Math.max(0, sold - prod);
  }

  /**
   * 把本期净抛售换算成压力增量（0 ~ 1）。
   *
   * @param {number} periods 本次结算跨越了几期（在线通常为 1，离线可能很大）。
   *
   * 为什么要除以 periods：计数器**只在期切换时才清零**，所以离线一次跨 n 期时，
   * 卖出/产出都是「n 期的累计量」。如果直接拿累计量相减，会出现一个致命漏洞 ——
   * 囤满 n 期再一次性清仓，卖出 ≈ 产出，净抛售约等于 0，砸盘反而**不受罚**。
   * 按期末均摊之后，「每期净抛售」才是真正的信号。
   *
   * 分母取 max(baseVolume, 每期产出)：产能越大，市场对正常吞吐量的预期越高，
   * 同样多的净抛售反而压不动价格 —— 这是「扩张产能不自我惩罚」的关键。
   */
  C.pressureAdd = function pressureAdd(s, goodId, periods) {
    const c = (s && s.company) || {};
    const n = Math.max(1, periods || 1);
    const sold = ((c.soldThisPeriod && c.soldThisPeriod[goodId]) || 0) / n;
    const prod = ((c.producedThisPeriod && c.producedThisPeriod[goodId]) || 0) / n;
    const excess = Math.max(0, sold - prod);
    const ref = Math.max(1, C.marketCfg().baseVolume || 0, prod);
    const add = excess / ref;
    return add > 1 ? 1 : add;
  }

  /**
   * 指定「期」的抛压系数（maxDrop 之下，1 = 不受影响）。
   *
   *   过去期  → 1（历史价不可考，按自然价展示）
   *   当前期  → 实际压力
   *   未来期  → 压力按 decay 逐期恢复
   *
   * 未来期做衰减推算，是为了让折线图能直接告诉玩家「砸完这一刀之后，
   * 价格大概什么时候爬回来」。
   */
  C.marketImpactAt = function marketImpactAt(s, good, period) {
    const pr = C.pressureOf(s, good.id);
    if (pr <= 0) return 1;
    const cur = C.goodsPeriod(good, C.marketClock(s));
    if (period < cur) return 1;
    const eff = pr * Math.pow(C.marketDecay(), period - cur);
    const impact = 1 - eff * (C.marketCfg().maxDrop || 0);
    return impact < 0 ? 0 : impact;
  }

  /** 综合价格下限（相对基准价），兜住「自然波动下限 × 抛压下限」的叠加 */
  C.marketFloorPrice = function marketFloorPrice(good) {
    return new D(good.basePrice).mul(C.marketCfg().floor || 0);
  }

  /**
   * 不受抛压影响的「自然价」（界面上用来对比「本应值多少」）。
   *
   *   自然价 = 基准价 × 行情波动因子 × 行业传导指数
   *
   * 第三项是产业链传导：上游行业的商品涨了，本行业的售价按 pricePass 打折跟涨。
   * 传 s 才会算传导（不传就只算行情，用于纯价格序列推导）。
   * realSeconds 省略时按 0 算（第 0 期 = 开市价）。
   */
  C.naturalPrice = function naturalPrice(good, realSeconds, s) {
    if (!good) return new D(0);
    const t = (realSeconds === undefined || realSeconds === null) ? 0 : realSeconds;
    const base = new D(good.basePrice).mul(C.goodsPriceFactor(good, C.goodsPeriod(good, t)));
    if (!s) return base;
    return base.mul(C.industryPriceIndex(s, good.industry));
  }

  /** 带上抛压与行业传导之后的市价 —— 前端展示与结算都应该用这个 */
  C.goodsPriceWith = function goodsPriceWith(s, good, realSeconds) {
    if (!good) return new D(0);
    const t = (realSeconds === undefined || realSeconds === null)
      ? C.marketClock(s) : realSeconds;
    const period = C.goodsPeriod(good, t);
    const natural = new D(good.basePrice).mul(C.goodsPriceFactor(good, period))
      .mul(s ? C.industryPriceIndex(s, good.industry) : 1);
    const price = natural.mul(C.marketImpactAt(s, good, period));
    const floor = C.marketFloorPrice(good);
    return price.lt(floor) ? floor : price;
  }

  /** 抛压造成的折价比例（0 ~ maxDrop），前端标色用 */
  C.marketDropRatio = function marketDropRatio(s, good) {
    // 必须带 s：自然价含行业传导，不传 s 会算出「没有传导的自然价」，
    // 折价率就不再是纯粹的抛压幅度了。
    const natural = C.naturalPrice(good, C.marketClock(s), s);
    if (natural.lte(0)) return 0;
    const now = C.goodsPriceWith(s, good);
    const r = natural.sub(now).div(natural).toNumber();
    return r > 0 ? r : 0;
  }

  /** 带抛压的价格序列（折线图用），多返回一个 impact 字段 */
  C.goodsSeriesWith = function goodsSeriesWith(s, good, fromPeriod, toPeriod) {
    if (!good) return [];
    const a = Math.max(0, Math.floor(fromPeriod));
    const b = Math.max(a, Math.floor(toPeriod));
    const len = C.goodsPeriodSeconds(good);
    const floor = C.marketFloorPrice(good);
    const out = [];
    // 行业传导是当前时刻的成本结构，不随期数变化 —— 所以整条序列乘同一个指数。
    // 这一步不能省：否则走势图上的当前点会和卡片上的标价对不上。
    const indIdx = s ? C.industryPriceIndex(s, good.industry) : 1;
    for (let p = a; p <= b; p++) {
      const impact = C.marketImpactAt(s, good, p);
      let price = new D(good.basePrice).mul(C.goodsPriceFactor(good, p)).mul(indIdx).mul(impact);
      if (price.lt(floor)) price = floor;
      out.push({ period: p, price: price, t: p * len, impact: impact });
    }
    return out;
  }

  /** 以当前期为基准、前后各若干期的带抛压走势 */
  C.goodsWindowWith = function goodsWindowWith(s, good, past, future) {
    const w = C.windowRange(C.goodsPeriod(good, C.marketClock(s)), past, future);
    return C.goodsSeriesWith(s, good, w.from, w.to);
  }

  /**
   * 市场抛压结算 —— 只在商品跨越「期」边界时执行。
   *
   * 为什么必须等到期切换：语义上「本期卖出」影响的是**下一期**的价格。
   * 玩家当期砸盘，当期成交价不变，下一期开市才发现被自己打下来了。
   *
   * 跨 n 期（离线常见）时的公式：
   *     add      = 每期净抛售 ÷ max(baseVolume, 每期产出)      ← 计数按 n 均摊
   *     pressure = pressure × decay^n + add × decay^(n-1)
   * add 只在跨越的第一期生效，之后每期只衰减。
   *
   * 「按 n 均摊」这一步不能省，理由见 pressureAdd 的注释 —— 否则囤货后清仓
   * 会因为「卖出 ≈ 产出」而被判定为没砸盘，反噬机制直接失效。
   *
   * 注意是「求和再夹到 1」，不是「取大值」—— 连续多期净抛售会累积，
   * 但上限就是满档，不会无限叠加。
   *
   * @returns {object|null} 本次结算的汇总
   */
  C.syncMarket = function syncMarket(s) {
    if (!C.companyFounded(s)) return null;
    const c = s.company;
    const d = C.marketDecay();
    const acc = { goods: 0, peak: 0, settled: {} };

    for (const g of GAME.company.goods) {
      const cur = C.goodsPeriod(g, C.marketClock(s));
      const last = Math.max(0, Math.floor((c.lastPeriod && c.lastPeriod[g.id]) || 0));
      if (cur <= last) continue;

      const n = cur - last;
      const old = C.pressureOf(s, g.id);
      const add = C.pressureAdd(s, g.id, n);
      let pr = old * Math.pow(d, n) + add * Math.pow(d, n - 1);
      if (!(pr > 0)) pr = 0;
      if (pr > 1) pr = 1;

      c.pressure[g.id] = pr;
      c.lastPeriod[g.id] = cur;
      // 本期计数清零，开始为**下一期**重新累积
      c.soldThisPeriod[g.id] = 0;
      c.producedThisPeriod[g.id] = 0;

      acc.goods += 1;
      acc.settled[g.id] = { pressure: pr, add: add, periods: n };
      if (pr > acc.peak) acc.peak = pr;
    }
    // 记录历史最高抛压（只增不减）——「操控市场」类功法成就的达成凭据
    if (acc.peak > (c.peakPressure || 0)) c.peakPressure = acc.peak;
    if (acc.goods > 0) C.bumpMarketVer();            // 抛压变了 → 传导缓存作废
    return acc;
  }

  /** 市场概览（前端与接口层共用），尽量返回可直接序列化的普通值 */
  C.marketSummary = function marketSummary(s) {
    if (!C.companyFounded(s)) return null;
    const m = C.marketCfg();
    const d = C.marketDecay();
    let peak = 0;
    const goods = GAME.company.goods.map((g) => {
      const p = C.pressureOf(s, g.id);
      if (p > peak) peak = p;
      const drop = C.marketDropRatio(s, g);
      const period = C.goodsPeriod(g, C.marketClock(s));
      // 当前「未结算窗口」跨了几期 —— 用来把累计计数换算成每期均值
      const win = Math.max(1, period - Math.max(0, Math.floor((s.company.lastPeriod && s.company.lastPeriod[g.id]) || 0)));
      const soldRaw = (s.company.soldThisPeriod && s.company.soldThisPeriod[g.id]) || 0;
      const prodRaw = (s.company.producedThisPeriod && s.company.producedThisPeriod[g.id]) || 0;
      return {
        id: g.id,
        name: g.name,
        pressure: p,
        dropRatio: drop,
        impact: 1 - drop,
        // 每期净抛售（正数 = 在砸库存）
        excess: Math.max(0, soldRaw / win - prodRaw / win),
        soldThisPeriod: soldRaw,
        producedThisPeriod: prodRaw,
        windowPeriods: win,
        // 抛压完全恢复到可忽略还需要几期
        recoverIn: p > 0 && d > 0 && d < 1 ? Math.ceil(Math.log(0.02) / Math.log(d)) : 0,
        price: C.goodsPriceWith(s, g),
        naturalPrice: C.naturalPrice(g, C.marketClock(s), s),
        nextPeriod: period + 1,
      };
    });
    return {
      peak: peak,
      warn: peak >= (m.warnAt || 0.45),
      maxDrop: m.maxDrop || 0,
      decay: d,
      floor: m.floor || 0,
      goods: goods,
    };
  }

  // ---------- 公司状态 ----------

  C.companyFounded = function companyFounded(s) {
    return !!(s.company && s.company.founded);
  }

  /** 是否达到「可以注册公司」的门槛（不含注册费是否够） */
  C.companyUnlocked = function companyUnlocked(s) {
    if (!GAME.company.implemented) return false;
    const need = GAME.company.unlock || {};
    return s.realm >= (need.realm || 0);
  }

  /** 不能注册 / 不能经营的原因（前端展示用） */
  C.companyLockedReason = function companyLockedReason(s) {
    if (!GAME.company.implemented) return '公司系统未开放';
    if (C.companyFounded(s)) return '';
    const need = GAME.company.unlock || {};
    if (s.realm < (need.realm || 0)) return '需达到「' + C.realmName(need.realm) + '」';
    if (s.money.lt(new D(GAME.company.foundCost))) {
      return '注册需金钱 ' + C.fmtBig(GAME.company.foundCost);
    }
    return '';
  }

  C.warehouseLevel = function warehouseLevel(s) {
    return Math.max(0, Math.floor((s.company && s.company.warehouseLevel) || 0));
  }

  /** 仓库容量（件） */
  C.warehouseCapacity = function warehouseCapacity(s) {
    const w = GAME.company.warehouse;
    const lv = Math.min(w.maxLevel, C.warehouseLevel(s));
    return w.baseCapacity + lv * w.perLevel;
  }

  /** 下一级仓库的升级价格（已满级返回 0） */
  C.warehouseCost = function warehouseCost(s) {
    const w = GAME.company.warehouse;
    const lv = C.warehouseLevel(s);
    if (lv >= w.maxLevel) return new D(0);
    return new D(w.baseCost).mul(D.pow(new D(w.costGrowth), lv));
  }

  /** 库存总件数 */
  C.stockTotal = function stockTotal(s) {
    if (!s.company) return 0;
    let n = 0;
    for (const g of GAME.company.goods) n += (s.company.stock[g.id] || 0);
    return n;
  }

  C.stockOf = function stockOf(s, goodId) {
    return (s.company && s.company.stock[goodId]) || 0;
  }

  /** 生产线是否已解锁（境界 + 前置生产线数量） */
  C.lineUnlocked = function lineUnlocked(s, line) {
    if (!line || !C.companyFounded(s)) return false;
    if (s.realm < (line.realm || 0)) return false;
    const after = line.after;
    if (after && C.lineOwned(s, after.id) < after.times) return false;
    return true;
  }

  C.lineLockedReason = function lineLockedReason(s, line) {
    if (!line) return '';
    if (!C.companyFounded(s)) return '尚未成立公司';
    if (s.realm < (line.realm || 0)) return '需达到「' + C.realmName(line.realm) + '」';
    const after = line.after;
    if (after && C.lineOwned(s, after.id) < after.times) {
      const prev = C.lineById(after.id);
      return '需先拥有 ' + (prev ? prev.name : after.id) + ' ×' + after.times;
    }
    return '';
  }

  /** 买下第 n 条生产线的价格（按已有数量递增） */
  C.lineCost = function lineCost(s, line) {
    if (!line) return new D(0);
    const owned = C.lineOwned(s, line.id);
    return new D(line.cost).mul(D.pow(new D(line.costGrowth), owned));
  }

  // ============================================================
  // 行业 · 生产线 · 工业算力
  // ============================================================
  //
  // 生产线不再绑定单一产物：一条线对应一个行业，可以随时改产这个行业的任意产物，
  // 也可以单独调这条线的产能。产能决定它占用多少算力、产多少货 —— 于是
  // 「买线」只是拿到产能上限，真正让它转起来的是**算力**。
  //
  // 存档结构：
  //   company.lines[lineId] = { units: [ { p: 产物id, r: 产能0~1 }, ... ] }
  // units 的长度就是这条线买了几台，**每台独立配置**（对应「单独调整每一台」）。

  C.industryById = function industryById(id) {
    if (!id) return null;
    return GAME.company.industries.find((x) => x.id === id) || null;
  }

  /** 某行业的全部产物 */
  C.goodsOfIndustry = function goodsOfIndustry(industryId) {
    return GAME.company.goods.filter((g) => g.industry === industryId);
  }

  /** 某条生产线能造的产物 —— 就是它所属行业的全部产物 */
  C.lineProducts = function lineProducts(line) {
    if (!line) return [];
    return C.goodsOfIndustry(line.industry);
  }

  C.lineIndustry = function lineIndustry(line) {
    return line ? C.industryById(line.industry) : null;
  }

  // ---------- 成本传导 ----------
  //
  // 上游行业的商品涨了 → 本行业的成本按 passThrough 涨、售价只按 pricePass 涨。
  // pricePass 恒小于 passThrough，于是上游一涨，本行业「售价涨得比成本慢」，
  // 毛利被压缩。矿价暴涨时钢锭也贵，但炼钢厂反而更不赚钱 —— 这就是联动的体感。
  //
  // 上下游是按 tier 递增的有向无环图，所以递归一定终止；这里仍加一层深度守卫，
  // 防止配置写错（出现环）时把整个 tick 拖成栈溢出。

  /** 传导链上最多向上展开几层（超出就按「无传导」= 1 处理） */
  const IND_MAX_DEPTH = 8;

  /**
   * 传导缓存。
   *
   * 三个约束叠在一起，才把这条链从「指数级」压成「常数级」：
   *
   * 1. **必须显式传行业指数**（v3.2 的旧结论）：不能直接调 `goodsPriceWith`，
   *    否则它会再算回本行业的指数，每层展开「6 件商品 × 上游数」。
   * 2. **深度预算必须按「剩余层数」传参，不能用全局计数器**：这条调用链是
   *    ratio → index → upstreamRatio → ratio 的互递归，全局守卫管不到 index 那一环。
   *    融合产业链是 36 层串联，守卫一失效就是每层 ×上游数 的爆炸
   *    （v3.6 实测：第 24 只融合股单次推导 39 秒）。
   * 3. **按 (行业, 剩余层数) 记忆化**：状态空间只有 行业数 × 9，
   *    再深的链也只是把每个格子算一次 —— 指数级退化成线性。
   *
   * 缓存的失效条件是「行情时钟 + 抛压版本号」，两者任一变化就整体清空。
   */
  // 按 state 分桶（WeakMap），杜绝「A 玩家的缓存被 B 玩家读到」；
  // 桶内再按「行情时钟 + 抛压版本号」失效。
  let _indMemoStore = new WeakMap();
  /** 抛压版本号：凡是改了 s.company.pressure 的地方都要 C.bumpMarketVer() */
  let _mktVer = 0;
  /** 抛压版本号读数（股票价格缓存的失效键之一；跨模块经 C.mktVer() 取） */
  C.mktVer = function () { return _mktVer; };
  C.bumpMarketVer = function bumpMarketVer() { _mktVer += 1; }
  C.indMemo = function indMemo(s) {
    const k = C.marketClock(s) + '|' + _mktVer;
    let e = (s && typeof s === 'object') ? _indMemoStore.get(s) : null;
    if (!e) {
      e = { key: '', map: new Map() };
      if (s && typeof s === 'object') _indMemoStore.set(s, e);
    }
    if (e.key !== k) { e.map.clear(); e.key = k; }
    return e.map;
  }

  /**
   * 某行业当前的「价格倍数」= 该行业全部商品 现价/基准价 的平均值（1 = 平价）。
   * rem = 还能向上展开的层数。
   */
  C.industryPriceRatio = function industryPriceRatio(s, industryId) {
    return C.industryRatioAt(s, industryId, IND_MAX_DEPTH);
  }

  C.industryRatioAt = function industryRatioAt(s, industryId, rem) {
    const list = C.goodsOfIndustry(industryId);
    if (!list.length) return 1;
    if (rem <= 0) return 1;
    const memo = C.indMemo(s);
    const key = 'R|' + industryId + '|' + rem;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const index = C.industryPassIndexAt(s, industryId, rem, 'pricePass', 'I');
    let sum = 0;
    for (const g of list) {
      const period = C.goodsPeriod(g, C.marketClock(s));
      let p = new D(g.basePrice)
        .mul(C.goodsPriceFactor(g, period))
        .mul(index)
        .mul(C.marketImpactAt(s, g, period));
      const floor = C.marketFloorPrice(g);
      if (p.lt(floor)) p = floor;
      sum += p.div(new D(g.basePrice)).toNumber();
    }
    const v = sum / list.length;
    memo.set(key, v);
    return v;
  }

  /** 上游综合价格倍数（多个上游行业等权平均） */
  C.industryUpstreamRatio = function industryUpstreamRatio(s, industryId) {
    return C.industryUpstreamRatioAt(s, industryId, IND_MAX_DEPTH);
  }

  C.industryUpstreamRatioAt = function industryUpstreamRatioAt(s, industryId, rem) {
    const ind = C.industryById(industryId);
    if (!ind || !ind.upstream || !ind.upstream.length) return 1;
    let sum = 0;
    for (const up of ind.upstream) sum += C.industryRatioAt(s, up, rem);
    return sum / ind.upstream.length;
  }

  /** 上游涨价 → 本行业**售价**的传导（打折跟涨） */
  C.industryPriceIndex = function industryPriceIndex(s, industryId) {
    return C.industryPassIndexAt(s, industryId, IND_MAX_DEPTH, 'pricePass', 'I');
  }

  /** 上游涨价 → 本行业**成本**的传导（全额上涨，于是毛利被压缩） */
  C.industryCostIndex = function industryCostIndex(s, industryId) {
    return C.industryPassIndexAt(s, industryId, IND_MAX_DEPTH, 'passThrough', 'C');
  }

  /**
   * 传导指数的统一实现：售价链读 `pricePass`、成本链读 `passThrough`，
   * 除「读哪个系数、用哪个缓存前缀」外逐行相同，故收敛于此。
   * `tag` 同时是记忆化的 key 前缀 —— 两条链各占各的格子，不能互相污染。
   */
  C.industryPassIndexAt = function industryPassIndexAt(s, industryId, rem, passKey, tag) {
    const ind = C.industryById(industryId);
    if (!ind) return 1;
    const pass = ind[passKey] || 0;
    if (pass <= 0) return 1;                       // 不跟涨 —— 不必展开上游
    if (rem <= 0) return 1;
    const memo = C.indMemo(s);
    const key = tag + '|' + industryId + '|' + rem;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const up = C.industryUpstreamRatioAt(s, industryId, rem - 1);
    const v = 1 + (up - 1) * pass;
    memo.set(key, v);
    return v;
  }

  // ---------- 工业算力 ----------

  /** 「工业产能」投向提供的算力池（0 = 没成立公司或没拨算力） */
  C.industrialComputePool = function industrialComputePool(s) {
    if (!C.companyFounded(s)) return new D(0);
    const cfg = GAME.company.industrialCompute || {};
    const ratio = (typeof cfg.ratio === 'number') ? cfg.ratio : 1;
    const share = Math.max(0, Math.min(1, s.alloc.industry || 0));
    return s.realCompute.mul(share).mul(ratio);
  }

  /** 某条线的各台配置（永远是数组，没买过就是空数组） */
  C.lineUnits = function lineUnits(s, lineId) {
    const e = s.company && s.company.lines && s.company.lines[lineId];
    if (!e) return [];
    return Array.isArray(e.units) ? e.units : [];
  }

  C.lineOwned = function lineOwned(s, lineId) {
    return C.lineUnits(s, lineId).length;
  }

  /** 停机阈值：低于这个产能视为没开机（不产货、也不占算力） */
  C.lineMinRate = function lineMinRate() {
    const cfg = GAME.company.industrialCompute || {};
    return (typeof cfg.minRate === 'number') ? cfg.minRate : 0.05;
  }

  /** 某台线当前是否在开工 */
  C.unitActive = function unitActive(unit) {
    return !!unit && !!unit.p && (unit.r === undefined ? 1 : unit.r) >= C.lineMinRate();
  }

  /** 某条线是否开了「优先生产」 */
  C.linePriority = function linePriority(s, lineId) {
    const e = s.company && s.company.lines && s.company.lines[lineId];
    return !!(e && e.priority);
  }

  /** 开 / 关某条线的「优先生产」。没买过的线也允许先标记（买了就生效）。 */
  C.setLinePriority = function setLinePriority(s, lineId, on) {
    const line = C.lineById(lineId);
    if (!line) return { ok: false, msg: '生产线不存在' };
    if (!C.companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    if (!s.company.lines[lineId]) s.company.lines[lineId] = { units: [] };
    s.company.lines[lineId].priority = !!on;
    bumpUnitsVer();
    return { ok: true, lineId: lineId, priority: !!on };
  }

  /**
   * 把一个行业下的**全部**生产线一次性设为同一产能（一键满速 / 一键停工）。
   * 只动已经买入的台，没买过的线不受影响。
   */
  C.setIndustryRate = function setIndustryRate(s, industryId, rate) {
    if (!C.companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    const ind = C.industryById(industryId);
    if (!ind) return { ok: false, msg: '行业不存在' };
    const r = Number(rate);
    if (!Number.isFinite(r)) return { ok: false, msg: '产能必须是数字' };
    const v = Math.max(0, Math.min(1, r));
    let lines = 0;
    let units = 0;
    for (const line of GAME.company.lines) {
      if (line.industry !== industryId) continue;
      const us = C.lineUnits(s, line.id);
      if (!us.length) continue;
      lines += 1;
      for (const u of us) { u.r = v; units += 1; }
    }
    bumpUnitsVer();
    return { ok: true, industryId: industryId, rate: v, lines: lines, units: units };
  }

  /** 全厂算力总需求 = Σ(每条线 maxCompute × 该台产能) */
  C.companyComputeDemand = function companyComputeDemand(s) {
    let need = new D(0);
    for (const line of GAME.company.lines) {
      const units = C.lineUnits(s, line.id);
      if (!units.length) continue;
      let r = 0;
      for (const u of units) if (C.unitActive(u)) r += Math.max(0, Math.min(1, u.r === undefined ? 1 : u.r));
      if (r <= 0) continue;
      need = need.add(new D(line.maxCompute).mul(r));
    }
    return need;
  }

  // 分级分配的缓存：按 state 分桶（WeakMap），桶内按「各线产能 + 优先标记 + 算力池」失效。
  let _tierStore = new WeakMap();

  /**
   * 算力按**两级**分配。
   *
   *   第一档：开了「优先生产」的线 —— 先吃满，只有它们自己吃不饱时才内部按比例摊薄；
   *   第二档：其余的线 —— 分第一档吃剩下的，按老规矩统一比例削减。
   *
   * 于是「优先」在经济上的含义是：算力不够时**先牺牲谁**。没开优先的线继续沿用
   * 原来的等比削减规则，玩家不设置任何优先标记时的行为与 v3.7 之前完全一致
   * （此时 priNeed = 0，normScale = pool / 总需求，即旧的 companyComputeScale）。
   */
  // 产线配置版本号：凡是改动「各台的产物 / 产能 / 优先标记」的路径都必须 bump。
  // 两级算力分配与财务快照的缓存 key 用它替代「全量遍历产线拼签名字符串」——
  // 遍历+拼串本身是性能剖析里的最大热点（每次调用都 O(产线×台数)）。
  let _unitsVer = 0;
  function bumpUnitsVer() { _unitsVer += 1; }
  C.bumpUnitsVer = bumpUnitsVer;   // 兵解清空公司（rebirth 模块）也要 bump

  C.companyComputeTiers = function companyComputeTiers(s) {
    const pool = C.industrialComputePool(s).toNumber();
    let e = (s && typeof s === 'object') ? _tierStore.get(s) : null;
    if (!e) {
      e = { key: '', v: null };
      if (s && typeof s === 'object') _tierStore.set(s, e);
    }
    const key = _unitsVer + '|' + pool.toExponential(8);
    if (e.key === key && e.v) return e.v;

    let priNeed = 0;
    let normNeed = 0;
    for (const line of GAME.company.lines) {
      const units = C.lineUnits(s, line.id);
      if (!units.length) continue;
      const pri = C.linePriority(s, line.id);
      let r = 0;
      for (const u of units) {
        if (C.unitActive(u)) r += Math.max(0, Math.min(1, u.r === undefined ? 1 : u.r));
      }
      if (r <= 0) continue;
      const c = (line.maxCompute || 0) * r;
      if (pri) priNeed += c; else normNeed += c;
    }
    {
      const priScale = priNeed > 0 ? Math.max(0, Math.min(1, pool / priNeed)) : 1;
      const left = Math.max(0, pool - Math.min(pool, priNeed));
      const normScale = normNeed > 0 ? Math.max(0, Math.min(1, left / normNeed)) : 1;
      const need = priNeed + normNeed;
      e.key = key;
      e.v = {
        pri: priScale,
        norm: normScale,
        priNeed: priNeed,
        normNeed: normNeed,
        need: need,
        pool: pool,
        // 全厂口径：只用于界面显示「整体几成」
        scale: need > 0 ? Math.max(0, Math.min(1, pool / need)) : 1,
      };
    }
    return e.v;
  }

  /** 某台线实际能拿到几成算力（优先线走 pri 档，其余走 norm 档） */
  C.unitComputeScale = function unitComputeScale(s, line) {
    const t = C.companyComputeTiers(s);
    return C.linePriority(s, line.id) ? t.pri : t.norm;
  }

  /**
   * 算力供给 / 需求的比值（>1 表示供大于求，此时钳到 1）。
   * 这是**全厂口径**，只给界面显示用 —— 真实产量走 unitComputeScale 的分档结果。
   */
  C.companyComputeScale = function companyComputeScale(s) {
    return C.companyComputeTiers(s).scale;
  }

  /**
   * 某台线一个周期的产量（件）。
   *
   *   产量 = 线基准产量 × 产物产量系数 × 产能 × 算力削减系数
   *
   * 产能与削减系数都是乘在产量上的，所以「算力不够 → 产能打折」与
   * 「自己把产能调低」在产量上是同一回事，只是前者不由玩家控制。
   *
   * 削减系数按**台**取（unitComputeScale），因为开了「优先生产」的线和没开的
   * 线拿到的成色不一样 —— 传进来的 scale 只在调用方已经算好时用于避免重复计算。
   */
  C.unitOutput = function unitOutput(s, line, unit, scale) {
    if (!C.unitActive(unit)) return 0;
    const g = C.goodById(unit.p);
    if (!g) return 0;
    const rate = Math.max(0, Math.min(1, unit.r === undefined ? 1 : unit.r));
    const sc = (scale === undefined) ? C.unitComputeScale(s, line) : scale;
    const coef = (typeof g.outputCoef === 'number') ? g.outputCoef : 1;
    return (line.baseOutput || 0) * coef * rate * sc;
  }

  /**
   * 每周期产出明细 { [goodId]: 件数 }（未受仓库容量限制）。
   * 件数可能是小数 —— 入库时再取整，避免低产能时「永远产 0 件」。
   */
  C.companyOutputPerCycle = function companyOutputPerCycle(s) {
    const out = {};
    for (const line of GAME.company.lines) {
      const units = C.lineUnits(s, line.id);
      if (!units.length) continue;
      const scale = C.unitComputeScale(s, line);
      for (const u of units) {
        const n = C.unitOutput(s, line, u, scale);
        if (n <= 0) continue;
        out[u.p] = (out[u.p] || 0) + n;
      }
    }
    return out;
  }

  /**
   * 每周期维护费。
   *
   *   单件维护费 = 该产物当前售价 × 产物维护费率 × 行业成本指数
   *
   * 于是「不同产物维护费不同」（由 upkeepRate 与售价共同决定），
   * 而「上游涨价」通过 costIndex 直接抬升下游成本 —— 这是成本传导的落点。
   */
  C.companyUpkeep = function companyUpkeep(s) {
    let material = new D(0);
    let labor = new D(0);
    const cache = {};
    for (const line of GAME.company.lines) {
      const units = C.lineUnits(s, line.id);
      if (!units.length) continue;
      const scale = C.unitComputeScale(s, line);
      for (const u of units) {
        const n = C.unitOutput(s, line, u, scale);
        if (n <= 0) continue;
        const g = C.goodById(u.p);
        if (!g) continue;
        // 同一商品的多台共用一份「售价 × 费率 × 成本指数」—— 产线越多收益越大
        let per = cache[g.id];
        if (per === undefined) {
          if (cache[g.industry] === undefined) {
            cache[g.industry] = C.industryCostIndex(s, g.industry);
          }
          per = C.goodsPriceWith(s, g).mul(g.upkeepRate || 0.3).mul(cache[g.industry]);
          cache[g.id] = per;
        }
        const total = per.mul(n);
        material = material.add(total.mul(0.66));
        labor = labor.add(total.mul(0.34));
      }
    }
    return { material: material, labor: labor, total: material.add(labor) };
  }

  /**
   * 每周期毛产出价值（按**当前市价**估算，已计入抛压与行业传导）。
   * 只是给界面看的预估值 —— 实际收益取决于结算那一刻的市价。
   */
  C.companyCycleGross = function companyCycleGross(s) {
    const out = C.companyOutputPerCycle(s);
    let v = new D(0);
    for (const id of Object.keys(out)) {
      const g = C.goodById(id);
      if (!g) continue;
      v = v.add(C.goodsPriceWith(s, g).mul(out[id]));
    }
    return v;
  }

  /** 每周期净收益 = 毛产出 − 维护费 */
  C.companyCycleNet = function companyCycleNet(s) {
    const f = C.companyFinance(s);
    return f ? f.net : new D(0);
  }

  // ---------- 公司财务快照缓存 ----------
  //
  // 「维护费 / 毛产出 / 净收益」的全部输入是：各台线的产物与产能、工业算力池、
  // 行情时钟与抛压版本。顶栏每 100ms 读一次「每秒净收益」，离线结算的一个
  // 大步里公司要跑十几个周期 —— 同一份输入被反复重算（每次都要沿产线把
  // 288 件商品的行情链推一遍）。这里按「units 签名 + 池 + 时钟 + 抛压版本」
  // 记忆化，与 companyComputeTiers 同一套失效思路：改产能 / 改抛压都会改
  // key，无需手动失效；行情时钟每步推进，快照天然逐步刷新。
  let _finStore = new WeakMap();

  C.companyFinance = function companyFinance(s) {
    if (!C.companyFounded(s)) return null;
    // key 用「配置版本号 + 池 + 行情时钟 + 抛压版本」—— 覆盖全部输入且构建 O(1)
    const key = _unitsVer + '|' + C.industrialComputePool(s).toNumber().toExponential(8)
      + '|' + C.marketClock(s) + '|' + _mktVer;

    let e = (s && typeof s === 'object') ? _finStore.get(s) : null;
    if (!e) {
      e = { key: '', v: null };
      if (s && typeof s === 'object') _finStore.set(s, e);
    }
    if (e.key !== key || !e.v) {
      const upkeep = C.companyUpkeep(s);
      const out = C.companyOutputPerCycle(s);
      const gross = C.companyCycleGross(s);
      // 自动卖出的成交价在**本段 tick 内是常量**（playTime 在 stepTick 末尾才累加），
      // 预计算一次价格表给生产循环复用 —— 这是长离线结算的主要加速点
      const price = {};
      for (const g of GAME.company.goods) {
        if ((out[g.id] > 0) || ((s.company.stock[g.id] || 0) > 0)) {
          price[g.id] = C.goodsPriceWith(s, g);
        }
      }
      e.key = key;
      e.v = {
        upkeep: upkeep,
        out: out,
        gross: gross,
        net: gross.sub(upkeep.total),
        price: price,
      };
    }
    return e.v;
  }

  // ---------- 生产线操作 ----------

  /**
   * 设置某台线的产物 / 产能。
   * @param {number} index 第几台（0-based）；传 -1 或 'all' 表示这条线的全部台
   */
  C.setLineUnit = function setLineUnit(s, lineId, index, patch) {
    const line = C.lineById(lineId);
    if (!line) return { ok: false, msg: '生产线不存在' };
    if (!C.companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    const units = C.lineUnits(s, lineId);
    if (!units.length) return { ok: false, msg: '这条线还没有买入' };

    const products = C.lineProducts(line);
    const productOk = (id) => products.some((g) => g.id === id);

    const all = (index === 'all' || index === -1 || index === null || index === undefined);
    const targets = all ? units : [units[index]];
    if (!all && !targets[0]) return { ok: false, msg: '台号不存在' };

    if (patch && patch.product !== undefined) {
      if (!productOk(patch.product)) return { ok: false, msg: '这条线造不了该产物' };
    }
    let rate = null;
    if (patch && patch.rate !== undefined) {
      rate = Math.max(0, Math.min(1, Number(patch.rate) || 0));
      if (!Number.isFinite(rate)) return { ok: false, msg: '产能必须是数字' };
    }

    for (const u of targets) {
      if (patch && patch.product !== undefined) u.p = patch.product;
      if (rate !== null) u.r = rate;
    }
    bumpUnitsVer();
    return { ok: true, lineId: lineId, index: index, all: all, count: targets.length };
  }

  C.companyIncomePerSecond = function companyIncomePerSecond(s) {
    if (!C.companyFounded(s)) return new D(0);
    const cyc = GAME.company.cycleRealSeconds || 1;
    return C.companyCycleNet(s).div(cyc);
  }

  // ---------- 公司操作 ----------

  /** 注册成立公司（消耗金钱） */
  C.foundCompany = function foundCompany(s) {
    if (!GAME.company.implemented) return { ok: false, msg: '公司系统未开放' };
    if (C.companyFounded(s)) return { ok: false, msg: '公司已成立' };
    const need = GAME.company.unlock || {};
    if (s.realm < (need.realm || 0)) {
      return { ok: false, msg: '需达到「' + C.realmName(need.realm) + '」' };
    }
    const cost = new D(GAME.company.foundCost);
    if (s.money.lt(cost)) return { ok: false, msg: '金钱不足，注册需 ' + C.fmtBig(GAME.company.foundCost) };
    s.money = s.money.sub(cost);
    s.company.founded = true;
    s.company.foundedDay = C.gameDate(s.gameSeconds).days;
    return { ok: true, cost: cost, foundedDay: s.company.foundedDay };
  }

  /** 买一条生产线 */
  C.buyLine = function buyLine(s, lineId, count) {
    const line = C.lineById(lineId);
    if (!line) return { ok: false, msg: '生产线不存在' };
    if (!C.lineUnlocked(s, line)) {
      return { ok: false, msg: C.lineLockedReason(s, line) || '尚未解锁' };
    }
    // v3.6 批量购买：count 台逐台成交（每台都按当前拥有数重新计价），
    // 钱不够就停在最后一台买得起的——「买了多少是多少」。
    let want = Math.floor(Number(count) || 1);
    if (!(want > 0)) want = 1;
    if (want > 100) want = 100;

    let totalCost = new D(0);
    let bought = 0;
    let lastIndex = -1;
    let lastProduct = null;
    let lastCost = new D(0);
    while (bought < want) {
      const cost = C.lineCost(s, line);
      if (s.money.lt(cost)) break;
      s.money = s.money.sub(cost);
      totalCost = totalCost.add(cost);
      // 新买的一台是一份**独立配置**：默认产该行业第一个产物、产能拉满。
      // 买完想改产什么、开几成力，由 setLineUnit 单独调。
      const units = C.lineUnits(s, line.id).slice();
      const prods = C.lineProducts(line);
      units.push({ p: prods.length ? prods[0].id : null, r: 1 });
      // priority 必须跟着一起写回 —— 否则「加购一台」会把这条线的优先标记抹掉，
      // 而且序列化时字段时有时无，存档往返会对不上。
      s.company.lines[line.id] = { units: units, priority: C.linePriority(s, line.id) };
      lastIndex = units.length - 1;
      lastProduct = units[units.length - 1].p;
      lastCost = cost;
      bought += 1;
    }
    if (bought === 0) return { ok: false, msg: '金钱不足' };
    bumpUnitsVer();
    return {
      ok: true, owned: C.lineUnits(s, line.id).length, cost: totalCost,
      bought: bought, asked: want,
      index: lastIndex, product: lastProduct, unitCost: lastCost,
    };
  }

  /** 升级仓库 */
  C.upgradeWarehouse = function upgradeWarehouse(s) {
    if (!C.companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    const w = GAME.company.warehouse;
    const lv = C.warehouseLevel(s);
    if (lv >= w.maxLevel) return { ok: false, msg: '仓库已至最高等级' };
    const cost = C.warehouseCost(s);
    if (s.money.lt(cost)) return { ok: false, msg: '金钱不足' };
    s.money = s.money.sub(cost);
    s.company.warehouseLevel = lv + 1;
    return { ok: true, level: s.company.warehouseLevel, capacity: C.warehouseCapacity(s), cost: cost };
  }

  /**
   * 商品的**售卖货币**（v3.6）：
   *   科技系 → 金钱（1:1）
   *   修仙系 / 融合系 → 灵石 = 售价（金钱口径）× company.stoneExchange
   * 价格、行情、抛压、股市联动仍全部按金钱口径计算 —— 只在入账那一刻换货币。
   */
  C.goodCurrency = function goodCurrency(g) {
    return (g && g.kind === 'tech') ? 'money' : 'stone';
  }

  /** 灵石换算系数（金钱口径售价 → 灵石） */
  C.stoneExchangeRate = function stoneExchangeRate() {
    return C.num(GAME.company.stoneExchange, 1e-4);
  }

  /**
   * 清仓的统一入账逻辑：价格表由调用方提供（动作路径现场推一份，
   * 离线循环复用 companyFinance 的快照表）。不校验是否已成立公司。
   * @returns {{revenue: D, money: D, stone: D, sold: object}}
   */
  C.sellAllWithPrices = function sellAllWithPrices(s, priceOf) {
    const sold = {};
    let moneyRev = new D(0);
    let stoneRev = new D(0);   // 金钱口径的销售额（入账前乘换算系数）
    for (const g of GAME.company.goods) {
      const n = s.company.stock[g.id] || 0;
      if (n <= 0) continue;
      const price = priceOf[g.id] || C.goodsPriceWith(s, g);
      const rev = price.mul(n);
      if (C.goodCurrency(g) === 'stone') stoneRev = stoneRev.add(rev);
      else moneyRev = moneyRev.add(rev);
      sold[g.id] = n;
      s.company.stock[g.id] = 0;
      s.company.goodsSold[g.id] = (s.company.goodsSold[g.id] || 0) + n;
      // 记进「本期成交量」—— 抛压结算时与本期产出对比，多出来的部分就是砸盘
      s.company.soldThisPeriod[g.id] = (s.company.soldThisPeriod[g.id] || 0) + n;
    }
    const revenue = moneyRev.add(stoneRev);
    if (revenue.gt(0)) {
      // 总营业额（市场累计收入、成就口径）仍按金钱量级记全量
      s.company.totalRevenue = s.company.totalRevenue.add(revenue);
      s.money = s.money.add(moneyRev);
      const stone = stoneRev.mul(C.stoneExchangeRate());
      if (stone.gt(0)) s.spiritStone = s.spiritStone.add(stone);
    }
    return { revenue: revenue, money: moneyRev, stone: stoneRev.mul(C.stoneExchangeRate()), sold: sold };
  }

  C.sellAllInternal = function sellAllInternal(s) {
    // 动作路径一次性清仓：现场推一份价格表，与离线循环共用同一套入账逻辑
    const priceOf = {};
    for (const g of GAME.company.goods) {
      if ((s.company.stock[g.id] || 0) > 0) priceOf[g.id] = C.goodsPriceWith(s, g);
    }
    return C.sellAllWithPrices(s, priceOf);
  }

  /**
   * 卖出库存。goodId 传 'all'（或省略）表示清仓；否则只卖指定商品。
   * count 省略或 <= 0 表示该商品全部卖出。
   */
  C.sellGoods = function sellGoods(s, goodId, count) {
    if (!C.companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    if (goodId === undefined || goodId === null || goodId === 'all') {
      const r = C.sellAllInternal(s);
      if (!r.revenue.gt(0)) return { ok: false, msg: '仓库是空的' };
      return { ok: true, revenue: r.revenue, money: r.money, stone: r.stone, sold: r.sold, all: true };
    }
    const g = C.goodById(goodId);
    if (!g) return { ok: false, msg: '商品不存在' };
    const have = s.company.stock[g.id] || 0;
    if (have <= 0) return { ok: false, msg: '该商品没有库存' };

    const n = (!count || count <= 0) ? have : Math.min(have, Math.floor(count));
    const price = C.goodsPriceWith(s, g);
    const revenue = price.mul(n);
    s.company.stock[g.id] = have - n;
    s.company.goodsSold[g.id] = (s.company.goodsSold[g.id] || 0) + n;
    s.company.soldThisPeriod[g.id] = (s.company.soldThisPeriod[g.id] || 0) + n;
    s.company.totalRevenue = s.company.totalRevenue.add(revenue);
    const isStone = C.goodCurrency(g) === 'stone';
    const stone = isStone ? revenue.mul(C.stoneExchangeRate()) : new D(0);
    if (!isStone) s.money = s.money.add(revenue);
    if (stone.gt(0)) s.spiritStone = s.spiritStone.add(stone);
    return {
      ok: true, revenue: revenue, count: n, price: price, goodId: g.id,
      currency: isStone ? 'stone' : 'money', stone: stone,
    };
  }

  /** 开关自动卖出 */
  C.setAutoSell = function setAutoSell(s, on) {
    if (!C.companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    s.company.autoSell = !!on;
    return { ok: true, autoSell: s.company.autoSell };
  }

  /**
   * 公司推进 —— 在 tick 内按现实秒累积，满一个周期就结算一次。
   *
   * 单个周期的结算顺序（不能打乱）：
   *   ① 扣维护费（钱不够 → 本周期停产，且不欠费）
   *   ② 各生产线产出并入库（仓库满 → 超出的部分直接放弃，形成经营压力）
   *   ③ 若开启自动卖出 → 立即按当前市价清仓
   *
   * @returns {object|null} 本次推进的汇总
   */
  C.syncCompany = function syncCompany(s, dt, offline) {
    if (!GAME.company.implemented) return null;
    if (!C.companyFounded(s)) return null;
    if (!(dt > 0)) return null;

    const eff = offline ? C.offlineRatio(s) : 1;
    if (offline && GAME.offline.companyWhileOffline === false) return null;

    const c = s.company;
    const cyc = Math.max(1, GAME.company.cycleRealSeconds);
    c.cycleProgress += dt * eff;

    const acc = {
      cycles: 0,
      revenue: new D(0),
      upkeep: new D(0),
      produced: 0,
      overflow: 0,
      starved: 0,
      sold: {},
    };

    let guard = 0;
    while (c.cycleProgress >= cyc && guard < 100000) {
      c.cycleProgress -= cyc;
      acc.cycles += 1;
      c.cycles += 1;

      // 本段 tick 内行情时钟不推进（playTime 在 stepTick 末尾才累加），
      // 所以「维护费 / 产量 / 成交价」在整个 while 循环里是常量 ——
      // companyFinance 按输入记忆化，长离线的十几个周期只算一次。
      const fin = C.companyFinance(s);

      // ① 维护费（钱不够 → 本周期停产，且不欠费）
      const upTotal = fin ? fin.upkeep.total : new D(0);
      if (s.money.lt(upTotal)) {
        acc.starved += 1;
        continue;
      }
      s.money = s.money.sub(upTotal);
      s.company.totalUpkeep = s.company.totalUpkeep.add(upTotal);
      acc.upkeep = acc.upkeep.add(upTotal);

      // ② 产出入库 —— 按「每台线各自产什么」汇总，产量受算力与产能双重缩放
      const outMap = fin ? fin.out : {};
      for (const goodId of Object.keys(outMap)) {
        // 产量可能是小数（低产能时不足一件），先攒着，够一件再入库，
        // 否则「开 1% 产能」会永远产 0 件
        c.pending[goodId] = (c.pending[goodId] || 0) + outMap[goodId];
        const whole = Math.floor(c.pending[goodId]);
        if (whole <= 0) continue;
        c.pending[goodId] -= whole;
        const room = Math.max(0, C.warehouseCapacity(s) - C.stockTotal(s));
        const put = Math.min(whole, room);
        if (put > 0) {
          c.stock[goodId] = (c.stock[goodId] || 0) + put;
          acc.produced += put;
          // 本期产出：抛压的分母。产得多说明市场本就该有这么多货，
          // 同量的卖出就不算「砸盘」。
          c.producedThisPeriod[goodId] = (c.producedThisPeriod[goodId] || 0) + put;
        }
        acc.overflow += whole - put;
      }

      // ③ 自动卖出（复用快照价格表，不再逐周期重推 288 件商品的行情链）
      if (c.autoSell) {
        const r = fin
          ? C.sellAllWithPrices(s, fin.price)
          : C.sellAllInternal(s);
        acc.revenue = acc.revenue.add(r.revenue);
        for (const k of Object.keys(r.sold)) acc.sold[k] = (acc.sold[k] || 0) + r.sold[k];
      }
      guard += 1;
    }

    return acc;
  }


  return C;
});
