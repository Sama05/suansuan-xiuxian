/**
 * 游戏核心逻辑单元测试
 * 用法: node tests/core.test.js
 */

const D = require('../shared/decimal.js');
const GAME = require('../shared/game-config.js');
const C = require('../shared/game-core.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

// ============================================================
console.log('\n=== 初始状态 ===');
{
  const s = C.createState();
  ok(s.money.eq(GAME.base.startMoney), '初始金钱 = ' + GAME.base.startMoney, s.money.toString());
  ok(s.realm === 0, '初始境界 = 凡人');
  ok(s.realCompute.eq(0), '初始算力 = 0');
  ok(s.spiritStone.eq(0), '初始灵石 = 0');
  ok(Object.keys(s.devices).length === GAME.devices.length, '设备条目齐全');
  ok(s.alloc.xiuxian === 1, '初始全投修仙');
  const sum = Object.values(s.alloc).reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 1) < 1e-12, '初始分配合计 = 1');

  // 新增系统
  ok(s.gameSeconds === 0, '游戏内时间从 0 起算');
  ok(s.timeTier === GAME.time.defaultTier, '起始时间档位 = ' + GAME.time.defaultTier);
  ok(s.autoTier === false, '不再自动跟随档位（时间流速由顶栏四键控制）');
  ok(s.energy === GAME.realms[0].maxEnergy, '初始精力 = 凡人上限', String(s.energy));
  ok(C.jobById(s.jobId) !== null, '默认选中第一份工作');
  ok(s.totalJobs === 0 && s.rushCount === 0, '工作计数从 0 开始');
  ok(s.technique === null, '初始未习得功法');

  // 工作完成次数表齐全
  let allJobs = true;
  for (const j of GAME.jobs) if (s.jobDone[j.id] !== 0) allJobs = false;
  ok(allJobs, '所有工作的完成次数已初始化');
}

// ============================================================
console.log('\n=== 序列化往返 ===');
{
  const s = C.createState();
  s.money = new D(5000);
  C.buyDevice(s, 'pc');
  C.tick(s, 120, { offline: false });
  C.rushJob(s, 2);

  const json = JSON.parse(JSON.stringify(C.serialize(s)));
  const back = C.hydrate(json);

  ok(back.money.eq(s.money), 'money 一致', back.money.toString());
  ok(back.realCompute.eq(s.realCompute), 'realCompute 一致');
  ok(back.aiBonus.eq(s.aiBonus), 'aiBonus 一致');
  ok(back.spiritStone.eq(s.spiritStone), 'spiritStone 一致');
  ok(back.realm === s.realm, 'realm 一致');
  ok(back.devices.pc === s.devices.pc, 'devices 一致');
  ok(Math.abs(back.playTime - s.playTime) < 1e-9, 'playTime 一致');

  // 新字段
  ok(Math.abs(back.gameSeconds - s.gameSeconds) < 1e-6, '游戏内时间可往返',
    back.gameSeconds + ' vs ' + s.gameSeconds);
  ok(back.timeTier === s.timeTier, '时间档位可往返');
  ok(back.autoTier === s.autoTier, '自动档位开关可往返');
  ok(Math.abs(back.energy - s.energy) < 1e-9, '精力可往返');
  ok(back.jobId === s.jobId, '当前工作可往返');
  ok(back.totalJobs === s.totalJobs, '工作总次数可往返');
  ok(back.rushCount === s.rushCount, '催工次数可往返');
  ok(back.jobDone[s.jobId] === s.jobDone[s.jobId], '各工作完成次数可往返');
  ok(back.technique === s.technique, '功法字段可往返');
  ok(back.money.gt(GAME.base.startMoney), '确实有进度');
}

// ============================================================
console.log('\n=== 时间系统 ===');
{
  const s = C.createState();
  const d0 = C.gameDate(0);
  ok(d0.year === 2000 && d0.month === 1 && d0.day === 1, '游戏起点 = 2000年1月1日',
    JSON.stringify(d0));
  ok(C.fmtGameDate(0) === '2000年1月1日 00:00', '起点格式化正确', C.fmtGameDate(0));

  // 档位 1：1 现实秒 = 600 游戏秒
  const speed1 = C.gameSecondsPerRealSecond(s);
  ok(speed1 === 600, '档1 流速 = 600 游戏秒/现实秒', String(speed1));
  C.tick(s, 10, { offline: false });
  ok(Math.abs(s.gameSeconds - 6000) < 1e-6, 'tick 10 秒推进 6000 游戏秒', String(s.gameSeconds));
  ok(C.fmtGameDate(s.gameSeconds) === '2000年1月1日 01:40', '10 分钟后时间正确',
    C.fmtGameDate(s.gameSeconds));

  // 日历换算
  const dMon = C.gameDate(C.SEC_PER_DAY * 30);
  ok(dMon.month === 2 && dMon.day === 1, '30 天 = 1 个月', JSON.stringify(dMon));
  const dYear = C.gameDate(C.SEC_PER_DAY * 360);
  ok(dYear.year === 2001 && dYear.month === 1, '360 天 = 1 年', JSON.stringify(dYear));

  // 档位解锁（档2「常速」从凡人就可 —— 顶栏播放键的基线档位）
  ok(C.maxUnlockedTier(s) === 2, '凡人解锁到档2（常速）', String(C.maxUnlockedTier(s)));
  ok(C.tierUnlocked(s, 2) === true, '档2（常速）凡人即可用');
  ok(C.setTimeTier(s, 2).ok === true, '凡人可切到档2');
  ok(C.maxUnlockedTier(s) === 2, '炼气档位上限不变');
  s.realm = 2;
  ok(C.maxUnlockedTier(s) === 3, '筑基解锁档3');
  s.realm = 3;
  ok(C.maxUnlockedTier(s) === 4, '金丹解锁档4');
  s.realm = 4;
  ok(C.maxUnlockedTier(s) === 4, '元婴仍为档4上限');
  s.realm = 5;
  ok(C.maxUnlockedTier(s) === 5, '化神解锁档5（1 秒 = 1 游戏年）');

  // 档位由玩家手动控制，不再自动跟随（autoTier 已废弃，字段仅为兼容旧存档保留）
  const s2 = C.createState();
  s2.realm = 4;
  C.setTimeTier(s2, 2);
  ok(s2.timeTier === 2, '手动切到档2');
  C.tick(s2, 1, { offline: false });
  ok(s2.timeTier === 2, 'tick 不会自动跳档（时间流速由玩家控制）');
  ok(s2.autoTier === false, '手动切档后关闭自动');
  C.tick(s2, 1, { offline: false });
  ok(s2.timeTier === 2, '关闭自动后 tick 不会自动升档');
  C.setAutoTier(s2, true);
  ok(s2.timeTier === 4 && s2.autoTier === true, '重新开启自动后跟到最高档');

  // 档4 流速
  const s3 = C.createState();
  s3.realm = 4;
  C.setAutoTier(s3, true);
  ok(C.gameSecondsPerRealSecond(s3) === 2592000, '档4 流速 = 2592000 游戏秒/现实秒',
    String(C.gameSecondsPerRealSecond(s3)));

  // 时长格式化：0 必须显示 0（回归：曾显示成「1 分钟」）
  ok(C.fmtGameDuration(0) === '0', '零时长显示为 0', C.fmtGameDuration(0));
  ok(/小时/.test(C.fmtGameDuration(C.SEC_PER_HOUR * 2)), '2 小时显示单位正确');
  ok(/年/.test(C.fmtGameDuration(C.SEC_PER_YEAR * 3)), '3 年显示单位正确');
}

// ============================================================
console.log('\n=== 精力系统 ===');
{
  const s = C.createState();
  ok(C.maxEnergy(s) === 100, '凡人精力上限 100', String(C.maxEnergy(s)));
  s.realm = 4;
  ok(C.maxEnergy(s) === 660, '元婴精力上限 660', String(C.maxEnergy(s)));

  // 恢复速率 1/s（现实时间）
  const s2 = C.createState();
  C.setJob(s2, 'flyer');
  C.setWorking(s2, false);        // 关闭工作，只看恢复
  s2.energy = 0;
  C.tick(s2, 30, { offline: false });
  ok(Math.abs(s2.energy - 30) < 1e-6, '30 秒恢复 30 点', String(s2.energy));

  // 上限封顶
  s2.energy = 95;
  C.tick(s2, 60, { offline: false });
  ok(s2.energy === 100, '恢复不超过上限', String(s2.energy));

  // 精力恢复不受时间档位影响（这是与档位解耦的硬约束）
  const mk = () => {
    const s = C.createState();
    s.realm = 4;
    C.setAutoTier(s, true);       // 档4
    C.setWorking(s, false);
    s.energy = 0;
    return s;
  };
  const a = mk();
  C.tick(a, 60, { offline: false });
  ok(Math.abs(a.energy - 60 * C.energyRegen(a)) < 1e-6,
    '档4 下精力按现实时间恢复（速度随境界 = ' + C.energyRegen(a) + '/秒）',
    String(a.energy));
}

// ============================================================
console.log('\n=== 工作系统 ===');
{
  const s = C.createState();
  const flyer = C.jobById('flyer');
  ok(flyer !== null, '第一份工作存在');
  ok(C.jobDurationSeconds(flyer) === 2 * 3600, '发传单耗时 2 游戏小时',
    String(C.jobDurationSeconds(flyer)));

  // 解锁链：默认只解锁第一份
  ok(C.jobUnlocked(s, flyer), '第一份工作默认解锁');
  ok(!C.jobUnlocked(s, C.jobById('store')), '第二份工作默认未解锁');
  ok(C.lockedReason(s, C.jobById('store')).length > 0, '未解锁有原因说明',
    C.lockedReason(s, C.jobById('store')));
  ok(!C.setJob(s, 'store').ok, '未解锁不能选择');

  // 完成 5 次后解锁第二份
  C.rushJob(s, 5);
  ok(C.jobDoneCount(s, 'flyer') === 5, '催工 5 次计数正确');
  ok(C.jobUnlocked(s, C.jobById('store')), '完成 5 次后解锁便利店');
  ok(C.setJob(s, 'store').ok, '解锁后可选择');

  // 境界门槛
  ok(!C.jobUnlocked(s, C.jobById('driver')), '网约车需炼气且前置次数');
  const s2 = C.createState();
  s2.realm = 1;
  ok(!C.jobUnlocked(s2, C.jobById('driver')), '仅境界够但前置次数不够仍锁定');
  s2.jobDone.delivery = 5;
  ok(C.jobUnlocked(s2, C.jobById('driver')), '境界 + 前置次数都满足才解锁');

  // 自动完成与结算
  const s3 = C.createState();
  const m0 = s3.money;
  const e0 = s3.energy;
  C.tick(s3, 12, { offline: false });   // 档1：12 秒 = 7200 游戏秒 = 2 游戏小时
  ok(C.jobDoneCount(s3, 'flyer') === 1, '自动完成 1 份', String(C.jobDoneCount(s3, 'flyer')));
  ok(s3.money.eq(m0.add(new D(flyer.money))), '金钱按单次收益增加', s3.money.toString());
  // 注意：精力恢复发生在工作之前，且会被上限截断
  const expectEnergy = Math.min(C.maxEnergy(s3), e0 + 12) - flyer.energy;
  ok(Math.abs(s3.energy - expectEnergy) < 1e-6,
    '精力 = min(上限, 初始+恢复) - 消耗', s3.energy + ' vs ' + expectEnergy);

  // 精力不足时进度停在满格等待，不丢进度。
  // 注意：必须用高档位才能造出「精力不够」的场景 —— 低档位下时间才是瓶颈，
  // 等满一份工作的时间里恢复的精力一定超过消耗。
  // 境界用凡人（恢复 1/秒）而档位用档4：精力恢复速度随境界走，与档位无关，
  // 这样 1 秒内只回 1 点、不够一份工作的 6 点。
  const s4 = C.createState();
  s4.realm = 4;
  C.setTimeTier(s4, 4);             // 档4：1 秒 = 1 月
  s4.realm = 0;                     // 恢复速度按凡人 1/秒
  C.setJob(s4, 'flyer');
  s4.energy = 0;
  C.tick(s4, 1, { offline: false });
  ok(C.jobDoneCount(s4, 'flyer') === 0, '精力不足时不结算',
    String(C.jobDoneCount(s4, 'flyer')));
  ok(s4.jobProgress === C.jobDurationSeconds(flyer), '进度停在满格等待',
    String(s4.jobProgress));
  // 精力恢复后自动继续
  C.tick(s4, 10, { offline: false });
  ok(C.jobDoneCount(s4, 'flyer') >= 1, '精力恢复后自动继续工作',
    String(C.jobDoneCount(s4, 'flyer')));

  // 暂停
  const s5 = C.createState();
  C.setWorking(s5, false);
  C.tick(s5, 60, { offline: false });
  ok(C.jobDoneCount(s5, 'flyer') === 0, '暂停后不工作');
  ok(s5.energy === 100, '暂停时精力仍恢复');

  // 催工：立即完成 + 清空进度 + 扣精力
  const s6 = C.createState();
  s6.jobProgress = 3600;                 // 已做了一半
  const beforeMoney = s6.money;
  const r = C.rushJob(s6, 3);
  ok(r.ok && r.done === 3, '催工 3 次成功', String(r.done));
  ok(s6.jobProgress === 0, '催工后进度清零（不与自动结算重复计一份）');
  ok(s6.money.eq(beforeMoney.add(new D(flyer.money * 3))), '催工金钱正确', s6.money.toString());
  ok(s6.rushCount === 3, '催工次数累加');
  ok(s6.energy === 100 - flyer.energy * 3, '催工扣除精力', String(s6.energy));

  // 精力不足时催工失败
  const s7 = C.createState();
  s7.energy = 2;
  ok(!C.rushJob(s7, 1).ok, '精力不足时催工失败');

  // 切工作清空进度
  const s8 = C.createState();
  s8.jobDone.flyer = 5;
  C.setJob(s8, 'flyer');
  s8.jobProgress = 5000;
  C.setJob(s8, 'store');
  ok(s8.jobProgress === 0, '切换工作会清空进度');

  // 收益单调性：越高级的工作，时间效率与精力效率都更高
  let prevHourly = 0, prevEnergy = 0, monoHour = true, monoEnergy = true;
  const speedRef = (() => { const t = C.createState(); t.realm = 4; return C.gameSecondsPerRealSecond(t); })();
  for (const j of GAME.jobs) {
    const hourly = j.money / (j.hours * 3600 / speedRef);   // 金/现实秒（统一按档4）
    const perEnergy = j.money / j.energy;
    if (hourly <= prevHourly) monoHour = false;
    if (perEnergy <= prevEnergy) monoEnergy = false;
    prevHourly = hourly; prevEnergy = perEnergy;
  }
  ok(monoHour, '工作的时间效率逐级递增');
  ok(monoEnergy, '工作的精力效率逐级递增');

  // 耗时逐级递增
  let monoDur = true, prevDur = 0;
  for (const j of GAME.jobs) {
    const d = C.jobDurationSeconds(j);
    if (d <= prevDur) monoDur = false;
    prevDur = d;
  }
  ok(monoDur, '工作的耗时逐级递增');

  // 精力消耗逐级递增
  let monoCost = true, prevCost = 0;
  for (const j of GAME.jobs) {
    if (j.energy <= prevCost) monoCost = false;
    prevCost = j.energy;
  }
  ok(monoCost, '工作的精力消耗逐级递增');

  // 最高级工作消耗不超过元婴精力上限
  const maxJobEnergy = Math.max(...GAME.jobs.map((j) => j.energy));
  ok(maxJobEnergy <= GAME.realms[GAME.realms.length - 1].maxEnergy,
    '最高工作精力消耗 ≤ 元婴上限（否则永远做不了）',
    maxJobEnergy + ' vs ' + GAME.realms[GAME.realms.length - 1].maxEnergy);

  // 后期工作产出灵气与灵石
  const lateJobs = GAME.jobs.filter((j) => j.spirit > 0);
  ok(lateJobs.length > 0, '存在产出灵气的后期工作', String(lateJobs.length) + ' 份');
  ok(lateJobs.every((j) => j.unlock.realm >= 4),
    '灵气工作都在元婴及以上（境界已扩到 8 层，不必都挂最高境）',
    lateJobs.map((j) => j.id + '@r' + j.unlock.realm).join(' '));
  const stoneJobs = GAME.jobs.filter((j) => j.stone > 0);
  ok(stoneJobs.length > 0, '存在产出灵石的后期工作', String(stoneJobs.length) + ' 份');
  ok(stoneJobs.every((j) => j.spirit > 0), '产出灵石的工作同时产出灵气');
}

// ============================================================
console.log('\n=== 功法系统 · 锁定与解锁 ===');
{
  const s = C.createState();
  const techInv = GAME.investments.find((i) => i.id === 'technique');
  ok(techInv !== undefined, '投向中存在「功法增幅」项');
  ok(C.investmentAvailable(s, techInv) === false, '未习得功法时该项不可用');
  ok(C.investOutput(s, techInv).eq(0), '未习得功法时产出为 0');
  ok(C.techniqueUnlocked(s) === false, '未习得功法');

  // 灵气产出开关：用户要求「没有功法之前不允许获得灵气」
  ok(GAME.techniques.requireForSpirit === true, '配置开启了「需功法才产灵气」');
  ok(C.spiritAllowed(s) === false, '未习得功法时不产灵气');
  ok(C.qiMultiplier(s) === 0, '未习得功法时灵气乘区为 0', String(C.qiMultiplier(s)));

  // 分配时被忽略：功法项拿到的份额补给修仙
  s.realCompute = new D(1000);
  s.alloc.xiuxian = 0;
  C.setAllocation(s, { xiuxian: 0, ai: 0, hardware: 0, finance: 0, technique: 1 });
  ok(s.alloc.technique === 0, '功法增幅拿不到份额', String(s.alloc.technique));
  ok(s.alloc.xiuxian === 1, '腾出的份额补给修仙方向', String(s.alloc.xiuxian));

  // 可分配列表不含锁定项
  const usable = C.allocatableInvestments(s);
  ok(usable.every((i) => !i.locked || C.investmentAvailable(s, i)),
    '可分配列表排除未解锁项', String(usable.length) + ' 项');

  // 四路均分不会被功法项稀释
  C.setAllocation(s, { xiuxian: 1, ai: 1, hardware: 1, finance: 1, technique: 1 });
  ok(Math.abs(s.alloc.xiuxian - 0.25) < 1e-9, '均分后修仙 = 25%（未被功法项稀释）',
    String(s.alloc.xiuxian));
}

// ============================================================
console.log('\n=== 功法系统 · 获取与灵气联动 ===');
{
  const s = C.createState();
  ok(C.firstTechUnlocked(s) === false, '没有个人电脑时拿不到第一本功法');
  s.money = new D(1e6);

  // 买下个人电脑 → 自动习得第一本
  const r = C.buyDevice(s, 'pc');
  ok(r.ok === true, '买下个人电脑', r.msg);
  ok(C.firstTechUnlocked(s) === true, '第一本功法条件已满足');
  ok(s.technique === 'jiuzhang', '自动习得并装备第一本功法', String(s.technique));
  ok(Object.keys(s.learned).length === 1, '只习得一本',
    String(Object.keys(s.learned).length));
  ok(C.spiritAllowed(s) === true, '习得功法后开始允许产灵气');
  ok(C.qiMultiplier(s) > 1, '灵气乘区 > 1', String(C.qiMultiplier(s)));
  ok(C.investmentAvailable(s, GAME.investments.find((i) => i.id === 'technique')) === true,
    '习得功法后「功法增幅」解锁');

  // 灵气开始产出
  s.realCompute = new D(100);
  const q0 = s.qi.toNumber();
  C.tick(s, 60, { offline: false });
  ok(s.qi.toNumber() > q0, '灵气开始随时间产出', q0 + ' → ' + s.qi.toNumber());

  // 后续功法按境界自动习得
  ok(s.learned.daishu === undefined, '炼气期功法尚未习得');
  s.realm = 1;
  C.learnTechniques(s);
  ok(s.learned.daishu !== undefined, '炼气后自动习得第二本（代数真解）');

  // 同一时间只能修炼一本
  C.setTechnique(s, 'daishu');
  ok(s.technique === 'daishu', '可以切换到第二本修炼', String(s.technique));
  ok(C.setTechnique(s, 'lianxu').ok === false, '未习得的功法不能修炼');
}

