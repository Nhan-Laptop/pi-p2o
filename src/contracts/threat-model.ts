import type { Digest, Id, Timestamp } from './types.js';
import { ID_PATTERN } from './schemas.js';
import { digestJson, makeSchema, rules as r } from './validation.js';

/**
 * Run-scoped shared threat model. One document per run and normalized target key; every worker reads
 * the same bounded document and may only append an attributed, size-capped addendum. A fresh run starts
 * with no model — nothing is inherited from an earlier run or from another target spelling.
 */
export const threatModelCapsDefaults = Object.freeze({
  maxBodyChars: 16_384,
  maxAmendmentChars: 2_048,
  maxAmendments: 64,
});

export interface ThreatModelCaps {
  /** Bound on the baseline body, in characters. */
  maxBodyChars: number;
  /** Bound on one amendment, in characters. */
  maxAmendmentChars: number;
  /** Bound on the number of append-only amendments on one document. */
  maxAmendments: number;
}

export interface ThreatModelAmendment {
  amendmentId: Id;
  /** Attempt that authored the addendum; attribution is recorded, never inferred. */
  authorAttemptId: Id;
  at: Timestamp;
  /** Digest of `text` exactly as appended. */
  digest: Digest;
  text: string;
}

export interface ThreatModel {
  schemaVersion: 1;
  runId: Id;
  /** Normalized target key; equivalent spellings of one host/path collapse to one model. */
  targetKey: string;
  body: string;
  bodyDigest: Digest;
  /** Monotonic body revision; amendments do not bump it. */
  revision: number;
  createdAt: Timestamp;
  createdByAttemptId: Id;
  amendments: ThreatModelAmendment[];
  caps: ThreatModelCaps;
}

const id = r.string({ pattern: ID_PATTERN, maxLength: 128 });
const digest = r.string({ pattern: /^[a-f0-9]{64}$/, maxLength: 64 });
const date = r.string({ format: 'date-time', maxLength: 24 });
const caps = r.object({
  maxBodyChars: r.number(true, 256, 1_048_576),
  maxAmendmentChars: r.number(true, 128, 262_144),
  maxAmendments: r.number(true, 0, 4_096),
});
const amendmentRule = r.object({
  amendmentId: id,
  authorAttemptId: id,
  at: date,
  digest,
  text: r.string({ minLength: 1, maxLength: 262_144 }),
});

export const threatModelAmendmentSchema = makeSchema<ThreatModelAmendment>('threat-model-amendment', amendmentRule);

export const threatModelCapsSchema = makeSchema<ThreatModelCaps>('threat-model-caps', caps);

export const threatModelSchema = makeSchema<ThreatModel>('threat-model', r.object({
  schemaVersion: r.literal(1),
  runId: id,
  targetKey: r.string({ minLength: 1, maxLength: 2_048 }),
  body: r.string({ minLength: 1, maxLength: 1_048_576 }),
  bodyDigest: digest,
  revision: r.number(true, 1),
  createdAt: date,
  createdByAttemptId: id,
  amendments: r.array(amendmentRule, 0),
  caps,
}), (model, issues) => {
  const add = (path: string, code: string, message: string) => { if (issues.length < 100) issues.push({ path, code, message }); };
  if (model.body.length > model.caps.maxBodyChars) add('$/body', 'threat-model-size', 'Threat-model body exceeds its declared size cap');
  if (digestJson(model.body) !== model.bodyDigest) add('$/bodyDigest', 'threat-model-digest', 'Body digest does not match the body');
  if (model.amendments.length > model.caps.maxAmendments) add('$/amendments', 'threat-model-amendments', 'Threat model exceeds its amendment count cap');
  const seen = new Set<string>();
  for (const [index, amendment] of model.amendments.entries()) {
    if (seen.has(amendment.amendmentId)) add(`$/amendments/${index}/amendmentId`, 'threat-model-amendment-id', 'Amendment identities must be unique');
    seen.add(amendment.amendmentId);
    if (amendment.text.length > model.caps.maxAmendmentChars) add(`$/amendments/${index}/text`, 'threat-model-amendment-size', 'Amendment exceeds its declared size cap');
    if (digestJson(amendment.text) !== amendment.digest) add(`$/amendments/${index}/digest`, 'threat-model-amendment-digest', 'Amendment digest does not match its text');
    if (Date.parse(amendment.at) < Date.parse(model.createdAt)) add(`$/amendments/${index}/at`, 'threat-model-amendment-time', 'Amendment predates the model it amends');
  }
});

/** Digest binding of the whole document, including every amendment. */
export function threatModelDigest(model: ThreatModel): Digest {
  return digestJson({ runId: model.runId, targetKey: model.targetKey, body: model.body, revision: model.revision, amendmentDigests: model.amendments.map(a => a.digest) });
}

const credentialLike = /@/;

/**
 * Normalize a target spelling to one stable key. A URL collapses to scheme://host[:port][/path] with no
 * credentials, query or fragment; a repository/artifact path only loses trailing separators. Anything with
 * an ambiguous or credential-bearing spelling is refused rather than guessed.
 */
export function normalizeTargetKey(locator: string): string {
  if (typeof locator !== 'string') throw new TypeError('target locator must be a string');
  const value = locator.trim();
  if (!value || value.length > 2_048 || /[\u0000-\u001f]/.test(value)) throw new TypeError('target locator is empty or unbounded');
  let url: URL | undefined;
  try { url = new URL(value); } catch { url = undefined; }
  if (url) {
    if (!['http:', 'https:', 'tcp:', 'udp:', 'file:'].includes(url.protocol)) throw new TypeError(`unsupported target scheme: ${url.protocol}`);
    if (url.username || url.password) throw new TypeError('target locator must not carry credentials');
    if (url.search || url.hash) throw new TypeError('target locator must not carry a query or fragment');
    const host = url.hostname.toLowerCase();
    if (!host && url.protocol !== 'file:') throw new TypeError('target locator has no host');
    const port = url.port ? `:${url.port}` : '';
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    return `${url.protocol}//${host}${port}${path}`;
  }
  if (credentialLike.test(value)) throw new TypeError('target locator must not carry credentials');
  return value.replace(/\/+$/u, '') || value;
}

/** Bounded, read-only projection. Truncation is explicit and never presented as the full document. */
export interface BoundedThreatModel {
  found: boolean;
  runId: Id;
  targetKey: string;
  revision: number;
  body: string;
  bodyTruncated: boolean;
  amendmentCount: number;
  amendments: ThreatModelAmendment[];
  amendmentsTruncated: boolean;
}

export function readThreatModelBounded(model: ThreatModel | undefined, runId: Id, targetKey: string, limits: { maxBodyChars?: number; maxAmendments?: number } = {}): BoundedThreatModel {
  if (!model) return { found: false, runId, targetKey, revision: 0, body: '', bodyTruncated: false, amendmentCount: 0, amendments: [], amendmentsTruncated: false };
  const bodyLimit = Math.min(limits.maxBodyChars ?? model.caps.maxBodyChars, model.caps.maxBodyChars);
  const amendmentLimit = Math.min(limits.maxAmendments ?? model.caps.maxAmendments, model.caps.maxAmendments);
  return {
    found: true,
    runId: model.runId,
    targetKey: model.targetKey,
    revision: model.revision,
    body: model.body.slice(0, bodyLimit),
    bodyTruncated: model.body.length > bodyLimit,
    amendmentCount: model.amendments.length,
    amendments: model.amendments.slice(-amendmentLimit),
    amendmentsTruncated: model.amendments.length > amendmentLimit,
  };
}

