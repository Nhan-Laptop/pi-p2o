// NO AI AND NO OUTBOUND NETWORK. A bounded deterministic OpenAI-completions transport fixture.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' ? value : (value ?? []).map(part => part?.text ?? '').join('');
const parse = value => { try { return JSON.parse(value); } catch { return undefined; } };

export function planningAnswer(messages) {
  const prompt = text(messages.findLast(message => message.role === 'user')?.content);
  // Accept the production author's structured facts, or its older bounded text facts. Neither grants scope.
  const start = prompt.indexOf('\n{');
  const input = start >= 0 ? parse(prompt.slice(start + 1)) : parse(prompt);
  const facts = input?.facts;
  const kind = facts?.targetKind ?? facts?.kind ?? /kind=([^ ]+)/.exec(prompt)?.[1];
  const locator = facts?.locator ?? /locator=(.*?) targetId=/.exec(prompt)?.[1];
  const menu = facts?.ownerObservations ?? [...prompt.matchAll(/taskId=([^ ]+) observationId=([^ ]+) tool=/g)]
    .map(match => ({ taskId: match[1], observationId: match[2] }));
  if (kind === 'http-url') {
    const taskId = facts?.generatedTasks?.[0]?.taskId ?? /Task hosts approved[\s\S]*?taskId=([^ ]+)/.exec(prompt)?.[1];
    if (!taskId || !locator || !/^http:\/\/127\.0\.0\.1:\d+\/exact$/.test(locator)) throw new Error('INERT_SCOPE_DENIED: only the owned loopback /exact target');
    const requests = [{ requestId: 'read-owner-url', taskId, tool: 'http.request', method: 'GET', url: locator,
      action: 'read', accountId: 'anonymous', kind: 'observation', classification: 'independently-observed',
      summary: 'Exact read-only loopback observation, not vulnerability verification',
      // Required by the CURRENT production plan-request draft contract (prompt shape in src/application/entry/pi-author.ts).
      purpose: 'Decide the bounded read-only surface question for the exact owner-approved URL', requests: 1,
      expectation: { type: 'http', status: 200 } }];
    // Structured facts version consumes a full proposal; legacy version consumes its request array.
    return { steps: ['Read exactly the approved URL with one bounded GET.'], generatedRequests: facts
      ? { schemaVersion: 1, proposalId: `inert-read-${randomUUID()}`, runId: input.runId,
        generator: { generatorAttemptId: 'inert-planner', generatorKind: 'worker',
          requestedSelection: { provider: 'inert-fixture', model: 'inert-worker', thinking: 'off' },
          inputDigests: [input.scopeDigest], producedAt: new Date().toISOString() }, requests }
      : requests };
  }
  if (!['local-dir', 'github-repo'].includes(kind) || !menu.length) throw new Error('INERT_PLAN_CONTRACT: no approved static observation menu');
  return { steps: ['Select only approved bounded static source analysis. No repository execution.'],
    ownerMenu: menu.map(({ taskId, observationId }) => ({ taskId, observationId })) };
}

export function transcriptResults(messages) {
  const calls = new Map(), results = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, { name: call.function.name, args: parse(call.function.arguments) });
    if (message.role === 'tool') results.push({ ...calls.get(message.tool_call_id), value: parse(text(message.content)), raw: text(message.content) });
  }
  return results;
}
/** Exact limitation text this inert packet declares. The qualified report must preserve it verbatim. */
export const UNTESTED_SCOPE = Object.freeze([
  'Deterministic INERT PROVIDER: no live AI, exploit replay or vulnerability qualification.',
]);


function packet(context, observations) {
  const source = context.observations.some(item => item.tool === 'source.analyze');
  const ids = observations.map(item => item.value?.evidenceId).filter(Boolean);
  if (!ids.length) throw new Error('INERT_PACKET_CONTRACT: real broker returned no evidence ids');
  return { schemaVersion: 1, contract: 'H1', packetId: `inert-packet-${context.attemptId}`, runId: context.runId,
    taskId: context.taskId, attemptId: context.attemptId, producer: { id: context.ownerId, role: 'worker' },
    consumer: { id: 'p2o-reviewer', role: 'reviewer' }, createdAt: new Date().toISOString(),
    inputRevision: context.inputRevision, scope: context.scope, question: context.question,
    classification: source ? 'static-inference' : 'independently-observed', outcome: source ? 'static-only' : 'supported', evidenceIds: ids,
    limits: { negativeControlEvidenceIds: [], failedAssumptions: [],
      untestedScope: [...UNTESTED_SCOPE],
      risks: [], reproduction: { successes: 0, attempts: 0 } },
    nextAction: { action: 'Report authenticated bounded observations without upgrading static inference.',
      stopCondition: 'Approved observation list exhausted.', allowedActions: context.allowedActions },
    requestedRuntime: context.requestedRuntime, observedRuntime: context.observedRuntime,
    details: { interfaces: [{ surfaceId: 'owner-target', registration: 'bounded broker observation',
      handler: 'unknown', actorId: 'anonymous', gate: 'real owner ledger and broker policy',
      processIdentity: 'controller-attested worker', formats: ['bounded source/HTTP observation'],
      benignOperations: ['read/static only'], priority: 1, priorityReason: 'mechanical-chain qualification only',
      evidenceIds: ids, reachability: source ? 'inferred' : 'observed',
      ...(source ? { proposedCheck: 'Any dynamic reachability remains untested; require separate runtime approval and evidence.' } : {}),
    }], unresolvedRoutes: ['No exploit or state-change exercised.'] } };
}

