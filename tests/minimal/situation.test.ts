import { describe, expect, it } from 'vitest';
import { SEGMENT_FIELDS, SITUATION_LIMIT, situationLine, situationSegments, summarizeSituation, type SituationSnapshot } from '../../src/situation.js';

// planning_update.md P3: one bounded line about the run, computed from records so the lead does not infer the frontier
// from an empty list, and testable without an engine.
const full: SituationSnapshot = { open: 6, running: 2, runningRoles: ['discovery', 'validation'], ready: 3, exhausted: 0, leadsUntriaged: 2, leadsCritical: 1, routesOpen: 2, routesDone: 1, routeNames: ['auth'], unprovenNegations: 1, blocked: 1,
  openContradictions: 1, chainReady: 1, chainUnmet: 2, chainSteps: 0, chainReadySteps: 0, chainWaitingSteps: 0, unmetNeeds: 2,
  unplannedAssets: 4, unplannedSamples: ['endpoint /api/export'], wstgUnplanned: 2, wstgSamples: ['wstg-athz-04'], unmetNeedSamples: ['cred.session <- claim-2'],
  untriagedGaps: 1, untriagedSamples: ['gap-1'], replayableClaims: 3, derivedEdges: 2, validationCurrent: 1, pendingRating: 4, coverageTested: 12, coverageCells: 31, coveragePlanned: 0, coverageOmitted: 0,
  suggested: { purpose: 'validation', score: 65 } };
const idle: SituationSnapshot = { open: 0, running: 0, runningRoles: [], ready: 0, exhausted: 0, leadsUntriaged: 0, leadsCritical: 0, routesOpen: 0, routesDone: 0, routeNames: [], unprovenNegations: 0, blocked: 0, openContradictions: 0,
  chainReady: 0, chainUnmet: 0, chainSteps: 0, chainReadySteps: 0, chainWaitingSteps: 0, unmetNeeds: 0,
  unplannedAssets: 0, unplannedSamples: [], wstgUnplanned: 0, wstgSamples: [], unmetNeedSamples: [], untriagedGaps: 0, untriagedSamples: [],
  replayableClaims: 0, derivedEdges: 0, validationCurrent: 0, pendingRating: 0, coverageTested: 0, coverageCells: 0, coveragePlanned: 0, coverageOmitted: 0, suggested: null };

const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, status, role: 'discovery', prerequisites: [], ...extra }) as never;
const view = (extra: Record<string, unknown>) => ({ verdict: 'open', reviewStatus: 'pending', contradictions: [], ...extra }) as never;
const plan = (cells: Array<Record<string, unknown>>) => ({ cells }) as never;
const claim = (extra: Record<string, unknown>) => ({ closure: 'confirmed', ...extra });

