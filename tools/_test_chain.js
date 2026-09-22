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
