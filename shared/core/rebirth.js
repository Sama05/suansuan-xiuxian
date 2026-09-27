/**
 * game-core · rebirth —— 转生（兵解）与渡劫：道行结算、重置清单、转生衰减（幂 + 绝对上限 + v3.4 快照）、道行加成、渡劫成功率与确定性掷点、被动兵解。
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
  // 转生（兵解）
  // ============================================================

  C.rebirthCfg = function rebirthCfg() { return GAME.rebirth || {}; }

  /** 转生状态（容错读取，老存档没有这个字段时给一份默认值） */
  C.rebirthState = function rebirthState(s) {
    if (!s) return { count: 0, dao: 0, daoTotal: 0, perks: {}, history: [] };
    if (!s.rebirth) s.rebirth = { count: 0, dao: 0, daoTotal: 0, perks: {}, history: [] };
    if (!s.rebirth.perks) s.rebirth.perks = {};
    if (!Array.isArray(s.rebirth.history)) s.rebirth.history = [];
    /**
     * 转生衰减快照（v3.4）：兵解那一刻的设备存量。
     *   baseCompute  兵解时 raw 设备算力（D）
     *   baseShenshi  兵解时 raw 设备神识加成（m − 1，number）
     * 衰减只作用于这份快照；**之后新买的设备全额累加** ——
     * 否则「买多少设备属性栏都不动」，买设备这件事在转生后失去意义。
     * 旧存档没有这两个字段时，在 hydrate 里补拍。
     */
    if (!s.rebirth.baseCompute) s.rebirth.baseCompute = null;
    if (typeof s.rebirth.baseShenshi !== 'number') s.rebirth.baseShenshi = null;
    return s.rebirth;
  }

  /** 已完成的兵解次数 */
  C.rebirthCount = function rebirthCount(s) {
    return Math.max(0, Math.floor(C.rebirthState(s).count || 0));
  }

  /**
   * 指定「已兵解次数」对应的转生**衰减指数**。
   *
   *   指数(0)  = 1.00                          ← 还没兵解过，原值
   *   指数(n≥1) = min(base + perRun ×(n − 1), cap)
   *
   * ⚠️ 「0 次 = 原值」这一条是**必须**的。把 base 当成任何时刻的指数，
   * 会让所有没兵解过的玩家一开始算力就被开方 —— 这个坑踩过一次。
   */
  C.rebirthFactorAt = function rebirthFactorAt(n) {
    const c = C.rebirthCfg().deviceDiscount || {};
    const base = C.num(c.base, 0.5);
    const per = C.num(c.perRun, 0.03);
    const cap = C.num(c.cap, 0.75);
    const k = Math.max(0, Math.floor(C.num(n, 0)));
    if (k <= 0) return 1;
    const v = base + per * (k - 1);
    // 抹掉浮点尾巴（0.5 + 0.03 → 0.53），界面直接显示时更干净
    return Math.max(0.05, Math.min(cap, Math.round(v * 1e4) / 1e4));
  }

  // ============================================================
  // 渡劫 —— 突破境界的门槛
  // ============================================================

  C.tribulationCfg = function tribulationCfg() { return GAME.tribulation || {}; }

  C.tribulationState = function tribulationState(s) {
    const t = s.tribulation;
    if (!t || typeof t !== 'object') {
      s.tribulation = { level: 0, attempts: 0, failures: 0, won: null, lost: null };
    } else {
      t.level = Math.max(0, Math.floor(C.num(t.level, 0)));
      t.attempts = Math.max(0, Math.floor(C.num(t.attempts, 0)));
      t.failures = Math.max(0, Math.floor(C.num(t.failures, 0)));
      if (t.won === undefined) t.won = null;
      if (t.lost === undefined) t.lost = null;
    }
    return s.tribulation;
  }

  /** 渡劫淬体层数（永久，跨兵解保留） */
  C.tribulationLevel = function tribulationLevel(s) {
    return Math.min(
      Math.max(0, Math.floor(C.num(C.tribulationCfg().maxLevel, 40))),
      C.tribulationState(s).level
    );
  }

  /**
   * 渡劫淬体提供的永久加成（按 key，与 `techniques.list[].passive` 同名同义）。
   * 之所以沿用同一套键名：两套加成在同一个乘区里并排相加，
   * 不需要再造一层「渡劫乘区」，也就不会出现两个乘区互相打架。
   */
  C.tribulationBonus = function tribulationBonus(s, key) {
    const per = C.num((C.tribulationCfg().boon || {})[key], 0);
    if (!per) return 0;
    return C.tribulationLevel(s) * per;
  }

  /** 该境界的「基准算力」—— 渡劫准备度里算力冗余的参照点 */
  C.tribulationComputeBase = function tribulationComputeBase(s) {
    const arr = (C.tribulationCfg().prepare || {}).computeBase || [];
    const v = arr[Math.min(s.realm, Math.max(0, arr.length - 1))];
    return C.num(v, 1e2);
  }

  /** 已修满（被动常驻）的功法数量 —— 渡劫准备度的一项 */
  C.perfectedTechniqueCount = function perfectedTechniqueCount(s) {
    let n = 0;
    for (const id of Object.keys(s.learned || {})) {
      const rec = s.learned[id];
      if (rec && rec.passive) n += 1;
    }
    return n;
  }

  /**
   * 渡劫成功率，以及拆解出来的每一项加成（界面要逐项显示，不能只给一个总数 ——
   * 玩家得知道「再堆一点算力就能多 3%」）。
   *
   *     成功率 = clamp(基础 + 算力冗余 + 功法造诣 + 道行底蕴, minRate, maxRate)
   *
   * 三项准备各自封顶，`maxRate` 也不给到 1 —— **渡劫永远有风险**，
   * 否则整个系统就退化成一个需要多点一次的按钮。
   */
  C.tribulationOdds = function tribulationOdds(s) {
    const cfg = C.tribulationCfg();
    const p = cfg.prepare || {};
    const rates = cfg.baseRate || [];
    const idx = Math.min(s.realm, Math.max(0, rates.length - 1));
    const base = C.num(rates[idx], 0.8);

    // 算力冗余：每高出基准 10 倍 +computePerDecade
    const c = s.realCompute.toNumber();
    const cb = C.tribulationComputeBase(s);
    const decades = (c > 0 && cb > 0) ? Math.log10(c / cb) : 0;
    const computeAdd = Math.max(0, Math.min(
      C.num(p.computeCap, 0.15), decades * C.num(p.computePerDecade, 0.03)
    ));

    // 功法造诣：每本修满的功法
    const perfect = C.perfectedTechniqueCount(s);
    const perfectAdd = Math.min(C.num(p.perfectCap, 0.10), perfect * C.num(p.perfectPer, 0.02));

    // 道行底蕴：累计道行
    const daoTotal = C.num(C.rebirthState(s).daoTotal, 0);
    const daoAdd = Math.min(
      C.num(p.daoCap, 0.08),
      (daoTotal / Math.max(1, C.num(p.daoPer, 2000))) * C.num(p.daoPerBonus, 0.01)
    );

    const raw = base + computeAdd + perfectAdd + daoAdd;
    const rate = Math.max(C.num(cfg.minRate, 0.05), Math.min(C.num(cfg.maxRate, 0.95), raw));

    return {
      realm: s.realm,
      nextRealm: s.realm + 1,
      base: base,
      computeAdd: computeAdd,
      perfectAdd: perfectAdd,
      daoAdd: daoAdd,
      decades: decades,
      computeBase: cb,
      perfectCount: perfect,
      daoTotal: daoTotal,
      rate: rate,
    };
  }

  /** 灵气是否已满、且还有下一境界可渡 */
  C.tribulationReady = function tribulationReady(s) {
    if (!C.tribulationCfg().implemented) return false;
    const t = C.nextRealm(s);
    if (!t || !t.next || !t.need) return false;
    return s.qi.gte(t.need);
  }

  /**
   * 渡劫结果的伪随机数。
   *
   * ⚠️ **不能用 Math.random()。** 前端每 100ms 跑一次 tick、服务端在离线结算里
   * 也跑同一份 tick —— 两端必须算出同一个结果，否则屏幕上「渡劫失败、一切归零」
   * 而服务器存档里还留着元婴，两边会永久打架（这个项目在转生那轮已经吃过一次
   * 「两端各算一遍」的亏）。所以结果必须是**状态的纯函数**。
   *
   * 用 (境界, 已尝试次数, 淬体层数, 游戏内时间分钟数) 做散列：
   *   - 同一份状态，两端算出的值一定相同；
   *   - 每次尝试 `attempts` 都会 +1，所以失败之后再点一次得到的是**另一个**结果，
   *     不存在「卡在必死的那一次」；
   *   - 玩家无法在点之前预知结果（要预知就得复刻整个散列，而这并不可行 ——
   *     更重要的是，知道了也改变不了什么，结果只由状态决定）。
   */
  C.tribulationRoll = function tribulationRoll(s) {
    const st = C.tribulationState(s);
    let h = 2166136261;
    const feed = (x) => {
      let v = Math.floor(C.num(x, 0)) >>> 0;
      for (let i = 0; i < 4; i++) {
        h ^= (v & 0xff);
        h = Math.imul(h, 16777619) >>> 0;
        v >>>= 8;
      }
    };
    feed(s.realm);
    feed(st.attempts);
    feed(st.level);
    feed(Math.floor((s.playTime || 0) / 60));
    feed(C.rebirthCount(s) * 7919);
    // 取 [0,1)
    return (h >>> 0) / 4294967296;
  }

  /** 渡劫淬体的效果清单（界面用） */
  C.tribulationBoonSummary = function tribulationBoonSummary(s, level) {
    const boon = C.tribulationCfg().boon || {};
    const lv = (level === undefined) ? C.tribulationLevel(s) : Math.max(0, Math.floor(C.num(level, 0)));
    const label = {
      qiSpeed: '灵气吸收',
      compute: '实际算力',
      money: '工作金钱',
      shenshi: '境界基础神识',
      energyMax: '精力上限',
      stone: '灵石产出',
    };
    const out = [];
    for (const k of Object.keys(boon)) {
      const per = C.num(boon[k], 0);
      if (!per) continue;
      out.push({
        key: k,
        name: label[k] || k,
        per: per,
        value: per * lv,
      });
    }
    return out;
  }

  /** 渡劫面板要展示的全部信息（前端一次拿齐，不需要自己拼） */
  C.tribulationSummary = function tribulationSummary(s) {
    const cfg = C.tribulationCfg();
    if (!cfg.implemented) return null;
    const st = C.tribulationState(s);
    const t = C.nextRealm(s);
    const odds = C.tribulationOdds(s);
    const maxLevel = Math.max(0, Math.floor(C.num(cfg.maxLevel, 40)));
    return {
      implemented: true,
      level: C.tribulationLevel(s),
      maxLevel: maxLevel,
      attempts: st.attempts,
      failures: st.failures,
      /** 自动渡劫开关 */
      auto: s.autoTribulation !== false,
      /** 是否能立刻渡劫 */
      ready: C.tribulationReady(s),
      /** 已至最高境界（无劫可渡） */
      atMax: !t || !t.next,
      need: (t && t.need) ? t.need.toJSON() : null,
      progress: s.realmProgress ? s.realmProgress.toNumber() : 0,
      odds: odds,
      boons: C.tribulationBoonSummary(s),
      /** 下一次成功之后的层数 */
      nextLevel: Math.min(maxLevel, C.tribulationLevel(s) + 1),
      /** 最近一次结果（一次性提示） */
      won: st.won,
      lost: st.lost,
      passiveRules: {
        belowRealm: C.num((cfg.passiveRules || {}).belowRealm, 4),
        fullWipeBelow: (cfg.passiveRules || {}).fullWipeBelow !== false,
      },
    };
  }

  /**
   * 渡劫 —— 灵气满格时的唯一出口。
   *
   *   成功：消耗灵气、境界 +1、渡劫淬体 +1 层（永久），并补齐精力
   *   失败：**被动兵解** —— 这一世作废。元婴以下连设备与功法一起清掉。
   *
   * 注意它**不产生随机数**（见 tribulationRoll 的注释），
   * 所以前后端各自跑一次 tick 会得到完全一致的结局。
   */
  C.doTribulation = function doTribulation(s) {
    const cfg = C.tribulationCfg();
    if (!cfg.implemented) return { ok: false, msg: '渡劫系统未开放' };

    const t = C.nextRealm(s);
    if (!t || !t.next) return { ok: false, msg: '已至最高境界，无劫可渡' };
    if (!t.need || s.qi.lt(t.need)) return { ok: false, msg: '灵气未满，引不动天劫' };

    const st = C.tribulationState(s);
    const odds = C.tribulationOdds(s);
    st.attempts += 1;
    st.won = null;
    st.lost = null;

    const roll = C.tribulationRoll(s);

    if (roll >= odds.rate) {
      // ---- 失败：被动兵解 ----
      st.failures += 1;
      const info = {
        realm: s.realm,
        realmName: C.realmName(s.realm),
        rate: odds.rate,
        roll: roll,
        at: s.playTime,
      };
      const rb = C.doRebirth(s, 'passive');
      st.lost = {
        realm: info.realm,
        realmName: info.realmName,
        rate: info.rate,
        fullWipe: !!rb.fullWipe,
        dao: rb.dao || 0,
        at: info.at,
      };
      return {
        ok: true,
        success: false,
        rate: odds.rate,
        roll: roll,
        lostRealm: info.realm,
        lostRealmName: info.realmName,
        dao: rb.dao || 0,
        fullWipe: !!rb.fullWipe,
      };
    }

    // ---- 成功：境界 +1、淬体 +1 层 ----
    const maxLevel = Math.max(0, Math.floor(C.num(cfg.maxLevel, 40)));
    const oldMaxE = C.maxEnergy(s);
    s.qi = s.qi.sub(t.need);
    s.realm += 1;
    st.level = Math.min(maxLevel, st.level + 1);
    st.won = {
      realm: s.realm,
      realmName: C.realmName(s.realm),
      level: st.level,
      rate: odds.rate,
      at: s.playTime,
    };

    // 境界抬升 → 精力上限变高 → 按新上限补一段（与旧自动突破的行为一致）
    const newMaxE = C.maxEnergy(s);
    if (s.energy < newMaxE) s.energy = Math.min(newMaxE, s.energy + (newMaxE - oldMaxE));

    s.realmProgress = new D(0);
    s.shenshi = C.totalShenshi(s);
    s.realCompute = C.realComputeOf(s);

    return {
      ok: true,
      success: true,
      rate: odds.rate,
      roll: roll,
      realm: s.realm,
      realmName: C.realmName(s.realm),
      level: st.level,
      maxLevel: maxLevel,
      boons: C.tribulationBoonSummary(s),
    };
  }

  /**
   * 切换「自动渡劫」。
   *
   * 关掉之后，灵气满格也不会自己硬闯 —— 界面会停在「待渡劫」，
   * 让玩家先把算力堆厚（算力冗余最多能把成功率抬 15 个百分点）再动手。
   * 这是唯一一个能改变渡劫结果的玩家决策，所以开关必须显式存在。
   */
  C.setAutoTribulation = function setAutoTribulation(s, on) {
    s.autoTribulation = !!on;
    return { ok: true, auto: s.autoTribulation };
  }

  /**
   * 暂停 / 恢复游戏时间。
   *
   * 注意语义：停的是**游戏内时间**（工作进度、日期、行情推演的基础），
   * 不是整个游戏 —— 精力恢复、算力投向、公司周期、功法修炼都挂现实时间，
   * 照常推进。所以「暂停」是「我不赶时间了」，不是「世界冻结」。
   */
  C.setTimePaused = function setTimePaused(s, paused) {
    s.timePaused = !!paused;
    return { ok: true, paused: s.timePaused };
  }

  /**
   * 转生衰减 —— 兵解后「设备算力」与「设备神识倍率」被压掉几个数量级。
   *
   *     有效值 = min(原值 ^ 指数, 绝对上限)
   *
   * 为什么是幂而不是「乘一个比例」：见 game-config 的 rebirth.deviceDiscount 注释 ——
   * 本作算力跨 16 个数量级，而境界阈值只到 5×10^10。实测线性折扣 0.35 下，
   * 元婴玩家兵解后 **0.1 秒内就重新突破回元婴**。线性折扣对跨数量级的数值没有刹车力。
   *
   * 为什么还要再加一道绝对上限：开方只削「相对倍数」。实测开方之后算力仍有 2×10^7，
   * 于是 2 秒又能回到元婴。绝对上限处理的是「前世设备越多、绝对值越高」——
   * **不管前世多强，这一世都从同一水平线开始**，这才是转生该有的语义。
   * 上限本身随兵解次数放宽（每世半个数量级），「越转越快」体现在那里。
   *
   * 为什么只作用在这两项：境界基础神识本来就归零重来（不需要再压）；
   * 功法被动是永久资产（不压，否则「修满转常驻」的意义被削弱）。
   *
   * @param {boolean} useCap 是否夹绝对上限（设备算力夹；神识倍率不夹 ——
   *                         它本来就被境界基础值线性缩放，境界归零已经压过一轮了）
   */
  C.rebirthAttenuate = function rebirthAttenuate(s, value, useCap) {
    const n = C.rebirthCount(s);
    if (n <= 0) return value;
    if (!value || typeof value.gt !== 'function' || !value.gt(0)) return value;
    let out = D.pow(value, new D(C.rebirthFactorAt(n)));
    if (useCap) {
      const capBase = C.num(C.rebirthCfg().deviceComputeCapBase, 0);
      const capPer = C.num(C.rebirthCfg().deviceComputeCapPerRun, 0);
      if (capBase > 0) {
        const cap = capBase * Math.pow(10, capPer * (n - 1));
        const capD = new D(cap);
        if (out.gt(capD)) out = capD;
      }
    }
    return out;
  }

  /** 当前生效的转生衰减指数（1 = 不衰减）。界面与引擎共用同一口径。 */
  C.rebirthDiscount = function rebirthDiscount(s) {
    return C.rebirthFactorAt(C.rebirthCount(s));
  }

  /** 当前生效的转生算力上限（未兵解时为 0 = 不限制） */
  C.rebirthComputeCap = function rebirthComputeCap(s) {
    const n = C.rebirthCount(s);
    if (n <= 0) return 0;
    const capBase = C.num(C.rebirthCfg().deviceComputeCapBase, 0);
    if (!(capBase > 0)) return 0;
    return capBase * Math.pow(10, C.num(C.rebirthCfg().deviceComputeCapPerRun, 0) * (n - 1));
  }

  /**
   * 设备算力的**有效值**（已应用转生衰减与上限）—— 界面与引擎共用。
   *
   * v3.4 快照模型：衰减只作用于「兵解那一刻的设备存量」（baseCompute），
   * 之后新买的设备按原值全额累加：
   *
   *     有效算力 = min(快照存量 ^ f, cap) + max(0, 现在的存量 − 快照存量)
   *
   * 旧模型把「现在的存量」整体开方，导致兵解后买设备几乎不加算力
   * （买 1.2e10 只多出 ~1.1e5 的一半）—— 属性栏「买多少都不动」就是这么来的。
   */
  C.deviceComputeEffective = function deviceComputeEffective(s) {
    const raw = C.totalCompute(s);
    const n = C.rebirthCount(s);
    if (n <= 0) return raw;
    const st = C.rebirthState(s);
    const hasSnap = st.baseCompute && typeof st.baseCompute.gt === 'function';
    // 兼容旧存档：没有快照（或快照比现在还大，理论不该发生）→ 以现在为基准补拍
    const base = (hasSnap && !st.baseCompute.gt(raw)) ? st.baseCompute : raw;
    const capped = C.rebirthAttenuate(s, base, true);
    const growth = raw.gt(base) ? raw.sub(base) : new D(0);
    return capped.add(growth);
  }

  /** 兵解时快照设备存量（在 doRebirth 的重置完成之后调用） */
  C.snapshotRebirthBase = function snapshotRebirthBase(s) {
    const st = C.rebirthState(s);
    st.baseCompute = C.totalCompute(s);
    st.baseShenshi = C.rawShenshiBonus(s);
  }


  C.perkById = function perkById(id) {
    return (C.rebirthCfg().perks || []).find((p) => p.id === id) || null;
  }

  /** 某项道行加成的当前等级 */
  C.perkLevel = function perkLevel(s, id) {
    return Math.max(0, Math.floor(C.rebirthState(s).perks[id] || 0));
  }

  /** 某项道行加成的当前累计效果（数值型） */
  C.perkValue = function perkValue(s, id) {
    const p = C.perkById(id);
    if (!p) return 0;
    return C.perkLevel(s, id) * C.num(p.per, 0);
  }

  /** 升下一级需要的道行（已满级返回 0） */
  C.perkCost = function perkCost(s, id) {
    const p = C.perkById(id);
    if (!p) return 0;
    const lv = C.perkLevel(s, id);
    if (lv >= C.num(p.maxLevel, 0)) return 0;
    return Math.ceil(C.num(p.cost, 0) * Math.pow(C.num(p.costGrowth, 1.8), lv));
  }

  /**
   * 兵解可获得多少道行。
   *
   *   道行 = daoBase ×(1 + daoPerRun × 已兵解次数) ×(主动 1.0 / 被动 passiveDaoRatio)
   *
   * **刻意不含「资产总量」项**：否则玩家会先囤到天量资产再兵解，把转生变成
   * 一次性的暴富操作，而不是一轮轮的节奏循环。收益只认境界与次数。
   * 被动（渡劫失败）打三折：失败仍有收益以兑现「重启有得」，但显著低于主动兵解，
   * 否则玩家会故意去渡劫失败刷道行。
   */
  C.rebirthDaoGain = function rebirthDaoGain(s, mode) {
    const c = C.rebirthCfg();
    const base = C.num(c.daoBase, 100);
    const per = C.num(c.daoPerRun, 0.6);
    const raw = base * (1 + per * C.rebirthCount(s));
    const ratio = (mode === 'passive') ? C.num(c.passiveDaoRatio, 0.3) : 1;
    return Math.max(0, Math.floor(raw * ratio));
  }

  /** 是否达到兵解门槛（二次确认属于界面层的事） */
  C.rebirthUnlocked = function rebirthUnlocked(s) {
    if (!C.rebirthCfg().implemented) return false;
    const need = C.rebirthCfg().unlock || {};
    return (s ? s.realm : 0) >= C.num(need.realm, 4);
  }

  C.rebirthLockedReason = function rebirthLockedReason(s) {
    if (!C.rebirthCfg().implemented) return '转生系统未开放';
    if (C.rebirthUnlocked(s)) return '';
    const need = C.rebirthCfg().unlock || {};
    return '需达到「' + C.realmName(C.num(need.realm, 4)) + '」才能兵解';
  }

  /**
   * 兵解 —— 结束这一世，换取道行。
   *
   * 重置清单（与 config 的 rebirth.wipe 对齐）：
   *   归零：境界 · 灵气 · 灵石 · 金钱 · 精力 · 投向分配 · 档位 · 当前工作
   *   清空：公司（注册 / 产线 / 仓库 / 库存 / 全部统计）· 股市（持仓 / 成本 / 流 / 统计）
   *   保留：功法本体 · 熟练度段位 · 被动常驻 · 工作履历 · 设备（吃转生折扣）·
   *         playTime 与 gameSeconds（行情时钟与日期绝不允许倒退，否则抛压 / 冲击结算会错乱）
   *
   * @param {string} mode 'active' 主动兵解 | 'passive' 被动（渡劫失败，道行打三折）
   */
  /**
   * 兵解 —— 主动与被动走的是同一段代码，差别只在**清到什么程度**。
   *
   *   主动（mode='active'）  需境界 ≥ 元婴；按 `rebirth.wipe` 清资产，保留功法/设备/履历
   *   被动（mode='passive'） 渡劫失败强制触发，无境界要求；道行打三折；
   *                          且当 `realm < tribulation.passiveRules.belowRealm`
   *                          （元婴）时**额外清掉功法与设备**，等于这一世彻底白干
   *
   * 每个开关都挂在配置上（`rebirth.wipe` / `rebirth.passiveExtraWipe` /
   * `tribulation.passiveRules`），改口径只动配置。
   * 清单本身写在 game-config 的 `rebirth.wipe` 注释里，改代码前先对照那份清单，
   * 避免又出现「新加了一个资源字段但忘了在兵解里清掉」。
   */
  C.doRebirth = function doRebirth(s, mode) {
    const cfg = C.rebirthCfg();
    if (!cfg.implemented) return { ok: false, msg: '转生系统未开放' };

    const passive = (mode === 'passive');
    if (!passive && !C.rebirthUnlocked(s)) {
      return { ok: false, msg: C.rebirthLockedReason(s) || '尚未达到兵解条件' };
    }

    const wipe = cfg.wipe || {};
    const rules = C.tribulationCfg().passiveRules || {};
    const extra = cfg.passiveExtraWipe || {};
    const belowRealm = C.num(rules.belowRealm, 4);
    /**
     * 被动兵解在元婴之下要「全清」。
     * 注意方向：这是**在标准清空之外再加码**，不是替代 ——
     * 元婴及以上的失败仍然保留设备与功法，只是道行打三折。
     */
    const fullWipe = passive
      && rules.fullWipeBelow !== false
      && C.num(s.realm, 0) < belowRealm;

    const gain = C.rebirthDaoGain(s, mode);
    const before = {
      realm: s.realm,
      realmName: C.realmName(s.realm),
      money: s.money.toJSON(),
      deviceCompute: C.totalCompute(s).toJSON(),
    };

    // ---- 1. 道行结算（先结，后面的重置不会动它）----
    const st = C.rebirthState(s);
    st.count += 1;
    st.dao += gain;
    st.daoTotal += gain;
    st.history.push({
      n: st.count,
      realm: before.realm,
      realmName: before.realmName,
      dao: gain,
      money: before.money,
      gameSeconds: s.gameSeconds,
      mode: passive ? 'passive' : 'active',
      fullWipe: fullWipe,
    });
    // 历史只留最近 20 条，避免长线存档无限膨胀
    if (st.history.length > 20) st.history = st.history.slice(-20);

    // ---- 2. 修仙线（永远清）----
    s.realm = 0;
    s.qi = new D(0);
    s.realmProgress = new D(0);
    // 「最近一次渡劫结果」属于上一世，别让它跨世提示
    const tst = C.tribulationState(s);
    tst.won = null;
    tst.lost = null;

    // ---- 3. 功法 ----
    // 默认只清熟练度进度（段位决定被动是否常驻，被动本身是永久资产）；
    // 被动全清时会连本体一起抹掉。
    if (fullWipe && extra.techniques !== false) {
      s.learned = {};
      s.technique = null;
      s.cultivating = true;
    } else if (wipe.techniqueProgress !== false) {
      for (const id of Object.keys(s.learned)) {
        const rec = s.learned[id];
        if (rec) rec.mastery = 0;
      }
    }

    // ---- 4. 本世累积的算力加成也要归零 ----
    // aiBonus 是「AI 领域」逐 tick 累积出来的算力增量，性质上属于「这一世攒下的产能」，
    // 与设备存量无关。不清它的话，兵解后 realCompute = 衰减后的设备算力 + 巨额 aiBonus，
    // 照样秒回元婴 —— 这是「转生刹车失灵」的第二个来源（第一个是设备算力没压数量级）。
    if (wipe.computeBonus !== false || fullWipe) {
      s.aiBonus = new D(0);
      s.investedCompute = new D(0);
    }

    // ---- 5. 设备（只有被动全清才会抹）----
    if (fullWipe && extra.devices !== false) {
      for (const dev of GAME.devices) s.devices[dev.id] = 0;
    }

    // ---- 6. 硬通货 ----
    if (wipe.currency !== false || fullWipe) {
      s.money = new D(GAME.base.startMoney);
      s.spiritStone = new D(0);
    }

    // ---- 7. 投向分配与累计产出（回到「全修仙」，锁定项由 setAllocation 自动归零）----
    if (wipe.invest !== false || fullWipe) {
      for (const inv of GAME.investments) s.produced[inv.id] = new D(0);
      C.setAllocation(s, {});
    }

    // ---- 8. 工作 ----
    // 履历（jobDone / totalJobs）默认保留 —— 否则每一世都要重跑一整条升职链，
    // 而那条链的解锁条件里带着「工作完成次数」，重跑一次要几十小时。
    if (wipe.job !== false) {
      s.jobId = GAME.jobs.length ? GAME.jobs[0].id : null;
      s.jobProgress = 0;
      s.working = true;
    }
    if (rules.keepJobHistory === false) {
      for (const j of GAME.jobs) s.jobDone[j.id] = 0;
      s.totalJobs = 0;
      s.rushCount = 0;
    }

    // ---- 9. 公司：全清 ----
    if (wipe.company !== false || fullWipe) {
      const c = s.company;
      c.founded = false;
      c.foundedDay = null;
      c.lines = {};
      c.pending = {};
      c.warehouseLevel = 0;
      c.stock = {};
      c.cycleProgress = 0;
      c.cycles = 0;
      c.autoSell = true;
      c.goodsSold = {};
      c.totalRevenue = new D(0);
      c.totalUpkeep = new D(0);
      c.pressure = {};
      c.soldThisPeriod = {};
      c.producedThisPeriod = {};
      c.lastPeriod = {};
      // 重新铺满「每条线 0 台」与「每种商品 0 件」的骨架
      for (const l of GAME.company.lines) c.lines[l.id] = 0;
      for (const g of GAME.company.goods) {
        c.stock[g.id] = 0;
        c.goodsSold[g.id] = 0;
        c.pressure[g.id] = 0;
        c.soldThisPeriod[g.id] = 0;
        c.producedThisPeriod[g.id] = 0;
        c.lastPeriod[g.id] = 0;
      }
      C.bumpMarketVer();
      C.bumpUnitsVer();   // 产线全清 —— 两级算力分配与财务快照的缓存一并作废
    }

    // ---- 10. 股市：全清 ----
    if (wipe.stock !== false || fullWipe) {
      const k = s.stock;
      k.shares = {};
      k.flow = {};
      k.cost = {};
      k.lastPeriod = {};
      k.realized = new D(0);
      k.totalFee = new D(0);
      k.totalTrades = 0;
      for (const x of GAME.stock.stocks) {
        k.shares[x.id] = 0;
        k.flow[x.id] = 0;
        k.cost[x.id] = new D(0);
      }
    }

    // ---- 11. 时间与派生量 ----
    // 档位回落到最初一档（autoTier 保持开启，渡劫成功后会自动跟上）
    if (wipe.timeTier !== false) {
      s.timeTier = GAME.time.defaultTier;
      s.autoTier = true;
    }
    // 快照兵解时的设备存量：转生衰减只压这份快照，
    // 这一世之后新买的设备全额累加（买多少算力涨多少）。
    C.snapshotRebirthBase(s);
    // 注意：gameSeconds 与 playTime **绝不允许倒退** —— 前者是日期，后者是行情时钟
    s.shenshi = C.totalShenshi(s);
    s.realCompute = C.realComputeOf(s);
    s.energy = C.maxEnergy(s);

    return {
      ok: true,
      dao: gain,
      count: st.count,
      mode: passive ? 'passive' : 'active',
      fullWipe: fullWipe,
      discount: C.rebirthDiscount(s),
      lost: before,
    };
  }

  /**
   * 用道行升一级永久加成。
   * 每项都有硬上限（config.perks[].maxLevel）—— 转生是无限循环，没有上限的长线一定失控。
   */
  C.buyPerk = function buyPerk(s, id) {
    const p = C.perkById(id);
    if (!p) return { ok: false, msg: '加成不存在' };
    const lv = C.perkLevel(s, id);
    const maxLv = C.num(p.maxLevel, 0);
    if (lv >= maxLv) return { ok: false, msg: '「' + p.name + '」已达上限 ' + maxLv + ' 级' };
    const cost = C.perkCost(s, id);
    const st = C.rebirthState(s);
    if ((st.dao || 0) < cost) {
      return { ok: false, msg: '道行不足（需要 ' + cost + '，当前 ' + Math.floor(st.dao || 0) + '）' };
    }
    st.dao = Math.floor(st.dao - cost);
    st.perks[id] = lv + 1;
    // 有些加成会改乘区，立刻刷新派生量
    s.shenshi = C.totalShenshi(s);
    s.realCompute = C.realComputeOf(s);
    return { ok: true, id: id, name: p.name, level: lv + 1, cost: cost, daoLeft: st.dao };
  }

  /** 转生概览（界面与接口层共用） */
  C.rebirthSummary = function rebirthSummary(s) {
    const cfg = C.rebirthCfg();
    if (!cfg.implemented) return null;
    const st = C.rebirthState(s);
    const perks = (cfg.perks || []).map((p) => {
      const lv = C.perkLevel(s, p.id);
      const maxLv = C.num(p.maxLevel, 0);
      return {
        id: p.id, name: p.name, desc: p.desc || '',
        level: lv, maxLevel: maxLv, maxed: lv >= maxLv,
        per: C.num(p.per, 0), unit: p.unit || '',
        cost: C.perkCost(s, p.id),
        /** 当前生效的总效果 */
        value: lv * C.num(p.per, 0),
      };
    });
    return {
      implemented: true,
      count: st.count,
      dao: Math.floor(st.dao || 0),
      daoTotal: Math.floor(st.daoTotal || 0),
      discount: C.rebirthDiscount(s),
      unlocked: C.rebirthUnlocked(s),
      lockedReason: C.rebirthLockedReason(s),
      /**
       * 面板是否展开。
       * 注意与 unlocked 的区别：unlocked 是「现在能不能执行兵解」（境界 ≥ 元婴），
       * 而 visible 是「该不该给玩家看道行面板」—— 兵解之后境界会掉回凡人，
       * 如果面板跟着锁上，玩家就看不到自己的道行、也花不掉它。
       */
      visible: C.rebirthUnlocked(s) || st.count > 0,
      /** 现在兵解能拿多少道行 */
      daoGain: C.rebirthDaoGain(s, 'active'),
      /** 被动（渡劫失败）能拿多少 —— 主动的三折 */
      daoGainPassive: C.rebirthDaoGain(s, 'passive'),
      passiveRatio: C.num(cfg.passiveDaoRatio, 0.3),
      /** 下一次兵解之后的衰减指数（用同一个函数算，避免界面与引擎给出两个数） */
      nextDiscount: C.rebirthFactorAt(st.count + 1),
      perks: perks,
      history: st.history.slice(-8),
    };
  }

  // ---- 道行加成落到「非转生」参数上的那几项（离线 / 股市费率）----
  // 这三项原先写死在 GAME.offline / GAME.stock 里，现在由道行加成抬高/降低，
  // 也顺手把手册里「离线收益可通过升级提高」那条久未实现的设计接通了。

  /** 离线收益系数（基础 0.30 + 道行 · 离线延展，夹到 1.0） */
  C.offlineRatio = function offlineRatio(s) {
    const c = GAME.offline || {};
    const v = C.num(c.ratio, 0.3) + C.perkValue(s, 'offlineRatio');
    return Math.max(0, Math.min(1, v));
  }

  /** 离线封顶时长（小时）= 基础 48 + 道行 · 离线恒长 */
  C.offlineMaxHours = function offlineMaxHours(s) {
    const c = GAME.offline || {};
    return Math.max(1, C.num(c.maxHours, 48) + C.perkValue(s, 'offlineHours'));
  }



  return C;
});
