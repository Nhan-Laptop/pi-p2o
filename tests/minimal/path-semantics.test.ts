import { describe, expect, it } from 'vitest';
import { RELATION_KINDS } from '../../src/state/graph.js';
import { GRAPH_ACTIONS, GRAPH_ACTION_PARAMETERS, graphParameters } from '../../src/state/graph-tool.js';
import { RELATION_ROLE, annotatePathEffect, effectCapability, isConditional, isTraversable, relationRole, traverseDecision } from '../../src/path-view.js';
import { CAPABILITY_KINDS } from '../../src/capabilities.js';

/**
 * R3.1/D-R1-11: one constant decides what a recorded edge means for a path. The classification is deliberately conservative —
 * a conditional edge is kept and marked (the crossing needs a demonstrated identity/input), and an informational edge is never
 * movement (similarity, provenance and source locations are reading aids). The same rule is exposed on read rows.
 */
describe('relation kinds have exactly one traversal classification (R3.1)', () => {
  it('classifies each of the relation kinds once and nothing else', () => {
    expect(Object.keys(RELATION_ROLE).sort()).toEqual([...RELATION_KINDS].sort());
    expect(Object.values(RELATION_ROLE).every(role => ['traversable', 'conditional', 'informational'].includes(role))).toBe(true);
    expect(new Set(Object.values(RELATION_ROLE))).toEqual(new Set(['traversable', 'conditional', 'informational']));
  });

  it('pins the classification so a later edge rename cannot silently change reachability', () => {
    // The exact map is the contract: traversable structure, conditional crossings, informational reading aids.
    expect(RELATION_ROLE).toEqual({
      contains: 'traversable', resolves_to: 'traversable', exposes: 'traversable', implemented_by: 'traversable', alias_of: 'traversable',
      reads: 'traversable', writes: 'traversable', owns: 'traversable', hosts: 'traversable',
      consumes: 'conditional', authenticates_as: 'conditional', authenticates: 'conditional', depends_on: 'conditional',
      variant_of: 'informational', anchors: 'informational', derived_from: 'informational',
    });
  });

  it('maps queries by the same rule: conditional is traversable, informational is not, unknown is informational', () => {
    expect(relationRole('exposes')).toBe('traversable'); expect(isTraversable('exposes')).toBe(true); expect(isConditional('exposes')).toBe(false);
    expect(relationRole('authenticates_as')).toBe('conditional'); expect(isTraversable('authenticates_as')).toBe(true); expect(isConditional('authenticates_as')).toBe(true);
    expect(relationRole('variant_of')).toBe('informational'); expect(isTraversable('variant_of')).toBe(false); expect(isConditional('variant_of')).toBe(false);
    expect(relationRole('not-a-kind')).toBe('informational'); expect(isTraversable('not-a-kind')).toBe(false);
    expect(traverseDecision('reads')).toEqual({ traversable: true, conditional: false });
    expect(traverseDecision('anchors')).toEqual({ traversable: false, conditional: false });
  });
});

describe('the path action is a bounded root read (R3.2)', () => {
  it('declares the action and its parameters without changing the root-closed shape', () => {
    expect(GRAPH_ACTIONS).toContain('path');
    expect(GRAPH_ACTION_PARAMETERS.path).toEqual(['action', 'fromId', 'toId', 'toKind', 'effect', 'maxDepth', 'maxNodes', 'kinds']);
    const properties = (graphParameters as unknown as { properties: Record<string, unknown> }).properties;
    for (const field of ['fromId', 'toId', 'toKind', 'effect', 'maxDepth', 'maxNodes', 'kinds']) expect(properties[field], field).toBeDefined();
    expect(graphParameters).toMatchObject({ additionalProperties: false });
  });
});

describe('an effect annotation only accepts a typed capability (R3.3)', () => {
  it('validates the effect against the one capability vocabulary', () => {
    for (const kind of CAPABILITY_KINDS) expect(effectCapability(kind)).toEqual({ kind });
    expect(effectCapability('data.Read')).toBeUndefined();
    expect(effectCapability('admin')).toBeUndefined();
  });

  it('is supplied by a demonstrated claim whose host-stamped assets touch the hop, and never by an untested one', () => {
    const hops = [[{ relationEntityId: 'relation-a', fromId: 'asset-a', toId: 'asset-b' }]];
    const demonstrated = { claimId: 'claim-a', claim: { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'host.shell' }], assetRefs: [{ id: 'asset-b' }] } };
    expect(annotatePathEffect(hops, [demonstrated], 'host.shell')).toMatchObject({ kind: 'host.shell', supplied: true,
      satisfiedBy: { pathIndex: 0, hopIndex: 0, relationEntityId: 'relation-a', claimId: 'claim-a' } });
    // Same claim, not demonstrated: it can never supply the effect.
    const untested = { claimId: 'claim-a', claim: { ...demonstrated.claim, execution: 'not_tested' } };
    expect(annotatePathEffect(hops, [untested], 'host.shell')).toMatchObject({ kind: 'host.shell', supplied: false,
      missingHop: { pathIndex: 0, hopIndex: 0, relationEntityId: 'relation-a' } });
    // A capability the claim does not gain is missing even when it is demonstrated.
    expect(annotatePathEffect(hops, [demonstrated], 'data.read')).toMatchObject({ supplied: false });
  });

  it('refuses an unknown effect and reports the last hop when nothing supplies it', () => {
    const hops = [[{ relationEntityId: 'relation-a', fromId: 'asset-a', toId: 'asset-b' }, { relationEntityId: 'relation-b', fromId: 'asset-b', toId: 'asset-c' }]];
    expect(() => annotatePathEffect(hops, [], 'admin')).toThrow('Unknown path effect');
    expect(annotatePathEffect(hops, [], 'db.query').missingHop).toMatchObject({ pathIndex: 0, hopIndex: 1, relationEntityId: 'relation-b' });
  });
});
