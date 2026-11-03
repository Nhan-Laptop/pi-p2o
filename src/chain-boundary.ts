import type { AssessmentRecord } from './records.js';

/**
 * W-AB Option B (finding F15; H16): the foothold/pivot boundary a chain step's receipts were gathered under.
 *
 * A run can hold one interactive foothold shell per session (one peer connection) and turn an identified foothold into a
 * reverse SOCKS5 pivot; before this read, two steps on two obtained hosts projected exactly like two steps on one. The
 * boundary is derived from records that already exist, never from a model field and never from a second store:
 *
 *  - a `lifecycle` row whose `data.session` names `foothold-open`, `foothold-identity` or `tunnel-open` is the boundary fact,
 *    keyed by the session id that owns the one connection/pivot (`foothold-identity` supplies the observed account);
 *  - an `evidence` receipt names the session whose executor produced its bytes in `data.sessionRef`, and a lifecycle fact may
 *    name the receipt it recorded (`evidenceId`, e.g. `foothold-send`), so both directions link receipt -> session;
 *  - a `candidate` claim's cited receipts (`refs`, or `data.evidenceRefs` for an older row) therefore resolve to the sessions
 *    its observation came from, and those sessions' boundaries become the claim's, and its chain step's.
 *
 * This is attribution by recorded facts, in the same class as the retest provenance check: it says which boundary the run's
 * own records put the step under, not that the effect crossed it. Nothing here is a rung, rating, proof, readiness or
 * authority input, and W-AB Option B leaves the ladder unchanged; the report prints it as one line.
 */

/** One recorded foothold or pivot the session holds. `session` is the boundary identity: one peer connection/pivot per session. */
export interface ChainBoundary {
  kind: 'foothold' | 'pivot';
  session: string;
  /** Foothold: its target-facing port. Pivot: the loopback SOCKS5 port the session proxies through. */
  port: number;
  /** Lab-network address recorded with the transition (target-side address handed to the peer, or the relay's dial-back). */
  address?: string;
  /** The account the foothold's identity observation recorded through the shell, when one was recorded. */
  user?: string;
  uid?: number;
}

export interface ChainBoundaryIndex {
  /** Recorded boundaries per claim identity: the candidate slug and every ledger record id the claim was recorded under. */
  byClaim: Map<string, ChainBoundary[]>;
  /** Recorded boundaries per session id, for a caller that starts from a session rather than a claim. */
  bySession: Map<string, ChainBoundary[]>;
}

/** One claim's list stays small and printable; the claim itself cites at most ten receipts. */
export const CHAIN_BOUNDARY_MAX_PER_CLAIM = 8;
/** One step's list is a display cap: a step citing many receipts still names a bounded set of boundaries. */
export const CHAIN_BOUNDARY_MAX_PER_STEP = 4;
const SESSION_MAX = 80, ADDRESS_MAX = 120, USER_MAX = 80;

const clipped = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined;
const integer = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => rows(value).filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 80);
const identity = (boundary: Pick<ChainBoundary, 'kind' | 'session' | 'port'>): string => `${boundary.kind}\u0000${boundary.session}\u0000${boundary.port}`;

/** Deterministic dedupe, order preserved: one boundary per recorded transition, not one per cited receipt. */
export function mergeBoundaries(boundaries: readonly ChainBoundary[], max = CHAIN_BOUNDARY_MAX_PER_STEP): ChainBoundary[] {
  const seen = new Set<string>(), merged: ChainBoundary[] = [];
  for (const boundary of boundaries) {
    const key = identity(boundary);
    if (seen.has(key) || merged.length >= max) continue;
    seen.add(key);
    merged.push(boundary);
  }
  return merged;
}

/** A reader-facing boundary reference: `foothold session-1a2b3c4d:4444 (www-data)` or `pivot session-....:1080`. */
export function boundaryRef(boundary: ChainBoundary): string {
  const base = `${boundary.kind} ${clipped(boundary.session, SESSION_MAX)}:${boundary.port}`;
  return boundary.user ? `${base} (${clipped(boundary.user, USER_MAX)})` : base;
}

