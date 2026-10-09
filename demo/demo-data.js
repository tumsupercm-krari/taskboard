'use strict';
// DEMO_MODE support: fictional data + wipe/reseed. All data here is fake. Used in-process by server.js.
const crypto = require('node:crypto');

const DEMO_USERS = [
  { username: 'manager', name: 'วิภา รัตนากร', role: 'manager', pwKey: 'manager' },
  { username: 'staff1', name: 'ธนากร ศรีสุวรรณ', role: 'staff', pwKey: 'staff' },
  { username: 'staff2', name: 'พิมพ์ชนก แก้วมณี', role: 'staff', pwKey: 'staff' },
  { username: 'staff3', name: 'กฤษดา พึ่งบุญ', role: 'staff', pwKey: 'staff' },
];

// [title, description, status, deadline offset (days from today), member indexes into DEMO_USERS, done N days ago]
const DEMO_TASKS = [
  ['สรุปยอดขายประจำเดือน', 'รวบรวมยอดขายจากทุกสาขาและส่งสรุปให้ผู้จัดการ', 'todo', 5, [1, 2]],
  ['จัดซื้อกระดาษ A4 และอุปกรณ์สำนักงาน', 'ขอใบเสนอราคาอย่างน้อย 3 ร้านก่อนสั่งซื้อ', 'todo', 7, [3]],
  ['นัดประชุมทีมประจำสัปดาห์', 'จองห้องประชุมและส่งวาระให้ทุกคนล่วงหน้า', 'todo', 2, [2]],
  ['ตอบอีเมลลูกค้าที่ค้างอยู่', 'ไล่ตอบอีเมลที่ค้างเกิน 2 วันทำการ', 'todo', 1, [1]],
  ['ทำใบเสนอราคาให้บริษัทลูกค้ารายใหม่', 'ใช้แม่แบบเดิม ปรับราคาตามที่ตกลง', 'doing', 3, [1, 3]],
  ['อัปเดตข้อมูลสต็อกสินค้า', 'ตรวจนับของจริงเทียบกับในระบบ แล้วบันทึกส่วนต่าง', 'doing', 4, [3]],
  ['เตรียมเอกสารสำหรับตรวจบัญชีสิ้นไตรมาส', 'ใบกำกับภาษี ใบเสร็จ และรายงานค่าใช้จ่าย', 'doing', 10, [2, 3]],
  ['ตรวจร่างสัญญาเช่าพื้นที่คลังสินค้า', 'ตรวจเงื่อนไขค่าเช่าและระยะเวลาสัญญา', 'review', 2, [2]],
  ['ออกแบบโปสเตอร์โปรโมชันปลายปี', 'รอผู้จัดการตรวจสีและข้อความก่อนส่งพิมพ์', 'review', 6, [1]],
  ['จัดทำรายงานค่าใช้จ่ายเดือนที่แล้ว', 'แยกหมวดค่าเดินทาง ค่าวัสดุ และค่าสาธารณูปโภค', 'done', -3, [2, 1], 1],
  ['สำรองข้อมูลไฟล์งานของแผนก', 'คัดลอกไฟล์สำคัญขึ้นที่เก็บข้อมูลสำรอง', 'done', -5, [3], 2],
  ['ตอบแบบสอบถามความพึงพอใจลูกค้า', 'สรุปผลคะแนนและข้อเสนอแนะ 20 ราย', 'done', -2, [1], 3],
];

// Resolve demo config once at startup. Passwords come from env; if unset, random ones are generated and logged once.
function resolveConfig(env = process.env, log = console.log) {
  const resetHoursNum = Number(env.DEMO_RESET_HOURS);
  const resetHours = Number.isFinite(resetHoursNum) && resetHoursNum > 0 ? resetHoursNum : 6;
  const pw = {};
  for (const [key, envName] of [['manager', 'DEMO_MANAGER_PASSWORD'], ['staff', 'DEMO_STAFF_PASSWORD']]) {
    if (env[envName]) pw[key] = env[envName];
    else { pw[key] = crypto.randomBytes(6).toString('base64url'); log(`[demo] ${envName} not set, generated: ${pw[key]}`); }
  }
  const accounts = DEMO_USERS.map((u) => ({ username: u.username, role: u.role, password: pw[u.pwKey] }));
  return { resetHours, accounts };
}

