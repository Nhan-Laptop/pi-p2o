#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AssessmentReport } from '../../src/reporting/index.js';
import { createApplication, loadApplicationConfig, type ApplicationConfig, type AssessmentApplication } from '../../src/application/index.js';
import { createLocalFixtureSandbox } from '../../src/tools/index.js';
import { buildScenario, ENVIRONMENT_B, RUN_ID, TASK_HYP_CASE, TASK_HYP_EXPORT, type Scenario } from './scenario.js';
import { startFixture, type FixtureInstance } from './fixture-server.js';
import { createFixtureReplayEnvironment } from './replay-environment.js';
import { startOverlapMonitor, type OverlapReport } from './overlap.js';

/** One owner-approved observation: what the controller actually recorded versus what the worker claimed. */
export interface ObservationRecord {
  checkId: string;
  taskId: string;
  observationId: string;
  /** Controller-minted receipt identity, when the check reached collection. */
  evidenceId: string | null;
  /** Controller-evaluated test outcome stored in the durable receipt (`test.outcome`), never worker prose. */
  receiptOutcome: string | null;
  /** Outcome the controller returned to the worker over the bridge, as the inert worker recorded it. */
  workerReported: string | null;
  /** Worker-side plan hint. The controller never reads it, so a disagreement proves it cannot set the outcome. */
  hint: string | null;
  classification: string | null;
  attempts: number | null;
  successes: number | null;
}

export interface ResultRecord {
  taskId: string;
  /** Attempt that produced the packet (the producing evidence identity). */
  attemptId: string;
  packetId: string;
  producerId: string;
  status: 'accepted' | 'returned-for-evidence';
}

export interface EvidenceRecord {
  evidenceId: string;
  taskId: string;
  attemptId: string;
  kind: string;
  classification: string;
  collectorId: string;
  collectorRole: string;
  toolName: string;
  environmentId: string;
  testOutcome: string | null;
  testPurpose: string | null;
}
export interface LocalAssessmentResult {
  runDir: string;
  runId: string;
  runState: string;
  terminal: boolean;
  report: AssessmentReport;
  markdown: string;
  json: string;
  accepted: number;
  returned: number;
  evidenceReceipts: number;
  findings: Array<{ findingId: string; state: string; taskId: string }>;
  packets: Array<{ packetId: string; taskId: string; contract: string; outcome: string }>;
  coverage: Array<{ state: string; count: number }>;
  events: number;
  /** Requests answered and peak simultaneous in-flight requests per loopback fixture instance. */
  fixtureRequests: Array<{ environment: string; requests: number; maxConcurrent: number }>;
  /** Controller-evaluated classification of every owner-approved check that reached collection. */
  observations: ObservationRecord[];
  /** Durable result decisions with the exact attempt that produced each packet. */
  acceptedResults: ResultRecord[];
  /** Bounded receipt index (attempt/collector/tool identity) for the durable evidence of this run. */
  evidence: EvidenceRecord[];
  /** Real execution-overlap evidence for the two independent hypothesis tasks. */
  overlap: OverlapReport;
}

export interface LocalAssessmentOptions {
  keep?: boolean;
  runRoot?: string;
  log?: (message: string) => void;
  /** Safe fixture variant: the export route enforces the tenant boundary. */
  enforceExportTenant?: boolean;
  /** Absolute request budget override for the pre-dispatch budget regression test. */
  maxRequests?: number;
  /** Optional worker idle window before the packet (pre-dispatch budget regression). */
  probeHoldMs?: number;
}

export interface PreparedAssessment {
  app: AssessmentApplication;
  config: ApplicationConfig;
  runDir: string;
  assessmentPath: string;
  manifestPath: string;
  scenario: Scenario;
  configurationDigest: string;
  /** Requests answered by each loopback fixture instance (budget/limit regression tests). */
  /** Requests answered and peak simultaneous in-flight requests per loopback fixture instance. */
  fixtureRequests(): { environment: string; requests: number; maxConcurrent: number }[];
  /** Close the loopback fixture instances (workers are not running yet in the idle case). */
  closeFixtures(): Promise<void>;
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no port')); return; }
      const port = address.port;
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function exampleSourceRoot(): string {
  return process.env.P2O_EXAMPLE_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../examples/local-assessment');
}

/**
 * Prepare the inert local fixture composition: real store/vault/policy/broker/supervisor/interface plus the
 * real headless runtime adapter driving an inert scripted worker against a loopback-only fixture.
 */
export interface PrepareOptions {
  runRoot?: string;
  log?: (message: string) => void;
  /** Safe fixture variant: the export route enforces the tenant boundary. */
  enforceExportTenant?: boolean;
  /** Absolute request budget override for the pre-dispatch budget regression test. */
  maxRequests?: number;
  /** Optional worker idle window before the packet (pre-dispatch budget regression). */
  probeHoldMs?: number;
}

export async function prepareLocalAssessment(options: PrepareOptions = {}): Promise<PreparedAssessment> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const runDir = options.runRoot ?? mkdtempSync(join(tmpdir(), 'p2o-local-assessment-'));
  const sourceRoot = exampleSourceRoot();
  chmodSync(join(sourceRoot, 'inert-worker.mjs'), 0o700);
  const now = Date.now();
  mkdirSync(join(runDir, 'snapshot'), { recursive: true, mode: 0o700 });
  const snapshotFile = join(runDir, 'snapshot', 'fixture-server.ts');
  copyFileSync(join(sourceRoot, 'fixture-server.ts'), snapshotFile);

