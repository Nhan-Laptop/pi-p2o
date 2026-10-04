/**
 * Bundled-controller restart seam for one interrupted controller run.
 *
 * This module owns exactly the pieces the durable checkpoint cannot own by itself:
 *
 *  1. **Discovery** from controller-owned metadata only. The run root, state database, entry plan store,
 *     owner approval directory, checkpoint root and pinned autonomous budget are re-read from the private
 *     controller directories the run already wrote. No model-, worker- or target-supplied path is trusted.
 *  2. **Exact request re-read.** `readControllerApprovedRequest` re-derives the approved source request from
 *     the sealed entry-plan record (digest re-checked by the entry store), the owner approval document, the
 *     durable admitted run and the controller's original `source-approval.json`. The checkpoint never mints
 *     approval; the existing owner-ledger gate (`createControllerOwnerGate`) still decides on every call.
 *  3. **Physical resource reconciliation.** `reconcileOwnedResourcesPhysically` drives the REAL managed
 *     runtime adapter over the durable launch/handle records, so the guardian process family is re-adopted by
 *     its exact durable control markers and kernel identity (`pid`/`bootId`/`startTicks`), container session
 *     leases are swept through the registered `container-pack` family with the daemon/label/incarnation checks
 *     in `recoverContainerResources`, and every terminal verdict is backed by a collector-trusted runtime
 *     receipt admitted through the same `admitControllerReceipt` path the supervisor uses. A live, unknown,
 *     foreign or unattributable resource never becomes quiescence; a bare PID is never signalled.
 *  4. **Verifier dynamic state.** A deferred verifier program that has already produced or admitted anything
 *     is refused explicitly, because its in-process dynamic finding/check/replay registries cannot be
 *     reconstructed from accepted evidence alone. Only the pre-admission case is reconstructed, and only when
 *     the deterministic derivation reproduces the exact durable task/finding/claim identity.
 *
 * Nothing here reacquires a source (`HEAD`), resets a budget, recreates the SQLite store, reuses a session,
 * serializes a credential or executes target/source code.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { canonicalJson, digestJson } from '../../contracts/index.js';
import { planApprovalDocumentSchema, type PlanApprovalDocument } from '../../contracts/index.js';
import { DurableStore } from '../../store/index.js';
import type { ReconciliationObservation, ReconciliationReport } from '../../store/types.js';
import { admitControllerReceipt, ControlFiles } from '../../orchestrator/index.js';
import { registerPackSessionFamily } from '../../runtime/pack-lifecycle.js';
import { alive, LinuxProcessProbe, sameProcess } from '../../runtime/processes.js';
import type { ProcessIdentity } from '../../runtime/types.js';
import type { ModelGateway, RuntimeAdapter, RuntimeEvent, RuntimeHandle, RuntimeHooks } from '../../runtime/types.js';
import { createOwnedHeadlessRuntime } from '../runtimes.js';
import { ownerGrantFor, type ApplicationConfigWithSpend } from '../composition.js';
import { createOwnerDirectoryAuthority } from '../entry/approvals.js';
import { createEntryPlanStore, entryOwnerApprovalPath, readOwnerDocument, sealPlanDigest, type StoredEntryPlan } from '../entry/index.js';
import { configurationDigest, consentCovers, readOwnerConsent, type OnboardingReady } from '../onboarding/index.js';
import { createPlanLedger } from '../planner.js';
import { deriveFirstUseVerificationPlan, type FirstUseVerificationBudget } from '../first-use-verification/index.js';
import { recoverContainerResources } from '../source-binding/container-lifecycle.js';
import { assertSourceIdentity, validateSourceApproval, type ApprovedSourceRequest, type ApprovedSourceSnapshot, type SourceOwnerGate } from '../source-binding/index.js';
import type { SessionReleaseRegistry } from '../../runtime/sessions.js';
import { deny, readBounded } from './files.js';
import { prepareControllerRestore, type CheckpointLocation, type ControllerRestoreTicket } from './index.js';

const MAX_RUN_DIRECTORIES = 512;
const RUN_DIRECTORY = /^assessment-[0-9a-fA-F-]{36}$/;

/** Controller-owned layout of one interrupted run; every field is re-validated, never model-supplied. */
export interface ControllerRunLayout {
  base: string;
  runId: string;
  runRoot: string;
  controlRoot: string;
  workspaceRoot: string;
  /** Exact controller-owned evidence vault (`<runRoot>/vault`); never a caller- or config-supplied path. */
  vaultRoot: string;
  statePath: string;
  checkpointRoot: string;
  entryControlRoot: string;
  approvalDirectory: string;
  configPath: string;
  budgetPath: string;
  sourceApprovalPath: string;
  verificationPath: string;
  verificationAdmissionPath: string;
}

export interface ControllerRunDiscovery {
  layout: ControllerRunLayout;
  config: ApplicationConfigWithSpend;
  configDigest: string;
  budget: Extract<Readonly<import('../../policy/budget.js').AutonomousModelBudgetPlan>, { outcome: 'ready' }>;
}

export interface ControllerRestorePreparation {
  phase: 'reconciliation-required';
  layout: ControllerRunLayout;
  discovery: ControllerRunDiscovery;
  verifier: VerifierRestartVerdict;
  /** Real owner-ledger gate bound to the current consent; reusable for the restored mount and later checkpoints. */
  authorize: SourceOwnerGate;
  ticket: ControllerRestoreTicket;
}

/**
 * Verdict on the deferred verifier program across a restart.
 *
 * `none` means the owner document authorizes no verifier program (or the derivation refused one), so no
 * dynamic controller state exists. `pre-admission` means the program identity is re-derivable and nothing
 * has been admitted yet: the exact schedule is rebuilt from the durable synthesis record and must reproduce
 * the same task/finding/claim identity. `refused` is terminal for this restart state: once an accepted
 * producer packet or any verifier admission/attempt/evidence exists, the in-process dynamic finding, check
 * and replay registries cannot be reconstructed from durable accepted evidence here, and silently skipping
 * the verifier is not allowed.
 */
export type VerifierRestartVerdict =
  | { kind: 'none'; reason: string }
  | { kind: 'pre-admission'; schedule: ControllerVerificationSchedule; reason: string }
  | { kind: 'refused'; code: string; reason: string };

/** Exact controller-owned post-admission verifier scheduling identity (`ApplicationOverrides.verificationSchedule`). */
export interface ControllerVerificationSchedule {
  producerTaskId: string;
  verifierTaskId: string;
  targetId: string;
  targetLocator: string;
  budget: FirstUseVerificationBudget;
  derivedAt: string;
}

