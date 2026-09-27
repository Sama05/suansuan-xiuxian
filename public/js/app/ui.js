/**
 * app · ui —— 界面基建：toast / $ / setText 值缓存 / esc / setT / 通用折叠组件 / 弹窗骨架。
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

  // 只在文本真正变化时才写 DOM。
  // A.renderTop 每 100ms 跑一次，无条件重写 textContent 会让浏览器反复做
  // 「replace data → 重新测量文本宽度 → 重排」，是顶栏细微抖动感的来源之一。
  // 加一层值缓存后，稳定不变的文本（如「突破境界用」）完全不再碰 DOM。
  A.textCache = Object.create(null);

  // ============================================================
  // 通用折叠 / 展开（v3.7）
  // ============================================================
  /*
   * 页面上所有「点一下收起、再点一下展开」的地方统一走这一处，不再各自实现。
   *
   * 用法（新增折叠点只需两步）：
   *   1. 给可点击的标题元素加 `data-collapse`（值是要展开的元素选择器，
   *      写 next 或不写就取它的下一个兄弟元素）；
   *   2. 容器上调用一次 A.bindCollapse(容器, { onToggle })。
   *
   * 折叠状态写在祖先的 `.folded` 类上（箭头靠 CSS 旋转），动画期间用
   * `.col-anim` 临时接管 display —— 这样「静止态由 CSS 决定、动画态由 JS 决定」，
   * 不会出现收起动画还没播完就被 display:none 抹掉的情况。
   */
  A.COLLAPSE_MS = 200;

  /** el -> { r: rafId, t: timerId }，防止连点把动画叠在一起 */
  A.collapseAnim = new WeakMap();

  /**
   * 只在值变化时才写 DOM。
   * 100ms 一帧的重绘里，绝大多数字段的值根本没变 —— 直接赋值也会让浏览器
   * 把对应节点标记为脏、重新做样式与布局。先比对再写，是这里最便宜的一档优化。
   */
  A.setT = function setT(el, prop, value) {
    if (!el) return;
    if (el[prop] !== value) el[prop] = value;
  }

  /**
   * innerHTML 版的写前比对 —— 与 setT 同理，但省的是「重新解析 HTML 子树」。
   * 用在每帧都会重拼的大段 HTML 上（产线统计行、被动汇总、规则说明），
   * 值没变时跳过赋值，浏览器就不会反复解析 + 重建子树。
   */
  A.setHTML = function setHTML(el, html) {
    if (!el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  A.collapseBodyOf = function collapseBodyOf(head) {
    const sel = head.getAttribute('data-collapse');
    if (!sel || sel === 'next') return head.nextElementSibling;
    return head.parentElement ? head.parentElement.querySelector(sel) : null;
  }

  /**
   * 高度过渡：展开 0 → 内容高，收起 内容高 → 0，结束后把高度交还给 CSS。
   * @param {HTMLElement} el 要展开 / 收起的元素
   * @param {boolean} open true 展开
   * @param {function} [onDone] 动画结束回调
   * @param {string} [hideClass] 收起结束后要加的类（如 'hidden'）；组头折叠靠 .folded，不传
   */
  A.slideToggle = function slideToggle(el, open, onDone, hideClass) {
    if (!el) { if (onDone) onDone(); return; }
    const prev = A.collapseAnim.get(el);
    if (prev && prev.t) clearTimeout(prev.t);
    const rec = { t: 0 };
    A.collapseAnim.set(el, rec);

    el.classList.remove('hidden');   // 动画期间不能被 .hidden 压住
    el.classList.add('col-anim');

    /**
     * 起始高度 → **强制一次同步布局** → 目标高度。
     *
     * 中间那步 `void el.offsetHeight` 不能省，也不能换成 requestAnimationFrame：
     * rAF 回调排在样式计算**之前**，所以「起始值」和「目标值」会落进同一次 recalc，
     * 浏览器只看到 `auto → 0px` —— 而 auto 不可插值，过渡被直接跳过，收起就成了瞬变。
     * 只有读一次布局属性（offsetHeight）把起始高度真正落到**计算值**上，
     * transition 才有东西可以插值。
     *
     * 症状上的表现很有迷惑性：**展开有动画、收起没有**。
     * 因为展开时 `el.scrollHeight` 恰好是在赋值之后读的，那一次读顺带把布局刷了，
     * 于是「碰巧」有动画 —— 依赖这种巧合的动画等于没有。
     */
    el.style.height = (open ? 0 : el.scrollHeight) + 'px';
    void el.offsetHeight;
    el.style.height = (open ? el.scrollHeight : 0) + 'px';

    rec.t = setTimeout(() => {
      el.classList.remove('col-anim');
      el.style.height = '';
      if (!open && hideClass) el.classList.add(hideClass);
      if (onDone) onDone();
    }, A.COLLAPSE_MS + 30);
  }

  /**
   * 给容器里的 [data-collapse] 元素挂上点击折叠（事件委托，重建 DOM 也不失效）。
   * @param {HTMLElement} root 容器
   * @param {object} [opts] { onToggle(head, group, folded) }
   */
  A.bindCollapse = function bindCollapse(root, opts) {
    if (!root) return;
    opts = opts || {};
    root.addEventListener('click', (e) => {
      // 组头里可能塞了按钮（一键满速 / 优先生产……），点它们不该顺手折叠分组
      if (e.target.closest('[data-nocollapse]')) return;
      const head = e.target.closest('[data-collapse]');
      if (!head || !root.contains(head)) return;
      const body = A.collapseBodyOf(head);
      if (!body) return;
      const group = head.closest('.mk-group, .co-line-group') || head.parentElement;
      const folded = !group.classList.contains('folded');   // 当前展开 -> 接下来收起
      // 先切类：箭头（CSS 旋转）立刻跟着动，不等动画结束
      if (folded) group.classList.add('folded'); else group.classList.remove('folded');
      A.slideToggle(body, !folded);
      head.setAttribute('aria-expanded', folded ? 'false' : 'true');
      if (opts.onToggle) opts.onToggle(head, group, folded);
    });
  }

  A.toast = function toast(msg, type) {
    const zone = document.getElementById('toast-zone');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    zone.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(22px)';
      setTimeout(() => el.remove(), 320);
    }, 2200);
  }

  A.$ = (id) => document.getElementById(id);

  A.setText = function setText(id, value) {
    const txt = String(value);
    if (A.textCache[id] === txt) return;
    const el = A.$(id);
    if (!el) return;
    A.textCache[id] = txt;
    el.textContent = txt;
  }

  A.esc = function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  A.buildModal = function buildModal(cfg) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';

    const rows = (cfg.rows || []).map(([k, v]) =>
      '<div class="modal-row"><span class="k">' + A.esc(k) + '</span><span class="v">' + A.esc(v) + '</span></div>'
    ).join('');

    mask.innerHTML =
      '<div class="modal">' +
        '<div class="modal-head">' + A.esc(cfg.title) + '</div>' +
        '<div class="modal-body">' + rows +
          (cfg.note ? '<div class="modal-note">' + A.esc(cfg.note) + '</div>' : '') +
        '</div>' +
        '<div class="modal-foot"><button class="btn primary" id="modal-ok">' +
          A.esc(cfg.okText || '确定') + '</button></div>' +
      '</div>';

    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('#modal-ok').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
