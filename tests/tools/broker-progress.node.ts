// Regression tests for the F4 fix at the broker boundary: cold bring-up must not consume the operation
// deadline, a dead tool plane halts the attempt, and pre-dispatch refusals must not consume the
// capability/tool-call budget. The private build compiles src/policy + src/tools + tests; no network,
// no container and no external target is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, PolicyError, TargetBudget } from '../../src/policy/index.js';
import { createDefaultRegistry, createLocalFixtureSandbox, createToolBroker, ToolExecutionError } from '../../src/tools/index.js';
import type { ToolBrokerOptions } from '../../src/tools/broker.js';
import {
  DEFAULT_NO_PROGRESS_REFUSALS, NO_PROGRESS_HALT, type ToolBrokerWithNoProgress,
} from '../../src/tools/broker.js';
import { DEFAULT_STARTUP_BUDGET_MS } from '../../src/tools/registry.js';
import type { ExecutionSandbox } from '../../src/tools/sandbox.js';
import type { TestContext } from 'node:test';
import { context, fixtureScope, roots } from './fixtures.js';

const ACK = 'local-fixtures-only-not-hostile-code-isolation' as const;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const isCode = (code: string) => (error: unknown) => error instanceof PolicyError && error.code === code;

interface HarnessOptions {
  /** Narrowed steady-state operation cap; the production cap stays 15s. */
  opTimeoutMs?: number;
  preflightMs?: number;
  /** How many of the first bring-ups fail, proving a failed bring-up is not cached. */
  preflightFailures?: number;
  workMs?: number;
  failWork?: boolean;
  broker?: Partial<ToolBrokerOptions>;
}

async function harness(t: TestContext, options: HarnessOptions = {}) {
  const paths = await roots(t);
  const policy = createPolicy(fixtureScope());
  const budgets = new TargetBudget(policy.scope.targets);
  const base = createLocalFixtureSandbox({ ...paths, acknowledgement: ACK });
  const state = { failWork: options.failWork === true, preflights: 0, dispatches: 0, remainingPreflightFailures: options.preflightFailures ?? 0 };
  const sandbox: ExecutionSandbox = {
    ...base,
    preflight: async () => {
      state.preflights += 1;
      if (options.preflightMs) await delay(options.preflightMs);
      if (state.remainingPreflightFailures > 0) { state.remainingPreflightFailures -= 1; throw new PolicyError('UNAVAILABLE', 'fixture bring-up failed once'); }
      return base.preflight();
    },
    analyzeSource: async (files, contains, signal) => {
      state.dispatches += 1;
      if (options.workMs) await delay(options.workMs);
      if (state.failWork) throw new PolicyError('UNAVAILABLE', 'fixture tool plane dead');
      return base.analyzeSource(files, contains, signal);
    },
  };
  const registry = createDefaultRegistry(options.opTimeoutMs ? { limits: { timeoutMs: options.opTimeoutMs } } : {});
  const broker = createToolBroker({ policy, budgets, sandbox, registry, ...options.broker }) as ToolBrokerWithNoProgress;
  const call = (input: unknown = { paths: ['app.ts'] }) => broker.execute({ context, tool: 'source.analyze', input });
  return {
    paths, policy, budgets, registry, broker, call, state,
    stats: () => ({ preflights: state.preflights, dispatches: state.dispatches }),
    setFailWork: (value: boolean) => { state.failWork = value; },
    grantCalls: () => budgets.grantSnapshot(context.grantId).calls,
  };
}

test('the default operation cap stays 15s while the descriptor bring-up budget stays at least 30s', () => {
  const registry = createDefaultRegistry();
  assert.equal(registry.get('http.request').limits.timeoutMs, 15_000);
  assert.equal(registry.get('source.analyze').limits.timeoutMs, 15_000);
  assert.equal(registry.startupBudgetMs('http.request'), DEFAULT_STARTUP_BUDGET_MS);
  assert.ok(registry.startupBudgetMs('source.analyze') >= 30_000);
  // Narrowing the operation cap for a test must not narrow bring-up below the packed-image cold-start floor.
  const narrowed = createDefaultRegistry({ limits: { timeoutMs: 200 } });
  assert.equal(narrowed.get('source.analyze').limits.timeoutMs, 200);
  assert.ok(narrowed.startupBudgetMs('source.analyze') >= 30_000);
});

