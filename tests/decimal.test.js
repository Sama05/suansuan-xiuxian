/**
 * Decimal 模块单元测试
 * 用法: node tests/decimal.test.js
 */

const D = require('../shared/decimal.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) {
  const x = a.toString(), y = b.toString();
  ok(x === y, name, x + ' vs ' + y);
}

console.log('\n=== 构造与归一化 ===');
{
  eq(new D(0), D.fromString('0'), '0');
  eq(new D(10), D.fromString('1e1'), '10 = 1e1');
  eq(new D(460), D.fromString('4.6e2'), '460 = 4.6e2');
  eq(new D(0.05), D.fromString('5e-2'), '0.05 = 5e-2');
  eq(D.fromString('1.23e456'), D.fromString('1.23e456'), '大数往返一致');
  eq(D.fromString('-2.5e-10'), D.fromString('-2.5e-10'), '负数小数');
  ok(D.fromString('abc').eq(0), '非法字符串返回 0');
  ok(D.fromJSON(null).eq(0), 'fromJSON(null) = 0');
  ok(D.fromJSON({ m: 3, e: 5 }).eq(D.fromString('3e5')), 'fromJSON 对象');
}

console.log('\n=== 加减（精度关键路径） ===');
{
  eq(D.add(new D(460), new D(0.05)), D.fromString('460.05'), '460 + 0.05');
  eq(D.add(new D(100), new D(0.05)), D.fromString('100.05'), '100 + 0.05');
  eq(D.add(new D(1), new D(999999)), new D(1000000), '1 + 999999');
  eq(D.sub(new D(10), new D(10)), new D(0), '10 - 10 = 0');
  eq(D.sub(new D(0), new D(5)), new D(-5), '0 - 5 = -5');
  eq(D.add(new D(1e300), new D(1e300)), D.fromString('2e300'), '1e300 + 1e300');
  // 精度极限：差值超过 18 位有效数字时，小数被吞掉（可接受）
  eq(D.add(new D(1e30), new D(1)), D.fromString('1e30'), '1e30 + 1 精度截断');
}

console.log('\n=== 乘除 ===');
{
  eq(D.mul(new D(2), new D(3)), new D(6), '2 * 3');
  eq(D.mul(new D(1e200), new D(1e200)), D.fromString('1e400'), '1e200 * 1e200 无溢出');
  eq(D.div(new D(10), new D(4)), new D(2.5), '10 / 4');
  eq(D.div(new D(1), new D(0)), new D(0), '除零返回 0');
  eq(D.mul(new D(0), new D(1e100)), new D(0), '0 乘大数');
  eq(D.div(new D(-6), new D(2)), new D(-3), '负数除法');
}

console.log('\n=== 幂与根 ===');
{
  eq(D.pow(new D(2), 10), new D(1024), '2^10');
  eq(D.pow(new D(10), 0), new D(1), 'x^0 = 1');
  eq(D.pow(new D(1e5), 2), D.fromString('1e10'), '1e5^2');
  ok(Math.abs(D.sqrt(new D(16)).toNumber() - 4) < 1e-9, 'sqrt(16) = 4');
  ok(Math.abs(D.pow(new D(100), 0.5).toNumber() - 10) < 1e-9, '100^0.5 = 10');
  eq(D.pow(new D(0), 5), new D(0), '0^5 = 0');
}

console.log('\n=== 比较 ===');
{
  ok(new D(1e100).gt(new D(1e99)), '1e100 > 1e99');
  ok(new D(-5).lt(new D(0)), '-5 < 0');
  ok(new D(0).eq(new D(0)), '0 == 0');
  ok(new D(1.5).lte(new D(1.5)), '1.5 <= 1.5');
  ok(new D(1e-300).gt(new D(0)), '1e-300 > 0');
  ok(D.cmp(new D(-1e50), new D(1)) < 0, '负数小数量级仍小于正数');
  eq(D.max(new D(1), new D(2)), new D(2), 'max');
  eq(D.min(new D(1), new D(2)), new D(1), 'min');

  // ---- 负数比较（回归）----
  // cmp 在同指数分支上曾经又乘了一次「负数翻符号」，把 -2600 < -1300 判成了 false。
  // 游戏里金钱/灵气都是正数，一直没暴露；股市出现负盈亏后才炸出来。
  // 指数不同的分支**确实需要**翻符号，所以两组都要测。
  ok(new D(-2600).lt(new D(-1300)), '-2600 < -1300（同指数）');
  ok(new D(-2600).lte(new D(-1300)), '-2600 <= -1300（同指数）');
  ok(new D(-1300).gt(new D(-2600)), '-1300 > -2600（同指数）');
  ok(new D(-1300).gte(new D(-2600)), '-1300 >= -2600（同指数）');
  ok(new D(-2600).eq(new D(-2600)), '-2600 == -2600');
  ok(new D(-2600).gte(new D(-2600)), '-2600 >= -2600（相等也要成立）');
  // 不同指数：负数时指数大 = 绝对值大 = 值更小
  ok(new D(-2.6e4).lt(new D(-1.3e3)), '-2.6e4 < -1.3e3（不同指数）');
  ok(new D(-2600).gt(new D(-13000)), '-2600 > -13000（不同指数）');
  ok(D.cmp(new D(-2600), new D(-1300)) === -1, 'cmp(-2600, -1300) = -1');
  ok(D.cmp(new D(-1300), new D(-2600)) === 1, 'cmp(-1300, -2600) = 1');
  eq(D.max(new D(-2600), new D(-1300)), new D(-1300), 'max(-2600, -1300) = -1300');
  eq(D.min(new D(-2600), new D(-1300)), new D(-2600), 'min(-2600, -1300) = -2600');
  // 异号
  ok(new D(-1).lt(new D(1)), '-1 < 1');
  ok(new D(1).gt(new D(-1)), '1 > -1');
  ok(new D(-1).lt(new D(0)), '-1 < 0（与零比）');
}

