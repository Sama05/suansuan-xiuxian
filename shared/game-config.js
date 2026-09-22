/**
 * 游戏配置 —— 数值与系统参数
 * 前后端共用。所有数值集中在此，方便调优。
 *
 * ============================================================
 * 两条货币 + 两个属性（改数值前务必分清）
 * ============================================================
 *   金钱 money        —— 买算力设备、开公司。来源：工作 + 设备被动收益 + 金融投向。
 *   灵气 qi           —— **突破境界的唯一货币**。必须先习得功法才会产生。
 *   灵石 spiritStone  —— **后期修仙类资源**，购买科技修仙设备用（金钱 + 灵石双造价）。
 *
 *   算力 compute      —— 设备提供，投向四个方向。
 *   神识 shenshi      —— **一开始就有**，随境界成长，被设备（尤其科技修仙设备）增幅。
 *                        它同时增幅两件事：
 *                          a) 实际算力的效果（算力乘区）
 *                          b) 功法修炼速度 —— 而功法修炼速度就是灵气提升速度
 *
 * ============================================================
 * 时间尺度约定（贯穿全表）
 * ============================================================
 *   凡人  → 档1「1 现实秒 = 10 游戏分钟」→ 工作耗时以「小时」计
 *   炼气  → 档2「1 现实秒 = 1 游戏小时」→ 工作耗时以「天」计
 *   筑基  → 档3「1 现实秒 = 1 游戏天」  → 工作耗时以「月」计
 *   金丹+ → 档4「1 现实秒 = 1 游戏月」  → 工作耗时以「年」计
 * 每档解锁时工作的游戏内耗时同步跳一个量级，玩家体感的「完成一次工作」
 * 始终落在 10-30 现实秒，不会因为数值膨胀而变成盯着进度条。
 *
 * 游戏内日历简化为 1 月 = 30 天、1 年 = 12 月（=360 天），便于换算。
 */

