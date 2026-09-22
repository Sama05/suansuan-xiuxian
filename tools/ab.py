"""agent-browser 包装器 —— 绕过本机损坏的 Git Bash shim。

用法：
    python tools/ab.py open http://localhost:3210
    python tools/ab.py wait --load load
    python tools/ab.py screenshot --path preview/x.png
    python tools/ab.py close

也支持一次传多条（用 ; 分隔的字符串），例如：
    python tools/ab.py "open URL ; wait --load load ; screenshot --path p.png"

背景：本机 PATH 上的 node 未必能直接跑 agent-browser（需 node 18+，且其内部会
spawn node 子进程），所以显式用系统 node 并把它的目录前置到 PATH。
"""
import os
import shlex
import subprocess
import sys
import tempfile

NODE_DIR = r"D:\Application\nodejs"
NODE = os.path.join(NODE_DIR, "node.exe")
ROOT = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "npm",
                    "node_modules", "agent-browser")
CLI = os.path.join(ROOT, "bin", "agent-browser.js")


def _exec(args, timeout=240):
    """跑一条命令，返回 (退出码, 合并后的输出)。"""
    env = os.environ.copy()
    env["PATH"] = NODE_DIR + os.pathsep + env.get("PATH", "")
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as f:
        p = subprocess.Popen([NODE, CLI] + list(args),
                             stdout=f, stderr=subprocess.STDOUT, env=env)
        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait(timeout=10)
        f.seek(0)
        out = f.read() or ""
    return p.returncode, out


def run(args, timeout=240):
    """跑一条 agent-browser 命令，打印输出，返回退出码。

    ⚠️ 这里刻意**不用管道**接输出：agent-browser 的守护进程会继承子进程的
    stdout 句柄，管道永远等不到 EOF，调用会假死（表现为打开成功但迟迟不返回）。
    改用临时文件收输出，再给一个超时兜底。
    """
    rc, out = _exec(args, timeout=timeout)
    sys.stdout.write(out)
    sys.stdout.write("\n[rc=%s] agent-browser %s\n" % (rc, " ".join(args)))
    sys.stdout.flush()
    return rc


def capture(args, timeout=240):
    """跑一条命令，只返回输出（不打印），用于 eval / snapshot 这类要读结果的调用。"""
    _, out = _exec(args, timeout=timeout)
    return out


def main():
    if not os.path.exists(CLI):
        print("agent-browser 未安装：%s 不存在" % CLI)
        return 2
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        return 2
    # 规则很简单：单个参数且含 ';' 时按多条命令拆；其余情况整个 argv 就是一条命令。
    # 不要按「第一个词是不是已知子命令」去猜 —— 像 `screenshot --full path`
    # 这种以选项开头的调用会被误判成多条命令。
    if len(argv) == 1 and ";" in argv[0]:
        argv = [s.strip() for s in argv[0].split(";") if s.strip()]
        rc = 0
        for chunk in argv:
            rc = run(shlex.split(chunk))
            if rc != 0:
                break
        return rc
    return run(argv)


if __name__ == "__main__":
    sys.exit(main())
