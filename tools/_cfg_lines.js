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
        maxCompute: 1.2e10, baseOutput: 4, cost: 1.2e11, costGrowth: 1.25,
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
