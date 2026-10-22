import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import type { AssessmentRecord } from '../../src/records.js';
import { GRAPH_RESPONSE_BYTES, applyGraphEvents } from '../../src/state/graph.js';
import { graphParameters } from '../../src/state/graph-tool.js';

const manifest = (runId: string, targetIdentity = 'fixture-target'): StoreManifest => ({ runId, retention: 'durable-local', targetKind: 'directory',
  targetIdentity, targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });
const evidence = (store: AssessmentStore, text = 'bounded inert receipt'): string => {
  const ack = store.commitRecords([{ at: '2030', by: 'owner', runId: store.manifest().runId, kind: 'evidence', text } as AssessmentRecord]);
  return ack[0].recordId;
};
const request = (id: string, payload: unknown) => ({ actorId: 'owner', requestId: id, payload });
async function fixture(work: (store: AssessmentStore, root: string) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-graph-')); let store: AssessmentStore | undefined;
  try { store = AssessmentStore.create(root, manifest('run-graph')); await work(store, root); } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
}

describe('asset/fact/hypothesis graph (K3, canonical store only)', () => {
  it('keeps tool arguments in a root object so legacy Pi provider projection does not silently erase them',()=>{
    const projected={type:'object',properties:graphParameters.properties??{},required:graphParameters.required??[]};
    expect(graphParameters.type).toBe('object');expect(projected.required).toContain('action');expect(Object.keys(projected.properties)).toEqual(['action','batch','id','requestId','cursor','limit','asOfSequence']);
    expect(projected.properties.batch).toMatchObject({type:'object',additionalProperties:false});expect(projected.properties.action).toMatchObject({type:'string',enum:['record','view','page','export','chain']});
  });
  it('derives exact-byte identities, converges duplicates and keeps append-only revisions with history', async () => fixture(async (store) => {
    const key = 'GET https://example.com/auth';
    const first = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key, label: 'auth endpoint' } }] });
    expect(first[0]).toMatchObject({ kind: 'asset', revision: 1, created: true });
    expect(first[0].entityId).toMatch(/^asset-[a-f0-9]{24}$/);
    expect(first[0].id).toBe(`${first[0].entityId}-r1`);
    const repeated = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key, label: 'auth endpoint' } }] });
    expect(repeated[0]).toMatchObject({ entityId: first[0].entityId, revision: 1, created: false, sequence: first[0].sequence });
    const changed = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key, label: 'auth endpoint (renamed)' } }] });
    expect(changed[0]).toMatchObject({ entityId: first[0].entityId, revision: 2, created: true });
    expect(changed[0].sequence).toBeGreaterThan(first[0].sequence);
    expect(store.records()).toHaveLength(0); // Graph rows are typed rows + events, not prose records.
    expect(store.events({ since: 0 }).rows.filter(row => row.kind === 'asset.upserted')).toHaveLength(2);
    const view = store.assetView(first[0].entityId);
    expect(view).toMatchObject({ revision: 2, counts: { revisions: 2, assertions: 0, relations: 0, anchors: 0 } });
    expect(view.revisions.map(row => row.revision)).toEqual([1, 2]);
    expect(view.head).toMatchObject({ kind: 'endpoint', key, label: 'auth endpoint (renamed)' });
    const page = store.graphPage({ limit: 10 });
    expect(page.rows.map(row => row.revision)).toEqual([1, 2]);
    expect(page).toMatchObject({ total: 2, shown: 2, omitted: 0 });
    for (const bad of [{ kind: 'endpoint', key: ' padded' }, { kind: 'endpoint', key: 'padded ' }, { kind: 'endpoint', key: 'a\u0301' },
      { kind: 'not-a-kind', key: 'x' }, { kind: 'endpoint', key: '' }, { kind: 'endpoint', key: 'x'.repeat(501) }, { kind: 'endpoint', key: 'x\n y' },
      { kind: 'endpoint', key: 'x', attributes: { ['n'.repeat(65)]: 'v' } }, { kind: 'endpoint', key: 'x', anchors: Array.from({ length: 11 }, () => ({ kind: 'url', value: '/a' })) }])
      expect(() => store.recordGraph({ assets: [{ asset: bad as never }] })).toThrow();
    expect(() => store.recordGraph({ assets: [] })).toThrow('at least one row');
    expect(() => store.recordGraph({ assets: Array.from({ length: 129 }, (_, i) => ({ asset: { kind: 'file', key: `f-${i}` } })) })).toThrow('1..128');
  }));
  it('rejects foreign, missing, imported and non-evidence receipts for claims, and unknown assets', async () => fixture(async (store) => {
    const assetId = store.recordGraph({ assets: [{ asset: { kind: 'file', key: 'app/main.py' } }] })[0].entityId;
    const receipt = evidence(store);
    const artifact = store.ingestArtifact('owner', Buffer.from('bounded output'), { kind: 'output' });
    expect(() => store.recordGraph({ facts: [{ assetId, kind: 'observed', statement: 'reads config', confidence: 'high', evidenceRefs: [artifact.id] }] }))
      .toThrow('same-run evidence records');
    expect(() => store.recordGraph({ facts: [{ assetId, kind: 'configuration', statement: 'debug on', confidence: 'medium', evidenceRefs: ['11111111-1111-1111-1111-111111111111'] }] }))
      .toThrow('same-run evidence records');
    expect(() => store.recordGraph({ facts: [{ assetId, kind: 'observed', statement: 'no evidence', confidence: 'low' }] })).toThrow('at least one same-run evidence receipt');
    expect(() => store.recordGraph({ facts: [{ assetId: 'asset-000000000000000000000000', kind: 'inferred', statement: 'ghost', confidence: 'low' }] })).toThrow('Unknown asset entity');
    expect(() => store.recordGraph({ relations: [{ kind: 'depends_on', fromId: assetId, toId: 'asset-000000000000000000000000' }] })).toThrow('Unknown asset entity');
    expect(() => store.recordGraph({ relations: [{ kind: 'depends_on', fromId: assetId, toId: assetId }] })).toThrow('cannot point an asset at itself');
    const fact = store.recordGraph({ facts: [{ assetId, kind: 'observed', statement: 'reads config at startup', confidence: 'high', evidenceRefs: [receipt] }] });
    expect(fact[0]).toMatchObject({ kind: 'fact:observed', revision: 1, created: true });
    expect(store.assetView(assetId).assertions[0]).toMatchObject({ statement: 'reads config at startup', evidenceRefs: [receipt], stale: false });
    expect(() => store.recordGraph({ anchors: [{ assetId, anchor: { kind: 'artifact', value: 'retained', artifactId: 'artifact-00000000-0000-0000-0000-000000000000' } }] })).toThrow('not retained');
    // A foreign run's rows are invisible: the same key in another scope is a different identity.
    const other = AssessmentStore.create(join(await mkdtemp(join(tmpdir(), 'p2o-graph-other-')), 'state'), manifest('run-other', 'other-target'));
    try { expect(other.graphScope()).not.toBe(store.graphScope()); expect(other.graphPage().rows).toEqual([]);
      expect(() => store.assetView(other.recordGraph({ assets: [{ asset: { kind: 'file', key: 'app/main.py' } }] })[0].entityId)).toThrow('Unknown asset entity'); } finally { other.close(); }
  }));
  it('keeps hypothesis counterevidence and marks asset-stale pins after the asset evolves', async () => fixture(async (store) => {
    const assetId = store.recordGraph({ assets: [{ asset: { kind: 'route', key: '/admin' } }] })[0].entityId;
    const supporting = evidence(store, 'authorization check observed'), counter = evidence(store, 'control request rejected');
    const otherId = store.recordGraph({ assets: [{ asset: { kind: 'identity', key: 'tenant-admin' } }] })[0].entityId;
    const hypothesis = store.recordGraph({ hypotheses: [{ assetId, statement: 'gate is enforced server-side', status: 'supported', impact: 'privilege boundary',
      evidenceRefs: [supporting], counterevidenceRefs: [counter] }], relations: [{ kind: 'authenticates', fromId: otherId, toId: assetId, note: 'admin session' }] });
    expect(hypothesis.map(row => row.kind)).toEqual(['hypothesis', 'relation']);
    const before = store.assetView(assetId);
    expect(before.assertions[0]).toMatchObject({ status: 'supported', counterevidenceRefs: [counter], stale: false });
    expect(before.relations[0]).toMatchObject({ direction: 'incoming', kind: 'authenticates', stale: false });
    expect(() => store.recordGraph({ hypotheses: [{ assetId, statement: 'resolved without proof', status: 'refuted' }] })).toThrow('needs same-run evidence or counterevidence');
    store.recordGraph({ assets: [{ asset: { kind: 'route', key: '/admin', label: 'admin (moved)' } }] });
    const after = store.assetView(assetId);
    expect(after.revision).toBe(2);
    expect(after.assertions[0]).toMatchObject({ stale: true, subjectRevision: 1 });
    expect(after.relations[0]).toMatchObject({ stale: true });
    expect((after.assertions[0] as Record<string, unknown>).statement).toBe('gate is enforced server-side'); // History is never rewritten.
  }));
  it('records anchors idempotently, includes retained artifacts and binds them to the asset', async () => fixture(async (store) => {
    const assetId = store.recordGraph({ assets: [{ asset: { kind: 'file', key: 'src/auth.py',
      anchors: [{ kind: 'symbol', value: 'def check_gate' }, { kind: 'path', value: 'src/auth.py', locator: { line: '42' } }] } }] })[0].entityId;
    const artifact = store.ingestArtifact('owner', Buffer.from('def check_gate(): ...'), { kind: 'source-slice' });
    const anchor = store.recordGraph({ anchors: [{ assetId, anchor: { kind: 'artifact', value: 'retained slice', artifactId: artifact.id } }] });
    expect(anchor[0]).toMatchObject({ kind: 'anchor', revision: 1, created: true });
    expect(store.recordGraph({ anchors: [{ assetId, anchor: { kind: 'artifact', value: 'retained slice', artifactId: artifact.id } }] })[0]).toMatchObject({ created: false });
    const view = store.assetView(assetId);
    expect(view.counts.anchors).toBe(3);
    expect(view.anchors.map(row => row.kind)).toEqual(['symbol', 'path', 'artifact']);
    expect(view.anchors.at(-1)).toMatchObject({ artifactId: artifact.id });
    expect(() => store.recordGraph({ anchors: [{ assetId, anchor: { kind: 'url', value: 'https://example.com', locator: { ['p'.repeat(65)]: 'x' } } }] })).toThrow();
  }));
  it('returns original ACKs for an identical authenticated batch and conflicts on a changed one', async () => fixture(async (store, root) => {
    const payload = { assets: [{ asset: { kind: 'service' as const, key: 'http://fixture.local:8080' } }] };
    const first = store.recordGraph(payload, request('graph-batch-1', payload));
    const replay = store.recordGraph(payload, request('graph-batch-1', { assets: [{ asset: { kind: 'service', key: 'http://fixture.local:8080' } }] } as never));
    expect(replay).toEqual(first);
    expect(store.events({ since: 0 }).rows.filter(row => row.kind === 'asset.upserted')).toHaveLength(1);
    expect(() => store.recordGraph({ assets: [{ asset: { kind: 'service', key: 'http://fixture.local:9090' } }] }, request('graph-batch-1', payload))).toThrow('IDEMPOTENCY_CONFLICT');
    const reader = AssessmentStore.open(root, store.manifest().runId);
    try { expect(() => reader.recordGraph(payload)).toThrow('read-only'); expect(reader.graphExport().json).toMatchObject({ scope: store.graphScope() }); } finally { reader.close(); }
  }));
  it('exports bounded JSON and Mermaid for current heads only, with explicit truncation', async () => fixture(async (store) => {
    const seed = store.recordGraph({ assets: [{ asset: { kind: 'file', key: 'a.py' } }, { asset: { kind: 'file', key: 'b.py' } }] });
    store.recordGraph({ assets: [{ asset: { kind: 'file', key: 'a.py', label: 'renamed' } }], relations: [{ kind: 'depends_on', fromId: seed[1].entityId, toId: seed[0].entityId }] });
    const exported = store.graphExport();
    expect(exported.json).toMatchObject({ scope: store.graphScope() });
    const assets = exported.json.assets as Array<Record<string, unknown>>;
    expect(assets.map(asset => asset.key)).toEqual(['a.py', 'b.py']);
    expect(assets[0]).toMatchObject({ revision: 2, label: 'renamed' });
    expect((exported.json.relations as unknown[])).toHaveLength(1);
    expect(exported.mermaid).toContain('```mermaid'); expect(exported.mermaid).toContain('graph LR');
    expect(exported.mermaid).toContain('depends_on'); expect(exported.mermaid).toContain('file: a.py');
    expect(exported.mermaid).not.toContain('verified finding');
    const truncated = store.graphExport({ limit: 1 });
    expect(truncated).toMatchObject({ truncated: true, omitted: 1 });
    expect((truncated.json.assets as unknown[])).toHaveLength(1);
    for (const limit of [0, 501, 1.5, '10']) expect(() => store.graphExport({ limit: limit as never })).toThrow('1..500');
    expect(() => store.graphPage({ limit: 101 })).toThrow('cursor/limit'); expect(() => store.graphPage({ since: -1 })).toThrow('cursor/limit');
  }));
  it('caps the final encoded graph export including large anchors, and labels selected/cross-page count scope',async()=>fixture(async store=>{
    const id=store.recordGraph({assets:[{asset:{kind:'file',key:'anchors.py'}}]})[0].entityId;
    store.recordGraph({anchors:Array.from({length:8},(_,n)=>({assetId:id,anchor:{kind:'symbol',value:'symbol-'+n,locator:Object.fromEntries(Array.from({length:6},(_,k)=>['part'+k,'x'.repeat(500)]))}}))});
    const page=store.graphExport();expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
    expect(page.shown.anchors).toBeGreaterThan(0);expect(page.omittedByKind.anchors).toBeGreaterThan(0);expect(page.json.anchors.length+page.omittedByKind.anchors).toBe(8);
    expect(page).not.toHaveProperty('anchors');expect(page.countScope).toMatchObject({assertions:'selected assets only',relations:'both endpoints selected'});
  }));
  it('resolves batch-local refs atomically and preserves each producer without duplicate assets or repeat events',async()=>fixture(async store=>{
    const receipt=evidence(store),batch={assets:[{ref:'entry',asset:{kind:'endpoint' as const,key:'GET http://[::1]:8080/objects?x=1&x=2'}}],
      facts:[{assetId:'@entry',kind:'observed' as const,statement:'control request rejected for actor B',confidence:'medium' as const,evidenceRefs:[receipt]}]};
    const first=store.recordGraph(batch,{actorId:'worker-a',requestId:'batch-1',payload:batch},{actorId:'worker-a',taskId:'task-a',role:'recon',depth:1});
    const second=store.recordGraph(batch,{actorId:'worker-b',requestId:'batch-1',payload:batch},{actorId:'worker-b',taskId:'task-b',role:'recon',depth:1});
    expect(second.map(row=>row.entityId)).toEqual(first.map(row=>row.entityId));expect(second.every(row=>!row.created)).toBe(true);
    const view=store.assetView(first[0].entityId);expect(view.counts).toMatchObject({revisions:1,assertions:1,provenance:4});
    expect(view.provenance.map(row=>[row.actorId,row.taskId])).toEqual([['worker-a','task-a'],['worker-a','task-a'],['worker-b','task-b'],['worker-b','task-b']]);
    expect(view.provenance.filter(row=>row.revisionId===first[1].id).map(row=>row.actorId)).toEqual(['worker-a','worker-b']);
    const before=store.sequence();store.recordGraph(batch,{actorId:'worker-b',requestId:'batch-2',payload:batch},{actorId:'worker-b',taskId:'task-b',role:'recon',depth:1});expect(store.sequence()).toBe(before);
    expect(store.graphSummary()).toMatchObject({assets:1,assetRevisions:1,assertions:1});
    expect(()=>store.recordGraph({assets:[{asset:{kind:'file',key:'must-roll-back'}}],facts:[{assetId:'@absent',kind:'inferred',statement:'unknown ref',confidence:'low'}]})).toThrow('Unknown batch ref');
    expect(store.graphSummary().assets).toBe(1);
    expect(()=>store.recordGraph({assets:[{ref:'x',asset:{kind:'file',key:'one'}},{ref:'x',asset:{kind:'file',key:'two'}}]})).toThrow('Duplicate batch ref');
    expect(store.graphSummary().assets).toBe(1);
  }));
  it('does not normalize path case, percent encodings, query repeats/order, slash, method or IPv6 spellings into false aliases',async()=>fixture(async store=>{
    const keys=['GET http://[::1]:8080/A','GET http://[::1]:8080/a','GET http://[::1]:8080/a/','GET http://[::1]:8080/a%2Fb','GET http://[::1]:8080/a/b',
      'GET http://[::1]:8080/a?x=1&x=2','GET http://[::1]:8080/a?x=2&x=1','get http://[::1]:8080/a','CUSTOM http://[::1]:8080/a','GET http://[0:0:0:0:0:0:0:1]:8080/a'];
    const rows=store.recordGraph({assets:keys.map(key=>({asset:{kind:'endpoint',key}}))});expect(new Set(rows.map(r=>r.entityId)).size).toBe(keys.length);
    expect(store.graphSummary().assets).toBe(keys.length);
    for(const key of [' bad','bad ','e\u0301','a\u202eb'])expect(()=>store.recordGraph({assets:[{asset:{kind:'file',key}}]})).toThrow();
    const current=store.recordGraph({assets:[{asset:{kind:'file',key:'src/gate.py'}}]})[0];
    const root=await mkdtemp(join(tmpdir(),'p2o-graph-snapshot-'));const other=AssessmentStore.create(root,{...manifest('run-new'),sourceSnapshotSha256:'a'.repeat(64)});
    try{const changed=other.recordGraph({assets:[{asset:{kind:'file',key:'src/gate.py'}}]})[0];expect(changed.entityId).not.toBe(current.entityId);}finally{other.close();await rm(root,{recursive:true,force:true});}
  }));
  it('rejects secret-bearing identities/unknown fields and redacts attributes before content hashing, persistence and export',async()=>fixture(async store=>{
    const secrets=['GET https://user:VERY_SECRET@fixture.local/a','GET https://fixture.local/a?access_token=VERY_SECRET','GET https://fixture.local/a?%74oken=VERY_SECRET','password=VERY_SECRET','Bearer VERY_SECRET','-----BEGIN PRIVATE KEY-----VERY_SECRET'];
    for(const key of secrets)expect(()=>store.recordGraph({assets:[{asset:{kind:'endpoint',key}}]})).toThrow('secret-bearing');
    expect(()=>store.recordGraph({assets:[{asset:{kind:'file',key:'a',in_scope:true} as never}]})).toThrow('host-owned');
    expect(()=>store.recordGraph({assets:[{asset:{kind:'file',key:'a'}}],producer:{actorId:'owner'}} as never)).toThrow('host-owned');
    expect(()=>store.recordGraph({assets:'not-a-list'} as never)).toThrow('lists');
    expect(()=>store.recordGraph({assets:[{asset:{kind:'file',key:'a',attributes:Object.fromEntries(Array.from({length:17},(_,n)=>['k'+n,'v']))}}]})).toThrow('at most 16');
    const id=store.recordGraph({assets:[{asset:{kind:'file',key:'config.py',label:'password=VERY_SECRET',attributes:{password:'VERY_SECRET',description:'Bearer VERY_SECRET'}}}]} )[0].entityId;
    const retained=JSON.stringify({view:store.assetView(id),snapshot:store.graphSnapshot(),events:store.events({since:0}),exported:store.graphExport()});
    expect(retained).not.toContain('VERY_SECRET');expect(retained).toContain('[REDACTED]');
    expect(()=>store.recordGraph({facts:[{assetId:id,kind:'inferred',statement:'token=VERY_SECRET',confidence:'low'}]})).toThrow('secret-bearing');
    expect(()=>store.recordGraph({anchors:[{assetId:id,anchor:{kind:'header',value:'Authorization: Bearer VERY_SECRET'}}]})).toThrow('secret-bearing');
  }));
  it('deduplicates canonical property/ref order and supports current revision-pinned corrections without losing counterevidence',async()=>fixture(async store=>{
    const first=store.recordGraph({assets:[{asset:{kind:'file',key:'app.py',attributes:{b:'2',a:'1'}}}]})[0];
    expect(store.recordGraph({assets:[{asset:{kind:'file',key:'app.py',attributes:{a:'1',b:'2'}}}]})[0]).toMatchObject({created:false,revision:1});
    const positive=evidence(store,'positive receipt'),negative=evidence(store,'bounded negative control'),fact=store.recordGraph({facts:[{assetId:first.entityId,assetRevision:1,kind:'observed',statement:'initial observation',confidence:'low',evidenceRefs:[positive,negative]}]})[0];
    const correction=store.recordGraph({facts:[{assetId:first.entityId,assetRevision:1,kind:'observed',statement:'corrected bounded observation',confidence:'medium',evidenceRefs:[negative,positive],supersedes:fact.id}]})[0];
    expect(correction).toMatchObject({entityId:fact.entityId,revision:2,created:true});
    expect(()=>store.recordGraph({facts:[{assetId:first.entityId,kind:'observed',statement:'stale correction',confidence:'high',evidenceRefs:[positive],supersedes:fact.id}]})).toThrow('STALE_GRAPH_REFERENCE');
    const view=store.assetView(first.entityId);expect(view.assertions.map(r=>r.superseded)).toEqual([true,false]);
    const exported=store.graphExport();expect(exported.json.assertions).toHaveLength(1);expect(exported.json.assertions[0].statement).toBe('corrected bounded observation');
    store.recordGraph({assets:[{asset:{kind:'file',key:'app.py',attributes:{a:'changed',b:'2'},expectedRevision:1}}]});
    expect(()=>store.recordGraph({facts:[{assetId:first.entityId,assetRevision:1,kind:'inferred',statement:'stale input',confidence:'low'}]})).toThrow('STALE_GRAPH_REFERENCE');
    expect(()=>store.recordGraph({assets:[{asset:{kind:'file',key:'app.py',expectedRevision:1}}]})).toThrow('STALE_GRAPH_REFERENCE');
    expect(store.graphExport().json.assertions[0].stale).toBe(true);
  }));
  it('keeps anchor revisions and checks both endpoints for stale/withdrawn relations, without destructive alias merge',async()=>fixture(async store=>{
    const rows=store.recordGraph({assets:[{ref:'a',asset:{kind:'file',key:'a.py'}},{ref:'b',asset:{kind:'file',key:'b.py'}}],relations:[{kind:'alias_of',fromId:'@a',toId:'@b'}]});
    const a=rows[0].entityId,b=rows[1].entityId,edge=rows[2];
    const first=store.recordGraph({anchors:[{assetId:a,anchor:{kind:'path',value:'a.py',locator:{line:'1'}}}]})[0];
    const changed=store.recordGraph({anchors:[{assetId:a,anchor:{kind:'path',value:'a.py',locator:{line:'2'},supersedes:first.id}}]})[0];
    expect(changed).toMatchObject({entityId:first.entityId,revision:2});expect(store.assetView(a).counts.anchors).toBe(2);
    expect(store.graphExport().json.anchors).toHaveLength(1);expect(store.graphExport().json.anchors[0].locator).toEqual({line:'2'});
    store.recordGraph({assets:[{asset:{kind:'file',key:'b.py',label:'changed'}}]});
    expect(store.assetView(a).relations[0].stale).toBe(true);expect(store.graphExport().json.relations[0].stale).toBe(true);
    const withdrawn=store.recordGraph({relations:[{kind:'alias_of',fromId:a,toId:b,status:'withdrawn',supersedes:edge.id}]})[0];expect(withdrawn.revision).toBe(2);
    expect(store.graphSummary().assets).toBe(2);expect(store.graphExport().json.relations).toHaveLength(1);expect(store.graphExport().json.relations[0].status).toBe('withdrawn');
    expect(()=>store.recordGraph({relations:[{kind:'depends_on',fromId:a,toId:b,fromRevision:2}]})).toThrow('STALE_GRAPH_REFERENCE');
  }));
  it('bounds effective batch rows, byte-sized reads and whole-sequence history pagination without losing old rows',async()=>fixture(async store=>{
    expect(()=>store.recordGraph({assets:Array.from({length:13},(_,i)=>({asset:{kind:'file',key:'f'+i,anchors:Array.from({length:10},(_,n)=>({kind:'symbol',value:'s'+n}))}}))} as never)).toThrow('including nested anchors');
    const asset=store.recordGraph({assets:[{asset:{kind:'file',key:'many.py'}}]})[0];
    for(let i=0;i<30;i++)store.recordGraph({facts:[{assetId:asset.entityId,kind:'inferred',statement:`question ${i}: `+'€'.repeat(450),confidence:'low'}]});
    let cursor=0,asOfSequence=store.sequence();const seen=new Set<string>();
    for(let pages=0;pages<40;pages++){const view=store.assetView(asset.entityId,{since:cursor,limit:3,asOfSequence});expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
      for(const row of [...view.revisions,...view.assertions,...view.provenance]){expect(seen.has(row.id)).toBe(false);seen.add(row.id);}
      if(view.nextCursor===undefined)break;expect(view.nextCursor).toBeGreaterThan(cursor);cursor=view.nextCursor;
    }
    expect(seen.size).toBe(62); // one asset + 30 assertions + 31 matching provenance entries
    const exported=store.graphExport();expect(Buffer.byteLength(JSON.stringify(exported))).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);expect(exported.omittedByKind.assertions).toBeGreaterThan(0);
    const page=store.graphPage({limit:100});expect(page.uniqueAssets).toBe(1);expect(page.total).toBe(1);
    expect(()=>store.graphPage({limit:'20' as never})).toThrow();expect(()=>store.assetView(asset.entityId,{since:-1})).toThrow();expect(()=>store.graphExport({limit:501})).toThrow();
  }));
  it('puts graph revisions/provenance in checkpoint barrier and rebuilds the exact graph from snapshot + event tail',async()=>fixture(async store=>{
    const id=store.recordGraph({assets:[{asset:{kind:'route',key:'/private'}}]})[0].entityId,checkpoint=store.checkpoint('graph barrier');
    const snapshot=store.inspectCheckpoint(checkpoint.id).snapshot!.graph!;expect(checkpoint.graph!.heads).toMatchObject({assets:1,assertions:0});
    const receipt=evidence(store,'new bounded control');store.recordGraph({facts:[{assetId:id,kind:'observed',statement:'actor B denied at this boundary',confidence:'medium',evidenceRefs:[receipt]}]});
    store.recordGraph({assets:[{asset:{kind:'route',key:'/private'}}]},{actorId:'worker-two',requestId:'observe',payload:'bounded'},{actorId:'worker-two',taskId:'task-two',role:'recon',depth:1});
    const tail=store.events({since:snapshot.asOfSequence,limit:100}).rows,reconstructed=applyGraphEvents(snapshot,tail);
    expect(reconstructed).toEqual(store.graphSnapshot());expect(applyGraphEvents(reconstructed,tail)).toEqual(reconstructed);
    expect(store.inspectCheckpoint(checkpoint.id)).toMatchObject({integrityStatus:'complete',currentness:'changed-since-checkpoint',authorityRestored:false});
    const graphEvent=tail.find(e=>e.data?.graph)!;expect(()=>applyGraphEvents(snapshot,[{...graphEvent,runId:'run-foreign'}])).toThrow('Foreign');
    const before=store.graphScope();expect(()=>store.sealSource({'new.py':'a'.repeat(64)},0)).toThrow('after graph recording');expect(store.graphScope()).toBe(before);
  }));
  it('renders hostile labels as inert Mermaid text with distinct assertion nodes, not proof or diagram directives',async()=>fixture(async store=>{
    const id=store.recordGraph({assets:[{asset:{kind:'file',key:'x"] --> Z["<script>boom</script> %%'}}]})[0].entityId;
    store.recordGraph({facts:[{assetId:id,kind:'inferred',statement:'line"] click x "javascript:boom"',confidence:'low'}]});
    const exported=store.graphExport();expect(exported.mermaid).not.toContain('<script>');expect(exported.mermaid).not.toContain('javascript:boom"');
    expect(exported.mermaid).toContain('#34;');expect(exported.mermaid).not.toMatch(/^\s*(?:click|classDef|style|%%)/m);
    expect(exported.mermaid).toContain('nassertion');expect(exported.mermaid).toContain('nasset');expect(exported.json.warning).toContain('not verified');
  }));
  it.each([3,4])('refuses older schema %s instead of migrating graph-less stores in place', async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-graph-v3-'));
    try {
      const store = AssessmentStore.create(root, manifest('run-graph')); store.recordGraph({ assets: [{ asset: { kind: 'file', key: 'x' } }] });
      const directory = store.location; store.close();
      const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(directory, 'assessment.sqlite')); db.exec(`PRAGMA user_version=${version}`); db.close();
      const reader = AssessmentStore.open(root, 'run-graph');
      try { expect(reader.compatible).toBe(false); expect(reader.schemaVersion).toBe(version);
        expect(() => reader.recordGraph({ assets: [{ asset: { kind: 'file', key: 'x' } }] })).toThrow(`Unsupported state schema ${version}`);
        expect(() => AssessmentStore.open(root, 'run-graph', { readOnly: false })).toThrow(`Unsupported state schema ${version}`);
      } finally { reader.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