test('cold bring-up does not consume the operation deadline', async t => {
  // Bring-up (300ms) is slower than the narrowed operation cap (200ms): before the fix the first call
  // TIMED OUT inside sandbox readiness.
  const f = await harness(t, { opTimeoutMs: 200, preflightMs: 300, broker: { startupBudgetMs: 5_000 } });
  const result = await f.call();
  assert.equal(result.receipt.outcome, 'collected');
  assert.equal(f.stats().preflights, 1);
  assert.equal(f.stats().dispatches, 1);
  assert.equal(f.grantCalls(), 1);
});

test('the operation deadline still bounds real work after a successful bring-up', async t => {
  const f = await harness(t, { opTimeoutMs: 200, workMs: 600, broker: { startupBudgetMs: 5_000 } });
  await assert.rejects(f.call(), isCode('TIMEOUT'));
});

test('a sandbox that never honours the signal is still bounded by the bring-up budget', async t => {
  const f = await harness(t, { preflightMs: 1_600, broker: { startupBudgetMs: 1_000 } });
  await assert.rejects(f.call(), (error: unknown) => error instanceof PolicyError && error.code === 'TIMEOUT' && /bring-up exceeded 1000 ms/.test(error.message));
  assert.equal(f.stats().dispatches, 0, 'no operation may run after a refused bring-up');
  assert.equal(f.grantCalls(), 0, 'a refused bring-up must not consume the tool-call budget');
});

test('a failed bring-up is retried on the next call instead of being cached forever', async t => {
  const f = await harness(t, { preflightFailures: 1, broker: { startupBudgetMs: 5_000 } });
  await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  const result = await f.call();
  assert.equal(result.receipt.outcome, 'collected');
  assert.equal(f.stats().preflights, 2);
});

test('N consecutive tool-plane refusals with zero collected receipts halt the attempt', async t => {
  const f = await harness(t, { failWork: true, broker: { noProgress: { consecutiveRefusals: 3 } } });
  await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  let halted: unknown;
  try { await f.call(); } catch (error) { halted = error; }
  assert.ok(halted instanceof PolicyError, 'the tripping call reports the halt');
  assert.ok(halted.message.startsWith(NO_PROGRESS_HALT));
  assert.match(halted.message, /3 consecutive tool-plane refusals/);
  const dispatchesAtHalt = f.stats().dispatches;
  await assert.rejects(f.call(), (error: unknown) => error instanceof PolicyError && error.message.startsWith(NO_PROGRESS_HALT));
  assert.equal(f.stats().dispatches, dispatchesAtHalt, 'a halted attempt may not dispatch again');
  assert.equal(f.grantCalls(), 3, 'the halted call consumes no further tool-call budget');
  const report = f.broker.noProgress(context.attemptId);
  assert.equal(report?.code, NO_PROGRESS_HALT);
  assert.equal(report?.refusals, 3);
  assert.equal(report?.collected, 0);
  assert.equal(report?.lastCode, 'UNAVAILABLE');
});

test('one collected receipt disables the breaker for that attempt even after later refusals', async t => {
  const f = await harness(t, { broker: { noProgress: { consecutiveRefusals: 2 } } });
  const first = await f.call();
  assert.equal(first.receipt.outcome, 'collected');
  f.setFailWork(true);
  await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  assert.equal(f.broker.noProgress(context.attemptId), undefined, 'an attempt that collected something is never halted by the breaker');
});

