/**
 * W-Y (A): HAR-first evidence materiality. One pure module owns the frozen traffic snapshot: the browser writes a HAR inside
 * the sandbox, the host freezes a bounded, redacted prefix of each request/response pair into its own artifact (hash = the
 * snapshot's identity), and a case rating cites the frozen exchange by an owner-imported `snapshotRef`. Nothing here reads
 * files, spawns processes, talks to a target or authorizes anything: it is the deterministic join between an imported HAR,
 * the stored snapshot note and the case rating, plus the version the report prints and refuses to forget.
 *
 * Redaction happens BEFORE hashing, through the caller's injected function (evidence.ts `redact` plus the run identity's
 * exact-value redaction), so a secret that survives is a known limit of best-effort redaction, never a hash of raw bytes.
 * Header names that are themselves the credential contract (cookie, set-cookie, authorization, proxy-authorization,
 * x-api-key, x-auth-token) are masked to '[REDACTED]' before hashing: the generic pattern redaction only recognizes a value
 * that carries its key, and a HAR header stores the name and value in separate fields.
 * Every bound is explicit: FROZEN_ENTRY_LIMIT retained entries out of FROZEN_SCAN_LIMIT scanned, 64 KiB per frozen entry,
 * 1 KiB per header value, 16 KiB per body. A malformed HAR is a warning, never a throw.
 */
import { graphCanonical } from './state/graph.js';
import { sha256Hex } from './validate.js';
import { REPRODUCTION_ROLES, type ReproductionStep } from './case-types.js';
import type { LedgerIndex } from './records.js';

export const TRAFFIC_SNAPSHOT_FORMAT = 'p2o-traffic/1';
/** Entries retained in the frozen snapshot; a longer capture is counted in `omitted`, never silently truncated. */
export const FROZEN_ENTRY_LIMIT = 12;
/** Entries scanned before the retained cap applies, so one huge HAR stays linear and bounded. */
export const FROZEN_SCAN_LIMIT = 24;
/** A single frozen snapshot artifact must stay readable; the entry JSON cap is what the importer enforces. */
export const FROZEN_ENTRY_BYTES = 64 * 1024;
export const FROZEN_URL_BYTES = 2048;
export const FROZEN_HEADER_LIMIT = 12;
export const FROZEN_HEADER_NAME_BYTES = 120;
export const FROZEN_HEADER_VALUE_BYTES = 1024;
export const FROZEN_BODY_BYTES = 16 * 1024;
/** The role vocabulary is the case's own reproduction vocabulary; traffic evidence adds no second taxonomy. */
export const TRAFFIC_ROLES = REPRODUCTION_ROLES;
export type TrafficRole = ReproductionStep['role'];

export interface FrozenHttpPart {
  headers: Record<string, string>;
  headersSha256: string;
  body?: string;
  /** Bytes of the redacted body before truncation; 0 when the HAR carried no text body. */
  bodyBytes: number;
  bodyTruncated: boolean;
  /** SHA-256 of the retained redacted body bytes (`''` when no body was retained). */
  bodySha256: string;
}
export interface FrozenEntry {
  position: number;
  method: string;
  url: string;
  status: number | null;
  request: FrozenHttpPart;
  response: FrozenHttpPart;
  requestSha256: string;
  responseSha256: string;
}
/** One ordered citation of a frozen exchange. `sha256` is the frozen snapshot artifact's stored manifest hash. */
export interface TrafficRef { role: TrafficRole; position: number; snapshotRef: string; sha256: string }
export interface TrafficBinding { trafficRefs: TrafficRef[]; evidenceVersion?: string }

const SNAPSHOT_REF = /^artifact-[a-f0-9-]{36}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** A header whose name alone is the credential contract: its value is masked whatever bytes it carries. */
const CREDENTIAL_HEADER = /^(?:cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/** UTF-8 prefix that never splits a codepoint; reports the pre-truncation byte count for the retained-body claim. */
function bytePrefix(value: string, max: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= max) return { text: value, bytes: bytes.length, truncated: false };
  let end = max; while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), bytes: bytes.length, truncated: true };
}

