import type { Classification, Digest, EvidenceKind, Id, JsonObject, RunManifest, RuntimeSelection, Timestamp } from './types.js';
import { ID_PATTERN } from './schemas.js';
import { classifications, evidenceKinds, thinkingLevels } from './types.js';
import { digestJson, makeSchema, rules as r } from './validation.js';
import { planIssue, type PlanIssue } from './plan.js';

/**
 * Generated request proposal contract. This is a deliberately separate path from `PlanProposal`: instead of
 * *selecting* owner-prewritten observations, the model *authors* concrete `http.request` inputs (method, URL,
 * account, bounded headers/body) for new paths/queries that the owner checks never enumerated. Nothing here
 * grants authority: a proposal is inert until the owner approves its exact canonical digest, and only then may
 * the controller materialize it into checks/task grants. There is no script, shell or arbitrary-tool field.
 */

export const planRequestMethods = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type PlanRequestMethod = typeof planRequestMethods[number];
export const planRequestActions = ['read', 'mutate'] as const;
export type PlanRequestAction = typeof planRequestActions[number];
export const planRequestTools = ['http.request'] as const;
export type PlanRequestTool = typeof planRequestTools[number];

/** Headers the broker's http adapter will accept from a caller; anything else is refused before dispatch. */
export const planRequestHeaders = ['accept', 'accept-language', 'content-type', 'if-match', 'if-none-match', 'idempotency-key'] as const;

export const planRequestCapsDefaults = Object.freeze({ maxRequests: 16, maxProposals: 32 });
export const planRequestLimits = Object.freeze({
  urlChars: 2_048, bodyBytes: 16_384, headerBytes: 8_192, headerCount: 8, summaryChars: 2_048,
});

export interface PlanRequestCaps { maxRequests: number; maxProposals: number }

/** One model-authored concrete request. `requests` is the target-request cost charged against the caps. */
export interface PlanRequestDraft {
  requestId: Id;
  taskId: Id;
  tool: PlanRequestTool;
  method: PlanRequestMethod;
  /** Concrete absolute URL. New paths/queries are the point; origin, account and action must stay in scope. */
  url: string;
  action: PlanRequestAction;
  accountId: Id;
  headers?: Record<string, string>;
  body?: string;
  expectation?: { type: 'http'; status: number; bodyIncludes?: string; mustMatch?: boolean };
  kind: EvidenceKind;
  classification: Classification;
  summary: string;
  /** Why this new request decides the task question; bounded prose, never authority. */
  purpose: string;
  requests: number;
}

export interface PlanRequestGenerator {
  generatorAttemptId: Id;
  /** 'scripted' is the deterministic inert author used by tests; 'worker' is a real runtime packet. */
  generatorKind: 'scripted' | 'worker';
  /** Informational only; never a runtime grant. */
  requestedSelection: RuntimeSelection;
  inputDigests?: Digest[];
  producedAt: Timestamp;
  /** Digest of the exact raw packet this proposal was derived from; injected by the ledger when absent. */
  packetDigest?: Digest;
}

export interface PlanRequestProposal {
  schemaVersion: 1;
  proposalId: Id;
  runId: Id;
  generator: PlanRequestGenerator;
  requests: PlanRequestDraft[];
}

/** A stored proposal: the exact bytes plus the canonical digest the owner must approve. */
export interface StoredPlanRequestProposal {
  proposalId: Id;
  digest: Digest;
  runId: Id;
  proposal: PlanRequestProposal;
  storedAt: Timestamp;
  generatorAttemptId: Id;
}

/**
 * Owner-authored approval for one exact generated-request proposal. The whole request set (URLs, methods,
 * accounts, bodies, headers, actions and costs) is inside the single canonical proposal digest.
 */
export interface PlanRequestApprovalDocument {
  version: 1;
  approvalId: Id;
  proposalId: Id;
  proposalDigest: Digest;
  runId: Id;
  approvedBy: string;
  reference: string;
  approvedAt: Timestamp;
  expiresAt: Timestamp;
  requestCount: number;
  note?: string;
}

export interface PlanRequestApproval {
  allowed: true;
  digest: Digest;
  proposalId: Id;
  proposalDigest: Digest;
  approvalId: Id;
  approvalDocumentDigest: Digest;
  authorizationRef: string;
  approvedBy: string;
  reference: string;
  expiresAt: Timestamp;
}

