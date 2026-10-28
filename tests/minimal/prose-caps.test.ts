import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { appendRecord, readLedger } from '../../src/records.js';
import { EvidenceStore } from '../../src/evidence.js';
import { PROSE_CAPS, clampProseInPlace } from '../../src/validate.js';
import { candidateParameters, finishParameters, noteParameters, reportParameters, surfaceParameters } from '../../src/tool-schemas.js';
import { REPORT_PROSE_CAPS, normalizeReport, reportProseWarnings, type WorkerReport } from '../../src/broker.js';

/**
 * A1 (owner decision 2026-10-28): a cosmetic-prose field declares a bound well above the bound it is stored at, so verbosity
 * reaches the host and is clamped with a `truncated:` trace instead of Pi's argument validator refusing the call and echoing
 * the whole payload back. Identity-shaped fields keep their strict caps: truncating those would change what a record means.
 */
describe('prose caps (A1)', () => {
  const wellAbove = (declared: number, stored: number) => expect(declared, `declared ${declared} vs stored ${stored}`).toBeGreaterThanOrEqual(Math.max(4 * stored, 2000));

  it('declares every cosmetic prose field well above its stored cap', () => {
    for (const [field, stored] of Object.entries(PROSE_CAPS.candidate) as Array<[keyof typeof PROSE_CAPS['candidate'], number]>)
      wellAbove((candidateParameters.properties[field] as unknown as { maxLength: number }).maxLength, stored);
    for (const [field, stored] of Object.entries(PROSE_CAPS.note) as Array<[keyof typeof PROSE_CAPS['note'], number]>)
      wellAbove((noteParameters.properties[field] as unknown as { maxLength: number }).maxLength, stored);
    for (const [field, stored] of Object.entries(PROSE_CAPS.surface) as Array<[keyof typeof PROSE_CAPS['surface'], number]>)
      wellAbove((surfaceParameters.properties[field] as unknown as { maxLength: number }).maxLength, stored);
    for (const [field, stored] of Object.entries(PROSE_CAPS.finish) as Array<[keyof typeof PROSE_CAPS['finish'], number]>)
      wellAbove((finishParameters.properties[field] as unknown as { maxLength: number }).maxLength, stored);
    wellAbove((reportParameters.properties.summary as unknown as { maxLength: number }).maxLength, REPORT_PROSE_CAPS.summary);
    wellAbove(((reportParameters.properties.findings as any).items as { maxLength: number }).maxLength, REPORT_PROSE_CAPS.findings);
    wellAbove(((reportParameters.properties.openItems as any).items as { maxLength: number }).maxLength, REPORT_PROSE_CAPS.openItems);
    // Identity caps stay strict even though they are strings next to the cosmetic ones.
    expect((candidateParameters.properties.evidenceRefs as any).items.maxLength).toBe(80);
  });

  it('clamps only a length overflow and leaves empty, short, non-string and control text for the hard refusal', () => {
    const fields: Record<string, unknown> = { text: 'a'.repeat(2500), surface: 'kept', risk: '', refs: ['x'] };
    expect(clampProseInPlace(fields, PROSE_CAPS.note)).toEqual(['truncated:text (stored 2000 of 2500 characters)']);
    expect(fields).toMatchObject({ text: 'a'.repeat(2000), surface: 'kept', risk: '', refs: ['x'] });
    const control = { text: 'a\u0000'.repeat(3000) };
    expect(clampProseInPlace(control, PROSE_CAPS.note)).toEqual([]);
    expect(control.text).toHaveLength(6000);
  });

  it('lets Pi accept over-long cosmetic prose while identity overflows still fail the schema', () => {
    const candidate = { candidate: 'prose-claim', surface: 's'.repeat(1500), risk: 'r'.repeat(1500), limitations: 'l'.repeat(5000), control: 'c'.repeat(3000),
      note: 'n'.repeat(900), closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', policyBasis: 'inferred',
      expectedPolicy: 'declared boundary', evidenceRefs: [], negativeControls: [] };
    expect(Value.Check(candidateParameters, candidate)).toBe(true);
    expect(Value.Check(candidateParameters, { ...candidate, candidate: 'a'.repeat(90) })).toBe(false);
    expect(Value.Check(candidateParameters, { ...candidate, evidenceRefs: ['x'.repeat(90)] })).toBe(false);
    expect(Value.Check(noteParameters, { kind: 'note', text: 't'.repeat(7000), surface: 's'.repeat(1500), risk: 'r'.repeat(1500) })).toBe(true);
    expect(Value.Check(surfaceParameters, { component: 'c'.repeat(1500), entryPoint: 'e'.repeat(1500), text: 't'.repeat(3500) })).toBe(true);
    expect(Value.Check(reportParameters, { summary: 's'.repeat(15000), findings: ['f'.repeat(3500)], evidence: ['e'.repeat(1500)],
      coverage: [{ surface: 's'.repeat(1500), risk: 'r'.repeat(1500), outcome: 'clean' }], openItems: ['o'.repeat(3500)], confidence: 'low', blocked: 'b'.repeat(3500) })).toBe(true);
    expect(Value.Check(finishParameters, { partial: 'p'.repeat(2000) })).toBe(true);
  });

  it('stores a candidate at the cosmetic caps and carries the truncation trace on the record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-prose-')), path = join(root, 'records.jsonl');
    await appendRecord(path, { id: randomUUID(), runId: 'run-prose', by: 'owner', at: '2030', kind: 'lifecycle', text: 'test start' });
    try {
      const store = new EvidenceStore('run-prose', path, 'fixture');
      const record = await store.candidate('worker-a', { candidate: 'prose-claim', surface: 's'.repeat(900), risk: 'r'.repeat(900),
        limitations: 'l'.repeat(4000), control: 'c'.repeat(2500), note: 'n'.repeat(800), closure: 'open_proof_gap', execution: 'not_tested',
        proof: 'static_trace', policyBasis: 'inferred', expectedPolicy: 'p'.repeat(1500), evidenceRefs: [], negativeControls: [] });
      const data = record.data as Record<string, unknown>;
      expect(data).toMatchObject({ surface: 's'.repeat(200), risk: 'r'.repeat(200), limitations: 'l'.repeat(1500), control: 'c'.repeat(1000), note: 'n'.repeat(300), expectedPolicy: 'p'.repeat(1000) });
      expect(data.admissionWarnings).toEqual(['truncated:surface (stored 200 of 900 characters)', 'truncated:risk (stored 200 of 900 characters)',
        'truncated:limitations (stored 1500 of 4000 characters)', 'truncated:control (stored 1000 of 2500 characters)', 'truncated:note (stored 300 of 800 characters)',
        'truncated:expectedPolicy (stored 1000 of 1500 characters)']);
      const retained = (await readLedger(path, 'run-prose')).byId.get(record.id!)!.data as Record<string, unknown>;
      expect(retained).toMatchObject({ surface: 's'.repeat(200), admissionWarnings: data.admissionWarnings });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('names every report field the broker will store truncated, then stores the bounded report', () => {
    const raw = { summary: 's'.repeat(5000), findings: ['f'.repeat(1500), 'short'], evidence: ['e'.repeat(700)],
      coverage: [{ surface: 'c'.repeat(300), risk: 'r'.repeat(300), outcome: 'clean' }], openItems: [], blocked: 'b'.repeat(1200), confidence: 'low' } as unknown as WorkerReport;
    expect(reportProseWarnings(raw)).toEqual(['truncated:summary (stored 4000 of 5000 characters)', 'truncated:findings[0] (stored 1000 of 1500 characters)',
      'truncated:evidence[0] (stored 500 of 700 characters)', 'truncated:coverage[0].surface (stored 200 of 300 characters)',
      'truncated:coverage[0].risk (stored 200 of 300 characters)', 'truncated:blocked (stored 1000 of 1200 characters)']);
    const normalized = normalizeReport(raw);
    expect(normalized.summary).toHaveLength(4000);
    expect(normalized.findings).toEqual(['f'.repeat(1000), 'short']);
    expect(normalized.evidence).toEqual(['e'.repeat(500)]);
    expect(normalized.coverage[0]).toMatchObject({ surface: 'c'.repeat(200), risk: 'r'.repeat(200) });
    expect(normalized.blocked).toHaveLength(1000);
    expect(reportProseWarnings(normalized)).toEqual([]);
  });
});
