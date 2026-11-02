import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaseBoard } from '../../src/cases.js';
import { chainBoard } from '../../src/chain-board.js';
import { chainJoin, chainLinkGap, chainLinkRefusal, claimHeadClaims } from '../../src/chain-view.js';
import { deriveCompletion } from '../../src/completion.js';
import { chainObligations } from '../../src/obligations.js';
import { planFrontier } from '../../src/planning.js';
import { appendRecord, appendRecords, readLedger, type AssessmentRecord } from '../../src/records.js';
import { TaskBoard, taskFrontier } from '../../src/tasks.js';

/**
 * W-X Option C (planning_update.md §5.3): hermetic chain drills.
 *
 * A frozen transcript of the recorded P23/C2 run `run-11badbea` — the run that dispatched its chain successor at 12:19:08Z
 * while the link was authored at 12:30:04Z and walled at 12:30:20Z — is replayed through the *current* projections and gates
 * with no model, no worker, no network and no extension. The expected value of a drill row is what the run should have been
 * told at that moment: the host refuses the unlinked dispatch, admits it once the link is open, and closes admission again
 * when the link is walled. The rows are a table, so the same replay pins readiness → link → dispatch → rating behaviour and a
 * changed projection has to update the table deliberately.
 */
const RUN = 'run-11badbea-c08b-4d45-be7e-9b891a66064c';
const TASK_ID = 'task-cms-forwarder-step2';
const FORWARDER = 'rec-cms-forwarder';
const FORWARDER_STEP = 'rec-cms-forwarder-step2-claim';
const ORACLE = 'rec-cms-oracle';
const CASE_ID = 'case-cms-metadata-oracle';
const at = (time: string) => `2026-10-30T${time}Z`;

/** The recorded ids that mark each checkpoint of the transcript. */
const CHECKPOINT = { task: 'rec-task-successor', link: 'rec-plan-forwarder-step2-r1', wall: 'rec-plan-forwarder-step2-r2' } as const;

type Data = Record<string, unknown>;
const record = (id: string, time: string, kind: AssessmentRecord['kind'], text: string, data?: Data, extra: Partial<AssessmentRecord> = {}): AssessmentRecord =>
  ({ id, runId: RUN, at: at(time), kind, text, by: 'owner', ...(data ? { data } : {}), ...extra });

/** A worker claim as the worker broker stored it: the slug is what the chain join keys on, the record id is what a row cites. */
const claim = (id: string, time: string, data: Data, extra: Partial<AssessmentRecord> = {}): AssessmentRecord => record(id, time, 'candidate',
  `${data.candidate}: ${data.closure} (${data.execution}, ${data.proof}); agent claim, not automatic verification`, data,
  { by: 'worker-a', workerId: 'worker-a', surface: String(data.surface), risk: String(data.risk), outcome: data.closure as AssessmentRecord['outcome'], refs: data.evidenceRefs as string[], ...extra });

/** An owner plan row, stored the way PlanBoard writes it: one note carrying `data.plan` and a revision chain. */
const plan = (recordId: string, time: string, entry: Data, extra: Partial<AssessmentRecord> = {}): AssessmentRecord =>
  record(recordId, time, 'note', `${entry.kind} ${entry.id}@r${entry.revision}: ${entry.status}; ${entry.reason}`, { plan: { ...entry, runId: RUN } }, extra);

/** The successor task the recorded run authored 16 s before it dispatched it (the order defect this drill replays). */
const taskEntry = () => ({
  id: TASK_ID, runId: RUN, revision: 1, status: 'proposed' as const, role: 'exploit' as const,
  question: 'Does the confirmed CMS forwarder carry the chain one step further under the recorded boundary?',
  surface: '/cms/export', risk: 'authorization',
  roleReason: 'The demonstrated forwarder primitive is the only provider of http.request on this surface',
  expectedTrue: 'The forwarder carries the recorded request one step further', expectedFalse: 'The forwarder records the mismatch at the boundary',
  stopCondition: 'Stop after one bounded request through the recorded forwarder', evidenceIds: [], prerequisites: [], recordId: 'rec-task-successor',
  method: { skills: [], reason: 'Reuse the recorded primitive; this attempt introduces no new method' },
  work: { assetRefs: [{ id: 'asset-0123456789abcdef01234567', revision: 1 }], questionKey: 'chain:cms-forwarder-step2', methodFamily: 'chain-step', purpose: 'exploitation' as const,
    claimRefs: [FORWARDER, FORWARDER_STEP], needs: [{ kind: 'http.request', subject: 'cms-forwarder' }] },
  decision: { disposition: 'new' as const, reason: 'Chain successor for the recorded forwarder primitive' },
  outputContract: { kind: 'validation' as const, required: ['evidence', 'candidates'] as const, partialAllowed: false, artifactPolicy: 'ids-only' as const },
});

