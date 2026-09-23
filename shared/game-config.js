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
     * 时间档位 —— 玩家用顶栏的四个小按钮切换（只能切到已解锁的档位）。
     * gameSecondsPerRealSecond：1 现实秒对应多少游戏秒。
     * unlockRealm：达到该境界后解锁此档位。
     *
     * 档 2（1 秒 = 1 小时）是「常速」，从凡人就可用的基线；
     * 档 1 是减速档，档 3/4/5 是加速档。
     * 档 5（1 秒 = 1 游戏年）刻意压到化神（id 5）才解锁 —— **超出元婴之后**
     * 才给最高速，正好卡在主动兵解开放之后：终局循环里反复重爬，
     * 没有这一档每世都要再等一遍同样的挂机时间。
     */
    tiers: [
      { tier: 1, name: '缓', label: '1 秒 = 10 分钟', gameSecondsPerRealSecond: 600,     unlockRealm: 0 },
      { tier: 2, name: '常', label: '1 秒 = 1 小时',  gameSecondsPerRealSecond: 3600,    unlockRealm: 0 },
      { tier: 3, name: '疾', label: '1 秒 = 1 游戏天', gameSecondsPerRealSecond: 86400,   unlockRealm: 2 },
      { tier: 4, name: '倏', label: '1 秒 = 1 游戏月', gameSecondsPerRealSecond: 2592000, unlockRealm: 3 },
      { tier: 5, name: '瞬', label: '1 秒 = 1 游戏年', gameSecondsPerRealSecond: 31536000, unlockRealm: 5 },
    ],

    /** 起始档位（减速档，让凡人期的每一步都可感知） */
    defaultTier: 1,

    /** 常速档位 —— 顶栏播放按钮对应的档位 */
    normalTier: 2,
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
    /**
     * 基准恢复速度（点 / 现实秒）—— 只对凡人生效。
     * 炼气起按 realms[].regen 逐境抬升（见 realms 注释），本字段只是兜底默认值。
     */
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
   *   a) 放大实际算力的效果 —— 见下方阻尼说明
   *   b) 加快功法修炼速度（功法修炼速度就是灵气提升速度）
   *
   * ============================================================
   * 阻尼：神识对乘区的加成必须「分层」，不能整体次线性
   * ============================================================
   * 神识 = 境界基础值 × 设备倍率，这两个来源的性质完全不同：
   *   - 境界那一份：随境界线性增长，也是「道行加成 · 神识根基」的载体。
   *     必须保持线性、可感知 —— 否则玩家花道行买的永久加成会被一起压扁，
   *     回报说不清，转生就失去意义。
   *   - 设备那一份：玩家可以无限堆，且 shenshiBonus 从 0.5 一路跃升至 120，
   *     是数值爆炸的唯一来源，必须次线性。
   *
   * 所以把两者拆开：**境界保持线性，设备改走对数收敛**。
   *
   *     有效强度 = 境界神识 × computePerPointRealm × f(设备倍率)
   *     f(m)     = 1 + computeDeviceLogK × ln(m)            // m ≥ 1
   *     实际算力 = (设备算力 × 转生折扣 + AI 加成) × (1 + 有效强度) × (1 + 功法被动算力)
   *
   * f(m) 的形状保证三件事：
   *   a) **无设备时 f(1) = 1** —— 与旧口径完全一致，前期手感一点不变；
   *   b) 设备越多放大越猛，但按**对数**收敛 —— 后期不爆炸；
   *   c) 境界基础神识仍是线性因子 —— 道行加成买来的永久提升不会被稀释。
   *
   * 为什么是「境界 × f(设备)」的乘法、而不是两者相加：
   *   相加会让「低境界 + 大量设备」时设备那一份脱离境界约束，反而比线性口径更强。
   *   乘法保留了原设计「神识 = 境界基础 × 设备倍率」的语义，只把设备那一项换成收敛函数。
   *
   * 实测（元婴 + 设备神识倍率 429）：旧线性口径给出 ×859 的算力乘区，
   * 本公式给出 ×64（降 13 倍）；而设备倍率 2（一台灵石供电机柜）时
   * 两者分别是 ×1.16 与 ×1.36 —— 阻尼只削后期、几乎不动前期。
   */
  shenshi: {
    /** 境界那一份：每点神识对「实际算力」的增幅（线性） */
    computePerPointRealm: 0.02,
    /**
     * 设备那一份的收敛系数 k：f(m) = 1 + k × ln(m)。
     * 调大 = 后期更强；调小 = 后期更收敛。k = 0 会退化成「设备完全无效」。
     */
    computeDeviceLogK: 5,
    /** 境界那一份：每点神识对「功法修炼速度」的增幅（线性） */
    cultivatePerPointRealm: 0.02,
    /** 设备那一份：修炼速度的收敛系数 */
    cultivateDeviceLogK: 5,
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
    /**
     * 第一个产出**灵石**的岗位。
     *
     * 为什么它必须存在、而且必须排在最前面：
     * 第一台需要灵石的设备是「灵石供电机柜」（5e10 金钱 + 2e3 灵石）。
     * 早先灵石只能从「灵矿勘探开采工程」拿，而那一份又要求先刷满 20 次 CEO ——
     * 玩家经常先攒够 5e10 金钱，却因为升职链没走完而**一颗灵石都拿不到**，
     * 整条设备线卡死。现在拆成两步：先有这一份低门槛的灵石来源，
     * 兑换 2e3 灵石约需 40 分钟（精力上限 250，单次 200 颗），
     * 与「5e10 金钱大约在同一阶段到手」的节奏对齐。
     */
    {
      id: 'orelab', name: '灵材成分分析', real: '材料检测 × 修仙', tier: 4,
      hours: 21600, energy: 250, money: 2.2e8, spirit: 1.0e4, stone: 200,
      desc: '给矿企做灵材检测，从尾矿里回收零散的灵石碎屑。量不大，但这是第一条灵石来源。',
      unlock: { realm: 4, after: { id: 'ceo', times: 12 } },
    },
    {
      id: 'spiritmine', name: '灵矿勘探开采工程', real: '资源开发 × 修仙', tier: 4,
      hours: 25920, energy: 300, money: 4.5e8, spirit: 2.0e4, stone: 500,
      desc: '用地质雷达找灵脉，再用重机把它挖出来。挖出的碎屑就是灵石。',
      unlock: { realm: 4, after: { id: 'orelab', times: 12 } },
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

    // ---------- 化神期：以界为工 ----------
    /**
     * 化神以后的工作。**没有这两份，新境界就是空壳** —— 境界抬高了、
     * 灵气阈值 ×100 了，钱和灵石的来源却停在元婴档，玩家只能靠旧工作硬磨。
     * 单调性约束（耗时/精力/时薪/精力效率逐级递增）照旧，数值按 ×2.2 ~ ×4.6 抬。
     */
    {
      id: 'zhoutian', name: '周天星斗大阵工程', real: '阵法基建 × 修仙', tier: 5,
      hours: 172800, energy: 620, money: 6.0e10, spirit: 4.0e6, stone: 6.0e5,
      desc: '把一整片星域编进阵图。工期以甲子计，结项那天星辰会为你让路。',
      unlock: { realm: 5, after: { id: 'spiritnet', times: 20 } },
    },
    {
      id: 'dongtian', name: '洞天群落营造', real: '世界营造 × 修仙', tier: 5,
      hours: 345600, energy: 720, money: 3.0e11, spirit: 2.0e7, stone: 4.0e6,
      desc: '一次开凿十三方洞天，再以灵脉把它们串成一片。你卖的不再是地，是疆域。',
      unlock: { realm: 6, after: { id: 'zhoutian', times: 24 } },
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
    {
      // 化神（id 5）档。算力 ×100 / 档的节奏与境界阈值（×100 / 境）对齐，
      // 否则新境界只能靠干等灵气 —— 等价于「加了境界但没加内容」。
      id: 'guixu', name: '归墟演算阵列', cost: 5e20, stoneCost: 5e10, costGrowth: 1.30,
      compute: 5e18, incomeBonus: 1600, shenshiBonus: 400, stonePerSecond: 1e6,
      desc: '把整片归墟之水当冷却液。涌动的是万物归返之力，顺便带走热量。',
    },
    {
      // 炼虚（id 6）档。
      id: 'taichu', name: '太初推理核心', cost: 5e22, stoneCost: 2e12, costGrowth: 1.32,
      compute: 5e20, incomeBonus: 5000, shenshiBonus: 1500, stonePerSecond: 1.2e7,
      desc: '在天地未分之处跑第一行推理。它算完的时候，因果才刚刚开始。',
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
   * ------------------------------------------------------------
   * 产出公式与单位（改数值前务必先读这一节）
   * ------------------------------------------------------------
   *     产出 = (实际算力 × 本项份额) ^ decay × rate
   *
   * 注意这个「产出」不是资源，而是**各方向自己的量纲**：
   *   修仙 → 灵气/现实秒（还要再乘 qiMultiplier 才是最终入账的灵气）
   *   AI   → 「算力增量」的中间量，乘 aiToCompute 之后才落到 aiBonus（算力/秒）
   *   金融 → 金钱/现实秒
   *   硬件 → 折扣曲线上的一个点（1/(1+产出)），不是资源
   *   功法 → 灵气倍率的加项（不是每秒资源）
   *   工业 → 工业算力池
   * 前端显示务必用 core.investOutputRate()（已换算成上表右边的单位），
   * 直接显示 investOutput 会让人误以为「修仙方向每秒只给几十点灵气」。
   *
   * ------------------------------------------------------------
   * 为什么修仙方向的 rate 是 0.25 而不是更小的数
   * ------------------------------------------------------------
   * 它是主线唯一的灵气来源，必须和境界阈值处在**同一个可读量级**。
   * 早先 rate = 0.01 时，筑基期（阈值 5e6）拉满也只显示二十几点/秒，
   * 静态比（阈值 ÷ 速度）高达几十万秒，玩家看到的是一个几乎不动的进度条。
   * 现在抬高到 0.25（×25），同时把「灵气/秒」按真正的入账口径显示出来
   * （含 qiMultiplier 与功法倍率），数字才和实际体感对得上。
   *
   * 若想整体拖慢/加快主线，**优先调这里和 realms[].need**，一次只动一个：
   * 两者同调等于没调（比值不变），投向调大而阈值不动则主线会明显变快。
   *
   * locked: true 的项在习得功法 / 成立公司之前不可分配，也不会参与归一化。
   */
  investments: [
    {
      id: 'xiuxian',
      name: '修仙方向',
      desc: '以算力优化吐纳，是灵气（境界）的唯一来源。',
      period: '主线，决定境界上限',
      rate: 0.25,
      decay: 0.75,
      /** 前端显示单位：每现实秒入账的灵气（已含灵气倍率） */
      unit: 'qi',
    },
    {
      id: 'ai',
      name: 'AI 领域',
      desc: '让算力自我增殖，直接提升算力总量。',
      period: '中线，放大所有路线',
      rate: 0.35,
      /**
       * AI 的衰减指数与修仙方向一致（0.75）。
       * 两个方向的算力投入理应「同样划算」，差别只在**换算成什么**：
       * 修仙直接换灵气，AI 换算力再间接换一切。早先 AI 用 0.70、修仙用 0.75，
       * 结果算力越堆越厚时 AI 反而先掉队，与「中线放大所有路线」的定位相反。
       */
      decay: 0.75,
      /**
       * AI 产出 → 算力的换算系数。
       *
       * 实际算力增量/秒 = (算力 × 份额)^0.75 × rate × aiToCompute
       *
       * 取值目标是「相对增幅」而不是绝对值。v3.5 从 0.006 提到 0.012：
       * 实测算力成长太慢，玩家卡在「买不起下一台设备」的档口 —— 翻倍 AI
       * 转化是最直接的松绑，且它 ∝ 算力^0.75，早期受益最大、后期不失控。
       */
      aiToCompute: 0.012,
      /** 前端显示单位：每现实秒增加的算力 */
      unit: 'compute',
    },
    {
      id: 'hardware',
      name: '计算设备领域',
      desc: '持续积累设备议价经验，永久压低所有设备的造价。',
      period: '中线，反哺科技线（优惠永久保留）',
      rate: 0.04,
      decay: 0.65,
      /**
       * v3.5 累积折扣：本方向的产出**不再即时生效**，而是累积进
       * `s.investedHardware`，永久压低设备造价 —— 哪怕之后把进度条拉没，
       * 已累积的优惠也保持住，只是不再增长。
       *
       * 单台设备的折扣比例 = maxRed × X / (X + 该设备现价 × dilution)
       *   X = 累积值；X = 设备现价 × dilution 时折扣恰为 maxRed 的一半；
       *   X → ∞ 时折扣趋近 maxRed（软上限，**永远不会免费**）；
       *   设备越贵同样 X 折扣越小（跟随设备价格稀释）。
       */
      accum: {
        maxRed: 0.6,     // 造价最低降到原价的 40%
        dilution: 0.5,   // 稀释权重：X = 现价×0.5 时打对折（-30%）
      },
      /** 前端显示单位：累积折扣（显示当前优惠与累积速度） */
      unit: 'discount',
    },
    {
      id: 'finance',
      name: '金融行业',
      desc: '用算力直接变现，换取购买设备的本金。',
      period: '短线，即时变现',
      rate: 0.5,
      decay: 0.70,
      /** 前端显示单位：每现实秒入账的金钱 */
      unit: 'money',
    },
    {
      id: 'technique',
      name: '功法算力投入',
      desc: '把算力灌入当前修炼的功法，持续转化为功法经验（只喂当前这一本）。',
      period: '需先习得功法',
      /** 未习得功法时锁定：前端置灰不可拖，产出恒为 0 */
      locked: true,
      /** 产出不再进灵气倍率，而是按 expPerInvest 换算成功法经验/秒（v3.5） */
      rate: 0.3,
      decay: 0.55,
      /** 前端显示单位：功法经验/秒 */
      unit: 'techexp',
      /** 锁定原因文案（前端直接显示） */
      lockReason: '未习得功法',
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
      /** 前端显示单位：工业算力池 */
      unit: 'industrial',
      /** 锁定原因文案（前端直接显示，避免把「未成立公司」写成「未习得功法」） */
      lockReason: '未成立公司',
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

    /**
     * 熟练度段位对**主属性**的加成。
     *
     *     主属性 = 稀有度基值 ×(1 + 功法等级 × mainPerLevel) × 熟练系数
     *     熟练系数 = masteryMainBase + masteryMainPerTier × 段位序号
     *
     * 没有这一层的话，段位只决定「被动是否常驻」，而被动要修满（圆满）才拿得到 ——
     * 前四个段位除了一行文字什么都没给，修炼在拿到达成前毫无正反馈。
     * 现在每升一段主属性 +10%：入门 0.5 → 圆满 1.0，满熟练度时功法全属性最强。
     * 刻意从 0.5 起步而不是 0：刚习得就能用，只是「没练熟」。
     */
    masteryMain: { base: 0.5, perTier: 0.1 },

    /** 修炼：挂机积累熟练度 */
    cultivate: {
      /** 基础速度（熟练度 / 现实秒） */
      pointsPerSecond: 1,
      /**
       * 修炼速度 = 基础速度 ×(1 + 神识的有效强度)。
       * 「神识的有效强度」与算力乘区共用同一套分层口径（境界线性 / 设备对数），
       * 系数取 GAME.shenshi.cultivatePerPointRealm 与 cultivateDeviceLogK，
       * 不在这里重复配置 —— 否则两处系数会漂移。
       * 修炼速度就是灵气提升速度。
       */
    },

    /** 参悟：消耗灵气，立即获得熟练度（相当于熟练度的「催工」） */
    comprehend: {
      /** 消耗 = 当前境界突破所需灵气 × 该比例 */
      qiCostRatio: 0.02,
      /** 每次获得「当前段位增量」的该比例（0.25 = 4 次参悟升一段） */
      gainRatio: 0.25,
    },

    /**
     * 功法等级（v3.5 重做）：**每本功法独立经验/等级**，无上限。
     *
     *   经验速率 = expPerLog10 × log10(1 + 实际算力)              ← 挂机基础
     *            + expPerInvest × 功法算力投向的产出              ← 投向加成
     *   升级需求 = expBase × expGrowth^当前等级
     *
     * 经验**只喂给当前修炼的那一本**（切换功法即换目标），等级各自独立、
     * 永久保留（跨兵解不清 —— 兵解清的是熟练度进度，不清等级）。
     * 算力越高经验越快，所以兵解后重新推境界的速度会随「设备恢复速度」一起回来，
     * 转生循环的爬坡期不至于太痛。
     */
    level: {
      /** 每级提升主属性的比例 */
      mainPerLevel: 0.08,
      /** 升到下一级需要的经验 = expBase × expGrowth^当前等级 */
      expBase: 30,
      expGrowth: 1.35,
      /** 挂机经验速率 = expPerLog10 × log10(1 + 实际算力) / 秒 */
      expPerLog10: 1,
      /** 功法算力投向：每点投向产出换 expRate 的系数 */
      expPerInvest: 1,
    },

    /**
     * 稀有度 —— 8 级，取「天地玄黄，宇宙洪荒」全八字。
     *
     * ⚠️ 排列方向：**「天」最稀有，「荒」最普遍** —— 按「天地玄黄宇宙洪荒」的
     * 书写顺序，越靠前越稀有、越靠后越常见。`level` 是强度序号（越大越强），
     * 所以数组按 level **升序**写：荒(1) → 洪(2) → 宙(3) → 宇(4) → 黄(5) → 玄(6) → 地(7) → 天(8)。
     *
     * 稀有度**无法提升**，越高主属性基值越强；基值按 ~×3 / 级指数拉开，
     * 与「数学越深奥的功法越难修」对应（见功法表的排序）。
     * id 直接用汉字 —— 稀有度只存在于配置里、不进存档（存档只记功法 id），改名零迁移成本。
     */
    rarities: [
      { id: '荒', name: '荒', level: 1, mainQiSpeed: 0.10 },
      { id: '洪', name: '洪', level: 2, mainQiSpeed: 0.30 },
      { id: '宙', name: '宙', level: 3, mainQiSpeed: 0.90 },
      { id: '宇', name: '宇', level: 4, mainQiSpeed: 2.7 },
      { id: '黄', name: '黄', level: 5, mainQiSpeed: 8 },
      { id: '玄', name: '玄', level: 6, mainQiSpeed: 24 },
      { id: '地', name: '地', level: 7, mainQiSpeed: 72 },
      { id: '天', name: '天', level: 8, mainQiSpeed: 216 },
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
    /**
     * 功法表 —— **按数学深奥程度升序排列**，稀有度跟着走：
     * 越往下数学越深、稀有度越高、解锁境界与算力门槛也越高。
     * 新增功法时插进对应深度位置即可，别堆在表尾 ——
     * 「天字号功法却只讲四则运算」是这一版的明确红线。
     */
    list: [
      // ============ 荒（最普遍）· 数学深度：算术与记数 ============
      {
        id: 'jiuzhang', name: '九章算经·残卷', rarity: '荒',
        school: '算术', realm: 0, compute: 0,
        passive: { money: 0.05 },
        desc: '从竹简残页里拼出的四则运算。看似粗浅，却是万法之基。',
      },
      {
        id: 'chousuan', name: '筹算小术', rarity: '荒',
        school: '记数与进位', cond: { jobsDone: 3 },
        passive: { energyMax: 0.05 },
        desc: '一把小棍摆出千军万马。进位一落，天地便有了次序。',
      },
      {
        id: 'huanfang', name: '幻方引', rarity: '荒',
        school: '幻方与填数', cond: { devicesOwned: 2 },
        passive: { money: 0.08 },
        desc: '三三斜对，纵横皆十五。数在格中自行 balancing，是为幻方。',
      },
      {
        id: 'gougu', name: '勾股心诀', rarity: '荒',
        school: '勾股定理', cond: { compute: 5e3 },
        passive: { compute: 0.05 },
        desc: '勾三股四弦必五。直角之中藏着第一道必然，不证自明。',
      },
      {
        id: 'jitu', name: '鸡兔同笼术', rarity: '荒',
        school: '不定方程初步', cond: { marketProfit: true },
        passive: { money: 0.10 },
        desc: '只知总数与总脚，便要算出各几只。第一门「从结果倒推」的功夫。',
      },

      // ============ 洪 · 初等代数与几何 ============
      {
        id: 'daishu', name: '代数真解', rarity: '洪',
        school: '代数与几何', realm: 1, compute: 0,
        passive: { energyMax: 0.10 },
        desc: '以符号代替未知，以方程锁住天机。未知数一旦被命名，就已经被驯服。',
      },
      {
        id: 'jihe', name: '几何原本·抄本', rarity: '洪',
        school: '欧氏几何', cond: { jobsDone: 15 },
        passive: { money: 0.08 },
        desc: '五条公设推出一整个世界。抄本缺了第十三卷，恰是留给你的机缘。',
      },
      {
        id: 'hanxin', name: '韩信点兵符', rarity: '洪',
        school: '同余与剩余', cond: { companyCycles: 30 },
        passive: { compute: 0.08 },
        desc: '三三数之剩二，五五数之剩三。兵不必点，符到即知。',
      },
      {
        id: 'yuanzhoulv', name: '圆周率周天诀', rarity: '洪',
        school: '无理数与逼近', cond: { devicesOwned: 5 },
        passive: { energyMax: 0.12 },
        desc: '割之弥细，所失弥少。周三径一之外，是一串永不循环的天机。',
      },
      {
        id: 'pailie', name: '排列归藏经', rarity: '洪',
        school: '计数原理', cond: { trades: 10 },
        passive: { money: 0.12 },
        desc: '加法原理分路而行，乘法原理步步相乘。万般可能，皆可清点。',
      },

      // ============ 宙 · 微积分与线性代数 ============
      {
        id: 'liushu', name: '流数周天', rarity: '宙',
        school: '微积分与分析', realm: 2, compute: 0,
        passive: { compute: 0.10 },
        desc: '把无穷小切成无穷多片，再拼回一个整圆。周天运转，无非求导与积分。',
      },
      {
        id: 'xianxing', name: '线性归一诀', rarity: '宙',
        school: '线性代数', cond: { marketRevenue: 1e6 },
        passive: { compute: 0.10 },
        desc: '矩阵一动，万维归一。特征向量所指的方向，就是不动的方向。',
      },
      {
        id: 'gailv', name: '概率天机签', rarity: '宙',
        school: '概率论', cond: { trades: 30 },
        passive: { allOutput: 0.06 },
        desc: '抽签之前，签文已定于分布之中。不求一签之准，但求万签之真。',
      },
      {
        id: 'jiexi', name: '解析几何遁', rarity: '宙',
        school: '解析几何', cond: { devicesOwned: 10 },
        passive: { deviceCost: -0.08 },
        desc: '几何入坐标则成代数，代数画图则成几何。遁法走的是那条最短的斜率。',
      },
      {
        id: 'jishu', name: '级数聚灵篇', rarity: '宙',
        school: '无穷级数', cond: { compute: 1e7 },
        passive: { shenshi: 0.08 },
        desc: '一加二分之一加三分之一……无穷项之和可以收敛。聚灵亦然：细水长流，终成江海。',
      },

      // ============ 宇 · 数论与分析进阶 ============
      {
        id: 'cedu', name: '测度无量功', rarity: '宇',
        school: '测度论与实分析', realm: 3, compute: 0,
        passive: { shenshi: 0.15 },
        desc: '先问「多大」，再问「多少」。零测之集可以有无穷个点 —— 无量，方能容物。',
      },
      {
        id: 'shulun', name: '数论窥密篇', rarity: '宇',
        school: '初等数论', cond: { stockProfit: true },
        passive: { compute: 0.12 },
        desc: '素数是乘法世界的原子。窥见分布之一斑者，可窥天机之一隅。',
      },
      {
        id: 'weifen', name: '微分万象功', rarity: '宇',
        school: '常微分方程', cond: { companyCycles: 300 },
        passive: { money: 0.15 },
        desc: '知道此刻的变化率，便知道下一刻的一切。万象流转，不过一组方程。',
      },
      {
        id: 'fubian', name: '复变玄枢诀', rarity: '宇',
        school: '复分析', cond: { pressurePeak: 0.2 },
        passive: { allOutput: 0.10 },
        desc: '实轴上走不通的路，绕到复平面上便是一片坦途。枢机一转，围道顿开。',
      },
      {
        id: 'zuhe', name: '组合千机阵', rarity: '宇',
        school: '组合数学', cond: { jobsDone: 60 },
        passive: { energyMax: 0.15 },
        desc: '鸽笼一开，千机必现。数不清的东西，就证明它数不清。',
      },

      // ============ 黄 · 抽象结构 ============
      {
        id: 'liuxing', name: '流形遁法', rarity: '黄',
        school: '拓扑与流形', realm: 4, compute: 1e6,
        passive: { deviceCost: -0.15 },
        desc: '在局部与整体之间穿行。你看不见那个洞，但正是洞让空间连成一体。',
      },
      {
        id: 'chouxiang', name: '抽象万法门', rarity: '黄',
        school: '抽象代数', cond: { marketRevenue: 1e10 },
        passive: { compute: 0.15 },
        desc: '群环域三重门。放下「数是什么」，才看得见「运算本身」。',
      },
      {
        id: 'shifenxi', name: '实分析炼神篇', rarity: '黄',
        school: '实分析', cond: { stockRealized: 1e5 },
        passive: { shenshi: 0.12 },
        desc: '把「极限」两个字拆到骨头里。炼神之路，一步不可跳。',
      },
      {
        id: 'shuzhi', name: '数值推演术', rarity: '黄',
        school: '数值分析', cond: { warehouse: 3 },
        passive: { money: 0.15 },
        desc: '解不出来就逼近它，误差有界便是赢家。修行讲究实际，此术最实际。',
      },
      {
        id: 'tulun', name: '图论迷踪步', rarity: '黄',
        school: '图论', cond: { devicesOwned: 20 },
        passive: { deviceCost: -0.10 },
        desc: '七桥不能一次走遍，但最短路永远存在。节点千万，一步算尽。',
      },

      // ============ 玄 · 高等结构 ============
      {
        id: 'tongdiao', name: '同调大衍篇', rarity: '玄',
        school: '范畴论与同调代数', realm: 5, compute: 1e8,
        passive: { money: 0.25 },
        desc: '不再追问「是什么」，只追问「箭头怎么连」。万物皆为对象，万物皆有态射。',
      },
      {
        id: 'hanhan', name: '泛函通玄录', rarity: '玄',
        school: '泛函分析', cond: { compute: 1e9 },
        passive: { compute: 0.18 },
        desc: '函数之上还有函数，空间之上还有空间。通玄之要，在于把无穷当成一个点。',
      },
      {
        id: 'daijihe', name: '代数几何·天工卷', rarity: '玄',
        school: '代数几何', cond: { pressurePeak: 0.4 },
        passive: { allOutput: 0.15 },
        desc: '方程即形状，形状即方程。天工开物，开的是概形（scheme）。',
      },
      {
        id: 'jiaohuan', name: '交换玄奥经', rarity: '玄',
        school: '交换代数', cond: { rebirth: 1 },
        passive: { energyMax: 0.20 },
        desc: '局部化是一面镜子：环的品性，看它的素理想便知。',
      },
      {
        id: 'liqun', name: '李群御灵诀', rarity: '玄',
        school: '李群与李代数', cond: { tribulation: 3 },
        passive: { shenshi: 0.15 },
        desc: '连续的对称藏着连续的生成元。御灵之要，是握住那个无穷小',
      },

      // ============ 地 · 深奥分支 ============
      {
        id: 'bianli', name: '遍历归元诀', rarity: '地',
        school: '遍历理论与动力系统', realm: 6, compute: 1e10,
        passive: { energyMax: 0.30 },
        desc: '一条轨道走遍整个空间，时间平均等于空间平均。万般变化，终归于一条测线。',
      },
      {
        id: 'biaoshi', name: '表示论·万象章', rarity: '地',
        school: '表示论', cond: { marketRevenue: 1e12 },
        passive: { money: 0.20 },
        desc: '抽象的群无影无形，化作矩阵便现出真身。万象皆为表示。',
      },
      {
        id: 'weifentuopo', name: '微分拓扑·穿界步', rarity: '地',
        school: '微分拓扑', cond: { stockRealized: 1e7 },
        passive: { compute: 0.20 },
        desc: '五维以上，凭微分同胚穿界而行；高维之中，配边即通途。',
      },
      {
        id: 'suanzi', name: '算子摄魂典', rarity: '地',
        school: '算子代数', cond: { rebirth: 2 },
        passive: { allOutput: 0.18 },
        desc: '冯·诺依曼代数自摄其影。观測者与被观测的空间，本是一体两面。',
      },
      {
        id: 'tuoyuan', name: '椭圆曲线藏珍诀', rarity: '地',
        school: '椭圆曲线', cond: { pressurePeak: 0.55 },
        passive: { deviceCost: -0.18 },
        desc: '一条三次曲线，藏着BSD猜想与千禧年悬赏。藏珍之地，最朴素的方程最深。',
      },

      // ============ 天（最稀有）· 数理逻辑与几何顶点 ============
      {
        id: 'lianxu', name: '连续统真言', rarity: '天',
        school: '数理逻辑·大基数', realm: 7, compute: 1e12,
        passive: { allOutput: 0.30 },
        desc: '有些命题，你既无法证明它为真，也无法证明它为假。参至此境，言语道断。',
      },
      {
        id: 'langlanzi', name: '朗兰兹通天箓', rarity: '天',
        school: '朗兰兹纲领', compute: 1e14,
        passive: { allOutput: 0.50 },
        desc: '数论、代数几何、表示论，本是同一句话的三种方言。参透此箓，万法互译。',
      },
      {
        id: 'gaojie', name: '高阶范畴·无量天章', rarity: '天',
        school: '高阶范畴论', cond: { rebirth: 3 },
        passive: { allOutput: 0.25 },
        desc: '对象之间有态射，态射之间还有态射。∞-群胚之中，无量天章自然成文。',
      },
      {
        id: 'muti', name: '母题玄机箓', rarity: '天',
        school: '母题理论', cond: { tribulation: 8 },
        passive: { shenshi: 0.30 },
        desc: '所有上同调理论的共同源头，那个「万变之中的不变量」，古人称之为母题。',
      },
      {
        id: 'suanjihe', name: '算术几何·永恒篇', rarity: '天',
        school: '算术几何', cond: { pressurePeak: 0.7 },
        passive: { compute: 0.25 },
        desc: '把素数铺成一张概形上的几何。费马大定理就沉眠在这条路上。',
      },
      {
        id: 'zhengming', name: '证明论·太上篇', rarity: '天',
        school: '证明论与反推数学', cond: { marketRevenue: 1e14 },
        passive: { money: 0.30 },
        desc: '证明本身也是被研究的对象。「此句不可证」——太上忘情，逻辑忘己。',
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
    /**
   * 境界表。
   *
   *   need      从本境界突破到下一境界所需的灵气（×100 / 境，与算力增长同量级）
   *   maxEnergy 精力上限
   *   regen     精力恢复速度（点 / 现实秒）—— **随境界提升**。
   *             工作的单次精力消耗也在涨（15 → 38 → 80 → 200 → 520），
   *             若恢复速度恒为 1，元婴期做一份工作要等 8 分钟以上，纯粹的干等。
   *             恢复速度按 ~×1.45 / 境抬升，把等待时间压回一分钟上下；
   *             同时它不会让收入失控 —— 高档位下工作收益的瓶颈会自动从
   *             「精力」切到「游戏时间」，恢复再快也加不了钱（见 advanceWork）。
   *   shenshi   本境界的基准神识
   */
  realms: [
    { id: 0, name: '凡人', need: 500,   maxEnergy: 100,  regen: 1,    shenshi: 1 },
    { id: 1, name: '炼气', need: 5e4,   maxEnergy: 160,  regen: 1.6,  shenshi: 4 },
    { id: 2, name: '筑基', need: 5e6,   maxEnergy: 260,  regen: 2.6,  shenshi: 14 },
    { id: 3, name: '金丹', need: 5e8,   maxEnergy: 420,  regen: 4.5,  shenshi: 40 },
    { id: 4, name: '元婴', need: 5e10,  maxEnergy: 660,  regen: 7,    shenshi: 100 },
    { id: 5, name: '化神', need: 5e12,  maxEnergy: 960,  regen: 10,   shenshi: 260 },
    { id: 6, name: '炼虚', need: 5e14,  maxEnergy: 1360, regen: 14,   shenshi: 680 },
    { id: 7, name: '合体', need: 5e16,  maxEnergy: 1900, regen: 20,   shenshi: 1800 },
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

    /** 注册门槛：只看境界。金钱门槛由 foundCost 表达 —— 它就是注册费本身。 */
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
     * 压力的演化（每期结算一次，只在「期切换」时发生）。
     * 「期」按**现实时间**计（见 goods[].periodSeconds），不受时间档位影响：
     *
     *     add      = clamp(excess / max(baseVolume, 本期产出), 0, 1)
     *     pressure = clamp(pressure × decay^期数 + add × decay^(期数−1), 0, 1)
     *     impact   = 1 − pressure × maxDrop                          → 0.60 ~ 1.00
     *     price    = basePrice × 自然波动因子 × impact
     *
     * 注意新增压力是**加上去**的，不是与旧压力取大值 —— 连续砸盘会一轮轮叠高，
     * 停手之后才按 decay 逐期恢复。（早先这里的公式写成 clamp(max(旧压力, add))，
     * 与 game-core.js 的 syncMarket 实现不符，已按代码改正。）
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
       * 综合价格的保底倍数（以基准价为参照：0.15 = 不低于基准价的 15%）。
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
     *   periodSeconds 变价周期（**现实秒**）。科技类 60 秒，修仙类 600 秒。
     *                刻意与游戏内时间脱钩：时间档位只加速工作，不加速行情。
     *                早先按「游戏内年」计时，档 4（1 秒 = 1 游戏月）下 1 游戏年
     *                只有 12 现实秒 —— 抛压 4 期就衰减干净，砸盘惩罚形同虚设，
     *                把档位拉满等于免罚。改成现实秒后，任何档位下行情节奏一致。
     *                取值与公司生产周期（20 现实秒）成整数倍，保证一期里恰好
     *                跑完整数个生产周期，「本期卖出 / 本期产出」的计数才干净。
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
      { id: 'iron_ore',    name: '铁矿石',   kind: 'tech', industry: 'mining', basePrice: 12,  volatility: 0.34, minFactor: 0.45, maxFactor: 2.30, periodSeconds: 60, outputCoef: 1.20, upkeepRate: 0.28 },
      { id: 'coal',        name: '焦煤',     kind: 'tech', industry: 'mining', basePrice: 16,  volatility: 0.33, minFactor: 0.46, maxFactor: 2.25, periodSeconds: 60, outputCoef: 1.15, upkeepRate: 0.28 },
      { id: 'copper_ore',  name: '铜矿石',   kind: 'tech', industry: 'mining', basePrice: 18,  volatility: 0.33, minFactor: 0.46, maxFactor: 2.25, periodSeconds: 60, outputCoef: 1.12, upkeepRate: 0.29 },
      { id: 'bauxite',     name: '铝土矿',   kind: 'tech', industry: 'mining', basePrice: 22,  volatility: 0.32, minFactor: 0.47, maxFactor: 2.20, periodSeconds: 60, outputCoef: 1.08, upkeepRate: 0.29 },
      { id: 'silica',      name: '硅石',     kind: 'tech', industry: 'mining', basePrice: 28,  volatility: 0.31, minFactor: 0.48, maxFactor: 2.15, periodSeconds: 60, outputCoef: 1.00, upkeepRate: 0.29 },
      { id: 'rare_earth',  name: '稀土矿',   kind: 'tech', industry: 'mining', basePrice: 55,  volatility: 0.36, minFactor: 0.42, maxFactor: 2.45, periodSeconds: 60, outputCoef: 0.72, upkeepRate: 0.31 },
      // ---- 冶炼（上游：采掘）----
      { id: 'pig_iron',    name: '生铁',     kind: 'tech', industry: 'smelt', basePrice: 95,   volatility: 0.31, minFactor: 0.48, maxFactor: 2.15, periodSeconds: 60, outputCoef: 1.18, upkeepRate: 0.29 },
      { id: 'blister_cu',  name: '粗铜',     kind: 'tech', industry: 'smelt', basePrice: 140,  volatility: 0.31, minFactor: 0.48, maxFactor: 2.12, periodSeconds: 60, outputCoef: 1.10, upkeepRate: 0.29 },
      { id: 'aluminum',    name: '铝锭',     kind: 'tech', industry: 'smelt', basePrice: 170,  volatility: 0.30, minFactor: 0.49, maxFactor: 2.10, periodSeconds: 60, outputCoef: 1.05, upkeepRate: 0.30 },
      { id: 'steel',       name: '钢材',     kind: 'tech', industry: 'smelt', basePrice: 210,  volatility: 0.29, minFactor: 0.50, maxFactor: 2.08, periodSeconds: 60, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'silicon_met', name: '工业硅',   kind: 'tech', industry: 'smelt', basePrice: 260,  volatility: 0.30, minFactor: 0.50, maxFactor: 2.08, periodSeconds: 60, outputCoef: 0.92, upkeepRate: 0.30 },
      { id: 'rare_alloy',  name: '稀土合金', kind: 'tech', industry: 'smelt', basePrice: 400,  volatility: 0.33, minFactor: 0.46, maxFactor: 2.20, periodSeconds: 60, outputCoef: 0.70, upkeepRate: 0.32 },
      // ---- 化工（上游：采掘）----
      { id: 'sulfuric',    name: '硫酸',     kind: 'tech', industry: 'chem', basePrice: 115,  volatility: 0.30, minFactor: 0.49, maxFactor: 2.08, periodSeconds: 60, outputCoef: 1.18, upkeepRate: 0.28 },
      { id: 'ammonia',     name: '合成氨',   kind: 'tech', industry: 'chem', basePrice: 150,  volatility: 0.30, minFactor: 0.49, maxFactor: 2.06, periodSeconds: 60, outputCoef: 1.10, upkeepRate: 0.29 },
      { id: 'ethylene',    name: '乙烯',     kind: 'tech', industry: 'chem', basePrice: 190,  volatility: 0.29, minFactor: 0.50, maxFactor: 2.04, periodSeconds: 60, outputCoef: 1.02, upkeepRate: 0.29 },
      { id: 'spec_gas',    name: '特种气体', kind: 'tech', industry: 'chem', basePrice: 420,  volatility: 0.31, minFactor: 0.48, maxFactor: 2.10, periodSeconds: 60, outputCoef: 0.85, upkeepRate: 0.31 },
      { id: 'reagent',     name: '高纯试剂', kind: 'tech', industry: 'chem', basePrice: 560,  volatility: 0.32, minFactor: 0.47, maxFactor: 2.12, periodSeconds: 60, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'photoresist', name: '光刻胶',   kind: 'tech', industry: 'chem', basePrice: 880,  volatility: 0.35, minFactor: 0.44, maxFactor: 2.25, periodSeconds: 60, outputCoef: 0.62, upkeepRate: 0.33 },
      // ---- 精密制造（上游：冶炼）----
      { id: 'bearing',     name: '轴承',     kind: 'tech', industry: 'precision', basePrice: 620,  volatility: 0.28, minFactor: 0.52, maxFactor: 1.98, periodSeconds: 60, outputCoef: 1.16, upkeepRate: 0.29 },
      { id: 'gearbox',     name: '齿轮组',   kind: 'tech', industry: 'precision', basePrice: 850,  volatility: 0.28, minFactor: 0.52, maxFactor: 1.96, periodSeconds: 60, outputCoef: 1.08, upkeepRate: 0.29 },
      { id: 'hydraulic',   name: '液压件',   kind: 'tech', industry: 'precision', basePrice: 1100, volatility: 0.27, minFactor: 0.53, maxFactor: 1.94, periodSeconds: 60, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'mold',        name: '精密模具', kind: 'tech', industry: 'precision', basePrice: 1500, volatility: 0.28, minFactor: 0.52, maxFactor: 1.94, periodSeconds: 60, outputCoef: 0.90, upkeepRate: 0.30 },
      { id: 'optics',      name: '光学镜片', kind: 'tech', industry: 'precision', basePrice: 2600, volatility: 0.30, minFactor: 0.50, maxFactor: 1.98, periodSeconds: 60, outputCoef: 0.74, upkeepRate: 0.31 },
      { id: 'chamber',     name: '真空腔体', kind: 'tech', industry: 'precision', basePrice: 4200, volatility: 0.32, minFactor: 0.48, maxFactor: 2.02, periodSeconds: 60, outputCoef: 0.60, upkeepRate: 0.32 },
      // ---- 电子（上游：冶炼 + 化工）----
      { id: 'component',   name: '电子元件', kind: 'tech', industry: 'electron', basePrice: 3200,  volatility: 0.30, minFactor: 0.50, maxFactor: 2.00, periodSeconds: 60, outputCoef: 1.15, upkeepRate: 0.29 },
      { id: 'power_dev',   name: '功率器件', kind: 'tech', industry: 'electron', basePrice: 5400,  volatility: 0.31, minFactor: 0.49, maxFactor: 2.02, periodSeconds: 60, outputCoef: 1.05, upkeepRate: 0.30 },
      { id: 'sensor',      name: '传感器',   kind: 'tech', industry: 'electron', basePrice: 8200,  volatility: 0.31, minFactor: 0.49, maxFactor: 2.02, periodSeconds: 60, outputCoef: 0.95, upkeepRate: 0.30 },
      { id: 'memory_die',  name: '存储颗粒', kind: 'tech', industry: 'electron', basePrice: 15000, volatility: 0.34, minFactor: 0.46, maxFactor: 2.12, periodSeconds: 60, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'optical_mod', name: '光模块',   kind: 'tech', industry: 'electron', basePrice: 28000, volatility: 0.35, minFactor: 0.45, maxFactor: 2.15, periodSeconds: 60, outputCoef: 0.66, upkeepRate: 0.32 },
      { id: 'chip',        name: '半导体芯片', kind: 'tech', industry: 'electron', basePrice: 52000, volatility: 0.38, minFactor: 0.42, maxFactor: 2.25, periodSeconds: 60, outputCoef: 0.52, upkeepRate: 0.33 },
      // ---- 整机装配（上游：电子 + 精密制造）----
      { id: 'server',      name: '服务器整机', kind: 'tech', industry: 'assembly', basePrice: 1.3e5, volatility: 0.28, minFactor: 0.53, maxFactor: 1.94, periodSeconds: 60, outputCoef: 1.15, upkeepRate: 0.29 },
      { id: 'robot',       name: '工业机器人', kind: 'tech', industry: 'assembly', basePrice: 2.6e5, volatility: 0.29, minFactor: 0.52, maxFactor: 1.96, periodSeconds: 60, outputCoef: 1.02, upkeepRate: 0.30 },
      { id: 'cabinet',     name: '算力集群',   kind: 'tech', industry: 'assembly', basePrice: 5.5e5, volatility: 0.30, minFactor: 0.51, maxFactor: 1.98, periodSeconds: 60, outputCoef: 0.88, upkeepRate: 0.30 },
      { id: 'cnc',         name: '精密机床',   kind: 'tech', industry: 'assembly', basePrice: 1.1e6, volatility: 0.30, minFactor: 0.51, maxFactor: 1.98, periodSeconds: 60, outputCoef: 0.74, upkeepRate: 0.31 },
      { id: 'imaging',     name: '影像设备',   kind: 'tech', industry: 'assembly', basePrice: 1.8e6, volatility: 0.31, minFactor: 0.50, maxFactor: 2.00, periodSeconds: 60, outputCoef: 0.64, upkeepRate: 0.31 },
      { id: 'sat_bus',     name: '卫星平台',   kind: 'tech', industry: 'assembly', basePrice: 3.2e6, volatility: 0.34, minFactor: 0.47, maxFactor: 2.10, periodSeconds: 60, outputCoef: 0.52, upkeepRate: 0.33 },
      // ---- 灵植（修仙最上游）----
      { id: 'spirit_grain',  name: '灵谷',   kind: 'xiuxian', industry: 'herb', basePrice: 220,  volatility: 0.24, minFactor: 0.58, maxFactor: 1.88, periodSeconds: 600, outputCoef: 1.20, upkeepRate: 0.28 },
      { id: 'spirit_hemp',   name: '灵麻',   kind: 'xiuxian', industry: 'herb', basePrice: 340,  volatility: 0.24, minFactor: 0.58, maxFactor: 1.86, periodSeconds: 600, outputCoef: 1.12, upkeepRate: 0.28 },
      { id: 'moon_herb',     name: '月华草', kind: 'xiuxian', industry: 'herb', basePrice: 620,  volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodSeconds: 600, outputCoef: 1.00, upkeepRate: 0.29 },
      { id: 'frost_lotus',   name: '玄冰花', kind: 'xiuxian', industry: 'herb', basePrice: 980,  volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodSeconds: 600, outputCoef: 0.88, upkeepRate: 0.29 },
      { id: 'blood_ginseng', name: '赤血参', kind: 'xiuxian', industry: 'herb', basePrice: 1600, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodSeconds: 600, outputCoef: 0.76, upkeepRate: 0.30 },
      { id: 'thunder_wood',  name: '雷击木', kind: 'xiuxian', industry: 'herb', basePrice: 2800, volatility: 0.29, minFactor: 0.53, maxFactor: 1.96, periodSeconds: 600, outputCoef: 0.62, upkeepRate: 0.31 },
      // ---- 炼丹（上游：灵植）----
      { id: 'body_pill',   name: '淬体丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 1.3e4, volatility: 0.23, minFactor: 0.59, maxFactor: 1.85, periodSeconds: 600, outputCoef: 1.18, upkeepRate: 0.29 },
      { id: 'gather_pill', name: '聚灵丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 3.0e4, volatility: 0.23, minFactor: 0.59, maxFactor: 1.84, periodSeconds: 600, outputCoef: 1.05, upkeepRate: 0.29 },
      { id: 'heal_pill',   name: '疗伤丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 7.0e4, volatility: 0.24, minFactor: 0.58, maxFactor: 1.86, periodSeconds: 600, outputCoef: 0.92, upkeepRate: 0.30 },
      { id: 'marrow_pill', name: '洗髓丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 1.8e5, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodSeconds: 600, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'break_pill',  name: '破境丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 4.5e5, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodSeconds: 600, outputCoef: 0.64, upkeepRate: 0.32 },
      { id: 'golden_pill', name: '九转金丹', kind: 'xiuxian', industry: 'alchemy', basePrice: 1.2e6, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodSeconds: 600, outputCoef: 0.50, upkeepRate: 0.33 },
      // ---- 制符（上游：灵植）----
      { id: 'wind_talis',   name: '清风符', kind: 'xiuxian', industry: 'talisman', basePrice: 9.5e3, volatility: 0.23, minFactor: 0.60, maxFactor: 1.84, periodSeconds: 600, outputCoef: 1.18, upkeepRate: 0.29 },
      { id: 'fire_talis',   name: '火球符', kind: 'xiuxian', industry: 'talisman', basePrice: 2.2e4, volatility: 0.23, minFactor: 0.59, maxFactor: 1.84, periodSeconds: 600, outputCoef: 1.06, upkeepRate: 0.29 },
      { id: 'conceal_tal',  name: '敛息符', kind: 'xiuxian', industry: 'talisman', basePrice: 5.5e4, volatility: 0.24, minFactor: 0.58, maxFactor: 1.86, periodSeconds: 600, outputCoef: 0.92, upkeepRate: 0.30 },
      { id: 'vajra_talis',  name: '金刚符', kind: 'xiuxian', industry: 'talisman', basePrice: 1.4e5, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodSeconds: 600, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'thunder_tal',  name: '雷符',   kind: 'xiuxian', industry: 'talisman', basePrice: 3.5e5, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodSeconds: 600, outputCoef: 0.64, upkeepRate: 0.32 },
      { id: 'teleport_tal', name: '传送符', kind: 'xiuxian', industry: 'talisman', basePrice: 9.0e5, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodSeconds: 600, outputCoef: 0.50, upkeepRate: 0.33 },
      // ---- 炼器（上游：冶炼）----
      { id: 'storage_ring',  name: '储物戒',   kind: 'xiuxian', industry: 'refine', basePrice: 5.5e4, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodSeconds: 600, outputCoef: 1.16, upkeepRate: 0.29 },
      { id: 'magic_sword',   name: '法剑',     kind: 'xiuxian', industry: 'refine', basePrice: 1.4e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodSeconds: 600, outputCoef: 1.02, upkeepRate: 0.30 },
      { id: 'armor',         name: '护甲',     kind: 'xiuxian', industry: 'refine', basePrice: 3.5e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodSeconds: 600, outputCoef: 0.88, upkeepRate: 0.30 },
      { id: 'flying_boat',   name: '飞舟',     kind: 'xiuxian', industry: 'refine', basePrice: 9.0e5, volatility: 0.28, minFactor: 0.54, maxFactor: 1.94, periodSeconds: 600, outputCoef: 0.72, upkeepRate: 0.31 },
      { id: 'spirit_furnace',name: '灵炉',     kind: 'xiuxian', industry: 'refine', basePrice: 2.5e6, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodSeconds: 600, outputCoef: 0.58, upkeepRate: 0.32 },
      { id: 'core_treasure', name: '本命法宝', kind: 'xiuxian', industry: 'refine', basePrice: 7.0e6, volatility: 0.34, minFactor: 0.48, maxFactor: 2.08, periodSeconds: 600, outputCoef: 0.42, upkeepRate: 0.34 },
      // ---- 阵盘（上游：炼器 + 制符）----
      { id: 'ward_array',   name: '防护阵',     kind: 'xiuxian', industry: 'array', basePrice: 6.5e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodSeconds: 600, outputCoef: 1.14, upkeepRate: 0.29 },
      { id: 'gather_array', name: '聚灵阵',     kind: 'xiuxian', industry: 'array', basePrice: 1.5e6, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodSeconds: 600, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'illusion_arr', name: '幻阵',       kind: 'xiuxian', industry: 'array', basePrice: 3.5e6, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodSeconds: 600, outputCoef: 0.86, upkeepRate: 0.30 },
      { id: 'kill_array',   name: '杀伐阵',     kind: 'xiuxian', industry: 'array', basePrice: 8.0e6, volatility: 0.29, minFactor: 0.53, maxFactor: 1.96, periodSeconds: 600, outputCoef: 0.70, upkeepRate: 0.31 },
      { id: 'teleport_arr', name: '传送阵',     kind: 'xiuxian', industry: 'array', basePrice: 2.0e7, volatility: 0.31, minFactor: 0.51, maxFactor: 2.00, periodSeconds: 600, outputCoef: 0.56, upkeepRate: 0.32 },
      { id: 'star_array',   name: '周天星斗阵', kind: 'xiuxian', industry: 'array', basePrice: 5.0e7, volatility: 0.35, minFactor: 0.47, maxFactor: 2.10, periodSeconds: 600, outputCoef: 0.40, upkeepRate: 0.34 },
      // ---- 洞天（上游：阵盘 + 炼丹）----
      { id: 'leyline_node', name: '灵脉节点', kind: 'xiuxian', industry: 'cave', basePrice: 2.2e10, volatility: 0.24, minFactor: 0.58, maxFactor: 1.88, periodSeconds: 600, outputCoef: 1.14, upkeepRate: 0.29 },
      { id: 'cave_heaven',  name: '洞天福地', kind: 'xiuxian', industry: 'cave', basePrice: 4.5e10, volatility: 0.24, minFactor: 0.58, maxFactor: 1.88, periodSeconds: 600, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'void_ship',    name: '太虚舟',   kind: 'xiuxian', industry: 'cave', basePrice: 9.0e10, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodSeconds: 600, outputCoef: 0.84, upkeepRate: 0.30 },
      { id: 'micro_world',  name: '小千世界', kind: 'xiuxian', industry: 'cave', basePrice: 2.0e11, volatility: 0.28, minFactor: 0.54, maxFactor: 1.94, periodSeconds: 600, outputCoef: 0.68, upkeepRate: 0.31 },
      { id: 'star_core',    name: '星辰核',   kind: 'xiuxian', industry: 'cave', basePrice: 5.0e11, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodSeconds: 600, outputCoef: 0.54, upkeepRate: 0.32 },
      { id: 'world_tree',   name: '世界树',   kind: 'xiuxian', industry: 'cave', basePrice: 1.2e12, volatility: 0.33, minFactor: 0.49, maxFactor: 2.04, periodSeconds: 600, outputCoef: 0.40, upkeepRate: 0.34 },
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

    /**
     * 每过一期，净买入流保留的比例（0.5 = 一期减半，冲击逐期消退）。
     * 「期」按**现实秒**计（stocks[].periodSeconds），与商品市场同一套口径 ——
     * 早先按游戏内年计时，档位拉满时一期只有 12 现实秒，冲击瞬间衰减干净，
     * 「一轮买卖必亏」的约束会被档位抹掉。
     */
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

    /** 成交价相对自然价的保底倍数（0.05 = 不低于自然价的 5%，防止被砸到 0 附近） */
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
     *   periodSeconds 变价周期（现实秒，与商品市场同一套口径）
     *
     * 价格量级刻意比联动商品**低几个数量级**：一股的价钱不等于一件货的价钱，
     * 否则洞天类公司一股要 1e12，早期玩家永远开不了仓。同时流通盘按「目标市值
     * ≈ 1e11」反推，让 50 家的市值落在同一档 —— 榜单前 10 才会随行情真的换人。
     */
    stocks: [
      // ================= 科技 · 采掘（4）=================
      { id: 'jinshi', name: '金石矿业', code: 'JINSHI', kind: 'tech', sector: 'mining', link: 'iron_ore',
        business: '铁矿石开采与粗选', basePrice: 45, volatility: 1.05, minFactor: 0.34, maxFactor: 2.90, depth: 2.2e9, periodSeconds: 60,
        desc: '守着半座铁矿山过日子。钢价涨它未必涨，矿价跌它一定跌。' },
      { id: 'beiling', name: '北岭煤业', code: 'BEILING', kind: 'tech', sector: 'mining', link: 'coal',
        business: '焦煤开采与洗选', basePrice: 38, volatility: 1.00, minFactor: 0.36, maxFactor: 2.75, depth: 2.4e9, periodSeconds: 60,
        desc: '给所有高炉供口粮。口粮一贵，全产业链都跟着咳嗽。' },
      { id: 'chitong', name: '赤铜集团', code: 'CHITONG', kind: 'tech', sector: 'mining', link: 'copper_ore',
        business: '铜矿石采选', basePrice: 62, volatility: 1.10, minFactor: 0.33, maxFactor: 3.00, depth: 1.6e9, periodSeconds: 60,
        desc: '电线、电机、散热片都吃铜。它的报表就是基建的体温计。' },
      { id: 'xitu', name: '稀土纪元', code: 'XITU', kind: 'tech', sector: 'mining', link: 'rare_earth',
        business: '稀土矿开采与分离', basePrice: 180, volatility: 1.35, minFactor: 0.26, maxFactor: 3.80, depth: 4.4e8, periodSeconds: 60,
        desc: '一吨矿里的那几克，卡着整个高端制造的脖子。涨起来没有道理可讲。' },
      // ================= 科技 · 冶炼（4）=================
      { id: 'rongcheng', name: '熔城冶金', code: 'RONGCHENG', kind: 'tech', sector: 'smelt', link: 'pig_iron',
        business: '生铁冶炼', basePrice: 55, volatility: 0.98, minFactor: 0.37, maxFactor: 2.65, depth: 1.8e9, periodSeconds: 60,
        desc: '高炉日夜不熄火。矿价是它最大的敌人，钢价是它唯一的指望。' },
      { id: 'changhe', name: '长河钢铁', code: 'CHANGHE', kind: 'tech', sector: 'smelt', link: 'steel',
        business: '钢材轧制', basePrice: 95, volatility: 0.95, minFactor: 0.38, maxFactor: 2.55, depth: 1.1e9, periodSeconds: 60,
        desc: '基建的米铺子。毛利率薄得像钢板，全靠走量。' },
      { id: 'qingjin', name: '轻金属联合', code: 'QINGJIN', kind: 'tech', sector: 'smelt', link: 'aluminum',
        business: '铝锭电解', basePrice: 130, volatility: 1.00, minFactor: 0.36, maxFactor: 2.70, depth: 8.0e8, periodSeconds: 60,
        desc: '电解槽一开就是几个月不停。电价涨一分，利润就没了。' },
      { id: 'jinggui', name: '晶硅科技', code: 'JINGGUI', kind: 'tech', sector: 'smelt', link: 'silicon_met',
        business: '工业硅提纯', basePrice: 240, volatility: 1.15, minFactor: 0.32, maxFactor: 3.05, depth: 3.6e8, periodSeconds: 60,
        desc: '光伏与芯片的共同上游。两头景气它最风光，两头萧条它最先倒。' },
      // ================= 科技 · 化工（4）=================
      { id: 'sansuan', name: '三酸化建', code: 'SANSUAN', kind: 'tech', sector: 'chem', link: 'sulfuric',
        business: '硫酸与基础化工', basePrice: 70, volatility: 0.92, minFactor: 0.39, maxFactor: 2.45, depth: 1.5e9, periodSeconds: 60,
        desc: '化工里的自来水厂。哪里都要，哪里都不值钱 —— 胜在稳定。' },
      { id: 'dangu', name: '氮谷化工', code: 'DANGU', kind: 'tech', sector: 'chem', link: 'ammonia',
        business: '合成氨与氮肥', basePrice: 110, volatility: 0.95, minFactor: 0.38, maxFactor: 2.50, depth: 9.0e8, periodSeconds: 60,
        desc: '养活一半人口的产业。需求刚性，价格也就没什么想象力。' },
      { id: 'teqi', name: '特气先锋', code: 'TEQI', kind: 'tech', sector: 'chem', link: 'spec_gas',
        business: '特种气体', basePrice: 320, volatility: 1.12, minFactor: 0.33, maxFactor: 2.95, depth: 3.0e8, periodSeconds: 60,
        desc: '纯度写进小数点后六位。客户一旦认证就不换供应商，也不还价。' },
      { id: 'guangke', name: '光刻材料', code: 'GUANGKE', kind: 'tech', sector: 'chem', link: 'photoresist',
        business: '光刻胶与电子化学品', basePrice: 620, volatility: 1.30, minFactor: 0.28, maxFactor: 3.55, depth: 1.6e8, periodSeconds: 60,
        desc: '卡脖子的那瓶液体。国产替代的故事讲了很多年，每次都能涨一轮。' },
      // ================= 科技 · 精密制造（5）=================
      { id: 'jinggong', name: '精工轴承', code: 'JINGGONG', kind: 'tech', sector: 'precision', link: 'bearing',
        business: '高精度轴承', basePrice: 380, volatility: 0.90, minFactor: 0.40, maxFactor: 2.40, depth: 2.6e8, periodSeconds: 60,
        desc: '所有转动的东西都要它。寿命按万小时算，口碑按十年攒。' },
      { id: 'wanxiang', name: '万象传动', code: 'WANXIANG', kind: 'tech', sector: 'precision', link: 'gearbox',
        business: '齿轮组与传动系统', basePrice: 520, volatility: 0.92, minFactor: 0.40, maxFactor: 2.42, depth: 2.0e8, periodSeconds: 60,
        desc: '把转速变成扭矩的生意。机床、风电、机器人，处处有它的齿轮。' },
      { id: 'hengyue', name: '恒岳重工', code: 'HENGYUE', kind: 'tech', sector: 'precision', link: 'hydraulic',
        business: '液压件与重型装备', basePrice: 700, volatility: 0.94, minFactor: 0.39, maxFactor: 2.45, depth: 1.5e8, periodSeconds: 60,
        desc: '挖掘机的大臂、水轮机的闸门。订单跟着基建周期大起大落。' },
      { id: 'tiangong', name: '天工模具', code: 'TIANGONG', kind: 'tech', sector: 'precision', link: 'mold',
        business: '精密模具', basePrice: 900, volatility: 0.95, minFactor: 0.39, maxFactor: 2.48, depth: 1.2e8, periodSeconds: 60,
        desc: '一套模具定一款产品的命。做得准就能吃十年，做不准就是废铁。' },
      { id: 'mingjing', name: '明镜光学', code: 'MINGJING', kind: 'tech', sector: 'precision', link: 'optics',
        business: '光学镜片与镜头组', basePrice: 1500, volatility: 1.08, minFactor: 0.35, maxFactor: 2.80, depth: 6.5e7, periodSeconds: 60,
        desc: '镜头里的玻璃比金贵。镀膜配方是它唯一不写在说明书上的东西。' },
      // ================= 科技 · 电子（6）=================
      { id: 'yuanjian', name: '元件世家', code: 'YUANJIAN', kind: 'tech', sector: 'electron', link: 'component',
        business: '被动元件与连接器', basePrice: 1200, volatility: 1.05, minFactor: 0.36, maxFactor: 2.75, depth: 8.5e7, periodSeconds: 60,
        desc: '一颗几分钱，缺货时整条产线停摆。周期来了涨十倍，走了跌回原地。' },
      { id: 'gonglv', name: '功率半导体', code: 'GONGLV', kind: 'tech', sector: 'electron', link: 'power_dev',
        business: '功率器件', basePrice: 2100, volatility: 1.10, minFactor: 0.34, maxFactor: 2.85, depth: 4.8e7, periodSeconds: 60,
        desc: '电车与电网的心脏。不追先进制程，靠可靠性吃一辈子。' },
      { id: 'ganxin', name: '感芯科技', code: 'GANXIN', kind: 'tech', sector: 'electron', link: 'sensor',
        business: '传感器', basePrice: 3200, volatility: 1.15, minFactor: 0.33, maxFactor: 2.95, depth: 3.2e7, periodSeconds: 60,
        desc: '给机器装五官。出货量跟着终端走，毛利率跟着竞争格局走。' },
      { id: 'cunchu', name: '存储纪元', code: 'CUNCHU', kind: 'tech', sector: 'electron', link: 'memory_die',
        business: '存储颗粒', basePrice: 3000, volatility: 1.28, minFactor: 0.29, maxFactor: 3.40, depth: 3.4e7, periodSeconds: 60,
        desc: '标准的周期股。三年不开张，开张吃三年，散户在这上面亏得最惨。' },
      { id: 'guanglian', name: '光联通信', code: 'GUANGLIAN', kind: 'tech', sector: 'electron', link: 'optical_mod',
        business: '光模块', basePrice: 4500, volatility: 1.20, minFactor: 0.31, maxFactor: 3.20, depth: 2.3e7, periodSeconds: 60,
        desc: '算力集群的血管。数据中心一扩建，它的订单就排到明年。' },
      { id: 'chipsci', name: '算力芯科', code: 'CHIPSCI', kind: 'tech', sector: 'electron', link: 'chip',
        business: '半导体芯片设计与代工', basePrice: 5200, volatility: 1.25, minFactor: 0.30, maxFactor: 3.30, depth: 2.0e7, periodSeconds: 60,
        desc: '给整机厂供芯的老牌大厂。芯片行情好它就涨，行情差它就跌 —— 很诚实。' },
      // ================= 科技 · 整机装配（6）=================
      { id: 'xuanji', name: '玄机数术', code: 'XUANJI', kind: 'tech', sector: 'assembly', link: 'server',
        business: '服务器整机与算力集群', basePrice: 8000, volatility: 1.00, minFactor: 0.38, maxFactor: 2.60, depth: 1.3e7, periodSeconds: 60,
        desc: '整机与算力集群的承包商。订单跟着服务器行情走，账期跟着甲方走。' },
      { id: 'jixie', name: '机械纪元', code: 'JIXIE', kind: 'tech', sector: 'assembly', link: 'robot',
        business: '工业机器人', basePrice: 12000, volatility: 1.05, minFactor: 0.36, maxFactor: 2.70, depth: 8.5e6, periodSeconds: 60,
        desc: '替代人工的那批铁臂。人力越贵它越好卖，需求很朴素。' },
      { id: 'jiqun', name: '集群时代', code: 'JIQUN', kind: 'tech', sector: 'assembly', link: 'cabinet',
        business: '算力集群集成', basePrice: 15000, volatility: 1.08, minFactor: 0.35, maxFactor: 2.78, depth: 7.0e6, periodSeconds: 60,
        desc: '把机柜、供电、液冷打包交付。真正的门槛是交付速度，不是技术。' },
      { id: 'ruifeng', name: '锐锋机床', code: 'RUIFENG', kind: 'tech', sector: 'assembly', link: 'cnc',
        business: '精密数控机床', basePrice: 22000, volatility: 1.02, minFactor: 0.37, maxFactor: 2.62, depth: 4.6e6, periodSeconds: 60,
        desc: '工业母机。所有精密件的精度，最终都由它的丝杠决定。' },
      { id: 'yinghe', name: '影和医疗', code: 'YINGHE', kind: 'tech', sector: 'assembly', link: 'imaging',
        business: '医学影像设备', basePrice: 28000, volatility: 0.98, minFactor: 0.38, maxFactor: 2.55, depth: 3.6e6, periodSeconds: 60,
        desc: 'CT 与核磁。招标周期长、回款慢，但一旦中标就是十年服务。' },
      { id: 'xingcha', name: '星槎航天', code: 'XINGCHA', kind: 'tech', sector: 'assembly', link: 'sat_bus',
        business: '卫星平台与载荷', basePrice: 42000, volatility: 1.22, minFactor: 0.30, maxFactor: 3.25, depth: 2.5e6, periodSeconds: 60,
        desc: '把东西送上天，还要它回来。一次失利，股价腰斩；一次成功，翻倍。' },
      // ================= 科技 · 独立行情（1）=================
      { id: 'tianji', name: '天机阁', code: 'TIANJI', kind: 'tech', sector: null, link: null,
        business: '推演与咨询（无从核实）', basePrice: 60, volatility: 1.45, minFactor: 0.24, maxFactor: 4.20, depth: 1.8e9, periodSeconds: 60,
        desc: '坊间传它算得出天机。既算不出自己的现金流，也算不出下个月还在不在。' },
      // ================= 修仙 · 灵植（4）=================
      { id: 'qinghe', name: '青禾灵田', code: 'QINGHE', kind: 'xiuxian', sector: 'herb', link: 'spirit_grain',
        business: '灵谷种植与仓储', basePrice: 260, volatility: 0.80, minFactor: 0.44, maxFactor: 2.20, depth: 4.0e8, periodSeconds: 60,
        desc: '修仙界的口粮供应商。谁都要吃饭，所以谁也不敢让它倒。' },
      { id: 'yunma', name: '云麻堂', code: 'YUNMA', kind: 'xiuxian', sector: 'herb', link: 'spirit_hemp',
        business: '灵麻与纤维作物', basePrice: 380, volatility: 0.82, minFactor: 0.43, maxFactor: 2.22, depth: 2.7e8, periodSeconds: 60,
        desc: '符纸与法袍都从它这里起。制符业景气，它的地里就全是订单。' },
      { id: 'yuehua', name: '月华药圃', code: 'YUEHUA', kind: 'xiuxian', sector: 'herb', link: 'moon_herb',
        business: '月华草等灵草栽培', basePrice: 650, volatility: 0.85, minFactor: 0.42, maxFactor: 2.28, depth: 1.6e8, periodSeconds: 60,
        desc: '丹房的头号供应商。灵草一歉收，下游丹价立刻跳。' },
      { id: 'xuanbing', name: '玄冰谷', code: 'XUANBING', kind: 'xiuxian', sector: 'herb', link: 'frost_lotus',
        business: '玄冰花等寒性灵植', basePrice: 980, volatility: 0.90, minFactor: 0.41, maxFactor: 2.35, depth: 1.05e8, periodSeconds: 60,
        desc: '谷里终年不化雪。寒性灵材九成出自此处，也就九成的定价权。' },
      // ================= 修仙 · 炼丹（4）=================
      { id: 'cuiti', name: '淬体堂', code: 'CUITI', kind: 'xiuxian', sector: 'alchemy', link: 'body_pill',
        business: '淬体丹批量炼制', basePrice: 900, volatility: 0.75, minFactor: 0.46, maxFactor: 2.12, depth: 1.15e8, periodSeconds: 60,
        desc: '最低端的丹，也是销量最大的丹。薄利多销，靠自动化产线活。' },
      { id: 'danxia', name: '丹霞生物', code: 'DANXIA', kind: 'xiuxian', sector: 'alchemy', link: 'heal_pill',
        business: '疗伤丹与常备丹药', basePrice: 1800, volatility: 0.78, minFactor: 0.45, maxFactor: 2.18, depth: 5.8e7, periodSeconds: 60,
        desc: '把炼丹做成工艺的医药巨头。一粒丹的毛利率，够养活整条产业链。' },
      { id: 'xisui', name: '洗髓宗', code: 'XISUI', kind: 'xiuxian', sector: 'alchemy', link: 'marrow_pill',
        business: '洗髓丹与体质改造', basePrice: 3200, volatility: 0.82, minFactor: 0.44, maxFactor: 2.25, depth: 3.2e7, periodSeconds: 60,
        desc: '改资质的丹，卖的是希望。涨价不需要理由，跌价只需要一次事故。' },
      { id: 'jindan', name: '金丹阁', code: 'JINDAN', kind: 'xiuxian', sector: 'alchemy', link: 'golden_pill',
        business: '九转金丹等高端丹药', basePrice: 6800, volatility: 0.95, minFactor: 0.40, maxFactor: 2.45, depth: 1.5e7, periodSeconds: 60,
        desc: '一丹难求。产量以「炉」计，客户以「宗门」计，价格从不明码。' },
      // ================= 修仙 · 制符（3）=================
      { id: 'qingfeng', name: '清风符社', code: 'QINGFENG', kind: 'xiuxian', sector: 'talisman', link: 'wind_talis',
        business: '清风符等日用符箓', basePrice: 750, volatility: 0.76, minFactor: 0.46, maxFactor: 2.14, depth: 1.4e8, periodSeconds: 60,
        desc: '日用符里的日用品。赚的是复购，不是溢价。' },
      { id: 'leifu', name: '雷符门', code: 'LEIFU', kind: 'xiuxian', sector: 'talisman', link: 'thunder_tal',
        business: '雷符与攻伐符箓', basePrice: 4500, volatility: 0.88, minFactor: 0.42, maxFactor: 2.32, depth: 2.3e7, periodSeconds: 60,
        desc: '斗法用的消耗品。宗门摩擦一多，它的库存就见底。' },
      { id: 'tiandun', name: '天遁符宗', code: 'TIANDUN', kind: 'xiuxian', sector: 'talisman', link: 'teleport_tal',
        business: '传送符与空间符阵', basePrice: 8000, volatility: 0.96, minFactor: 0.40, maxFactor: 2.48, depth: 1.3e7, periodSeconds: 60,
        desc: '空间一道，自古独门。会做的人少，敢买的人多。' },
      // ================= 修仙 · 炼器（4）=================
      { id: 'cangfeng', name: '藏锋阁', code: 'CANGFENG', kind: 'xiuxian', sector: 'refine', link: 'magic_sword',
        business: '法剑锻制', basePrice: 2600, volatility: 0.85, minFactor: 0.43, maxFactor: 2.28, depth: 4.0e7, periodSeconds: 60,
        desc: '一名剑修一把剑，藏锋阁供了三成。剑修越多，它越稳。' },
      { id: 'xuanjia', name: '玄甲宗', code: 'XUANJIA', kind: 'xiuxian', sector: 'refine', link: 'armor',
        business: '护甲与防具', basePrice: 5200, volatility: 0.88, minFactor: 0.42, maxFactor: 2.32, depth: 2.0e7, periodSeconds: 60,
        desc: '护具这门生意，跟着「谁在打仗」走。和平年代它就卖农具。' },
      { id: 'feizhou', name: '飞舟坊', code: 'FEIZHOU', kind: 'xiuxian', sector: 'refine', link: 'flying_boat',
        business: '飞舟与载具', basePrice: 12000, volatility: 0.92, minFactor: 0.41, maxFactor: 2.38, depth: 8.6e6, periodSeconds: 60,
        desc: '从货运到远游都靠它。灵脉航线开到哪里，它的订单就到哪。' },
      { id: 'benming', name: '本命斋', code: 'BENMING', kind: 'xiuxian', sector: 'refine', link: 'core_treasure',
        business: '本命法宝温养', basePrice: 35000, volatility: 1.05, minFactor: 0.37, maxFactor: 2.70, depth: 3.0e6, periodSeconds: 60,
        desc: '一人一件，温养百年。客户终身只来一次，客单价高得离谱。' },
      // ================= 修仙 · 阵盘（3）=================
      { id: 'panshi', name: '磐石阵门', code: 'PANSHI', kind: 'xiuxian', sector: 'array', link: 'ward_array',
        business: '防护阵盘', basePrice: 6500, volatility: 0.88, minFactor: 0.42, maxFactor: 2.30, depth: 1.6e7, periodSeconds: 60,
        desc: '护山大阵的承办方。宗门只要还在，它的维护合同就续。' },
      { id: 'huanzhen', name: '幻阵阁', code: 'HUANZHEN', kind: 'xiuxian', sector: 'array', link: 'illusion_arr',
        business: '幻阵与迷阵', basePrice: 18000, volatility: 0.95, minFactor: 0.40, maxFactor: 2.45, depth: 5.8e6, periodSeconds: 60,
        desc: '卖的是「看不穿」。秘境一开，它的阵盘就脱销。' },
      { id: 'zhoutian', name: '周天阵宗', code: 'ZHOUTIAN', kind: 'xiuxian', sector: 'array', link: 'star_array',
        business: '周天星斗大阵', basePrice: 60000, volatility: 1.10, minFactor: 0.36, maxFactor: 2.85, depth: 1.75e6, periodSeconds: 60,
        desc: '一套阵护一宗千年。做不了假的生意，也就没有价格战。' },
      // ================= 修仙 · 洞天（2）=================
      { id: 'lingmai', name: '灵脉能源', code: 'LINGMAI', kind: 'xiuxian', sector: 'cave', link: 'leyline_node',
        business: '灵脉节点与供能', basePrice: 90000, volatility: 0.98, minFactor: 0.39, maxFactor: 2.55, depth: 1.2e6, periodSeconds: 60,
        desc: '握着灵脉的能源寡头。阵盘卖得越好，它的电价越硬 —— 直到有人找到第二条灵脉。' },
      { id: 'taixu', name: '太虚洞天', code: 'TAIXU', kind: 'xiuxian', sector: 'cave', link: 'cave_heaven',
        business: '洞天开凿与小世界营造', basePrice: 200000, volatility: 1.15, minFactor: 0.34, maxFactor: 3.00, depth: 5.4e5, periodSeconds: 60,
        desc: '卖天地的公司。每开出一方洞天，就多一处可以收租的世界。' },
    ],
  },

  // ============================================================
  // 渡劫
  // ============================================================

  /**
   * 渡劫 —— 突破境界的门槛。
   *
   * ------------------------------------------------------------
   * 为什么不许「灵气攒够就自动升级」
   * ------------------------------------------------------------
   * 灵气阈值是一条**纯时间**的曲线：只要挂得够久，境界必然到手。
   * 于是主线是一根匀速上升的直线，没有任何赌注，也就没有故事。
   * 渡劫把「时间到了」换成「要不要现在过」：过了，所有基础加成永久抬一档；
   * 不过，这一世就地作废（被动兵解）。
   *
   * ------------------------------------------------------------
   * 成功率怎么算（全部有上限，堆不出 100%）
   * ------------------------------------------------------------
   *     成功率 = clamp(基础 - 无, +准备, minRate, maxRate)
   *     准备 = 算力冗余 + 功法造诣 + 道行底蕴      （三项各自封顶）
   *
   *   baseRate[境界]   越高越难：凡人 92% → 元婴 70% → 更后的境界一路走低
   *   算力冗余         实际算力每比「本境界基准」高 10 倍 +3%（上限 +15%）
   *                    —— 逼玩家在渡劫前先把算力堆厚，而不是一路裸冲
   *   功法造诣         每本修满（被动常驻）的功法 +2%（上限 +10%）
   *   道行底蕴         累计道行每 2000 点 +1%（上限 +8%）
   *   maxRate 0.95     渡劫永远有风险。设成 100% 等于把整个系统作废。
   *
   * 反过来说：**不会出现「注定失败」**。minRate 0.05 只是兜底，
   * 正常玩到阈值时成功率都在 75% 以上。
   *
   * ------------------------------------------------------------
   * 成功的回报：渡劫淬体（boon）
   * ------------------------------------------------------------
   * 每成功一次 `level + 1`，**永久保留、跨兵解不丢**（它就是转生循环里
   * 「这一世没有白过」的那部分沉淀）。效果键与功法被动**同名同义**，
   * 于是两套加成可以并排相加，不会出现两套互相打架的乘区。
   * 全部层数封顶 maxLevel —— 转生无限循环，没有上限的长线一定失控。
   */
  tribulation: {
    /** 渡劫系统是否已实现 */
    implemented: true,

    /**
     * 默认是否自动渡劫。
     *   开 = 灵气一够就立刻硬闯（挂机党友好，但会在低成功率时翻车）
     *   关 = 攒够后停下来等你点「渡劫」（可以用准备度换成功率）
     * 玩家可在界面上切换，存档里存的是 `s.autoTribulation`。
     */
    autoDefault: true,

    /**
     * 各境界的基础成功率，索引 = 当前境界。
     *
     * 形状刻意的：**前三次几乎不会翻车，元婴之后一路变难。**
     * 元婴以下是「全清」的重罚（见 passiveRules），如果早期就动辄失败，
     * 新玩家会在还没看懂游戏之前被反复抹掉 —— 那不是紧张感，是劝退。
     * 真正的赌注从元婴开始，那也正是主动兵解开放的地方：
     * 玩家此时已经明白「重来一次」是什么代价。
     */
    baseRate: [0.96, 0.94, 0.91, 0.86, 0.78, 0.68, 0.58, 0.50],

    /** 准备度加成（每一项都有独立上限，合计最多 +33%） */
    prepare: {
      /**
       * 算力冗余 —— 每个境界的「基准算力」，实际算力比它每高 10 倍 +3%。
       * 这组数是「该境界玩家手上通常有多少算力」的量级顺序，
       * 与 sim.js 的「投产出力」表对得上（炼气 1e2 / 筑基 1e3 / 金丹 1e5 / 元婴 1e7…）。
       */
      computeBase: [1e2, 1e3, 1e5, 1e7, 1e9, 1e11, 1e13, 1e15],
      computePerDecade: 0.03,
      computeCap: 0.15,
      /** 功法造诣 —— 每本修满（被动常驻）的功法 */
      perfectPer: 0.02,
      perfectCap: 0.10,
      /** 道行底蕴 —— 累计道行 */
      daoPer: 2000,
      daoPerBonus: 0.01,
      daoCap: 0.08,
    },

    /** 成功率下限 / 上限 */
    minRate: 0.05,
    maxRate: 0.95,

    /**
     * 渡劫成功的永久加成（每层）。键名与 `techniques.list[].passive` 完全一致，
     * 但 `qiSpeed` 是渡劫独有的（功法被动没有这一项）。
     *   qiSpeed    灵气吸收速度 —— 直接乘在 qiMultiplier 上
     *   compute    实际算力
     *   money      工作金钱
     *   shenshi    境界基础神识
     *   energyMax  精力上限
     *   stone      灵石产出（设备 + 工作）
     */
    boon: {
      qiSpeed: 0.06,
      compute: 0.05,
      money: 0.05,
      shenshi: 0.04,
      energyMax: 0.04,
      stone: 0.05,
    },

    /** 渡劫淬体的层数上限 */
    maxLevel: 40,

    /**
     * 被动兵解（渡劫失败）的规则。
     *
     * 「元婴」是分水岭 —— 它同时也是主动兵解的门槛：
     *   realm ≥ belowRealm  失败 = 等同主动兵解（保留设备 / 功法 / 履历），道行打三折
     *   realm <  belowRealm 失败 = **再清掉设备与功法**，等于这一世彻底白干
     * 之所以在元婴之下更狠：元婴之前重来一次的代价本来就不大，
     * 而这个阶段的渡劫成功率最高（92%→78%），失败是纯粹的「不该裸冲」惩罚。
     */
    passiveRules: {
      /** 分水岭境界（元婴） */
      belowRealm: 4,
      /** 低于分水岭时，是否连「保留清单」也一并清掉（设备 / 功法） */
      fullWipeBelow: true,
      /** 无论哪种被动兵解，工作履历都保留 —— 否则新手要重跑一整条升职链 */
      keepJobHistory: true,
      /** 无论哪种被动兵解，道行都保留（按 rebirth.passiveDaoRatio 打折） */
      keepDao: true,
    },
  },

  // ============================================================
  // 转生（兵解）
  // ============================================================

  /**
   * 兵解 · 转生 —— 终局循环。
   *
   * 为什么需要它：境界表只到元婴（id 4），元婴的 need 是「从元婴突破所需」的数值，
   * 但没有 id 5。模拟器实测 11.9 小时到元婴，之后进度条恒为 100% —— 主线约 12 小时
   * 通关，公司 / 市场 / 股市这些设计量最大的系统全落在「通关之后的沙盒」里，
   * 缺一个终局目标去驱动它们。转生把「终点」变成「一轮的终点」。
   *
   * 三条设计原则（改动时别破）：
   *   1) 道行收益**只看境界与已兵解次数，不看资产总量** —— 否则玩家会先囤到天量资产
   *      再兵解，把转生变成一次性的暴富操作，而不是一轮轮的节奏循环。
   *   2) 转生折扣必须**随次数回升但封顶** —— 折扣是「第二世爬得更快」的唯一刹车，
   *      没有它就会秒回元婴；封顶则保证长线不会退化成零代价刷新境界。
   *   3) 每一项道行加成**都必须有硬上限** —— 转生是无限循环，没有上限的长线一定失控。
   */
  rebirth: {
    /** 转生系统是否已实现 */
    implemented: true,

    /** 触发门槛：境界（元婴）。元婴以下不开放入口 */
    unlock: { realm: 4 },

    /** 道行基础收益 */
    daoBase: 100,
    /**
     * 每完成一次兵解带来的道行增幅（0.6 = 第 2 次拿 160%）。
     * 刻意不含「资产总量」项 —— 见上方设计原则 1。
     */
    daoPerRun: 0.6,

    /**
     * 转生衰减 —— 兵解后「设备算力」与「设备神识倍率」被压掉几个数量级。
     *
     *     指数 f(0 次)  = 1.00                                ← 还没兵解过，原值
     *     指数 f(n ≥ 1) = min(base + perRun ×(n − 1), cap)
     *     有效值        = 原值 ^ f
     *
     * 为什么用**指数**而不是「乘一个比例」：
     *   本作的算力跨 16 个数量级（1 → 5×10^16），而境界阈值只到 5×10^10。
     *   实测过线性折扣 = 0.35 的效果：一个元婴玩家兵解后 **0.1 秒内就重新突破回元婴** ——
     *   因为 5×10^17 × 0.35 仍然比突破元婴所需的算力高出 6 个数量级。
     *   **线性折扣对跨数量级的数值没有刹车力，必须直接削数量级。**
     *   换成指数 0.50 之后：5×10^17 ^ 0.5 ≈ 7×10^8，落回筑基~金丹期的量级，
     *   重新爬升才有过程可言。
     *
     * base = 0.50：第 1 次兵解后算力被开方，量级直接掉 8~9 档。
     * perRun = 0.03：之后每次转生指数抬高 0.03，越转越快（这是设计意图）。
     * cap = 0.75：封顶 —— 再高就等于没衰减，长线会退化成零代价刷新境界。
     *
     * ⚠️ 「0 次 = 原值」这一条不能省。把 base 当成「任何时刻的衰减指数」，
     * 会让所有没兵解过的玩家一开始算力就被开方 —— 这个坑踩过一次。
     */
    deviceDiscount: { base: 0.5, perRun: 0.03, cap: 0.75 },

    /**
     * 转生后**设备算力的绝对上限**（幂衰减之后再夹一道）。
     *
     *     上限(n) = capBase × 10^(capPerRun ×(n − 1))
     *
     * 为什么幂衰减还不够：实测「开方」之后，一个带满设备的元婴玩家兵解后，
     * 算力仍有 2×10^7 —— 而境界阈值只到 5×10^10，于是**2 秒就重新突破回元婴**。
     * 幂衰减削掉的是相对倍数，但「前世设备越多、绝对值越高」这件事没有被处理。
     *
     * 绝对上限解决的是语义问题：**不管前世多强，这一世都从同一水平线开始。**
     *   capBase = 1e8（约当金丹前期的算力规模）
     *   capPerRun = 0.5（每转生一次放宽半个数量级 —— 「越转越快」体现在这里）
     * 于是：第 1 世 1e8 → 第 5 世 1e10 → 第 10 世 3e12。
     *
     * 取值依据：兵解后还有两道「隐藏产能」要一起考虑 —— 一是功法等级由算力换算
     * （算力 1e8 → 功法约 32 级 → 主属性 ×3.5），二是投向与神识乘区。
     * 实测 capBase = 1e6 时回元婴要十几小时（比第一次还慢），1e8 落在几分钟，
     * 与「第一世十小时、第二世几分钟」的节奏目标相符。
     */
    deviceComputeCapBase: 1e8,
    deviceComputeCapPerRun: 0.5,

    /**
     * 被动兵解（将来「渡劫失败」触发）的道行折扣。
     * 0.3 = 三折 —— 失败仍有收益（兑现「重启有得」），但显著低于主动兵解，
     * 否则玩家会故意去渡劫失败刷道行。
     */
    passiveDaoRatio: 0.3,

    /**
     * 兵解时清空的资产 —— 逐项列清，改口径只动这里，不需要碰核心逻辑。
     *
     * ------------------------------------------------------------
     * 两条清单（改动前先想清楚「这一项属于哪边」）
     * ------------------------------------------------------------
     * 清空（wipe）—— 一切「这一世赚来的资源」：
     *   境界 / 灵气 / 境界进度 / 神识      修仙进度本身
     *   金钱 / 灵石                        硬通货
     *   投向分配 / 投向累计产出            算力投向的配置与统计
     *   AI 加成（aiBonus）/ 已投资算力      这一世攒出来的产能
     *   精力                               回满（不是清空，见 doRebirth 注释）
     *   公司：注册 / 生产线 / 仓库 / 库存 / 抛压 / 全部统计
     *   股市：持仓 / 成本 / 净买入流 / 已实现盈亏 / 手续费与笔数
     *   时间档位                           回到最初一档（日期与行情时钟**不倒流**）
     *   功法熟练度进度                     段位与被动的「已修满」标记保留
     *
     * 保留（keep）—— 永久沉淀：
     *   功法本体 / 段位 / 已常驻被动
     *   设备（但吃转生衰减）
     *   道行与全部道行加成
     *   渡劫淬体层数（tribulation.level）
     *   工作履历（jobDone / totalJobs）—— 否则每世都要重跑升职链
     *   游戏内日期与行情时钟（gameSeconds / playTime）
     *
     * 被动兵解（渡劫失败）在 `realm < tribulation.passiveRules.belowRealm`
     * 时会**额外清掉「保留」里的设备与功法**，见 tribute 段的注释。
     */
    wipe: {
      /** 公司：注册状态 / 生产线 / 仓库等级 / 库存 / 全部累计统计 */
      company: true,
      /** 股市：持仓 / 成本 / 净买入流 / 已实现盈亏 / 手续费与笔数统计 */
      stock: true,
      /** 金钱与灵石 */
      currency: true,
      /** 当前工作与工作进度（工作履历 totalJobs / jobDone 保留，否则升职链要重跑） */
      job: true,
      /** 投向分配与投向累计产出 */
      invest: true,
      /** 本世累积的算力加成（AI 投向逐 tick 累出来的 aiBonus + 已投资算力） */
      computeBonus: true,
      /** 功法熟练度进度（段位与被动常驻标记保留） */
      techniqueProgress: true,
      /** 时间档位回落/游戏内时间是否重置（游戏内时间与行情时钟**永远不会**倒流） */
      timeTier: true,
    },

    /**
     * 被动兵解（渡劫失败）在被清之外**额外清掉**的项。
     * 只有 `realm < tribulation.passiveRules.belowRealm` 且
     * `fullWipeBelow = true` 时生效 —— 元婴以上的失败等同主动兵解。
     */
    passiveExtraWipe: {
      /** 设备：连同转生衰减一起归零 */
      devices: true,
      /** 功法：本体 / 段位 / 被动常驻标记全部清掉 */
      techniques: true,
    },

    /**
     * 道行加成表。
     *   id       唯一标识（存档 perks 的键）
     *   maxLevel 硬上限（转生是无限循环，没有上限的长线一定失控）
     *   cost     首级成本；第 n 级成本 = cost × costGrowth^(n−1)
     *   per      每级效果；unit 仅用于界面文案
     */
    perks: [
      {
        id: 'shenshi', name: '神识根基', maxLevel: 8, cost: 40, costGrowth: 1.8,
        per: 5, unit: '点',
        desc: '每级提升「境界基础神识」+5 —— 直接抬高每一世的起跑线，后续所有神识加成都被它放大。',
      },
      {
        id: 'qiSpeed', name: '灵气亲和', maxLevel: 10, cost: 60, costGrowth: 1.8,
        per: 0.08, unit: '%',
        desc: '每级使灵气吸收速度永久 +8%，加在主循环最核心的环节上。',
      },
      {
        id: 'energyMax', name: '精力淬炼', maxLevel: 5, cost: 50, costGrowth: 1.8,
        per: 0.10, unit: '%',
        desc: '每级提升精力上限 10%。精力是与时间档位解耦的产能硬上限，加它等于直接抬高产出天花板。',
      },
      {
        id: 'offlineRatio', name: '离线延展', maxLevel: 4, cost: 30, costGrowth: 1.8,
        per: 0.05, unit: '',
        desc: '每级把离线收益系数从 0.30 抬高 0.05（最高 0.50）。',
      },
      {
        id: 'offlineHours', name: '离线恒长', maxLevel: 4, cost: 30, costGrowth: 1.8,
        per: 6, unit: '小时',
        desc: '每级把离线收益上限从 48 小时延长 6 小时（最高 72 小时）。',
      },
      {
        id: 'marketFee', name: '市场人脉', maxLevel: 5, cost: 45, costGrowth: 1.8,
        per: 0.0005, unit: '',
        desc: '每级降低股市单边手续费 0.05%（0.50% → 0.25%）。前期本金不足时手续费是硬门槛，这条让它随转生次数变软。',
      },
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
