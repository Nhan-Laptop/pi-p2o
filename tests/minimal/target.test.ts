import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, classifyTarget, addressClass, publicIPv4, scopedRequest, httpRequest } from '../../src/target.js';

describe('one target grammar', () => {
  it('has only help, stop and a target', () => {
    expect(parseCommand('')).toEqual({ action: 'help' });
    expect(parseCommand('stop')).toEqual({ action: 'stop' });
    expect(parseCommand('pause')).toEqual({action:'pause'});expect(parseCommand('resume')).toEqual({action:'resume'});
    expect(parseCommand('--target "./my repo"')).toEqual({ action: 'start', target: './my repo', options: { solo: false } });
    expect(parseCommand("--target './my repo'")).toEqual({ action: 'start', target: './my repo', options: { solo: false } });
    expect(parseCommand('--target https://example.com')).toEqual({ action: 'start', target: 'https://example.com', options: { solo: false } });
    for (const args of ['--target', '--target x --headless', '--target x --target y', '--target x;y extra', 'approve plan-1', 'resume extra', '--target "unterminated', '--target --help']) expect(() => parseCommand(args)).toThrow();
  });
  it('parses only the delegation limits it understands', () => {
    expect(parseCommand('--target x --solo')).toMatchObject({ options: { solo: true } });
    expect(parseCommand('--target x --workers 12 --loop event-driven --executors isolated --target-ops 2')).toMatchObject({options:{workers:12,loopMode:'event-driven',executorMode:'isolated',maxTargetOperations:2}});
    for (const args of ['--loop retry','--executors bad','--target-ops 0']) expect(() => parseCommand(`--target x ${args}`)).toThrow();
    expect(parseCommand('--target x --workers 5 --max-depth 1')).toMatchObject({ options: { solo: false, workers: 5, maxDepth: 1 } });
    for (const args of ['--target x --workers 0', '--target x --workers 9007199254740992', '--target x --workers many', '--target x --max-depth 4', '--target x --max-depth -1', '--target x --delegate', '--target x --solo --solo=1']) {
      expect(() => parseCommand(args), args).toThrow();
    }
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
    expect(request).toMatchObject({ addressClass: 'public', pin: true });
  });
  it('rejects origin changes, URL credentials, fragments and non-HTTP schemes before DNS', async () => {
    for (const url of ['https://other.com', 'http://example.com', 'https://example.com:444', 'https://user:pass@example.com', '/#x', 'file:///etc/passwd', 'https://example.com./']) {
      await expect(scopedRequest(target, url, async () => { throw new Error('DNS must not be called'); })).rejects.not.toThrow('DNS must not be called');
    }
    await expect(scopedRequest({ kind: 'directory', path: '/tmp' }, '/', async () => [])).rejects.toThrow('unavailable');
  });
  it('classifies every non-public range without blocking it, and leaves IP literals unpinned', async () => {
    for (const [ip, kind] of [['0.1.2.3', 'reserved'], ['10.0.0.1', 'private'], ['100.64.1.1', 'shared'], ['127.0.0.1', 'loopback'], ['169.254.169.254', 'link-local'], ['172.16.0.1', 'private'], ['192.168.1.1', 'private'], ['192.0.0.9', 'reserved'], ['198.18.0.1', 'reserved'], ['203.0.113.1', 'reserved'], ['224.1.1.1', 'multicast'], ['::1', 'ipv6']] as const) {
      expect(publicIPv4(ip), ip).toBe(false);
      expect(addressClass(ip), ip).toBe(kind);
    }
    expect(addressClass('93.184.216.34')).toBe('public');
    // The confirmed scope, not the address class, is what stops a request now.
    const loopback = { kind: 'url' as const, url: 'http://127.0.0.1:8080/', origin: 'http://127.0.0.1:8080' };
    await expect(scopedRequest(loopback, '/', async () => ['127.0.0.1'])).resolves.toMatchObject({ addressClass: 'loopback', pin: false });
    await expect(scopedRequest(target, '/', async () => ['10.0.0.7'])).resolves.toMatchObject({ addressClass: 'private', address: '10.0.0.7' });
    await expect(scopedRequest(target, '/', async () => ['93.184.216.34', '10.0.0.7'])).resolves.toMatchObject({ address: '93.184.216.34' });
    await expect(scopedRequest(target, '/', async () => [])).rejects.toThrow('Could not resolve');
    const ipv6={kind:'url' as const,url:'http://[::1]:8080/',origin:'http://[::1]:8080'};
    expect(await scopedRequest(ipv6,'/',async()=>{throw Error('No DNS for a literal');})).toMatchObject({address:'::1',addressClass:'ipv6',pin:false});
  });
  it('validates methods, headers and bodies before any request is made', () => {
    expect(httpRequest({ url: '/x' })).toMatchObject({ method: 'GET', followRedirects: true, maxRedirects: 3 });
    expect(httpRequest({ url: '/x', method: 'post', body: '{}', headers: { 'Content-Type': 'application/json' } })).toMatchObject({ method: 'POST', body: '{}' });
    for (const method of ['get ', '', 'G\r\nET']) expect(() => httpRequest({ url: '/x', method })).toThrow('HTTP token');
    for (const method of ['TRACE', 'CONNECT', 'PROPFIND', 'M-SEARCH']) expect(httpRequest({url:'/x',method}).method).toBe(method);
    for(const input of [{url:'/x',body:123},{url:'/x',method:42},{url:'/x',followRedirects:'yes'},{url:'/x',maxRedirects:1.5},{url:'/x',session:'a/b'}]) expect(()=>httpRequest(input)).toThrow();
    expect(() => httpRequest({ url: '/x', maxRedirects: 9 })).toThrow('maxRedirects must be 0..5');
    expect(() => httpRequest({ url: '/x', method: 'HEAD', body: 'x' })).toThrow('cannot carry a body');
    expect(() => httpRequest({ url: '/x', body: 'x'.repeat(70_000) })).toThrow('at most');
    expect(() => httpRequest({ url: '/x', headers: { 'Bad Name': 'v' } })).toThrow('Invalid header name');
    expect(() => httpRequest({ url: '/x', headers: { 'X-Test': 'a\r\nInjected: 1' } })).toThrow('Invalid value');
    expect(() => httpRequest({ url: '/x', headers: { 'Content-Length': '10' } })).toThrow('cannot be overridden');
    expect(() => httpRequest({ url: '/x', headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-${i}`, 'v'])) })).toThrow('At most 20');
    expect(() => httpRequest({ url: 'x'.repeat(4100) })).toThrow('1..4096');
  });
});
