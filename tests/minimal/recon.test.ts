import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ownerInstructions, reconInstructions, workerInstructions, workerBrief } from '../../src/prompts.js';
import { createHash } from 'node:crypto';
import type { Ticket } from '../../src/ticket.js';
import { SkillLibrary } from '../../src/skills.js';
import { EvidenceStore } from '../../src/evidence.js';
import { appendRecord, readRecords } from '../../src/records.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copySource } from '../../src/source.js';

// Contract/mechanical checks, not an autonomous-agent quality benchmark.
describe('bounded recon contract', () => {
  it('distinguishes source mapping from URL permissions and includes corrective next-task reasoning', () => {
    const facts = { runId: 'run-recon', targetLabel: '/target', targetKind: 'directory' as const, deadline: '2030-01-01', sourceSkipped: 2,
      delegation: { enabled: false, maxWorkers: 1, maxDepth: 1 }, workerBudget: 20 };
    const source = ownerInstructions(facts);
    expect(source).toContain('Source recon:');
    expect(source).toContain('asynchronous consumers');
    expect(source).toContain('Git history and omitted dependencies remain unknown');
    expect(source).toContain('correct them when evidence contradicts them');
    expect(source).toContain('why it is next');
    expect(source).toContain('same-run Evidence IDs');
    expect(source).not.toContain('CAPABILITIES');
    expect(source).not.toMatch(/\bp2o_[a-z_]+\b|nextOffset|offset\?|supersedes=|policyBasis=/);
    expect(source.length).toBeLessThan(5000);
    expect(source).toContain('Only the human can change confirmed scope');
    expect(source).toContain('never bypass scope');
    expect(source).toContain('missing, blocked or untested proof remain open_proof_gap');
    expect(source).toContain('specific effective control and location');
    expect(source).toContain('separate worker reproducing the effect');
    expect(source).toContain('complete verified cleanup before the final report');
    const url = reconInstructions('url');
    expect(url).toContain('same-origin GET/HEAD');
    expect(url).toContain('No other origins, port scans, login, redirects, form submission or state changes');
    expect(url).toContain('inferred, not deployment proof');
  });

  it.each([
    ['url', 'cc9c5d89d6192d2caff26cfe16c87603c9876386fae05f2d09a6cdb0910ad28d', 'd46788388126e353c5744c364e1390e75c98f69e9da043156651dcdaf2ee67c3'],
    ['directory', 'c720eba4021e5c67b900d051bc29b6fbfb78994caab53de26d3a1b914e04d65a', 'dfad83371227e967125d31a208fd7c417214dcaba90d471e4b33ed721f5b10b9'],
  ])('keeps %s worker instructions and briefs byte-identical to 8f6db40', (kind, instructionHash, briefHash) => {
    const ticket = { workerId: 'worker-test', role: 'recon', runId: 'run-test', depth: 1, parentWorkerId: null,
      expiresAt: 1893456000000, target: { kind, label: kind === 'url' ? 'https://example.invalid' : '/target' }, commandBudget: 20 } as Ticket;
    const input = { ticket, focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work', skills: [{ name: 'test', body: 'Approved fixture guidance' }] };
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(hash(workerInstructions(ticket))).toBe(instructionHash);
    expect(hash(workerBrief(input))).toBe(briefHash);
  });

  it('serves descriptive prerequisites, rejects a legacy capability registry and malformed prose', async () => {
    const library = new SkillLibrary(resolve(import.meta.dirname, '../..'));
    const catalog = await library.load();
    expect(JSON.stringify(catalog.skills)).not.toMatch(/allOf|anyOf|source\.snapshot/);
    expect(catalog.skills.flatMap(s => s.workflows).some(w => w.prerequisites?.length)).toBe(true);
    const root = await mkdtemp(join(tmpdir(), 'p2o-catalog-recon-'));
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'skills'));
      for (const malformed of [{ allOf: ['source.snapshot'] }, { prerequisites: ['x'] }, { prerequisites: [42] }]) {
        await writeFile(join(root, 'skills/catalog.json'), JSON.stringify({ version: 1,
          documents: [{ id: 'test', path: 'test.md' }], skills: [{ name: 'test', description: 'A sufficiently descriptive skill', kind: 'technique', document: 'test',
            workflows: [{ id: 'review', description: 'A sufficiently descriptive workflow', ...malformed }] }] }));
        await expect(new SkillLibrary(root).load()).rejects.toThrow('Invalid workflow');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves evidence-linked inventory, changed assumptions, decision and missing-scanner gap without capability metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-recon-ledger-'));
    try {
      const path = join(root, 'records.jsonl');
      const store = new EvidenceStore('run-recon', path, '/target');
      const snapshot = await copySource(resolve(import.meta.dirname, 'fixtures/recon-source'));
      let output: { stdout: string; stderr: string };
      const script = `import json,runpy,sys\nm=runpy.run_path(sys.argv[1]); q=[]; principal={'id':'member','tenant':'a'}; m['enqueue_export'](principal,q)\nprint(json.dumps({'routes':list(m['ROUTES'].values()),'allowed':m['read_order'](principal,{'id':1,'tenant':'a'}),'denied':m['read_order'](principal,{'id':2,'tenant':'b'}),'consumer':m['publish_export'](q[0],{'id':'service'})}))`;
      try {
        output = await promisify(execFile)('python3', ['-c', script, join(snapshot.path, 'app.py')], { timeout: 5000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
        expect(Object.keys(snapshot.manifest).sort()).toEqual(['README.md', 'app.py']);
        expect(JSON.parse(output.stdout)).toEqual({ routes: ['health', 'read_order', 'enqueue_export'], allowed: { status: 'ok', id: 1 }, denied: { status: 'denied' }, consumer: { tenant: 'a', executor: 'service' } });
      } finally { await rm(snapshot.path, { recursive: true, force: true }); }
      const receipt = await store.receipt('owner', 'shell', `python3 -c ${script} app.py (owned offline fixture)`, {
        code: 0, stdout: output.stdout, stderr: output.stderr, truncated: false,
      }, new Date().toISOString());
      await appendRecord(path, { runId: 'run-recon', at: new Date().toISOString(), by: 'owner', kind: 'note', text: 'Inventory: orders/read input=id; actor=tenant member; gate=tenant_guard; consumer=read_order. Async publisher identity remains inferred.', refs: [receipt] });
      await appendRecord(path, { runId: 'run-recon', at: new Date().toISOString(), by: 'owner', kind: 'note', text: 'Correction: service principal is not the initiating tenant. Next surface/risk: queue publisher/authorization; ambiguity at async boundary justifies mapping consumer identity before discovery. Expected observation: policy consumes tenant identity; stop after tracing the gate or record deployment uncertainty.', refs: [receipt] });
      const missing = await store.receipt('owner', 'shell', 'command -v optional-scanner', { code: 127, stdout: '', stderr: 'not installed', truncated: false }, new Date().toISOString());
      await expect(store.candidate('owner', { candidate: 'missing-scanner', surface: 'queue', risk: 'authorization', closure: 'open_proof_gap', execution: 'blocked', proof: 'static_trace', evidenceRefs: [missing], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Consumer should preserve tenant isolation; contract not established', limitations: 'No deployment artifact or optional scanner; no installation attempted', requirement: '' })).rejects.toThrow('prerequisite reason');
      await store.candidate('owner', { candidate: 'missing-scanner', surface: 'queue', risk: 'authorization', closure: 'open_proof_gap', execution: 'blocked', proof: 'static_trace', evidenceRefs: [missing], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Consumer should preserve tenant isolation; contract not established', limitations: 'No deployment artifact or optional scanner; no installation attempted', requirement: 'Optional scanner binary is absent in the offline sandbox' });
      const exported = JSON.parse(await readFile(await store.exportTo(root, { sourceHashes: snapshot.manifest, reason: 'test' }), 'utf8'));
      expect(exported.manifest).not.toHaveProperty('capabilities');
      expect((await readRecords(path)).filter(r => r.kind === 'note').every(r => r.refs?.includes(receipt))).toBe(true);
      expect(exported.records.at(-1).data).toMatchObject({ execution: 'blocked', closure: 'open_proof_gap' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
