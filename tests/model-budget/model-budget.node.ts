import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createControllerModelGateway, clampModelRequest } from '../../src/runtime/config.js';
import { createTurnSpendGate } from '../../src/runtime/managed.js';
import { ModelSpendBudget, pinnedModelPrices, planAutonomousModelBudget, createAutonomousPhaseBudgets, type ModelSpendState } from '../../src/policy/budget.js';
import type { ModelGateway, RuntimeSelection } from '../../src/runtime/types.js';
const prices = pinnedModelPrices({ 'fixture/model': { input: 3, output: 15 }, 'deepseek/deepseek-flash': { input: .3, output: 1.2 } });
const selection: RuntimeSelection = { provider: 'fixture', model: 'model', thinking: 'off' };
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function journal() {
  let state: ModelSpendState | undefined;
  let fail = false;
  return { load: () => state && structuredClone(state), save: (v: Readonly<ModelSpendState>) => { if (fail) { fail = false; throw new Error('injected durable failure'); } state = structuredClone(v); }, fault: () => { fail = true; } };
}
async function fixture(options: { api?: ModelGateway['api']; ceiling?: number; selection?: RuntimeSelection; model?: ModelGateway['models'][number]; packets?: unknown[]; missing?: boolean; barrier?: number; limits?: number; receiptFile?: string; abort?: boolean; beforeReply?: () => Promise<void> } = {}) {
  const wire: Buffer[] = [];
  const held: Array<() => void> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    wire.push(Buffer.concat(chunks));
    if (options.abort) { req.socket.destroy(); return; }
    await options.beforeReply?.();
    const reply = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const packets = options.missing ? [{}] : options.packets ?? [{ usage: { prompt_tokens: 30, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 }, prompt_tokens_details: { cached_tokens: 10 } } }];
      for (const packet of packets) res.write(`data: ${JSON.stringify(packet)}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (options.barrier && wire.length < options.barrier) held.push(reply);
    else { for (const release of held.splice(0)) release(); reply(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const chosen = options.selection ?? selection;
  const gateway = createControllerModelGateway({ approval: 'offline', provider: chosen.provider, upstreamBaseUrl: `http://127.0.0.1:${address.port}`, api: options.api ?? 'openai-completions', models: [options.model ?? { id: chosen.model, maxTokens: 32768, contextWindow: 131072 }], credential: { accountId: 'fixture-owner', version: '1', secret: 'fixture-only-secret-not-a-provider-key' }, requireSpendGate: true });
  await gateway.listen();
  const durable = journal();
  const ledger = new ModelSpendBudget({ maxTokens: options.limits ?? 100000, maxCostUsd: 10 }, { runId: 'fixture-run', journal: durable, freshRun: true, prices });
  const ceiling = options.ceiling ?? 100;
  const reservation = ledger.reserve({ attemptId: 'fixture-attempt', selection: chosen, inputTokensUpperBound: 100, maxOutputTokens: ceiling, reservationId: 'fixture-reservation' });
  const denied: string[] = [];
  const failed: string[] = [];
  const placeholder = gateway.bindAttempt({ attemptId: 'fixture-attempt', requested: chosen, ...(options.receiptFile ? { receiptFile: options.receiptFile } : {}) });
  gateway.bindSpendGate({ attemptId: 'fixture-attempt', gate: createTurnSpendGate({ ledger, reservationId: reservation.reservationId, attemptId: 'fixture-attempt', selection: chosen, maxOutputTokens: ceiling, onDenied: v => denied.push(v.reason), onChargeFailed: v => failed.push(v.reason) }) });
  return { wire, gateway, durable, ledger, reservation, denied, failed, async send(body: Record<string, unknown>, route = '/chat/completions') {
    const original = JSON.stringify({ model: chosen.model, stream: true, messages: [{ role: 'user', content: 'test' }], ...body });
    const response = await fetch(`${gateway.url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${placeholder}`, 'content-type': 'application/json' }, body: original });
    const text = await response.text();
    return { status: response.status, text, original };
  }, async close() { await gateway.close(); await new Promise<void>(r => server.close(() => r())); } };
}

