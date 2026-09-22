"""真实浏览器演示「股市」页 —— 走完整点击路径并截图。

为什么单独写一个：`tests/frontend.test.js` 用的是 DOM 桩，`tests/e2e.js` 打的是接口。
「在真实浏览器里点『最大 → 买入 → 部分卖出 → 清仓』」这条路径两边都覆盖不到 ——
按钮的 disabled 逻辑、事件绑定、买入后行情条 / 持仓区是否真的重渲染，只有真浏览器能验。

它走的是真实玩法路径，不写库作弊：
  登录（账号由 tools/seed-demo.js 预置了天机阁 + 算力芯科的持仓）
  → 关掉离线结算弹窗 → 开股市页 → 读账户概览 → 点某行切走势图
  → 「最大」+「买入」→「卖出」一半 →「清仓」
  → 逐条断言冲击条、持仓、已实现盈亏的变化 → 截图

两个真机坑（都在这脚本里处理掉了，改的时候别踩回去）：

1. **离线结算弹窗会盖住整页。** 登录后如果距上次在线超过 60 秒，前端会往
   `document.body` 追加一个 `.modal-mask`。它盖在游戏区上方，`agent-browser` 的
   真实点击会落到弹窗上（有时甚至返回 rc=0 却什么也没发生）。所以每轮交互前先
   点 `#modal-ok` 关掉它。
2. **吸顶栏会盖住滚到它下面的行。** 行情列表比较长，行滚到顶栏下方时点不到。
   因此这里的 `click()` 一律「真实点击 → 校验效果 → 没生效才退化为 JS click」。
   JS click 也是真实 MouseEvent（会冒泡），前端用的是事件委托，处理链路完全一致。

前置：
    node tools/seed-demo.js stock_demo stockdemo123 3   # 先生成演示账号
    后端已在 3210 运行
    python tools/demo-stock.py
"""
import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import ab  # noqa: E402


def ev(expr, timeout=120):
    """eval 一段 JS，返回解码后的值。

    agent-browser 的 eval 输出是 JSON —— 字符串会带引号（`"167"`），
    数字/布尔则是裸的，所以要解一次码，否则拿到的全是带引号的字符串。
    """
    raw = ab.capture(["eval", expr], timeout=timeout)
    line = ""
    for ln in (raw or "").splitlines():
        if ln.strip():
            line = ln.strip()
    if not line:
        return None
    try:
        return json.loads(line)
    except ValueError:
        return line


def q(stock, role):
    return "document.querySelector('.st-row[data-stock=\"%s\"] [data-role=\"%s\"]')" % (stock, role)


def txt(stock, role):
    v = ev("(%s||{}).textContent" % q(stock, role))
    return "" if v is None else str(v)


def num(text):
    """把页面上「1.23万 / 4.56e3 / -7.8 / 493 股」这类显示值粗解析成浮点数。"""
    s = str(text).strip().replace(",", "").replace("+", "")
    m = re.match(r"^(-?[\d.]+)(万|亿)?", s)
    if not m:
        return None
    v = float(m.group(1))
    unit = m.group(2)
    if unit == "万":
        v *= 1e4
    elif unit == "亿":
        v *= 1e8
    return v


