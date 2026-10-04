#!/usr/bin/env node
// Loads the extension through jiti — the same TS loader Pi uses — to prove the entry point
// resolves under the real loader and registers exactly one human command plus the agent tools,
// without opening resources at load time.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const [jitiRoot, piPackage] = process.argv.slice(2);
if (!jitiRoot || !piPackage || !existsSync(piPackage)) { console.error('JITI: FAIL — missing arguments or Pi package; the loader probe is a required check'); process.exit(1); }
let createJiti;
try {
  const require = createRequire(`${piPackage}/`);
  ({ createJiti } = require('jiti'));
} catch { console.error('JITI: FAIL — jiti is not provisioned by the Pi host package; the TS loader probe is required'); process.exit(1); }

const jiti = createJiti(`${jitiRoot}/probe.mjs`, { interopDefault: true, moduleCache: false });
const mod = await jiti.import(`${jitiRoot}/extensions/p2o/index.ts`);
const assert = (condition, message) => { if (!condition) { console.error(`JITI: FAIL — ${message}`); process.exit(1); } };
assert(typeof mod.default === 'function', 'default export is not an extension factory');
assert(typeof mod.registerP2O === 'function', 'registerP2O seam is not exported');
const tools = new Map(), commands = new Set(), events = [];
const pi = {
  registerTool: (tool) => { assert(!tools.has(tool.name), `duplicate tool ${tool.name}`); tools.set(tool.name, tool); },
  registerCommand: (name) => commands.add(name),
  on: (name) => events.push(name),
  sendMessage: () => {},
};
mod.registerP2O(pi); // No injected factory: the default must fail closed without P2O_CONTROL_MODULE.
assert(tools.size === 14, `expected 14 tools, saw ${tools.size}`);
assert(commands.size === 1 && commands.has('p2o'), `expected exactly one slash command /p2o, saw ${[...commands].join(',') || 'none'}`);
assert(![...commands].some(name => name.startsWith('p2o_')), 'per-action slash commands must not be registered');
assert(tools.keys().next().value === 'p2o_start', 'first registered tool must be p2o_start');
assert(events.includes('session_start') && events.includes('session_shutdown'), 'lifecycle handlers missing');
let failedClosed = false;
try { await tools.get('p2o_status').execute('call-1', { runId: 'run-1' }, undefined, undefined, { cwd: process.cwd() }); }
catch (error) {
  const message = String(error instanceof Error ? error.message : error);
  // The packaged first-use composition loads through the real loader, then refuses without an admitted run
  // instead of falling back to a fixture: the refusal itself must name that absence.
  failedClosed = message.includes('ENTRY_RUN_UNKNOWN') && message.includes('no fake backend');
}
assert(failedClosed, 'the bundled default must fail closed without an admitted owner run and never select a fake backend');
console.log(`JITI: PASS — 14 tools and one /p2o command registered through jiti, no work at load (${[...tools.keys()].join(',')})`);
process.exitCode = 0; // explicit success; every failure path above exits 1