test('DeepSeek max reasoning request has actual recorded wire ceiling 4096, not worker 32768', async () => {
  const f = await fixture({ ceiling: 4096, selection: { provider: 'deepseek', model: 'deepseek-flash', thinking: 'max' }, model: { id: 'deepseek-flash', reasoning: true, maxTokens: 32768, contextWindow: 131072, thinkingLevelMap: { max: 'max' } } });
  try {
    const response = await f.send({ max_tokens: 32768, max_completion_tokens: 999999, max_output_tokens: 999999, reasoning_effort: 'max', n: 9 });
    assert.equal(response.status, 200);
    const transmitted = JSON.parse(f.wire[0]!.toString());
    assert.equal(transmitted.max_tokens, 4096);
    assert.equal(transmitted.max_completion_tokens, undefined);
    assert.equal(transmitted.max_output_tokens, undefined);
    assert.equal(transmitted.reasoning_effort, 'max');
    assert.equal(transmitted.n, 1);
    const attestation = f.gateway.attestations()[0]!;
    assert.equal(attestation.request.digest, sha(`POST /chat/completions\0${sha(response.original)}`));
    assert.equal(attestation.request.effective!.digest, sha(`POST /chat/completions\0${sha(f.wire[0]!)}`));
    assert.notEqual(attestation.request.digest, attestation.request.effective!.digest);
    assert.equal(attestation.request.effective!.bytes, f.wire[0]!.length);
    assert.equal(attestation.request.effective!.maxOutputTokens, 4096);
    assert.match(attestation.request.effective!.inputEstimationPolicy, /estimate-not-tokenizer/);
    assert.equal(f.ledger.snapshot().committed.tokens, 50, 'reasoning and cache subsets not double counted');
  } finally { await f.close(); }
});

test('every API has a supervisor-selected wire dialect and bounded reasoning budget', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const) {
    const thinking = api === 'anthropic-messages' ? { thinking: { type: 'enabled', budget_tokens: 16000 } } : api === 'google-generative-ai' ? { generationConfig: { maxOutputTokens: 99999, candidateCount: 8, thinkingConfig: { thinkingBudget: 16000 } } } : {};
    const chosen: RuntimeSelection = { ...selection, thinking: Object.keys(thinking).length ? 'max' : 'off' };
    const f = await fixture({ api, ceiling: 4096, selection: chosen, model: { id: 'model', maxTokens: 32768, contextWindow: 131072, completionTokenField: 'max_completion_tokens', thinkingLevelMap: { max: '16000' } } });
    try {
      const route = api === 'openai-responses' ? '/responses' : api === 'anthropic-messages' ? '/messages' : api === 'google-generative-ai' ? '/models/model:streamGenerateContent' : '/chat/completions';
      const response = await f.send({ max_tokens: 99999, max_completion_tokens: 99999, max_output_tokens: 99999, ...thinking }, route);
      assert.equal(response.status, 200, response.text);
      const wire = JSON.parse(f.wire[0]!.toString());
      if (api === 'openai-completions') assert.equal(wire.max_completion_tokens, 4096);
      else if (api === 'openai-responses') assert.equal(wire.max_output_tokens, 4096);
      else if (api === 'anthropic-messages') { assert.equal(wire.max_tokens, 4096); assert.equal(wire.thinking.budget_tokens, 4095); }
      else { assert.equal(wire.generationConfig.maxOutputTokens + wire.generationConfig.thinkingConfig.thinkingBudget, 4096); assert.equal(wire.generationConfig.candidateCount, 1); }
      assert.equal(f.gateway.attestations()[0]!.matchesRequest, true, 'original model/thinking policy still attested');
    } finally { await f.close(); }
  }
});

