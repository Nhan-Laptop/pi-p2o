/**
 * P21/B1: the operator's policy baseline — the intended-policy source a run records at start so a black-box finding can cite
 * recorded policy instead of an inference (planning_update.md §6/B1, D-P21-4).
 *
 * The file is operator input, never model input: it is read once at start, bounded, hashed, and the campaign frame keeps the
 * source identity and the digest, never the body. A model sees the source label and the rule that cites it, not the text.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** The named standards the host recognizes. A standard is a vocabulary the run measures against, never a blanket permission. */
export const POLICY_STANDARDS = ['OWASP-ASVS-L2', 'OWASP-WSTG', 'OWASP-Top10'] as const;
export type PolicyStandard = typeof POLICY_STANDARDS[number];
/** The file bound: enough for a policy or a page of a standard, far below the 4 MiB ingest/report bounds. */
export const MAX_POLICY_BYTES = 256 * 1024;
export const MAX_POLICY_SOURCE_CHARS = 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PolicyArtifact {
  /** `file` for an operator-supplied artifact, `standard` for a named standard the host recognizes. */
  kind: 'file' | 'standard';
  /** The id a claim cites as `policyRef`: the absolute path for a file, the standard name for a standard. */
  id: string;
  sha256: string;
  bytes: number;
  /** Present only for `kind: 'standard'`. */
  standard?: PolicyStandard;
}

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Pure shape check for a recorded artifact; undefined for anything malformed (never throws). */
export function parsePolicyArtifact(value: unknown): PolicyArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind !== 'file' && row.kind !== 'standard') return undefined;
  if (typeof row.id !== 'string' || row.id.length > MAX_POLICY_SOURCE_CHARS || CONTROL.test(row.id)) return undefined;
  if (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) return undefined;
  if (typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_POLICY_BYTES) return undefined;
  if (row.kind === 'standard') {
    const standard = row.standard;
    if (typeof standard !== 'string' || !(POLICY_STANDARDS as readonly string[]).includes(standard) || row.id !== standard || row.bytes !== 0) return undefined;
    return { kind: 'standard', id: standard, standard: standard as PolicyStandard, sha256: row.sha256, bytes: 0 };
  }
  if (row.standard !== undefined || !isAbsolute(row.id) || row.id.length < 2) return undefined;
  return { kind: 'file', id: row.id, sha256: row.sha256, bytes: row.bytes };
}

/** Parse the token the start parser records: one absolute path, or `standard:<one of POLICY_STANDARDS>`. Throws on anything else. */
export function parsePolicyOption(value: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_POLICY_SOURCE_CHARS || CONTROL.test(value)) {
    throw new Error(`--policy needs one absolute path to the operator policy artifact, or standard:<${POLICY_STANDARDS.join('|')}>`);
  }
  if (value.startsWith('standard:')) {
    const standard = value.slice('standard:'.length);
    if (!(POLICY_STANDARDS as readonly string[]).includes(standard)) throw new Error(`--policy standard must be one of: ${POLICY_STANDARDS.map(name => `standard:${name}`).join(', ')}`);
    return value;
  }
  if (!isAbsolute(value)) throw new Error('--policy needs an absolute path to the operator policy artifact, or standard:<name>');
  return value;
}

/**
 * Host-only load: bounded regular file (lstat, so no symlink), strict UTF-8, digest of the exact bytes. A standard needs no
 * file; its digest is derived from the standard name so the record still names one stable identity.
 */
export async function loadPolicyArtifact(option: string): Promise<PolicyArtifact> {
  const value = parsePolicyOption(option);
  if (value.startsWith('standard:')) {
    const standard = value.slice('standard:'.length) as PolicyStandard;
    return { kind: 'standard', id: standard, standard, sha256: digest(`p2o-policy-standard\u0000${standard}`), bytes: 0 };
  }
  const info = await lstat(value);
  if (!info.isFile()) throw new Error('Policy file must be a regular file (symlinks are not followed)');
  if (info.size > MAX_POLICY_BYTES) throw new Error(`Policy file must be at most ${MAX_POLICY_BYTES} bytes`);
  const bytes = await readFile(value);
  if (bytes.byteLength > MAX_POLICY_BYTES) throw new Error(`Policy file must be at most ${MAX_POLICY_BYTES} bytes`);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Policy file must be UTF-8 text'); }
  return { kind: 'file', id: value, sha256: digest(bytes), bytes: bytes.byteLength };
}

/** One deterministic source label for the start preview, the report and refusals. */
export function policySourceLabel(policy: PolicyArtifact): string {
  return policy.kind === 'standard'
    ? `standard ${policy.standard} (sha256 ${policy.sha256.slice(0, 12)})`
    : `file ${policy.id} (sha256 ${policy.sha256.slice(0, 12)}, ${policy.bytes} bytes)`;
}

/** The one teaching line: what the recorded policy is and how a claim cites it. Body text never enters it. */
export function policyPromptClause(policy: PolicyArtifact): string {
  return `POLICY ${policySourceLabel(policy)}: cite a demonstrated effect that violates it as policyBasis=operator_contract with policyRef=${policy.id}`;
}