// ============================================================
console.log('\n=== 设备成本增长 ===');
{
  const s = C.createState();
  const dev = GAME.devices[0];
  const c0 = C.deviceCost(s, dev);
  ok(c0.toNumber() === dev.cost, '0 台时价格 = 基准价', c0.toString());

  s.devices[dev.id] = 1;
  const c1 = C.deviceCost(s, dev);
  ok(c1.gt(c0), '买 1 台后更贵', c0.toString() + ' -> ' + c1.toString());
  ok(Math.abs(c1.toNumber() / c0.toNumber() - dev.costGrowth) < 1e-9, '涨幅 = costGrowth');

  s.devices[dev.id] = 10;
  ok(C.deviceCost(s, dev).gt(c1), '买 10 台后更更贵');
}

// ============================================================
console.log('\n=== 算力与设备收益 ===');
{
  const s = C.createState();
  ok(C.totalCompute(s).eq(0), '无设备算力 0');
  ok(C.autoIncome(s).eq(0), '无设备自动收益 0');

  s.devices.pc = 1;
  const c1 = C.totalCompute(s);
  ok(c1.toNumber() === GAME.devices[0].compute, '1 台 PC 算力正确', c1.toString());
  ok(C.autoIncome(s).gt(0), '有设备后自动收益 > 0');

  s.devices.pc = 10;
  ok(C.totalCompute(s).gt(c1), '10 台算力更高');
}

// ============================================================
console.log('\n=== 购买设备 ===');
{
  const s = C.createState();
  const r0 = C.buyDevice(s, 'pc');
  ok(r0.ok === false, '钱不够时购买失败', r0.msg);
  ok(s.devices.pc === 0, '失败后数量不变');

  s.money = new D(1e6);
  const r1 = C.buyDevice(s, 'pc');
  ok(r1.ok === true, '钱够时购买成功');
  ok(s.devices.pc === 1, '数量 +1');
  const before = s.money;
  C.buyDevice(s, 'pc');
  ok(s.money.lt(before), '购买后金钱减少');
  ok(!C.buyDevice(s, 'nope').ok, '不存在的设备购买失败');
}

// ============================================================
console.log('\n=== 分配归一化 ===');
{
  const s = C.createState();
  C.setAllocation(s, { xiuxian: 2, ai: 2, hardware: 0, finance: 0 });
  ok(Math.abs(s.alloc.xiuxian - 0.5) < 1e-9, '超 1 时按比例缩放', String(s.alloc.xiuxian));
  ok(Math.abs(s.alloc.ai - 0.5) < 1e-9, 'ai 同步缩放');

  C.setAllocation(s, { xiuxian: 1, ai: 1, hardware: 1, finance: 1 });
  const sum = Object.values(s.alloc).reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 1) < 1e-9, '四路均分合计 = 1', 'sum=' + sum);

  C.setAllocation(s, { xiuxian: 0, ai: 0, hardware: 0, finance: 0 });
  ok(s.alloc.xiuxian === 1, '全零时回落到全修仙');

  C.setAllocation(s, { xiuxian: 0.3, ai: -5, hardware: 0, finance: 0 });
  ok(s.alloc.ai >= 0, '负数分配被清理为 0');
}

// ============================================================
console.log('\n=== 投资产出（收益递减） ===');
{
  const s = C.createState();
  s.realCompute = new D(1000);
  const xiuxian = GAME.investments.find((i) => i.id === 'xiuxian');

  s.alloc.xiuxian = 1;
  const full = C.investOutput(s, xiuxian);
  ok(full.gt(0), '有算力时有产出', full.toString());

  s.alloc.xiuxian = 0.5;
  const half = C.investOutput(s, xiuxian);
  ok(half.lt(full), '算力减半，产出减少（递减）', half.toString() + ' < ' + full.toString());
  ok(half.gt(full.mul(0.49)), '但不会等比例腰斩（decay<1 的效果）');

  s.alloc.xiuxian = 0;
  ok(C.investOutput(s, xiuxian).eq(0), '分配为 0 时产出 0');
}

// ============================================================
console.log('\n=== 硬件折扣（v3.5 累积制） ===');
{
  const s = C.createState();
  s.realm = 4;
  s.devices.pc = 10;
  const inv = GAME.investments.find((i) => i.id === 'hardware');
  const acc = inv.accum || {};
  const pc = GAME.devices.find((d) => d.id === 'pc');

  // 未累积：无折扣
  ok('未累积时造价系数 = 1', C.hardwareCostFactor(s, pc) === 1);

  // 累积后打折，且拉没份额不清空
  s.alloc.hardware = 1;
  C.tick(s, 120, { offline: false });
  const d1 = C.hardwareCostFactor(s, pc);
  ok('累积后打折（< 1）', d1 < 1, String(d1));
  ok('折扣不超过软上限（造价 ≥ 原价 × (1 - maxRed)）',
    d1 >= 1 - (acc.maxRed || 0.6) - 1e-9, String(d1));
  const X1 = s.investedHardware.toNumber();
  const costAtX1 = C.deviceCost(s, pc).toNumber();
  s.alloc.hardware = 0;
  C.tick(s, 30, { offline: false });
  ok('拉没进度条：累积值保持住', Math.abs(s.investedHardware.toNumber() - X1) < 1e-6,
    X1 + ' → ' + s.investedHardware.toNumber());
  ok('拉没进度条：设备价不变（优惠永久保留）',
    Math.abs(C.deviceCost(s, pc).toNumber() - costAtX1) < 1e-6);

  // 稀释：同样的累积值，贵设备折扣远小于便宜设备
  const big = GAME.devices.reduce((a, b) => (b.cost > a.cost ? b : a));
  ok('跟随设备价格稀释：贵设备折扣小',
    C.hardwareCostFactor(s, big) > C.hardwareCostFactor(s, pc),
    big.id + ' ' + C.hardwareCostFactor(s, big).toFixed(4) + ' vs ' +
    C.hardwareCostFactor(s, pc).toFixed(4));

  // 存档往返
  const back = C.hydrate(C.serialize(s));
  ok('累积议价值随存档往返',
    back.investedHardware.eq(s.investedHardware), back.investedHardware.toString());
}

// ============================================================
console.log('\n=== 境界推进 ===');
{
  const s = C.createState();
  const nr = C.nextRealm(s);
  ok(nr.next && nr.next.name === '炼气', '凡人下一境 = 炼气');
  ok(nr.need.eq(GAME.realms[0].need), '突破需求 = realms[0].need', nr.need.toString());

  s.spiritStone = new D(GAME.realms[0].need).sub(1);
  s.alloc.xiuxian = 0;
  C.tick(s, 1, { offline: false });
  ok(s.realm === 0, '灵气不足不突破');

  s.qi = new D(GAME.realms[0].need);
  s.realCompute = new D(0);
  C.tick(s, 1, { offline: false });
  ok(s.realm === 1, '灵气足够突破到炼气', 'realm=' + s.realm);
  ok(s.qi.lt(new D(GAME.realms[0].need)), '突破消耗灵气');

  const s2 = C.createState();
  s2.alloc.xiuxian = 0;
  s2.realCompute = new D(0);
  s2.qi = new D(GAME.realms[0].need + GAME.realms[1].need + GAME.realms[2].need);
  C.tick(s2, 1, { offline: false });
  ok(s2.realm === 3, '一次 tick 可连跳多级', 'realm=' + s2.realm);

  const s3 = C.createState();
  s3.realm = GAME.realms.length - 1;
  const nr3 = C.nextRealm(s3);
  ok(nr3.next === null, '最高境界无下一境');
  ok(nr3.need === null, '最高境界无需求');
  s3.spiritStone = new D(1e20);
  C.tick(s3, 1, { offline: false });
  ok(s3.realm === GAME.realms.length - 1, '最高境界不再突破');
}

// ============================================================
console.log('\n=== tick 时间处理 ===');
{
  const s = C.createState();
  s.devices.pc = 1;
  C.setWorking(s, false);
  const m0 = s.money;
  C.tick(s, 10, { offline: false });
  ok(s.money.gt(m0), '10 秒有收益');
  ok(Math.abs(s.playTime - 10) < 1e-9, 'playTime +10');

  const before = s.money;
  C.tick(s, 0, { offline: false });
  ok(s.money.eq(before), '0 秒无变化');
  C.tick(s, -100, { offline: false });
  ok(s.money.eq(before), '负时间无变化');

  const s2 = C.createState();
  s2.devices.pc = 1;
  C.tick(s2, 1e9, { offline: false });
  ok(s2.playTime <= GAME.save.maxTickSeconds + 1e-9,
    '单次 tick 时长被截断到 maxTickSeconds', String(s2.playTime));
}

// ============================================================
console.log('\n=== 离线结算 ===');
{
  // 收益按 ratio 折算
  const mk = () => {
    const s = C.createState();
    s.devices.pc = 1;
    C.setJob(s, 'flyer');
    return s;
  };
  const a = mk(), b = mk();
  C.tick(a, 100, { offline: false });
  C.tick(b, 100, { offline: true });
  const gainA = a.money.sub(GAME.base.startMoney).toNumber();
  const gainB = b.money.sub(GAME.base.startMoney).toNumber();
  ok(Math.abs(gainB / gainA - GAME.offline.ratio) < 1e-6,
    '离线收益 = 在线 × ' + GAME.offline.ratio, (gainB / gainA).toFixed(6));

  // 离线结算不再被 maxTickSeconds 截断（回归：曾把 48 小时砍成 1 小时）
  const s2 = mk();
  const prev = C.previewOffline(s2, 48 * 3600, true);
  ok(prev.seconds === 48 * 3600, '48 小时不被截断', String(prev.seconds));
  ok(prev.cappedOut === false, '刚好封顶不算超限');
  const over = C.previewOffline(s2, 100 * 3600, true);
  ok(over.seconds === GAME.offline.maxHours * 3600, '超长离线封顶到 48 小时',
    String(over.seconds));
  ok(over.cappedOut === true, '标记为已封顶');

  // 分段推进精度：一次性结算与分段结算结果应接近
  const x = mk(), y = mk();
  C.tick(x, 1000, { offline: false });
  for (let i = 0; i < 1000; i++) C.tick(y, 1, { offline: false });
  const dx = x.money.toNumber(), dy = y.money.toNumber();
  ok(Math.abs(dx - dy) / Math.max(1, dy) < 0.02,
    '长时间一次结算与逐秒结算误差 < 2%', dx.toFixed(2) + ' vs ' + dy.toFixed(2));

  // 预览不修改原状态
  const z = mk();
  const zBefore = z.money.toString();
  C.previewOffline(z, 3600, true);
  ok(z.money.toString() === zBefore, 'previewOffline 不修改原状态');
}

// ============================================================
console.log('\n=== AI 加成 ===');
{
  const mk = () => {
    const s = C.createState();
    s.devices.datacenter = 10;      // 10 * 4e5 = 4e6 算力
    s.alloc.ai = 1;
    return s;
  };

  const s = mk();
  const baseCompute = C.totalCompute(s);
  ok(baseCompute.gt(0), '测试状态有算力基底', baseCompute.toString());

  const before = s.aiBonus;
  C.tick(s, 10, { offline: false });
  ok(s.aiBonus.gt(before), 'AI 方向累积算力加成', s.aiBonus.toString());
  ok(s.realCompute.gt(baseCompute), 'realCompute 含 AI 加成', s.realCompute.toString());

  const acc1 = s.aiBonus;
  C.tick(s, 10, { offline: false });
  ok(s.aiBonus.gt(acc1), 'AI 加成跨 tick 持续累积（回归）',
    acc1.toString() + ' -> ' + s.aiBonus.toString());

  const out = C.investOutput(s, GAME.investments.find((i) => i.id === 'ai'));
  ok(out.gt(0), 'AI 加成反哺 AI 自身产出', out.toString());

  const back = C.hydrate(JSON.parse(JSON.stringify(C.serialize(s))));
  ok(back.aiBonus.eq(s.aiBonus), 'AI 加成可存档往返');
  ok(back.realCompute.eq(s.realCompute), '含加成的算力可存档往返');

  const s2 = C.createState();
  s2.devices.datacenter = 10;
  s2.alloc.ai = 0;
  C.tick(s2, 10, { offline: false });
  ok(s2.aiBonus.eq(0), '不投 AI 则无加成');
}

// ============================================================
console.log('\n=== 边界：超大数值 ===');
{
  const s = C.createState();
  s.money = D.fromString('1e300');
  C.setWorking(s, false);
  C.tick(s, 3600, { offline: false });
  ok(s.money.isFinite(), '极大金钱 tick 后仍有限');
  ok(!s.money.eq(0), '极大金钱未被清零');

  const s1 = C.createState();
  s1.money = D.fromString('1e20');
  C.setWorking(s1, false);
  const m0 = s1.money;
  s1.devices.megacenter = 1000;
  C.tick(s1, 3600, { offline: false });
  ok(s1.money.gt(m0), '同量级时极大金钱正常增长', m0.toString() + ' -> ' + s1.money.toString());

  s.spiritStone = D.fromString('1e500');
  C.tick(s, 1, { offline: false });
  ok(s.spiritStone.isFinite(), '超大灵石不产生 NaN/Infinity');

  const huge = D.fromString('9.99e307');
  ok(D.mul(huge, new D(100)).isFinite(), '超大数乘法不产生 Infinity 内部值');
  ok(D.fromString('1e500').isFinite(), '1e500 可表示且有限');
}

// ============================================================
console.log('\n=== 公司系统 · 配置自洽 ===');
{
  const cfg = GAME.company;
  ok(cfg && cfg.implemented === true, '公司系统标记为已实现');
  ok(!!cfg.unlock && cfg.unlock.realm === 1, '注册门槛境界 = 炼气');
  ok(cfg.foundCost > 0, '注册费为正数', String(cfg.foundCost));
  ok(cfg.cycleRealSeconds > 0, '生产周期为正数', String(cfg.cycleRealSeconds));
  ok(cfg.goods.length >= 6, '商品表至少 6 种', String(cfg.goods.length));
  ok(cfg.lines.length >= 6, '生产线表至少 6 条', String(cfg.lines.length));

  // ---------- 行业（上下游与成本传导）----------
  ok(cfg.industries.length >= 6, '行业表至少 6 个', String(cfg.industries.length));
  const indIds = new Set(cfg.industries.map((x) => x.id));
  ok(indIds.size === cfg.industries.length, '行业 id 不重复');

  // 上游必须存在、且处在更低的层级 —— 否则传导会成环，tick 里会栈溢出
  let noCycle = true;
  for (const ind of cfg.industries) {
    for (const u of (ind.upstream || [])) {
      const up = C.industryById(u);
      if (!up) noCycle = false;
      else if (up.tier >= ind.tier) noCycle = false;
    }
  }
  ok(noCycle, '上游行业都存在且层级更低（传导图无环）');

  // 成本传导必须 ≥ 售价传导，否则上游涨价反而让下游更赚，与「成本传导」的意图相反
  let passOk = true;
  for (const ind of cfg.industries) {
    if (!((ind.passThrough || 0) >= (ind.pricePass || 0))) passOk = false;
  }
  ok(passOk, '每个行业的成本传导 ≥ 售价传导（上游涨价会压缩下游毛利）');

  // 每行业至少 6 种产物
  let sixOk = true;
  const perInd = [];
  for (const ind of cfg.industries) {
    const n = C.goodsOfIndustry(ind.id).length;
    perInd.push(ind.name + ':' + n);
    if (n < 6) sixOk = false;
  }
  ok(sixOk, '每个行业至少 6 种产物', perInd.join(' '));

  // ---------- 商品 ----------
  const gids = new Set(cfg.goods.map((g) => g.id));
  ok(gids.size === cfg.goods.length, '商品 id 不重复');
  const lids = new Set(cfg.lines.map((l) => l.id));
  ok(lids.size === cfg.lines.length, '生产线 id 不重复');

  let indOk = true;
  for (const g of cfg.goods) if (!C.industryById(g.industry)) indOk = false;
  ok(indOk, '每件产物都归属于存在的行业');

  const techGoods = cfg.goods.filter((g) => g.kind === 'tech');
  const xiuGoods = cfg.goods.filter((g) => g.kind === 'xiuxian');
  ok(techGoods.length > 0 && xiuGoods.length > 0, '科技类与修仙类商品都存在');
  // 变价周期按**现实秒**计（与时间档位解耦）：科技类 60 秒，修仙类 600 秒
  ok(techGoods.every((g) => g.periodSeconds === 60), '科技类商品 60 秒变价');
  ok(xiuGoods.every((g) => g.periodSeconds === 600), '修仙类商品 600 秒变价');

  // 行业内：价值递增、产量系数递减（越贵造得越慢 ——「堆产量」与「堆单价」两种打法）
  let ascOk = true, coefOk = true;
  for (const ind of cfg.industries) {
    const list = C.goodsOfIndustry(ind.id);
    for (let i = 1; i < list.length; i++) {
      if (!(list[i].basePrice > list[i - 1].basePrice)) ascOk = false;
      if (!(list[i].outputCoef < list[i - 1].outputCoef)) coefOk = false;
    }
  }
  ok(ascOk, '每个行业内产物价值递增');
  ok(coefOk, '每个行业内越贵的产物造得越慢（outputCoef 递减）');

  // 维护费率：净收益率约 70%
  let rateOk = true;
  for (const g of cfg.goods) if (!(g.upkeepRate > 0.25 && g.upkeepRate < 0.35)) rateOk = false;
  ok(rateOk, '每件产物的维护费率 ≈ 30%（净收益率约 70%）');

  // ---------- 生产线 ----------
  // 一条线不再绑定单一产物，而是绑定一个行业 —— 能造这个行业的全部产物
  let lineOk = true;
  for (const line of cfg.lines) {
    if (!C.industryById(line.industry)) lineOk = false;
    else if (!C.lineProducts(line).length) lineOk = false;
    else if (!(line.maxCompute > 0) || !(line.baseOutput > 0)) lineOk = false;
  }
  ok(lineOk, '每条生产线都挂在有产物的行业上，且算力上限 / 基准产量为正');

  // 解锁链：至少一条无前置，其余都有有效前置
  const noAfter = cfg.lines.filter((l) => !l.after);
  ok(noAfter.length >= 1, '至少一条生产线无前置', String(noAfter.length));
  let chained = true;
  for (const l of cfg.lines) {
    if (!l.after) continue;
    if (!C.lineById(l.after.id) || !(l.after.times > 0)) chained = false;
  }
  ok(chained, '其余生产线都有有效的前置条件');

  // 单位算力产值随产业链层级递增 —— 高级线更划算，但造价与解锁门槛同步抬升。
  // 用「每层取最小值」比较，允许同层内科技线与修仙线互有高低。
  const geo = (list) => {
    let s = 0;
    for (const g of list) s += Math.log10(g.basePrice);
    return Math.pow(10, s / list.length);
  };
  const byTier = {};
  for (const l of cfg.lines) {
    const t = C.industryById(l.industry).tier;
    const v = (l.baseOutput * geo(C.lineProducts(l))) / l.maxCompute;
    if (byTier[t] === undefined || v < byTier[t]) byTier[t] = v;
  }
  const tiers = Object.keys(byTier).map(Number).sort((a, b) => a - b);
  let tierOk = true;
  const tierVals = [];
  for (const t of tiers) tierVals.push(t + '层' + byTier[t].toFixed(2));
  for (let i = 1; i < tiers.length; i++) {
    if (!(byTier[tiers[i]] > byTier[tiers[i - 1]])) tierOk = false;
  }
  ok(tierOk, '越下游的行业单位算力产值越高', tierVals.join(' < '));
}

