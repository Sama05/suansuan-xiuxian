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

  function industryById(id) {
    if (!id) return null;
    return GAME.company.industries.find((x) => x.id === id) || null;
  }

  /** 某行业的全部产物 */
  function goodsOfIndustry(industryId) {
    return GAME.company.goods.filter((g) => g.industry === industryId);
  }

  /** 某条生产线能造的产物 —— 就是它所属行业的全部产物 */
  function lineProducts(line) {
    if (!line) return [];
    return goodsOfIndustry(line.industry);
  }

  function lineIndustry(line) {
    return line ? industryById(line.industry) : null;
  }

  // ---------- 成本传导 ----------
  //
  // 上游行业的商品涨了 → 本行业的成本按 passThrough 涨、售价只按 pricePass 涨。
  // pricePass 恒小于 passThrough，于是上游一涨，本行业「售价涨得比成本慢」，
  // 毛利被压缩。矿价暴涨时钢锭也贵，但炼钢厂反而更不赚钱 —— 这就是联动的体感。
  //
  // 上下游是按 tier 递增的有向无环图，所以递归一定终止；这里仍加一层深度守卫，
  // 防止配置写错（出现环）时把整个 tick 拖成栈溢出。

  let _indDepth = 0;

  /** 某行业当前的「价格倍数」= 该行业全部商品 现价/基准价 的平均值（1 = 平价） */
  function industryPriceRatio(s, industryId) {
    const list = goodsOfIndustry(industryId);
    if (!list.length) return 1;
    if (_indDepth > 8) return 1;
    _indDepth += 1;
    let sum = 0;
    try {
      for (const g of list) {
        sum += goodsPriceWith(s, g).div(new D(g.basePrice)).toNumber();
      }
    } finally {
      _indDepth -= 1;
    }
    return sum / list.length;
  }

  /** 上游综合价格倍数（多个上游行业等权平均） */
  function industryUpstreamRatio(s, industryId) {
    const ind = industryById(industryId);
    if (!ind || !ind.upstream || !ind.upstream.length) return 1;
    let sum = 0;
    for (const up of ind.upstream) sum += industryPriceRatio(s, up);
    return sum / ind.upstream.length;
  }

  /** 上游涨价 → 本行业**售价**的传导（打折跟涨） */
  function industryPriceIndex(s, industryId) {
    const ind = industryById(industryId);
    if (!ind) return 1;
    const up = industryUpstreamRatio(s, industryId);
    if (_indDepth > 8) return 1;
    return 1 + (up - 1) * (ind.pricePass || 0);
  }

  /** 上游涨价 → 本行业**成本**的传导（全额上涨，于是毛利被压缩） */
  function industryCostIndex(s, industryId) {
    const ind = industryById(industryId);
    if (!ind) return 1;
    const up = industryUpstreamRatio(s, industryId);
    if (_indDepth > 8) return 1;
    return 1 + (up - 1) * (ind.passThrough || 0);
  }

  // ---------- 工业算力 ----------

  /** 「工业产能」投向提供的算力池（0 = 没成立公司或没拨算力） */
  function industrialComputePool(s) {
    if (!companyFounded(s)) return new D(0);
    const cfg = GAME.company.industrialCompute || {};
    const ratio = (typeof cfg.ratio === 'number') ? cfg.ratio : 1;
    const share = Math.max(0, Math.min(1, s.alloc.industry || 0));
    return s.realCompute.mul(share).mul(ratio);
  }

  /** 某条线的各台配置（永远是数组，没买过就是空数组） */
  function lineUnits(s, lineId) {
    const e = s.company && s.company.lines && s.company.lines[lineId];
    if (!e) return [];
    return Array.isArray(e.units) ? e.units : [];
  }

  function lineOwned(s, lineId) {
    return lineUnits(s, lineId).length;
  }

  /** 停机阈值：低于这个产能视为没开机（不产货、也不占算力） */
  function lineMinRate() {
    const cfg = GAME.company.industrialCompute || {};
    return (typeof cfg.minRate === 'number') ? cfg.minRate : 0.05;
  }

  /** 某台线当前是否在开工 */
  function unitActive(unit) {
    return !!unit && !!unit.p && (unit.r === undefined ? 1 : unit.r) >= lineMinRate();
  }

  /** 全厂算力总需求 = Σ(每条线 maxCompute × 该台产能) */
  function companyComputeDemand(s) {
    let need = new D(0);
    for (const line of GAME.company.lines) {
      const units = lineUnits(s, line.id);
      if (!units.length) continue;
      let r = 0;
      for (const u of units) if (unitActive(u)) r += Math.max(0, Math.min(1, u.r === undefined ? 1 : u.r));
      if (r <= 0) continue;
      need = need.add(new D(line.maxCompute).mul(r));
    }
    return need;
  }

  /**
   * 算力供给 / 需求的比值（>1 表示供大于求，此时钳到 1）。
   * **统一按比例削减**，不是先到先得 —— 于是算力不足时多买线不会凭空增产，
   * 只会把每条线摊薄。这是「工业产能」这条投向的全部意义。
   */
  function companyComputeScale(s) {
    const need = companyComputeDemand(s);
    if (need.lte(0)) return 1;
    const pool = industrialComputePool(s);
    if (pool.gte(need)) return 1;
    const v = pool.div(need).toNumber();
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }

  /**
   * 某台线一个周期的产量（件）。
   *
   *   产量 = 线基准产量 × 产物产量系数 × 产能 × 算力削减系数
   *
   * 产能与削减系数都是乘在产量上的，所以「算力不够 → 产能打折」与
   * 「自己把产能调低」在产量上是同一回事，只是前者不由玩家控制。
   */
  function unitOutput(s, line, unit, scale) {
    if (!unitActive(unit)) return 0;
    const g = goodById(unit.p);
    if (!g) return 0;
    const rate = Math.max(0, Math.min(1, unit.r === undefined ? 1 : unit.r));
    const sc = (scale === undefined) ? companyComputeScale(s) : scale;
    const coef = (typeof g.outputCoef === 'number') ? g.outputCoef : 1;
    return (line.baseOutput || 0) * coef * rate * sc;
  }

  /**
   * 每周期产出明细 { [goodId]: 件数 }（未受仓库容量限制）。
   * 件数可能是小数 —— 入库时再取整，避免低产能时「永远产 0 件」。
   */
  function companyOutputPerCycle(s) {
    const out = {};
    const scale = companyComputeScale(s);
    for (const line of GAME.company.lines) {
      const units = lineUnits(s, line.id);
      if (!units.length) continue;
      for (const u of units) {
        const n = unitOutput(s, line, u, scale);
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
  function companyUpkeep(s) {
    let material = new D(0);
    let labor = new D(0);
    const scale = companyComputeScale(s);
    const cache = {};
    for (const line of GAME.company.lines) {
      const units = lineUnits(s, line.id);
      if (!units.length) continue;
      for (const u of units) {
        const n = unitOutput(s, line, u, scale);
        if (n <= 0) continue;
        const g = goodById(u.p);
        if (!g) continue;
        if (cache[g.industry] === undefined) cache[g.industry] = industryCostIndex(s, g.industry);
        const per = goodsPriceWith(s, g).mul(g.upkeepRate || 0.3).mul(cache[g.industry]);
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
  function companyCycleGross(s) {
    const out = companyOutputPerCycle(s);
    let v = new D(0);
    for (const id of Object.keys(out)) {
      const g = goodById(id);
      if (!g) continue;
      v = v.add(goodsPriceWith(s, g).mul(out[id]));
    }
    return v;
  }

  /** 每周期净收益 = 毛产出 − 维护费 */
  function companyCycleNet(s) {
    return companyCycleGross(s).sub(companyUpkeep(s).total);
  }

  // ---------- 生产线操作 ----------

  /**
   * 设置某台线的产物 / 产能。
   * @param {number} index 第几台（0-based）；传 -1 或 'all' 表示这条线的全部台
   */
  function setLineUnit(s, lineId, index, patch) {
    const line = lineById(lineId);
    if (!line) return { ok: false, msg: '生产线不存在' };
    if (!companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    const units = lineUnits(s, lineId);
    if (!units.length) return { ok: false, msg: '这条线还没有买入' };

    const products = lineProducts(line);
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
    return { ok: true, lineId: lineId, index: index, all: all, count: targets.length };
  }
