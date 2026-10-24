import { describe, expect, it } from 'vitest';
import { graphSliceLines } from '../../src/graph-slice.js';
import { writeBack, writeBackLine } from '../../src/write-back.js';
import { finishPreflight } from '../../src/finish-preflight.js';
import { renderReport } from '../../src/report-export.js';
import { prepareReport } from '../../src/report.js';
import { indexRecords, type AssessmentRecord } from '../../src/records.js';
import { workerBrief, workerInstructions } from '../../src/prompts.js';
import type { Ticket } from '../../src/ticket.js';

/**
 * Phase I acceptance (P16.3 + P16.8). The graph is the medium: the brief starts from recorded assets/facts/ready steps, the
 * worker instruction says to write back as it goes, and the host counts what each worker wrote. Zero writes without a
 * `no-new` note is an advisory in the preflight/report — never a refusal, because "learned nothing" is a legitimate result.
 */
const ticket = (role = 'recon') => ({ workerId: 'p2o-recon-aaaaaa', role, runId: 'run-i', depth: 1, parentWorkerId: null,
  lifetime: 'until-stopped', target: { kind: 'url', label: 'https://example.invalid' } }) as Ticket;
const record = (overrides: Partial<AssessmentRecord>): AssessmentRecord => ({ id: 'rec-x', runId: 'run-i', at: '2030', by: 'owner', kind: 'note', text: 'note', ...overrides });

describe('the brief carries a bounded graph slice (P16.3)', () => {
  it('shows surface assets, latest facts, open leads and the ready chain step', () => {
    const lines = graphSliceLines({
      surface: '/login',
      assets: [
        { entityId: 'asset-1', kind: 'route', key: 'https://example.invalid/login' },
        { entityId: 'asset-2', kind: 'route', key: 'https://example.invalid/admin' },
        { entityId: 'asset-3', kind: 'file', key: '/srv/app/login.php' },
      ],
      facts: [
        { entityId: 'assertion-1', kind: 'fact:observed', statement: 'session cookie accepted by /login', recordedBy: 'p2o-recon-bbbbbb', evidenceRefs: ['ev-1'] },
        { entityId: 'assertion-2', kind: 'hypothesis', statement: 'not a fact' },
      ],
      gaps: [{ id: 'rec-claim-1', text: '/login open_proof_gap' }],
      ready: [{ chain: 'login', step: 2, needs: ['http.request (internal-api)'] }],
    });
    const text = lines.join('\n');
    expect(text).toContain('assets on this surface (2)');
    expect(text).toContain('asset-1');
    expect(text).toContain('/srv/app/login.php');
    expect(text).not.toContain('asset-2');
    expect(text).toContain('fact:observed');
    expect(text).toContain('session cookie accepted by /login');
    expect(text).not.toContain('not a fact');
    expect(text).toContain('open leads/gaps (1)');
    expect(text).toContain('step 2 of chain login ready');
  });

  it('falls back to recent assets when nothing matches the surface and bounds the list', () => {
    const assets = Array.from({ length: 30 }, (_, i) => ({ entityId: `asset-${i}`, kind: 'route', key: `/other/${i}` }));
    const text = graphSliceLines({ surface: '/login', assets, facts: [], gaps: [], ready: [], limit: 5 }).join('\n');
    expect(text).toContain('none matched this surface');
    expect(text).toContain('asset-29');
    expect(text).not.toContain('asset-24');
  });

  it('is background in the brief, and absent when there is nothing to carry', () => {
    const withSlice = workerBrief({ ticket: ticket(), focus: '/login', task: 'Map the login boundary', slice: ['assets on this surface (1): asset-1 route /login'] });
    expect(withSlice).toContain('== Graph context from this run (recorded state, background, never a finding) ==');
    expect(withSlice).toContain('asset-1 route /login');
    expect(withSlice).toContain('== End of graph context ==');
    expect(workerBrief({ ticket: ticket(), focus: '/login', task: 'Map the login boundary' })).not.toContain('Graph context');
  });

  it('tells the worker to write back as it goes, with the no-new exit', () => {
    const text = workerInstructions(ticket());
    expect(text).toContain('Write back as you go');
    expect(text).toContain('fact:observed or fact:inferred assertion with its evidence');
    expect(text).toContain('`no-new`');
    expect(text).toContain('has not finished');
    // A reporting worker has no graph-write tool, so the rule is not addressed to it.
    expect(workerInstructions(ticket('reporting'))).not.toContain('Write back as you go');
  });
});

