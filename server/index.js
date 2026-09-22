/**
 * 算力修仙 —— 后端服务
 * Express + SQLite
 *
 * 设计原则：服务端保存状态，客户端负责实时 tick 与展示。
 * 服务端在读写存档时使用同一份 game-core 做离线结算，保证前后端一致。
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dbm = require('./db');
const GameCore = require('../shared/game-core.js');
const Decimal = require('../shared/decimal.js');
const GAME = require('../shared/game-config.js');

const app = express();
const PORT = process.env.PORT || 3210;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

// ---------- 会话（内存 token，重启后需重新登录） ----------
const sessions = new Map(); // token -> { userId, username, created }

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function auth(req, res, next) {
  const token = req.get('x-token') || (req.body && req.body.token);
  const sess = token && sessions.get(token);
  if (!sess) return res.status(401).json({ ok: false, msg: '未登录或登录已失效' });
  req.user = sess;
  next();
}

// ---------- 账号 ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const r = dbm.register(username, password);
  if (!r.ok) return res.status(400).json(r);
  const token = newToken();
  sessions.set(token, { userId: r.userId, username: r.username, created: Date.now() });
  res.json({ ok: true, token, username: r.username, userId: r.userId });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const r = dbm.login(username, password);
  if (!r.ok) return res.status(400).json(r);
  const token = newToken();
  sessions.set(token, { userId: r.userId, username: r.username, created: Date.now() });
  res.json({ ok: true, token, username: r.username, userId: r.userId });
});

app.post('/api/logout', auth, (req, res) => {
  const token = req.get('x-token') || (req.body && req.body.token);
  sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ ok: true, username: req.user.username, userId: req.user.userId });
});

// ---------- 存档 ----------
/**
 * 读取存档。
 * 服务端负责离线结算：用保存时的 lastTick 起算，按 GAME.offline.ratio 折算。
 */
app.get('/api/load', auth, (req, res) => {
  const raw = dbm.loadSave(req.user.userId);
  if (!raw) {
    // 新玩家：创建初始状态并直接入库
    const s = GameCore.createState();
    const snap = GameCore.serialize(s);
    dbm.saveGame(req.user.userId, snap);
    return res.json({
      ok: true,
      isNew: true,
      state: snap,
      config: publicConfig(),
      offline: null,
    });
  }

  const s = GameCore.hydrate(raw);
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - (raw.lastTick || now)) / 1000);

  let offlineResult = null;
  if (elapsedSec > 0.5) {
    // 短暂离开（刷新/切标签页）→ 全额结算，不打折，避免频繁刷新吃亏
    // 真正离线（超过阈值）→ 按 ratio 折算，且有封顶
    const isRealOffline = elapsedSec >= GAME.offline.thresholdSeconds;
    const preview = GameCore.previewOffline(s, elapsedSec, isRealOffline);
    GameCore.tick(s, preview.seconds, { offline: isRealOffline });

    if (isRealOffline) {
      offlineResult = {
        seconds: preview.seconds,
        realSeconds: elapsedSec,
        cappedOut: preview.cappedOut,
        money: preview.money.toJSON(),
        spirit: preview.spirit.toJSON(),
        stone: preview.stone.toJSON(),
        jobDone: preview.jobDone,
        gameSeconds: preview.gameSeconds,
        realm: preview.realm,
        learned: preview.learned,
        company: preview.company ? {
          cycles: preview.company.cycles,
          revenue: preview.company.revenue.toJSON(),
          upkeep: preview.company.upkeep.toJSON(),
          produced: preview.company.produced,
          overflow: preview.company.overflow,
          starved: preview.company.starved,
        } : null,
        stock: preview.stock ? {
          totalValue: preview.stock.totalValue.toJSON(),
          pnl: preview.stock.pnl.toJSON(),
          realized: preview.stock.realized.toJSON(),
          totalFee: preview.stock.totalFee.toJSON(),
          totalTrades: preview.stock.totalTrades,
        } : null,
        ratio: GAME.offline.ratio,
      };
    }
  }

  const snap = GameCore.serialize(s);
  dbm.saveGame(req.user.userId, snap);

  res.json({
    ok: true,
    isNew: false,
    state: snap,
    config: publicConfig(),
    offline: offlineResult,
  });
});

