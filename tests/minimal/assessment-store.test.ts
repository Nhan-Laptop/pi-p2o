import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink, link, stat, readdir, unlink, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AssessmentStore, type StoreManifest, type StoreFault } from '../../src/state/store.js';
import { PrivateDirectory } from '../../src/state/files.js';
import type { AssessmentRecord } from '../../src/records.js';

const manifest: StoreManifest = { runId: 'run-fixture', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'snapshot-fixture',
  targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };
const note = (id?: string, text = 'bounded inert observation'): AssessmentRecord => ({ id, at: '2030', by: 'owner', runId: manifest.runId, kind: 'note', text });
const request = (id: string, payload: unknown = { a: 1, b: 2 }) => ({ actorId: 'owner', requestId: id, payload });
async function fixture(work: (root: string, store: AssessmentStore) => Promise<void>, fault?: StoreFault) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-store-')); let store: AssessmentStore | undefined;
  try { store = AssessmentStore.create(root, manifest, { fault }); await work(root, store); }
  finally { store?.close(); await rm(root, { recursive: true, force: true }); }
}

describe('canonical owner-only SQLite foundation (not runtime integration)', () => {
  it('commits record/event/outbox/request atomically and returns original ACK on repeated transport delivery', async () => fixture(async (_root, store) => {
    const a = store.commitRecords([note()], request('first', { b: 2, a: 1 }));
    expect(a[0]).toMatchObject({ version: 2, storeVersion: 7, sequence: 1 });
    expect(store.commitRecords([note()], request('first', { a: 1, b: 2 }))).toEqual(a);
    expect(store.records()).toHaveLength(1); expect(store.outbox()).toEqual([1]);
    expect(store.events().rows[0]).toMatchObject({ actorId: 'owner', kind: 'record.committed', runId: manifest.runId, payloadRefs: [a[0].recordId] });
    expect(() => store.commitRecords([note(undefined, 'different')], request('first'))).toThrow('IDEMPOTENCY_CONFLICT');
    expect(() => store.commitRecords([note()], request('first', { a: 9 }))).toThrow('IDEMPOTENCY_CONFLICT');
    store.acknowledgeOutbox(1); expect(store.outbox()).toEqual([]); expect(store.events().total).toBe(1);
  }));
  it('rolls back the whole packet before commit; a retry gets one effect after lost post-commit ACK', async () => {
    let fail: string | undefined = 'before-commit';
    await fixture(async (_root, store) => {
      expect(() => store.commitRecords([note('one'), note('two')], request('packet'))).toThrow('injected');
      expect(store.records()).toEqual([]); expect(store.outbox()).toEqual([]); expect(store.sequence()).toBe(0);
      fail = 'after-commit'; expect(() => store.commitRecords([note('one'), note('two')], request('packet'))).toThrow('injected');
      expect(store.records()).toHaveLength(2); expect(store.outbox()).toEqual([1, 2]);
      fail = undefined; const ack = store.commitRecords([note('one'), note('two')], request('packet'));
      expect(ack.map(r => r.sequence)).toEqual([1, 2]); expect(store.events().total).toBe(2);
    }, stage => { if (stage === fail) throw Error('injected transport failure'); });
  });
  it('rolls back IDs/domain rows on invalid packet and rejects foreign namespaces and damaged revisions', async () => fixture(async (_root, store) => {
    expect(() => store.commitRecords([note('one'), { ...note('bad'), runId: 'foreign' }])).toThrow('same-run');
    expect(store.records()).toHaveLength(0);
    expect(() => store.commitRecords([{ ...note('bad'), supersedes: 'absent' }])).toThrow('revision');
    expect(() => store.commitRecords([{ ...note('bad'), resolves: ['absent'] }])).toThrow('resolution');
    expect(() => store.commitRecords([note('x'), note('x')])).toThrow('Duplicate');
    expect(store.events().total).toBe(0);
    expect(() => store.commitRecords([note('big', 'x'.repeat(20000))])).toThrow('too large');
  }));
  it('allows only one owner writer, permits readers, and restores knowledge only after close/reopen', async () => fixture(async (root, store) => {
    store.commitRecords([note('saved')]);
    expect(() => AssessmentStore.open(root, manifest.runId, { readOnly: false })).toThrow(/locked/);
    const reader = AssessmentStore.open(root, manifest.runId);
    try { expect(reader.record('saved')?.text).toContain('inert'); expect(reader.health()).toMatchObject({ readOnly: true, authorityRestored: false });
      expect(() => reader.commitRecords([note('forbidden')])).toThrow('read-only');
      expect(() => reader.event({ actorId: 'owner', kind: 'run.started', occurredAt: '2030', summary: 'forbidden' })).toThrow('read-only');
      expect(() => reader.acknowledgeOutbox(1)).toThrow('read-only');
    } finally { reader.close(); }
    store.close(); const next = AssessmentStore.open(root, manifest.runId, { readOnly: false });
    try { expect(next.records()).toHaveLength(1); expect(next.health().authorityRestored).toBe(false); } finally { next.close(); }
    expect(() => store.commitRecords([note()])).toThrow('closed');
  }));
  it('has private root/DB/journal/lock modes, no WAL/SHM files and no persisted authority material', async () => fixture(async (_root, store) => {
    store.commitRecords([{ ...note('secret', 'Authorization: Bearer fixture-secret'), data: { password: 'fixture-secret', cookie: 'fixture-cookie', environment: { SECRET: 'no' } } }]);
    const event = store.event({ actorId: 'owner', kind: 'operation.started', operationId: 'op-one', occurredAt: '2030', summary: 'Cookie: fixture-cookie' });
    expect(JSON.stringify(store.records())).not.toContain('fixture-secret'); expect(event.summary).not.toContain('fixture-cookie');
    expect((await stat(store.location)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(store.location)) { expect(name).not.toMatch(/-wal|-shm/); expect((await stat(join(store.location, name))).mode & 0o777).toBe(0o600); }
    expect(store.manifest()).toEqual(manifest);
  }));
  it('pins directories and rejects symlink ancestors, wrong root modes and hard-linked state files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'p2o-state-path-'));
    try {
      const alias = join(base, 'alias'); await symlink(base, alias);
      expect(() => PrivateDirectory.open(alias)).toThrow();
      expect(() => PrivateDirectory.open(join(alias, 'nested'), true)).toThrow();
      await chmod(base, 0o755); expect(() => PrivateDirectory.open(base)).toThrow('0700'); await chmod(base, 0o700);
      const dir = PrivateDirectory.open(base);
      try { expect(() => dir.path('../outside')).toThrow('filename'); dir.createFile('regular'); await link(join(base, 'regular'), join(base, 'hard'));
        expect(() => dir.file('regular')).toThrow('single-link');
      } finally { dir.close(); }
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it('rejects replacement DB symlinks and untrusted side files without touching outside bytes', async () => fixture(async (root, store) => {
    const location = store.location; store.close(); const outside = join(root, 'outside'); await writeFile(outside, 'do not change', { mode: 0o600 });
    await unlink(join(location, 'assessment.sqlite')); await symlink(outside, join(location, 'assessment.sqlite'));
    expect(() => AssessmentStore.open(root, manifest.runId)).toThrow(); expect(await readFile(outside, 'utf8')).toBe('do not change');
  }));
  it('fails closed if the opened DB directory is renamed/replaced, without writing a journal into a foreign directory', async () => fixture(async (root, store) => {
    store.commitRecords([note('prior')]); const moved = join(root, 'moved'), outside = join(root, 'outside');
    await rename(store.location, moved); await mkdir(outside, { mode: 0o700 }); await symlink(outside, store.location);
    expect(() => store.commitRecords([note('forbidden')])).toThrow(/readonly/i);
    expect(await readdir(outside)).toEqual([]); expect(store.records().map(r => r.id)).toEqual(['prior']);
  }));
  it('leaves unknown versions unchanged and permits metadata-only historical inspection, never migration', async () => fixture(async (root, store) => {
    store.close(); const path = join(root, manifest.runId, 'assessment.sqlite');
    for(const version of [3,4,5,6,77]){
      const db = new DatabaseSync(path);db.exec(`PRAGMA user_version=${version}`);db.close();const before=await readFile(path);
      expect(() => AssessmentStore.open(root, manifest.runId, { readOnly: false })).toThrow(`Unsupported state schema ${version}`);
      const reader=AssessmentStore.open(root,manifest.runId);try{expect(reader.health()).toMatchObject({schemaVersion:version,compatible:false,readOnly:true});expect(()=>reader.records()).toThrow('Unsupported');}finally{reader.close();}
      expect(await readFile(path)).toEqual(before);
    }
  }));
  it('publishes immutable redacted artifacts with byte ranges, input capture limits and evidence provenance', async () => fixture(async (_root, store) => {
    store.commitRecords([{ ...note('receipt'), kind: 'evidence' }]);
    const source = Buffer.from('password=fixture-secret\n' + 'x'.repeat(400));
    const artifact = store.ingestArtifact('owner', source, { maxBytes: 128, totalBytes: 999, evidenceRefs: ['receipt'] }, request('artifact'));
    expect(artifact).toMatchObject({ sensitivity: 'redacted', totalBytes: 999, capturedInputBytes: 128, truncated: true, evidenceRefs: ['receipt'] });
    expect(store.ingestArtifact('owner', source, { maxBytes: 128, totalBytes: 999, evidenceRefs: ['receipt'] }, request('artifact'))).toEqual(artifact);
    expect(store.artifacts()).toHaveLength(1); const page = store.artifact(artifact.id, 0, 20); expect(page.text).not.toContain('fixture-secret'); expect(page.nextOffset).toBe(20);
    expect(() => store.artifact('../outside')).toThrow('range'); expect(() => store.artifact(artifact.id, 900)).toThrow('range');
    expect(() => store.ingestArtifact('owner', source, { mediaType: 'application/octet-stream' })).toThrow('text artifact');
    expect(() => store.ingestArtifact('owner', source, { evidenceRefs: ['unknown'] })).toThrow('evidence'); expect(store.artifacts()).toHaveLength(1);
  }));
  it('captures a transaction-boundary checkpoint, pending review/gaps/in-flight work, and snapshot+tail without duplicating on retry', async () => fixture(async (_root, store) => {
    store.commitRecords([{ ...note('old-gap'), kind: 'open' }]);
    store.event({ actorId: 'owner', kind: 'operation.started', operationId: 'op-inflight', occurredAt: '2030', summary: 'running, not elapsed timeout' });
    const artifact = store.ingestArtifact('owner', Buffer.from('benign output'));
    const checkpoint = store.checkpoint('inert barrier', request('checkpoint'));
    expect(store.checkpoint('inert barrier', request('checkpoint'))).toEqual(checkpoint);
    expect(checkpoint).toMatchObject({ asOfSequence: 3, integrityStatus: 'complete', openGapIds: ['old-gap'], inFlightOperationIds: ['op-inflight'] });
    expect(checkpoint.artifacts[0].id).toBe(artifact.id);
    const inspected = store.inspectCheckpoint(checkpoint.id); expect(inspected.authorityRestored).toBe(false); expect(inspected.integrityStatus).toBe('complete');
    const snapshot = inspected.snapshot!; store.commitRecords([note('new')]);
    const tail = store.events({ since: checkpoint.asOfSequence, limit: 100 });
    expect([...snapshot.events, ...tail.rows].map(e => e.sequence)).toEqual(store.events({ since: 0, limit: 100 }).rows.map(e => e.sequence));
    expect(store.inspectCheckpoint(checkpoint.id).currentness).toBe('changed-since-checkpoint'); expect(store.checkpoints()).toHaveLength(1);
  }));
  it('does not publish a checkpoint pointer after interrupted file publication and retries safely', async () => {
    let fail = true;
    await fixture(async (_root, store) => {
      store.commitRecords([note('saved')]); expect(() => store.checkpoint('fault', request('checkpoint'))).toThrow('injected');
      expect(store.checkpoints()).toEqual([]); expect(store.sequence()).toBe(1); fail = false;
      const cp = store.checkpoint('fault', request('checkpoint')); expect(store.checkpoints()).toHaveLength(1); expect(store.inspectCheckpoint(cp.id).integrityStatus).toBe('complete');
    }, stage => { if (stage === 'checkpoint-published' && fail) throw Error('injected publish failure'); });
  });
  it('never calls missing/tampered artifact or snapshot bytes complete', async () => fixture(async (_root, store) => {
    const artifact = store.ingestArtifact('owner', Buffer.from('benign'));
    const cp = store.checkpoint('has bytes'); await writeFile(join(store.location, `${artifact.id}.txt`), 'changed');
    expect(() => store.artifact(artifact.id)).toThrow('integrity'); expect(store.inspectCheckpoint(cp.id).missingRefs).toContain(artifact.id);
    const next = store.checkpoint('partial bytes'); expect(next.integrityStatus).toBe('partial');
    await unlink(join(store.location, `${cp.id}.json`)); expect(store.inspectCheckpoint(cp.id).missingRefs).toContain(cp.id);
    expect(store.inspectCheckpoint(cp.id).integrityStatus).toBe('partial');
  }));
  it('uses exact stable event cursors under page/byte limits, actor filtering and duplicate outbox delivery', async () => fixture(async (_root, store) => {
    for (let i = 0; i < 29; i++) store.event({ actorId: i % 2 ? 'owner' : 'worker', kind: 'operation.requested', operationId: `op-${i}`, occurredAt: '2030', summary: '観'.repeat(1800) });
    const first = store.events({ limit: 100 }); expect(first.shown).toBeLessThan(29); expect(first.total).toBe(29); expect(first.omitted).toBe(29 - first.shown);
    const seen: number[] = []; let cursor = 0;
    for (;;) { const page = store.events({ since: cursor, limit: 100 }); seen.push(...page.rows.map(e => e.sequence)); if (!page.nextCursor) break; cursor = page.nextCursor; }
    expect(seen).toEqual(Array.from({ length: 29 }, (_, i) => i + 1)); expect(store.events({ actorId: 'owner', limit: 100 }).total).toBe(14);
    expect(store.outbox()).toEqual(store.outbox()); expect(() => store.events({ since: -1 })).toThrow('cursor'); expect(() => store.events({ limit: 101 })).toThrow('cursor');
  }));
  it('rejects quota exhaustion explicitly without disturbing earlier commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-store-quota-')); let store: AssessmentStore | undefined;
    try {
      store = AssessmentStore.create(root, manifest, { maxBytes: 8 * 1024 * 1024 }); store.commitRecords([note('saved')]);
      expect(() => store!.ingestArtifact('owner', Buffer.alloc(8 * 1024 * 1024, 120), { maxBytes: 8 * 1024 * 1024 })).toThrow('quota');
      expect(store.records()).toHaveLength(1); expect(store.artifacts()).toHaveLength(0); expect(store.events().total).toBe(1);
    } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('retains a bounded finalization reserve: ordinary artifacts stop early, outcome/checkpoint still commit, quota is never raised', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-store-reserve-')); let store: AssessmentStore | undefined;
    try {
      store = AssessmentStore.create(root, manifest, { maxBytes: 8 * 1024 * 1024 }); store.commitRecords([note('saved')]);
      const reserve = store.health().finalizationReserveBytes; expect(reserve).toBe(512 * 1024);
      const payload = Buffer.alloc(256 * 1024, 121); let written = 0;
      for (;;) {
        try { store.ingestArtifact('owner', payload, { maxBytes: 256 * 1024 }); written += 1; }
        catch (error) { expect(String(error)).toContain('finalization reserve retained'); break; }
        if (written > 40) throw new Error('reserve never engaged');
      }
      const usage = store.health().bytes; expect(usage).toBeLessThanOrEqual(8 * 1024 * 1024 - reserve);
      // The reserved headroom is what the final outcome/final checkpoint are allowed to consume.
      const held = store; expect(held.outcome()).toBeUndefined();
      const final = held.checkpoint('final operator barrier before outcome'); held.finalize('incomplete','owner stopped with retained gaps','cleaned');
      expect(held.outcome()).toMatchObject({assessmentOutcome:'incomplete',resourceOutcome:'cleaned'});
      expect(held.inspectCheckpoint(final.id)).toMatchObject({integrityStatus:'complete',authorityRestored:false});
      expect(held.artifacts()).toHaveLength(written); expect(() => held.ingestArtifact('owner', payload, { maxBytes: 256 * 1024 })).toThrow('finalization reserve retained');
      expect(held.health().maxBytes).toBe(8 * 1024 * 1024);
    } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('reconciles interrupted state with an attributed knowledge record, never rewriting tasks or restoring authority', async () => fixture(async (root, store) => {
    const task = (status: string, revision: number) => ({ id: `task-${status}`, runId: manifest.runId, at: '2030', by: 'owner', kind: 'task' as const, text: `task ${status}`,
      data: { task: { id: 'task-a', runId: manifest.runId, status, revision, prerequisites: [], question: 'bounded', surface: 'fixture', risk: 'policy', role: 'recon', roleReason: 'recon needs a bounded question', expectedTrue: 'observed', expectedFalse: 'not observed', stopCondition: 'after one receipt' } } });
    const ack = store.commitRecords([task('running', 1)]);
    const operation = store.event({ actorId: 'owner', kind: 'operation.requested', operationId: 'operation-abc', occurredAt: '2030', summary: 'inert operation', data: {} });
    const state = store.interruptedState();
    expect(state).toMatchObject({ runningTaskIds: ['task-a'], runningTaskRevisions: [1], unknownOperationIds: ['operation-abc'], latestReconciliation: undefined });
    expect(state.workerIds).toEqual([]);
    const before = store.records().length, sequence = store.sequence();
    const record = store.reconcileInterruption('owner', 'process exited during an authorized run');
    expect(record).toMatchObject({ kind: 'lifecycle', by: 'owner', runId: manifest.runId });
    expect(record.supersedes).toBeUndefined();
    expect(record.data?.reconciliation).toMatchObject({ asOfSequence: sequence, by: 'owner', runningTaskIds: ['task-a'], unknownOperationIds: ['operation-abc'], authorityRestored: false, resume: false });
    expect(record.text).toContain('no resume, no authority');
    expect(store.records()).toHaveLength(before + 1);
    expect(store.record(ack[0].recordId)?.data?.task).toMatchObject({ status: 'running', revision: 1 }); // Task history is untouched.
    expect(store.events({ since: sequence }).rows.filter(row => row.kind === 'record.committed')).toHaveLength(1);
    expect(store.interruptedState().latestReconciliation?.id).toBe(record.id);
    expect(() => store.reconcileInterruption('owner', '   ')).toThrow('bounded reason');
    const reader = AssessmentStore.open(root, manifest.runId);
    try { expect(reader.interruptedState().latestReconciliation?.id).toBe(record.id); expect(reader.health().authorityRestored).toBe(false); } finally { reader.close(); }
    expect(operation.sequence).toBeGreaterThan(0);
  }));
  it('rolls back SQLITE_FULL across record/event/outbox/request rows and preserves the last committed state', async () => fixture(async (_root, store) => {
    store.commitRecords([note('saved')]);
    // Infrastructure-only failure injection; no model-accessible SQL API exists.
    const db = (store as unknown as { db: DatabaseSync }).db;
    const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count); db.exec(`PRAGMA max_page_count=${pages}`);
    expect(() => store.commitRecords(Array.from({ length: 8 }, (_, i) => note(`full-${i}`, 'x'.repeat(10000))), request('full'))).toThrow(/full/i);
    expect(store.records().map(r => r.id)).toEqual(['saved']); expect(store.events().total).toBe(1); expect(store.outbox()).toEqual([1]);
    db.exec('PRAGMA max_page_count=10000');
    expect(store.commitRecords([note('after')], request('full'))[0].sequence).toBe(2);
  }));
  it('an artifact publication fault cannot publish domain refs or a success ACK; retry commits exactly one registry entry', async () => {
    let fail = true;
    await fixture(async (_root, store) => {
      expect(() => store.ingestArtifact('owner', Buffer.from('inert'), {}, request('artifact'))).toThrow('injected');
      expect(store.artifacts()).toHaveLength(0); expect(store.sequence()).toBe(0); expect(store.outbox()).toEqual([]);
      fail = false; const artifact = store.ingestArtifact('owner', Buffer.from('inert'), {}, request('artifact'));
      expect(store.ingestArtifact('owner', Buffer.from('inert'), {}, request('artifact'))).toEqual(artifact); expect(store.artifacts()).toHaveLength(1);
    }, stage => { if (stage === 'artifact-published' && fail) throw Error('injected publication fault'); });
  });
  it('recovers a killed uncommitted transaction with OS lock release, preserving only prior commits and no authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-store-kill-'));
    try {
      const store = AssessmentStore.create(root, manifest); store.commitRecords([note('prior')]); store.close();
      const modulePath = fileURLToPath(new URL('../../dist/src/state/store.js', import.meta.url));
      const script = `import {AssessmentStore} from ${JSON.stringify(modulePath)}; const s=AssessmentStore.open(process.argv[1],'run-fixture',{readOnly:false,fault:stage=>{if(stage==='before-commit')process.kill(process.pid,'SIGKILL')}});s.commitRecords([{id:'uncommitted',runId:'run-fixture',at:'2030',by:'owner',kind:'note',text:'inert'}]);`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { timeout: 10000, encoding: 'utf8' }); expect(child.signal, child.stderr).toBe('SIGKILL');
      // Explicit host database recovery is not assessment/worker resume. Never mint an Engine/ticket.
      const recovery = AssessmentStore.open(root, manifest.runId, { readOnly: false });
      try { expect(recovery.records().map(r => r.id)).toEqual(['prior']); expect(recovery.outbox()).toEqual([1]); expect(recovery.health().authorityRestored).toBe(false); }
      finally { recovery.close(); }
      const reader = AssessmentStore.open(root, manifest.runId); try { expect(reader.record('uncommitted')).toBeUndefined(); } finally { reader.close(); }
      expect(await readdir(join(root, manifest.runId))).not.toContain('broker.sock');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