/** Array pairs (HAR header shape) → bounded object; the last duplicate name wins, as in a browser profile. */
function frozenHeaders(value: unknown, redact: (text: string) => string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!Array.isArray(value)) return headers;
  for (const item of value) {
    if (Object.keys(headers).length >= FROZEN_HEADER_LIMIT) break;
    if (!isRecord(item)) continue;
    const name = bytePrefix(redact(String(item.name ?? '')), FROZEN_HEADER_NAME_BYTES).text.toLowerCase().trim();
    if (!name) continue;
    const value = bytePrefix(redact(String(item.value ?? '')), FROZEN_HEADER_VALUE_BYTES).text;
    headers[name] = CREDENTIAL_HEADER.test(name) ? '[REDACTED]' : value;
  }
  return headers;
}

/** One request/response half: redacted headers and a redacted, bounded text body, each hashed after redaction. */
function frozenPart(headers: unknown, body: unknown, redact: (text: string) => string): FrozenHttpPart {
  const keptHeaders = frozenHeaders(headers, redact);
  const raw = typeof body === 'string' ? redact(body) : undefined;
  const retained = raw === undefined || raw === '' ? undefined : bytePrefix(raw, FROZEN_BODY_BYTES);
  const part: FrozenHttpPart = { headers: keptHeaders, headersSha256: sha256Hex(graphCanonical(keptHeaders)), bodyBytes: retained?.bytes ?? 0, bodyTruncated: retained?.truncated ?? false, bodySha256: retained ? sha256Hex(retained.text) : '' };
  if (retained) part.body = retained.text;
  return part;
}

/** The canonical bytes of one frozen entry: what the artifact stores and the note hashes. */
export function snapshotJson(entry: FrozenEntry): string {
  return graphCanonical({ format: TRAFFIC_SNAPSHOT_FORMAT, entry: {
    position: entry.position, method: entry.method, url: entry.url, status: entry.status, requestSha256: entry.requestSha256,
    responseSha256: entry.responseSha256, request: entry.request, response: entry.response } });
}
export function snapshotByteLength(entry: FrozenEntry): number { return Buffer.byteLength(snapshotJson(entry)); }

/** Fit one entry under FROZEN_ENTRY_BYTES by halving retained bodies; the headers cap already fits on its own. */
function fitEntry(entry: FrozenEntry): FrozenEntry {
  let current = entry;
  const shrink = (part: FrozenHttpPart): FrozenHttpPart => {
    if (part.body === undefined) return part;
    const next = bytePrefix(part.body, Math.floor(Buffer.byteLength(part.body, 'utf8') / 2));
    return { ...part, body: next.text || undefined, bodyTruncated: true, bodySha256: next.text ? sha256Hex(next.text) : '' };
  };
  for (let guard = 0; guard < 64 && snapshotByteLength(current) > FROZEN_ENTRY_BYTES; guard += 1) {
    const request = shrink(current.request), response = shrink(current.response);
    if (request.body === undefined && response.body === undefined) break;
    current = { ...current, request, response, requestSha256: sha256Hex(graphCanonical(request)), responseSha256: sha256Hex(graphCanonical(response)) };
  }
  return current;
}

/**
 * Parse one HAR document into bounded frozen entries. Redaction is applied to every retained URL, header value and body
 * before the hash is taken; an invalid document, a missing `log.entries` or a malformed entry returns a warning, never throws.
 */
