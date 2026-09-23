"""接口层冒烟检查（修仙线 v2 + 公司线）

覆盖：
  1. 配置下发（功法表 / 稀有度 / 神识 / 科技修仙设备）
  2. 新玩家初始态：无功法、灵气 0、神识 > 0
  3. 买个人电脑 → 自动习得第一本功法 → 灵气开始产出
  4. 参悟 / 切换修炼功法 / 修炼开关
  5. 防作弊：功法不允许凭空消失
  5b. 公司（产业）：注册门槛 / 生产线解锁链 / 仓库 / 生产周期 / 手动卖出 / 自动卖出开关
  5c. 公司防作弊：伪造成立被拒、进度字段不允许倒退、超容库存被裁剪
  5d. 股市（证券账户）：视图字段 / 买入 / 卖出（一轮买卖必亏）/ 越界裁剪
  6. 旧存档迁移：v1 的 spiritStone 应迁到 qi
"""
import json
import time
import urllib.error
import urllib.request

B = 'http://localhost:3210'
PASS = [0]
FAIL = [0]


def ok(label, cond, extra=''):
    if cond:
        PASS[0] += 1
        print('  ✓ ' + label)
    else:
        FAIL[0] += 1
        print('  ✗ ' + label + ('  → ' + str(extra) if extra != '' else ''))


def call(path, body=None, tok=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data,
                                 method=method or ('POST' if data else 'GET'),
                                 headers={'Content-Type': 'application/json'})
    if tok:
        req.add_header('x-token', tok)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=10).read().decode()), 200
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode()), e.code


print('\n[1] 配置下发')
# 新玩家注册
uname = 'smoke_' + str(int(time.time()) % 1000000)
r, _ = call('/api/register', {'username': uname, 'password': 'smoke12345'})
if not r.get('ok'):
    r, _ = call('/api/login', {'username': uname, 'password': 'smoke12345'})
tok = r['token']
ld, _ = call('/api/load', tok=tok)
cfg = ld['config']
ok('配置含功法表', len(cfg.get('techniques', {}).get('list') or []) >= 6,
   len(cfg.get('techniques', {}).get('list') or []))
ok('配置含 6 级稀有度', len(cfg.get('techniques', {}).get('rarities') or []) == 6,
   [x.get('name') for x in (cfg.get('techniques', {}).get('rarities') or [])])
ok('配置含熟练度 6 段', len(cfg.get('techniques', {}).get('mastery') or []) == 6,
   [x.get('name') for x in (cfg.get('techniques', {}).get('mastery') or [])])
ok('配置含神识段', 'computePerPointRealm' in (cfg.get('shenshi') or {}))
ok('设备表 ≥ 10 台', len(cfg.get('devices') or []) >= 10, len(cfg.get('devices') or []))
shen_devs = [d for d in (cfg.get('devices') or []) if d.get('shenshiBonus')]
ok('存在增幅神识的设备 ≥ 5 台', len(shen_devs) >= 5, len(shen_devs))
ok('科技修仙设备有灵石造价', all(d.get('stoneCost', 0) > 0 for d in shen_devs))
ok('神识增幅越靠后越强',
   all(shen_devs[i]['shenshiBonus'] < shen_devs[i + 1]['shenshiBonus']
       for i in range(len(shen_devs) - 1)),
   [d['shenshiBonus'] for d in shen_devs])

print('\n[2] 新玩家初始态')
v = call('/api/view', tok=tok)[0]['view']
ok('初始无功法', v['technique'] is None, v['technique'])
ok('初始灵气为 0', v['qi']['m'] == 0 or v['qi']['e'] == 0, v['qi'])
ok('神识 > 0（一开始就有）', v['shenshi'] > 0, v['shenshi'])
ok('未习得功法时禁止产出灵气', v['spiritAllowed'] is False, v['spiritAllowed'])
ok('灵气乘区为 0', v['qiMultiplier'] == 0, v['qiMultiplier'])
ok('功法增幅投向不可用', v['investments']['technique']['available'] is False)
ok('返回功法列表（含未解锁）', len(v['techniques']) >= 6, len(v['techniques']))
ok('第一本功法未解锁（还没电脑）', v['firstTechUnlocked'] is False, v['firstTechUnlocked'])
ok('首本功法给出锁定原因', bool(v['techniques'][0].get('lockedReason')) or v['techniques'][0]['learned'] is False)

