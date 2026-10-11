import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillLibrary } from '../../src/skills.js';
import { WSTG_BY_KEY, WSTG_MAP, wstgKey } from '../../src/wstg-map.js';

/**
 * planning_update.md X0.5: every in-scope WSTG test has exactly one owner skill, and the owner's reference card says which tests it runs on its first
 * line (`Tests: wstg-sess-03, ...`). The data (owner and card per test) lives in src/wstg-map.ts and may name skills that do not exist yet; this guard
 * only holds the plan to what exists, so it is green at every phase and tightens as skills land: a card counts when its skill, its document and its
 * `Tests:` line exist; a test with a card must be supported as D; a test supported as D must have a card or be one of the rows whose skill already named it.
 */
const root = resolve(import.meta.dirname, '../..');
/** The 21 rows supported as D by wording that predates the cards (planning_update.md B.3). A row may leave this set only by being demoted. */
const BASELINE_D = new Set(['INFO-06', 'INFO-07', 'CONF-13', 'ATHN-04', 'ATHN-10', 'ATHZ-02', 'ATHZ-03', 'ATHZ-04', 'INJT-01', 'INJT-02', 'INJT-16', 'INJT-18', 'INJT-20', 'INJT-22', 'INJT-23', 'CLNT-01', 'CLNT-02', 'CLNT-03', 'APIT-01', 'APIT-02', 'APIT-04'].map(id => `WSTG-${id}`));
/** Skills created for the WSTG plan: held to the size targets (the first page of a SKILL.md is inlined into a worker's brief; planning_update.md aims at 7,000 and this guard enforces one page). */
const NEW_PLAYBOOKS = ['web-deployment-hygiene', 'web-session-management', 'web-credential-lifecycle', 'web-server-side-injection', 'web-token-and-federation', 'web-business-logic-misuse', 'web-browser-trust-controls', 'web-graphql-testing', 'web-crypto-usage-review'];
const SKILL_CHARS = 8_000, CARD_CHARS = 6_000; // src/skills.ts pages are 8 KiB: a SKILL.md under 8,000 characters is inlined whole, with no "Continued" step

interface Landed { id: string; owner: string; card: string; ok: boolean; reason: string }

async function inspect() {
  const library = new SkillLibrary(root), catalog = await library.load();
  const skills = new Map(catalog.skills.map(skill => [skill.name, skill])), documents = new Map(catalog.documents.map(document => [document.id, document]));
  const cardKeys = new Map<string, string[]>(); // document id -> keys on its Tests: line
  for (const document of catalog.documents) {
    if (!/^skills\/[^/]+\/references\/[^/]+\.md$/.test(document.path)) continue;
    const first = (await readFile(join(root, document.path), 'utf8')).split('\n', 1)[0];
    if (first.startsWith('Tests:')) cardKeys.set(document.id, first.slice('Tests:'.length).split(',').map(key => key.trim()).filter(Boolean));
  }
  const landed: Landed[] = WSTG_MAP.filter(test => test.support !== 'O').map(test => {
    const base = { id: test.id, owner: test.owner, card: test.card };
    if (!skills.has(test.owner)) return { ...base, ok: false, reason: 'the owner skill does not exist yet' };
    if (!test.card) return { ...base, ok: false, reason: 'the owner has no card for this test' };
    const keys = cardKeys.get(`${test.owner}:${test.card}`);
    if (!keys) return { ...base, ok: false, reason: 'the card has no Tests: line yet' };
    return keys.includes(wstgKey(test.id)) ? { ...base, ok: true, reason: '' } : { ...base, ok: false, reason: 'the Tests: line does not list the key' };
  });
  return { skills, documents, cardKeys, landed };
}

describe('every in-scope WSTG test has one owner and its card says so', () => {
  it('lets a card count only when its skill, document and Tests: line exist, and then requires support D with the owner first', async () => {
    const { landed } = await inspect();
    for (const item of landed) {
      const test = WSTG_BY_KEY.get(wstgKey(item.id))!;
      if (item.ok) { expect(test.support, `${item.id} has a card, so it is supported as D`).toBe('D'); expect(test.skills[0], `${item.id}: the owner skill is listed first`).toBe(test.owner); }
      else if (test.support === 'D') expect(BASELINE_D.has(item.id), `${item.id} is D without a card (${item.reason}), which only the rows that predate the cards may be`).toBe(true);
    }
  });

  it('delivers an owner\'s cards together: once one card exists, every card the plan names for that owner exists', async () => {
    const { landed } = await inspect(), byOwner = new Map<string, Landed[]>();
    for (const item of landed.filter(entry => entry.card)) byOwner.set(item.owner, [...(byOwner.get(item.owner) ?? []), item]);
    for (const [owner, items] of byOwner) {
      const delivered = items.filter(item => item.ok);
      if (delivered.length) expect(items.filter(item => !item.ok).map(item => `${item.id}: ${item.reason}`), `${owner} is partly delivered`).toEqual([]);
    }
  });

  it('keeps each Tests: line consistent with the data and lists every key exactly once across the library', async () => {
    const { cardKeys } = await inspect(), seen = new Map<string, string>();
    for (const [documentId, keys] of cardKeys) {
      const [owner, card] = documentId.split(':');
      expect(keys.length, `${documentId} lists no key`).toBeGreaterThan(0);
      for (const key of keys) {
        const test = WSTG_BY_KEY.get(key);
        expect(test, `${documentId} lists ${key}, which is not a WSTG key`).toBeDefined();
        expect([test!.owner, test!.card], `${documentId} lists ${key}, which the data gives to another owner or card`).toEqual([owner, card]);
        expect(seen.get(key), `${key} appears on two Tests: lines`).toBeUndefined();
        seen.set(key, documentId);
      }
    }
  });

  it('indexes the keys it owns in the SKILL.md of a playbook, so a worker can find the card', async () => {
    const { skills, landed } = await inspect();
    for (const item of landed.filter(entry => entry.ok && skills.get(entry.owner)?.kind === 'playbook')) {
      const text = await readFile(join(root, 'skills', item.owner, 'SKILL.md'), 'utf8');
      expect(text, `${item.owner}/SKILL.md must mention ${wstgKey(item.id)}`).toContain(wstgKey(item.id));
      expect(text, `${item.owner}/SKILL.md must link its card ${item.card}`).toContain(`references/${item.card}.md`);
    }
  });

  it('holds the skills created for the plan to the size targets, so a worker\'s inlined first page stays small', async () => {
    const { skills, documents, landed } = await inspect();
    for (const name of NEW_PLAYBOOKS.filter(entry => skills.has(entry))) {
      expect(skills.get(name)!.kind, `${name} is a playbook`).toBe('playbook');
      const length = (await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8')).length;
      expect(length, `${name}/SKILL.md is ${length} characters`).toBeLessThanOrEqual(SKILL_CHARS);
    }
    for (const item of landed.filter(entry => entry.ok)) {
      const document = documents.get(`${item.owner}:${item.card}`)!, length = (await readFile(join(root, document.path), 'utf8')).length;
      expect(length, `${document.path} is ${length} characters`).toBeLessThanOrEqual(CARD_CHARS);
    }
  });

  it('names a planned owner in the data only with a kebab-case skill name, and every in-scope test has exactly one', () => {
    const inScope = WSTG_MAP.filter(test => test.support !== 'O');
    expect(inScope).toHaveLength(104);
    for (const test of inScope) expect(test.owner, test.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for (const name of NEW_PLAYBOOKS) expect(inScope.some(test => test.owner === name), `${name} owns at least one test`).toBe(true);
  });
});
