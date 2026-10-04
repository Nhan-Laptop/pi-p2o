#!/usr/bin/env node
// [T8] Real-Herdr sanity: launch ONE worker through the runtime's real Herdr adapter (not the fake herdr
// CLI used by other suites), with the project-pinned Pi binary, T6's guardian relay and the loopback inert
// gateway + controller-owned model gateway + model spend ledger.
//
// KNOWN FAILURE (recorded here, not hidden): on this tree the
// supervisor's first reconcile probe can fire while the Herdr launch pipeline is still in flight, before the
// adapter records the owned pane shell. managed.ts reconcile() then treats the launch as terminated, the
// attempt is reconciled to failed and the worker never reaches the gateway. The script therefore exits 1
// with the raw event trail until that (out-of-T8-ownership) defect is fixed; it is opt-in via --herdr.
//
// This is opt-in because it needs a live local Herdr caller/socket context. It never contacts a provider:
// every socket is loopback and the only "model" is the scripted gateway fixture. Run it with
// `node tests/real-worker/run.mjs --herdr`, or directly against a compiled slice:
//   node <build>/tests/real-worker/herdr-sanity.js
//
// Required environment (explicit, never ambient fallback): HERDR_ENV=1, HERDR_SOCKET_PATH=<absolute>,
// HERDR_PANE_ID=<parent pane>, HERDR_BIN_PATH or an absolute herdr binary, P2O_REPO_ROOT,
// P2O_REAL_WORKER_SOURCE.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createApplication, validateApplicationConfig, type AssessmentApplication } from '../../src/application/index.js';
import { createLocalFixtureSandbox } from '../../src/tools/index.js';
import { PINNED_MODEL_PRICES, modelPriceKey, type ModelSpendState } from '../../src/policy/index.js';
import type { RuntimeHandle } from '../../src/runtime/index.js';
import { startFixture, type FixtureInstance } from '../../examples/local-assessment/fixture-server.js';
import {
  REAL_WORKER_ENVIRONMENT, REAL_WORKER_GATEWAY_APPROVAL, REAL_WORKER_MODEL,
  REAL_WORKER_PROVIDER, REAL_WORKER_SNAPSHOT_FILE, REAL_WORKER_TASK_ID, buildRealWorkerScenario,
} from './scenario.js';

const HERDR_PI_VERSION = '0.9.0';
const RUN_ID = 'run-real-worker-herdr';
const DEADLINE_MS = 120_000;
const SPEND_BOUND = { inputTokensUpperBound: 8_000, maxOutputTokens: 4_096 } as const;
/** [T9] Every provider turn must fit its payload-derived worst case next to the earlier turns' spend. */
const RUN_MAX_TOKENS = 96_000;
const UPSTREAM_ACCOUNT = 'fixture-upstream-owner';
const UPSTREAM_SECRET = 'sk-t8fixtureupstreamcredential0123456789';

interface GatewayTurn {
  turn: number; authorization: string;
  body: { model?: string };
  usage?: { prompt_tokens: number; completion_tokens: number };
}
interface InertGateway {
  origin: string;
  turns: GatewayTurn[];
  errors: string[];
  close(): Promise<void>;
}
interface InertGatewayModule {
  startInertGateway(options?: { onRequest?: (request: { turn: number }) => unknown }): Promise<InertGateway>;
}
interface HerdrObservation { turn: number; reservations: number }

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert.ok(value && value.trim(), `${name} is required`);
  return value;
}

function herdrEnv(socketPath: string, paneId: string): Record<string, string> {
  return { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', HERDR_ENV: '1', HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: paneId };
}

function herdrCall(binary: string, socketPath: string, paneId: string, args: string[]): Record<string, unknown> {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000, env: herdrEnv(socketPath, paneId) });
  assert.equal(result.status, 0, `herdr ${args.join(' ')} must exit 0 (stderr: ${result.stderr})`);
  const envelope = JSON.parse(result.stdout) as { error?: unknown; result?: Record<string, unknown> };
  assert.ok(!envelope.error, `herdr ${args.join(' ')} returned an error envelope: ${result.stdout.slice(0, 300)}`);
  assert.ok(envelope.result, `herdr ${args.join(' ')} returned no result envelope`);
  return envelope.result;
}

