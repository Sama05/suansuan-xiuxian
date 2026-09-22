"""本机私有的演示账号读取器（不参与版本控制）。

**为什么要有这个文件**：仓库是公开的，而脚本默认登录的账号是本地演示号 ——
把用户名/密码写进代码等于把它们一起公开。所以真实值放在 `tools/_local.json`
（已加进 `.gitignore`，只存在于本机）：

    {
      "user": "你的演示账号",
      "pwd": "你的演示密码"
    }

读取优先级：环境变量 `SUANSUAN_<KEY>` > `tools/_local.json` > 中性默认值。
中性默认值只是为了「脚本能被跑起来并给出清晰报错」，它不是一个可用账号；
真要跑这些脚本，请在命令行传参或配好上面两个来源之一。
"""
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))


def local(key, fallback=''):
    """取一个本机私有配置项。找不到就回落。"""
    env = os.environ.get('SUANSUAN_' + (key or '').upper())
    if env:
        return env
    try:
        with open(os.path.join(_HERE, '_local.json'), encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get(key):
            return data[key]
    except Exception:
        pass
    return fallback
