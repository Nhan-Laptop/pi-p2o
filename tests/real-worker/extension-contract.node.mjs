#!/usr/bin/env node
// Contract test for the real operational worker bridge extension.
//
// Plain `node --test tests/real-worker/extension-contract.node.mjs`. It loads the real extension factory with
// a stub Pi API, starts a real `node:net` server implementing the supervisor bridge framing, and asserts the
// exact frames the extension emits. There is no model call and no network beyond that loopback unix socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionPath = path.join(repoRoot, 'examples', 'local-assessment', 'bridge-extension.js');
const extensionSha256 = createHash('sha256').update(fs.readFileSync(extensionPath)).digest('hex');
const EXTENSION_TOOLS = ['p2o_context', 'p2o_broker', 'p2o_packet'];

/** Controller-derived `attempt.state` data: identity/scope/runtime plus the owner-approved observation menu. */
const CONTEXT_DATA = {
  runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', ownerId: 'owner-1',
  sequence: 1, lifecycleState: 'running',
  requestedRuntime: { adapter: 'headless', selection: { provider: 'contract-fixture', model: 'contract-fixture', thinking: 'max' } },
  observedRuntime: null,
  scope: { hosts: ['127.0.0.1'] }, question: { text: 'contract fixture question' }, inputRevision: 'rev-1',
  allowedActions: ['read'], skills: ['source-review'],
  observations: [{ observationId: 'map-source', tool: 'source.analyze', kind: 'source', classification: 'indirect', summary: 'contract fixture observation' }],
};

/** Controller-minted `broker.execute` data; the worker only ever sees this redacted result. */
const BROKER_DATA = { evidenceId: 'check-1-attempt-1', kind: 'source', outcome: 'passed', data: { hops: [] } };

// The factory reads P2O_CONFIG when it is called, so one module instance serves every fixture below.
const { default: bridgeExtension } = await import(pathToFileURL(extensionPath).href);

/** Minimal Pi API stub; captures every registered tool definition verbatim. */
function stubApi() {
  const tools = [];
  return { tools, api: { registerTool: definition => { tools.push(definition); } } };
}

function writeFixture(t, { sha256, tools }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2o-extension-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const controlDir = path.join(root, 'control');
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(root, 'bridge.sock');
  const configPath = path.join(root, 'worker.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    version: 1,
    token: 'contract-fixture-owner-token',
    workspace,
    controlDir,
    requested: { provider: 'contract-fixture', model: 'contract-fixture', thinking: 'max' },
    toolPolicy: {
      mode: 'sandbox-extension',
      boundaryId: 'extension-contract-boundary',
      extension: { path: extensionPath, sha256, approval: 'contract fixture approval' },
      tools,
    },
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, 'p2o-bridge.json'), `${JSON.stringify({ socketPath, taskId: 'task-1' })}\n`, { mode: 0o600 });
  return { root, workspace, controlDir, socketPath, configPath };
}

function useConfig(t, configPath) {
  const previous = process.env.P2O_CONFIG;
  process.env.P2O_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.P2O_CONFIG; else process.env.P2O_CONFIG = previous; });
}

/** Real supervisor-framing server: `{id,taskId,token,operation,payload}` line in, `{id,ok,data}` line out. */
async function startBridge(t, socketPath) {
  const frames = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let end = buffer.indexOf('\n');
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf('\n');
        if (!line) continue;
        const frame = JSON.parse(line);
        frames.push(frame);
        const data = frame.operation === 'attempt.state' ? CONTEXT_DATA : BROKER_DATA;
        socket.write(`${JSON.stringify({ id: frame.id, ok: true, data })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(() => { fs.rmSync(socketPath, { force: true }); resolve(); });
  }));
  return { frames };
}

test('the extension emits the exact supervisor frames for p2o_context and p2o_broker', async (t) => {
  const fixture = writeFixture(t, { sha256: extensionSha256, tools: EXTENSION_TOOLS });
  useConfig(t, fixture.configPath);
  const bridge = await startBridge(t, fixture.socketPath);

  const { api, tools } = stubApi();
  bridgeExtension(api);

  assert.deepEqual(tools.map(tool => tool.name), EXTENSION_TOOLS);
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.parameters, 'object');
    assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);
    assert.equal(typeof tool.execute, 'function');
  }
  const [context, broker] = tools;
  assert.deepEqual(Object.keys(broker.parameters.properties), ['observationId']);
  assert.deepEqual(Object.keys(context.parameters.properties), []);
  const guidance = [...context.promptGuidelines, ...broker.promptGuidelines].join('\n');
  assert.match(guidance, /p2o_context first/);
  assert.match(guidance, /exactly once per owner-approved observationId/);
  assert.match(guidance, /denial is a result/);
  assert.match(guidance, /never invent evidence ids/i);
  assert.match(guidance, /exactly one p2o_packet/);

  const contextResult = await context.execute('call-context', {}, undefined);
  assert.equal(bridge.frames.length, 1);
  const contextFrame = bridge.frames[0];
  assert.deepEqual(Object.keys(contextFrame).sort(), ['id', 'operation', 'payload', 'taskId', 'token']);
  assert.equal(contextFrame.operation, 'attempt.state');
  assert.deepEqual(contextFrame.payload, {});
  assert.equal(contextFrame.taskId, 'task-1');
  assert.equal(contextFrame.token, 'contract-fixture-owner-token');
  assert.match(contextFrame.id, /^[0-9a-f-]{36}$/);
  assert.equal(contextResult.content[0].type, 'text');
  assert.deepEqual(JSON.parse(contextResult.content[0].text), CONTEXT_DATA);

  const brokerResult = await broker.execute('call-broker', { observationId: 'map-source' }, undefined);
  assert.equal(bridge.frames.length, 2);
  const brokerFrame = bridge.frames[1];
  assert.deepEqual(Object.keys(brokerFrame).sort(), ['id', 'operation', 'payload', 'taskId', 'token']);
  assert.equal(brokerFrame.operation, 'broker.execute');
  assert.deepEqual(brokerFrame.payload, { observationId: 'map-source' });
  assert.equal(brokerFrame.taskId, 'task-1');
  assert.equal(brokerFrame.token, 'contract-fixture-owner-token');
  assert.equal(brokerResult.content[0].type, 'text');
  assert.deepEqual(JSON.parse(brokerResult.content[0].text), BROKER_DATA);

  // A widened, empty or malformed selection must throw locally and never widen the bridge payload.
  await assert.rejects(() => broker.execute('call-wide', { observationId: 'map-source', tool: 'http.request' }, undefined), /unexpected fields: tool/);
  await assert.rejects(() => broker.execute('call-empty', {}, undefined), /missing fields: observationId/);
  await assert.rejects(() => broker.execute('call-blank', { observationId: '' }, undefined), /bounded non-empty string/);
  await assert.rejects(() => context.execute('call-context-wide', { taskId: 'task-1' }, undefined), /unexpected fields: taskId/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(bridge.frames.length, 2);
});

test('a tampered policy pin refuses to register any tool', (t) => {
  const tampered = extensionSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  const fixture = writeFixture(t, { sha256: tampered, tools: EXTENSION_TOOLS });
  useConfig(t, fixture.configPath);
  const { api, tools } = stubApi();
  assert.throws(() => bridgeExtension(api), /pinned extension digest mismatch/);
  assert.equal(tools.length, 0);
});
