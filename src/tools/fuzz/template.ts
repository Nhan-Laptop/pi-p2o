import { checkCancelled, invariant, PolicyError, type PolicyErrorCode } from '../../policy/errors.js';
import { normalizeWebTarget } from '../../policy/targets.js';
import { choice, deepFreeze, digest, identifier, integer, list, record, text, timestamp } from '../../policy/validation.js';
import type { Action, ToolContext } from '../../policy/index.js';
import type { HttpExecution } from '../http.js';
import { sha256 } from '../redaction.js';
import type { ApprovedFuzzTemplate, FuzzTemplateAxis, FuzzTemplateInput, HttpEvidence, HttpInput, ToolDescriptor } from '../types.js';
import { seededRandom, validateFuzzSeed, type SeededRandom } from './prng.js';

export const FUZZ_TEMPLATE_AXES = ['query', 'header', 'body'] as const;
export const FUZZ_TEMPLATE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** Header names a caller may set at all (mirrors the broker adapter's caller-header allowlist). */
export const SAFE_MUTATION_HEADERS = ['accept', 'accept-language', 'content-type', 'if-match', 'if-none-match', 'idempotency-key'] as const;
const IDENTITY_PARAMETER = /^(?:access[-_]?token|refresh[-_]?token|auth[-_]?token|token|api[-_]?key|key|password|passwd|authorization|cookie|session(?:id)?|credential|auth)$/i;
const DENIAL_CODES = new Set<PolicyErrorCode>(['INVALID_INPUT', 'EXPIRED', 'IDENTITY_DENIED', 'CAPABILITY_DENIED', 'ACTION_DENIED', 'TARGET_DENIED', 'ACCOUNT_DENIED', 'ADDRESS_DENIED', 'DNS_CHANGED', 'PEER_MISMATCH', 'REDIRECT_DENIED', 'FILESYSTEM_DENIED']);
const CLASSIFICATIONS = ['same', 'status-diff', 'digest-diff', 'structure-diff', 'length-diff', 'error'] as const;
export type TemplateClassification = typeof CLASSIFICATIONS[number];

export const TEMPLATE_LIMITS = Object.freeze([
  'Only parts declared in the owner-approved template are mutated; scheme, host, port, path and account are fixed by construction and re-asserted per request.',
  'Every mutated request is independently authorized, DNS-pinned and budgeted by the existing broker policy path; a scope escape is a hard denial, never a recorded observation.',
  'Per-template request caps, per-template rate windows and the target budget all fail closed, so there is no unbounded payload flooding.',
  'Header values with control characters are refused by the broker adapter, so request-splitting payloads never leave the host.',
  'Classifications compare status/structure/length/digest against an unmutated baseline: an observation, never a verified finding.',
]);

export interface TemplateFuzzState { used: number; windowStart: number; windowCount: number }
export interface TemplateFuzzOptions {
  readonly context: ToolContext;
  readonly descriptor: ToolDescriptor;
  readonly request: (execution: HttpExecution) => Promise<HttpEvidence>;
  readonly touchedTargets: Set<string>;
  readonly state: TemplateFuzzState;
  readonly now: () => number;
  readonly boundary: string;
  readonly signal?: AbortSignal;
}

export interface FuzzTemplateObservation {
  readonly case: number;
  readonly axis: FuzzTemplateAxis;
  readonly name: string;
  readonly value: string;
  readonly valueSha256: string;
  readonly url: string;
  readonly status: number;
  readonly bytes: number;
  readonly bodySha256: string;
  readonly classification: TemplateClassification;
  readonly detail: string;
  readonly responseFingerprint: string;
}
export interface FuzzTemplateEvidence {
  readonly kind: 'fuzz-template';
  readonly templateId: string;
  readonly method: string;
  readonly accountId: string;
  readonly url: string;
  readonly seed: string;
  readonly casesMax: number;
  readonly casesRun: number;
  readonly baseline: { readonly status: number; readonly bytes: number; readonly bodySha256: string };
  readonly observations: readonly FuzzTemplateObservation[];
  readonly classifications: readonly { readonly name: TemplateClassification; readonly count: number }[];
  readonly stopped: 'completed' | 'deadline' | 'request-cap' | 'rate-limit';
  /** `attemptsUsed` counts requests charged to the template cap, including attempts the target budget refused. */
  readonly budget: { readonly deadlineMs: number; readonly spentMs: number; readonly attemptsUsed: number; readonly requestsMax: number };
  readonly isolation: string;
  readonly limits: readonly string[];
}

function boundedToken(value: unknown, label: string, maxLength: number): string {
  return text(value, label, maxLength);
}

/**
 * Owner-supplied template declarations are validated once, at pack construction: any declaration
 * that could widen the request beyond its approved origin/method/account, or that names an identity
 * parameter or a header the adapter would refuse, is a hard configuration error.
 */
export function validateApprovedTemplates(value: unknown): readonly ApprovedFuzzTemplate[] {
  invariant(Array.isArray(value), 'INVALID_INPUT', 'fuzz.template requires an owner-supplied approved template list');
  const seen = new Set<string>();
  const templates = value.map((entry, index) => {
    const label = `templates[${index}]`;
    const o = record(entry, label, ['id', 'accountId', 'method', 'url', 'query', 'headers', 'body', 'maxRequests', 'rate', 'approvedBy', 'expiresAt']);
    const id = identifier(o.id, `${label}.id`);
    invariant(!seen.has(id), 'INVALID_INPUT', 'Duplicate approved template id');
    seen.add(id);
    const method = choice(o.method, `${label}.method`, FUZZ_TEMPLATE_METHODS);
    const url = normalizeWebTarget(text(o.url, `${label}.url`, 8192)).url;
    const accountId = identifier(o.accountId, `${label}.accountId`);
    const query = list(o.query ?? [], `${label}.query`, (raw, at) => {
      const q = record(raw, at, ['name', 'base', 'tokens', 'maxLength']);
      const name = identifier(q.name, `${at}.name`);
      invariant(!IDENTITY_PARAMETER.test(name), 'ACCOUNT_DENIED', `${at}.name is an identity parameter; credentials are never fuzzed`);
      const maxLength = integer(q.maxLength ?? 256, `${at}.maxLength`, 1, 4096);
      const tokens = list(q.tokens, `${at}.tokens`, (token, tokenLabel) => boundedToken(token, tokenLabel, maxLength), 1, 32);
      invariant(new Set(tokens).size === tokens.length, 'INVALID_INPUT', `${at}.tokens contains duplicates`);
      return Object.freeze({ name, ...(q.base === undefined ? {} : { base: boundedToken(q.base, `${at}.base`, maxLength) }), tokens: Object.freeze(tokens), maxLength });
    }, 0, 16);
    const headers = list(o.headers ?? [], `${label}.headers`, (raw, at) => {
      const h = record(raw, at, ['name', 'base', 'tokens', 'maxLength']);
      const name = text(h.name, `${at}.name`, 64).toLowerCase();
      invariant((SAFE_MUTATION_HEADERS as readonly string[]).includes(name), 'ACCOUNT_DENIED', `${at}.name must be one of the caller headers the broker adapter accepts; host/authorization/cookie headers cannot be mutated`);
      const maxLength = integer(h.maxLength ?? 256, `${at}.maxLength`, 1, 4096);
      const tokens = list(h.tokens, `${at}.tokens`, (token, tokenLabel) => boundedToken(token, tokenLabel, maxLength), 1, 32);
      invariant(new Set(tokens).size === tokens.length, 'INVALID_INPUT', `${at}.tokens contains duplicates`);
      return Object.freeze({ name, base: boundedToken(h.base, `${at}.base`, maxLength), tokens: Object.freeze(tokens), maxLength });
    }, 0, 8);
    const body = o.body === undefined ? undefined : (() => {
      const b = record(o.body, `${label}.body`, ['base', 'tokens', 'maxLength']);
      invariant(!['GET', 'HEAD', 'OPTIONS'].includes(method), 'ACTION_DENIED', 'A body mutation requires an approved method that can carry a body');
      const maxLength = integer(b.maxLength ?? 4096, `${label}.body.maxLength`, 1, 65536);
      const tokens = list(b.tokens, `${label}.body.tokens`, (token, tokenLabel) => boundedToken(token, tokenLabel, maxLength), 1, 32);
      invariant(new Set(tokens).size === tokens.length, 'INVALID_INPUT', `${label}.body.tokens contains duplicates`);
      return Object.freeze({ base: boundedToken(b.base, `${label}.body.base`, maxLength), tokens: Object.freeze(tokens), maxLength });
    })();
    invariant(query.length + headers.length + (body ? 1 : 0) > 0, 'INVALID_INPUT', `${label} declares no mutable part`);
    const rate = record(o.rate, `${label}.rate`, ['requests', 'windowMs']);
    const maxRequests = integer(o.maxRequests, `${label}.maxRequests`, 1, 256);
    const rateWindow = { requests: integer(rate.requests, `${label}.rate.requests`, 1, 256), windowMs: integer(rate.windowMs, `${label}.rate.windowMs`, 1, 600000) };
    return Object.freeze({
      id, accountId, method, url,
      query: Object.freeze(query), headers: Object.freeze(headers),
      ...(body ? { body } : {}),
      maxRequests, rate: Object.freeze(rateWindow),
      approvedBy: text(o.approvedBy, `${label}.approvedBy`, 128), expiresAt: timestamp(o.expiresAt, `${label}.expiresAt`),
    });
  });
  return Object.freeze(templates);
}

export function declaredAxes(template: ApprovedFuzzTemplate): readonly FuzzTemplateAxis[] {
  const axes: FuzzTemplateAxis[] = [];
  if (template.query.length > 0) axes.push('query');
  if (template.headers.length > 0) axes.push('header');
  if (template.body) axes.push('body');
  return Object.freeze(axes);
}

function buildValue(rng: SeededRandom, tokens: readonly string[], maxLength: number): string {
  const count = 1 + rng.int(3);
  let value = '';
  for (let index = 0; index < count; index += 1) value += rng.pick(tokens);
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

interface Mutation {
  readonly axis: FuzzTemplateAxis;
  readonly name: string;
  readonly value: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

function buildMutation(rng: SeededRandom, template: ApprovedFuzzTemplate, axis: FuzzTemplateAxis, baseHeaders: Record<string, string>): Mutation {
  if (axis === 'query') {
    invariant(template.query.length > 0, 'INVALID_INPUT', 'Template declares no mutable query parameters');
    const parameter = template.query[rng.int(template.query.length)]!;
    const value = buildValue(rng, parameter.tokens, parameter.maxLength);
    const url = new URL(template.url);
    url.searchParams.set(parameter.name, value);
    return { axis, name: parameter.name, value, url: url.href };
  }
  if (axis === 'header') {
    invariant(template.headers.length > 0, 'INVALID_INPUT', 'Template declares no mutable headers');
    const header = template.headers[rng.int(template.headers.length)]!;
    const value = buildValue(rng, header.tokens, header.maxLength);
    return { axis, name: header.name, value, url: template.url, headers: { ...baseHeaders, [header.name]: value } };
  }
  invariant(template.body, 'INVALID_INPUT', 'Template declares no mutable body');
  const value = buildValue(rng, template.body.tokens, template.body.maxLength);
  return { axis: 'body', name: 'body', value, url: template.url, body: value };
}

function shapeOf(value: unknown, depth = 0): string {
  if (depth > 8) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length === 0 ? '' : shapeOf(value[0], depth + 1)}]`;
  if (typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().join(',')}}`;
  return typeof value;
}

function structureDetail(baseline: string, candidate: string): string | undefined {
  const parse = (value: string): unknown => { try { return JSON.parse(value); } catch { return undefined; } };
  const left = parse(baseline), right = parse(candidate);
  if (left === undefined && right === undefined) return undefined;
  if (left === undefined) return 'baseline is not JSON; mutation parses as JSON';
  if (right === undefined) return 'mutation is not JSON';
  const before = shapeOf(left), after = shapeOf(right);
  return before === after ? undefined : `shape ${before} -> ${after}`.slice(0, 512);
}

function classify(baseline: { status: number; bytes: number; bodySha256: string; body: string }, response: HttpEvidence): { classification: TemplateClassification; detail: string } {
  if (response.status !== baseline.status) return { classification: 'status-diff', detail: `${baseline.status} -> ${response.status}` };
  const structure = structureDetail(baseline.body, response.body);
  if (structure !== undefined) return { classification: 'structure-diff', detail: structure };
  if (response.bodySha256 !== baseline.bodySha256) {
    const bytes = Buffer.byteLength(response.body);
    if (Math.abs(bytes - baseline.bytes) > Math.max(32, Math.floor(baseline.bytes * 0.1))) return { classification: 'length-diff', detail: `${baseline.bytes} -> ${bytes} bytes` };
    return { classification: 'digest-diff', detail: 'body bytes differ' };
  }
  return { classification: 'same', detail: '' };
}

function observationOf(index: number, mutation: Mutation, response: HttpEvidence): FuzzTemplateObservation {
  const bytes = Buffer.byteLength(response.body);
  return Object.freeze({
    case: index, axis: mutation.axis, name: mutation.name, value: mutation.value, valueSha256: sha256(mutation.value),
    url: response.finalUrl, status: response.status, bytes, bodySha256: response.bodySha256,
    classification: 'same', detail: '', responseFingerprint: digest({ status: response.status, bodySha256: response.bodySha256, headers: Object.keys(response.headers).sort() }),
  });
}

function errorObservation(index: number, mutation: Mutation, code: PolicyErrorCode | 'UNAVAILABLE'): FuzzTemplateObservation {
  const bodySha256 = digest({ noResponse: code });
  return Object.freeze({
    case: index, axis: mutation.axis, name: mutation.name, value: mutation.value, valueSha256: sha256(mutation.value),
    url: mutation.url, status: 0, bytes: 0, bodySha256,
    classification: 'error' as const, detail: code,
    responseFingerprint: digest({ error: code }),
  });
}

export async function runTemplateFuzz(input: FuzzTemplateInput, template: ApprovedFuzzTemplate, options: TemplateFuzzOptions): Promise<FuzzTemplateEvidence> {
  const started = options.now();
  const seed = validateFuzzSeed(input.seed);
  const casesMax = integer(input.cases ?? 16, 'cases', 1, 64);
  const axes = input.axes === undefined ? declaredAxes(template) : list(input.axes, 'axes', (value, label) => choice(value, label, FUZZ_TEMPLATE_AXES), 1, 3);
  invariant(axes.every(axis => declaredAxes(template).includes(axis)), 'INVALID_INPUT', 'Requested mutation axis is not declared by the approved template');
  invariant(options.now() < Date.parse(template.expiresAt), 'EXPIRED', 'Approved template expired; re-approval is required before any request');
  const action: Action = ['GET', 'HEAD', 'OPTIONS'].includes(template.method) ? 'read' : 'mutate';
  const baseHeaders = Object.fromEntries(template.headers.map(header => [header.name, header.base]));
  const baseInput: HttpInput = {
    url: template.url, accountId: template.accountId, method: template.method,
    ...(Object.keys(baseHeaders).length > 0 ? { headers: baseHeaders } : {}),
    ...(template.body ? { body: template.body.base } : {}),
  };
  const deadlineMs = Math.max(1, Math.floor(options.descriptor.limits.timeoutMs * 0.9));
  const deadline = started + deadlineMs;

  const charge = (): void => { options.state.used += 1; options.state.windowCount += 1; };
  /** Roll the window forward once it elapses, then report whether the next request would exceed it. */
  const rateLimited = (): boolean => {
    const at = options.now();
    if (options.state.windowStart === 0 || at - options.state.windowStart >= template.rate.windowMs) { options.state.windowStart = at; options.state.windowCount = 0; }
    return options.state.windowCount >= template.rate.requests;
  };
  invariant(options.state.used < template.maxRequests, 'BUDGET_EXCEEDED', 'Per-template request cap is exhausted');
  invariant(!rateLimited(), 'RATE_LIMITED', 'Per-template rate window is exhausted');

  charge();
  const baselineResponse = await options.request({ context: options.context, capability: 'fuzz.template', input: baseInput, descriptor: options.descriptor, signal: options.signal, touchedTargets: options.touchedTargets, action });
  const baseline = Object.freeze({ status: baselineResponse.status, bytes: Buffer.byteLength(baselineResponse.body), bodySha256: baselineResponse.bodySha256, body: baselineResponse.body });

  const rng = seededRandom(seed, `template:${template.id}`);
  const declared = new Set(Object.keys(baseHeaders));
  const allowedHeaderNames = new Set(template.headers.map(header => header.name));
  const observations: FuzzTemplateObservation[] = [];
  const counts = new Map<TemplateClassification, number>();
  let stopped: FuzzTemplateEvidence['stopped'] = 'completed';
  let casesRun = 0;
  for (let index = 0; index < casesMax; index += 1) {
    checkCancelled(options.signal);
    if (options.now() > deadline) { stopped = 'deadline'; break; }
    if (options.state.used >= template.maxRequests) { stopped = 'request-cap'; break; }
    if (rateLimited()) { stopped = 'rate-limit'; break; }
    const axis = axes[index % axes.length]!;
    const mutation = buildMutation(rng, template, axis, baseHeaders);
    const base = new URL(template.url);
    const candidate = new URL(mutation.url);
    invariant(candidate.origin === base.origin && candidate.pathname === base.pathname, 'TARGET_DENIED', 'Template mutation cannot change scheme, host, port or path');
    for (const name of Object.keys(mutation.headers ?? {})) invariant(declared.has(name) && allowedHeaderNames.has(name), 'ACCOUNT_DENIED', 'Template mutation cannot add or rename headers');
    const requestInput: HttpInput = {
      ...baseInput,
      url: mutation.url,
      accountId: template.accountId,
      method: template.method,
      ...(mutation.headers ? { headers: mutation.headers } : {}),
      ...(mutation.body !== undefined ? { body: mutation.body } : {}),
    };
    charge();
    casesRun = index + 1;
    try {
      const response = await options.request({ context: options.context, capability: 'fuzz.template', input: requestInput, descriptor: options.descriptor, signal: options.signal, touchedTargets: options.touchedTargets, action });
      const classified = classify(baseline, response);
      const observation = Object.freeze({
        ...observationOf(index, mutation, response),
        classification: classified.classification,
        detail: classified.detail,
      });
      observations.push(observation);
      counts.set(classified.classification, (counts.get(classified.classification) ?? 0) + 1);
    } catch (error) {
      if (error instanceof PolicyError && error.code === 'BUDGET_EXCEEDED') { stopped = 'request-cap'; break; }
      if (error instanceof PolicyError && error.code === 'RATE_LIMITED') { stopped = 'rate-limit'; break; }
      if (error instanceof PolicyError && DENIAL_CODES.has(error.code)) throw error; // a policy refusal is never softened into an observation
      const code = error instanceof PolicyError ? error.code : 'UNAVAILABLE';
      observations.push(errorObservation(index, mutation, code));
      counts.set('error', (counts.get('error') ?? 0) + 1);
    }
  }
  return deepFreeze({
    kind: 'fuzz-template' as const,
    templateId: template.id, method: template.method, accountId: template.accountId, url: template.url,
    seed, casesMax, casesRun,
    baseline: { status: baseline.status, bytes: baseline.bytes, bodySha256: baseline.bodySha256 },
    observations: observations.slice(0, 64),
    classifications: [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, count]) => ({ name, count })),
    stopped,
    budget: { deadlineMs, spentMs: options.now() - started, attemptsUsed: options.state.used, requestsMax: template.maxRequests },
    isolation: options.boundary,
    limits: TEMPLATE_LIMITS,
  });
}