  const sandboxOptions = {
    acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' as const,
    inputRoot: join(runDir, 'snapshot'),
    outputRoot: join(runDir, 'broker-artifacts'),
    trustedInputSnapshot: true as const,
  };
  const sandboxIdentity = createLocalFixtureSandbox(sandboxOptions);
  const portB = await freePort();
  const enforceExportTenant = options.enforceExportTenant === true;
  const environmentA = await startFixture({ environmentId: 'lab-fixture-a', port: 0, configurationDigest: sandboxIdentity.configurationDigest, enforceExportTenant });
  let environmentB: FixtureInstance = await startFixture({ environmentId: ENVIRONMENT_B, port: portB, configurationDigest: sandboxIdentity.configurationDigest, enforceExportTenant });
  log(`fixture A ${environmentA.origin}  fixture B ${environmentB.origin}`);

  const scenario = buildScenario({
    runRoot: runDir,
    snapshotRoot: join(runDir, 'snapshot'),
    snapshotBytes: readFileSync(snapshotFile),
    environmentA,
    environmentB,
    workspaceRoot: join(runDir, 'workspaces'),
    controlRoot: join(runDir, 'control'),
    vaultRoot: join(runDir, 'vault'),
    socketPath: join(runDir, 'run', 'worker-bridge.sock'),
    inertWorkerPath: join(sourceRoot, 'inert-worker.mjs'),
    extensionPath: join(sourceRoot, 'bridge-extension.js'),
    configurationDigest: sandboxIdentity.configurationDigest,
    exportTenantEnforced: enforceExportTenant,
    ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
    ...(options.probeHoldMs === undefined ? {} : { probeHoldMs: options.probeHoldMs }),
    now,
  });