export function parseFrozenEntries(text: string, redact: (value: string) => string = value => value): { entries: FrozenEntry[]; warnings: string[]; omitted: number } {
  const failed = (warning: string) => ({ entries: [] as FrozenEntry[], warnings: [warning], omitted: 0 });
  if (typeof text !== 'string' || !text.trim()) return failed('Traffic snapshot is empty');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return failed('Traffic snapshot is not valid JSON'); }
  const log = isRecord(parsed) ? parsed.log : undefined;
  const rows = isRecord(log) && Array.isArray(log.entries) ? log.entries : undefined;
  if (!rows) return failed('Traffic snapshot has no log.entries array; a HAR document is required');
  const warnings: string[] = [], entries: FrozenEntry[] = [];
  let scanned = 0, malformed = 0, base64 = 0, anyTruncated = false;
  for (const row of rows) {
    if (scanned >= FROZEN_SCAN_LIMIT || entries.length >= FROZEN_ENTRY_LIMIT) break;
    scanned += 1;
    const request = isRecord(row) && isRecord(row.request) ? row.request : undefined, response = isRecord(row) && isRecord(row.response) ? row.response : undefined;
    const url = asText(request?.url), method = (asText(request?.method) ?? 'GET').trim().toUpperCase().slice(0, 16) || 'GET';
    if (!url || !/^[A-Z-]{1,16}$/.test(method)) { malformed += 1; continue; }
    const content = isRecord(response?.content) ? response.content : undefined, encoding = asText(content?.encoding);
    if (encoding === 'base64') base64 += 1;
    const postData = isRecord(request?.postData) ? asText(request.postData.text) : undefined;
    const requestPart = frozenPart(request?.headers, postData, redact), responsePart = frozenPart(response?.headers, encoding === 'base64' ? undefined : asText(content?.text), redact);
    if (requestPart.bodyTruncated || responsePart.bodyTruncated) anyTruncated = true;
    const retainedUrl = bytePrefix(redact(url), FROZEN_URL_BYTES), position = entries.length + 1;
    entries.push(fitEntry({ position, method, url: retainedUrl.text, status: typeof response?.status === 'number' && Number.isFinite(response.status) ? Math.trunc(response.status) : null,
      request: requestPart, response: responsePart, requestSha256: sha256Hex(graphCanonical(requestPart)), responseSha256: sha256Hex(graphCanonical(responsePart)) }));
  }
  const omitted = Math.max(0, rows.length - entries.length);
  if (malformed) warnings.push(`${malformed} HAR entr${malformed === 1 ? 'y' : 'ies'} had no request URL/method and were skipped`);
  if (base64) warnings.push(`${base64} HAR body(ies) were base64-encoded and are not retained as text`);
  if (anyTruncated) warnings.push(`Traffic snapshot bodies were truncated at ${FROZEN_BODY_BYTES} bytes each; bodyBytes/bodyTruncated name the discarded bytes`);
  if (omitted) warnings.push(`${omitted} HAR entr${omitted === 1 ? 'y is' : 'ies are'} past the ${FROZEN_ENTRY_LIMIT}-entry retained / ${FROZEN_SCAN_LIMIT}-entry scan limit and are not part of the snapshot`);
  if (!entries.length) warnings.push('Traffic snapshot retained no usable entry');
  return { entries, warnings, omitted };
}

/** Canonical evidence version: the ordered citations (role, position, ref, snapshot hash) as one 64-hex identity. */
export function evidenceVersionOf(refs: readonly TrafficRef[]): string {
  return sha256Hex(graphCanonical({ version: 1, refs: refs.map(ref => ({ role: ref.role, position: ref.position, snapshotRef: ref.snapshotRef, sha256: ref.sha256 })) }));
}

/** The stored owner notes this run imported: snapshotRef → frozen artifact hash. Malformed entries are ignored. */
function trafficSnapshots(index: LedgerIndex, runId?: string): Map<string, { sha256: string }> {
  const found = new Map<string, { sha256: string }>();
  for (const row of index.records) {
    if (row.kind !== 'note' || row.by !== 'owner' || row.workerId || (runId !== undefined && row.runId !== undefined && row.runId !== runId)) continue;
    const data = row.data?.trafficSnapshot as Record<string, unknown> | undefined;
    if (!isRecord(data) || data.format !== TRAFFIC_SNAPSHOT_FORMAT || !Array.isArray(data.snapshots)) continue;
    for (const item of data.snapshots) {
      if (!isRecord(item)) continue;
      const snapshotRef = item.snapshotRef, hash = item.sha256;
      if (typeof snapshotRef !== 'string' || !SNAPSHOT_REF.test(snapshotRef) || typeof hash !== 'string' || !SHA256.test(hash)) continue;
      found.set(snapshotRef, { sha256: hash });
    }
  }
  return found;
}

/**
 * Bind a case rating's ordered reproduction steps to this run's frozen snapshots. All steps name a snapshot or none do: a
 * partial binding would let a reader mistake the named exchange for the whole reproduction. Returns the host-computed refs
 * (never accepted from the model) plus the evidence version the report prints.
 */
export function resolveTrafficBinding(index: LedgerIndex, runId: string, steps: readonly ReproductionStep[]): TrafficBinding {
  const named = steps.filter(step => step.snapshotRef !== undefined);
  if (named.length && named.length !== steps.length) throw Error('TRAFFIC_REFS_INCOMPLETE: either every reproduction step names its frozen traffic snapshot or none does');
  if (!named.length) return { trafficRefs: [] };
  const known = trafficSnapshots(index, runId), seen = new Set<string>(), trafficRefs: TrafficRef[] = [];
  for (const [indexStep, step] of steps.entries()) {
    const snapshotRef = step.snapshotRef!;
    if (seen.has(snapshotRef)) throw Error('Duplicate traffic snapshot reference');
    seen.add(snapshotRef);
    const snapshot = known.get(snapshotRef);
    if (!snapshot) throw Error(`Unknown same-run traffic snapshot ${snapshotRef}; import the HAR first (p2o_graph_plan action=ingest) and cite the snapshotRef it returns`);
    trafficRefs.push({ role: step.role, position: indexStep + 1, snapshotRef, sha256: snapshot.sha256 });
  }
  return { trafficRefs, evidenceVersion: evidenceVersionOf(trafficRefs) };
}

