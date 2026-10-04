#!/usr/bin/env node
// Deterministic loopback "model" gateway for the real-Pi worker test.
//
// It is NOT a model and never contacts one. It implements just enough of the OpenAI Chat Completions
// streaming API for a real `pi` process (provider api `openai-completions`, baseUrl `http://127.0.0.1:<port>`)
// to drive a fixed tool-call script against the supervisor's real worker bridge:
//
//   p2o_context -> p2o_broker rw-baseline -> p2o_broker rw-source -> p2o_broker rw-denied -> p2o_packet -> stop
//
// The script is derived from the transcript tool results in the request (not from prompt prose), so it stays
// deterministic across Pi turns. Only `POST /chat/completions` exists; every other route is 404. The server
// binds 127.0.0.1 only and makes no outbound request.
import { createServer } from 'node:http';

const PLACEHOLDER_KEY = 'p2o-gateway-placeholder';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CONTEXT_RETRY_LIMIT = 40;
const PACKET_ID = 'packet-real-worker';

function parseJson(text) {
  if (typeof text !== 'string') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.flatMap(part => (part && typeof part === 'object' && typeof part.text === 'string' ? [part.text] : [])).join('');
  }
  return '';
}

/** Rebuild the (toolName, arguments, result) history a real Pi process sent in this request. */
function analyzeTranscript(messages) {
  const calls = new Map();
  const results = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        calls.set(String(call.id ?? ''), { name: String(call.function?.name ?? ''), args: parseJson(call.function?.arguments) });
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const call = calls.get(String(message.tool_call_id ?? '')) ?? { name: '', args: undefined };
    results.push({ toolCallId: String(message.tool_call_id ?? ''), name: call.name, args: call.args, content: textContent(message.content) });
  }
  return { calls, results };
}

const BROKER_SCRIPTS = [
  { observationId: 'rw-baseline', step: 'baseline' },
  { observationId: 'rw-source', step: 'source' },
  { observationId: 'rw-denied', step: 'denied' },
];

function chooseTurn(transcript) {
  const contexts = transcript.results.filter(entry => entry.name === 'p2o_context');
  if (contexts.length === 0) return { kind: 'tool', name: 'p2o_context', args: {}, step: 'context' };
  const context = parseJson(contexts.at(-1).content);
  if (!context || typeof context !== 'object') {
    return { kind: 'error', error: `p2o_context returned unparsable JSON text: ${contexts.at(-1).content.slice(0, 240)}` };
  }
  if (!Array.isArray(context.observations)) {
    return { kind: 'error', error: 'p2o_context result has no approved observation list (`observations`); the frozen bridge contract is not satisfied' };
  }
  if (!context.observedRuntime) {
    if (contexts.length > CONTEXT_RETRY_LIMIT) return { kind: 'error', error: `no controller runtime observation after ${contexts.length} p2o_context calls` };
    // The supervisor attests the attempt asynchronously; re-read the context until the durable observation exists.
    return { kind: 'tool', name: 'p2o_context', args: {}, step: 'context-again' };
  }
  const approved = new Set(context.observations.map(entry => entry && entry.observationId).filter(id => typeof id === 'string'));
  const brokerCalls = transcript.results.filter(entry => entry.name === 'p2o_broker');
  const done = observationId => brokerCalls.some(entry => entry.args && entry.args.observationId === observationId);
  for (const script of BROKER_SCRIPTS) {
    if (done(script.observationId)) continue;
    if (!approved.has(script.observationId)) {
      return { kind: 'error', error: `owner-approved observation ${script.observationId} is missing from the p2o_context list` };
    }
    return { kind: 'tool', name: 'p2o_broker', args: { observationId: script.observationId }, step: script.step, context, approved };
  }
  if (transcript.results.some(entry => entry.name === 'p2o_packet')) {
    return { kind: 'text', step: 'done', text: 'Real-worker fixture complete: context, baseline, source, denied probe and one accepted H2 packet were handled through the supervisor bridge.' };
  }
  const evidence = {};
  for (const script of BROKER_SCRIPTS) {
    const entry = [...brokerCalls].reverse().find(candidate => candidate.args && candidate.args.observationId === script.observationId);
    const parsed = entry ? parseJson(entry.content) : undefined;
    if (parsed && typeof parsed.evidenceId === 'string') evidence[script.observationId] = parsed.evidenceId;
  }
  if (!evidence['rw-baseline'] || !evidence['rw-source']) {
    return { kind: 'error', error: `missing evidence ids for the H2 packet: ${JSON.stringify(evidence)}` };
  }
  return { kind: 'tool', name: 'p2o_packet', args: { packet: buildPacket(context, evidence) }, step: 'packet', context, evidence };
}