/** 保存存档。服务端会做一次轻量推进，防止客户端造假。 */
app.post('/api/save', auth, (req, res) => {
  const { state } = req.body || {};
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ ok: false, msg: '存档数据无效' });
  }

  const prev = dbm.loadSave(req.user.userId);
  const now = Date.now();

  const incoming = GameCore.hydrate(state);
  incoming.lastTick = now;

  // 防作弊：存档中的关键数值不得低于服务端已有进度
  if (prev) {
    const prevState = GameCore.hydrate(prev);
    if (prevState.playTime > incoming.playTime) incoming.playTime = prevState.playTime;
    if (prevState.realm > incoming.realm) incoming.realm = prevState.realm;
    if (prevState.gameSeconds > incoming.gameSeconds) incoming.gameSeconds = prevState.gameSeconds;
    if (prevState.totalJobs > incoming.totalJobs) incoming.totalJobs = prevState.totalJobs;
    if (prevState.rushCount > incoming.rushCount) incoming.rushCount = prevState.rushCount;
    // 设备数量只能增不能减
    for (const k of Object.keys(prevState.devices)) {
      if ((prevState.devices[k] || 0) > (incoming.devices[k] || 0)) {
        incoming.devices[k] = prevState.devices[k];
      }
    }
    // 各工作的完成次数只能增不能减（否则可以刷回低级工作重新领解锁进度）
    for (const k of Object.keys(prevState.jobDone)) {
      if ((prevState.jobDone[k] || 0) > (incoming.jobDone[k] || 0)) {
        incoming.jobDone[k] = prevState.jobDone[k];
      }
    }
    // 已习得的功法不允许消失；熟练度与段位、被动常驻也只能增不能减
    // （将来做兵解时，应通过一个显式的服务端「兵解」操作来清空，而不是放开这里的校验）
    for (const id of Object.keys(prevState.learned)) {
      const prevTech = prevState.learned[id];
      const nextTech = incoming.learned[id];
      if (!nextTech) {
        incoming.learned[id] = {
          mastery: prevTech.mastery, tier: prevTech.tier, passive: prevTech.passive,
        };
        continue;
      }
      if (prevTech.mastery > nextTech.mastery) nextTech.mastery = prevTech.mastery;
      if (prevTech.tier > nextTech.tier) nextTech.tier = prevTech.tier;
      if (prevTech.passive && !nextTech.passive) nextTech.passive = true;
    }

    // 公司（产业）：成立不可撤销，生产线 / 仓库等级 / 生产周期数 / 累计卖出只增不减。
    // 库存与金钱**不**受此限 —— 它们本来就会因为卖出而减少。
    // 伪造库存的空间已被 hydrate 按仓库容量裁剪封住（最多塞满一间仓库）。
    const prevCo = prevState.company;
    const nextCo = incoming.company;
    if (prevCo && nextCo) {
      // 「成立」是一次性付费的单向状态：服务端没批过，就不认客户端单方面写上来的 true。
      // 客户端注册公司走的是 /api/action（服务端权威），所以这条不会误伤正常游玩。
      if (!prevCo.founded && nextCo.founded) nextCo.founded = false;
      if (prevCo.founded && !nextCo.founded) nextCo.founded = true;
      if (prevCo.foundedDay !== null && prevCo.foundedDay !== undefined) {
        nextCo.foundedDay = prevCo.foundedDay;
      }
      if (prevCo.warehouseLevel > nextCo.warehouseLevel) {
        nextCo.warehouseLevel = prevCo.warehouseLevel;
      }
      if (prevCo.cycles > nextCo.cycles) nextCo.cycles = prevCo.cycles;
      if (prevCo.totalRevenue.gt(nextCo.totalRevenue)) nextCo.totalRevenue = prevCo.totalRevenue;
      if (prevCo.totalUpkeep.gt(nextCo.totalUpkeep)) nextCo.totalUpkeep = prevCo.totalUpkeep;
      // 生产线：现在是「每台独立配置」的结构（{ units: [{p 产物, r 产能}] }）。
      // 台数只增不减；每台造什么、开几成力由玩家自己改，但要夹到合法范围内 ——
      // 产物必须是这条线能造的（否则可以拿矿线造芯片），产能必须在 [0, 1]。
      // （产能允许低于停机阈值 —— 那就是玩家主动关掉这台线，不产货也不占算力）
      for (const line of GAME.company.lines) {
        const prevU = GameCore.lineUnits(prevState, line.id);
        const nextU = GameCore.lineUnits(incoming, line.id);
        const okIds = GameCore.lineProducts(line).map((g) => g.id);
        const def = okIds.length ? okIds[0] : null;
        const fixed = [];
        for (let i = 0; i < nextU.length; i++) {
          const p = (nextU[i].p && okIds.indexOf(nextU[i].p) >= 0) ? nextU[i].p : def;
          let r = Number(nextU[i].r);
          if (!Number.isFinite(r)) r = 1;
          if (r < 0) r = 0;
          if (r > 1) r = 1;
          fixed.push({ p: p, r: r });
        }
        // 台数被改少了 → 用服务端记的旧台数补齐（补出来的沿用旧配置）
        for (let i = fixed.length; i < prevU.length; i++) {
          fixed.push({ p: prevU[i].p, r: prevU[i].r });
        }
        incoming.company.lines[line.id] = { units: fixed };
      }
      for (const k of Object.keys(prevCo.goodsSold)) {
        if ((prevCo.goodsSold[k] || 0) > (nextCo.goodsSold[k] || 0)) {
          nextCo.goodsSold[k] = prevCo.goodsSold[k];
        }
      }

      // 市场抛压：只做区间夹取（负数会让价格暴涨，>1 会变成倒贴钱）。
      // 压力由「本期净抛售」推导，而净抛售依赖客户端上报的卖出计数，服务端
      // 手里没有独立的成交账本可对 —— 所以这一层挡得住越界，挡不住蓄意篡改，
      // 属于本作防作弊的已知边界（与 money 同类）。
      // 真正有效的一层在 hydrate：lastPeriod 不允许超前于当前期，
      // 否则抛压永远等不到结算。
      if (nextCo.pressure) {
        for (const k of Object.keys(nextCo.pressure)) {
          const n = Number(nextCo.pressure[k]);
          nextCo.pressure[k] = (!Number.isFinite(n) || n <= 0) ? 0 : (n > 1 ? 1 : n);
        }
      }
    }

    // 股市（证券账户）：持股与净买入流做区间夹取；累计手续费 / 已实现盈亏 / 成交笔数
    // 只增不减。持股本身**不能**做「只增」约束 —— 卖出本来就会让它变小，所以这一层
    // 挡得住越界（凭空多出股份 / 把冲击流拨成负数），挡不住蓄意篡改持股数，
    // 属于本作防作弊的已知边界（与 money 同类，详见 README）。
    //
    // 这里不额外管 lastPeriod：hydrate 已经把它夹到「不超过当前期」，而把它往回拨
    // 只会让冲击多衰减几轮（对自己不利），不存在套利空间。
    const prevSk = prevState.stock;
    const nextSk = incoming.stock;
    if (prevSk && nextSk) {
      for (const st of GAME.stock.stocks) {
        const depth = Math.max(1, Math.floor(st.depth || 1));
        const sh = Math.floor(Number(nextSk.shares[st.id]) || 0);
        nextSk.shares[st.id] = Math.max(0, Math.min(depth, sh));
        const fl = Math.trunc(Number(nextSk.flow[st.id]) || 0);
        nextSk.flow[st.id] = Math.max(-depth, Math.min(depth, fl));
      }
      if (prevSk.totalFee.gt(nextSk.totalFee)) nextSk.totalFee = prevSk.totalFee;
      if (prevSk.realized.gt(nextSk.realized)) nextSk.realized = prevSk.realized;
      if (prevSk.totalTrades > nextSk.totalTrades) nextSk.totalTrades = prevSk.totalTrades;
    }
  }

  const snap = GameCore.serialize(incoming);
  const r = dbm.saveGame(req.user.userId, snap);
  res.json({ ok: true, saved: true, bytes: r.bytes, at: now });
});

