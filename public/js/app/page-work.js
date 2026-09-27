/**
 * app · page-work —— 工作页：精力与工作列表渲染 + 选工作/催工/暂停。
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

  A.renderWorkPage = function renderWorkPage() {
    const job = Core.jobById(A.state.jobId);
    // 精力一律按整数显示：上限带功法被动 / 渡劫淬体的百分比乘区，会出现 660.0000001
    // 这类浮点尾巴，显示成小数只会让人困惑。计算照旧用全精度，只在显示层取整。
    const maxE = Math.round(Core.maxEnergy(A.state));
    const regen = Core.energyRegen(A.state);

    // ---- 精力 ----
    const eRatio = maxE > 0 ? Math.max(0, Math.min(1, A.state.energy / maxE)) : 0;
    const fill = A.$('ui-energy-bar');
    fill.style.width = (eRatio * 100).toFixed(1) + '%';
    fill.classList.toggle('low', eRatio <= GAME.energy.lowRatio);
    A.$('ui-energy-val').textContent = Math.floor(A.state.energy) + ' / ' + maxE;
    const regenTxt = regen % 1 === 0 ? String(regen) : regen.toFixed(1);
    A.$('ui-energy-rate').textContent = '+' + regenTxt + ' / 秒';

    if (job) {
      A.$('ui-energy-next').textContent = '每份工作消耗 ' + job.energy + ' 点';
      if (A.state.energy < job.energy) {
        const wait = (job.energy - A.state.energy) / regen;
        A.$('ui-energy-wait').innerHTML = '<span class="warn">还需 ' + A.fmtRealDuration(wait) + ' 恢复</span>';
      } else {
        A.$('ui-energy-wait').textContent = '';
      }
    } else {
      A.$('ui-energy-next').textContent = '尚未选择工作';
      A.$('ui-energy-wait').textContent = '';
    }

    // ---- 当前工作 ----
    if (!job) {
      A.$('ui-job-name').textContent = '—';
      A.$('ui-job-real').textContent = '';
      A.$('ui-job-bar').style.width = '0%';
      A.$('ui-job-time').textContent = '未选择工作';
      A.$('ui-job-eta').textContent = '';
      A.$('ui-job-money').textContent = '+0';
      A.$('ui-job-spirit').classList.add('hidden');
      A.$('ui-job-stone').classList.add('hidden');
      A.$('btn-rush').disabled = true;
      A.$('ui-job-status').textContent = '空闲';
    } else {
      const dur = Core.jobDurationSeconds(job);
      const prog = dur > 0 ? Math.max(0, Math.min(1, A.state.jobProgress / dur)) : 0;
      const remainGame = Math.max(0, dur - A.state.jobProgress);
      const speed = Core.gameSecondsPerRealSecond(A.state);
      const remainReal = speed > 0 ? remainGame / speed : 0;
      const enough = A.state.energy >= job.energy;

      A.$('ui-job-name').textContent = job.name;
      A.$('ui-job-real').textContent = job.real;
      A.$('ui-job-bar').style.width = (prog * 100).toFixed(2) + '%';
      A.$('ui-job-time').textContent =
        Core.fmtGameDuration(A.state.jobProgress) + ' / ' + Core.fmtGameDuration(dur);

      if (!A.state.working) {
        A.$('ui-job-eta').textContent = '已暂停';
      } else if (!enough) {
        A.$('ui-job-eta').textContent = '精力不足，等待中';
      } else {
        A.$('ui-job-eta').textContent = '约 ' + A.fmtRealDuration(remainReal) + ' 后完成';
      }

      const inc = Core.jobIncome(job);
      A.$('ui-job-money').textContent = '+' + A.fmt(inc.money);
      const sp = A.$('ui-job-spirit');
      if (job.spirit) {
        sp.classList.remove('hidden');
        sp.textContent = '+' + A.fmt(inc.spirit) + ' 灵气';
      } else {
        sp.classList.add('hidden');
      }
      const st = A.$('ui-job-stone');
      if (job.stone) {
        st.classList.remove('hidden');
        st.textContent = '+' + A.fmt(inc.stone) + ' 灵石';
      } else {
        st.classList.add('hidden');
      }

      A.$('btn-rush').disabled = !enough;
      A.$('btn-toggle-work').textContent = A.state.working ? '暂停' : '继续';
      A.$('ui-job-status').textContent = !A.state.working
        ? '已暂停'
        : (enough ? '进行中' : '精力不足');
    }

    // ---- 工作列表 ----
    const items = A.$('job-list').querySelectorAll('.job-item');
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const j = Core.jobById(el.dataset.job);
      if (!j) continue;
      const unlocked = Core.jobUnlocked(A.state, j);
      const done = Core.jobDoneCount(A.state, j.id);
      const dur = Core.jobDurationSeconds(j);

      el.classList.toggle('locked', !unlocked);
      el.classList.toggle('active', A.state.jobId === j.id);

      const lockEl = el.querySelector('[data-role="lock"]');
      if (unlocked) {
        lockEl.classList.add('hidden');
      } else {
        lockEl.classList.remove('hidden');
        lockEl.textContent = '未解锁 · ' + Core.lockedReason(A.state, j);
      }

      el.querySelector('[data-role="jstat"]').textContent =
        '耗时 ' + Core.fmtGameDuration(dur) + '　精力 ' + j.energy;
      el.querySelector('[data-role="jdone"]').textContent =
        '已完成 ' + A.fmtCount(done) + ' 次';

      el.querySelector('[data-role="jmoney"]').textContent =
        unlocked ? ('+' + A.fmt(new D(j.money))) : '—';

      const spEl = el.querySelector('[data-role="jspirit"]');
      if (j.spirit) {
        spEl.classList.remove('hidden');
        spEl.textContent = '+' + A.fmt(new D(j.spirit)) + ' 灵气';
      } else {
        spEl.classList.add('hidden');
      }

      const stEl = el.querySelector('[data-role="jstone"]');
      if (j.stone) {
        stEl.classList.remove('hidden');
        stEl.textContent = '+' + A.fmt(new D(j.stone)) + ' 灵石';
      } else {
        stEl.classList.add('hidden');
      }
    }
  }

  A.selectJob = async function selectJob(jobId) {
    if (!A.state) return;
    const r = Core.setJob(A.state, jobId);
    if (!r.ok) {
      A.toast(r.msg || '无法选择该工作', 'err');
      return;
    }
    A.dirty = true;
    const job = Core.jobById(jobId);
    A.toast('已开始「' + job.name + '」', 'ok');
    A.renderAll();
    A.syncNow();
  }

  A.rushJob = async function rushJob() {
    if (!A.state) return;
    const r = Core.rushJob(A.state, 1);
    if (!r.ok) {
      A.toast(r.msg, 'err');
      return;
    }
    A.dirty = true;
    let msg = '+' + A.fmt(r.money);
    if (r.spirit.gt(0)) msg += '　+' + A.fmt(r.spirit) + ' 灵气';
    if (r.stone.gt(0)) msg += '　+' + A.fmt(r.stone) + ' 灵石';
    A.toast('催工完成　' + msg, 'ok');
    A.renderAll();
    A.syncNow();
  }

  A.toggleWork = async function toggleWork() {
    if (!A.state) return;
    Core.setWorking(A.state, !A.state.working);
    A.dirty = true;
    A.renderAll();
    A.syncNow();
  }
})(typeof window !== 'undefined' ? window : globalThis);
