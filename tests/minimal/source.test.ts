import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copySource, PRIVATE_KNOWLEDGE_MARKER } from '../../src/source.js';

it('copies only regular source files, not external symlinks, host sockets or dependency trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-source-test-'));
  const server = createServer(); let copied: string | undefined;
  try {
    await writeFile(join(root, 'source.txt'), 'original');
    await symlink('/etc/passwd', join(root, 'outside-link'));
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules/ignored'), 'ignored');
    await new Promise<void>(resolve => server.listen(join(root, 'service.sock'), resolve));
    const result = await copySource(root); copied = result.path;
    expect(result.skipped).toBe(3); expect(await readdir(copied)).toEqual(['source.txt']);
    await writeFile(join(root, 'source.txt'), 'changed');
    expect(await readFile(join(copied, 'source.txt'), 'utf8')).toBe('original');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (copied) await rm(copied, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it('hashes special object-key filenames without losing manifest entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-source-manifest-'));
  let copy: string | undefined;
  try {
    await writeFile(join(root, '__proto__'), 'owned source bytes');
    const result = await copySource(root); copy = result.path;
    expect(Object.keys(result.manifest)).toEqual(['__proto__']);
    expect(result.manifest.__proto__).toBe(createHash('sha256').update('owned source bytes').digest('hex'));
  } finally { if (copy) await rm(copy, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

it('excludes current control/custom knowledge and prior reserved private roots, not similarly named source', async () => {
  const root=await mkdtemp(join(tmpdir(),'p2o-source-private-'));let copy:string|undefined;
  try {
    for(const name of ['control','state','statement','.p2o-state','.p2o-reports']) {await mkdir(join(root,name));await writeFile(join(root,name,'data'),name);}
    await writeFile(join(root,'app.py'),'original source');
    const result=await copySource(root,[join(root,'control'),join(root,'state')]);copy=result.path;
    expect(result.skipped).toBe(4);expect(Object.keys(result.manifest).sort()).toEqual(['app.py','statement/data']);
    expect(await readdir(copy)).toEqual(['app.py','statement']);
    await expect(copySource(root,['relative-state'])).rejects.toThrow('absolute');
  } finally {if(copy)await rm(copy,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
it('does not expose prior custom store/control bytes even if their root is selected as source', async () => {
  const root=await mkdtemp(join(tmpdir(),'p2o-source-old-private-'));const copies:string[]=[];
  try {
    await mkdir(join(root,'custom-store'));for(const name of ['assessment.sqlite','writer.lock'])await writeFile(join(root,'custom-store',name),'private knowledge');
    await mkdir(join(root,'p2o-run-abcdef'));await writeFile(join(root,'p2o-run-abcdef','ticket.json'),'private authority');
    for(const path of [root,join(root,'custom-store'),join(root,'p2o-run-abcdef')]){const result=await copySource(path);copies.push(result.path);expect(result.manifest).toEqual({});expect(result.skipped).toBeGreaterThan(0);}
    expect(await readdir(join(copies[0],'custom-store'))).toEqual([]);expect(await readdir(join(copies[0],'p2o-run-abcdef'))).toEqual([]);
  } finally {for(const copy of copies)await rm(copy,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
it('does not recursively copy its own destination when TMPDIR is inside the target', async () => {
  const root=await mkdtemp(join(tmpdir(),'p2o-source-nested-')),previous=process.env.TMPDIR;let copy:string|undefined;
  try {
    await mkdir(join(root,'temporary'));await writeFile(join(root,'app.py'),'original source');process.env.TMPDIR=join(root,'temporary');
    const result=await copySource(root);copy=result.path;
    expect(result.skipped).toBe(1);expect(Object.keys(result.manifest)).toEqual(['app.py']);
    expect(await readdir(join(copy,'temporary'))).toEqual([]);
  } finally {if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;if(copy)await rm(copy,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});

it('excludes owner portable knowledge exports, including when a bundle root is selected directly',async()=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-source-bundle-')),copies:string[]=[];
  try{await mkdir(join(root,'bundle'));await writeFile(join(root,'app.py'),'target source');await writeFile(join(root,'bundle',PRIVATE_KNOWLEDGE_MARKER),'private owner marker');await writeFile(join(root,'bundle','manifest.json'),'private run identity');await writeFile(join(root,'bundle','records.ndjson'),'private assessment notes');
    const target=await copySource(root);copies.push(target.path);expect(Object.keys(target.manifest)).toEqual(['app.py']);expect(await readdir(join(target.path,'bundle'))).toEqual([]);
    const direct=await copySource(join(root,'bundle'));copies.push(direct.path);expect(direct.manifest).toEqual({});expect(direct.skipped).toBe(1);
  }finally{for(const path of copies)await rm(path,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
it('recognizes markerless prior bundle v1 roots without suppressing ordinary source manifests',async()=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-source-legacy-bundle-')),copies:string[]=[];
  try{await mkdir(join(root,'old-bundle'));await mkdir(join(root,'.p2o-export-interrupted'));await writeFile(join(root,'.p2o-export-interrupted','records.ndjson'),'private interrupted export');await writeFile(join(root,'app.py'),'source');await writeFile(join(root,'manifest.json'),JSON.stringify({name:'public app',version:1}));
    await writeFile(join(root,'old-bundle','manifest.json'),JSON.stringify({version:1,redactionVersion:2,authorityRestored:false,runId:'run-old',bundleSha256:'a'.repeat(64),files:[]}));await writeFile(join(root,'old-bundle','notes'),'private prior knowledge');
    const target=await copySource(root);copies.push(target.path);expect(Object.keys(target.manifest).sort()).toEqual(['app.py','manifest.json']);expect(await readdir(join(target.path,'old-bundle'))).toEqual([]);
    for(const selected of ['old-bundle','.p2o-export-interrupted']){const direct=await copySource(join(root,selected));copies.push(direct.path);expect(direct.manifest).toEqual({});expect(direct.skipped).toBe(1);}
  }finally{for(const path of copies)await rm(path,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
it('refuses an oversized source without leaving a partial copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-source-large-'));
  try {
    const { open } = await import('node:fs/promises');
    const file = await open(join(root, 'large'), 'w'); await file.truncate(65 * 1024 * 1024); await file.close();
    await expect(copySource(root)).rejects.toThrow('64 MiB');
  } finally { await rm(root, { recursive: true, force: true }); }
});