export function controllerBaseForOwnerConfig(ownerConfigPath: string): string {
  if (typeof ownerConfigPath !== 'string' || !ownerConfigPath.startsWith(sep) || resolve(ownerConfigPath) !== ownerConfigPath) {
    deny('CHECKPOINT_ROOT', 'owner consent path must be a canonical absolute path');
  }
  const base = resolve(dirname(ownerConfigPath), '..');
  if (base === sep || base === ownerConfigPath || resolve(base) !== base) deny('CHECKPOINT_ROOT', 'controller base derived from owner consent is unusable');
  return base;
}

function canonicalDirectory(path: string, label: string): string {
  if (typeof path !== 'string' || !path.startsWith(sep) || resolve(path) !== path || path === sep) {
    deny('CHECKPOINT_ROOT', `${label} must be a canonical absolute directory`);
  }
  return path;
}

/** Bounded private JSON read; a missing record is `undefined`, an unsafe/corrupt one still throws. */
async function privateJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readBounded(path)) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) deny('CHECKPOINT_FILE', `${label} is not an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    deny('CHECKPOINT_FILE', `${label} is not a bounded string`);
  }
  return value;
}

/** Structural layout of one controller run. Reads no configuration and grants no authority. */
export async function resolveControllerRunLayout(options: {
  runId: string;
  runRoot: string;
  checkpointRoot?: string;
  base?: string;
}): Promise<ControllerRunLayout> {
  const runId = text(options.runId, 'runId');
  const runRoot = canonicalDirectory(options.runRoot, 'controller run root');
  const base = canonicalDirectory(options.base ?? resolve(dirname(dirname(runRoot))), 'controller base');
  if (dirname(runRoot) !== join(base, 'runs')) deny('CHECKPOINT_ROOT', 'controller run root is not inside the private runs directory');
  const checkpointRoot = canonicalDirectory(options.checkpointRoot ?? join(base, 'checkpoints', runId), 'checkpoint root');
  const controlRoot = join(runRoot, 'control');
  const layout: ControllerRunLayout = {
    base, runId, runRoot, controlRoot,
    workspaceRoot: join(runRoot, 'workspaces'),
    vaultRoot: join(runRoot, 'vault'),
    statePath: join(runRoot, 'state.sqlite'),
    checkpointRoot,
    entryControlRoot: join(controlRoot, 'entry', 'entry-control'),
    // The bundled first-use human approval port writes owner approval documents here (not under entry/).
    approvalDirectory: join(controlRoot, 'approvals'),
    configPath: join(controlRoot, 'application.json'),
    budgetPath: join(runRoot, 'autonomous-budget.json'),
    sourceApprovalPath: join(controlRoot, 'source-approval.json'),
    verificationPath: join(controlRoot, 'verification-synthesis.json'),
    verificationAdmissionPath: join(controlRoot, 'verification', 'admission.json'),
  };
  for (const [label, directory] of [['run root', runRoot], ['control root', controlRoot]] as const) {
    const stat = await lstat(directory).catch(() => undefined);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) deny('CHECKPOINT_DISCOVERY', `${label} is missing or not a real directory`);
  }
  const checkpointStat = await lstat(layout.checkpointRoot).catch(() => undefined);
  if (!checkpointStat || !checkpointStat.isDirectory() || checkpointStat.isSymbolicLink()) {
    deny('CHECKPOINT_DISCOVERY', 'no controller checkpoint directory exists for this run');
  }
  return layout;
}

/** Discover the interrupted run from the private `runs/` scan and its own persisted controller records. */
export async function discoverInterruptedControllerRun(options: {
  /** Original owner consent path; supplies the controller base when `base` is not given. */
  ownerConfigPath?: string;
  runId: string;
  /** Controller base for a fresh-process restart, where no session owner value exists yet. */
  base?: string;
}): Promise<ControllerRunDiscovery> {
  if (!options.base && !options.ownerConfigPath) deny('CHECKPOINT_ROOT', 'restore discovery needs the controller base or the original owner consent path');
  const base = options.base
    ? canonicalDirectory(options.base, 'controller base')
    : controllerBaseForOwnerConfig(options.ownerConfigPath!);
  const runId = text(options.runId, 'runId');
  const runsRoot = join(base, 'runs');
  const entries = await readdir(runsRoot).catch(() => undefined);
  if (!entries) deny('CHECKPOINT_DISCOVERY', 'the controller runs directory does not exist; no run can be restored');
  const matches: string[] = [];
  for (const entry of entries.slice(0, MAX_RUN_DIRECTORIES).sort()) {
    if (!RUN_DIRECTORY.test(entry)) continue;
    const candidate = join(runsRoot, entry);
    // An unreadable record for another run never blocks this run's discovery; the matched layout below is
    // re-read strictly, so a corrupt matching record still refuses instead of being skipped.
    const config = await privateJson(join(candidate, 'control', 'application.json')).catch(() => undefined);
    if (!config) continue;
    const run = (config as { run?: { runId?: unknown } }).run;
    if (run?.runId === runId) matches.push(candidate);
  }
  if (matches.length !== 1) {
    deny('CHECKPOINT_DISCOVERY', matches.length === 0
      ? `no controller run ${runId} is present under controller-owned run metadata`
      : `more than one controller run claims identity ${runId}; ambiguous restore is refused`);
  }
  const layout = await resolveControllerRunLayout({ runId, runRoot: matches[0]!, base });
  const rawConfig = await privateJson(layout.configPath);
  if (!rawConfig) deny('CHECKPOINT_DISCOVERY', 'the controller application record is missing');
  const config = rawConfig as ApplicationConfigWithSpend;
  const roots = record(config.roots, 'application roots');
  if (config.schemaVersion !== 1 || config.mode !== 'authorized-assessment') deny('CHECKPOINT_DISCOVERY', 'the persisted controller application is not a bundled first-use assessment');
  if (config.run?.runId !== runId) deny('CHECKPOINT_DISCOVERY', 'the persisted application run identity does not match the requested run');
  if (roots.state !== layout.statePath || roots.control !== layout.controlRoot || roots.workspace !== layout.workspaceRoot
    || roots.vault !== layout.vaultRoot) {
    deny('CHECKPOINT_DISCOVERY', 'the persisted application roots do not match the controller run layout');
  }
  const budget = await privateJson(layout.budgetPath);
  const parsed = record(budget, 'pinned autonomous budget');
  if (parsed.outcome !== 'ready' || parsed.policy !== 'isolated-phase-caps-no-borrowing') {
    deny('CHECKPOINT_BUDGET', 'the original autonomous budget is partial or missing; explicit owner extension is required and no budget is reset');
  }
  if (parsed.ownerLimits === undefined || parsed.phases === undefined || parsed.prices === undefined) {
    deny('CHECKPOINT_BUDGET', 'the pinned autonomous budget is incomplete; a fresh allocation is never synthesized');
  }
  return {
    layout,
    config,
    configDigest: digestJson(config as unknown as import('../../contracts/index.js').JsonValue),
    budget: parsed as unknown as ControllerRunDiscovery['budget'],
  };
}

/**
 * Durable kernel identities of every controller that ever opened this run's container/evidence plane.
 *
 * The controller owner writes one durable session lease (`owner.process`) per controller instance before it
 * preflights anything, so this is the only durable record that ties the run's exclusive writers to an exact
 * kernel process. A lease without a usable identity is a hard refusal: ownership must never be guessed.
 */
export async function readControllerKernelIdentities(layout: ControllerRunLayout): Promise<ProcessIdentity[]> {
  const root = join(layout.controlRoot, 'container-controller-sessions');
  const names = await readdir(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw error;
  });
  const identities = new Map<string, ProcessIdentity>();
  for (const name of names.filter(entry => /^lease-[a-f0-9]{64}\.json$/.test(entry)).sort().slice(0, MAX_RUN_DIRECTORIES)) {
    const raw = record(await privateJson(join(root, name)), 'controller session lease');
    const owner = record(raw.owner, 'controller session lease owner');
    const process = record(owner.process, 'controller session lease owner process');
    const pid = process.pid, bootId = process.bootId, startTicks = process.startTicks;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof bootId !== 'string' || bootId.length < 8 || bootId.length > 256
      || typeof startTicks !== 'string' || !/^\d+$/.test(startTicks)) {
      deny('CHECKPOINT_RESOURCE', 'a durable controller session lease has no exact kernel owner identity; an unowned writer lock is never removed');
    }
    identities.set(`${String(pid)}:${bootId}:${startTicks}`, process as unknown as ProcessIdentity);
  }
  return [...identities.values()];
}

/**
 * Release the evidence vault's exclusive supervisor writer lock after a proven-quiescent restart.
 *
 * The lock file itself carries only random bytes, so ownership is never inferred from the file. Restart
 * requires, in order: the exact controller-owned vault root from the validated layout; every durable controller
 * kernel identity recorded in the run's own controller session leases; and `/proc` proof that all of them are
 * dead. It then re-validates the vault directory inode and the writer inode immediately around the removal
 * (opening the directory with `O_DIRECTORY|O_NOFOLLOW`), and syncs the directory exactly like
 * `EvidenceVault.close()` does. Unknown or live ownership refuses with no mutation. The controller container
 * sweep (`createControllerContainerOwner`) is NOT such a proof: a lease whose owner is alive is reported
 * `skipped-live-owner` and `swept.verified` only ignores `unverifiable` entries (`src/runtime/sessions.ts`),
 * so it stays true while the old controller still runs.
 */
export async function releaseStaleVaultWriter(options: {
  layout: ControllerRunLayout;
  config: ApplicationConfigWithSpend;
}): Promise<void> {
  const { layout, config } = options;
  if (config.roots.vault !== layout.vaultRoot) {
    deny('CHECKPOINT_ROOT', 'the persisted evidence vault is not the controller-owned vault directory for this run');
  }
  const vaultRoot = layout.vaultRoot;
  const directory = await lstat(vaultRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!directory) return; // the original controller never opened a vault writer
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || (process.getuid && directory.uid !== process.getuid())) {
    deny('CHECKPOINT_RESOURCE', 'the evidence vault root is not an owner-only real directory; restart never touches a foreign vault');
  }
  const writerPath = join(vaultRoot, '.writer');
  const writer = await lstat(writerPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!writer) return;
  if (!writer.isFile() || writer.isSymbolicLink() || writer.nlink !== 1 || writer.size > 1024 || (writer.mode & 0o077) !== 0
    || (process.getuid && writer.uid !== process.getuid())) {
    deny('CHECKPOINT_RESOURCE', 'the evidence vault writer lock is not a safe owner-only regular file; restart never removes a foreign lock');
  }
  // 1. Every durable controller process of this run must be provably dead before its vault writer is released.
  const identities = await readControllerKernelIdentities(layout);
  if (!identities.length) {
    deny('CHECKPOINT_RESOURCE', 'no durable controller kernel identity is recorded for this run; a writer lock with unknown ownership is never removed');
  }
  let rows: Awaited<ReturnType<LinuxProcessProbe['snapshot']>>;
  try { rows = await new LinuxProcessProbe().snapshot(); }
  catch { deny('CHECKPOINT_RESOURCE', 'controller liveness could not be determined from /proc; refusing to remove the vault writer'); }
  if (identities.some(identity => rows.some(row => sameProcess(row, identity) && alive(row)))) {
    deny('CHECKPOINT_RESOURCE', 'the original controller process is still live; its evidence vault writer is never removed');
  }
  // 2. Re-validate the directory and writer identities immediately around the removal and defend the path race
  //    by holding the directory open with O_DIRECTORY|O_NOFOLLOW while the name is unlinked.
  const handle = await open(vaultRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const before = await lstat(vaultRoot);
    if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino
      || before.dev !== directory.dev || before.ino !== directory.ino) {
      deny('CHECKPOINT_RESOURCE', 'the evidence vault directory identity changed during restart; writer lock left untouched');
    }
    const writerNow = await lstat(writerPath);
    if (writerNow.dev !== writer.dev || writerNow.ino !== writer.ino || writerNow.nlink !== 1 || !writerNow.isFile()) {
      deny('CHECKPOINT_RESOURCE', 'the evidence vault writer lock changed identity during restart; writer lock left untouched');
    }
    await unlink(writerPath);
    const gone = await lstat(writerPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const after = await lstat(vaultRoot);
    if (gone || !after.isDirectory() || after.dev !== directory.dev || after.ino !== directory.ino) {
      deny('CHECKPOINT_RESOURCE', 'the evidence vault writer lock removal could not be confirmed on the validated directory identity');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Reconstruct the exact owner of an interrupted run in a process that has no session onboarding value.
 *
 * `/p2o resume` can be the first command of a fresh Pi session, so the run's own durable consent copy
 * (`consent-inputs/owner-consent.json`, written by the original human onboarding) is matched by configuration
 * digest against the owner-private consent bundles in the owner storage root. The saved effective limits and
 * permissions are accepted only when `consentCovers` proves they still narrow the current, unexpired bundle;
 * every later gate (`revalidateOwner`, the owner-ledger gate) re-reads the current consent again. Nothing is
 * widened, synthesized or taken from the checkpoint.
 */
export async function readControllerOwnerFromDurableConsent(options: {
  layout: ControllerRunLayout;
  storageRoot: string;
}): Promise<OnboardingReady> {
  const storageRoot = canonicalDirectory(options.storageRoot, 'owner storage root');
  const saved = record(await privateJson(join(options.layout.runRoot, 'consent-inputs', 'owner-consent.json')), 'durable owner consent copy');
  const configuration = record(saved.configuration, 'durable owner configuration') as unknown as OnboardingReady['configuration'];
  const limits = record(saved.effectiveLimits, 'durable owner effective limits');
  const permissions = record(saved.effectivePermissions, 'durable owner effective permissions');
  const digest = configurationDigest(configuration);
  const entries = await readdir(storageRoot).catch(() => undefined);
  if (!entries) deny('OWNER_ONBOARDING_REQUIRED', 'the owner storage root is missing; a fresh-process restart needs the original human consent bundle');
  const load = async (path: string): Promise<Awaited<ReturnType<typeof readOwnerConsent>> | undefined> => {
    try { return await readOwnerConsent(path); } catch { return undefined; }
  };
  for (const entry of entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().slice(0, MAX_RUN_DIRECTORIES)) {
    const path = join(storageRoot, entry);
    const bundle = await load(path);
    if (!bundle || configurationDigest(bundle.configuration) !== digest) continue;
    const configurationLimits = bundle.configuration.limits as unknown as Record<string, unknown>;
    const configurationPermissions = bundle.configuration.permissions as unknown as Record<string, unknown>;
    if (Object.keys(limits).length !== Object.keys(configurationLimits).length
      || Object.keys(configurationLimits).some(key => typeof limits[key] !== typeof configurationLimits[key])) {
      deny('OWNER_ONBOARDING_REQUIRED', 'the durable owner effective limits are incomplete or widened; explicit human consent is required');
    }
    if (Object.keys(permissions).length !== Object.keys(configurationPermissions).length
      || Object.keys(configurationPermissions).some(key => typeof permissions[key] !== 'boolean')) {
      deny('OWNER_ONBOARDING_REQUIRED', 'the durable owner effective permissions are incomplete; explicit human consent is required');
    }
    const effectiveLimits = Object.freeze({ ...limits }) as unknown as OnboardingReady['effectiveLimits'];
    const effectivePermissions = Object.freeze({ ...permissions }) as unknown as OnboardingReady['effectivePermissions'];
    if (!consentCovers(bundle.configuration, bundle.configuration.scope, effectiveLimits, effectivePermissions, Date.now())) {
      deny('OWNER_ONBOARDING_REQUIRED', 'the saved owner consent no longer covers the interrupted run (expired or widened); explicit human consent is required');
    }
    return Object.freeze({ status: 'ready', configuration: bundle.configuration, configPath: path, receiptPath: path, reused: true, effectiveLimits, effectivePermissions });
  }
  deny('OWNER_ONBOARDING_REQUIRED', 'no current owner consent bundle matches the interrupted run; explicit human consent is required');
}

async function readStoredEntryPlan(layout: ControllerRunLayout, planId: string): Promise<StoredEntryPlan> {
  const store = createEntryPlanStore({
    root: layout.entryControlRoot,
    digestOf: recordValue => sealPlanDigest({
      preparation: recordValue.preparation,
      steps: recordValue.plan.steps,
      packet: recordValue.packet,
      proposalId: recordValue.proposalId,
      proposalDigest: recordValue.proposalDigest,
    }),
  });
  const stored = await store.read(planId);
  if (!stored) deny('CHECKPOINT_APPROVAL', 'the sealed original entry plan is absent; a lost entry ledger is never reconstructed from a checkpoint');
  const admitted = await store.admitted(stored.planId);
  if (!admitted || admitted.runId !== stored.runId) deny('CHECKPOINT_APPROVAL', 'the original entry plan has no matching admission record');
  if (stored.packet.kind !== 'owner-menu') deny('CHECKPOINT_SOURCE_ROOT', 'the bundled restart seam restores approved source runs; generated-request runs are refused');
  return stored;
}

/**
 * Reconstruct the exact approved source request from the original controller records.
 *
 * Every input is authoritative on its own: the entry store re-derives the sealed plan digest, the owner
 * approval document is owner-only canonical bytes, the run comes from the durable store, and the source pin
 * comes from the controller's own pre-checkpoint `source-approval.json`. The checkpoint's source identity is
 * never used as an approval source; it is only allowed to confirm the same pinned digest.
 */
export async function readControllerApprovedRequest(options: {
  layout: ControllerRunLayout;
  store: DurableStore;
  planId: string;
}): Promise<{ request: ApprovedSourceRequest; stored: StoredEntryPlan }> {
  const { layout, store } = options;
  const stored = await readStoredEntryPlan(layout, text(options.planId, 'planId'));
  const durableRun = store.getRun(stored.runId);
  if (!durableRun) deny('CHECKPOINT_APPROVAL', 'the durable admitted run is missing; a lost ledger is never reconstructed');
  const rawSourceApproval = await privateJson(layout.sourceApprovalPath);
  if (rawSourceApproval === undefined) deny('CHECKPOINT_APPROVAL', 'the original controller source approval record is absent; the source pin cannot be re-derived from a checkpoint');
  const sourceApproval = record(rawSourceApproval, 'source approval record');
  if (sourceApproval.sourceUIConfirmed !== true) deny('CHECKPOINT_APPROVAL', 'the original controller source approval was not UI-confirmed');
  const identity = record(sourceApproval.source, 'source identity');
  if (identity.runId !== stored.runId || identity.scopeDigest !== stored.preparation.scopeDigest || identity.planDigest !== stored.plan.digest) {
    deny('CHECKPOINT_APPROVAL', 'the controller source approval record does not bind this exact sealed plan');
  }
  const approvalDocument = planApprovalDocumentSchema.parse(
    readOwnerDocument(entryOwnerApprovalPath(layout.approvalDirectory, 'plan', stored.proposalDigest), 'owner plan approval'),
  ) as PlanApprovalDocument;
  if (approvalDocument.runId !== stored.runId || approvalDocument.proposalId !== stored.proposalId || approvalDocument.proposalDigest !== stored.proposalDigest) {
    deny('CHECKPOINT_APPROVAL', 'the owner approval document is not bound to this sealed proposal');
  }
  if (sourceApproval.approvalRef !== approvalDocument.reference) deny('CHECKPOINT_APPROVAL', 'the controller source approval reference differs from the owner approval document');
  if (Date.parse(approvalDocument.expiresAt) <= Date.now()) deny('CHECKPOINT_APPROVAL', 'the original owner approval expiry has passed; restart never renews approval');

  const run = structuredClone(durableRun);
  const preparationTarget = stored.preparation.target;
  const target = run.authorization.targets.find(candidate => candidate.locator === preparationTarget.locator
    && (candidate.kind === 'artifact' || candidate.kind === 'lab'));
  if (!target) deny('CHECKPOINT_APPROVAL', 'the durable run no longer carries the owner-approved target locator');
  const kind = text(identity.kind, 'source kind');
  if (kind !== 'local-dir' && kind !== 'github-repo') deny('CHECKPOINT_SOURCE_ROOT', 'the controller source approval names an unsupported source kind');
  // The durable target kind is left exactly as the original plan admitted it (`lab` for bundled sources): the
  // owner ledger compares the approved proposal's target kind against this run, so rewriting it to `artifact`
  // would refuse an otherwise exact original approval. Only the acquired pin is re-composed.
  target.digest = text(identity.digest, 'source digest');
  target.revision = typeof identity.revision === 'string' ? identity.revision : target.digest;
  const request: ApprovedSourceRequest = {
    run,
    preparation: structuredClone(stored.preparation),
    plan: structuredClone(stored.plan),
    approval: {
      channel: 'human-command',
      approvalRef: approvalDocument.reference,
      approvedAt: approvalDocument.approvedAt,
      scopeDigest: stored.preparation.scopeDigest,
      planDigest: stored.plan.digest,
    },
  };
  try {
    validateSourceApproval(request);
  } catch (error) {
    deny('CHECKPOINT_APPROVAL', `the reconstructed approved request is not consistent: ${error instanceof Error ? error.message.slice(0, 300) : 'invalid'}`);
  }
  return { request, stored };
}

/**
 * Existing owner-ledger gate re-bound to the current owner consent and the exact sealed plan.
 *
 * The gate re-reads the current consent bundle, requires the exact original owner configuration digest and
 * the original run budget/window coverage, then re-runs the real plan-ledger approval against the owner-only
 * canonical document. It is called before acquisition, before mounting and again before restore publication,
 * so a consent change, an expired approval or a replaced owner document is refused at every stage.
 */
export function createControllerOwnerGate(options: {
  layout: ControllerRunLayout;
  config: ApplicationConfigWithSpend;
  ownerConfigPath: string;
  ownerConfigurationDigest: string;
}): SourceOwnerGate {
  const authority = createOwnerDirectoryAuthority({
    grant: ownerGrantFor(options.config),
    directory: options.layout.approvalDirectory,
  });
  const ledger = createPlanLedger({ controlRoot: options.layout.controlRoot, authority });
  return async (request: ApprovedSourceRequest): Promise<void> => {
    const owner = await readOwnerConsent(options.ownerConfigPath);
    if (configurationDigest(owner.configuration) !== options.ownerConfigurationDigest) {
      deny('CHECKPOINT_CONSENT', 'owner consent changed since the original checkpoint; explicit re-approval is required');
    }
    const stored = await readStoredEntryPlan(options.layout, request.plan.planId);
    if (stored.runId !== request.run.runId || stored.plan.digest !== request.plan.digest || stored.preparation.scopeDigest !== request.preparation.scopeDigest) {
      deny('CHECKPOINT_APPROVAL', 'the owner gate refuses a request that does not match the sealed entry plan');
    }
    const document = planApprovalDocumentSchema.parse(
      readOwnerDocument(entryOwnerApprovalPath(options.layout.approvalDirectory, 'plan', stored.proposalDigest), 'owner plan approval'),
    );
    const approved = await ledger.approve({ run: request.run, proposalDigest: stored.proposalDigest, document });
    if (!approved.ok) {
      deny('CHECKPOINT_APPROVAL', `the owner plan ledger refused the restored approval (${approved.code}): ${approved.issues.map(issue => issue.message).join('; ').slice(0, 300)}`);
    }
    const limits = owner.configuration.limits;
    if (!consentCovers(owner.configuration, owner.configuration.scope, {
      maxCostUsd: request.run.budgets.maxCostUsd, maxRequests: request.run.budgets.maxRequests, maxTokens: request.run.budgets.maxTokens,
      maxToolCalls: request.run.budgets.maxToolCalls, maxAttempts: request.run.budgets.maxAttempts,
      deadlineMs: Date.parse(request.run.budgets.deadlineAt), concurrency: request.run.budgets.maxConcurrency,
    }, owner.configuration.permissions) || limits.deadlineMs <= Date.now()) {
      deny('CHECKPOINT_CONSENT', 'current owner consent no longer covers the original run budget/deadline');
    }
  };
}

/** Read the deferred-verifier state of one interrupted run and either reconstruct it or refuse it. */
export async function inspectVerifierRestartState(options: {
  layout: ControllerRunLayout;
  store: DurableStore;
  config: ApplicationConfigWithSpend;
  owner: OnboardingReady;
}): Promise<VerifierRestartVerdict> {
  const { layout, store, config, owner } = options;
  const deferred = config.tasks.find(task => task.deferred === true && task.role === 'verifier');
  const synthesis = await privateJson(layout.verificationPath);
  if (!deferred && synthesis === undefined) return { kind: 'none', reason: 'the owner document authorizes no deferred verifier program' };
  const parsed = synthesis === undefined ? undefined : record(synthesis, 'verification synthesis record');
  if (parsed !== undefined && parsed.supported !== true) {
    return { kind: 'none', reason: 'the original derivation refused to build a verifier program from the owner-approved checks' };
  }
  if (!deferred) {
    return { kind: 'refused', code: 'CHECKPOINT_VERIFIER_STATE',
      reason: 'a verification synthesis record exists but the owner document carries no deferred verifier task; the restart state is inconsistent and cannot be skipped' };
  }
  if (parsed === undefined) {
    return { kind: 'refused', code: 'CHECKPOINT_VERIFIER_STATE',
      reason: 'a deferred verifier task exists without its controller verification synthesis record; the derived program identity cannot be proven' };
  }
  const producerTask = config.tasks.find(task => task.deferred !== true);
  if (!producerTask) return { kind: 'refused', code: 'CHECKPOINT_VERIFIER_STATE', reason: 'no producer task exists for the deferred verifier program' };
  const verifierTaskId = deferred.manifest.taskId;
  const admission = await privateJson(layout.verificationAdmissionPath);
  const admittedProducer = store.listResults(config.run.runId).some(result => result.decision.status === 'accepted' && result.taskId === producerTask.manifest.taskId);
  const durableVerifierState = Boolean(store.getTask(verifierTaskId))
    || store.listAttempts(config.run.runId).some(attempt => attempt.taskId === verifierTaskId)
    || store.listEvidence(config.run.runId).some(evidence => evidence.taskId === verifierTaskId)
    || admission !== undefined;
  if (admittedProducer || durableVerifierState) {
    return { kind: 'refused', code: 'CHECKPOINT_VERIFIER_STATE',
      reason: admittedProducer
        ? 'a producer packet was already accepted, so the post-admission dynamic finding/check/replay registries may exist; they cannot be reconstructed from durable accepted evidence here and skipping the verifier is refused'
        : 'verifier admission/attempt/evidence already exists durably; its exact dynamic identity cannot be reconstructed from durable accepted evidence here and silently skipping it is refused' };
  }
  // Pre-admission only: the dynamic registries are provably empty, so the deterministic derivation must
  // reproduce the exact durable task/finding/claim identity before the schedule may be reinstated.
  const derivedAt = text(parsed.derivedAt, 'verification derivedAt');
  const verifierBudget: FirstUseVerificationBudget = {
    maxRequests: owner.effectiveLimits.maxRequests,
    maxToolCalls: owner.effectiveLimits.maxToolCalls,
    maxTokens: (parsed.protectedReserve as { maxTokens?: unknown } | undefined)?.maxTokens as number,
    maxCostUsd: (parsed.protectedReserve as { maxCostUsd?: unknown } | undefined)?.maxCostUsd as number,
  };
  if (!Number.isSafeInteger(verifierBudget.maxTokens) || !Number.isFinite(verifierBudget.maxCostUsd)) {
    return { kind: 'refused', code: 'CHECKPOINT_VERIFIER_STATE', reason: 'the protected verifier reserve is missing from the durable synthesis record' };
  }
  const planned = deriveFirstUseVerificationPlan({
    run: config.run,
    producerTask: producerTask.manifest,
    targetId: text(config.run.authorization.targets[0]?.id, 'targetId'),
    targetLocator: text(config.run.authorization.targets[0]?.locator, 'targetLocator'),
    checks: config.checks ?? [],
    workspaceRoot: layout.workspaceRoot,
    verifierBudget,
    now: derivedAt,
    verifierTaskCreatedAt: derivedAt,
  });
  if (!planned.supported) {
    return { kind: 'refused', code: 'CHECKPOINT_VERIFIER_STATE', reason: `the recorded verifier program is no longer derivable: ${planned.reason}` };
  }
  const mismatch = planned.draft.verifierTask.taskId !== verifierTaskId
    || (typeof parsed.verifierTaskId === 'string' && parsed.verifierTaskId !== verifierTaskId)
    || (typeof parsed.findingId === 'string' && parsed.findingId !== planned.draft.finding.findingId)
    || (typeof parsed.claimDigest === 'string' && parsed.claimDigest !== digestJson(planned.draft.finding.claim))
    || canonicalJson(planned.draft.verifierTask) !== canonicalJson(deferred.manifest);
  if (mismatch) {
    return { kind: 'refused', code: 'CHECKPOINT_VERIFIER_STATE',
      reason: 'the re-derived verifier task/finding/claim identity differs from the durable owner-authorized identity; reinstating a different program is refused' };
  }
  return {
    kind: 'pre-admission',
    schedule: {
      producerTaskId: producerTask.manifest.taskId,
      verifierTaskId,
      targetId: config.run.authorization.targets[0]!.id,
      targetLocator: config.run.authorization.targets[0]!.locator,
      budget: verifierBudget,
      derivedAt,
    },
    reason: 'no producer packet or verifier admission exists yet; the exact owner-authorized verifier program was re-derived and matches the durable synthesis record',
  };
}

// ------------------------------------------------------------------------------------------------
// Physical resource reconciliation
// ------------------------------------------------------------------------------------------------

export interface PhysicalReconcileResult {
  status: 'quiescent' | 'unknown' | 'running';
  observations: ReconciliationObservation[];
  report?: ReconciliationReport;
}

/** Persisted runtime identity only: no credential, header or provider secret is part of it. */
export interface PhysicalReconcileRuntime {
  adapter: string;
  piBinary: string;
  gateway: ModelGateway;
  sandbox: { mode: string; enginePath?: '/usr/bin/docker' | '/usr/local/bin/docker'; engineVersion?: string };
  /** Controller-pinned guardian/receipt entry points; defaults to the runtime module's own compiled files. */
  runtimePaths?: { guardianPath?: string; receiptExtensionPath?: string; nodeBinary?: string };
}

export interface PhysicalReconcileOptions {
  store: DurableStore;
  layout: ControllerRunLayout;
  runId: string;
  runtime: PhysicalReconcileRuntime;
  /** Trusted test/qualification seam: the real adapters the composition would have built. */
  runtimes?: Record<string, RuntimeAdapter>;
  log?: (message: string) => void;
}

/**
 * The same durable runtime-hook contract the supervisor exposes, re-bound to the restarted controller.
 *
 * `claim` refuses (a reconciler never creates a writer), `release` is a no-op because the durable store owns
 * the workspace lease, `persistHandle` refuses an owner-token change, `loadHandle` requires both the launch
 * and handle records to agree, `emit` writes bounded durable events, and `validateResume` never approves a new
 * attempt. This is exactly the code the composition already relies on; no empty or synthetic hook is used.
 */
function durableRuntimeHooks(controlRoot: string, store: DurableStore): RuntimeHooks {
  const files = new ControlFiles(controlRoot);
  return Object.freeze({
    async claim(): Promise<boolean> { return false; },
    async release(): Promise<void> { /* the durable store owns the workspace lease */ },
    async persistHandle(handle: RuntimeHandle): Promise<void> {
      const existing = files.read<RuntimeHandle>('handles', handle.attemptId);
      if (existing && existing.ownerToken !== handle.ownerToken) throw new Error('restart-reconcile: stale runtime handle owner token');
      files.write('handles', handle.attemptId, handle, 4 * 1024 * 1024);
    },
    async loadHandle(identity: Pick<RuntimeHandle, 'runId' | 'taskId' | 'attemptId'>): Promise<RuntimeHandle | undefined> {
      const launch = files.read<{ version?: number; request?: { workspace?: unknown; scopeDigest?: unknown; inputDigest?: unknown; deadlineAt?: unknown } }>('launches', identity.attemptId);
      const handle = files.read<RuntimeHandle>('handles', identity.attemptId);
      if (!launch || !handle) return undefined;
      if (launch.version !== 1 || handle.version !== 1) return undefined;
      if (handle.runId !== identity.runId || handle.taskId !== identity.taskId || handle.attemptId !== identity.attemptId) return undefined;
      const request = launch.request;
      if (!request || handle.workspace !== request.workspace || handle.scopeDigest !== request.scopeDigest
        || handle.inputDigest !== request.inputDigest || handle.deadlineAt !== request.deadlineAt) return undefined;
      return handle;
    },
    async emit(handle: RuntimeHandle, event: RuntimeEvent): Promise<void> {
      store.appendEvent({
        runId: handle.runId, taskId: handle.taskId, attemptId: handle.attemptId, type: 'orchestrator.runtime-event',
        payload: { attemptId: handle.attemptId, cursor: event.cursor, event: event.type.slice(0, 64) },
      });
    },
    async validateResume(): Promise<boolean> { return false; },
  });
}

function durableLaunch(control: ControlFiles, attemptId: string): { handle: RuntimeHandle; adapterKind: string; leaseToken: string } | undefined {
  const handle = control.read<RuntimeHandle>('handles', attemptId);
  const launch = control.read<{ version?: number; adapterKind?: unknown; leaseToken?: unknown; request?: { attemptId?: unknown } }>('launches', attemptId);
  if (!handle || !launch) return undefined;
  if (handle.version !== 1 || handle.attemptId !== attemptId || typeof handle.ownerToken !== 'string') return undefined;
  if (launch.version !== 1 || launch.request?.attemptId !== attemptId) return undefined;
  return { handle, adapterKind: typeof launch.adapterKind === 'string' ? launch.adapterKind : handle.kind, leaseToken: typeof launch.leaseToken === 'string' ? launch.leaseToken : '' };
}

function terminalLifecycleFor(handle: RuntimeHandle, packetAccepted: boolean): 'exited' | 'failed' {
  const reason = handle.stopReceipt?.reason;
  return packetAccepted && (reason === 'completed' || reason === 'checkpoint') ? 'exited' : 'failed';
}

/**
 * Real physical reconciliation of one run's owned execution and pack resources.
 *
 * The adapter is the real managed runtime over the ORIGINAL control root, so it re-adopts only the exact
 * processes carrying this attempt's durable control markers, verifies kernel identity, sweeps stale session
 * leases through the registered pack families (container daemon/label/incarnation checks) and emits
 * collector-trusted receipts. Anything short of a proven terminal verdict is `unknown`/`running`: no PID is
 * killed, no foreign resource is touched and no fake quiescence is produced.
 */
export async function reconcileOwnedResourcesPhysically(options: PhysicalReconcileOptions): Promise<PhysicalReconcileResult> {
  const { store, layout, runId, runtime } = options;
  const run = store.getRun(runId);
  if (!run || run.state !== 'active') return { status: 'unknown', observations: [] };
  const runtimes = options.runtimes ?? {};
  try {
    if (!options.runtimes) {
      if (runtime.adapter !== 'headless' || runtime.sandbox.mode !== 'container' || !runtime.sandbox.enginePath || !runtime.sandbox.engineVersion) {
        options.log?.(`restart-reconcile refused: runtime ${runtime.adapter}/${runtime.sandbox.mode} has no qualified physical reconciler`);
        return { status: 'unknown', observations: [] };
      }
      const adapter = createOwnedHeadlessRuntime({
        controlRoot: layout.controlRoot,
        piBinary: runtime.piBinary,
        hooks: durableRuntimeHooks(layout.controlRoot, store),
        // Persisted gateway identity only: no credential exists in the controller record and none is needed
        // to inspect or terminate already-dispatched execution.
        gateway: runtime.gateway,
        ...(runtime.runtimePaths?.guardianPath ? { guardianPath: runtime.runtimePaths.guardianPath } : {}),
        ...(runtime.runtimePaths?.receiptExtensionPath ? { receiptExtensionPath: runtime.runtimePaths.receiptExtensionPath } : {}),
        ...(runtime.runtimePaths?.nodeBinary ? { nodeBinary: runtime.runtimePaths.nodeBinary } : {}),
      });
      const registry = (adapter as unknown as { sessions?: SessionReleaseRegistry }).sessions;
      if (!registry) return { status: 'unknown', observations: [] };
      // The pinned engine identity is re-read from the durable application record; a missing/changed
      // engine makes `recoverContainerResources` refuse instead of guessing a new one.
      const engine = { enginePath: runtime.sandbox.enginePath, engineVersion: runtime.sandbox.engineVersion };
      registerPackSessionFamily(registry, {
        name: 'container-pack',
        // A restarted controller holds no live sandbox instance; recovery must go through the durable
        // daemon/label/incarnation checks, never through an empty in-memory responder.
        lookup: () => undefined,
        recover: (resources, scope, owner) => recoverContainerResources(resources, scope, owner, engine),
        shutdown: async () => {},
      });
      runtimes[runtime.adapter] = adapter;
    }

    const observations: ReconciliationObservation[] = [];
    let status: PhysicalReconcileResult['status'] = 'quiescent';
    const tasks = new Map(store.listTasks(runId).map(task => [task.taskId, task]));
    const control = new ControlFiles(layout.controlRoot);
    let sawLease = false;
    for (const task of tasks.values()) {
      const lease = store.getLease(task.taskId);
      if (!lease) continue;
      sawLease = true;
      const attempt = store.getAttempt(lease.attemptId);
      if (!attempt) { status = 'unknown'; continue; }
      const launch = durableLaunch(control, attempt.attemptId);
      const adapter = launch ? runtimes[launch.adapterKind] : undefined;
      if (!launch || !adapter || launch.leaseToken !== lease.token) {
        // The durable launch record is written before any dispatch and the handle before any run; a missing or
        // foreign pair cannot prove that no writer exists, so the resource stays unknown and blocks restore.
        status = status === 'running' ? status : 'unknown';
        continue;
      }
      let receipt: Awaited<ReturnType<RuntimeAdapter['reconcile']>>;
      try {
        receipt = await adapter.reconcile(launch.handle);
      } catch (error) {
        options.log?.(`restart-reconcile: attempt ${attempt.attemptId} reconcile failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
        status = status === 'running' ? status : 'unknown';
        continue;
      }
      if (receipt.state === 'live') { status = 'running'; continue; }
      if (receipt.state !== 'terminated') { status = status === 'running' ? status : 'unknown'; continue; }
      const packetAccepted = task.packetState === 'accepted';
      const notStarted = receipt.handle.launchIntent === false && !attempt.observedRuntime?.processIdentity;
      const lifecycleState = notStarted ? 'failed' : terminalLifecycleFor(receipt.handle, packetAccepted);
      const process = receipt.handle.native.guardian ?? receipt.handle.native.processes[0];
      const observation = notStarted ? 'not-started' : 'terminated';
      // The collector receipt must be timestamped at or after the observation it backs (`runtimeReceipts`).
      const observedAt = new Date().toISOString();
      const evidenceId = admitControllerReceipt({
        files: control, store, controllerId: 'p2o-restart-reconciler',
        environmentId: task.scope.environmentId, configurationDigest: task.scope.configurationDigest,
        inputDigests: [digestJson(task.scope.inputs), digestJson(task.question)],
        handle: receipt.handle, now: new Date().toISOString(),
        observation: {
          observation, status: receipt.handle.status, adapter: receipt.handle.kind,
          requested: { ...receipt.handle.requested }, capabilities: adapter.capabilities as unknown as import('../../contracts/index.js').JsonObject,
          deadlineAt: receipt.handle.deadlineAt,
          ...(process ? { processIdentity: { pid: process.pid, hostId: process.bootId, startToken: process.startTicks } } : {}),
        },
      });
      observations.push({
        attemptId: attempt.attemptId,
        status: notStarted ? 'not-started' : 'terminated',
        observedAt,
        receiptEvidenceIds: [evidenceId],
        terminationConfirmed: true,
        lifecycleState,
        ...(receipt.handle.exit ? { exit: { code: receipt.handle.exit.code, ...(receipt.handle.exit.signal ? { signal: receipt.handle.exit.signal } : {}), observedAt } } : {}),
      });
    }
    // A non-terminal attempt without a lease cannot prove its writer is gone either.
    for (const attempt of store.listAttempts(runId)) {
      if (['exited', 'failed', 'timed-out', 'cancelled'].includes(attempt.lifecycleState)) continue;
      if (!store.getLease(attempt.taskId)) status = status === 'running' ? status : 'unknown';
    }
    let report: ReconciliationReport | undefined;
    if (status === 'quiescent' && observations.length) {
      report = store.reconcileRun(runId, observations);
      if (report.unknown.length || report.resumed.length) status = 'unknown';
    }
    if (status === 'quiescent' && !sawLease) {
      // No lease remains; the ticket's own second reconciliation pass will confirm the empty report.
      report = store.reconcileRun(runId, []);
      if (report.unknown.length || report.resumed.length) status = 'unknown';
    }
    return { status, observations: status === 'quiescent' ? observations : [], ...(report ? { report } : {}) };
  } catch (error) {
    options.log?.(`restart-reconcile unavailable: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
    return { status: 'unknown', observations: [] };
  }
}

/** Prepare phase one: hold the controller claim, re-read approval and inventory, grant nothing yet. */
export async function prepareInterruptedControllerRestore(options: {
  owner: OnboardingReady;
  discovery: ControllerRunDiscovery;
  store?: DurableStore;
  /** Explicit real-adapter seam for qualification tests; production builds the runtime adapter above. */
  runtimes?: Record<string, RuntimeAdapter>;
  log?: (message: string) => void;
}): Promise<ControllerRestorePreparation> {
  const { owner, discovery } = options;
  const { layout, config } = discovery;
  const store = options.store ?? new DurableStore({ path: layout.statePath });
  const verifier = await inspectVerifierRestartState({ layout, store, config, owner });
  if (verifier.kind === 'refused') deny(verifier.code, verifier.reason);
  const ownerConfigurationDigest = configurationDigest(owner.configuration);
  const gate = createControllerOwnerGate({ layout, config, ownerConfigPath: owner.configPath, ownerConfigurationDigest });
  const forbiddenRoots = [
    layout.workspaceRoot, layout.runRoot,
    ...Object.values(config.roots.artifacts),
    join(layout.controlRoot, 'immutable-source'),
    ...config.run.authorization.targets.map(target => target.locator).filter(locator => locator.startsWith('/')),
  ];
  const location: CheckpointLocation = { root: layout.checkpointRoot, forbiddenRoots };
  const ticket = await prepareControllerRestore({
    ...location,
    store,
    runId: layout.runId,
    ownerConfigPath: owner.configPath,
    privateSourceRoot: join(layout.controlRoot, 'immutable-source'),
    readApprovedRequest: planId => readControllerApprovedRequest({ layout, store, planId }).then(result => result.request),
    authorize: gate,
    reconcileOwnedResources: runId => reconcileOwnedResourcesPhysically({
      store, layout, runId,
      runtime: {
        adapter: config.runtime.adapter,
        piBinary: config.runtime.piBinary,
        gateway: config.runtime.gateway,
        sandbox: config.sandbox.mode === 'container'
          ? { mode: 'container', enginePath: (config.sandbox.options as { enginePath: '/usr/bin/docker' | '/usr/local/bin/docker' }).enginePath, engineVersion: (config.sandbox.options as { engineVersion: string }).engineVersion }
          : { mode: config.sandbox.mode },
      },
      ...(options.runtimes ? { runtimes: options.runtimes } : {}),
      ...(options.log ? { log: options.log } : {}),
    }),
  });
  return { phase: 'reconciliation-required', layout, discovery, verifier, authorize: gate, ticket };
}

/** Confirm that a restored request still describes the same approved source snapshot. */
export function assertRestoredRequestMatches(ready: { request: ApprovedSourceRequest; source: ApprovedSourceSnapshot }): void {
  validateSourceApproval(ready.request);
  assertSourceIdentity(ready.request, ready.source);
}

export type { CheckpointLocation, ControllerRestoreTicket };
export { prepareControllerRestore };
