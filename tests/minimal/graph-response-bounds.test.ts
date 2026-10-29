import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { GRAPH_RESPONSE_BYTES, GRAPH_SUMMARY_BYTES } from '../../src/state/graph.js';
import { createFakePi, EXTENSION_PATH } from './helpers/fake-pi.js';
import { fixture, seedClaim } from './helpers/report-fixture.js';

/**
 * S1/C2 (F-42, F-37): the declaration says every read is bounded, so the bound is proved by a call that actually presses
 * against it. The dossier and the query page trim trailing rows and report the omission, the summary trims its machine
 * rows against its own smaller cap, and the chain page trims the lists it sliced. A page that cannot fit even at its floor
 * is refused by name rather than handed to the model over the bound.
 */
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const resultBytes = (result: { content: Array<{ text: string }> }) => Buffer.byteLength(result.content[0]!.text);

describe('graph response bounds (S1/C2)', () => {
  it('declares p2o_graph as one clause per read verb and under 900 characters', () => {
    const pi = createFakePi();
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH } as never);
    const description = String(pi.tools.get('p2o_graph')!.description);
    expect(description.length).toBeLessThanOrEqual(900);
    for (const verb of ['view', 'query', 'summary', 'export', 'path']) expect(description).toContain(`${verb}:`);
    // The verbs that moved off the read tool must not be advertised here again.
    for (const moved of ['record', 'chain', 'ingest', 'page']) expect(description).not.toContain(`${moved}:`);
  });

  it('trims the view dossier at the byte boundary and reports the omitted rows (F-37)', async () => fixture(async h => {
    await h.command('--target ./source');
    const recorded = await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'service', key: 'GET /bounded' } }] } });
    const assetId = recorded.details.acks[0].entityId as string;
    // Inferred facts need no receipt and each statement may be 2,000 chars, so fourteen of them push the dossier past the bound.
    await h.call('p2o_graph_record', { batch: { facts: Array.from({ length: 14 }, (_, index) => ({ assetId, kind: 'inferred' as const,
      statement: `${index}:${'F'.repeat(1990)}`, confidence: 'low' as const })) } });
    const view = await h.call('p2o_graph', { action: 'view', id: assetId });
    expect(bytes(view.details)).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
    expect(resultBytes(view)).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
    // The dossier names every section it shortened instead of leaving the caller to infer a silent drop.
    expect(view.details.dossier.omitted.facts + view.details.dossier.omitted.relations).toBeGreaterThan(0);
    expect(view.details.counts.assertions).toBe(14);
  }));

  it('keeps query, summary, export, path and the chain page inside their declared byte bounds', async () => fixture(async h => {
    await h.command('--target ./source');
    const evidenceId = (await h.call('p2o_note', { kind: 'evidence', text: 'bounded inert receipt' })).details.recordId as string;
    const recorded = await h.call('p2o_graph_record', { batch: {
      assets: [{ asset: { kind: 'host', key: 'host-a' }, ref: 'host' }, { asset: { kind: 'service', key: 'svc-a' }, ref: 'svc' },
        { asset: { kind: 'endpoint', key: 'GET /bounded' }, ref: 'endpoint' }],
      relations: [{ kind: 'hosts', fromId: '@host', toId: '@svc', fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [evidenceId] },
        { kind: 'exposes', fromId: '@svc', toId: '@endpoint', fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [evidenceId] }] } });
    const [host, , endpoint] = recorded.details.acks.filter((ack: { kind: string }) => ack.kind === 'asset').map((ack: { entityId: string }) => ack.entityId);
    await h.call('p2o_graph_record', { batch: { facts: Array.from({ length: 14 }, (_, index) => ({ assetId: endpoint, kind: 'inferred' as const,
      statement: `${index}:${'Q'.repeat(1990)}`, confidence: 'low' as const })) } });

    const query = await h.call('p2o_graph', { action: 'query', limit: 50 });
    expect(bytes(query.details)).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
    expect(query.details.truncated).toBe(true);
    expect(query.details.omitted).toBeGreaterThan(0);
    expect(query.details.counts.assertions).toBe(14);

    const summary = await h.call('p2o_graph', { action: 'summary', cursor: 0, limit: 10 });
    expect(bytes(summary.details)).toBeLessThanOrEqual(GRAPH_SUMMARY_BYTES);
    expect(resultBytes(summary)).toBeLessThanOrEqual(GRAPH_SUMMARY_BYTES);

    const exported = await h.call('p2o_graph', { action: 'export', limit: 500 });
    expect(bytes(exported.details)).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);

    const walked = await h.call('p2o_graph', { action: 'path', fromId: host });
    expect(bytes(walked.details)).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
    expect(walked.details.paths.length).toBeGreaterThan(0);

    // Two claims are enough to prove the chain page is wired through the fitter and reports shown against counts.
    const claim = (params: Record<string, unknown>) => seedClaim(h, { surface: '/bounded-fixture', risk: 'authorization', evidenceRefs: [evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture only', ...params });
    await claim({ candidate: 'bound-primitive', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', gained: [{ kind: 'data.read', subject: 'bounded' }] });
    await claim({ candidate: 'bound-consumer', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', needs: [{ kind: 'data.read', subject: 'bounded' }] });
    const chain = await h.call('p2o_graph_plan', { action: 'chain' });
    expect(bytes(chain.details)).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
    expect(chain.details.shown.frontier).toBeLessThanOrEqual(chain.details.counts.frontier);
    expect(chain.details.counts.ready).toBe(1);
  }));
});
