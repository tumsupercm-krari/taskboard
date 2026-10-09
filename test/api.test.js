'use strict';
// API tests: run with `npm test`. Uses a throwaway database.
process.env.INGEST_KEYS = 'erp=erp-test-key-0123456789abcdef,short=tooshort';
process.env.DB_PATH = require('node:path').join(require('node:os').tmpdir(), `tb-test-${process.pid}.db`);
const assert = require('node:assert/strict');
const { server, db } = require('../server.js');

let base;
const jar = {};
async function call(who, method, url, body, extraHeaders = {}) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'taskboard', ...(jar[who] ? { Cookie: jar[who] } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, res };
}
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n', e); process.exitCode = 1; } }

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;

  await t('state says setup needed on empty db', async () => { assert.equal((await call('x', 'GET', '/api/state')).json.setupNeeded, true); });
  await t('weak password rejected at setup', async () => { assert.equal((await call('m1', 'POST', '/api/setup', { username: 'boss', name: 'Boss', password: 'short' })).status, 400); });
  await t('setup creates first manager and logs in', async () => {
    const r = await call('m1', 'POST', '/api/setup', { username: 'Boss', name: 'หัวหน้า เอ', password: 'password-1' });
    assert.equal(r.status, 200); assert.equal(r.json.user.role, 'manager');
    assert.match(r.res.headers.get('set-cookie'), /HttpOnly/); assert.match(r.res.headers.get('set-cookie'), /SameSite=Strict/);
  });
  await t('setup is closed afterwards', async () => { assert.equal((await call('x', 'POST', '/api/setup', { username: 'evil', name: 'E', password: 'password-1' })).status, 403); });
  await t('mutating request without header is rejected (CSRF)', async () => {
    const res = await fetch(base + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
  });
  await t('unauthenticated api access is 401', async () => { assert.equal((await call('anon', 'GET', '/api/tasks')).status, 401); });

  let staffA, staffB;
  await t('manager creates staff accounts', async () => {
    staffA = (await call('m1', 'POST', '/api/users', { username: 'somchai', name: 'สมชาย', role: 'staff', password: 'password-2' })).json.user;
    staffB = (await call('m1', 'POST', '/api/users', { username: 'somying', name: 'สมหญิง', role: 'staff', password: 'password-3' })).json.user;
    assert.ok(staffA.id && staffB.id);
    assert.equal((await call('m1', 'POST', '/api/users', { username: 'somchai', name: 'dup', role: 'staff', password: 'password-2' })).status, 409);
  });
  await t('staff login works, wrong password fails', async () => {
    assert.equal((await call('a', 'POST', '/api/login', { username: 'somchai', password: 'nope-nope' })).status, 401);
    assert.equal((await call('a', 'POST', '/api/login', { username: 'somchai', password: 'password-2' })).status, 200);
    assert.equal((await call('b', 'POST', '/api/login', { username: 'somying', password: 'password-3' })).status, 200);
  });
  await t('staff cannot reach user management or invites', async () => {
    for (const [m, u, b] of [['GET', '/api/users'], ['POST', '/api/users', { username: 'x12', name: 'x', role: 'manager', password: 'password-9' }], ['GET', '/api/invites'], ['POST', '/api/invites', {}], ['PATCH', `/api/users/${staffA.id}`, { role: 'manager' }]])
      assert.equal((await call('a', m, u, b)).status, 403, m + ' ' + u);
  });

  let task;
  await t('manager creates task for two people', async () => {
    const r = await call('m1', 'POST', '/api/tasks', { title: 'ทำรายงานประจำเดือน', description: 'รายละเอียด', deadline: '2026-12-31', members: [staffA.id, staffB.id] });
    assert.equal(r.status, 201); task = r.json.task; assert.equal(task.members.length, 2); assert.equal(task.status, 'todo');
    assert.equal(task.history[0].action, 'create');
  });
  await t('invalid deadline / empty title rejected', async () => {
    assert.equal((await call('m1', 'POST', '/api/tasks', { title: 'x', deadline: '2026-02-31', members: [staffA.id] })).status, 400);
    assert.equal((await call('m1', 'POST', '/api/tasks', { title: '  ', members: [staffA.id] })).status, 400);
    assert.equal((await call('m1', 'POST', '/api/tasks', { title: 'x', members: [] })).status, 400);
  });
  await t('staff sees only their own tasks', async () => {
    const mine = (await call('a', 'POST', '/api/tasks', { title: 'งานของสมชายเอง', members: [staffB.id] })).json.task;  // members ignored: forced to self
    assert.deepEqual(mine.members.map((m) => m.id), [staffA.id]);
    const listA = (await call('a', 'GET', '/api/tasks')).json.tasks.map((x) => x.title).sort();
    assert.deepEqual(listA, ['ทำรายงานประจำเดือน', 'งานของสมชายเอง'].sort());
    const listB = (await call('b', 'GET', '/api/tasks')).json.tasks.map((x) => x.title);
    assert.deepEqual(listB, ['ทำรายงานประจำเดือน']);
    assert.equal((await call('b', 'GET', `/api/tasks/${mine.id}`)).status, 404);
    assert.equal((await call('b', 'PATCH', `/api/tasks/${mine.id}`, { title: 'hack' })).status, 404);
    assert.equal((await call('m1', 'GET', '/api/tasks')).json.tasks.length, 2);
  });
  await t('staff edits are recorded with who and when', async () => {
    const r = await call('a', 'PATCH', `/api/tasks/${task.id}`, { description: 'รายละเอียดใหม่', status: 'doing', base_updated_at: task.updated_at });
    assert.equal(r.status, 200);
    const h = r.json.task.history; assert.equal(r.json.task.updated_by_name, 'สมชาย');
    assert.ok(h.some((x) => x.action === 'status' && x.user_name === 'สมชาย' && x.detail.to === 'doing'));
    assert.ok(h.some((x) => x.action === 'update' && x.detail.field === 'description' && x.detail.from === 'รายละเอียด'));
    assert.match(h[0].at, /^\d{4}-\d{2}-\d{2}T/);
    task = r.json.task;
  });
  await t('stale edit is rejected with 409', async () => {
    const r = await call('b', 'PATCH', `/api/tasks/${task.id}`, { title: 'ชื่อใหม่', base_updated_at: '2000-01-01T00:00:00.000Z' });
    assert.equal(r.status, 409);
  });
  await t('staff cannot close task or change members, can send to review', async () => {
    assert.equal((await call('a', 'PATCH', `/api/tasks/${task.id}`, { status: 'done' })).status, 403);
    assert.equal((await call('a', 'PATCH', `/api/tasks/${task.id}`, { members: [staffA.id] })).status, 403);
    assert.equal((await call('a', 'PATCH', `/api/tasks/${task.id}`, { status: 'review' })).status, 200);
  });
  await t('manager closes task; it moves to done board; staff cannot edit it afterwards', async () => {
    const r = await call('m1', 'PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    assert.equal(r.json.task.status, 'done'); assert.equal(r.json.task.done_by_name, 'หัวหน้า เอ');
    const done = (await call('a', 'GET', '/api/tasks?scope=done')).json.tasks; assert.equal(done.length, 1);
    assert.equal((await call('a', 'PATCH', `/api/tasks/${task.id}`, { title: 'x' })).status, 403);
    const reopened = await call('m1', 'PATCH', `/api/tasks/${task.id}`, { status: 'doing' });
    assert.equal(reopened.json.task.done_at, null);
  });
  await t('manager filter by user and member change history', async () => {
    const f = (await call('m1', 'GET', `/api/tasks?user=${staffB.id}`)).json.tasks; assert.equal(f.length, 1);
    const r = await call('m1', 'PATCH', `/api/tasks/${task.id}`, { members: [staffA.id] });
    assert.ok(r.json.task.history.some((x) => x.detail && x.detail.field === 'members' && x.detail.to.length === 1));
    assert.equal((await call('b', 'GET', `/api/tasks/${task.id}`)).status, 404, 'removed member loses access');
  });
  await t('invite + register flow, single use', async () => {
    const inv = (await call('m1', 'POST', '/api/invites', { role: 'staff' })).json;
    assert.equal((await call('n', 'POST', '/api/register', { invite_code: 'BADCODE', username: 'newbie', name: 'N', password: 'password-4' })).status, 400);
    const r = await call('n', 'POST', '/api/register', { invite_code: inv.code, username: 'newbie', name: 'น้องใหม่', password: 'password-4' });
    assert.equal(r.status, 200); assert.equal(r.json.user.role, 'staff');
    assert.equal((await call('n2', 'POST', '/api/register', { invite_code: inv.code, username: 'another', name: 'N', password: 'password-4' })).status, 400);
  });
  await t('cannot demote/deactivate the last manager; can with a second one', async () => {
    const me = (await call('m1', 'GET', '/api/me')).json.user;
    assert.equal((await call('m1', 'PATCH', `/api/users/${me.id}`, { role: 'staff' })).status, 400);
    const m2 = (await call('m1', 'POST', '/api/users', { username: 'boss2', name: 'หัวหน้า บี', role: 'manager', password: 'password-5' })).json.user;
    assert.equal((await call('m2', 'POST', '/api/login', { username: 'boss2', password: 'password-5' })).status, 200);
    assert.equal((await call('m2', 'GET', '/api/tasks')).json.tasks.length, 2, 'second manager sees everything');
    assert.equal((await call('m2', 'PATCH', `/api/users/${me.id}`, { role: 'staff' })).status, 200);
    assert.equal((await call('m1', 'GET', '/api/users')).status, 401, 'demoted manager is signed out immediately');
  });
  await t('deactivated user is locked out; password reset kills sessions', async () => {
    assert.equal((await call('m2', 'PATCH', `/api/users/${staffB.id}`, { active: false })).status, 200);
    assert.equal((await call('b', 'GET', '/api/me')).status, 401);
    assert.equal((await call('b2', 'POST', '/api/login', { username: 'somying', password: 'password-3' })).status, 401);
    await call('m2', 'PATCH', `/api/users/${staffA.id}`, { password: 'brand-new-pass' });
    assert.equal((await call('a', 'GET', '/api/me')).status, 401);
    assert.equal((await call('a', 'POST', '/api/login', { username: 'somchai', password: 'brand-new-pass' })).status, 200);
  });
  await t('login is throttled after repeated failures', async () => {
    let last; for (let i = 0; i < 9; i++) last = await call('z', 'POST', '/api/login', { username: 'ghost', password: 'wrong-wrong' });
    assert.equal(last.status, 429);
  });
  await t('passwords are not stored in plain text', async () => {
    const row = db.prepare("SELECT pw_hash, pw_salt FROM users WHERE username='somchai'").get();
    assert.ok(row.pw_hash.length >= 128 && !row.pw_hash.includes('brand-new-pass'));
  });
  await t('path traversal on static files is blocked', async () => {
    const res = await fetch(base + '/..%2fserver.js'); assert.equal(res.status, 404);
  });
  await t('hour tracking: counts one row per minute, no acknowledgement step', async () => {
    await call('a', 'POST', '/api/login', { username: 'somchai', password: 'brand-new-pass' });
    const r1 = await call('a', 'POST', '/api/activity', {}); assert.equal(r1.status, 200);
    const r2 = await call('a', 'POST', '/api/activity', {});
    assert.equal(r2.json.today_minutes, r1.json.today_minutes, 'two beats in the same minute count once');
    assert.ok(r1.json.today_minutes >= 1);
  });
  await t('hour report: local-day cutting, blocks, permissions', async () => {
    const uid = staffA.id;
    db.prepare('DELETE FROM activity WHERE user_id = ?').run(uid);
    // 2026-03-02 local (UTC+7): day starts 2026-03-01T17:00Z
    const startMin = Date.UTC(2026, 2, 2) / 60000 - 420;
    const put = (m) => db.prepare('INSERT OR IGNORE INTO activity (user_id, minute) VALUES (?,?)').run(uid, m);
    for (let i = 9 * 60; i < 9 * 60 + 90; i++) put(startMin + i);          // 09:00-10:30 = 90 min
    for (let i = 10 * 60 + 40; i < 11 * 60; i++) put(startMin + i);        // 10:40-11:00 = 20 min, gap 10 > 5 -> new block
    put(startMin - 1);                                                     // 23:59 the day before (local)
    put(startMin + 1440);                                                  // 00:00 next local day
    const mgr = (await call('m2', 'GET', '/api/hours?from=2026-03-02&days=2')).json;
    const me = mgr.users.find((u) => u.id === uid);
    assert.equal(me.days[0].minutes, 110); assert.equal(me.days[1].minutes, 1); assert.equal(me.total_minutes, 111);
    assert.equal(me.days[0].blocks.length, 2); assert.equal(me.days[0].blocks[0].minutes, 90);
    assert.equal(me.days[0].first, new Date((startMin + 540) * 60000).toISOString());
    const prev = (await call('m2', 'GET', '/api/hours?from=2026-03-01&days=1')).json.users.find((u) => u.id === uid);
    assert.equal(prev.days[0].minutes, 1, 'minute before local midnight belongs to previous day');
    const own = (await call('a', 'GET', '/api/hours?from=2026-03-02&days=2')).json;
    assert.deepEqual(own.users.map((u) => u.id), [uid], 'staff only sees own hours');
    assert.equal((await call('m2', 'GET', '/api/hours?from=2026-13-40')).status, 400);
    assert.equal((await call('m2', 'GET', '/api/hours?from=2026-03-02&days=99')).status, 400);
  });
  await t('ingest: needs a valid per-system key; no CSRF header needed for server-to-server', async () => {
    const post = (key, body) => fetch(base + '/api/ingest/activity', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const ev = { events: [{ username: 'somchai' }] };
    assert.equal((await post(null, ev)).status, 401);
    assert.equal((await post('wrong-key-wrong-key-wrong-key', ev)).status, 401);
    assert.equal((await post('tooshort', ev)).status, 401, 'invalid configured keys are ignored');
    const ok = await post('erp-test-key-0123456789abcdef', ev);
    assert.equal(ok.status, 200); assert.equal(ok.json.source, 'erp'); assert.equal(ok.json.accepted_minutes, 1);
    assert.equal((await post('erp-test-key-0123456789abcdef', { events: [] })).status, 400);
    assert.equal((await post('erp-test-key-0123456789abcdef', { events: new Array(501).fill({ username: 'x' }) })).status, 400);
  });
  await t('ingest: unknown users skipped, bad times rejected, minutes merged without double counting', async () => {
    const post = (body) => fetch(base + '/api/ingest/activity', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer erp-test-key-0123456789abcdef' }, body: JSON.stringify(body) }).then((r) => r.json());
    const uid = staffA.id; db.prepare('DELETE FROM activity WHERE user_id = ?').run(uid); db.prepare('DELETE FROM activity_source WHERE user_id = ?').run(uid);
    const day = new Date(Date.now() - 10 * 864e5 + 420 * 60000).toISOString().slice(0, 10);   // a recent local day
    const t0 = Date.parse(day + 'T03:00:00Z');                                              // 10:00 local
    const r = await post({ events: [{ username: 'SomChai', at: t0 }, { username: 'ghost', at: t0 }, { username: 'somchai', at: 'not-a-date' }, { username: 'somchai', at: Date.now() + 3_600_000 }] });
    assert.equal(r.accepted_minutes, 1); assert.deepEqual(r.unknown_users, ['ghost']); assert.equal(r.rejected_events, 2);
    // taskboard heartbeat on the same minute + an overlapping erp window -> union
    db.prepare("INSERT OR IGNORE INTO activity (user_id, minute) VALUES (?, ?)").run(uid, Math.floor(t0 / 60000));
    db.prepare("INSERT OR IGNORE INTO activity_source (user_id, minute, source) VALUES (?, ?, 'taskboard')").run(uid, Math.floor(t0 / 60000));
    await post({ events: [{ username: 'somchai', at: t0 }], extend_minutes: 4 });                   // 10:00-10:04 from erp
    const me = (await call('m2', 'GET', `/api/hours?from=${day}&days=1`)).json.users.find((u) => u.id === uid);
    assert.equal(me.total_minutes, 5, 'union of both systems, minute shared by both counted once');
    assert.deepEqual(me.by_source, { erp: 5, taskboard: 1 });
    assert.equal((await post({ events: [{ username: 'somchai', at: t0 }], extend_minutes: 9 })).error, 'extend_minutes ต้องเป็น 0-5');
  });
  await t('logout invalidates the session', async () => {
    await call('a', 'POST', '/api/logout', {}); assert.equal((await call('a', 'GET', '/api/me')).status, 401);
  });

  console.log(`\n${passed} checks passed`);
  server.close(); db.close();
})();