function herdrPanes(binary: string, socketPath: string, paneId: string): Array<Record<string, unknown>> {
  const result = herdrCall(binary, socketPath, paneId, ['pane', 'list']);
  return Array.isArray(result.panes) ? result.panes as Array<Record<string, unknown>> : [];
}

function journalState(app: AssessmentApplication): ModelSpendState | undefined {
  return app.store.modelSpendJournal(RUN_ID).load(RUN_ID) as ModelSpendState | undefined;
}

function sessionAssistantUsages(sessionFile: string): Array<{ input: number; output: number }> {
  const usages: Array<{ input: number; output: number }> = [];
  for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const message = (parsed as { message?: unknown } | null)?.message;
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; usage?: { input?: unknown; output?: unknown } };
    if (record.role !== 'assistant' || !record.usage) continue;
    usages.push({ input: Number(record.usage.input ?? 0), output: Number(record.usage.output ?? 0) });
  }
  return usages;
}

function artifacts(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= 2000) return;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && statSync(absolute).size <= 8 * 1024 * 1024) found.push(relative(root, absolute));
    }
  };
  visit(root);
  return found;
}

const repoRoot = requiredEnv('P2O_REPO_ROOT');
const realWorkerSource = requiredEnv('P2O_REAL_WORKER_SOURCE');
const herdrBinary = requiredEnv('HERDR_BIN_PATH');
const socketPath = requiredEnv('HERDR_SOCKET_PATH');
const parentPaneId = requiredEnv('HERDR_PANE_ID');
assert.equal(process.env.HERDR_ENV, '1', 'HERDR_ENV must be exactly 1');
assert.ok(parentPaneId, 'HERDR_PANE_ID must name the caller pane');
assert.ok(herdrBinary.startsWith('/'), 'HERDR_BIN_PATH must be an absolute binary path');

const version = spawnSync(herdrBinary, ['--version'], { encoding: 'utf8', env: herdrEnv(socketPath, parentPaneId) });
assert.equal(version.status, 0, `herdr --version must exit 0 (stderr: ${version.stderr})`);
assert.equal(version.stdout.trim().replace(/^herdr\s+/, ''), HERDR_PI_VERSION, `the local Herdr must be exactly ${HERDR_PI_VERSION}`);
const schemaResult = spawnSync(herdrBinary, ['api', 'schema', '--json'], { encoding: 'utf8', timeout: 30_000, env: herdrEnv(socketPath, parentPaneId) });
assert.equal(schemaResult.status, 0, `herdr api schema must exit 0 (stderr: ${schemaResult.stderr})`);
const schema = JSON.parse(schemaResult.stdout) as { protocol?: unknown; schema_version?: unknown };
assert.equal(schema.protocol, 22, 'the local Herdr API protocol must be 22');
assert.equal(schema.schema_version, 1, 'the local Herdr API schema version must be 1');
console.log(`herdr ready version=${HERDR_PI_VERSION} protocol=${schema.protocol} schema=${schema.schema_version} parentPane=${parentPaneId} socket=${socketPath}`);

const gatewayModule = await import(pathToFileURL(join(realWorkerSource, 'inert-gateway.mjs')).href) as InertGatewayModule;
const observations: HerdrObservation[] = [];
const logs: string[] = [];
let app: AssessmentApplication | undefined;
const gateway = await gatewayModule.startInertGateway({
  onRequest: request => {
    const state = app ? journalState(app) : undefined;
    const observed = { turn: request.turn, reservations: Object.keys(state?.reservations ?? {}).length };
    observations.push(observed);
    return observed;
  },
});

