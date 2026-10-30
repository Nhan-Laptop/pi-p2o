import { describe, expect, it } from 'vitest';
import { CASE_CHAIN_MAX_CHAINS, CASE_CHAIN_MAX_LINKS, projectCaseChains, type CaseChainSource } from '../../src/case-chain-view.js';
import type { Capability } from '../../src/capabilities.js';
import type { CaseChain, CaseChainStep } from '../../src/case-types.js';

/**
 * P22/A3: the accepted-case chain projection the round brief's ready section prints. The module is a pure read over the case
 * view and the claim heads, so these fixtures are exactly the two inputs the extension hands it; the tests pin the executed
 * boundary, the join that decides what is left hanging, the eligibility gates, and both bounds.
 */
const OBJECTIVE = 'Reach the foreign invoice object through the recorded selector and then extend it to a write';
const read = (subject: string): Capability => ({ kind: 'data.read', subject });
const session = (subject: string): Capability => ({ kind: 'cred.session', subject });
const write = (subject: string): Capability => ({ kind: 'file.write', subject });

const step = (order: number, extra: Partial<CaseChainStep> = {}): CaseChainStep => ({ order, step: `Executed link ${order}`, gained: [], needs: [], ...extra });
const chain = (steps: CaseChainStep[], demonstratedThrough?: number): CaseChain => ({
  objective: OBJECTIVE, steps, ...(demonstratedThrough !== undefined ? { demonstratedThrough } : {}),
});
const view = (id: string, overrides: { chain?: CaseChain; acceptedFinding?: boolean; ratingCurrent?: boolean; revision?: number } = {}): CaseChainSource => ({
  id, revision: overrides.revision ?? 3, acceptedFinding: overrides.acceptedFinding ?? true, ratingCurrent: overrides.ratingCurrent ?? true,
  ...(overrides.chain ? { finding: { chain: overrides.chain } } : {}),
});

