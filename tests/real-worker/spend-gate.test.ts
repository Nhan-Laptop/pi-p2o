// [T9] Faithful gateway-level witness for per-turn spend admission at the single egress.
//
// This drives the REAL controller-owned model gateway (`src/runtime/config.ts`) with the REAL supervisor gate
// (`createTurnSpendGate` from `src/runtime/managed.ts`) and the REAL durable ledger (`src/policy/budget.ts`),
// against a loopback OpenAI-completions fixture that reports scripted usage. Nothing here is a model, no
// network is contacted and no credential leaves the process:
//
//   test client --(placeholder)--> controller gateway --(injected secret)--> loopback fixture
//
// It proves, deterministically and without a worker process: (1) a turn whose payload-derived worst case no
// longer fits the run budget is refused with GATEWAY_BUDGET_DENIED and issues zero upstream requests, while
// earlier turns are durably charged per turn; (2) every charge is durable before the client can observe the
// response end; (3) a response without readable usage is charged as the admitted worst case and recorded as
// an explicit assumption instead of being skipped.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createControllerModelGateway,
  clampModelRequest,
  type ControllerModelGateway, type GatewaySpendGate, type GatewayTurnCharge, type GatewayTurnPermit, type GatewayTurnUsage,
} from '../../src/runtime/config.js';
import { createTurnSpendGate } from '../../src/runtime/managed.js';
import {
  ModelSpendBudget, pinnedModelPrices, type ModelSpendState, type ModelSpendTurn, type ModelSpendTurnCharge,
} from '../../src/policy/index.js';

const RUN = 'run-spend-gate';
const ATTEMPT = 'attempt-spend-gate';
const RESERVATION = `model-spend-${ATTEMPT}`;
const PROVIDER = 'gateway-fixture';
const MODEL = 'gateway-fixture-model';
/** The supervisor-declared completion bound for every turn of the witness. */
const DECLARED_OUTPUT = 100;
/** The model must be priced so the ledger can bound the turn; a zero quote keeps the arithmetic about tokens. */
const PRICES = pinnedModelPrices({ [`${PROVIDER}/${MODEL}`]: { input: 0, output: 0 } });
const SELECTION = { provider: PROVIDER, model: MODEL, thinking: 'off' as const };
const UPSTREAM_SECRET = 'sk-t9-gateway-fixture-credential-0123456789';

interface FixtureTurn { bytes: number; body: string }
interface Fixture {
  origin: string;
  turns: FixtureTurn[];
  close(): Promise<void>;
}

/** Loopback OpenAI chat-completions fixture: scripted usage, or no usage at all for the given turns. */
async function startFixture(options: {
  usage: (turn: number, bytes: number) => { prompt_tokens: number; completion_tokens: number } | undefined;
  /** [T10] Hold every response until this many requests have arrived, so the turns genuinely overlap. */
  barrier?: number;
}): Promise<Fixture> {
  const turns: FixtureTurn[] = [];
  const held: Array<() => void> = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const turn = turns.length + 1;
      turns.push({ bytes: Buffer.byteLength(body, 'utf8'), body });
      const respond = (): void => {
        const usage = options.usage(turn, turns[turn - 1]!.bytes);
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
        response.write(`data: ${JSON.stringify({ id: `chunk-${turn}`, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: `chunk-${turn}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        if (usage) response.write(`data: ${JSON.stringify({ id: `chunk-${turn}`, choices: [], usage })}\n\n`);
        response.write('data: [DONE]\n\n');
        response.end();
      };
      // [T10] A barrier keeps the admitted turns in flight: the charges can only happen after every request
      // the run budget admits has already been admitted.
      if (options.barrier !== undefined && turns.length < options.barrier) { held.push(respond); return; }
      if (options.barrier !== undefined && turns.length === options.barrier) for (const release of held.splice(0)) release();
      respond();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    turns,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

/** In-memory durable journal, exactly the port the composition supplies from the store. */
function memoryJournal(options: { faultOnSettlement?: boolean } = {}) {
  let saved: ModelSpendState | undefined;
  let faults = 0;
  return {
    state: () => saved,
    faults: () => faults,
    journal: {
      load: () => (saved === undefined ? undefined : structuredClone(saved)),
      save: (state: Readonly<ModelSpendState>) => {
        // [T10] One-shot failure: the first state carrying a settlement is exactly the completion charge.
        if (options.faultOnSettlement === true && faults === 0 && Object.keys(state.settlements).length > 0) { faults += 1; throw new Error('fixture journal unavailable'); }
        saved = structuredClone(state) as ModelSpendState;
      },
    },
  };
}

/** One provider request through the real gateway, exactly as a worker would issue it. */
/** The exact payload every witness request sends; [T10] admission bounds are derived from these real bytes. */
const requestBody = (payloadBytes: number): string => JSON.stringify({
  model: MODEL, stream: true, stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'x'.repeat(Math.max(1, payloadBytes - 200)) }],
});

