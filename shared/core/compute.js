/**
 * game-core · compute —— 设备与投向：设备造价（含 hardware 累积折扣）、实际算力拆解、设备被动收益、六条投向的产出与可用性。
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
  // 科技线计算
  // ============================================================

  /** 计算某设备的金钱单价（含 hardware 折扣 + 功法被动折扣） */
  C.deviceCost = function deviceCost(s, dev) {
    const owned = s.devices[dev.id] || 0;
    const base = new D(dev.cost).mul(D.pow(new D(dev.costGrowth), owned));
    const q = 1 + C.passiveBonus(s, 'deviceCost');
    return base.mul(C.hardwareCostFactor(s, dev)).mul(q > 0 ? q : 0.01);
  }

  /** 计算某设备的灵石单价（科技修仙设备的双造价） */
  C.deviceStoneCost = function deviceStoneCost(s, dev) {
    if (!dev.stoneCost) return new D(0);
    const owned = s.devices[dev.id] || 0;
    return new D(dev.stoneCost).mul(D.pow(new D(dev.costGrowth), owned));
  }

  /** 计算玩家拥有的设备算力总量（不含 AI 加成与神识乘区） */
  C.totalCompute = function totalCompute(s) {
    let total = new D(0);
    for (const dev of GAME.devices) {
      const n = s.devices[dev.id] || 0;
      if (n > 0) total = total.add(new D(dev.compute).mul(n));
    }
    return total;
  }

  /** 科技修仙设备的灵石产出（每秒） */
  C.deviceStoneOutput = function deviceStoneOutput(s) {
    let total = new D(0);
    for (const dev of GAME.devices) {
      if (!dev.stonePerSecond) continue;
      const n = s.devices[dev.id] || 0;
      if (n > 0) total = total.add(new D(dev.stonePerSecond).mul(n));
    }
    return total;
  }

  /**
   * 「实际算力」的构成拆解 —— 给界面显示用。
   *
   * 为什么要单拎出来：`实际算力` 不是「设备 + AI」这么简单，中间还有一层**兵解衰减**
   * （设备部分走 deviceComputeEffective）和两层乘区（神识、被动/淬体）。
   * 顶栏早先只显示 `总设备算力 + AI`，后期两者合计才 1e20，而标题写着 2.27e23 ——
   * 差 2000 倍，玩家只会以为数字算错了。拆解出来之后这一行能自己对上账：
   *   (device + ai) × mul === total === C.realComputeOf(s)
   */
  C.computeBreakdown = function computeBreakdown(s) {
    const device = C.deviceComputeEffective(s);
    const ai = (s.aiBonus instanceof D) ? s.aiBonus : D.fromJSON(s.aiBonus || 0);
    const shenshiMul = C.shenshiComputeMultiplier(s);
    const passiveMul = (1 + C.passiveBonus(s, 'compute')) * (1 + C.tribulationBonus(s, 'compute'));
    const mul = shenshiMul * passiveMul;
    const base = D.add(device, ai);
    return {
      device: device,
      ai: ai,
      mul: mul,
      base: base,
      total: base.mul(mul),
    };
  }

  /**
   * 实际算力 = (设备算力 × 转生衰减 + AI 加成) × 神识乘区 ×(1 + 功法被动算力加成)。
   * 神识放大了算力的「效果」，但不改变设备本身的算力。
   *
   * 两处刻意：
   *   a) 转生衰减只作用于**设备算力** —— AI 加成是「投向产出」，不是设备产能，不衰减。
   *   b) 神识乘区走 shenshiComputeMultiplier 的分层公式（境界线性 × 设备对数收敛），
   *      不再用「神识总量 × 固定系数」—— 那个口径在后期会爆炸。
   */
  C.realComputeOf = function realComputeOf(s) {
    return C.computeBreakdown(s).total;
  }

  /**
   * 设备被动收益（每秒，现实时间）。
   * 设备不是主要收入（工作是 / 公司是），但它是稳产底盘 ——
   * 精力耗尽、无法工作时，只有设备还在产钱。
   */
  C.autoIncome = function autoIncome(s) {
    // 走 deviceComputeEffective：设备被动收益与「实际算力」共用同一份转生衰减。
    // 早先这里直接读 totalCompute（原值），于是兵解之后 realCompute 掉下去了、
    // 但挂机金钱收入还是兵解前的量级 —— 玩家几分钟就能把设备全买回来，
    // 主线等于没重来。凡是「由设备算力派生出来的产出」都必须吃同一份衰减。
    const base = D.add(C.deviceComputeEffective(s), s.aiBonus);
    if (base.lte(0)) return new D(0);
    const scaled = D.pow(base, GAME.base.incomeExponent);
    return scaled.mul(GAME.base.autoIncomePerCompute);
  }

  /**
   * 灵气产出倍率 —— 所有灵气来源（工作 + 修仙投向）统一乘这个系数。
   *   1) 当前功法主属性（灵气吸收速度，随稀有度与等级提升）
   *   2) 神识（通过「功法修炼速度」影响灵气提升速度）
   *   3) 「功法增幅」投向的产出
   *   4) 功法被动 allOutput
   * 未习得功法时恒为 0（requireForSpirit）。
   */
  C.qiMultiplier = function qiMultiplier(s) {
    if (!C.spiritAllowed(s)) return 0;
    let m = 1;
    const tech = C.currentTech(s);
    if (tech) m += C.techMainQiSpeed(s, tech);

    // 神识乘区（分层口径）—— 与修炼速度同源，避免两处各有一套系数而漂移
    m *= C.shenshiCultivateMultiplier(s);

    // 道行 · 灵气亲和：永久 +8% / 级，加在主循环最核心的环节上
    m *= 1 + C.perkValue(s, 'qiSpeed');

    // v3.5：「功法算力投入」不再直接加灵气倍率 —— 它的产出换算成**功法经验**，
    // 只喂当前修炼的那本（见 stepTick 的功法经验段）。倍率由功法等级自己长。

    m *= 1 + C.passiveBonus(s, 'allOutput');
    // 渡劫淬体 · 灵气吸收：每渡过一次 +6%，乘在主循环最核心的环节上
    m *= 1 + C.tribulationBonus(s, 'qiSpeed');
    return m > 0 ? m : 0;
  }

  /** 可参与分配的投向（排除未解锁的锁定项） */
  C.allocatableInvestments = function allocatableInvestments(s) {
    return GAME.investments.filter((inv) => C.investmentAvailable(s, inv));
  }

  /**
   * 是否已习得**任意**功法。
   *
   * 注意与 `s.technique` 的区别：那个字段是「当前正在修炼的那一本」。
   * 早先「功法增幅」的解锁判定写的是 `!!s.technique`，于是出现两种错：
   *   a) 玩家明明已经习得几本功法、只是没在修炼（s.technique 被置空），
   *      界面却提示「未习得功法」；
   *   b) 兵解之后 s.technique 归零，条目跟着锁上，而功法本体其实还在。
   * 可用性应该只看「有没有学会」，不看「在不在修」。
   */
  C.hasAnyTechnique = function hasAnyTechnique(s) {
    if (!s || !s.learned) return false;
    for (const id of Object.keys(s.learned)) {
      if (s.learned[id]) return true;
    }
    return false;
  }

  /** 某投向是否所有条件都满足 */
  C.investmentAvailable = function investmentAvailable(s, inv) {
    if (!inv.locked) return true;
    // 「功法增幅」需要先习得功法（任意一本，不必正在修炼）
    if (inv.id === 'technique') return !!GAME.techniques.implemented && C.hasAnyTechnique(s);
    // 「工业产能」需要先成立公司 —— 没工厂就没有产能可分配
    if (inv.id === 'industry') {
      return !!GAME.company.implemented && C.companyFounded(s);
    }
    return false;
  }

  /** 某项投向的锁定原因（前端直接用，避免把「未成立公司」写成「未习得功法」） */
  C.investmentLockReason = function investmentLockReason(s, inv) {
    if (C.investmentAvailable(s, inv)) return '';
    if (inv.lockReason) return inv.lockReason;
    if (inv.id === 'technique') return '未习得功法';
    if (inv.id === 'industry') return '未成立公司';
    return '未解锁';
  }

  /**
   * 快捷投向调整（v3.6）：把某一个方向设为指定份额，**其余可用方向按比例
   * 分掉剩余额度** —— 合计恒为 1，不会把别的方向清零。
   * 内部复用 setAllocation 的归一化与锁定过滤，保证口径一致。
   */
  C.setAllocationShare = function setAllocationShare(s, id, share) {
    const target = GAME.investments.find((i) => i.id === id);
    if (!target) return { ok: false, msg: '投向不存在' };
    if (!C.investmentAvailable(s, target)) {
      return { ok: false, msg: '该方向当前不可用' };
    }
    const v = Math.max(0, Math.min(1, Number(share) || 0));
    const next = {};
    let others = 0;
    for (const inv of GAME.investments) {
      if (inv.id === id) continue;
      if (!C.investmentAvailable(s, inv)) continue;
      const cur = s.alloc[inv.id] || 0;
      next[inv.id] = cur;
      others += cur;
    }
    const rest = 1 - v;
    if (others > 1e-9) {
      const k = rest / others;
      for (const key of Object.keys(next)) next[key] = next[key] * k;
    }
    next[id] = v;
    return C.setAllocation(s, next);
  }

  /**
   * 计算某投资方向的实际产出：收益 = rate × compute^decay（decay < 1 递减）。
   */
  C.investOutput = function investOutput(s, inv) {
    if (!C.investmentAvailable(s, inv)) return new D(0);
    const ratio = s.alloc[inv.id] || 0;
    if (ratio <= 0) return new D(0);
    const compute = s.realCompute.mul(ratio);
    if (compute.lte(0)) return new D(0);
    const effective = D.pow(compute, inv.decay);
    return effective.mul(inv.rate);
  }

  /**
   * 投向的**可读产出** —— 换成本方向自己的量纲，专门给界面用。
   *
   * 为什么必须单独有这么一个函数：`investOutput` 返回的是「中间量」，
   * 每个方向的量纲都不一样（修仙是灵气、AI 是算力增量、功法是倍率加项）。
   * 早先界面直接 `fmt(investOutput) + ' / 秒'`，于是修仙方向显示的是
   * **没乘灵气倍率的裸值** —— 玩家看到「28.9/秒」对着五百万的突破阈值，
   * 自然觉得「这条线废了」，而实际入账要高几十倍。显示口径错比数值错更误导人。
   *
   *   修仙 → 灵气 / 现实秒（含灵气倍率；未习得功法时为 0，那本来就是硬门槛）
   *   AI   → 算力 / 现实秒（已乘 aiToCompute）
   *   金融 → 金钱 / 现实秒
   *   硬件 → 累积议价值的**每秒增长**（不是折扣本身 —— 折扣按设备价稀释，
   *          没有单一数字，界面用 hardwareCostFactor 按设备算）
   *   功法 → 功法经验 / 现实秒（v3.5：只喂当前修炼的那本）
   *   工业 → 工业算力池的规模
   */
  C.investOutputRate = function investOutputRate(s, inv) {
    const out = C.investOutput(s, inv).toNumber();
    const unit = inv.unit || '';
    if (unit === 'qi') return out * C.qiMultiplier(s);
    if (unit === 'compute') return out * C.num(inv.aiToCompute, 0);
    if (unit === 'discount') return out;
    if (unit === 'techexp') return out * C.techExpCfg().expPerInvest;
    if (unit === 'industrial') return C.industrialComputePool(s).toNumber();
    return out;
  }

  /**
   * hardware 累积折扣参数（v3.5）。配置缺失时给安全默认值。
   */
  C.hardwareAccumCfg = function hardwareAccumCfg() {
    const inv = GAME.investments.find((i) => i.id === 'hardware') || {};
    const a = inv.accum || {};
    return {
      maxRed: C.num(a.maxRed, 0.6),
      dilution: C.num(a.dilution, 0.5),
    };
  }

  /** 累积议价值（D） */
  C.investedHardwareOf = function investedHardwareOf(s) {
    return (s.investedHardware && typeof s.investedHardware.gt === 'function')
      ? s.investedHardware : new D(0);
  }

  /**
   * 单台设备的**造价系数**（1 = 原价，最低 1 − maxRed）。
   *
   *   折扣比例 = maxRed × X / (X + 该设备现价 × dilution)
   *
   * 用设备**自己的现价**做稀释基准：同样的累积值，对便宜设备接近软上限、
   * 对贵设备几乎不打折 —— 「跟随设备价格稀释」，后期不会免费，
   * 但只要持续投入，累积值总会追上当前档位的设备价。
   * 灵石造价不参与折扣（灵石是另一条资源线，见 deviceStoneCost）。
   */
  C.hardwareCostFactor = function hardwareCostFactor(s, dev) {
    const cfg = C.hardwareAccumCfg();
    const X = C.investedHardwareOf(s).toNumber();
    if (!(cfg.maxRed > 0) || !(X > 0) || !dev) return 1;
    const owned = s.devices[dev.id] || 0;
    const cost = new D(dev.cost).mul(D.pow(new D(dev.costGrowth), owned)).toNumber();
    if (!(cost > 0)) return 1;
    const red = cfg.maxRed * X / (X + cost * cfg.dilution);
    return Math.max(1 - cfg.maxRed, 1 - red);
  }


  return C;
});
