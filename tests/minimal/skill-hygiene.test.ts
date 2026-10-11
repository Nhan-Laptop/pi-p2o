import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillLibrary } from '../../src/skills.js';
import { ALL_TOOLS } from '../../src/tool-policy.js';

/**
 * S3 (plan): the lead's prompt names no tool, and neither does the knowledge it reads. A skill, a reference, a sidecar or the catalog that names a
 * tool couples the knowledge to a loadout (the delegated lead cannot call the target tools a catalog prerequisite used to name), so that cannot return silently.
 */
const root = resolve(import.meta.dirname, '../..');
async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(path)); else if (/\.(?:md|json|ya?ml)$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}
const tools = (text: string) => [...new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? [])];

describe('the knowledge layer stays tool-agnostic', () => {
  it('names no p2o_* tool in any skill, reference, recipe, sidecar or the catalog', async () => {
    const paths = await files(join(root, 'skills'));
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths) expect(tools(await readFile(path, 'utf8')), path.slice(root.length + 1)).toEqual([]);
  });

  it('lets the shared handoff contract name only tools that exist', async () => {
    for (const name of tools(await readFile(join(root, 'HANDOFFS.md'), 'utf8'))) expect(ALL_TOOLS, `HANDOFFS.md names ${name}`).toContain(name);
  });

  it('serves the two handoff sections skills link to as small documents instead of the whole contract', async () => {
    const library = new SkillLibrary(root), whole = await library.read('shared:handoffs');
    const method = await library.read('shared:handoffs-method-review'), owner = await library.read('shared:handoffs-owner-review');
    expect(method.text.startsWith('### Focused method and review')).toBe(true); expect(owner.text.startsWith('### Provisional owner review')).toBe(true);
    expect(method.text.length + owner.text.length).toBeLessThan((await readFile(join(root, 'HANDOFFS.md'), 'utf8')).length / 3); expect(method.nextOffset).toBeUndefined();
    // Whole-file hash is unchanged by serving a section, so an assigned method goes stale only when HANDOFFS.md itself changes.
    expect(method.sha256).toBe(whole.sha256);
    const linking = (await files(join(root, 'skills'))).filter(path => path.endsWith('.md'));
    let sections = 0;
    for (const path of linking) {
      const text = await readFile(path, 'utf8'), id = path.slice(join(root, 'skills').length + 1).replace(/\/(?:SKILL|references\/([^/]+))\.md$/, (_m, ref) => ref ? `:${ref}` : '').replace(/\.md$/, '');
      if (!/HANDOFFS\.md#focused-method-and-review/.test(text)) continue;
      let page = await library.read(id), rendered = page.text; while (page.nextOffset !== undefined) { page = await library.read(id, page.nextOffset); rendered += page.text; }
      sections++;
      expect(rendered, id).toContain('p2o-skill:shared:handoffs-method-review'); expect(rendered, id).not.toContain('HANDOFFS.md#focused-method-and-review');
    }
    expect(sections).toBeGreaterThanOrEqual(10);
  });
});