describe('situation line (P3)', () => {
  it('renders the documented line for a busy run', () => {
    // The line is hard-capped at 240 bytes: with the route/negation/lead segments present the chain, rating and coverage
    // segments fall off the tail in that order (they are the optional ones), and nothing is invented to fill the space.
    expect(situationLine(full)).toBe('Situation: 2 running (discovery, validation) · 3 ready · next: validation 65 · 1 blocked on evidence · 1 open contradiction · routes: 2 open (auth), 1 done · 1 unproven-negation · leads: 2 untriaged (1 critical).');
    expect(situationLine(full).length).toBeLessThanOrEqual(SITUATION_LIMIT);
  });

  it('says 0 open when the frontier is empty, and drops optional segments before exceeding the cap', () => {
    expect(situationLine(idle)).toBe('Situation: 0 open.');
    const crowded = { ...full, runningRoles: ['investigation', 'reporting', 'validation'], openContradictions: 12, pendingRating: 99, chainUnmet: 88, chainSteps: 0, chainReadySteps: 0, chainWaitingSteps: 0, coverageTested: 999, coverageCells: 1000 };
    const line = situationLine(crowded);
    expect(line.length).toBeLessThanOrEqual(SITUATION_LIMIT);
    expect(line.startsWith('Situation: 2 running')).toBe(true);
  });

  it('suggests the highest-scoring dispatchable task and lets a ready chain step outrank it (P4)', () => {
    const tasks = [
      task('t-validation', 'proposed', { role: 'validation', work: { purpose: 'validation', questionKey: 'q-open', assetRefs: [{ id: 'asset-a' }] } }),
      task('t-covered', 'proposed', { work: { purpose: 'discovery', questionKey: 'q-answered', assetRefs: [{ id: 'asset-b' }] } }),
      task('t-running', 'running'),
    ];
    const coverage = [plan([{ questionKey: 'q-answered', currentness: 'current', effectiveAssessment: 'confirmed_claim', execution: 'tested' }])];
    // Unlocking purpose 50+15 = 65; a question an answered cell already covers 50-20 = 30.
    const relaxed = summarizeSituation({ tasks, cases: [], coverage, claims: [] });
    expect(relaxed.suggested).toEqual({ purpose: 'validation', score: 65 });
    expect(situationLine(relaxed)).toContain('next: validation 65');
    // A ready chain step is the claim whose every need an existing claim already gains: 50+15+20 = 85.
    const chained = summarizeSituation({ tasks, cases: [], coverage, claims: [claim({ gained: [{ kind: 'cred.session' }], execution: 'tested' }), claim({ closure: 'open_proof_gap', needs: [{ kind: 'cred.session' }] })] });
    expect(chained.suggested).toEqual({ purpose: 'validation', score: 85 });
  });

  it('boosts a task whose asset already carries an accepted finding, and stays silent when nothing can start', () => {
    const tasks = [task('t-mapping', 'proposed', { work: { purpose: 'mapping', questionKey: 'q', assetRefs: [{ id: 'asset-a' }] } })];
    const accepted = view({ reviewStatus: 'accepted', acceptedFinding: true, assetRefs: [{ id: 'asset-a' }] });
    expect(summarizeSituation({ tasks, cases: [accepted], coverage: [], claims: [] }).suggested).toEqual({ purpose: 'mapping', score: 60 });
    expect(summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [] }).suggested).toBeNull();
  });

  it('keeps the renderer and the snapshot in step: every counter is rendered and every rendered segment has a field', () => {
    const covered = new Set(Object.values(SEGMENT_FIELDS).flat());
    expect([...covered].sort()).toEqual(Object.keys(idle).sort());
    const rendered = new Set(situationSegments(full).map(segment => segment.id));
    for (const [id, fields] of Object.entries(SEGMENT_FIELDS)) {
      if (id === 'stall') continue; // renders only when nothing is open, asserted below
      if (fields.some(field => full[field] !== 0)) expect(rendered.has(id as never), id).toBe(true);
    }
    expect(rendered.has('stall')).toBe(full.open === 0);
    expect(situationSegments(idle).map(segment => segment.id)).toEqual(['stall']);
  });

  it('counts the frontier, the chain join and the rating backlog from records', () => {
    const snapshot = summarizeSituation({
      tasks: [task('a', 'closed'), task('b', 'cancelled'), task('c', 'running'), task('d', 'proposed', { prerequisites: [{ taskId: 'a' }] }),
        task('e', 'proposed', { prerequisites: [{ taskId: 'c' }] }), task('f', 'blocked')],
      cases: [view({ contradictions: [{ status: 'open' }, { status: 'resolved' }] }), view({ reviewStatus: 'accepted' }),
        view({ reviewStatus: 'accepted', finding: { severity: 'high' } }), view({ reviewStatus: 'pending', contradictions: [{ status: 'open' }] })],
      coverage: [plan([{ execution: 'tested' }, { execution: 'planned' }]), plan([{ execution: 'tested' }])],
      claims: [claim({ gained: [{ kind: 'cred.session', subject: 'alice' }], execution: 'tested' }), claim({ closure: 'open_proof_gap', needs: [{ kind: 'cred.session', subject: 'alice' }] }),
        claim({ closure: 'open_proof_gap', needs: [{ kind: 'data.read', scope: 'admin-bucket' }], gained: [{ kind: 'data.read' }] })],
    });
    expect([snapshot.open, snapshot.running, snapshot.ready, snapshot.blocked]).toEqual([4, 1, 1, 1]);
    expect(snapshot.runningRoles).toEqual(['discovery']);
    expect(snapshot.openContradictions).toBe(2);
    expect([snapshot.chainReady, snapshot.chainUnmet]).toEqual([1, 1]);
    expect(snapshot.pendingRating).toBe(1);
    expect([snapshot.coverageTested, snapshot.coverageCells]).toEqual([2, 3]);
  });

  it('counts open claims against confirmed+tested providers, not against every recorded claim', () => {
    const open = claim({ closure: 'open_proof_gap', needs: [{ kind: 'cred.session', subject: 'alice' }] });
    const join = (...claims: Array<Record<string, unknown>>) => { const snapshot = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: claims as never }); return [snapshot.chainReady, snapshot.chainUnmet]; };
    expect(join(open)).toEqual([0, 1]); // nothing recorded gains it yet
    expect(join(open, claim({ gained: [{ kind: 'cred.session', subject: 'alice' }], execution: 'not_tested' }))).toEqual([0, 1]); // recorded, not tested
    expect(join(open, claim({ closure: 'ruled_out', gained: [{ kind: 'cred.session', subject: 'alice' }] }))).toEqual([0, 1]); // ruled out is not a primitive
    expect(join(open, claim({ gained: [{ kind: 'cred.session', subject: 'alice' }], execution: 'tested' }))).toEqual([1, 0]);
    expect(join(claim({ gained: [{ kind: 'cred.session', subject: 'alice' }], execution: 'tested' }))).toEqual([0, 0]); // a closed claim is not pending work
  });
});