/** 服务端权威的操作接口 —— 关键操作走服务端校验，避免纯前端改数值 */
app.post('/api/action', auth, (req, res) => {
  const { action, payload } = req.body || {};
  let raw = dbm.loadSave(req.user.userId);
  // 新账号可能还没存档：自动创建一份初始存档，而不是直接报错
  if (!raw) {
    raw = GameCore.serialize(GameCore.createState());
    dbm.saveGame(req.user.userId, raw);
  }

  const s = GameCore.hydrate(raw);
  const now = Date.now();

  // 先按离线时长推进到当前时刻（但不打折——玩家在线时是全额）
  const elapsedSec = Math.max(0, (now - (raw.lastTick || now)) / 1000);
  if (elapsedSec > 0 && elapsedSec < GAME.save.maxTickSeconds) {
    GameCore.tick(s, elapsedSec, { offline: false });
  }

  let result = null;
  switch (action) {
    case 'rushJob': {
      // 手动催工：立即完成当前工作的若干份。上限 1000 次/请求。
      const times = Math.max(1, Math.min(parseInt(payload && payload.times, 10) || 1, 1000));
      const r = GameCore.rushJob(s, times);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = {
        ok: true, done: r.done,
        money: r.money.toJSON(), spirit: r.spirit.toJSON(), stone: r.stone.toJSON(),
      };
      break;
    }
    case 'setJob': {
      const r = GameCore.setJob(s, payload && payload.jobId);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = { ok: true, jobId: r.jobId };
      break;
    }
    case 'setWorking': {
      const r = GameCore.setWorking(s, payload && payload.working);
      result = { ok: true, working: r.working };
      break;
    }
    case 'setTimeTier': {
      const r = GameCore.setTimeTier(s, payload && payload.tier);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = { ok: true, tier: r.tier, auto: r.auto };
      break;
    }
    case 'setAutoTier': {
      const r = GameCore.setAutoTier(s, payload && payload.auto);
      result = { ok: true, auto: r.auto, tier: r.tier };
      break;
    }
    case 'buyDevice': {
      const r = GameCore.buyDevice(s, payload && payload.deviceId);
      result = r.ok
        ? {
          ok: true, cost: r.cost.toJSON(), owned: r.owned,
          stoneCost: r.stoneCost.toJSON(), learned: r.learned,
        }
        : { ok: false, msg: r.msg };
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      break;
    }
    case 'setAllocation': {
      const r = GameCore.setAllocation(s, (payload && payload.alloc) || {});
      result = { ok: true, normalized: r.normalized, alloc: s.alloc };
      break;
    }
    case 'setTechnique': {
      // 切换当前修炼的功法（同一时间只能修炼一本）
      const r = GameCore.setTechnique(s, payload && payload.techniqueId);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = { ok: true, technique: r.technique };
      break;
    }
    case 'setCultivating': {
      const r = GameCore.setCultivating(s, payload && payload.cultivating);
      result = { ok: true, cultivating: r.cultivating };
      break;
    }
    case 'comprehend': {
      // 参悟：消耗灵气换熟练度
      const times = Math.max(1, Math.min(parseInt(payload && payload.times, 10) || 1, 1000));
      const r = GameCore.comprehend(s, times);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = {
        ok: true, done: r.done, gain: r.gain, tier: r.tier,
        passive: r.passive, cost: r.cost.toJSON(),
      };
      break;
    }
    // ---------- 公司（产业）----------
    case 'foundCompany': {
      const r = GameCore.foundCompany(s);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = { ok: true, cost: r.cost.toJSON(), foundedDay: r.foundedDay };
      break;
    }
    case 'buyLine': {
      const r = GameCore.buyLine(s, payload && payload.lineId);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = {
        ok: true, lineId: payload.lineId, cost: r.cost.toJSON(),
        owned: r.owned, index: r.index, product: r.product,
      };
      break;
    }
    /**
     * 调整某一台生产线的产物 / 产能。
     * index 传 'all' 或 -1 表示这条线的全部台；否则是第几台（0-based）。
     */
    case 'setLineUnit': {
      const r = GameCore.setLineUnit(s,
        payload && payload.lineId,
        payload && payload.index,
        { product: payload && payload.product, rate: payload && payload.rate });
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = {
        ok: true, lineId: r.lineId, index: r.index, all: r.all, count: r.count,
      };
      break;
    }
    case 'upgradeWarehouse': {
      const r = GameCore.upgradeWarehouse(s);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = {
        ok: true, level: r.level, capacity: r.capacity, cost: r.cost.toJSON(),
      };
      break;
    }
    case 'sellGoods': {
      const r = GameCore.sellGoods(s, payload && payload.goodId, payload && payload.count);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = {
        ok: true, revenue: r.revenue.toJSON(), sold: r.sold,
        count: r.count || null, price: r.price ? r.price.toJSON() : null,
      };
      break;
    }
    case 'setAutoSell': {
      const r = GameCore.setAutoSell(s, payload && payload.autoSell);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = { ok: true, autoSell: r.autoSell };
      break;
    }
    // ---------- 股市（证券账户）----------
    case 'buyStock': {
      const r = GameCore.buyStock(s, payload && payload.stockId, payload && payload.shares);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = {
        ok: true, stockId: r.stockId, shares: r.shares,
        unitPrice: r.unitPrice.toJSON(), gross: r.gross.toJSON(),
        fee: r.fee.toJSON(), total: r.total.toJSON(),
        impact: r.impact, sharesAfter: r.sharesAfter,
      };
      break;
    }
    case 'sellStock': {
      const r = GameCore.sellStock(s, payload && payload.stockId, payload && payload.shares);
      if (!r.ok) {
        dbm.saveGame(req.user.userId, GameCore.serialize(s));
        return res.status(400).json({ ok: false, msg: r.msg, state: GameCore.serialize(s) });
      }
      result = {
        ok: true, stockId: r.stockId, shares: r.shares,
        unitPrice: r.unitPrice.toJSON(), gross: r.gross.toJSON(),
        fee: r.fee.toJSON(), net: r.net.toJSON(),
        costOut: r.costOut.toJSON(), profit: r.profit.toJSON(),
        impact: r.impact, sharesAfter: r.sharesAfter,
      };
      break;
    }
    default:
      return res.status(400).json({ ok: false, msg: '未知操作: ' + action });
  }

  const snap = GameCore.serialize(s);
  dbm.saveGame(req.user.userId, snap);
  res.json({ ok: true, result, state: snap });
});