console.log('\n=== 对数 ===');
{
  ok(Math.abs(D.log10(new D(1000)) - 3) < 1e-12, 'log10(1000) = 3');
  ok(Math.abs(D.log10(D.fromString('1e400')) - 400) < 1e-9, 'log10(1e400) = 400');
  ok(Math.abs(D.ln(new D(Math.E)) - 1) < 1e-12, 'ln(e) = 1');
  ok(D.log10(new D(0)) === -Infinity, 'log10(0) = -Infinity');
}

console.log('\n=== 转换与边界 ===');
{
  ok(new D(0).floor().eq(0), 'floor(0)');
  ok(new D(3.7).floor().eq(3), 'floor(3.7) = 3');
  // 溢出保护：JS 数值字面量 1e400 本身就是 Infinity，
  // 应饱和为 1e308 而非静默归零（归零会造成难排查的数据丢失）
  const over = new D(1e400);
  ok(!over.isZero(), 'new D(1e400) 不静默归零（溢出饱和）', over.toString());
  ok(over.isFinite(), '饱和后的值仍有限');
  ok(over.eq(D.fromString('1e308')), 'new D(1e400) 饱和为 1e308', over.toString());

  ok(D.fromString('1e400').toNumber() === Infinity, 'fromString(1e400).toNumber() = Infinity');
  ok(D.fromString('1e400').isFinite(), 'fromString(1e400) 本身有限（指数可表示）');

  ok(new D(1e300).toNumber() === 1e300, 'toNumber 在 double 范围内正常');
  ok(new D(1e-400).toNumber() === 0, 'toNumber 下溢为 0');
  ok(new D(NaN).isZero(), 'new D(NaN) 视为 0');
  ok(new D(Infinity).eq(D.fromString('1e308')), 'new D(Infinity) 饱和为 1e308');
  ok(new D(-Infinity).eq(D.fromString('-1e308')), 'new D(-Infinity) 饱和为 -1e308');
  ok(D.floor(new D(1e100)).eq(new D(1e100)), '超大数 floor 保持（e 远超精度位）');
  ok(new D(0).isZero(), 'isZero');
  ok(new D(-1).isNeg(), 'isNeg');
}

console.log('\n=== 存档往返 ===');
{
  const samples = [0, 1, 10, 3.14, 1e10, 1.23e456, -7.5e-20, 9.99e299];
  let allOk = true;
  for (const v of samples) {
    const d = new D(v);
    const back = D.fromJSON(JSON.parse(JSON.stringify(d.toJSON())));
    if (!d.eq(back)) { allOk = false; console.log('     往返失败: ' + v + ' -> ' + back.toString()); }
  }
  ok(allOk, '8 个样本 JSON 往返一致');
}

