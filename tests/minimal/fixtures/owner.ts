import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../../extensions/p2o/index.js';
import type { SandboxOptions } from '../../../src/sandbox.js';
import type { Target } from '../../../src/target.js';
import { InertSandbox } from '../helpers/inert-sandbox.js';
import { createFakeHerdr } from './fake-herdr.js';
import { registerInertProvider } from './inert-provider.js';
import { plannerWakePrompt } from '../../../src/planner-bridge.js';

export { InertSandbox };

// The fixture is also used as the owner process; tests point P2O_TEST_* at their own temp paths.
export default async function (pi: ExtensionAPI) {
  const installed = process.env.P2O_TEST_INSTALLED_EXTENSION;
  const register = installed ? (await import(installed)).registerP2O : registerP2O;
  registerInertProvider(pi, 'owner');
  // Test-only stale-message injection, not an extension/runtime command.
  pi.registerCommand('fixture-stale-wake',{description:'Inject a deliberately obsolete inert wake',handler:async()=>{
    pi.sendUserMessage(plannerWakePrompt({runId:'run-obsolete',epoch:0,through:1,round:1}),{deliverAs:'followUp'});
  }});
  // Hermetic delegation transport for tests: same Herdr contract, child `pi` processes instead of panes.
  const fake = process.env.P2O_TEST_FAKE_HERDR === '1'
    ? createFakeHerdr({
      cwd: process.env.P2O_TEST_CWD ?? process.cwd(),
      piBinary: process.env.P2O_TEST_PI_BINARY ?? 'pi',
      ...(process.env.P2O_TEST_WORKER_EXT ? { replaceExtensionArg: process.env.P2O_TEST_WORKER_EXT } : {}),
    })
    : undefined;
  register(pi, {
    ...(installed ? { extensionPath: installed } : {}),
    ...(fake ? { herdr: fake } : {}),
    createSandbox: (target: Target, _options: SandboxOptions) => new InertSandbox(target),
    ...(process.env.P2O_TEST_SETTINGS ? { settingsPath: process.env.P2O_TEST_SETTINGS } : {}),
    ...(process.env.P2O_TEST_CONTROL_ROOT ? { controlRoot: process.env.P2O_TEST_CONTROL_ROOT } : {}),
    ...(process.env.P2O_TEST_WORKER_EXT ? { workerExtensionPath: process.env.P2O_TEST_WORKER_EXT } : {}),
  });
  // S1/C1 test-only opt-in: `p2o_graph_record` is a worker/validation verb and never part of the production planner
  // loadout, but the three inert owner fixtures record graph rows as part of their scripted flow. Activate it for their
  // turns only; authority.test.ts and context-budget.test.ts pin the real loadouts, so this cannot widen the shipped surface.
  if (['P2O_TEST_GRAPH_OWNER', 'P2O_TEST_CASE_OWNER', 'P2O_TEST_WORK_OWNER'].some(key => process.env[key] === '1')) {
    pi.on('before_agent_start', () => {
      const active = pi.getActiveTools();
      if (!active.includes('p2o_graph_record')) pi.setActiveTools([...active, 'p2o_graph_record']);
    });
  }
}