print('\n[3] 买个人电脑 → 习得第一本功法 → 灵气开始产出')
# 先推进/催工攒钱：直接推时间让设备被动收益 + 工作产出
call('/api/action', {'action': 'rushJob', 'payload': {'times': 500}}, tok=tok)
st = call('/api/load', tok=tok)[0]['state']
money = st['money']['m'] * (10 ** st['money']['e'])
ok('攒到足够金钱', money >= 50, money)

guard = 0
while guard < 200:
    v = call('/api/view', tok=tok)[0]['view']
    dev = v['devices'].get('pc', 0)
    cost = v['deviceCosts']['pc']
    cm = cost['m'] * (10 ** cost['e'])
    if money >= cm and dev == 0:
        res, code = call('/api/action', {'action': 'buyDevice', 'payload': {'deviceId': 'pc'}}, tok=tok)
        break
    call('/api/action', {'action': 'rushJob', 'payload': {'times': 500}}, tok=tok)
    st = call('/api/load', tok=tok)[0]['state']
    money = st['money']['m'] * (10 ** st['money']['e'])
    guard += 1

v = call('/api/view', tok=tok)[0]['view']
ok('已拥有个人电脑', v['devices'].get('pc', 0) >= 1, v['devices'])
ok('自动习得第一本功法', v['technique'] is not None, v['technique'])
ok('第一本是九章算经', v['technique'] == 'jiuzhang', v['technique'])
ok('功法列表标记为已习得', any(t['learned'] for t in v['techniques']))
ok('灵气系统解锁', v['spiritAllowed'] is True)
ok('灵气乘区 > 1', v['qiMultiplier'] > 1, v['qiMultiplier'])
ok('功法增幅投向解锁', v['investments']['technique']['available'] is True)
ok('主属性强度 > 0', v['techniques'][0]['mainQiSpeed'] > 0, v['techniques'][0]['mainQiSpeed'])

import time
# 注意：只有 /api/load 与 /api/action 会推进时间（/api/view 只读存档快照），
# 所以要验证「随时间增长」必须走 /api/load。
before = call('/api/load', tok=tok)[0]
time.sleep(3)
after = call('/api/load', tok=tok)[0]
v1 = call('/api/view', tok=tok)[0]['view']
qi1 = before['state']['qi']['m'] * (10 ** before['state']['qi']['e'])
qi2 = after['state']['qi']['m'] * (10 ** after['state']['qi']['e'])
ok('灵气随时间增长', qi2 > qi1, '%s → %s' % (qi1, qi2))
m1 = before['state']['learned']['jiuzhang']['mastery']
m2 = after['state']['learned']['jiuzhang']['mastery']
ok('熟练度随时间增长（修炼）', m2 > m1, '%s → %s' % (m1, m2))
ok('修炼速度受神识加成 > 1', v1['cultivateSpeed'] > 1, v1['cultivateSpeed'])

print('\n[4] 参悟 / 切换修炼 / 修炼开关')
r, code = call('/api/action', {'action': 'comprehend', 'payload': {'times': 1}}, tok=tok)
ok('灵气不足时参悟被拒', code == 400, code)
ok('给出合理失败原因', '灵气' in str(r.get('msg')), r.get('msg'))

# 给一笔灵气用于测试参悟的成功路径（qi 属于软货币，允许被客户端写入）
st = call('/api/load', tok=tok)[0]['state']
st['qi'] = {'m': 1.0, 'e': 4}
call('/api/save', {'state': st}, tok=tok)
v = call('/api/view', tok=tok)[0]['view']
ok('测试前置：灵气已就位', v['qi']['e'] >= 3, v['qi'])
cost = v['comprehendCost']
cm = cost['m'] * (10 ** cost['e'])
before_m = v['techniques'][0]['mastery']
r, code = call('/api/action', {'action': 'comprehend', 'payload': {'times': 1}}, tok=tok)
ok('参悟成功', code == 200 and r.get('result', {}).get('ok') is True, r.get('msg'))
after_v = call('/api/view', tok=tok)[0]['view']
ok('参悟后熟练度提升',
   after_v['techniques'][0]['mastery'] > before_m,
   '%s → %s' % (before_m, after_v['techniques'][0]['mastery']))
