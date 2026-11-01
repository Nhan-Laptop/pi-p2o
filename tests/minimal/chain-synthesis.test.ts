import { describe, expect, it } from 'vitest';
import { fixture, populate, seedClaim } from './helpers/report-fixture.js';
import { CHAIN_CANDIDATE_CAP_BY_SOURCE, CHAIN_CANDIDATE_MAX_TOTAL, rankChainCandidates, type ChainCandidate } from '../../src/chain-view.js';

/**
 * planning_update.md P25 §3.5: `p2o_graph_plan action=chain` now also derives a bounded `synthesis` read over four sources
 * (frontier/primitive/asset/finding). Every source is a read over claims, obligations, the asset graph and accepted case
 * chains the run already records; `plan:true` is unchanged below (it still composes only from `join.frontier`), and a read
 * writes nothing — none of `synthesis` can satisfy readiness, a rating or completion.
 */
const cand = (source: ChainCandidate['source'], patch: Partial<ChainCandidate> = {}): ChainCandidate =>
  ({ source, planable: source === 'frontier', rank: 0, needs: [], gained: [], why: `${source} candidate`, ...patch });

describe('rankChainCandidates (P25 §3.5, pure)', () => {
  it('caps each source independently, then trims the overall total from the lowest-priority gap tail', () => {
    const raw: ChainCandidate[] = [
      ...Array.from({ length: 5 }, (_, index) => cand('frontier', { claimId: `f${index}`, rank: index })),
      ...Array.from({ length: 5 }, (_, index) => cand('primitive', { claimId: `p${index}`, needs: [{ kind: 'data.read' }] })),
      ...Array.from({ length: 5 }, (_, index) => cand('asset', { claimId: `a${index}`, path: { assets: [`asset-${index}`], relations: [], depth: 0 } })),
      ...Array.from({ length: 5 }, (_, index) => cand('finding', { caseId: `c${index}` })),
    ];
    const ranked = rankChainCandidates(raw);
    expect(ranked.counts).toEqual({ frontier: 5, primitive: 5, asset: 5, finding: 5 });
    // Per-source caps: frontier/primitive ≤3, asset/finding ≤2.
    expect(ranked.candidates).toHaveLength(CHAIN_CANDIDATE_CAP_BY_SOURCE.frontier);
    expect(ranked.candidates.map(item => item.claimId)).toEqual(['f4', 'f3', 'f2']); // deepest (highest rank) first
    expect(ranked.gaps.filter(item => item.source === 'primitive')).toHaveLength(CHAIN_CANDIDATE_CAP_BY_SOURCE.primitive);
    expect(ranked.gaps.filter(item => item.source === 'finding')).toHaveLength(CHAIN_CANDIDATE_CAP_BY_SOURCE.finding);
    // 3+3+2+2=10 survives the per-source caps; the overall cap (9) drops one, and asset is the lowest-priority gap source.
    expect(ranked.gaps.filter(item => item.source === 'asset')).toHaveLength(CHAIN_CANDIDATE_CAP_BY_SOURCE.asset - 1);
    expect(ranked.candidates.length + ranked.gaps.length).toBe(CHAIN_CANDIDATE_MAX_TOTAL);
    expect(ranked.omitted).toBe(raw.length - CHAIN_CANDIDATE_MAX_TOTAL);
    expect(ranked.shown).toEqual({ candidates: ranked.candidates.length, gaps: ranked.gaps.length });
    // Gap source order is primitive → finding → asset.
    const order = ranked.gaps.map(item => item.source);
    expect(order.indexOf('primitive')).toBeLessThan(order.indexOf('finding'));
    expect(order.indexOf('finding')).toBeLessThan(order.indexOf('asset'));
  });

  it('never drops a planable candidate for the overall cap, and ranks order-independently', () => {
    const raw: ChainCandidate[] = [cand('frontier', { claimId: 'only-ready', rank: 9 }),
      ...Array.from({ length: 12 }, (_, index) => cand('primitive', { claimId: `p${index}`, needs: [{ kind: 'data.read' }, ...(index % 2 ? [{ kind: 'file.read' } as const] : [])] }))];
    const ranked = rankChainCandidates(raw);
    expect(ranked.candidates).toEqual([expect.objectContaining({ claimId: 'only-ready' })]);
    expect(ranked.candidates.length + ranked.gaps.length).toBeLessThanOrEqual(CHAIN_CANDIDATE_MAX_TOTAL);
    expect(rankChainCandidates([...raw].reverse())).toEqual(ranked);
  });

  it('breaks a rank tie by severityHint, but never ahead of the structural rank (W-A/F3)', () => {
    const tie: ChainCandidate[] = [
      cand('frontier', { claimId: 'plain', rank: 2 }),
      cand('frontier', { claimId: 'cvss-9', rank: 2, severityHint: { cvss: 9 } }),
      cand('frontier', { claimId: 'auth-weakened', rank: 2, severityHint: { authWeakened: true } }),
    ];
    expect(rankChainCandidates(tie).candidates.map(item => item.claimId)).toEqual(['cvss-9', 'auth-weakened', 'plain']);

    const structural: ChainCandidate[] = [
      cand('frontier', { claimId: 'shallow-but-severe', rank: 2, severityHint: { cvss: 10 } }),
      cand('frontier', { claimId: 'deeper-but-plain', rank: 3 }),
    ];
    // A higher structural rank always wins first regardless of severity: severityRank is consulted only on a rank tie.
    expect(rankChainCandidates(structural).candidates.map(item => item.claimId)).toEqual(['deeper-but-plain', 'shallow-but-severe']);
  });
});

