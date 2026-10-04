#!/usr/bin/env node
/**
 * Two-process DEFAULT bundled-entry restart qualification.
 *
 * The slice is compiled into an owner-private temp root (nothing is installed, no repository file is edited)
 * and the compiled root is made the package root: the shipped container lock, bridge extension, guardian and
 * receipt runtime modules resolve inside it exactly as they do in a real install.
 *
 * Process one runs the real `/p2o --target` command with the inert loopback provider and automated human
 * dialogs, waits for a live worker attempt plus its enrolled container, then SIGKILLs itself. Process two is a
 * fresh process whose FIRST command is `/p2o resume <runId>`: the assertion is that the original source is
 * reused, the pinned spend continues, and a NEW physical attempt/container runs through the bundled entry,
 * while the original container is physically reclaimed.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = mkdtempSync(join('/tmp', 'p2o-checkpoint-default-build-'));
const roots = [];
const docker = (args, timeout = 30_000) => spawnSync('/usr/bin/docker', args, { encoding: 'utf8', timeout });

function ownedRunIds(root) {
  try {
    return readdirSync(join(root, 'runs')).filter(name => name.startsWith('assessment-')).map(name => {
      try { return JSON.parse(readFileSync(join(root, 'runs', name, 'control', 'application.json'), 'utf8')).run.runId; } catch { return undefined; }
    }).filter(Boolean);
  } catch { return []; }
}
function writable(path) {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) writable(join(path, entry));
}
try {
  // Pinned local Docker only: no pull, build, re-pin or public target.
  const lock = JSON.parse(readFileSync(join(repo, 'containers/pack.lock.json'), 'utf8'));
  const version = docker(['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'], 5_000);
  assert.equal(version.status, 0, `REAL Docker prerequisite failed: ${version.error ?? version.stderr}`);
  assert.equal(version.stdout.trim(), `${lock.engineVersion}/${lock.engineVersion}`, 'REAL Docker prerequisite: pinned engine version required; no re-pin');
  const image = docker(['image', 'inspect', lock.image.pin], 5_000);
  assert.equal(image.status, 0, `REAL Docker prerequisite: pinned image missing; no pull/build: ${image.error ?? image.stderr}`);

  writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'module' }), { mode: 0o600 });
  const compilation = spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'),
    '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023',
    '--rootDir', repo, '--outDir', output, '--skipLibCheck', '--esModuleInterop', '--noEmitOnError',
    join(repo, 'tests/checkpoint-default/process.ts'),
    join(repo, 'src/runtime/guardian.ts'), join(repo, 'src/runtime/pi-receipts.ts')], { cwd: repo, encoding: 'utf8', timeout: 240_000 });
  assert.equal(compilation.status, 0, `checkpoint-default slice compilation failed:\n${compilation.stdout}${compilation.stderr}`);

  // Make the compiled slice behave like the shipped package root without touching the repository install.
  symlinkSync(join(repo, 'node_modules'), join(output, 'node_modules'), 'dir');
  // Real copies, not links: the pinned seccomp profile and the approved bridge extension are read through
  // no-follow/realpath checks that reject symlinked package assets.
  cpSync(join(repo, 'containers'), join(output, 'containers'), { recursive: true });
  cpSync(join(repo, 'examples'), join(output, 'examples'), { recursive: true });
  mkdirSync(join(output, 'dist', 'src'), { recursive: true });
  cpSync(join(output, 'src', 'runtime'), join(output, 'dist', 'src', 'runtime'), { recursive: true });
  assert(existsSync(join(output, 'dist', 'src', 'runtime', 'guardian.js')) && existsSync(join(output, 'dist', 'src', 'runtime', 'pi-receipts.js')),
    'the compiled slice must expose the standalone guardian/receipt runtime entries');

  const child = (mode, root, timeout) => spawnSync(process.execPath, [join(output, 'tests', 'checkpoint-default', 'process.js'), mode, root], {
    cwd: repo, encoding: 'utf8', timeout,
    // No provider API key is injected: the only available model must be the explicit loopback inert fixture.
    env: { ...process.env, P2O_CHECKPOINT_DEFAULT_AMBIENT_SECRET: 'CHECKPOINT_SECRET_MUST_NOT_SERIALIZE' },
  });

  const cycle = async (label, persistMode, restoreMode, tokens) => {
    let persisted;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const root = mkdtempSync(join('/tmp', `p2o-checkpoint-default-${label}-`)); roots.push(root);
      persisted = child(persistMode, root, 300_000);
      if (persisted.status === 0 && persisted.stdout.includes('CHECKPOINT_DEFAULT_PERSIST_RETRY')) continue;
      assert.equal(persisted.signal, 'SIGKILL', `${label} persist process was not SIGKILLed:\n${persisted.stdout}${persisted.stderr}`);
      const ready = /CHECKPOINT_DEFAULT_PERSIST_READY (\S+) (\S+) (\S+)/.exec(persisted.stdout);
      assert(ready, `${label} persist readiness token missing:\n${persisted.stdout}${persisted.stderr}`);
      const [, runId] = ready;
      const checkpoint = readFileSync(join(root, 'checkpoints', runId, 'checkpoint.json'), 'utf8');
      assert(!checkpoint.includes('CHECKPOINT_SECRET') && !checkpoint.includes('explicit-inert-secret-not-live') && !checkpoint.includes('leaseToken'),
        'the durable checkpoint must not serialise credentials or session lease tokens');
      const restored = child(restoreMode, root, 360_000);
      assert.equal(restored.status, 0, `${label} fresh-process default restart refused or failed:\n${restored.stdout}${restored.stderr}`);
      for (const token of tokens) assert(restored.stdout.includes(token), `${label} missing ${token}:\n${restored.stdout}${restored.stderr}`);
      process.stdout.write(restored.stdout);
      return;
    }
    assert.fail(`${label} could not crash before the first provider turn in 3 attempts`);
  };
  await cycle('restart', 'persist', 'restore', [
    'CHECKPOINT_DEFAULT_ORIGINAL_SOURCE_REUSED',
    'CHECKPOINT_DEFAULT_SPEND_CONTINUED_NOT_RESET',
    'CHECKPOINT_DEFAULT_NO_REPLANNING_MODEL_CALL',
    'CHECKPOINT_DEFAULT_NEW_ATTEMPT_AND_CONTAINER',
    'CHECKPOINT_DEFAULT_TWO_PROCESS_RESTART_OK',
  ]);
  await cycle('midexecution', 'persist-mid', 'restore-mid', ['CHECKPOINT_DEFAULT_MIDEXECUTION_SPEND_REFUSED_NO_RESET']);
  await cycle('live-controller', 'persist-live-controller', 'restore-live-controller', ['CHECKPOINT_DEFAULT_LIVE_CONTROLLER_REFUSED_WRITER_UNTOUCHED']);
  await cycle('vault-tamper', 'persist', 'restore-vault-tamper', ['CHECKPOINT_DEFAULT_VAULT_ROOT_TAMPER_REFUSED']);
} finally {
  // Kill any fixture controller sentinel first: only identities created by this runner are signalled.
  for (const root of roots) {
    try {
      const sentinel = JSON.parse(readFileSync(join(root, 'original.json'), 'utf8')).sentinel;
      if (sentinel?.pid) { try { process.kill(sentinel.pid, 'SIGKILL'); } catch { /* already gone */ } }
    } catch { /* no snapshot or no sentinel */ }
  }
  // Remove only containers enrolled by runs created under our own roots; never touch foreign resources.
  const runIds = new Set(roots.flatMap(ownedRunIds));
  if (runIds.size) {
    const listed = docker(['ps', '-a', '--format', '{{.ID}} {{.Label "org.pi-p2o.container.run"}}']);
    for (const line of listed.stdout.trim().split('\n').filter(Boolean)) {
      const [id, run] = line.trim().split(/\s+/);
      if (run && runIds.has(run)) docker(['rm', '--force', id], 20_000);
    }
  }
  for (const root of roots) { writable(root); rmSync(root, { recursive: true, force: true }); }
  rmSync(output, { recursive: true, force: true });
  assert(!existsSync(output), 'private build output was not cleaned');
  assert(roots.every(root => !existsSync(root)), 'fixture roots were not cleaned');
}