describe('case chain projection (P22/A3)', () => {
  it('projects the executed links only and respects demonstratedThrough', () => {
    const cases = [view('case-rated', { chain: chain([
      step(1, { claimRef: 'rec-first', gained: [read('selected-object')] }),
      step(2, { claimRef: 'rec-second', gained: [read('foreign-field')], needs: [read('selected-object')], effect: 'confidentiality-read' }),
      step(3, { needs: [write('selected-object')] }),
    ], 2) })];
    const before = JSON.stringify(cases), projection = projectCaseChains({ cases });
    expect(projection.total).toBe(1);
    expect(projection.chains[0]).toMatchObject({ caseId: 'case-rated', revision: 3, demonstratedThrough: 2, totalSteps: 3, omittedLinks: 0 });
    // The reasoned third link is not projected: only the claims that actually ran establish the path.
    expect(projection.chains[0]!.links.map(link => link.order)).toEqual([1, 2]);
    expect(projection.chains[0]!.links[1]).toMatchObject({ order: 2, claim: 'rec-second', effect: 'confidentiality-read' });
    // A projection is a read: the caller's read is not rewritten.
    expect(JSON.stringify(cases)).toBe(before);
  });

  it('projects a chain with no demonstrated depth as reasoned only, with no executed link', () => {
    const projection = projectCaseChains({ cases: [view('case-reasoned', { chain: chain([step(1), step(2)]), revision: 2 })] });
    expect(projection.chains[0]).toMatchObject({ caseId: 'case-reasoned', revision: 2, totalSteps: 2, omittedLinks: 0 });
    expect(projection.chains[0]!.demonstratedThrough).toBeUndefined();
    expect(projection.chains[0]!.links).toEqual([]);
    expect(projection.chains[0]!.leftover).toEqual([]);
  });

  it('excludes a case that is not accepted, not current-rated, unrated or chainless', () => {
    const projection = projectCaseChains({ cases: [
      view('case-not-accepted', { chain: chain([step(1)], 1), acceptedFinding: false }),
      view('case-stale-rating', { chain: chain([step(1)], 1), ratingCurrent: false }),
      view('case-unrated'),
      view('case-rating-without-chain'),
      { id: 'case-pending-verdict', revision: 1, acceptedFinding: false, ratingCurrent: true, finding: { chain: chain([step(1)], 1) } },
    ] });
    expect(projection).toEqual({ chains: [], total: 0 });
  });

  it('resolves a claim record id to the slug the join keys on and keeps an unknown reference as recorded', () => {
    const cases = [
      view('case-by-record-id', { chain: chain([step(1, { claimRef: 'rec-primitive' })], 1) }),
      view('case-retired-claim', { chain: chain([step(1, { claimRef: 'rec-superseded' })], 1) }),
    ];
    const projection = projectCaseChains({ cases, claims: [{ candidate: 'login-primitive', recordId: 'rec-primitive' }] });
    const claimOf = (caseId: string) => projection.chains.find(chain => chain.caseId === caseId)!.links[0]!.claim;
    expect(claimOf('case-by-record-id')).toBe('login-primitive');
    // The one identity that cannot be resolved stays readable instead of vanishing.
    expect(claimOf('case-retired-claim')).toBe('rec-superseded');
    // A step may cite the slug directly; the recorded reference is what the brief prints.
    const bySlug = projectCaseChains({ cases: [view('case-by-slug', { chain: chain([step(1, { claimRef: 'login-primitive' })], 1) })] });
    expect(bySlug.chains[0]!.links[0]!.claim).toBe('login-primitive');
  });

  it('derives the capability no later executed link consumes, and no reasoned link consumes anything', () => {
    const projection = projectCaseChains({ cases: [view('case-hanging', { chain: chain([
      step(1, { gained: [read('foreign-object'), session('alice')] }),
      step(2, { needs: [read('foreign-object')], gained: [{ kind: 'exec.code', subject: 'fixture-host' }] }),
      // Beyond the demonstrated depth: an unexecuted link consumes nothing, so the session above is still left hanging.
      step(3, { needs: [session('alice')], gained: [] }),
    ], 2) })] });
    expect(projection.chains[0]!.leftover).toEqual([session('alice'), { kind: 'exec.code', subject: 'fixture-host' }]);
  });

  it('dedupes a capability two executed links gained, keeping first-gained order', () => {
    const projection = projectCaseChains({ cases: [
      view('case-duplicate', { chain: chain([step(1, { gained: [read('same-object')] }), step(2, { gained: [read('same-object'), write('same-object')] })], 2) }),
      view('case-none', { chain: chain([step(1, { claimRef: 'rec-effect', needs: [write('other-object')] })], 1) }),
    ] });
    expect(projection.chains[0]!.leftover).toEqual([read('same-object'), write('same-object')]);
    // A chain whose only capability is a need never gained anything, so nothing is left hanging.
    expect(projection.chains[1]!.leftover).toEqual([]);
  });

  it('does not join or project pre-P14 prose as a typed capability', () => {
    const projection = projectCaseChains({ cases: [view('case-legacy', { chain: chain([
      step(1, { gained: [{ legacy: 'a selected foreign object identity' }] }),
      step(2, { needs: [{ kind: 'cred.session' }], gained: [read('typed-effect')] }),
    ], 2) })] });
    const [projected] = projection.chains;
    // Legacy text is readable in the case report, but it joins to nothing: it is not projected as a link capability...
    expect(projected!.links[0]!.gained).toEqual([]);
    // ...and a typed capability is not consumed by it, so it stays left hanging.
    expect(projected!.leftover).toEqual([read('typed-effect')]);
  });

  it('bounds the chains to the most actionable and reports the true total', () => {
    const projection = projectCaseChains({ cases: [
      view('case-complete', { chain: chain([step(1, { gained: [read('a')] }), step(2, { needs: [read('a')] })], 2) }),
      view('case-two-left-one-link', { chain: chain([step(1, { gained: [read('b'), write('b')] })], 1) }),
      view('case-two-left-three-links', { chain: chain([step(1, { gained: [read('c'), write('c')] }), step(2), step(3)], 3) }),
      view('case-one-left', { chain: chain([step(1, { gained: [session('d')] })], 1) }),
    ] });
    // Two chains left two typed capabilities hanging; the deeper executed path wins the tie, then the id decides.
    expect(projection.total).toBe(4);
    expect(projection.chains.map(chain => chain.caseId)).toEqual(['case-two-left-three-links', 'case-two-left-one-link']);
    expect(projection.chains).toHaveLength(CASE_CHAIN_MAX_CHAINS);
  });

  it('bounds a deep chain to its last executed links and counts the omitted ones', () => {
    const steps = Array.from({ length: 5 }, (_, index) => step(index + 1, index === 0 ? { gained: [read('from-first-link')] } : {}));
    const projection = projectCaseChains({ cases: [view('case-deep', { chain: chain(steps, 5) })] });
    const [projected] = projection.chains;
    expect(projected!.links.map(link => link.order)).toEqual([4, 5]);
    expect(projected!.omittedLinks).toBe(5 - CASE_CHAIN_MAX_LINKS);
    // The leftover is derived over every executed link, including the ones the page does not print.
    expect(projected!.leftover).toEqual([read('from-first-link')]);
  });
});