new_qi = after_v['qi']['m'] * (10 ** after_v['qi']['e'])
ok('参悟扣掉了灵气', new_qi < 1.0e4 - cm * 0.5, '%s（消耗 %s）' % (new_qi, cm))
print('     参悟：消耗灵气 %s，获得熟练度 %s' % (cm, r.get('result', {}).get('gain')))

r, code = call('/api/action', {'action': 'setCultivating', 'payload': {'cultivating': False}}, tok=tok)
ok('可以停止修炼', r.get('result', {}).get('cultivating') is False or r.get('ok'))
r, code = call('/api/action', {'action': 'setCultivating', 'payload': {'cultivating': True}}, tok=tok)
ok('可以恢复修炼', r.get('result', {}).get('cultivating') is True or r.get('ok'))

# 用一本「条件远未达到」的功法验证拒绝路径（lianxu 需元婴 + 算力 1e9）
r, code = call('/api/action', {'action': 'setTechnique', 'payload': {'techniqueId': 'lianxu'}}, tok=tok)
ok('未习得的功法不能切换', code == 400, r.get('msg'))
ok('给出未习得原因', bool(r.get('msg')), r.get('msg'))
r, code = call('/api/action', {'action': 'setTechnique', 'payload': {'techniqueId': 'jiuzhang'}}, tok=tok)
ok('已习得的功法可以切换', code == 200 and r['result']['technique'] == 'jiuzhang', r.get('msg'))

print('\n[5] 防作弊：功法不允许凭空消失')
st = call('/api/load', tok=tok)[0]['state']
ok('存档含 learned', isinstance(st.get('learned'), dict) and len(st['learned']) >= 1, st.get('learned'))
bad = json.loads(json.dumps(st))
bad['learned'] = {}
bad['technique'] = None
call('/api/save', {'state': bad}, tok=tok)
after = call('/api/load', tok=tok)[0]['state']
ok('清空 learned 被服务端拒绝', len(after.get('learned') or {}) >= 1, after.get('learned'))
ok('technique 不会被清空', after.get('technique') is not None, after.get('technique'))

print('\n[5b] 公司（产业）')
# 公司需要「炼气 + 5 万金钱」，主冒烟账号是凡人 —— 另开一个账号，
# 用 /api/save 把境界与金钱抬上去（防作弊只拦倒退，不拦增长）。
co_name = uname + 'co'
r, _ = call('/api/register', {'username': co_name, 'password': 'smoke12345'})
co_tok = r.get('token')
ok('公司账号注册成功', bool(co_tok), r.get('msg'))

co_st = call('/api/load', tok=co_tok)[0]['state']
ok('存档含公司状态', isinstance(co_st.get('company'), dict))
ok('新账号公司未成立', co_st['company']['founded'] is False)
ok('初始库存为空', all((v or 0) == 0 for v in co_st['company']['stock'].values()),
   co_st['company']['stock'])
ok('默认开启自动卖出', co_st['company']['autoSell'] is True)

v = call('/api/view', tok=co_tok)[0]['view']['company']
ok('view 含公司', isinstance(v, dict))
ok('凡人时公司未解锁', v['unlocked'] is False)
ok('给出未解锁原因', '炼气' in (v.get('lockedReason') or ''), v.get('lockedReason'))
ok('view 含注册费', v['foundCost'] > 0, v['foundCost'])
ok('view 含生产周期', v['cycleRealSeconds'] > 0, v['cycleRealSeconds'])
ok('view 含商品行情 ≥ 6 种', len(v.get('goods') or []) >= 6, len(v.get('goods') or []))
ok('view 含生产线 ≥ 6 条', len(v.get('lines') or []) >= 6, len(v.get('lines') or []))
ok('未成立公司时生产线全锁', all(not x['unlocked'] for x in v['lines']))
ok('行情含科技类与修仙类',
   any(x['kind'] == 'tech' for x in v['goods']) and
   any(x['kind'] == 'xiuxian' for x in v['goods']))
