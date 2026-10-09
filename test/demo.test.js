'use strict';
// DEMO_MODE tests: run with `npm test` (separate process from api.test.js because DEMO_MODE is read at load).
process.env.DEMO_MODE = '1';
process.env.DEMO_MANAGER_PASSWORD = 'demo-mgr-pass';
process.env.DEMO_STAFF_PASSWORD = 'demo-staff-pass';
process.env.DEMO_RESET_HOURS = '3';
process.env.INGEST_KEYS = 'erp=erp-test-key-0123456789abcdef';
const path = require('node:path');
process.env.DB_PATH = path.join(require('node:os').tmpdir(), `tb-demo-test-${process.pid}.db`);
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { server, db, resetDemo } = require('../server.js');

let base; const jar = {};
async function call(who, method, url, body, headers = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'taskboard', ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, res };
}
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n', e); process.exitCode = 1; } }
const count = (tbl, where = '') => db.prepare(`SELECT COUNT(*) c FROM ${tbl} ${where}`).get().c;
const ip = (n) => ({ 'X-Forwarded-For': `10.0.0.1, 203.0.113.${n}` });
const ALL_TABLES = ['activity_source', 'activity', 'task_history', 'task_members', 'tasks', 'sessions', 'invites', 'users'];

const NODEMO_SCRIPT = `
const { server } = require('./server.js');
(async () => {
  await new Promise((r) => server.listen(0, r));
  const b = 'http://localhost:' + server.address().port, H = { 'Content-Type': 'application/json', 'X-Requested-With': 'taskboard' };
  const post = (u, body, extra = {}) => fetch(b + u, { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify(body) });
  const s = await (await fetch(b + '/api/state')).json();
  const r = await post('/api/setup', { username: 'boss1', name: 'B', password: 'password-1' });
  const c = r.headers.get('set-cookie').split(';')[0];
  const u = await post('/api/users', { username: 'abc123', name: 'A', role: 'staff', password: 'password-2' }, { Cookie: c });
  let last = 0;
  for (let i = 0; i < 8; i++) last = (await post('/api/login', { username: 'boss1', password: 'bad-bad-bad' })).status;
  const locked = (await post('/api/login', { username: 'boss1', password: 'password-1' })).status;
  console.log(JSON.stringify({ demo: 'demo' in s, setupNeeded: s.setupNeeded, setup: r.status, create: u.status, last, locked }));
  process.exit(0);
})();`;

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;

  await t('seeds 1 manager + 3 staff, >=10 tasks in all 4 statuses, a week of work minutes', async () => {
    assert.equal(count('users', "WHERE role='manager'"), 1); assert.equal(count('users', "WHERE role='staff'"), 3);
    assert.ok(count('tasks') >= 10);
    for (const s of ['todo', 'doing', 'review', 'done']) assert.ok(count('tasks', `WHERE status='${s}'`) >= 1, s);
    assert.equal(count('tasks', 'WHERE deadline IS NULL'), 0);
    assert.ok(count('activity') > 1000); assert.equal(count('activity'), count('activity_source'));
  });
  await t('state exposes demo info with env passwords', async () => {
    const s = (await call('x', 'GET', '/api/state')).json;
    assert.equal(s.setupNeeded, false); assert.equal(s.demo.resetHours, 3);
    assert.deepEqual(s.demo.accounts.map((a) => [a.username, a.role, a.password]), [
      ['manager', 'manager', 'demo-mgr-pass'], ['staff1', 'staff', 'demo-staff-pass'], ['staff2', 'staff', 'demo-staff-pass'], ['staff3', 'staff', 'demo-staff-pass']]);
  });
  await t('demo accounts can log in; hours report has data', async () => {
    assert.equal((await call('m', 'POST', '/api/login', { username: 'manager', password: 'demo-mgr-pass' }, ip(1))).status, 200);
    assert.equal((await call('s', 'POST', '/api/login', { username: 'staff1', password: 'demo-staff-pass' }, ip(1))).status, 200);
    const day = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const h = (await call('m', 'GET', `/api/hours?from=${day}&days=1`)).json;
    assert.ok(h.users.some((u) => u.total_minutes > 0));
  });
  await t('blocked endpoints return Thai 403', async () => {
    const sid = (await call('m', 'GET', '/api/users')).json.users.find((u) => u.username === 'staff1').id;
    for (const [method, url, body] of [['POST', '/api/users', { username: 'evil1', name: 'x', role: 'manager', password: 'password-9' }], ['PATCH', `/api/users/${sid}`, { active: false }], ['PATCH', `/api/users/${sid}`, { password: 'hacked-pass-1' }],
      ['POST', '/api/invites', { role: 'staff' }], ['DELETE', '/api/invites/ABC', undefined], ['POST', '/api/register', { invite_code: 'x', username: 'evil2', name: 'x', password: 'password-9' }],
      ['POST', '/api/setup', { username: 'evil3', name: 'x', password: 'password-9' }]]) {
      const r = await call('m', method, url, body); assert.equal(r.status, 403, method + ' ' + url); assert.match(r.json.error, /เดโม/);
    }
    const ing = await fetch(base + '/api/ingest/activity', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer erp-test-key-0123456789abcdef' }, body: JSON.stringify({ events: [{ username: 'staff1' }] }) });
    assert.equal(ing.status, 403);
    assert.equal(count('users'), 4);
    assert.equal((await call('s', 'POST', '/api/login', { username: 'staff1', password: 'demo-staff-pass' }, ip(1))).status, 200, 'password unchanged');
  });
  await t('login throttle is per IP and never locks the shared account', async () => {
    for (let i = 0; i < 10; i++) await call('atk', 'POST', '/api/login', { username: 'manager', password: 'wrong-wrong' }, ip(99));
    assert.equal((await call('atk', 'POST', '/api/login', { username: 'manager', password: 'demo-mgr-pass' }, ip(99))).status, 429, 'attacker IP throttled');
    assert.equal((await call('ok', 'POST', '/api/login', { username: 'manager', password: 'demo-mgr-pass' }, ip(7))).status, 200, 'other IP still logs in');
  });
  await t('caps: title/description length', async () => {
    const uid = db.prepare("SELECT id FROM users WHERE username='staff2'").get().id;
    assert.equal((await call('m', 'POST', '/api/tasks', { title: 'x'.repeat(101), members: [uid] }, ip(2))).status, 400);
    assert.equal((await call('m', 'POST', '/api/tasks', { title: 'ok', description: 'y'.repeat(1001), members: [uid] }, ip(2))).status, 400);
    assert.equal((await call('m', 'POST', '/api/tasks', { title: 'x'.repeat(100), members: [uid] }, ip(2))).status, 201);
  });
  await t('caps: task count limit 150', async () => {
    const uid = db.prepare("SELECT id FROM users WHERE username='manager'").get().id;
    db.exec('BEGIN');
    while (count('tasks') < 150) db.prepare("INSERT INTO tasks (title, created_by, created_at, updated_at) VALUES ('f',?, 'x','x')").run(uid);
    db.exec('COMMIT');
    const r = await call('m', 'POST', '/api/tasks', { title: 'เกินโควตา', members: [uid] }, ip(3));
    assert.equal(r.status, 403); assert.match(r.json.error, /150/);
  });
  await t('per-IP write rate limit (other IP unaffected)', async () => {
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await call('m', 'DELETE', '/api/tasks/999999', undefined, ip(50))).status === 429) limited++;
    assert.ok(limited >= 9, 'limited ' + limited);
    assert.notEqual((await call('m', 'DELETE', '/api/tasks/999999', undefined, ip(51))).status, 429);
  });
  await t('reset wipes visitor junk, invalidates sessions, restores seed', async () => {
    resetDemo();
    assert.equal(count('tasks'), 12); assert.equal(count('users'), 4); assert.equal(count('sessions'), 0);
    assert.equal((await call('m', 'GET', '/api/me')).status, 401);
    assert.equal((await call('m', 'POST', '/api/login', { username: 'manager', password: 'demo-mgr-pass' }, ip(8))).status, 200);
  });
  await t('empty db is reseeded on next /api/state', async () => {
    db.exec('PRAGMA foreign_keys = OFF'); for (const tb of ALL_TABLES) db.exec(`DELETE FROM ${tb}`); db.exec('PRAGMA foreign_keys = ON');
    const s = (await call('x', 'GET', '/api/state')).json;
    assert.equal(s.setupNeeded, false); assert.equal(count('users'), 4);
  });
  await t('generated passwords when env unset (never hardcoded)', async () => {
    const { resolveConfig } = require('../demo/demo-data.js'); const logs = [];
    const cfg = resolveConfig({}, (m) => logs.push(m));
    assert.equal(cfg.resetHours, 6); assert.equal(logs.length, 2);
    assert.ok(cfg.accounts.every((a) => a.password.length >= 8));
    assert.notEqual(cfg.accounts[0].password, resolveConfig({}, () => {}).accounts[0].password);
  });
  await t('non-demo mode unchanged: no demo field, setup open, per-username lockout', async () => {
    const env = { ...process.env }; delete env.DEMO_MODE; env.DB_PATH = path.join(require('node:os').tmpdir(), `tb-nodemo-${process.pid}.db`);
    const out = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', NODEMO_SCRIPT], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.stdout.trim()), { demo: false, setupNeeded: true, setup: 200, create: 201, last: 401, locked: 429 }, out.stderr);
  });

  console.log(`\n${passed} demo checks passed`);
  server.close(); db.close();
})();
