import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attackPathSection } from '../../src/report-export.js';
import type { CaseView } from '../../src/cases.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { PlanEntry } from '../../src/planning.js';
import { fixture, populate, seedClaim } from './helpers/report-fixture.js';

/**
 * P22/A4/D-P22-6: the report keeps every recorded chain, bounded, with plan-only links labelled not executed. The derived effect
 * label is a suggestion from an explicit, incomplete table and changes no rung, rating or case verdict.
 */
const claim = (recordId: string, gained: unknown[] = []): ChainClaim => ({ candidate: `claim-${recordId}`, closure: 'confirmed', execution: 'tested', gained, needs: [], recordId });
const link = (chainOf: string, step: number, extra: Partial<PlanEntry> = {}): PlanEntry => ({
  id: `todo-${chainOf}-${step}`, runId: 'run-a4', revision: 1, recordId: `rec-${chainOf}-${step}`, kind: 'todo',
  title: `Recorded link ${step} of ${chainOf}`, status: 'open', reason: 'A recorded plan link in this fixture', chainOf, step, claimRefs: ['claim-record-1'], ...extra,
} as PlanEntry);
const caseChain = (id: string, revision: number, chain: Record<string, unknown>, extra: Partial<CaseView> = {}): CaseView => ({ id, revision, acceptedFinding: true, ratingCurrent: true, finding: { chain }, ...extra } as unknown as CaseView);

describe('attack path section (P22/A4)', () => {
  it('renders nothing when the run recorded no chain, so an existing report keeps its bytes', () => {
    expect(attackPathSection([], [], [])).toEqual([]);
  });

  it('prints a plan link with its derived state, providers, target effect, derived suggestion and not-executed mark', () => {
    const claims = [claim('claim-record-1', [{ kind: 'db.query', subject: 'records' }])];
    const plans = [link('chain-a', 1), link('chain-a', 2, { needs: [{ kind: 'db.query', subject: 'records' }], effect: 'confidentiality-read' })];
    const text = attackPathSection(plans, claims, []).join('\n');
    expect(text).toContain('## Attack path');
    expect(text).toContain('#### Plan chain chain-a');
    expect(text).toContain('chain chain-a 0/2 · next: step 1 \\(ready\\)');
    expect(text).toContain('| Step | Link | State | Claim it stands on | Needs | Provided by | Waiting on | Target effect | Derived | Execution |');
    const second = text.split('\n').find(line => line.startsWith('| 2/2 |'))!;
    expect(second).toContain('db.query \\(records\\)'); // the typed need, described and neutralized
    expect(second).toContain('claim-record-1'); // the provider derived from the earlier link's cited claim
    expect(second).toContain('confidentiality-read'); // target effect and derived label agree here
    expect(second).toContain('not executed — plan record only'); // a plan link is not evidence
    expect(text).toContain('A recorded chain is not proof of a path');
    expect(text).toContain('derived suggestion, not a rating');
  });

  it('prints an accepted case chain with its executed depth and marks written links past it as not executed', () => {
    const rated = [caseChain('case-a', 2, { objective: 'Reach the recorded read through the recorded selector', demonstratedThrough: 1, steps: [
      { order: 1, step: 'Read the selected record through the recorded endpoint', claimRef: 'claim-record-1', needs: [], gained: [{ kind: 'data.read' }], effect: 'confidentiality-read' },
      { order: 2, step: 'Write the selected record with the same primitive', needs: [{ kind: 'file.write' }], gained: [] },
    ] })];
    const text = attackPathSection([], [claim('claim-record-1')], rated).join('\n');
    expect(text).toContain('**Case chain case-a r2** — Reach the recorded read through the recorded selector');
    expect(text).toContain('executed through step 1 of 2');
    expect(text).toContain('effect: confidentiality-read');
    expect(text).toContain('1 written link(s) after the demonstrated depth were not executed; the chain records no run for them.');
    expect(text).toContain('No plan chain is recorded');
  });

  it('does not call a stale rating\'s chain executed, so a plan-only link cannot borrow evidence from it', () => {
    const stale = caseChain('case-stale', 3, { objective: 'Reach the recorded read through the recorded selector', demonstratedThrough: 1,
      steps: [{ order: 1, step: 'Read the selected record through the recorded endpoint', claimRef: 'claim-record-1', needs: [], gained: [], effect: 'confidentiality-read' }] },
    { ratingCurrent: false, ratedRevision: 2 });
    const text = attackPathSection([link('chain-a', 1)], [claim('claim-record-1')], [stale]).join('\n');
    expect(text).toContain('the rating is recorded against r2, not the current case revision');
    expect(text).toContain('demonstrated through step 1 of 1'); // listed as recorded, not as a current execution
    expect(text).toContain('| not executed — plan record only |'); // the plan link is not joined to a stale chain
  });

  it('counts the chains and links it drops instead of losing them, for plan chains, deep chains and case chains', () => {
    const manyChains = Array.from({ length: 22 }, (_, index) => link(`chain-${String(index).padStart(2, '0')}`, 1));
    expect(attackPathSection(manyChains, [], []).join('\n')).toContain('2 more plan chain(s) not shown (20 shown)');
    const deep = Array.from({ length: 27 }, (_, index) => link('chain-deep', index + 1));
    expect(attackPathSection(deep, [], []).join('\n')).toContain('2 more link(s) in this chain not shown (25 shown)');
    const manyCases = Array.from({ length: 21 }, (_, index) => caseChain(`case-${String(index).padStart(2, '0')}`, 1, {
      objective: 'Reach the recorded read through the recorded selector', demonstratedThrough: 1,
      steps: [{ order: 1, step: 'Read the selected record through the recorded endpoint', claimRef: 'claim-record-1', needs: [], gained: [], effect: 'confidentiality-read' }],
    }));
    expect(attackPathSection([], [], manyCases).join('\n')).toContain('1 more accepted case chain(s) not shown (20 shown)');
    const deepCase = [caseChain('case-deep', 1, { objective: 'Reach the recorded read through the recorded selector', demonstratedThrough: 27,
      steps: Array.from({ length: 27 }, (_, index) => ({ order: index + 1, step: 'Read the selected record through the recorded endpoint', claimRef: 'claim-record-1', needs: [], gained: [], effect: 'confidentiality-read' })) })];
    expect(attackPathSection([], [], deepCase).join('\n')).toContain('2 more executed link(s) not shown (25 shown)');
  });
});

