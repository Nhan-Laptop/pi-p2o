import { describe, expect, it } from 'vitest';
import { indexRecords, isOpenGap, retiredIds, summarizeRecords, type AssessmentRecord } from '../../src/records.js';
import { reportProjection } from '../../src/report.js';
import { finishPreflight } from '../../src/finish-preflight.js';
import { awaitingReview } from '../../src/tasks.js';
import { needsCaseReview } from '../../src/cases.js';
import { planFrontier, validatePlanDraft } from '../../src/planning.js';
import { normalizeReport } from '../../src/broker.js';
import { safeText } from '../../src/evidence.js';
import { sha256Hex, CONTROL, TEXT_CONTROL } from '../../src/validate.js';
import { choices } from '../../src/schema-kit.js';

const runId = 'run-shared';
const row = (id: string, patch: Partial<AssessmentRecord> = {}): AssessmentRecord => ({ version: 2, id, runId, at: '2030', by: 'owner', kind: 'note', text: id, ...patch } as AssessmentRecord);
const claim = (id: string, patch: Partial<AssessmentRecord>, data: Record<string, unknown>): AssessmentRecord =>
  row(id, { by: 'worker-a', workerId: 'worker-a', kind: 'candidate', surface: '/a', risk: 'authorization', ...patch, data: { candidate: 'shared-claim', ...data } });

describe('one definition of an open gap and of a pending review', () => {
  // g1 open; g2 open but resolved; g3/g4 candidates left as an open proof gap / blocked; g5 a gap candidate replaced by a confirmed revision.
  const rows = [
    row('g1', { kind: 'open', text: 'unresolved question' }),
    row('g2', { kind: 'open', text: 'question answered later' }),
    row('closer', { by: 'worker-a', workerId: 'worker-a', kind: 'candidate', surface: '/z', risk: 'authorization', resolves: ['g2'], data: { candidate: 'closer', closure: 'confirmed', execution: 'tested' } }),
    claim('g3', { surface: '/b' }, { candidate: 'gap-three', closure: 'open_proof_gap', execution: 'not_tested' }),
    claim('g4', { surface: '/c' }, { candidate: 'gap-four', closure: 'open_proof_gap', execution: 'blocked' }),
    claim('g5', { surface: '/d' }, { candidate: 'gap-five', closure: 'open_proof_gap', execution: 'not_tested' }),
    claim('g5b', { surface: '/d', supersedes: 'g5' }, { candidate: 'gap-five', closure: 'confirmed', execution: 'tested' }),
    row('n1', { text: 'plain note' }),
  ];
  const index = indexRecords(rows, runId);

  it('retires replaced and resolved rows and recognises gaps by kind and state', () => {
    expect(index.complete).toBe(true);
    const retired = retiredIds(index.records);
    expect([...retired].sort()).toEqual(['g2', 'g5']);
    expect(index.records.filter(record => isOpenGap(record, retired)).map(record => record.id)).toEqual(['g1', 'g3', 'g4']);
    expect(isOpenGap(row('legacy', { kind: 'open', id: undefined }), retired)).toBe(true);
  });
  it('is what the summary, the report projection and the finish preflight all count', () => {
    expect(summarizeRecords(index.records).open.map(record => record.id)).toEqual(['g1', 'g3', 'g4']);
    expect(reportProjection(index).openIds).toEqual(['g1', 'g3', 'g4']);
    const unreferenced = [...finishPreflight(index).obligations, ...finishPreflight(index).advisory].find(item => item.code === 'OPEN_GAP_UNREFERENCED');
    expect(unreferenced?.ids).toEqual(['g1', 'g3', 'g4']);
  });
  it('names the task and case states that wait for the owner', () => {
    expect(awaitingReview({ status: 'reported' })).toBe(true);
    expect(awaitingReview({ status: 'blocked', handoffId: 'handoff-1' })).toBe(true);
    for (const status of ['blocked', 'proposed', 'reserved', 'running', 'reviewed', 'closed', 'cancelled', 'expired']) expect(awaitingReview({ status }), status).toBe(false);
    for (const reviewStatus of ['pending', 'disputed']) expect(needsCaseReview({ reviewStatus }), reviewStatus).toBe(true);
    for (const reviewStatus of ['accepted', 'withdrawn']) expect(needsCaseReview({ reviewStatus }), reviewStatus).toBe(false);
  });
});

