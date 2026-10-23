import { describe, expect, it } from 'vitest';
import { CAPABILITY_KINDS, capabilityKey, capabilityList, capabilityMatches, describeCapability, isTypedCapability,
  parseCapability, readCapabilities } from '../../src/capabilities.js';

// planning_update.md P14.1: the chain edge was word overlap. These tests pin the replacement: a closed vocabulary, one match
// rule, and a legacy string that stays readable while joining to nothing.
describe('capability vocabulary (P14.1)', () => {
  it('accepts only a closed kind, and a bare string becomes a legacy entry rather than a typed one', () => {
    expect(parseCapability({ kind: 'host.shell' }, 'x')).toEqual({ kind: 'host.shell' });
    expect(parseCapability({ kind: 'host.shell', subject: ' web1 ', scope: 'prod' }, 'x')).toEqual({ kind: 'host.shell', subject: 'web1', scope: 'prod' });
    expect(parseCapability('a selected object identity the caller does not own', 'x')).toEqual({ legacy: 'a selected object identity the caller does not own' });
    expect(() => parseCapability({ kind: 'anything' }, 'x')).toThrow(/kind must be one of/);
    expect(() => parseCapability({ kind: 'host.shell', extra: 1 }, 'x')).toThrow(/unknown field extra/);
    expect(() => parseCapability({ kind: 'host.shell', subject: '' }, 'x')).toThrow(/subject/);
    expect(() => parseCapability(7, 'x')).toThrow(/capability object or its pre-P14 text/);
    // The vocabulary is exactly the documented fifteen, so adding a kind is a reviewed change and not a typo.
    expect([...CAPABILITY_KINDS]).toEqual(['net.egress', 'http.request', 'auth.bypass', 'cred.session', 'cred.secret', 'file.read',
      'file.write', 'exec.code', 'db.query', 'deserialize', 'cloud.role', 'host.shell', 'dns.resolve', 'admin.ui', 'data.read']);
  });

  it('matches on kind and only compares subject/scope when both sides name one', () => {
    const need = { kind: 'cred.session' as const }, asAlice = { kind: 'cred.session' as const, subject: 'alice' };
    expect(capabilityMatches(need, asAlice)).toBe(true);          // absent on the need = any
    expect(capabilityMatches(asAlice, need)).toBe(true);          // absent on the provider = any
    expect(capabilityMatches(asAlice, asAlice)).toBe(true);
    expect(capabilityMatches(asAlice, { kind: 'cred.session', subject: 'bob' })).toBe(false);
    expect(capabilityMatches({ kind: 'cred.session', scope: 'tenant-a' }, { kind: 'cred.session', scope: 'tenant-b' })).toBe(false);
    expect(capabilityMatches({ kind: 'file.read' }, { kind: 'file.write' })).toBe(false);
    // The legacy form never matches, on either side: that is the defect this file removes.
    expect(capabilityMatches({ legacy: 'a session' }, { kind: 'cred.session' })).toBe(false);
    expect(capabilityMatches({ kind: 'cred.session' }, { legacy: 'a session' })).toBe(false);
    expect(capabilityMatches({ legacy: 'a session' }, { legacy: 'a session' })).toBe(false);
  });

  it('stores one canonical list: bounded, deduplicated and ordered, with legacy entries last', () => {
    const list = capabilityList([{ kind: 'host.shell' }, { kind: 'auth.bypass', subject: 'admin' }, 'pre-P14 text'], 'gained');
    expect(list.map(describeCapability)).toEqual(['auth.bypass (admin)', 'host.shell', 'untyped text "pre-P14 text"']);
    expect(list.map(capabilityKey)).toEqual([...list.map(capabilityKey)].sort());
    expect(isTypedCapability(list[0]!)).toBe(true);
    expect(isTypedCapability(list[2]!)).toBe(false);
    expect(() => capabilityList([], 'gained')).toThrow(/1\.\.10 capabilities/);
    expect(() => capabilityList(Array.from({ length: 11 }, () => ({ kind: 'host.shell' })), 'gained')).toThrow(/1\.\.10 capabilities/);
    expect(() => capabilityList([{ kind: 'host.shell' }, { kind: 'host.shell' }], 'gained')).toThrow(/Duplicate gained capability/);
  });

  it('reads ledger rows leniently, so one malformed entry cannot blank the chain view', () => {
    expect(readCapabilities(undefined, 'gained')).toEqual([]);
    expect(readCapabilities({ kind: 'file.read' }, 'gained')).toEqual([{ kind: 'file.read' }]);
    expect(readCapabilities([{ kind: 'nope' }, { kind: 'file.read' }, 'old text'], 'gained')).toEqual([{ kind: 'file.read' }, { legacy: 'old text' }]);
  });
});
