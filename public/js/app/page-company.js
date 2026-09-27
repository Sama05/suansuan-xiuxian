/**
 * app · page-company —— 公司页：经营概览、产线（每台独立配置）、注册/买线/扩仓操作。
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

  // 生产线折叠（v3.7）
  A.lineFolded = new Set();

  A.lineFoldInit = new Set();

    /**
     * v3.6：生产线按行业分组骨架（折叠 + fusion kind）。
     * 行内容（lstats / lunits / lprice）仍由 A.renderCompanyPage 逐帧回填。
     */
  A.buildCompanyLineGroups = function buildCompanyLineGroups() {
      A.$('co-line-list').innerHTML = GAME.company.industries.map((ind) => {
        const ls = GAME.company.lines.filter((l) => l.industry === ind.id);
        if (!ls.length) return '';
        const kind = A.marketKindOf(ind.id);
        if (kind === 'fusion' && !A.lineFoldInit.has(ind.id)) { A.lineFoldInit.add(ind.id); A.lineFolded.add(ind.id); }
        const rows = ls.map((l) => {
          return '<div class="co-line ' + kind + '" data-line="' + l.id + '">' +
            '<div class="co-line-icon">' + A.esc(A.indIcon(l.industry)) + '</div>' +
            '<div class="co-line-main">' +
              '<div class="co-line-title">' + A.esc(l.name) +
                '<span class="co-line-tag ' + kind + '">' + A.esc(A.indName(l.industry)) + '</span>' +
                '<span class="co-line-tag" data-role="lowned">×0</span>' +
                // 「优先生产」：算力不够时先喂饱这条线。data-nocollapse 让点它不触发组折叠
                '<button class="co-prio" data-role="lprio" data-nocollapse ' +
                  'title="开启后，工业产能不足时优先保障这条线">优先</button>' +
              '</div>' +
              '<div class="co-line-desc">' + A.esc(l.desc) + '</div>' +
              '<div class="co-line-stats" data-role="lstats"></div>' +
              // 每一台的配置行在这里动态回填（台数会变，不能写死在静态结构里）
              '<div class="co-line-units" data-role="lunits"></div>' +
              '<div class="co-line-lock hidden" data-role="llock"></div>' +
            '</div>' +
            '<div class="co-line-right">' +
              '<div class="co-line-owned" data-role="lcap">已拥有 0 条</div>' +
              '<div class="co-line-price" data-role="lprice">—</div>' +
              '<button class="btn sm" data-role="lbuy">购入</button>' +
            '</div>' +
          '</div>';
        }).join('');
        return '<div class="co-line-group ' + (A.lineFolded.has(ind.id) ? 'folded' : '') + '" data-industry="' + ind.id + '">' +
          '<div class="mk-group-head" data-role="lgrouphead" data-collapse="next" ' +
            'aria-expanded="' + (A.lineFolded.has(ind.id) ? 'false' : 'true') + '" ' +
            'title="点击折叠 / 展开该行业生产线">' +
            '<span class="mk-fold">▾</span>' +
            '<span class="mk-group-icon">' + A.esc(A.indIcon(ind.id)) + '</span>' +
            '<span class="mk-group-name">' + A.esc(ind.name) + '</span>' +
            '<span class="mk-group-tag">' + (kind === 'fusion' ? '融合 · 元婴解锁' : (kind === 'xiuxian' ? '修仙 · 产业' : '科技 · 产业')) + '</span>' +
            '<span class="mk-group-idx">' + ls.length + ' 条线' +
              '<span class="faint" data-role="lgown"></span></span>' +
            // 批量操作：整个行业一起满速 / 停工（data-nocollapse 防止顺手把组折叠了）
            '<span class="mk-group-acts" data-nocollapse>' +
              '<button class="btn xs" data-role="lrun" data-industry="' + ind.id + '" ' +
                'title="把该行业全部产线的产能拉到 100%">一键满速运转</button>' +
              '<button class="btn xs ghost" data-role="lstop" data-industry="' + ind.id + '" ' +
                'title="把该行业全部产线的产能降到 0（停机不耗算力）">一键停工</button>' +
            '</span>' +
          '</div>' +
          '<div class="mk-group-body">' + rows + '</div>' +
        '</div>';
      }).join('');
    }

  A.renderCompanyPage = function renderCompanyPage() {
    const C = GAME.company;
    if (!C || !C.implemented) return;

    const founded = Core.companyFounded(A.state);
    A.$('company-panel').classList.toggle('hidden', founded);
    A.$('company-main').classList.toggle('hidden', !founded);
    A.$('tab-company').classList.toggle('locked', !founded);
    A.$('tab-company-badge').textContent = founded ? '经营中' : '未成立';

    // ---------- 未成立：注册门槛 ----------
    if (!founded) {
      const cost = new D(C.foundCost);
      const need = C.unlock || {};
      const realmOk = Core.companyUnlocked(A.state);
      A.$('ui-co-found-cost').textContent = A.fmt(cost);
      A.$('ui-co-found-lock').textContent = realmOk
        ? (A.state.money.lt(cost) ? '（金钱不足）' : '')
        : ('（需达到「' + ((GAME.realms[need.realm] || {}).name || '?') + '」）');

      const btn = A.$('btn-found-company');
      btn.disabled = !realmOk || A.state.money.lt(cost);
      btn.textContent = realmOk ? '注册成立' : '尚未解锁';
      return;
    }

    // ---------- 已成立 ----------
    const cyc = C.cycleRealSeconds;
    const up = Core.companyUpkeep(A.state);
    const gross = Core.companyCycleGross(A.state);
    const net = Core.companyCycleNet(A.state);
    const cap = Core.warehouseCapacity(A.state);
    const used = Core.stockTotal(A.state);

    // 周期进度
    const prog = cyc > 0 ? Math.max(0, Math.min(1, A.state.company.cycleProgress / cyc)) : 0;
    A.$('ui-co-cycle-bar').style.width = (prog * 100).toFixed(1) + '%';
    A.$('ui-co-cycle-label').textContent =
      '下个周期 ' + A.fmtRealDuration(Math.max(0, cyc - A.state.company.cycleProgress)) + ' 后';
    A.$('ui-co-cycle-count').textContent =
      '已完成 ' + A.fmtCount(A.state.company.cycles) + ' 个周期';

    // 经营状态
    const statusEl = A.$('ui-co-status');
    if (A.state.money.lt(up.total) && up.total.gt(0)) {
      statusEl.textContent = '资金不足 · 停产';
      statusEl.className = 'hint err';
    } else if (used >= cap && cap > 0) {
      statusEl.textContent = '仓库已满 · 停产';
      statusEl.className = 'hint err';
    } else {
      statusEl.textContent = '运转中';
      statusEl.className = 'hint ok';
    }

    // 收支
    A.$('ui-co-gross').textContent = '+' + A.fmt(gross);
    A.$('ui-co-upkeep').textContent = '-' + A.fmt(up.total);
    const netEl = A.$('ui-co-net');
    netEl.textContent = (net.isNeg() ? '' : '+') + A.fmt(net);
    netEl.className = 'v ' + (net.isNeg() ? 'red' : 'jade');
    A.$('ui-co-netps').textContent = A.fmtRate(Core.companyIncomePerSecond(A.state));
    A.$('ui-co-revenue').textContent = A.fmt(A.state.company.totalRevenue);
    A.$('ui-co-upkeep-total').textContent = A.fmt(A.state.company.totalUpkeep);

    // 仓库
    const lv = Core.warehouseLevel(A.state);
    const maxLv = C.warehouse.maxLevel;
    const atMax = lv >= maxLv;
    const cost = Core.warehouseCost(A.state);
    A.$('ui-co-wh-level').textContent = 'Lv.' + lv;
    A.$('ui-co-wh-bar').style.width =
      (cap > 0 ? Math.min(100, used / cap * 100) : 0).toFixed(1) + '%';
    A.$('ui-co-wh-val').textContent = A.fmtCount(used) + ' / ' + A.fmtCount(cap);

    const whBtn = A.$('btn-co-warehouse');
    whBtn.textContent = atMax ? '已满级' : ('扩容 ' + A.fmt(cost));
    whBtn.disabled = atMax || A.state.money.lt(cost);
    A.$('ui-co-wh-cost').textContent = atMax
      ? ('仓库已至最高等级 Lv.' + maxLv + '，容量 ' +
         A.fmtCount(C.warehouse.baseCapacity + maxLv * C.warehouse.perLevel) + ' 件')
      : ('下一级容量 ' + A.fmtCount(C.warehouse.baseCapacity + (lv + 1) * C.warehouse.perLevel) +
         ' 件　需 ' + A.fmt(cost) + ' 金钱');

    A.$('chk-co-autosell').checked = !!A.state.company.autoSell;

    // ---------- 工业算力 ----------
    // 买线只拿到「产能上限」，真正转起来要靠工业算力。供给不足时全厂按比例削减，
    // 所以多买线不会凭空增产 —— 这是「工业产能」这条投向的全部意义。
    const pool = Core.industrialComputePool(A.state);
    const demand = Core.companyComputeDemand(A.state);
    const scale = Core.companyComputeScale(A.state);
    const share = A.state.alloc.industry || 0;

    A.setText('ui-co-cp-pool', A.fmt(pool));
    A.setText('ui-co-cp-demand', A.fmt(demand));
    A.setText('ui-co-cp-share', (share * 100).toFixed(1) + '%');
    A.setText('ui-co-cp-val', A.fmt(demand) + ' / ' + A.fmt(pool));

    // 进度条画的是「吃掉了多少供给」，满格 = 刚好吃满
    const useRatio = demand.gt(0)
      ? demand.div(pool.gt(0) ? pool : new D(1)).toNumber()
      : 0;
    A.$('ui-co-cp-bar').style.width =
      Math.round(Math.max(0, Math.min(1, useRatio)) * 100) + '%';

    const cpScale = A.$('ui-co-cp-scale');
    const tiers = Core.companyComputeTiers(A.state);
    let prioLines = 0;
    for (const l of GAME.company.lines) {
      if (Core.linePriority(A.state, l.id) && Core.lineUnits(A.state, l.id).length) prioLines += 1;
    }
    if (demand.lte(0)) {
      cpScale.className = 'hint';
      cpScale.textContent = '无产线开工';
    } else if (scale >= 0.999) {
      cpScale.className = 'hint ok';
      // 后期算力通常远远富余（设备 + AI 投向的累加把池子推到 1e22 量级，需求才 1e14），
      // 这时「优先生产」标记是**没有任何效果**的。不说明的话，玩家会以为开关坏了 ——
      // 一个能点但看不出作用的开关，比没有这个开关更糟。
      cpScale.textContent = '算力充足 · 满负荷' + (prioLines > 0
        ? '　（已标记 ' + prioLines + ' 条优先线；当前算力不缺，暂不影响产量）'
        : '');
    } else if (prioLines > 0) {
      cpScale.className = 'hint ' + (scale < 0.5 ? 'err' : 'warn');
      cpScale.textContent = '算力不足 · 优先线按 ' + (tiers.pri * 100).toFixed(0) +
        '%　其余线按 ' + (tiers.norm * 100).toFixed(0) + '% 运转';
    } else {
      cpScale.className = 'hint ' + (scale < 0.5 ? 'err' : 'warn');
      cpScale.textContent = '算力不足 · 全厂按 ' + (scale * 100).toFixed(0) + '% 运转';
    }
    A.setText('ui-co-cp-tip', share <= 0
      ? '「工业产能」份额为 0 —— 产线买再多也不会转。去「投向」页把算力拨过来。'
      : '提高「工业产能」份额 = 提高全厂产能；它会和境界修行抢同一份算力。');

    // ---------- 生产线（每台可单独选产物、调产能）----------
    let lineCount = 0;
    // v3.7：折叠不再重建 DOM —— 直接切 .folded 类 + 高度动画就够了。
    // 重建反而更糟：新骨架里 [data-role="lunits"] 是空的，而台数没变、
    // 重建签名也没变，于是「每一台」的配置行会一直不回填，直到玩家再买一条线
    // （台数变了才触发重建）才冒出来 —— 就是那个「改了产物看不见」的 bug。
    const lineItems = A.$('co-line-list').querySelectorAll('.co-line');
    for (let i = 0; i < lineItems.length; i++) {
      const el = lineItems[i];
      const line = GAME.company.lines.find((x) => x.id === el.dataset.line);
      if (!line) continue;

      const units = Core.lineUnits(A.state, line.id);
      const owned = units.length;
      const unlocked = Core.lineUnlocked(A.state, line);
      const price = Core.lineCost(A.state, line);
      const prods = Core.lineProducts(line);
      const prio = Core.linePriority(A.state, line.id);
      // 优先线和非优先线拿到的算力成色不一样，产量要按**这条线自己的**削减系数算
      const lscale = Core.unitComputeScale(A.state, line);
      lineCount += owned;

      el.classList.toggle('locked', !unlocked && owned === 0);
      el.classList.toggle('prio', prio);
      const prioBtn = el.querySelector('[data-role="lprio"]');
      if (prioBtn) {
        prioBtn.classList.toggle('on', prio);
        prioBtn.textContent = prio ? '优先 ★' : '优先';
        prioBtn.title = prio
          ? '已开启：算力不足时优先保障这条线（点击关闭）'
          : '开启后，工业产能不足时优先保障这条线';
      }
      el.querySelector('[data-role="lowned"]').textContent = '×' + A.fmtCount(owned);
      el.querySelector('[data-role="lcap"]').textContent = '已拥有 ' + A.fmtCount(owned) + ' 条';

      // 每帧重拼但几乎从不变化 —— setHTML 写前比对，省掉无效的子树解析
      A.setHTML(el.querySelector('[data-role="lstats"]'),
        '产能上限 ' + A.esc(A.fmt(new D(line.maxCompute))) + ' 算力 / 台' +
        '　可选产物 ' + prods.length + ' 种' +
        '　<span class="faint">满负荷基准 ' + A.esc(A.fmtNum(line.baseOutput)) + ' 件 / 台 · 周期</span>');

      const lockEl = el.querySelector('[data-role="llock"]');
      if (unlocked) {
        lockEl.classList.add('hidden');
      } else {
        lockEl.classList.remove('hidden');
        lockEl.textContent = '未解锁 · ' + Core.lineLockedReason(A.state, line);
      }

      const priceEl = el.querySelector('[data-role="lprice"]');
      priceEl.textContent = A.fmt(price);
      priceEl.classList.toggle('no', A.state.money.lt(price));

      const buyBtn = el.querySelector('[data-role="lbuy"]');
      buyBtn.disabled = !unlocked || A.state.money.lt(price);

      A.renderLineUnits(el, line, units, prods, lscale);
    }
    A.$('ui-co-line-hint').textContent = lineCount > 0
      ? ('共 ' + A.fmtCount(lineCount) + ' 条生产线 · 每台可单独换产物')
      : '买下一条线只是拿到产能上限，转起来要靠工业算力';

    // 每个行业组头：显示该行业共有几台（批量操作的作用范围一目了然）
    const lGroups = A.$('co-line-list').querySelectorAll('.co-line-group');
    for (let i = 0; i < lGroups.length; i++) {
      const gid = lGroups[i].dataset.industry;
      let n = 0;
      for (const l of GAME.company.lines) {
        if (l.industry === gid) n += Core.lineUnits(A.state, l.id).length;
      }
      const ownEl = lGroups[i].querySelector('[data-role="lgown"]');
      if (ownEl) ownEl.textContent = n ? ('　已购 ' + A.fmtCount(n) + ' 台') : '　未购产线';
    }
  }

  /**
   * 回填一条产线下「每一台」的配置行。
   *
   * 结构只在**台数或产物**变化时重建 —— 产能是拖动条，玩家正拖着的时候
   * 如果把 DOM 整个换掉，拖动会被打断。所以产能只回写显示值，且焦点在它上面时不回写。
   */
  /**
   * 重建签名存在**元素自己身上**（data-usig），不用模块级缓存表。
   *
   * 原因：模块级 Map 的生命周期比 DOM 长。分组骨架一旦被重建（折叠、切页、
   * 重新登录），新元素里的 units 盒子是空的，可缓存表里还留着旧签名 —— 于是
   * 「签名没变 → 不重建」，盒子就一直空着，玩家改产物也看不到，非得再买一条线
   * （台数变了、签名才变）才冒出来。签名跟着元素走，元素换了自然就重建，
   * 不管是谁、什么时候重建的 DOM。
   */
  A.renderLineUnits = function renderLineUnits(el, line, units, prods, scale) {
    const box = el.querySelector('[data-role="lunits"]');
    if (!box) return;
    const sig = units.length + '|' + units.map((u) => u.p).join(',');

    if (box.getAttribute('data-usig') !== sig || box.children.length !== units.length) {
      box.setAttribute('data-usig', sig);
      box.innerHTML = units.map((u, idx) => {
        const opts = prods.map((g) =>
          '<option value="' + A.esc(g.id) + '"' + (g.id === u.p ? ' selected' : '') + '>' +
          A.esc(g.name) + '</option>').join('');
        return '<div class="co-unit" data-unit="' + idx + '">' +
          '<span class="co-unit-idx">#' + (idx + 1) + '</span>' +
          '<select class="co-unit-sel" data-role="uproduct" aria-label="第 ' + (idx + 1) + ' 台的产物">' +
            opts +
          '</select>' +
          '<input type="range" min="0" max="100" step="5" value="' + Math.round(u.r * 100) + '" ' +
            'class="co-unit-range" data-role="urate" aria-label="第 ' + (idx + 1) + ' 台的产能">' +
          '<span class="co-unit-rate" data-role="uratetxt">' + Math.round(u.r * 100) + '%</span>' +
          '<span class="co-unit-out" data-role="uout"></span>' +
          '<button class="btn sm ghost" data-role="uapplyall" title="把这台的配置套用到整条线">全部套用</button>' +
        '</div>';
      }).join('');
    }

    // 只回写数值与产能显示（不重建 DOM，避免打断拖动）
    const rows = box.querySelectorAll('.co-unit');
    for (let i = 0; i < rows.length; i++) {
      const u = units[i];
      if (!u) continue;
      const outEl = rows[i].querySelector('[data-role="uout"]');
      const good = Core.goodById(u.p);
      if (outEl) {
        if (!good || !Core.unitActive(u)) {
          outEl.className = 'co-unit-out off';
          outEl.textContent = '停机';
        } else {
          outEl.className = 'co-unit-out';
          const perCycle = Core.unitOutput(A.state, line, u, scale);
          const unitPrice = Core.goodsPriceWith(A.state, good);
          outEl.textContent = A.fmtNum(perCycle) + ' 件 / 周期　毛 ' + A.fmt(unitPrice.mul(perCycle));
        }
      }
      const rng = rows[i].querySelector('[data-role="urate"]');
      if (rng && document.activeElement !== rng) {
        const want = String(Math.round(u.r * 100));
        if (rng.value !== want) rng.value = want;
      }
      const txt = rows[i].querySelector('[data-role="uratetxt"]');
      if (txt) txt.textContent = Math.round(u.r * 100) + '%';
    }
  }

  /**
   * 公司 / 股市相关操作统一走 A.serverAction（POST /api/action），不走
   * 「本地先改、再同步」的老路：公司是「一次性付费 + 单向状态」的经济系统，
   * 股市成交必须由服务端按自己的报价裁决 —— 让服务端比前端直接改数稳妥得多。
   */
  A.foundCompany = async function foundCompany() {
    const r = await A.serverAction('foundCompany');
    if (!r) return;
    A.toast('公司已成立　—　去「生产线」买下第一条产线', 'ok');
  }

  A.lineBuyQty = function lineBuyQty() {
    const el = document.getElementById('line-buy-qty');
    const v = el ? Math.floor(Number(el.value) || 1) : 1;
    return Math.max(1, Math.min(100, v));
  }

  A.buyLine = async function buyLine(lineId) {
    const qty = A.lineBuyQty();
    const r = await A.serverAction('buyLine', { lineId: lineId, count: qty });
    if (!r) return;
    const line = GAME.company.lines.find((l) => l.id === lineId);
    const bought = r.bought || 1;
    A.toast('已购入「' + (line ? line.name : lineId) + '」×' + bought +
      (r.asked > bought ? '（想买 ' + r.asked + ' 台，金钱只够 ' + bought + ' 台）' : '') +
      '（共 ' + r.owned + ' 条）', 'ok');
  }

  /**
   * 调整一台（或一整条线的全部台）产线的产物 / 产能。
   * 与买线不同：这是纯粹的配置变更，本地内核先改、下次同步推上去即可；
   * 但走服务端能保证「产物必须是这条线能造的」这层校验不被绕过。
   */
  A.setLineUnit = async function setLineUnit(lineId, index, patch) {
    const r = await A.serverAction('setLineUnit', {
      lineId: lineId, index: index, product: patch.product, rate: patch.rate,
    });
    if (!r) return;
    // index === 'all' 时服务端返回 all=true，提示语要说清楚改了几台
    A.toast('已更新产线配置' + (r.all ? '（整条线 ' + r.count + ' 台）' : ''), 'ok');
  }

  /**
   * 整条线的「优先生产」开关。
   * 只在算力不够时才有意义：开了的线先吃满，剩下的才轮到没开的线。
   */
  A.setLinePriority = async function setLinePriority(lineId, on) {
    const r = await A.serverAction('setLinePriority', { lineId: lineId, priority: on });
    if (!r) return;
    const line = GAME.company.lines.find((l) => l.id === lineId);
    A.toast((on ? '已开启优先生产：「' : '已关闭优先生产：「') + (line ? line.name : lineId) +
      '」' + (on ? '　算力不足时优先保障这条线' : '　恢复按全厂比例分摊'), 'ok');
  }

  /**
   * 一个行业下的全部产线批量设产能（1 = 一键满速，0 = 一键停工）。
   * 逐台点太反人类，批量只改已经买入的台，没买过的线不受影响。
   */
  A.setIndustryRate = async function setIndustryRate(industryId, rate) {
    const r = await A.serverAction('setIndustryRate', { industryId: industryId, rate: rate });
    if (!r) return;
    const ind = GAME.company.industries.find((x) => x.id === industryId);
    const name = ind ? ind.name : industryId;
    if (!r.units) {
      A.toast('「' + name + '」还没有买入任何产线，无需调整', 'warn');
      return;
    }
    A.toast(rate >= 1
      ? '「' + name + '」已一键满速：' + r.lines + ' 条线 · ' + r.units + ' 台全部 100%'
      : '「' + name + '」已一键停工：' + r.lines + ' 条线 · ' + r.units + ' 台全部停机', 'ok');
  }

  A.upgradeWarehouse = async function upgradeWarehouse() {
    const r = await A.serverAction('upgradeWarehouse');
    if (!r) return;
    A.toast('仓库扩容至 Lv.' + r.level + '　容量 ' + A.fmtCount(r.capacity) + ' 件', 'ok');
  }
})(typeof window !== 'undefined' ? window : globalThis);
