/**
 * game-core · util —— 通用工具：数值兜底、确定性散列、行情时钟、大数简写、时间常量。无游戏语义，被其余全部模块依赖。
 *
 * 本文件属于 shared/core 模块群：所有模块共享同一个命名空间对象 C（函数在
 * 调用期经 C.xxx 惰性解析，因此模块间互相引用无需关心加载顺序）。请勿直接
 * 引用本文件，统一走 shared/game-core.js 聚合出口（Node）或 index.html 里
 * 按序加载的 <script>（浏览器）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory;
  } else {
    (root.__gcMods = root.__gcMods || []).push(factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (C, root) {
  const Decimal = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('../decimal.js') : root.Decimal;
  const GAME = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('../game-config.js') : root.GAME;
  const D = Decimal;

  /** 数值兜底：非有限数时取默认值（配置缺字段时，不要让它变成 NaN 渗进乘区） */
  C.num = function num(v, dflt) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : dflt;
  }

  // ---------- 时间常量 ----------
  const SEC_PER_MIN = C.SEC_PER_MIN = 60;
  const SEC_PER_HOUR = C.SEC_PER_HOUR = 3600;
  const SEC_PER_DAY = C.SEC_PER_DAY = 86400;
  const DAYS_PER_MONTH = C.DAYS_PER_MONTH = GAME.time.daysPerMonth;
  const MONTHS_PER_YEAR = C.MONTHS_PER_YEAR = GAME.time.monthsPerYear;
  const DAYS_PER_YEAR = C.DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR;
  const SEC_PER_MONTH = C.SEC_PER_MONTH = SEC_PER_DAY * DAYS_PER_MONTH;
  const SEC_PER_YEAR = C.SEC_PER_YEAR = SEC_PER_MONTH * MONTHS_PER_YEAR;

  /** 确定性散列 → [0, 1)。同一个 x 永远得到同一个值（前后端一致性靠它） */
  C.hash01 = function hash01(x) {
    const v = Math.sin(x) * 43758.5453123;
    return v - Math.floor(v);
  }
  /**
   * 行情时钟 —— 市场与股市的「期」都按**现实秒**计。
   *
   * 用 playTime（现实秒累计）而不是 gameSeconds：时间档位只该加速工作，
   * 不该加速行情。否则档 4（1 秒 = 1 游戏月）下 1 游戏年只剩 12 现实秒，
   * 抛压与股市冲击 4 期就衰减干净，「砸盘被压价 / 大单砸自己」的代价被档位抹掉。
   */
  C.marketClock = function marketClock(s) {
    return (s && s.playTime) || 0;
  }
  /** 大数简写（提示文案用）：1234 → 1.23e3 */
  C.fmtBig = function fmtBig(v) {
    if (v === null || v === undefined) return '0';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (Math.abs(n) < 1e4) return String(Math.round(n));
    return n.toExponential(2).replace('e+', 'e');
  }

  return C;
});