// ============================================================
console.log('\n=== 公司系统 · 注册门槛 ===');
{
  const s = C.createState();                 // realm 0, money 20
  ok(!C.companyFounded(s), '初始未成立公司');
  ok(!C.companyUnlocked(s), '凡人不能注册公司');
  ok(C.companyLockedReason(s).indexOf('炼气') >= 0, '未达境界时给出原因',
    C.companyLockedReason(s));

  const r0 = C.foundCompany(s);
  ok(r0.ok === false, '境界不足时注册被拒', r0.msg);
  ok(!C.companyFounded(s), '注册失败后仍为未成立');

  s.realm = 1;                               // 炼气
  ok(C.companyUnlocked(s), '炼气后可注册公司');
  ok(C.companyLockedReason(s).indexOf('金钱') >= 0, '钱不够时给出金钱原因',
    C.companyLockedReason(s));

  const r1 = C.foundCompany(s);
  ok(r1.ok === false, '金钱不足时注册被拒', r1.msg);
  ok(!C.companyFounded(s), '金钱不足后仍为未成立');

  s.money = new D(1e5);
  const before = s.money;
  const r2 = C.foundCompany(s);
  ok(r2.ok === true, '条件满足时注册成功', r2.msg);
  ok(C.companyFounded(s), '注册后标记为已成立');
  ok(s.money.eq(before.sub(new D(GAME.company.foundCost))), '注册扣除注册费',
    before.toString() + ' -> ' + s.money.toString());
  ok(typeof s.company.foundedDay === 'number' && s.company.foundedDay === C.gameDate(s.playTime).days,
    '成立日期 = 当日游戏日', String(s.company.foundedDay));
  ok(s.company.foundedDay === 0, '开局当天成立 → 第 0 天');
  ok(C.companyLockedReason(s) === '', '成立后无锁定原因');

  const r3 = C.foundCompany(s);
  ok(r3.ok === false, '重复注册被拒', r3.msg);

  // 开局之后再成立 → 成立日期为正
  const late = C.createState();
  late.realm = 1;
  late.money = new D(1e5);
  late.gameSeconds = C.SEC_PER_YEAR;          // 一年后
  C.foundCompany(late);
  ok(late.company.foundedDay === C.gameDate(late.gameSeconds).days,
    '延后成立记录正确日期', String(late.company.foundedDay));
  ok(late.company.foundedDay > 0, '延后成立日期为正', String(late.company.foundedDay));

  // 刚成立、还没买生产线时，公司自身状态是完整的
  ok(C.stockTotal(s) === 0, '新公司仓库为空');
  ok(s.company.autoSell === true, '默认开启自动卖出');
  ok(s.company.cycles === 0, '周期计数从 0 起算');
}

// ============================================================
console.log('\n=== 公司系统 · 生产线与解锁链 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e7);
  C.foundCompany(s);

  ok(C.lineOwned(s, 'mine') === 0, '初始没有生产线');
  ok(Object.keys(C.companyOutputPerCycle(s)).length === 0, '没有生产线时不产出');
  ok(C.companyUpkeep(s).total.eq(0), '没有生产线时无维护费');
  ok(C.companyCycleGross(s).eq(0), '没有生产线时毛产值为 0');
  ok(C.companyIncomePerSecond(s).eq(0), '没有生产线时无收益');

  ok(C.lineUnlocked(s, C.lineById('mine')), '矿井可直接购买');
  ok(!C.lineUnlocked(s, C.lineById('smelter')), '炼钢厂需要前置');
  ok(C.lineLockedReason(s, C.lineById('smelter')).indexOf('矿井') >= 0,
    '前置不足时给出原因', C.lineLockedReason(s, C.lineById('smelter')));

  const bad = C.buyLine(s, 'smelter');
  ok(bad.ok === false, '前置不足时不能购买', bad.msg);
  const nope = C.buyLine(s, 'not-a-line');
  ok(nope.ok === false, '不存在的生产线购买失败', nope.msg);

  const c0 = C.lineCost(s, C.lineById('mine'));
  ok(c0.eq(new D(GAME.company.lines[0].cost)), '第一条按基准价', c0.toString());

  const b1 = C.buyLine(s, 'mine');
  ok(b1.ok === true, '购买矿井成功', b1.msg);
  ok(C.lineOwned(s, 'mine') === 1, '数量 +1');
  ok(b1.cost.eq(new D(GAME.company.lines[0].cost)), '首次价格 = 基准价', b1.cost.toString());

  const c1 = C.lineCost(s, C.lineById('mine'));
  ok(c1.gt(c0), '第二条更贵', c0.toString() + ' -> ' + c1.toString());
  const growth = c1.div(c0).toNumber();
  ok(growth > 1.17 && growth < 1.19, '涨幅 = costGrowth', String(growth));

  // 买够 5 条解锁炼钢厂
  for (let i = 0; i < 4; i++) C.buyLine(s, 'mine');
  ok(C.lineOwned(s, 'mine') === 5, '累计 5 条矿井');
  ok(C.lineUnlocked(s, C.lineById('smelter')), '5 条后解锁炼钢厂');
  ok(C.lineLockedReason(s, C.lineById('smelter')) === '', '解锁后无锁定原因');

  // 境界不够的生产线
  ok(!C.lineUnlocked(s, C.lineById('precision')), '精密制造厂需筑基');
  ok(C.lineLockedReason(s, C.lineById('precision')).indexOf('筑基') >= 0,
    '境界不足时给出境界原因', C.lineLockedReason(s, C.lineById('precision')));

  // 钱不够
  const poor = C.createState();
  poor.realm = 1;
  poor.money = new D(6e4);                   // 注册后只剩 1e4
  C.foundCompany(poor);
  const poorBuy = C.buyLine(poor, 'mine');
  ok(poorBuy.ok === false, '钱不够时购买失败', poorBuy.msg);
  ok(C.lineOwned(poor, 'mine') === 0, '失败后数量不变');

  // 未成立公司
  const raw = C.createState();
  raw.realm = 1;
  raw.money = new D(1e7);
  ok(!C.lineUnlocked(raw, C.lineById('mine')), '未成立公司时生产线未解锁');
  ok(C.buyLine(raw, 'mine').ok === false, '未成立公司时购买被拒');
  ok(!C.lineUnlocked(raw, null), '空生产线不视为解锁');
  ok(C.lineLockedReason(raw, C.lineById('mine')) === '尚未成立公司',
    '未成立时给出原因', C.lineLockedReason(raw, C.lineById('mine')));

  // 整条产业链：买齐前置就能一路买到洞天（需境界 4）
  const full = C.createState();
  full.realm = 4;
  full.money = D.fromString('1e15');
  C.foundCompany(full);

  const chain = [
    ['mine', 5], ['smelter', 5], ['precision', 5],
    ['chemplant', 5], ['elecplant', 5], ['assembly', 5],
    ['herbfield', 5], ['talismanry', 5], ['alchemy', 5],
    ['refine', 5], ['arrayforge', 5], ['cave', 5],
  ];
  let chainOk = true;
  const chainLog = [];
  for (const step of chain) {
    const id = step[0];
    const line = C.lineById(id);
    if (!C.lineUnlocked(full, line)) {
      chainOk = false;
      chainLog.push(id + '未解锁(' + C.lineLockedReason(full, line) + ')');
      continue;
    }
    for (let i = 0; i < step[1]; i++) {
      const r = C.buyLine(full, id);
      if (!r.ok) { chainOk = false; chainLog.push(id + '购买失败(' + r.msg + ')'); break; }
    }
    chainLog.push(id + '×' + C.lineOwned(full, id));
  }
  ok(chainOk, '整条产业链可以一路买到洞天', chainLog.join(' '));

  // ---- 买线 ≠ 开工：转起来要靠「工业产能」投向拨的算力 ----
  full.realCompute = new D(1e16);
  const sumOut = (o) => Object.keys(o).reduce((n, k) => n + o[k], 0);

  C.setAllocation(full, { industry: 0 });
  ok(Object.keys(C.companyOutputPerCycle(full)).length === 0,
    '工业算力为 0 时一台都转不起来');
  ok(C.companyUpkeep(full).total.eq(0), '没有产出就不收维护费');
  ok(C.companyComputeScale(full) === 0, '需求 > 供给且供给为 0 时削减系数为 0');

  C.setAllocation(full, { industry: 1 });
  const outFull = sumOut(C.companyOutputPerCycle(full));
  ok(outFull > 0, '拨足算力后开始产出', String(outFull));
  ok(C.companyComputeScale(full) === 1, '算力充足时削减系数为 1（不打折）');
  ok(C.companyUpkeep(full).total.gt(0), '有产出就有维护费');
  ok(C.companyCycleNet(full).gt(0), '全开净收益为正');

  // 产能减半 → 产量减半（算力充足时产量与产能成正比）
  for (const step of chain) C.setLineUnit(full, step[0], 'all', { rate: 0.5 });
  const outHalf = sumOut(C.companyOutputPerCycle(full));
  ok(Math.abs(outHalf / outFull - 0.5) < 1e-9, '产能减半 → 产量减半',
    outFull.toFixed(3) + ' → ' + outHalf.toFixed(3));

  // 算力砍半 → 产量也砍半（供不应求时统一按比例削减，不是先到先得）
  for (const step of chain) C.setLineUnit(full, step[0], 'all', { rate: 1 });
  full.realCompute = new D(7.5e10);          // < 总需求 1.5e11
  const sc = C.companyComputeScale(full);
  ok(sc > 0 && sc < 1, '算力不足时削减系数落在 (0,1)', sc.toFixed(4));
  const outStarved = sumOut(C.companyOutputPerCycle(full));
  ok(Math.abs(outStarved / outFull - sc) < 1e-6, '削减系数直接乘在产量上',
    outFull.toFixed(2) + ' × ' + sc.toFixed(4) + ' = ' + outStarved.toFixed(2));

  // ---- 每台独立配置：同一条线可以各产各的 ----
  const m = C.createState();
  m.realm = 1;
  m.money = new D(1e7);
  C.foundCompany(m);
  for (let i = 0; i < 3; i++) C.buyLine(m, 'mine');
  ok(C.lineOwned(m, 'mine') === 3, '买了 3 台矿井');
  ok(C.lineUnits(m, 'mine').every((u) => u.r === 1), '新买的台默认满产能');

  C.setLineUnit(m, 'mine', 0, { product: 'iron_ore', rate: 1 });
  C.setLineUnit(m, 'mine', 1, { product: 'coal', rate: 0.5 });
  C.setLineUnit(m, 'mine', 2, { product: 'rare_earth', rate: 0 });
  const us = C.lineUnits(m, 'mine');
  ok(us[0].p === 'iron_ore' && us[1].p === 'coal' && us[2].p === 'rare_earth',
    '三台可以各产各的', JSON.stringify(us));
  ok(!C.unitActive(us[2]), '产能 0 的那台视为停机');

  m.realCompute = new D(1e9);
  C.setAllocation(m, { industry: 1 });
  const mo = C.companyOutputPerCycle(m);
  ok((mo.iron_ore || 0) > 0 && (mo.coal || 0) > 0, '两台在产的都有产出', JSON.stringify(mo));
  ok(!mo.rare_earth, '停机的那台不产出');

  // 越界的配置被拒
  ok(C.setLineUnit(m, 'mine', 0, { product: 'chip' }).ok === false, '不能产别的行业的东西');
  ok(C.setLineUnit(m, 'mine', 0, { rate: 5 }).ok === true, '产能超 1 会被夹到 1');
  ok(C.lineUnits(m, 'mine')[0].r === 1, '夹取后产能 = 1', String(C.lineUnits(m, 'mine')[0].r));
  ok(C.setLineUnit(m, 'mine', 99, { rate: 0.5 }).ok === false, '不存在的台号被拒');
  const none = C.createState();
  none.realm = 1;
  C.foundCompany(none);
  ok(C.setLineUnit(none, 'mine', 0, { rate: 1 }).ok === false, '没买过这条线时设置被拒');
  ok(C.companyCycleNet(full).gt(0), '全开净收益为正');
}

// ============================================================
console.log('\n=== 公司系统 · 仓库 ===');
{
  const raw = C.createState();
  raw.realm = 1;
  raw.money = new D(1e7);
  const r = C.upgradeWarehouse(raw);
  ok(r.ok === false, '未成立公司时不能升级仓库', r.msg);

  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e7);
  C.foundCompany(s);

  const w = GAME.company.warehouse;
  ok(C.warehouseLevel(s) === 0, '初始仓库等级 0');
  ok(C.warehouseCapacity(s) === w.baseCapacity, '初始容量 = 基础容量',
    String(C.warehouseCapacity(s)));
  ok(C.warehouseCost(s).eq(new D(w.baseCost)), '首次升级价 = baseCost',
    C.warehouseCost(s).toString());

  const before = s.money;
  const u1 = C.upgradeWarehouse(s);
  ok(u1.ok === true, '升级仓库成功', u1.msg);
  ok(C.warehouseLevel(s) === 1, '等级 +1');
  ok(C.warehouseCapacity(s) === w.baseCapacity + w.perLevel, '容量按级增加',
    String(C.warehouseCapacity(s)));
  ok(s.money.eq(before.sub(new D(w.baseCost))), '升级扣钱');

  const c1 = C.warehouseCost(s).div(new D(w.baseCost)).toNumber();
  ok(c1 > 1.5 && c1 < 1.6, '升级价格按 costGrowth 上涨', String(c1));

  // 满级
  s.company.warehouseLevel = w.maxLevel;
  ok(C.warehouseLevel(s) === w.maxLevel, '仓库可到最高等级');
  ok(C.warehouseCapacity(s) === w.baseCapacity + w.maxLevel * w.perLevel, '满级容量正确',
    String(C.warehouseCapacity(s)));
  ok(C.warehouseCost(s).eq(0), '满级后升级价为 0');
  const uMax = C.upgradeWarehouse(s);
  ok(uMax.ok === false, '满级后不能继续升级', uMax.msg);

  // 超出上限的等级被夹紧
  s.company.warehouseLevel = w.maxLevel + 99;
  ok(C.warehouseCapacity(s) === w.baseCapacity + w.maxLevel * w.perLevel,
    '超出上限的等级被夹紧', String(C.warehouseCapacity(s)));

  // 钱不够
  const poor = C.createState();
  poor.realm = 1;
  poor.money = new D(1e5);
  C.foundCompany(poor);                      // 剩 5e4 < 2e5
  ok(C.upgradeWarehouse(poor).ok === false, '钱不够时不能升级仓库');
}

// ============================================================
console.log('\n=== 公司系统 · 周期结算 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e6);
  C.setWorking(s, false);                    // 排除工作收益干扰
  C.foundCompany(s);
  C.buyLine(s, 'mine');
  // 买线只拿到产能上限，转起来要靠「工业产能」投向拨的算力
  s.realCompute = new D(1e6);
  C.setAllocation(s, { industry: 1 });

  const line = C.lineById('mine');
  const g = C.goodById(C.lineUnits(s, 'mine')[0].p);
  ok(g && g.id === 'iron_ore', '新买的台默认产该行业第一种产物', g && g.name);

  const price0 = C.goodsPrice(g, 0);
  ok(price0.eq(new D(g.basePrice)), '开市按基准价挂牌', price0.toString());

  // ---- 产量 = 基准产量 × 产物产量系数 × 产能 × 算力削减系数 ----
  const out = C.companyOutputPerCycle(s);
  const qty = out[g.id];
  ok(Math.abs(qty - line.baseOutput * g.outputCoef) < 1e-9,
    '每周期产量 = 基准产量 × 产物产量系数',
    qty + ' = ' + line.baseOutput + ' × ' + g.outputCoef);

  // ---- 维护费 = 单件维护费 × 产量；单件 = 售价 × 维护费率 × 行业成本指数 ----
  const px = C.goodsPriceWith(s, g);
  const up = C.companyUpkeep(s);
  // 采掘是最上游，成本指数恒为 1
  ok(C.industryCostIndex(s, 'mining') === 1, '最上游行业没有上游成本可传导');
  ok(up.total.eq(px.mul(g.upkeepRate).mul(qty)), '维护费 = 单件维护费 × 产量',
    up.total.toString());
  ok(up.material.add(up.labor).eq(up.total), '维护费 = 原料 + 人工');

  const gross = C.companyCycleGross(s);
  ok(gross.eq(px.mul(qty)), '毛产值 = 产量 × 市价', gross.toString());
  const net = C.companyCycleNet(s);
  const nr = net.div(gross).toNumber();
  ok(nr > 0.65 && nr < 0.75, '净收益率 ≈ 70%', String(nr));
  ok(C.companyIncomePerSecond(s).eq(net.div(GAME.company.cycleRealSeconds)),
    '折算每秒收益 = 净收益 / 周期', C.companyIncomePerSecond(s).toString());

  // ---- 走一个完整周期 ----
  const m0 = s.money;
  const acc = C.syncCompany(s, GAME.company.cycleRealSeconds, false);
  ok(acc.cycles === 1, '满一个周期结算 1 次', String(acc.cycles));
  ok(acc.produced === Math.floor(qty), '本周期产出入库（不足一件先攒着）',
    acc.produced + ' / ' + qty);
  ok(acc.upkeep.eq(up.total), '本周期扣维护费', acc.upkeep.toString());
  ok(acc.revenue.gt(0), '本周期卖出有收入', acc.revenue.toString());
  ok(acc.starved === 0, '本周期未停产');
  ok(acc.overflow === 0, '本周期无溢仓');
  ok(s.money.eq(m0.sub(up.total).add(acc.revenue)), '金钱 = 初始 − 维护费 + 收入',
    m0.toString() + ' -> ' + s.money.toString());
  ok(s.company.cycles === 1, '累计周期数 +1');
  ok(C.stockTotal(s) === 0, '自动卖出后库存清零');
  ok((s.company.goodsSold[g.id] || 0) === acc.produced, '售出计数累加',
    String(s.company.goodsSold[g.id]));
  ok(s.company.totalRevenue.gt(0), '累计营业额记录', s.company.totalRevenue.toString());
  ok(s.company.totalUpkeep.gt(0), '累计维护费记录', s.company.totalUpkeep.toString());

  // 不足一个周期只累积进度
  const a2 = C.syncCompany(s, 10, false);
  ok(a2.cycles === 0, '不足一个周期不结算');
  ok(Math.abs(s.company.cycleProgress - 10) < 1e-9, '进度累积到 10 秒',
    String(s.company.cycleProgress));
  const a3 = C.syncCompany(s, 10, false);
  ok(a3.cycles === 1, '补满后结算');

  // 多个周期一次算清
  const s2 = C.createState();
  s2.realm = 1;
  s2.money = new D(1e7);
  C.setWorking(s2, false);
  C.foundCompany(s2);
  C.buyLine(s2, 'mine');
  s2.realCompute = new D(1e6);
  C.setAllocation(s2, { industry: 1 });
  const a4 = C.syncCompany(s2, GAME.company.cycleRealSeconds * 30, false);
  ok(a4.cycles === 30, '一次推进 30 个周期', String(a4.cycles));
  ok(a4.revenue.gt(0), '30 周期收入累计', a4.revenue.toString());
  ok(s2.company.cycles === 30, '周期计数累加到 30');

  // 未成立 / dt 为 0 时不推进
  const raw = C.createState();
  raw.realm = 1;
  ok(C.syncCompany(raw, 100, false) === null, '未成立公司时不推进');
  ok(C.syncCompany(s, 0, false) === null, 'dt = 0 时不推进');

  // tick 集成：公司挂在主循环上
  const s3 = C.createState();
  s3.realm = 1;
  s3.money = new D(1e7);
  C.setWorking(s3, false);
  C.foundCompany(s3);
  C.buyLine(s3, 'mine');
  s3.realCompute = new D(1e6);
  C.setAllocation(s3, { industry: 1 });
  s3.devices.pc = 1;                         // tick 会重算算力，给点设备兜住
  const t = C.tick(s3, GAME.company.cycleRealSeconds, { offline: false });
  ok(t.company !== null, 'tick 返回公司结算汇总');
  ok(t.company.cycles >= 1, 'tick 内公司正常推进', String(t.company.cycles));
  ok(s3.company.cycles >= 1, 'tick 后公司周期计数已累加');

  // 公司不吃精力 —— 与工作系统的根本区别
  const s4 = C.createState();
  s4.realm = 1;
  s4.money = new D(1e7);
  C.setWorking(s4, false);
  const e0 = s4.energy;
  C.foundCompany(s4);
  C.buyLine(s4, 'mine');
  C.tick(s4, GAME.company.cycleRealSeconds, { offline: false });
  ok(s4.energy >= e0, '公司生产不消耗精力', e0 + ' -> ' + s4.energy);
}

