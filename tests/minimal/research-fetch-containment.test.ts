import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { fetchBounded, isBlockedAddress, isTextContentType, pinLookup, pinnedFetchResponse } from '../../src/research-fetch.js';
import { sha256Hex } from '../../src/validate.js';

/**
 * R0/D-R1-4: the citation fetch is a host-side URL chosen by the model, so it is exactly the place an SSRF or an unbounded
 * allocation would appear. These tests pin the refusal list, the caps and the W-Q property that the address the destination
 * check admitted is the address the transport connects to — a control over DNS cannot re-answer between the check and the
 * connection. The transport tests use an injected resolver and a local server; no real network is touched.
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

  it('accepts the JS content types a same-origin bundle fetch needs, without widening past them (W-E/F6)', async () => {
    expect(isTextContentType('application/javascript; charset=utf-8')).toBe(true);
    expect(isTextContentType('application/x-javascript')).toBe(true);
    expect(isTextContentType('application/ecmascript')).toBe(true);
    expect(isTextContentType('text/javascript')).toBe(true); // already matched the text/* pattern before this change
    expect(isTextContentType('application/octet-stream')).toBe(false);
    const bundle = async (url: string) => json('fetch("/api/orders");', url, { headers: { 'content-type': 'application/javascript' } });
    const result = await fetchBounded('https://citations.example/bundle.js', { lookupHost: publicLookup, fetchImpl: bundle as never });
    expect(result).toMatchObject({ status: 200, contentType: 'application/javascript' });
  });

  it('resolves once per hop and hands the vetted addresses to the transport, so a second answer cannot redirect it (W-Q)', async () => {
    let answers = 0;
    const rebindingLookup = async () => [{ address: answers++ === 0 ? '93.184.216.34' : '169.254.169.254', family: 4 }];
    const seen: Array<{ url: string; addresses: readonly { address: string; family: number }[] }> = [];
    const fetchImpl = async (url: string, init: { addresses: readonly { address: string; family: number }[] }) => {
      seen.push({ url, addresses: init.addresses });
      return new Response('public citation', { headers: { 'content-type': 'text/plain' } });
    };
    const result = await fetchBounded('https://citations.example/page', { lookupHost: rebindingLookup as never, fetchImpl: fetchImpl as never });
    expect(result.body).toBe('public citation');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    // One resolution for the hop; the transport is handed that answer instead of resolving the hostname again.
    expect(answers).toBe(1);
  });

  it('re-pins every redirect hop: a private answer on hop two never reaches the transport (W-Q)', async () => {
    const answers = [[{ address: '93.184.216.34', family: 4 }], [{ address: '10.0.0.7', family: 4 }]];
    let hops = 0;
    const lookupHost = async () => answers[hops++]!;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://private.example/admin' } }));
    await expect(fetchBounded('https://citations.example/page', { lookupHost: lookupHost as never, fetchImpl: fetchImpl as never }))
      .rejects.toThrow('resolves to a loopback, link-local, private or metadata address');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(hops).toBe(2);
  });

  it('the pinned lookup answers only the vetted address, in both Node lookup shapes (W-Q)', async () => {
    const lookup = pinLookup([{ address: '93.184.216.34', family: 4 }, { address: '93.184.216.35', family: 4 }]);
    const single = await new Promise<{ error: unknown; address?: unknown; family?: number }>(resolve =>
      lookup('citations.example', {}, (error, address, family) => resolve({ error, address, family })));
    expect(single).toEqual({ error: null, address: '93.184.216.34', family: 4 });
    const all = await new Promise<{ error: unknown; rows?: unknown }>(resolve =>
      lookup('citations.example', { all: true }, (error, rows) => resolve({ error, rows })));
    expect(all).toEqual({ error: null, rows: [{ address: '93.184.216.34', family: 4 }, { address: '93.184.216.35', family: 4 }] });
  });

  it('the production transport connects to the vetted address instead of resolving the hostname (W-Q)', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`host=${request.headers.host}`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // `.invalid` is reserved and never resolves: a response can only exist if the socket used the pinned address.
      const response = await pinnedFetchResponse(new URL(`http://pinned.invalid:${port}/page?q=1`), [{ address: '127.0.0.1', family: 4 }],
        { signal: new AbortController().signal, headers: { accept: 'text/plain' } });
      expect(response.status).toBe(200);
      expect(await new Response(response.body).text()).toBe(`host=pinned.invalid:${port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
