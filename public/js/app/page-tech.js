/**
 * app · page-tech —— 设备页：设备列表渲染与购买（含修仙×科技双造价）。
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

  A.DEV_ICONS = {
    pc: 'PC', workstation: 'WS', cluster: 'CL',
    datacenter: 'DC', megacenter: 'MC',
    spiritrack: '灵电', leyline: '脉', array: '阵',
    cavecenter: '洞天', voidlattice: '太虚',
  };

  A.renderTechPage = function renderTechPage() {
    for (const dev of GAME.devices) {
      const el = document.querySelector('[data-dev="' + dev.id + '"]');
      if (!el) continue;

      const owned = A.state.devices[dev.id] || 0;
      const cost  = Core.deviceCost(A.state, dev);
      const stoneCost = Core.deviceStoneCost(A.state, dev);
      const canMoney = A.state.money.gte(cost);
      const canStone = !stoneCost.gt(0) || A.state.spiritStone.gte(stoneCost);
      const can   = canMoney && canStone;

      el.querySelector('[data-role="owned"]').textContent = '×' + owned;

      // 设备属性说明
      const bits = ['算力 +' + A.fmt(new D(dev.compute))];
      if (dev.shenshiBonus) bits.push('神识 +' + dev.shenshiBonus);
      if (dev.stonePerSecond) bits.push('灵石 +' + dev.stonePerSecond + '/秒');
      el.querySelector('[data-role="stat"]').textContent = bits.join('　');

      const priceEl = el.querySelector('[data-role="price"]');
      priceEl.textContent = A.fmt(cost);
      priceEl.classList.toggle('no', !canMoney);

      const stoneEl = el.querySelector('[data-role="stone"]');
      if (stoneCost.gt(0)) {
        stoneEl.classList.remove('hidden');
        stoneEl.textContent = '+ ' + A.fmt(stoneCost) + ' 灵石';
        stoneEl.classList.toggle('no', !canStone);
      } else {
        stoneEl.classList.add('hidden');
      }

      const discEl = el.querySelector('[data-role="disc"]');
      const costFactor = Core.hardwareCostFactor(A.state, dev);
      if (costFactor < 0.999) {
        discEl.classList.remove('hidden');
        discEl.textContent = '折 ' + ((1 - costFactor) * 100).toFixed(0) + '%';
      } else {
        discEl.classList.add('hidden');
      }

      const buyBtn = el.querySelector('[data-role="buy"]');
      buyBtn.disabled = !can;
      el.classList.toggle('locked', owned === 0 && !can);
    }
  }

  A.buyDevice = async function buyDevice(deviceId) {
    const beforeIds = new Set(Object.keys(A.state.learned));
    const r = Core.buyDevice(A.state, deviceId);
    if (!r.ok) {
      A.toast(r.msg, 'err');
      return;
    }
    A.dirty = true;
    const dev = GAME.devices.find((d) => d.id === deviceId);
    let msg = '已购买 ' + dev.name + '（共 ' + r.owned + ' 台）';
    if (r.stoneCost.gt(0)) msg += '　耗灵石 ' + A.fmt(r.stoneCost);
    A.toast(msg, 'ok');

    // 买到个人电脑触发了第一本功法 —— 这是本作最重要的一次解锁，必须说清楚
    const newIds = Object.keys(A.state.learned).filter((id) => !beforeIds.has(id));
    if (newIds.length) {
      const names = newIds.map((id) => {
        const t = Core.techById(id);
        return t ? '《' + t.name + '》' : id;
      }).join('、');
      setTimeout(() => {
        A.toast('习得功法 ' + names + '　—　灵气、神识、功法算力投入已解锁', 'ok');
      }, 380);
    }

    A.renderAll();
    A.syncNow();
  }
})(typeof window !== 'undefined' ? window : globalThis);
