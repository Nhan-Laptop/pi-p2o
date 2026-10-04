import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, renameSync, readdirSync, lstatSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';

// Self-contained: provisioned compiler only; no installs, repository scripts or in-place emit.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = mkdtempSync(join('/tmp', 'p2o-checkpoint-build-'));
const worker = join(output, 'tests/checkpoint/process.js');
const checkpointFile = root => join(root, 'checkpoints', 'source-run', 'checkpoint.json');
const roots = [];
const child = (mode, root, timeout = 120_000) => spawnSync(process.execPath, [worker, mode, root], {
  cwd: repo, encoding: 'utf8', timeout,
  env: { ...process.env, OPENAI_API_KEY: 'CHECKPOINT_SECRET_MUST_NOT_SERIALIZE', ANTHROPIC_API_KEY: 'CHECKPOINT_SECRET_MUST_NOT_SERIALIZE' },
});
const setup = (persistMode = 'persist') => {
  const root = mkdtempSync(join('/tmp', 'p2o-checkpoint-test-')); roots.push(root);
  const saved = child(persistMode, root);
  assert.equal(saved.signal, 'SIGKILL', saved.stdout + saved.stderr);
  // Durable publication is readiness, not potentially unflushed stdout before SIGKILL.
  const cp = readFileSync(checkpointFile(root), 'utf8');
  assert.equal(JSON.parse(cp).version, 1);
  assert(!cp.includes('CHECKPOINT_SECRET')); assert(!cp.includes('API_KEY')); assert(!cp.includes('leaseToken'));
  return root;
};
const ok = r => assert.equal(r.status, 0, r.stdout + r.stderr);
const denied = (r, text) => { assert.notEqual(r.status, 0, r.stdout + r.stderr); assert((r.stderr + r.stdout).includes(text), r.stdout + r.stderr); };
try {
  const lock = JSON.parse(readFileSync(join(repo, 'containers/pack.lock.json'), 'utf8'));
  const version = spawnSync('/usr/bin/docker', ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(version.status, 0, `REAL Docker prerequisite failed: ${version.error ?? version.stderr}`);
  assert.equal(version.stdout.trim(), `${lock.engineVersion}/${lock.engineVersion}`, 'REAL Docker prerequisite: pinned engine version required; no re-pin');
  const image = spawnSync('/usr/bin/docker', ['image', 'inspect', lock.image.pin], { encoding: 'utf8', timeout: 5000 });
  assert.equal(image.status, 0, `REAL Docker prerequisite: pinned image missing; no pull/build: ${image.error ?? image.stderr}`);

  writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'module' }), { mode: 0o600 });
  const compilation = spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'),
    '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023',
    '--rootDir', repo, '--outDir', output, '--skipLibCheck', '--esModuleInterop', '--noEmitOnError',
    join(repo, 'tests/checkpoint/process.ts')], { cwd: repo, encoding: 'utf8', timeout: 180_000 });
  assert.equal(compilation.status, 0, `checkpoint slice compilation failed: ${compilation.error ?? ''}\n${compilation.stdout}${compilation.stderr}`);

  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000); process.send("ready")'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('foreign sentinel IPC readiness deadline exceeded')); }, 5000);
      const cleanup = () => { clearTimeout(timer); sentinel.off('message', message); sentinel.off('error', error); sentinel.off('exit', exited); };
      const message = value => { if (value === 'ready') { cleanup(); resolveReady(); } };
      const error = e => { cleanup(); reject(e); };
      const exited = (code, signal) => { cleanup(); reject(new Error(`foreign sentinel exited before readiness: ${code}/${signal}`)); };
      sentinel.on('message', message); sentinel.once('error', error); sentinel.once('exit', exited);
    });
    const root = setup(); writeFileSync(join(root, 'original/canary.ts'), 'UNAPPROVED_ORIGINAL_MOVED');
    const container = JSON.parse(readFileSync(join(root, 'container-fixture.json'), 'utf8'));
    assert.equal(spawnSync('/usr/bin/docker', ['inspect', container.id], { encoding: 'utf8' }).status, 0, 'enrolled container must exist before restore');
    const r = child('restore', root);
    ok(r);
    assert(r.stdout.includes('PHYSICAL_PINNED_DOCKER_READBACK_OK') && !r.stdout.includes('PHYSICAL_DOCKER_SKIPPED'), 'physical pinned Docker readback is required, never a skipped pass');
    assert.notEqual(spawnSync('/usr/bin/docker', ['inspect', container.id], { encoding: 'utf8' }).status, 0, 'the dead-owner enrolled container must be physically removed by restart recovery');
    console.log('PHYSICAL_CONTAINER_RECOVERY_REMOVED_OWNED_CONTAINER');
    console.log(r.stdout.trim());
    process.kill(sentinel.pid, 0); console.log('FOREIGN_PROCESS_UNTOUCHED');
  } finally {
    if (sentinel.pid && sentinel.exitCode === null && sentinel.signalCode === null) {
      const exited = once(sentinel, 'exit'); sentinel.kill(); await exited;
    }
  }

  // Real physical live-resource refusal: the adopted guardian process is left alive after the refusal.
  {
    const root = setup('persist-live');
    const pid = Number(readFileSync(join(root, 'sentinel.pid'), 'utf8'));
    denied(child('restore', root), 'CHECKPOINT_RESOURCE');
    process.kill(pid, 0);
    process.kill(pid, 'SIGKILL');
    console.log('PHYSICAL_LIVE_RESOURCE_REFUSED_FOREIGN_PROCESS_UNTOUCHED');
  }
  denied(child('missing-handle', setup()), 'CHECKPOINT_RESOURCE');
  denied(child('terminal', setup()), 'CHECKPOINT_TERMINAL');
  denied(child('consent-change', setup()), 'CHECKPOINT_CONSENT');
  denied(child('expired', setup()), 'CHECKPOINT_EXPIRED');
  denied(child('lost-ledger', setup()), 'RESTORE_REFUSED');
  {
    const root = setup(), cp = JSON.parse(readFileSync(checkpointFile(root)));
    const source = cp.checkpoint.source.seal.root;
    renameSync(source, source + '.old'); cpSync(source + '.old', source, { recursive: true });
    chmodSync(join(source, 'canary.ts'), 0o444); chmodSync(source, 0o555);
    denied(child('restore', root), 'SCOPE_DIGEST_MISMATCH');
  }
  {
    const root = setup(), path = checkpointFile(root);
    const cp = JSON.parse(readFileSync(path)); cp.checkpoint.progress.usage.costUsd = 0;
    writeFileSync(path, JSON.stringify(cp)); denied(child('restore', root), 'CHECKPOINT_CORRUPT');
  }
  {
    const root = setup(), cp = JSON.parse(readFileSync(checkpointFile(root)));
    const path = join(cp.checkpoint.source.seal.root, 'canary.ts');
    chmodSync(path, 0o600); writeFileSync(path, 'DRIFT'); chmodSync(path, 0o444);
    denied(child('restore', root), 'SCOPE_DIGEST_MISMATCH');
  }
  {
    const root = setup(), cp = JSON.parse(readFileSync(checkpointFile(root)));
    renameSync(cp.checkpoint.source.seal.root, cp.checkpoint.source.seal.root + '.gone');
    denied(child('restore', root), 'CHECKPOINT_SOURCE_MISSING');
  }
  {
    const root = setup(); writeFileSync(join(root, 'owner-plan-approval.json'), '{}');
    denied(child('restore', root), 'RESTORE_REFUSED');
  }
  {
    const dir = mkdtempSync(join('/tmp', 'p2o-checkpoint-verifier-')); roots.push(dir);
    const r = child('verifier-state', dir);
    ok(r);
    assert(r.stdout.includes('VERIFIER_RESTART_STATE_GATES_OK'), r.stdout + r.stderr);
    console.log('VERIFIER_RESTART_STATE_GATES_OK');
  }
  {
    const dir = mkdtempSync(join('/tmp', 'p2o-checkpoint-reconstruct-')); roots.push(dir);
    const r = child('reconstruct', dir);
    ok(r);
    assert(r.stdout.includes('RECONSTRUCTED_APPROVED_REQUEST_OK'), r.stdout + r.stderr);
    console.log('RECONSTRUCTED_APPROVED_REQUEST_OK');
  }
  console.log('CHECKPOINT_TWO_PROCESS_NEGATIVE_GATES_OK');
} finally {
  const writable = path => { if (!lstatSync(path).isDirectory()) return; chmodSync(path, 0o700); for (const entry of readdirSync(path)) writable(join(path, entry)); };
  // Refusal scenarios never reach reconciliation, so their enrolled fixture containers are removed here.
  for (const root of roots) {
    try {
      const container = JSON.parse(readFileSync(join(root, 'container-fixture.json'), 'utf8'));
      spawnSync('/usr/bin/docker', ['rm', '--force', container.id], { encoding: 'utf8', timeout: 20_000 });
    } catch { /* no container fixture or already removed */ }
  }
  try { for (const root of roots) { writable(root); rmSync(root, { recursive: true, force: true }); } }
  finally { rmSync(output, { recursive: true, force: true }); assert(!existsSync(output), 'private build output was not cleaned'); }
  assert(roots.every(root => !existsSync(root)), 'read-only fixture outputs were not cleaned');
}