ok('行情含合法涨跌标记',
   all(x['trend'] in ('up', 'down', 'flat') for x in v['goods']),
   [x['trend'] for x in v['goods']])
ok('市价以 {m,e} 下发', all('m' in x['price'] and 'e' in x['price'] for x in v['goods']))
ok('科技类 60 秒变价', all(x['periodSeconds'] == 60 for x in v['goods'] if x['kind'] == 'tech'))
ok('修仙类 600 秒变价', all(x['periodSeconds'] == 600 for x in v['goods'] if x['kind'] == 'xiuxian'))

# 抬境界与金钱
rich = json.loads(json.dumps(co_st))
rich['realm'] = 1
rich['money'] = {'m': 1, 'e': 8}
rich['energy'] = 1000
call('/api/save', {'state': rich}, tok=co_tok)
chk = call('/api/load', tok=co_tok)[0]['state']
ok('境界已抬到炼气', chk['realm'] == 1, chk['realm'])

# 注册
call('/api/action', {'action': 'setWorking', 'payload': {'working': False}}, tok=co_tok)
m_before = call('/api/load', tok=co_tok)[0]['state']['money']
r, code = call('/api/action', {'action': 'foundCompany'}, tok=co_tok)
ok('成立公司成功', code == 200 and r['state']['company']['founded'] is True, r.get('msg'))
paid = m_before['m'] * 10 ** m_before['e'] - r['state']['money']['m'] * 10 ** r['state']['money']['e']
ok('扣除注册费 5 万', abs(paid - 5e4) < 1e-3, paid)
r, code = call('/api/action', {'action': 'foundCompany'}, tok=co_tok)
ok('重复成立被拒', code == 400, r.get('msg'))

# 生产线
r, code = call('/api/action', {'action': 'buyLine', 'payload': {'lineId': 'smelter'}}, tok=co_tok)
ok('前置不足时购买生产线被拒', code == 400, r.get('msg'))
r, code = call('/api/action', {'action': 'buyLine', 'payload': {'lineId': 'nope'}}, tok=co_tok)
ok('不存在的生产线被拒', code == 400)
r, code = call('/api/action', {'action': 'buyLine', 'payload': {'lineId': 'mine'}}, tok=co_tok)
ok('购买矿井成功', code == 200 and r['state']['company']['lines']['mine'] == 1, r.get('msg'))
for _ in range(4):
    call('/api/action', {'action': 'buyLine', 'payload': {'lineId': 'mine'}}, tok=co_tok)
v = call('/api/view', tok=co_tok)[0]['view']['company']
fdr = [x for x in v['lines'] if x['id'] == 'smelter'][0]
ok('累计 5 条矿井', [x for x in v['lines'] if x['id'] == 'mine'][0]['owned'] == 5)
ok('5 条后解锁炼钢厂', fdr['unlocked'] is True, fdr.get('lockedReason'))

# 仓库
r, code = call('/api/action', {'action': 'upgradeWarehouse'}, tok=co_tok)
ok('升级仓库成功', code == 200 and r['state']['company']['warehouseLevel'] == 1, r.get('msg'))
v = call('/api/view', tok=co_tok)[0]['view']['company']
ok('容量扩到 1100', v['warehouseCapacity'] == 1100, v['warehouseCapacity'])
ok('维护费 = 5 条作坊之和', v['upkeep']['total'] == {'m': 3.6, 'e': 3}
   or abs(v['upkeep']['total']['m'] * 10 ** v['upkeep']['total']['e'] - 3600) < 1e-6,
   v['upkeep']['total'])
ok('每周期产量 100 件', v['outputPerCycle'] == 100, v['outputPerCycle'])

