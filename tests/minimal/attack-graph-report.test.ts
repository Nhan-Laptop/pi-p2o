import { describe, expect, it } from 'vitest';
import { renderReport } from '../../src/report-export.js';
import { indexRecords } from '../../src/records.js';
import { EXPLORATION_NODE_KINDS, EXPLORATION_RELATIONS, EXPLORATION_REPORT_LABEL, REPORT_CASE_ROWS, REPORT_DIGEST_ROWS,
  type ExplorationOverview, type ExplorationReportChain, type ExplorationReportFacts } from '../../src/exploration-graph.js';

/**
 * planning_update.md P24/D §3.5/§3.6: the report carries one bounded graph section — round digest timeline, recorded ancestry
 * of accepted current cases, and the inherited-graph line. It is absent when the caller passes no graph facts, so a run that
 * recorded no digest (and every older report fixture) keeps its bytes, and it is labeled a derived projection throughout.
 */
const meta = { runId: 'run-graph-report', target: 'inert fixture', retention: 'durable-local', historical: false, asOfSequence: 1,
  storeSchema: 8, runtime: { hash: 'inert' }, complete: true, format: 2 } as const;
const counts = (): ExplorationOverview['counts'] => ({
  nodes: 12, edges: 9, anchors: 2,
  byKind: Object.fromEntries(EXPLORATION_NODE_KINDS.map(kind => [kind, 0])) as Record<(typeof EXPLORATION_NODE_KINDS)[number], number>,
  byRelation: Object.fromEntries(EXPLORATION_RELATIONS.map(rel => [rel, 0])) as Record<(typeof EXPLORATION_RELATIONS)[number], number>,
});
const digest = (round: number, patch: Partial<ExplorationReportFacts['digests'][number]> = {}): ExplorationReportFacts['digests'][number] =>
  ({ id: `digest-${round}`, round, state: 'active', rows: 4, nodes: 7, edges: 3, facts: 2, findings: 1, links: 1,
    text: `round ${round}: 7 node(s) (1 goal, 1 link, 1 intent, 2 fact, 1 finding), 3 edge(s), 0 anchor(s) recorded in sequence 0..4`, superseded: false, ...patch });
const facts = (patch: Partial<ExplorationReportFacts> = {}): ExplorationReportFacts => ({
  label: EXPLORATION_REPORT_LABEL, counts: counts(),
  digests: [digest(1)], digestsOmitted: 0,
  cases: [{ caseId: 'case-a', revision: 2, nodeId: 'finding-0123456789abcdef01234567',
    chain: 'origin#run-graph-report → intent#task-top → fact#claim-one → finding#case-a' }], casesOmitted: 0,
  inherited: { nodes: 0, edges: 0, runs: [], reason: 'no --refer-workspace selection' },
  ...patch,
});
const report = (graph?: ExplorationReportFacts): string =>
  renderReport(indexRecords([], meta.runId), { ...(graph ? { graph } : {}) }, meta).files.find(file => file.name === 'REPORT.md')!.body;
const section = (graph: ExplorationReportFacts): string => {
  const body = report(graph), at = body.indexOf('## Attack graph — recorded ancestry, bounded');
  return at < 0 ? '' : body.slice(at, body.indexOf('## Coverage and gaps', at) < 0 ? undefined : body.indexOf('## Coverage and gaps', at));
};

