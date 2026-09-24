/**
 * 核心逻辑临时自检（修仙线 + 公司线）—— 验证：
 *   1. 买个人电脑前：无功法、灵气恒为 0
 *   2. 买个人电脑后：自动习得第一本功法，灵气开始产出
 *   3. 神识随境界成长，且放大实际算力
 *   4. 修炼涨熟练度、参悟消耗灵气换熟练度
 *   5. 熟练度圆满后被动转常驻，切换功法不丢
 *   6. 科技修仙设备需要「金钱 + 灵石」双造价
 *   7. 存档往返与旧存档迁移
 *   8. 公司（产业）：注册门槛 / 生产线解锁链 / 维护费 / 周期结算 / 停产 / 仓库溢仓 /
 *      市价确定性 / 离线折算 / 不消耗精力
 *   9. 公司存档往返与超容库存裁剪
 *  10. 市场抛压：砸库存压价、逐期恢复、价格下限
 *  11. 股市（证券账户）：开户门槛 / 价格三层构成 / 冲击反作用 / 「一轮买卖必亏」 /
 *      flow 逐期衰减 / 与公司商品联动 / 概览与存档往返与越界裁剪
 */
const Core = require('../shared/game-core.js');
const GAME = require('../shared/game-config.js');
const D = require('../shared/decimal.js');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}

console.log('\n[1] 买电脑之前：没有功法，灵气恒为 0');
let s = Core.createState();
ok('初始无功法', s.technique === null);
ok('初始 learned 为空', Object.keys(s.learned).length === 0);
ok('requireForSpirit 已打开', GAME.techniques.requireForSpirit === true);
ok('神识不为 0（一开始就有）', Core.totalShenshi(s) > 0, Core.totalShenshi(s));
Core.tick(s, 600, {});
ok('60 秒后灵气仍为 0', s.qi.isZero(), s.qi.toString());
ok('60 秒后仍无功法', s.technique === null);

console.log('\n[2] 买下个人电脑 → 自动习得第一本功法 → 灵气开始产出');
s.money = new D(1e6);
const r1 = Core.buyDevice(s, 'pc');
ok('购买成功', r1.ok === true, r1.msg);
ok('习得了功法', s.technique !== null, s.technique);
ok('第一本是九章算经', s.technique === 'jiuzhang', s.technique);
// v3.4：成就条件功法（筹算小术 jobsDone=3 / 几何原本 jobsDone=15 等）在买电脑前
// 可能已经达成条件，第一本入手后会被立即补发 —— 所以 learned 数 ≥ 1 即可，
// 关键是「当前修炼的那本」必须是九章算经。
ok('learned 至少 1 本且含九章算经',
  Object.keys(s.learned).length >= 1 && !!s.learned.jiuzhang,
  Object.keys(s.learned));
const qiBefore = s.qi.toNumber();
Core.tick(s, 600, {});
ok('灵气开始增长', s.qi.toNumber() > qiBefore, qiBefore + ' → ' + s.qi.toNumber());
ok('qiMultiplier > 1', Core.qiMultiplier(s) > 1, Core.qiMultiplier(s));

console.log('\n[3] 神识随境界成长并放大实际算力');
const sh0 = Core.totalShenshi(s);
s.realm = 4;
const sh4 = Core.totalShenshi(s);
ok('元婴神识 > 凡人神识', sh4 > sh0, sh0 + ' → ' + sh4);
ok('境界基础神识来自配置', Core.shenshiBase(s) === 100, Core.shenshiBase(s));
const rawC = Core.totalCompute(s);
const realC = Core.realComputeOf(s).toNumber();
ok('实际算力 > 原始算力（神识乘区）', realC > rawC.toNumber(), rawC.toString() + ' → ' + realC);
// 分层阻尼：境界那一份线性、设备那一份按对数收敛（见 game-config.shenshi）
const parts = Core.shenshiParts(s);
const expectMul = 1 + parts.realmPart * GAME.shenshi.computePerPointRealm
  * (1 + GAME.shenshi.computeDeviceLogK * Math.log(parts.deviceMul));
ok('算力乘区符合分层公式（境界线性 × 设备对数收敛）',
  Math.abs(realC / rawC.toNumber() - expectMul) < 1e-6, expectMul);
// f(1) = 1 —— 没有设备时与旧线性口径完全一致，前期手感不变
const bare = Core.createState();
bare.realm = 4;
const bareMul = Core.shenshiComputeMultiplier(bare);
ok('无设备时与旧口径一致（f(1) = 1）',
  Math.abs(bareMul - (1 + Core.shenshiBase(bare) * GAME.shenshi.computePerPointRealm)) < 1e-9,
  bareMul);

