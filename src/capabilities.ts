import type { Target } from './target.js';

export const CAPABILITY_IDS = ['source.snapshot', 'source.history', 'shell.offline', 'work.scratch',
  'http.same-origin.get', 'http.same-origin.head', 'http.authenticated', 'http.body', 'browser.execution',
  'lab.local-http', 'oast.callback', 'requests.parallel', 'tool.python', 'tool.semgrep'] as const;
export type CapabilityId = typeof CAPABILITY_IDS[number];
export interface Capability {
  id: CapabilityId; permitted: boolean; applicable: boolean;
  availability: 'supported' | 'unavailable' | 'unknown'; reason: string; evidence?: string;
}
export interface Requirements { allOf?: CapabilityId[]; anyOf?: CapabilityId[] }
export interface Workflow extends Requirements { id: string; description: string }
export interface CapabilitySnapshot { version: 1; targetKind: Target['kind']; capabilities: Capability[]; limits: Record<string, number> }

/** Policy is computed by the owner. Unknown tools require a real bounded probe, not a version assumption. */
export function capabilities(target: Pick<Target, 'kind'>): CapabilitySnapshot {
  const source = target.kind === 'directory';
  const supported = new Set<CapabilityId>(['shell.offline', 'work.scratch', ...(source
    ? ['source.snapshot' as const] : ['http.same-origin.get' as const, 'http.same-origin.head' as const])]);
  return { version: 1, targetKind: target.kind, limits: { shellSeconds: 60, outputBytes: 49152, httpBytes: 1048576, httpSeconds: 20 },
    capabilities: CAPABILITY_IDS.map(id => {
      const tool = id.startsWith('tool.');
      const applicable = id.startsWith('source.') ? source : id.startsWith('http.') ? !source : true;
      return { id, permitted: supported.has(id) || tool, applicable,
        availability: supported.has(id) ? 'supported' : tool ? 'unknown' : 'unavailable',
        reason: supported.has(id) ? 'Owner-enforced assessment transport' : tool ? 'Needs a bounded offline execution with its dependencies/rules; no probe yet'
          : id === 'source.history' ? 'Source snapshots omit .git' : id === 'browser.execution'
            ? 'No managed browser transport. Offline shell binaries are a separate unprobed facility; local parser/browser experiments establish offline, not live target reproduction.'
            : 'Not provided by this assessment transport' };
    }) };
}
export function validateRequirements(value: Requirements): void {
  for (const key of ['allOf', 'anyOf'] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key]!.some(id => !(CAPABILITY_IDS as readonly string[]).includes(id)))) {
      throw new Error(`Unknown capability requirement in ${key}`);
    }
  }
}
export function missingRequirements(requirements: Requirements, snapshot: CapabilitySnapshot): string[] {
  validateRequirements(requirements);
  const has = (id: string) => snapshot.capabilities.some(c => c.id === id && c.permitted && c.applicable && c.availability === 'supported');
  const missing = (requirements.allOf ?? []).filter(id => !has(id));
  return [...missing, ...(requirements.anyOf?.length && !requirements.anyOf.some(has) ? [`one of: ${requirements.anyOf.join(', ')}`] : [])];
}
export function capabilityInstructions(target: Pick<Target, 'kind'>, snapshot = capabilities(target)): string {
  return `CAPABILITIES (policy, availability and applicability are separate):\n${snapshot.capabilities.map(c =>
    `${c.id}: permitted=${c.permitted}, applicable=${c.applicable}, ${c.availability} (${c.reason})`).join('\n')}\nUse p2o_capabilities for the current owner snapshot. Missing dynamic capability does not prevent source analysis; record selected blocked workflows, never call them tested/clean.`;
}
