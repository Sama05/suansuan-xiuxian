#!/usr/bin/env node
/**
 * 造一个「工业算力不足」的演示存档，用来肉眼验证「优先生产」的分档分配。
 *
 * 为什么需要它：`工业算力池 = 实际算力 × 工业份额`，而产线需求是 `maxCompute × 产能`。
 * 后期实际算力被设备与 AI 投向推到 1e22 量级，需求才 1e14 —— 池子永远富余 8 个数量级，
 * 于是「算力不足」这个状态**在实际存档里几乎不可能自然出现**（见 README「校准观察」）。
 * 想验证分档逻辑，就得专门造一个供需比落在 (0, 1) 区间的存档。
 *
 * 用法：
 *   node tools/make-scarce-demo.js [用户名] [--pwd 密码] [--realm N]
 *
 * 默认账号 scarce_demo / 密码取 tools/_local.json 的 pwd（没有就用 dev12345678）。
 * 造完刷新浏览器、用该账号登录即可看到：优先线满负荷，其余线按剩余算力摊薄。
 *
 * 注意：这个工具会**覆盖**同名账号的存档，不要对着真实账号跑。
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
const bcrypt = require('bcryptjs');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const username = argv.find((a) => !a.startsWith('--')) || 'scarce_demo';
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

let defaultPwd = 'dev12345678';
try {
  const local = require(path.join(__dirname, '_local.json'));
  if (local && local.pwd) defaultPwd = local.pwd;
} catch (e) { /* 本机私有配置缺失就用兜底密码 */ }
const password = String(opt('pwd', defaultPwd));
const realm = Math.max(1, Math.min(GAME.realms.length - 1, Number(opt('realm', 3)) || 3));

// ---------- 账号 ----------
let user = dbm.db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (user) {
  dbm.db.prepare('UPDATE users SET password = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), user.id);
  console.log('复用已有账号 ' + username + '（密码已重置为命令行给定的值）');
} else {
  // 离线工具用同步版：register 是 async 的（HTTP 路由要 await），
  // 在脚本里直接调会拿到 Promise 而静默失败。
  const r = dbm.registerSync(username, password);
  if (!r.ok) { console.error('建号失败：' + r.msg); process.exit(1); }
  user = { id: r.userId, username: r.username };
  console.log('已创建账号 ' + username);
}

// ---------- 造状态 ----------
const s = Core.createState();
s.money = new D(1e18);
s.spiritStone = new D(1e14);
s.realm = realm;

// 1. 设备：**只买到「算力池够小」为止**。
//    这不是省事，是必须 —— 池子 = 实际算力 × 工业份额，实际算力一旦上到 1e16，
//    要实现「池子只有 1e6」就得把工业份额压到 1e-10，界面上那个滑块会显示成 0%，
//    看着像坏了。所以宁可少买设备，让份额落在一个肉眼可读的区间（10%~40%）。
const RC_TARGET = 4e6;
for (const dev of GAME.devices) {
  for (let i = 0; i < 40; i++) {
    if (Core.realComputeOf(s).toNumber() >= RC_TARGET) break;
    if (!Core.buyDevice(s, dev.id).ok) break;
  }
  if (Core.realComputeOf(s).toNumber() >= RC_TARGET) break;
}

// 2. 公司 + 产线：按配置的 after 链解锁，铺少量台
Core.foundCompany(s);
const want = [
  { id: 'talismanry', n: 2, pri: true },   // 符箓工坊 330k
  { id: 'alchemy', n: 2, pri: false },     // 丹房      250k
  { id: 'refine', n: 1, pri: false },      // 炼器坊    840k
];
for (const spec of want) {
  const line = Core.lineById(spec.id);
  if (line && line.after) {
    let g = 0;
    while (Core.lineOwned(s, line.after.id) < (line.after.times || 1) && g++ < 200) {
      if (!Core.buyLine(s, line.after.id).ok) break;
    }
  }
  for (let i = 0; i < spec.n; i++) {
    if (!Core.buyLine(s, spec.id).ok) break;
  }
  if (spec.pri) Core.setLinePriority(s, spec.id, true);
}

// 前置解锁链买下来的线（灵田等）不参与演示 —— 下调产能到 0，让它们不进需求口径
for (const line of GAME.company.lines) {
  const units = Core.lineUnits(s, line.id);
  if (!units.length) continue;
  if (want.some((w) => w.id === line.id)) continue;
  for (let i = 0; i < units.length; i++) Core.setLineUnit(s, line.id, i, { rate: 0 });
}

// 3. 份额：把工业池调到「优先线刚好吃满 + 其余线只能吃三成」的位置
function needs() {
  let priNeed = 0, normNeed = 0;
  for (const line of GAME.company.lines) {
    const units = Core.lineUnits(s, line.id);
    if (!units.length) continue;
    let r = 0;
    for (const u of units) if (Core.unitActive(u)) r += Math.max(0, Math.min(1, u.r === undefined ? 1 : u.r));
    if (r <= 0) continue;
    const c = (line.maxCompute || 0) * r;
    if (Core.linePriority(s, line.id)) priNeed += c; else normNeed += c;
  }
  return { priNeed, normNeed };
}

const rc = Core.realComputeOf(s).toNumber();
const base = needs();
const targetPool = base.priNeed * 1.0 + base.normNeed * 0.3;
const share = Math.max(0, Math.min(1, targetPool / rc));
const r0 = Core.setAllocationShare(s, 'industry', share);
if (!r0.ok) console.log('设定工业份额失败：' + r0.msg);

// 4. 落盘
const out = Core.serialize(s);
dbm.saveGame(user.id, out);

// ---------- 报告 ----------
const t = Core.companyComputeTiers(s);
console.log('\n=== 演示存档：' + username + ' ===');
console.log('  境界      : ' + ((GAME.realms[s.realm] || {}).name || '?'));
console.log('  实际算力  : ' + String(s.realCompute));
console.log('  工业份额  : ' + (share < 0.01 ? (share * 100).toFixed(3) : (share * 100).toFixed(1)) + '%');
console.log('  算力池    : ' + t.pool.toExponential(3));
console.log('  优先线需求: ' + t.priNeed.toExponential(3) + ' → 分到 ' + (t.pri * 100).toFixed(1) + '%');
console.log('  其余线需求: ' + t.normNeed.toExponential(3) + ' → 分到 ' + (t.norm * 100).toFixed(1) + '%');
console.log('  全厂口径  : ' + (t.scale * 100).toFixed(1) + '%');
console.log('\n  产线明细：');
for (const line of GAME.company.lines) {
  const units = Core.lineUnits(s, line.id);
  if (!units.length) continue;
  const pri = Core.linePriority(s, line.id);
  const sc = Core.unitComputeScale(s, line);
  const active = units.filter((u) => Core.unitActive(u)).length;
  if (!active) continue;
  console.log('    ' + (pri ? '★优先 ' : '  普通 ') + line.name + ' ×' + units.length +
    '　算力系数 ' + (sc * 100).toFixed(1) + '%');
}
console.log('\n用 ' + username + ' / ' + password + ' 登录即可查看。');