// ============================================================
console.log('\n=== 公司系统 · 维护费不足则停产 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e8);
  C.foundCompany(s);
  for (let i = 0; i < 3; i++) C.buyLine(s, 'mine');
  s.realCompute = new D(1e6);
  C.setAllocation(s, { industry: 1 });

  const up = C.companyUpkeep(s);
  ok(up.total.gt(0), '三条矿井有维护费', up.total.toString());

  s.money = new D(0);                        // 破产
  const a = C.syncCompany(s, GAME.company.cycleRealSeconds * 2, false);
  ok(a.cycles === 2, '周期照常推进', String(a.cycles));
  ok(a.starved === 2, '两个周期都停产', String(a.starved));
  ok(a.revenue.eq(0), '停产周期无收入');
  ok(a.produced === 0, '停产周期无产出');
  ok(s.money.eq(0), '停产不会欠费（金钱不为负）', s.money.toString());
  ok(!s.money.isNeg(), '金钱未被扣成负数');
  ok(C.stockTotal(s) === 0, '停产周期库存不增加');
  ok(s.company.totalUpkeep.eq(0), '停产周期不计维护费');

  // 补上钱后恢复生产
  s.money = new D(1e5);
  const a2 = C.syncCompany(s, GAME.company.cycleRealSeconds, false);
  ok(a2.starved === 0, '补钱后恢复生产');
  ok(a2.revenue.gt(0), '恢复后有收入', a2.revenue.toString());
  ok(a2.upkeep.gt(0), '恢复后正常扣维护费', a2.upkeep.toString());
}

// ============================================================
console.log('\n=== 公司系统 · 仓容与溢仓 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e7);
  C.foundCompany(s);
  C.buyLine(s, 'mine');
  s.realCompute = new D(1e6);
  C.setAllocation(s, { industry: 1 });
  C.setAutoSell(s, false);                   // 关闭自动卖出，才看得到积压

  const cap = C.warehouseCapacity(s);        // 500
  ok(cap === 500, '基础容量 500', String(cap));

  const perCycle = Math.floor(C.companyOutputPerCycle(s).iron_ore);
  const n = Math.floor(cap / perCycle) + 5;
  const a = C.syncCompany(s, GAME.company.cycleRealSeconds * n, false);
  ok(a.cycles === n, '推进 ' + n + ' 个周期', String(a.cycles));
  ok(a.produced === cap, '入库被仓容截断到 500', String(a.produced));
  ok(a.overflow > 0, '超出部分计为溢仓', String(a.overflow));
  ok(C.stockTotal(s) === cap, '库存 = 仓容上限', String(C.stockTotal(s)));
  ok(C.stockOf(s, 'iron_ore') === cap, '积压的是铁矿石', String(C.stockOf(s, 'iron_ore')));
  ok(a.revenue.eq(0), '关闭自动卖出时无收入');

  // 手动清仓
  const g = C.goodById('iron_ore');
  const m0 = s.money;
  const sell = C.sellGoods(s, 'all');
  ok(sell.ok === true, '手动清仓成功', sell.msg);
  ok(sell.revenue.eq(C.goodsPriceWith(s, g).mul(cap)), '清仓收入 = 库存 × 市价',
    sell.revenue.toString());
  ok(s.money.gt(m0), '清仓后金钱增加', m0.toString() + ' -> ' + s.money.toString());
  ok(C.stockTotal(s) === 0, '清仓后库存为 0');
  ok(C.sellGoods(s, 'all').ok === false, '空仓时清仓被拒');

  // 部分卖出
  C.syncCompany(s, GAME.company.cycleRealSeconds * 2, false);
  ok(C.stockOf(s, 'iron_ore') === perCycle * 2, '两周期攒下的件数',
    String(C.stockOf(s, 'iron_ore')));
  const part = C.sellGoods(s, 'iron_ore', 15);
  ok(part.ok === true, '指定数量卖出成功', part.msg);
  ok(C.stockOf(s, 'iron_ore') === perCycle * 2 - 15, '剩余件数正确',
    String(C.stockOf(s, 'iron_ore')));
  ok(part.count === 15, '卖出 15 件');
  ok(part.price.eq(C.goodsPriceWith(s, g)), '按当前市价卖出', part.price.toString());
  ok(part.revenue.eq(C.goodsPriceWith(s, g).mul(15)), '收入 = 数量 × 市价',
    part.revenue.toString());

  // count 省略 = 全部
  const rest = C.sellGoods(s, 'iron_ore');
  ok(rest.count === perCycle * 2 - 15, '省略数量即全卖', String(rest.count));
  ok(C.stockOf(s, 'iron_ore') === 0, '全卖后库存为 0');

  // 异常路径
  C.syncCompany(s, GAME.company.cycleRealSeconds, false);
  const over = C.sellGoods(s, 'iron_ore', 999);
  ok(over.count === perCycle, '数量超过库存时只卖库存', String(over.count));
  ok(C.sellGoods(s, 'iron_ore').ok === false, '库存为 0 时卖出被拒');
  ok(C.sellGoods(s, 'nope').ok === false, '不存在的商品卖出被拒');

  // 未成立公司不能卖
  const raw = C.createState();
  raw.realm = 1;
  ok(C.sellGoods(raw, 'all').ok === false, '未成立公司不能卖出');
  ok(C.setAutoSell(raw, true).ok === false, '未成立公司不能切换自动卖出');
}


// ============================================================
console.log('\n=== 公司系统 · 自动卖出开关 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e6);
  C.foundCompany(s);
  C.buyLine(s, 'mine');
  s.realCompute = new D(1e6);
  C.setAllocation(s, { industry: 1 });

  ok(s.company.autoSell === true, '默认开启自动卖出');
  ok(C.setAutoSell(s, false).ok === true, '可以关闭自动卖出');
  ok(s.company.autoSell === false, '关闭后状态已更新');

  const perCycle = Math.floor(C.companyOutputPerCycle(s).iron_ore);
  const up = C.companyUpkeep(s).total;
  const m0 = s.money;
  C.syncCompany(s, GAME.company.cycleRealSeconds, false);
  ok(s.money.eq(m0.sub(up)), '关闭后只扣维护费',
    m0.toString() + ' -> ' + s.money.toString());
  ok(C.stockTotal(s) === perCycle, '产物留在仓库', String(C.stockTotal(s)));

  ok(C.setAutoSell(s, true).ok === true, '可以重新开启');
  C.syncCompany(s, GAME.company.cycleRealSeconds, false);
  ok(C.stockTotal(s) === 0, '开启后周期末自动清仓');
  ok(s.company.goodsSold.iron_ore === perCycle * 2, '两次周期共售出 ' + perCycle * 2 + ' 件',
    String(s.company.goodsSold.iron_ore));
  ok(s.company.autoSell === true, '开关状态保持为开');
}

// ============================================================
console.log('\n=== 公司系统 · 市价（确定性） ===');
{
  for (const g of GAME.company.goods) {
    const p0 = C.goodsPrice(g, 0);
    ok(p0.eq(new D(g.basePrice)), '开市按基准价：' + g.name, p0.toString());
    ok(C.goodsTrend(g, 0) === 'flat', '开市无涨跌：' + g.name);

    const len = C.goodsPeriodSeconds(g);
    ok(len === g.periodSeconds,
      g.name + ' 变价周期 = ' + g.periodSeconds + ' 现实秒', String(len));
    ok(C.goodsNextChangeIn(g, 0) === len, '开市距下次变价 = 一个周期：' + g.name);

    const third = Math.floor(len / 3);
    ok(C.goodsNextChangeIn(g, third) === len - third, '距下次变价随时间递减：' + g.name,
      String(C.goodsNextChangeIn(g, third)));
  }

  const chip = C.goodById('chip');

  // 同一时刻反复取值必须一致（前后端算出的价格要对得上）
  const t = 1234567;
  ok(C.goodsPrice(chip, t).eq(C.goodsPrice(chip, t)), '同一时刻价格可重复复现');

  // 价格落在配置的上下限内
  const base = new D(chip.basePrice);
  let inRange = true, changed = false;
  for (let p = 1; p <= 60; p++) {
    const tp = p * C.goodsPeriodSeconds(chip);
    const f = C.goodsPrice(chip, tp).div(base).toNumber();
    if (f < chip.minFactor - 1e-9 || f > chip.maxFactor + 1e-9) inRange = false;
    if (Math.abs(f - 1) > 1e-6) changed = true;
  }
  ok(inRange, '市价始终落在 minFactor ~ maxFactor 区间内');
  ok(changed, '市价随期数变化（不是常量）');

  // 趋势函数与价格方向一致
  let consistent = true;
  for (let p = 1; p <= 40; p++) {
    const tp = p * C.goodsPeriodSeconds(chip);
    const tr = C.goodsTrend(chip, tp);
    const cur = C.goodsPrice(chip, tp);
    const prev = C.goodsPrice(chip, tp - C.goodsPeriodSeconds(chip));
    if (tr === 'up' && !cur.gt(prev)) consistent = false;
    if (tr === 'down' && !cur.lt(prev)) consistent = false;
  }
  ok(consistent, '涨跌标记与价格方向一致');

  // 同一期内价格不变
  const lp = C.goodsPeriodSeconds(chip);
  ok(C.goodsPrice(chip, lp + 1).eq(C.goodsPrice(chip, lp + lp - 1)),
    '同一期内价格保持不变');
  // 跨期至少有一次不同（否则「浮动」形同虚设）
  ok(changed, '跨期存在真实变价');

  // 科技类 vs 修仙类变价节奏
  const comp = C.goodById('component');
  const tal = C.goodById('wind_talis');       // 制符业（修仙类）
  ok(C.goodsPeriodSeconds(comp) * 10 === C.goodsPeriodSeconds(tal),
    '修仙类变价周期是科技类的 10 倍');
  const fiveYears = C.goodsPeriodSeconds(comp) * 5;
  ok(C.goodsPrice(tal, fiveYears).eq(C.goodsPrice(tal, 0)),
    '修仙商品在 5 年内不变价（未到第 1 期）');
  ok(!C.goodsPrice(comp, fiveYears).eq(C.goodsPrice(comp, 0)),
    '科技商品 5 年内已多次变价');

  // 越下游的行业越值钱
  ok(C.goodsPrice(C.goodById('star_array'), 0).gt(C.goodsPrice(C.goodById('golden_pill'), 0)),
    '阵盘（下游）基准价 > 丹药（上游）基准价');
}

// ============================================================
console.log('\n=== 公司系统 · 序列化往返 ===');
{
  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e8);
  C.foundCompany(s);
  C.buyLine(s, 'mine');
  C.buyLine(s, 'mine');
  C.upgradeWarehouse(s);
  C.setAutoSell(s, false);
  s.realCompute = new D(1e6);
  C.setAllocation(s, { industry: 1 });
  const perCycle = Math.floor(C.companyOutputPerCycle(s).iron_ore);
  C.syncCompany(s, GAME.company.cycleRealSeconds * 3, false);
  const wantStock = perCycle * 3;             // 2 台 × 基准产量 × 3 个周期

  const json = JSON.parse(JSON.stringify(C.serialize(s)));
  const back = C.hydrate(json);

  ok(C.companyFounded(back), 'founded 可往返');
  ok(back.company.foundedDay === s.company.foundedDay, 'foundedDay 可往返');
  ok(C.lineOwned(back, 'mine') === 2, '生产线数量可往返',
    String(C.lineOwned(back, 'mine')));
  ok(C.warehouseLevel(back) === 1, '仓库等级可往返', String(C.warehouseLevel(back)));
  ok(C.warehouseCapacity(back) === C.warehouseCapacity(s), '仓库容量一致');
  ok(back.company.autoSell === false, '自动卖出开关可往返');
  ok(C.stockOf(back, 'iron_ore') === wantStock, '库存可往返',
    C.stockOf(back, 'iron_ore') + ' / ' + wantStock);
  ok(back.company.cycles === 3, '周期计数可往返', String(back.company.cycles));
  ok((back.company.goodsSold.iron_ore || 0) === 0, '售出计数可往返');
  // 每台线的产物与产能都要能往返 —— 这两项现在是存档的一部分
  ok(JSON.stringify(back.company.lines.mine) === JSON.stringify(s.company.lines.mine),
    '每台线的产物 / 产能可往返', JSON.stringify(back.company.lines.mine));
  ok(Math.abs(back.company.cycleProgress - s.company.cycleProgress) < 1e-9,
    '周期进度可往返');
  ok(back.company.totalRevenue.eq(s.company.totalRevenue), '累计营业额可往返');
  ok(back.company.totalUpkeep.eq(s.company.totalUpkeep), '累计维护费可往返');
  ok(back.money.eq(s.money), '金钱可往返');

  // 库存超过仓容时被裁剪
  const cheat = JSON.parse(JSON.stringify(C.serialize(s)));
  cheat.company.stock.iron_ore = 999999;
  const fixed = C.hydrate(cheat);
  ok(C.stockTotal(fixed) <= C.warehouseCapacity(fixed), '超容库存被裁到仓容内',
    C.stockTotal(fixed) + ' / ' + C.warehouseCapacity(fixed));

  // 伪造 founded 会被服务端挡掉；这里只验 hydrate 尊重 founded
  const orphan = JSON.parse(JSON.stringify(C.serialize(s)));
  orphan.company.founded = false;
  const orphanBack = C.hydrate(orphan);
  ok(!C.companyFounded(orphanBack), '未成立公司时 founded 保持 false');
  ok(C.stockTotal(orphanBack) === 0, '未成立公司时库存被清空');

  // 旧存档（没有 company 字段）能正常加载
  const legacy = JSON.parse(JSON.stringify(C.serialize(s)));
  delete legacy.company;
  const legacyBack = C.hydrate(legacy);
  ok(!C.companyFounded(legacyBack), '旧存档加载后公司为未成立');
  ok(C.stockTotal(legacyBack) === 0, '旧存档库存为空');
  ok(C.warehouseCapacity(legacyBack) > 0, '旧存档仓库容量正常');
  ok(C.upgradeWarehouse(legacyBack).ok === false, '旧存档不能凭空升级仓库');
}

// ============================================================
console.log('\n=== 公司系统 · 离线结算 ===');
{
  ok(GAME.offline.companyWhileOffline === true, '配置允许离线生产');

  const s = C.createState();
  s.realm = 1;
  s.money = new D(1e7);
  C.setWorking(s, false);
  C.foundCompany(s);
  C.buyLine(s, 'mine');

  const cyc = GAME.company.cycleRealSeconds;
  const a1 = C.syncCompany(s, cyc, true);    // 打折 0.3 → 只算 6 秒
  ok(a1.cycles === 0, '离线按 30% 折算：一个周期不够', String(a1.cycles));
  ok(Math.abs(s.company.cycleProgress - cyc * GAME.offline.ratio) < 1e-9,
    '离线进度 = 时长 × 0.3', String(s.company.cycleProgress));

  const a2 = C.syncCompany(s, cyc, false);   // 在线补 20 秒
  ok(a2.cycles === 1, '在线补足后结算 1 个周期', String(a2.cycles));

  // 离线 100 秒 → 30 秒有效 → 1 个周期
  const s2 = C.createState();
  s2.realm = 1;
  s2.money = new D(1e7);
  C.setWorking(s2, false);
  C.foundCompany(s2);
  C.buyLine(s2, 'mine');
  const off = C.syncCompany(s2, 100, true);
  ok(off.cycles === 1, '离线 100 秒折算 1 个周期', String(off.cycles));

  // 同样时长在线能跑 5 个周期 —— 离线明显更慢
  const s3 = C.createState();
  s3.realm = 1;
  s3.money = new D(1e7);
  C.setWorking(s3, false);
  C.foundCompany(s3);
  C.buyLine(s3, 'mine');
  const on = C.syncCompany(s3, 100, false);
  ok(on.cycles === 5, '同样时长在线跑 5 个周期', String(on.cycles));
  ok(on.cycles > off.cycles, '离线产出少于在线');

  // previewOffline 带公司汇总，且不改动原状态
  const s4 = C.createState();
  s4.realm = 1;
  s4.money = new D(1e7);
  C.setWorking(s4, false);
  C.foundCompany(s4);
  C.buyLine(s4, 'mine');
  // tick 会按设备重算算力，光设 realCompute 不够 —— 给台大设备兜住工业算力
  s4.devices.megacenter = 1;
  C.setAllocation(s4, { industry: 1 });
  const beforeMoney = s4.money.toString();
  const p = C.previewOffline(s4, 3600, true);
  ok(p.company !== null, 'previewOffline 返回公司汇总');
  ok(p.company.cycles === 54, '预览里 1 小时 → 54 个离线周期', String(p.company.cycles));
  ok(p.company.revenue.gt(0), '预览里有收入');
  ok(p.company.upkeep.gt(0), '预览里有维护费');
  ok(s4.money.toString() === beforeMoney, 'previewOffline 不修改金钱');
  ok(s4.company.cycles === 0, 'previewOffline 不改动公司计数');
  ok(s4.company.cycleProgress === 0, 'previewOffline 不改动周期进度');

  // 未成立公司时离线不产出
  const raw = C.createState();
  raw.realm = 1;
  ok(C.previewOffline(raw, 3600, true).company === null, '未成立公司时离线无公司收益');
}

