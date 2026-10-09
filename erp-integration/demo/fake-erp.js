'use strict';
// A tiny stand-in ERP for trying the integration: node erp-integration/demo/fake-erp.js
// Pretends everybody is logged in as ?as=<username> (default: somchai). Real ERPs use their own session.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
process.env.TASKBOARD_URL = process.env.TASKBOARD_URL || 'http://localhost:3000';
process.env.TASKBOARD_API_KEY = process.env.TASKBOARD_API_KEY || 'erp-demo-key-0123456789abcdef';
const { forwardHeartbeat } = require('../forward-heartbeat.js');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const user = (req.headers.cookie || '').match(/erpuser=([a-z0-9._-]+)/)?.[1] || url.searchParams.get('as') || 'somchai';
  if (req.method === 'POST' && url.pathname === '/api/work-heartbeat') {
    try { const r = await forwardHeartbeat(user); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); }
    catch (e) { console.error(e.message); res.writeHead(502); res.end('{}'); }
    return;
  }
  if (url.pathname === '/work-tracker.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return fs.createReadStream(path.join(__dirname, '..', 'work-tracker.js')).pipe(res); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `erpuser=${user}; Path=/` });
  res.end(`<!doctype html><meta charset="utf-8"><title>ERP จำลอง</title><body style="font:16px sans-serif;padding:24px">
  <h1>ERP จำลอง</h1><p>ล็อกอินเป็น <b>${user}</b> · หน้านี้ใส่ work-tracker.js ไว้แล้ว ลองขยับเมาส์แล้วดูที่ TaskBoard เมนู "ชั่วโมงทำงาน"</p>
  <script src="/work-tracker.js" data-endpoint="/api/work-heartbeat"></script></body>`);
});
server.listen(Number(process.env.PORT) || 4000, () => console.log('fake ERP on http://localhost:' + (process.env.PORT || 4000)));
