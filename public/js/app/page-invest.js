/**
 * app · page-invest —— 投向页：六路分配渲染、拖动提交、快捷预设与快捷投向条。
 *
 * 本文件是 public/js/app 模块群的一员：全部模块共享入口注入的命名空间 A，
 * 函数在调用期经 A.xxx 解析（新增模块只需挂到 A 上并加入 index.html 脚本序）。
 * 可变状态统一由 state.js 初始化；请勿直接引用本文件，浏览器从 /js/app.js 进入。
 */
(function (root) {
  const A = (root.App = root.App || {});
  const D = root.Decimal;
  const GAME = root.GAME;
  const Core = root.GameCore;
  'use strict';

  /** v3.6：快捷算力投向模块（境界页=修仙 / 设备页=AI），改动按比例让位其余方向 */
  A.renderQuickAlloc = function renderQuickAlloc() {
    const bars = document.querySelectorAll('[data-qa]');
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const id = bar.dataset.qa;
      const inv = GAME.investments.find((x) => x.id === id);
      if (!inv) continue;
      const available = Core.investmentAvailable(A.state, inv);
      const range = bar.querySelector('[data-role="qarange"]');
      const pctEl = bar.querySelector('[data-role="qapct"]');
      const v = Math.round((A.state.alloc[id] || 0) * 100);
      if (pctEl) pctEl.textContent = available ? (v + '%') : '锁定';
      if (range) {
        range.disabled = !available;
        if (document.activeElement !== range && Number(range.value) !== v) range.value = String(v);
      }
    }
  }

  A.commitQuickAlloc = function commitQuickAlloc(id, pct_arg) {
    const r = Core.setAllocationShare(A.state, id, pct_arg / 100);
    if (!r.ok) {
      A.toast(r.msg || '调整失败', 'err');
      A.renderQuickAlloc();
      return;
    }
    A.dirty = true;
    A.renderAll();
    A.syncNow();
  }

  /**
   * 投向的显示口径。
   *
   * 每个方向的产出量纲都不一样，必须**换成本方向的单位**再显示：
   * 直接显示 investOutput（中间量）会让玩家以为「修仙方向每秒只给几十点灵气」，
   * 而实际入账还要乘灵气倍率（功法主属性 × 神识 × 功法投向），能差一两个数量级。
   */
  A.investDisplay = function investDisplay(inv) {
    const unit = inv.unit || '';
    const rate = Core.investOutputRate(A.state, inv);
    if (unit === 'qi') {
      // 灵气是硬门槛：没有功法就没有灵气。这时显示「需先习得功法」比显示 0 更有用。
      if (!Core.spiritAllowed(A.state)) return { label: '灵气 / 秒', text: '需先习得功法' };
      return { label: '灵气 / 秒', text: A.fmt(new D(rate)) };
    }
    if (unit === 'compute') return { label: '算力 / 秒', text: '+' + A.fmt(new D(rate)) };
    if (unit === 'money') return { label: '金钱 / 秒', text: '+' + A.fmt(new D(rate)) };
    if (unit === 'discount') {
      // v3.5：累积制 —— 显示「累积值 + 每秒增长」，折扣本身按设备逐台算（设备页「折 X%」）
      const X = Core.investedHardwareOf(A.state);
      return { label: '议价累积', text: A.fmt(X) + '（+' + A.fmt(new D(rate)) + ' / 秒）' };
    }
    if (unit === 'techexp') {
      // 功法算力投入 → 经验/秒，只喂当前修炼的那本
      const cur = Core.currentTech(A.state);
      return cur
        ? { label: '功法经验 / 秒', text: '+' + A.fmt(new D(rate)) + ' → ' + cur.name }
        : { label: '功法经验 / 秒', text: '0' };
    }
    return { label: '产出', text: A.fmt(new D(rate)) };
  }

  /** 这些投向的「产出」不是每秒资源，累计值没有意义，不显示 */
  A.INVEST_NO_TOTAL = { industrial: 1 };

  A.renderInvestPage = function renderInvestPage() {
    let allocSum = 0;
    A.refreshAllocPresets();

    for (const inv of GAME.investments) {
      const el = document.querySelector('[data-inv="' + inv.id + '"]');
      if (!el) continue;

      const available = Core.investmentAvailable(A.state, inv);
      el.classList.toggle('disabled', !available);

      // 锁定标签：文案由核心层给出（功法算力投入 = 未习得功法 / 工业产能 = 未成立公司），
      // 条件满足后就地消失 —— 不能只在首次渲染时写死。
      const tag = el.querySelector('[data-role="locktag"]');
      if (tag) {
        const reason = Core.investmentLockReason(A.state, inv);
        tag.textContent = reason;
        tag.hidden = !reason;
      }

      const a = A.state.alloc[inv.id] || 0;
      if (available) allocSum += a;

      const range = el.querySelector('[data-role="range"]');
      range.disabled = !available;
      if (document.activeElement !== range) {
        range.value = Math.round(a * 100);
      }

      el.querySelector('[data-role="pct"]').textContent = available
        ? Math.round(a * 100) + '%' : '锁定';

      const disp = A.investDisplay(inv);
      el.querySelector('[data-role="outlabel"]').textContent = disp.label;
      el.querySelector('[data-role="out"]').textContent = disp.text;

      const totalEl = el.querySelector('[data-role="total"]');
      if (A.INVEST_NO_TOTAL[inv.unit]) {
        totalEl.textContent = '';
      } else {
        totalEl.textContent = '累计 ' + A.fmt(A.state.produced[inv.id]);
      }
    }

    const sumEl = A.$('ui-alloc-sum');
    const sumPct = Math.round(allocSum * 100);
    sumEl.textContent = '合计 ' + sumPct + '%';
    sumEl.className = 'hint alloc-sum ' + (sumPct > 100 ? 'over' : 'ok');

    const xiuxianPct = Math.round((A.state.alloc.xiuxian || 0) * 100);
    A.$('ui-alloc-warn').classList.toggle('hidden', xiuxianPct > 0);
  }

  A.onAllocDrag = function onAllocDrag(invId, pctVal) {
    const inv = GAME.investments.find((i) => i.id === invId);
    if (!inv || !Core.investmentAvailable(A.state, inv)) return;

    const want = Math.max(0, Math.min(100, pctVal)) / 100;
    const others = Core.allocatableInvestments(A.state).filter((i) => i.id !== invId);
    const remain = Math.max(0, 1 - want);

    const alloc = {};
    alloc[invId] = want;

    let otherSum = 0;
    for (const o of others) otherSum += (A.state.alloc[o.id] || 0);

    if (otherSum <= 0) {
      const share = others.length ? remain / others.length : 0;
      for (const o of others) alloc[o.id] = share;
    } else {
      const scale = remain / otherSum;
      for (const o of others) alloc[o.id] = (A.state.alloc[o.id] || 0) * scale;
    }

    Core.setAllocation(A.state, alloc);
    A.dirty = true;
    A.renderAll();
  }

  /**
   * 快捷预设（v3.7）。
   *
   * 早先这两个按钮写死成「全部归修仙 / 四路均分」—— 可分配的方向早就不是四个了
   * （修仙 / AI / 计算设备 / 金融 / 功法 / 工业，六条），写死的文案与写死的份数
   * 都在骗人。现在份数一律按**当前已解锁**的方向数算，文案也跟着变。
   */
  A.allocUsable = function allocUsable() {
    return A.state ? Core.allocatableInvestments(A.state) : [];
  }

  A.setAllocPreset = function setAllocPreset(kind) {
    const usable = A.allocUsable();
    if (!usable.length) { A.toast('当前没有可分配的投向', 'err'); return; }

    const alloc = {};
    if (kind === 'reset') {
      for (const inv of GAME.investments) alloc[inv.id] = inv.id === 'xiuxian' ? 1 : 0;
    } else if (kind === 'main') {
      // 修仙一半，其余已解锁方向平分另一半；只剩修仙可用时全额给它
      const rest = usable.filter((i) => i.id !== 'xiuxian');
      const xiShare = rest.length ? 0.5 : 1;
      const share = rest.length ? (1 - xiShare) / rest.length : 0;
      for (const inv of GAME.investments) {
        if (!Core.investmentAvailable(A.state, inv)) { alloc[inv.id] = 0; continue; }
        alloc[inv.id] = inv.id === 'xiuxian' ? xiShare : share;
      }
    } else {
      const share = 1 / usable.length;
      for (const inv of GAME.investments) {
        alloc[inv.id] = Core.investmentAvailable(A.state, inv) ? share : 0;
      }
    }
    Core.setAllocation(A.state, alloc);
    A.dirty = true;
    A.renderAll();

    const n = usable.length;
    A.toast(kind === 'reset'
      ? '算力已全部拨给修仙方向'
      : (kind === 'main'
        ? '修仙 50%，其余 ' + (n - 1) + ' 个方向平分剩余 50%'
        : '已均分到 ' + n + ' 个方向（每个 ' + (100 / n).toFixed(1) + '%）'), 'ok');
  }

  /** 预设按钮的文案随「当前可用方向数」走，不再写死 */
  A.refreshAllocPresets = function refreshAllocPresets() {
    const usable = A.allocUsable();
    const n = usable.length;
    const evenBtn = A.$('btn-alloc-even');
    if (evenBtn) {
      evenBtn.textContent = n > 1 ? (n + ' 路均分') : '均分';
      evenBtn.disabled = n === 0;
    }
    const mainBtn = A.$('btn-alloc-main');
    if (mainBtn) mainBtn.disabled = n === 0;
    const resetBtn = A.$('btn-alloc-reset');
    if (resetBtn) resetBtn.disabled = n === 0;

    const hint = A.$('ui-alloc-preset-hint');
    if (hint) {
      hint.textContent = n
        ? ('当前可分配 ' + n + ' 个方向：' + usable.map((i) => i.name).join(' / ') +
           '　·　未解锁的方向不参与分配，解锁后按钮上的份数会自动跟着变')
        : '当前没有可分配的投向';
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