console.log('\n=== 市场价格序列（走势图数据源）===');
{
  const chip = C.goodById('chip');
  const talisman = C.goodById('wind_talis');
  ok(!!chip && !!talisman, '取到科技类与修仙类商品');

  const series = C.goodsSeries(chip, 0, 5);
  ok(series.length === 6, '0~5 期共 6 个点', String(series.length));
  ok(series[0].period === 0 && series[5].period === 5, '期数区间正确');
  ok(series[0].price.eq(new D(chip.basePrice)), '第 0 期（开市）等于基准价',
    series[0].price.toString());

  // 同一期用「序列」和「即时价格」两种方式算，结果必须一致 ——
  // 否则走势图上的当前点会和卡片上的标价对不上。
  const len = C.goodsPeriodSeconds(chip);
  ok(series[3].price.eq(C.goodsPrice(chip, 3 * len + 1)), '序列价格与 goodsPrice 一致');
  ok(series[3].t === 3 * len, '记录了该期起始时间', String(series[3].t));

  const clamped = C.goodsSeries(chip, -5, 2);
  ok(clamped.length === 3 && clamped[0].period === 0, '起始期被夹到 0', String(clamped.length));

  const single = C.goodsSeries(chip, 3, 1);
  ok(single.length === 1 && single[0].period === 3, '反向区间退化为单点', String(single.length));

  const again = C.goodsSeries(chip, 0, 5);
  ok(again.every((p, i) => p.price.eq(series[i].price)), '序列可复现（不含随机数）');

  ok(C.goodsPeriodSeconds(talisman) > C.goodsPeriodSeconds(chip),
    '修仙类变价周期长于科技类',
    C.goodsPeriodSeconds(talisman) + ' vs ' + C.goodsPeriodSeconds(chip));

  const gs = C.goodsPeriodSeconds(chip) * 20 + 10;   // 停在第 20 期中
  const win = C.goodsWindow(chip, gs, 4, 2);
  ok(win.length === 7, '前 4 后 2 共 7 个点', String(win.length));
  ok(win[0].period === 16 && win[6].period === 22, '窗口区间正确',
    win[0].period + ' ~ ' + win[6].period);
  ok(win[4].period === C.goodsPeriod(chip, gs), '第 5 个点是当前期');

  const early = C.goodsWindow(chip, 5, 10, 3);
  ok(early[0].period === 0, '早期存档窗口从 0 开始');
  ok(early[early.length - 1].period === 3, '早期存档窗口末端为第 3 期');

  ok(C.goodsSeries(null, 0, 5).length === 0, '空商品返回空序列');

  // 窗口退化成单期时必须向后补一期：否则折线图连不成线，整块空白
  const solo = C.goodsWindow(chip, gs, 0, 0);
  ok(solo.length === 2 && solo[0].period === C.goodsPeriod(chip, gs),
    '单期窗口自动补一期（保证能连线）', solo.length + ' 点');

  // 开局边界：修仙类每 10 游戏年才变一次价，此时序列里本来只有第 0 期
  const talEarly = C.goodsWindow(talisman, 0, 8, 0);
  ok(talEarly.length >= 2, '修仙类开局窗口也能连线', String(talEarly.length));
  ok(talEarly[0].price.eq(new D(talisman.basePrice)), '修仙类开局首点即基准价');
}

// ============================================================
console.log('\n=== 公司系统 · 市场抛压（卖出影响下一期） ===');
{
  const MK = GAME.company.market;
  const chip = C.goodById('chip');
  const per = C.goodsPeriodSeconds(chip);

  // ---- 配置自洽 ----
  ok(!!MK, '配置里有 market 段');
  ok(MK.baseVolume > 0, '参考成交量 baseVolume > 0', String(MK.baseVolume));
  ok(MK.maxDrop > 0 && MK.maxDrop < 1, '压价幅度 maxDrop 在 (0,1)', String(MK.maxDrop));
  ok(MK.decay >= 0 && MK.decay <= 1, '衰减比例 decay 在 [0,1]', String(MK.decay));
  ok(MK.floor > 0 && MK.floor < 1, '价格下限 floor 在 (0,1)', String(MK.floor));

  /** 造一个已成立公司的状态；spec = [[生产线 id, 数量], ...]，会自动补齐解锁链 */
  const fresh = (spec) => {
    const s = C.createState();
    // 用 1e12 而不是更大的数：Decimal 的尾数只有约 14 位有效数字，
    // 金库太大时「卖一批货」的收入会落在精度之外，差值直接消失（不是 bug，
    // 但会让「金钱增量 = 收入」这类断言失效）。
    s.money = new D(1e12);
    s.realm = 6;
    C.foundCompany(s);
    for (const pair of (spec || [])) {
      for (let i = 0; i < pair[1]; i++) {
        const line = C.lineById(pair[0]);
        if (line && line.after) {
          let guard = 0;
          while (C.lineOwned(s, line.after.id) < line.after.times && guard++ < 200) {
            if (!C.buyLine(s, line.after.id).ok) break;
          }
        }
        if (!C.buyLine(s, pair[0]).ok) break;
      }
    }
    return s;
  };

  // ---- 初始：无抛压，市价 = 自然价 ----
  {
    const s = fresh();
    s.playTime = per * 3 + 10;
    ok(C.pressureOf(s, 'chip') === 0, '初始无抛压');
    ok(C.pressureOf(s, '不存在的商品') === 0, '未知商品抛压按 0 处理');
    ok(C.goodsPriceWith(s, chip).eq(C.naturalPrice(chip, s.playTime, s)),
      '无抛压时市价 = 自然价');
    ok(C.marketDropRatio(s, chip) === 0, '无抛压时折价为 0');
    ok(C.pressureOf(C.createState(), 'chip') === 0, '未成立公司时抛压为 0');
  }

  // ---- 正常经营：产多少卖多少 → 不该被罚 ----
  {
    const s = fresh();
    s.company.lastPeriod.chip = 0;
    s.playTime = per * 1 + 1;
    s.company.producedThisPeriod.chip = 300;
    s.company.soldThisPeriod.chip = 300;
    C.syncMarket(s);
    ok(C.pressureOf(s, 'chip') === 0, '产多少卖多少不触发抛压（扩张产能不自我惩罚）',
      String(C.pressureOf(s, 'chip')));
  }

  // ---- 当期卖出不影响当期价，跨期才生效 ----
  {
    const s = fresh();
    s.company.lastPeriod.chip = 2;
    s.playTime = per * 2 + 5;
    s.company.stock.chip = 5000;

    const before = C.goodsPriceWith(s, chip);
    const r = C.sellGoods(s, 'chip');
    ok(r.ok === true, '可以卖出库存');
    ok(r.price.eq(before), '成交价就是卖出前的市价');
    ok(C.goodsPriceWith(s, chip).eq(before), '当期卖出不改变当期成交价');
    ok(C.pressureOf(s, 'chip') === 0, '卖出当期不立刻产生抛压');
    ok(s.company.soldThisPeriod.chip === 5000, '本期成交量已记账',
      String(s.company.soldThisPeriod.chip));

    // 跨到下一期 → 抛压生效
    s.playTime = per * 3 + 5;
    C.syncMarket(s);
    ok(C.pressureOf(s, 'chip') > 0, '跨期后抛压生效', C.pressureOf(s, 'chip').toFixed(4));
    ok(C.marketDropRatio(s, chip) > 0, '跨期后出现折价');
    ok(C.goodsPriceWith(s, chip).lt(C.naturalPrice(chip, s.playTime)),
      '被压低的价格低于自然价');
  }

  // ---- 跨 n 期（离线）的公式与计数清零 ----
  {
    const s = fresh();
    s.company.lastPeriod.chip = 5;
    s.playTime = per * 8 + 1;                 // 跨 3 期
    s.company.pressure.chip = 0;
    s.company.producedThisPeriod.chip = 300;     // 每期产出 100
    s.company.soldThisPeriod.chip = 900;         // 每期净抛售 200 → add 封顶 1

    C.syncMarket(s);
    const expect = 1 * Math.pow(MK.decay, 2);    // add×decay^(n-1)
    ok(Math.abs(C.pressureOf(s, 'chip') - expect) < 1e-9,
      '跨 3 期：压力 = add × decay^(n−1)',
      C.pressureOf(s, 'chip').toFixed(4) + ' vs ' + expect.toFixed(4));
    ok(s.company.lastPeriod.chip === 8, '结算后 lastPeriod 推进到当前期',
      String(s.company.lastPeriod.chip));
    ok(s.company.soldThisPeriod.chip === 0 && s.company.producedThisPeriod.chip === 0,
      '结算后本期计数清零，开始为下一期累积');

    // 跨期结算必须按 n 均摊，否则 baseVolume（件/期）与累计量不是一个量纲
    const s2 = fresh();
    s2.company.lastPeriod.chip = 0;
    s2.playTime = per * 10 + 1;               // 跨 10 期
    s2.company.producedThisPeriod.chip = 1000;   // 每期 100
    s2.company.soldThisPeriod.chip = 1100;       // 总共只多卖 100 → 每期净抛售 10
    C.syncMarket(s2);
    const expect2 = (10 / Math.max(MK.baseVolume, 100)) * Math.pow(MK.decay, 9);
    ok(Math.abs(C.pressureOf(s2, 'chip') - expect2) < 1e-12,
      '同一批计数摊到 10 期时压力按每期均值算',
      C.pressureOf(s2, 'chip').toExponential(3) + ' vs ' + expect2.toExponential(3));
  }

  // ---- 衰减恢复 ----
  {
    const s = fresh();
    s.company.pressure.chip = 0.8;
    s.company.lastPeriod.chip = 0;
    s.playTime = per * 1 + 1;
    C.syncMarket(s);
    const p1 = C.pressureOf(s, 'chip');
    ok(Math.abs(p1 - 0.8 * MK.decay) < 1e-9, '无新抛售时按 decay 衰减', p1.toFixed(6));

    s.playTime += per * 4;
    C.syncMarket(s);
    const p2 = C.pressureOf(s, 'chip');
    ok(Math.abs(p2 - p1 * Math.pow(MK.decay, 4)) < 1e-9,
      '连续多期按 decay^n 衰减', p2.toFixed(8));
    ok(p2 < p1, '压力单调下降');
    ok(C.pressureOf(s, 'chip') > 0, '但不会一步归零');
  }

  // ---- 上限封顶 ----
  {
    const s = fresh();
    s.company.pressure.chip = 1;
    s.company.lastPeriod.chip = 0;
    s.company.soldThisPeriod.chip = 1e9;
    s.playTime = per * 1 + 1;
    C.syncMarket(s);
    ok(C.pressureOf(s, 'chip') <= 1 + 1e-12, '压力不会超过 1（不会无限叠加）',
      String(C.pressureOf(s, 'chip')));
  }

  // ---- 满压折价与价格下限 ----
  {
    const s = fresh();
    s.company.pressure.chip = 1;
    s.playTime = per * 4 + 1;
    const nat = C.naturalPrice(chip, s.playTime, s);
    ok(C.goodsPriceWith(s, chip).eq(nat.mul(1 - MK.maxDrop)),
      '满压时价格 = 自然价 × (1 − maxDrop)', C.goodsPriceWith(s, chip).toString());
    ok(Math.abs(C.marketDropRatio(s, chip) - MK.maxDrop) < 1e-9,
      '满压折价 = maxDrop', C.marketDropRatio(s, chip).toFixed(4));
    ok(C.marketFloorPrice(chip).eq(new D(chip.basePrice).mul(MK.floor)),
      '价格下限 = 基准价 × floor');

    // 任何期数下都不得击穿下限（自然波动下限与抛压下限会叠加）
    let lowest = null;
    for (let p = 1; p <= 240; p++) {
      s.playTime = per * p + 1;
      const v = C.goodsPriceWith(s, chip);
      if (lowest === null || v.lt(lowest)) lowest = v;
    }
    ok(lowest.gte(C.marketFloorPrice(chip)), '任意期数下价格不低于下限（兜底生效）',
      lowest.toString() + ' >= ' + C.marketFloorPrice(chip).toString());
  }

  // ---- 成交价 / 收入 / 毛产值预估都走带抛压的价格 ----
  {
    const s = fresh();
    s.playTime = per * 5 + 1;
    s.company.pressure.chip = 1;
    s.company.stock.chip = 10;
    const before = s.money;
    const r = C.sellGoods(s, 'chip');
    ok(r.price.eq(C.goodsPriceWith(s, chip)), '成交价 = 带抛压的市价');
    ok(r.revenue.eq(C.goodsPriceWith(s, chip).mul(10)), '收入 = 成交价 × 数量');

    // 金钱增量不能用 eq 比：收入与金库差好几个数量级时，Decimal 的加减要对齐
    // 尾数做 double 运算，属于灾难性抵消，回不到精确值（详见 decimal.test.js 的
    // 「抵消」小节）。正确的规律是：**绝对误差不超过大数的若干个 ulp**。
    // 游戏里 fmtBig 会 round 掉，肉眼与玩法都感知不到。
    const delta = s.money.sub(before);
    const absErr = Math.abs(delta.toNumber() - r.revenue.toNumber());
    const bound = 8 * Number.EPSILON * before.toNumber();
    ok(absErr <= bound, '金钱增量 = 本笔收入（绝对误差不超过金库的 8 个 ulp）',
      delta.toString() + ' vs ' + r.revenue.toString() +
      '  err=' + absErr.toExponential(2) + ' <= ' + bound.toExponential(2));
  }
  {
    const s = fresh([['smelter', 1]]);
    s.playTime = per * 5 + 1;
    s.realCompute = new D(1e9);
    C.setAllocation(s, { industry: 1 });
    ok(C.lineOwned(s, 'smelter') === 1, '已买到炼钢厂（解锁链可用）');
    // 前置的矿井是解锁链顺带买来的，先停掉，只留炼钢厂转，才凑得出整数关系
    C.setLineUnit(s, 'mine', 'all', { rate: 0 });
    const g0 = C.companyCycleGross(s);
    // 只压这条线正在产的那件货。冶炼的传导来自「采掘」，压下游不会反噬上游，
    // 于是传导指数不变、毛产值应整齐地少 maxDrop —— 若把全部商品都压满，
    // 上游价格也会掉，传导指数跟着动，就凑不出这个整数关系了。
    const making = C.lineUnits(s, 'smelter')[0].p;
    s.company.pressure[making] = 1;
    const g1 = C.companyCycleGross(s);
    ok(g1.lt(g0), '周期毛产值预估已计入抛压');
    ok(Math.abs(g0.sub(g1).div(g0).toNumber() - MK.maxDrop) < 1e-9,
      '全商品满压时毛产值正好少 maxDrop', g0.sub(g1).div(g0).toNumber().toFixed(4));
  }

  // ---- 走势图序列（含抛压） ----
  {
    const s = fresh();
    s.company.pressure.chip = 1;
    s.playTime = per * 10 + 1;
    const win = C.goodsWindowWith(s, chip, 3, 3);
    ok(win.length === 7, '带抛压窗口取到 7 个点', String(win.length));
    const curP = C.goodsPeriod(chip, s.playTime);
    const atCur = win.filter((x) => x.period === curP)[0];
    ok(win[0].impact === 1, '过去期不受当期抛压影响（画的是历史）');
    ok(Math.abs(atCur.impact - (1 - MK.maxDrop)) < 1e-9, '当前期承受完整抛压');
    ok(win[win.length - 1].impact > atCur.impact,
      '未来期抛压逐步恢复（折线图上能看到价格爬回来）',
      win[win.length - 1].impact.toFixed(4) + ' > ' + atCur.impact.toFixed(4));
    ok(atCur.price.eq(C.goodsPriceWith(s, chip)), '序列中当前期价格与实时价格一致');
    ok(C.goodsWindowWith(s, chip, 0, 0).length >= 2, '单期窗口仍能连线');

    // 无抛压时，带抛压序列 = 纯自然序列 × 行业传导指数
    // （纯自然序列用于「这张图本来该怎么走」的参考线，不含传导成本）
    const s2 = fresh();
    s2.playTime = per * 12 + 1;
    const a = C.goodsWindowWith(s2, chip, 3, 3);
    const b = C.goodsWindow(chip, s2.playTime, 3, 3);
    const indIdx = C.industryPriceIndex(s2, chip.industry);
    let same = a.length === b.length;
    if (same) {
      for (let i = 0; i < a.length; i++) {
        if (!a[i].price.eq(b[i].price.mul(indIdx))) same = false;
      }
    }
    ok(same, '无抛压时，带抛压序列 = 纯自然序列 × 行业传导指数',
      '传导指数 ' + indIdx.toFixed(6));
    ok(C.goodsSeriesWith(s2, null, 0, 3).length === 0, '空商品返回空序列');
  }

  // ---- 市场概览 ----
  {
    const s = fresh();
    s.playTime = per * 5 + 1;
    s.company.pressure.chip = 0.5;
    const ms = C.marketSummary(s);
    ok(ms !== null && ms.goods.length === GAME.company.goods.length,
      '市场概览覆盖全部商品');
    const g = ms.goods.filter((x) => x.id === 'chip')[0];
    ok(Math.abs(g.pressure - 0.5) < 1e-12, '概览含抛压');
    ok(Math.abs(g.impact - (1 - 0.5 * MK.maxDrop)) < 1e-9, '概览含影响系数');
    ok(g.naturalPrice.gt(g.price), '被压价时自然价高于现价');
    ok(g.recoverIn > 0, '概览给出恢复所需期数', String(g.recoverIn));
    ok(ms.peak >= 0.5, '概览给出最高抛压', String(ms.peak));
    ok(typeof ms.warn === 'boolean', '概览给出警示标记');
    ok(C.marketSummary(C.createState()) === null, '未成立公司时无市场概览');
  }

  // ---- hydrate 夹取（客户端可上报，只能挡越界） ----
  {
    const s = fresh();
    s.playTime = per * 6 + 10;
    s.company.pressure.chip = 0.5;
    s.company.soldThisPeriod.chip = 42;
    s.company.producedThisPeriod.chip = 17;
    s.company.lastPeriod.chip = 4;

    const raw = C.serialize(s);
    ok(raw.company.pressure.chip === 0.5, '抛压已写入存档');
    ok(raw.company.soldThisPeriod.chip === 42, '本期卖出已写入存档');
    ok(raw.company.producedThisPeriod.chip === 17, '本期产出已写入存档');

    const h = C.hydrate(JSON.parse(JSON.stringify(raw)));
    ok(Math.abs(C.pressureOf(h, 'chip') - 0.5) < 1e-12, '抛压可往返');
    ok(h.company.soldThisPeriod.chip === 42, '本期卖出可往返');
    ok(h.company.producedThisPeriod.chip === 17, '本期产出可往返');
    ok(h.company.lastPeriod.chip === 4, '期数游标可往返');

    const neg = JSON.parse(JSON.stringify(raw));
    neg.company.pressure.chip = -5;
    neg.company.soldThisPeriod.chip = -3;
    neg.company.producedThisPeriod.chip = -9;
    const hn = C.hydrate(neg);
    ok(C.pressureOf(hn, 'chip') === 0, '负抛压被夹到 0（否则价格会暴涨）');
    ok(hn.company.soldThisPeriod.chip === 0, '负计数被夹到 0');
    ok(hn.company.producedThisPeriod.chip === 0, '负产出被夹到 0');

    const big = JSON.parse(JSON.stringify(raw));
    big.company.pressure.chip = 99;
    ok(C.pressureOf(C.hydrate(big), 'chip') === 1, '超范围抛压被夹到 1');

    const ahead = JSON.parse(JSON.stringify(raw));
    ahead.company.lastPeriod.chip = 99999;
    const ha = C.hydrate(ahead);
    ok(ha.company.lastPeriod.chip <= C.goodsPeriod(chip, ha.playTime),
      'lastPeriod 不允许超前于当前期（否则抛压永远等不到结算）',
      String(ha.company.lastPeriod.chip));
  }

  // ---- 未成立公司时不结算 ----
  {
    const raw = C.createState();
    ok(C.syncMarket(raw) === null, '未成立公司时市场不结算');

    raw.company.founded = true;
    raw.playTime = per * 2 + 1;
    for (const g of GAME.company.goods) raw.company.lastPeriod[g.id] = 0;
    // 能结算的只有「当前期数已经前进」的商品：科技类逐年变价，修仙类每 10 年
    // 才变一次，所以此时只有 3 种科技品该结算 —— 这正是期望行为。
    // 12 个行业 × 6 种产物，其中 6 个科技行业逐年变价（36 种），
    // 修仙行业每 10 年才变一次 —— 此刻还没跨过期边界
    const due = GAME.company.goods.filter((g) => C.goodsPeriod(g, raw.playTime) > 0);
    const techCount = GAME.company.goods.filter((g) => g.kind === 'tech').length;
    ok(due.length === techCount, '此刻只有科技类跨过了期边界',
      due.length + ' / 科技类 ' + techCount);
    const acc = C.syncMarket(raw);
    ok(acc !== null && acc.goods === due.length,
      '一次性结算全部「已跨期」的商品（修仙类周期未到，不结算）',
      String(acc && acc.goods));
  }
}

