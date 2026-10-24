import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';

/**
 * planning_update.md P9: a plan may only stand on something it names. ARTEX refuses an intent whose parents are not a fact or a
 * finding (`agent/tools.go:1032-1090`); p2o has the same refusal now, expressed in its own vocabulary — a same-run candidate claim
 * (`work.claimRefs`), a prior task (`validationOf` / `retestOf` / prerequisites), or an asset revision (a mapped surface is a
 * legitimate starting point). `mapping` and `reporting` are exempt because they *are* the starting point.
 *
 * The gate runs inside `checkDependencies`, so create, revise and the ready-time checks (`reserve`, dispatch) share one rule.
 */
const runId = 'run-lineage';
const draft = (assetId: string, purpose: TaskDraft['work'] extends undefined ? never : 'mapping' | 'discovery' | 'investigation' | 'refinement' | 'exploitation' | 'chaining' | 'validation' | 'retest' | 'reporting', extra: Partial<TaskDraft> = {}): TaskDraft => ({
  id: `task-${randomUUID()}`, question: 'Does the declared fixture boundary hold for the named claim?', surface: '/lineage', risk: 'authorization', role: 'general',
  roleReason: 'Bounded inert source comparison only', expectedTrue: 'Declared actor reaches the consumer', expectedFalse: 'Control actor does not', stopCondition: 'Stop after the bounded observation',
  evidenceIds: [], prerequisites: [], method: { skills: [], reason: 'Controlled offline fixture, not a target assessment' },
  work: { assetRefs: [{ id: assetId, revision: 1 }], questionKey: `policy:${purpose}`, policyKey: 'policy:declared-contract', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'source-trace', purpose },
  decision: { disposition: 'new', reason: 'No prior retained attempt for this structured identity' }, outputContract: { kind: 'investigation', required: ['evidence'], partialAllowed: true, artifactPolicy: 'ids-only' },
  ...extra,
});

/** The same draft without a structured work identity: the legacy shape, whose only lineage fields are validationOf/retestOf/prerequisites. */
const bare = (assetId: string) => { const { work: _work, decision: _decision, outputContract: _contract, id: _id, ...rest } = draft(assetId, 'investigation'); return rest; };
async function fixture(work: (h: { board: TaskBoard; store: AssessmentStore; assetId: string; claim: () => string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-lineage-')), store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'inert', targetDisplay: 'inert', profile: { runtimeHash: 'inert', image: 'inert', loopMode: 'manual', executorMode: 'shared' } });
  const path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store);
  const assetId = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /lineage' } }] })[0].entityId;
  const claim = () => store.commitRecords([{ id: randomUUID(), runId, at: '2030-01-01', by: 'worker-a', workerId: 'worker-a', kind: 'candidate', text: 'Confirmed fixture primitive', surface: '/lineage', risk: 'authorization', outcome: 'confirmed',
    data: { candidate: `parent-${randomUUID().slice(0, 8)}`, closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [], negativeControls: [], limitations: 'Fixture only', policyBasis: 'boundary_invariant', expectedPolicy: 'Declared boundary' } }])[0].recordId!;
  try { await work({ board: new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id)), store, assetId, claim }); }
  finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}

