// K0 storage feasibility probe ONLY. No assessment integration, reference execution, target traffic or authority.
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export async function storageSpike() {
  const root = await mkdtemp(join(tmpdir(), 'p2o-sqlite-spike-'));
  const path = join(root, 'assessment.sqlite');
  let db;
  try {
    await chmod(root, 0o700);
    db = new DatabaseSync(path);
    await chmod(path, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE records (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, record_id TEXT NOT NULL REFERENCES records(id));
      CREATE TABLE outbox (sequence INTEGER PRIMARY KEY REFERENCES events(sequence));
      CREATE TABLE requests (actor TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor, request_id));
      PRAGMA user_version=1;`);
    const version = db.prepare('SELECT sqlite_version() AS version').get().version;
    const commit = (actor, request, payload, fail = false) => {
      const prior = db.prepare('SELECT payload, result FROM requests WHERE actor=? AND request_id=?').get(actor,request);
      if (prior) { assert.equal(prior.payload,payload,'idempotency key conflict');return JSON.parse(prior.result); }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO records VALUES (?,?)').run(request,payload);
        db.prepare('INSERT INTO events (id,kind,record_id) VALUES (?,?,?)').run(`event-${request}`,'fixture',request);
        const sequence = Number(db.prepare('SELECT max(sequence) AS sequence FROM events').get().sequence);
        db.prepare('INSERT INTO outbox VALUES (?)').run(sequence);
        if (fail) throw Error('injected pre-commit failure');
        const result = {id:request,sequence};
        db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(actor,request,payload,JSON.stringify(result));
        db.exec('COMMIT');return result;
      } catch (error) { db.exec('ROLLBACK');throw error; }
    };
    assert.throws(()=>commit('worker','failed','fixture',true),/pre-commit/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
    const first=commit('worker','committed','fixture');
    assert.deepEqual(commit('worker','committed','fixture'),first);
    assert.throws(()=>commit('worker','committed','changed'),/conflict/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,1);
    // Abrupt exit leaves an uncommitted write invisible while preserving the prior commit.
    const child=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO records VALUES (?,?)').run('uncommitted','fixture');process.exit(17);`,path],{timeout:10000,encoding:'utf8'});
    assert.equal(child.status,17,child.stderr);
    db.close();db=new DatabaseSync(path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
    // Reader never creates a writer or reconstructs workers/tickets.
    const reader=new DatabaseSync(path,{readOnly:true});
    assert.equal(reader.prepare('SELECT count(*) AS n FROM records').get().n,1);
    assert.throws(()=>reader.exec("INSERT INTO records VALUES ('forbidden','fixture')"),/readonly/i);
    reader.close();
    const pages=Number(db.prepare('PRAGMA page_count').get().page_count);
    db.exec(`PRAGMA max_page_count=${pages}`);
    assert.throws(()=>db.prepare('INSERT INTO records VALUES (?,?)').run('disk-full','x'.repeat(1024*1024)),/full/i);
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,1);
    assert.equal((await stat(root)).mode & 0o777,0o700);
    assert.equal((await stat(path)).mode & 0o777,0o600);
    return {node:process.version,sqlite:version,driver:'node:sqlite DatabaseSync',mechanics:['transaction/outbox rollback','idempotency/conflict','abrupt pre-commit exit','read-only reopen','SQLITE_FULL failure','private main file modes'],runtimeIntegrated:false,limitations:['No task/report migration','No authority replay','No checkpoint/artifact atomic publishing','No benchmark or lifecycle acceptance','Node/Pi version matrix not implied','WAL/SHM path hardening remains to qualify']};
  } finally {db?.close();await rm(root,{recursive:true,force:true});}
}
if(process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await storageSpike()));
