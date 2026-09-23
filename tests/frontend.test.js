/**
 * 前端脚本测试
 *
 * 用最小 DOM 桩在 Node 里加载 public/js/app.js，验证：
 *   1) 模块依赖齐全、无语法错误、初始化与事件绑定不抛异常
 *   2) boot 流程跑完后，DOM 上确实被渲染出了内容（不是白板）
 *   3) HTML 里 5 个子页面与导航齐全，app.js 引用的 id 全部存在
 *   4) 前后端共用模块的契约成立
 *
 * 这能在不起浏览器的情况下拦住大部分前端低级错误。
 *
 * 用法: node tests/frontend.test.js
 */

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ---------- DOM 桩 ----------
let EL_CACHE = {};

function mkEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', disabled: false, checked: false,
    style: {}, dataset: {}, children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) {
        if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else { f ? this._s.add(c) : this._s.delete(c); }
      },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); }, remove() {}, focus() {},
    querySelector() { return mkEl('q'); },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
}

/**
 * 一个「能查到自己子元素」的列表容器桩。
 *
 * app.js 先把列表铺成 innerHTML（骨架），之后又用 querySelectorAll('.co-line') /
 * ('.co-good') 逐个回填动态数值。真实 DOM 需要解析 HTML 才能拿到这些子元素，
 * 而 innerHTML 在桩里只是个字符串 —— 所以这里直接按 dataset 造出子元素，
 * 让动态回填分支真正被执行。否则那些循环永远走空，等于没测。
 */
function mkListMock(ids, roles, attr) {
  const selfClass = (attr === 'good') ? 'co-good' : null;

  const items = ids.map((id) => {
    const sub = {};
    for (const r of roles) sub[r] = mkEl(id + '.' + r);
    const item = {
      dataset: { [attr]: id },
      classList: mkEl('c').classList,
      innerHTML: '', style: {}, disabled: false,
      querySelector(sel) {
        const m = /\[data-role="([^"]+)"\]/.exec(String(sel));
        return (m && sub[m[1]]) ? sub[m[1]] : mkEl('missing');
      },
      // 市场页的商品行是**嵌在行业分组里**的：容器先查 .mk-group，
      // 再从每个分组里查 .co-good。所以商品行必须能「查到自己」，
      // 否则整个回填循环走空 —— 价格永远渲染不出来。
      querySelectorAll(sel) {
        return (selfClass && sel === '.' + selfClass) ? [item] : [];
      },
      _sub: sub,
    };
    return item;
  });
  return {
    innerHTML: '', style: {}, classList: mkEl('c').classList,
    addEventListener() {}, appendChild() {}, remove() {},
    querySelectorAll() { return items; },
    querySelector() { return mkEl('q'); },
    _items: items,
  };
}

function installStubs() {
  global.window = global;
  global.addEventListener = () => {};
  global.removeEventListener = () => {};
  EL_CACHE = {};
  global.document = {
    getElementById: (id) => (EL_CACHE[id] = EL_CACHE[id] || mkEl(id)),
    querySelector: () => mkEl('q'),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => mkEl('new'),
    body: mkEl('body'),
    activeElement: null,
    visibilityState: 'visible',
  };
  // 关键：必须让 localStorage 里存在 token，否则 boot 会直接停在登录页，
  // 游戏内的渲染逻辑完全不会被执行，测试就成了空转。
  global.localStorage = {
    getItem: (k) => (k === 'suansuan-xiuxian-token'
      ? JSON.stringify({ token: 'test-token', username: 'tester' })
      : null),
    setItem() {}, removeItem() {},
  };
  global.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).indexOf('/api/me') >= 0
      ? { ok: true, username: 'tester' }
      : { ok: true }),
  });
  global.XMLHttpRequest = function () {
    this.open = () => {}; this.setRequestHeader = () => {}; this.send = () => {};
  };
  global.setInterval = () => 0;
  global.clearInterval = () => {};
}

// ============================================================

