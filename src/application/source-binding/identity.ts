/** Controller binding, not an approval authority. The existing owner ledger remains mandatory. */
import { resolve } from 'node:path';
import { digestJson, type RunManifest } from '../../contracts/index.js';
import type { EntryHumanApproval, EntryPlan, EntryPreparation } from '../../interface/target-entry.js';
import type { EntryAcquisition, EntryBounds } from '../entry/types.js';
import { ENTRY_BOUNDS_DEFAULTS } from '../entry/types.js';
import { entryFail } from '../entry/errors.js';
import { normalizeGitHubRepo } from '../entry/targets.js';
import type { EntrySnapshotSeal } from '../entry/snapshot.js';
import { validateEntryBounds } from '../entry/snapshot.js';

export interface ApprovedSourceRequest {
  /** Re-read owner document; do not use a model-authored target/authorization. */
  run: RunManifest;
  preparation: EntryPreparation;
  plan: EntryPlan;
  approval: EntryHumanApproval;
  now?: number;
}
export interface SourceIdentity {
  readonly version: 1;
  readonly runId: string;
  readonly targetId: string;
  readonly kind: 'local-dir' | 'github-repo';
  /** Approved original, NEVER the mount path. */
  readonly origin: string;
  readonly digest: string;
  readonly revision?: string;
  readonly scopeDigest: string;
  readonly planDigest: string;
  readonly approvalRef: string;
}
export interface ApprovedSourceSnapshot {
  readonly identity: SourceIdentity;
  readonly identityDigest: string;
  readonly acquisition: Readonly<EntryAcquisition>;
  readonly seal: EntrySnapshotSeal;
}
export type SourceOwnerGate = (request: ApprovedSourceRequest) => Promise<void>;
export function entrySourceScopeDigest(p: EntryPreparation): string {
  return digestJson({ version: 1, runId: p.runId, target: { kind: p.target.kind, locator: p.target.locator, ...(p.target.digest ? { digest: p.target.digest } : {}), ...(p.target.revision ? { revision: p.target.revision } : {}) }, mode: p.mode, actions: [...p.actions], spend: p.spend, concurrency: p.concurrency, planOnly: p.planOnly });
}
const sha = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const commit = (s: unknown): s is string => typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
export function validateSourceApproval(request: ApprovedSourceRequest): {
  targetId: string; origin: string; kind: SourceIdentity['kind']; expectedDigest?: string; expectedRevision?: string;
} {
  const { run, preparation: p, plan, approval: a } = request;
  if (p.runId !== run.runId || plan.runId !== run.runId || !p.requiresHumanApproval || p.targetRequests !== 0 || plan.targetRequests !== 0 || !sha(p.scopeDigest) || !sha(plan.digest) || p.scopeDigest !== entrySourceScopeDigest(p) || a.channel !== 'human-command' || a.scopeDigest !== p.scopeDigest || a.planDigest !== plan.digest || !a.approvalRef) entryFail('SCOPE_DIGEST_MISMATCH', 'source run/scope/plan/approval identities do not agree');
  const now = request.now ?? Date.now(), approvedAt = Date.parse(a.approvedAt);
  const validFrom = Date.parse(run.authorization.validFrom), expiresAt = Date.parse(run.authorization.expiresAt), deadline = Date.parse(run.budgets.deadlineAt);
  if (![now, approvedAt, validFrom, expiresAt, deadline].every(Number.isFinite) || validFrom >= expiresAt || now < validFrom || now >= expiresAt || now >= deadline || approvedAt < validFrom || approvedAt > now) entryFail('ENTRY_APPROVAL_WINDOW', 'source approval is outside the owner window or run deadline');
  // Preparation binds permission verbs; legacy entry records used the capability as their action label.
  // In either representation, BOTH analyze permission and source.analyze capability remain mandatory.
  if ((p.target.kind !== 'local-dir' && p.target.kind !== 'github-repo') || !p.actions.some(action => action === 'analyze' || action === 'source.analyze') || !run.allowedCapabilities.includes('source.analyze') || !run.authorization.allowedActions.includes('analyze')) entryFail('TARGET_DENIED', 'source analysis is not owner-authorized');
  const kind = p.target.kind;
  const origin = kind === 'github-repo' ? normalizeGitHubRepo(p.target.locator).url : p.target.locator;
  if (origin !== p.target.locator || (kind === 'local-dir' && (origin === '/' || resolve(origin) !== origin || !origin.startsWith('/') || /[\u0000-\u001f\u007f]/.test(origin)))) entryFail('TARGET_DENIED', 'approved source origin must be canonical and permit a disjoint private snapshot');
  const target = run.authorization.targets.find(t => (t.kind === 'artifact' || (kind === 'local-dir' && t.kind === 'lab')) && t.locator === origin);
  if (!target) entryFail('TARGET_DENIED', 'source origin is no longer in the owner-approved target list');
  const expectedDigest = p.target.digest ?? target.digest;
  if ((expectedDigest !== undefined && !sha(expectedDigest)) || (target.digest && target.digest !== expectedDigest)) entryFail('SCOPE_DIGEST_MISMATCH', 'approved source digest pins conflict');
  const expectedRevision = kind === 'github-repo' ? (p.target.revision ?? target.revision) : undefined;
  if ((expectedRevision !== undefined && !commit(expectedRevision)) || (kind === 'github-repo' && target.revision && target.revision !== expectedRevision)) entryFail('SCOPE_DIGEST_MISMATCH', 'approved commit pins conflict or are not immutable commits');
  if (kind === 'local-dir' ? !expectedDigest : (!expectedDigest && !expectedRevision)) entryFail('ENTRY_SOURCE_UNBOUND', 'source container binding needs an approved local digest or GitHub digest/full commit; unpinned acquisition is not authority');
  return { targetId: target.id, origin, kind, ...(expectedDigest ? { expectedDigest } : {}), ...(expectedRevision ? { expectedRevision } : {}) };
}
export function sourceBounds(request: ApprovedSourceRequest, overrides?: Partial<EntryBounds>): EntryBounds {
  const bounds = { ...ENTRY_BOUNDS_DEFAULTS, ...overrides };
  bounds.maxTotalBytes = Math.min(bounds.maxTotalBytes, request.run.budgets.maxBytes);
  validateEntryBounds(bounds);
  return bounds;
}
export function assertSourceIdentity(request: ApprovedSourceRequest, snapshot: ApprovedSourceSnapshot): void {
  const expected = validateSourceApproval(request), id = snapshot.identity, acquisition = snapshot.acquisition;
  if (snapshot.identityDigest !== digestJson(id) || id.runId !== request.run.runId || id.scopeDigest !== request.preparation.scopeDigest || id.planDigest !== request.plan.digest || id.approvalRef !== request.approval.approvalRef || id.targetId !== expected.targetId || id.origin !== expected.origin || id.kind !== expected.kind || !sha(id.digest) || (expected.expectedDigest && id.digest !== expected.expectedDigest) || (expected.expectedRevision && id.revision !== expected.expectedRevision) || (id.kind === 'github-repo' && !commit(id.revision)) || acquisition.locator !== snapshot.seal.root || acquisition.kind !== id.kind || acquisition.digest !== id.digest || acquisition.revision !== id.revision || acquisition.readOnly !== true || snapshot.seal.digest !== id.digest || snapshot.seal.files !== acquisition.files || snapshot.seal.bytes !== acquisition.bytes) entryFail('SCOPE_DIGEST_MISMATCH', 'acquisition, immutable source and approved identity disagree');
}