/** The stored case the drill rates: an accepted case whose chain executed step 1 (the anonymous metadata oracle). */
const caseEntry = () => ({ id: CASE_ID, runId: RUN, revision: 1,
  title: 'Recorded CMS anonymous metadata oracle read reaches a foreign object',
  policyKey: 'policy:cms-metadata-oracle', rootCauseKey: 'root:cms-metadata-oracle',
  assetRefs: [{ id: 'asset-0123456789abcdef01234567' }], claimRefs: [ORACLE], independentEvidenceRefs: [],
  taskRefs: [], reportRefs: [], contradictions: [], affectedVariants: [], relatedCaseIds: [],
  verdict: 'confirmed' as const, reviewStatus: 'accepted' as const,
  reviewReason: 'The recorded primitive shows the fixture principal reading a foreign metadata object; the owner accepted the bounded case',
  limitations: 'One inert fixture principal and one metadata object only',
  remediation: { status: 'unplanned' as const, reason: 'No remediation was planned or reviewed for this case yet', evidenceRefs: [] } });

/**
 * The frozen transcript, in recorded order. Only the chain-relevant slice of run-11badbea is kept: the forwarder primitive,
 * the successor that was dispatched before its link existed, the link authored afterwards and its wall, the second recorded
 * chain, and the case the drill rates. Timestamps and facts come from the run's transcript (docs/HISTORY.md, 2026-10-30).
 */