console.log('\n[3b] 兵解 · 转生');
{
  const r = Core.createState();
  ok('未达元婴时兵解被拒', Core.doRebirth(r).ok === false, Core.rebirthLockedReason(r));
  ok('未兵解过时转生衰减指数 = 1（不能把 base 当成常驻指数）',
    Core.rebirthDiscount(r) === 1, Core.rebirthDiscount(r));
  ok('衰减指数序列：1 次 0.50 / 2 次 0.53 / 封顶 0.75',
    Core.rebirthFactorAt(1) === 0.5 && Core.rebirthFactorAt(2) === 0.53
    && Core.rebirthFactorAt(999) === 0.75,
    [1, 2, 999].map(Core.rebirthFactorAt).join(' / '));

  // 造一个「什么都有」的元婴存档，逐项验证兵解前后
  r.realm = 4;
  r.money = new D(1e15);
  for (const d of GAME.devices) r.devices[d.id] = 5;
  Core.foundCompany(r);
  Core.buyLine(r, 'mine');
  r.company.warehouseLevel = 5;
  r.company.stock[GAME.company.goods[0].id] = 100;
  r.company.cycles = 42;
  r.stock.shares[GAME.stock.stocks[0].id] = 1000;
  r.stock.cost[GAME.stock.stocks[0].id] = new D(5e4);
  r.stock.realized = new D(1234);
  r.learned['jiuzhang'] = { mastery: 5000, tier: 4, passive: true };
  r.technique = 'jiuzhang';
  r.qi = new D(1e9);
  r.spiritStone = new D(999);
  r.playTime = 12345;
  r.gameSeconds = 67890;

  const devBefore = r.devices.pc;
  // 兵解前先记一次实际算力与设备算力，兵解后用来验证「转生折扣确实生效」
  const realBefore = Core.realComputeOf(r).toNumber();
  const devComputeBefore = Core.totalCompute(r).toNumber();
  const gain = Core.rebirthDaoGain(r, 'active');
  ok('道行只认境界与次数，不认资产总量', gain === 100, gain);
  ok('被动兵解打三折前的原始值 = 100', Core.rebirthDaoGain(r, 'passive') === 30,
    Core.rebirthDaoGain(r, 'passive'));

  const res = Core.doRebirth(r);
  ok('元婴可以兵解', res.ok === true, res.msg || '');

  // —— 清空项 ——
  ok('境界归零', r.realm === 0);
  ok('灵气清零', r.qi.toNumber() === 0);
  ok('金钱回到起手值', r.money.toNumber() === GAME.base.startMoney, r.money.toNumber());
  ok('灵石清零', r.spiritStone.toNumber() === 0);
  ok('公司注册状态被清', r.company.founded === false);
  ok('生产线被清空', r.company.lines.mine === 0, JSON.stringify(r.company.lines.mine));
  ok('仓库等级归零', r.company.warehouseLevel === 0);
  ok('库存清空', Core.stockTotal(r) === 0, Core.stockTotal(r));
  ok('公司累计统计归零', r.company.cycles === 0 && r.company.totalRevenue.toNumber() === 0);
  ok('股市持仓清空', r.stock.shares[GAME.stock.stocks[0].id] === 0);
  ok('股市统计归零', r.stock.totalTrades === 0 && r.stock.realized.toNumber() === 0);

  // —— 保留项 ——
  ok('设备保留', r.devices.pc === devBefore, r.devices.pc);
  ok('功法本体保留', !!r.learned['jiuzhang']);
  ok('熟练度进度清空', r.learned['jiuzhang'].mastery === 0);
  ok('熟练度段位保留', r.learned['jiuzhang'].tier === 4, r.learned['jiuzhang'].tier);
  ok('被动常驻保留', r.learned['jiuzhang'].passive === true);
  ok('游戏内时间不倒退', r.gameSeconds === 67890, r.gameSeconds);
  ok('行情时钟不倒退', r.playTime === 12345, r.playTime);

  // —— 转生衰减 ——
  ok('兵解后衰减指数 = 0.50', Core.rebirthDiscount(r) === 0.5, Core.rebirthDiscount(r));
  ok('衰减按**数量级**生效（幂，不是乘法）—— 至少砍掉 6 个数量级',
    Core.deviceComputeEffective(r).toNumber() < Core.totalCompute(r).toNumber() / 1e6,
    Core.deviceComputeEffective(r).toString() + ' vs ' + Core.totalCompute(r).toString());
  ok('设备数据本身不减（衰减只在计算时生效，不删玩家的设备）',
    Core.totalCompute(r).toNumber() === devComputeBefore, Core.totalCompute(r).toNumber());
  ok('兵解后实际算力显著下降（境界归零 + 转生衰减双重作用）',
    Core.realComputeOf(r).toNumber() < realBefore * 1e-3,
    Core.realComputeOf(r).toNumber() + ' < ' + (realBefore * 1e-3).toExponential(2));

  // —— 道行 ——
  ok('道行已入账', r.rebirth.dao === 100, r.rebirth.dao);
  ok('累计道行只增', r.rebirth.daoTotal === 100, r.rebirth.daoTotal);
  ok('兵解记录已写入', r.rebirth.history.length === 1);
  ok('第二次兵解道行递增（100 → 160）',
    Core.rebirthSummary(r).daoGain === 160, String(Core.rebirthSummary(r).daoGain));
  ok('被动（渡劫失败）为主动的三折', Core.rebirthSummary(r).daoGainPassive === 48,
    String(Core.rebirthSummary(r).daoGainPassive));

  // —— 道行加成 ——
  const b1 = Core.buyPerk(r, 'shenshi');
  ok('可以买道行加成', b1.ok === true, b1.msg || '');
  ok('买后境界基础神识 +5', Core.shenshiBase(r) === 1 + 5, Core.shenshiBase(r));
  ok('等级已提升', Core.perkLevel(r, 'shenshi') === 1);
  const b2 = Core.buyPerk(r, 'shenshi');   // 第二级 40×1.8 = 72 > 剩余 60
  ok('道行不足时拒绝', b2.ok === false, b2.msg);
  ok('不存在的加成被拒', Core.buyPerk(r, 'nope').ok === false);
  ok('加成落到了精力上限上', Core.maxEnergy(r) === (GAME.realms[0].maxEnergy) * (
    1 + Core.passiveBonus(r, 'energyMax')) * (1 + Core.perkValue(r, 'energyMax')),
    Core.maxEnergy(r));

  // —— 存档往返 ——
  const back = Core.hydrate(Core.serialize(r));
  ok('转生存档往返一致',
    back.rebirth.count === 1 && back.rebirth.dao === r.rebirth.dao
    && back.rebirth.perks.shenshi === 1, JSON.stringify(back.rebirth.perks));
  ok('衰减参与存档往返', Core.rebirthDiscount(back) === 0.5, Core.rebirthDiscount(back));

  // —— hydrate 夹取（防手改存档）——
  const cheat = Core.serialize(r);
  cheat.rebirth.perks.shenshi = 9999;
  cheat.rebirth.dao = 1e9;
  cheat.rebirth.daoTotal = 10;
  const hc = Core.hydrate(cheat);
  ok('加成等级被夹到硬上限', hc.rebirth.perks.shenshi === 8, hc.rebirth.perks.shenshi);
  ok('未分配道行被夹到 daoTotal 以内', hc.rebirth.dao === 10, hc.rebirth.dao);
}

