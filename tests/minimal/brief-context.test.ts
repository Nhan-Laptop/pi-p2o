import { describe, expect, it } from 'vitest';
import { workerBrief, type BriefContract, type ExploitBriefFacts } from '../../src/prompts.js';
import type { Ticket } from '../../src/ticket.js';

/**
 * planning_update.md P17.4 / A17.3 (D34): a chain successor needs a grey-box handoff, not a one-line question. The block is
 * derived from records the run already holds and renders "not recorded" for anything absent, so a worker reports a gap in the
 * handoff instead of inventing the fact. The dispatcher passes the facts only for exploitation/chaining tickets, which keeps
 * every other brief byte-identical (and the recon brief inside its recorded ceiling).
 */
const ticket = (purpose: string) => ({ workerId: 'worker-test', role: 'exploit', runId: 'run-test', depth: 1, parentWorkerId: null,
  lifetime: 'until-stopped', purpose, target: { kind: 'url', label: 'https://example.invalid' } }) as Ticket;
const facts = (overrides: Partial<ExploitBriefFacts> = {}): ExploitBriefFacts => ({
  primitive: 'cross-tenant-read is confirmed/tested (proof live_reproduction), gained data.read(foreign-object)',
  targetFacts: ['endpoint GET /api/orders revision 3', 'build unknown'],
  knownControls: ['negative control ev-2: the owner principal sees the same order'],
  needs: ['cred.session(alice)'],
  handles: ['session executor: one long-lived container on this ticket'],
  expectedObservation: 'the other tenant order body is returned to the fixture principal',
  stopCondition: 'stop after one bounded read and a control',
  ...overrides,
});

describe('EXPLOIT CONTEXT brief block (A17.3)', () => {
  it('renders every field of the grey-box handoff for an exploitation ticket', () => {
    const brief = workerBrief({ ticket: ticket('exploitation'), focus: 'cross-tenant-read', task: 'Read one foreign order', exploit: facts() });
    expect(brief).toContain('== EXPLOIT CONTEXT (grey-box handoff for this attempt; derived from the run records, never a finding) ==');
    expect(brief).toContain('PRIMITIVE: cross-tenant-read is confirmed/tested');
    expect(brief).toContain('TARGET FACTS: endpoint GET /api/orders revision 3 | build unknown');
    expect(brief).toContain('KNOWN CONTROLS AND LIMITATIONS: negative control ev-2');
    expect(brief).toContain('NEEDS FRONTIER: cred.session(alice)');
    expect(brief).toContain('HANDLES: session executor');
    expect(brief).toContain('EXPECTED OBSERVATION: the other tenant order body');
    expect(brief).toContain('STOP CONDITION: stop after one bounded read and a control');
    expect(brief).toContain('== End of exploit context ==');
    // The block is a handoff, not a licence to invent what the ledger did not record.
    expect(brief).toContain('A field that says "not recorded" is a gap to report, not a fact to invent');
    // The block stays a bounded appendix: it must not turn the brief into a second task description.
    const block = brief.slice(brief.indexOf('== EXPLOIT CONTEXT'), brief.indexOf('== End of exploit context =='));
    expect(block.length).toBeLessThanOrEqual(1_200);
  });

  it('says "not recorded" for every absent field instead of fabricating one', () => {
    const brief = workerBrief({ ticket: ticket('chaining'), focus: 'f', task: 't', exploit: facts({
      primitive: '', targetFacts: [], knownControls: [], needs: [], handles: [], expectedObservation: '', stopCondition: '',
    }) });
    for (const label of ['PRIMITIVE', 'TARGET FACTS', 'KNOWN CONTROLS AND LIMITATIONS', 'NEEDS FRONTIER', 'HANDLES', 'EXPECTED OBSERVATION', 'STOP CONDITION']) {
      expect(brief.split('\n').find(line => line.startsWith(`${label}: `)), label).toBe(`${label}: not recorded`);
    }
    // No derived sentence may appear when the handler had nothing to derive it from.
    expect(brief).not.toContain('proof live_reproduction');
    expect(brief).not.toContain('gained ');
  });

  it('is absent unless the dispatcher supplies it, so non-chain briefs are unchanged', () => {
    const plain = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't', context: 'No previous work' });
    expect(plain).not.toContain('EXPLOIT CONTEXT');
    // The same ticket with facts is the exploit path only because the dispatcher passes them for that purpose.
    const withFacts = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't', exploit: facts() });
    expect(withFacts).toContain('== EXPLOIT CONTEXT');
  });

  it('keeps the non-exploit brief inside the recorded ceiling while the exploit appendix is bounded', () => {
    const plain = workerBrief({ ticket: ticket('recon'), focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work' });
    expect(plain.length).toBeLessThanOrEqual(1_650);
    const exploit = workerBrief({ ticket: ticket('exploitation'), focus: 'cross-tenant-read', task: 'Read one foreign order', exploit: facts() });
    // 1,650 (the pinned recon ceiling) + 1,200 (the block bound) is the hard bound for the longest brief this pass can produce.
    expect(exploit.length).toBeLessThanOrEqual(2_850);
  });
});

/**
 * P20/B: the handoff a worker actually needs. The assignment contract carries the capsule fields the worker acts on (asset
 * ids, the two predictions, the stop condition, pinned prerequisites); the workflow recipe carries the method family's own
 * steps/observe/wall when the selected catalog workflow has them; the role contract states the writer split the shared
 * HANDOFFS document holds. Each is conditional or bounded, so a legacy dispatch and the pinned plain brief are unchanged.
 */
