// Docker-gated regression for the F4 fix: a REAL local pack container bring-up must happen under the
// bounded bring-up budget, and the first `source.analyze` must collect instead of timing out inside
// sandbox readiness. Missing Docker / pinned pack / locally resolved base is a SKIP with an explicit
// receipt (never a silent pass); an incomplete flow in a qualified environment is a FAILURE.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPolicy, TargetBudget } from '../../src/policy/index.js';
import { createContainerSandbox, createDefaultRegistry } from '../../src/tools/index.js';
import { createToolBroker } from '../../src/tools/broker.js';
import { buildContainerSandboxOptions, packPaths, readPackLock } from '../../examples/live-lab/pack.js';

const repoRoot = process.env.P2O_REPO_ROOT ?? join(import.meta.dirname, '../..');
/** In-memory synchronous journal: operational container mode requires a durable budget journal. */
function memoryJournal() {
  let state: unknown;
  return { load: (_runId: string): unknown => state, save: (next: unknown): void => { state = structuredClone(next); } };
}

/** Explicit environment receipt: `undefined` means qualified, otherwise the exact reason to skip. */
function environmentBlocker(): string | undefined {
  const { lockPath, seccompPath } = packPaths(repoRoot);
  if (!existsSync('/usr/bin/docker')) return 'docker engine not installed at /usr/bin/docker';
  if (!existsSync(lockPath) || !existsSync(seccompPath)) return 'pinned pack lock/seccomp not present in this checkout';
  let lock: ReturnType<typeof readPackLock>;
  try { lock = readPackLock(lockPath); } catch (error) { return `pinned pack lock unreadable: ${String(error)}`; }
  const docker = (args: string[]): string | undefined => {
    try { return execFileSync('/usr/bin/docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { return undefined; }
  };
  const server = docker(['version', '--format', '{{.Server.Version}}']);
  if (server !== lock.engineVersion) return `docker server ${String(server)} does not match pinned ${lock.engineVersion}`;
  if (!docker(['image', 'inspect', '--format', '{{.Id}}', lock.image.pin])) return `pinned pack image ${lock.image.pin} is not present locally (never pulled implicitly)`;
  // The sandbox verifies the base recorded in the pack image label, not the lock's index digest.
  const baseRef = docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.pi-p2o.base.image"}}', lock.image.pin]);
  if (!baseRef) return `pinned pack image ${lock.image.pin} does not record a digest-pinned base label`;
  const baseId = docker(['image', 'inspect', '--format', '{{.Id}}', baseRef]);
  if (!baseId) return `pinned base ${baseRef} is not present locally`;
  if (baseId !== lock.base.localBaseImageId) return `locally resolved base ${baseId} does not match the recorded pin ${lock.base.localBaseImageId}`;
  return undefined;
}

test('a real local pack cold start completes bring-up before the 15s operation deadline', async t => {
  const blocker = environmentBlocker();
  if (blocker) { t.skip(`live container cold-start check skipped: ${blocker}`); return; }

  const root = mkdtempSync(join(tmpdir(), 'p2o-coldstart-'));
  const inputRoot = join(root, 'inputs');
  const outputRoot = join(root, 'outputs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(inputRoot, { mode: 0o700 });
  mkdirSync(outputRoot, { mode: 0o700 });
  const text = 'import http from "node:http";\nexport const handler = () => http.createServer();\nconst password = "cold-start-fixture";\n';
  writeFileSync(join(inputRoot, 'app.ts'), text);
  const sha256 = createHash('sha256').update(text).digest('hex');

  try {
    const sandbox = createContainerSandbox(buildContainerSandboxOptions({
      repoRoot, inputRoot, outputRoot,
      approvedBy: 'p2o-test-owner',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }));

    // 1. Real bring-up on this host, measured.
    const bringUpStarted = Date.now();
    const preflight = await sandbox.preflight();
    const bringUpMs = Date.now() - bringUpStarted;
    assert.equal(preflight.ok, true, `pack preflight must succeed: ${JSON.stringify(preflight.checks.filter(check => !check.ok))}`);
    t.diagnostic(`real pack bring-up took ${bringUpMs} ms`);

    // 2. The operation keeps the unweakened 15s cap, and the integrated broker call collects.
    const registry = createDefaultRegistry();
    assert.equal(registry.get('source.analyze').limits.timeoutMs, 15_000, 'the steady-state operation cap must stay 15s');
    assert.ok(registry.startupBudgetMs('source.analyze') >= 30_000, 'the descriptor bring-up budget must stay >= 30s');
    const budgets = new TargetBudget([], { runId: 'coldstart-run', journal: memoryJournal(), freshRun: true });
    const policy = createPolicy({
      version: 1, runId: 'coldstart-run',
      authorization: { reference: 'owner-approved-coldstart-proof', approvedBy: 'p2o-test-owner', notBefore: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
      targets: [], exclusions: [], accounts: [],
      grants: [{
        id: 'coldstart-grant', taskId: 'coldstart-task', attemptId: 'coldstart-attempt', role: 'worker',
        capabilities: ['source.analyze'], targetIds: [], actions: ['analyze'], accountIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z', maxCalls: 4, maxArtifactBytes: 1_048_576,
      }],
    });
    const broker = createToolBroker({ policy, budgets, sandbox, registry });
    const callStarted = Date.now();
    const result = await broker.execute({
      context: { runId: 'coldstart-run', taskId: 'coldstart-task', attemptId: 'coldstart-attempt', grantId: 'coldstart-grant' },
      tool: 'source.analyze',
      input: { paths: ['app.ts'], contains: 'password' },
    });
    const callMs = Date.now() - callStarted;
    t.diagnostic(`first source.analyze through the real pack took ${callMs} ms (bring-up ${bringUpMs} ms)`);
    assert.equal(result.receipt.outcome, 'collected', 'the first call must collect, never TIMEOUT inside bring-up');
    assert.equal((result.data as { kind?: string }).kind, 'source');
    assert.equal(budgets.grantSnapshot('coldstart-grant').calls, 1, 'a dispatched call is charged exactly once');
    assert.equal(broker.noProgress('coldstart-attempt'), undefined, 'a collected first call never trips the no-progress breaker');
    // The source bytes really went through the pack: the analyzer saw the real file.
    assert.equal((result.data as { files?: Array<{ path?: string; sha256?: string }> }).files?.[0]?.sha256, sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
