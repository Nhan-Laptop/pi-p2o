import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../../src/sandbox.js';

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker: read-only source, non-root shell, offline networking, scratch, cancellation and verified cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-minimal-docker-')); await chmod(root, 0o755);
  await writeFile(join(root, 'source.txt'), 'approved source', { mode: 0o644 });
  const sandbox = new Sandbox({ kind: 'directory', path: root });
  try {
    await sandbox.start();
    const result = await sandbox.exec('id -u; cat /target/source.txt; printf scratch > /work/test; cat /work/test; grep CapEff /proc/self/status');
    expect(result.code).toBe(0); expect(result.stdout).toContain('65532'); expect(result.stdout).toContain('approved source'); expect(result.stdout).toContain('scratch'); expect(result.stdout).toContain('0000000000000000');
    expect((await sandbox.exec('echo changed > /target/source.txt')).code).not.toBe(0);
    expect((await sandbox.exec('echo changed > /etc/p2o-test')).code).not.toBe(0);
    expect((await sandbox.exec('test ! -e /var/run/docker.sock')).code).toBe(0);
    const large = await sandbox.exec('python3 -c "print(\'x\' * 100000)"');
    expect(large.truncated).toBe(true); expect(Buffer.byteLength(large.stdout)).toBeLessThanOrEqual(48 * 1024);
    const offline = await sandbox.exec('python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect((\'192.0.2.1\',80))"');
    expect(offline.code).not.toBe(0);
    await expect(sandbox.http('https://example.com')).rejects.toThrow('unavailable');
    const abort = new AbortController();
    const task = sandbox.exec('sleep 999', 60, abort.signal); setTimeout(() => abort.abort(), 500);
    await expect(task).rejects.toThrow('Cancelled');
    await sandbox.stop();
  } finally { await sandbox.stop(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
