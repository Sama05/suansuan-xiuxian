/**
 * 游戏核心逻辑 —— 前后端共用
 *
 * 关键原则：同一个 tick 函数，前端用于实时刷新，后端用于离线结算。
 * 两边算法完全一致，避免出现「前端显示的进度」与「后端保存的进度」对不上。
 *
 * ============================================================
 * 三条时间线的分工（改数值前务必理解）
 * ============================================================
 *   1) 游戏内时间（gameSeconds）—— 由时间档位决定流速，驱动「工作耗时」与日期显示。
 *   2) 现实时间（dt）          —— 驱动设备被动收益、算力投资产出、精力恢复、功法修炼。
 *   3) 精力                    —— 按现实时间恢复，是**与档位无关**的产出硬上限。
 *
 * 为什么精力必须按现实时间算：时间档位可以调到「1 秒 = 1 个月」，
 * 如果产出上限也跟着游戏时间膨胀，玩家拉满档位就能无限产出。
 * 精力把总产出锁死在「每秒恢复 1 点」上，档位只决定你多快花完这份额度。
 *
 * ============================================================
 * 两条货币 + 两个属性
 * ============================================================
 *   金钱 money        —— 买设备、开公司
 *   灵气 qi           —— **突破境界的唯一货币**，需先习得功法才会产生
 *   灵石 spiritStone  —— 后期修仙资源，买科技修仙设备用
 *   算力 compute      —— 设备提供，投向四个方向
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
      costDiscount: 1,
      realCompute: new D(0),
      aiBonus: new D(0),
      investedCompute: new D(0),

      // ---- 公司（产业）----
      /**
       * 与「工作」彻底分开的一条线：
       *   工作 = 职业（别人雇你，固定收益、消耗精力）
       *   公司 = 产业（自己生产、自己卖，收益随市价浮动、扣维护费）
       *
       * 注意 `stock` 存的是**件数**（整数），市价不存档 —— 它由 gameSeconds
       * 确定性推导（见 goodsPrice），这样前端 tick 与后端离线结算算出的价格完全一致。
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
    s.costDiscount = typeof raw.costDiscount === 'number' ? raw.costDiscount : 1;

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
        // 记录期数；比当前期还大的值会让抛压永远不结算，直接裁到当前期
        const lp = clampCount(rc.lastPeriod && rc.lastPeriod[g.id]);
        const cur = goodsPeriod(g, s.gameSeconds);
        s.company.lastPeriod[g.id] = Math.min(lp, cur);
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
        // 期数游标不允许超前于当前期，否则冲击永远等不到衰减
        const lp = clampInt(rs.lastPeriod && rs.lastPeriod[st.id], 0, 1e15);
        s.stock.lastPeriod[st.id] = Math.min(lp, stockPeriod(st, s.gameSeconds));
      }
    }

    // ---- 精力（上限受功法被动影响，必须在 learned 还原之后再算）----
    const maxE = maxEnergy(s);
    s.energy = typeof raw.energy === 'number' && raw.energy >= 0
      ? Math.min(raw.energy, maxE) : maxE;

    s.shenshi = totalShenshi(s);
    s.realCompute = realComputeOf(s);

    return s;
  }

  /** 序列化为可存档的纯 JSON */
  function serialize(s) {
    const out = {
      money: s.money.toJSON(),
      qi: s.qi.toJSON(),
      spiritStone: s.spiritStone.toJSON(),
      realmProgress: s.realmProgress.toJSON(),
      realCompute: s.realCompute.toJSON(),
      aiBonus: s.aiBonus.toJSON(),
      investedCompute: s.investedCompute.toJSON(),
      costDiscount: s.costDiscount,

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
      out.learned[id] = { mastery: rec.mastery, tier: rec.tier, passive: rec.passive };
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
  function gameSecondsPerRealSecond(s) {
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

  /** 当前精力上限（境界基础 × 功法被动加成） */
  function maxEnergy(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    const base = (r && r.maxEnergy) || (GAME.realms[0] && GAME.realms[0].maxEnergy) || 100;
    return base * (1 + passiveBonus(s, 'energyMax'));
  }

  // ============================================================
  // 神识
  // ============================================================

  /** 境界提供的基础神识 */
  function shenshiBase(s) {
    const r = GAME.realms[Math.min(s.realm, GAME.realms.length - 1)];
    return (r && r.shenshi) || 1;
  }

  /** 设备对神识的放大倍率（科技修仙设备越靠后越猛） */
  function shenshiDeviceMultiplier(s) {
    let m = 1;
    for (const dev of GAME.devices) {
      if (!dev.shenshiBonus) continue;
      const n = s.devices[dev.id] || 0;
      if (n > 0) m += dev.shenshiBonus * n;
    }
    return m;
  }

  /** 神识总量 = 境界基础 × 设备倍率 × (1 + 功法被动加成) */
  function totalShenshi(s) {
    const v = shenshiBase(s) * shenshiDeviceMultiplier(s) * (1 + passiveBonus(s, 'shenshi'));
    return Number.isFinite(v) && v > 0 ? v : 0;
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
  function techUnlockConditionMet(s, tech) {
    if (!tech) return false;
    if (s.realm < (tech.realm || 0)) return false;
    const need = tech.compute || 0;
    if (need > 0 && realComputeOf(s).lt(need)) return false;
    return true;
  }

  /** 未习得的原因（前端展示用） */
  function techLockedReason(s, tech) {
    if (!tech) return '';
    if (s.realm < (tech.realm || 0)) return '需达到「' + realmName(tech.realm) + '」';
    const need = tech.compute || 0;
    if (need > 0 && realComputeOf(s).lt(need)) return '需算力达到 ' + fmtBig(need);
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
    s.learned[id] = { mastery: 0, tier: 0, passive: false };
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
  function cultivateSpeed(s) {
    const c = GAME.techniques.cultivate;
    const sh = totalShenshi(s);
    return c.pointsPerSecond * (1 + sh * c.shenshiBonusPerPoint);
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
  function techLevel(s, tech) {
    if (!tech || !s.learned[tech.id]) return 0;
    const c = realComputeOf(s).toNumber();
    if (!(c > 0)) return 0;
    const lv = Math.floor(Math.log10(1 + c) * GAME.techniques.level.logCoef);
    return lv > 0 ? lv : 0;
  }

  /** 某功法主属性强度（灵气吸收速度加成，纯小数）。随等级与稀有度提升，无上限 */
  function techMainQiSpeed(s, tech) {
    if (!tech) return 0;
    const r = rarityById(tech.rarity);
    const base = r ? r.mainQiSpeed : 0;
    const lv = techLevel(s, tech);
    return base * (1 + lv * GAME.techniques.level.mainPerLevel);
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
    return base.mul(s.costDiscount).mul(q > 0 ? q : 0.01);
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
  function realComputeOf(s) {
    const base = D.add(totalCompute(s), s.aiBonus);
    const shenshiMul = 1 + totalShenshi(s) * GAME.shenshi.computeBonusPerPoint;
    const passiveMul = 1 + passiveBonus(s, 'compute');
    return base.mul(shenshiMul).mul(passiveMul);
  }

  /**
   * 设备被动收益（每秒，现实时间）。
   * 设备不是主要收入（工作是 / 公司是），但它是稳产底盘 ——
   * 精力耗尽、无法工作时，只有设备还在产钱。
   */
  function autoIncome(s) {
    const base = D.add(totalCompute(s), s.aiBonus);
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

    m *= 1 + totalShenshi(s) * GAME.techniques.cultivate.shenshiBonusPerPoint;

    const inv = GAME.investments.find((i) => i.id === 'technique');
    if (inv && investmentAvailable(s, inv)) {
      const out = investOutput(s, inv);
      if (out.gt(0)) m += out.toNumber();
    }

    m *= 1 + passiveBonus(s, 'allOutput');
    return m > 0 ? m : 0;
  }

  /** 可参与分配的投向（排除未解锁的锁定项） */
  function allocatableInvestments(s) {
    return GAME.investments.filter((inv) => investmentAvailable(s, inv));
  }

  /** 某投向是否所有条件都满足 */
  function investmentAvailable(s, inv) {
    if (!inv.locked) return true;
    // 「功法增幅」需要先习得功法
    if (inv.id === 'technique') return GAME.techniques.implemented && !!s.technique;
    // 「工业产能」需要先成立公司 —— 没工厂就没有产能可分配
    if (inv.id === 'industry') {
      return !!GAME.company.implemented && companyFounded(s);
    }
    return false;
  }

  /**
   * 计算某投资方向的实际可用算力
   * 收益 = rate * compute^decay，其中 decay < 1 表示收益递减
   */
  function investOutput(s, inv) {
    if (!investmentAvailable(s, inv)) return new D(0);
    const ratio = s.alloc[inv.id] || 0;
    if (ratio <= 0) return new D(0);
    const compute = s.realCompute.mul(ratio);
    if (compute.lte(0)) return new D(0);
    const effective = D.pow(compute, inv.decay);
    return effective.mul(inv.rate);
  }

  /** 计算 hardware 投资带来的新折扣 */
  function computeDiscount(s) {
    const inv = GAME.investments.find((i) => i.id === 'hardware');
    if (!inv) return 1;
    const out = investOutput(s, inv);
    if (out.lte(0)) return 1;
    const d = 1 / (1 + out.toNumber());
    return Math.max(inv.cap, d);
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

  /** 商品的变价周期（游戏秒）：科技类逐年，修仙类每 10 年 */
  function goodsPeriodSeconds(good) {
    return Math.max(1, (good.periodYears || 1) * SEC_PER_YEAR);
  }

  /** 商品当前处于第几期 */
  function goodsPeriod(good, gameSeconds) {
    return Math.floor(Math.max(0, gameSeconds || 0) / goodsPeriodSeconds(good));
  }

  /** 商品当前市价 */
  function goodsPrice(good, gameSeconds) {
    if (!good) return new D(0);
    return new D(good.basePrice).mul(goodsPriceFactor(good, goodsPeriod(good, gameSeconds)));
  }

  /** 相对上一期的涨跌：'up' / 'down' / 'flat' */
  function goodsTrend(good, gameSeconds) {
    const p = goodsPeriod(good, gameSeconds);
    if (p <= 0) return 'flat';
    const cur = goodsPriceFactor(good, p);
    const prev = goodsPriceFactor(good, p - 1);
    if (cur > prev * 1.004) return 'up';
    if (cur < prev * 0.996) return 'down';
    return 'flat';
  }

  /** 距下次变价还剩多少游戏秒 */
  function goodsNextChangeIn(good, gameSeconds) {
    const len = goodsPeriodSeconds(good);
    const rem = Math.max(0, gameSeconds || 0) % len;
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
        t: p * len,
      });
    }
    return out;
  }

  /**
   * 以当前时间为基准，取前 past 期 ~ 后 future 期的走势（含当前期）。
   *
   * 注意一个开局边界：修仙类商品每 10 游戏年才变一次价，游戏刚开始时序列里
   * 只有「第 0 期」一个点，连不成线，折线图会整个空白。所以当窗口退化成单期
   * 时，向后补一期 —— 让图上至少有一条从基准价出发的线段。
   */
  function goodsWindow(good, gameSeconds, past, future) {
    const p = goodsPeriod(good, gameSeconds);
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
    const cur = goodsPeriod(good, (s && s.gameSeconds) || 0);
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
   */
  function naturalPrice(good, gameSeconds, s) {
    if (!good) return new D(0);
    const t = (gameSeconds === undefined || gameSeconds === null) ? 0 : gameSeconds;
    const base = new D(good.basePrice).mul(goodsPriceFactor(good, goodsPeriod(good, t)));
    if (!s) return base;
    return base.mul(industryPriceIndex(s, good.industry));
  }

  /** 带上抛压与行业传导之后的市价 —— 前端展示与结算都应该用这个 */
  function goodsPriceWith(s, good, gameSeconds) {
    if (!good) return new D(0);
    const t = (gameSeconds === undefined || gameSeconds === null)
      ? ((s && s.gameSeconds) || 0) : gameSeconds;
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
    const natural = naturalPrice(good, s.gameSeconds, s);
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
    const p = goodsPeriod(good, (s && s.gameSeconds) || 0);
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
      const cur = goodsPeriod(g, s.gameSeconds);
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
      const period = goodsPeriod(g, s.gameSeconds);
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
        naturalPrice: naturalPrice(g, s.gameSeconds, s),
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

  let _indDepth = 0;

  /** 某行业当前的「价格倍数」= 该行业全部商品 现价/基准价 的平均值（1 = 平价） */
  function industryPriceRatio(s, industryId) {
    const list = goodsOfIndustry(industryId);
    if (!list.length) return 1;
    if (_indDepth > 8) return 1;
    _indDepth += 1;
    let sum = 0;
    try {
      for (const g of list) {
        sum += goodsPriceWith(s, g).div(new D(g.basePrice)).toNumber();
      }
    } finally {
      _indDepth -= 1;
    }
    return sum / list.length;
  }

  /** 上游综合价格倍数（多个上游行业等权平均） */
  function industryUpstreamRatio(s, industryId) {
    const ind = industryById(industryId);
    if (!ind || !ind.upstream || !ind.upstream.length) return 1;
    let sum = 0;
    for (const up of ind.upstream) sum += industryPriceRatio(s, up);
    return sum / ind.upstream.length;
  }

  /** 上游涨价 → 本行业**售价**的传导（打折跟涨） */
  function industryPriceIndex(s, industryId) {
    const ind = industryById(industryId);
    if (!ind) return 1;
    const up = industryUpstreamRatio(s, industryId);
    if (_indDepth > 8) return 1;
    return 1 + (up - 1) * (ind.pricePass || 0);
  }

  /** 上游涨价 → 本行业**成本**的传导（全额上涨，于是毛利被压缩） */
  function industryCostIndex(s, industryId) {
    const ind = industryById(industryId);
    if (!ind) return 1;
    const up = industryUpstreamRatio(s, industryId);
    if (_indDepth > 8) return 1;
    return 1 + (up - 1) * (ind.passThrough || 0);
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
  function buyLine(s, lineId) {
    const line = lineById(lineId);
    if (!line) return { ok: false, msg: '生产线不存在' };
    if (!lineUnlocked(s, line)) {
      return { ok: false, msg: lineLockedReason(s, line) || '尚未解锁' };
    }
    const cost = lineCost(s, line);
    if (s.money.lt(cost)) return { ok: false, msg: '金钱不足' };
    s.money = s.money.sub(cost);

    // 新买的一台是一份**独立配置**：默认产该行业第一个产物、产能拉满。
    // 买完想改产什么、开几成力，由 setLineUnit 单独调。
    const units = lineUnits(s, line.id).slice();
    const prods = lineProducts(line);
    units.push({ p: prods.length ? prods[0].id : null, r: 1 });
    s.company.lines[line.id] = { units: units };

    return {
      ok: true, owned: units.length, cost: cost,
      index: units.length - 1, product: units[units.length - 1].p,
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
  function sellAllInternal(s) {
    const sold = {};
    let revenue = new D(0);
    for (const g of GAME.company.goods) {
      const n = s.company.stock[g.id] || 0;
      if (n <= 0) continue;
      revenue = revenue.add(goodsPriceWith(s, g).mul(n));
      sold[g.id] = n;
      s.company.stock[g.id] = 0;
      s.company.goodsSold[g.id] = (s.company.goodsSold[g.id] || 0) + n;
      // 记进「本期成交量」—— 抛压结算时与本期产出对比，多出来的部分就是砸盘
      s.company.soldThisPeriod[g.id] = (s.company.soldThisPeriod[g.id] || 0) + n;
    }
    if (revenue.gt(0)) {
      s.money = s.money.add(revenue);
      s.company.totalRevenue = s.company.totalRevenue.add(revenue);
    }
    return { revenue: revenue, sold: sold };
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
      return { ok: true, revenue: r.revenue, sold: r.sold, all: true };
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
    s.money = s.money.add(revenue);
    s.company.totalRevenue = s.company.totalRevenue.add(revenue);
    return { ok: true, revenue: revenue, count: n, price: price, goodId: g.id };
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

    const eff = offline ? GAME.offline.ratio : 1;
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

  /** 股票的变价周期（游戏秒） */
  function stockPeriodSeconds(stock) {
    return Math.max(1, (stock.periodYears || 1) * SEC_PER_YEAR);
  }

  /** 股票当前处于第几期 */
  function stockPeriod(stock, gameSeconds) {
    return Math.floor(Math.max(0, gameSeconds || 0) / stockPeriodSeconds(stock));
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
  function stockNaturalPrice(s, stock, gameSeconds) {
    if (!stock) return new D(0);
    const t = (gameSeconds === undefined || gameSeconds === null)
      ? ((s && s.gameSeconds) || 0) : gameSeconds;
    return stockNaturalAtPeriod(s, stock, stockPeriod(stock, t));
  }

  /** 指定期数的冲击衰减：过去期按 1（历史价不可考），未来期按 flowDecay 逐期恢复 */
  function stockImpactAtPeriod(s, stock, period) {
    const flow = stockFlow(s, stock.id);
    if (flow === 0) return 1;
    const cur = stockPeriod(stock, (s && s.gameSeconds) || 0);
    if (period < cur) return 1;
    const dec = Math.pow(stockFlowDecay(), period - cur);
    return stockImpactAt(s, stock, stockShares(s, stock.id), flow * dec);
  }

  /** 当前成交价 = 自然价 × 冲击系数，并兜一道绝对下限 */
  function stockPrice(s, stock, gameSeconds) {
    if (!stock) return new D(0);
    const t = (gameSeconds === undefined || gameSeconds === null)
      ? ((s && s.gameSeconds) || 0) : gameSeconds;
    const nat = stockNaturalAtPeriod(s, stock, stockPeriod(stock, t));
    const px = nat.mul(stockImpact(s, stock));
    const fl = nat.mul(stockCfg().floor || 0);
    return px.lt(fl) ? fl : px;
  }

  /** 相对上一期的行情涨跌：'up' / 'down' / 'flat'（只看自然价，不看自己的冲击） */
  function stockTrend(s, stock) {
    const p = stockPeriod(stock, (s && s.gameSeconds) || 0);
    if (p <= 0) return 'flat';
    const cur = stockNaturalAtPeriod(s, stock, p).toNumber();
    const prev = stockNaturalAtPeriod(s, stock, p - 1).toNumber();
    if (cur > prev * 1.004) return 'up';
    if (cur < prev * 0.996) return 'down';
    return 'flat';
  }

  /** 距下次变价还剩多少游戏秒 */
  function stockNextChangeIn(stock, gameSeconds) {
    const len = stockPeriodSeconds(stock);
    const rem = Math.max(0, gameSeconds || 0) % len;
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
    const p = stockPeriod(stock, (s && s.gameSeconds) || 0);
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
    const cfg = stockCfg();
    if (!stock) return { ok: false, msg: '股票不存在' };
    const want = Math.floor(Number(shares) || 0);
    if (!(want > 0)) return { ok: false, msg: '数量必须大于 0' };

    const depth = stockDepth(stock);
    const have = stockShares(s, stock.id);
    if (have + want > depth) {
      return { ok: false, msg: '超过流通盘上限（最多持有 ' + depth + ' 股）' };
    }

    const nat = stockNaturalPrice(s, stock);
    const impact = stockImpactAt(s, stock, have + want, stockFlow(s, stock.id) + want);
    const unitPrice = nat.mul(impact);
    const gross = unitPrice.mul(want);
    const fee = gross.mul(cfg.fee || 0);
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
    const fee = gross.mul(cfg.fee || 0);
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
    const first = stockBuyQuote(s, stock, 1);
    if (!first.ok || first.total.gt(s.money)) return 0;

    let guard = 0;
    while (lo < hi && guard++ < 200) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const q = stockBuyQuote(s, stock, mid);
      if (q.ok && q.total.lte(s.money)) lo = mid;
      else hi = mid - 1;
    }
    guard = 0;
    while (lo > 0 && guard++ < 8) {
      const q = stockBuyQuote(s, stock, lo);
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
      const cur = stockPeriod(st, s.gameSeconds);
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
      const period = stockPeriod(st, s.gameSeconds);

      // 「清仓可变现」——按真实卖出的报价算（含冲击与手续费）。
      // 它一定小于等于按现价算的市值：市值里含着你自己的买入冲击溢价，
      // 而这份溢价在你卖的时候会被自己砸回去，拿不到手。所以盈亏要按可变现口径看。
      const liq = shares > 0 ? stockSellQuote(s, st, shares) : null;

      return {
        id: st.id, name: st.name, code: st.code, link: st.link || null,
        kind: st.kind || 'tech', sector: st.sector || null, business: st.business || '',
        basePrice: st.basePrice, depth: stockDepth(st),
        periodYears: st.periodYears || 1,
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
        nextChangeIn: stockNextChangeIn(st, s.gameSeconds),
        maxBuy: stockMaxBuy(s, st),
        unlocked: stockUnlocked(s),
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

    // 榜单：按市值降序取前 N 家。池子里一共 50 家，界面只列这 10 家 ——
    // 但**交易对全部 50 家开放**（接口按 id 找，不在榜上也能买），
    // 否则「想买的刚好掉出前十」会变成硬性阻断，而榜单本就该随行情换人。
    const boardSize = Math.max(1, Math.floor(cfg.boardSize || 10));
    const board = list.slice().sort((a, b) => {
      if (b.marketCap.gt(a.marketCap)) return 1;
      if (b.marketCap.lt(a.marketCap)) return -1;
      return a.id < b.id ? -1 : 1;
    }).slice(0, boardSize);

    return {
      fee: cfg.fee || 0,
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
  function stepTick(s, dt, offline) {
    const ratio = offline ? GAME.offline.ratio : 1;
    const speed = gameSecondsPerRealSecond(s);

    // 1. 游戏内时间推进
    const dtGame = dt * speed;
    s.gameSeconds += dtGame;

    // 2. 精力恢复（现实时间，与档位无关）
    const maxE = maxEnergy(s);
    s.energy = Math.min(maxE, s.energy + dt * GAME.energy.regenPerSecond);

    // 3. 神识 / 实际算力（每段先刷新，保证后续投向产出用的是最新值）
    s.shenshi = totalShenshi(s);
    s.realCompute = realComputeOf(s);

    // 4. 功法习得检查（境界/算力/设备条件可能刚刚满足）
    learnTechniques(s);

    // 5. 工作推进与结算
    const work = advanceWork(s, dtGame);
    const moneyPassive = 1 + passiveBonus(s, 'money');
    const allOut = 1 + passiveBonus(s, 'allOutput');
    const qiMul = qiMultiplier(s);

    if (work.done > 0) {
      s.money = s.money.add(work.money.mul(ratio).mul(moneyPassive).mul(allOut));
      if (qiMul > 0 && work.spirit.gt(0)) s.qi = s.qi.add(work.spirit.mul(ratio).mul(qiMul));
      if (allOut > 0 && work.stone.gt(0)) s.spiritStone = s.spiritStone.add(work.stone.mul(ratio).mul(allOut));
    }

    // 6. 设备被动收益
    const auto = autoIncome(s).mul(dt * ratio).mul(allOut);
    s.money = s.money.add(auto);

    // 7. 科技修仙设备的灵石产出
    const stoneOut = deviceStoneOutput(s).mul(dt * ratio).mul(allOut);
    if (stoneOut.gt(0)) s.spiritStone = s.spiritStone.add(stoneOut);

    // 8. 算力投向产出
    let qiGain = new D(0);
    let financeGain = new D(0);
    let aiGain = new D(0);

    for (const inv of GAME.investments) {
      const out = investOutput(s, inv).mul(dt * ratio);
      if (out.lte(0)) continue;
      s.produced[inv.id] = D.add(s.produced[inv.id], out);

      if (inv.id === 'finance') financeGain = financeGain.add(out);
      else if (inv.id === 'xiuxian') qiGain = qiGain.add(out);
      else if (inv.id === 'ai') aiGain = aiGain.add(out);
      // 'technique' 的产出是倍率，已在 qiMultiplier 内生效，不再累加资源
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

    // 11. hardware 折扣
    s.costDiscount = computeDiscount(s);

    // 12. 境界进度（允许一段 tick 内连续突破多级）—— 消耗灵气
    let guard = 0;
    let target = nextRealm(s);
    while (target && target.need && s.qi.gte(target.need) && guard < 100) {
      s.qi = s.qi.sub(target.need);
      s.realm += 1;
      // 突破后精力上限提高，当前精力按新上限补齐一部分
      const newMax = maxEnergy(s);
      if (s.energy < newMax) s.energy = Math.min(newMax, s.energy + (newMax - maxE));
      guard += 1;
      target = nextRealm(s);
    }
    if (target && target.need) {
      s.realmProgress = s.qi.div(target.need);
    } else {
      s.realmProgress = new D(1);
    }

    // 13. 突破后可能出现新的时间档位，自动跟随最高已解锁档位
    if (s.timeTier < maxUnlockedTier(s) && s.autoTier !== false) {
      s.timeTier = maxUnlockedTier(s);
    }

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
      const r = stepTick(s, step, offline);
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
      ? Math.min(seconds, GAME.offline.maxHours * 3600)
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
    // 工作
    jobById, jobDurationSeconds, jobDoneCount, jobUnlocked, lockedReason,
    jobIncome, setJob, setWorking, rushJob, advanceWork,
    // 功法
    techById, rarityById, masteryTierOf, masteryInfo, currentTech, techRecord,
    techLearned, techUnlockConditionMet, techLockedReason, firstTechUnlocked,
    learnTechniques, addMastery, cultivateSpeed, comprehendCost, comprehendGain,
    techLevel, techMainQiSpeed, techniqueList, passiveBonus,
    // 科技
    deviceCost, deviceStoneCost, totalCompute, deviceStoneOutput, realComputeOf,
    autoIncome, qiMultiplier,
    allocatableInvestments, investmentAvailable, investOutput, computeDiscount,
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
    stockNextChangeIn, stockSeries, stockWindow,
    stockHoldingValue, stockHoldingPnl,
    stockBuyQuote, stockSellQuote, stockMaxBuy,
    buyStock, sellStock, syncStocks, stockSummary,
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
