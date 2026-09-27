/**
 * game-core · ops —— 玩家操作：买设备、投向分配（归一化 + 快捷份额）、选功法/参悟、注册公司/买线/仓库/卖货、离线预览。服务端 /api/action 与前端本地共用这一层。
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
  // 玩家操作
  // ============================================================

  /** 购买设备（科技修仙设备需要「金钱 + 灵石」双造价） */
  C.buyDevice = function buyDevice(s, deviceId) {
    const dev = GAME.devices.find((d) => d.id === deviceId);
    if (!dev) return { ok: false, msg: '设备不存在' };
    const cost = C.deviceCost(s, dev);
    const stoneCost = C.deviceStoneCost(s, dev);
    if (s.money.lt(cost)) return { ok: false, msg: '金钱不足' };
    if (stoneCost.gt(0) && s.spiritStone.lt(stoneCost)) return { ok: false, msg: '灵石不足' };

    s.money = s.money.sub(cost);
    if (stoneCost.gt(0)) s.spiritStone = s.spiritStone.sub(stoneCost);
    s.devices[deviceId] = (s.devices[deviceId] || 0) + 1;

    // 买到个人电脑会触发放下第一本功法
    C.learnTechniques(s);

    s.shenshi = C.totalShenshi(s);
    s.realCompute = C.realComputeOf(s);
    return {
      ok: true,
      cost: cost,
      stoneCost: stoneCost,
      owned: s.devices[deviceId],
      learned: Object.keys(s.learned),
    };
  }

  /** 设置投资分配；锁定项被忽略，总和超过 1 时按比例归一化 */
  C.setAllocation = function setAllocation(s, alloc) {
    const usable = C.allocatableInvestments(s);

    // 先按传入值过滤，锁定项归 0
    const want = {};
    let sum = 0;
    // 先按传入值过滤，不可用的项归 0。
    //
    // ⚠️ 这里**只看 investmentAvailable，不看 inv.locked** —— locked 只是配置上的
    // 初始标记，真正的可用性由 investmentAvailable 判定（功法增幅要习得功法、
    // 工业产能要成立公司）。早先写成 `inv.locked || !C.investmentAvailable(...)`，
    // 结果锁定项**永远**被过滤：功法习得后「功法增幅」依旧拿不到份额，
    // 那条路线等于白配。
    for (const inv of GAME.investments) {
      if (!C.investmentAvailable(s, inv)) { want[inv.id] = 0; continue; }
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
  C.setTechnique = function setTechnique(s, id) {
    if (!id) return { ok: false, msg: '未指定功法' };
    const tech = C.techById(id);
    if (!tech) return { ok: false, msg: '功法不存在' };
    if (!s.learned[id]) {
      return { ok: false, msg: C.techLockedReason(s, tech) || '尚未习得该功法' };
    }
    s.technique = id;
    s.cultivating = true;
    return { ok: true, technique: id };
  }

  /** 开始 / 停止修炼 */
  C.setCultivating = function setCultivating(s, on) {
    s.cultivating = !!on;
    return { ok: true, cultivating: s.cultivating };
  }

  /**
   * 参悟 —— 消耗灵气，立即获得一笔熟练度（相当于熟练度的「催工」）。
   * 熟练度已至圆满（被动已常驻）时不能再参悟。
   */
  C.comprehend = function comprehend(s, times) {
    if (!GAME.techniques.implemented) return { ok: false, msg: '功法系统未开放' };
    const tech = C.currentTech(s);
    if (!tech) return { ok: false, msg: '尚未习得功法' };
    const rec = s.learned[tech.id];
    if (!rec) return { ok: false, msg: '尚未习得该功法' };
    if (rec.tier >= C.PERFECT_TIER) return { ok: false, msg: '已至圆满，无需再参悟' };

    const n = Math.max(1, Math.min(Math.floor(times || 1), 1000));
    const cost = C.comprehendCost(s);
    let done = 0;
    let gained = 0;
    for (let i = 0; i < n; i++) {
      if (s.qi.lt(cost)) break;
      if (rec.tier >= C.PERFECT_TIER) break;
      s.qi = s.qi.sub(cost);
      const g = C.comprehendGain(rec.tier);
      const res = C.addMastery(s, tech.id, g);
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
  C.previewOffline = function previewOffline(s, seconds, offline) {
    if (offline === undefined) offline = true;
    const capped = offline
      ? Math.min(seconds, C.offlineMaxHours(s) * 3600)
      : seconds;
    const tmp = C.hydrate(C.serialize(s));
    const res = C.tick(tmp, capped, { offline: offline });
    const stk = C.stockSummary(tmp);
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


  return C;
});
