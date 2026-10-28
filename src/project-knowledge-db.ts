import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FINDING_ID_PATTERN } from './finding-fingerprint.js';
import { CONTROL, validId } from './validate.js';

/**
 * R3.9: project-level knowledge, kept OUTSIDE the run (one database per project, not per run), so a later run can be told what an
 * earlier run in the same project already recorded: the same finding id came back, the same asset exists, a retest answered it.
 *
 * What this is not: it is not the run's evidence. Every row is SUGGESTED context — a lookup hint the host derived from stored
 * identities, never a graph fact, never a receipt, never enough to confirm a claim or a coverage cell. Nothing here is written by a
 * model: the host merges only identity-bearing values it already validated in the run (finding id, policy/root-cause keys, severity,
 * asset kind/key), with provenance (run id, retrieval time, source scope), append-only. A conflict (the same finding id recorded with
 * a different state by another run) keeps both rows and is surfaced instead of overwritten, and a tenant that moves to a different
 * target marks the old target's rows stale instead of deleting them.
 *
 * Single writer: WAL, a busy timeout, and a merge in one immediate transaction. This file opens its own handle and never shares the
 * run store's connection.
 */
export const PROJECT_KNOWLEDGE_SCHEMA = 1;
export const PROJECT_KNOWLEDGE_NOTE = 'Host-only history from earlier exports in this project. Suggested context only: never a graph fact, never a receipt, and never enough to confirm a claim or a coverage cell.';

export interface ProjectScope { tenant: string; target: string }
/** One finding identity a run recorded, as it stood at that moment. `state` is the recorded disposition, not a live verdict. */
export interface ProjectFindingObservation { findingId: string; policyKey: string; rootCauseKey?: string; severity?: string; state: string; caseRef?: string }
export interface ProjectAssetObservation { id: string; kind: string; key: string; label?: string }
export interface ProjectMergeInput { scope: ProjectScope; runId: string; retrievedAt: string; findings: readonly ProjectFindingObservation[]; assets: readonly ProjectAssetObservation[] }
export interface ProjectKnowledgeRow {
  kind: 'finding' | 'asset'; identity: string; state: string; detail: Readonly<Record<string, string | number>>;
  runId: string; retrievedAt: string; /** Earlier runs that recorded the same identity, newest first. */ priorRunIds: readonly string[];
  /** States those earlier runs recorded, so a reader sees a changed disposition instead of a silently overwritten one. */ priorStates: readonly string[];
  stale: boolean; conflict: boolean; suggested: true;
}
export interface ProjectKnowledgeView {
  schema: number; tenant: string; target: string; findings: ProjectKnowledgeRow[]; assets: ProjectKnowledgeRow[];
  conflicts: number; staleRows: number; note: string;
}
export interface ProjectMergeResult { inserted: number; suppressed: number; conflicts: number; staleScopes: number }

const clean = (value: unknown, label: string, limit: number): string => {
  const text = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (!text || text.length > limit || CONTROL.test(text)) throw Error(`Invalid project knowledge ${label}`);
  return text;
};
const scopeOf = (scope: ProjectScope | undefined): ProjectScope => {
  if (!scope || typeof scope !== 'object') throw Error('Project knowledge merge needs a scope');
  const tenant = typeof scope.tenant === 'string' ? scope.tenant.trim().toLowerCase() : '';
  if (tenant && (tenant.length > 120 || CONTROL.test(tenant))) throw Error('Invalid project knowledge tenant');
  return { tenant, target: clean(scope.target, 'target', 400).toLowerCase() };
};
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const boundedJson = (value: Readonly<Record<string, unknown>>): string => JSON.stringify(value);
const rowDetail = (detail: string): Record<string, string | number> => {
  try { const parsed = JSON.parse(detail) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string | number> : {}; } catch { return {}; }
};

/** Columns a finding observation may carry; everything else is dropped, so this store cannot become a free-text side channel. */
const findingDetail = (observation: ProjectFindingObservation): Record<string, string | number> => ({
  policyKey: clean(observation.policyKey, 'policy key', 160),
  ...(observation.rootCauseKey ? { rootCauseKey: clean(observation.rootCauseKey, 'root cause key', 160) } : {}),
  ...(observation.severity ? { severity: clean(observation.severity, 'severity', 32) } : {}),
  ...(observation.caseRef ? { caseRef: clean(observation.caseRef, 'case reference', 80) } : {}),
});
const assetDetail = (observation: ProjectAssetObservation): Record<string, string | number> => ({
  id: validId(observation.id) ? observation.id : clean(observation.id, 'asset id', 80),
  kind: clean(observation.kind, 'asset kind', 32),
  key: clean(observation.key, 'asset key', 240),
  ...(observation.label ? { label: clean(observation.label, 'asset label', 120) } : {}),
});

