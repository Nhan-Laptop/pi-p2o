import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, digestJson, type BudgetUsage } from '../../contracts/index.js';
import type { DurableStore } from '../../store/index.js';
import type { ReconciliationObservation } from '../../store/types.js';
import { readOwnerConsent, configurationDigest, consentCovers } from '../onboarding/index.js';
import { assertIssuedSourceSnapshot, copySourceRequest, restoreApprovedSource } from '../source-binding/acquire.js';
import { assertSourceIdentity, type ApprovedSourceRequest, type ApprovedSourceSnapshot, type SourceOwnerGate } from '../source-binding/identity.js';
import { assertSnapshotSeal } from '../entry/snapshot.js';
import { atomicCheckpoint, checkpointDirectory, controllerClaim, deny, MAX_CHECKPOINT_BYTES, readBounded } from './files.js';
export { CheckpointError } from './files.js';

export interface CheckpointLocation {
  root: string;
  /** Controller-selected roots, including original target, snapshots, outputs and all worker roots. */
  forbiddenRoots: readonly string[];
}
export interface ControllerCheckpoint {
  version: 1;
  kind: 'interrupted-controller';
  runId: string;
  ownerConfigurationDigest: string;
  planId: string;
  planDigest: string;
  approvalRef: string;
  authorityDigest: string;
  deadlineAt: string;
  source: ApprovedSourceSnapshot;
  mountDigest: string;
  /** Informational only. Never loaded into the store/budget/attempt session. */
  progress: ReturnType<typeof durableProgress>;
}
function authority(store: DurableStore, runId: string): string {
  const run = store.getRun(runId);
  if (!run) deny('CHECKPOINT_RUN', 'durable run is missing');
  return digestJson({ runId, authorization: run.authorization, budgets: run.budgets, allowedCapabilities: run.allowedCapabilities });
}
export function durableProgress(store: DurableStore, runId: string) {
  const attempts = store.listAttempts(runId);
  const usage: BudgetUsage = { requests: 0, bytes: 0, toolCalls: 0, tokens: 0, costUsd: 0 };
  for (const a of attempts) for (const k of Object.keys(usage) as (keyof BudgetUsage)[]) usage[k] += a.usage[k];
  return {
    usage,
    attempts: attempts.map(a => ({ attemptId: a.attemptId, taskId: a.taskId, sequence: a.sequence, lifecycleState: a.lifecycleState })),
    tasks: store.listTasks(runId).map(t => ({ taskId: t.taskId, lifecycleState: t.lifecycleState, packetState: t.packetState })),
    evidenceIds: store.listEvidence(runId).map(e => e.evidenceId),
    results: store.listResults(runId).map(r => ({ resultId: r.resultId, digest: r.digest, taskId: r.taskId })),
  };
}
function assertDurableHistory(store: DurableStore, cp: ControllerCheckpoint): void {
  const actual = durableProgress(store, cp.runId);
  for (const key of Object.keys(actual.usage) as (keyof BudgetUsage)[]) {
    if (actual.usage[key] < cp.progress.usage[key]) deny('CHECKPOINT_LEDGER', 'durable usage lost previously checkpointed spend; never reset/import counters');
  }
  if (cp.progress.attempts.some(a => !actual.attempts.some(b => a.attemptId === b.attemptId && a.taskId === b.taskId && a.sequence === b.sequence)) ||
      cp.progress.evidenceIds.some(id => !actual.evidenceIds.includes(id)) ||
      cp.progress.results.some(r => !actual.results.some(s => r.resultId === s.resultId && r.digest === s.digest && r.taskId === s.taskId))) {
    deny('CHECKPOINT_LEDGER', 'durable attempts/evidence/results lost checkpointed history');
  }
}
/** Linux mount identity is hashed, not serialized. Detects changed bind mounts even with identical bytes. */
export async function sourceMountDigest(root: string): Promise<string> {
  if (process.platform !== 'linux') deny('CHECKPOINT_MOUNT', 'physical mount identity is currently Linux-only');
  const lines = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n');
  const decode = (s: string) => s.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const relevant = lines.filter(line => { const mount = decode(line.split(' ')[4]!); return mount === '/' || root === mount || root.startsWith(mount + '/'); });
  if (!relevant.length) deny('CHECKPOINT_MOUNT', 'mount identity unavailable');
  return digestJson(relevant);
}
function assertCurrentConsent(owner: Awaited<ReturnType<typeof readOwnerConsent>>, request: ApprovedSourceRequest): void {
  const target = request.preparation.target;
  const b = request.run.budgets;
  if ((target.kind !== 'local-dir' && target.kind !== 'github-repo') || !consentCovers(owner.configuration, {
    target: { kind: target.kind, raw: target.locator, locator: target.locator },
    boundary: target.kind === 'local-dir' ? 'directory-tree-no-symlinks' : 'single-repository',
  }, { maxCostUsd: b.maxCostUsd, maxRequests: b.maxRequests, maxTokens: b.maxTokens, maxToolCalls: b.maxToolCalls,
    maxAttempts: b.maxAttempts, deadlineMs: Date.parse(b.deadlineAt), concurrency: b.maxConcurrency },
    { readStatic: true, repositoryScripts: false, stateChanges: false }) || !owner.configuration.allowedActions.includes('analyze')) {
    deny('CHECKPOINT_CONSENT', 'current owner actions/budget/target do not cover the original run');
  }
}
function active(store: DurableStore, runId: string): void {
  const run = store.getRun(runId);
  if (!run || run.state !== 'active') deny('CHECKPOINT_TERMINAL', 'only interrupted active controllers can restore; stop is terminal cancellation');
  if (Date.now() >= Date.parse(run.budgets.deadlineAt) || Date.now() >= Date.parse(run.authorization.expiresAt)) deny('CHECKPOINT_EXPIRED', 'original absolute deadline/authorization expired');
}
export async function persistControllerCheckpoint(options: CheckpointLocation & {
  store: DurableStore; request: ApprovedSourceRequest; source: ApprovedSourceSnapshot;
  ownerConfigPath: string; authorize: SourceOwnerGate;
}): Promise<{ digest: string; sequence: number }> {
  options = { ...options, forbiddenRoots: [...options.forbiddenRoots], request: copySourceRequest(options.request) };
  const { store, request, source } = options;
  await checkpointDirectory(options.root, [...options.forbiddenRoots, source.seal.root, ...(source.identity.kind === 'local-dir' ? [source.identity.origin] : [])], true);
  const release = await controllerClaim(options.root);
  try {
    active(store, request.run.runId);
    assertIssuedSourceSnapshot(source);
    await options.authorize(request);
    assertSourceIdentity(request, source);
    await assertSnapshotSeal(source.seal);
    const owner = await readOwnerConsent(options.ownerConfigPath);
    if (owner.configuration.limits.deadlineMs <= Date.now()) deny('CHECKPOINT_EXPIRED', 'owner consent expired');
    assertCurrentConsent(owner, request);
    const checkpoint: ControllerCheckpoint = {
      version: 1, kind: 'interrupted-controller', runId: request.run.runId,
      ownerConfigurationDigest: configurationDigest(owner.configuration),
      planId: request.plan.planId, planDigest: request.plan.digest, approvalRef: request.approval.approvalRef,
      authorityDigest: authority(store, request.run.runId), deadlineAt: store.getRun(request.run.runId)!.budgets.deadlineAt,
      source: structuredClone(source), mountDigest: await sourceMountDigest(source.seal.root),
      progress: durableProgress(store, request.run.runId),
    };
    // Strip human/worker free text from the serialized acquisition; identity/seal remain exact.
    checkpoint.source = { ...checkpoint.source, acquisition: { ...checkpoint.source.acquisition, warnings: [] } };
    const digest = digestJson(checkpoint);
    if (Buffer.byteLength(canonicalJson(checkpoint)) > MAX_CHECKPOINT_BYTES - 1024) deny('CHECKPOINT_SIZE', 'checkpoint exceeds bounded envelope');
    // SQLite event is the authoritative integrity anchor. A failed publication is safe, never a rollback/reset.
    const event = store.appendEvent({ runId: checkpoint.runId, type: 'controller.checkpoint', payload: { digest, version: 1, sourceSnapshotDigest: digestJson(checkpoint.source) } });
    await atomicCheckpoint(options.root, canonicalJson({ version: 1, sequence: event.sequence, digest, checkpoint }));
    return { digest, sequence: event.sequence };
  } finally { await release(); }
}