  const assessmentPath = join(runDir, 'assessment.json');
  const manifestPath = join(runDir, 'run-manifest.json');
  writeFileSync(assessmentPath, `${JSON.stringify(scenario.config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(manifestPath, `${JSON.stringify(scenario.config.run, null, 2)}\n`, { mode: 0o600 });
  const config = loadApplicationConfig(assessmentPath);

  const app = await createApplication(config, {
    // Even a scripted no-model fixture keeps the production controller gateway/spend guard.
    // This synthetic credential and loopback-only placeholder confer no provider access.
    upstream: {
      approval: 'inert-local-example-no-provider-access',
      provider: config.runtime.selection.provider,
      upstreamBaseUrl: 'http://127.0.0.1:9/',
      api: config.runtime.gateway.api,
      models: config.runtime.gateway.models.map(model => ({ ...model, reasoning: true, maxTokens: 1024, contextWindow: 32768, thinkingLevelMap: { max: 'max-effort' } })),
      credential: { accountId: 'inert-local-example', version: '1', secret: 'inert-local-example-not-a-provider-credential' },
    },
    replayEnvironment: services => createFixtureReplayEnvironment(services, {
      port: portB,
      initial: () => environmentB,
      setCurrent: instance => { environmentB = instance; },
      // The owner-approved document the controller issues the scoped verifier capability from.
      config,
    }),
    log: (event, detail) => log(`[app] ${event} ${detail}`),
  });
  return {
    app, config, runDir, assessmentPath, manifestPath, scenario,
    configurationDigest: sandboxIdentity.configurationDigest,
    fixtureRequests: () => [
      { environment: environmentA.environmentId, requests: environmentA.requests, maxConcurrent: environmentA.maxConcurrent },
      { environment: environmentB.environmentId, requests: environmentB.requests, maxConcurrent: environmentB.maxConcurrent },
    ],
    async closeFixtures() {
      await environmentA.close().catch(() => {});
      await environmentB.close().catch(() => {});
    },
  };
}

/** Bounded worker-side record of the controller outcomes the inert worker actually received. */
function readWorkerObservations(workspace: string): Array<{ observationId: string; outcome: string | null; hint: string | null }> {
  try {
    const parsed = JSON.parse(readFileSync(join(workspace, 'worker-observations.json'), 'utf8')) as { observations?: unknown };
    if (!Array.isArray(parsed.observations)) return [];
    return parsed.observations.flatMap(entry => {
      const record = entry as { observationId?: unknown; outcome?: unknown; hint?: unknown };
      return typeof record.observationId === 'string'
        ? [{ observationId: record.observationId, outcome: typeof record.outcome === 'string' ? record.outcome : null, hint: typeof record.hint === 'string' ? record.hint : null }]
        : [];
    });
  } catch { return []; }
}

/** Controller-evaluated classification for every owner-approved check the worker actually performed. */
function collectObservations(app: AssessmentApplication, config: ApplicationConfig, runId: string): ObservationRecord[] {
  const receipts = app.store.listEvidence(runId);
  const records: ObservationRecord[] = [];
  for (const task of config.tasks) {
    const plan = task.workerPlan as { observations?: Array<{ observationId?: unknown; hint?: unknown }> } | undefined;
    const reported = readWorkerObservations(join(config.roots.workspace, task.manifest.taskId));
    for (const check of config.checks ?? []) {
      if (check.taskId !== task.manifest.taskId) continue;
      const entry = (plan?.observations ?? []).find(candidate => candidate.observationId === check.observationId);
      if (!entry) continue;
      const receipt = receipts.filter(candidate => candidate.evidenceId.startsWith(`${check.checkId}-`)).at(-1);
      const report = reported.find(candidate => candidate.observationId === check.observationId);
      records.push({
        checkId: check.checkId, taskId: check.taskId, observationId: check.observationId,
        evidenceId: receipt?.evidenceId ?? null,
        receiptOutcome: receipt?.test?.outcome ?? null,
        workerReported: report?.outcome ?? null,
        hint: typeof entry.hint === 'string' ? entry.hint : report?.hint ?? null,
        classification: receipt?.classification ?? null,
        attempts: receipt?.test?.attempts ?? null,
        successes: receipt?.test?.successes ?? null,
      });
    }
  }
  return records;
}

function collectResults(app: AssessmentApplication, runId: string): ResultRecord[] {
  return app.store.listResults(runId).map(result => ({
    taskId: result.taskId, attemptId: result.attemptId, packetId: result.packet.packetId,
    producerId: result.packet.producer.id,
    status: result.decision.status === 'accepted' ? 'accepted' : 'returned-for-evidence',
  }));
}

function collectEvidence(app: AssessmentApplication, runId: string): EvidenceRecord[] {
  return app.store.listEvidence(runId).map(receipt => {
    let collectorRole = 'unknown';
    try { collectorRole = app.vault.inspect(receipt.evidenceId)?.collector.role ?? 'unknown'; }
    catch { collectorRole = 'unverifiable'; }
    return {
      evidenceId: receipt.evidenceId, taskId: receipt.taskId, attemptId: receipt.attemptId, kind: receipt.kind,
      classification: receipt.classification, collectorId: receipt.provenance.collectorId, collectorRole,
      toolName: receipt.provenance.tool.name, environmentId: receipt.provenance.environmentId,
      testOutcome: receipt.test?.outcome ?? null, testPurpose: receipt.test?.purpose ?? null,
    };
  });
}

/**
 * Run the full local fixture: mapping -> two parallel hypothesis workers -> independent verifier -> report.
 * Loopback only; no model provider call, no external target, no container and no host built-in tools.
 */
export async function runLocalAssessment(options: LocalAssessmentOptions = {}): Promise<LocalAssessmentResult> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const prepared = await prepareLocalAssessment({
    ...(options.runRoot ? { runRoot: options.runRoot } : {}), log,
    ...(options.enforceExportTenant === undefined ? {} : { enforceExportTenant: options.enforceExportTenant }),
    ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
    ...(options.probeHoldMs === undefined ? {} : { probeHoldMs: options.probeHoldMs }),
  });
  const { app, config, runDir } = prepared;
  try {
    await app.admitApprovedRun();
    await app.admitApprovedTasks();
    app.supervisor.start(RUN_ID);
    log('run started; waiting for terminal state');
    // Overlap evidence is only observable while the run is live: the monitor verifies owned pids against /proc
    // and records the durable lifecycle per sample, then measures the intersection of both verified windows.
    const overlapMonitor = startOverlapMonitor({
      store: app.store, runId: RUN_ID, controlRoot: config.roots.control,
      taskIds: [TASK_HYP_EXPORT, TASK_HYP_CASE],
    });
    const snapshot = await app.supervisor.wait(RUN_ID).finally(() => overlapMonitor.stop());
    const overlap = overlapMonitor.stop();
    log(`run ${snapshot.run.runId} state=${snapshot.run.state} tasks=${snapshot.tasks.map(task => `${task.taskId}:${task.lifecycleState}/${task.packetState}`).join(' ')}`);
    const artifacts = app.artifacts(RUN_ID);
    writeFileSync(join(runDir, 'report.json'), `${artifacts.json}\n`, { mode: 0o600 });
    writeFileSync(join(runDir, 'report.md'), `${artifacts.markdown}\n`, { mode: 0o600 });
    return {
      runDir,
      runId: RUN_ID,
      runState: snapshot.run.state,
      terminal: ['completed', 'failed', 'cancelled'].includes(snapshot.run.state),
      report: artifacts.report,
      markdown: artifacts.markdown,
      json: artifacts.json,
      accepted: snapshot.results.filter(entry => entry.decision.status === 'accepted').length,
      returned: snapshot.results.filter(entry => entry.decision.status !== 'accepted').length,
      evidenceReceipts: app.store.listEvidence(RUN_ID).length,
      findings: artifacts.report.findings.map(finding => ({ findingId: finding.findingId, state: finding.state, taskId: finding.taskId })),
      packets: artifacts.report.packets.map(packet => ({ packetId: packet.packetId, taskId: packet.taskId, contract: packet.contract, outcome: packet.outcome })),
      coverage: Object.entries(artifacts.report.coverage.counts).map(([state, count]) => ({ state, count: Number(count) })),
      events: app.store.listEvents({ runId: RUN_ID }).length,
      fixtureRequests: prepared.fixtureRequests(),
      observations: collectObservations(app, config, RUN_ID),
      acceptedResults: collectResults(app, RUN_ID),
      evidence: collectEvidence(app, RUN_ID),
      overlap,
    };
  } finally {
    await app.close();
    await prepared.closeFixtures();
    if (options.keep !== true && options.runRoot === undefined) rmSync(runDir, { recursive: true, force: true });
  }
}

function printResult(result: LocalAssessmentResult): void {
  const lines = [
    `run ${result.runId} state=${result.runState} terminal=${result.terminal}`,
    `accepted=${result.accepted} returned=${result.returned} evidence=${result.evidenceReceipts} events=${result.events}`,
    `packets: ${result.packets.map(packet => `${packet.contract}/${packet.taskId}/${packet.outcome}`).join(', ') || 'none'}`,
    `findings: ${result.findings.map(finding => `${finding.findingId}=${finding.state}`).join(', ') || 'none'}`,
    `coverage: ${result.coverage.map(entry => `${entry.state}=${entry.count}`).join(', ')}`,
    `assessmentStatus: ${result.report.assessmentStatus}`,
    `overlap: bothAliveMs=${result.overlap.bothAliveMs} sharedRunningRounds=${result.overlap.sharedRunningRounds} fixtureMaxConcurrent=${result.fixtureRequests.map(entry => entry.maxConcurrent).join('/')}`,
    `observations: ${result.observations.map(record => `${record.checkId}=${record.receiptOutcome ?? record.workerReported ?? 'none'}${record.hint && record.hint !== (record.receiptOutcome ?? record.workerReported) ? '(worker-hint-overridden)' : ''}`).join(', ')}`,
    `run directory: ${result.runDir}`,
    '',
    result.markdown,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keep = process.argv.includes('--keep');
  const runRootArg = process.argv.indexOf('--run-root');
  const runRoot = runRootArg >= 0 ? process.argv[runRootArg + 1] : undefined;
  runLocalAssessment({ keep, runRoot })
    .then(result => {
      printResult(result);
      const ok = result.terminal && result.accepted >= 4 && result.findings.some(finding => finding.state === 'independently-validated');
      if (!ok) {
        process.stderr.write('LOCAL ASSESSMENT INCOMPLETE: expected a terminal run with accepted packets and an independently validated finding\n');
        process.exitCode = 1;
      }
    })
    .catch(error => {
      process.stderr.write(`LOCAL ASSESSMENT FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
