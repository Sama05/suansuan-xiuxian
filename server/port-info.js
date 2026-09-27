/**
 * 端口占用查询 —— 只有 Node 侧用（浏览器不吃这个文件，所以别放进 shared/）。
 *
 * 抽出来的原因：`server/index.js`（端口冲突提示）、`tools/free-port.js`（释放端口）、
 * `tools/doctor.js`（环境自检）都要回答「谁占着这个端口」。抄三份必然漂移，
 * 而且每个副本都得各自记住「本机 spawnSync 带 stdin 管道会 EBUSY」这个坑。
 *
 * 实现要点：
 *  - 只用 netstat / tasklist / ps 这类系统自带命令，且**不经 shell**（传参数数组），
 *    避免命令注入与转义问题；
 *  - 所有子进程显式 `stdio: ['ignore', 'pipe', 'pipe']`。本机环境下 stdin 开管道会
 *    直接 EBUSY，子进程根本起不来 —— 表现是「查不到占用者」，很容易被误判成解析逻辑错；
 *  - 任何一步失败都不抛，只少一条信息，调用方拿到的仍是可用的结果。
 */
'use strict';

const { execFileSync } = require('child_process');

const STDIO = ['ignore', 'pipe', 'pipe'];

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: STDIO });
}

/** 某端口所有监听进程的 PID（去重后的数字数组）。查不到就返回空数组。 */
function listenerPids(port) {
  const tail = ':' + port;
  const pids = new Set();
  let out;
  try {
    out = run('netstat', ['-ano']);
  } catch (e) {
    return [];
  }
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!/^TCP/i.test(t) || !/LISTEN/i.test(t)) continue;
    const cols = t.split(/\s+/);              // TCP  本地:端口  外部  状态  PID
    if (cols.length < 4) continue;
    if (!(cols[1] || '').endsWith(tail)) continue;
    const pid = cols[cols.length - 1];
    if (/^\d+$/.test(pid)) pids.add(Number(pid));
  }
  return Array.from(pids);
}

/** 进程名（拿不到就空串）。 */
function procName(pid) {
  try {
    if (process.platform === 'win32') {
      const tl = run('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
      const m = tl.match(/^"([^"]+)"/);
      return m ? m[1] : '';
    }
    return run('ps', ['-p', String(pid), '-o', 'comm=']).trim();
  } catch (e) {
    return '';
  }
}

/** [{ pid, name }] —— 占用指定端口的监听进程。 */
function listenersOf(port) {
  return listenerPids(port).map((pid) => ({ pid, name: procName(pid) }));
}

/**
 * 人类可读的占用者描述，如 `PID 1234（node.exe）`；没人占用或查不到时返回空串。
 * 调用方据此决定要不要打印「占用者：…」那一行。
 */
function describe(port) {
  const list = listenersOf(port);
  if (!list.length) return '';
  return list.map((x) => 'PID ' + x.pid + (x.name ? '（' + x.name + '）' : '')).join('、');
}

/** 进程名是不是 node（free-port 只杀 node，避免误伤无关服务）。 */
function isNodeProc(name) {
  return /^node(\.exe)?$/i.test(String(name || '').trim());
}

module.exports = { listenersOf, listenerPids, describe, isNodeProc };
