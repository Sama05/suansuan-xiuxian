"""临时脚本：用真实浏览器走一遍「抛压」路径并截图。

走的是**真实玩法路径**，不做任何写库作弊：
  登录（autoSell 关、仓库满 4700 件）→ 开公司页 → 点「全部卖出」
  → 等一个「期数边界」（该账号 1 现实秒 = 1 游戏月，科技类每游戏年结算一次，约 12 秒）
  → 这一刻 sold ≫ produced，抛压直接拉满 → 截图

可比对：注入前后 marketSummary 的 peak、价格相对自然价的跌幅、抛压条宽度。
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import ab  # noqa: E402

B = "http://localhost:3210"
USER, PWD = "press_demo", "pressdemo123"
OUT = os.path.join(ROOT, "preview", "shot-company.png")


def nudge():
    """读一下页面上的市场提示，用于确认抛压已经出现。"""
    return ab.capture(["eval", "document.getElementById('ui-co-market-hint').textContent"]).strip()


def main():
    ab.run(["open", B])
    ab.run(["wait", "--load", "load"])
    time.sleep(1.0)
    ab.run(["type", "#in-username", USER])
    ab.run(["type", "#in-password", PWD])
    ab.run(["click", "#btn-login"])
    for _ in range(30):
        time.sleep(0.4)
        if "true" in ab.capture(
                ["eval", "document.getElementById('login-screen').classList.contains('hidden')"]).lower():
            break
    time.sleep(1.5)
    ab.run(["click", "#tab-company"])
    time.sleep(1.5)
    print("卖出前市场提示：", nudge()[:160])

    # 真实交互：清空库存（4700 件）→ 本期卖出 ≫ 本期产出
    ab.run(["click", "#btn-co-sell-all"])
    time.sleep(2.0)
    print("清仓后市场提示：", nudge()[:160])

    # 等一个期数边界让抛压结算；最多等 30 秒
    peak = 0.0
    for i in range(30):
        time.sleep(1.0)
        raw = ab.capture(["eval", "window.__mktPeak===undefined?'':String(window.__mktPeak)"])
        # 前端没暴露全局变量，退而求其次：从提示文本里抓「抛压最高 X%」
        txt = nudge()
        import re
        m = re.search(r"抛压最高\s*([\d.]+)%", txt)
        if m:
            peak = float(m.group(1))
        print("  t=%2ds  %s" % (i + 1, txt[:120]))
        if peak > 20:
            break

    ab.run(["screenshot", "--full", OUT])
    ab.run(["close"])
    print("\n最终抛压峰值 %.1f%%\n截图：%s" % (peak, OUT))


if __name__ == "__main__":
    main()
