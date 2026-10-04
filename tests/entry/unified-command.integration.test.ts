/**
 * Unified `/p2o` integration test — the actual command, through the default composition factory, into the
 * real target-entry port, the real model-author seam, the real owner gate, the real supervisor and the real
 * broker against a loopback fixture.
 *
 * What this test drives (no fixture doubles for the seam under test):
 *   `registerP2O` (the real extension registration) → `/p2o --target …` (the real command grammar) →
 *   `createP2OBackend` (the default composition factory that `createDefaultBackend`'s P2O_CONTROL_MODULE must
 *   export) → `ControlBackend.entry` → `createPiModelPlanAuthor` (the production author, here bound to an
 *   *inert* `pi-ai` provider fixture — no provider call, no cost) → the real `RequestPlanLedger` /
 *   `materializeRequestPlan` gate → an owner-authored approval file → the real supervisor, runtime adapter,
 *   tool broker and evidence vault → the loopback fixture → `/p2o status` and `/p2o report`.
 *
 * The ownership rules this test proves:
 *   * `prepare`/`plan`/`--plan-only` report `targetRequests: 0` and never clone, copy or contact the target.
 *   * A target outside the owner document's approved list is refused (`TARGET_DENIED`) before any acquisition.
 *   * Nothing is admitted or launched without the interactive confirmation that mints `human-command`.
 *   * The model authors a *selection/request set*; identity, scope, budget and authority stay owner-derived.
 *   * These are preconfigured-contract suites (`P2O_APP_CONFIG`): owner consent is injected as the saved
 *     document approval (`preconfiguredOwnerConsent`), while the entry port still enforces every scope,
 *     digest, owner-gate and source-binding refusal against the real command.
 *   * A registered generated check is executed by a supervisor worker through the real broker.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentText, createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createP2OBackend } from '../../src/application/backend.js';
import { ENTRY_BOUNDS_DEFAULTS, createPiModelPlanAuthor, fingerprintTree } from '../../src/application/entry/index.js';
import { createLocalFixtureSandbox } from '../../src/tools/index.js';
import { registerP2O } from '../../extensions/p2o/index.js';
import { startFixture, type FixtureInstance } from '../../examples/local-assessment/fixture-server.js';
import { createFixtureReplayEnvironment } from '../../examples/local-assessment/replay-environment.js';
import {
  ACTOR_GUEST, ENVIRONMENT_B, RUN_ID, TARGET_A, TARGET_SOURCE, TASK_HYP_CASE,
  buildScenario, type Scenario,
} from '../../examples/local-assessment/scenario.js';
import { fakeGitRunner, preconfiguredOwnerConsent } from './fixtures.js';
import { fakePi } from '../interface/helpers.js';

const EXAMPLE_ROOT = join(process.cwd(), 'examples', 'local-assessment');
const REPO_ROOT = process.cwd();
const BUILT_GUARDIAN = join(REPO_ROOT, 'dist', 'src', 'runtime', 'guardian.js');
const BUILT_RECEIPTS = join(REPO_ROOT, 'dist', 'src', 'runtime', 'pi-receipts.js');

/**
 * The real headless guardian is spawned by path. Running this suite from the TypeScript sources resolves it
 * beside `src/runtime`, so the built copies are used; the repository build is the same artifact `npm test`
 * produces, and it is compiled here only when it is missing.
 */
beforeAll(() => {
  if (existsSync(BUILT_GUARDIAN) && existsSync(BUILT_RECEIPTS)) return;
  const compile = spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000,
  });
  if (compile.status !== 0 || !existsSync(BUILT_GUARDIAN) || !existsSync(BUILT_RECEIPTS)) {
    throw new Error(`the composition build required by the real runtime adapter failed: ${(compile.stdout ?? '').slice(-2000)}${(compile.stderr ?? '').slice(-2000)}`);
  }
}, 300_000);
// The fail-closed model-spend gate can only bound a selection that has a pinned quote, so the inert plan author
// uses the synthetic `inert-fixture/inert-worker` pair already pinned for fixtures. The faux provider never
// leaves this process: no live provider request, no credential and no real cost.
const AUTHOR_PROVIDER = 'inert-fixture';
const AUTHOR_MODEL = 'inert-worker';

interface EntryAppFixture {
  runDir: string;
  assessmentPath: string;
  controlRoot: string;
  workspaceRoot: string;
  snapshotRoot: string;
  /** Decoy/owner-configured sandbox source root when one was requested. */
  sandboxRoot: string;
  outputRoot: string;
  originA: string;
  environmentA: FixtureInstance;
  environmentB: { current?: FixtureInstance; close(): Promise<void> };
  scenario: Scenario;
  close(): Promise<void>;
}

interface ScenarioOptions {
  /** Pin the local snapshot directory as the owner-approved local artifact target (tree digest included). */
  localTarget?: boolean;
  /** GitHub repository locator (owner-approved repository target) with the pinned revision and tree digest. */
  repoTarget?: { locator: string; digest: string; revision: string };
  /** Owner-approved planner document (enables the owner-menu plan flavour). */
  planner?: boolean;
  /**
   * Owner-configured worker source root. The entry workflow must re-root it to the acquired view (or
   * refuse); tests point it at a decoy directory to prove the snapshot is what the worker reads.
   */
  sandboxRoot?: string;
  /** Relative source paths for the owner-approved `hyp-case-source` check (must exist in the view). */
  sourceCheckPaths?: string[];
  /** Extra files written into the owner-pinned local target before its tree digest is taken. */
  extraSnapshotFiles?: Record<string, string>;
  /** Injected git runner for the hardened clone (records argv/env, never spawns git). */
  gitRunner?: ReturnType<typeof fakeGitRunner>['runner'];
}