class Demo(object):
    """真浏览器操作封装。"""

    def __init__(self):
        self.fallback = 0
        self.modals = 0

    # ---------- 基础设施 ----------

    def dismiss_modals(self, limit=4):
        """关掉离线结算等遮罩弹窗 —— 不关掉后面所有真实点击都会落在弹窗上。"""
        for _ in range(limit):
            if not ev("document.querySelectorAll('.modal-mask').length"):
                return True
            ev("var b=document.querySelector('#modal-ok'); if(b){b.click();'ok'}"
               "else{var m=document.querySelector('.modal-mask'); if(m)m.remove();'removed'}")
            self.modals += 1
            time.sleep(0.4)
        return not ev("document.querySelectorAll('.modal-mask').length")

    def click(self, selector, probe=None, note=""):
        """真实点击 → 用 probe 表达式校验效果 → 没生效就退化为 JS click。

        probe 给的是一个「点了之后一定会变」的表达式（例如输入框的 value）。
        不给 probe 时只做真实点击，不做兜底。
        """
        before = ev(probe) if probe else None
        rc = ab.run(["click", selector])
        time.sleep(0.5)
        if probe is None or ev(probe) != before:
            return True
        self.fallback += 1
        print("  · 真实点击未生效（rc=%s，多半被吸顶栏/弹窗挡住），改用 JS click：%s" % (rc, selector))
        ev("var e=document.querySelector('%s'); if(e){e.click();'ok'} else {'missing'}" % selector)
        time.sleep(0.5)
        return ev(probe) != before

    def set_input(self, selector, value):
        ev("var e=document.querySelector('%s'); if(e){e.value='%s';"
           "e.dispatchEvent(new Event('input',{bubbles:true})); 'ok'} else {'missing'}"
           % (selector, value))
        time.sleep(0.3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3210")
    ap.add_argument("--user", default="stock_demo")
    ap.add_argument("--pwd", default="stockdemo123")
    ap.add_argument("--stock", default="tianji", help="用于买卖演示的股票")
    ap.add_argument("--out", default=os.path.join(ROOT, "preview", "shot-stock.png"))
    ap.add_argument("--keep", action="store_true", help="结束时保留浏览器")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    fails = []
    stats = {"n": 0}

    def check(cond, label, extra=""):
        stats["n"] += 1
        print(("  ✓ " if cond else "  ✗ ") + label + (("  " + extra) if extra else ""))
        if not cond:
            fails.append(label)

    d = Demo()
    S = ".st-row[data-stock=\"%s\"]" % args.stock
    qty_sel = q(args.stock, "stqty")

    # ---------- 登录 ----------
    ab.run(["open", args.base])
    ab.run(["wait", "--load", "load"])
    time.sleep(1.0)
    ab.run(["type", "#in-username", args.user])
    ab.run(["type", "#in-password", args.pwd])
    ab.run(["click", "#btn-login"])
    for _ in range(40):
        time.sleep(0.4)
        if ev("document.getElementById('login-screen').classList.contains('hidden')") is True:
            break
    time.sleep(1.5)

    print("\n=== 0. 准备 ===")
    check(d.dismiss_modals(), "已关闭所有遮罩弹窗（离线结算等）",
          "关了 %d 个" % d.modals if d.modals else "本来就没有")

    # ---------- 切到股市页 ----------
    d.click("#tab-stock",
            probe="!document.getElementById('stock-main').classList.contains('hidden')",
            note="切换股市标签")
    time.sleep(1.0)
    check(ev("!document.getElementById('stock-main').classList.contains('hidden')") is True,
          "股市页正文可见（账号已开户）")
    print("  账户标签：" + str(ev("document.getElementById('tab-stock-badge').textContent")))

    # ---------- 概览 ----------
    before = {
        "price": txt(args.stock, "stprice"),
        "cash": ev("document.getElementById('ui-st-cash').textContent"),
        "liq": ev("document.getElementById('ui-st-liq').textContent"),
        "liqpnl": ev("document.getElementById('ui-st-liqpnl').textContent"),
        "realized": num(ev("document.getElementById('ui-st-realized').textContent")),
        "fee": num(ev("document.getElementById('ui-st-fee').textContent")),
        "shares": num(txt(args.stock, "stshares")),
        "trades": num(ev("document.getElementById('ui-st-trades').textContent")),
        "rows": ev("document.querySelectorAll('#st-list .st-row').length"),
        "chart": ev("document.getElementById('ui-st-chart-name').textContent"),
    }
    print("\n=== 1. 开户初始状态 ===")
    for k in ("price", "cash", "liq", "liqpnl", "realized", "fee", "shares", "trades", "rows", "chart"):
        print("  %-9s %s" % (k, before[k]))
    check(before["rows"] == 5, "行情列表渲染出 5 只股票", str(before["rows"]))

    # ---------- 点行切走势图 ----------
    other = "lingmai" if args.stock != "lingmai" else "danxia"
    d.click(".st-row[data-stock=\"%s\"] .st-price" % other,
            probe="document.getElementById('ui-st-chart-name').textContent",
            note="切换走势图")
    now_chart = ev("document.getElementById('ui-st-chart-name').textContent")
    check(now_chart not in (None, "") and now_chart != before["chart"],
          "点行情行可切换走势大图", "%s → %s" % (before["chart"], now_chart))

    # ---------- 「最大」----------
    d.click(S + " [data-role=\"stmax\"]", probe=qty_sel + ".value", note="最大")
    qty = num(ev(qty_sel + ".value"))
    print("\n=== 2. 买入 ===")
    print("  「最大」给出的股数：" + str(qty))
    check(qty is not None and qty > 0, "「最大」给出可成交股数", str(qty))

    # 只买最大量的 1/3：既验证成交，又留够现金（也更贴近真实操作）
    part = max(1, int(int(qty) / 3))
    d.set_input(qty_sel, str(part))
    print("  买入预览：" + txt(args.stock, "stcost"))

    cash_before_buy = num(ev("document.getElementById('ui-st-cash').textContent"))
    d.click(S + " [data-role=\"stbuy\"]", probe=qty_sel + ".value", note="买入")
    time.sleep(1.0)

    after_buy = {
        "cash": num(ev("document.getElementById('ui-st-cash').textContent")),
        "shares": num(txt(args.stock, "stshares")),
        "impact": txt(args.stock, "stimptxt"),
        "imp_hidden": ev(q(args.stock, "stimp") + ".classList.contains('hidden')"),
        "trades": num(ev("document.getElementById('ui-st-trades').textContent")),
        "fee": num(ev("document.getElementById('ui-st-fee').textContent")),
    }
    for k in ("cash", "shares", "impact", "imp_hidden", "trades", "fee"):
        print("  %-9s %s" % (k, after_buy[k]))

    check(after_buy["cash"] < cash_before_buy, "买入后可用金钱减少",
          "%s → %s" % (cash_before_buy, after_buy["cash"]))
    check(after_buy["shares"] > before["shares"], "买入后持仓股数增加",
          "%s → %s" % (before["shares"], after_buy["shares"]))
    check(after_buy["imp_hidden"] is False and "推高" in after_buy["impact"],
          "买入后出现「买盘推高」冲击条", after_buy["impact"][:64])
    check(after_buy["trades"] == before["trades"] + 1, "成交笔数 +1",
          "%s → %s" % (before["trades"], after_buy["trades"]))
    check(after_buy["fee"] is not None and abs(after_buy["fee"]) > abs(before["fee"] or 0),
          "累计手续费增加（单边手续费已收）",
          "%s → %s" % (before["fee"], after_buy["fee"]))

    ab.run(["screenshot", "--full", os.path.join(ROOT, "preview", "shot-stock.png")])

    # ---------- 部分卖出：冲击应回落 ------------------
    half = max(1, int(int(qty) / 6))
    d.set_input(qty_sel, str(half))
    print("\n=== 3. 部分卖出 ===")
    print("  卖出预览：" + txt(args.stock, "stnet"))
    d.click(S + " [data-role=\"stsell\"]", probe=qty_sel + ".value", note="卖出")
    time.sleep(1.0)

    after_part = {
        "shares": num(txt(args.stock, "stshares")),
        "impact": txt(args.stock, "stimptxt"),
        "realized": num(ev("document.getElementById('ui-st-realized').textContent")),
    }
    for k in ("shares", "impact", "realized"):
        print("  %-9s %s" % (k, after_part[k]))
    check(after_part["shares"] < after_buy["shares"], "部分卖出后持仓减少",
          "%s → %s" % (after_buy["shares"], after_part["shares"]))
    check(num(after_part["realized"]) < (before["realized"] or 0),
          "部分卖出后「已实现盈亏」变负（本笔卖出即在亏钱）",
          "%s → %s" % (before["realized"], after_part["realized"]))

    # ---------- 清仓 ----------
    print("\n=== 4. 清仓 ===")
    d.click(S + " [data-role=\"stclose\"]", probe=qty_sel + ".value", note="清仓")
    time.sleep(1.0)

    after_all = {
        "shares": num(txt(args.stock, "stshares")),
        "imp_hidden": ev(q(args.stock, "stimp") + ".classList.contains('hidden')"),
        "realized": num(ev("document.getElementById('ui-st-realized').textContent")),
        "trades": num(ev("document.getElementById('ui-st-trades').textContent")),
    }
    for k in ("shares", "imp_hidden", "realized", "trades"):
        print("  %-9s %s" % (k, after_all[k]))

    check(after_all["shares"] == 0, "清仓后持仓归零", str(after_all["shares"]))
    check(after_all["realized"] < before["realized"], "已实现盈亏整体为负（买高卖低 + 双边手续费）",
          "%s → %s" % (before["realized"], after_all["realized"]))
    check(after_all["trades"] == before["trades"] + 3, "三笔成交（买 / 卖 / 清仓）全部记账",
          "%s → %s" % (before["trades"], after_all["trades"]))

    ab.run(["screenshot", "--full", os.path.join(ROOT, "preview", "shot-stock-after.png")])
    if not args.keep:
        ab.run(["close"])

    print("\n截图：")
    print("  买入后 " + os.path.join(ROOT, "preview", "shot-stock.png"))
    print("  清仓后 " + os.path.join(ROOT, "preview", "shot-stock-after.png"))
    if d.fallback:
        print("（其中 %d 次点击因被遮挡/未生效退化为 JS click）" % d.fallback)
    print("\n通过 %d   失败 %d" % (stats["n"] - len(fails), len(fails)))
    if fails:
        print("失败项：" + " / ".join(fails))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
