import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCoverageCellDraft } from '../../src/coverage-types.js';
import { SkillLibrary } from '../../src/skills.js';
import { fieldValidators } from '../../src/validate.js';
import { WSTG_BY_KEY, WSTG_COMMIT, WSTG_MAP, isWstgKey, wstgEvidence, wstgKey, wstgTableRows, type WstgCell, type WstgCase, type WstgEvidence } from '../../src/wstg-map.js';

/**
 * S4 (plan): the OWASP WSTG map is data plus two pure helpers. No new state, field or tool: a test is addressed by its lower-case ID in the existing
 * questionKey. This guard keeps the data, the document that shows it and the skills it names from drifting apart. It checks consistency only; whether
 * the support level of each test is right is a design inference that the owner reviews (planning_update.md, Q6).
 */
const root = resolve(import.meta.dirname, '../..');

describe('WSTG map data', () => {
  it('lists 108 unique tests whose keys are valid questionKey values', () => {
    expect(WSTG_MAP).toHaveLength(108);
    expect(new Set(WSTG_MAP.map(test => test.id)).size).toBe(108); expect(WSTG_BY_KEY.size).toBe(108);
    const { key } = fieldValidators('wstg');
    for (const test of WSTG_MAP) {
      expect(test.id, test.id).toMatch(/^WSTG-[A-Z]{4}-\d{2}$/);
      expect(() => key(wstgKey(test.id), 'question key'), test.id).not.toThrow();
      expect(isWstgKey(wstgKey(test.id)), test.id).toBe(true);
    }
    expect(() => key('WSTG-ATHZ-04', 'question key')).toThrow(); // the upper-case form would be rejected, which is why the key is lower-cased
  });

  it('keeps support levels consistent with the skills they name, and every named skill exists in the catalog', async () => {
    const names = new Set((await new SkillLibrary(root).load()).skills.map(skill => skill.name));
    for (const test of WSTG_MAP) {
      expect(test.skills.filter(name => !names.has(name)), `${test.id} names an unknown skill`).toEqual([]);
      expect(test.skills.length > 0, `${test.id}: D and T carry a skill, N and O carry none`).toBe(test.support === 'D' || test.support === 'T');
      expect(new Set(test.skills).size, `${test.id} repeats a skill`).toBe(test.skills.length);
      if (test.support === 'O') expect(test.identity || test.browser, `${test.id}: an out-of-scope test has no further flags`).toBe(false);
    }
  });

  it('pins the counts that docs/WSTG_MAP.md and planning_update.md quote', () => {
    const count = (predicate: (test: (typeof WSTG_MAP)[number]) => boolean) => WSTG_MAP.filter(predicate).length;
    expect({ D: count(test => test.support === 'D'), T: count(test => test.support === 'T'), N: count(test => test.support === 'N'), O: count(test => test.support === 'O'), browser: count(test => test.browser), identity: count(test => test.identity) })
      .toEqual({ D: 26, T: 35, N: 43, O: 4, browser: 20, identity: 39 });
    expect(WSTG_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('docs/WSTG_MAP.md', () => {
  it('quotes the pinned commit and shows exactly the rows of the data', async () => {
    const doc = await readFile(join(root, 'docs/WSTG_MAP.md'), 'utf8');
    expect(doc).toContain(WSTG_COMMIT);
    expect(doc.split('\n').filter(line => line.startsWith('| wstg-')), 'regenerate with: npm run build && node scripts/render-wstg-map.mjs').toEqual(wstgTableRows());
  });
});

describe('wstgEvidence (L0 to L3 from the coverage cells that carry a test key)', () => {
  const cell = (execution: string, currentness: string, caseRefs: Array<{ caseId: string; revision: number }> = []) => ({ execution, currentness, caseRefs }) as WstgCell;
  const cases: WstgCase[] = [{ id: 'case-1', revision: 2, acceptedFinding: true }, { id: 'case-2', revision: 1, acceptedFinding: false }];
  const accepted = [{ caseId: 'case-1', revision: 2 }];
  const table: Array<[string, WstgCell[], WstgEvidence]> = [
    ['no cell', [], 'L0'],
    ['only planned or running cells', [cell('planned', 'current'), cell('running', 'current'), cell('unplanned', 'current')], 'L0'],
    ['a retired cell is ignored even when it was proven', [cell('tested', 'retired', accepted)], 'L0'],
    ['attempted', [cell('attempted', 'current')], 'L1'],
    ['blocked', [cell('blocked', 'current')], 'L1'],
    ['tested but stale', [cell('tested', 'stale')], 'L1'],
    ['tested but currentness unknown', [cell('tested', 'unknown')], 'L1'],
    ['stale is never proof, even with an accepted case', [cell('tested', 'stale', accepted)], 'L1'],
    ['tested and current', [cell('tested', 'current')], 'L2'],
    ['tested, citing a case that is not an accepted finding', [cell('tested', 'current', [{ caseId: 'case-2', revision: 1 }])], 'L2'],
    ['tested, citing a superseded revision of the accepted case', [cell('tested', 'current', [{ caseId: 'case-1', revision: 1 }])], 'L2'],
    ['tested, citing the current accepted confirmed case', [cell('tested', 'current', accepted)], 'L3'],
    ['the best cell wins over the weakest', [cell('blocked', 'current'), cell('tested', 'current'), cell('tested', 'current', accepted)], 'L3'],
    ['every cell not applicable', [cell('not_applicable', 'current')], 'n/a'],
    ['a not-applicable cell beside a tested one', [cell('not_applicable', 'current'), cell('tested', 'current')], 'L2'],
  ];
  it.each(table)('%s', (_name, cells, expected) => { expect(wstgEvidence(cells, cases)).toBe(expected); });
});

describe('the map reaches the lead and the workers without a new prompt line or tool', () => {
  const library = new SkillLibrary(root);
  const readAll = async (id: string) => { let page = await library.read(id), text = page.text; while (page.nextOffset !== undefined) { page = await library.read(id, page.nextOffset); text += page.text; } return text; };

  it('serves the table section of docs/WSTG_MAP.md as shared:wstg-map, without the Vietnamese preface or any tool name', async () => {
    expect((await library.list()).sharedDocuments).toContain('shared:wstg-map');
    const text = await readAll('shared:wstg-map');
    expect(text).toMatch(/^## WSTG map table/); expect(text).toContain(WSTG_COMMIT);
    expect(text.split('\n').filter(line => line.startsWith('| wstg-'))).toEqual(wstgTableRows());
    expect(text).not.toContain('Cách dùng khóa'); expect(text).not.toMatch(/\bp2o_[a-z_]+\b/);
    expect(text.length).toBeLessThanOrEqual(12_500); // measured 11,595; a longer section would cost a worker a third page
  });

  it('is linked from the shared handoff contract by the test-key convention', async () => {
    const handoffs = await readAll('shared:handoffs');
    expect(handoffs).toContain('wstg-athz-04'); expect(handoffs).toContain('p2o-skill:shared:wstg-map');
  });

  it('keeps the coverage-cell example valid and consistent with the map and the catalog', async () => {
    const doc = await readFile(join(root, 'docs/WSTG_MAP.md'), 'utf8');
    const block = /^## Ví dụ cell coverage[\s\S]*?```json\n([\s\S]*?)\n```/m.exec(doc)?.[1];
    expect(block, 'the example block is missing').toBeTruthy();
    const cell = validateCoverageCellDraft(JSON.parse(block!));
    const test = WSTG_BY_KEY.get(cell.questionKey);
    expect(test, 'the example must use a mapped key').toBeDefined();
    const workflows = (await library.load()).skills.filter(skill => test!.skills.includes(skill.name)).flatMap(skill => skill.workflows.map(workflow => workflow.id));
    expect(workflows, 'methodFamily must be a workflow id of a skill the map names for that test').toContain(cell.methodFamily);
  });
});