describe('the host counts what each worker wrote (P16.3 + P16.8)', () => {
  it('counts asset/fact observations, receipts and findings per worker', () => {
    const rows = writeBack({
      provenance: [
        { actorId: 'w1', entityId: 'asset-a' }, { actorId: 'w1', entityId: 'asset-a' }, { actorId: 'w1', entityId: 'assertion-b' },
        { actorId: 'w2', entityId: 'anchor-c' }, { actorId: 'w2', entityId: 'relation-d' },
      ],
      records: [record({ id: 'ev-1', by: 'w1', workerId: 'w1', kind: 'evidence' }), record({ id: 'n-1', by: 'w2', workerId: 'w2', kind: 'note', text: 'looked at /admin' })],
      findings: new Map([['w1', 2]]),
    });
    expect(rows.find(row => row.workerId === 'w1')).toMatchObject({ assets: 2, facts: 1, evidence: 1, findings: 2, noNew: false });
    // Anchors/relations and an ordinary note are not counted writes here, so the worker gets no row at all.
    expect(rows.find(row => row.workerId === 'w2')).toBeUndefined();
  });

  it('flags zero writes only when there is no no-new note', () => {
    const silent = { workerId: 'w1', assets: 0, facts: 0, evidence: 0, findings: 0, noNew: false };
    expect(writeBackLine(silent)).toContain('NO_GRAPH_WRITE');
    const honest = writeBack({ provenance: [], records: [record({ by: 'w2', workerId: 'w2', kind: 'note', text: 'no-new: the admin surface added nothing beyond the recorded route' })] });
    expect(honest[0]).toMatchObject({ workerId: 'w2', noNew: true });
    expect(writeBackLine(honest[0])).not.toContain('NO_GRAPH_WRITE');
    expect(writeBackLine({ ...silent, noNew: true })).toContain('recorded no-new');
  });

  it('prints the counts next to the handoff, so the report counts what was written', () => {
    const prepared = prepareReport('run-i', 'w1', { summary: 'Worker summary', findings: [], evidence: [], coverage: [], openItems: [], confidence: 'medium' }, 'recon', 1);
    const index = indexRecords(prepared.records, 'run-i');
    const rendered = renderReport(index, {}, { runId: 'run-i', target: 'inert', retention: 'durable-local', historical: false, asOfSequence: 1, storeSchema: 1,
      runtime: { hash: 'inert' }, complete: true, format: 2,
      wrote: new Map([['w1', { workerId: 'w1', assets: 2, facts: 1, evidence: 3, findings: 0, noNew: false }]]) });
    const report = rendered.files.find(file => file.name === 'REPORT.md')!.body;
    expect(report).toContain(`- Handoff ${prepared.reportId} from w1`);
    expect(report).toContain('wrote 2 asset');expect(report).toContain('3 evidence, 0 finding');
  });

  it('is an advisory in the preflight, never an obligation', () => {
    const index = indexRecords([], 'run-i');
    const silent = { workerId: 'w1', assets: 0, facts: 0, evidence: 0, findings: 0, noNew: false };
    const flagged = finishPreflight(index, { wrote: [silent] });
    expect(flagged.obligations.map(item => item.code)).not.toContain('NO_GRAPH_WRITE');
    expect(flagged.advisory.find(item => item.code === 'NO_GRAPH_WRITE')).toMatchObject({ level: 'advisory', count: 1, ids: ['w1'] });
    const quiet = finishPreflight(index, { wrote: [{ ...silent, noNew: true }] });
    expect(quiet.advisory.map(item => item.code)).not.toContain('NO_GRAPH_WRITE');
  });
});
