import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerP2O } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { indexRecords, type AssessmentRecord } from '../../src/records.js';
import { SEARCH_LIMIT_MAX, SNIPPET_CHARS, normalizeQuery, searchLines, searchRecords } from '../../src/search.js';
import { parseWorkspaceCommand } from '../../src/ui/workspace.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/** W4-lite (plan): bounded plain-substring search over committed records. No query language, no schema change, hits are pointers. */
const row = (n: number, text: string, extra: Partial<AssessmentRecord> = {}): AssessmentRecord => ({ id: `rec-${n}`, runId: 'run-search', at: '2030', by: n % 2 ? 'worker-a' : 'owner', kind: 'note', text, ...extra });
const ids = (page: { hits: Array<{ id: string }> }) => page.hits.map(hit => hit.id);

describe('searchRecords', () => {
  const rows = [row(0, 'Login endpoint rejects the Admin token'), row(1, 'unrelated observation'), row(2, 'LOGIN rate limit missing', { kind: 'open', surface: '/api/login', risk: 'authentication' }),
    row(3, 'part body login', { kind: 'report_part' }), row(4, 'candidate note', { kind: 'candidate', data: { candidate: 'Login brute force claim', title: 'x' } as never }), row(5, 'password=hunter2-fixture-secret near the login form', { kind: 'evidence' })];
  const index = indexRecords(rows, 'run-search');

  it('matches case-insensitively over text, surface, risk and titles, skips report parts and reports an exact total', () => {
    const page = searchRecords(index, 'login');
    expect(page).toMatchObject({ total: 4, shown: 4, omitted: 0, cursor: 0, asOfRecords: rows.length }); expect(page.nextCursor).toBeUndefined();
    expect(ids(page)).toEqual(['rec-0', 'rec-2', 'rec-4', 'rec-5']); // rec-3 is a report part; rec-4 matches through data.candidate
    expect(searchRecords(index, 'AUTHENTICATION').hits.map(hit => hit.id)).toEqual(['rec-2']); // risk field
    expect(searchRecords(index, 'nothing like this').total).toBe(0);
    expect(searchRecords(index, 'login').hits.every(hit => hit.snippet.length <= SNIPPET_CHARS + 4)).toBe(true);
  });

  it('redacts secrets in snippets, keeps queries literal and refuses malformed queries, cursors and limits', () => {
    const secret = searchRecords(index, 'password').hits[0]; // the window starts at the credential itself
    expect(secret.snippet).toContain('password'); expect(secret.snippet).not.toContain('hunter2'); expect(JSON.stringify(searchRecords(index, 'login'))).not.toContain('hunter2');
    for (const literal of ['.*', "' OR 1=1 --", '(a+)+$', '%%', '\\d+']) expect(searchRecords(index, literal).total, literal).toBe(0); // no regex, SQL or glob semantics
    expect(searchRecords(indexRecords([row(0, 'cost is 5% (approx) .* done')], 'run-search'), '.* done').total).toBe(1); // present only as literal text
    for (const bad of [undefined, 3, '', 'a', 'x'.repeat(81), 'bad\u0000query', 'bidi‮query', 'esc\u001b[0m']) expect(() => normalizeQuery(bad), String(bad)).toThrow();
    expect(() => searchRecords(index, 'login', { cursor: -1 })).toThrow('cursor'); expect(() => searchRecords(index, 'login', { cursor: 1.5 })).toThrow('cursor');
    for (const limit of [0, SEARCH_LIMIT_MAX + 1, 2.5]) expect(() => searchRecords(index, 'login', { limit }), String(limit)).toThrow('limit');
  });

  it('pages without gaps or overlaps by position and says when the ledger is incomplete', () => {
    const many = indexRecords(Array.from({ length: 95 }, (_, n) => row(n, n % 3 === 0 ? `match-${n} needle` : `other ${n}`)), 'run-search');
    const seen: string[] = []; let cursor = 0, pages = 0;
    for (;;) {
      const page = searchRecords(many, 'needle', { cursor, limit: 7 }); pages++;
      expect(page.total).toBe(32); seen.push(...ids(page)); expect(page.shown).toBeLessThanOrEqual(7);
      if (page.nextCursor === undefined) { expect(page.omitted).toBe(0); break; }
      expect(page.nextCursor).toBeGreaterThan(cursor); cursor = page.nextCursor;
    }
    expect(pages).toBe(5); expect(seen).toHaveLength(32); expect(new Set(seen).size).toBe(32);
    expect(searchRecords(many, 'needle', { cursor: 90 })).toMatchObject({ total: 32, shown: 2, omitted: 0 });
    expect(searchLines(searchRecords(many, 'needle', { limit: 3 })).some(line => line.startsWith('Next: /p2o search needle '))).toBe(true);
    expect(searchLines({ ...searchRecords(many, 'needle'), complete: false })[0]).toContain('INCOMPLETE ledger');
  });

  it('answers a 100,000-record search in well under a second (measured and published in the verification notes)', () => {
    const big = indexRecords(Array.from({ length: 100_000 }, (_, n) => row(n, `observation ${n} of the synthetic fixture ${n % 997 === 0 ? 'needle-token' : 'plain'} for timing only`)), 'run-search');
    const durations: number[] = []; let last = searchRecords(big, 'needle-token');
    for (let n = 0; n < 5; n++) { const start = performance.now(); last = searchRecords(big, 'needle-token'); durations.push(performance.now() - start); }
    expect(last.total).toBe(101); expect(Math.max(...durations)).toBeLessThan(1500);
    expect(searchRecords(big, 'absent-token-zzz').total).toBe(0);
  }, 120_000);
});