/** 服务端计算的实时视图（供前端校准用） */
app.get('/api/view', auth, (req, res) => {
  const raw = dbm.loadSave(req.user.userId);
  // 新账号无存档时返回初始视图，而非报错
  const s = GameCore.hydrate(raw || null);
  res.json({
    ok: true,
    view: buildView(s),
  });
});

// ---------- 视图构建 ----------
function publicConfig() {
  return {
    devices: GAME.devices.map((d) => ({
      id: d.id, name: d.name, cost: d.cost, desc: d.desc,
      compute: d.compute, incomeBonus: d.incomeBonus,
      /** 灵石造价（>0 表示这是「修仙 × 科技」设备，需要金钱 + 灵石双造价） */
      stoneCost: d.stoneCost || 0,
      /** 对神识的增幅（科技修仙设备越靠后越猛） */
      shenshiBonus: d.shenshiBonus || 0,
      /** 灵石产出（每秒） */
      stonePerSecond: d.stonePerSecond || 0,
    })),
    investments: GAME.investments.map((i) => ({
      id: i.id, name: i.name, desc: i.desc, period: i.period, locked: !!i.locked,
    })),
    jobs: GAME.jobs.map((j) => ({
      id: j.id, name: j.name, real: j.real, tier: j.tier, hours: j.hours,
      energy: j.energy, money: j.money, spirit: j.spirit || 0, stone: j.stone || 0,
      desc: j.desc, unlock: j.unlock,
    })),
    time: { startYear: GAME.time.startYear, tiers: GAME.time.tiers, defaultTier: GAME.time.defaultTier },
    energy: GAME.energy,
    shenshi: GAME.shenshi,
    techniques: GAME.techniques,
    rush: GAME.rush,
    realms: GAME.realms,
    company: {
      implemented: GAME.company.implemented,
      unlock: GAME.company.unlock,
      foundCost: GAME.company.foundCost,
      cycleRealSeconds: GAME.company.cycleRealSeconds,
      warehouse: GAME.company.warehouse,
      /** 市场抛压参数（卖出影响下一期经济的反噬机制） */
      market: GAME.company.market,
      goods: GAME.company.goods.map((g) => ({
        id: g.id, name: g.name, kind: g.kind, basePrice: g.basePrice,
        industry: g.industry,
        /** 造一件要占多少工业算力；维护费率（按产值比例收） */
        computePerUnit: g.computePerUnit, outputCoef: g.outputCoef,
        upkeep: g.upkeep,
        volatility: g.volatility, minFactor: g.minFactor, maxFactor: g.maxFactor,
        periodYears: g.periodYears,
      })),
      /** 行业表 —— 上下游与成本传导都挂在这里 */
      industries: GAME.company.industries.map((ind) => ({
        id: ind.id, name: ind.name, kind: ind.kind, tier: ind.tier,
        upstream: ind.upstream || [],
        passThrough: ind.passThrough || 0,
        pricePass: ind.pricePass || 0,
        desc: ind.desc || '',
      })),
      lines: GAME.company.lines.map((l) => ({
        id: l.id, name: l.name, industry: l.industry,
        /** 单台产线的算力上限 / 满负荷基准产量 */
        maxCompute: l.maxCompute, baseOutput: l.baseOutput,
        cost: l.cost, costGrowth: l.costGrowth,
        realm: l.realm, after: l.after, desc: l.desc,
      })),
    },
    stock: {
      implemented: GAME.stock.implemented,
      unlock: GAME.stock.unlock,
      fee: GAME.stock.fee,
      minOrder: GAME.stock.minOrder,
      flowDecay: GAME.stock.flowDecay,
      maxRise: GAME.stock.maxRise,
      maxDrop: GAME.stock.maxDrop,
      illiquidity: GAME.stock.illiquidity,
      floor: GAME.stock.floor,
      linkWeight: GAME.stock.linkWeight,
      /** 池子里一共 50 家，榜单只显示市值前 N 家 */
      boardSize: GAME.stock.boardSize || 10,
      stocks: GAME.stock.stocks.map((st) => ({
        id: st.id, name: st.name, code: st.code, link: st.link || null,
        /** 主营业务 —— 股市页每行都显示它 */
        business: st.business || '',
        kind: st.kind || 'tech', sector: st.sector || null,
        basePrice: st.basePrice, volatility: st.volatility,
        minFactor: st.minFactor, maxFactor: st.maxFactor,
        depth: st.depth, periodYears: st.periodYears, desc: st.desc,
      })),
    },
    offline: GAME.offline,
  };
}

