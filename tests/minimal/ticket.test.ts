import { describe, expect, it } from 'vitest';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { ensurePrivateDirectory, extensionDigest, mintTicket, readTicket, removeTicket, ticketPath, workerName, type Ticket } from '../../src/ticket.js';

const IMAGE = 'example.invalid/image@sha256:' + 'a'.repeat(64);
const EXTENSION = '/opt/p2o/extensions/p2o/index.ts';
const SHA = extensionDigest('fake extension source');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'p2o-ticket-'));
  const control = join(root, 'control');
  await ensurePrivateDirectory(control);
  await mkdir(join(control, 'reports'), { recursive: true, mode: 0o700 });
  const server = createServer();
  const socket = join(control, 'sandbox.sock');
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const records = join(control, 'records.jsonl');
  await writeFile(records, '', { mode: 0o600 });
  const ticket: Ticket = {
    version: 2, runId: 'run-1', workerId: workerName('validation'), paneId: 'w1T:p2', parentWorkerId: null, depth: 1,
    role: 'validation', target: { kind: 'url', label: 'https://example.com', origin: 'https://example.com' },
    image: IMAGE, socket, records, reports: join(control, 'reports'), lifetime: 'until-stopped',
    extension: { path: EXTENSION, sha256: SHA }, token: 'b'.repeat(32),
  };
  const path = await mintTicket(control, ticket);
  const expectations = { image: IMAGE, extensionPath: EXTENSION, extensionSha: SHA };
  return { root, control, socket, records, ticket, path, expectations, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

describe('worker tickets', () => {
  it('mints an owner-private ticket and validates it', async () => {
    const f = await fixture();
    try {
      expect((await stat(f.path)).mode & 0o777).toBe(0o600);
      const ticket = await readTicket(f.path, f.expectations);
      expect(ticket.workerId).toBe(f.ticket.workerId);
      expect(ticket.token).toBe(f.ticket.token);
      expect(ticket.lifetime).toBe('until-stopped');
      expect(await readTicket(f.path,{...f.expectations,now:Date.now()+365*24*60*60*1000})).toEqual(ticket);
    } finally { await f.close(); }
  });

  it('rejects a permissive ticket, a permissive directory, an implicit/legacy lifetime and a foreign identity', async () => {
    const f = await fixture();
    try {
      await chmod(f.path, 0o644);
      await expect(readTicket(f.path, f.expectations)).rejects.toThrow(/owner-private \(0600\)/);
      await chmod(f.path, 0o600);
      await chmod(f.control, 0o755);
      await expect(readTicket(f.path, f.expectations)).rejects.toThrow(/directory must be owner-private/);
      await chmod(f.control, 0o700);
      for (const patch of [{expiresAt:Date.now()-1},{lifetime:undefined},{lifetime:null},{lifetime:'forever'},{deadline:Date.now()+1000}]) {
        await writeFile(f.path,JSON.stringify({...f.ticket,...patch}),{mode:0o600});
        await expect(readTicket(f.path,f.expectations)).rejects.toThrow(/lifetime/);
      }
      await writeFile(f.path, JSON.stringify(f.ticket), { mode: 0o600 });
      await expect(readTicket(f.path, { ...f.expectations, extensionSha: extensionDigest('other') })).rejects.toThrow(/extension identity/);
      await expect(readTicket(f.path, { ...f.expectations, image: 'other' })).rejects.toThrow(/image/);
    } finally { await f.close(); }
  });

  it('rejects malformed identity, escape paths and missing sockets', async () => {
    const f = await fixture();
    try {
      const cases: Array<[Partial<Ticket>, RegExp]> = [
        [{ workerId: 'worker' }, /workerId/],
        [{ socket: '/tmp/evil.sock' }, /socket must live/],
        [{ records: '/tmp/records.jsonl' }, /records and reports/],
        [{ depth: 9 }, /depth/],
        [{ token: 'nope' }, /token/],
        [{ target: { kind: 'url', label: 'x' } as Ticket['target'] }, /origin/],
        [{ version: 1 as any }, /version/],
      ];
      for (const [patch, pattern] of cases) {
        await writeFile(f.path, JSON.stringify({ ...f.ticket, ...patch }), { mode: 0o600 });
        await expect(readTicket(f.path, f.expectations), JSON.stringify(patch)).rejects.toThrow(pattern);
      }
      await writeFile(f.path, '{not json', { mode: 0o600 });
      await expect(readTicket(f.path, f.expectations)).rejects.toThrow(/valid JSON/);
      await removeTicket(f.path);
      await expect(readTicket(f.path, f.expectations)).rejects.toThrow(/no ticket/);
    } finally { await f.close(); }
  });

  it('refuses when the owner socket is gone, and the control directory stays private', async () => {
    const f = await fixture();
    try {
      await rm(f.socket, { force: true });
      await expect(readTicket(f.path, f.expectations)).rejects.toThrow(/socket is not available/);
      const info = await lstat(f.control);
      expect(info.mode & 0o777).toBe(0o700);
      expect((await lstat(f.records)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(f.control, 'records.jsonl'), 'utf8')).toBe('');
      const name = ticketPath(f.control, 'p2o-recon-abcdef');
      expect(name.endsWith('ticket-p2o-recon-abcdef.json')).toBe(true);
    } finally { await f.close(); }
  });
});
