/**
 * Explicit MODEL-INERT fixture provider for the first-use verification suite.
 *
 * Real host Pi completion API and real worker Pi processes call this local server; it is NOT a model, a live
 * provider or a qualification claim. It scripts two deterministic roles:
 *
 *   * producer: plan the owner-approved read-only differential (observation, negative control, reproduction),
 *     then perform exactly those checks and publish one H1 packet that references its own receipts.
 *   * verifier: perform the single approved baseline observation, call `p2o_verify` with the findingId named in
 *     the task question, then publish one H1 packet whose outcome follows the controller replay outcome.
 *
 * There is no outbound provider connection, no credential and no target authority beyond the approved checks.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

function parse(value: unknown): any {
  try {
    return JSON.parse(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function text(content: any): string {
  return typeof content === 'string' ? content : (content ?? []).map((part: any) => part.text ?? '').join('');
}

type PlanFlavour = 'differential' | 'benign';

interface ProviderOptions {
  /** The owner-approved plan the inert model authors; the real owner still has to approve it. */
  plan?: PlanFlavour;
}

function planningAnswer(input: any, flavour: PlanFlavour): string {
  const taskId = input.facts.generatedTasks[0].taskId;
  const locator = String(input.facts.locator);
  const draft = (requestId: string, kind: string, summary: string, query: string, expectation: Record<string, unknown>) => ({
    requestId, taskId, tool: 'http.request', method: 'GET', url: `${locator}/item?${query}`, action: 'read', accountId: 'anonymous',
    kind, classification: 'independently-observed', summary, purpose: 'Bounded read-only observation inside the owner-approved target', requests: 1, expectation,
  });
  if (flavour === 'benign') {
    return JSON.stringify({
      steps: ['Read exactly the approved read-only surface once; author no vulnerability claim.'],
      generatedRequests: [draft('r-benign', 'observation', 'Single benign read-only observation of the approved alpha item; no vulnerability claim', 'id=i-100&tenant=alpha', { type: 'http', status: 200, bodyIncludes: '"value":"alpha-value"' })],
    });
  }
  return JSON.stringify({
    steps: [
      'Read the alpha item under its own tenant to establish the baseline observable.',
      'Send the same read with a mismatched tenant claim to establish the negative control.',
      'Read the beta item with tenant=beta to bound whether the guard checks the claimed tenant only.',
    ],
    generatedRequests: [
      draft('r-baseline', 'observation', 'Anonymous read of the alpha item under its own tenant returns the alpha value', 'id=i-100&tenant=alpha', { type: 'http', status: 200, bodyIncludes: '"value":"alpha-value"' }),
      draft('r-control', 'negative-control', 'The same read with a mismatched tenant claim is rejected by the tenant guard', 'id=i-100&tenant=beta', { type: 'http', status: 403, bodyIncludes: 'tenant_mismatch' }),
      draft('r-reproduction', 'reproduction', 'The beta item is returned to the anonymous actor when the tenant parameter merely names beta, so the guard checks the claimed tenant only', 'id=i-200&tenant=beta', { type: 'http', status: 200, bodyIncludes: '"value":"beta-secret"' }),
    ],
  });
}