/** Build one real composition against the shared loopback fixture scenario. */
async function prepareEntryApp(options: ScenarioOptions = {}): Promise<EntryAppFixture> {
  const runDir = mkdtempSync(join(tmpdir(), 'p2o-entry-command-'));
  const snapshotRoot = join(runDir, 'snapshot');
  const outputRoot = join(runDir, 'broker-artifacts');
  // The owner-configured worker source root. Repository runs default it to a separate directory holding the
  // identical synthetic tree the injected clone produces: the hardened clone owns the deterministic view path
  // (and refuses to reuse it), while the composition still proves the worker root content-identical to the
  // acquired view. Local runs default it to the owner-approved target directory itself.
  const sandboxRoot = options.sandboxRoot ?? (options.repoTarget ? join(runDir, 'worker-source') : snapshotRoot);
  for (const directory of [snapshotRoot, outputRoot, sandboxRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(snapshotRoot, 'fixture-server.ts'), readFileSync(join(EXAMPLE_ROOT, 'fixture-server.ts')), { mode: 0o600 });
  if (options.repoTarget && !options.sandboxRoot) {
    // Same path and bytes `fakeGitRunner` fabricates, so the worker root fingerprints to the clone digest.
    mkdirSync(join(sandboxRoot, 'src'), { recursive: true, mode: 0o700 });
    writeFileSync(join(sandboxRoot, 'src', 'index.ts'), 'export const fixture = true;\n', { mode: 0o600 });
  }
  for (const [name, content] of Object.entries(options.extraSnapshotFiles ?? {})) {
    mkdirSync(join(snapshotRoot, name, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(join(snapshotRoot, name), content, { mode: 0o600 });
  }

  const sandbox = createLocalFixtureSandbox({
    acknowledgement: 'local-fixtures-only-not-hostile-code-isolation',
    inputRoot: sandboxRoot, outputRoot, trustedInputSnapshot: true,
  });
  const environmentA = await startFixture({ environmentId: TARGET_A, port: 0, configurationDigest: sandbox.configurationDigest });
  let environmentB: FixtureInstance | undefined;
  try {
    environmentB = await startFixture({ environmentId: ENVIRONMENT_B, port: 0, configurationDigest: sandbox.configurationDigest });
    const scenario = buildScenario({
      runRoot: runDir, snapshotRoot, snapshotBytes: readFileSync(join(snapshotRoot, 'fixture-server.ts')),
      environmentA, environmentB,
      workspaceRoot: join(runDir, 'workspaces'), controlRoot: join(runDir, 'control'), vaultRoot: join(runDir, 'vault'),
      socketPath: join(runDir, 'run', 'worker-bridge.sock'),
      inertWorkerPath: join(EXAMPLE_ROOT, 'inert-worker.mjs'), extensionPath: join(EXAMPLE_ROOT, 'bridge-extension.js'),
      configurationDigest: sandbox.configurationDigest, now: Date.now(),
    });
    const config = JSON.parse(JSON.stringify(scenario.config)) as Record<string, unknown> & {
      run: { authorization: { targets: Array<Record<string, unknown>>; allowedActions: string[] } };
      sandbox: { inputRoot: string };
      checks: Array<{ checkId: string; input: { paths?: string[] } }>;
      tasks: Array<{
        manifest: { taskId: string; allowedActions: string[]; scope: { inputs: Array<{ id: string; locator: string; digest: string; revision: string }> } };
        toolPolicy: unknown;
      }>;
    };
    // The owner-configured worker source root is deliberately separate from the entry target when the test
    // asks for a decoy: only a correct re-root to the acquired view can make the worker read the real file.
    config.sandbox.inputRoot = sandboxRoot;
    // The first-use owner-consent vocabulary is read/analyze (plus separately opted-in repo-script/state-change).
    // The legacy fixture's vestigial `local-test` verb can be granted by no human consent and is used by no
    // policy grant, so this preconfigured owner document is narrowed to the consent-grantable verbs; task
    // manifests are narrowed with it because a plan's allowedActions must stay inside the run authorization.
    // Every scope, digest, approval and source-binding assertion below stays as strict as before.
    config.run.authorization.allowedActions = ['read', 'analyze'];
    for (const task of config.tasks) {
      task.manifest.allowedActions = task.manifest.allowedActions.filter(action => action !== 'local-test');
    }
    if (options.sourceCheckPaths) {
      const sourceCheck = config.checks.find(check => check.checkId === 'hyp-case-source');
      if (!sourceCheck) throw new Error('the fixture scenario must define the hyp-case-source check');
      sourceCheck.input.paths = [...options.sourceCheckPaths];
    }
    const targets = config.run.authorization.targets;
    const sourceTarget = targets.find(target => target.id === TARGET_SOURCE);
    if (!sourceTarget) throw new Error('the fixture scenario must authorize the source artifact target');
    // An owner-approved artifact target's provenance is repeated in every task scope that names it, so the
    // run authorization and the task scopes are patched together (the contract compares them exactly).
    const pinSource = (locator: string, digest: string, revision: string): void => {
      sourceTarget.locator = locator;
      sourceTarget.digest = digest;
      sourceTarget.revision = revision;
      for (const task of config.tasks) {
        for (const input of task.manifest.scope.inputs) {
          if (input.id !== TARGET_SOURCE) continue;
          input.locator = locator;
          input.digest = digest;
          input.revision = revision;
        }
      }
    };
    if (options.localTarget) {
      const tree = await fingerprintTree({ root: snapshotRoot, bounds: ENTRY_BOUNDS_DEFAULTS });
      pinSource(snapshotRoot, tree.digest, 'local-tree-1');
    }
    if (options.repoTarget) pinSource(options.repoTarget.locator, options.repoTarget.digest, options.repoTarget.revision);
    if (options.planner) {
      const granted = config.tasks.find(task => task.manifest.taskId === TASK_HYP_CASE);
      if (!granted) throw new Error('the fixture scenario must authorize the case task');
      config.planner = {
        toolPolicy: granted.toolPolicy,
        boundaryReceipt: 'owner-approved planner worker; selects from the owner document only',
        role: 'worker',
      };
    }
    const assessmentPath = join(runDir, 'assessment.json');
    writeFileSync(assessmentPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return {
      runDir, assessmentPath, controlRoot: scenario.config.roots.control, workspaceRoot: scenario.config.roots.workspace,
      snapshotRoot, sandboxRoot, outputRoot, originA: environmentA.origin, environmentA, scenario,
      environmentB: { get current() { return environmentB; }, close: async () => { await environmentB?.close(); } },
      async close() {
        await environmentA.close().catch(() => {});
        await environmentB?.close().catch(() => {});
        for (let attempt = 0; attempt < 6; attempt++) {
          try { rmSync(runDir, { recursive: true, force: true }); break; }
          catch { await new Promise(done => setTimeout(done, 200)); }
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

/**
 * The injected git runner fabricates the same tree a real clone would produce (`src/index.ts` and an
 * excluded `.git` directory). Dropping that tree into a fresh directory and fingerprinting it yields the
 * exact owner-pinned digest the entry acquisition re-checks after the clone.
 */
async function syntheticCloneDigest(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'p2o-entry-clone-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const fixture = true;\n', { mode: 0o600 });
    return (await fingerprintTree({ root, bounds: ENTRY_BOUNDS_DEFAULTS })).digest;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The production author bound to an inert `pi-ai` provider fixture: the real code path, zero cost. */
function inertModelAuthor(): { author: ReturnType<typeof createPiModelPlanAuthor>; setPlan(plan: unknown): void; prompts: string[] } {
  const faux = fauxProvider({ provider: AUTHOR_PROVIDER, models: [{ id: AUTHOR_MODEL }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  const author = createPiModelPlanAuthor({
    selection: { provider: AUTHOR_PROVIDER, model: AUTHOR_MODEL, thinking: 'low' },
    complete: async ({ system, prompt, signal }) => {
      prompts.push(prompt);
      const message = await models.completeSimple(faux.getModel(), {
        systemPrompt: system,
        messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: prompt }] }],
      }, ...(signal ? [{ signal }] : []));
      return contentText(message.content ?? []);
    },
  });
  return { author, prompts, setPlan: plan => faux.setResponses([fauxAssistantMessage(JSON.stringify(plan))]) };
}

interface RegisteredPi {
  pi: ReturnType<typeof fakePi>;
  last(): { customType?: string; content?: unknown; details?: unknown };
  text(): string;
}

function registeredPi(app: EntryAppFixture, author: unknown, gitRunner?: ReturnType<typeof fakeGitRunner>['runner']): RegisteredPi {
  const pi = fakePi();
  registerP2O(pi.api, {
    backendFactory: context => createP2OBackend(context, {
      // [T8/T10] Model-spend enforcement is unconditional, so a managed run needs an owner-supplied
      // controller-owned gateway; the scripted inert worker below never contacts a provider, but the runtime
      // still refuses to dispatch a worker attempt whose spend gate is not bound to a real gateway process.
      // The upstream is loopback port 9 (discard) and is NEVER contacted: the gateway holds only a placeholder
      // credential for this fixture, mints per-attempt placeholders and never leaves this process.
      upstream: {
        approval: 'integration-inert-controller-gateway-never-contacted',
        provider: AUTHOR_PROVIDER,
        upstreamBaseUrl: 'http://127.0.0.1:9/',
        api: 'openai-completions',
        // Spend-enforced models need explicit completion/context bounds and a mapping for the requested
        // thinking level; the fixture selection is inert-fixture/inert-worker at thinking 'max'.
        models: [{ id: AUTHOR_MODEL, reasoning: true, contextWindow: 131_072, maxTokens: 4096, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max' } }],
        credential: { accountId: 'integration-inert-fixture-owner', version: '1', secret: 'integration-inert-fixture-placeholder-never-a-real-provider-key' },
        log: () => {},
      },
      // The fixture's verifier task needs its clean replay provider; everything else is the real composition.
      runtimePaths: { guardianPath: BUILT_GUARDIAN, receiptExtensionPath: BUILT_RECEIPTS },
      replayEnvironment: services => createFixtureReplayEnvironment(services, {
        port: 0, initial: () => app.environmentB.current!, setCurrent: instance => { (app.environmentB as { current?: FixtureInstance }).current = instance; },
      }),
      log: () => {},
      ...(gitRunner ? { entry: { commandRunner: gitRunner } } : {}),
    }),
    // TEST-ONLY: the preconfigured owner document is the out-of-band human consent for these suites; the
    // onboarding dialogs themselves are covered by tests/onboarding and tests/command/onboarding.contract.
    onboardingFor: preconfiguredOwnerConsent(app.assessmentPath),
    planAuthorFor: () => author,
  });
  const last = () => (pi.messages.at(-1) ?? {}) as { customType?: string; content?: unknown; details?: unknown };
  return { pi, last, text: () => String(last().content ?? '') };
}

async function command(host: RegisteredPi, args: string): Promise<{ customType?: string; text: string; details: Record<string, unknown> }> {
  await host.pi.command('p2o', args);
  const outcome = { customType: host.last().customType, text: host.text(), details: (host.last().details ?? {}) as Record<string, unknown> };
  if (outcome.customType === 'p2o_error') console.error(`[p2o ${args}] ${outcome.text}`);
  return outcome;
}

function entryPlanRecord(controlRoot: string, planId: string): {
  proposalDigest: string; proposalId: string; packet: { kind: string }; preparation: { runId: string };
} {
  const path = join(controlRoot, 'entry', 'entry-control', 'plans', `${planId}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as never;
}

async function until<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise(done => setTimeout(done, 100));
  }
}

/** Owner approval directory the composition both reads and, after a human confirmation, mints into. */
const approvalDirectory = (app: EntryAppFixture): string => join(app.controlRoot, 'entry', 'approvals');
const approvalFiles = (app: EntryAppFixture): string[] => { try { return readdirSync(approvalDirectory(app)); } catch { return []; } };

/** Private read-only view the entry workflow would hand to workers for a local/repository target. */
const entryView = (app: EntryAppFixture, runId = RUN_ID): string => join(app.controlRoot, 'entry', 'entry-views', runId, 'source');

/** One owner-scope generated request authored by the planning model. */
const healthPlan = (app: EntryAppFixture): unknown => ({
  steps: ['confirm the owner-approved loopback origin', 'issue one bounded read-only health request through the broker'],
  generatedRequests: [{
    requestId: 'health-1', taskId: TASK_HYP_CASE, tool: 'http.request', method: 'GET',
    url: `${app.originA}/healthz`, action: 'read', accountId: ACTOR_GUEST,
    kind: 'observation', classification: 'independently-observed',
    summary: 'Owner-scope health observation authored by the planning model',
    purpose: 'decide whether the owner-approved origin answers the bounded health route',
    requests: 1, expectation: { type: 'http', status: 200 },
  }],
});

/**
 * The owner menu of the case task, in the order the scripted worker walks it. Selecting the full menu keeps
 * the scripted worker plan admissible while still exercising the real plan-selection narrowing.
 */
const OWNER_MENU_CASE = [
  { taskId: TASK_HYP_CASE, observationId: 'hyp-case-source' },
];

const savedConfig = process.env.P2O_APP_CONFIG;
const savedPlanModule = process.env.P2O_PLAN_AUTHOR_MODULE;
afterAll(() => {
  if (savedConfig === undefined) delete process.env.P2O_APP_CONFIG; else process.env.P2O_APP_CONFIG = savedConfig;
  if (savedPlanModule === undefined) delete process.env.P2O_PLAN_AUTHOR_MODULE; else process.env.P2O_PLAN_AUTHOR_MODULE = savedPlanModule;
});

describe('unified /p2o command over the default composition', () => {
  it('drives prepare → model author → human approval → owner gate → supervisor worker → broker → report', async () => {
    const app = await prepareEntryApp();
    const { author, setPlan, prompts } = inertModelAuthor();
    setPlan({
      steps: ['confirm the owner-approved loopback origin', 'issue one bounded read-only health request through the broker'],
      generatedRequests: [{
        requestId: 'health-1', taskId: TASK_HYP_CASE, tool: 'http.request', method: 'GET',
        url: `${app.originA}/healthz`, action: 'read', accountId: ACTOR_GUEST,
        kind: 'observation', classification: 'independently-observed',
        summary: 'Owner-scope health observation authored by the planning model',
        purpose: 'decide whether the owner-approved origin answers the bounded health route',
        requests: 1, expectation: { type: 'http', status: 200 },
      }],
    });
    const host = registeredPi(app, author);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      // 1. --plan-only: prepare + plan, zero target requests, nothing cloned or launched.
      const planOnly = await command(host, `--target ${app.originA}/ --plan-only`);
      expect(planOnly.customType).toBe('p2o_result');
      expect(planOnly.details.targetRequests).toBe(0);
      expect(planOnly.text).toMatch(/no target request/i);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Owner-approved target');
      const planId = String(planOnly.details.planId);
      const record = entryPlanRecord(app.controlRoot, planId);
      expect(record.packet.kind).toBe('generated-requests');
      expect(record.preparation.runId).toBe(RUN_ID);
      expect(app.environmentA.requests).toBe(0);

      // 2. The human (owner) authors the approval document for the exact sealed proposal digest.
      const approvalDirectory = join(app.controlRoot, 'entry', 'approvals');
      mkdirSync(approvalDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(approvalDirectory, `request-approval-${record.proposalDigest}.json`), `${JSON.stringify({
        version: 1, approvalId: 'entry-request-approval-1', proposalId: record.proposalId,
        proposalDigest: record.proposalDigest, runId: RUN_ID, approvedBy: 'integration-owner',
        reference: 'owner-approved-entry-request', approvedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), requestCount: 1,
        note: 'Owner approves this exact generated request set.',
      })}\n`, { mode: 0o600 });

      // 3. /p2o approve <planId>: interactive confirmation, owner gate, real materialization, delegation.
      expect(host.pi.confirmCalls).toHaveLength(0);
      const approved = await command(host, `approve ${planId}`);
      expect(host.pi.confirmCalls).toHaveLength(1);
      expect(approved.customType).toBe('p2o_result');
      expect(approved.text).toMatch(/admitted once/i);
      const runId = String(approved.details.runId);

      // 4. The registered generated check is executed by a supervisor worker through the real broker.
      const registered = await until(
        () => app.environmentA.requests > 0 ? app.environmentA.requests : undefined,
        120_000, 'the loopback fixture to answer the registered generated check',
      );
      expect(registered).toBeGreaterThan(0);
      // The registered generated check itself is executed by the supervisor worker: its controller-minted
      // evidence receipt is `rchk-<proposal digest prefix>-<attemptId>`, and the registration is durable.
      const registeredEvidence = await until(async () => {
        const page = await host.pi.call('p2o_evidence', { runId, limit: 100 });
        const items = (page.details as { items: Array<{ evidenceId?: string }> }).items;
        return items.some(item => String(item.evidenceId ?? '').startsWith('rchk-')) ? items : undefined;
      }, 120_000, 'the registered generated check to produce controller evidence');
      expect(registeredEvidence.some(item => String(item.evidenceId ?? '').startsWith('rchk-'))).toBe(true);

      // 5. /p2o status and /p2o report use the current run of the same session.
      const status = await command(host, 'status');
      expect(status.customType).toBe('p2o_result');
      expect(status.details.runId).toBe(runId);
      const snapshot = status.details.result as { run?: { state?: string; requestedRuntime?: { selection?: { provider?: string } } }; process?: { attempts?: unknown[] } };
      expect(snapshot.run?.requestedRuntime?.selection?.provider).toBe('inert-fixture');
      expect(Array.isArray(snapshot.process?.attempts)).toBe(true);

      const report = await command(host, 'report');
      expect(report.customType).toBe('p2o_result');
      expect(report.text.length).toBeGreaterThan(0);

      // 6. Verified stop keeps the legacy gate; session shutdown then closes the composition.
      const stopped = await command(host, `stop ${runId}`);
      expect(stopped.customType).toBe('p2o_result');
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 240_000);

  it('intakes an owner-approved local directory offline and refuses anything outside the owner document', async () => {
    // The owner pins the exact content digest of the local directory in the run document; the entry
    // preparation fingerprints the tree and must match it (nothing is copied and nothing is executed).
    const app = await prepareEntryApp({ localTarget: true, planner: true });

    const { author, setPlan } = inertModelAuthor();
    setPlan({
      steps: ['read the owner-approved source snapshot statically'],
      ownerMenu: [{ taskId: TASK_HYP_CASE, observationId: 'hyp-case-source' }],
    });
    const host = registeredPi(app, author);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      const result = await command(host, `--target ${app.snapshotRoot} --plan-only`);
      expect(result.customType).toBe('p2o_result');
      expect(result.details.targetRequests).toBe(0);
      const planId = String(result.details.planId);
      const record = entryPlanRecord(app.controlRoot, planId);
      expect(record.packet.kind).toBe('owner-menu');
      // No acquisition happened before approval: the entry workspace holds no snapshot copy yet.
      expect(() => readFileSync(join(app.workspaceRoot, 'entry-views', RUN_ID, 'source', 'fixture-server.ts'), 'utf8')).toThrow();

      const denied = await command(host, '--target /etc --plan-only');
      expect(denied.customType).toBe('p2o_error');
      expect(denied.text).toMatch(/TARGET_DENIED/);
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 180_000);

  it('intakes a GitHub repository offline, refuses an unapproved repository, and hands the clone to the worker after approval', async () => {
    const { runner, invocations } = fakeGitRunner();
    const app = await prepareEntryApp({
      repoTarget: { locator: 'https://github.com/owner/repo', digest: await syntheticCloneDigest(), revision: 'a'.repeat(40) },
      planner: true, gitRunner: runner, sourceCheckPaths: ['src/index.ts'],
    });
    const { author, setPlan } = inertModelAuthor();
    // Only observations whose owner-derived target affinity includes the repository artifact are
    // selectable for a repository target; the plan may narrow, never widen, that menu.
    setPlan({ steps: ['review the owner-approved repository revision'], ownerMenu: [{ taskId: TASK_HYP_CASE, observationId: 'hyp-case-source' }] });
    const host = registeredPi(app, author, runner);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      const denied = await command(host, '--target https://github.com/attacker/repo --plan-only');
      expect(denied.customType).toBe('p2o_error');
      expect(denied.text).toMatch(/TARGET_DENIED/);
      expect(invocations).toHaveLength(0);

      // The human confirms the repository scope; the controller mints the exact approval and only then
      // does the hardened clone run. No approval file is written by the test.
      const approved = await command(host, '--target https://github.com/owner/repo');
      expect(approved.customType).toBe('p2o_result');
      const runId = String(approved.details.runId);
      const planId = String(approved.details.planId);
      const record = entryPlanRecord(app.controlRoot, planId);
      expect(String(approved.details.approvalPath)).toBe(join(approvalDirectory(app), `plan-approval-${record.proposalDigest}.json`));
      expect(statSync(String(approved.details.approvalPath)).mode & 0o777).toBe(0o600);

      // The hardened clone runs only after the human approval, with an argv that pins depth/single-branch/
      // config hardening and an environment that removes ambient git configuration.
      const invocation = await until(() => invocations[0], 60_000, 'the hardened clone invocation');
      expect(invocation.file).toMatch(/git$/);
      expect(invocation.args.slice(0, 3)).toEqual(['clone', '--depth', '1']);
      expect(invocation.args).toContain('--single-branch');
      expect(invocation.args).toContain('--no-tags');
      expect(invocation.args).toContain('--no-recurse-submodules');
      // `core.symlinks=true`: links stay real links so the shared no-follow walker excludes them instead of
      // checking link text out as ordinary source.
      expect(invocation.args).toContain('core.symlinks=true');
      expect(invocation.args).toContain('credential.helper=');
      expect(invocation.args).toContain('https://github.com/owner/repo');
      expect(invocation.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(invocation.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(invocation.env.GIT_ASKPASS).toBe('');

      // The worker source root is proven content-identical to the acquired clone view; the binding is durable.
      const registration = JSON.parse(readFileSync(join(app.controlRoot, 'entry-registrations', `plan-${planId}.json`), 'utf8')) as {
        sourceBinding?: { workerInputRoot: string; workerDigest: string; equivalent: boolean; revision?: string; digest?: string };
      };
      const cloneDigest = await syntheticCloneDigest();
      expect(registration.sourceBinding?.workerInputRoot).toBe(app.sandboxRoot);
      expect(registration.sourceBinding?.workerDigest).toBe(cloneDigest);
      expect(registration.sourceBinding?.equivalent).toBe(true);
      expect(registration.sourceBinding?.revision).toBe('a'.repeat(40));
      expect(registration.sourceBinding?.digest).toBe(cloneDigest);

      await command(host, `stop ${runId}`);
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 180_000);

  it('binds an owner-private plan-author module when the host session supplies none', async () => {
    const app = await prepareEntryApp();
    const moduleDir = mkdtempSync(join(tmpdir(), 'p2o-entry-author-'));
    const modulePath = join(moduleDir, 'plan-author.mjs');
    const markerPath = join(moduleDir, 'called.txt');
    // The owner-private module is the standalone (P2O_CONTROL_MODULE-style) author binding: it must be an
    // owner-only canonical ESM file exporting createEntryPlanAuthor(), and its output is still re-validated
    // by the entry port against the owner menu/envelope.
    writeFileSync(modulePath, [
      "import { appendFileSync } from 'node:fs';",
      `export function createEntryPlanAuthor() {`,
      "  return {",
      "    async author(input, signal) {",
      `      appendFileSync(${JSON.stringify(markerPath)}, 'called\\n');`,
      "      if (signal?.aborted) throw new Error('cancelled');",
      "      return {",
      "        authoredBy: 'model', attemptId: 'module-plan-author',",
      "        steps: ['issue one bounded owner-scope health request'],",
      "        packet: { kind: 'generated-requests', proposal: {",
      "          schemaVersion: 1, proposalId: 'module-request-proposal-1', runId: input.preparation.runId,",
      "          generator: { generatorAttemptId: 'module-plan-author', generatorKind: 'worker',",
      "            requestedSelection: { provider: 'inert-fixture', model: 'inert-worker', thinking: 'max' },",
      "            inputDigests: [], producedAt: new Date().toISOString() },",
      "          requests: [{ requestId: 'module-health', taskId: 'task-hyp-case', tool: 'http.request', method: 'GET',",
      "            url: input.facts.locator.replace(/\\/$/, '') + '/healthz', action: 'read', accountId: 'guest',",
      "            kind: 'observation', classification: 'independently-observed', summary: 'owner-scope health observation',",
      "            purpose: 'decide the bounded health route', requests: 1, expectation: { type: 'http', status: 200 } }],",
      "        } },",
      "      };",
      "    },",
      "  };",
      "}",
      "",
    ].join('\n'), { mode: 0o600 });
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    process.env.P2O_PLAN_AUTHOR_MODULE = modulePath;
    // No host author and no `entry.planAuthor` override: the module is the only binding.
    const host = registeredPi(app, undefined);
    try {
      const result = await command(host, `--target ${app.originA}/ --plan-only`);
      expect(result.customType).toBe('p2o_result');
      expect(result.details.targetRequests).toBe(0);
      expect(readFileSync(markerPath, 'utf8')).toContain('called');
      expect(entryPlanRecord(app.controlRoot, String(result.details.planId)).packet.kind).toBe('generated-requests');
      await host.pi.event('session_shutdown');
      await app.close();

      // A module without the required export is refused at backend construction (fail closed, no fallback
      // plan). The author is bound when the composition is built, so this needs its own backend.
      const second = await prepareEntryApp();
      const badPath = join(moduleDir, 'bad.mjs');
      writeFileSync(badPath, 'export const nothing = true;\n', { mode: 0o600 });
      process.env.P2O_APP_CONFIG = second.assessmentPath;
      process.env.P2O_PLAN_AUTHOR_MODULE = badPath;
      const refusedHost = registeredPi(second, undefined);
      try {
        const refused = await command(refusedHost, `--target ${second.originA}/ --plan-only`);
        expect(refused.customType).toBe('p2o_error');
        expect(refused.text).toMatch(/INTEGRATION_INVALID/);
      } finally {
        await refusedHost.pi.event('session_shutdown');
        await second.close();
      }
    } finally {
      delete process.env.P2O_PLAN_AUTHOR_MODULE;
      rmSync(moduleDir, { recursive: true, force: true });
      await app.close();
    }
  }, 180_000);
  it('mints the exact owner approval from one human confirmation for a non-plan-only target run', async () => {
    const app = await prepareEntryApp();
    const { author, setPlan, prompts } = inertModelAuthor();
    setPlan(healthPlan(app));
    const host = registeredPi(app, author);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      // The test never authors an approval file: the human confirmation is the only source.
      expect(approvalFiles(app)).toHaveLength(0);
      expect(host.pi.confirmCalls).toHaveLength(0);
      const approved = await command(host, `--target ${app.originA}/`);
      expect(host.pi.confirmCalls).toHaveLength(1);
      expect(approved.customType).toBe('p2o_result');
      expect(approved.text).toMatch(/admitted/i);
      const runId = String(approved.details.runId);
      const planId = String(approved.details.planId);
      const record = entryPlanRecord(app.controlRoot, planId);

      // The controller created exactly the digest-named owner artifact the ledger reads, 0600, bound to the
      // proposal identity and to the human confirmation reference, and inside the owner window.
      const mintedPath = String(approved.details.approvalPath);
      expect(mintedPath).toBe(join(approvalDirectory(app), `request-approval-${record.proposalDigest}.json`));
      expect(statSync(mintedPath).mode & 0o777).toBe(0o600);
      const document = JSON.parse(readFileSync(mintedPath, 'utf8')) as { proposalId: string; proposalDigest: string; runId: string; reference: string; expiresAt: string; requestCount: number };
      expect(document.proposalId).toBe(record.proposalId);
      expect(document.proposalDigest).toBe(record.proposalDigest);
      expect(document.runId).toBe(RUN_ID);
      expect(document.reference).toBe(String(approved.details.approvalRef));
      expect(document.requestCount).toBe(1);
      expect(Date.parse(document.expiresAt)).toBeGreaterThan(Date.now());
      expect(prompts).toHaveLength(1);

      // The worker executes the registered check through the real broker and the run reports normally.
      await until(() => app.environmentA.requests > 0 ? true : undefined, 120_000, 'the fixture to answer the minted run');
      const status = await command(host, 'status');
      expect(status.details.runId).toBe(runId);
      const report = await command(host, 'report');
      expect(report.customType).toBe('p2o_result');
      await command(host, `stop ${runId}`);
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 240_000);

  it('binds the session model author when a tool or status call builds the composition first', async () => {
    const app = await prepareEntryApp();
    const { author, setPlan, prompts } = inertModelAuthor();
    setPlan(healthPlan(app));
    const host = registeredPi(app, author);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      // Tool-first: the tool dispatch path never carries a session author and builds the backend now.
      await host.pi.call('p2o_evidence', { runId: RUN_ID, limit: 5 }).catch(() => undefined);
      // Status-first with an explicit run id also skips entry-port author resolution.
      await command(host, `status ${RUN_ID}`);
      // The later target command must still bind the actual session author to the already-built backend.
      const planOnly = await command(host, `--target ${app.originA}/ --plan-only`);
      expect(planOnly.customType).toBe('p2o_result');
      expect(planOnly.details.targetRequests).toBe(0);
      expect(prompts).toHaveLength(1);
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 180_000);

  it('never mints or starts without a genuine human confirmation', async () => {
    const app = await prepareEntryApp();
    const { author, setPlan } = inertModelAuthor();
    setPlan(healthPlan(app));
    const host = registeredPi(app, author);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      // Tool origin: the model can never approve, so it can never reach the mint.
      await expect(host.pi.call('p2o_plan', { action: 'approve', runId: RUN_ID, proposalDigest: 'a'.repeat(64), approvalPath: 'approval.json' }))
        .rejects.toThrow(/APPROVAL_HUMAN_ONLY/);
      expect(approvalFiles(app)).toHaveLength(0);

      // Human declines the dialog.
      host.pi.setConfirm(false);
      const declined = await command(host, `--target ${app.originA}/`);
      expect(declined.customType).toBe('p2o_error');
      expect(declined.text).toMatch(/NOT_APPROVED/);
      expect(approvalFiles(app)).toHaveLength(0);
      expect(app.environmentA.requests).toBe(0);

      // No UI at all: the command refuses before a confirmation or a mint.
      setPlan(healthPlan(app));
      host.pi.setHasUI(false);
      const headless = await command(host, `--target ${app.originA}/`);
      expect(headless.customType).toBe('p2o_error');
      expect(headless.text).toMatch(/HUMAN_CONFIRMATION_REQUIRED/);
      host.pi.setHasUI(true);
      expect(approvalFiles(app)).toHaveLength(0);
      expect(app.environmentA.requests).toBe(0);
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 180_000);

  it('refuses a mutated stored proposal at the owner gate before admitting anything', async () => {
    const app = await prepareEntryApp();
    const { author, setPlan } = inertModelAuthor();
    setPlan(healthPlan(app));
    const host = registeredPi(app, author);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      const planOnly = await command(host, `--target ${app.originA}/ --plan-only`);
      expect(planOnly.customType).toBe('p2o_result');
      const planId = String(planOnly.details.planId);
      const record = entryPlanRecord(app.controlRoot, planId);

      // Mutate the ledger's stored proposal after the human reviewed the sealed digest.
      const ledgerPath = join(app.controlRoot, 'request-plans', `${record.proposalId}.json`);
      const stored = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { proposal: { requests: Array<{ url: string }> } };
      stored.proposal.requests[0]!.url = 'https://mutated.invalid/healthz';
      writeFileSync(ledgerPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

      const refused = await command(host, `approve ${planId}`);
      expect(host.pi.confirmCalls).toHaveLength(1);
      expect(refused.customType).toBe('p2o_error');
      expect(refused.text).toMatch(/ENTRY_PLAN_REJECTED/);
      expect(refused.text).toMatch(/digest/i);
      expect(app.environmentA.requests).toBe(0);
      await expect(host.pi.call('p2o_status', { runId: RUN_ID })).rejects.toThrow();
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 180_000);

  it('refuses an expired owner-authored approval and never overwrites the owner document', async () => {
    const app = await prepareEntryApp();
    const { author, setPlan } = inertModelAuthor();
    setPlan(healthPlan(app));
    const host = registeredPi(app, author);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      const planOnly = await command(host, `--target ${app.originA}/ --plan-only`);
      expect(planOnly.customType).toBe('p2o_result');
      const planId = String(planOnly.details.planId);
      const record = entryPlanRecord(app.controlRoot, planId);
      mkdirSync(approvalDirectory(app), { recursive: true, mode: 0o700 });
      const expiredPath = join(approvalDirectory(app), `request-approval-${record.proposalDigest}.json`);
      const expired = {
        version: 1, approvalId: 'owner-expired-1', proposalId: record.proposalId, proposalDigest: record.proposalDigest,
        runId: RUN_ID, approvedBy: 'integration-owner', reference: 'owner-expired',
        approvedAt: new Date(Date.now() - 7_200_000).toISOString(), expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        requestCount: 1,
      };
      writeFileSync(expiredPath, `${JSON.stringify(expired)}\n`, { mode: 0o600 });

      const refused = await command(host, `approve ${planId}`);
      expect(refused.customType).toBe('p2o_error');
      expect(refused.text).toMatch(/ENTRY_PLAN_REJECTED/);
      expect(refused.text).toMatch(/expired/i);
      expect((JSON.parse(readFileSync(expiredPath, 'utf8')) as { approvalId: string }).approvalId).toBe('owner-expired-1');
      expect(app.environmentA.requests).toBe(0);
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 180_000);

  it('verifies the worker source root is content-identical to the acquired local snapshot', async () => {
    const app = await prepareEntryApp({
      localTarget: true, planner: true, sourceCheckPaths: ['fixture-server.ts'],
      extraSnapshotFiles: {
        'canary.cjs': "require('node:fs').writeFileSync(process.env.P2O_CANARY ?? '/tmp/p2o-canary-ran', 'ran');\n",
      },
    });
    const { author, setPlan } = inertModelAuthor();
    setPlan({ steps: ['read the owner-approved source view statically'], ownerMenu: OWNER_MENU_CASE });
    const host = registeredPi(app, author);
    process.env.P2O_APP_CONFIG = app.assessmentPath;
    try {
      const approved = await command(host, `--target ${app.snapshotRoot}`);
      expect(approved.customType).toBe('p2o_result');
      const runId = String(approved.details.runId);
      const planId = String(approved.details.planId);
      const registration = JSON.parse(readFileSync(join(app.controlRoot, 'entry-registrations', `plan-${planId}.json`), 'utf8')) as {
        runId: string;
        sourceBinding?: { workerInputRoot: string; workerDigest: string; equivalent: boolean; relativePaths: string[]; digest?: string };
      };
      const binding = registration.sourceBinding;
      const targetDigest = (await fingerprintTree({ root: app.snapshotRoot, bounds: ENTRY_BOUNDS_DEFAULTS })).digest;
      expect(binding).toBeDefined();
      // The read-only view exists and the owner-configured worker root is proven byte-identical to it.
      expect(binding!.workerInputRoot).toBe(app.snapshotRoot);
      expect(binding!.digest).toBe(targetDigest);
      expect(binding!.workerDigest).toBe(targetDigest);
      expect(binding!.equivalent).toBe(true);
      expect(binding!.relativePaths).toContain('fixture-server.ts');
      expect(existsSync(entryView(app))).toBe(true);

      // The delegated worker really scanned the verified root: its controller-minted receipt exists.
      let evidence: Array<{ evidenceId?: string }> = [];
      const deadline = Date.now() + 90_000;
      for (;;) {
        const page = await host.pi.call('p2o_evidence', { runId, limit: 100 });
        evidence = (page.details as { items: Array<{ evidenceId?: string }> }).items;
        if (evidence.some(item => String(item.evidenceId ?? '').startsWith('hyp-case-source'))) break;
        if (Date.now() > deadline) throw new Error('timed out waiting for the source.analyze receipt from the verified source root');
        await new Promise(done => setTimeout(done, 500));
      }
      expect(evidence.some(item => String(item.evidenceId ?? '').startsWith('hyp-case-source'))).toBe(true);

      // No target code was executed: the canary was copied into the read-only view but never ran.
      expect(existsSync(join(entryView(app), 'canary.cjs'))).toBe(true);
      expect(existsSync('/tmp/p2o-canary-ran')).toBe(false);
      await command(host, `stop ${runId}`);
      await host.pi.event('session_shutdown');
    } finally {
      await app.close();
    }
  }, 240_000);

  it('refuses a local source workflow whose worker root is not the acquired view', async () => {
    const decoyRoot = mkdtempSync(join(tmpdir(), 'p2o-entry-decoy-'));
    try {
      const app = await prepareEntryApp({
        localTarget: true, planner: true, sandboxRoot: decoyRoot, sourceCheckPaths: ['fixture-server.ts'],
      });
      const { author, setPlan } = inertModelAuthor();
      setPlan({ steps: ['read the owner-approved source view statically'], ownerMenu: OWNER_MENU_CASE });
      const host = registeredPi(app, author);
      process.env.P2O_APP_CONFIG = app.assessmentPath;
      try {
        const refused = await command(host, `--target ${app.snapshotRoot}`);
        expect(refused.customType).toBe('p2o_error');
        expect(refused.text).toMatch(/ENTRY_SOURCE_UNBOUND/);
        // Refused before delegation: no worker ran and the decoy root was never scanned.
        await expect(host.pi.call('p2o_status', { runId: RUN_ID })).rejects.toThrow();
        expect(app.environmentA.requests).toBe(0);
        await host.pi.event('session_shutdown');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(decoyRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