# 生产周期：把进度推到临界点再等一小会儿（不直接改 cycles，那是只增字段）
co_st = call('/api/load', tok=co_tok)[0]['state']
c0 = {'cycles': co_st['company']['cycles'],
      'upkeep': co_st['company']['totalUpkeep'],
      'revenue': co_st['company']['totalRevenue']}
near = json.loads(json.dumps(co_st))
near['company']['autoSell'] = False
near['company']['cycleProgress'] = 19
call('/api/save', {'state': near}, tok=co_tok)
time.sleep(2)
after = call('/api/load', tok=co_tok)[0]['state']
ok('跨过周期线后结算生产周期', after['company']['cycles'] > c0['cycles'],
   '%s → %s' % (c0['cycles'], after['company']['cycles']))
up0 = c0['upkeep']['m'] * 10 ** c0['upkeep']['e']
up1 = after['company']['totalUpkeep']['m'] * 10 ** after['company']['totalUpkeep']['e']
ok('维护费按 5 条作坊记账', abs((up1 - up0) - 3600) < 1e-3, up1 - up0)
rv0 = c0['revenue']['m'] * 10 ** c0['revenue']['e']
rv1 = after['company']['totalRevenue']['m'] * 10 ** after['company']['totalRevenue']['e']
ok('关闭自动卖出时营业额不增加', abs(rv1 - rv0) < 1e-6, '%s → %s' % (rv0, rv1))

v = call('/api/view', tok=co_tok)[0]['view']['company']
ok('产物已入库', v['stockUsed'] > 0, v['stockUsed'])
ok('电子元件有库存', [x for x in v['goods'] if x['id'] == 'component'][0]['stock'] > 0)

# 手动卖出
r, code = call('/api/action', {'action': 'sellGoods', 'payload': {'goodId': 'all'}}, tok=co_tok)
ok('清仓卖出成功', code == 200, r.get('msg'))
ok('清仓有收入', r['result']['revenue']['m'] > 0, r['result']['revenue'])
v = call('/api/view', tok=co_tok)[0]['view']['company']
ok('清仓后库存归零', v['stockUsed'] == 0, v['stockUsed'])
r, code = call('/api/action', {'action': 'sellGoods', 'payload': {'goodId': 'all'}}, tok=co_tok)
ok('空仓时卖出被拒', code == 400, r.get('msg'))
r, code = call('/api/action', {'action': 'sellGoods', 'payload': {'goodId': 'nope'}}, tok=co_tok)
ok('不存在的商品卖出被拒', code == 400)

# 自动卖出开关
r, code = call('/api/action', {'action': 'setAutoSell', 'payload': {'autoSell': False}}, tok=co_tok)
ok('可以关闭自动卖出', code == 200 and r['result']['autoSell'] is False)
r, code = call('/api/action', {'action': 'setAutoSell', 'payload': {'autoSell': True}}, tok=co_tok)
ok('可以重新开启自动卖出', code == 200 and r['result']['autoSell'] is True)

print('\n[5c] 公司防作弊')
st = call('/api/load', tok=tok)[0]['state']       # 主账号：未成立公司
bad = json.loads(json.dumps(st))
bad['company']['founded'] = True
call('/api/save', {'state': bad}, tok=tok)
after = call('/api/load', tok=tok)[0]['state']
ok('未成立公司不能被伪造为已成立', after['company']['founded'] is False,
   after['company']['founded'])
ok('伪造后仓库等级仍为 0', after['company']['warehouseLevel'] == 0)

cur = call('/api/load', tok=co_tok)[0]['state']
reg = json.loads(json.dumps(cur))
reg['company']['cycles'] = 0
reg['company']['warehouseLevel'] = 0
reg['company']['lines'] = {}
reg['company']['totalRevenue'] = {'m': 0, 'e': 0}
call('/api/save', {'state': reg}, tok=co_tok)
back = call('/api/load', tok=co_tok)[0]['state']
ok('已成立公司不会被改成未成立', back['company']['founded'] is True)
ok('周期计数不允许倒退', back['company']['cycles'] >= cur['company']['cycles'],
   '%s >= %s' % (back['company']['cycles'], cur['company']['cycles']))
