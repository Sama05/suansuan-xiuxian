/**
 * app · state —— 全局可变状态。
 *
 * 浏览器端不把游戏状态写进 localStorage（只存 token），状态始终以服务端存档
 * 为准；本地这份是「实时手感层」，由 100ms tick 推进、按 15 秒节流回写。
 * 其余模块只读写 A.xxx，不自己 declare。
 */
(function (root) {
  const A = (root.App = root.App || {});

  // ---------- 全局状态 ----------
  A.state = null;
  A.token = null;
  A.username = '';
  A.dirty = false;
  A.currentTab = 'realm';
  // 市场走势图当前选中的商品（点击商品行可切换）
  A.chartGood = null;
  // 股市走势图当前选中的股票（同上）
  A.chartStock = null;
  // 行情列表是否展开全部 100 家（默认只列市值前 10）
  A.showAllStocks = false;
  A.lastLocalTick = 0;
  A.lastServerSave = 0;
  A.saveTimer = null;
  A.tickTimer = null;
  A.syncing = false;
  /**
   * 请求服务端执行一次渡劫。节流 1.2 秒，避免「灵气刚好压在阈值上」时
   * 每 100ms 发一次请求（失败会重置状态，成功的下一境也要等一小会儿）。
   */
  A.lastTribulationAt = 0;
  A.tribulating = false;
  A.firstRenderDone = false;
  A.STORAGE_KEY = 'suansuan-xiuxian-token';

})(typeof window !== 'undefined' ? window : globalThis);
