import { describe, expect, it } from 'vitest';
import { Sandbox, IMAGE } from '../../src/sandbox.js';
import { cleanText, type RunProcess } from '../../src/process.js';

function driver() {
  const calls: string[][] = []; const names = new Set<string>();
  let cleanupFails = false; let execFails = false;
  const run: RunProcess = async args => {
    calls.push(args);
    const flags = args[0] === '--host' ? args.slice(2) : args;
    let stdout = '';
    if (flags[0] === 'context') stdout = '"unix:///var/run/docker.sock"';
    if (flags[0] === 'info') stdout = 'linux';
    if (flags[0] === 'create') names.add(flags[flags.indexOf('--name') + 1]);
    if (flags[0] === 'inspect') stdout = 'true';
    if (flags[0] === 'exec') {
      if (execFails) throw new Error('Docker operation timed out');
      stdout = 'safe data';
    }
    if (flags[0] === 'rm' && !cleanupFails) names.delete(flags.at(-1)!);
    if (flags[0] === 'container') stdout = [...names].filter(name => flags.join(' ').includes(name)).join('\n');
    return { code: 0, stdout, stderr: '', truncated: false };
  };
  return { calls, names, run, cleanupFailure: () => { cleanupFails = true; }, cleanupRecovery: () => { cleanupFails = false; }, execFailure: () => { execFails = true; } };
}
const target = { kind: 'url' as const, url: 'https://example.com', origin: 'https://example.com' };

describe('sandbox executor, no agents', () => {
  it('starts a pinned, unprivileged offline executor; passes model shell only to docker exec', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run);
    await sandbox.start(); await sandbox.exec('printf data');
    const create = d.calls.find(args => args.includes('create'))!;
    for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus', '--tmpfs', IMAGE]) expect(create).toContain(flag);
    expect(create[create.indexOf('--network') + 1]).toBe('none');
    expect(create[create.indexOf('--user') + 1]).toBe('65532:65532');
    expect(create).not.toContain('printf data');
    expect(d.calls.find(args => args.includes('exec'))?.at(-1)).toBe('printf data');
    await sandbox.stop(); expect(d.names.size).toBe(0);
    await sandbox.stop();
    await expect(sandbox.exec('id')).rejects.toThrow('No active');
  });
  it('uses fixed curl with a validated address; networking container has no shell or source mount', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run, async () => ['93.184.216.34']);
    await sandbox.start(); await sandbox.http('/x', 'HEAD');
    const create = d.calls.filter(args => args.includes('create'))[1];
    expect(create[create.indexOf('--network') + 1]).toBe('bridge');
    expect(create[create.indexOf('--entrypoint') + 1]).toBe('/usr/bin/curl');
    expect(create).toContain('example.com:443:93.184.216.34');
    expect(create).toContain('--no-location'); expect(create).toContain('--head');
    expect(create).not.toContain('--volume'); expect(create).not.toContain('/bin/sh');
    expect(d.names.size).toBe(1); // Only the offline executor remains.
    await expect(sandbox.http('https://other.com')).rejects.toThrow('Out of scope');
    await sandbox.stop();
  });
  it('retains ownership if daemon removal is not verified, and permits retry', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run);
    await sandbox.start(); d.cleanupFailure();
    await expect(sandbox.stop()).rejects.toThrow('could not be verified');
    expect(d.names.size).toBe(1);
    d.cleanupRecovery(); await sandbox.stop(); expect(d.names.size).toBe(0);
  });
  it('removes the entire sandbox after exec timeout rather than leaving background processes', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run);
    await sandbox.start(); d.execFailure();
    await expect(sandbox.exec('sleep 999')).rejects.toThrow('timed out');
    expect(d.names.size).toBe(0);
    await expect(sandbox.exec('id')).rejects.toThrow('No active');
  });
  it('rejects invalid shell timeout and HTTP method even at the executor boundary', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run);
    await sandbox.start();
    await expect(sandbox.exec('id', 61)).rejects.toThrow('timeout');
    await expect(sandbox.http('/', 'POST' as 'GET')).rejects.toThrow('GET/HEAD');
    await sandbox.stop();
  });
  it('strips terminal escapes from target-controlled output', () => {
    expect(cleanText('\u001b[31mhello\u001b[0m\u0000')).toBe('hello');
  });
});