describe('p2o_graph_plan action=chain synthesis (P25 §3.5, integration)', () => {
  it('names the ready frontier as planable candidates, and reads without moving the ledger sequence', async () => fixture(async h => {
    const built = await populate(h);
    const claim = (params: Record<string, unknown>) => seedClaim(h, { surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...params });
    await claim({ candidate: 'syn-primitive', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', gained: [{ kind: 'data.read', subject: 'syn-object' }] });
    await claim({ candidate: 'syn-consumer', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
      needs: [{ kind: 'data.read', subject: 'syn-object' }], gained: [{ kind: 'exec.code', subject: 'syn-app-host' }],
      severityHint: { cve: ['CVE-2021-41773'], cvss: 7.5 } });

    const before = (await h.reader()).sequence();
    const view = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    expect((await h.reader()).sequence()).toBe(before);

    const synthesis = view.synthesis;
    expect(synthesis.label).toMatch(/derived/);
    const frontierCandidate = synthesis.candidates.find((item: any) => item.claimId === 'syn-consumer');
    expect(frontierCandidate).toMatchObject({ source: 'frontier', planable: true, needs: [{ kind: 'data.read', subject: 'syn-object' }] });
    expect(frontierCandidate.why).toContain('syn-primitive → syn-consumer');
    // A planable candidate names what its claim record would hand on, not an empty list: the reader sees the successor's effect.
    expect(frontierCandidate.gained).toEqual([{ kind: 'exec.code', subject: 'syn-app-host' }]);
    // W-A/F3: the claim's own cited severity signal survives the candidate-read allowlist (candidateClaims) and the
    // chainSynthesis frontier loop, reaching the ChainCandidate a caller actually sees.
    expect(frontierCandidate.severityHint).toEqual({ cve: ['CVE-2021-41773'], cvss: 7.5 });
    // The synthesis is pre-bounded on its own (4 KiB incl. research) and the whole page stays inside the shared 24 KiB read bound.
    expect(Buffer.byteLength(JSON.stringify(synthesis))).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(24 * 1024);
    expect(synthesis.counts.frontier).toBeGreaterThanOrEqual(1);
    expect(synthesis.shown.candidates).toBeLessThanOrEqual(synthesis.counts.frontier + synthesis.counts.primitive + synthesis.counts.asset + synthesis.counts.finding);
  }));

  it('names a primitive gap for a demonstrated claim with no successor, pointing at the open claim it partially unlocks', async () => fixture(async h => {
    const built = await populate(h);
    const claim = (params: Record<string, unknown>) => seedClaim(h, { surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...params });
    const primitive = await claim({ candidate: 'syn-unchained', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', gained: [{ kind: 'cred.session' }] });
    await claim({ candidate: 'syn-partial-unmet', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', needs: [{ kind: 'cred.session' }, { kind: 'file.read' }] });

    const view = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    expect(view.unmet).toContain('syn-partial-unmet');
    const gap = view.synthesis.gaps.find((item: any) => item.source === 'primitive' && item.claimId === 'syn-partial-unmet');
    expect(gap).toBeDefined();
    expect(gap.gained).toEqual([{ kind: 'cred.session' }]);
    expect(gap.needs).toEqual([{ kind: 'file.read' }]); // still missing even with this primitive counted
    expect(gap.planRefusal).toMatch(/no claim record/);
    expect(gap.recordId).toBe(primitive.recordId);
    expect(gap.why).toContain(primitive.recordId);
    expect(gap.why).toContain('syn-partial-unmet');
  }));

  it('names an asset gap with the exact relations traversed from the ready claim\'s starting asset', async () => fixture(async h => {
    const built = await populate(h);
    const recorded = await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'host', key: 'host-syn' }, ref: 'host' }, { asset: { kind: 'service', key: 'svc-syn' }, ref: 'svc' }],
      relations: [{ kind: 'hosts', fromId: '@host', toId: '@svc', fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [built.observation.evidenceId] }] } });
    const [host, svc] = recorded.details.acks.filter((ack: { kind: string }) => ack.kind === 'asset').map((ack: { entityId: string }) => ack.entityId);
    const claim = (params: Record<string, unknown>) => seedClaim(h, { surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...params });
    await claim({ candidate: 'syn-asset-primitive', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', gained: [{ kind: 'data.read', subject: 'syn-asset' }] });
    await claim({ candidate: 'syn-asset-consumer', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
      needs: [{ kind: 'data.read', subject: 'syn-asset' }], gained: [{ kind: 'data.read', subject: 'syn-asset-next' }],
      assetRefs: [{ id: host, revision: 1 }] });

    const view = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    expect(view.frontier[0]).toMatchObject({ claimId: 'syn-asset-consumer' });
    const gap = view.synthesis.gaps.find((item: any) => item.source === 'asset' && item.claimId === 'syn-asset-consumer');
    expect(gap).toBeDefined();
    expect(gap.path).toMatchObject({ assets: [host, svc], relations: ['hosts'], depth: 1 });
    // `path.effect` names the capability kinds the walked path would extend (the source claim's recorded gained kinds).
    expect(gap.path.effect).toContain('data.read');
    expect(gap.planRefusal).toBe('a path is not a claim');
  }));

  it('flags an asset-gap path as truncated once the reachability walk hits its own path cap (MAX_PATHS=10)', async () => fixture(async h => {
    const built = await populate(h);
    const extraServices = Array.from({ length: 11 }, (_, index) => ({ asset: { kind: 'service', key: `svc-cap-${index}` }, ref: `svc${index}` }));
    const recorded = await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'host', key: 'host-cap' }, ref: 'host' }, ...extraServices],
      relations: extraServices.map(svc => ({ kind: 'hosts', fromId: '@host', toId: `@${svc.ref}`, fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [built.observation.evidenceId] })) } });
    const [host] = recorded.details.acks.filter((ack: { kind: string }) => ack.kind === 'asset').map((ack: { entityId: string }) => ack.entityId);
    const claim = (params: Record<string, unknown>) => seedClaim(h, { surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...params });
    await claim({ candidate: 'syn-cap-primitive', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', gained: [{ kind: 'data.read', subject: 'syn-cap-asset' }] });
    await claim({ candidate: 'syn-cap-consumer', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
      needs: [{ kind: 'data.read', subject: 'syn-cap-asset' }], gained: [{ kind: 'data.read', subject: 'syn-cap-asset-next' }],
      assetRefs: [{ id: host, revision: 1 }] });

    const view = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    const gap = view.synthesis.gaps.find((item: any) => item.source === 'asset' && item.claimId === 'syn-cap-consumer');
    expect(gap).toBeDefined();
    // 11 one-hop targets exceed graphPath's own MAX_PATHS (10): the walk is cut off before it has seen every reachable asset.
    expect(gap.path.truncated).toBe(true);
    expect(gap.why).toContain('walk capped before finishing — a longer or different path may exist');
    // W-B/Option C: the per-candidate flag rolls up into a health summary a caller can check without scanning every gap.
    // Both hops sliced from this one truncated walk (`walk.paths.slice(0, 2)`) inherit the same walk-level flag.
    expect(view.synthesis.truncated).toEqual({ candidates: 0, gaps: 2 });
  }));

  it('names a finding gap from an accepted case chain\'s leftover capability, walking a path from its asset', async () => fixture(async h => {
    const built = await populate(h);
    const recorded = await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /report-fixture-alias' }, ref: 'alias' }],
      relations: [{ kind: 'alias_of', fromId: built.asset.entityId, toId: '@alias', fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [built.observation.evidenceId] }] } });
    const svc = recorded.details.acks.find((ack: { kind: string }) => ack.kind === 'asset').entityId;
    const chain = { objective: 'Reach a second effect through the fixture endpoint', demonstratedThrough: 1,
      steps: [{ order: 1, step: 'Read through the recorded endpoint', claimRef: built.claim.id, gained: [{ kind: 'db.query', subject: 'syn-finding' }], needs: [], effect: 'confidentiality-read' }] };
    await h.call('p2o_case_rate', { id: built.accepted.id, revision: built.accepted.revision,
      entry: { severity: 'medium', basis: 'Confirmed boundary deviation reaching only the tested identity’s own object in the fixture', chain } });

    const view = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    const gap = view.synthesis.gaps.find((item: any) => item.source === 'finding' && item.caseId === built.accepted.id);
    expect(gap).toBeDefined();
    expect(gap.gained).toEqual([{ kind: 'db.query', subject: 'syn-finding' }]);
    expect(gap.path.assets[0]).toBe(built.asset.entityId);
    expect(gap.path.relations).toContain('alias_of');
    expect(gap.findingId).toBeDefined();
    // The next plausible effect class is the last effect the rating recorded; the walk names the hanging capability kinds.
    expect(gap.effect).toBe('confidentiality-read');
    expect(gap.path.effect).toContain('db.query');
    expect(gap.planRefusal).toBe('a path is not a claim');
    void svc;
  }));

  it('keeps plan:true unchanged: composes ≤3 planable chains from the ranked frontier and dispatches nothing', async () => fixture(async h => {
    const built = await populate(h);
    const claim = (params: Record<string, unknown>) => seedClaim(h, { surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...params });
    for (const index of [1, 2, 3, 4]) await claim({ candidate: `syn-multi-primitive-${index}`, closure: 'confirmed', execution: 'tested', proof: 'live_reproduction',
      gained: [{ kind: 'http.request', subject: `syn-multi-api-${index}` }] });
    for (const index of [1, 2, 3, 4]) await claim({ candidate: `syn-multi-consumer-${index}`, closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
      needs: [{ kind: 'http.request', subject: `syn-multi-api-${index}` }], gained: [{ kind: 'exec.code', subject: 'syn-app-host' }] });

    const view = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    expect(view.synthesis.counts.frontier).toBe(4);
    expect(view.synthesis.candidates).toHaveLength(3); // frontier source caps at 3, independent of the page's own `limit`

    const planned = (await h.call('p2o_graph_plan', { action: 'chain', plan: true, assetRefs: [{ id: built.asset.entityId, revision: 1 }], requestId: 'chain-synthesis-plan' })).details;
    expect(planned.entries).toHaveLength(3);
    expect(planned.chains).toHaveLength(3);
    expect(planned.chains.every((chain: any) => chain.todos.length === 2)).toBe(true);
    expect((await h.call('p2o_board', { board: 'tasks' })).details.total).toBe(2); // only the fixture's two tasks; nothing dispatched
  }));
});
