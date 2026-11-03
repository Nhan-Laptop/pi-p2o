import { describe, expect, it } from 'vitest';
import { boundaryRef, CHAIN_BOUNDARY_MAX_PER_CLAIM, chainBoundaryIndex, mergeBoundaries } from '../../src/chain-boundary.js';
import type { AssessmentRecord } from '../../src/records.js';

/**
 * W-AB Option B (F15/H16): a chain step's foothold/pivot boundary is derived from records that already exist — the session
 * lifecycle facts, the receipts that name the session whose executor produced their bytes, and the claim's own citations —
 * never from a model field. Pure: hand-built ledger rows only.
 */
const row = (patch: Partial<AssessmentRecord> & { id: string; kind: AssessmentRecord['kind'] }): AssessmentRecord => ({
  runId: 'run-boundary', at: '2026-11-02T00:00:00.000Z', by: 'owner', text: 'fixture ledger row', ...patch,
});
const lifecycle = (id: string, data: Record<string, unknown>): AssessmentRecord => row({ id, kind: 'lifecycle', data: { session: data } });
const evidence = (id: string, sessionRef?: string, by = 'worker-a'): AssessmentRecord =>
  row({ id, kind: 'evidence', by, ...(sessionRef ? { data: { sessionRef } } : {}) });
const candidate = (id: string, slug: string, evidenceRefs: string[], negativeControls: string[] = []): AssessmentRecord =>
  row({ id, kind: 'candidate', by: 'worker-a', refs: evidenceRefs, data: { candidate: slug, evidenceRefs, ...(negativeControls.length ? { negativeControls } : {}) } });

describe('W-AB/B chain boundary derivation', () => {
  it('links a claim to the foothold its cited receipt ran under, with the identity observation as the account', () => {
    const records = [
      lifecycle('life-1', { id: 'session-a', event: 'foothold-open', port: 4444, address: 'p2o-target-lab' }),
      lifecycle('life-2', { id: 'session-a', event: 'foothold-identity', port: 4444, address: 'p2o-target-lab', user: 'www-data', uid: 33 }),
      evidence('ev-1', 'session-a'),
      candidate('cand-1', 'claim-foothold', ['ev-1']),
    ];
    const index = chainBoundaryIndex(records);
    const expected = [{ kind: 'foothold', session: 'session-a', port: 4444, address: 'p2o-target-lab', user: 'www-data', uid: 33 }];
    expect(index.bySession.get('session-a')).toEqual(expected);
    // The claim resolves by slug and by every ledger record id it was recorded under, because plan rows cite either.
    expect(index.byClaim.get('claim-foothold')).toEqual(expected);
    expect(index.byClaim.get('cand-1')).toEqual(expected);
    expect(boundaryRef(index.byClaim.get('claim-foothold')![0]!)).toBe('foothold session-a:4444 (www-data)');
  });

  it('reads a foothold-send receipt through the lifecycle fact that recorded it, which names no sessionRef', () => {
    const records = [
      lifecycle('life-1', { id: 'session-a', event: 'foothold-open', port: 4444 }),
      lifecycle('life-2', { id: 'session-a', event: 'foothold-send', port: 4444, bytes: 12, evidenceId: 'ev-2' }),
      evidence('ev-2'), // the send ran through the foothold, not the session executor, so the receipt names no session
      candidate('cand-1', 'claim-send', ['ev-2']),
    ];
    expect(chainBoundaryIndex(records).byClaim.get('claim-send')).toEqual([{ kind: 'foothold', session: 'session-a', port: 4444 }]);
  });

  it('records a pivot from its tunnel-open fact and ignores malformed facts, unknown sessions and uncited claims', () => {
    const records = [
      lifecycle('life-1', { id: 'session-b', event: 'tunnel-open', port: 1080, socks: 1080, relayPort: 5555, address: 'p2o-relay' }),
      evidence('ev-1', 'session-b'),
      candidate('cand-1', 'claim-pivot', ['ev-1']),
      lifecycle('life-bad-1', { id: 'x'.repeat(200), event: 'foothold-open', port: 4444 }),
      lifecycle('life-bad-2', { id: 'session-c', event: 'foothold-open', port: 99999 }),
      lifecycle('life-bad-3', { id: 42, event: 'foothold-open', port: 4444 }),
      evidence('ev-orphan', 'session-unknown'),
      candidate('cand-2', 'claim-orphan', ['ev-orphan']),
      candidate('cand-3', 'claim-uncited', ['ev-missing']),
    ];
    const index = chainBoundaryIndex(records);
    expect(index.byClaim.get('claim-pivot')).toEqual([{ kind: 'pivot', session: 'session-b', port: 1080, address: 'p2o-relay' }]);
    expect(index.byClaim.has('claim-orphan')).toBe(false);
    expect(index.byClaim.has('claim-uncited')).toBe(false);
    expect(index.bySession.has('session-c')).toBe(false);
    expect(index.bySession.size).toBe(1);
  });

  it('dedupes a repeated transition and caps the boundaries a claim carries', () => {
    const records: AssessmentRecord[] = [];
    const refs: string[] = [];
    for (let position = 0; position < 10; position += 1) {
      const session = `session-${String(position).padStart(2, '0')}`;
      records.push(lifecycle(`life-${position}`, { id: session, event: 'foothold-open', port: 4000 + position }));
      records.push(lifecycle(`life-again-${position}`, { id: session, event: 'foothold-open', port: 4000 + position }));
      records.push(evidence(`ev-${position}`, session));
      refs.push(`ev-${position}`);
    }
    records.push(candidate('cand-many', 'claim-many', refs));
    const index = chainBoundaryIndex(records);
    expect(index.bySession.get('session-00')).toEqual([{ kind: 'foothold', session: 'session-00', port: 4000 }]);
    expect(index.byClaim.get('claim-many')).toHaveLength(CHAIN_BOUNDARY_MAX_PER_CLAIM);
    expect(mergeBoundaries([{ kind: 'foothold', session: 'a', port: 1 }, { kind: 'foothold', session: 'a', port: 1 }])).toHaveLength(1);
  });

  it('counts a negative control receipt the same way as primary evidence', () => {
    const records = [
      lifecycle('life-1', { id: 'session-a', event: 'foothold-open', port: 4444 }),
      evidence('ev-control', 'session-a'),
      candidate('cand-1', 'claim-negative', [], ['ev-control']),
    ];
    expect(chainBoundaryIndex(records).byClaim.get('claim-negative')?.[0]).toMatchObject({ kind: 'foothold', session: 'session-a' });
  });
});