console.log('\n[4] 修炼涨熟练度 / 参悟消耗灵气换熟练度');
s = Core.createState();
s.money = new D(1e9);
Core.buyDevice(s, 'pc');
const m0 = s.learned['jiuzhang'].mastery;
Core.tick(s, 100, {});
ok('自动修炼涨熟练度', s.learned['jiuzhang'].mastery > m0,
  m0 + ' → ' + s.learned['jiuzhang'].mastery);
ok('修炼使段位提升', s.learned['jiuzhang'].tier >= 1, s.learned['jiuzhang'].tier);
s.cultivating = false;
const mStop = s.learned['jiuzhang'].mastery;
Core.tick(s, 100, {});
ok('停止修炼后熟练度不变', s.learned['jiuzhang'].mastery === mStop);
ok('修炼速度受神识影响', Core.cultivateSpeed(s) > GAME.techniques.cultivate.pointsPerSecond,
  Core.cultivateSpeed(s));

s.qi = new D(1e7);
const cost = Core.comprehendCost(s);
const cr = Core.comprehend(s, 1);
ok('参悟成功', cr.ok === true, cr.msg);
ok('参悟消耗了灵气', Math.abs(s.qi.toNumber() - (1e7 - cost.toNumber())) < 1, s.qi.toString());
ok('参悟给了熟练度', cr.gain > 0, cr.gain);

console.log('\n[5] 熟练度圆满 → 被动转常驻 → 切换功法不丢');
const rec = s.learned['jiuzhang'];
Core.addMastery(s, 'jiuzhang', 1e6);
ok('熟练度封顶', rec.mastery === GAME.techniques.mastery[5].need, rec.mastery);
ok('段位到圆满', rec.tier === 5, rec.tier);
ok('被动已转常驻', rec.passive === true);
ok('money 被动生效', Core.passiveBonus(s, 'money') > 0, Core.passiveBonus(s, 'money'));
s.realm = 1;
Core.learnTechniques(s);
ok('炼气后自动习得第二本', !!s.learned['daishu'], Object.keys(s.learned));
Core.addMastery(s, 'daishu', 1e6);
ok('energyMax 被动生效（精力上限被抬高）',
  Core.maxEnergy(s) > GAME.realms[1].maxEnergy, Core.maxEnergy(s));
ok('切到第二本后 money 被动仍在', (function () {
  Core.setTechnique(s, 'daishu');
  return Core.passiveBonus(s, 'money') > 0;
})());
ok('当前功法已切换', s.technique === 'daishu', s.technique);
ok('原功法熟练度保留', s.learned['jiuzhang'].mastery === GAME.techniques.mastery[5].need);

console.log('\n[6] 科技修仙设备需要金钱 + 灵石双造价');
s = Core.createState();
s.money = new D(1e30);
s.spiritStone = new D(0);
const dev = GAME.devices.find((d) => d.id === 'spiritrack');
ok('该设备有灵石造价', Core.deviceStoneCost(s, dev).gt(0), Core.deviceStoneCost(s, dev).toString());
const r2 = Core.buyDevice(s, 'spiritrack');
ok('灵石不足时购买失败', r2.ok === false, r2.msg);
s.spiritStone = new D(1e6);
const r3 = Core.buyDevice(s, 'spiritrack');
ok('灵石足够时购买成功', r3.ok === true, r3.msg);
ok('购买后神识被大幅放大', Core.totalShenshi(s) > Core.shenshiBase(s) * 1.4,
  Core.totalShenshi(s));
