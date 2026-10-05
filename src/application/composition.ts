import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  canonicalJson, classifications, digestJson, evidenceKinds, normalizeTargetKey, planApprovalDocumentSchema, runSchema, taskSchema,
  type AttemptRecord, type CoverageReconciliation, type EvidenceReceipt, type FindingRecord, type HandoffPacket, type JsonObject,
  type PlanCaps, type PlanProposal, type RunManifest, type TaskManifest,
} from '../contracts/index.js';
import { openStore, type StoredResult } from '../store/index.js';
import {
  createResultCollectorBridge, createWorkspacePacketSource, openEvidenceVault, PACKET_EVIDENCE_CLASSIFICATION,
  PACKET_EVIDENCE_KIND, publishHandoffReviews as publishEvidenceReviews, type CleanReplayBroker, type FindingReview, type ResultCollectorBridge,
} from '../evidence/index.js';
import { createPlanLedger, createPlanPort, createRequestPlanLedger, createWorkerContextPort, materializeRequestPlan, type PlanLedger, type PlanPort, type PlanPortOptions, type RequestPlanLedger } from './planner.js';
import { defaultResolver } from '../tools/http.js';
import { createPolicy, modelPriceKey, modelAccountingPolicy, PINNED_MODEL_PRICES, PolicyError, TargetBudget, type Policy, type Scope } from '../policy/index.js';
import {
  CapabilityRegistry, createBrowserPack, createContainerSandbox, createDefaultRegistry, createHostBrowserSandbox, createLocalFixtureSandbox,
  createProxyPack, createToolBroker, ToolExecutionError, validateApprovedTemplates,
  type ApprovedFuzzTemplate, type BrowserPack, type DnsResolver, type ExecutionSandbox, type PackSessionFence, type ProxyPack, type ToolBroker,
} from '../tools/index.js';
import { CAPABILITIES } from '../policy/index.js';
import {
  createControllerModelGateway,
  createHerdrRuntime,
  type ControllerGatewayCredential,
  type ControllerModelGateway,
  type ModelGateway,
  type ModelSpendRuntimeOptions,
  type RuntimeAdapter,
  type SessionReleaser,
  type SessionReleaseRegistry,
} from '../runtime/index.js';
import { createOwnedHeadlessRuntime } from './runtimes.js';
import type { RuntimeRequest, ToolPolicy as RuntimeToolPolicy } from '../runtime/types.js';
import {
  createSupervisor, validateTools, type Authority, type Clock, type Role, type SupervisorApi, type TaskProposal,
} from '../orchestrator/index.js';
import { createCredentialAuthority, type OwnerCredentialStore } from './authority.js';
import type { CredentialRequirement } from '../interface/supervisor-backend.js';
import type { CredentialProvider } from '../tools/index.js';
import { createSupervisorBackend, type SupervisorPort } from '../interface/supervisor-backend.js';
import type { ControlBackend, PlanInput, Report as InterfaceReport } from '../interface/types.js';
import { createWorkerBridge, type WorkerBridgeOperations } from './bridge.js';
import { packetAuthoringFor } from './packet-authoring.js';
import { admitAuthenticatedPacket } from './packet-admission.js';
import { createCollectorBridge, controllerToolIdentity, type CollectorBridge } from './evidence.js';
import { acceptedPacket, acceptedResult, buildAssessmentArtifacts, coverageRecords, coverageReviews, producerFinding } from './report.js';
import { createIndependentVerifier, type CleanReplayEnvironmentFactory, type VerificationServices } from './verification.js';
import {
  createFirstUseReplayEnvironment, createScopedVerificationPolicy, deriveFirstUseVerificationPlan,
  selectReceiptBoundProducerCandidate, synthesizeFirstUseVerification,
  type FirstUseReplayPlan, type FirstUseVerificationBudget,
} from './first-use-verification/index.js';
import {
  HOST_BROWSER_SANDBOX_ACKNOWLEDGEMENT, INERT_FIXTURE_ACKNOWLEDGEMENT, LOCAL_FIXTURE_SANDBOX_ACKNOWLEDGEMENT,
  type ApplicationConfig, type AssessmentApplication, type AssessmentArtifacts,
  type PacksConfig,
  type FindingPlan,
  type CoveragePlanEntry, type GrantedTask, type ObservationCheck, type OwnerGrant as OwnerGrantDocument,
  type PlanContextDocument, type PlanContextObservation, type PlanContextScope, type PlanContextTask, type PlannerConfig,
  type VerificationPlan,
} from './types.js';
import { ApplicationError, absolutePath, bool, fail, integer, list, literal, object, parseObservationSelection, text } from './validation.js';
import { enforceInterfaceMode, interfaceModeFor } from './mode.js';
import { createOwnerDirectoryAuthority, ownerDocumentPathFor } from './entry/approvals.js';
import { ENTRY_BOUNDS_DEFAULTS } from './entry/types.js';
import { fingerprintTree } from './entry/snapshot.js';
import type { EntryAcquisition, EntryObserver, EntryBounds, EntryCommandRunner, EntryOwnerObservation, EntryPlanAuthor, EntryRunBinding } from './entry/types.js';
import type { EntryPlan, EntryPreparation } from '../interface/target-entry.js';
import type { EntrySeams } from './entry/factory.js';
import type { EntryOwnerSelection } from './entry/types.js';
import type { ApprovedRequestGrant } from './planner.js';
import type { PlanCoverageCell, PlanObservation, PlanTask } from '../contracts/plan.js';
import type { PlanRequestEnvelope } from '../contracts/plan-request.js';
import type { RequestApprovalAuthority } from './authority.js';

import { registerPackSessionFamily, recoverControllerListeners } from '../runtime/pack-lifecycle.js';
import { recoverBrowserResources } from '../tools/browser-lifecycle.js';
import { recoverContainerResources, type ContainerSandboxOptions, type SourceContainerSandbox } from '../tools/container.js';
import { createControllerContainerOwner, type ControllerContainerOwner } from './container-owner.js';
import type { ApprovedSourceContainerBinding } from './source-binding/index.js';
/**
 * Reservations are taken before dispatch so an already exhausted task/run/target budget refuses without any
 * target traffic. A call that then provably never dispatched (broker pre-dispatch refusal: capability/input
 * validation, policy authorize, session fence, sandbox bring-up, halt fence) must not keep those counters, so
 * the exact reservation is released. Dispatched work — including redirects and failures — stays charged.
 */
export function isPreDispatchRefusal(error: unknown): boolean {
  return error instanceof ToolExecutionError && !error.dispatched;
}
/**
 * Release a prepared environment on a refusal path without trusting it to cooperate. An AbortSignal only bounds
 * an abort-AWARE close; it does not bound the await, so the await itself is raced against a deadline. Never
 * throws, and reports whether the release actually settled so a leak is visible in the refusal message.
 */
export async function closePreparedReplaySession(
  session: { close(signal: AbortSignal): unknown },
  timeoutMs = 1_000,
): Promise<'closed' | 'timeout' | 'failed'> {
  const controller = new AbortController();
  let expire: () => void = () => {};
  const deadline = new Promise<'timeout'>(resolve => { expire = () => resolve('timeout'); });
  const timer = setTimeout(() => { controller.abort(); expire(); }, timeoutMs);
  timer.unref();
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => session.close(controller.signal))
        .then(() => 'closed' as const, () => 'failed' as const),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * [verification] Controller-owned policy seam for ANY replay environment, override included. The verifier's
 * scoped verification policy is never chosen or weakened by a harness: it is computed per request from the
 * ACTUAL verifier attempt's broker scope (`scopeFor(request.attempt.attemptId)`). An environment may omit the
 * policy (the controller injects it) but may not supply a conflicting one — a mismatching policy is refused by
 * name and the freshly created environment is released instead of being used.
 */
export function bindControllerVerificationPolicy(input: { run: RunManifest; scopeFor: (attemptId: string) => Scope; now: () => number }): (broker: CleanReplayBroker) => CleanReplayBroker {
  return broker => ({
    async prepare(request) {
      // Validate the controller side BEFORE creating anything: a defective scope (or run binding) must refuse
      // here, while there is no session to release, instead of leaking an environment this seam cannot return.
      const expected = createScopedVerificationPolicy(input.run, input.scopeFor(request.attempt.attemptId), input.now);
      const session = await broker.prepare(request);
      const supplied = session.verificationPolicy;
      if (supplied && (supplied.runId !== expected.runId || supplied.scopeDigest !== expected.scopeDigest)) {
        const released = await closePreparedReplaySession(session);
        throw new ApplicationError('replay-policy-conflict', `replay-policy-conflict: a replay environment may not supply a verification policy that differs from the controller-computed verifier scope (prepared environment release: ${released})`);
      }
      return { ...session, verificationPolicy: expected };
    },
  });
}
export interface ApplicationOverrides {
  /** Controller-issued immutable binding; never loaded from model/worker JSON. */
  sourceBinding?: ApprovedSourceContainerBinding;
  /** Separate durable owner of source preflight probes, supplied by the first-use controller. */
  controllerContainerOwner?: ControllerContainerOwner;
  /** Additional runtime adapters registered beside the configured one (e.g. an owner-supplied herdr runtime). */
  runtimes?: Record<string, RuntimeAdapter>;
  /** Publication override; defaults to the evidence module's controller-attested publication bridge. */
  publish?: (options: { runId: string; reviewerId: string; now: string }) => { reviews: readonly unknown[]; controllerReceipts: readonly unknown[] };
  /** Clean replay environment factory (fixture/assessment specific). Required when verification plans exist. */
  replayEnvironment?: CleanReplayEnvironmentFactory;
  clock?: Clock;
  log?: (event: string, detail: string) => void;
  /**
   * Owner-provided upstream provider credential. When supplied, ONE controller-owned model gateway is
   * created per run and its (loopback, placeholder-only) gateway object is what every worker runtime
   * receives; the real credential never leaves the controller gateway process.
   */
  upstream?: {
    approval: string;
    provider: string;
    upstreamBaseUrl: string;
    api: ModelGateway['api'];
    models: ModelGateway['models'];
    credential: ControllerGatewayCredential;
    log?: (line: string) => void;
  };
  /** Owner credential store for authenticated target access; required for credential-tier accounts. */
  credentials?: OwnerCredentialStore;
  /** Owner-approved account/target/action requirements re-resolved at preflight and every dispatch. */
  credentialPlan?: readonly CredentialRequirement[];
  /** Extra values to redact from tool output and evidence (per-request credentials are always redacted). */
  secrets?: readonly string[];
  /**
   * Optional declared model-spend bounds. Enforcement itself is fail-closed and always on: the ledger is
   * built from the owner-approved run budgets even when no bounds are declared here. These bounds only
   * pin the worst case one provider request may reserve.
   */
  spend?: { inputTokensUpperBound?: number; maxOutputTokens?: number; freshRun?: boolean; phase?: ModelSpendRuntimeOptions; byTask?: (taskId: string) => ModelSpendRuntimeOptions | undefined };
  /**
   * Controller-owned post-admission verifier scheduling for an owner-approved read-only differential. The
   * producer packet must already be admitted; the verifier task's exact manifest must already be present and
   * `deferred` in the owner document. This seam grants nothing: synthesis re-validates the per-claim receipts
   * and the pre-authorized manifest digest before `supervisor.admitTask` is reached.
   */
  verificationSchedule?: {
    producerTaskId: string;
    verifierTaskId: string;
    targetId: string;
    targetLocator: string;
    /** Protected verifier phase reserve; never widened by the scheduler. */
    budget: FirstUseVerificationBudget;
    /** When the controller derived the verifier identity from the approved plan. */
    derivedAt: string;
  };
  /** Optional owner-supplied DNS resolver shared by the browser/proxy packs and the HTTP adapter. */
  resolver?: DnsResolver;
  /**
   * [F3/F5] Optional plan-port seam. `planner.ts` owns the plan-port contract; this composition sets the
   * collaborators it owns and forwards every owner-supplied option it does not own (for example a
   * generated-plan materializer the planner workstream adds, or explicit plan caps) into `createPlanPort`.
   * Composition-owned keys are refused here so a seam can never replace the store, authority or admission path,
   * and passing an option the plan port does not implement is a compile-time error, never a silent no-op.
   */
  planPortOptions?: Omit<Partial<PlanPortOptions>, 'controlRoot' | 'store' | 'supervisor' | 'authority' | 'ledger' | 'toolPolicy' | 'boundaryReceipt' | 'observationApproved' | 'prepareWorkspace' | 'onAdmitted'>;
  /**
   * [F3/F5] Optional generated-plan (request-plan) seam. `planner.ts` owns the generated-request contract
   * (`RequestPlanLedger` + `materializeRequestPlan`); this composition hosts the caller's ledger verbatim and
   * exposes the planner's own materializer beside it, so a generated-plan path produces checks and grants through
   * the approved planner gate instead of a private copy of it. The materializer may only be replaced by a function
   * with the same signature. Absent (the default), no generated-plan ledger exists in this composition and the
   * owner-menu plan path (with its `planApprovals` gate) is unchanged.
   */
  requestPlan?: { ledger: RequestPlanLedger; materialize?: typeof materializeRequestPlan };
  /**
   * Target-entry workflow (`/p2o --target`). The composition always derives the owner-scoped seams from the
   * validated owner document (owner observations, request envelope, registration callbacks, owner approval
   * directory); these overrides only pin their locations and the model author. `createP2OBackend` builds the
   * `TargetEntryPort` from them and attaches it as `ControlBackend.entry`.
   */
  entry?: ApplicationEntryOverrides;
  /**
   * Controller-owned runtime entry points (guardian wrapper and receipt extension). Defaults are resolved
   * beside `src/runtime`, which is correct for the built composition; a harness that runs the TypeScript
   * sources directly (a vitest suite) points these at the built files so the real guardian still runs.
   */
  runtimePaths?: { guardianPath?: string; receiptExtensionPath?: string; nodeBinary?: string };
}

/** Owner/operator pinning for the derived target-entry seams; every field is optional. */
export interface ApplicationEntryOverrides {
  /** Canonical private root for entry snapshots/clones/plan records; default `<roots.control>/entry`. */
  workspaceRoot?: string;
  /** Canonical owner-authored RunManifest document; default is a derived copy of the owner run document. */
  manifestPath?: string;
  /** Owner-authored approval directory; default `<roots.control>/entry/approvals`. */
  approvalDirectory?: string;
  /** Real model plan author (Pi host model or owner-private module); absent makes `plan` fail closed. */
  planAuthor?: EntryPlanAuthor;
  bounds?: Partial<EntryBounds>;
  clock?: () => number;
  newId?: () => string;
  gitBinary?: string;
  commandRunner?: EntryCommandRunner;
  observer?: EntryObserver;
}

/** [T8/S1] Owner/application-declared model-spend bounds; enforcement itself is never optional. */
export interface ApplicationSpendConfig { inputTokensUpperBound?: number; maxOutputTokens?: number }
/** The validated application document plus the optional owner-declared spend bounds. */
export type ApplicationConfigWithSpend = ApplicationConfig & { spend?: ApplicationSpendConfig };

const SUPERVISOR_OWNER = 'p2o-supervisor';
const REVIEWER_ID = 'p2o-reviewer';
const VERIFIER_COLLECTOR = 'p2o-independent-verifier';

/** [F3] Attempt lifecycle states in which no pack session may be created or driven (same rule as the worker bridge). */
const TERMINAL_ATTEMPT_STATES = new Set(['exited', 'failed', 'timed-out', 'cancelled', 'reconciling', 'queued']);
/** [F3] Run states in which no attempt may own a pack session. */
const INACTIVE_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);
/** [F3] Plan-port options this composition owns; a plan-port seam may never replace them. */
const PLAN_PORT_OWNED_KEYS = ['controlRoot', 'store', 'supervisor', 'authority', 'ledger', 'toolPolicy', 'boundaryReceipt', 'observationApproved', 'prepareWorkspace', 'onAdmitted'] as const;

/**
 * [F3] Controller-private runtime handle of one attempt, and the only source of its session-lease owner token.
 * Shape, ownership and permissions are re-checked on every fence call: a caller-supplied token is never trusted,
 * and a stale/missing handle refuses the pack call instead of guessing an ownership identity.
 */
function attemptOwnerToken(controlRoot: string, runId: string, attemptId: string): string {
  const deny = (message: string): never => { throw new PolicyError('CAPABILITY_DENIED', message); };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId)) deny('Attempt identity is not a bounded identifier');
  const file = join(controlRoot, 'handles', `${attemptId}.json`);
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(file); } catch { return deny(`No controller-owned runtime handle exists for attempt ${attemptId}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return deny(`The runtime handle for attempt ${attemptId} is not a private regular file`);
  if (stat.size === 0 || stat.size > 4 * 1024 * 1024) return deny(`The runtime handle for attempt ${attemptId} has an implausible size`);
  let handle: { attemptId?: unknown; runId?: unknown; ownerToken?: unknown };
  try { handle = JSON.parse(readFileSync(file, 'utf8')) as typeof handle; } catch { return deny(`The runtime handle for attempt ${attemptId} is not readable JSON`); }
  if (!handle || handle.attemptId !== attemptId || handle.runId !== runId || typeof handle.ownerToken !== 'string' || handle.ownerToken.length < 8 || handle.ownerToken.length > 256) {
    return deny(`The runtime handle for attempt ${attemptId} does not carry this attempt's owner token`);
  }
  return handle.ownerToken;
}

// ---------------------------------------------------------------- validation

