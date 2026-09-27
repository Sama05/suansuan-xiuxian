#!/usr/bin/env node
/**
 * 环境自检 —— 「跑不起来」时先跑这个。
 *
 * 用法：node tools/doctor.js
 *
 * 为什么需要它：这台机器上装了**两套 Node**（D:\Application\nodejs 的 24.x 与
 * 别处的 22.x）和**两套 Python**（3.13 / 3.14），取决于 PATH 顺序。同一份代码
 * 在不同解释器下表现可能不一样（原生模块 ABI、编码默认值…），而报错信息
 * 通常根本不会告诉你在用哪个。这里一次性把「实际生效的是谁」打出来。
 *
 * 只读检查，不修改任何东西。任何一项不过都给出可直接照做的修法。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { listenersOf } = require('../server/port-info');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3210;
let problems = 0;

function head(t) { console.log('\n' + t); }
function line(k, v) { console.log('  ' + (k + ' '.repeat(22)).slice(0, 22) + v); }
function pass(name) { console.log('  \u2713 ' + name); }
function bad(name, fix) {
  problems++;
  console.log('  \u2717 ' + name);
  if (fix) String(fix).split('\n').forEach((l) => console.log('      修法：' + l));
}

/** 跑一个外部命令，拿 stdout；失败返回 null。显式关 stdin（本机开管道会 EBUSY）。 */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return null;
  }
}

