#!/usr/bin/env node
// Inert, deterministic local fixture worker.
//
// This is NOT a model. It is an owner-authored scripted worker used by the local end-to-end fixture to
// exercise the real runtime adapter contract (guardian ownership, RPC readiness, receipts, deadlines, stop)
// without any provider call. It performs only:
//   - the pinned `--version` preflight,
//   - the public Pi RPC subset the headless adapter uses (get_state / prompt),
//   - the fixture plan steps through the supervisor's authenticated worker bridge,
//   - one workspace packet file that the evidence result collector preserves and admits.
// It has no host shell, no filesystem tools, no credentials and no network except the local bridge socket.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';

if (process.argv.includes('--version')) {
  process.stdout.write('0.85.1\n');
  process.exit(0);
}

const configPath = process.env.P2O_CONFIG;
if (!configPath) { process.stderr.write('P2O_CONFIG is required\n'); process.exit(2); }
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Fail closed unless the pinned sandbox extension is present and unmodified. The inert worker does not load Pi
// extensions, but the owner-approved tool policy pin must still be operationally true before any call is made.
function assertPinnedExtension() {
  const policy = config.toolPolicy;
  if (!policy || policy.mode !== 'sandbox-extension' || !policy.extension || typeof policy.extension.path !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(policy.extension.sha256))) {
    throw new Error('worker was not launched under a pinned sandbox-extension tool policy');
  }
  const digest = createHash('sha256').update(fs.readFileSync(policy.extension.path)).digest('hex');
  if (digest !== policy.extension.sha256) throw new Error('pinned extension digest mismatch; refusing to run worker steps');
}
assertPinnedExtension();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sessionId() {
  const first = fs.readFileSync(config.sessionFile, 'utf8').split('\n')[0];
  const header = JSON.parse(first);
  if (header.type !== 'session' || typeof header.id !== 'string') throw new Error('unexpected session header');
  return header.id;
}

