import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { digestJson } from '../../contracts/index.js';
import { assertClonedSourceSnapshot, cloneGitHubRepoSafely, createProcessRunner } from '../entry/clone.js';
import { entryFail } from '../entry/errors.js';
import { assertSnapshotSeal, createReadOnlySnapshot, ensurePrivateSourceDirectory, fingerprintTree, removePrivateSourceTree, sealSnapshot } from '../entry/snapshot.js';
import type { EntryAcquisition, EntryBounds, EntryCommandRunner, EntryObserver } from '../entry/types.js';
import { assertSourceIdentity, sourceBounds, validateSourceApproval, type ApprovedSourceRequest, type ApprovedSourceSnapshot, type SourceIdentity, type SourceOwnerGate } from './identity.js';

const issued = new WeakSet<ApprovedSourceSnapshot>();
export function assertIssuedSourceSnapshot(snapshot: ApprovedSourceSnapshot): void {
  if (!issued.has(snapshot)) entryFail('ENTRY_SOURCE_UNBOUND', 'source binding requires a controller-issued snapshot, never worker-authored identity JSON');
}
/** Capture authority fields before any await; callers cannot change the source while the owner gate runs. */
export function copySourceRequest(request: ApprovedSourceRequest): ApprovedSourceRequest {
  const copy = { run: structuredClone(request.run), preparation: structuredClone(request.preparation), plan: structuredClone(request.plan), approval: { channel: request.approval.channel, approvalRef: request.approval.approvalRef, approvedAt: request.approval.approvedAt, scopeDigest: request.approval.scopeDigest, planDigest: request.approval.planDigest }, ...(request.now === undefined ? {} : { now: request.now }) };
  const freeze = (object: object): void => { for (const value of Object.values(object)) if (value && typeof value === 'object') freeze(value); Object.freeze(object); };
  freeze(copy); return copy;
}
export interface SourceAcquisitionOptions {
  request: ApprovedSourceRequest;
  /** Existing owner-ledger authorize call, mandatory and BEFORE source I/O. Not a boolean approval. */
  authorize: SourceOwnerGate;
  privateRoot: string;
  bounds?: Partial<EntryBounds>;
  /** Existing entry acquisition may be captured instead of acquiring twice. */
  acquisition?: EntryAcquisition;
  signal?: AbortSignal;
  observer?: EntryObserver;
  /** Trusted test transport boundary only. Never supplied by workers/models. */
  commandRunner?: EntryCommandRunner;
  gitBinary?: string;
  cloneTimeoutMs?: number;
}
/** Same entry snapshot/clone implementation. No second source engine, model call or repo execution. */
export async function acquireApprovedSource(options: SourceAcquisitionOptions): Promise<ApprovedSourceSnapshot> {
  options = { ...options, ...(options.bounds ? { bounds: structuredClone(options.bounds) } : {}), ...(options.acquisition ? { acquisition: structuredClone(options.acquisition) } : {}) };
  const request = copySourceRequest(options.request), approved = validateSourceApproval(request);
  if (typeof options.authorize !== 'function') entryFail('ENTRY_HUMAN_APPROVAL_REQUIRED', 'bind the existing owner-ledger source gate before acquisition');
  await options.authorize(request);
  validateSourceApproval(request);
  const bounds = sourceBounds(request, options.bounds);
  if (resolve(options.privateRoot) !== options.privateRoot || options.privateRoot === sep || options.privateRoot === approved.origin || options.privateRoot.startsWith(`${approved.origin}${sep}`)) entryFail('TARGET_DENIED', 'source private root must be canonical and outside the approved original');
  await ensurePrivateSourceDirectory(options.privateRoot);
  const holder = join(options.privateRoot, `run-${digestJson({ runId: request.run.runId, scopeDigest: request.preparation.scopeDigest }).slice(0, 32)}`);
  try { await mkdir(holder, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') entryFail('TARGET_DENIED', 'this source run already has a private snapshot; never overwrite or silently reacquire it'); throw error; }
  const destination = join(holder, 'source');
  try {
    let digest: string, revision: string | undefined, warnings: string[] = [];
    if (options.acquisition) {
      const acquisition = structuredClone(options.acquisition);
      if (acquisition.kind !== approved.kind || !acquisition.readOnly || !acquisition.digest || (approved.expectedDigest && acquisition.digest !== approved.expectedDigest) || (approved.expectedRevision && acquisition.revision !== approved.expectedRevision)) entryFail('SCOPE_DIGEST_MISMATCH', 'entry acquisition no longer matches the approved source pins');
      if (approved.kind === 'github-repo') {
        if (!acquisition.revision) entryFail('ENTRY_SOURCE_UNBOUND', 'repository acquisition has no resolved commit');
        await assertClonedSourceSnapshot(acquisition.locator, acquisition.revision, acquisition.digest);
      }
      revision = approved.kind === 'github-repo' ? acquisition.revision : undefined;
      digest = (await createReadOnlySnapshot({ root: acquisition.locator, destination, bounds, expectedDigest: acquisition.digest, containerReadable: true, signal: options.signal, observer: options.observer })).digest;
      warnings = [...acquisition.warnings];
    } else if (approved.kind === 'local-dir') {
      const copied = await createReadOnlySnapshot({ root: approved.origin, destination, bounds, expectedDigest: approved.expectedDigest!, containerReadable: true, signal: options.signal, observer: options.observer });
      digest = copied.digest;
      if (copied.skippedSymlinks) warnings.push(`${copied.skippedSymlinks} symlinks excluded; never followed`);
      if (copied.skippedUnsafePaths || copied.skippedDeep) warnings.push('unsafe/hard-linked/deep paths excluded from the approved bounded view');
    } else {
      const cloned = await cloneGitHubRepoSafely({ repoUrl: approved.origin, destination, privateRoot: join(holder, 'git-control'), runner: options.commandRunner ?? createProcessRunner(), bounds, expectedRevision: approved.expectedRevision, expectedDigest: approved.expectedDigest, containerReadable: true, signal: options.signal, observer: options.observer, gitBinary: options.gitBinary, timeoutMs: options.cloneTimeoutMs });
      revision = cloned.revision;
      digest = (await fingerprintTree({ root: destination, bounds, signal: options.signal })).digest;
    }
    const seal = await sealSnapshot({ root: destination, bounds, expectedDigest: digest, containerReadable: true, signal: options.signal });
    const identity: SourceIdentity = Object.freeze({ version: 1, runId: request.run.runId, targetId: approved.targetId, kind: approved.kind, origin: approved.origin, digest, ...(revision ? { revision } : {}), scopeDigest: request.preparation.scopeDigest, planDigest: request.plan.digest, approvalRef: request.approval.approvalRef });
    const acquisition: EntryAcquisition = { kind: approved.kind, locator: destination, digest, ...(revision ? { revision } : {}), readOnly: true, files: seal.files, bytes: seal.bytes, warnings };
    const snapshot: ApprovedSourceSnapshot = Object.freeze({ identity, identityDigest: digestJson(identity), acquisition: Object.freeze({ ...acquisition, warnings: Object.freeze(warnings) as unknown as string[] }), seal });
    assertSourceIdentity(request, snapshot);
    await assertSnapshotSeal(seal, options.signal);
    // Private provenance is beside the mount, NOT inside it. Never expose owner docs/git config to a worker.
    await writeFile(join(holder, 'source.identity.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
    issued.add(snapshot);
    return snapshot;
  } catch (error) { await removePrivateSourceTree(holder); throw error; }
}

/** Restore ONLY an existing immutable snapshot. This is a controller-only gate, not JSON authority. */
export async function restoreApprovedSource(options: {
  request: ApprovedSourceRequest; authorize: SourceOwnerGate;
  saved: ApprovedSourceSnapshot; privateRoot: string; signal?: AbortSignal;
  /** Durable controller event anchors the PRIOR source inode/content seal, not worker JSON. */
  checkpointAnchor: { store: import('../../store/index.js').DurableStore; sequence: number };
}): Promise<ApprovedSourceSnapshot> {
  const request = copySourceRequest(options.request);
  validateSourceApproval(request);
  if (typeof options.authorize !== 'function') entryFail('ENTRY_HUMAN_APPROVAL_REQUIRED', 'restore needs the current owner ledger gate');
  await options.authorize(request);
  const saved = structuredClone(options.saved);
  assertSourceIdentity(request, saved);
  const anchor = options.checkpointAnchor;
  const event = anchor?.store.listEvents({ afterSequence: anchor.sequence - 1, limit: 1 })[0];
  if (!Number.isSafeInteger(anchor?.sequence) || event?.sequence !== anchor.sequence || event.runId !== request.run.runId || event.type !== 'controller.checkpoint' || event.payload.sourceSnapshotDigest !== digestJson(saved)) entryFail('ENTRY_SOURCE_UNBOUND', 'source restore requires its prior durable checkpoint identity anchor');
  if (anchor.store.getRun(request.run.runId)?.state !== 'active' || anchor.store.listTasks(request.run.runId).some(task => anchor.store.getLease(task.taskId))) entryFail('ENTRY_SOURCE_UNBOUND', 'restore cannot mint a source capability while durable attempt leases remain unreconciled');
  const holder = join(options.privateRoot, `run-${digestJson({ runId: request.run.runId, scopeDigest: request.preparation.scopeDigest }).slice(0, 32)}`);
  if (resolve(options.privateRoot) !== options.privateRoot || saved.seal.root !== join(holder, 'source')) entryFail('ENTRY_SOURCE_UNBOUND', 'restored snapshot is outside the controller-selected immutable root');
  const { checkpointDirectory } = await import('../checkpoint/files.js');
  await checkpointDirectory(options.privateRoot, saved.identity.kind === 'local-dir' ? [saved.identity.origin] : []);
  // Missing snapshots and inode/content swaps fail here; never clone or copy the original.
  await assertSnapshotSeal(saved.seal, options.signal);
  const { readBounded } = await import('../checkpoint/files.js');
  const { canonicalJson } = await import('../../contracts/index.js');
  const provenance = JSON.parse(await readBounded(join(holder, 'source.identity.json'))) as ApprovedSourceSnapshot;
  const withoutWarnings = (s: ApprovedSourceSnapshot) => ({ ...s, acquisition: { ...s.acquisition, warnings: [] } });
  if (canonicalJson(withoutWarnings(provenance)) !== canonicalJson(withoutWarnings(saved))) entryFail('ENTRY_SOURCE_UNBOUND', 'source provenance differs from the approved checkpoint');
  await options.authorize(request);
  assertSourceIdentity(request, saved);
  await assertSnapshotSeal(saved.seal, options.signal);
  const freeze = (object: object): void => { for (const value of Object.values(object)) if (value && typeof value === 'object') freeze(value); Object.freeze(object); };
  freeze(saved);
  issued.add(saved);
  return saved;
}
