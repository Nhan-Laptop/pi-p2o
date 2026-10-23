/**
 * planning_update.md P14.1: a chain edge used to be a shared word.
 *
 * `Candidate.provides`/`requires` were free text and `chainJoin` matched them by token overlap, so "a selected object identity
 * the caller does not own" linked to any claim that mentioned "object" and to nothing else. The vocabulary below is closed, the
 * match lives in one function, and a record written before this change stays readable: it is carried with its original text and
 * marked legacy, and it matches nothing at all, because text overlap is the defect this file removes.
 */

export const CAPABILITY_KINDS = [
  'net.egress', 'http.request', 'auth.bypass', 'cred.session', 'cred.secret', 'file.read', 'file.write', 'exec.code',
  'db.query', 'deserialize', 'cloud.role', 'host.shell', 'dns.resolve', 'admin.ui', 'data.read',
] as const;
export type CapabilityKind = typeof CAPABILITY_KINDS[number];

/** What the run joins on: `subject` is what the capability applies to, `scope` the boundary it holds inside. */
export interface TypedCapability { kind: CapabilityKind; subject?: string; scope?: string }
/** A pre-P14 `provides`/`requires` string. It is displayed with its original text and never matched as if it were typed. */
export interface LegacyCapability { legacy: string }
export type Capability = TypedCapability | LegacyCapability;

export const isTypedCapability = (capability: Capability): capability is TypedCapability => 'kind' in capability;

const SUBJECT_BYTES = 80;
const SCOPE_BYTES = 40;
const LEGACY_BYTES = 300;
const MAX_CAPABILITIES = 10;
const KINDS: ReadonlySet<string> = new Set(CAPABILITY_KINDS);

/**
 * The one match rule. Same kind, and a subject or scope only has to agree when both sides name one — an absent field means
 * "any", which is what lets one claim hand out "a session" and another ask for "a session as alice". A legacy entry never
 * matches, on either side.
 */
export function capabilityMatches(need: Capability, have: Capability): boolean {
  if (!isTypedCapability(need) || !isTypedCapability(have)) return false;
  if (need.kind !== have.kind) return false;
  if (need.subject !== undefined && have.subject !== undefined && need.subject !== have.subject) return false;
  if (need.scope !== undefined && have.scope !== undefined && need.scope !== have.scope) return false;
  return true;
}

/** Canonical identity: dedup, ordering, and the text a gap prints. Order is total so two runs sort the same list the same way. */
export function capabilityKey(capability: Capability): string {
  return isTypedCapability(capability)
    ? `${capability.kind}\u0000${capability.subject ?? ''}\u0000${capability.scope ?? ''}`
    : `\ufffflegacy\u0000${capability.legacy}`;
}

/** Human form for prompts, reports and gap lines. `\uffff` in the key above keeps legacy entries last in every listing. */
export function describeCapability(capability: Capability): string {
  if (!isTypedCapability(capability)) return `untyped text "${capability.legacy}"`;
  const detail = [capability.subject, capability.scope].filter((part): part is string => part !== undefined);
  return detail.length ? `${capability.kind} (${detail.join(' @ ')})` : capability.kind;
}

const bounded = (value: unknown, label: string, max: number, min = 1): string => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw Error(`${label} must be ${min}..${max} characters`);
  return value.trim();
};

/**
 * Strict parse for the write path. A bare string is accepted as a legacy entry so an old client still writes something readable, and the stored form of
 * that entry (`{legacy}`) parses back into itself, so a record written before P14 can be re-validated without being upgraded into something it was not.
 */
export function parseCapability(value: unknown, label: string): Capability {
  if (typeof value === 'string') return { legacy: bounded(value, `${label} legacy text`, LEGACY_BYTES, 5) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be a capability object or its pre-P14 text`);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length === 1 && row.legacy !== undefined) return { legacy: bounded(row.legacy, `${label} legacy text`, LEGACY_BYTES, 5) };
  for (const key of Object.keys(row)) if (!['kind', 'subject', 'scope'].includes(key)) throw Error(`${label} has unknown field ${key}`);
  if (typeof row.kind !== 'string' || !KINDS.has(row.kind)) throw Error(`${label} kind must be one of ${CAPABILITY_KINDS.join(', ')}`);
  const capability: TypedCapability = { kind: row.kind as CapabilityKind };
  if (row.subject !== undefined) capability.subject = bounded(row.subject, `${label} subject`, SUBJECT_BYTES);
  if (row.scope !== undefined) capability.scope = bounded(row.scope, `${label} scope`, SCOPE_BYTES);
  return capability;
}

/** Strict list for a write: 1..10 entries, canonical order, no duplicate identity — the same stored form whoever writes it. */
export function capabilityList(value: unknown, label: string): Capability[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CAPABILITIES) throw Error(`${label} needs 1..${MAX_CAPABILITIES} capabilities`);
  const capabilities = value.map((entry, index) => parseCapability(entry, `${label} ${index + 1}`));
  const keys = capabilities.map(capabilityKey);
  if (new Set(keys).size !== keys.length) throw Error(`Duplicate ${label} capability`);
  return capabilities.sort((left, right) => capabilityKey(left).localeCompare(capabilityKey(right)));
}

/**
 * Lenient read for rows that arrive as untyped ledger JSON: one malformed entry is dropped rather than blanking the chain view
 * for the whole run. It is never rewritten — the ledger is append-only, and a bad entry is a record of what was written.
 */
export function readCapabilities(value: unknown, label: string): Capability[] {
  if (value === undefined || value === null) return [];
  const rows = Array.isArray(value) ? value : [value];
  const capabilities: Capability[] = [];
  for (const row of rows.slice(0, MAX_CAPABILITIES)) {
    try { capabilities.push(parseCapability(row, label)); } catch { /* dropped: see the doc comment, not a silent repair */ }
  }
  return capabilities;
}
