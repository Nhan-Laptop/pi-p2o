import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import { exportBundle, importBundle, inspectBundle, bundlePath, BUNDLE_SOURCE_MARKER } from '../../src/state/bundle.js';
import type { AssessmentRecord } from '../../src/records.js';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const manifest: StoreManifest = { runId: 'run-fixture', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'bundle-fixture',
  targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };
const note = (text: string, extra: Record<string, unknown> = {}): AssessmentRecord => ({ at: '2030', by: 'owner', runId: manifest.runId, kind: 'note', text, ...extra });

async function seeded(root: string): Promise<AssessmentStore> {
  const store = AssessmentStore.create(join(root,'state'), manifest);
  store.commitRecords([note('retained observation one'), note('retained observation two')]);
  store.events({ since: 0, limit: 1 });
  store.ingestArtifact('owner', Buffer.from('password=bundle-secret\nretained artifact body'), { kind:'output' });
  return store;
}
async function fixture(work:(root:string,store:AssessmentStore)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'p2o-bundle-'));let store:AssessmentStore|undefined;
  try{store=await seeded(root);await work(root,store);}finally{store?.close();await rm(root,{recursive:true,force:true});}
}

describe('portable knowledge bundle (owner host command, not a model capability)',()=>{
  it('exports indexed segments/artifacts with hashes, refuses overwrite and never writes inside the state root',async()=>fixture(async(root,store)=>{
    const destination=join(root,'bundle');
    const exported=await exportBundle(store,destination);
    expect(exported.manifest).toMatchObject({version:2,runId:'run-fixture',redactionVersion:2,authorityRestored:false,retention:'durable-local',targetIdentity:'bundle-fixture'});
    expect(exported.manifest.counts).toMatchObject({records:2,artifacts:1,files:3,events:3});
    for(const file of exported.manifest.files)expect(await stat(join(destination,file.name))).toMatchObject({size:file.bytes});
    expect(exported.manifest.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    const index=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'));expect(index.bundleSha256).toBe(exported.manifest.bundleSha256);
    const segment=await readFile(join(destination,'segments/records-00000.ndjson'),'utf8');
    expect(segment.split('\n').filter(Boolean).map(line=>JSON.parse(line).text)).toEqual(['retained observation one','retained observation two']);
    await expect(exportBundle(store,destination)).rejects.toThrow('already exists');
    await expect(exportBundle(store,join(root,'state','nested-bundle'))).rejects.toThrow('outside the private state');
    await expect(exportBundle(store,join(root,'state'))).rejects.toThrow('outside the private state');
    await expect(exportBundle(store,'relative/bundle')).rejects.toThrow('absolute host directory');
    expect((await readdir(destination)).sort()).toEqual(['.npmignore',BUNDLE_SOURCE_MARKER,'artifacts','manifest.json','segments'].sort());
  }));
  it('inspects a bundle and reports missing, tampered and extra files instead of assuming integrity',async()=>fixture(async(root,store)=>{
    const destination=join(root,'bundle');await exportBundle(store,destination);
    const clean=await inspectBundle(destination);expect(clean).toMatchObject({integrityStatus:'complete',missing:[],tampered:[],extra:[]});
    await writeFile(join(destination,'artifacts',clean.manifest.files.find(f=>f.kind==='artifact')!.sourceId!+'.txt'),'tampered body');
    expect(await inspectBundle(destination)).toMatchObject({integrityStatus:'partial',tampered:[expect.stringContaining('artifacts/')]});
    await rm(join(destination,'segments',clean.manifest.files.find(f=>f.kind==='records')!.name.split('/')[1]));
    const missing=await inspectBundle(destination);expect(missing.integrityStatus).toBe('partial');expect(missing.missing).toHaveLength(1);
    await writeFile(join(destination,'artifacts','unindexed.txt'),'extra bytes are not imported');
    expect((await inspectBundle(destination)).extra).toEqual(['artifacts/unindexed.txt']);
  }));
  it('rejects a bundle whose index is internally inconsistent, oversized or path-traversing',async()=>fixture(async(root,store)=>{
    const destination=join(root,'bundle');await exportBundle(store,destination);
    const indexPath=join(destination,'manifest.json'), good=JSON.parse(await readFile(indexPath,'utf8'));
    const traversal={...good,files:[...good.files,{name:'../../etc/passwd',kind:'records',bytes:1,sha256:'a'.repeat(64)}]};
    const cases:[Record<string,unknown>,string][]=[
      [{...good,version:99},'shape'],[{...good,counts:{...good.counts,files:9}},'count'],
      [{...traversal,counts:{...good.counts,files:good.files.length+1,bytes:good.counts.bytes+1}},'file entry'], // Counts stay internally consistent so the name rule is what rejects it.
      [{...good,files:[{name:'segments/records-00000.ndjson',kind:'artifact',bytes:1,sha256:'a'.repeat(64),sourceId:'artifact-'+'0'.repeat(36)}],counts:{files:1,records:0,events:0,artifacts:1,bytes:1,graph:0}},'file entry'],
      ];
    for(const [value,needle] of cases){
      await writeFile(indexPath,JSON.stringify(value));
      await expect(inspectBundle(destination)).rejects.toThrow(needle);
    }
    await writeFile(indexPath,JSON.stringify({...good,bundleSha256:'b'.repeat(64)}));
    expect(await inspectBundle(destination)).toMatchObject({integrityStatus:'partial',tampered:['manifest.json']});
    await writeFile(indexPath,JSON.stringify(good));
    await rm(destination,{recursive:true,force:true});await mkdir(destination);
    await expect(inspectBundle(destination)).rejects.toThrow('manifest missing or oversized');
    await expect(inspectBundle(join(root,'absent'))).rejects.toThrow('missing or not a directory');
  }));
  it('imports preserved bytes as immutable artifacts plus one provenance note, and refuses duplicates/tamper/authority claims',async()=>fixture(async(root,store)=>{
    const destination=join(root,'bundle');const exported=await exportBundle(store,destination);
    const artifactFile=exported.manifest.files.find(f=>f.kind==='artifact')!;
    const original=await readFile(join(destination,artifactFile.name));
    const receipt=store.ingestArtifact('owner',Buffer.from('same-run evidence body'),{kind:'output'});
    expect(receipt.id).toMatch(/^artifact-/);
    const target=AssessmentStore.create(join(root,'target'),{...manifest,runId:'run-target'});
    try{
      target.commitRecords([{at:'2030',by:'owner',runId:'run-target',kind:'note',text:'pre-existing target note'}]);
      const imported=await importBundle(target,destination);
      expect(imported.artifactIds).toHaveLength(exported.manifest.counts.files);
      expect(store2text(target,imported.artifactIds)).toBeDefined();
      const preserved=target.artifacts().filter(a=>a.importedFrom);
      expect(preserved).toHaveLength(exported.manifest.counts.files);
      for(const a of preserved){const row=target.artifact(a.id);expect(a.sha256).toBe(a.importedFrom!.originalSha256);expect(a.hashScope).toBe('preserved-exported-bytes');expect(a.captureReason).toContain('without re-redaction');expect(a.producer).toBe('owner');}
      const artifact=preserved.find(a=>a.kind==='imported-artifact')!;
      expect(artifact.importedFrom).toMatchObject({sourceRunId:'run-fixture',file:artifactFile.name});
      expect(target.artifact(artifact.id).text).toBe(original.toString('utf8'));
      expect(target.record(imported.noteId)).toMatchObject({kind:'note',by:'owner'});
      expect(target.record(imported.noteId)!.refs).toEqual(imported.artifactIds);
      expect(target.record(imported.noteId)!.data).toMatchObject({bundleSha256:exported.manifest.bundleSha256,authorityRestored:false});
      // Imported knowledge cannot masquerade as this run's own evidence or resolve its open items.
      expect(target.records().some(r=>r.kind==='evidence')).toBe(false);
      expect(target.records().filter(r=>r.kind==='note').some(r=>r.data?.bundleSha256===exported.manifest.bundleSha256)).toBe(true);
      expect(() => target.commitRecords([{at:'2030',by:'owner',runId:'run-target',kind:'note',text:'forged resolution',resolves:[imported.noteId]}])).toThrow('resolution');
      await expect(importBundle(target,destination)).rejects.toThrow('already imported');
      await writeFile(join(destination,artifactFile.name),'changed after export');
      await expect(importBundle(target,destination)).rejects.toThrow('integrity is partial');
      expect(target.artifacts().filter(a=>a.importedFrom)).toHaveLength(exported.manifest.counts.files);
      expect(target.health()).toMatchObject({maxBytes:268435456,authorityRestored:false});
    }finally{target.close();}
  }));
  it('exports byte-exact UTF-8 across range boundaries and accepts an artifact larger than one NDJSON segment',async()=>fixture(async(root,store)=>{
    const utf8=store.ingestArtifact('owner',Buffer.from('a'.repeat(49151)+'€'.repeat(20)),{maxBytes:100000});
    const large=store.ingestArtifact('owner',Buffer.alloc(4*1024*1024+1,65),{maxBytes:8*1024*1024});
    const destination=join(root,'unicode-bundle'),bundle=await exportBundle(store,destination);
    const view=await inspectBundle(destination);expect(view.integrityStatus).toBe('complete');
    expect((await readFile(join(destination,`artifacts/${utf8.id}.txt`))).equals(store.artifactBytes(utf8.id).bytes)).toBe(true);
    expect((await readFile(join(destination,`artifacts/${large.id}.txt`))).equals(store.artifactBytes(large.id).bytes)).toBe(true);
    expect(bundle.manifest.files.find(f=>f.sourceId===large.id)!.bytes).toBe(4*1024*1024+1);
  }));
  it('includes typed graph history/provenance as segments, but imports them only as foreign knowledge without a writable graph or evidence',async()=>fixture(async(root,store)=>{
    const asset=store.recordGraph({assets:[{asset:{kind:'file',key:'src/auth.py',anchors:[{kind:'symbol',value:'check_gate'}]}}]})[0];
    store.recordGraph({facts:[{assetId:asset.entityId,kind:'inferred',statement:'policy unknown; no runtime proof',confidence:'low'}]});
    const destination=join(root,'graph-bundle'),bundle=await exportBundle(store,destination);
    expect(bundle.manifest.counts.graph).toBe(6);const file=bundle.manifest.files.find(f=>f.kind==='graph')!;
    const rows=(await readFile(join(destination,file.name),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(rows.map(row=>row.table).sort()).toEqual(['anchors','assertions','assets','provenance','provenance','provenance']);
    expect(rows.find(row=>row.table==='assets').body.entityId).toBe(asset.entityId);
    const target=AssessmentStore.create(join(root,'import-state'),{...manifest,runId:'run-import'});
    try{await importBundle(target,destination);expect(target.graphSummary().assets).toBe(0);expect(target.artifacts().some(a=>a.kind==='imported-graph')).toBe(true);
      expect(()=>target.recordGraph({facts:[{assetId:asset.entityId,kind:'inferred',statement:'foreign asset is not established here',confidence:'low'}]})).toThrow('Unknown asset');}
    finally{target.close();}
  }));
  it('reads the prior bundle v1 without inventing graph rows, and rejects duplicate indexed paths',async()=>fixture(async(root,store)=>{
    const destination=join(root,'legacy-bundle'),bundle=await exportBundle(store,destination),indexPath=join(destination,'manifest.json');
    const old={...bundle.manifest,version:1,counts:{...bundle.manifest.counts}};delete old.counts.graph;
    old.bundleSha256=sha(JSON.stringify({version:old.version,runId:old.runId,createdAt:old.createdAt,counts:old.counts,files:old.files}));
    await writeFile(indexPath,JSON.stringify(old));expect((await inspectBundle(destination)).integrityStatus).toBe('complete');
    const duplicate={...bundle.manifest,files:[...bundle.manifest.files,bundle.manifest.files[0]],counts:{...bundle.manifest.counts,files:bundle.manifest.counts.files+1,bytes:bundle.manifest.counts.bytes+bundle.manifest.files[0].bytes}};
    await writeFile(indexPath,JSON.stringify(duplicate));await expect(inspectBundle(destination)).rejects.toThrow('Duplicate');
  }));
  it('refuses to preserve unredacted bytes without import provenance and validates index names strictly',async()=>fixture(async(root,store)=>{
    expect(()=>store.ingestArtifact('owner',Buffer.from('raw'),{preserveBytes:true})).toThrow('imported-bundle provenance');
    expect(()=>store.ingestArtifact('owner',Buffer.from('raw'),{preserveBytes:true,importedFrom:{bundleSha256:'a'.repeat(64),file:'../../host',sourceRunId:'run-x',originalSha256:sha('raw')}})).toThrow('provenance');
    expect(()=>store.ingestArtifact('owner',Buffer.from('raw'),{preserveBytes:true,importedFrom:{bundleSha256:'a'.repeat(64),file:'segments/records-00000.ndjson',sourceRunId:'run-x',originalSha256:'b'.repeat(64)}})).toThrow('provenance');
    const linked=join(root,'linked');await symlink(join(root,'missing-target'),linked);
    await expect(stat(linked)).rejects.toThrow();
    expect(()=>bundlePath('C:\\windows','export')).toThrow('absolute host directory');
    expect(()=>bundlePath('/tmp/\u0000bad','import')).toThrow('absolute host directory');
  }));
});
function store2text(store:AssessmentStore,ids:string[]){for(const id of ids)if(!store.artifact(id))return undefined;return ids.length;}