const GAME = {
  /** 基础参数 */
  base: {
    /** 初始金钱 */
    startMoney: 20,
    /**
     * 设备自动收益系数。
     * 自动收益/秒 = 算力^incomeExponent * autoIncomePerCompute
     * 设备不再是主要收入（工作是），但它是后期的稳产底盘 ——
     * 精力耗尽、无法工作时，只有设备还在产钱。
     */
    autoIncomePerCompute: 0.5,
    /**
     * 自动收益的算力指数。1.0 = 线性。
     * 注意：这个值**不能**盲目调大。指数 > 1 会让收益二次复合，
     * 后期资金在几小时内暴涨上百倍，境界阈值再高也追不上，
     * 结果反而是「越到后期越快」的倒挂曲线。
     */
    incomeExponent: 1.0,
    /** 算力基础值（无设备时为 0） */
    baseCompute: 0,
  },

  // ============================================================
  // 时间系统
  // ============================================================

  time: {
    /** 游戏起点：所有玩家从 2000 年 1 月 1 日 00:00 开始 */
    startYear: 2000,
    /** 简化日历 */
    daysPerMonth: 30,
    monthsPerYear: 12,
    hoursPerDay: 24,

    /**
     * 时间档位 —— 玩家可自由切换（只能切到已解锁的档位）。
     * gameSecondsPerRealSecond：1 现实秒对应多少游戏秒。
     * unlockRealm：达到该境界后解锁此档位。
     */
    tiers: [
      { tier: 1, name: '缓', label: '1 秒 = 10 分钟', gameSecondsPerRealSecond: 600,     unlockRealm: 0 },
      { tier: 2, name: '常', label: '1 秒 = 1 小时',  gameSecondsPerRealSecond: 3600,    unlockRealm: 1 },
      { tier: 3, name: '疾', label: '1 秒 = 1 游戏天', gameSecondsPerRealSecond: 86400,   unlockRealm: 2 },
      { tier: 4, name: '倏', label: '1 秒 = 1 游戏月', gameSecondsPerRealSecond: 2592000, unlockRealm: 3 },
    ],

    /** 起始档位 */
    defaultTier: 1,
  },

  // ============================================================
  // 精力（工作的硬约束）
  // ============================================================

  /**
   * 为什么需要精力：时间档位可以无限加速，如果没有一个与时间无关的约束，
   * 玩家拉满档位就能无限产出。精力按**现实时间**恢复（不随档位变快），
   * 因此它才是真正的产出上限；档位只决定「多快把这份额度花掉」。
   */
  energy: {
    /** 每秒恢复量（现实秒） */
    regenPerSecond: 1,
    /** 低于此比例时前端给提示（精力即将见底） */
    lowRatio: 0.2,
  },

  // ============================================================
  // 神识
  // ============================================================

  /**
   * 神识 —— 一开始就存在的属性。
   *
   * 来源：境界基础值（realms[].shenshi）× 设备加成（devices[].shenshiBonus）。
   *       「后期设备对神识的增幅更高，尤其是科技修仙设备」，
   *       所以设备表越靠后的 shenshiBonus 跃升越猛。
   *
   * 作用：
   *   a) 放大实际算力的效果 —— realCompute = 原始算力 × (1 + 神识 × computeBonusPerPoint)
   *   b) 加快功法修炼速度 —— 见 techniques.cultivate.shenshiBonusPerPoint
   *      （功法修炼速度就是灵气提升速度）
   */
  shenshi: {
    /** 神识每点对「实际算力」的增幅 */
    computeBonusPerPoint: 0.02,
  },

  // ============================================================
  // 工作系统
  // ============================================================

  /**
   * 现实职业表 —— 工作区的内容。
   *
   * 字段说明：
   *   hours        单次耗时（游戏内小时）
   *   energy       单次精力消耗
   *   money        单次金钱收益
   *   spirit       单次灵气收益（突破资源；元婴期的修仙类工作才有）
   *   stone        单次灵石收益（后期修仙资源；元婴期的修仙类工作才有）
   *   unlock.realm 需要达到的境界
   *   unlock.after 需要**先完成**的工作 id 与次数（「升职」感）
   *
   * 数值设计原则（两条都必须单调递增，否则高级工作会被低级工作支配）：
   *   1) money / hours  —— 时间效率递增
   *   2) money / energy —— 精力效率递增
   */
  jobs: [
    // ---------- 凡人期：打零工 ----------
    {
      id: 'flyer', name: '街头发传单', real: '日结零工', tier: 0,
      hours: 2, energy: 6, money: 20,
      desc: '站在写字楼底下塞纸，一天结一次账。',
      unlock: { realm: 0, after: null },
    },
    {
      id: 'store', name: '便利店店员', real: '零售服务', tier: 0,
      hours: 5, energy: 10, money: 70,
      desc: '收银、理货、关东煮。至少不用风吹日晒。',
      unlock: { realm: 0, after: { id: 'flyer', times: 5 } },
    },
    {
      id: 'delivery', name: '外卖骑手', real: '即时配送', tier: 0,
      hours: 10, energy: 15, money: 220,
      desc: '跑单越多拿得越多，但超时一单白干半天。',
      unlock: { realm: 0, after: { id: 'store', times: 5 } },
    },

    // ---------- 炼气期：靠手艺吃饭 ----------
    {
      id: 'driver', name: '网约车司机', real: '交通运输', tier: 1,
      hours: 24, energy: 22, money: 900,
      desc: '车是自己的，油钱也是自己的。',
      unlock: { realm: 1, after: { id: 'delivery', times: 5 } },
    },
    {
      id: 'sorter', name: '物流分拣中心', real: '仓储物流', tier: 1,
      hours: 60, energy: 30, money: 3200,
      desc: '通宵班，按件计酬，手速就是工资。',
      unlock: { realm: 1, after: { id: 'driver', times: 8 } },
    },
    {
      id: 'crane', name: '工地塔吊操作员', real: '建筑施工', tier: 1,
      hours: 120, energy: 38, money: 9500,
      desc: '持证上岗，几十米高空一待一整天。',
      unlock: { realm: 1, after: { id: 'sorter', times: 8 } },
    },

    // ---------- 筑基期：专业资质 ----------
    {
      id: 'dev', name: '初级程序员', real: '软件研发', tier: 2,
      hours: 360, energy: 50, money: 40000,
      desc: '需求改到第八版，终于开始写第一行代码。',
      unlock: { realm: 2, after: { id: 'crane', times: 10 } },
    },
    {
      id: 'cpa', name: '注册会计师', real: '财税审计', tier: 2,
      hours: 720, energy: 65, money: 150000,
      desc: '年报季连着三个月不见天日，签字费很可观。',
      unlock: { realm: 2, after: { id: 'dev', times: 12 } },
    },
    {
      id: 'doctor', name: '三甲医院主治医师', real: '医疗', tier: 2,
      hours: 1440, energy: 80, money: 600000,
      desc: '门诊、手术、带教、论文，四头烧。',
      unlock: { realm: 2, after: { id: 'cpa', times: 12 } },
    },

    // ---------- 金丹期：资源与决策 ----------
    {
      id: 'partner', name: '律所合伙人', real: '法律服务', tier: 3,
      hours: 3600, energy: 120, money: 3.5e6,
      desc: '不再亲自打官司，而是决定谁去打。',
      unlock: { realm: 3, after: { id: 'doctor', times: 15 } },
    },
    {
      id: 'exec', name: '上市公司高管', real: '企业管理', tier: 3,
      hours: 8640, energy: 160, money: 1.8e7,
      desc: '一个决定的代价是整个部门，收益也是。',
      unlock: { realm: 3, after: { id: 'partner', times: 18 } },
    },
    {
      id: 'ceo', name: '创业公司 CEO', real: '创业', tier: 3,
      hours: 17280, energy: 200, money: 9.0e7,
      desc: '账上还剩十一个月，你得让它变成三年。',
      unlock: { realm: 3, after: { id: 'exec', times: 18 } },
    },

    // ---------- 元婴期：修仙与科技结合 ----------
    {
      id: 'spiritmine', name: '灵矿勘探开采工程', real: '资源开发 × 修仙', tier: 4,
      hours: 25920, energy: 300, money: 4.5e8, spirit: 2.0e4, stone: 500,
      desc: '用地质雷达找灵脉，再用重机把它挖出来。挖出的碎屑就是灵石。',
      unlock: { realm: 4, after: { id: 'ceo', times: 20 } },
    },
    {
      id: 'cave', name: '洞天福地基建工程', real: '基建 × 修仙', tier: 4,
      hours: 43200, energy: 400, money: 2.4e9, spirit: 1.2e5, stone: 8000,
      desc: '把整座山改造成阵法节点，工期以年计。顺手能收走山腹里的灵石。',
      unlock: { realm: 4, after: { id: 'spiritmine', times: 20 } },
    },
    {
      id: 'spiritnet', name: '灵脉算力网络建设', real: '算力基建 × 修仙', tier: 4,
      hours: 86400, energy: 520, money: 1.3e10, spirit: 8.0e5, stone: 120000,
      desc: '沿灵脉铺设算力节点。算力与灵气，本就是同一种东西。',
      unlock: { realm: 4, after: { id: 'cave', times: 24 } },
    },
  ],

  /** 手动催工：点击一次立即完成当前工作的一份 */
  rush: {
    /** 是否启用 */
    enabled: true,
  },

  // ============================================================
  // 科技线
  // ============================================================

  /**
   * 算力设备表 —— 购买后提供算力与金钱收益加成。
   *
   * 前 5 台是纯科技设备（用金钱买）。
   * 后 5 台是**修仙与科技结合**设备（金钱 + 灵石双造价），
   * 它们对**神识**的增幅（shenshiBonus）越往后越猛，是后期数值膨胀的主要来源；
   * 同时它们产出灵石（stonePerSecond），让灵石经济能自我滚动。
   */
  devices: [
    // ---------- 纯科技 ----------
    {
      id: 'pc', name: '个人电脑', cost: 50, costGrowth: 1.10,
      compute: 1, incomeBonus: 0.05,
      desc: '一台凑合能跑的机器，算力的起点。也是你第一次接触到「可计算的功法」。',
    },
    {
      id: 'workstation', name: '工作站', cost: 5e3, costGrowth: 1.12,
      compute: 40, incomeBonus: 0.15,
      desc: '专业级配置，算力开始有规模。',
    },
    {
      id: 'cluster', name: '大型集群', cost: 5e5, costGrowth: 1.14,
      compute: 3000, incomeBonus: 0.40,
      desc: '机架成排，散热是个问题。',
    },
    {
      id: 'datacenter', name: '数据中心', cost: 5e7, costGrowth: 1.16,
      compute: 4.0e5, incomeBonus: 1.00,
      desc: '整栋楼都在为你算。',
    },
    {
      id: 'megacenter', name: '超大数据中心集群', cost: 5e9, costGrowth: 1.18,
      compute: 6.0e7, incomeBonus: 2.50,
      desc: '地区级算力枢纽。到这一步，硅已经快到头了。',
    },

    // ---------- 修仙 × 科技（金钱 + 灵石，增幅神识） ----------
    {
      id: 'spiritrack', name: '灵石供电机柜', cost: 5e10, stoneCost: 2e3, costGrowth: 1.20,
      compute: 5e8, incomeBonus: 6, shenshiBonus: 0.5, stonePerSecond: 5,
      desc: '以灵石替代市电。机柜里每一度电，都来自一颗被磨碎的灵石。',
    },
    {
      id: 'leyline', name: '灵脉直连阵列', cost: 5e12, stoneCost: 5e4, costGrowth: 1.22,
      compute: 5e10, incomeBonus: 18, shenshiBonus: 2, stonePerSecond: 40,
      desc: '打穿地脉，把灵脉的流动直接引成电流，省掉了整座变电站。',
    },
    {
      id: 'array', name: '阵法加速节点', cost: 5e14, stoneCost: 1.5e6, costGrowth: 1.24,
      compute: 5e12, incomeBonus: 55, shenshiBonus: 8, stonePerSecond: 400,
      desc: '用聚灵阵替代散热与信号线。阵纹亮起时，延迟低得不像这个世界。',
    },
    {
      id: 'cavecenter', name: '洞天算力中心', cost: 5e16, stoneCost: 5e7, costGrowth: 1.26,
      compute: 5e14, incomeBonus: 170, shenshiBonus: 30, stonePerSecond: 5000,
      desc: '在一粒芥子里折叠出整座机房。占地面积是零，算力不是。',
    },
    {
      id: 'voidlattice', name: '太虚晶格超算', cost: 5e18, stoneCost: 2e9, costGrowth: 1.28,
      compute: 5e16, incomeBonus: 520, shenshiBonus: 120, stonePerSecond: 80000,
      desc: '以神识为时钟、以虚空为总线。它算的不是数，是可能性。',
    },
  ],

  /**
   * 算力投向 —— 玩家分配算力到不同方向。
   *
   * 各路线**不是互相替代**，而是各自从不同角度强化同一条主循环：
   *   - 修仙：唯一的灵气来源（境界推进只能靠它）
   *   - 金融：把算力换成金钱，反哺设备购置
   *   - AI  ：放大有效算力，等于给其他几条路线都加成
   *   - 硬件：降低设备成本，同样是全局加成
   *   - 功法：习得功法后解锁，产出作为**灵气倍率**叠加
   * 因此最优解是「动态调配」而非「一路走到底」。
   *
   * locked: true 的项在前端显示为灰色、不可拖动，也不会参与分配。
   */
  investments: [
    {
      id: 'xiuxian',
      name: '修仙方向',
      desc: '以算力优化吐纳，是灵气（境界）的唯一来源。',
      period: '主线，决定境界上限',
      rate: 0.01,
      decay: 0.75,
    },
    {
      id: 'ai',
      name: 'AI 领域',
      desc: '让算力自我增殖，直接提升算力总量。',
      period: '中线，放大所有路线',
      rate: 0.05,
      decay: 0.70,
      /** AI 产出转化为算力的系数 */
      aiToCompute: 0.02,
    },
    {
      id: 'hardware',
      name: '计算设备领域',
      desc: '压低设备造价，让扩张更快。',
      period: '中线，反哺科技线',
      rate: 0.015,
      decay: 0.60,
      /** 成本折扣下限（最低降到原价的这个比例） */
      cap: 0.35,
    },
    {
      id: 'finance',
      name: '金融行业',
      desc: '用算力直接变现，换取购买设备的本金。',
      period: '短线，即时变现',
      rate: 0.5,
      decay: 0.70,
    },
    {
      id: 'technique',
      name: '功法增幅',
      desc: '把算力灌入功法，直接放大灵气吸收速度。',
      period: '需先习得功法',
      /** 未习得功法时锁定：前端置灰不可拖，产出恒为 0 */
      locked: true,
      /** 产出作为「灵气产出倍率」叠加（0.3 → +30%） */
      rate: 0.3,
      decay: 0.55,
    },
    {
      id: 'industry',
      name: '工业产能',
      desc: '把算力拨给生产线，决定全厂能开动多少机器。',
      period: '公司线，产能总闸',
      /** 未成立公司时锁定（成立公司后由核心层解锁，与功法增幅同一套机制） */
      locked: true,
      /**
       * 这一项的产出**不是资源**，而是「工业算力池」：
       *
       *     池 = 实际算力 × 本项份额 × company.industrialCompute.ratio
       *
       * 生产线按各自的产能（rate）从这个池子里取用；池子不够时**统一按比例削减**，
       * 不是先到先得 —— 于是算力不足时多买线不会凭空增产，只会把每条线摊薄。
       */
      toIndustrialCompute: true,
      rate: 0,
      decay: 1,
    },
  ],

  // ============================================================
  // 修仙线
  // ============================================================

  /**
   * 功法系统。
   *
   * 获取链：买下第一台「个人电脑」→ 自动习得第一本功法（黄级）
   *         → **同时解锁灵气系统**（在此之前灵气恒为 0）
   *         后续功法按境界 + 算力条件自动习得。
   *
   * 同一时间只修炼一本。修炼涨熟练度；熟练度修满后该功法的**被动属性转为常驻**，
   * 之后切换到别的功法也不会丢失。
   *
   * 等级由**算力**换算（无上限），等级越高主属性（灵气吸收速度）越强。
   *
   * requireForSpirit：是否需要习得功法才能产生灵气。
   *   现在功法可以正常获取了（个人电脑只要 50 金钱，工作几次就能买到），
   *   所以这里可以安全地打开 —— 凡人期是「打工攒钱 → 买电脑 → 得功法 → 才有灵气」，
   *   不会死锁。这也正是用户要求的「没有功法之前不允许获得灵气」。
   */
  techniques: {
    /** 功法系统是否已实现 */
    implemented: true,

    /** 是否要求习得功法才能产出灵气 */
    requireForSpirit: true,

    /** 第一本功法的获取条件 */
    firstUnlock: { device: 'pc', count: 1 },

    /**
     * 熟练度段位（6 段）。need = 达到该段所需的**累计**熟练度。
     * 速度基准 1 点/现实秒，因此「圆满」需要约 2.5 小时（有神识加成会快得多）。
     */
    mastery: [
      { id: 'entry',      name: '入门', need: 0 },
      { id: 'skilled',    name: '熟练', need: 60 },
      { id: 'minor',      name: '小成', need: 240 },
      { id: 'proficient', name: '精通', need: 900 },
      { id: 'major',      name: '大成', need: 3000 },
      { id: 'perfect',    name: '圆满', need: 9000 },
    ],

    /** 修炼：挂机积累熟练度 */
    cultivate: {
      /** 基础速度（熟练度 / 现实秒） */
      pointsPerSecond: 1,
      /** 神识对修炼速度的增幅：速度 ×(1 + 神识 × 该系数)。修炼速度即灵气提升速度 */
      shenshiBonusPerPoint: 0.02,
    },

    /** 参悟：消耗灵气，立即获得熟练度（相当于熟练度的「催工」） */
    comprehend: {
      /** 消耗 = 当前境界突破所需灵气 × 该比例 */
      qiCostRatio: 0.02,
      /** 每次获得「当前段位增量」的该比例（0.25 = 4 次参悟升一段） */
      gainRatio: 0.25,
    },

    /** 功法等级：由算力换算，无上限 */
    level: {
      /** level = floor(log10(1 + 算力) × logCoef) */
      logCoef: 4,
      /** 每级提升主属性的比例 */
      mainPerLevel: 0.08,
    },

    /**
     * 稀有度 —— 6 级，黄最普通 → 宙最稀有。
     * 名称取自「天地玄黄，宇宙洪荒」，此处取前六字。
     * 稀有度**无法提升**，越高主属性基值越强。
     */
    rarities: [
      { id: 'huang', name: '黄', level: 1, mainQiSpeed: 0.20 },
      { id: 'xuan',  name: '玄', level: 2, mainQiSpeed: 0.60 },
      { id: 'di',    name: '地', level: 3, mainQiSpeed: 1.8 },
      { id: 'tian',  name: '天', level: 4, mainQiSpeed: 5.0 },
      { id: 'yu',    name: '宇', level: 5, mainQiSpeed: 15 },
      { id: 'zhou',  name: '宙', level: 6, mainQiSpeed: 45 },
    ],

    /**
     * 功法表 —— 命名规则：数学的深奥程度 × 修仙术语。
     * 数学越深入，稀有度越高。
     *
     * 主属性统一为「灵气吸收速度」，强度 = rarities[].mainQiSpeed × (1 + 等级 × mainPerLevel)。
     * 被动属性在熟练度修满后转为常驻，支持的效果键：
     *   money      工作金钱
     *   energyMax  精力上限
     *   compute    算力
     *   deviceCost 设备成本（负值 = 打折）
     *   shenshi    神识
     *   allOutput  全部产出
     */
    list: [
      {
        id: 'jiuzhang', name: '九章算经·残卷', rarity: 'huang',
        school: '算术', realm: 0, compute: 0,
        passive: { money: 0.05 },
        desc: '从竹简残页里拼出的四则运算。看似粗浅，却是万法之基。',
      },
      {
        id: 'daishu', name: '代数真解', rarity: 'xuan',
        school: '代数与几何', realm: 1, compute: 0,
        passive: { energyMax: 0.10 },
        desc: '以符号代替未知，以方程锁住天机。未知数一旦被命名，就已经被驯服。',
      },
      {
        id: 'liushu', name: '流数周天', rarity: 'di',
        school: '微积分与分析', realm: 2, compute: 0,
        passive: { compute: 0.10 },
        desc: '把无穷小切成无穷多片，再拼回一个整圆。周天运转，无非求导与积分。',
      },
      {
        id: 'liuxing', name: '流形遁法', rarity: 'tian',
        school: '拓扑与流形', realm: 3, compute: 0,
        passive: { deviceCost: -0.15 },
        desc: '在局部与整体之间穿行。你看不见那个洞，但正是洞让空间连成一体。',
      },
      {
        id: 'tongdiao', name: '同调大衍篇', rarity: 'yu',
        school: '范畴论与同调代数', realm: 4, compute: 1e6,
        passive: { shenshi: 0.25 },
        desc: '不再追问「是什么」，只追问「箭头怎么连」。万物皆为对象，万物皆有态射。',
      },
      {
        id: 'lianxu', name: '连续统真言', rarity: 'zhou',
        school: '数理逻辑·大基数', realm: 4, compute: 1e9,
        passive: { allOutput: 0.30 },
        desc: '有些命题，你既无法证明它为真，也无法证明它为假。参至此境，言语道断。',
      },
    ],
  },

  /**
   * 境界表
   * need      = 从本境界突破到下一境界所需的**灵气**
   * maxEnergy = 该境界的精力上限（工作的硬约束，随境界提升）
   * shenshi   = 该境界的基础神识（设备加成会在此基础上再放大）
   *
   * 数值曲线：每级灵气阈值 ×100 左右（跨 2 个数量级），保证每个境界都有明显的
   * 「攒资源 → 突破」阶段，而不是几十分钟一路冲上去。
   *
   * 兵解（转生）：按设定元婴以上才能兵解，因此本轮不引入兵解系统，
   * 但功法字段已按兵解规则拆开存储（等级 / 熟练度进度 / 熟练度段位三者独立），
   * 将来做兵解时「保留功法、清空等级、清空熟练度进度、保留熟练度段位」可以直接实现。
   */
  realms: [
    { id: 0, name: '凡人', need: 500,   maxEnergy: 100, shenshi: 1 },
    { id: 1, name: '炼气', need: 5e4,   maxEnergy: 160, shenshi: 4 },
    { id: 2, name: '筑基', need: 5e6,   maxEnergy: 260, shenshi: 14 },
    { id: 3, name: '金丹', need: 5e8,   maxEnergy: 420, shenshi: 40 },
    { id: 4, name: '元婴', need: 5e10,  maxEnergy: 660, shenshi: 100 },
  ],

  // ============================================================
  // 公司（产业）系统
  // ============================================================

  /**
   * 公司 —— 与「工作」彻底分开的另一条线。
   *
   *   工作 = 职业：**别人雇你**。收益固定、消耗精力、受时间档位驱动。
   *                 它是「起步资金」的来源，也是前期唯一的收入。
   *   公司 = 产业：**你自己生产、自己卖**。收益随市价浮动、不消耗精力，
   *                 但每周期要付维护费（原料 + 人工），卖不出去会积压。
   *
   * ------------------------------------------------------------
   * 为什么生产周期按「现实时间」而不是「游戏内时间」
   * ------------------------------------------------------------
   * 时间档位可以调到「1 秒 = 1 个月」。如果公司周期也跟着游戏内时间走，
   * 玩家拉满档位就能无限产钱 —— 这与精力锁死工作产出的道理是同一个。
   * 所以公司周期固定在现实时间上（20 秒），它是**与档位无关的产能上限**。
   *
   * 对应的代价是：后期工作受档位加成、单次收益跨数量级暴涨，而公司周期恒定。
   * 所以公司要靠**规模**（买很多条生产线）和**择时**（低买高卖）取胜，
   * 而不是靠时间加速。这正是「产业」与「职业」的区别。
   *
   * ------------------------------------------------------------
   * 关于「工作 : 公司产物 = 1 : 10」
   * ------------------------------------------------------------
   * 指**同等档位下**，一条基础生产线一个周期的毛产出价值
   * ≈ 单次同级别工作的 10 倍。见下方 workshop 的注释。
   */
  company: {
    /** 公司系统是否已实现 */
    implemented: true,

    /** 注册门槛：境界 + 金钱（金钱同时就是注册费） */
    unlock: { realm: 1 },

    /** 注册费（金钱） */
    foundCost: 5e4,

    /**
     * 生产周期（现实秒）。
     * 每个周期：① 扣维护费（原料 + 人工）→ ② 各生产线产出商品 → ③ 入库 / 自动卖出。
     */
    cycleRealSeconds: 20,

    /**
     * 仓库 —— 升级扩容，防止产物积压。
     * 容量按「件数」计（不同商品件数意义不同，此处统一简化）。
     */
    warehouse: {
      /** 基础容量（等级 0） */
      baseCapacity: 500,
      /** 每级增加的容量 */
      perLevel: 600,
      /** 首次升级价格 */
      baseCost: 2e5,
      /** 价格涨幅 */
      costGrowth: 1.55,
      /** 最高等级 */
      maxLevel: 40,
    },

    /**
     * 市场抛压 —— 「卖得多，价格被压低」的反噬机制。
     *
     * 设计意图（关键）：**市场消化得了你的正常产量，消化不了你砸出去的库存。**
     * 所以抛压只由「本期净抛售」决定：
     *
     *     净抛售 excess = max(0, 本期卖出量 − 本期产出量)
     *
     * 开着自动卖出、产多少卖多少时 excess = 0 → **零折价**，扩张产能不会自我惩罚。
     * 但把攒了几十期的库存一次性清空，或停售几期后集中出货，excess 会很大，
     * 价格当期就被打下去，并且**顺延到下一期继续压制**，之后按 decay 逐期恢复。
     *
     * 压力的演化（每期结算一次，只在「期切换」时发生）：
     *
     *     add      = clamp(excess / max(baseVolume, 本期产出), 0, 1)
     *     pressure = clamp(max(pressure × decay^期数, add), 0, 1)   ← 取大值，不叠加
     *     impact   = 1 − pressure × maxDrop                          → 0.60 ~ 1.00
     *     price    = basePrice × 自然波动因子 × impact
     *
     * 全程确定性：只依赖存档里的卖出/产出计数，不使用随机数 —— 前端 tick 与
     * 后端离线结算必须算出同一个价格，否则屏幕上的钱和服务器存的钱会对不上。
     */
    market: {
      /** 参考成交量的下限（件/期）。没有产出、纯砸库存时的分母，防止除零。 */
      baseVolume: 60,
      /** 满档抛压下的压价幅度（0.40 = 最多打 6 折） */
      maxDrop: 0.40,
      /** 每过一期，旧压力保留的比例（0.5 = 一期减半，约 4 期回到可忽略） */
      decay: 0.5,
      /**
       * 综合价格的绝对下限（相对基准价的倍数）。
       * 自然波动下限 × 抛压下限可能叠得很低，这里兜一道底，
       * 保证任何情况下公司都还有薄利可图，不至于彻底变成负收益。
       */
      floor: 0.15,
      /** 抛压超过这个值就在前端标红警示 */
      warnAt: 0.45,
    },

    /**
     * 行业表 —— 产物按行业归类，行业之间有上下游。
     *
     *   upstream     上游行业（成本从这里来）
     *   tier         产业链层级（1 = 最上游，只受自身供需影响）
     *   passThrough  上游涨价 → 本行业**成本**的传导强度（0 = 不受上游影响）
     *   pricePass    上游涨价 → 本行业**售价**的传导强度
     *
     * 成本传导的关键：pricePass **恒小于** passThrough。于是上游一涨，
     * 下游「售价涨得比成本慢」，毛利被压缩 —— 矿价暴涨时钢锭也贵，
     * 但炼钢厂反而更不赚钱，玩家会想去开上游的线。这是行业联动要的体感。
     */
    industries: [
      { id: 'mining',    name: '采掘',     kind: 'tech',    tier: 1, upstream: [],                              passThrough: 0.00, pricePass: 0.00 },
      { id: 'smelt',     name: '冶炼',     kind: 'tech',    tier: 2, upstream: ['mining'],                      passThrough: 0.55, pricePass: 0.30 },
      { id: 'chem',      name: '化工',     kind: 'tech',    tier: 2, upstream: ['mining'],                      passThrough: 0.45, pricePass: 0.25 },
      { id: 'precision', name: '精密制造', kind: 'tech',    tier: 3, upstream: ['smelt'],                       passThrough: 0.50, pricePass: 0.28 },
      { id: 'electron',  name: '电子',     kind: 'tech',    tier: 4, upstream: ['smelt', 'chem'],               passThrough: 0.50, pricePass: 0.26 },
      { id: 'assembly',  name: '整机装配', kind: 'tech',    tier: 5, upstream: ['electron', 'precision'],       passThrough: 0.55, pricePass: 0.28 },
      { id: 'herb',      name: '灵植',     kind: 'xiuxian', tier: 1, upstream: [],                              passThrough: 0.00, pricePass: 0.00 },
      { id: 'alchemy',   name: '炼丹',     kind: 'xiuxian', tier: 2, upstream: ['herb'],                        passThrough: 0.60, pricePass: 0.32 },
      { id: 'talisman',  name: '制符',     kind: 'xiuxian', tier: 2, upstream: ['herb'],                        passThrough: 0.50, pricePass: 0.26 },
      { id: 'refine',    name: '炼器',     kind: 'xiuxian', tier: 3, upstream: ['smelt'],                       passThrough: 0.50, pricePass: 0.27 },
      { id: 'array',     name: '阵盘',     kind: 'xiuxian', tier: 4, upstream: ['refine', 'talisman'],          passThrough: 0.50, pricePass: 0.26 },
      { id: 'cave',      name: '洞天',     kind: 'xiuxian', tier: 5, upstream: ['array', 'alchemy'],            passThrough: 0.45, pricePass: 0.24 },
    ],

    /**
     * 商品表 —— 12 个行业，每行业 6 种产物。
     *
     *   industry     所属行业（决定上下游传导，也决定它能被哪条生产线制造）
     *   basePrice    基准价（市价围绕它波动）
     *   volatility   波动幅度 / min-max 市价相对基准价的倍数上下限
     *   periodYears  变价周期（**游戏内年**）。科技类 1 年，修仙类 10 年。
     *   outputCoef   产量系数：同一条线造它时，产量 = 线基准产量 × outputCoef
     *                越贵的产物造得越慢，于是「堆产量」与「堆单价」是两种打法
     *   upkeepRate   维护费率：单件维护费 = 售价 × upkeepRate（原料 + 人工合计）
     *                基准 0.30（净收益率 70%），高阶产物略高
     *
     * 市价由 (商品序号, 期数) 确定性推导，不做随机数 —— 前端 tick 与后端
     * 离线结算必须算出同一个价格，否则两端进度会对不上。
     */
    goods: [
      // ---- 采掘（最上游，无上游成本）----
      { id: 'iron_ore',    name: '铁矿石',   kind: 'tech', industry: 'mining', basePrice: 12,  volatility: 0.34, minFactor: 0.45, maxFactor: 2.30, periodYears: 1, outputCoef: 1.20, upkeepRate: 0.28 },
      { id: 'coal',        name: '焦煤',     kind: 'tech', industry: 'mining', basePrice: 16,  volatility: 0.33, minFactor: 0.46, maxFactor: 2.25, periodYears: 1, outputCoef: 1.15, upkeepRate: 0.28 },
      { id: 'copper_ore',  name: '铜矿石',   kind: 'tech', industry: 'mining', basePrice: 18,  volatility: 0.33, minFactor: 0.46, maxFactor: 2.25, periodYears: 1, outputCoef: 1.12, upkeepRate: 0.29 },
      { id: 'bauxite',     name: '铝土矿',   kind: 'tech', industry: 'mining', basePrice: 22,  volatility: 0.32, minFactor: 0.47, maxFactor: 2.20, periodYears: 1, outputCoef: 1.08, upkeepRate: 0.29 },
      { id: 'silica',      name: '硅石',     kind: 'tech', industry: 'mining', basePrice: 28,  volatility: 0.31, minFactor: 0.48, maxFactor: 2.15, periodYears: 1, outputCoef: 1.00, upkeepRate: 0.29 },
      { id: 'rare_earth',  name: '稀土矿',   kind: 'tech', industry: 'mining', basePrice: 55,  volatility: 0.36, minFactor: 0.42, maxFactor: 2.45, periodYears: 1, outputCoef: 0.72, upkeepRate: 0.31 },
      // ---- 冶炼（上游：采掘）----
      { id: 'pig_iron',    name: '生铁',     kind: 'tech', industry: 'smelt', basePrice: 95,   volatility: 0.31, minFactor: 0.48, maxFactor: 2.15, periodYears: 1, outputCoef: 1.18, upkeepRate: 0.29 },
      { id: 'blister_cu',  name: '粗铜',     kind: 'tech', industry: 'smelt', basePrice: 140,  volatility: 0.31, minFactor: 0.48, maxFactor: 2.12, periodYears: 1, outputCoef: 1.10, upkeepRate: 0.29 },
      { id: 'aluminum',    name: '铝锭',     kind: 'tech', industry: 'smelt', basePrice: 170,  volatility: 0.30, minFactor: 0.49, maxFactor: 2.10, periodYears: 1, outputCoef: 1.05, upkeepRate: 0.30 },
      { id: 'steel',       name: '钢材',     kind: 'tech', industry: 'smelt', basePrice: 210,  volatility: 0.29, minFactor: 0.50, maxFactor: 2.08, periodYears: 1, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'silicon_met', name: '工业硅',   kind: 'tech', industry: 'smelt', basePrice: 260,  volatility: 0.30, minFactor: 0.50, maxFactor: 2.08, periodYears: 1, outputCoef: 0.92, upkeepRate: 0.30 },
      { id: 'rare_alloy',  name: '稀土合金', kind: 'tech', industry: 'smelt', basePrice: 400,  volatility: 0.33, minFactor: 0.46, maxFactor: 2.20, periodYears: 1, outputCoef: 0.70, upkeepRate: 0.32 },
      // ---- 化工（上游：采掘）----
      { id: 'sulfuric',    name: '硫酸',     kind: 'tech', industry: 'chem', basePrice: 115,  volatility: 0.30, minFactor: 0.49, maxFactor: 2.08, periodYears: 1, outputCoef: 1.18, upkeepRate: 0.28 },
      { id: 'ammonia',     name: '合成氨',   kind: 'tech', industry: 'chem', basePrice: 150,  volatility: 0.30, minFactor: 0.49, maxFactor: 2.06, periodYears: 1, outputCoef: 1.10, upkeepRate: 0.29 },
      { id: 'ethylene',    name: '乙烯',     kind: 'tech', industry: 'chem', basePrice: 190,  volatility: 0.29, minFactor: 0.50, maxFactor: 2.04, periodYears: 1, outputCoef: 1.02, upkeepRate: 0.29 },
      { id: 'spec_gas',    name: '特种气体', kind: 'tech', industry: 'chem', basePrice: 420,  volatility: 0.31, minFactor: 0.48, maxFactor: 2.10, periodYears: 1, outputCoef: 0.85, upkeepRate: 0.31 },
      { id: 'reagent',     name: '高纯试剂', kind: 'tech', industry: 'chem', basePrice: 560,  volatility: 0.32, minFactor: 0.47, maxFactor: 2.12, periodYears: 1, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'photoresist', name: '光刻胶',   kind: 'tech', industry: 'chem', basePrice: 880,  volatility: 0.35, minFactor: 0.44, maxFactor: 2.25, periodYears: 1, outputCoef: 0.62, upkeepRate: 0.33 },
      // ---- 精密制造（上游：冶炼）----
      { id: 'bearing',     name: '轴承',     kind: 'tech', industry: 'precision', basePrice: 620,  volatility: 0.28, minFactor: 0.52, maxFactor: 1.98, periodYears: 1, outputCoef: 1.16, upkeepRate: 0.29 },
      { id: 'gearbox',     name: '齿轮组',   kind: 'tech', industry: 'precision', basePrice: 850,  volatility: 0.28, minFactor: 0.52, maxFactor: 1.96, periodYears: 1, outputCoef: 1.08, upkeepRate: 0.29 },
      { id: 'hydraulic',   name: '液压件',   kind: 'tech', industry: 'precision', basePrice: 1100, volatility: 0.27, minFactor: 0.53, maxFactor: 1.94, periodYears: 1, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'mold',        name: '精密模具', kind: 'tech', industry: 'precision', basePrice: 1500, volatility: 0.28, minFactor: 0.52, maxFactor: 1.94, periodYears: 1, outputCoef: 0.90, upkeepRate: 0.30 },
      { id: 'optics',      name: '光学镜片', kind: 'tech', industry: 'precision', basePrice: 2600, volatility: 0.30, minFactor: 0.50, maxFactor: 1.98, periodYears: 1, outputCoef: 0.74, upkeepRate: 0.31 },
      { id: 'chamber',     name: '真空腔体', kind: 'tech', industry: 'precision', basePrice: 4200, volatility: 0.32, minFactor: 0.48, maxFactor: 2.02, periodYears: 1, outputCoef: 0.60, upkeepRate: 0.32 },
      // ---- 电子（上游：冶炼 + 化工）----
      { id: 'component',   name: '电子元件', kind: 'tech', industry: 'electron', basePrice: 3200,  volatility: 0.30, minFactor: 0.50, maxFactor: 2.00, periodYears: 1, outputCoef: 1.15, upkeepRate: 0.29 },
      { id: 'power_dev',   name: '功率器件', kind: 'tech', industry: 'electron', basePrice: 5400,  volatility: 0.31, minFactor: 0.49, maxFactor: 2.02, periodYears: 1, outputCoef: 1.05, upkeepRate: 0.30 },
      { id: 'sensor',      name: '传感器',   kind: 'tech', industry: 'electron', basePrice: 8200,  volatility: 0.31, minFactor: 0.49, maxFactor: 2.02, periodYears: 1, outputCoef: 0.95, upkeepRate: 0.30 },
      { id: 'memory_die',  name: '存储颗粒', kind: 'tech', industry: 'electron', basePrice: 15000, volatility: 0.34, minFactor: 0.46, maxFactor: 2.12, periodYears: 1, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'optical_mod', name: '光模块',   kind: 'tech', industry: 'electron', basePrice: 28000, volatility: 0.35, minFactor: 0.45, maxFactor: 2.15, periodYears: 1, outputCoef: 0.66, upkeepRate: 0.32 },
      { id: 'chip',        name: '半导体芯片', kind: 'tech', industry: 'electron', basePrice: 52000, volatility: 0.38, minFactor: 0.42, maxFactor: 2.25, periodYears: 1, outputCoef: 0.52, upkeepRate: 0.33 },
      // ---- 整机装配（上游：电子 + 精密制造）----
      { id: 'server',      name: '服务器整机', kind: 'tech', industry: 'assembly', basePrice: 1.3e5, volatility: 0.28, minFactor: 0.53, maxFactor: 1.94, periodYears: 1, outputCoef: 1.15, upkeepRate: 0.29 },
      { id: 'robot',       name: '工业机器人', kind: 'tech', industry: 'assembly', basePrice: 2.6e5, volatility: 0.29, minFactor: 0.52, maxFactor: 1.96, periodYears: 1, outputCoef: 1.02, upkeepRate: 0.30 },
      { id: 'cabinet',     name: '算力集群',   kind: 'tech', industry: 'assembly', basePrice: 5.5e5, volatility: 0.30, minFactor: 0.51, maxFactor: 1.98, periodYears: 1, outputCoef: 0.88, upkeepRate: 0.30 },
      { id: 'cnc',         name: '精密机床',   kind: 'tech', industry: 'assembly', basePrice: 1.1e6, volatility: 0.30, minFactor: 0.51, maxFactor: 1.98, periodYears: 1, outputCoef: 0.74, upkeepRate: 0.31 },
      { id: 'imaging',     name: '影像设备',   kind: 'tech', industry: 'assembly', basePrice: 1.8e6, volatility: 0.31, minFactor: 0.50, maxFactor: 2.00, periodYears: 1, outputCoef: 0.64, upkeepRate: 0.31 },
      { id: 'sat_bus',     name: '卫星平台',   kind: 'tech', industry: 'assembly', basePrice: 3.2e6, volatility: 0.34, minFactor: 0.47, maxFactor: 2.10, periodYears: 1, outputCoef: 0.52, upkeepRate: 0.33 },
      // ---- 灵植（修仙最上游）----
      { id: 'spirit_grain',  name: '灵谷',   kind: 'xiuxian', industry: 'herb', basePrice: 220,  volatility: 0.24, minFactor: 0.58, maxFactor: 1.88, periodYears: 10, outputCoef: 1.20, upkeepRate: 0.28 },
      { id: 'spirit_hemp',   name: '灵麻',   kind: 'xiuxian', industry: 'herb', basePrice: 340,  volatility: 0.24, minFactor: 0.58, maxFactor: 1.86, periodYears: 10, outputCoef: 1.12, upkeepRate: 0.28 },
      { id: 'moon_herb',     name: '月华草', kind: 'xiuxian', industry: 'herb', basePrice: 620,  volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodYears: 10, outputCoef: 1.00, upkeepRate: 0.29 },
      { id: 'frost_lotus',   name: '玄冰花', kind: 'xiuxian', industry: 'herb', basePrice: 980,  volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 0.88, upkeepRate: 0.29 },
      { id: 'blood_ginseng', name: '赤血参', kind: 'xiuxian', industry: 'herb', basePrice: 1600, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodYears: 10, outputCoef: 0.76, upkeepRate: 0.30 },
      { id: 'thunder_wood',  name: '雷击木', kind: 'xiuxian', industry: 'herb', basePrice: 2800, volatility: 0.29, minFactor: 0.53, maxFactor: 1.96, periodYears: 10, outputCoef: 0.62, upkeepRate: 0.31 },
      // ---- 炼丹（上游：灵植）----
      { id: 'body_pill',   name: '淬体丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 1.3e4, volatility: 0.23, minFactor: 0.59, maxFactor: 1.85, periodYears: 10, outputCoef: 1.18, upkeepRate: 0.29 },
      { id: 'gather_pill', name: '聚灵丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 3.0e4, volatility: 0.23, minFactor: 0.59, maxFactor: 1.84, periodYears: 10, outputCoef: 1.05, upkeepRate: 0.29 },
      { id: 'heal_pill',   name: '疗伤丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 7.0e4, volatility: 0.24, minFactor: 0.58, maxFactor: 1.86, periodYears: 10, outputCoef: 0.92, upkeepRate: 0.30 },
      { id: 'marrow_pill', name: '洗髓丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 1.8e5, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodYears: 10, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'break_pill',  name: '破境丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 4.5e5, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodYears: 10, outputCoef: 0.64, upkeepRate: 0.32 },
      { id: 'golden_pill', name: '九转金丹', kind: 'xiuxian', industry: 'alchemy', basePrice: 1.2e6, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodYears: 10, outputCoef: 0.50, upkeepRate: 0.33 },
      // ---- 制符（上游：灵植）----
      { id: 'wind_talis',   name: '清风符', kind: 'xiuxian', industry: 'talisman', basePrice: 9.5e3, volatility: 0.23, minFactor: 0.60, maxFactor: 1.84, periodYears: 10, outputCoef: 1.18, upkeepRate: 0.29 },
      { id: 'fire_talis',   name: '火球符', kind: 'xiuxian', industry: 'talisman', basePrice: 2.2e4, volatility: 0.23, minFactor: 0.59, maxFactor: 1.84, periodYears: 10, outputCoef: 1.06, upkeepRate: 0.29 },
      { id: 'conceal_tal',  name: '敛息符', kind: 'xiuxian', industry: 'talisman', basePrice: 5.5e4, volatility: 0.24, minFactor: 0.58, maxFactor: 1.86, periodYears: 10, outputCoef: 0.92, upkeepRate: 0.30 },
      { id: 'vajra_talis',  name: '金刚符', kind: 'xiuxian', industry: 'talisman', basePrice: 1.4e5, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodYears: 10, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'thunder_tal',  name: '雷符',   kind: 'xiuxian', industry: 'talisman', basePrice: 3.5e5, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodYears: 10, outputCoef: 0.64, upkeepRate: 0.32 },
      { id: 'teleport_tal', name: '传送符', kind: 'xiuxian', industry: 'talisman', basePrice: 9.0e5, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodYears: 10, outputCoef: 0.50, upkeepRate: 0.33 },
      // ---- 炼器（上游：冶炼）----
      { id: 'storage_ring',  name: '储物戒',   kind: 'xiuxian', industry: 'refine', basePrice: 5.5e4, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodYears: 10, outputCoef: 1.16, upkeepRate: 0.29 },
      { id: 'magic_sword',   name: '法剑',     kind: 'xiuxian', industry: 'refine', basePrice: 1.4e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 1.02, upkeepRate: 0.30 },
      { id: 'armor',         name: '护甲',     kind: 'xiuxian', industry: 'refine', basePrice: 3.5e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 0.88, upkeepRate: 0.30 },
      { id: 'flying_boat',   name: '飞舟',     kind: 'xiuxian', industry: 'refine', basePrice: 9.0e5, volatility: 0.28, minFactor: 0.54, maxFactor: 1.94, periodYears: 10, outputCoef: 0.72, upkeepRate: 0.31 },
      { id: 'spirit_furnace',name: '灵炉',     kind: 'xiuxian', industry: 'refine', basePrice: 2.5e6, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodYears: 10, outputCoef: 0.58, upkeepRate: 0.32 },
      { id: 'core_treasure', name: '本命法宝', kind: 'xiuxian', industry: 'refine', basePrice: 7.0e6, volatility: 0.34, minFactor: 0.48, maxFactor: 2.08, periodYears: 10, outputCoef: 0.42, upkeepRate: 0.34 },
      // ---- 阵盘（上游：炼器 + 制符）----
      { id: 'ward_array',   name: '防护阵',     kind: 'xiuxian', industry: 'array', basePrice: 6.5e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 1.14, upkeepRate: 0.29 },
      { id: 'gather_array', name: '聚灵阵',     kind: 'xiuxian', industry: 'array', basePrice: 1.5e6, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'illusion_arr', name: '幻阵',       kind: 'xiuxian', industry: 'array', basePrice: 3.5e6, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodYears: 10, outputCoef: 0.86, upkeepRate: 0.30 },
      { id: 'kill_array',   name: '杀伐阵',     kind: 'xiuxian', industry: 'array', basePrice: 8.0e6, volatility: 0.29, minFactor: 0.53, maxFactor: 1.96, periodYears: 10, outputCoef: 0.70, upkeepRate: 0.31 },
      { id: 'teleport_arr', name: '传送阵',     kind: 'xiuxian', industry: 'array', basePrice: 2.0e7, volatility: 0.31, minFactor: 0.51, maxFactor: 2.00, periodYears: 10, outputCoef: 0.56, upkeepRate: 0.32 },
      { id: 'star_array',   name: '周天星斗阵', kind: 'xiuxian', industry: 'array', basePrice: 5.0e7, volatility: 0.35, minFactor: 0.47, maxFactor: 2.10, periodYears: 10, outputCoef: 0.40, upkeepRate: 0.34 },
      // ---- 洞天（上游：阵盘 + 炼丹）----
      { id: 'leyline_node', name: '灵脉节点', kind: 'xiuxian', industry: 'cave', basePrice: 2.2e10, volatility: 0.24, minFactor: 0.58, maxFactor: 1.88, periodYears: 10, outputCoef: 1.14, upkeepRate: 0.29 },
      { id: 'cave_heaven',  name: '洞天福地', kind: 'xiuxian', industry: 'cave', basePrice: 4.5e10, volatility: 0.24, minFactor: 0.58, maxFactor: 1.88, periodYears: 10, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'void_ship',    name: '太虚舟',   kind: 'xiuxian', industry: 'cave', basePrice: 9.0e10, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 0.84, upkeepRate: 0.30 },
      { id: 'micro_world',  name: '小千世界', kind: 'xiuxian', industry: 'cave', basePrice: 2.0e11, volatility: 0.28, minFactor: 0.54, maxFactor: 1.94, periodYears: 10, outputCoef: 0.68, upkeepRate: 0.31 },
      { id: 'star_core',    name: '星辰核',   kind: 'xiuxian', industry: 'cave', basePrice: 5.0e11, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodYears: 10, outputCoef: 0.54, upkeepRate: 0.32 },
      { id: 'world_tree',   name: '世界树',   kind: 'xiuxian', industry: 'cave', basePrice: 1.2e12, volatility: 0.33, minFactor: 0.49, maxFactor: 2.04, periodYears: 10, outputCoef: 0.40, upkeepRate: 0.34 },
    ],

    /**
     * 生产线 —— 与「算力设备」完全分开的一套设备，但**吃同一份算力**。
     *
     * 与旧模型最大的不同：**生产线不再绑定单一产物**。
     * 一条线买下来对应一个行业，可以随时改产这个行业的 6 种产物之一，
     * 也可以单独调这条线的产能（0~100%），产能决定它占用多少算力、产多少货。
     *
     *   industry     所属行业 —— 决定这条线能造哪些产物（该行业的全部产物）
     *   maxCompute   满载算力（满载 = 产能 100%）。不同档次的线差距很大
     *   baseOutput   基准产量（件/周期，满载时）。实际产量再乘产物的 outputCoef
     *   cost/growth  买第 n 条 = cost × growth^n
     *   realm/after  解锁条件：境界 + 前置生产线数量
     *
     * 算力账：**全厂总需求 = Σ(每条线 maxCompute × 它的产能)**，
     * 这个总需求由「工业产能」投向提供的算力池来供。池子不够时**统一按比例削减**
     * （不是先到先得），于是「多买线」在算力不足时不会凭空增产，只会摊薄每条线。
     *
     * 数值配平：单位算力的产值随产业链层级递增（采掘 0.6 → 洞天 8.5），
     * 所以高级线永远更划算 —— 但它的造价、解锁门槛与维护费也同步抬升。
     */
    lines: [
      {
        id: 'mine', name: '矿井', industry: 'mining',
        maxCompute: 4.0e3, baseOutput: 90, cost: 2.5e4, costGrowth: 1.18,
        realm: 1, after: null,
        desc: '打一口竖井，把地里的东西挖出来卖。产业链的第一环，谁都得从这里开始。',
      },
      {
        id: 'smelter', name: '炼钢厂', industry: 'smelt',
        maxCompute: 1.3e4, baseOutput: 60, cost: 3.5e5, costGrowth: 1.19,
        realm: 1, after: { id: 'mine', times: 4 },
        desc: '高炉转炉连铸线。铁矿石进去，钢材出来 —— 也吃矿价，矿一涨它就肉疼。',
      },
      {
        id: 'chemplant', name: '化工厂', industry: 'chem',
        maxCompute: 1.6e4, baseOutput: 95, cost: 4.2e5, costGrowth: 1.19,
        realm: 1, after: { id: 'mine', times: 4 },
        desc: '反应釜、精馏塔、尾气处理。从硫酸到光刻胶，同一套装置换个配方就是另一门生意。',
      },
      {
        id: 'precision', name: '精密制造厂', industry: 'precision',
        maxCompute: 8.6e4, baseOutput: 110, cost: 8.0e6, costGrowth: 1.21,
        realm: 2, after: { id: 'smelter', times: 4 },
        desc: '恒温恒湿车间里的机床群。轴承、齿轮、模具、镜片 —— 精度就是定价权。',
      },
      {
        id: 'elecplant', name: '电子元件厂', industry: 'electron',
        maxCompute: 4.4e5, baseOutput: 100, cost: 2.2e8, costGrowth: 1.22,
        realm: 2, after: { id: 'chemplant', times: 4 },
        desc: '洁净室与光刻区。一颗芯片要过上百道工序，良率每提一个点都是钱。',
      },
      {
        id: 'assembly', name: '整机装配厂', industry: 'assembly',
        maxCompute: 2.1e6, baseOutput: 9, cost: 6.0e9, costGrowth: 1.24,
        realm: 3, after: { id: 'elecplant', times: 4 },
        desc: '把别人的零件装成能卖的系统。服务器、机床、影像设备，乃至卫星平台。',
      },
      {
        id: 'herbfield', name: '灵田', industry: 'herb',
        maxCompute: 1.3e4, baseOutput: 65, cost: 1.2e5, costGrowth: 1.18,
        realm: 2, after: null,
        desc: '引灵脉灌溉的田。灵谷灵麻一年数熟，灵草则要看节气与地气。',
      },
      {
        id: 'talismanry', name: '符箓工坊', industry: 'talisman',
        maxCompute: 3.3e5, baseOutput: 18, cost: 1.8e6, costGrowth: 1.19,
        realm: 2, after: { id: 'herbfield', times: 4 },
        desc: '用印刷电路的方式批量制符。同样的朱砂与符纸，产能翻了百倍。',
      },
      {
        id: 'alchemy', name: '丹房', industry: 'alchemy',
        maxCompute: 2.5e5, baseOutput: 12, cost: 2.4e6, costGrowth: 1.20,
        realm: 2, after: { id: 'herbfield', times: 4 },
        desc: '温控丹炉、自动投料、色谱检测成色。炼丹从玄学变成工艺。',
      },
      {
        id: 'refine', name: '炼器坊', industry: 'refine',
        maxCompute: 8.4e5, baseOutput: 10, cost: 7.0e7, costGrowth: 1.21,
        realm: 3, after: { id: 'smelter', times: 4 },
        desc: '法剑、护甲、飞舟、本命法宝。器成之时有雷劫，坊里常备避雷阵。',
      },
      {
        id: 'arrayforge', name: '阵盘锻造坊', industry: 'array',
        maxCompute: 5.1e6, baseOutput: 6, cost: 2.5e9, costGrowth: 1.23,
        realm: 3, after: { id: 'refine', times: 4 },
        desc: '把阵纹刻进晶圆，用刻蚀精度替代手工笔法。阵盘第一次可以量产。',
      },
      {
        id: 'cave', name: '洞天营造司', industry: 'cave',
        maxCompute: 3.0e10, baseOutput: 4, cost: 1.2e11, costGrowth: 1.25,
        realm: 4, after: { id: 'arrayforge', times: 4 },
        desc: '开凿小世界、接引灵脉、栽植世界树。做到这一步，你卖的已经是天地。',
      },
    ],

    /**
     * 工业算力 —— 「工业产能」投向把算力转成全厂的动力。
     *
     *   ratio       投向份额 → 工业算力池的换算（池 = 实际算力 × 份额 × ratio）
     *   minRate     单条线的最低产能（低于它就停机，避免一堆 1% 的线空转）
     */
    industrialCompute: {
      /** 份额 → 算力池的系数。1 = 份额多少就给多少算力 */
      ratio: 1,
      /** 产能下限（0.05 = 低于 5% 视为停机） */
      minRate: 0.05,
    },
  },

  // ============================================================
  // 股市系统
  // ============================================================

  /**
   * 股市 —— 与公司市场挂钩的第三条经济线。
   *
   *   工作 = 出卖时间换钱（受精力约束）
   *   公司 = 生产 + 卖货（受维护费与仓容约束，收益随市价浮动）
   *   股市 = 买卖股票（受「自己的成交量把价格推歪」约束）
   *
   * ------------------------------------------------------------
   * 一、价格怎么算（三层相乘，全部确定性）
   * ------------------------------------------------------------
   *
   *     自然价 = basePrice × 波动因子(期数) × 联动因子(公司市场)
   *     成交价 = 自然价 × 冲击系数(自己的成交与持仓)
   *
   *   波动因子只依赖「期数」，与公司的商品价格同源思路（散列，不用随机数）；
   *   联动因子把股票挂到某类商品上 —— 你在公司砸盘把商品价格打下去，
   *   对应股票也会跟着跌。这是「股市与市场经济挂钩」的落点。
   *
   * ------------------------------------------------------------
   * 二、反作用（核心机制）：你自己的成交会把价格推歪，而且永远对你不利
   * ------------------------------------------------------------
   *
   *     净买入流 flow = 本期买入股数 − 本期卖出股数（期切换时按 flowDecay 衰减）
   *     冲击 impact = 1 + clamp(flow / 流通盘 × 流动性系数, −maxDrop, +maxRise)
   *     流动性系数 = 1 + 持仓占比 × illiquidity   ← 你持仓越集中，进出越难，冲击越大
   *
   *   关键点是**按成交后的冲击结算**：买入时 flow 变大，成交价被自己推高，
   *   于是「大单买得越贵」；卖出时 flow 变小，成交价被自己压低，
   *   于是「大单一卖就砸」。而冲击每期按 flowDecay 衰减回 1 ——
   *   也就是说你「买」出来的高价会自己退回去，你想等它涨了再卖是拿不到这笔钱的。
   *
   *   于是任何一轮「买 → 卖」都必然亏掉：买入支付的冲击溢价 + 双边手续费。
   *   唯一能赚钱的方式是**赌对自然价的方向**（也就是看准行情）。
   *
   *   这同时解释了「早期本金不足时收益低」：冲击与手续费都对小资金不利，
   *   而后期资金量上来后，仓位与波动都能放大 —— 但风险同比放大。
   *
   * ------------------------------------------------------------
   * 三、为什么不做「持仓越多越涨」的市值推高
   * ------------------------------------------------------------
   *   如果持仓本身能抬高市值，玩家只要「买入 → 看着市值涨」，就能凭空套利。
   *   所以这里刻意让**持仓只影响冲击的放大倍数（惩罚）**，不影响价格水平本身。
   */
  stock: {
    /** 股市系统是否已实现 */
    implemented: true,

    /** 解锁门槛：境界（炼气期即可开户，与公司同步；不另收开户费，避免多一个单向状态） */
    unlock: { realm: 1 },

    /** 单边手续费（买入、卖出各收一次） */
    fee: 0.005,

    /**
     * 单笔最小成交金额（金钱）。
     * 低于这个值直接拒绝 —— 否则小资金可以靠高频小额交易把手续费当不存在，
     * 也与「早期本金不足时收益低」的设计意图一致。
     */
    minOrder: 1e4,

    /** 每过一期，净买入流保留的比例（0.5 = 一期减半，冲击逐期消退） */
    flowDecay: 0.5,

    /** 净买入把价格推高的上限（0.60 = 最多 +60%，买入越猛成交均价越贵） */
    maxRise: 0.60,
    /** 净卖出把价格压低的上限（0.50 = 最多 −50%，砸盘时成交均价越卖越低） */
    maxDrop: 0.50,

    /**
     * 持仓集中度对冲击的放大系数。
     * 0 = 持仓不影响冲击；1 = 持满流通盘时冲击翻倍。
     */
    illiquidity: 1.0,

    /** 成交价相对自然价的绝对下限（防止「自然价极低 + 满档砸盘」把价格压到 0 附近） */
    floor: 0.05,

    /**
     * 与公司商品价格的联动权重。
     * 1 = 完全跟随（股票变成商品的影子）；0 = 完全脱钩。取 0.5 让股票既反映行情
     * 又有自己的波动，不至于变成公司线的附庸。
     */
    linkWeight: 0.5,

    /** 前端榜单只显示市值最高的前 N 家（其余留在池子里，留给后续收购） */
    boardSize: 10,

    /**
     * 上市公司表 —— 30 家科技 + 20 家修仙（宗门）。
     *
     *   kind       tech = 科技公司，xiuxian = 修仙宗门
     *   sector     主营行业（对应 company.industries）
     *   link       联动的商品 id（null = 独立行情，不受商品市场影响）
     *   business   主营业务 —— 前端每行都显示它，行情一动就能看出波及谁
     *   depth      流通盘（股）
     *   periodYears 变价周期（游戏内年）
     *
     * 价格量级刻意比联动商品**低几个数量级**：一股的价钱不等于一件货的价钱，
     * 否则洞天类公司一股要 1e12，早期玩家永远开不了仓。同时流通盘按「目标市值
     * ≈ 1e11」反推，让 50 家的市值落在同一档 —— 榜单前 10 才会随行情真的换人。
     */
    stocks: [
      // ================= 科技 · 采掘（4）=================
      { id: 'jinshi', name: '金石矿业', code: 'JINSHI', kind: 'tech', sector: 'mining', link: 'iron_ore',
        business: '铁矿石开采与粗选', basePrice: 45, volatility: 1.05, minFactor: 0.34, maxFactor: 2.90, depth: 2.2e9, periodYears: 1,
        desc: '守着半座铁矿山过日子。钢价涨它未必涨，矿价跌它一定跌。' },
      { id: 'beiling', name: '北岭煤业', code: 'BEILING', kind: 'tech', sector: 'mining', link: 'coal',
        business: '焦煤开采与洗选', basePrice: 38, volatility: 1.00, minFactor: 0.36, maxFactor: 2.75, depth: 2.4e9, periodYears: 1,
        desc: '给所有高炉供口粮。口粮一贵，全产业链都跟着咳嗽。' },
      { id: 'chitong', name: '赤铜集团', code: 'CHITONG', kind: 'tech', sector: 'mining', link: 'copper_ore',
        business: '铜矿石采选', basePrice: 62, volatility: 1.10, minFactor: 0.33, maxFactor: 3.00, depth: 1.6e9, periodYears: 1,
        desc: '电线、电机、散热片都吃铜。它的报表就是基建的体温计。' },
      { id: 'xitu', name: '稀土纪元', code: 'XITU', kind: 'tech', sector: 'mining', link: 'rare_earth',
        business: '稀土矿开采与分离', basePrice: 180, volatility: 1.35, minFactor: 0.26, maxFactor: 3.80, depth: 4.4e8, periodYears: 1,
        desc: '一吨矿里的那几克，卡着整个高端制造的脖子。涨起来没有道理可讲。' },
      // ================= 科技 · 冶炼（4）=================
      { id: 'rongcheng', name: '熔城冶金', code: 'RONGCHENG', kind: 'tech', sector: 'smelt', link: 'pig_iron',
        business: '生铁冶炼', basePrice: 55, volatility: 0.98, minFactor: 0.37, maxFactor: 2.65, depth: 1.8e9, periodYears: 1,
        desc: '高炉日夜不熄火。矿价是它最大的敌人，钢价是它唯一的指望。' },
      { id: 'changhe', name: '长河钢铁', code: 'CHANGHE', kind: 'tech', sector: 'smelt', link: 'steel',
        business: '钢材轧制', basePrice: 95, volatility: 0.95, minFactor: 0.38, maxFactor: 2.55, depth: 1.1e9, periodYears: 1,
        desc: '基建的米铺子。毛利率薄得像钢板，全靠走量。' },
      { id: 'qingjin', name: '轻金属联合', code: 'QINGJIN', kind: 'tech', sector: 'smelt', link: 'aluminum',
        business: '铝锭电解', basePrice: 130, volatility: 1.00, minFactor: 0.36, maxFactor: 2.70, depth: 8.0e8, periodYears: 1,
        desc: '电解槽一开就是几个月不停。电价涨一分，利润就没了。' },
      { id: 'jinggui', name: '晶硅科技', code: 'JINGGUI', kind: 'tech', sector: 'smelt', link: 'silicon_met',
        business: '工业硅提纯', basePrice: 240, volatility: 1.15, minFactor: 0.32, maxFactor: 3.05, depth: 3.6e8, periodYears: 1,
        desc: '光伏与芯片的共同上游。两头景气它最风光，两头萧条它最先倒。' },
      // ================= 科技 · 化工（4）=================
      { id: 'sansuan', name: '三酸化建', code: 'SANSUAN', kind: 'tech', sector: 'chem', link: 'sulfuric',
        business: '硫酸与基础化工', basePrice: 70, volatility: 0.92, minFactor: 0.39, maxFactor: 2.45, depth: 1.5e9, periodYears: 1,
        desc: '化工里的自来水厂。哪里都要，哪里都不值钱 —— 胜在稳定。' },
      { id: 'dangu', name: '氮谷化工', code: 'DANGU', kind: 'tech', sector: 'chem', link: 'ammonia',
        business: '合成氨与氮肥', basePrice: 110, volatility: 0.95, minFactor: 0.38, maxFactor: 2.50, depth: 9.0e8, periodYears: 1,
        desc: '养活一半人口的产业。需求刚性，价格也就没什么想象力。' },
      { id: 'teqi', name: '特气先锋', code: 'TEQI', kind: 'tech', sector: 'chem', link: 'spec_gas',
        business: '特种气体', basePrice: 320, volatility: 1.12, minFactor: 0.33, maxFactor: 2.95, depth: 3.0e8, periodYears: 1,
        desc: '纯度写进小数点后六位。客户一旦认证就不换供应商，也不还价。' },
      { id: 'guangke', name: '光刻材料', code: 'GUANGKE', kind: 'tech', sector: 'chem', link: 'photoresist',
        business: '光刻胶与电子化学品', basePrice: 620, volatility: 1.30, minFactor: 0.28, maxFactor: 3.55, depth: 1.6e8, periodYears: 1,
        desc: '卡脖子的那瓶液体。国产替代的故事讲了很多年，每次都能涨一轮。' },
      // ================= 科技 · 精密制造（5）=================
      { id: 'jinggong', name: '精工轴承', code: 'JINGGONG', kind: 'tech', sector: 'precision', link: 'bearing',
        business: '高精度轴承', basePrice: 380, volatility: 0.90, minFactor: 0.40, maxFactor: 2.40, depth: 2.6e8, periodYears: 1,
        desc: '所有转动的东西都要它。寿命按万小时算，口碑按十年攒。' },
      { id: 'wanxiang', name: '万象传动', code: 'WANXIANG', kind: 'tech', sector: 'precision', link: 'gearbox',
        business: '齿轮组与传动系统', basePrice: 520, volatility: 0.92, minFactor: 0.40, maxFactor: 2.42, depth: 2.0e8, periodYears: 1,
        desc: '把转速变成扭矩的生意。机床、风电、机器人，处处有它的齿轮。' },
      { id: 'hengyue', name: '恒岳重工', code: 'HENGYUE', kind: 'tech', sector: 'precision', link: 'hydraulic',
        business: '液压件与重型装备', basePrice: 700, volatility: 0.94, minFactor: 0.39, maxFactor: 2.45, depth: 1.5e8, periodYears: 1,
        desc: '挖掘机的大臂、水轮机的闸门。订单跟着基建周期大起大落。' },
      { id: 'tiangong', name: '天工模具', code: 'TIANGONG', kind: 'tech', sector: 'precision', link: 'mold',
        business: '精密模具', basePrice: 900, volatility: 0.95, minFactor: 0.39, maxFactor: 2.48, depth: 1.2e8, periodYears: 1,
        desc: '一套模具定一款产品的命。做得准就能吃十年，做不准就是废铁。' },
      { id: 'mingjing', name: '明镜光学', code: 'MINGJING', kind: 'tech', sector: 'precision', link: 'optics',
        business: '光学镜片与镜头组', basePrice: 1500, volatility: 1.08, minFactor: 0.35, maxFactor: 2.80, depth: 6.5e7, periodYears: 1,
        desc: '镜头里的玻璃比金贵。镀膜配方是它唯一不写在说明书上的东西。' },
      // ================= 科技 · 电子（6）=================
      { id: 'yuanjian', name: '元件世家', code: 'YUANJIAN', kind: 'tech', sector: 'electron', link: 'component',
        business: '被动元件与连接器', basePrice: 1200, volatility: 1.05, minFactor: 0.36, maxFactor: 2.75, depth: 8.5e7, periodYears: 1,
        desc: '一颗几分钱，缺货时整条产线停摆。周期来了涨十倍，走了跌回原地。' },
      { id: 'gonglv', name: '功率半导体', code: 'GONGLV', kind: 'tech', sector: 'electron', link: 'power_dev',
        business: '功率器件', basePrice: 2100, volatility: 1.10, minFactor: 0.34, maxFactor: 2.85, depth: 4.8e7, periodYears: 1,
        desc: '电车与电网的心脏。不追先进制程，靠可靠性吃一辈子。' },
      { id: 'ganxin', name: '感芯科技', code: 'GANXIN', kind: 'tech', sector: 'electron', link: 'sensor',
        business: '传感器', basePrice: 3200, volatility: 1.15, minFactor: 0.33, maxFactor: 2.95, depth: 3.2e7, periodYears: 1,
        desc: '给机器装五官。出货量跟着终端走，毛利率跟着竞争格局走。' },
      { id: 'cunchu', name: '存储纪元', code: 'CUNCHU', kind: 'tech', sector: 'electron', link: 'memory_die',
        business: '存储颗粒', basePrice: 3000, volatility: 1.28, minFactor: 0.29, maxFactor: 3.40, depth: 3.4e7, periodYears: 1,
        desc: '标准的周期股。三年不开张，开张吃三年，散户在这上面亏得最惨。' },
      { id: 'guanglian', name: '光联通信', code: 'GUANGLIAN', kind: 'tech', sector: 'electron', link: 'optical_mod',
        business: '光模块', basePrice: 4500, volatility: 1.20, minFactor: 0.31, maxFactor: 3.20, depth: 2.3e7, periodYears: 1,
        desc: '算力集群的血管。数据中心一扩建，它的订单就排到明年。' },
      { id: 'chipsci', name: '算力芯科', code: 'CHIPSCI', kind: 'tech', sector: 'electron', link: 'chip',
        business: '半导体芯片设计与代工', basePrice: 5200, volatility: 1.25, minFactor: 0.30, maxFactor: 3.30, depth: 2.0e7, periodYears: 1,
        desc: '给整机厂供芯的老牌大厂。芯片行情好它就涨，行情差它就跌 —— 很诚实。' },
      // ================= 科技 · 整机装配（6）=================
      { id: 'xuanji', name: '玄机数术', code: 'XUANJI', kind: 'tech', sector: 'assembly', link: 'server',
        business: '服务器整机与算力集群', basePrice: 8000, volatility: 1.00, minFactor: 0.38, maxFactor: 2.60, depth: 1.3e7, periodYears: 1,
        desc: '整机与算力集群的承包商。订单跟着服务器行情走，账期跟着甲方走。' },
      { id: 'jixie', name: '机械纪元', code: 'JIXIE', kind: 'tech', sector: 'assembly', link: 'robot',
        business: '工业机器人', basePrice: 12000, volatility: 1.05, minFactor: 0.36, maxFactor: 2.70, depth: 8.5e6, periodYears: 1,
        desc: '替代人工的那批铁臂。人力越贵它越好卖，需求很朴素。' },
      { id: 'jiqun', name: '集群时代', code: 'JIQUN', kind: 'tech', sector: 'assembly', link: 'cabinet',
        business: '算力集群集成', basePrice: 15000, volatility: 1.08, minFactor: 0.35, maxFactor: 2.78, depth: 7.0e6, periodYears: 1,
        desc: '把机柜、供电、液冷打包交付。真正的门槛是交付速度，不是技术。' },
      { id: 'ruifeng', name: '锐锋机床', code: 'RUIFENG', kind: 'tech', sector: 'assembly', link: 'cnc',
        business: '精密数控机床', basePrice: 22000, volatility: 1.02, minFactor: 0.37, maxFactor: 2.62, depth: 4.6e6, periodYears: 1,
        desc: '工业母机。所有精密件的精度，最终都由它的丝杠决定。' },
      { id: 'yinghe', name: '影和医疗', code: 'YINGHE', kind: 'tech', sector: 'assembly', link: 'imaging',
        business: '医学影像设备', basePrice: 28000, volatility: 0.98, minFactor: 0.38, maxFactor: 2.55, depth: 3.6e6, periodYears: 1,
        desc: 'CT 与核磁。招标周期长、回款慢，但一旦中标就是十年服务。' },
      { id: 'xingcha', name: '星槎航天', code: 'XINGCHA', kind: 'tech', sector: 'assembly', link: 'sat_bus',
        business: '卫星平台与载荷', basePrice: 42000, volatility: 1.22, minFactor: 0.30, maxFactor: 3.25, depth: 2.5e6, periodYears: 1,
        desc: '把东西送上天，还要它回来。一次失利，股价腰斩；一次成功，翻倍。' },
      // ================= 科技 · 独立行情（1）=================
      { id: 'tianji', name: '天机阁', code: 'TIANJI', kind: 'tech', sector: null, link: null,
        business: '推演与咨询（无从核实）', basePrice: 60, volatility: 1.45, minFactor: 0.24, maxFactor: 4.20, depth: 1.8e9, periodYears: 1,
        desc: '坊间传它算得出天机。既算不出自己的现金流，也算不出下个月还在不在。' },
      // ================= 修仙 · 灵植（4）=================
      { id: 'qinghe', name: '青禾灵田', code: 'QINGHE', kind: 'xiuxian', sector: 'herb', link: 'spirit_grain',
        business: '灵谷种植与仓储', basePrice: 260, volatility: 0.80, minFactor: 0.44, maxFactor: 2.20, depth: 4.0e8, periodYears: 1,
        desc: '修仙界的口粮供应商。谁都要吃饭，所以谁也不敢让它倒。' },
      { id: 'yunma', name: '云麻堂', code: 'YUNMA', kind: 'xiuxian', sector: 'herb', link: 'spirit_hemp',
        business: '灵麻与纤维作物', basePrice: 380, volatility: 0.82, minFactor: 0.43, maxFactor: 2.22, depth: 2.7e8, periodYears: 1,
        desc: '符纸与法袍都从它这里起。制符业景气，它的地里就全是订单。' },
      { id: 'yuehua', name: '月华药圃', code: 'YUEHUA', kind: 'xiuxian', sector: 'herb', link: 'moon_herb',
        business: '月华草等灵草栽培', basePrice: 650, volatility: 0.85, minFactor: 0.42, maxFactor: 2.28, depth: 1.6e8, periodYears: 1,
        desc: '丹房的头号供应商。灵草一歉收，下游丹价立刻跳。' },
      { id: 'xuanbing', name: '玄冰谷', code: 'XUANBING', kind: 'xiuxian', sector: 'herb', link: 'frost_lotus',
        business: '玄冰花等寒性灵植', basePrice: 980, volatility: 0.90, minFactor: 0.41, maxFactor: 2.35, depth: 1.05e8, periodYears: 1,
        desc: '谷里终年不化雪。寒性灵材九成出自此处，也就九成的定价权。' },
      // ================= 修仙 · 炼丹（4）=================
      { id: 'cuiti', name: '淬体堂', code: 'CUITI', kind: 'xiuxian', sector: 'alchemy', link: 'body_pill',
        business: '淬体丹批量炼制', basePrice: 900, volatility: 0.75, minFactor: 0.46, maxFactor: 2.12, depth: 1.15e8, periodYears: 1,
        desc: '最低端的丹，也是销量最大的丹。薄利多销，靠自动化产线活。' },
      { id: 'danxia', name: '丹霞生物', code: 'DANXIA', kind: 'xiuxian', sector: 'alchemy', link: 'heal_pill',
        business: '疗伤丹与常备丹药', basePrice: 1800, volatility: 0.78, minFactor: 0.45, maxFactor: 2.18, depth: 5.8e7, periodYears: 1,
        desc: '把炼丹做成工艺的医药巨头。一粒丹的毛利率，够养活整条产业链。' },
      { id: 'xisui', name: '洗髓宗', code: 'XISUI', kind: 'xiuxian', sector: 'alchemy', link: 'marrow_pill',
        business: '洗髓丹与体质改造', basePrice: 3200, volatility: 0.82, minFactor: 0.44, maxFactor: 2.25, depth: 3.2e7, periodYears: 1,
        desc: '改资质的丹，卖的是希望。涨价不需要理由，跌价只需要一次事故。' },
      { id: 'jindan', name: '金丹阁', code: 'JINDAN', kind: 'xiuxian', sector: 'alchemy', link: 'golden_pill',
        business: '九转金丹等高端丹药', basePrice: 6800, volatility: 0.95, minFactor: 0.40, maxFactor: 2.45, depth: 1.5e7, periodYears: 1,
        desc: '一丹难求。产量以「炉」计，客户以「宗门」计，价格从不明码。' },
      // ================= 修仙 · 制符（3）=================
      { id: 'qingfeng', name: '清风符社', code: 'QINGFENG', kind: 'xiuxian', sector: 'talisman', link: 'wind_talis',
        business: '清风符等日用符箓', basePrice: 750, volatility: 0.76, minFactor: 0.46, maxFactor: 2.14, depth: 1.4e8, periodYears: 1,
        desc: '日用符里的日用品。赚的是复购，不是溢价。' },
      { id: 'leifu', name: '雷符门', code: 'LEIFU', kind: 'xiuxian', sector: 'talisman', link: 'thunder_tal',
        business: '雷符与攻伐符箓', basePrice: 4500, volatility: 0.88, minFactor: 0.42, maxFactor: 2.32, depth: 2.3e7, periodYears: 1,
        desc: '斗法用的消耗品。宗门摩擦一多，它的库存就见底。' },
      { id: 'tiandun', name: '天遁符宗', code: 'TIANDUN', kind: 'xiuxian', sector: 'talisman', link: 'teleport_tal',
        business: '传送符与空间符阵', basePrice: 8000, volatility: 0.96, minFactor: 0.40, maxFactor: 2.48, depth: 1.3e7, periodYears: 1,
        desc: '空间一道，自古独门。会做的人少，敢买的人多。' },
      // ================= 修仙 · 炼器（4）=================
      { id: 'cangfeng', name: '藏锋阁', code: 'CANGFENG', kind: 'xiuxian', sector: 'refine', link: 'magic_sword',
        business: '法剑锻制', basePrice: 2600, volatility: 0.85, minFactor: 0.43, maxFactor: 2.28, depth: 4.0e7, periodYears: 1,
        desc: '一名剑修一把剑，藏锋阁供了三成。剑修越多，它越稳。' },
      { id: 'xuanjia', name: '玄甲宗', code: 'XUANJIA', kind: 'xiuxian', sector: 'refine', link: 'armor',
        business: '护甲与防具', basePrice: 5200, volatility: 0.88, minFactor: 0.42, maxFactor: 2.32, depth: 2.0e7, periodYears: 1,
        desc: '护具这门生意，跟着「谁在打仗」走。和平年代它就卖农具。' },
      { id: 'feizhou', name: '飞舟坊', code: 'FEIZHOU', kind: 'xiuxian', sector: 'refine', link: 'flying_boat',
        business: '飞舟与载具', basePrice: 12000, volatility: 0.92, minFactor: 0.41, maxFactor: 2.38, depth: 8.6e6, periodYears: 1,
        desc: '从货运到远游都靠它。灵脉航线开到哪里，它的订单就到哪。' },
      { id: 'benming', name: '本命斋', code: 'BENMING', kind: 'xiuxian', sector: 'refine', link: 'core_treasure',
        business: '本命法宝温养', basePrice: 35000, volatility: 1.05, minFactor: 0.37, maxFactor: 2.70, depth: 3.0e6, periodYears: 1,
        desc: '一人一件，温养百年。客户终身只来一次，客单价高得离谱。' },
      // ================= 修仙 · 阵盘（3）=================
      { id: 'panshi', name: '磐石阵门', code: 'PANSHI', kind: 'xiuxian', sector: 'array', link: 'ward_array',
        business: '防护阵盘', basePrice: 6500, volatility: 0.88, minFactor: 0.42, maxFactor: 2.30, depth: 1.6e7, periodYears: 1,
        desc: '护山大阵的承办方。宗门只要还在，它的维护合同就续。' },
      { id: 'huanzhen', name: '幻阵阁', code: 'HUANZHEN', kind: 'xiuxian', sector: 'array', link: 'illusion_arr',
        business: '幻阵与迷阵', basePrice: 18000, volatility: 0.95, minFactor: 0.40, maxFactor: 2.45, depth: 5.8e6, periodYears: 1,
        desc: '卖的是「看不穿」。秘境一开，它的阵盘就脱销。' },
      { id: 'zhoutian', name: '周天阵宗', code: 'ZHOUTIAN', kind: 'xiuxian', sector: 'array', link: 'star_array',
        business: '周天星斗大阵', basePrice: 60000, volatility: 1.10, minFactor: 0.36, maxFactor: 2.85, depth: 1.75e6, periodYears: 1,
        desc: '一套阵护一宗千年。做不了假的生意，也就没有价格战。' },
      // ================= 修仙 · 洞天（2）=================
      { id: 'lingmai', name: '灵脉能源', code: 'LINGMAI', kind: 'xiuxian', sector: 'cave', link: 'leyline_node',
        business: '灵脉节点与供能', basePrice: 90000, volatility: 0.98, minFactor: 0.39, maxFactor: 2.55, depth: 1.2e6, periodYears: 1,
        desc: '握着灵脉的能源寡头。阵盘卖得越好，它的电价越硬 —— 直到有人找到第二条灵脉。' },
      { id: 'taixu', name: '太虚洞天', code: 'TAIXU', kind: 'xiuxian', sector: 'cave', link: 'cave_heaven',
        business: '洞天开凿与小世界营造', basePrice: 200000, volatility: 1.15, minFactor: 0.34, maxFactor: 3.00, depth: 5.4e5, periodYears: 1,
        desc: '卖天地的公司。每开出一方洞天，就多一处可以收租的世界。' },
    ],
  },

  /** 离线收益 */
  offline: {
    /** 基础系数 */
    ratio: 0.3,
    /** 最大离线时长（小时） */
    maxHours: 48,
    /**
     * 离线判定阈值（秒）。
     * 低于此值视为「短暂离开」（刷新页面、切标签页），按 100% 全额结算，
     * 避免玩家频繁刷新被反复打折。
     */
    thresholdSeconds: 60,
    /**
     * 离线时工作是否继续自动执行（消耗精力 + 产出）。
     * 开启后离线收益受精力上限约束，不会无限膨胀。
     */
    workWhileOffline: true,
    /** 离线时是否继续修炼功法（涨熟练度） */
    cultivateWhileOffline: true,
    /**
     * 离线时公司是否继续生产。
     * 与工作同理：离线生产同样受「维护费」约束（钱不够就停产），
     * 而且按离线效率折算，所以不会比在线更赚。
     */
    companyWhileOffline: true,
  },

  /** 存档 */
  save: {
    /** 自动保存间隔（毫秒） */
    intervalMs: 15000,
    /**
     * 单次结算的最大时间跨度（秒），防止时钟作弊。
     *
     * 必须 >= 离线封顶时长，否则离线结算会被静默截断 ——
     * 之前这里是 3600，导致离线 48 小时实际只结算了 1 小时。
     * tick 内部会按 60 秒一段切分推进保证精度。
     */
    maxTickSeconds: 48 * 3600,
  },

  /** 界面刷新间隔（毫秒） */
  ui: {
    tickMs: 100,
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = GAME;
if (typeof window !== 'undefined') window.GAME = GAME;