/** Defensive read of host-computed traffic fields from one stored `data.caseRating`; malformed values are dropped, not promoted. */
export function storedTrafficBinding(value: unknown): TrafficBinding {
  const rating = isRecord(value) ? value : undefined;
  const version = rating && typeof rating.evidenceVersion === 'string' && SHA256.test(rating.evidenceVersion) ? rating.evidenceVersion : undefined;
  if (!rating || !version || !Array.isArray(rating.trafficRefs) || !rating.trafficRefs.length) return { trafficRefs: [] };
  const trafficRefs: TrafficRef[] = [];
  for (const [position, item] of rating.trafficRefs.entries()) {
    if (!isRecord(item)) return { trafficRefs: [] };
    const role = item.role, snapshotRef = item.snapshotRef, hash = item.sha256;
    if (typeof role !== 'string' || !(TRAFFIC_ROLES as readonly string[]).includes(role) || typeof snapshotRef !== 'string' || !SNAPSHOT_REF.test(snapshotRef)
      || typeof hash !== 'string' || !SHA256.test(hash) || item.position !== position + 1) return { trafficRefs: [] };
    trafficRefs.push({ role: role as TrafficRole, position: position + 1, snapshotRef, sha256: hash });
  }
  return { trafficRefs, evidenceVersion: version };
}

/**
 * Verify every stored rating's frozen traffic evidence: the cited snapshot note must exist, its artifact must still hash to
 * the recorded value, and the stored evidence version must equal the one the current citations derive. A missing artifact or
 * a read failure is an issue in the result, never a throw — the report can refuse on the issues instead of crashing.
 */
export function verifyTrafficEvidence(index: LedgerIndex, readArtifact: (ref: string) => Buffer): { ok: boolean; issues: string[]; versions: Array<{ caseId: string; evidenceVersion: string }> } {
  const issues: string[] = [], versions: Array<{ caseId: string; evidenceVersion: string }> = [], known = trafficSnapshots(index);
  for (const row of index.records) {
    if (row.kind !== 'note' || row.by !== 'owner' || row.workerId || !row.id) continue;
    const rating = row.data?.caseRating as Record<string, unknown> | undefined;
    if (!isRecord(rating) || !Array.isArray(rating.trafficRefs) || typeof rating.evidenceVersion !== 'string') continue;
    const caseId = typeof rating.caseId === 'string' ? rating.caseId : `record ${row.id}`, binding = storedTrafficBinding(rating);
    if (!binding.trafficRefs.length || !binding.evidenceVersion) { issues.push(`rating ${row.id}: malformed traffic binding`); continue; }
    versions.push({ caseId, evidenceVersion: binding.evidenceVersion });
    const current: TrafficRef[] = [];
    for (const ref of binding.trafficRefs) {
      const snapshot = known.get(ref.snapshotRef);
      if (!snapshot) { issues.push(`rating ${row.id}: unknown traffic snapshot ${ref.snapshotRef}`); continue; }
      try {
        const bytes = readArtifact(ref.snapshotRef);
        if (sha256Hex(bytes) !== snapshot.sha256) { issues.push(`rating ${row.id}: snapshot ${ref.snapshotRef} does not match its stored hash`); continue; }
      } catch { issues.push(`snapshot ${ref.snapshotRef} is no longer readable`); continue; }
      current.push({ ...ref, sha256: snapshot.sha256 });
    }
    if (current.length === binding.trafficRefs.length && evidenceVersionOf(current) !== binding.evidenceVersion) issues.push(`rating ${row.id}: evidence version ${binding.evidenceVersion.slice(0, 16)} does not match the cited snapshots`);
  }
  return { ok: issues.length === 0, issues: issues.length > 10 ? [...issues.slice(0, 9), `and ${issues.length - 9} more evidence issue(s)`] : issues, versions };
}
