/**
 * Technique-first routing.
 *
 * The target kind decides which capability the entry workflow may use, and the capability decides the
 * portable skill ids handed to the planner. Depth only narrows the skill list; it never widens authority,
 * and no mode word ("assessment", "pentest", …) grants exploit or post-exploitation authority.
 */
import type { EntryDepth } from '../../interface/target-entry.js';
import type { EntryTechnique } from './types.js';
import { entryFail } from './errors.js';

export interface EntryTechniqueRoute {
  /** Capability the controller executes; must be owner-granted for the matched target. */
  capability: EntryTechnique;
  /** Owner-approved action verb this capability requires on the matched target. */
  ownerAction: string;
  /** Portable skill ids, ordered by default emphasis. */
  skills: readonly string[];
}

/**
 * Local code and repositories are reviewed statically by default (`source.analyze` on a read-only
 * snapshot). HTTP(S) targets get bounded reconnaissance (`http.request`, read action only) first; nothing
 * here authorizes exploitation, mutation or post-exploitation.
 */
export const ENTRY_TECHNIQUE_ROUTES: Readonly<Record<'local-dir' | 'github-repo' | 'http-url', EntryTechniqueRoute>> = Object.freeze({
  'local-dir': Object.freeze({
    capability: 'source.analyze' as const,
    ownerAction: 'analyze',
    skills: Object.freeze([
      'source-code-auditing',
      'data-flow-analysis',
      'attack-surface-mapping',
      'compiler-invariant-auditing',
    ]),
  }),
  'github-repo': Object.freeze({
    capability: 'source.analyze' as const,
    ownerAction: 'analyze',
    skills: Object.freeze([
      'source-code-auditing',
      'data-flow-analysis',
      'attack-surface-mapping',
      'sandbox-boundary-analysis',
    ]),
  }),
  'http-url': Object.freeze({
    capability: 'http.request' as const,
    ownerAction: 'read',
    skills: Object.freeze([
      'attack-surface-mapping',
      'authorization-auditing',
    ]),
  }),
});

/** Depth narrows the skill list for the chosen technique; it never selects a different technique. */
export function skillsFor(kind: 'local-dir' | 'github-repo' | 'http-url', depth: EntryDepth): string[] {
  const route = ENTRY_TECHNIQUE_ROUTES[kind];
  const limit = depth === 'quick' ? 2 : depth === 'standard' ? 3 : route.skills.length;
  return route.skills.slice(0, Math.max(1, limit));
}

/**
 * Owner-grant check. The requested target must carry the owner action verb for the routed capability;
 * otherwise the entry workflow refuses instead of executing an action the owner did not approve.
 */
export function assertOwnerAction(route: EntryTechniqueRoute, actions: readonly string[], targetId: string): void {
  if (!actions.includes(route.ownerAction)) {
    entryFail('ENTRY_UNSUPPORTED_CAPABILITY',
      `owner target ${targetId} does not grant the ${route.ownerAction} action required by ${route.capability}; entry does not add actions`);
  }
}