/** Owner-approved action/target/capability envelope for one task that may host generated requests. */
export interface PlanRequestTaskGrant {
  taskId: Id;
  targetIds: Id[];
  allowedActions: string[];
  allowedCapabilities: string[];
}

/** Optional per-account narrowing; when supplied, an account must name the target and action it is used for. */
export interface PlanRequestAccountGrant { accountId: Id; targetIds: Id[]; actions: string[] }

/**
 * Controller-derived envelope every proposal is validated against. It mirrors the owner document (targets,
 * accounts, task scopes, actions, capabilities and policy exclusions); a proposal can never introduce a target,
 * account, action, capability or destination exclusion the owner did not already approve.
 */
export interface PlanRequestEnvelope {
  targets: PlanRequestTarget[];
  taskGrants: PlanRequestTaskGrant[];
  accounts: Id[];
  accountGrants?: PlanRequestAccountGrant[];
  allowedCapabilities: string[];
  allowedActions: string[];
  /** Owner policy exclusions, matched by origin + path prefix before any proposal is accepted. */
  exclusions?: Array<{ origin: string; pathPrefixes: string[] }>;
}

export interface PlanRequestTarget { id: Id; kind: 'artifact' | 'web' | 'service' | 'lab'; locator: string }

export interface PlanRequestBinding { targetId: Id; origin: string; path: string }

export function planRequestProposalDigest(proposal: PlanRequestProposal): Digest { return digestJson(proposal); }

const id = r.string({ pattern: ID_PATTERN, maxLength: 128 });
const digest = r.string({ pattern: /^[a-f0-9]{64}$/, maxLength: 64 });
const date = r.string({ format: 'date-time', maxLength: 24 });
const texts = r.array(r.string({ maxLength: 256 }), 0, true);
const selectionRule = r.object({ provider: r.string({ maxLength: 160 }), model: r.string({ maxLength: 240 }), thinking: r.enum(thinkingLevels) });
const headerRule = r.record(r.string({ maxLength: 1_024 }));
const expectationRule = r.object({
  type: r.literal('http'), status: r.number(true, 100, 599),
  bodyIncludes: r.optional(r.string({ maxLength: 4_096 })), mustMatch: r.optional(r.boolean()),
});

export const planRequestDraftRule = r.object({
  requestId: id, taskId: id, tool: r.enum(planRequestTools), method: r.enum(planRequestMethods),
  url: r.string({ maxLength: planRequestLimits.urlChars }), action: r.enum(planRequestActions), accountId: id,
  headers: r.optional(headerRule), body: r.optional(r.string({ maxLength: 65_536 })), expectation: r.optional(expectationRule),
  kind: r.enum(evidenceKinds), classification: r.enum(classifications), summary: r.string({ maxLength: planRequestLimits.summaryChars }),
  purpose: r.string({ maxLength: planRequestLimits.summaryChars }), requests: r.number(true, 1, 1_000_000),
});
export const planRequestDraftSchema = makeSchema<PlanRequestDraft>('plan-request-draft', planRequestDraftRule);

export const planRequestGeneratorRule = r.object({
  generatorAttemptId: id, generatorKind: r.enum(['scripted', 'worker']), requestedSelection: selectionRule,
  inputDigests: r.optional(r.array(digest, 0, true)), producedAt: date, packetDigest: r.optional(digest),
});
export const planRequestProposalRule = r.object({
  schemaVersion: r.literal(1), proposalId: id, runId: id, generator: planRequestGeneratorRule,
  requests: r.array(planRequestDraftRule, 0),
});
export const planRequestProposalSchema = makeSchema<PlanRequestProposal>('plan-request-proposal', planRequestProposalRule);

export const planRequestApprovalDocumentSchema = makeSchema<PlanRequestApprovalDocument>('plan-request-approval', r.object({
  version: r.literal(1), approvalId: id, proposalId: id, proposalDigest: digest, runId: id,
  approvedBy: r.string({ maxLength: 512 }), reference: r.string({ maxLength: 512 }), approvedAt: date, expiresAt: date,
  requestCount: r.number(true, 1, 4_096), note: r.optional(r.string({ maxLength: 4_096 })),
}));

