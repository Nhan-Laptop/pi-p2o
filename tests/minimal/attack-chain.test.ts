import { describe, expect, it } from 'vitest';
import { attackChainFor, attackChainLines, attackChainOrderLine, attackChainReportRows, attackChains, ATTACK_CHAIN_BYTES,
  ATTACK_CHAIN_LINE_CHARS, ATTACK_CHAIN_MAX_CHAINS, ATTACK_CHAIN_MAX_STEPS } from '../../src/attack-chain.js';
import type { Capability } from '../../src/capabilities.js';
import type { CaseChainSource } from '../../src/case-chain-view.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { CaseChain } from '../../src/case-types.js';
import type { CaseEffect } from '../../src/cvss.js';
import { explorationNodeId, type ExplorationEdgeRow, type ExplorationNodeRow, type ExplorationSnapshot } from '../../src/exploration-graph.js';
import type { PlanEntry } from '../../src/planning.js';

/**
 * planning_update.md P25 §3.4: the canonical `AttackChain` read merges the plan chain, the current accepted case rating and
 * the persisted `leads_to` order edge. It is a pure projection — executed comes only from a current rating's demonstrated
 * depth, adjacency is recorded or it says so, and no builder here can write, rate, prove or complete anything.
 */
const runId = 'run-chain';
const nodeOf = (kind: ExplorationNodeRow['kind'], entityId: string, body: Record<string, unknown> = {}): ExplorationNodeRow => ({
  id: explorationNodeId(kind, runId, entityId), kind, state: kind === 'link' ? 'open' : 'demonstrated', entityId,
  sequence: 1, createdSequence: 1, updatedSequence: 1, body,
});
const snapshotOf = (nodes: ExplorationNodeRow[], edges: ExplorationEdgeRow[] = []): ExplorationSnapshot => ({
  version: 1, runId, asOfSequence: 9, graphVersion: 2,
  counts: { nodes: nodes.length, edges: edges.length, anchors: 0 },
  unresolved: 0, overflow: 0, chainOrderTruncated: 0, nodes, edges, anchors: [],
});
const planOf = (patch: Partial<PlanEntry> & { id: string }): PlanEntry => ({
  runId, revision: 1, recordId: `rec-${patch.id}`, kind: 'todo', title: patch.id, status: 'open', reason: 'chain fixture', ...patch,
});
const claimOf = (slug: string, gained: Capability[] = []): ChainClaim => ({
  candidate: slug, recordId: `rec-${slug}`, recordIds: [`rec-${slug}`], gained, closure: 'confirmed', execution: 'tested', needs: [],
} as unknown as ChainClaim);
/** A head the run has not demonstrated: it resolves for identity, but it hands no capability on (F9). */
const openClaimOf = (slug: string, gained: Capability[] = []): ChainClaim => ({
  candidate: slug, recordId: `rec-${slug}`, recordIds: [`rec-${slug}`], gained, closure: 'open_proof_gap', execution: 'not_tested', needs: [],
} as unknown as ChainClaim);
const chainOf = (objective: string, steps: ReadonlyArray<{ claimRef?: string; step?: string; effect?: CaseEffect }>, demonstratedThrough?: number): CaseChain => ({
  objective,
  steps: steps.map((item, index) => ({ order: index + 1, step: item.step ?? `recorded step ${index + 1}`,
    ...(item.claimRef ? { claimRef: item.claimRef } : {}), ...(item.effect ? { effect: item.effect } : {}), gained: [], needs: [] })),
  ...(demonstratedThrough !== undefined ? { demonstratedThrough } : {}),
});
const caseOf = (id: string, chain: CaseChain, patch: Partial<CaseChainSource> = {}): CaseChainSource =>
  ({ id, revision: 1, acceptedFinding: true, ratingCurrent: true, finding: { chain }, ...patch });
const capability = (kind: 'net.egress' | 'cred.session' | 'data.read'): Capability => ({ kind });

