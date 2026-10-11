import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * docs/ACCEPTANCE_MATRIX.md maps the fixture scenarios of docs/ACCEPTANCE_BASELINE.md (formerly §13 of planning_update.md) to tests. This guard keeps that mapping honest: every cited test
 * must still exist under its exact title, every scenario of the plan must have a row with evidence, and a scenario added to the plan
 * without a matrix row fails here. It checks that evidence exists, not that the evidence is sufficient.
 */
const root = resolve(import.meta.dirname, '../..'), tests = join(root, 'tests/minimal');
const TITLE = /\b(?:it|test)(?:\.skipIf\([^)]*\)|\.each\(\[[^\]]*\](?:\s+as const)?\))?\(\s*(['`])((?:\\.|(?!\1).)*)\1/g;
const normalize = (value: string) => value.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();

async function inventory(): Promise<Map<string, Set<string>>> {
  const files = (await readdir(tests)).filter(name => name.endsWith('.test.ts')), result = new Map<string, Set<string>>();
  for (const name of files) { const source = await readFile(join(tests, name), 'utf8'), titles = new Set<string>(); for (const match of source.matchAll(TITLE)) titles.add(normalize(match[2])); result.set(name, titles); }
  return result;
}
const section = (text: string, from: RegExp, to: RegExp) => { const start = text.search(from); const rest = text.slice(start + 1); const end = rest.search(to); return rest.slice(0, end < 0 ? undefined : end); };
const references = (text: string) => [...text.matchAll(/`([a-z0-9-]+\.test\.ts) :: ([^`]+)`/g)].map(match => ({ file: match[1], title: normalize(match[2]) }));

describe('acceptance matrix (plan §13) stays tied to real tests', () => {
  it('cites only tests that exist under their exact titles', async () => {
    const known = await inventory(), cited = references(await readFile(join(root, 'docs/ACCEPTANCE_MATRIX.md'), 'utf8'));
    expect(cited.length).toBeGreaterThan(60);
    const missing = cited.filter(ref => !known.get(ref.file)?.has(ref.title)).map(ref => `${ref.file} :: ${ref.title}`);
    expect(missing).toEqual([]);
  });

  it('has exactly one evidence-bearing row for every §13.1 scenario of the plan and every §13.3 condition', async () => {
    const plan = await readFile(join(root, 'docs/ACCEPTANCE_BASELINE.md'), 'utf8'), matrix = await readFile(join(root, 'docs/ACCEPTANCE_MATRIX.md'), 'utf8');
    const planned = section(plan, /^### 13\.1\./m, /^### 13\.2\./m).split('\n').filter(line => /^\| /.test(line) && !/^\| Case \|/.test(line) && !/^\|---/.test(line));
    expect(planned, 'the baseline lists 22 mandatory fixture scenarios').toHaveLength(22);
    const rows = section(matrix, /^## §13\.1/m, /^## §13\.3/m).split('\n').filter(line => /^\| \d+ \|/.test(line));
    expect(rows.map(line => Number(/^\| (\d+) \|/.exec(line)![1]))).toEqual(Array.from({ length: planned.length }, (_, index) => index + 1));
    for (const row of rows) expect(references(row).length, row.slice(0, 80)).toBeGreaterThanOrEqual(1);
    const failures = plan.slice(plan.search(/^### 13\.3\./m)).split('\n').slice(1).join('\n'), bullets = section(failures, /^/m, /^---/m).split('\n').filter(line => /^- /.test(line));
    expect(bullets, 'the baseline lists 7 conditions that fail acceptance').toHaveLength(7);
    const conditions = section(matrix, /^## §13\.3/m, /^## Chạy lại/m).split('\n').filter(line => /^\| /.test(line) && !/^\| Điều kiện/.test(line) && !/^\|---/.test(line));
    expect(conditions).toHaveLength(bullets.length);
    for (const row of conditions) expect(references(row).length, row.slice(0, 80)).toBeGreaterThanOrEqual(1);
  });

  it('never rates a scenario Covered through a test that is only skipped when its opt-in flag is absent', async () => {
    const matrix = await readFile(join(root, 'docs/ACCEPTANCE_MATRIX.md'), 'utf8');
    for (const row of section(matrix, /^## §13\.1/m, /^## §13\.3/m).split('\n').filter(line => /^\| \d+ \|/.test(line))) {
      const optIn = row.split('<br>').filter(item => /\(D\)/.test(item)).length, total = references(row).length;
      expect(total - optIn, `scenario row ${row.slice(0, 6)} needs at least one test that runs in the default suite`).toBeGreaterThanOrEqual(1);
    }
  });
});