export function validateApplicationConfig(input: unknown): ApplicationConfigWithSpend {
  const config = object(input, [
    'schemaVersion', 'mode', 'acknowledgement', 'roots', 'run', 'tasks', 'runtime', 'sandbox', 'policy',
    'bridge', 'checks', 'reporting', 'interface', 'vaultLimits', 'spend', 'planner', 'packs',
  ], 'application config');
  if (config.schemaVersion !== 1) fail('invalid-config', 'schemaVersion must be 1');
  const mode = literal(config.mode, 'mode', ['inert-local-fixture', 'authorized-assessment']);
  if (mode === 'inert-local-fixture') {
    if (config.acknowledgement !== INERT_FIXTURE_ACKNOWLEDGEMENT) {
      fail('invalid-config', 'inert-local-fixture requires the exact inert acknowledgement; it is never selected implicitly');
    }
  } else if (config.acknowledgement !== undefined) {
    fail('invalid-config', 'authorized-assessment must not carry the inert acknowledgement');
  }

  const roots = object(config.roots, ['state', 'control', 'workspace', 'vault', 'artifacts', 'workerWriteRoots'], 'roots');
  const statePath = absolutePath(roots.state, 'roots.state');
  const control = absolutePath(roots.control, 'roots.control');
  const workspace = absolutePath(roots.workspace, 'roots.workspace');
  const vault = absolutePath(roots.vault, 'roots.vault');
  const artifactsRaw = object(roots.artifacts, Object.keys(roots.artifacts as Record<string, unknown>), 'roots.artifacts');
  const artifacts: Record<string, string> = {};
  for (const [id, value] of Object.entries(artifactsRaw)) artifacts[id] = absolutePath(value, `roots.artifacts.${id}`);
  if (Object.keys(artifacts).length === 0) fail('invalid-config', 'at least one artifact root is required');
  const workerWriteRoots = list(roots.workerWriteRoots, 'roots.workerWriteRoots', (value, index) => absolutePath(value, `roots.workerWriteRoots[${index}]`), 32);
  if (workerWriteRoots.length === 0) fail('invalid-config', 'roots.workerWriteRoots must name every worker-writable root');

  const run = runSchema.parse(config.run) as RunManifest;
  if (run.state !== 'created') fail('invalid-config', 'run.state must be "created" in the owner document');
  const runtimeRaw = object(config.runtime, ['adapter', 'selection', 'piBinary', 'piVersion', 'gateway', 'startupTimeoutMs', 'pollMs', 'stopGraceMs', 'herdr'], 'runtime');
  const adapter = literal(runtimeRaw.adapter, 'runtime.adapter', ['headless', 'herdr']);
  if (run.requestedRuntime.adapter !== adapter) fail('invalid-config', 'run.requestedRuntime.adapter must match runtime.adapter');
  const piBinary = absolutePath(runtimeRaw.piBinary, 'runtime.piBinary');
  const runtime = {
    adapter,
    selection: run.requestedRuntime.selection,
    piBinary,
    ...(runtimeRaw.piVersion === undefined ? {} : { piVersion: text(runtimeRaw.piVersion, 'runtime.piVersion', 64) }),
    gateway: runtimeRaw.gateway as ApplicationConfig['runtime']['gateway'],
    ...(runtimeRaw.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: integer(runtimeRaw.startupTimeoutMs, 'runtime.startupTimeoutMs', 100, 300_000) }),
    ...(runtimeRaw.pollMs === undefined ? {} : { pollMs: integer(runtimeRaw.pollMs, 'runtime.pollMs', 10, 10_000) }),
    ...(runtimeRaw.stopGraceMs === undefined ? {} : { stopGraceMs: integer(runtimeRaw.stopGraceMs, 'runtime.stopGraceMs', 0, 300_000) }),
    ...(runtimeRaw.herdr === undefined ? {} : { herdr: runtimeRaw.herdr as ApplicationConfig['runtime']['herdr'] }),
  } as ApplicationConfig['runtime'];
  if (adapter === 'herdr' && !runtime.herdr) fail('invalid-config', 'runtime.herdr routing metadata is required for the herdr adapter');

  const sandboxRaw = object(config.sandbox, ['mode', 'acknowledgement', 'inputRoot', 'outputRoot', 'maxFileBytes', 'maxArtifactBytes', 'maxArtifacts', 'identityDigest', 'options',
    'approvedBy', 'expiresAt', 'egress', 'profileRoot', 'maxSessions', 'sessionTtlMs', 'maxActionsPerSession', 'maxRequestsPerSession', 'identity'], 'sandbox');
  let sandbox: ApplicationConfig['sandbox'];
  if (sandboxRaw.mode === 'local-fixture') {
    if (mode !== 'inert-local-fixture') fail('invalid-config', 'local-fixture sandbox is only valid in inert-local-fixture mode; it is never an assessment fallback');
    if (sandboxRaw.acknowledgement !== LOCAL_FIXTURE_SANDBOX_ACKNOWLEDGEMENT) fail('invalid-config', 'local-fixture sandbox requires its exact acknowledgement');
    sandbox = {
      mode: 'local-fixture',
      acknowledgement: 'local-fixtures-only-not-hostile-code-isolation',
      inputRoot: absolutePath(sandboxRaw.inputRoot, 'sandbox.inputRoot'),
      outputRoot: absolutePath(sandboxRaw.outputRoot, 'sandbox.outputRoot'),
      ...(sandboxRaw.maxFileBytes === undefined ? {} : { maxFileBytes: integer(sandboxRaw.maxFileBytes, 'sandbox.maxFileBytes', 1024, 1 << 30) }),
      ...(sandboxRaw.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: integer(sandboxRaw.maxArtifactBytes, 'sandbox.maxArtifactBytes', 1024, 1 << 30) }),
      ...(sandboxRaw.maxArtifacts === undefined ? {} : { maxArtifacts: integer(sandboxRaw.maxArtifacts, 'sandbox.maxArtifacts', 1, 4096) }),
      ...(sandboxRaw.identityDigest === undefined ? {} : { identityDigest: text(sandboxRaw.identityDigest, 'sandbox.identityDigest', 64) }),
    };
  } else if (sandboxRaw.mode === 'container') {
    if (sandboxRaw.options === undefined) fail('invalid-config', 'container sandbox requires explicit options');
    sandbox = { mode: 'container', options: sandboxRaw.options };
  } else if (sandboxRaw.mode === 'host-browser') {
    // [F3] Real headless Chrome on the host: an explicit, owner-acknowledged boundary that is never a container
    // fallback and never selectable from an inert fixture run.
    if (mode !== 'authorized-assessment') fail('invalid-config', 'host-browser sandbox is refused in inert-local-fixture mode; an inert fixture run never launches a host browser');
    if (sandboxRaw.acknowledgement !== HOST_BROWSER_SANDBOX_ACKNOWLEDGEMENT) fail('invalid-config', 'host-browser sandbox requires its exact not-container-isolated acknowledgement');
    const identityRaw = object(sandboxRaw.identity, ['launcher', 'launcherSha256', 'executable', 'executableSha256', 'version', 'product'], 'sandbox.identity');
    const sha256Hex = (value: unknown, label: string): string => {
      const hex = text(value, label, 64);
      if (!/^[a-f0-9]{64}$/.test(hex)) fail('invalid-config', `${label} must be a sha256 hex digest`);
      return hex;
    };
    sandbox = {
      mode: 'host-browser',
      acknowledgement: HOST_BROWSER_SANDBOX_ACKNOWLEDGEMENT,
      inputRoot: absolutePath(sandboxRaw.inputRoot, 'sandbox.inputRoot'),
      outputRoot: absolutePath(sandboxRaw.outputRoot, 'sandbox.outputRoot'),
      approvedBy: text(sandboxRaw.approvedBy, 'sandbox.approvedBy', 128),
      expiresAt: text(sandboxRaw.expiresAt, 'sandbox.expiresAt', 64),
      egress: literal(sandboxRaw.egress, 'sandbox.egress', ['loopback-only', 'policy-scope']),
      profileRoot: absolutePath(sandboxRaw.profileRoot, 'sandbox.profileRoot'),
      ...(sandboxRaw.maxSessions === undefined ? {} : { maxSessions: integer(sandboxRaw.maxSessions, 'sandbox.maxSessions', 1, 8) }),
      ...(sandboxRaw.sessionTtlMs === undefined ? {} : { sessionTtlMs: integer(sandboxRaw.sessionTtlMs, 'sandbox.sessionTtlMs', 1000, 3_600_000) }),
      ...(sandboxRaw.maxActionsPerSession === undefined ? {} : { maxActionsPerSession: integer(sandboxRaw.maxActionsPerSession, 'sandbox.maxActionsPerSession', 1, 1024) }),
      ...(sandboxRaw.maxRequestsPerSession === undefined ? {} : { maxRequestsPerSession: integer(sandboxRaw.maxRequestsPerSession, 'sandbox.maxRequestsPerSession', 1, 4096) }),
      ...(sandboxRaw.maxFileBytes === undefined ? {} : { maxFileBytes: integer(sandboxRaw.maxFileBytes, 'sandbox.maxFileBytes', 1024, 1 << 30) }),
      ...(sandboxRaw.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: integer(sandboxRaw.maxArtifactBytes, 'sandbox.maxArtifactBytes', 1024, 1 << 30) }),
      ...(sandboxRaw.maxArtifacts === undefined ? {} : { maxArtifacts: integer(sandboxRaw.maxArtifacts, 'sandbox.maxArtifacts', 1, 4096) }),
      identity: {
        launcher: absolutePath(identityRaw.launcher, 'sandbox.identity.launcher'),
        launcherSha256: sha256Hex(identityRaw.launcherSha256, 'sandbox.identity.launcherSha256'),
        executable: absolutePath(identityRaw.executable, 'sandbox.identity.executable'),
        executableSha256: sha256Hex(identityRaw.executableSha256, 'sandbox.identity.executableSha256'),
        version: text(identityRaw.version, 'sandbox.identity.version', 64),
        product: text(identityRaw.product, 'sandbox.identity.product', 128),
      },
      ...(sandboxRaw.identityDigest === undefined ? {} : { identityDigest: text(sandboxRaw.identityDigest, 'sandbox.identityDigest', 64) }),
    };
  } else if (sandboxRaw.mode === 'container') {
    if (sandboxRaw.options === undefined) fail('invalid-config', 'container sandbox requires explicit options');
    sandbox = { mode: 'container', options: sandboxRaw.options };
  } else fail('invalid-config', 'sandbox.mode must be local-fixture, host-browser or container');

  // [F3] Optional owner-configured capability packs. Nothing is enabled by the sandbox mode, and each pack is
  // refused here when the configured boundary cannot qualify it (browser needs the acknowledged host boundary;
  // the capture proxy is a host loopback listener that container isolation refuses).
  const packsRaw = config.packs === undefined ? {} : object(config.packs, ['browser', 'proxy', 'fuzz'], 'packs');
  const browserPack = packsRaw.browser === undefined ? false : bool(packsRaw.browser, 'packs.browser');
  const proxyPack = packsRaw.proxy === undefined ? false : bool(packsRaw.proxy, 'packs.proxy');
  let fuzzPack: NonNullable<PacksConfig['fuzz']> | undefined;
  if (packsRaw.fuzz !== undefined) {
    const fuzzRaw = object(packsRaw.fuzz, ['templates'], 'packs.fuzz');
    if (fuzzRaw.templates === undefined) fuzzPack = {};
    else {
      const templates = list(fuzzRaw.templates, 'packs.fuzz.templates', (value: unknown) => {
        // The fuzz pack owns the approved-template contract; its own validator is the authority here too.
        try { validateApprovedTemplates([value as ApprovedFuzzTemplate]); }
        catch (error) { fail('invalid-config', `packs.fuzz.templates entry is not an owner-approved template: ${error instanceof Error ? error.message.slice(0, 200) : 'invalid'}`); }
        return value as ApprovedFuzzTemplate;
      }, 64);
      fuzzPack = { templates };
    }
  }
  if (browserPack && sandbox.mode !== 'host-browser') fail('invalid-config', 'packs.browser requires the acknowledged host-browser sandbox; browser.* is never qualified on local-fixture or container isolation');
  if (proxyPack && sandbox.mode === 'container') fail('invalid-config', 'packs.proxy is refused on container isolation: the capture proxy is a host loopback listener and the pack is only qualified on local-fixture/host-browser');
  const packs: PacksConfig | undefined = browserPack || proxyPack || fuzzPack ? { browser: browserPack, proxy: proxyPack, ...(fuzzPack ? { fuzz: fuzzPack } : {}) } : undefined;

  const bridgeRaw = object(config.bridge, ['socketPath', 'controllerArtifactRootId', 'brokerArtifactRootId', 'inertLocalOnly'], 'bridge');
  const bridge = {
    socketPath: absolutePath(bridgeRaw.socketPath, 'bridge.socketPath'),
    controllerArtifactRootId: text(bridgeRaw.controllerArtifactRootId, 'bridge.controllerArtifactRootId', 128),
    brokerArtifactRootId: text(bridgeRaw.brokerArtifactRootId, 'bridge.brokerArtifactRootId', 128),
    inertLocalOnly: bool(bridgeRaw.inertLocalOnly, 'bridge.inertLocalOnly'),
  };
  if (!Object.hasOwn(artifacts, bridge.controllerArtifactRootId)) fail('invalid-config', 'bridge.controllerArtifactRootId must name a declared artifact root');
  if (!Object.hasOwn(artifacts, bridge.brokerArtifactRootId)) fail('invalid-config', 'bridge.brokerArtifactRootId must name a declared artifact root');
  if (mode === 'inert-local-fixture' && !bridge.inertLocalOnly) fail('invalid-config', 'inert-local-fixture requires bridge.inertLocalOnly');
  if (mode === 'authorized-assessment' && bridge.inertLocalOnly) fail('invalid-config', 'authorized-assessment must not claim the inert bridge mode');

  const taskEntries = list(config.tasks, 'tasks', (value, index) => {
    const entry = object(value, ['manifest', 'role', 'exclusiveKeys', 'toolPolicy', 'boundaryReceipt', 'workerPlan', 'deferred'], `tasks[${index}]`);
    const manifest = taskSchema.parse(entry.manifest) as TaskManifest;
    const role = literal(entry.role, `tasks[${index}].role`, ['orchestrator', 'worker', 'verifier', 'reporter']) as Role;
    const exclusiveKeys = entry.exclusiveKeys === undefined ? undefined : list(entry.exclusiveKeys, `tasks[${index}].exclusiveKeys`, (key) => text(key, 'exclusive key', 256), 32);
    if (manifest.runId !== run.runId) fail('invalid-config', `tasks[${index}] belongs to another run`);
    if (manifest.requestedRuntime.adapter !== adapter) fail('invalid-config', `tasks[${index}] requests an adapter that is not configured`);
    // Owner-approved tool policy is validated with the same rules the supervisor applies.
    const toolPolicy = validateTools(entry.toolPolicy, manifest, role);
    const boundaryReceipt = text(entry.boundaryReceipt, `tasks[${index}].boundaryReceipt`, 1024);
    if (entry.workerPlan !== undefined && mode !== 'inert-local-fixture') fail('invalid-config', 'worker plans are only valid in inert-local-fixture mode');
    const deferred = entry.deferred === undefined ? undefined : bool(entry.deferred, `tasks[${index}].deferred`);
    if (deferred === true && role !== 'verifier') fail('invalid-config', `tasks[${index}] is deferred but is not a verifier task; only the controller-derived verifier may be admitted after execution`);
    return {
      manifest, role, ...(exclusiveKeys ? { exclusiveKeys } : {}), toolPolicy, boundaryReceipt, ...(deferred === true ? { deferred: true } : {}),
      ...(entry.workerPlan === undefined ? {} : { workerPlan: entry.workerPlan as GrantedTask['workerPlan'] }),
    } satisfies GrantedTask;
  }, 256);
  if (taskEntries.length === 0) fail('invalid-config', 'at least one owner-approved task is required');

  // [T8/S1] Fail-closed model-spend plan gate for BOUNDED legacy runs: every selection must be priceable by
  // the pinned catalog, otherwise no worst-case reservation can be bounded. An informational-accounting run
  // has no financial admission to bound, so an unpriced model is allowed there: its tokens are recorded and
  // its cost is reported as unknown, never silently as zero.
  if (run.budgets.modelAccounting !== 'informational') {
    for (const selection of [run.requestedRuntime.selection, ...taskEntries.map(entry => entry.manifest.requestedRuntime.selection)]) {
      if (!PINNED_MODEL_PRICES[modelPriceKey(selection.provider, selection.model)]) {
        fail('invalid-config', `No pinned model price for ${selection.provider}/${selection.model}; the run cannot be bounded (fail-closed)`);
      }
    }
  }

  const checkEntries = config.checks === undefined ? [] : list(config.checks, 'checks', (value, index) => {
    const entry = object(value, ['checkId', 'taskId', 'observationId', 'tool', 'input', 'kind', 'classification', 'summary', 'expectation', 'test', 'claim', 'surfaceId', 'actorId'], `checks[${index}]`);
    const taskId = text(entry.taskId, `checks[${index}].taskId`, 128);
    if (!taskEntries.some(task => task.manifest.taskId === taskId)) fail('invalid-config', `check ${String(entry.checkId)} names an unapproved task`);
    const tool = text(entry.tool, `checks[${index}].tool`, 64);
    if (!(CAPABILITIES as readonly string[]).includes(tool)) fail('invalid-config', `check ${String(entry.checkId)} uses an unknown tool capability`);
    if (entry.input === undefined) fail('invalid-config', `check ${String(entry.checkId)} requires an owner-approved input`);
    const kind = text(entry.kind, `checks[${index}].kind`, 64);
    if (!(evidenceKinds as readonly string[]).includes(kind)) fail('invalid-config', `check ${String(entry.checkId)} uses an unknown evidence kind`);
    const classification = text(entry.classification, `checks[${index}].classification`, 64);
    if (!(classifications as readonly string[]).includes(classification)) fail('invalid-config', `check ${String(entry.checkId)} uses an unknown classification`);
    let expectation: ObservationCheck['expectation'];
    if (entry.expectation !== undefined) {
      const raw = object(entry.expectation, ['type', 'status', 'bodyIncludes', 'mustMatch', 'contains'], `checks[${index}].expectation`);
      if (raw.type === 'http') {
        expectation = {
          type: 'http',
          status: integer(raw.status, `checks[${index}].expectation.status`, 100, 599),
          ...(raw.bodyIncludes === undefined ? {} : { bodyIncludes: text(raw.bodyIncludes, 'expected body fragment', 512) }),
          ...(raw.mustMatch === undefined ? {} : { mustMatch: bool(raw.mustMatch, 'expected match') }),
        };
      } else if (raw.type === 'source') {
        expectation = { type: 'source', ...(raw.contains === undefined ? {} : { contains: text(raw.contains, 'expected source fragment', 256) }) };
      } else fail('invalid-config', `check ${String(entry.checkId)} has an unsupported expectation type`);
    }
    let test: ObservationCheck['test'];
    if (entry.test !== undefined) {
      const raw = object(entry.test, ['purpose', 'invariant', 'originalPolicy', 'targetId'], `checks[${index}].test`);
      test = {
        purpose: literal(raw.purpose, 'test purpose', ['baseline', 'negative-control', 'reproduction', 'regression', 'forbidden']),
        invariant: text(raw.invariant, `checks[${index}].test.invariant`, 4096),
        ...(raw.originalPolicy === undefined ? {} : { originalPolicy: bool(raw.originalPolicy, 'original policy') }),
        ...(raw.targetId === undefined ? {} : { targetId: text(raw.targetId, 'test targetId', 128) }),
      };
    }
    return {
      checkId: text(entry.checkId, `checks[${index}].checkId`, 128),
      taskId,
      observationId: text(entry.observationId, `checks[${index}].observationId`, 128),
      tool: tool as ObservationCheck['tool'],
      input: entry.input as ObservationCheck['input'],
      kind: kind as ObservationCheck['kind'],
      classification: classification as ObservationCheck['classification'],
      summary: text(entry.summary, `checks[${index}].summary`, 2048),
      ...(expectation ? { expectation } : {}),
      ...(test ? { test } : {}),
      ...(entry.claim === undefined ? {} : { claim: text(entry.claim, `checks[${index}].claim`, 4096) }),
      ...(entry.surfaceId === undefined ? {} : { surfaceId: text(entry.surfaceId, 'check surfaceId', 128) }),
      ...(entry.actorId === undefined ? {} : { actorId: text(entry.actorId, 'check actorId', 128) }),
    } satisfies ObservationCheck;
  }, 512);
  const checkIds = new Set<string>();
  const observationKeys = new Set<string>();
  for (const check of checkEntries) {
    if (checkIds.has(check.checkId)) fail('invalid-config', `duplicate check identity ${check.checkId}`);
    checkIds.add(check.checkId);
    const key = `${check.taskId}/${check.observationId}`;
    if (observationKeys.has(key)) fail('invalid-config', `duplicate approved observation ${key}`);
    observationKeys.add(key);
  }

  const policyRaw = object(config.policy, ['version', 'runId', 'authorization', 'targets', 'exclusions', 'accounts', 'grantTemplates'], 'policy');
  if (policyRaw.version !== 1) fail('invalid-config', 'policy.version must be 1');
  if (policyRaw.runId !== run.runId) fail('invalid-config', 'policy.runId must match the approved run');
  const policyAuthorization = object(policyRaw.authorization, ['reference', 'approvedBy', 'expiresAt', 'notBefore'], 'policy.authorization');
  if (policyAuthorization.reference !== run.authorization.reference) fail('invalid-config', 'policy authorization reference must match the run authorization');
  if (policyAuthorization.approvedBy !== run.authorization.authorizedBy) fail('invalid-config', 'policy approver must match the run authorization');
  if (text(policyAuthorization.expiresAt, 'policy.authorization.expiresAt', 64) > run.authorization.expiresAt) fail('invalid-config', 'policy authorization may not outlive the run authorization');
  const grantTemplates = list(policyRaw.grantTemplates, 'policy.grantTemplates', (value, index) => {
    const template = object(value, ['id', 'taskId', 'role', 'capabilities', 'targetIds', 'actions', 'accountIds', 'expiresAt', 'maxCalls', 'maxArtifactBytes'], `policy.grantTemplates[${index}]`);
    const taskId = text(template.taskId, 'policy grant taskId', 128);
    if (!taskEntries.some(entry => entry.manifest.taskId === taskId)) fail('invalid-config', `policy grant ${String(template.id)} names an unapproved task`);
    return template as unknown as ApplicationConfig['policy']['grantTemplates'][number];
  }, 256);
  if (grantTemplates.length === 0) fail('invalid-config', 'at least one policy grant template is required');
  for (const entry of taskEntries) {
    if (!grantTemplates.some(template => template.taskId === entry.manifest.taskId)) fail('invalid-config', `task ${entry.manifest.taskId} has no policy grant template`);
  }
  const policy: ApplicationConfig['policy'] = {
    version: 1,
    runId: run.runId,
    authorization: policyAuthorization as ApplicationConfig['policy']['authorization'],
    targets: policyRaw.targets as ApplicationConfig['policy']['targets'],
    exclusions: policyRaw.exclusions as ApplicationConfig['policy']['exclusions'],
    accounts: policyRaw.accounts as ApplicationConfig['policy']['accounts'],
    grantTemplates,
  };
  // Validate the whole template through the real policy engine with a placeholder attempt binding.
  createPolicy({
    version: 1, runId: policy.runId, authorization: policy.authorization, targets: policy.targets,
    exclusions: policy.exclusions, accounts: policy.accounts,
    grants: policy.grantTemplates.map(template => ({ ...template, attemptId: 'placeholder-attempt' })),
  });

  const perTarget = config.interface === undefined ? {} : object(config.interface, ['perTargetConcurrency'], 'interface');
  const perTargetConcurrency = perTarget.perTargetConcurrency === undefined
    ? Object.fromEntries(run.authorization.targets.map(target => [target.id, 1]))
    : (() => {
      const raw = object(perTarget.perTargetConcurrency, run.authorization.targets.map(target => target.id), 'interface.perTargetConcurrency');
      const map: Record<string, number> = {};
      for (const target of run.authorization.targets) map[target.id] = integer(raw[target.id], `interface.perTargetConcurrency.${target.id}`, 1, run.budgets.maxConcurrency);
      return map;
    })();

  const reportingRaw = config.reporting === undefined ? {} : object(config.reporting, ['coverage', 'findings', 'verification'], 'reporting');
  const coverage = reportingRaw.coverage === undefined ? undefined : list(reportingRaw.coverage, 'reporting.coverage', (value, index) => {
    const entry = object(value, ['surfaceId', 'actorId', 'question', 'taskId', 'state', 'basis', 'reason'], `reporting.coverage[${index}]`);
    return {
      surfaceId: text(entry.surfaceId, 'coverage surfaceId', 128),
      actorId: text(entry.actorId, 'coverage actorId', 128),
      question: text(entry.question, 'coverage question', 4096),
      ...(entry.taskId === undefined ? {} : { taskId: text(entry.taskId, 'coverage taskId', 128) }),
      state: literal(entry.state, 'coverage state', ['tested', 'ruled-out', 'blocked', 'untested', 'not-applicable']),
      basis: literal(entry.basis, 'coverage basis', ['worker-asserted', 'runtime-observed', 'reviewer-validated']),
      reason: text(entry.reason, 'coverage reason', 1024),
    } satisfies CoveragePlanEntry;
  }, 512);
  const findings = reportingRaw.findings === undefined ? undefined : list(reportingRaw.findings, 'reporting.findings', (value, index) => {
    const entry = object(value, ['findingId', 'taskId', 'title', 'claim', 'state', 'classification', 'limitations', 'impact', 'evidenceIds', 'negativeControlEvidenceIds'], `reporting.findings[${index}]`);
    const taskId = text(entry.taskId, 'finding taskId', 128);
    if (!taskEntries.some(task => task.manifest.taskId === taskId)) fail('invalid-config', `finding ${String(entry.findingId)} names an unapproved task`);
    return {
      findingId: text(entry.findingId, 'findingId', 128),
      taskId,
      title: text(entry.title, 'finding title', 512),
      claim: text(entry.claim, 'finding claim', 4096),
      state: literal(entry.state, 'finding state', ['candidate', 'supported-static', 'reproduced', 'independently-validated', 'rejected', 'unresolved']),
      classification: literal(entry.classification, 'finding classification', ['independently-observed', 'static-inference', 'source-author-report', 'hypothesis', 'defensive-recommendation', 'unresolved']),
      limitations: list(entry.limitations, 'finding limitations', (item, i) => text(item, `finding limitations[${i}]`, 1024), 64),
      ...(entry.impact === undefined ? {} : { impact: text(entry.impact, 'finding impact', 2048) }),
      // Explicit per-claim evidence selection. Omission stays omitted: the report layer derives empty arrays,
      // never the packet's broad attribution.
      ...(entry.evidenceIds === undefined ? {} : { evidenceIds: list(entry.evidenceIds, 'finding evidenceIds', (item, i) => text(item, `finding evidenceIds[${i}]`, 128), 256) }),
      ...(entry.negativeControlEvidenceIds === undefined ? {} : { negativeControlEvidenceIds: list(entry.negativeControlEvidenceIds, 'finding negativeControlEvidenceIds', (item, i) => text(item, `finding negativeControlEvidenceIds[${i}]`, 128), 256) }),
    };
  }, 256);
  const verification = reportingRaw.verification === undefined ? undefined : list(reportingRaw.verification, 'reporting.verification', (value, index) => {
    const entry = object(value, ['verifierTaskId', 'producerTaskId', 'findingId', 'recipe', 'maxMs'], `reporting.verification[${index}]`);
    if (entry.recipe === undefined) fail('invalid-config', `reporting.verification[${index}] requires a recipe`);
    return {
      verifierTaskId: text(entry.verifierTaskId, 'verification verifierTaskId', 128),
      producerTaskId: text(entry.producerTaskId, 'verification producerTaskId', 128),
      findingId: text(entry.findingId, 'verification findingId', 128),
      recipe: entry.recipe as unknown as VerificationPlan['recipe'],
      ...(entry.maxMs === undefined ? {} : { maxMs: integer(entry.maxMs, 'verification maxMs', 1, 60_000) }),
    };
  }, 64);

  const vaultLimits = config.vaultLimits === undefined ? undefined : object(config.vaultLimits, ['maxArtifactBytes', 'maxTotalBytes', 'maxReceipts', 'maxReceiptBytes', 'maxAgeMs'], 'vaultLimits');

  // [T8/S1] Optional owner-declared worst-case bounds. The document may not declare enforcement itself:
  // enforcement is always on for a managed run (see createApplication), and unknown keys are refused.
  const spendRaw = config.spend === undefined ? undefined : object(config.spend, ['inputTokensUpperBound', 'maxOutputTokens'], 'spend');
  const spend: ApplicationSpendConfig | undefined = spendRaw === undefined ? undefined : {
    ...(spendRaw.inputTokensUpperBound === undefined ? {} : { inputTokensUpperBound: integer(spendRaw.inputTokensUpperBound, 'spend.inputTokensUpperBound', 1, 100_000_000) }),
    ...(spendRaw.maxOutputTokens === undefined ? {} : { maxOutputTokens: integer(spendRaw.maxOutputTokens, 'spend.maxOutputTokens', 1, 100_000_000) }),
  };
  // Owner-approved planner document. Its presence is the only thing that wires `p2o_plan`; an invalid planner is
  // refused here, before any run admission, and an absent/empty approval list approves nothing.
  const plannerRaw = config.planner === undefined ? undefined : object(config.planner, ['toolPolicy', 'boundaryReceipt', 'role', 'caps', 'threatModelCaps', 'planApprovals'], 'planner');
  let planner: PlannerConfig | undefined;
  if (plannerRaw) {
    const role = plannerRaw.role === undefined ? 'worker' : literal(plannerRaw.role, 'planner.role', ['worker', 'verifier', 'reporter', 'orchestrator']);
    const capsRaw = plannerRaw.caps === undefined ? undefined : object(plannerRaw.caps, ['maxTasks', 'maxDepth', 'maxObservations', 'maxRequests'], 'planner.caps');
    const threatCapsRaw = plannerRaw.threatModelCaps === undefined ? undefined : object(plannerRaw.threatModelCaps, ['maxBodyChars', 'maxAmendmentChars', 'maxAmendments'], 'planner.threatModelCaps');
    planner = {
      // Plan-materialized tasks execute target capabilities: the owner must pin a sandbox-bound extension, and
      // the synthetic capability requirement refuses a policy that grants this executor no tools at all.
      toolPolicy: (() => {
        const policy = validateTools(plannerRaw.toolPolicy, { requiredCapabilities: ['plan-task-execution'] } as TaskManifest, role);
        if (policy.mode !== 'sandbox-extension') fail('invalid-config', 'planner.toolPolicy must pin a sandbox-bound extension; a trusted fixture policy cannot execute plan tasks');
        return policy;
      })(),
      boundaryReceipt: text(plannerRaw.boundaryReceipt, 'planner.boundaryReceipt', 4096),
      role,
      ...(capsRaw === undefined ? {} : { caps: {
        maxTasks: integer(capsRaw.maxTasks, 'planner.caps.maxTasks', 1, 4096),
        maxDepth: integer(capsRaw.maxDepth, 'planner.caps.maxDepth', 0, 64),
        maxObservations: integer(capsRaw.maxObservations, 'planner.caps.maxObservations', 1, 16_384),
        maxRequests: integer(capsRaw.maxRequests, 'planner.caps.maxRequests', 1, 1_000_000),
      } }),
      ...(threatCapsRaw === undefined ? {} : { threatModelCaps: {
        maxBodyChars: integer(threatCapsRaw.maxBodyChars, 'planner.threatModelCaps.maxBodyChars', 256, 1_048_576),
        maxAmendmentChars: integer(threatCapsRaw.maxAmendmentChars, 'planner.threatModelCaps.maxAmendmentChars', 128, 262_144),
        maxAmendments: integer(threatCapsRaw.maxAmendments, 'planner.threatModelCaps.maxAmendments', 0, 4096),
      } }),
      ...(plannerRaw.planApprovals === undefined ? {} : {
        planApprovals: list(plannerRaw.planApprovals, 'planner.planApprovals', (entry: unknown) => planApprovalDocumentSchema.parse(entry), 32),
      }),
    };
  }
  return {
    schemaVersion: 1, mode, ...(config.acknowledgement === undefined ? {} : { acknowledgement: String(config.acknowledgement) }),
    roots: { state: statePath, control, workspace, vault, artifacts, workerWriteRoots },
    run, tasks: taskEntries, runtime, sandbox, policy, bridge,
    ...(checkEntries.length ? { checks: checkEntries } : {}),
    ...(config.reporting === undefined ? {} : { reporting: { ...(coverage ? { coverage } : {}), ...(findings ? { findings } : {}), ...(verification ? { verification } : {}) } }),
    interface: { perTargetConcurrency },
    ...(vaultLimits === undefined ? {} : { vaultLimits: vaultLimits as ApplicationConfig['vaultLimits'] }),
    ...(spend === undefined ? {} : { spend }),
    ...(planner === undefined ? {} : { planner }),
    ...(packs === undefined ? {} : { packs }),
  } satisfies ApplicationConfigWithSpend;
}

