"""真实浏览器端到端检查 —— 开页面 → 登录 → 切到指定子页面 → 截图 + 抓文本。

和 tests/frontend.test.js 的 DOM 桩互补：桩跑得快、能覆盖分支，但它不是浏览器。
这个是真 Chromium，能发现「桩环境里看不出来」的问题（真实布局、CSS 失效、
运行时异常导致白屏等）。

前置：后端已在 3210 运行。

用法：
    python tools/browser-check.py                       # 默认看公司页
    python tools/browser-check.py --tab work --out preview/shot-work.png
    python tools/browser-check.py --keep                 # 结束后不关浏览器

账号来源：`--user/--pwd` > 环境变量 `SUANSUAN_USER`/`SUANSUAN_PWD` >
本机私有文件 `tools/_local.json`。真实账号不写进仓库（见 tools/_env.py）。
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ab  # noqa: E402
from _env import local  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def step(args, fatal=True):
    rc = ab.run(args)
    if rc != 0 and fatal:
        print("!! 命令失败：%s" % " ".join(args))
        sys.exit(rc)
    return rc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3210")
    ap.add_argument("--user", default=local("user", "demo"))
    ap.add_argument("--pwd", default=local("pwd", "demo1234"))
    ap.add_argument("--tab", default="company")
    ap.add_argument("--out", default=os.path.join(ROOT, "preview", "shot-company.png"))
    ap.add_argument("--settle", type=float, default=2.5, help="登录后等页面渲染的秒数")
    ap.add_argument("--keep", action="store_true", help="结束时保留浏览器")
    ap.add_argument("--snapshot", action="store_true", help="顺便打印页面文本快照")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    step(["open", args.base])
    # wait 是可降级的：某些页面永远不会进入 networkidle，失败就继续
    step(["wait", "--load", "load"], fatal=False)
    time.sleep(1.0)

    step(["type", "#in-username", args.user])
    step(["type", "#in-password", args.pwd])
    step(["click", "#btn-login"])

    # 等登录 + 首屏渲染。轮询登录框是否隐藏，避免死等固定时长。
    for _ in range(30):
        time.sleep(0.4)
        out = ab.capture(["eval", "document.getElementById('login-screen').classList.contains('hidden')"])
        if "true" in out.lower():
            break
    time.sleep(args.settle)

    # 「闭关归来」离线结算弹窗会盖住整个页面（而且它是先于游戏界面渲染的）。
    # 不点掉它，截图永远是一张弹窗 —— 所以只要它还在就点「继续修行」。
    for _ in range(10):
        out = ab.capture(["eval",
                          "!!(document.getElementById('modal-ok') && "
                          "document.querySelector('.modal-mask'))"])
        if "true" not in out.lower():
            break
        step(["click", "#modal-ok"], fatal=False)
        time.sleep(0.5)
    time.sleep(0.6)

    if args.tab:
        step(["click", "#tab-%s" % args.tab], fatal=False)
        time.sleep(1.2)

    if args.snapshot:
        step(["snapshot"], fatal=False)

    step(["screenshot", "--full", args.out], fatal=False)

    if not args.keep:
        step(["close"], fatal=False)
    print("\n截图：%s" % args.out)


if __name__ == "__main__":
    main()