async function request(gateway: ControllerModelGateway, placeholder: string, payloadBytes: number): Promise<{ status: number; body: string }> {
  const body = requestBody(payloadBytes);
  const response = await fetch(`${gateway.url}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${placeholder}`, 'content-type': 'application/json' },
    body,
  });
  return { status: response.status, body: await response.text() };
}

/** Run one witness against the real gateway, the real gate factory and a durable (in-memory) ledger. */
async function withGateway(
  fixture: Fixture,
  limits: { maxTokens: number; maxCostUsd: number } | { mode: 'accounting-only' },
  body: (context: { gateway: ControllerModelGateway; journal: ReturnType<typeof memoryJournal>; ledger: ModelSpendBudget; placeholder: string }) => Promise<void>,
  options: {
    /** [T10] One-shot journal failure on the first state carrying a settlement. */
    faultOnSettlement?: boolean;
    contextWindow?: number;
    nativeMaxTokens?: number;
    launchOutputTokens?: number;
    /** [T10] Replace the production gate (e.g. to inject a duplicate-producing permit or a failure sink). */
    gate?: (context: { ledger: ModelSpendBudget; reservationId: string }) => GatewaySpendGate;
  } = {},
): Promise<void> {
  const gateway = createControllerModelGateway({
    approval: 't9-loopback-gateway-witness',
    provider: PROVIDER,
    upstreamBaseUrl: fixture.origin,
    api: 'openai-completions',
    models: [{ id: MODEL, maxTokens: options.nativeMaxTokens ?? 4096, contextWindow: options.contextWindow ?? 131072 }],
    credential: { accountId: 't9-fixture-owner', version: 'v1', secret: UPSTREAM_SECRET },
  });
  await gateway.listen();
  const journal = memoryJournal(options.faultOnSettlement === true ? { faultOnSettlement: true } : {});
  const ledger = new ModelSpendBudget(limits, { runId: RUN, freshRun: true, journal: journal.journal, prices: PRICES });
  ledger.bindRun(RUN, limits);
  const placeholder = gateway.bindAttempt({ attemptId: ATTEMPT, requested: SELECTION });
  ledger.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 200, maxOutputTokens: options.launchOutputTokens ?? DECLARED_OUTPUT, reservationId: RESERVATION });
  gateway.bindSpendGate({
    attemptId: ATTEMPT,
    gate: options.gate?.( { ledger, reservationId: RESERVATION }) ?? createTurnSpendGate({ ledger, reservationId: RESERVATION, attemptId: ATTEMPT, selection: SELECTION, maxOutputTokens: DECLARED_OUTPUT }),
  });
  try {
    await body({ gateway, journal, ledger, placeholder });
  } finally {
    await gateway.close();
  }
}

test('review repro: effective 558 versus initial 1200 with observed 600 notifies native failure even below total allowance', async t => {
  const fixture = await startFixture({ usage: () => ({ prompt_tokens: 100, completion_tokens: 600 }) });
  const failures: Array<{ reason: string; kind?: string; maxOutputTokens?: number; observedOutputTokens?: number }> = [];
  const native = { id: MODEL, maxTokens: 1200, contextWindow: 1400 };
  const baseBytes = Buffer.byteLength(JSON.stringify(clampModelRequest('openai-completions', JSON.parse(requestBody(200)), native, 558)));
  try {
    await withGateway(fixture, { mode: 'accounting-only' }, async ({ gateway, journal, ledger, placeholder }) => {
      const result = await request(gateway, placeholder, 201 + 842 - baseBytes);
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(fixture.turns[0]!.body).max_tokens, 558);
      assert.equal(failures.length, 1, 'runtime must be notified although 600 < initial1200 and 100+600 < 1400');
      assert.equal(failures[0]!.kind, 'native-output-bound');
      assert.equal(failures[0]!.maxOutputTokens, 558);
      assert.equal(failures[0]!.observedOutputTokens, 600);
      assert.match(failures[0]!.reason, /not monetary exhaustion/);
      assert.equal(ledger.snapshot().committed.tokens, 700, 'measured usage is still charged truthfully');
      assert.equal(ledger.snapshot().overshoot.tokens, 42);
      assert.deepEqual(ledger.snapshot().breach, { tokens: 0, costUsd: 0 });
      assert.equal(gateway.attestations()[0]!.spend?.reasonCode, 'MODEL_NATIVE_BOUND_EXCEEDED');
      const closed = await request(gateway, placeholder, 500);
      assert.equal(closed.status, 403);
      assert.match(closed.body, /GATEWAY_MODEL_BOUND_DENIED/);
      assert.doesNotMatch(closed.body, /BUDGET_EXCEEDED/);
      assert.equal(fixture.turns.length, 1);
      assert.equal(Object.values(journal.state()!.settlements)[0]!.outputTokens, 600);
      t.diagnostic('initial=1200 effective=558 observedOutput=600 observedTotal=700 admittedTotal=1400 nativeOvershoot=42 callbacks=1 monetaryBreach=0 nextRequest=native-bound-denied');
    }, { contextWindow: 1400, nativeMaxTokens: 1200, launchOutputTokens: 1200,
      gate: ({ ledger, reservationId }) => createTurnSpendGate({ ledger, reservationId, attemptId: ATTEMPT, selection: SELECTION, maxOutputTokens: 1200, accountingOnly: true, onDenied: input => { failures.push(input); } }) });
  } finally { await fixture.close(); }
});