describe('parent-typed lineage gate (P9)', () => {
  it('refuses a validation task that names no parent at all, once the run holds a claim to cite', async () => fixture(async ({ board, assetId, claim }) => {
    claim(); // nothing to cite is not the same as refusing to cite: on an empty run the same draft is accepted (see the last test)
    // The role is the purpose signal for a plain draft: a validation worker must say which claim it reproduces.
    await expect(board.create({ ...bare(assetId), role: 'validation' })).rejects.toThrow(/PURPOSE_NEEDS_LINEAGE: a validation task must cite the claim it reproduces/);
    // Naming the predecessor task is the existing idiom and satisfies the gate (structured work already forces validationOf).
    const prior = await board.create({ ...bare(assetId), role: 'general' });
    const linked = { ...bare(assetId), role: 'validation' as const, validationOf: prior.id, prerequisites: [{ taskId: prior.id, revision: 1 }] };
    expect(await board.create(linked)).toMatchObject({ status: 'proposed', validationOf: prior.id });
  }));

  it('accepts a structured task that cites its parent claim, and refuses an unknown or non-candidate one', async () => fixture(async ({ board, assetId, claim }) => {
    const claimId = claim(), { id: _fresh, ...base } = draft(assetId, 'investigation');
    const accepted = await board.create({ ...base, work: { ...base.work!, claimRefs: [claimId] } });
    expect(accepted.work!.claimRefs).toEqual([claimId]);
    await expect(board.create({ ...base, work: { ...base.work!, claimRefs: ['candidate-that-does-not-exist'] } })).rejects.toThrow(/Unknown same-run parent claim/);
    // An evidence receipt is not a claim: the parent must be the primitive itself.
    await expect(board.create({ ...base, work: { ...base.work!, claimRefs: [`${claimId}-nope`] } })).rejects.toThrow(/Unknown same-run parent claim/);
  }));

  it('re-runs the gate when a revision drops the parent, so a claim cannot lose its lineage later', async () => fixture(async ({ board, assetId, claim }) => {
    claim();
    const prior = await board.create({ ...bare(assetId), role: 'general' });
    const created = await board.create({ ...bare(assetId), role: 'validation', validationOf: prior.id, prerequisites: [{ taskId: prior.id, revision: 1 }] });
    // The same fields are refused on create, which proves the gate reads the lineage rather than the transition.
    await expect(board.create({ ...bare(assetId), id: 'task-orphan-probe', role: 'validation' })).rejects.toThrow(/PURPOSE_NEEDS_LINEAGE/);
    // And a revision cannot drop the predecessor to reach that state.
    await expect(board.revise(created.id, created.revision, { ...bare(assetId), id: created.id, role: 'validation' })).rejects.toThrow(/PURPOSE_NEEDS_LINEAGE/);
  }));

  it('exempts mapping and reporting, and accepts an asset revision as the parent of investigation', async () => fixture(async ({ board, assetId }) => {
    for (const purpose of ['mapping', 'reporting'] as const) expect(await board.create(draft(assetId, purpose))).toMatchObject({ status: 'proposed' });
    // No claim and no prior task: the pinned asset revision is what an investigation stands on.
    expect(await board.create(draft(assetId, 'investigation'))).toMatchObject({ status: 'proposed' });
  }));

  it('normalizes the parent list without counting it', async () => fixture(async ({ board, assetId, claim }) => {
    const claimId = claim(), { id: _fresh, ...base } = draft(assetId, 'investigation');
    await expect(board.create({ ...base, work: { ...base.work!, claimRefs: [claimId, claimId] } })).rejects.toThrow(/Duplicate work parent claim reference/);
    // No count cap: a task may stand on as many claims as it truly consumes.
    const many = Array.from({ length: 11 }, () => claim());
    expect((await board.create({ ...base, work: { ...base.work!, questionKey: 'policy:investigation-wide', claimRefs: many } })).work!.claimRefs).toHaveLength(11);
    await expect(board.create({ ...base, work: { ...base.work!, claimRefs: [] } as never })).rejects.toThrow(/at least one parent claim reference/);
    // Sorted on the way in, so the same lineage recorded in another order is the same lineage.
    const second = claim();
    const created = await board.create({ ...base, work: { ...base.work!, claimRefs: [second, claimId] } });
    expect(created.work!.claimRefs).toEqual([claimId, second].sort());
  }));
});

/**
 * planning_update.md P14.5: exploitation and chaining take a demonstrated primitive further, so the P9 asset-revision exemption
 * no longer covers them — an exploit step has to name the claim it escalates, and a chain has to name two. A structured draft
 * without a `work` object stays out of reach (the legacy prose delegate has no field to fill). The claim-plus-demonstrated-
 * environment alternative is not expressible yet, because a task still cannot name an environment (P14.10).
 */
describe('exploitation and chaining lineage (P14.5)', () => {
  it('refuses an exploitation task whose only parent is an asset revision, and names the field to fill', async () => fixture(async ({ board, assetId, claim }) => {
    claim();
    // Same lineage as the accepted investigation below, refused only because the purpose escalates past it.
    await expect(board.create(draft(assetId, 'exploitation'))).rejects.toThrow(/PURPOSE_NEEDS_LINEAGE: an exploitation task must cite the claim it takes further \(work\.claimRefs\)/);
    expect(await board.create(draft(assetId, 'investigation'))).toMatchObject({ status: 'proposed' });
  }));

  it('accepts an exploitation task that cites the claim it takes further', async () => fixture(async ({ board, assetId, claim }) => {
    const claimId = claim(), { id: _fresh, ...base } = draft(assetId, 'exploitation');
    const accepted = await board.create({ ...base, work: { ...base.work!, claimRefs: [claimId] } });
    expect(accepted.work!.claimRefs).toEqual([claimId]);
  }));

  it('refuses a chaining task with exactly one claim, because one claim is not a chain', async () => fixture(async ({ board, assetId, claim }) => {
    const claimId = claim(), { id: _fresh, ...base } = draft(assetId, 'chaining');
    await expect(board.create({ ...base, work: { ...base.work!, claimRefs: [claimId] } })).rejects.toThrow(/PURPOSE_NEEDS_LINEAGE: a chaining task must cite the two claims it composes \(work\.claimRefs\)/);
    // An asset revision is not a substitute, and neither is a prior task: two claims are what a chain composes.
    await expect(board.create(draft(assetId, 'chaining'))).rejects.toThrow(/PURPOSE_NEEDS_LINEAGE/);
  }));

  it('accepts a chaining task that cites two claims', async () => fixture(async ({ board, assetId, claim }) => {
    const first = claim(), second = claim(), { id: _fresh, ...base } = draft(assetId, 'chaining');
    const accepted = await board.create({ ...base, work: { ...base.work!, claimRefs: [first, second] } });
    expect(accepted.work!.claimRefs).toEqual([first, second].sort());
  }));
});