let fixture: FixtureInstance | undefined;
let paneId: string | undefined;
const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'p2o-real-worker-herdr-')));
const snapshotRoot = join(runRoot, 'snapshot');
const workspaceRoot = join(runRoot, 'workspaces');
const controlRoot = join(runRoot, 'control');
const vaultRoot = join(runRoot, 'vault');
const socketFile = join(runRoot, 'run', 'worker-bridge.sock');
let exitCode = 0;
try {
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  copyFileSync(join(repoRoot, 'examples', 'local-assessment', REAL_WORKER_SNAPSHOT_FILE), join(snapshotRoot, REAL_WORKER_SNAPSHOT_FILE));
  const snapshotBytes = readFileSync(join(snapshotRoot, REAL_WORKER_SNAPSHOT_FILE));
  const sandboxIdentity = createLocalFixtureSandbox({
    acknowledgement: 'local-fixtures-only-not-hostile-code-isolation',
    inputRoot: snapshotRoot,
    outputRoot: join(runRoot, 'broker-artifacts'),
    trustedInputSnapshot: true,
  });
  fixture = await startFixture({ environmentId: REAL_WORKER_ENVIRONMENT, port: 0, configurationDigest: sandboxIdentity.configurationDigest });

  const scenario = buildRealWorkerScenario({
    runId: RUN_ID, adapter: 'herdr', runMaxTokens: RUN_MAX_TOKENS,
    herdr: { herdrBinary, herdrVersion: HERDR_PI_VERSION, parentPaneId, context: { HERDR_ENV: '1', HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: parentPaneId } },
    runRoot, snapshotRoot, snapshotBytes, fixture, workspaceRoot, controlRoot, vaultRoot,
    socketPath: socketFile,
    extensionPath: join(repoRoot, 'examples', 'local-assessment', 'bridge-extension.js'),
    piBinary: join(repoRoot, 'node_modules', '.bin', 'pi'),
    gatewayOrigin: gateway.origin,
    now: Date.now(),
  });
  const config = validateApplicationConfig(scenario.config);
  app = await createApplication(config, {
    log: (event, detail) => logs.push(`${event} ${detail}`),
    spend: { ...SPEND_BOUND },
    upstream: {
      approval: REAL_WORKER_GATEWAY_APPROVAL,
      provider: REAL_WORKER_PROVIDER,
      upstreamBaseUrl: gateway.origin,
      api: config.runtime.gateway.api,
      models: config.runtime.gateway.models,
      credential: { accountId: UPSTREAM_ACCOUNT, version: 'v1', secret: UPSTREAM_SECRET },
      log: line => logs.push(`gateway ${line}`),
    },
  });
  await app.admitApprovedRun();
  await app.admitApprovedTasks();
  app.supervisor.start(RUN_ID);

  const deadline = Date.now() + DEADLINE_MS;
  let snapshot = app.supervisor.snapshot(RUN_ID);
  while (!['completed', 'failed', 'cancelled'].includes(snapshot.run.state) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    snapshot = app.supervisor.snapshot(RUN_ID);
  }
  assert.ok(['completed', 'failed', 'cancelled'].includes(snapshot.run.state), `the Herdr run must terminate; observed ${snapshot.run.state}`);
  assert.equal(gateway.errors.length, 0, `the inert gateway must report no contract error: ${gateway.errors.join(' | ')}`);
  const attempt = snapshot.attempts.find(candidate => candidate.taskId === REAL_WORKER_TASK_ID);
  assert.ok(attempt, 'the Herdr worker must produce a durable attempt');
  const handle = JSON.parse(readFileSync(join(controlRoot, 'handles', `${attempt.attemptId}.json`), 'utf8')) as RuntimeHandle;
  paneId = handle.native.paneId;
  assert.equal(handle.kind, 'herdr', 'the durable handle must come from the real herdr adapter');
  assert.ok(paneId, 'the durable handle must carry a native Herdr pane id');
  assert.ok(handle.native.agentName, 'the durable handle must carry the renamed Herdr agent identity');
  assert.ok(handle.native.guardian, 'T6 guardian relay identity must be attested for the Herdr pane');
  assert.equal(handle.status, 'completed', `the Herdr worker must complete; observed ${handle.status} (${handle.startupError ?? 'no error'})`);
  assert.ok(gateway.turns.length >= 1, 'the Herdr worker must reach the inert gateway');

  const state = journalState(app);
  const reservationId = `model-spend-${attempt.attemptId}`;
  const price = PINNED_MODEL_PRICES[modelPriceKey(REAL_WORKER_PROVIDER, REAL_WORKER_MODEL)];
  expectUsage: {
    assert.ok(price, 'the pinned price table must carry the Herdr worker selection');
    const reported = gateway.turns.map(turn => turn.usage);
    assert.ok(reported.every(usage => usage && usage.prompt_tokens >= 1), 'every Herdr provider turn must report usage');
    assert.deepEqual(
      sessionAssistantUsages(handle.sessionFile),
      reported.map(usage => ({ input: usage!.prompt_tokens, output: usage!.completion_tokens })),
      'real Pi must persist exactly the provider usage the gateway reported',
    );
    const input = reported.reduce((sum, usage) => sum + usage!.prompt_tokens, 0);
    const output = reported.reduce((sum, usage) => sum + usage!.completion_tokens, 0);
    const expectedMicros = Math.ceil((input * price.inputMicroUsdPerMillion) / 1_000_000) + Math.ceil((output * price.outputMicroUsdPerMillion) / 1_000_000);
    // [T9] One durable charge per provider turn, charged at the gateway as each response completed.
    const turnCharges = Object.entries(state?.settlements ?? {})
      .filter(([id]) => id.startsWith(`${reservationId}:turn-`))
      .sort((left, right) => Number(left[0].slice(`${reservationId}:turn-`.length)) - Number(right[0].slice(`${reservationId}:turn-`.length)));
    assert.equal(turnCharges.length, reported.length, `the ledger must charge every Herdr turn; release=${JSON.stringify(state?.released[reservationId] ?? null)}`);
    assert.deepEqual(turnCharges.map(([, record]) => ({ input: record.inputTokens, output: record.outputTokens })), reported.map(usage => ({ input: usage!.prompt_tokens, output: usage!.completion_tokens })));
    assert.equal(state!.committed.tokens, input + output);
    assert.equal(state!.committed.costMicros, expectedMicros);
    console.log(`gateway turns=${gateway.turns.length} upstreamAuthorization=${gateway.turns[0]!.authorization}`);
    console.log(`herdr pane=${paneId} agent=${handle.native.agentName} guardian=${handle.native.guardian.pid} status=${handle.status} workspace=${handle.workspace}`);
    console.log(`spend reservationsObservedAtRequests=${observations.map(observed => `${observed.turn}:${observed.reservations}`).join(',')} perTurn=${turnCharges.map(([, record]) => `${record.inputTokens}+${record.outputTokens}`).join(' ')} committed tokens=${state!.committed.tokens} micros=${state!.committed.costMicros}`);
    console.log(`artifacts=${artifacts(runRoot).length} runState=${snapshot.run.state} taskState=${snapshot.tasks[0]?.lifecycleState}/${snapshot.tasks[0]?.packetState}`);
  }
  // The supervisor must have closed the owned pane as part of verified termination.
  const panesAfter = herdrPanes(herdrBinary, socketPath, parentPaneId);
  assert.equal(panesAfter.some(pane => pane.pane_id === paneId), false, `the owned Herdr pane ${paneId} must be closed after verified termination`);
  console.log(`pane closed=${paneId} remainingPanes=${panesAfter.length}`);
} catch (error) {
  exitCode = 1;
  console.error(`HERDR SANITY FAIL: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`diagnostic logs=${logs.join(' | ').slice(0, 6000)}`);
  console.error(`diagnostic gatewayTurns=${gateway.turns.length} observations=${JSON.stringify(observations)}`);
  if (app) console.error(`diagnostic events=${app.store.listEvents({ runId: RUN_ID }).map(event => `${event.type}:${JSON.stringify(event.payload)}`).join(' | ').slice(0, 8000)}`);
} finally {
  await app?.close().catch(() => {});
  await fixture?.close().catch(() => {});
  await gateway.close().catch(() => {});
  // Safety net: never leave an owned pane behind when the run failed before verified termination.
  if (paneId) {
    try {
      if (herdrPanes(herdrBinary, socketPath, parentPaneId).some(pane => pane.pane_id === paneId)) {
        herdrCall(herdrBinary, socketPath, parentPaneId, ['pane', 'close', paneId]);
        console.error(`HERDR SANITY: closed leftover pane ${paneId}`);
      }
    } catch { /* the adapter's own reconciliation is the primary path */ }
  }
  rmSync(runRoot, { recursive: true, force: true });
}
process.exitCode = exitCode;
