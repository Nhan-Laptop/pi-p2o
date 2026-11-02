import { describe, expect, it } from 'vitest';
import { routeInventory, ROUTE_INVENTORY_SCHEMA } from '../../src/extract/route-inventory.js';
import { EXTRACT_MAX_ASSETS, EXTRACT_MAX_FACTS, EXTRACT_MAX_HYPOTHESES, EXTRACT_MAX_ROW_BYTES } from '../../src/extract/types.js';

/**
 * W-Z/A: the crawl document is the one JSON shape this parser claims, and what it produces is attributed knowledge only.
 * These tests pin the format gate (any other JSON is somebody else's artifact), the parameter matrix as a bounded attribute,
 * the suspicious-name matrix (a name is a hypothesis, never a claim) and the caps that keep one crawl from authoring an
 * unbounded graph. The extractor is tested directly here; the registry pin lives with the registration the lead owns.
 */
const source = (text: string) => ({ text });
const document = (routes: unknown[], extra: Record<string, unknown> = {}) =>
  source(JSON.stringify({ schema: ROUTE_INVENTORY_SCHEMA, routes, crawl: { seed: 'http://lab.test/', depth: 2, principal: 'anonymous', requests: routes.length, truncated: false }, ...extra }));

const login = {
  path: '/login', methods: ['get', 'POST'],
  params: [{ in: 'form', name: 'username' }, { in: 'form', name: 'password' }, { in: 'query', name: 'next' }],
  auth: { cookie: false, bearer: false },
};
const account = {
  path: '/users/42', methods: ['GET'],
  params: [{ in: 'path', name: 'id' }, { in: 'query', name: 'q' }],
  auth: { cookie: true, bearer: true },
};

describe('route-inventory extractor: the crawl document becomes route knowledge', () => {
  it('exports the exact signature the crawl script emits', () => {
    expect(ROUTE_INVENTORY_SCHEMA).toBe('p2o-route-inventory/1');
  });

  it('turns routes into route assets with a bounded parameter matrix and an auth label', () => {
    const result = routeInventory(document([login, account]))!;
    expect(result).toBeDefined();
    expect(result.extractor).toBe('route-inventory');
    expect(result.assets.map(asset => asset.key)).toEqual(['/login', '/users/42']);

    const [loginAsset, accountAsset] = result.assets;
    expect(loginAsset).toMatchObject({
      kind: 'route', key: '/login', label: '/login',
      attributes: { source: 'route-crawl', auth: 'anonymous', method: 'GET,POST', params: 'form:username,form:password,query:next' },
      anchors: [{ kind: 'path', value: '/login' }],
    });
    expect(accountAsset?.attributes).toMatchObject({ source: 'route-crawl', auth: 'cookie+bearer', method: 'GET', params: 'path:id,query:q' });
  });

  it('records one observed fact per parameter and a hypothesis only for a suspicious name', () => {
    const result = routeInventory(document([login, account]))!;
    expect(result.facts).toHaveLength(5);
    expect(result.facts.every(fact => fact.kind === 'observed' && fact.confidence === 'medium')).toBe(true);
    expect(result.facts.map(fact => fact.asset)).toEqual([0, 0, 0, 1, 1]);
    expect(result.facts[2]?.statement).toContain('/login');
    expect(result.facts[2]?.statement).toContain('next');
    expect(result.facts[2]?.statement).toContain('query');
    // `username`/`password`/`q` are ordinary inputs; `next` and `id` are name-shaped candidates.
    expect(result.hypotheses).toHaveLength(2);
    expect(result.hypotheses[0]).toMatchObject({ asset: 0 });
    expect(result.hypotheses[0]?.statement).toContain('next');
    expect(result.hypotheses[0]?.statement).toContain('never a demonstrated effect');
    expect(result.hypotheses[0]?.impact).toContain('Candidate parameter next');
    expect(result.hypotheses[1]?.statement).toContain('id');
  });

  it('treats the matrix as knowledge, not a claim, and keeps it inside one route row', () => {
    const result = routeInventory(document([login, account]))!;
    expect(result.components).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('hypothesis matrix'))).toBe(true);
    expect(result.warnings.some(warning => warning.includes('never a claim'))).toBe(true);
    for (const asset of result.assets) expect(Buffer.byteLength(JSON.stringify(asset))).toBeLessThanOrEqual(EXTRACT_MAX_ROW_BYTES);
  });

  it('keeps only valid locations, names and methods; truncates a parameter name instead of throwing', () => {
    const result = routeInventory(document([{
      path: '/mixed', methods: ['GET', 'post', 'G3T', 'toolongmethodname', 'GET'],
      params: [
        { in: 'header', name: 'X-Trace' }, // unsupported location
        { in: 'query', name: 'a'.repeat(100) }, // truncated to the identity bound
        { in: 'query', name: '' },
        { in: 'form' },
        'not-a-param',
      ],
      auth: { cookie: false, bearer: true },
    }]))!;
    const asset = result.assets[0]!;
    expect(asset.attributes?.['method']).toBe('GET,POST');
    expect(asset.attributes?.['auth']).toBe('bearer');
    const params = asset.attributes?.['params'] ?? '';
    expect(params).toMatch(/^query:a{64}$/);
    expect([...params].length).toBeLessThanOrEqual(500);
    expect(result.facts).toHaveLength(1);
    expect(result.hypotheses).toEqual([]); // `a` is not a suspicious token
  });

  it('merges a repeated path into one asset and keeps the matrix deduplicated', () => {
    const result = routeInventory(document([
      login,
      { path: '/login', methods: ['POST'], params: [{ in: 'form', name: 'username' }], auth: { cookie: true } },
    ]))!;
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.attributes?.['params']).toBe('form:username,form:password,query:next');
    expect(result.facts).toHaveLength(4); // 3 from the first row, 1 from the second
  });

  it('drops rows without a usable path and says so', () => {
    const result = routeInventory(document([
      login,
      null, 7, {}, { path: '' }, { path: 'relative/path' }, { path: '/ok?token=deadbeef' },
    ]))!;
    expect(result.assets.map(asset => asset.key)).toEqual(['/login']);
    expect(result.warnings.some(warning => warning.includes('no usable path'))).toBe(true);
  });

  it('caps routes, facts and hypotheses with counted omissions', () => {
    const routes = (count: number, param: (index: number) => string) => Array.from({ length: count }, (_, index) => ({
      path: `/r${index}`, methods: ['GET'], params: [{ in: 'query', name: param(index) }], auth: { cookie: true },
    }));
    const manyRoutes = routeInventory(document(routes(250, index => `q${index}`)))!;
    expect(manyRoutes.assets).toHaveLength(EXTRACT_MAX_ASSETS);
    expect(manyRoutes.omitted.assets).toBe(50);

    const manyParams = Array.from({ length: 40 }, (_, index) => ({ in: 'form', name: `field${index}` }));
    const facts = routeInventory(document(Array.from({ length: 40 }, (_, index) => ({ path: `/f${index}`, methods: ['GET'], params: manyParams, auth: {} }))))!;
    expect(facts.facts.length).toBeLessThanOrEqual(EXTRACT_MAX_FACTS);
    expect(facts.omitted.facts).toBeGreaterThan(0);

    const suspicious = routeInventory(document(Array.from({ length: 10 }, (_, index) => ({
      path: `/h${index}`, methods: ['GET'], auth: {}, params: Array.from({ length: 32 }, (_, n) => ({ in: 'query', name: `id_${n}` })),
    }))))!;
    expect(suspicious.hypotheses).toHaveLength(EXTRACT_MAX_HYPOTHESES);
    expect(suspicious.omitted.hypotheses).toBeGreaterThan(0);
  });
});