describe('owner notes become the head only along a valid revision chain', () => {
  const todo = { kind: 'todo', title: 'Review the retained boundary receipt', status: 'open', reason: 'The owner needs to review this one task' };
  const plan = (id: string, revision: number, status = 'open') => ({ ...todo, status, id, runId, revision });
  const note = (id: string, data: unknown, patch: Partial<AssessmentRecord> = {}) => row(id, { data: { plan: data } as never, ...patch });

  it('ignores forged, skipped, mis-linked and worker-written revisions and keeps accepting the real next one', () => {
    const rows = [
      note('p1', plan('todo-a', 1)),
      note('p2', plan('todo-a', 2, 'in-progress'), { supersedes: 'p1' }),
      note('forged-skip', plan('todo-a', 4, 'done'), { supersedes: 'p2' }),
      note('forged-link', plan('todo-a', 3, 'done'), { supersedes: 'p1' }),
      note('forged-worker', plan('todo-a', 3, 'done'), { supersedes: 'p2', by: 'worker-a', workerId: 'worker-a' }),
      note('forged-first', plan('todo-b', 2), {}),
    ];
    const before = planFrontier(indexRecords(rows, runId));
    expect(before.map(entry => [entry.id, entry.revision, entry.recordId, entry.status])).toEqual([['todo-a', 2, 'p2', 'in-progress']]);
    const after = planFrontier(indexRecords([...rows, note('p3', plan('todo-a', 3, 'done'), { supersedes: 'p2' })], runId));
    expect(after.map(entry => [entry.id, entry.revision, entry.recordId, entry.status])).toEqual([['todo-a', 3, 'p3', 'done']]);
  });
});

describe('free text and single-line text refuse the same characters', () => {
  const bidi = '‮', c1 = '\u0085', isolate = '⁦';
  it('keeps a tab or line feed in prose but never in an identifier', () => {
    expect(TEXT_CONTROL.test('first line\nsecond\tcolumn')).toBe(false);
    expect(CONTROL.test('first line\nsecond')).toBe(true);
    for (const bad of [bidi, c1, isolate, '\u0000', '\u001b', '\u007f', 'a\rb']) expect(TEXT_CONTROL.test(bad), JSON.stringify(bad)).toBe(true);
    for (const bad of [bidi, c1, isolate, '\u0000', '\u007f', '\n']) expect(CONTROL.test(bad), JSON.stringify(bad)).toBe(true);
  });
  it('rejects bidirectional overrides and C1 controls in plan text, accepts a plain line break', () => {
    const base = { kind: 'todo' as const, title: 'Review the retained boundary receipt', status: 'open', reason: 'First line\nsecond line is fine' };
    expect(() => validatePlanDraft(base)).not.toThrow();
    expect(() => validatePlanDraft({ ...base, title: `Review the receipt ${bidi}txt.exe` })).toThrow('Invalid plan title');
    expect(() => validatePlanDraft({ ...base, reason: `A reason${c1} with a next-line control` })).toThrow('Invalid plan reason');
  });
  it('removes them from worker report text instead of storing what could disguise it', () => {
    const report = normalizeReport({ summary: `Looks fine${bidi}exe.txt`, findings: [`a${c1}b`], openItems: ['plain'], confidence: 'high' });
    expect(report.summary).toBe('Looks fineexe.txt');
    expect(report.findings).toEqual(['ab']);
  });
});

describe('small shared helpers', () => {
  it('hashes like sha256 and redacts then strips control characters in one step', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const shown = safeText('password=hunter2 \u001b[31mred\u0007 done');
    expect(shown).not.toContain('hunter2');
    expect(shown).not.toMatch(/[\u001b\u0007]/);
  });
  it('declares an enum as one string schema instead of an anyOf of constants', () => {
    expect(choices(['a', 'b'] as const)).toMatchObject({ type: 'string', enum: ['a', 'b'] });
    expect(choices(['a', 'b'] as const)).not.toHaveProperty('anyOf');
  });
});