/** Build the concrete H2 packet a real worker would produce from controller-derived identity plus evidence ids. */
function buildPacket(context, evidence) {
  const scope = context.scope;
  const packet = {
    schemaVersion: 1,
    contract: 'H2',
    packetId: PACKET_ID,
    runId: context.runId,
    taskId: context.taskId,
    attemptId: context.attemptId,
    producer: { id: context.ownerId, role: 'worker' },
    consumer: { id: 'p2o-reviewer', role: 'reviewer' },
    createdAt: new Date().toISOString(),
    inputRevision: context.inputRevision,
    scope,
    question: context.question,
    classification: 'independently-observed',
    outcome: 'supported',
    evidenceIds: [evidence['rw-source'], evidence['rw-baseline']],
    limits: {
      negativeControlEvidenceIds: [],
      failedAssumptions: [
        'rw-denied: the owner-approved probe against an unapproved destination was denied before dispatch, so it is a bounded negative observation, not evidence.',
      ],
      untestedScope: [
        'only the seeded loopback fixture instance and the single approved guest actor were observed',
        'no non-GET method, redirect, or additional tenant value was exercised',
      ],
      risks: [],
      reproduction: { successes: 1, attempts: 1 },
    },
    nextAction: {
      action: 'retain the observed same-tenant baseline as the bounded H2 baseline and stop',
      stopCondition: 'stop after the single approved baseline/denial pair on this fixture instance',
      allowedActions: ['read'],
    },
    requestedRuntime: context.requestedRuntime,
    observedRuntime: context.observedRuntime,
    details: {
      minimalSlice: 'GET /api/v1/items/i-100?tenant=alpha against the loopback tenant fixture with the approved guest actor',
      invariant: String(context.question?.text ?? 'the guarded read route keeps tenant-scoped items behind an exact tenant match'),
      controllableFields: ['item id parameter', 'tenant parameter', 'approved guest account'],
      constraints: ['loopback fixture only', 'read-only approved HTTP requests', 'no fixture state mutation'],
      unknown: 'whether the tenant guard holds for encodings other than the exact lowercase tenant spelling',
      predictions: {
        ifTrue: 'The guarded read route returns the same-tenant item to the approved guest actor',
        ifFalse: 'The guarded read route rejects the same-tenant read',
        observableIfTrue: 'HTTP 200 whose JSON body reports the requested tenant',
        observableIfFalse: 'HTTP 403 with a tenant mismatch error',
      },
      observationPoints: ['HTTP status and JSON body of the guarded read response', 'the supervisor broker admission decision'],
      instrumentation: [],
      prerequisites: ['loopback fixture listening on 127.0.0.1', 'items i-100 (alpha) and i-200 (beta) seeded', 'guest account approved for read'],
      prerequisitesKnown: true,
      baseline: { status: 'observed', evidenceIds: [evidence['rw-baseline']] },
      lab: {
        safety: 'inert loopback fixture; no external target and no mutation',
        isolation: scope.isolation,
        authorized: true,
      },
      modifiedBuild: false,
    },
  };
  return JSON.stringify(packet, null, 2);
}

function chunk(id, model, delta, finishReason) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason ?? null }] };
}

/**
 * [T8] Deterministic token accounting for the scripted fixture. A "token" is one ceil of four UTF-8 bytes,
 * minimum one, of the exact text Pi sent (prompt) or the exact delta this gateway produced (completion).
 * The numbers are synthetic but they are *derived from the observed request/response bytes* and are
 * reported back to Pi through the standard OpenAI `stream_options.include_usage` usage chunk, so the
 * worker's real provider-usage path carries real, checkable numbers.
 */
function countTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function usageOf(promptTokens, completionTokens) {
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

/** The final OpenAI usage chunk: no choices, only usage, emitted after the finish_reason chunk. */
function usageChunk(id, model, usage) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage };
}

