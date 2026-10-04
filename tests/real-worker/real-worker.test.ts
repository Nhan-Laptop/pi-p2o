// Real `pi` process as the assessment worker, now also driven through the controller-owned model gateway
// and the supervisor's model spend ledger.
//
// The worker is the project-pinned Pi binary (1.0.0) launched by the real headless runtime adapter in RPC
// mode with only the owner-pinned bridge extension tools. The worker sees only the loopback
// credential-owning controller gateway with a minted attempt-scoped placeholder; that gateway injects the
// owner credential and forwards to the deterministic loopback gateway fixture, which scripts fixed model
// turns and reports real OpenAI usage (`prompt_tokens`/`completion_tokens`) for every turn. There is no
// provider call and no real credential anywhere in this test.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication, validateApplicationConfig, type AssessmentApplication } from '../../src/application/index.js';
import { createLocalFixtureSandbox } from '../../src/tools/index.js';
import { ModelSpendBudget, PINNED_MODEL_PRICES, modelPriceKey, type ModelSpendState } from '../../src/policy/index.js';
import type { RuntimeHandle } from '../../src/runtime/index.js';
import { startFixture, type FixtureInstance } from '../../examples/local-assessment/fixture-server.js';
import {
  REAL_WORKER_ACTOR, REAL_WORKER_ENVIRONMENT, REAL_WORKER_GATEWAY_APPROVAL, REAL_WORKER_MODEL,
  REAL_WORKER_OBSERVATION_BASELINE, REAL_WORKER_OBSERVATION_DENIED, REAL_WORKER_PACKET_ID,
  REAL_WORKER_PI_VERSION, REAL_WORKER_PROVIDER, REAL_WORKER_REFUSED_RUN_ID, REAL_WORKER_REFUSED_TURN_RUN_ID, REAL_WORKER_RUN_ID,
  REAL_WORKER_SNAPSHOT_FILE, REAL_WORKER_TASK_ID, REAL_WORKER_THINKING, REAL_WORKER_TOOLS,
  buildRealWorkerScenario,
} from './scenario.js';

interface GatewayUsage { prompt_tokens: number; completion_tokens: number; total_tokens?: number }
interface GatewayTurn {
  turn: number; path: string; authorization: string;
  body: { model?: string; messages?: Message[]; max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number; n?: number };
  /** [T9] Exact request payload byte length the controller gateway measured for this turn. */
  bytes: number;
  promptTokens?: number;
  usage?: GatewayUsage;
  reservationsAtRequest?: GatewayRequestObservation;
}
interface ToolCall { id?: string; function?: { name?: string; arguments?: string } }
interface Message { role?: string; tool_call_id?: string; content?: unknown; tool_calls?: ToolCall[] }
interface ToolExchange { toolCallId: string; name: string; args: Record<string, unknown>; content: string }
interface GatewayRequest { turn: number; path: string; authorization: string; model: string; body: { messages?: Message[] }; bytes: number; promptTokens: number }
/** The controller ledger state observed from inside the gateway handler while a provider request is in flight. */
interface GatewayRequestObservation {
  turn: number;
  at: number;
  reservations: Record<string, { attemptId: string; reservedTokens: number; reservedCostMicros: number; createdAt: number }>;
  settlements: number;
  releases: number;
  /** [T9] Durable per-turn charges recorded before this provider request arrived. */
  turnSettlements: number;
  /** [T9] Tokens already charged to the run before this provider request arrived. */
  chargedTokens: number;
}
interface InertGateway {
  origin: string;
  placeholderKey: string;
  turns: GatewayTurn[];
  toolResults: string[];
  errors: string[];
  close(): Promise<void>;
}
interface InertGatewayModule {
  startInertGateway(options?: { maxExchanges?: number; onRequest?: (request: GatewayRequest) => unknown }): Promise<InertGateway>;
}
interface SessionAssistantUsage { input: number; output: number; costTotal: number }
type RealWorkerSnapshot = ReturnType<AssessmentApplication['supervisor']['snapshot']>;

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);
const DEADLINE_MS = 120_000;
/** Controller pre-dispatch denial codes: policy scope/account/action plus the store's target-budget fence. */
const DENIAL_CODE = /TARGET_DENIED|target-required|policy-denied|out-of-scope|unapproved|ACCOUNT_DENIED|CAPABILITY_DENIED|ADDRESS_DENIED|IDENTITY_DENIED|ACTION_DENIED|BUDGET_EXCEEDED|RATE_LIMITED|EXPIRED/;

/** Every key src/runtime/config.ts cleanEnvironment() injects; anything else would be an escaping credential. */
const WORKER_ENV_KEYS = ['HOME', 'LANG', 'PATH', 'P2O_CONFIG', 'P2O_ISOLATED', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'TERM', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const;
/** Secret-shaped values that must never reach worker inputs or run artifacts. */
const SECRET_SHAPE = /sk-[A-Za-z0-9_-]{16,}/;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** [T8] A synthetic but secret-shaped owner credential: the controller gateway holds it, the worker must never see it. */
const UPSTREAM_ACCOUNT = 'fixture-upstream-owner';
const UPSTREAM_SECRET = 'sk-t8fixtureupstreamcredential0123456789';
/** A placeholder minted by the controller gateway, never the upstream secret. */
const CONTROLLER_PLACEHOLDER = /^p2o-gw\.v1\.[0-9a-f]{8}\.[0-9a-f]{32}$/;
const CONTROLLER_GATEWAY_URL = /^http:\/\/127\.0\.0\.1:\d+\/p2o-gw\/[0-9a-f]{8}$/;
/**
 * [T9] Declared owner bounds for the successful run. `maxOutputTokens` is the supervisor-declared
 * per-turn completion bound; the per-turn input bound is derived from the actual request payload bytes.
 */
const SPEND_BOUND = { inputTokensUpperBound: 8_000, maxOutputTokens: 4_096 } as const;
/** Declared owner bounds for the refusal run: input bound + max output cannot fit the 4000-token run budget. */
const REFUSED_SPEND_BOUND = { inputTokensUpperBound: 4_000, maxOutputTokens: 512 } as const;
/** [T8/S1] Default-enforcement run: no spend plan is declared at all; only the run budgets exist. */
const REAL_WORKER_DEFAULT_RUN_ID = 'run-real-worker-default';
/**
 * [T9] Run budget for the successful real-worker run. Every provider turn must fit its payload-derived
 * worst case (request bytes + declared max output) next to the spend already committed by earlier turns.
 */
const MAIN_RUN_MAX_TOKENS = 96_000;
/** Large enough for the default prompt-bound plus per-turn payload bounds of one sequential attempt. */
const DEFAULT_RUN_MAX_TOKENS = 400_000;
/**
 * [T9] Nearly-exhausted run for the mid-conversation refusal witness. From the measured payloads of the
 * six-turn conversation, each admitted turn needs `committed + payload bytes + 4096` to fit the budget:
 * turn 1 needs 7 863 and turn 2 needs 12 301, both inside this limit, while turn 3 needs 15 207 and is
 * therefore refused before the provider is contacted (the packet-producing turn never happens).
 */
const PER_TURN_REFUSAL_RUN_MAX_TOKENS = 13_000;
/** The completion bound the supervisor declares when the owner declares none (min(4096, budget - prompt)). */
const PER_TURN_REFUSAL_DEFAULT_OUTPUT = 4_096;

/** Host provider credentials, read in-process for an absence check only; never written or logged. */
function hostCredentials(): string[] {
  try {
    const auth = parseJson<Record<string, unknown>>(readFileSync(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8'), 'host auth store');
    return Object.values(auth).flatMap(entry => entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string' ? [(entry as { key: string }).key] : []);
  } catch { return []; }
}

/** Bounded recursive read of every artifact under the isolated run root; binary files keep their latin1 view. */
function runArtifacts(root: string): Array<{ path: string; text: string; textLike: boolean }> {
  const found: Array<{ path: string; text: string; textLike: boolean }> = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= 2000) return;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && statSync(absolute).size <= MAX_SCAN_BYTES) {
        const bytes = readFileSync(absolute);
        let textLike = true;
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { textLike = false; }
        found.push({ path: relative(root, absolute), text: bytes.toString('latin1'), textLike });
      }
    }
  };
  visit(root);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert.ok(value && value.trim(), `${name} must point at the real repository path`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJson<T>(text: string, label: string): T {
  try { return JSON.parse(text) as T; } catch (error) {
    assert.fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The durable model spend journal as stored for the run (read-only). */
function journalState(app: AssessmentApplication, runId: string): ModelSpendState | undefined {
  return app.store.modelSpendJournal(runId).load(runId) as ModelSpendState | undefined;
}

/** The provider-reported usage Pi itself persisted for every assistant turn of this attempt. */
function sessionAssistantUsages(sessionFile: string): SessionAssistantUsage[] {
  const usages: SessionAssistantUsage[] = [];
  for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const message = (parsed as { message?: unknown }).message;
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; usage?: unknown };
    if (record.role !== 'assistant' || !record.usage || typeof record.usage !== 'object') continue;
    const usage = record.usage as { input?: unknown; output?: unknown; cost?: { total?: unknown } };
    usages.push({ input: Number(usage.input ?? 0), output: Number(usage.output ?? 0), costTotal: Number(usage.cost?.total ?? 0) });
  }
  return usages;
}

/** USD-per-million-token quote to integer micro-USD, exactly as the pinned ledger prices it. */
function microsFor(tokens: number, microsPerMillion: number): number {
  return Math.ceil((tokens * microsPerMillion) / 1_000_000);
}

/**
 * Rebuild the ordered bridge tool exchanges the real Pi process performed, from the OpenAI transcripts it
 * sent to the loopback gateway. Each exchange pairs the assistant tool call (name + arguments) with the tool
 * result the real extension/bridge returned to Pi.
 */
function toolExchanges(turns: GatewayTurn[]): ToolExchange[] {
  const calls = new Map<string, { name: string; args: string }>();
  const exchanges: ToolExchange[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    for (const message of turn.body.messages ?? []) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          calls.set(String(call.id ?? ''), { name: String(call.function?.name ?? ''), args: String(call.function?.arguments ?? '{}') });
        }
        continue;
      }
      if (message.role !== 'tool') continue;
      const toolCallId = String(message.tool_call_id ?? '');
      if (seen.has(toolCallId)) continue;
      seen.add(toolCallId);
      const call = calls.get(toolCallId) ?? { name: '', args: '{}' };
      exchanges.push({
        toolCallId, name: call.name,
        args: parseJson<Record<string, unknown>>(call.args || '{}', `${call.name} arguments`),
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      });
    }
  }
  return exchanges;
}

