/**
 * 临时探针：股市核心逻辑的手动验证（跑完即删）。
 * 用法: node tools/_probe-stock.js
 */
const C = require('../shared/game-core.js');
const GAME = require('../shared/game-config.js');
const D = require('../shared/decimal.js');

const P = (o) => o.toJSON ? (o.m + 'e' + o.e) : o;

console.log('--- 配置 ---');
console.log('stocks:', GAME.stock.stocks.map((s) => s.id + '/' + s.name).join(', '));

const s = C.createState();
s.money = new D(1e9);
s.realm = 1;
console.log('解锁:', C.stockUnlocked(s), C.stockLockedReason(s));

const st = C.stockById('tianji');
console.log('期秒:', C.stockPeriodSeconds(st), '当前期:', C.stockPeriod(st, 0));

// ---- 自然价确定性 ----
for (const p of [0, 1, 2, 3, 10, 50]) {
  const nat = C.stockNaturalAtPeriod ? C.stockNaturalAtPeriod(s, st, p) : null;
  console.log('  期', p, 'factor', C.stockFactor(st, p).toFixed(4),
    'natural', nat ? nat.m.toFixed(4) + 'e' + nat.e : '-');
}

// ---- 买入推高 ----
s.gameSeconds = 0;   // 第 0 期 = 基准价
const nat0 = C.stockNaturalPrice(s, st);
console.log('自然价(期0):', P(nat0), '现价:', P(C.stockPrice(s, st)));
const q1 = C.stockBuyQuote(s, st, 1000);
console.log('买 1000 股: 冲击', q1.impact.toFixed(4), '均价', P(q1.unitPrice), '总额', P(q1.total));
const r1 = C.buyStock(s, 'tianji', 1000);
console.log('成交:', r1.ok, '持股', C.stockShares(s, 'tianji'), 'flow', C.stockFlow(s, 'tianji'));
console.log('成交后现价:', P(C.stockPrice(s, st)));
console.log('含费均价:', P(C.stockAvgCost(s, 'tianji')));

// ---- 立刻卖出（应亏损）----
const before = s.money;
const sq = C.stockSellQuote(s, st, 1000);
console.log('卖 1000 股: 冲击', sq.impact.toFixed(4), '净收入', P(sq.net));
const r2 = C.sellStock(s, 'tianji', 1000);
console.log('卖出:', r2.ok, '已实现', P(r2.profit), '持股', C.stockShares(s, 'tianji'));
console.log('一轮买卖净变化:', P(s.money.sub(before)), '（应为负）');

// ---- 冲击衰减 ----
s.gameSeconds = 0;
C.buyStock(s, 'tianji', 5000);
console.log('\n买入 5000 后 impact:', C.stockImpact(s, st).toFixed(4));
s.gameSeconds = C.stockPeriodSeconds(st) * 1 + 1;
C.syncStocks(s);
console.log('过 1 期后 flow:', C.stockFlow(s, 'tianji'), 'impact:', C.stockImpact(s, st).toFixed(4));
s.gameSeconds = C.stockPeriodSeconds(st) * 4 + 1;
C.syncStocks(s);
console.log('过 4 期后 flow:', C.stockFlow(s, 'tianji'), 'impact:', C.stockImpact(s, st).toFixed(4));

// ---- 联动 ----
{
  const s2 = C.createState();
  s2.money = new D(1e12);
  s2.realm = 4;
  C.foundCompany(s2);
  const chs = C.stockById('chipsci');
  const chip = C.goodById('chip');
  s2.gameSeconds = C.goodsPeriodSeconds(chip) * 5 + 1;
  const natClean = C.stockNaturalPrice(s2, chs);
  s2.company.pressure.chip = 1;
  s2.company.lastPeriod.chip = C.goodsPeriod(chip, s2.gameSeconds);
  const natBad = C.stockNaturalPrice(s2, chs);
  console.log('\n联动：无抛压自然价', P(natClean), '→ 芯片满抛压', P(natBad),
    '比值', natBad.div(natClean).toNumber().toFixed(4));

  // 未成立公司时压力为 0，联动因子应等于纯行情
  const s3 = C.createState();
  s3.gameSeconds = s2.gameSeconds;
  console.log('未成立公司时自然价:', P(C.stockNaturalPrice(s3, chs)));
}

// ---- 最大可买 ----
{
  const s4 = C.createState();
  s4.money = new D(1e6);
  s4.realm = 1;
  const mb = C.stockMaxBuy(s4, C.stockById('tianji'));
  const q = C.stockBuyQuote(s4, C.stockById('tianji'), mb);
  console.log('\n最大可买', mb, '需', P(q.total), '钱', P(s4.money), '买得起?', q.total.lte(s4.money));
  const q2 = C.stockBuyQuote(s4, C.stockById('tianji'), mb + 1);
  console.log('再买 1 股需', P(q2.total), '买得起?', q2.total.lte(s4.money));
}

// ---- 汇总 + 往返 ----
{
  const sum = C.stockSummary(s);
  console.log('\nsummary: peak', sum.peak.toFixed(4), 'totalValue', P(sum.totalValue),
    'realized', P(sum.realized), 'fee', P(sum.totalFee), 'trades', sum.totalTrades);
  const back = C.hydrate(JSON.parse(JSON.stringify(C.serialize(s))));
  console.log('往返：持股', back.stock.shares.tianji, 'flow', back.stock.flow.tianji,
    'cost', P(back.stock.cost.tianji), 'realized', P(back.stock.realized),
    'lastPeriod', back.stock.lastPeriod.tianji);
}
