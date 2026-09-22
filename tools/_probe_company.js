/** 临时探针：验证「生产线可换产物 + 算力驱动产能 + 成本传导」。 */
const D = require('../shared/decimal.js');
const G = require('../shared/game-config.js');
const C = require('../shared/game-core.js');

const s = C.createState();
s.realm = 2;
s.money = new D(1e12);
s.devices.pc = 1;
s.devices.workstation = 1;

console.log('--- 1. 成立公司 ---');
console.log(C.foundCompany(s).msg || 'ok', 'founded =', C.companyFounded(s));

console.log('\n--- 2. 买矿井 ×3 ---');
for (let i = 0; i < 3; i++) {
  const r = C.buyLine(s, 'mine');
  if (!r.ok) { console.log('  买失败:', r.msg); break; }
}
const mine = C.lineById('mine');
console.log('  台数', C.lineOwned(s, 'mine'), 'units =', JSON.stringify(C.lineUnits(s, 'mine')));
console.log('  可选产物:', C.lineProducts(mine).map((g) => g.name).join(' / '));

console.log('\n--- 3. 每台独立配置 ---');
C.setLineUnit(s, 'mine', 0, { product: 'iron_ore', rate: 1 });
C.setLineUnit(s, 'mine', 1, { product: 'coal', rate: 0.5 });
C.setLineUnit(s, 'mine', 2, { product: 'rare_earth', rate: 0.2 });
console.log('  units =', JSON.stringify(C.lineUnits(s, 'mine')));
console.log('  批量设为 silica/0.8：', JSON.stringify(C.setLineUnit(s, 'mine', 'all', { product: 'silica', rate: 0.8 })));
console.log('  units =', JSON.stringify(C.lineUnits(s, 'mine')));
console.log('  非法产物应被拒：', JSON.stringify(C.setLineUnit(s, 'mine', 0, { product: 'chip' })));

console.log('\n--- 4. 算力 → 产能 ---');
C.tick(s, 1, { offline: false });   // 先跑一段把 realCompute 刷新出来
console.log('  realCompute =', s.realCompute.toString());
C.setAllocation(s, { xiuxian: 0.5, industry: 0.5 });
console.log('  alloc =', JSON.stringify(s.alloc));
console.log('  工业算力池 =', C.industrialComputePool(s).toString());
console.log('  总需求     =', C.companyComputeDemand(s).toString());
console.log('  供给系数   =', C.companyComputeScale(s).toFixed(4));
console.log('  每周期产出 =', JSON.stringify(C.companyOutputPerCycle(s)));

console.log('\n  把工业份额降到 5%：');
C.setAllocation(s, { xiuxian: 0.95, industry: 0.05 });
console.log('  工业算力池 =', C.industrialComputePool(s).toString());
console.log('  供给系数   =', C.companyComputeScale(s).toFixed(4));
console.log('  每周期产出 =', JSON.stringify(C.companyOutputPerCycle(s)));

console.log('\n--- 5. 成本传导（上游涨价 → 下游成本涨得比售价快）---');
C.setAllocation(s, { xiuxian: 0.5, industry: 0.5 });
const smeltBefore = C.industryCostIndex(s, 'smelt');
const priceBefore = C.industryPriceIndex(s, 'smelt');
console.log('  采掘价格倍数（前）', C.industryPriceRatio(s, 'mining').toFixed(4));
console.log('  冶炼 成本指数', smeltBefore.toFixed(4), ' 售价指数', priceBefore.toFixed(4));

// 传导的输入是「上游商品的 现价/基准价」，所以改基准价没用（分子分母同变），
// 必须让现价偏离基准价 —— 推进期数让行情波动因子动起来即可。
console.log('  （推进期数，观察上游行情如何传导到下游成本与售价）');
for (const p of [1, 5, 9, 14, 21]) {
  s.gameSeconds = p * C.SEC_PER_YEAR + 10;
  const mr = C.industryPriceRatio(s, 'mining');
  const ci = C.industryCostIndex(s, 'smelt');
  const pi = C.industryPriceIndex(s, 'smelt');
  console.log('   期 ' + String(p).padStart(2) +
    '  采掘 ' + mr.toFixed(4) +
    '  冶炼成本 ' + ci.toFixed(4) + '(' + ((ci - 1) * 100).toFixed(2) + '%)' +
    '  售价 ' + pi.toFixed(4) + '(' + ((pi - 1) * 100).toFixed(2) + '%)' +
    '  毛利差 ' + ((pi - ci) * 100).toFixed(2) + '%');
}
const smeltInd = C.industryById('smelt');
console.log('  → passThrough', smeltInd.passThrough, '> pricePass', smeltInd.pricePass,
  '：上游涨时成本涨得比售价快，毛利被压缩；上游跌时反过来');
s.gameSeconds = C.SEC_PER_YEAR * 3;

console.log('\n--- 6. 生产周期跑一遍 ---');
const mineLine = C.lineById('mine');
C.setLineUnit(s, 'mine', 'all', { product: 'iron_ore', rate: 1 });
const before = s.company.cycles;
C.tick(s, 60, { offline: false });
console.log('  60 秒后周期数', s.company.cycles, '(前', before + ')');
console.log('  库存 iron_ore =', s.company.stock.iron_ore || 0);
console.log('  累计维护费 =', s.company.totalUpkeep.toString());
console.log('  累计收入   =', s.company.totalRevenue.toString());

console.log('\n--- 7. 存档往返 ---');
const raw = C.serialize(s);
const h = C.hydrate(raw);
console.log('  units 往返一致:', JSON.stringify(h.company.lines.mine) === JSON.stringify(s.company.lines.mine));
console.log('  老结构（数字）迁移:', JSON.stringify(C.hydrate(Object.assign({}, raw, {
  company: Object.assign({}, raw.company, { lines: { workshop: 4, mine: 2 } }),
})).company.lines.mine));

console.log('\n--- 8. 股市榜单 ---');
const sum = C.stockSummary(s);
console.log('  池子总数', sum.totalListed, ' 榜单', sum.board.length);
console.log('  前 10：');
for (const b of sum.board) {
  console.log('   ', b.code.padEnd(10), b.name.padEnd(6), b.kind === 'xiuxian' ? '宗门' : '科技',
    '主营:', b.business, ' 市值', b.marketCap.toString());
}
