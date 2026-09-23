/**
 * 公司价格走势图 · 静态预览
 *
 * 用最小 DOM 桩在 Node 里真跑一遍 public/js/app.js，把渲染出来的 SVG 导出成
 * 一个独立 HTML 文件。用途：不用起浏览器、不用登录，就能肉眼核对折线图画得
 * 对不对 —— 坐标是否合理、涨红跌绿、实线/虚线分段、迷你走势是否都在。
 *
 * 注意它是「真实渲染」而不是重新画一遍：走的是 app.js 里那条一模一样的
 * 代码路径，所以图上不对，就说明页面里也不对。
 *
 * 用法: node tools/chart-preview.js [输出路径]
 *      默认输出 preview/company-chart.html
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'preview', 'company-chart.html');

// ============================================================
// DOM 桩（与 tests/frontend.test.js 同源，这里只保留预览需要的部分）
// ============================================================

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
 * 能查到自己子元素的列表容器桩 —— app.js 先铺 innerHTML 骨架，再用
 * querySelectorAll('.co-good') 逐个回填动态值。桩里 innerHTML 只是字符串，
 * 必须按 dataset 造出子元素，回填分支才会真的执行。
 */
function mkListMock(ids, roles, attr) {
  const items = ids.map((id) => {
    const sub = {};
    for (const r of roles) sub[r] = mkEl(id + '.' + r);
    return {
      dataset: { [attr]: id },
      classList: mkEl('c').classList,
      innerHTML: '', style: {}, disabled: false,
      querySelector(sel) {
        const m = /\[data-role="([^"]+)"\]/.exec(String(sel));
        return (m && sub[m[1]]) ? sub[m[1]] : mkEl('missing');
      },
      querySelectorAll() { return []; },
      _sub: sub,
    };
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
  // 有 token 才会跳过登录页，直接进入游戏内渲染
  global.localStorage = {
    getItem: (k) => (k === 'suansuan-xiuxian-token'
      ? JSON.stringify({ token: 'preview-token', username: 'preview' })
      : null),
    setItem() {}, removeItem() {},
  };
  global.setInterval = () => 0;
  global.clearInterval = () => {};
  global.XMLHttpRequest = function () {
    this.open = () => {}; this.setRequestHeader = () => {}; this.send = () => {};
  };
}

// ============================================================
// 主流程
// ============================================================

(async function main() {

  // 先让 window 存在，shared 模块才会把 Decimal / GAME / GameCore 挂到全局
  global.window = global;
  const Decimal = require(path.join(ROOT, 'shared', 'decimal.js'));
  require(path.join(ROOT, 'shared', 'game-config.js'));
  const Core = require(path.join(ROOT, 'shared', 'game-core.js'));
  const GAME = global.GAME;

  /** 变价周期（现实秒）→ 文案 */
  const fmtPer = (g) => (g.periodSeconds >= 60 ? (g.periodSeconds / 60) + ' 分钟' : g.periodSeconds + ' 秒');

  // ---------- 造一个「多条产线 + 有库存」的存档 ----------
  const s = Core.createState();
  s.realm = 4;
  s.money = new Decimal(1e15);
  s.working = false;
  s.playTime = 60 * 40;               // 停在第 40 期（科技类 60 秒一期），避开开市期
  Core.foundCompany(s);
  // 沿解锁链铺开：每条线尽量多买，买不动（前置数量/境界不够）就停在那一档
  for (const l of GAME.company.lines) {
    for (let i = 0; i < 6; i++) {
      const r = Core.buyLine(s, l.id);
      if (!r || r.ok === false) break;
    }
  }
  s.company.autoSell = false;                                   // 留一仓库存
  Core.syncCompany(s, GAME.company.cycleRealSeconds * 4, false); // 跑 4 个周期攒货

  // 给两个商品种上抛压，让预览里能看到抛压条 + 自然价差分线。
  // 第一个必须种 —— 大图默认选中 goods[0]，差分线只画在选中的那个商品上。
  const pressured = { [GAME.company.goods[0].id]: 0.62, [GAME.company.goods[4].id]: 0.28 };
  for (const id of Object.keys(pressured)) s.company.pressure[id] = pressured[id];
  // 期数游标推到当前期，否则首次结算会把刚种下的抛压当积压上百期衰减掉
  for (const g of GAME.company.goods) {
    s.company.lastPeriod[g.id] = Core.goodsPeriod(g, s.playTime);
  }
  const snap = Core.serialize(s);

  console.log('存档就绪：第 ' + Math.floor(s.playTime / 60) + ' 期，'
    + '产线 ' + GAME.company.lines.filter((l) => Core.lineOwned(s, l.id) > 0).length + ' 种，'
    + '库存 ' + Core.stockTotal(s) + ' 件');

  // ---------- 跑真实的前端脚本 ----------
  installStubs();
  EL_CACHE['co-line-list'] = mkListMock(
    GAME.company.lines.map((l) => l.id),
    ['lowned', 'lcap', 'lstats', 'llock', 'lprice', 'lbuy'], 'line');
  EL_CACHE['mk-good-list'] = mkListMock(
    GAME.company.goods.map((g) => g.id),
    ['gprice', 'gtrend', 'gmeta', 'gpress', 'gpressbar', 'gpresstxt',
     'gstock', 'gvalue', 'gsell', 'gspark'], 'good');

  global.fetch = async (url) => {
    const u = String(url);
    if (u.indexOf('/api/me') >= 0) {
      return { ok: true, status: 200, json: async () => ({ ok: true, username: 'preview' }) };
    }
    if (u.indexOf('/api/load') >= 0) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, isNew: false, state: snap, config: null, offline: null }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  require(path.join(ROOT, 'public', 'js', 'app.js'));
  await new Promise((r) => setTimeout(r, 120));   // 等 boot 的异步渲染落地

  // ---------- 取渲染结果 ----------
  const chart = String(EL_CACHE['mk-chart-body'].innerHTML);
  const rows = GAME.company.goods.map((g) => {
    const it = EL_CACHE['mk-good-list']._items.find((x) => x.dataset.good === g.id);
    const spark = it ? String(it._sub.gspark.innerHTML) : '';
    const trend = Core.goodsTrend(g, s.playTime);
    const cls = trend === 'up' ? 'up' : (trend === 'down' ? 'down' : 'flat');
    const arrow = trend === 'up' ? '▲ 涨' : (trend === 'down' ? '▼ 跌' : '— 平');
    const pr = Core.pressureOf(s, g.id);
    const drop = Core.marketDropRatio(s, g);
    const press = pr > 0
      ? '<div class="co-press' + (pr >= GAME.company.market.warnAt ? ' warn' : '') + '">'
        + '<span class="co-press-label">抛压</span>'
        + '<span class="co-press-bar"><i style="width:' + Math.round(pr * 100) + '%"></i></span>'
        + '<span class="co-press-txt">已被压 −' + (drop * 100).toFixed(1) + '%'
        + '<span class="faint">　本应 ' + Core.naturalPrice(g, s.playTime).toString()
        + '　卖出后下一期起跳</span></span></div>'
      : '';
    return '<div class="pv-row">'
      + '<div class="pv-name">' + g.name
      + '<span class="co-line-tag ' + (g.kind === 'xiuxian' ? 'xiuxian' : 'tech') + '">'
      + (g.kind === 'xiuxian' ? '修仙类' : '科技类') + ' · 每 ' + fmtPer(g) + '变价</span>'
      + press
      + '</div>'
      + '<div class="co-good-spark pv-spark">' + spark + '</div>'
      + '<div class="pv-trend trend ' + cls + '">' + arrow + '</div>'
      + '</div>';
  }).join('');

  if (!chart || chart.indexOf('<svg') !== 0) {
    console.error('渲染失败：mk-chart-body 里没有 SVG，预览中止');
    process.exit(1);
  }
  if (chart.indexOf('NaN') >= 0) {
    console.error('渲染异常：SVG 坐标里出现 NaN');
    process.exit(1);
  }

  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  // 大图默认选中 goods[0]，所以只对这个商品断言差分线必须出现
  const selectedGood = GAME.company.goods[0];
  const anyPressure = Core.pressureOf(s, selectedGood.id) > 0;
  if (anyPressure && chart.indexOf('stroke-dasharray="2 3"') < 0) {
    console.error('渲染异常：选中的商品有抛压，却没画出「自然价」参考线');
    process.exit(1);
  }
  const legend = '<span class="co-chart-legend">'
    + '<i class="lg solid"></i><span>已发生</span>'
    + '<i class="lg dashed"></i><span>推演</span>'
    + '<i class="lg base"></i><span>基准价</span>'
    + (anyPressure ? '<i class="lg natural"></i><span>自然价（未受抛压）</span>' : '')
    + '</span>';

  const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>算力修仙 · 价格走势图预览</title>'
    + '<style>' + css + '</style>'
    + '<style>'
    + 'body{background:var(--bg);color:var(--text);font:13px/1.5 system-ui,sans-serif;'
    + 'max-width:920px;margin:0 auto;padding:24px 18px 60px;}'
    + 'h1{font-size:16px;letter-spacing:2px;color:var(--gold);margin-bottom:4px;}'
    + '.pv-note{font-size:11px;color:var(--text-faint);margin-bottom:18px;}'
    + '.pv-panel{margin-bottom:18px;}'
    + '.pv-row{display:flex;align-items:center;gap:14px;padding:9px 14px;'
    + 'border-bottom:1px solid var(--border);}'
    + '.pv-row:last-child{border-bottom:none;}'
    + '.pv-name{flex:1;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;}'
    + '.pv-spark{flex:0 0 180px;width:180px;height:34px;}'
    + '.pv-trend{font-family:var(--mono);font-size:11px;min-width:54px;text-align:right;}'
    + '.pv-trend.up{color:var(--red);}.pv-trend.down{color:var(--jade);}'
    + '.pv-trend.flat{color:var(--text-faint);}'
    + '.pv-name{flex-direction:column;align-items:flex-start;gap:3px;}'
    + '.lg.natural{border-top:1px dashed var(--text-faint);}'
    + '</style></head><body>'
    + '<h1>价格走势图 · 静态预览</h1>'
    + '<div class="pv-note">由 tools/chart-preview.js 跑真实前端脚本导出，'
    + '存档时间：第 ' + Math.floor(s.playTime / 60) + ' 期'
    + '　·　灰色细虚线 = 不受抛压的自然价，与实线的落差就是玩家自己砸出来的'
    + '</div>'

    + '<div class="panel pv-panel"><div class="panel-head">'
    + '<h2>市场走势（大图）</h2><span class="hint">点商品行切换 · 这里只显示默认选中项</span>'
    + '</div><div class="co-chart-wrap">'
    + '<div class="co-chart-head">'
    + '<span class="co-chart-name">' + EL_CACHE['ui-mk-chart-name'].textContent + '</span>'
    + '<span class="co-chart-tag">' + EL_CACHE['ui-mk-chart-tag'].textContent + '</span>'
    + legend + '</div>'
    + '<div class="co-chart-body">' + chart + '</div>'
    + '<div class="co-chart-foot">' + EL_CACHE['ui-mk-chart-foot'].textContent + '</div>'
    + '</div></div>'

    + '<div class="panel pv-panel"><div class="panel-head">'
    + '<h2>各商品迷你走势</h2><span class="hint">只画已发生段，不推演</span>'
    + '</div>' + rows + '</div>'

    + '</body></html>\n';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  console.log('已导出：' + OUT);
  console.log('大图 SVG ' + chart.length + ' 字节，迷你走势 ' + GAME.company.goods.length + ' 条');
  process.exit(0);
})();