console.log('\n=== 股市（证券账户） · 配置自洽 ===');
{
  const SK = GAME.stock;
  ok(!!SK, '配置里有 stock 段');
  ok(SK.implemented === true, 'stock.implemented 为 true');
  ok(SK.fee > 0 && SK.fee < 0.05, '单边手续费在合理区间', String(SK.fee));
  ok(SK.minOrder > 0, '最小成交额 > 0', String(SK.minOrder));
  ok(SK.flowDecay > 0 && SK.flowDecay < 1, 'flowDecay 在 (0,1)', String(SK.flowDecay));
  ok(SK.maxRise > 0 && SK.maxRise < 1, 'maxRise 在 (0,1)', String(SK.maxRise));
  ok(SK.maxDrop > 0 && SK.maxDrop < 1, 'maxDrop 在 (0,1)', String(SK.maxDrop));
  ok(SK.floor > 0 && SK.floor < 1, 'floor 在 (0,1)', String(SK.floor));
  ok(SK.linkWeight > 0 && SK.linkWeight <= 1, 'linkWeight 在 (0,1]', String(SK.linkWeight));
  ok(!!SK.unlock && SK.unlock.realm >= 0, '声明了开户境界门槛');

  const list = SK.stocks || [];
  ok(list.length >= 10, '池子里至少 10 家公司', String(list.length));
  ok(SK.boardSize >= 1 && SK.boardSize < list.length,
    '榜单长度小于池子（只显示前 N 家）', SK.boardSize + ' / ' + list.length);

  let bad = null;
  for (const st of list) {
    if (!st.name) bad = st.id + ' 缺 name';
    if (!st.code) bad = st.id + ' 缺 code';
    if (!(st.basePrice > 0)) bad = st.id + ' basePrice 必须 > 0';
    if (!(st.volatility > 0)) bad = st.id + ' volatility 必须 > 0';
    if (!(st.depth >= 1)) bad = st.id + ' depth 必须 >= 1';
    if (!(st.periodSeconds > 0)) bad = st.id + ' periodSeconds 必须 > 0';
    if (!(st.minFactor > 0 && st.minFactor < 1)) bad = st.id + ' minFactor 应在 (0,1)';
    if (!(st.maxFactor > 1)) bad = st.id + ' maxFactor 应 > 1';
    if (st.link && !C.goodById(st.link)) bad = st.id + ' link 指向不存在的商品: ' + st.link;
    // 主营业务是「行情一动就能看出波及谁」的关键，必须有
    if (!st.business) bad = st.id + ' 缺 business（主营业务）';
    // v3.6 起新增第三类：fusion（融合赛道，元婴解锁）
    if (st.kind !== 'tech' && st.kind !== 'xiuxian' && st.kind !== 'fusion') {
      bad = st.id + ' kind 必须是 tech / xiuxian / fusion';
    }
  }
  ok(bad === null, '每只股票的字段自洽', bad || '');

  // 30 家科技 + 20 家修仙宗门
  const techN = list.filter((x) => x.kind === 'tech').length;
  const xiuN = list.filter((x) => x.kind === 'xiuxian').length;
  ok(techN === 30 && xiuN === 20, '30 家科技公司 + 20 家修仙宗门',
    techN + ' / ' + xiuN);

  // 每家都挂在某个行业上（独立行情的那家除外）
  let secOk = true;
  for (const st of list) {
    if (st.sector === null) continue;
    if (!C.industryById(st.sector)) secOk = false;
  }
  ok(secOk, '每家公司的主营行业都存在');

  // 市值集中在同一档 —— 否则榜单前 N 会被天价股永久占据，行情再怎么动也不换人
  const caps = list.map((x) => x.basePrice * x.depth).sort((a, b) => a - b);
  ok(caps[caps.length - 1] / caps[0] < 20, '各家公司市值在同一档（榜单会随行情换人）',
    caps[0].toExponential(2) + ' ~ ' + caps[caps.length - 1].toExponential(2));

  ok(C.stockById(list[0].id) === list[0], 'stockById 能取回配置项');
  ok(C.stockById('不存在') === null, 'stockById 对未知 id 返回 null');
}

console.log('\n=== 股市 · 开户门槛 ===');
{
  const s0 = C.createState();
  ok(C.stockUnlocked(s0) === false, '凡人未开户');
  ok(C.stockLockedReason(s0).indexOf(C.constructor === Object ? '' : '') >= 0, '给出未开户原因');
  ok(C.stockLockedReason(s0).length > 0, '未开户原因非空', C.stockLockedReason(s0));

  const need = (GAME.stock.unlock || {}).realm || 0;
  const s1 = C.createState();
  s1.realm = need;
  ok(C.stockUnlocked(s1) === true, '达到门槛即开户（realm=' + need + '）');
  ok(C.stockLockedReason(s1) === '', '已开户时原因为空');
  ok(C.stockSummary(C.createState()).unlocked === false, '未开户时概览标未解锁');
}

console.log('\n=== 股市 · 价格构成（确定性） ===');
{
  const tianji = C.stockById('tianji');
  const per = C.stockPeriodSeconds(tianji);
  const mk = () => { const s = C.createState(); s.realm = 1; s.money = new D(1e12); return s; };

  // 第 0 期按基准价挂牌
  {
    const s = mk();
    s.playTime = 0;
    ok(C.stockNaturalPrice(s, tianji).eq(new D(tianji.basePrice)),
      '第 0 期自然价 = 基准价', C.stockNaturalPrice(s, tianji).toString());
    ok(C.stockImpact(s, tianji) === 1, '无持仓无交易时冲击系数 = 1');
    ok(C.stockPrice(s, tianji).eq(C.stockNaturalPrice(s, tianji)),
      '无冲击时成交价 = 自然价');
    ok(C.stockTrend(s, tianji) === 'flat', '第 0 期无上一期可比，趋势为平');
    ok(C.stockPeriod(tianji, 0) === 0, '第 0 期期号为 0');
  }

  // 确定性：同样的输入必须给出同样的价格（前端与后端各算一次也得一致）
  {
    const a = C.stockNaturalPrice(mk(), tianji, per * 7 + 3).toString();
    const b = C.stockNaturalPrice(mk(), tianji, per * 7 + 3).toString();
    ok(a === b, '同一期的自然价可复现（前后端不会算出两个价）', a);
    const s2 = mk();
    s2.playTime = per * 7 + 3;
    ok(C.stockPrice(s2, tianji).toString() === a, '成交价同样可复现');
  }

  // 期数推进会改价，但同一期内任何秒数都不变
  {
    const s = mk();
    s.playTime = per * 3 + 10;
    const p1 = C.stockNaturalPrice(s, tianji).toString();
    s.playTime = per * 3 + per - 1;
    ok(C.stockNaturalPrice(s, tianji).toString() === p1, '同一期内价格恒定（只在期边界变价）');
    s.playTime = per * 4 + 1;
    ok(C.stockNaturalPrice(s, tianji).toString() !== p1, '跨期后价格改变');
  }

  // 波动幅度被 minFactor / maxFactor 兜住
  {
    let minF = Infinity, maxF = -Infinity;
    for (let p = 1; p <= 400; p++) {
      const f = C.stockFactor(tianji, p);
      if (f < minF) minF = f;
      if (f > maxF) maxF = f;
    }
    ok(minF >= tianji.minFactor - 1e-12, '波动倍数不低于 minFactor', minF.toFixed(4));
    ok(maxF <= tianji.maxFactor + 1e-12, '波动倍数不高于 maxFactor', maxF.toFixed(4));
    ok(maxF > 1.2 && minF < 0.85, '波动确实有「翻倍 / 腰斩」的量级',
      minF.toFixed(3) + ' ~ ' + maxF.toFixed(3));
  }

  // 涨跌方向与相邻两期比较一致
  {
    const s = mk();
    let up = 0, down = 0;
    for (let p = 2; p <= 60; p++) {
      s.playTime = p * per + 1;
      const t = C.stockTrend(s, tianji);
      if (t === 'up') up++; else if (t === 'down') down++;
    }
    ok(up > 0 && down > 0, '既出现过涨也出现过跌', up + ' 涨 / ' + down + ' 跌');
  }

  // 序列（走势图数据源）
  {
    const s = mk();
    s.playTime = per * 10 + 1;
    const w = C.stockWindow(s, tianji, 5, 5);
    ok(w.length === 11, 'stockWindow(5,5) 给出 11 期', String(w.length));
    ok(w[0].period === 5 && w[10].period === 15, '窗口期号连续正确',
      w[0].period + '~' + w[10].period);
    ok(w.every((x) => x.price.gt(0)), '所有期的价格都为正');
    const ser = C.stockSeries(s, tianji, 0, 20);
    ok(ser.length === 21, 'stockSeries(0,20) 给出 21 期', String(ser.length));
    ok(ser[0].price.eq(new D(tianji.basePrice)), '序列首期按基准价挂牌');
    ok(C.stockSeries(s, tianji, 5, 5).length === 1, '单期序列只含 1 个点');

    // 开头不越界：窗口早于第 0 期时自动贴到 0
    const w0 = C.stockWindow(s, tianji, 999, 2);
    ok(w0[0].period === 0, '窗口不会早于第 0 期', String(w0[0].period));
  }
}

console.log('\n=== 股市 · 冲击系数（反作用） ===');
{
  const tianji = C.stockById('tianji');
  const depth = C.stockDepth(tianji);
  const s = C.createState();
  s.realm = 1;

  ok(C.stockImpactAt(s, tianji, 0, 0) === 1, '不交易时冲击为 0');
  // 这条是防止「自抬轿子」套利的关键性质：光持仓不交易，价格一点都不动
  ok(C.stockImpactAt(s, tianji, depth, 0) === 1,
    '只持仓、不交易时冲击仍为 0（持仓不会自己把价格抬起来）');

  const buyI = C.stockImpactAt(s, tianji, 0, depth * 0.1);
  ok(buyI > 1, '净买入把成交价推高', buyI.toFixed(6));
  const sellI = C.stockImpactAt(s, tianji, depth, -depth * 0.1);
  ok(sellI < 1, '净卖出把成交价压低', sellI.toFixed(6));

  ok(C.stockImpactAt(s, tianji, 0, 1e18) === 1 + (GAME.stock.maxRise || 0),
    '买入冲击封顶 +maxRise', String(C.stockImpactAt(s, tianji, 0, 1e18)));
  ok(C.stockImpactAt(s, tianji, 0, -1e18) === 1 - (GAME.stock.maxDrop || 0),
    '卖出冲击封底 −maxDrop', String(C.stockImpactAt(s, tianji, 0, -1e18)));

  // 持仓集中度放大冲击幅度 —— 重仓难出
  const i0 = C.stockImpactAt(s, tianji, 0, depth * 0.08);
  const i1 = C.stockImpactAt(s, tianji, Math.floor(depth / 2), depth * 0.08);
  ok(i1 > i0, '同样一笔买入，持仓越集中冲击越大', i0.toFixed(5) + ' → ' + i1.toFixed(5));

  // 过去期不再受冲击影响（已经拿不回来了）
  s.playTime = 10 * C.stockPeriodSeconds(tianji);
  s.stock.flow[tianji.id] = 5000;
  ok(C.stockSeries(s, tianji, 3, 5).every((x) => x.impact === 1),
    '历史期的冲击恒为 1（历史价不可考）');
  const fut = C.stockSeries(s, tianji, 10, 14);
  ok(Math.abs(fut[0].impact - 1) > 1e-9, '当前期仍有冲击');
  ok(Math.abs(fut[4].impact - 1) < Math.abs(fut[0].impact - 1),
    '未来期的冲击逐期衰减回 1');
}

console.log('\n=== 股市 · 买入 ===');
{
  const tianji = C.stockById('tianji');
  const depth = C.stockDepth(tianji);
  const mk = () => { const s = C.createState(); s.realm = 1; s.money = new D(1e12); return s; };

  {
    const s = mk();
    const pxBefore = C.stockPrice(s, tianji);
    const q = C.stockBuyQuote(s, tianji, 2000);
    ok(q.ok === true, '买入报价成立');
    ok(q.impact > 1, '买入报价的冲击系数 > 1', q.impact.toFixed(6));
    // 成交按「成交之后」的冲击价结算 —— 这就是「买在高处」的来源
    ok(q.unitPrice.gt(pxBefore), '成交价高于成交前的市场价（买高）',
      q.unitPrice.toString() + ' vs ' + pxBefore.toString());
    ok(q.gross.eq(q.unitPrice.mul(2000)), '成交额 = 成交价 × 股数');
    ok(q.fee.eq(q.gross.mul(GAME.stock.fee)), '手续费 = 成交额 × fee');
    ok(q.total.eq(q.gross.add(q.fee)), '应付款 = 成交额 + 手续费');

    const m0 = s.money;
    const b = C.buyStock(s, tianji.id, 2000);
    ok(b.ok === true, '买入成功');
    ok(s.money.eq(m0.sub(q.total)), '扣款 = 成交额 + 手续费',
      s.money.toString() + ' vs ' + m0.sub(q.total).toString());
    ok(C.stockShares(s, tianji.id) === 2000, '股数已入账');
    ok(C.stockFlow(s, tianji.id) === 2000, '净买入流已记账');
    ok(C.stockCost(s, tianji.id).eq(q.total), '持仓成本含手续费');
    ok(s.stock.totalFee.eq(q.fee), '累计手续费已记账');
    ok(s.stock.totalTrades === 1, '成交笔数 +1');
    ok(C.stockAvgCost(s, tianji.id).eq(q.total.div(2000)), '含费均价 = 成本 / 股数');
  }

  // 买得越多，均价越高（越买越贵）
  {
    const a = C.stockBuyQuote(mk(), tianji, 2000).unitPrice.toNumber();
    const b = C.stockBuyQuote(mk(), tianji, 60000).unitPrice.toNumber();
    ok(b > a, '买得越多成交均价越高（越买越贵）', a.toFixed(2) + ' → ' + b.toFixed(2));
  }

  // 拒绝路径
  {
    const s = mk();
    const b1 = C.buyStock(s, tianji.id, 1);
    ok(b1.ok === false, '单笔不足最小成交额时拒绝', b1.msg);
    ok(b1.msg.indexOf('不足') >= 0, '拒绝原因说明成交额不足', b1.msg);

    const b2 = C.buyStock(s, tianji.id, 0);
    ok(b2.ok === false, '股数为 0 时拒绝', b2.msg);
    const b3 = C.buyStock(s, tianji.id, -5);
    ok(b3.ok === false, '股数为负时拒绝', b3.msg);
    const b4 = C.buyStock(s, '不存在', 100);
    ok(b4.ok === false, '未知股票拒绝', b4.msg);

    const b5 = C.buyStock(s, tianji.id, depth + 1);
    ok(b5.ok === false, '超过流通盘上限时拒绝', b5.msg);
    ok(C.buyStock(s, tianji.id, depth).ok === true, '恰好买满流通盘允许');

    const s2 = mk();
    s2.money = new D(1);
    const b6 = C.buyStock(s2, tianji.id, 10000);
    ok(b6.ok === false, '金钱不足时拒绝', b6.msg);
    ok(s2.money.eq(new D(1)), '拒绝的交易不动钱');

    const s3 = C.createState();
    s3.money = new D(1e12);
    const b7 = C.buyStock(s3, tianji.id, 10000);
    ok(b7.ok === false, '未开户时拒绝买入', b7.msg);
    ok(s3.money.eq(new D(1e12)), '未开户的交易不动钱');
  }

  // 最大可买
  {
    const s = mk();
    s.money = new D(1e6);
    const mb = C.stockMaxBuy(s, tianji);
    ok(mb > 0, '算得出最大可买量', String(mb));
    ok(C.stockBuyQuote(s, tianji, mb).total.lte(s.money), '最大可买量确实买得起');
    const over = C.stockBuyQuote(s, tianji, mb + 1);
    ok(over.total.gt(s.money), '再多一股就买不起', over.total.toString());

    const s2 = mk();
    s2.money = new D(1);
    ok(C.stockMaxBuy(s2, tianji) === 0, '买不起最小成交额时最大可买为 0');
  }
}

console.log('\n=== 股市 · 卖出与「一轮买卖必亏」 ===');
{
  const tianji = C.stockById('tianji');
  const per = C.stockPeriodSeconds(tianji);
  const mk = () => { const s = C.createState(); s.realm = 1; s.money = new D(1e12); return s; };

  {
    const s = mk();
    const m0 = s.money;
    const b = C.buyStock(s, tianji.id, 5000);
    ok(b.ok === true, '先买入 5000 股');

    const q = C.stockSellQuote(s, tianji, 5000);
    ok(q.ok === true, '卖出报价成立');
    // 刚买进来的 5000 股一次性卖回去，净买入流正好归零 —— 这一笔不吃冲击，只亏手续费
    ok(Math.abs(q.impact - 1) < 1e-12, '把刚买的那笔流原样卖回时冲击归零', q.impact.toFixed(6));
    ok(q.net.eq(q.gross.sub(q.fee)), '净得 = 成交额 − 手续费');

    const r = C.sellStock(s, tianji.id, 5000);
    ok(r.ok === true, '卖出成功');
    ok(r.profit.isNeg(), '买入后立刻卖回：本笔盈亏为负（溢价 + 双边手续费）',
      r.profit.toString());
    ok(s.money.lt(m0), '一轮买→卖之后金钱变少', s.money.toString() + ' < ' + m0.toString());
    ok(s.stock.realized.eq(r.profit), '已实现盈亏已累计');
    ok(s.stock.totalTrades === 2, '两笔成交都记账了', String(s.stock.totalTrades));
  }

  // 「卖低」：手里有货但本期没有买入流时，卖出会把自己砸低
  {
    const s = mk();
    s.stock.shares[tianji.id] = 5000;
    s.stock.cost[tianji.id] = new D(0);
    s.stock.flow[tianji.id] = 0;
    const pxBeforeSell = C.stockPrice(s, tianji);
    const q = C.stockSellQuote(s, tianji, 5000);
    ok(q.impact < 1, '卖出报价的冲击系数 < 1', q.impact.toFixed(6));
    ok(q.unitPrice.lt(pxBeforeSell), '成交价低于成交前的市场价（卖低）',
      q.unitPrice.toString() + ' vs ' + pxBeforeSell.toString());
    ok(C.stockSellQuote(s, tianji, 1000).unitPrice
      .gt(C.stockSellQuote(s, tianji, 5000).unitPrice),
      '卖得越多成交均价越低（越卖越便宜）');
  }

  // 卖出数量超过持仓 → 自动按持仓成交
  {
    const s = mk();
    C.buyStock(s, tianji.id, 1000);
    const r = C.sellStock(s, tianji.id, 999999);
    ok(r.ok === true, '卖超时按持仓成交');
    ok(r.shares === 1000, '实际成交股数 = 持仓数', String(r.shares));
    ok(r.sharesAfter === 0, '卖完之后持仓归零');
    ok(C.stockShares(s, tianji.id) === 0, '内核持仓为 0');
    ok(C.stockCost(s, tianji.id).isZero(), '清仓后持仓成本精确归零');
    ok(C.stockAvgCost(s, tianji.id).isZero(), '无持仓时均价为 0');
    ok(C.stockHoldingValue(s, tianji).isZero(), '无持仓时市值为 0');
    ok(C.stockHoldingPnl(s, tianji).isZero(), '无持仓时浮动盈亏为 0');
  }

  // 部分卖出按含费均价结转成本
  {
    const s = mk();
    const b = C.buyStock(s, tianji.id, 4000);
    const avg = C.stockAvgCost(s, tianji.id);
    ok(avg.eq(b.total.div(4000)), '部分卖出前的含费均价正确');
    const r = C.sellStock(s, tianji.id, 1000);
    ok(r.costOut.eq(avg.mul(1000)), '结转成本 = 含费均价 × 卖出股数');
    ok(C.stockCost(s, tianji.id).eq(b.total.sub(avg.mul(1000))), '剩余成本相应减少');
    ok(C.stockShares(s, tianji.id) === 3000, '剩余持仓正确');
  }

  // 拒绝路径
  {
    const s = mk();
    const r1 = C.sellStock(s, tianji.id, 100);
    ok(r1.ok === false, '没有持仓时拒绝卖出', r1.msg);
    ok(r1.msg.indexOf('没有持仓') >= 0, '拒绝原因说明没有持仓', r1.msg);

    C.buyStock(s, tianji.id, 1000);
    const r2 = C.sellStock(s, tianji.id, 10);
    ok(r2.ok === false, '卖出额不足最小成交额时拒绝', r2.msg);
    const r3 = C.sellStock(s, '不存在', 100);
    ok(r3.ok === false, '未知股票拒绝卖出', r3.msg);
  }

  // 价格回归：多期之后冲击消失，成交价回到自然价
  {
    const s = mk();
    C.buyStock(s, tianji.id, 1000);
    ok(C.stockFlow(s, tianji.id) === 1000, '前置：有净买入流');
    s.playTime = per * 60 + 1;
    C.syncStocks(s);
    ok(C.stockFlow(s, tianji.id) === 0, '多期之后净买入流归零', String(C.stockFlow(s, tianji.id)));
    ok(C.stockImpact(s, tianji) === 1, '冲击回归 1');
    ok(C.stockPrice(s, tianji).eq(C.stockNaturalPrice(s, tianji)),
      '此时成交价 = 自然价（当初买出来的溢价拿不回来了）');
  }
}