const stoneBefore = s.spiritStone.toNumber();
Core.tick(s, 600, {});
ok('设备产出灵石', s.spiritStone.toNumber() > stoneBefore, s.spiritStone.toNumber());

console.log('\n[7] 存档往返与旧存档迁移');
s = Core.createState();
s.money = new D(1e6);
Core.buyDevice(s, 'pc');
Core.tick(s, 300, {});
s.qi = new D(1234);
s.spiritStone = new D(77);
Core.setTechnique(s, 'jiuzhang');
const snap = Core.serialize(s);
const s2 = Core.hydrate(snap);
ok('灵气往返一致', Math.abs(s2.qi.toNumber() - 1234) < 1e-9, s2.qi.toNumber());
ok('灵石往返一致', Math.abs(s2.spiritStone.toNumber() - 77) < 1e-9, s2.spiritStone.toNumber());
ok('learned 往返一致', s2.learned['jiuzhang'] !== undefined);
ok('technique 往返一致', s2.technique === 'jiuzhang');
const legacy = Core.serialize(Core.createState());
delete legacy.qi;
delete legacy.learned;
delete legacy.technique;
delete legacy.cultivating;
legacy.spiritStone = new D(9999).toJSON();
const s3 = Core.hydrate(legacy);
ok('旧存档 spiritStone 迁移到 qi', Math.abs(s3.qi.toNumber() - 9999) < 1e-9, s3.qi.toNumber());
ok('迁移后灵石归零', s3.spiritStone.isZero(), s3.spiritStone.toString());

console.log('\n[8] 公司（产业）');
s = Core.createState();
ok('初始未成立公司', !Core.companyFounded(s));
ok('凡人不能注册', !Core.companyUnlocked(s));
ok('给出门槛原因', Core.companyLockedReason(s).indexOf('炼气') >= 0, Core.companyLockedReason(s));
s.realm = 1;
s.money = new D(1e8);
ok('炼气后可以注册', Core.companyUnlocked(s), Core.companyLockedReason(s));
const f = Core.foundCompany(s);
ok('注册成功', f.ok === true, f.msg);
ok('注册扣费 5 万', Math.abs(s.money.toNumber() - (1e8 - 5e4)) < 1e-6, s.money.toString());

ok('炼钢厂初始锁定', !Core.lineUnlocked(s, Core.lineById('smelter')));
ok('炼钢厂给出前置原因',
  Core.lineLockedReason(s, Core.lineById('smelter')).indexOf('矿井') >= 0,
  Core.lineLockedReason(s, Core.lineById('smelter')));
ok('购买矿井', Core.buyLine(s, 'mine').ok === true);
for (let i = 0; i < 4; i++) Core.buyLine(s, 'mine');
ok('5 条后解锁炼钢厂', Core.lineUnlocked(s, Core.lineById('smelter')));

// 买线只拿到产能上限，转起来要靠「工业产能」投向拨的算力
s.realCompute = new D(1e8);
Core.setAllocation(s, { industry: 1 });
ok('工业算力池 = 算力 × 份额', Core.industrialComputePool(s).eq(new D(1e8)),
  Core.industrialComputePool(s).toString());
ok('算力充足时不削减', Core.companyComputeScale(s) === 1, Core.companyComputeScale(s));

const up = Core.companyUpkeep(s);
ok('维护费 = 原料 + 人工', up.total.eq(up.material.add(up.labor)), up.total.toString());
ok('5 台开工后有维护费', up.total.gt(0), up.total.toString());
const outMap = Core.companyOutputPerCycle(s);
const outN = Object.keys(outMap).reduce((n, k) => n + outMap[k], 0);
ok('5 台矿井都有产出', outN > 0, JSON.stringify(outMap));
const gross = Core.companyCycleGross(s);
const net = Core.companyCycleNet(s);
const yieldRate = net.div(gross).toNumber();
ok('净收益率约 70%', yieldRate > 0.65 && yieldRate < 0.75, yieldRate.toFixed(4));

// 周期结算
s.money = new D(1e6);
const mBefore = s.money.toNumber();
const acc = Core.syncCompany(s, GAME.company.cycleRealSeconds, false);
ok('满一周期结算 1 次', acc.cycles === 1, acc.cycles);
ok('产出入库', acc.produced === Math.min(Math.floor(outN), Core.warehouseCapacity(s)), acc.produced + ' / ' + outN + '（仓容 ' + Core.warehouseCapacity(s) + '）');
ok('默认自动卖出', acc.revenue.gt(0), acc.revenue.toString());
ok('金钱 = 初始 − 维护费 + 收入',
  Math.abs(s.money.toNumber() - (mBefore - up.total.toNumber() + acc.revenue.toNumber())) < 1e-6,
  s.money.toString());
ok('自动卖出后库存清零', Core.stockTotal(s) === 0, Core.stockTotal(s));

// 停产：钱不够不欠费
s.money = new D(0);
const acc2 = Core.syncCompany(s, GAME.company.cycleRealSeconds, false);
ok('钱不够时停产', acc2.starved === 1, acc2.starved);
ok('停产无收入', acc2.revenue.eq(0));
ok('停产不欠费（不为负）', !s.money.isNeg(), s.money.toString());

