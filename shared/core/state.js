/**
 * game-core · state —— 存档三件套：createState / hydrate / serialize。字段口径与迁移逻辑全部集中在此（v1→v2 灵气迁移、v3.4 衰减快照、v3.5 功法等级）。
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
  // 状态
  // ============================================================

  /** 创建一份全新的游戏状态 */
  C.createState = function createState() {
    const state = {
      money: new D(GAME.base.startMoney),

      // ---- 时间 ----
      /** 游戏内时间：从 2000-01-01 00:00 起经过的游戏秒数 */
      gameSeconds: 0,
      /** 当前时间档位 */
      timeTier: GAME.time.defaultTier,
      // autoTier 也属于状态，但它是已废弃字段 —— 定义见下方「统计」段之前，只写一次

      // ---- 精力 ----
      /** 当前精力（可为小数） */
      energy: 0,

      // ---- 工作 ----
      /** 当前选择的工作 id，null = 未选 */
      jobId: GAME.jobs.length ? GAME.jobs[0].id : null,
      /** 当前这份工作已进行的游戏秒数 */
      jobProgress: 0,
      /** 是否启用自动执行（精力不足时只是暂停推进，不会关掉此开关） */
      working: true,
      /** 各工作已完成次数 */
      jobDone: {},
      /** 总完成工作次数 */
      totalJobs: 0,
      /** 手动催工次数 */
      rushCount: 0,

      // ---- 神识 ----
      /** 当前神识（由境界 + 设备 + 功法被动算出，此处缓存供前端展示） */
      shenshi: 0,

      // ---- 功法 ----
      /** 当前修炼的功法 id，null = 未习得 */
      technique: null,
      /** 是否正在修炼（修炼涨熟练度） */
      cultivating: true,
      /**
       * 已习得功法明细：{ [id]: { mastery, tier, passive } }
       *   mastery —— 熟练度累计点数（兵解时清空）
       *   tier    —— 熟练度段位索引 0..5（入门..圆满，兵解时保留）
       *   passive —— 被动属性是否已转为常驻（修满后永久为 true）
       */
      learned: {},

      // ---- 科技 ----
      devices: {},
      alloc: {},
      produced: {},
      realCompute: new D(0),
      aiBonus: new D(0),
      investedCompute: new D(0),
      /**
       * 计算设备领域的**累积议价值**（v3.5）—— 永久压低设备造价。
       * 每秒按 hardware 投向份额增长；拉没进度条只停止增长、不清空。
       * 折扣比例按「该设备现价」稀释，见 hardwareDiscountFor。
       */
      investedHardware: new D(0),

      // ---- 公司（产业）----
      /**
       * 与「工作」彻底分开的一条线：
       *   工作 = 职业（别人雇你，固定收益、消耗精力）
       *   公司 = 产业（自己生产、自己卖，收益随市价浮动、扣维护费）
       *
       * 注意 `stock` 存的是**件数**（整数），市价不存档 —— 它由 marketClock
       * （现实秒，见 marketClock 的注释）确定性推导，这样前端 tick 与后端
       * 离线结算算出的价格完全一致。
       */
      company: {
        /** 是否已注册成立 */
        founded: false,
        /** 成立时的游戏内天数（仅展示用） */
        foundedDay: null,
        /**
         * 各生产线的**每一台** { [lineId]: { units: [ { p, r } ] } }
         *   p = 这台正在产的产物 id（必须是这条线所属行业的产物之一）
         *   r = 这台开几成力（0~1），决定它占多少算力、产多少货
         * units.length 就是这条线买了几台。**每台独立配置** —— 想让第 3 台矿井
         * 挖煤、其余挖铁，直接改第 3 台就行。
         */
        lines: {},
        /** 不足一件的产量零头 { [goodId]: 小数 }。攒够一件再入库，否则低产能永远产 0 */
        pending: {},
        /** 仓库等级（0 = 基础容量） */
        warehouseLevel: 0,
        /** 库存件数 { [goodId]: count } */
        stock: {},
        /** 当前生产周期已累积的现实秒数 */
        cycleProgress: 0,
        /** 已完成的生产周期总数 */
        cycles: 0,
        /** 自动卖出（默认开；关掉后可以压货等高价，但要承担仓库爆仓停产的风险） */
        autoSell: true,
        /** 累计卖出的件数 { [goodId]: count } */
        goodsSold: {},
        /** 累计毛收入 */
        totalRevenue: new D(0),
        /** 累计已付维护费 */
        totalUpkeep: new D(0),

        // ---- 市场抛压（「卖得多价格被压低」的反噬）----
        /** 当前生效的抛压 { [goodId]: 0~1 }，由上一期的净抛售产生，逐期按 decay 衰减 */
        pressure: {},
        /** 本期已卖出件数 { [goodId]: count }（期切换时结算成压力并清零） */
        soldThisPeriod: {},
        /** 本期产出件数 { [goodId]: count }（作为抛压的分母：正常产出不算砸盘） */
        producedThisPeriod: {},
        /** 上次结算抛压时各商品所处的期数 { [goodId]: period } */
        lastPeriod: {},
        /**
         * 历史最高抛压（0~1，只增不减）—— 「操控市场」类功法成就的达成凭据。
         * 抛压只在清仓砸盘时产生，能留下高水位 = 玩家真的砸过盘。
         */
        peakPressure: 0,
      },

      // ---- 股市（证券账户）----
      /**
       * 第三条经济线：买卖股票。价格 = 自然价 × 冲击系数，
       * 自然价由 (股票序号, 期数) + 联动商品价格确定性推导（不存档），
       * 只有「持仓 / 成交流 / 成本」需要存。
       *
       * 注意与 `company.stock`（仓库存货）区分：那个是「货」，这个是「股」。
       */
      stock: {
        /** 持股数 { [stockId]: count }（整数股） */
        shares: {},
        /** 本期净买入股数 { [stockId]: count }（正 = 净买入，负 = 净卖出；期切换时衰减） */
        flow: {},
        /** 持仓成本 { [stockId]: Decimal }（含手续费，卖出时按含费均价扣减） */
        cost: {},
        /** 上次结算冲击时各股票所处的期数 { [stockId]: period } */
        lastPeriod: {},
        /** 累计已实现盈亏（金钱，可正可负） */
        realized: new D(0),
        /** 累计手续费 */
        totalFee: new D(0),
        /** 累计成交笔数 */
        totalTrades: 0,
      },

      // ---- 修仙 ----
      /** 灵气 —— 突破境界用 */
      qi: new D(0),
      /** 灵石 —— 后期修仙资源，购买科技修仙设备用 */
      spiritStone: new D(0),
      realm: 0,
      realmProgress: new D(0),

      // ---- 转生（兵解）----
      /**
       * 每一世的沉淀。兵解时：count +1、道行按「境界 + 已兵解次数」结算
       * （**对资产总量不敏感**）、境界与灵气归零、公司股市全清、
       * 设备保留但吃转生折扣（算力与神识倍率各留一定比例）。
       *   count    已完成的兵解次数（只增，防作弊）
       *   dao      未分配的道行
       *   daoTotal 历史累计道行（只增，防作弊）
       *   perks    各项永久加成的等级 { [perkId]: level }
       *   history  每世摘要（最多保留 20 条，仅用于展示）
       */
      rebirth: { count: 0, dao: 0, daoTotal: 0, perks: {}, history: [] },

      // ---- 渡劫（突破境界的门槛）----
      /**
       * 每成功渡劫一次 +1 层的**永久**沉淀 —— 跨兵解不丢，
       * 是转生循环里「这一世没有白过」的那部分。
       *   level     当前层数（效果 = 层数 × tribulation.boon[key]）
       *   attempts  累计尝试次数（展示用）
       *   failures  累计失败次数（展示用）
       *   won/lost  最近一次渡劫的结果，供界面做一次性提示
       */
      tribulation: { level: 0, attempts: 0, failures: 0, won: null, lost: null },
      /** 是否自动渡劫（灵气一够就硬闯） */
      autoTribulation: true,
      /** 游戏时间是否暂停（精力恢复 / 投向 / 公司 / 修炼走现实时间，不受影响） */
      timePaused: false,
      /**
       * 自动跟随最高档 —— 已废弃（见 stepTick 第 13 步的注释）。
       * 字段保留只为兼容旧存档；新代码不再读它。初始值恒为 false。
       */
      autoTier: false,

      // ---- 统计 ----
      playTime: 0,
      lastTick: Date.now(),
    };

    for (const dev of GAME.devices) state.devices[dev.id] = 0;
    for (const inv of GAME.investments) {
      state.alloc[inv.id] = (!inv.locked && inv.id === 'xiuxian') ? 1 : 0;
      state.produced[inv.id] = new D(0);
    }
    for (const j of GAME.jobs) state.jobDone[j.id] = 0;
    for (const l of GAME.company.lines) state.company.lines[l.id] = 0;
    for (const g of GAME.company.goods) {
      state.company.stock[g.id] = 0;
      state.company.goodsSold[g.id] = 0;
      state.company.pressure[g.id] = 0;
      state.company.soldThisPeriod[g.id] = 0;
      state.company.producedThisPeriod[g.id] = 0;
      state.company.lastPeriod[g.id] = 0;
    }

    for (const st of GAME.stock.stocks) {
      state.stock.shares[st.id] = 0;
      state.stock.flow[st.id] = 0;
      state.stock.cost[st.id] = new D(0);
      state.stock.lastPeriod[st.id] = 0;
    }

    state.shenshi = C.totalShenshi(state);
    state.energy = C.maxEnergy(state);
    return state;
  }

  /** 把存档 JSON 还原为运行时状态（Decimal 需要重建） */
  C.hydrate = function hydrate(raw) {
    if (!raw) return C.createState();
    const s = C.createState();

    s.money = D.fromJSON(raw.money);
    s.realmProgress = D.fromJSON(raw.realmProgress);
    s.aiBonus = D.fromJSON(raw.aiBonus);
    s.investedCompute = D.fromJSON(raw.investedCompute);
    s.investedHardware = raw.investedHardware ? D.fromJSON(raw.investedHardware) : new D(0);

    /**
     * 存档迁移（v1 → v2）：
     *   v1 里只有 spiritStone，且它就是「突破用资源」。
     *   v2 把突破资源改名为 qi（灵气），spiritStone（灵石）改为后期修仙资源。
     *   因此旧存档的 spiritStone 必须迁到 qi，否则老玩家会凭空丢掉全部突破进度。
     */
    if (raw.qi === undefined || raw.qi === null) {
      s.qi = D.fromJSON(raw.spiritStone);
      s.spiritStone = new D(0);
    } else {
      s.qi = D.fromJSON(raw.qi);
      s.spiritStone = D.fromJSON(raw.spiritStone);
    }

    s.realm = Number.isInteger(raw.realm) ? Math.max(0, raw.realm) : 0;
    s.playTime = raw.playTime || 0;
    s.lastTick = raw.lastTick || Date.now();

    // ---- 转生（兵解）----
    // 逐项夹范围：count / daoTotal 只增（服务端 /api/save 另有保护），
    // dao 夹到 [0, daoTotal]，perks 每项夹到 [0, 该加成的 maxLevel] ——
    // 后者是防手改存档：不加这一道，玩家可以直接把加成等级填到天上。
    {
      const rc = (raw.rebirth && typeof raw.rebirth === 'object') ? raw.rebirth : {};
      const rp = (rc.perks && typeof rc.perks === 'object') ? rc.perks : {};
      const perks = {};
      for (const p of ((GAME.rebirth && GAME.rebirth.perks) || [])) {
        const lv = Math.max(0, Math.floor(C.num(rp[p.id], 0)));
        perks[p.id] = Math.min(Math.floor(C.num(p.maxLevel, 0)), lv);
      }
      const count = Math.max(0, Math.floor(C.num(rc.count, 0)));
      const daoTotal = Math.max(0, Math.floor(C.num(rc.daoTotal, 0)));
      let dao = Math.max(0, Math.floor(C.num(rc.dao, 0)));
      if (dao > daoTotal) dao = daoTotal;
      const history = Array.isArray(rc.history) ? rc.history.slice(-20) : [];
      s.rebirth = {
        count: count, dao: dao, daoTotal: daoTotal, perks: perks, history: history,
        // 转生衰减快照：baseCompute 是 D，baseShenshi 是 number；
        // 旧存档没有这两个字段（null），hydrate 尾部会在设备还原后补拍
        baseCompute: (rc.baseCompute && typeof rc.baseCompute === 'object') ? D.fromJSON(rc.baseCompute) : null,
        baseShenshi: (typeof rc.baseShenshi === 'number' && rc.baseShenshi >= 0) ? rc.baseShenshi : null,
      };
    }

    // ---- 渡劫 ----
    // level 夹到 [0, maxLevel]（防手改存档直接填层数）；次数只做非负夹取。
    {
      const cfgT = C.tribulationCfg();
      const rt = (raw.tribulation && typeof raw.tribulation === 'object') ? raw.tribulation : {};
      const maxLv = Math.max(0, Math.floor(C.num(cfgT.maxLevel, 40)));
      const level = Math.min(maxLv, Math.max(0, Math.floor(C.num(rt.level, 0))));
      s.tribulation = {
        level: level,
        attempts: Math.max(0, Math.floor(C.num(rt.attempts, 0))),
        failures: Math.max(0, Math.floor(C.num(rt.failures, 0))),
        won: rt.won || null,
        lost: rt.lost || null,
      };
      // 老存档没有这个字段时跟随配置默认值
      s.autoTribulation = (raw.autoTribulation === undefined || raw.autoTribulation === null)
        ? (cfgT.autoDefault !== false)
        : !!raw.autoTribulation;
    }

    // ---- 时间暂停 ----
    s.timePaused = !!raw.timePaused;

    // ---- 时间 ----
    s.gameSeconds = typeof raw.gameSeconds === 'number' && raw.gameSeconds >= 0 ? raw.gameSeconds : 0;
    s.timeTier = C.tierInfo(raw.timeTier).tier;
    if (!C.tierUnlocked(s, s.timeTier)) s.timeTier = GAME.time.defaultTier;
    s.autoTier = raw.autoTier === undefined ? true : !!raw.autoTier;

    // ---- 工作 ----
    if (raw.jobDone && typeof raw.jobDone === 'object') {
      for (const j of GAME.jobs) {
        s.jobDone[j.id] = Math.max(0, Math.floor(raw.jobDone[j.id] || 0));
      }
    }
    s.totalJobs = Math.max(0, Math.floor(raw.totalJobs || 0));
    s.rushCount = Math.max(0, Math.floor(raw.rushCount || 0));
    s.jobId = C.jobById(raw.jobId) ? raw.jobId : (GAME.jobs.length ? GAME.jobs[0].id : null);
    // 存档里的工作必须是已解锁的，否则退回第一个可用工作
    if (s.jobId && !C.jobUnlocked(s, C.jobById(s.jobId))) {
      const first = GAME.jobs.find((j) => C.jobUnlocked(s, j));
      s.jobId = first ? first.id : null;
      s.jobProgress = 0;
    }
    const dur = s.jobId ? C.jobDurationSeconds(C.jobById(s.jobId)) : 0;
    s.jobProgress = typeof raw.jobProgress === 'number'
      ? Math.max(0, Math.min(raw.jobProgress, dur || 0))
      : 0;
    s.working = raw.working === undefined ? true : !!raw.working;

    // ---- 功法 ----
    if (raw.learned && typeof raw.learned === 'object') {
      for (const t of GAME.techniques.list) {
        const rec = raw.learned[t.id];
        if (!rec) continue;
        const mastery = Math.max(0, Math.min(C.MAX_MASTERY, Number(rec.mastery) || 0));
        // 段位取「存档值」与「由熟练度推出的值」中的较大者 —— 兵解清空熟练度后段位仍保留
        const tierFromMastery = C.masteryTierOf(mastery);
        const tier = Math.max(0, Math.min(C.PERFECT_TIER,
          Number.isInteger(rec.tier) ? rec.tier : tierFromMastery));
        s.learned[t.id] = {
          mastery: mastery,
          tier: Math.max(tier, tierFromMastery),
          passive: !!rec.passive || Math.max(tier, tierFromMastery) >= C.PERFECT_TIER,
          // v3.5 每本功法独立的经验 / 等级。旧存档没有这两个字段 ——
          // level 置 -1 作为迁移标记，hydrate 尾部（realCompute 还原后）
          // 按旧全局公式补一次初始等级，经验从 0 起步。
          exp: (typeof rec.exp === 'number' && rec.exp >= 0) ? rec.exp : 0,
          level: Number.isInteger(rec.level) && rec.level >= 0 ? rec.level : -1,
        };
      }
    }
    s.technique = (raw.technique && s.learned[raw.technique]) ? raw.technique : null;
    if (!s.technique) {
      const first = GAME.techniques.list.find((t) => s.learned[t.id]);
      if (first) s.technique = first.id;
    }
    s.cultivating = raw.cultivating === undefined ? true : !!raw.cultivating;

    // ---- 科技 ----
    if (raw.devices) for (const k of Object.keys(s.devices)) {
      s.devices[k] = Math.max(0, Math.floor(raw.devices[k] || 0));
    }
    // 实际算力是「设备 + 神识加成」的运行期结果，tick 里每帧都会重算；
    // 但**读档后的第一帧还没 tick**，若这里不恢复，产线会瞬间判断成「算力 0」
    // —— 表现为刚上线的一瞬间全厂停摆（下一帧才恢复）。存档里就带着它。
    if (raw.realCompute !== undefined && raw.realCompute !== null) {
      const rc = D.fromJSON(raw.realCompute);
      s.realCompute = rc.gt(0) ? rc : new D(0);
    }
    // ⚠️ 「工业产能」可用与否取决于公司是否已成立，而 company 段在下面才恢复。
    // 这里必须先补上 founded，否则 investmentAvailable 会把它判成不可用，
    // 读一次档就把工业份额抹成 0 —— 表现为「下线再上线，工厂全停」。
    if (raw.company) s.company.founded = !!raw.company.founded;
    if (raw.alloc) for (const k of Object.keys(s.alloc)) {
      const inv = GAME.investments.find((i) => i.id === k);
      // 与 setAllocation 同一口径：**看 investmentAvailable，不看 inv.locked**。
      // locked 只是配置的初始标记，习得功法 / 成立公司之后这些项就该能拿到份额。
      // 早先这里写的是 `inv.locked → 归 0`，于是每次读档都会把「功法增幅」和
      // 「工业产能」的份额抹掉 —— 读一次档公司就停一次产。
      if (inv && !C.investmentAvailable(s, inv)) { s.alloc[k] = 0; continue; }
      const v = raw.alloc[k];
      s.alloc[k] = (typeof v === 'number' && v >= 0) ? v : 0;
    }
    if (raw.produced) for (const k of Object.keys(s.produced)) {
      s.produced[k] = D.fromJSON(raw.produced[k]);
    }

    // ---- 公司（产业）----
    if (raw.company && typeof raw.company === 'object') {
      const rc = raw.company;
      s.company.founded = !!rc.founded;
      s.company.foundedDay = Number.isFinite(rc.foundedDay) ? rc.foundedDay : null;
      s.company.warehouseLevel = Math.max(0, Math.min(
        GAME.company.warehouse.maxLevel, Math.floor(rc.warehouseLevel || 0)));
      s.company.cycleProgress = Math.max(0, Number(rc.cycleProgress) || 0);
      s.company.cycles = Math.max(0, Math.floor(rc.cycles || 0));
      s.company.autoSell = rc.autoSell === undefined ? true : !!rc.autoSell;
      s.company.totalRevenue = D.fromJSON(rc.totalRevenue);
      s.company.totalUpkeep = D.fromJSON(rc.totalUpkeep);

      /**
       * 生产线按「每台独立配置」重建。
       *
       * 老存档是 `lines: { [lineId]: 数量 }` 的纯数字结构，而且旧的线（电子作坊、
       * 芯片代工厂……）在新表里已经不存在了，无法一一映射。所以这里一律按新结构
       * 重建，产物回落到行业默认 —— 台数尽量保留，但**造什么由玩家重新指定**。
       * 这是模型重构的代价：founded / 仓库等级 / 累计收入 / 抛压全部保留。
       */
      for (const l of GAME.company.lines) {
        const raw = rc.lines && rc.lines[l.id];
        const oldUnits = (raw && Array.isArray(raw.units)) ? raw.units : [];
        const prods = C.lineProducts(l);
        const okIds = prods.map((g) => g.id);
        const def = prods.length ? prods[0].id : null;
        const n = (typeof raw === 'number') ? raw : oldUnits.length;
        const out = [];
        for (let i = 0; i < n; i++) {
          const u = oldUnits[i] || {};
          const p = (typeof u.p === 'string' && okIds.indexOf(u.p) >= 0) ? u.p : def;
          let r = Number(u.r);
          if (!Number.isFinite(r)) r = 1;
          if (r < 0) r = 0;
          if (r > 1) r = 1;
          out.push({ p: p, r: r });
        }
        s.company.lines[l.id] = { units: out, priority: !!(raw && raw.priority) };
      }
      if (rc.pending) for (const g of GAME.company.goods) {
        const v = Number(rc.pending[g.id]);
        s.company.pending[g.id] = Number.isFinite(v) && v > 0 ? v : 0;
      }
      if (rc.stock) for (const g of GAME.company.goods) {
        s.company.stock[g.id] = Math.max(0, Math.floor(rc.stock[g.id] || 0));
      }
      if (rc.goodsSold) for (const g of GAME.company.goods) {
        s.company.goodsSold[g.id] = Math.max(0, Math.floor(rc.goodsSold[g.id] || 0));
      }

      // 市场抛压：全部夹到合法区间。压力是「客户端上报」的字段，夹取只能防住
      // 明显越界（负数会让价格暴涨），防不住蓄意篡改 —— 这一点与 money 同类，
      // 属于本作防作弊的既有边界，详见 README。
      const clamp01 = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return n > 1 ? 1 : n;
      };
      const clampCount = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.floor(n);
      };
      for (const g of GAME.company.goods) {
        s.company.pressure[g.id] = clamp01(rc.pressure && rc.pressure[g.id]);
        s.company.soldThisPeriod[g.id] = clampCount(rc.soldThisPeriod && rc.soldThisPeriod[g.id]);
        s.company.producedThisPeriod[g.id] =
          clampCount(rc.producedThisPeriod && rc.producedThisPeriod[g.id]);
        // 记录期数；比当前期还大的值会让抛压永远不结算，直接裁到当前期。
        // 期数按**现实秒**口径（marketClock）。旧存档里存的是「游戏内年」口径的
        // 期数，在档 4 下会大出好几个数量级，正好被这里夹回当前期 ——
        // 代价只是跳过一期的抛压结算，之后一切正常。
        const lp = clampCount(rc.lastPeriod && rc.lastPeriod[g.id]);
        const cur = C.goodsPeriod(g, C.marketClock(s));
        s.company.lastPeriod[g.id] = Math.min(lp, cur);
      }
      // 历史最高抛压：只增不减，且必须落在 [0,1]
      {
        const pk = Number(rc.peakPressure);
        const curPeak = Math.max(0, Math.min(1, Number.isFinite(pk) ? pk : 0));
        if (curPeak > (s.company.peakPressure || 0)) s.company.peakPressure = curPeak;
      }

      // 未成立则清空库存与周期进度，避免「先囤货再成立」绕过启动成本。
      // 注意：**不能**反过来用「没有生产线」推断未成立 —— 刚注册的公司本来就是零产线。
      // 「cannot forge founded」由服务端的 /api/save 校验负责（founded 不允许 false → true）。
      if (!s.company.founded) {
        for (const g of GAME.company.goods) s.company.stock[g.id] = 0;
        s.company.cycleProgress = 0;
      }
      // 仓库容量可能因为配置调整而变小，超出的库存直接裁掉
      const cap = C.warehouseCapacity(s);
      let total = C.stockTotal(s);
      if (total > cap) {
        for (const g of GAME.company.goods) {
          if (total <= cap) break;
          const n = s.company.stock[g.id];
          const drop = Math.min(n, total - cap);
          s.company.stock[g.id] = n - drop;
          total -= drop;
        }
      }
    }

    // ---- 股市（证券账户）----
    // 与 company.stock（仓库存货）是两码事：那个存「件」，这个存「股」。
    // 全部字段都是客户端上报的，所以这里只做**区间夹取**（负数股 / 越界冲击会让
    // 价格失控）。真正的防作弊边界与 money 同类，详见 README。
    if (raw.stock && typeof raw.stock === 'object') {
      const rs = raw.stock;
      const clampInt = (v, lo, hi) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return lo;
        return Math.max(lo, Math.min(hi, Math.floor(n)));
      };
      s.stock.realized = D.fromJSON(rs.realized);
      s.stock.totalFee = D.fromJSON(rs.totalFee);
      s.stock.totalTrades = clampInt(rs.totalTrades, 0, 1e12);
      for (const st of GAME.stock.stocks) {
        const depth = Math.max(1, Math.floor(st.depth || 1));
        // 持股不能超过流通盘（超出的部分是伪造的），也不能为负
        s.stock.shares[st.id] = clampInt(rs.shares && rs.shares[st.id], 0, depth);
        // 净买入流的绝对值不会超过流通盘
        s.stock.flow[st.id] = clampInt(rs.flow && rs.flow[st.id], -depth, depth);
        const c = D.fromJSON(rs.cost && rs.cost[st.id]);
        s.stock.cost[st.id] = c.isNeg() ? new D(0) : c;
        // 持股为 0 时成本必须归零，否则「卖了又留着成本」会让浮盈看起来是巨亏
        if (s.stock.shares[st.id] === 0) s.stock.cost[st.id] = new D(0);
        // 期数游标不允许超前于当前期，否则冲击永远等不到衰减（口径同上：现实秒）
        const lp = clampInt(rs.lastPeriod && rs.lastPeriod[st.id], 0, 1e15);
        s.stock.lastPeriod[st.id] = Math.min(lp, C.stockPeriod(st, C.marketClock(s)));
      }
    }

    // ---- 精力（上限受功法被动影响，必须在 learned 还原之后再算）----
    const maxE = C.maxEnergy(s);
    s.energy = typeof raw.energy === 'number' && raw.energy >= 0
      ? Math.min(raw.energy, maxE) : maxE;

    // ---- 功法等级迁移（v3.5）----
    // 旧模型：level = floor(log10(1+实际算力) × 4)，全功法共享。
    // 新模型：每本独立。迁移时按旧公式给每本一个起始等级（不丢旧进度），
    // 经验从 0 起步，之后各自独立成长。
    for (const id of Object.keys(s.learned)) {
      const rec = s.learned[id];
      if (rec.level < 0) {
        const c = C.realComputeOf(s).toNumber();
        rec.level = c > 0 ? Math.max(0, Math.floor(Math.log10(1 + c) * 4)) : 0;
      }
    }

    // ---- 转生衰减快照迁移（v3.4）----
    // 旧存档兵解过但没有快照字段 → 在设备已还原之后补拍一次。
    // 从这一刻起新买的设备全额累加；快照前的存量继续按旧口径吃衰减。
    {
      const rst = C.rebirthState(s);
      if (rst.count > 0 && (!rst.baseCompute || rst.baseCompute.gt(C.totalCompute(s)))) {
        C.snapshotRebirthBase(s);
      }
    }

    s.shenshi = C.totalShenshi(s);
    s.realCompute = C.realComputeOf(s);

    return s;
  }

  /** 序列化为可存档的纯 JSON */
  C.serialize = function serialize(s) {
    const st = C.rebirthState(s);
    const out = {
      money: s.money.toJSON(),
      qi: s.qi.toJSON(),
      spiritStone: s.spiritStone.toJSON(),
      realmProgress: s.realmProgress.toJSON(),
      realCompute: s.realCompute.toJSON(),
      aiBonus: s.aiBonus.toJSON(),
      investedCompute: s.investedCompute.toJSON(),
      investedHardware: s.investedHardware.toJSON(),

      gameSeconds: s.gameSeconds,
      timeTier: s.timeTier,
      autoTier: s.autoTier,

      energy: s.energy,
      jobId: s.jobId,
      jobProgress: s.jobProgress,
      working: s.working,
      jobDone: Object.assign({}, s.jobDone),
      totalJobs: s.totalJobs,
      rushCount: s.rushCount,

      shenshi: s.shenshi,
      technique: s.technique,
      cultivating: s.cultivating,
      learned: {},

      realm: s.realm,
      /**
       * 转生（兵解）。
       * count / daoTotal / perks 都是**只增字段**，服务端 /api/save 会拒绝回退。
       * dao 会因为消费加成而减少，所以不走只增保护，改为夹到 [0, daoTotal]。
       */
      rebirth: {
        count: st.count,
        dao: st.dao,
        daoTotal: st.daoTotal,
        perks: Object.assign({}, st.perks),
        history: st.history.slice(-20),
        // 转生衰减快照（v3.4）：null = 未兵解过或旧存档待迁移
        baseCompute: (st.baseCompute && typeof st.baseCompute.toJSON === 'function')
          ? st.baseCompute.toJSON() : null,
        baseShenshi: (typeof st.baseShenshi === 'number') ? st.baseShenshi : null,
      },

      /**
       * 渡劫。
       * level 同样是**只增字段**（服务端 /api/save 会拒绝回退）——
       * 它是「每一世没有白过」的那部分沉淀，跨兵解必须原样带着。
       * won / lost 是一次性提示，存下来只为刷新页面后还能补一条 toast。
       */
      tribulation: {
        level: C.tribulationLevel(s),
        attempts: C.tribulationState(s).attempts,
        failures: C.tribulationState(s).failures,
        won: C.tribulationState(s).won || null,
        lost: C.tribulationState(s).lost || null,
      },
      autoTribulation: s.autoTribulation !== false,
      /** 游戏时间是否暂停 */
      timePaused: !!s.timePaused,
      playTime: s.playTime,
      lastTick: s.lastTick,
      devices: Object.assign({}, s.devices),
      alloc: Object.assign({}, s.alloc),
      produced: {},

      company: {
        founded: s.company.founded,
        foundedDay: s.company.foundedDay,
        lines: (function () {
          const o = {};
          for (const l of GAME.company.lines) {
            o[l.id] = {
              units: C.lineUnits(s, l.id).map((u) => ({ p: u.p, r: u.r })),
              priority: C.linePriority(s, l.id),
            };
          }
          return o;
        })(),
        pending: Object.assign({}, s.company.pending),
        warehouseLevel: s.company.warehouseLevel,
        stock: Object.assign({}, s.company.stock),
        cycleProgress: s.company.cycleProgress,
        cycles: s.company.cycles,
        autoSell: s.company.autoSell,
        goodsSold: Object.assign({}, s.company.goodsSold),
        totalRevenue: s.company.totalRevenue.toJSON(),
        totalUpkeep: s.company.totalUpkeep.toJSON(),
        pressure: Object.assign({}, s.company.pressure),
        soldThisPeriod: Object.assign({}, s.company.soldThisPeriod),
        producedThisPeriod: Object.assign({}, s.company.producedThisPeriod),
        lastPeriod: Object.assign({}, s.company.lastPeriod),
        // 历史最高抛压（只增字段）：「操控市场」类功法成就的凭据
        peakPressure: s.company.peakPressure || 0,
      },

      stock: {
        shares: Object.assign({}, s.stock.shares),
        flow: Object.assign({}, s.stock.flow),
        cost: {},
        lastPeriod: Object.assign({}, s.stock.lastPeriod),
        realized: s.stock.realized.toJSON(),
        totalFee: s.stock.totalFee.toJSON(),
        totalTrades: s.stock.totalTrades,
      },
    };
    for (const id of Object.keys(s.stock.cost)) {
      const v = s.stock.cost[id];
      out.stock.cost[id] = (v && v.toJSON) ? v.toJSON() : new D(0).toJSON();
    }
    for (const id of Object.keys(s.learned)) {
      const rec = s.learned[id];
      out.learned[id] = {
        mastery: rec.mastery, tier: rec.tier, passive: rec.passive,
        exp: rec.exp || 0, level: rec.level || 0,
      };
    }
    for (const k of Object.keys(s.produced)) out.produced[k] = s.produced[k].toJSON();
    return out;
  }


  return C;
});
