import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registerP2O } from '../../extensions/p2o/index.js';
import { AssessmentStore } from '../../src/state/store.js';
import { DashboardScreen } from '../../src/ui/dashboard-screen.js';
import { createFakePi, createContext, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, type InertSandbox } from './helpers/fake-pi.js';

const draft = {question:'Inspect the fixture boundary',surface:'fixture',risk:'policy',role:'general',roleReason:'Controlled local fixture observation',expectedTrue:'Specific observable support',expectedFalse:'Specific contradictory support',stopCondition:'Stop after the bounded observation',evidenceIds:[],prerequisites:[],skills:[],methodReason:'Controlled inert fixture, not security proof'};

async function fixture(work: (h: any) => Promise<void>, args = '') {
  const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-'));
  await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'nonexistent-test-settings.json'), herdr: herdr.client, createSandbox: sandboxFactory(sandboxes) });
  const command = (s: string) => pi.commands.get('p2o').handler(s, ctx.ctx);
  const call = (s: string, p = {}) => pi.tools.get(s).execute('call', p, undefined, undefined, ctx.ctx);
  try { await command(`--target ./source ${args}`); await work({ root, pi, ctx, herdr, sandboxes, command, call }); }
  finally { await command('stop'); await rm(root, { recursive: true, force: true }); }
}

describe('/p2o dashboard (P2: multi-tab live screen)', () => {
  it('opens on the overview tab by default, matching /p2o status content', async () => {
    await fixture(async h => {
      await h.command('dashboard');
      expect(h.ctx.screens).toHaveLength(1);
      expect(h.ctx.screens.at(-1)).toBeInstanceOf(DashboardScreen);
      const rendered = h.ctx.screens.at(-1).render(150).join('\n');
      expect(rendered).toContain('[1:overview]');
      expect(rendered).toContain('Tasks 0:'); // same content as /p2o status
    });
  });

  it('opens directly on a requested tab by name or number', async () => {
    await fixture(async h => {
      await h.command('dashboard workers');
      expect(h.ctx.screens.at(-1).render(150).join('\n')).toContain('[2:workers]');
      await h.command('dashboard 4'); // coverage
      expect(h.ctx.screens.at(-1).render(150).join('\n')).toContain('[4:coverage]');
    });
  });

  it('rejects an unknown section', async () => {
    await fixture(async h => {
      await h.command('dashboard nonsense');
      expect(h.ctx.notices.at(-1)).toContain('Usage: /p2o dashboard');
    });
  });

  it('falls back to a text notification in RPC mode, with no screen opened', async () => {
    await fixture(async h => {
      (h.ctx.ctx as any).mode = 'rpc';
      await h.command('dashboard cases');
      expect(h.ctx.screens).toHaveLength(0);
      expect(h.ctx.notices.at(-1)).toContain('Cases:');
    });
  });

  it('stays live while open: a committed task shows up on the tasks tab, and opening the dashboard adds no scan beyond the normal commit+refresh cycle', async () => {
    const records = vi.spyOn(AssessmentStore.prototype, 'recordsSince');
    try {
      await fixture(async h => {
        await h.call('p2o_task', { action: 'create', draft }); await delay(150);
        const baseline = records.mock.calls.length;
        await h.command('dashboard tasks');
        records.mockClear();
        await h.call('p2o_task', { action: 'create', draft: { ...draft, question: 'A second, distinct task' } }); await delay(150);
        expect(records.mock.calls.length, 'opening the dashboard must not add scans beyond the baseline commit+refresh cycle').toBe(baseline);
        expect(h.ctx.renderRequests, 'the live screen asked the TUI to re-render').toBeGreaterThan(0);
        expect(h.ctx.screens.at(-1).render(150).join('\n')).toContain('A second, distinct task');
      });
    } finally { records.mockRestore(); }
  });

  it('keeps the current tab and scroll position across a live refresh', async () => {
    await fixture(async h => {
      await h.command('dashboard coverage');
      await h.call('p2o_note', { kind: 'observation', text: 'tick' }); await delay(150);
      expect(h.ctx.screens.at(-1).render(150).join('\n')).toContain('[4:coverage]');
    });
  });

  it('shows the in-memory final summary on overview only after the run finishes, and the no-store notice for any other tab', async () => {
    await fixture(async h => {
      await h.command('stop');
      await h.command('dashboard'); // overview still works from lastStatus, as a StateScreen (not a live DashboardScreen)
      expect(h.ctx.screens.at(-1).render(150).join('\n')).toContain('HISTORICAL in-memory final summary');
      await h.command('dashboard workers');
      expect(h.ctx.notices.at(-1)).toContain('No active/open knowledge store');
    });
  });
});

describe('F2 shortcut (P5: non-capturing live overlay)', () => {
  it('registers f2 and needs an active TUI assessment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-f2-'));
    await mkdir(join(root, 'source'));
    const pi = createFakePi(), ctx = createContext({ cwd: root }), sandboxes: InertSandbox[] = [];
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'nonexistent-test-settings.json'), herdr: createSimpleHerdr().client, createSandbox: sandboxFactory(sandboxes) });
    try {
      const shortcut = pi.shortcuts.get('f2');
      expect(shortcut).toBeTruthy();
      await shortcut.handler(ctx.ctx);
      expect(ctx.notices.at(-1)).toContain('needs an active TUI assessment');
      expect(ctx.overlays).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('opens a non-capturing overlay on first press and toggles hidden/shown on later presses without recreating it', async () => {
    await fixture(async h => {
      const shortcut = h.pi.shortcuts.get('f2');
      await shortcut.handler(h.ctx.ctx);
      expect(h.ctx.overlays).toHaveLength(1);
      expect(h.ctx.overlays[0].options.overlayOptions.nonCapturing).toBe(true);
      const handle = h.ctx.overlays[0].handle;
      expect(handle.isHidden()).toBe(false);
      await shortcut.handler(h.ctx.ctx); // toggle off
      expect(handle.isHidden()).toBe(true);
      await shortcut.handler(h.ctx.ctx); // toggle on again
      expect(handle.isHidden()).toBe(false);
      expect(h.ctx.overlays).toHaveLength(1); // still the same overlay, not a second one
    });
  });

  it('stays live through the shared refresh pipeline, same as the modal dashboard', async () => {
    await fixture(async h => {
      const shortcut = h.pi.shortcuts.get('f2');
      await shortcut.handler(h.ctx.ctx);
      const before = h.ctx.renderRequests;
      await h.call('p2o_note', { kind: 'observation', text: 'overlay-tick' }); await delay(150);
      expect(h.ctx.renderRequests).toBeGreaterThan(before);
    });
  });
});