interface RealWorkerRun {
  app: AssessmentApplication;
  gateway: InertGateway;
  fixture: FixtureInstance;
  logs: string[];
  upstreamLog: string[];
  runRoot: string;
  controlRoot: string;
  snapshot: RealWorkerSnapshot;
  /** Doctor/preflight report captured before admission (the same surface `p2o_preflight` uses). */
  preflight: Awaited<ReturnType<AssessmentApplication['interfaceBackend']['preflight']>>;
  /** Verified pinned worker CLI identity (package, version and content hash). */
  pin: { cliPath: string; packageRoot: string; version: string; sha256: string };
  /** Journal state captured by the gateway handler for every provider request it received. */
  observations: GatewayRequestObservation[];
  journal(): ModelSpendState | undefined;
  close(): Promise<void>;
}

/**
 * Launch one real pinned-Pi attempt for the owner-approved real-worker scenario, through the
 * controller-owned model gateway and the supervisor's durable model spend ledger.
 */
async function launchRealWorker(options: {
  runId: string;
  /** [T8/S1] Owner-document spend bounds. Enforcement itself is on with or without them. */
  spend?: { inputTokensUpperBound?: number; maxOutputTokens?: number };
  /** Declared run token budget; defaults to the scenario's 4 000. */
  runMaxTokens?: number;
  /** [T9] Task attempt budget; 1 keeps a mid-run refusal a single-attempt witness. */
  taskMaxAttempts?: number;
  /** Selection override, used to prove an unpriceable run is refused. */
  selection?: { provider: string; model: string; thinking: 'max' };
}): Promise<RealWorkerRun> {
  const repoRoot = requiredEnv('P2O_REPO_ROOT');
  const realWorkerSource = requiredEnv('P2O_REAL_WORKER_SOURCE');
  const piBinary = join(repoRoot, 'node_modules', '.bin', 'pi');
  const extensionPath = join(repoRoot, 'examples', 'local-assessment', 'bridge-extension.js');

  // [T8/S3] Version AND content hash: a wrapper that merely prints 1.0.0 cannot masquerade as the worker.
  const pinModule = await import(pathToFileURL(join(realWorkerSource, 'pi-pin.mjs')).href) as { verifyPiCli(piBinary: string): { cliPath: string; packageRoot: string; version: string; sha256: string } };
  const version = spawnSync(piBinary, ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, `real pinned pi --version must exit 0 (stderr: ${version.stderr})`);
  assert.equal(version.stdout.trim(), REAL_WORKER_PI_VERSION,
    `the project-pinned pi binary must report exactly ${REAL_WORKER_PI_VERSION}`);
  const pin = pinModule.verifyPiCli(piBinary);
  assert.equal(pin.version, REAL_WORKER_PI_VERSION, 'the resolved package version must be the pinned worker version');
  assert.equal(pin.cliPath, realpathSync(piBinary), 'the verified CLI must be the resolved worker binary');

  const gatewayModule = await import(pathToFileURL(join(realWorkerSource, 'inert-gateway.mjs')).href) as InertGatewayModule;
  const logs: string[] = [];
  const upstreamLog: string[] = [];
  const observations: GatewayRequestObservation[] = [];
  let app: AssessmentApplication | undefined;
  // The observation seam: every provider request is checked against the durable spend journal before the
  // gateway answers it, which is what proves the reservation was taken before the provider request.
  const gateway = await gatewayModule.startInertGateway({
    onRequest: request => {
      const state = app ? journalState(app, options.runId) : undefined;
      const settlements = state?.settlements ?? {};
      const observed: GatewayRequestObservation = {
        turn: request.turn, at: Date.now(),
        reservations: (state?.reservations ?? {}) as GatewayRequestObservation['reservations'],
        settlements: Object.keys(settlements).length,
        releases: Object.keys(state?.released ?? {}).length,
        // [T9] Per-turn charges recorded by the controller gateway before this request reached the provider.
        turnSettlements: Object.keys(settlements).filter(id => id.includes(':turn-')).length,
        chargedTokens: Object.values(settlements).reduce((sum, record) => sum + record.tokens, 0),
      };
      observations.push(observed);
      return observed;
    },
  });

  let fixture: FixtureInstance | undefined;
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'p2o-real-worker-')));
  const snapshotRoot = join(runRoot, 'snapshot');
  const workspaceRoot = join(runRoot, 'workspaces');
  const controlRoot = join(runRoot, 'control');
  const vaultRoot = join(runRoot, 'vault');
  const socketPath = join(runRoot, 'run', 'worker-bridge.sock');
  const close = async (): Promise<void> => {
    await app?.close().catch(() => {});
    await fixture?.close().catch(() => {});
    await gateway.close().catch(() => {});
    rmSync(runRoot, { recursive: true, force: true });
  };
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
    fixture = await startFixture({
      environmentId: REAL_WORKER_ENVIRONMENT,
      port: 0,
      configurationDigest: sandboxIdentity.configurationDigest,
    });

    const scenario = buildRealWorkerScenario({
      runId: options.runId,
      runRoot,
      snapshotRoot,
      snapshotBytes,
      fixture,
      workspaceRoot,
      controlRoot,
      vaultRoot,
      socketPath,
      extensionPath,
      piBinary,
      gatewayOrigin: gateway.origin,
      now: Date.now(),
      ...(options.runMaxTokens === undefined ? {} : { runMaxTokens: options.runMaxTokens }),
      ...(options.taskMaxAttempts === undefined ? {} : { taskMaxAttempts: options.taskMaxAttempts }),
      ...(options.spend === undefined ? {} : { spend: options.spend }),
      ...(options.selection === undefined ? {} : { selection: options.selection }),
    });
    const config = validateApplicationConfig(scenario.config);
    app = await createApplication(config, {
      log: (event, detail) => logs.push(`${event} ${detail}`),
      // [T8/S1] NO spend override: the composition always builds the ledger from the run manifest, and the
      // owner-declared bounds travel in the document (`config.spend`).
      // One controller-owned model gateway per run holds the synthetic upstream credential; the worker only
      // ever sees its loopback mount and a minted attempt-scoped placeholder.
      upstream: {
        approval: REAL_WORKER_GATEWAY_APPROVAL,
        provider: options.selection?.provider ?? REAL_WORKER_PROVIDER,
        upstreamBaseUrl: gateway.origin,
        api: config.runtime.gateway.api,
        models: config.runtime.gateway.models,
        credential: { accountId: UPSTREAM_ACCOUNT, version: 'v1', secret: UPSTREAM_SECRET },
        log: line => upstreamLog.push(line),
      },
    });
    // [T8/S1] Read-only doctor/preflight report (the `p2o_preflight` surface) must name the effective spend
    // plan without contacting a model. It is taken before admission so it cannot observe a durable run.
    const manifestPath = join(runRoot, 'run-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(config.run, null, 2)}\n`, { mode: 0o600 });
    const preflight = await app.interfaceBackend.preflight({ manifestPath, mode: 'fixture' });
    await app.admitApprovedRun();
    await app.admitApprovedTasks();
    app.supervisor.start(options.runId);

    const deadline = Date.now() + DEADLINE_MS;
    let snapshot = app.supervisor.snapshot(options.runId);
    while (!TERMINAL_RUN_STATES.has(snapshot.run.state) && Date.now() < deadline) {
      await sleep(200);
      snapshot = app.supervisor.snapshot(options.runId);
    }
    assert.ok(TERMINAL_RUN_STATES.has(snapshot.run.state),
      `real-Pi run must reach a terminal state within ${DEADLINE_MS}ms; observed ${snapshot.run.state} with ${snapshot.attempts.length} attempt(s)`);
    assert.equal(gateway.errors.length, 0, `the scripted gateway must not report contract errors: ${gateway.errors.join(' | ')}`);
    return {
      app, gateway, fixture, logs, upstreamLog, runRoot, controlRoot, snapshot, observations, preflight, pin,
      journal: () => journalState(app!, options.runId),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('real pinned pi worker drives the controller gateway, the spend ledger, the bridge and the evidence vault', { timeout: DEADLINE_MS + 60_000 }, async (t) => {
  const run = await launchRealWorker({ runId: REAL_WORKER_RUN_ID, runMaxTokens: MAIN_RUN_MAX_TOKENS, spend: { ...SPEND_BOUND } });
  const { app, gateway, fixture, logs, upstreamLog, runRoot, controlRoot, snapshot, observations, pin } = run;
  try {
    t.diagnostic(`run state=${snapshot.run.state} tasks=${snapshot.tasks.map(task => `${task.taskId}:${task.lifecycleState}/${task.packetState}`).join(',')} attempts=${snapshot.attempts.length} results=${snapshot.results.length}`);

    const attempt = snapshot.attempts.find(candidate => candidate.taskId === REAL_WORKER_TASK_ID);
    assert.ok(attempt, 'the real-Pi worker must produce one durable attempt for the approved task');
    const attemptId = attempt.attemptId;
    const handle = parseJson<{
      toolPolicy: { mode: string; tools: string[]; extension: { path: string } };
      controlDir: string;
      workspace: string;
      sessionFile: string;
      status: string;
      native: { guardian?: unknown; processes: unknown[] };
      events: Array<{ type: string; cursor: number }>;
    }>(readFileSync(join(controlRoot, 'handles', `${attemptId}.json`), 'utf8'), 'durable runtime handle');
    const worker = parseJson<{ args: string[]; env: Record<string, string> }>(readFileSync(join(handle.controlDir, 'worker.json'), 'utf8'), 'durable worker config');
    const receipt = parseJson<{ ready: boolean; error?: string; events: Array<{ type: string; selection?: { thinking?: string } }> }>(
      readFileSync(join(handle.controlDir, 'pi-receipt.json'), 'utf8'), 'durable Pi receipt');

    // (a) the real Pi binary ran and reached the scripted provider boundary through the controller gateway.
    assert.ok(gateway.turns.length >= 1, 'the real Pi process must have sent at least one request to the loopback gateway');
    for (const turn of gateway.turns) {
      assert.equal(turn.path, '/chat/completions', 'Pi must post only the OpenAI chat completions route to the gateway');
      assert.equal(turn.authorization, `Bearer ${UPSTREAM_SECRET}`,
        'the controller gateway must inject the owner credential on the upstream hop (never the worker placeholder)');
    }
    // The accepted packet aborts the session before any terminal-prose provider turn: exactly five upstream
    // requests (context, three owner-approved observations, packet decision) and no sixth 'done' turn.
    assert.equal(gateway.turns.length, 5,
      `the real Pi agent loop must stop at exactly five provider turns (no terminal prose), saw ${gateway.turns.length}`);
    assert.ok(worker.args.includes('--mode') && worker.args[worker.args.indexOf('--mode') + 1] === 'rpc',
      'the durable worker config must launch Pi in RPC mode');
    assert.ok(attempt.observedRuntime, 'the durable attempt must carry the controller runtime observation');
    assert.deepEqual(attempt.observedRuntime.selection,
      { provider: REAL_WORKER_PROVIDER, model: REAL_WORKER_MODEL, thinking: REAL_WORKER_THINKING },
      'the attested runtime selection must equal the requested provider/model/thinking');
    const exchanges = toolExchanges(gateway.turns);
    // `toolExchanges` pairs each assistant tool call with the tool result the NEXT provider request carries.
    // The p2o_packet call is the response to the fifth request and the accepted-packet abort prevents a sixth
    // request, so the four result-bearing exchanges are the context and three broker calls; the packet call is
    // proven below from the durable packet gate and the preserved p2o_packet bytes.
    assert.deepEqual(exchanges.map(exchange => exchange.name), ['p2o_context', 'p2o_broker', 'p2o_broker', 'p2o_broker'],
      'the real Pi agent loop must execute the four result-bearing scripted bridge tool calls in order');

    // (b) controller-derived evidence receipt for the approved baseline check.
    const evidence = app.store.listEvidence(REAL_WORKER_RUN_ID);
    const baseline = evidence.find(entry => entry.evidenceId.startsWith(`${REAL_WORKER_OBSERVATION_BASELINE}-`));
    assert.ok(baseline, `the approved baseline check must mint a durable receipt; got ${evidence.map(entry => entry.evidenceId).join(', ') || 'none'}`);
    assert.equal(baseline.provenance.tool.name, 'http.request', 'baseline evidence must come from the real http.request broker tool');
    assert.equal(baseline.attemptId, attemptId, 'baseline evidence must belong to the real-Pi attempt');
    assert.equal(baseline.test?.outcome, 'passed', 'the controller must evaluate the approved baseline expectation');
    assert.equal(baseline.test?.purpose, 'baseline', 'the controller must derive the baseline test purpose');

    // (c) the out-of-scope probe was denied before any dispatch and produced no evidence.
    assert.equal(evidence.filter(entry => entry.evidenceId.startsWith(`${REAL_WORKER_OBSERVATION_DENIED}-`)).length, 0,
      'a denied observation must never mint an evidence receipt');
    const deniedExchange = exchanges.find(exchange => exchange.name === 'p2o_broker' && exchange.args.observationId === REAL_WORKER_OBSERVATION_DENIED);
    assert.ok(deniedExchange, 'the real worker must attempt the owner-approved denied observation');
    const denial = deniedExchange.content;
    assert.match(denial, DENIAL_CODE,
      `the denied probe must surface the controller denial to the worker; observed tool result: ${denial.slice(0, 400)}`);
    assert.ok(logs.some(line => line.includes('bridge-error') && line.includes('broker.execute') && DENIAL_CODE.test(line)),
      `the controller bridge must log the pre-dispatch denial; logs: ${logs.filter(line => line.includes('bridge-error')).join(' | ')}`);
    assert.equal(fixture.requests, 1, 'the fixture must answer exactly the one approved baseline request');

    // (d) the worker-written packet was preserved by the collector bridge and accepted by the real gates.
    const task = snapshot.tasks.find(candidate => candidate.taskId === REAL_WORKER_TASK_ID);
    assert.equal(task?.packetState, 'accepted', 'the real contract gates must accept the worker packet');
    const results = app.store.listResults(REAL_WORKER_RUN_ID);
    assert.equal(results.length, 1, 'exactly one result may be admitted for the task');
    assert.equal(results[0]!.decision.status, 'accepted', `packet must be accepted: ${results[0]!.decision.reasons.map(r => r.code).join(', ')}`);
    assert.equal(results[0]!.packet.packetId, REAL_WORKER_PACKET_ID, 'the accepted packet must be the worker-written packet');
    assert.ok(results[0]!.packet.limits.failedAssumptions.some(text => text.includes(REAL_WORKER_OBSERVATION_DENIED)),
      'the denial must be recorded as a bounded negative/failed observation limit, not as evidence');
    const artifacts = app.artifacts(REAL_WORKER_RUN_ID);
    writeFileSync(join(runRoot, 'report.json'), `${artifacts.json}\n`, { mode: 0o600 });
    assert.ok(artifacts.report.packets.some(packet => packet.packetId === REAL_WORKER_PACKET_ID),
      'the report artifacts must contain the accepted packet');
    const preserved = app.vault.list(REAL_WORKER_RUN_ID).find(entry => entry.evidenceId.startsWith('pkt-'));
    assert.ok(preserved, 'the supervisor collector bridge must preserve the worker packet in the evidence vault');
    const admission = app.vault.inspect(preserved.evidenceId);
    assert.ok(admission, 'the vault must hold the immutable admission record for the preserved packet');
    // The accepted-packet abort means the p2o_packet call never appears in a later provider request body. The
    // extension's p2o_packet tool is the only writer of the packet file (the pinned allowlist has no
    // builtin/filesystem tool) and the collector preserves exactly those bytes; the workspace file plus the
    // vault admission record below bind the exact p2o_packet argument the real worker sent.
    const workerPacketBytes = readFileSync(join(handle.workspace, 'handoff.packet.json'));
    assert.ok(workerPacketBytes.byteLength > 0, 'the real worker must have written one nonempty p2o_packet argument');
    assert.equal(admission.originalDigest, createHash('sha256').update(workerPacketBytes).digest('hex'),
      'the vault admission record must bind the exact bytes the real worker wrote through p2o_packet');
    assert.equal(admission.originalBytes, workerPacketBytes.byteLength,
      'the vault admission record must record the original worker packet byte length');
    const workerPacket = parseJson<{ packetId: string; attemptId: string; evidenceIds: string[]; limits: { negativeControlEvidenceIds: string[]; failedAssumptions: string[] }; observedRuntime: { attestation: string; receiptEvidenceIds: string[] } }>(workerPacketBytes.toString('utf8'), 'preserved worker packet');
    assert.equal(workerPacket.packetId, REAL_WORKER_PACKET_ID, 'the preserved bytes must be the packet the real worker authored');
    assert.equal(workerPacket.attemptId, attemptId, 'the preserved packet must belong to the real-Pi attempt');
    assert.ok(workerPacket.evidenceIds.includes(baseline.evidenceId),
      'the preserved packet must reference the controller-minted baseline receipt');
    assert.equal(workerPacket.limits.negativeControlEvidenceIds.length, 0, 'the denied probe is not a negative-control receipt');
    assert.deepEqual(JSON.parse(app.vault.read(preserved.evidenceId).toString('utf8')), workerPacket,
      'the preserved vault artifact must carry exactly the worker-authored packet content');
    // The real gate echoes the worker bytes except for `observedRuntime`, which the supervisor replaces with
    // its own controller-attested observation of the attempt before admission.
    const { observedRuntime: acceptedRuntime, ...acceptedContent } = results[0]!.packet;
    const { observedRuntime: workerRuntime, ...workerContent } = workerPacket;
    assert.deepEqual(acceptedContent, workerContent,
      'the accepted packet must be exactly the preserved p2o_packet bytes apart from the controller-attested runtime');
    assert.equal(acceptedRuntime.attestation, 'attested', 'the accepted packet must carry the controller-attested runtime observation');
    assert.ok(acceptedRuntime.receiptEvidenceIds.length >= 1, 'the controller-attested runtime must bind its receipt ids');
    assert.ok(workerRuntime.attestation.length > 0, 'the worker-authored packet must declare a runtime observation to be replaced');
    // The durable gate event binds the same packet content: `packet.schema-valid` is appended by the store when
    // the extension's p2o_packet -> packet.admit path submits the workspace file to the real admission gate.
    const packetGateEvents = app.store.listEvents({ runId: REAL_WORKER_RUN_ID }).filter(event => event.type === 'packet.schema-valid');
    assert.equal(packetGateEvents.length, 1, 'exactly one worker packet may reach the real admission gate');
    assert.equal(packetGateEvents[0]!.payload.packetId, REAL_WORKER_PACKET_ID, 'the gate event must bind the worker packet id');
    assert.equal(packetGateEvents[0]!.payload.digest, results[0]!.digest, 'the gate event must bind the accepted packet digest');
    assert.ok(artifacts.report.packets.some(packet => packet.evidenceIds.includes(baseline.evidenceId)),
      'the accepted packet must reference the controller-minted baseline evidence id');

    // (e) the observed tool allowlist is exactly the three p2o tools; no built-in tool could run.
    assert.equal(handle.toolPolicy.mode, 'sandbox-extension', 'the durable handle must pin a sandbox extension tool policy');
    assert.deepEqual(handle.toolPolicy.tools, [...REAL_WORKER_TOOLS], 'the durable handle must pin exactly the three p2o tools');
    const extensionPath = join(requiredEnv('P2O_REPO_ROOT'), 'examples', 'local-assessment', 'bridge-extension.js');
    assert.equal(handle.toolPolicy.extension.path, extensionPath, 'the pinned extension must be the real bridge extension');
    assert.ok(worker.args.includes('--no-builtin-tools'), 'the durable worker config must disable built-in tools');
    const toolsIndex = worker.args.indexOf('--tools');
    assert.ok(toolsIndex >= 0 && worker.args[toolsIndex + 1] === REAL_WORKER_TOOLS.join(','),
      `the durable worker config must allow exactly ${REAL_WORKER_TOOLS.join(',')}; got ${String(worker.args[toolsIndex + 1])}`);
    assert.equal(receipt.ready, true, `the Pi receipt extension must attest readiness (getActiveTools === policy tools, no builtin); error: ${receipt.error ?? 'none'}`);
    assert.equal(receipt.error, undefined, 'the Pi receipt must not record a tool-policy or environment error');
    assert.ok(receipt.events.some(event => event.type === 'session_start' && event.selection?.thinking === REAL_WORKER_THINKING),
      'the durable Pi receipt must record the effective thinking selection from the started session');
    const extensionArgs = worker.args.flatMap((value, index) => (value === '--extension' ? [String(worker.args[index + 1])] : []));
    assert.equal(extensionArgs.length, 2, `exactly the pinned bridge extension and the runtime receipt extension must load; got ${JSON.stringify(extensionArgs)}`);
    assert.equal(extensionArgs[0], extensionPath, 'the pinned bridge extension must load first');
    assert.match(String(extensionArgs[1]), /pi-receipts\.(js|ts)$/, 'the runtime receipt extension must load last so it observes the final tool allowlist');

    // (f) prompt-delivered, working-observed and result-accepted are distinct durable states.
    const runtimeTypes = handle.events.map(event => event.type);
    const promptIndex = runtimeTypes.indexOf('prompt-delivered');
    const agentStartIndex = runtimeTypes.indexOf('pi:agent_start');
    assert.ok(promptIndex >= 0, `the runtime record must show prompt delivery, saw ${runtimeTypes.join(',') || 'nothing'}`);
    assert.ok(agentStartIndex > promptIndex, 'working observation (pi:agent_start) must follow delivered prompts, not be inferred from them');
    assert.ok(runtimeTypes.includes('pi:agent_settled'), 'Pi settlement must be recorded separately from prompt delivery');
    assert.ok(handle.native.guardian || handle.native.processes.length > 0, 'working observation must include a native process identity');
    const durableEvents = app.store.listEvents({ runId: REAL_WORKER_RUN_ID });
    const workingEvent = durableEvents.find(event => event.type === 'attempt.observed' && event.payload.to === 'running');
    assert.ok(workingEvent, 'the durable store must record the working (running) transition');
    const observationRejections = durableEvents.filter(event => event.type === 'orchestrator.observation-rejected');
    const readyEvent = durableEvents.find(event => event.type === 'packet.ready' || event.type === 'packet.schema-valid');
    const acceptedEvent = durableEvents.find(event => event.type === 'result.accepted');
    assert.ok(readyEvent && acceptedEvent, `packet readiness and result acceptance must be separate durable events; saw ${durableEvents.map(event => event.type).join(',')}`);
    assert.ok(readyEvent.sequence > workingEvent.sequence && acceptedEvent.sequence > readyEvent.sequence,
      'prompt/working/ready/accepted ordering must be monotonic in the durable record');

    // (g) credential isolation: placeholder only, and no host credential anywhere the worker or run touched.
    assert.deepEqual(Object.keys(worker.env).sort(), [...WORKER_ENV_KEYS].sort(),
      'the worker environment must be exactly the fixed runtime allowlist');
    assert.equal(worker.env.PI_CODING_AGENT_DIR, join(worker.env.HOME, '.pi', 'agent'), 'the worker config home must be its private HOME');
    assert.deepEqual(parseJson<Record<string, unknown>>(readFileSync(join(worker.env.PI_CODING_AGENT_DIR, 'auth.json'), 'utf8'), 'worker auth store'), {},
      'the isolated worker auth store must be empty');
    const workerModels = parseJson<{ providers: Record<string, { baseUrl?: string; apiKey?: string }> }>(
      readFileSync(join(worker.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'), 'worker models catalog');
    assert.match(String(workerModels.providers[REAL_WORKER_PROVIDER]?.apiKey), CONTROLLER_PLACEHOLDER,
      'the worker may only see a controller-minted attempt placeholder credential');
    assert.notEqual(workerModels.providers[REAL_WORKER_PROVIDER]?.apiKey, UPSTREAM_SECRET, 'the upstream secret must never reach the worker catalog');
    assert.match(String(workerModels.providers[REAL_WORKER_PROVIDER]?.baseUrl), CONTROLLER_GATEWAY_URL,
      'the worker catalog must point only at the loopback controller gateway mount');
    assert.notEqual(workerModels.providers[REAL_WORKER_PROVIDER]?.baseUrl, gateway.origin, 'the worker must not address the upstream gateway directly');
    const sessionHeader = parseJson<{ cwd?: string }>(readFileSync(handle.sessionFile, 'utf8').split('\n')[0]!, 'worker session header');
    assert.equal(sessionHeader.cwd, handle.workspace, 'the worker process cwd must be its private task workspace');
    assert.ok(handle.workspace.startsWith(`${runRoot}${sep}`), 'the worker workspace must live inside the isolated run root');
    const credentials = hostCredentials();
    const secretScanTargets = [{ path: 'worker argv', text: worker.args.join('\n'), textLike: true }, { path: 'worker env', text: JSON.stringify(worker.env), textLike: true }, ...runArtifacts(runRoot)];
    // The controller gateway's own log sink must be credential-redacted too.
    secretScanTargets.push({ path: 'controller gateway log', text: upstreamLog.join('\n'), textLike: true });
    for (const target of secretScanTargets) {
      for (const credential of credentials) assert.ok(!target.text.includes(credential), `${target.path} must not contain a host provider credential`);
      assert.ok(!target.text.includes(UPSTREAM_SECRET), `${target.path} must not contain the controller-owned upstream credential`);
      if (target.textLike) assert.ok(!SECRET_SHAPE.test(target.text), `${target.path} must not contain a secret-shaped token`);
    }
    // The controller gateway attests every forwarded exchange without naming the credential material.
    const attestations = parseJson<Array<{
      attemptId: string | null; outcome: string; matchesRequest: boolean;
      credential: { accountId: string; version: string; ref: string };
      observed: { provider: string; model: string | null; thinking: string };
    }>>(readFileSync(join(handle.controlDir, 'gateway-attestation.json'), 'utf8'), 'controller gateway attestation');
    assert.equal(attestations.length, gateway.turns.length, 'the controller gateway must attest every forwarded provider request');
    for (const attestation of attestations) {
      assert.equal(attestation.outcome, 'forwarded', 'every attested exchange must be a forwarded provider request');
      assert.equal(attestation.attemptId, attemptId, 'the attestation must be bound to the real-Pi attempt');
      assert.equal(attestation.matchesRequest, true, 'the observed provider/model/thinking must match the requested selection');
      assert.equal(attestation.observed.provider, REAL_WORKER_PROVIDER);
      assert.equal(attestation.observed.model, REAL_WORKER_MODEL);
      assert.equal(attestation.credential.accountId, UPSTREAM_ACCOUNT);
      assert.match(attestation.credential.ref, /^sha256:[0-9a-f]{64}$/, 'the attestation may only carry a digest reference, never the secret');
    }

    // (h0) [T8/S1] Fail-closed default: the composition built the ledger from the run manifest with no spend
    // override, and the read-only doctor/preflight surface reports the effective plan without a model call.
    assert.equal(run.preflight.ok, true, `preflight must be clean for the approved run: ${run.preflight.issues.map(issue => `${issue.code}: ${issue.message}`).join(' | ')}`);
    assert.ok(run.preflight.warnings.some(line => line.includes('spend enforcement=on')
      && line.includes(`price=${REAL_WORKER_PROVIDER}/${REAL_WORKER_MODEL}`)
      && line.includes(`inputTokensUpperBound=${SPEND_BOUND.inputTokensUpperBound}`)
      && line.includes(`maxOutputTokens=${SPEND_BOUND.maxOutputTokens}`)),
      `preflight must report the effective spend plan; warnings: ${run.preflight.warnings.join(' | ')}`);
    const planner = run.journal();
    assert.ok(planner, 'the ledger must exist without any spend override');
    assert.equal(planner.limits.maxTokens, MAIN_RUN_MAX_TOKENS, 'the ledger limits must be the declared run budget');
    assert.equal(planner.limits.maxCostUsdMicros, 2_000_000, 'the ledger cost limit must be the declared run budget');
    // (h) [T9] Per-turn admission at the single egress: the durable attempt hold exists before every provider
    // request, and every earlier provider turn is already charged when the next request arrives.
    const reservationId = `model-spend-${attemptId}`;
    const price = PINNED_MODEL_PRICES[modelPriceKey(REAL_WORKER_PROVIDER, REAL_WORKER_MODEL)];
    assert.ok(price, `the pinned price table must carry ${REAL_WORKER_PROVIDER}/${REAL_WORKER_MODEL}`);
    assert.equal(observations.length, gateway.turns.length, 'every provider request must have been observed against the durable spend journal');
    assert.ok(observations.length >= 2, `the real worker is a multi-turn conversation, saw ${observations.length} provider request(s)`);
    const reported: GatewayUsage[] = gateway.turns.map(turn => {
      const usage = turn.usage;
      assert.ok(usage, `gateway turn ${turn.turn} must report provider usage`);
      assert.ok(usage.prompt_tokens >= 1 && usage.completion_tokens >= 1, `gateway turn ${turn.turn} usage must be positive`);
      return usage;
    });
    let chargedBefore = 0;
    for (const [index, observed] of observations.entries()) {
      const reservation = observed.reservations[reservationId];
      assert.ok(reservation, `provider request ${observed.turn} arrived without the durable attempt hold ${reservationId}`);
      assert.equal(reservation.attemptId, attemptId, 'the hold must belong to the real-Pi attempt');
      assert.ok(reservation.reservedTokens >= 0 && reservation.createdAt <= observed.at, 'the hold must exist, not be negative, and predate the request');
      assert.equal(observed.releases, 0, 'no attempt hold may be released while the attempt is running');
      assert.equal(observed.turnSettlements, index, 'every earlier provider turn must be durably charged before the next request is forwarded');
      assert.equal(observed.chargedTokens, chargedBefore, 'the charged token total must equal the earlier turns the provider reported');
      chargedBefore += reported[index]!.prompt_tokens + reported[index]!.completion_tokens;
    }

    // (i) [T9] Per-turn settlement: one durable charge per provider turn, in order, equal to the usage the
    // provider reported for that turn and to Pi's own session record — two artifacts from different components.
    const expectedInput = reported.reduce((sum, usage) => sum + usage.prompt_tokens, 0);
    const expectedOutput = reported.reduce((sum, usage) => sum + usage.completion_tokens, 0);
    const expectedTokens = expectedInput + expectedOutput;
    const expectedCostMicros = microsFor(expectedInput, price.inputMicroUsdPerMillion) + microsFor(expectedOutput, price.outputMicroUsdPerMillion);
    // The accepted-packet abort stops Pi before the terminal-prose provider request; Pi can still persist one
    // trailing assistant entry with zero usage for the aborted turn. Compare only billed (nonzero-usage)
    // assistant turns, and assert the trailing entry cannot hide an uncharged provider turn.
    const sessionUsages = sessionAssistantUsages(handle.sessionFile);
    const billedSessionUsages = sessionUsages.filter(usage => usage.input + usage.output > 0);
    assert.equal(billedSessionUsages.length, 5, 'exactly five billed assistant turns may be persisted (no terminal prose)');
    assert.deepEqual(
      billedSessionUsages.map(usage => ({ input: usage.input, output: usage.output })),
      reported.map(usage => ({ input: usage.prompt_tokens, output: usage.completion_tokens })),
      'real Pi must persist exactly the provider usage the gateway reported, once per billed assistant turn',
    );
    const trailingSessionUsages = sessionUsages.slice(billedSessionUsages.length);
    assert.ok(trailingSessionUsages.every(usage => usage.input === 0 && usage.output === 0),
      'the aborted turn may persist only a zero-usage session entry, never an uncharged provider turn');
    const state = run.journal();
    assert.ok(state, 'the run must carry a durable model spend journal');
    const turnCharges = Object.entries(state.settlements)
      .filter(([id]) => id.startsWith(`${reservationId}:turn-`))
      .sort((left, right) => Number(left[0].slice(`${reservationId}:turn-`.length)) - Number(right[0].slice(`${reservationId}:turn-`.length)));
    assert.equal(turnCharges.length, reported.length, 'the attempt must have exactly one durable charge per provider turn');
    for (const [index, [id, record]] of turnCharges.entries()) {
      const usage = reported[index]!;
      assert.equal(id, `${reservationId}:turn-${index + 1}`, 'turn charges must be ordered and identified per turn');
      assert.equal(record.attemptId, attemptId, 'every turn charge must belong to the real-Pi attempt');
      assert.equal(record.inputTokens, usage.prompt_tokens, `turn ${index + 1} input tokens must equal the provider-reported prompt tokens`);
      assert.equal(record.outputTokens, usage.completion_tokens, `turn ${index + 1} output tokens must equal the provider-reported completion tokens`);
      assert.equal(record.tokens, usage.prompt_tokens + usage.completion_tokens);
      assert.equal(record.costMicros, microsFor(record.inputTokens, price.inputMicroUsdPerMillion) + microsFor(record.outputTokens, price.outputMicroUsdPerMillion), 'the charge must be derived from the pinned price table');
      assert.equal(record.basis, 'provider-usage', 'a per-turn charge must be the usage the provider reported for that turn');
      assert.equal(record.overshootTokens, 0, 'usage within the admitted turn bound is not overshoot');
      assert.equal(record.overshootCostMicros, 0, 'usage within the admitted turn bound is not overshoot');
      assert.deepEqual({ input: billedSessionUsages[index]!.input, output: billedSessionUsages[index]!.output }, { input: record.inputTokens, output: record.outputTokens }, `turn ${index + 1} must match Pi's own billed session record`);
      // The admitted bound for this turn is the payload the gateway measured plus the declared output bound.
      assert.ok(record.tokens <= gateway.turns[index]!.bytes + SPEND_BOUND.maxOutputTokens, `turn ${index + 1} must have been admitted against its payload-derived worst case`);
      const wire = gateway.turns[index]!.body;
      assert.equal(wire.max_completion_tokens ?? wire.max_tokens, SPEND_BOUND.maxOutputTokens, 'the REAL Pi transmitted request must carry exactly the reserved completion ceiling');
      assert.equal(wire.n, 1, 'multiple completions cannot evade reservation');
      assert.ok(record.outputTokens <= SPEND_BOUND.maxOutputTokens, 'provider output including reasoning must fit the enforced ceiling');
    }
    assert.equal(state.committed.tokens, expectedTokens, 'the run must be charged exactly the sum of its provider turns');
    assert.equal(state.committed.costMicros, expectedCostMicros);
    assert.equal(Object.keys(state.settlements).length, reported.length, 'the gateway must charge every turn exactly once, with no catch-up left to apply');
    assert.match(String(state.released[reservationId]?.reason), /^[a-z-]+:charged-turns=5$/,
      'the accepted-packet abort must release the hold with exactly the five charged provider turns and no terminal prose');
    assert.deepEqual(state.reservations, {}, 'a completed attempt must leave no active hold');
    assert.deepEqual(state.overshoot, { tokens: 0, costMicros: 0 }, 'no turn may exceed its admitted worst-case bound');

    // (j) [T8] re-reading the finished attempt through the runtime must not charge a second time.
    const finishedHandle = parseJson<Parameters<typeof app.runtimes.headless.collect>[0]>(readFileSync(join(controlRoot, 'handles', `${attemptId}.json`), 'utf8'), 'durable runtime handle');
    await app.runtimes.headless.collect(finishedHandle);
    await app.runtimes.headless.collect(finishedHandle);
    const replayed = run.journal();
    assert.ok(replayed, 'the durable model spend journal must survive a replay read');
    assert.deepEqual(replayed.committed, state.committed, 're-reading a settled attempt must not double-charge it');
    assert.deepEqual(replayed.settlements, state.settlements, 're-reading a settled attempt must not add or alter a settlement');
    assert.deepEqual(replayed.reservations, {}, 're-reading a settled attempt must leave no active reservation behind');

    t.diagnostic(`lifecycle=${runtimeTypes.filter(type => ['prompt-delivered', 'pi:agent_start', 'pi:agent_settled'].includes(type)).join(' -> ')} handleStatus=${handle.status}`);
    t.diagnostic(`credential isolation: envKeys=${Object.keys(worker.env).length} placeholder=${String(workerModels.providers[REAL_WORKER_PROVIDER]?.apiKey)} hostCredentials=${credentials.length} artifactsScanned=${secretScanTargets.length}`);
    t.diagnostic(`gateway POST ${gateway.turns[0]!.path} model=${String(gateway.turns[0]!.body.model)} upstreamAuthorization=${gateway.turns[0]!.authorization} turns=${gateway.turns.length} attesters=${attestations.length}`);
    t.diagnostic(`tool sequence=${[...exchanges.map(exchange => `${exchange.name}(${exchange.name === 'p2o_broker' ? String(exchange.args.observationId) : ''})`), `p2o_packet(${REAL_WORKER_PACKET_ID})`].join(' -> ')} (p2o_packet proven by the durable gate + preserved bytes)`);
    t.diagnostic(`baseline receipt=${JSON.stringify({ evidenceId: baseline.evidenceId, kind: baseline.kind, classification: baseline.classification, trust: baseline.provenance.trust, tool: baseline.provenance.tool.name, environmentId: baseline.provenance.environmentId, attemptId: baseline.attemptId, test: baseline.test })}`);
    t.diagnostic(`denial tool result=${denial.slice(0, 220)}`);
    t.diagnostic(`packet evidence=${preserved.evidenceId} status=${results[0]!.decision.status} originalBytes=${admission.originalBytes}`);
    t.diagnostic(`allowed tools=${worker.args[toolsIndex + 1]} receiptReady=${String(receipt.ready)} actor=${REAL_WORKER_ACTOR}`);
    t.diagnostic(`observation-rejections=${observationRejections.length} types=${[...new Set(observationRejections.map(event => String(event.payload.code)))].join(',') || 'none'}`);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, 'the verified worker CLI must carry a content hash');
    assert.ok(pin.packageRoot.includes('@earendil-works/pi-coding-agent'), `the verified CLI must belong to the pinned package, saw ${pin.packageRoot}`);
    assert.equal(pin.sha256.length, 64, 'the recorded worker CLI hash must be a full SHA-256 digest');
    t.diagnostic(`spend hold=${reservationId} limit=${MAIN_RUN_MAX_TOKENS} declared=payload-bytes+${SPEND_BOUND.maxOutputTokens} observedAtRequests=${observations.map(observed => observed.turn).join(',')}`);
    t.diagnostic(`per-turn admission at the gateway: ${observations.map(observed => `req${observed.turn}:charged=${observed.chargedTokens}turns=${observed.turnSettlements}`).join(' ')}`);
    t.diagnostic(`per-turn charges: ${turnCharges.map(([id, record]) => `${id.slice(id.lastIndexOf(':') + 1)}=${record.inputTokens}+${record.outputTokens}`).join(' ')} total=${state.committed.tokens} micros=${state.committed.costMicros}`);
    t.diagnostic(`payload bytes per turn: ${gateway.turns.map(turn => `${turn.turn}:${turn.bytes}`).join(' ')}`);
    t.diagnostic(`release=${JSON.stringify(state.released[reservationId])} overshoot=${JSON.stringify(state.overshoot)}`);
    t.diagnostic(`worker pin package=${pin.packageRoot} version=${pin.version} cli=${pin.cliPath} sha256=${pin.sha256}`);
  } finally {
    await run.close();
  }
});

test('an unaffordable model spend reservation is refused before any provider request', { timeout: DEADLINE_MS + 60_000 }, async (t) => {
  const run = await launchRealWorker({ runId: REAL_WORKER_REFUSED_RUN_ID, spend: { ...REFUSED_SPEND_BOUND } });
  try {
    // Zero provider requests is the headline claim: the refusal happened before dispatch, not after.
    assert.equal(run.gateway.turns.length, 0, 'a refused reservation must issue zero provider requests');
    assert.equal(run.observations.length, 0, 'no provider request may reach the gateway when the reservation is refused');
    assert.equal(run.gateway.errors.length, 0, 'the gateway must record no contract error for a refused run');
    const task = run.snapshot.tasks.find(candidate => candidate.taskId === REAL_WORKER_TASK_ID);
    assert.equal(task?.lifecycleState, 'failed', `the refused task must be durably failed; observed ${String(task?.lifecycleState)}`);
    const attempt = run.snapshot.attempts.find(candidate => candidate.taskId === REAL_WORKER_TASK_ID);
    assert.ok(attempt, 'the supervisor must record the refused attempt durably');
    assert.equal(attempt.lifecycleState, 'failed', 'the refused attempt must be durably failed');
    assert.equal(attempt.observedRuntime, undefined, 'a refused attempt must never be observed running');
    // The durable handle the supervisor observes for the refused attempt must show it was never dispatched.
    const refusedHandleFile = join(run.controlRoot, 'handles', `${attempt.attemptId}.json`);
    assert.ok(existsSync(refusedHandleFile), 'the supervisor must persist its observation record for the refused attempt');
    const refusedHandle = parseJson<RuntimeHandle>(readFileSync(refusedHandleFile, 'utf8'), 'refused runtime handle');
    assert.equal(refusedHandle.launchIntent, false, 'a refused attempt must never reach the durable launch-intent boundary');
    assert.equal(refusedHandle.native.processes.length, 0, 'a refused attempt must own no worker process');
    assert.equal(refusedHandle.native.guardian, undefined, 'a refused attempt must own no native guardian');
    // The controller must record the runtime's stable refusal message naming the unaffordable worst case.
    assert.ok(run.logs.some(line => line.includes('adapter.start-failed') && line.includes('Model token budget cannot cover the worst-case reservation')),
      `the controller log must record the runtime's model-budget refusal; logs: ${run.logs.join(' | ')}`);
    // The durable journal must be untouched by the refusal.
    const state = run.journal();
    assert.ok(state, 'the refused run must still carry its durable spend journal');
    assert.deepEqual(state.reservations, {}, 'a refused reservation must leave no hold behind');
    assert.deepEqual(state.settlements, {}, 'a refused request must never be charged');
    assert.deepEqual(state.released, {}, 'a refused request must never create a release record');
    assert.deepEqual(state.committed, { tokens: 0, costMicros: 0 }, 'a refused request must leave the committed spend at zero');
    assert.equal(state.limits.maxTokens, 4_000, 'the run budget that made the worst case unaffordable must be the approved one');
    // The stable enforcement code, checked against exactly this durable journal and these approved limits: the
    // declared worst case (input bound + max output) cannot fit, so the ledger refuses with BUDGET_EXCEEDED.
    const approved = { maxTokens: state.limits.maxTokens, maxCostUsd: state.limits.maxCostUsdMicros / 1_000_000 };
    const refusalLedger = new ModelSpendBudget(approved, { runId: REAL_WORKER_REFUSED_RUN_ID, journal: run.app.store.modelSpendJournal(REAL_WORKER_REFUSED_RUN_ID) });
    refusalLedger.bindRun(REAL_WORKER_REFUSED_RUN_ID, approved);
    let budgetError: { code?: string; message?: string } | undefined;
    try {
      refusalLedger.reserve({
        attemptId: attempt.attemptId,
        selection: { provider: REAL_WORKER_PROVIDER, model: REAL_WORKER_MODEL, thinking: REAL_WORKER_THINKING },
        inputTokensUpperBound: REFUSED_SPEND_BOUND.inputTokensUpperBound,
        maxOutputTokens: REFUSED_SPEND_BOUND.maxOutputTokens,
      });
    } catch (error) { budgetError = error as { code?: string; message?: string }; }
    assert.ok(budgetError, 'the unaffordable worst case must be refused, not admitted');
    assert.equal(budgetError.code, 'BUDGET_EXCEEDED', 'the refusal must carry the stable budget error code');
    assert.match(String(budgetError.message), /worst-case reservation/, 'the refusal must name the unaffordable worst-case reservation');
    assert.deepEqual(refusalLedger.snapshot().active, { count: 0, tokens: 0, costUsd: 0 }, 'a refused reservation must leave no hold');
    assert.deepEqual(run.journal(), state, 'the refusal must not modify the durable journal');
    const refusedEvents = run.app.store.listEvents({ runId: REAL_WORKER_REFUSED_RUN_ID });
    assert.ok(refusedEvents.some(event => event.type === 'attempt.reconciled-terminal' && event.payload.lifecycleState === 'failed'),
      'the refused attempt must be durably reconciled as failed');
    t.diagnostic(`refusal code=${String(budgetError.code)} message=${String(budgetError.message)} gatewayRequests=${run.gateway.turns.length} attempts=${run.snapshot.attempts.length} launchIntent=${String(refusedHandle.launchIntent)} journal=${JSON.stringify({ reservations: Object.keys(state.reservations).length, settlements: Object.keys(state.settlements).length, committed: state.committed })}`);
    t.diagnostic(`refusal log=${run.logs.filter(line => line.includes('adapter.start-failed')).join(' | ')}`);
  } finally {
    await run.close();
  }
});

/**
 * [T8/S1/T9] Fail-closed by default: the run declares only its budgets (no owner spend bounds, no override).
 * The ledger is still built from the manifest, the launch envelope is the prompt-bound worst case, and every
 * provider turn is admitted against the request payload's own worst case and charged as it completes.
 */
test('enforcement is on by default for a run that declares only its budgets', { timeout: DEADLINE_MS + 60_000 }, async (t) => {
  const run = await launchRealWorker({ runId: REAL_WORKER_DEFAULT_RUN_ID, runMaxTokens: DEFAULT_RUN_MAX_TOKENS });
  const { gateway, controlRoot, snapshot, observations, preflight } = run;
  try {
    const attempt = snapshot.attempts.find(candidate => candidate.taskId === REAL_WORKER_TASK_ID);
    assert.ok(attempt, 'the default-enforcement run must produce a durable attempt');
    const attemptId = attempt.attemptId;
    const reservationId = `model-spend-${attemptId}`;
    const launch = parseJson<{ request: { prompt: string } }>(readFileSync(join(controlRoot, 'launches', `${attemptId}.json`), 'utf8'), 'durable launch record');
    const promptBytes = Math.max(1, Buffer.byteLength(launch.request.prompt));
    const state = run.journal();
    assert.ok(state, 'the ledger must exist even without any declared spend plan');
    assert.equal(state.limits.maxTokens, DEFAULT_RUN_MAX_TOKENS, 'the ledger limits must come from the declared run budget');
    assert.equal(state.limits.maxCostUsdMicros, 2_000_000, 'the ledger cost limit must come from the declared run budget');
    const defaultOutput = Math.min(4096, Math.max(1, state.limits.maxTokens - promptBytes));
    const launchHold = promptBytes + defaultOutput;
    const price = PINNED_MODEL_PRICES[modelPriceKey(REAL_WORKER_PROVIDER, REAL_WORKER_MODEL)];
    assert.ok(price, 'the pinned price table must carry the worker selection');
    assert.equal(gateway.turns.length, 5,
      `the default-enforcement worker must stop at exactly five provider turns (no terminal prose), saw ${gateway.turns.length}`);
    assert.equal(observations.length, gateway.turns.length, 'every provider request must be observed against the ledger');
    const reported = gateway.turns.map(turn => {
      const usage = turn.usage;
      assert.ok(usage, `gateway turn ${turn.turn} must report provider usage`);
      return usage;
    });
    let chargedBefore = 0;
    for (const [index, observed] of observations.entries()) {
      const reservation = observed.reservations[reservationId];
      assert.ok(reservation, `provider request ${observed.turn} arrived without the default reservation ${reservationId}`);
      // [T9] The admitted bound for a turn is the actual payload the gateway measured plus the declared
      // completion bound; the launch envelope is the default prompt bound, so every turn grows the hold.
      const turnBound = gateway.turns[index]!.bytes + defaultOutput;
      assert.ok(reservation.reservedTokens >= turnBound, `provider request ${observed.turn} must be admitted against its payload-derived worst case`);
      assert.equal(observed.turnSettlements, index, 'every earlier turn must be durably charged before the next request is forwarded');
      assert.equal(observed.chargedTokens, chargedBefore, 'the charged total must equal the earlier turns the provider reported');
      assert.equal(observed.releases, 0, 'no default hold may be released while the attempt is running');
      chargedBefore += reported[index]!.prompt_tokens + reported[index]!.completion_tokens;
    }
    assert.equal(observations[0]!.reservations[reservationId]!.reservedTokens, gateway.turns[0]!.bytes + defaultOutput,
      'the first turn must grow the default prompt-bound hold to its own payload-derived worst case');
    assert.ok(launchHold < gateway.turns[0]!.bytes + defaultOutput, 'the default launch envelope is smaller than the payload-derived per-turn bound');
    assert.ok(preflight.warnings.some(line => line.includes('spend enforcement=on') && line.includes('inputTokensUpperBound=prompt-bytes') && line.includes('maxOutputTokens=min(4096,remaining)')),
      `preflight must report the default plan; warnings: ${preflight.warnings.join(' | ')}`);
    const expectedInput = reported.reduce((sum, usage) => sum + usage.prompt_tokens, 0);
    const expectedOutputTokens = reported.reduce((sum, usage) => sum + usage.completion_tokens, 0);
    const turnCharges = Object.entries(state.settlements)
      .filter(([id]) => id.startsWith(`${reservationId}:turn-`))
      .sort((left, right) => Number(left[0].slice(`${reservationId}:turn-`.length)) - Number(right[0].slice(`${reservationId}:turn-`.length)));
    assert.equal(turnCharges.length, reported.length, 'the default plan must charge every provider turn exactly once');
    assert.deepEqual(turnCharges.map(([, record]) => ({ input: record.inputTokens, output: record.outputTokens })), reported.map(usage => ({ input: usage.prompt_tokens, output: usage.completion_tokens })));
    assert.equal(state.committed.tokens, expectedInput + expectedOutputTokens, 'all turns must be charged');
    assert.match(String(state.released[reservationId]?.reason), /^[a-z-]+:charged-turns=5$/,
      'the default hold must be released with exactly five charged turns (accepted-packet abort, no terminal prose)');
    assert.deepEqual(state.reservations, {}, 'no default reservation may be left active');
    assert.deepEqual(state.overshoot, { tokens: 0, costMicros: 0 }, 'no turn may exceed its own payload-derived bound');
    t.diagnostic(`default enforcement promptBytes=${promptBytes} launchHold=${launchHold} tokens gatewayTurns=${gateway.turns.length} perTurn=${turnCharges.map(([, record]) => `${record.inputTokens}+${record.outputTokens}`).join(' ')} committed=${JSON.stringify(state.committed)}`);
    t.diagnostic(`default preflight=${preflight.warnings.filter(line => line.includes('spend enforcement')).join(' | ')}`);
  } finally {
    await run.close();
  }
});

/**
 * [T9] The headline witness: a run whose token budget is nearly exhausted refuses the NEXT provider turn at
 * the controller gateway, with zero upstream requests for that turn, while every earlier turn stays charged.
 *
 * The run declares only its budgets. With `PER_TURN_REFUSAL_RUN_MAX_TOKENS`, the first turns of the six-turn
 * conversation each fit their payload-derived worst case (`payload bytes + declared max output`) next to the
 * spend already committed by earlier turns; a later turn does not, so the gateway denies it before the
 * provider is contacted. The refused attempt is a failed attempt whose consumed tokens stay charged.
 */
test('a nearly exhausted run refuses the next provider turn at the gateway with zero upstream requests', { timeout: DEADLINE_MS + 60_000 }, async (t) => {
  const run = await launchRealWorker({
    runId: REAL_WORKER_REFUSED_TURN_RUN_ID,
    runMaxTokens: PER_TURN_REFUSAL_RUN_MAX_TOKENS,
    taskMaxAttempts: 1,
  });
  const { gateway, controlRoot, snapshot, observations } = run;
  try {
    const attempt = snapshot.attempts.find(candidate => candidate.taskId === REAL_WORKER_TASK_ID);
    assert.ok(attempt, 'the refused-turn run must produce one durable attempt');
    const attemptId = attempt.attemptId;
    const reservationId = `model-spend-${attemptId}`;
    const handle = parseJson<{ controlDir: string; sessionFile: string; status: string; startupError?: string; events: Array<{ type: string; text: string }>; budgetOutcome?: { outcome: string; extensionRequired: boolean }; stopReceipt?: { verified: boolean }; sessionRelease?: { verified: boolean } }>(readFileSync(join(controlRoot, 'handles', `${attemptId}.json`), 'utf8'), 'durable runtime handle');
    const state = run.journal();
    assert.ok(state, 'the refused-turn run must carry its durable spend journal');
    assert.equal(state.limits.maxTokens, PER_TURN_REFUSAL_RUN_MAX_TOKENS, 'the ledger limit must be the approved run budget');
    assert.equal(handle.budgetOutcome?.outcome, 'partial', 'denied turn must leave a durable explicit partial receipt');
    assert.equal(handle.budgetOutcome?.extensionRequired, true, 'continued assessment requires explicit owner extension');
    assert.equal(handle.stopReceipt?.verified, true, 'partial outcome still requires real process cleanup');
    assert.equal(handle.sessionRelease?.verified, true, 'partial outcome cannot bypass pack resource cleanup');
    const admitted = gateway.turns.length;
    assert.ok(admitted >= 1 && admitted <= 3, `the spend gate must cut the six-turn conversation short, saw ${admitted} upstream request(s)`);
    assert.equal(observations.length, admitted, 'only admitted turns may reach the provider');
    const reported = gateway.turns.map(turn => { const usage = turn.usage; assert.ok(usage, `gateway turn ${turn.turn} must report provider usage`); return usage; });
    // (1) Every earlier turn is charged per turn, before the next request reaches the provider.
    let chargedBefore = 0;
    for (const [index, observed] of observations.entries()) {
      assert.equal(observed.turnSettlements, index, `request ${observed.turn} must arrive after ${index} per-turn charge(s)`);
      assert.equal(observed.chargedTokens, chargedBefore, `request ${observed.turn} must see exactly the earlier turns charged`);
      chargedBefore += reported[index]!.prompt_tokens + reported[index]!.completion_tokens;
    }
    const turnCharges = Object.entries(state.settlements)
      .filter(([id]) => id.startsWith(`${reservationId}:turn-`))
      .sort((left, right) => Number(left[0].slice(`${reservationId}:turn-`.length)) - Number(right[0].slice(`${reservationId}:turn-`.length)));
    assert.equal(turnCharges.length, admitted, 'one durable charge per admitted provider turn');
    assert.deepEqual(turnCharges.map(([, record]) => ({ input: record.inputTokens, output: record.outputTokens })), reported.map(usage => ({ input: usage.prompt_tokens, output: usage.completion_tokens })));
    const sessionUsages = sessionAssistantUsages(handle.sessionFile);
    assert.deepEqual(
      sessionUsages.slice(0, admitted).map(usage => ({ input: usage.input, output: usage.output })),
      reported.map(usage => ({ input: usage.prompt_tokens, output: usage.completion_tokens })),
      'the charged turns must equal the per-turn usage Pi recorded in its own session',
    );
    assert.ok(sessionUsages.slice(admitted).every(usage => usage.input === 0 && usage.output === 0),
      'the refused turn must have consumed no provider tokens');
    assert.equal(state.committed.tokens, chargedBefore, 'the run must be charged exactly the admitted turns');
    // (2) The refused turn never reached the provider: it exists only as a denial attestation.
    const attestations = parseJson<Array<{ attemptId: string | null; outcome: string; denial?: { code: string; message: string }; request: { bytes: number }; spend?: { outcome: string } }>>(
      readFileSync(join(handle.controlDir, 'gateway-attestation.json'), 'utf8'), 'controller gateway attestation');
    assert.equal(attestations.length, admitted + 1, 'every controller-gateway exchange must be attested, refusal included');
    const forwarded = attestations.filter(entry => entry.outcome === 'forwarded');
    const denied = attestations.filter(entry => entry.outcome === 'denied');
    assert.equal(forwarded.length, admitted, 'the forwarded attestations must be exactly the admitted turns');
    assert.equal(denied.length, 1, 'exactly one turn must be refused at the gateway');
    const refusal = denied[0]!;
    assert.equal(refusal.attemptId, attemptId, 'the refusal must be bound to the real-Pi attempt');
    assert.equal(refusal.denial?.code, 'GATEWAY_BUDGET_DENIED', 'the refusal must carry the stable gateway spend code');
    assert.match(String(refusal.denial?.message), /cannot cover the next provider turn's worst case/);
    assert.equal(refusal.spend?.outcome, 'denied', 'the refusal must be attested as a denied spend turn');
    // (3) The ledger arithmetic behind every admission and the single refusal, from the recorded payloads.
    let committed = 0;
    for (const [index, turn] of gateway.turns.entries()) {
      assert.ok(committed + turn.bytes + PER_TURN_REFUSAL_DEFAULT_OUTPUT <= PER_TURN_REFUSAL_RUN_MAX_TOKENS,
        `turn ${index + 1} was admitted only because its payload-derived worst case fit the remaining budget`);
      committed += reported[index]!.prompt_tokens + reported[index]!.completion_tokens;
    }
    assert.ok(committed + refusal.request.bytes + PER_TURN_REFUSAL_DEFAULT_OUTPUT > PER_TURN_REFUSAL_RUN_MAX_TOKENS,
      'the refused turn was denied because its payload-derived worst case no longer fit the remaining budget');
    // (4) Failed-attempt accounting: the consumed tokens stay charged; only the residual hold is released.
    assert.ok(state.released[reservationId], `the failed attempt must release its residual hold, journal=${JSON.stringify(state)}`);
    assert.match(String(state.released[reservationId]!.reason), new RegExp(`^[a-z-]+:charged-turns=${admitted}$`), 'the residual hold must be released with the charged turn count, never silently');
    assert.equal(state.committed.tokens, chargedBefore, 'releasing the hold of a failed attempt must not erase the charged tokens');
    assert.deepEqual(state.reservations, {}, 'the failed attempt must leave no active hold behind');
    const refusedTask = snapshot.tasks.find(candidate => candidate.taskId === REAL_WORKER_TASK_ID);
    assert.ok(refusedTask && ['exited', 'failed', 'cancelled', 'timed-out'].includes(String(refusedTask.lifecycleState)), `the refused task must be durably terminal, observed ${String(refusedTask?.lifecycleState)}`);
    assert.notEqual(refusedTask.packetState, 'accepted', `a refused run must not have an accepted packet, observed ${String(refusedTask.packetState)}`);
    assert.equal(run.app.store.listResults(REAL_WORKER_REFUSED_TURN_RUN_ID).length, 0, 'a refused run must admit no result');
    // The refusal is durably recorded on the attempt itself, and the attempt never ends `completed`.
    assert.notEqual(handle.status, 'completed', `a refused attempt must never be recorded as completed, observed ${handle.status}`);
    const refusalEvent = handle.events.find(event => event.type === 'spend-refused');
    assert.ok(refusalEvent, `the refusal must be a durable runtime event; events: ${handle.events.map(event => event.type).join(',')}`);
    assert.match(refusalEvent.text, /cannot cover the next provider turn's worst case/);
    // The supervisor's run terminal summary is the honest one: zero accepted results, and the run itself is
    // classified as truncated by the spend refusal instead of being labelled `completed` (T9 residual 3).
    const refusalEvents = run.app.store.listEvents({ runId: REAL_WORKER_REFUSED_TURN_RUN_ID });
    const finished = refusalEvents.find(event => event.type === 'orchestrator.run-finished');
    assert.ok(finished, `the run must record its terminal summary, observed ${[...new Set(refusalEvents.map(event => event.type))].join(',')}`);
    t.diagnostic(`refusal visibility: handleEvents=${handle.events.length} refusalAt=${handle.events.findIndex(event => event.type === 'spend-refused')} runEventTypes=${[...new Set(refusalEvents.map(event => event.type))].join(',')}`);
    assert.equal(finished.payload.accepted, 0, 'a refused run must report zero accepted results');
    assert.equal(finished.payload.state, 'failed', 'a spend-truncated run must not be reported completed');
    assert.equal(finished.payload.truncation, 'model-spend-refusal', 'the terminal summary must name the truncation');
    assert.equal(run.app.store.getRun(REAL_WORKER_REFUSED_TURN_RUN_ID)?.state, 'failed', 'the durable run state must reflect the truncation');
    assert.ok(refusalEvents.some(event => event.type === 'orchestrator.spend-truncated'), 'the refusal must be a durable run-level marker');
    t.diagnostic(`refused turn: gatewayRequests=${admitted} refusedBytes=${refusal.request.bytes} committedBefore=${committed} limit=${PER_TURN_REFUSAL_RUN_MAX_TOKENS} denial=${refusal.denial?.code} chargedTurns=${admitted} committed=${state.committed.tokens} release=${state.released[reservationId]!.reason}`);
    t.diagnostic(`refused turn terminal state: run=${snapshot.run.state} task=${String(refusedTask.lifecycleState)} runtimeHandle=${handle.status}`);
    t.diagnostic(`admission arithmetic: ${gateway.turns.map((turn, index) => `t${index + 1}:${turn.bytes}+${PER_TURN_REFUSAL_DEFAULT_OUTPUT}<=${PER_TURN_REFUSAL_RUN_MAX_TOKENS}`).join(' ')} refused:${refusal.request.bytes}+${PER_TURN_REFUSAL_DEFAULT_OUTPUT}>${PER_TURN_REFUSAL_RUN_MAX_TOKENS - committed}`);
  } finally {
    await run.close();
  }
});

/**
 * [T8/S1] No enforceable plan: a selection the pinned catalog cannot price refuses the owner document before any
 * admission, store, gateway or worker exists.
 */
test('an unpriceable selection is refused before any admission (no spend plan can be built)', async (t) => {
  const repoRoot = requiredEnv('P2O_REPO_ROOT');
  const document = buildRealWorkerScenario({
    runId: 'run-real-worker-unpriced',
    runRoot: '/tmp/p2o-unpriced-root',
    snapshotRoot: '/tmp/p2o-unpriced-root/snapshot',
    snapshotBytes: Buffer.from('fixture', 'utf8'),
    fixture: { origin: 'http://127.0.0.1:9/', configurationDigest: 'a'.repeat(64) } as unknown as FixtureInstance,
    workspaceRoot: '/tmp/p2o-unpriced-root/workspaces',
    controlRoot: '/tmp/p2o-unpriced-root/control',
    vaultRoot: '/tmp/p2o-unpriced-root/vault',
    socketPath: '/tmp/p2o-unpriced-root/run/worker-bridge.sock',
    extensionPath: join(repoRoot, 'examples', 'local-assessment', 'bridge-extension.js'),
    piBinary: join(repoRoot, 'node_modules', '.bin', 'pi'),
    gatewayOrigin: 'http://127.0.0.1:9/',
    now: Date.now(),
    selection: { provider: 'unpriced-provider', model: 'unpriced-model', thinking: 'max' },
  });
  assert.throws(() => validateApplicationConfig(document.config), /No pinned model price for unpriced-provider\/unpriced-model/,
    'a selection with no pinned price must refuse the document instead of running unbounded');
  t.diagnostic('unpriced selection refused before admission: No pinned model price for unpriced-provider/unpriced-model');
});
