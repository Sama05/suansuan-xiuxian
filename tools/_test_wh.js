console.log('\n=== 公司系统 · 维护费不足则停产 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e8);
  C.foundCompany(s);
  for (let i = 0; i < 3; i++) C.buyLine(s, 'mine');
  s.realCompute = new D(1e6);
  C.setAllocation(s, { industry: 1 });

  const up = C.companyUpkeep(s);
  ok(up.total.gt(0), '三条矿井有维护费', up.total.toString());

  s.money = new D(0);                        // 破产
  const a = C.syncCompany(s, GAME.company.cycleRealSeconds * 2, false);
  ok(a.cycles === 2, '周期照常推进', String(a.cycles));
  ok(a.starved === 2, '两个周期都停产', String(a.starved));
  ok(a.revenue.eq(0), '停产周期无收入');
  ok(a.produced === 0, '停产周期无产出');
  ok(s.money.eq(0), '停产不会欠费（金钱不为负）', s.money.toString());
  ok(!s.money.isNeg(), '金钱未被扣成负数');
  ok(C.stockTotal(s) === 0, '停产周期库存不增加');
  ok(s.company.totalUpkeep.eq(0), '停产周期不计维护费');

  // 补上钱后恢复生产
  s.money = new D(1e5);
  const a2 = C.syncCompany(s, GAME.company.cycleRealSeconds, false);
  ok(a2.starved === 0, '补钱后恢复生产');
  ok(a2.revenue.gt(0), '恢复后有收入', a2.revenue.toString());
  ok(a2.upkeep.gt(0), '恢复后正常扣维护费', a2.upkeep.toString());
}

// ============================================================
console.log('\n=== 公司系统 · 仓容与溢仓 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e7);
  C.foundCompany(s);
  C.buyLine(s, 'mine');
  s.realCompute = new D(1e6);
  C.setAllocation(s, { industry: 1 });
  C.setAutoSell(s, false);                   // 关闭自动卖出，才看得到积压

  const cap = C.warehouseCapacity(s);        // 500
  ok(cap === 500, '基础容量 500', String(cap));

  const perCycle = Math.floor(C.companyOutputPerCycle(s).iron_ore);
  const n = Math.floor(cap / perCycle) + 5;
  const a = C.syncCompany(s, GAME.company.cycleRealSeconds * n, false);
  ok(a.cycles === n, '推进 ' + n + ' 个周期', String(a.cycles));
  ok(a.produced === cap, '入库被仓容截断到 500', String(a.produced));
  ok(a.overflow > 0, '超出部分计为溢仓', String(a.overflow));
  ok(C.stockTotal(s) === cap, '库存 = 仓容上限', String(C.stockTotal(s)));
  ok(C.stockOf(s, 'iron_ore') === cap, '积压的是铁矿石', String(C.stockOf(s, 'iron_ore')));
  ok(a.revenue.eq(0), '关闭自动卖出时无收入');

  // 手动清仓
  const g = C.goodById('iron_ore');
  const m0 = s.money;
  const sell = C.sellGoods(s, 'all');
  ok(sell.ok === true, '手动清仓成功', sell.msg);
  ok(sell.revenue.eq(C.goodsPriceWith(s, g).mul(cap)), '清仓收入 = 库存 × 市价',
    sell.revenue.toString());
  ok(s.money.gt(m0), '清仓后金钱增加', m0.toString() + ' -> ' + s.money.toString());
  ok(C.stockTotal(s) === 0, '清仓后库存为 0');
  ok(C.sellGoods(s, 'all').ok === false, '空仓时清仓被拒');

  // 部分卖出
  C.syncCompany(s, GAME.company.cycleRealSeconds * 2, false);
  ok(C.stockOf(s, 'iron_ore') === perCycle * 2, '两周期攒下的件数',
    String(C.stockOf(s, 'iron_ore')));
  const part = C.sellGoods(s, 'iron_ore', 15);
  ok(part.ok === true, '指定数量卖出成功', part.msg);
  ok(C.stockOf(s, 'iron_ore') === perCycle * 2 - 15, '剩余件数正确',
    String(C.stockOf(s, 'iron_ore')));
  ok(part.count === 15, '卖出 15 件');
  ok(part.price.eq(C.goodsPriceWith(s, g)), '按当前市价卖出', part.price.toString());
  ok(part.revenue.eq(C.goodsPriceWith(s, g).mul(15)), '收入 = 数量 × 市价',
    part.revenue.toString());

  // count 省略 = 全部
  const rest = C.sellGoods(s, 'iron_ore');
  ok(rest.count === perCycle * 2 - 15, '省略数量即全卖', String(rest.count));
  ok(C.stockOf(s, 'iron_ore') === 0, '全卖后库存为 0');

  // 异常路径
  C.syncCompany(s, GAME.company.cycleRealSeconds, false);
  const over = C.sellGoods(s, 'iron_ore', 999);
  ok(over.count === perCycle, '数量超过库存时只卖库存', String(over.count));
  ok(C.sellGoods(s, 'iron_ore').ok === false, '库存为 0 时卖出被拒');
  ok(C.sellGoods(s, 'nope').ok === false, '不存在的商品卖出被拒');

  // 未成立公司不能卖
  const raw = C.createState();
  raw.realm = 1;
  ok(C.sellGoods(raw, 'all').ok === false, '未成立公司不能卖出');
  ok(C.setAutoSell(raw, true).ok === false, '未成立公司不能切换自动卖出');
}
