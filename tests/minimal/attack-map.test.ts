import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACK_SOURCE, ATTACK_TACTICS, ATTACK_TECHNIQUES, ATTACK_VERSION, WSTG_ATTACK, attackForWstg, attackTechniques, isAttackTechnique } from '../../src/attack-map.js';
import { WSTG_MAP, isWstgKey, wstgKey } from '../../src/wstg-map.js';

/**
 * R3.4 (plan): the ATT&CK crosswalk is data plus three pure helpers. No new state, field or tool: techniques are derived from the
 * WSTG keys that cases and coverage cells already carry. This guard keeps the catalogue, the WSTG crosswalk, the document that
 * shows it and the library's own test list from drifting apart. It checks consistency only; whether each mapping is the right
 * judgement is reviewed by the owner, and no mapping is evidence that p2o can detect the technique.
 */
const root = resolve(import.meta.dirname, '../..');
const inScope = WSTG_MAP.filter(test => test.support !== 'O');

describe('ATT&CK catalogue', () => {
  it('pins the source and a release, and carries a curated 40 to 60 techniques', () => {
    expect(ATTACK_SOURCE).toBe('https://attack.mitre.org/');
    expect(ATTACK_VERSION).toMatch(/^v\d+(?:\.\d+)?$/);
    expect(ATTACK_TECHNIQUES.length).toBeGreaterThanOrEqual(40);
    expect(ATTACK_TECHNIQUES.length).toBeLessThanOrEqual(60);
  });

  it('lists the 14 Enterprise tactics in kill-chain order', () => {
    expect(ATTACK_TACTICS).toEqual([
      'reconnaissance', 'resource-development', 'initial-access', 'execution', 'persistence', 'privilege-escalation',
      'defense-evasion', 'credential-access', 'discovery', 'lateral-movement', 'collection', 'command-and-control',
      'exfiltration', 'impact',
    ]);
  });

  it('uses unique technique ids, known tactics, non-empty names and canonical urls', () => {
    const ids = ATTACK_TECHNIQUES.map(technique => technique.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tactics = new Set<string>(ATTACK_TACTICS);
    for (const technique of ATTACK_TECHNIQUES) {
      expect(technique.id, technique.id).toMatch(/^T\d{4}(?:\.\d{3})?$/);
      expect(tactics.has(technique.tactic), `${technique.id} uses ${technique.tactic}`).toBe(true);
      expect(technique.name.trim().length, technique.id).toBeGreaterThan(0);
      // ATT&CK prints a sub-technique as /T1021/001/, so the url ends with the path form of the id, not the dotted key.
      expect(technique.url, technique.id).toBe(`https://attack.mitre.org/techniques/${technique.id.split('.').join('/')}/`);
      expect(technique.url.startsWith('https://')).toBe(true);
    }
  });

  it('resolves ids deterministically: deduped, tactic order then id, unknown ids ignored', () => {
    expect(isAttackTechnique('T1190')).toBe(true); expect(isAttackTechnique('T1078.004')).toBe(true);
    expect(isAttackTechnique('T9999')).toBe(false); expect(isAttackTechnique('t1190')).toBe(false);
    const ids = ['T1021.001', 'T1190', 'T1595', 'T1190', 'T9999'], first = attackTechniques(ids);
    expect(first.map(technique => technique.id)).toEqual(['T1595', 'T1190', 'T1021.001']);
    expect(attackTechniques([...ids].reverse())).toEqual(first);
  });
});

describe('WSTG to ATT&CK crosswalk', () => {
  it('maps in-scope tests only, each to 1 to 3 techniques that exist in the catalogue', () => {
    const byKey = new Map(WSTG_MAP.map(test => [wstgKey(test.id), test]));
    const techniqueIds = new Set(ATTACK_TECHNIQUES.map(technique => technique.id));
    for (const [key, techniques] of Object.entries(WSTG_ATTACK)) {
      expect(isWstgKey(key), key).toBe(true);
      const test = byKey.get(key);
      expect(test, `${key} is not a WSTG test`).toBeDefined();
      expect(test!.support, `${key} is out of scope`).not.toBe('O');
      expect(techniques.length, key).toBeGreaterThanOrEqual(1);
      expect(techniques.length, key).toBeLessThanOrEqual(3);
      expect(new Set(techniques).size, `${key} repeats a technique`).toBe(techniques.length);
      for (const id of techniques) expect(techniqueIds.has(id), `${key} names unknown ${id}`).toBe(true);
    }
    expect(inScope).toHaveLength(104);
    expect(Object.keys(WSTG_ATTACK)).toHaveLength(inScope.length);
  });

  it('covers every in-scope test and leaves the out-of-scope tests unmapped', () => {
    expect(Object.keys(WSTG_ATTACK).sort()).toEqual(inScope.map(test => wstgKey(test.id)).sort());
    for (const test of WSTG_MAP.filter(item => item.support === 'O')) expect(WSTG_ATTACK[wstgKey(test.id)], test.id).toBeUndefined();
  });

  it('resolves WSTG keys deterministically, deduped, and ignores unknown keys', () => {
    const keys = ['wstg-athz-04', 'wstg-injt-05', 'wstg-athz-04', 'wstg-unknown-99', 'WSTG-ATHZ-04'];
    const first = attackForWstg(keys), expected = attackTechniques(keys.flatMap(key => WSTG_ATTACK[key] ?? []));
    expect(first).toEqual(expected);
    expect(first.map(technique => technique.id)).toEqual(attackForWstg([...keys].reverse()).map(technique => technique.id));
    expect(new Set(first.map(technique => technique.id)).size).toBe(first.length);
    expect(attackForWstg(['wstg-unknown-99'])).toEqual([]);
    expect(attackForWstg([])).toEqual([]);
  });
});

describe('docs/ATTACK_MAP.md', () => {
  const read = () => readFile(join(root, 'docs/ATTACK_MAP.md'), 'utf8');

  it('quotes the source, the pinned release, the access date and the counts of the data', async () => {
    const doc = await read();
    expect(doc).toContain(ATTACK_SOURCE);
    expect(doc).toContain(ATTACK_VERSION);
    expect(doc).toContain('2026-10-28');
    expect(doc).toContain(`${ATTACK_TECHNIQUES.length} kỹ thuật`);
    expect(doc).toContain(`${inScope.length} test`);
    const used = new Set(Object.values(WSTG_ATTACK).flat());
    expect(doc).toContain(`${ATTACK_TECHNIQUES.filter(technique => !used.has(technique.id)).length} kỹ thuật`);
  });

  it('shows exactly the crosswalk rows of the data, in WSTG_MAP order', async () => {
    const doc = await read();
    const rows = inScope.map(test => {
      const key = wstgKey(test.id);
      return `| ${key} | ${WSTG_ATTACK[key].join(', ')} |`;
    });
    expect(doc.split('\n').filter(line => line.startsWith('| wstg-')), 'regenerate the table from src/attack-map.ts').toEqual(rows);
  });
});
