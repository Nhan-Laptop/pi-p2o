import { readFile } from 'node:fs/promises';
import { environment } from './fixtures.js';
import { currentProcessIdentity } from '../../src/tools/browser-lifecycle.js';

// Isolated real controller. SIGKILL bypasses exit hooks, leaving actual Chrome for fresh-controller recovery.
try {
  const settings = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
  const env = await environment(settings.root, settings.origin, settings.pin);
  const handle = await env.runtime.start(await env.request({ hold: true, ignoreTerm: true }));
  await env.ready(handle);
  const opened = await env.open(handle);
  process.send?.({ kind: 'ready', handle: (await env.runtime.collect(handle)).handle, controller: currentProcessIdentity(),
    browserId: opened.browser.browserId, proxyId: opened.proxy.proxyId, identity: opened.identity, profile: opened.inspected.profile, ports: opened.ports });
  setInterval(() => {}, 1000);
} catch (error) { process.send?.({ kind: 'error', message: String(error) }); process.exitCode = 1; }
