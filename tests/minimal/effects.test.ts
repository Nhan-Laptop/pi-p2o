import { describe, expect, it } from 'vitest';
import { derivedEffect, derivedEffects } from '../../src/effects.js';
import { CAPABILITY_KINDS } from '../../src/capabilities.js';

/** P22/A4: the derived effect suggestion is an explicit, incomplete table — never a rating and never a readiness input. */
describe('derived capability → effect suggestion (P22/A4)', () => {
  it('pins every capability kind: four effect mappings are explicit and the rest deliberately suggest nothing', () => {
    const expected: Record<string, string | undefined> = {
      'data.read': 'confidentiality-read', 'db.query': 'confidentiality-read', 'file.read': 'confidentiality-read',
      'file.write': 'integrity-write',
      'exec.code': 'code-execution', 'host.shell': 'code-execution', 'deserialize': 'code-execution',
      'auth.bypass': 'authentication-bypass',
      // Possession of a session or a secret is a means, not a demonstrated bypass; transport and identity context say how a
      // request travels or where from, not what establishing it would let the run do.
      'cred.session': undefined, 'cred.secret': undefined,
      'net.egress': undefined, 'http.request': undefined, 'dns.resolve': undefined, 'cloud.role': undefined, 'admin.ui': undefined,
    };
    // The table is complete over the closed kind list, so a new CapabilityKind cannot be added without deciding here.
    expect(Object.keys(expected).sort()).toEqual([...CAPABILITY_KINDS].sort());
    for (const kind of CAPABILITY_KINDS) expect(derivedEffect({ kind }), kind).toBe(expected[kind]);
  });

  it('dedupes suggestions in canonical effect order and never joins pre-P14 prose', () => {
    expect(derivedEffects([{ kind: 'file.write' }, { kind: 'data.read' }, { kind: 'exec.code' }, { kind: 'db.query' }]))
      .toEqual(['confidentiality-read', 'integrity-write', 'code-execution']);
    expect(derivedEffects([{ kind: 'host.shell' }, { kind: 'auth.bypass' }])).toEqual(['authentication-bypass', 'code-execution']);
    expect(derivedEffects([{ legacy: 'a selected object identity the caller does not own' }])).toEqual([]);
    expect(derivedEffects([])).toEqual([]);
  });
});
