import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
