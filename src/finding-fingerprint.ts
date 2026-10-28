import { sha256Hex } from './validate.js';

/**
 * R3.6: a finding keeps one identity across runs, so a later run can recognize a finding a remediation already answered instead of
 * re-rating it as new. The identity is derived by the host from the finding's scope, policy, root cause and asset identity — never
 * authored by the model, never random, never the case id (which is per-run). It is a lookup key, not evidence: two findings with the
 * same id are "the same weakness in the same place" as the recorded inputs claim, which is exactly as trustworthy as those inputs.
 *
 * An asset contributes `kind:key` (the extractor-normalized identity from the graph), never its per-run record id. The case id, the
 * revision, severity and evidence stay out of the digest on purpose: a re-rated or re-reproduced finding is the same finding.
 */
export interface FindingIdentityInput {
  /** The authorized target (and tenant when the run recorded one): the scope the finding points at, never the run id. */
  scope: string;
  policyKey: string;
  rootCauseKey?: string;
  assets: ReadonlyArray<{ kind: string; key: string }>;
}

/** Finding ids are 32 lower-case hex characters (sha256 prefix); the full digest is not printed, so the id never doubles as proof. */
export const FINDING_ID_PATTERN = /^[a-f0-9]{32}$/;
const FINGERPRINT_DOMAIN = 'p2o-finding-id/v1';

const clean = (value: unknown): string => String(value ?? '').trim().normalize('NFC');

/**
 * The scope part of a finding identity: the authorized target, plus the tenant id when the run recorded one. Lower-cased because a
 * host name is case-insensitive, so `HCMUSSH.edu.vn` and `hcmussh.edu.vn` are one scope, not two findings.
 */
export function findingScope(target: string, tenant?: string): string {
  const scope = clean(target).toLowerCase(), tenantId = clean(tenant ?? '').toLowerCase();
  if (!scope) throw Error('A finding identity needs the authorized target it was recorded against');
  return tenantId ? `${tenantId}\u0001${scope}` : scope;
}

/**
 * Stable, host-derived finding id. Deterministic for the same inputs: asset order and duplicates do not matter, an empty root cause
 * is distinct from a recorded one, and every part is domain-separated so concatenation cannot collide.
 */
export function findingId(input: FindingIdentityInput): string {
  const scope = clean(input.scope), policyKey = clean(input.policyKey), rootCauseKey = clean(input.rootCauseKey ?? '');
  if (!scope || !policyKey) throw Error('A finding identity needs a non-empty scope and policy key');
  const assets = [...new Set((input.assets ?? []).map(asset => `${clean(asset.kind)}\u0002${clean(asset.key)}`))]
    .filter(identity => identity !== '\u0002' && !identity.startsWith('\u0002') && !identity.endsWith('\u0002'))
    .sort();
  return sha256Hex([FINGERPRINT_DOMAIN, scope, policyKey, rootCauseKey, ...assets].join('\u0000')).slice(0, 32);
}
