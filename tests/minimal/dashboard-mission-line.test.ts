import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * planning_update.md P4 / §5.5: the README mission line is the product-boundary claim the owner approved (m1), and P4's exit
 * gate requires every clause of it to be demonstrably true in the shipped code. This test pins the sentence and the source
 * invariants behind it, so a future edit cannot quietly widen the claim or remove the mechanism while keeping the prose.
 */
const root = resolve(import.meta.dirname, '../..');
const APPROVED = 'There is no hidden planner model and no provider harness. An optional local, read-only dashboard renders committed records and holds no execution authority.';
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8');

/** Every file under the client tree (the served surface), so a renderer-safety claim covers the whole app, not one page. */
const clientSources = async (directory = 'dashboard/app'): Promise<Array<{ name: string; source: string }>> => {
  const entries = (await readdir(join(root, directory), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const files: Array<{ name: string; source: string }> = [];
  for (const entry of entries) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await clientSources(name));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push({ name, source: await read(name) });
  }
  return files;
};

describe('dashboard mission line: approved sentence and the invariants it claims', () => {
  it('keeps the approved sentence and does not reintroduce the pre-dashboard claim', async () => {
    const readme = normalize(await read('README.md'));
    expect(readme).toContain(APPROVED);
    expect(readme).not.toContain('no hidden planner model, no provider harness and no dashboard');
    // The install/run path the sentence depends on is documented where build commands live.
    for (const line of ['npm run dashboard:build', 'npm run dashboard:test', 'dashboard/main.js serve', '#token=', '127.0.0.1', 'GET']) {
      expect(readme).toContain(line);
    }
    const architecture = normalize(await read('docs/ARCHITECTURE.md'));
    expect(architecture).toContain('Read-only dashboard');
    expect(architecture).toContain('holds no execution authority');
    expect(normalize(await read('AGENTS.md'))).toContain('npm run dashboard:build');
  });

  it('matches the sentence against the code: loopback only, GET/HEAD only, read-only opens and no model or target call', async () => {
    const server = await read('src/dashboard/server.ts');
    expect(server).toContain("export const DASHBOARD_SERVE_HOST = '127.0.0.1';");
    expect(server).toContain("method !== 'GET' && method !== 'HEAD'");
    expect(server).toContain("sendText(request, response, 405, 'method not allowed', { allow: 'GET, HEAD' })");
    // The listener has no write path: no filesystem write, no child process, no engine/planner/broker/sandbox handle.
    expect(server).not.toMatch(/\b(?:writeFile|createWriteStream|mkdir|rename|copyFile|appendFile)\b/);
    expect(server).not.toMatch(/child_process|\bspawn\(/);
    for (const source of [server, await read('src/dashboard/main.ts')]) {
      expect(source).not.toMatch(/from '\.\.\/(?:engine|planner[^']*|broker[^']*|sandbox[^']*|executor[^']*|herdr[^']*)\.js'/);
    }
    const readModel = await read('src/dashboard/read-model.ts');
    expect(readModel).toContain('AssessmentStore.open(root, runId, { readOnly: true })');
    expect(readModel).toContain("store.readOnly !== true");
    expect(readModel).toContain('store.artifactBytes('); // live artifact reads go through the store's bounded reader
    const contract = await read('src/dashboard/contract.ts');
    expect(contract).toMatch(/authority:\s*'[^']*no execution authority[^']*cannot pause, stop or dispatch/);
    // The renderer renders committed values as React text: no HTML injection, and a snapshot copy is owner-only (0700/0600).
    const snapshot = await read('src/dashboard/snapshot.ts');
    expect(snapshot).toContain('mode: 0o700');
    expect(snapshot).toContain('mode: 0o600');
    const sources = await clientSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) expect(file.source, file.name).not.toContain('dangerouslySetInnerHTML');
  });
});