test('a policy denial resets the consecutive-refusal streak (the plane answered)', async t => {
  const f = await harness(t, { failWork: true, broker: { noProgress: { consecutiveRefusals: 2 } } });
  await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  await assert.rejects(f.broker.execute({ context, tool: 'native.inspect', input: { path: 'app.ts' } }), isCode('CAPABILITY_DENIED'));
  await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  assert.equal(f.broker.noProgress(context.attemptId), undefined);
});

test('the breaker can be disabled explicitly', async t => {
  const f = await harness(t, { failWork: true, broker: { noProgress: { consecutiveRefusals: 0 } } });
  for (let call = 0; call < DEFAULT_NO_PROGRESS_REFUSALS + 2; call++) await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  assert.equal(f.broker.noProgress(context.attemptId), undefined);
});

test('pre-dispatch refusals consume no tool-call budget; dispatched work does', async t => {
  const f = await harness(t, {});
  // Pre-dispatch: capability not granted for the fixture scope.
  await assert.rejects(f.broker.execute({ context, tool: 'native.inspect', input: { path: 'app.ts' } }), isCode('CAPABILITY_DENIED'));
  assert.equal(f.grantCalls(), 0, 'a capability refusal never dispatched and must not be charged');
  // Pre-dispatch: invalid input.
  await assert.rejects(f.call({ paths: ['../escape'] }), (error: unknown) => error instanceof PolicyError);
  assert.equal(f.grantCalls(), 0, 'invalid input never dispatched and must not be charged');
  // Dispatched work is charged exactly once.
  const collected = await f.call();
  assert.equal(collected.receipt.outcome, 'collected');
  assert.equal(f.grantCalls(), 1);
  // Dispatched-but-failed work stays charged: the attempt really spent tool plane time.
  f.setFailWork(true);
  await assert.rejects(f.call(), isCode('UNAVAILABLE'));
  assert.equal(f.grantCalls(), 2);
  assert.equal(f.budgets.snapshot('fixture-target').requests, 0, 'an offline tool must reserve no target traffic');
});

test('the broker reports whether a failed call actually reached the capability adapter (R2)', async t => {
  const refusal = (error: unknown): boolean => error instanceof ToolExecutionError && error.dispatched === false;
  const f = await harness(t, { broker: { startupBudgetMs: 5_000 } });
  // Pre-dispatch refusals: capability, input, and the halt fence all report dispatched === false.
  await assert.rejects(f.broker.execute({ context, tool: 'native.inspect', input: { path: 'app.ts' } }), refusal);
  await assert.rejects(f.call({ paths: ['../escape'] }), refusal);
  assert.equal(f.grantCalls(), 0, 'a pre-dispatch refusal costs no tool-call budget');

  // A sandbox that never becomes ready is a pre-dispatch refusal too.
  const unavailable = await harness(t, { preflightMs: 1_600, broker: { startupBudgetMs: 1_000 } });
  await assert.rejects(unavailable.call(), (error: unknown) => error instanceof ToolExecutionError && error.dispatched === false && error.code === 'TIMEOUT');

  // A dispatched failure stays charged and reports dispatched === true.
  f.setFailWork(true);
  await assert.rejects(f.call(), (error: unknown) => error instanceof ToolExecutionError && error.dispatched === true && error.code === 'UNAVAILABLE');
  assert.equal(f.grantCalls(), 1, 'dispatched work is charged even when it fails');

  // The halt fence is pre-dispatch as well.
  const halted = await harness(t, { failWork: true, broker: { noProgress: { consecutiveRefusals: 2 } } });
  await assert.rejects(halted.call(), (error: unknown) => error instanceof ToolExecutionError && error.dispatched === true);
  await assert.rejects(halted.call(), (error: unknown) => error instanceof ToolExecutionError && error.message.startsWith(NO_PROGRESS_HALT) && error.dispatched === true);
  await assert.rejects(halted.call(), (error: unknown) => error instanceof ToolExecutionError && error.message.startsWith(NO_PROGRESS_HALT) && error.dispatched === false);
  assert.equal(halted.grantCalls(), 2, 'a halted call consumes no further budget');
});