// Wipe everything and insert fake data in ONE transaction. Sessions are deleted too, so everyone is logged out consistently.
function resetAndSeed(db, hashPassword, cfg, tzOffsetMin = 420, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const ago = (days, hours = 0) => new Date(nowMs - days * 864e5 - hours * 36e5).toISOString();
  const hashes = cfg.accounts.map((a) => hashPassword(a.password));   // before BEGIN: keep the transaction short
  db.exec('BEGIN');
  try {
    for (const t of ['activity_source', 'activity', 'task_history', 'task_members', 'tasks', 'sessions', 'invites', 'users']) db.exec(`DELETE FROM ${t}`);
    db.exec("DELETE FROM sqlite_sequence");
    const ids = DEMO_USERS.map((u, i) => Number(db.prepare('INSERT INTO users (username, name, role, pw_salt, pw_hash, created_at) VALUES (?,?,?,?,?,?)')
      .run(u.username, u.name, u.role, hashes[i].salt, hashes[i].hash, ago(30)).lastInsertRowid));
    const manager = 0;
    DEMO_TASKS.forEach(([title, desc, status, dl, members, doneAgo], n) => {
      const deadline = new Date(nowMs + dl * 864e5).toISOString().slice(0, 10);
      const created = ago(8 - (n % 6), n % 5);
      const doneAt = status === 'done' ? ago(doneAgo) : null;
      const id = Number(db.prepare('INSERT INTO tasks (title, description, deadline, status, created_by, created_at, updated_at, updated_by, done_at, done_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(title, desc, deadline, status, ids[manager], created, doneAt || created, ids[manager], doneAt, doneAt ? ids[manager] : null).lastInsertRowid);
      for (const m of members) db.prepare('INSERT INTO task_members (task_id, user_id) VALUES (?,?)').run(id, ids[m]);
      const hist = db.prepare('INSERT INTO task_history (task_id, user_id, user_name, at, action, detail) VALUES (?,?,?,?,?,?)');
      hist.run(id, ids[manager], DEMO_USERS[manager].name, created, 'create', JSON.stringify({ members: members.map((m) => DEMO_USERS[m].name).sort() }));
      if (status !== 'todo') hist.run(id, ids[members[0]], DEMO_USERS[members[0]].name, created, 'status', JSON.stringify({ from: 'todo', to: status === 'done' ? 'review' : status }));
      if (doneAt) hist.run(id, ids[manager], DEMO_USERS[manager].name, doneAt, 'status', JSON.stringify({ from: 'review', to: 'done' }));
    });
    // ~1 week of work: 09:00-12:00 and 13:00-17:30 local time, with small deterministic gaps
    const todayStart = Math.floor((Math.floor(nowMs / 60000) + tzOffsetMin) / 1440) * 1440 - tzOffsetMin;
    const act = db.prepare('INSERT OR IGNORE INTO activity (user_id, minute) VALUES (?,?)');
    const src = db.prepare("INSERT OR IGNORE INTO activity_source (user_id, minute, source) VALUES (?,?,'taskboard')");
    ids.forEach((uid, u) => {
      for (let d = 1; d <= 7; d++) {
        for (const [from, to] of [[540, 720], [780, 1050]]) {
          for (let m = from + (u + d) % 4 * 5; m < to - (u * d) % 7 * 4; m++) {
            if ((m * 7 + u + d) % 13 === 0) continue;
            act.run(uid, todayStart - d * 1440 + m); src.run(uid, todayStart - d * 1440 + m);
          }
        }
      }
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { at: nowIso };
}

module.exports = { DEMO_USERS, DEMO_TASKS, resolveConfig, resetAndSeed };
