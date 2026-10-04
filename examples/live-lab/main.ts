#!/usr/bin/env node
// Live vertical slice harness: real controller gateway -> real pinned `pi` worker -> brokered tools ->
// evidence vault -> independent verifier -> qualified report, against the loopback live lab.
//
// Everything the model may do is owner-approved in `scenario.ts`. Two loopback lab instances are started by
// this harness, the real container-sandbox identity is read from `containers/pack.lock.json`, the real pinned
// `pi` binary is launched by the managed headless runtime, and the only credential that exists in this process
// is the upstream provider credential held by the controller-owned gateway.
//
// Usage:
//   node examples/live-lab/run.mjs [--require-live] [--keep]
//
// Exit codes: 0 = live run completed and met the acceptance bar; 1 = live preconditions unavailable (honest
// SKIP, or FAIL with --require-live); 2 = the live run was attempted but did not meet the acceptance bar.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApplication, loadApplicationConfig, type AssessmentApplication, type VerificationServices } from '../../src/application/index.js';
import type { StoredResult } from '../../src/store/index.js';
import { auditArtifactsForSecrets, type GatewayAttestation } from '../../src/runtime/config.js';
import type { OwnerCredentialEntry, OwnerCredentialStore } from '../../src/application/authority.js';
import { createContainerSandbox, type ContainerSandboxOptions } from '../../src/tools/index.js';
import { buildContainerSandboxOptions, readPackLock, packPaths } from './pack.js';
import { createLabReplayEnvironment } from './replay-environment.js';
import {
  ACTOR_ADMIN, ACTOR_GUEST, ACTOR_GUEST_B, AUTHORIZATION_WINDOW_MS, ENVIRONMENT_A, ENVIRONMENT_B, LIVE_API,
  LIVE_GATEWAY_APPROVAL, LIVE_GATEWAY_MODELS, LIVE_PI_VERSION, LIVE_SELECTION, LIVE_UPSTREAM_BASE_URL,
  RUN_MAX_COST_USD, RUN_MAX_TOKENS, SNAPSHOT_FILE, TARGET_A, TARGET_B, assertPricedSelection, buildScenario,
  sourceSnapshotDigest,
} from './scenario.js';
import type { LabInstance, LabServerModule } from './types.js';

/** Seeded identities of environment B; the fresh replay instance must provision the same ones. */
const ENVIRONMENT_B_ACCOUNTS = Object.freeze([
  Object.freeze({ accountId: ACTOR_GUEST_B, tenant: 'alpha', role: 'member', password: 'guest-live-fixture-password' }),
]);

export interface LiveLabOptions {
  /** Upstream provider credential. Held in-process only; never written, logged or passed to a worker. */
  apiKey: string;
  /** Owner-store account identity the gateway receipt is allowed to name. */
  credentialAccount?: string;
  /** Rotation identity of the credential material. */
  credentialVersion?: string;
  repoRoot?: string;
  sourceRoot?: string;
  runId?: string;
  runRoot?: string;
  keep?: boolean;
  log?: (message: string) => void;
}

export interface LiveTurnSettlement {
  turnId: string;
  attemptId: string;
  selection: { provider: string; model: string; thinking: string };
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costMicros: number;
  basis: string;
}