/**
 * 公司视图 —— 把「配置里的公司」与「玩家存档里的公司」合成前端要的结构。
 * 市价 / 涨跌 / 下次变价时间都由 game-core 用 gameSeconds 确定性算出，
 * 前端不需要自己实现任何价格逻辑。
 */
function buildCompanyView(s) {
  const cyc = GAME.company.cycleRealSeconds || 20;
  const up = GameCore.companyUpkeep(s);
  // 一律用带抛压的价格：界面显示的钱必须与实际结算到账的钱一致
  const goodsPrice = (g) => GameCore.goodsPriceWith(s, g);
  const mkt = GameCore.marketSummary(s);

  return {
    implemented: GAME.company.implemented,
    founded: GameCore.companyFounded(s),
    unlocked: GameCore.companyUnlocked(s),
    lockedReason: GameCore.companyLockedReason(s),
    foundCost: GAME.company.foundCost,
    unlockRealm: (GAME.company.unlock || {}).realm || 0,
    foundedDay: s.company.foundedDay,

    cycleRealSeconds: cyc,
    cycleProgress: s.company.cycleProgress,
    cycleRemain: Math.max(0, cyc - s.company.cycleProgress),
    cycles: s.company.cycles,
    autoSell: s.company.autoSell,

    warehouseLevel: GameCore.warehouseLevel(s),
    warehouseCapacity: GameCore.warehouseCapacity(s),
    warehouseMaxLevel: GAME.company.warehouse.maxLevel,
    warehouseCost: GameCore.warehouseCost(s).toJSON(),
    stockUsed: GameCore.stockTotal(s),

    upkeep: {
      material: up.material.toJSON(),
      labor: up.labor.toJSON(),
      total: up.total.toJSON(),
    },
    outputPerCycle: GameCore.companyOutputPerCycle(s),
    grossPerCycle: GameCore.companyCycleGross(s).toJSON(),
    netPerCycle: GameCore.companyCycleNet(s).toJSON(),
    incomePerSecond: GameCore.companyIncomePerSecond(s).toJSON(),
    totalRevenue: s.company.totalRevenue.toJSON(),
    totalUpkeep: s.company.totalUpkeep.toJSON(),

    goods: GAME.company.goods.map((g) => {
      const price = goodsPrice(g);
      const stock = GameCore.stockOf(s, g.id);
      const ms = mkt ? mkt.goods.find((x) => x.id === g.id) : null;
      return {
        id: g.id, name: g.name, kind: g.kind, basePrice: g.basePrice,
        industry: g.industry,
        industryName: (GameCore.industryById(g.industry) || {}).name || '',
        periodYears: g.periodYears,
        outputCoef: g.outputCoef,
        upkeepRate: g.upkeepRate,
        price: price.toJSON(),
        factor: price.div(new Decimal(g.basePrice)).toNumber(),
        naturalPrice: ms ? ms.naturalPrice.toJSON() : price.toJSON(),
        trend: GameCore.goodsTrend(g, s.gameSeconds),
        nextChangeIn: GameCore.goodsNextChangeIn(g, s.gameSeconds),
        stock: stock,
        sold: s.company.goodsSold[g.id] || 0,
        stockValue: price.mul(stock).toJSON(),
        // ---- 市场抛压 ----
        pressure: ms ? ms.pressure : 0,
        dropRatio: ms ? ms.dropRatio : 0,
        impact: ms ? ms.impact : 1,
        excess: ms ? ms.excess : 0,
        soldThisPeriod: ms ? ms.soldThisPeriod : 0,
        producedThisPeriod: ms ? ms.producedThisPeriod : 0,
        recoverIn: ms ? ms.recoverIn : 0,
      };
    }),

    market: mkt ? {
      peak: mkt.peak,
      warn: mkt.warn,
      maxDrop: mkt.maxDrop,
      decay: mkt.decay,
      floor: mkt.floor,
    } : null,

    // ---- 行业（上下游与成本传导）----
    industries: GAME.company.industries.map((ind) => ({
      id: ind.id, name: ind.name, kind: ind.kind, tier: ind.tier,
      upstream: ind.upstream || [],
      passThrough: ind.passThrough || 0,
      pricePass: ind.pricePass || 0,
      // 上游现在的整体价格水平（1 = 平价）；>1 说明原料在涨
      upstreamRatio: GameCore.industryUpstreamRatio(s, ind.id),
      costIndex: GameCore.industryCostIndex(s, ind.id),
      priceIndex: GameCore.industryPriceIndex(s, ind.id),
      goods: GameCore.goodsOfIndustry(ind.id).map((g) => g.id),
    })),

    // ---- 工业算力：买线只拿到产能上限，转起来要靠「工业产能」投向拨算力 ----
    compute: {
      pool: GameCore.industrialComputePool(s).toJSON(),
      demand: GameCore.companyComputeDemand(s).toJSON(),
      /** 供给/需求；<1 表示算力不足，全厂按比例削减 */
      scale: GameCore.companyComputeScale(s),
      share: s.alloc.industry || 0,
      ratio: (GAME.company.industrialCompute || {}).ratio || 1,
      minRate: GameCore.lineMinRate(),
    },

    lines: GAME.company.lines.map((l) => {
      const units = GameCore.lineUnits(s, l.id);
      const prods = GameCore.lineProducts(l);
      return {
        id: l.id,
        name: l.name,
        desc: l.desc || '',
        industry: l.industry,
        industryName: (GameCore.industryById(l.industry) || {}).name || '',
        maxCompute: l.maxCompute,
        baseOutput: l.baseOutput,
        owned: units.length,
        unlocked: GameCore.lineUnlocked(s, l),
        lockedReason: GameCore.lineLockedReason(s, l),
        cost: GameCore.lineCost(s, l).toJSON(),
        realm: l.realm || 0,
        after: l.after || null,
        /** 这条线能造的全部产物（= 所属行业的 6 种） */
        products: prods.map((g) => {
          const price = goodsPrice(g);
          return {
            id: g.id, name: g.name, basePrice: g.basePrice,
            outputCoef: g.outputCoef, upkeepRate: g.upkeepRate,
            price: price.toJSON(),
            /** 这条线满产能、算力充足时，造它一周期能出多少件 */
            perCycle: l.baseOutput * g.outputCoef,
          };
        }),
        /** 每一台的当前配置 —— 玩家可以逐台改 */
        units: units.map((u, i) => ({ index: i, product: u.p, rate: u.r })),
      };
    }),
  };
}

