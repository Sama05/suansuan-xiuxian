/**
 * 游戏核心逻辑 —— 前后端共用
 *
 * 关键原则：同一个 tick 函数，前端用于实时刷新，后端用于离线结算。
 * 两边算法完全一致，避免出现「前端显示的进度」与「后端保存的进度」对不上。
 *
 * ============================================================
 * 时间线的分工（改数值前务必理解）
 * ============================================================
 *   1) 游戏内时间（gameSeconds）—— 由时间档位决定流速，驱动「工作耗时」与日期显示。
 *   2) 现实秒累计（playTime）   —— **行情时钟**：商品市场与股市的「期」都按它推进
 *                                 （见 marketClock）。与时间档位无关。
 *   3) 现实时间（dt）           —— 驱动设备被动收益、算力投向产出、精力恢复、
 *                                 公司生产周期、功法修炼。
 *   4) 精力                     —— 按现实时间恢复，是**与档位无关**的产出硬上限。
 *
 * 为什么精力必须按现实时间算：时间档位可以调到「1 秒 = 1 个月」，
 * 如果产出上限也跟着游戏时间膨胀，玩家拉满档位就能无限产出。
 * 精力把总产出锁死在「每秒恢复 1 点」上，档位只决定你多快花完这份额度。
 *
 * 为什么行情也必须按现实时间算（与精力同一个道理）：
 *   档 4（1 秒 = 1 游戏月）下，1 游戏年只有 12 现实秒。若「期」按游戏内时间计，
 *   抛压与股市冲击每 12 秒就衰减一半、约 1 分钟归零 —— 砸盘被压价、大单砸自己
 *   这两条约束会形同虚设，把档位拉满等于免罚。改用现实秒后，任何档位下
 *   行情节奏一致，档位只加速工作。
 *
 * ============================================================
 * 两条货币 + 三个属性
 * ============================================================
 *   金钱 money        —— 买设备、开公司
 *   灵气 qi           —— **突破境界的唯一货币**，需先习得功法才会产生
 *   灵石 spiritStone  —— 后期修仙资源，买科技修仙设备用
 *   算力 compute      —— 设备提供，投向六个方向（含功法增幅、工业产能）
 *   神识 shenshi      —— 一开始就有，随境界成长，被设备（尤其科技修仙设备）增幅。
 *                        同时放大「实际算力效果」与「功法修炼速度」，
 *                        而功法修炼速度就是灵气提升速度。
 */