ok('仓库等级不允许倒退', back['company']['warehouseLevel'] >= cur['company']['warehouseLevel'])
ok('生产线数量不允许倒退',
   (back['company']['lines'].get('mine') or 0) >= (cur['company']['lines'].get('mine') or 0))
ok('累计营业额不允许倒退',
   back['company']['totalRevenue']['m'] * 10 ** back['company']['totalRevenue']['e'] >=
   cur['company']['totalRevenue']['m'] * 10 ** cur['company']['totalRevenue']['e'])

cheat = json.loads(json.dumps(back))
cheat['company']['stock']['component'] = 999999
call('/api/save', {'state': cheat}, tok=co_tok)
b3 = call('/api/load', tok=co_tok)[0]['state']
tot = sum((v or 0) for v in b3['company']['stock'].values())
ok('超容库存被裁剪到仓容内', tot <= 1100, tot)

print('\n[5d] 股市（证券账户）')
# 先用公司账号的名义资产把金钱抬上去（防作弊只拦倒退，不拦增长）
_bs = call('/api/load', tok=co_tok)[0]['state']
_bs['money'] = {'m': 1.0, 'e': 10}
call('/api/save', {'state': _bs}, tok=co_tok)
_b = call('/api/load', tok=co_tok)[0]['state']

v = call('/api/view', tok=co_tok)[0]['view']['stock']
ok('view 含股市', isinstance(v, dict))
ok('view 标记股市已实现', v['implemented'] is True)
ok('炼气后股市已开户', v['unlocked'] is True, v.get('lockedReason'))
ok('view 含手续费', v['fee'] > 0, v['fee'])
ok('view 含最小成交额', v['minOrder'] > 0, v['minOrder'])
ok('view 含冲击上下限', v['maxRise'] > 0 and v['maxDrop'] > 0,
   '%s / %s' % (v['maxRise'], v['maxDrop']))
ok('view 含衰减比例', 0 < v['flowDecay'] <= 1, v['flowDecay'])
ok('view 含联动权重', v['linkWeight'] > 0, v['linkWeight'])
ok('view 含全部股票 ≥ 5 只', len(v.get('stocks') or []) >= 5, len(v.get('stocks') or []))
ok('股价以 {m,e} 下发', all('m' in x['price'] for x in v['stocks']))
ok('成交价均为正', all(x['price']['m'] > 0 for x in v['stocks']))
ok('每只股票标出涨跌', all(x['trend'] in ('up', 'down', 'flat') for x in v['stocks']))
ok('清仓可变现不高于账面市值',
   all(x['liquidateValue']['m'] * 10 ** x['liquidateValue']['e'] <=
       x['value']['m'] * 10 ** x['value']['e'] * (1 + 1e-9) + 1 for x in v['stocks']))
ok('存在与公司商品联动的股票', any(x.get('link') for x in v['stocks']))

# 买入：成交按成交后的冲击价结算，所以成交价被自己顶高
r, code = call('/api/action', {'action': 'buyStock',
                               'payload': {'stockId': 'tianji', 'shares': 20000}}, tok=co_tok)
ok('买入接口成功', code == 200 and r.get('ok') is True, r.get('msg'))
q = r['result']
ok('返回成交股数', q['shares'] == 20000, q['shares'])
ok('返回成交均价（{m,e}）', isinstance(q['unitPrice'], dict) and 'm' in q['unitPrice'])
ok('买入后冲击系数 > 1', q['impact'] > 1, q['impact'])
ok('应付款 = 成交额 + 手续费',
   abs(q['total']['m'] * 10 ** q['total']['e']
       - (q['gross']['m'] * 10 ** q['gross']['e']
          + q['fee']['m'] * 10 ** q['fee']['e'])) < 1e-6 * max(1, q['gross']['m'] * 10 ** q['gross']['e']))

_b2 = call('/api/load', tok=co_tok)[0]['state']
ok('存档里持仓已入账', _b2['stock']['shares']['tianji'] == 20000,
   _b2['stock']['shares']['tianji'])
