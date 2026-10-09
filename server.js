'use strict';
// TaskBoard: zero-dependency Node server (node:http + node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'taskboard.db');
const SETUP_KEY = process.env.SETUP_KEY || '';          // optional: required to create the first manager
const SESSION_DAYS = 7;
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN ?? 420);   // Asia/Bangkok = UTC+7; used to cut days for hour reports
const INGEST_KEYS = parseIngestKeys(process.env.INGEST_KEYS || '');   // "erp=secret1,crm=secret2": systems allowed to report activity
const BLOCK_GAP_MIN = 5;                                          // active minutes closer than this form one work block
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUSES = ['todo', 'doing', 'review', 'done'];
// Opt-in public demo (DEMO_MODE=1): fake data, periodic reset, locked-down admin endpoints. Unset = normal behaviour.
const DEMO = process.env.DEMO_MODE === '1';
const demoData = DEMO ? require('./demo/demo-data.js') : null;
const DEMO_MAX_TASKS = 150, DEMO_WRITES_PER_MIN = 60;
const TITLE_MAX = DEMO ? 100 : 200, DESC_MAX = DEMO ? 1000 : 5000;
const DEMO_BLOCKED = [/^\/api\/(setup|register)$/, /^\/api\/users(\/\d+)?$/, /^\/api\/invites(\/[^/]+)?$/, /^\/api\/ingest\//];

function parseIngestKeys(spec) {
  const out = [];
  for (const part of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    const name = part.slice(0, i).trim().toLowerCase(), key = part.slice(i + 1).trim();
    if (i < 1 || !/^[a-z0-9_-]{1,20}$/.test(name) || key.length < 24) { console.warn(`INGEST_KEYS: ignoring invalid entry "${part.split('=')[0]}" (name a-z0-9_- and key of 24+ chars required)`); continue; }
    out.push({ name, hash: crypto.createHash('sha256').update(key).digest() });
  }
  return out;
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager','staff')),
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('manager','staff')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  done_at TEXT,
  done_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS task_members (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (task_id, user_id)
);
CREATE TABLE IF NOT EXISTS task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  user_name TEXT NOT NULL,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_user ON task_members(user_id);
CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id);
CREATE TABLE IF NOT EXISTS activity (
  user_id INTEGER NOT NULL REFERENCES users(id),
  minute INTEGER NOT NULL,
  PRIMARY KEY (user_id, minute)
) WITHOUT ROWID;
`);
const hadSource = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_source'").get();
db.exec(`CREATE TABLE IF NOT EXISTS activity_source (
  user_id INTEGER NOT NULL REFERENCES users(id),
  minute INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (user_id, minute, source)
) WITHOUT ROWID;`);
if (!hadSource) db.exec("INSERT OR IGNORE INTO activity_source (user_id, minute, source) SELECT user_id, minute, 'taskboard' FROM activity");
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'tracking_ack_at')) db.exec('ALTER TABLE users ADD COLUMN tracking_ack_at TEXT');

// ---------- helpers ----------
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(pw, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DUMMY = hashPassword('dummy-password-for-timing');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 200_000) { reject(new HttpError(413, 'ข้อมูลใหญ่เกินไป')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(bad('รูปแบบข้อมูลไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isSecure = (req) => process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
function sessionCookie(req, token, maxAgeSec) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, exp);
  return token;
}
function getUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
  if (!row || !row.active || row.expires_at < now()) return null;
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}

// client IP: LAST X-Forwarded-For value (the proxy appends the real peer; earlier values are client-controlled), only behind a trusted proxy (demo mode / TRUST_PROXY=1)
const clientIp = (req) => ((DEMO || process.env.TRUST_PROXY === '1') && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '?';
// demo: per-IP write rate limit (excludes login/logout and the work-hour heartbeat)
const writeHits = new Map();
function demoWriteLimited(ip) {
  const t = Date.now(), h = (writeHits.get(ip) || []).filter((x) => t - x < 60_000);
  h.push(t); writeHits.set(ip, h);
  return h.length > DEMO_WRITES_PER_MIN;
}

// simple login throttle: 8 failures per username per 10 minutes (demo: per IP, so shared demo accounts can't be locked for everyone)
const fails = new Map();
function throttled(key) { const f = fails.get(key); return f && f.until > Date.now(); }
function noteFail(key) {
  const f = fails.get(key) || { n: 0, until: 0, first: Date.now() };
  if (Date.now() - f.first > 600_000) { f.n = 0; f.first = Date.now(); }
  f.n++; if (f.n >= 8) f.until = Date.now() + 600_000;
  fails.set(key, f);
}

const cleanStr = (v, max, label, { required = false } = {}) => {
  if (v == null) v = '';
  if (typeof v !== 'string') throw bad(`${label} ไม่ถูกต้อง`);
  v = v.trim();
  if (required && !v) throw bad(`กรุณากรอก${label}`);
  if (v.length > max) throw bad(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return v;
};
function cleanUsername(v) {
  v = cleanStr(v, 32, 'ชื่อผู้ใช้', { required: true }).toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(v)) throw bad('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 3-32 ตัว');
  return v;
}
function cleanPassword(v) {
  if (typeof v !== 'string' || v.length < 8) throw bad('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
  if (v.length > 200) throw bad('รหัสผ่านยาวเกินไป');
  return v;
}
function cleanDeadline(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('วันที่ deadline ไม่ถูกต้อง');
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('วันที่ deadline ไม่ถูกต้อง');
  return v;
}
const cleanRole = (v) => { if (v !== 'manager' && v !== 'staff') throw bad('ตำแหน่งไม่ถูกต้อง'); return v; };
const cleanStatus = (v) => { if (!STATUSES.includes(v)) throw bad('สถานะงานไม่ถูกต้อง'); return v; };

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, created_at: u.created_at });
const requireManager = (user) => { if (user.role !== 'manager') throw new HttpError(403, 'เฉพาะผู้จัดการเท่านั้น'); };
const activeManagerCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='manager' AND active=1").get().c;

// ---------- tasks ----------
function loadTasks(where, params) {
  const rows = db.prepare(`SELECT t.*, cu.name AS created_by_name, uu.name AS updated_by_name, du.name AS done_by_name
    FROM tasks t JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users uu ON uu.id = t.updated_by LEFT JOIN users du ON du.id = t.done_by
    ${where} ORDER BY t.id`).all(...params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const mem = db.prepare(`SELECT m.task_id, u.id, u.name FROM task_members m JOIN users u ON u.id = m.user_id
    WHERE m.task_id IN (${ids.map(() => '?').join(',')}) ORDER BY u.name`).all(...ids);
  const byTask = new Map();
  for (const m of mem) { if (!byTask.has(m.task_id)) byTask.set(m.task_id, []); byTask.get(m.task_id).push({ id: m.id, name: m.name }); }
  return rows.map((r) => ({ ...r, members: byTask.get(r.id) || [] }));
}
function canSee(user, taskId) {
  if (user.role === 'manager') return true;
  return !!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND (t.created_by = ? OR EXISTS
    (SELECT 1 FROM task_members m WHERE m.task_id = t.id AND m.user_id = ?))`).get(taskId, user.id, user.id);
}
function getTask(user, id) {
  if (!Number.isInteger(id) || !canSee(user, id)) throw new HttpError(404, 'ไม่พบงานนี้');
  const t = loadTasks('WHERE t.id = ?', [id])[0];
  if (!t) throw new HttpError(404, 'ไม่พบงานนี้');
  t.history = db.prepare('SELECT id, user_id, user_name, at, action, detail FROM task_history WHERE task_id = ? ORDER BY id DESC').all(id)
    .map((h) => ({ ...h, detail: h.detail ? JSON.parse(h.detail) : null }));
  return t;
}
function cleanMembers(v) {
  if (!Array.isArray(v) || v.length > 50) throw bad('รายชื่อผู้เกี่ยวข้องไม่ถูกต้อง');
  const ids = [...new Set(v.map(Number))];
  for (const id of ids) {
    const u = db.prepare('SELECT active FROM users WHERE id = ?').get(id);
    if (!Number.isInteger(id) || !u || !u.active) throw bad('ผู้เกี่ยวข้องบางคนไม่มีอยู่ในระบบหรือถูกปิดใช้งาน');
  }
  return ids;
}
const addHistory = (taskId, user, action, detail) =>
  db.prepare('INSERT INTO task_history (task_id, user_id, user_name, at, action, detail) VALUES (?,?,?,?,?,?)')
    .run(taskId, user.id, user.name, now(), action, detail ? JSON.stringify(detail) : null);
