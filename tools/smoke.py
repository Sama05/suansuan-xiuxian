"""冒烟检查：登录演示账号，校验新系统字段是否完整回传。

/api/load  -> { ok, isNew, state(原始存档), config(公开配置), offline }
/api/view  -> { ok, view(实时视图) }

账号从本机私有文件 / 环境变量取（仓库是公开的，不外泄真实账号），见 tools/_env.py。
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _env import local  # noqa: E402

B = 'http://localhost:3210'


def post(p, body, tok=None):
    req = urllib.request.Request(B + p, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    if tok:
        req.add_header('x-token', tok)
    return json.loads(urllib.request.urlopen(req, timeout=5).read().decode())


def get(p, tok=None):
    req = urllib.request.Request(B + p)
    if tok:
        req.add_header('x-token', tok)
    return json.loads(urllib.request.urlopen(req, timeout=5).read().decode())


r = post('/api/login', {'username': local('smokeUser', 'demo'),
                        'password': local('smokePwd', 'demo1234')})
print('登录:', r.get('ok'), r.get('username'))
tok = r['token']

ld = get('/api/load', tok)
cfg = ld.get('config') or {}
print('离线结算:', ld.get('offline'))

v = get('/api/view', tok).get('view') or {}
missing = [k for k in ('gameSeconds', 'gameDate', 'gameSpeed', 'timeTier', 'autoTier',
                       'maxTier', 'energy', 'maxEnergy', 'jobId', 'jobProgress',
                       'working', 'jobDone', 'totalJobs', 'rushCount', 'technique',
                       'investments')
           if k not in v]
print('实时视图缺失字段:', missing or '无')

print('境界:', v.get('realm'), '| 游戏内日期:', v.get('gameDate'),
      '| 速率档:', v.get('timeTier'), '/', v.get('maxTier'),
      '| 速度(游戏秒/实时秒):', v.get('gameSpeed'))
print('精力:', v.get('energy'), '/', v.get('maxEnergy'),
      '| 当前工作:', v.get('jobId'), '| 进行中:', v.get('working'),
      '| 进度:', v.get('jobProgress'))
print('金钱:', v.get('money'), '| 灵石:', v.get('spiritStone'))
print('各工作完成数:', v.get('jobDone'))
print('投向可分配:', v.get('investments'))
print('投向比例:', v.get('alloc'))
print('功法:', v.get('technique'))
print('配置工作数:', len(cfg.get('jobs') or []),
      '| 速率档位:', [t.get('name') for t in (cfg.get('time', {}).get('tiers') or [])],
      '| 功法已实现:', cfg.get('techniques', {}).get('implemented'))