describe('P25 §3.4 canonical AttackChain', () => {
  it('builds a plan-only chain in recorded order and never calls a step executed without a rating', () => {
    const linkOne = nodeOf('link', 'plan-1', { chainOf: 'chain-a', step: 1, title: 'Get foothold' });
    const linkTwo = nodeOf('link', 'plan-2', { chainOf: 'chain-a', step: 2, title: 'Read data' });
    const factOne = nodeOf('fact', 'claim-one');
    const snapshot = snapshotOf([linkOne, linkTwo, factOne], [{ srcId: linkOne.id, rel: 'leads_to', dstId: linkTwo.id, sequence: 2 }]);
    const plans = [
      planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, title: 'Get foothold', status: 'done', claimRefs: ['rec-claim-one'],
        effect: 'authentication-bypass' }),
      planOf({ id: 'plan-2', chainOf: 'chain-a', step: 2, title: 'Read data', claimRefs: ['rec-claim-two'] }),
    ];
    const claims = [claimOf('claim-one', [capability('cred.session')]), claimOf('claim-two', [capability('data.read')])];
    const set = attackChains({ snapshot, plans, claims, cases: [] });
    expect(set.total).toBe(1);
    const chain = set.chains[0]!;
    expect(chain.id).toBe('chain-a');
    expect(chain.sources).toEqual(['plan']);
    expect(chain.steps.map(step => step.order)).toEqual([1, 2]);
    expect(chain.steps.map(step => step.claimId)).toEqual(['claim-one', 'claim-two']);
    expect(chain.steps.every(step => step.executed === false)).toBe(true);
    expect(chain.steps[0]).toMatchObject({ state: 'done', effect: 'authentication-bypass' });
    expect(chain.steps[0]!.nodeRefs).toEqual({ link: linkOne.id, fact: factOne.id });
    expect(chain.steps[0]!.orderEdge).toBe('recorded');
    expect(chain.steps[1]!.orderEdge).toBeUndefined();
    expect(chain.leftover).toEqual([]);
    expect(chain.demonstratedThrough).toBeUndefined();
  });

  it('says step-only when no leads_to edge joins two recorded steps, so an un-repaired store reads honestly', () => {
    const plans = [
      planOf({ id: 'plan-1', chainOf: 'chain-b', step: 1, title: 'First' }),
      planOf({ id: 'plan-2', chainOf: 'chain-b', step: 2, title: 'Second' }),
    ];
    const snapshot = snapshotOf([nodeOf('link', 'plan-1', { chainOf: 'chain-b', step: 1 }), nodeOf('link', 'plan-2', { chainOf: 'chain-b', step: 2 })]);
    const chain = attackChains({ snapshot, plans, claims: [], cases: [] }).chains[0]!;
    expect(chain.steps[0]!.orderEdge).toBe('step-only');
  });

  it('keeps a case chain separate when no plan row names the same claim, and marks only demonstrated links executed', () => {
    const finding = nodeOf('finding', 'case-one');
    const snapshot = snapshotOf([finding, nodeOf('fact', 'claim-one')]);
    const cases = [caseOf('case-one', chainOf('Read the fixture data', [
      { claimRef: 'rec-claim-one', effect: 'authentication-bypass' }, { claimRef: 'rec-claim-two' }, { claimRef: 'rec-claim-three' },
    ], 2))];
    const chain = attackChains({ snapshot, plans: [], claims: [claimOf('claim-one')], cases }).chains[0]!;
    expect(chain.id).toBe('case-case-one');
    expect(chain.sources).toEqual(['case']);
    expect(chain.steps.map(step => step.executed)).toEqual([true, true, false]);
    expect(chain.demonstratedThrough).toBe(2);
    expect(chain.steps.at(-1)!.nodeRefs.finding).toBe(finding.id);
    expect(chain.status).toContain('2/3 executed');
  });

  it('merges a rating into the one plan chain that names the same claim and takes executed depth from the rating', () => {
    const linkOne = nodeOf('link', 'plan-1', { chainOf: 'chain-a', step: 1 }), linkTwo = nodeOf('link', 'plan-2', { chainOf: 'chain-a', step: 2 });
    const factOne = nodeOf('fact', 'claim-one'), finding = nodeOf('finding', 'case-one');
    const snapshot = snapshotOf([linkOne, linkTwo, factOne, finding], [{ srcId: linkOne.id, rel: 'leads_to', dstId: linkTwo.id, sequence: 2 }]);
    const plans = [
      planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, status: 'done', claimRefs: ['rec-claim-one'], title: 'Get foothold' }),
      planOf({ id: 'plan-2', chainOf: 'chain-a', step: 2, claimRefs: ['rec-claim-two'], title: 'Read data' }),
    ];
    // The rating cites the plan's record id through its slug: the merge is by claim identity, not by matching strings.
    const cases = [caseOf('case-one', chainOf('Prove the fixture read', [{ claimRef: 'claim-one' }, { claimRef: 'claim-two' }], 1))];
    const chain = attackChains({ snapshot, plans, claims: [claimOf('claim-one'), claimOf('claim-two')], cases }).chains[0]!;
    expect(chain.sources).toEqual(['plan', 'case']);
    expect(chain.steps.map(step => step.executed)).toEqual([true, false]);
    expect(chain.demonstratedThrough).toBe(1);
    expect(chain.objective).toBe('Prove the fixture read');
    expect(chain.steps[0]!.nodeRefs.finding).toBe(finding.id);
    expect(chain.status).toContain('rating 1/2 executed');
    // A page opened by the case id resolves the merged chain, not only the case-only one.
    expect(attackChainFor({ snapshot, plans, claims: [claimOf('claim-one'), claimOf('claim-two')], cases }, 'case-one')?.sources).toEqual(['plan', 'case']);
  });

  it('keeps an ambiguous rating separate when one claim appears in two plan chains, and says why', () => {
    const snapshot = snapshotOf([nodeOf('link', 'plan-1'), nodeOf('link', 'plan-2'), nodeOf('fact', 'claim-one')]);
    const plans = [
      planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, claimRefs: ['rec-claim-one'] }),
      planOf({ id: 'plan-2', chainOf: 'chain-b', step: 1, claimRefs: ['rec-claim-one'] }),
    ];
    const cases = [caseOf('case-one', chainOf('Ambiguous fixture', [{ claimRef: 'rec-claim-one' }], 1))];
    const set = attackChains({ snapshot, plans, claims: [claimOf('claim-one')], cases });
    const separate = set.chains.find(chain => chain.id === 'case-case-one')!;
    expect(separate.sources).toEqual(['case']);
    expect(separate.status).toContain('ambiguous');
    expect(set.chains.filter(chain => chain.sources.includes('plan')).every(chain => chain.sources.length === 1)).toBe(true);
  });

  it('never merges a second rating into a plan chain already merged with another case', () => {
    const snapshot = snapshotOf([nodeOf('link', 'plan-1'), nodeOf('fact', 'claim-one')]);
    const plans = [planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, claimRefs: ['rec-claim-one'] })];
    const cases = [caseOf('case-one', chainOf('First rating', [{ claimRef: 'rec-claim-one' }], 1)),
      caseOf('case-two', chainOf('Second rating', [{ claimRef: 'rec-claim-one' }], 1))];
    const set = attackChains({ snapshot, plans, claims: [claimOf('claim-one')], cases });
    const merged = set.chains.filter(chain => chain.sources.includes('plan'));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toEqual(['plan', 'case']);
    expect(set.chains.find(chain => chain.id === 'case-case-two')!.status).toContain('already merged');
  });

  it('caps chains and steps and always reports how many it omitted', () => {
    const plans = Array.from({ length: ATTACK_CHAIN_MAX_CHAINS + 2 }, (_, index) =>
      planOf({ id: `plan-${index + 1}`, chainOf: `chain-${index + 1}`, step: 1 }));
    const set = attackChains({ snapshot: snapshotOf([]), plans, claims: [], cases: [] }, { chains: 2 });
    expect(set.chains).toHaveLength(2);
    expect(set.total).toBe(ATTACK_CHAIN_MAX_CHAINS + 2);
    expect(set.omitted).toBe(ATTACK_CHAIN_MAX_CHAINS);
    const steps = attackChains({ snapshot: snapshotOf([]), plans: [planOf({ id: 'p', chainOf: 'c', step: 1 }),
      planOf({ id: 'p2', chainOf: 'c', step: 2 }), planOf({ id: 'p3', chainOf: 'c', step: 3 })], claims: [], cases: [] }, { steps: 1 });
    expect(steps.chains[0]!.steps).toHaveLength(1);
    expect(steps.chains[0]!.omittedSteps).toBe(2);
    expect(steps.chains[0]!.truncated).toBe(true);
    expect(ATTACK_CHAIN_MAX_STEPS).toBeGreaterThan(1);
  });

  it('ignores inherited snapshot rows when it resolves nodes and order edges', () => {
    const ownLink = nodeOf('link', 'plan-1', { chainOf: 'chain-a', step: 1 });
    const inheritedLink = { ...nodeOf('link', 'plan-2'), id: 'link-inherited', inheritedFrom: 'run-prior' } as ExplorationNodeRow;
    const snapshot = snapshotOf([ownLink, inheritedLink], [
      { srcId: ownLink.id, rel: 'leads_to', dstId: inheritedLink.id, sequence: 2, inheritedFrom: 'run-prior' },
    ]);
    const plans = [planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1 }), planOf({ id: 'plan-2', chainOf: 'chain-a', step: 2 })];
    const chain = attackChains({ snapshot, plans, claims: [], cases: [] }).chains[0]!;
    expect(chain.steps[1]!.nodeRefs.link).toBeUndefined();
    expect(chain.steps[0]!.orderEdge).toBe('step-only');
    const inheritedCase = attackChains({ snapshot, plans: [], claims: [],
      cases: [caseOf('case-prior', chainOf('Inherited', [{ claimRef: 'rec-x' }], 1))] }).chains[0]!;
    // A rating copied as an inherited node is not in this run's cases at all; the input did not list it, so nothing to merge.
    expect(inheritedCase.id).toBe('case-case-prior');
  });

  it('resolves a chain from a chain id, a case id, a node id, a plan id or a claim record id', () => {
    const link = nodeOf('link', 'plan-1', { chainOf: 'chain-a', step: 1 });
    const fact = nodeOf('fact', 'claim-one');
    const finding = nodeOf('finding', 'case-one');
    const snapshot = snapshotOf([link, fact, finding]);
    const input = { snapshot, plans: [planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, claimRefs: ['rec-claim-one'] })],
      claims: [claimOf('claim-one'), claimOf('claim-two')], cases: [caseOf('case-one', chainOf('Case fixture', [{ claimRef: 'rec-claim-two' }], 1))] };
    expect(attackChainFor(input, 'chain-a')?.id).toBe('chain-a');
    expect(attackChainFor(input, 'case-case-one')?.id).toBe('case-case-one');
    expect(attackChainFor(input, link.id)?.id).toBe('chain-a');
    expect(attackChainFor(input, fact.id)?.id).toBe('chain-a');
    expect(attackChainFor(input, finding.id)?.id).toBe('case-case-one');
    expect(attackChainFor(input, 'rec-claim-one')?.id).toBe('chain-a');
    expect(attackChainFor(input, 'plan-1')?.id).toBe('chain-a');
    expect(attackChainFor(input, 'claim-two')?.id).toBe('case-case-one');
    expect(attackChainFor(input, 'no-such-ref')).toBeUndefined();
  });

  it('renders bounded host lines with the recorded order marker and drops trailing steps by name', () => {
    const linkOne = nodeOf('link', 'plan-1', { chainOf: 'chain-a', step: 1 }), linkTwo = nodeOf('link', 'plan-2', { chainOf: 'chain-a', step: 2 });
    const snapshot = snapshotOf([linkOne, linkTwo, nodeOf('fact', 'claim-one')], [{ srcId: linkOne.id, rel: 'leads_to', dstId: linkTwo.id, sequence: 2 }]);
    const plans = [
      planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, status: 'done', claimRefs: ['rec-claim-one'], title: 'Get foothold' }),
      planOf({ id: 'plan-2', chainOf: 'chain-a', step: 2, claimRefs: ['rec-claim-two'], title: 'Read data' }),
    ];
    const chain = attackChains({ snapshot, plans, claims: [claimOf('claim-one', [capability('cred.session')]), claimOf('claim-two')], cases: [] }).chains[0]!;
    const render = attackChainLines(chain);
    expect(render.truncated).toBe(false);
    expect(render.bytes).toBeLessThanOrEqual(ATTACK_CHAIN_BYTES);
    expect(render.lines[0]).toContain('CHAIN chain-a');
    expect(render.lines.some(line => line.includes('claim-one') && line.includes('nodes'))).toBe(true);
    expect(render.lines.some(line => line.includes('order recorded'))).toBe(true);
    expect(render.lines.at(-1)).toContain('Derived from recorded rows');
    const tight = attackChainLines(chain, { byteCap: render.lines[0]!.length + 120 });
    expect(tight.lines.length).toBeLessThan(render.lines.length);
    expect(tight.lines.some(line => line.startsWith('OMITTED:') && line.includes('step(s)'))).toBe(true);
    expect(tight.lines.at(-1)).toContain('Derived from recorded rows');
    expect(tight.lines[0]!.length).toBeLessThanOrEqual(ATTACK_CHAIN_LINE_CHARS);
  });

  it('renders the one-line order the planner brief prints', () => {
    const plans = [planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1 }), planOf({ id: 'plan-2', chainOf: 'chain-a', step: 2, needs: [] })];
    const chain = attackChains({ snapshot: snapshotOf([]), plans, claims: [], cases: [] }).chains[0]!;
    expect(attackChainOrderLine(chain)).toBe('Chain order: chain-a 1\u21922 (next: step 1 plan-1)');
  });

  it('reduces report rows to plain strings and keeps the recorded/step-only marker', () => {
    const linkOne = nodeOf('link', 'plan-1', { chainOf: 'chain-a', step: 1 }), linkTwo = nodeOf('link', 'plan-2', { chainOf: 'chain-a', step: 2 });
    const snapshot = snapshotOf([linkOne, linkTwo, nodeOf('fact', 'claim-one')], [{ srcId: linkOne.id, rel: 'leads_to', dstId: linkTwo.id, sequence: 2 }]);
    const chain = attackChains({ snapshot, plans: [
      planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, claimRefs: ['rec-claim-one'] }),
      planOf({ id: 'plan-2', chainOf: 'chain-a', step: 2, claimRefs: ['rec-claim-two'] }),
    ], claims: [claimOf('claim-one', [capability('cred.session')]), claimOf('claim-two', [capability('data.read')])], cases: [] }).chains[0]!;
    const { rows, total, omitted } = attackChainReportRows({ label: 'x', chains: [chain], total: 1, omitted: 0 });
    expect(rows).toHaveLength(1);
    expect({ total, omitted }).toEqual({ total: 1, omitted: 0 });
    expect(rows[0]!.sources).toEqual(['plan']);
    expect(rows[0]!.steps[0]).toMatchObject({ order: 1, claimId: 'claim-one', state: 'ready', executed: false, gained: ['cred.session'], orderEdge: 'recorded' });
    expect(typeof rows[0]!.steps[0]!.needs[0] === 'string' || rows[0]!.steps[0]!.needs.length === 0).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('"kind"');
  });

  // W-W: the projection reads only demonstrated evidence and merges executed links by position.
  it('shows a capability only when the claim that gains it is demonstrated (F9)', () => {
    const plans = [planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, claimRefs: ['rec-claim-open'] })];
    const claims = [openClaimOf('claim-open', [capability('cred.session')])];
    const chain = attackChains({ snapshot: snapshotOf([]), plans, claims, cases: [] }).chains[0]!;
    expect(chain.steps[0]!.gained).toEqual([]);
    // The demonstrated twin keeps it, so the rule is the claim's state, not the citation style.
    const demonstrated = attackChains({ snapshot: snapshotOf([]), plans, claims: [claimOf('claim-open', [capability('cred.session')])], cases: [] }).chains[0]!;
    expect(demonstrated.steps[0]!.gained).toEqual([{ kind: 'cred.session' }]);
  });

  it('merges executed links by (claim, order), so duplicate-slug steps do not both read executed (F7)', () => {
    const feeding = nodeOf('link', 'plan-1', { chainOf: 'chain-a', step: 1 }), second = nodeOf('link', 'plan-2', { chainOf: 'chain-a', step: 2 });
    const snapshot = snapshotOf([feeding, second, nodeOf('fact', 'claim-one')]);
    // Two plan steps cite the same claim; the rating records that claim executed at order 1 only.
    const plans = [planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, claimRefs: ['rec-claim-one'] }),
      planOf({ id: 'plan-2', chainOf: 'chain-a', step: 2, claimRefs: ['rec-claim-one'] })];
    const cases = [caseOf('case-one', chainOf('Same slug at two orders', [{ claimRef: 'rec-claim-one' }, { claimRef: 'rec-claim-two' }], 1))];
    const chain = attackChains({ snapshot, plans, claims: [claimOf('claim-one'), claimOf('claim-two')], cases }).chains[0]!;
    expect(chain.steps.map(step => step.executed)).toEqual([true, false]);
    expect(chain.status).toContain('rating 1/2 executed');
  });

  it('resolves every claim a plan step cites, not only the first (F16)', () => {
    const plans = [planOf({ id: 'plan-1', chainOf: 'chain-a', step: 1, claimRefs: ['rec-claim-one', 'rec-claim-two'] })];
    const claims = [claimOf('claim-one', [capability('cred.session')]), claimOf('claim-two', [capability('data.read')])];
    const chain = attackChains({ snapshot: snapshotOf([]), plans, claims, cases: [] }).chains[0]!;
    expect(chain.steps[0]!.claimId).toBe('claim-one');
    expect(chain.steps[0]!.claimIds).toEqual(['claim-one', 'claim-two']);
    expect(chain.steps[0]!.gained).toEqual(expect.arrayContaining([{ kind: 'cred.session' }, { kind: 'data.read' }]));
    // Either cited claim resolves the chain page: the citation list is the identity, not the first entry.
    expect(attackChainFor({ snapshot: snapshotOf([]), plans, claims, cases: [] }, 'claim-two')?.id).toBe('chain-a');
  });
});

