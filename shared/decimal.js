/**
 * Decimal —— 十进制浮点数（尾数 + 指数）
 * 用于放置类游戏的超大数值运算，前后端共用同一份实现，保证结果一致。
 *
 * 表示法：value = sign * mantissa * 10^exponent
 *   - mantissa 归一化到 [1, 10) 区间（零除外）
 *   - exponent 为整数，可为负
 *
 * 精度：mantissa 保留 18 位有效数字（十进制）
 * 上限：约 1e(9e15)，远超任何游戏需求
 */

const PRECISION = 18;           // 有效数字位数
/** 指数上限（防止 e 溢出为 Infinity 导致后续运算产生 NaN） */
const MAX_EXPONENT = 9e15;
const LOG10E = Math.LOG10E;
const LN10 = Math.LN10;

function normalize(m, e) {
  // 溢出保护：传入 Infinity（常见于 JS 数值字面量超出 double 范围，
  // 例如 new D(1e400)）时，饱和到一个"极大但有限"的值，而不是静默归零。
  // 静默归零会造成难以排查的数值丢失。
  // 饱和值取 1e308（干净的 10 的幂），避免尾数位数破坏归一化不变量。
  if (!isFinite(m)) {
    if (isNaN(m)) return { m: 0, e: 0 };
    return { m: m > 0 ? 1 : -1, e: 308 };
  }
  if (m === 0) return { m: 0, e: 0 };
  // 指数溢出保护
  if (!isFinite(e)) e = e > 0 ? MAX_EXPONENT : -MAX_EXPONENT;
  e = Math.max(-MAX_EXPONENT, Math.min(MAX_EXPONENT, e));
  const neg = m < 0;
  m = Math.abs(m);
  // 把 m 归一到 [1, 10)
  const shift = Math.floor(Math.log10(m));
  if (shift !== 0) {
    m = m / Math.pow(10, shift);
    e += shift;
  }
  // 处理浮点误差导致的边界（如 9.9999999999999998）
  if (m >= 10) { m /= 10; e += 1; }
  if (m < 1 && m > 0) { m *= 10; e -= 1; }
  // 截断精度
  const factor = Math.pow(10, PRECISION - 1);
  m = Math.round(m * factor) / factor;
  if (m >= 10) { m /= 10; e += 1; }
  if (m === 0) return { m: 0, e: 0 };
  // 消掉浮点噪声（如 3.4999999999999996 -> 3.5）。
  //
  // 这里必须比 double 的可靠精度**再低一位**。JS 的 double 约有 15~16 位可靠
  // 有效数字，如果就按 15 位清洗，等于把最后一位的浮点噪声原样保留下来：
  //   new D(480).add(new D(240))  ->  7.199999999999999e2   （而不是 7.2e2）
  // 原因是 4.8 + 2.4 在二进制下并不精确，误差落在第 16 位，清洗到 15 位时刚好
  // 被当成有效数字留下。这类「整数相加得到非整数」的脏值会让 eq 比较失效，
  // 存档里也会出现一堆 7.199999999999999e2 这样的尾巴。
  //
  // 清洗到 14 位就留出了 1 位保护位，噪声被抹掉，而 14 位有效数字对放置类游戏
  // 来说依然绰绰有余（远超实际数值调参需要的位数）。
  const cleanFactor = Math.pow(10, PRECISION - 4);
  m = Math.round(m * cleanFactor) / cleanFactor;
  if (m >= 10) { m /= 10; e += 1; }
  if (m === 0) return { m: 0, e: 0 };
  return { m: neg ? -m : m, e };
}

class Decimal {
  constructor(m = 0, e = 0) {
    if (m instanceof Decimal) { this.m = m.m; this.e = m.e; return; }
    if (typeof m === 'string') {
      const p = Decimal.fromString(m);
      this.m = p.m; this.e = p.e; return;
    }
    if (m === 0) { this.m = 0; this.e = 0; return; }
    const n = normalize(m, e);
    this.m = n.m; this.e = n.e;
  }

  static fromString(s) {
    s = String(s).trim();
    if (!s) return new Decimal(0);
    // 支持 1.23e456 与 1.23E456
    const m = s.match(/^([+-]?)(\d*\.?\d+)(?:[eE]([+-]?\d+))?$/);
    if (!m) return new Decimal(0);
    const sign = m[1] === '-' ? -1 : 1;
    const num = parseFloat(m[2]);
    const exp = m[3] ? parseInt(m[3], 10) : 0;
    const n = normalize(sign * num, exp);
    return new Decimal(n.m, n.e);
  }

  static fromJSON(o) {
    if (o == null) return new Decimal(0);
    if (typeof o === 'number') return new Decimal(o);
    if (typeof o === 'string') return Decimal.fromString(o);
    if (o.m !== undefined) return new Decimal(o.m, o.e);
    return new Decimal(0);
  }

  /** 存档用：压成最简结构 */
  toJSON() { return { m: this.m, e: this.e }; }

  /** 显示用：1.23e456 */
  toString() {
    if (this.m === 0) return '0';
    return this.m.toFixed(2) + 'e' + this.e;
  }

  clone() { return new Decimal(this.m, this.e); }

  isZero() { return this.m === 0; }
  isNeg() { return this.m < 0; }
  isFinite() { return isFinite(this.m) && isFinite(this.e); }