describe('report graph section (P24/D)', () => {
  it('renders nothing when the caller supplies no graph facts, so an old report keeps its bytes', () => {
    expect(report()).not.toContain('Attack graph');
    expect(report(facts())).toContain('## Attack graph — recorded ancestry, bounded');
  });

  it('prints the counts, the digest timeline and the projection label before any row', () => {
    const text = section(facts());
    expect(text).toContain('derived projection, not evidence; only the recorded receipt/rating is evidence');
    expect(text).toContain('Graph: **12** node(s), **9** edge(s), **2** anchor(s)');
    expect(text).toContain('## Attack graph — recorded ancestry, bounded');
    expect(text).toContain('| Round | Ledger rows | Nodes | Edges | Facts | Findings | Links | State | Host sentence |');
    expect(text).toContain('| 1 | 4 | 7 | 3 | 2 | 1 | 1 | active |');
    expect(text).toContain('recorded in sequence 0..4');
    expect(text).toContain('A node projects a committed record; it is not a finding, a rating, a proof or an executed step');
  });

  it('prints one recorded ancestry chain per accepted current case and says what it dropped', () => {
    const text = section(facts({ cases: Array.from({ length: 22 }, (_, index) => ({ caseId: `case-${String(index).padStart(2, '0')}`, revision: 1,
      nodeId: 'finding-0123456789abcdef01234567', chain: 'origin#run-graph-report → intent#task-top → fact#claim-one → finding#case' })), casesOmitted: 0 }));
    expect(text).toContain('### Recorded ancestry per accepted current case');
    expect(text).toContain('Recorded ancestry (ancestor → descendant, depth ≤6)');
    expect(text).toContain('origin\\#run-graph-report');
    expect(text).toContain('finding\\#case');
    expect(text.split('\n').filter(line => line.startsWith('| case-'))).toHaveLength(REPORT_CASE_ROWS);
    expect(text).toContain('2 accepted current case(s) not shown (20 shown)');
    // A run with no accepted current case still says the section is empty rather than omitting it silently.
    expect(section(facts({ cases: [], casesOmitted: 0 }))).toContain('No accepted current case resolves a finding node');
  });

  it('bounds the digest timeline and counts the older rounds it did not print', () => {
    const digests = Array.from({ length: 25 }, (_, index) => digest(25 - index, { text: `round ${25 - index}: host sentence` }));
    const text = section(facts({ digests, digestsOmitted: 0 }));
    expect(text.split('\n').filter(line => /^\| \d+ \|/.test(line))).toHaveLength(REPORT_DIGEST_ROWS);
    expect(text).toContain('5 older digest(s) not shown (20 shown)');
    expect(text).toContain('| active |');
    expect(section(facts({ digests: [], digestsOmitted: 0 }))).toContain('No round digest is recorded');
  });

  it('states the inherited line as a count with the referenced runs, or as an explicit absence reason', () => {
    const inherited = section(facts({ inherited: { nodes: 14, edges: 6, runs: ['run-prior', 'run-older'] } }));
    expect(inherited).toContain('14 node(s) and 6 edge(s) copied from referenced run(s) `run-prior`, `run-older`');
    expect(inherited).toContain('read-only suggested context, never a fact and never evidence');
    expect(section(facts({ inherited: { nodes: 0, edges: 0, runs: [], reason: 'disabled for this run by --no-inherit or p2o.inheritGraph=false' } })))
      .toContain('Inherited graph: none (disabled for this run by --no-inherit or p2o.inheritGraph=false)');
  });

  it('marks a superseded digest as kept, not current', () => {
    const text = section(facts({ digests: [{ ...digest(1), state: 'superseded', superseded: true }] }));
    expect(text).toContain('| superseded |');
    expect(text).not.toContain('no vulnerabilities');
  });
});

/**
 * P25 §3.4 surface 5: the report prints the canonical chain read — plan chain, rating depth and recorded adjacency — with node
 * ids and the recorded/step-only marker. The subsection exists only when chains were supplied, so older reports keep their bytes.
 */
const chainRow = (patch: Partial<ExplorationReportChain> = {}): ExplorationReportChain => ({
  id: 'chain-export', sources: ['plan', 'case'], demonstratedThrough: 2, omittedSteps: 0,
  steps: [
    { order: 1, claimId: 'claim-one', state: 'done', executed: true, needs: [], gained: ['cred.session'], nodes: ['link-aaaaaaaaaaaaaaaaaaaaaaaa', 'fact-bbbbbbbbbbbbbbbbbbbbbbbb'], orderEdge: 'recorded' },
    { order: 2, state: 'ready', executed: true, claimId: 'claim-two', effect: 'confidentiality-read', needs: ['cred.session'], gained: ['data.read'],
      nodes: [], orderEdge: 'step-only' },
  ],
  ...patch,
});

describe('report chain-order subsection (P25 §3.4)', () => {
  it('renders nothing when no chains were supplied, so the P24 report bytes are unchanged', () => {
    const plain = facts();
    expect(report(plain)).toBe(report(plain));
    const withoutChains = report(plain);
    expect(withoutChains).not.toContain('### Recorded chain order');
    const withUndefined = report({ ...plain, chains: undefined });
    expect(withUndefined).toBe(withoutChains);
  });

  it('prints the canonical chain after the recorded ancestry, with sources, step state and the order marker', () => {
    const text = section(facts({ chains: [chainRow()] }));
    expect(text).toContain('### Recorded chain order');
    expect(text.indexOf('### Recorded chain order')).toBeGreaterThan(text.indexOf('### Recorded ancestry per accepted current case'));
    expect(text.indexOf('### Recorded chain order')).toBeLessThan(text.indexOf('### Inherited graph'));
    expect(text).toContain('**Chain `chain-export`** — plan+case; executed through step 2 (2 executed)');
    expect(text).toContain('1. `claim-one` [done, executed]; gained: cred.session; nodes `link-aaaaaaaaaaaaaaaaaaaaaaaa`, `fact-bbbbbbbbbbbbbbbbbbbbbbbb`; order recorded');
    expect(text).toContain('2. `claim-two` [ready, executed]; effect: confidentiality-read; needs: cred.session; gained: data.read; order step-only (no leads_to edge)');
    expect(text).toContain('A derived projection: it is not a rating, a proof or an execution claim');
    // A step without any node id prints no empty node clause, and an omitted step count is named.
    const bare = section(facts({ chains: [chainRow({ omittedSteps: 3, steps: [chainRow().steps[1]!] })] }));
    expect(bare).toContain('3 step(s) not shown');
    expect(bare).not.toContain('nodes ;');
  });

  it('names the F-lite inherited chain summaries beside the copied node count', () => {
    const text = section(facts({ inherited: { nodes: 3, edges: 1, runs: ['run-prior'], chains: 2 } }));
    expect(text).toContain('2 inherited finding body(ies) also carry the referenced run');
    expect(section(facts({ inherited: { nodes: 3, edges: 1, runs: ['run-prior'] } }))).not.toContain('executed-chain summary');
  });
});