(async function main() {

  console.log('\n=== 静态资源存在性 ===');
  {
    const files = [
      'public/index.html',
      'public/css/style.css',
      'public/js/app.js',
      'shared/decimal.js',
      'shared/game-config.js',
      'shared/game-core.js',
      'server/index.js',
      'server/db.js',
    ];
    for (const f of files) ok(fs.existsSync(path.join(ROOT, f)), f + ' 存在');
  }

  console.log('\n=== HTML 结构完整性 ===');
  const html = read('public/index.html');
  {
    // app.js 引用的每个 id 都必须在 HTML 里存在，否则运行时会 null 报错
    const appSrc = read('public/js/app.js');
    const usedIds = new Set();
    const re = /\$\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(appSrc))) usedIds.add(m[1]);

    const missing = [];
    for (const id of usedIds) {
      if (!html.includes('id="' + id + '"')) missing.push(id);
    }
    ok(missing.length === 0, 'app.js 引用的 ' + usedIds.size + ' 个元素 id 全部存在于 HTML',
      missing.length ? '缺失: ' + missing.join(', ') : '');

    for (const s of ['/shared/decimal.js', '/shared/game-config.js', '/shared/game-core.js', '/js/app.js']) {
      ok(html.includes(s), 'HTML 引入 ' + s);
    }
    ok(html.includes('/css/style.css'), 'HTML 引入样式表');

    ok(html.includes('id="login-screen"'), '存在登录容器');
    ok(html.includes('id="game-screen"'), '存在游戏主界面容器');
  }

  console.log('\n=== 子页面导航 ===');
  {
    const tabs = ['realm', 'work', 'tech', 'invest', 'technique', 'company', 'market', 'stock'];
    for (const t of tabs) {
      ok(html.includes('data-tab="' + t + '"'), '导航含「' + t + '」标签');
      ok(html.includes('data-page="' + t + '"'), '存在「' + t + '」子页面');
    }

    // 工作页必须有精力条、当前工作、工作列表
    ok(html.includes('id="ui-energy-bar"'), '工作页含精力条');
    ok(html.includes('id="ui-job-bar"'), '工作页含当前工作进度条');
    ok(html.includes('id="job-list"'), '工作页含工作列表容器');
    ok(html.includes('id="btn-rush"'), '工作页含催工按钮');

    // 时间系统：档位选择已改成顶栏四键
    ok(html.includes('id="ui-clock"'), '顶栏含游戏内时钟');
    ok(html.includes('id="btn-tc-play"') && html.includes('id="btn-tc-max"') &&
       html.includes('id="btn-tc-slower"') && html.includes('id="btn-tc-faster"'),
      '顶栏含时间流速四键（减速 / 播放暂停 / 加速 / 最大速）');
    ok(html.includes('id="event-bar"') && html.includes('id="ui-ev-text"'),
      '页面最上方含事件通知栏');

    // 功法页锁定占位
    ok(html.includes('id="technique-panel"'), '功法页容器存在');
    ok(/功法|technique/.test(html), '功法页有内容');

    // 公司页：锁定占位 / 经营主体 / 生产线 / 仓库 / 工业算力
    ok(html.includes('id="company-panel"'), '公司页含未成立占位');
    ok(html.includes('id="company-main"'), '公司页含经营主体');
    ok(html.includes('id="co-line-list"'), '公司页含生产线容器');
    ok(html.includes('id="ui-co-cp-pool"'), '公司页含工业算力供给');
    ok(html.includes('id="ui-co-cp-demand"'), '公司页含工业算力需求');
    ok(html.includes('id="ui-co-cp-bar"'), '公司页含算力供需条');
    ok(html.includes('id="btn-found-company"'), '公司页含注册按钮');
    ok(html.includes('id="btn-co-warehouse"'), '公司页含仓库扩容按钮');
    ok(html.includes('id="chk-co-autosell"'), '公司页含自动卖出开关');
    ok(html.includes('id="ui-co-cycle-bar"'), '公司页含周期进度条');
    ok(html.includes('id="tab-company-badge"'), '公司页含未成立徽章');

    // 市场页（独立页）：行业景气 / 走势图 / 商品行情 / 清仓
    ok(html.includes('id="mk-ind-list"'), '市场页含行业景气容器');
    ok(html.includes('id="mk-good-list"'), '市场页含商品行情容器');
    ok(html.includes('id="mk-chart-body"'), '市场页含价格走势图');
    ok(html.includes('id="btn-mk-sell-all"'), '市场页含清仓按钮');
    ok(html.includes('id="ui-mk-stock-value"'), '市场页含库存估值');

    // 股市页：锁定占位 / 账户概览 / 行情时钟 / 行情列表 / 走势图
    ok(html.includes('id="stock-panel"'), '股市页含未开户占位');
    ok(html.includes('id="stock-main"'), '股市页含账户主体');
    ok(html.includes('id="ui-st-lock"'), '股市页含未开户原因');
    ok(html.includes('id="ui-st-value"'), '股市页含总市值');
    ok(html.includes('id="ui-st-cost"'), '股市页含持仓成本');
    ok(html.includes('id="ui-st-pnl"'), '股市页含浮动盈亏');
    ok(html.includes('id="ui-st-liq"'), '股市页含清仓可变现');
    ok(html.includes('id="ui-st-liqpnl"'), '股市页含可变现盈亏');
    ok(html.includes('id="ui-st-realized"'), '股市页含累计已实现');
    ok(html.includes('id="ui-st-fee"'), '股市页含累计手续费');
    ok(html.includes('id="ui-st-trades"'), '股市页含成交笔数');
    ok(html.includes('id="ui-st-periodbar"'), '股市页含行情时钟进度条');
    ok(html.includes('id="ui-st-rules"'), '股市页含交易规则说明');
    ok(html.includes('id="st-list"'), '股市页含行情列表容器');
    ok(html.includes('id="st-chart-body"'), '股市页含走势图容器');
    ok(html.includes('id="tab-stock-badge"'), '股市页含未开户徽章');

    // 旧的工作按钮应已移除
    ok(!html.includes('id="work-btn"'), '旧的单一「工作」按钮已移除');
  }

  console.log('\n=== 公司页样式（涨红跌绿）===');
  {
    const css = read('public/css/style.css');
    const hexOf = (name) => {
      const m = new RegExp('--' + name + ':\\s*#([0-9a-fA-F]{6})').exec(css);
      return m ? m[1] : null;
    };
    const redHex = hexOf('red');
    const jadeHex = hexOf('jade');

    ok(redHex !== null, '定义了 --red', String(redHex));
    ok(jadeHex !== null, '定义了 --jade', String(jadeHex));

    // 涨红跌绿：红要红得下去（R 最高），绿要绿得出来（G 最高）
    const red = redHex ? {
      r: parseInt(redHex.slice(0, 2), 16),
      g: parseInt(redHex.slice(2, 4), 16),
      b: parseInt(redHex.slice(4, 6), 16),
    } : null;
    const jade = jadeHex ? {
      r: parseInt(jadeHex.slice(0, 2), 16),
      g: parseInt(jadeHex.slice(2, 4), 16),
      b: parseInt(jadeHex.slice(4, 6), 16),
    } : null;
    ok(red && red.r > red.g && red.r > red.b, '--red 是红色调', String(redHex));
    ok(jade && jade.g > jade.r && jade.g > jade.b, '--jade 是绿色调', String(jadeHex));

    ok(/\.co-good-price\s+\.trend\.up\s*\{[^}]*var\(--red\)/.test(css),
      '「涨」用红色（中国习惯）');
    ok(/\.co-good-price\s+\.trend\.down\s*\{[^}]*var\(--jade\)/.test(css),
      '「跌」用绿色（中国习惯）');
    ok(/\.co-good-price\s+\.trend\.flat\s*\{[^}]*\}/.test(css), '「平」有独立样式');

    // 公司页的关键版式都在
    for (const sel of ['.co-line', '.co-line-title', '.co-line-stats', '.co-line-lock',
      '.co-good', '.co-good-price', '.co-good-stock', '.co-good-sell',
      '.co-market-foot', '.co-cycle']) {
      ok(css.indexOf(sel) >= 0, '公司页样式含 ' + sel);
    }
    ok(/@media[^{]*max-width:\s*620px/.test(css), '公司页有窄屏适配');
  }

  console.log('\n=== 股市页样式 ===');
  {
    const css = read('public/css/style.css');
    for (const sel of ['.st-row', '.st-row.selected', '.st-icon', '.st-main',
      '.st-price', '.st-hold', '.st-trade', '.st-trade-cost', '.st-impact', '.st-rules']) {
      ok(css.indexOf(sel) >= 0, '股市页样式含 ' + sel);
    }
    // 涨红跌绿同样适用于股市
    ok(/\.st-price\s+\.trend\.up\s*\{[^}]*var\(--red\)/.test(css),
      '股价「涨」用红色（中国习惯）');
    ok(/\.st-price\s+\.trend\.down\s*\{[^}]*var\(--jade\)/.test(css),
      '股价「跌」用绿色（中国习惯）');
    ok(/\.st-hold\s+\.pnl\.up\s*\{[^}]*var\(--red\)/.test(css),
      '持仓盈利用红色');
    ok(/\.st-hold\s+\.pnl\.down\s*\{[^}]*var\(--jade\)/.test(css),
      '持仓亏损用绿色');
    ok(/\.st-impact\.down\s+\.co-press-bar\s+i\s*\{[^}]*var\(--jade\)/.test(css),
      '卖盘折价的冲击条用绿色');
    ok(/@media[^{]*max-width:\s*620px[\s\S]{0,400}\.st-spark\s*\{\s*display:\s*none/.test(css),
      '股市页有窄屏适配');
  }

  console.log('\n=== 顶栏布局稳定性（防「资源条跳动」）===');
  {
    const css = read('public/css/style.css');
    const html0 = read('public/index.html');
    const app = read('public/js/app.js');

    // 资源条必须是「固定列数网格」：列宽只由容器决定，与文本长度无关。
    // 若退回 flex + flex-wrap，副标题一变长就可能跨过换行阈值折行，
    // 顶栏高度随之变化，整页内容跟着上下跳。
    const rg = /\.res-group\s*\{[^}]*\}/.exec(css);
    ok(!!rg, '存在 .res-group 样式');
    const rgb = rg ? rg[0] : '';
    ok(/display:\s*grid/.test(rgb), '资源条用 grid 布局（列宽不受内容影响）');
    ok(/grid-template-columns:\s*repeat\(\s*6/.test(rgb), '资源条固定 6 列');
    ok(!/flex-wrap/.test(rgb), '资源条不再使用 flex-wrap（跳动的根因）');

    const resCount = (html0.match(/class="res"/g) || []).length;
    ok(resCount === 6, '顶栏资源项恰为 6 项，与列数一致', String(resCount));

    ok(/\.res\s+\.v\s*\{[^}]*white-space:\s*nowrap/.test(css), '资源数值单行不换行');
    ok(/\.res\s+\.v\s*\{[^}]*tabular-nums/.test(css), '资源数值用等宽数字');
    ok(/\.res\s+\.sub\s*\{[^}]*min-height/.test(css), '副标题保留行高，不会塌陷');

    ok(/\.clock\s*\{[^}]*min-width/.test(css), '时钟固定最小宽度，日期位数变化不推挤');
    ok(/#ui-username\s*\{[^}]*max-width/.test(css), '用户名限宽截断');

    ok(/@media\s*\(max-width:\s*1080px\)[\s\S]{0,200}?\.res-group[\s\S]{0,120}?repeat\(/.test(css),
      '窄屏资源条仍按固定列数排');

    ok(/function setText\(/.test(app), '存在 setText 值缓存写入');
    ok(!/\$\('ui-money'\)\.textContent\s*=/.test(app),
      '顶栏不再无条件重写 textContent（避免每帧重排）');
  }

  console.log('\n=== app.js 加载（模拟浏览器） ===');
  {
    installStubs();
    require(path.join(ROOT, 'shared', 'decimal.js'));
    require(path.join(ROOT, 'shared', 'game-config.js'));
    require(path.join(ROOT, 'shared', 'game-core.js'));

    let err = null;
    try {
      require(path.join(ROOT, 'public', 'js', 'app.js'));
    } catch (e) {
      err = e;
    }
    ok(err === null, 'app.js 初始化无异常',
      err ? err.message + ' @ ' + (err.stack || '').split('\n')[1] : '');

    ok(typeof global.Decimal === 'function', 'window.Decimal 可用');
    ok(typeof global.GAME === 'object', 'window.GAME 可用');
    ok(typeof global.GameCore === 'object', 'window.GameCore 可用');

    // boot 是异步的，等它跑完再检查渲染结果
    await new Promise((r) => setTimeout(r, 60));

    const el = (id) => EL_CACHE[id];
    ok(el('ui-clock') && /^\d{4}年\d{1,2}月\d{1,2}日/.test(el('ui-clock').textContent),
      'boot 后时钟已渲染', el('ui-clock') && el('ui-clock').textContent);
    ok(el('ui-clock') && el('ui-clock').textContent.indexOf('2000年') === 0,
      '游戏内时间从 2000 年起算', el('ui-clock') && el('ui-clock').textContent);
    ok(el('ui-clock-tier') && el('ui-clock-tier').textContent.length > 0,
      '时钟含当前档位说明', el('ui-clock-tier') && el('ui-clock-tier').textContent);

    ok(el('ui-money') && el('ui-money').textContent === '20',
      '顶栏金钱已渲染（初始 20）', el('ui-money') && el('ui-money').textContent);
    ok(el('ui-energy-val') && el('ui-energy-val').textContent === '100 / 100',
      '精力已渲染（上限整数）', el('ui-energy-val') && el('ui-energy-val').textContent);
    ok(el('ui-energy-rate') && el('ui-energy-rate').textContent === '+1 / 秒',
      '精力恢复速率已渲染（凡人 1 点/秒，整数不带小数点）',
      el('ui-energy-rate') && el('ui-energy-rate').textContent);

    ok(el('ui-job-name') && el('ui-job-name').textContent === '街头发传单',
      '当前工作已渲染（默认第一份）', el('ui-job-name') && el('ui-job-name').textContent);
    ok(el('ui-job-money') && el('ui-job-money').textContent === '+20',
      '工作单次收益已渲染', el('ui-job-money') && el('ui-job-money').textContent);
    ok(el('ui-job-time') && el('ui-job-time').textContent.indexOf('/') > 0,
      '工作进度已渲染', el('ui-job-time') && el('ui-job-time').textContent);

    // 时间流速：列表已移除，改为顶栏四键 + 时钟旁的档位文案
    ok(el('ui-clock-tier') && el('ui-clock-tier').textContent.indexOf('1 秒') === 0,
      '时钟旁显示当前档位', el('ui-clock-tier') && el('ui-clock-tier').textContent);
    ok(!el('tier-list'), '境界页不再铺档位列表（已由顶栏四键取代）');

    // 工作列表骨架
    const jobHtml = el('job-list') ? el('job-list').innerHTML : '';
    ok(jobHtml.length > 0 && jobHtml.indexOf('街头发传单') >= 0, '工作列表已渲染');
    ok(jobHtml.split('class="job-item').length - 1 >= 10,
      '工作列表条目数 ≥ 10', String(jobHtml.split('class="job-item').length - 1));

    // 投向里应有功法增幅。锁定标签改成了「文案由核心层给」—— 骨架里只留占位，
    // 所以这里改为断言：① 占位存在；② 核心层给出的锁定文案两方向各自正确。
    // （早先写成写死的「未习得功法」，于是工业产能未成立公司时也显示「未习得功法」。）
    const invHtml = el('inv-list') ? el('inv-list').innerHTML : '';
    ok(invHtml.indexOf('功法算力投入') >= 0, '投向列表含「功法算力投入」项');
    ok(invHtml.indexOf('data-role="locktag"') >= 0, '投向锁定标签占位已就位');
    const st0 = global.GameCore.createState();
    const invTech = global.GAME.investments.find((i) => i.id === 'technique');
    const invInd = global.GAME.investments.find((i) => i.id === 'industry');
    ok(global.GameCore.investmentLockReason(st0, invTech) === '未习得功法',
      '功法增幅未习得时锁定文案 = 未习得功法');
    ok(global.GameCore.investmentLockReason(st0, invInd) === '未成立公司',
      '工业产能未成立公司时锁定文案 = 未成立公司（不再是「未习得功法」）');
    // 习得功法之后（哪怕没在修炼）功法增幅必须可用 —— 这是本轮修的可用性判定
    st0.learned = { jiuzhang: { mastery: 0, tier: 0, passive: false } };
    st0.technique = null;
    ok(global.GameCore.investmentAvailable(st0, invTech) === true,
      '已习得功法（未在修炼）时功法增幅可用');
    ok(global.GameCore.investmentLockReason(st0, invTech) === '',
      '已习得功法后不再显示锁定文案');

    // 功法页
    ok(el('ui-tech-unlock') && el('ui-tech-unlock').textContent.length > 0,
      '功法页解锁条件已渲染', el('ui-tech-unlock') && el('ui-tech-unlock').textContent);

    // 公司页（默认存档：凡人，未成立）
    ok(!el('company-panel').classList.contains('hidden'), '公司页未成立占位已显示');
    ok(el('company-main').classList.contains('hidden'), '公司页经营主体已隐藏');
    ok(el('tab-company-badge') && el('tab-company-badge').textContent === '未成立',
      '公司标签徽章显示未成立', el('tab-company-badge') && el('tab-company-badge').textContent);
    ok(el('ui-co-found-cost') && el('ui-co-found-cost').textContent.length > 0,
      '公司注册费已渲染', el('ui-co-found-cost') && el('ui-co-found-cost').textContent);
    ok(el('ui-co-found-lock') && el('ui-co-found-lock').textContent.indexOf('炼气') >= 0,
      '公司未解锁原因已渲染', el('ui-co-found-lock') && el('ui-co-found-lock').textContent);
    ok(el('btn-found-company') && el('btn-found-company').disabled === true,
      '凡人时注册按钮被禁用');
    ok(el('btn-found-company') && el('btn-found-company').textContent === '尚未解锁',
      '凡人时注册按钮文案为尚未解锁',
      el('btn-found-company') && el('btn-found-company').textContent);

    // 股市页（默认存档：凡人，未开户）
    ok(!el('stock-panel').classList.contains('hidden'), '股市页未开户占位已显示');
    ok(el('stock-main').classList.contains('hidden'), '股市页账户主体已隐藏');
    ok(el('tab-stock-badge') && el('tab-stock-badge').textContent === '未开户',
      '股市标签徽章显示未开户', el('tab-stock-badge') && el('tab-stock-badge').textContent);
    ok(el('ui-st-lock') && el('ui-st-lock').textContent.indexOf('炼气') >= 0,
      '股市未开户原因已渲染', el('ui-st-lock') && el('ui-st-lock').textContent);

    // 股市行情列表骨架：静态铺满
    const stHtml = el('st-list') ? el('st-list').innerHTML : '';
    ok(stHtml.split('data-stock="').length - 1 === global.GAME.stock.stocks.length,
      '股市行情列表铺满全部股票',
      String(stHtml.split('data-stock="').length - 1));
    ok(stHtml.indexOf('金石矿业') >= 0 && stHtml.indexOf('太虚洞天') >= 0,
      '股市行情列表含首尾股票');
    ok(stHtml.indexOf('联动 · ') >= 0, '股市标出了与公司商品的联动');
    ok(stHtml.indexOf('买入') >= 0 && stHtml.indexOf('卖出') >= 0 && stHtml.indexOf('清仓') >= 0,
      '股市行情列表含买卖清仓按钮');
    // 主营业务：行情一动就能看出波及哪家公司
    ok(stHtml.indexOf('主营：') >= 0, '股市每行标出主营业务');
    ok(stHtml.indexOf('铁矿石开采与粗选') >= 0, '主营文案取自配置',
      stHtml.slice(stHtml.indexOf('主营：'), stHtml.indexOf('主营：') + 24));
    ok(stHtml.indexOf('修仙宗门') >= 0 && stHtml.indexOf('>科技<') >= 0,
      '股市标出了科技 / 修仙门类');

    // 生产线 / 市场列表是静态骨架，应当一次铺满
    const coLineHtml = el('co-line-list') ? el('co-line-list').innerHTML : '';
    ok(coLineHtml.split('data-line="').length - 1 === global.GAME.company.lines.length,
      '生产线列表铺满全部生产线',
      String(coLineHtml.split('data-line="').length - 1));
    ok(coLineHtml.indexOf('矿井') >= 0 && coLineHtml.indexOf('洞天营造司') >= 0,
      '生产线列表含首尾生产线');
    ok(coLineHtml.indexOf('科技 · ') >= 0 && coLineHtml.indexOf('修仙 · ') >= 0,
      '生产线标出了科技 / 修仙门类');
    ok(coLineHtml.indexOf('购入') >= 0, '生产线含购入按钮');

    const coGoodHtml = el('mk-good-list') ? el('mk-good-list').innerHTML : '';
    ok(coGoodHtml.split('data-good="').length - 1 === global.GAME.company.goods.length,
      '市场列表铺满全部商品',
      String(coGoodHtml.split('data-good="').length - 1));
    // 商品按行业分组：每个有产物的行业一个分组头
    ok(coGoodHtml.split('class="mk-group ').length - 1 === global.GAME.company.industries.length,
      '市场按行业分组',
      String(coGoodHtml.split('class="mk-group ').length - 1));
    ok(coGoodHtml.indexOf('铁矿石') >= 0 && coGoodHtml.indexOf('世界树') >= 0,
      '市场列表含首尾商品');
    ok(coGoodHtml.indexOf('上游 · ') >= 0, '行业分组标出上游行业');
    ok(coGoodHtml.indexOf('每 1 分钟变价') >= 0 && coGoodHtml.indexOf('每 10 分钟变价') >= 0,
      '市场标出科技类 1 分钟 / 修仙类 10 分钟变价');
    ok(coGoodHtml.indexOf('卖出') >= 0, '市场含卖出按钮');

    // 行业景气条
    const indHtml = el('mk-ind-list') ? el('mk-ind-list').innerHTML : '';
    ok(indHtml.split('data-industry="').length - 1 === global.GAME.company.industries.length,
      '行业景气铺满全部行业',
      String(indHtml.split('data-industry="').length - 1));
  }

  console.log('\n=== 功法页（已习得功法后）===');
  {
    const Core = global.GameCore;
    const D = global.Decimal;

    // 造一份「已买个人电脑 → 已习得第一本功法」的存档
    const s = Core.createState();
    s.money = new D(1e6);
    Core.buyDevice(s, 'pc');
    Core.tick(s, 120, { offline: false });
    const snap = Core.serialize(s);

    installStubs();
    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/api/me') >= 0) {
        return { ok: true, status: 200, json: async () => ({ ok: true, username: 'tester' }) };
      }
      if (u.indexOf('/api/load') >= 0) {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, isNew: false, state: snap, config: null, offline: null }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    delete require.cache[path.join(ROOT, 'public', 'js', 'app.js')];
    let err2 = null;
    try {
      require(path.join(ROOT, 'public', 'js', 'app.js'));
    } catch (e) {
      err2 = e;
    }
    ok(err2 === null, '带功法存档时 app.js 初始化无异常',
      err2 ? err2.message + ' @ ' + (err2.stack || '').split('\n')[1] : '');
    await new Promise((r) => setTimeout(r, 60));

    const el2 = (id) => EL_CACHE[id];
    const T = (id) => (el2(id) ? el2(id).textContent : '');

    ok(!el2('technique-main').classList.contains('hidden'),
      '功法主界面已显示');
    ok(el2('technique-panel').classList.contains('hidden'),
      '锁定占位已隐藏');
    ok(T('tab-technique-badge') === '已习得', '标签徽章显示已习得', T('tab-technique-badge'));

    ok(T('ui-tech-name') === '九章算经·残卷', '当前功法名已渲染', T('ui-tech-name'));
    // 稀有度阶梯已改为「天最稀有、荒最普遍」：第一本功法（算术）是最常见的荒
    ok(T('ui-tech-rarity') === '荒', '稀有度已渲染', T('ui-tech-rarity'));
    ok(el2('ui-tech-rarity').dataset.rarity === '荒', '稀有度标记已设置');
    ok(global.GAME.techniques.rarities[0].name === '荒' &&
       global.GAME.techniques.rarities[global.GAME.techniques.rarities.length - 1].name === '天',
      '稀有度阶梯：荒最普遍 → 天最稀有');
    ok(T('ui-tech-school').indexOf('算术') >= 0, '功法门类已渲染', T('ui-tech-school'));
    ok(/^\d+$/.test(T('ui-tech-level')), '功法等级已渲染', T('ui-tech-level'));
    ok(T('ui-tech-main').charAt(0) === '+', '主属性（灵气吸收）已渲染', T('ui-tech-main'));
    ok(T('ui-tech-desc').length > 0 && T('ui-tech-desc').indexOf('竹简') >= 0,
      '功法说明已渲染', T('ui-tech-desc'));

    const M = global.GAME.techniques.mastery;
    ok(M.map((x) => x.name).indexOf(T('ui-tech-mastery-tier')) >= 0,
      '熟练度段位已渲染（是六个段位之一）', T('ui-tech-mastery-tier'));
    ok(T('ui-tech-mastery-val').indexOf('/') > 0, '熟练度数值已渲染', T('ui-tech-mastery-val'));
    ok(/^\+\d/.test(T('ui-tech-cultivate')), '修炼速度已渲染', T('ui-tech-cultivate'));
    ok(/工作金钱/.test(el2('ui-tech-passive').innerHTML), '被动属性已渲染');
    ok(/修满后转为常驻|已常驻/.test(el2('ui-tech-passive').innerHTML),
      '被动属性标出了常驻条件');

    ok(T('ui-tech-count').indexOf('/') > 0, '功法阁计数已渲染', T('ui-tech-count'));
    // v3.4：功法阁只渲染「已拥有」的功法（本场景学了 2 本）；全部功法走图鉴
    const techHtml = el2('tech-list') ? el2('tech-list').innerHTML : '';
    const techCount = techHtml.split('data-tech="').length - 1;
    ok(techCount === 2,
      '功法阁只显示已拥有的功法（不渲染未习得的行）',
      String(techCount) + ' / ' + global.GAME.techniques.list.length);
    const codexHtml = el2('tech-codex') ? el2('tech-codex').innerHTML : '';
    const codexCount = codexHtml.split('data-codex="').length - 1;
    ok(codexCount === global.GAME.techniques.list.length,
      '图鉴渲染出全部功法（含未拥有的）',
      String(codexCount) + ' / ' + global.GAME.techniques.list.length);
    ok(codexHtml.indexOf('九章算经') >= 0 && codexHtml.indexOf('连续统真言') >= 0 &&
       codexHtml.indexOf('解锁：') >= 0,
      '图鉴含稀有度两端功法并给出解锁条件');

    ok(el2('passive-list').innerHTML.indexOf('工作金钱') >= 0, '常驻被动汇总已渲染');

    ok(T('ui-sh-total').length > 0 && T('ui-sh-total') !== '0', '神识已渲染', T('ui-sh-total'));
    ok(/^\+/.test(T('ui-sh-compute')), '神识→算力增益已渲染', T('ui-sh-compute'));
    ok(/^\+/.test(T('ui-sh-cultivate')), '神识→修炼增益已渲染', T('ui-sh-cultivate'));

    // 顶栏的两个资源 + 神识
    ok(T('ui-qi').length > 0 && T('ui-qi') !== '0', '顶栏灵气已渲染', T('ui-qi'));
    ok(T('ui-shenshi').length > 0, '顶栏神识已渲染', T('ui-shenshi'));
    ok(/算力 \+/.test(T('ui-shenshi-sub')), '神识副标题给出算力增益', T('ui-shenshi-sub'));

    // 设备页应含「修仙 × 科技」设备
    const devHtml = el2('dev-list') ? el2('dev-list').innerHTML : '';
    ok(devHtml.indexOf('修仙 × 科技') >= 0, '设备页含修仙×科技设备标记');
    ok(devHtml.indexOf('灵石供电机柜') >= 0 && devHtml.indexOf('太虚晶格超算') >= 0,
      '设备页含首尾修仙设备');

    // 境界页的新统计行
    ok(T('ui-stat-shenshi').length > 0, '境界页含神识统计');
    ok(T('ui-stat-qimul').charAt(0) === '×', '境界页含灵气产出倍率', T('ui-stat-qimul'));
    ok(T('ui-stat-tech') === '九章算经·残卷', '境界页含当前功法', T('ui-stat-tech'));
  }

  console.log('\n=== 公司页（已成立 · 运转中）===');
  {
    const Core = global.GameCore;
    const D = global.Decimal;
    const G = global.GAME;

    // 造一份「炼气 + 5 条矿井 + 仓库 Lv.1 + 攒了两周期库存」的存档。
    // 新模型下产线要吃「工业算力」：不给份额就全厂按 0% 运转，一件也产不出来。
    const s = Core.createState();
    s.realm = 1;
    s.money = new D(1e8);
    Core.foundCompany(s);
    for (let i = 0; i < 5; i++) Core.buyLine(s, 'mine');
    // 工业算力来自「设备算力 × 工业产能份额」：没有设备就一件也产不出来。
    // realCompute 是运行期值（tick 里按设备重算），这里手动补上是为了让
    // 下面的 syncCompany 在还没 tick 时也能算出产量。
    s.devices.cluster = 10;                   // 3000 × 10 = 3 万算力
    s.realCompute = new D(3e4);
    s.alloc.industry = 0.5;                   // 一半算力拨给工业产能
    Core.upgradeWarehouse(s);
    Core.setAutoSell(s, false);
    Core.syncCompany(s, G.company.cycleRealSeconds * 2, false);

    const stockWant = Math.floor((Core.companyOutputPerCycle(s)['iron_ore'] || 0) * 2);
    ok(stockWant > 0, '给了工业算力后产线确实出货', String(stockWant));
    ok(Core.stockTotal(s) === stockWant, '种子存档已攒下库存', String(Core.stockTotal(s)));

    const snap = Core.serialize(s);
    installStubs();
    // 预置「有子元素」的列表容器，让生产线 / 市场的动态回填分支真正跑起来
    EL_CACHE['co-line-list'] = mkListMock(
      G.company.lines.map((l) => l.id),
      ['lowned', 'lcap', 'lstats', 'llock', 'lprice', 'lbuy', 'lunits'], 'line');
    EL_CACHE['mk-good-list'] = mkListMock(
      G.company.goods.map((g) => g.id),
      ['gprice', 'gtrend', 'gmeta', 'gpress', 'gpressbar', 'gpresstxt',
       'gstock', 'gvalue', 'gsell', 'gspark'], 'good');
    EL_CACHE['mk-ind-list'] = mkListMock(
      G.company.industries.map((x) => x.id),
      ['icost', 'iprice', 'imargin'], 'industry');
    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/api/me') >= 0) {
        return { ok: true, status: 200, json: async () => ({ ok: true, username: 'tester' }) };
      }
      if (u.indexOf('/api/load') >= 0) {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, isNew: false, state: snap, config: null, offline: null }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    delete require.cache[path.join(ROOT, 'public', 'js', 'app.js')];
    let errCo = null;
    try {
      require(path.join(ROOT, 'public', 'js', 'app.js'));
    } catch (e) {
      errCo = e;
    }
    ok(errCo === null, '带公司存档时 app.js 初始化无异常',
      errCo ? errCo.message + ' @ ' + (errCo.stack || '').split('\n')[1] : '');
    await new Promise((r) => setTimeout(r, 60));

    const elC = (id) => EL_CACHE[id];
    const T = (id) => (elC(id) ? elC(id).textContent : '');

    ok(elC('company-panel').classList.contains('hidden'), '未成立占位已隐藏');
    ok(!elC('company-main').classList.contains('hidden'), '经营主体已显示');
    ok(T('tab-company-badge') === '经营中', '标签徽章显示经营中', T('tab-company-badge'));

    ok(T('ui-co-status') === '运转中', '经营状态显示运转中', T('ui-co-status'));
    ok(String(elC('ui-co-status').className).indexOf('ok') >= 0, '运转中为 ok 样式',
      String(elC('ui-co-status').className));

    ok(T('ui-co-cycle-label').indexOf('下个周期') >= 0, '周期倒计时已渲染',
      T('ui-co-cycle-label'));
    ok(T('ui-co-cycle-count').indexOf('已完成') >= 0, '周期计数已渲染', T('ui-co-cycle-count'));
    ok(/^\d+(\.\d+)?%$/.test(String(elC('ui-co-cycle-bar').style.width)),
      '周期进度条已设置宽度', String(elC('ui-co-cycle-bar').style.width));

    ok(T('ui-co-gross').charAt(0) === '+', '毛产值已渲染', T('ui-co-gross'));
    ok(T('ui-co-upkeep').charAt(0) === '-', '维护费已渲染', T('ui-co-upkeep'));
    ok(T('ui-co-net').charAt(0) === '+', '净收益已渲染', T('ui-co-net'));
    ok(String(elC('ui-co-net').className).indexOf('jade') >= 0, '净收益用「涨」色（jade）',
      String(elC('ui-co-net').className));
    ok(T('ui-co-netps').indexOf('/ 秒') > 0, '每秒净收益已渲染', T('ui-co-netps'));
    ok(T('ui-co-revenue').length > 0, '累计营业额已渲染', T('ui-co-revenue'));
    ok(T('ui-co-upkeep-total').length > 0, '累计维护费已渲染', T('ui-co-upkeep-total'));

    ok(T('ui-co-wh-level') === 'Lv.1', '仓库等级已渲染', T('ui-co-wh-level'));
    ok(/^\d[\d,]* \/ \d[\d,]*$/.test(T('ui-co-wh-val')), '仓库用量已渲染', T('ui-co-wh-val'));
    ok(/^0(\.\d+)?%$|^\d+(\.\d+)?%$/.test(String(elC('ui-co-wh-bar').style.width)),
      '仓库占用条已设置宽度', String(elC('ui-co-wh-bar').style.width));
    ok(T('btn-co-warehouse').indexOf('扩容') === 0, '扩容按钮文案已渲染',
      T('btn-co-warehouse'));
    ok(elC('btn-co-warehouse').disabled === false, '钱够时扩容按钮可用');
    ok(T('ui-co-wh-cost').indexOf('下一级容量') >= 0, '扩容说明已渲染', T('ui-co-wh-cost'));
    ok(elC('chk-co-autosell').checked === false, '自动卖出开关反映存档状态');

    ok(T('ui-co-line-hint').indexOf('共') === 0, '生产线合计已渲染', T('ui-co-line-hint'));
    ok(/^\d[\d,]*$/.test(T('ui-mk-stock-count')), '库存件数已渲染', T('ui-mk-stock-count'));
    ok(Number(T('ui-mk-stock-count').replace(/,/g, '')) > 0, '库存件数与存档一致',
      T('ui-mk-stock-count') + ' vs ' + Core.stockTotal(s));
    ok(T('ui-mk-stock-value').length > 0, '库存估值已渲染', T('ui-mk-stock-value'));
    ok(elC('btn-mk-sell-all').disabled === false, '有库存时清仓按钮可用');

    // ---- 工业算力 ----
    ok(T('ui-co-cp-pool').length > 0 && T('ui-co-cp-pool') !== '0', '算力供给已渲染',
      T('ui-co-cp-pool'));
    ok(T('ui-co-cp-demand').length > 0, '算力需求已渲染', T('ui-co-cp-demand'));
    ok(T('ui-co-cp-share') === '50.0%', '工业产能份额已渲染', T('ui-co-cp-share'));
    ok(/^\d+(\.\d+)?%$/.test(String(elC('ui-co-cp-bar').style.width)),
      '算力供需条已设置宽度', String(elC('ui-co-cp-bar').style.width));
    ok(T('ui-co-cp-scale').length > 0, '算力状态提示已渲染', T('ui-co-cp-scale'));

    // ---- 生产线的动态回填 ----
    const lineOf = (id) => EL_CACHE['co-line-list']._items.find((x) => x.dataset.line === id);
    const L = (id, role) => lineOf(id)._sub[role];

    ok(lineOf('mine') !== undefined && lineOf('cave') !== undefined,
      '生产线子元素齐备（首尾）');
    ok(L('mine', 'lowned').textContent === '×5', '生产线「已拥有」已回填',
      L('mine', 'lowned').textContent);
    ok(L('mine', 'lcap').textContent === '已拥有 5 条', '生产线数量文案已回填',
      L('mine', 'lcap').textContent);
    ok(/产能上限/.test(L('mine', 'lstats').innerHTML) &&
       /算力 \/ 台/.test(L('mine', 'lstats').innerHTML), '生产线算力上限已回填',
      L('mine', 'lstats').innerHTML);
    ok(/可选产物 6 种/.test(L('mine', 'lstats').innerHTML), '生产线标出可选产物数',
      L('mine', 'lstats').innerHTML);

    // 每一台的独立配置行：5 条线就该有 5 行，且带产物下拉与产能拖动条
    const unitsHtml = L('mine', 'lunits').innerHTML;
    ok(unitsHtml.split('data-unit="').length - 1 === 5, '每台产线各有一行配置',
      String(unitsHtml.split('data-unit="').length - 1));
    ok(unitsHtml.indexOf('data-role="uproduct"') >= 0, '每台可选产物');
    ok(unitsHtml.indexOf('data-role="urate"') >= 0, '每台可调产能');
    ok(unitsHtml.indexOf('铁矿石') >= 0, '产物下拉里含本行业产物');
    ok(unitsHtml.indexOf('全部套用') >= 0, '整条线可一键套用');
    ok(L('mine', 'lprice').textContent.length > 0, '生产线价格已回填',
      L('mine', 'lprice').textContent);
    ok(L('mine', 'lbuy').disabled === false, '已解锁且钱够时购入按钮可用');
    ok(L('mine', 'llock').classList.contains('hidden'), '已解锁时锁定说明隐藏');
    ok(!lineOf('mine').classList.contains('locked'), '已解锁生产线不标 locked');

    // 未达境界的生产线：锁定说明可见 + 给出原因 + 按钮禁用
    ok(!L('precision', 'llock').classList.contains('hidden'), '未解锁时锁定说明可见');
    ok(L('precision', 'llock').textContent.indexOf('未解锁') === 0, '未解锁生产线给出原因',
      L('precision', 'llock').textContent);
    ok(L('precision', 'llock').textContent.indexOf('筑基') >= 0, '原因含所需境界',
      L('precision', 'llock').textContent);
    ok(L('precision', 'lbuy').disabled === true, '未解锁时购入按钮禁用');
    ok(lineOf('precision').classList.contains('locked'), '未解锁生产线标 locked');

    // 前置不足的代工厂：5 条作坊后已解锁、可购买、显示 ×0
    ok(L('smelter', 'lbuy').disabled === false, '解锁后购入按钮可用');
    ok(L('smelter', 'lowned').textContent === '×0', '未购买生产线显示 ×0',
      L('smelter', 'lowned').textContent);
    ok(!lineOf('smelter').classList.contains('locked'), '解锁的代工厂不标 locked');

    // ---- 市场的动态回填 ----
    const goodOf = (id) => EL_CACHE['mk-good-list']._items.find((x) => x.dataset.good === id);
    const Gd = (id, role) => goodOf(id)._sub[role];

    ok(goodOf('iron_ore') !== undefined && goodOf('world_tree') !== undefined,
      '市场子元素齐备（首尾）');
    ok(Gd('iron_ore', 'gprice').textContent.length > 0, '商品市价已回填',
      Gd('iron_ore', 'gprice').textContent);
    ok(/^\d[\d,]* 件$/.test(Gd('iron_ore', 'gstock').textContent), '商品库存已回填',
      Gd('iron_ore', 'gstock').textContent);
    ok(Gd('iron_ore', 'gstock').textContent !== '0 件', '有库存的商品件数不为 0',
      Gd('iron_ore', 'gstock').textContent);
    ok(Gd('iron_ore', 'gvalue').textContent.indexOf('市值') === 0, '商品市值已回填',
      Gd('iron_ore', 'gvalue').textContent);
    ok(Gd('iron_ore', 'gsell').disabled === false, '有库存时卖出按钮可用');
    ok(!Gd('iron_ore', 'gstock').classList.contains('zero'), '有库存时不标 zero');
    ok(/距下次变价/.test(Gd('iron_ore', 'gmeta').innerHTML), '商品变价倒计时已回填',
      Gd('iron_ore', 'gmeta').innerHTML);
    ok(/累计卖出/.test(Gd('iron_ore', 'gmeta').innerHTML), '商品累计卖出已回填');
    ok(/基准 /.test(Gd('iron_ore', 'gtrend').textContent), '商品标出基准价',
      Gd('iron_ore', 'gtrend').textContent);

    // 开市（第 0 期）：一律「平」，且按基准价挂牌
    ok(Gd('iron_ore', 'gtrend').className === 'trend flat', '开市时涨跌标记为 flat',
      Gd('iron_ore', 'gtrend').className);
    ok(Gd('iron_ore', 'gtrend').textContent.indexOf('平') > 0, '开市时显示「平」',
      Gd('iron_ore', 'gtrend').textContent);

    // 无库存的商品：卖不出去
    ok(Gd('world_tree', 'gstock').textContent === '0 件', '无库存商品显示 0 件',
      Gd('world_tree', 'gstock').textContent);
    ok(Gd('world_tree', 'gstock').classList.contains('zero'), '无库存商品标 zero');
    ok(Gd('world_tree', 'gsell').disabled === true, '无库存时卖出按钮禁用');
  }

  console.log('\n=== 公司页（已成立 · 资金不足停产）===');
  {
    const Core = global.GameCore;
    const D = global.Decimal;

    const s = Core.createState();
    s.realm = 1;
    s.money = new D(1e8);
    Core.foundCompany(s);
    for (let i = 0; i < 3; i++) Core.buyLine(s, 'mine');
    s.devices.cluster = 10;                   // 够 3 条矿井满负荷
    s.alloc.industry = 0.5;
    s.money = new D(0);                       // 破产

    const snap = Core.serialize(s);
    installStubs();
    EL_CACHE['co-line-list'] = mkListMock(
      global.GAME.company.lines.map((l) => l.id),
      ['lowned', 'lcap', 'lstats', 'llock', 'lprice', 'lbuy'], 'line');
    EL_CACHE['mk-good-list'] = mkListMock(
      global.GAME.company.goods.map((g) => g.id),
      ['gprice', 'gtrend', 'gmeta', 'gpress', 'gpressbar', 'gpresstxt',
       'gstock', 'gvalue', 'gsell'], 'good');
    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/api/me') >= 0) {
        return { ok: true, status: 200, json: async () => ({ ok: true, username: 'tester' }) };
      }
      if (u.indexOf('/api/load') >= 0) {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, isNew: false, state: snap, config: null, offline: null }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    delete require.cache[path.join(ROOT, 'public', 'js', 'app.js')];
    let errPoor = null;
    try {
      require(path.join(ROOT, 'public', 'js', 'app.js'));
    } catch (e) {
      errPoor = e;
    }
    ok(errPoor === null, '破产存档下 app.js 初始化无异常',
      errPoor ? errPoor.message + ' @ ' + (errPoor.stack || '').split('\n')[1] : '');
    await new Promise((r) => setTimeout(r, 60));

    const elP = (id) => EL_CACHE[id];
    const T = (id) => (elP(id) ? elP(id).textContent : '');

    ok(T('ui-co-status') === '资金不足 · 停产', '资金不足时状态显示停产', T('ui-co-status'));
    ok(String(elP('ui-co-status').className).indexOf('err') >= 0, '停产状态为 err 样式',
      String(elP('ui-co-status').className));
    ok(elP('btn-co-warehouse').disabled === true, '没钱时扩容按钮禁用');
    ok(T('ui-co-wh-level') === 'Lv.0', '未升级仓库时等级为 Lv.0', T('ui-co-wh-level'));
    ok(T('ui-co-line-hint').indexOf('共') === 0, '生产线合计已渲染', T('ui-co-line-hint'));

    const lineOf = (id) => EL_CACHE['co-line-list']._items.find((x) => x.dataset.line === id);
    const L = (id, role) => lineOf(id)._sub[role];
    ok(L('mine', 'lcap').textContent === '已拥有 3 条', '生产线数量文案已回填',
      L('mine', 'lcap').textContent);
    ok(L('mine', 'lbuy').disabled === true, '没钱时购入按钮禁用');
    ok(L('mine', 'lprice').classList.contains('no'), '买不起时价格标 no');
    ok(L('smelter', 'lbuy').disabled === true, '买不起时（含已解锁）购入按钮禁用');
    ok(elP('btn-mk-sell-all').disabled === true, '空仓时清仓按钮禁用');
  }

  console.log('\n=== 公司页（市价涨跌 · 涨红跌绿）===');
  {
    const Core = global.GameCore;
    const D = global.Decimal;
    const G = global.GAME;
    // 行情按现实秒走：科技类 60 秒一期，修仙类 600 秒一期。
    // 用 60 秒的整数倍当时间戳，两类商品的期边界都能覆盖到。
    const PER_SEC = 60;

    // 找一个「同一期里既有商品涨、又有商品跌」的期 —— 两个分支才会都走到
    let pick = null;
    for (let p = 1; p <= 300; p++) {
      const t = p * PER_SEC;
      const trs = G.company.goods.map((g) => Core.goodsTrend(g, t));
      if (trs.indexOf('up') >= 0 && trs.indexOf('down') >= 0) { pick = { p, t }; break; }
    }
    ok(pick !== null, '存在涨跌并存的期', pick ? String(pick.p) : '未找到');
    const t0 = pick ? pick.t : PER_SEC;

    const s = Core.createState();
    s.realm = 1;
    s.money = new D(1e8);
    s.playTime = t0;
    Core.foundCompany(s);
    Core.buyLine(s, 'mine');

    // 给第一个商品种一份抛压：验证「抛压条 + 自然价参考线」这条新路径。
    // 顺手把所有商品的期数游标推到当前期 —— 否则 hydrate 之后第一次
    // 市场结算会把「刚种下的抛压」当成积压了上百期而直接衰减掉。
    const pressuredGood = G.company.goods[0].id;
    s.company.pressure[pressuredGood] = 0.5;
    for (const g of G.company.goods) {
      s.company.lastPeriod[g.id] = Core.goodsPeriod(g, s.playTime);
    }

    const snap = Core.serialize(s);
    installStubs();
    EL_CACHE['co-line-list'] = mkListMock(
      G.company.lines.map((l) => l.id),
      ['lowned', 'lcap', 'lstats', 'llock', 'lprice', 'lbuy'], 'line');
    EL_CACHE['mk-good-list'] = mkListMock(
      G.company.goods.map((g) => g.id),
      ['gprice', 'gtrend', 'gmeta', 'gpress', 'gpressbar', 'gpresstxt',
       'gstock', 'gvalue', 'gsell', 'gspark'], 'good');
    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/api/me') >= 0) {
        return { ok: true, status: 200, json: async () => ({ ok: true, username: 'tester' }) };
      }
      if (u.indexOf('/api/load') >= 0) {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, isNew: false, state: snap, config: null, offline: null }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    delete require.cache[path.join(ROOT, 'public', 'js', 'app.js')];
    let errT = null;
    try {
      require(path.join(ROOT, 'public', 'js', 'app.js'));
    } catch (e) {
      errT = e;
    }
    ok(errT === null, '非开市存档下 app.js 初始化无异常',
      errT ? errT.message + ' @ ' + (errT.stack || '').split('\n')[1] : '');
    await new Promise((r) => setTimeout(r, 60));

    const goodOf = (id) => EL_CACHE['mk-good-list']._items.find((x) => x.dataset.good === id);
    const Gd = (id, role) => goodOf(id)._sub[role];

    // 前端显示的涨跌必须与内核推导完全一致（前端不自己算行情）
    let consistent = true;
    const seen = {};
    for (const g of G.company.goods) {
      const tr = Core.goodsTrend(g, s.playTime);
      seen[tr] = (seen[tr] || 0) + 1;
      const cls = String(Gd(g.id, 'gtrend').className);
      if (cls !== 'trend ' + tr) {
        consistent = false;
        console.log('     类名不一致: ' + g.id + ' ' + cls + ' vs trend ' + tr);
      }
      const arrow = tr === 'up' ? '▲ 涨' : (tr === 'down' ? '▼ 跌' : '— 平');
      if (Gd(g.id, 'gtrend').textContent.indexOf(arrow) !== 0) {
        consistent = false;
        console.log('     箭头不一致: ' + g.id + ' ' + Gd(g.id, 'gtrend').textContent);
      }
      if (Gd(g.id, 'gprice').textContent.length === 0) {
        consistent = false;
        console.log('     价格未渲染: ' + g.id);
      }
    }
    ok(consistent, '每个商品的涨跌标记与内核推导一致');
    ok(seen.up > 0, '渲染出「涨」的商品', String(seen.up || 0));
    ok(seen.down > 0, '渲染出「跌」的商品', String(seen.down || 0));

    // 非开市期：市价整体已偏离基准价
    let anyDiff = false;
    for (const g of G.company.goods) {
      const f = Core.goodsPrice(g, s.playTime).div(new D(g.basePrice)).toNumber();
      if (Math.abs(f - 1) > 1e-9) anyDiff = true;
    }
    ok(anyDiff, '非开市期至少有一个商品价格偏离基准价');

    // ---------- 价格走势图 ----------
    const h0 = read('public/index.html');
    const css0 = read('public/css/style.css');
    ok(h0.indexOf('id="mk-chart-body"') > 0, 'HTML 含走势图容器');
    ok(h0.indexOf('id="ui-mk-chart-name"') > 0, 'HTML 含走势图标题位');
    // 图例现在在「市场」与「股市」两张图上各有一份，所以只数市场那张图前的那一段
    const coChartHtml = h0.slice(0, h0.indexOf('id="mk-chart-body"'));
    const coLegend = coChartHtml.slice(coChartHtml.lastIndexOf('co-chart-legend'));
    ok((coLegend.match(/class="lg /g) || []).length === 3,
      '市场走势图图例含三种线型（已发生 / 推演 / 基准价）');
    ok(/\.co-chart-body\s*\{[^}]*height/.test(css0), '走势图有固定高度');
    ok(/\.co-chart-body svg\s*\{[^}]*width:\s*100%/.test(css0), '走势图宽度自适应');
    ok(/\.co-good\.selected/.test(css0), '选中行有高亮样式');

    const svg = String(EL_CACHE['mk-chart-body'].innerHTML);
    ok(svg.indexOf('<svg') === 0, '走势图已渲染为 SVG', svg.slice(0, 40));
    ok(/viewBox="0 0 320 118"/.test(svg), '走势图用固定 viewBox + 自适应宽度');
    ok(/preserveAspectRatio="none"/.test(svg), '走势图按容器宽度拉伸');
    ok(/vector-effect="non-scaling-stroke"/.test(svg), '描边不随缩放变粗');
    ok((svg.match(/<polyline/g) || []).length >= 2, '同时画出「已发生」与「推演」两条折线');
    ok(svg.indexOf('stroke-dasharray="4 3"') > 0, '推演段用虚线');
    ok(svg.indexOf('stroke="var(--border)"') > 0, '画出基准价参考线');
    // 非等比缩放下圆会变成椭圆，所以当前期只能用竖线标记
    ok(svg.indexOf('<circle') < 0, '不使用圆点（会被拉成椭圆）');
    ok(/<line [^>]*stroke-width="2"/.test(svg), '用竖线标出当前期');

    // ---------- 市场抛压（卖出影响下一期） ----------
    const T2 = (id) => (EL_CACHE[id] ? EL_CACHE[id].textContent : '');
    const drop = Core.marketDropRatio(s, G.company.goods[0]);
    ok(drop > 0, '内核确认该商品被抛压压价', drop.toFixed(4));

    ok(!Gd(pressuredGood, 'gpress').classList.contains('hidden'),
      '有抛压时显示抛压条');
    ok(String(Gd(pressuredGood, 'gpressbar').style.width) ===
       Math.round(0.5 * 100) + '%',
      '抛压条宽度 = 抛压比例 × 100%',
      String(Gd(pressuredGood, 'gpressbar').style.width));
    ok(/已被压/.test(Gd(pressuredGood, 'gpresstxt').innerHTML), '抛压文案已渲染',
      Gd(pressuredGood, 'gpresstxt').innerHTML);
    ok(/本应/.test(Gd(pressuredGood, 'gpresstxt').innerHTML),
      '抛压文案给出「本应值多少」的自然价对照');

    const m = /([\d.]+)%/.exec(Gd(pressuredGood, 'gpresstxt').innerHTML);
    ok(m !== null && Math.abs(parseFloat(m[1]) - drop * 100) < 0.05,
      '折价百分比与内核计算一致',
      (m ? m[1] + '% vs ' + (drop * 100).toFixed(2) + '%' : 'no match'));

    const cleanGood = G.company.goods[1].id;
    ok(Core.pressureOf(s, cleanGood) === 0, '第二个商品确实没有抛压');
    ok(Gd(cleanGood, 'gpress').classList.contains('hidden'),
      '无抛压时不显示抛压条');

    // 面板头部概览：peak = 0.5 ≥ warnAt(0.45) → 用警示色
    ok(T2('ui-mk-market-hint').indexOf('抛压最高 50%') >= 0,
      '市场面板头部给出最高抛压', T2('ui-mk-market-hint'));
    ok(String(EL_CACHE['ui-mk-market-hint'].className).indexOf('err') >= 0,
      '抛压越过警示线时用警示色',
      String(EL_CACHE['ui-mk-market-hint'].className));
    ok(T2('ui-mk-market-hint').indexOf('正常清仓不压价') > 0,
      '提示文案说明了机制（正常清仓不压价）');

    // 走势图：抛压生效时多画一条自然价参考线
    ok((svg.match(/<polyline/g) || []).length === 3,
      '抛压生效时多画一条「自然价」参考线（共 3 条折线）',
      String((svg.match(/<polyline/g) || []).length));
    ok(svg.indexOf('stroke-dasharray="2 3"') > 0, '自然价参考线用细虚线区分');
    ok(T2('ui-mk-chart-foot').indexOf('自然价') > 0,
      '走势图脚注标出自然价与被压幅度', T2('ui-mk-chart-foot'));
    ok(T2('ui-mk-chart-foot').indexOf('压低') > 0, '脚注说明被压低了多少');
    ok(css0.indexOf('.co-press') > 0, 'CSS 含抛压条样式');
    ok(/\.co-press\.hidden/.test(css0), 'CSS 定义了抛压条的隐藏态');

    const g0 = G.company.goods[0];
    const tr0 = Core.goodsTrend(g0, s.playTime);
    const want = tr0 === 'up' ? 'var(--red)'
      : (tr0 === 'down' ? 'var(--jade)' : 'var(--text-faint)');
    ok(svg.indexOf('stroke="' + want + '"') > 0, '折线颜色随涨跌（涨红跌绿）',
      want + ' / trend=' + tr0);

    ok(EL_CACHE['ui-mk-chart-name'].textContent === g0.name,
      '默认选中第一个商品', EL_CACHE['ui-mk-chart-name'].textContent);
    ok(/变价$/.test(EL_CACHE['ui-mk-chart-tag'].textContent), '走势图标出变价周期',
      EL_CACHE['ui-mk-chart-tag'].textContent);
    ok(EL_CACHE['ui-mk-chart-foot'].textContent.indexOf('第 ') === 0,
      '走势图给出期数范围', EL_CACHE['ui-mk-chart-foot'].textContent);
    ok(EL_CACHE['ui-mk-chart-foot'].textContent.indexOf('基准') > 0, '走势图给出基准价');

    // 每个商品行内的迷你走势图
    let sparkN = 0;
    for (const g of G.company.goods) {
      const el = goodOf(g.id)._sub.gspark;
      if (el && String(el.innerHTML).indexOf('<svg') === 0) sparkN++;
      else console.log('     缺迷你走势图: ' + g.id);
    }
    ok(sparkN === G.company.goods.length, '每个商品行都有迷你走势图',
      sparkN + '/' + G.company.goods.length);
    ok(/viewBox="0 0 320 34"/.test(String(goodOf(g0.id)._sub.gspark.innerHTML)),
      '迷你走势图用矮 viewBox');
    ok(String(goodOf(g0.id)._sub.gspark.innerHTML).indexOf('stroke-dasharray="4 3"') < 0,
      '迷你走势图不画推演段（只看已发生）');

    const selN = EL_CACHE['mk-good-list']._items
      .filter((x) => x.classList.contains('selected')).length;
    ok(selN === 1, '同一时刻只有一行处于选中态', String(selN));
    ok(goodOf(g0.id).classList.contains('selected'), '选中的正是走势图对应那一行');

    // 折线图最隐蔽的失效方式是坐标算成 NaN —— 画面上一片空白，控制台却不报错
    ok(svg.indexOf('NaN') < 0, '走势图坐标无 NaN');
    ok(svg.indexOf('undefined') < 0, '走势图无 undefined 属性');
    let anyNaN = false;
    for (const g of G.company.goods) {
      const h = String(goodOf(g.id)._sub.gspark.innerHTML);
      if (h.indexOf('NaN') >= 0 || h.indexOf('undefined') >= 0) {
        anyNaN = true;
        console.log('     迷你走势图坐标异常: ' + g.id);
      }
    }
    ok(!anyNaN, '所有迷你走势图坐标正常');
  }

  console.log('\n=== 股市页（已开户 · 有持仓与冲击）===');
  {
    const Core = global.GameCore;
    const D = global.Decimal;
    const G = global.GAME;

    const s = Core.createState();
    s.realm = 1;
    s.money = new D(1e12);
    s.playTime = 50 * 60;                  // 第 50 期（科技类 60 秒一期），确保选中行的期数不是 0

    // 池子 50 家、界面只列市值前 10 —— 所以测试要挑**榜内**的股票，
    // 榜外行默认不渲染，拿它断言等于什么都没测到。
    const board0 = Core.stockSummary(s).board[0];
    const heldId = board0.id;
    // 冲击要看得见：买流通盘的 5%（买 1000 股只有 4.5e-7，进度条会被舍入成 0%）
    const buyQty = Math.floor(board0.depth * 0.05);
    const buy = Core.buyStock(s, heldId, buyQty);
    ok(buy.ok, '内核买入成功（前置条件）', buy.ok ? '' : buy.msg);

    const snap = Core.serialize(s);
    const s2 = Core.hydrate(snap);
    const sum = Core.stockSummary(s2);

    installStubs();
    EL_CACHE['st-list'] = mkListMock(
      G.stock.stocks.map((x) => x.id),
      ['stmeta', 'stimp', 'stimpbar', 'stimptxt', 'stspark', 'stprice', 'sttrend',
       'stshares', 'stvalue', 'stpnl', 'stqty', 'stmax', 'stcost', 'stnet',
       'stbuy', 'stsell', 'stclose'], 'stock');
    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/api/me') >= 0) {
        return { ok: true, status: 200, json: async () => ({ ok: true, username: 'tester' }) };
      }
      if (u.indexOf('/api/load') >= 0) {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, isNew: false, state: snap, config: null, offline: null }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    delete require.cache[path.join(ROOT, 'public', 'js', 'app.js')];
    let errSt = null;
    try {
      require(path.join(ROOT, 'public', 'js', 'app.js'));
    } catch (e) {
      errSt = e;
    }
    ok(errSt === null, '持股存档下 app.js 初始化无异常',
      errSt ? errSt.message + ' @ ' + (errSt.stack || '').split('\n')[1] : '');
    await new Promise((r) => setTimeout(r, 60));

    const elS = (id) => EL_CACHE[id];
    const T = (id) => (elS(id) ? elS(id).textContent : '');
    const rowOf = (id) => EL_CACHE['st-list']._items.find((x) => x.dataset.stock === id);
    const S = (id, role) => rowOf(id)._sub[role];

    // ---------- 开户状态 ----------
    ok(elS('stock-panel').classList.contains('hidden'), '开户后锁定占位已隐藏');
    ok(!elS('stock-main').classList.contains('hidden'), '开户后账户主体已显示');
    ok(!elS('tab-stock').classList.contains('locked'), '股市标签不再是锁定态');
    ok(T('tab-stock-badge') === '持 1 只', '徽章显示持仓只数', T('tab-stock-badge'));

    // ---------- 账户概览（必须与内核口径一致）----------
    ok(sum.totalFee.gt(0), '前置：买入确实产生了手续费');
    ok(T('ui-st-trades') === '1 笔', '成交笔数已渲染', T('ui-st-trades'));
    ok(T('ui-st-fee').indexOf('-') === 0, '累计手续费以支出形式展示', T('ui-st-fee'));
    ok(T('ui-st-pnlratio') === '暂无可变现收益率' || /收益率|持仓/.test(T('ui-st-pnlratio')),
      '账户头部给出可变现收益率或暂无持仓', T('ui-st-pnlratio'));

    for (const id of ['ui-st-value', 'ui-st-cost', 'ui-st-pnl', 'ui-st-liq',
      'ui-st-liqpnl', 'ui-st-cash', 'ui-st-realized']) {
      ok(T(id).length > 0, '账户概览「' + id + '」已渲染', T(id));
      ok(T(id).indexOf('NaN') < 0 && T(id).indexOf('undefined') < 0,
        '账户概览「' + id + '」无异常值', T(id));
    }

    // 盈亏着色：红涨绿跌（赚了红、亏了绿）
    for (const id of ['ui-st-pnl', 'ui-st-liqpnl', 'ui-st-realized']) {
      const cls = String(elS(id).className);
      ok(/red|jade/.test(cls), '「' + id + '」按盈亏着色', cls);
    }
    ok(read('public/index.html').indexOf('class="v red" id="ui-st-fee"') > 0,
      '手续费固定用红色（静态着色）');

    // ---------- 行情时钟 ----------
    ok(T('ui-st-period').indexOf('第 50 期') === 0, '行情时钟给出当期期数', T('ui-st-period'));
    ok(/^\d+(\.\d+)?%$/.test(String(elS('ui-st-periodbar').style.width)),
      '行情时钟进度条宽度合法', String(elS('ui-st-periodbar').style.width));
    ok(T('ui-st-period-label').indexOf('距离下次变价') === 0,
      '行情时钟给出距下次变价的时间', T('ui-st-period-label'));

    // ---------- 规则说明 ----------
    const rules = String(elS('ui-st-rules').innerHTML);
    ok(rules.indexOf('自然价') > 0, '规则说明给出价格构成');
    ok(rules.indexOf('手续费') > 0, '规则说明给出手续费');
    ok(rules.indexOf('衰减') > 0, '规则说明讲清冲击衰减');
    ok(/成交额 ≥ [\d,万亿]+/.test(rules), '规则说明给出最小成交额', rules.slice(0, 200));

    // ---------- 概览提示与冲击峰值 ----------
    ok(T('ui-st-market-hint').indexOf('冲击峰值') >= 0,
      '行情头部给出冲击峰值', T('ui-st-market-hint'));
    ok(/warn|err/.test(String(elS('ui-st-market-hint').className)),
      '有冲击时头部提示用警示色', String(elS('ui-st-market-hint').className));
    ok(T('ui-st-peak').indexOf('冲击峰值') >= 0, '时钟头部给出冲击峰值', T('ui-st-peak'));

    // ---------- 行情列表：持仓行 ----------
    const heldRow = sum.stocks.find((x) => x.id === heldId);
    ok(heldRow.shares === buyQty, '内核确认持仓 ' + buyQty + ' 股', String(heldRow.shares));
    ok(Math.abs(heldRow.impactPct) > 1e-6, '内核确认该股票存在冲击',
      String(heldRow.impactPct));

    ok(S(heldId, 'stshares').textContent === buyQty.toLocaleString('en-US') + ' 股',
      '持仓股数已渲染', S(heldId, 'stshares').textContent);
    ok(!S(heldId, 'stshares').classList.contains('zero'), '有持仓时不标 zero');
    ok(S(heldId, 'stvalue').textContent.indexOf('市值') === 0, '持仓市值已渲染',
      S(heldId, 'stvalue').textContent);
    ok(/pnl (up|down)/.test(String(S(heldId, 'stpnl').className)),
      '持仓盈亏按涨红跌绿着色', String(S(heldId, 'stpnl').className));
    ok(S(heldId, 'stpnl').textContent.indexOf('可变现') === 0,
      '持仓盈亏用可变现口径', S(heldId, 'stpnl').textContent);

    ok(S(heldId, 'stprice').textContent.length > 0, '成交价已渲染');
    ok(S(heldId, 'stprice').textContent.indexOf('NaN') < 0, '成交价无 NaN');
    ok(/^trend (up|down|flat)$/.test(String(S(heldId, 'sttrend').className)),
      '涨跌标记类名合法', String(S(heldId, 'sttrend').className));
    ok(S(heldId, 'stmeta').innerHTML.indexOf('流通盘') > 0, '行情元信息给出流通盘');
    ok(S(heldId, 'stmeta').innerHTML.indexOf('净买入流') > 0,
      '行情元信息给出净买入流');

    // ---------- 冲击条 ----------
    ok(!S(heldId, 'stimp').classList.contains('hidden'), '有冲击时显示冲击条');
    ok(Number(String(S(heldId, 'stimpbar').style.width).replace('%', '')) > 0,
      '冲击条宽度非零', String(S(heldId, 'stimpbar').style.width));
    ok(/买盘推高/.test(S(heldId, 'stimptxt').innerHTML), '买入后冲击文案为「买盘推高」',
      S(heldId, 'stimptxt').innerHTML);
    ok(/自然价/.test(S(heldId, 'stimptxt').innerHTML), '冲击文案给出自然价对照');
    ok(!S(heldId, 'stimp').classList.contains('down'),
      '买入溢价时冲击条不是「折价」态');

    // ---------- 交易控件 ----------
    ok(S(heldId, 'stqty').disabled === false, '数量输入框可用');
    ok(Number(S(heldId, 'stqty').value) > 0, '首次渲染给出默认手数',
      String(S(heldId, 'stqty').value));
    ok(S(heldId, 'stcost').textContent.indexOf('买需') === 0,
      '买入预览给出所需金钱', S(heldId, 'stcost').textContent);
    ok(S(heldId, 'stbuy').disabled === false, '买得起时买入按钮可用');
    ok(S(heldId, 'stmax').disabled === false, '有购买力时「最大」按钮可用');
    ok(S(heldId, 'stsell').disabled === false, '有持仓且数量合法时卖出按钮可用');
    ok(S(heldId, 'stclose').disabled === false, '有持仓时清仓按钮可用');
    ok(S(heldId, 'stnet').textContent.indexOf('卖得') === 0,
      '卖出预览给出可得金额', S(heldId, 'stnet').textContent);

    // ---------- 行情列表：无持仓行（同样取榜内，否则整行不渲染）----------
    const emptyId = sum.board[1].id;
    ok(emptyId !== heldId, '前置：两只参照股票不同');
    ok(S(emptyId, 'stshares').textContent === '0 股', '未持仓显示 0 股',
      S(emptyId, 'stshares').textContent);
    ok(S(emptyId, 'stshares').classList.contains('zero'), '未持仓标 zero');
    ok(S(emptyId, 'stvalue').textContent === '未持仓', '未持仓时市值位显示未持仓',
      S(emptyId, 'stvalue').textContent);
    ok(S(emptyId, 'stpnl').textContent === '', '未持仓不显示盈亏');
    ok(S(emptyId, 'stimp').classList.contains('hidden'), '未持仓且无冲击则隐藏冲击条');
    ok(S(emptyId, 'stsell').disabled === true, '未持仓时卖出按钮禁用');
    ok(S(emptyId, 'stclose').disabled === true, '未持仓时清仓按钮禁用');
    ok(S(emptyId, 'stnet').textContent === '未持仓', '未持仓时卖出预览提示未持仓',
      S(emptyId, 'stnet').textContent);

    // ---------- 走势图 ----------
    const svg = String(elS('st-chart-body').innerHTML);
    ok(svg.indexOf('<svg') === 0, '股市走势图已渲染为 SVG', svg.slice(0, 40));
    ok(/viewBox="0 0 320 118"/.test(svg), '股市走势图用固定 viewBox');
    ok(/preserveAspectRatio="none"/.test(svg), '股市走势图按容器宽度拉伸');
    ok(/vector-effect="non-scaling-stroke"/.test(svg), '股市走势图描边不随缩放变粗');
    ok((svg.match(/<polyline/g) || []).length === 3,
      '有冲击时多画一条「自然价」参考线（共 3 条折线）',
      String((svg.match(/<polyline/g) || []).length));
    ok(svg.indexOf('stroke-dasharray="2 3"') > 0, '自然价参考线用细虚线区分');
    ok(svg.indexOf('stroke-dasharray="4 3"') > 0, '推演段用虚线');
    ok(svg.indexOf('stroke="var(--border)"') > 0, '画出基准价参考线');
    ok(svg.indexOf('<circle') < 0, '不使用圆点（会被拉成椭圆）');
    ok(svg.indexOf('NaN') < 0, '股市走势图坐标无 NaN');
    ok(svg.indexOf('undefined') < 0, '股市走势图无 undefined 属性');

    const trend0 = Core.stockTrend(s2, Core.stockById(heldId));
    const wantStroke = trend0 === 'up' ? 'var(--red)'
      : (trend0 === 'down' ? 'var(--jade)' : 'var(--text-faint)');
    ok(svg.indexOf('stroke="' + wantStroke + '"') > 0, '折线颜色随涨跌（涨红跌绿）',
      wantStroke + ' / trend=' + trend0);

    ok(T('ui-st-chart-name').indexOf(heldRow.name) === 0, '默认选中持仓股票',
      T('ui-st-chart-name'));
    ok(/变价$/.test(T('ui-st-chart-tag')), '走势图标出变价周期', T('ui-st-chart-tag'));
    ok(T('ui-st-chart-foot').indexOf('成交价') > 0, '走势图脚注给出成交价');
    ok(T('ui-st-chart-foot').indexOf('自然价') > 0, '走势图脚注给出自然价');
    ok(T('ui-st-chart-foot').indexOf('推高') > 0,
      '走势图脚注说明成交价被自己推高', T('ui-st-chart-foot'));

    // ---------- 行内迷你走势图：只画榜内那 10 只 ----------
    let sparkN = 0;
    let sparkNaN = false;
    for (const x of sum.board) {
      const h = String(S(x.id, 'stspark').innerHTML);
      if (h.indexOf('<svg') === 0) sparkN++;
      else console.log('     缺迷你走势图: ' + x.id);
      if (h.indexOf('NaN') >= 0 || h.indexOf('undefined') >= 0) sparkNaN = true;
    }
    ok(sparkN === sum.board.length, '市值榜内每只股票都有迷你走势图',
      sparkN + '/' + sum.board.length);
    ok(sum.board.length === (G.stock.boardSize || 10), '榜单长度取自配置的 boardSize',
      String(sum.board.length));

    // 榜外公司默认不渲染（点「显示全部」才铺开）
    const offId = sum.stocks.map((x) => x.id)
      .find((id) => !sum.board.some((b) => b.id === id));
    ok(offId !== undefined, '前置：50 家池子里确实有榜外公司');
    ok(String(S(offId, 'stspark').innerHTML).indexOf('<svg') !== 0,
      '榜外公司默认不渲染迷你走势图');
    ok(rowOf(offId).classList.contains('hidden'), '榜外公司整行隐藏',
      String(rowOf(offId).classList.contains('hidden')));
    ok(/viewBox="0 0 320 34"/.test(String(S(heldId, 'stspark').innerHTML)),
      '迷你走势图用矮 viewBox');
    ok(String(S(heldId, 'stspark').innerHTML).indexOf('stroke-dasharray="4 3"') < 0,
      '迷你走势图不画推演段（只看已发生）');
    ok(!sparkNaN, '所有迷你走势图坐标正常');

    // ---------- 同一时刻只有一行选中 ----------
    const selN = EL_CACHE['st-list']._items
      .filter((x) => x.classList.contains('selected')).length;
    ok(selN === 1, '同一时刻只有一行处于选中态', String(selN));
    ok(rowOf(heldId).classList.contains('selected'), '选中的正是走势图对应那一行');
  }

  console.log('\n=== 已移除 API 不应残留引用 ===');
  {
    const appSrc = read('public/js/app.js');
    const serverSrc = read('server/index.js');
    for (const bad of ['clickIncome', 'doWork', 'clickCount', 'baseClickIncome']) {
      ok(appSrc.indexOf(bad) < 0, 'app.js 不再引用 ' + bad);
      ok(serverSrc.indexOf(bad) < 0, 'server/index.js 不再引用 ' + bad);
    }
  }

  console.log('\n=== 前后端共用模块一致性 ===');
  {
    // 关键契约：同一份文件既能在 Node（require）下工作，也能在浏览器（全局变量）下工作。
    // 用「实际加载行为」验证，而不是字符串匹配 —— 因为实现里可能写
    // root.GameCore = API 而非字面上的 window.GameCore。
    for (const name of ['decimal.js', 'game-core.js', 'game-config.js']) {
      const src = read(path.join('shared', name));
      ok(/module\.exports/.test(src), name + ' 声明了 CommonJS 导出（后端）');
      ok(/root\.|window\./.test(src), name + ' 声明了浏览器全局挂载（前端）');
    }

    ok(typeof global.Decimal === 'function', '全局 Decimal 是构造函数');
    ok(typeof global.GameCore.tick === 'function', '全局 GameCore.tick 可用');
    ok(typeof global.GameCore.createState === 'function', '全局 GameCore.createState 可用');
    ok(typeof global.GameCore.rushJob === 'function', '全局 GameCore.rushJob 可用');
    ok(typeof global.GameCore.setTimeTier === 'function', '全局 GameCore.setTimeTier 可用');
    ok(Array.isArray(global.GAME.devices) && global.GAME.devices.length > 0, '全局 GAME.devices 可用');
    ok(Array.isArray(global.GAME.jobs) && global.GAME.jobs.length > 0, '全局 GAME.jobs 可用');
    ok(Array.isArray(global.GAME.time.tiers) && global.GAME.time.tiers.length === 5,
      '全局 GAME.time.tiers 有 5 档（含化神解锁的 1 秒 = 1 游戏年）');
    ok(global.GAME.time.tiers[global.GAME.time.tiers.length - 1].unlockRealm === 5,
      '最高档在化神解锁（超出元婴之后）');
    ok(Array.isArray(global.GAME.realms) && global.GAME.realms.length > 0, '全局 GAME.realms 可用');

    const NodeCore = require(path.join(ROOT, 'shared', 'game-core.js'));
    const NodeDec = require(path.join(ROOT, 'shared', 'decimal.js'));
    ok(typeof NodeCore.tick === 'function', 'Node require game-core 可用');
    ok(typeof NodeDec === 'function', 'Node require decimal 可用');
    ok(NodeCore.tick === global.GameCore.tick, '前后端拿到的是同一份实现（非副本）');
  }

  console.log('\n=== 兵解 · 转生（界面）===');
  {
    const Core = global.GameCore;
    const D = global.Decimal;
    const G = global.GAME;

    const bootWith = async (snap) => {
      installStubs();
      global.fetch = async (url) => {
        const u = String(url);
        if (u.indexOf('/api/me') >= 0) {
          return { ok: true, status: 200, json: async () => ({ ok: true, username: 'tester' }) };
        }
        if (u.indexOf('/api/load') >= 0) {
          return { ok: true, status: 200, json: async () => ({ ok: true, isNew: false, state: snap, config: null, offline: null }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };
      delete require.cache[path.join(ROOT, 'public', 'js', 'app.js')];
      let err = null;
      try {
        require(path.join(ROOT, 'public', 'js', 'app.js'));
      } catch (e) {
        err = e;
      }
      await new Promise((r) => setTimeout(r, 60));
      return err;
    };

    // ---------- 场景 A：元婴 + 已兵解一次 + 买过 1 级加成 ----------
    const s = Core.createState();
    s.realm = 4;
    s.money = new D(1e12);
    for (const d of G.devices) s.devices[d.id] = 1;
    s.learned['jiuzhang'] = { mastery: 0, tier: 2, passive: false };
    s.technique = 'jiuzhang';
    s.playTime = 5000;
    s.rebirth = {
      count: 1, dao: 150, daoTotal: 250,
      perks: { shenshi: 1 },
      history: [{ n: 1, realm: 4, realmName: '元婴', dao: 100, money: { m: 1, e: 6 }, gameSeconds: 0, mode: 'active' }],
    };
    const errA = await bootWith(Core.serialize(s));
    ok(errA === null, '带转生存档时 app.js 初始化无异常',
      errA ? errA.message + ' @ ' + String(errA.stack || '').split('\n')[1] : '');

    const el = (id) => EL_CACHE[id];
    ok(el('rb-lock').classList.contains('hidden'), '已解锁时不显示门槛说明');
    ok(!el('rb-main').classList.contains('hidden'), '已解锁时显示转生面板');
    ok(el('ui-rb-count').textContent === '1', '已兵解次数已渲染', el('ui-rb-count').textContent);
    ok(el('ui-rb-dao').textContent === '150', '可用道行已渲染', el('ui-rb-dao').textContent);
    ok(el('ui-rb-daototal').textContent === '250', '累计道行已渲染', el('ui-rb-daototal').textContent);
    // 1 次兵解 → 衰减指数 0.50（界面显示 ^0.50，与 Core 同一口径）
    ok(el('ui-rb-disc').textContent === '^' + Core.rebirthDiscount(s).toFixed(2),
      '转生衰减指数已渲染', el('ui-rb-disc').textContent);
    ok(el('ui-rb-gain').textContent === '160', '本次道行收益已渲染（100 → 160）',
      el('ui-rb-gain').textContent);
    ok(el('ui-rb-gain-passive').textContent === '48', '被动兵解三折已渲染（160 × 0.3）',
      el('ui-rb-gain-passive').textContent);
    ok(String(el('ui-rb-nextline').textContent).indexOf('^0.53') > 0,
      '下一次的衰减指数在文案里可见', el('ui-rb-nextline').textContent);

    const perkHtml = String(el('rb-perk-list').innerHTML);
    ok(perkHtml.split('class="rb-perk-lv"').length - 1 === 6, '道行加成渲染 6 项',
      String(perkHtml.split('class="rb-perk-lv"').length - 1));
    ok(perkHtml.indexOf('神识根基') >= 0 && perkHtml.indexOf('市场人脉') >= 0, '加成名取自配置');
    ok(perkHtml.indexOf('Lv 1 / 8') >= 0, '已买等级已渲染');
    ok(perkHtml.indexOf('已满级') < 0, '未满级时不出现「已满级」');
    ok(perkHtml.split('data-perk="').length - 1 === 6, '每项加成都有升级按钮');

    const histHtml = String(el('rb-history').innerHTML);
    ok(histHtml.indexOf('#1') >= 0, '兵解记录已渲染');
    ok(histHtml.indexOf('元婴') >= 0, '记录里带上一世境界');
    ok(histHtml.indexOf('+100') >= 0, '记录里带道行收益');

    // ---------- 场景 B：未达元婴门槛 ----------
    const s2 = Core.createState();
    s2.realm = 2;
    const errB = await bootWith(Core.serialize(s2));
    ok(errB === null, '未达门槛时 app.js 初始化无异常',
      errB ? errB.message : '');
    ok(!EL_CACHE['rb-lock'].classList.contains('hidden'), '未达门槛时显示门槛说明');
    ok(EL_CACHE['rb-main'].classList.contains('hidden'), '未达门槛时隐藏转生面板');
    ok(String(EL_CACHE['ui-rb-lock'].textContent).indexOf('元婴') >= 0, '门槛文案提到元婴',
      EL_CACHE['ui-rb-lock'].textContent);

    // ---------- HTML 骨架：id 必须齐全（否则 renderRebirthPage 会写空）----------
    const html = read('public/index.html');
    const needIds = [
      'rebirth-panel', 'rb-lock', 'rb-main', 'ui-rb-count', 'ui-rb-dao', 'ui-rb-daototal',
      'ui-rb-disc', 'ui-rb-gain', 'ui-rb-gain-passive', 'ui-rb-nextline', 'btn-rebirth',
      'rb-perk-list', 'rb-history', 'rebirth-modal', 'rb-lost-list', 'rb-keep-list',
      'rb-gain-list', 'btn-rebirth-cancel', 'btn-rebirth-confirm',
    ];
    const missing = needIds.filter((id) => html.indexOf('id="' + id + '"') < 0);
    ok(missing.length === 0, 'index.html 里兵解相关 id 全部存在',
      missing.join(', '));

    // 确认弹窗三栏的标题必须在（这是「不可撤销操作」的硬要求）
    ok(html.indexOf('rb-col lost') > 0 && html.indexOf('rb-col keep') > 0
      && html.indexOf('rb-col gain') > 0, '确认弹窗含「失去 / 保留 / 获得」三栏');

    // app.js 引用同一套 id，且不再引用被删掉的神识旧字段
    const appJs = read('public/js/app.js');
    ok(appJs.indexOf('renderRebirthPage') > 0, 'app.js 已接入 renderRebirthPage');
    ok(appJs.indexOf('computeBonusPerPoint') < 0, 'app.js 不再引用被移除的神识旧系数');
    ok(appJs.indexOf('shenshiComputeMultiplier') > 0, 'app.js 用分层后的实际乘区显示加成');
  }

  console.log('\n' + '='.repeat(46));
  console.log('  通过  ' + pass + '   失败  ' + fail);
  console.log('='.repeat(46) + '\n');
  process.exit(fail > 0 ? 1 : 0);

})().catch((e) => {
  console.error('\n测试异常:', e);
  process.exit(1);
});
