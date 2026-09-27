/**
 * game-core · tick —— 核心 tick：单段推进 stepTick 的固定顺序（不可打乱）+ 总入口的步长切分。离线步长自适应，长离线靠各模块「一次跨多期」能力保持结果一致。
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

  /**
   * tick 内部分段步长（现实秒）。
   * 离线 48 小时一次性结算时，若不分段，「推进工作 → 恢复精力」的交互顺序
   * 会被压成一次近似计算，导致长时间离线的工作份数出现明显偏差。
   * 60 秒一段兼顾精度与性能（48 小时 = 2880 段，纯算术开销可忽略）。
   */
  const STEP_REAL_SECONDS = 60;
  /** 离线结算的步数上限（步长由此反推，见 tick） */
  const OFFLINE_MAX_STEPS = 600;
  // ============================================================
  // 核心 tick
  // ============================================================

  /**
   * 单段推进（内部使用）。dt 为现实秒，已被外层切分。
   * @returns {object} 本段收益
   */
  C.stepTick = function stepTick(s, dt, offline, autoTribulation) {
    const ratio = offline ? C.offlineRatio(s) : 1;
    const speed = C.gameSecondsPerRealSecond(s);
    /** 本段 tick 内是否允许自动渡劫（默认允许；浏览器端会显式关掉） */
    const canTribulate = autoTribulation !== false;

    // 1. 游戏内时间推进
    const dtGame = dt * speed;
    s.gameSeconds += dtGame;

    // 2. 精力恢复（现实时间，与档位无关；**速度随境界提升**，见 energyRegen）
    const maxE = C.maxEnergy(s);
    s.energy = Math.min(maxE, s.energy + dt * C.energyRegen(s));

    // 3. 神识 / 实际算力（每段先刷新，保证后续投向产出用的是最新值）
    s.shenshi = C.totalShenshi(s);
    s.realCompute = C.realComputeOf(s);

    // 4. 功法习得检查（境界/算力/设备条件可能刚刚满足）
    C.learnTechniques(s);

    // 5. 工作推进与结算
    const work = C.advanceWork(s, dtGame);
    const moneyPassive = (1 + C.passiveBonus(s, 'money')) * (1 + C.tribulationBonus(s, 'money'));
    const allOut = 1 + C.passiveBonus(s, 'allOutput');
    /** 灵石产出乘区（渡劫淬体 · 灵石产出） */
    const stoneMul = 1 + C.tribulationBonus(s, 'stone');
    const qiMul = C.qiMultiplier(s);

    if (work.done > 0) {
      s.money = s.money.add(work.money.mul(ratio).mul(moneyPassive).mul(allOut));
      if (qiMul > 0 && work.spirit.gt(0)) s.qi = s.qi.add(work.spirit.mul(ratio).mul(qiMul));
      if (allOut > 0 && work.stone.gt(0)) {
        s.spiritStone = s.spiritStone.add(work.stone.mul(ratio).mul(allOut).mul(stoneMul));
      }
    }

    // 6. 设备被动收益
    const auto = C.autoIncome(s).mul(dt * ratio).mul(allOut);
    s.money = s.money.add(auto);

    // 7. 科技修仙设备的灵石产出
    const stoneOut = C.deviceStoneOutput(s).mul(dt * ratio).mul(allOut).mul(stoneMul);
    if (stoneOut.gt(0)) s.spiritStone = s.spiritStone.add(stoneOut);

    // 8. 算力投向产出
    let qiGain = new D(0);
    let financeGain = new D(0);
    let aiGain = new D(0);

    let techExpFromInvest = 0;
    for (const inv of GAME.investments) {
      const out = C.investOutput(s, inv).mul(dt * ratio);
      if (out.lte(0)) continue;
      s.produced[inv.id] = D.add(s.produced[inv.id], out);

      if (inv.id === 'finance') financeGain = financeGain.add(out);
      else if (inv.id === 'xiuxian') qiGain = qiGain.add(out);
      else if (inv.id === 'ai') aiGain = aiGain.add(out);
      else if (inv.id === 'hardware') {
        // v3.5：hardware 产出累积进议价值 —— 永久压低设备造价。
        // 拉没进度条只停止增长、不清空（见 hardwareCostFactor）。
        s.investedHardware = C.investedHardwareOf(s).add(out);
      } else if (inv.id === 'technique') {
        // v3.5：功法算力投入的产出换算成功法经验（只喂当前修炼的那本）
        techExpFromInvest += out.toNumber() * C.num(C.techExpCfg().expPerInvest, 1);
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
    s.realCompute = C.realComputeOf(s);

    // 9. 市场抛压结算 —— **必须早于公司结算**：跨越期边界时要先把上一期的
    //    净抛售兑换成本期压力，公司这一段的产出与自动卖出才会用到新价格。
    const mkt = C.syncMarket(s);

    // 9b. 公司（产业）结算 —— 按现实秒累积生产周期：扣维护费 → 产出 → 入库/自动卖
    const comp = C.syncCompany(s, dt, offline);

    // 9c. 股市结算 —— 跨越期边界时把上期的净买入流按 flowDecay 衰减。
    //     必须排在公司之后：联动因子会读公司商品的抛压，先让公司那边结算完，
    //     同一段 tick 内看到的才是同一份行情。
    C.syncStocks(s);

    // 10. 功法修炼（涨熟练度）—— 修炼速度受神识加成
    if (s.cultivating && (!offline || GAME.offline.cultivateWhileOffline) && s.technique) {
      const gain = C.cultivateSpeed(s) * dt;
      if (gain > 0) C.addMastery(s, s.technique, gain);
    }

    // 10b. 功法经验（v3.5）—— **不依赖 cultivating 开关**：挂机就涨，
    //      算力越高越快，只喂当前修炼的那本；兵解不清等级。
    //      投向那份已在第 8 步算好（techExpFromInvest），这里补挂机基础。
    if (s.technique) {
      const expGain = C.techBaseExpRate(s) * dt * ratio + techExpFromInvest;
      if (expGain > 0) C.addTechExp(s, s.technique, expGain);
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
      if (C.tribulationCfg().implemented) {
        let guard = 0;
        while (C.tribulationReady(s) && guard < 8) {
          const tr = C.doTribulation(s);
          guard += 1;
          if (!tr.ok || !tr.success) break;
        }
      }
    }

    {
      const target = C.nextRealm(s);
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
  C.tick = function tick(s, dtSeconds, opts) {
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
    // 离线步长自适应：把总步数压在上限内，短时离线（< 上限 × 60 秒）步长不变。
    //
    // 为什么离线可以放大步长：这段 tick 里所有**按周期结算**的模块都支持一次跨多期 ——
    //   · syncCompany：cycleProgress 累加后 while 循环把这一大步里的每个周期都结算掉；
    //   · syncMarket / syncStocks：n = 当前期 − 上次结算期，一次补齐 n 期的衰减与压力；
    //   · 工作 / 精力 / 灵气：都是速率 × dt 的线性累积。
    // 所以放大步长不改变结果，只减少「每步固定开销」被重复的次数 —— 那才是
    // 长离线真正的耗时来源（每步都要扫一遍 288 个商品、100 只股票、几十条产线）。
    const stepMax = offline
      ? Math.max(STEP_REAL_SECONDS, Math.ceil(total / OFFLINE_MAX_STEPS))
      : STEP_REAL_SECONDS;
    let guard = 0;
    while (remain > 0 && guard < 100000) {
      const step = Math.min(remain, stepMax);
      // 渡劫是否允许在这段 tick 内自动触发。
      // 浏览器端传 tribulation:false —— 它把渡劫留给服务端权威操作；
      // 服务端（/api/load 的离线结算、/api/action 的前置推进）保持默认开启。
      const r = C.stepTick(s, step, offline, opts.tribulation !== false);
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


  return C;
});
