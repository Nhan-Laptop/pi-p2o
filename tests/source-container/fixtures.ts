import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runManifestFor, ownerMenuProposal } from '../entry/fixtures.js';
import { createPlanLedger } from '../../src/application/planner.js';
import { createOwnerAuthority } from '../../src/application/authority.js';
import { readOwnerDocument } from '../../src/application/entry/documents.js';
import { fingerprintTree, removePrivateSourceTree } from '../../src/application/entry/snapshot.js';
import { ENTRY_BOUNDS_DEFAULTS } from '../../src/application/entry/types.js';
import { entrySourceScopeDigest, type ApprovedSourceRequest, type SourceOwnerGate, type QualifiedSourceContainerSettings } from '../../src/application/source-binding/index.js';
import type { EntryPreparation } from '../../src/interface/target-entry.js';
import type { PlanApprovalDocument } from '../../src/contracts/index.js';
import { runSchema } from '../../src/contracts/index.js';

export const repoRoot = resolve(import.meta.dirname, '../..');
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function roots() {
  const root = await mkdtemp(join(tmpdir(), 'p2o-source-container-'));
  const original = join(root, 'original'), privateRoot = join(root, 'private');
  await mkdir(original, { mode: 0o700 }); await mkdir(privateRoot, { mode: 0o700 });
  return { root, original, privateRoot, cleanup: () => removePrivateSourceTree(root) };
}
/** REAL owner PlanLedger + canonical document membership gate. No fabricated allowed:true callback. */
export async function approvedRequest(options: { root: string; origin: string; kind?: 'local-dir' | 'github-repo'; digest?: string; revision?: string; runId?: string; mode?: 'fixture' | 'assessment' }): Promise<{ request: ApprovedSourceRequest; authorize: SourceOwnerGate; approvalPath: string }> {
  const now = Date.now(), iso = (n: number) => new Date(n).toISOString();
  const kind = options.kind ?? 'local-dir', targetId = kind === 'local-dir' ? 'local-source' : 'repo-source';
  const digest = options.digest ?? (kind === 'local-dir' ? (await fingerprintTree({ root: options.origin, bounds: ENTRY_BOUNDS_DEFAULTS })).digest : undefined);
  const run = runManifestFor({ ...(kind === 'local-dir' ? { localDir: options.origin } : { githubUrl: options.origin }), runId: options.runId ?? 'source-run' });
  run.authorization.validFrom = iso(now - 60_000); run.authorization.expiresAt = iso(now + 600_000); run.budgets.deadlineAt = iso(now + 600_000); run.createdAt = iso(now - 30_000);
  if (digest) run.authorization.targets[0]!.digest = digest;
  run.authorization.targets[0]!.revision = options.revision ?? digest?.slice(0, 12);
  runSchema.parse(run);
  const preparation: EntryPreparation = { runId: run.runId, target: { kind, raw: options.origin, locator: options.origin, ...(digest ? { digest } : {}), ...(options.revision ? { revision: options.revision } : {}) }, mode: options.mode ?? 'fixture', scopeDigest: '', actions: ['source.analyze'], spend: { maxCostUsd: 0, maxRequests: 0, maxTokens: 0, maxToolCalls: 16, maxAttempts: 1, deadlineMs: 600_000 }, concurrency: 1, planOnly: false, requiresHumanApproval: true, targetRequests: 0, warnings: [] };
  preparation.scopeDigest = entrySourceScopeDigest(preparation);
  const proposal = ownerMenuProposal({ run, targetId, targetKind: 'artifact', targetLocator: options.origin, observationId: 'source-observation' });
  proposal.run.budgets.deadlineAt = iso(now + 300_000); proposal.provenance.producedAt = iso(now); proposal.provenance.inputDigests = [preparation.scopeDigest];
  // The real ledger stores/seals the actual proposal; the owner's canonical document is authored after it.
  let ownerDocument: PlanApprovalDocument | undefined;
  const admission = { mode: 'managed' as const, manifest: run, perTargetConcurrency: { [targetId]: 1 } };
  const authority = createOwnerAuthority({ version: 1, runs: [admission], tasks: [] });
  const ledger = createPlanLedger({ controlRoot: join(options.root, 'plan-control'), authority: { ...authority, async approvePlan(p, d, context) { if (!ownerDocument) throw new Error('owner has not approved'); const real = createOwnerAuthority({ version: 1, runs: [admission], tasks: [], planApprovals: [ownerDocument] }); return real.approvePlan!(p, d, context); } } });
  const proposed = ledger.propose({ packet: proposal, run, plannerAttemptId: proposal.provenance.plannerAttemptId, inputDigests: [preparation.scopeDigest] });
  if (!proposed.ok) throw new Error(`real fixture plan refused: ${JSON.stringify(proposed)}`);
  const plan = { planId: proposed.record.proposalId, runId: run.runId, digest: proposed.record.digest, steps: ['bounded approved source analysis'], targetRequests: 0 as const };
  ownerDocument = { version: 1, approvalId: 'source-owner-approval', proposalId: proposed.record.proposalId, proposalDigest: proposed.record.digest, runId: run.runId, approvedBy: 'user-requested-source-test-fixture', reference: run.authorization.reference, approvedAt: iso(now), expiresAt: iso(now + 600_000), taskCount: proposal.tasks.length, observationCount: proposal.observations.length };
  const approvalPath = join(options.root, 'owner-plan-approval.json');
  await writeFile(approvalPath, JSON.stringify(ownerDocument), { mode: 0o600 });
  const request: ApprovedSourceRequest = { run, preparation, plan, approval: { channel: 'human-command', approvalRef: ownerDocument.reference, approvedAt: ownerDocument.approvedAt, scopeDigest: preparation.scopeDigest, planDigest: plan.digest } };
  const authorize: SourceOwnerGate = async incoming => {
    if (incoming.run.runId !== run.runId || incoming.plan.digest !== plan.digest || incoming.preparation.scopeDigest !== preparation.scopeDigest) throw new Error('foreign source approval');
    const document = readOwnerDocument(approvalPath, 'source test owner approval');
    const approved = await ledger.approve({ run: incoming.run, proposalDigest: incoming.plan.digest, document });
    if (!approved.ok) throw new Error(`real owner-ledger gate refused: ${JSON.stringify(approved)}`);
  };
  return { request, authorize, approvalPath };
}
/** Current lock only: this helper never prepares, builds, pulls or re-pins an image. */
export async function qualifiedSettings(): Promise<QualifiedSourceContainerSettings> {
  const lock = JSON.parse(await readFile(join(repoRoot, 'containers/pack.lock.json'), 'utf8'));
  return { enginePath: '/usr/bin/docker', engineVersion: lock.engineVersion, image: lock.image.pin, imageRootfsLayers: lock.image.rootfsLayers, baseImageId: lock.base.localBaseImageId, workerSha256: lock.sources.workerSha256, sourceSha256: lock.sources.sourceSha256, seccompPath: join(repoRoot, 'containers/seccomp.json'), seccompSha256: lock.sources.seccompSha256, qualification: { acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation', dedicatedLab: true, approvedBy: 'explicit user-requested real source Docker test window', expiresAt: new Date(Date.now() + 600_000).toISOString(), nativeEnabled: false } };
}
export async function dockerAvailable(): Promise<string | undefined> {
  try {
    const settings = await qualifiedSettings();
    const version = spawnSync(settings.enginePath, ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'], { encoding: 'utf8', timeout: 5000 });
    if (version.status !== 0 || version.stdout.trim() !== `${settings.engineVersion}/${settings.engineVersion}`) return 'current qualified Docker release unavailable (no auto-repin)';
    const image = spawnSync(settings.enginePath, ['image', 'inspect', settings.image], { encoding: 'utf8', timeout: 5000 });
    if (image.status !== 0) return 'current pinned image missing (no pull)';
    return undefined;
  } catch { return 'current container qualification lock is missing'; }
}
