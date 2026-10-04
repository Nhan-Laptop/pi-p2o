/** Trusted inert runner fixtures only. No acquired repository code or hooks are executed. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createProcessRunner } from '../../src/application/entry/clone.js';
import { roots } from './fixtures.js';
it('real default runner bounds output and waits for termination before refusing', async () => {
  await expect(createProcessRunner().run({ file: process.execPath, args: ['--eval', 'process.stdout.write("x".repeat(32768)); setInterval(() => {}, 1000);'], env: {}, cwd: process.cwd(), timeoutMs: 2000, maxOutputBytes: 16 })).rejects.toThrow(/output exceeded/);
});
it('real default runner deadline terminates a trusted inert process, no repository execution', async () => {
  await expect(createProcessRunner().run({ file: process.execPath, args: ['--eval', 'setInterval(() => {}, 1000);'], env: {}, cwd: process.cwd(), timeoutMs: 50, maxOutputBytes: 16 })).rejects.toThrow(/time bound/);
});
it('real cancellation kills the helper process group as well as its CLI', async () => {
  const r = await roots(), controller = new AbortController(), marker = join(r.root, 'helper.pid');
  const script = 'const cp = require("node:child_process"), fs = require("node:fs"); const helper = cp.spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000);"], {stdio: "inherit"}); fs.writeFileSync(process.env.PID_FILE, String(helper.pid)); setInterval(() => {}, 1000);';
  const running = createProcessRunner().run({ file: process.execPath, args: ['--eval', script], env: { PID_FILE: marker }, cwd: r.root, signal: controller.signal, timeoutMs: 3000, maxOutputBytes: 64 });
  // Register the rejection handler before aborting so failure never creates an unhandled promise.
  const refused = expect(running).rejects.toThrow(/cancelled/);
  try {
    let pid: string | undefined;
    for (let i = 0; i < 100; i++) { pid = await readFile(marker, 'utf8').catch(() => undefined); if (pid) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(pid).toMatch(/^\d+$/); controller.abort(); await refused;
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    // A zombie is already terminated (no live acquisition); PID 1 may reap it later.
    if (stat) expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z');
  } finally { controller.abort(); await refused; await r.cleanup(); }
});