export interface LiveWorkerSession {
  attemptId: string;
  taskId: string;
  tools: string[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LiveToolReceipt {
  evidenceId: string;
  taskId: string;
  attemptId: string;
  toolName: string;
  kind: string;
  classification: string;
  collectorId: string;
  collectorRole: string;
  environmentId: string;
  testOutcome: string | null;
  testPurpose: string | null;
  checkId: string | null;
  observationId: string | null;
  collectedAt: string;
}

export interface LiveResultDecision {
  taskId: string;
  attemptId: string;
  packetId: string | null;
  status: 'accepted' | 'returned-for-evidence';
  contract: string | null;
  outcome: string | null;
  reasons: string[];
}

export interface LiveLabResult {
  runId: string;
  runRoot: string;
  runState: string;
  terminal: boolean;
  assessmentStatus: string;
  reportPaths: { json: string; markdown: string; summary: string };
  report: {
    findings: { findingId: string; state: string; classification: string; evidenceCount: number; verifier: string | null }[];
    coverage: { state: string; count: number }[];
    packets: { taskId: string; contract: string; outcome: string; classification: string }[];
  };
  gateway: {
    gatewayId: string | null;
    credential: { accountId: string; version: string; ref: string } | null;
    exchanges: number;
    forwarded: number;
    denied: number;
    observed: { provider: string; model: string; thinking: string; matchesRequest: boolean }[];
    attestations: GatewayAttestation[];
  };
  spend: {
    limits: { maxTokens: number; maxCostUsd: number };
    committed: { tokens: number; costMicros: number };
    overshoot: { tokens: number; costMicros: number };
    settlements: LiveTurnSettlement[];
    releases: { attemptId: string; reason: string }[];
  };
  workerSessions: LiveWorkerSession[];
  toolReceipts: LiveToolReceipt[];
  decisions: LiveResultDecision[];
  verifierOutcomes: string[];
  scope: { approvedOrigins: string[]; observedOrigins: string[]; escapes: string[] };
  leakAudit: { providerCredential: { files: number; clean: boolean; detail: string }; labTokens: { files: number; clean: boolean; detail: string } };
  acceptance: { ok: boolean; reasons: string[] };
}

/**
 * Resolve the owner-provided provider credential through the pinned `pi` CLI. The value is captured from
 * stdout in this process only: it is never written to disk, never logged and never part of an artifact.
 */
export function resolveProviderCredential(piBinary: string, provider: string): { key: string; detail: string } {
  const result = spawnSync(piBinary, ['auth', 'print-api-key', '--provider', provider], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  if (result.error) return { key: '', detail: `pi auth did not run: ${result.error.message.slice(0, 120)}` };
  if (result.status !== 0) return { key: '', detail: `pi auth print-api-key --provider ${provider} exited ${result.status}` };
  const key = (result.stdout ?? '').trim();
  if (!key) return { key: '', detail: `pi auth returned no key for provider ${provider}` };
  return { key, detail: `resolved in-process (${key.length} characters); value never logged` };
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no port')); return; }
      const port = address.port;
      server.close(error => (error ? reject(error) : resolvePort(port)));
    });
  });
}

/** Load the plain-JavaScript lab target from the source tree (it is also the hashed analysis snapshot). */
export async function loadLabModule(sourceRoot: string): Promise<LabServerModule> {
  const modulePath = join(sourceRoot, 'lab-server.mjs');
  const module = await import(pathToFileURL(modulePath).href) as LabServerModule;
  if (typeof module.startLabServer !== 'function') throw new Error(`lab target module ${modulePath} does not export startLabServer`);
  return module;
}

function parseJsonFile<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

/** Owner-store credential boundary for the two lab environments; session tokens live in this process only. */
function labCredentialStore(input: { labA: () => LabInstance | undefined; labB: () => LabInstance | undefined; version: string; expiresAt: string }): OwnerCredentialStore {
  const entryFor = (accountId: string, instance: LabInstance | undefined): OwnerCredentialEntry | undefined => {
    if (!instance) return undefined;
    const token = instance.tokenFor(accountId);
    if (!token) return undefined;
    return { accountId, version: `${input.version}-${instance.instanceId}`, secret: token, expiresAt: input.expiresAt, targetIds: [TARGET_A, TARGET_B], actions: ['read'] };
  };
  return {
    async read(accountId: string) {
      if (accountId === ACTOR_GUEST || accountId === ACTOR_ADMIN) return entryFor(accountId, input.labA());
      if (accountId === ACTOR_GUEST_B) return entryFor(accountId, input.labB());
      return undefined;
    },
    async list() { return [ACTOR_GUEST, ACTOR_ADMIN, ACTOR_GUEST_B]; },
  };
}

// ------------------------------------------------------------------------------------------------- run

