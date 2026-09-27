/**
 * app · res-tip —— 顶栏资源悬停明细。
 *
 * 鼠标移到顶栏资源项上，展开该项的「每秒收益来源 / 构成拆解」：
 *   金钱  工作折算 · 设备被动 · 金融投向 · 公司毛/维护/净（口径与顶栏收入一致）
 *   算力  设备原始 → 兵解衰减 → AI 累积 → ×神识 ×被动/淬体 = 实际算力 + 六路分配
 *   灵气  修仙投向与融合岗工作按秒换算 × 灵气倍率，并列出倍率构成
 *   灵石  各修仙×科技设备的每秒产出
 *   神识  境界基础 × 设备倍率 × 功法被动，以及分层后的两个实际乘区
 *   境界  只给百分比进度（境界由灵气驱动，明细在灵气与境界页）
 *
 * 所有数字走 Core 的同名口径函数（与结算同源，不允许界面另算一份）。
 * 面板每 100ms 随 renderTop 刷新一次（refreshResTip），悬停期间数值实时。
 */
(function (root) {
  const A = (root.App = root.App || {});
  const D = root.Decimal;
  const GAME = root.GAME;
  const Core = root.GameCore;
  'use strict';

  // ---------- 拼装小工具 ----------
  function row(k, v, cls, indented) {
    return '<div class="rt-row' + (indented ? ' indented' : '') + '">' +
      '<span class="rt-k">' + k + '</span>' +
      '<span class="rt-v ' + (cls || '') + '">' + v + '</span></div>';
  }
  function head(t) { return '<div class="rt-h">' + t + '</div>'; }
  function sep() { return '<div class="rt-sep"></div>'; }
  function note(t) { return '<div class="rt-note">' + t + '</div>'; }
  /** 速率值：+x / 秒（正绿负红由调用方决定，金额默认原色） */
  function rate(v, cls) {
    const d = (v instanceof D) ? v : new D(v);
    return (d.isNeg() ? '' : '+') + A.fmt(d) + ' / 秒';
  }
  /** 支出型速率：-x / 秒（Decimal 没有 neg()，负号在这里显式加；零值保持 +0） */
  function costRate(v) {
    const d = (v instanceof D) ? v : new D(v);
    return (d.isZero() ? '+' : '-') + A.fmt(d) + ' / 秒';
  }
  /** 有符号倍率/百分比 */
  function signedPct(v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }

  // ---------- 口径助手（renderTop 与明细共用，保证顶栏数字 = 明细合计） ----------

  /**
   * 金钱的每秒入账来源（工作按当前档位与职业折算，实际还受精力约束）。
   * 返回 { work, auto, finance, companyGross, companyUpkeep, companyNet, total }。
   */
  A.moneyIncomeParts = function moneyIncomeParts() {
    const s = A.state;
    const zero = new D(0);
    if (!s) {
      return { work: zero, auto: zero, finance: zero,
        companyGross: zero, companyUpkeep: zero, companyNet: zero, total: zero };
    }
    // 工作：单份收益 × 乘区 ÷（一份的现实秒数）。与 stepTick 的结算乘区同口径，
    // 但「精力不足会停」没法折进速率 —— 明细里注明是折算值。
    let work = zero;
    const job = Core.jobById(s.jobId);
    if (job && s.working) {
      const dur = Core.jobDurationSeconds(job);
      const speed = Core.gameSecondsPerRealSecond(s);
      if (dur > 0 && speed > 0) {
        work = new D(job.money || 0)
          .mul((1 + Core.passiveBonus(s, 'money')) * (1 + Core.tribulationBonus(s, 'money')))
          .mul(1 + Core.passiveBonus(s, 'allOutput'))
          .mul(speed / dur);
      }
    }
    const auto = Core.autoIncome(s);
    const finInv = GAME.investments.find(function (i) { return i.id === 'finance'; });
    const finance = finInv ? new D(Core.investOutputRate(s, finInv)) : zero;
    const f = Core.companyFinance(s);
    const companyGross = f ? f.gross : zero;
    const companyUpkeep = f ? f.upkeep.total : zero;
    const companyNet = Core.companyIncomePerSecond(s);
    return {
      work: work, auto: auto, finance: finance,
      companyGross: companyGross, companyUpkeep: companyUpkeep, companyNet: companyNet,
      total: work.add(auto).add(finance).add(companyNet),
    };
  }

  /**
   * 灵气的每秒产出（按秒换算）：修仙投向 × 倍率 + 当前工作（融合岗）折算 × 倍率。
   * 返回 { invest, work, mul, total }；未习得功法时 total 恒为 0（硬门槛）。
   */
  A.qiRateParts = function qiRateParts() {
    const s = A.state;
    const zero = new D(0);
    if (!s || !Core.spiritAllowed(s)) {
      return { invest: zero, work: zero, mul: 0, total: zero };
    }
    const xiuxian = GAME.investments.find(function (i) { return i.id === 'xiuxian'; });
    const invest = xiuxian ? new D(Core.investOutput(s, xiuxian)).mul(Core.qiMultiplier(s)) : zero;
    let work = zero;
    const job = Core.jobById(s.jobId);
    if (job && job.spirit && s.working) {
      const dur = Core.jobDurationSeconds(job);
      const speed = Core.gameSecondsPerRealSecond(s);
      if (dur > 0 && speed > 0) {
        work = new D(job.spirit)
          .mul(1 + Core.passiveBonus(s, 'allOutput'))
          .mul(speed / dur)
          .mul(Core.qiMultiplier(s));
      }
    }
    return { invest: invest, work: work, mul: Core.qiMultiplier(s), total: invest.add(work) };
  }

  // ---------- 各资源的明细构建 ----------

  const BUILDERS = {
    money: function () {
      const p = A.moneyIncomeParts();
      let html = head('金钱 · 每秒入账来源');
      html += row('工作 · 当前职业（折算）', rate(p.work));
      html += row('设备被动收益（按实际算力）', rate(p.auto));
      html += row('投向 · 金融行业', rate(p.finance));
      html += row('公司 · 毛产出', rate(p.companyGross));
      html += row('公司 · 维护费', costRate(p.companyUpkeep), 'neg', true);
      html += row('公司 · 净收益', rate(p.companyNet), p.companyNet.isNeg() ? 'neg' : '');
      html += sep();
      html += row('合计 / 秒', rate(p.total), 'gold');
      html += note('工作为按当前档位折算的估算值，实际受精力与渡劫淬体加成影响；' +
        '公司周期挂在现实时间（' + GAME.company.cycleRealSeconds + ' 秒/周期），拉满时间档位不会变快。');
      return html;
    },

    compute: function () {
      const s = A.state;
      const cb = Core.computeBreakdown(s);
      const shenshiMul = Core.shenshiComputeMultiplier(s);
      const passiveMul = (1 + Core.passiveBonus(s, 'compute')) * (1 + Core.tribulationBonus(s, 'compute'));
      let html = head('算力 · 构成拆解');
      html += row('设备算力（原始）', A.fmt(Core.totalCompute(s)));
      const rb = Core.rebirthCount(s);
      if (rb > 0) {
        html += row('　兵解 ' + rb + ' 世衰减（^' + Core.rebirthDiscount(s).toFixed(2) + '）',
          A.fmt(Core.deviceComputeEffective(s)), 'dim', true);
      }
      if (s.aiBonus.gt(0)) {
        html += row('AI 投向累积加成', '+ ' + A.fmt(s.aiBonus), 'pos');
      }
      html += row('小计（设备有效 + AI）', A.fmt(cb.base));
      html += row('× 神识乘区（分层阻尼）', '× ' + A.fmtNum(shenshiMul), 'dim', true);
      html += row('× 功法被动 / 渡劫淬体', '× ' + A.fmtNum(passiveMul), 'dim', true);
      html += sep();
      html += row('实际算力', A.fmt(cb.total), 'gold');
      html += sep() + head('算力 · 六路分配');
      for (const inv of GAME.investments) {
        const share = s.alloc[inv.id] || 0;
        const avail = Core.investmentAvailable(s, inv);
        let v = (share * 100).toFixed(0) + '%';
        if (inv.id === 'industry' && avail && share > 0) {
          v += '（池 ' + A.fmt(Core.industrialComputePool(s)) + '）';
        }
        html += row(inv.name + (avail ? '' : ' · 未解锁'), v, avail ? '' : 'dim');
      }
      html += note('拉满时间档位只加速工作，不会放大算力；' +
        '神识对算力的实际放大见「神识」明细。');
      return html;
    },

    qi: function () {
      const s = A.state;
      let html = head('灵气 · 每秒产出（按秒换算）');
      if (!Core.spiritAllowed(s)) {
        html += note('尚未习得功法 —— 灵气恒为 0。买下第一台个人电脑即获赠第一本功法。');
        return html;
      }
      const p = A.qiRateParts();
      html += row('修仙投向产出 × 倍率', rate(p.invest));
      if (p.work.gt(0)) {
        html += row('当前工作 · 融合岗（折算）', rate(p.work));
      }
      html += sep();
      html += row('× 灵气总倍率', '× ' + p.mul.toFixed(2), 'dim');
      html += row('功法主属性（灵气吸收）',
        signedPct(Core.currentTech(s) ? Core.techMainQiSpeed(s, Core.currentTech(s)) : 0), 'dim', true);
      html += row('神识 · 修炼乘区',
        signedPct(Core.shenshiCultivateMultiplier(s) - 1), 'dim', true);
      html += row('道行 · 灵气亲和', signedPct(Core.perkValue(s, 'qiSpeed')), 'dim', true);
      html += row('渡劫淬体 · 灵气吸收', signedPct(Core.tribulationBonus(s, 'qiSpeed')), 'dim', true);
      html += row('功法被动 · 全部产出', signedPct(Core.passiveBonus(s, 'allOutput')), 'dim', true);
      html += sep();
      html += row('合计 / 秒', rate(p.total), 'gold');
      const target = Core.nextRealm(s);
      html += row('突破进度', target.need
        ? (A.pct(s.realmProgress) + '（' + A.fmt(s.qi) + ' / ' + A.fmt(target.need) + '）')
        : '已至此境巅峰');
      return html;
    },

    spirit: function () {
      const s = A.state;
      let html = head('灵石 · 每秒产出');
      let total = new D(0);
      let any = false;
      for (const dev of GAME.devices) {
        if (!dev.stonePerSecond) continue;
        const owned = s.devices[dev.id] || 0;
        if (owned <= 0) continue;
        any = true;
        total = total.add(new D(dev.stonePerSecond).mul(owned));
        html += row(dev.name + ' ×' + owned,
          '+' + A.fmt(new D(dev.stonePerSecond).mul(owned)) + ' / 秒');
      }
      if (!any) {
        html += note('尚无产灵石的设备 —— 后 5 台「修仙 × 科技」设备（金钱 + 灵石双造价）会持续产出。');
        return html;
      }
      html += sep();
      html += row('合计 / 秒', rate(total), 'gold');
      html += note('灵石来自「修仙 × 科技」设备的自我造血，与时间档位无关。');
      return html;
    },

    shenshi: function () {
      const s = A.state;
      let html = head('神识 · 构成');
      html += row('境界基础（含道行 · 神识根基 +' + Core.perkValue(s, 'shenshi') + '）',
        A.fmtNum(Core.shenshiBase(s)));
      const rb = Core.rebirthCount(s);
      html += row('× 设备倍率' + (rb > 0 ? '（已吃 ' + rb + ' 世衰减）' : ''),
        '× ' + A.fmtNum(Core.shenshiDeviceMultiplier(s)), 'dim', true);
      html += row('× 1 + 功法被动',
        '× ' + A.fmtNum(1 + Core.passiveBonus(s, 'shenshi')), 'dim', true);
      html += sep();
      html += row('总神识', A.fmtNum(Core.totalShenshi(s)), 'gold');
      html += sep() + head('实际乘区（境界线性 × 设备对数收敛）');
      html += row('对实际算力', signedPct(Core.shenshiComputeMultiplier(s) - 1));
      html += row('对功法修炼速度', signedPct(Core.shenshiCultivateMultiplier(s) - 1));
      html += note('设备倍率按对数收敛，后期不爆炸；境界那一份保持线性，' +
        '道行买来的永久提升不会被稀释。');
      return html;
    },

    realm: function () {
      const s = A.state;
      const info = Core.realmInfo(s);
      const target = Core.nextRealm(s);
      let html = head('境界 · 突破进度');
      html += row('当前境界', info.name + '（TIER ' + s.realm + '）');
      html += row('突破进度', A.pct(s.realmProgress), 'gold');
      if (target.need) {
        html += note('下一境「' + target.next.name + '」—— 灵气攒满后须渡劫方能升境；' +
          '灵气产出速率见「灵气」明细。');
      } else {
        html += note('已至此境巅峰 —— 再往前只能兵解重来。');
      }
      return html;
    },
  };

  // ---------- 悬停绑定与刷新 ----------

  let tipEl = null;
  let hoverKind = null;
  let lastHtml = '';

  /** 在 renderStatic 里调用一次；事件委托挂在资源组容器上 */
  A.bindResTips = function bindResTips() {
    const group = document.querySelector('.res-group');
    tipEl = A.$('res-tip');
    if (!group || !tipEl) return;
    group.addEventListener('mouseover', function (e) {
      const res = e.target.closest('[data-res]');
      if (!res || !res.dataset.res) return;
      hoverKind = res.dataset.res;
      showTip(res);
    });
    group.addEventListener('mouseleave', hideTip);
  }

  function showTip(res) {
    const html = BUILDERS[hoverKind] ? BUILDERS[hoverKind]() : '';
    lastHtml = html;
    tipEl.innerHTML = html;
    tipEl.classList.remove('hidden');
    position(res);
  }

  function position(res) {
    const r = res.getBoundingClientRect();
    const width = tipEl.offsetWidth || 280;
    const left = Math.max(8, Math.min(r.left, (window.innerWidth || 1200) - width - 12));
    tipEl.style.left = left + 'px';
    tipEl.style.top = (r.bottom + 8) + 'px';
  }

  function hideTip() {
    hoverKind = null;
    lastHtml = '';
    if (tipEl) tipEl.classList.add('hidden');
  }

  /**
   * renderTop 每帧调用：悬停期间数值实时跟着 tick 走。
   * 内容没变就不碰 DOM（与 setText 同一纪律）。
   */
  A.refreshResTip = function refreshResTip() {
    if (!tipEl || !hoverKind || tipEl.classList.contains('hidden')) return;
    const html = BUILDERS[hoverKind] ? BUILDERS[hoverKind]() : '';
    if (html !== lastHtml) {
      lastHtml = html;
      tipEl.innerHTML = html;
    }
  }

})(typeof window !== 'undefined' ? window : globalThis);
