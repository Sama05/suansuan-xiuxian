/**
 * game-core · technique —— 功法：习得条件（境界/算力/行为成就）、熟练度与段位、独立经验等级、主属性、被动汇总。全部条件是状态的纯函数（前后端判定一致）。
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

  const MASTERY = C.MASTERY = GAME.techniques.mastery;
  const MAX_MASTERY = C.MAX_MASTERY = MASTERY[MASTERY.length - 1].need;
  const PERFECT_TIER = C.PERFECT_TIER = MASTERY.length - 1;
  // ============================================================
  // 功法系统
  // ============================================================

  C.techById = function techById(id) {
    if (!id) return null;
    return GAME.techniques.list.find((t) => t.id === id) || null;
  }

  C.rarityById = function rarityById(id) {
    return GAME.techniques.rarities.find((r) => r.id === id) || null;
  }

  /** 熟练度点数 → 段位索引 */
  C.masteryTierOf = function masteryTierOf(points) {
    let t = 0;
    for (let i = 0; i < MASTERY.length; i++) {
      if (points >= MASTERY[i].need) t = i;
    }
    return t;
  }

  /** 段位信息 */
  C.masteryInfo = function masteryInfo(tier) {
    const i = Math.max(0, Math.min(PERFECT_TIER, Math.floor(tier || 0)));
    return MASTERY[i];
  }

  /** 当前修炼的功法对象 */
  C.currentTech = function currentTech(s) {
    return s.technique ? C.techById(s.technique) : null;
  }

  /** 某功法的存档记录 */
  C.techRecord = function techRecord(s, id) {
    return s.learned[id] || null;
  }

  /** 是否已习得某功法 */
  C.techLearned = function techLearned(s, id) {
    return !!s.learned[id];
  }

  /**
   * 归一化功法的成就条件。
   * 配置里允许两种写法（等价）：
   *   cond: { devicesOwned: 2 }                 ← 紧凑式：键 = 类型，值 = 参数
   *   cond: { type: 'devicesOwned', n: 2 }      ← 展开式
   * 归一化后统一为展开式，判定与文案都只认这一种。
   */
  C.techCondOf = function techCondOf(tech) {
    const raw = tech && tech.cond;
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type) return raw;
    const keys = Object.keys(raw);
    if (keys.length !== 1) return null;
    const type = keys[0];
    const v = raw[type];
    switch (type) {
      case 'marketRevenue': case 'stockRealized': return { type: type, amount: v };
      case 'pressurePeak':                        return { type: type, peak: v };
      case 'warehouse':                           return { type: type, level: v };
      default:                                    return { type: type, n: v };
    }
  }

  /**
   * 功法解锁条件是否达成（v3.4 扩展）。
   *
   * 两条路径：
   *   a) 境界解锁 —— legacy 字段 `realm`（+ 可选 `compute`），除「天」级外
   *      每个稀有度至少一本走这条路；
   *   b) 行为成就 —— `cond: { type: ... }`，稀有度越高条件越苛刻
   *      （首次赚钱 → 累计金额 → 操纵市场 / 兵解 / 渡劫…）。
   *
   * 所有条件都是**状态的纯函数读数**：不用随机、不依赖 UI，
   * stepTick 与服务器各跑一份时判定必然一致。
   */
  C.techUnlockConditionMet = function techUnlockConditionMet(s, tech) {
    if (!tech) return false;
    if (s.realm < (tech.realm || 0)) return false;
    const need = tech.compute || 0;
    if (need > 0) {
      // 优先读缓存值：stepTick 在「功法习得检查」的前一步刚刷新 s.realCompute，
      // hydrate / buyDevice / 兵解也会同步刷新。41 本功法逐个调 realComputeOf
      // 全链重算（设备 × 衰减 × 神识 × 被动）是离线结算里的隐形大头。
      const rc = (s.realCompute && typeof s.realCompute.lt === 'function')
        ? s.realCompute : C.realComputeOf(s);
      if (rc.lt(need)) return false;
    }
    const c = C.techCondOf(tech);
    if (!c) return true;

    const jobs = s.totalJobs || 0;
    const devCount = (function () {
      let n = 0;
      for (const k of Object.keys(s.devices || {})) n += s.devices[k] || 0;
      return n;
    })();
    const company = s.company || {};
    const stock = s.stock || {};

    switch (c.type) {
      case 'jobsDone':      return jobs >= c.n;
      case 'devicesOwned':  return devCount >= c.n;
      case 'marketProfit':  return company.totalRevenue ? company.totalRevenue.gt(0) : false;
      case 'marketRevenue': return company.totalRevenue ? company.totalRevenue.gte(c.amount) : false;
      case 'stockProfit':   return stock.realized ? stock.realized.gt(0) : false;
      case 'stockRealized': return stock.realized ? stock.realized.gte(c.amount) : false;
      case 'trades':        return (stock.totalTrades || 0) >= c.n;
      case 'pressurePeak':  return (company.peakPressure || 0) >= c.peak;
      case 'companyCycles': return (company.cycles || 0) >= c.n;
      case 'warehouse':     return (company.warehouseLevel || 0) >= c.level;
      case 'tribulation':   return C.tribulationLevel(s) >= c.n;
      case 'rebirth':       return C.rebirthCount(s) >= c.n;
      case 'compute':       return C.realComputeCached(s).gte(c.n);
      default:              return false;
    }
  }

  /** s.realCompute 缓存优先的实际算力读数（条件判定高频路径，见 techUnlockConditionMet 注释） */
  C.realComputeCached = function realComputeCached(s) {
    return (s.realCompute && typeof s.realCompute.lt === 'function')
      ? s.realCompute : C.realComputeOf(s);
  }

  /**
   * 成就条件的**当前进度**（图鉴显示「12/15 次」用）。
   * 返回 { cur, need }；该条件没有可比数字时返回 null。
   */
  C.techCondProgress = function techCondProgress(s, tech) {
    const c = C.techCondOf(tech);
    if (!c) return null;
    const company = s.company || {};
    const stock = s.stock || {};
    let devCount = 0;
    for (const k of Object.keys(s.devices || {})) devCount += s.devices[k] || 0;
    switch (c.type) {
      case 'jobsDone':      return { cur: s.totalJobs || 0, need: c.n };
      case 'devicesOwned':  return { cur: devCount, need: c.n };
      case 'marketProfit':  return { cur: (company.totalRevenue && company.totalRevenue.gt(0)) ? 1 : 0, need: 1 };
      case 'marketRevenue': return { cur: company.totalRevenue ? company.totalRevenue.toNumber() : 0, need: c.amount };
      case 'stockProfit':   return { cur: (stock.realized && stock.realized.gt(0)) ? 1 : 0, need: 1 };
      case 'stockRealized': return { cur: stock.realized ? stock.realized.toNumber() : 0, need: c.amount };
      case 'trades':        return { cur: stock.totalTrades || 0, need: c.n };
      case 'pressurePeak':  return { cur: company.peakPressure || 0, need: c.peak };
      case 'companyCycles': return { cur: company.cycles || 0, need: c.n };
      case 'warehouse':     return { cur: company.warehouseLevel || 0, need: c.level };
      case 'tribulation':   return { cur: C.tribulationLevel(s), need: c.n };
      case 'rebirth':       return { cur: C.rebirthCount(s), need: c.n };
      case 'compute':       return { cur: C.realComputeOf(s).toNumber(), need: c.n };
      default:              return null;
    }
  }

  /** 成就条件的**文案**（图鉴与锁定原因共用） */
  C.techCondText = function techCondText(tech) {
    const c = C.techCondOf(tech);
    if (!c) return '';
    switch (c.type) {
      case 'jobsDone':      return '完成工作 ≥ ' + c.n + ' 次';
      case 'devicesOwned':  return '持有设备 ≥ ' + c.n + ' 台';
      case 'marketProfit':  return '在市场赚到第一笔钱';
      case 'marketRevenue': return '市场累计卖出收入 ≥ ' + C.fmtBig(c.amount);
      case 'stockProfit':   return '在股市赚到第一笔钱';
      case 'stockRealized': return '股市累计实现盈亏 ≥ ' + C.fmtBig(c.amount);
      case 'trades':        return '股市成交 ≥ ' + c.n + ' 笔';
      case 'pressurePeak':  return '市场抛压曾达到 ' + Math.round(c.peak * 100) + '%（清仓砸盘的痕迹）';
      case 'companyCycles': return '公司运转 ≥ ' + c.n + ' 个生产周期';
      case 'warehouse':     return '仓库扩容至 ' + c.level + ' 级';
      case 'tribulation':   return '渡劫淬体 ≥ ' + c.n + ' 层';
      case 'rebirth':       return '兵解 ≥ ' + c.n + ' 次';
      case 'compute':       return '实际算力 ≥ ' + C.fmtBig(c.n);
      default:              return '';
    }
  }

  /** 未习得的原因（前端展示用） */
  C.techLockedReason = function techLockedReason(s, tech) {
    if (!tech) return '';
    if (s.realm < (tech.realm || 0)) return '需达到「' + C.realmName(tech.realm) + '」';
    const need = tech.compute || 0;
    if (need > 0 && C.realComputeOf(s).lt(need)) return '需算力达到 ' + C.fmtBig(need);
    const c = tech.cond;
    if (c && !C.techUnlockConditionMet(s, tech)) {
      return '条件：' + (C.techCondText(tech) || '未知的功法条件');
    }
    return '';
  }

  /** 是否已拿到第一本功法（第一本需要先拥有个人电脑） */
  C.firstTechUnlocked = function firstTechUnlocked(s) {
    const fu = GAME.techniques.firstUnlock;
    if (!fu) return true;
    return (s.devices[fu.device] || 0) >= fu.count;
  }

  /** 习得一本功法（内部） */
  C.grantTechnique = function grantTechnique(s, id) {
    if (s.learned[id]) return false;
    s.learned[id] = { mastery: 0, tier: 0, passive: false, exp: 0, level: 0 };
    if (!s.technique) s.technique = id;
    return true;
  }

  /**
   * 检查并自动习得符合条件的功法。
   * 触发点：买了第一台个人电脑（第一本）、境界提升、算力跨过阈值。
   * @returns {string[]} 本次新习得的功法 id
   */
  C.learnTechniques = function learnTechniques(s) {
    const newly = [];
    const list = GAME.techniques.list;
    const first = list[0];

    // 第一本：需要先拥有指定设备（个人电脑）
    if (first && !s.learned[first.id] && C.firstTechUnlocked(s)) {
      if (C.grantTechnique(s, first.id)) newly.push(first.id);
    }

    // 后续：必须先有第一本，再满足境界 + 算力
    if (first && s.learned[first.id]) {
      for (const t of list) {
        if (s.learned[t.id]) continue;
        if (!C.techUnlockConditionMet(s, t)) continue;
        if (C.grantTechnique(s, t.id)) newly.push(t.id);
      }
    }

    return newly;
  }

  /** 累加熟练度并处理段位提升 / 被动转常驻。返回本次变化 */
  C.addMastery = function addMastery(s, id, gain) {
    const rec = s.learned[id];
    if (!rec || !(gain > 0)) return null;
    const before = rec.tier;
    rec.mastery = Math.min(MAX_MASTERY, rec.mastery + gain);
    const tier = Math.max(rec.tier, C.masteryTierOf(rec.mastery));
    rec.tier = Math.min(PERFECT_TIER, tier);
    let passiveTurnedOn = false;
    if (rec.tier >= PERFECT_TIER && !rec.passive) {
      rec.passive = true;
      passiveTurnedOn = true;
    }
    return {
      tier: rec.tier,
      mastery: rec.mastery,
      tierUp: rec.tier > before,
      passiveTurnedOn: passiveTurnedOn,
    };
  }

  /** 修炼速度（熟练度 / 现实秒）—— 受神识增幅，而修炼速度就是灵气提升速度 */
  /**
   * 功法修炼速度 = 基础速度 × 神识乘区（分层口径，与算力共用同一套系数）。
   * 修炼速度就是灵气提升速度 —— 于是「神识 → 算力」与「神识 → 修炼」两条路
   * 由同一套阻尼约束，不会出现「堵了一条、另一条照样爆」。
   */
  C.cultivateSpeed = function cultivateSpeed(s) {
    const c = GAME.techniques.cultivate;
    return C.num(c.pointsPerSecond, 1) * C.shenshiCultivateMultiplier(s);
  }

  /** 参悟一次的灵气消耗 = 当前境界突破所需灵气 × 比例 */
  C.comprehendCost = function comprehendCost(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const need = (r && r.need) || 100;
    return new D(need).mul(GAME.techniques.comprehend.qiCostRatio);
  }

  /** 参悟一次获得的熟练度 = 当前段位增量 × 比例 */
  C.comprehendGain = function comprehendGain(tier) {
    const i = Math.max(0, Math.min(PERFECT_TIER - 1, Math.floor(tier || 0)));
    const delta = MASTERY[i + 1].need - MASTERY[i].need;
    return delta * GAME.techniques.comprehend.gainRatio;
  }

  /**
   * 功法等级（v3.5）：**每本独立**，存在 `learned[id].level`，由经验累积升级，
   * 不再由总算力全局换算 —— 否则「换一本功法 = 换一个等级」，玩家没法选择主修。
   */
  C.techLevel = function techLevel(s, tech) {
    if (!tech || !s.learned[tech.id]) return 0;
    const rec = s.learned[tech.id];
    return rec.level > 0 ? rec.level : 0;
  }

  /** 功法经验配置（缺失给安全默认值） */
  C.techExpCfg = function techExpCfg() {
    return GAME.techniques.level || {};
  }

  /** 升到 lv+1 级需要的经验 */
  C.techExpNeed = function techExpNeed(lv) {
    const c = C.techExpCfg();
    return C.num(c.expBase, 30) * Math.pow(C.num(c.expGrowth, 1.35), Math.max(0, lv || 0));
  }

  /**
   * 挂机基础经验速率（exp / 现实秒）= expPerLog10 × log10(1 + 实际算力)。
   * 算力跨 16 个数量级，取对数后是 0~16 的温和数字 —— 算力越高升得越快，
   * 但不会出现「算力翻倍等级翻倍」的爆炸；配合 expGrowth 的指数需求，
   * 等级成长是「越往后越慢、但永远在走」。
   */
  C.techBaseExpRate = function techBaseExpRate(s) {
    const c = C.techExpCfg();
    const comp = C.realComputeOf(s).toNumber();
    if (!(comp > 0)) return 0;
    return C.num(c.expPerLog10, 1) * Math.log10(1 + comp);
  }

  /**
   * 某本功法当前的经验速率 —— **只有当前修炼的那本 > 0**。
   * 挂机基础（随算力）+ 功法算力投入（随投向份额）。
   */
  C.techExpRateOf = function techExpRateOf(s, tech) {
    if (!tech || s.technique !== tech.id) return 0;
    let rate = C.techBaseExpRate(s);
    const inv = GAME.investments.find((i) => i.id === 'technique');
    if (inv && C.investmentAvailable(s, inv)) {
      rate += C.investOutput(s, inv).toNumber() * C.num(C.techExpCfg().expPerInvest, 1);
    }
    return rate;
  }

  /**
   * 累加功法经验并处理升级（可一段 tick 连升多级）。返回升了的级数。
   * 经验只进 `id` 这一本 —— 当前修炼哪本，哪本吃经验。
   */
  C.addTechExp = function addTechExp(s, id, gain) {
    const rec = s.learned[id];
    if (!rec || !(gain > 0)) return 0;
    rec.exp = (rec.exp || 0) + gain;
    let ups = 0;
    let guard = 0;
    while (guard++ < 1000) {
      const need = C.techExpNeed(rec.level || 0);
      if (rec.exp < need) break;
      rec.exp -= need;
      rec.level = (rec.level || 0) + 1;
      ups += 1;
    }
    return ups;
  }

  /** 某功法主属性强度（灵气吸收速度加成，纯小数）。随等级与稀有度提升，无上限 */
  C.techMainQiSpeed = function techMainQiSpeed(s, tech) {
    if (!tech) return 0;
    const r = C.rarityById(tech.rarity);
    const base = r ? r.mainQiSpeed : 0;
    const lv = C.techLevel(s, tech);
    // 熟练度段位也吃主属性：入门 0.5 → 圆满 1.0。
    // 没有这一层，段位在修满（拿被动）之前只给一行文字，修炼毫无正反馈。
    const m = GAME.techniques.masteryMain || {};
    const mBase = C.num(m.base, 0.5);
    const mPer = C.num(m.perTier, 0.1);
    const rec = s.learned[tech.id];
    const tier = rec ? Math.max(0, Math.min(5, Math.floor(C.num(rec.tier, 0)))) : 0;
    return base * (1 + lv * GAME.techniques.level.mainPerLevel) * (mBase + mPer * tier);
  }

  /** 功法列表 + 各自状态（前端渲染用） */
  C.techniqueList = function techniqueList(s) {
    return GAME.techniques.list.map((t) => {
      const rec = s.learned[t.id] || null;
      const r = C.rarityById(t.rarity);
      return {
        id: t.id,
        name: t.name,
        rarity: t.rarity,
        rarityName: r ? r.name : '',
        rarityLevel: r ? r.level : 0,
        school: t.school,
        desc: t.desc,
        realm: t.realm || 0,
        computeNeed: t.compute || 0,
        passive: t.passive || {},
        learned: !!rec,
        active: s.technique === t.id,
        level: rec ? C.techLevel(s, t) : 0,
        mastery: rec ? rec.mastery : 0,
        masteryTier: rec ? rec.tier : 0,
        masteryTierName: rec ? C.masteryInfo(rec.tier).name : C.masteryInfo(0).name,
        masteryNeed: rec && rec.tier < PERFECT_TIER ? MASTERY[rec.tier + 1].need : MAX_MASTERY,
        passiveActive: rec ? rec.passive : false,
        mainQiSpeed: rec ? C.techMainQiSpeed(s, t) : 0,
        lockedReason: rec ? '' : C.techLockedReason(s, t),
        /** v3.5：独立经验进度（图鉴与功法阁都用） */
        exp: rec ? (rec.exp || 0) : 0,
        expNeed: rec ? C.techExpNeed(rec.level || 0) : 0,
        expRate: rec ? C.techExpRateOf(s, t) : 0,
        /** 成就条件的展示文案（图鉴用；境界/算力解锁的功法为空串） */
        condText: C.techCondText(t),
        /** 成就条件进度（图鉴显示 12/15 用；无可数字化的条件为 null） */
        condProgress: rec ? null : C.techCondProgress(s, t),
        /** 图鉴用完整解锁文案：境界 / 算力 / 行为成就三合一 */
        unlockText: (function () {
          const parts = [];
          if (t.realm) parts.push('境界 · ' + C.realmName(t.realm));
          if (t.compute) parts.push('算力 ≥ ' + C.fmtBig(t.compute));
          const ct = C.techCondText(t);
          if (ct) parts.push(ct);
          if (!t.realm && !t.compute && !t.cond) parts.push('拥有第一台个人电脑');
          return parts.join('　+　');
        })(),
      };
    });
  }

  /** 累加所有「已修满」功法的被动属性值（切换功法不会消失） */
  C.passiveBonus = function passiveBonus(s, key) {
    let sum = 0;
    for (const id of Object.keys(s.learned)) {
      const rec = s.learned[id];
      if (!rec || !rec.passive) continue;
      const t = C.techById(id);
      if (!t || !t.passive) continue;
      const v = t.passive[key];
      if (typeof v === 'number') sum += v;
    }
    return sum;
  }


  return C;
});
