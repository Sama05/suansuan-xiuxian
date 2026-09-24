"""v3.8 功能验收（真浏览器，可复跑）。

一、生产线批量操作（一键满速 / 一键停工 + 状态反馈）
二、优先生产 —— 在真·算力不足的存档（scarce_demo）上验分档
三、市场四种排序 + 分组折叠动画
四、顶栏算力拆解（副行数字必须和标题对得上账）
五、后期存档快照

前置：
  1) 服务端 3210 跑最新代码；
  2) 账号密码取 tools/_local.json（USER / PWD）；
  3) 第二段依赖 `node tools/make-scarce-demo.js` 造的 scarce_demo 存档 ——
     后期存档的算力永远富余（池 1e22 vs 需 1e14），分档根本不可见，
     必须用专用存档才能验证「优先生产」。

用法：python tools/verify-v38.py   （全项通过退出码 0）
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ab  # noqa: E402
from _env import local  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://localhost:3210"
USER = local("user")
PWD = local("pwd")
SCARCE = "scarce_demo"

FAIL = []


def ev(js, timeout=120):
    out = ab.capture(["eval", js], timeout=timeout)
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    return lines[-1] if lines else ""


def clean(v):
    """agent-browser 的 eval 会把字符串结果加上一对引号 —— 统一剥掉。"""
    v = (v or "").strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1]
    return v


def txt(js):
    return clean(ev("String(%s)" % js))


def num(js):
    v = clean(ev("String(%s)" % js)).replace(",", "")
    for tok in v.split():
        try:
            return float(tok)
        except ValueError:
            continue
    return -1


def parse_fmt(tok):
    """把 app.js 里 fmt() 的显示串反解回数值 —— 只用于验收时「数字能不能对上账」。

    支持三种形态（与 public/js/app.js 的 fmt / fmtNum 保持一致）：
      1.05e20          指数式（e >= 15）
      1.05兆 / 3.2亿 / 8万   中文单位（e 在 [6,15)）
      12345 / 67.8     纯数字
    """
    tok = (tok or "").strip().replace(",", "")
    for suf, mul in (("兆", 1e12), ("亿", 1e8), ("万", 1e4)):
        if tok.endswith(suf):
            try:
                return float(tok[: -len(suf)]) * mul
            except ValueError:
                return None
    try:
        return float(tok)
    except ValueError:
        return None


def check(name, cond, extra=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (("  -> " + str(extra)) if extra else ""))
    if not cond:
        FAIL.append(name)


def login(user, pwd):
    ab.run(["open", BASE])
    time.sleep(1.0)
    ev("try{localStorage.clear()}catch(e){};'ok'")
    ab.run(["open", BASE])
    time.sleep(1.4)
    if "true" not in ev(
        "document.getElementById('login-screen').classList.contains('hidden')"
    ).lower():
        ab.run(["type", "#in-username", user])
        ab.run(["type", "#in-password", pwd])
        ab.run(["click", "#btn-login"])
        for _ in range(30):
            time.sleep(0.4)
            if "true" in ev(
                "document.getElementById('login-screen').classList.contains('hidden')"
            ).lower():
                break
    time.sleep(2.5)
    for _ in range(10):
        if "true" not in ev(
            "!!(document.getElementById('modal-ok') && document.querySelector('.modal-mask'))"
        ).lower():
            break
        ab.run(["click", "#modal-ok"], timeout=60)
        time.sleep(0.5)
    # 错误收集器 + toast 记录器（toast 只活 2.2 秒，跨进程读必然错过）
    ev("window.__err=[];window.onerror=function(m){window.__err.push(String(m))};"
       "window.__toasts=[];"
       "(function(){var z=document.getElementById('toast-zone');if(!z)return;"
       "new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){"
       "var ns=ms[i].addedNodes;for(var j=0;j<ns.length;j++){"
       "if(ns[j].textContent)window.__toasts.push(ns[j].textContent);}}}).observe(z,{childList:true});"
       "})();'ok'")
    time.sleep(0.3)


def tab(name):
    ev("document.querySelector(\"[data-tab='%s']\").click();'ok'" % name)
    time.sleep(1.3)


def line_js(line_id, expr):
    return ("(function(){var e=document.querySelector('.co-line[data-line=\"%s\"]');"
            "if(!e)return 'no-line';%s})()" % (line_id, expr))


def line_out(line_id):
    return txt(line_js(line_id, "var o=e.querySelector('[data-role=\"uout\"]');"
                                "return o?o.textContent.replace(/\\s+/g,' '):'no-out';"))


def line_prio(line_id):
    return txt(line_js(line_id, "return e.classList.contains('prio')?'on':'off';"))


def click_prio(line_id):
    return txt(line_js(line_id, "var b=e.querySelector('[data-role=\"lprio\"]');"
                                "if(!b)return 'no-btn';b.click();return 'clicked';"))


def qty(s):
    """从 '21.24 件 / 周期 毛 201,779' 里取出 21.24"""
    return float(s.split("件")[0].strip().replace(",", ""))


def main():
    # ============================================================
    print("\n=========== 二、优先生产：真·算力不足（scarce_demo）===========")
    login(SCARCE, PWD)
    tab("company")
    print("  顶栏境界        :", txt("document.getElementById('ui-realm-top').textContent"))
    hint0 = txt("document.getElementById('ui-co-cp-scale').textContent")
    print("  算力状态行      :", hint0)
    check("scarce_demo 确实处于「算力不足」",
          "算力不足" in hint0 and "优先线按 100%" in hint0 and "其余线按 30%" in hint0, hint0)

    P, N = "talismanry", "alchemy"
    print("  符箓工坊        : 优先=%s　产出 %s" % (line_prio(P), line_out(P)))
    print("  丹房            : 优先=%s　产出 %s" % (line_prio(N), line_out(N)))
    before = (line_out(P), line_out(N))
    check("初始：优先线开关为 on、普通线为 off",
          line_prio(P) == "on" and line_prio(N) == "off",
          "%s / %s" % (line_prio(P), line_prio(N)))

    click_prio(N)
    time.sleep(2.0)
    hint2 = txt("document.getElementById('ui-co-cp-scale').textContent")
    after = (line_out(P), line_out(N))
    print("  点丹房「优先」后:")
    print("    状态行        :", hint2)
    print("    丹房按钮/样式 :", txt(line_js(N, "var b=e.querySelector('[data-role=\"lprio\"]');"
                                            "return b.textContent+' / '+(b.classList.contains('on')?'on':'off');")))
    print("    符箓工坊      :", before[0], "→", after[0])
    print("    丹房          :", before[1], "→", after[1])

    p0, p1 = qty(before[0]), qty(after[0])
    n0, n1 = qty(before[1]), qty(after[1])
    ratioN = n1 / n0
    ratioP = p1 / p0
    print("    产出比        : 丹房 ×%.3f（期望 0.698/0.30 = 2.327）　符箓工坊 ×%.3f（期望 0.698）"
          % (ratioN, ratioP))
    check("标优先后丹房产出上升 ≈2.33×", abs(ratioN - 2.327) < 0.15, "%.3f" % ratioN)
    check("标优先后符箓工坊降至 ≈69.8%", abs(ratioP - 0.698) < 0.05, "%.3f" % ratioP)
    check("状态行同步成新的分档", "优先线按 70%" in hint2, hint2)

    click_prio(N)
    time.sleep(1.5)
    print("  已把丹房的优先关回:")
    print("    丹房优先态    :", line_prio(N))
    print("    状态行        :", txt("document.getElementById('ui-co-cp-scale').textContent"))
    ab.run(["screenshot", "--full", os.path.join(ROOT, "preview", "shot-v38-scarce.png")], timeout=180)

    # ============================================================
    print("\n=========== 一、生产线批量操作（后期存档）===========")
    login(USER, PWD)
    tab("company")
    print("  顶栏境界        :", txt("document.getElementById('ui-realm-top').textContent"))
    print("  产线总数        :", txt("document.getElementById('ui-co-line-hint').textContent"))
    gcount = num("document.querySelectorAll('.co-line-group').length")
    print("  行业组 / 批量按钮:", gcount, "/", num("document.querySelectorAll('[data-role=\"lrun\"]').length"),
          "满速,", num("document.querySelectorAll('[data-role=\"lstop\"]').length"), "停工")
    print("  优先开关数      :", num("document.querySelectorAll('[data-role=\"lprio\"]').length"))
    check("每个产业组头都有「一键满速 / 一键停工」",
          num("document.querySelectorAll('[data-role=\"lrun\"]').length") == gcount and
          num("document.querySelectorAll('[data-role=\"lstop\"]').length") == gcount)
    check("每条生产线都有「优先生产」开关",
          num("document.querySelectorAll('[data-role=\"lprio\"]').length") ==
          num("document.querySelectorAll('.co-line').length"))

    pick = txt("(function(){var gs=document.querySelectorAll('.co-line-group');"
               "for(var i=0;i<gs.length;i++){var l=gs[i].querySelectorAll('.co-unit').length;"
               "if(l>0){window.__g=gs[i];return gs[i].dataset.industry+'|'+l;}}return 'none';})()")
    print("  选中行业        :", pick)
    gid = pick.split("|")[0]
    folded0 = txt("window.__g.classList.contains('folded')")
    rates = ("(function(){return Array.from(window.__g.querySelectorAll('[data-role=\"urate\"]'))"
             ".map(function(r){return r.value}).join(',');})()")

    r_before = txt(rates)
    print("  操作前产能      :", r_before)
    txt("(function(){window.__toasts=[];window.__g.querySelector('[data-role=\"lstop\"]').click();return 'ok';})()")
    time.sleep(1.8)
    r_stop = txt(rates)
    print("  一键停工后      :", r_stop)
    print("  停工提示        :", txt("(window.__toasts||[]).join(' / ')"))
    check("一键停工：该行业全部台产能归 0", set(r_stop.split(",")) == {"0"}, r_stop)
    check("一键停工有明确提示", txt("(window.__toasts||[]).length") not in ("0", "-1", ""),
          txt("(window.__toasts||[]).join(' / ')"))

    txt("(function(){window.__toasts=[];window.__g.querySelector('[data-role=\"lrun\"]').click();return 'ok';})()")
    time.sleep(1.8)
    r_run = txt(rates)
    print("  一键满速后      :", r_run)
    print("  满速提示        :", txt("(window.__toasts||[]).join(' / ')"))
    check("一键满速：该行业全部台产能回到 100", set(r_run.split(",")) == {"100"}, r_run)
    check("一键满速有明确提示", txt("(window.__toasts||[]).length") not in ("0", "-1", ""),
          txt("(window.__toasts||[]).join(' / ')"))
    check("批量按钮不误触折叠", folded0 == txt("window.__g.classList.contains('folded')"))
    print("  组头范围显示    :", txt("window.__g.querySelector('[data-role=\"lgown\"]').textContent"))

    print("  ---- 优先开关（后期算力富余，只验状态与持久化）----")
    lp = txt("(function(){var l=window.__g.querySelector('.co-line');if(!l)return 'none';"
             "window.__l=l;return l.dataset.line;})()")
    was = txt("window.__l.classList.contains('prio')")
    print("  切换的产线      :", lp, "　当前 prio =", was)
    if was == "true":
        # 上一次验收可能把它留成开启 —— 先归位，让下面这段与初始状态无关
        click_prio(lp)
        time.sleep(1.6)
        print("  （先归位）现 prio :", txt("window.__l.classList.contains('prio')"))
    txt("(function(){window.__toasts=[];return 'ok';})()")
    click_prio(lp)
    time.sleep(1.8)
    print("  行 prio 类      :", txt("window.__l.classList.contains('prio')"))
    print("  按钮文案/样式   :", txt("window.__l.querySelector('[data-role=\"lprio\"]').textContent + ' / ' + "
                                  "(window.__l.querySelector('[data-role=\"lprio\"]').classList.contains('on')?'on':'off')"))
    print("  提示            :", txt("(window.__toasts||[]).join(' / ')"))
    check("优先开关：行加 prio 类、按钮变 on 且文案切换",
          txt("window.__l.classList.contains('prio')") == "true" and
          "★" in txt("window.__l.querySelector('[data-role=\"lprio\"]').textContent"))

    # 持久化：整页重载
    ab.run(["open", BASE])
    time.sleep(3.5)
    for _ in range(6):
        if "true" not in ev(
            "!!(document.getElementById('modal-ok') && document.querySelector('.modal-mask'))"
        ).lower():
            break
        ab.run(["click", "#modal-ok"], timeout=60)
        time.sleep(0.5)
    tab("company")
    persisted = txt("(function(){var l=document.querySelector('.co-line[data-line=\"%s\"]');"
                    "return l?(l.classList.contains('prio')?'是':'否'):'未找到';})()" % lp)
    print("  重载后仍为优先  :", persisted)
    check("优先状态落盘（重载后仍是优先）", persisted == "是", persisted)
    # 刻意**不关**这条标记：留着它，顶栏算力状态行就会显示
    # 「算力充足 · 满负荷（已标记 N 条优先线；当前算力不缺，暂不影响产量）」，
    # 正好用来肉眼确认「算力充足时优先开关有解释」这条 UX 修复。
    print("  （刻意保留该优先标记，用于演示算力充足时的解释文案）")
    print("  算力状态行      :", txt("document.getElementById('ui-co-cp-scale').textContent"))

    # ============================================================
    print("\n=========== 三、市场排序 ===========")
    tab("market")
    time.sleep(1.2)
    print("  排序按钮        :", num("document.querySelectorAll('#mk-sortbar [data-sort]').length"))
    print("  初始 组/行      : %g / %g" % (
        num("document.querySelectorAll('#mk-good-list .mk-group').length"),
        num("document.querySelectorAll('#mk-good-list .co-good').length")))
    check("四个互斥排序按钮都在",
          txt("(function(){var b=document.querySelectorAll('#mk-sortbar [data-sort]');"
              "var o=[];for(var i=0;i<b.length;i++)o.push(b[i].dataset.sort);return o.sort().join(',');})()")
          == "drop,gain,industry,price")

    def sample():
        return txt("(function(){var a=document.querySelectorAll('#mk-good-list .co-good');"
                   "var o=[];for(var i=0;i<Math.min(3,a.length);i++)o.push(a[i].dataset.good);"
                   "var b=[];for(var i=Math.max(0,a.length-3);i<a.length;i++)b.push(a[i].dataset.good);"
                   "return o.join(',')+' || '+b.join(',');})()")

    def col(role):
        return txt("(function(){var a=document.querySelectorAll('#mk-good-list .co-good');"
                   "var o=[];for(var i=0;i<Math.min(3,a.length);i++){"
                   "var e=a[i].querySelector('[data-role=\"%s\"]');o.push(e?e.textContent:'?');}"
                   "return o.join(' / ');})()" % role)

    for field in ["price", "gain", "drop"]:
        txt("(function(){document.querySelector('#mk-sortbar [data-sort=\"%s\"]').click();return 'ok';})()" % field)
        time.sleep(1.4)
        g1 = num("document.querySelectorAll('#mk-good-list .mk-group').length")
        r1 = num("document.querySelectorAll('#mk-good-list .co-good').length")
        ar1 = txt("document.querySelector('#mk-sortbar [data-sort=\"%s\"] .ar').textContent" % field)
        asc = txt("document.querySelector('#mk-sortbar [data-sort=\"%s\"]').classList.contains('asc')" % field)
        on1 = txt("document.querySelector('#mk-sortbar [data-sort=\"%s\"]').classList.contains('on')" % field)
        h1 = txt("document.getElementById('ui-mk-sort-hint').textContent")
        s1 = sample()
        others = txt("(function(){var b=document.querySelectorAll('#mk-sortbar [data-sort]');var o=[];"
                     "for(var i=0;i<b.length;i++){if(!b[i].classList.contains('on'))"
                     "o.push(b[i].querySelector('.ar').textContent||'·');}return o.join('');})()")
        print("  [%s] 一次点击: 组%g 行%g 箭头%s asc=%s" % (field, g1, r1, ar1, asc))
        print("        %s" % h1)
        print("        首位 %s" % s1)
        check("%s：首次点击=升序(↓)且取消分组" % field,
              g1 == 0 and ar1 == "↓" and asc == "true" and on1 == "true", "组%g 箭头%s" % (g1, ar1))
        check("%s：其余按钮箭头全部清空（互斥）" % field, set(others) <= {"·"}, others)

        txt("(function(){document.querySelector('#mk-sortbar [data-sort=\"%s\"]').click();return 'ok';})()" % field)
        time.sleep(1.4)
        ar2 = txt("document.querySelector('#mk-sortbar [data-sort=\"%s\"] .ar').textContent" % field)
        desc = txt("document.querySelector('#mk-sortbar [data-sort=\"%s\"]').classList.contains('desc')" % field)
        s2 = sample()
        print("        再点一次: 箭头%s desc=%s　首位 %s" % (ar2, desc, s2))
        print("        %s" % txt("document.getElementById('ui-mk-sort-hint').textContent"))
        check("%s：再次点击=降序(↑)" % field, ar2 == "↑" and desc == "true")
        check("%s：升降序结果确实相反" % field, s1 != s2, "%s | %s" % (s1, s2))
        # 数据刷新后顺序保持
        time.sleep(3.5)
        print("        3.5s 后: 组%g 顺序%s" % (
            num("document.querySelectorAll('#mk-good-list .mk-group').length"),
            "保持" if s2 == sample() else "变化（价格随期变动，属正常）"))
        check("%s：3.5 秒后仍是平铺排序（没被渲染重置回分组）" % field,
              num("document.querySelectorAll('#mk-good-list .mk-group').length") == 0)

    # 回到行业
    txt("(function(){document.querySelector('#mk-sortbar [data-sort=\"industry\"]').click();return 'ok';})()")
    time.sleep(1.6)
    gback = num("document.querySelectorAll('#mk-good-list .mk-group').length")
    print("  回到行业        : 组%g 行%g on=%s" % (
        gback, num("document.querySelectorAll('#mk-good-list .co-good').length"),
        txt("document.querySelector('#mk-sortbar [data-sort=\"industry\"]').classList.contains('on')")))
    check("行业：恢复分组并保留折叠交互", gback == 48, gback)

    print("  ---- 折叠动画（rAF 采样 computed height）----")
    armed = txt("(function(){var h=document.querySelector('#mk-good-list [data-role=\"ghead\"]');"
                "if(!h)return 'no-head';var g=h.closest('.mk-group');"
                "var b=g.querySelector('.mk-group-body');window.__fs=[];window.__fdone=0;"
                "window.__f0=g.classList.contains('folded');"
                "h.click();var t0=performance.now();"
                "function step(){window.__fs.push(Math.round(parseFloat(getComputedStyle(b).height)||0));"
                "if(performance.now()-t0<450)requestAnimationFrame(step);else window.__fdone=1;}"
                "requestAnimationFrame(step);return 'armed|before='+window.__f0;})()")
    print("  采样已布置      :", armed)
    time.sleep(1.2)
    seq = txt("(window.__fs||[]).join(',')")
    print("  高度采样        :", seq)
    print("  折叠后带 folded :", txt("document.querySelector('#mk-good-list .mk-group').classList.contains('folded')"))
    print("  折叠未误触排序  :", txt("document.querySelector('#mk-sortbar [data-sort=\"industry\"]').classList.contains('on')"))
    nums = [int(x) for x in seq.split(",") if x.strip().isdigit()]
    mids = [v for v in nums if 0 < v < (max(nums) if nums else 0)]
    check("折叠有高度过渡（采样里出现中间值，不是瞬变）", len(mids) >= 2,
          "采样 %s" % seq)

    # 展开方向也测一次
    armed2 = txt("(function(){var h=document.querySelector('#mk-good-list [data-role=\"ghead\"]');"
                 "var g=h.closest('.mk-group');var b=g.querySelector('.mk-group-body');"
                 "window.__fs=[];h.click();var t0=performance.now();"
                 "function step(){window.__fs.push(Math.round(parseFloat(getComputedStyle(b).height)||0));"
                 "if(performance.now()-t0<450)requestAnimationFrame(step);}requestAnimationFrame(step);"
                 "return 'armed';})()")
    print("  展开采样已布置  :", armed2)
    time.sleep(1.2)
    seq2 = txt("(window.__fs||[]).join(',')")
    print("  高度采样        :", seq2)
    nums2 = [int(x) for x in seq2.split(",") if x.strip().isdigit()]
    mids2 = [v for v in nums2 if 0 < v < (max(nums2) if nums2 else 0)]
    check("展开也有高度过渡", len(mids2) >= 2, "采样 %s" % seq2)

    # ============================================================
    print("\n=========== 四、顶栏算力拆解（数字得自己对上账）===========")
    top_title = txt("document.getElementById('ui-compute').textContent")
    top_sub = txt("document.getElementById('ui-compute-sub').textContent")
    print("  标题 实际算力   :", top_title)
    print("  副行 拆解       :", top_sub)
    check("副行已由 JS 渲染（不是静态占位「设备提供」）",
          top_sub not in ("设备提供", "", "(null)", "-1"), top_sub)
    check("副行形如「设备 …[+ AI …]　乘区 ×…」",
          top_sub.startswith("设备 ") and "乘区 ×" in top_sub, top_sub)

    mtop = re.match(r"^设备\s+(\S+)(?:\s*\+\s*AI\s+(\S+))?\s*乘区\s*×\s*(\S+)$", top_sub)
    if not mtop:
        check("副行可被解析（格式没被改动）", False, top_sub)
    else:
        v_dev = parse_fmt(mtop.group(1))
        v_ai = parse_fmt(mtop.group(2)) if mtop.group(2) else 0.0
        v_mul = parse_fmt(mtop.group(3))
        v_tot = parse_fmt(top_title)
        print("  反解            : 设备=%s AI=%s 乘区=%s 标题=%s" % (v_dev, v_ai, v_mul, v_tot))
        if None in (v_dev, v_ai, v_mul, v_tot) or not v_tot:
            check("副行各段都能反解成数值", False, top_sub)
        else:
            v_calc = (v_dev + v_ai) * v_mul
            dev_pct = abs(v_calc - v_tot) / v_tot * 100.0
            print("  (设备+AI)×乘区  = %.4g　标题 = %.4g　偏差 %.2f%%" % (v_calc, v_tot, dev_pct))
            # 显示只保留 2 位有效数字 + 中文单位/指数，允许个位数百分比的舍入误差。
            check("(设备 + AI) × 乘区 ≈ 标题数值（容差 6%）", dev_pct < 6, "%.2f%%" % dev_pct)

    # ============================================================
    print("\n=========== 五、后期存档快照 ===========")
    tab("company")
    print("  境界            :", txt("document.getElementById('ui-realm-top').textContent"),
          "/", txt("document.getElementById('ui-realm-tier').textContent"))
    print("  金钱 / 灵气     :", txt("document.getElementById('ui-money').textContent"),
          "/", txt("document.getElementById('ui-qi').textContent"))
    print("  产线            :", txt("document.getElementById('ui-co-line-hint').textContent"))
    print("  算力状态        :", txt("document.getElementById('ui-co-cp-scale').textContent"))
    tab("stock")
    print("  股市行情行数    :", num("document.querySelectorAll('#st-list [data-stock]').length"))
    tab("invest")
    print("  投向预设按钮    :", txt("(function(){var ids=['btn-alloc-reset','btn-alloc-main','btn-alloc-even'];"
                                  "var o=[];for(var i=0;i<ids.length;i++){var e=document.getElementById(ids[i]);"
                                  "o.push(e?e.textContent:'(缺)'+ids[i]);}return o.join(' | ');})()"))

    print("\n=========== JS 错误 ===========")
    errs = txt("JSON.stringify(window.__err||[])")
    print("  错误汇总        :", errs)
    check("浏览器控制台无 JS 错误", errs == "[]", errs)

    ab.run(["screenshot", "--full", os.path.join(ROOT, "preview", "shot-v38-late-company.png")], timeout=180)
    tab("market")
    ab.run(["screenshot", "--full", os.path.join(ROOT, "preview", "shot-v38-market.png")], timeout=180)
    ab.run(["close"], timeout=60)

    print("\n" + "=" * 46)
    if FAIL:
        print("  未通过 %d 项：" % len(FAIL))
        for f in FAIL:
            print("    ✗ " + f)
    else:
        print("  全部通过")
    print("=" * 46)
    print("截图：preview/shot-v38-{scarce,late-company,market}.png")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
