// CONTRACT ONLY: stub UI/backend tests; not evidence of live model, target or runtime execution.
//
// F5 regression: `/p2o` must be usable headlessly. Pi 1.0.0 text print mode (`pi -p`, `ctx.mode === 'print'`)
// has no extension UI, redirects `process.stdout.write` to stderr and renders no custom message, so the
// command outcome has to reach stdout through the host text sink as plain text. The `p2o_result`/`p2o_error`
// messages stay the machine-readable channel and must remain unchanged in every mode.
import { describe, expect, test, vi } from 'vitest';
import { createP2OTextSink, registerP2O } from '../../extensions/p2o/index.js';
import { p2oErrorText } from '../../src/interface/command.js';
import { FakeBackend, FakeEntry, fakePi } from '../interface/helpers.js';

import { contractOwnerConsent } from './owner-consent-fixture.js';

type Mode = 'tui' | 'json' | 'print' | 'rpc';

function setup(mode: Mode) {
  const pi = fakePi(mode === 'tui');
  Object.assign(pi.context, { mode });
  const backend = new FakeBackend(), entry = new FakeEntry();
  backend.entry = entry;
  const written: string[] = [];
  const controller = registerP2O(pi.api, {
    backendFactory: () => backend,
    onboardingFor: contractOwnerConsent,
    textPrintWriterFor: text => { written.push(text); },
  });
  return { pi, backend, entry, written, controller };
}

const lastText = (pi: ReturnType<typeof fakePi>) => String(pi.messages.at(-1)?.content ?? '');

describe('headless /p2o text output (F5)', () => {
  test('the text sink exists only for the one-shot text print mode', async () => {
    const written: string[] = [];
    const sinkFor = (mode: Mode) => createP2OTextSink(Object.assign(fakePi(false).context, { mode }), text => { written.push(text); });
    expect(sinkFor('tui')).toBeUndefined();
    expect(sinkFor('json')).toBeUndefined();
    expect(sinkFor('rpc')).toBeUndefined();
    const sink = sinkFor('print');
    expect(sink).toBeTypeOf('function');
    await sink?.('one line');
    await sink?.('terminated\n');
    expect(written).toEqual(['one line\n', 'terminated\n']);
  });

  test('bare /p2o prints the help text while p2o_result stays the machine event', async () => {
    const s = setup('print');
    await s.pi.command('p2o', '');
    const message = s.pi.messages.at(-1);
    expect(message?.customType).toBe('p2o_result');
    expect(s.written).toEqual([`${lastText(s.pi)}\n`]);
    expect(s.written[0]).toMatch(/\/p2o status\|stop\|resume\|report/);
    expect(s.written[0]).toMatch(/no target I\/O during preparation\/planning/i);
    await s.controller.close();
  });

  test('a fail-closed error is distinguishable plain text and stays a p2o_error event', async () => {
    const s = setup('print');
    await s.pi.command('p2o', 'status');
    expect(s.pi.messages.at(-1)?.customType).toBe('p2o_error');
    expect(s.written).toEqual([`${p2oErrorText(lastText(s.pi))}\n`]);
    expect(s.written[0]).toMatch(/^p2o error: RUN_ID_REQUIRED/);
    await s.controller.close();
  });

  test('tui/json/rpc surfaces keep only the emitted message and receive no raw text', async () => {
    for (const mode of ['tui', 'json', 'rpc'] as const) {
      const s = setup(mode);
      await s.pi.command('p2o', '');
      expect(s.pi.messages.at(-1)?.customType).toBe('p2o_result');
      expect(s.written).toEqual([]);
      await s.controller.close();
    }
  });

  test('plan-only/approve/status/report/stop/resume print the same text as their receipts', async () => {
    const s = setup('print');
    s.entry.current = { runId: 'run-1', state: 'active' };
    const steps = [
      ['--target ./repo --plan-only', 'p2o_result'],
      ['approve plan-1', 'p2o_error'],
      ['status', 'p2o_result'],
      ['report', 'p2o_result'],
      ['stop', 'p2o_result'],
      ['resume run-1', 'p2o_result'],
    ] as const;
    for (const [args, customType] of steps) {
      await s.pi.command('p2o', args);
      expect(s.pi.messages.at(-1)?.customType).toBe(customType);
    }
    expect(s.pi.messages).toHaveLength(steps.length);
    expect(s.written).toEqual(s.pi.messages.map(message => message.customType === 'p2o_error'
      ? `${p2oErrorText(String(message.content))}\n` : `${String(message.content)}\n`));
    expect(s.written[0]).toMatch(/Plan only — no target request/);
    // A headless approve cannot show the required confirmation dialog: fail-closed and visible.
    expect(s.written[1]).toMatch(/^p2o error: HUMAN_CONFIRMATION_REQUIRED/);
    expect(s.written[2]).toMatch(/requested-provider/);
    expect(s.written[3]).toMatch(/Qualified report/);
    expect(s.written[4]).toMatch(/verified termination/);
    expect(s.written[5]).toMatch(/re-checked/);
    await s.controller.close();
  });

  test('a failing text writer never turns a reported outcome into an error', async () => {
    const reported: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      reported.push(String(chunk));
      return true;
    });
    try {
      const pi = fakePi(false);
      Object.assign(pi.context, { mode: 'print' });
      const backend = new FakeBackend(), entry = new FakeEntry();
      backend.entry = entry;
      const controller = registerP2O(pi.api, {
        backendFactory: () => backend,
        onboardingFor: contractOwnerConsent,
        textPrintWriterFor: () => { throw new Error('stdout closed'); },
      });
      await pi.command('p2o', '');
      expect(pi.messages.at(-1)?.customType).toBe('p2o_result');
      await pi.command('p2o', 'status');
      expect(pi.messages.at(-1)?.customType).toBe('p2o_error');
      expect(reported).toHaveLength(2);
      expect(reported[0]).toMatch(/^p2o: text print output failed: .*stdout closed/);
      await controller.close();
    } finally { stderr.mockRestore(); }
  });
});