test('model/context invalid bounds and changed thinking fail before the upstream', async () => {
  assert.throws(() => clampModelRequest('anthropic-messages', { thinking: { type: 'enabled', budget_tokens: 16000 } }, { id: 'model', maxTokens: 16000, contextWindow: 32768 }, 1024), /minimum thinking/);
  assert.throws(() => clampModelRequest('openai-completions', {}, { id: 'model', maxTokens: 100, contextWindow: 1024 }, 101), /model maximum/);
  assert.throws(() => clampModelRequest('openai-completions', {}, { id: 'model' }, 100), /explicit completion and context/);
  for (const options of [{ ceiling: 101, model: { id: 'model', maxTokens: 100, contextWindow: 1024 } }, { ceiling: 100, model: { id: 'model', maxTokens: 100, contextWindow: 200 } }]) {
    const f = await fixture(options);
    try { const r = await f.send({ max_tokens: 100000 }); assert.equal(r.status, 403); assert.equal(f.wire.length, 0); assert.equal(f.denied.length, 1); assert.equal(f.gateway.attestations()[0]!.spend!.outcome, 'denied'); } finally { await f.close(); }
  }
  const f = await fixture();
  try { const r = await f.send({ reasoning_effort: 'max' }); assert.equal(r.status, 403); assert.match(r.text, /GATEWAY_THINKING_DENIED/); assert.equal(f.wire.length, 0); } finally { await f.close(); }
});

test('Anthropic split cumulative stream includes disjoint cache input without repeating counters', async () => {
  const f = await fixture({ api: 'anthropic-messages', packets: [{ message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } }, { usage: { output_tokens: 3 } }, { usage: { output_tokens: 8 } }] });
  try { await f.send({}, '/messages'); assert.deepEqual(f.ledger.snapshot().committed, { tokens: 43, costUsd: .000225 }); } finally { await f.close(); }
});

test('Google prompt cache subset and additive thoughts are normalized once', async () => {
  const f = await fixture({ api: 'google-generative-ai', packets: [{ usageMetadata: { promptTokenCount: 30, cachedContentTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 15 } }] });
  try { await f.send({}, '/models/model:streamGenerateContent'); assert.equal(f.ledger.snapshot().committed.tokens, 50); } finally { await f.close(); }
});

test('missing, partial, and malformed streamed usage charge exact admitted worst case', async () => {
  for (const packets of [[{}], [{ usage: { prompt_tokens: 10 } }], [{ usage: { prompt_tokens: 10, completion_tokens: -1 } }]]) {
    const f = await fixture({ packets });
    try { await f.send({}); const charge = f.gateway.attestations()[0]!.spend!; assert.equal(charge.outcome, 'assumed-worst-case'); assert.equal(f.ledger.snapshot().committed.tokens, f.wire[0]!.length + 100); } finally { await f.close(); }
  }
});

test('measured 25425 output overshoot is charged durably and cannot masquerade as completion', async () => {
  const f = await fixture({ ceiling: 4096, packets: [{ usage: { prompt_tokens: 10, completion_tokens: 25425, completion_tokens_details: { reasoning_tokens: 25000 } } }] });
  try {
    await f.send({ max_tokens: 32768 });
    assert.equal(JSON.parse(f.wire[0]!.toString()).max_tokens, 4096);
    assert.equal(f.ledger.snapshot().committed.tokens, 25435);
    assert.equal(f.ledger.snapshot().overshoot.tokens, 25425 - 4096);
    assert.equal(f.denied.length, 1, 'runtime gets mandatory partial notification');
    assert.equal(f.gateway.attestations()[0]!.spend!.reason, 'measured-wire-ceiling-overshoot');
    const next = await f.send({});
    assert.equal(next.status, 403);
    assert.match(next.text, /ATTEMPT_BUDGET_CLOSED/);
    assert.equal(f.wire.length, 1);
  } finally { await f.close(); }
});

