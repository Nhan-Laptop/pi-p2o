import { describe, expect, it } from 'vitest';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P3: `/p2o map` is the in-Pi wrapper. It writes the same frozen directory `snapshot` writes, prints the
 * standalone serve command, and spawns nothing (owner decision m3) — the host never owns a server process or its token.
 */
const lastNotice = (h: any): string => h.ctx.notices.at(-1) ?? '';

describe('/p2o map', () => {
  it('writes a frozen dashboard snapshot from committed state and prints the standalone serve command', async () => {
    await fixture(async h => {
      await populate(h);
      h.ctx.setConfirm(true);
      const out = join(h.root, 'map-out');
      await h.command(`map --out ${out}`);
      const notice = h.screen();
      expect(notice).toContain(`Dashboard snapshot: ${out}`);
      expect(notice).toContain(`serve --snapshot ${out}`);
      expect(notice).toContain('no execution authority');
      expect(h.ctx.confirmBodies.at(-1)).toContain('review it before sharing');
      expect((await stat(out)).isDirectory()).toBe(true);
      const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
      expect(index).toMatchObject({ format: 'p2o-dashboard', version: 1 });
      expect(index.runs).toHaveLength(1);
      expect(index.totals.findings).toBe(1);
      const runs = await readdir(join(out, 'runs'));
      expect(runs).toHaveLength(1);
      const run = JSON.parse(await readFile(join(out, 'runs', runs[0]!), 'utf8'));
      expect(run).toMatchObject({ format: 'p2o-dashboard-run', version: 1 });
      expect(run.findings).toHaveLength(1);
      expect(run.artifacts).toEqual([]); // the fixture cites no retained capture
    });
  });

  it('refuses to overwrite an existing directory and states it through the error notice', async () => {
    await fixture(async h => {
      await populate(h);
      h.ctx.setConfirm(true);
      const out = join(h.root, 'map-out');
      await h.command(`map --out ${out}`);
      await h.command(`map --out ${out}`);
      expect(lastNotice(h)).toMatch(/new directory/);
    });
  });
});
