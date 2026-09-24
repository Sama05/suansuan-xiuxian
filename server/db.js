/**
 * 数据库层 —— SQLite 存档
 * 使用 better-sqlite3 同步 API，简单可靠。
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'game.db'));
db.pragma('journal_mode = WAL');
// WAL 不做 checkpoint 的话 -wal 文件会一直涨（写入越多涨越快），读性能也会退化。
// 这里两件事一起做：① 启动时把已有的 WAL 合并回主库并截断；② 开自动 checkpoint，
// 让 WAL 超过 512 页（约 2MB）时自动合并，不用等人手动处理。
db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('wal_autocheckpoint = 512');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_login  INTEGER
  );

  CREATE TABLE IF NOT EXISTS saves (
    user_id     INTEGER PRIMARY KEY,
    state       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- 会话表：token 落盘，服务端重启后依然有效 —— 这是「登录一次免重复登录」的关键。
  -- 早先用内存 Map 存 token，重启一次全部作废，前端 localStorage 里的 token 变成废票。
  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    username    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    seen_at     INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

const q = {
  findUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  findUserById: db.prepare('SELECT id, username, created_at, last_login FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)'),
  touchLogin: db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
  getSave: db.prepare('SELECT state, updated_at FROM saves WHERE user_id = ?'),
  putSave: db.prepare(`
    INSERT INTO saves (user_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
  `),
  // ---- 会话 ----
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  putSession: db.prepare(`
    INSERT INTO sessions (token, user_id, username, created_at, seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET seen_at = excluded.seen_at
  `),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  delStaleSessions: db.prepare('DELETE FROM sessions WHERE seen_at < ?'),
  countSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions'),
  allSessions: db.prepare('SELECT * FROM sessions ORDER BY seen_at DESC LIMIT 20'),
};

/**
 * 注册前的字段校验（同步 / 异步两条注册路径共用，避免规则漂移）。
 * 返回 { ok:true, username } 或 { ok:false, msg }。
 */
function validateNewAccount(username, password) {
  const name = String(username || '').trim();
  if (name.length < 2 || name.length > 20) {
    return { ok: false, msg: '用户名长度需为 2-20 个字符' };
  }
  if (!/^[\w\u4e00-\u9fa5]+$/.test(name)) {
    return { ok: false, msg: '用户名只能包含字母、数字、下划线或中文' };
  }
  if (!password || String(password).length < 4) {
    return { ok: false, msg: '密码至少 4 位' };
  }
  if (q.findUser.get(name)) {
    return { ok: false, msg: '该用户名已被注册' };
  }
  return { ok: true, username: name };
}

/**
 * 注册（**异步**，HTTP 路由走这条）。
 *
 * bcrypt 走异步接口：hashSync 是纯 CPU 的同步阻塞，一次 ~90ms，
 * 期间整个 Node 进程（也就是所有其它玩家的请求）都得等着。人一多就排队雪崩。
 * 所以这里返回 Promise，路由那边 await。
 */
async function register(username, password) {
  const v = validateNewAccount(username, password);
  if (!v.ok) return v;
  const hash = await bcrypt.hash(password, 10);
  const info = q.createUser.run(v.username, hash, Date.now());
  return { ok: true, userId: info.lastInsertRowid, username: v.username };
}

/**
 * 注册（**同步**，只给离线脚本 / 造号工具用）。
 *
 * 存在的理由：把 register 改成 async 之后，命令行工具里那句 `dbm.register(...)`
 * 会拿到一个 Promise，`r.ok` 恒为 undefined —— 工具会静默地建不出号。
 * 与其让每个脚本自己 await（总有漏的），不如在这一层把两条路都摆出来。
 */
function registerSync(username, password) {
  const v = validateNewAccount(username, password);
  if (!v.ok) return v;
  const hash = bcrypt.hashSync(password, 10);
  const info = q.createUser.run(v.username, hash, Date.now());
  return { ok: true, userId: info.lastInsertRowid, username: v.username };
}

/** 登录（**异步**，HTTP 路由走这条）。同理走异步 compare，别把进程堵住 */
async function login(username, password) {
  const name = String(username || '').trim();
  const user = q.findUser.get(name);
  if (!user) return { ok: false, msg: '用户名或密码错误' };
  const okPwd = await bcrypt.compare(password || '', user.password);
  if (!okPwd) return { ok: false, msg: '用户名或密码错误' };
  q.touchLogin.run(Date.now(), user.id);
  return { ok: true, userId: user.id, username: user.username };
}

/** 登录（**同步**，只给离线脚本用，理由同 registerSync） */
function loginSync(username, password) {
  const name = String(username || '').trim();
  const user = q.findUser.get(name);
  if (!user) return { ok: false, msg: '用户名或密码错误' };
  if (!bcrypt.compareSync(password || '', user.password)) {
    return { ok: false, msg: '用户名或密码错误' };
  }
  q.touchLogin.run(Date.now(), user.id);
  return { ok: true, userId: user.id, username: user.username };
}

function loadSave(userId) {
  const row = q.getSave.get(userId);
  if (!row) return null;
  try {
    return JSON.parse(row.state);
  } catch (e) {
    return null;
  }
}

function saveGame(userId, state) {
  const json = JSON.stringify(state);
  q.putSave.run(userId, json, Date.now());
  return { ok: true, bytes: json.length };
}

function getUser(userId) {
  return q.findUserById.get(userId) || null;
}

// ---------- 会话 ----------
//
// 为什么放数据库而不是内存 Map：内存 Map 在服务端每次重启时全部作废，
// 而前端 localStorage 里的 token 是长期保存的 —— 结果是「每次重启服务端，
// 所有人都要重新登录一次」。token 落盘之后，重启不再影响登录状态。

/** 会话有效期（毫秒）—— 60 天。只要期间还在用就一直续期 */
const SESSION_TTL_MS = 60 * 24 * 3600 * 1000;
/** 续期节流：距上次续期不足 1 小时就不写库（否则每 15 秒一次自动保存都要 UPDATE） */
const SESSION_TOUCH_MS = 3600 * 1000;

function createSession(userId, username) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  q.putSession.run(token, userId, String(username), now, now);
  return token;
}

/** 查会话并续期。返回 null 表示 token 不存在或已过期 */
function getSession(token) {
  if (!token) return null;
  const row = q.getSession.get(String(token));
  if (!row) return null;
  const now = Date.now();
  if (now - row.seen_at > SESSION_TTL_MS) {
    q.delSession.run(row.token);
    return null;
  }
  if (now - row.seen_at > SESSION_TOUCH_MS) {
    q.putSession.run(row.token, row.user_id, row.username, row.created_at, now);
  }
  return { userId: row.user_id, username: row.username, created: row.created_at, token: row.token };
}

function deleteSession(token) {
  if (token) q.delSession.run(String(token));
}

/** 清掉已过期的会话（启动时调用一次） */
function purgeSessions() {
  const r = q.delStaleSessions.run(Date.now() - SESSION_TTL_MS);
  return r.changes || 0;
}

function sessionStats() {
  return { total: q.countSessions.get().n, ttlDays: Math.round(SESSION_TTL_MS / 86400000) };
}

module.exports = {
  register, login, registerSync, loginSync, loadSave, saveGame, getUser, db,
  createSession, getSession, deleteSession, purgeSessions, sessionStats,
  SESSION_TTL_MS,
};