// 仓库与溢仓
s.money = new D(1e7);
ok('仓库初始容量 500', Core.warehouseCapacity(s) === 500, Core.warehouseCapacity(s));
ok('扩容成功', Core.upgradeWarehouse(s).ok === true);
ok('扩容后容量 1100', Core.warehouseCapacity(s) === 1100, Core.warehouseCapacity(s));
Core.setAutoSell(s, false);
const cyc = GAME.company.cycleRealSeconds;
const acc3 = Core.syncCompany(s, cyc * 60, false);
ok('入库被仓容截断', acc3.produced === 1100, acc3.produced);
ok('超出部分计为溢仓', acc3.overflow > 0, acc3.overflow);
ok('库存 = 仓容上限', Core.stockTotal(s) === 1100, Core.stockTotal(s));

// 市价确定性
const chip = Core.goodById('chip');
ok('开市按基准价', Core.goodsPrice(chip, 0).eq(new D(chip.basePrice)),
  Core.goodsPrice(chip, 0).toString());
ok('同一时刻可复现', Core.goodsPrice(chip, 12345).eq(Core.goodsPrice(chip, 12345)));
ok('开市无涨跌', Core.goodsTrend(chip, 0) === 'flat', Core.goodsTrend(chip, 0));
const lenComp = Core.goodsPeriodSeconds(Core.goodById('component'));
const lenTal = Core.goodsPeriodSeconds(Core.goodById('wind_talis'));
ok('修仙类变价周期是科技类的 10 倍', lenTal === lenComp * 10, lenTal + ' / ' + lenComp);
let inRange = true;
for (let p = 1; p <= 60; p++) {
  const fac = Core.goodsPrice(chip, p * lenComp).div(new D(chip.basePrice)).toNumber();
  if (fac < chip.minFactor - 1e-9 || fac > chip.maxFactor + 1e-9) inRange = false;
}
ok('市价始终在配置区间内', inRange);

// 离线：按 30% 折算
const s4 = Core.createState();
s4.realm = 1;
s4.money = new D(1e7);
Core.foundCompany(s4);
Core.buyLine(s4, 'mine');
const offAcc = Core.syncCompany(s4, 100, true);
const onAcc = Core.syncCompany(s4, 100, false);
ok('离线 100 秒 = 1 周期', offAcc.cycles === 1, offAcc.cycles);
ok('在线 100 秒 = 5 周期', onAcc.cycles === 5, onAcc.cycles);
ok('离线产出少于在线', offAcc.cycles < onAcc.cycles);

// 公司不吃精力
const s5 = Core.createState();
s5.realm = 1;
s5.money = new D(1e7);
Core.setWorking(s5, false);
Core.foundCompany(s5);
Core.buyLine(s5, 'mine');
const e0 = s5.energy;
Core.tick(s5, GAME.company.cycleRealSeconds, {});
ok('公司生产不消耗精力', s5.energy >= e0, e0 + ' → ' + s5.energy);

console.log('\n[9] 公司存档往返');
const snap2 = Core.serialize(s);
const back2 = Core.hydrate(JSON.parse(JSON.stringify(snap2)));
ok('founded 往返一致', Core.companyFounded(back2));
ok('仓库等级往返一致', Core.warehouseLevel(back2) === Core.warehouseLevel(s));
ok('生产线数量往返一致',
  Core.lineOwned(back2, 'mine') === Core.lineOwned(s, 'mine'));
ok('周期计数往返一致', back2.company.cycles === s.company.cycles);
ok('累计营业额往返一致', back2.company.totalRevenue.eq(s.company.totalRevenue));
const forged = JSON.parse(JSON.stringify(snap2));
forged.company.stock.component = 999999;
ok('超容库存被裁剪', Core.stockTotal(Core.hydrate(forged)) <= Core.warehouseCapacity(s),
  Core.stockTotal(Core.hydrate(forged)) + ' / ' + Core.warehouseCapacity(s));

