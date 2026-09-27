/**
 * game-core · shenshi —— 神识：境界基础 × 设备倍率（含转生衰减快照）× 功法被动；分层阻尼后的「有效强度」乘区（算力/修炼共用同一套系数）。
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

  // ============================================================
  // 神识
  // ============================================================

  /**
   * 境界提供的基础神识。
   * 含「道行加成 · 神识根基」—— 它直接加在境界基础值上，
   * 于是每一世的起跑线被永久抬高，后续所有以神识为输入的乘区都被它放大。
   */
  C.shenshiBase = function shenshiBase(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const base = (r && r.shenshi) || 1;
    // 道行 · 神识根基 是「点」，渡劫淬体是「百分比」—— 先加后乘，两者互不吞掉对方
    return (base + C.perkValue(s, 'shenshi')) * (1 + C.tribulationBonus(s, 'shenshi'));
  }

  /**
   * 设备对神识的放大倍率（科技修仙设备越靠后越猛）。
   * v3.4 快照模型：与 deviceComputeEffective 同一套逻辑 ——
   * 兵解时快照 raw 加成（baseShenshi），衰减只压快照那份，
   * 之后新买的设备按原值累加进倍率。
   */
  C.shenshiDeviceMultiplier = function shenshiDeviceMultiplier(s) {
    const rawBonus = C.rawShenshiBonus(s);
    if (rawBonus <= 0) return 1;
    const n = C.rebirthCount(s);
    if (n <= 0) return 1 + rawBonus;
    const st = C.rebirthState(s);
    const hasSnap = typeof st.baseShenshi === 'number' && st.baseShenshi >= 0;
    const base = (hasSnap && st.baseShenshi <= rawBonus) ? st.baseShenshi : rawBonus;
    const capped = C.rebirthAttenuate(s, new D(base)).toNumber();
    const growth = Math.max(0, rawBonus - base);
    return 1 + capped + growth;
  }

  /**
   * 神识总量 = 境界基础 × 设备倍率 ×(1 + 功法被动加成)。
   * **只用于界面展示**；实际乘区一律走 shenshiEffect 的分层公式，两者不混用。
   */
  C.totalShenshi = function totalShenshi(s) {
    const v = C.shenshiBase(s) * C.shenshiDeviceMultiplier(s) * (1 + C.passiveBonus(s, 'shenshi'));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /**
   * 把神识拆成两份 —— 分层阻尼的基础。
   *
   * 为什么必须拆：神识 = 境界基础 × 设备倍率，两个来源性质完全不同。
   *   境界那一份：随境界线性增长，也是「道行 · 神识根基」的载体，必须线性可感知。
   *   设备那一份：玩家可以无限堆（shenshiBonus 从 0.5 一路跃升到 120），是数值爆炸的唯一来源。
   * 拆开之后「境界管手感与道行回报、设备管规模上限」就解耦了，各自可独立调参。
   */
  C.shenshiParts = function shenshiParts(s) {
    const passive = 1 + C.passiveBonus(s, 'shenshi');
    /** 境界那一份（含道行加成），线性因子的载体 */
    const realmPart = C.shenshiBase(s) * passive;
    /** 设备倍率（≥ 1，已被转生折扣作用过） */
    const deviceMul = Math.max(1, C.shenshiDeviceMultiplier(s));
    return { realmPart: realmPart, deviceMul: deviceMul, passive: passive };
  }

  /**
   * 神识对某个乘区的**有效强度**（分层阻尼：境界线性 × 设备对数收敛）。
   *
   *     有效强度 = 境界神识 × perPointRealm × f(设备倍率)
   *     f(m)     = 1 + deviceLogK × ln(m)              // m ≥ 1
   *     乘区     = 1 + 有效强度
   *
   * 三个关键性质：
   *   a) f(1) = 1 —— **无设备时与旧口径完全一致**，前期手感不变；
   *   b) 设备按对数收敛 —— 后期不爆炸；
   *   c) 境界神识仍是线性因子 —— 道行买来的永久提升不被稀释。
   *
   * 为什么不把两者相加：相加会让「低境界 + 大量设备」时设备那一份脱离境界约束，
   * 反而比原线性口径更强（实测过：凡人 + 800 倍设备，相加给出 ×54，线性只有 ×17）。
   * 乘法保留了原设计「神识 = 境界基础 × 设备倍率」的语义，只把设备那一项换成收敛函数。
   */
  C.shenshiEffect = function shenshiEffect(s, perPointRealm, deviceLogK) {
    const p = C.shenshiParts(s);
    const f = 1 + deviceLogK * Math.log(p.deviceMul);
    const v = p.realmPart * perPointRealm * f;
    return Number.isFinite(v) ? v : 0;
  }

  /** 神识对「实际算力」的乘区 —— 引擎与界面共用同一口径，避免显示与实际不符 */
  C.shenshiComputeMultiplier = function shenshiComputeMultiplier(s) {
    const g = GAME.shenshi || {};
    const v = 1 + C.shenshiEffect(s, C.num(g.computePerPointRealm, 0.02), C.num(g.computeDeviceLogK, 8));
    return v > 0 ? v : 0;
  }

  /** 神识对「功法修炼速度」的乘区（修炼速度即灵气提升速度） */
  C.shenshiCultivateMultiplier = function shenshiCultivateMultiplier(s) {
    const g = GAME.shenshi || {};
    const v = 1 + C.shenshiEffect(s, C.num(g.cultivatePerPointRealm, 0.02), C.num(g.cultivateDeviceLogK, 8));
    return v > 0 ? v : 0;
  }

  /** raw 设备神识加成（不含衰减，不含境界 / 功法 / 渡劫那几份） */
  C.rawShenshiBonus = function rawShenshiBonus(s) {
    let bonus = 0;
    for (const dev of GAME.devices) {
      if (!dev.shenshiBonus) continue;
      const n = s.devices[dev.id] || 0;
      if (n > 0) bonus += dev.shenshiBonus * n;
    }
    return bonus;
  }

  return C;
});
