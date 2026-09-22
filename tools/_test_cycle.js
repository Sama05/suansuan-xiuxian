console.log('\n=== 公司系统 · 周期结算 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e6);
  C.setWorking(s, false);                    // 排除工作收益干扰
  C.foundCompany(s);
  C.buyLine(s, 'mine');
  // 买线只拿到产能上限，转起来要靠「工业产能」投向拨的算力
  s.realCompute = new D(1e6);
  C.setAllocation(s, { industry: 1 });

  const line = C.lineById('mine');
  const g = C.goodById(C.lineUnits(s, 'mine')[0].p);
  ok(g && g.id === 'iron_ore', '新买的台默认产该行业第一种产物', g && g.name);

  const price0 = C.goodsPrice(g, 0);
  ok(price0.eq(new D(g.basePrice)), '开市按基准价挂牌', price0.toString());

  // ---- 产量 = 基准产量 × 产物产量系数 × 产能 × 算力削减系数 ----
  const out = C.companyOutputPerCycle(s);
  const qty = out[g.id];
  ok(Math.abs(qty - line.baseOutput * g.outputCoef) < 1e-9,
    '每周期产量 = 基准产量 × 产物产量系数',
    qty + ' = ' + line.baseOutput + ' × ' + g.outputCoef);

  // ---- 维护费 = 单件维护费 × 产量；单件 = 售价 × 维护费率 × 行业成本指数 ----
  const px = C.goodsPriceWith(s, g);
  const up = C.companyUpkeep(s);
  // 采掘是最上游，成本指数恒为 1
  ok(C.industryCostIndex(s, 'mining') === 1, '最上游行业没有上游成本可传导');
  ok(up.total.eq(px.mul(g.upkeepRate).mul(qty)), '维护费 = 单件维护费 × 产量',
    up.total.toString());
  ok(up.material.add(up.labor).eq(up.total), '维护费 = 原料 + 人工');

  const gross = C.companyCycleGross(s);
  ok(gross.eq(px.mul(qty)), '毛产值 = 产量 × 市价', gross.toString());
  const net = C.companyCycleNet(s);
  const nr = net.div(gross).toNumber();
  ok(nr > 0.65 && nr < 0.75, '净收益率 ≈ 70%', String(nr));
  ok(C.companyIncomePerSecond(s).eq(net.div(GAME.company.cycleRealSeconds)),
    '折算每秒收益 = 净收益 / 周期', C.companyIncomePerSecond(s).toString());

  // ---- 走一个完整周期 ----
  const m0 = s.money;
  const acc = C.syncCompany(s, GAME.company.cycleRealSeconds, false);
  ok(acc.cycles === 1, '满一个周期结算 1 次', String(acc.cycles));
  ok(acc.produced === Math.floor(qty), '本周期产出入库（不足一件先攒着）',
    acc.produced + ' / ' + qty);
  ok(acc.upkeep.eq(up.total), '本周期扣维护费', acc.upkeep.toString());
  ok(acc.revenue.gt(0), '本周期卖出有收入', acc.revenue.toString());
  ok(acc.starved === 0, '本周期未停产');
  ok(acc.overflow === 0, '本周期无溢仓');
  ok(s.money.eq(m0.sub(up.total).add(acc.revenue)), '金钱 = 初始 − 维护费 + 收入',
    m0.toString() + ' -> ' + s.money.toString());
  ok(s.company.cycles === 1, '累计周期数 +1');
  ok(C.stockTotal(s) === 0, '自动卖出后库存清零');
  ok((s.company.goodsSold[g.id] || 0) === acc.produced, '售出计数累加',
    String(s.company.goodsSold[g.id]));
  ok(s.company.totalRevenue.gt(0), '累计营业额记录', s.company.totalRevenue.toString());
  ok(s.company.totalUpkeep.gt(0), '累计维护费记录', s.company.totalUpkeep.toString());

  // 不足一个周期只累积进度
  const a2 = C.syncCompany(s, 10, false);
  ok(a2.cycles === 0, '不足一个周期不结算');
  ok(Math.abs(s.company.cycleProgress - 10) < 1e-9, '进度累积到 10 秒',
    String(s.company.cycleProgress));
  const a3 = C.syncCompany(s, 10, false);
  ok(a3.cycles === 1, '补满后结算');

  // 多个周期一次算清
  const s2 = C.createState();
  s2.realm = 1;
  s2.money = new D(1e7);
  C.setWorking(s2, false);
  C.foundCompany(s2);
  C.buyLine(s2, 'mine');
  s2.realCompute = new D(1e6);
  C.setAllocation(s2, { industry: 1 });
  const a4 = C.syncCompany(s2, GAME.company.cycleRealSeconds * 30, false);
  ok(a4.cycles === 30, '一次推进 30 个周期', String(a4.cycles));
  ok(a4.revenue.gt(0), '30 周期收入累计', a4.revenue.toString());
  ok(s2.company.cycles === 30, '周期计数累加到 30');

  // 未成立 / dt 为 0 时不推进
  const raw = C.createState();
  raw.realm = 1;
  ok(C.syncCompany(raw, 100, false) === null, '未成立公司时不推进');
  ok(C.syncCompany(s, 0, false) === null, 'dt = 0 时不推进');

  // tick 集成：公司挂在主循环上
  const s3 = C.createState();
  s3.realm = 1;
  s3.money = new D(1e7);
  C.setWorking(s3, false);
  C.foundCompany(s3);
  C.buyLine(s3, 'mine');
  s3.realCompute = new D(1e6);
  C.setAllocation(s3, { industry: 1 });
  s3.devices.pc = 1;                         // tick 会重算算力，给点设备兜住
  const t = C.tick(s3, GAME.company.cycleRealSeconds, { offline: false });
  ok(t.company !== null, 'tick 返回公司结算汇总');
  ok(t.company.cycles >= 1, 'tick 内公司正常推进', String(t.company.cycles));
  ok(s3.company.cycles >= 1, 'tick 后公司周期计数已累加');

  // 公司不吃精力 —— 与工作系统的根本区别
  const s4 = C.createState();
  s4.realm = 1;
  s4.money = new D(1e7);
  C.setWorking(s4, false);
  const e0 = s4.energy;
  C.foundCompany(s4);
  C.buyLine(s4, 'mine');
  C.tick(s4, GAME.company.cycleRealSeconds, { offline: false });
  ok(s4.energy >= e0, '公司生产不消耗精力', e0 + ' -> ' + s4.energy);
}
