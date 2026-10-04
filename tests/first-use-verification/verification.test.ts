/**
 * First-use independent-verification suite (REAL PROCESSES + REAL BROKER + REAL CONTAINERS, MODEL-INERT).
 *
 * Every test here uses the real bundled backend: real `/p2o` command handler, real owner consent, real native
 * Pi planning API, real worker Pi processes, real Docker-backed container tool boundary, real supervisor,
 * real tool broker and the real evidence vault. The only fixture is the explicitly inert loopback model
 * (`MODEL-INERT ONLY`) and the loopback lab HTTP server. NOT a live-AI, live-provider or hostile-code claim.
 *
 * The verification contract under test: the verifier task/plan identity is derived from the owner-approved
 * checks and pre-authorized as a deferred task, but it is admitted and launched ONLY after the producing
 * attempt's packet is durably admitted and its exact per-claim collector receipts pass controller validation.
 * The verifier attempt runs in the same original run under its own narrowed verifier grant and the protected
 * verifier phase ledger; promotion or rejection comes from the controller-owned replay, never from worker prose.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ModelRuntime, ModelRegistry, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../extensions/p2o/index.js';
import { ensureOwnerOnboarding } from '../../src/application/onboarding/index.js';
import { removePrivateSourceTree } from '../../src/application/entry/snapshot.js';
import { startLabFixture, type LabFixture } from './lab-fixture.js';
import { inertVerificationProvider } from './inert-provider.js';

const repo = resolve(import.meta.dirname, '../..');

interface HarnessOptions {
  plan?: 'differential' | 'benign';
}

async function harness(options: HarnessOptions = {}) {
  for (const key of ['P2O_CONTROL_MODULE', 'P2O_APP_CONFIG', 'P2O_PLAN_AUTHOR_MODULE']) delete process.env[key];
  const root = await mkdtemp(join(homedir(), '.p2o-FIRST-USE-VERIFY-MODEL-INERT-'));
  const provider = await inertVerificationProvider({ ...(options.plan ? { plan: options.plan } : {}) });
  const runtime = await ModelRuntime.create({ authPath: join(root, 'host-auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('inert-fixture', {
    baseUrl: provider.origin, api: 'openai-completions', apiKey: 'explicit-inert-secret-not-live',
    models: [{ id: 'inert-worker', name: 'MODEL-INERT ONLY', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 }, contextWindow: 128000, maxTokens: 4096 }],
  });
  const models = await runtime.getAvailable();
  const model = models.find(candidate => candidate.provider === 'inert-fixture')!;
  const registry = new ModelRegistry(runtime);
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const messages: any[] = [];
  const notifications: any[] = [];
  const dialogs: Array<{ title: string; body?: string }> = [];
  const pi = {
    registerTool() {}, registerCommand(name: string, spec: any) { if (name === 'p2o') handler = spec.handler; },
    on() {}, appendEntry() {}, sendMessage(message: any) { messages.push(message); },
  } as unknown as ExtensionAPI;
  const ui = {
    async confirm(title: string, body: string) { dialogs.push({ title, body }); return true; },
    async select(title: string, choices: string[]) { dialogs.push({ title }); return choices[0]; },
    async input(title: string, placeholder?: string) {
      dialogs.push({ title });
      if (title.startsWith('Maximum model tokens')) return '400000';
      if (title.startsWith('Total USD')) return '10';
      return placeholder ?? 'explicit inert test owner';
    },
    notify(message: string, type?: string) { notifications.push({ message, type }); }, setStatus() {},
  };
  const controller = registerP2O(pi, { onboardingFor: input => ensureOwnerOnboarding(input, { storageRoot: join(root, 'owner-consent') }) });
  const ctx = {
    cwd: repo, model, modelRegistry: registry, thinkingLevel: 'off', hasUI: true, mode: 'rpc', ui,
    waitForIdle: async () => {}, sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionCommandContext;
  async function command(args: string) {
    const before = messages.length;
    await handler!(args, ctx);
    return messages.slice(before).at(-1)?.details as any;
  }
  async function waitForRun(runId: string) {
    let status: any;
    for (let index = 0; index < 900; index++) {
      status = await controller.execute('status', { runId }, repo);
      if (['completed', 'failed', 'cancelled'].includes(status.run?.state)) return status;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    throw new Error(`run did not settle: ${JSON.stringify(status?.run)}`);
  }
  async function report(runId: string, format: 'json' | 'markdown' = 'json') {
    const rendered: any = await controller.execute('report', { runId, format }, repo);
    // The control plane projects the backend's `{format, content, modelBudget}` envelope; keep the protected
    // phase accounting and unwrap the rendered content without relying on the composition's render shape.
    const modelBudget = rendered && typeof rendered === 'object' ? rendered.modelBudget : undefined;
    const unwrap = (value: any): any => (value && typeof value === 'object' && 'content' in value && !('findings' in value) && !('packets' in value) ? unwrap(value.content) : value);
    const content = unwrap(rendered);
    if (format !== 'json') return content;
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return parsed && typeof parsed === 'object' ? { ...parsed, ...(modelBudget ? { modelBudget } : {}) } : parsed;
  }
  return {
    root, provider, dialogs, notifications, controller, command, waitForRun, report, messages,
    async close() {
      await controller.close();
      await provider.close();
      if (process.env.P2O_FIRST_USE_VERIFY_KEEP === '1') { console.log(`P2O_FIRST_USE_VERIFY_KEEP root=${root}`); return; }
      await removePrivateSourceTree(root);
    },
  };
}

/** Run the real command flow against an owner-approved literal-loopback lab target. */
async function runAgainst(fixture: LabFixture, options: HarnessOptions = {}) {
  const support = await harness(options);
  const target = `${fixture.origin}${fixture.path}`;
  const planned = await support.command(`--target ${target} --plan-only`);
  expect(support.notifications.filter(notification => notification.type === 'error')).toEqual([]);
  expect(planned?.planOnly).toBe(true);
  expect(fixture.requests).toHaveLength(0);
  await support.command(`approve ${planned.planId}`);
  const status = await support.waitForRun(planned.runId);
  return { support, planned, status };
}

