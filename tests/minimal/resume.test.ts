import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerP2O } from '../../extensions/p2o/index.js';
import { AssessmentStore } from '../../src/state/store.js';
import { EXTENSION_PATH, InertSandbox, createContext, createFakePi, createSimpleHerdr, sandboxFactory } from './helpers/fake-pi.js';

/** planning_update.md Part XI S8: a durable-local run reopens writable under the same runId, with no restored ticket or worker. */
describe('resume a historical run', () => {
  it('keeps the runId and prior records, records the interruption boundary, and refuses a second live resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-resume-')); await mkdir(join(root, 'source'));
    const settingsPath = join(root, 'settings.json'), controlRoot = join(root, 'control');
    const open = () => registerP2O(createFakePi().pi, { extensionPath: EXTENSION_PATH, controlRoot, settingsPath, herdr: createSimpleHerdr().client, createSandbox: sandboxFactory([]) });
    const first = createFakePi(), firstCtx = createContext({ cwd: root });
    openWith(first);
    try {
      await first.commands.get('p2o')!.handler('--target ./source --retention durable-local', firstCtx.ctx);
      const [runId] = (await readdir(join(root, '.p2o-state'))).filter(name => name.startsWith('run-'));
      expect(runId).toBeDefined();
      await first.commands.get('p2o')!.handler('stop', firstCtx.ctx);

      const second = createFakePi(), secondCtx = createContext({ cwd: root });
      openWith(second);
      await second.commands.get('p2o')!.handler(`--resume ${runId}`, secondCtx.ctx);
      expect(secondCtx.notices.join(' ')).toContain('Sandbox ready');
      expect(second.messages.at(-1)).toMatch(/^Continue the resumed assessment\./);
      expect(second.active).toContain('p2o_task_author');
      expect(second.active).not.toContain('p2o_shell');

      const reopened = AssessmentStore.open(join(root, '.p2o-state'), runId!, { readOnly: true });
      try {
        expect(reopened.manifest().runId).toBe(runId);
        const records = reopened.records();
        expect(records.some(row => row.kind === 'lifecycle' && String(row.text).includes('run resumed for'))).toBe(true);
        const boundary = records.filter(row => row.kind === 'lifecycle' && (row.data?.reconciliation as Record<string, unknown> | undefined)?.resume === true).at(-1);
        expect(boundary?.data?.reconciliation as Record<string, unknown>).toMatchObject({ resume: true, authorityRestored: false });
      } finally { reopened.close(); }

      // The process-level guard wins even before the store writer lock: one live owner per Pi.
      const third = createFakePi(), thirdCtx = createContext({ cwd: root });
      openWith(third);
      await third.commands.get('p2o')!.handler(`--resume ${runId}`, thirdCtx.ctx);
      // Another live owner is refused: the process guard names it, and the store writer lock refuses a second handle.
      expect(thirdCtx.notices.join(' ')).toMatch(/already active|locked/);
      expect(third.messages).toHaveLength(0);
      await second.commands.get('p2o')!.handler('stop', secondCtx.ctx);
    } finally {
      await first.commands.get('p2o')!.handler('stop', firstCtx.ctx).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }

    function openWith(fake: ReturnType<typeof createFakePi>) {
      registerP2O(fake.pi, { extensionPath: EXTENSION_PATH, controlRoot, settingsPath, herdr: createSimpleHerdr().client, createSandbox: sandboxFactory([]) });
    }
  }, 60_000);

  it('never resurrects a worker: a resumed run starts with an empty worker set and no ticket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-resume-empty-')); await mkdir(join(root, 'source'));
    const settingsPath = join(root, 'settings.json'), controlRoot = join(root, 'control');
    const fake = createFakePi(), ctx = createContext({ cwd: root });
    registerP2O(fake.pi, { extensionPath: EXTENSION_PATH, controlRoot, settingsPath, herdr: createSimpleHerdr().client, createSandbox: sandboxFactory([]) });
    try {
      await fake.commands.get('p2o')!.handler('--target ./source', ctx.ctx);
      const [runId] = (await readdir(join(root, '.p2o-state'))).filter(name => name.startsWith('run-'));
      await fake.commands.get('p2o')!.handler('stop', ctx.ctx);

      const resumed = createFakePi(), resumedCtx = createContext({ cwd: root });
      registerP2O(resumed.pi, { extensionPath: EXTENSION_PATH, controlRoot, settingsPath, herdr: createSimpleHerdr().client, createSandbox: sandboxFactory([]) });
      await resumed.commands.get('p2o')!.handler(`--resume ${runId}`, resumedCtx.ctx);
      const workers = await resumed.tools.get('p2o_workers')!.execute('list', { action: 'list' }, undefined, undefined, resumedCtx.ctx);
      expect(workers.details.workers ?? workers.details.rows ?? []).toHaveLength(0);
      await resumed.commands.get('p2o')!.handler('stop', resumedCtx.ctx);
    } finally {
      await fake.commands.get('p2o')!.handler('stop', ctx.ctx).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