export class ProjectKnowledge {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open (or create) the project database at `file`. One writer: WAL plus a busy timeout, so a second handle waits instead of corrupting. */
  static open(file: string): ProjectKnowledge {
    if (typeof file !== 'string' || !file.trim()) throw Error('Project knowledge needs a database path');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
        identity TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT NOT NULL, retrieved_at TEXT NOT NULL, detail TEXT NOT NULL,
        UNIQUE(tenant, target, kind, identity, run_id, state, detail));
      CREATE TABLE IF NOT EXISTS scope_events(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, target TEXT NOT NULL, mark TEXT NOT NULL, at TEXT NOT NULL);`);
    const stored = db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value?: unknown } | undefined;
    const schema = stored?.value === undefined ? PROJECT_KNOWLEDGE_SCHEMA : Number(stored.value);
    if (!Number.isSafeInteger(schema) || schema !== PROJECT_KNOWLEDGE_SCHEMA) { db.close(); throw Error(`Unsupported project knowledge schema ${String(stored?.value)}`); }
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('schema', ?)").run(String(PROJECT_KNOWLEDGE_SCHEMA));
    return new ProjectKnowledge(db);
  }

  /** Append one run's observations. Re-merging the same run is idempotent (the unique key suppresses duplicates). */
  merge(input: ProjectMergeInput): ProjectMergeResult {
    const scope = scopeOf(input.scope);
    if (!validId(input.runId)) throw Error('Invalid project knowledge run id');
    const runId = String(input.runId);
    if (!INSTANT.test(String(input.retrievedAt ?? ''))) throw Error('Invalid project knowledge retrieval time');
    const retrievedAt = String(input.retrievedAt);
    if (!Array.isArray(input.findings) || !Array.isArray(input.assets)) throw Error('Project knowledge merge needs findings and assets arrays');
    const findings = input.findings.slice(0, 200).map(observation => {
      if (!FINDING_ID_PATTERN.test(String(observation.findingId ?? ''))) throw Error('Invalid project knowledge finding id');
      const state = clean(observation.state, 'finding state', 64);
      return { identity: String(observation.findingId), state, detail: boundedJson(findingDetail(observation)) };
    });
    const assets = input.assets.slice(0, 500).map(observation => {
      const detail = assetDetail(observation);
      if (!detail.kind || !detail.key) throw Error('Project knowledge asset needs a kind and a key');
      return { identity: `${detail.kind}:${detail.key}`, state: 'observed', detail: boundedJson(detail) };
    });
    const insert = this.db.prepare('INSERT OR IGNORE INTO observations(tenant, target, kind, identity, state, run_id, retrieved_at, detail) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
    let inserted = 0, suppressed = 0;
    const mark = this.db.prepare('INSERT INTO scope_events(tenant, target, mark, at) VALUES(?, ?, ?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [kind, rows] of [['finding', findings], ['asset', assets]] as const) {
        for (const row of rows) { const result = insert.run(scope.tenant, scope.target, kind, row.identity, row.state, runId, retrievedAt, row.detail); if (Number(result.changes) > 0) inserted++; else suppressed++; }
      }
      // A tenant that moved to another target keeps its history but the old target reads as stale; nothing is deleted.
      const previous = this.db.prepare('SELECT DISTINCT target FROM observations WHERE tenant=? AND target<>?').all(scope.tenant, scope.target) as Array<{ target: string }>;
      let staleScopes = 0;
      for (const row of previous) { mark.run(scope.tenant, row.target, 'stale', retrievedAt); staleScopes++; }
      mark.run(scope.tenant, scope.target, 'current', retrievedAt);
      this.db.exec('COMMIT');
      const conflicts = this.read({ tenant: scope.tenant, target: scope.target })[0]?.conflicts ?? 0;
      return { inserted, suppressed, conflicts, staleScopes };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Read the history of the matching project scopes. Rows are ordered by identity for a deterministic report. */
  read(filter: { tenant?: string; target?: string; limit?: number } = {}): ProjectKnowledgeView[] {
    const limit = Math.min(500, Math.max(1, Number(filter.limit ?? 200)));
    const tenant = typeof filter.tenant === 'string' ? filter.tenant.trim().toLowerCase() : undefined, target = typeof filter.target === 'string' ? filter.target.trim().toLowerCase() : undefined;
    const clauses = [tenant === undefined ? '1=1' : 'tenant=?', target === undefined ? '1=1' : 'target=?'], params = [tenant ?? null, target ?? null].filter(value => value !== null) as string[];
    const scopes = this.db.prepare(`SELECT DISTINCT tenant, target FROM observations WHERE ${clauses.join(' AND ')} ORDER BY tenant, target`).all(...params) as Array<{ tenant: string; target: string }>;
    const latestMark = this.db.prepare('SELECT mark FROM scope_events WHERE tenant=? AND target=? ORDER BY id DESC LIMIT 1');
    const rowsOf = this.db.prepare('SELECT kind, identity, state, run_id, retrieved_at, detail FROM observations WHERE tenant=? AND target=? ORDER BY id ASC');
    const views: ProjectKnowledgeView[] = [];
    for (const scope of scopes) {
      const mark = latestMark.get(scope.tenant, scope.target) as { mark?: unknown } | undefined, stale = mark?.mark === 'stale';
      const grouped = new Map<string, Array<{ kind: 'finding' | 'asset'; identity: string; state: string; runId: string; retrievedAt: string; detail: string }>>();
      for (const raw of rowsOf.all(scope.tenant, scope.target) as Array<Record<string, unknown>>) {
        const row = { kind: String(raw.kind) as 'finding' | 'asset', identity: String(raw.identity), state: String(raw.state), runId: String(raw.run_id), retrievedAt: String(raw.retrieved_at), detail: String(raw.detail) };
        grouped.set(`${row.kind}\u0000${row.identity}`, [...(grouped.get(`${row.kind}\u0000${row.identity}`) ?? []), row]);
      }
      const findings: ProjectKnowledgeRow[] = [], assets: ProjectKnowledgeRow[] = [];
      for (const history of grouped.values()) {
        const latest = history.at(-1)!;
        // One entry per distinct run, in ledger order, so a re-merge of the same run cannot read as a conflict with itself.
        const perRun = new Map<string, typeof latest>();
        for (const row of history) perRun.set(row.runId, row);
        const runs = [...perRun.values()], states = [...new Set(runs.map(row => row.state))];
        const conflict = states.length > 1 && new Set(runs.map(row => row.runId)).size > 1;
        const row: ProjectKnowledgeRow = { kind: latest.kind, identity: latest.identity, state: latest.state, detail: rowDetail(latest.detail), runId: latest.runId, retrievedAt: latest.retrievedAt,
          priorRunIds: [...new Set(runs.map(item => item.runId).filter(run => run !== latest.runId))].reverse(),
          priorStates: [...new Set(runs.filter(item => item.runId !== latest.runId).map(item => item.state))], stale, conflict, suggested: true };
        (row.kind === 'finding' ? findings : assets).push(row);
      }
      findings.sort((left, right) => left.identity.localeCompare(right.identity)); assets.sort((left, right) => left.identity.localeCompare(right.identity));
      const shownFindings = findings.slice(0, limit), shownAssets = assets.slice(0, limit);
      views.push({ schema: PROJECT_KNOWLEDGE_SCHEMA, tenant: scope.tenant, target: scope.target, findings: shownFindings, assets: shownAssets,
        conflicts: [...shownFindings, ...shownAssets].filter(row => row.conflict).length, staleRows: [...shownFindings, ...shownAssets].filter(row => row.stale).length, note: PROJECT_KNOWLEDGE_NOTE });
    }
    return views;
  }

  /** How many observation rows exist, by scope: enough for a round-trip test and an operator health check. */
  counts(): { observations: number; scopes: number } {
    const observations = Number((this.db.prepare('SELECT COUNT(*) AS count FROM observations').get() as { count?: unknown }).count ?? 0);
    const scopes = Number((this.db.prepare('SELECT COUNT(*) AS count FROM (SELECT DISTINCT tenant, target FROM observations)').get() as { count?: unknown }).count ?? 0);
    return { observations, scopes };
  }

  close(): void { this.db.close(); }
}