export const planRequestTaskGrantRule = r.object({
  taskId: id, targetIds: r.array(id, 1, true), allowedActions: texts, allowedCapabilities: texts,
});
export const planRequestEnvelopeRule = r.object({
  targets: r.array(r.object({ id, kind: r.enum(['artifact', 'web', 'service', 'lab']), locator: r.string({ maxLength: 4_096 }) }), 1),
  taskGrants: r.array(planRequestTaskGrantRule, 1),
  accounts: r.array(id, 0, true),
  accountGrants: r.optional(r.array(r.object({ accountId: id, targetIds: r.array(id, 1, true), actions: texts }), 0)),
  allowedCapabilities: texts,
  allowedActions: texts,
  exclusions: r.optional(r.array(r.object({ origin: r.string({ maxLength: 4_096 }), pathPrefixes: texts }), 0)),
});
export const planRequestEnvelopeSchema = makeSchema<PlanRequestEnvelope>('plan-request-envelope', planRequestEnvelopeRule);

export interface PlanRequestValidationOptions {
  run: RunManifest;
  envelope: PlanRequestEnvelope;
  /** Stricter of the declared and supplied caps always wins. */
  caps?: Partial<PlanRequestCaps>;
}

const readMethods = new Set<string>(['GET', 'HEAD', 'OPTIONS']);
const identityField = /^(?:authorization|password|passwd|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|api[-_]?key|cookie|session(?:id)?|credential|secret)$/i;
const callerHeaders = new Set<string>(planRequestHeaders);

/** Derived action class of an HTTP method; a proposal may never pair a mutating method with `read`. */
export function planRequestActionFor(method: PlanRequestMethod): PlanRequestAction {
  return readMethods.has(method) ? 'read' : 'mutate';
}

function controlFree(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Resolve a concrete request URL to one owner-approved target inside a task's target subset. New paths and
 * queries are accepted; a different origin, a target path prefix the owner did not approve, credentials or a
 * non-http(s) scheme are not. Returns undefined when nothing matches.
 */
export function planRequestBinding(input: { url: string; taskGrant: PlanRequestTaskGrant; envelope: PlanRequestEnvelope }): PlanRequestBinding | undefined {
  let parsed: URL;
  try { parsed = new URL(input.url); }
  catch { return undefined; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.username || parsed.password || parsed.hash) return undefined;
  const path = parsed.pathname || '/';
  for (const targetId of input.taskGrant.targetIds) {
    const target = input.envelope.targets.find(candidate => candidate.id === targetId);
    if (!target || (target.kind !== 'web' && target.kind !== 'service' && target.kind !== 'lab')) continue;
    let locator: URL;
    try { locator = new URL(target.locator); }
    catch { continue; }
    if (locator.protocol !== 'http:' && locator.protocol !== 'https:') continue;
    if (locator.origin !== parsed.origin) continue;
    const base = locator.pathname.replace(/\/+$/u, '');
    if (base !== '' && path !== base && !path.startsWith(`${base}/`)) continue;
    return { targetId, origin: parsed.origin, path };
  }
  return undefined;
}

/** Owner policy exclusion match, mirroring the runtime scope gate's origin + path-prefix rule. */
function excludedPath(origin: string, path: string, envelope: PlanRequestEnvelope): boolean {
  const within = (prefix: string): boolean => {
    const base = prefix.length > 1 ? prefix.replace(/\/+$/, '') : prefix;
    return base === '/' || path === base || path.startsWith(`${base}/`);
  };
  return (envelope.exclusions ?? []).some(rule => {
    let ruleOrigin: string;
    try { ruleOrigin = new URL(rule.origin).origin; }
    catch { return false; }
    return ruleOrigin === origin && rule.pathPrefixes.some(within);
  });
}

function headerIssues(draft: PlanRequestDraft, add: (code: string, path: string, message: string) => void): void {
  const headers = draft.headers;
  if (!headers) return;
  const seen = new Set<string>();
  let bytes = 0;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const at = `$/requests/${draft.requestId}/headers/${key}`;
    if (!callerHeaders.has(lower) || seen.has(lower)) {
      add('request-plan-header', at, `Header ${key} is not an owner-permitted caller header (${[...callerHeaders].join(', ')}) or is duplicated`);
      continue;
    }
    seen.add(lower);
    if (typeof value !== 'string' || !controlFree(value)) { add('request-plan-header', at, 'Header values must be control-character free strings'); continue; }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
  }
  if (Object.keys(headers).length > planRequestLimits.headerCount) add('request-plan-header', `$/requests/${draft.requestId}/headers`, `At most ${planRequestLimits.headerCount} caller headers are permitted`);
  if (bytes > planRequestLimits.headerBytes) add('request-plan-header', `$/requests/${draft.requestId}/headers`, `Header bytes exceed ${planRequestLimits.headerBytes}`);
}

