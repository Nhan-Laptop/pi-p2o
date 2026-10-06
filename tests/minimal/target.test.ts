import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, classifyTarget, publicIPv4, scopedRequest } from '../../src/target.js';

describe('one target grammar', () => {
  it('has only help, stop and a target', () => {
    expect(parseCommand('')).toEqual({ action: 'help' });
    expect(parseCommand('stop')).toEqual({ action: 'stop' });
    expect(parseCommand('--target "./my repo"')).toEqual({ action: 'start', target: './my repo' });
    expect(parseCommand("--target './my repo'")).toEqual({ action: 'start', target: './my repo' });
    expect(parseCommand('--target https://example.com')).toEqual({ action: 'start', target: 'https://example.com' });
    for (const args of ['--target', '--target x --headless', '--target x --target y', '--target x;y extra', 'approve plan-1', 'resume', '--target "unterminated', '--target --help']) expect(() => parseCommand(args)).toThrow();
  });
  it('resolves directories, refuses files and root, and treats GitHub as an ordinary URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-target-'));
    try {
      await writeFile(join(root, 'file'), 'data'); await symlink(root, `${root}-link`);
      expect(await classifyTarget(`${root}-link`, '/tmp')).toEqual({ kind: 'directory', path: root });
      await expect(classifyTarget(join(root, 'file'), root)).rejects.toThrow('directory');
      await expect(classifyTarget('/', root)).rejects.toThrow();
      await expect(classifyTarget('ftp://example.com', root)).rejects.toThrow();
      expect(await classifyTarget('https://github.com/owner/repo', root)).toMatchObject({ kind: 'url', origin: 'https://github.com' });
    } finally { await rm(`${root}-link`, { force: true }); await rm(root, { recursive: true, force: true }); }
  });
});

describe('HTTP scope', () => {
  const target = { kind: 'url' as const, url: 'https://example.com/start', origin: 'https://example.com' };
  it('pins a public address and accepts relative URLs', async () => {
    const request = await scopedRequest(target, '/about', async () => ['93.184.216.34']);
    expect(request.address).toBe('93.184.216.34'); expect(request.url.href).toBe('https://example.com/about');
  });
  it('rejects origin changes, URL credentials, fragments and non-HTTP schemes before DNS', async () => {
    for (const url of ['https://other.com', 'http://example.com', 'https://example.com:444', 'https://user:pass@example.com', '/#x', 'file:///etc/passwd', 'https://example.com./']) {
      await expect(scopedRequest(target, url, async () => { throw new Error('DNS must not be called'); })).rejects.not.toThrow('DNS must not be called');
    }
    await expect(scopedRequest({ kind: 'directory', path: '/tmp' }, '/', async () => [])).rejects.toThrow('unavailable');
  });
  it('blocks private, reserved and IPv6 addresses, including mixed DNS answers', async () => {
    for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.1.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.1.1.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) {
      expect(publicIPv4(ip), ip).toBe(false);
      await expect(scopedRequest(target, '/', async () => ['93.184.216.34', ip])).rejects.toThrow('public IPv4');
    }
    await expect(scopedRequest(target, '/', async () => [])).rejects.toThrow();
  });
});