test('concurrent recorded turns have distinct durable ids and receipt appends', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2o-wire-test-'));
  const receiptFile = path.join(root, 'gateway.json');
  const f = await fixture({ barrier: 2, receiptFile });
  try {
    const replies = await Promise.all([f.send({}), f.send({})]);
    assert.deepEqual(replies.map(r => r.status), [200, 200]);
    const state = f.durable.load()!;
    assert.equal(Object.keys(state.settlements).length, 2);
    assert.equal(state.committed.tokens, 100);
    const receipts = JSON.parse(await readFile(receiptFile, 'utf8')) as Array<{ spend: { turnId: string } }>;
    assert.equal(receipts.length, 2);
    assert.equal(new Set(receipts.map(r => r.spend.turnId)).size, 2);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('finite prelaunch allocation protects verifier/report and insufficient owner limits yield explicit partial', () => {
  const phase = { selection, inputTokensUpperBound: 100, maxOutputTokens: 100, maxTurns: 2 };
  const requests = { planner: phase, workers: phase, verifier: phase, report: phase };
  const partial = planAutonomousModelBudget({ maxTokens: 1599, maxCostUsd: 1 }, requests, prices);
  assert.equal(partial.outcome, 'partial');
  if (partial.outcome !== 'partial') throw new Error('partial required');
  assert.equal(partial.launchAllowed, false);
  assert.equal(partial.shortfall.maxTokens, 1);
  assert.equal(partial.reason, 'budget-extension-required');
  assert.throws(() => createAutonomousPhaseBudgets(partial, { runId: 'run' }), /requires owner extension/);
  const plan = planAutonomousModelBudget({ maxTokens: 1600, maxCostUsd: .0144 }, requests, prices);
  assert.equal(plan.outcome, 'ready');
  const pool = createAutonomousPhaseBudgets(plan, { runId: 'run' });
  const hold = pool.workers.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 });
  const turn = { attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100, reservationId: hold.reservationId };
  pool.workers.admitTurn(turn).charge({ inputTokens: 1, outputTokens: 1 });
  pool.workers.admitTurn(turn).charge({ inputTokens: 1, outputTokens: 1 });
  assert.throws(() => pool.workers.admitTurn(turn), /Finite phase/);
  assert.equal(pool.verifier.snapshot().remaining.tokens, 400);
  assert.equal(pool.report.snapshot().remaining.tokens, 400);
  assert.equal(pool.planner.snapshot().remaining.tokens, 400);
  assert.throws(() => pool.workers.reserve({ attemptId: 'other', selection, inputTokensUpperBound: 500, maxOutputTokens: 1 }), /worst-case/);
  assert.equal(pool.verifier.reserve({ attemptId: 'verifier', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 }).reservedTokens, 200);
});

test('restart preserves unknown turn bounds and requires real termination evidence before worst-case settlement', () => {
  const j = journal();
  const limits = { maxTokens: 1000, maxCostUsd: 1 };
  const first = new ModelSpendBudget(limits, { runId: 'run', journal: j, freshRun: true, prices, maxTurns: 2 });
  const hold = first.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100, reservationId: 'hold' });
  first.admitTurn({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100, reservationId: hold.reservationId });
  const resumed = new ModelSpendBudget(limits, { runId: 'run', journal: j, prices, maxTurns: 2 });
  assert.equal(resumed.snapshot().active.tokens, 200);
  assert.throws(() => resumed.release('hold'), /Unobserved admitted/);
  assert.throws(() => resumed.reconcileTerminal('hold', { terminationVerified: false as never, reference: 'not-proof' }), /Verified termination/);
  resumed.reconcileTerminal('hold', { terminationVerified: true, reference: 'independently-verified-process-exit' });
  assert.equal(resumed.snapshot().committed.tokens, 200);
  assert.equal(resumed.attemptUsage('hold').assumedTurns, 1);
  resumed.release('hold');
  const third = new ModelSpendBudget(limits, { runId: 'run', journal: j, prices, maxTurns: 2 });
  const next = third.reserve({ attemptId: 'next', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 });
  const request = { attemptId: 'next', selection, inputTokensUpperBound: 100, maxOutputTokens: 100, reservationId: next.reservationId };
  third.admitTurn(request).charge({ inputTokens: 1, outputTokens: 1 });
  assert.throws(() => third.admitTurn(request), /Finite phase/);
  assert.throws(() => new ModelSpendBudget(limits, { runId: 'run', journal: j, prices, maxTurns: 3 }), /identity mismatch/);
});

