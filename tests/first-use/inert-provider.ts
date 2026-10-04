/** Explicit MODEL-INERT fixture. Real host Pi completion API and real worker Pi processes call this local server.
 * It is not a model/live qualification; no outbound provider connection, credential or target authority. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

function parse(value: unknown): any { try { return JSON.parse(typeof value === 'string' ? value : JSON.stringify(value)); } catch { return undefined; } }
function text(content: any): string { return typeof content === 'string' ? content : (content ?? []).map((part: any) => part.text ?? '').join(''); }
function packet(context: any, evidence: any[]) {
  const ids = evidence.flatMap(item => item?.evidenceId ? [item.evidenceId] : []);
  const source = context.observations.every((observation: any) => observation.tool === 'source.analyze');
  return { schemaVersion: 1, contract: 'H1', packetId: `inert-packet-${context.attemptId}`, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
    producer: { id: context.ownerId, role: 'worker' }, consumer: { id: 'p2o-reviewer', role: 'reviewer' }, createdAt: new Date().toISOString(),
    inputRevision: context.inputRevision, scope: context.scope, question: context.question,
    classification: source ? 'static-inference' : 'independently-observed', outcome: source ? 'static-only' : 'supported', evidenceIds: ids,
    limits: { negativeControlEvidenceIds: [], failedAssumptions: [], untestedScope: ['Explicit MODEL-INERT script; no live model quality or vulnerability/negative-control replay qualification.'], risks: [], reproduction: { successes: 0, attempts: 0 } },
    nextAction: { action: 'Report authenticated observations with static-only and model-inert limitations.', stopCondition: 'Approved bounded observation list exhausted.', allowedActions: context.allowedActions },
    requestedRuntime: context.requestedRuntime, observedRuntime: context.observedRuntime,
    details: { interfaces: [{ surfaceId: 'owner-target', registration: 'bounded broker observation', handler: 'unknown; do not infer exploitability', actorId: 'anonymous', gate: 'owner scope and broker policy', processIdentity: 'controller-attested worker', formats: ['bounded source/HTTP observation'], benignOperations: ['read/static only'], priority: 1, priorityReason: 'explicit inert transport verification only', evidenceIds: ids, reachability: source ? 'inferred' : 'observed', ...(source ? { proposedCheck: 'Qualify actual runtime handler/gate behavior before any vulnerability claim.' } : {}) }], unresolvedRoutes: ['No exploit or state-change exercise qualified.'] } };
}
/** `holdWorkerMs` stalls only tool-bearing worker turns, leaving planner calls bounded: it exists so an
 * interruption window with a live physical worker can be observed by restart qualification tests. */
export async function inertProvider(options: { holdWorkerMs?: number } = {}) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const body = parse(Buffer.concat(parts).toString()); requests.push(body);
    const messages = body.messages ?? [];
    const hasTools = (body.tools ?? []).some((tool: any) => tool.function?.name === 'p2o_context');
    // Hold after the real broker (container) call has already happened: the attempt is live, the enrolled
    // container exists, and the crash window does not prevent the physical resource from being created.
    const calledBroker = messages.some((message: any) => (message.tool_calls ?? []).some((call: any) => call.function?.name === 'p2o_broker'));
    if (options.holdWorkerMs !== undefined && hasTools && calledBroker) await new Promise(resolve => setTimeout(resolve, options.holdWorkerMs));
    let answer: string | undefined, tool: { name: string; arguments: any } | undefined;
    if (!hasTools) {
      const prompt = text(messages.findLast((message: any) => message.role === 'user')?.content);
      const input = parse(prompt.slice(prompt.lastIndexOf('\n{\n') + 1, prompt.lastIndexOf('\nSelect only ids')));
      if (!input?.facts) { res.writeHead(400).end('invalid inert planning facts'); return; }
      if (input.facts.targetKind === 'http-url') {
        answer = JSON.stringify({ steps: ['Read exactly the approved URL with a bounded GET.'], generatedRequests: [{ requestId: 'read-owner-url', taskId: input.facts.generatedTasks[0].taskId, tool: 'http.request', method: 'GET', url: input.facts.locator, action: 'read', accountId: 'anonymous', kind: 'observation', classification: 'independently-observed', summary: 'Read-only exact URL observation; no vulnerability claim', purpose: 'Decide bounded read-only surface question', requests: 1, expectation: { type: 'http', status: 200 } }] });
      } else answer = JSON.stringify({ steps: ['Enumerate only the approved immutable filtered source; analyze at most 64 bounded UTF-8 files without execution.'], ownerMenu: input.facts.ownerObservations.map((observation: any) => ({ taskId: observation.taskId, observationId: observation.observationId })) });
    } else {
      const calls = new Map<string, any>(); const results: any[] = [];
      for (const message of messages) {
        for (const call of message.tool_calls ?? []) calls.set(call.id, { name: call.function.name, args: parse(call.function.arguments) });
        if (message.role === 'tool') results.push({ ...calls.get(message.tool_call_id), value: parse(text(message.content)) });
      }
      const context = results.findLast(item => item.name === 'p2o_context')?.value;
      if (!context?.observedRuntime) tool = { name: 'p2o_context', arguments: {} };
      else {
        const observations = results.filter(item => item.name === 'p2o_broker');
        const next = context.observations.find((observation: any) => !observations.some(item => item.args?.observationId === observation.observationId));
        if (next) tool = { name: 'p2o_broker', arguments: { observationId: next.observationId } };
        else if (!results.some(item => item.name === 'p2o_packet')) tool = { name: 'p2o_packet', arguments: { packet: JSON.stringify(packet(context, observations.map(item => item.value))) } };
        else answer = 'MODEL-INERT transport script ended. Only receipt-supported bounded observations; no live qualification or verified vulnerability.';
      }
    }
    const id = `chatcmpl-${randomUUID()}`, usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }; // explicitly synthetic fixture counters
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: any, finish_reason: string | null = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    const data = tool ? [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }), chunk({}, 'tool_calls')]
      : [chunk({ role: 'assistant', content: answer }), chunk({}, 'stop')];
    for (const item of [...data, { ...chunk({}), choices: [], usage }]) res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, async close() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
