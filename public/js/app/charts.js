/**
 * app · charts —— 价格走势 SVG：lineChartSVG 统一实现 + 商品/股票两个薄封装 + 迷你图缓存。
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

  /** 迷你走势图缓存。价格按「期」变，期内 SVG 是静止的，没换期就不重建。 */
  A.stockSparkCache = new Map();

  A.CHART_W = 320;   // viewBox 宽度，实际显示宽度由 CSS 决定

  A.CHART_EDGE = 5;  // viewBox 内的四周留白

  A.trendStroke = function trendStroke(trend) {
    if (trend === 'up') return 'var(--red)';      // 涨红
    if (trend === 'down') return 'var(--jade)';   // 跌绿
    return 'var(--text-faint)';
  }

  /**
   * 折线图统一实现 —— 商品走势与股票走势同构（同样的 viewBox / 拉伸 /
   * 竖线标记约束），早先是两份几乎逐行相同的函数，改一处忘另一处就是
   * 两条图对不上。差异只有三点：期数入口、自然价参照、无障碍标注。
   *
   * @param {object} o
   *   series    {period, price, t}[] 升序期序列
   *   curPeriod 当前期数（决定实线/虚线分界与竖线位置）
   *   basePrice 基准价（灰色虚线参照，纳入纵轴范围）
   *   natural   number[] 自然价序列（被抛压压低 / 自己造出冲击时才有，灰色虚线）
   *   trend     'up' | 'down' | 'flat'（涨红跌绿）
   *   height    viewBox 高度
   *   label     aria-label（"价格走势" / "股价走势"）
   */
  A.lineChartSVG = function lineChartSVG(o) {
    const series = o.series;
    if (!series || series.length < 2) return '';

    const curPeriod = o.curPeriod;
    const vals = series.map((p) => p.price.toNumber());
    const baseVal = Number(o.basePrice) || vals[0];
    if (o.natural) for (const v of o.natural) vals.push(v);

    // 纵轴范围：把基准价也纳入，保证参考线永远在可见区域内
    let lo = Math.min.apply(Math, vals.concat([baseVal]));
    let hi = Math.max.apply(Math, vals.concat([baseVal]));
    if (hi - lo < 1e-9) {
      const d = Math.max(1, Math.abs(hi) * 0.2);
      lo -= d; hi += d;
    }
    const pad = (hi - lo) * 0.14;
    lo -= pad; hi += pad;
    if (lo < 0) lo = 0;

    const span = o.height - A.CHART_EDGE * 2;
    const x = (i) => A.CHART_EDGE + (i * (A.CHART_W - A.CHART_EDGE * 2)) / (series.length - 1);
    const y = (v) => o.height - A.CHART_EDGE - ((v - lo) / (hi - lo)) * span;

    // 当前期在序列里的下标（序列升序，最后一个 period <= curPeriod 的就是它）
    let ci = 0;
    for (let i = 0; i < series.length; i++) if (series[i].period <= curPeriod) ci = i;

    const pts = (from, to) => {
      const a = [];
      for (let i = from; i <= to; i++) {
        a.push(x(i).toFixed(2) + ',' + y(series[i].price.toNumber()).toFixed(2));
      }
      return a.join(' ');
    };

    const stroke = A.trendStroke(o.trend);
    let svg = '<svg class="co-chart" viewBox="0 0 ' + A.CHART_W + ' ' + o.height + '" '
      + 'preserveAspectRatio="none" role="img" aria-label="' + o.label + '">';

    // 基准价参考线
    svg += '<line x1="0" y1="' + y(baseVal).toFixed(2) + '" x2="' + A.CHART_W + '" y2="'
      + y(baseVal).toFixed(2) + '" stroke="var(--border)" stroke-width="1" '
      + 'stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>';

    // 自然价参考线（仅在自己造成价差时出现：抛压 / 冲击）
    if (o.natural) {
      const npts = o.natural.map((v, i) => x(i).toFixed(2) + ',' + y(v).toFixed(2)).join(' ');
      svg += '<polyline points="' + npts + '" fill="none" stroke="var(--text-faint)" '
        + 'stroke-width="1" stroke-dasharray="2 3" opacity="0.55" '
        + 'vector-effect="non-scaling-stroke"/>';
    }

    // 已发生：实线
    svg += '<polyline points="' + pts(0, ci) + '" fill="none" stroke="' + stroke + '" '
      + 'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" '
      + 'vector-effect="non-scaling-stroke"/>';

    // 推演：虚线
    if (ci < series.length - 1) {
      svg += '<polyline points="' + pts(ci, series.length - 1) + '" fill="none" stroke="'
        + stroke + '" stroke-width="2" stroke-dasharray="4 3" stroke-linejoin="round" '
        + 'stroke-linecap="round" opacity="0.5" vector-effect="non-scaling-stroke"/>';
    }

    // 当前期标记：贯穿的淡竖线 + 从当前价到底部的实竖线
    const cx = x(ci).toFixed(2);
    const cy = y(series[ci].price.toNumber()).toFixed(2);
    svg += '<line x1="' + cx + '" y1="' + A.CHART_EDGE + '" x2="' + cx + '" y2="'
      + (o.height - A.CHART_EDGE) + '" stroke="' + stroke
      + '" stroke-width="1" opacity="0.22" vector-effect="non-scaling-stroke"/>';
    svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + cx + '" y2="'
      + (o.height - A.CHART_EDGE) + '" stroke="' + stroke
      + '" stroke-width="2" vector-effect="non-scaling-stroke"/>';

    return svg + '</svg>';
  }

  /** 商品价格走势：抛压生效时叠一条「不受抛压的自然价」参照线 */
  A.priceChartSVG = function priceChartSVG(good, realClock, trend, past, future, height) {
    const series = Core.goodsWindowWith(A.state, good, past, future);
    if (!series || series.length < 2) return '';
    const pressured = Core.pressureOf(A.state, good.id) > 0;
    const natural = pressured
      ? Core.goodsSeries(good, series[0].period,
          series[series.length - 1].period).map((p) => p.price.toNumber())
      : null;
    return A.lineChartSVG({
      series: series,
      curPeriod: Core.goodsPeriod(good, realClock),
      basePrice: good.basePrice,
      natural: natural,
      trend: trend,
      height: height,
      label: '价格走势',
    });
  }

  /**
   * 股票走势：有冲击时叠自然价参照线。
   *   过去期不受冲击影响（历史价已经拿不回来了），
   *   当前期与未来期按 flowDecay 逐期回到自然价 —— 于是玩家能一眼看出
   *   「行情本应值多少」以及「是我自己的买卖把它推歪了多少」。
   */
  A.stockChartSVG = function stockChartSVG(stock, realClock, trend, past, future, height) {
    const series = Core.stockWindow(A.state, stock, past, future);
    if (!series || series.length < 2) return '';
    const impacted = Core.stockFlow(A.state, stock.id) !== 0;
    return A.lineChartSVG({
      series: series,
      curPeriod: Core.stockPeriod(stock, realClock),
      basePrice: stock.basePrice,
      natural: impacted ? series.map((p) => p.natural.toNumber()) : null,
      trend: trend,
      height: height,
      label: '股价走势',
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
