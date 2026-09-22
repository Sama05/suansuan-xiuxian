/**
 * 数值模拟 —— 用一个「理性玩家」跑一遍全流程，用于校准节奏。
 *
 * 用法：
 *   node tools/sim.js [模拟小时数] [策略] [步长秒]
 *   例：node tools/sim.js 72 xiuxian 5
 *
 * 策略：xiuxian（默认）/ even / finance
 *
 * 理性玩家的决策规则：
 *   1) 选工作：在已解锁的工作里，选「单位现实时间金钱产出」最高的那份。
 *      产出率 = min(游戏时间速率, 精力恢复速率) × 单次收益。
 *      低档位时受游戏时间限制，高档位时受精力限制 —— min 会自动处理。
 *   2) 买设备：在所有「金钱 + 灵石都付得起」的设备里，买「算力/价格」性价比最高的一台。
 *      修仙×科技设备是双造价（金钱 + 灵石），付不起灵石就不会买。
 *   3) 分配算力：按策略给出的固定比例投向；「功法增幅」在习得功法前是锁定的，
 *      未解锁时它的份额会自动回落到修仙方向（core 的 setAllocation 负责归一化）。
 *   4) 突破解锁新档位后，自动切到最高档（autoTier）。
 *
 * 关注点（修仙线）：
 *   - 灵气只来自「修仙投向 + 修仙类工作」，且**必须先习得功法**才允许产出。
 *   - 神识 = 境界基础 × 设备倍率 × 功法被动，它同时放大实际算力与功法修炼速度。
 *   - 功法等级由算力换算（无上限），等级越高灵气吸收速度越快。
 */

const D = require('../shared/decimal.js');
const GAME = require('../shared/game-config.js');
const C = require('../shared/game-core.js');

const args = process.argv.slice(2);
const HOURS = parseFloat(args[0]) || 72;
const STRATEGY = args[1] || 'xiuxian';
/** 每步的现实秒数：越小越精确、越慢。5 秒对节奏校准足够 */
const STEP = parseFloat(args[2]) || 5;
/** 每隔多少步重新套用一次分配（用于功法解锁后即时生效） */
const REBALANCE_EVERY = Math.max(1, Math.round(300 / STEP));

const ALLOCS = {
  // 全压灵气：修仙 + 功法增幅，钱只靠工作与设备被动
  xiuxian: { xiuxian: 0.55, technique: 0.45, ai: 0, hardware: 0, finance: 0 },
  // 均衡：一半灵气、一半放大与变现
  even:    { xiuxian: 0.25, technique: 0.15, ai: 0.2, hardware: 0.2, finance: 0.2 },
  // 金融优先：留足本金买设备，再用修仙收尾
  finance: { xiuxian: 0.35, technique: 0.15, ai: 0.05, hardware: 0.05, finance: 0.4 },
};

// ---------- 决策 ----------

