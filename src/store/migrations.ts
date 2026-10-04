import type { DatabaseSync } from 'node:sqlite';
import { StoreError } from './types.js';

export const STORE_SCHEMA_VERSION = 4;
export const migrations = [
  {
    version: 1, name: 'durable-runs-tasks-attempts-receipts', sql: `
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
      CREATE TABLE runs(run_id TEXT PRIMARY KEY, state TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
      CREATE TABLE tasks(
        task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
        parent_task_id TEXT REFERENCES tasks(task_id), current_attempt_id TEXT,
        lifecycle_state TEXT NOT NULL, packet_state TEXT NOT NULL, input_revision TEXT NOT NULL,
        workspace TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)), UNIQUE(task_id, run_id)
      ) STRICT;
      CREATE TABLE task_dependencies(task_id TEXT NOT NULL REFERENCES tasks(task_id), dependency_task_id TEXT NOT NULL REFERENCES tasks(task_id), PRIMARY KEY(task_id, dependency_task_id), CHECK(task_id <> dependency_task_id)) STRICT;
      CREATE TABLE attempts(
        attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0), lifecycle_state TEXT NOT NULL,
        json TEXT NOT NULL CHECK(json_valid(json)), UNIQUE(task_id, sequence), UNIQUE(attempt_id, task_id, run_id),
        FOREIGN KEY(task_id, run_id) REFERENCES tasks(task_id, run_id)
      ) STRICT;
      CREATE TABLE workspace_fences(workspace TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation > 0)) STRICT;
      CREATE TABLE workspace_leases(
        workspace TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
        acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        FOREIGN KEY(attempt_id, task_id, run_id) REFERENCES attempts(attempt_id, task_id, run_id)
      ) STRICT;
      CREATE TABLE evidence(
        evidence_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        digest TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)),
        FOREIGN KEY(attempt_id, task_id, run_id) REFERENCES attempts(attempt_id, task_id, run_id)
      ) STRICT;
      CREATE TABLE results(
        result_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        digest TEXT NOT NULL, decision_state TEXT NOT NULL CHECK(decision_state IN ('accepted', 'returned-for-evidence')),
        packet_json TEXT NOT NULL CHECK(json_valid(packet_json)), decision_json TEXT NOT NULL CHECK(json_valid(decision_json)), admitted_at TEXT NOT NULL,
        FOREIGN KEY(attempt_id, task_id, run_id) REFERENCES attempts(attempt_id, task_id, run_id)
      ) STRICT;
      CREATE UNIQUE INDEX one_accepted_result_per_attempt ON results(attempt_id) WHERE decision_state = 'accepted';
      CREATE TABLE result_keys(run_id TEXT NOT NULL REFERENCES runs(run_id), idempotency_key TEXT NOT NULL, result_id TEXT NOT NULL REFERENCES results(result_id), PRIMARY KEY(run_id, idempotency_key)) STRICT;
      CREATE TABLE coverage(coverage_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), task_id TEXT REFERENCES tasks(task_id), json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
      CREATE TABLE findings(finding_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)), FOREIGN KEY(task_id, run_id) REFERENCES tasks(task_id, run_id)) STRICT;
      CREATE TABLE events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(run_id), task_id TEXT REFERENCES tasks(task_id), attempt_id TEXT REFERENCES attempts(attempt_id),
        type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
      ) STRICT;
      CREATE TABLE outbox(
        event_sequence INTEGER PRIMARY KEY REFERENCES events(sequence), delivery_attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL, claim_owner TEXT, claim_token TEXT, claim_until TEXT, delivered_at TEXT, last_error TEXT,
        CHECK((claim_owner IS NULL AND claim_token IS NULL AND claim_until IS NULL) OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_until IS NOT NULL))
      ) STRICT;
    `,
  },
  {
    version: 2, name: 'budget-ledger-and-query-indexes', sql: `
      CREATE TABLE target_usage(run_id TEXT NOT NULL REFERENCES runs(run_id), target_id TEXT NOT NULL, requests INTEGER NOT NULL CHECK(requests >= 0), PRIMARY KEY(run_id, target_id)) STRICT;
      CREATE INDEX tasks_by_run ON tasks(run_id);
      CREATE INDEX attempts_by_run_task ON attempts(run_id, task_id);
      CREATE INDEX leases_by_run ON workspace_leases(run_id);
      CREATE INDEX evidence_by_run ON evidence(run_id);
      CREATE INDEX results_by_run_task ON results(run_id, task_id);
      CREATE INDEX events_by_run_sequence ON events(run_id, sequence);
      CREATE INDEX outbox_ready ON outbox(delivered_at, available_at, claim_until);
    `,
  },
  {
    version: 3, name: 'model-spend-journal', sql: `
      CREATE TABLE model_spend_journal(
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        json TEXT NOT NULL CHECK(json_valid(json)),
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  { version: 4, name: 'autonomous-phase-journals', sql: `
    CREATE TABLE autonomous_budget_runs(run_id TEXT PRIMARY KEY, plan_json TEXT NOT NULL CHECK(json_valid(plan_json))) STRICT;
    CREATE TABLE autonomous_phase_attempts(run_id TEXT NOT NULL REFERENCES autonomous_budget_runs(run_id), phase TEXT NOT NULL CHECK(phase IN ('planner','report')), attempt_id TEXT NOT NULL UNIQUE, PRIMARY KEY(run_id, phase, attempt_id)) STRICT;
    CREATE TABLE autonomous_phase_journals(run_id TEXT NOT NULL REFERENCES autonomous_budget_runs(run_id), phase TEXT NOT NULL CHECK(phase IN ('planner','workers','verifier','report')), json TEXT NOT NULL CHECK(json_valid(json)), updated_at TEXT NOT NULL, PRIMARY KEY(run_id, phase)) STRICT;
    CREATE TABLE autonomous_preflight_budget(run_id TEXT PRIMARY KEY REFERENCES autonomous_budget_runs(run_id), json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
  ` },
] as const;

/** Each migration and its version receipt share an exclusive writer transaction. */
export function migrate(db: DatabaseSync, now: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (current > STORE_SCHEMA_VERSION) throw new StoreError('schema-too-new', 'Database was created by a newer store; refusing to downgrade');
    if (current > 0) {
      const recorded = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
      if (recorded.length !== current || recorded.some((r, i) => Number(r.version) !== i + 1 || r.name !== migrations[i]?.name)) throw new StoreError('migration-history', 'Database migration history is inconsistent');
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, now);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