export async function runLiveLab(options: LiveLabOptions): Promise<LiveLabResult> {
  if (!options?.apiKey || options.apiKey.length < 8) throw new Error('a resolved upstream credential is required');
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const repoRoot = options.repoRoot ?? process.env.P2O_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const sourceRoot = options.sourceRoot ?? process.env.P2O_EXAMPLE_SOURCE ?? join(repoRoot, 'examples', 'live-lab');
  const runId = options.runId ?? `live-lab-${Date.now().toString(36)}`;
  const now = Date.now();

  const priceLine = assertPricedSelection(LIVE_SELECTION.provider, LIVE_SELECTION.model);
  log(`[live] selection ${LIVE_SELECTION.provider}/${LIVE_SELECTION.model} thinking=${LIVE_SELECTION.thinking}; pinned price ${priceLine}`);
  log(`[live] sandbox pack ${readPackLock(packPaths(repoRoot).lockPath).image.pin} source snapshot ${SNAPSHOT_FILE}`);

  const labModule = await loadLabModule(sourceRoot);
  const piBinary = join(repoRoot, 'node_modules', '.bin', 'pi');
  if (!existsSync(piBinary)) throw new Error(`pinned worker binary missing: ${piBinary}`);
  const piPackage = parseJsonFile<{ version?: string }>(join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'));
  if (piPackage?.version !== LIVE_PI_VERSION) throw new Error(`worker binary version ${piPackage?.version ?? 'unknown'} does not match the pinned ${LIVE_PI_VERSION}`);

  const runRootWasGiven = options.runRoot !== undefined;
  if (options.runRoot) mkdirSync(options.runRoot, { recursive: true, mode: 0o700 });
  // Short run-directory name: the worker bridge is a unix socket, which has a ~100 character path limit.
  const runRoot = mkdtempSync(join(options.runRoot ?? tmpdir(), 'll-'));
  const snapshotRoot = join(runRoot, 'snapshot');
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotFile = join(snapshotRoot, SNAPSHOT_FILE);
  copyFileSync(join(sourceRoot, SNAPSHOT_FILE), snapshotFile);
  const snapshotBytes = readFileSync(snapshotFile);
  const snapshotDigest = sourceSnapshotDigest(snapshotBytes);
  if (snapshotDigest !== sourceSnapshotDigest(readFileSync(join(sourceRoot, SNAPSHOT_FILE)))) throw new Error('snapshot copy is not identical to the executed lab target');

  const authorizationExpiresAt = new Date(now + AUTHORIZATION_WINDOW_MS).toISOString();
  const sandboxOptions: ContainerSandboxOptions = buildContainerSandboxOptions({
    repoRoot,
    inputRoot: snapshotRoot,
    outputRoot: join(runRoot, 'broker-artifacts'),
    approvedBy: 'live-lab-owner',
    expiresAt: authorizationExpiresAt,
  });
  const configurationDigest = createContainerSandbox(sandboxOptions).configurationDigest;

  const portB = await freePort();
  let labA: LabInstance | undefined;
  let labB: LabInstance | undefined;
  const store = labCredentialStore({ labA: () => labA, labB: () => labB, version: 'live-lab', expiresAt: authorizationExpiresAt });

  let app: AssessmentApplication | undefined;
  const logLines: string[] = [];
  const logSink = (message: string): void => {
    logLines.push(message);
    if (logLines.length > 4_000) logLines.splice(0, logLines.length - 4_000);
    log(`[live] ${message}`);
  };
  try {
    labA = await labModule.startLabServer({ environmentId: ENVIRONMENT_A, port: 0, configurationDigest });
    labB = await labModule.startLabServer({
      environmentId: ENVIRONMENT_B, port: portB, configurationDigest,
      accounts: ENVIRONMENT_B_ACCOUNTS,
    });
    log(`[live] lab A ${labA.origin}  lab B ${labB.origin}  sandbox digest ${configurationDigest.slice(0, 16)}`);

    const scenario = buildScenario({
      runId, runRoot, snapshotRoot, snapshotBytes, labA, labB,
      workspaceRoot: join(runRoot, 'workspaces'),
      controlRoot: join(runRoot, 'control'),
      vaultRoot: join(runRoot, 'vault'),
      socketPath: join(runRoot, 'b.sock'),
      piBinary,
      extensionPath: join(sourceRoot, 'bridge-extension.js'),
      sandboxOptions,
      configurationDigest,
      now,
    });
    const assessmentPath = join(runRoot, 'assessment.json');
    const manifestPath = join(runRoot, 'run-manifest.json');
    writeFileSync(assessmentPath, `${JSON.stringify(scenario.config, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(manifestPath, `${JSON.stringify(scenario.config.run, null, 2)}\n`, { mode: 0o600 });
    const config = loadApplicationConfig(assessmentPath);

    app = await createApplication(config, {
      upstream: {
        approval: LIVE_GATEWAY_APPROVAL,
        provider: LIVE_SELECTION.provider,
        upstreamBaseUrl: LIVE_UPSTREAM_BASE_URL,
        api: LIVE_API,
        models: [...LIVE_GATEWAY_MODELS],
        credential: {
          accountId: options.credentialAccount ?? 'deepseek-owner-account',
          version: options.credentialVersion ?? 'pi-auth-print-api-key',
          secret: options.apiKey,
        },
        log: logSink,
      },
      credentials: store,
      replayEnvironment: (services: VerificationServices) => createLabReplayEnvironment(services, {
        module: labModule,
        port: portB,
        environmentId: ENVIRONMENT_B,
        initial: () => labB,
        setCurrent: (instance: LabInstance) => { labB = instance; },
        accounts: ENVIRONMENT_B_ACCOUNTS,
      }),
      log: (event: string, detail: string) => logSink(`${event} ${detail}`),
    });

    try {
      const preflight = await app.interfaceBackend.preflight({ manifestPath, mode: 'assessment' });
      log(`[live] preflight issues=${preflight.issues.length} warnings=${preflight.warnings.length}`);
      for (const warning of preflight.warnings.slice(0, 8)) log(`[live]   warning: ${warning}`);
      for (const issue of preflight.issues.slice(0, 8)) log(`[live]   issue: ${issue.code} ${issue.message}`);
    } catch (error) {
      log(`[live] preflight unavailable: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
    }

    await app.admitApprovedRun();
    await app.admitApprovedTasks();
    app.supervisor.start(runId);
    log('[live] run started; waiting for terminal state');
    // The supervisor's own `wait()` caps at a fixed multiple of its operation timeout; a live run needs the
    // full owner-approved deadline, so this harness drives the supervisor until the run is terminal or the
    // declared deadline is reached (then cancels and reports honestly).
    const runDeadlineAt = Date.parse(config.run.budgets.deadlineAt);
    const terminalStates = new Set(['completed', 'failed', 'cancelled']);
    let snapshot = app.supervisor.snapshot(runId);
    let lastProgress = 0;
    while (!terminalStates.has(snapshot.run.state) && Date.now() < runDeadlineAt + 5_000) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      snapshot = await app.supervisor.tick(runId);
      if (Date.now() - lastProgress > 30_000) {
        lastProgress = Date.now();
        log(`[live] progress ${snapshot.tasks.map(task => `${task.taskId}:${task.lifecycleState}/${task.packetState}`).join(' ')}`);
      }
    }
    if (!terminalStates.has(snapshot.run.state)) {
      log('[live] declared deadline reached without a terminal run; cancelling owned execution');
      snapshot = await app.supervisor.cancel(runId);
    }
    log(`[live] run ${snapshot.run.runId} state=${snapshot.run.state} tasks=${snapshot.tasks.map(task => `${task.taskId}:${task.lifecycleState}/${task.packetState}`).join(' ')}`);

    const artifacts = app.artifacts(runId);
    const reportJsonPath = join(runRoot, 'report.json');
    const reportMarkdownPath = join(runRoot, 'report.md');
    writeFileSync(reportJsonPath, `${artifacts.json}\n`, { mode: 0o600 });
    writeFileSync(reportMarkdownPath, `${artifacts.markdown}\n`, { mode: 0o600 });

    const evidence = app.store.listEvidence(runId);
    const results = app.store.listResults(runId);
    const controlRoot = config.roots.control;

    // Controller-owned per-attempt records: gateway attestations, Pi worker sessions and tool receipts.
    const attestations: GatewayAttestation[] = [];
    const workerSessions: LiveWorkerSession[] = [];
    const handlesRoot = join(controlRoot, 'handles');
    for (const entry of readdirSync(handlesRoot)) {
      if (!entry.endsWith('.json')) continue;
      const handle = parseJsonFile<{ attemptId?: string; taskId?: string; controlDir?: string; requested?: { selection?: unknown } }>(join(handlesRoot, entry));
      if (!handle?.attemptId || !handle.taskId || !handle.controlDir) continue;
      const controlDir = handle.controlDir;
      try { if (!statSync(controlDir).isDirectory()) continue; } catch { continue; }
      const worker = parseJsonFile<{ toolPolicy?: { tools?: string[] } }>(join(controlDir, 'worker.json'));
      const exchange = parseJsonFile<GatewayAttestation[]>(join(controlDir, 'gateway-attestation.json'));
      if (Array.isArray(exchange)) attestations.push(...exchange);
      const receipt = parseJsonFile<{ ready?: boolean; events?: Array<{ type?: string; assistant?: unknown }> }>(join(controlDir, 'pi-receipt.json'));
      const events = Array.isArray(receipt?.events) ? receipt.events : [];
      // The worker session receipt records one 'message_end' event per completed model turn; per-turn token
      // usage comes from the durable controller ledger, never from the worker's own record.
      const turns = events.filter(event => event.type === 'message_end').length;
      workerSessions.push({
        attemptId: handle.attemptId,
        taskId: handle.taskId,
        tools: Array.isArray(worker?.toolPolicy?.tools) ? worker.toolPolicy.tools : [],
        turns,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    attestations.sort((left, right) => left.seq - right.seq);

    const toolReceipts: LiveToolReceipt[] = [];
    const observedOrigins = new Set<string>();
    const escapes: string[] = [];
    const approvedOrigins = [labA.origin, labB?.origin].filter((origin): origin is string => typeof origin === 'string');
    for (const receipt of evidence) {
      let collectorRole = 'unknown';
      try { collectorRole = app.vault.inspect(receipt.evidenceId)?.collector.role ?? 'controller'; } catch { collectorRole = 'unverifiable'; }
      const metadata = (receipt.metadata ?? {}) as Record<string, unknown>;
      toolReceipts.push({
        evidenceId: receipt.evidenceId,
        taskId: receipt.taskId,
        attemptId: receipt.attemptId,
        toolName: receipt.provenance.tool.name,
        kind: receipt.kind,
        classification: receipt.classification,
        collectorId: receipt.provenance.collectorId,
        collectorRole,
        environmentId: receipt.provenance.environmentId,
        testOutcome: receipt.test?.outcome ?? null,
        testPurpose: receipt.test?.purpose ?? null,
        checkId: typeof metadata.checkId === 'string' ? metadata.checkId : null,
        observationId: typeof metadata.observationId === 'string' ? metadata.observationId : null,
        collectedAt: receipt.provenance.collectedAt,
      });
      if (receipt.provenance.tool.name !== 'http.request') continue;
      let bytes: Buffer | undefined;
      try { bytes = app.vault.read(receipt.evidenceId); } catch { bytes = undefined; }
      if (!bytes) continue;
      const data = JSON.parse(bytes.toString('utf8')) as { hops?: Array<{ url?: string }> };
      for (const hop of data.hops ?? []) {
        if (typeof hop.url !== 'string') continue;
        let origin: string;
        try { origin = new URL(hop.url).origin; } catch { escapes.push(`${receipt.evidenceId}: unparseable hop url`); continue; }
        observedOrigins.add(origin);
        if (!approvedOrigins.includes(origin)) escapes.push(`${receipt.evidenceId}: ${origin} is outside the approved targets`);
      }
    }
    toolReceipts.sort((left, right) => left.collectedAt.localeCompare(right.collectedAt));

    const ledger = app.store.modelSpendJournal(runId).load(runId) as {
      limits?: { maxTokens?: number; maxCostUsdMicros?: number };
      committed?: { tokens?: number; costMicros?: number };
      overshoot?: { tokens?: number; costMicros?: number };
      settlements?: Record<string, { attemptId?: string; selection?: { provider: string; model: string; thinking: string }; inputTokens?: number; outputTokens?: number; tokens?: number; costMicros?: number; basis?: string }>;
      released?: Record<string, { attemptId?: string; reason?: string }>;
    } | undefined;
    const settlements: LiveTurnSettlement[] = Object.entries(ledger?.settlements ?? {}).map(([turnId, record]) => ({
      turnId,
      attemptId: record.attemptId ?? 'unknown',
      selection: record.selection ?? { provider: 'unknown', model: 'unknown', thinking: 'unknown' },
      inputTokens: record.inputTokens ?? 0,
      outputTokens: record.outputTokens ?? 0,
      tokens: record.tokens ?? 0,
      costMicros: record.costMicros ?? 0,
      basis: record.basis ?? 'provider-usage',
    })).sort((left, right) => left.turnId.localeCompare(right.turnId));

    // Attribute the durable per-turn charges back to each worker session (the worker's own receipt carries no usage).
    for (const session of workerSessions) {
      const charged = settlements.filter(settlement => settlement.attemptId === session.attemptId);
      session.inputTokens = charged.reduce((sum, settlement) => sum + settlement.inputTokens, 0);
      session.outputTokens = charged.reduce((sum, settlement) => sum + settlement.outputTokens, 0);
    }

    const decisions: LiveResultDecision[] = results.map((result: StoredResult) => ({
      taskId: result.taskId,
      attemptId: result.attemptId,
      packetId: result.packet?.packetId ?? null,
      status: result.decision.status,
      contract: result.decision.contract ?? null,
      outcome: result.decision.outcome ?? null,
      reasons: result.decision.reasons.map(reason => reason.code),
    }));

    // Leak audit: the real provider credential must appear in no artifact of this run.
    const audit = async (secrets: string[]): Promise<{ files: number; clean: boolean; detail: string }> => {
      if (!secrets.length) return { files: 0, clean: true, detail: 'no secret material to scan for' };
      try { return { files: await auditArtifactsForSecrets(runRoot, secrets), clean: true, detail: 'absent' }; }
      catch (error) { return { files: 0, clean: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'scan failed' }; }
    };
    const labTokens = [
      labA.tokenFor(ACTOR_GUEST), labA.tokenFor(ACTOR_ADMIN), labB?.tokenFor(ACTOR_GUEST_B),
    ].filter((token): token is string => typeof token === 'string');
    const leakAudit = { providerCredential: await audit([options.apiKey]), labTokens: await audit(labTokens) };

    const accepted = decisions.filter(decision => decision.status === 'accepted').length;
    const reportFindings = artifacts.report.findings.map(finding => ({
      findingId: finding.findingId, state: finding.state, classification: finding.classification,
      evidenceCount: finding.evidenceIds.length, verifier: finding.verifier?.identity ?? null,
    }));
    const verifierOutcomes = logLines.filter(line => line.startsWith('verifier.outcome'));
    const independentlyValidated = reportFindings.filter(finding => finding.state === 'independently-validated').length;
    const acceptanceReasons: string[] = [];
    if (snapshot.run.state !== 'completed') acceptanceReasons.push(`run state is ${snapshot.run.state}`);
    if (accepted < 1) acceptanceReasons.push('no worker packet was accepted');
    if (!reportFindings.length) acceptanceReasons.push('the report carries no reviewed finding');
    if (!independentlyValidated) acceptanceReasons.push('no finding reached independently-validated');
    if (escapes.length) acceptanceReasons.push(`scope escapes: ${escapes.join('; ')}`);
    if (!leakAudit.providerCredential.clean) acceptanceReasons.push(`credential leak audit failed: ${leakAudit.providerCredential.detail}`);
    if (!leakAudit.labTokens.clean) acceptanceReasons.push(`lab token leak audit failed: ${leakAudit.labTokens.detail}`);
    if ((ledger?.committed?.tokens ?? 0) > RUN_MAX_TOKENS) acceptanceReasons.push('run token budget exceeded');
    if ((ledger?.committed?.costMicros ?? 0) > RUN_MAX_COST_USD * 1_000_000) acceptanceReasons.push('run cost budget exceeded');

    const summaryPath = join(runRoot, 'live-summary.json');
    const result: LiveLabResult = {
      runId,
      runRoot,
      runState: snapshot.run.state,
      terminal: ['completed', 'failed', 'cancelled'].includes(snapshot.run.state),
      assessmentStatus: artifacts.report.assessmentStatus,
      reportPaths: { json: reportJsonPath, markdown: reportMarkdownPath, summary: summaryPath },
      report: {
        findings: reportFindings,
        coverage: Object.entries(artifacts.report.coverage.counts).map(([state, count]) => ({ state, count: Number(count) })),
        packets: artifacts.report.packets.map(packet => ({ taskId: packet.taskId, contract: packet.contract, outcome: packet.outcome, classification: packet.classification })),
      },
      gateway: {
        gatewayId: attestations[0]?.gatewayId ?? null,
        credential: attestations[0]?.credential ?? null,
        exchanges: attestations.length,
        forwarded: attestations.filter(entry => entry.outcome === 'forwarded').length,
        denied: attestations.filter(entry => entry.outcome === 'denied').length,
        observed: attestations.map(entry => ({
          provider: entry.observed.provider,
          model: entry.observed.model ?? 'none',
          thinking: entry.observed.thinking,
          matchesRequest: entry.matchesRequest,
        })),
        attestations: attestations.slice(-40),
      },
      spend: {
        limits: { maxTokens: ledger?.limits?.maxTokens ?? 0, maxCostUsd: (ledger?.limits?.maxCostUsdMicros ?? 0) / 1_000_000 },
        committed: { tokens: ledger?.committed?.tokens ?? 0, costMicros: ledger?.committed?.costMicros ?? 0 },
        overshoot: { tokens: ledger?.overshoot?.tokens ?? 0, costMicros: ledger?.overshoot?.costMicros ?? 0 },
        settlements,
        releases: Object.values(ledger?.released ?? {}).map(release => ({ attemptId: release.attemptId ?? 'unknown', reason: release.reason ?? 'unknown' })),
      },
      workerSessions,
      toolReceipts,
      decisions,
      verifierOutcomes,
      scope: { approvedOrigins, observedOrigins: [...observedOrigins].sort(), escapes },
      leakAudit,
      acceptance: { ok: acceptanceReasons.length === 0, reasons: acceptanceReasons },
    };
    writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    // Durable evidence even for a throwaway run: the three report artifacts always survive, and `--keep`
    // additionally retains the full run directory (control dirs, sessions, vault, artifacts).
    if (options.keep !== true) {
      const durable = join(sourceRoot, '.runs', 'latest');
      mkdirSync(durable, { recursive: true, mode: 0o700 });
      for (const [name, path] of [['report.json', reportJsonPath], ['report.md', reportMarkdownPath], ['live-summary.json', summaryPath]] as const) {
        copyFileSync(path, join(durable, name));
      }
      result.reportPaths = { json: join(durable, 'report.json'), markdown: join(durable, 'report.md'), summary: join(durable, 'live-summary.json') };
    }
    return result;
  } finally {
    try { await app?.close(); } catch { /* the app owns its runtimes */ }
    try { await labA?.close(); } catch { /* instance may already be closed */ }
    try { await labB?.close(); } catch { /* instance may already be closed */ }
    if (options.keep !== true && !runRootWasGiven) rmSync(runRoot, { recursive: true, force: true });
    else log(`[live] run directory kept at ${runRoot}`);
  }
}

// ------------------------------------------------------------------------------------------------- print

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(6)}`;

/** Raw, printable evidence summary. Contains no credential material by construction. */
export function formatLiveResult(result: LiveLabResult): string {
  const lines: string[] = [];
  lines.push(`run ${result.runId} state=${result.runState} terminal=${result.terminal} assessmentStatus=${result.assessmentStatus}`);
  lines.push(`ACCEPTANCE ok=${result.acceptance.ok}${result.acceptance.ok ? '' : ` reasons=${result.acceptance.reasons.join(' | ')}`}`);
  lines.push(`gateway id=${result.gateway.gatewayId ?? 'none'} exchanges=${result.gateway.exchanges} forwarded=${result.gateway.forwarded} denied=${result.gateway.denied} credential=${result.gateway.credential ? `${result.gateway.credential.accountId}@${result.gateway.credential.version} ref=${result.gateway.credential.ref.slice(0, 22)}…` : 'none'}`);
  for (const entry of result.gateway.attestations) {
    lines.push(`  attestation seq=${entry.seq} attempt=${entry.attemptId ?? 'unbound'} outcome=${entry.outcome} provider=${entry.observed.provider} model=${entry.observed.model ?? 'none'} thinking=${entry.observed.thinking} thinkingValue=${entry.observed.thinkingValue ?? 'none'} matchesRequest=${entry.matchesRequest} upstream=${entry.upstream ? `${entry.upstream.origin}${entry.upstream.path} status=${entry.upstream.status ?? 'n/a'}` : 'n/a'} spend=${entry.spend ? `${entry.spend.outcome} in=${entry.spend.inputTokens ?? 0} out=${entry.spend.outputTokens ?? 0} micros=${entry.spend.costMicros ?? 0}` : 'none'}`);
  }
  lines.push(`spend ledger limits maxTokens=${result.spend.limits.maxTokens} maxCostUsd=${result.spend.limits.maxCostUsd} committed tokens=${result.spend.committed.tokens} cost=${usd(result.spend.committed.costMicros)} overshoot tokens=${result.spend.overshoot.tokens} cost=${usd(result.spend.overshoot.costMicros)}`);
  for (const settlement of result.spend.settlements) {
    lines.push(`  turn ${settlement.turnId} attempt=${settlement.attemptId} selection=${settlement.selection.provider}/${settlement.selection.model}/${settlement.selection.thinking} in=${settlement.inputTokens} out=${settlement.outputTokens} tokens=${settlement.tokens} cost=${usd(settlement.costMicros)} basis=${settlement.basis}`);
  }
  for (const session of result.workerSessions) {
    lines.push(`  worker attempt=${session.attemptId} task=${session.taskId} tools=[${session.tools.join(',')}] turns=${session.turns} in=${session.inputTokens} out=${session.outputTokens}`);
  }
  lines.push(`worker tool receipts (${result.toolReceipts.length}):`);
  for (const receipt of result.toolReceipts) {
    lines.push(`  ${receipt.evidenceId} task=${receipt.taskId} tool=${receipt.toolName} kind=${receipt.kind} classification=${receipt.classification} role=${receipt.collectorRole}${receipt.testPurpose ? ` purpose=${receipt.testPurpose}` : ''}${receipt.testOutcome ? ` outcome=${receipt.testOutcome}` : ''}${receipt.checkId ? ` check=${receipt.checkId}` : ''}`);
  }
  lines.push(`result decisions (${result.decisions.length}):`);
  for (const decision of result.decisions) {
    lines.push(`  task=${decision.taskId} attempt=${decision.attemptId} status=${decision.status} contract=${decision.contract ?? 'n/a'} outcome=${decision.outcome ?? 'n/a'} packet=${decision.packetId ?? 'none'}${decision.reasons.length ? ` reasons=${decision.reasons.join(',')}` : ''}`);
  }
  for (const outcome of result.verifierOutcomes) lines.push(`  ${outcome}`);
  lines.push(`packets: ${result.report.packets.map(packet => `${packet.taskId}/${packet.contract}/${packet.outcome}/${packet.classification}`).join(', ') || 'none'}`);
  lines.push(`findings: ${result.report.findings.map(finding => `${finding.findingId}=${finding.state}/${finding.classification} evidence=${finding.evidenceCount} verifier=${finding.verifier ?? 'none'}`).join(', ') || 'none'}`);
  lines.push(`coverage: ${result.report.coverage.map(entry => `${entry.state}=${entry.count}`).join(', ')}`);
  lines.push(`scope: approved=[${result.scope.approvedOrigins.join(',')}] observed=[${result.scope.observedOrigins.join(',')}] escapes=${result.scope.escapes.length}${result.scope.escapes.length ? ` (${result.scope.escapes.join('; ')})` : ''}`);
  lines.push(`leak-audit: provider-credential ${result.leakAudit.providerCredential.clean ? 'ABSENT' : 'DETECTED'} (${result.leakAudit.providerCredential.files} files scanned, ${result.leakAudit.providerCredential.detail}); lab-session-tokens ${result.leakAudit.labTokens.clean ? 'ABSENT' : 'DETECTED'} (${result.leakAudit.labTokens.files} files scanned, ${result.leakAudit.labTokens.detail})`);
  lines.push(`report: ${result.reportPaths.json} | ${result.reportPaths.markdown} | ${result.reportPaths.summary}`);
  lines.push(`run directory: ${result.runRoot}`);
  return lines.join('\n');
}

// --------------------------------------------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.env.P2O_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const sourceRoot = process.env.P2O_EXAMPLE_SOURCE ?? join(repoRoot, 'examples', 'live-lab');
  const credential = resolveProviderCredential(join(repoRoot, 'node_modules', '.bin', 'pi'), LIVE_SELECTION.provider);
  if (!credential.key) {
    process.stderr.write(`SKIP: ${credential.detail}\n`);
    process.exitCode = process.argv.includes('--require-live') ? 1 : 0;
  } else {
    process.stdout.write(`[live] credential ${credential.detail}\n`);
    const keep = process.argv.includes('--keep');
    const runId = `live-lab-${Date.now().toString(36)}`;
    runLiveLab({
      apiKey: credential.key, repoRoot, sourceRoot, runId, keep,
      ...(keep ? { runRoot: join(sourceRoot, '.runs') } : {}),
      log: (message: string) => process.stdout.write(`${message}\n`),
    }).then(result => {
      process.stdout.write(`${formatLiveResult(result)}\n`);
      process.exitCode = result.acceptance.ok ? 0 : 2;
    }).catch(error => {
      process.stderr.write(`LIVE RUN FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
  }
}
