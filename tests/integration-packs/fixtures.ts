// [F3/F4] Fixtures for the application-level pack wiring tests.
//
// These tests drive the REAL application composition: `createApplication` builds the sandbox, the capability
// registry, the per-attempt brokers and the owned runtime, and the tests dispatch through the application's own
// broker while a real attempt of a real run is live. The owner-approved documents come from the shared local
// fixture scenario (`examples/local-assessment`), so the run/task/policy shapes are schema-valid; the fixtures
// add exactly the pack observations the test asks for.
//
// No model, provider, credential or external target is contacted. The only processes involved are the inert
// loopback fixture HTTP servers and (for the host-browser case) the pinned host Chrome.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import {
  createApplication, loadApplicationConfig, type ApplicationConfig, type AssessmentApplication,
} from '../../src/application/index.js';
import { createHostBrowserSandbox, createLocalFixtureSandbox, discoverChromeIdentity, type ChromeIdentity } from '../../src/tools/index.js';
import { LinuxProcessProbe } from '../../src/runtime/index.js';
import { startFixture, type FixtureInstance } from '../../examples/local-assessment/fixture-server.js';
import { createFixtureReplayEnvironment } from '../../examples/local-assessment/replay-environment.js';
import {
  ACTOR_GUEST, ENVIRONMENT_B, RUN_ID, TASK_HYP_CASE, TASK_SURFACE_MAP,
  buildScenario, type Scenario,
} from '../../examples/local-assessment/scenario.js';

// The suite is compiled into a private build tree, so the repository root comes from the runner.
const repoRoot = process.env.P2O_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exampleRoot = process.env.P2O_EXAMPLE_SOURCE ?? join(repoRoot, 'examples', 'local-assessment');
export const GRANT = 'grant-hyp-case';
export const TARGET_A = 'lab-fixture-a';
const EXPIRES = '2099-01-01T00:00:00.000Z';
/** The idle window the inert worker takes after its observations, so a test can act on a durably live attempt. */
export const HOLD_MS = 9_000;
export { RUN_ID, TASK_HYP_CASE, TASK_SURFACE_MAP };

let pinCache: ChromeIdentity | undefined | null = null;
/** The pinned host Chrome identity, discovered once; undefined when the host has no usable Chrome. */
export async function chromePin(): Promise<ChromeIdentity | undefined> {
  if (pinCache !== null) return pinCache;
  try { pinCache = await discoverChromeIdentity(process.env.P2O_CHROME_LAUNCHER ?? '/usr/bin/google-chrome'); }
  catch { pinCache = undefined; }
  return pinCache;
}

export interface TargetFixture { origin: string; hits: { path: string; method: string }[] }
/** One extra loopback target; the host-browser test uses it to prove Chrome really rendered a page. */
export async function targetFixture(t: TestContext): Promise<TargetFixture> {
  const hits: { path: string; method: string }[] = [];
  const server: Server = createServer((request, response) => {
    hits.push({ path: (request.url ?? '/').split('?', 1)[0]!, method: request.method ?? 'GET' });
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><html><head><title>Pack Fixture</title></head><body><div id="root">rendered-by-fixture</div></body></html>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits };
}

/** Kernel identity of a process this suite started and already reaped, for stale-owner fixtures. */
export async function deadIdentity(): Promise<{ pid: number; ppid: number; pgid: number; startTicks: string; bootId: string; state: string }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  const rows = await new LinuxProcessProbe().snapshot();
  const row = rows.find(candidate => candidate.pid === child.pid);
  if (!row) throw new Error('the fixture controller process must be visible in /proc');
  child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>(done => child.once('exit', () => done()));
  return { pid: row.pid, ppid: row.ppid, pgid: row.pgid, startTicks: row.startTicks, bootId: row.bootId, state: row.state };
}

/** This suite's own process identity, for a live-owner fixture. */
export async function ownIdentity(): Promise<{ pid: number; ppid: number; pgid: number; startTicks: string; bootId: string; state: string }> {
  const rows = await new LinuxProcessProbe().snapshot();
  const own = rows.find(row => row.pid === process.pid);
  if (!own) throw new Error('the suite process must be visible in /proc');
  return { pid: own.pid, ppid: own.ppid, pgid: own.pgid, startTicks: own.startTicks, bootId: own.bootId, state: own.state };
}

export type PackMode = 'inert-fixture' | 'host-browser';
export interface PackRequest { proxy?: boolean; browser?: boolean; fuzz?: Record<string, unknown> }
/** Owner-approved capabilities to put in the case task's grant even when the pack itself is not enabled. */
export interface PackObservation { observationId: string; tool: string; input: Record<string, unknown>; summary: string }

