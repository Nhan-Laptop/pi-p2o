/** Minimal trusted Docker test probe. Executes ONLY this fixed fixture, never source/repo code. */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { runFixedProcess } from '../../src/tools/process.js';
import type { ApprovedSourceContainerBinding, QualifiedSourceContainerSettings } from '../../src/application/source-binding/index.js';
const PROBE = `const fs = require('node:fs'); let denied = false, errorCode; try { fs.writeFileSync('/inputs/canary.ts', 'MUST_NOT_WRITE'); } catch (e) { denied = true; errorCode = e.code; } process.stdout.write(JSON.stringify({ canary: fs.readFileSync('/inputs/canary.ts', 'utf8'), denied, errorCode, uid: process.getuid() }));`;
export async function readAndDenyWrite(binding: ApprovedSourceContainerBinding, q: QualifiedSourceContainerSettings): Promise<{ canary: string; denied: boolean; errorCode: string; uid: number }> {
  await binding.assertCurrent();
  const name = `p2o-source-test-${randomUUID()}`;
  const args = ['run', '--name', name, '--rm', '--pull=never', '--network=none', '--read-only', '--user=65532:65532', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', `--security-opt=seccomp=${q.seccompPath}`, '--pids-limit=32', '--memory=256m', '--memory-swap=256m', '--cpus=0.5', '--ulimit=nofile=64:64', '--ulimit=core=0:0', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8388608,mode=1777', '--mount', `type=bind,src=${binding.inputRoot},dst=/inputs,readonly,bind-propagation=rprivate`, '--env=HOME=/tmp', '--env=NODE_OPTIONS=', '--log-driver=none', '--entrypoint=/usr/local/bin/node', q.image, '--eval', PROBE];
  const run = (args: string[]) => runFixedProcess(q.enginePath, args, { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
  try {
    const result = await run(args);
    if (result.code !== 0) throw new Error(`real pinned test probe failed: ${result.stderr}`);
    await binding.assertCurrent();
    return JSON.parse(result.stdout);
  } finally {
    for (let round = 0; round < 2; round++) {
      await run(['rm', '--force', name]);
      const gone = await run(['inspect', name]);
      if (gone.code !== 1 || !gone.stderr.includes(`No such object: ${name}`)) throw new Error('real fixture container termination not verified');
    }
  }
}
export function observeDocker() {
  const child = spawn('/usr/bin/docker', ['events', '--since', new Date().toISOString(), '--format', '{{json .}}'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const created: { name: string; image: string }[] = [], pulls: string[] = [];
  let buffer = '';
  child.stdout.on('data', chunk => { buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) { let e; try { e = JSON.parse(line); } catch { continue; } if (e.Type === 'image' && e.Action === 'pull') pulls.push(e.Actor.ID); const name = e.Actor?.Attributes?.name ?? ''; if (e.Type === 'container' && e.Action === 'create' && name.startsWith('p2o-')) created.push({ name, image: e.Actor.Attributes.image }); } });
  child.stderr.resume();
  return { created, pulls, async stop() { child.kill('SIGTERM'); await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); child.once('close', () => { clearTimeout(timer); resolve(); }); }); } };
}