describe('assignment contract, recipe and role contract in the worker brief (P20/B)', () => {
  const contract: BriefContract = {
    assets: [`asset-${'a'.repeat(24)}@r3`, `asset-${'b'.repeat(24)}`],
    expectedTrue: 'A valid session token is accepted on /admin for the fixture principal and the owner sees the same page',
    expectedFalse: 'No token is accepted and every unauthenticated request is redirected to /login with a 302',
    stopCondition: 'Stop after one bounded request pair and its control',
    prerequisites: ['task-3@r2', 'task-4@r1'],
  };
  const recipe = {
    id: 'reproduce-to-control',
    description: 'Climb from a stored reproduction to control of the object the primitive acts on',
    prerequisites: ['A confirmed claim on the recorded revision'],
    steps: ['Replay the stored payload twice and keep the control run that differs only in the payload.',
      'Shrink the payload one field at a time until removing that field stops the effect.',
      'Vary the one input you claim to control and write both expected outcomes before sending either.'],
    observe: ['The response diff between payload and control, plus the target log line naming the request'],
    wall: ['The effect survives the control run only intermittently, which is a reproduction rate, not control.'],
  };

  it('carries the role contract in every brief, with the read-only variant for a reporting worker', () => {
    const brief = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't' });
    expect(brief).toContain('ROLE: workers are the only executors and the only claim/note authors');
    expect(brief).toContain('the planner cannot execute and plans from what you record');
    expect(brief.indexOf('ROLE:')).toBeLessThan(brief.indexOf('TASK:'));
    const reporting = workerBrief({ ticket: { ...ticket('reporting'), role: 'reporting' } as Ticket, focus: 'f', task: 't' });
    expect(reporting).toContain('ROLE: reporting is a read-only second reader');
    expect(reporting).not.toContain('ROLE: workers are the only executors');
  });

  it('renders the capsule fields with pinned revisions, and stays absent when no task record exists', () => {
    const brief = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't', contract });
    expect(brief).toContain('== Assignment contract (owner-authored coordination; background) ==');
    expect(brief).toContain(`ASSETS: asset-${'a'.repeat(24)}@r3 | asset-${'b'.repeat(24)}`);
    expect(brief).toContain('IF TRUE: A valid session token is accepted');
    expect(brief).toContain('| IF FALSE: No token is accepted');
    expect(brief).toContain('STOP: Stop after one bounded request pair and its control');
    expect(brief).toContain('PREREQUISITES: task-3@r2 | task-4@r1');
    expect(brief).toContain('A field that says "not recorded" is a gap to report, not a fact to invent');
    expect(brief).toContain('== End of assignment contract ==');
    // A legacy delegate/structured objective dispatched without a task record keeps the previous brief shape.
    expect(workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't' })).not.toContain('Assignment contract');
  });

  it('says "not recorded" for absent capsule fields and clips an over-long prediction instead of growing the brief', () => {
    const empty = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't',
      contract: { assets: [], expectedTrue: '', expectedFalse: '   ', stopCondition: '', prerequisites: [] } });
    for (const label of ['ASSETS', 'IF TRUE', 'STOP']) expect(empty, label).toContain(`${label}: not recorded`);
    expect(empty).toContain('PREREQUISITES: none');
    const long = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't',
      contract: { ...contract, expectedTrue: 'x'.repeat(400) } });
    const line = long.split('\n').find(entry => entry.startsWith('IF TRUE: '))!;
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line.split(' | IF FALSE: ')[0].endsWith('…')).toBe(true);
  });

  it('renders the workflow recipe when the catalog workflow has one, and nothing when it does not', () => {
    const skills = [{ name: 'test', body: 'Approved fixture guidance' }];
    const withRecipe = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't', skills, workflow: recipe, contract });
    expect(withRecipe).toContain('== Workflow recipe (the method family, not a script) ==');
    expect(withRecipe).toContain('STEPS: 1) Replay the stored payload twice');
    expect(withRecipe).toContain('OBSERVE: The response diff between payload and control');
    expect(withRecipe).toContain('WALL: The effect survives the control run only intermittently');
    expect(withRecipe).toContain('== End of workflow recipe ==');
    expect(withRecipe.indexOf('WORKFLOW: reproduce-to-control')).toBeLessThan(withRecipe.indexOf('== Workflow recipe'));
    expect(workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't', skills, workflow: { id: 'source-review', description: 'Review supplied source' } }))
      .not.toContain('Workflow recipe');
  });

  it('keeps the conditional envelope inside a recorded bound: plain 1,650, contract+recipe ≤2,400', () => {
    const plain = workerBrief({ ticket: ticket('recon'), focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work' });
    expect(plain.length).toBeLessThanOrEqual(1_650);
    const contractOnly = workerBrief({ ticket: ticket('recon'), focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work', contract });
    expect(contractOnly.length).toBeLessThanOrEqual(1_650);
    const full = workerBrief({ ticket: ticket('recon'), focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work',
      skills: [{ name: 'test', body: 'Approved fixture guidance' }], workflow: recipe, contract });
    // Measured 2026-10-29 (P20/B): plain 911, contract 1,389, contract+recipe with the fixture skill 2,365. The recipe and every
    // list item are clipped, so this envelope stays bounded however long the catalog workflow text is.
    expect(full.length).toBeLessThanOrEqual(2_400);
  });
});
