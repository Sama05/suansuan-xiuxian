  // ---------- 行业（上下游与成本传导）----------
  ok(cfg.industries.length >= 6, '行业表至少 6 个', String(cfg.industries.length));
  const indIds = new Set(cfg.industries.map((x) => x.id));
  ok(indIds.size === cfg.industries.length, '行业 id 不重复');

  // 上游必须存在、且处在更低的层级 —— 否则传导会成环，tick 里会栈溢出
  let noCycle = true;
  for (const ind of cfg.industries) {
    for (const u of (ind.upstream || [])) {
      const up = C.industryById(u);
      if (!up) noCycle = false;
      else if (up.tier >= ind.tier) noCycle = false;
    }
  }
  ok(noCycle, '上游行业都存在且层级更低（传导图无环）');

  // 成本传导必须 ≥ 售价传导，否则上游涨价反而让下游更赚，与「成本传导」的意图相反
  let passOk = true;
  for (const ind of cfg.industries) {
    if (!((ind.passThrough || 0) >= (ind.pricePass || 0))) passOk = false;
  }
  ok(passOk, '每个行业的成本传导 ≥ 售价传导（上游涨价会压缩下游毛利）');

  // 每行业至少 6 种产物
  let sixOk = true;
  const perInd = [];
  for (const ind of cfg.industries) {
    const n = C.goodsOfIndustry(ind.id).length;
    perInd.push(ind.name + ':' + n);
    if (n < 6) sixOk = false;
  }
  ok(sixOk, '每个行业至少 6 种产物', perInd.join(' '));

  // ---------- 商品 ----------
  const gids = new Set(cfg.goods.map((g) => g.id));
  ok(gids.size === cfg.goods.length, '商品 id 不重复');
  const lids = new Set(cfg.lines.map((l) => l.id));
  ok(lids.size === cfg.lines.length, '生产线 id 不重复');

  let indOk = true;
  for (const g of cfg.goods) if (!C.industryById(g.industry)) indOk = false;
  ok(indOk, '每件产物都归属于存在的行业');

  const techGoods = cfg.goods.filter((g) => g.kind === 'tech');
  const xiuGoods = cfg.goods.filter((g) => g.kind === 'xiuxian');
  ok(techGoods.length > 0 && xiuGoods.length > 0, '科技类与修仙类商品都存在');
  ok(techGoods.every((g) => g.periodYears === 1), '科技类商品逐年变价');
  ok(xiuGoods.every((g) => g.periodYears === 10), '修仙类商品每 10 年变价');

  // 行业内：价值递增、产量系数递减（越贵造得越慢 ——「堆产量」与「堆单价」两种打法）
  let ascOk = true, coefOk = true;
  for (const ind of cfg.industries) {
    const list = C.goodsOfIndustry(ind.id);
    for (let i = 1; i < list.length; i++) {
      if (!(list[i].basePrice > list[i - 1].basePrice)) ascOk = false;
      if (!(list[i].outputCoef < list[i - 1].outputCoef)) coefOk = false;
    }
  }
  ok(ascOk, '每个行业内产物价值递增');
  ok(coefOk, '每个行业内越贵的产物造得越慢（outputCoef 递减）');

  // 维护费率：净收益率约 70%
  let rateOk = true;
  for (const g of cfg.goods) if (!(g.upkeepRate > 0.25 && g.upkeepRate < 0.35)) rateOk = false;
  ok(rateOk, '每件产物的维护费率 ≈ 30%（净收益率约 70%）');

  // ---------- 生产线 ----------
  // 一条线不再绑定单一产物，而是绑定一个行业 —— 能造这个行业的全部产物
  let lineOk = true;
  for (const line of cfg.lines) {
    if (!C.industryById(line.industry)) lineOk = false;
    else if (!C.lineProducts(line).length) lineOk = false;
    else if (!(line.maxCompute > 0) || !(line.baseOutput > 0)) lineOk = false;
  }
  ok(lineOk, '每条生产线都挂在有产物的行业上，且算力上限 / 基准产量为正');

  // 解锁链：至少一条无前置，其余都有有效前置
  const noAfter = cfg.lines.filter((l) => !l.after);
  ok(noAfter.length >= 1, '至少一条生产线无前置', String(noAfter.length));
  let chained = true;
  for (const l of cfg.lines) {
    if (!l.after) continue;
    if (!C.lineById(l.after.id) || !(l.after.times > 0)) chained = false;
  }
  ok(chained, '其余生产线都有有效的前置条件');

  // 单位算力产值随产业链层级递增 —— 高级线更划算，但造价与解锁门槛同步抬升。
  // 用「每层取最小值」比较，允许同层内科技线与修仙线互有高低。
  const geo = (list) => {
    let s = 0;
    for (const g of list) s += Math.log10(g.basePrice);
    return Math.pow(10, s / list.length);
  };
  const byTier = {};
  for (const l of cfg.lines) {
    const t = C.industryById(l.industry).tier;
    const v = (l.baseOutput * geo(C.lineProducts(l))) / l.maxCompute;
    if (byTier[t] === undefined || v < byTier[t]) byTier[t] = v;
  }
  const tiers = Object.keys(byTier).map(Number).sort((a, b) => a - b);
  let tierOk = true;
  const tierVals = [];
  for (const t of tiers) tierVals.push(t + '层' + byTier[t].toFixed(2));
  for (let i = 1; i < tiers.length; i++) {
    if (!(byTier[tiers[i]] > byTier[tiers[i - 1]])) tierOk = false;
  }
  ok(tierOk, '越下游的行业单位算力产值越高', tierVals.join(' < '));