/** The boundary a session's lifecycle rows recorded, including a duplicate transition's later address/account. */
function recordBoundary(bySession: Map<string, ChainBoundary[]>, boundary: ChainBoundary): void {
  const existing = bySession.get(boundary.session) ?? [];
  const same = existing.find(row => identity(row) === identity(boundary));
  if (same) {
    // A later row refines the same transition (an identity observation, a re-read address); it never starts a second row.
    if (boundary.address !== undefined && same.address === undefined) same.address = boundary.address;
    if (boundary.user !== undefined) same.user = boundary.user;
    if (boundary.uid !== undefined) same.uid = boundary.uid;
  } else if (existing.length < CHAIN_BOUNDARY_MAX_PER_CLAIM) existing.push(boundary);
  bySession.set(boundary.session, existing);
}

/**
 * Derive the recorded boundaries and the claim identities that cite their sessions. Pure and bounded: every value is
 * validated and clipped, a malformed row contributes nothing, and a claim with no boundary keeps no entry (no empty noise).
 */
export function chainBoundaryIndex(records: readonly AssessmentRecord[]): ChainBoundaryIndex {
  const bySession = new Map<string, ChainBoundary[]>(), evidenceSession = new Map<string, string>();
  // Pass 1: the recorded transitions. A session is the boundary identity (one foothold/pivot per session at a time).
  for (const record of records) {
    const data = record.data?.session as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const session = text(data.id, SESSION_MAX);
    if (session && typeof data.evidenceId === 'string' && data.evidenceId.length > 0) evidenceSession.set(data.evidenceId, session);
    if (!session) continue;
    const address = text(data.address, ADDRESS_MAX);
    if (data.event === 'foothold-open') {
      const port = integer(data.port, 1, 65535);
      if (port !== undefined) recordBoundary(bySession, { kind: 'foothold', session, port, ...(address ? { address } : {}) });
    } else if (data.event === 'foothold-identity') {
      const user = text(data.user, USER_MAX), uid = integer(data.uid, 0, 2 ** 31 - 1);
      if (user === undefined && uid === undefined) continue;
      const foothold = (bySession.get(session) ?? []).find(row => row.kind === 'foothold');
      // The identity fact carries the port too, so a snapshot that no longer holds the open row still names the boundary.
      if (foothold) { if (user !== undefined) foothold.user = user; if (uid !== undefined) foothold.uid = uid; }
      else {
        const port = integer(data.port, 1, 65535);
        if (port !== undefined) recordBoundary(bySession, { kind: 'foothold', session, port, ...(address ? { address } : {}), ...(user !== undefined ? { user } : {}), ...(uid !== undefined ? { uid } : {}) });
      }
    } else if (data.event === 'tunnel-open') {
      const socks = integer(data.socks, 1, 65535) ?? integer(data.port, 1, 65535);
      if (socks !== undefined) recordBoundary(bySession, { kind: 'pivot', session, port: socks, ...(address ? { address } : {}) });
    }
  }
  // Pass 2: receipt -> session, from the executor that produced the bytes. The lifecycle `evidenceId` link above covers receipts
  // that never ran inside the session container (a foothold send), so both directions are read.
  for (const record of records) {
    if (record.kind !== 'evidence' || !record.id) continue;
    const session = text(record.data?.sessionRef, SESSION_MAX);
    if (session) evidenceSession.set(record.id, session);
  }
  // Pass 3: claim -> the boundaries of the sessions its receipts came from. The slug and every record id resolve, because a
  // plan row or case step may cite either identity the claim was recorded under.
  const byClaim = new Map<string, ChainBoundary[]>();
  for (const record of records) {
    if (record.kind !== 'candidate' || !record.id) continue;
    const data = record.data as Record<string, unknown>;
    const slug = text(data.candidate, 80);
    if (!slug) continue;
    const cited = [...new Set([...strings(record.refs), ...strings(data.evidenceRefs), ...strings(data.negativeControls)])];
    const facts = cited.flatMap(id => bySession.get(evidenceSession.get(id) ?? '') ?? []);
    const boundaries = mergeBoundaries(facts, CHAIN_BOUNDARY_MAX_PER_CLAIM);
    if (!boundaries.length) continue;
    for (const ref of [slug, record.id]) byClaim.set(ref, mergeBoundaries([...(byClaim.get(ref) ?? []), ...boundaries], CHAIN_BOUNDARY_MAX_PER_CLAIM));
  }
  return { byClaim, bySession };
}