console.log('\n=== 股市 · 跨期结算（flow 衰减） ===');
{
  const tianji = C.stockById('tianji');
  const per = C.stockPeriodSeconds(tianji);
  const decay = GAME.stock.flowDecay;

  const mk = () => {
    const s = C.createState();
    s.realm = 1;
    s.money = new D(1e12);
    s.stock.shares[tianji.id] = 1000;
    s.stock.flow[tianji.id] = 1000;
    s.stock.lastPeriod[tianji.id] = 0;
    return s;
  };

  {
    const s = mk();
    // 未跨期 → 不结算
    s.playTime = 1;
    const acc0 = C.syncStocks(s);
    ok(acc0 === null || acc0.stocks === 0, '未跨期时不结算');
    ok(C.stockFlow(s, tianji.id) === 1000, '未跨期时净买入流不变');
  }

  {
    const s = mk();
    s.playTime = per * 4 + 1;      // 跨 4 期
    C.syncStocks(s);
    ok(C.stockFlow(s, tianji.id) === Math.trunc(1000 * Math.pow(decay, 4)),
      'flow = trunc(原值 × decay^期数)',
      String(C.stockFlow(s, tianji.id)));
    ok(s.stock.lastPeriod[tianji.id] === 4, '结算后期数游标推进到当前期',
      String(s.stock.lastPeriod[tianji.id]));
  }

  {
    // 结算返回的冲击与当前读数一致
    const s = mk();
    s.playTime = per * 1 + 1;
    const acc = C.syncStocks(s);
    ok(acc !== null && acc.stocks >= 1, '跨期结算给出结算股票数', String(acc && acc.stocks));
    ok(Math.abs(acc.settled[tianji.id].impact - C.stockImpact(s, tianji)) < 1e-12,
      '结算返回的冲击与当前读数一致');
    ok(Math.abs(acc.peak - Math.abs(C.stockImpact(s, tianji) - 1)) < 1e-12,
      '结算给出冲击峰值');
  }

  {
    // 股票不跨期时不结算（周期更长的那只）
    const s = mk();
    const long = GAME.stock.stocks.filter((x) => x.periodSeconds > 60);
    if (long.length) {
      const st = long[0];
      s.playTime = per * 2 + 1;
      for (const x of GAME.stock.stocks) s.stock.lastPeriod[x.id] = C.stockPeriod(x, s.playTime);
      const acc = C.syncStocks(s);
      ok(acc === null || acc.stocks === 0, '只推进了 1 期的短周期，不会带上长周期一起结算');
    } else {
      ok(true, '（配置里没有长周期股票，跳过）');
    }
  }

  {
    // tick 里确实接了结算：跑一段很长的现实时间，flow 必须衰减
    const s = C.createState();
    s.realm = 1;
    s.money = new D(1e12);
    C.buyStock(s, tianji.id, 8000);
    const before = C.stockFlow(s, tianji.id);
    const impBefore = Math.abs(C.stockImpact(s, tianji) - 1);
    C.tick(s, 3600 * 24 * 365 * 3, { offline: false });
    ok(C.stockPeriod(tianji, s.playTime) >= 3, 'tick 把行情推进了至少 3 期',
      String(C.stockPeriod(tianji, s.playTime)));
    ok(C.stockFlow(s, tianji.id) < before, 'tick 之后净买入流已衰减',
      String(C.stockFlow(s, tianji.id)) + ' < ' + String(before));
    ok(Math.abs(C.stockImpact(s, tianji) - 1) <= impBefore, 'tick 之后冲击不比原来更大');
  }
}

console.log('\n=== 股市 · 与公司商品的联动 ===');
{
  const chipsci = C.stockById('chipsci');
  const chip = C.goodById(chipsci.link);
  const per = C.stockPeriodSeconds(chipsci);

  ok(!!chip, '算力芯科声明了关联商品');

  const w = GAME.stock.linkWeight;
  const s = C.createState();
  s.realm = 1;
  s.playTime = per * 5 + 60;
  const base = C.stockNaturalPrice(s, chipsci).toNumber();
  // 联动因子吃的是「关联商品的实际价格水平 / 基准价」这个整体倍数：
  //   F = 商品行情倍数（goodsPrice / basePrice，不含抛压）× 行业传导
  //   I = 抛压冲击（goodsPriceWith / goodsPrice）
  // 于是无抛压时 M₀ = F、被压后 M₁ = F × I，
  // 而 联动因子 = 1 + (M − 1) × linkWeight。
  const goodsBase = C.goodsPrice(chip, s.playTime).toNumber();
  const F = (goodsBase / chip.basePrice) * C.industryPriceIndex(s, chip.industry);
  ok(Math.abs(F - 1) > 1e-6, '前置：关联商品的行情本身已偏离基准价',
    F.toFixed(6));

  // 用一份「轻抛压」：幅度小到不会碰到商品价格的绝对下限，
  // 这样比值才等价于公式本身，而不是被 floor 截断过的值。
  s.company.pressure[chip.id] = 0.1;
  const after = C.stockNaturalPrice(s, chipsci).toNumber();
  // 抛压冲击要单独取：goodsPriceWith 里已经含了传导，直接相除会把传导算进 I 里去
  const I = C.marketImpactAt(s, chip, C.goodsPeriod(chip, s.playTime));
  ok(I < 1, '前置：关联商品确实被抛压压低了', I.toFixed(6));
  ok(after < base, '公司商品被砸价时关联股票自然价同步下降',
    base.toFixed(2) + ' → ' + after.toFixed(2));

  const lf0 = 1 + (F - 1) * w;
  const lf1 = 1 + (F * I - 1) * w;
  ok(Math.abs(after / base - lf1 / lf0) < 1e-9,
    '联动幅度 = 商品价格倍数按 linkWeight 打折（部分联动）',
    (after / base).toFixed(6) + ' vs ' + (lf1 / lf0).toFixed(6));
  ok(Math.abs(after / base - I) > 1e-6,
    '不是完全联动（完全联动时比值应恰为商品的变动倍数 ' + I.toFixed(4) + '）');

  // 没有抛压时，商品的「行情」本身也会传导过去
  {
    const clean = C.createState();
    clean.realm = 1;
    clean.playTime = per * 5 + 60;
    ok(Math.abs(C.stockLinkFactor(clean, chipsci, 5) - 1) > 1e-6,
      '即使关联商品无抛压，其行情波动也会传导给关联股票',
      C.stockLinkFactor(clean, chipsci, 5).toFixed(6));
  }

  // 无关联的股票不受影响
  const tianji = C.stockById('tianji');
  ok(!tianji.link, '天机阁是独立行情（无联动）');
  const a = C.stockNaturalPrice(s, tianji).toNumber();
  s.company.pressure.chip = 1;      // 拉满抛压
  ok(C.stockNaturalPrice(s, tianji).toNumber() === a, '抛压不影响无关联的股票');

  const s2 = C.createState();
  s2.realm = 1;
  ok(C.stockLinkFactor(s2, tianji, 5) === 1, '无关联时联动因子恒为 1');
}

console.log('\n=== 股市 · 概览与序列化往返 ===');
{
  const tianji = C.stockById('tianji');
  const chipsci = C.stockById('chipsci');

  ok(C.stockSummary(null) === null, '空状态返回 null');
  ok(C.stockSummary({}) === null, '没有 stock 段的状态返回 null');

  {
    const s = C.createState();
    s.realm = 1;
    s.money = new D(1e12);
    C.buyStock(s, tianji.id, 3000);
    C.buyStock(s, chipsci.id, 50);

    const sum = C.stockSummary(s);
    ok(sum && sum.stocks.length === GAME.stock.stocks.length, '概览列出全部股票');
    ok(sum.unlocked === true, '概览标注已开户');

    let wantValue = new D(0);
    let wantCost = new D(0);
    for (const x of sum.stocks) {
      wantValue = wantValue.add(x.value);
      wantCost = wantCost.add(x.cost);
      // 清仓可变现必然 ≤ 市值：市值里含着自己买出来的冲击溢价
      ok(x.liquidateValue.lte(x.value.add(new D(1e-15))),
        x.name + '：清仓可变现 ≤ 按现价算的市值',
        x.liquidateValue.toString() + ' vs ' + x.value.toString());
      ok(x.liquidatePnl.lte(x.pnl.add(new D(1e-15))),
        x.name + '：可变现盈亏 ≤ 账面浮动盈亏');
      ok(x.avgCost.gte(0), x.name + '：均价非负');
      ok(x.heldRatio >= 0 && x.heldRatio <= 1, x.name + '：持仓占比在 [0,1]');
      if (x.shares > 0) ok(x.heldRatio > 0, x.name + '：有持仓时占比 > 0');
      else ok(x.heldRatio === 0, x.name + '：无持仓时占比为 0');
      ok(typeof x.trend === 'string', x.name + '：给出涨跌标记');
      ok(x.maxBuy >= 0, x.name + '：给出最大可买量');
    }
    ok(sum.totalValue.eq(wantValue), '总市值 = 各股市值之和');
    ok(sum.totalCost.eq(wantCost), '总成本 = 各股成本之和');
    ok(sum.pnl.eq(sum.totalValue.sub(sum.totalCost)), '浮动盈亏 = 市值 − 成本');
    ok(sum.liquidateValue.lt(sum.totalValue), '清仓可变现低于按现价算的总市值');
    ok(sum.totalFee.gt(0), '累计手续费已统计');
    ok(sum.totalTrades === 2, '成交笔数已统计', String(sum.totalTrades));
    ok(sum.peak > 0, '给出冲击峰值', String(sum.peak));
    ok(sum.fee === GAME.stock.fee && sum.minOrder === GAME.stock.minOrder,
      '概览回传了费率与最小成交额');
  }

  {
    // 序列化 / 反序列化
    const s = C.createState();
    s.realm = 1;
    s.money = new D(1e12);
    s.playTime = 5 * C.stockPeriodSeconds(tianji) + 30;
    C.buyStock(s, tianji.id, 1500);

    const raw = C.serialize(s);
    ok(!!raw.stock, '序列化含 stock 段');
    const h = C.hydrate(raw);
    ok(C.stockShares(h, tianji.id) === 1500, '持仓股数可往返');
    ok(C.stockFlow(h, tianji.id) === 1500, '净买入流可往返');
    ok(C.stockCost(h, tianji.id).eq(C.stockCost(s, tianji.id)), '持仓成本可往返');
    ok(h.stock.realized.eq(s.stock.realized), '已实现盈亏可往返');
    ok(h.stock.totalFee.eq(s.stock.totalFee), '累计手续费可往返');
    ok(h.stock.totalTrades === s.stock.totalTrades, '成交笔数可往返');
    ok(h.stock.lastPeriod[tianji.id] === s.stock.lastPeriod[tianji.id], '期数游标可往返');
    // 注意：往返一次后 lastPeriod 会被夹到当前期（这是预期的防作弊行为），
    // 所以「完全一致」要从第二次往返开始比 —— 那之后状态才是稳定的不动点。
    const raw2 = C.serialize(h);
    ok(JSON.stringify(C.serialize(C.hydrate(raw2))) === JSON.stringify(raw2),
      '二次序列化起进入稳定态（完全一致）');
  }

  {
    // hydrate 的防作弊 / 防越界
    const s = C.createState();
    s.realm = 1;
    s.money = new D(1e12);
    s.playTime = 3 * C.stockPeriodSeconds(tianji) + 5;
    C.buyStock(s, tianji.id, 1200);
    const raw = C.serialize(s);

    const neg = JSON.parse(JSON.stringify(raw));
    neg.stock.shares[tianji.id] = -50;
    neg.stock.flow[tianji.id] = -999999;
    neg.stock.cost[tianji.id] = { m: -1, e: 0 };
    const hn = C.hydrate(neg);
    ok(C.stockShares(hn, tianji.id) === 0, '负持仓被夹到 0');
    ok(Math.abs(C.stockFlow(hn, tianji.id)) <= C.stockDepth(tianji),
      '净买入流被夹在 ±流通盘内', String(C.stockFlow(hn, tianji.id)));
    ok(C.stockCost(hn, tianji.id).isZero(), '负成本被夹到 0');

    const big = JSON.parse(JSON.stringify(raw));
    big.stock.shares[tianji.id] = 1e12;
    ok(C.stockShares(C.hydrate(big), tianji.id) === C.stockDepth(tianji),
      '超流通盘的持仓被夹到流通盘', String(C.stockShares(C.hydrate(big), tianji.id)));

    // 清仓状态下残留的成本必须被清掉，否则下次开仓的均价会算歪
    const ghost = JSON.parse(JSON.stringify(raw));
    ghost.stock.shares[tianji.id] = 0;
    ghost.stock.cost[tianji.id] = { m: 12345, e: 3 };
    ok(C.stockCost(C.hydrate(ghost), tianji.id).isZero(),
      '无持仓时的残留成本被清零');

    const ahead = JSON.parse(JSON.stringify(raw));
    ahead.stock.lastPeriod[tianji.id] = 99999;
    const ha = C.hydrate(ahead);
    ok(ha.stock.lastPeriod[tianji.id] <= C.stockPeriod(tianji, ha.playTime),
      'lastPeriod 不允许超前于当前期（否则冲击永远等不到衰减）',
      String(ha.stock.lastPeriod[tianji.id]));

    const junk = JSON.parse(JSON.stringify(raw));
    junk.stock.totalTrades = -7;
    junk.stock.realized = { m: -1, e: 20 };
    const hj = C.hydrate(junk);
    ok(hj.stock.totalTrades >= 0, '负成交笔数被夹到 0', String(hj.stock.totalTrades));
    // 已实现盈亏为负是**合法状态**（做亏了），不能夹成 0，否则账面会凭空变好
    ok(hj.stock.realized.eq(new D(-1, 20)), '负的已实现盈亏（真实亏损）被原样保留',
      hj.stock.realized.toString());

    const nan = JSON.parse(JSON.stringify(raw));
    nan.stock.totalTrades = 'abc';
    nan.stock.shares[tianji.id] = 'xyz';
    const hnan = C.hydrate(nan);
    ok(hnan.stock.totalTrades === 0, '非法成交笔数回落为 0');
    ok(C.stockShares(hnan, tianji.id) === 0, '非法持仓回落为 0');
  }

  {
    // 新号初始状态自洽
    const s = C.createState();
    ok(!!s.stock, '新号带 stock 段');
    ok(s.stock.realized.isZero(), '已实现盈亏初始为 0');
    ok(s.stock.totalFee.isZero(), '累计手续费初始为 0');
    ok(s.stock.totalTrades === 0, '成交笔数初始为 0');
    for (const st of GAME.stock.stocks) {
      if (C.stockShares(s, st.id) !== 0) { ok(false, st.id + ' 初始持仓应为 0'); }
      if (C.stockFlow(s, st.id) !== 0) { ok(false, st.id + ' 初始净买入流应为 0'); }
      if (!C.stockCost(s, st.id).isZero()) { ok(false, st.id + ' 初始成本应为 0'); }
    }
    ok(true, '所有股票初始持仓 / 流 / 成本均为 0');
    ok(C.stockImpact(s, C.stockById('tianji')) === 1, '新号冲击系数为 1');
  }

  {
    // 离线预览必须带上股市汇总
    const s = C.createState();
    s.realm = 1;
    s.money = new D(1e12);
    C.buyStock(s, tianji.id, 2000);
    const prev = C.previewOffline(s, 3600, true);
    ok(!!prev.stock, '离线预览含 stock 段');
    ok(prev.stock.totalTrades >= 0, '离线预览给出成交笔数');
    ok(prev.stock.realized !== undefined, '离线预览给出已实现盈亏');
    ok(prev.stock.totalValue !== undefined, '离线预览给出持仓市值');
  }
}

