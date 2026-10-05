import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { canonicalJson, digestJson, type PlanProposal, type RunManifest, type Scope, type TaskManifest } from '../contracts/index.js';
import type { PlanRequestEnvelope } from '../contracts/plan-request.js';
import type { BackendFactoryContext, ControlBackend } from '../interface/types.js';
import type { EntryPreparation, EntryRun, EntryRunSummary, TargetEntryPort } from '../interface/target-entry.js';
import { configurationDigest, consentCovers, defaultOwnerStorageRoot, inspectBundledRuntime, onboardingScopeFor, readOwnerConsent, type BundledRuntimePlan, type OnboardingReady } from './onboarding/index.js';
import { createApplication, ownerGrantFor, validateApplicationConfig, type ApplicationConfigWithSpend } from './composition.js';
import type { AssessmentApplication, ObservationCheck } from './types.js';
import { createTargetEntryPort } from './entry/port.js';
import { createOwnerApprovalPort, createOwnerDirectoryAuthority, ownerDocumentPathFor } from './entry/approvals.js';
import { createGeneratedRequestExecution, createOwnerMenuExecution } from './entry/executions.js';
import { createPlanLedger, createRequestPlanLedger } from './planner.js';
import type { EntryAcquisition, EntryPlanExecutionCompleteInput, EntryRunBinding, EntryOwnerSelection } from './entry/types.js';
import type { HostAssessmentSetup, HostPiPlanAuthor } from './entry/pi-author.js';
import { EntryError } from './entry/errors.js';
import { ensureOwnerRunManifest } from './entry/documents.js';
import { acquireApprovedSource, bindApprovedSourceContainer, type ApprovedSourceContainerBinding, type QualifiedSourceContainerSettings } from './source-binding/index.js';
import { fingerprintTree } from './entry/snapshot.js';
import { ENTRY_BOUNDS_DEFAULTS } from './entry/types.js';
/** Ceiling on model-authored concrete drafts one owner-approved envelope may admit (matches the ledger cap). */
const MAX_GENERATED_REQUEST_DRAFTS = 16;
import { createContainerSandbox } from '../tools/container.js';
import { createControllerContainerOwner, type ControllerContainerOwner } from './container-owner.js';
import { DurableStore } from '../store/store.js';
import { TargetBudget } from '../policy/budget.js';
import { defaultAutonomousBudget, durableAutonomousPool } from './autonomous-budget.js';
import { deriveFirstUseVerificationPlan, type FirstUseVerificationBudget } from './first-use-verification/index.js';
import { packConfigurationDigest } from './pack-readiness/index.js';
import { createControllerModelGateway, type ControllerModelGateway } from '../runtime/config.js';
import { persistControllerCheckpoint, type ControllerRestoreReady } from './checkpoint/index.js';
import { discoverInterruptedControllerRun, prepareInterruptedControllerRestore, readControllerOwnerFromDurableConsent, releaseStaleVaultWriter, type ControllerRunDiscovery } from './checkpoint/restore.js';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(code: string, message: string): never { throw new EntryError(code, message); }

/**
 * Resolve the bundled runtime or refuse with the named code. No path is joined ad hoc in this module: a missing
 * `dist/` runtime or worker binary must surface as BUNDLED_RUNTIME_MISSING before any run directory exists,
 * never as a raw ENOENT after the owner has already consented.
 */
function bundledRuntime(): BundledRuntimePlan {
  const inspected = inspectBundledRuntime();
  if (!inspected.ok) fail(inspected.code, inspected.message);
  return inspected.plan;
}
const iso = (n: number) => new Date(n).toISOString();
const taskId = 'assessment';
const targetId = 'owner-target';


function initialUrlCidrs(url: URL): string[] {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  // DNS is deliberately deferred until human plan approval. This documentation address is a
  // deny-by-default validation sentinel, never dispatched: prepareApplication replaces it first.
  return family ? [`${hostname}/${family === 6 ? 128 : 32}`] : ['192.0.2.0/32'];
}
/** Consent is re-read for every authority-sensitive operation. An author/worker never widens it. */
async function revalidateOwner(owner: OnboardingReady): Promise<void> {
  const saved = await readOwnerConsent(owner.configPath);
  if (configurationDigest(saved.configuration) !== configurationDigest(owner.configuration) ||
      !consentCovers(saved.configuration, owner.configuration.scope, owner.effectiveLimits, owner.effectivePermissions)) fail('OWNER_CONSENT_CHANGED', 'saved owner consent changed, expanded or expired; dispatch refused');
  if (owner.effectivePermissions.repositoryScripts || owner.effectivePermissions.stateChanges) fail('ENTRY_UNSUPPORTED_ACTION', 'repository scripts and state-changing actions are not qualified by the bundled read/static runtime; granting consent does not enable unsupported tools');
}

function containerSettings(root: string, owner: OnboardingReady, runtime: BundledRuntimePlan): QualifiedSourceContainerSettings {
  const lock = JSON.parse(readFileSync(runtime.containerLockPath, 'utf8'));
  if (lock.lockVersion !== 2 || lock.packVersion !== '1.0.0') fail('SANDBOX_NOT_QUALIFIED', 'bundled container lock is unavailable/unsupported; no pull/build/re-pin');
  return { enginePath: '/usr/bin/docker', engineVersion: lock.engineVersion, image: lock.image.pin,
    imageRootfsLayers: lock.image.rootfsLayers, baseImageId: lock.base.localBaseImageId,
    workerSha256: lock.sources.workerSha256, sourceSha256: lock.sources.sourceSha256,
    seccompPath: runtime.seccompPath, seccompSha256: lock.sources.seccompSha256,
    qualification: { acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation', dedicatedLab: true,
      approvedBy: `human-ui:${owner.configuration.owner.uid}`, expiresAt: iso(owner.effectiveLimits.deadlineMs), nativeEnabled: false },
    maxFileBytes: 1024 * 1024, maxArtifactBytes: 4 * 1024 * 1024,
    // Root is included in the controller's qualification receipt, not an executable/model-selected path.
    maxArtifacts: root ? 128 : 128 };
}