/** 某份工作在现实时间下的金钱产出率（金/现实秒） */
function jobRate(s, job) {
  const durGame = C.jobDurationSeconds(job);
  const speed = C.gameSecondsPerRealSecond(s);
  const byTime = durGame > 0 ? speed / durGame : Infinity;  // 份/现实秒（时间上限）
  const byEnergy = 1 / job.energy;                          // 份/现实秒（精力上限）
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

/**
 * 选功法：优先修炼「主属性最强且尚未圆满」的那一本 —— 主属性立刻生效，
 * 而圆满只决定被动是否常驻，所以先追强、后补被动是更优解。
 * 全部圆满后，回头修主属性最强的那本。
 */
function bestTechnique(s) {
  const learned = Object.keys(s.learned)
    .map((id) => C.techById(id))
    .filter(Boolean)
    .sort((a, b) => C.techMainQiSpeed(s, b) - C.techMainQiSpeed(s, a));
  if (!learned.length) return null;
  const pending = learned.find((t) => !s.learned[t.id].passive);
  return (pending || learned[0]).id;
}

/**
 * 买设备：只买「金钱 + 灵石都付得起」的，取「算力/价格」性价比最高的一台。
 * 性价比用对数尺度衡量（算力与价格跨十几个数量级，直接相除没有意义）。
 */
function tryBuy(s) {
  let best = null;
  for (const dev of GAME.devices) {
    const cost = C.deviceCost(s, dev);
    if (s.money.lt(cost)) continue;
    const stone = C.deviceStoneCost(s, dev);
    if (stone.gt(0) && s.spiritStone.lt(stone)) continue;

    const eff = D.log10(new D(dev.compute)) - D.log10(cost);
    if (!best || eff > best.eff) best = { dev, eff };
  }
  if (best) return C.buyDevice(s, best.dev.id).ok;
  return false;
}

// ---------- 主循环 ----------

function run(hours, alloc) {
  const s = C.createState();
  C.setAllocation(s, alloc);

  const MAX = Math.floor(hours * 3600 / STEP);
  const realmAt = { 0: 0 };      // 境界 -> 达成时的现实秒
  const realmGame = { 0: 0 };    // 境界 -> 达成时的游戏秒
  const techAt = {};             // 功法 id -> 习得时的现实秒
  const techGame = {};
  const perfectAt = {};          // 功法 id -> 圆满（被动常驻）时的现实秒
  const devAt = {};              // 设备 id -> 首次入手时的现实秒
  let t = 0;

  for (let i = 0; i < MAX; i++) {
    if (i % REBALANCE_EVERY === 0) {
      C.setAllocation(s, alloc);
      const tid = bestTechnique(s);
      if (tid && tid !== s.technique) C.setTechnique(s, tid);
    }

    const bj = bestJob(s);
    if (bj && bj.job.id !== s.jobId) C.setJob(s, bj.job.id);

    let guard = 0;
    while (tryBuy(s) && guard++ < 50) {}

    C.tick(s, STEP, { offline: false });
    t += STEP;

    if (realmAt[s.realm] === undefined) {
      realmAt[s.realm] = t;
      realmGame[s.realm] = s.gameSeconds;
    }
    for (const id of Object.keys(s.learned)) {
      if (techAt[id] === undefined) { techAt[id] = t; techGame[id] = s.gameSeconds; }
      if (s.learned[id].passive && perfectAt[id] === undefined) perfectAt[id] = t;
    }
    for (const dev of GAME.devices) {
      if (devAt[dev.id] === undefined && (s.devices[dev.id] || 0) > 0) devAt[dev.id] = t;
    }
  }

  return { s, t, realmAt, realmGame, techAt, techGame, perfectAt, devAt };
}

function fmtT(sec) {
  if (sec === undefined) return '未达成';
  const h = sec / 3600;
  if (h >= 24) return (h / 24).toFixed(2) + '天';
  if (h >= 1) return h.toFixed(2) + 'h';
  return Math.max(1, Math.round(sec / 60)) + 'min';
}

/** 实际算力 / 原始算力 —— 即神识乘区与功法被动乘区的合乘积 */
function realComputeMul(s) {
  const raw = C.totalCompute(s);
  if (!raw.gt(0)) return 1;
  return s.realCompute.div(raw).toNumber();
}

function pad(s, n) {
  // 中文按 2 宽度对齐
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  let out = String(s);
  while (w < n) { out += ' '; w += 1; }
  return out;
}

// ---------- 输出 ----------

console.log('');
console.log('策略 ' + STRATEGY + '    模拟上限 ' + HOURS + ' 小时' + '    步长 ' + STEP + 's');
console.log('='.repeat(78));

const r = run(HOURS, ALLOCS[STRATEGY] || ALLOCS.xiuxian);
const s = r.s;

// 1) 境界时间表
console.log('【境界】');
console.log(pad('境界', 12) + pad('达成(现实)', 14) + pad('达成(游戏内)', 22));
console.log('-'.repeat(78));
for (let i = 0; i < GAME.realms.length; i++) {
  const at = r.realmAt[i];
  console.log(
    pad(GAME.realms[i].name, 12) +
    pad(fmtT(at), 14) +
    pad(at === undefined ? '—' : C.fmtGameDate(r.realmGame[i]).slice(0, 11), 22)
  );
}

// 2) 功法时间线
console.log('');
console.log('【功法】');
console.log(pad('功法', 20) + pad('稀有度', 10) + pad('习得(现实)', 14) + pad('圆满(现实)', 14));
console.log('-'.repeat(78));
for (const t of GAME.techniques.list) {
  const rar = C.rarityById(t.rarity);
  const rec = s.learned[t.id];
  console.log(
    pad(t.name, 20) +
    pad(rar ? rar.name + '级' : '', 10) +
    pad(r.techAt[t.id] === undefined ? '未习得' : fmtT(r.techAt[t.id]), 14) +
    pad(r.perfectAt[t.id] === undefined ? (rec ? '未圆满' : '—') : fmtT(r.perfectAt[t.id]), 14)
  );
}

// 3) 设备时间线（第一台何时入手 —— 用来校准修仙×科技设备的灵石门槛）
console.log('');
console.log('【设备】');
console.log(pad('设备', 22) + pad('类型', 12) + pad('首台入手', 14) + '最终持有');
console.log('-'.repeat(78));
for (const dev of GAME.devices) {
  const kind = dev.stoneCost ? '修仙×科技' : '纯科技';
  console.log(
    pad(dev.name, 22) +
    pad(kind, 12) +
    pad(r.devAt[dev.id] === undefined ? '未入手' : fmtT(r.devAt[dev.id]), 14) +
    (s.devices[dev.id] || 0)
  );
}

// 4) 最终状态
const tech = C.currentTech(s);
console.log('');
console.log('【最终状态】');
console.log('  游戏内时间   ' + C.fmtGameDate(s.gameSeconds));
console.log('  时间档位     ' + C.tierInfo(s.timeTier).name + '（' + C.tierInfo(s.timeTier).label + '）');
console.log('  金钱         ' + s.money.toString());
console.log('  算力(原始)   ' + C.totalCompute(s).toString());
console.log('  算力(实际)   ' + s.realCompute.toString());
console.log('  灵气 qi      ' + s.qi.toString() + '   ← 突破资源');
console.log('  灵石         ' + s.spiritStone.toString() + '   ← 后期修仙资源');
console.log('  神识         ' + s.shenshi.toFixed(2) +
  '   （境界基础 ' + C.shenshiBase(s) + ' × 设备 ' + C.shenshiDeviceMultiplier(s).toFixed(2) + '）');
console.log('  精力         ' + Math.floor(s.energy) + ' / ' + Math.round(C.maxEnergy(s)));
console.log('  算力倍率     ×' + realComputeMul(s).toFixed(2) +
  '   （神识乘区 × 功法被动）');
console.log('  灵石产出     ' + C.deviceStoneOutput(s).toString() + ' / 现实秒（仅修仙×科技设备）');
console.log('  工作总次数   ' + s.totalJobs);
console.log('  设备         ' + JSON.stringify(s.devices));
if (tech) {
  const rec = s.learned[tech.id];
  console.log('  当前修炼     ' + tech.name + '（' + (C.rarityById(tech.rarity) || {}).name + '级）');
  console.log('  功法等级     ' + C.techLevel(s, tech) +
    '     主属性·灵气吸收 +' + (C.techMainQiSpeed(s, tech) * 100).toFixed(1) + '%');
  console.log('  熟练度       ' + Math.round(rec.mastery) + ' / ' + C.masteryInfo(5).need +
    '    段位 ' + C.masteryInfo(rec.tier).name +
    (rec.passive ? '（被动已常驻）' : ''));
}
console.log('  灵气倍率     ×' + C.qiMultiplier(s).toFixed(3) +
  '   （功法主属性 × 神识 × 功法投向 × allOutput）');
console.log('  修炼速度     ' + C.cultivateSpeed(s).toFixed(2) + ' 熟练度/现实秒');

// 5) 工作履历
const jobLines = [];
for (const j of GAME.jobs) {
  const n = C.jobDoneCount(s, j.id);
  if (n > 0) jobLines.push('  ' + pad(j.name, 26) + n + ' 次');
}
if (jobLines.length) {
  console.log('');
  console.log('【工作履历】');
  console.log(jobLines.join('\n'));
}
console.log('');