function h1Packet(context: any, options: { evidenceIds: string[]; controlIds: string[]; interfaceEvidenceIds: string[]; outcome: 'supported' | 'unresolved'; role: string; reproductionSuccesses: number; untestedScope: string[]; failedAssumptions: string[]; source?: boolean }): string {
  return JSON.stringify({
    schemaVersion: 1,
    contract: 'H1',
    packetId: `inert-h1-${options.role}-${context.taskId}-${String(context.attemptId).slice(-12)}`,
    runId: context.runId,
    taskId: context.taskId,
    attemptId: context.attemptId,
    producer: { id: context.ownerId, role: 'worker' },
    consumer: { id: 'p2o-reviewer', role: 'reviewer' },
    createdAt: new Date().toISOString(),
    inputRevision: context.inputRevision,
    scope: context.scope,
    question: context.question,
    classification: options.source === true ? 'static-inference' : options.outcome === 'supported' ? 'independently-observed' : 'unresolved',
    outcome: options.source === true ? 'static-only' : options.outcome,
    evidenceIds: options.evidenceIds,
    limits: {
      negativeControlEvidenceIds: options.controlIds,
      failedAssumptions: options.failedAssumptions,
      untestedScope: options.untestedScope,
      risks: [],
      reproduction: { successes: options.reproductionSuccesses, attempts: 1 },
    },
    nextAction: {
      action: options.role === 'verifier' ? 'Report the controller independent replay outcome honestly; never promote a claim the replay did not reproduce.' : 'Independently replay the bounded differential before any finding is promoted.',
      stopCondition: 'Stop after the single bounded replay; no widening.',
      allowedActions: context.allowedActions,
    },
    requestedRuntime: context.requestedRuntime,
    observedRuntime: context.observedRuntime,
    details: {
      interfaces: [{
        surfaceId: 'owner-target',
        registration: 'GET <owner-approved read surface>',
        handler: 'bounded loopback item handler',
        actorId: context.scope.actor.id,
        gate: options.role === 'verifier' ? 'owner-approved verifier replay in a fresh verifier environment' : 'owner-approved policy grant and anonymous read account',
        processIdentity: options.role === 'verifier' ? 'controller-attested verifier attempt' : 'controller-attested producing attempt',
        formats: ['application/json'],
        benignOperations: ['read an item inside the tested tenant claim'],
        priority: 1,
        priorityReason: 'the owner-approved read surface carries the bounded differential under test',
        evidenceIds: options.interfaceEvidenceIds,
        reachability: options.source === true ? 'inferred' : 'observed',
        ...(options.source === true ? { proposedCheck: 'Qualify actual runtime handler/gate behavior before any vulnerability claim.' } : {}),
      }],
      unresolvedRoutes: ['state-changing, administrative and other-actor behavior was not exercised'],
    },
  });
}

