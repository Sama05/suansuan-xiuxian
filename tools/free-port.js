#!/usr/bin/env node
/**
 * 释放被占用的端口（默认 3210）。
 *
 * 存在的理由：这个项目反复出现「端口被上一次没退干净的 node 占着 → 启动失败」。
 * 之前每次都得手动 `netstat -ano | grep :3210` 再 `taskkill //PID xxx //F`，
 * 在 Git Bash 里还要注意斜杠要写两个。这里固化成一个命令。
 *
 * 用法：
 *   node tools/free-port.js            # 释放 3210
 *   node tools/free-port.js 3211       # 释放 3211
 *   node tools/free-port.js 3210-3215  # 释放一段
 *   node tools/free-port.js 3210 --dry # 只看占用者，不动手
 *
 * 安全约束：**只结束进程名是 node / node.exe 的占用者**。
 * 端口被别的程序占用时只报告、不杀 —— 免得手滑把一个无关服务干掉。
 *
 * 端口查询复用 server/port-info.js —— 服务端「启动失败」提示用的是同一份，
 * 免得两处各写一遍 netstat 解析然后慢慢漂移。
 */
'use strict';

const { execFileSync } = require('child_process');
const { listenersOf, isNodeProc } = require('../server/port-info');

function parsePorts(argv) {
  const out = [];
  for (const a of argv) {
    if (a.startsWith('--')) continue;
    const m = String(a).match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let p = from; p <= to; p++) out.push(p);
  }
  return out.length ? out : [3210];
}

function kill(pid) {
  try {
    // 同样要显式关掉 stdin：本机子进程带 stdin 管道会 EBUSY（见 server/port-info.js）
    execFileSync('taskkill', ['/PID', String(pid), '/F'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (e) {
    console.error('  结束 PID ' + pid + ' 失败：' + (e && e.message ? e.message : e));
    return false;
  }
}

const dry = process.argv.includes('--dry');
const ports = parsePorts(process.argv.slice(2));

let killed = 0;
let skipped = 0;

for (const port of ports) {
  const list = listenersOf(port);
  if (!list.length) {
    console.log('端口 ' + port + '：空闲');
    continue;
  }
  for (const { pid, name } of list) {
    const label = 'PID ' + pid + (name ? '（' + name + '）' : '');
    if (dry) {
      console.log('端口 ' + port + '：被 ' + label + ' 占用（--dry，未处理）');
      continue;
    }
    if (!isNodeProc(name)) {
      // 不是 node 就不动 —— 端口可能被别的服务占着，误杀代价太大。
      console.log('端口 ' + port + '：被 ' + label + ' 占用 —— 不是 node，已跳过（请自行确认）');
      skipped++;
      continue;
    }
    if (kill(pid)) {
      console.log('端口 ' + port + '：已结束 ' + label);
      killed++;
    }
  }
}

if (!dry) {
  console.log('');
  console.log('结束 ' + killed + ' 个进程' + (skipped ? '，跳过 ' + skipped + ' 个非 node 进程' : '') + '。');
}
process.exit(0);