test('informational measured input above JSON estimate is accounted, not treated as monetary exhaustion', () => {
  const ledger = new ModelSpendBudget({ mode: 'accounting-only' }, { runId: RUN, prices: PRICES });
  ledger.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 842, maxOutputTokens: 1200, reservationId: RESERVATION });
  const failures: unknown[] = [];
  const gate = createTurnSpendGate({ ledger, reservationId: RESERVATION, attemptId: ATTEMPT, selection: SELECTION, maxOutputTokens: 1200, accountingOnly: true, onDenied: input => { failures.push(input); } });
  gate.admit({ bytes: 842, path: '/chat/completions', maxOutputTokens: 558 }).settle({ inputTokens: 3000, outputTokens: 500 });
  assert.equal(failures.length, 0);
  assert.equal(ledger.snapshot().committed.tokens, 3500);
  assert.deepEqual(ledger.snapshot().breach, { tokens: 0, costUsd: 0 });
  assert.equal(ledger.snapshot().overshoot.tokens, 0);
});

test('actual wire admission is mandatory only for informational turns; legacy reservations stay immutable', () => {
  for (const accountingOnly of [true, false]) {
    const journal = memoryJournal();
    const policy = accountingOnly ? { mode: 'accounting-only' as const } : { maxTokens: 10_000, maxCostUsd: 1 };
    const ledger = new ModelSpendBudget(policy, { runId: RUN, freshRun: true, journal: journal.journal, prices: PRICES });
    ledger.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 842, maxOutputTokens: 1200, reservationId: RESERVATION });
    const gate = createTurnSpendGate({ ledger, reservationId: RESERVATION, attemptId: ATTEMPT, selection: SELECTION, maxOutputTokens: 1200, accountingOnly });
    if (accountingOnly) {
      const before = journal.state();
      assert.throws(() => gate.admit({ bytes: 842, path: '/chat/completions' }), /Actual wire completion ceiling is required/);
      assert.deepEqual(journal.state(), before, 'missing actual ceiling cannot create a stale launch-bound reservation');
    }
    gate.admit({ bytes: 842, path: '/chat/completions', maxOutputTokens: 558 }).unobserved('fixture-no-usage');
    const settlement = Object.values(journal.state()!.settlements)[0]!;
    assert.equal(settlement.outputTokens, accountingOnly ? 558 : 1200);
    assert.equal(settlement.tokens, accountingOnly ? 1400 : 2042);
  }
});

test('review repro: wire output 558, not initial 1200, is durably admitted and assumed when usage is absent', async t => {
  let admission: ModelSpendState | undefined;
  let readState: () => ModelSpendState | undefined = () => undefined;
  const fixture = await startFixture({ usage: () => { admission = readState(); return undefined; } });
  const native = { id: MODEL, maxTokens: 1200, contextWindow: 1400 };
  const baseBytes = Buffer.byteLength(JSON.stringify(clampModelRequest('openai-completions', JSON.parse(requestBody(200)), native, 558)));
  const payloadBytes = 201 + 842 - baseBytes;
  try {
    await withGateway(fixture, { mode: 'accounting-only' }, async ({ gateway, journal, ledger, placeholder }) => {
      readState = journal.state;
      const result = await request(gateway, placeholder, payloadBytes);
      assert.equal(result.status, 200, result.body);
      const wire = fixture.turns[0]!;
      assert.equal(wire.bytes, 842);
      assert.equal(JSON.parse(wire.body).max_tokens, 558);
      const hold = Object.values(admission!.reservations[RESERVATION]!.turnHolds!)[0]!;
      assert.deepEqual(hold, { inputTokens: 842, outputTokens: 558 }, 'actual wire bounds are durable before upstream dispatch');
      const state = journal.state()!;
      const settlement = Object.values(state.settlements)[0]!;
      assert.equal(settlement.inputTokens, 842);
      assert.equal(settlement.outputTokens, 558, 'unknown usage must not charge the initial 1200 ceiling');
      assert.equal(settlement.tokens, 1400);
      assert.match(settlement.basis!, /assumed-worst-case/);
      assert.equal(ledger.snapshot().overshoot.tokens, 0);
      const reopened = new ModelSpendBudget({ mode: 'accounting-only' }, { runId: RUN, journal: journal.journal, prices: PRICES });
      assert.deepEqual(reopened.snapshot(), ledger.snapshot());
      t.diagnostic(`wireInput=${wire.bytes} wireOutput=${JSON.parse(wire.body).max_tokens} assumedInput=${settlement.inputTokens} assumedOutput=${settlement.outputTokens} total=${settlement.tokens} initialCeiling=1200 restart=preserved`);
    }, { contextWindow: 1400, nativeMaxTokens: 1200, launchOutputTokens: 1200, gate: ({ ledger, reservationId }) => createTurnSpendGate({ ledger, reservationId, attemptId: ATTEMPT, selection: SELECTION, maxOutputTokens: 1200, accountingOnly: true }) });
  } finally { await fixture.close(); }
});

