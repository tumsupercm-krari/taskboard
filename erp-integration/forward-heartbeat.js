'use strict';
/*
 * Server-side helper for your ERP backend (Node.js). Call forwardHeartbeat(username) from the route that
 * receives POST /api/work-heartbeat, passing the username of the logged-in ERP user (from the ERP session,
 * never from the request body).
 *
 * Environment on the ERP server:
 *   TASKBOARD_URL      e.g. https://taskboard.example.com
 *   TASKBOARD_API_KEY  the secret that TaskBoard lists in INGEST_KEYS as "erp=<secret>"
 */
const TASKBOARD_URL = process.env.TASKBOARD_URL;
const TASKBOARD_API_KEY = process.env.TASKBOARD_API_KEY;
const lastSent = new Map();                          // username -> minute already reported (at most 1 call/min/user)

async function forwardHeartbeat(username, now = Date.now()) {
  const minute = Math.floor(now / 60000);
  if (lastSent.get(username) === minute) return { skipped: true };
  lastSent.set(username, minute);
  const res = await fetch(`${TASKBOARD_URL}/api/ingest/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TASKBOARD_API_KEY}` },
    body: JSON.stringify({ events: [{ username, at: now }] }),
  });
  if (!res.ok) throw new Error(`TaskBoard answered ${res.status}`);
  return res.json();
}
module.exports = { forwardHeartbeat };