describe('W-AB/B chain boundary on canonical steps', () => {
  it('carries the recorded foothold boundary on plan and case-only steps and prints it in the chain lines (H16)', () => {
    const boundaries = new Map([['rec-claim-one', [{ kind: 'foothold' as const, session: 'session-a', port: 4444, user: 'www-data' }]]]);
    const plans = [planOf({ id: 'plan-1', chainOf: 'chain-b', step: 1, claimRefs: ['rec-claim-one'] })];
    const claims = [claimOf('claim-one')];
    const snapshot = snapshotOf([nodeOf('link', 'plan-1', { chainOf: 'chain-b', step: 1 }), nodeOf('fact', 'claim-one')]);
    const chain = attackChains({ snapshot, plans, claims, cases: [], claimBoundaries: boundaries }).chains[0]!;
    expect(chain.steps[0]!.boundaries).toEqual([{ kind: 'foothold', session: 'session-a', port: 4444, user: 'www-data' }]);
    expect(attackChainLines(chain).lines.join('\n')).toContain('boundary foothold session-a:4444 (www-data)');
    // A caller with no boundary index keeps the previous bytes: no field, no line fragment.
    const plain = attackChains({ snapshot, plans, claims, cases: [] }).chains[0]!;
    expect(plain.steps[0]).not.toHaveProperty('boundaries');
    expect(attackChainLines(plain).lines.join('\n')).not.toContain('boundary');
    // A case-only chain resolves the recorded claim reference to the same boundary, not to a second store.
    const rated = [caseOf('case-b', chainOf('Reach the recorded read', [{ claimRef: 'rec-claim-one' }], 1))];
    const caseChain = attackChains({ snapshot: snapshotOf([nodeOf('fact', 'claim-one')]), plans: [], claims, cases: rated, claimBoundaries: boundaries }).chains[0]!;
    expect(caseChain.sources).toEqual(['case']);
    expect(caseChain.steps[0]!.boundaries?.[0]).toMatchObject({ kind: 'foothold', session: 'session-a', port: 4444 });
  });
});
