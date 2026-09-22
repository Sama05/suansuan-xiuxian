/**
 * 生成一个「已有进度」的演示账号，方便直接看到中期的各系统状态。
 *
 * 用法: node tools/seed-demo.js [用户名] [密码] [模拟小时数]
 *
 * 做法：用一个理性玩家跑一遍模拟，把到达目标时点的存档直接写进数据库。
 * 这样玩家一登录就能看到：多份工作已解锁、精力在跑、时间档位已升、功法页锁定。
 *
 * 账号来源：命令行参数 > 环境变量 SUANSUAN_SEEDUSER / SUANSUAN_SEEDPWD >
 * 本机私有文件 tools/_local.json。真实账号不写进仓库（仓库是公开的）。
 */

const fs = require('fs');
const path = require('path');

const D = require('../shared/decimal.js');
const GAME = require('../shared/game-config.js');
const C = require('../shared/game-core.js');
const dbm = require('../server/db.js');

/** 读一个本机私有配置项（tools/_local.json）。 */
function local(key, fallback) {
  const env = process.env['SUANSUAN_' + String(key).toUpperCase()];
  if (env) return env;
  try {
    const p = path.join(__dirname, '_local.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && data[key]) return data[key];
  } catch (e) { /* 没有就回落 */ }
  return fallback;
}

const username = process.argv[2] || local('seedUser', 'demo');
const password = process.argv[3] || local('seedPwd', 'demo1234');
const HOURS = parseFloat(process.argv[4]) || 2;

// ---------- 理性玩家（与 tools/sim.js 同规则） ----------

function jobRate(s, job) {
  const durGame = C.jobDurationSeconds(job);
  const speed = C.gameSecondsPerRealSecond(s);
  const byTime = durGame > 0 ? speed / durGame : Infinity;
  const byEnergy = 1 / job.energy;
  return Math.min(byTime, byEnergy) * job.money;
}

function bestJob(s) {
  let best = null;
  for (const j of GAME.jobs) {
    if (!C.jobUnlocked(s, j)) continue;
    const r = jobRate(s, j);
    if (!best || r > best.rate) best = { job: j, rate: r };
  }
  return best;
}

function tryBuy(s) {
  let best = null;
  for (const dev of GAME.devices) {
    const cost = C.deviceCost(s, dev);
    if (s.money.lt(cost)) continue;
    const eff = D.log10(new D(dev.compute)) - D.log10(cost);
    if (!best || eff > best.eff) best = { dev, eff };
  }
  if (best) { C.buyDevice(s, best.dev.id); return true; }
  return false;
}

const s = C.createState();
C.setAllocation(s, { xiuxian: 0.7, ai: 0.2, hardware: 0.1, finance: 0 });
const MAX = Math.floor(HOURS * 3600);
let t = 0;

for (let i = 0; i < MAX; i++) {
  const bj = bestJob(s);
  if (bj && bj.job.id !== s.jobId) C.setJob(s, bj.job.id);
  let guard = 0;
  while (tryBuy(s) && guard++ < 200) {}
  C.tick(s, 1, { offline: false });
  t += 1;
}

// 存档写入前把 lastTick 归到当前，避免下次登录触发一次假的离线结算
s.lastTick = Date.now();

// ---------- 顺手建个仓（股市已解锁时），让演示账号的证券页不是空的 ----------
//
// 只用一小部分资金，且刻意挑「低价妖股 + 联动股」各一只：前者展示波动，
// 后者展示与公司商品的联动。买完不动 —— 真实的盈亏要玩家自己赌方向。
const STOCK_SEED = [
  { id: 'tianji', budget: 0.10 },    // 独立行情、波动最凶
  { id: 'chipsci', budget: 0.10 },   // 联动「半导体芯片」
];
const seeded = [];

if (C.stockUnlocked(s)) {
  for (const spec of STOCK_SEED) {
    const st = C.stockById(spec.id);
    if (!st) continue;
    // 把「可用资金」临时缩小到预算，stockMaxBuy 就会直接给出这个预算内的最大股数，
    // 不用在外面自己算价（成交价取决于成交后的冲击，前端手算极易差一股）。
    const saved = s.money;
    s.money = saved.mul(spec.budget);
    const n = C.stockMaxBuy(s, st);
    s.money = saved;
    if (n <= 0) continue;
    const r = C.buyStock(s, st.id, n);
    if (r.ok) seeded.push({ name: st.name, shares: r.shares, total: r.total });
  }
}

console.log('模拟完成');
console.log('  现实时长   ' + (t / 3600).toFixed(2) + ' 小时');
console.log('  游戏内时间 ' + C.fmtGameDate(s.gameSeconds));
console.log('  境界       ' + C.realmInfo(s).name + '（灵石 ' + s.spiritStone.toString() + '）');
console.log('  时间档位   ' + C.tierInfo(s.timeTier).name + '（' + C.tierInfo(s.timeTier).label + '）');
console.log('  金钱       ' + s.money.toString());
console.log('  算力       ' + s.realCompute.toString());
console.log('  精力       ' + Math.floor(s.energy) + ' / ' + C.maxEnergy(s));
console.log('  设备       ' + JSON.stringify(s.devices));
console.log('  已解锁工作:');
for (const j of GAME.jobs) {
  if (C.jobUnlocked(s, j)) {
    console.log('    ' + j.name.padEnd(22) + '已完成 ' + C.jobDoneCount(s, j.id) + ' 次');
  }
}

if (C.stockUnlocked(s)) {
  const sum = C.stockSummary(s);
  console.log('  证券账户:');
  for (const pos of seeded) {
    console.log('    买入 ' + pos.name.padEnd(8) + ' ' + pos.shares + ' 股，花费 ' + pos.total.toString());
  }
  console.log('    总市值 ' + sum.totalValue.toString() + '（清仓可变现 ' + sum.liquidateValue.toString() + '）');
  console.log('    浮动盈亏 ' + sum.pnl.toString() + ' / 可变现盈亏 ' + sum.liquidatePnl.toString());
} else {
  console.log('  证券账户: 未开户（境界不足）');
}

// ---------- 写库 ----------

// 注意：dbm.getUser() 收的是 userId 而不是用户名，这里按用户名自己查一次
function findUserByName(name) {
  return dbm.db.prepare('SELECT id, username FROM users WHERE username = ?').get(name) || null;
}

let u = findUserByName(username);
let created = false;
if (!u) {
  const r = dbm.register(username, password);
  if (!r.ok) {
    console.error('注册失败:', r.msg);
    process.exit(1);
  }
  u = findUserByName(username);
  created = true;
}
if (!u) {
  console.error('账号创建后仍查不到，终止');
  process.exit(1);
}

const res = dbm.saveGame(u.id, C.serialize(s));
console.log('\n' + (created ? '已创建账号 ' : '已覆盖账号 ') + username
  + (created ? ' / ' + password : '（密码保持不变）'));
console.log('存档已写入（user_id=' + u.id + '，' + res.bytes + ' 字节）。');
