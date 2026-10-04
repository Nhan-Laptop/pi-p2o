import type { Action, Capability } from '../../policy/types.js';

export const PACKS = {
  static: { description: 'Read and statically analyze approved source; never import repository JS.', capabilities: ['source.analyze'], actions: ['read', 'analyze'], acknowledgement: 'static-read-no-repository-code' },
  browser: { description: 'Pinned Chrome on the HOST, not container isolation. Scope-gated CDP/egress; no host profiles.', capabilities: ['browser.session', 'browser.act'], actions: ['read', 'mutate'], acknowledgement: 'host-browser-not-container-isolated' },
  proxy: { description: 'HOST loopback capture/repeat; passthrough, no TLS MITM or trust-store changes. Policy-scope egress requires host-browser qualification.', capabilities: ['proxy.session', 'proxy.history'], actions: ['read', 'mutate'], acknowledgement: 'host-browser-not-container-isolated' },
  differential: { description: 'PRIVILEGED controller imports ONLY trusted owner-supplied modules. No hostile-code isolation; never select for untrusted repository JS.', capabilities: ['fuzz.differential'], actions: ['analyze'], acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' },
  template: { description: 'Bounded declared HTTP mutations via existing policy/budget gates; no arbitrary code or external fuzz engines.', capabilities: ['fuzz.template'], actions: ['read', 'mutate'], acknowledgement: 'bounded-policy-http-no-arbitrary-code' },
} as const satisfies Record<string, { description: string; capabilities: readonly Capability[]; actions: readonly Action[]; acknowledgement: string }>;
export type PackId = keyof typeof PACKS;
export interface PackSelection {
  packs: PackId[];
  actions: Action[];
  maxRequests: number;
  maxCalls: number;
  deadlineMs: number;
  /** Digest of operator-reviewed, pinned boundary settings, not a repository-provided path. */
  configurationDigest: string;
}
export function validateSelection(value: PackSelection): PackSelection {
  if (!value || Object.keys(value).sort().join('|') !== ['packs', 'actions', 'maxRequests', 'maxCalls', 'deadlineMs', 'configurationDigest'].sort().join('|') ||
    !Array.isArray(value.packs) || !value.packs.length || value.packs.some(p => !Object.hasOwn(PACKS, p)) || new Set(value.packs).size !== value.packs.length ||
    !Array.isArray(value.actions) || !value.actions.length || new Set(value.actions).size !== value.actions.length ||
    value.actions.some(a => !value.packs.some(p => (PACKS[p].actions as readonly string[]).includes(a))) ||
    !/^[a-f0-9]{64}$/.test(value.configurationDigest) ||
    ![value.maxRequests, value.maxCalls, value.deadlineMs].every(n => Number.isSafeInteger(n) && n > 0) || value.maxRequests > 1_000_000 || value.maxCalls > 1_000_000) throw new Error('PACK_SELECTION_INVALID');
  return structuredClone(value);
}
export function capabilitiesFor(selection: PackSelection): Capability[] {
  return [...new Set(selection.packs.flatMap(p => [...PACKS[p].capabilities]))];
}
