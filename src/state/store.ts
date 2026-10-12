import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { sha256Hex as sha, validId } from '../validate.js';
import { closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { PrivateDirectory } from './files.js';
import { EVENT_KINDS, STATE_SCHEMA, STATE_SCHEMA_VERSION, type EventKind } from './schema.js';
import { isOpenGap, isRecordKind, LEDGER_BYTES, LEDGER_RECORDS, retiredIds, type AssessmentRecord, type RecordAck } from '../records.js';
import { redact } from '../evidence.js';
import { cleanText } from '../process.js';
import { redactArtifactPrefix, redactScratchSegment, utf8Prefix } from '../artifacts.js';
import { validateWorkFields, workIdentity, type WorkTaskLike } from '../work.js';
import { phasePackets, planFrontier } from '../planning.js';
import { indexRecords } from '../records.js';
import { validateScratchSnapshot, type ScratchSnapshot } from '../scratch.js';
import { validateStoredCase } from '../case-types.js';
import { validateCoverageCellDraft, validateStoredCoverageCell, validateStoredCoveragePlan } from '../coverage-types.js';
import { caseViews, needsCaseReview, type CaseContext } from '../cases.js';
import { awaitingReview } from '../tasks.js';
import { coverageViews, type CoverageContext } from '../coverage.js';
import { describeKnowledgeRecord, KNOWLEDGE_DOMAINS, type KnowledgeIndexSnapshot, type ContextCursor, type ContextItem, type ContextPacket, type KnowledgeDomain, type KnowledgePage } from '../context.js';
import { anchorEntityId, assetEntityId, assertionEntityId, graphEntityId, relationEntityId, renderGraph, scopeOf, validateAnchor, validateAsset, validateFact, validateHypothesis, validateRelation,
  graphCanonical, graphObject, validateGraphBatch, GRAPH_IDENTITY_VERSION, GRAPH_ROW_BYTES, GRAPH_RESPONSE_BYTES, GRAPH_ENTITY_LIMIT, GRAPH_ASSERTION_LIMIT, GRAPH_RELATION_LIMIT, GRAPH_ANCHOR_ROWS, GRAPH_PROVENANCE_LIMIT,
  type AnchorInput, type GraphAck, type GraphBatch, type GraphProducer, type GraphRow, type GraphTable, type GraphSnapshot, type GraphObservation } from './graph.js';

export const DEFAULT_STORE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export interface StoreManifest {
  runId: string; retention: 'durable-local' | 'ephemeral'; targetKind: 'directory' | 'url';
  targetIdentity: string; targetDisplay: string;
  profile: { runtimeHash: string; image: string; loopMode: string; executorMode: string;
    maxWorkers?: number; maxDepth?: number; maxPlannerRounds?: number; maxTargetOperations?: number;
    totalCommandBudget?: number; storageQuotaMiB?: number; artifactCaptureKiB?: number };
  sourceSnapshotSha256?: string; sourceEntries?: number; sourceSkipped?: number;
}
export interface MutationRequest { actorId: string; requestId: string; payload: unknown }
export interface StateEvent {
  sequence: number; eventId: string; schemaVersion: number; runId: string; kind: EventKind;
  occurredAt: string; committedAt: string; actorId: string; taskId?: string; attemptId?: string;
  operationId?: string; correlationId?: string; entityId?: string; entityRevision?: number;
  summary: string; payloadRefs: string[]; redactionVersion: 1; data?: Record<string, unknown>;
}
export type EventDraft = Omit<StateEvent, 'sequence' | 'eventId' | 'schemaVersion' | 'runId' | 'committedAt' | 'redactionVersion' | 'payloadRefs'> & { payloadRefs?: string[] };
export interface StorePage<T> { rows: T[]; total: number; shown: number; omitted: number; asOfSequence: number; cursor: number; nextCursor?: number }
export interface ArtifactManifest {
  id: string; sequence: number; kind: string; mediaType: string; producer: string; operationId?: string;
  bytes: number; sha256: string; sensitivity: 'redacted'; redactionVersion: 1 | 2 | 3;
  totalBytes: number; capturedInputBytes: number; truncated: boolean; evidenceRefs: string[];
  beforeRedactionSha256?: string; hashScope?: 'captured-prefix-before-redaction' | 'preserved-exported-bytes';
  captureOutcome?: 'returned' | 'interrupted'; captureReason?: string; decodingLossy?: boolean; captureSource?: ScratchSnapshot;
  importedFrom?: { bundleSha256: string; file: string; sourceRunId: string; originalSha256: string };
}
export interface CheckpointManifest {
  id: string; schemaVersion: number; sourceRunId: string; targetIdentity: string; asOfSequence: number;
  createdAt: string; reason: string; snapshotSha256: string; snapshotBytes: number;
  integrityStatus: 'complete' | 'partial'; missingRefs: string[]; omissions: string[];
  pendingReviews: string[]; openGapIds: string[]; inFlightOperationIds: string[];
  artifacts: ArtifactManifest[]; retentionStatus: 'durable-local' | 'ephemeral';
  dataStatus?: 'complete' | 'partial'; capturePartialArtifactIds?: string[]; captureUnavailableEvidenceIds?: string[];
  graph?: { identityVersion:number; scope:string; sha256:string; heads:{assets:number;assertions:number;relations:number;anchors:number} };
  planning?:{goals:number;todo:number;decisions:number;phasePackets:number;pendingPhasePacketIds:string[]};
  review?:{cases:number;uniqueAcceptedFindings:number;duplicateCases:number;pendingCases:number;staleCases:number;coveragePlans:number;coverageCells:number;staleCoverageCells:number;discoveredUnplannedAssets:number};
  knowledge?:{version:1;sha256:string;heads:number;links:number;cursors:number};
}
export type StoreFault = (stage: 'before-commit' | 'after-commit' | 'artifact-published' | 'checkpoint-published') => void;
/** Retained for the final outcome/checkpoint only; never an increase of the confirmed quota. */
export const finalizationReserve = (maxBytes: number) => Math.max(256 * 1024, Math.min(4 * 1024 * 1024, Math.floor(maxBytes / 16)));
const safe = <T>(value: T): T => JSON.parse(JSON.stringify(value, (key, item) =>
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|secret|token|environment|tickets|socket)$/i.test(key) ? '[REDACTED]' : typeof item === 'string' ? redact(item) : item));
const canonical = (value: unknown): string => {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, normalize(v)])) : item;
  const result = JSON.stringify(normalize(value));
  if (result === undefined || Buffer.byteLength(result) > 128 * 1024) throw Error('Mutation payload exceeds 128 KiB');
  return result;
};