// ============================================================
console.log('\n=== 浮点噪声清洗（回归） ===');
{
  // 4.8 + 2.4 在二进制下是 7.199999999999999，清洗位取 15 时误差会被当成
  // 有效数字留下，导致 480 + 240 ≠ 720。清洗位降到 14 后应当抹掉。
  // 公司的「维护费 = 原料 + 人工」正是这条路径。
  ok(D.add(new D(480), new D(240)).eq(new D(720)), '480 + 240 = 720',
    D.add(new D(480), new D(240)).toString());
  ok(D.add(new D(480), new D(240)).eq(720), '480 + 240 与字面量 720 相等');

  const pairs = [[100, 200], [480, 240], [7800, 3900], [2.5e4, 3.2e6]];
  let allExact = true;
  for (const [a, b] of pairs) {
    const d = D.add(new D(a), new D(b));
    if (!d.eq(new D(a + b))) {
      allExact = false;
      console.log('     偏差: ' + a + ' + ' + b + ' = ' + d.toString());
    }
  }
  ok(allExact, '常见整数加法结果精确');

  // 减法同样要干净
  ok(D.sub(new D(720), new D(240)).eq(new D(480)), '720 − 240 = 480',
    D.sub(new D(720), new D(240)).toString());
  ok(D.sub(new D(2400), new D(1680)).eq(new D(720)), '2400 − 1680 = 720');

  // 净收益率这类「乘完再减」的组合也不能留尾巴
  const gross = D.mul(new D(20), new D(120));
  const net = D.sub(gross, D.add(new D(480), new D(240)));
  ok(net.eq(new D(1680)), '20 × 120 − (480 + 240) = 1680', net.toString());

  // 除法后仍可精确回到原值
  const q = D.div(new D(1680), new D(20));
  ok(q.eq(new D(84)), '1680 / 20 = 84', q.toString());

  // 存档里不应出现 7.199999999999999 这类尾巴
  const dirt = D.add(new D(480), new D(240)).toJSON();
  ok(String(dirt.m).length <= 4, '存档尾数干净（m = ' + dirt.m + '）');
}

// ============================================================
console.log('\n=== 大小量级相减的抵消（已知特性，不是 bug） ===');
{
  // add 的做法是把两个数的尾数对齐到同一指数再做 double 加法：
  //     loScaled = lo.m / 10^diff ;  sum = hi.m + loScaled
  // 当 hi 与 lo 相差好几个数量级时，(hi + lo) − hi 属于**灾难性抵消**：
  // double 表示 hi.m 时的舍入误差（约 1e-16）会被 lo/hi 这个比例放大。
  //
  //   1e12 + 1.34e4 = 1.0000000134e12      ← 加法本身完全正确
  //   减回 1e12      = 1.33999999984979e4  ← 相对误差约 1e-10
  //
  // 这是「尾数 + 指数」这类表示法的固有代价（break_infinity.js 等同样如此），
  // 单纯调精度位数解决不了。所以：
  //   · 游戏里不要用 eq 比较这种「大数相减」的结果，要用相对误差
  //   · 界面上用 fmtBig 会 round，肉眼与玩法都感知不到
  //   · 本作实际会走到这条路径的地方是「金库极大时累加一笔小额收入」
  const a = new D(1e12);
  const b = new D(13400);
  const sum = a.add(b);
  ok(sum.gt(a), '大数加小数，和确实变大了');
  ok(sum.sub(a).gt(0), '减回来仍是正数（没有归零）');

  const rel = Math.abs(sum.sub(a).toNumber() - b.toNumber()) / b.toNumber();
  ok(rel < 1e-6, '抵消后的相对误差仍在 1e-6 以内', 'rel=' + rel.toExponential(2));
  ok(rel > 0, '但确实不精确 —— 因此不能用 eq 断言', 'rel=' + rel.toExponential(2));

  // 真正该记住的规律是**绝对误差**：不超过大数的若干个 ulp。
  // 也就是说「误差来自大数本身的表示精度，与小数的量级无关」。
  const absErr = Math.abs(sum.sub(a).toNumber() - b.toNumber());
  const bound = 8 * Number.EPSILON * a.toNumber();
  ok(absErr <= bound, '绝对误差不超过大数的 8 个 ulp',
    absErr.toExponential(2) + ' <= ' + bound.toExponential(2));

  // 量级接近时误差小得多，但同样不是位精确（对齐时尾数要做除法）
  const close = D.sub(new D(1e12), new D(999999000000));
  const closeRel = Math.abs(close.toNumber() - 1e6) / 1e6;
  ok(closeRel < 1e-9, '量级接近相减，相对误差更小', 'rel=' + closeRel.toExponential(2));

  // 差值超出精度时直接忽略较小者（这是有意为之的截断，避免无意义计算）
  const tiny = new D(1e30);
  ok(tiny.add(new D(1)).eq(tiny), '差值超出精度时小数被直接忽略');

  // 差值在精度范围内时必须保留
  ok(new D(1e12).add(new D(1e5)).gt(new D(1e12)), '精度范围内的增量不会被吞掉');
}

console.log('\n' + '='.repeat(46));
console.log('  通过  ' + pass + '   失败  ' + fail);
console.log('='.repeat(46) + '\n');
process.exit(fail > 0 ? 1 : 0);