export function ownerGrantFor(config: ApplicationConfig): OwnerGrantDocument {
  return {
    version: 1,
    runs: [{ manifest: config.run, mode: 'managed', perTargetConcurrency: config.interface?.perTargetConcurrency ?? {} }],
    tasks: config.tasks.map(task => ({
      // parseTask normalizes the key list, so the approved proposal must carry the same normalized shape.
      proposal: { manifest: task.manifest, role: task.role, exclusiveKeys: task.exclusiveKeys ?? [] } satisfies TaskProposal,
      toolPolicy: task.toolPolicy,
      boundaryReceipt: task.boundaryReceipt,
    })),
    // Owner-authored batch approvals are held verbatim in the owner grant; the model can never add one.
    ...(config.planner?.planApprovals?.length ? { planApprovals: config.planner.planApprovals.map(document => ({ ...document })) } : {}),
  };
}

// ---------------------------------------------------------------- composition

function requireTask(config: ApplicationConfig, taskId: string): TaskManifest {
  const task = config.tasks.find(entry => entry.manifest.taskId === taskId);
  if (!task) throw new ApplicationError('task-missing', `No approved task ${taskId}`);
  return task.manifest;
}

/** Query-free plan binding derived from one owner-approved check input. The plan contract refuses URLs with a
/** query or fragment, so an HTTP check binds the owner-approved origin and the owner input stays what executes. */
function planBindingFor(input: JsonObject): JsonObject | undefined {
  const url = typeof input.url === 'string' ? input.url : undefined;
  if (url) {
    try {
      const parsed = new URL(url);
      const accountId = typeof input.accountId === 'string' ? input.accountId : undefined;
      return { url: `${parsed.origin}/`, ...(accountId ? { accountId } : {}) };
    } catch { return undefined; }
  }
  const path = typeof input.path === 'string' ? input.path
    : Array.isArray(input.paths) && typeof input.paths[0] === 'string' ? input.paths[0] : undefined;
  return path ? { path } : undefined;
}

/** Fail-closed owner cross-check: a planned binding must be covered by the owner-approved check input. */
function planBindingRefusal(ownerInput: JsonObject, binding: JsonObject): string | undefined {
  const ownerUrl = typeof ownerInput.url === 'string' ? ownerInput.url : undefined;
  const bindingUrl = typeof binding.url === 'string' ? binding.url : undefined;
  const bindingPath = typeof binding.path === 'string' ? binding.path : undefined;
  if (bindingUrl) {
    if (!ownerUrl) return 'the owner-approved check binds no URL for this observation';
    let ownerKey: string, planKey: string;
    try { ownerKey = normalizeTargetKey(new URL(ownerUrl).origin + '/'); planKey = normalizeTargetKey(bindingUrl); }
    catch { return 'the planned URL binding is not an absolute URL'; }
    if (ownerKey !== planKey) return `the planned URL binding ${planKey} is not the owner-approved origin ${ownerKey}`;
    const bindingAccount = typeof binding.accountId === 'string' ? binding.accountId : undefined;
    if (bindingAccount && bindingAccount !== ownerInput.accountId) return 'the planned account binding differs from the owner-approved account';
    return undefined;
  }
  if (bindingPath) {
    const ownerPaths = [typeof ownerInput.path === 'string' ? ownerInput.path : undefined,
      ...(Array.isArray(ownerInput.paths) ? ownerInput.paths.filter((entry): entry is string => typeof entry === 'string') : [])];
    if (!ownerPaths.includes(bindingPath)) return `the planned path binding ${bindingPath} is not an owner-approved check input path`;
    return undefined;
  }
  return 'the planned observation declares no url or path binding';
}

/** Evaluate the owner-approved expectation over the collected bytes. */
function evaluateCheck(check: ObservationCheck, data: unknown): 'passed' | 'failed' | 'inconclusive' | undefined {
  if (!check.expectation) return undefined;
  if (check.expectation.type === 'http') {
    const http = data as { kind?: unknown; status?: unknown; body?: unknown } | null;
    if (!http || http.kind !== 'http' || typeof http.status !== 'number') return 'inconclusive';
    const matched = http.status === check.expectation.status
      && (check.expectation.bodyIncludes === undefined || (typeof http.body === 'string' && http.body.includes(check.expectation.bodyIncludes)));
    return matched === (check.expectation.mustMatch !== false) ? 'passed' : 'failed';
  }
  const source = data as { kind?: unknown } | null;
  if (!source || source.kind !== 'source') return 'inconclusive';
  if (check.expectation.contains === undefined) return 'passed';
  return JSON.stringify(data).includes(check.expectation.contains) ? 'passed' : 'failed';
}

/**
 * Relative source inputs an owner-approved check will make a worker read. `source.analyze` paths are
 * resolved by the sandbox against its input root, so they are the worker's real source input surface.
 */
function sourceRelativePaths(check: ObservationCheck): string[] {
  if (check.tool !== 'source.analyze') return [];
  const input = check.input as JsonObject;
  const single = typeof input.path === 'string' ? [input.path] : [];
  const many = Array.isArray(input.paths) ? input.paths.filter((value): value is string => typeof value === 'string') : [];
  return [...single, ...many];
}

/** Why one relative worker source path cannot be served from an acquired read-only view. */
function sourcePathProblem(view: string, relativePath: string): string | undefined {
  const segments = relativePath.split('/');
  if (isAbsolute(relativePath) || relativePath.includes('\\') || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return 'is not an unambiguous relative path';
  }
  const absolute = join(view, relativePath);
  const inside = relative(view, absolute);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return 'escapes the acquired view';
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return 'is not a regular non-link file in the acquired view';
  } catch { return 'does not exist in the acquired view'; }
  return undefined;
}

/** The exact per-attempt pack instances a composition shares between broker dispatch and release. */
export interface PackInstanceSet { browser?: { close(): Promise<void> }; proxy?: { close(): Promise<void> }; container?: { close(): Promise<void> } }

/**
 * [F3] One retryable close pass over the EXACT pack instances the composition shares with dispatch. A failed
 * pass is never cached as closed: the next call closes the same instances again (each pack's own close() is
 * idempotent after success and resets on failure), and the resolved promise is retained only after every
 * owned pack has closed. A failing pack never skips the remaining resource families.
 */
