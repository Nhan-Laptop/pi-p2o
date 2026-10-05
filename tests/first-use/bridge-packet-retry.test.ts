import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
const extensionPath = resolve(import.meta.dirname, '../../examples/local-assessment/bridge-extension.js');

describe('p2o_packet returned-for-evidence retry discipline', () => {
  it('surfaces the admission reason, allows one correction, then stops without a third admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-packet-retry-'));
    const workspace = join(root, 'w');
    await mkdir(workspace, { mode: 0o700 });
    const socketPath = join(root, 'b.sock');
    const descriptor = { socketPath, taskId: 'task-packet-retry' };
    await writeFile(join(workspace, 'p2o-bridge.json'), JSON.stringify(descriptor), { mode: 0o600 });
    const configPath = join(root, 'worker.json');
    await writeFile(configPath, JSON.stringify({
      token: 'fixture-owner-token', workspace,
      toolPolicy: { mode: 'sandbox-extension', tools: ['p2o_packet'], extension: { path: extensionPath, sha256: createHash('sha256').update(await readFile(extensionPath)).digest('hex') } },
    }), { mode: 0o600 });

    const previousConfig = process.env.P2O_CONFIG;
    process.env.P2O_CONFIG = configPath;
    let admissionCalls = 0;
    const server = createServer(socket => {
      let pending = '';
      socket.on('data', chunk => {
        pending += chunk.toString('utf8');
        const end = pending.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(pending.slice(0, end)) as { id: string; operation: string };
        expect(request.operation).toBe('packet.admit');
        admissionCalls += 1;
        socket.end(`${JSON.stringify({ id: request.id, ok: true, data: { accepted: false, reasons: ['future-packet'] } })}\n`);
      });
    });

    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => { server.removeListener('error', reject); resolveListen(); });
      });
      const tools = new Map<string, any>();
      const { default: bridgeExtension } = await import(pathToFileURL(extensionPath).href);
      bridgeExtension({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
      const packet = JSON.stringify({ contract: 'H1', createdAt: '2099-01-01T00:00:00.000Z' });
      let aborts = 0;
      const context = { abort: async () => { aborts += 1; } };
      const submit = () => tools.get('p2o_packet').execute('packet', { packet }, new AbortController().signal, undefined, context);

      const first = await submit();
      expect(first.content[0].text).toContain('returned-for-evidence');
      expect(first.content[0].text).toContain('future-packet');
      expect(first.content[0].text).toContain('one final p2o_packet call');
      expect(admissionCalls).toBe(1);
      expect(aborts).toBe(0);

      const second = await submit();
      expect(second.content[0].text).toContain('returned-for-evidence');
      expect(second.content[0].text).toContain('one correction was also returned');
      expect(second.content[0].text).toContain('No further packet retry is allowed');
      expect(admissionCalls).toBe(2);
      expect(aborts).toBe(1);

      const third = await submit();
      expect(third.content[0].text).toContain('correction limit exhausted');
      expect(admissionCalls, 'the retry brake must not send a third packet to the controller').toBe(2);
      expect(aborts).toBe(2);
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      if (previousConfig === undefined) delete process.env.P2O_CONFIG;
      else process.env.P2O_CONFIG = previousConfig;
      await rm(root, { recursive: true, force: true });
    }
  });
});