export interface RestorePorts {
  /** MUST re-read exact entry plan + owner approval ledger; never synthesize approval from checkpoint. */
  readApprovedRequest(planId: string): Promise<ApprovedSourceRequest>;
  /** MUST re-read consent actions/budget and exact ledger approval on every call. */
  authorize: SourceOwnerGate;
  /** Physical controller observer/releaser. Must inspect the complete durable container/guardian inventory,
   * verify ownership/incarnation before termination, and never kill an arbitrary stored PID.
   * Unknown, foreign or still-live resources block. The store validates attempt receipt evidence. */
  reconcileOwnedResources(runId: string): Promise<{
    status: 'quiescent' | 'unknown' | 'running'; observations: readonly ReconciliationObservation[];
  }>;
}
/** Phase one holds exclusive controller ownership but grants NO source/launch authority. */
export async function prepareControllerRestore(options: CheckpointLocation & RestorePorts & {
  store: DurableStore; runId: string; ownerConfigPath: string; privateSourceRoot: string;
}) {
  options = { ...options, forbiddenRoots: [...options.forbiddenRoots] };
  await checkpointDirectory(options.root, options.forbiddenRoots);
  const releaseClaim = await controllerClaim(options.root);
  let closed = false;
  const release = async () => { closed = true; await releaseClaim(); };
  try {
    const envelope = JSON.parse(await readBounded(join(options.root, 'checkpoint.json'))) as {
      version: number; sequence: number; digest: string; checkpoint: ControllerCheckpoint;
    };
    const cp = envelope.checkpoint;
    if (envelope.version !== 1 || cp?.version !== 1 || cp.kind !== 'interrupted-controller' || cp.runId !== options.runId ||
        !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || digestJson(cp) !== envelope.digest) deny('CHECKPOINT_CORRUPT', 'checkpoint identity/schema/digest mismatch');
    const event = options.store.listEvents({ afterSequence: envelope.sequence - 1, limit: 1 })[0];
    if (event?.sequence !== envelope.sequence || event.runId !== options.runId || event.type !== 'controller.checkpoint' || event.payload.digest !== envelope.digest) deny('CHECKPOINT_CORRUPT', 'checkpoint is not anchored in this durable store');
    await checkpointDirectory(options.root, [...options.forbiddenRoots, cp.source.seal.root, ...(cp.source.identity.kind === 'local-dir' ? [cp.source.identity.origin] : [])]);
    const expectedSource = join(options.privateSourceRoot, `run-${digestJson({ runId: cp.runId, scopeDigest: cp.source.identity.scopeDigest }).slice(0, 32)}`, 'source');
    if (cp.source.seal.root !== expectedSource) deny('CHECKPOINT_SOURCE_ROOT', 'checkpoint snapshot is not in the configured immutable source root');
    const validate = async () => {
      active(options.store, options.runId);
      assertDurableHistory(options.store, cp);
      if (cp.authorityDigest !== authority(options.store, options.runId) || cp.deadlineAt !== options.store.getRun(options.runId)!.budgets.deadlineAt) deny('CHECKPOINT_AUTHORITY', 'original run budgets/authorization changed');
      const owner = await readOwnerConsent(options.ownerConfigPath);
      if (configurationDigest(owner.configuration) !== cp.ownerConfigurationDigest || owner.configuration.limits.deadlineMs <= Date.now()) deny('CHECKPOINT_CONSENT', 'owner consent changed or expired; explicit re-approval required');
      const request = copySourceRequest(await options.readApprovedRequest(cp.planId));
      if (request.run.runId !== cp.runId || request.plan.planId !== cp.planId || request.plan.digest !== cp.planDigest || request.approval.approvalRef !== cp.approvalRef) deny('CHECKPOINT_APPROVAL', 'exact original plan approval is missing/changed');
      assertCurrentConsent(owner, request);
      await options.authorize(request);
      assertSourceIdentity(request, cp.source);
      try { await assertSnapshotSeal(cp.source.seal); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') deny('CHECKPOINT_SOURCE_MISSING', 'existing immutable snapshot is absent; blocked pending explicit owner re-approval, never re-clone HEAD');
        throw e;
      }
      if (await sourceMountDigest(cp.source.seal.root) !== cp.mountDigest) deny('CHECKPOINT_MOUNT', 'approved source mount changed; re-approval required');
      return request;
    };
    await validate();
    let consumed = false;
    let reconciling = false;
    return Object.freeze({
      phase: 'reconciliation-required' as const,
      runId: cp.runId,
      async close() {
        if (reconciling) deny('CHECKPOINT_BUSY', 'cannot release the controller claim during in-flight reconciliation');
        await release();
      },
      async reconcile() {
        if (consumed || closed) deny('CHECKPOINT_USED', 'restore ticket is single-use and cannot be used after close');
        consumed = true;
        reconciling = true;
        try {
          await validate();
          const proof = await options.reconcileOwnedResources(cp.runId);
          if (proof.status !== 'quiescent' || proof.observations.some(o => o.status === 'running' || o.status === 'unknown')) deny('CHECKPOINT_RESOURCE', 'owned resource inventory is unknown or still live; no resume');
          const report = options.store.reconcileRun(cp.runId, proof.observations);
          if (report.unknown.length || report.resumed.length) deny('CHECKPOINT_RESOURCE', 'durable attempt reconciliation is not quiescent');
          const request = await validate();
          const source = await restoreApprovedSource({ request, authorize: options.authorize, saved: cp.source, privateRoot: options.privateSourceRoot, checkpointAnchor: { store: options.store, sequence: envelope.sequence } });
          reconciling = false;
          return Object.freeze({ phase: 'ready-for-new-attempts' as const, source, request,
            progress: durableProgress(options.store, cp.runId), reconciliation: report,
            deadlineAt: cp.deadlineAt, close: release });
          // No launch, admission, stale session reattachment or budget import. Integration uses beginAttempt.
        } catch (e) { reconciling = false; await release(); throw e; }
      },
    });
  } catch (e) { await release(); throw e; }
}

export type ControllerRestoreTicket = Awaited<ReturnType<typeof prepareControllerRestore>>;
export type ControllerRestoreReady = Awaited<ReturnType<ControllerRestoreTicket['reconcile']>>;