/** 用**指定路径**的 node 在指定 cwd 跑一段代码，失败也返回可读输出。 */
function execFileSyncSafe(nodePath, args, cwd) {
  try {
    const out = execFileSync(nodePath, args, {
      cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, out: '找不到可执行文件' };
    return { ok: false, out: String((e && (e.stdout || e.stderr)) || (e && e.message) || e).trim() };
  }
}

console.log('='.repeat(52));
console.log('  算力修仙 —— 环境自检');
console.log('='.repeat(52));

// ---------- Node ----------
head('Node');
line('版本', process.version);
line('可执行文件', process.execPath);
line('ABI (modules)', process.versions.modules);
if (Number(process.versions.node.split('.')[0]) < 18) {
  bad('Node 版本过低（需要 >= 18）', '升级 Node 后重跑 npm install');
} else {
  pass('Node 版本满足要求（>= 18）');
}

// ---------- 依赖 ----------
head('依赖');
const deps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {};
const missing = [];
for (const name of Object.keys(deps)) {
  const dir = path.join(ROOT, 'node_modules', name);
  if (!fs.existsSync(dir)) { missing.push(name); continue; }
  try {
    require(dir);                       // 真正加载一次（原生模块会在这里暴露 ABI 问题）
    pass(name + ' 可加载');
  } catch (e) {
    bad(name + ' 装了但加载失败：' + (e && e.message ? e.message.split('\n')[0] : e),
      '若是 NODE_MODULE_VERSION / 找不到 .node 之类的原生模块报错：\n' +
      '      npm rebuild better-sqlite3\n' +
      '      或换回安装时用的那个 Node 再跑（本轮用 ' + process.execPath + '）');
  }
}
if (missing.length) {
  bad('缺依赖：' + missing.join(', '), 'npm install');
} else if (!problems) {
  pass('依赖齐全');
}

// ---------- Python（tools 下的脚本要用） ----------
head('Python（tools/*.py 需要）');
const py = process.platform === 'win32' ? 'python' : 'python3';
const pyVer = tryExec(py, ['-c', 'import sys;print(sys.version.split()[0] + " | " + sys.executable)']);
if (pyVer === null) {
  bad('PATH 里找不到 ' + py,
    '装 Python 并勾选 Add to PATH；或就在 VSCode 里改用「真浏览器验收」任务（已内置退路）');
} else {
  line('版本 | 路径', pyVer);
  pass('Python 可用');
}

// ---------- 端口 ----------
head('端口 ' + PORT);
const list = listenersOf(PORT);
if (!list.length) {
  pass('端口空闲，可以直接启动');
} else {
  line('占用者', list.map((x) => 'PID ' + x.pid + (x.name ? '（' + x.name + '）' : '')).join('、'));
  const allNode = list.every((x) => /^node(\.exe)?$/i.test(String(x.name || '').trim()));
  if (allNode) {
    // 这不算「自检失败」—— 服务可能本来就在跑。但必须说清楚下一步会撞上什么，
    // 否则用户按 F5 看到「端口已被占用」会以为是环境坏了。
    console.log('      注意：占用者是 node，通常是已经在运行的服务 —— 那就不用再启，直接开');
    console.log('            http://localhost:' + PORT + ' 即可。');
    console.log('      若想重启：node tools/free-port.js ' + PORT + ' 然后 npm start / F5');
  } else {
    bad('端口被非 node 进程占用', '换个端口启动：PORT=3211 npm start');
  }
}

// ---------- VSCode 配置 ----------
head('VSCode 配置');
const VSC = path.join(ROOT, '.vscode');
const wants = ['launch.json', 'tasks.json', 'settings.json', 'extensions.json'];
const miss = wants.filter((f) => !fs.existsSync(path.join(VSC, f)));
if (miss.length) {
  bad('.vscode 缺文件：' + miss.join(', '), '从仓库重新拉一份（这些是随仓库走的）');
} else {
  pass('.vscode 四个配置齐全');
  // 关键路径是否存在：终端 profile / git.path 写死了本机绝对路径
  const strip = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  try {
    const st = JSON.parse(strip(fs.readFileSync(path.join(VSC, 'settings.json'), 'utf8')));
    const bash = (((st['terminal.integrated.profiles.windows'] || {})['Git Bash']) || {}).path;
    if (bash && !fs.existsSync(bash)) {
      bad('settings.json 里的 Git Bash 路径不存在：' + bash,
        '改成这台机器上真实的 bash.exe 路径（which bash）');
    } else if (bash) {
      pass('Git Bash 路径存在');
    }
    const gp = st['git.path'];
    if (gp && !fs.existsSync(gp)) {
      bad('settings.json 里的 git.path 不存在：' + gp, '改成这台机器上真实的 git.exe 路径');
    } else if (gp) {
      pass('git.path 存在');
    }

    // 最关键的一条：VSCode 钉死的那个 Node，能不能真的把服务跑起来？
    // 原生模块的 ABI 只在「目标 Node 实际加载一次」时才算验过 ——
    // 光看版本号是不够的（踩过：两套 Node 都“版本够”，但只有一个能加载）。
    const pinned = st['suansuan.node'];
    if (!pinned) {
      console.log('  - 未设置 suansuan.node，VSCode 会用它自己找的 Node（可能与依赖不匹配）');
    } else if (!fs.existsSync(pinned)) {
      bad('settings.json 的 suansuan.node 不存在：' + pinned,
        '改成这台机器上真实的 node.exe 路径；或在文件里删掉该行改用 PATH 里的 node');
    } else {
      const v = tryExec(pinned, ['-v']);
      line('VSCode 运行时', pinned + (v ? '  ' + v : ''));
      const r = execFileSyncSafe(pinned, ['-e', "require('better-sqlite3')"], ROOT);
      if (r.ok) {
        pass('钉死的运行时能加载 better-sqlite3 —— F5 可以跑');
      } else {
        bad('钉死的运行时加载 better-sqlite3 失败 —— F5 会 ERR_DLOPEN_FAILED',
          '在项目根目录执行：npm run fix-native\n' +
          '      （或在 VSCode 里跑任务「修复原生模块（ABI 不匹配时）」）\n' +
          '      原因：原生模块的 ABI 与这个 Node 不一致，需按该 Node 重装');
      }
    }
  } catch (e) {
    bad('settings.json 解析失败：' + e.message);
  }
}

// ---------- 结论 ----------
console.log('\n' + '='.repeat(52));
if (problems === 0) {
  console.log('  自检通过。启动：npm start   或  VSCode 里按 F5');
} else {
  console.log('  发现 ' + problems + ' 个问题，按上面「修法」逐条处理。');
}
console.log('='.repeat(52) + '\n');
process.exit(problems === 0 ? 0 : 1);