export async function inertVerificationProvider(options: ProviderOptions = {}) {
  const requests: any[] = [];
  const flavour: PlanFlavour = options.plan ?? 'differential';
  const server = createServer(async (req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const body = parse(Buffer.concat(parts).toString());
    requests.push(body);
    const messages = body.messages ?? [];
    const toolNames = (body.tools ?? []).map((tool: any) => tool.function?.name);
    let answer: string | undefined;
    let tools: Array<{ name: string; arguments: any }> | undefined;
    if (!toolNames.includes('p2o_context')) {
      const prompt = text(messages.findLast((message: any) => message.role === 'user')?.content);
      const input = parse(prompt.slice(prompt.lastIndexOf('\n{\n') + 1, prompt.lastIndexOf('\nSelect only ids')));
      if (!input?.facts) {
        res.writeHead(400).end('invalid inert planning facts');
        return;
      }
      if (input.facts.targetKind === 'http-url') answer = planningAnswer(input, flavour);
      else answer = JSON.stringify({
        steps: ['Enumerate only the approved immutable filtered source and analyze a bounded UTF-8 file sample without execution.'],
        ownerMenu: input.facts.ownerObservations.map((observation: any) => ({ taskId: observation.taskId, observationId: observation.observationId })),
      });
    } else {
      const calls = new Map<string, any>();
      const results: any[] = [];
      for (const message of messages) {
        for (const call of message.tool_calls ?? []) calls.set(call.id, { name: call.function.name, args: parse(call.function.arguments) });
        if (message.role === 'tool') results.push({ ...calls.get(message.tool_call_id), value: parse(text(message.content)) });
      }
      const context = results.findLast((item: any) => item.name === 'p2o_context')?.value;
      const isVerifier = toolNames.includes('p2o_verify');
      if (!context?.observedRuntime) tools = [{ name: 'p2o_context', arguments: {} }];
      else if (isVerifier) {
        const observations = results.filter((item: any) => item.name === 'p2o_broker');
        const next = context.observations.find((observation: any) => !observations.some((item: any) => item.args?.observationId === observation.observationId));
        const verification = results.findLast((item: any) => item.name === 'p2o_verify')?.value;
        const packetWritten = results.some((item: any) => item.name === 'p2o_packet');
        if (next) tools = [{ name: 'p2o_broker', arguments: { observationId: next.observationId } }];
        else if (!verification) {
          const findingId = /findingId\s+"([A-Za-z0-9._:-]+)"/.exec(String(context.question?.text))?.[1];
          if (!findingId) throw new Error('inert verifier could not read the findingId from the task question');
          tools = [{ name: 'p2o_verify', arguments: { findingId } }];
        } else if (!packetWritten) {
          const baseline = observations.map((item: any) => item.value).find((value: any) => value?.kind === 'observation');
          const evidenceIds = [baseline?.evidenceId, ...(verification.evidenceIds ?? [])].filter((id: any) => typeof id === 'string');
          const controlIds = (verification.evidenceIds ?? []).filter((id: string) => id.endsWith('.negative-control'));
          const reproduced = verification.finding?.state === 'independently-validated';
          tools = [{
            name: 'p2o_packet',
            arguments: {
              packet: h1Packet(context, {
                evidenceIds, controlIds, interfaceEvidenceIds: [baseline?.evidenceId].filter((id: any) => typeof id === 'string'),
                outcome: reproduced ? 'supported' : 'unresolved', role: 'verifier', reproductionSuccesses: reproduced ? 1 : 0,
                untestedScope: ['Administrative, state-changing and other-actor behavior was not exercised; the replay is bounded to the owner-approved requests.'],
                failedAssumptions: reproduced ? [] : [`The controller replay outcome for the finding was ${String(verification.finding?.state ?? verification.status)}; the claim is not promoted.`],
              }),
            },
          }];
        } else answer = 'MODEL-INERT verifier script ended. The controller replay outcome is reported as-is; no exploit claim was authored.';
      } else {
        const observations = results.filter((item: any) => item.name === 'p2o_broker');
        const remaining = context.observations.filter((observation: any) => !observations.some((item: any) => item.args?.observationId === observation.observationId));
        const packetWritten = results.some((item: any) => item.name === 'p2o_packet');
        // The producing program must fit the finite workers phase: one context turn, one assistant message that
        // performs every remaining owner-approved observation in parallel, then the packet turn.
        if (remaining.length) tools = remaining.map((observation: any) => ({ name: 'p2o_broker', arguments: { observationId: observation.observationId } }));
        else if (!packetWritten) {
          const byKind = new Map(observations.map((item: any) => [item.value?.kind, item.value]));
          const sourceOnly = context.observations.length > 0 && context.observations.every((observation: any) => observation.tool === 'source.analyze');
          if (sourceOnly) {
            const sourceReceipt = observations.map((item: any) => item.value).find((value: any) => value?.kind === 'source');
            tools = [{
              name: 'p2o_packet',
              arguments: {
                packet: h1Packet(context, {
                  evidenceIds: [sourceReceipt?.evidenceId].filter((id: any) => typeof id === 'string'),
                  controlIds: [], interfaceEvidenceIds: [sourceReceipt?.evidenceId].filter((id: any) => typeof id === 'string'),
                  outcome: 'unresolved', role: 'producer', reproductionSuccesses: 0, source: true,
                  untestedScope: ['No repository script, build, install, native code or state-changing action was authorized or executed; dynamic behavior and exploitability remain unverified.'],
                  failedAssumptions: [],
                }),
              },
            }];
            answer = undefined;
          } else {
          const baseline = byKind.get('observation') as any;
          const control = byKind.get('negative-control') as any;
          const reproduction = byKind.get('reproduction') as any;
          tools = [{
            name: 'p2o_packet',
            arguments: {
              packet: h1Packet(context, {
                evidenceIds: [baseline?.evidenceId, reproduction?.evidenceId].filter((id: any) => typeof id === 'string'),
                controlIds: [control?.evidenceId].filter((id: any) => typeof id === 'string'),
                interfaceEvidenceIds: [baseline?.evidenceId].filter((id: any) => typeof id === 'string'),
                outcome: 'supported', role: 'producer', reproductionSuccesses: reproduction?.outcome === 'passed' ? 1 : 0,
                untestedScope: ['No repository script, state change, other path or other actor was exercised; the bounded differential is the only claim.'],
                failedAssumptions: [],
              }),
            },
          }];
          }
        } else answer = 'MODEL-INERT producing script ended. Only receipt-supported bounded observations; no live qualification or verified vulnerability.';
      }
    }
    const id = `chatcmpl-${randomUUID()}`;
    const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }; // explicitly synthetic fixture counters
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: any, finish_reason: string | null = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    const data = tools?.length
      ? [chunk({ role: 'assistant', tool_calls: tools.map((entry, index) => ({ index, id: `call-${randomUUID()}`, type: 'function', function: { name: entry.name, arguments: JSON.stringify(entry.arguments) } })) }), chunk({}, 'tool_calls')]
      : [chunk({ role: 'assistant', content: answer }), chunk({}, 'stop')];
    for (const item of [...data, { ...chunk({}), choices: [], usage }]) res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