/** Host owner writer only. Persistence and writer locks do not constitute execution authority. */
export class AssessmentStore {
  private closed = false;
  private transaction = false;
  private readonly observers = new Set<(sequence: number) => void>();
  readonly schemaVersion: number;
  readonly compatible: boolean;
  private constructor(private readonly directory: PrivateDirectory, private readonly db: DatabaseSync,
    private readonly writerLock: DatabaseSync | undefined, readonly readOnly: boolean,
    readonly maxBytes: number, private readonly fault?: StoreFault) {
    this.schemaVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    this.compatible = this.schemaVersion === STATE_SCHEMA_VERSION;
  }
  get location(): string { return this.directory.displayPath; }
  /** Operator's private knowledge root; portable bundles/artifacts must stay outside it. */
  get stateRoot(): string { return dirname(this.directory.displayPath); }
  static create(root: string, manifest: StoreManifest, options: { maxBytes?: number; fault?: StoreFault } = {}): AssessmentStore {
    if (!validId(manifest.runId) || !['durable-local', 'ephemeral'].includes(manifest.retention)
      || !['directory', 'url'].includes(manifest.targetKind) || !manifest.targetIdentity || manifest.targetIdentity.length > 256
      || typeof manifest.targetDisplay !== 'string' || manifest.targetDisplay.length > 4096) throw Error('Invalid store manifest');
    const parent = PrivateDirectory.open(root, true);
    let directory: PrivateDirectory;
    try { directory = parent.child(manifest.runId, true); } finally { parent.close(); }
    let store: AssessmentStore | undefined;
    try {
      directory.createFile('assessment.sqlite'); directory.createFile('writer.lock');
      store = this.connect(directory, false, options.maxBytes ?? DEFAULT_STORE_BYTES, options.fault, true);
      store.db.exec('BEGIN IMMEDIATE');
      try {
        store.db.exec(STATE_SCHEMA);
        store.db.prepare('INSERT INTO metadata VALUES (?,?)').run('manifest', JSON.stringify(safe(manifest)));
        store.db.prepare('INSERT INTO metadata VALUES (?,?)').run('request-hmac-key', JSON.stringify(randomBytes(32).toString('hex')));
        store.db.exec('COMMIT');
      } catch (error) { try { store.db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ } throw error; }
      // Initialization is committed before publishing the handle. No migration/replay occurs here.
      return new AssessmentStore(directory, store.db, store.writerLock, false, store.maxBytes, options.fault);
    } catch (error) { if (store) store.close(); else directory.close(); throw error; }
  }
  /** Explicit host reopen. UI uses readOnly=true; writable reopen never reconstructs the Engine. */
  static open(root: string, runId: string, options: { readOnly?: boolean; maxBytes?: number; fault?: StoreFault } = {}): AssessmentStore {
    if (!validId(runId)) throw Error('Invalid run ID');
    const parent = PrivateDirectory.open(root);
    let directory: PrivateDirectory;
    try { directory = parent.child(runId); } finally { parent.close(); }
    try { return this.connect(directory, options.readOnly ?? true, options.maxBytes ?? DEFAULT_STORE_BYTES, options.fault); }
    catch (error) { directory.close(); throw error; }
  }
  private static connect(directory: PrivateDirectory, readOnly: boolean, maxBytes: number, fault?: StoreFault, initialize = false): AssessmentStore {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 8 * 1024 * 1024 || maxBytes > 1024 * 1024 * 1024) throw Error('Storage quota must be 8..1024 MiB');
    // DELETE journals are bounded by database pages. Do not silently open another journal policy.
    const usage = directory.usage();
    if (usage.bytes > maxBytes) throw Error('State exceeds storage quota');
    for (const name of ['assessment.sqlite', 'writer.lock']) { const fd = directory.file(name); closeSync(fd); }
    let lock: DatabaseSync | undefined, db: DatabaseSync | undefined;
    try {
      if (!readOnly) {
        lock = new DatabaseSync(directory.path('writer.lock'));
        lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
      }
      db = new DatabaseSync(directory.path('assessment.sqlite'), { readOnly, enableDoubleQuotedStringLiterals: false });
      db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0');
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (!readOnly && !initialize && version !== STATE_SCHEMA_VERSION) throw Error(`Unsupported state schema ${version}; inspect read-only, never migrate in place`);
      const journal = String(db.prepare('PRAGMA journal_mode').get()!.journal_mode);
      if (journal !== 'delete') throw Error('Unsupported state journal mode; expected DELETE');
      if (readOnly) db.exec('PRAGMA query_only=ON');
      else db.exec(`PRAGMA synchronous=FULL; PRAGMA max_page_count=${Math.floor(maxBytes / 3 / 4096)}; PRAGMA journal_size_limit=0`);
      return new AssessmentStore(directory, db, lock, readOnly, maxBytes, fault);
    } catch (error) { db?.close(); if (lock) { try { lock.exec('ROLLBACK'); } catch { /* OS releases any held lock on close. */ } lock.close(); } throw error; }
  }
  private gate(write = false): void {
    if (this.closed) throw Error('State store is closed');
    if (!this.compatible) throw Error(`Unsupported state schema ${this.schemaVersion}; historical metadata only`);
    if (write && this.readOnly) throw Error('Historical state is read-only; no active authority');
  }
  subscribe(observer: (sequence: number) => void): () => void { this.gate(); this.observers.add(observer); return () => { this.observers.delete(observer); }; }
  manifest(): StoreManifest { this.gate(); return JSON.parse(String(this.db.prepare("SELECT body FROM metadata WHERE key='manifest'").get()!.body)); }
  sealSource(sourceHashes: Record<string, string>, skipped: number): void {
    const entries = Object.entries(sourceHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.length > 20000 || entries.some(([path, hash]) => path.length > 4096 || !/^[a-f0-9]{64}$/.test(hash)) || !Number.isSafeInteger(skipped) || skipped < 0) throw Error('Invalid source snapshot metadata');
    const sourceSnapshotSha256 = sha(JSON.stringify(entries));
    this.atomically(() => {
      const prior=this.manifest();
      if(prior.sourceSnapshotSha256 && prior.sourceSnapshotSha256!==sourceSnapshotSha256)throw Error('Confirmed source snapshot cannot be changed in this run');
      if(this.graphCount('assets') && prior.sourceSnapshotSha256!==sourceSnapshotSha256)throw Error('Source identity cannot be changed after graph recording');
      const manifest = { ...prior, sourceSnapshotSha256, sourceEntries: entries.length, sourceSkipped: skipped };
      this.db.prepare("UPDATE metadata SET body=? WHERE key='manifest'").run(JSON.stringify(manifest));
      this.insertEvent({ kind: 'phase.committed', actorId: 'owner', occurredAt: new Date().toISOString(), summary: 'Bootstrap source snapshot verified; knowledge only',
        data: { sourceSnapshotSha256, sourceEntries: entries.length, sourceSkipped: skipped } });
    });
  }
  finalize(outcome: 'partial' | 'blocked' | 'cancelled' | 'incomplete', reason: string, resourceOutcome: 'cleaned' | 'unresolved'): void {
    // Outcome/run.stopped may consume the retained finalization reserve; ordinary writes may not.
    this.atomically(() => {
      const data = { assessmentOutcome: outcome, resourceOutcome, reason: redact(reason), at: new Date().toISOString() };
      this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('outcome', JSON.stringify(data));
      this.insertEvent({ kind: 'run.stopped', actorId: 'owner', occurredAt: data.at, summary: `Resources ${resourceOutcome}; assessment ${outcome}`, data });
    }, undefined, undefined, {finalization:true});
  }
  outcome(): Record<string, unknown> | undefined { this.gate(); const row = this.db.prepare("SELECT body FROM metadata WHERE key='outcome'").get(); return row ? JSON.parse(String(row.body)) : undefined; }
  /** Read-only summary of states that cannot have survived a process exit. Never resumes or rewrites them. */
  interruptedState() {
    this.gate();
    const records = this.records();
    const heads = new Map<string, AssessmentRecord>();
    for (const row of records) if (row.kind === 'task') heads.set(String((row.data?.task as Record<string, unknown>)?.id), row);
    const running = [...heads.values()].filter(row => ['reserved','running'].includes(String((row.data!.task as Record<string, unknown>).status)));
    const operations = new Map<string, StateEvent>();
    for (const row of this.db.prepare('SELECT sequence,body FROM events ORDER BY sequence').all()) {
      const event = { ...JSON.parse(String(row.body)), sequence: Number(row.sequence) } as StateEvent;
      if (event.operationId && event.kind.startsWith('operation.')) operations.set(event.operationId, event);
    }
    const latest = records.filter(row => row.kind === 'lifecycle' && row.data?.reconciliation).at(-1);
    return {
      asOfSequence: this.sequence(),
      runningTaskIds: running.map(row => String((row.data!.task as Record<string, unknown>).id)),
      runningTaskRevisions: running.map(row => Number((row.data!.task as Record<string, unknown>).revision)),
      unknownOperationIds: [...operations.values()].filter(row => ['operation.requested','operation.started','operation.unknown-terminal'].includes(row.kind)).map(row => row.operationId!),
      workerIds: [...new Set(records.map(row => row.workerId).filter((id): id is string => typeof id === 'string'))],
      pendingReviews: [...heads.values()].filter(row => awaitingReview(row.data!.task as Record<string, unknown>)).map(row => String((row.data!.task as Record<string, unknown>).id)),
      latestReconciliation: latest,
    };
  }
  /** Human-attributed knowledge record marking interrupted/unknown state. Writes no task status, ticket or authority. */
  reconcileInterruption(actorId = 'owner', reason = 'Human reconciliation'): AssessmentRecord {
    if (!validId(actorId) || typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw Error('Reconciliation needs a valid actor and a bounded reason');
    const state = this.interruptedState();
    const record: AssessmentRecord = { id: randomUUID(), runId: this.manifest().runId, at: new Date().toISOString(), by: actorId, kind: 'lifecycle',
      text: `Interruption reconciled @${state.asOfSequence}: ${state.runningTaskIds.length} non-terminal task(s) and ${state.unknownOperationIds.length} unknown/in-flight operation(s) labelled interrupted/unknown; no resume, no authority`,
      data: { reconciliation: { asOfSequence: state.asOfSequence, at: new Date().toISOString(), by: actorId, reason: redact(reason),
        runningTaskIds: state.runningTaskIds.slice(0,100), unknownOperationIds: state.unknownOperationIds.slice(0,100), workerIds: state.workerIds.slice(0,100),
        pendingReviews: state.pendingReviews.slice(0,100), authorityRestored: false, resume: false,
        note: 'Historical state is evidence of interruption, not live execution. Currentness/proof still require this run\'s own receipts.' } } };
    this.commitRecords([record]);
    return this.record(record.id!)!;
  }
  sequence(): number { this.gate(); return Number(this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM events').get()!.n); }
  health() {
    if (this.closed) throw Error('State store is closed');
    return { schemaVersion: this.schemaVersion, compatible: this.compatible, readOnly: this.readOnly,
      authorityRestored: false as const, ...this.directory.usage(), maxBytes: this.maxBytes, finalizationReserveBytes: finalizationReserve(this.maxBytes), journalMode: 'DELETE' as const };
  }
  /** Ordinary writes stop before this retained headroom so a final checkpoint/outcome can still commit. */
  private capacity(extraBytes = 0, finalization = false): void {
    const usage = this.directory.usage(), pages = Number(this.db.prepare('PRAGMA page_count').get()!.page_count);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    // Reserve a worst-case rollback journal plus bounded transaction/index growth.
    const growth = pages * pageSize + extraBytes + 256 * 1024;
    if (usage.files >= 4094) throw Error('Storage quota/backpressure reached');
    if (usage.bytes + growth + (finalization ? 0 : finalizationReserve(this.maxBytes)) > this.maxBytes) throw Error(finalization
      ? 'Storage quota reached during finalization; a complete final snapshot was not retained'
      : 'Storage quota/backpressure reached (finalization reserve retained)');
  }
  private atomically<T>(work: () => T, request?: MutationRequest, mutation?: unknown, options?: {finalization?:boolean}): T {
    this.gate(true);
    if (this.transaction) throw Error('Nested state transaction denied');
    let payloadHash: string | undefined;
    if (request) {
      if (!validId(request.actorId) || !validId(request.requestId)) throw Error('Invalid mutation request identity');
      const key = JSON.parse(String(this.db.prepare("SELECT body FROM metadata WHERE key='request-hmac-key'").get()!.body));
      payloadHash = createHmac('sha256', key).update(canonical({ submitted: request.payload, mutation })).digest('hex');
      const prior = this.db.prepare('SELECT payload_sha256,result FROM requests WHERE actor_id=? AND request_id=?').get(request.actorId, request.requestId);
      if (prior) { if (prior.payload_sha256 !== payloadHash) throw Error('IDEMPOTENCY_CONFLICT'); return JSON.parse(String(prior.result)); }
    }
    this.capacity(0,options?.finalization ?? false); this.db.exec('BEGIN IMMEDIATE'); this.transaction = true;
    let committed = false;
    try {
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw Error('State transaction must be synchronous');
      if (request) this.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?)').run(request.actorId, request.requestId, payloadHash!, JSON.stringify(result), this.sequence());
      this.fault?.('before-commit'); this.db.exec('COMMIT'); committed = true;
      const sequence = this.sequence();
      for (const observer of this.observers) { try { observer(sequence); } catch { /* Lost UI hints never undo/mask durable commit. */ } }
      this.fault?.('after-commit'); return result;
    } catch (error) { if (!committed) { try { this.db.exec('ROLLBACK'); } catch { /* SQLITE_FULL can roll back automatically. */ } } throw error; }
    finally { this.transaction = false; }
  }
  private insertEvent(input: EventDraft): StateEvent {
    if (!(EVENT_KINDS as readonly string[]).includes(input.kind) || !validId(input.actorId)
      || [input.taskId, input.attemptId, input.operationId, input.correlationId, input.entityId].some(id => id !== undefined && !validId(id))
      || (input.entityRevision !== undefined && (!Number.isSafeInteger(input.entityRevision) || input.entityRevision < 1))
      || typeof input.occurredAt !== 'string' || input.occurredAt.length > 64 || typeof input.summary !== 'string' || input.summary.length > 2000) throw Error('Invalid state event');
    const event = safe({ ...input, payloadRefs: input.payloadRefs ?? [], eventId: randomUUID(), schemaVersion: STATE_SCHEMA_VERSION,
      runId: this.manifest().runId, committedAt: new Date().toISOString(), redactionVersion: 1 as const });
    if (event.payloadRefs.length > 100 || event.payloadRefs.some(id => !validId(id)) || Buffer.byteLength(JSON.stringify(event)) > 16 * 1024) throw Error('State event exceeds bound');
    const sequence = Number(this.db.prepare(`INSERT INTO events(event_id,schema_version,run_id,kind,occurred_at,committed_at,actor_id,task_id,attempt_id,operation_id,correlation_id,entity_id,entity_revision,summary,body)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.eventId, event.schemaVersion, event.runId, event.kind, event.occurredAt, event.committedAt, event.actorId,
        event.taskId ?? null, event.attemptId ?? null, event.operationId ?? null, event.correlationId ?? null, event.entityId ?? null, event.entityRevision ?? null, event.summary, JSON.stringify(event)).lastInsertRowid);
    this.db.prepare('INSERT INTO outbox(sequence) VALUES (?)').run(sequence);
    return { ...event, sequence };
  }
  event(input: EventDraft, request?: MutationRequest): StateEvent { return this.atomically(() => this.insertEvent(input), request, { event: input }); }
  commitRecords(input: AssessmentRecord[], request?: MutationRequest): Array<RecordAck & { sequence: number; storeVersion: typeof STATE_SCHEMA_VERSION }> {
    return this.atomically(() => this.insertRecords(input, request), request, { records: input });
  }
  /** Host-generated IDs/timestamps are allocated only after idempotency lookup, never on replay. */
  commitGeneratedRecords(makeRecords: () => AssessmentRecord[], request: MutationRequest): Array<RecordAck & { sequence: number; storeVersion: typeof STATE_SCHEMA_VERSION }> {
    return this.atomically(() => this.insertRecords(makeRecords(), request), request, { kind: 'generated-record-packet' });
  }
  /** Read retained mutation result only. Never re-runs the builder/target or reconstructs authority. */
  mutationResult(request: MutationRequest, mutation: unknown): unknown | undefined {
    this.gate();
    if (!validId(request.actorId) || !validId(request.requestId)) throw Error('Invalid mutation request identity');
    const prior = this.db.prepare('SELECT payload_sha256,result FROM requests WHERE actor_id=? AND request_id=?').get(request.actorId,request.requestId);
    if (!prior) return;
    const key = JSON.parse(String(this.db.prepare("SELECT body FROM metadata WHERE key='request-hmac-key'").get()!.body));
    const hash = createHmac('sha256',key).update(canonical({submitted:request.payload,mutation})).digest('hex');
    if (prior.payload_sha256 !== hash) throw Error('IDEMPOTENCY_CONFLICT');
    return JSON.parse(String(prior.result));
  }
  generatedResult(request: MutationRequest): RecordAck[] | undefined {
    return this.mutationResult(request, { kind: 'generated-record-packet' }) as RecordAck[] | undefined;
  }
  /** Rebuildable hot-head/relevance index. Canonical record bytes remain the source of truth. */
  private indexKnowledge(row:AssessmentRecord,sequence:number):void{
    const descriptor=describeKnowledgeRecord(row),task=row.kind==='task'?row.data?.task as Record<string,unknown>|undefined:undefined;
    // A resolution may be carried by an otherwise unindexed observation/lifecycle record.
    for(const resolved of row.resolves??[]){this.db.prepare("UPDATE knowledge_heads SET status='resolved' WHERE domain='gap' AND entity_id=?").run(resolved);this.invalidateKnowledge(resolved,'gap');}
    if(!descriptor)return;const {domain,entityId,status,links}=descriptor;
    if(!row.id)throw Error('Knowledge-indexed record must have an ID');
    this.db.prepare(`INSERT INTO knowledge_heads(domain,entity_id,record_id,sequence,status,actor_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(domain,entity_id) DO UPDATE SET record_id=excluded.record_id,sequence=excluded.sequence,status=excluded.status,actor_id=excluded.actor_id`).run(domain,entityId,row.id,sequence,status,row.by);
    const insert=this.db.prepare('INSERT OR IGNORE INTO knowledge_links(record_id,relation,target_id) VALUES (?,?,?)');for(const [relation,target] of links)insert.run(row.id,relation,target);
    if(task){this.db.prepare(`UPDATE knowledge_heads SET status=? WHERE domain='phase' AND record_id IN
      (SELECT record_id FROM knowledge_links WHERE relation='task' AND target_id=?)`).run(['reviewed','closed'].includes(String(task.status))?'reviewed':String(task.status)==='reported'?'pending':String(task.status),String(task.id));}
    if(row.supersedes){if(row.kind==='candidate')this.invalidateKnowledge(row.supersedes,'claim');if(task)this.invalidateKnowledge(String(task.id),'task');if(domain==='case')this.invalidateKnowledge(entityId,'case');}
  }
  private invalidateKnowledge(targetId:string,relation:string):void{
    // UNION deduplicates cycles. Only current heads participate; cold revisions cannot hide a dependency.
    this.db.prepare(`WITH RECURSIVE affected(domain,entity_id,record_id) AS (
      SELECT h.domain,h.entity_id,h.record_id FROM knowledge_heads h JOIN knowledge_links l ON l.record_id=h.record_id
      WHERE l.target_id=? AND l.relation=? AND h.domain IN ('case','coverage-cell')
      UNION
      SELECT h.domain,h.entity_id,h.record_id FROM knowledge_heads h JOIN knowledge_links l ON l.record_id=h.record_id
      JOIN affected a ON l.target_id=a.entity_id AND l.relation=a.domain WHERE h.domain IN ('case','coverage-cell')
    ) UPDATE knowledge_heads SET status='stale' WHERE record_id IN (SELECT record_id FROM affected) AND status NOT IN ('withdrawn','retired')`).run(targetId,relation);
  }
  private insertRecords(input: AssessmentRecord[], request?: MutationRequest): Array<RecordAck & { sequence: number; storeVersion: typeof STATE_SCHEMA_VERSION }> {
    if (!input.length || input.length > 128) throw Error('Record packet must contain 1..128 records');
    const packetBytes = input.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
    this.capacity(packetBytes * 4 + input.length * 16 * 1024);
      const current = this.db.prepare('SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM records').get()!;
      if (Number(current.n) + input.length > LEDGER_RECORDS) throw Error('State record count exceeds 100000');
      let bytes = Number(current.bytes);
      return input.map(raw => {
        // Report parts are already redacted before framing/hashing by the host normalizer.
        // Redacting serialized fragments again could silently invalidate their hashes.
        const protectedPart = raw.kind === 'report_part' && raw.data?.redacted === true;
        const row = { ...(protectedPart ? raw : safe(raw)), runId: raw.runId ?? this.manifest().runId, version: 2 as const, id: raw.id ?? randomUUID() };
        const body = JSON.stringify(row); bytes += Buffer.byteLength(body) + 1;
        if (Buffer.byteLength(body) + 1 > 16 * 1024) throw Error('Record is too large');
        if (bytes > LEDGER_BYTES) throw Error('State record payload exceeds 64 MiB');
        if (!validId(row.id) || row.runId !== this.manifest().runId || !validId(row.by) || !isRecordKind(row.kind)
          || typeof row.at !== 'string' || row.at.length > 64 || typeof row.text !== 'string'
          || (row.data !== undefined && (!row.data || typeof row.data !== 'object' || Array.isArray(row.data)))
          || (row.refs !== undefined && (!Array.isArray(row.refs) || row.refs.some(v => typeof v !== 'string')))) throw Error('Invalid same-run state record');
        if (this.db.prepare('SELECT id FROM records WHERE id=?').get(row.id)) throw Error('Duplicate state record ID');
        const previous = row.supersedes ? this.record(row.supersedes) : undefined;
        if (row.supersedes && (!previous || previous.kind !== row.kind || (row.kind === 'candidate'
          && (previous.data?.candidate !== row.data?.candidate || previous.surface !== row.surface || previous.risk !== row.risk)))) throw Error('Invalid state revision');
        if (row.resolves && (!Array.isArray(row.resolves) || row.resolves.some(id => this.record(id)?.kind !== 'open'))) throw Error('Invalid state resolution');
        const task = row.kind === 'task' ? row.data?.task as Record<string, unknown> | undefined : undefined;
        if (row.kind === 'task') {
          const head = typeof task?.id === 'string' ? this.db.prepare("SELECT body FROM records WHERE kind='task' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(task.id) : undefined;
          const prior = head ? JSON.parse(String(head.body)) as AssessmentRecord : undefined;
          if (!task || row.by !== 'owner' || row.workerId || task.runId !== row.runId || typeof task.id !== 'string' || !validId(task.id)
            || !Array.isArray(task.prerequisites) || !['proposed','reserved','running','reported','reviewed','closed','blocked','cancelled','expired'].includes(String(task.status))
            || !Number.isSafeInteger(task.revision) || (prior ? row.supersedes !== prior.id || task.revision !== Number((prior.data!.task as Record<string, unknown>).revision) + 1 : task.revision !== 1)
            || Object.keys(task).some(key => ['deadline','scope','token','authority','target','permissions'].includes(key))) throw Error('Invalid owned task revision');
          validateWorkFields(task as unknown as WorkTaskLike);
          if ((task.workFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(String(task.workFingerprint)))||(task.workOverlapKey!==undefined&&!/^[a-f0-9]{64}$/.test(String(task.workOverlapKey)))
            ||(task.targetRevision!==undefined&&(typeof task.targetRevision!=='string'||task.targetRevision.length<1||task.targetRevision.length>160))
            ||(task.dedupConfidence!==undefined&&!['exact','unknown'].includes(String(task.dedupConfidence))))throw Error('Invalid host work identity');
          if(task.work){const targetRevision=this.graphScope(),identity=workIdentity(targetRevision,task as unknown as WorkTaskLike);
            if(task.targetRevision!==targetRevision||task.workFingerprint!==identity.fingerprint||task.workOverlapKey!==identity.overlapKey||task.dedupConfidence!==identity.confidence)throw Error('Work identity does not match the host target/source namespace');
            for(const ref of (task as unknown as WorkTaskLike).work!.assetRefs){const head=this.graphHead('assets',ref.id);if(!head||ref.revision!==undefined&&head.revision<ref.revision)throw Error('Unknown task asset/revision');
              if(ref.revision!==undefined&&['proposed','reserved','running'].includes(String(task.status))&&head.revision!==ref.revision)throw Error('STALE_WORK_REFERENCE: asset changed before atomic admission');}
          }
        }
        const plan=row.kind==='note'&&row.data?.plan&&typeof row.data.plan==='object'&&!Array.isArray(row.data.plan)?row.data.plan as Record<string,unknown>:undefined;
        const phase=row.kind==='note'&&row.data?.phase&&typeof row.data.phase==='object'&&!Array.isArray(row.data.phase)?row.data.phase as Record<string,unknown>:undefined;
        const caseData=row.kind==='note'&&row.data?.case&&typeof row.data.case==='object'&&!Array.isArray(row.data.case)?row.data.case:undefined;
        const coveragePlanData=row.kind==='note'&&row.data?.coveragePlan&&typeof row.data.coveragePlan==='object'&&!Array.isArray(row.data.coveragePlan)?row.data.coveragePlan:undefined;
        const coverageCellData=row.kind==='note'&&row.data?.coverageCell&&typeof row.data.coverageCell==='object'&&!Array.isArray(row.data.coverageCell)?row.data.coverageCell:undefined;
        const caseEntry=caseData?validateStoredCase(caseData,row.id):undefined,coveragePlan=coveragePlanData?validateStoredCoveragePlan(coveragePlanData,row.id):undefined,coverageCell=coverageCellData?validateStoredCoverageCell(coverageCellData,row.id):undefined;
        if(plan){const head=typeof plan.id==='string'?this.db.prepare("SELECT body FROM records WHERE kind='note' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(plan.id):undefined,
          prior=head?JSON.parse(String(head.body)) as AssessmentRecord:undefined;
          if(row.by!=='owner'||row.workerId||plan.runId!==row.runId||typeof plan.id!=='string'||!validId(plan.id)||!['goal','todo','decision'].includes(String(plan.kind))||!Number.isSafeInteger(plan.revision)
            ||(prior?row.supersedes!==prior.id||plan.revision!==Number((prior.data!.plan as Record<string,unknown>).revision)+1:plan.revision!==1))throw Error('Invalid owned plan revision');
        }
        if(phase&&(row.by!=='owner'||row.workerId||phase.id!==row.id||phase.version!==1||typeof phase.taskId!=='string'||!validId(phase.taskId)||!['reported','blocked'].includes(String(phase.delivery))||phase.reviewStatus!=='pending'))throw Error('Invalid phase packet');
        if(caseEntry){const head=this.db.prepare("SELECT body FROM records WHERE kind='note' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(caseEntry.id),prior=head?JSON.parse(String(head.body)) as AssessmentRecord:undefined,priorCase=prior?.data?.case as Record<string,unknown>|undefined;
          if(row.by!=='owner'||row.workerId||caseEntry.runId!==row.runId||(prior?row.supersedes!==prior.id||caseEntry.revision!==Number(priorCase?.revision)+1:row.supersedes!==undefined||caseEntry.revision!==1))throw Error('Invalid owned case revision');}
        if(coveragePlan){const head=this.db.prepare("SELECT body FROM records WHERE kind='note' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(coveragePlan.id),prior=head?JSON.parse(String(head.body)) as AssessmentRecord:undefined,priorPlan=prior?.data?.coveragePlan as Record<string,unknown>|undefined;
          if(row.by!=='owner'||row.workerId||coveragePlan.runId!==row.runId||coveragePlan.targetRevision!==this.graphScope()||(prior?row.supersedes!==prior.id||coveragePlan.revision!==Number(priorPlan?.revision)+1:row.supersedes!==undefined||coveragePlan.revision!==1))throw Error('Invalid owned coverage plan revision');}
        if(coverageCell){const head=this.db.prepare("SELECT body FROM records WHERE kind='note' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(coverageCell.id),prior=head?JSON.parse(String(head.body)) as AssessmentRecord:undefined,priorCell=prior?.data?.coverageCell as Record<string,unknown>|undefined,
          planHead=this.db.prepare("SELECT body FROM records WHERE kind='note' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(coverageCell.planId),planRecord=planHead?JSON.parse(String(planHead.body)) as AssessmentRecord:undefined,planValue=planRecord?.data?.coveragePlan as Record<string,unknown>|undefined,
          {runId:_run,revision:_revision,recordId:_record,planId:_plan,planRevision:_planRevision,targetRevision:_target,fingerprint:_fingerprint,retired:_retired,...coverageDraft}=coverageCell,model=validateCoverageCellDraft(coverageDraft),fingerprint=sha(graphCanonical({version:1,targetRevision:coverageCell.targetRevision,assetRef:model.assetRef,questionKey:model.questionKey,policyKey:model.policyKey??null,actorContext:model.actorContext,tenantContext:model.tenantContext,methodFamily:model.methodFamily}));
          if(row.by!=='owner'||row.workerId||coverageCell.runId!==row.runId||coverageCell.targetRevision!==this.graphScope()||coverageCell.fingerprint!==fingerprint||Number(planValue?.revision)!==coverageCell.planRevision
            ||!Array.isArray(planValue?.cellIds)||(coverageCell.retired?(planValue!.cellIds as unknown[]).includes(coverageCell.id):!(planValue!.cellIds as unknown[]).includes(coverageCell.id))
            ||(prior?row.supersedes!==prior.id||coverageCell.revision!==Number(priorCell?.revision)+1:row.supersedes!==undefined||coverageCell.revision!==1))throw Error('Invalid owned coverage cell revision');}
        const eventKind=task?`task.${task.status === 'proposed' ? 'created' : task.status}` as EventKind:phase?'phase.committed':coveragePlan||coverageCell?'coverage.revised':caseEntry?(caseEntry.reviewStatus==='pending'?'case.revised':'review.committed'):plan?.kind==='decision'?'decision.committed':'record.committed';
        const event = this.insertEvent({ kind: eventKind,
          actorId: row.by, correlationId:request?.requestId, entityId: row.id, entityRevision: Number(task?.revision??caseEntry?.revision??coveragePlan?.revision??coverageCell?.revision) || undefined, taskId: task?.id as string | undefined,
          occurredAt: row.at, summary: cleanText(row.text).slice(0, 2000), payloadRefs: [row.id] });
        this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)').run(row.id, event.sequence, row.kind, row.by,
          typeof task?.id === 'string' ? task.id : typeof plan?.id==='string'?plan.id:typeof phase?.id==='string'?phase.id:coveragePlan?.id??coverageCell?.id??caseEntry?.id??(typeof row.data?.candidate === 'string' ? row.data.candidate : null), row.supersedes ?? null, body, Buffer.byteLength(body) + 1);
        this.indexKnowledge(row,event.sequence);
        if(row.kind==='candidate'&&row.supersedes){const where="h.domain='case' AND h.record_id IN (SELECT record_id FROM knowledge_links WHERE target_id=? AND relation='claim')",affected=this.db.prepare(`SELECT h.record_id FROM knowledge_heads h WHERE ${where} ORDER BY h.sequence LIMIT 99`).all(row.supersedes),total=Number(this.db.prepare(`SELECT count(*) AS n FROM knowledge_heads h WHERE ${where}`).get(row.supersedes)!.n);
          if(total)this.insertEvent({kind:'support.invalidated',actorId:row.by,entityId:row.id,occurredAt:row.at,summary:`Candidate revision invalidated ${total} reviewed case support pin(s); re-review required`,payloadRefs:[row.id,...affected.map(item=>String(item.record_id))],data:{affected:total,shown:affected.length,omitted:total-affected.length}});}
        if(task){const taskId=String(task.id),status=String(task.status),fingerprint=typeof task.workFingerprint==='string'?task.workFingerprint:undefined;
          this.db.prepare('UPDATE work_history SET current=0 WHERE task_id=? AND current=1').run(taskId);this.db.prepare('DELETE FROM work_reservations WHERE task_id=?').run(taskId);
          if(fingerprint){const result=status==='closed'&&typeof task.reviewReason==='string'&&Array.isArray(task.evidenceIds)&&task.evidenceIds.length?'reusable':['blocked','reported','cancelled','expired'].includes(status)?'partial':'none';
            this.db.prepare('INSERT INTO work_history VALUES (?,?,?,?,?,?,?,?,?,?)').run(event.sequence,row.id,taskId,Number(task.revision),fingerprint,String(task.targetRevision),typeof task.workOverlapKey==='string'?task.workOverlapKey:null,status,1,result);
            if(['reserved','running','reported','reviewed'].includes(status))try{this.db.prepare('INSERT INTO work_reservations VALUES (?,?,?,?)').run(fingerprint,taskId,Number(task.revision),event.sequence);}
            catch(error){if(String(error).includes('UNIQUE constraint failed'))throw Error('ASSIGNMENT_CONFLICT: exact work fingerprint already reserved');throw error;}
          }
        }
        return { recordId: row.id, version: 2 as const, sequence: event.sequence, storeVersion: STATE_SCHEMA_VERSION };
      });
  }
  record(id: string): AssessmentRecord | undefined {
    this.gate(); const row = this.db.prepare('SELECT body FROM records WHERE id=?').get(id); return row ? JSON.parse(String(row.body)) : undefined;
  }
  records(): AssessmentRecord[] { this.gate(); return this.db.prepare('SELECT body FROM records ORDER BY sequence').all().map(row => JSON.parse(String(row.body))); }
  /** Read-only, bounded page of rows committed after a record sequence, for append-only projections; never a write path. */
  recordsSince(sequence: number, limit = 2000): Array<{ sequence: number; record: AssessmentRecord }> {
    this.gate();
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw Error('Invalid record page request');
    return this.db.prepare('SELECT sequence, body FROM records WHERE sequence > ? ORDER BY sequence LIMIT ?').all(sequence, limit).map(row => ({ sequence: Number(row.sequence), record: JSON.parse(String(row.body)) }));
  }
  private workPage(column:'fingerprint'|'overlap_key',value:string,limit=20){
    this.gate();if(!/^[a-f0-9]{64}$/.test(value)||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid work-history query');
    const where=`${column}=?`,counts=this.db.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN current=1 AND status IN ('proposed','reserved','running','reported','reviewed') THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN current=1 AND result='reusable' THEN 1 ELSE 0 END) AS reusable,sum(CASE WHEN current=1 AND result='partial' THEN 1 ELSE 0 END) AS partial FROM work_history WHERE ${where}`).get(value)!;
    const heads=Number(this.db.prepare(`SELECT count(*) AS n FROM work_history WHERE ${where} AND current=1`).get(value)!.n);
    const rows=this.db.prepare(`SELECT sequence,record_id,task_id,task_revision,fingerprint,target_revision,overlap_key,status,current,result FROM work_history WHERE ${where} AND current=1
      ORDER BY CASE WHEN status IN ('proposed','reserved','running','reported','reviewed') THEN 0 WHEN result='reusable' THEN 1 WHEN result='partial' THEN 2 ELSE 3 END,sequence DESC LIMIT ?`).all(value,limit).map(row=>({
      sequence:Number(row.sequence),recordId:String(row.record_id),taskId:String(row.task_id),taskRevision:Number(row.task_revision),fingerprint:String(row.fingerprint),targetRevision:String(row.target_revision),
      ...(row.overlap_key?{overlapKey:String(row.overlap_key)}:{}),status:String(row.status),current:Boolean(row.current),result:String(row.result) as 'none'|'partial'|'reusable'}));
    const total=Number(counts.total);return {rows,total,heads,active:Number(counts.active??0),reusable:Number(counts.reusable??0),partial:Number(counts.partial??0),omitted:Math.max(0,heads-rows.length)};
  }
  workHistory(fingerprint:string,limit=20){return this.workPage('fingerprint',fingerprint,limit);}
  workOverlap(overlapKey:string,limit=20){return this.workPage('overlap_key',overlapKey,limit);}
  private knowledgeItem(raw:Record<string,SQLInputValue>):ContextItem{
    const record=this.record(String(raw.record_id));if(!record)throw Error('Knowledge index references a missing record');const domain=String(raw.domain) as KnowledgeDomain,status=String(raw.status),detail:Record<string,unknown>={};
    const task=record.data?.task as Record<string,unknown>|undefined,plan=record.data?.plan as Record<string,unknown>|undefined,caseEntry=record.data?.case as Record<string,unknown>|undefined,coveragePlan=record.data?.coveragePlan as Record<string,unknown>|undefined,coverageCell=record.data?.coverageCell as Record<string,unknown>|undefined;
    if(task)Object.assign(detail,{revision:task.revision,status:task.status,role:task.role,assignee:task.assignee,question:cleanText(String(task.question??'')).slice(0,300),phasePacketId:task.phasePacketId,dedupConfidence:task.dedupConfidence,assetRefs:(task.work as Record<string,unknown>|undefined)?.assetRefs,prerequisites:task.prerequisites});
    else if(plan)Object.assign(detail,{revision:plan.revision,kind:plan.kind,status:plan.status,title:cleanText(String(plan.title??'')).slice(0,240),taskIds:(plan.taskIds as unknown[]|undefined)?.slice(0,10),goalIds:(plan.goalIds as unknown[]|undefined)?.slice(0,10)});
    else if(caseEntry)Object.assign(detail,{revision:caseEntry.revision,verdict:caseEntry.verdict,reviewStatus:caseEntry.reviewStatus,title:cleanText(String(caseEntry.title??'')).slice(0,240),duplicateOf:caseEntry.duplicateOf,claimRefs:(caseEntry.claimRefs as unknown[]|undefined)?.slice(0,10),assetRefs:(caseEntry.assetRefs as unknown[]|undefined)?.slice(0,10)});
    else if(coveragePlan)Object.assign(detail,{revision:coveragePlan.revision,status:coveragePlan.status,title:cleanText(String(coveragePlan.title??'')).slice(0,240),cells:(coveragePlan.cellIds as unknown[]|undefined)?.length??0,unknownScope:(coveragePlan.unknownScope as unknown[]|undefined)?.slice(0,10)});
    else if(coverageCell)Object.assign(detail,{revision:coverageCell.revision,execution:coverageCell.execution,assessment:coverageCell.assessment,assetRef:coverageCell.assetRef,questionKey:coverageCell.questionKey,planId:coverageCell.planId,retired:coverageCell.retired});
    else if(domain==='candidate')Object.assign(detail,{candidate:record.data?.candidate,closure:record.data?.closure,execution:record.data?.execution,proof:record.data?.proof,surface:record.surface,risk:record.risk});
    else if(domain==='phase')Object.assign(detail,{delivery:record.data?.phase&&((record.data.phase as Record<string,unknown>).delivery),taskId:record.data?.phase&&((record.data.phase as Record<string,unknown>).taskId)});
    return {domain,entityId:String(raw.entity_id),recordId:String(raw.record_id),sequence:Number(raw.sequence),status,actorId:String(raw.actor_id),summary:cleanText(record.text).slice(0,400),refs:(record.refs??[]).slice(0,10),detail};
  }
  knowledgePage(options:{domain?:KnowledgeDomain;status?:string;cursor?:number;limit?:number}={}):KnowledgePage{
    this.gate();const cursor=options.cursor??0,limit=options.limit??20;if(options.domain!==undefined&&!(KNOWLEDGE_DOMAINS as readonly string[]).includes(options.domain)||!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>100||options.status!==undefined&&(typeof options.status!=='string'||options.status.length>80))throw Error('Invalid knowledge-head query');
    const where=['sequence>?'],params:SQLInputValue[]=[cursor];if(options.domain){where.push('domain=?');params.push(options.domain);}if(options.status){where.push('status=?');params.push(options.status);}const clause=where.join(' AND '),total=Number(this.db.prepare(`SELECT count(*) AS n FROM knowledge_heads WHERE ${clause}`).get(...params)!.n),candidates=this.db.prepare(`SELECT * FROM knowledge_heads WHERE ${clause} ORDER BY sequence,domain,entity_id LIMIT ?`).all(...params,limit).map(row=>this.knowledgeItem(row)),rows:ContextItem[]=[];let bytes=0;
    for(const row of candidates){const size=Buffer.byteLength(JSON.stringify(row));if(bytes+size>48*1024)break;rows.push(row);bytes+=size;}const next=rows.at(-1)?.sequence;
    return {rows,total,shown:rows.length,omitted:Math.max(0,total-rows.length),cursor,asOfSequence:this.sequence(),...(next!==undefined&&rows.length<total?{nextCursor:next}:{})};
  }
  knowledgeRecord(domain:KnowledgeDomain,entityId:string):AssessmentRecord|undefined{
    this.gate();if(!(KNOWLEDGE_DOMAINS as readonly string[]).includes(domain)||!validId(entityId))throw Error('Invalid knowledge-head identity');
    const row=this.db.prepare('SELECT record_id FROM knowledge_heads WHERE domain=? AND entity_id=?').get(domain,entityId);return row?this.record(String(row.record_id)):undefined;
  }
  /** Explicit checkpoint/audit snapshot only. Normal UI/context reads never materialize this index. */
  knowledgeIndex():KnowledgeIndexSnapshot{
    this.gate();const heads=this.db.prepare('SELECT * FROM knowledge_heads ORDER BY domain,entity_id').all().map(row=>({domain:String(row.domain) as KnowledgeDomain,entityId:String(row.entity_id),recordId:String(row.record_id),sequence:Number(row.sequence),status:String(row.status),actorId:String(row.actor_id)})),
      links=this.db.prepare('SELECT l.* FROM knowledge_links l JOIN knowledge_heads h ON h.record_id=l.record_id ORDER BY l.record_id,l.relation,l.target_id').all().map(row=>({recordId:String(row.record_id),relation:String(row.relation),targetId:String(row.target_id)})),
      cursors=this.db.prepare('SELECT consumer_id FROM context_cursors ORDER BY consumer_id').all().map(row=>this.contextCursor(String(row.consumer_id))!);
    return {version:1,runId:this.manifest().runId,asOfSequence:this.sequence(),heads,links,cursors,authorityRestored:false};
  }
  contextCursor(consumerId:string):ContextCursor|undefined{
    this.gate();if(!validId(consumerId))throw Error('Invalid context consumer');const row=this.db.prepare('SELECT * FROM context_cursors WHERE consumer_id=?').get(consumerId);return row?{consumerId,throughSequence:Number(row.through_sequence),gapThrough:Number(row.gap_through),reviewThrough:Number(row.review_through),packetSha256:String(row.packet_sha256),eventSequence:Number(row.event_sequence)}:undefined;
  }
  /** Deterministic indexed packet. Building is read-only; response delivery is ACKed separately, never proof review. */
  contextPacket(options:{consumerId:string;role:'planner'|'worker'|'reporting';taskId?:string;maxBytes?:number}):ContextPacket{
    this.gate();if(!validId(options.consumerId)||!['planner','worker','reporting'].includes(options.role)||options.taskId!==undefined&&!validId(options.taskId)||options.role!=='planner'&&!options.taskId)throw Error('Invalid context packet request');const maxBytes=options.maxBytes??20*1024;if(!Number.isInteger(maxBytes)||maxBytes<4096||maxBytes>48*1024)throw Error('Context packet bound must be 4..48 KiB');
    const barrier=this.sequence(),prior=this.contextCursor(options.consumerId),before={throughSequence:prior?.throughSequence??0,gapThrough:prior?.gapThrough??0,reviewThrough:prior?.reviewThrough??0},headCount=Number(this.db.prepare('SELECT count(*) AS n FROM knowledge_heads').get()!.n),recordCount=Number(this.db.prepare('SELECT count(*) AS n FROM records').get()!.n),openGaps=Number(this.db.prepare("SELECT count(*) AS n FROM knowledge_heads WHERE domain='gap' AND status='open'").get()!.n),reviewWhere="(domain='case' AND status IN ('pending','disputed','stale')) OR (domain='task' AND status IN ('reported','blocked')) OR (domain='phase' AND status='pending') OR (domain='coverage-cell' AND status='stale')",pendingReviews=Number(this.db.prepare(`SELECT count(*) AS n FROM knowledge_heads WHERE ${reviewWhere}`).get()!.n),eventsAfter=Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE sequence>? AND sequence<=? AND kind<>'context.consumed'").get(before.throughSequence,barrier)!.n);
    const changeRows=this.db.prepare("SELECT sequence,kind,actor_id,task_id,entity_id,summary,body FROM events WHERE sequence>? AND sequence<=? AND kind<>'context.consumed' ORDER BY sequence LIMIT 21").all(before.throughSequence,barrier),changes=changeRows.slice(0,20).map(row=>{const body=JSON.parse(String(row.body)) as StateEvent;return {sequence:Number(row.sequence),kind:String(row.kind),actorId:String(row.actor_id),...(row.task_id?{taskId:String(row.task_id)}:{}),...(row.entity_id?{entityId:String(row.entity_id)}:{}),summary:cleanText(String(row.summary)).slice(0,300),payloadRefs:body.payloadRefs.slice(0,20)};});
    const queryItems=(sql:string,...params:SQLInputValue[])=>this.db.prepare(sql).all(...params).map(row=>this.knowledgeItem(row)),attentionAll=queryItems(`SELECT * FROM knowledge_heads WHERE domain='gap' AND status='open' OR ${reviewWhere} ORDER BY sequence LIMIT 11`),attention=attentionAll.slice(0,10),gapAll=queryItems("SELECT * FROM knowledge_heads WHERE domain='gap' AND status='open' AND sequence>? ORDER BY sequence LIMIT 11",before.gapThrough),newGaps=gapAll.slice(0,10),reviewAll=queryItems(`SELECT * FROM knowledge_heads WHERE (${reviewWhere}) AND sequence>? ORDER BY sequence LIMIT 11`,before.reviewThrough),newReviews=reviewAll.slice(0,10);
    // Rotate unresolved heads after reaching the end. A cursor is delivery, never resolution.
    if(!newGaps.length&&openGaps)newGaps.push(...queryItems("SELECT * FROM knowledge_heads WHERE domain='gap' AND status='open' ORDER BY sequence LIMIT 10"));
    if(!newReviews.length&&pendingReviews)newReviews.push(...queryItems(`SELECT * FROM knowledge_heads WHERE ${reviewWhere} ORDER BY sequence LIMIT 10`));
    let relevantWhere:string,relevantParams:SQLInputValue[]=[];
    if(options.role==='worker'&&options.taskId){relevantWhere=`(h.domain='task' AND h.entity_id=?) OR h.actor_id=? OR h.record_id IN (SELECT l.record_id FROM knowledge_links l WHERE l.target_id=?) OR h.entity_id IN (SELECT l.target_id FROM knowledge_links l JOIN knowledge_heads t ON t.record_id=l.record_id WHERE t.domain='task' AND t.entity_id=?) OR h.record_id IN (SELECT l.target_id FROM knowledge_links l JOIN knowledge_heads t ON t.record_id=l.record_id WHERE t.domain='task' AND t.entity_id=?)`;relevantParams=[options.taskId,options.consumerId,options.taskId,options.taskId,options.taskId];}
    else {const domains=options.role==='reporting'?"'case','coverage-plan','coverage-cell','report','gap'":"'goal','todo','decision','task','case','coverage-plan','coverage-cell','candidate','gap','phase'";relevantWhere=`h.domain IN (${domains})`;}
    const relevantAll=queryItems(`SELECT h.* FROM knowledge_heads h WHERE ${relevantWhere} ORDER BY CASE WHEN status IN ('stale','pending','disputed','reported','blocked','open') THEN 0 ELSE 1 END,h.sequence DESC LIMIT 20`,...relevantParams),relevantTotal=Number(this.db.prepare(`SELECT count(*) AS n FROM knowledge_heads h WHERE ${relevantWhere}`).get(...relevantParams)!.n),relevant=relevantAll,omissions={changes:Math.max(0,eventsAfter-changes.length),attention:Math.max(0,openGaps+pendingReviews-attention.length),newGaps:Math.max(0,openGaps-newGaps.length),newReviews:Math.max(0,pendingReviews-newReviews.length),relevant:Math.max(0,relevantTotal-relevant.length)};
    const packetBase={version:1 as const,runId:this.manifest().runId,consumerId:options.consumerId,role:options.role,...(options.taskId?{taskId:options.taskId}:{}),asOfSequence:barrier,cursorBefore:before,cursorAfter:{throughSequence:omissions.changes?changes.at(-1)?.sequence??before.throughSequence:barrier,gapThrough:newGaps.at(-1)?.sequence??0,reviewThrough:newReviews.at(-1)?.sequence??0},counts:{heads:headCount,coldRecords:Math.max(0,recordCount-headCount),openGaps,pendingReviews,eventsAfterCursor:eventsAfter},changes,attention,newGaps,newReviews,relevant,omissions,retrieval:{headsCursor:0,eventCursor:before.throughSequence,commands:['p2o_state action=heads domain/status/cursor/limit','p2o_ledger by exact record ID','p2o_graph by asset ID','p2o_case/p2o_coverage view by ID']},warning:'Indexed navigation packet only; omissions/counts are explicit. Knowledge never grants scope, restores authority, proves a finding or completes a goal.'};
    const arrays=['relevant','changes','newReviews','attention','newGaps'] as const,budget=maxBytes-160;let encoded=Buffer.byteLength(JSON.stringify(packetBase));for(const key of arrays)while(encoded>budget&&packetBase[key].length){packetBase[key].pop();packetBase.omissions[key==='changes'?'changes':key]=(packetBase.omissions[key==='changes'?'changes':key]??0)+1;if(key==='changes')packetBase.cursorAfter.throughSequence=packetBase.changes.at(-1)?.sequence??before.throughSequence;if(key==='newReviews')packetBase.cursorAfter.reviewThrough=packetBase.newReviews.at(-1)?.sequence??before.reviewThrough;if(key==='newGaps')packetBase.cursorAfter.gapThrough=packetBase.newGaps.at(-1)?.sequence??before.gapThrough;encoded=Buffer.byteLength(JSON.stringify(packetBase));}
    if(encoded>budget)throw Error('Context packet minimum safety sections exceed configured bound');const packetSha256=sha(graphCanonical(packetBase)),packet={...packetBase,packetSha256,encodedBytes:0};
    for(let i=0;i<3;i++)packet.encodedBytes=Buffer.byteLength(JSON.stringify(packet));
    if(Buffer.byteLength(JSON.stringify(packet))!==packet.encodedBytes||packet.encodedBytes>maxBytes)throw Error('Context packet encoded bound exceeded');return packet;
  }
  acknowledgeContext(packet:ContextPacket):ContextCursor{
    this.gate();const {packetSha256,encodedBytes:_,...base}=packet;if(packet.version!==1||packet.runId!==this.manifest().runId||!validId(packet.consumerId)||!['planner','worker','reporting'].includes(packet.role)||packetSha256!==sha(graphCanonical(base))||packet.encodedBytes!==Buffer.byteLength(JSON.stringify(packet))||packet.encodedBytes>48*1024||!Number.isSafeInteger(packet.asOfSequence)||packet.asOfSequence>this.sequence()||Object.values(packet.cursorAfter).some(value=>!Number.isSafeInteger(value)||value<0||value>packet.asOfSequence)||packet.cursorAfter.throughSequence<packet.cursorBefore.throughSequence)throw Error('Invalid context packet receipt');const request:MutationRequest={actorId:'owner',requestId:`context-${packetSha256.slice(0,40)}`,payload:{consumerId:packet.consumerId,packetSha256,cursorBefore:packet.cursorBefore,cursorAfter:packet.cursorAfter}};
    return this.atomically(()=>{const current=this.contextCursor(packet.consumerId),actual={throughSequence:current?.throughSequence??0,gapThrough:current?.gapThrough??0,reviewThrough:current?.reviewThrough??0};if(graphCanonical(actual)!==graphCanonical(packet.cursorBefore))throw Error('STALE_CONTEXT_PACKET: a newer packet was already consumed');const body={version:1,consumerId:packet.consumerId,role:packet.role,taskId:packet.taskId,asOfSequence:packet.asOfSequence,counts:packet.counts,omissions:packet.omissions,cursorAfter:packet.cursorAfter,packetSha256,authorityRestored:false,proofReviewed:false},event=this.insertEvent({kind:'context.consumed',actorId:'owner',occurredAt:new Date().toISOString(),summary:`Context delivery ${packetSha256.slice(0,12)} to ${packet.consumerId} through ${packet.cursorAfter.throughSequence}; not proof review`,payloadRefs:[],data:{context:body}});this.db.prepare(`INSERT INTO context_cursors VALUES (?,?,?,?,?,?,?) ON CONFLICT(consumer_id) DO UPDATE SET through_sequence=excluded.through_sequence,gap_through=excluded.gap_through,review_through=excluded.review_through,packet_sha256=excluded.packet_sha256,event_sequence=excluded.event_sequence,body=excluded.body`).run(packet.consumerId,packet.cursorAfter.throughSequence,packet.cursorAfter.gapThrough,packet.cursorAfter.reviewThrough,packetSha256,event.sequence,JSON.stringify(body));return {consumerId:packet.consumerId,throughSequence:packet.cursorAfter.throughSequence,gapThrough:packet.cursorAfter.gapThrough,reviewThrough:packet.cursorAfter.reviewThrough,packetSha256,eventSequence:event.sequence};},request,{context:{consumerId:packet.consumerId,packetSha256,cursorAfter:packet.cursorAfter}});
  }
  events(options: { since?: number; until?: number; limit?: number; actorId?: string; taskId?: string; operationId?: string; tail?: boolean } = {}): StorePage<StateEvent> {
    this.gate(); const asOfSequence = options.until ?? this.sequence(), cursor = options.since ?? 0, limit = options.limit ?? 20;
    if (![asOfSequence, cursor, limit].every(Number.isSafeInteger) || cursor < 0 || asOfSequence < cursor || asOfSequence > this.sequence() || limit < 1 || limit > 100) throw Error('Invalid state event cursor/limit');
    const conditions = ['sequence>?', 'sequence<=?'], values: SQLInputValue[] = [cursor, asOfSequence];
    for (const [column, value] of [['actor_id', options.actorId], ['task_id', options.taskId], ['operation_id', options.operationId]]) if (value !== undefined) { if (!validId(value)) throw Error('Invalid event filter'); conditions.push(`${column}=?`); values.push(value); }
    const where = conditions.join(' AND '), total = Number(this.db.prepare(`SELECT count(*) AS n FROM events WHERE ${where}`).get(...values)!.n);
    // `tail` returns the newest matching events (still oldest-first) so a filtered view can open on recent activity; it never pages forward.
    const tail = options.tail === true;
    const selected = tail
      ? this.db.prepare(`SELECT sequence,body FROM (SELECT sequence,body FROM events WHERE ${where} ORDER BY sequence DESC LIMIT ?) ORDER BY sequence`).all(...values, limit)
      : this.db.prepare(`SELECT sequence,body FROM events WHERE ${where} ORDER BY sequence LIMIT ?`).all(...values, limit);
    const rows: StateEvent[] = []; let bytes = 0;
    for (const row of tail ? [...selected].reverse() : selected) { bytes += Buffer.byteLength(String(row.body)); if (bytes > 48 * 1024) break; rows.push({ ...JSON.parse(String(row.body)), sequence: Number(row.sequence) }); }
    if (tail) rows.reverse();
    return { rows, total, shown: rows.length, omitted: total - rows.length, cursor, asOfSequence,
      ...(!tail && rows.length < total && rows.length ? { nextCursor: rows.at(-1)!.sequence } : {}) };
  }
  outbox(since = 0, limit = 100): number[] {
    this.gate(); if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid outbox cursor/limit');
    return this.db.prepare('SELECT sequence FROM outbox WHERE sequence>? AND delivered=0 ORDER BY sequence LIMIT ?').all(since, limit).map(r => Number(r.sequence));
  }
  acknowledgeOutbox(sequence: number): void {
    this.gate(true); if (!Number.isSafeInteger(sequence) || sequence < 1) throw Error('Invalid outbox sequence');
    this.db.prepare('UPDATE outbox SET delivered=1 WHERE sequence=?').run(sequence);
  }
  ingestArtifact(actorId: string, input: Buffer, options: { kind?: string; mediaType?: string; totalBytes?: number; maxBytes?: number; operationId?: string; evidenceRefs?: string[]; captureOutcome?: 'returned' | 'interrupted'; captureReason?: string; captureSource?: ScratchSnapshot; offset?: number; importedFrom?: { bundleSha256: string; file: string; sourceRunId: string; originalSha256: string }; preserveBytes?: boolean } = {}, request?: MutationRequest): ArtifactManifest {
    return this.atomically(() => {
      const max = options.maxBytes ?? DEFAULT_ARTIFACT_BYTES, total = options.totalBytes ?? input.length;
      if (!Buffer.isBuffer(input) || !Number.isSafeInteger(max) || max < 1 || max > MAX_ARTIFACT_BYTES || !Number.isSafeInteger(total) || total < input.length
        || (options.mediaType !== undefined && !['text/plain', 'application/json'].includes(options.mediaType))) throw Error('Invalid bounded text artifact');
      if (!validId(actorId) || (options.operationId !== undefined && !validId(options.operationId))
        || (options.kind !== undefined && (typeof options.kind !== 'string' || !options.kind.trim() || options.kind.length > 80))
        || (options.evidenceRefs !== undefined && (!Array.isArray(options.evidenceRefs) || options.evidenceRefs.length > 10 || options.evidenceRefs.some(ref => this.record(ref)?.kind !== 'evidence')))) throw Error('Unknown artifact evidence reference or invalid producer metadata');
      if ((options.captureOutcome !== undefined && !['returned','interrupted'].includes(options.captureOutcome))
        || (options.captureReason !== undefined && (typeof options.captureReason !== 'string' || options.captureReason.length > 200))) throw Error('Invalid artifact capture outcome');
      const captured = input.subarray(0, max), decoded = captured.toString('utf8');
      if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) throw Error('Invalid artifact segment offset');
      if (options.captureSource) {
        validateScratchSnapshot(options.captureSource);
        if (options.captureSource.root !== (actorId === 'owner' ? '/work' : `/work/${actorId}`) || options.captureSource.capturedBytes !== captured.length
          || options.captureSource.totalBytes !== total || options.captureSource.prefixSha256 !== sha(captured)
          || options.captureSource.offset !== (options.offset ?? 0)) throw Error('Artifact scratch provenance/producer/byte/hash mismatch');
      }
      if (options.importedFrom) {
        const source = options.importedFrom;
        if (!/^[a-f0-9]{64}$/.test(source.bundleSha256) || !/^run-[a-zA-Z0-9-]{1,75}$/.test(source.sourceRunId) || source.originalSha256 !== sha(captured)
          || !/^(?:segments\/(?:records|events|graph)-[0-9]{5}\.ndjson|artifacts\/artifact-[a-f0-9-]{36}\.txt)$/.test(source.file)) throw Error('Invalid imported-bundle provenance');
      }
      if (options.preserveBytes && !options.importedFrom) throw Error('Preserving unredacted bytes requires imported-bundle provenance');
      const segment=options.captureSource&&!options.preserveBytes?redactScratchSegment(decoded,options.captureSource,redact):undefined;
      const redacted = options.preserveBytes ? captured : Buffer.from(segment?.text??redactArtifactPrefix(decoded, redact)), bytes = options.preserveBytes?redacted.subarray(0,max):utf8Prefix(redacted,max);
      const id = `artifact-${randomUUID()}`, filename = `${id}.txt`;
      this.capacity(bytes.length); this.directory.publish(filename, bytes); this.fault?.('artifact-published');
      const event = this.insertEvent({ kind: 'artifact.retained', actorId, operationId: options.operationId, occurredAt: new Date().toISOString(), summary: `${id}: retained redacted bytes`, payloadRefs: [id] });
      const manifest: ArtifactManifest = { id, sequence: event.sequence, kind: cleanText(options.kind ?? 'output').slice(0, 80), mediaType: options.mediaType ?? 'text/plain', producer: actorId,
        operationId: options.operationId, bytes: bytes.length, sha256: sha(bytes), sensitivity: 'redacted', redactionVersion: 3, totalBytes: total,
        capturedInputBytes: captured.length, truncated: total > captured.length || redacted.length > max || options.captureOutcome === 'interrupted' || options.captureSource?.stable === false || segment?.partial===true, evidenceRefs: options.evidenceRefs ?? [],
        beforeRedactionSha256: sha(captured), hashScope: options.preserveBytes ? 'preserved-exported-bytes' : 'captured-prefix-before-redaction', decodingLossy: !Buffer.from(decoded).equals(captured),
        ...(options.captureOutcome ? {captureOutcome:options.captureOutcome} : {}),
        ...(options.importedFrom ? {importedFrom: options.importedFrom} : {}),
        captureReason: options.importedFrom ? 'imported portable bundle bytes; preserved without re-redaction' : options.captureSource?.stable === false ? 'Scratch stat changed during capture; not an atomic snapshot' : segment?.reason??(total > captured.length ? 'capture byte cap' : redacted.length > max ? 'redaction expansion byte cap' : options.captureReason),
        ...(options.captureSource ? {captureSource:safe(options.captureSource)} : {}) };
      if (manifest.evidenceRefs.length > 10 || manifest.evidenceRefs.some(ref => this.record(ref)?.kind !== 'evidence')) throw Error('Unknown artifact evidence reference');
      this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?)').run(id, event.sequence, filename, manifest.sha256, bytes.length, JSON.stringify(manifest));
      return manifest;
    }, request, { artifact: { actorId, inputHash: sha(input), options } });
  }
  artifacts(): ArtifactManifest[] { this.gate(); return this.db.prepare('SELECT body FROM artifacts ORDER BY sequence').all().map(r => JSON.parse(String(r.body))); }
  /** Host-only verified bytes for portable export. Never serialize this Buffer into tool/RPC results. */
  artifactBytes(id:string):{manifest:ArtifactManifest;bytes:Buffer} {
    this.gate();if(!validId(id))throw Error('Invalid artifact ID');
    const row=this.db.prepare('SELECT filename,sha256,bytes,body FROM artifacts WHERE id=?').get(id);
    if(!row)throw Error('Unknown artifact ID');
    const bytes=this.directory.read(String(row.filename),MAX_ARTIFACT_BYTES);
    if(bytes.length!==Number(row.bytes)||sha(bytes)!==row.sha256)throw Error('Artifact integrity failure');
    return {manifest:JSON.parse(String(row.body)) as ArtifactManifest,bytes};
  }
  artifact(id: string, offset = 0, length = 16 * 1024) {
    this.gate(); if (!validId(id) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 48 * 1024) throw Error('Invalid artifact range');
    const {manifest,bytes}=this.artifactBytes(id);
    if (offset > bytes.length) throw Error('Artifact range exceeds retained bytes');
    const shown = bytes.subarray(offset, offset + length);
    return { manifest, offset, returnedBytes: shown.length, text: shown.toString('utf8'),
      ...(offset + shown.length < bytes.length ? { nextOffset: offset + shown.length } : {}) };
  }
  checkpoint(reason: string, request?: MutationRequest): CheckpointManifest {
    return this.atomically(() => {
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw Error('Checkpoint reason must be 1..2000 characters');
      const asOfSequence = this.sequence(), id = `checkpoint-${randomUUID()}`, filename = `${id}.json`, records = this.records(), artifacts = this.artifacts();
      const events = this.db.prepare('SELECT sequence,body FROM events WHERE sequence<=? ORDER BY sequence').all(asOfSequence).map(r => ({ ...JSON.parse(String(r.body)), sequence: Number(r.sequence) })) as StateEvent[];
      const missingRefs: string[] = [];
      for (const a of artifacts) { try { this.artifact(a.id); } catch { missingRefs.push(a.id); } }
      const heads = new Map<string, AssessmentRecord>();
      for (const r of records) if (r.kind === 'task') heads.set(String((r.data?.task as Record<string, unknown>)?.id), r);
      const operations = new Map<string, StateEvent>(); for (const e of events) if (e.operationId && e.kind.startsWith('operation.')) operations.set(e.operationId, e);
      const graph=this.graphSnapshot(asOfSequence),graphHeads=this.graphSummary(asOfSequence),index=indexRecords(records,this.manifest().runId),plans=planFrontier(index),phases=phasePackets(index),context=this.reviewContext(),cases=caseViews(index,context.cases),coverage=coverageViews(index,context.coverage),
        planning={goals:plans.filter(row=>row.kind==='goal').length,todo:plans.filter(row=>row.kind==='todo').length,decisions:plans.filter(row=>row.kind==='decision').length,phasePackets:phases.length,
          pendingPhasePacketIds:phases.filter(row=>{const task=heads.get(row.taskId)?.data?.task as Record<string,unknown>|undefined;return task?.phasePacketId===row.id&&awaitingReview(task);}).map(row=>row.id)},
        review={cases:cases.length,uniqueAcceptedFindings:new Set(cases.filter(row=>row.acceptedFinding).map(row=>row.canonicalCaseId)).size,duplicateCases:cases.filter(row=>Boolean(row.duplicateOf)).length,pendingCases:cases.filter(needsCaseReview).length,staleCases:cases.filter(row=>row.currentness==='stale').length,coveragePlans:coverage.length,coverageCells:coverage.reduce((sum,row)=>sum+row.cellIds.length,0),staleCoverageCells:coverage.reduce((sum,row)=>sum+row.counts.stale,0),discoveredUnplannedAssets:coverage.reduce((sum,row)=>sum+row.discoveredUnplannedAssets,0)};
      const knowledge=this.knowledgeIndex(),snapshot = Buffer.from(JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, manifest: this.manifest(), asOfSequence, records, events, artifacts, graph, planning,review,knowledge }));
      if (snapshot.length > LEDGER_BYTES) throw Error('Checkpoint exceeds 64 MiB; portable snapshot requires segmented export');
      this.capacity(snapshot.length,true); this.directory.publish(filename, snapshot); this.fault?.('checkpoint-published');
      const manifest: CheckpointManifest = { id, schemaVersion: STATE_SCHEMA_VERSION, sourceRunId: this.manifest().runId, targetIdentity: this.manifest().targetIdentity,
        asOfSequence, createdAt: new Date().toISOString(), reason: redact(reason), snapshotSha256: sha(snapshot), snapshotBytes: snapshot.length,
        integrityStatus: missingRefs.length ? 'partial' : 'complete', missingRefs, omissions: ['No execution authority, credentials, sockets, cookies or request replay state'],
        pendingReviews: [...heads.values()].filter(r => awaitingReview(r.data!.task as Record<string, unknown>)).map(r => String((r.data!.task as Record<string, unknown>).id)).concat(cases.filter(row=>needsCaseReview(row)||row.currentness==='stale').map(row=>row.id)).slice(0,100),
        openGapIds: (() => { const retired = retiredIds(records); return records.filter(r => isOpenGap(r, retired)).map(r => r.id!); })(),
        inFlightOperationIds: [...operations.values()].filter(e => ['operation.requested', 'operation.started', 'operation.unknown-terminal'].includes(e.kind)).map(e => e.operationId!),
        artifacts, retentionStatus: this.manifest().retention,planning,review,
        knowledge:{version:1,sha256:sha(graphCanonical(knowledge)),heads:knowledge.heads.length,links:knowledge.links.length,cursors:knowledge.cursors.length},
        graph:{identityVersion:graph.identityVersion,scope:graph.scope,sha256:sha(graphCanonical(graph)),heads:{assets:graphHeads.assets,assertions:graphHeads.assertions,relations:graphHeads.relations,anchors:graphHeads.anchors}},
        capturePartialArtifactIds: artifacts.filter(a=>a.truncated || a.decodingLossy).map(a=>a.id),
        captureUnavailableEvidenceIds: records.filter(r=>r.kind === 'evidence' && (r.data?.capture as {available?:boolean} | undefined)?.available === false).map(r=>r.id!) };
      manifest.dataStatus = missingRefs.length || manifest.capturePartialArtifactIds!.length || manifest.captureUnavailableEvidenceIds!.length || manifest.inFlightOperationIds.length ? 'partial' : 'complete';
      const event = this.insertEvent({ kind: 'checkpoint.committed', actorId: 'owner', occurredAt: manifest.createdAt, summary: `${id} @${asOfSequence}: ${manifest.integrityStatus}`, payloadRefs: [id] });
      this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?)').run(id, event.sequence, asOfSequence, filename, manifest.snapshotSha256, snapshot.length, JSON.stringify(manifest));
      return manifest;
    }, request, { checkpoint: { reason } }, {finalization:true});
  }
  checkpoints(): CheckpointManifest[] { this.gate(); return this.db.prepare('SELECT manifest FROM checkpoints ORDER BY sequence').all().map(r => JSON.parse(String(r.manifest))); }
  inspectCheckpoint(id: string) {
    this.gate(); if (!validId(id)) throw Error('Invalid checkpoint ID');
    const row = this.db.prepare('SELECT filename,sha256,bytes,manifest FROM checkpoints WHERE id=?').get(id);
    if (!row) throw Error('Unknown committed checkpoint');
    const manifest = JSON.parse(String(row.manifest)) as CheckpointManifest, missingRefs: string[] = [...manifest.missingRefs];
    let snapshot: { records: AssessmentRecord[]; events: StateEvent[]; artifacts: ArtifactManifest[]; graph?:GraphSnapshot;planning?:CheckpointManifest['planning'];review?:CheckpointManifest['review'];knowledge?:KnowledgeIndexSnapshot } | undefined;
    try {
      const bytes = this.directory.read(String(row.filename), LEDGER_BYTES);
      if (bytes.length !== Number(row.bytes) || sha(bytes) !== row.sha256) throw Error('Snapshot hash mismatch');
      snapshot = JSON.parse(bytes.toString('utf8'));
      if(manifest.graph && (!snapshot?.graph || sha(graphCanonical(snapshot.graph))!==manifest.graph.sha256))missingRefs.push(`graph@${manifest.asOfSequence}`);
      if(manifest.knowledge&&(!snapshot?.knowledge||sha(graphCanonical(snapshot.knowledge))!==manifest.knowledge.sha256))missingRefs.push(`knowledge@${manifest.asOfSequence}`);
    } catch { missingRefs.push(id); }
    for (const a of manifest.artifacts) { try { this.artifact(a.id); } catch { missingRefs.push(a.id); } }
    return { manifest, integrityStatus: missingRefs.length ? 'partial' as const : 'complete' as const, missingRefs: [...new Set(missingRefs)],
      dataStatus: missingRefs.length || manifest.dataStatus === 'partial' ? 'partial' as const : manifest.dataStatus ?? 'unknown' as const,
      eventsNewer: this.sequence() - manifest.asOfSequence, currentness: this.sequence() > manifest.asOfSequence + 1 ? 'changed-since-checkpoint' as const : 'unchanged-since-checkpoint' as const,
      authorityRestored: false as const, snapshot };
  }

  // ---------------------------------------------------------------- asset graph (K3)
  /** Target/source identity is knowledge scoping, not live origin permission. */
  graphScope(): string {
    this.gate(); const m=this.manifest();
    return scopeOf(graphCanonical({identityVersion:GRAPH_IDENTITY_VERSION,targetKind:m.targetKind,targetIdentity:m.targetIdentity,sourceSnapshotSha256:m.sourceSnapshotSha256??null}));
  }
  /** Indexed host reference check; no history/materialization or execution authority. */
  assetRevision(entityId:string):number|undefined {
    this.gate();if(!/^asset-[a-f0-9]{24}$/.test(entityId))throw Error('Invalid task asset ID');return this.graphHead('assets',entityId)?.revision;
  }
  /** Same-run assertion head lookup for revision-pinned case hypotheses; knowledge only. */
  assertionRevision(entityId:string):number|undefined {
    this.gate();if(!/^assertion-[a-f0-9]{24}$/.test(entityId))throw Error('Invalid case hypothesis ID');return this.graphHead('assertions',entityId)?.revision;
  }
  /** Current same-run graph asset identities for explicit coverage denominator comparison. */
  assetEntityIds():string[]{
    this.gate();return this.db.prepare('SELECT DISTINCT entity_id FROM assets ORDER BY entity_id LIMIT ?').all(GRAPH_ENTITY_LIMIT+1).map(row=>String(row.entity_id));
  }
  /** Currentness lookups the case and coverage views need, bound to this store: the one place a projection learns the live asset/assertion revisions. */
  reviewContext():{cases:CaseContext;coverage:CoverageContext}{
    const cases:CaseContext={assetRevision:id=>this.assetRevision(id),assertionRevision:id=>this.assertionRevision(id)};
    return {cases,coverage:{...cases,targetRevision:()=>this.graphScope(),assetIds:()=>this.assetEntityIds()}};
  }
  private graphHead(table: GraphTable, entityId: string, asOfSequence=this.sequence()): GraphRow | undefined {
    const row=this.db.prepare(`SELECT body FROM ${table} WHERE entity_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1`).get(entityId,asOfSequence);
    return row ? JSON.parse(String(row.body)) as GraphRow : undefined;
  }
  private graphCount(table: GraphTable | 'graph_provenance'): number {return Number(this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);}
  private requireAsset(entityId: string, expectedRevision?:number, asOfSequence=this.sequence()): GraphRow {
    const head=this.graphHead('assets',entityId,asOfSequence);
    if(!head)throw Error(`Unknown asset entity ${entityId}; record the asset before claims about it`);
    if(expectedRevision!==undefined&&head.revision!==expectedRevision)throw Error(`STALE_GRAPH_REFERENCE: ${entityId} expected r${expectedRevision}, current r${head.revision}`);
    return head;
  }
  private evidenceRefs(ids:string[],label:string):void {
    for(const id of ids){const row=this.record(id);if(!row||row.kind!=='evidence'||row.data?.imported||row.data?.importedFrom)
      throw Error(`${label} must cite same-run evidence records; foreign, missing or imported IDs are refused (${id})`);}
  }
  private graphProducer(request?:MutationRequest,producer?:GraphProducer):GraphProducer {
    const actorId=request?.actorId??'owner',value=producer??{actorId};
    if(value.actorId!==actorId||!validId(value.actorId)||(value.taskId!==undefined&&!validId(value.taskId))
      ||(value.role!==undefined&&!['owner','general','recon','discovery','validation','reporting'].includes(value.role))
      ||(value.depth!==undefined&&(!Number.isInteger(value.depth)||value.depth<0||value.depth>3)))throw Error('Invalid host graph provenance');
    return value;
  }
  /** Operation-specific retained lookup: same canonical mutation as commit, never report ACK casts. */
  graphResult(batch:GraphBatch,request:MutationRequest,producer?:GraphProducer):GraphAck[]|undefined {
    return this.mutationResult(request,{graph:batch,producer:this.graphProducer(request,producer)}) as GraphAck[]|undefined;
  }
  /** One owner transaction. Effective row cap includes nested anchors, so the ACK fits the broker. */
  recordGraph(batch:GraphBatch,request?:MutationRequest,producer?:GraphProducer):GraphAck[] {
    validateGraphBatch(batch);const attribution=this.graphProducer(request,producer);
    return this.atomically(()=>{
      const scope=this.graphScope(),actorId=attribution.actorId,occurredAt=new Date().toISOString(),acks:GraphAck[]=[],local=new Map<string,string>();
      const limits={assets:GRAPH_ENTITY_LIMIT,assertions:GRAPH_ASSERTION_LIMIT,relations:GRAPH_RELATION_LIMIT,anchors:GRAPH_ANCHOR_ROWS};
      const insert={
        assets:'INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?)',assertions:'INSERT INTO assertions VALUES (?,?,?,?,?,?,?,?)',
        relations:'INSERT INTO relations VALUES (?,?,?,?,?,?,?,?,?,?)',anchors:'INSERT INTO anchors VALUES (?,?,?,?,?,?,?,?,?)',
      } as const;
      const observe=(entityId:string,revisionId:string)=>{
        const prior=this.db.prepare('SELECT body FROM graph_provenance WHERE revision_id=? AND actor_id=? AND task_id=?').get(revisionId,actorId,attribution.taskId??'');
        if(prior)return {prior:JSON.parse(String(prior.body)) as GraphObservation};
        if(this.graphCount('graph_provenance')>=GRAPH_PROVENANCE_LIMIT)throw Error('Graph provenance capacity reached; no budget renewal');
        const id=`provenance-${sha(graphCanonical({revisionId,...attribution})).slice(0,24)}`;
        return {observation:{...attribution,id,entityId,revisionId,at:occurredAt} as Omit<GraphObservation,'sequence'>};
      };
      const retainObservation=(observation:Omit<GraphObservation,'sequence'>,sequence:number)=>{
        const body={...observation,sequence};this.db.prepare('INSERT INTO graph_provenance VALUES (?,?,?,?,?,?,?)')
          .run(body.id,body.entityId,body.revisionId,actorId,attribution.taskId??'',sequence,JSON.stringify(body));
      };
      const write=(table:GraphTable,kind:string,entityId:string,columns:Record<string,unknown>,content:Record<string,unknown>,eventKind:EventKind,refs:string[]=[],supersedes?:string)=>{
        if(Buffer.byteLength(graphCanonical(content))>GRAPH_ROW_BYTES-1024)throw Error('Graph row exceeds the 8 KiB bound; retain a separate artifact');
        const contentHash=sha(graphCanonical(content)),head=this.graphHead(table,entityId);
        if(supersedes!==undefined&&head?.id!==supersedes)throw Error('STALE_GRAPH_REFERENCE: supersedes must name the current revision of this entity');
        if(head?.contentHash===contentHash){
          const seen=observe(entityId,head.id);let observationSequence=seen.prior?.sequence??head.sequence;
          if(seen.observation){const event=this.insertEvent({kind:'graph.observed',actorId,taskId:attribution.taskId,entityId,entityRevision:head.revision,occurredAt,summary:`${kind} ${entityId}: additional producer`,payloadRefs:[head.id],
            data:{graph:{scope,table:'provenance',observation:seen.observation}}});retainObservation(seen.observation,event.sequence);observationSequence=event.sequence;}
          acks.push({kind,entityId,id:head.id,revision:head.revision,sequence:head.sequence,observationSequence,created:false,storeVersion:STATE_SCHEMA_VERSION});return;
        }
        if(this.graphCount(table)>=limits[table])throw Error(`Graph ${table} capacity reached (${limits[table]} retained revisions); no silent archive or raised quota`);
        const revision=(head?.revision??0)+1,id=`${entityId}-r${revision}`,seen=observe(entityId,id);
        const body={...content,contentHash,id,entityId,revision,supersedes:head?.id??null,recordedBy:actorId,taskId:attribution.taskId,at:occurredAt};
        const event=this.insertEvent({kind:eventKind,actorId,taskId:attribution.taskId,entityId,entityRevision:revision,occurredAt,summary:`${kind} ${entityId} r${revision}`,payloadRefs:refs,
          data:{graph:{scope,table,body,observation:seen.observation}}});
        const stored=JSON.stringify({...body,sequence:event.sequence}),old=head?.id??null;
        const params:Record<GraphTable,SQLInputValue[]>={
          assets:[id,entityId,scope,String(columns.kind),String(columns.key),revision,stored,event.sequence,old],
          assertions:[id,entityId,String(columns.subjectId),kind,revision,stored,event.sequence,old],
          relations:[id,entityId,scope,String(columns.kind),String(columns.fromId),String(columns.toId),revision,stored,event.sequence,old],
          anchors:[id,entityId,String(columns.assetEntity),String(columns.kind),String(columns.value),revision,stored,event.sequence,old],
        };
        this.db.prepare(insert[table]).run(...params[table]);if(head&&(table==='assets'||table==='assertions'))this.invalidateKnowledge(entityId,table==='assets'?'asset':'assertion');if(seen.observation)retainObservation(seen.observation,event.sequence);
        acks.push({kind,entityId,id,revision,sequence:event.sequence,observationSequence:event.sequence,created:true,storeVersion:STATE_SCHEMA_VERSION});
      };
      const resolve=(value:unknown)=>typeof value==='string'&&value.startsWith('@')?(local.get(value.slice(1))??(()=>{throw Error(`Unknown batch ref ${value}`);})()):graphEntityId(value,'asset');
      const anchorWrite=(assetId:string,input:AnchorInput)=>{
        const anchor=validateAnchor(input);if(anchor.artifactId&&!this.artifactExists(anchor.artifactId))throw Error(`Anchor artifact ${anchor.artifactId} is not retained in this run`);
        const entityId=anchorEntityId(assetId,anchor.kind,anchor.value);
        write('anchors','anchor',entityId,{assetEntity:assetId,kind:anchor.kind,value:anchor.value},
          {assetEntity:assetId,kind:anchor.kind,value:anchor.value,locator:anchor.locator,artifactId:anchor.artifactId},'assertion.revised',anchor.artifactId?[anchor.artifactId]:[],anchor.supersedes);
      };
      for(const item of batch.assets??[]){
        const asset=validateAsset(item.asset),entityId=assetEntityId(scope,asset.kind,asset.key),head=this.graphHead('assets',entityId);
        if(item.ref){if(local.has(item.ref))throw Error(`Duplicate batch ref ${item.ref}`);local.set(item.ref,entityId);}
        if(asset.expectedRevision!==undefined&&head?.revision!==asset.expectedRevision)throw Error('STALE_GRAPH_REFERENCE: expected asset revision differs');
        this.evidenceRefs(asset.evidenceRefs,'Asset evidence');
        for(const anchor of item.asset.anchors??[])if(anchor.artifactId&&!this.artifactExists(anchor.artifactId))throw Error(`Anchor artifact ${anchor.artifactId} is not retained in this run`);
        write('assets','asset',entityId,{scope,kind:asset.kind,key:asset.key},{kind:asset.kind,key:asset.key,...asset.body,evidenceRefs:asset.evidenceRefs},'asset.upserted',asset.evidenceRefs);
        for(const anchor of item.asset.anchors??[])anchorWrite(entityId,anchor);
      }
      const assertionId=(subjectId:string,kind:string,statement:string,priorId?:string)=>{
        if(!priorId)return assertionEntityId(subjectId,kind,statement);
        const row=this.db.prepare('SELECT body FROM assertions WHERE id=?').get(priorId),prior=row?JSON.parse(String(row.body)) as GraphRow:undefined;
        if(!prior||prior.subjectId!==subjectId||prior.kind!==kind||this.graphHead('assertions',prior.entityId)?.id!==priorId)throw Error('STALE_GRAPH_REFERENCE: supersedes must pin the same asset/kind current assertion');
        return prior.entityId;
      };
      for(const input of batch.facts??[]){
        const fact=validateFact(input),subjectId=resolve(input.assetId),subject=this.requireAsset(subjectId,fact.assetRevision),kind=`fact:${fact.kind}`;
        if(fact.kind!=='inferred'&&!fact.evidenceRefs.length)throw Error('Observed/configuration facts need at least one same-run evidence receipt');
        this.evidenceRefs(fact.evidenceRefs,'Fact evidence');
        write('assertions',kind,assertionId(subjectId,kind,fact.statement,fact.supersedes),{subjectId},
          {subjectId,subjectRevision:subject.revision,kind,statement:fact.statement,confidence:fact.confidence,evidenceRefs:fact.evidenceRefs,unverified:true},'assertion.revised',fact.evidenceRefs,fact.supersedes);
      }
      for(const input of batch.hypotheses??[]){
        const h=validateHypothesis(input),subjectId=resolve(input.assetId),subject=this.requireAsset(subjectId,h.assetRevision);
        if(h.status!=='open'&&!h.evidenceRefs.length&&!h.counterevidenceRefs.length)throw Error('A resolved hypothesis needs same-run evidence or counterevidence');
        this.evidenceRefs(h.evidenceRefs,'Hypothesis evidence');this.evidenceRefs(h.counterevidenceRefs,'Hypothesis counterevidence');
        write('assertions','hypothesis',assertionId(subjectId,'hypothesis',h.statement,h.supersedes),{subjectId},
          {subjectId,subjectRevision:subject.revision,kind:'hypothesis',statement:h.statement,status:h.status,impact:h.impact,evidenceRefs:h.evidenceRefs,counterevidenceRefs:h.counterevidenceRefs,unverified:true},
          'assertion.revised',[...h.evidenceRefs,...h.counterevidenceRefs],h.supersedes);
      }
      for(const input of batch.relations??[]){
        const r=validateRelation(input),fromId=resolve(input.fromId),toId=resolve(input.toId);
        if(fromId===toId)throw Error('A relation cannot point an asset at itself');
        const from=this.requireAsset(fromId,r.fromRevision),to=this.requireAsset(toId,r.toRevision);
        this.evidenceRefs(r.evidenceRefs,'Relation evidence');if(r.basis==='observed'&&!r.evidenceRefs.length)throw Error('Observed relations need same-run evidence');
        write('relations','relation',relationEntityId(scope,r.kind,fromId,toId),{kind:r.kind,fromId,toId},
          {kind:r.kind,fromId,toId,fromRevision:from.revision,toRevision:to.revision,note:r.note,evidenceRefs:r.evidenceRefs,basis:r.basis,status:r.status},'assertion.revised',r.evidenceRefs,r.supersedes);
      }
      for(const item of batch.anchors??[]){graphObject(item,['assetId','assetRevision','anchor'],'Graph anchor row');const assetId=resolve(item.assetId);
        if(item.assetRevision!==undefined&&(!Number.isSafeInteger(item.assetRevision)||item.assetRevision<1))throw Error('Anchor asset revision must be a positive integer');
        this.requireAsset(assetId,item.assetRevision);anchorWrite(assetId,item.anchor);}
      return acks;
    },request,{graph:batch,producer:attribution});
  }
  private artifactExists(id:string):boolean {return Boolean(this.db.prepare('SELECT id FROM artifacts WHERE id=?').get(id));}
  graphSnapshot(asOfSequence=this.sequence()):GraphSnapshot {
    this.gate();if(!Number.isSafeInteger(asOfSequence)||asOfSequence<0||asOfSequence>this.sequence())throw Error('Invalid graph snapshot barrier');
    const rows=(table:GraphTable|'graph_provenance')=>this.db.prepare(`SELECT body FROM ${table} WHERE sequence<=? ORDER BY sequence,id`).all(asOfSequence).map(r=>JSON.parse(String(r.body)));
    return {identityVersion:GRAPH_IDENTITY_VERSION,runId:this.manifest().runId,scope:this.graphScope(),asOfSequence,assets:rows('assets'),assertions:rows('assertions'),relations:rows('relations'),anchors:rows('anchors'),provenance:rows('graph_provenance')};
  }
  graphSummary(asOfSequence=this.sequence()) {
    this.gate();if(!Number.isSafeInteger(asOfSequence)||asOfSequence<0||asOfSequence>this.sequence())throw Error('Invalid graph barrier');
    const count=(table:GraphTable)=>Number(this.db.prepare(`SELECT count(DISTINCT entity_id) AS n FROM ${table} WHERE sequence<=?`).get(asOfSequence)!.n);
    return {scope:this.graphScope(),asOfSequence,assets:count('assets'),assertions:count('assertions'),relations:count('relations'),anchors:count('anchors'),
      assetRevisions:Number(this.db.prepare('SELECT count(*) AS n FROM assets WHERE sequence<=?').get(asOfSequence)!.n)};
  }
  /** Bounded immutable history. Pagination covers whole sequence groups, including their provenance. */
  assetView(id:string,options:{since?:number;limit?:number;asOfSequence?:number}={}) {
    this.gate();const entityId=graphEntityId(id,'asset'),cursor=options.since??0,limit=options.limit??20,asOfSequence=options.asOfSequence??this.sequence();
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(asOfSequence)||asOfSequence<cursor||asOfSequence>this.sequence())throw Error('Invalid graph view cursor/limit/barrier');
    const head=this.requireAsset(entityId,undefined,asOfSequence),scope=this.graphScope();
    const union=`SELECT 'revisions' AS section,sequence,body FROM assets WHERE entity_id=?
      UNION ALL SELECT 'assertions',sequence,body FROM assertions WHERE subject_id=?
      UNION ALL SELECT 'relations',sequence,body FROM relations WHERE from_id=? OR to_id=?
      UNION ALL SELECT 'anchors',sequence,body FROM anchors WHERE asset_entity=?
      UNION ALL SELECT 'provenance',sequence,body FROM graph_provenance WHERE entity_id=?
        OR entity_id IN (SELECT entity_id FROM assertions WHERE subject_id=?)
        OR entity_id IN (SELECT entity_id FROM relations WHERE from_id=? OR to_id=?)
        OR entity_id IN (SELECT entity_id FROM anchors WHERE asset_entity=?)`;
    const params=[entityId,entityId,entityId,entityId,entityId,entityId,entityId,entityId,entityId,entityId];
    const counts:Record<string,number>={};for(const row of this.db.prepare(`SELECT section,count(*) AS n FROM (${union}) WHERE sequence<=? GROUP BY section`).all(...params,asOfSequence))counts[String(row.section)]=Number(row.n);
    const view={entityId,scope,revision:head.revision,head,revisions:[] as GraphRow[],assertions:[] as Array<GraphRow&{stale:boolean;superseded:boolean}>,relations:[] as Array<GraphRow&{stale:boolean;direction:'incoming'|'outgoing';superseded:boolean}>,anchors:[] as GraphRow[],provenance:[] as GraphObservation[],
      counts:{revisions:counts.revisions??0,assertions:counts.assertions??0,relations:counts.relations??0,anchors:counts.anchors??0,provenance:counts.provenance??0},asOfSequence,cursor,shown:0,total:0,omitted:0,nextCursor:undefined as number|undefined};
    view.total=Number(this.db.prepare(`SELECT count(*) AS n FROM (${union}) WHERE sequence>? AND sequence<=?`).get(...params,cursor,asOfSequence)!.n);
    const candidates=this.db.prepare(`SELECT section,sequence,body FROM (${union}) WHERE sequence>? AND sequence<=? ORDER BY sequence,section LIMIT ?`).all(...params,cursor,asOfSequence,limit*2+2);
    const groups=new Map<number,typeof candidates>();for(const row of candidates){const seq=Number(row.sequence),group=groups.get(seq)??[];group.push(row);groups.set(seq,group);}
    let last=cursor,groupCount=0;
    for(const [sequence,group] of groups){
      if(groupCount>=limit)break;
      const additions=group.map(r=>({section:String(r.section),body:JSON.parse(String(r.body)) as GraphRow}));
      for(const entry of additions){const row=entry.body;
        if(entry.section==='assertions')Object.assign(row,{stale:row.subjectRevision!==head.revision,superseded:this.graphHead('assertions',row.entityId,asOfSequence)?.id!==row.id});
        if(entry.section==='relations')Object.assign(row,{direction:row.fromId===entityId?'outgoing':'incoming',superseded:this.graphHead('relations',row.entityId,asOfSequence)?.id!==row.id,
          stale:row.fromRevision!==this.requireAsset(String(row.fromId),undefined,asOfSequence).revision||row.toRevision!==this.requireAsset(String(row.toId),undefined,asOfSequence).revision});
        (view[entry.section as 'revisions'] as Array<GraphRow|GraphObservation>).push(row);
      }
      if(Buffer.byteLength(JSON.stringify(view))>GRAPH_RESPONSE_BYTES-512){for(const entry of additions)(view[entry.section as 'revisions'] as unknown[]).pop();break;}
      view.shown+=additions.length;last=sequence;groupCount++;
    }
    view.omitted=view.total-view.shown;if(view.omitted&&view.shown)view.nextCursor=last;
    if(view.omitted&&!view.shown)throw Error('Graph history row cannot fit the bounded response; use a narrower artifact-backed assertion');
    return view;
  }
  graphPage(options:{since?:number;limit?:number;asOfSequence?:number}={}):StorePage<GraphRow>&{uniqueAssets:number} {
    this.gate();const cursor=options.since??0,limit=options.limit??20,asOfSequence=options.asOfSequence??this.sequence(),scope=this.graphScope();
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(asOfSequence)||asOfSequence<cursor||asOfSequence>this.sequence())throw Error('Invalid graph page cursor/limit/barrier');
    const total=Number(this.db.prepare('SELECT count(*) AS n FROM assets WHERE scope=? AND sequence>? AND sequence<=?').get(scope,cursor,asOfSequence)!.n),rows:GraphRow[]=[];
    let bytes=0;for(const r of this.db.prepare('SELECT body FROM assets WHERE scope=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(scope,cursor,asOfSequence,limit)){
      const row=JSON.parse(String(r.body)) as GraphRow,size=Buffer.byteLength(JSON.stringify(row));if(bytes+size>GRAPH_RESPONSE_BYTES-1024)break;rows.push(row);bytes+=size;}
    return {rows,total,shown:rows.length,omitted:total-rows.length,asOfSequence,cursor,uniqueAssets:Number(this.db.prepare('SELECT count(DISTINCT entity_id) AS n FROM assets WHERE scope=? AND sequence<=?').get(scope,asOfSequence)!.n),...(rows.length<total&&rows.length?{nextCursor:rows.at(-1)!.sequence}:{})};
  }
  /** SQL selects current heads, not all revisions. All categories share a strict encoded response bound. */
  graphExport(options:{limit?:number;since?:number;asOfSequence?:number}={}) {
    this.gate();const limit=options.limit??200,cursor=options.since??0,asOfSequence=options.asOfSequence??this.sequence(),scope=this.graphScope();
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Graph export limit must be 1..500');
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(asOfSequence)||asOfSequence<cursor||asOfSequence>this.sequence())throw Error('Invalid graph export cursor/barrier');
    const latest=(table:GraphTable)=>`NOT EXISTS(SELECT 1 FROM ${table} newer WHERE newer.entity_id=r.entity_id AND newer.sequence<=${asOfSequence} AND newer.sequence>r.sequence)`;
    const assets:GraphRow[]=[],assertions:GraphRow[]=[],relations:GraphRow[]=[],anchors:GraphRow[]=[];
    const available=Number(this.db.prepare(`SELECT count(*) AS n FROM assets r WHERE scope=? AND sequence>? AND sequence<=? AND ${latest('assets')}`).get(scope,cursor,asOfSequence)!.n);
    const render=()=>{const graph=renderGraph({scope,assets,assertions,relations});return {...graph,json:{...graph.json,anchors}};};
    const add=(list:GraphRow[],row:GraphRow)=>{list.push(row);if(Buffer.byteLength(JSON.stringify(render()))>GRAPH_RESPONSE_BYTES-2048){list.pop();return false;}return true;};
    // Cursor zero presents a deterministic kind/key order; subsequent pages still select all omitted heads via sequence.
    const candidates=this.db.prepare(`SELECT body FROM assets r WHERE scope=? AND sequence>? AND sequence<=? AND ${latest('assets')} ORDER BY sequence LIMIT ?`).all(scope,cursor,asOfSequence,limit);
    let last=cursor;for(const r of candidates){const row=JSON.parse(String(r.body)) as GraphRow;if(!add(assets,row))break;last=row.sequence;}
    assets.sort((a,b)=>String(a.kind)<String(b.kind)?-1:String(a.kind)>String(b.kind)?1:String(a.key)<String(b.key)?-1:1);
    const ids=assets.map(a=>a.entityId),totals={assets:available,assertions:0,relations:0,anchors:0};
    if(ids.length){const marks=ids.map(()=>'?').join(',');
      for(const [table,list,condition,args] of [
        ['assertions',assertions,`subject_id IN (${marks})`,ids],['relations',relations,`from_id IN (${marks}) AND to_id IN (${marks})`,[...ids,...ids]],['anchors',anchors,`asset_entity IN (${marks})`,ids],
      ] as Array<[GraphTable,GraphRow[],string,string[]]>){
        totals[table as 'assertions']=Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} r WHERE ${condition} AND sequence<=? AND ${latest(table)}`).get(...args,asOfSequence)!.n);
        for(const r of this.db.prepare(`SELECT body FROM ${table} r WHERE ${condition} AND sequence<=? AND ${latest(table)} ORDER BY sequence DESC LIMIT ?`).all(...args,asOfSequence,limit)){
          const row=JSON.parse(String(r.body)) as GraphRow;
          if(table==='assertions')row.stale=row.subjectRevision!==this.requireAsset(String(row.subjectId),undefined,asOfSequence).revision;
          if(table==='relations')row.stale=row.fromRevision!==this.requireAsset(String(row.fromId),undefined,asOfSequence).revision||row.toRevision!==this.requireAsset(String(row.toId),undefined,asOfSequence).revision;
          if(!add(list,row))break;
        }
      }
    }
    const rendered=render(),shown={assets:assets.length,assertions:assertions.length,relations:relations.length,anchors:anchors.length};
    const omittedByKind={assets:totals.assets-shown.assets,assertions:totals.assertions-shown.assertions,relations:totals.relations-shown.relations,anchors:totals.anchors-shown.anchors};
    return {...rendered,asOfSequence,cursor,counts:totals,countScope:{assets:'remaining current heads in this run',assertions:'selected assets only',relations:'both endpoints selected',anchors:'selected assets only'},shown,omittedByKind,truncated:Object.values(omittedByKind).some(n=>n>0),omitted:omittedByKind.assets,
      ...(omittedByKind.assets&&assets.length?{nextCursor:last}:{}),warning:'Bounded current-head graph; assertion/anchor counts cover selected assets, relation counts require both endpoints. Read asset history for omitted/cross-page data; no execution authority.'};
  }

  close(): void {
    if (this.closed) return; this.closed = true; this.observers.clear();
    try { this.db.close(); } finally {
      try { if (this.writerLock) { try { this.writerLock.exec('ROLLBACK'); } finally { this.writerLock.close(); } } }
      finally { this.directory.close(); }
    }
  }
}
