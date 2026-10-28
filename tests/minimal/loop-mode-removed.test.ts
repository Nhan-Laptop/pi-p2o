import { afterEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerP2O } from '../../extensions/p2o/index.js';
import { AssessmentEngine } from '../../src/engine.js';
import { parseCommand } from '../../src/target.js';
import { AssessmentStore } from '../../src/state/store.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH } from './helpers/fake-pi.js';

/**
 * P18/D48 (owner decision): the manual loop mode was removed. A run is always the automatic loop, so it needs a worker
 * backend; `--loop manual` refuses by name, and a stored profile that recorded the old mode resumes as the automatic loop
 * with one lifecycle fact instead of silently pretending nothing changed.
 */
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'p2o-loop-mode-'));
  roots.push(root);
  await mkdir(join(root, 'source'));
  return root;
}

describe('manual loop mode removed (P18/D48)', () => {
  it('refuses --loop manual by name and still accepts the only remaining mode', () => {
    expect(() => parseCommand('--target x --loop manual')).toThrow(/MANUAL_LOOP_REMOVED/);
    const accepted = parseCommand('--target x --loop event-driven');
    expect(accepted).toMatchObject({ target: 'x' });
    expect((accepted as { options?: Record<string, unknown> }).options ?? {}).not.toHaveProperty('loopMode');
  });

  it('has no manual branch left: a legacy-labelled engine still schedules automatic wakes', async () => {
    // The manual-storm assertion moves here: the snapshot still carries the stored label, but every mode guard was removed
    // (P18/D48), so a run labelled `manual` is the automatic loop too.
    const wakes: unknown[] = [];
    const engine = new AssessmentEngine('run-legacy-manual', 'manual', {
      active: () => true, list: async () => [], readiness: async () => ({ ready: true }), capacity: () => 1, reap: async () => true,
      spawn: async () => undefined, persist: async () => undefined, wake: wake => wakes.push(wake), idle: () => true, problem: () => undefined,
    }, 5);
    try {
      for (let i = 0; i < 200; i += 1) engine.notify('worker-report', `worker-${i}`);
      await delay(60);
      expect(wakes, 'the snapshot label is legacy data, not a mode gate').toHaveLength(1);
      expect(engine.snapshot()).toMatchObject({ mode: 'manual', rounds: 1, pendingEvents: 200 });
    } finally { engine.stop(); }
  });

  it('refuses to start a run when no worker backend can execute target work', async () => {
    const root = await workspace();
    const pi = createFakePi(), ctx = createContext({ cwd: root });
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'),
      herdr: createSimpleHerdr({ available: false }).client, createSandbox: sandboxFactory([]) });
    // The planner holds no target tools, so without Herdr there is no execution path at all: refuse before consent.
    await pi.commands.get('p2o').handler('--target ./source', ctx.ctx);
    expect(pi.messages).toHaveLength(0);
    expect(ctx.dialogs).toHaveLength(0);
    expect(ctx.notices.at(-1)).toMatch(/worker backend \(Herdr\)/);
    expect(ctx.notices.at(-1)).toMatch(/manual loop mode was removed/);
  });

  it('resumes a stored manual-loop profile as the automatic loop with one lifecycle fact', async () => {
    const root = await workspace(), targetPath = await realpath(join(root, 'source'));
    const stateRoot = join(root, '.p2o-state');
    // A store written by the previous build: its profile still says `manual`, which the current build only reads.
    const legacy = AssessmentStore.create(stateRoot, { runId: 'run-legacy-manual', retention: 'durable-local', targetKind: 'directory',
      targetIdentity: 'legacy-manual', targetDisplay: targetPath,
      profile: { runtimeHash: 'legacy', image: 'legacy-image', loopMode: 'manual', executorMode: 'shared' } });
    legacy.close();
    const pi = createFakePi(), ctx = createContext({ cwd: root });
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'),
      herdr: createSimpleHerdr().client, createSandbox: sandboxFactory([]) });
    try {
      await pi.commands.get('p2o').handler('--resume run-legacy-manual', ctx.ctx);
      expect(pi.messages.at(-1)).toMatch(/^Continue the resumed assessment\./);
      const reopened = AssessmentStore.open(stateRoot, 'run-legacy-manual', { readOnly: true });
      try {
        const mapped = reopened.records().find(row => row.data?.event === 'engine.loop-mode-mapped');
        expect(mapped?.kind).toBe('lifecycle');
        expect(mapped?.data).toMatchObject({ event: 'engine.loop-mode-mapped', from: 'manual', to: 'event-driven' });
        expect(String(mapped?.text)).toContain('removed manual loop');
      } finally { reopened.close(); }
    } finally {
      await pi.commands.get('p2o').handler('stop', ctx.ctx).catch(() => {});
    }
  }, 60_000);
});