export interface PreparedPackApp {
  app: AssessmentApplication;
  config: ApplicationConfig;
  /** Path of the owner-approved run manifest this composition was validated against (for interface preflight). */
  manifestPath: string;
  scenario: Scenario;
  target: TargetFixture;
  originA: string;
  observations: PackObservation[];
  runDir: string;
  caseTaskId: string;
  /** The attempt currently leased by the case task, when one exists. */
  caseAttemptId(): string | undefined;
  /** Controller-private owner token of one attempt, as the runtime recorded it in the handle file. */
  ownerToken(attemptId: string): string;
  close(): Promise<void>;
}

/** The one owner document this test tree mutates: a validated copy with a fresh root and optional edits. */
export function variant(config: unknown, suffix: string, mutate: (copy: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(config)) as Record<string, never> & {
    roots: { state: string; control: string; workspace: string; vault: string; artifacts: Record<string, string> };
    bridge: { socketPath: string };
  };
  const root = `${copy.roots.control}-${suffix}`;
  copy.roots.state = join(root, 'state', 'p2o.sqlite');
  copy.roots.control = join(root, 'control');
  copy.roots.workspace = join(root, 'workspaces');
  copy.roots.vault = join(root, 'vault');
  copy.roots.artifacts = { ...copy.roots.artifacts, 'controller-artifacts': join(root, 'controller-artifacts'), 'broker-artifacts': join(root, 'broker-artifacts') };
  copy.bridge.socketPath = join(root, 'run', 'worker-bridge.sock');
  // Task workspaces are validated against the configured root, so they move with it.
  for (const task of (copy as unknown as { tasks: Array<{ manifest: { taskId: string; workspace: string } }> }).tasks) {
    task.manifest.workspace = join(copy.roots.workspace, task.manifest.taskId);
  }
  for (const directory of [copy.roots.control, copy.roots.workspace, copy.roots.vault, join(root, 'run'), ...Object.values(copy.roots.artifacts)]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  mutate(copy as unknown as Record<string, unknown>);
  return copy;
}

/**
 * Build an application that enables exactly the requested packs on the requested boundary. Every pack
 * observation the caller passes is added to the owner-approved case task and to that task's worker plan, so the
 * inert worker performs it through the authenticated bridge exactly like an owner-menu observation.
 */
export async function preparePackApp(t: TestContext, options: {
  mode: PackMode; packs: PackRequest; packObservations: PackObservation[]; grantCapabilities?: string[];
  /**
   * Host-browser only: how long the pinned inert RPC worker stays live. It answers the public pi RPC subset and
   * settles after the delay, so a real attempt (real handle, real session lease, real terminal release) exists
   * without any model call.
   */
  workerDelayMs?: number;
}): Promise<PreparedPackApp> {
  const runDir = mkdtempSync(join(tmpdir(), 'p2o-integration-packs-'));
  const snapshotRoot = join(runDir, 'snapshot');
  const outputRoot = join(runDir, 'broker-artifacts');
  const profileRoot = join(runDir, 'browser-profiles');
  for (const directory of [snapshotRoot, outputRoot, profileRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  copyFileSync(join(exampleRoot, 'fixture-server.ts'), join(snapshotRoot, 'fixture-server.ts'));
  chmodSync(join(exampleRoot, 'inert-worker.mjs'), 0o700);

  const target = await targetFixture(t);
  const pin = options.mode === 'host-browser' ? await chromePin() : undefined;
  if (options.mode === 'host-browser' && !pin) throw new Error('host Chrome is required for the host-browser pack tests');
  const sandbox = options.mode === 'host-browser'
    ? createHostBrowserSandbox({
      inputRoot: snapshotRoot, outputRoot, trustedInputSnapshot: true,
      browser: {
        acknowledgement: 'host-browser-not-container-isolated', approvedBy: 'integration-pack-owner', expiresAt: EXPIRES,
        egress: 'loopback-only', profileRoot, sessionTtlMs: 120_000, maxSessions: 2, identity: pin!,
      },
    })
    : createLocalFixtureSandbox({ acknowledgement: 'local-fixtures-only-not-hostile-code-isolation', inputRoot: snapshotRoot, outputRoot, trustedInputSnapshot: true });

  const environmentA = await startFixture({ environmentId: TARGET_A, port: 0, configurationDigest: sandbox.configurationDigest });
  let environmentB: FixtureInstance | undefined;
  try {
    environmentB = await startFixture({ environmentId: ENVIRONMENT_B, port: 0, configurationDigest: sandbox.configurationDigest });
    const scenario = buildScenario({
      runRoot: runDir,
      snapshotRoot,
      snapshotBytes: readFileSync(join(snapshotRoot, 'fixture-server.ts')),
      environmentA,
      environmentB,
      workspaceRoot: join(runDir, 'workspaces'),
      controlRoot: join(runDir, 'control'),
      vaultRoot: join(runDir, 'vault'),
      socketPath: join(runDir, 'run', 'worker-bridge.sock'),
      inertWorkerPath: join(exampleRoot, 'inert-worker.mjs'),
      extensionPath: join(exampleRoot, 'bridge-extension.js'),
      configurationDigest: sandbox.configurationDigest,
      probeHoldMs: HOLD_MS,
      now: Date.now(),
    });
    const config = scenario.config as unknown as Record<string, unknown> & ApplicationConfig;
    const originA = environmentA.origin;
    // The pack observations are patched here, where the fixture origin is known.
    const observations = options.packObservations.map(observation => ({
      ...observation,
      input: JSON.parse(JSON.stringify(observation.input).replaceAll('$originA', originA)) as Record<string, unknown>,
    }));
    const checks = (config.checks ?? []) as unknown as Record<string, unknown>[];
    for (const observation of observations) {
      checks.push({
        checkId: observation.observationId, taskId: TASK_HYP_CASE, observationId: observation.observationId,
        tool: observation.tool, input: observation.input, kind: 'observation', classification: 'independently-observed',
        summary: observation.summary, actorId: ACTOR_GUEST, surfaceId: 'api.read',
      });
    }
    const casePlan = scenario.plans.get(TASK_HYP_CASE) as unknown as {
      observations: { observationId: string; name: string }[]; packet: { evidenceIds: string };
    };
    observations.forEach((observation, index) => casePlan.observations.push({ observationId: observation.observationId, name: `pack-${index}` }));
    if (observations.length) casePlan.packet.evidenceIds = `${casePlan.packet.evidenceIds},${observations.map((_, index) => `pack-${index}`).join(',')}`;

    const packs = options.packs;
    const packCapabilities = [
      ...(packs.browser ? ['browser.session', 'browser.act'] : []),
      ...(packs.proxy ? ['proxy.session', 'proxy.history'] : []),
      ...(packs.fuzz ? ['fuzz.differential', 'fuzz.template'] : []),
      ...(options.grantCapabilities ?? []),
    ];
    const policy = config.policy as unknown as { grantTemplates: Array<{ taskId: string; capabilities: string[]; targetIds: string[] }> };
    const grant = policy.grantTemplates.find(template => template.taskId === TASK_HYP_CASE);
    if (!grant) throw new Error('the fixture scenario must grant the case task');
    grant.capabilities = [...new Set([...grant.capabilities, ...packCapabilities])];
    const run = config.run as unknown as { allowedCapabilities: string[] };
    run.allowedCapabilities = [...new Set([...run.allowedCapabilities, ...packCapabilities])];
    if (packs.fuzz) {
      for (const name of ['strict-header.mjs', 'lenient-header.mjs', 'oracle-header.mjs']) {
        copyFileSync(join(repoRoot, 'tests', 'fuzz', 'fixtures', name), join(snapshotRoot, name));
      }
    }

    if (options.mode === 'host-browser') {
      // The host boundary is never reachable from an inert fixture run; this variant is an authorized assessment.
      config.mode = 'authorized-assessment';
      delete (config as { acknowledgement?: string }).acknowledgement;
      (config.bridge as { inertLocalOnly: boolean }).inertLocalOnly = false;
      config.sandbox = {
        mode: 'host-browser', acknowledgement: 'host-browser-not-container-isolated',
        inputRoot: snapshotRoot, outputRoot, profileRoot, approvedBy: 'integration-pack-owner', expiresAt: EXPIRES,
        egress: 'loopback-only', identity: pin!, sessionTtlMs: 120_000, maxSessions: 2,
      };
      // No model is contacted: the pinned inert RPC worker answers the public pi RPC subset and settles after a
      // bounded delay. Scripted worker plans are refused outside the inert fixture mode, so this run carries one
      // owner-approved task with no plan and the test dispatches through the application's own broker.
      const workerPath = join(runDir, 'pinned-inert-worker.mjs');
      copyFileSync(join(repoRoot, 'tests/runtime/fixtures/fake-pi.mjs'), workerPath);
      chmodSync(workerPath, 0o700);
      const runtime = config.runtime as unknown as Record<string, unknown>;
      runtime.piBinary = workerPath;
      runtime.piVersion = '0.85.1';
      runtime.startupTimeoutMs = 30_000;
      runtime.pollMs = 50;
      runtime.stopGraceMs = 300;
      const tasks = (config.tasks as unknown as Array<{ manifest: Record<string, unknown>; role: string; workerPlan?: unknown }>)
        .filter(task => task.manifest.taskId === TASK_HYP_CASE);
      if (tasks.length !== 1) throw new Error('the fixture scenario must carry exactly one case task');
      const caseTask = tasks[0]!;
      caseTask.manifest.dependencyTaskIds = [];
      delete caseTask.manifest.parentTaskId;
      // The remaining task is the run's only task, so it is a root task.
      caseTask.manifest.depth = 0;
      (caseTask.manifest.budgets as Record<string, unknown>).maxAttempts = 1;
      delete caseTask.workerPlan;
      config.tasks = tasks as unknown as ApplicationConfig['tasks'];
      // Policy grants and reporting plans may only name approved tasks.
      const policy = config.policy as unknown as { grantTemplates: Array<{ taskId: string }> };
      policy.grantTemplates = policy.grantTemplates.filter(template => template.taskId === TASK_HYP_CASE);
      delete (config as { checks?: unknown }).checks;
      delete (config as { reporting?: unknown }).reporting;
      const workspace = caseTask.manifest.workspace as string;
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      writeFileSync(join(workspace, 'fixture.json'), `${JSON.stringify({ delayMs: options.workerDelayMs ?? 30_000 })}\n`, { mode: 0o600 });
    }
    config.packs = { ...packs } as ApplicationConfig['packs'];

    const assessmentPath = join(runDir, 'assessment.json');
    const manifestPath = join(runDir, 'run-manifest.json');
    writeFileSync(assessmentPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(manifestPath, `${JSON.stringify((config as { run: unknown }).run, null, 2)}\n`, { mode: 0o600 });
    const loaded = loadApplicationConfig(assessmentPath);
    const app = await createApplication(loaded, {
      // Even a scripted no-model fixture keeps the production controller gateway and spend guard. The upstream
      // URL is an unreachable loopback sentinel, the credential is inert and no model/provider is contacted;
      // the explicit model metadata satisfies the gateway's readiness checks without widening any budget.
      upstream: {
        approval: 'integration-packs-inert-controller-gateway-never-contacted',
        provider: loaded.runtime.selection.provider,
        upstreamBaseUrl: 'http://127.0.0.1:9/',
        api: loaded.runtime.gateway.api,
        models: loaded.runtime.gateway.models.map(model => ({
          ...model, reasoning: true, maxTokens: 1024, contextWindow: 32768,
          thinkingLevelMap: { [loaded.runtime.selection.thinking]: 'inert-effort' },
        })),
        credential: { accountId: 'integration-packs-inert-gateway', version: '1', secret: 'integration-packs-inert-placeholder-never-a-real-provider-key' },
      },
      replayEnvironment: services => createFixtureReplayEnvironment(services, {
        port: 0, initial: () => environmentB!, setCurrent: instance => { environmentB = instance; },
        // The owner-approved document the controller issues any scoped verifier capability from.
        config: loaded,
      }),
      log: () => {},
    });
    return {
      app, config: loaded, manifestPath, scenario, target, originA, observations, runDir, caseTaskId: TASK_HYP_CASE,
      caseAttemptId: () => app.store.getLease(TASK_HYP_CASE)?.attemptId,
      ownerToken: (attemptId: string) => (JSON.parse(readFileSync(join(loaded.roots.control, 'handles', `${attemptId}.json`), 'utf8')) as { ownerToken: string }).ownerToken,
      async close() {
        try { await app.close(); } catch { /* the fixture teardown below still runs */ }
        await environmentA.close().catch(() => {});
        await environmentB?.close().catch(() => {});
        for (let attempt = 0; attempt < 6; attempt++) {
          try { rmSync(runDir, { recursive: true, force: true }); break; }
          catch { await new Promise(done => setTimeout(done, 150)); }
        }
      },
    };
  } catch (error) {
    await environmentA.close().catch(() => {});
    await environmentB?.close().catch(() => {});
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}

/** Admit and start the approved run; the fixture completes on its own unless a test cancels it. */
export async function startRun(app: AssessmentApplication): Promise<void> {
  await app.admitApprovedRun();
  await app.admitApprovedTasks();
  app.supervisor.start(RUN_ID);
}

const LIVE = new Set(['running', 'prompt-delivered', 'starting', 'queued', 'reconciling']);
/**
 * Wait until the case task's durable attempt satisfies exactly the precondition of the composition's
 * attempt-liveness fence: live attempt, controller-private runtime handle, and an open runtime session lease.
 */
export async function waitForLiveCaseAttempt(prepared: PreparedPackApp, timeoutMs = 90_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const attemptId = prepared.caseAttemptId();
    if (attemptId) {
      const attempt = prepared.app.store.getAttempt(attemptId);
      const lease = sessionLeases(prepared.config.roots.control)
        .find(entry => entry.scope.taskId === prepared.caseTaskId && entry.scope.attemptId === attemptId);
      if (attempt && LIVE.has(attempt.lifecycleState) && lease?.state === 'open') {
        try { prepared.ownerToken(attemptId); return attemptId; } catch { /* the launch handle is not durable yet */ }
      }
    }
    if (Date.now() > end) throw new Error(`no live, leased attempt with a controller handle for ${prepared.caseTaskId} after ${timeoutMs}ms`);
    await new Promise(done => setTimeout(done, 50));
  }
}

/** Wait for one owner-approved pack observation's controller-minted receipt. */
export async function waitForPackEvidence(prepared: PreparedPackApp, checkId: string, timeoutMs = 60_000): Promise<{ evidenceId: string; kind: string; classification: string }> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const found = prepared.app.store.listEvidence(RUN_ID).find(receipt => receipt.evidenceId.startsWith(`${checkId}-`));
    if (found) return found as { evidenceId: string; kind: string; classification: string };
    if (Date.now() > end) throw new Error(`no receipt for ${checkId} after ${timeoutMs}ms`);
    await new Promise(done => setTimeout(done, 50));
  }
}

export interface DurableLease {
  attemptKey: string; scope: { taskId: string; attemptId: string }; state: string;
  release?: {
    state: string; verified: boolean; duplicate: boolean; outstanding: number; reason: string; ms: number; evidenceNote?: string;
    releasers: Array<{ name: string; outcome: string; released?: number; outstanding?: number; error?: string }>;
  };
}
/** Durable session leases recorded in one lease directory. */
export function leasesIn(directory: string): DurableLease[] {
  let names: string[] = [];
  try { names = readdirSync(directory).filter(name => name.startsWith('lease-') && name.endsWith('.json')); } catch { return []; }
  return names.map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as DurableLease);
}

/** Durable session leases recorded by the runtime under the composition's control root. */
export function sessionLeases(controlRoot: string): DurableLease[] {
  const directory = join(controlRoot, 'sessions');
  let names: string[] = [];
  try { names = readdirSync(directory).filter(name => name.startsWith('lease-') && name.endsWith('.json')); } catch { return []; }
  return names.map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as DurableLease);
}