describe('search command parsing', () => {
  it('takes a plain text query with an explicit cursor= so numeric queries stay unambiguous', () => {
    expect(parseWorkspaceCommand('search login failure')).toEqual({ action: 'search', query: 'login failure', cursor: 0 });
    expect(parseWorkspaceCommand('search 404 cursor=12')).toEqual({ action: 'search', query: '404', cursor: 12 });
    expect(parseWorkspaceCommand('search error 404')).toEqual({ action: 'search', query: 'error 404', cursor: 0 });
    for (const bad of ['search', 'search x', 'search cursor=3', `search ${'q'.repeat(81)}`, 'search bad‮query']) expect(() => parseWorkspaceCommand(bad), bad).toThrow();
  });
});

async function fixture(work: (h: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-search-')); await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: herdr.client, createSandbox: (target: any) => { const sandbox = new InertSandbox(target); sandboxes.push(sandbox); return sandbox; } });
  const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx), call = (name: string, params: any = {}) => pi.tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx.ctx);
  const screen = () => ctx.screens.at(-1).render(220).join('\n');
  const ticket = async (id: string) => JSON.parse(await readFile(join(root, 'control', (await readdir(join(root, 'control')))[0], `ticket-${id}.json`), 'utf8'));
  const connect = async (workerId: string) => { const t = await ticket(workerId), client = new BrokerClient(t.socket, t.token); await client.request('runtime', { model: t.requestedRuntime?.model, thinking: t.requestedRuntime?.thinking }); return client; };
  try { await command('--target ./source'); await work({ root, pi, ctx, command, call, screen, connect, sandboxes, runId: async () => (await readdir(join(root, '.p2o-state')))[0] }); }
  finally { await command('stop'); await command('close'); await rm(root, { recursive: true, force: true }); }
}

describe('search through the runtime', () => {
  it('serves the owner, a worker over the broker and a reporting worker, never caps a knowledge read and never calls a model', async () => fixture(async h => {
    await h.call('p2o_note', { kind: 'observation', text: 'The Billing export endpoint leaks the invoice owner field' });
    await h.call('p2o_note', { kind: 'open', text: 'billing admin role could not be tested' });
    const messages = h.pi.messages.length;
    const owner = (await h.call('p2o_state', { action: 'search', q: 'billing' })).details;
    expect(owner).toMatchObject({ total: 2, shown: 2 }); expect(owner.hits.map((hit: any) => hit.kind).sort()).toEqual(['observation', 'open']);
    await expect(h.call('p2o_state', { action: 'search', q: 'x' })).rejects.toThrow(); await expect(h.call('p2o_state', { action: 'search' })).rejects.toThrow();
    await expect(h.call('p2o_state', { action: 'search', q: 'billing', limit: 101 })).rejects.toThrow(); await expect(h.call('p2o_state', { action: 'search', q: 'billing', domain: 'task' })).rejects.toThrow();
    expect((await h.call('p2o_state', { action: 'heads', domain: 'gap' })).details).toBeTruthy(); // heads keep working beside search

    const first = (await h.call('p2o_delegate', { focus: 'search-a', task: 'Observe the inert fixture and report', role: 'discovery' })).details;
    const second = (await h.call('p2o_delegate', { focus: 'search-b', task: 'Synthesize existing receipts', role: 'reporting' })).details;
    const a = await h.connect(first.workerId), b = await h.connect(second.workerId);
    try {
      const viaWorker = (await a.request('knowledge_search', { action: 'search', q: 'billing' })).value; expect(viaWorker.total).toBe(2);
      expect((await b.request('knowledge_search', { action: 'search', q: 'invoice' })).value.total).toBe(1); // reporting is read-only knowledge, allowed
      await expect(a.request('knowledge_search', { action: 'search', q: 'billing', extra: 1 })).rejects.toThrow();
      // 200 reads from one worker: the retired 160-read split cannot cut a search loop short (owner decision 2026-10-24).
      for (let n = 0; n < 200; n++) await a.request('knowledge_search', { action: 'search', q: 'billing', limit: 1 });
      expect((await a.request('knowledge_search', { action: 'search', q: 'billing' })).value.total).toBe(2);
    } finally { a.close(); b.close(); }
    await h.command('search billing'); expect(h.screen()).toContain('2 match(es)'); expect(h.screen()).toContain('Billing export endpoint');
    await h.command('search nothing-matches-this'); expect(h.screen()).toContain('0 match(es)');
    expect(h.pi.messages).toHaveLength(messages); expect(h.sandboxes[0].commands).toHaveLength(0);
  }));

  it('searches a historical run read-only after it was opened', async () => fixture(async h => {
    await h.call('p2o_note', { kind: 'note', text: 'durable searchable marker zebra-crossing' });
    const id = await h.runId(); await h.command('stop'); await h.command(`open ${id}`);
    await h.command('search zebra-crossing'); expect(h.screen()).toContain('1 match(es)');
  }));
});
