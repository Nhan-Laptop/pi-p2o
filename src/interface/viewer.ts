// Static assets: no run data or bearer token is interpolated into executable code/HTML.
export const viewerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>p2o read-only dashboard</title><link rel="stylesheet" href="/style.css"><script src="/viewer.js" defer></script></head>
<body><h1>p2o · read-only</h1><p>Fixture and assessment paths are distinct. Process exit ≠ packet acceptance ≠ finding verification. Coverage may be incomplete.</p>
<p id="connection" role="status">Connecting with a local access token…</p>
<section><h2>Run / requested runtime</h2><pre id="run"></pre></section>
<section><h2>Process / observed runtime receipts</h2><pre id="process"></pre></section>
<section><h2>Packet acceptance</h2><pre id="packets"></pre></section>
<section><h2>Finding verification</h2><pre id="findings"></pre></section>
<section><h2>Coverage and gaps</h2><pre id="coverage"></pre></section>
<section><h2>Execution failures</h2><pre id="failures"></pre></section>
<section><h2>Evidence (first 100 metadata receipts)</h2><pre id="evidence"></pre></section>
<section><h2>Qualified report</h2><pre id="report"></pre></section>
<section><h2>Events / redacted log tail (bounded)</h2><pre id="events"></pre></section>
<p>No action endpoints. Use Pi p2o_stop for verified runtime cancellation. Closing this viewer does not stop an assessment.</p></body></html>`;

export const viewerCss = `:root{color-scheme:light dark;font:15px system-ui}body{max-width:1000px;margin:auto;padding:1rem}section{border:1px solid #777;border-radius:6px;margin:1rem 0;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:28rem;overflow:auto}h2{font-size:1.1rem}`;

export const viewerScript = String.raw`'use strict';
(() => {
  const MAX_EVENTS = 200, MAX_LOG_CHARS = 65536, MAX_FRAME_CHARS = 65536;
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname); // Never retain the token in history, query or referrer.
  const state = { stopped: false, cursor: 0, lines: [], refreshPending: false, timer: null };
  const controller = new AbortController();
  const text = (id, value) => { document.getElementById(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  if (!token) { text('connection', 'Missing access token. Open the private URL shown by /p2o_dashboard.'); return; }
  const headers = { Authorization: 'Bearer ' + token };
  async function read(path) {
    const response = await fetch(path, { headers, cache: 'no-store', credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error('Read failed: HTTP ' + response.status);
    return response.json();
  }
  async function refresh() {
    if (state.stopped || state.refreshPending) return;
    state.refreshPending = true;
    try {
      const s = await read('/api/status');
      text('run', { mode: s.mode, run: s.run, counts: s.counts, truncated: s.truncated, qualification: s.qualification, notice: s.notice, preview: s.preview });
      for (const key of ['process', 'packets', 'findings', 'coverage', 'failures']) text(key, s[key] || []);
      const e = await read('/api/evidence?limit=100'); text('evidence', e);
      try { const r = await read('/api/report?format=json'); text('report', r); }
      catch (error) { text('report', 'Report unavailable: ' + error.message); }
      text('connection', 'Read-only · connected. Selection requests are not worker attestation.');
    } catch (error) { if (!state.stopped) text('connection', error.message); }
    finally { state.refreshPending = false; }
  }
  function append(page) {
    if (page.gap || page.truncated) state.lines.push('[event gap / display truncation; use p2o_events for durable receipts]');
    for (const item of (page.items || []).slice(0, 100)) {
      const line = item.occurredAt + ' ' + item.type + (item.display ? ' [' + item.display.kind + '] ' + item.display.text : '');
      state.lines.push(line.slice(0, 8192));
    }
    state.lines = state.lines.slice(-MAX_EVENTS);
    while (state.lines.join('\n').length > MAX_LOG_CHARS) state.lines.shift();
    text('events', state.lines.join('\n'));
  }
  async function stream() {
    const response = await fetch('/api/stream?afterSequence=' + state.cursor, { headers, cache: 'no-store', credentials: 'omit', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Stream failed: HTTP ' + response.status);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!state.stopped) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > MAX_FRAME_CHARS) throw new Error('Stream frame display limit exceeded');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          if (!data) continue;
          const page = JSON.parse(data);
          if (page.error) throw new Error(page.error);
          if (Number.isSafeInteger(page.nextSequence) && page.nextSequence >= state.cursor) state.cursor = page.nextSequence;
          append(page);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (!state.stopped) throw new Error('Stream closed; reopen p2o_dashboard if its session ended.');
  }
  refresh();
  state.timer = setInterval(refresh, 5000);
  stream().catch(error => { if (!state.stopped) text('connection', error.message); });
  addEventListener('pagehide', () => { state.stopped = true; clearInterval(state.timer); controller.abort(); }, { once: true });
})();`;