console.log('\n[10] 市场抛压（卖出影响下一期）');
{
  const MK = GAME.company.market;
  const g = Core.goodById('component');
  const per = Core.goodsPeriodSeconds(g);

  const mk = () => {
    const st = Core.createState();
    st.realm = 4;
    st.money = new D(1e12);
    Core.foundCompany(st);
    for (let i = 0; i < 5; i++) Core.buyLine(st, 'mine');
    return st;
  };

  ok('配置含 market', !!MK && MK.maxDrop > 0 && MK.decay >= 0 && MK.floor > 0,
    JSON.stringify(MK));

  // 正常经营：产多少卖多少 → 不该被罚
  {
    const st = mk();
    st.playTime = per * 3 + 1;
    st.company.lastPeriod.component = 2;
    st.company.producedThisPeriod.component = 400;
    st.company.soldThisPeriod.component = 400;
    Core.syncMarket(st);
    ok('产多少卖多少不产生抛压', Core.pressureOf(st, 'component') === 0,
      String(Core.pressureOf(st, 'component')));
  }

  // 砸库存 → 下一期压价
  {
    const st = mk();
    st.playTime = per * 3 + 1;
    st.company.lastPeriod.component = 2;
    st.company.producedThisPeriod.component = 0;
    st.company.soldThisPeriod.component = 900;
    const natural = Core.naturalPrice(g, st.playTime, st);
    const before = Core.goodsPriceWith(st, g);
    ok('结算前价格 = 自然价', before.eq(natural), before.toString());

    Core.syncMarket(st);
    const pr = Core.pressureOf(st, 'component');
    ok('砸盘后抛压满档', pr > 0.99, String(pr));

    const after = Core.goodsPriceWith(st, g);
    ok('价格被压低到 (1 − maxDrop)', after.lt(natural), after.toString());
    ok('折价幅度 = maxDrop',
      Math.abs(Core.marketDropRatio(st, g) - MK.maxDrop) < 1e-9,
      Core.marketDropRatio(st, g).toFixed(4));

    // 逐期恢复
    const p1 = Core.pressureOf(st, 'component');
    st.playTime += per;
    Core.syncMarket(st);
    ok('无新抛售时压力按 decay 衰减',
      Math.abs(Core.pressureOf(st, 'component') - p1 * MK.decay) < 1e-9,
      Core.pressureOf(st, 'component').toFixed(6));

    // 下限兜底
    st.company.pressure.component = 1;
    let lowest = null;
    for (let p = 1; p <= 200; p++) {
      st.playTime = per * p + 1;
      const v = Core.goodsPriceWith(st, g);
      if (lowest === null || v.lt(lowest)) lowest = v;
    }
    ok('价格不低于 floor × 基准价', lowest.gte(Core.marketFloorPrice(g)),
      lowest.toString() + ' >= ' + Core.marketFloorPrice(g).toString());
  }

  // 成交价必须用带抛压的市价
  {
    const st = mk();
    st.playTime = per * 4 + 1;
    st.company.pressure.component = 1;
    st.company.stock.component = 20;
    const r = Core.sellGoods(st, 'component');
    ok('成交价 = 带抛压的市价', r.price.eq(Core.goodsPriceWith(st, g)), r.price.toString());
    ok('成交价低于自然价', r.price.lt(Core.naturalPrice(g, st.playTime)),
      r.price.toString() + ' < ' + Core.naturalPrice(g, st.playTime).toString());
  }

  // 存档往返 + 夹取
  {
    const st = mk();
    st.playTime = per * 5 + 1;
    st.company.pressure.component = 0.42;
    st.company.lastPeriod.component = 4;
    const b = Core.hydrate(JSON.parse(JSON.stringify(Core.serialize(st))));
    ok('抛压往返一致', Math.abs(Core.pressureOf(b, 'component') - 0.42) < 1e-12,
      String(Core.pressureOf(b, 'component')));

    const neg = JSON.parse(JSON.stringify(Core.serialize(st)));
    neg.company.pressure.component = -1;
    ok('负抛压被夹到 0', Core.pressureOf(Core.hydrate(neg), 'component') === 0);

    const ahead = JSON.parse(JSON.stringify(Core.serialize(st)));
    ahead.company.lastPeriod.component = 99999;
    const ha = Core.hydrate(ahead);
    ok('超前 lastPeriod 被夹回当前期',
      ha.company.lastPeriod.component <= Core.goodsPeriod(g, ha.playTime),
      String(ha.company.lastPeriod.component));
  }
}