const transcript = (): AssessmentRecord[] => [
  record('rec-ev-shell-forwarder', '12:13:20', 'evidence', 'shell receipt: print the CMS forwarder identity', { operation: 'shell', exitCode: 0, timedOut: false },
    { by: 'worker-a', workerId: 'worker-a' }),
  plan('rec-goal-cms-read', '12:13:40', { id: 'goal-cms-read', revision: 1, kind: 'goal', status: 'active',
    title: 'Reach the recorded CMS read effect under an impact goal',
    reason: 'Exploit mode admits target-effecting work only under a goal whose proof is a demonstrated primitive',
    criteria: ['the recorded read effect is demonstrated and attributed to one capability'], proof: { kind: 'capability', capability: { kind: 'data.read' } } }),
  claim(FORWARDER, '12:17:56', { candidate: 'cms-forwarder-primitive', surface: '/cms/export', risk: 'authorization', closure: 'confirmed', execution: 'tested',
    proof: 'live_reproduction', evidenceRefs: ['rec-ev-shell-forwarder'], negativeControls: [], policyBasis: 'boundary_invariant',
    expectedPolicy: 'The CMS export preserves the tenant boundary', limitations: 'One inert fixture principal',
    gained: [{ kind: 'http.request', subject: 'cms-forwarder' }] }),
  plan('rec-plan-forwarder-1', '12:18:20', { id: 'todo-cms-forwarder-1', revision: 1, kind: 'todo', status: 'done',
    title: '1/2 confirm the forwarder primitive', reason: 'The primitive the run demonstrated first; it carries the chain',
    claimRefs: [FORWARDER], chainOf: 'cms-forwarder-chain', step: 1 }),
  claim(FORWARDER_STEP, '12:18:40', { candidate: 'cms-forwarder-step2', surface: '/cms/export', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested',
    proof: 'static_trace', evidenceRefs: ['rec-ev-shell-forwarder'], negativeControls: [], policyBasis: 'inferred',
    expectedPolicy: 'The CMS export preserves the tenant boundary', limitations: 'Nothing executed yet; the successor was dispatched before its link existed',
    needs: [{ kind: 'http.request', subject: 'cms-forwarder' }], gained: [{ kind: 'exec.code', subject: 'cms-forwarder-host' }] }),
  record('rec-task-successor', '12:18:52', 'task', `${TASK_ID}: proposed (exploit); coordination, not proof`, { task: taskEntry() }),
  // 12:19:08 is the recorded dispatch this drill replays; there is deliberately no record for it, because the current host refuses it.
  plan('rec-plan-forwarder-step2-r1', '12:30:04', { id: 'todo-cms-forwarder-2', revision: 1, kind: 'todo', status: 'open',
    title: '2/2 carry the recorded forwarder request one step further',
    reason: 'Authored after the dispatch, so the successor brief it should have fed never carried a link',
    claimRefs: [FORWARDER_STEP], chainOf: 'cms-forwarder-chain', step: 2,
    needs: [{ kind: 'http.request', subject: 'cms-forwarder' }], effect: 'confidentiality-read' }),
  plan('rec-plan-forwarder-step2-r2', '12:30:20', { id: 'todo-cms-forwarder-2', revision: 2, kind: 'todo', status: 'blocked',
    title: '2/2 carry the recorded forwarder request one step further',
    reason: 'Walled after the target returned 403; the recorded run never executed the step',
    claimRefs: [FORWARDER_STEP], chainOf: 'cms-forwarder-chain', step: 2,
    needs: [{ kind: 'http.request', subject: 'cms-forwarder' }], effect: 'confidentiality-read' }, { supersedes: 'rec-plan-forwarder-step2-r1' }),
  claim(ORACLE, '12:41:10', { candidate: 'cms-anon-metadata-oracle', surface: '/cms/metadata', risk: 'authorization', closure: 'confirmed', execution: 'tested',
    proof: 'live_reproduction', evidenceRefs: ['rec-ev-shell-forwarder'], negativeControls: [], policyBasis: 'boundary_invariant',
    expectedPolicy: 'Anonymous metadata stays scoped to the requested object', limitations: 'One inert fixture principal',
    gained: [{ kind: 'data.read', subject: 'foreign-metadata-object' }] }),
  plan('rec-plan-oracle-1', '12:41:40', { id: 'todo-cms-oracle-1', revision: 1, kind: 'todo', status: 'done',
    title: '1/1 read the recorded anonymous metadata object', reason: 'The recorded chain executed this step before the run was stopped',
    claimRefs: [ORACLE], chainOf: 'cms-anon-metadata-oracle', step: 1, effect: 'confidentiality-read' }),
  plan('rec-plan-auth-mount-1', '12:42:10', { id: 'todo-cms-auth-mount-1', revision: 1, kind: 'todo', status: 'blocked',
    title: '1/1 mount the recorded auth surface', reason: 'Blocked on a missing credential; the recorded wall for this chain',
    claimRefs: [FORWARDER], chainOf: 'cms-auth-mount-to-session', step: 1 }),
  record('rec-case-cms-oracle', '12:45:00', 'note', `case ${CASE_ID}@r1: confirmed/accepted; owner review, not goal completion`, { case: caseEntry() }),
];

/** Replays the transcript into a fresh ledger; `through` stops at (and includes) the record with that id. */
async function replay(through?: string): Promise<{ root: string; path: string; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-chain-drill-')), path = join(root, 'records.jsonl'), rows = transcript();
  const stop = through === undefined ? rows.length - 1 : rows.findIndex(row => row.id === through);
  if (stop < 0) throw Error(`drill checkpoint ${through} is not in the transcript`);
  await appendRecords(path, rows.slice(0, stop + 1));
  return { root, path, close: () => rm(root, { recursive: true, force: true }) };
}

async function read(path: string) {
  const index = await readLedger(path, RUN);
  return { index, plans: planFrontier(index), claims: claimHeadClaims(index, RUN), tasks: taskFrontier(index) };
}

type Checkpoint = {
  label: string; through: string; mode?: string;
  chain: Record<string, string[]>;
  obligations: { ready: string[]; unchained: string[] };
  completion: string[];
  gate: 'admitted' | 'refused';
};
const CHECKPOINTS: readonly Checkpoint[] = [
  { label: 'the successor is authored while no link exists (the recorded run dispatched it here; the replay has no dispatch record)', through: CHECKPOINT.task,
    chain: { 'cms-forwarder-chain': ['1:done'] },
    obligations: { ready: [], unchained: [FORWARDER] },
    completion: ['GOAL_UNSETTLED:1', 'PRIMITIVE_UNCHAINED:1'], gate: 'refused' },
  { label: 'the link is authored at the next step after the demonstrated one', through: CHECKPOINT.link,
    chain: { 'cms-forwarder-chain': ['1:done', '2:ready'] },
    obligations: { ready: ['todo-cms-forwarder-2'], unchained: [FORWARDER] },
    completion: ['GOAL_UNSETTLED:1', 'PRIMITIVE_UNCHAINED:1', 'CHAIN_READY:1'], gate: 'admitted' },
  { label: 'the run walls the link; the depth debt is not discharged by a wall on the next link', through: CHECKPOINT.wall,
    chain: { 'cms-forwarder-chain': ['1:done', '2:blocked'] },
    obligations: { ready: [], unchained: [FORWARDER] },
    completion: ['GOAL_UNSETTLED:1', 'PRIMITIVE_UNCHAINED:1'], gate: 'refused' },
  { label: 'assess mode produces exposure proof and takes no chain step, so the same transcript admits the task', through: CHECKPOINT.task, mode: 'assess',
    chain: { 'cms-forwarder-chain': ['1:done'] },
    obligations: { ready: [], unchained: [FORWARDER] },
    completion: ['GOAL_UNSETTLED:1', 'PRIMITIVE_UNCHAINED:1'], gate: 'admitted' },
];