// ============================================================
console.log('\n=== 渡劫（突破境界的门槛） ===');
{
  const CFG = GAME.tribulation;
  ok(!!CFG && CFG.implemented === true, '渡劫系统已启用');
  ok(Array.isArray(CFG.baseRate) && CFG.baseRate.length >= GAME.realms.length,
    '成功率表覆盖全部境界', String((CFG.baseRate || []).length) + ' vs ' + GAME.realms.length);
  ok(CFG.baseRate[0] > CFG.baseRate[Math.min(4, CFG.baseRate.length - 1)],
    '境界越高基础成功率越低', CFG.baseRate.slice(0, 5).join(' → '));

  // —— 灵气未满不可渡 ——
  const s0 = C.createState();
  ok(!C.tribulationReady(s0), '灵气未满时不可渡劫');
  const r0 = C.doTribulation(s0);
  ok(r0.ok === false, '灵气未满时渡劫被拒', r0.msg);

  // —— 灵气满格：金丹 → 元婴 ——
  const mk = (realm) => {
    const s = C.createState();
    s.realm = realm;
    s.qi = new D(GAME.realms[realm].need);
    s.learned = { jiuzhang: { mastery: 0, tier: 5, passive: true } };
    return s;
  };
  const sA = mk(3);
  const odds = C.tribulationOdds(sA);
  ok(odds.rate > 0 && odds.rate <= (CFG.maxRate || 0.95),
    '成功率落在 (0, maxRate] 内', String(odds.rate));
  ok(odds.base === CFG.baseRate[3], '成功率含境界基础项', String(odds.base));
  ok(odds.perfectAdd === (CFG.prepare.perfectPer || 0) * 1,
    '每本修满功法提供造诣加成', String(odds.perfectAdd));
  ok(odds.computeAdd === 0, '算力恰在基准时冗余为 0', String(odds.computeAdd));

  // 算力冗余：每高 10 倍 +perDecade，且封顶
  const sB = mk(3);
  sB.realCompute = new D(CFG.prepare.computeBase[3] * 1e3);
  const oddsB = C.tribulationOdds(sB);
  ok(oddsB.computeAdd > odds.computeAdd, '算力更厚时冗余加成更高',
    oddsB.computeAdd + ' > ' + odds.computeAdd);
  ok(oddsB.computeAdd <= (CFG.prepare.computeCap || 0.15) + 1e-12,
    '算力冗余不超过上限', String(oddsB.computeAdd));

  // —— 成功分支 ——
  const sC = mk(2);   // 筑基 → 金丹
  let okC = null;
  for (let k = 0; k < 4000 && !okC; k++) {
    sC.playTime = k * 60;
    const r = C.doTribulation(sC);
    if (r.ok && r.success) okC = { r: r, s: sC };
  }
  ok(!!okC, '存在成功的渡劫样本');
  if (okC) {
    ok(okC.r.realm === 3 && okC.s.realm === 3, '渡劫成功后境界 +1', String(okC.s.realm));
    ok(okC.s.tribulation.level === 1, '渡劫成功后淬体 +1 层', String(okC.s.tribulation.level));
    ok(okC.s.qi.lt(new D(GAME.realms[2].need)), '成功后扣除本次突破所需灵气', okC.s.qi.toString());
    ok(C.tribulationBonus(okC.s, 'qiSpeed') > 0, '淬体层数带来永久加成');
  }

  // —— 失败分支：元婴以下全清 ——
  const wipeRealm = (CFG.passiveRules || {}).belowRealm || 4;
  let failS = null;
  for (let k = 0; k < 6000 && !failS; k++) {
    const s = mk(wipeRealm - 1);
    s.playTime = k * 60;
    s.devices.pc = 30;
    s.money = new D(1e9);
    s.spiritStone = new D(500);
    s.aiBonus = new D(777);
    s.learned = { jiuzhang: { mastery: 500, tier: 3, passive: true } };
    s.technique = 'jiuzhang';
    s.jobDone.flyer = 9; s.totalJobs = 40;
    C.foundCompany(s);
    s.stock.shares[GAME.stock.stocks[0].id] = 12;
    s.rebirth.count = 1; s.rebirth.daoTotal = 200; s.tribulation.level = 3;
    const r = C.doTribulation(s);
    if (r.ok && !r.success) failS = { r: r, s: s };
  }
  ok(!!failS, '存在失败的渡劫样本（元婴之下）');
  if (failS) {
    ok(failS.r.fullWipe === true, '元婴以下失败标记为全清');
    ok(failS.s.realm === 0, '失败后退回凡人', String(failS.s.realm));
    ok(failS.s.devices.pc === 0, '全清会抹掉设备');
    ok(Object.keys(failS.s.learned).length === 0, '全清会抹掉功法');
    ok(failS.s.technique === null, '全清会清掉当前修炼');
    ok(failS.s.aiBonus.isZero(), '全清会清掉 AI 加成');
    ok(failS.s.company.founded === false, '全清会撤销公司');
    ok(failS.s.stock.shares[GAME.stock.stocks[0].id] === 0, '全清会清空持仓');
    ok(failS.s.jobDone.flyer === 9 && failS.s.totalJobs === 40,
      '工作履历保留（否则升职链要重跑）');
    ok(failS.s.rebirth.count === 2 && failS.s.rebirth.daoTotal > 200,
      '道行仍按被动比例结算并累计');
    ok(failS.s.tribulation.level === 3, '淬体层数跨兵解保留');
    ok(failS.s.playTime >= 0 && failS.s.gameSeconds >= 0, '时间不倒流');
  }

  // —— 确定性：同一状态必然得到同一结果（前后端各跑一遍必须一致）——
  {
    const a = mk(2); a.playTime = 1234;
    const b = C.hydrate(C.serialize(a));
    ok(C.tribulationRoll(a) === C.tribulationRoll(b),
      '渡劫 roll 是状态的纯函数（存档往返不变）');
    const ra = C.doTribulation(a);
    const rb = C.doTribulation(b);
    ok(ra.success === rb.success, '两端渡劫结果一致',
      ra.success + ' vs ' + rb.success);
  }

  // —— tick 的 tribulation:false 选项：浏览器端用它把渡劫交给服务端 ——
  {
    const s = mk(1);
    s.autoTribulation = true;
    const before = s.realm;
    C.tick(s, 5, { offline: false, tribulation: false });
    ok(s.realm === before, 'tribulation:false 时不自动渡劫', String(s.realm));
    ok(s.qi.gte(new D(GAME.realms[1].need)), '灵气仍在累积（满格待渡）');
  }

  // —— serialize / hydrate 带上渡劫字段 ——
  {
    const s = mk(1);
    s.tribulation.level = 7; s.tribulation.attempts = 11; s.tribulation.failures = 4;
    s.autoTribulation = false;
    const b = C.hydrate(C.serialize(s));
    ok(b.tribulation.level === 7 && b.tribulation.attempts === 11 &&
       b.tribulation.failures === 4, '渡劫计数随存档往返');
    ok(b.autoTribulation === false, '自动渡劫开关随存档往返');
    s.tribulation.level = 9999;
    ok(C.hydrate(C.serialize(s)).tribulation.level <= (CFG.maxLevel || 40),
      '淬体层数被夹到 maxLevel（防手改存档）');
  }
}

// ============================================================
console.log('\n=== 投向 · 显示口径与可用性 ===');
{
  const s = C.createState();
  s.realm = 2;
  s.realCompute = new D(1e5);
  s.learned = { jiuzhang: { mastery: 0, tier: 0, passive: false } };
  s.technique = 'jiuzhang';

  const xi = GAME.investments.find((i) => i.id === 'xiuxian');
  const ai = GAME.investments.find((i) => i.id === 'ai');
  ok(xi.unit === 'qi' && ai.unit === 'compute', '投向声明了各自的显示量纲');

  // 修仙方向的显示值必须含灵气倍率（否则玩家看到的数字比实际小几个数量级）
  C.setAllocation(s, { xiuxian: 1 });
  const raw = C.investOutput(s, xi).toNumber();
  const rate = C.investOutputRate(s, xi);
  ok(rate === raw * C.qiMultiplier(s),
    '修仙方向显示值 = 裸产出 × 灵气倍率',
    rate.toFixed(2) + ' vs ' + raw.toFixed(2) + ' × ' + C.qiMultiplier(s).toFixed(2));
  ok(rate > raw, '修仙方向显示值不低于裸产出（早期倍率 ≥ 1）');

  // AI 方向显示的是「算力/秒」而不是中间量
  C.setAllocation(s, { ai: 1 });
  const aiRaw = C.investOutput(s, ai).toNumber();
  const aiRate = C.investOutputRate(s, ai);
  ok(Math.abs(aiRate - aiRaw * (ai.aiToCompute || 0)) < 1e-9,
    'AI 方向显示值 = 产出 × aiToCompute（算力/秒）');
  ok(aiRate > 0, 'AI 方向给出正的算力增量');

  // 数值重平衡：拉满修仙投向在筑基期算力下，静态积累时间应是「小时级」而非「天级」
  const sJ = C.createState();
  sJ.realm = 2;
  sJ.learned = { jiuzhang: { mastery: 0, tier: 0, passive: false } };
  sJ.technique = 'jiuzhang';
  sJ.realCompute = new D(1e5);
  C.setAllocation(sJ, { xiuxian: 1 });
  const qiPerSec = C.investOutputRate(sJ, xi);
  const need = GAME.realms[2].need;
  const staticSec = need / Math.max(1e-9, qiPerSec);
  ok(staticSec < 6 * 3600,
    '筑基期拉满修仙投向的静态积累时间 ≤ 6 小时（早先是几十小时）',
    (staticSec / 3600).toFixed(1) + ' h（灵气 ' + qiPerSec.toFixed(1) + ' / 秒，阈值 ' + need + '）');

  // 锁定文案
  const sEmpty = C.createState();
  ok(C.investmentLockReason(sEmpty, GAME.investments.find((i) => i.id === 'technique')) === '未习得功法',
    '功法增幅锁定文案 = 未习得功法');
  ok(C.investmentLockReason(sEmpty, GAME.investments.find((i) => i.id === 'industry')) === '未成立公司',
    '工业产能锁定文案 = 未成立公司');
}

// ============================================================
console.log('\n=== 工作系统 · 灵石来源与设备节奏匹配 ===');
{
  const stoneJobs = GAME.jobs.filter((j) => j.stone > 0);
  ok(stoneJobs.length >= 4, '存在多档灵石工作', String(stoneJobs.length));
  // 首个需要灵石的设备
  const stoneDev = GAME.devices.find((d) => (d.stoneCost || 0) > 0);
  ok(!!stoneDev, '存在需要灵石的设备');
  const first = stoneJobs[0];
  ok(first.unlock.realm >= 4,
    '首个灵石工作在元婴及以上（与修仙 × 科技设备同步开放）',
    first.id + '@r' + first.unlock.realm);
  // 按精力上限估算：刷满首台设备所需灵石的耗时应该是「几十分钟」而不是「一天」
  const realm = GAME.realms[GAME.realms.length - 1];
  const perJob = first.stone;
  const secs = stoneDev.stoneCost / perJob * first.energy;   // 精力恢复 1/秒
  ok(secs < 2 * 3600,
    '刷满「' + stoneDev.name + '」所需灵石 ≤ 2 小时（精力约束下）',
    Math.round(secs / 60) + ' 分钟（' + stoneDev.stoneCost + ' 灵石 × ' + first.energy + ' 精力 / ' + perJob + ' 颗）');
  // 灵石工作的解锁链不能过长：前置工作完成次数 ≤ 15
  ok((first.unlock.after || {}).times <= 15,
    '首个灵石工作的前置完成次数 ≤ 15（避免「钱够了拿不到灵石」）',
    JSON.stringify(first.unlock.after));
}

// ============================================================
console.log('\n=== v3.3 · 精力恢复随境界 / 熟练度主属性 / 稀有度阶梯 / 时间控制 ===');
{
  // —— 精力恢复随境界抬升 ——
  const sR = C.createState();
  let prevRegen = 0;
  let regenMono = true;
  const regenList = [];
  for (let r = 0; r < GAME.realms.length; r++) {
    sR.realm = r;
    const g = C.energyRegen(sR);
    regenList.push(GAME.realms[r].name + ' ' + g);
    if (g < prevRegen) regenMono = false;
    prevRegen = g;
  }
  ok(regenMono, '精力恢复速度随境界单调递增', regenList.join(' → '));
  ok(C.energyRegen(sR) > GAME.energy.regenPerSecond,
    '最高境的恢复速度高于凡人基准（不再恒为 1）',
    C.energyRegen(sR) + ' > ' + GAME.energy.regenPerSecond);
  // 元婴期做一份 520 精力的工作，等待时间应在一分钟量级（旧口径要 520 秒）
  const sYuan = C.createState(); sYuan.realm = 4;
  const waitSec = 520 / C.energyRegen(sYuan);
  ok(waitSec < 120, '元婴期 520 精力的等待 ≤ 2 分钟（旧口径 520 秒）',
    Math.round(waitSec) + ' 秒');
  // tick 里的恢复确实用了逐境速度
  const sTick = C.createState(); sTick.realm = 4; sTick.energy = 0;
  C.tick(sTick, 10, { offline: false });
  ok(Math.abs(sTick.energy - 10 * C.energyRegen(sTick)) < 1e-6,
    'tick 的精力恢复按当前境界的速度走',
    sTick.energy + ' vs ' + (10 * C.energyRegen(sTick)));

  // —— 熟练度段位影响主属性 ——
  const sT = C.createState(); sT.realm = 4; sT.realCompute = new D(1e6);
  const tech = GAME.techniques.list[0];
  sT.learned[tech.id] = { mastery: 0, tier: 0, passive: false };
  const at = (t) => { sT.learned[tech.id].tier = t; return C.techMainQiSpeed(sT, tech); };
  const v0 = at(0), v5 = at(5), v3 = at(3);
  ok(v5 > v3 && v3 > v0, '熟练度越高主属性越强',
    v0.toFixed(3) + ' < ' + v3.toFixed(3) + ' < ' + v5.toFixed(3));
  const mm = GAME.techniques.masteryMain || {};
  ok(Math.abs(v0 / v5 - (mm.base || 0.5) / ((mm.base || 0.5) + 5 * (mm.perTier || 0.1))) < 1e-9,
    '熟练系数 = base + perTier × 段位（入门 0.5 → 圆满 1.0）');

  // —— 稀有度阶梯：天最稀有、荒最普遍 ——
  const R = GAME.techniques.rarities;
  ok(R[0].name === '荒' && R[R.length - 1].name === '天',
    '稀有度阶梯从荒到天', R.map((r) => r.name + r.level).join(' '));
  ok(R.every((r, i) => i === 0 || r.mainQiSpeed > R[i - 1].mainQiSpeed),
    '稀有度越高主属性基值越强',
    R.map((r) => r.mainQiSpeed).join(' < '));
  // 功法的数学深度与稀有度必须同向（列表按深奥程度升序，稀有度 level 也须升序）
  const lvOf = (id) => (R.find((r) => r.id === id) || {}).level || 0;
  const list = GAME.techniques.list;
  let lvMono = true;
  for (let i = 1; i < list.length; i++) {
    if (lvOf(list[i].rarity) < lvOf(list[i - 1].rarity)) lvMono = false;
  }
  ok(lvMono, '功法表的稀有度随数学深度递增',
    list.map((t) => t.name + '/' + t.rarity).join(' → '));
  ok(list.length >= GAME.realms.length,
    '功法数量覆盖境界数（每境至少一本可修）', String(list.length));

  // —— 游戏时间暂停 ——
  const sP = C.createState();
  const sp0 = C.gameSecondsPerRealSecond(sP);
  sP.timePaused = true;
  ok(C.gameSecondsPerRealSecond(sP) === 0, '暂停时游戏时间停走');
  ok(C.energyRegen(sP) > 0, '暂停不影响精力恢复（走现实时间）');
  sP.timePaused = false;
  ok(C.gameSecondsPerRealSecond(sP) === sp0, '恢复后回到原档位');
  C.setTimePaused(sP, true);
  ok(sP.timePaused === true, 'setTimePaused 可切换');
  const g0 = sP.gameSeconds;
  C.tick(sP, 10, { offline: false });
  ok(sP.gameSeconds === g0, '暂停期间 tick 不推进游戏时间', sP.gameSeconds + ' vs ' + g0);
  ok(sP.energy > 100 || sP.energy >= C.maxEnergy(sP), '暂停期间精力照常恢复');

  // —— 行情前瞻（事件通知栏用）——
  const sF = C.createState(); sF.realm = 4;
  const st0 = GAME.stock.stocks[0];
  const f = C.stockForecastPct(sF, st0);
  ok(typeof f === 'number' && Number.isFinite(f), 'stockForecastPct 给出有限值',
    String(f));
  // 确定性：同一状态两次计算一致
  ok(f === C.stockForecastPct(sF, st0), '行情前瞻是确定性的');
}

console.log('\n=== v3.4 · 转生衰减快照 / 功法成就解锁 / 功法规模 ===');
{
  // —— 转生衰减快照：兵解后新买的设备全额累加 ——
  const sA = C.createState(); sA.realm = 4;
  const dev = GAME.devices.find((d) => d.id === 'leyline');
  sA.devices[dev.id] = 1;
  C.doRebirth(sA, 'active');
  const effBefore = C.deviceComputeEffective(sA).toNumber();
  ok('兵解后旧存量仍被压数量级', effBefore < Number(C.totalCompute(sA)),
    effBefore.toExponential(2) + ' < ' + C.totalCompute(sA).toString());
  sA.money = new D(1e30); sA.spiritStone = new D(1e15);
  C.buyDevice(sA, dev.id);
  const effAfter = C.deviceComputeEffective(sA).toNumber();
  ok('兵解后新买设备全额累加（增量 = 设备算力）',
    Math.abs((effAfter - effBefore) - dev.compute) < dev.compute * 1e-9,
    (effAfter - effBefore).toExponential(2) + ' vs ' + dev.compute.toExponential(2));
  // 神识倍率同步增长
  const m1 = C.shenshiDeviceMultiplier(sA);
  C.buyDevice(sA, dev.id);
  ok('新设备也全额累加进神识倍率', C.shenshiDeviceMultiplier(sA) > m1,
    m1.toFixed(3) + ' → ' + C.shenshiDeviceMultiplier(sA).toFixed(3));
  // 快照随存档往返
  const backA = C.hydrate(C.serialize(sA));
  ok('快照随存档往返且有效算力一致',
    C.deviceComputeEffective(backA).eq(C.deviceComputeEffective(sA)),
    C.deviceComputeEffective(backA).toString());
  // 旧存档迁移：无快照字段 → hydrate 补拍，之后买设备仍全额累加
  const legacy = JSON.parse(JSON.stringify(C.serialize(sA)));
  delete legacy.rebirth.baseCompute; delete legacy.rebirth.baseShenshi;
  const mig = C.hydrate(legacy);
  const mBefore = C.deviceComputeEffective(mig).toNumber();
  mig.money = new D(1e30); mig.spiritStone = new D(1e15);
  C.buyDevice(mig, dev.id);
  ok('旧存档迁移后买设备仍全额累加',
    Math.abs((C.deviceComputeEffective(mig).toNumber() - mBefore) - dev.compute)
      < dev.compute * 1e-9);
  // 未兵解：衰减恒等
  const sN = C.createState();
  ok('未兵解时有效算力 = 原始算力', C.deviceComputeEffective(sN).eq(C.totalCompute(sN)));

  // —— 功法成就解锁 ——
  const sC = C.createState(); sC.realm = 4;
  const condOf = (id) => GAME.techniques.list.find((t) => t.id === id);
  ok('条件未达成时不可解锁', !C.techUnlockConditionMet(sC, condOf('chousuan')));
  sC.totalJobs = 3;
  ok('完成工作 ≥3 解锁筹算小术', C.techUnlockConditionMet(sC, condOf('chousuan')));
  ok('每本功法都有解锁文案',
    C.techniqueList(sC).every((t) => t.unlockText && t.unlockText.length > 0),
    C.techniqueList(sC).filter((t) => !t.unlockText).map((t) => t.id).join(','));
  // 稀有度规模：每级 ≥5，除天外每级 ≥1 本境界解锁
  const byR = {};
  for (const r of GAME.techniques.rarities) byR[r.id] = { total: 0, realm: 0 };
  for (const t of GAME.techniques.list) {
    byR[t.rarity].total += 1;
    if (t.realm) byR[t.rarity].realm += 1;
  }
  ok('每个稀有度至少 5 本功法',
    GAME.techniques.rarities.every((r) => byR[r.id].total >= 5),
    GAME.techniques.rarities.map((r) => r.name + ':' + byR[r.id].total).join(' '));
  ok('除天级外每个稀有度至少 1 本境界解锁',
    GAME.techniques.rarities.filter((r) => r.id !== '天')
      .every((r) => byR[r.id].realm >= 1),
    GAME.techniques.rarities.filter((r) => r.id !== '天')
      .map((r) => r.name + ':' + byR[r.id].realm).join(' '));

  // —— peakPressure 只增与成就联动 ——
  const sP = C.createState(); sP.realm = 4;
  ok('初始 peakPressure = 0', (sP.company.peakPressure || 0) === 0);
  sP.company.peakPressure = 0.42;
  ok('pressurePeak 0.4 达成 / 0.5 未达成',
    C.techUnlockConditionMet(sP, condOf('fubian')) &&
    !C.techUnlockConditionMet(sP, condOf('tuoyuan')));
  const backP = C.hydrate(C.serialize(sP));
  ok('peakPressure 随存档往返', Math.abs(backP.company.peakPressure - 0.42) < 1e-9,
    String(backP.company.peakPressure));
}

console.log('\n' + '='.repeat(46));
console.log('  通过  ' + pass + '   失败  ' + fail);
console.log('='.repeat(46) + '\n');
process.exit(fail > 0 ? 1 : 0);
