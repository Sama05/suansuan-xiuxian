/**
 * app · page-stock —— 股市页：行情列表、买卖报价缓存、交易操作。
 *
 * 本文件是 public/js/app 模块群的一员：全部模块共享入口注入的命名空间 A，
 * 函数在调用期经 A.xxx 解析（新增模块只需挂到 A 上并加入 index.html 脚本序）。
 * 可变状态统一由 state.js 初始化；请勿直接引用本文件，浏览器从 /js/app.js 进入。
 */
(function (root) {
  const A = (root.App = root.App || {});
  const D = root.Decimal;
  const GAME = root.GAME;
  const Core = root.GameCore;
  'use strict';

  // 每只股票的交易数量。必须缓存下来：列表每 100ms 重绘一次，
  // 若每次都用配置里的默认值回写输入框，玩家刚敲进去的数字会被冲掉。
  A.stockQty = Object.create(null);

  /**
   * 买卖报价缓存。key = (期数 | 净买入流 | 持仓 | 手数 | 最小成交额)，
   * 报价只由这几项决定；金钱只影响「够不够买」那一次比较，不进 key。
   * 行情不动就一帧都不用重算 —— 报价要走行业传导链，50 只股票全量重算每帧要几毫秒。
   */
  A.stockQuoteCache = Object.create(null);

  A.renderStockPage = function renderStockPage() {
    const S = GAME.stock;
    if (!S || !S.implemented) return;

    const unlocked = Core.stockUnlocked(A.state);
    A.$('stock-panel').classList.toggle('hidden', unlocked);
    A.$('stock-main').classList.toggle('hidden', !unlocked);
    A.$('tab-stock').classList.toggle('locked', !unlocked);

    // ---------- 未开户 ----------
    if (!unlocked) {
      A.$('tab-stock-badge').textContent = '未开户';
      A.$('ui-st-lock').textContent = Core.stockLockedReason(A.state) || '尚未开放';
      return;
    }

    const sum = Core.stockSummary(A.state);
    if (!sum) return;

    const held = sum.stocks.filter((x) => x.shares > 0).length;
    A.$('tab-stock-badge').textContent = held > 0 ? ('持 ' + held + ' 只') : '已开户';

    // ---------- 账户概览 ----------
    // 盈亏一律按「可变现」口径：市值里含着自己买出来的冲击溢价，
    // 而那份溢价在卖出时会被自己砸回去，不算真赚到的钱。
    A.$('ui-st-value').textContent = A.fmt(sum.totalValue);
    A.$('ui-st-cost').textContent = A.fmt(sum.totalCost);

    const pnlEl = A.$('ui-st-pnl');
    pnlEl.textContent = (sum.pnl.isNeg() ? '' : '+') + A.fmt(sum.pnl);
    pnlEl.className = 'v ' + (sum.pnl.isNeg() ? 'jade' : 'red');

    A.$('ui-st-liq').textContent = A.fmt(sum.liquidateValue);
    const lpEl = A.$('ui-st-liqpnl');
    lpEl.textContent = (sum.liquidatePnl.isNeg() ? '' : '+') + A.fmt(sum.liquidatePnl);
    lpEl.className = 'v ' + (sum.liquidatePnl.isNeg() ? 'jade' : 'red');

    A.$('ui-st-cash').textContent = A.fmt(A.state.money);

    const rEl = A.$('ui-st-realized');
    rEl.textContent = (sum.realized.isNeg() ? '' : '+') + A.fmt(sum.realized);
    rEl.className = 'v ' + (sum.realized.isNeg() ? 'jade' : 'red');

    A.$('ui-st-fee').textContent = '-' + A.fmt(sum.totalFee);
    A.$('ui-st-trades').textContent = A.fmtCount(sum.totalTrades) + ' 笔';

    const ratioEl = A.$('ui-st-pnlratio');
    ratioEl.className = 'hint';
    ratioEl.textContent = sum.totalCost.gt(0)
      ? ('可变现收益率 ' + A.fmtSignedPct(sum.liquidatePnlRatio))
      : '暂无持仓';

    // ---------- 选中股票（走势图 + 行情时钟都跟着它）----------
    if (!GAME.stock.stocks.some((x) => x.id === A.chartStock)) {
      const withHold = sum.stocks.find((x) => x.shares > 0);
      A.chartStock = (withHold || sum.stocks[0] || {}).id || null;
    }
    const sel = sum.stocks.find((x) => x.id === A.chartStock) || sum.stocks[0];

    if (sel) {
      const st = Core.stockById(sel.id);
      const len = Core.stockPeriodSeconds(st);
      const prog = len > 0 ? ((A.state.playTime % len) / len) : 0;
      A.$('ui-st-periodbar').style.width = (prog * 100).toFixed(1) + '%';
      A.$('ui-st-period-label').textContent =
        '距离下次变价 ' + A.fmtRealDuration(Core.stockNextChangeIn(st, A.state.playTime));
      A.$('ui-st-period').textContent = '第 ' + sel.period + ' 期 · 每期 ' + A.fmtPeriod(len);
    }

    const peakEl = A.$('ui-st-peak');
    if (sum.peak <= 1e-9) {
      peakEl.className = 'hint';
      peakEl.textContent = '无冲击';
    } else {
      const sev = sum.peak / Math.max(1e-9, Number(sum.maxRise) || 0.6);
      peakEl.className = 'hint ' + (sev >= 0.6 ? 'err' : 'warn');
      peakEl.textContent = '冲击峰值 ' + (sum.peak * 100).toFixed(2) + '%';
    }

    A.setHTML(A.$('ui-st-rules'),
      '<div>成交价 = 自然价 × 冲击系数　自然价 = 基准 × 行情 × 公司联动 ' +
        (sum.linkWeight * 100).toFixed(0) + '%</div>' +
      '<div>单边手续费 ' + (sum.fee * 100).toFixed(2) + '%　单笔成交额 ≥ ' +
        A.esc(A.fmt(new D(sum.minOrder))) + '</div>' +
      '<div>净买入流每期衰减至 ' + (sum.flowDecay * 100).toFixed(0) +
        '%　买入最多推高 ' + (sum.maxRise * 100).toFixed(0) +
        '%、卖出最多压低 ' + (sum.maxDrop * 100).toFixed(0) + '%</div>' +
      '<div>成交按「成交之后」的冲击价结算 —— 同一轮买卖必亏掉溢价 + 双边手续费</div>');

    // ---------- 行情列表 ----------
    // 池子 50 家，界面默认只列市值前 N 家；榜外公司照样能交易，
    // 只是不占版面 —— 榜单随行情换人，涨起来的公司会自己挤进来。
    const boardRank = Object.create(null);
    for (let i = 0; i < sum.board.length; i++) boardRank[sum.board[i].id] = i + 1;

    const boardTxt = A.$('ui-st-board-txt');
    const boardBtn = A.$('btn-st-board-all');
    if (boardTxt) {
      boardTxt.textContent = A.showAllStocks
        ? ('全部 ' + sum.stocks.length + ' 家')
        : ('市值榜 · 前 ' + sum.board.length + ' 家（共 ' + sum.stocks.length + ' 家）');
    }
    if (boardBtn) {
      boardBtn.textContent = A.showAllStocks ? '只看市值前 10' : '显示全部 ' + sum.stocks.length + ' 家';
    }

    // id -> 行对象。别用 Array.find：50 行 × 50 家的 O(n²) 每帧白扫两千多次。
    const rowById = Object.create(null);
    for (const x of sum.stocks) rowById[x.id] = x;

    const rows = A.$('st-list').querySelectorAll('.st-row');
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i];
      const row = rowById[el.dataset.stock];
      if (!row) continue;
      const st = Core.stockById(row.id);

      // 榜外公司：默认隐藏，点「显示全部」才铺开
      const rank = boardRank[row.id] || 0;
      el.classList.toggle('hidden', !A.showAllStocks && rank === 0);
      if (!A.showAllStocks && rank === 0) continue;

      el.classList.toggle('selected', row.id === A.chartStock);
      el.classList.toggle('locked', !row.unlocked);

      const trend = row.trend;
      const tEl = el.querySelector('[data-role="sttrend"]');
      A.setT(tEl, 'className', 'trend ' + trend);
      A.setT(tEl, 'textContent', (trend === 'up' ? '▲ 涨' : (trend === 'down' ? '▼ 跌' : '— 平')) +
        '　基准 ' + A.fmt(new D(row.basePrice)));

      A.setT(el.querySelector('[data-role="stprice"]'), 'textContent', A.fmt(row.price));

      A.setT(el.querySelector('[data-role="stmeta"]'), 'innerHTML',
        '距变价 ' + A.esc(A.fmtRealDuration(row.nextChangeIn)) +
        '　流通盘 ' + A.fmtCount(row.depth) + ' 股' +
        (rank > 0 ? '　市值 ' + A.esc(A.fmt(row.marketCap)) + ' · 第 ' + rank + ' 名' : '') +
        '　持仓占比 ' + A.esc(A.pct(row.heldRatio)) +
        '　净买入流 ' + (row.flow > 0 ? '+' : '') + A.fmtCount(row.flow) + ' 股');

      // ---------- 冲击条 ----------
      const impEl = el.querySelector('[data-role="stimp"]');
      if (impEl) {
        const pctv = row.impactPct;
        const on = Math.abs(pctv) > 1e-6;
        impEl.classList.toggle('hidden', !on);
        impEl.classList.toggle('down', pctv < 0);
        impEl.classList.toggle('warn', pctv > 0);
        const barEl = el.querySelector('[data-role="stimpbar"]');
        if (barEl) {
          const full = pctv >= 0 ? (Number(sum.maxRise) || 1) : (Number(sum.maxDrop) || 1);
          const w = Math.round(Math.min(1, Math.abs(pctv) / full) * 100) + '%';
          if (barEl.style.width !== w) barEl.style.width = w;
        }
        const txtEl = el.querySelector('[data-role="stimptxt"]');
        if (txtEl) {
          A.setT(txtEl, 'innerHTML', (pctv >= 0 ? '买盘推高 +' : '卖盘压低 −') +
            A.esc((Math.abs(pctv) * 100).toFixed(2)) + '%' +
            '<span class="faint">　自然价 ' + A.esc(A.fmt(row.naturalPrice)) +
            '　逐期衰减回去</span>');
        }
      }

      // ---------- 持仓 ----------
      const sEl = el.querySelector('[data-role="stshares"]');
      A.setT(sEl, 'textContent', A.fmtCount(row.shares) + ' 股');
      sEl.classList.toggle('zero', row.shares <= 0);
      A.setT(el.querySelector('[data-role="stvalue"]'), 'textContent', row.shares > 0
        ? ('市值 ' + A.fmt(row.value)) : '未持仓');

      const pEl = el.querySelector('[data-role="stpnl"]');
      if (row.shares > 0) {
        A.setT(pEl, 'className', 'pnl ' + (row.liquidatePnl.isNeg() ? 'down' : 'up'));
        A.setT(pEl, 'textContent', '可变现 ' + A.fmt(row.liquidateValue) + '　' +
          (row.liquidatePnl.isNeg() ? '' : '+') + A.fmt(row.liquidatePnl) +
          '（' + A.fmtSignedPct(row.liquidatePnlRatio) + '）');
      } else {
        A.setT(pEl, 'className', 'pnl');
        A.setT(pEl, 'textContent', '');
      }

      // ---------- 交易 ----------
      // 首次渲染给一个「够得着最小成交额」的默认手数；之后完全由玩家决定
      if (A.stockQty[row.id] === undefined) {
        const px = row.price.toNumber() || 1;
        A.stockQty[row.id] = Math.max(1, Math.ceil((Number(sum.minOrder) || 0) / px));
      }
      const qty = Math.max(0, Math.floor(Number(A.stockQty[row.id]) || 0));

      const qtyEl = el.querySelector('[data-role="stqty"]');
      if (qtyEl) {
        const want = String(A.stockQty[row.id]);
        if (qtyEl.value !== want) qtyEl.value = want;
        qtyEl.max = String(Math.max(1, row.depth));
      }

      // 买卖报价的输入只有「期数 / 净买入流 / 持仓 / 手数 / 最小成交额」。
      // 报价要走行业传导链（不便宜），而这几项在绝大多数帧里根本不变 ——
      // 按 key 缓存，行情没动就一帧都不用重算。（金钱只影响「够不够买」的判断，
      // 那是后面一次比较，不进缓存键。）
      const qKey = row.period + '|' + row.flow + '|' + row.shares + '|' + qty +
        '|' + row.impactPct + '|' + sum.minOrder;
      let qc = A.stockQuoteCache[row.id];
      if (!qc || qc.key !== qKey) {
        qc = {
          key: qKey,
          buy: Core.stockBuyQuote(A.state, st, qty),
          sell: row.shares > 0
            ? Core.stockSellQuote(A.state, st, Math.min(qty, row.shares)) : null,
        };
        A.stockQuoteCache[row.id] = qc;
      }
      const bq = qc.buy;
      const costEl = el.querySelector('[data-role="stcost"]');
      let buyOk = false;
      if (qty <= 0) {
        A.setT(costEl, 'className', 'st-trade-cost');
        A.setT(costEl, 'textContent', '输入股数');
      } else if (!bq.ok) {
        A.setT(costEl, 'className', 'st-trade-cost no');
        A.setT(costEl, 'textContent', bq.msg);
      } else if (bq.tooSmall) {
        A.setT(costEl, 'className', 'st-trade-cost no');
        A.setT(costEl, 'textContent', '买额需 ≥ ' + A.fmt(new D(sum.minOrder)));
      } else if (bq.total.gt(A.state.money)) {
        A.setT(costEl, 'className', 'st-trade-cost no');
        A.setT(costEl, 'textContent', '买需 ' + A.fmt(bq.total) + ' · 金钱不足');
      } else {
        A.setT(costEl, 'className', 'st-trade-cost');
        A.setT(costEl, 'textContent', '买需 ' + A.fmt(bq.total) + ' · 均价 ' + A.fmt(bq.unitPrice));
        buyOk = true;
      }

      // 卖出预览（数量超过持仓时按持仓算，与内核的 clamp 一致）
      const sellable = Math.min(qty, row.shares);
      const sq = qc.sell;
      const netEl = el.querySelector('[data-role="stnet"]');
      let sellOk = false;
      if (row.shares <= 0) {
        A.setT(netEl, 'className', 'st-trade-cost');
        A.setT(netEl, 'textContent', '未持仓');
      } else if (qty <= 0) {
        A.setT(netEl, 'className', 'st-trade-cost');
        A.setT(netEl, 'textContent', '输入股数');
      } else if (!sq || !sq.ok) {
        A.setT(netEl, 'className', 'st-trade-cost no');
        A.setT(netEl, 'textContent', (sq && sq.msg) || '无法卖出');
      } else if (sq.tooSmall) {
        A.setT(netEl, 'className', 'st-trade-cost no');
        A.setT(netEl, 'textContent', '卖额需 ≥ ' + A.fmt(new D(sum.minOrder)));
      } else {
        A.setT(netEl, 'className', 'st-trade-cost');
        A.setT(netEl, 'textContent', '卖得 ' + A.fmt(sq.net) +
          (sellable < qty ? '（按 ' + A.fmtCount(sellable) + ' 股）' : '') +
          ' · 均价 ' + A.fmt(sq.unitPrice));
        sellOk = true;
      }

      // v3.6：未解锁个股（融合赛道 50 家 = 元婴解锁）禁交易并标注原因
      if (!row.unlocked) {
        const reason = Core.stockAccessReason(A.state, st) || '元婴解锁';
        A.setT(costEl, 'className', 'st-trade-cost no');
        A.setT(costEl, 'textContent', '🔒 ' + reason);
        A.setT(netEl, 'className', 'st-trade-cost');
        A.setT(netEl, 'textContent', '');
        buyOk = false; sellOk = false;
      }

      const bb = el.querySelector('[data-role="stbuy"]');
      if (bb.disabled !== !buyOk) bb.disabled = !buyOk;
      const bs = el.querySelector('[data-role="stsell"]');
      if (bs.disabled !== !sellOk) bs.disabled = !sellOk;
      const bc = el.querySelector('[data-role="stclose"]');
      if (bc.disabled !== (row.shares <= 0)) bc.disabled = row.shares <= 0;
      const bm = el.querySelector('[data-role="stmax"]');
      if (bm.disabled !== (row.maxBuy <= 0)) bm.disabled = row.maxBuy <= 0;

      // 行内迷你走势：只看已发生的期，不推演。
      // 走势在「期」内是静止的（价格按期变），所以按 (股票, 期数, 有无冲击) 缓存 ——
      // 没换期就完全不用重建 SVG 字符串，更不用让浏览器重新解析 50 段 SVG。
      const sparkEl = el.querySelector('[data-role="stspark"]');
      if (sparkEl) {
        const sKey = row.id + ':' + row.period + ':' + (row.flow !== 0 ? 1 : 0);
        let svg = A.stockSparkCache.get(sKey);
        if (svg === undefined) {
          svg = A.stockChartSVG(st, A.state.playTime, trend, 8, 0, 34);
          if (A.stockSparkCache.size > 300) A.stockSparkCache.clear();
          A.stockSparkCache.set(sKey, svg);
        }
        if (sparkEl.innerHTML !== svg) sparkEl.innerHTML = svg;
      }
    }

    // ---------- 行情概览提示 ----------
    const hintEl = A.$('ui-st-market-hint');
    if (sum.peak <= 1e-9) {
      hintEl.className = 'hint';
      hintEl.textContent = '无冲击　·　所有股票都在按自然价成交';
    } else {
      const sev = sum.peak / Math.max(1e-9, Number(sum.maxRise) || 0.6);
      hintEl.className = 'hint ' + (sev >= 0.6 ? 'err' : 'warn');
      hintEl.textContent = '冲击峰值 ' + (sum.peak * 100).toFixed(2) +
        '%　·　净买入流每期衰减至 ' + (sum.flowDecay * 100).toFixed(0) + '%';
    }

    // ---------- 走势图（跟随选中的股票）----------
    const chartBody = A.$('st-chart-body');
    if (sel && chartBody) {
      const st = Core.stockById(sel.id);
      // 大图与迷你图同一条缓存思路：期内静止，按 (股票, 期, 净买入流, 持仓) 缓存。
      // 这张图有 20 个期点 + 自然价虚线，是整页最贵的一段 SVG，不缓存会每帧重建。
      const cKey = sel.id + ':' + sel.period + ':' + sel.flow + ':' + sel.shares;
      let csvg = A.stockSparkCache.get(cKey);
      if (csvg === undefined) {
        csvg = A.stockChartSVG(st, A.state.playTime, sel.trend, 12, 8, 118);
        if (A.stockSparkCache.size > 300) A.stockSparkCache.clear();
        A.stockSparkCache.set(cKey, csvg);
      }
      if (chartBody.innerHTML !== csvg) chartBody.innerHTML = csvg;

      A.setText('ui-st-chart-name', sel.name + '　' + sel.code);
      const good = sel.link ? Core.goodById(sel.link) : null;
      A.setText('ui-st-chart-tag',
        (good ? '联动 · ' + good.name : '独立行情') + ' · 每 ' + A.fmtPeriod(sel.periodSeconds) + '变价');

      let foot = '第 ' + Math.max(0, sel.period - 12) + ' ~ ' + (sel.period + 8) +
        ' 期（当前第 ' + sel.period + ' 期）　成交价 ' + A.fmt(sel.price) +
        '　自然价 ' + A.fmt(sel.naturalPrice) +
        '　基准 ' + A.fmt(new D(sel.basePrice)) +
        '　距变价 ' + A.fmtRealDuration(sel.nextChangeIn);
      if (Math.abs(sel.impactPct) > 1e-6) {
        foot += '　' + (sel.impactPct > 0 ? '你的买盘把成交价推高 ' : '你的卖盘把成交价压低 ') +
          (Math.abs(sel.impactPct) * 100).toFixed(2) + '%（会逐期衰减回去）';
      }
      A.setText('ui-st-chart-foot', foot);
    }
  }

  A.stockQtyValue = function stockQtyValue(id) {
    return Math.max(0, Math.floor(Number(A.stockQty[id]) || 0));
  }

  /** all = true 时无视输入框，直接按全部持仓卖出（「清仓」按钮） */
  A.stockTrade = async function stockTrade(side, stockId, all) {
    if (!A.state) return;
    const stock = Core.stockById(stockId);
    if (!stock) return;

    let shares = all ? Core.stockShares(A.state, stockId) : A.stockQtyValue(stockId);
    if (!(shares > 0)) {
      A.toast(all ? '该股票没有持仓' : '请输入交易股数', 'err');
      return;
    }

    // 本地预演：把「金钱不足 / 超过流通盘 / 不足最小成交额」这类
    // 一定能提前判断的拒绝挡在这里，避免无谓的往返
    const quote = side === 'buy'
      ? Core.stockBuyQuote(A.state, stock, shares)
      : Core.stockSellQuote(A.state, stock, shares);
    if (!quote.ok) { A.toast(quote.msg, 'err'); return; }
    if (quote.tooSmall) {
      A.toast('单笔成交额不足 ' + Core.fmtBig(Core.stockCfg().minOrder || 0), 'err');
      return;
    }
    if (side === 'buy' && quote.total.gt(A.state.money)) { A.toast('金钱不足', 'err'); return; }

    const r = await A.serverAction(side === 'buy' ? 'buyStock' : 'sellStock',
      { stockId: stockId, shares: shares });
    if (!r) return;

    if (side === 'buy') {
      A.toast('买入 ' + stock.name + ' ×' + A.fmtCount(r.shares) +
        '　均价 ' + A.fmt(D.fromJSON(r.unitPrice)) +
        '　支出 -' + A.fmt(D.fromJSON(r.total)), 'ok');
      A.stockQty[stockId] = r.shares;   // 手数保持，方便接着买
      // 大单才上通知栏：成交额 ≥ 100 万 或 ≥ 手头金钱的一成，小额进出不刷屏
      const total = D.fromJSON(r.total);
      if (total.gte(1e6) || total.gte(A.state.money.mul(0.1))) {
        A.pushEvent('股市大单：买入 ' + stock.name + '（' + stock.code + '）' +
          A.fmtCount(r.shares) + ' 股 · 支出 ' + A.fmt(total), 'money');
      }
    } else {
      const profit = D.fromJSON(r.profit);
      A.toast('卖出 ' + stock.name + ' ×' + A.fmtCount(r.shares) +
        '　均价 ' + A.fmt(D.fromJSON(r.unitPrice)) +
        '　净得 +' + A.fmt(D.fromJSON(r.net)) +
        '　本笔盈亏 ' + (profit.isNeg() ? '' : '+') + A.fmt(profit), 'ok');
      // 清仓后把数量还原成默认手数，下次开仓不用自己再填
      if (r.sharesAfter === 0) delete A.stockQty[stockId];
      const big = D.fromJSON(r.net).gte(1e6);
      if (big) {
        A.pushEvent('股市大单：清出 ' + stock.name + '（' + stock.code + '）' +
          A.fmtCount(r.shares) + ' 股 · 净得 ' + A.fmt(D.fromJSON(r.net)) +
          '（' + (profit.isNeg() ? '亏 ' : '盈 ') + A.fmt(profit) + '）', 'money');
      }
    }
  }

  A.stockFillMax = function stockFillMax(stockId) {
    if (!A.state) return;
    const stock = Core.stockById(stockId);
    if (!stock) return;
    const max = Core.stockMaxBuy(A.state, stock);
    if (max <= 0) {
      A.toast('金钱不足以买入最小成交额（' +
        Core.fmtBig(Core.stockCfg().minOrder || 0) + '）', 'err');
      return;
    }
    A.stockQty[stockId] = max;
    A.renderStockPage();
  }
})(typeof window !== 'undefined' ? window : globalThis);