const selection = { provider: config.requested.provider, model: config.requested.model, thinking: config.requested.thinking };
const receipt = { token: config.token, seq: 0, ready: false, events: [] };
function flushReceipt() {
  const temporary = `${config.receiptFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, config.receiptFile);
}
function record(type, extra = {}) {
  receipt.events.push({ seq: ++receipt.seq, at: Date.now(), type, selection, ...extra });
  receipt.events = receipt.events.slice(-64);
  flushReceipt();
}
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
function note(message) {
  // Bounded diagnostics on stderr; the runtime adapter keeps these in its bounded log tail.
  process.stderr.write(`[inert-worker] ${message}\n`);
}

function respond(id, command, data, success = true, error) {
  emit({ id, type: 'response', command, success, ...(success ? { data } : { error: error ?? 'failed' }) });
}

async function bridgeCall(bridge, operation, payload, timeoutMs = 30000) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.connect(bridge.socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error(`bridge ${operation} timed out`)), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, taskId: bridge.taskId, token: config.token, operation, payload })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.id !== id) return finish(new Error('bridge response identity mismatch'));
        if (!response.ok) return finish(new Error(`${response.code}: ${response.message}`));
        finish(undefined, response.data);
      } catch (error) { finish(error instanceof Error ? error : new Error('malformed bridge response')); }
    });
    socket.on('error', (error) => { clearTimeout(timer); finish(error); });
    socket.on('close', () => { clearTimeout(timer); finish(new Error('bridge connection closed')); });
  });
}

function requestedRuntime(state) {
  return state.requestedRuntime ?? { adapter: 'headless', selection, requiredCapabilities: ['ownsLifecycle'] };
}
function fallbackRuntime(state) {
  const requested = requestedRuntime(state);
  const capabilities = { ownsLifecycle: false, canHardStop: false, canResume: false, streamsEvents: false, attestsRuntime: false };
  for (const name of requested.requiredCapabilities ?? []) capabilities[name] = true;
  return { adapter: requested.adapter, selection: requested.selection, capabilities, attestation: 'reported', observedAt: new Date().toISOString(), receiptEvidenceIds: [] };
}

function resolveDeep(value, context) {
  if (typeof value === 'string') {
    if (value.startsWith('$evidence:')) {
      const id = context.evidence[value.slice('$evidence:'.length)];
      if (!id) throw new Error(`unresolved evidence placeholder ${value}`);
      return id;
    }
    if (value.startsWith('$evidenceIds:')) {
      const names = value.slice('$evidenceIds:'.length).split(',').map(n => n.trim()).filter(Boolean);
      const ids = names.map(name => context.evidence[name]).filter(Boolean);
      if (ids.length !== names.length) throw new Error(`unresolved evidence list ${value}`);
      return ids;
    }
    switch (value) {
      case '$runId': return context.state.runId;
      case '$taskId': return context.state.taskId;
      case '$attemptId': return context.state.attemptId;
      case '$producerId': return context.state.ownerId;
      case '$scope': return context.state.scope;
      case '$question': return context.state.question;
      case '$inputRevision': return context.state.inputRevision;
      case '$requestedRuntime': return requestedRuntime(context.state);
      case '$runtime': return context.state.observedRuntime ?? fallbackRuntime(context.state);
      case '$inputDigests': return context.state.scope.inputs.map(input => input.digest);
      case '$isolation': return context.state.scope.isolation;
      case '$observedAt': return new Date().toISOString();
      case '$verifierEvidence': return context.verification?.evidenceIds ?? [];
      default: return value;
    }
  }
  if (Array.isArray(value)) return value.map(entry => resolveDeep(entry, context));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveDeep(entry, context);
    return out;
  }
  return value;
}

function writeWorkspace(file, value) {
  const target = path.join(config.workspace, file);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return target;
}

async function runPlan() {
  const plan = readJson(path.join(config.workspace, 'worker-plan.json'));
  const bridge = readJson(path.join(config.workspace, 'p2o-bridge.json'));
  note('plan started');
  const state = await bridgeCall(bridge, 'attempt.state', {});
  if (state.taskId !== plan.taskIdHint) {
    // The workspace plan is written by the composition for the admitted task; a mismatch is a hard error.
    throw new Error(`workspace plan task ${plan.taskIdHint} does not match ${state.taskId}`);
  }
  const context = { state, evidence: {}, verification: undefined };
  const declared = [];
  for (const observation of plan.observations ?? []) {
    const observationId = observation.observationId;
    if (typeof observationId !== 'string') throw new Error('worker plan observation lacks an owner-approved observationId');
    note(`observe ${observation.name ?? observationId}`);
    // The worker selects an owner-approved observation; inputs, expectations and test outcomes live in the
    // owner document and are evaluated by the controller.
    const result = await bridgeCall(bridge, 'broker.execute', { observationId });
    context.evidence[observation.name ?? observationId] = result.evidenceId;
    // Record only what the controller returned. `hint` is worker-side plan prose that the controller never
    // reads; the regression asserts the recorded outcome can disagree with it.
    declared.push({
      name: observation.name ?? observationId,
      observationId,
      evidenceId: typeof result.evidenceId === 'string' ? result.evidenceId : null,
      outcome: typeof result.outcome === 'string' ? result.outcome : null,
      hint: typeof observation.hint === 'string' ? observation.hint : null,
    });
  }
  // Progress marker written while the owned attempt is still live: the pre-dispatch budget regression waits for
  // it and then measures one denied probe against an otherwise idle attempt.
  writeWorkspace('worker-observations.json', { taskId: state.taskId, attemptId: state.attemptId, observations: declared });
  const holdMs = Number(plan.holdBeforePacketMs);
  if (Number.isSafeInteger(holdMs) && holdMs > 0) {
    note(`holding ${Math.min(holdMs, 10000)}ms before the packet`);
    await new Promise(resolve => setTimeout(resolve, Math.min(holdMs, 10000)));
  }
  if (plan.verify) {
    // Only the finding id is worker-supplied; the recipe, deadline and reviewer identity are owner-approved.
    context.verification = await bridgeCall(bridge, 'verify.finding', { findingId: plan.verify.findingId }, 45000);
    for (const [index, id] of (context.verification.evidenceIds ?? []).entries()) context.evidence[`verifier-${index}`] = id;
  }
  const packet = resolveDeep({ ...plan.packet, observedRuntime: state.observedRuntime ?? fallbackRuntime(state) }, context);
  note(`writing packet ${plan.packetFile ?? 'handoff.packet.json'}`);
  const file = writeWorkspace(plan.packetFile ?? 'handoff.packet.json', packet);
  writeWorkspace('worker-outcome.json', {
    attemptId: state.attemptId, taskId: state.taskId, step: plan.step,
    evidence: context.evidence, observations: declared, verification: context.verification ? { status: context.verification.status } : undefined,
    packetFile: path.basename(file), completedAt: new Date().toISOString(),
  });
  return packet.outcome ?? 'unknown';
}

function finish(ok, detail) {
  const assistant = { provider: config.requested.provider, model: config.requested.model, stopReason: ok ? 'stop' : 'error', ...(ok ? {} : { errorMessage: String(detail).slice(-512) }) };
  record('message_end', { assistant });
  emit({ type: 'message_end', message: { role: 'assistant', ...assistant } });
  record('agent_end');
  emit({ type: 'agent_end' });
  record('agent_settled', { idle: true });
  emit({ type: 'agent_settled' });
  setTimeout(() => process.exit(ok ? 0 : 1), 20);
}

let started = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try { request = JSON.parse(trimmed); } catch { return; }
  if (!request || typeof request !== 'object' || typeof request.id !== 'string' || typeof request.type !== 'string') return;
  if (request.type === 'get_state') {
    note('rpc get_state');
    respond(request.id, 'get_state', {
      model: { provider: config.requested.provider, id: config.requested.model },
      thinkingLevel: config.requested.thinking,
      sessionFile: config.sessionFile,
      sessionId: sessionId(),
      isStreaming: false,
    });
    return;
  }
  if (request.type === 'prompt') {
    note('rpc prompt');
    respond(request.id, 'prompt', { accepted: true });
    if (started) return;
    started = true;
    runPlan().then(outcome => finish(true, outcome)).catch(error => {
      try { writeWorkspace('worker-error.json', { at: new Date().toISOString(), message: String(error && error.message ? error.message : error).slice(0, 1024) }); } catch { /* bounded best effort */ }
      finish(false, error && error.message ? error.message : error);
    });
    return;
  }
  respond(request.id, request.type, undefined, false, 'unsupported RPC command for the inert fixture worker');
});

record('session_start');
receipt.ready = true;
flushReceipt();
note(`started pid=${process.pid} workspace=${config.workspace}`);
