/**
 * 端到端接口测试
 * 用法: node tests/e2e.js
 */

const BASE = 'http://localhost:3210';

/** 把存档里的 {m,e} 还原成精确的 JS number（用于断言里做比较） */
function num(o) {
  if (o == null) return NaN;
  if (typeof o === 'number') return o;
  return o.m * Math.pow(10, o.e);
}

/** 粗略比较两个 {m,e} 是否相等（容忍浮点误差） */
function near(a, b, tol) {
  tol = tol || 1e-6;
  const x = num(a), y = num(b);
  return Math.abs(x - y) <= tol * Math.max(1, Math.abs(y));
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

async function req(path, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers['x-token'] = opts.token;
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

(async function main() {
  const user = 'test_' + Date.now().toString(36);
  let token = null;

  console.log('\n=== 1. 认证 ===');
  {
    let r = await req('/api/register', { method: 'POST', body: { username: 'a', password: '1234' } });
    ok(r.status === 400, '用户名过短被拒', JSON.stringify(r.data));

    r = await req('/api/register', { method: 'POST', body: { username: user, password: '123' } });
    ok(r.status === 400, '密码过短被拒', JSON.stringify(r.data));

    r = await req('/api/register', { method: 'POST', body: { username: user, password: 'test1234' } });
    ok(r.data.ok === true && !!r.data.token, '注册成功并返回 token');
    token = r.data.token;

    r = await req('/api/register', { method: 'POST', body: { username: user, password: 'test1234' } });
    ok(r.status === 400, '重复用户名被拒');

    r = await req('/api/me');
    ok(r.status === 401, '无 token 访问被拒');

    r = await req('/api/me', { token: 'deadbeef' });
    ok(r.status === 401, '错误 token 被拒');

    r = await req('/api/me', { token });
    ok(r.data.ok === true && r.data.username === user, 'token 校验通过');

    r = await req('/api/login', { method: 'POST', body: { username: user, password: 'wrong' } });
    ok(r.status === 400, '错误密码被拒');

    r = await req('/api/login', { method: 'POST', body: { username: user, password: 'test1234' } });
    ok(r.data.ok === true, '正确密码登录成功');
    token = r.data.token;
  }

  console.log('\n=== 2. 首次读取存档 ===');
  let snap = null;
  {
    const r = await req('/api/load', { token });
    ok(r.data.ok === true, 'load 成功');
    ok(r.data.isNew === true, '识别为新玩家');
    ok(near(r.data.state.money, { m: 2, e: 1 }), '初始金钱 = 20', JSON.stringify(r.data.state.money));
    ok(r.data.state.realm === 0, '初始境界 = 凡人');
    ok(r.data.state.alloc.xiuxian === 1, '初始算力全投修仙');
    ok(r.data.state.alloc.technique === 0, '功法增幅初始为 0（未习得功法）');
    ok(Array.isArray(r.data.config.devices) && r.data.config.devices.length >= 10,
      '返回 10 种设备配置', String((r.data.config.devices || []).length));
    const mythDevs = (r.data.config.devices || []).filter((d) => d.stoneCost > 0);
    ok(mythDevs.length >= 5, '返回 5 台「修仙 × 科技」设备', String(mythDevs.length));
    ok(mythDevs.every((d) => d.shenshiBonus > 0), '修仙设备都增幅神识');
    ok(mythDevs.every((d, i) => i === 0 || d.shenshiBonus > mythDevs[i - 1].shenshiBonus),
      '神识增幅越靠后越强',
      mythDevs.map((d) => d.shenshiBonus).join(' < '));

    // 新系统字段
    ok(typeof r.data.state.gameSeconds === 'number', '存档含游戏内时间');
    ok(r.data.state.timeTier === 1, '起始时间档位 = 1', String(r.data.state.timeTier));
    ok(r.data.state.autoTier === false, '不再自动跟随档位（顶栏四键手动控制）');
    ok(r.data.state.timePaused === false, '默认不暂停');
    ok(r.data.state.energy === 100, '初始精力 = 100', String(r.data.state.energy));
    ok(typeof r.data.state.jobId === 'string', '默认已选中工作', String(r.data.state.jobId));
    ok(r.data.state.totalJobs === 0, '工作计数从 0 开始');
    ok(r.data.state.technique === null, '初始未习得功法');

    // 配置下发
    ok(Array.isArray(r.data.config.jobs) && r.data.config.jobs.length >= 10,
      '返回工作列表', String((r.data.config.jobs || []).length) + ' 份');
    ok(Array.isArray(r.data.config.time.tiers) && r.data.config.time.tiers.length === 5,
      '返回 5 个时间档位');
    ok(r.data.config.energy.regenPerSecond === 1, '精力恢复基准 1/秒（凡人）');
    ok(r.data.config.realms.length >= 8, '境界表已扩到 8 层');
    ok(r.data.config.realms.every((x) => typeof x.regen === 'number'),
      '每个境界都带精力恢复速度');
    ok(r.data.config.techniques.implemented === true, '功法系统标记为已实现');
    const rars = r.data.config.techniques.rarities || [];
    ok(rars.length === 8, '返回 8 级稀有度', rars.map((x) => x.name).join(''));
    ok(rars[0].name === '荒' && rars[rars.length - 1].name === '天',
      '稀有度阶梯：荒最普遍 → 天最稀有');
    ok((r.data.config.techniques.mastery || []).length === 6, '返回 6 段熟练度',
      (r.data.config.techniques.mastery || []).map((x) => x.name).join('/'));
    ok((r.data.config.techniques.list || []).length >= 6, '返回功法表',
      String((r.data.config.techniques.list || []).length));
    ok(r.data.config.shenshi.computePerPointRealm > 0, '神识配置已下发');
    ok(r.data.config.investments.some((i) => i.id === 'technique' && i.locked === true),
      '功法增幅项标记为锁定');

    snap = r.data.state;
  }

  console.log('\n=== 3. 服务端权威操作 ===');
  {
    // ---- 催工（替代旧的 work） ----
    const r = await req('/api/action', { token, method: 'POST', body: { action: 'rushJob', payload: { times: 5 } } });
    ok(r.data.ok === true, 'rushJob 成功', JSON.stringify(r.data.msg || ''));
    ok(r.data.result.done === 5, '催工完成 5 份', String(r.data.result.done));
    ok(r.data.result.money.m > 0, '催工有金钱收益', JSON.stringify(r.data.result.money));
    ok(r.data.state.totalJobs === 5, '工作总次数 = 5', String(r.data.state.totalJobs));
    ok(r.data.state.rushCount === 5, '催工次数 = 5', String(r.data.state.rushCount));
    ok(Math.abs(r.data.state.energy - (100 - 6 * 5)) < 1e-6, '精力被扣除（6 点/份）',
      String(r.data.state.energy));

    // 精力不足时只能完成能做的部分
    const rE = await req('/api/action', { token, method: 'POST', body: { action: 'rushJob', payload: { times: 100 } } });
    ok(rE.data.ok === true, '精力不足时催工只完成能做的部分');
    ok(rE.data.result.done < 100, '未完成全部 100 次', String(rE.data.result.done));
    const rE2 = await req('/api/action', { token, method: 'POST', body: { action: 'rushJob', payload: { times: 1 } } });
    ok(rE2.status === 400, '精力为 0 时催工被拒', JSON.stringify(rE2.data.msg));

    // ---- 选择工作：解锁链 ----
    const rJ = await req('/api/action', { token, method: 'POST', body: { action: 'setJob', payload: { jobId: 'delivery' } } });
    ok(rJ.status === 400, '未解锁的工作不能选', JSON.stringify(rJ.data.msg));
    const rJ2 = await req('/api/action', { token, method: 'POST', body: { action: 'setJob', payload: { jobId: 'store' } } });
    ok(rJ2.data.ok === true, '完成 5 次后解锁便利店并可选择', JSON.stringify(rJ2.data.msg || ''));

    // ---- 时间档位 ----
    // 档3（1 秒 = 1 游戏天）要筑基才解锁；档2（常速）凡人即可用
    const rT = await req('/api/action', { token, method: 'POST', body: { action: 'setTimeTier', payload: { tier: 3 } } });
    ok(rT.status === 400, '凡人无法切到未解锁档位', JSON.stringify(rT.data.msg));
    const rT2 = await req('/api/action', { token, method: 'POST', body: { action: 'setTimeTier', payload: { tier: 1 } } });
    ok(rT2.data.ok === true, '可以切到已解锁档位');
    ok(rT2.data.result.auto === false, '切档走手动路径');
    // 档位不再自动跟随（autoTier 已废弃）：切到档1 后 tick 不会自己跳上去
    const rTier2 = await req('/api/action', { token, method: 'POST', body: { action: 'setTimeTier', payload: { tier: 2 } } });
    ok(rTier2.data.ok === true, '凡人可切到档2（常速）');
    const rBack = await req('/api/action', { token, method: 'POST', body: { action: 'setTimeTier', payload: { tier: 1 } } });
    ok(rBack.data.ok === true, '切回档1');

    // ---- 暂停 / 恢复 ----
    const rW = await req('/api/action', { token, method: 'POST', body: { action: 'setWorking', payload: { working: false } } });
    ok(rW.data.result.working === false, '可以暂停自动工作');
    await req('/api/action', { token, method: 'POST', body: { action: 'setWorking', payload: { working: true } } });

    // ---- 购买设备 ----
    // 前面催工刷到的钱足够买第一台设备（个人电脑 50 金）
    const moneyNow = num((await req('/api/load', { token })).data.state.money);
    const r2 = await req('/api/action', { token, method: 'POST', body: { action: 'buyDevice', payload: { deviceId: 'pc' } } });
    if (r2.data.ok) {
      ok(r2.data.state.devices.pc >= 1, '设备数量 ≥ 1', String(r2.data.state.devices.pc));
      ok(r2.data.state.realCompute.m > 0, '算力 > 0', JSON.stringify(r2.data.state.realCompute));
    } else {
      ok(false, '购买个人电脑成功', '当前金钱 ' + moneyNow + '，失败原因: ' + JSON.stringify(r2.data.msg));
    }

    const r3 = await req('/api/action', { token, method: 'POST', body: { action: 'buyDevice', payload: { deviceId: 'nonexist' } } });
    ok(r3.status === 400, '购买不存在的设备被拒');

    const r4 = await req('/api/action', { token, method: 'POST', body: { action: 'nonsense' } });
    ok(r4.status === 400, '未知操作被拒');
  }

  console.log('\n=== 4. 算力分配 ===');
  {
    const r = await req('/api/action', {
      token, method: 'POST',
      body: { action: 'setAllocation', payload: { alloc: { xiuxian: 2, ai: 2, hardware: 0, finance: 0 } } },
    });
    ok(r.data.ok === true, 'setAllocation 成功');
    const sum = Object.values(r.data.state.alloc).reduce((a, b) => a + b, 0);
    ok(Math.abs(sum - 1) < 1e-9, '分配总和归一化到 1', 'sum=' + sum);
    ok(Math.abs(r.data.state.alloc.xiuxian - 0.5) < 1e-9, 'xiuxian = 0.5', String(r.data.state.alloc.xiuxian));
  }

  console.log('\n=== 5. 数值推进（tick） ===');
  {
    // 等 3 秒（低于离线阈值 60s）→ 应按全额结算，且 playTime 必须累加
    const before = (await req('/api/load', { token })).data.state;
    await new Promise((r) => setTimeout(r, 3000));
    const after = (await req('/api/load', { token })).data.state;

    const bMoney = num(before.money);
    const aMoney = num(after.money);
    ok(aMoney > bMoney, '等待后金钱增长', bMoney.toFixed(4) + ' -> ' + aMoney.toFixed(4));

    const bPlay = before.playTime, aPlay = after.playTime;
    ok(aPlay > bPlay, 'playTime 累加（短暂离开不打折）', bPlay.toFixed(2) + ' -> ' + aPlay.toFixed(2));

    // 习得功法后灵气开始产出（本测试账号此前已买下个人电脑 → 已习得第一本功法）
    ok(before.technique !== null, '测试账号已习得功法', String(before.technique));
    const bQi = num(before.qi);
    const aQi = num(after.qi);
    ok(aQi > bQi, '灵气增长（修仙方向有产出）', bQi.toFixed(6) + ' -> ' + aQi.toFixed(6));
    ok(after.learned && after.learned.jiuzhang !== undefined, '存档含功法熟练度记录');

    // 短暂离开不应触发「离线收益」弹窗
    const r = await req('/api/load', { token });
    ok(r.data.offline === null, '3 秒离开不触发离线弹窗', JSON.stringify(r.data.offline));

    // 游戏内时间应随现实时间推进（档1：1 秒 = 10 分钟）
    const dGame = after.gameSeconds - before.gameSeconds;
    ok(dGame > 0, '游戏内时间随现实时间推进', dGame.toFixed(0) + ' 游戏秒');
    ok(dGame >= 3 * 600 * 0.8 && dGame <= 3 * 600 * 2,
      '推进量符合档1 流速（约 1800 游戏秒）', dGame.toFixed(0));

    // 精力按现实时间恢复
    ok(after.energy > before.energy || before.energy >= 100,
      '精力随时间恢复', before.energy + ' -> ' + after.energy);
  }

  console.log('\n=== 5b. 工作系统（接口层） ===');
  {
    const st = (await req('/api/load', { token })).data.state;
    ok(typeof st.jobProgress === 'number', '存档含工作进度');
    ok(st.jobProgress >= 0 && st.jobProgress <= 5 * 3600,
      '进度不超过当前工作的耗时', String(st.jobProgress));

    // 未解锁的工作在 view 里也应体现
    const vRes = await req('/api/view', { token });
    ok(vRes.data.ok === true, '/api/view 成功', JSON.stringify(vRes.data.msg || ''));
    const v = vRes.data.view;
    ok(typeof v.gameDate === 'object' && v.gameDate.year >= 2000, 'view 含游戏内日期',
      JSON.stringify(v.gameDate));
    ok(v.gameDate.year === 2000, '游戏内年份仍在 2000 年', String(v.gameDate.year));
    ok(v.maxEnergy === 100, 'view 含精力上限', String(v.maxEnergy));
    ok(v.investments.technique !== undefined, 'view 含功法增幅项');
    ok(v.investments.technique.available === true,
      '已习得功法后「功法增幅」在 view 中可用', JSON.stringify(v.investments.technique));
    ok(typeof v.shenshi === 'number' && v.shenshi > 0, 'view 含神识', String(v.shenshi));
    ok(v.shenshiBase === 1, '凡人基础神识 = 1', String(v.shenshiBase));
    ok(typeof v.qi === 'object' && v.qi !== null, 'view 含灵气', JSON.stringify(v.qi));
    ok(typeof v.spiritStone === 'object' && v.spiritStone !== null, 'view 含灵石',
      JSON.stringify(v.spiritStone));
    ok(typeof v.qiMultiplier === 'number' && v.qiMultiplier > 1,
      'view 含灵气产出倍率且 > 1', String(v.qiMultiplier));
    ok(Array.isArray(v.techniques) && v.techniques.length >= 6, 'view 含功法列表',
      String((v.techniques || []).length));
    ok(v.techniques.some((t) => t.learned && t.active), 'view 标出了当前修炼的功法');
    ok(v.cultivating === true, 'view 含修炼开关');
    ok(v.cultivateSpeed > 1, 'view 含修炼速度（受神识加成）', String(v.cultivateSpeed));
    ok(typeof v.comprehendCost === 'object', 'view 含参悟消耗');
    ok(typeof v.passiveBonus === 'object', 'view 含常驻被动汇总');

    // 切回第一份工作（后面的测试更依赖短耗时工作）
    await req('/api/action', { token, method: 'POST', body: { action: 'setJob', payload: { jobId: 'flyer' } } });
    const st2 = (await req('/api/load', { token })).data.state;
    ok(st2.jobId === 'flyer', '可以切回已解锁的低级工作');
  }

  console.log('\n=== 5c. 功法系统（接口层） ===');
  {
    // 未习得的功法不能修炼
    const rBad = await req('/api/action', {
      token, method: 'POST',
      body: { action: 'setTechnique', payload: { techniqueId: 'lianxu' } },
    });
    ok(rBad.status === 400, '未习得的功法不能修炼', JSON.stringify(rBad.data.msg));

    // 已习得的可以切换
    const rOk = await req('/api/action', {
      token, method: 'POST',
      body: { action: 'setTechnique', payload: { techniqueId: 'jiuzhang' } },
    });
    ok(rOk.data.ok === true && rOk.data.result.technique === 'jiuzhang',
      '已习得的功法可以切换', JSON.stringify(rOk.data.msg || ''));

    // 修炼开关
    const rC1 = await req('/api/action', {
      token, method: 'POST', body: { action: 'setCultivating', payload: { cultivating: false } },
    });
    ok(rC1.data.result.cultivating === false, '可以停止修炼');
    await req('/api/action', {
      token, method: 'POST', body: { action: 'setCultivating', payload: { cultivating: true } },
    });

    // 修炼使熟练度上涨（必须走 /api/load 才会推进时间，/api/view 只读快照）
    const m0 = (await req('/api/load', { token })).data.state.learned.jiuzhang.mastery;
    await new Promise((r) => setTimeout(r, 2500));
    const m1 = (await req('/api/load', { token })).data.state.learned.jiuzhang.mastery;
    ok(m1 > m0, '修炼使熟练度上涨', m0 + ' -> ' + m1);

    // 参悟：灵气不足时应被拒
    const st = (await req('/api/load', { token })).data.state;
    const lowState = JSON.parse(JSON.stringify(st));
    lowState.qi = { m: 0, e: 0 };
    await req('/api/save', { token, method: 'POST', body: { state: lowState } });
    const rC = await req('/api/action', {
      token, method: 'POST', body: { action: 'comprehend', payload: { times: 1 } },
    });
    ok(rC.status === 400, '灵气不足时参悟被拒', JSON.stringify(rC.data.msg));

    // 给足灵气后应成功（给得多一些：突破会先消耗掉一部分灵气）
    const st2 = (await req('/api/load', { token })).data.state;
    const richState = JSON.parse(JSON.stringify(st2));
    richState.qi = { m: 1, e: 12 };
    await req('/api/save', { token, method: 'POST', body: { state: richState } });
    const beforeM = (await req('/api/load', { token })).data.state.learned.jiuzhang.mastery;
    const rC2 = await req('/api/action', {
      token, method: 'POST', body: { action: 'comprehend', payload: { times: 1 } },
    });
    ok(rC2.data.ok === true && rC2.data.result.ok === true, '灵气充足时参悟成功',
      JSON.stringify(rC2.data.msg || ''));
    const afterM = (await req('/api/load', { token })).data.state.learned.jiuzhang.mastery;
    ok(afterM > beforeM, '参悟提升熟练度', beforeM + ' -> ' + afterM);

    // 防作弊：功法不允许凭空消失
    const cur = (await req('/api/load', { token })).data.state;
    const wiped = JSON.parse(JSON.stringify(cur));
    wiped.learned = {};
    wiped.technique = null;
    await req('/api/save', { token, method: 'POST', body: { state: wiped } });
    const back = (await req('/api/load', { token })).data.state;
    ok(back.learned && Object.keys(back.learned).length >= 1,
      '清空 learned 被服务端拒绝', JSON.stringify(Object.keys(back.learned || {})));
    ok(back.technique !== null, 'technique 不会被清空', String(back.technique));
  }

  console.log('\n=== 5d. 公司系统（接口层） ===');
  let coToken = null;
  {
    // 公司需要「炼气 + 5 万金钱」，主测试账号是凡人 —— 另开一个账号，
    // 用 /api/save 把境界与金钱抬上去（防作弊只拦倒退，不拦增长）。
    const coUser = user + 'co';
    const rReg = await req('/api/register', {
      method: 'POST', body: { username: coUser, password: 'test1234' },
    });
    ok(rReg.data.ok === true && !!rReg.data.token, '公司测试账号注册成功',
      JSON.stringify(rReg.data.msg || ''));
    coToken = rReg.data.token;

    let st = (await req('/api/load', { token: coToken })).data.state;
    ok(st.company !== undefined && st.company !== null, '存档含公司状态');
    ok(st.company.founded === false, '新账号公司未成立');
    ok(st.company.cycles === 0, '周期计数从 0 起算');
    ok(st.company.warehouseLevel === 0, '仓库等级从 0 起算');
    ok(st.company.autoSell === true, '默认开启自动卖出');
    ok(st.company.stock && st.company.stock.iron_ore === 0, '初始库存为空');
    ok(st.company.totalRevenue && num(st.company.totalRevenue) === 0, '初始营业额为 0');
    ok(st.company.totalUpkeep && num(st.company.totalUpkeep) === 0, '初始维护费为 0');

    // ---- 解锁前：view 里应当给出原因与配置 ----
    let v = (await req('/api/view', { token: coToken })).data.view;
    ok(v.company !== undefined && v.company !== null, 'view 含公司');
    ok(v.company.implemented === true, 'view 标记公司已实现');
    ok(v.company.founded === false, 'view 中公司未成立');
    ok(v.company.unlocked === false, '凡人时公司未解锁');
    ok(String(v.company.lockedReason).indexOf('炼气') >= 0, 'view 给出未解锁原因',
      String(v.company.lockedReason));
    ok(v.company.foundCost > 0, 'view 含注册费', String(v.company.foundCost));
    ok(v.company.unlockRealm === 1, 'view 含解锁境界', String(v.company.unlockRealm));
    ok(v.company.cycleRealSeconds === 20, 'view 含生产周期', String(v.company.cycleRealSeconds));
    ok(Array.isArray(v.company.goods) && v.company.goods.length >= 6, 'view 含商品行情',
      String(v.company.goods && v.company.goods.length));
    ok(Array.isArray(v.company.lines) && v.company.lines.length >= 6, 'view 含生产线',
      String(v.company.lines && v.company.lines.length));
    ok(v.company.lines.every((l) => l.unlocked === false), '未成立公司时生产线全部锁定');
    ok(typeof v.company.goods[0].trend === 'string', '行情含涨跌标记',
      String(v.company.goods[0].trend));
    ok(['up', 'down', 'flat'].indexOf(v.company.goods[0].trend) >= 0, '涨跌标记取值合法');
    ok(num(v.company.goods[0].price) > 0, '行情含市价',
      JSON.stringify(v.company.goods[0].price));
    ok(v.company.goods[0].price.m !== undefined, '市价以 {m,e} 下发（前后端同口径）');
    ok(v.company.goods.every((g) => g.periodSeconds > 0), '每个商品都有变价周期');
    ok(v.company.goods.some((g) => g.kind === 'tech'), '行情含科技类商品');
    ok(v.company.goods.some((g) => g.kind === 'xiuxian'), '行情含修仙类商品');

    // ---- 抬境界与金钱 ----
    st = (await req('/api/load', { token: coToken })).data.state;
    const rich = JSON.parse(JSON.stringify(st));
    rich.realm = 1;
    rich.money = { m: 1, e: 8 };              // 1e8
    rich.energy = 1000;
    await req('/api/save', { token: coToken, method: 'POST', body: { state: rich } });

    const chk = (await req('/api/load', { token: coToken })).data.state;
    ok(chk.realm === 1, '境界已抬到炼气', String(chk.realm));
    ok(num(chk.money) >= 1e8, '金钱已抬到 1e8', JSON.stringify(chk.money));

    v = (await req('/api/view', { token: coToken })).data.view;
    ok(v.company.unlocked === true, '炼气后公司可注册');
    ok(v.company.lockedReason === '', '满足条件后无锁定原因', String(v.company.lockedReason));
    ok(v.company.lines[0].unlocked === false, '未成立公司时生产线仍锁定');

    // ---- 注册 ----
    // 先停掉自动工作，否则注册费会和这几秒的工作收入混在一起
    await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'setWorking', payload: { working: false } },
    });
    const moneyBeforeFound = num((await req('/api/load', { token: coToken })).data.state.money);

    const rF = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'foundCompany' },
    });
    ok(rF.data.ok === true, '成立公司成功', JSON.stringify(rF.data.msg || ''));
    ok(rF.data.state.company.founded === true, 'state 中公司已成立');
    ok(num(rF.data.result.cost) === 5e4, '返回注册费', JSON.stringify(rF.data.result.cost));
    const paid = moneyBeforeFound - num(rF.data.state.money);
    ok(Math.abs(paid - 5e4) <= 1e-6 * 5e4, '已扣除注册费 5 万', paid.toFixed(2));
    ok(num(rF.data.state.money) > 0, '注册后金钱仍为正',
      JSON.stringify(rF.data.state.money));

    const rF2 = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'foundCompany' },
    });
    ok(rF2.status === 400, '重复成立公司被拒', JSON.stringify(rF2.data.msg));

    // ---- 生产线 ----
    const rB0 = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'buyLine', payload: { lineId: 'smelter' } },
    });
    ok(rB0.status === 400, '前置不足时购买生产线被拒', JSON.stringify(rB0.data.msg));
    const rBX = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'buyLine', payload: { lineId: 'nope' } },
    });
    ok(rBX.status === 400, '不存在的生产线被拒');

    const rB1 = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'buyLine', payload: { lineId: 'mine' } },
    });
    ok(rB1.data.ok === true, '购买矿井成功', JSON.stringify(rB1.data.msg || ''));
    ok(rB1.data.state.company.lines.mine.units.length === 1, '生产线数量 +1',
      JSON.stringify(rB1.data.state.company.lines.mine));
    ok(rB1.data.result.product === 'iron_ore',
      '新买的一台默认产该行业第一个产物', String(rB1.data.result.product));

    // 买满 5 条以解锁炼钢厂
    for (let i = 0; i < 4; i++) {
      await req('/api/action', {
        token: coToken, method: 'POST', body: { action: 'buyLine', payload: { lineId: 'mine' } },
      });
    }
    v = (await req('/api/view', { token: coToken })).data.view;
    const mineView = v.company.lines.find((l) => l.id === 'mine');
    const smelterView = v.company.lines.find((l) => l.id === 'smelter');
    ok(mineView && mineView.owned === 5, '累计 5 条矿井',
      String(mineView && mineView.owned));
    ok(smelterView && smelterView.owned === 0, '炼钢厂尚未拥有');
    ok(smelterView && smelterView.unlocked === true, '5 条作坊后解锁炼钢厂');
    ok(smelterView && smelterView.lockedReason === '', '解锁后无锁定原因');
    ok(smelterView && num(smelterView.cost) > 0, '生产线含购买价');
    ok(mineView && mineView.products.length >= 6, '一条线至少 6 种可选产物',
      String(mineView && mineView.products.length));
    ok(mineView && mineView.units.length === 5, '每台产线各自可配',
      String(mineView && mineView.units.length));

    // ---- 工业算力：买线只拿到产能上限，转起来要靠「工业产能」投向 ----
    const rDev = await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'buyDevice', payload: { deviceId: 'datacenter' } },
    });
    ok(rDev.data.ok === true, '购入算力设备给工厂供电', JSON.stringify(rDev.data.msg || ''));
    const rAlloc = await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'setAllocation', payload: { alloc: { industry: 1 } } },
    });
    ok(rAlloc.data.ok === true, '把算力拨给工业产能', JSON.stringify(rAlloc.data.msg || ''));

    // ---- 换产物 / 调产能（每台独立配置）----
    const rU1 = await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'setLineUnit', payload: { lineId: 'mine', index: 0, product: 'coal' } },
    });
    ok(rU1.data.ok === true, '单台换产物成功', JSON.stringify(rU1.data.msg || ''));
    ok(rU1.data.state.company.lines.mine.units[0].p === 'coal', '第 1 台已改为焦煤');

    const rU2 = await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'setLineUnit', payload: { lineId: 'mine', index: 'all', rate: 0.5 } },
    });
    ok(rU2.data.ok === true, '整条线调产能成功', JSON.stringify(rU2.data.msg || ''));
    ok(rU2.data.result.all === true, '标记为「整条线」生效', JSON.stringify(rU2.data.result));
    ok(rU2.data.state.company.lines.mine.units.every((u) => u.r === 0.5),
      '每一台产能都被改成 50%');

    // 换回满负荷（否则后面的产量断言要再打一次折）
    await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'setLineUnit', payload: { lineId: 'mine', index: 'all', rate: 1 } },
    });

    // 非法产物必须被拒 —— 否则可以拿矿井造芯片
    const rU3 = await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'setLineUnit', payload: { lineId: 'mine', index: 0, product: 'chip_x' } },
    });
    ok(rU3.status === 400, '产物不属于该行业时被拒', JSON.stringify(rU3.data.msg));

    // ---- 仓库 ----
    const rW = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'upgradeWarehouse' },
    });
    ok(rW.data.ok === true, '升级仓库成功', JSON.stringify(rW.data.msg || ''));
    ok(rW.data.result.level === 1, '仓库等级 = 1', String(rW.data.result.level));
    ok(rW.data.state.company.warehouseLevel === 1, 'state 中仓库等级已更新');

    v = (await req('/api/view', { token: coToken })).data.view;
    ok(v.company.warehouseLevel === 1, 'view 中仓库等级 = 1');
    ok(v.company.warehouseCapacity === 1100, 'view 中容量 = 1100',
      String(v.company.warehouseCapacity));
    ok(v.company.warehouseMaxLevel > 1, 'view 含仓库最高等级');
    ok(num(v.company.warehouseCost) > 0, 'view 含下次升级价');

    // ---- 经营概览（维护费按产物计，产量取决于工业算力，都只能断言「算得出来」）----
    v = (await req('/api/view', { token: coToken })).data.view;
    ok(num(v.company.compute.pool) > 0, 'view 含工业算力供给',
      JSON.stringify(v.company.compute.pool));
    ok(num(v.company.compute.demand) > 0, 'view 含算力需求',
      JSON.stringify(v.company.compute.demand));
    ok(v.company.compute.scale > 0 && v.company.compute.scale <= 1, 'view 含供需比',
      String(v.company.compute.scale));

    ok(num(v.company.upkeep.total) > 0, 'view 含维护费（按所造产物计）',
      JSON.stringify(v.company.upkeep.total));
    ok(num(v.company.upkeep.material) > 0 && num(v.company.upkeep.labor) > 0,
      '维护费拆出原料与人工');
    const outMap = v.company.outputPerCycle || {};
    const outSum = Object.keys(outMap).reduce((a, k) => a + (outMap[k] || 0), 0);
    ok(outSum > 0, 'view 中每周期产量 > 0', JSON.stringify(outMap));

    let grossWant = 0;
    for (const k of Object.keys(outMap)) {
      const gg = v.company.goods.find((g) => g.id === k);
      grossWant += (outMap[k] || 0) * num(gg.price);
    }
    ok(Math.abs(num(v.company.grossPerCycle) - grossWant) <= 1e-6 * Math.max(1, grossWant),
      'view 中毛产值 = Σ(产量 × 当前市价)',
      num(v.company.grossPerCycle) + ' vs ' + grossWant);
    ok(num(v.company.netPerCycle) > 0, 'view 中净收益为正',
      JSON.stringify(v.company.netPerCycle));
    ok(num(v.company.incomePerSecond) > 0, 'view 中每秒收益为正',
      JSON.stringify(v.company.incomePerSecond));
    ok(v.company.cycleRemain >= 0 && v.company.cycleRemain <= 20,
      'view 含距下个周期的剩余时间', String(v.company.cycleRemain));

    // ---- 生产周期：把进度推到临界点，再等一小会儿 ----
    // 不直接改 cycleProgress 以外的东西：cycles / totalUpkeep 这些被防作弊锁成只能增，
    // 所以断言一律用「前后差值」，避免受此前实时累积影响。
    st = (await req('/api/load', { token: coToken })).data.state;
    const cyc0 = {
      cycles: st.company.cycles,
      upkeep: num(st.company.totalUpkeep),
      revenue: num(st.company.totalRevenue),
    };
    const nearEnd = JSON.parse(JSON.stringify(st));
    nearEnd.company.autoSell = false;         // 先关自动卖出，才看得到库存
    nearEnd.company.cycleProgress = 19;
    await req('/api/save', { token: coToken, method: 'POST', body: { state: nearEnd } });

    await new Promise((r) => setTimeout(r, 2000));   // 跨过 20 秒周期线

    const after = (await req('/api/load', { token: coToken })).data.state;
    ok(after.company.cycles > cyc0.cycles, '跨过周期线后结算生产周期',
      cyc0.cycles + ' -> ' + after.company.cycles);
    ok(num(after.company.totalUpkeep) - cyc0.upkeep > 0,
      '跨周期后按产线记账维护费', num(after.company.totalUpkeep) + ' - ' + cyc0.upkeep);
    ok(num(after.company.totalRevenue) === cyc0.revenue,
      '关闭自动卖出时营业额不增加',
      cyc0.revenue + ' -> ' + num(after.company.totalRevenue));

    v = (await req('/api/view', { token: coToken })).data.view;
    ok(v.company.stockUsed > 0, '产物已入库', String(v.company.stockUsed));
    const compGood = v.company.goods.find((g) => g.id === 'iron_ore');
    ok(compGood.stock > 0, '产出物已入库', String(compGood.stock));
    ok(num(compGood.stockValue) > 0, '库存含估值', JSON.stringify(compGood.stockValue));
    ok(compGood.sold === 0, '手动模式下未产生售出记录', String(compGood.sold));

    // ---- 手动卖出 ----
    const rSell = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'sellGoods', payload: { goodId: 'all' } },
    });
    ok(rSell.data.ok === true, '清仓卖出成功', JSON.stringify(rSell.data.msg || ''));
    ok(num(rSell.data.result.revenue) > 0, '清仓有收入',
      JSON.stringify(rSell.data.result.revenue));

    v = (await req('/api/view', { token: coToken })).data.view;
    ok(v.company.stockUsed === 0, '清仓后库存归零', String(v.company.stockUsed));
    ok(num(v.company.totalRevenue) > cyc0.revenue, '累计营业额已记账',
      num(v.company.totalRevenue) + ' > ' + cyc0.revenue);
    ok(v.company.goods.find((g) => g.id === 'iron_ore').sold > 0, '售出计数已累加');

    const rSell2 = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'sellGoods', payload: { goodId: 'all' } },
    });
    ok(rSell2.status === 400, '空仓时卖出被拒', JSON.stringify(rSell2.data.msg));
    const rSell3 = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'sellGoods', payload: { goodId: 'nope' } },
    });
    ok(rSell3.status === 400, '不存在的商品卖出被拒');

    // ---- 自动卖出开关 ----
    const rA1 = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'setAutoSell', payload: { autoSell: false } },
    });
    ok(rA1.data.result.autoSell === false, '可以关闭自动卖出');
    const rA2 = await req('/api/action', {
      token: coToken, method: 'POST', body: { action: 'setAutoSell', payload: { autoSell: true } },
    });
    ok(rA2.data.result.autoSell === true, '可以重新开启自动卖出');
    ok(rA2.data.state.company.autoSell === true, 'state 中开关已更新');
  }

  console.log('\n=== 5e. 公司防作弊 ===');
  {
    // 尚未成立公司的账号不能凭空「成立」（主测试账号正好是这种情况）
    {
      const cur = (await req('/api/load', { token })).data.state;
      const forged = JSON.parse(JSON.stringify(cur));
      forged.company.founded = true;
      forged.company.foundedDay = 0;
      await req('/api/save', { token, method: 'POST', body: { state: forged } });
      const back = (await req('/api/load', { token })).data.state;
      ok(back.company.founded === false, '未成立公司不能被伪造为已成立',
        String(back.company.founded));
      ok(back.company.warehouseLevel === 0, '伪造后仓库等级仍为 0',
        String(back.company.warehouseLevel));
      ok(back.company.cycles === 0, '伪造后周期计数仍为 0', String(back.company.cycles));
    }

    // 已成立公司的账号：进度类字段不允许倒退
    const cur2 = (await req('/api/load', { token: coToken })).data.state;
    const regress = JSON.parse(JSON.stringify(cur2));
    regress.company.cycles = 0;
    regress.company.warehouseLevel = 0;
    regress.company.lines = {};
    regress.company.goodsSold = {};
    regress.company.totalRevenue = { m: 0, e: 0 };
    regress.company.totalUpkeep = { m: 0, e: 0 };
    await req('/api/save', { token: coToken, method: 'POST', body: { state: regress } });

    const back2 = (await req('/api/load', { token: coToken })).data.state;
    ok(back2.company.founded === true, '已成立公司不会被改成未成立');
    ok(back2.company.cycles >= cur2.company.cycles, '周期计数不允许倒退',
      back2.company.cycles + ' >= ' + cur2.company.cycles);
    ok(back2.company.warehouseLevel >= cur2.company.warehouseLevel, '仓库等级不允许倒退',
      back2.company.warehouseLevel + ' >= ' + cur2.company.warehouseLevel);
    ok((back2.company.lines.mine || 0) >= (cur2.company.lines.mine || 0),
      '生产线数量不允许倒退',
      String(back2.company.lines.mine) + ' >= ' + String(cur2.company.lines.mine));
    ok(num(back2.company.totalRevenue) >= num(cur2.company.totalRevenue),
      '累计营业额不允许倒退',
      num(back2.company.totalRevenue) + ' >= ' + num(cur2.company.totalRevenue));
    ok(num(back2.company.totalUpkeep) >= num(cur2.company.totalUpkeep),
      '累计维护费不允许倒退');

    // 库存不允许超过仓容
    {
      const cur3 = (await req('/api/load', { token: coToken })).data.state;
      const cheat = JSON.parse(JSON.stringify(cur3));
      cheat.company.stock.iron_ore = 999999;
      await req('/api/save', { token: coToken, method: 'POST', body: { state: cheat } });
      const back3 = (await req('/api/load', { token: coToken })).data.state;
      const stockSum = Object.values(back3.company.stock).reduce((a, b) => a + (b || 0), 0);
      ok(stockSum <= 1100, '超容库存被裁剪到仓容内', String(stockSum));
    }
  }

  console.log('\n=== 5f. 市场抛压（接口层） ===');
  {
    const Core = require('../shared/game-core.js');
    const GAME = require('../shared/game-config.js');
    const MK = GAME.company.market;

    ok(!!MK && MK.maxDrop > 0, '本地配置含 market 段');

    // ---- 视图字段齐全 ----
    let v = (await req('/api/view', { token: coToken })).data.view;
    ok(v.company.market && typeof v.company.market === 'object', '视图含市场抛压概览');
    ok(v.company.market.maxDrop === MK.maxDrop, '概览的压价幅度与配置一致',
      String(v.company.market.maxDrop));
    ok(v.company.market.decay === MK.decay, '概览的衰减比例与配置一致',
      String(v.company.market.decay));
    ok(typeof v.company.market.peak === 'number', '概览含最高抛压',
      String(v.company.market.peak));
    ok(typeof v.company.market.warn === 'boolean', '概览含警示标记');

    const gg = v.company.goods[0];
    ok(typeof gg.pressure === 'number', '商品含抛压值', String(gg.pressure));
    ok(typeof gg.dropRatio === 'number', '商品含折价比例', String(gg.dropRatio));
    ok(typeof gg.impact === 'number', '商品含影响系数', String(gg.impact));
    ok(typeof gg.excess === 'number', '商品含每期净抛售', String(gg.excess));
    ok(typeof gg.recoverIn === 'number', '商品含恢复所需期数', String(gg.recoverIn));
    ok(gg.naturalPrice !== undefined, '商品含自然价（不受抛压）',
      JSON.stringify(gg.naturalPrice));
    ok(gg.soldThisPeriod !== undefined && gg.producedThisPeriod !== undefined,
      '商品含本期成交 / 产出计数');

    const clean = v.company.goods.filter((x) => x.pressure === 0);
    ok(clean.length > 0, '存在无抛压的商品', String(clean.length));
    ok(clean.every((x) => num(x.price) === num(x.naturalPrice)),
      '无抛压商品的现价 = 自然价');

    // ---- 砸库存：当期不生效，跨期才压价 ----
    // 说明：这段账号是炼气期、时间档位很低，靠真实时间等一个游戏年不现实，
    // 所以直接把行情时钟（playTime）推到下一期之后，再制造一小段「净抛售」。
    const st = (await req('/api/load', { token: coToken })).data.state;
    const gConf = Core.goodById('iron_ore');
    const per = Core.goodsPeriodSeconds(gConf);
    const jumpTo = (Core.goodsPeriod(gConf, st.playTime) + 2) * per + 1;
    const newPeriod = Core.goodsPeriod(gConf, jumpTo);

    const craft = JSON.parse(JSON.stringify(st));
    craft.playTime = jumpTo;
    craft.company.autoSell = false;
    for (const g of GAME.company.goods) {
      craft.company.lastPeriod[g.id] = Core.goodsPeriod(g, jumpTo);
    }
    craft.company.lastPeriod.iron_ore = newPeriod - 1;   // 制造「跨 1 期」
    craft.company.pressure.iron_ore = 0;
    craft.company.soldThisPeriod.iron_ore = 800;         // 净抛售 800 件
    craft.company.producedThisPeriod.iron_ore = 0;
    await req('/api/save', { token: coToken, method: 'POST', body: { state: craft } });

    // 保存本身不推进时间，所以此刻还没结算
    const vA = (await req('/api/view', { token: coToken })).data.view.company;
    ok(vA.goods.find((x) => x.id === 'iron_ore').pressure === 0,
      '保存当下还没结算，抛压仍为 0');

    await new Promise((r) => setTimeout(r, 1200));
    await req('/api/load', { token: coToken });           // 触发一次 tick

    const vB = (await req('/api/view', { token: coToken })).data.view.company;
    const gB = vB.goods.find((x) => x.id === 'iron_ore');
    ok(gB.pressure > 0.99, '跨过变价期后抛压满档（净抛售 800 ≫ 参考量）',
      String(gB.pressure));
    ok(num(gB.price) < num(gB.naturalPrice), '被压价后的市价低于自然价',
      num(gB.price) + ' < ' + num(gB.naturalPrice));
    ok(Math.abs(num(gB.price) / num(gB.naturalPrice) - (1 - MK.maxDrop)) < 0.02,
      '压价幅度 ≈ maxDrop', (num(gB.price) / num(gB.naturalPrice)).toFixed(4));
    ok(gB.dropRatio > 0.3, '折价比例已随视图下发', String(gB.dropRatio));
    ok(gB.recoverIn > 0, '给出恢复所需期数', String(gB.recoverIn));
    ok(vB.market.peak > 0.99, '概览反映最高抛压', String(vB.market.peak));
    ok(vB.market.warn === true, '越过警示线时概览给出警示');

    // ---- 结算后本期计数清零 ----
    const stAfter = (await req('/api/load', { token: coToken })).data.state;
    ok((stAfter.company.soldThisPeriod.iron_ore || 0) === 0,
      '结算后本期成交量清零', String(stAfter.company.soldThisPeriod.iron_ore));
    ok((stAfter.company.producedThisPeriod.iron_ore || 0) === 0,
      '结算后本期产出清零', String(stAfter.company.producedThisPeriod.iron_ore));
    ok(stAfter.company.lastPeriod.iron_ore === newPeriod,
      '期数游标推进到当前期', String(stAfter.company.lastPeriod.iron_ore));

    // ---- 负值被夹取（负数会让价格暴涨 / 变成倒贴） ----
    {
      const neg = JSON.parse(JSON.stringify(stAfter));
      neg.company.pressure.iron_ore = -3;
      neg.company.soldThisPeriod.iron_ore = -50;
      neg.company.producedThisPeriod.iron_ore = -7;
      await req('/api/save', { token: coToken, method: 'POST', body: { state: neg } });
      const back = (await req('/api/load', { token: coToken })).data.state;
      ok((back.company.pressure.iron_ore || 0) >= 0, '负抛压被夹到 0',
        String(back.company.pressure.iron_ore));
      ok((back.company.soldThisPeriod.iron_ore || 0) >= 0, '负成交量被夹到 0',
        String(back.company.soldThisPeriod.iron_ore));
      ok((back.company.producedThisPeriod.iron_ore || 0) >= 0, '负产出被夹到 0',
        String(back.company.producedThisPeriod.iron_ore));
    }

    // ---- 超范围抛压被夹到 1 ----
    {
      const st3 = (await req('/api/load', { token: coToken })).data.state;
      const big = JSON.parse(JSON.stringify(st3));
      big.company.pressure.iron_ore = 99;
      await req('/api/save', { token: coToken, method: 'POST', body: { state: big } });
      const back = (await req('/api/load', { token: coToken })).data.state;
      ok(back.company.pressure.iron_ore <= 1, '超范围抛压被夹到 1',
        String(back.company.pressure.iron_ore));
    }

    // ---- 期数游标不允许超前于当前期（否则抛压永远等不到结算） ----
    {
      const st4 = (await req('/api/load', { token: coToken })).data.state;
      const ahead = JSON.parse(JSON.stringify(st4));
      ahead.company.lastPeriod.iron_ore = 999999;
      await req('/api/save', { token: coToken, method: 'POST', body: { state: ahead } });
      const back = (await req('/api/load', { token: coToken })).data.state;
      ok(back.company.lastPeriod.iron_ore <=
         Core.goodsPeriod(gConf, back.playTime) + 1,
        '超前的 lastPeriod 被夹回当前期',
        String(back.company.lastPeriod.iron_ore));
    }
  }

  console.log('\n=== 5g. 股市（接口层） ===');
  {
    const Core = require('../shared/game-core.js');
    const GAME = require('../shared/game-config.js');
    const SK = GAME.stock;

    ok(!!SK && SK.implemented === true, '本地配置含 stock 段');

    // ---- 视图字段齐全 ----
    let v = (await req('/api/view', { token: coToken })).data.view;
    ok(v.stock !== undefined && v.stock !== null, 'view 含股市');
    ok(v.stock.implemented === true, 'view 标记股市已实现');
    ok(v.stock.unlocked === true, '炼气后股市已开户');
    ok(v.stock.lockedReason === '', '已开户时无锁定原因', String(v.stock.lockedReason));
    ok(v.stock.unlockRealm === (SK.unlock || {}).realm, 'view 含开户境界',
      String(v.stock.unlockRealm));
    ok(v.stock.fee === SK.fee, 'view 的费率与配置一致', String(v.stock.fee));
    ok(v.stock.minOrder === SK.minOrder, 'view 的最小成交额与配置一致',
      String(v.stock.minOrder));
    ok(v.stock.flowDecay === SK.flowDecay, 'view 的衰减比例与配置一致',
      String(v.stock.flowDecay));
    ok(v.stock.maxRise === SK.maxRise && v.stock.maxDrop === SK.maxDrop,
      'view 的冲击上下限与配置一致');
    ok(v.stock.linkWeight === SK.linkWeight, 'view 的联动权重与配置一致');
    ok(typeof v.stock.peak === 'number', 'view 含冲击峰值', String(v.stock.peak));
    ok(typeof v.stock.totalTrades === 'number', 'view 含成交笔数');
    ok(v.stock.realized !== undefined && v.stock.totalFee !== undefined,
      'view 含已实现盈亏与累计手续费');
    ok(Array.isArray(v.stock.stocks) && v.stock.stocks.length === SK.stocks.length,
      'view 含全部股票', String(v.stock.stocks && v.stock.stocks.length));

    const s0 = v.stock.stocks[0];
    for (const f of ['id', 'name', 'code', 'basePrice', 'depth', 'periodSeconds',
      'period', 'nextPeriod', 'price', 'naturalPrice', 'impact', 'impactPct',
      'shares', 'heldRatio', 'cost', 'avgCost', 'value', 'pnl', 'pnlRatio',
      'liquidateValue', 'liquidatePnl', 'liquidateImpact', 'flow', 'trend',
      'nextChangeIn', 'maxBuy', 'unlocked']) {
      ok(s0[f] !== undefined, '股票视图含字段 ' + f, JSON.stringify(s0[f]));
    }
    ok(s0.price && s0.price.m !== undefined, '股价以 {m,e} 下发（前后端同口径）');
    ok(s0.cost && s0.cost.m !== undefined, '持仓成本以 {m,e} 下发');
    ok(['up', 'down', 'flat'].indexOf(s0.trend) >= 0, '涨跌标记取值合法', String(s0.trend));
    ok(v.stock.stocks.every((x) => num(x.price) > 0), '每只股票的成交价都为正');
    ok(v.stock.stocks.every((x) => num(x.liquidateValue) <= num(x.value) * (1 + 1e-9)),
      '清仓可变现不高于按现价算的市值');
    ok(v.stock.stocks.some((x) => x.link), '存在与公司商品联动的股票');

    // ---- 未开户账号：接口层直接拒绝 ----
    {
      const lockUser = user + 'stklock';
      const rl = await req('/api/register', {
        method: 'POST', body: { username: lockUser, password: 'test1234' },
      });
      const lockToken = rl.data.token;
      const vl = (await req('/api/view', { token: lockToken })).data.view;
      ok(vl.stock.unlocked === false, '凡人账号在 view 中未开户');
      ok(String(vl.stock.lockedReason).indexOf('炼气') >= 0, 'view 给出未开户原因',
        String(vl.stock.lockedReason));

      const rr = await req('/api/action', {
        token: lockToken, method: 'POST',
        body: { action: 'buyStock', payload: { stockId: 'tianji', shares: 10000 } },
      });
      ok(rr.status === 400, '未开户时买入被拒', String(rr.status));
      ok(String(rr.data.msg).indexOf('炼气') >= 0, '拒绝原因说明需要境界',
        String(rr.data.msg));
    }

    // ---- 抬钱 ----
    let st = (await req('/api/load', { token: coToken })).data.state;
    const rich = JSON.parse(JSON.stringify(st));
    rich.money = { m: 1, e: 10 };             // 1e10
    await req('/api/save', { token: coToken, method: 'POST', body: { state: rich } });
    st = (await req('/api/load', { token: coToken })).data.state;
    ok(num(st.money) >= 1e10, '金钱已抬到 1e10', JSON.stringify(st.money));
    ok(st.stock && st.stock.shares, '存档含股市状态');
    ok(st.stock.totalTrades === 0, '初始成交笔数为 0', String(st.stock.totalTrades));
    ok(num(st.stock.realized) === 0, '初始已实现盈亏为 0');

    /**
     * 这个账号已经成立公司、还买了算力设备，所以**两次请求之间会有被动收入进账**
     * （/api/action 会先把离线时长 tick 掉）。下面凡是比较金钱的断言，都要按
     * 「每秒被动收入 × 请求间隔」留出容差，否则测的是设备收益而不是买卖逻辑。
     */
    const vMoney = (await req('/api/view', { token: coToken })).data.view;
    const incomePerSec = num(vMoney.autoIncome) + num(vMoney.company.incomePerSecond);
    const drift = Math.max(1, incomePerSec * 3);

    // ---- 买入 ----
    // 注意：action 本身不推进时间（存档读出来直接结算），所以
    // 「上一个请求返回的 state」与「本 action 返回的 state」之间的金钱差是精确的；
    // 而 /api/load 会 tick 出一笔被动收入，拿它的 money 去比就会有偏差。
    const moneyBeforeBuy = num((await req('/api/load', { token: coToken })).data.state.money);
    const rb = await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'buyStock', payload: { stockId: 'tianji', shares: 20000 } },
    });
    ok(rb.status === 200 && rb.data.ok === true, '买入接口成功',
      JSON.stringify(rb.data.msg || ''));
    const q = rb.data.result;
    ok(q.stockId === 'tianji' && q.shares === 20000, '返回成交股票与股数');
    ok(q.unitPrice && q.unitPrice.m !== undefined, '返回成交均价（{m,e}）');
    ok(near(q.total, num(q.gross) + num(q.fee), 1e-12), '应付款 = 成交额 + 手续费',
      num(q.total) + ' vs ' + (num(q.gross) + num(q.fee)));
    ok(Math.abs(num(rb.data.state.money) - (moneyBeforeBuy - num(q.total))) <= drift,
      '扣款 = 成交额 + 手续费（容忍期间被动收入）',
      num(rb.data.state.money) + ' vs ' + (moneyBeforeBuy - num(q.total)) +
      ' drift=' + drift);
    ok(q.impact > 1, '买入后冲击系数 > 1', String(q.impact));
    ok(q.sharesAfter === 20000, '返回成交后持仓', String(q.sharesAfter));

    const afterBuy = (await req('/api/load', { token: coToken })).data.state;
    ok(afterBuy.stock.shares.tianji === 20000, '存档里持仓已入账',
      String(afterBuy.stock.shares.tianji));
    ok(afterBuy.stock.flow.tianji === 20000, '存档里净买入流已记账',
      String(afterBuy.stock.flow.tianji));
    ok(afterBuy.stock.totalTrades === 1, '成交笔数 +1', String(afterBuy.stock.totalTrades));
    ok(num(afterBuy.stock.totalFee) > 0, '累计手续费已记账',
      JSON.stringify(afterBuy.stock.totalFee));
    ok(num(afterBuy.stock.cost.tianji) > 0, '持仓成本已记账');

    // 视图里这只股票应当带上冲击（价格被自己的买盘推高）
    const vBuy = (await req('/api/view', { token: coToken })).data.view.stock;
    const tBuy = vBuy.stocks.find((x) => x.id === 'tianji');
    ok(tBuy.shares === 20000, 'view 反映持仓');
    ok(tBuy.impact > 1, 'view 反映买入冲击', String(tBuy.impact));
    ok(num(tBuy.price) > num(tBuy.naturalPrice), 'view 里成交价高于自然价',
      num(tBuy.price) + ' > ' + num(tBuy.naturalPrice));
    ok(num(tBuy.liquidateValue) < num(tBuy.value),
      '清仓可变现低于账面市值（溢价拿不回来）',
      num(tBuy.liquidateValue) + ' < ' + num(tBuy.value));
    ok(vBuy.totalTrades >= 1, 'view 概览反映成交笔数');

    // ---- 拒绝路径 ----
    {
      const r1 = await req('/api/action', {
        token: coToken, method: 'POST',
        body: { action: 'buyStock', payload: { stockId: 'tianji', shares: 1 } },
      });
      ok(r1.status === 400, '不足最小成交额被拒', String(r1.status));
      ok(String(r1.data.msg).indexOf('不足') >= 0, '拒绝原因说明成交额不足',
        String(r1.data.msg));

      const r2 = await req('/api/action', {
        token: coToken, method: 'POST',
        body: { action: 'buyStock', payload: { stockId: '不存在的股票', shares: 100000 } },
      });
      ok(r2.status === 400, '未知股票被拒', String(r2.status));

      const r3 = await req('/api/action', {
        token: coToken, method: 'POST',
        body: { action: 'sellStock', payload: { stockId: 'lingmai', shares: 1 } },
      });
      ok(r3.status === 400, '没有持仓时卖出被拒', String(r3.status));
      ok(String(r3.data.msg).indexOf('没有持仓') >= 0, '拒绝原因说明没有持仓',
        String(r3.data.msg));
      ok(r3.data.state !== undefined, '被拒时仍回传 state 供前端纠正');
    }

    // ---- 卖出：一轮买卖必亏 ----
    const moneyBeforeSell = num((await req('/api/load', { token: coToken })).data.state.money);
    const rs = await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'sellStock', payload: { stockId: 'tianji', shares: 20000 } },
    });
    ok(rs.status === 200 && rs.data.ok === true, '卖出接口成功',
      JSON.stringify(rs.data.msg || ''));
    const sq = rs.data.result;
    ok(num(sq.profit) < 0, '买入后立刻卖回：本笔盈亏为负', JSON.stringify(sq.profit));
    ok(near(sq.net, num(sq.gross) - num(sq.fee), 1e-12), '净得 = 成交额 − 手续费',
      num(sq.net) + ' vs ' + (num(sq.gross) - num(sq.fee)));
    ok(Math.abs(num(rs.data.state.money) - (moneyBeforeSell + num(sq.net))) <= drift,
      '入账 = 净得（容忍期间被动收入）',
      num(rs.data.state.money) + ' vs ' + (moneyBeforeSell + num(sq.net)));
    // 「一轮买卖必亏」直接比成交口径：卖回来的钱一定少于买出去的钱。
    // 不拿 state.money 比 —— 那里面混着设备与公司的被动收入，比的是收益不是买卖。
    ok(num(sq.net) < num(q.total), '一轮买卖必亏（卖得 < 买付）',
      num(sq.net) + ' < ' + num(q.total));
    ok(sq.sharesAfter === 0, '全部卖出后持仓归零', String(sq.sharesAfter));

    const afterSell = (await req('/api/load', { token: coToken })).data.state;
    ok(afterSell.stock.shares.tianji === 0, '存档里持仓已归零');
    ok(num(afterSell.stock.cost.tianji) === 0, '清仓后成本精确归零',
      JSON.stringify(afterSell.stock.cost.tianji));
    ok(afterSell.stock.totalTrades === 2, '两笔成交都已记账',
      String(afterSell.stock.totalTrades));
    ok(num(afterSell.stock.realized) < 0, '已实现盈亏为负（真实亏损）',
      JSON.stringify(afterSell.stock.realized));
    ok(afterSell.stock.flow.tianji === 0, '清仓后净买入流归零',
      String(afterSell.stock.flow.tianji));

    // ---- 防作弊：越界裁剪 ----
    {
      const cur = (await req('/api/load', { token: coToken })).data.state;
      const tianji = Core.stockById('tianji');

      const big = JSON.parse(JSON.stringify(cur));
      big.stock.shares.tianji = 1e12;
      big.stock.flow.tianji = 1e12;
      await req('/api/save', { token: coToken, method: 'POST', body: { state: big } });
      const back = (await req('/api/load', { token: coToken })).data.state;
      ok(back.stock.shares.tianji <= Core.stockDepth(tianji),
        '超流通盘的持仓被裁剪', String(back.stock.shares.tianji));
      ok(Math.abs(back.stock.flow.tianji) <= Core.stockDepth(tianji),
        '超范围的净买入流被裁剪', String(back.stock.flow.tianji));

      const neg = JSON.parse(JSON.stringify(back));
      neg.stock.shares.tianji = -100;
      neg.stock.flow.tianji = -1e9;
      neg.stock.cost.tianji = { m: -5, e: 6 };
      await req('/api/save', { token: coToken, method: 'POST', body: { state: neg } });
      const back2 = (await req('/api/load', { token: coToken })).data.state;
      ok(back2.stock.shares.tianji >= 0, '负持仓被夹到 0', String(back2.stock.shares.tianji));
      ok(num(back2.stock.cost.tianji) >= 0, '负成本被夹到 0',
        JSON.stringify(back2.stock.cost.tianji));

      const ghost = JSON.parse(JSON.stringify(back2));
      ghost.stock.shares.tianji = 0;
      ghost.stock.cost.tianji = { m: 999, e: 6 };
      await req('/api/save', { token: coToken, method: 'POST', body: { state: ghost } });
      const back3 = (await req('/api/load', { token: coToken })).data.state;
      ok(num(back3.stock.cost.tianji) === 0, '无持仓时的残留成本被清零',
        JSON.stringify(back3.stock.cost.tianji));

      const ahead = JSON.parse(JSON.stringify(back3));
      ahead.stock.lastPeriod.tianji = 999999;
      await req('/api/save', { token: coToken, method: 'POST', body: { state: ahead } });
      const back4 = (await req('/api/load', { token: coToken })).data.state;
      ok(back4.stock.lastPeriod.tianji <=
         Core.stockPeriod(tianji, back4.playTime) + 1,
        '超前的期数游标被夹回当前期', String(back4.stock.lastPeriod.tianji));
      ok(back4.stock.totalTrades >= 2, '成交笔数不会被倒退清零',
        String(back4.stock.totalTrades));
    }
  }

  console.log('\n=== 6. 防作弊 ===');
  {
    const cur = (await req('/api/load', { token })).data.state;

    // 尝试把进度改小
    const forged = JSON.parse(JSON.stringify(cur));
    forged.playTime = 0;
    forged.realm = 0;
    forged.devices.pc = 0;
    forged.totalJobs = 0;
    forged.rushCount = 0;
    forged.gameSeconds = 0;
    if (forged.jobDone) for (const k of Object.keys(forged.jobDone)) forged.jobDone[k] = 0;
    if (forged.money) forged.money = { m: 999, e: 999 };   // 金钱改超大（服务端不校验上限，只校验进度倒退）

    const r = await req('/api/save', { token, method: 'POST', body: { state: forged } });
    ok(r.data.ok === true, 'save 请求成功');

    const after = (await req('/api/load', { token })).data.state;
    ok(after.playTime >= cur.playTime, 'playTime 不允许倒退', String(after.playTime) + ' >= ' + String(cur.playTime));
    ok(after.devices.pc >= cur.devices.pc, '设备数量不允许倒退', String(after.devices.pc) + ' >= ' + String(cur.devices.pc));
    ok(after.totalJobs >= cur.totalJobs, '工作总次数不允许倒退', String(after.totalJobs) + ' >= ' + String(cur.totalJobs));
    ok(after.rushCount >= cur.rushCount, '催工次数不允许倒退', String(after.rushCount));
    ok(after.gameSeconds >= cur.gameSeconds, '游戏内时间不允许倒退',
      String(after.gameSeconds) + ' >= ' + String(cur.gameSeconds));
    ok(after.jobDone.flyer >= cur.jobDone.flyer, '各工作完成次数不允许倒退',
      String(after.jobDone.flyer) + ' >= ' + String(cur.jobDone.flyer));

    const r2 = await req('/api/save', { token, method: 'POST', body: { state: null } });
    ok(r2.status === 400, '无效存档被拒');
  }

  console.log('\n=== 7. 静态资源 ===');
  {
    for (const p of ['/', '/css/style.css', '/js/app.js', '/shared/decimal.js', '/shared/game-core.js', '/shared/game-config.js']) {
      const res = await fetch(BASE + p);
      ok(res.status === 200, 'GET ' + p + ' -> 200');
    }
  }

  console.log('\n=== 8. 登出 ===');
  {
    const r = await req('/api/logout', { token, method: 'POST' });
    ok(r.data.ok === true, 'logout 成功');
    const r2 = await req('/api/me', { token });
    ok(r2.status === 401, '登出后 token 失效');
  }

  console.log('\n=== 9. 离线结算（专项） ===');
  {
    // 说明：/api/save 会强制把 lastTick 改写为当前时间（防作弊），
    // 因此无法通过 HTTP 伪造离线时长。离线逻辑在 game-core.previewOffline，
    // 这里直接对该函数做单元级验证，保证折扣与封顶规则正确。
    const Core = require('../shared/game-core.js');
    const D = require('../shared/decimal.js');
    const GAME = require('../shared/game-config.js');

    const mk = () => {
      const s = Core.createState();
      s.money = new D(1e6);
      Core.buyDevice(s, 'pc');
      Core.buyDevice(s, 'pc');
      return s;
    };

    // --- 全额结算（短暂离开，低于阈值） ---
    {
      const s = mk();
      const p = Core.previewOffline(s, 30, false);
      ok(p.seconds === 30, '短暂离开：不打折、不封顶', String(p.seconds));
      ok(p.cappedOut === false, '短暂离开：未封顶');
      ok(!p.money.eq(0), '短暂离开有收益', p.money.toString());

      // 对照：同样 30 秒按离线规则应打 3 折
      const p2 = Core.previewOffline(mk(), 30, true);
      const ratio = p2.money.toNumber() / p.money.toNumber();
      ok(Math.abs(ratio - GAME.offline.ratio) < 1e-9,
        '离线 30 秒按 ' + (GAME.offline.ratio * 100) + '% 折算', 'ratio=' + ratio);
    }

    // --- 封顶（100 小时 -> 48 小时） ---
    {
      const p = Core.previewOffline(mk(), 100 * 3600, true);
      ok(p.seconds === GAME.offline.maxHours * 3600, '超长离线封顶到 48 小时', String(p.seconds));
      ok(p.cappedOut === true, '标记为已封顶');
    }

    // --- 恰好未封顶 ---
    {
      const p = Core.previewOffline(mk(), 47 * 3600, true);
      ok(p.seconds === 47 * 3600, '47 小时不封顶', String(p.seconds));
      ok(p.cappedOut === false, '47 小时未封顶');
    }

    // --- 离线不应推进 playTime 之外的副作用（境界可正常推进） ---
    {
      const s = mk();
      s.qi = new D(GAME.realms[0].need * 3);   // 灵气足够连跳
      const before = s.realm;
      Core.tick(s, 10, { offline: true });
      ok(s.realm > before, '离线期间境界可正常突破',
        '凡人 -> ' + Core.realmInfo(s).name);
    }
  }

  console.log('\n=== 5h. 新模型：行业 / 工业算力 / 市值榜（接口层） ===');
  {
    const Core = require('../shared/game-core.js');
    const GAME = require('../shared/game-config.js');

    // 用一个全新账号看「未成立公司」时的行业与行情（价格是公开的）
    const v = (await req('/api/view', { token: coToken })).data.view;
    const CO = v.company;

    // ---- 行业（上下游与成本传导）----
    ok(Array.isArray(CO.industries) && CO.industries.length === GAME.company.industries.length,
      'view 含全部行业', String(CO.industries && CO.industries.length));
    const mining = CO.industries.find((x) => x.id === 'mining');
    const smelt = CO.industries.find((x) => x.id === 'smelt');
    ok(mining && mining.upstream.length === 0, '采掘是最上游（无原料依赖）');
    ok(smelt && smelt.upstream.indexOf('mining') >= 0, '冶炼的上游是采掘');
    ok(smelt && smelt.passThrough > smelt.pricePass,
      '成本传导强于售价传导（上游涨价压缩下游毛利）',
      smelt && (smelt.passThrough + ' > ' + smelt.pricePass));
    ok(typeof mining.costIndex === 'number' && typeof mining.priceIndex === 'number',
      'view 给出行业的成本 / 售价指数');
    ok(mining.goods.length >= 6, '每个行业至少 6 种产物', String(mining.goods.length));

    // ---- 商品按行业归档 ----
    ok(CO.goods.every((g) => !!g.industry), '每个商品都归属某个行业');
    ok(CO.goods.every((g) => typeof g.industryName === 'string'), '商品带行业名');
    const indSet = new Set(CO.goods.map((g) => g.industry));
    ok(indSet.size === GAME.company.industries.length, '商品覆盖全部行业',
      String(indSet.size));

    // ---- 工业算力 ----
    ok(CO.compute && typeof CO.compute.scale === 'number', 'view 含算力供需比',
      String(CO.compute && CO.compute.scale));
    ok(CO.compute.scale >= 0 && CO.compute.scale <= 1, '供需比夹在 [0,1]');
    ok(typeof CO.compute.share === 'number', 'view 含工业产能份额',
      String(CO.compute.share));

    // ---- 生产线：每台可单独换产物 ----
    const mineV = CO.lines.find((l) => l.id === 'mine');
    ok(mineV && mineV.products.length >= 6, '一条线至少 6 种可选产物',
      String(mineV && mineV.products.length));
    ok(mineV && Array.isArray(mineV.units), 'view 给出每一台的配置');
    ok(mineV && mineV.units.every((u) => !!u.product && typeof u.rate === 'number'),
      '每台都带产物与产能');
    ok(mineV && mineV.maxCompute > 0, 'view 给出单台算力上限', String(mineV.maxCompute));
    ok(CO.lines.every((l) => !!l.industry), '每条产线都归属某个行业');

    // ---- 股市：v3.6 起池子 100 家（原 50 + 50 家元婴解锁的融合赛道）、榜单只列前 10 ----
    const SKv = v.stock;
    ok(SKv.stocks.length === 100, '池子里共 100 家上市公司', String(SKv.stocks.length));
    const techN = GAME.stock.stocks.filter((x) => x.kind === 'tech').length;
    const xiuN = GAME.stock.stocks.filter((x) => x.kind === 'xiuxian').length;
    const fuN = GAME.stock.stocks.filter((x) => x.kind === 'fusion').length;
    ok(techN === 30, '其中 30 家科技', String(techN));
    ok(xiuN === 20, '其中 20 家修仙宗门', String(xiuN));
    ok(fuN === 50, '另有 50 家融合赛道（元婴解锁）', String(fuN));
    // 融合赛道要元婴才上板：此刻（炼气）榜单里不该出现
    ok(SKv.board.every((x) => x.kind !== 'fusion'),
      '元婴之前榜单里没有融合赛道公司',
      SKv.board.filter((x) => x.kind === 'fusion').map((x) => x.id).join(','));
    ok(SKv.board.length === (GAME.stock.boardSize || 10), '榜单长度 = boardSize',
      String(SKv.board.length));
    ok(SKv.board.every((x) => typeof x.business === 'string' && x.business.length > 0),
      '榜单每只都带主营业务');
    ok(SKv.stocks.every((x) => x.business !== undefined), '全量列表也带主营业务');

    // 榜单按市值降序
    let desc = true;
    for (let i = 1; i < SKv.board.length; i++) {
      if (num(SKv.board[i - 1].marketCap) < num(SKv.board[i].marketCap)) desc = false;
    }
    ok(desc, '榜单按市值降序排列',
      SKv.board.map((x) => num(x.marketCap).toExponential(2)).join(' > '));

    // 榜外公司照样能交易（接口按 id 找，不在榜上也能买）
    const offBoard = SKv.stocks.find(
      (x) => !SKv.board.some((b) => b.id === x.id));
    ok(offBoard !== undefined, '池子里存在榜外公司');
    const rOff = await req('/api/action', {
      token: coToken, method: 'POST',
      body: { action: 'buyStock', payload: { stockId: offBoard.id, shares: 1 } },
    });
    // 1 股要么因为不足最小成交额被拒（合理），要么成交 —— 但不能是「找不到这只股票」
    ok(String(rOff.data.msg || '').indexOf('不存在') < 0,
      '榜外公司也能被接口找到', String(rOff.data.msg || 'ok'));

    // ---- 成本传导的方向性（内核层）----
    {
      const D = require('../shared/decimal.js');
      const s = Core.createState();
      s.realm = 4;
      s.money = new D(1e12);
      Core.foundCompany(s);
      s.playTime = 300 * 60;                 // 走到行情已经散开的期（第 300 期）

      let checked = 0;
      for (const ind of GAME.company.industries) {
        if (!ind.upstream || !ind.upstream.length) continue;
        const cost = Core.industryCostIndex(s, ind.id);
        const price = Core.industryPriceIndex(s, ind.id);
        const up = Core.industryUpstreamRatio(s, ind.id);
        // 上游涨（up>1）→ 成本涨得比售价快；上游跌则反过来。
        // 两种方向都要成立，否则传导方向写反了。
        if (up > 1.0001) {
          ok(cost > price, '上游涨价时 ' + ind.id + ' 成本指数高于售价指数（毛利被压缩）',
            cost.toFixed(4) + ' > ' + price.toFixed(4));
          checked++;
        } else if (up < 0.9999) {
          ok(cost < price, '上游跌价时 ' + ind.id + ' 成本指数低于售价指数（毛利扩大）',
            cost.toFixed(4) + ' < ' + price.toFixed(4));
          checked++;
        }
      }
      ok(checked > 0, '至少验证了一个有上下游关系的行业', String(checked));
    }
  }

  console.log('\n=== 5i. 兵解 · 转生（接口层） ===');
  {
    const Core = require('../shared/game-core.js');
    const D = require('../shared/decimal.js');
    const GAME = require('../shared/game-config.js');

    // 独立账号，避免污染前面几块的测试状态
    const ru = 'rebirth_' + Date.now().toString(36);
    const rr = await req('/api/register', { method: 'POST', body: { username: ru, password: 'test1234' } });
    ok(rr.data.ok === true, '兵解测试账号已注册');
    const tk = rr.data.token;

    let r = await req('/api/load', { token: tk });
    ok(r.data.config.rebirth && r.data.config.rebirth.implemented === true, '转生配置已下发');
    ok((r.data.config.rebirth.perks || []).length === 6, '道行加成表 6 项已下发',
      String((r.data.config.rebirth.perks || []).length));
    ok(r.data.state.rebirth && r.data.state.rebirth.count === 0, '新存档带空的转生状态');

    // 未达元婴时兵解必须被服务端拒绝（不能只靠前端置灰）
    r = await req('/api/action', { token: tk, method: 'POST', body: { action: 'rebirth', payload: {} } });
    ok(r.status === 400 && r.data.ok === false, '未达元婴时兵解被服务端拒绝', JSON.stringify(r.data.msg));

    // 造一份「元婴 + 公司 + 股市持仓」的存档（realm 是只增字段，0 → 4 允许）
    const s = Core.hydrate(r.data.state);
    s.realm = 4;
    s.money = new D(1e15);
    s.spiritStone = new D(1e6);
    Core.foundCompany(s);
    Core.buyLine(s, 'mine');
    // 造点真实设备算力，才能验证「转生衰减是压数量级，不是乘一个比例」
    s.devices['datacenter'] = 100;
    s.devices['megacenter'] = 20;
    s.company.warehouseLevel = 3;
    s.stock.shares[GAME.stock.stocks[0].id] = 500;
    s.stock.totalTrades = 7;
    const craft = Core.serialize(s);
    r = await req('/api/save', { token: tk, method: 'POST', body: { state: craft } });
    ok(r.data.ok === true, '造好一份「元婴 + 公司 + 持仓」的存档');

    r = await req('/api/view', { token: tk });
    const rb = r.data.view.rebirth;
    ok(rb && rb.unlocked === true, '元婴后转生面板解锁');
    ok(rb.daoGain === 100, '道行收益 = 100', String(rb.daoGain));
    ok(rb.daoGainPassive === 30, '被动兵解三折 = 30', String(rb.daoGainPassive));
    ok(rb.discount === 1, '未兵解过时转生衰减指数 = 1（不能把 base 当成常驻指数）', String(rb.discount));

    // 服务端权威兵解
    r = await req('/api/action', { token: tk, method: 'POST', body: { action: 'rebirth', payload: {} } });
    ok(r.data.ok === true, '兵解成功', JSON.stringify(r.data.result || r.data.msg));
    ok(r.data.result.dao === 100, '服务端给出 100 道行', String(r.data.result.dao));
    ok(Math.abs(r.data.result.discount - 0.5) < 1e-9, '兵解后衰减指数 = 0.50（按数量级压）',
      String(r.data.result.discount));

    const after = Core.hydrate(r.data.state);
    ok(after.realm === 0, '境界归零');
    ok(after.qi.toNumber() === 0, '灵气清零');
    ok(after.money.toNumber() === GAME.base.startMoney, '金钱回到起手值', String(after.money.toNumber()));
    ok(after.spiritStone.toNumber() === 0, '灵石清零');
    ok(after.company.founded === false, '公司被清空');
    ok(Core.lineOwned(after, 'mine') === 0, '生产线被清空');
    ok(after.stock.shares[GAME.stock.stocks[0].id] === 0, '股市持仓被清空');
    ok(after.stock.totalTrades === 0, '股市统计归零');
    ok(after.rebirth.dao === 100 && after.rebirth.count === 1, '道行与兵解次数已入账');

    // 兵解结果必须真的落盘 —— 不能被 /api/save 的「只增保护」公司/股市又补回来
    r = await req('/api/load', { token: tk });
    const loaded = Core.hydrate(r.data.state);
    ok(loaded.company.founded === false, '落盘后公司仍是清空状态（只增保护没有把它救回来）');
    ok(Core.lineOwned(loaded, 'mine') === 0, '落盘后生产线仍为空');
    ok(loaded.stock.totalTrades === 0, '落盘后股市统计为零');
    ok(Core.rebirthDiscount(loaded) === 0.5, '落盘后衰减指数仍是 0.50');
    // 关键：衰减必须是「幂」而不是「乘 0.5」—— 后者对跨 16 个数量级的算力没有刹车力
    {
      const rawC = Core.totalCompute(loaded).toNumber();
      const effC = Core.deviceComputeEffective(loaded).toNumber();
      ok(Math.abs(effC - Math.sqrt(rawC)) / Math.max(1, effC) < 0.02,
        '有效设备算力 = 原值 ^ 0.50（按数量级压，不是乘比例）',
        effC.toExponential(2) + ' ≈ sqrt(' + rawC.toExponential(2) + ')');
      ok(effC < rawC / 1e3, '至少压掉 3 个数量级', effC + ' vs ' + rawC);
    }

    // 拿兵解前的旧存档来回写 → 必须被打回（典型场景：另一个标签页还在用旧 state）
    r = await req('/api/save', { token: tk, method: 'POST', body: { state: craft } });
    ok(r.status === 409, '拿兵解前的旧存档回写会被拒（409）', String(r.status));
    ok(r.data.state && Core.hydrate(r.data.state).rebirth.count === 1,
      '409 回包里给的是服务端版本（仍是已兵解状态）');

    // 买道行加成
    r = await req('/api/action', { token: tk, method: 'POST', body: { action: 'buyPerk', payload: { perkId: 'shenshi' } } });
    ok(r.data.ok === true, '买道行加成成功', JSON.stringify(r.data.result || r.data.msg));
    ok(r.data.result.level === 1 && r.data.result.daoLeft === 60, '等级 1 / 剩余道行 60',
      JSON.stringify(r.data.result));

    r = await req('/api/action', { token: tk, method: 'POST', body: { action: 'buyPerk', payload: { perkId: 'shenshi' } } });
    ok(r.status === 400, '道行不足时买加成被拒（第二级 72 > 60）', JSON.stringify(r.data.msg));

    r = await req('/api/action', { token: tk, method: 'POST', body: { action: 'buyPerk', payload: { perkId: 'nope' } } });
    ok(r.status === 400, '不存在的加成被拒');

    // 伪造：把加成等级直接写到天上
    r = await req('/api/load', { token: tk });
    const cheat = r.data.state;
    cheat.rebirth.perks.shenshi = 99;
    cheat.rebirth.dao = 1e9;
    cheat.rebirth.daoTotal = 1e9;
    r = await req('/api/save', { token: tk, method: 'POST', body: { state: cheat } });
    ok(r.data.ok === true, '伪造存档已提交');
    r = await req('/api/load', { token: tk });
    const after2 = Core.hydrate(r.data.state);
    ok(after2.rebirth.perks.shenshi === 8, '伪造的加成等级被夹到硬上限 8',
      String(after2.rebirth.perks.shenshi));

    // 被动兵解的接口入口（将来渡劫失败接上时不用改接口）
    r = await req('/api/load', { token: tk });
    const s2 = Core.hydrate(r.data.state);
    s2.realm = 4;
    await req('/api/save', { token: tk, method: 'POST', body: { state: Core.serialize(s2) } });
    r = await req('/api/action', { token: tk, method: 'POST', body: { action: 'rebirth', payload: { mode: 'passive' } } });
    ok(r.data.ok === true && r.data.result.mode === 'passive', '被动兵解入口可用');
    ok(r.data.result.dao === 48, '被动兵解道行 = 160 × 0.3 = 48（三折）',
      String(r.data.result.dao));
    ok(r.data.result.count === 2, '兵解次数累加到 2', String(r.data.result.count));
  }

  console.log('\n=== 5j. 渡劫（服务端权威） ===');
  {
    const Core = require('../shared/game-core.js');
    const D = require('../shared/decimal.js');
    const GAME = require('../shared/game-config.js');
    // 独立账号，避免污染前面几块的测试状态
    const tu = 'trib_' + Date.now().toString(36);
    const tr = await req('/api/register', { method: 'POST', body: { username: tu, password: 'test1234' } });
    ok(tr.data.ok === true, '渡劫测试账号已注册');
    const tk = tr.data.token;

    let r = await req('/api/view', { token: tk });
    ok(!!(r.data.view && r.data.view.tribulation), 'view 暴露渡劫面板数据');
    // config 只随 /api/load 下发（/api/view 是纯视图，不带配置）
    r = await req('/api/load', { token: tk });
    ok(!!(r.data.config && r.data.config.tribulation &&
          Array.isArray(r.data.config.tribulation.baseRate)),
      'config 下发渡劫成功率表与规则');

    // 灵气未满必须被服务端拒绝（不能只靠前端置灰）
    r = await req('/api/action', { token: tk, method: 'POST', body: { action: 'tribulation' } });
    ok(r.status === 400 && r.data.ok === false, '灵气未满时渡劫被服务端拒绝',
      JSON.stringify(r.data.msg || ''));

    /**
     * 造「金丹 + 灵气满格 + 自动渡劫关」的存档，换着 playTime 反复渡。
     * roll 是状态的纯函数，playTime 变 → 结果变，所以几十次内必然成功过也失败过。
     * 每轮都重新落盘 —— 上一次失败可能已经把这一世全清了。
     */
    let sawSuccess = null;
    let sawFail = null;
    for (let k = 0; k < 80 && !(sawSuccess && sawFail); k++) {
      const cur = await req('/api/load', { token: tk });
      const st = Core.hydrate(cur.data.state);
      st.realm = 3;
      st.qi = new D(GAME.realms[3].need);
      st.playTime = k * 60 + 7;
      st.autoTribulation = false;   // 关掉自动，避免 /api/action 的前置推进抢先渡劫
      st.learned = { jiuzhang: { mastery: 0, tier: 5, passive: true } };
      await req('/api/save', { token: tk, method: 'POST', body: { state: Core.serialize(st) } });
      r = await req('/api/action', { token: tk, method: 'POST', body: { action: 'tribulation' } });
      if (!r.data || r.data.ok !== true) continue;
      if (r.data.result.success) sawSuccess = r.data.result;
      else sawFail = r.data.result;
    }
    ok(!!sawSuccess, '至少一次渡劫成功');
    if (sawSuccess) {
      ok(sawSuccess.realm === 4, '渡劫成功后境界 +1（金丹 → 元婴）', String(sawSuccess.realm));
      ok(sawSuccess.level >= 1, '渡劫成功后淬体至少 1 层', String(sawSuccess.level));
    }
    if (sawFail) {
      ok(sawFail.fullWipe === true, '元婴以下渡劫失败 = 全清');
      ok(typeof sawFail.dao === 'number' && sawFail.dao > 0, '失败仍结算被动道行',
        String(sawFail.dao));
    }

    // 落盘状态必须与服务端结论一致
    const fin = Core.hydrate((await req('/api/load', { token: tk })).data.state);
    if (sawSuccess && !sawFail) {
      ok(fin.realm === 4, '落盘境界 = 渡劫结果', String(fin.realm));
      ok(fin.tribulation.level >= 1, '落盘淬体层数 ≥ 1', String(fin.tribulation.level));
    } else if (sawFail && !sawSuccess) {
      ok(fin.realm === 0, '落盘境界归零（被动兵解）', String(fin.realm));
      ok(Object.keys(fin.learned).length === 0, '落盘后功法已被全清');
    }
    // 自动渡劫开关走服务端
    r = await req('/api/action', { token: tk, method: 'POST',
      body: { action: 'setAutoTribulation', payload: { on: false } } });
    ok(r.data.ok === true && r.data.result.auto === false, '自动渡劫开关可切换');
    r = await req('/api/load', { token: tk });
    ok(Core.hydrate(r.data.state).autoTribulation === false, '开关已落盘');
  }

  console.log('\n' + '='.repeat(46));
  console.log('  通过  ' + pass + '   失败  ' + fail);
  console.log('='.repeat(46) + '\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常:', e);
  process.exit(1);
});
