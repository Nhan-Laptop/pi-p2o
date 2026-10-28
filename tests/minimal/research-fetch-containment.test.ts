import { describe, expect, it, vi } from 'vitest';
import { fetchBounded, isBlockedAddress, isTextContentType } from '../../src/research-fetch.js';
import { sha256Hex } from '../../src/validate.js';

/**
 * R0/D-R1-4: the citation fetch is a host-side URL chosen by the model, so it is exactly the place an SSRF or an unbounded
 * allocation would appear. These tests pin the refusal list and the caps with an injected resolver and transport; no real
 * network is touched.
 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const json = (body: string, url: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'content-type': 'text/plain', ...(init.headers ?? {}) } });

describe('research fetch containment (R0/D-R1-4)', () => {
  it('classifies loopback, link-local, private, metadata and reserved addresses as unreachable citations', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '100.64.0.1', '169.254.1.1', '169.254.169.254', '198.18.0.1', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '2001:db8::1', '2002::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('refuses localhost and metadata literals before any request leaves the host', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchBounded('http://localhost:8080/', { lookupHost: publicLookup, fetchImpl: fetchImpl as never })).rejects.toThrow('local and metadata hostnames');
    await expect(fetchBounded('http://169.254.169.254/latest/meta-data', { lookupHost: publicLookup, fetchImpl: fetchImpl as never })).rejects.toThrow('loopback, link-local, private and metadata');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a public hostname that resolves to a private address, and a redirect to one', async () => {
    const privateLookup = async () => [{ address: '10.0.0.7', family: 4 }];
    await expect(fetchBounded('https://citations.example/page', { lookupHost: privateLookup, fetchImpl: vi.fn() as never })).rejects.toThrow('resolves to a loopback, link-local, private or metadata address');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }));
    await expect(fetchBounded('https://citations.example/page', { lookupHost: publicLookup, fetchImpl: fetchImpl as never })).rejects.toThrow('loopback, link-local, private and metadata');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps the body and marks truncation instead of growing without bound', async () => {
    const body = 'a'.repeat(512);
    const fetchImpl = async (url: string) => json(body, url);
    const result = await fetchBounded('https://citations.example/big', { lookupHost: publicLookup, fetchImpl: fetchImpl as never, maxBytes: 16, timeoutMs: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(16);
    expect(result.bytes).toBe(16);
    expect(result.sha256).toBe(sha256Hex(result.body));
    expect(result.finalUrl).toBe('https://citations.example/big');
  });

  it('stops a redirect chain at the configured cap', async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://citations.example/next' } });
    await expect(fetchBounded('https://citations.example/start', { lookupHost: publicLookup, fetchImpl: fetchImpl as never, maxRedirects: 2 })).rejects.toThrow('stopped after 2 redirects');
  });

  it('times out even when the transport ignores the abort signal', async () => {
    const fetchImpl = () => new Promise<Response>(() => { /* never resolves */ });
    await expect(fetchBounded('https://citations.example/slow', { lookupHost: publicLookup, fetchImpl: fetchImpl as never, timeoutMs: 20 })).rejects.toThrow('timed out after 20 ms');
  });

  it('refuses non-text content types and returns the bounded text result on success', async () => {
    const binary = async (url: string) => new Response('PNG', { headers: { 'content-type': 'image/png' } });
    await expect(fetchBounded('https://citations.example/image', { lookupHost: publicLookup, fetchImpl: binary as never })).rejects.toThrow('non-text content type');
    const ok = async (url: string) => json('cloud metadata answers on link-local addresses', url, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const result = await fetchBounded('https://citations.example/page', { lookupHost: publicLookup, fetchImpl: ok as never });
    expect(result).toMatchObject({ status: 200, body: 'cloud metadata answers on link-local addresses', bytes: 46, contentType: 'text/html; charset=utf-8', truncated: false });
    expect(isTextContentType('text/html; charset=utf-8')).toBe(true);
  });
});