/**
 * 股市视图 —— 价格 / 冲击 / 报价全部由 game-core 确定性算出，前端不实现任何价格逻辑。
 *
 * 报价（买入花费、清仓可变现）也一并下发：界面上显示的钱必须就是点下去能成交的钱，
 * 而买入/卖出的成交价都含「成交后的冲击」，前端自己算容易算歪。
 */
function buildStockView(s) {
  const sum = GameCore.stockSummary(s);
  if (!sum) return null;
  const unlockRealm = (GAME.stock.unlock || {}).realm || 0;

  return {
    implemented: GAME.stock.implemented,
    unlocked: sum.unlocked,
    lockedReason: sum.lockedReason,
    unlockRealm: unlockRealm,
    unlockRealmName: (GAME.realms[unlockRealm] || {}).name || null,

    fee: sum.fee,
    minOrder: sum.minOrder,
    flowDecay: sum.flowDecay,
    maxRise: sum.maxRise,
    maxDrop: sum.maxDrop,
    illiquidity: sum.illiquidity,
    floor: sum.floor,
    linkWeight: sum.linkWeight,
    peak: sum.peak,

    boardSize: sum.boardSize,
    totalListed: sum.totalListed,

    totalValue: sum.totalValue.toJSON(),
    totalCost: sum.totalCost.toJSON(),
    pnl: sum.pnl.toJSON(),
    pnlRatio: sum.pnlRatio,
    liquidateValue: sum.liquidateValue.toJSON(),
    liquidatePnl: sum.liquidatePnl.toJSON(),
    liquidatePnlRatio: sum.liquidatePnlRatio,
    realized: sum.realized.toJSON(),
    totalFee: sum.totalFee.toJSON(),
    totalTrades: sum.totalTrades,

    /** 把一只股票压成前端能直接渲染的纯 JSON —— 全量池与榜单共用同一套字段 */
    stocks: sum.stocks.map(packStock),
    /**
     * 市值榜：池子里一共 50 家，界面默认只列前 N 家。
     * 交易对全部 50 家开放（接口按 id 找），榜外也能买 —— 榜单随行情换人。
     */
    board: sum.board.map(packStock),
    /** 榜外公司（id 集合），前端做「显示全部」时用得上 */
    boardIds: sum.board.map((x) => x.id),
  };

  function packStock(x) {
    return {
      id: x.id, name: x.name, code: x.code, link: x.link,
      /** 主营业务 —— 行情一动就能看出波及哪家 */
      business: x.business || '',
      kind: x.kind || 'tech', sector: x.sector || null,
      basePrice: x.basePrice, depth: x.depth, periodYears: x.periodYears,
      /** 市值 = 现价 × 流通盘，榜单排序依据 */
      marketCap: x.marketCap.toJSON(),
      period: x.period, nextPeriod: x.nextPeriod,
      price: x.price.toJSON(),
      naturalPrice: x.naturalPrice.toJSON(),
      impact: x.impact,
      impactPct: x.impactPct,
      shares: x.shares,
      heldRatio: x.heldRatio,
      cost: x.cost.toJSON(),
      avgCost: x.avgCost.toJSON(),
      value: x.value.toJSON(),
      pnl: x.pnl.toJSON(),
      pnlRatio: x.pnlRatio,
      liquidateValue: x.liquidateValue.toJSON(),
      liquidatePnl: x.liquidatePnl.toJSON(),
      liquidateImpact: x.liquidateImpact,
      flow: x.flow,
      trend: x.trend,
      nextChangeIn: x.nextChangeIn,
      maxBuy: x.maxBuy,
      unlocked: x.unlocked,
    };
  }
}

