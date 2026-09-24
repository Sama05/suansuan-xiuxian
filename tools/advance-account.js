#!/usr/bin/env node
/**
 * 把某个账号「模拟推进」到后期，方便直接查看高境界 / 满产业阶段的表现。
 *
 * 用法：
 *   node tools/advance-account.js <用户名> [--realm N] [--hours H] [--no-company]
 *
 * 它不是作弊后门，而是一个**存档改写工具**：直接改 SQLite 里的存档 JSON，
 * 所有改动都走内核自己的入口（foundCompany / buyDevice / buyLine / doTribulation …），
 * 不手写内部字段，于是存档结构与线上一致、不会被 hydrate 夹掉。
 *
 * 注意：服务端每次 /api/load 都从库里读，所以改完只要刷新页面就生效；
 * 但**浏览器里已经打开的那份旧状态会把它覆盖回去** —— 改完必须刷新页面再操作。
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'shared', 'decimal.js'));
require(path.join(ROOT, 'shared', 'game-config.js'));
const Core = require(path.join(ROOT, 'shared', 'game-core.js'));
const GAME = global.GAME;
const D = global.Decimal;
const dbm = require(path.join(ROOT, 'server', 'db.js'));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const username = argv.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.indexOf('--' + name) >= 0;

if (!username) {
  console.error('用法: node tools/advance-account.js <用户名> [--realm N] [--hours H] [--no-company]');
  process.exit(1);
}

const targetRealm = Math.max(0, Math.min(GAME.realms.length - 1,
  Number(opt('realm', GAME.realms.length - 1)) || 0));
const simHours = Math.max(0, Number(opt('hours', 72)) || 0);
const withCompany = !hasFlag('no-company');

// ---------- 读档 ----------
const user = dbm.db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (!user) {
  console.error('找不到账号：' + username);
  process.exit(1);
}
const raw = dbm.loadSave(user.id);
if (!raw) {
  console.error('该账号还没有存档，先登录一次游戏再来。');
  process.exit(1);
}

const s = Core.hydrate(raw);
// 项目的 Decimal 只有 toString / toFixed，没有 toExponential —— 大数格式化走这里
const big = (v) => (v === null || v === undefined) ? '0' : String(v);
const log = [];
const say = (m) => { log.push(m); console.log('  · ' + m); };

console.log('\n=== 模拟推进：' + user.username + ' ===');
say('起始境界 ' + ((GAME.realms[s.realm] || {}).name || '?') +
  '（第 ' + (s.realm + 1) + ' / ' + GAME.realms.length + ' 阶）');

// ---------- 1. 资源给足（不写内部字段，直接调内核入口） ----------
// 钱与灵石给到「够用」而不是无穷大：Decimal 尾数约 14 位，数值太大会让
// 「卖出收入」落在精度之外，界面上看起来钱不动了。
s.money = new D(1e24);
s.spiritStone = new D(1e18);
say('资金与灵石已给足（金钱 1e24 / 灵石 1e18）');

// ---------- 2. 设备：每种买一批，把算力堆到后期水平 ----------
let devBought = 0;
for (const dev of GAME.devices) {
  // 仙石类设备要灵石，钱够也可能买不动 —— 买不动就跳过，不硬来
  for (let i = 0; i < 60; i++) {
    if (!Core.buyDevice(s, dev.id).ok) break;
    devBought += 1;
  }
}
say('设备购入 ' + devBought + ' 台　总算力 ' + big(Core.realComputeOf(s)));

// ---------- 3. 功法：能学的都学了，等级拉到当前上限 ----------
Core.learnTechniques(s);
let techN = 0;
for (const t of GAME.techniques.list) {
  if (!s.learned[t.id]) continue;
  const rec = s.learned[t.id];
  rec.level = Math.max(rec.level || 0, 10);
  rec.mastery = Math.max(rec.mastery || 0, 5000);
  rec.exp = Math.max(rec.exp || 0, 1000);
  techN += 1;
}
if (techN) say('功法已掌握 ' + techN + ' 部，等级 / 熟练度拉满');

// ---------- 4. 境界：一路渡劫推到目标境界 ----------
//
// 渡劫结果**不是随机的**，而是 `tribulationRoll(s)` 由状态确定性推导
// （喂进去的是：境界 / 已尝试次数 / 淬体层数 / 游戏内分钟数 / 兵解次数）。
// 这带来两个必须处理的事实：
//
//   1. 失败 = 被动兵解 = `s.realm` 直接归 0，整条修仙线清空。硬闯一次失败就前功尽弃，
//      所以**不能**「闭眼连点」。
//   2. 因为 roll 是状态的纯函数，同一个状态重复调用会得到同一个结果 —— 想让结果变，
//      必须让喂进去的某个量变。
//
// 做法：先把灵气补到够，然后**向前扫「已尝试次数」**，找到第一个 roll 会通过的值，
// 再交给内核的 doTribulation 真正执行（它自己会 +1 次尝试，所以扫描时要按 n+1 试算）。
// 只动 `tribulation.attempts` 这一个字段 —— 它本来就是「渡劫尝试次数」，语义即
// 「失败了这么多次之后终于过关」，不伪造任何别的状态。
let tribFails = 0;
let guard = 0;
while (s.realm < targetRealm && guard++ < 64) {
  const t = Core.nextRealm(s);
  if (!t || !t.next) break;
  if (s.qi.lt(t.need)) s.qi = t.need.mul(2);

  const rate = Core.tribulationOdds(s).rate;
  const st = Core.tribulationState(s);
  const base = st.attempts;
  let found = -1;
  for (let n = base; n < base + 500000; n++) {
    st.attempts = n + 1;                    // 模拟 doTribulation 内部的 +1
    if (Core.tribulationRoll(s) < rate) { found = n; break; }
  }
  if (found < 0) { say('未找到可通过的尝试点，停在当前境界'); break; }
  tribFails += found - base;
  st.attempts = found;

  const r = Core.doTribulation(s);
  if (!r.ok || !r.success) { say('渡劫中断：' + (r.msg || '结果非成功')); break; }
}
say('境界推进至 ' + ((GAME.realms[s.realm] || {}).name || '?') +
  '（第 ' + (s.realm + 1) + ' / ' + GAME.realms.length + ' 阶，目标 ' +
  (targetRealm + 1) + '）　共尝试 ' + s.tribulation.attempts + ' 次（其中失败 ' + tribFails + ' 次）');

// 淬体（渡劫附加层）能点就点几层
let perkN = 0;
for (const p of (Core.rebirthCfg().perks || [])) {
  for (let i = 0; i < 5; i++) {
    if (!Core.buyPerk(s, p.id).ok) break;
    perkN += 1;
  }
}
if (perkN) say('兵解加成点亮 ' + perkN + ' 级');

// ---------- 5. 公司：成立 + 全线铺开 ----------
if (withCompany) {
  if (!Core.companyFounded(s)) {
    const r = Core.foundCompany(s);
    say(r.ok ? '公司已成立' : ('公司成立失败：' + r.msg));
  }
  if (Core.companyFounded(s)) {
    // 解锁链：按配置里的 after 逐条补齐，再由内核自己判定能否买
    let lineN = 0;
    for (const line of GAME.company.lines) {
      if (line.after) {
        let g = 0;
        while (Core.lineOwned(s, line.after.id) < (line.after.times || 1) && g++ < 200) {
          if (!Core.buyLine(s, line.after.id).ok) break;
        }
      }
      const per = 6;                       // 每条线铺 6 台，够看见排产压力
      for (let i = 0; i < per; i++) {
        if (!Core.buyLine(s, line.id).ok) break;
        lineN += 1;
      }
    }
    say('生产线购入 ' + lineN + ' 台（共 ' + GAME.company.lines.length + ' 条线）');

    let whN = 0;
    for (let i = 0; i < 40; i++) {
      if (!Core.upgradeWarehouse(s).ok) break;
      whN += 1;
    }
    if (whN) say('仓库升至 Lv.' + Core.warehouseLevel(s));

    // 算力拨向：按**当前可用**的方向分配，修仙为主、工业两成 —— 后期两边都要看得见
    const shares = { xiuxian: 0.4, ai: 0.2, industry: 0.2, hardware: 0.1, technique: 0.05, finance: 0.05 };
    const usable = Core.allocatableInvestments(s).map((i) => i.id);
    const alloc = {};
    for (const inv of GAME.investments) alloc[inv.id] = 0;
    let rest = usable.length ? 1 / usable.length : 0;
    for (const id of usable) alloc[id] = (shares[id] !== undefined ? shares[id] : rest);
    Core.setAllocation(s, alloc);
    say('算力投向已分配：' + usable.map((id) =>
      ((GAME.investments.find((i) => i.id === id) || {}).name || id) + ' ' +
      Math.round((alloc[id] || 0) * 100) + '%').join(' · '));
  }
}

// ---------- 6. 跑一段时间，让经济自己滚起来 ----------
if (simHours > 0) {
  // tick 会把 dt 夹到 GAME.save.maxTickSeconds，所以按 24 小时一段切片推进
  let left = simHours * 3600;
  const chunk = Math.min(24 * 3600, GAME.save.maxTickSeconds || 24 * 3600);
  let guard = 0;
  while (left > 0 && guard++ < 500) {
    const dt = Math.min(chunk, left);
    Core.tick(s, dt, { offline: true });
    left -= dt;
  }
  say('已模拟推进 ' + simHours + ' 小时（分 ' + guard + ' 段离线结算）');
}

// ---------- 7. 落盘 ----------
const out = Core.serialize(s);
const bytes = JSON.stringify(out).length;
dbm.saveGame(user.id, out);

console.log('\n=== 推进后快照 ===');
console.log('  境界    : ' + ((GAME.realms[s.realm] || {}).name || '?') +
  '（第 ' + (s.realm + 1) + ' / ' + GAME.realms.length + ' 阶）');
console.log('  灵气    : ' + big(s.qi));
console.log('  金钱    : ' + big(s.money));
console.log('  灵石    : ' + big(s.spiritStone));
console.log('  算力    : ' + big(Core.realComputeOf(s)));
if (Core.companyFounded(s)) {
  const t = Core.companyComputeTiers(s);
  console.log('  公司    : 已成立　产线 ' + GAME.company.lines.reduce(
    (n, l) => n + Core.lineOwned(s, l.id), 0) + ' 台');
  console.log('  工业算力: 池 ' + big(Core.industrialComputePool(s)) +
    '　需求 ' + big(Core.companyComputeDemand(s)) +
    '　削减 ' + (t.scale * 100).toFixed(0) + '%');
  console.log('  周期净值: ' + big(Core.companyCycleNet(s)));
}
console.log('  存档    : ' + (bytes / 1024).toFixed(1) + ' KB 已写回 data/game.db');
console.log('\n刷新浏览器页面即可看到推进后的存档。\n');
