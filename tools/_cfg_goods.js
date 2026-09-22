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
      { id: 'gather_pill', name: '聚灵丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 3.2e4, volatility: 0.23, minFactor: 0.59, maxFactor: 1.84, periodYears: 10, outputCoef: 1.05, upkeepRate: 0.29 },
      { id: 'heal_pill',   name: '疗伤丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 8.5e4, volatility: 0.24, minFactor: 0.58, maxFactor: 1.86, periodYears: 10, outputCoef: 0.92, upkeepRate: 0.30 },
      { id: 'marrow_pill', name: '洗髓丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 2.2e5, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodYears: 10, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'break_pill',  name: '破境丹',   kind: 'xiuxian', industry: 'alchemy', basePrice: 6.8e5, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodYears: 10, outputCoef: 0.64, upkeepRate: 0.32 },
      { id: 'golden_pill', name: '九转金丹', kind: 'xiuxian', industry: 'alchemy', basePrice: 2.4e6, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodYears: 10, outputCoef: 0.50, upkeepRate: 0.33 },
      // ---- 制符（上游：灵植）----
      { id: 'wind_talis',   name: '清风符', kind: 'xiuxian', industry: 'talisman', basePrice: 9.5e3, volatility: 0.23, minFactor: 0.60, maxFactor: 1.84, periodYears: 10, outputCoef: 1.18, upkeepRate: 0.29 },
      { id: 'fire_talis',   name: '火球符', kind: 'xiuxian', industry: 'talisman', basePrice: 2.4e4, volatility: 0.23, minFactor: 0.59, maxFactor: 1.84, periodYears: 10, outputCoef: 1.06, upkeepRate: 0.29 },
      { id: 'conceal_tal',  name: '敛息符', kind: 'xiuxian', industry: 'talisman', basePrice: 6.5e4, volatility: 0.24, minFactor: 0.58, maxFactor: 1.86, periodYears: 10, outputCoef: 0.92, upkeepRate: 0.30 },
      { id: 'vajra_talis',  name: '金刚符', kind: 'xiuxian', industry: 'talisman', basePrice: 1.7e5, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodYears: 10, outputCoef: 0.78, upkeepRate: 0.31 },
      { id: 'thunder_tal',  name: '雷符',   kind: 'xiuxian', industry: 'talisman', basePrice: 4.6e5, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodYears: 10, outputCoef: 0.64, upkeepRate: 0.32 },
      { id: 'teleport_tal', name: '传送符', kind: 'xiuxian', industry: 'talisman', basePrice: 1.8e6, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodYears: 10, outputCoef: 0.50, upkeepRate: 0.33 },
      // ---- 炼器（上游：冶炼）----
      { id: 'storage_ring',  name: '储物戒',   kind: 'xiuxian', industry: 'refine', basePrice: 5.5e4, volatility: 0.25, minFactor: 0.57, maxFactor: 1.88, periodYears: 10, outputCoef: 1.16, upkeepRate: 0.29 },
      { id: 'magic_sword',   name: '法剑',     kind: 'xiuxian', industry: 'refine', basePrice: 1.6e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 1.02, upkeepRate: 0.30 },
      { id: 'armor',         name: '护甲',     kind: 'xiuxian', industry: 'refine', basePrice: 4.2e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 0.88, upkeepRate: 0.30 },
      { id: 'flying_boat',   name: '飞舟',     kind: 'xiuxian', industry: 'refine', basePrice: 1.4e6, volatility: 0.28, minFactor: 0.54, maxFactor: 1.94, periodYears: 10, outputCoef: 0.72, upkeepRate: 0.31 },
      { id: 'spirit_furnace',name: '灵炉',     kind: 'xiuxian', industry: 'refine', basePrice: 6.5e6, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodYears: 10, outputCoef: 0.58, upkeepRate: 0.32 },
      { id: 'core_treasure', name: '本命法宝', kind: 'xiuxian', industry: 'refine', basePrice: 8.0e7, volatility: 0.34, minFactor: 0.48, maxFactor: 2.08, periodYears: 10, outputCoef: 0.42, upkeepRate: 0.34 },
      // ---- 阵盘（上游：炼器 + 制符）----
      { id: 'ward_array',   name: '防护阵',     kind: 'xiuxian', industry: 'array', basePrice: 6.5e5, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 1.14, upkeepRate: 0.29 },
      { id: 'gather_array', name: '聚灵阵',     kind: 'xiuxian', industry: 'array', basePrice: 1.8e6, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'illusion_arr', name: '幻阵',       kind: 'xiuxian', industry: 'array', basePrice: 5.5e6, volatility: 0.27, minFactor: 0.55, maxFactor: 1.92, periodYears: 10, outputCoef: 0.86, upkeepRate: 0.30 },
      { id: 'kill_array',   name: '杀伐阵',     kind: 'xiuxian', industry: 'array', basePrice: 2.2e7, volatility: 0.29, minFactor: 0.53, maxFactor: 1.96, periodYears: 10, outputCoef: 0.70, upkeepRate: 0.31 },
      { id: 'teleport_arr', name: '传送阵',     kind: 'xiuxian', industry: 'array', basePrice: 1.1e8, volatility: 0.31, minFactor: 0.51, maxFactor: 2.00, periodYears: 10, outputCoef: 0.56, upkeepRate: 0.32 },
      { id: 'star_array',   name: '周天星斗阵', kind: 'xiuxian', industry: 'array', basePrice: 5.0e9, volatility: 0.35, minFactor: 0.47, maxFactor: 2.10, periodYears: 10, outputCoef: 0.40, upkeepRate: 0.34 },
      // ---- 洞天（上游：阵盘 + 炼丹）----
      { id: 'leyline_node', name: '灵脉节点', kind: 'xiuxian', industry: 'cave', basePrice: 2.2e10, volatility: 0.24, minFactor: 0.58, maxFactor: 1.88, periodYears: 10, outputCoef: 1.14, upkeepRate: 0.29 },
      { id: 'cave_heaven',  name: '洞天福地', kind: 'xiuxian', industry: 'cave', basePrice: 8.5e10, volatility: 0.24, minFactor: 0.58, maxFactor: 1.88, periodYears: 10, outputCoef: 1.00, upkeepRate: 0.30 },
      { id: 'void_ship',    name: '太虚舟',   kind: 'xiuxian', industry: 'cave', basePrice: 4.0e11, volatility: 0.26, minFactor: 0.56, maxFactor: 1.90, periodYears: 10, outputCoef: 0.84, upkeepRate: 0.30 },
      { id: 'micro_world',  name: '小千世界', kind: 'xiuxian', industry: 'cave', basePrice: 2.6e12, volatility: 0.28, minFactor: 0.54, maxFactor: 1.94, periodYears: 10, outputCoef: 0.68, upkeepRate: 0.31 },
      { id: 'star_core',    name: '星辰核',   kind: 'xiuxian', industry: 'cave', basePrice: 1.5e13, volatility: 0.30, minFactor: 0.52, maxFactor: 1.98, periodYears: 10, outputCoef: 0.54, upkeepRate: 0.32 },
      { id: 'world_tree',   name: '世界树',   kind: 'xiuxian', industry: 'cave', basePrice: 1.0e14, volatility: 0.33, minFactor: 0.49, maxFactor: 2.04, periodYears: 10, outputCoef: 0.40, upkeepRate: 0.34 },
    ],