function buildView(s) {
  const date = GameCore.gameDate(s.gameSeconds);
  const techs = GameCore.techniqueList(s);
  const passive = {
    money: GameCore.passiveBonus(s, 'money'),
    energyMax: GameCore.passiveBonus(s, 'energyMax'),
    compute: GameCore.passiveBonus(s, 'compute'),
    deviceCost: GameCore.passiveBonus(s, 'deviceCost'),
    shenshi: GameCore.passiveBonus(s, 'shenshi'),
    allOutput: GameCore.passiveBonus(s, 'allOutput'),
  };
  return {
    money: s.money.toJSON(),
    realCompute: s.realCompute.toJSON(),
    deviceCompute: GameCore.totalCompute(s).toJSON(),
    aiBonus: s.aiBonus.toJSON(),
    costDiscount: s.costDiscount,

    // ---- 时间 ----
    gameSeconds: s.gameSeconds,
    timeTier: s.timeTier,
    autoTier: s.autoTier,
    maxTier: GameCore.maxUnlockedTier(s),
    gameDate: date,
    gameSpeed: GameCore.gameSecondsPerRealSecond(s),

    // ---- 精力 ----
    energy: s.energy,
    maxEnergy: GameCore.maxEnergy(s),

    // ---- 工作 ----
    jobId: s.jobId,
    jobProgress: s.jobProgress,
    working: s.working,
    jobDone: Object.assign({}, s.jobDone),
    totalJobs: s.totalJobs,
    rushCount: s.rushCount,

    // ---- 神识 ----
    shenshi: GameCore.totalShenshi(s),
    shenshiBase: GameCore.shenshiBase(s),
    shenshiDeviceMultiplier: GameCore.shenshiDeviceMultiplier(s),

    // ---- 修仙（灵气 / 灵石 / 功法）----
    qi: s.qi.toJSON(),
    spiritStone: s.spiritStone.toJSON(),
    qiMultiplier: GameCore.qiMultiplier(s),
    realm: s.realm,
    realmName: GameCore.realmInfo(s).name,
    realmProgress: s.realmProgress.toJSON(),
    technique: s.technique,
    techniqueName: (GameCore.currentTech(s) || {}).name || null,
    cultivating: s.cultivating,
    cultivateSpeed: GameCore.cultivateSpeed(s),
    comprehendCost: GameCore.comprehendCost(s).toJSON(),
    techniques: techs,
    passiveBonus: passive,
    spiritAllowed: GameCore.spiritAllowed(s),
    firstTechUnlocked: GameCore.firstTechUnlocked(s),

    // ---- 科技 ----
    autoIncome: GameCore.autoIncome(s).toJSON(),
    stonePerSecond: GameCore.deviceStoneOutput(s).toJSON(),
    devices: Object.assign({}, s.devices),
    deviceCosts: GAME.devices.reduce((acc, d) => {
      acc[d.id] = GameCore.deviceCost(s, d).toJSON();
      return acc;
    }, {}),
    deviceStoneCosts: GAME.devices.reduce((acc, d) => {
      acc[d.id] = GameCore.deviceStoneCost(s, d).toJSON();
      return acc;
    }, {}),
    investments: GAME.investments.reduce((acc, inv) => {
      acc[inv.id] = {
        alloc: s.alloc[inv.id] || 0,
        output: GameCore.investOutput(s, inv).toJSON(),
        produced: s.produced[inv.id].toJSON(),
        available: GameCore.investmentAvailable(s, inv),
      };
      return acc;
    }, {}),

    // ---- 公司（产业）----
    company: buildCompanyView(s),

    // ---- 股市（证券账户）----
    stock: buildStockView(s),

    playTime: s.playTime,
  };
}

// ---------- 启动 ----------
app.listen(PORT, () => {
  console.log('');
  console.log('  算力修仙 服务已启动');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('  数据目录: ' + path.join(__dirname, '..', 'data'));
  console.log('');
});