console.log('\n[11] 股市（证券账户）');
{
  const SK = GAME.stock;
  const tianji = Core.stockById('tianji');
  const chipsci = Core.stockById('chipsci');
  const per = Core.stockPeriodSeconds(tianji);

  ok('配置含 stock', !!SK && SK.implemented === true, JSON.stringify({
    fee: SK.fee, minOrder: SK.minOrder, flowDecay: SK.flowDecay,
    maxRise: SK.maxRise, maxDrop: SK.maxDrop, linkWeight: SK.linkWeight,
  }));
  // v3.6 起池子 100 家：老 50 家（30 科技 + 20 宗门）+ 50 家融合赛道（元婴解锁）
  ok('池子里 100 家公司（50 基础 + 50 融合赛道）', (SK.stocks || []).length === 100, (SK.stocks || []).length);

  const mk = () => {
    const st = Core.createState();
    st.realm = 1;
    st.money = new D(1e12);
    return st;
  };

  // 开户门槛
  ok('凡人未开户', Core.stockUnlocked(Core.createState()) === false);
  ok('给出开户门槛原因', Core.stockLockedReason(Core.createState()).indexOf('炼气') >= 0,
    Core.stockLockedReason(Core.createState()));
  ok('炼气后开户', Core.stockUnlocked(mk()) === true);

  // 价格构成
  {
    const st = mk();
    st.playTime = 0;
    ok('第 0 期按基准价挂牌',
      Core.stockNaturalPrice(st, tianji).eq(new D(tianji.basePrice)),
      Core.stockNaturalPrice(st, tianji).toString());
    ok('不交易时冲击为 1', Core.stockImpact(st, tianji) === 1);
    ok('不交易时成交价 = 自然价',
      Core.stockPrice(st, tianji).eq(Core.stockNaturalPrice(st, tianji)));
    ok('同一时刻可复现',
      Core.stockNaturalPrice(st, tianji, per * 7 + 3)
        .eq(Core.stockNaturalPrice(st, tianji, per * 7 + 3)));

    // 只持仓不交易 → 价格一点都不动（防自抬轿子套利的关键性质）
    st.stock.shares[tianji.id] = 200000;
    ok('只持仓不交易时冲击仍为 1（不会自己抬价）', Core.stockImpact(st, tianji) === 1);
    st.stock.shares[tianji.id] = 0;
  }

  // 买入：成交按「成交之后」的冲击价结算
  {
    const st = mk();
    const pxBefore = Core.stockPrice(st, tianji);
    const q = Core.stockBuyQuote(st, tianji, 20000);
    ok('买入报价成立', q.ok === true, q.msg);
    ok('买入冲击系数 > 1', q.impact > 1, q.impact.toFixed(6));
    ok('成交价高于成交前市场价（买高）', q.unitPrice.gt(pxBefore),
      q.unitPrice.toString() + ' > ' + pxBefore.toString());

    const m0 = st.money;
    const b = Core.buyStock(st, tianji.id, 20000);
    ok('买入成功', b.ok === true, b.msg);
    ok('扣款 = 成交额 + 手续费', st.money.eq(m0.sub(q.total)),
      st.money.toString() + ' = ' + m0.sub(q.total).toString());
    ok('股数入账 20000', Core.stockShares(st, tianji.id) === 20000);
    ok('净买入流记账', Core.stockFlow(st, tianji.id) === 20000);
    ok('持仓成本含手续费', Core.stockCost(st, tianji.id).eq(q.total));
    ok('成交笔数 +1', st.stock.totalTrades === 1);
    ok('累计手续费记账', st.stock.totalFee.eq(q.fee));

    // 拒绝路径
    ok('不足最小成交额被拒', Core.buyStock(st, tianji.id, 1).ok === false);
    ok('超过流通盘被拒',
      Core.buyStock(st, tianji.id, Core.stockDepth(tianji)).ok === false
      || Core.buyStock(st, tianji.id, Core.stockDepth(tianji)).msg.indexOf('流通盘') >= 0);
    ok('未知股票被拒', Core.buyStock(st, '不存在', 10000).ok === false);
    const poor = mk();
    poor.money = new D(1);
    ok('金钱不足被拒', Core.buyStock(poor, tianji.id, 10000).ok === false);
  }

  // 「一轮买卖必亏」——本作最关键的经济性质
  {
    const st = mk();
    const m0 = st.money;
    Core.buyStock(st, tianji.id, 20000);
    const r = Core.sellStock(st, tianji.id, 20000);
    ok('卖出成功', r.ok === true, r.msg);
    ok('买入后立刻卖回：本笔盈亏为负', r.profit.isNeg(), r.profit.toString());
    ok('一轮买卖后金钱变少', st.money.lt(m0),
      st.money.toString() + ' < ' + m0.toString());
    ok('已实现盈亏已累计', st.stock.realized.eq(r.profit));
    ok('清仓后持仓成本归零', Core.stockCost(st, tianji.id).isZero());
    ok('无持仓时市值为 0', Core.stockHoldingValue(st, tianji).isZero());
  }

  // 卖出之所以「卖低」：手里有货、本期没有买入流
  {
    const st = mk();
    st.stock.shares[tianji.id] = 20000;
    st.stock.cost[tianji.id] = new D(0);
    st.stock.flow[tianji.id] = 0;
    const q = Core.stockSellQuote(st, tianji, 20000);
    ok('卖出冲击系数 < 1', q.impact < 1, q.impact.toFixed(6));
    ok('成交价低于成交前市场价（卖低）', q.unitPrice.lt(Core.stockPrice(st, tianji)),
      q.unitPrice.toString());
    ok('卖得越多均价越低',
      Core.stockSellQuote(st, tianji, 5000).unitPrice
        .gt(Core.stockSellQuote(st, tianji, 20000).unitPrice));
  }

  // flow 每期衰减 → 买出来的溢价一定会退回去
  {
    const st = mk();
    Core.buyStock(st, tianji.id, 20000);
    st.playTime = per * 4 + 1;
    Core.syncStocks(st);
    const decay = SK.flowDecay;
    ok('flow = trunc(原值 × flowDecay^期数)',
      Core.stockFlow(st, tianji.id) === Math.trunc(20000 * Math.pow(decay, 4)),
      String(Core.stockFlow(st, tianji.id)));
    st.playTime = per * 40 + 1;
    Core.syncStocks(st);
    ok('多期之后流归零', Core.stockFlow(st, tianji.id) === 0);
    ok('冲击回归 1（成交价回到自然价）', Core.stockImpact(st, tianji) === 1);
    ok('此时成交价 = 自然价',
      Core.stockPrice(st, tianji).eq(Core.stockNaturalPrice(st, tianji)));
  }

  // 持仓集中度放大冲击，但不改变「不交易就不动价」
  {
    const st = mk();
    const depth = Core.stockDepth(tianji);
    const i0 = Core.stockImpactAt(st, tianji, 0, depth * 0.08);
    const i1 = Core.stockImpactAt(st, tianji, Math.floor(depth / 2), depth * 0.08);
    ok('重仓会放大冲击幅度', i1 > i0, i0.toFixed(5) + ' → ' + i1.toFixed(5));
    ok('买入冲击封顶 +maxRise',
      Core.stockImpactAt(st, tianji, 0, 1e18) === 1 + SK.maxRise);
    ok('卖出冲击封底 −maxDrop',
      Core.stockImpactAt(st, tianji, 0, -1e18) === 1 - SK.maxDrop);
  }

  // 与公司商品的联动
  {
    const chip = Core.goodById(chipsci.link);
    const cp = Core.stockPeriodSeconds(chipsci);
    const st = mk();
    st.playTime = cp * 5 + 60;
    const base = Core.stockNaturalPrice(st, chipsci).toNumber();
    const goodsBase = Core.goodsPrice(chip, st.playTime).toNumber();
    const F = (goodsBase / chip.basePrice) * Core.industryPriceIndex(st, chip.industry);

    st.company.pressure[chip.id] = 0.1;
    const after = Core.stockNaturalPrice(st, chipsci).toNumber();
    const I = Core.marketImpactAt(st, chip, Core.goodsPeriod(chip, st.playTime));
    const w = SK.linkWeight;
    ok('商品被砸价时关联股票自然价同步下降', after < base,
      base.toFixed(2) + ' → ' + after.toFixed(2));
    ok('联动幅度 = 商品价格倍数按 linkWeight 打折',
      Math.abs(after / base - (1 + (F * I - 1) * w) / (1 + (F - 1) * w)) < 1e-9);
    const clean = Core.createState();
    clean.realm = 1;
    clean.playTime = cp * 5 + 60;
    ok('无抛压时商品的行情波动也会传导',
      Math.abs(Core.stockLinkFactor(clean, chipsci, 5) - 1) > 1e-6,
      Core.stockLinkFactor(clean, chipsci, 5).toFixed(6));
  }

  // 概览口径与存档往返
  {
    const st = mk();
    Core.buyStock(st, tianji.id, 20000);
    Core.buyStock(st, chipsci.id, 40);
    const sum = Core.stockSummary(st);
    ok('概览列出全部股票', sum.stocks.length === SK.stocks.length);
    ok('总市值 = 各股之和',
      sum.totalValue.eq(sum.stocks.reduce((a, x) => a.add(x.value), new D(0))));
    ok('总成本 = 各股之和',
      sum.totalCost.eq(sum.stocks.reduce((a, x) => a.add(x.cost), new D(0))));
    ok('清仓可变现低于按现价算的市值', sum.liquidateValue.lt(sum.totalValue),
      sum.liquidateValue.toString() + ' < ' + sum.totalValue.toString());
    ok('清仓可变现 ≤ 市值（溢价拿不回来）',
      sum.stocks.every((x) => x.liquidateValue.lte(x.value.add(new D(1e-15)))));

    const b = Core.hydrate(JSON.parse(JSON.stringify(Core.serialize(st))));
    ok('持仓往返一致', Core.stockShares(b, tianji.id) === Core.stockShares(st, tianji.id));
    ok('净买入流往返一致', Core.stockFlow(b, tianji.id) === Core.stockFlow(st, tianji.id));
    ok('持仓成本往返一致', Core.stockCost(b, tianji.id).eq(Core.stockCost(st, tianji.id)));
    ok('成交笔数往返一致', b.stock.totalTrades === st.stock.totalTrades);

    const forged = JSON.parse(JSON.stringify(Core.serialize(st)));
    forged.stock.shares[tianji.id] = 1e12;
    ok('超流通盘持仓被裁剪',
      Core.stockShares(Core.hydrate(forged), tianji.id) === Core.stockDepth(tianji),
      String(Core.stockShares(Core.hydrate(forged), tianji.id)));

    const ghost = JSON.parse(JSON.stringify(Core.serialize(st)));
    ghost.stock.shares[tianji.id] = 0;
    ghost.stock.cost[tianji.id] = { m: 999, e: 6 };
    ok('无持仓时的残留成本被清零',
      Core.stockCost(Core.hydrate(ghost), tianji.id).isZero());

    const ahead = JSON.parse(JSON.stringify(Core.serialize(st)));
    ahead.stock.lastPeriod[tianji.id] = 99999;
    const ha = Core.hydrate(ahead);
    ok('超前 lastPeriod 被夹回当前期',
      ha.stock.lastPeriod[tianji.id] <= Core.stockPeriod(tianji, ha.playTime),
      String(ha.stock.lastPeriod[tianji.id]));
  }

  // 最大可买
  {
    const st = mk();
    st.money = new D(1e6);
    const mb = Core.stockMaxBuy(st, tianji);
    ok('算得出最大可买量', mb > 0, String(mb));
    ok('最大可买量确实买得起', Core.stockBuyQuote(st, tianji, mb).total.lte(st.money));
    ok('再多一股就买不起', Core.stockBuyQuote(st, tianji, mb + 1).total.gt(st.money));
  }
}

console.log('\n==============================================');
console.log('  通过 ' + pass + '   失败 ' + fail);
console.log('==============================================\n');
process.exit(fail === 0 ? 0 : 1);
