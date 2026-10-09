'use strict';
(() => {
  // ---------- tiny helpers ----------
  const STATUS = [
    { key: 'todo', label: 'รอทำ' },
    { key: 'doing', label: 'กำลังทำ' },
    { key: 'review', label: 'รอตรวจ' },
    { key: 'done', label: 'เสร็จแล้ว' },
  ];
  const STATUS_LABEL = Object.fromEntries(STATUS.map((s) => [s.key, s.label]));
  const FIELD_LABEL = { title: 'ชื่องาน', description: 'รายละเอียด', deadline: 'วันที่ deadline', members: 'ผู้เกี่ยวข้อง' };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  let toastTimer;
  function toast(msg, isBad) {
    $toast.textContent = msg; $toast.className = 'show' + (isBad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $toast.className = ''; }, 3200);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'taskboard' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'เกิดข้อผิดพลาด'); err.status = res.status;
      if (res.status === 401 && state.me) { state.me = null; go('#/login'); }
      throw err;
    }
    return data;
  }

  const fmtDateTime = (iso) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDay = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function daysUntil(ymd) { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(); return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5); }
  const COLORS = ['#3b6fd1', '#c2562f', '#2f8f6b', '#8a56b8', '#b8860b', '#c0407a', '#2b8aa6', '#6b7a3a'];
  const colorFor = (id) => COLORS[id % COLORS.length];
  const initials = (name) => { const p = name.trim().split(/\s+/); return (p[0][0] + (p[1] ? p[1][0] : (p[0][1] || ''))).toUpperCase(); };
  function avatar(user) { const a = h('span', { class: 'av', title: user.name, text: initials(user.name) }); a.style.setProperty('--c', colorFor(user.id)); return a; }

  function deadlineChip(task) {
    if (!task.deadline) return h('span', { class: 'chip', text: 'ไม่กำหนดวัน' });
    const label = fmtDay(task.deadline);
    if (task.status === 'done') return h('span', { class: 'chip ok', text: '📅 ' + label });
    const d = daysUntil(task.deadline);
    if (d < 0) return h('span', { class: 'chip late', text: `⚠ เลยกำหนด ${-d} วัน · ${label}` });
    if (d <= 2) return h('span', { class: 'chip soon', text: `⏰ ${d === 0 ? 'วันนี้' : 'อีก ' + d + ' วัน'} · ${label}` });
    return h('span', { class: 'chip', text: '📅 ' + label });
  }


  // ---------- work-hour tracker ----------
  // Sends a heartbeat every 30s while the tab is visible and the user touched the mouse/keyboard/screen in the last 2 minutes.
  const IDLE_MS = 120_000, BEAT_MS = 30_000;
  const fmtHM = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  const tracker = {
    chip: h('span', { class: 'chip-hours hidden', title: 'เวลาที่ใช้งาน TaskBoard วันนี้ (นับเฉพาะตอนที่มีการใช้งานจริง)' }),
    last: 0, timer: null, running: false,
    bump() { const idle = Date.now() - tracker.last > IDLE_MS; tracker.last = Date.now(); if (idle && tracker.running) tracker.beat(); },
    async beat() {
      if (!state.me || document.visibilityState !== 'visible' || Date.now() - tracker.last > IDLE_MS) return;
      try {
        const r = await api('POST', '/api/activity', {});
        tracker.chip.textContent = `วันนี้ ${fmtHM(r.today_minutes)} ชม.`; tracker.chip.classList.remove('hidden');
      } catch { /* ignore: next beat retries */ }
    },
    start() {
      if (tracker.running) return; tracker.running = true; tracker.last = Date.now();
      for (const ev of ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart']) window.addEventListener(ev, tracker.throttledBump, { passive: true, capture: true });
      tracker.timer = setInterval(tracker.beat, BEAT_MS); tracker.beat();
    },
    stop() {
      tracker.running = false; clearInterval(tracker.timer); tracker.chip.classList.add('hidden');
      for (const ev of ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart']) window.removeEventListener(ev, tracker.throttledBump, { capture: true });
    },
  };
  let lastBumpCall = 0;
  tracker.throttledBump = () => { const t = Date.now(); if (t - lastBumpCall > 1000) { lastBumpCall = t; tracker.bump(); } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && tracker.running) tracker.beat(); });

  function ensureTracking() { if (state.me) tracker.start(); else tracker.stop(); }

  // ---------- state & routing ----------
  const state = { me: null, users: [], boardUser: null };
  const isManager = () => state.me && state.me.role === 'manager';
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/board';
    const [pathPart, query = ''] = raw.split('?');
    return { parts: pathPart.split('/').filter(Boolean), query: new URLSearchParams(query) };
  }

  const demoBanner = (demo) => h('div', { class: 'demo-banner', role: 'note', text: `เดโมสำหรับทดลอง ข้อมูลเป็นข้อมูลสมมติ รีเซ็ตทุก ${demo.resetHours} ชั่วโมง อย่ากรอกข้อมูลจริง` });

  async function boot() {
    try { const st = await api('GET', '/api/state'); if (st.demo) $app.before(demoBanner(st.demo)); } catch { /* banner is optional */ }
    try { state.me = (await api('GET', '/api/me')).user; } catch { state.me = null; }
    window.addEventListener('hashchange', render);
    render();
  }

  async function render() {
    closeModal();
    const { parts, query } = parseHash();
    const page = parts[0] || 'board';
    if (!state.me) {
      if (page === 'register') return viewRegister(query.get('code') || '');
      return viewLogin();
    }
    if (page === 'login' || page === 'register') return go('#/board');
    const manager = isManager();
    try {
      if (page === 'board') return await viewBoard(parts[1]);
      if (page === 'done') return await viewDone();
      if (page === 'hours') return await viewHours();
      if (page === 'team' && manager) return await viewTeam();
      if (page === 'users' && manager) return await viewUsers();
      go('#/board');
    } catch (e) { toast(e.message, true); } finally { ensureTracking(); }
  }

  // ---------- layout ----------
  function shell(active, content) {
    const link = (href, key, text) => h('a', { href, class: active === key ? 'on' : '' , text });
    const nav = h('nav', { class: 'nav', 'aria-label': 'เมนูหลัก' },
      link('#/board', 'board', 'งานของฉัน'),
      isManager() && link('#/team', 'team', 'ภาพรวมทีม'),
      isManager() && link('#/board/all', 'all', 'งานทั้งหมด'),
      link('#/done', 'done', 'งานที่เสร็จแล้ว'),
      link('#/hours', 'hours', isManager() ? 'ชั่วโมงทำงาน' : 'ชั่วโมงของฉัน'),
      isManager() && link('#/users', 'users', 'จัดการผู้ใช้'));
    const who = h('div', { class: 'who' }, tracker.chip, avatar(state.me),
      h('div', {}, state.me.name, h('small', { text: isManager() ? 'ผู้จัดการ' : 'พนักงาน' })),
      h('button', { class: 'linkbtn', onclick: async () => { tracker.stop(); try { await api('POST', '/api/logout', {}); } catch { /* ignore */ } state.me = null; go('#/login'); }, text: 'ออกจากระบบ' }));
    $app.replaceChildren(
      h('header', { class: 'top' }, h('div', { class: 'brand' }, h('i'), 'TaskBoard'), nav, who),
      h('main', {}, content));
  }

  // ---------- auth views ----------
  function authShell(title, ...body) {
    $app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'brand' }, h('i'), 'TaskBoard'), h('div', { class: 'card' }, h('h1', { text: title }), ...body)));
  }
  function field(label, input) { return h('label', { class: 'f' }, h('span', { text: label }), input); }

  async function viewLogin() {
    let st = { setupNeeded: false };
    try { st = await api('GET', '/api/state'); } catch { /* ignore */ }
    const err = h('p', { class: 'err', role: 'alert' });
    const user = h('input', { type: 'text', autocomplete: 'username', required: true, autocapitalize: 'off' });
    const pass = h('input', { type: 'password', autocomplete: st.setupNeeded ? 'new-password' : 'current-password', required: true });
    const nameIn = st.setupNeeded ? h('input', { type: 'text', required: true, maxlength: '80' }) : null;
    const keyIn = st.setupNeeded && st.setupKeyRequired ? h('input', { type: 'password', required: true }) : null;
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try {
          const r = st.setupNeeded
            ? await api('POST', '/api/setup', { username: user.value, name: nameIn.value, password: pass.value, setup_key: keyIn ? keyIn.value : undefined })
            : await api('POST', '/api/login', { username: user.value, password: pass.value });
          state.me = r.user; go('#/board');
        } catch (ex) { err.textContent = ex.message; }
      },
    },
      st.setupNeeded && h('p', { class: 'note', text: 'ยังไม่มีผู้ใช้ในระบบ บัญชีนี้จะเป็นผู้จัดการคนแรก' }),
      field('ชื่อผู้ใช้', user), nameIn && field('ชื่อที่แสดง', nameIn), keyIn && field('รหัสตั้งค่าระบบ (SETUP_KEY)', keyIn),
      field(st.setupNeeded ? 'รหัสผ่าน (อย่างน้อย 8 ตัว)' : 'รหัสผ่าน', pass), err,
      h('button', { class: 'btn', type: 'submit', style: null, text: st.setupNeeded ? 'สร้างบัญชีผู้จัดการ' : 'เข้าสู่ระบบ' }));
    form.querySelector('button').style.width = '100%';
    authShell(st.setupNeeded ? 'ตั้งค่าครั้งแรก' : 'เข้าสู่ระบบ', form,
      st.demo && h('div', { class: 'demo-hint' }, h('b', { text: 'บัญชีสำหรับทดลอง' }),
        ...st.demo.accounts.map((a) => h('div', {}, `${a.role === 'manager' ? 'ผู้จัดการ' : 'พนักงาน'}: `, h('code', { text: a.username }), ' / ', h('code', { text: a.password })))),
      !st.setupNeeded && h('p', { class: 'alt' }, 'มีรหัสเชิญจากผู้จัดการ? ', h('a', { href: '#/register', text: 'สมัครสมาชิก' })));
    user.focus();
  }

  function viewRegister(code) {
    const err = h('p', { class: 'err', role: 'alert' });
    const f = { code: h('input', { type: 'text', required: true, value: code, autocapitalize: 'characters' }), user: h('input', { type: 'text', required: true, autocapitalize: 'off', autocomplete: 'username' }),
      name: h('input', { type: 'text', required: true, maxlength: '80', autocomplete: 'name' }), pass: h('input', { type: 'password', required: true, autocomplete: 'new-password' }) };
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try { state.me = (await api('POST', '/api/register', { invite_code: f.code.value, username: f.user.value, name: f.name.value, password: f.pass.value })).user; go('#/board'); }
        catch (ex) { err.textContent = ex.message; }
      },
    }, h('p', { class: 'note', text: 'การสมัครต้องใช้รหัสเชิญที่ผู้จัดการสร้างให้ (ใช้ได้ครั้งเดียว)' }), h('br'),
    field('รหัสเชิญ', f.code), field('ชื่อผู้ใช้ (a-z 0-9 . _ -)', f.user), field('ชื่อที่แสดง', f.name), field('รหัสผ่าน (อย่างน้อย 8 ตัว)', f.pass), err,
    h('button', { class: 'btn', type: 'submit', text: 'สมัครสมาชิก' }));
    form.querySelector('button').style.width = '100%';
    authShell('สมัครสมาชิก', form, h('p', { class: 'alt' }, 'มีบัญชีแล้ว? ', h('a', { href: '#/login', text: 'เข้าสู่ระบบ' })));
  }

  // ---------- modal ----------
  let closeFn = null;
  function closeModal() { const m = document.querySelector('.scrim'); if (m) m.remove(); document.removeEventListener('keydown', onEsc); if (closeFn) { const f = closeFn; closeFn = null; f(); } }
  function onEsc(e) { if (e.key === 'Escape') closeModal(); }
  function openModal(title, body, footer, onClose) {
    closeModal();
    const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim) closeModal(); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('header', {}, h('h2', { text: title }), h('button', { class: 'x', 'aria-label': 'ปิด', onclick: closeModal, text: '×' })),
        h('div', { class: 'body' }, body), footer && h('footer', {}, footer)));
    document.body.append(scrim); closeFn = onClose || null;
    document.addEventListener('keydown', onEsc);
    const first = scrim.querySelector('input, textarea, select'); if (first) first.focus();
    return scrim;
  }

  // ---------- task modal ----------
  function describeChange(hist) {
    const d = hist.detail || {};
    const quote = (v) => (v == null || v === '' ? '(ว่าง)' : String(v).length > 80 ? String(v).slice(0, 80) + '…' : String(v));
    if (hist.action === 'create') return h('span', {}, 'สร้างงาน', d.members ? ' · ผู้เกี่ยวข้อง: ' + d.members.join(', ') : '');
    if (hist.action === 'status') return h('span', {}, 'เปลี่ยนสถานะ ', h('del', { text: STATUS_LABEL[d.from] }), ' → ', h('ins', { text: STATUS_LABEL[d.to] }));
    const label = FIELD_LABEL[d.field] || d.field;
    const fmt = d.field === 'deadline' ? (v) => (v ? fmtDay(v) : '(ไม่กำหนด)') : d.field === 'members' ? (v) => v.join(', ') : quote;
    return h('span', {}, `แก้${label} `, h('del', { text: fmt(d.from) }), ' → ', h('ins', { text: fmt(d.to) }));
  }

  async function openTask(id, opts = {}) {
    let task = null;
    if (id) task = (await api('GET', `/api/tasks/${id}`)).task;
    const manager = isManager();
    const locked = !manager && task && task.status === 'done';
    if (manager && !state.users.length) state.users = (await api('GET', '/api/users')).users;
    const err = h('p', { class: 'err', role: 'alert' });
    const title = h('input', { type: 'text', maxlength: '200', required: true, value: task ? task.title : '', disabled: locked });
    const desc = h('textarea', { maxlength: '5000', disabled: locked }); desc.value = task ? task.description : '';
    const deadline = h('input', { type: 'date', value: task && task.deadline ? task.deadline : '', disabled: locked });
    const statusOptions = STATUS.filter((s) => manager || s.key !== 'done' || (task && task.status === 'done'));
    const status = h('select', { disabled: locked || !task }, statusOptions.map((s) => h('option', { value: s.key, selected: (task ? task.status : 'todo') === s.key, text: s.label })));
    const selected = new Set(task ? task.members.map((m) => m.id) : (opts.members || []));
    let membersBox;
    if (manager) {
      membersBox = h('div', { class: 'pick' }, state.users.filter((u) => u.active || selected.has(u.id)).map((u) => {
        const cb = h('input', { type: 'checkbox', checked: selected.has(u.id), onchange: () => { cb.checked ? selected.add(u.id) : selected.delete(u.id); } });
        return h('label', {}, cb, avatar(u), u.name);
      }));
    } else if (task) {
      membersBox = h('div', { class: 'pick' }, task.members.map((m) => h('label', {}, avatar(m), m.name)));
    } else membersBox = h('p', { class: 'sub', text: 'งานที่คุณสร้างจะเป็นงานของคุณ ผู้จัดการสามารถเพิ่มคนอื่นให้ได้ภายหลัง' });

    const save = h('button', {
      class: 'btn', type: 'button', disabled: locked, text: task ? 'บันทึก' : 'สร้างงาน',
      onclick: async () => {
        err.textContent = ''; save.disabled = true;
        try {
          const payload = { title: title.value, description: desc.value, deadline: deadline.value || null };
          if (manager) payload.members = [...selected];
          if (task) { payload.status = status.value; payload.base_updated_at = task.updated_at; await api('PATCH', `/api/tasks/${task.id}`, payload); }
          else await api('POST', '/api/tasks', payload);
          closeModal(); toast('บันทึกแล้ว'); render();
        } catch (e) { err.textContent = e.message; save.disabled = false; }
      },
    });
    const footer = [save, h('button', { class: 'btn ghost', type: 'button', onclick: closeModal, text: 'ยกเลิก' }), h('span', { class: 'grow' })];
    if (task && manager) footer.push(h('button', { class: 'btn danger', type: 'button', text: 'ลบงาน', onclick: async () => {
      if (!confirm(`ลบงาน "${task.title}" ถาวร? ประวัติการแก้ไขจะหายไปด้วย`)) return;
      try { await api('DELETE', `/api/tasks/${task.id}`); closeModal(); toast('ลบงานแล้ว'); render(); } catch (e) { err.textContent = e.message; }
    } }));

    const body = [];
    if (task) {
      body.push(h('p', { class: 'audit' }, `สร้างโดย ${task.created_by_name} เมื่อ ${fmtDateTime(task.created_at)}`, h('br'),
        `แก้ไขล่าสุดโดย ${task.updated_by_name || task.created_by_name} เมื่อ ${fmtDateTime(task.updated_at)}`,
        task.status === 'done' && task.done_at ? h('span', {}, h('br'), `ปิดงานโดย ${task.done_by_name || '-'} เมื่อ ${fmtDateTime(task.done_at)}`) : null));
      if (locked) body.push(h('p', { class: 'note', text: 'งานนี้เสร็จแล้ว แก้ไขได้เฉพาะผู้จัดการ' }), h('br'));
    }
    body.push(field('ชื่องาน', title), field('รายละเอียดงาน', desc),
      h('div', { class: 'row' }, field('Deadline', deadline), task ? field('สถานะ', status) : null),
      h('div', { class: 'f' }, h('span', { class: 'sub', text: 'ใครเกี่ยวข้องกับงานนี้' }), membersBox), err);
    if (task) {
      body.push(h('h2', { text: 'ประวัติการแก้ไข' }), h('ul', { class: 'hist' }, task.history.map((x) =>
        h('li', {}, h('b', { text: x.user_name }), ' ', describeChange(x), h('time', { datetime: x.at, text: fmtDateTime(x.at) })))));
    }
    openModal(task ? 'รายละเอียดงาน' : 'เพิ่มงานใหม่', body, footer);
  }

  async function moveTask(task, to) {
    try { await api('PATCH', `/api/tasks/${task.id}`, { status: to }); toast(`ย้ายไป "${STATUS_LABEL[to]}"`); } catch (e) { toast(e.message, true); }
    render();
  }

  // ---------- board ----------
  const byDeadline = (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.id - b.id;

  function taskCard(task, canMoveTo) {
    const card = h('div', { class: 'tcard', role: 'button', tabindex: '0', draggable: 'true', 'data-id': task.id,
      onclick: (e) => { if (!e.target.closest('.mv')) openTask(task.id).catch((x) => toast(x.message, true)); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === card) openTask(task.id).catch((x) => toast(x.message, true)); },
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(task.id)); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); },
      ondragend: () => card.classList.remove('dragging'),
    },
    h('h3', { text: task.title }),
    h('div', { class: 'meta' }, deadlineChip(task), h('div', { class: 'avatars' }, task.members.slice(0, 4).map(avatar), task.members.length > 4 ? h('span', { class: 'av', text: '+' + (task.members.length - 4) }) : null)));
    const idx = STATUS.findIndex((s) => s.key === task.status);
    const prev = STATUS[idx - 1], next = STATUS[idx + 1];
    const movers = h('div', { class: 'movers' });
    if (prev && canMoveTo(task, prev.key)) movers.append(h('button', { class: 'mv', type: 'button', onclick: () => moveTask(task, prev.key), 'aria-label': `ย้ายไป ${prev.label}`, text: '‹ ' + prev.label }));
    if (next && canMoveTo(task, next.key)) movers.append(h('button', { class: 'mv', type: 'button', onclick: () => moveTask(task, next.key), 'aria-label': `ย้ายไป ${next.label}`, text: next.label + ' ›' }));
    if (movers.children.length) card.append(movers);
    return card;
  }

  async function viewBoard(which) {
    const manager = isManager();
    if (which && !manager) return go('#/board');
    const target = which === 'all' ? 'all' : which ? Number(which) : state.me.id;
    if (manager && !state.users.length) state.users = (await api('GET', '/api/users')).users;
    const { tasks } = await api('GET', `/api/tasks?scope=board&user=${target}`);
    const owner = typeof target === 'number' ? state.users.find((u) => u.id === target) || state.me : null;
    const canMoveTo = (task, to) => manager || (to !== 'done' && task.status !== 'done');
    const cols = STATUS.map((s) => {
      const list = tasks.filter((t) => t.status === s.key).sort(byDeadline);
      const col = h('section', { class: 'col', 'data-s': s.key, 'aria-label': s.label,
        ondragover: (e) => { if (canMoveTo({ status: 'x' }, s.key)) { e.preventDefault(); col.classList.add('over'); } },
        ondragleave: (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); },
        ondrop: (e) => {
          e.preventDefault(); col.classList.remove('over');
          const task = tasks.find((t) => t.id === Number(e.dataTransfer.getData('text/plain')));
          if (task && task.status !== s.key) moveTask(task, s.key);
        } },
      h('div', { class: 'colhead' }, h('span', { text: s.label }), h('span', { class: 'count', text: list.length })),
      h('div', { class: 'cards' }, list.length ? list.map((t) => taskCard(t, canMoveTo)) : h('p', { class: 'empty', text: 'ไม่มีงาน' })));
      if (s.key === 'done') col.append(h('p', { class: 'sub', text: 'แสดงงานที่เสร็จใน 7 วันล่าสุด · ดูทั้งหมดที่ "งานที่เสร็จแล้ว"' }));
      if (s.key === 'todo') col.append(h('button', { class: 'addbtn', type: 'button', text: '+ เพิ่มงาน', onclick: () => openTask(null, { members: owner ? [owner.id] : [] }).catch((x) => toast(x.message, true)) }));
      return col;
    });
    const title = which === 'all' ? 'งานทั้งหมดของทีม' : owner && owner.id !== state.me.id ? `งานของ ${owner.name}` : 'งานของฉัน';
    const head = h('div', { class: 'pagehead' }, h('h1', { text: title }),
      !manager && h('span', { class: 'sub', text: 'ลากการ์ดหรือกดปุ่มเพื่อย้ายสถานะ · งานที่ทำเสร็จให้ย้ายไป "รอตรวจ" ผู้จัดการจะเป็นคนปิดงาน' }),
      h('span', { class: 'grow' }),
      manager && personFilter(target, (v) => go(v === state.me.id ? '#/board' : `#/board/${v}`)),
      h('button', { class: 'btn', type: 'button', text: '+ เพิ่มงาน', onclick: () => openTask(null, { members: owner ? [owner.id] : [] }).catch((x) => toast(x.message, true)) }));
    shell(which === 'all' ? 'all' : (!which || target === state.me.id) ? 'board' : 'team', [head, h('div', { class: 'board' }, cols)]);
  }

  function personFilter(selected, onChange, { includeAll = true } = {}) {
    const sel = h('select', { 'aria-label': 'เลือกพนักงาน', onchange: () => onChange(sel.value === 'all' ? 'all' : Number(sel.value)) },
      includeAll && h('option', { value: 'all', selected: selected === 'all', text: 'ทุกคน' }),
      state.users.filter((u) => u.active).map((u) => h('option', { value: u.id, selected: selected === u.id, text: u.name + (u.id === state.me.id ? ' (ฉัน)' : '') })));
    sel.style.width = 'auto'; sel.style.minWidth = '190px';
    return sel;
  }

  // ---------- team overview (manager) ----------
  async function viewTeam() {
    state.users = (await api('GET', '/api/users')).users;
    const { tasks } = await api('GET', '/api/tasks?scope=board&user=all');
    const open = tasks.filter((t) => t.status !== 'done');
    const overdue = open.filter((t) => t.deadline && daysUntil(t.deadline) < 0);
    const review = tasks.filter((t) => t.status === 'review');
    const stats = h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', { text: open.length }), h('span', { text: 'งานที่ยังไม่เสร็จ' })),
      h('div', { class: 'stat' + (review.length ? ' warn' : '') }, h('b', { text: review.length }), h('span', { text: 'รอผู้จัดการตรวจ' })),
      h('div', { class: 'stat' + (overdue.length ? ' warn' : '') }, h('b', { text: overdue.length }), h('span', { text: 'เลยกำหนด' })),
      h('div', { class: 'stat' }, h('b', { text: tasks.filter((t) => t.status === 'done').length }), h('span', { text: 'เสร็จใน 7 วันล่าสุด' })));

    const reviewPanel = h('div', { class: 'panel' }, h('h2', { text: 'งานรอตรวจ' }),
      review.length ? review.sort(byDeadline).map((t) => h('div', { class: 'line' },
        h('div', { class: 'grow' }, h('b', { text: t.title }), h('div', { class: 'sub', text: 'โดย ' + (t.members.map((m) => m.name).join(', ') || '-') })),
        deadlineChip(t), h('button', { class: 'btn ghost small', type: 'button', text: 'เปิดดู', onclick: () => openTask(t.id).catch((x) => toast(x.message, true)) }),
        h('button', { class: 'btn small', type: 'button', text: '✓ ปิดงาน', onclick: () => moveTask(t, 'done') }),
        h('button', { class: 'btn ghost small', type: 'button', text: '↩ ส่งกลับไปทำต่อ', onclick: () => moveTask(t, 'doing') })))
        : h('p', { class: 'sub', text: 'ไม่มีงานรอตรวจ' }));

    const people = h('div', { class: 'people' }, state.users.filter((u) => u.active).map((u) => {
      const mine = tasks.filter((t) => t.members.some((m) => m.id === u.id));
      const c = Object.fromEntries(STATUS.map((s) => [s.key, mine.filter((t) => t.status === s.key).length]));
      const late = mine.filter((t) => t.status !== 'done' && t.deadline && daysUntil(t.deadline) < 0).length;
      const total = mine.length || 1;
      const a = h('a', { class: 'person', href: `#/board/${u.id}` },
        h('header', {}, avatar(u), h('div', {}, h('h3', { text: u.name }), h('span', { class: 'tag' + (u.role === 'manager' ? ' mgr' : ''), text: u.role === 'manager' ? 'ผู้จัดการ' : 'พนักงาน' }))),
        h('div', { class: 'bar', 'aria-hidden': 'true' }, STATUS.map((s) => { const i = h('i', { class: 'b-' + s.key }); i.style.width = (c[s.key] / total * 100) + '%'; return i; })),
        h('div', { class: 'counts' }, STATUS.map((s) => h('span', {}, s.label + ' ', h('b', { text: c[s.key] }))), late ? h('span', { class: 'chip late', text: `เลยกำหนด ${late}` }) : null));
      return a;
    }));
    shell('team', [h('div', { class: 'pagehead' }, h('h1', { text: 'ภาพรวมทีม' }), h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', text: '+ มอบหมายงานใหม่', onclick: () => openTask(null).catch((x) => toast(x.message, true)) })),
      stats, reviewPanel, h('h2', { text: 'พนักงานแต่ละคน (กดเพื่อดู/จัดการบอร์ดของคนนั้น)' }), people]);
  }

  // ---------- done archive ----------
  async function viewDone() {
    const manager = isManager();
    if (manager && !state.users.length) state.users = (await api('GET', '/api/users')).users;
    let filter = 'all', q = '';
    const tbody = h('tbody');
    let tasks = [];
    const paint = () => {
      const rows = tasks.filter((t) => !q || (t.title + ' ' + t.description).toLowerCase().includes(q.toLowerCase()));
      tbody.replaceChildren(...(rows.length ? rows.map((t) => h('tr', { class: 'click', tabindex: '0', onclick: () => openTask(t.id).catch((x) => toast(x.message, true)),
        onkeydown: (e) => { if (e.key === 'Enter') openTask(t.id).catch((x) => toast(x.message, true)); } },
      h('td', {}, h('b', { text: t.title })), h('td', {}, h('div', { class: 'avatars' }, t.members.map(avatar))),
      h('td', { text: t.deadline ? fmtDay(t.deadline) : '-' }), h('td', { text: t.done_at ? fmtDateTime(t.done_at) : '-' }), h('td', { text: t.done_by_name || '-' })))
        : [h('tr', {}, h('td', { colspan: '5', class: 'empty', text: 'ยังไม่มีงานที่เสร็จแล้ว' }))]));
    };
    const load = async () => { tasks = (await api('GET', `/api/tasks?scope=done&user=${filter}`)).tasks; paint(); };
    const search = h('input', { type: 'search', placeholder: 'ค้นหาชื่อหรือรายละเอียดงาน', 'aria-label': 'ค้นหางาน', oninput: () => { q = search.value; paint(); } });
    const filters = h('div', { class: 'filters' }, search, manager && personFilter('all', (v) => { filter = v; load().catch((x) => toast(x.message, true)); }));
    shell('done', [h('div', { class: 'pagehead' }, h('h1', { text: 'กระดานงานที่เสร็จแล้ว' }), h('span', { class: 'sub', text: 'เรียงตามวันที่ปิดงานล่าสุด' })), filters,
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['ชื่องาน', 'ผู้เกี่ยวข้อง', 'Deadline', 'ปิดงานเมื่อ', 'ปิดโดย'].map((x) => h('th', { text: x })))), tbody))]);
    await load();
  }


  // ---------- work hours report ----------
  const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const dayShort = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' }); };
  let hoursTz = 420;   // server's day-cutting offset, so shown times match the day columns
  const fmtTime = (iso) => new Date(new Date(iso).getTime() + hoursTz * 60000).toISOString().slice(11, 16);
  const srcLabel = (k) => (k === 'taskboard' ? 'TaskBoard' : k.toUpperCase());
  const srcText = (u) => Object.entries(u.by_source).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${srcLabel(k)} ${fmtHM(v)}`).join(' · ');
  const hoursText = (min) => `${Math.floor(min / 60)} ชม. ${min % 60} น.`;

  async function viewHours(offsetWeeks = 0, pickId = null) {
    const start = mondayOf(new Date()); start.setDate(start.getDate() + offsetWeeks * 7);
    const from = ymdOf(start);
    const data = await api('GET', `/api/hours?from=${from}&days=7`);
    hoursTz = data.tz_offset_min;
    const manager = isManager();
    let picked = pickId != null ? data.users.find((u) => u.id === pickId) : (manager ? null : data.users[0]);
    const maxDay = Math.max(480, ...data.users.flatMap((u) => u.days.map((d) => d.minutes)));
    const end = data.dates[6];
    const nav = h('div', { class: 'pagehead' }, h('h1', { text: manager ? 'ชั่วโมงทำงานของทีม' : 'ชั่วโมงของฉัน' }), h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost small', type: 'button', text: '‹ สัปดาห์ก่อน', onclick: () => viewHours(offsetWeeks - 1, picked && picked.id) }),
      h('b', { text: `${fmtDay(from)} – ${fmtDay(end)}` }),
      h('button', { class: 'btn ghost small', type: 'button', text: 'สัปดาห์ถัดไป ›', disabled: offsetWeeks >= 0, onclick: () => viewHours(offsetWeeks + 1, picked && picked.id) }),
      offsetWeeks !== 0 && h('button', { class: 'btn small', type: 'button', text: 'สัปดาห์นี้', onclick: () => viewHours(0, picked && picked.id) }));
    const rows = data.users.map((u) => {
      const tr = h('tr', { class: manager ? 'click' : '', tabindex: manager ? '0' : null, 'aria-selected': picked && picked.id === u.id ? 'true' : null,
        onclick: manager ? () => viewHours(offsetWeeks, u.id) : null, onkeydown: manager ? (e) => { if (e.key === 'Enter') viewHours(offsetWeeks, u.id); } : null },
      h('td', {}, h('div', { class: 'who2' }, avatar(u), h('div', {}, h('b', { text: u.name }), Object.keys(u.by_source).length > 1 || (Object.keys(u.by_source)[0] || 'taskboard') !== 'taskboard' ? h('div', { class: 'sub', text: srcText(u) }) : null))),
      u.days.map((d) => { const cell = h('td', { class: 'hc' }, h('span', { text: d.minutes ? fmtHM(d.minutes) : '–' }));
        if (d.minutes) { const bar = h('i', { class: 'hbar' }); bar.style.width = Math.min(100, d.minutes / maxDay * 100) + '%'; cell.append(h('div', { class: 'hbarwrap' }, bar)); } return cell; }),
      h('td', { class: 'hc tot' }, h('b', { text: fmtHM(u.total_minutes) })));
      if (picked && picked.id === u.id) tr.classList.add('sel');
      return tr;
    });
    const table = h('div', { class: 'tablewrap' }, h('table', { class: 'hours' }, h('thead', {}, h('tr', {}, h('th', { text: 'พนักงาน' }), data.dates.map((d) => h('th', { class: 'hc', text: dayShort(d) })), h('th', { class: 'hc', text: 'รวม (ชม:นาที)' }))), h('tbody', {}, rows)));
    let detail = null;
    if (picked) {
      detail = h('div', { class: 'panel' }, h('h2', { text: `รายละเอียด: ${picked.name}` }),
        Object.keys(picked.by_source).length ? h('p', { class: 'sub', text: `แยกตามระบบ: ${srcText(picked)} (ชั่วโมงรวมไม่นับเวลาที่ใช้หลายระบบพร้อมกันซ้ำ)` }) : null,
        picked.days.map((d) => h('div', { class: 'line' }, h('div', { class: 'daycol' }, h('b', { text: dayShort(d.date) }), h('div', { class: 'sub', text: d.minutes ? hoursText(d.minutes) : 'ไม่มีการใช้งาน' })),
          h('div', { class: 'grow blocks' }, d.blocks.length ? d.blocks.map((b) => h('span', { class: 'chip', title: hoursText(b.minutes), text: `${fmtTime(b.start)}–${fmtTime(b.end)}` })) : null),
          d.first ? h('span', { class: 'sub', text: `เริ่ม ${fmtTime(d.first)} · ล่าสุด ${fmtTime(d.last)}` }) : null)));
    }
    const totalAll = data.users.reduce((a, u) => a + u.total_minutes, 0);
    shell('hours', [nav,
      h('p', { class: 'note', text: 'นับเฉพาะเวลาที่เปิด TaskBoard อยู่หน้าจอและมีการใช้งานจริง (เมาส์ คีย์บอร์ด หรือสัมผัส ห่างกันไม่เกิน 2 นาที) งานที่ทำนอกแอปนี้ เช่น ประชุมหรือโปรแกรมอื่น ไม่ถูกนับ ดังนั้นตัวเลขนี้เป็นเวลาใช้งานในแอป ไม่ใช่เวลาเข้า-ออกงาน' }),
      h('br'), table,
      manager && h('p', { class: 'sub', text: `รวมทั้งทีมในสัปดาห์ที่เลือก ${hoursText(totalAll)} · กดที่ชื่อพนักงานเพื่อดูช่วงเวลาแต่ละวัน` }),
      detail]);
  }

  // ---------- user management (manager) ----------
  async function viewUsers() {
    const [{ users }, { invites }] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/invites')]);
    state.users = users;
    const reload = () => render();

    const err = h('p', { class: 'err', role: 'alert' });
    const f = { user: h('input', { type: 'text', required: true, autocapitalize: 'off', autocomplete: 'off' }), name: h('input', { type: 'text', required: true, maxlength: '80' }),
      role: h('select', {}, h('option', { value: 'staff', text: 'พนักงาน' }), h('option', { value: 'manager', text: 'ผู้จัดการ' })), pass: h('input', { type: 'password', required: true, autocomplete: 'new-password' }) };
    const create = h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await api('POST', '/api/users', { username: f.user.value, name: f.name.value, role: f.role.value, password: f.pass.value }); toast('สร้างบัญชีแล้ว'); reload(); } catch (ex) { err.textContent = ex.message; }
    } }, h('h2', { text: 'สร้างบัญชีผู้ใช้' }),
    h('div', { class: 'row' }, field('ชื่อผู้ใช้', f.user), field('ชื่อที่แสดง', f.name), field('ตำแหน่ง', f.role), field('รหัสผ่านเริ่มต้น', f.pass)), err,
    h('button', { class: 'btn', type: 'submit', text: 'สร้างบัญชี' }));

    const patch = async (u, body, msg) => { try { await api('PATCH', `/api/users/${u.id}`, body); toast(msg); } catch (e) { toast(e.message, true); } reload(); };
    const resetPw = (u) => {
      const pe = h('p', { class: 'err', role: 'alert' }); const pw = h('input', { type: 'password', autocomplete: 'new-password' });
      openModal('ตั้งรหัสผ่านใหม่: ' + u.name, [field('รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)', pw), h('p', { class: 'sub', text: 'ผู้ใช้จะถูกออกจากระบบทุกอุปกรณ์' }), pe],
        [h('button', { class: 'btn', type: 'button', text: 'บันทึก', onclick: async () => { try { await api('PATCH', `/api/users/${u.id}`, { password: pw.value }); closeModal(); toast('เปลี่ยนรหัสผ่านแล้ว'); } catch (e) { pe.textContent = e.message; } } }),
          h('button', { class: 'btn ghost', type: 'button', text: 'ยกเลิก', onclick: closeModal })]);
    };
    const rows = users.map((u) => {
      const role = h('select', { 'aria-label': 'ตำแหน่ง ' + u.name, onchange: () => patch(u, { role: role.value }, 'เปลี่ยนตำแหน่งแล้ว (ผู้ใช้ต้องเข้าสู่ระบบใหม่)') },
        h('option', { value: 'staff', selected: u.role === 'staff', text: 'พนักงาน' }), h('option', { value: 'manager', selected: u.role === 'manager', text: 'ผู้จัดการ' }));
      role.style.width = 'auto';
      return h('tr', {}, h('td', {}, h('b', { text: u.name }), h('div', { class: 'sub', text: '@' + u.username })), h('td', {}, role),
        h('td', {}, h('span', { class: 'tag' + (u.active ? '' : ' off'), text: u.active ? 'ใช้งานอยู่' : 'ปิดใช้งาน' })),
        h('td', { text: fmtDateTime(u.created_at) }),
        h('td', {}, h('button', { class: 'btn ghost small', type: 'button', text: 'ตั้งรหัสผ่านใหม่', onclick: () => resetPw(u) }),
          h('button', { class: 'btn ghost small', type: 'button', text: u.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน', onclick: () => patch(u, { active: !u.active }, u.active ? 'ปิดใช้งานแล้ว' : 'เปิดใช้งานแล้ว') })));
    });

    const invRole = h('select', { 'aria-label': 'ตำแหน่งของรหัสเชิญ' }, h('option', { value: 'staff', text: 'พนักงาน' }), h('option', { value: 'manager', text: 'ผู้จัดการ' }));
    invRole.style.width = 'auto';
    const invRows = invites.map((i) => {
      const used = !!i.used_by, expired = !used && i.expires_at < new Date().toISOString();
      const link = `${location.origin}/#/register?code=${i.code}`;
      return h('div', { class: 'line' }, h('code', { class: 'inv', text: i.code }), h('span', { class: 'tag' + (i.role === 'manager' ? ' mgr' : ''), text: i.role === 'manager' ? 'ผู้จัดการ' : 'พนักงาน' }),
        h('span', { class: 'sub grow', text: used ? `ใช้แล้วโดย ${i.used_by_name}` : expired ? 'หมดอายุแล้ว' : `ใช้ได้ถึง ${fmtDateTime(i.expires_at)}` }),
        !used && !expired && h('button', { class: 'btn ghost small', type: 'button', text: 'คัดลอกลิงก์', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('คัดลอกลิงก์แล้ว'); } catch { prompt('คัดลอกลิงก์นี้', link); } } }),
        !used && h('button', { class: 'btn danger small', type: 'button', text: 'ลบ', onclick: async () => { await api('DELETE', `/api/invites/${i.code}`); reload(); } }));
    });
    const invites_ = h('div', { class: 'panel' }, h('h2', { text: 'รหัสเชิญสมัครสมาชิก' }),
      h('p', { class: 'sub', text: 'ส่งรหัสหรือลิงก์ให้คนที่จะสมัครเอง (ใช้ได้ครั้งเดียว อายุ 7 วัน)' }),
      h('div', { class: 'filters' }, invRole, h('button', { class: 'btn', type: 'button', text: '+ สร้างรหัสเชิญ', onclick: async () => { try { await api('POST', '/api/invites', { role: invRole.value }); reload(); } catch (e) { toast(e.message, true); } } })),
      invRows.length ? invRows : h('p', { class: 'sub', text: 'ยังไม่มีรหัสเชิญ' }));

    shell('users', [h('div', { class: 'pagehead' }, h('h1', { text: 'จัดการผู้ใช้' }), h('span', { class: 'sub', text: 'เฉพาะผู้จัดการเท่านั้นที่เห็นหน้านี้' })), create,
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['ผู้ใช้', 'ตำแหน่ง', 'สถานะ', 'สร้างเมื่อ', ''].map((x) => h('th', { text: x })))), h('tbody', {}, rows))),
      h('br'), invites_]);
  }

  boot();
})();
