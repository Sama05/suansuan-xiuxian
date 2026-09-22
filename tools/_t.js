const D = require('../shared/decimal.js');
const G = require('../shared/game-config.js');
const C = require('../shared/game-core.js');

// Decimal 负数比较自检
const a = new D(-2600);
const b = new D(-1300);
console.log('D(-2600).lte(D(-1300)) =', a.lte(b), ' 应为 true');
console.log('D(-2600).lt(D(-1300)) =', a.lt(b), ' 应为 true');
console.log('a.m,e =', a.m, a.e, '  b.m,e =', b.m, b.e);

const s = C.createState();
s.realm = 1;
s.money = new D(1e12);
const tianji = C.stockById('tianji');
const chipsci = C.stockById('chipsci');
console.log('buy tianji:', JSON.stringify(C.buyStock(s, tianji.id, 3000).ok));
console.log('buy chipsci:', JSON.stringify(C.buyStock(s, chipsci.id, 50).ok));
const sum = C.stockSummary(s);
for (const x of sum.stocks) {
  if (x.shares <= 0) continue;
  console.log('\n' + x.name, 'shares', x.shares);
  console.log('  value    =', x.value.toString(), x.value.toNumber());
  console.log('  liqValue =', x.liquidateValue.toString(), x.liquidateValue.toNumber());
  console.log('  cost     =', x.cost.toString(), x.cost.toNumber());
  console.log('  pnl      =', x.pnl.toString(), x.pnl.toNumber());
  console.log('  liqPnl   =', x.liquidatePnl.toString(), x.liquidatePnl.toNumber());
  console.log('  liqPnl.lte(pnl) =', x.liquidatePnl.lte(x.pnl));
  console.log('  liqVal.lte(value) =', x.liquidateValue.lte(x.value));
}