describe('route-inventory extractor: only its own exact format is claimed', () => {
  it('refuses JSON with another schema, no routes or no signature', () => {
    expect(routeInventory(source(JSON.stringify({ schema: 'other', routes: [login] })))).toBeUndefined();
    expect(routeInventory(source(JSON.stringify({ routes: [login] })))).toBeUndefined();
    expect(routeInventory(source(JSON.stringify({ schema: ROUTE_INVENTORY_SCHEMA })))).toBeUndefined();
    expect(routeInventory(source(JSON.stringify({ schema: ROUTE_INVENTORY_SCHEMA, routes: [] })))).toBeUndefined();
  });

  it('refuses non-JSON, malformed JSON, arrays and other scanner shapes without throwing', () => {
    expect(routeInventory(source('not json at all'))).toBeUndefined();
    expect(routeInventory(source('{"schema":"p2o-route-inventory/1","routes":['))).toBeUndefined();
    expect(routeInventory(source(JSON.stringify([login])))).toBeUndefined();
    expect(routeInventory(source(JSON.stringify({ openapi: '3.0.0', paths: { '/login': {} } })))).toBeUndefined();
    expect(routeInventory(source(JSON.stringify({ schema: ROUTE_INVENTORY_SCHEMA, routes: [null, 7, 'x', {}] })))).toBeUndefined();
    expect(routeInventory({ text: '' })).toBeUndefined();
  });

  it('ignores ambient fields outside the routes array', () => {
    const result = routeInventory(document([login], { schema: ROUTE_INVENTORY_SCHEMA, notes: { claim: 'ignored' }, routes: [login] }))!;
    expect(result.assets.map(asset => asset.key)).toEqual(['/login']);
  });
});