function sse(response, ...objects) {
  for (const object of objects) response.write(`data: ${JSON.stringify(object)}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function sendText(response, model, text, promptTokens) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
  const usage = usageOf(promptTokens, countTokens(text));
  sse(response, chunk(id, model, { role: 'assistant', content: '' }), chunk(id, model, { content: text }), chunk(id, model, {}, 'stop'), usageChunk(id, model, usage));
  return usage;
}

function sendToolCall(response, model, name, args, promptTokens) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
  const callId = `call_${name}_${Math.random().toString(36).slice(2, 10)}`;
  const usage = usageOf(promptTokens, countTokens({ name, arguments: JSON.stringify(args) }));
  const start = chunk(id, model, { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] });
  sse(response, start, chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }), chunk(id, model, {}, 'tool_calls'), usageChunk(id, model, usage));
  return usage;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    request.on('data', part => {
      size += part.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body exceeds the bounded gateway limit')); request.destroy(); return; }
      parts.push(part);
    });
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
}

/**
 * Start the inert gateway. Loopback only; no outbound request is ever made.
 * @param {{ maxExchanges?: number, onRequest?: (request: { turn: number, path: string, authorization: string, model: string, body: object, promptTokens: number }) => unknown }} [options]
 */
export async function startInertGateway(options = {}) {
  const maxExchanges = options.maxExchanges ?? 16;
  const turns = [];
  const toolResults = [];
  const errors = [];
  const onRequest = typeof options.onRequest === 'function' ? options.onRequest : undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', `http://127.0.0.1`).pathname;
      if (request.method !== 'POST' || path !== '/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(`${JSON.stringify({ error: { message: 'not_found', type: 'invalid_request_error' } })}\n`);
        return;
      }
      let raw, body;
      try { raw = await readBody(request); body = JSON.parse(raw); } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(`${JSON.stringify({ error: { message: String(error && error.message ? error.message : error), type: 'invalid_request_error' } })}\n`);
        return;
      }
      const model = String(body?.model ?? 'p2o-inert-1');
      const authorization = String(request.headers.authorization ?? '');
      const promptTokens = countTokens(body?.messages ?? []);
      // [T9] The exact payload byte length the controller gateway measured for this provider turn: the
      // per-turn worst case is derived from it, so recording it lets a test recompute the admission bound.
      const turn = { turn: turns.length + 1, path, authorization, body, bytes: Buffer.byteLength(raw, 'utf8'), promptTokens, usage: undefined, reservationsAtRequest: undefined };
      turns.push(turn);
      for (const message of Array.isArray(body?.messages) ? body.messages : []) {
        if (message && message.role === 'tool') toolResults.push(textContent(message.content));
      }
      // [T8] Observation seam: the caller can inspect controller state (e.g. the durable spend journal)
      // while this provider request is in flight, before any response byte is emitted.
      if (onRequest) {
        try { turn.reservationsAtRequest = await onRequest({ turn: turn.turn, path, authorization, model, body, promptTokens }); }
        catch (error) { errors.push(`onRequest observer failed: ${error && error.message ? error.message : error}`); }
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
      });
      if (turns.length > maxExchanges) {
        errors.push(`gateway exceeded ${maxExchanges} exchanges`);
        turn.usage = sendText(response, model, 'P2O_GATEWAY_LIMIT: scripted exchange limit reached.', promptTokens);
        return;
      }
      const transcript = analyzeTranscript(body?.messages);
      const scripted = chooseTurn(transcript);
      if (scripted.kind === 'error') {
        errors.push(scripted.error);
        turn.usage = sendText(response, model, `P2O_GATEWAY_CONTRACT_ERROR: ${scripted.error}`, promptTokens);
        return;
      }
      if (scripted.kind === 'text') { turn.usage = sendText(response, model, scripted.text, promptTokens); return; }
      turn.usage = sendToolCall(response, model, scripted.name, scripted.args, promptTokens);
    })().catch(error => {
      errors.push(String(error && error.message ? error.message : error));
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(`${JSON.stringify({ error: { message: 'gateway failure', type: 'server_error' } })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('inert gateway did not bind a loopback TCP address');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    port: address.port,
    placeholderKey: PLACEHOLDER_KEY,
    turns,
    toolResults,
    errors,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}
