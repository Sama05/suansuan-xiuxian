/**
 * 测试总入口 —— 依次运行所有测试套件
 * 用法: node tests/run.js  或  npm test
 */

const { spawnSync } = require('child_process');
const path = require('path');

const NODE = process.execPath;
const suites = [
  { name: 'Decimal 单元测试', file: 'decimal.test.js' },
  { name: '游戏核心单元测试', file: 'core.test.js' },
  { name: '前端加载与结构测试', file: 'frontend.test.js' },
  { name: '接口端到端测试', file: 'e2e.js', needsServer: true },
];

/** 检查服务是否在跑 */
async function serverUp() {
  try {
    await fetch('http://localhost:3210/');
    return true;
  } catch (e) {
    return false;
  }
}

(async function main() {
  const up = await serverUp();

  console.log('');
  console.log('='.repeat(52));
  console.log('  算力修仙 —— 测试套件');
  console.log('='.repeat(52));

  let totalFail = 0;
  const results = [];

  for (const s of suites) {
    if (s.needsServer && !up) {
      console.log('\n  ⚠ 跳过「' + s.name + '」：服务未启动');
      console.log('    请先运行 node server/index.js');
      results.push({ name: s.name, status: 'skipped' });
      continue;
    }

    // stdin 必须是 'ignore'：本机环境下 spawnSync 给 stdin 开管道会直接 EBUSY，
    // 子进程起不来（status=null），整套测试会被误判成失败。
    const r = spawnSync(NODE, [path.join(__dirname, s.file)], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    process.stdout.write(r.stdout || '');
    if (r.stderr && r.stderr.trim() && !/dirname|shim|command not found/.test(r.stderr)) {
      process.stderr.write(r.stderr);
    }

    if (r.status !== 0) totalFail++;
    results.push({ name: s.name, status: r.status === 0 ? 'pass' : 'fail' });
  }

  console.log('');
  console.log('='.repeat(52));
  console.log('  汇总');
  console.log('='.repeat(52));
  for (const r of results) {
    const mark = r.status === 'pass' ? '\u2713' : (r.status === 'fail' ? '\u2717' : '-');
    console.log('  ' + mark + '  ' + r.name + (r.status === 'skipped' ? '（已跳过）' : ''));
  }
  console.log('');

  process.exit(totalFail > 0 ? 1 : 0);
})();
