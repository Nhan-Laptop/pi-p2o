import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { appendRecord } from '../../src/records.js';
import { EvidenceStore } from '../../src/evidence.js';
import { candidateParameters, noteParameters, reportParameters } from '../../src/tool-schemas.js';
import { normalizeReport } from '../../src/broker.js';
import { graphEntityId } from '../../src/state/graph.js';

/**
 * A1 whole-surface audit (owner decision 2026-10-28): after the prose-cap pass, the remaining Pi-refusal classes in the session
 * corpus were fields whose omission has exactly one conservative reading (no negative control, nothing closed, default note
 * kind, default low confidence). The host records that default; a contradicting value is still refused by the schema. This
 * keeps the whole call — and the payload echo — out of Pi's argument validator without changing what a stored record means.
 */
describe('tool argument defaults (A1 audit)', () => {
  it('admits a candidate with no negative control and no claimed closure, and still refuses contradicting values', () => {
    const claim = { candidate: 'no-control-claim', surface: '/admin', risk: 'policy', evidenceRefs: [], execution: 'not_tested',
      proof: 'static_trace', policyBasis: 'inferred', expectedPolicy: 'declared route boundary', limitations: 'nothing executed' };
    expect(Value.Check(candidateParameters, claim)).toBe(true);
    expect(Value.Check(candidateParameters, { ...claim, closure: 'closed-ish' })).toBe(false);
    expect(Value.Check(candidateParameters, { ...claim, negativeControls: 'none' })).toBe(false);
  });

  it('records the conservative candidate defaults on the record instead of refusing the call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-defaults-')), path = join(root, 'records.jsonl');
    await appendRecord(path, { id: randomUUID(), runId: 'run-defaults', by: 'owner', at: '2030', kind: 'lifecycle', text: 'test start' });
    try {
      const store = new EvidenceStore('run-defaults', path, 'fixture');
      const record = await store.candidate('worker-a', { candidate: 'default-claim', surface: '/admin', risk: 'policy', evidenceRefs: [],
        execution: 'not_tested', proof: 'static_trace', policyBasis: 'inferred', expectedPolicy: 'declared route boundary', limitations: 'nothing executed' } as never);
      expect(record.outcome).toBe('open_proof_gap');
      expect(record.data).toMatchObject({ closure: 'open_proof_gap', negativeControls: [] });
      expect(record.data?.admissionWarnings).toBeUndefined();
      const long = await store.candidate('worker-a', { candidate: 'default-claim-long', surface: '/admin', risk: 'policy', evidenceRefs: [],
        execution: 'not_tested', proof: 'static_trace', policyBasis: 'inferred', expectedPolicy: 'p'.repeat(1500), limitations: 'nothing executed' } as never);
      expect(long.data?.expectedPolicy).toHaveLength(1000);
      expect(long.data?.admissionWarnings).toEqual(['truncated:expectedPolicy (stored 1000 of 1500 characters)']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('admits a report with no confidence, notes the low default and refuses an invented level', () => {
    expect(Value.Check(reportParameters, { summary: 'bounded synthesis, no findings' })).toBe(true);
    expect(normalizeReport({ summary: 'bounded synthesis, no findings' }).confidence).toBe('low');
    expect(Value.Check(reportParameters, { summary: 'x', confidence: 'certain' })).toBe(false);
  });

  it('admits a note with no kind and refuses an unknown kind', () => {
    expect(Value.Check(noteParameters, { text: 'one bounded observation' })).toBe(true);
    expect(Value.Check(noteParameters, { kind: 'guess', text: 'one bounded observation' })).toBe(false);
  });

  it('names the accepted identity shape when a graph page/view id is malformed', () => {
    expect(() => graphEntityId('admin', 'asset')).toThrow(/asset-<24 hex>.*entityId from a page/);
  });
});