(function (root) {
  const Decimal = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./decimal.js') : root.Decimal;
  const GAME = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./game-config.js') : root.GAME;

  const D = Decimal;

  /** 数值兜底：非有限数时取默认值（配置缺字段时，不要让它变成 NaN 渗进乘区） */
  function num(v, dflt) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : dflt;
  }

  // ---------- 时间常量 ----------
  const SEC_PER_MIN = 60;
  const SEC_PER_HOUR = 3600;
  const SEC_PER_DAY = 86400;
  const DAYS_PER_MONTH = GAME.time.daysPerMonth;
  const MONTHS_PER_YEAR = GAME.time.monthsPerYear;
  const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR;
  const SEC_PER_MONTH = SEC_PER_DAY * DAYS_PER_MONTH;
  const SEC_PER_YEAR = SEC_PER_MONTH * MONTHS_PER_YEAR;

  const MASTERY = GAME.techniques.mastery;
  const MAX_MASTERY = MASTERY[MASTERY.length - 1].need;
  const PERFECT_TIER = MASTERY.length - 1;

  /**
   * tick 内部分段步长（现实秒）。
   * 离线 48 小时一次性结算时，若不分段，「推进工作 → 恢复精力」的交互顺序
   * 会被压成一次近似计算，导致长时间离线的工作份数出现明显偏差。
   * 60 秒一段兼顾精度与性能（48 小时 = 2880 段，纯算术开销可忽略）。
   */
  const STEP_REAL_SECONDS = 60;

  // ============================================================
  // 状态
  // ============================================================

  /** 创建一份全新的游戏状态 */
  function createState() {
    const state = {
      money: new D(GAME.base.startMoney),

      // ---- 时间 ----
      /** 游戏内时间：从 2000-01-01 00:00 起经过的游戏秒数 */
      gameSeconds: 0,
      /** 当前时间档位 */
      timeTier: GAME.time.defaultTier,
      /** 是否自动跟随已解锁的最高档位（玩家手动选档位后置 false） */
      autoTier: true,

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
       * 字段保留只为兼容旧存档；新代码不再读它。
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

    state.shenshi = totalShenshi(state);
    state.energy = maxEnergy(state);
    return state;
  }

  /** 把存档 JSON 还原为运行时状态（Decimal 需要重建） */
  function hydrate(raw) {
    if (!raw) return createState();
    const s = createState();

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
        const lv = Math.max(0, Math.floor(num(rp[p.id], 0)));
        perks[p.id] = Math.min(Math.floor(num(p.maxLevel, 0)), lv);
      }
      const count = Math.max(0, Math.floor(num(rc.count, 0)));
      const daoTotal = Math.max(0, Math.floor(num(rc.daoTotal, 0)));
      let dao = Math.max(0, Math.floor(num(rc.dao, 0)));
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
      const cfgT = tribulationCfg();
      const rt = (raw.tribulation && typeof raw.tribulation === 'object') ? raw.tribulation : {};
      const maxLv = Math.max(0, Math.floor(num(cfgT.maxLevel, 40)));
      const level = Math.min(maxLv, Math.max(0, Math.floor(num(rt.level, 0))));
      s.tribulation = {
        level: level,
        attempts: Math.max(0, Math.floor(num(rt.attempts, 0))),
        failures: Math.max(0, Math.floor(num(rt.failures, 0))),
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
    s.timeTier = tierInfo(raw.timeTier).tier;
    if (!tierUnlocked(s, s.timeTier)) s.timeTier = GAME.time.defaultTier;
    s.autoTier = raw.autoTier === undefined ? true : !!raw.autoTier;

    // ---- 工作 ----
    if (raw.jobDone && typeof raw.jobDone === 'object') {
      for (const j of GAME.jobs) {
        s.jobDone[j.id] = Math.max(0, Math.floor(raw.jobDone[j.id] || 0));
      }
    }
    s.totalJobs = Math.max(0, Math.floor(raw.totalJobs || 0));
    s.rushCount = Math.max(0, Math.floor(raw.rushCount || 0));
    s.jobId = jobById(raw.jobId) ? raw.jobId : (GAME.jobs.length ? GAME.jobs[0].id : null);
    // 存档里的工作必须是已解锁的，否则退回第一个可用工作
    if (s.jobId && !jobUnlocked(s, jobById(s.jobId))) {
      const first = GAME.jobs.find((j) => jobUnlocked(s, j));
      s.jobId = first ? first.id : null;
      s.jobProgress = 0;
    }
    const dur = s.jobId ? jobDurationSeconds(jobById(s.jobId)) : 0;
    s.jobProgress = typeof raw.jobProgress === 'number'
      ? Math.max(0, Math.min(raw.jobProgress, dur || 0))
      : 0;
    s.working = raw.working === undefined ? true : !!raw.working;

    // ---- 功法 ----
    if (raw.learned && typeof raw.learned === 'object') {
      for (const t of GAME.techniques.list) {
        const rec = raw.learned[t.id];
        if (!rec) continue;
        const mastery = Math.max(0, Math.min(MAX_MASTERY, Number(rec.mastery) || 0));
        // 段位取「存档值」与「由熟练度推出的值」中的较大者 —— 兵解清空熟练度后段位仍保留
        const tierFromMastery = masteryTierOf(mastery);
        const tier = Math.max(0, Math.min(PERFECT_TIER,
          Number.isInteger(rec.tier) ? rec.tier : tierFromMastery));
        s.learned[t.id] = {
          mastery: mastery,
          tier: Math.max(tier, tierFromMastery),
          passive: !!rec.passive || Math.max(tier, tierFromMastery) >= PERFECT_TIER,
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
      if (inv && !investmentAvailable(s, inv)) { s.alloc[k] = 0; continue; }
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
        const prods = lineProducts(l);
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
        s.company.lines[l.id] = { units: out };
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
        const cur = goodsPeriod(g, marketClock(s));
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
      const cap = warehouseCapacity(s);
      let total = stockTotal(s);
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
        s.stock.lastPeriod[st.id] = Math.min(lp, stockPeriod(st, marketClock(s)));
      }
    }

    // ---- 精力（上限受功法被动影响，必须在 learned 还原之后再算）----
    const maxE = maxEnergy(s);
    s.energy = typeof raw.energy === 'number' && raw.energy >= 0
      ? Math.min(raw.energy, maxE) : maxE;

    // ---- 功法等级迁移（v3.5）----
    // 旧模型：level = floor(log10(1+实际算力) × 4)，全功法共享。
    // 新模型：每本独立。迁移时按旧公式给每本一个起始等级（不丢旧进度），
    // 经验从 0 起步，之后各自独立成长。
    for (const id of Object.keys(s.learned)) {
      const rec = s.learned[id];
      if (rec.level < 0) {
        const c = realComputeOf(s).toNumber();
        rec.level = c > 0 ? Math.max(0, Math.floor(Math.log10(1 + c) * 4)) : 0;
      }
    }

    // ---- 转生衰减快照迁移（v3.4）----
    // 旧存档兵解过但没有快照字段 → 在设备已还原之后补拍一次。
    // 从这一刻起新买的设备全额累加；快照前的存量继续按旧口径吃衰减。
    {
      const rst = rebirthState(s);
      if (rst.count > 0 && (!rst.baseCompute || rst.baseCompute.gt(totalCompute(s)))) {
        snapshotRebirthBase(s);
      }
    }

    s.shenshi = totalShenshi(s);
    s.realCompute = realComputeOf(s);

    return s;
  }

  /** 序列化为可存档的纯 JSON */
  function serialize(s) {
    const st = rebirthState(s);
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
        level: tribulationLevel(s),
        attempts: tribulationState(s).attempts,
        failures: tribulationState(s).failures,
        won: tribulationState(s).won || null,
        lost: tribulationState(s).lost || null,
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
            o[l.id] = { units: lineUnits(s, l.id).map((u) => ({ p: u.p, r: u.r })) };
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

  // ============================================================
  // 时间系统
  // ============================================================

  /** 取档位配置（非法档位回落到第一档） */
  function tierInfo(tier) {
    return GAME.time.tiers.find((t) => t.tier === tier) || GAME.time.tiers[0];
  }

  /** 当前境界下已解锁的最高档位 */
  function maxUnlockedTier(s) {
    let best = GAME.time.tiers.length ? GAME.time.tiers[0].tier : 1;
    for (const t of GAME.time.tiers) {
      if (s.realm >= t.unlockRealm) best = Math.max(best, t.tier);
    }
    return best;
  }

  function tierUnlocked(s, tier) {
    return tier <= maxUnlockedTier(s);
  }

  /** 切档；未解锁的档位会被拒绝。手动选档会关闭「自动跟随」。 */
  function setTimeTier(s, tier) {
    tier = Math.floor(tier);
    const t = GAME.time.tiers.find((x) => x.tier === tier);
    if (!t) return { ok: false, msg: '不存在的档位' };
    if (!tierUnlocked(s, tier)) return { ok: false, msg: '该档位需 ' + realmName(t.unlockRealm) + ' 解锁' };
    s.timeTier = tier;
    s.autoTier = false;
    return { ok: true, tier: tier, auto: false };
  }

  /** 打开/关闭「自动跟随最高已解锁档位」 */
  function setAutoTier(s, on) {
    s.autoTier = !!on;
    if (s.autoTier) s.timeTier = maxUnlockedTier(s);
    return { ok: true, auto: s.autoTier, tier: s.timeTier };
  }

  function realmName(idx) {
    const r = GAME.realms[idx];
    return r ? r.name : ('境界 ' + idx);
  }

  /** 当前档位：1 现实秒 = 多少游戏秒 */
  /**
   * 精力恢复速度（点 / 现实秒）—— **随境界提升**。
   *
   * 为什么不能恒为 1：工作的单次精力消耗随境界涨（15 → 38 → 80 → 200 → 520），
   * 恢复恒为 1 意味着元婴期做一份工作要干等 8 分钟以上，纯耗时间不产生决策。
   * 恢复速度按 ~×1.45 / 境抬升，把等待压回一分钟上下。
   *
   * 为什么这不会让收入失控：高档位下工作收益的瓶颈会自动从「精力」切到
   * 「游戏时间」（advanceWork 取两者较小值）—— 元婴档 1 秒 = 1 游戏月时，
   * 一份 86400 游戏小时的工作时间下限就是 120 现实秒，恢复再快也加不了钱，
   * 只是把「干等」变成「接着干」。
   */
  function energyRegen(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const v = (r && typeof r.regen === 'number') ? r.regen : GAME.energy.regenPerSecond;
    return num(v, 1);
  }

  function gameSecondsPerRealSecond(s) {
    // 暂停档：游戏时间停走，精力恢复 / 投向 / 公司 / 修炼照常（它们走现实时间）
    if (s.timePaused) return 0;
    return tierInfo(s.timeTier).gameSecondsPerRealSecond;
  }

  /** 游戏秒 → 日历 */
  function gameDate(gs) {
    gs = Math.max(0, gs || 0);
    const days = Math.floor(gs / SEC_PER_DAY);
    const years = Math.floor(days / DAYS_PER_YEAR);
    const remDays = days % DAYS_PER_YEAR;
    return {
      year: GAME.time.startYear + years,
      month: Math.floor(remDays / DAYS_PER_MONTH) + 1,
      day: (remDays % DAYS_PER_MONTH) + 1,
      hour: Math.floor((gs % SEC_PER_DAY) / SEC_PER_HOUR),
      minute: Math.floor((gs % SEC_PER_HOUR) / SEC_PER_MIN),
      /** 自游戏起点起经过的整年数 */
      years: years,
      /** 自游戏起点起经过的整天数 */
      days: days,
    };
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** 游戏内时间显示：2000年1月1日 00:00 */
  function fmtGameDate(gs) {
    const d = gameDate(gs);
    return d.year + '年' + d.month + '月' + d.day + '日 ' + pad2(d.hour) + ':' + pad2(d.minute);
  }

  /** 游戏时长显示：用游戏内单位表述一段时长（秒） */
  function fmtGameDuration(sec) {
    // 0 必须显示为 0 —— 否则进度条归零时会显示成「1 分钟」，看着像没结算干净
    if (!(sec > 0)) return '0';
    if (sec < SEC_PER_HOUR) return Math.max(1, Math.round(sec / SEC_PER_MIN)) + ' 分钟';
    if (sec < SEC_PER_DAY) return (sec / SEC_PER_HOUR).toFixed(sec < 10 * SEC_PER_HOUR ? 1 : 0) + ' 小时';
    if (sec < SEC_PER_MONTH) return (sec / SEC_PER_DAY).toFixed(sec < 10 * SEC_PER_DAY ? 1 : 0) + ' 天';
    if (sec < SEC_PER_YEAR) return (sec / SEC_PER_MONTH).toFixed(sec < 10 * SEC_PER_MONTH ? 1 : 0) + ' 个月';
    return (sec / SEC_PER_YEAR).toFixed(sec < 10 * SEC_PER_YEAR ? 1 : 0) + ' 年';
  }

  // ============================================================
  // 精力
  // ============================================================

  /**
   * 当前精力上限 = 境界基础 ×(1 + 功法被动) ×(1 + 道行 · 精力淬炼)。
   * 精力是与时间档位解耦的产能硬上限，所以这条加成的实际影响比它看起来大。
   */
  function maxEnergy(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const base = (r && r.maxEnergy) || (GAME.realms[0] && GAME.realms[0].maxEnergy) || 100;
    return base
      * (1 + passiveBonus(s, 'energyMax'))
      * (1 + perkValue(s, 'energyMax'))
      * (1 + tribulationBonus(s, 'energyMax'));
  }

  // ============================================================
  // 神识
  // ============================================================

  /**
   * 境界提供的基础神识。
   * 含「道行加成 · 神识根基」—— 它直接加在境界基础值上，
   * 于是每一世的起跑线被永久抬高，后续所有以神识为输入的乘区都被它放大。
   */
  function shenshiBase(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const base = (r && r.shenshi) || 1;
    // 道行 · 神识根基 是「点」，渡劫淬体是「百分比」—— 先加后乘，两者互不吞掉对方
    return (base + perkValue(s, 'shenshi')) * (1 + tribulationBonus(s, 'shenshi'));
  }

  /**
   * 设备对神识的放大倍率（科技修仙设备越靠后越猛）。
   * 转生衰减作用在这一份上 —— 只有 (m − 1) 是设备贡献，只对这一部分做幂衰减。
   */
  /**
   * 设备对神识的放大倍率（科技修仙设备越靠后越猛）。
   * v3.4 快照模型：与 deviceComputeEffective 同一套逻辑 ——
   * 兵解时快照 raw 加成（baseShenshi），衰减只压快照那份，
   * 之后新买的设备按原值累加进倍率。
   */
  function shenshiDeviceMultiplier(s) {
    const rawBonus = rawShenshiBonus(s);
    if (rawBonus <= 0) return 1;
    const n = rebirthCount(s);
    if (n <= 0) return 1 + rawBonus;
    const st = rebirthState(s);
    const hasSnap = typeof st.baseShenshi === 'number' && st.baseShenshi >= 0;
    const base = (hasSnap && st.baseShenshi <= rawBonus) ? st.baseShenshi : rawBonus;
    const capped = rebirthAttenuate(s, new D(base)).toNumber();
    const growth = Math.max(0, rawBonus - base);
    return 1 + capped + growth;
  }

  /**
   * 神识总量 = 境界基础 × 设备倍率 ×(1 + 功法被动加成)。
   * **只用于界面展示**；实际乘区一律走 shenshiEffect 的分层公式，两者不混用。
   */
  function totalShenshi(s) {
    const v = shenshiBase(s) * shenshiDeviceMultiplier(s) * (1 + passiveBonus(s, 'shenshi'));
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
  function shenshiParts(s) {
    const passive = 1 + passiveBonus(s, 'shenshi');
    /** 境界那一份（含道行加成），线性因子的载体 */
    const realmPart = shenshiBase(s) * passive;
    /** 设备倍率（≥ 1，已被转生折扣作用过） */
    const deviceMul = Math.max(1, shenshiDeviceMultiplier(s));
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
  function shenshiEffect(s, perPointRealm, deviceLogK) {
    const p = shenshiParts(s);
    const f = 1 + deviceLogK * Math.log(p.deviceMul);
    const v = p.realmPart * perPointRealm * f;
    return Number.isFinite(v) ? v : 0;
  }

  /** 神识对「实际算力」的乘区 —— 引擎与界面共用同一口径，避免显示与实际不符 */
  function shenshiComputeMultiplier(s) {
    const g = GAME.shenshi || {};
    const v = 1 + shenshiEffect(s, num(g.computePerPointRealm, 0.02), num(g.computeDeviceLogK, 8));
    return v > 0 ? v : 0;
  }

  /** 神识对「功法修炼速度」的乘区（修炼速度即灵气提升速度） */
  function shenshiCultivateMultiplier(s) {
    const g = GAME.shenshi || {};
    const v = 1 + shenshiEffect(s, num(g.cultivatePerPointRealm, 0.02), num(g.cultivateDeviceLogK, 8));
    return v > 0 ? v : 0;
  }

  // ============================================================
  // 转生（兵解）
  // ============================================================

  function rebirthCfg() { return GAME.rebirth || {}; }

  /** 转生状态（容错读取，老存档没有这个字段时给一份默认值） */
  function rebirthState(s) {
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
  function rebirthCount(s) {
    return Math.max(0, Math.floor(rebirthState(s).count || 0));
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
  function rebirthFactorAt(n) {
    const c = rebirthCfg().deviceDiscount || {};
    const base = num(c.base, 0.5);
    const per = num(c.perRun, 0.03);
    const cap = num(c.cap, 0.75);
    const k = Math.max(0, Math.floor(num(n, 0)));
    if (k <= 0) return 1;
    const v = base + per * (k - 1);
    // 抹掉浮点尾巴（0.5 + 0.03 → 0.53），界面直接显示时更干净
    return Math.max(0.05, Math.min(cap, Math.round(v * 1e4) / 1e4));
  }

  // ============================================================
  // 渡劫 —— 突破境界的门槛
  // ============================================================

  function tribulationCfg() { return GAME.tribulation || {}; }

  function tribulationState(s) {
    const t = s.tribulation;
    if (!t || typeof t !== 'object') {
      s.tribulation = { level: 0, attempts: 0, failures: 0, won: null, lost: null };
    } else {
      t.level = Math.max(0, Math.floor(num(t.level, 0)));
      t.attempts = Math.max(0, Math.floor(num(t.attempts, 0)));
      t.failures = Math.max(0, Math.floor(num(t.failures, 0)));
      if (t.won === undefined) t.won = null;
      if (t.lost === undefined) t.lost = null;
    }
    return s.tribulation;
  }

  /** 渡劫淬体层数（永久，跨兵解保留） */
  function tribulationLevel(s) {
    return Math.min(
      Math.max(0, Math.floor(num(tribulationCfg().maxLevel, 40))),
      tribulationState(s).level
    );
  }

  /**
   * 渡劫淬体提供的永久加成（按 key，与 `techniques.list[].passive` 同名同义）。
   * 之所以沿用同一套键名：两套加成在同一个乘区里并排相加，
   * 不需要再造一层「渡劫乘区」，也就不会出现两个乘区互相打架。
   */
  function tribulationBonus(s, key) {
    const per = num((tribulationCfg().boon || {})[key], 0);
    if (!per) return 0;
    return tribulationLevel(s) * per;
  }

  /** 该境界的「基准算力」—— 渡劫准备度里算力冗余的参照点 */
  function tribulationComputeBase(s) {
    const arr = (tribulationCfg().prepare || {}).computeBase || [];
    const v = arr[Math.min(s.realm, Math.max(0, arr.length - 1))];
    return num(v, 1e2);
  }

  /** 已修满（被动常驻）的功法数量 —— 渡劫准备度的一项 */
  function perfectedTechniqueCount(s) {
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
  function tribulationOdds(s) {
    const cfg = tribulationCfg();
    const p = cfg.prepare || {};
    const rates = cfg.baseRate || [];
    const idx = Math.min(s.realm, Math.max(0, rates.length - 1));
    const base = num(rates[idx], 0.8);

    // 算力冗余：每高出基准 10 倍 +computePerDecade
    const c = s.realCompute.toNumber();
    const cb = tribulationComputeBase(s);
    const decades = (c > 0 && cb > 0) ? Math.log10(c / cb) : 0;
    const computeAdd = Math.max(0, Math.min(
      num(p.computeCap, 0.15), decades * num(p.computePerDecade, 0.03)
    ));

    // 功法造诣：每本修满的功法
    const perfect = perfectedTechniqueCount(s);
    const perfectAdd = Math.min(num(p.perfectCap, 0.10), perfect * num(p.perfectPer, 0.02));

    // 道行底蕴：累计道行
    const daoTotal = num(rebirthState(s).daoTotal, 0);
    const daoAdd = Math.min(
      num(p.daoCap, 0.08),
      (daoTotal / Math.max(1, num(p.daoPer, 2000))) * num(p.daoPerBonus, 0.01)
    );

    const raw = base + computeAdd + perfectAdd + daoAdd;
    const rate = Math.max(num(cfg.minRate, 0.05), Math.min(num(cfg.maxRate, 0.95), raw));

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
  function tribulationReady(s) {    if (!tribulationCfg().implemented) return false;
    const t = nextRealm(s);
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
  function tribulationRoll(s) {
    const st = tribulationState(s);
    let h = 2166136261;
    const feed = (x) => {
      let v = Math.floor(num(x, 0)) >>> 0;
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
    feed(rebirthCount(s) * 7919);
    // 取 [0,1)
    return (h >>> 0) / 4294967296;
  }

  /** 渡劫淬体的效果清单（界面用） */
  function tribulationBoonSummary(s, level) {
    const boon = tribulationCfg().boon || {};
    const lv = (level === undefined) ? tribulationLevel(s) : Math.max(0, Math.floor(num(level, 0)));
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
      const per = num(boon[k], 0);
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
  function tribulationSummary(s) {
    const cfg = tribulationCfg();
    if (!cfg.implemented) return null;
    const st = tribulationState(s);
    const t = nextRealm(s);
    const odds = tribulationOdds(s);
    const maxLevel = Math.max(0, Math.floor(num(cfg.maxLevel, 40)));
    return {
      implemented: true,
      level: tribulationLevel(s),
      maxLevel: maxLevel,
      attempts: st.attempts,
      failures: st.failures,
      /** 自动渡劫开关 */
      auto: s.autoTribulation !== false,
      /** 是否能立刻渡劫 */
      ready: tribulationReady(s),
      /** 已至最高境界（无劫可渡） */
      atMax: !t || !t.next,
      need: (t && t.need) ? t.need.toJSON() : null,
      progress: s.realmProgress ? s.realmProgress.toNumber() : 0,
      odds: odds,
      boons: tribulationBoonSummary(s),
      /** 下一次成功之后的层数 */
      nextLevel: Math.min(maxLevel, tribulationLevel(s) + 1),
      /** 最近一次结果（一次性提示） */
      won: st.won,
      lost: st.lost,
      passiveRules: {
        belowRealm: num((cfg.passiveRules || {}).belowRealm, 4),
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
  function doTribulation(s) {
    const cfg = tribulationCfg();
    if (!cfg.implemented) return { ok: false, msg: '渡劫系统未开放' };

    const t = nextRealm(s);
    if (!t || !t.next) return { ok: false, msg: '已至最高境界，无劫可渡' };
    if (!t.need || s.qi.lt(t.need)) return { ok: false, msg: '灵气未满，引不动天劫' };

    const st = tribulationState(s);
    const odds = tribulationOdds(s);
    st.attempts += 1;
    st.won = null;
    st.lost = null;

    const roll = tribulationRoll(s);

    if (roll >= odds.rate) {
      // ---- 失败：被动兵解 ----
      st.failures += 1;
      const info = {
        realm: s.realm,
        realmName: realmName(s.realm),
        rate: odds.rate,
        roll: roll,
        at: s.playTime,
      };
      const rb = doRebirth(s, 'passive');
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
    const maxLevel = Math.max(0, Math.floor(num(cfg.maxLevel, 40)));
    const oldMaxE = maxEnergy(s);
    s.qi = s.qi.sub(t.need);
    s.realm += 1;
    st.level = Math.min(maxLevel, st.level + 1);
    st.won = {
      realm: s.realm,
      realmName: realmName(s.realm),
      level: st.level,
      rate: odds.rate,
      at: s.playTime,
    };

    // 境界抬升 → 精力上限变高 → 按新上限补一段（与旧自动突破的行为一致）
    const newMaxE = maxEnergy(s);
    if (s.energy < newMaxE) s.energy = Math.min(newMaxE, s.energy + (newMaxE - oldMaxE));

    s.realmProgress = new D(0);
    s.shenshi = totalShenshi(s);
    s.realCompute = realComputeOf(s);

    return {
      ok: true,
      success: true,
      rate: odds.rate,
      roll: roll,
      realm: s.realm,
      realmName: realmName(s.realm),
      level: st.level,
      maxLevel: maxLevel,
      boons: tribulationBoonSummary(s),
    };
  }

  /**
   * 切换「自动渡劫」。
   *
   * 关掉之后，灵气满格也不会自己硬闯 —— 界面会停在「待渡劫」，
   * 让玩家先把算力堆厚（算力冗余最多能把成功率抬 15 个百分点）再动手。
   * 这是唯一一个能改变渡劫结果的玩家决策，所以开关必须显式存在。
   */
  function setAutoTribulation(s, on) {
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
  function setTimePaused(s, paused) {
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
  function rebirthAttenuate(s, value, useCap) {
    const n = rebirthCount(s);
    if (n <= 0) return value;
    if (!value || typeof value.gt !== 'function' || !value.gt(0)) return value;
    let out = D.pow(value, new D(rebirthFactorAt(n)));
    if (useCap) {
      const capBase = num(rebirthCfg().deviceComputeCapBase, 0);
      const capPer = num(rebirthCfg().deviceComputeCapPerRun, 0);
      if (capBase > 0) {
        const cap = capBase * Math.pow(10, capPer * (n - 1));
        const capD = new D(cap);
        if (out.gt(capD)) out = capD;
      }
    }
    return out;
  }

  /** 当前生效的转生衰减指数（1 = 不衰减）。界面与引擎共用同一口径。 */
  function rebirthDiscount(s) {
    return rebirthFactorAt(rebirthCount(s));
  }

  /** 当前生效的转生算力上限（未兵解时为 0 = 不限制） */
  function rebirthComputeCap(s) {
    const n = rebirthCount(s);
    if (n <= 0) return 0;
    const capBase = num(rebirthCfg().deviceComputeCapBase, 0);
    if (!(capBase > 0)) return 0;
    return capBase * Math.pow(10, num(rebirthCfg().deviceComputeCapPerRun, 0) * (n - 1));
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
  function deviceComputeEffective(s) {
    const raw = totalCompute(s);
    const n = rebirthCount(s);
    if (n <= 0) return raw;
    const st = rebirthState(s);
    const hasSnap = st.baseCompute && typeof st.baseCompute.gt === 'function';
    // 兼容旧存档：没有快照（或快照比现在还大，理论不该发生）→ 以现在为基准补拍
    const base = (hasSnap && !st.baseCompute.gt(raw)) ? st.baseCompute : raw;
    const capped = rebirthAttenuate(s, base, true);
    const growth = raw.gt(base) ? raw.sub(base) : new D(0);
    return capped.add(growth);
  }

  /** 兵解时快照设备存量（在 doRebirth 的重置完成之后调用） */
  function snapshotRebirthBase(s) {
    const st = rebirthState(s);
    st.baseCompute = totalCompute(s);
    st.baseShenshi = rawShenshiBonus(s);
  }

  /** raw 设备神识加成（不含衰减，不含境界 / 功法 / 渡劫那几份） */
  function rawShenshiBonus(s) {
    let bonus = 0;
    for (const dev of GAME.devices) {
      if (!dev.shenshiBonus) continue;
      const n = s.devices[dev.id] || 0;
      if (n > 0) bonus += dev.shenshiBonus * n;
    }
    return bonus;
  }

  function perkById(id) {
    return (rebirthCfg().perks || []).find((p) => p.id === id) || null;
  }

  /** 某项道行加成的当前等级 */
  function perkLevel(s, id) {
    return Math.max(0, Math.floor(rebirthState(s).perks[id] || 0));
  }

  /** 某项道行加成的当前累计效果（数值型） */
  function perkValue(s, id) {
    const p = perkById(id);
    if (!p) return 0;
    return perkLevel(s, id) * num(p.per, 0);
  }

  /** 升下一级需要的道行（已满级返回 0） */
  function perkCost(s, id) {
    const p = perkById(id);
    if (!p) return 0;
    const lv = perkLevel(s, id);
    if (lv >= num(p.maxLevel, 0)) return 0;
    return Math.ceil(num(p.cost, 0) * Math.pow(num(p.costGrowth, 1.8), lv));
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
  function rebirthDaoGain(s, mode) {
    const c = rebirthCfg();
    const base = num(c.daoBase, 100);
    const per = num(c.daoPerRun, 0.6);
    const raw = base * (1 + per * rebirthCount(s));
    const ratio = (mode === 'passive') ? num(c.passiveDaoRatio, 0.3) : 1;
    return Math.max(0, Math.floor(raw * ratio));
  }

  /** 是否达到兵解门槛（二次确认属于界面层的事） */
  function rebirthUnlocked(s) {
    if (!rebirthCfg().implemented) return false;
    const need = rebirthCfg().unlock || {};
    return (s ? s.realm : 0) >= num(need.realm, 4);
  }

  function rebirthLockedReason(s) {
    if (!rebirthCfg().implemented) return '转生系统未开放';
    if (rebirthUnlocked(s)) return '';
    const need = rebirthCfg().unlock || {};
    return '需达到「' + realmName(num(need.realm, 4)) + '」才能兵解';
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
  function doRebirth(s, mode) {
    const cfg = rebirthCfg();
    if (!cfg.implemented) return { ok: false, msg: '转生系统未开放' };

    const passive = (mode === 'passive');
    if (!passive && !rebirthUnlocked(s)) {
      return { ok: false, msg: rebirthLockedReason(s) || '尚未达到兵解条件' };
    }

    const wipe = cfg.wipe || {};
    const rules = tribulationCfg().passiveRules || {};
    const extra = cfg.passiveExtraWipe || {};
    const belowRealm = num(rules.belowRealm, 4);
    /**
     * 被动兵解在元婴之下要「全清」。
     * 注意方向：这是**在标准清空之外再加码**，不是替代 ——
     * 元婴及以上的失败仍然保留设备与功法，只是道行打三折。
     */
    const fullWipe = passive
      && rules.fullWipeBelow !== false
      && num(s.realm, 0) < belowRealm;

    const gain = rebirthDaoGain(s, mode);
    const before = {
      realm: s.realm,
      realmName: realmName(s.realm),
      money: s.money.toJSON(),
      deviceCompute: totalCompute(s).toJSON(),
    };

    // ---- 1. 道行结算（先结，后面的重置不会动它）----
    const st = rebirthState(s);
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
    const tst = tribulationState(s);
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
      setAllocation(s, {});
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
      bumpMarketVer();
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
    snapshotRebirthBase(s);
    // 注意：gameSeconds 与 playTime **绝不允许倒退** —— 前者是日期，后者是行情时钟
    s.shenshi = totalShenshi(s);
    s.realCompute = realComputeOf(s);
    s.energy = maxEnergy(s);

    return {
      ok: true,
      dao: gain,
      count: st.count,
      mode: passive ? 'passive' : 'active',
      fullWipe: fullWipe,
      discount: rebirthDiscount(s),
      lost: before,
    };
  }

  /**
   * 用道行升一级永久加成。
   * 每项都有硬上限（config.perks[].maxLevel）—— 转生是无限循环，没有上限的长线一定失控。
   */
  function buyPerk(s, id) {
    const p = perkById(id);
    if (!p) return { ok: false, msg: '加成不存在' };
    const lv = perkLevel(s, id);
    const maxLv = num(p.maxLevel, 0);
    if (lv >= maxLv) return { ok: false, msg: '「' + p.name + '」已达上限 ' + maxLv + ' 级' };
    const cost = perkCost(s, id);
    const st = rebirthState(s);
    if ((st.dao || 0) < cost) {
      return { ok: false, msg: '道行不足（需要 ' + cost + '，当前 ' + Math.floor(st.dao || 0) + '）' };
    }
    st.dao = Math.floor(st.dao - cost);
    st.perks[id] = lv + 1;
    // 有些加成会改乘区，立刻刷新派生量
    s.shenshi = totalShenshi(s);
    s.realCompute = realComputeOf(s);
    return { ok: true, id: id, name: p.name, level: lv + 1, cost: cost, daoLeft: st.dao };
  }

  /** 转生概览（界面与接口层共用） */
  function rebirthSummary(s) {
    const cfg = rebirthCfg();
    if (!cfg.implemented) return null;
    const st = rebirthState(s);
    const perks = (cfg.perks || []).map((p) => {
      const lv = perkLevel(s, p.id);
      const maxLv = num(p.maxLevel, 0);
      return {
        id: p.id, name: p.name, desc: p.desc || '',
        level: lv, maxLevel: maxLv, maxed: lv >= maxLv,
        per: num(p.per, 0), unit: p.unit || '',
        cost: perkCost(s, p.id),
        /** 当前生效的总效果 */
        value: lv * num(p.per, 0),
      };
    });
    return {
      implemented: true,
      count: st.count,
      dao: Math.floor(st.dao || 0),
      daoTotal: Math.floor(st.daoTotal || 0),
      discount: rebirthDiscount(s),
      unlocked: rebirthUnlocked(s),
      lockedReason: rebirthLockedReason(s),
      /**
       * 面板是否展开。
       * 注意与 unlocked 的区别：unlocked 是「现在能不能执行兵解」（境界 ≥ 元婴），
       * 而 visible 是「该不该给玩家看道行面板」—— 兵解之后境界会掉回凡人，
       * 如果面板跟着锁上，玩家就看不到自己的道行、也花不掉它。
       */
      visible: rebirthUnlocked(s) || st.count > 0,
      /** 现在兵解能拿多少道行 */
      daoGain: rebirthDaoGain(s, 'active'),
      /** 被动（渡劫失败）能拿多少 —— 主动的三折 */
      daoGainPassive: rebirthDaoGain(s, 'passive'),
      passiveRatio: num(cfg.passiveDaoRatio, 0.3),
      /** 下一次兵解之后的衰减指数（用同一个函数算，避免界面与引擎给出两个数） */
      nextDiscount: rebirthFactorAt(st.count + 1),
      perks: perks,
      history: st.history.slice(-8),
    };
  }

  // ---- 道行加成落到「非转生」参数上的那几项（离线 / 股市费率）----
  // 这三项原先写死在 GAME.offline / GAME.stock 里，现在由道行加成抬高/降低，
  // 也顺手把手册里「离线收益可通过升级提高」那条久未实现的设计接通了。

  /** 离线收益系数（基础 0.30 + 道行 · 离线延展，夹到 1.0） */
  function offlineRatio(s) {
    const c = GAME.offline || {};
    const v = num(c.ratio, 0.3) + perkValue(s, 'offlineRatio');
    return Math.max(0, Math.min(1, v));
  }

  /** 离线封顶时长（小时）= 基础 48 + 道行 · 离线恒长 */
  function offlineMaxHours(s) {
    const c = GAME.offline || {};
    return Math.max(1, num(c.maxHours, 48) + perkValue(s, 'offlineHours'));
  }

  /** 股市单边手续费 = 基础 0.5% − 道行 · 市场人脉（保底 0.01%） */
  function stockFee(s) {
    const base = num(stockCfg().fee, 0.005);
    const v = base - perkValue(s, 'marketFee');
    return v > 0.0001 ? v : 0.0001;
  }

  // ============================================================
  // 工作系统
  // ============================================================

  function jobById(id) {
    if (!id) return null;
    return GAME.jobs.find((j) => j.id === id) || null;
  }

  /** 单次耗时（游戏秒） */
  function jobDurationSeconds(job) {
    return (job.hours || 0) * SEC_PER_HOUR;
  }

  /** 某工作已完成次数 */
  function jobDoneCount(s, id) {
    return s.jobDone[id] || 0;
  }

  /** 工作是否已解锁 */
  function jobUnlocked(s, job) {
    if (!job) return false;
    const u = job.unlock || {};
    if (s.realm < (u.realm || 0)) return false;
    if (u.after && jobDoneCount(s, u.after.id) < u.after.times) return false;
    return true;
  }

  /** 未解锁的原因（用于前端显示） */
  function lockedReason(s, job) {
    if (!job) return '';
    const u = job.unlock || {};
    if (s.realm < (u.realm || 0)) {
      return '需达到「' + realmName(u.realm) + '」';
    }
    if (u.after && jobDoneCount(s, u.after.id) < u.after.times) {
      const prev = jobById(u.after.id);
      return '需先完成「' + (prev ? prev.name : u.after.id) + '」'
        + u.after.times + ' 次（当前 ' + jobDoneCount(s, u.after.id) + '/' + u.after.times + '）';
    }
    return '';
  }

  /** 单次工作的收益（不含各种被动/神识乘区，那些在 tick 里统一施加） */
  function jobIncome(job) {
    return {
      money: new D(job.money || 0),
      spirit: new D(job.spirit || 0),
      stone: new D(job.stone || 0),
    };
  }

  /** 选择工作；切到不同工作会清空当前进度 */
  function setJob(s, jobId) {
    const job = jobById(jobId);
    if (!job) return { ok: false, msg: '工作不存在' };
    if (!jobUnlocked(s, job)) return { ok: false, msg: lockedReason(s, job) || '尚未解锁' };
    if (s.jobId !== jobId) {
      s.jobId = jobId;
      s.jobProgress = 0;
    }
    s.working = true;
    return { ok: true, jobId: jobId };
  }

  /** 暂停 / 恢复自动工作 */
  function setWorking(s, on) {
    s.working = !!on;
    return { ok: true, working: s.working };
  }

  /**
   * 手动催工 —— 立即完成当前工作的若干份。
   * 会清空当前未完成的进度（那一份已经被你手动干完了），避免与自动结算重复计数。
   */
  function rushJob(s, times) {
    if (!GAME.rush.enabled) return { ok: false, msg: '手动催工未开放' };
    const job = jobById(s.jobId);
    if (!job) return { ok: false, msg: '尚未选择工作' };
    if (!s.working) s.working = true;

    const n = Math.max(1, Math.min(Math.floor(times || 1), 1000));
    let done = 0;
    let money = new D(0);
    let spirit = new D(0);
    let stone = new D(0);

    for (let i = 0; i < n; i++) {
      if (s.energy < job.energy) break;
      s.energy -= job.energy;
      money = money.add(new D(job.money || 0));
      if (job.spirit) spirit = spirit.add(new D(job.spirit));
      if (job.stone) stone = stone.add(new D(job.stone));
      s.jobDone[job.id] = (s.jobDone[job.id] || 0) + 1;
      s.totalJobs += 1;
      done += 1;
    }

    if (done === 0) return { ok: false, msg: '精力不足' };

    const moneyMul = (1 + passiveBonus(s, 'money')) * (1 + passiveBonus(s, 'allOutput'));
    const qiMul = qiMultiplier(s);
    const allOut = 1 + passiveBonus(s, 'allOutput');

    s.rushCount += done;
    s.jobProgress = 0;
    s.money = s.money.add(money.mul(moneyMul));
    if (qiMul > 0 && spirit.gt(0)) s.qi = s.qi.add(spirit.mul(qiMul));
    if (allOut > 0 && stone.gt(0)) s.spiritStone = s.spiritStone.add(stone.mul(allOut));

    return { ok: true, done: done, money: money.mul(moneyMul), spirit: spirit.mul(qiMul), stone: stone.mul(allOut) };
  }

  /**
   * 推进工作进度并结算完成的份数。
   * 精力不足时进度会停在满格等待恢复，而不是丢弃进度。
   * 注意：此处只算「原始收益」，乘区（被动 / 神识 / 功法）由 tick 统一施加。
   */
  function advanceWork(s, dtGame) {
    const job = jobById(s.jobId);
    const empty = { money: new D(0), spirit: new D(0), stone: new D(0), done: 0 };
    if (!job || !s.working || dtGame <= 0) return empty;

    const dur = jobDurationSeconds(job);
    if (dur <= 0) return empty;

    s.jobProgress += dtGame;

    let done = 0;
    let money = new D(0);
    let spirit = new D(0);
    let stone = new D(0);
    let guard = 0;

    while (s.jobProgress >= dur && guard < 100000) {
      if (s.energy < job.energy) {
        // 精力不够完成这一份：进度停在满格，恢复后继续
        s.jobProgress = dur;
        break;
      }
      s.energy -= job.energy;
      money = money.add(new D(job.money || 0));
      if (job.spirit) spirit = spirit.add(new D(job.spirit));
      if (job.stone) stone = stone.add(new D(job.stone));
      s.jobProgress -= dur;
      s.jobDone[job.id] = (s.jobDone[job.id] || 0) + 1;
      s.totalJobs += 1;
      done += 1;
      guard += 1;
    }

    if (guard >= 100000) s.jobProgress = s.jobProgress % dur;
    if (s.jobProgress > dur) s.jobProgress = dur;

    return { money: money, spirit: spirit, stone: stone, done: done };
  }

  // ============================================================
  // 功法系统
  // ============================================================

  function techById(id) {
    if (!id) return null;
    return GAME.techniques.list.find((t) => t.id === id) || null;
  }

  function rarityById(id) {
    return GAME.techniques.rarities.find((r) => r.id === id) || null;
  }

  /** 熟练度点数 → 段位索引 */
  function masteryTierOf(points) {
    let t = 0;
    for (let i = 0; i < MASTERY.length; i++) {
      if (points >= MASTERY[i].need) t = i;
    }
    return t;
  }

  /** 段位信息 */
  function masteryInfo(tier) {
    const i = Math.max(0, Math.min(PERFECT_TIER, Math.floor(tier || 0)));
    return MASTERY[i];
  }

  /** 当前修炼的功法对象 */
  function currentTech(s) {
    return s.technique ? techById(s.technique) : null;
  }

  /** 某功法的存档记录 */
  function techRecord(s, id) {
    return s.learned[id] || null;
  }

  /** 是否已习得某功法 */
  function techLearned(s, id) {
    return !!s.learned[id];
  }

  /** 某功法当前解锁条件是否满足（除「第一本需先有设备」外的通用条件） */
  /**
   * 归一化功法的成就条件。
   * 配置里允许两种写法（等价）：
   *   cond: { devicesOwned: 2 }                 ← 紧凑式：键 = 类型，值 = 参数
   *   cond: { type: 'devicesOwned', n: 2 }      ← 展开式
   * 归一化后统一为展开式，判定与文案都只认这一种。
   */
  function techCondOf(tech) {
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
  function techUnlockConditionMet(s, tech) {
    if (!tech) return false;
    if (s.realm < (tech.realm || 0)) return false;
    const need = tech.compute || 0;
    if (need > 0 && realComputeOf(s).lt(need)) return false;
    const c = techCondOf(tech);
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
      case 'tribulation':   return tribulationLevel(s) >= c.n;
      case 'rebirth':       return rebirthCount(s) >= c.n;
      case 'compute':       return realComputeOf(s).gte(c.n);
      default:              return false;
    }
  }

  /**
   * 成就条件的**当前进度**（图鉴显示「12/15 次」用）。
   * 返回 { cur, need }；该条件没有可比数字时返回 null。
   */
  function techCondProgress(s, tech) {
    const c = techCondOf(tech);
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
      case 'tribulation':   return { cur: tribulationLevel(s), need: c.n };
      case 'rebirth':       return { cur: rebirthCount(s), need: c.n };
      case 'compute':       return { cur: realComputeOf(s).toNumber(), need: c.n };
      default:              return null;
    }
  }

  /** 成就条件的**文案**（图鉴与锁定原因共用） */
  function techCondText(tech) {
    const c = techCondOf(tech);
    if (!c) return '';
    switch (c.type) {
      case 'jobsDone':      return '完成工作 ≥ ' + c.n + ' 次';
      case 'devicesOwned':  return '持有设备 ≥ ' + c.n + ' 台';
      case 'marketProfit':  return '在市场赚到第一笔钱';
      case 'marketRevenue': return '市场累计卖出收入 ≥ ' + fmtBig(c.amount);
      case 'stockProfit':   return '在股市赚到第一笔钱';
      case 'stockRealized': return '股市累计实现盈亏 ≥ ' + fmtBig(c.amount);
      case 'trades':        return '股市成交 ≥ ' + c.n + ' 笔';
      case 'pressurePeak':  return '市场抛压曾达到 ' + Math.round(c.peak * 100) + '%（清仓砸盘的痕迹）';
      case 'companyCycles': return '公司运转 ≥ ' + c.n + ' 个生产周期';
      case 'warehouse':     return '仓库扩容至 ' + c.level + ' 级';
      case 'tribulation':   return '渡劫淬体 ≥ ' + c.n + ' 层';
      case 'rebirth':       return '兵解 ≥ ' + c.n + ' 次';
      case 'compute':       return '实际算力 ≥ ' + fmtBig(c.n);
      default:              return '';
    }
  }

  /** 未习得的原因（前端展示用） */
  function techLockedReason(s, tech) {
    if (!tech) return '';
    if (s.realm < (tech.realm || 0)) return '需达到「' + realmName(tech.realm) + '」';
    const need = tech.compute || 0;
    if (need > 0 && realComputeOf(s).lt(need)) return '需算力达到 ' + fmtBig(need);
    const c = tech.cond;
    if (c && !techUnlockConditionMet(s, tech)) {
      return '条件：' + (techCondText(tech) || '未知的功法条件');
    }
    return '';
  }

  /** 是否已拿到第一本功法（第一本需要先拥有个人电脑） */
  function firstTechUnlocked(s) {
    const fu = GAME.techniques.firstUnlock;
    if (!fu) return true;
    return (s.devices[fu.device] || 0) >= fu.count;
  }

  /** 习得一本功法（内部） */
  function grantTechnique(s, id) {
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
  function learnTechniques(s) {
    const newly = [];
    const list = GAME.techniques.list;
    const first = list[0];

    // 第一本：需要先拥有指定设备（个人电脑）
    if (first && !s.learned[first.id] && firstTechUnlocked(s)) {
      if (grantTechnique(s, first.id)) newly.push(first.id);
    }

    // 后续：必须先有第一本，再满足境界 + 算力
    if (first && s.learned[first.id]) {
      for (const t of list) {
        if (s.learned[t.id]) continue;
        if (!techUnlockConditionMet(s, t)) continue;
        if (grantTechnique(s, t.id)) newly.push(t.id);
      }
    }

    return newly;
  }

  /** 累加熟练度并处理段位提升 / 被动转常驻。返回本次变化 */
  function addMastery(s, id, gain) {
    const rec = s.learned[id];
    if (!rec || !(gain > 0)) return null;
    const before = rec.tier;
    rec.mastery = Math.min(MAX_MASTERY, rec.mastery + gain);
    const tier = Math.max(rec.tier, masteryTierOf(rec.mastery));
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
  function cultivateSpeed(s) {
    const c = GAME.techniques.cultivate;
    return num(c.pointsPerSecond, 1) * shenshiCultivateMultiplier(s);
  }

  /** 参悟一次的灵气消耗 = 当前境界突破所需灵气 × 比例 */
  function comprehendCost(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const need = (r && r.need) || 100;
    return new D(need).mul(GAME.techniques.comprehend.qiCostRatio);
  }

  /** 参悟一次获得的熟练度 = 当前段位增量 × 比例 */
  function comprehendGain(tier) {
    const i = Math.max(0, Math.min(PERFECT_TIER - 1, Math.floor(tier || 0)));
    const delta = MASTERY[i + 1].need - MASTERY[i].need;
    return delta * GAME.techniques.comprehend.gainRatio;
  }

  /** 功法等级：由算力换算，无上限 */
  /**
   * 功法等级（v3.5）：**每本独立**，存在 `learned[id].level`，由经验累积升级，
   * 不再由总算力全局换算 —— 否则「换一本功法 = 换一个等级」，玩家没法选择主修。
   */
  function techLevel(s, tech) {
    if (!tech || !s.learned[tech.id]) return 0;
    const rec = s.learned[tech.id];
    return rec.level > 0 ? rec.level : 0;
  }

  /** 功法经验配置（缺失给安全默认值） */
  function techExpCfg() {
    return GAME.techniques.level || {};
  }

  /** 升到 lv+1 级需要的经验 */
  function techExpNeed(lv) {
    const c = techExpCfg();
    return num(c.expBase, 30) * Math.pow(num(c.expGrowth, 1.35), Math.max(0, lv || 0));
  }

  /**
   * 挂机基础经验速率（exp / 现实秒）= expPerLog10 × log10(1 + 实际算力)。
   * 算力跨 16 个数量级，取对数后是 0~16 的温和数字 —— 算力越高升得越快，
   * 但不会出现「算力翻倍等级翻倍」的爆炸；配合 expGrowth 的指数需求，
   * 等级成长是「越往后越慢、但永远在走」。
   */
  function techBaseExpRate(s) {
    const c = techExpCfg();
    const comp = realComputeOf(s).toNumber();
    if (!(comp > 0)) return 0;
    return num(c.expPerLog10, 1) * Math.log10(1 + comp);
  }

  /**
   * 某本功法当前的经验速率 —— **只有当前修炼的那本 > 0**。
   * 挂机基础（随算力）+ 功法算力投入（随投向份额）。
   */
  function techExpRateOf(s, tech) {
    if (!tech || s.technique !== tech.id) return 0;
    let rate = techBaseExpRate(s);
    const inv = GAME.investments.find((i) => i.id === 'technique');
    if (inv && investmentAvailable(s, inv)) {
      rate += investOutput(s, inv).toNumber() * num(techExpCfg().expPerInvest, 1);
    }
    return rate;
  }

  /**
   * 累加功法经验并处理升级（可一段 tick 连升多级）。返回升了的级数。
   * 经验只进 `id` 这一本 —— 当前修炼哪本，哪本吃经验。
   */
  function addTechExp(s, id, gain) {
    const rec = s.learned[id];
    if (!rec || !(gain > 0)) return 0;
    rec.exp = (rec.exp || 0) + gain;
    let ups = 0;
    let guard = 0;
    while (guard++ < 1000) {
      const need = techExpNeed(rec.level || 0);
      if (rec.exp < need) break;
      rec.exp -= need;
      rec.level = (rec.level || 0) + 1;
      ups += 1;
    }
    return ups;
  }

  /** 某功法主属性强度（灵气吸收速度加成，纯小数）。随等级与稀有度提升，无上限 */
  function techMainQiSpeed(s, tech) {
    if (!tech) return 0;
    const r = rarityById(tech.rarity);
    const base = r ? r.mainQiSpeed : 0;
    const lv = techLevel(s, tech);
    // 熟练度段位也吃主属性：入门 0.5 → 圆满 1.0。
    // 没有这一层，段位在修满（拿被动）之前只给一行文字，修炼毫无正反馈。
    const m = GAME.techniques.masteryMain || {};
    const mBase = num(m.base, 0.5);
    const mPer = num(m.perTier, 0.1);
    const rec = s.learned[tech.id];
    const tier = rec ? Math.max(0, Math.min(5, Math.floor(num(rec.tier, 0)))) : 0;
    return base * (1 + lv * GAME.techniques.level.mainPerLevel) * (mBase + mPer * tier);
  }

  /** 功法列表 + 各自状态（前端渲染用） */
  function techniqueList(s) {
    return GAME.techniques.list.map((t) => {
      const rec = s.learned[t.id] || null;
      const r = rarityById(t.rarity);
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
        level: rec ? techLevel(s, t) : 0,
        mastery: rec ? rec.mastery : 0,
        masteryTier: rec ? rec.tier : 0,
        masteryTierName: rec ? masteryInfo(rec.tier).name : masteryInfo(0).name,
        masteryNeed: rec && rec.tier < PERFECT_TIER ? MASTERY[rec.tier + 1].need : MAX_MASTERY,
        passiveActive: rec ? rec.passive : false,
        mainQiSpeed: rec ? techMainQiSpeed(s, t) : 0,
        lockedReason: rec ? '' : techLockedReason(s, t),
        /** v3.5：独立经验进度（图鉴与功法阁都用） */
        exp: rec ? (rec.exp || 0) : 0,
        expNeed: rec ? techExpNeed(rec.level || 0) : 0,
        expRate: rec ? techExpRateOf(s, t) : 0,
        /** 成就条件的展示文案（图鉴用；境界/算力解锁的功法为空串） */
        condText: techCondText(t),
        /** 成就条件进度（图鉴显示 12/15 用；无可数字化的条件为 null） */
        condProgress: rec ? null : techCondProgress(s, t),
        /** 图鉴用完整解锁文案：境界 / 算力 / 行为成就三合一 */
        unlockText: (function () {
          const parts = [];
          if (t.realm) parts.push('境界 · ' + realmName(t.realm));
          if (t.compute) parts.push('算力 ≥ ' + fmtBig(t.compute));
          const ct = techCondText(t);
          if (ct) parts.push(ct);
          if (!t.realm && !t.compute && !t.cond) parts.push('拥有第一台个人电脑');
          return parts.join('　+　');
        })(),
      };
    });
  }

  /** 累加所有「已修满」功法的被动属性值（切换功法不会消失） */
  function passiveBonus(s, key) {
    let sum = 0;
    for (const id of Object.keys(s.learned)) {
      const rec = s.learned[id];
      if (!rec || !rec.passive) continue;
      const t = techById(id);
      if (!t || !t.passive) continue;
      const v = t.passive[key];
      if (typeof v === 'number') sum += v;
    }
    return sum;
  }

  // ============================================================
  // 科技线计算
  // ============================================================

  /** 计算某设备的金钱单价（含 hardware 折扣 + 功法被动折扣） */
  function deviceCost(s, dev) {
    const owned = s.devices[dev.id] || 0;
    const base = new D(dev.cost).mul(D.pow(new D(dev.costGrowth), owned));
    const q = 1 + passiveBonus(s, 'deviceCost');
    return base.mul(hardwareCostFactor(s, dev)).mul(q > 0 ? q : 0.01);
  }

  /** 计算某设备的灵石单价（科技修仙设备的双造价） */
  function deviceStoneCost(s, dev) {
    if (!dev.stoneCost) return new D(0);
    const owned = s.devices[dev.id] || 0;
    return new D(dev.stoneCost).mul(D.pow(new D(dev.costGrowth), owned));
  }

  /** 计算玩家拥有的设备算力总量（不含 AI 加成与神识乘区） */
  function totalCompute(s) {
    let total = new D(0);
    for (const dev of GAME.devices) {
      const n = s.devices[dev.id] || 0;
      if (n > 0) total = total.add(new D(dev.compute).mul(n));
    }
    return total;
  }

  /** 科技修仙设备的灵石产出（每秒） */
  function deviceStoneOutput(s) {
    let total = new D(0);
    for (const dev of GAME.devices) {
      if (!dev.stonePerSecond) continue;
      const n = s.devices[dev.id] || 0;
      if (n > 0) total = total.add(new D(dev.stonePerSecond).mul(n));
    }
    return total;
  }

  /**
   * 实际算力 —— 设备算力 + AI 加成，再乘神识乘区与功法被动乘区。
   * 神识放大了算力的「效果」，但不改变设备本身的算力。
   */
  /**
   * 实际算力 = (设备算力 × 转生衰减 + AI 加成) × 神识乘区 ×(1 + 功法被动算力加成)。
   *
   * 两处刻意：
   *   a) 转生衰减只作用于**设备算力** —— AI 加成是「投向产出」，不是设备产能，不衰减。
   *   b) 神识乘区走 shenshiComputeMultiplier 的分层公式（境界线性 × 设备对数收敛），
   *      不再用「神识总量 × 固定系数」—— 那个口径在后期会爆炸。
   */
  function realComputeOf(s) {
    const base = D.add(deviceComputeEffective(s), s.aiBonus);
    const shenshiMul = shenshiComputeMultiplier(s);
    const passiveMul = (1 + passiveBonus(s, 'compute')) * (1 + tribulationBonus(s, 'compute'));
    return base.mul(shenshiMul).mul(passiveMul);
  }

  /**
   * 设备被动收益（每秒，现实时间）。
   * 设备不是主要收入（工作是 / 公司是），但它是稳产底盘 ——
   * 精力耗尽、无法工作时，只有设备还在产钱。
   */
  function autoIncome(s) {
    // 走 deviceComputeEffective：设备被动收益与「实际算力」共用同一份转生衰减。
    // 早先这里直接读 totalCompute（原值），于是兵解之后 realCompute 掉下去了、
    // 但挂机金钱收入还是兵解前的量级 —— 玩家几分钟就能把设备全买回来，
    // 主线等于没重来。凡是「由设备算力派生出来的产出」都必须吃同一份衰减。
    const base = D.add(deviceComputeEffective(s), s.aiBonus);
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
  function qiMultiplier(s) {
    if (!spiritAllowed(s)) return 0;
    let m = 1;
    const tech = currentTech(s);
    if (tech) m += techMainQiSpeed(s, tech);

    // 神识乘区（分层口径）—— 与修炼速度同源，避免两处各有一套系数而漂移
    m *= shenshiCultivateMultiplier(s);

    // 道行 · 灵气亲和：永久 +8% / 级，加在主循环最核心的环节上
    m *= 1 + perkValue(s, 'qiSpeed');

    // v3.5：「功法算力投入」不再直接加灵气倍率 —— 它的产出换算成**功法经验**，
    // 只喂当前修炼的那本（见 stepTick 的功法经验段）。倍率由功法等级自己长。

    m *= 1 + passiveBonus(s, 'allOutput');
    // 渡劫淬体 · 灵气吸收：每渡过一次 +6%，乘在主循环最核心的环节上
    m *= 1 + tribulationBonus(s, 'qiSpeed');
    return m > 0 ? m : 0;
  }

  /** 可参与分配的投向（排除未解锁的锁定项） */
  function allocatableInvestments(s) {
    return GAME.investments.filter((inv) => investmentAvailable(s, inv));
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
  function hasAnyTechnique(s) {
    if (!s || !s.learned) return false;
    for (const id of Object.keys(s.learned)) {
      if (s.learned[id]) return true;
    }
    return false;
  }

  /** 某投向是否所有条件都满足 */
  function investmentAvailable(s, inv) {
    if (!inv.locked) return true;
    // 「功法增幅」需要先习得功法（任意一本，不必正在修炼）
    if (inv.id === 'technique') return !!GAME.techniques.implemented && hasAnyTechnique(s);
    // 「工业产能」需要先成立公司 —— 没工厂就没有产能可分配
    if (inv.id === 'industry') {
      return !!GAME.company.implemented && companyFounded(s);
    }
    return false;
  }

  /** 某项投向的锁定原因（前端直接用，避免把「未成立公司」写成「未习得功法」） */
  function investmentLockReason(s, inv) {
    if (investmentAvailable(s, inv)) return '';
    if (inv.lockReason) return inv.lockReason;
    if (inv.id === 'technique') return '未习得功法';
    if (inv.id === 'industry') return '未成立公司';
    return '未解锁';
  }

  /**
   * 计算某投资方向的实际可用算力
   * 收益 = rate * compute^decay，其中 decay < 1 表示收益递减
   */
  /**
   * 快捷投向调整（v3.6）：把某一个方向设为指定份额，**其余可用方向按比例
   * 分掉剩余额度** —— 合计恒为 1，不会把别的方向清零。
   * 内部复用 setAllocation 的归一化与锁定过滤，保证口径一致。
   */
  function setAllocationShare(s, id, share) {
    const target = GAME.investments.find((i) => i.id === id);
    if (!target) return { ok: false, msg: '投向不存在' };
    if (!investmentAvailable(s, target)) {
      return { ok: false, msg: '该方向当前不可用' };
    }
    const v = Math.max(0, Math.min(1, Number(share) || 0));
    const next = {};
    let others = 0;
    for (const inv of GAME.investments) {
      if (inv.id === id) continue;
      if (!investmentAvailable(s, inv)) continue;
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
    return setAllocation(s, next);
  }

  function investOutput(s, inv) {
    if (!investmentAvailable(s, inv)) return new D(0);
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
  function investOutputRate(s, inv) {
    const out = investOutput(s, inv).toNumber();
    const unit = inv.unit || '';
    if (unit === 'qi') return out * qiMultiplier(s);
    if (unit === 'compute') return out * num(inv.aiToCompute, 0);
    if (unit === 'discount') return out;
    if (unit === 'techexp') return out * techExpCfg().expPerInvest;
    if (unit === 'industrial') return industrialComputePool(s).toNumber();
    return out;
  }

  /**
   * hardware 累积折扣参数（v3.5）。配置缺失时给安全默认值。
   */
  function hardwareAccumCfg() {
    const inv = GAME.investments.find((i) => i.id === 'hardware') || {};
    const a = inv.accum || {};
    return {
      maxRed: num(a.maxRed, 0.6),
      dilution: num(a.dilution, 0.5),
    };
  }

  /** 累积议价值（D） */
  function investedHardwareOf(s) {
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
  function hardwareCostFactor(s, dev) {
    const cfg = hardwareAccumCfg();
    const X = investedHardwareOf(s).toNumber();
    if (!(cfg.maxRed > 0) || !(X > 0) || !dev) return 1;
    const owned = s.devices[dev.id] || 0;
    const cost = new D(dev.cost).mul(D.pow(new D(dev.costGrowth), owned)).toNumber();
    if (!(cost > 0)) return 1;
    const red = cfg.maxRed * X / (X + cost * cfg.dilution);
    return Math.max(1 - cfg.maxRed, 1 - red);
  }

  // ============================================================
  // 修仙线
  // ============================================================

  /** 获取当前境界信息 */
  function realmInfo(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    return r || GAME.realms[0];
  }

  /**
   * 当前境界的升级目标信息
   * 语义：realms[i].need 表示「从 realms[i] 突破到 realms[i+1] 所需的灵气」
   * 返回 { current, next, need }；已至最高境界时 next 为 null、need 为 null
   */
  function nextRealm(s) {
    const current = realmInfo(s);
    const next = GAME.realms[s.realm + 1] || null;
    if (!next) return { current: current, next: null, need: null };
    return { current: current, next: next, need: new D(current.need) };
  }

  /** 是否已习得功法 */
  function techniqueUnlocked(s) {
    return !!s.technique;
  }

  /** 当前是否允许产出灵气 —— 没功法就不允许（用户要求） */
  function spiritAllowed(s) {
    if (!GAME.techniques.requireForSpirit) return true;
    return techniqueUnlocked(s);
  }

  /** 大数简写（提示文案用）：1234 → 1.23e3 */
  function fmtBig(v) {
    if (v === null || v === undefined) return '0';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (Math.abs(n) < 1e4) return String(Math.round(n));
    return n.toExponential(2).replace('e+', 'e');
  }

  // ============================================================
  // 公司（产业）系统
  // ============================================================
  //
  // 与「工作」的分工：
  //   工作 = 职业 → 别人雇你，单次收益固定，消耗精力，随游戏内时间推进。
  //   公司 = 产业 → 自己生产商品、自己卖，收益随市价浮动，**不消耗精力**，
  //                但每周期扣维护费（原料 + 人工），仓库满了会压货停产。
  //
  // 生产周期挂在**现实时间**上（与精力同理），因此它是一条与时间档位解耦的
  // 产能上限：拉满档位不会让公司多产一分钱，只会让工作更强。
  //
  // 市价的关键约束：**必须可确定性复现**。
  // 前端每 100ms tick 一次、后端离线一次性结算 48 小时，两边都要算出同一个价格，
  // 否则「屏幕上看到的钱」和「服务器存的钱」就会对不上。所以这里不用 Math.random，
  // 而是把 (商品序号, 期数) 喂进一个散列函数 —— 同一个输入永远得到同一个价格。

  function companyCfg() { return GAME.company; }

  function lineById(id) {
    if (!id) return null;
    return GAME.company.lines.find((l) => l.id === id) || null;
  }

  function goodById(id) {
    if (!id) return null;
    return GAME.company.goods.find((g) => g.id === id) || null;
  }

  function goodIndex(id) {
    return GAME.company.goods.findIndex((g) => g.id === id);
  }

  /** 确定性散列 → [0, 1)。同一个 x 永远得到同一个值（前后端一致性靠它） */
  function hash01(x) {
    const v = Math.sin(x) * 43758.5453123;
    return v - Math.floor(v);
  }

  /** 商品在指定期数下的「相对基准价倍数」 */
  function goodsPriceFactor(good, period) {
    // 第 0 期 = 开市，直接按基准价挂牌 —— 否则配置里的 basePrice 就不是玩家
    // 第一眼看到的价格，调数值时会失去参照。
    if (period <= 0) return 1;
    const i = goodIndex(good.id);
    const noise = hash01(period * 1.7 + i * 3.1 + 0.5) * 2 - 1;  // 当期噪声
    const drift = hash01(period * 0.37 + i * 7.3) * 2 - 1;       // 慢漂移
    const wave = Math.sin((period + i * 2.4) * 0.9);             // 周期波动
    let f = 1 + good.volatility * (0.5 * noise + 0.3 * wave + 0.2 * drift);
    const lo = good.minFactor || 0.2;
    const hi = good.maxFactor || 5;
    if (f < lo) f = lo;
    if (f > hi) f = hi;
    return f;
  }

  /**
   * 行情时钟 —— 市场与股市的「期」都按**现实秒**计。
   *
   * 用 playTime（现实秒累计）而不是 gameSeconds：时间档位只该加速工作，
   * 不该加速行情。否则档 4（1 秒 = 1 游戏月）下 1 游戏年只剩 12 现实秒，
   * 抛压与股市冲击 4 期就衰减干净，「砸盘被压价 / 大单砸自己」的代价被档位抹掉。
   */
  function marketClock(s) {
    return (s && s.playTime) || 0;
  }

  /** 商品的变价周期（**现实秒**）：科技类 60 秒，修仙类 600 秒 */
  function goodsPeriodSeconds(good) {
    return Math.max(1, good.periodSeconds || 60);
  }

  /** 商品当前处于第几期（按现实时间推进，与时间档位无关） */
  function goodsPeriod(good, realSeconds) {
    return Math.floor(Math.max(0, realSeconds || 0) / goodsPeriodSeconds(good));
  }

  /** 商品当前市价 */
  function goodsPrice(good, realSeconds) {
    if (!good) return new D(0);
    return new D(good.basePrice).mul(goodsPriceFactor(good, goodsPeriod(good, realSeconds)));
  }

  /** 相对上一期的涨跌：'up' / 'down' / 'flat' */
  function goodsTrend(good, realSeconds) {
    const p = goodsPeriod(good, realSeconds);
    if (p <= 0) return 'flat';
    const cur = goodsPriceFactor(good, p);
    const prev = goodsPriceFactor(good, p - 1);
    if (cur > prev * 1.004) return 'up';
    if (cur < prev * 0.996) return 'down';
    return 'flat';
  }

  /** 距下次变价还剩多少现实秒 */
  function goodsNextChangeIn(good, realSeconds) {
    const len = goodsPeriodSeconds(good);
    const rem = Math.max(0, realSeconds || 0) % len;
    return len - rem;
  }

  /**
   * 取商品在 [fromPeriod, toPeriod] 内每一期的挂牌价。
   *
   * 价格是「期数」的确定性函数（goodsPriceFactor 不含随机数），所以历史和未来
   * 都能直接算出来 —— 前端画走势图不需要另存任何历史数据，也不会因为刷新而
   * 出现线条断档。第 0 期固定为基准价（开市）。
   *
   * @returns {Array<{period:number, price:Decimal, t:number}>} 按时间升序，含首尾
   */
  function goodsSeries(good, fromPeriod, toPeriod) {
    if (!good) return [];
    const a = Math.max(0, Math.floor(fromPeriod));
    const b = Math.max(a, Math.floor(toPeriod));
    const len = goodsPeriodSeconds(good);
    const out = [];
    for (let p = a; p <= b; p++) {
      out.push({
        period: p,
        price: new D(good.basePrice).mul(goodsPriceFactor(good, p)),
        /** 该期起点的时间戳（现实秒，与 marketClock 同口径） */
        t: p * len,
      });
    }
    return out;
  }

  /**
   * 以当前时间为基准，取前 past 期 ~ 后 future 期的走势（含当前期）。
   *
   * 注意一个开局边界：修仙类商品每 600 现实秒才变一次价，游戏刚开始时序列里
   * 只有「第 0 期」一个点，连不成线，折线图会整个空白。所以当窗口退化成单期
   * 时，向后补一期 —— 让图上至少有一条从基准价出发的线段。
   */
  function goodsWindow(good, realSeconds, past, future) {
    const p = goodsPeriod(good, realSeconds);
    const from = Math.max(0, p - (past || 0));
    let to = p + (future || 0);
    if (to <= from) to = from + 1;
    return goodsSeries(good, from, to);
  }

  // ============================================================
  // 市场抛压 —— 「卖得多，价格被压低」的反噬
  // ============================================================
  //
  // 与 goodsPriceFactor 一样是**纯确定性**的：只读存档里的卖出/产出计数，
  // 不使用随机数。前端 tick 与后端离线结算必须算出同一个价格。
  //
  // 语义链：
  //   本期卖出 > 本期产出  →  差额是「净抛售」（动用库存 / 停售囤货后集中出货）
  //   净抛售 ÷ 参考成交量  →  本期新增压力 add
  //   压力在**期切换时**结算   →  当期卖出的货，影响的是**下一期**的开市价
  //   之后每期按 decay 衰减   →  砸盘的影响会过去，价格会爬回来

  function marketCfg() { return GAME.company.market || {}; }

  function marketDecay() {
    const d = marketCfg().decay;
    return (typeof d === 'number' && d >= 0 && d <= 1) ? d : 0.5;
  }

  /** 某商品当前生效的抛压（0 ~ 1） */
  function pressureOf(s, goodId) {
    const m = (s && s.company && s.company.pressure) || {};
    const v = Number(m[goodId]);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v > 1 ? 1 : v;
  }

  /** 本期净抛售件数 = max(0, 本期卖出 − 本期产出)。正常清仓时为 0。 */
  function excessSold(s, goodId) {
    const c = (s && s.company) || {};
    const sold = (c.soldThisPeriod && c.soldThisPeriod[goodId]) || 0;
    const prod = (c.producedThisPeriod && c.producedThisPeriod[goodId]) || 0;
    return Math.max(0, sold - prod);
  }

  /**
   * 把本期净抛售换算成压力增量（0 ~ 1）。
   *
   * @param {number} periods 本次结算跨越了几期（在线通常为 1，离线可能很大）。
   *
   * 为什么要除以 periods：计数器**只在期切换时才清零**，所以离线一次跨 n 期时，
   * 卖出/产出都是「n 期的累计量」。如果直接拿累计量相减，会出现一个致命漏洞 ——
   * 囤满 n 期再一次性清仓，卖出 ≈ 产出，净抛售约等于 0，砸盘反而**不受罚**。
   * 按期末均摊之后，「每期净抛售」才是真正的信号。
   *
   * 分母取 max(baseVolume, 每期产出)：产能越大，市场对正常吞吐量的预期越高，
   * 同样多的净抛售反而压不动价格 —— 这是「扩张产能不自我惩罚」的关键。
   */
  function pressureAdd(s, goodId, periods) {
    const c = (s && s.company) || {};
    const n = Math.max(1, periods || 1);
    const sold = ((c.soldThisPeriod && c.soldThisPeriod[goodId]) || 0) / n;
    const prod = ((c.producedThisPeriod && c.producedThisPeriod[goodId]) || 0) / n;
    const excess = Math.max(0, sold - prod);
    const ref = Math.max(1, marketCfg().baseVolume || 0, prod);
    const add = excess / ref;
    return add > 1 ? 1 : add;
  }

  /**
   * 指定「期」的抛压系数（maxDrop 之下，1 = 不受影响）。
   *
   *   过去期  → 1（历史价不可考，按自然价展示）
   *   当前期  → 实际压力
   *   未来期  → 压力按 decay 逐期恢复
   *
   * 未来期做衰减推算，是为了让折线图能直接告诉玩家「砸完这一刀之后，
   * 价格大概什么时候爬回来」。
   */
  function marketImpactAt(s, good, period) {
    const pr = pressureOf(s, good.id);
    if (pr <= 0) return 1;
    const cur = goodsPeriod(good, marketClock(s));
    if (period < cur) return 1;
    const eff = pr * Math.pow(marketDecay(), period - cur);
    const impact = 1 - eff * (marketCfg().maxDrop || 0);
    return impact < 0 ? 0 : impact;
  }

  /** 综合价格下限（相对基准价），兜住「自然波动下限 × 抛压下限」的叠加 */
  function marketFloorPrice(good) {
    return new D(good.basePrice).mul(marketCfg().floor || 0);
  }

  /**
   * 不受抛压影响的「自然价」（界面上用来对比「本应值多少」）。
   *
   *   自然价 = 基准价 × 行情波动因子 × 行业传导指数
   *
   * 第三项是产业链传导：上游行业的商品涨了，本行业的售价按 pricePass 打折跟涨。
   * 传 s 才会算传导（不传就只算行情，用于纯价格序列推导）。
   * realSeconds 省略时按 0 算（第 0 期 = 开市价）。
   */
  function naturalPrice(good, realSeconds, s) {
    if (!good) return new D(0);
    const t = (realSeconds === undefined || realSeconds === null) ? 0 : realSeconds;
    const base = new D(good.basePrice).mul(goodsPriceFactor(good, goodsPeriod(good, t)));
    if (!s) return base;
    return base.mul(industryPriceIndex(s, good.industry));
  }

  /** 带上抛压与行业传导之后的市价 —— 前端展示与结算都应该用这个 */
  function goodsPriceWith(s, good, realSeconds) {
    if (!good) return new D(0);
    const t = (realSeconds === undefined || realSeconds === null)
      ? marketClock(s) : realSeconds;
    const period = goodsPeriod(good, t);
    const natural = new D(good.basePrice).mul(goodsPriceFactor(good, period))
      .mul(s ? industryPriceIndex(s, good.industry) : 1);
    const price = natural.mul(marketImpactAt(s, good, period));
    const floor = marketFloorPrice(good);
    return price.lt(floor) ? floor : price;
  }

  /** 抛压造成的折价比例（0 ~ maxDrop），前端标色用 */
  function marketDropRatio(s, good) {
    // 必须带 s：自然价含行业传导，不传 s 会算出「没有传导的自然价」，
    // 折价率就不再是纯粹的抛压幅度了。
    const natural = naturalPrice(good, marketClock(s), s);
    if (natural.lte(0)) return 0;
    const now = goodsPriceWith(s, good);
    const r = natural.sub(now).div(natural).toNumber();
    return r > 0 ? r : 0;
  }

  /** 带抛压的价格序列（折线图用），多返回一个 impact 字段 */
  function goodsSeriesWith(s, good, fromPeriod, toPeriod) {
    if (!good) return [];
    const a = Math.max(0, Math.floor(fromPeriod));
    const b = Math.max(a, Math.floor(toPeriod));
    const len = goodsPeriodSeconds(good);
    const floor = marketFloorPrice(good);
    const out = [];
    // 行业传导是当前时刻的成本结构，不随期数变化 —— 所以整条序列乘同一个指数。
    // 这一步不能省：否则走势图上的当前点会和卡片上的标价对不上。
    const indIdx = s ? industryPriceIndex(s, good.industry) : 1;
    for (let p = a; p <= b; p++) {
      const impact = marketImpactAt(s, good, p);
      let price = new D(good.basePrice).mul(goodsPriceFactor(good, p)).mul(indIdx).mul(impact);
      if (price.lt(floor)) price = floor;
      out.push({ period: p, price: price, t: p * len, impact: impact });
    }
    return out;
  }

  /** 以当前期为基准、前后各若干期的带抛压走势 */
  function goodsWindowWith(s, good, past, future) {
    const p = goodsPeriod(good, marketClock(s));
    const from = Math.max(0, p - (past || 0));
    let to = p + (future || 0);
    if (to <= from) to = from + 1;
    return goodsSeriesWith(s, good, from, to);
  }

  /**
   * 市场抛压结算 —— 只在商品跨越「期」边界时执行。
   *
   * 为什么必须等到期切换：语义上「本期卖出」影响的是**下一期**的价格。
   * 玩家当期砸盘，当期成交价不变，下一期开市才发现被自己打下来了。
   *
   * 跨 n 期（离线常见）时的公式：
   *     add      = 每期净抛售 ÷ max(baseVolume, 每期产出)      ← 计数按 n 均摊
   *     pressure = pressure × decay^n + add × decay^(n-1)
   * add 只在跨越的第一期生效，之后每期只衰减。
   *
   * 「按 n 均摊」这一步不能省，理由见 pressureAdd 的注释 —— 否则囤货后清仓
   * 会因为「卖出 ≈ 产出」而被判定为没砸盘，反噬机制直接失效。
   *
   * 注意是「求和再夹到 1」，不是「取大值」—— 连续多期净抛售会累积，
   * 但上限就是满档，不会无限叠加。
   *
   * @returns {object|null} 本次结算的汇总
   */
  function syncMarket(s) {
    if (!companyFounded(s)) return null;
    const c = s.company;
    const d = marketDecay();
    const acc = { goods: 0, peak: 0, settled: {} };

    for (const g of GAME.company.goods) {
      const cur = goodsPeriod(g, marketClock(s));
      const last = Math.max(0, Math.floor((c.lastPeriod && c.lastPeriod[g.id]) || 0));
      if (cur <= last) continue;

      const n = cur - last;
      const old = pressureOf(s, g.id);
      const add = pressureAdd(s, g.id, n);
      let pr = old * Math.pow(d, n) + add * Math.pow(d, n - 1);
      if (!(pr > 0)) pr = 0;
      if (pr > 1) pr = 1;

      c.pressure[g.id] = pr;
      c.lastPeriod[g.id] = cur;
      // 本期计数清零，开始为**下一期**重新累积
      c.soldThisPeriod[g.id] = 0;
      c.producedThisPeriod[g.id] = 0;

      acc.goods += 1;
      acc.settled[g.id] = { pressure: pr, add: add, periods: n };
      if (pr > acc.peak) acc.peak = pr;
    }
    // 记录历史最高抛压（只增不减）——「操控市场」类功法成就的达成凭据
    if (acc.peak > (c.peakPressure || 0)) c.peakPressure = acc.peak;
    if (acc.goods > 0) bumpMarketVer();            // 抛压变了 → 传导缓存作废
    return acc;
  }

  /** 市场概览（前端与接口层共用），尽量返回可直接序列化的普通值 */
  function marketSummary(s) {
    if (!companyFounded(s)) return null;
    const m = marketCfg();
    const d = marketDecay();
    let peak = 0;
    const goods = GAME.company.goods.map((g) => {
      const p = pressureOf(s, g.id);
      if (p > peak) peak = p;
      const drop = marketDropRatio(s, g);
      const period = goodsPeriod(g, marketClock(s));
      // 当前「未结算窗口」跨了几期 —— 用来把累计计数换算成每期均值
      const win = Math.max(1, period - Math.max(0, Math.floor((s.company.lastPeriod && s.company.lastPeriod[g.id]) || 0)));
      const soldRaw = (s.company.soldThisPeriod && s.company.soldThisPeriod[g.id]) || 0;
      const prodRaw = (s.company.producedThisPeriod && s.company.producedThisPeriod[g.id]) || 0;
      return {
        id: g.id,
        name: g.name,
        pressure: p,
        dropRatio: drop,
        impact: 1 - drop,
        // 每期净抛售（正数 = 在砸库存）
        excess: Math.max(0, soldRaw / win - prodRaw / win),
        soldThisPeriod: soldRaw,
        producedThisPeriod: prodRaw,
        windowPeriods: win,
        // 抛压完全恢复到可忽略还需要几期
        recoverIn: p > 0 && d > 0 && d < 1 ? Math.ceil(Math.log(0.02) / Math.log(d)) : 0,
        price: goodsPriceWith(s, g),
        naturalPrice: naturalPrice(g, marketClock(s), s),
        nextPeriod: period + 1,
      };
    });
    return {
      peak: peak,
      warn: peak >= (m.warnAt || 0.45),
      maxDrop: m.maxDrop || 0,
      decay: d,
      floor: m.floor || 0,
      goods: goods,
    };
  }

  // ---------- 公司状态 ----------

  function companyFounded(s) {
    return !!(s.company && s.company.founded);
  }

  /** 是否达到「可以注册公司」的门槛（不含注册费是否够） */
  function companyUnlocked(s) {
    if (!GAME.company.implemented) return false;
    const need = GAME.company.unlock || {};
    return s.realm >= (need.realm || 0);
  }

  /** 不能注册 / 不能经营的原因（前端展示用） */
  function companyLockedReason(s) {
    if (!GAME.company.implemented) return '公司系统未开放';
    if (companyFounded(s)) return '';
    const need = GAME.company.unlock || {};
    if (s.realm < (need.realm || 0)) return '需达到「' + realmName(need.realm) + '」';
    if (s.money.lt(new D(GAME.company.foundCost))) {
      return '注册需金钱 ' + fmtBig(GAME.company.foundCost);
    }
    return '';
  }

  function warehouseLevel(s) {
    return Math.max(0, Math.floor((s.company && s.company.warehouseLevel) || 0));
  }

  /** 仓库容量（件） */
  function warehouseCapacity(s) {
    const w = GAME.company.warehouse;
    const lv = Math.min(w.maxLevel, warehouseLevel(s));
    return w.baseCapacity + lv * w.perLevel;
  }

  /** 下一级仓库的升级价格（已满级返回 0） */
  function warehouseCost(s) {
    const w = GAME.company.warehouse;
    const lv = warehouseLevel(s);
    if (lv >= w.maxLevel) return new D(0);
    return new D(w.baseCost).mul(D.pow(new D(w.costGrowth), lv));
  }

  /** 库存总件数 */
  function stockTotal(s) {
    if (!s.company) return 0;
    let n = 0;
    for (const g of GAME.company.goods) n += (s.company.stock[g.id] || 0);
    return n;
  }

  function stockOf(s, goodId) {
    return (s.company && s.company.stock[goodId]) || 0;
  }

  /** 生产线是否已解锁（境界 + 前置生产线数量） */
  function lineUnlocked(s, line) {
    if (!line || !companyFounded(s)) return false;
    if (s.realm < (line.realm || 0)) return false;
    const after = line.after;
    if (after && lineOwned(s, after.id) < after.times) return false;
    return true;
  }

  function lineLockedReason(s, line) {
    if (!line) return '';
    if (!companyFounded(s)) return '尚未成立公司';
    if (s.realm < (line.realm || 0)) return '需达到「' + realmName(line.realm) + '」';
    const after = line.after;
    if (after && lineOwned(s, after.id) < after.times) {
      const prev = lineById(after.id);
      return '需先拥有 ' + (prev ? prev.name : after.id) + ' ×' + after.times;
    }
    return '';
  }

  /** 买下第 n 条生产线的价格（按已有数量递增） */
  function lineCost(s, line) {
    if (!line) return new D(0);
    const owned = lineOwned(s, line.id);
    return new D(line.cost).mul(D.pow(new D(line.costGrowth), owned));
  }

  // ============================================================
  // 行业 · 生产线 · 工业算力
  // ============================================================
  //
  // 生产线不再绑定单一产物：一条线对应一个行业，可以随时改产这个行业的任意产物，
  // 也可以单独调这条线的产能。产能决定它占用多少算力、产多少货 —— 于是
  // 「买线」只是拿到产能上限，真正让它转起来的是**算力**。
  //
  // 存档结构：
  //   company.lines[lineId] = { units: [ { p: 产物id, r: 产能0~1 }, ... ] }
  // units 的长度就是这条线买了几台，**每台独立配置**（对应「单独调整每一台」）。

  function industryById(id) {
    if (!id) return null;
    return GAME.company.industries.find((x) => x.id === id) || null;
  }

  /** 某行业的全部产物 */
  function goodsOfIndustry(industryId) {
    return GAME.company.goods.filter((g) => g.industry === industryId);
  }

  /** 某条生产线能造的产物 —— 就是它所属行业的全部产物 */
  function lineProducts(line) {
    if (!line) return [];
    return goodsOfIndustry(line.industry);
  }

  function lineIndustry(line) {
    return line ? industryById(line.industry) : null;
  }

  // ---------- 成本传导 ----------
  //
  // 上游行业的商品涨了 → 本行业的成本按 passThrough 涨、售价只按 pricePass 涨。
  // pricePass 恒小于 passThrough，于是上游一涨，本行业「售价涨得比成本慢」，
  // 毛利被压缩。矿价暴涨时钢锭也贵，但炼钢厂反而更不赚钱 —— 这就是联动的体感。
  //
  // 上下游是按 tier 递增的有向无环图，所以递归一定终止；这里仍加一层深度守卫，
  // 防止配置写错（出现环）时把整个 tick 拖成栈溢出。

  /** 传导链上最多向上展开几层（超出就按「无传导」= 1 处理） */
  const IND_MAX_DEPTH = 8;

  /**
   * 传导缓存。
   *
   * 三个约束叠在一起，才把这条链从「指数级」压成「常数级」：
   *
   * 1. **必须显式传行业指数**（v3.2 的旧结论）：不能直接调 `goodsPriceWith`，
   *    否则它会再算回本行业的指数，每层展开「6 件商品 × 上游数」。
   * 2. **深度预算必须按「剩余层数」传参，不能用全局计数器**：这条调用链是
   *    ratio → index → upstreamRatio → ratio 的互递归，全局守卫管不到 index 那一环。
   *    融合产业链是 36 层串联，守卫一失效就是每层 ×上游数 的爆炸
   *    （v3.6 实测：第 24 只融合股单次推导 39 秒）。
   * 3. **按 (行业, 剩余层数) 记忆化**：状态空间只有 行业数 × 9，
   *    再深的链也只是把每个格子算一次 —— 指数级退化成线性。
   *
   * 缓存的失效条件是「行情时钟 + 抛压版本号」，两者任一变化就整体清空。
   */
  // 按 state 分桶（WeakMap），杜绝「A 玩家的缓存被 B 玩家读到」；
  // 桶内再按「行情时钟 + 抛压版本号」失效。
  let _indMemoStore = new WeakMap();
  /** 抛压版本号：凡是改了 s.company.pressure 的地方都要 bumpMarketVer() */
  let _mktVer = 0;
  function bumpMarketVer() { _mktVer += 1; }
  function indMemo(s) {
    const k = marketClock(s) + '|' + _mktVer;
    let e = (s && typeof s === 'object') ? _indMemoStore.get(s) : null;
    if (!e) {
      e = { key: '', map: new Map() };
      if (s && typeof s === 'object') _indMemoStore.set(s, e);
    }
    if (e.key !== k) { e.map.clear(); e.key = k; }
    return e.map;
  }

  /**
   * 某行业当前的「价格倍数」= 该行业全部商品 现价/基准价 的平均值（1 = 平价）。
   * rem = 还能向上展开的层数。
   */
  function industryPriceRatio(s, industryId) {
    return industryRatioAt(s, industryId, IND_MAX_DEPTH);
  }

  function industryRatioAt(s, industryId, rem) {
    const list = goodsOfIndustry(industryId);
    if (!list.length) return 1;
    if (rem <= 0) return 1;
    const memo = indMemo(s);
    const key = 'R|' + industryId + '|' + rem;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const index = industryIndexAt(s, industryId, rem);
    let sum = 0;
    for (const g of list) {
      const period = goodsPeriod(g, marketClock(s));
      let p = new D(g.basePrice)
        .mul(goodsPriceFactor(g, period))
        .mul(index)
        .mul(marketImpactAt(s, g, period));
      const floor = marketFloorPrice(g);
      if (p.lt(floor)) p = floor;
      sum += p.div(new D(g.basePrice)).toNumber();
    }
    const v = sum / list.length;
    memo.set(key, v);
    return v;
  }

  /** 上游综合价格倍数（多个上游行业等权平均） */
  function industryUpstreamRatio(s, industryId) {
    return industryUpstreamRatioAt(s, industryId, IND_MAX_DEPTH);
  }

  function industryUpstreamRatioAt(s, industryId, rem) {
    const ind = industryById(industryId);
    if (!ind || !ind.upstream || !ind.upstream.length) return 1;
    let sum = 0;
    for (const up of ind.upstream) sum += industryRatioAt(s, up, rem);
    return sum / ind.upstream.length;
  }

  /** 上游涨价 → 本行业**售价**的传导（打折跟涨） */
  function industryPriceIndex(s, industryId) {
    return industryIndexAt(s, industryId, IND_MAX_DEPTH);
  }

  function industryIndexAt(s, industryId, rem) {
    const ind = industryById(industryId);
    if (!ind) return 1;
    const pass = ind.pricePass || 0;
    if (pass <= 0) return 1;                       // 不跟涨 —— 不必展开上游
    if (rem <= 0) return 1;
    const memo = indMemo(s);
    const key = 'I|' + industryId + '|' + rem;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const up = industryUpstreamRatioAt(s, industryId, rem - 1);
    const v = 1 + (up - 1) * pass;
    memo.set(key, v);
    return v;
  }

  /** 上游涨价 → 本行业**成本**的传导（全额上涨，于是毛利被压缩） */
  function industryCostIndex(s, industryId) {
    return industryCostIndexAt(s, industryId, IND_MAX_DEPTH);
  }

  function industryCostIndexAt(s, industryId, rem) {
    const ind = industryById(industryId);
    if (!ind) return 1;
    const pass = ind.passThrough || 0;
    if (pass <= 0) return 1;
    if (rem <= 0) return 1;
    const memo = indMemo(s);
    const key = 'C|' + industryId + '|' + rem;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const up = industryUpstreamRatioAt(s, industryId, rem - 1);
    const v = 1 + (up - 1) * pass;
    memo.set(key, v);
    return v;
  }

  // ---------- 工业算力 ----------

  /** 「工业产能」投向提供的算力池（0 = 没成立公司或没拨算力） */
  function industrialComputePool(s) {
    if (!companyFounded(s)) return new D(0);
    const cfg = GAME.company.industrialCompute || {};
    const ratio = (typeof cfg.ratio === 'number') ? cfg.ratio : 1;
    const share = Math.max(0, Math.min(1, s.alloc.industry || 0));
    return s.realCompute.mul(share).mul(ratio);
  }

  /** 某条线的各台配置（永远是数组，没买过就是空数组） */
  function lineUnits(s, lineId) {
    const e = s.company && s.company.lines && s.company.lines[lineId];
    if (!e) return [];
    return Array.isArray(e.units) ? e.units : [];
  }

  function lineOwned(s, lineId) {
    return lineUnits(s, lineId).length;
  }

  /** 停机阈值：低于这个产能视为没开机（不产货、也不占算力） */
  function lineMinRate() {
    const cfg = GAME.company.industrialCompute || {};
    return (typeof cfg.minRate === 'number') ? cfg.minRate : 0.05;
  }

  /** 某台线当前是否在开工 */
  function unitActive(unit) {
    return !!unit && !!unit.p && (unit.r === undefined ? 1 : unit.r) >= lineMinRate();
  }

  /** 全厂算力总需求 = Σ(每条线 maxCompute × 该台产能) */
  function companyComputeDemand(s) {
    let need = new D(0);
    for (const line of GAME.company.lines) {
      const units = lineUnits(s, line.id);
      if (!units.length) continue;
      let r = 0;
      for (const u of units) if (unitActive(u)) r += Math.max(0, Math.min(1, u.r === undefined ? 1 : u.r));
      if (r <= 0) continue;
      need = need.add(new D(line.maxCompute).mul(r));
    }
    return need;
  }

  /**
   * 算力供给 / 需求的比值（>1 表示供大于求，此时钳到 1）。
   * **统一按比例削减**，不是先到先得 —— 于是算力不足时多买线不会凭空增产，
   * 只会把每条线摊薄。这是「工业产能」这条投向的全部意义。
   */
  function companyComputeScale(s) {
    const need = companyComputeDemand(s);
    if (need.lte(0)) return 1;
    const pool = industrialComputePool(s);
    if (pool.gte(need)) return 1;
    const v = pool.div(need).toNumber();
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }

  /**
   * 某台线一个周期的产量（件）。
   *
   *   产量 = 线基准产量 × 产物产量系数 × 产能 × 算力削减系数
   *
   * 产能与削减系数都是乘在产量上的，所以「算力不够 → 产能打折」与
   * 「自己把产能调低」在产量上是同一回事，只是前者不由玩家控制。
   */
  function unitOutput(s, line, unit, scale) {
    if (!unitActive(unit)) return 0;
    const g = goodById(unit.p);
    if (!g) return 0;
    const rate = Math.max(0, Math.min(1, unit.r === undefined ? 1 : unit.r));
    const sc = (scale === undefined) ? companyComputeScale(s) : scale;
    const coef = (typeof g.outputCoef === 'number') ? g.outputCoef : 1;
    return (line.baseOutput || 0) * coef * rate * sc;
  }

  /**
   * 每周期产出明细 { [goodId]: 件数 }（未受仓库容量限制）。
   * 件数可能是小数 —— 入库时再取整，避免低产能时「永远产 0 件」。
   */
  function companyOutputPerCycle(s) {
    const out = {};
    const scale = companyComputeScale(s);
    for (const line of GAME.company.lines) {
      const units = lineUnits(s, line.id);
      if (!units.length) continue;
      for (const u of units) {
        const n = unitOutput(s, line, u, scale);
        if (n <= 0) continue;
        out[u.p] = (out[u.p] || 0) + n;
      }
    }
    return out;
  }

  /**
   * 每周期维护费。
   *
   *   单件维护费 = 该产物当前售价 × 产物维护费率 × 行业成本指数
   *
   * 于是「不同产物维护费不同」（由 upkeepRate 与售价共同决定），
   * 而「上游涨价」通过 costIndex 直接抬升下游成本 —— 这是成本传导的落点。
   */
  function companyUpkeep(s) {
    let material = new D(0);
    let labor = new D(0);
    const scale = companyComputeScale(s);
    const cache = {};
    for (const line of GAME.company.lines) {
      const units = lineUnits(s, line.id);
      if (!units.length) continue;
      for (const u of units) {
        const n = unitOutput(s, line, u, scale);
        if (n <= 0) continue;
        const g = goodById(u.p);
        if (!g) continue;
        if (cache[g.industry] === undefined) cache[g.industry] = industryCostIndex(s, g.industry);
        const per = goodsPriceWith(s, g).mul(g.upkeepRate || 0.3).mul(cache[g.industry]);
        const total = per.mul(n);
        material = material.add(total.mul(0.66));
        labor = labor.add(total.mul(0.34));
      }
    }
    return { material: material, labor: labor, total: material.add(labor) };
  }

  /**
   * 每周期毛产出价值（按**当前市价**估算，已计入抛压与行业传导）。
   * 只是给界面看的预估值 —— 实际收益取决于结算那一刻的市价。
   */
  function companyCycleGross(s) {
    const out = companyOutputPerCycle(s);
    let v = new D(0);
    for (const id of Object.keys(out)) {
      const g = goodById(id);
      if (!g) continue;
      v = v.add(goodsPriceWith(s, g).mul(out[id]));
    }
    return v;
  }

  /** 每周期净收益 = 毛产出 − 维护费 */
  function companyCycleNet(s) {
    return companyCycleGross(s).sub(companyUpkeep(s).total);
  }

  // ---------- 生产线操作 ----------

  /**
   * 设置某台线的产物 / 产能。
   * @param {number} index 第几台（0-based）；传 -1 或 'all' 表示这条线的全部台
   */
  function setLineUnit(s, lineId, index, patch) {
    const line = lineById(lineId);
    if (!line) return { ok: false, msg: '生产线不存在' };
    if (!companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    const units = lineUnits(s, lineId);
    if (!units.length) return { ok: false, msg: '这条线还没有买入' };

    const products = lineProducts(line);
    const productOk = (id) => products.some((g) => g.id === id);

    const all = (index === 'all' || index === -1 || index === null || index === undefined);
    const targets = all ? units : [units[index]];
    if (!all && !targets[0]) return { ok: false, msg: '台号不存在' };

    if (patch && patch.product !== undefined) {
      if (!productOk(patch.product)) return { ok: false, msg: '这条线造不了该产物' };
    }
    let rate = null;
    if (patch && patch.rate !== undefined) {
      rate = Math.max(0, Math.min(1, Number(patch.rate) || 0));
      if (!Number.isFinite(rate)) return { ok: false, msg: '产能必须是数字' };
    }

    for (const u of targets) {
      if (patch && patch.product !== undefined) u.p = patch.product;
      if (rate !== null) u.r = rate;
    }
    return { ok: true, lineId: lineId, index: index, all: all, count: targets.length };
  }

  function companyIncomePerSecond(s) {
    if (!companyFounded(s)) return new D(0);
    const cyc = GAME.company.cycleRealSeconds || 1;
    return companyCycleNet(s).div(cyc);
  }

  // ---------- 公司操作 ----------

  /** 注册成立公司（消耗金钱） */
  function foundCompany(s) {
    if (!GAME.company.implemented) return { ok: false, msg: '公司系统未开放' };
    if (companyFounded(s)) return { ok: false, msg: '公司已成立' };
    const need = GAME.company.unlock || {};
    if (s.realm < (need.realm || 0)) {
      return { ok: false, msg: '需达到「' + realmName(need.realm) + '」' };
    }
    const cost = new D(GAME.company.foundCost);
    if (s.money.lt(cost)) return { ok: false, msg: '金钱不足，注册需 ' + fmtBig(GAME.company.foundCost) };
    s.money = s.money.sub(cost);
    s.company.founded = true;
    s.company.foundedDay = gameDate(s.gameSeconds).days;
    return { ok: true, cost: cost, foundedDay: s.company.foundedDay };
  }

  /** 买一条生产线 */
  function buyLine(s, lineId, count) {
    const line = lineById(lineId);
    if (!line) return { ok: false, msg: '生产线不存在' };
    if (!lineUnlocked(s, line)) {
      return { ok: false, msg: lineLockedReason(s, line) || '尚未解锁' };
    }
    // v3.6 批量购买：count 台逐台成交（每台都按当前拥有数重新计价），
    // 钱不够就停在最后一台买得起的——「买了多少是多少」。
    let want = Math.floor(Number(count) || 1);
    if (!(want > 0)) want = 1;
    if (want > 100) want = 100;

    let totalCost = new D(0);
    let bought = 0;
    let lastIndex = -1;
    let lastProduct = null;
    let lastCost = new D(0);
    while (bought < want) {
      const cost = lineCost(s, line);
      if (s.money.lt(cost)) break;
      s.money = s.money.sub(cost);
      totalCost = totalCost.add(cost);
      // 新买的一台是一份**独立配置**：默认产该行业第一个产物、产能拉满。
      // 买完想改产什么、开几成力，由 setLineUnit 单独调。
      const units = lineUnits(s, line.id).slice();
      const prods = lineProducts(line);
      units.push({ p: prods.length ? prods[0].id : null, r: 1 });
      s.company.lines[line.id] = { units: units };
      lastIndex = units.length - 1;
      lastProduct = units[units.length - 1].p;
      lastCost = cost;
      bought += 1;
    }
    if (bought === 0) return { ok: false, msg: '金钱不足' };
    return {
      ok: true, owned: lineUnits(s, line.id).length, cost: totalCost,
      bought: bought, asked: want,
      index: lastIndex, product: lastProduct, unitCost: lastCost,
    };
  }

  /** 升级仓库 */
  function upgradeWarehouse(s) {
    if (!companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    const w = GAME.company.warehouse;
    const lv = warehouseLevel(s);
    if (lv >= w.maxLevel) return { ok: false, msg: '仓库已至最高等级' };
    const cost = warehouseCost(s);
    if (s.money.lt(cost)) return { ok: false, msg: '金钱不足' };
    s.money = s.money.sub(cost);
    s.company.warehouseLevel = lv + 1;
    return { ok: true, level: s.company.warehouseLevel, capacity: warehouseCapacity(s), cost: cost };
  }

  /**
   * 按当前市价卖光库存（内部使用，不校验是否已成立公司）。
   * @returns {{revenue: D, sold: object}}
   */
  /**
   * 商品的**售卖货币**（v3.6）：
   *   科技系 → 金钱（1:1）
   *   修仙系 / 融合系 → 灵石 = 售价（金钱口径）× company.stoneExchange
   * 价格、行情、抛压、股市联动仍全部按金钱口径计算 —— 只在入账那一刻换货币。
   */
  function goodCurrency(g) {
    return (g && g.kind === 'tech') ? 'money' : 'stone';
  }

  /** 灵石换算系数（金钱口径售价 → 灵石） */
  function stoneExchangeRate() {
    return num(GAME.company.stoneExchange, 1e-4);
  }

  function sellAllInternal(s) {
    const sold = {};
    let moneyRev = new D(0);
    let stoneRev = new D(0);   // 金钱口径的销售额（入账前乘换算系数）
    for (const g of GAME.company.goods) {
      const n = s.company.stock[g.id] || 0;
      if (n <= 0) continue;
      const rev = goodsPriceWith(s, g).mul(n);
      if (goodCurrency(g) === 'stone') stoneRev = stoneRev.add(rev);
      else moneyRev = moneyRev.add(rev);
      sold[g.id] = n;
      s.company.stock[g.id] = 0;
      s.company.goodsSold[g.id] = (s.company.goodsSold[g.id] || 0) + n;
      // 记进「本期成交量」—— 抛压结算时与本期产出对比，多出来的部分就是砸盘
      s.company.soldThisPeriod[g.id] = (s.company.soldThisPeriod[g.id] || 0) + n;
    }
    const revenue = moneyRev.add(stoneRev);
    if (revenue.gt(0)) {
      // 总营业额（市场累计收入、成就口径）仍按金钱量级记全量
      s.company.totalRevenue = s.company.totalRevenue.add(revenue);
      s.money = s.money.add(moneyRev);
      const stone = stoneRev.mul(stoneExchangeRate());
      if (stone.gt(0)) s.spiritStone = s.spiritStone.add(stone);
    }
    return { revenue: revenue, money: moneyRev, stone: stoneRev.mul(stoneExchangeRate()), sold: sold };
  }

  /**
   * 卖出库存。goodId 传 'all'（或省略）表示清仓；否则只卖指定商品。
   * count 省略或 <= 0 表示该商品全部卖出。
   */
  function sellGoods(s, goodId, count) {
    if (!companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    if (goodId === undefined || goodId === null || goodId === 'all') {
      const r = sellAllInternal(s);
      if (!r.revenue.gt(0)) return { ok: false, msg: '仓库是空的' };
      return { ok: true, revenue: r.revenue, money: r.money, stone: r.stone, sold: r.sold, all: true };
    }
    const g = goodById(goodId);
    if (!g) return { ok: false, msg: '商品不存在' };
    const have = s.company.stock[g.id] || 0;
    if (have <= 0) return { ok: false, msg: '该商品没有库存' };

    const n = (!count || count <= 0) ? have : Math.min(have, Math.floor(count));
    const price = goodsPriceWith(s, g);
    const revenue = price.mul(n);
    s.company.stock[g.id] = have - n;
    s.company.goodsSold[g.id] = (s.company.goodsSold[g.id] || 0) + n;
    s.company.soldThisPeriod[g.id] = (s.company.soldThisPeriod[g.id] || 0) + n;
    s.company.totalRevenue = s.company.totalRevenue.add(revenue);
    const isStone = goodCurrency(g) === 'stone';
    const stone = isStone ? revenue.mul(stoneExchangeRate()) : new D(0);
    if (!isStone) s.money = s.money.add(revenue);
    if (stone.gt(0)) s.spiritStone = s.spiritStone.add(stone);
    return {
      ok: true, revenue: revenue, count: n, price: price, goodId: g.id,
      currency: isStone ? 'stone' : 'money', stone: stone,
    };
  }

  /** 开关自动卖出 */
  function setAutoSell(s, on) {
    if (!companyFounded(s)) return { ok: false, msg: '尚未成立公司' };
    s.company.autoSell = !!on;
    return { ok: true, autoSell: s.company.autoSell };
  }

  /**
   * 公司推进 —— 在 tick 内按现实秒累积，满一个周期就结算一次。
   *
   * 单个周期的结算顺序（不能打乱）：
   *   ① 扣维护费（钱不够 → 本周期停产，且不欠费）
   *   ② 各生产线产出并入库（仓库满 → 超出的部分直接放弃，形成经营压力）
   *   ③ 若开启自动卖出 → 立即按当前市价清仓
   *
   * @returns {object|null} 本次推进的汇总
   */
  function syncCompany(s, dt, offline) {
    if (!GAME.company.implemented) return null;
    if (!companyFounded(s)) return null;
    if (!(dt > 0)) return null;

    const eff = offline ? offlineRatio(s) : 1;
    if (offline && GAME.offline.companyWhileOffline === false) return null;

    const c = s.company;
    const cyc = Math.max(1, GAME.company.cycleRealSeconds);
    c.cycleProgress += dt * eff;

    const acc = {
      cycles: 0,
      revenue: new D(0),
      upkeep: new D(0),
      produced: 0,
      overflow: 0,
      starved: 0,
      sold: {},
    };

    let guard = 0;
    while (c.cycleProgress >= cyc && guard < 100000) {
      c.cycleProgress -= cyc;
      acc.cycles += 1;
      c.cycles += 1;

      // ① 维护费
      const up = companyUpkeep(s);
      if (s.money.lt(up.total)) {
        acc.starved += 1;
        continue;
      }
      s.money = s.money.sub(up.total);
      s.company.totalUpkeep = s.company.totalUpkeep.add(up.total);
      acc.upkeep = acc.upkeep.add(up.total);

      // ② 产出入库 —— 按「每台线各自产什么」汇总，产量受算力与产能双重缩放
      const outMap = companyOutputPerCycle(s);
      for (const goodId of Object.keys(outMap)) {
        // 产量可能是小数（低产能时不足一件），先攒着，够一件再入库，
        // 否则「开 1% 产能」会永远产 0 件
        c.pending[goodId] = (c.pending[goodId] || 0) + outMap[goodId];
        const whole = Math.floor(c.pending[goodId]);
        if (whole <= 0) continue;
        c.pending[goodId] -= whole;
        const room = Math.max(0, warehouseCapacity(s) - stockTotal(s));
        const put = Math.min(whole, room);
        if (put > 0) {
          c.stock[goodId] = (c.stock[goodId] || 0) + put;
          acc.produced += put;
          // 本期产出：抛压的分母。产得多说明市场本就该有这么多货，
          // 同量的卖出就不算「砸盘」。
          c.producedThisPeriod[goodId] = (c.producedThisPeriod[goodId] || 0) + put;
        }
        acc.overflow += whole - put;
      }

      // ③ 自动卖出
      if (c.autoSell) {
        const r = sellAllInternal(s);
        acc.revenue = acc.revenue.add(r.revenue);
        for (const k of Object.keys(r.sold)) acc.sold[k] = (acc.sold[k] || 0) + r.sold[k];
      }
      guard += 1;
    }

    return acc;
  }

  // ============================================================
  // 股市（证券账户）
  // ============================================================
  //
  // 与公司市场同样是**纯确定性**的：价格只依赖 (股票序号, 期数) 与存档里的
  // 成交流/持仓，不使用随机数。前端 tick 与后端离线结算必须算出同一个价格。
  //
  // 三层价格：
  //   波动因子   ← hash(股票序号, 期数)                 （行情本身）
  //   联动因子   ← 关联公司商品的价格与抛压             （与市场经济挂钩）
  //   冲击系数   ← 玩家自己的本期净买入与持仓集中度     （反作用，永远不利）
  //
  // 冲击为什么永远对玩家不利：成交按**成交后**的冲击价结算 —— 买入把 flow 推大、
  // 成交价被自己顶高；卖出把 flow 压小、成交价被自己砸低。而 flow 每期按
  // flowDecay 衰减，也就是「你买出来的溢价会自己退回去」，等它涨了再卖是拿不到的。
  // 唯一的盈利来源是赌对自然价的方向。

  function stockCfg() { return GAME.stock || {}; }

  function stockFlowDecay() {
    const d = stockCfg().flowDecay;
    return (typeof d === 'number' && d >= 0 && d <= 1) ? d : 0.5;
  }

  function stockById(id) {
    if (!id) return null;
    return GAME.stock.stocks.find((x) => x.id === id) || null;
  }

  function stockIndex(id) {
    return GAME.stock.stocks.findIndex((x) => x.id === id);
  }

  /** 股票是否已解锁（境界门槛） */
  function stockUnlocked(s) {
    if (!stockCfg().implemented) return false;
    const need = stockCfg().unlock || {};
    return (s ? s.realm : 0) >= (need.realm || 0);
  }

  /**
   * **单只**股票是否可交易（v3.6）：系统级开户之外，
   * 个股还可以有自己的 unlockRealm（融合赛道 50 家 = 元婴解锁）。
   */
  function stockAccessible(s, stock) {
    if (!stockUnlocked(s)) return false;
    if (!stock) return false;
    const need = stock.unlockRealm || 0;
    return (s ? s.realm : 0) >= need;
  }

  /** 逐股锁定原因（界面直接显示） */
  function stockAccessReason(s, stock) {
    if (stockUnlocked(s) && stock && (stock.unlockRealm || 0) > (s ? s.realm : 0)) {
      return '需达到「' + realmName(stock.unlockRealm) + '」解锁';
    }
    return '';
  }

  function stockLockedReason(s) {
    if (!stockCfg().implemented) return '股市系统未开放';
    if (stockUnlocked(s)) return '';
    const need = stockCfg().unlock || {};
    return '需达到「' + realmName(need.realm) + '」才能开户';
  }

  /** 流通盘（股）—— 冲击公式的分母，也是单只股票的持仓上限 */
  function stockDepth(stock) {
    if (!stock) return 1;
    return Math.max(1, Math.floor(stock.depth || 1));
  }

  /** 股票的变价周期（**现实秒**，与商品市场同一套口径） */
  function stockPeriodSeconds(stock) {
    return Math.max(1, stock.periodSeconds || 60);
  }

  /** 股票当前处于第几期（按现实时间推进，与时间档位无关） */
  function stockPeriod(stock, realSeconds) {
    return Math.floor(Math.max(0, realSeconds || 0) / stockPeriodSeconds(stock));
  }

  /**
   * 某只股票在指定期数下的「行情波动倍数」。
   *
   * 用 exp 而不是线性式：股票的摆动本来就该是**乘性**的（翻倍 / 腰斩），
   * 线性式在 v < 1 时最多只能摆动到 [1−v, 1+v]，做不出「妖股翻几倍」的效果。
   * v 的取值让区间约为 [e^−v, e^v]，再由 minFactor / maxFactor 兜住两端。
   *
   * 注意 exp 是超越函数，与 goodsPriceFactor 里的 Math.sin 同理 ——
   * 前后端都是 V8（Node 服务端 + Chromium 客户端），实现一致，可以复现。
   */
  function stockFactor(stock, period) {
    // 第 0 期 = 上市首日，按基准价挂牌，方便对着配置调数值
    if (period <= 0) return 1;
    const i = stockIndex(stock.id);
    const k = 0.45 * (hash01(period * 2.3 + i * 5.7 + 11.3) * 2 - 1)
      + 0.35 * Math.sin((period + i * 3.7) * 0.75)
      + 0.20 * (hash01(period * 0.41 + i * 9.1 + 3.3) * 2 - 1);
    let f = Math.exp((stock.volatility || 0) * k);
    const lo = stock.minFactor || 0.1;
    const hi = stock.maxFactor || 5;
    if (!Number.isFinite(f) || f <= 0) f = lo;
    if (f < lo) f = lo;
    if (f > hi) f = hi;
    return f;
  }

  /**
   * 与公司市场的联动因子。
   *
   * 联动的是「关联商品那一期的实际价格水平 / 基准价」—— 所以你在公司砸某商品的
   * 价格，对应股票也会跟着跌（抛压通过 marketImpactAt 传进来）。
   * linkWeight 把联动调成部分的：完全联动会让股票退化成商品的影子。
   */
  function stockLinkFactor(s, stock, period) {
    if (!stock || !stock.link) return 1;
    const g = goodById(stock.link);
    if (!g) return 1;
    const w = stockCfg().linkWeight;
    if (!(w > 0)) return 1;
    const t = period * stockPeriodSeconds(stock);
    const gp = goodsPeriod(g, t);
    // 与 naturalPrice 同一口径：行情波动 × 行业传导 × 抛压冲击。
    // 少了传导这一项，股票联动的幅度会跟商品自己的涨跌对不上。
    const ratio = goodsPriceFactor(g, gp)
      * industryPriceIndex(s, g.industry)
      * marketImpactAt(s, g, gp);
    return 1 + (ratio - 1) * w;
  }

  // ---------- 账户读数 ----------

  function stockShares(s, id) {
    const v = s && s.stock && s.stock.shares && s.stock.shares[id];
    const n = Math.floor(Number(v) || 0);
    return n > 0 ? n : 0;
  }

  /** 本期净买入股数（正 = 净买入，负 = 净卖出） */
  function stockFlow(s, id) {
    const v = s && s.stock && s.stock.flow && s.stock.flow[id];
    const n = Math.trunc(Number(v) || 0);
    return Number.isFinite(n) ? n : 0;
  }

  /** 持仓成本（含手续费） */
  function stockCost(s, id) {
    const v = s && s.stock && s.stock.cost && s.stock.cost[id];
    if (!v) return new D(0);
    return (v instanceof D) ? v : D.fromJSON(v);
  }

  /** 含费持仓均价 */
  function stockAvgCost(s, id) {
    const n = stockShares(s, id);
    if (n <= 0) return new D(0);
    return stockCost(s, id).div(n);
  }

  /** 持仓占流通盘的比例（0 ~ 1）—— 越高越「重仓难出」，冲击被放大 */
  function stockHeldRatio(s, stock) {
    const r = stockShares(s, stock.id) / stockDepth(stock);
    return r > 1 ? 1 : r;
  }

  /**
   * 冲击系数（1 = 不受影响）。
   * @param {number} sharesAfter 成交之后的持股数（用于算持仓集中度）
   * @param {number} flowAfter   成交之后的净买入流
   */
  function stockImpactAt(s, stock, sharesAfter, flowAfter) {
    const cfg = stockCfg();
    const depth = stockDepth(stock);
    const liq = 1 + Math.max(0, Number(sharesAfter) || 0) / depth * (cfg.illiquidity || 0);
    let raw = ((Number(flowAfter) || 0) / depth) * liq;
    if (!Number.isFinite(raw)) raw = 0;
    const hi = Number(cfg.maxRise) || 0;
    const lo = -(Number(cfg.maxDrop) || 0);
    if (raw > hi) raw = hi;
    if (raw < lo) raw = lo;
    return 1 + raw;
  }

  /** 当前时点的冲击系数（用玩家此刻真实持仓与本期的净买入流） */
  function stockImpact(s, stock) {
    return stockImpactAt(s, stock, stockShares(s, stock.id), stockFlow(s, stock.id));
  }

  // ---------- 价格 ----------

  function stockNaturalAtPeriod(s, stock, period) {
    return new D(stock.basePrice)
      .mul(stockFactor(stock, period))
      .mul(stockLinkFactor(s, stock, period));
  }

  /** 不受玩家成交影响的「自然价」 */
  function stockNaturalPrice(s, stock, realSeconds) {
    if (!stock) return new D(0);
    const t = (realSeconds === undefined || realSeconds === null)
      ? marketClock(s) : realSeconds;
    return stockNaturalAtPeriod(s, stock, stockPeriod(stock, t));
  }

  /** 指定期数的冲击衰减：过去期按 1（历史价不可考），未来期按 flowDecay 逐期恢复 */
  function stockImpactAtPeriod(s, stock, period) {
    const flow = stockFlow(s, stock.id);
    if (flow === 0) return 1;
    const cur = stockPeriod(stock, marketClock(s));
    if (period < cur) return 1;
    const dec = Math.pow(stockFlowDecay(), period - cur);
    return stockImpactAt(s, stock, stockShares(s, stock.id), flow * dec);
  }

  /** 当前成交价 = 自然价 × 冲击系数，并兜一道绝对下限 */
  function stockPrice(s, stock, realSeconds) {
    if (!stock) return new D(0);
    const t = (realSeconds === undefined || realSeconds === null)
      ? marketClock(s) : realSeconds;
    const nat = stockNaturalAtPeriod(s, stock, stockPeriod(stock, t));
    const px = nat.mul(stockImpact(s, stock));
    const fl = nat.mul(stockCfg().floor || 0);
    return px.lt(fl) ? fl : px;
  }

  /** 相对上一期的行情涨跌：'up' / 'down' / 'flat'（只看自然价，不看自己的冲击） */
  function stockTrend(s, stock) {
    const p = stockPeriod(stock, marketClock(s));
    if (p <= 0) return 'flat';
    const cur = stockNaturalAtPeriod(s, stock, p).toNumber();
    const prev = stockNaturalAtPeriod(s, stock, p - 1).toNumber();
    if (cur > prev * 1.004) return 'up';
    if (cur < prev * 0.996) return 'down';
    return 'flat';
  }

  /**
   * 下一期的预计涨跌幅（%），给事件通知栏的「行情前瞻」用。
   *
   * 价格是确定性的（由「股票序号 + 期数」散列推导），所以下一期**能算出来** ——
   * 这不是预测，是把已经定好的未来念出来。返回 null 表示算不出（新上市 / 配置缺失）。
   *
   * 刻意只看自然价、不含玩家自己的冲击：前瞻播报的是「行情」，不是「你的仓位」。
   */
  function stockForecastPct(s, stock) {
    if (!stock || !s || !stockCfg().implemented) return null;
    const p = stockPeriod(stock, marketClock(s));
    const cur = stockNaturalAtPeriod(s, stock, p).toNumber();
    if (!(cur > 0)) return null;
    const next = stockNaturalAtPeriod(s, stock, p + 1).toNumber();
    if (!Number.isFinite(next)) return null;
    return (next / cur - 1) * 100;
  }

  /** 距下次变价还剩多少现实秒 */
  function stockNextChangeIn(stock, realSeconds) {
    const len = stockPeriodSeconds(stock);
    const rem = Math.max(0, realSeconds || 0) % len;
    return len - rem;
  }

  /** [fromPeriod, toPeriod] 内每一期的价格（含冲击衰减），折线图用 */
  function stockSeries(s, stock, fromPeriod, toPeriod) {
    if (!stock) return [];
    const a = Math.max(0, Math.floor(fromPeriod));
    const b = Math.max(a, Math.floor(toPeriod));
    const len = stockPeriodSeconds(stock);
    const out = [];
    for (let p = a; p <= b; p++) {
      const nat = stockNaturalAtPeriod(s, stock, p);
      const impact = stockImpactAtPeriod(s, stock, p);
      let price = nat.mul(impact);
      const fl = nat.mul(stockCfg().floor || 0);
      if (price.lt(fl)) price = fl;
      out.push({ period: p, price: price, natural: nat, t: p * len, impact: impact });
    }
    return out;
  }

  /** 以当前期为基准、前后各若干期的走势（含当前期） */
  function stockWindow(s, stock, past, future) {
    const p = stockPeriod(stock, marketClock(s));
    const from = Math.max(0, p - (past || 0));
    let to = p + (future || 0);
    if (to <= from) to = from + 1;
    return stockSeries(s, stock, from, to);
  }

  /** 当前持仓市值 */
  function stockHoldingValue(s, stock) {
    return stockPrice(s, stock).mul(stockShares(s, stock.id));
  }

  /** 当前浮动盈亏（市值 − 含费成本） */
  function stockHoldingPnl(s, stock) {
    const n = stockShares(s, stock.id);
    if (n <= 0) return new D(0);
    return stockHoldingValue(s, stock).sub(stockCost(s, stock.id));
  }

  // ---------- 报价（前端预览与服务端结算共用同一份，保证数字一致）----------

  /**
   * 买入报价：按**成交后**的冲击价结算。
   * @returns {object} { ok, msg, shares, unitPrice, gross, fee, total, impact, natural, tooSmall }
   */
  function stockBuyQuote(s, stock, shares) {
    if (!stock) return { ok: false, msg: '股票不存在' };
    return stockBuyQuoteWith(s, stock, shares,
      stockNaturalPrice(s, stock), stockFee(s), stockCfg());
  }

  /**
   * stockBuyQuote 的实际实现：`nat` / `fee` 由调用方传入。
   *
   * 为什么要拆出来：`stockMaxBuy` 是一次二分查找（最多几十次迭代），
   * 而自然价与手续费在整个查找过程中**完全不变**。早先每次迭代都重新推导
   * 一遍自然价 —— 那是一条「行情因子 × 行业传导 × 公司联动」的链，
   * 单次就要几十微秒，乘上迭代数就是毫秒级。股市页每帧要对 50 只股票各来一次，
   * 每帧 30ms+ —— 这是「股市页卡顿」的第二个根因（第一个是行业传导的自引用）。
   */
  function stockBuyQuoteWith(s, stock, shares, nat, feeRate, cfg) {
    if (!stock) return { ok: false, msg: '股票不存在' };
    const want = Math.floor(Number(shares) || 0);
    if (!(want > 0)) return { ok: false, msg: '数量必须大于 0' };

    const depth = stockDepth(stock);
    const have = stockShares(s, stock.id);
    if (have + want > depth) {
      return { ok: false, msg: '超过流通盘上限（最多持有 ' + depth + ' 股）' };
    }

    const impact = stockImpactAt(s, stock, have + want, stockFlow(s, stock.id) + want);
    const unitPrice = nat.mul(impact);
    const gross = unitPrice.mul(want);
    const fee = gross.mul(feeRate);
    const total = gross.add(fee);
    return {
      ok: true, shares: want, unitPrice: unitPrice, gross: gross, fee: fee, total: total,
      impact: impact, natural: nat,
      tooSmall: gross.lt(new D(cfg.minOrder || 0)),
    };
  }

  /**
   * 卖出报价：同样按**成交后**的冲击价结算（卖得越多，均价越低）。
   * shares 省略或 <= 0 表示全部卖出。
   */
  function stockSellQuote(s, stock, shares) {
    const cfg = stockCfg();
    if (!stock) return { ok: false, msg: '股票不存在' };
    const have = stockShares(s, stock.id);
    if (have <= 0) return { ok: false, msg: '该股票没有持仓' };
    const want = (!shares || shares <= 0) ? have : Math.min(have, Math.floor(Number(shares) || 0));
    if (!(want > 0)) return { ok: false, msg: '数量必须大于 0' };

    const nat = stockNaturalPrice(s, stock);
    const impact = stockImpactAt(s, stock, have - want, stockFlow(s, stock.id) - want);
    const unitPrice = nat.mul(impact);
    const gross = unitPrice.mul(want);
    const fee = gross.mul(stockFee(s));
    return {
      ok: true, shares: want, unitPrice: unitPrice, gross: gross, fee: fee,
      net: gross.sub(fee), impact: impact, natural: nat,
      tooSmall: gross.lt(new D(cfg.minOrder || 0)),
    };
  }

  /**
   * 当前金钱最多能买多少股（0 = 一股都买不起）。
   *
   * 报价对股数是单调不减的（冲击有上限，涨到顶后就变成线性），所以用二分查找。
   * 查完再往回退几步兜住浮点边界，保证「最大」按钮给出的数字一定真的买得起。
   */
  function stockMaxBuy(s, stock) {
    if (!stock) return 0;
    const depth = stockDepth(stock);
    const have = stockShares(s, stock.id);
    let lo = 0;
    let hi = Math.max(0, depth - have);
    if (hi <= 0) return 0;
    // 自然价与手续费在整个二分过程中不变 —— 提出来，别在每次迭代里重算
    const nat = stockNaturalPrice(s, stock);
    const feeRate = stockFee(s);
    const cfg = stockCfg();
    const q1 = stockBuyQuoteWith(s, stock, 1, nat, feeRate, cfg);
    if (!q1.ok || q1.total.gt(s.money)) return 0;

    let guard = 0;
    while (lo < hi && guard++ < 64) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const q = stockBuyQuoteWith(s, stock, mid, nat, feeRate, cfg);
      if (q.ok && q.total.lte(s.money)) lo = mid;
      else hi = mid - 1;
    }
    guard = 0;
    while (lo > 0 && guard++ < 8) {
      const q = stockBuyQuoteWith(s, stock, lo, nat, feeRate, cfg);
      if (q.ok && q.total.lte(s.money)) break;
      lo -= 1;
    }
    return lo;
  }

  // ---------- 成交 ----------

  function buyStock(s, stockId, shares) {
    const stock = stockById(stockId);
    if (!stock) return { ok: false, msg: '股票不存在' };
    if (!stockUnlocked(s)) return { ok: false, msg: stockLockedReason(s) };
    if (!stockAccessible(s, stock)) return { ok: false, msg: stockAccessReason(s, stock) };

    const q = stockBuyQuote(s, stock, shares);
    if (!q.ok) return q;
    if (q.tooSmall) {
      return { ok: false, msg: '单笔成交额不足 ' + fmtBig(stockCfg().minOrder || 0) };
    }
    if (q.total.gt(s.money)) return { ok: false, msg: '金钱不足' };

    const c = s.stock;
    s.money = s.money.sub(q.total);
    c.shares[stock.id] = stockShares(s, stock.id) + q.shares;
    c.flow[stock.id] = stockFlow(s, stock.id) + q.shares;
    c.cost[stock.id] = stockCost(s, stock.id).add(q.total);
    c.totalFee = c.totalFee.add(q.fee);
    c.totalTrades += 1;

    return {
      ok: true, stockId: stock.id, shares: q.shares, unitPrice: q.unitPrice,
      gross: q.gross, fee: q.fee, total: q.total, impact: q.impact,
      sharesAfter: c.shares[stock.id],
    };
  }

  function sellStock(s, stockId, shares) {
    const stock = stockById(stockId);
    if (!stock) return { ok: false, msg: '股票不存在' };
    const have = stockShares(s, stock.id);
    if (have <= 0) return { ok: false, msg: '该股票没有持仓' };

    const q = stockSellQuote(s, stock, shares);
    if (!q.ok) return q;
    if (q.tooSmall) {
      return { ok: false, msg: '单笔成交额不足 ' + fmtBig(stockCfg().minOrder || 0) };
    }

    const c = s.stock;
    const avg = stockAvgCost(s, stock.id);
    const costOut = avg.mul(q.shares);
    const left = have - q.shares;

    s.money = s.money.add(q.net);
    c.shares[stock.id] = left;
    c.flow[stock.id] = stockFlow(s, stock.id) - q.shares;
    // 清仓时成本必须精确归零，否则残留的零头会让下次开仓的均价算歪
    c.cost[stock.id] = left > 0 ? stockCost(s, stock.id).sub(costOut) : new D(0);
    if (c.cost[stock.id].isNeg()) c.cost[stock.id] = new D(0);
    c.totalFee = c.totalFee.add(q.fee);
    c.totalTrades += 1;
    c.realized = c.realized.add(q.net.sub(costOut));

    return {
      ok: true, stockId: stock.id, shares: q.shares, unitPrice: q.unitPrice,
      gross: q.gross, fee: q.fee, net: q.net, impact: q.impact,
      costOut: costOut, profit: q.net.sub(costOut), sharesAfter: left,
    };
  }

  /**
   * 股市结算 —— 只在股票跨越「期」边界时执行：把上期的净买入流按 flowDecay 衰减。
   *
   * 为什么必须衰减：冲击是「你自己把价格推歪了多少」的度量。如果它永不消退，
   * 那么「买入 → 等价格维持在高位 → 卖出」就能白赚一笔冲击溢价。每期衰减保证了
   * 这笔溢价一定会退回去，于是任何一轮买→卖都只会亏掉溢价 + 双边手续费。
   *
   * @returns {object|null} 本次结算的汇总
   */
  function syncStocks(s) {
    const cfg = stockCfg();
    if (!cfg.implemented) return null;
    if (!s || !s.stock) return null;

    const c = s.stock;
    const d = stockFlowDecay();
    const acc = { stocks: 0, peak: 0, settled: {} };

    for (const st of GAME.stock.stocks) {
      const cur = stockPeriod(st, marketClock(s));
      const last = Math.max(0, Math.floor((c.lastPeriod && c.lastPeriod[st.id]) || 0));
      if (cur <= last) continue;

      const n = cur - last;
      const depth = stockDepth(st);
      let f = stockFlow(s, st.id) * Math.pow(d, n);
      if (!Number.isFinite(f)) f = 0;
      // 股数取整：flow 是「多少股」的计数，小数股没有意义，也会留下永不消失的尾巴
      f = Math.trunc(f);
      if (f > depth) f = depth;
      if (f < -depth) f = -depth;

      c.flow[st.id] = f;
      c.lastPeriod[st.id] = cur;

      acc.stocks += 1;
      const im = stockImpact(s, st);
      acc.settled[st.id] = { flow: f, impact: im, periods: n };
      const dev = Math.abs(im - 1);
      if (dev > acc.peak) acc.peak = dev;
    }
    return acc;
  }

  /** 股市概览（前端与接口层共用），尽量返回可直接序列化的普通值 */
  function stockSummary(s) {
    const cfg = stockCfg();
    if (!cfg.implemented) return null;
    if (!s || !s.stock) return null;

    const c = s.stock;
    let peak = 0;
    const list = GAME.stock.stocks.map((st) => {
      const price = stockPrice(s, st);
      const natural = stockNaturalPrice(s, st);
      const impact = stockImpact(s, st);
      const dev = Math.abs(impact - 1);
      if (dev > peak) peak = dev;

      const shares = stockShares(s, st.id);
      const cost = stockCost(s, st.id);
      const value = price.mul(shares);
      const pnl = shares > 0 ? value.sub(cost) : new D(0);
      const period = stockPeriod(st, marketClock(s));

      // 「清仓可变现」——按真实卖出的报价算（含冲击与手续费）。
      // 它一定小于等于按现价算的市值：市值里含着你自己的买入冲击溢价，
      // 而这份溢价在你卖的时候会被自己砸回去，拿不到手。所以盈亏要按可变现口径看。
      const liq = shares > 0 ? stockSellQuote(s, st, shares) : null;

      return {
        id: st.id, name: st.name, code: st.code, link: st.link || null,
        kind: st.kind || 'tech', sector: st.sector || null, business: st.business || '',
        basePrice: st.basePrice, depth: stockDepth(st),
        periodSeconds: stockPeriodSeconds(st),
        period: period, nextPeriod: period + 1,
        price: price, naturalPrice: natural,
        /** 市值 = 现价 × 流通盘 —— 榜单排序的依据 */
        marketCap: price.mul(stockDepth(st)),
        impact: impact, impactPct: impact - 1,
        shares: shares, heldRatio: stockHeldRatio(s, st),
        cost: cost, avgCost: stockAvgCost(s, st.id),
        value: value, pnl: pnl,
        pnlRatio: (shares > 0 && cost.gt(0)) ? pnl.div(cost).toNumber() : 0,
        liquidateValue: liq ? liq.net : new D(0),
        liquidatePnl: liq ? liq.net.sub(cost) : new D(0),
        liquidateImpact: liq ? liq.impact : 1,
        flow: stockFlow(s, st.id),
        trend: stockTrend(s, st),
        nextChangeIn: stockNextChangeIn(st, marketClock(s)),
        maxBuy: stockMaxBuy(s, st),
        unlocked: stockAccessible(s, st),
      };
    });

    let totalValue = new D(0);
    let totalCost = new D(0);
    let liquidateValue = new D(0);
    for (const x of list) {
      totalValue = totalValue.add(x.value);
      totalCost = totalCost.add(x.cost);
      liquidateValue = liquidateValue.add(x.liquidateValue);
    }
    const pnlAll = totalValue.sub(totalCost);
    const liquidatePnl = liquidateValue.sub(totalCost);

    // 榜单：按市值降序取前 N 家。界面只列这 10 家 ——
    // 但**交易对全部开放**（接口按 id 找，不在榜上也能买），
    // 否则「想买的刚好掉出前十」会变成硬性阻断，而榜单本就该随行情换人。
    // v3.6：**未解锁的个股不进榜**（融合赛道 50 家元婴后才上板），
    // 锁定行在列表里灰显展示、标注解锁条件。
    const boardSize = Math.max(1, Math.floor(cfg.boardSize || 10));
    const board = list.filter((x) => x.unlocked).slice().sort((a, b) => {
      if (b.marketCap.gt(a.marketCap)) return 1;
      if (b.marketCap.lt(a.marketCap)) return -1;
      return a.id < b.id ? -1 : 1;
    }).slice(0, boardSize);

    return {
      fee: stockFee(s),
      minOrder: cfg.minOrder || 0,
      flowDecay: stockFlowDecay(),
      maxRise: cfg.maxRise || 0,
      maxDrop: cfg.maxDrop || 0,
      illiquidity: cfg.illiquidity || 0,
      floor: cfg.floor || 0,
      linkWeight: cfg.linkWeight || 0,
      peak: peak,
      boardSize: boardSize,
      totalListed: list.length,
      totalValue: totalValue,
      totalCost: totalCost,
      pnl: pnlAll,
      pnlRatio: totalCost.gt(0) ? pnlAll.div(totalCost).toNumber() : 0,
      liquidateValue: liquidateValue,
      liquidatePnl: liquidatePnl,
      liquidatePnlRatio: totalCost.gt(0) ? liquidatePnl.div(totalCost).toNumber() : 0,
      realized: c.realized,
      totalFee: c.totalFee,
      totalTrades: c.totalTrades,
      /** 全部上市公司（交易用，前端可从这里做搜索/详情） */
      stocks: list,
      /** 市值前 N 家（界面列表用） */
      board: board,
      unlocked: stockUnlocked(s),
      lockedReason: stockLockedReason(s),
    };
  }

  // ============================================================
  // 核心 tick
  // ============================================================

  /**
   * 单段推进（内部使用）。dt 为现实秒，已被外层切分。
   * @returns {object} 本段收益
   */
  function stepTick(s, dt, offline, autoTribulation) {
    const ratio = offline ? offlineRatio(s) : 1;
    const speed = gameSecondsPerRealSecond(s);
    /** 本段 tick 内是否允许自动渡劫（默认允许；浏览器端会显式关掉） */
    const canTribulate = autoTribulation !== false;

    // 1. 游戏内时间推进
    const dtGame = dt * speed;
    s.gameSeconds += dtGame;

    // 2. 精力恢复（现实时间，与档位无关；**速度随境界提升**，见 energyRegen）
    const maxE = maxEnergy(s);
    s.energy = Math.min(maxE, s.energy + dt * energyRegen(s));

    // 3. 神识 / 实际算力（每段先刷新，保证后续投向产出用的是最新值）
    s.shenshi = totalShenshi(s);
    s.realCompute = realComputeOf(s);

    // 4. 功法习得检查（境界/算力/设备条件可能刚刚满足）
    learnTechniques(s);

    // 5. 工作推进与结算
    const work = advanceWork(s, dtGame);
    const moneyPassive = (1 + passiveBonus(s, 'money')) * (1 + tribulationBonus(s, 'money'));
    const allOut = 1 + passiveBonus(s, 'allOutput');
    /** 灵石产出乘区（渡劫淬体 · 灵石产出） */
    const stoneMul = 1 + tribulationBonus(s, 'stone');
    const qiMul = qiMultiplier(s);

    if (work.done > 0) {
      s.money = s.money.add(work.money.mul(ratio).mul(moneyPassive).mul(allOut));
      if (qiMul > 0 && work.spirit.gt(0)) s.qi = s.qi.add(work.spirit.mul(ratio).mul(qiMul));
      if (allOut > 0 && work.stone.gt(0)) {
        s.spiritStone = s.spiritStone.add(work.stone.mul(ratio).mul(allOut).mul(stoneMul));
      }
    }

    // 6. 设备被动收益
    const auto = autoIncome(s).mul(dt * ratio).mul(allOut);
    s.money = s.money.add(auto);

    // 7. 科技修仙设备的灵石产出
    const stoneOut = deviceStoneOutput(s).mul(dt * ratio).mul(allOut).mul(stoneMul);
    if (stoneOut.gt(0)) s.spiritStone = s.spiritStone.add(stoneOut);

    // 8. 算力投向产出
    let qiGain = new D(0);
    let financeGain = new D(0);
    let aiGain = new D(0);

    let techExpFromInvest = 0;
    for (const inv of GAME.investments) {
      const out = investOutput(s, inv).mul(dt * ratio);
      if (out.lte(0)) continue;
      s.produced[inv.id] = D.add(s.produced[inv.id], out);

      if (inv.id === 'finance') financeGain = financeGain.add(out);
      else if (inv.id === 'xiuxian') qiGain = qiGain.add(out);
      else if (inv.id === 'ai') aiGain = aiGain.add(out);
      else if (inv.id === 'hardware') {
        // v3.5：hardware 产出累积进议价值 —— 永久压低设备造价。
        // 拉没进度条只停止增长、不清空（见 hardwareCostFactor）。
        s.investedHardware = investedHardwareOf(s).add(out);
      } else if (inv.id === 'technique') {
        // v3.5：功法算力投入的产出换算成功法经验（只喂当前修炼的那本）
        techExpFromInvest += out.toNumber() * num(techExpCfg().expPerInvest, 1);
      }
    }

    s.money = s.money.add(financeGain.mul(allOut));
    if (qiMul > 0 && qiGain.gt(0)) s.qi = s.qi.add(qiGain.mul(qiMul));

    // AI 方向：把产出折算为算力增量，抬高算力总量。
    // 这是 AI 路线的核心价值 —— 它不只产钱，而是让「所有」路线的分母变大。
    if (aiGain.gt(0)) {
      const aiInv = GAME.investments.find((i) => i.id === 'ai');
      const k = (aiInv && aiInv.aiToCompute) || 0.02;
      s.aiBonus = s.aiBonus.add(aiGain.mul(k));
    }
    s.realCompute = realComputeOf(s);

    // 9. 市场抛压结算 —— **必须早于公司结算**：跨越期边界时要先把上一期的
    //    净抛售兑换成本期压力，公司这一段的产出与自动卖出才会用到新价格。
    const mkt = syncMarket(s);

    // 9b. 公司（产业）结算 —— 按现实秒累积生产周期：扣维护费 → 产出 → 入库/自动卖
    const comp = syncCompany(s, dt, offline);

    // 9c. 股市结算 —— 跨越期边界时把上期的净买入流按 flowDecay 衰减。
    //     必须排在公司之后：联动因子会读公司商品的抛压，先让公司那边结算完，
    //     同一段 tick 内看到的才是同一份行情。
    syncStocks(s);

    // 10. 功法修炼（涨熟练度）—— 修炼速度受神识加成
    if (s.cultivating && (!offline || GAME.offline.cultivateWhileOffline) && s.technique) {
      const gain = cultivateSpeed(s) * dt;
      if (gain > 0) addMastery(s, s.technique, gain);
    }

    // 10b. 功法经验（v3.5）—— **不依赖 cultivating 开关**：挂机就涨，
    //      算力越高越快，只喂当前修炼的那本；兵解不清等级。
    //      投向那份已在第 8 步算好（techExpFromInvest），这里补挂机基础。
    if (s.technique) {
      const expGain = techBaseExpRate(s) * dt * ratio + techExpFromInvest;
      if (expGain > 0) addTechExp(s, s.technique, expGain);
    }

    // 12. 境界进度 —— 灵气满格之后**必须渡劫**才能升境（不再自动突破）
    //
    // 渡劫结果由 tribulationRoll 从「境界 / 已尝试次数 / 淬体层数 / 游戏内时间」
    // 确定性推导，所以前端与服务端各跑一次 tick 会得到同一个结局。
    //   · canTribulate = false（浏览器端）：只累进度条，把「要不要渡」留给界面，
    //     实际渡劫走 /api/action 的服务端权威路径。
    //   · 自动渡劫成功 → 继续尝试下一境（一段 tick 内可连渡）
    //   · 自动渡劫失败 → 被动兵解，这一世已结束，本段 tick 立即停手，
    //     否则会在同一段里拿着全新的状态反复硬闯。
    if (canTribulate && s.autoTribulation !== false) {
      if (tribulationCfg().implemented) {
        let guard = 0;
        while (tribulationReady(s) && guard < 8) {
          const tr = doTribulation(s);
          guard += 1;
          if (!tr.ok || !tr.success) break;
        }
      }
    }

    {
      const target = nextRealm(s);
      if (target && target.need) {
        s.realmProgress = s.qi.div(target.need);
        if (s.realmProgress.gt(1)) s.realmProgress = new D(1);
      } else {
        s.realmProgress = new D(1);
      }
    }

    // 13. 时间档位完全由玩家在顶栏用四键控制（◀ / ▶⏸ / ▶▶ / ▶▶▶），
    //     **不再自动跟随最高档**。早先有「autoTier 自动跳到最高已解锁档」的逻辑，
    //     那时档 2 要炼气才解锁，跟着跳还算合理；现在「常速」从凡人就可用了，
    //     自动跟随会让凡人开局就被顶到 1 秒 = 1 小时，凡人期的每一步都不再可感知。
    //     想要最快，按一下 ▶▶▶ 就到 —— 明确的手动动作比隐式的自动跟随好。

    s.playTime += dt;

    // 公司的金钱净额 = 卖出收入 − 已付维护费（两者已在 syncCompany 内落到 s.money 上，
    // 这里只把它计入本段收益，供离线结算的弹窗汇总使用）
    const compMoney = comp ? comp.revenue.sub(comp.upkeep) : new D(0);

    return {
      money: auto.add(financeGain.mul(allOut))
        .add(work.money.mul(ratio).mul(moneyPassive).mul(allOut))
        .add(compMoney),
      spirit: work.spirit.mul(ratio).mul(qiMul).add(qiGain.mul(qiMul)),
      stone: stoneOut.add(work.stone.mul(ratio).mul(allOut)),
      jobDone: work.done,
      company: comp,
      dt: dt,
    };
  }

  /**
   * 推进游戏状态 —— 核心 tick 函数
   * @param {object} s 状态
   * @param {number} dtSeconds 经过的现实秒数
   * @param {object} opts { offline: bool }
   */
  function tick(s, dtSeconds, opts) {
    opts = opts || {};
    const total = Math.max(0, Math.min(dtSeconds, GAME.save.maxTickSeconds));

    const acc = {
      money: new D(0), spirit: new D(0), stone: new D(0), jobDone: 0, dt: 0,
      company: { cycles: 0, revenue: new D(0), upkeep: new D(0), produced: 0, overflow: 0, starved: 0, sold: {} },
    };
    if (total <= 0) {
      s.lastTick = Date.now();
      return {
        money: acc.money, spirit: acc.spirit, stone: acc.stone,
        jobDone: 0, offline: !!opts.offline, dt: 0, company: null,
      };
    }

    const offline = !!opts.offline;
    let remain = total;
    let guard = 0;
    while (remain > 0 && guard < 100000) {
      const step = Math.min(remain, STEP_REAL_SECONDS);
      // 渡劫是否允许在这段 tick 内自动触发。
      // 浏览器端传 tribulation:false —— 它把渡劫留给服务端权威操作；
      // 服务端（/api/load 的离线结算、/api/action 的前置推进）保持默认开启。
      const r = stepTick(s, step, offline, opts.tribulation !== false);
      acc.money = acc.money.add(r.money);
      acc.spirit = acc.spirit.add(r.spirit);
      acc.stone = acc.stone.add(r.stone);
      acc.jobDone += r.jobDone;
      acc.dt += r.dt;

      if (r.company) {
        const cc = acc.company;
        cc.cycles += r.company.cycles;
        cc.revenue = cc.revenue.add(r.company.revenue);
        cc.upkeep = cc.upkeep.add(r.company.upkeep);
        cc.produced += r.company.produced;
        cc.overflow += r.company.overflow;
        cc.starved += r.company.starved;
        for (const k of Object.keys(r.company.sold)) {
          cc.sold[k] = (cc.sold[k] || 0) + r.company.sold[k];
        }
      }

      remain -= step;
      guard += 1;
    }

    s.lastTick = Date.now();

    return {
      money: acc.money,
      spirit: acc.spirit,
      stone: acc.stone,
      jobDone: acc.jobDone,
      offline: offline,
      dt: acc.dt,
      company: acc.company.cycles > 0 ? acc.company : null,
    };
  }

  // ============================================================
  // 玩家操作
  // ============================================================

  /** 购买设备（科技修仙设备需要「金钱 + 灵石」双造价） */
  function buyDevice(s, deviceId) {
    const dev = GAME.devices.find((d) => d.id === deviceId);
    if (!dev) return { ok: false, msg: '设备不存在' };
    const cost = deviceCost(s, dev);
    const stoneCost = deviceStoneCost(s, dev);
    if (s.money.lt(cost)) return { ok: false, msg: '金钱不足' };
    if (stoneCost.gt(0) && s.spiritStone.lt(stoneCost)) return { ok: false, msg: '灵石不足' };

    s.money = s.money.sub(cost);
    if (stoneCost.gt(0)) s.spiritStone = s.spiritStone.sub(stoneCost);
    s.devices[deviceId] = (s.devices[deviceId] || 0) + 1;

    // 买到个人电脑会触发放下第一本功法
    learnTechniques(s);

    s.shenshi = totalShenshi(s);
    s.realCompute = realComputeOf(s);
    return {
      ok: true,
      cost: cost,
      stoneCost: stoneCost,
      owned: s.devices[deviceId],
      learned: Object.keys(s.learned),
    };
  }

  /** 设置投资分配；锁定项被忽略，总和超过 1 时按比例归一化 */
  function setAllocation(s, alloc) {
    const usable = allocatableInvestments(s);

    // 先按传入值过滤，锁定项归 0
    const want = {};
    let sum = 0;
    // 先按传入值过滤，不可用的项归 0。
    //
    // ⚠️ 这里**只看 investmentAvailable，不看 inv.locked** —— locked 只是配置上的
    // 初始标记，真正的可用性由 investmentAvailable 判定（功法增幅要习得功法、
    // 工业产能要成立公司）。早先写成 `inv.locked || !investmentAvailable(...)`，
    // 结果锁定项**永远**被过滤：功法习得后「功法增幅」依旧拿不到份额，
    // 那条路线等于白配。
    for (const inv of GAME.investments) {
      if (!investmentAvailable(s, inv)) { want[inv.id] = 0; continue; }
      const v = alloc[inv.id];
      const val = (typeof v === 'number' && v >= 0) ? v : 0;
      want[inv.id] = val;
      sum += val;
    }

    if (sum <= 0) {
      // 全零时归位到修仙
      for (const inv of GAME.investments) {
        s.alloc[inv.id] = (!inv.locked && inv.id === 'xiuxian') ? 1 : 0;
      }
      return { ok: true, normalized: true };
    }

    const scale = sum > 1 ? 1 / sum : 1;
    for (const inv of GAME.investments) {
      s.alloc[inv.id] = (want[inv.id] || 0) * scale;
    }
    // 未使用的份额（锁定项腾出来的空间）补给修仙方向，避免算力凭空消失
    let used = 0;
    for (const inv of usable) used += s.alloc[inv.id] || 0;
    const slack = 1 - used;
    if (slack > 1e-9) {
      const xi = GAME.investments.find((i) => i.id === 'xiuxian');
      if (xi && !xi.locked) s.alloc[xi.id] = (s.alloc[xi.id] || 0) + slack;
    }

    return { ok: true, normalized: sum > 1 };
  }

  /** 选择修炼哪本功法（同一时间只能修炼一本）。熟练度进度与段位各自独立保留 */
  function setTechnique(s, id) {
    if (!id) return { ok: false, msg: '未指定功法' };
    const tech = techById(id);
    if (!tech) return { ok: false, msg: '功法不存在' };
    if (!s.learned[id]) {
      return { ok: false, msg: techLockedReason(s, tech) || '尚未习得该功法' };
    }
    s.technique = id;
    s.cultivating = true;
    return { ok: true, technique: id };
  }

  /** 开始 / 停止修炼 */
  function setCultivating(s, on) {
    s.cultivating = !!on;
    return { ok: true, cultivating: s.cultivating };
  }

  /**
   * 参悟 —— 消耗灵气，立即获得一笔熟练度（相当于熟练度的「催工」）。
   * 熟练度已至圆满（被动已常驻）时不能再参悟。
   */
  function comprehend(s, times) {
    if (!GAME.techniques.implemented) return { ok: false, msg: '功法系统未开放' };
    const tech = currentTech(s);
    if (!tech) return { ok: false, msg: '尚未习得功法' };
    const rec = s.learned[tech.id];
    if (!rec) return { ok: false, msg: '尚未习得该功法' };
    if (rec.tier >= PERFECT_TIER) return { ok: false, msg: '已至圆满，无需再参悟' };

    const n = Math.max(1, Math.min(Math.floor(times || 1), 1000));
    const cost = comprehendCost(s);
    let done = 0;
    let gained = 0;
    for (let i = 0; i < n; i++) {
      if (s.qi.lt(cost)) break;
      if (rec.tier >= PERFECT_TIER) break;
      s.qi = s.qi.sub(cost);
      const g = comprehendGain(rec.tier);
      const res = addMastery(s, tech.id, g);
      gained += g;
      done += 1;
      if (!res) break;
    }

    if (done === 0) return { ok: false, msg: '灵气不足' };
    return { ok: true, done: done, cost: cost.mul(done), gain: gained, tier: rec.tier, passive: rec.passive };
  }

  /**
   * 计算离线收益预览（不修改状态）
   * @param {object} s 状态
   * @param {number} seconds 经过的真实秒数
   * @param {boolean} offline 是否按离线规则（打折 + 封顶）
   */
  function previewOffline(s, seconds, offline) {
    if (offline === undefined) offline = true;
    const capped = offline
      ? Math.min(seconds, offlineMaxHours(s) * 3600)
      : seconds;
    const tmp = hydrate(serialize(s));
    const res = tick(tmp, capped, { offline: offline });
    const stk = stockSummary(tmp);
    return {
      seconds: capped,
      money: res.money,
      spirit: res.spirit,
      stone: res.stone,
      jobDone: res.jobDone,
      gameSeconds: tmp.gameSeconds,
      realm: tmp.realm,
      learned: Object.keys(tmp.learned),
      // 公司（产业）在离线期间的经营汇总
      company: res.company ? {
        cycles: res.company.cycles,
        revenue: res.company.revenue,
        upkeep: res.company.upkeep,
        produced: res.company.produced,
        overflow: res.company.overflow,
        starved: res.company.starved,
      } : null,
      // 股市：离线期间冲击会衰减（价格向自然价回归），所以持仓市值可能变动。
      // 这里只回传账户层面的汇总，避免离线弹窗被五行股票数据撑爆。
      stock: {
        totalValue: stk ? stk.totalValue : new D(0),
        pnl: stk ? stk.pnl : new D(0),
        realized: tmp.stock.realized,
        totalFee: tmp.stock.totalFee,
        totalTrades: tmp.stock.totalTrades,
      },
      cappedOut: offline && seconds > capped,
    };
  }

  const API = {
    // 状态
    createState, hydrate, serialize,
    // 时间
    tierInfo, maxUnlockedTier, tierUnlocked, setTimeTier, setAutoTier,
    gameSecondsPerRealSecond, gameDate, fmtGameDate, fmtGameDuration,
    // 精力
    maxEnergy,
    // 神识
    shenshiBase, shenshiDeviceMultiplier, totalShenshi,
    shenshiParts, shenshiEffect, shenshiComputeMultiplier, shenshiCultivateMultiplier,
    // 工作
    jobById, jobDurationSeconds, jobDoneCount, jobUnlocked, lockedReason,
    jobIncome, setJob, setWorking, rushJob, advanceWork,
    // 功法
    techById, rarityById, masteryTierOf, masteryInfo, currentTech, techRecord,
    techLearned, techUnlockConditionMet, techLockedReason, techCondText, firstTechUnlocked,
    techExpCfg, techExpNeed, techBaseExpRate, techExpRateOf, addTechExp,
    learnTechniques, addMastery, cultivateSpeed, comprehendCost, comprehendGain,
    techLevel, techMainQiSpeed, techniqueList, passiveBonus,
    // 科技
    deviceCost, deviceStoneCost, totalCompute, deviceStoneOutput, realComputeOf,
    autoIncome, qiMultiplier,
    allocatableInvestments, investmentAvailable, investmentLockReason,
    investOutput, investOutputRate, hardwareCostFactor, investedHardwareOf, hasAnyTechnique,
    goodCurrency, stoneExchangeRate, setAllocationShare, stockAccessible, stockAccessReason, techCondProgress,
    // 修仙
    realmInfo, nextRealm, techniqueUnlocked, spiritAllowed, fmtBig,
    // 公司（产业）
    lineById, goodById, goodsPrice, goodsTrend, goodsNextChangeIn, goodsPeriodSeconds,
    goodsPeriod, goodsSeries, goodsWindow,
    // 市场抛压（卖出影响下一期经济）
    marketCfg, pressureOf, excessSold, pressureAdd, marketImpactAt,
    goodsPriceWith, goodsSeriesWith, goodsWindowWith, marketDropRatio, naturalPrice,
    syncMarket, marketSummary, marketFloorPrice,
    companyFounded, companyUnlocked, companyLockedReason,
    warehouseLevel, warehouseCapacity, warehouseCost,
    stockTotal, stockOf, lineOwned, lineUnlocked, lineLockedReason, lineCost,
    companyUpkeep, companyOutputPerCycle, companyCycleGross, companyCycleNet,
    companyIncomePerSecond, syncCompany,
    // 行业 · 生产线 · 工业算力（生产线可换产物、产能由算力驱动）
    industryById, goodsOfIndustry, lineProducts, lineIndustry,
    industryPriceRatio, industryUpstreamRatio, industryPriceIndex, industryCostIndex,
    industrialComputePool, lineUnits, lineMinRate, unitActive,
    companyComputeDemand, companyComputeScale, unitOutput, setLineUnit,
    // 股市（证券账户）
    stockCfg, stockById, stockUnlocked, stockLockedReason, stockDepth,
    stockPeriodSeconds, stockPeriod, stockFactor, stockLinkFactor,
    stockShares, stockFlow, stockCost, stockAvgCost, stockHeldRatio,
    stockImpact, stockImpactAt, stockNaturalPrice, stockPrice, stockTrend,
    stockNextChangeIn, stockSeries, stockWindow, stockForecastPct,
    stockHoldingValue, stockHoldingPnl,
    stockBuyQuote, stockSellQuote, stockMaxBuy,
    buyStock, sellStock, syncStocks, stockSummary,
    // 行情时钟（现实秒）—— 前端算「距变价」进度条等要用
    marketClock,
    // 转生（兵解）
    rebirthCfg, rebirthState, rebirthCount, rebirthDiscount, rebirthFactorAt,
    rebirthAttenuate, rebirthComputeCap, deviceComputeEffective, rebirthSummary,
    rebirthDaoGain, rebirthUnlocked, rebirthLockedReason, doRebirth,
    perkById, perkLevel, perkValue, perkCost, buyPerk,
    // 渡劫（突破境界的门槛）
    tribulationCfg, tribulationState, tribulationLevel, tribulationBonus,
    tribulationComputeBase, perfectedTechniqueCount, tribulationOdds,
    tribulationReady, tribulationRoll, tribulationBoonSummary, tribulationSummary,
    doTribulation, setAutoTribulation, energyRegen, setTimePaused,
    // 道行加成落到的几个参数（离线 / 股市费率）
    offlineRatio, offlineMaxHours, stockFee,
    // 主循环
    tick, buyDevice, setAllocation, setTechnique, setCultivating, comprehend,
    foundCompany, buyLine, upgradeWarehouse, sellGoods, setAutoSell,
    previewOffline,
    // 常量
    SEC_PER_MIN, SEC_PER_HOUR, SEC_PER_DAY, SEC_PER_MONTH, SEC_PER_YEAR, DAYS_PER_YEAR,
    PERFECT_TIER,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') root.GameCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