/** The durable release verdict of one attempt (or of any attempt of the case task), once terminated. */
export async function terminalCaseLease(prepared: PreparedPackApp, options: { attemptId?: string; timeoutMs?: number } = {}): Promise<NonNullable<DurableLease['release']>> {
  const end = Date.now() + (options.timeoutMs ?? 180_000);
  for (;;) {
    for (const lease of sessionLeases(prepared.config.roots.control)) {
      if (lease.scope.taskId !== prepared.caseTaskId || !lease.release) continue;
      if (options.attemptId === undefined || lease.scope.attemptId === options.attemptId) return lease.release;
    }
    if (Date.now() > end) throw new Error(`no durable session release for ${options.attemptId ?? prepared.caseTaskId} after ${options.timeoutMs ?? 180_000}ms`);
    await new Promise(done => setTimeout(done, 100));
  }
}

/** The seeded differential input whose minimal reproducer is the single byte 0x8e. */
export function fuzzInput(): Record<string, unknown> {
  return { subject: { kind: 'module-pair', moduleA: 'strict-header.mjs', moduleB: 'lenient-header.mjs' }, strategy: 'bytes', seed: 'b3-differential-1', cases: 64, maxInputBytes: 32 };
}

export function packRoots(prepared: PreparedPackApp): { control: string; input: string; profile: string } {
  const sandbox = prepared.config.sandbox;
  return {
    control: prepared.config.roots.control,
    input: sandbox.mode === 'container' ? '' : sandbox.inputRoot,
    profile: sandbox.mode === 'host-browser' ? sandbox.profileRoot : '',
  };
}
