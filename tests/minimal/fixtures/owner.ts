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
}