interface RunArtifacts {
  runDir: string;
  config: any;
  synthesis: any;
  admission: any;
  evidence: Map<string, any>;
  tasks: Map<string, any>;
  attempts: Map<string, any>;
  events: Array<{ sequence: number; type: string; taskId: string | null; attemptId: string | null; payload: any }>;
}

/** Read the durable control/evidence state of one settled run without re-validating it through the product. */
async function readRunArtifacts(support: { root: string }, runId: string): Promise<RunArtifacts> {
  const runDirs = await readdir(join(support.root, 'runs'));
  expect(runDirs).toHaveLength(1);
  const runDir = join(support.root, 'runs', runDirs[0]!);
  const db = new DatabaseSync(join(runDir, 'state.sqlite'), { readOnly: true });
  let events: RunArtifacts['events'], evidence: Map<string, any>, tasks: Map<string, any>, attempts: Map<string, any>;
  try {
    events = db.prepare('SELECT sequence, type, task_id, attempt_id, payload_json FROM events WHERE run_id = ? ORDER BY sequence').all(runId)
      .map((row: any) => ({ sequence: Number(row.sequence), type: String(row.type), taskId: row.task_id ?? null, attemptId: row.attempt_id ?? null, payload: JSON.parse(String(row.payload_json)) }));
    evidence = new Map(db.prepare('SELECT evidence_id, json FROM evidence WHERE run_id = ?').all(runId).map((row: any) => [String(row.evidence_id), JSON.parse(String(row.json))]));
    tasks = new Map(db.prepare('SELECT task_id, json FROM tasks WHERE run_id = ?').all(runId).map((row: any) => [String(row.task_id), JSON.parse(String(row.json))]));
    attempts = new Map(db.prepare('SELECT attempt_id, json FROM attempts WHERE run_id = ?').all(runId).map((row: any) => [String(row.attempt_id), JSON.parse(String(row.json))]));
  } finally { db.close(); }
  const config = JSON.parse(await readFile(join(runDir, 'control/application.json'), 'utf8'));
  const synthesis = JSON.parse(await readFile(join(runDir, 'control/verification-synthesis.json'), 'utf8'));
  let admission: any;
  try { admission = JSON.parse(await readFile(join(runDir, 'control/verification/admission.json'), 'utf8')); } catch { admission = undefined; }
  return { runDir, config, synthesis, admission, evidence, tasks, attempts, events };
}