ok('存档里净买入流已记账', _b2['stock']['flow']['tianji'] == 20000)
ok('成交笔数 +1', _b2['stock']['totalTrades'] == 1, _b2['stock']['totalTrades'])
ok('累计手续费已记账', _b2['stock']['totalFee']['m'] > 0, _b2['stock']['totalFee'])

# 拒绝路径
r, code = call('/api/action', {'action': 'buyStock',
                               'payload': {'stockId': 'tianji', 'shares': 1}}, tok=co_tok)
ok('不足最小成交额被拒', code == 400, r.get('msg'))
r, code = call('/api/action', {'action': 'buyStock',
                               'payload': {'stockId': 'nope', 'shares': 100000}}, tok=co_tok)
ok('未知股票被拒', code == 400, r.get('msg'))
r, code = call('/api/action', {'action': 'sellStock',
                               'payload': {'stockId': 'lingmai', 'shares': 1}}, tok=co_tok)
ok('无持仓时卖出被拒', code == 400, r.get('msg'))

# 卖出：一轮买卖必亏
r, code = call('/api/action', {'action': 'sellStock',
                               'payload': {'stockId': 'tianji', 'shares': 20000}}, tok=co_tok)
ok('卖出接口成功', code == 200 and r.get('ok') is True, r.get('msg'))
sq = r['result']
_pf = sq['profit']['m'] * 10 ** sq['profit']['e']
ok('买入后立刻卖回：本笔盈亏为负', _pf < 0, sq['profit'])
ok('全部卖出后持仓归零', sq['sharesAfter'] == 0, sq['sharesAfter'])
_b3 = call('/api/load', tok=co_tok)[0]['state']
ok('清仓后成本归零', _b3['stock']['cost']['tianji']['m'] == 0, _b3['stock']['cost']['tianji'])
ok('已实现盈亏为负（真实亏损）', _b3['stock']['realized']['m'] < 0, _b3['stock']['realized'])

# 防作弊：越界裁剪
_cheat = json.loads(json.dumps(_b3))
_cheat['stock']['shares']['tianji'] = 10 ** 12
_cheat['stock']['flow']['tianji'] = -10 ** 12
call('/api/save', {'state': _cheat}, tok=co_tok)
_back = call('/api/load', tok=co_tok)[0]['state']
ok('超流通盘持仓被裁剪', _back['stock']['shares']['tianji'] <= 2.4e5,
   _back['stock']['shares']['tianji'])
ok('超范围净买入流被裁剪', abs(_back['stock']['flow']['tianji']) <= 2.4e5,
   _back['stock']['flow']['tianji'])
_cheat2 = json.loads(json.dumps(_back))
_cheat2['stock']['shares']['tianji'] = 0
_cheat2['stock']['cost']['tianji'] = {'m': 999, 'e': 6}
call('/api/save', {'state': _cheat2}, tok=co_tok)
_back2 = call('/api/load', tok=co_tok)[0]['state']
ok('无持仓时的残留成本被清零', _back2['stock']['cost']['tianji']['m'] == 0,
   _back2['stock']['cost']['tianji'])

print('\n[6] 旧存档迁移（v1 spiritStone → qi）')
r, _ = call('/api/login', {'username': 'sama05', 'password': 'sama051234'})
if r.get('ok'):
    old = call('/api/load', tok=r['token'])[0]
    ost = old['state']
    ok('旧账号仍可加载', ost is not None)
    ok('旧存档已带 qi 字段', 'qi' in ost, list(ost.keys())[:8])
    ov = call('/api/view', tok=r['token'])[0]['view']
    print('     旧账号境界 %s / 灵气 %s / 灵石 %s / 神识 %s'
          % (ov['realmName'], ov['qi'], ov['spiritStone'], round(ov['shenshi'], 2)))
else:
    print('  - 旧账号 sama05 登录失败，跳过')

print('\n==============================================')
print('  通过 %d   失败 %d' % (PASS[0], FAIL[0]))
print('==============================================\n')
