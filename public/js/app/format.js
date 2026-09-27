/**
 * app · format —— 数字与时长格式化（fmt 万亿兆中文单位、pct、时长、周期文案）。
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

  /**
   * 把 Decimal 格式化成人类可读的短字符串。
   * < 1000        → 保留最多 2 位小数，如 12.34
   * < 1e6         → 千分位，如 1,234
   * < 1e15        → 万/亿/兆/京 中文单位
   * >= 1e15       → 科学计数法 1.23e18
   */
  A.fmt = function fmt(dec) {
    if (!dec) return '0';
    if (!(dec instanceof D)) dec = D.fromJSON(dec);

    const neg = dec.m < 0;
    dec = new D(Math.abs(dec.m), dec.e);
    let out;

    if (dec.m === 0) {
      out = '0';
    } else if (dec.e < 3) {
      const n = dec.toNumber();
      if (n < 10)       out = n.toFixed(n % 1 === 0 ? 0 : 2);
      else if (n < 100) out = n.toFixed(n % 1 === 0 ? 0 : 1);
      else              out = Math.floor(n).toLocaleString('en-US');
    } else if (dec.e < 6) {
      out = Math.floor(dec.toNumber()).toLocaleString('en-US');
    } else if (dec.e < 15) {
      out = A.chineseUnit(dec);
    } else {
      out = dec.m.toFixed(2) + 'e' + dec.e;
    }

    return (neg ? '-' : '') + out;
  }

  A.CN_UNITS = [
    { e: 12, s: '兆' },
    { e: 8,  s: '亿' },
    { e: 4,  s: '万' },
  ];

  A.chineseUnit = function chineseUnit(dec) {
    for (const u of A.CN_UNITS) {
      if (dec.e >= u.e) {
        const v = D.div(dec, new D(1, u.e)).toNumber();
        return v.toFixed(v < 100 ? 2 : 1) + u.s;
      }
    }
    return Math.floor(dec.toNumber()).toLocaleString('en-US');
  }

  /** 速率显示：+1.23万 / 秒 */
  A.fmtRate = function fmtRate(dec) {
    return '+' + A.fmt(dec) + ' / 秒';
  }

  /** 百分比 */
  A.pct = function pct(v) {
    const n = (v instanceof D) ? v.toNumber() : v;
    if (!isFinite(n)) return '100.00%';
    const p = n * 100;
    if (p >= 100) return '100.00%';
    if (p === 0) return '0.00%';
    if (p < 0.01) return p.toFixed(4) + '%';
    return p.toFixed(2) + '%';
  }

  /** 现实时长（秒）—— 用于「还剩多久完成」 */
  A.fmtRealDuration = function fmtRealDuration(sec) {
    sec = Math.max(0, Math.ceil(sec));
    if (sec < 60) return sec + ' 秒';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h + ' 时 ' + m + ' 分';
  }

  /** 变价周期（现实秒）→ 简洁文案："60 秒" / "10 分钟" / "1 小时" */
  A.fmtPeriod = function fmtPeriod(sec) {
    sec = Math.max(1, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + ' 秒';
    if (sec % 3600 === 0) return (sec / 3600) + ' 小时';
    if (sec % 60 === 0) return (sec / 60) + ' 分钟';
    return A.fmtRealDuration(sec);
  }

  A.fmtCount = function fmtCount(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  /** 带符号百分比：0.05 → +5%，-0.15 → -15% */
  A.fmtSignedPct = function fmtSignedPct(v) {
    const n = Number(v) || 0;
    const p = n * 100;
    const sign = p >= 0 ? '+' : '';
    return sign + (Math.abs(p) < 1 ? p.toFixed(2) : p.toFixed(1)) + '%';
  }

  /** 普通数值（神识这类可能是很大的整数） */
  A.fmtNum = function fmtNum(n) {
    if (!isFinite(n)) return '∞';
    const a = Math.abs(n);
    if (a < 1000) return (Math.round(n * 100) / 100).toString();
    if (a < 1e8) return Math.round(n).toLocaleString('en-US');
    return n.toExponential(2).replace('e+', 'e');
  }

  A.pad2 = function pad2(n) { return n < 10 ? '0' + n : String(n); }
})(typeof window !== 'undefined' ? window : globalThis);
