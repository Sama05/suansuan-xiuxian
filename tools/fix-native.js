#!/usr/bin/env node
/**
 * 修复原生模块 better-sqlite3 与当前 Node 的 ABI 不匹配。
 *
 * 用法：
 *   node tools/fix-native.js          # 需要时才动作，已能加载就直接跳过
 *   node tools/fix-native.js --force  # 无条件重新拉取本 ABI 的预编译包
 *
 * ── 为什么需要这个脚本 ─────────────────────────────────────────────
 * better-sqlite3 是原生模块，二进制绑死在某个 Node 的 ABI 上。这台机器有两套 Node：
 *   · D:\Application\nodejs        24.x  (ABI 137)  ← 系统装的，VSCode 默认用它
 *   · 别处（本项目早期安装环境）    22.x  (ABI 127)
 *
 * 更坑的是：npmmirror 的 better-sqlite3 tarball 里**自带**一个 build/Release/better_sqlite3.node
 * （实测是 ABI 127）。prebuild-install 看到目标文件已存在就跳过，于是
 * `npm install` 报成功、包版本也升上去了，但二进制还是旧的 —— 一跑就是
 * ERR_DLOPEN_FAILED / NODE_MODULE_VERSION 127 vs 137。
 * 所以必须显式 `--force` 才会真正替换。
 *
 * ── 行为 ───────────────────────────────────────────────────────────
 * 1. 先试着 require：能加载 → 直接成功退出（正常情况零开销、不联网）。
 * 2. 加载不了 → 用当前 Node 的 ABI 去 GitHub Releases 拉对应预编译包（--force）。
 * 3. 再在**独立子进程**里验证一次，把结果如实打出来（不靠“脚本说成功了”）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 本机（以及很多企业网络）子进程带 stdin 管道会 EBUSY —— 一律关掉 stdin。
const STDIO = ['ignore', 'pipe', 'pipe'];

const ROOT = path.join(__dirname, '..');
const MOD_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3');
const PREBUILD_BIN = path.join(ROOT, 'node_modules', 'prebuild-install', 'bin.js');
const ABI = process.versions.modules;
const force = process.argv.includes('--force');
// --soft：始终以 0 退出。给 `npm install` 的 postinstall 用 ——
// 镜像里自带的旧二进制可能让修复拿不到网络，但不该因此把整个 npm install 判失败。
// 代价是「装成功但其实坏的」，所以这里会打印得非常显眼，且 doctor / npm test 都会再拦一道。
const soft = process.argv.includes('--soft');
const bail = (code) => process.exit(soft ? 0 : code);

function canLoad() {
  // 在子进程里试，避免本进程 require 缓存把失败/成功状态带偏
  const r = spawnSync(process.execPath, ['-e', "require('better-sqlite3')"], {
    cwd: ROOT, encoding: 'utf8', stdio: STDIO, timeout: 60000,
  });
  return { ok: r.status === 0, err: (r.stderr || '').trim() };
}

function firstLines(s, n) {
  return String(s || '').split('\n').slice(0, n).join('\n');
}

console.log('');
console.log('  better-sqlite3 自检');
console.log('    当前 Node : ' + process.version + '（ABI ' + ABI + '）');
console.log('    可执行文件: ' + process.execPath);
console.log('    模块目录  : ' + (fs.existsSync(MOD_DIR) ? '存在' : '**不存在**'));

if (!fs.existsSync(MOD_DIR)) {
  console.error('');
  console.error('  没有装 better-sqlite3。先跑：npm install');
  console.error('');
  bail(1);
}

if (!force) {
  const v = canLoad();
  if (v.ok) {
    console.log('    加载测试  : \u2713 通过 —— 与当前 Node 匹配，无需修复。');
    console.log('');
    process.exit(0);
  }
  console.log('    加载测试  : \u2717 失败');
  console.log('    ' + firstLines(v.err, 6).replace(/\n/g, '\n    '));
  console.log('');
}

// ---------- 拉取本 ABI 的预编译包 ----------
if (!fs.existsSync(PREBUILD_BIN)) {
  console.error('  找不到 prebuild-install（node_modules/prebuild-install/bin.js）。');
  console.error('  先跑 npm install 再来。');
  console.error('');
  bail(1);
}

console.log('  正在获取 ABI ' + ABI + ' 的预编译包（GitHub Releases，需要联网）…');
const args = [
  PREBUILD_BIN, '--verbose', '--force',
  '--runtime', 'node',
  '--target', process.versions.node,
  '--platform', process.platform,
  '--arch', process.arch,
];
const p = spawnSync(process.execPath, args, {
  cwd: MOD_DIR, encoding: 'utf8', stdio: STDIO, timeout: 600000,
});
const out = (p.stdout || '') + (p.stderr || '');
// 只把关键几行回显出来，不然刷屏
for (const line of out.split('\n')) {
  if (/prebuild-install (http|info|warn|error|ERRO)/.test(line)) console.log('    ' + line.trim());
}

// ---------- 如实验证 ----------
const after = canLoad();
console.log('');
if (after.ok) {
  console.log('  \u2713 修复成功：better-sqlite3 现在可以在 Node ' + process.version +
    '（ABI ' + ABI + '）下加载。');
  console.log('');
  process.exit(0);
}

console.error('  \u2717 修复失败。可能原因与对策：');
console.error('    1) 网络拿不到预编译包（GitHub 不通）—— 检查代理/网络后重试。');
console.error('    2) 该 Node 版本没有对应的预编译包 —— 换用有预编译的 Node，或装 MSVC 后手动编译：');
console.error('         cd node_modules/better-sqlite3 && node-gyp rebuild --release');
console.error('    3) 只是想跑起来：先跑 node tools/doctor.js，看清有哪几个 Node、谁匹配。');
console.error('');
console.error('  原始错误：');
console.error('    ' + firstLines(after.err, 8).replace(/\n/g, '\n    '));
console.error('');
bail(1);