test('failed admission/charge commit never dispatches or erases the durable worst-case hold', async () => {
  const f = await fixture();
  try {
    f.durable.fault();
    const refused = await f.send({});
    assert.equal(refused.status, 403);
    assert.equal(f.wire.length, 0);
    assert.equal(f.denied.length, 1);
    assert.equal(Object.keys(f.durable.load()!.settlements).length, 0);
    assert.equal(f.gateway.attestations()[0]!.spend!.outcome, 'denied');
  } finally { await f.close(); }
  const j = journal();
  const budget = new ModelSpendBudget({ maxTokens: 1000, maxCostUsd: 1 }, { runId: 'run', journal: j, freshRun: true, prices });
  const hold = budget.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 });
  const turn = budget.admitTurn({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100, reservationId: hold.reservationId });
  j.fault();
  assert.throws(() => turn.charge({ inputTokens: 10, outputTokens: 20 }), /persistence failed/);
  assert.equal(j.load()!.reservations[hold.reservationId]!.openTurns, 1);
  assert.throws(() => hold.release(), /retained for reconciliation/);
  budget.reconcileTerminal(hold.reservationId, { terminationVerified: true, reference: 'fixture-verified-exit', usage: { inputTokens: 10, outputTokens: 20 }, completeUsageVerified: true });
  hold.release();
  assert.equal(budget.snapshot().committed.tokens, 30);
});

test('Pi provider usage counts disjoint caches and does not add reasoning to output again', () => {
  const budget = new ModelSpendBudget({ maxTokens: 1000, maxCostUsd: 1 }, { runId: 'run', prices });
  const hold = budget.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 });
  const result = hold.settle({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 15, totalTokens: 100 });
  assert.equal(result.inputTokens, 80);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.tokens, 100);
});

test('transport failure after a transmitted body is uncertain paid work, not a free abandoned turn', async () => {
  const f = await fixture({ abort: true });
  try {
    const response = await f.send({});
    assert.equal(response.status, 502);
    assert.equal(f.wire.length, 1);
    const attestation = f.gateway.attestations()[0]!;
    assert.equal(attestation.spend!.outcome, 'assumed-worst-case');
    assert.equal(attestation.spend!.reason, 'upstream-request-outcome-unknown');
    assert.equal(f.ledger.snapshot().committed.tokens, f.wire[0]!.length + 100);
    assert.equal(f.ledger.exportState().reservations[f.reservation.reservationId]!.openTurns, 0);
  } finally { await f.close(); }
});

test('receipt persistence failure after charging closes the worker response and reports failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2o-receipt-fault-'));
  const f = await fixture({ receiptFile: path.join(root, 'gateway.json'), beforeReply: () => rm(root, { recursive: true, force: true }) });
  try {
    await assert.rejects(f.send({}));
    assert.equal(f.wire.length, 1);
    assert.equal(f.ledger.snapshot().committed.tokens, 50, 'actual paid usage stays durably charged');
    assert.equal(f.failed.length, 1, 'a durable-charge success cannot mask failed audit persistence');
    const response = await f.send({});
    assert.equal(response.status, 502, 'a failed mandatory receipt must never enable another provider turn');
    assert.equal(f.wire.length, 1);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('observed cost above pinned quote consumes headroom and cumulative receipts never add it twice', () => {
  const budget = new ModelSpendBudget({ maxTokens: 1000, maxCostUsd: 1 }, { runId: 'run', prices });
  const hold = budget.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 });
  budget.admitTurn({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100, reservationId: hold.reservationId }).charge({ inputTokens: 10, outputTokens: 10, reportedCostUsd: .5 });
  assert.equal(budget.snapshot().accountedCostUsd, .5);
  assert.equal(budget.snapshot().observedCostUsd, .5);
  assert.equal(budget.snapshot().costPolicy, 'pinned-cache-miss-price');
  assert.ok(budget.snapshot().remaining.costUsd! < .5);
  assert.equal(budget.catchUp({ attemptId: 'worker', selection, reservationId: hold.reservationId, usage: { inputTokens: 10, outputTokens: 10, reportedCostUsd: .5 } }), undefined);
  assert.equal(budget.snapshot().accountedCostUsd, .5);
  assert.throws(() => budget.admitTurn({ attemptId: 'worker', selection, inputTokensUpperBound: 1, maxOutputTokens: 1, reservationId: hold.reservationId }), /overshoot/);
});

