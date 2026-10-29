import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { graphReadParameters, graphRecordParameters, normalizeGraphRecord } from '../../src/state/graph-tool.js';
import { validateGraphBatch } from '../../src/state/graph.js';

const receipt = '11111111-1111-1111-1111-111111111111';
const asset = { kind: 'file' as const, key: 'src/gate.py' };
/** Shapes observed in real worker sessions (Oct 28): they must pass Pi's argument validator and reach the host fold. */
const drifted = {
  requestId: 'record-1',
  batch: {
    requestId: 'record-1',
    assets: [
      { asset, evidenceRefs: [receipt], expectedRevision: 2 },
      { kind: 'endpoint', key: 'GET /admin', label: 'admin gate' },
    ],
    facts: [{ assetId: '@gate', kind: 'inferred', statement: 'the gate runs server-side', confidence: 'low', supersedes: '' }],
  },
};

describe('p2o_graph_record argument tolerance (A1)', () => {
  it('accepts the drifted placements at the Pi schema boundary while keeping the root object closed', () => {
    expect(Value.Check(graphRecordParameters, drifted)).toBe(true);
    // Tolerating placement drift is not tolerating wrong types: the batch still has to be the canonical object.
    expect(Value.Check(graphRecordParameters, { batch: { assets: { asset } } })).toBe(false);
    expect(Value.Check(graphRecordParameters, { batch: { facts: [{ kind: 'observed', statement: 'x' }] } })).toBe(false);
    expect(Value.Check(graphRecordParameters, { ...drifted, bogus: 'file' })).toBe(false);
    // S1/C1: the write verb carries no action field and no read filter, so a read argument cannot ride in unnoticed; the
    // read verb is closed too and has no batch, which is what keeps the 3,982-char batch out of the planner loadout.
    expect(Value.Check(graphRecordParameters, { ...drifted, action: 'record' })).toBe(false);
    expect(Value.Check(graphRecordParameters, { ...drifted, kind: 'file' })).toBe(false);
    expect((graphReadParameters as unknown as { properties: Record<string, unknown> }).properties).not.toHaveProperty('batch');
    // R0: the documented ten-reference cap is enforced at the Pi boundary too.
    const refs = (length: number) => Array.from({ length }, () => receipt);
    expect(Value.Check(graphRecordParameters, { batch: { facts: [{ assetId: '@a', kind: 'inferred', statement: 'x', confidence: 'low', evidenceRefs: refs(10) }] } })).toBe(true);
    expect(Value.Check(graphRecordParameters, { batch: { facts: [{ assetId: '@a', kind: 'inferred', statement: 'x', confidence: 'low', evidenceRefs: refs(11) }] } })).toBe(false);
  });

  it('folds requestId, row-level asset fields and flat rows into one canonical batch the host accepts', () => {
    const normalized = normalizeGraphRecord(drifted.batch, drifted.requestId);
    expect(normalized.requestId).toBe('record-1');
    expect(normalized.batch).not.toHaveProperty('requestId');
    expect(normalized.batch.assets?.[0].asset).toMatchObject({ ...asset, evidenceRefs: [receipt], expectedRevision: 2 });
    expect(normalized.batch.assets?.[1]).toMatchObject({ asset: { kind: 'endpoint', key: 'GET /admin', label: 'admin gate' } });
    expect(normalized.batch.facts?.[0]).not.toHaveProperty('supersedes');
    expect(() => validateGraphBatch(normalized.batch)).not.toThrow();
  });

  it('hoists a batch-level requestId when the envelope omits it, and refuses two different keys', () => {
    expect(normalizeGraphRecord({ assets: [{ asset }], requestId: 'only-in-batch' }, undefined).requestId).toBe('only-in-batch');
    expect(normalizeGraphRecord({ assets: [{ asset }] }, undefined)).not.toHaveProperty('requestId');
    expect(() => normalizeGraphRecord({ assets: [{ asset }], requestId: 'inside' }, 'outside')).toThrow(/two different requestId/);
    expect(() => normalizeGraphRecord({ assets: [{ asset }], requestId: 'has space' }, undefined)).toThrow(/requestId inside batch/);
  });

  it('merges row and nested evidence while refusing contradictory values with a message that names the fix', () => {
    const merged = normalizeGraphRecord({ assets: [{ asset: { ...asset, evidenceRefs: [receipt] }, evidenceRefs: ['22222222-2222-2222-2222-222222222222', receipt] }] }, undefined);
    expect(merged.batch.assets?.[0].asset.evidenceRefs).toEqual([receipt, '22222222-2222-2222-2222-222222222222']);
    expect(() => normalizeGraphRecord({ assets: [{ asset: { ...asset, expectedRevision: 1 }, expectedRevision: 2 }] } as never, undefined))
      .toThrow(/sets expectedRevision both inside asset and on the row with different values/);
  });

  it('refuses unknown or malformed rows with the accepted shape instead of losing the call to the argument validator', () => {
    expect(() => normalizeGraphRecord('assets: []', undefined)).toThrow(/record needs batch as an object holding assets\/facts\/hypotheses\/relations\/anchors/);
    expect(() => normalizeGraphRecord({ assets: [{ asset }], kind: 'file' } as never, undefined)).toThrow(/Graph batch has unknown field\(s\): kind; batch holds only assets, facts, hypotheses, relations, anchors/);
    expect(() => normalizeGraphRecord({ assets: [{ asset, in_scope: true }] } as never, undefined))
      .toThrow(/assets\[0\] has unknown field\(s\): in_scope; a row holds \{asset, ref\} and may carry asset fields \(kind, key, label, attributes, anchors, evidenceRefs, expectedRevision\) directly/);
    expect(() => normalizeGraphRecord({ assets: [{ asset: 'file: src/gate.py' }] } as never, undefined)).toThrow(/assets\[0\]\.asset must be an object with kind and key/);
    expect(() => normalizeGraphRecord({ assets: [{ ref: 'gate' }] } as never, undefined)).toThrow(/assets\[0\] has no asset object and no flat kind\/key/);
    // An unknown asset field still passes placement tolerance and is refused by the host's semantic validator.
    const unknown = normalizeGraphRecord({ assets: [{ asset: { ...asset, authority: 'owner' } }] } as never, undefined);
    expect(() => validateGraphBatch(unknown.batch)).toThrow(/Asset input has unknown field\(s\): authority .* host-owned/);
  });
});