function synthesize(owner: OnboardingReady, setup: HostAssessmentSetup, root: string, qualified: QualifiedSourceContainerSettings, controller: ControllerContainerOwner, runtime: BundledRuntimePlan): ApplicationConfigWithSpend {
  const limits = owner.effectiveLimits, scope = owner.configuration.scope, source = scope.target.kind !== 'http-url';
  const runId = controller.binding.scope.runId;
  const control = join(root, 'control'), workspace = join(root, 'workspaces'), input = join(root, 'consent-inputs'), output = join(root, 'outputs');
  for (const p of [root, control, workspace, input, output]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const consent = canonicalJson({ configuration: owner.configuration, effectiveLimits: limits, effectivePermissions: owner.effectivePermissions });
  writeFileSync(join(input, 'owner-consent.json'), consent, { mode: 0o400, flag: 'wx' });
  const configuration = createContainerSandbox({ ...qualified, inputRoot: input, outputRoot: output, trustedInputSnapshot: true, controllerLifecycle: controller.binding });
  const action = source ? 'analyze' : 'read', capability = source ? 'source.analyze' : 'http.request';
  // All phases are capped independently by the shared pool; run-level consent is not a second allocation.
  const remainingTokens = limits.maxTokens;
  const remainingCost = limits.maxCostUsd;
  const now = Date.now(), deadlineAt = iso(limits.deadlineMs), reserveMs = Math.min(30_000, Math.floor((limits.deadlineMs - now) / 10));
  const run: RunManifest = { schemaVersion: 1, runId, createdAt: iso(now), state: 'created',
    authorization: { reference: owner.configuration.authorization.reference, authorizedBy: `human-ui-uid:${owner.configuration.owner.uid}`,
      validFrom: iso(now - 1000), expiresAt: deadlineAt, targets: [{ id: targetId, kind: source ? 'lab' : 'web', locator: scope.target.locator }], exclusions: [], allowedActions: ['read', 'analyze'] },
    budgets: { deadlineAt, maxRequests: limits.maxRequests, maxBytes: 64 * 1024 * 1024, maxToolCalls: limits.maxToolCalls,
      maxTokens: remainingTokens, maxCostUsd: remainingCost, ...(limits.modelAccounting ? { modelAccounting: limits.modelAccounting } : {}), maxAttempts: limits.maxAttempts, maxTasks: source ? 1 : 2, maxDepth: source ? 0 : 1,
      // The owner's concurrency is a ceiling, and the manifest may not declare more concurrent work than it has
      // tasks; a run with one planned task therefore runs one worker even when the owner allows more.
      maxConcurrency: Math.min(limits.concurrency, source ? 1 : 2), reportReserveMs: reserveMs, targetRequestLimits: { [targetId]: limits.maxRequests } },
    requestedRuntime: { adapter: 'headless', selection: { ...setup.selection }, requiredCapabilities: ['ownsLifecycle', 'canHardStop', 'attestsRuntime'] }, allowedCapabilities: [capability] };
  // The declared per-target concurrency can never exceed the run's own admitted concurrency.
  const runConcurrency = run.budgets.maxConcurrency;
  const inputDigest = sha(consent);
  const taskScope: Scope = { authorizationRef: run.authorization.reference, targetIds: [targetId], actor: { id: 'anonymous', privileges: [action] },
    boundary: `${scope.boundary}; owner self-attestation is not independently verified legal authorization`, isolation: 'pinned dedicated-lab container; shares host kernel, not hostile-code isolation',
    recovery: 'verified owned runtime/container release; immutable source revalidation; new attempt sessions on resume', environmentId: `consent-${inputDigest.slice(0, 24)}`,
    configurationDigest: configuration.configurationDigest, inputs: [{ id: 'owner-consent', digest: inputDigest, locator: join(input, 'owner-consent.json'), revision: inputDigest }] };
  const manifest: TaskManifest = { schemaVersion: 1, runId, taskId, createdAt: iso(now), depth: 0, dependencyTaskIds: [], inputRevision: inputDigest,
    question: { text: `What bounded ${source ? 'static source' : 'read-only HTTP'} observations are supported within the exact approved target?`, ifTrue: 'Authenticated observations support a bounded account of the assessed surface, with limitations.', ifFalse: 'Evidence is insufficient; identify failures and untested scope without claiming vulnerability verification.' },
    scope: taskScope, skills: [source ? 'source-code-auditing' : 'attack-surface-mapping'], allowedActions: [action], requiredCapabilities: [capability],
    budgets: { deadlineAt: iso(limits.deadlineMs - reserveMs), maxRequests: limits.maxRequests, maxBytes: run.budgets.maxBytes, maxToolCalls: limits.maxToolCalls, maxTokens: remainingTokens, maxCostUsd: remainingCost, ...(limits.modelAccounting ? { modelAccounting: limits.modelAccounting } : {}), maxAttempts: limits.maxAttempts }, requestedRuntime: { ...run.requestedRuntime }, workspace: join(workspace, taskId), lifecycleState: 'queued', packetState: 'draft' };
  const extension = runtime.bridgeExtensionPath;
  const toolPolicy = { mode: 'sandbox-extension' as const, extension: { path: extension, sha256: sha(readFileSync(extension)), approval: 'bundled pinned bridge; no built-in host tools' }, boundaryId: 'p2o-first-use-read-static', tools: ['p2o_context', 'p2o_broker', 'p2o_packet'] };
  const parsedUrl = source ? undefined : new URL(scope.target.locator);
  // Unix sockets have a ~108-byte kernel limit; never derive the socket from long owner/run paths.
  const bridgeDirectory = mkdtempSync(join(tmpdir(), 'p2o-b-'));
  return validateApplicationConfig({ schemaVersion: 1, mode: 'authorized-assessment', roots: { state: join(root, 'state.sqlite'), control, workspace, vault: join(root, 'vault'), artifacts: { controller: join(control, 'artifacts'), broker: output }, workerWriteRoots: [workspace] },
    run, tasks: [{ manifest, role: 'worker', toolPolicy, boundaryReceipt: taskScope.isolation }],
    runtime: { adapter: 'headless', selection: { ...setup.selection }, piBinary: runtime.piBinary, piVersion: '1.0.0', gateway: { approval: setup.upstream.approval, baseUrl: 'http://127.0.0.1:1', api: setup.upstream.api, models: setup.upstream.models } },
    sandbox: { mode: 'container', options: { ...qualified, inputRoot: input, outputRoot: output, trustedInputSnapshot: true } },
    policy: { version: 1, runId, authorization: { reference: run.authorization.reference, approvedBy: run.authorization.authorizedBy, expiresAt: deadlineAt },
      targets: parsedUrl ? [{ id: targetId, origins: [parsedUrl.origin], pathPrefixes: [parsedUrl.pathname], allowedCidrs: initialUrlCidrs(parsedUrl), methods: ['GET', 'HEAD'], actions: ['read'], accounts: ['anonymous'], limits: { maxRequests: limits.maxRequests, maxBytes: run.budgets.maxBytes, maxConcurrent: limits.concurrency, rate: { requests: Math.max(1, Math.min(8, limits.maxRequests)), windowMs: 1000 } } }] : [],
      exclusions: [], accounts: source ? [] : [{ id: 'anonymous', kind: 'anonymous', targetIds: [targetId], actions: [action], expiresAt: deadlineAt }],
      grantTemplates: [{ id: 'first-use-grant', taskId, role: 'worker', capabilities: [capability], targetIds: source ? [] : [targetId], actions: [action], accountIds: source ? [] : ['anonymous'], expiresAt: deadlineAt, maxCalls: limits.maxToolCalls, maxArtifactBytes: run.budgets.maxBytes }] },
    bridge: { socketPath: join(bridgeDirectory, 'bridge.sock'), controllerArtifactRootId: 'controller', brokerArtifactRootId: 'broker', inertLocalOnly: false },
    interface: { perTargetConcurrency: { [targetId]: runConcurrency } }, ...(remainingTokens === null ? {} : { spend: { maxOutputTokens: Math.min(4096, remainingTokens) } }),
    // Source-only runs synthesize no finding: a lexical source scan is an observation, not a demonstrated issue.
    // The source receipts and the untested coverage cell stay visible with static-inference classification.
    reporting: { coverage: [{ taskId, surfaceId: targetId, actorId: 'anonymous', question: manifest.question.text, state: 'untested', basis: 'worker-asserted', reason: 'Coverage remains bounded to accepted evidence; findings are limited to owner-approved checks with an independent verifier outcome, with unsupported claims left unresolved.' }] } } satisfies ApplicationConfigWithSpend);
}

interface FirstUseFlow {
  owner: OnboardingReady; setup: HostAssessmentSetup; author: HostPiPlanAuthor; config: ApplicationConfigWithSpend; port: TargetEntryPort;
  application?: AssessmentApplication; source?: ApprovedSourceContainerBinding; controller?: ControllerContainerOwner; persist(): void;
  budgetStore: DurableStore; budgetPlan: Extract<import("../policy/budget.js").AutonomousModelBudgetPlan, { outcome: "ready" | "accounting-only" }>; pool: ReturnType<typeof durableAutonomousPool>; planningGateway?: ControllerModelGateway;
  checkpointRequest?: import("./source-binding/identity.js").ApprovedSourceRequest; saveCheckpoint?: () => Promise<void>;
  /** Restart wiring: the held controller claim, the restored-run resume seam and a bounded run summary. */
  restore?: { ticket: { close(): Promise<void> }; resume(): Promise<EntryRun>; summary: EntryRunSummary };
}

/** Built-in default backend is lazy: status/tool-first cannot capture a missing consent/model slot forever. */
export function createFirstUseBackend(context: BackendFactoryContext): ControlBackend {
  const flows = new Map<string, FirstUseFlow>();
  const plans = new Map<string, FirstUseFlow>();
  let latest: FirstUseFlow | undefined;
  let closed = false;
  const ownerNow = () => context.onboardingSlot?.current ?? context.onboarding;
  const authorNow = () => context.planAuthorSlot?.current ?? context.planAuthor;
  const active = (runId: string) => { const flow = flows.get(runId); if (!flow?.application) fail('ENTRY_RUN_UNKNOWN', 'no admitted bundled run with this identity; no fake backend/report'); return flow.application.interfaceBackend; };

  const newFlow = async (): Promise<FirstUseFlow> => {
    if (closed) fail('ENTRY_CLOSED', 'backend is closed');
    const owner = ownerNow();
    if (!owner) fail('OWNER_ONBOARDING_REQUIRED', 'run /p2o --target to create human scope consent before preparation');
    await revalidateOwner(owner);
    const author = authorNow() as HostPiPlanAuthor | undefined;
    if (!author?.configure || !author.confirmSource || !author.confirmContainer) fail('ENTRY_PLAN_AUTHOR_REQUIRED', 'bundled first use needs the checked host Pi model selection, pricing and source UI bridge; a string-only custom author cannot grant these boundaries');
    const setup = await author.configure(owner);
    if (setup.qualificationHarness && (setup.qualificationHarness.kind !== 'model-inert-controlled-targets-not-live' || setup.selection.provider !== 'inert-fixture' || new URL(setup.upstream.upstreamBaseUrl).hostname !== '127.0.0.1')) fail('QUALIFICATION_MODE_DENIED', 'controlled transport is only legal for an explicit inert loopback qualification; never live/production');
    // The bundled runtime is resolved (worker binary, dist guardian/receipts, pinned lock/seccomp/bridge)
    // before any run directory or consent-adjacent artifact is created, so a broken install refuses here.
    const runtime = bundledRuntime();
    const root = join(resolve(dirname(owner.configPath), '..'), 'runs', `assessment-${randomUUID()}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const selected = setup.upstream.models.find(model => model.id === setup.selection.model);
    if (!selected?.maxTokens || !selected.contextWindow) fail("MODEL_LIMITS_REQUIRED", "Selected model needs explicit output/context limits; no fallback");
    const budgetPlan = defaultAutonomousBudget(owner.effectiveLimits, setup.selection, selected.maxTokens);
    writeFileSync(join(root, "autonomous-budget.json"), canonicalJson(budgetPlan), { mode: 0o600, flag: "wx" });
    if (budgetPlan.outcome === "partial") {
      const report = { outcome: "partial", reason: budgetPlan.reason, extensionRequired: true, launchAllowed: false, budget: budgetPlan, findings: [], coverage: [{ target: owner.configuration.scope.target.locator, state: "untested", reason: "Budget admission refused before planning/launch" }] };
      writeFileSync(join(root, "partial-report.json"), canonicalJson(report), { mode: 0o600, flag: "wx" });
      fail("BUDGET_EXTENSION_REQUIRED", `Partial: no planning or launch. Required ${budgetPlan.required.maxTokens} tokens / $${budgetPlan.required.maxCostUsd}. Explicit owner extension required; no automatic increase. Report: ${join(root, "partial-report.json")}`);
    }
    if (!setup.bindPlannerBudget) fail("MODEL_PLAN_GATEWAY_REQUIRED", "Author cannot bind durable phase/gateway admission; no paid fallback");
    if (budgetPlan.outcome === 'ready') Object.assign(setup.planningLimits, budgetPlan.phases.planner.limits);
    const qualified = containerSettings(root, owner, runtime);
    await author.confirmContainer(qualified.image, qualified.qualification.expiresAt);
    mkdirSync(join(root, 'control'), { recursive: true, mode: 0o700 });
    const controller = await createControllerContainerOwner(join(root, 'control'), `run-${randomUUID()}`, qualified);
    const config = synthesize(owner, setup, root, qualified, controller, runtime);
    const budgetStore = new DurableStore({ path: config.roots.state });
    const pool = durableAutonomousPool(budgetStore, config.run.runId, budgetPlan);
    const preflightJournal = budgetStore.autonomousPreflightJournal(config.run.runId);
    const preflightBudgets = new TargetBudget([], { runId: config.run.runId, journal: preflightJournal, freshRun: preflightJournal.load(config.run.runId) === undefined });
    let packGrant: import("./pack-readiness/index.js").PackGrantMaterial | undefined;
    try {
    if (owner.configuration.scope.target.kind !== "http-url") {
      if (!author.preparePacks) fail("PACK_CONSENT_REQUIRED", "Author lacks human pack consent/readiness bridge; no implicit static qualification");
      packGrant = await author.preparePacks(owner, { kind: "container", settings: { ...qualified, inputRoot: (config.sandbox as { options: { inputRoot: string } }).options.inputRoot, outputRoot: config.roots.artifacts.broker!, trustedInputSnapshot: true } }, controller.binding, preflightBudgets);
      if (!packGrant.capabilities.includes("source.analyze") || !packGrant.actions.includes("analyze")) fail("PACK_GRANT_REQUIRED", "Static source capability was not consented/qualified");
      const grant = config.policy.grantTemplates[0]!;
      grant.maxCalls = Math.min(grant.maxCalls, packGrant.maxCalls);
      grant.maxArtifactBytes = Math.min(grant.maxArtifactBytes, config.run.budgets.maxBytes);
      writeFileSync(join(config.roots.control, "pack-grant.json"), canonicalJson(packGrant), { mode: 0o600, flag: "wx" });
    }
    } catch (error) { await controller.close(); budgetStore.close(); throw error; }
    const planningGateway = createControllerModelGateway({ ...setup.upstream, requireSpendGate: true });
    const plannerAttemptId = `planner-${randomUUID()}`;
    budgetStore.registerControllerPhaseAttempt(config.run.runId, "planner", plannerAttemptId);
    try {
      await planningGateway.listen();
      setup.bindPlannerBudget({ ledger: pool.planner, ...(budgetPlan.outcome === 'ready' ? { allocation: budgetPlan.phases.planner } : {}), gateway: planningGateway, attemptId: plannerAttemptId });
    } catch (error) { await planningGateway.close(); await controller.close(); budgetStore.close(); throw error; }
    const manifestPath = join(config.roots.control, 'run-manifest.json');
    ensureOwnerRunManifest({ path: manifestPath, run: config.run, derived: true });
    const approvalDirectory = join(config.roots.control, 'approvals');
    const authority = createOwnerDirectoryAuthority({ grant: ownerGrantFor(config), directory: approvalDirectory });
    const ledger = createPlanLedger({ controlRoot: config.roots.control, authority });
    const requestLedger = createRequestPlanLedger({ controlRoot: config.roots.control, authority });
    const sourceKind = owner.configuration.scope.target.kind !== 'http-url';
    // The envelope grants read-only http.request on the single approved target; the grant count only bounds how many
    // concrete drafts the model may put in front of the human for exact approval (the ledger caps the request sum too).
    const draftGrants = Array.from({ length: Math.min(MAX_GENERATED_REQUEST_DRAFTS, owner.effectiveLimits.maxRequests) }, () => ({ taskId, targetIds: [targetId], allowedActions: ['read'], allowedCapabilities: ['http.request'] }));
    const envelope: PlanRequestEnvelope = { targets: config.run.authorization.targets.map(target => ({ id: target.id, kind: target.kind, locator: target.locator })), taskGrants: draftGrants, accounts: ['anonymous'], accountGrants: [{ accountId: 'anonymous', targetIds: [targetId], actions: ['read'] }], allowedActions: ['read'], allowedCapabilities: ['http.request'], exclusions: [] };
    const binding: EntryRunBinding = { backend, manifestPath, mode: 'assessment', run: config.run, selection: setup.selection, approvedTargets: [{ targetId, kind: sourceKind ? 'artifact' : 'web', locator: owner.configuration.scope.target.locator, actions: ['read', 'analyze'], accounts: ['anonymous'] }],
      ownerObservations: sourceKind ? [{ taskId, observationId: 'static-source-inventory', tool: 'source.analyze', targetIds: [targetId], capabilities: ['source.analyze'], actions: ['analyze'], summary: 'Enumerate the approved immutable filtered tree, select at most 64 bounded UTF-8 files, and perform lexical static analysis. No execution or assumed finding.' }] : [], ...(!sourceKind ? { requestEnvelope: envelope } : {}) };
    let flow: FirstUseFlow;
    let execution: ReturnType<typeof createOwnerMenuExecution>;
    let executionInput: EntryPlanExecutionCompleteInput | undefined;
    const authorize = async () => { await revalidateOwner(owner); if (!executionInput) fail('ENTRY_HUMAN_APPROVAL_REQUIRED', 'no sealed owner-gated execution input'); await execution.authorize!(executionInput); };
    const prepareApplication = async (input: { preparation: EntryPreparation; plan: EntryPlanExecutionCompleteInput['plan']; approval: EntryPlanExecutionCompleteInput['approval']; acquisition?: EntryAcquisition }, checks: readonly ObservationCheck[]) => {
      await revalidateOwner(owner);
      if (flow.application) fail('ALREADY_APPROVED', 'one immutable plan per bundled run');
      const acquisition = input.acquisition;
      let finalChecks = [...checks];
      /** Owner-authorized deferred verifier scheduling, present only for a supported owner-approved differential. */
      let verificationScheduleForApplication: NonNullable<import('./composition.js').ApplicationOverrides['verificationSchedule']> | undefined;
      if (sourceKind) {
        if (!acquisition) fail('ENTRY_SOURCE_UNBOUND', 'source acquisition is missing');
        await author.confirmSource(acquisition, input.plan.digest);
        await authorize();
        const sourceRun = structuredClone(config.run);
        sourceRun.authorization.targets[0]!.digest = acquisition.digest;
        sourceRun.authorization.targets[0]!.kind = 'artifact';
        sourceRun.authorization.targets[0]!.revision = acquisition.revision ?? acquisition.digest;
        if (acquisition.revision) sourceRun.authorization.targets[0]!.revision = acquisition.revision;
        const request = { run: sourceRun, preparation: input.preparation, plan: input.plan, approval: input.approval };
        const source = await acquireApprovedSource({ request, authorize, acquisition, privateRoot: join(config.roots.control, 'immutable-source') });
        const bound = await bindApprovedSourceContainer({ request, authorize, source, qualified: { ...qualified, controllerLifecycle: flow.controller!.binding }, outputRoot: config.roots.artifacts.broker });
        flow.controller!.attach(bound.sandbox);
        // Source admission changes the mounted-input configuration. Re-consent/check that exact
        // boundary; the earlier metadata-only doctor receipt is not a grant for another mount.
        packGrant = await author.preparePacks!(owner, { kind: "container", settings: { ...qualified, inputRoot: bound.inputRoot, outputRoot: bound.outputRoot, trustedInputSnapshot: true } }, flow.controller!.binding, preflightBudgets);
        if (!packGrant.capabilities.includes("source.analyze") || !packGrant.actions.includes("analyze")) fail("PACK_GRANT_REQUIRED", "Approved source static pack was not consented/qualified");
        writeFileSync(join(config.roots.control, "pack-grant.json"), canonicalJson(packGrant), { mode: 0o600 });
        flow.source = bound;
        flow.checkpointRequest = request;
        flow.saveCheckpoint = async () => {
          if (!flow.application || !flow.source || !flow.checkpointRequest || flow.application.store.getRun(config.run.runId)?.state !== "active") return;
          try { await persistControllerCheckpoint({ root: join(dirname(root), "..", "checkpoints", config.run.runId), forbiddenRoots: [config.roots.workspace, config.roots.artifacts.broker!, bound.inputRoot, ...(acquisition.kind === "local-dir" ? [acquisition.locator] : [])], store: flow.application.store, request: flow.checkpointRequest, source: flow.source.source, ownerConfigPath: owner.configPath, authorize }); }
          catch (error) {
            // Completion may race the filesystem validation awaits. A terminal run needs no resumable checkpoint.
            if ((error as { code?: string }).code === "CHECKPOINT_TERMINAL" && flow.application.store.getRun(config.run.runId)?.state !== "active") return;
            throw error;
          }
        };
        const fingerprints = bound.fingerprints;
        const scope = config.tasks[0]!.manifest.scope;
        Object.assign(scope, { environmentId: fingerprints.environmentId, configurationDigest: fingerprints.configurationDigest, inputs: [...fingerprints.inputs] });
        config.tasks[0]!.manifest.inputRevision = fingerprints.inputRevision;
        const walked = await fingerprintTree({ root: bound.inputRoot, bounds: { ...ENTRY_BOUNDS_DEFAULTS, maxSamplePaths: 64 } });
        const paths = walked.samplePaths;
        if (!paths.length) fail('ENTRY_SOURCE_UNBOUND', 'filtered source has no bounded readable files');
        finalChecks = [{ checkId: 'static-source-inventory', taskId, observationId: 'static-source-inventory', tool: 'source.analyze', input: { paths }, kind: 'source', classification: 'static-inference', summary: 'Bounded lexical analysis of exact approved mounted files; not exploit reproduction', claim: config.tasks[0]!.manifest.question.text, surfaceId: targetId, actorId: 'anonymous' }];
        config.sandbox = { mode: 'container', options: { ...qualified, inputRoot: bound.inputRoot, outputRoot: bound.outputRoot, trustedInputSnapshot: true, approvedSource: { identityDigest: source.identityDigest, snapshot: source.seal } } };
        writeFileSync(join(config.roots.control, 'source-approval.json'), canonicalJson({ source: source.identity, planDigest: input.plan.digest, approvalRef: input.approval.approvalRef, sourceUIConfirmed: true, fingerprints }), { mode: 0o600, flag: 'wx' });
      } else {
        const approvedTarget = new URL(owner.configuration.scope.target.locator);
        const approvedBase = approvedTarget.pathname.replace(/\/+$/u, '');
        for (const check of checks) {
          const draft = check.input as { url?: string; method?: string; action?: string; accountId?: string };
          if (check.tool !== 'http.request') fail('ENTRY_PLAN_REJECTED', 'the exact approved target plan may only contain read-only http.request observations');
          if (!['GET', 'HEAD'].includes(draft.method ?? 'GET') || (draft.action ?? 'read') !== 'read') fail('ENTRY_PLAN_REJECTED', 'generated request requests a mutating method or a non-read action; review expanded scope/actions first');
          if (draft.accountId !== undefined && draft.accountId !== 'anonymous') fail('ENTRY_PLAN_REJECTED', 'generated request names an account outside the owner-approved anonymous read grant');
          const candidate = (() => { try { return new URL(draft.url ?? ''); } catch { return undefined; } })();
          const insidePrefix = candidate !== undefined && (approvedBase === '' || candidate.pathname === approvedBase || candidate.pathname.startsWith(`${approvedBase}/`));
          if (!candidate || candidate.origin !== approvedTarget.origin || !insidePrefix || candidate.username || candidate.password || candidate.hash) {
            fail('ENTRY_PLAN_REJECTED', 'generated request leaves the exact owner-approved target origin/path prefix; re-run with a plan for the approved target');
          }
        }
        await authorize();
        const url = new URL(owner.configuration.scope.target.locator);
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.length > 16) fail('TARGET_ADDRESS_UNBOUND', 'approved hostname needs a bounded nonempty address set after exact plan approval');
        config.policy.targets[0]!.allowedCidrs = [...new Set(addresses.map(({ address, family }) => `${address}/${family === 6 ? 128 : 32}`))];
        // The owner-approved read-only differential is a *program*, not a finding. The controller derives the
        // verifier task/plan identity from the approved checks alone and pre-authorizes it as a deferred task;
        // nothing is admitted, no finding plan exists and no claim is promoted before execution.
        const derivedAt = iso(Date.now());
        const verifierExtensionPath = runtime.bridgeExtensionPath;
        const verifierBudget: FirstUseVerificationBudget = {
          maxRequests: owner.effectiveLimits.maxRequests, maxToolCalls: owner.effectiveLimits.maxToolCalls,
          ...(budgetPlan.outcome === 'accounting-only' ? { modelAccounting: 'informational' as const, maxTokens: null, maxCostUsd: null } : { maxTokens: budgetPlan.phases.verifier.limits.maxTokens, maxCostUsd: budgetPlan.phases.verifier.limits.maxCostUsd }),
        };
        const planned = deriveFirstUseVerificationPlan({
          run: config.run, producerTask: config.tasks[0]!.manifest, targetId, targetLocator: owner.configuration.scope.target.locator,
          checks: finalChecks, workspaceRoot: config.roots.workspace, verifierBudget, now: derivedAt, verifierTaskCreatedAt: derivedAt,
        });
        if (planned.supported) {
          // The producer checks carry the controller-side test descriptor so their collector receipts are bound
          // to the exact owner-approved claim; inputs, URLs, accounts and expectations are unchanged.
          finalChecks = planned.draft.enrichedChecks;
          config.tasks.push({
            manifest: planned.draft.verifierTask, role: 'verifier', deferred: true,
            toolPolicy: { mode: 'sandbox-extension', boundaryId: 'p2o-first-use-verifier',
              extension: { path: verifierExtensionPath, sha256: sha(readFileSync(verifierExtensionPath)), approval: 'bundled pinned bridge; verifier-role read-only replay only' },
              tools: ['p2o_context', 'p2o_broker', 'p2o_verify', 'p2o_packet'] },
            boundaryReceipt: `${config.tasks[0]!.manifest.scope.isolation}; controller-derived narrowed verifier replay of one owner-approved differential`,
          });
          config.policy.grantTemplates.push({
            id: 'first-use-verifier-grant', taskId: planned.draft.verifierTask.taskId, role: 'verifier',
            capabilities: ['http.request'], targetIds: [targetId], actions: ['read'], accountIds: ['anonymous'],
            expiresAt: config.run.authorization.expiresAt, maxCalls: owner.effectiveLimits.maxToolCalls, maxArtifactBytes: config.run.budgets.maxBytes,
          });
          verificationScheduleForApplication = {
            producerTaskId: taskId, verifierTaskId: planned.draft.verifierTask.taskId, targetId,
            targetLocator: owner.configuration.scope.target.locator, budget: verifierBudget, derivedAt,
          };
        }
        writeFileSync(join(config.roots.control, 'verification-synthesis.json'), canonicalJson({
          supported: planned.supported,
          phase: planned.supported ? 'candidate-evidence-required' : 'no-supported-verification-program',
          reason: planned.supported
            ? 'Owner-approved differential program derived. The verifier task/grant are owner-authorized but are admitted only after the producer packet and its exact per-claim collector receipts pass controller validation; no finding or target reset is synthesized before execution.'
            : planned.reason,
          ...(planned.supported ? { verifierTaskId: planned.draft.verifierTask.taskId, findingId: planned.draft.finding.findingId, claimDigest: digestJson(planned.draft.finding.claim) } : {}),
          ...(budgetPlan.outcome === 'ready' ? { protectedReserve: budgetPlan.phases.verifier.limits, reportReserve: budgetPlan.phases.report.limits } : { modelAccounting: 'informational' }), derivedAt,
        }), { mode: 0o600 });
      }
      config.checks = finalChecks;
      flow.persist();
      // The verifier attempt is the only attempt resolved to the protected verifier phase ledger; every other
      // attempt keeps the workers phase. The reserve is never widened or borrowed here.
      const verifierTaskId = verificationScheduleForApplication?.verifierTaskId;
      flow.application = await createApplication(config, { upstream: setup.upstream, ...(flow.source ? { sourceBinding: flow.source } : {}), controllerContainerOwner: flow.controller,
        spend: budgetPlan.outcome === 'accounting-only' ? { phase: { limits: budgetPlan.ownerLimits, ledger: pool.workers, selection: setup.selection } } : { phase: { ...budgetPlan.phases.workers, ledger: pool.workers, prices: budgetPlan.prices },
          ...(verifierTaskId ? { byTask: (id: string) => id === verifierTaskId ? { ...budgetPlan.phases.verifier, ledger: pool.verifier, prices: budgetPlan.prices } : undefined } : {}) },
        ...(verificationScheduleForApplication ? { verificationSchedule: verificationScheduleForApplication } : {}),
        runtimePaths: { guardianPath: runtime.guardianPath, receiptExtensionPath: runtime.receiptExtensionPath } });
      return { taskIds: [taskId], observationIds: finalChecks.map(check => check.observationId) };
    };
    const sourceProposal = (selection: EntryOwnerSelection[], preparation: EntryPreparation): PlanProposal => {
      if (selection.length !== 1 || selection[0]?.taskId !== taskId || selection[0]?.observationId !== 'static-source-inventory') fail('ENTRY_PLAN_REJECTED', 'model selected an unavailable static observation');
      const task = config.tasks[0]!.manifest;
      const { reportReserveMs: _reserve, targetRequestLimits: _targets, ...planBudgets } = config.run.budgets;
      return { schemaVersion: 1, proposalId: `source-plan-${preparation.scopeDigest.slice(0, 24)}`,
        run: { runId: config.run.runId, purpose: 'Model-selected bounded read/static source inventory; no assumed vulnerabilities', inputRevision: task.inputRevision, scope: structuredClone(task.scope), targets: config.run.authorization.targets, accounts: ['anonymous'], allowedCapabilities: ['source.analyze'], allowedActions: ['analyze'], budgets: { ...planBudgets, deadlineAt: task.budgets.deadlineAt } },
        tasks: [{ taskId, question: task.question, surfaceId: targetId, surface: preparation.target.locator, actor: task.scope.actor, targetIds: [targetId], skills: task.skills, allowedActions: ['analyze'], requiredCapabilities: ['source.analyze'], dependencies: [], depth: 0, priority: 'normal' }],
        observations: [{ observationId: 'static-source-inventory', taskId, tool: 'source.analyze', input: { path: '.' }, requests: 1, kind: 'source', classification: 'static-inference', summary: binding.ownerObservations[0]!.summary }],
        coverage: [{ cellId: 'source-inventory', taskId, surfaceId: targetId, actorId: 'anonymous', question: task.question.text }], caps: { maxTasks: 1, maxDepth: 0, maxObservations: 1, maxRequests: 1 },
        provenance: { plannerAttemptId: 'host-plan-author', plannerKind: 'worker', requestedSelection: setup.selection, inputDigests: [preparation.scopeDigest], producedAt: iso(Date.now()) } };
    };
    const implementation = sourceKind ? createOwnerMenuExecution({ ledger, run: config.run, ownerDocumentPath: ownerDocumentPathFor(approvalDirectory, 'plan'), workspaceFor: () => config.tasks[0]!.manifest.workspace, selection: setup.selection, register: input => prepareApplication(input, input.materialized.checks) })
      : createGeneratedRequestExecution({ ledger: requestLedger, run: config.run, envelope, ownerDocumentPath: ownerDocumentPathFor(approvalDirectory, 'request'), selection: setup.selection, register: input => prepareApplication(input, input.materialized.checks) });
    execution = { ...implementation, async authorize(input) { executionInput = input; await revalidateOwner(owner); await implementation.authorize!(input); } };
    const port = createTargetEntryPort({ cwd: context.cwd, workspaceRoot: join(config.roots.control, 'entry'), binding,
      ...(setup.qualificationHarness?.sourceRunner ? { commandRunner: setup.qualificationHarness.sourceRunner } : {}),
      planAuthor: { async author(input, signal) { await revalidateOwner(owner); return author.author({ ...input, preparation: { ...input.preparation, spend: { ...input.preparation.spend, ...setup.planningLimits } } }, signal); } },
      approvals: createOwnerApprovalPort({ directory: approvalDirectory }), executions: { [implementation.kind]: execution },
      buildOwnerMenuProposal: async input => ({ proposal: sourceProposal(input.selection, input.preparation) }),
      delegation: {
        async preflight() {
          await revalidateOwner(owner);
          flow.controller ??= await createControllerContainerOwner(config.roots.control, config.run.runId, qualified);
          // Actual pinned image/engine checks, with a separate durable controller owner; never target I/O.
          const probe = createContainerSandbox({ ...qualified, inputRoot: (config.sandbox as { options: { inputRoot: string } }).options.inputRoot, outputRoot: config.roots.artifacts.broker!, trustedInputSnapshot: true, controllerLifecycle: flow.controller.binding });
          flow.controller.attach(probe);
          // Preflight probe is quiescent on return; its resources remain in the durable inventory if cleanup fails.
          const receipt = await probe.preflight();
          return { ok: receipt.ok, runId: config.run.runId, issues: receipt.checks.filter(check => !check.ok).map(check => ({ code: 'SANDBOX_NOT_QUALIFIED', message: check.detail })), warnings: [receipt.boundary] };
        },
        async delegate(input) {
          await authorize();
          if (!flow.application || (sourceKind && !flow.source)) fail('ENTRY_SOURCE_UNBOUND', 'actual application/source binding must exist before delegation');
          await flow.source?.assertCurrent();
          const ready = await flow.application.interfaceBackend.preflight({ manifestPath, mode: 'assessment' });
          if (!ready.ok) fail('ENTRY_DELEGATION_BLOCKED', JSON.stringify(ready.issues));
          const launched = await flow.application.interfaceBackend.start({ manifestPath, mode: 'assessment' });
          await flow.saveCheckpoint?.();
          if (launched.runId !== input.preparation.runId) fail('ENTRY_DELEGATION_FAILED', 'foreign run launched');
          return { runId: launched.runId, state: String((await flow.application.interfaceBackend.status(launched.runId)).run && 'active') };
        },
        async resume(input) {
          await revalidateOwner(owner);
          if (!flow.application || (sourceKind && !flow.source)) fail('ENTRY_SOURCE_UNBOUND', 'restart source restoration is unsupported; never reacquire mutable HEAD/original');
          await flow.source?.assertCurrent();
          const resumed = await flow.application.interfaceBackend.resume({ runId: input.runId, manifestPath, mode: 'assessment' });
          return { runId: resumed.runId, state: 'active' };
        },
      },
    });
    flow = { owner, setup, author, config, port, controller, budgetStore, budgetPlan, pool, planningGateway, persist() { writeFileSync(join(config.roots.control, 'application.json'), canonicalJson(config), { mode: 0o600 }); writeFileSync(join(config.roots.control, 'planning-spend.json'), canonicalJson({ limits: setup.planningLimits, receipts: setup.planningReceipts, ...(budgetPlan.outcome === 'accounting-only' ? { accounting: pool.workers.snapshot() } : { phases: Object.fromEntries(Object.entries(pool).map(([phase, ledger]) => [phase, ledger.snapshot()])) }) }), { mode: 0o600 }); } };
    flow.persist(); flows.set(config.run.runId, flow); latest = flow;
    return flow;
  };

  /**
   * Restart one interrupted bundled run from its durable checkpoint.
   *
   * Discovery, approval re-read and physical reconciliation live in the checkpoint restore helper; this
   * wiring re-binds the restored immutable source with the CURRENT pinned container qualification and the
   * SAME durable phase budgets/prices/spend/turns, then lets the existing supervisor and DurableStore gates
   * admit new attempts. Every state that cannot be physically or owner-provably reconstructed is refused:
   * no source reacquisition, budget reset, stale-session reattachment, credential serialization or
   * verifier-only replay.
   */
  const restoreFlow = async (runId: string, signal?: AbortSignal): Promise<EntryRun> => {
    if (closed) fail('ENTRY_CLOSED', 'backend is closed');
    signal?.throwIfAborted();
    const sessionOwner = ownerNow();
    const storageRoot = context.ownerStorageRoot ?? defaultOwnerStorageRoot();
    // 1. Discovery from controller-owned run metadata only. A fresh session has no onboarding value yet, so
    //    the original owner is re-read from the run's durable consent copy and matched against the
    //    owner-private consent bundle; a missing or widened consent refuses instead of widening.
    const discovery: ControllerRunDiscovery = sessionOwner
      ? await discoverInterruptedControllerRun({ ownerConfigPath: sessionOwner.configPath, runId })
      : await discoverInterruptedControllerRun({ runId, base: resolve(storageRoot, '..') });
    const owner = sessionOwner ?? await readControllerOwnerFromDurableConsent({ layout: discovery.layout, storageRoot });
    await revalidateOwner(owner);
    const author = authorNow() as HostPiPlanAuthor | undefined;
    if (!author?.configure) fail('ENTRY_PLAN_AUTHOR_REQUIRED', 'bundled restart needs the checked host Pi model selection/pricing and source UI bridge');
    // A restored run reuses the same pinned bundled runtime; a now-unbuilt/broken install refuses with the
    // named code instead of producing a raw ENOENT while the durable run is being re-admitted.
    const runtime = bundledRuntime();
    // 2. Verifier-state refusal/reconstruction and the exclusive controller claim (phase one grants no source
    //    or launch authority).
    const prepared = await prepareInterruptedControllerRestore({ owner, discovery });
    let ready: ControllerRestoreReady;
    try { ready = await prepared.ticket.reconcile(); }
    catch (error) { await prepared.ticket.close(); throw error; }
    let flow: FirstUseFlow | undefined;
    try {
      const config = discovery.config;
      if (config.sandbox.mode !== 'container') fail('CHECKPOINT_BLOCKED', 'the bundled restart seam restores container source runs only');
      // The original supervisor's exclusive evidence-vault writer lock survives the crash. It is released only
      // now, and only with a real ownership proof: the ticket proved every owned worker resource terminated and
      // holds the exclusive claim, and `releaseStaleVaultWriter` additionally requires the exact controller-owned
      // vault root and `/proc` proof that every durable controller kernel identity of this run is dead.
      await releaseStaleVaultWriter({ layout: discovery.layout, config });
      // 3. Current pinned qualification must equal the original pins exactly; drift is a refusal, never a re-pin.
      const persistedPins = config.sandbox.options as Record<string, unknown>;
      const current = containerSettings(discovery.layout.runRoot, owner, runtime);
      for (const key of ['enginePath', 'engineVersion', 'image', 'baseImageId', 'workerSha256', 'sourceSha256', 'seccompPath', 'seccompSha256'] as const) {
        if (persistedPins[key] !== undefined && persistedPins[key] !== (current as unknown as Record<string, unknown>)[key]) {
          fail('CHECKPOINT_QUALIFICATION', `pinned container qualification ${key} changed since the original run; explicit re-approval and a new plan are required; no re-pin`);
        }
      }
      if (canonicalJson(persistedPins.imageRootfsLayers as never) !== canonicalJson(current.imageRootfsLayers)) {
        fail('CHECKPOINT_QUALIFICATION', 'pinned image layer identity changed since the original run; no re-pin');
      }
      // 4. Credential-owning gateway for the CURRENT host session only; the pinned model must be provisioned
      // with explicit limits. Nothing is serialized, and the durable phase ledgers keep the pinned prices.
      const setup = await author.configure(owner);
      const pinnedSelection = config.run.requestedRuntime.selection;
      const provisioned = setup.upstream.models.find(model => model.id === pinnedSelection.model);
      if (!provisioned?.maxTokens || !provisioned.contextWindow) fail('MODEL_LIMITS_REQUIRED', 'the pinned model is not provisioned with explicit limits in the current host session; no fallback');
      const budgetStore = new DurableStore({ path: config.roots.state });
      const pool = durableAutonomousPool(budgetStore, config.run.runId, discovery.budget);
      // 5. The persisted owner pack grant must still cover this exact restored mount; a mismatch requires
      // explicit re-consent and a revised plan instead of an implicit re-grant.
      let packGrant: { configurationDigest: string; capabilities: string[]; actions: string[]; maxCalls: number; expiresAt: string };
      try {
        packGrant = JSON.parse(readFileSync(join(config.roots.control, 'pack-grant.json'), 'utf8')) as typeof packGrant;
      } catch {
        fail('PACK_GRANT_REQUIRED', 'the original owner pack grant is missing; explicit pack consent and plan approval are required');
      }
      const controller = await createControllerContainerOwner(config.roots.control, config.run.runId, current);
      // 6. Re-bind the SAME immutable snapshot with the current pinned qualification and controller lifecycle.
      const binding = await bindApprovedSourceContainer({
        request: ready.request, authorize: prepared.authorize, source: ready.source,
        qualified: { ...current, controllerLifecycle: controller.binding }, outputRoot: config.roots.artifacts.broker,
      });
      controller.attach(binding.sandbox);
      // The persisted owner grant was computed over the owner pack BOUNDARY configuration (the acquired source
      // snapshot is deliberately excluded from that digest), so the restored mount must reproduce that exact
      // boundary digest — not the broader container-sandbox mount digest.
      let restoredPackDigest: string;
      try {
        restoredPackDigest = packConfigurationDigest({ kind: 'container', settings: { ...current, inputRoot: binding.inputRoot, outputRoot: binding.outputRoot, trustedInputSnapshot: true } });
      } catch {
        fail('PACK_GRANT_REQUIRED', 'the restored mount cannot reproduce the original owner pack boundary; explicit re-consent and plan approval are required');
      }
      if (packGrant.configurationDigest !== restoredPackDigest || !packGrant.capabilities.includes('source.analyze')
        || !packGrant.actions.includes('analyze') || Date.parse(packGrant.expiresAt) <= Date.now()) {
        fail('PACK_GRANT_REQUIRED', 'the owner pack grant no longer covers this exact restored mount; explicit re-consent and plan approval are required');
      }
      const grant = config.policy.grantTemplates[0]!;
      grant.maxCalls = Math.min(grant.maxCalls, packGrant.maxCalls);
      grant.maxArtifactBytes = Math.min(grant.maxArtifactBytes, config.run.budgets.maxBytes);
      // A verifier program is only reinstated pre-admission, from the exact owner-authorized identity.
      const verifierSchedule = prepared.verifier.kind === 'pre-admission' ? prepared.verifier.schedule : undefined;
      const manifestPath = join(config.roots.control, 'run-manifest.json');
      ensureOwnerRunManifest({ path: manifestPath, run: config.run, derived: true });
      const restoredSpend = (() => {
        const budget = discovery.budget;
        if (budget.outcome === 'accounting-only') return { phase: { limits: budget.ownerLimits, ledger: pool.workers, selection: budget.selection } };
        return { phase: { ...budget.phases.workers, ledger: pool.workers, prices: budget.prices },
          ...(verifierSchedule ? { byTask: (id: string) => id === verifierSchedule.verifierTaskId ? { ...budget.phases.verifier, ledger: pool.verifier, prices: budget.prices } : undefined } : {}) };
      })();
      const application = await createApplication(config, {
        upstream: setup.upstream, sourceBinding: binding, controllerContainerOwner: controller,
        spend: restoredSpend,
        ...(verifierSchedule ? { verificationSchedule: verifierSchedule } : {}),
        runtimePaths: { guardianPath: runtime.guardianPath, receiptExtensionPath: runtime.receiptExtensionPath },
      });
      // 7. The SAME durable run/tasks are re-admitted in this controller session, then the existing
      // supervisor/DurableStore gates start fresh attempts with fresh sessions on the restored source.
      await application.admitApprovedRun();
      await application.admitApprovedTasks();
      const resumed = await application.interfaceBackend.resume({ runId, manifestPath, mode: 'assessment' });
      const origin = ready.source.identity.origin;
      const restoredPort: TargetEntryPort = {
        async prepare() { fail('ENTRY_RUN_UNKNOWN', 'a restored run has one immutable approved plan; prepare a new run instead'); },
        async plan() { fail('ENTRY_RUN_UNKNOWN', 'a restored run has one immutable approved plan; prepare a new run instead'); },
        async start() { fail('ENTRY_RUN_UNKNOWN', 'a restored run is started through restart recovery, not a new start'); },
        async approve() { fail('ENTRY_RUN_UNKNOWN', 'a restored run has one immutable approved plan; prepare a new run instead'); },
        async resume(candidate: string) { const existing = flows.get(candidate)?.restore; return existing ? existing.resume() : restoreFlow(candidate); },
        async currentRun(): Promise<EntryRunSummary> { return { runId, state: 'active', targetKind: ready.source.identity.kind, startedAt: new Date(Date.now()).toISOString() }; },
      };
      flow = {
        owner, setup, author, config, port: restoredPort, controller, budgetStore, budgetPlan: discovery.budget, pool,
        application, source: binding, checkpointRequest: ready.request,
        saveCheckpoint: async () => {
          if (application.store.getRun(config.run.runId)?.state !== 'active') return;
          try {
            await persistControllerCheckpoint({ root: discovery.layout.checkpointRoot,
              forbiddenRoots: [config.roots.workspace, config.roots.artifacts.broker!, binding.inputRoot, ...(origin.startsWith('/') ? [origin] : [])],
              store: application.store, request: ready.request, source: ready.source, ownerConfigPath: owner.configPath, authorize: prepared.authorize });
          } catch (error) {
            if ((error as { code?: string }).code === 'CHECKPOINT_TERMINAL' && application.store.getRun(config.run.runId)?.state !== 'active') return;
            throw error;
          }
        },
        persist() { writeFileSync(join(config.roots.control, 'application.json'), canonicalJson(config), { mode: 0o600 }); },
        restore: {
          ticket: ready,
          resume: async () => {
            await revalidateOwner(owner);
            await binding.assertCurrent();
            const again = await application.interfaceBackend.resume({ runId, manifestPath, mode: 'assessment' });
            return { runId: again.runId, state: 'active', planId: ready.request.plan.planId, approvalRef: ready.request.approval.approvalRef, mode: 'assessment' };
          },
          summary: { runId, state: 'active', targetKind: ready.source.identity.kind },
        },
      };
      flows.set(runId, flow); latest = flow;
      return { runId: resumed.runId, state: 'active', planId: ready.request.plan.planId, approvalRef: ready.request.approval.approvalRef, mode: 'assessment' };
    } catch (error) {
      await flow?.application?.close().catch(() => {});
      await flow?.controller?.close().catch(() => {});
      flow?.budgetStore.close();
      await ready.close().catch(() => {});
      throw error;
    }
  };

  const forPreparation = (preparation: EntryPreparation) => { const flow = flows.get(preparation.runId); if (!flow) fail('PLAN_NOT_FOUND', 'preparation belongs to no bundled run'); return flow; };
  const entry: TargetEntryPort = {
    async prepare(input, signal) { const owner = ownerNow(); if (!owner || !consentCovers(owner.configuration, onboardingScopeFor(input.target, context.cwd), owner.effectiveLimits, owner.effectivePermissions)) fail('OWNER_SCOPE_MISMATCH', 'command target differs from current owner consent'); return (await newFlow()).port.prepare(input, signal); },
    async plan(input, signal) { const flow = forPreparation(input.preparation); try { const plan = await flow.port.plan(input, signal); plans.set(plan.planId, flow); return plan; } finally { flow.persist(); } },
    async start(input, signal) { return forPreparation(input.preparation).port.start(input, signal); },
    async approve(input, signal) { const flow = plans.get(input.planId); if (!flow) fail('PLAN_NOT_FOUND', 'sealed bundled plan cannot be restored in this process'); return flow.port.approve(input, signal); },
    async readPlan(planId, signal) { return plans.get(planId)?.port.readPlan?.(planId, signal) ?? null; },
    async resume(runId, signal) { const flow = flows.get(runId); if (flow?.restore) return flow.restore.resume(); if (flow) return flow.port.resume(runId, signal); return restoreFlow(runId, signal); },
    async currentRun() { const admitted = [...flows.values()].filter(flow => flow.application); if (admitted.length !== 1) return null; const flow = admitted[0]!; return flow.restore?.summary ?? flow.port.currentRun?.() ?? null; },
  };
  /**
   * Publish the packaging reviewer's review of every finding whose producing packet was accepted. The
   * composition never overwrites an existing review, so a verifier replay outcome (promoted, rejected or
   * unresolved) always wins; when no replay happened the finding stays at its producer-level state and the
   * report shows exactly that instead of an independent-validation claim.
   */
  const publishFindingReviews = (flow: FirstUseFlow | undefined): void => {
    const application = flow?.application;
    if (!flow || !application) return;
    for (const plan of flow.config.reporting?.findings ?? []) {
      if (!application.acceptedPacket(plan.taskId)) continue;
      application.verifier.producerReview(plan.findingId);
    }
  };
  const backend: ControlBackend = {
    entry,
    preflight: (input, signal) => active(latest?.config.run.runId ?? '').preflight(input, signal),
    start: (input, signal) => active(latest?.config.run.runId ?? '').start(input, signal),
    resume: (input, signal) => active(input.runId).resume(input, signal),
    stop: (runId, reason) => active(runId).stop(runId, reason), async status(runId) { const status = await active(runId).status(runId); await flows.get(runId)?.saveCheckpoint?.(); return status; },
    tasks: (runId, page) => active(runId).tasks(runId, page), evidence: (runId, page, evidenceId) => active(runId).evidence(runId, page, evidenceId),
    async report(runId, format) {
      const flow = flows.get(runId); publishFindingReviews(flow);
      const report = await active(runId).report(runId, format);
      flow?.persist();
      if (!flow) return report;
      // Accounting-only runs report one informational cumulative snapshot. Reporting four identical
      // 'phase' snapshots would falsely imply isolated financial quotas that no longer exist.
      return flow.budgetPlan.outcome === 'accounting-only'
        ? { ...report, modelBudget: { policy: flow.budgetPlan.policy, accounting: flow.pool.workers.snapshot() } }
        : { ...report, modelBudget: { policy: flow.budgetPlan.policy, phases: Object.fromEntries(Object.entries(flow.pool).map(([phase, ledger]) => [phase, ledger.snapshot()])) as Record<import("../policy/budget.js").AutonomousBudgetPhase, Readonly<import("../policy/budget.js").ModelSpendSnapshot>> } };
    }, events: (runId, page) => active(runId).events(runId, page),
    async close() { closed = true; for (const flow of flows.values()) { await flow.application?.close(); await flow.controller?.close(); await flow.planningGateway?.close(); await flow.restore?.ticket.close(); flow.budgetStore.close(); } },
  };
  return Object.freeze(backend);
}