test('owner cost caps round down and observed usage costs round up, never extending fractional consent', () => {
  const budget = new ModelSpendBudget({ maxTokens: 1000, maxCostUsd: .0000009 }, { runId: 'run', prices });
  assert.equal(budget.snapshot().limits.maxCostUsd, 0);
  assert.throws(() => budget.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 1, maxOutputTokens: 1 }), /cost budget/);
  const zeroPrice = pinnedModelPrices({ 'fixture/model': { input: 0, output: 0 } });
  const observed = new ModelSpendBudget({ maxTokens: 1000, maxCostUsd: 1 }, { runId: 'observed-run', prices: zeroPrice });
  observed.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 }).settle({ inputTokens: 1, outputTokens: 1, reportedCostUsd: .0000001 });
  assert.equal(observed.snapshot().observedCostUsd, .000001);
});

test('phase-wide pool blocks every paid phase after measured overshoot rather than borrowing verifier reserve', () => {
  const phase = { selection, inputTokensUpperBound: 100, maxOutputTokens: 100, maxTurns: 2 };
  const plan = planAutonomousModelBudget({ maxTokens: 1600, maxCostUsd: 1 }, { planner: phase, workers: phase, verifier: phase, report: phase }, prices);
  const pool = createAutonomousPhaseBudgets(plan, { runId: 'pool-run' });
  const held = pool.workers.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 });
  pool.workers.admitTurn({ reservationId: held.reservationId, attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 }).charge({ inputTokens: 1, outputTokens: 150 });
  assert.throws(() => pool.verifier.reserve({ attemptId: 'verifier', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 }), /blocks all phase dispatch/);
  assert.equal(pool.verifier.snapshot().remaining.tokens, 400);
  assert.equal(pool.verifier.snapshot().active.count, 0);
  assert.equal(pool.report.snapshot().remaining.tokens, 400);
});

test('terminal reconciliation seals admission and retains live gateway holds until a real settlement', () => {
  const budget = new ModelSpendBudget({ maxTokens: 1000, maxCostUsd: 1 }, { runId: 'run', prices });
  const held = budget.reserve({ attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 });
  const request = { reservationId: held.reservationId, attemptId: 'worker', selection, inputTokensUpperBound: 100, maxOutputTokens: 100 };
  const turn = budget.admitTurn(request);
  assert.throws(() => budget.reconcileTerminal(held.reservationId, { terminationVerified: true, reference: 'local-process-exit-only' }), /provider turns are still live/);
  assert.equal(budget.snapshot().active.tokens, 200);
  assert.equal(budget.snapshot().committed.tokens, 0);
  assert.throws(() => budget.admitTurn(request), /sealed/);
  turn.charge({ inputTokens: 10, outputTokens: 20 });
  budget.reconcileTerminal(held.reservationId, { terminationVerified: true, reference: 'gateway-settlement-and-process-exit' });
  held.release();
  assert.equal(budget.snapshot().committed.tokens, 30, 'the measured late gateway settlement takes precedence over an early terminal assumption');
});