test('informational turns use actual-input native completion capacity and charge that exact wire bound', async () => {
  const fixture = await startFixture({ usage: () => undefined });
  try {
    await withGateway(fixture, { mode: 'accounting-only' }, async ({ gateway, ledger, placeholder }) => {
      for (const bytes of [600, 3_000, 500]) {
        const result = await request(gateway, placeholder, bytes);
        assert.equal(result.status, 200, result.body);
        const wire = fixture.turns.at(-1)!;
        const effective = gateway.attestations().at(-1)!.request.effective!;
        assert.equal(JSON.parse(wire.body).max_tokens, effective.maxOutputTokens);
        assert.ok(wire.bytes + effective.maxOutputTokens <= 4096);
        assert.ok(effective.maxOutputTokens > DECLARED_OUTPUT, 'launch ceiling must not constrain informational turns');
      }
      const ceilings = gateway.attestations().map(a => a.request.effective!.maxOutputTokens);
      assert.ok(ceilings[1]! < ceilings[0]! && ceilings[2]! > ceilings[1]!);
      assert.equal(ledger.snapshot().committed.tokens, fixture.turns.reduce((n, turn, i) => n + turn.bytes + ceilings[i]!, 0));
      assert.equal(ledger.snapshot().overshoot.tokens, 0);
    }, { contextWindow: 4096, gate: ({ ledger, reservationId }) => createTurnSpendGate({ ledger, reservationId, attemptId: ATTEMPT, selection: SELECTION, maxOutputTokens: DECLARED_OUTPUT, accountingOnly: true }) });
  } finally { await fixture.close(); }
});

