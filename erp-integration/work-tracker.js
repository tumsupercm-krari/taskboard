/*
 * work-tracker.js: put this on every page of your ERP (before </body>).
 *
 *   <script src="/static/work-tracker.js" data-endpoint="/api/work-heartbeat" defer></script>
 *
 * It sends a small POST to YOUR ERP server every 30 seconds, but only while
 *   - the ERP tab is visible, and
 *   - the user moved the mouse / pressed a key / touched the screen in the last 2 minutes.
 * It sends no page content, URLs, keystrokes or screenshots: the body is empty.
 * Your ERP server knows who is logged in and forwards the heartbeat to TaskBoard
 * (see README.md in this folder). Optional attributes:
 *   data-csrf-header="X-CSRF-Token"   data-csrf-meta="csrf-token"   (read the token from <meta name="csrf-token">)
 */
(function () {
  'use strict';
  var tag = document.currentScript;
  var endpoint = (tag && tag.getAttribute('data-endpoint')) || '/api/work-heartbeat';
  var csrfHeader = tag && tag.getAttribute('data-csrf-header');
  var csrfMeta = tag && tag.getAttribute('data-csrf-meta');
  var BEAT_MS = 30000, IDLE_MS = 120000;
  var lastInput = Date.now(), lastBump = 0;

  function bump() {
    var now = Date.now();
    if (now - lastBump < 1000) return;
    lastBump = now;
    var wasIdle = now - lastInput > IDLE_MS;
    lastInput = now;
    if (wasIdle) beat();
  }
  function beat() {
    if (document.visibilityState !== 'visible' || Date.now() - lastInput > IDLE_MS) return;
    var headers = { 'Content-Type': 'application/json' };
    if (csrfHeader && csrfMeta) { var m = document.querySelector('meta[name="' + csrfMeta + '"]'); if (m) headers[csrfHeader] = m.content; }
    try { fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: headers, body: '{}', keepalive: true }).catch(function () {}); } catch (e) { /* ignore */ }
  }
  ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, bump, { passive: true, capture: true }); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') beat(); });
  setInterval(beat, BEAT_MS);
  beat();
})();