const eventOf = (artifacts: RunArtifacts, type: string, taskId: string) => artifacts.events.find(entry => entry.type === type && entry.taskId === taskId);
const evidenceOf = (artifacts: RunArtifacts, id: string) => {
  const receipt = artifacts.evidence.get(id);
  expect(receipt, `missing evidence ${id}`).toBeTruthy();
  return receipt;
};

describe('first-use independent verification (MODEL-INERT real-process fixtures)', () => {
  it('promotes an owner-approved differential only after the admitted producer packet is validated and a fresh verifier attempt replays it', async () => {
    const fixture = await startLabFixture();
    const { support, planned, status } = await runAgainst(fixture);
    try {
      expect(status.run.state).toBe('completed');
      const artifacts = await readRunArtifacts(support, planned.runId);
      const admission = artifacts.admission;
      expect(admission?.phase, JSON.stringify(admission)).toBe('admitted');

      // The owner document authorizes the exact verifier identity as a deferred task, but no finding or
      // verification plan exists before execution: the pre-execution record is the derivation, not a finding.
      expect(artifacts.config.tasks.map((entry: any) => entry.role)).toEqual(['worker', 'verifier']);
      expect(artifacts.config.tasks[1].deferred).toBe(true);
      expect(artifacts.config.tasks[1].manifest.taskId).toBe(admission.verifierTaskId);
      expect(artifacts.config.tasks[1].manifest.scope.environmentId).not.toBe(artifacts.config.tasks[0].manifest.scope.environmentId);
      expect(artifacts.config.tasks[1].toolPolicy.tools).toContain('p2o_verify');
      expect(artifacts.config.tasks[1].toolPolicy.extension.path).toBe(join(repo, 'examples/local-assessment/bridge-extension.js'));
      expect(artifacts.config.reporting.findings ?? []).toEqual([]);
      expect(artifacts.config.reporting.verification ?? []).toEqual([]);
      expect(artifacts.synthesis).toMatchObject({ supported: true, phase: 'candidate-evidence-required', verifierTaskId: admission.verifierTaskId });

      // The producer packet is durably admitted before the verifier task is admitted or any verifier attempt exists.
      const producerAccepted = eventOf(artifacts, 'orchestrator.result-admitted', 'assessment')!;
      const verifierAdmitted = eventOf(artifacts, 'orchestrator.task-admitted', admission.verifierTaskId)!;
      const verifierLaunched = eventOf(artifacts, 'orchestrator.attempt-launched', admission.verifierTaskId)!;
      expect(producerAccepted).toBeTruthy();
      expect(verifierAdmitted).toBeTruthy();
      expect(verifierLaunched).toBeTruthy();
      expect(producerAccepted.payload.status).toBe('accepted');
      expect(admission.resultId).toBe(producerAccepted.payload.resultId);
      expect(producerAccepted.sequence).toBeLessThan(verifierAdmitted.sequence);
      expect(verifierAdmitted.sequence).toBeLessThan(verifierLaunched.sequence);
      expect(typeof verifierLaunched.payload.attemptId).toBe('string');
      expect(artifacts.tasks.has(admission.verifierTaskId)).toBe(true);

      // Exact per-claim receipts: the dynamic finding uses the program's own collector receipts, not the
      // packet's broad attribution, and every receipt is claim-bound and the producing attempt's own.
      const claim = admission.claimDigest;
      expect(claim).toMatch(/^[a-f0-9]{64}$/);
      const baseline = evidenceOf(artifacts, admission.baselineEvidenceId);
      const control = evidenceOf(artifacts, admission.controlEvidenceId);
      const reproduction = evidenceOf(artifacts, admission.reproductionEvidenceId);
      expect(new Set([baseline.evidenceId, control.evidenceId, reproduction.evidenceId]).size).toBe(3);
      expect([baseline.kind, control.kind, reproduction.kind]).toEqual(['observation', 'negative-control', 'reproduction']);
      for (const receipt of [control, reproduction]) {
        expect(receipt.attemptId).toBe(admission.producerAttemptId);
        expect(receipt.metadata.claimDigest).toBe(claim);
        expect(receipt.test).toMatchObject({ outcome: 'passed', successes: 1, attempts: 1, originalPolicy: true });
      }
      expect(baseline.attemptId).toBe(admission.producerAttemptId);

      const report = await support.report(planned.runId, 'json');
      expect(report.findings).toHaveLength(1);
      const finding = report.findings[0];
      expect(finding.findingId).toBe(admission.findingId);
      expect(finding.evidenceIds).toEqual([admission.reproductionEvidenceId]);
      expect(finding.negativeControlEvidenceIds).toEqual([admission.controlEvidenceId]);
      expect(finding.evidenceIds).not.toContain(admission.baselineEvidenceId);
      expect(finding.state).toBe('independently-validated');
      expect(finding.classification).toBe('independently-observed');
      const producerAttempt = [...artifacts.attempts.values()].find((attempt: any) => attempt.taskId === 'assessment')!;
      expect(finding.verifier).toBeTruthy();
      expect(finding.verifier.identity).not.toBe(finding.producerId);
      expect(finding.verifier.attemptId).not.toBe(producerAttempt.attemptId);
      expect(finding.verifier.evidenceIds.some((id: string) => id.endsWith('.reproduction'))).toBe(true);
      expect(finding.verifier.evidenceIds.some((id: string) => id.endsWith('.negative-control'))).toBe(true);

      // The verifier-owned receipts are real authenticated vault receipts collected by a verifier collector in
      // its own attempt/environment, and the session explicitly does not claim a target reset.
      const verifierEvidence = report.evidence.filter((entry: any) => finding.verifier.evidenceIds.includes(entry.evidenceId));
      expect(verifierEvidence.some((entry: any) => entry.kind === 'runtime' && entry.collectorRole === 'verifier')).toBe(true);
      expect(verifierEvidence.some((entry: any) => entry.test?.purpose === 'reproduction' && entry.test?.outcome === 'passed')).toBe(true);
      expect(verifierEvidence.some((entry: any) => entry.test?.purpose === 'negative-control' && entry.test?.outcome === 'passed')).toBe(true);
      const environmentId = `${finding.findingId}.${finding.verifier.attemptId}.environment`;
      const environment = evidenceOf(artifacts, environmentId);
      expect(environment.metadata).toMatchObject({ independentSession: true, targetReset: false, fixtureReset: false, recipeDigest: expect.any(String) });
      expect(environment.provenance.collectorId).toBe(finding.verifier.identity);
      expect(environment.provenance.environmentId).not.toBe(artifacts.tasks.get('assessment')!.scope.environmentId);
      expect(environment.provenance.environmentId).toBe(artifacts.tasks.get(admission.verifierTaskId)!.scope.environmentId);
      expect(JSON.stringify(report)).not.toContain('"targetReset":true');
      expect(JSON.stringify(report)).not.toContain('cleanEnvironment');

      // Protected verifier phase debit: the verifier attempt's provider turns were charged to the protected
      // verifier ledger, the workers ledger paid the producer, and no phase borrowed from another.
      expect(report.modelBudget.phases.verifier.committed.tokens).toBeGreaterThan(0);
      expect(report.modelBudget.phases.verifier.limits.maxTokens).toBe(40960);
      expect(report.modelBudget.phases.verifier.remaining.tokens).toBeLessThan(40960);
      expect(report.modelBudget.phases.workers.committed.tokens).toBeGreaterThan(0);
      expect(report.modelBudget.policy).toBe('isolated-phase-caps-no-borrowing');

      // Cleanup: the replay environment termination and the verifier attempt termination are receipt-backed.
      const terminated = [...artifacts.evidence.values()].find((receipt: any) => receipt.kind === 'runtime' && receipt.attemptId === finding.verifier.attemptId && receipt.metadata?.terminationConfirmed === true);
      expect(terminated, 'verifier replay termination receipt').toBeTruthy();
      expect(artifacts.attempts.get(finding.verifier.attemptId)!.lifecycleState).toBe('exited');
      const handle = JSON.parse(await readFile(join(artifacts.runDir, 'control/handles', `${finding.verifier.attemptId}.json`), 'utf8'));
      expect(handle.sessionRelease?.verified).toBe(true);
      expect(status.process.tasks.map((task: any) => task.taskId).sort()).toEqual([admission.verifierTaskId, 'assessment'].sort());
      expect(status.process.attempts.every((attempt: any) => ['exited', 'failed', 'timed-out', 'cancelled'].includes(attempt.lifecycleState))).toBe(true);

      // The bounded requests the replay may issue are exactly the owner-approved ones, in order, after the
      // verifier's own baseline observation: producer checks + verifier baseline + replay baseline/control/probe.
      const urls = fixture.requests.filter(request => request.url.startsWith('/lab/item')).map(request => request.url);
      expect(urls).toHaveLength(7);
      expect(new Set(urls).size).toBe(3);
      const checkPath = (kind: string) => { const parsed = new URL(artifacts.config.checks.find((check: any) => check.kind === kind).input.url); return `${parsed.pathname}${parsed.search}`; };
      expect(urls.slice(-3)).toEqual([checkPath('observation'), checkPath('negative-control'), checkPath('reproduction')]);
      expect(urls[urls.length - 4]).toBe(checkPath('observation'));
      expect(report.runState).toBe('completed');
    } finally {
      await support.close();
      await fixture.close();
    }
  }, 240000);

  it('rejects the claim when the fresh verifier replay cannot reproduce the differential', async () => {
    // The fixture latches its guard after serving the vulnerable read once: the producing attempt observes the
    // differential, the independent replay does not. Promotion must fail and nothing may be reported as validated.
    const fixture = await startLabFixture({ latchAfterViolation: true });
    const { support, planned, status } = await runAgainst(fixture);
    try {
      expect(status.run.state).toBe('completed');
      const artifacts = await readRunArtifacts(support, planned.runId);
      expect(artifacts.admission?.phase).toBe('admitted');
      const report = await support.report(planned.runId, 'json');
      // The report shows the rejected finding with its verifier attribution: the claim is not promoted, and the
      // replay receipts that rejected it stay visible instead of being hidden or crashing the report build.
      expect(report.findings).toHaveLength(1);
      const finding = report.findings[0];
      expect(finding.state).toBe('rejected');
      expect(finding.verifier.identity).not.toBe(finding.producerId);
      expect(finding.verifier.evidenceIds.some((id: string) => id.endsWith('.negative-control'))).toBe(true);
      expect(JSON.stringify(report)).not.toContain('independently-validated');
      // The verifier's own replay receipts remain visible and honest: the reproduction did not reproduce.
      expect(report.evidence.some((entry: any) => entry.collectorRole === 'verifier' && entry.test?.purpose === 'reproduction' && entry.test?.outcome === 'failed')).toBe(true);
      expect(report.evidence.some((entry: any) => entry.collectorRole === 'verifier' && entry.test?.purpose === 'negative-control' && entry.test?.outcome === 'passed')).toBe(true);
      // The verifier still ran under the protected pool and its session was still closed with a receipt.
      expect(report.modelBudget.phases.verifier.committed.tokens).toBeGreaterThan(0);
      const terminated = [...artifacts.evidence.values()].find((receipt: any) => receipt.kind === 'runtime' && receipt.attemptId === finding.verifier.attemptId && receipt.metadata?.terminationConfirmed === true);
      expect(terminated, 'verifier replay termination receipt').toBeTruthy();
    } finally {
      await support.close();
      await fixture.close();
    }
  }, 240000);

  it('admits no verifier identity and promotes nothing when the admitted packet has no passing per-claim receipt', async () => {
    // The tenant guard is enforced from the first request, so the owner-approved reproduction check fails. The
    // producer may still publish its packet, but the receipt-backed candidate gate must refuse: no verifier
    // attempt is admitted, no finding exists and the protected verifier reserve stays unspent.
    const fixture = await startLabFixture({ enforceTenantBoundary: true });
    const { support, planned, status } = await runAgainst(fixture);
    try {
      expect(status.run.state).toBe('completed');
      const artifacts = await readRunArtifacts(support, planned.runId);
      expect(status.process.tasks.map((task: any) => task.taskId)).toEqual(['assessment']);
      expect(artifacts.tasks.has(artifacts.admission?.verifierTaskId ?? 'verify-unused')).toBe(false);
      if (artifacts.admission) {
        expect(artifacts.admission.phase).toBe('candidate-refused');
        expect(String(artifacts.admission.reason)).toMatch(/negative control|reproduction/);
      }
      const report = await support.report(planned.runId, 'json');
      expect(report.findings).toEqual([]);
      expect(report.modelBudget.phases.verifier.committed.tokens).toBe(0);
      expect(report.modelBudget.phases.verifier.remaining.tokens).toBe(40960);
      expect(artifacts.events.some(entry => entry.type === 'orchestrator.attempt-launched' && entry.taskId === artifacts.admission?.verifierTaskId)).toBe(false);
    } finally {
      await support.close();
      await fixture.close();
    }
  }, 240000);

  /** Run the real source flow against a local directory and return the settled status plus both renderings. */
  async function runSourceDirectory(fileName: string, contents: string) {
    const fixture = await startLabFixture();
    const support = await harness();
    const sourceDir = join(support.root, 'controlled-source');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, fileName), contents);
    try {
      const result = await support.command(`--target ${sourceDir}`);
      expect(support.notifications.filter(notification => notification.type === 'error')).toEqual([]);
      const status = await support.waitForRun(result.runId);
      expect(status.run.state).toBe('completed');
      // A source run authors no execution recipe: no verifier task is admitted.
      expect(status.process.tasks.map((task: any) => task.taskId)).toEqual(['assessment']);
      const report = await support.report(result.runId, 'json');
      const markdown = await support.report(result.runId, 'markdown');
      return { support, status, report, markdown };
    } finally {
      await support.close();
      await fixture.close();
    }
  }

  it('keeps a source-only run free of findings: observations stay static with no converted question claim', async () => {
    const { report, markdown } = await runSourceDirectory('index.ts', 'export const approvedCanary = "APPROVED_FIRST_USE_VERIFY_CANARY";\n');
    // A lexical source scan is an observation, not a demonstrated issue: nothing is promoted, not even a
    // static finding whose claim is only the task question.
    expect(report.findings).toEqual([]);
    expect(report.returned.filter((entry: any) => entry.category === 'finding')).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('supported-static');
    expect(JSON.stringify(report)).not.toContain('independently-validated');
    // The source observation itself stays visible and statically classified, with no exploitability claim.
    const sourceReceipt = report.evidence.find((entry: any) => entry.kind === 'source');
    expect(sourceReceipt.classification).toBe('static-inference');
    expect(report.packets).toHaveLength(1);
    expect(report.packets[0].outcome).toBe('static-only');
    expect(report.packets[0].classification).toBe('static-inference');
    expect(markdown).toContain('No accepted findings. This is not evidence of absence.');
    expect(markdown).not.toContain('independently-validated');
  }, 240000);

  it('adds no finding for benign source code with no demonstrated issue', async () => {
    const { report, markdown } = await runSourceDirectory('greeting.js', 'export function hello(name) { return `hello ${name}`; }\n');
    expect(report.findings).toEqual([]);
    expect(report.packets[0].outcome).toBe('static-only');
    expect(markdown).toContain('No accepted findings. This is not evidence of absence.');
    // Coverage remains explicitly untested rather than being dressed up as tested coverage.
    expect(report.coverage.records.some((record: any) => record.state === 'untested')).toBe(true);
    expect(report.coverage.records.every((record: any) => !['tested', 'ruled-out'].includes(record.state))).toBe(true);
  }, 240000);

  it('synthesizes no verification program and admits no verifier when the owner-approved plan has no distinguishable differential', async () => {
    const fixture = await startLabFixture();
    const { support, planned, status } = await runAgainst(fixture, { plan: 'benign' });
    try {
      expect(status.run.state).toBe('completed');
      expect(status.process.tasks.map((task: any) => task.taskId)).toEqual(['assessment']);
      const report = await support.report(planned.runId, 'json');
      expect(report.findings).toEqual([]);
      // A benign single read is never promoted into a finding and no verifier was admitted.
      expect(fixture.requests).toHaveLength(1);
      const runDirs = await readdir(join(support.root, 'runs'));
      const control = JSON.parse(await readFile(join(support.root, 'runs', runDirs[0]!, 'control/verification-synthesis.json'), 'utf8'));
      expect(control.supported).toBe(false);
      expect(control.phase).toBe('no-supported-verification-program');
      expect(control.reason).toContain('negative-control');
    } finally {
      await support.close();
      await fixture.close();
    }
  }, 240000);
});
