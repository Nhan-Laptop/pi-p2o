/**
 * planning_update.md P22/A4: a typed capability suggests the effect class a chain link is after, and the suggestion is not a rating.
 *
 * A plan link carries one typed field — the capabilities it consumes (`needs`) — so that is what this table reads. The mapping is
 * deliberately incomplete: possession of a session or a secret is not a demonstrated bypass, and a transport capability says how a
 * request travels rather than what establishing it would let the run do. Every kind is written out, including the ones that map to
 * nothing, so a new `CapabilityKind` cannot be added without deciding here; "no answer" is a decision, not an omission.
 *
 * The label is printed beside a link as "derived suggestion, not a rating". It is never read by `src/ladder.ts`, a case rating or
 * `src/goal-proof.ts`: only an executed case chain step establishes an effect (D-P22-5).
 */
import { CASE_EFFECTS, type CaseEffect } from './cvss.js';
import { isTypedCapability, type Capability, type CapabilityKind } from './capabilities.js';

const DERIVED_EFFECTS: Readonly<Record<CapabilityKind, CaseEffect | undefined>> = {
  // How a request travels, or where the run can reach it: no effect is established by having the path.
  'net.egress': undefined,
  'http.request': undefined,
  'dns.resolve': undefined,
  // A session or a secret is a means, not the effect: only a later link that consumes it can establish one.
  'cred.session': undefined,
  'cred.secret': undefined,
  // Administrative and cloud identity are privilege context; the table does not guess the effect they would reach.
  'cloud.role': undefined,
  'admin.ui': undefined,
  // The incomplete part of the table: a read, a write, execution, and a bypass are the effects a link can be after.
  'auth.bypass': 'authentication-bypass',
  'file.read': 'confidentiality-read',
  'file.write': 'integrity-write',
  'exec.code': 'code-execution',
  'db.query': 'confidentiality-read',
  'deserialize': 'code-execution',
  'host.shell': 'code-execution',
  'data.read': 'confidentiality-read',
};

/** The effect class a link that consumes this capability would establish; nothing when the table deliberately has no answer. */
export function derivedEffect(capability: Capability): CaseEffect | undefined {
  return isTypedCapability(capability) ? DERIVED_EFFECTS[capability.kind] : undefined;
}

/** Every distinct suggestion for a link's typed needs, in the canonical effect order; a pre-P14 prose entry suggests nothing. */
export function derivedEffects(needs: readonly Capability[]): CaseEffect[] {
  const suggested = new Set<CaseEffect>();
  for (const need of needs) {
    const effect = derivedEffect(need);
    if (effect) suggested.add(effect);
  }
  return CASE_EFFECTS.filter(effect => suggested.has(effect));
}