describe('hermetic chain drills (W-X/C): a recorded run replayed through the current gates', () => {
  it('reaches the recorded chain state, obligation and dispatch outcome at every checkpoint', async () => {
    for (const row of CHECKPOINTS) {
      const { path, close } = await replay(row.through);
      try {
        const { plans, claims } = await read(path);
        // Readiness: the plan board derives each recorded step's state, never a stored flag.
        const states = Object.fromEntries(chainBoard(plans, claims).map(chain => [chain.chainOf, chain.steps.map(step => `${step.step}:${step.state}`)]));
        expect(states, row.label).toEqual(row.chain);
        // Obligations: an open link is outstanding work; a wall on the next link does not discharge the primitive's depth debt.
        const obligations = chainObligations({ plans, claims, tasks: [] });
        expect(obligations.ready.map(step => step.planId), row.label).toEqual(row.obligations.ready);
        expect(obligations.unchained.map(item => item.recordId), row.label).toEqual(row.obligations.unchained);
        expect(deriveCompletion({ plans, claims, tasks: [] }).items.map(item => `${item.code}:${item.count}`), row.label).toEqual(row.completion);
        // Dispatch: the same gate the held continuation reserves through, driven by the recorded task record.
        const board = new TaskBoard(RUN, path, () => true, () => Date.parse(at('12:19:08')), 'target-r1', undefined, () => row.mode ?? 'exploit');
        if (row.gate === 'refused') {
          await expect(board.reserve(TASK_ID, 'worker-a'), row.label).rejects.toThrow(/^CHAIN_LINK_REQUIRED: task task-cms-forwarder-step2/);
          await expect(board.reserve(TASK_ID, 'worker-a'), row.label).rejects.toThrow(/no open plan row at the next chain step names it/);
        } else {
          await expect(board.reserve(TASK_ID, 'worker-a'), row.label).resolves.toMatchObject({ id: TASK_ID, status: 'reserved' });
        }
      } finally { await close(); }
    }
  });

  it('names the recorded gap through the pure gate the board calls, including the legal next link', async () => {
    const { path, close } = await replay(CHECKPOINT.task);
    try {
      const { plans, claims, tasks } = await read(path);
      const task = tasks.find(item => item.id === TASK_ID)!;
      const gap = chainLinkGap({ mode: 'exploit', task, plans, claims });
      expect(gap).toEqual({ claim: 'cms-forwarder-primitive', cited: [FORWARDER] });
      // The refusal is actionable: it names the step the operator has to author before dispatching, and the wall alternative.
      const message = chainLinkRefusal(TASK_ID, gap!);
      expect(message).toContain('no open plan row at the next chain step names it');
      expect(message).toContain('step=<the step after the last demonstrated one>');
      expect(message).toContain('record the wall instead');
    } finally { await close(); }
  });

  it('pins the plan-scoped frontier the graph page shows once the recorded link is open (F17)', async () => {
    const { path, close } = await replay(CHECKPOINT.link);
    try {
      const { plans, claims } = await read(path), join = chainJoin(claims, plans);
      expect(join.planScoped).toBe(true);
      expect(join.ready).toContain('cms-forwarder-step2');
      const frontier = join.frontier.find(item => item.claimId === 'cms-forwarder-step2')!;
      // The frontier travels the citation lineage the plan row resolved, not a capability path that could mix chains.
      expect(frontier.path).toEqual(['cms-forwarder-primitive', 'cms-forwarder-step2']);
      expect(frontier.planChain).toBe('cms-forwarder-chain');
      expect(frontier.depth).toBe(1);
      expect(frontier.needs.map(capability => (capability as { kind: string }).kind)).toEqual(['http.request']);
      expect(join.uncovered['cms-forwarder-step2']).toBeUndefined();
    } finally { await close(); }
  });

  const basis = 'The recorded anonymous metadata oracle read one foreign object as the fixture principal';
  const step = { order: 1, step: 'Read one anonymous metadata object as the fixture principal', claimRef: ORACLE,
    gained: [{ kind: 'data.read' }], needs: [], effect: 'confidentiality-read' };
  const RATINGS: ReadonlyArray<{ label: string; finding: Data; result: { flags?: string[]; error?: RegExp } }> = [
    { label: 'a rating at the demonstrated depth is recorded with the not-ready caveat', result: { flags: ['RATING_NOT_READY'] },
      finding: { severity: 'medium', basis, chain: { objective: 'Read the recorded anonymous metadata through the CMS oracle', demonstratedThrough: 1, steps: [step] } } },
    { label: 'a rating above the demonstrated depth is refused', result: { error: /exceeds what step 1 demonstrated/ },
      finding: { severity: 'high', basis, chain: { objective: 'Read the recorded anonymous metadata through the CMS oracle', demonstratedThrough: 1, steps: [step] } } },
    { label: 'a rating that names no executed depth is refused', result: { error: /A rating needs a demonstrated effect/ },
      finding: { severity: 'high', basis, chain: { objective: 'Read the recorded anonymous metadata through the CMS oracle', steps: [step] } } },
    { label: 'an executed step must cite a confirmed and tested claim', result: { error: /recorded as executed but its claim is not a confirmed tested result/ },
      finding: { severity: 'medium', basis, chain: { objective: 'Read the recorded anonymous metadata through the CMS oracle', demonstratedThrough: 1,
        steps: [{ ...step, claimRef: FORWARDER_STEP }] } } },
  ];

  it('keeps the recorded rating behaviour: depth bounds the number, and a not-ready case is recorded with its caveat', async () => {
    for (const row of RATINGS) {
      const { path, close } = await replay();
      try {
        const board = new CaseBoard(RUN, path, () => true, {}, () => Date.parse(at('12:45:00')));
        if (row.result.error) await expect(board.rate(CASE_ID, 1, row.finding), row.label).rejects.toThrow(row.result.error);
        else await expect(board.rate(CASE_ID, 1, row.finding), row.label).resolves.toMatchObject({ caseId: CASE_ID, caseRevision: 1, flags: row.result.flags });
      } finally { await close(); }
    }
  });

  it('records the not-ready caveat on the stale case the replay produced instead of refusing the rating (F11)', async () => {
    const { path, close } = await replay();
    try {
      const board = new CaseBoard(RUN, path, () => true, {}, () => Date.parse(at('13:10:00')));
      await expect(board.rate(CASE_ID, 1, { severity: 'medium', basis,
        chain: { objective: 'Read the recorded anonymous metadata through the CMS oracle', demonstratedThrough: 1, steps: [step] } }))
        .resolves.toMatchObject({ flags: ['RATING_NOT_READY'] });
      // A later revision of the same clone supersedes the claim the accepted case cites: the replay's own stale-support scenario.
      await appendRecord(path, claim('rec-cms-oracle-superseded', '13:10:00', { candidate: 'cms-anon-metadata-oracle', surface: '/cms/metadata',
        risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', evidenceRefs: ['rec-ev-shell-forwarder'],
        negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Anonymous metadata stays scoped to the requested object',
        limitations: 'Superseded after the replay to show the stale case' }, { supersedes: ORACLE }));
      const rated = await board.rate(CASE_ID, 1, { severity: 'medium', basis,
        chain: { objective: 'Read the recorded anonymous metadata through the CMS oracle', demonstratedThrough: 1, steps: [step] } });
      expect(rated.flags).toEqual(['RATING_NOT_READY']);
      const index = await readLedger(path, RUN);
      const rows = index.records.filter(row => (row.data?.caseRating as Data | undefined)?.caseId === CASE_ID);
      expect(rows.at(-1)!.data!.caseRating).toMatchObject({ flags: ['RATING_NOT_READY'] });
      expect(rows.at(-1)!.text).toContain('RATING_NOT_READY');
    } finally { await close(); }
  });
});
