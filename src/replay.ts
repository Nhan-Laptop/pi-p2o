/**
 * planning_update.md P21/A1: the replay unit the host records.
 *
 * A receipt is a bounded redacted excerpt, so it cannot be re-run. P14.2 made the replayable unit a model-stored artifact, and a
 * run showed why that does not work: 13/13 claims were "not replayable" because nothing made the model store one. The unit is a
 * host fact — the request or command the executor actually admitted — so the host captures it at the one dispatch seam, before
 * substitution, and stamps the receipt with the reference and hash. The bytes stay in the run's private payload directory
 * (0600, never exported, removed with the run, the P14.2 contract); the ledger keeps only the reference and hash.
 *
 * A unit the payload store refuses (larger than the payload bound, or containing characters that would make the stored bytes a
 * different program) is recorded as a visible gap (`captured:false` with a reason): a silent zero is exactly what this tranche
 * exists to remove.
 */
import { sha256Hex } from './validate.js';
import { PAYLOAD_BYTES, PayloadStore, type PayloadKind } from './lab.js';

/** The environment identity a replay has to happen in: same runtime, same executor profile. Bumped when the shape changes. */
export const REPLAY_ENVIRONMENT_VERSION = 1;

/** What a receipt records about the admitted replay unit. Never the bytes; the ledger keeps only the reference and hash. */
export interface ReplayStamp {
  captured: boolean;
  /** Present only when `captured` is true: the run-private payload holding the exact admitted unit. */
  payloadRef?: string;
  sha256?: string;
  bytes?: number;
  kind?: PayloadKind;
  /** sha256 of the host runtime identity the unit was admitted in; a replay in another image/executor profile does not match. */
  environmentFingerprint: string;
  /** Why the unit was not stored; present only when `captured` is false. */
  reason?: string;
}

export interface ReplayIdentity { runtime: string; extensionSha: string; image: string; executorMode: string }
export interface ReplayRequest { method: string; url: string; headers?: Record<string, string>; body?: string }
export interface ReplayUnit { kind: PayloadKind; name: string; body: string }

/**
 * A network claim needs no docker-compose recipe: the environment that matters is the host runtime identity, so the fingerprint
 * is derived from it. `p2o_lab action=env` stays for service/seed setups, and a claim that names one keeps that environment.
 */
export function replayEnvironmentFingerprint(identity: ReplayIdentity): string {
  return sha256Hex(JSON.stringify({ version: REPLAY_ENVIRONMENT_VERSION, runtime: identity.runtime || 'unknown',
    extensionSha: identity.extensionSha, image: identity.image, executorMode: identity.executorMode }));
}

const NAME_BYTES = 120;
/** The payload store's own bound for a readable name; the first line is enough to recognise the unit. */
function boundedName(value: string): string {
  let name = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() || 'replay unit';
  while (Buffer.byteLength(name) > NAME_BYTES && name.length > 1) name = name.slice(0, Math.floor(name.length * 0.75));
  return name;
}

/**
 * Canonical JSON, headers sorted, so two equivalent requests described in a different key order hash the same. The body is the
 * pre-substitution text: an operator-secret placeholder stays a placeholder, so the stored unit never holds a value (D-P21-5).
 */
export function replayRequestUnit(request: ReplayRequest): ReplayUnit {
  const headers = request.headers
    ? Object.fromEntries(Object.entries(request.headers).sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase())))
    : undefined;
  return { kind: 'request', name: boundedName(`http ${request.method} ${request.url}`),
    body: JSON.stringify({ version: 1, method: request.method, url: request.url, ...(headers ? { headers } : {}), ...(request.body === undefined ? {} : { body: request.body }) }) };
}

/** A shell or network command is its own replay unit; the admitted text is stored verbatim, placeholders intact. */
export function replayCommandUnit(operation: string, command: string): ReplayUnit {
  return { kind: 'command', name: boundedName(`${operation}: ${command.split('\n')[0]}`), body: command };
}

/**
 * Best effort by design: a capture problem is a recorded gap, never a failed target operation. The receipt still says what the
 * executor was asked to do; a second worker can only replay it when the reference is there.
 */
export async function storeReplayUnit(storePath: string, by: string, unit: ReplayUnit, environmentFingerprint: string): Promise<ReplayStamp> {
  const bytes = Buffer.byteLength(unit.body);
  if (bytes > PAYLOAD_BYTES)
    return { captured: false, bytes, kind: unit.kind, environmentFingerprint, reason: `replay unit is ${bytes} bytes; the payload bound is ${PAYLOAD_BYTES} bytes` };
  try {
    const ref = await new PayloadStore(storePath).put(by, unit);
    return { captured: true, payloadRef: ref.id, sha256: ref.sha256, bytes: ref.bytes, kind: ref.kind, environmentFingerprint };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { captured: false, bytes, kind: unit.kind, environmentFingerprint, reason: `replay unit was not stored: ${detail.slice(0, 200)}` };
  }
}
