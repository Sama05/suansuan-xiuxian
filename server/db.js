/**
 * 数据库层 —— SQLite 存档
 * 使用 better-sqlite3 同步 API，简单可靠。
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'game.db'));
db.pragma('journal_mode = WAL');

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
};

function register(username, password) {
  username = String(username || '').trim();
  if (username.length < 2 || username.length > 20) {
    return { ok: false, msg: '用户名长度需为 2-20 个字符' };
  }
  if (!/^[\w\u4e00-\u9fa5]+$/.test(username)) {
    return { ok: false, msg: '用户名只能包含字母、数字、下划线或中文' };
  }
  if (!password || password.length < 4) {
    return { ok: false, msg: '密码至少 4 位' };
  }
  if (q.findUser.get(username)) {
    return { ok: false, msg: '该用户名已被注册' };
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = q.createUser.run(username, hash, Date.now());
  return { ok: true, userId: info.lastInsertRowid, username };
}

function login(username, password) {
  username = String(username || '').trim();
  const user = q.findUser.get(username);
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

module.exports = { register, login, loadSave, saveGame, getUser, db };