/** No body may carry identity/secret fields the credential-owning boundary refuses at dispatch. */
function bodyIssues(draft: PlanRequestDraft, add: (code: string, path: string, message: string) => void): void {
  const body = draft.body;
  if (body === undefined) return;
  const at = `$/requests/${draft.requestId}/body`;
  if (Buffer.byteLength(body) > planRequestLimits.bodyBytes) { add('request-plan-body', at, `Body exceeds ${planRequestLimits.bodyBytes} bytes`); return; }
  if (!controlFree(body)) { add('request-plan-body', at, 'Body must not contain control characters'); return; }
  if (readMethods.has(draft.method)) { add('request-plan-body', at, `Read method ${draft.method} may not carry a body`); return; }
  let json: unknown;
  try { json = JSON.parse(body); }
  catch { json = undefined; }
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 24) return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (identityField.test(key)) add('request-plan-body', at, `Body field ${key} looks like credential/identity material and is never model-authored`);
        visit(child, depth + 1);
      }
    }
  };
  if (json !== undefined) visit(json);
  for (const key of new URLSearchParams(body).keys()) {
    if (identityField.test(key)) add('request-plan-body', at, `Body field ${key} looks like credential/identity material and is never model-authored`);
  }
  if (/(?:name\s*=\s*["'](?:password|passwd|token|secret|authorization|cookie)["'])/i.test(body)) {
    add('request-plan-body', at, 'Multipart identity fields are never model-authored');
  }
}

/** Semantics only, after shape validation. Every failure carries a stable explicit code. */
export function validatePlanRequestProposal(input: unknown, options: PlanRequestValidationOptions): PlanIssue[] {
  const parsed = planRequestProposalSchema.safeParse(input);
  if (!parsed.success) return parsed.issues.map(issue => planIssue('request-plan-schema', issue.path, `${issue.code}: ${issue.message}`));
  const proposal = parsed.data;
  const envelope = options.envelope;
  const run = options.run;
  const issues: PlanIssue[] = [];
  const add = (code: string, path: string, message: string): void => { if (issues.length < 100) issues.push(planIssue(code, path, message)); };
  const caps: PlanRequestCaps = {
    maxRequests: options.caps?.maxRequests ?? planRequestCapsDefaults.maxRequests,
    maxProposals: options.caps?.maxProposals ?? planRequestCapsDefaults.maxProposals,
  };

  if (proposal.runId !== run.runId) add('request-plan-run-identity', '$/runId', 'Proposal targets another run');
  if (proposal.requests.length === 0) add('request-plan-empty', '$/requests', 'A generated request proposal needs at least one concrete request');

  const requestIds = new Set<string>();
  const grants = new Map(envelope.taskGrants.map(grant => [grant.taskId, grant]));
  const approvedTargets = new Map(run.authorization.targets.map(target => [target.id, target]));
  const perTarget = new Map<string, number>();
  for (const draft of proposal.requests) {
    const at = (field: string): string => `$/requests/${draft.requestId}/${field}`;
    if (requestIds.has(draft.requestId)) add('request-plan-duplicate-request', '$/requests', 'Request identities must be unique');
    requestIds.add(draft.requestId);
    const grant = grants.get(draft.taskId);
    if (!grant) { add('request-plan-task', at('taskId'), `Task ${draft.taskId} is not an owner-approved generated-request host`); continue; }
    if (draft.tool !== 'http.request') { add('request-plan-tool', at('tool'), `Generated requests are http.request only; ${String(draft.tool)} is not model-authorable`); continue; }
    if (!grant.allowedCapabilities.includes(draft.tool) || !envelope.allowedCapabilities.includes(draft.tool) || !run.allowedCapabilities.includes(draft.tool)) {
      add('request-plan-capability', at('tool'), 'http.request is not owner-granted to this task, envelope and run');
    }
    if (draft.action !== planRequestActionFor(draft.method)) {
      add('request-plan-action', at('action'), `Method ${draft.method} is a ${planRequestActionFor(draft.method)} action and may not be proposed as ${draft.action}`);
    }
    if (!grant.allowedActions.includes(draft.action) || !envelope.allowedActions.includes(draft.action) || !run.authorization.allowedActions.includes(draft.action)) {
      add('request-plan-action', at('action'), `Action ${draft.action} is not owner-granted to this task, envelope and run`);
    }
    const accountApproved = envelope.accounts.includes(draft.accountId);
    if (!accountApproved) add('request-plan-account', at('accountId'), `Account ${draft.accountId} is not in the owner-approved account set`);
    if (typeof draft.url !== 'string' || draft.url.length === 0 || draft.url.length > planRequestLimits.urlChars || !controlFree(draft.url)) {
      add('request-plan-url', at('url'), 'Request URL must be a bounded control-character-free string');
      continue;
    }
    if (draft.url.includes('*')) { add('request-plan-url', at('url'), 'Generated request URLs may not be wildcards'); continue; }
    let parsedUrl: URL;
    try { parsedUrl = new URL(draft.url); }
    catch { add('request-plan-url', at('url'), 'Request URL is not an absolute URL'); continue; }
    if (parsedUrl.username || parsedUrl.password) { add('request-plan-url', at('url'), 'Request URL may not carry credentials'); continue; }
    if (parsedUrl.hash) { add('request-plan-url', at('url'), 'Request URL may not carry a fragment'); continue; }
    const binding = planRequestBinding({ url: draft.url, taskGrant: grant, envelope });
    if (!binding) {
      add('request-plan-target', at('url'), `Request URL is outside every owner-approved target of task ${draft.taskId}`);
      continue;
    }
    const authorized = approvedTargets.get(binding.targetId);
    if (!authorized) { add('request-plan-target', at('url'), `Target ${binding.targetId} is not in the admitted run authorization`); continue; }
    const declared = envelope.targets.find(target => target.id === binding.targetId);
    if (!declared || authorized.locator !== declared.locator || authorized.kind !== declared.kind) {
      add('request-plan-target', at('url'), 'Envelope target identity or locator differs from the run authorization');
      continue;
    }
    if (excludedPath(binding.origin, parsedUrl.pathname || '/', envelope)) {
      add('request-plan-target', at('url'), 'Request URL matches an owner policy exclusion');
      continue;
    }
    if (accountApproved && envelope.accountGrants) {
      const account = envelope.accountGrants.find(entry => entry.accountId === draft.accountId);
      if (!account || !account.actions.includes(draft.action) || !account.targetIds.includes(binding.targetId)) {
        add('request-plan-account', at('accountId'), `Account ${draft.accountId} is not owner-bound to this target and action`);
      }
    }
    headerIssues(draft, add);
    bodyIssues(draft, add);
    if (draft.expectation === undefined) add('request-plan-expectation', at('expectation'), 'A generated request must declare its http expectation');
    perTarget.set(binding.targetId, (perTarget.get(binding.targetId) ?? 0) + draft.requests);
  }

  const requestSum = proposal.requests.reduce((sum, draft) => sum + draft.requests, 0);
  if (requestSum > caps.maxRequests) add('request-plan-budget', '$/requests', `Proposal requests ${requestSum} target requests; cap is ${caps.maxRequests}`);
  if (proposal.requests.length > envelope.taskGrants.length) {
    add('request-plan-count', '$/requests', 'Proposal declares more requests than the owner-approved task grant list');
  }
  const runLimit = run.budgets.maxRequests;
  if (requestSum > runLimit) add('request-plan-budget', '$/requests', `Proposal requests ${requestSum} target requests; run budget is ${runLimit}`);
  for (const [targetId, count] of perTarget) {
    const limit = run.budgets.targetRequestLimits?.[targetId];
    if (limit !== undefined && count > limit) add('request-plan-budget', `$/requests/${targetId}`, `Proposal requests ${count} target requests for ${targetId}; run limit is ${limit}`);
  }
  return issues;
}

/** Bounded, JSON-safe copy of the concrete request input the controller will execute (never model prose). */
export function planRequestInput(draft: PlanRequestDraft): JsonObject {
  return {
    url: draft.url, method: draft.method, action: draft.action, accountId: draft.accountId,
    ...(draft.headers ? { headers: { ...draft.headers } } : {}),
    ...(draft.body === undefined ? {} : { body: draft.body }),
  };
}