export function workerAnswer(body) {
  const results = transcriptResults(body.messages ?? []);
  const context = results.findLast(item => item.name === 'p2o_context')?.value;
  if (!context?.observedRuntime) {
    if (results.filter(item => item.name === 'p2o_context').length >= 12) throw new Error('INERT_RUNTIME_CONTRACT: no real observed runtime after 12 attempts');
    return { tool: { name: 'p2o_context', args: {} }, step: 'context' };
  }
  const observations = results.filter(item => item.name === 'p2o_broker');
  const next = context.observations?.find(item => !observations.some(result => result.args?.observationId === item.observationId));
  if (next) return { tool: { name: 'p2o_broker', args: { observationId: next.observationId } }, step: 'broker', context };
  if (!results.some(item => item.name === 'p2o_packet')) return {
    tool: { name: 'p2o_packet', args: { packet: JSON.stringify(packet(context, observations)) } }, step: 'packet', context,
  };
  return { answer: 'INERT PROVIDER completed the mechanical chain. Not live AI or exploit evidence.', step: 'end', context };
}

export async function startInertProvider({ onReceipt = () => {}, maxExchanges = 24, holdPacket = false } = {}) {
  const receipts = [], errors = [], pending = new Set();
  let hold = holdPacket, held = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/chat/completions') { response.writeHead(404).end(); return; }
      const parts = []; let bytes = 0;
      for await (const part of request) {
        bytes += part.length; if (bytes > 4 * 1024 * 1024) throw new Error('INERT_BODY_BOUND: 4MiB'); parts.push(part);
      }
      const raw = Buffer.concat(parts).toString('utf8'), body = JSON.parse(raw);
      if (body.model !== 'inert-worker') throw new Error(`INERT_MODEL_DENIED: ${body.model}`);
      if (receipts.length >= maxExchanges) throw new Error('INERT_EXCHANGE_BOUND');
      const worker = body.tools?.some(tool => tool.function?.name === 'p2o_context');
      const turn = worker ? workerAnswer(body) : { answer: JSON.stringify(planningAnswer(body.messages ?? [])), step: 'plan' };
      const output = turn.tool ? JSON.stringify(turn.tool) : turn.answer;
      // Synthetic counters, conservatively derived from fixture bytes; NOT provider tokenization.
      const input = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(body.messages ?? [])) / 4));
      const completion = Math.max(1, Math.ceil(Buffer.byteLength(output) / 4));
      const usage = { prompt_tokens: input, completion_tokens: completion, total_tokens: input + completion };
      const receipt = { at: Date.now(), exchange: receipts.length + 1, evidenceClass: 'deterministic-inert-provider',
        step: turn.step, requestBytes: bytes, requestSha256: sha(raw), responseSha256: sha(output),
        model: body.model, stream: body.stream, usage, usageBasis: 'synthetic-ceil-UTF8-bytes/4-not-model-tokenization',
        body, turn };
      receipts.push(receipt); onReceipt(receipt);
      if (hold && turn.step === 'packet') {
        held = true;
        await new Promise(resolve => {
          const finish = () => { pending.delete(finish); resolve(); };
          pending.add(finish); response.once('close', finish);
        });
        if (response.destroyed) return;
      }
      const id = `chatcmpl-${randomUUID()}`;
      const message = turn.tool
        ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${randomUUID()}`, type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] }
        : { role: 'assistant', content: turn.answer };
      const reason = turn.tool ? 'tool_calls' : 'stop';
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: body.model,
          choices: [{ index: 0, message, finish_reason: reason }], usage })); return;
      }
      const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
        model: body.model, choices: [{ index: 0, delta, finish_reason }] });
      const delta = turn.tool
        ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] }
        : { role: 'assistant', content: turn.answer };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const item of [chunk(delta), chunk({}, reason), { ...chunk({}), choices: [], usage }]) response.write(`data: ${JSON.stringify(item)}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error.message); onReceipt({ at: Date.now(), error: error.message });
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message, type: 'inert_fixture_contract_error' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, receipts, errors, get held() { return held; },
    release() { hold = false; for (const finish of [...pending]) finish(); },
    async close() { this.release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