describe('attack path in the exported report (P22/A4)', () => {
  it('prints every recorded path, marks a plan-only link not executed and keeps the derived label a suggestion', async () => fixture(async h => {
    const built = await populate(h);
    // A chainless run keeps the report it had: the section is added only when a chain was recorded.
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'before')}`);
    expect((await h.read(join(h.root, 'before')))['REPORT.md']).not.toContain('Attack path');

    const second = await seedClaim(h, { candidate: 'a4-second-link', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', gained: [{ kind: 'data.read', subject: 'foreign-object' }], needs: [{ kind: 'data.read', subject: 'selected-object' }] });
    const unused = await seedClaim(h, { candidate: 'a4-unexecuted-link', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing was executed for this link' });
    const objective = 'Reach the fixture object of another actor through the recorded selector and the recorded read primitive';
    await h.call('p2o_case_rate', { id: built.accepted.id, revision: built.accepted.revision, entry: { severity: 'medium', basis: 'Confirmed boundary deviation reaching only the tested identity’s own object in the fixture', chain: {
      objective, demonstratedThrough: 2, steps: [
        { order: 1, step: 'Select an object identity the request does not own through the recorded parameter', claimRef: built.claim.id, gained: [{ kind: 'data.read', subject: 'selected-object' }] },
        { order: 2, step: 'Read the selected object through the recorded endpoint', claimRef: second.id, needs: [{ kind: 'data.read', subject: 'selected-object' }], gained: [{ kind: 'data.read', subject: 'foreign-field' }], effect: 'confidentiality-read' },
        { order: 3, step: 'Write to the selected object with the same primitive', needs: [{ kind: 'file.write', subject: 'selected-object' }] },
      ] } } });
    const plan = (entry: Record<string, unknown>) => h.call('p2o_goal_author', { entry });
    await plan({ kind: 'todo', title: 'Consume the recorded selector primitive', status: 'open', reason: 'The fixture records the first chain-a link', chainOf: 'chain-a', step: 1, claimRefs: [built.claim.id], effect: 'code-execution' });
    await plan({ kind: 'todo', title: 'Read through the recorded primitive', status: 'open', reason: 'The fixture records the second chain-a link', chainOf: 'chain-a', step: 2, claimRefs: [second.id], needs: [{ kind: 'data.read', subject: 'fixture-read' }], effect: 'code-execution' });
    await plan({ kind: 'todo', title: 'Start a branch from an unexecuted primitive', status: 'open', reason: 'The fixture records the only chain-b link', chainOf: 'chain-b', step: 1, claimRefs: [unused.id] });
    await plan({ kind: 'todo', title: 'Reach execution from the branch', status: 'open', reason: 'The fixture records the waiting chain-b link', chainOf: 'chain-b', step: 2, claimRefs: [unused.id], needs: [{ kind: 'exec.code', subject: 'fixture-host' }] });

    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = String((await h.read(join(h.root, 'out')))['REPORT.md']);
    expect(report).toContain('## Attack path — every recorded chain, bounded');
    expect(report).toContain('- Recorded: **2** plan chain(s) with **4** link(s), and **1** accepted current case(s) with a recorded chain.');
    expect(report).toContain('#### Plan chain chain-a');
    expect(report).toContain('#### Plan chain chain-b');
    // A link the accepted case chain executed is joined to it; one no case chain ran stays a plan record.
    expect(report).toContain(`executed: case ${built.accepted.id} r${built.accepted.revision} step 1`);
    const planOnly = report.split('\n').find((line: string) => line.includes(unused.id) && line.includes('not executed — plan record only'))!;
    expect(planOnly, 'a plan-only link is printed as not executed').toBeDefined();
    expect(planOnly).not.toMatch(/demonstrated|proved|evidence/);
    const typed = report.split('\n').find((line: string) => line.startsWith('| 2/2 |') && line.includes('executed: case'))!;
    expect(typed).toContain('| code-execution | confidentiality-read |'); // target effect recorded, derived label from the typed need
    expect(report).toContain(`**Case chain ${built.accepted.id} r${built.accepted.revision}** — ${objective}`);
    expect(report).toContain('executed through step 2 of 3');
    expect(report).toContain('1 written link(s) after the demonstrated depth were not executed; the chain records no run for them.');
    expect(report).toContain('A recorded chain is not proof of a path');
    expect(report).toContain('derived suggestion, not a rating');
  }));
});
