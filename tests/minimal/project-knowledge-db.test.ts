import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectKnowledge, PROJECT_KNOWLEDGE_NOTE, PROJECT_KNOWLEDGE_SCHEMA } from '../../src/project-knowledge-db.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * R3.9: project-scoped knowledge is append-only host history, kept outside the run. These tests pin the four properties the plan
 * asked for — round-trip provenance, tenant/scope isolation, conflict surfacing, stale-not-deleted on a changed scope — and the
 * invariant that a suggested row can never stand in for evidence.
 */
const finding = (findingId: string, state = 'accepted', extra: Record<string, unknown> = {}) => ({ findingId, policyKey: 'policy:report-case', rootCauseKey: 'root:report-gate', severity: 'medium', state, ...extra });
const findingsOf = (prefix: string) => [finding(`${prefix}00000000000000000000000000000`, 'accepted')];
const id = (tail: string) => tail.padEnd(32, '0').slice(0, 32);

let root: string, file: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'p2o-project-knowledge-')); file = join(root, 'project.sqlite'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const open = () => ProjectKnowledge.open(file);
const merge = (db: ProjectKnowledge, input: Record<string, unknown>) => db.merge({ scope: { tenant: 'acme', target: 'https://target.example/' }, runId: 'run-a', retrievedAt: '2026-10-29T00:00:00.000Z', findings: [], assets: [], ...(input as any) });
const read = (db: ProjectKnowledge, filter: Record<string, unknown> = {}) => db.read(filter)[0];

describe('project knowledge database', () => {
  it('round-trips identity, provenance and suggestion-only rows, and re-merging the same run is idempotent', () => {
    const db = open();
    try {
      expect(db.merge({ scope: { tenant: 'acme', target: 'https://target.example/' }, runId: 'run-a', retrievedAt: '2026-10-29T00:00:00.000Z',
        findings: [finding(id('a'), 'accepted', { caseRef: 'case-1' })], assets: [{ id: 'asset-1', kind: 'endpoint', key: 'GET /reports', label: 'reports' }] })).toMatchObject({ inserted: 2, suppressed: 0 });
      const view = read(db);
      expect(view).toMatchObject({ schema: PROJECT_KNOWLEDGE_SCHEMA, tenant: 'acme', target: 'https://target.example/', conflicts: 0, staleRows: 0, note: PROJECT_KNOWLEDGE_NOTE });
      expect(view.findings).toHaveLength(1); expect(view.findings[0]).toMatchObject({ kind: 'finding', identity: id('a'), state: 'accepted', runId: 'run-a', retrievedAt: '2026-10-29T00:00:00.000Z', suggested: true, conflict: false, stale: false, detail: { policyKey: 'policy:report-case', rootCauseKey: 'root:report-gate', severity: 'medium', caseRef: 'case-1' } });
      expect(view.assets[0]).toMatchObject({ kind: 'asset', identity: 'endpoint:GET /reports', state: 'observed', suggested: true, detail: { id: 'asset-1', kind: 'endpoint', key: 'GET /reports', label: 'reports' } });
      // Re-merging the same run/state is suppressed, not duplicated: a retried export cannot inflate history.
      expect(db.merge({ scope: { tenant: 'acme', target: 'https://target.example/' }, runId: 'run-a', retrievedAt: '2026-10-29T00:00:00.000Z', findings: [finding(id('a'), 'accepted', { caseRef: 'case-1' })], assets: [] })).toMatchObject({ inserted: 0, suppressed: 1 });
      expect(read(db).findings[0].priorRunIds).toEqual([]);
      expect(db.counts()).toEqual({ observations: 2, scopes: 1 });
    } finally { db.close(); }
  });

  it('keeps tenants and targets isolated: one scope never reads another scope history', () => {
    const db = open();
    try {
      merge(db, { findings: [finding(id('a'))] });
      db.merge({ scope: { tenant: 'acme', target: 'https://other.example/' }, runId: 'run-b', retrievedAt: '2026-10-29T01:00:00.000Z', findings: [finding(id('b'))], assets: [] });
      db.merge({ scope: { tenant: 'other-tenant', target: 'https://target.example/' }, runId: 'run-c', retrievedAt: '2026-10-29T02:00:00.000Z', findings: [finding(id('c'))], assets: [] });
      const mine = read(db, { tenant: 'acme', target: 'https://target.example/' });
      expect(mine.findings.map(row => row.identity)).toEqual([id('a')]);
      expect(db.read({ tenant: 'acme' })).toHaveLength(2);
      expect(db.read({ tenant: 'other-tenant' })[0].findings.map(row => row.identity)).toEqual([id('c')]);
      expect(db.read()).toHaveLength(3);
    } finally { db.close(); }
  });

  it('surfaces a conflict when another run recorded a different disposition for the same identity, keeping both', () => {
    const db = open();
    try {
      merge(db, { findings: [finding(id('a'), 'accepted')] });
      db.merge({ scope: { tenant: 'acme', target: 'https://target.example/' }, runId: 'run-b', retrievedAt: '2026-10-29T03:00:00.000Z', findings: [finding(id('a'), 'fixed')], assets: [] });
      const view = read(db);
      expect(view.conflicts).toBe(1);
      expect(view.findings[0]).toMatchObject({ state: 'fixed', conflict: true, priorRunIds: ['run-a'], priorStates: ['accepted'] });
      // A same-run re-observation is not a conflict with itself.
      db.merge({ scope: { tenant: 'acme', target: 'https://target.example/' }, runId: 'run-b', retrievedAt: '2026-10-29T04:00:00.000Z', findings: [finding(id('a'), 'still_reproducible')], assets: [] });
      const later = read(db);
      expect(later.findings[0]).toMatchObject({ state: 'still_reproducible', conflict: true, priorStates: ['accepted'] });
    } finally { db.close(); }
  });

  it('marks the previous target history stale when a tenant moves scope, without deleting it', () => {
    const db = open();
    try {
      merge(db, { findings: [finding(id('a'))] });
      db.merge({ scope: { tenant: 'acme', target: 'https://moved.example/' }, runId: 'run-b', retrievedAt: '2026-10-29T05:00:00.000Z', findings: [finding(id('b'))], assets: [] });
      const old = read(db, { tenant: 'acme', target: 'https://target.example/' }), moved = read(db, { tenant: 'acme', target: 'https://moved.example/' });
      expect(old).toMatchObject({ staleRows: 1 }); expect(old.findings[0]).toMatchObject({ stale: true, identity: id('a') });
      expect(moved).toMatchObject({ staleRows: 0 }); expect(moved.findings[0]).toMatchObject({ stale: false, identity: id('b') });
      expect(db.counts()).toMatchObject({ scopes: 2 }); // not deleted
    } finally { db.close(); }
  });

  it('rejects malformed input instead of storing it, and reports an unsupported schema rather than migrating in place', async () => {
    const db = open();
    try {
      expect(() => db.merge({ scope: { tenant: 'acme', target: '  ' }, runId: 'run-a', retrievedAt: '2026-10-29T00:00:00.000Z', findings: [], assets: [] })).toThrow(/target/);
      expect(() => db.merge({ scope: { tenant: 'acme', target: 'https://target.example/' }, runId: 'bad run id!', retrievedAt: '2026-10-29T00:00:00.000Z', findings: [], assets: [] })).toThrow(/run id/);
      expect(() => db.merge({ scope: { tenant: 'acme', target: 'https://target.example/' }, runId: 'run-a', retrievedAt: 'not-a-time', findings: [], assets: [] })).toThrow(/retrieval time/);
      expect(() => merge(db, { findings: [finding('not-a-fingerprint')] })).toThrow(/finding id/);
      expect(() => merge(db, { findings: [finding(id('a'), 'state\u0000null')] })).toThrow(/finding state/);
      expect(db.counts()).toEqual({ observations: 0, scopes: 0 });
    } finally { db.close(); }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '');
    const raw = ProjectKnowledge.open(file); raw.close();
    // A file with a different recorded schema is refused, never silently upgraded.
    const { DatabaseSync } = await import('node:sqlite');
    const direct = new DatabaseSync(file); direct.exec("UPDATE meta SET value='99' WHERE key='schema'"); direct.close();
    expect(() => ProjectKnowledge.open(file)).toThrow(/Unsupported project knowledge schema/);
  });

  it('is wired to an owner-requested export as suggested context only, and the default export is unchanged', async () => fixture(async h => {
    await populate(h);
    h.ctx.setConfirm(true);
    await h.command(`report export ${join(h.root, 'pk-flagged')} --project-knowledge`);
    const flagged = await h.read(join(h.root, 'pk-flagged'));
    const prior = JSON.parse(flagged['prior-knowledge.json']);
    expect(prior).toMatchObject({ format: 'p2o-prior-knowledge', version: 1, suggestedOnly: true, scope: { tenant: '' } });
    expect(prior.note).toContain('Suggested context only');
    expect(prior.rows.some((row: any) => row.kind === 'finding' && row.suggested === true)).toBe(true);
    expect(flagged['REPORT.md']).toContain('## Prior knowledge (suggested context, not evidence)');
    expect(flagged['REPORT.md']).toContain('| Kind | Identity | State | Detail | Recorded by | Earlier runs | Flag |');
    // The database is written next to the workspace only because the operator asked for it.
    const db = ProjectKnowledge.open(join(h.root, '.p2o-project-knowledge.sqlite'));
    try { expect(db.counts().observations).toBeGreaterThan(0); } finally { db.close(); }
    // Without the flag the bundle keeps its shape and no project database is touched.
    await h.command(`report export ${join(h.root, 'pk-plain')}`);
    const plain = await h.read(join(h.root, 'pk-plain'));
    expect(plain['prior-knowledge.json']).toBeUndefined();
    expect(plain['REPORT.md']).not.toContain('## Prior knowledge');
    // Suggested context is not evidence: the case and its claims are exactly what the run recorded.
    const cases = (await h.call('p2o_board', { board: 'cases' })).details.entries, accepted = cases.find((entry: any) => entry.acceptedFinding);
    expect((await h.call('p2o_board', { board: 'cases', id: accepted.id })).details).toMatchObject({ acceptedFinding: true, currentness: 'current' });
  }));

  it('is suggested context by construction: rows carry no receipt and the module writes nothing into the run store', () => {
    const db = open();
    try {
      merge(db, { findings: [finding(id('a'))], assets: [{ id: 'asset-1', kind: 'endpoint', key: 'GET /reports' }] });
      const row = read(db).findings[0];
      expect(row.suggested).toBe(true);
      // No evidence-shaped fields exist on a row: a reader cannot cite it as a receipt.
      expect(row).not.toHaveProperty('evidenceRefs'); expect(row).not.toHaveProperty('recordId'); expect(row).not.toHaveProperty('claimRefs'); expect(row).not.toHaveProperty('acceptedFinding');
      expect(read(db).note).toContain('never enough to confirm a claim or a coverage cell');
    } finally { db.close(); }
  });
});