  // ---------- 比较 ----------
  static cmp(a, b) {
    a = new Decimal(a); b = new Decimal(b);
    if (a.m === 0 && b.m === 0) return 0;
    if (a.m === 0) return b.m > 0 ? -1 : 1;
    if (b.m === 0) return a.m > 0 ? 1 : -1;
    if (a.m > 0 && b.m < 0) return 1;
    if (a.m < 0 && b.m > 0) return -1;
    const neg = a.m < 0;
    // 指数不同 → 先比指数。负数时「指数大 = 绝对值大 = 值更小」，要翻符号。
    if (a.e !== b.e) return (a.e > b.e ? 1 : -1) * (neg ? -1 : 1);
    // ⚠️ 指数相同时**不能再翻符号**：尾数本身就带着符号（-2.6 < -1.3），
    // 直接比尾数就是正确结果。早先这里也乘了 (neg ? -1 : 1)，把负数比较整体
    // 翻了个个 —— D(-2600).lt(D(-1300)) 会返回 false。游戏里金钱、灵气都是正数，
    // 一直没暴露；直到股市出现负盈亏，断言「可变现盈亏 ≤ 账面盈亏」才炸出来。
    return a.m === b.m ? 0 : (a.m > b.m ? 1 : -1);
  }

  cmp(b) { return Decimal.cmp(this, b); }
  gt(b) { return this.cmp(b) > 0; }
  gte(b) { return this.cmp(b) >= 0; }
  lt(b) { return this.cmp(b) < 0; }
  lte(b) { return this.cmp(b) <= 0; }
  eq(b) { return this.cmp(b) === 0; }

  static max(a, b) { return Decimal.cmp(a, b) >= 0 ? new Decimal(a) : new Decimal(b); }
  static min(a, b) { return Decimal.cmp(a, b) <= 0 ? new Decimal(a) : new Decimal(b); }

  // ---------- 加减 ----------
  static add(a, b) {
    a = new Decimal(a); b = new Decimal(b);
    if (a.m === 0) return b.clone();
    if (b.m === 0) return a.clone();
    // 对齐到较小指数
    let hi = a, lo = b;
    if (a.e < b.e) { hi = b; lo = a; }
    const diff = hi.e - lo.e;
    if (diff > PRECISION + 2) {
      // 差值超出精度，直接返回较大者
      return hi.clone();
    }
    const loScaled = lo.m / Math.pow(10, diff);
    const n = normalize(hi.m + loScaled, hi.e);
    return new Decimal(n.m, n.e);
  }

  static sub(a, b) {
    b = new Decimal(b);
    return Decimal.add(a, new Decimal(-b.m, b.e));
  }

  add(b) { return Decimal.add(this, b); }
  sub(b) { return Decimal.sub(this, b); }

  // ---------- 乘除 ----------
  static mul(a, b) {
    a = new Decimal(a); b = new Decimal(b);
    if (a.m === 0 || b.m === 0) return new Decimal(0);
    const n = normalize(a.m * b.m, a.e + b.e);
    return new Decimal(n.m, n.e);
  }

  static div(a, b) {
    a = new Decimal(a); b = new Decimal(b);
    if (b.m === 0) return new Decimal(0);
    if (a.m === 0) return new Decimal(0);
    const n = normalize(a.m / b.m, a.e - b.e);
    return new Decimal(n.m, n.e);
  }

  mul(b) { return Decimal.mul(this, b); }
  div(b) { return Decimal.div(this, b); }

  // ---------- 幂与根 ----------
  static pow(a, p) {
    a = new Decimal(a);
    p = typeof p === 'number' ? p : new Decimal(p).toNumber();
    if (a.m === 0) return new Decimal(0);
    if (p === 0) return new Decimal(1);
    if (p === 1) return a.clone();
    // (m * 10^e)^p = m^p * 10^(e*p)
    const logM = Math.log10(Math.abs(a.m));
    const total = (logM + a.e) * p;
    const e = Math.floor(total);
    const m = Math.pow(10, total - e);
    const n = normalize(m, e);
    if (a.m < 0 && Number.isInteger(p) && p % 2 !== 0) n.m = -n.m;
    return new Decimal(n.m, n.e);
  }

  static sqrt(a) { return Decimal.pow(a, 0.5); }

  pow(p) { return Decimal.pow(this, p); }
  sqrt() { return Decimal.sqrt(this); }

  /** 自然对数，用于公式；返回普通 number */
  static ln(a) {
    a = new Decimal(a);
    if (a.m <= 0) return -Infinity;
    return Math.log(a.m) + a.e * LN10;
  }

  /** 常用对数 */
  static log10(a) {
    a = new Decimal(a);
    if (a.m <= 0) return -Infinity;
    return Math.log10(a.m) + a.e;
  }

  ln() { return Decimal.ln(this); }
  log10() { return Decimal.log10(this); }

  // ---------- 转换 ----------
  /** 转为普通 number；超出范围时返回 ±Infinity */
  toNumber() {
    if (this.m === 0) return 0;
    if (this.e > 308) return this.m > 0 ? Infinity : -Infinity;
    if (this.e < -324) return 0;
    return this.m * Math.pow(10, this.e);
  }

  /** 向下取整（用于数量类数值） */
  floor() {
    if (this.e >= PRECISION) return this.clone();
    const v = this.toNumber();
    return new Decimal(Math.floor(v));
  }

  static floor(a) { return new Decimal(a).floor(); }

  /** 保留 n 位小数的近似 */
  toFixed(n = 2) {
    if (this.m === 0) return '0';
    return this.m.toFixed(n) + 'e' + this.e;
  }
}

Decimal.PRECISION = PRECISION;
Decimal.ZERO = new Decimal(0);
Decimal.ONE = new Decimal(1);

if (typeof module !== 'undefined' && module.exports) module.exports = Decimal;
if (typeof window !== 'undefined') window.Decimal = Decimal;
