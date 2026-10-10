/** Store schema is separate from the unchanged v2 record/exchange format. */
export const STATE_SCHEMA_VERSION = 7;
export const STATE_SCHEMA = `
CREATE TABLE metadata(key TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
CREATE TABLE events(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL,
  run_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, committed_at TEXT NOT NULL,
  actor_id TEXT NOT NULL, task_id TEXT, attempt_id TEXT, operation_id TEXT, correlation_id TEXT,
  entity_id TEXT, entity_revision INTEGER, summary TEXT NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
CREATE INDEX events_actor ON events(actor_id,sequence);
CREATE INDEX events_operation ON events(operation_id,sequence);
CREATE INDEX events_task ON events(task_id,sequence);
CREATE TABLE records(
  id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
  kind TEXT NOT NULL, actor_id TEXT NOT NULL, entity_id TEXT, supersedes TEXT REFERENCES records(id),
  body TEXT NOT NULL CHECK(json_valid(body)), bytes INTEGER NOT NULL
) STRICT;
CREATE INDEX records_kind ON records(kind,sequence);
CREATE INDEX records_actor ON records(actor_id,sequence);
CREATE INDEX records_entity ON records(entity_id,sequence);
CREATE TABLE work_history(
  sequence INTEGER PRIMARY KEY REFERENCES events(sequence), record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
  task_id TEXT NOT NULL, task_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, target_revision TEXT NOT NULL,
  overlap_key TEXT, status TEXT NOT NULL, current INTEGER NOT NULL CHECK(current IN (0,1)), result TEXT NOT NULL
) STRICT;
CREATE INDEX work_history_fingerprint ON work_history(fingerprint,current,sequence DESC);
CREATE INDEX work_history_overlap ON work_history(overlap_key,current,sequence DESC);
CREATE INDEX work_history_task ON work_history(task_id,sequence DESC);
CREATE TABLE work_reservations(
  fingerprint TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, task_revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL REFERENCES events(sequence)
) STRICT;
CREATE TABLE knowledge_heads(
  domain TEXT NOT NULL, entity_id TEXT NOT NULL, record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
  sequence INTEGER NOT NULL REFERENCES events(sequence), status TEXT NOT NULL, actor_id TEXT NOT NULL,
  PRIMARY KEY(domain,entity_id)
) STRICT;
CREATE INDEX knowledge_heads_status ON knowledge_heads(domain,status,sequence);
CREATE INDEX knowledge_heads_sequence ON knowledge_heads(sequence);
CREATE INDEX knowledge_heads_actor ON knowledge_heads(actor_id,domain,status,sequence);
CREATE TABLE knowledge_links(
  record_id TEXT NOT NULL REFERENCES records(id), relation TEXT NOT NULL, target_id TEXT NOT NULL,
  PRIMARY KEY(record_id,relation,target_id)
) STRICT;
CREATE INDEX knowledge_links_target ON knowledge_links(target_id,relation,record_id);
CREATE TABLE context_cursors(
  consumer_id TEXT PRIMARY KEY, through_sequence INTEGER NOT NULL, gap_through INTEGER NOT NULL, review_through INTEGER NOT NULL,
  packet_sha256 TEXT NOT NULL, event_sequence INTEGER NOT NULL REFERENCES events(sequence), body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
CREATE TABLE outbox(sequence INTEGER PRIMARY KEY REFERENCES events(sequence), delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1))) STRICT;
CREATE TABLE requests(
  actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)), sequence INTEGER NOT NULL REFERENCES events(sequence),
  PRIMARY KEY(actor_id,request_id)
) STRICT;
CREATE TABLE artifacts(
  id TEXT PRIMARY KEY, sequence INTEGER NOT NULL REFERENCES events(sequence),
  filename TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
CREATE TABLE checkpoints(
  id TEXT PRIMARY KEY, sequence INTEGER NOT NULL REFERENCES events(sequence), as_of_sequence INTEGER NOT NULL,
  filename TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
  manifest TEXT NOT NULL CHECK(json_valid(manifest))
) STRICT;

CREATE TABLE assets(
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
  revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), sequence INTEGER NOT NULL REFERENCES events(sequence),
  supersedes TEXT REFERENCES assets(id), UNIQUE(entity_id,revision)
) STRICT;
CREATE INDEX assets_scope ON assets(scope,sequence);
CREATE INDEX assets_identity ON assets(scope,kind,key);
CREATE INDEX assets_heads ON assets(entity_id,sequence DESC);
CREATE TABLE assertions(
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL,
  revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), sequence INTEGER NOT NULL REFERENCES events(sequence),
  supersedes TEXT REFERENCES assertions(id), UNIQUE(entity_id,revision)
) STRICT;
CREATE INDEX assertions_subject ON assertions(subject_id,sequence);
CREATE INDEX assertions_heads ON assertions(entity_id,sequence DESC);
CREATE TABLE relations(
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
  sequence INTEGER NOT NULL REFERENCES events(sequence), supersedes TEXT REFERENCES relations(id), UNIQUE(entity_id,revision)
) STRICT;
CREATE INDEX relations_from ON relations(from_id,sequence);
CREATE INDEX relations_to ON relations(to_id,sequence);
CREATE INDEX relations_heads ON relations(entity_id,sequence DESC);
CREATE TABLE anchors(
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, asset_entity TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
  revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), sequence INTEGER NOT NULL REFERENCES events(sequence),
  supersedes TEXT REFERENCES anchors(id), UNIQUE(entity_id,revision)
) STRICT;
CREATE INDEX anchors_asset ON anchors(asset_entity,sequence);
CREATE INDEX anchors_heads ON anchors(entity_id,sequence DESC);
CREATE TABLE graph_provenance(
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, task_id TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES events(sequence),
  body TEXT NOT NULL CHECK(json_valid(body)), UNIQUE(revision_id,actor_id,task_id)
) STRICT;
CREATE INDEX graph_provenance_entity ON graph_provenance(entity_id,sequence);
PRAGMA user_version=${STATE_SCHEMA_VERSION};
`;

export const EVENT_KINDS = [
  'record.committed', 'run.started', 'run.paused', 'run.stopping', 'run.stopped',
  'worker.admitted', 'worker.runtime-verified', 'worker.revoked', 'worker.retired',
  'operation.requested', 'operation.started', 'operation.returned', 'operation.failed', 'operation.cancelled', 'operation.unknown-terminal',
  'task.created', 'task.queued', 'task.reserved', 'task.running', 'task.reported', 'task.reviewed', 'task.closed', 'task.blocked', 'task.cancelled', 'task.expired',
  'asset.upserted', 'assertion.revised', 'graph.observed', 'case.revised', 'review.committed', 'support.invalidated', 'coverage.revised', 'phase.committed',
  'checkpoint.committed', 'checkpoint.failed', 'artifact.retained', 'artifact.missing',
  'decision.committed', 'context.consumed', 'planner.admitted', 'planner.vetoed', 'limit.reached', 'cleanup.result', 'retention.failed',
  'run.held', 'run.released', 'delegate.unstructured', 'usage.reported',
] as const;
export type EventKind = typeof EVENT_KINDS[number];