test('a turn that no longer fits the run budget is refused at the gateway with zero upstream requests', async () => {
  const fixture = await startFixture({ usage: turn => ({ prompt_tokens: 100 + turn, completion_tokens: 20 }) });
  // The attempt hold is 200 + 100. Each admitted turn must fit `committed + payload bytes + 100`.
  const limits = { maxTokens: 1_500, maxCostUsd: 1 };
  try {
    await withGateway(fixture, limits, async ({ gateway, journal, ledger, placeholder }) => {
      const first = await request(gateway, placeholder, 600);
      assert.equal(first.status, 200, first.body);
      // The charge is durable before the client can observe the response end.
      const afterFirst = journal.state()!;
      assert.equal(Object.keys(afterFirst.settlements).length, 1, 'the first turn must be charged before the response ends');
      assert.deepEqual(afterFirst.committed, { tokens: 121, costMicros: 0 }, 'the reported turn usage is charged');

      const second = await request(gateway, placeholder, 600);
      assert.equal(second.status, 200, second.body);
      const beforeRefusal = journal.state()!;
      assert.equal(Object.keys(beforeRefusal.settlements).length, 2, 'the second turn must be charged too');

      // The third turn is far larger than anything the remaining budget can cover.
      const refused = await request(gateway, placeholder, 4_000);
      assert.equal(refused.status, 403, `the refused turn must be denied before the provider: ${refused.body}`);
      assert.match(refused.body, /GATEWAY_BUDGET_DENIED/);
      assert.match(refused.body, /cannot cover the next provider turn's worst case/);
      assert.equal(fixture.turns.length, 2, 'the refused turn must issue zero upstream requests');
      assert.deepEqual(journal.state(), beforeRefusal, 'a refused turn must not modify the durable ledger');

      // The ledger arithmetic of every admission and of the single refusal, from the measured payloads.
      const attestations = gateway.attestations();
      assert.equal(attestations.length, 3, 'every exchange is attested, refusal included');
      const forwarded = attestations.filter(entry => entry.outcome === 'forwarded');
      assert.equal(forwarded.length, 2);
      const denial = attestations.at(-1)!;
      assert.equal(denial.outcome, 'denied');
      assert.equal(denial.denial?.code, 'GATEWAY_BUDGET_DENIED');
      assert.equal(denial.spend?.outcome, 'denied');
      assert.match(String(denial.spend?.reason), /cannot cover the next provider turn's worst case/);
      // Each admitted turn is charged the usage the fixture reported for it: `100 + turn` input, 20 output.
      const chargedPerTurn = forwarded.map((_entry, index) => 100 + (index + 1) + 20);
      assert.equal(beforeRefusal.committed.tokens, chargedPerTurn.reduce((sum, tokens) => sum + tokens, 0));
      let committed = 0;
      for (const [index, entry] of forwarded.entries()) {
        assert.ok(committed + entry.request.bytes + DECLARED_OUTPUT <= limits.maxTokens,
          `turn ${index + 1} was admitted only because its payload-derived worst case fit the remaining budget`);
        committed += chargedPerTurn[index]!;
      }
      assert.ok(committed + denial.request.bytes + DECLARED_OUTPUT > limits.maxTokens,
        'the refused turn could not fit the remaining headroom');
      assert.ok(ledger.snapshot().remaining.tokens! > 0, 'the refusal must leave the unspent budget visible');
      assert.equal(ledger.attemptUsage(RESERVATION, ATTEMPT).turns, 2, 'only the two forwarded turns were charged');
    });
  } finally {
    await fixture.close();
  }
});

test('every relayed response charges its own turn, and an unreadable usage is charged as the admitted worst case', async () => {
  // Turn 2 reports no usage at all: it must be charged its admitted worst case with an explicit basis.
  const fixture = await startFixture({ usage: turn => (turn === 2 ? undefined : { prompt_tokens: 40, completion_tokens: 10 }) });
  const limits = { maxTokens: 10_000, maxCostUsd: 1 };
  try {
    await withGateway(fixture, limits, async ({ gateway, journal, ledger, placeholder }) => {
      await request(gateway, placeholder, 500);
      await request(gateway, placeholder, 500);
      const state = journal.state()!;
      const settlements = Object.entries(state.settlements).sort((left, right) => left[0].localeCompare(right[0]));
      assert.equal(settlements.length, 2, 'both turns must be charged; none may be skipped');
      assert.equal(settlements[0]![1].basis, 'provider-usage');
      assert.equal(settlements[0]![1].tokens, 50);
      assert.equal(settlements[1]![1].basis, 'assumed-worst-case:provider-response-usage-absent');
      assert.equal(settlements[1]![1].tokens, fixture.turns[1]!.bytes + DECLARED_OUTPUT, 'the unreadable turn is charged its payload-derived worst case');
      assert.deepEqual(state.committed, { tokens: 50 + fixture.turns[1]!.bytes + DECLARED_OUTPUT, costMicros: 0 });
      assert.deepEqual(state.overshoot, { tokens: 0, costMicros: 0 });
      assert.equal(Object.keys(state.reservations).length, 1, 'the attempt hold stays active for the next turn');
      assert.equal(ledger.attemptUsage(RESERVATION, ATTEMPT).assumedTurns, 1);
      const attestations = gateway.attestations();
      assert.deepEqual(attestations.map(entry => entry.spend?.outcome), ['charged', 'assumed-worst-case']);
      assert.equal(attestations[1]!.spend?.inputTokens, fixture.turns[1]!.bytes);
    });
  } finally {
    await fixture.close();
  }
});

test('the gateway refuses every turn of an attempt whose hold was released and charges nothing', async () => {
  const fixture = await startFixture({ usage: () => ({ prompt_tokens: 10, completion_tokens: 5 }) });
  const limits = { maxTokens: 10_000, maxCostUsd: 1 };
  try {
    await withGateway(fixture, limits, async ({ gateway, journal, ledger, placeholder }) => {
      await request(gateway, placeholder, 500);
      const before = journal.state()!;
      // The attempt is finalized (failed): its hold is released and no further provider turn may be admitted.
      ledger.release(RESERVATION, 'failed:charged-turns=1');
      const refused = await request(gateway, placeholder, 500);
      assert.equal(refused.status, 403);
      assert.match(refused.body, /GATEWAY_BUDGET_DENIED/);
      assert.match(refused.body, /without the attempt hold/);
      assert.equal(fixture.turns.length, 1, 'a released attempt must not reach the provider again');
      assert.equal(journal.state()!.committed.tokens, before.committed.tokens, 'a refused turn never charges');
      assert.equal(journal.state()!.released[RESERVATION]!.reason, 'failed:charged-turns=1');
    });
  } finally {
    await fixture.close();
  }
});

// ---------------------------------------------------------------------------------------------
// [T10] R3 §6.1 — the falsification this revision closes. Overlapping provider turns must each be
// admitted against their own worst case, charged under their own identity, and refused *before* the
// provider once the run budget can no longer cover them.
// ---------------------------------------------------------------------------------------------

test('overlapping provider turns are admitted one by one, charged separately and refused before the provider (R3 §6.1)', async () => {
  // The run budget and the scripted usage are both derived from the exact payload, so each admitted turn's
  // charge equals the bound it was admitted under (no overshoot, no conservatism hidden by the fixture).
  const effectivePayload = JSON.stringify(clampModelRequest('openai-completions', JSON.parse(requestBody(600)), { id: MODEL, maxTokens: 4096, contextWindow: 131072 }, DECLARED_OUTPUT));
  const bound = Buffer.byteLength(effectivePayload, 'utf8') + DECLARED_OUTPUT;
  const fixture = await startFixture({ usage: (_turn, bytes) => ({ prompt_tokens: bytes, completion_tokens: DECLARED_OUTPUT }), barrier: 2 });
  const limits = { maxTokens: 2 * bound + 100, maxCostUsd: 1 };
  try {
    await withGateway(fixture, limits, async ({ gateway, journal, ledger, placeholder }) => {
      const responses = await Promise.all([
        request(gateway, placeholder, 600),
        request(gateway, placeholder, 600),
        request(gateway, placeholder, 600),
      ]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 403],
        `exactly k of N overlapping turns must be admitted: ${responses.map(response => `${response.status} ${response.body}`).join(' | ')}`);
      assert.equal(fixture.turns.length, 2, 'the refused overlap must issue zero upstream requests');
      const denied = responses.filter(response => response.status === 403);
      assert.equal(denied.length, 1);
      assert.match(denied[0]!.body, /GATEWAY_BUDGET_DENIED/);
      assert.match(denied[0]!.body, /cannot cover the next provider turn's worst case/);
      assert.match(denied[0]!.body, /\[BUDGET_EXCEEDED\]/, 'the outer refusal code stays stable while the policy cause is named');

      // Every admitted turn is charged exactly once, under its own monotonic identity.
      const state = journal.state()!;
      const turnCharges = Object.entries(state.settlements).sort((left, right) => left[0].localeCompare(right[0]));
      assert.deepEqual(turnCharges.map(([id]) => id), [`${RESERVATION}:turn-1`, `${RESERVATION}:turn-2`],
        'each admitted turn must have its own durable charge; no collapse onto one turn id');
      assert.deepEqual(turnCharges.map(([, record]) => ({ input: record.inputTokens, output: record.outputTokens })), [
        { input: bound - DECLARED_OUTPUT, output: DECLARED_OUTPUT }, { input: bound - DECLARED_OUTPUT, output: DECLARED_OUTPUT },
      ], 'each admitted turn is charged the usage the provider reported for that turn');
      assert.deepEqual(state.committed, { tokens: 2 * bound, costMicros: 0 }, 'both admitted turns are charged exactly once');
      assert.deepEqual(state.overshoot, { tokens: 0, costMicros: 0 }, 'the witness never exceeds an admitted bound');
      assert.ok(state.committed.tokens < limits.maxTokens, 'final committed spend stays below the declared limit');
      assert.equal(ledger.attemptUsage(RESERVATION, ATTEMPT).turns, 2);

      // The admission arithmetic is what bounded the burst: two worst cases fit, the third cannot.
      assert.ok(2 * bound <= limits.maxTokens, 'two admitted worst cases fit the run budget');
      assert.ok(3 * bound > limits.maxTokens, 'a third overlapping worst case cannot fit the run budget');
      assert.equal(fixture.turns[0]!.bytes, Buffer.byteLength(effectivePayload, 'utf8'), 'the admitted payload is the actual clamped wire payload');
      assert.equal(fixture.turns[0]!.body, effectivePayload, 'recorded upstream body exactly equals the supervisor-bound request');
      assert.ok(state.committed.tokens + bound > limits.maxTokens, 'the next turn no longer fits once the two admitted turns are charged');

      // The run is genuinely exhausted (not only apparently): the next turn is refused too.
      const continuation = await request(gateway, placeholder, 600);
      assert.equal(continuation.status, 403, 'a continuation must be refused once the admitted turns are really charged');
      assert.equal(fixture.turns.length, 2, 'the continuation must issue zero upstream requests');

      // The attestation tells the truth about every exchange: each admitted turn names its own outcome.
      const attestations = gateway.attestations();
      const forwarded = attestations.filter(entry => entry.outcome === 'forwarded');
      const refusals = attestations.filter(entry => entry.outcome === 'denied');
      assert.equal(forwarded.length, 2);
      assert.equal(refusals.length, 2);
      assert.deepEqual(forwarded.map(entry => entry.spend?.turnId).sort(), [`${RESERVATION}:turn-1`, `${RESERVATION}:turn-2`]);
      assert.ok(forwarded.every(entry => entry.spend?.outcome === 'charged'), 'a fresh charge must be attested charged');
      assert.ok(refusals.every(entry => entry.denial?.code === 'GATEWAY_BUDGET_DENIED'));
      assert.equal(refusals[0]!.denial?.reasonCode, 'BUDGET_EXCEEDED');
      assert.deepEqual(refusals.map(entry => entry.spend?.outcome), ['denied', 'denied']);
    });
  } finally {
    await fixture.close();
  }
});

test('the gateway attests a replayed charge as duplicate instead of charged (R3 §6.1 consequence 2)', async () => {
  const fixture = await startFixture({ usage: () => ({ prompt_tokens: 120, completion_tokens: 30 }) });
  const limits = { maxTokens: 10_000, maxCostUsd: 1 };
  try {
    await withGateway(fixture, limits, async ({ gateway, journal, placeholder }) => {
      await request(gateway, placeholder, 600);
      await request(gateway, placeholder, 600);
      const state = journal.state()!;
      assert.equal(Object.keys(state.settlements).length, 1, 'a replayed charge must not create a second settlement');
      assert.deepEqual(state.committed, { tokens: 150, costMicros: 0 }, 'a replayed charge must not double-charge the run');
      const attestations = gateway.attestations();
      assert.deepEqual(attestations.map(entry => entry.spend?.outcome), ['charged', 'duplicate'], 'a replay must never be attested as a fresh charge');
      assert.equal(attestations[0]!.spend?.turnId, attestations[1]!.spend?.turnId, 'the duplicate names the same durable turn');
      assert.equal(attestations[1]!.spend?.inputTokens, 120);
      assert.equal(attestations[1]!.spend?.outputTokens, 30);
      assert.match(String(attestations[1]!.spend?.reason), /already held this turn's charge/);
      assert.equal(fixture.turns.length, 2, 'both exchanges were genuinely forwarded; only the charge is a replay');
    }, {
      // A gate whose permit always replays one already-charged ledger turn: the second exchange is a duplicate.
      gate: ({ ledger, reservationId }) => {
        let turn: Readonly<ModelSpendTurn> | undefined;
        const charge = (result: Readonly<ModelSpendTurnCharge>): GatewayTurnCharge => ({
          turnId: result.turnId, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
          costMicros: result.costMicros, assumed: result.assumed, duplicate: result.duplicate,
        });
        return {
          attemptId: ATTEMPT,
          maxOutputTokens: DECLARED_OUTPUT,
          admit: (): GatewayTurnPermit => {
            turn ??= ledger.admitTurn({ reservationId, attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 600, maxOutputTokens: DECLARED_OUTPUT });
            const settled = turn;
            return {
              turnId: settled.turnId,
              settle: (usage: GatewayTurnUsage) => charge(settled.charge({ input: usage.inputTokens, output: usage.outputTokens })),
              unobserved: (reason: string) => charge(settled.chargeUnobserved(reason)),
              abandon: () => {},
            };
          },
        };
      },
    });
  } finally {
    await fixture.close();
  }
});

test('a spend-enforcing gateway refuses an un-gated placeholder before the provider (R3 §9.2)', async () => {
  const fixture = await startFixture({ usage: () => ({ prompt_tokens: 40, completion_tokens: 10 }) });
  const limits = { maxTokens: 10_000, maxCostUsd: 1 };
  const gateway = createControllerModelGateway({
    approval: 't10-loopback-gateway-witness',
    provider: PROVIDER,
    upstreamBaseUrl: fixture.origin,
    api: 'openai-completions',
    models: [{ id: MODEL, maxTokens: 4096, contextWindow: 131072 }],
    credential: { accountId: 't9-fixture-owner', version: 'v1', secret: UPSTREAM_SECRET },
    // The production composition sets this: a controller-created gateway never forwards without admission.
    requireSpendGate: true,
  });
  await gateway.listen();
  try {
    const placeholder = gateway.bindAttempt({ attemptId: ATTEMPT, requested: SELECTION });
    const refused = await request(gateway, placeholder, 600);
    assert.equal(refused.status, 403, refused.body);
    assert.match(refused.body, /GATEWAY_BUDGET_DENIED/);
    assert.match(refused.body, /\[SPEND_GATE_ABSENT\]/);
    assert.equal(fixture.turns.length, 0, 'an un-gated placeholder must issue zero upstream requests');
    const denial = gateway.attestations().at(-1)!;
    assert.equal(denial.outcome, 'denied');
    assert.equal(denial.denial?.code, 'GATEWAY_BUDGET_DENIED');
    assert.equal(denial.denial?.reasonCode, 'SPEND_GATE_ABSENT');
    assert.equal(denial.spend?.outcome, 'denied');
    assert.equal(denial.spend?.reasonCode, 'SPEND_GATE_ABSENT');
    assert.ok(denial.request.bytes > 0, 'the refusal is bound to the measured payload');

    // A denial is terminal for that attempt. Binding a gate cannot retroactively erase its partial receipt.
    const closed = await request(gateway, placeholder, 600);
    assert.equal(closed.status, 403);
    assert.match(closed.body, /ATTEMPT_BUDGET_CLOSED/);
    assert.equal(fixture.turns.length, 0);
    const freshAttempt = 'attempt-after-owner-extension';
    const freshReservation = `model-spend-${freshAttempt}`;
    const journal = memoryJournal();
    const ledger = new ModelSpendBudget(limits, { runId: RUN, freshRun: true, journal: journal.journal, prices: PRICES });
    ledger.bindRun(RUN, limits);
    ledger.reserve({ attemptId: freshAttempt, selection: SELECTION, inputTokensUpperBound: 200, maxOutputTokens: DECLARED_OUTPUT, reservationId: freshReservation });
    gateway.bindSpendGate({ attemptId: freshAttempt, gate: createTurnSpendGate({ ledger, reservationId: freshReservation, attemptId: freshAttempt, selection: SELECTION, maxOutputTokens: DECLARED_OUTPUT }) });
    const freshPlaceholder = gateway.bindAttempt({ attemptId: freshAttempt, requested: SELECTION });
    const forwarded = await request(gateway, freshPlaceholder, 600);
    assert.equal(forwarded.status, 200, forwarded.body);
    assert.equal(fixture.turns.length, 1);
    assert.deepEqual(journal.state()!.committed, { tokens: 50, costMicros: 0 });

    // Enforcement latches for the gateway's lifetime: an attempt minted later is refused without a bound gate.
    const ungated = gateway.bindAttempt({ attemptId: 'attempt-ungated', requested: SELECTION });
    const latched = await request(gateway, ungated, 600);
    assert.equal(latched.status, 403);
    assert.match(latched.body, /\[SPEND_GATE_ABSENT\]/);
    assert.equal(fixture.turns.length, 1, 'a latched gateway must never pay for an un-gated attempt');

    // The production launch path is covered twice: the composition declares `requireSpendGate`, and the runtime
    // binds a gate for every attempt before its placeholder is minted (managed.ts admitSpend -> workerConfig).
  } finally {
    await gateway.close();
    await fixture.close();
  }
});

test('a charge that cannot be persisted is attested failed, never charged, and reconciled later (R3 §9.3)', async () => {
  const fixture = await startFixture({ usage: () => ({ prompt_tokens: 500, completion_tokens: 50 }) });
  const failures: Array<{ turnId: string; reason: string }> = [];
  const limits = { maxTokens: 10_000, maxCostUsd: 1 };
  try {
    await withGateway(fixture, limits, async ({ gateway, journal, ledger, placeholder }) => {
      // The provider is paid before the charge is attempted: the worker is served, the charge is not.
      const first = await request(gateway, placeholder, 600);
      assert.equal(first.status, 200, first.body);
      const state = journal.state()!;
      assert.equal(Object.keys(state.settlements).length, 0, 'an unpersistable charge leaves no durable settlement');
      assert.deepEqual(state.committed, { tokens: 0, costMicros: 0 });
      assert.ok(state.reservations[RESERVATION]!.reservedTokens >= fixture.turns[0]!.bytes + DECLARED_OUTPUT,
        'the durable admission hold still covers the paid turn for reconciliation');
      const attestation = gateway.attestations().at(-1)!;
      assert.equal(attestation.outcome, 'forwarded');
      assert.equal(attestation.spend?.outcome, 'failed', 'a charge that did not persist must never be attested charged');
      assert.ok(attestation.spend?.turnId, 'the failed charge still names its own admitted turn');
      assert.equal(failures.length, 1, 'the supervisor is durably told that a paid turn is uncharged');
      assert.equal(failures[0]!.turnId, attestation.spend!.turnId);
      assert.match(failures[0]!.reason, /persistence failed/);
      assert.equal(journal.faults(), 1);

      // Fail closed: the poisoned ledger refuses the next turn before the provider is contacted.
      const second = await request(gateway, placeholder, 600);
      assert.equal(second.status, 403, second.body);
      assert.match(second.body, /ATTEMPT_BUDGET_CLOSED/, 'an unpersisted paid turn permanently closes that attempt');
      assert.equal(fixture.turns.length, 1, 'a poisoned ledger must not pay for another turn');
      assert.ok(journal.state()!.reservations[RESERVATION], 'the hold is left durable instead of being released as unspent');
      assert.throws(() => ledger.snapshot(), /Model spend journal failed/);

      // Terminal reconciliation in a fresh process charges the observed usage before releasing the hold.
      const resumed = new ModelSpendBudget(limits, { runId: RUN, journal: journal.journal, prices: PRICES });
      resumed.bindRun(RUN, limits);
      const restored = resumed.activeReservations().find(active => active.reservationId === RESERVATION)!;
      assert.ok(restored, 'the durable hold must survive the restart');
      resumed.catchUp({ reservationId: restored.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: { inputTokens: 500, outputTokens: 50 } });
      resumed.reconcileTerminal(restored.reservationId, { terminationVerified: true, reference: 'fixture-verified-terminal-collection', usage: { inputTokens: 500, outputTokens: 50 }, completeUsageVerified: true });
      resumed.release(restored.reservationId, 'reconciled:charged-turns=1');
      assert.equal(resumed.snapshot().committed.tokens, 550, 'the paid turn is charged by terminal reconciliation, never lost');
      assert.equal(resumed.exportState().released[restored.reservationId]!.reason, 'reconciled:charged-turns=1');
    }, {
      faultOnSettlement: true,
      // The production gate factory, with the supervisor's durable failure sink.
      gate: ({ ledger, reservationId }) => createTurnSpendGate({
        ledger, reservationId, attemptId: ATTEMPT, selection: SELECTION, maxOutputTokens: DECLARED_OUTPUT,
        onChargeFailed: input => { failures.push(input); },
      }),
    });
  } finally {
    await fixture.close();
  }
});