const names = (ids) => ids.map((id) => db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name || '?').sort();

function createTask(user, b) {
  const title = cleanStr(b.title, TITLE_MAX, 'ชื่องาน', { required: true });
  const description = cleanStr(b.description, DESC_MAX, 'รายละเอียดงาน');
  const deadline = cleanDeadline(b.deadline);
  let members = user.role === 'manager' ? cleanMembers(b.members ?? []) : [user.id];
  if (user.role === 'manager' && !members.length) throw bad('กรุณาเลือกผู้เกี่ยวข้องอย่างน้อย 1 คน');
  if (DEMO && db.prepare('SELECT COUNT(*) c FROM tasks').get().c >= DEMO_MAX_TASKS) throw new HttpError(403, `เดโมจำกัดจำนวนงานไม่เกิน ${DEMO_MAX_TASKS} งาน กรุณารอรีเซ็ตหรือลบงานเดิมก่อน`);
  const t = now();
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO tasks (title, description, deadline, status, created_by, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(title, description, deadline, 'todo', user.id, t, t, user.id);
    const id = Number(r.lastInsertRowid);
    for (const m of members) db.prepare('INSERT INTO task_members (task_id, user_id) VALUES (?,?)').run(id, m);
    addHistory(id, user, 'create', { members: names(members) });
    db.exec('COMMIT');
    return id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function updateTask(user, id, b) {
  const cur = getTask(user, id);
  const isManager = user.role === 'manager';
  if (!isManager && cur.status === 'done') throw new HttpError(403, 'งานที่เสร็จแล้วแก้ไขได้เฉพาะผู้จัดการ');
  if (b.base_updated_at && b.base_updated_at !== cur.updated_at) throw new HttpError(409, 'มีคนแก้ไขงานนี้ไปก่อนแล้ว กรุณาปิดแล้วเปิดงานใหม่เพื่อดูข้อมูลล่าสุด');
  const changes = []; const sets = {};
  if ('title' in b) { const v = cleanStr(b.title, TITLE_MAX, 'ชื่องาน', { required: true }); if (v !== cur.title) { changes.push(['update', { field: 'title', from: cur.title, to: v }]); sets.title = v; } }
  if ('description' in b) { const v = cleanStr(b.description, DESC_MAX, 'รายละเอียดงาน'); if (v !== cur.description) { changes.push(['update', { field: 'description', from: cur.description, to: v }]); sets.description = v; } }
  if ('deadline' in b) { const v = cleanDeadline(b.deadline); if (v !== cur.deadline) { changes.push(['update', { field: 'deadline', from: cur.deadline, to: v }]); sets.deadline = v; } }
  let newMembers = null;
  if ('members' in b) {
    if (!Array.isArray(b.members)) throw bad('รายชื่อผู้เกี่ยวข้องไม่ถูกต้อง');
    if (!isManager) { const same = JSON.stringify([...new Set(b.members.map(Number))].sort()) === JSON.stringify(cur.members.map((m) => m.id).sort()); if (!same) throw new HttpError(403, 'เฉพาะผู้จัดการที่เปลี่ยนผู้เกี่ยวข้องได้'); }
    else {
      const ids = cleanMembers(b.members);
      if (!ids.length) throw bad('กรุณาเลือกผู้เกี่ยวข้องอย่างน้อย 1 คน');
      const before = cur.members.map((m) => m.id).sort((x, y) => x - y);
      if (JSON.stringify(before) !== JSON.stringify([...ids].sort((x, y) => x - y))) { newMembers = ids; changes.push(['update', { field: 'members', from: names(before), to: names(ids) }]); }
    }
  }
  if ('status' in b) {
    const v = cleanStatus(b.status);
    if (v !== cur.status) {
      if (!isManager && v === 'done') throw new HttpError(403, 'เฉพาะผู้จัดการที่ปิดงานเป็น "เสร็จแล้ว" ได้');
      changes.push(['status', { from: cur.status, to: v }]); sets.status = v;
      if (v === 'done') { sets.done_at = now(); sets.done_by = user.id; } else if (cur.status === 'done') { sets.done_at = null; sets.done_by = null; }
    }
  }
  if (!changes.length) return getTask(user, id);
  const t = now();
  db.exec('BEGIN');
  try {
    const cols = Object.keys(sets);
    db.prepare(`UPDATE tasks SET ${[...cols.map((c) => `${c} = ?`), 'updated_at = ?', 'updated_by = ?'].join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => sets[c]), t, user.id, id);
    if (newMembers) {
      db.prepare('DELETE FROM task_members WHERE task_id = ?').run(id);
      for (const m of newMembers) db.prepare('INSERT INTO task_members (task_id, user_id) VALUES (?,?)').run(id, m);
    }
    for (const [action, detail] of changes) addHistory(id, user, action, detail);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getTask(user, id);
}

// ---------- routing ----------
const routes = [];
const route = (method, pattern, opts, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opts, fn });

route('GET', '/api/state', { auth: false }, () => {
  if (DEMO && db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) resetDemo();   // empty db: reseed
  return { setupNeeded: db.prepare('SELECT COUNT(*) c FROM users').get().c === 0, setupKeyRequired: !!SETUP_KEY, ...(DEMO ? { demo: demoInfo() } : {}) };
});

route('POST', '/api/setup', { auth: false }, (ctx, b) => {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) throw new HttpError(403, 'ระบบตั้งค่าแล้ว');
  if (SETUP_KEY && b.setup_key !== SETUP_KEY) throw new HttpError(403, 'รหัสตั้งค่าระบบไม่ถูกต้อง');
  const u = cleanUsername(b.username), name = cleanStr(b.name, 80, 'ชื่อ', { required: true }), pw = cleanPassword(b.password);
  const { salt, hash } = hashPassword(pw);
  const r = db.prepare('INSERT INTO users (username, name, role, pw_salt, pw_hash, created_at) VALUES (?,?,?,?,?,?)').run(u, name, 'manager', salt, hash, now());
  return loginAs(ctx, Number(r.lastInsertRowid));
});

function loginAs(ctx, userId) {
  const token = createSession(userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return { status: 200, headers: { 'Set-Cookie': sessionCookie(ctx.req, token, SESSION_DAYS * 86400) }, body: { user: publicUser(user) } };
}

route('POST', '/api/login', { auth: false }, (ctx, b) => {
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  const pw = typeof b.password === 'string' ? b.password : '';
  const tkey = DEMO ? 'ip:' + clientIp(ctx.req) : username;    // demo: throttle the caller's IP, never lock the shared accounts
  if (throttled(tkey)) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป กรุณารอ 10 นาทีแล้วลองใหม่');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = u ? checkPassword(pw, u.pw_salt, u.pw_hash) : (checkPassword(pw, DUMMY.salt, DUMMY.hash), false);
  if (!ok || !u.active) { noteFail(tkey); throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'); }
  fails.delete(tkey);
  return loginAs(ctx, u.id);
});

route('POST', '/api/logout', { auth: false }, (ctx) => {
  const token = parseCookies(ctx.req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  return { status: 200, headers: { 'Set-Cookie': sessionCookie(ctx.req, '', 0) }, body: { ok: true } };
});

route('GET', '/api/me', { auth: true }, (ctx) => ({ user: ctx.user }));

route('POST', '/api/register', { auth: false }, (ctx, b) => {
  const code = cleanStr(b.invite_code, 40, 'รหัสเชิญ', { required: true }).toUpperCase();
  const username = cleanUsername(b.username), name = cleanStr(b.name, 80, 'ชื่อ', { required: true }), pw = cleanPassword(b.password);
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!inv || inv.used_by || inv.expires_at < now()) throw new HttpError(400, 'รหัสเชิญไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  const { salt, hash } = hashPassword(pw);
  db.exec('BEGIN');
  let id;
  try {
    id = Number(db.prepare('INSERT INTO users (username, name, role, pw_salt, pw_hash, created_at) VALUES (?,?,?,?,?,?)').run(username, name, inv.role, salt, hash, now()).lastInsertRowid);
    db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(id, code);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return loginAs(ctx, id);
});

// users (manager only)
route('GET', '/api/users', { auth: true }, ({ user }) => {
  requireManager(user);
  return { users: db.prepare('SELECT * FROM users ORDER BY active DESC, role, name').all().map(publicUser) };
});
route('POST', '/api/users', { auth: true }, ({ user }, b) => {
  requireManager(user);
  const username = cleanUsername(b.username), name = cleanStr(b.name, 80, 'ชื่อ', { required: true }), role = cleanRole(b.role), pw = cleanPassword(b.password);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  const { salt, hash } = hashPassword(pw);
  const id = Number(db.prepare('INSERT INTO users (username, name, role, pw_salt, pw_hash, created_at) VALUES (?,?,?,?,?,?)').run(username, name, role, salt, hash, now()).lastInsertRowid);
  return { status: 201, body: { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) } };
});
route('PATCH', '/api/users/:id', { auth: true }, ({ user, params }, b) => {
  requireManager(user);
  const id = Number(params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้');
  const name = 'name' in b ? cleanStr(b.name, 80, 'ชื่อ', { required: true }) : target.name;
  const role = 'role' in b ? cleanRole(b.role) : target.role;
  const active = 'active' in b ? (b.active ? 1 : 0) : target.active;
  const losesManager = target.role === 'manager' && target.active && (role !== 'manager' || !active);
  if (losesManager && activeManagerCount() <= 1) throw bad('ต้องมีผู้จัดการที่ใช้งานอยู่อย่างน้อย 1 คน');
  if (id === user.id && !active) throw bad('ปิดใช้งานบัญชีของตัวเองไม่ได้');
  db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, id);
  if ('password' in b && b.password !== '') {
    const { salt, hash } = hashPassword(cleanPassword(b.password));
    db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (!active || role !== target.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
});
route('GET', '/api/invites', { auth: true }, ({ user }) => {
  requireManager(user);
  return { invites: db.prepare(`SELECT i.code, i.role, i.created_at, i.expires_at, i.used_by, u.name AS used_by_name, c.name AS created_by_name
    FROM invites i JOIN users c ON c.id = i.created_by LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 100`).all() };
});
route('POST', '/api/invites', { auth: true }, ({ user }, b) => {
  requireManager(user);
  const role = cleanRole(b.role || 'staff');
  const code = crypto.randomBytes(6).toString('hex').toUpperCase();
  const exp = new Date(Date.now() + 7 * 864e5).toISOString();
  db.prepare('INSERT INTO invites (code, role, created_by, created_at, expires_at) VALUES (?,?,?,?,?)').run(code, role, user.id, now(), exp);
  return { status: 201, body: { code, role, expires_at: exp } };
});
route('DELETE', '/api/invites/:code', { auth: true }, ({ user, params }) => {
  requireManager(user);
  db.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').run(params.code.toUpperCase());
  return { ok: true };
});

// tasks
route('GET', '/api/tasks', { auth: true }, ({ user, url }) => {
  const scope = url.searchParams.get('scope') || 'board';              // board | done
  const who = url.searchParams.get('user');                             // manager: user id filter
  const clauses = []; const params = [];
  if (scope === 'done') clauses.push("t.status = 'done'");
  else { clauses.push("(t.status != 'done' OR t.done_at >= ?)"); params.push(new Date(Date.now() - 7 * 864e5).toISOString()); }
  let filterUser = null;
  if (user.role !== 'manager') filterUser = user.id;
  else if (who && who !== 'all') { filterUser = Number(who); if (!Number.isInteger(filterUser)) throw bad('ตัวกรองไม่ถูกต้อง'); }
  if (filterUser != null) {
    clauses.push('(t.created_by = ? OR EXISTS (SELECT 1 FROM task_members m WHERE m.task_id = t.id AND m.user_id = ?))');
    params.push(filterUser, filterUser);
  }
  const tasks = loadTasks('WHERE ' + clauses.join(' AND '), params);
  if (scope === 'done') tasks.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
  return { tasks };
});
route('GET', '/api/tasks/:id', { auth: true }, ({ user, params }) => ({ task: getTask(user, Number(params.id)) }));
route('POST', '/api/tasks', { auth: true }, ({ user }, b) => ({ status: 201, body: { task: getTask(user, createTask(user, b)) } }));
route('PATCH', '/api/tasks/:id', { auth: true }, ({ user, params }, b) => ({ task: updateTask(user, Number(params.id), b) }));
route('DELETE', '/api/tasks/:id', { auth: true }, ({ user, params }) => {
  requireManager(user);
  const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(params.id));
  if (!r.changes) throw new HttpError(404, 'ไม่พบงานนี้');
  return { ok: true };
});


// ---------- work-hours tracking ----------
// The browser sends a heartbeat every 30s while the app is visible AND the user touched mouse/keyboard/screen in the last 2 minutes.
// Each heartbeat marks the current minute as active (one row per user per minute), so hours = active minutes / 60.
const localDay = (minute) => Math.floor((minute + TZ_OFFSET_MIN) / 1440);           // days since 1970-01-01, local time
const dayStartMinute = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d) / 60000 - TZ_OFFSET_MIN; };
const ymdAddDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const minuteIso = (min) => new Date(min * 60000).toISOString();

function markActive(userId, minute, source) {
  db.prepare('INSERT OR IGNORE INTO activity (user_id, minute) VALUES (?, ?)').run(userId, minute);
  db.prepare('INSERT OR IGNORE INTO activity_source (user_id, minute, source) VALUES (?, ?, ?)').run(userId, minute, source);
}

// Other company systems (ERP, ...) report activity here, server to server, with a per-system API key.
// Minutes are merged with TaskBoard's own, so time spent in both systems at once is counted only once.
function ingestSource(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!m || !INGEST_KEYS.length) return null;
  const given = crypto.createHash('sha256').update(m[1].trim()).digest();
  let found = null;
  for (const k of INGEST_KEYS) if (crypto.timingSafeEqual(k.hash, given)) found = k.name;   // check all: constant time
  return found;
}
route('POST', '/api/ingest/activity', { auth: false, ingest: true }, ({ source }, b) => {
  if (!Array.isArray(b.events) || !b.events.length || b.events.length > 500) throw bad('events ต้องเป็นรายการ 1-500 รายการ');
  const extend = b.extend_minutes == null ? 0 : Number(b.extend_minutes);
  if (!Number.isInteger(extend) || extend < 0 || extend > 5) throw bad('extend_minutes ต้องเป็น 0-5');
  const nowMs = Date.now(), users = new Map();
  const res = { source, accepted_minutes: 0, unknown_users: [], rejected_events: 0 };
  db.exec('BEGIN');
  try {
    for (const ev of b.events) {
      const uname = ev && typeof ev.username === 'string' ? ev.username.trim().toLowerCase() : '';
      const at = ev && ev.at != null ? (typeof ev.at === 'number' ? ev.at : Date.parse(ev.at)) : nowMs;
      if (!uname || !Number.isFinite(at) || at > nowMs + 120_000 || at < nowMs - 31 * 864e5) { res.rejected_events++; continue; }
      if (!users.has(uname)) users.set(uname, db.prepare('SELECT id, active FROM users WHERE username = ?').get(uname) || null);
      const u = users.get(uname);
      if (!u || !u.active) { if (!res.unknown_users.includes(uname)) res.unknown_users.push(uname); continue; }
      const base = Math.floor(at / 60000), maxMinute = Math.floor(nowMs / 60000);
      for (let i = 0; i <= extend && base + i <= maxMinute; i++) { markActive(u.id, base + i, source); res.accepted_minutes++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return res;
});

route('POST', '/api/activity', { auth: true }, ({ user }) => {
  const minute = Math.floor(Date.now() / 60000);
  markActive(user.id, minute, 'taskboard');
  const start = localDay(minute) * 1440 - TZ_OFFSET_MIN;
  const today = db.prepare('SELECT COUNT(*) c FROM activity WHERE user_id = ? AND minute >= ? AND minute < ?').get(user.id, start, start + 1440).c;
  return { today_minutes: today };
});

route('GET', '/api/hours', { auth: true }, ({ user, url }) => {
  const from = cleanDeadline(url.searchParams.get('from'));
  if (!from) throw bad('กรุณาระบุวันที่เริ่มต้น');
  const days = Number(url.searchParams.get('days') || 7);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw bad('จำนวนวันต้องอยู่ระหว่าง 1-31');
  const lo = dayStartMinute(from), hi = lo + days * 1440;
  const dates = Array.from({ length: days }, (_, i) => ymdAddDays(from, i));
  const who = user.role === 'manager'
    ? db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY role, name').all()
    : db.prepare('SELECT id, name, role FROM users WHERE id = ?').all(user.id);
  const rows = db.prepare(`SELECT user_id, minute FROM activity WHERE minute >= ? AND minute < ?
    ${user.role === 'manager' ? '' : 'AND user_id = ' + Number(user.id)} ORDER BY user_id, minute`).all(lo, hi);
  const srcRows = db.prepare(`SELECT user_id, source, COUNT(*) c FROM activity_source WHERE minute >= ? AND minute < ?
    ${user.role === 'manager' ? '' : 'AND user_id = ' + Number(user.id)} GROUP BY user_id, source`).all(lo, hi);
  const srcByUser = new Map();
  for (const r of srcRows) { if (!srcByUser.has(r.user_id)) srcByUser.set(r.user_id, {}); srcByUser.get(r.user_id)[r.source] = r.c; }
  const byUser = new Map();
  for (const r of rows) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r.minute); }
  const users = who.map((u) => {
    const mins = byUser.get(u.id) || [];
    const perDay = dates.map((date) => ({ date, minutes: 0, first: null, last: null, blocks: [] }));
    let blk = null;
    for (const m of mins) {
      const d = perDay[Math.floor((m - lo) / 1440)];
      d.minutes++;
      if (!d.first) d.first = minuteIso(m);
      d.last = minuteIso(m + 1);
      if (blk && blk.day === d && m - blk.endMin <= BLOCK_GAP_MIN) { blk.endMin = m + 1; blk.minutes++; blk.ref.end = minuteIso(m + 1); blk.ref.minutes++; }
      else { const ref = { start: minuteIso(m), end: minuteIso(m + 1), minutes: 1 }; d.blocks.push(ref); blk = { day: d, endMin: m + 1, minutes: 1, ref }; }
    }
    return { id: u.id, name: u.name, role: u.role, total_minutes: mins.length, by_source: srcByUser.get(u.id) || {}, days: perDay };
  });
  return { from, days, dates, tz_offset_min: TZ_OFFSET_MIN, users };
});

// ---------- static + server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
  res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return serveStatic(req, res, decodeURIComponent(url.pathname));
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (DEMO && mutating) {
      if (DEMO_BLOCKED.some((re) => re.test(url.pathname))) throw new HttpError(403, 'ปิดใช้งานในโหมดเดโม: ไม่สามารถสร้าง/แก้ไขผู้ใช้ รหัสเชิญ การสมัคร หรือเชื่อมระบบอื่นได้');
      if (url.pathname.startsWith('/api/') && !['/api/login', '/api/logout', '/api/activity'].includes(url.pathname) && demoWriteLimited(clientIp(req)))
        throw new HttpError(429, 'ส่งคำขอถี่เกินไปในโหมดเดโม กรุณารอสักครู่แล้วลองใหม่');
    }
    if (mutating && !url.pathname.startsWith('/api/ingest/') && req.headers['x-requested-with'] !== 'taskboard') throw new HttpError(403, 'คำขอไม่ถูกต้อง');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const ctx = { req, url, params: m.groups || {}, user: null };
      if (r.opts.ingest) { ctx.source = ingestSource(req); if (!ctx.source) throw new HttpError(401, 'API key ไม่ถูกต้อง'); }
      if (r.opts.auth) { ctx.user = getUser(req); if (!ctx.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ'); }
      const body = mutating ? await readJson(req) : {};
      const out = r.fn(ctx, body);
      if (out && out.body) return sendJson(res, out.status || 200, out.body, { ...SEC_HEADERS, ...(out.headers || {}) });
      return sendJson(res, 200, out, SEC_HEADERS);
    }
    throw new HttpError(404, 'ไม่พบหน้านี้');
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message }, SEC_HEADERS);
    console.error(e);
    sendJson(res, 500, { error: 'เกิดข้อผิดพลาดภายในระบบ' }, SEC_HEADERS);
  }
});

// purge expired sessions hourly
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600_000).unref();

// ---------- demo mode ----------
let demoCfg = null;
const demoInfo = () => ({ resetHours: demoCfg.resetHours, accounts: demoCfg.accounts });
function resetDemo() { demoData.resetAndSeed(db, hashPassword, demoCfg, TZ_OFFSET_MIN); writeHits.clear(); fails.clear(); }
if (DEMO) {
  demoCfg = demoData.resolveConfig();
  resetDemo();
  setInterval(() => { try { resetDemo(); console.log('[demo] reset done'); } catch (e) { console.error('[demo] reset failed', e); } }, demoCfg.resetHours * 3600_000).unref();
}

if (require.main === module) {
  const onListen = () => console.log(`TaskBoard running on ${DEMO ? 'port ' + PORT + ' (DEMO MODE)' : 'http://localhost:' + PORT}`);
  if (DEMO) server.listen(PORT, '0.0.0.0', onListen); else server.listen(PORT, onListen);
}
module.exports = { server, db, resetDemo };