export function createPackInstanceCloser(instances: () => Iterable<readonly [string, PackInstanceSet]>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      const failures: string[] = [];
      for (const [attemptId, entry] of instances()) {
        for (const name of ['browser', 'proxy', 'container'] as const) {
          const pack = entry[name];
          if (!pack) continue;
          try { await pack.close(); }
          catch (error) { failures.push(`${name}-pack ${attemptId}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
      if (failures.length) throw new Error(`Pack instance shutdown unverified: ${failures.join('; ')}`);
    })().catch(error => { closing = undefined; throw error; });
    return closing;
  };
}

export async function createApplication(configInput: ApplicationConfigWithSpend, overrides: ApplicationOverrides = {}): Promise<AssessmentApplication> {
  const config = validateApplicationConfig(configInput);
  const entryOverrides: ApplicationEntryOverrides = overrides.entry ?? {};
  const log = overrides.log ?? (() => {});
  const directories = [dirname(config.roots.state), config.roots.control, config.roots.workspace, config.roots.vault,
    ...Object.values(config.roots.artifacts), dirname(config.bridge.socketPath)];
  if (config.sandbox.mode === 'local-fixture') directories.push(config.sandbox.outputRoot);
  for (const directory of directories) mkdirSync(directory, { recursive: true, mode: 0o700 });

  const packs = config.packs ?? {};
  const browserPackEnabled = packs.browser === true;
  const proxyPackEnabled = packs.proxy === true;
  const fuzzPack = packs.fuzz;
  const packsEnabled = browserPackEnabled || proxyPackEnabled || fuzzPack !== undefined;
  const registry: CapabilityRegistry = createDefaultRegistry({ browser: browserPackEnabled, fuzz: fuzzPack !== undefined });
  /**
   * Build the configured sandbox boundary for one input root. The initial call uses the owner-document
   * root; the entry workflow may later re-root it to the acquired, digest-verified read-only view.
   */
  const buildSandbox = (inputRoot: string): ExecutionSandbox => config.sandbox.mode === 'local-fixture'
    ? createLocalFixtureSandbox({
      acknowledgement: LOCAL_FIXTURE_SANDBOX_ACKNOWLEDGEMENT,
      inputRoot,
      outputRoot: config.sandbox.outputRoot,
      trustedInputSnapshot: true,
      ...(config.sandbox.maxFileBytes === undefined ? {} : { maxFileBytes: config.sandbox.maxFileBytes }),
      ...(config.sandbox.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: config.sandbox.maxArtifactBytes }),
      ...(config.sandbox.maxArtifacts === undefined ? {} : { maxArtifacts: config.sandbox.maxArtifacts }),
    })
    : config.sandbox.mode === 'host-browser'
      // [F3] The acknowledged host browser boundary: the pinned binary identity is re-hashed at preflight and
      // containment comes from the broker gate, the CDP/egress-proxy scope checks and the session lifetime.
      ? createHostBrowserSandbox({
        inputRoot,
        outputRoot: config.sandbox.outputRoot,
        trustedInputSnapshot: true,
        ...(config.sandbox.maxFileBytes === undefined ? {} : { maxFileBytes: config.sandbox.maxFileBytes }),
        ...(config.sandbox.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: config.sandbox.maxArtifactBytes }),
        ...(config.sandbox.maxArtifacts === undefined ? {} : { maxArtifacts: config.sandbox.maxArtifacts }),
        browser: {
          acknowledgement: config.sandbox.acknowledgement,
          approvedBy: config.sandbox.approvedBy,
          expiresAt: config.sandbox.expiresAt,
          egress: config.sandbox.egress,
          profileRoot: config.sandbox.profileRoot,
          identity: config.sandbox.identity,
          ...(config.sandbox.maxSessions === undefined ? {} : { maxSessions: config.sandbox.maxSessions }),
          ...(config.sandbox.sessionTtlMs === undefined ? {} : { sessionTtlMs: config.sandbox.sessionTtlMs }),
          ...(config.sandbox.maxActionsPerSession === undefined ? {} : { maxActionsPerSession: config.sandbox.maxActionsPerSession }),
          ...(config.sandbox.maxRequestsPerSession === undefined ? {} : { maxRequestsPerSession: config.sandbox.maxRequestsPerSession }),
        },
      })
      : createContainerSandbox(config.sandbox.options as Parameters<typeof createContainerSandbox>[0]);
  const configuredInputRoot = (): string => config.sandbox.mode === 'container' ? '' : config.sandbox.inputRoot;
  let controllerContainerOwner = overrides.controllerContainerOwner;
  if (config.sandbox.mode === 'container' && !controllerContainerOwner) {
    controllerContainerOwner = await createControllerContainerOwner(config.roots.control, config.run.runId, config.sandbox.options as ContainerSandboxOptions);
  }
  if (config.sandbox.mode === 'container') {
    config.sandbox = { mode: 'container', options: { ...(config.sandbox.options as ContainerSandboxOptions), controllerLifecycle: controllerContainerOwner!.binding } };
  }
  const sandbox: ExecutionSandbox = overrides.sourceBinding?.sandbox ?? buildSandbox(configuredInputRoot());
  if (overrides.sourceBinding) {
    await overrides.sourceBinding.assertCurrent();
    for (const task of config.tasks) overrides.sourceBinding.assertEvidenceScope(task.manifest.scope);
  } else if (config.sandbox.mode === 'container') controllerContainerOwner!.attach(sandbox as SourceContainerSandbox);
  if (config.sandbox.mode !== 'container' && config.sandbox.identityDigest && sandbox.configurationDigest !== config.sandbox.identityDigest) {
    throw new ApplicationError('sandbox-identity', `Configured sandbox identity digest does not match the constructed ${config.sandbox.mode} sandbox`);
  }

  const store = openStore({ path: config.roots.state });
  const vault = openEvidenceVault({
    root: config.roots.vault,
    artifactRoots: { ...config.roots.artifacts, 'worker-workspaces': config.roots.workspace },
    workerWriteRoots: [...config.roots.workerWriteRoots, config.roots.workspace],
    ...(config.vaultLimits ? { limits: config.vaultLimits as never } : {}),
  });

  const grant: OwnerGrantDocument = ownerGrantFor(config);
  // [entry] Owner-authored approval directory: an additional, owner-only source of plan/request approval
  // documents for the target workflow. The existing owner gate still performs every binding/window/digest
  // check; this module never mints, edits or fabricates an approval (it only reads owner-authored files).
  const entryWorkspaceRoot = entryOverrides.workspaceRoot ?? join(config.roots.control, 'entry');
  const entryApprovalDirectory = entryOverrides.approvalDirectory ?? join(entryWorkspaceRoot, 'approvals');
  for (const [label, path] of [['workspaceRoot', entryWorkspaceRoot], ['approvalDirectory', entryApprovalDirectory]] as const) {
    if (!isAbsolute(path) || resolve(path) !== path) throw new ApplicationError('INTEGRATION_INVALID', `entry ${label} must be a canonical absolute path`);
  }
  // The supervisor backend re-reads the owner run document from disk on every preflight/resume and compares it
  // field-for-field with the composition's owner run. `createP2OBackend` materializes that derived document
  // (`ensureOwnerRunManifest`) under the private control root, or verifies an operator-pinned one.
  const entryManifestPath = entryOverrides.manifestPath ?? join(entryWorkspaceRoot, 'run-manifest.json');
  if (!isAbsolute(entryManifestPath) || resolve(entryManifestPath) !== entryManifestPath) throw new ApplicationError('INTEGRATION_INVALID', 'entry manifestPath must be a canonical absolute path');

  const authority: Authority & RequestApprovalAuthority = createOwnerDirectoryAuthority({
    grant, directory: entryApprovalDirectory,
    ...(overrides.clock ? { now: () => overrides.clock!.now() } : {}),
  });
  // Owner planner document: one durable ledger serves the plan port, the report coverage gate and the worker
  // threat-model bridge context. Absent, no ledger exists and p2o_plan stays closed with INTEGRATION_REQUIRED.
  // [F3/F5] The plan-port seam must never be shadowed by the ledger this composition owns: its `clock`, `caps`
  // and `threatModelCaps` are routed into the ledger here, and its `role`/`clock` also reach the port itself.
  const planPortSeamOptions: Omit<Partial<PlanPortOptions>, typeof PLAN_PORT_OWNED_KEYS[number]> = overrides.planPortOptions ?? {};
  const planLedgerCaps = planPortSeamOptions.caps ?? config.planner?.caps;
  const planLedgerThreatCaps = planPortSeamOptions.threatModelCaps ?? config.planner?.threatModelCaps;
  const planClock = planPortSeamOptions.clock ?? (overrides.clock ? () => overrides.clock!.now() : undefined);
  const planLedger: PlanLedger | undefined = config.planner ? createPlanLedger({
    controlRoot: config.roots.control, authority,
    ...(planClock ? { clock: planClock } : {}),
    ...(planLedgerCaps ? { caps: planLedgerCaps } : {}),
    ...(planLedgerThreatCaps ? { threatModelCaps: planLedgerThreatCaps } : {}),
  }) : undefined;
  if (!planLedger && Object.keys(planPortSeamOptions).length > 0) {
    throw new ApplicationError('INTEGRATION_REQUIRED', 'planPortOptions were configured but this composition has no owner planner document; the plan port would never consume them');
  }
  /** Exact owner-approved observation selection per plan-admitted task; absent means the full owner menu. */
  const planSelections = new Map<string, Set<string>>();
  // [entry] Checks registered by an owner-approved materialized plan (generated requests). They join the
  // task's observation menu beside the owner document's own checks; the owner check table is never edited.
  const entryChecks: ObservationCheck[] = [];
  /**
   * [verification] Controller-owned dynamic registries. They are populated only after a producer packet is
   * admitted and its exact per-claim collector receipts pass controller validation through the owner-authorized
   * verification program. Nothing here is built before execution, from a task question or from worker prose.
   */
  const dynamicFindingRecords = new Map<string, FindingRecord>();
  const dynamicFindingPlans: FindingPlan[] = [];
  const dynamicVerificationPlans: VerificationPlan[] = [];
  const dynamicVerifierChecks: ObservationCheck[] = [];
  const dynamicReplayPlans = new Map<string, { replay: FirstUseReplayPlan; claim: string }>();
  /** One post-admission scheduling outcome per producer task; a decision is never re-minted. */
  const verificationAdmissions = new Map<string, Record<string, unknown>>();
  let verificationInFlight: Promise<void> | undefined;
  const verificationSchedule = overrides.verificationSchedule;
  const clockIso = () => new Date(overrides.clock ? overrides.clock.now() : Date.now()).toISOString();
  /** Reporting sees the owner-document findings plus the exact post-admission controller findings. */
  const reportingFindings = (): readonly FindingPlan[] => [...(config.reporting?.findings ?? []), ...dynamicFindingPlans];
  /** Effective per-task observation menu: owner-authored checks plus registered plan-materialized checks. */
  const checkMenu = (): ObservationCheck[] => [...(config.checks ?? []), ...entryChecks, ...dynamicVerifierChecks];
  // [T2] The owner credential store is the only component allowed to answer a credential lookup; the
  // composition passes it into the interface backend and the per-attempt tool brokers.
  const credentialAuthority = overrides.credentials ? createCredentialAuthority({ store: overrides.credentials }) : undefined;
  const runtimes: Record<string, RuntimeAdapter> = { ...(overrides.runtimes ?? {}) };
  let collectorBridge: ResultCollectorBridge | undefined;
  async function collectPacketCandidates(handle: import("../runtime/types.js").RuntimeHandle) {
        // The result-collector bridge preserves worker packet bytes before the supervisor admits them.
        collectorBridge ??= createResultCollectorBridge({
          vault, store,
          packets: createWorkspacePacketSource({ root: config.roots.workspace, rootId: 'worker-workspaces' }),
          grant: attemptView => {
            const task = store.getTask(attemptView.taskId);
            if (!task) throw new ApplicationError('task-missing', `No durable task ${attemptView.taskId}`);
            return {
              collectorId: SUPERVISOR_OWNER, role: 'collector',
              runId: attemptView.runId, taskId: attemptView.taskId, attemptId: attemptView.attemptId,
              authorizationRef: config.run.authorization.reference,
              environmentId: task.scope.environmentId, configurationDigest: task.scope.configurationDigest,
              scopeDigest: scopeDigestFor(attemptView.attemptId),
              inputDigests: task.scope.inputs.map(input => input.digest),
              toolGrantId: `${attemptView.attemptId}.packet-preservation`,
              tool: controllerToolIdentity('p2o-result-bridge'),
              artifactRootIds: ['worker-workspaces'],
              allowedKinds: [PACKET_EVIDENCE_KIND],
              allowedClassifications: [PACKET_EVIDENCE_CLASSIFICATION],
              validFrom: config.run.authorization.validFrom, expiresAt: config.run.authorization.expiresAt,
              originalEnvironment: true, modifications: [],
            };
          },
        });
        return collectorBridge.collect(handle);
  }
  const supervisor: SupervisorApi = createSupervisor({
    store, authority, controlRoot: config.roots.control, workspaceRoot: config.roots.workspace, runtimes,
    ownerId: SUPERVISOR_OWNER, reviewerId: REVIEWER_ID, automatic: true,
    results: { collect: collectPacketCandidates },
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });


  /**
   * Caller-side sandbox boundary verification for the pinned extension policy. This checks the exact file
   * identity the owner approved and returns a boundary receipt string; it is not a security audit and does
   * not claim hostile-code isolation.
   */
  async function verifySandbox(policy: Extract<RuntimeToolPolicy, { mode: 'sandbox-extension' }>, request: RuntimeRequest): Promise<string | undefined> {
    if (request.runId !== config.run.runId) return undefined;
    if (config.sandbox.mode === 'local-fixture' && !config.bridge.inertLocalOnly) return undefined;
    const extension = policy.extension;
    try {
      const stat = lstatSync(extension.path);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      if (realpathSync(extension.path) !== extension.path) return undefined;
      const digest = createHash('sha256').update(readFileSync(extension.path)).digest('hex');
      if (digest !== extension.sha256) return undefined;
    } catch { return undefined; }
    if (!policy.tools.every(tool => /^p2o_[a-z0-9_]{1,32}$/.test(tool))) return undefined;
    return `${sandbox.mode}:broker-bound:${sandbox.configurationDigest.slice(0, 16)}:${extension.sha256.slice(0, 16)}`;
  }

  const runExists = Boolean(store.getRun(config.run.runId));
  const budgetJournal = supervisor.budgetJournal();
  // The durable budget journal is written at construction time, so "no durable run yet" does not imply
  // "no prior budget state": re-composing over the same roots must restore the existing counters instead
  // of claiming a fresh-run reset. The pinned limit digest still has to match exactly.
  const budgetStateExists = ((): boolean => {
    try { const prior = budgetJournal.load(config.run.runId); return prior !== undefined && prior !== null; }
    catch { return true; } // fail closed: the constructor surfaces the load failure as UNAVAILABLE
  })();
  const budgets = new TargetBudget(config.policy.targets, {
    runId: config.run.runId,
    journal: budgetJournal,
    ...(runExists || budgetStateExists ? {} : { freshRun: true }),
  });

  // [T2/T7] One controller-owned model gateway per run. The binding is an object-identity WeakMap: the
  // returned gateway object itself must be passed to the runtime (a copy would be unbound),
  // and the real upstream credential exists only inside this controller process.
  let controllerGateway: ControllerModelGateway | undefined;
  let runtimeGateway = config.runtime.gateway;
  if (overrides.upstream) {
    controllerGateway = createControllerModelGateway({
      approval: overrides.upstream.approval,
      provider: overrides.upstream.provider,
      upstreamBaseUrl: overrides.upstream.upstreamBaseUrl,
      api: overrides.upstream.api,
      models: overrides.upstream.models,
      credential: overrides.upstream.credential,
      log: overrides.upstream.log ?? (line => log('gateway', line)),
      // [T10] This composition always supplies a spend plan to the runtime, so its gateway is spend-enforcing:
      // an attempt whose spend gate is not bound is refused before the provider instead of forwarded uncharged.
      requireSpendGate: true,
    });
    await controllerGateway.listen();
    runtimeGateway = controllerGateway.gateway;
  }
  // [T3/T8/S1] Durable model spend ledger input is ALWAYS constructed from the owner-approved run manifest:
  // a managed run is never unbounded. The plan is refused here (fail-closed) when the journal cannot be
  // read or when any selection the run may request cannot be priced by the pinned catalog, rather than
  // silently dispatching without enforcement. Owner-declared bounds (`config.spend`) or a composition
  // override may pin the worst case; enforcement itself is not optional.
  const spendPlan: ModelSpendRuntimeOptions = (() => {
    if (overrides.spend?.phase) return overrides.spend.phase;
    const limits = modelAccountingPolicy(config.run.budgets);
    const journal = store.modelSpendJournal(config.run.runId);
    const priorExists = ((): boolean => {
      try { const prior = journal.load(config.run.runId); return prior !== undefined && prior !== null; }
      catch (error) {
        throw new ApplicationError('invalid-config', `Model spend journal is unavailable for run ${config.run.runId}: ${error instanceof Error ? error.message.slice(0, 256) : 'unknown error'}`);
      }
    })();
    // The price/fail-closed selection gate itself lives in validateApplicationConfig, which this composition
    // re-runs, so an unpriceable run never reaches a journal or a runtime.
    const inputTokensUpperBound = overrides.spend?.inputTokensUpperBound ?? config.spend?.inputTokensUpperBound;
    const maxOutputTokens = overrides.spend?.maxOutputTokens ?? config.spend?.maxOutputTokens;
    return {
      limits,
      journal,
      ...(runExists || priorExists ? {} : { freshRun: true }),
      ...(inputTokensUpperBound === undefined ? {} : { inputTokensUpperBound }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    } satisfies ModelSpendRuntimeOptions;
  })();
  const baseRuntimeHooks = supervisor.runtimeHooks();
  const runtimeHooks = {
    ...baseRuntimeHooks,
    async claim(handle: Parameters<typeof baseRuntimeHooks.claim>[0]) {
      if (overrides.sourceBinding) {
        await overrides.sourceBinding.assertCurrent();
        overrides.sourceBinding.assertEvidenceScope(requireTask(config, handle.taskId).scope);
      }
      const claimed = await baseRuntimeHooks.claim(handle);
      if (claimed && overrides.sourceBinding) {
        const attempt = store.getAttempt(handle.attemptId);
        if (!attempt) throw new ApplicationError('ENTRY_SOURCE_UNBOUND', 'source provenance needs the durable leased attempt before launch');
        collector.admitDocument(attempt, {
          evidenceId: `source-binding-${handle.attemptId}`, kind: 'source', classification: 'static-inference',
          summary: 'Controller-approved immutable source, actual read-only mount and qualified container identity; no execution/vulnerability claim',
          document: JSON.parse(canonicalJson(overrides.sourceBinding.evidenceDocument)) as import('../contracts/index.js').JsonValue,
          method: 'approved-source-container-binding-before-worker-launch',
          metadata: { approvedScopeDigest: overrides.sourceBinding.fingerprints.approvedScopeDigest, sourceIdentityDigest: overrides.sourceBinding.fingerprints.sourceIdentityDigest },
        });
      }
      return claimed;
    },
  };
  const runtimeSpend = { spend: spendPlan, ...(overrides.spend?.byTask ? { spendByTask: overrides.spend.byTask } : {}) };

  // Real runtime adapters are constructed after the supervisor so its hooks are attached before launch.
  if (config.runtime.adapter === 'headless') {
    runtimes.headless = createOwnedHeadlessRuntime({
      controlRoot: config.roots.control,
      piBinary: config.runtime.piBinary,
      ...(overrides.runtimePaths?.guardianPath ? { guardianPath: overrides.runtimePaths.guardianPath } : {}),
      ...(overrides.runtimePaths?.receiptExtensionPath ? { receiptExtensionPath: overrides.runtimePaths.receiptExtensionPath } : {}),
      ...(overrides.runtimePaths?.nodeBinary ? { nodeBinary: overrides.runtimePaths.nodeBinary } : {}),
      ...(config.runtime.piVersion ? { piVersion: config.runtime.piVersion } : {}),
      gateway: runtimeGateway,
      ...runtimeSpend,
      hooks: runtimeHooks,
      verifySandbox,
      ...(config.runtime.startupTimeoutMs ? { startupTimeoutMs: config.runtime.startupTimeoutMs } : {}),
      ...(config.runtime.pollMs ? { pollMs: config.runtime.pollMs } : {}),
      ...(config.runtime.stopGraceMs === undefined ? {} : { stopGraceMs: config.runtime.stopGraceMs }),
    });
  } else {
    const herdr = config.runtime.herdr;
    if (!herdr) throw new ApplicationError('invalid-config', 'herdr runtime metadata is required');
    runtimes.herdr = createHerdrRuntime({
      controlRoot: config.roots.control,
      piBinary: config.runtime.piBinary,
      gateway: runtimeGateway,
      ...runtimeSpend,
      herdrBinary: herdr.herdrBinary,
      parentPaneId: herdr.parentPaneId,
      context: herdr.context,
      ...(herdr.herdrVersion ? { herdrVersion: herdr.herdrVersion } : {}),
      hooks: runtimeHooks,
      verifySandbox,
    });
  }

  // Adapter failures are logged in bounded form; the supervisor records its own durable event.
  for (const [name, adapter] of Object.entries(runtimes)) {
    runtimes[name] = new Proxy(adapter, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || !['preflight', 'start', 'observe', 'checkpoint', 'stop', 'resume', 'collect', 'reconcile'].includes(String(property))) return value;
        return async (...args: unknown[]) => {
          try { return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args); }
          catch (error) {
            log(`adapter.${String(property)}-failed`, error instanceof Error ? error.message.slice(0, 512) : 'unknown error');
            throw error;
          }
        };
      },
    });
  }

  // -----------------------------------------------------------------------------------------------
  // [F3] Pack session lifetime. The composition owns the browser/proxy pack instances and hands the SAME
  // instances to the per-attempt broker and to the runtime's release hooks, so an attempt's pack sessions
  // are released by the runtime's own terminal paths (completion, stop, cancellation, deadline, quarantine,
  // crash recovery) and by `application.close()`. A pack session can only be created or driven while the
  // attempt is live under an open runtime session lease (`packFence`), so a released attempt can never mint
  // a new session or drive a stale one.
  // -----------------------------------------------------------------------------------------------
  const sessionRuntime = runtimes[config.runtime.adapter] as unknown as {
    sessions?: SessionReleaseRegistry;
    registerSessionReleaser?: (releaser: SessionReleaser) => void;
  } | undefined;
  interface AttemptPackInstances { browser?: BrowserPack; proxy?: ProxyPack; container?: SourceContainerSandbox }
  /** Exact pack/container objects shared by broker dispatch and runtime release. */
  const attemptPackInstances = new Map<string, AttemptPackInstances>();
  function packsFor(attemptId: string): AttemptPackInstances {
    const cached = attemptPackInstances.get(attemptId);
    if (cached) return cached;
    const policy = policyFor(attemptId);
    const created: AttemptPackInstances = {};
    const attempt = store.getAttempt(attemptId);
    if (!attempt || !sessionRuntime?.sessions) throw new ApplicationError('INTEGRATION_REQUIRED', 'pack construction needs its stored attempt and durable session registry');
    const scope = { runId: attempt.runId, taskId: attempt.taskId, attemptId };
    const token = attemptOwnerToken(config.roots.control, scope.runId, attemptId);
    if (config.sandbox.mode === 'container') {
      created.container = createContainerSandbox({
        ...(config.sandbox.options as ContainerSandboxOptions),
        lifecycle: { scope, lifecycle: sessionRuntime.sessions.binding(scope, token, 'container-pack') },
      });
      // Attempt sandboxes can perform controller-scoped preflight; their exact instances must be
      // attributable to both lifecycles, not just the source binding/probe instances.
      controllerContainerOwner!.attach(created.container);
    }
    const attemptSandbox = created.container ?? sandbox;
    if (proxyPackEnabled) created.proxy = createProxyPack({
      policy, budgets, sandbox: attemptSandbox, lifecycle: sessionRuntime.sessions.binding(scope, token, 'proxy-pack'),
      ...(overrides.resolver ? { resolver: overrides.resolver } : {}),
    });
    if (browserPackEnabled) created.browser = createBrowserPack({
      policy, budgets, sandbox: attemptSandbox, resolver: overrides.resolver ?? defaultResolver,
      lifecycle: sessionRuntime.sessions.binding(scope, token, 'browser-pack'),
      // The capture gate of this attempt's proxy pack records the page traffic of this attempt's browser.
      ...(created.proxy ? { egressProxy: created.proxy.egressProxy } : {}),
    });
    attemptPackInstances.set(attemptId, created);
    return created;
  }
  // Registered as the shutdown hook of every pack releaser: idempotent after success, retryable after a
  // failure, and always over the same map of exact instances the broker dispatched to.
  const closePackInstances = createPackInstanceCloser(() => attemptPackInstances);
  /**
   * [F3] A release receipt must name the packs that were asked. The composition therefore declares its own
   * pack set: one releaser per session-owning pack it enables, or - when it enables none - the explicit
   * `no-session-owning-packs` declaration. The runtime never reports a verified release over an empty releaser
   * set, so a composition that forgot to register its packs cannot mint a clean verdict, and the shipped
   * composition declares its pack set instead of leaving the verdict unprovable.
   */
  if (!sessionRuntime?.registerSessionReleaser) {
    throw new ApplicationError('INTEGRATION_REQUIRED', `The configured ${config.runtime.adapter} runtime exposes no session registry; no pack release could ever be proved, so the composition refuses to start`);
  }
  if (!sessionRuntime.sessions) throw new ApplicationError('INTEGRATION_REQUIRED', 'runtime has no durable pack session registry');
  const sessionRegistry = sessionRuntime.sessions;
  if (browserPackEnabled) registerPackSessionFamily(sessionRegistry, {
    name: 'browser-pack', lookup: scope => attemptPackInstances.get(scope.attemptId)?.browser,
    recover: (resources, scope, owner) => {
      if (config.sandbox.mode !== 'host-browser') throw new ApplicationError('INTEGRATION_REQUIRED', 'browser recovery requires its exact canonical profile root');
      return recoverBrowserResources(resources, scope, owner, config.sandbox.profileRoot);
    },
    shutdown: closePackInstances,
  });
  if (proxyPackEnabled) registerPackSessionFamily(sessionRegistry, {
    name: 'proxy-pack', lookup: scope => attemptPackInstances.get(scope.attemptId)?.proxy,
    recover: recoverControllerListeners, shutdown: closePackInstances,
  });
  if (config.sandbox.mode === 'container') registerPackSessionFamily(sessionRegistry, {
    name: 'container-pack', lookup: scope => attemptPackInstances.get(scope.attemptId)?.container,
    recover: (resources, scope, owner) => recoverContainerResources(resources, scope, owner, (config.sandbox as Extract<ApplicationConfig['sandbox'], { mode: 'container' }>).options as ContainerSandboxOptions),
    shutdown: closePackInstances,
  });
  if (!browserPackEnabled && !proxyPackEnabled && config.sandbox.mode !== 'container') sessionRuntime.registerSessionReleaser({
    name: 'no-session-owning-packs', ownsNoResources: true, release: async () => 0, outstanding: () => 0, shutdown: closePackInstances,
  });
  /**
   * [F3] Attempt-liveness fence for pack sessions, consulted by the broker before any capability that can
   * create or drive a `browser.*`/`proxy.*` session. The durable attempt must be live, its controller-private
   * runtime handle must exist, and the runtime's own session lease must still be open for that exact token.
   */
  const packFence: PackSessionFence = {
    async check(context, capability) {
      // A session-owning capability is only dispatchable when this composition owns the pack family that would
      // release its session. `proxy.*` is provisioned by the default registry, so an owner grant alone could
      // otherwise create a session that no registered releaser can account for.
      const family = capability.startsWith('browser.') ? 'browser' : capability.startsWith('proxy.') ? 'capture' : undefined;
      if (family === 'browser' && !browserPackEnabled) {
        throw new PolicyError('CAPABILITY_DENIED', `${capability} refused: this composition enables no browser pack, so a session it did not create could never be released`);
      }
      if (family === 'capture' && !proxyPackEnabled) {
        throw new PolicyError('CAPABILITY_DENIED', `${capability} refused: this composition enables no capture pack, so a session it did not create could never be released`);
      }
      const attempt = store.getAttempt(context.attemptId);
      if (!attempt || attempt.runId !== config.run.runId || attempt.taskId !== context.taskId) {
        throw new PolicyError('CAPABILITY_DENIED', `${capability} refused: no live attempt ${context.attemptId} of task ${context.taskId} exists in this run`);
      }
      const run = store.getRun(config.run.runId);
      if (!run || INACTIVE_RUN_STATES.has(run.state)) throw new PolicyError('CAPABILITY_DENIED', `${capability} refused: run ${config.run.runId} is no longer active`);
      if (TERMINAL_ATTEMPT_STATES.has(attempt.lifecycleState)) throw new PolicyError('CAPABILITY_DENIED', `${capability} refused: attempt ${context.attemptId} is ${attempt.lifecycleState}`);
      if (Date.now() >= Date.parse(attempt.deadlineAt)) throw new PolicyError('CAPABILITY_DENIED', `${capability} refused: attempt ${context.attemptId} exhausted its deadline`);
      const ownerToken = attemptOwnerToken(config.roots.control, config.run.runId, context.attemptId);
      try { await sessionRuntime!.sessions!.assertOpen({ runId: config.run.runId, taskId: context.taskId, attemptId: context.attemptId }, ownerToken); }
      catch (error) {
        throw new PolicyError('CAPABILITY_DENIED', `${capability} refused: ${error instanceof Error ? error.message.slice(0, 200) : 'the attempt holds no open session lease'}`);
      }
    },
  };

  const policies = new Map<string, Policy>();
  const brokers = new Map<string, ToolBroker>();
  function grantTemplate(taskId: string) {
    const template = config.policy.grantTemplates.find(candidate => candidate.taskId === taskId);
    if (!template) throw new ApplicationError('policy-grant', `No approved policy grant for task ${taskId}`);
    return template;
  }
  /**
   * The exact broker scope an attempt's policy is built from. The collector scope digest and any
   * controller-issued verification capability are derived from this same object, so a receipt's collector
   * digest always equals the capability's scope digest.
   */
  function brokerScope(attemptId: string): Scope {
    const attempt = store.getAttempt(attemptId);
    if (!attempt) throw new ApplicationError('attempt-missing', `No durable attempt ${attemptId}`);
    const template = grantTemplate(attempt.taskId);
    return {
      version: 1, runId: config.policy.runId, authorization: config.policy.authorization,
      targets: config.policy.targets, exclusions: config.policy.exclusions, accounts: config.policy.accounts,
      grants: [{ ...template, attemptId }],
    };
  }
  function policyFor(attemptId: string): Policy {
    const cached = policies.get(attemptId);
    if (cached) return cached;
    const policy = createPolicy(brokerScope(attemptId));
    policies.set(attemptId, policy);
    return policy;
  }
  function brokerFor(attemptId: string): ToolBroker {
    const cached = brokers.get(attemptId);
    if (cached) return cached;
    const policy = policyFor(attemptId);
    const attempt = store.getAttempt(attemptId);
    if (!attempt) throw new ApplicationError('attempt-missing', `No durable attempt ${attemptId}`);
    // [T2] Credential-tier accounts: the broker never sees a secret; it asks the credential-owning boundary
    // for the single-use headers of the approved account/target/action of the *policy decision*.
    const credentialProvider: CredentialProvider | undefined = credentialAuthority
      ? {
          async headers(input) {
            const decision = policy.authorize({
              context: { runId: attempt.runId, taskId: attempt.taskId, attemptId, grantId: grantTemplate(attempt.taskId).id },
              capability: 'http.request', action: input.action, url: input.origin, accountId: input.accountId,
            } as Parameters<Policy['authorize']>[0]);
            const resolved = await credentialAuthority.resolveAtDispatch(decision, new Date().toISOString());
            return resolved.headers();
          },
        }
      : undefined;
    // [F3] The attempt's own pack instances (the same objects the runtime releases) plus the attempt
    // liveness fence. Without packs neither option is passed and the broker keeps its own defaults.
    const packInstances = packsEnabled || config.sandbox.mode === 'container' ? packsFor(attemptId) : undefined;
    const broker = createToolBroker({
      policy, budgets, sandbox: packInstances?.container ?? sandbox, registry,
      ...(packInstances?.browser ? { browser: packInstances.browser } : {}),
      ...(packInstances?.proxy ? { proxy: packInstances.proxy } : {}),
      ...(fuzzPack ? { fuzz: fuzzPack } : {}),
      sessionFence: packFence,
      ...(overrides.resolver ? { resolver: overrides.resolver } : {}),
      ...(credentialProvider ? { credentials: credentialProvider } : {}),
      ...(overrides.secrets ? { secrets: overrides.secrets } : {}),
    });
    brokers.set(attemptId, broker);
    return broker;
  }
  const scopeDigestFor = (attemptId: string): string => policyFor(attemptId).digest;

  const collector: CollectorBridge = createCollectorBridge({
    vault, store,
    controllerArtifactRootId: config.bridge.controllerArtifactRootId,
    controllerArtifactRoot: config.roots.artifacts[config.bridge.controllerArtifactRootId]!,
    controllerTool: controllerToolIdentity('p2o-application'),
    attempt: attemptId => store.getAttempt(attemptId),
    task: taskId => store.getTask(taskId),
    scopeDigest: scopeDigestFor,
    grantIdFor: taskId => grantTemplate(taskId).id,
  });

  // Deterministic fixture plans and bridge discovery are written before any worker launch.
  for (const task of config.tasks) {
    const workspace = task.manifest.workspace;
    if (workspace !== join(config.roots.workspace, task.manifest.taskId)) {
      throw new ApplicationError('workspace', `Task workspace must be ${join(config.roots.workspace, task.manifest.taskId)}`);
    }
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, 'p2o-bridge.json'), `${JSON.stringify({ socketPath: config.bridge.socketPath, taskId: task.manifest.taskId })}\n`, { mode: 0o600 });
    if (task.workerPlan) {
      writeFileSync(join(workspace, 'worker-plan.json'), `${JSON.stringify({ taskIdHint: task.manifest.taskId, ...task.workerPlan })}\n`, { mode: 0o600 });
    }
  }

  const findingReviewCache = new Map<string, FindingReview>();
  function recordFindingReview(review: FindingReview): void {
    if (review.finding) findingReviewCache.set(review.finding.findingId, review);
  }
  function latestFindingReview(findingId: string): FindingReview | undefined {
    return findingReviewCache.get(findingId);
  }
  function producerFindings(): Map<string, FindingRecord> {
    const findings = new Map<string, FindingRecord>();
    for (const plan of reportingFindings()) {
      // The controller-registered dynamic record carries the exact per-claim receipts from the admitted packet;
      // it is never re-derived from the packet's broad attribution.
      const exact = dynamicFindingRecords.get(plan.findingId);
      if (exact) { findings.set(plan.findingId, exact); continue; }
      const packet = acceptedPacket(store, config.run.runId, plan.taskId);
      // The vault lets the report layer select only packet receipts whose authenticated claim digest/invariant
      // matches `plan.claim` for legacy owner-document plans; without it the arrays stay empty instead of
      // falling back to broad packet attribution.
      if (packet) findings.set(plan.findingId, producerFinding(plan, packet, config.run.runId, vault));
    }
    return findings;
  }

  const httpDescriptor = registry.get('http.request');
  const verificationServices: VerificationServices = {
    vault, store, collector,
    attempt: attemptId => store.getAttempt(attemptId),
    task: taskId => store.getTask(taskId),
    brokerFor: attempt => brokerFor(attempt.attemptId),
    verifierCollectorId: VERIFIER_COLLECTOR,
    grantIdFor: taskId => grantTemplate(taskId).id,
    artifactRootId: config.bridge.brokerArtifactRootId,
    httpTool: { name: 'http.request', version: httpDescriptor.version, implementationDigest: httpDescriptor.implementationDigest },
  };
  /**
   * [verification] Controller-owned replay environment for the owner-authorized verification program. A
   * plan is registered only after the admitted packet's exact per-claim receipts were validated, and the
   * capability is issued here from the ACTUAL verifier attempt's broker scope, never copied from the producer
   * grant. The normal scoped broker, DNS/CIDR/TLS checks and shared budgets remain the only transport.
   */
  const dynamicReplayFactory: CleanReplayEnvironmentFactory = services => ({
    async prepare(request) {
      const registered = dynamicReplayPlans.get(request.task.taskId);
      if (!registered) throw new ApplicationError('unapproved-verification', `No controller-registered replay plan exists for task ${request.task.taskId}`);
      const verificationPolicy = createScopedVerificationPolicy(config.run, brokerScope(request.attempt.attemptId), () => Date.parse(clockIso()));
      return createFirstUseReplayEnvironment(services, { verificationPolicy, replay: registered.replay, claim: registered.claim, now: clockIso }).prepare(request);
    },
  });
  const rawVerifier = createIndependentVerifier({
    ...verificationServices,
    authorization: config.run.authorization,
    reviewerId: REVIEWER_ID,
    producerFinding: findingId => producerFindings().get(findingId),
    tick: async () => { await supervisor.tick(config.run.runId); },
    replay: bindControllerVerificationPolicy({ run: config.run, scopeFor: brokerScope, now: () => Date.parse(clockIso()) })(
      (overrides.replayEnvironment ?? (verificationSchedule ? dynamicReplayFactory : undefined))?.(verificationServices)
        ?? { async prepare() { throw new ApplicationError('INTEGRATION_REQUIRED', 'No clean replay environment factory is configured for this composition'); } },
    ),
  });
  const verifier: AssessmentApplication['verifier'] = Object.freeze({
    producerReview: (findingId: string) => {
      const review = rawVerifier.producerReview(findingId);
      if (!findingReviewCache.has(findingId)) findingReviewCache.set(findingId, review);
      return review;
    },
    async verify(input: Parameters<AssessmentApplication['verifier']['verify']>[0]) {
      const outcome = await rawVerifier.verify(input);
      recordFindingReview(outcome.review);
      return outcome;
    },
  });

  /** Write the one durable post-admission scheduling decision for one producer task. */
  function writeVerificationAdmission(record: Record<string, unknown>): void {
    try {
      const directory = join(config.roots.control, 'verification');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, 'admission.json'), `${canonicalJson(record)}\n`, { mode: 0o600 });
    } catch (error) {
      log('verification.record-failed', error instanceof Error ? error.message.slice(0, 240) : 'admission record unavailable');
    }
  }

  /**
   * [verification] The only path from an admitted producer packet to a verifier attempt. It never runs before
   * the packet is durable, never uses the task question as a claim, never widens the owner-approved checks and
   * never mints a target reset: it re-derives the owner-authorized program, selects the exact per-claim
   * collector receipts, re-validates them through the producer's actual broker scope, and only then admits the
   * pre-authorized deferred verifier task inside the SAME run so the supervisor schedules it normally.
   */
  async function scheduleAcceptedVerification(): Promise<void> {
    const schedule = verificationSchedule;
    if (!schedule) return;
    if (verificationAdmissions.has(schedule.producerTaskId)) return;
    const task = store.getTask(schedule.producerTaskId) ?? requireTask(config, schedule.producerTaskId);
    // Producer packet admission is the gate: no admitted result, no verifier identity.
    const result = acceptedResult(store, config.run.runId, schedule.producerTaskId);
    if (!result || result.decision.status !== 'accepted') return;
    const packet = result.packet;
    const base = {
      version: 1, runId: config.run.runId, producerTaskId: schedule.producerTaskId, producerAttemptId: packet.attemptId,
      resultId: result.resultId, packetId: packet.packetId, verifierTaskId: schedule.verifierTaskId,
      derivedAt: schedule.derivedAt, scheduledAt: clockIso(),
    };
    const decide = (record: Record<string, unknown>, event: string, detail: string): void => {
      verificationAdmissions.set(schedule.producerTaskId, record);
      writeVerificationAdmission(record);
      try { store.appendEvent({ runId: config.run.runId, type: event, payload: { ...record } as JsonObject }); } catch { /* the control record is authoritative */ }
      log(event, detail.slice(0, 300));
    };
    const refuse = (reason: string): void => decide({ ...base, phase: 'candidate-refused', reason }, 'entry.verification-refused', reason);
    // 1. The owner-authorized program, re-derived from the same approved checks and the same derivation time.
    const checks = checkMenu().filter(check => check.taskId === schedule.producerTaskId);
    const planned = deriveFirstUseVerificationPlan({
      run: config.run, producerTask: task, targetId: schedule.targetId, targetLocator: schedule.targetLocator,
      checks, workspaceRoot: config.roots.workspace, verifierBudget: schedule.budget, now: clockIso(), verifierTaskCreatedAt: schedule.derivedAt,
    });
    if (!planned.supported) return refuse(`controller derivation no longer supports this plan: ${planned.reason}`);
    const draft = planned.draft;
    const preauthorized = config.tasks.find(entry => entry.manifest.taskId === schedule.verifierTaskId);
    if (!preauthorized || preauthorized.deferred !== true || preauthorized.role !== 'verifier') return refuse('the controller-derived verifier task is not an owner-authorized deferred verifier task');
    if (digestJson(preauthorized.manifest) !== digestJson(draft.verifierTask)) return refuse('the controller-derived verifier manifest no longer matches the owner-authorized deferred task');
    // 2. Exact per-claim receipts: the program's own baseline/control/reproduction checks, never packet-wide attribution.
    const baselineCheck = draft.enrichedChecks.find(check => check.taskId === schedule.producerTaskId && check.kind === 'observation'
      && digestJson(check.input) === digestJson(draft.verifierCheck.input));
    const controlCheck = draft.enrichedChecks.find(check => check.kind === 'negative-control');
    const reproductionCheck = draft.enrichedChecks.find(check => check.kind === 'reproduction');
    if (!baselineCheck || !controlCheck || !reproductionCheck) return refuse('the controller program no longer names an exact baseline/control/reproduction check');
    const selection = selectReceiptBoundProducerCandidate({
      vault, packet, task, findingId: draft.finding.findingId, claim: draft.finding.claim, baselineCheck, controlCheck, reproductionCheck,
    });
    if (!selection.ok) return refuse(selection.reason);
    // 3. Synthesis re-validates the candidate against the producer's actual broker scope and the approved checks.
    const verificationPolicy = createScopedVerificationPolicy(config.run, brokerScope(packet.attemptId), () => Date.parse(clockIso()));
    const policyContext = { runId: config.run.runId, taskId: task.taskId, attemptId: packet.attemptId, grantId: grantTemplate(task.taskId).id };
    const synthesis = synthesizeFirstUseVerification({
      candidate: selection.candidate, vault, verificationPolicy, policyContext,
      run: config.run, producerTask: task, targetId: schedule.targetId, targetLocator: schedule.targetLocator,
      checks, workspaceRoot: config.roots.workspace, verifierBudget: schedule.budget, now: clockIso(), verifierTaskCreatedAt: schedule.derivedAt,
    });
    if (!synthesis.supported) return refuse(synthesis.reason);
    const leg = synthesis.leg;
    if (digestJson(leg.verifierTask) !== digestJson(preauthorized.manifest)) return refuse('the synthesized verifier manifest differs from the owner-authorized identity');
    // 4. Register the dynamic finding/plan/check and admit the deferred verifier task in the same run.
    dynamicFindingRecords.set(leg.finding.findingId, leg.candidate);
    dynamicFindingPlans.push(leg.finding);
    dynamicVerificationPlans.push(leg.verification);
    dynamicVerifierChecks.push(leg.verifierCheck);
    dynamicReplayPlans.set(leg.verifierTask.taskId, { replay: leg.replay, claim: leg.finding.claim });
    try { verifier.producerReview(leg.finding.findingId); } catch (error) { log('verification.producer-review-failed', error instanceof Error ? error.message.slice(0, 200) : 'unavailable'); }
    const admitted = {
      ...base, phase: 'admitted', findingId: leg.finding.findingId, claimDigest: digestJson(leg.finding.claim),
      verifierManifestDigest: digestJson(leg.verifierTask), controlEvidenceId: selection.evidence.negativeControl,
      reproductionEvidenceId: selection.evidence.reproduction, baselineEvidenceId: selection.evidence.baseline,
      protected: { phase: 'verifier', limits: schedule.budget, policy: 'isolated-phase-caps-no-borrowing' },
      candidateClass: leg.replay.supportedClass,
    };
    try {
      await supervisor.admitTask({ manifest: leg.verifierTask, role: 'verifier', exclusiveKeys: [] });
    } catch (error) {
      const reason = `controller-owned verifier admission failed: ${error instanceof Error ? error.message.slice(0, 240) : 'unknown'}`;
      return decide({ ...admitted, phase: 'admission-failed', reason }, 'entry.verification-admission-failed', reason);
    }
    decide(admitted, 'entry.verification-admitted', `${leg.verifierTask.taskId} finding=${leg.finding.findingId} reproduction=${selection.evidence.reproduction}`);
    // Schedule inside the same run; the pump remains the only launcher.
    void supervisor.tick(config.run.runId).catch(error => log('verification.tick-failed', error instanceof Error ? error.message.slice(0, 200) : 'unknown'));
  }

  /** Idempotent trigger used only after real packet admission; failures never become an accepted false claim. */
  function triggerVerificationScheduling(): Promise<void> {
    verificationInFlight ??= scheduleAcceptedVerification().catch(error => {
      log('verification.schedule-failed', error instanceof Error ? error.message.slice(0, 240) : 'unknown');
    }).finally(() => { verificationInFlight = undefined; });
    return verificationInFlight;
  }

  const queues = new Map<string, Promise<void>>();
  function approvedCheck(taskId: string, observationId: string): ObservationCheck {
    // A plan-admitted task can only select the observations the owner-approved plan enumerated; an owner-admitted
    // task keeps its full owner-approved menu.
    const selected = planSelections.get(taskId);
    if (selected && !selected.has(observationId)) {
      throw new ApplicationError('unapproved-observation', `Observation ${observationId} is not in the owner-approved plan selection for task ${taskId}`);
    }
    const check = checkMenu().find(candidate => candidate.taskId === taskId && candidate.observationId === observationId);
    if (!check) throw new ApplicationError('unapproved-observation', `No owner-approved check for ${taskId}/${observationId}`);
    return check;
  }
  function approvedVerification(taskId: string, findingId: string): VerificationPlan {
    const plan = [...(config.reporting?.verification ?? []), ...dynamicVerificationPlans].find(candidate => candidate.verifierTaskId === taskId && candidate.findingId === findingId);
    if (!plan) throw new ApplicationError('unapproved-verification', `No owner-approved verification plan for ${taskId}/${findingId}`);
    return plan;
  }
  const bridgeOperations: WorkerBridgeOperations = {
    async execute(attempt, payload, signal) {
      if (overrides.sourceBinding) {
        await overrides.sourceBinding.assertCurrent(signal);
        overrides.sourceBinding.assertEvidenceScope(requireTask(config, attempt.taskId).scope);
      }
      const call = parseObservationSelection(payload);
      const check = approvedCheck(attempt.taskId, call.observationId);
      const policy = policyFor(attempt.attemptId);
      const context = { runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, grantId: grantTemplate(attempt.taskId).id };
      const input = check.input as { url?: string; method?: string; accountId?: string };
      const offline = check.tool === 'source.analyze' || check.tool === 'native.inspect';
      const action = check.tool === 'source.analyze' ? 'analyze' : check.tool === 'native.inspect' ? 'native' : 'read';
      if (signal.aborted) throw new ApplicationError('cancelled', 'Bridge request was aborted before dispatch');
      let targetId: string | undefined;
      try {
        const decision = policy.authorize({
          context, capability: check.tool, action,
          ...(input.url ? { url: input.url } : {}), ...(input.method ? { method: input.method } : {}), ...(input.accountId ? { accountId: input.accountId } : {}),
        } as Parameters<Policy['authorize']>[0]);
        targetId = decision.target?.id;
      } catch { /* the broker produces the immutable denial receipt below; a pre-dispatch refusal is released there */ }
      // Absolute run/task/target limits are charged BEFORE any dispatch, including calls that fail, are denied,
      // or redirect: the store rejects the attempt/task/run overage first, and the broker reserves the
      // target-wide request/rate/concurrency budget before the connection is created. A destination denial
      // resolves no target, and the store refuses an unscoped request count, so the attempted request is
      // attributed to the first owner-approved network target in the task scope.
      const budgetTargetId = targetId ?? (offline ? undefined : config.policy.targets.find(candidate => requireTask(config, attempt.taskId).scope.targetIds.includes(candidate.id))?.id);
      // One durable reservation per bridge call: its identity is the only handle that can release this
      // charge, so a replay can never refund another call's charge.
      const reservation = supervisor.reserveBudget(attempt.attemptId, {
        toolCalls: 1,
        ...(offline ? {} : { requests: 1 }),
        ...(budgetTargetId ? { targetId: budgetTargetId } : {}),
      });
      let result;
      try {
        result = await brokerFor(attempt.attemptId).execute({ context, tool: check.tool, input: check.input, signal });
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'broker-error';
        const detail = error instanceof Error ? error.message.slice(0, 240) : 'unknown error';
        log('entry.broker-refused', `${check.tool} ${code}: ${detail}`);
        // Reservation-before-dispatch is preserved (an exhausted budget refuses without traffic). A refusal that
        // never dispatched gives the reservation back so it cannot exhaust a task that collected nothing.
        if (isPreDispatchRefusal(error)) {
          try {
            supervisor.releaseBudget(attempt.attemptId, { reservationId: reservation.reservationId, reason: `pre-dispatch refusal (${code})`, refusal: { code } });
          } catch (releaseError) {
            // A failed release must never mask the refusal; the durable counters stay visible.
            log('entry.broker-release-failed', `${check.tool} ${code}: ${releaseError instanceof Error ? releaseError.message.slice(0, 120) : 'unknown'}`);
          }
        }
        throw new ApplicationError(code, `${check.tool} failed: ${detail}`);
      }
      // No late side effects: an aborted request must not mint evidence after cancellation/close/deadline.
      if (signal.aborted) throw new ApplicationError('cancelled', 'Bridge request was aborted during dispatch; refusing to admit evidence');
      const outcome = evaluateCheck(check, result.data);
      const receipt = collector.admitBroker(attempt, {
        result, operationInput: check.input, artifactRootId: config.bridge.brokerArtifactRootId,
        // A verifier-role attempt's baseline receipts must be attributed to the verifier capability itself;
        // the qualification gate refuses a collector-role receipt.
        ...(grantTemplate(attempt.taskId).role === 'verifier' ? { role: 'verifier' as const, collectorId: attempt.ownerId } : {}),
        evidence: {
          // Controller-derived identity and content: attempt-scoped, from the owner-approved check only.
          evidenceId: `${check.checkId}-${attempt.attemptId}`,
          kind: check.kind,
          classification: check.classification,
          summary: check.summary,
          ...(check.test ? {
            test: {
              purpose: check.test.purpose,
              outcome: outcome === 'inconclusive' ? 'inconclusive' : outcome ?? 'inconclusive',
              successes: outcome === 'passed' ? 1 : 0,
              attempts: 1,
              invariant: check.test.invariant,
              originalPolicy: check.test.originalPolicy !== false,
              ...(check.test.targetId ? { targetId: check.test.targetId } : {}),
            },
          } : {}),
          metadata: {
            checkId: check.checkId,
            observationId: check.observationId,
            ...(check.test ?? check.claim ? { claimDigest: digestJson(check.test?.invariant ?? check.claim!) } : {}),
            ...(check.surfaceId ? { surfaceId: check.surfaceId } : {}),
            ...(check.actorId ? { actorId: check.actorId } : {}),
          },
        },
      });
      const hops = (result.data as { hops?: Array<{ responseBytes?: number }> }).hops ?? [];
      const bytes = hops.reduce((sum, hop) => sum + (Number(hop.responseBytes) || 0), 0);
      if (Number.isSafeInteger(bytes) && bytes > 0) supervisor.consumeBudget(attempt.attemptId, { bytes, ...(targetId ? { targetId } : {}) });
      return { evidenceId: receipt.evidenceId, kind: receipt.kind, ...(outcome ? { outcome } : {}), data: result.data };
    },
    async acceptedInputs(attempt) {
      const accepted = supervisor.worker(attempt.attemptId).acceptedInputs();
      return accepted.map(packet => ({ taskId: packet.taskId, packetId: packet.packetId, contract: packet.contract, outcome: packet.outcome }));
    },
    async admitPacket(attempt) {
      // reserve + collect + submit + safe feedback all run behind authenticated bridge serialization.
      const admission = await admitAuthenticatedPacket({ attempt, store, now: clockIso,
        async collect() {
          const handle = JSON.parse(readFileSync(join(config.roots.control, "handles", `${attempt.attemptId}.json`), "utf8")) as import("../runtime/types.js").RuntimeHandle;
          if (handle.attemptId !== attempt.attemptId || handle.runId !== attempt.runId) throw new ApplicationError('packet-identity', 'Controller handle differs from authenticated attempt');
          return collectPacketCandidates(handle);
        },
        submit: candidate => supervisor.worker(attempt.attemptId).submit(candidate),
      });
      if (admission.accepted) await triggerVerificationScheduling();
      return admission;
    },
    async attemptState(attempt) {
      // The durable admitted manifest is authoritative: a plan-materialized task carries the approved plan's
      // exact question/scope/input revision, which is what the packet gate echoes. The owner document is only a
      // fallback before admission.
      const task = store.getTask(attempt.taskId) ?? requireTask(config, attempt.taskId);
      return {
        runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, ownerId: attempt.ownerId,
        sequence: attempt.sequence, lifecycleState: attempt.lifecycleState,
        controllerNow: clockIso(), deadlineAt: attempt.deadlineAt,
        packetAuthoring: packetAuthoringFor(task, attempt, clockIso(), grantTemplate(attempt.taskId).role === 'verifier' ? 'verifier' : 'worker'),
        packetRejections: store.packetRejectionCount(attempt.runId, attempt.attemptId),
        requestedRuntime: attempt.requestedRuntime, observedRuntime: attempt.observedRuntime ?? null,
        scope: task.scope, question: task.question, inputRevision: task.inputRevision,
        allowedActions: task.allowedActions, skills: task.skills,
        // Owner-approved observation menu for this task, narrowed to the owner-approved plan selection when the
        // task was admitted through a plan. `expectation` and `test` are deliberately excluded: they encode
        // expected outcomes and must never reach a worker.
        observations: checkMenu().filter(check => check.taskId === attempt.taskId
          && (!planSelections.has(attempt.taskId) || planSelections.get(attempt.taskId)!.has(check.observationId))).map(check => ({
          observationId: check.observationId, tool: check.tool, kind: check.kind, classification: check.classification, summary: check.summary,
          ...(check.surfaceId ? { surfaceId: check.surfaceId } : {}),
          ...(check.actorId ? { actorId: check.actorId } : {}),
          ...(check.claim ? { claim: check.claim } : {}),
        })),
      };
    },
    async verify(attempt, payload, signal) {
      // The worker selects a finding; the recipe, the deadline and the reviewer identity come from the owner plan.
      const request = object(payload, ['findingId'], 'verification request');
      const plan = approvedVerification(attempt.taskId, text(request.findingId, 'findingId', 128));
      if (signal.aborted) throw new ApplicationError('cancelled', 'Bridge request was aborted before replay');
      const outcome = await verifier.verify({
        findingId: plan.findingId,
        verifierTaskId: attempt.taskId,
        verifierAttemptId: attempt.attemptId,
        recipe: plan.recipe,
        reviewerId: REVIEWER_ID,
        ...(plan.maxMs === undefined ? {} : { maxMs: plan.maxMs }),
        signal,
      });
      log('verifier.outcome', `${outcome.status} evidence=${outcome.evidenceIds.length} issues=${outcome.issues.map(issue => `${issue.code}:${issue.message.slice(0, 120)}`).join(' | ') || 'none'}`);
      return {
        status: outcome.status, evidenceIds: outcome.evidenceIds,
        finding: outcome.review.finding ?? null,
        issues: outcome.issues.map(issue => ({ code: issue.code, message: issue.message })),
      };
    },
    serialize<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
      // One ordered queue per attempt: a single worker's trusted calls stay serialized, while independent
      // attempts admitted under the run/per-target concurrency limits never block on each other.
      const previous = queues.get(attemptId) ?? Promise.resolve();
      const next = previous.then(work, work);
      queues.set(attemptId, next.then(() => undefined, () => undefined));
      return next;
    },
  };

  /**
   * Owner-document-derived planner menu, served only to the attempt whose pinned tool policy includes
   * `p2o_plan_context`. It names the exact candidate tasks, observation bindings, approved targets/accounts and caps
   * ceiling a plan may select from. It grants nothing: the owner approval document still authorizes any batch.
   */
  function planContextFor(attempt: Readonly<AttemptRecord>): PlanContextDocument {
    const plannerConfig = config.planner;
    if (!plannerConfig || !planLedger) throw new ApplicationError('plan-context-unavailable', 'No owner planner document is configured');
    const granted = config.tasks.find(entry => entry.manifest.taskId === attempt.taskId);
    if (!granted || granted.toolPolicy.mode !== 'sandbox-extension' || !granted.toolPolicy.tools.includes('p2o_plan_context')) {
      throw new ApplicationError('bridge-denied', 'The planner context is served only to the owner-approved planner task');
    }
    const tasks: PlanContextTask[] = [];
    const scopes = new Map<string, PlanContextScope>();
    for (const entry of config.tasks) {
      // A deferred controller task is not part of the planning menu: it is admitted only by its own gate.
      if (entry.deferred === true) continue;
      const manifest = entry.manifest;
      if (manifest.taskId === attempt.taskId) continue;
      if (store.getTask(manifest.taskId)) continue;
      const observations: PlanContextObservation[] = [];
      for (const check of checkMenu().filter(candidate => candidate.taskId === manifest.taskId)) {
        const binding = planBindingFor(check.input as JsonObject);
        if (!binding) continue;
        observations.push({ observationId: check.observationId, tool: check.tool, kind: check.kind, classification: check.classification, summary: check.summary, requests: 1, input: binding });
      }
      if (!observations.length) continue;
      const declared = (config.reporting?.coverage ?? []).filter(cell => cell.taskId === manifest.taskId);
      const surfaceIds = [...new Set(observations.map(observation => (config.checks ?? []).find(check => check.taskId === manifest.taskId && check.observationId === observation.observationId)?.surfaceId ?? manifest.taskId))];
      const surfaceId = surfaceIds[0] ?? manifest.taskId;
      const first = observations[0]!.input;
      const surface = typeof first.url === 'string' ? first.url : typeof first.path === 'string' ? first.path : manifest.taskId;
      const coverage: PlanContextTask['coverage'] = declared.length
        ? declared.map((cell, index) => ({ cellId: `cov-${manifest.taskId}-${index}`, taskId: manifest.taskId, surfaceId: cell.surfaceId, actorId: cell.actorId, question: cell.question }))
        : [{ cellId: `cov-${manifest.taskId}-0`, taskId: manifest.taskId, surfaceId, actorId: manifest.scope.actor.id, question: manifest.question.text }];
      tasks.push({
        taskId: manifest.taskId, role: entry.role, question: manifest.question, surfaceId, surface, actor: manifest.scope.actor,
        targetIds: [...manifest.scope.targetIds], skills: [...manifest.skills], allowedActions: [...manifest.allowedActions],
        requiredCapabilities: [...manifest.requiredCapabilities], dependencies: manifest.dependencyTaskIds.filter(id => id !== attempt.taskId).sort(),
        depth: manifest.depth, priority: manifest.depth === 0 ? 'high' : 'normal', observations, coverage,
      });
      const scopeId = manifest.scope.environmentId;
      const scopeKeys = manifest.scope.targetIds.flatMap(targetId => {
        const target = config.run.authorization.targets.find(candidate => candidate.id === targetId);
        return target ? [normalizeTargetKey(target.locator)] : [];
      });
      const scope = scopes.get(scopeId) ?? { scopeId, scope: manifest.scope, taskIds: [], threatModelKeys: scopeKeys };
      scope.taskIds.push(manifest.taskId);
      scopes.set(scopeId, scope);
    }
    for (const scope of scopes.values()) {
      scope.threatModelKeys = [...new Set(scope.scope.targetIds.flatMap(targetId => {
        const target = config.run.authorization.targets.find(candidate => candidate.id === targetId);
        return target ? [normalizeTargetKey(target.locator)] : [];
      }))].sort();
    }
    const totalObservations = tasks.reduce((sum, task) => sum + task.observations.length, 0);
    const totalRequests = tasks.reduce((sum, task) => sum + task.observations.reduce((count, observation) => count + observation.requests, 0), 0);
    const maxDepth = tasks.reduce((deepest, task) => Math.max(deepest, task.depth), 0);
    const capsCeiling: PlanCaps = {
      maxTasks: Math.min(tasks.length, config.run.budgets.maxTasks, plannerConfig.caps?.maxTasks ?? 4_096),
      maxDepth: Math.min(maxDepth, config.run.budgets.maxDepth, plannerConfig.caps?.maxDepth ?? 64),
      maxObservations: Math.min(totalObservations, plannerConfig.caps?.maxObservations ?? 16_384),
      maxRequests: Math.min(totalRequests, config.run.budgets.maxRequests, plannerConfig.caps?.maxRequests ?? 1_000_000),
    };
    return {
      version: 1, runId: config.run.runId, plannerAttemptId: attempt.attemptId,
      purposeHint: 'Select the owner-approved tasks and observations that decide the run question; the plan is reviewed and approved as a batch before anything is admitted.',
      inputRevision: tasks[0] ? (config.tasks.find(entry => entry.manifest.taskId === tasks[0]!.taskId)?.manifest.inputRevision ?? 'r1') : 'r1',
      requestedSelection: config.run.requestedRuntime.selection,
      scopes: [...scopes.values()],
      targets: config.run.authorization.targets.map(target => ({ id: target.id, kind: target.kind, locator: target.locator })),
      accounts: config.policy.accounts.map(account => account.id).sort(),
      allowedCapabilities: [...config.run.allowedCapabilities],
      allowedActions: [...config.run.authorization.allowedActions],
      budgets: {
        deadlineAt: new Date(Date.parse(config.run.budgets.deadlineAt) - config.run.budgets.reportReserveMs).toISOString(),
        maxRequests: config.run.budgets.maxRequests, maxBytes: config.run.budgets.maxBytes, maxToolCalls: config.run.budgets.maxToolCalls,
        maxTokens: config.run.budgets.maxTokens, maxCostUsd: config.run.budgets.maxCostUsd, ...(config.run.budgets.modelAccounting ? { modelAccounting: config.run.budgets.modelAccounting } : {}), maxAttempts: config.run.budgets.maxAttempts,
        maxTasks: config.run.budgets.maxTasks, maxDepth: config.run.budgets.maxDepth, maxConcurrency: config.run.budgets.maxConcurrency,
      },
      capsCeiling, tasks,
      findings: (config.reporting?.findings ?? []).map(plan => ({ findingId: plan.findingId, taskId: plan.taskId, claim: plan.claim })),
      threatModelKeys: config.run.authorization.targets.map(target => normalizeTargetKey(target.locator)),
      rules: [
        'Select only taskIds and observationIds listed in this document; the propose tool refuses anything else.',
        'One proposal binds exactly one approved scope; a selection spanning two scopes is refused, so plan one scope at a time.',
        'A plan cannot introduce a target, account, capability or action the owner document does not already approve.',
        'Every selected task needs at least one planned coverage cell; use the cellId from this document.',
        'The threat-model draft targetKey must be one of threatModelKeys and already normalized.',
        'Budgets, caps and the provider/model/thinking selection are controller-derived from the owner document.',
      ],
      limitations: [
        'The plan is a selection/narrowing layer over the owner-approved task and observation menu.',
        'URL bindings are query-free target bindings; the owner-approved check input is what executes.',
        'The menu excludes tasks already admitted for this run.',
      ],
    };
  }

  // [F3/F5] Optional plan-port seam: the composition owns the collaborators above; every other option the
  // planner's port contract declares (a generated-plan materializer added by the planner workstream, explicit
  // plan caps, ...) is forwarded verbatim when the owner supplies it. Configuration values are checked here,
  // so a seam can never replace the store/authority/admission path or silently become a no-op.
  const planPortSeam = planPortSeamOptions;
  if (config.planner && planLedger) {
    for (const key of Object.keys(planPortSeam)) {
      if ((PLAN_PORT_OWNED_KEYS as readonly string[]).includes(key)) throw new ApplicationError('invalid-config', `planPortOptions.${key} is owned by the composition and cannot be supplied`);
      if ((planPortSeam as Record<string, unknown>)[key] === undefined) {
        throw new ApplicationError('invalid-config', `planPortOptions.${key} is undefined; omit the key instead of setting it`);
      }
    }
  }
  const planPort: PlanPort | undefined = config.planner && planLedger ? createPlanPort({
    controlRoot: config.roots.control, store, supervisor, authority,
    toolPolicy: config.planner.toolPolicy, boundaryReceipt: config.planner.boundaryReceipt,
    ...(config.planner.role ? { role: config.planner.role } : {}),
    ...(overrides.clock ? { clock: () => overrides.clock!.now() } : {}),
    ledger: planLedger,
    observationApproved({ taskId, observationId, tool, binding }) {
      const check = (config.checks ?? []).find(candidate => candidate.taskId === taskId && candidate.observationId === observationId);
      if (!check) return `Task ${taskId} has no owner-approved observation ${observationId}`;
      if (String(check.tool) !== tool) return `Observation ${observationId} is owner-approved for ${String(check.tool)}, not ${tool}`;
      return planBindingRefusal(check.input as JsonObject, binding);
    },
    prepareWorkspace({ taskId, workspace }) {
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      writeFileSync(join(workspace, 'p2o-bridge.json'), `${JSON.stringify({ socketPath: config.bridge.socketPath, taskId })}\n`, { mode: 0o600 });
    },
    onAdmitted(materialized) {
      for (const task of materialized.tasks) {
        planSelections.set(task.manifest.taskId, new Set(materialized.checks.filter(check => check.taskId === task.manifest.taskId).map(check => check.observationId)));
      }
    },
    ...planPortSeam,
  }) : undefined;

  // -----------------------------------------------------------------------------------------------
  // [entry] Target-entry workflow seams (`/p2o --target …`). Everything below is derived from the
  // validated owner document and from owner-authored approval files; the composition never mints
  // authority, never authors an owner approval and never writes into the owner document. The composed
  // backend, the Pi session cwd and the model author are added by `createP2OBackend`.
  // -----------------------------------------------------------------------------------------------
  const entryGeneratedLedger: RequestPlanLedger = overrides.requestPlan?.ledger ?? createRequestPlanLedger({
    controlRoot: config.roots.control, authority,
    ...(overrides.clock ? { clock: () => overrides.clock!.now() } : {}),
  });

  /**
   * Owner-approved observation menu. `targetIds` is the observation's *owner-derived target affinity*: a URL
   * observation binds the run target whose origin it names, and every other (path/artifact) observation binds
   * the owning task's owner-approved target subset. Capabilities/actions come from the task's policy grant, so
   * the menu can never name a capability or action the owner did not grant.
   */
  const entryOwnerObservations: EntryOwnerObservation[] = (config.checks ?? []).flatMap(check => {
    const template = config.policy.grantTemplates.find(candidate => candidate.taskId === check.taskId);
    const manifest = config.tasks.find(task => task.manifest.taskId === check.taskId)?.manifest;
    if (!template || !manifest) return [];
    const input = check.input as { url?: unknown };
    let targetIds = [...manifest.scope.targetIds];
    if (typeof input.url === 'string') {
      let origin: string | undefined;
      try { origin = new URL(input.url).origin; } catch { origin = undefined; }
      const matched = origin ? config.policy.targets.find(target => target.origins.includes(origin!)) : undefined;
      if (matched) targetIds = [matched.id];
    }
    return [{
      taskId: check.taskId, observationId: check.observationId, tool: String(check.tool), summary: check.summary,
      targetIds, capabilities: [...template.capabilities], actions: [...template.actions],
    }];
  });

  /** Controller-derived owner envelope for generated requests; every field mirrors the owner document. */
  const entryRequestEnvelope: PlanRequestEnvelope = {
    targets: config.run.authorization.targets.map(target => ({ id: target.id, kind: target.kind, locator: target.locator })),
    taskGrants: config.tasks.filter(task => task.deferred !== true).map(task => ({
      taskId: task.manifest.taskId,
      targetIds: [...task.manifest.scope.targetIds],
      allowedActions: [...task.manifest.allowedActions],
      allowedCapabilities: [...task.manifest.requiredCapabilities],
    })),
    accounts: config.policy.accounts.map(account => account.id),
    accountGrants: config.policy.accounts.map(account => ({ accountId: account.id, targetIds: [...account.targetIds], actions: [...account.actions] })),
    allowedCapabilities: [...config.run.allowedCapabilities],
    allowedActions: [...config.run.authorization.allowedActions],
    exclusions: config.policy.exclusions.map(exclusion => ({ origin: exclusion.origin, pathPrefixes: [...exclusion.pathPrefixes] })),
  };

  /**
   * Inert fixture only: extend one owner-authored *scripted* worker plan with an owner-approved
   * materialized (generated) observation, so the deterministic worker executes the registered check.
   * Real workers read the same registered observation from the authenticated attempt context, and a
   * scripted plan exists only in `inert-local-fixture` mode. Append-only and bounded; the owner document
   * in memory is never edited.
   */
  const extendScriptedEntryPlan = (taskId: string, checks: readonly ObservationCheck[]): void => {
    if (config.mode !== 'inert-local-fixture' || checks.length === 0) return;
    const task = config.tasks.find(entry => entry.manifest.taskId === taskId);
    if (!task?.workerPlan) return;
    const path = join(task.manifest.workspace, 'worker-plan.json');
    let plan: Record<string, unknown>;
    try {
      const bytes = readFileSync(path);
      if (bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) throw new Error('implausible scripted plan size');
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('scripted plan is not an object');
      plan = parsed as Record<string, unknown>;
    } catch (error) {
      // No silent widening: the registered check stays in the worker menu, but the scripted plan was not
      // extended. This runs before the run is admitted, so the diagnostic is a controller-root record.
      log('entry.scripted-plan-extend-skipped', `task=${taskId} reason=${error instanceof Error ? error.message.slice(0, 200) : 'unreadable scripted plan'}`);
      return;
    }
    const observations = Array.isArray(plan.observations) ? plan.observations as unknown[] : [];
    const known = new Set(observations.flatMap(entry => {
      const id = (entry as { observationId?: unknown } | null)?.observationId;
      return typeof id === 'string' ? [id] : [];
    }));
    for (const check of checks) {
      if (known.has(check.observationId)) continue;
      observations.push({ observationId: check.observationId, name: `entry-${check.observationId}`.slice(0, 96) });
    }
    plan.observations = observations;
    writeFileSync(path, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  };

  /**
   * Inert fixture only: narrow one owner-authored *scripted* worker plan to the owner-approved plan
   * selection, so the deterministic worker walks exactly the observations the human-approved plan selected
   * (and never a wider menu). Missing ids refuse the narrowing instead of silently running a subset.
   */
  const narrowScriptedEntryPlan = (taskId: string, observationIds: readonly string[]): void => {
    if (config.mode !== 'inert-local-fixture' || observationIds.length === 0) return;
    const task = config.tasks.find(entry => entry.manifest.taskId === taskId);
    if (!task?.workerPlan) return;
    const path = join(task.manifest.workspace, 'worker-plan.json');
    let plan: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('scripted plan is not an object');
      plan = parsed as Record<string, unknown>;
    } catch (error) {
      log('entry.scripted-plan-narrow-skipped', `task=${taskId} reason=${error instanceof Error ? error.message.slice(0, 200) : 'unreadable scripted plan'}`);
      return;
    }
    const observations = Array.isArray(plan.observations) ? plan.observations as unknown[] : [];
    const byId = new Map(observations.flatMap(entry => {
      const id = (entry as { observationId?: unknown } | null)?.observationId;
      return typeof id === 'string' ? [[id, entry] as const] : [];
    }));
    const selected = [...new Set(observationIds)];
    const narrowed = selected.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    if (narrowed.length !== selected.length) {
      log('entry.scripted-plan-narrow-refused', `task=${taskId} missing=${selected.filter(id => !byId.has(id)).slice(0, 8).join(',')}`);
      return;
    }
    plan.observations = narrowed;
    writeFileSync(path, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  };

  /**
   * Bind one acquired local/repository view to the worker's actual source inputs.
   *
   * The entry workflow acquired a read-only, digest-verified view; a worker reads source through the
   * sandbox input root. If that root is not the view, the sandbox is re-rooted to it (local-fixture and
   * host-browser boundaries keep the same limits and change only the root) and the substitution is
   * recorded. A boundary that cannot be re-rooted, a view that is not pinned by the owner document, or a
   * relative check path missing from the view refuses the run with `ENTRY_SOURCE_UNBOUND` instead of
   * letting a worker silently scan a stale manifest path.
   */
  const bindEntrySource = async (input: {
    preparation: EntryPreparation;
    checks: readonly ObservationCheck[];
    acquisition?: EntryAcquisition;
  }): Promise<JsonObject | undefined> => {
    const acquisition = input.acquisition;
    if (!acquisition || acquisition.kind === 'http-url') return undefined;
    const target = input.preparation.target;
    const approved = config.run.authorization.targets.find(candidate =>
      candidate.locator === target.locator || normalizeTargetKey(candidate.locator) === normalizeTargetKey(target.locator));
    if (!approved || approved.kind !== 'artifact') {
      throw new ApplicationError('ENTRY_SOURCE_UNBOUND', `the acquired ${acquisition.kind} view is not an owner-approved artifact target; entry refuses to hand it to a worker`);
    }
    if (acquisition.kind === 'local-dir') {
      if (!target.digest || acquisition.digest !== target.digest) {
        throw new ApplicationError('ENTRY_SOURCE_UNBOUND', 'the acquired local view does not carry the exact content digest this plan was prepared for');
      }
      if (approved.digest && approved.digest !== acquisition.digest) {
        throw new ApplicationError('ENTRY_SOURCE_UNBOUND', 'the acquired local view does not match the owner-pinned content digest');
      }
    } else {
      if (!approved.digest && !approved.revision) {
        throw new ApplicationError('ENTRY_SOURCE_UNBOUND', 'the owner document pins neither a revision nor a content digest for this repository, so the acquired view cannot be bound to it');
      }
      if (approved.digest && acquisition.digest !== approved.digest) {
        throw new ApplicationError('ENTRY_SOURCE_UNBOUND', 'the acquired repository view does not match the owner-pinned content digest');
      }
      if (approved.revision && acquisition.revision !== approved.revision) {
        throw new ApplicationError('ENTRY_SOURCE_UNBOUND', 'the acquired repository view does not match the owner-pinned revision');
      }
    }
    const view = acquisition.locator;
    const relativePaths = [...new Set(input.checks.flatMap(check => sourceRelativePaths(check)))].sort();
    for (const relative of relativePaths) {
      const problem = sourcePathProblem(view, relative);
      if (problem) {
        throw new ApplicationError('ENTRY_SOURCE_UNBOUND', `worker source path ${JSON.stringify(relative)} ${problem}; entry refuses to let a worker scan a stale manifest path`);
      }
    }
    if (config.sandbox.mode === 'container') {
      throw new ApplicationError('ENTRY_SOURCE_UNBOUND', 'this composition runs the container sandbox, whose input root cannot be verified against the acquired read-only view; run the source workflow on the local-fixture/host-browser boundary or leave source inputs out of this run');
    }
    // Refuse rather than pretend: the worker reads through the owner-pinned sandbox input root, and that
    // root must be byte-identical (same content digest) to the acquired read-only view. A divergent root is
    // refused instead of silently letting a worker scan a stale manifest path, and the acquired view is
    // never substituted for it because the owner-pinned sandbox configuration identity would change.
    const workerInputRoot = config.sandbox.inputRoot;
    const worker = await fingerprintTree({ root: workerInputRoot, bounds: ENTRY_BOUNDS_DEFAULTS });
    if (acquisition.digest !== worker.digest) {
      throw new ApplicationError('ENTRY_SOURCE_UNBOUND', `the composed runtime would scan ${workerInputRoot} (digest ${worker.digest.slice(0, 12)}), which is not the acquired read-only view (digest ${(acquisition.digest ?? 'none').slice(0, 12)}); configure the owner sandbox input root to the acquired view or run without source inputs`);
    }
    for (const relative of relativePaths) {
      const problem = sourcePathProblem(workerInputRoot, relative);
      if (problem) {
        throw new ApplicationError('ENTRY_SOURCE_UNBOUND', `worker source path ${JSON.stringify(relative)} ${problem}; entry refuses to let a worker scan a stale manifest path`);
      }
    }
    return {
      kind: acquisition.kind,
      locator: view,
      ...(acquisition.digest ? { digest: acquisition.digest } : {}),
      ...(acquisition.revision ? { revision: acquisition.revision } : {}),
      files: acquisition.files ?? null,
      workerInputRoot,
      workerDigest: worker.digest,
      /** The worker root is content-identical to the acquired view; it is not the view itself. */
      equivalent: worker.digest === acquisition.digest,
      relativePaths,
    };
  };

  /**
   * Register one owner-approved materialized plan with this composition. Owner-menu checks *narrow* the
   * task menu to the plan selection (that is what the model selected); generated checks are *additive*
   * inside the owner envelope, exactly like the request-plan ledger's own contract. A registered check
   * must be covered by the owner policy grant of its task: this never widens a grant or invents a target.
   */
  const registerEntryMaterialized = async (input: {
    kind: 'owner-menu' | 'generated-requests';
    plan: EntryPlan;
    checks: readonly ObservationCheck[];
    grants?: readonly ApprovedRequestGrant[];
    preparation?: EntryPreparation;
    acquisition?: EntryAcquisition;
  }): Promise<{ taskIds: string[]; observationIds: string[] }> => {
    const taskIds = new Set<string>();
    const observationIds = new Set<string>();
    const generatedByTask = new Map<string, ObservationCheck[]>();
    for (const check of input.checks) {
      requireTask(config, check.taskId);
      const template = grantTemplate(check.taskId);
      const capability = String(check.tool);
      if (!template.capabilities.includes(capability as never)) {
        throw new ApplicationError('unapproved-capability', `Registered check ${check.checkId} uses ${capability}, which the owner policy grant for ${check.taskId} does not grant`);
      }
      const grant = input.grants?.find(candidate => candidate.checkId === check.checkId);
      if (grant) {
        if (grant.tool !== 'http.request') throw new ApplicationError('unapproved-capability', `Registered grant ${grant.grantId} is not an http.request grant`);
        if (!template.targetIds.includes(grant.targetId)) throw new ApplicationError('unapproved-target', `Registered grant ${grant.grantId} names target ${grant.targetId}, which the owner policy grant for ${check.taskId} does not include`);
        if (!template.actions.includes(grant.action as never)) throw new ApplicationError('unapproved-action', `Registered grant ${grant.grantId} names action ${grant.action}, which the owner policy grant for ${check.taskId} does not include`);
        if (!template.accountIds.includes(grant.accountId)) throw new ApplicationError('unapproved-account', `Registered grant ${grant.grantId} names account ${grant.accountId}, which the owner policy grant for ${check.taskId} does not include`);
        if (!config.run.authorization.targets.some(target => target.id === grant.targetId)) throw new ApplicationError('unapproved-target', `Registered grant ${grant.grantId} names a target outside the admitted run authorization`);
      }
      const ownerDefined = (config.checks ?? []).some(candidate => candidate.taskId === check.taskId && candidate.observationId === check.observationId);
      if (!ownerDefined && !entryChecks.some(existing => existing.checkId === check.checkId)) entryChecks.push(check);
      taskIds.add(check.taskId);
      observationIds.add(check.observationId);
      if (input.kind === 'generated-requests') {
        const list = generatedByTask.get(check.taskId) ?? [];
        list.push(check);
        generatedByTask.set(check.taskId, list);
      }
    }
    for (const taskId of taskIds) {
      if (input.kind === 'owner-menu') {
        const selected = planSelections.get(taskId) ?? new Set<string>();
        for (const check of input.checks.filter(candidate => candidate.taskId === taskId)) selected.add(check.observationId);
        planSelections.set(taskId, selected);
        narrowScriptedEntryPlan(taskId, [...selected]);
      }
      const generated = generatedByTask.get(taskId);
      if (generated) extendScriptedEntryPlan(taskId, generated);
    }
    // Registration happens before any admission, so the receipt is a controller-root record. When the run is
    // already durable (for example a re-entry of the same owner document) the same receipt is also an event.
    const grants = input.grants?.map(grant => grant.grantId).sort() ?? [];
    // A local/repository plan hands the worker the acquired read-only view (or refuses); the binding is
    // part of the durable registration receipt so the hand-off is auditable after the fact.
    const sourceBinding = input.preparation
      ? await bindEntrySource({ preparation: input.preparation, checks: input.checks, ...(input.acquisition ? { acquisition: input.acquisition } : {}) })
      : undefined;
    const registration = {
      version: 1 as const, at: new Date(overrides.clock ? overrides.clock.now() : Date.now()).toISOString(),
      kind: input.kind, planId: input.plan.planId, planDigest: input.plan.digest,
      taskIds: [...taskIds].sort(), observationIds: [...observationIds].sort(), grants,
      ...(input.preparation ? { runId: input.preparation.runId, target: {
        kind: input.preparation.target.kind,
        locator: input.preparation.target.locator,
        ...(input.preparation.target.digest ? { digest: input.preparation.target.digest } : {}),
        ...(input.preparation.target.revision ? { revision: input.preparation.target.revision } : {}),
      } } : {}),
      ...(sourceBinding ? { sourceBinding } : {}),
    };
    mkdirSync(join(config.roots.control, 'entry-registrations'), { recursive: true, mode: 0o700 });
    const registrationName = `plan-${input.plan.planId.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 96)}.json`;
    writeFileSync(join(config.roots.control, 'entry-registrations', registrationName), `${JSON.stringify(registration)}\n`, { mode: 0o600 });
    if (store.getRun(config.run.runId)) store.appendEvent({ runId: config.run.runId, type: 'entry.plan-registered', payload: registration });
    return { taskIds: [...taskIds].sort(), observationIds: [...observationIds].sort() };
  };

  /**
   * Expand a bounded model selection into a full `PlanProposal` from owner data only. This is the
   * controller-side half of an owner-menu plan: the model selects observation ids, and identity, scope,
   * targets, accounts, budgets and coverage are copied from the owner-approved task/run documents.
   */
  const buildOwnerMenuProposal = async (input: {
    selection: EntryOwnerSelection[];
    preparation: EntryPreparation;
    binding: EntryRunBinding;
    targetId: string;
  }): Promise<{ proposal: PlanProposal }> => {
    const run = input.binding.run;
    const selectedTasks = [...new Set(input.selection.map(entry => entry.taskId))];
    const tasks: ObservationCheck[] = [];
    const tasksById = new Map<string, { granted: GrantedTask; checks: ObservationCheck[] }>();
    for (const taskId of selectedTasks) {
      const granted = config.tasks.find(entry => entry.manifest.taskId === taskId);
      if (!granted) throw new ApplicationError('unapproved-plan-task', `Plan selection names task ${taskId}, which the owner document does not approve`);
      const checks = input.selection.filter(entry => entry.taskId === taskId).map(entry => {
        const check = (config.checks ?? []).find(candidate => candidate.taskId === taskId && candidate.observationId === entry.observationId);
        if (!check) throw new ApplicationError('unapproved-observation', `Plan selection names observation ${entry.observationId} on task ${taskId}, which the owner document does not approve`);
        return check;
      });
      tasksById.set(taskId, { granted, checks });
      tasks.push(...checks);
    }
    const first = tasksById.get(selectedTasks[0]!)!;
    const scope = first.granted.manifest.scope;
    for (const { granted } of tasksById.values()) {
      if (granted.manifest.scope.actor.id !== scope.actor.id || granted.manifest.scope.environmentId !== scope.environmentId) {
        throw new ApplicationError('unapproved-plan-scope', 'Plan selection spans more than one owner scope; plan one scope at a time');
      }
    }
    const targetIds = [...new Set([...tasksById.values()].flatMap(({ granted }) => granted.manifest.scope.targetIds))];
    if (!targetIds.includes(input.targetId)) throw new ApplicationError('unapproved-plan-target', 'Plan selection does not include the requested target');
    const observations: PlanObservation[] = [];
    const planTasks: PlanTask[] = [];
    const coverage: PlanCoverageCell[] = [];
    for (const [taskId, { granted, checks }] of tasksById) {
      const manifest = granted.manifest;
      const bindings = checks.map(check => planBindingFor(check.input as JsonObject) ?? (() => { throw new ApplicationError('unapproved-observation', `Observation ${check.observationId} has no query-free owner binding`); })());
      const surfaceId = checks[0]!.surfaceId ?? manifest.taskId;
      const firstBinding = bindings[0]!;
      const surface = typeof firstBinding.url === 'string' ? firstBinding.url : typeof firstBinding.path === 'string' ? firstBinding.path : manifest.taskId;
      planTasks.push({
        taskId, question: manifest.question, surfaceId, surface, actor: { id: manifest.scope.actor.id, privileges: [...manifest.scope.actor.privileges] },
        targetIds: [...manifest.scope.targetIds], skills: [...manifest.skills], allowedActions: [...manifest.allowedActions],
        requiredCapabilities: [...manifest.requiredCapabilities], dependencies: [], priority: manifest.depth === 0 ? 'high' : 'normal', depth: manifest.depth,
      });
      checks.forEach((check, index) => observations.push({
        observationId: check.observationId, taskId, tool: String(check.tool), input: bindings[index]!, requests: 1,
        kind: check.kind, classification: check.classification, summary: check.summary,
      }));
      coverage.push({ cellId: `cov-${taskId}-0`, taskId, surfaceId, actorId: manifest.scope.actor.id, question: manifest.question.text });
    }
    const maxDepth = planTasks.reduce((deepest, task) => Math.max(deepest, task.depth), 0);
    const requestSum = observations.reduce((sum, observation) => sum + observation.requests, 0);
    const plan: PlanProposal = {
      schemaVersion: 1,
      proposalId: `entry-owner-${input.preparation.scopeDigest.slice(0, 24)}`,
      run: {
        runId: run.runId,
        purpose: `Owner-menu plan for ${input.targetId} selected by the model from the owner-approved observation menu`.slice(0, 512),
        inputRevision: first.granted.manifest.inputRevision,
        scope: {
          authorizationRef: scope.authorizationRef, targetIds, actor: { id: scope.actor.id, privileges: [...scope.actor.privileges] },
          boundary: scope.boundary, isolation: scope.isolation, recovery: scope.recovery,
          environmentId: scope.environmentId, configurationDigest: scope.configurationDigest,
          inputs: scope.inputs.map(reference => ({ ...reference })),
        },
        targets: run.authorization.targets.filter(target => targetIds.includes(target.id)).map(target => ({ id: target.id, kind: target.kind, locator: target.locator })),
        accounts: config.policy.accounts.filter(account => account.targetIds.some(id => targetIds.includes(id))).map(account => account.id),
        allowedCapabilities: [...new Set(planTasks.flatMap(task => task.requiredCapabilities))],
        allowedActions: [...new Set(planTasks.flatMap(task => task.allowedActions))],
        budgets: {
          deadlineAt: new Date(Date.parse(run.budgets.deadlineAt) - run.budgets.reportReserveMs).toISOString(),
          maxRequests: run.budgets.maxRequests, maxBytes: run.budgets.maxBytes, maxToolCalls: run.budgets.maxToolCalls,
          maxTokens: run.budgets.maxTokens, maxCostUsd: run.budgets.maxCostUsd, ...(run.budgets.modelAccounting ? { modelAccounting: run.budgets.modelAccounting } : {}), maxAttempts: run.budgets.maxAttempts,
          maxTasks: run.budgets.maxTasks, maxDepth: run.budgets.maxDepth, maxConcurrency: run.budgets.maxConcurrency,
        },
      },
      tasks: planTasks,
      observations,
      coverage,
      caps: { maxTasks: planTasks.length, maxDepth, maxObservations: observations.length, maxRequests: requestSum },
      provenance: {
        plannerAttemptId: `entry-model-${input.preparation.scopeDigest.slice(0, 24)}`,
        plannerKind: 'worker',
        requestedSelection: { ...run.requestedRuntime.selection },
        inputDigests: [input.preparation.scopeDigest],
        producedAt: new Date(overrides.clock ? overrides.clock.now() : Date.now()).toISOString(),
      },
    };
    return { proposal: plan };
  };

  const entrySeams: EntrySeams = {
    manifestPath: entryManifestPath,
    mode: interfaceModeFor(config.mode),
    workspaceRoot: entryWorkspaceRoot,
    /** Controller-side approval minting targets the same owner directory the ledger reads. */
    approvalDirectory: entryApprovalDirectory,
    ownerObservations: entryOwnerObservations,
    requestEnvelope: entryRequestEnvelope,
    buildOwnerMenuProposal,
    generated: {
      ledger: entryGeneratedLedger,
      ownerDocumentPath: ownerDocumentPathFor(entryApprovalDirectory, 'request'),
      register: async input => registerEntryMaterialized({
        kind: 'generated-requests', plan: input.plan, checks: input.materialized.checks, grants: input.materialized.grants,
        preparation: input.preparation, ...(input.acquisition ? { acquisition: input.acquisition } : {}),
      }),
    },
    ...(planLedger ? {
      ownerMenu: {
        ledger: planLedger,
        ownerDocumentPath: ownerDocumentPathFor(entryApprovalDirectory, 'plan'),
        register: async input => registerEntryMaterialized({
          kind: 'owner-menu', plan: input.plan, checks: input.materialized.checks,
          preparation: input.preparation, ...(input.acquisition ? { acquisition: input.acquisition } : {}),
        }),
        workspaceFor: taskId => {
          const workspaceFor = supervisor.workspaceFor;
          if (!workspaceFor) throw new ApplicationError('INTEGRATION_REQUIRED', 'the supervisor exposes no derived workspace for plan materialization');
          return workspaceFor.call(supervisor, taskId);
        },
        ...(config.planner?.role ? { role: config.planner.role } : {}),
      },
    } : {}),
    ...(overrides.clock ? { clock: () => overrides.clock!.now() } : {}),
    ...(entryOverrides.newId ? { newId: entryOverrides.newId } : {}),
    ...(entryOverrides.bounds ? { bounds: entryOverrides.bounds } : {}),
    ...(entryOverrides.gitBinary ? { gitBinary: entryOverrides.gitBinary } : {}),
    ...(entryOverrides.commandRunner ? { commandRunner: entryOverrides.commandRunner } : {}),
    ...(entryOverrides.observer ? { observer: entryOverrides.observer } : {}),
  };
  /** The interface's three plan actions mapped onto the port; approval always reads an owner file from disk. */
  async function dispatchPlan(port: PlanPort, input: PlanInput, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new ApplicationError('cancelled', 'Plan operation was aborted before dispatch');
    if (input.action === 'propose') return await port.propose({ runId: input.runId, proposalPath: input.proposalPath });
    if (input.action === 'read') return await port.read({ runId: input.runId, ...(input.proposalId ? { proposalId: input.proposalId } : {}) });
    return await port.approve({ runId: input.runId, proposalDigest: input.proposalDigest, approvalPath: input.approvalPath });
  }

  if (planLedger) {
    // Threat-model bridge context (read + attributed append-only amend) and the planner-only context op.
    // Every served context operation appends a durable, attempt-attributed diagnostic event so a real worker's
    // read/amend is independently visible in the run event stream (the operation itself stays authoritative).
    const contextPort = createWorkerContextPort({ ledger: planLedger, runId: config.run.runId });
    const note = (type: string, attempt: Readonly<AttemptRecord>, payload: JsonObject): void => {
      try { store.appendEvent({ runId: config.run.runId, type, payload, taskId: attempt.taskId, attemptId: attempt.attemptId }); }
      catch { /* diagnostic only; the served bridge operation already succeeded */ }
    };
    bridgeOperations.context = {
      async read(attempt, payload) {
        const result = await contextPort.read(attempt, payload) as { found?: boolean; models?: unknown[] };
        note('worker.threat-model-read', attempt, { found: result.found === true, models: Array.isArray(result.models) ? result.models.length : result.found === true ? 1 : 0 });
        return result;
      },
      async amend(attempt, payload, signal) {
        const result = await contextPort.amend(attempt, payload, signal) as { ok?: boolean; code?: string; amendmentId?: string; targetKey?: string };
        note('worker.threat-model-amend', attempt, { ok: result.ok === true, ...(result.code ? { code: result.code } : {}), ...(result.amendmentId ? { amendmentId: result.amendmentId } : {}), ...(result.targetKey ? { targetKey: result.targetKey } : {}) });
        return result as unknown;
      },
    };
    bridgeOperations.plan = {
      async context(attempt) {
        const document = planContextFor(attempt);
        note('worker.plan-context-read', attempt, { tasks: document.tasks.length, targets: document.targets.length, capsMaxTasks: document.capsCeiling.maxTasks });
        return JSON.parse(canonicalJson(document)) as unknown;
      },
    };
  }

  const bridge = createWorkerBridge({
    socketPath: config.bridge.socketPath,
    controlRoot: config.roots.control,
    runId: config.run.runId,
    store,
    operations: overrides.log ? { ...bridgeOperations, log: overrides.log } : bridgeOperations,
  });
  await bridge.listen();

  async function admitApprovedRun(): Promise<RunManifest> {
    const existing = store.getRun(config.run.runId);
    if (existing) return existing;
    const admission = ownerGrantFor(config).runs[0]!;
    return supervisor.admitRun(admission);
  }
  async function admitApprovedTasks(): Promise<TaskManifest[]> {
    const admitted: TaskManifest[] = [];
    for (const task of config.tasks) {
      // A deferred controller task (the pre-authorized verifier) is admitted only by its post-admission gate.
      if (task.deferred === true) continue;
      admitted.push(await supervisor.admitTask({
        manifest: task.manifest, role: task.role, ...(task.exclusiveKeys ? { exclusiveKeys: task.exclusiveKeys } : {}),
      }));
    }
    return admitted;
  }

  function artifacts(runId: string): AssessmentArtifacts {
    if (runId !== config.run.runId) throw new ApplicationError('run-identity', 'Only the configured run can be reported');
    const controller = { collectorId: SUPERVISOR_OWNER, toolName: 'p2o-supervisor', locatorRoot: config.roots.control };
    const publish = overrides.publish
      ? (override => override({ runId, reviewerId: REVIEWER_ID, now: new Date().toISOString() }))(overrides.publish)
      : publishEvidenceReviews({ vault, store, runId, reviewerId: REVIEWER_ID, now: () => new Date().toISOString(), controller });
    const published = { reviews: publish.reviews, controllerReceipts: publish.controllerReceipts };
    const findingReviews: FindingReview[] = [];
    for (const plan of reportingFindings()) {
      const review = latestFindingReview(plan.findingId);
      if (review) findingReviews.push(review);
    }
    const coveragePlan = config.reporting?.coverage ?? [];
    // Planner coverage gate input: only an approved plan contributes cells, and an open/needs_follow_up cell
    // blocks finalization unless the plan ledger recorded a resolution or an explicit untested/blocked carry.
    const planCells = planLedger?.approvedCells(runId) ?? [];
    const planCoverage: CoverageReconciliation | undefined = planLedger && planCells.length ? planLedger.coverage(runId) : undefined;
    const records = coverageRecords(store, runId, coveragePlan);
    const reviews = coverageReviews(vault, records, { reviewerId: REVIEWER_ID, now: new Date().toISOString() });
    return buildAssessmentArtifacts({
      vault, store, runId, reviewerId: REVIEWER_ID,
      generatedAt: new Date().toISOString(),
      handoffs: published.reviews as never,
      findings: findingReviews,
      coveragePlan,
      coverage: reviews,
      controllerReceipts: published.controllerReceipts,
      ...(planCoverage ? { planCoverage } : {}),
      controller,
    });
  }

  const port: SupervisorPort = {
    async admitRun({ manifest }) {
      // The supplied manifest is what the owner authority must approve; the owner-approved per-target limits are
      // used because the interface option cannot widen an owner grant.
      const existing = store.getRun(manifest.runId);
      const run = existing ?? await supervisor.admitRun({
        manifest, mode: 'managed', perTargetConcurrency: config.interface?.perTargetConcurrency ?? {},
      });
      await admitApprovedTasks();
      return run;
    },
    start: runId => supervisor.start(runId),
    async cancel(runId: string) {
      // The interface reports verified termination only from the supervisor's own snapshot (draining state,
      // non-terminal attempts, outstanding leases); a bare snapshot object is never a cancellation receipt.
      const snapshot = await supervisor.cancel(runId);
      const terminal = new Set(['exited', 'failed', 'timed-out', 'cancelled']);
      const live = snapshot.attempts.filter(attempt => !terminal.has(attempt.lifecycleState));
      const failures: { code: string; message: string }[] = [];
      if (snapshot.draining) failures.push({ code: 'DRAINING', message: 'supervisor still reports draining owned execution' });
      if (live.length) failures.push({ code: 'ATTEMPT_NOT_TERMINAL', message: `${live.length} attempt(s) have no terminal lifecycle state` });
      if (snapshot.outstandingLeases.length) failures.push({ code: 'OUTSTANDING_OWNERSHIP', message: `${snapshot.outstandingLeases.length} workspace lease(s) still held pending verified termination` });
      return { runId, schedulingStopped: !snapshot.draining, terminationVerified: !snapshot.draining && !live.length && !snapshot.outstandingLeases.length, failures };
    },
    switchModel: input => supervisor.switchModel(input.attemptId, { selection: input.selection, reason: input.reason }),
    requestSubtask: input => supervisor.worker(input.attemptId).requestSubtask({
      question: input.question,
      targetIds: [...input.targetIds],
      actor: { id: input.actor.id, privileges: [...input.actor.privileges] },
      inputRevision: input.inputRevision,
      role: input.role,
      reason: input.reason,
      ...(input.budgets ? { budgets: input.budgets } : {}),
      ...(input.skills ? { skills: [...input.skills] } : {}),
      ...(input.allowedActions ? { allowedActions: [...input.allowedActions] } : {}),
      ...(input.requiredCapabilities ? { requiredCapabilities: [...input.requiredCapabilities] } : {}),
      ...(input.dependencyTaskIds ? { dependencyTaskIds: [...input.dependencyTaskIds] } : {}),
    }),
    recover: runId => supervisor.recover(runId),
    snapshot: runId => supervisor.snapshot(runId),
    preflight: ({ manifest }) => {
      const issues: { code: string; message: string }[] = [];
      const warnings: string[] = [];
      if (manifest.runId !== config.run.runId) issues.push({ code: 'RUN_IDENTITY_MISMATCH', message: 'manifest is not the owner-approved run' });
      if (canonicalJson(manifest) !== canonicalJson(config.run)) issues.push({ code: 'RUN_IDENTITY_MISMATCH', message: 'manifest differs from the owner-approved document' });
      if (!existsSync(config.runtime.piBinary)) issues.push({ code: 'RUNTIME_UNAVAILABLE', message: 'configured runtime binary is missing' });
      if (!overrides.replayEnvironment && !verificationSchedule && (config.reporting?.verification?.length ?? 0) > 0) warnings.push('no clean replay environment factory is configured; verification fails closed');
      // [T2/T7] Read-only gateway identity/readiness: no model or provider request is made.
      if (controllerGateway) {
        const ready = controllerGateway.readiness(config.run.requestedRuntime.selection);
        warnings.push(`gateway ${controllerGateway.gatewayId} provider=${controllerGateway.provider} listening=${controllerGateway.listening} credential=${controllerGateway.credentialIdentity.ref} ready=${ready.ok}${ready.ok ? '' : ` code=${ready.code}: ${ready.message}`}`);
      }
      // [T8/S1] Read-only spend plan report: enforcement is on unconditionally, and this is the effective
      // reserve plan. It names the pinned price key and the declared bounds without contacting a model.
      {
        const requested = config.run.requestedRuntime.selection;
        const key = modelPriceKey(requested.provider, requested.model);
        const pricing = PINNED_MODEL_PRICES[key] ? `price=${key}` : `price=unknown for ${key} (informational tokens only)`;
        warnings.push('mode' in spendPlan.limits
          ? `model accounting=informational-durable; application token/USD caps=none; completion=selected-model capability; ${pricing}`
          : `spend enforcement=on limits=maxTokens:${spendPlan.limits.maxTokens} maxCostUsd:${spendPlan.limits.maxCostUsd} price=${key} prices=pinned inputTokensUpperBound=${spendPlan.inputTokensUpperBound ?? 'prompt-bytes'} maxOutputTokens=${spendPlan.maxOutputTokens ?? 'min(4096,remaining)'} journal=${spendPlan.journal ? 'durable' : 'memory'} operations=per-turn-admission-at-the-gateway+per-turn-charge+catch-up+release-with-charged-turns`);
        const priced = Boolean(PINNED_MODEL_PRICES[key]);
        // [L3] Bounded runs still refuse an unpriced selection; informational runs record tokens and leave the
        // monetary figure unknown instead.
        if (!priced && !('mode' in spendPlan.limits)) issues.push({ code: 'MODEL_SPEND_UNPRICED', message: `no pinned model price for ${key}; the run cannot be bounded` });
      }
      // [F3/F4] Read-only pack report: which optional packs this composition owns, on which boundary, and which
      // pack can release an attempt's session. No capability is granted here and nothing is contacted.
      if (packsEnabled) {
        const sessionReleasers = [
          ...(browserPackEnabled ? ['browser-pack'] : []),
          ...(proxyPackEnabled ? ['proxy-pack'] : []),
          ...(!browserPackEnabled && !proxyPackEnabled ? ['no-session-owning-packs'] : []),
        ];
        const packNames = [
          ...(browserPackEnabled ? ['browser.session/browser.act'] : []),
          ...(proxyPackEnabled ? ['proxy.session/proxy.history'] : []),
          ...(fuzzPack ? ['fuzz.differential/fuzz.template'] : []),
        ];
        warnings.push(`packs=${packNames.join(',') || 'none'} boundary=${sandbox.mode} releasers=${sessionReleasers.join(',')} fence=attempt-liveness+session-lease sessions=${browserPackEnabled ? 'host browser on the acknowledged boundary' : proxyPackEnabled ? 'capture listener' : 'none'}`);
        if (fuzzPack) warnings.push('fuzz.differential runs owner-supplied local modules in the controller process and is only qualified on the trusted-local-modules fixture boundary; fuzz.template needs owner-approved templates');
      }
      return { issues, warnings };
    },
    dispose: () => supervisor.dispose(),
  };
  // The configured owner document decides the only interface mode this composition accepts. The wrapper delegates
  // to the real backend methods, so a mismatch cannot admit a run or reach recover/start at all.
  const interfaceBackend: ControlBackend = enforceInterfaceMode(createSupervisorBackend({
    store, supervisor: port,
    ...(credentialAuthority ? { credentials: credentialAuthority } : {}),
    ...(overrides.credentialPlan ? { credentialPlan: overrides.credentialPlan } : {}),
    ...(planPort ? { plan: (input: PlanInput, signal?: AbortSignal) => dispatchPlan(planPort, input, signal) } : {}),
    render: (runId, format: InterfaceReport['format']) => {
      const built = artifacts(runId);
      return format === 'markdown'
        ? { format, content: built.markdown }
        : { format, content: JSON.parse(built.json) as unknown };
    },
  }), config.mode);

  const application: AssessmentApplication = {
    store, supervisor, vault, authority, sandbox, config, collector, bridge, verifier, interfaceBackend, runtimes,
    policyFor, grantIdFor: taskId => grantTemplate(taskId).id, brokerFor,
    admitApprovedRun, admitApprovedTasks,
    collectAccepted: taskId => acceptedResult(store, config.run.runId, taskId),
    acceptedPacket: taskId => acceptedPacket(store, config.run.runId, taskId),
    artifacts,
    ...(planLedger ? { planLedger } : {}),
    ...(overrides.requestPlan ? { requestPlan: Object.freeze({ ledger: overrides.requestPlan.ledger, materialize: overrides.requestPlan.materialize ?? materializeRequestPlan }) } : {}),
    entrySeams,
    // [F3] The exact pack instances this composition dispatches to and releases: an operator/test accessor.
    // Dispatching to a pack directly bypasses the broker's policy check and the attempt-liveness fence, so this
    // must never be handed to a worker.
    ...(packsEnabled ? { packInstancesFor: (attemptId: string) => packsFor(attemptId) } : {}),
    async close() {
      // Verified lifecycle cleanup precedes dropping the durable evidence/store. A failure retains state.
      const closingRun = store.getRun(config.run.runId);
      if (closingRun && (closingRun.state === 'active' || closingRun.state === 'paused')) {
        const stopped = await supervisor.cancel(closingRun.runId);
        if (stopped.outstandingLeases.length) throw new ApplicationError('RESOURCE_RELEASE_UNVERIFIED', 'controller close retains durable state until owned workers and sessions are verified stopped');
      }
      supervisor.dispose();
      for (const adapter of Object.values(runtimes)) await (adapter as { shutdown?: () => Promise<void> }).shutdown?.();
      await controllerContainerOwner?.close();
      await bridge.close();
      await controllerGateway?.close();
      store.close();
      vault.close();
    },
  };
  log('application.created', `${config.mode} ${config.run.runId} ${config.tasks.length} task(s)`);
  return application;
}

export type { EvidenceReceipt, HandoffPacket, StoredResult };

/** Explicit managed admission for callers that drive the supervisor directly (no launch). */
export function planAdmission(config: ApplicationConfig) {
  return ownerGrantFor(config).runs[0]!;
}
