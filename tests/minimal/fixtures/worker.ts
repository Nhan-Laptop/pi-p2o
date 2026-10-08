import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../../extensions/p2o/index.js';
import { registerInertProvider } from './inert-provider.js';

/**
 * Worker pane fixture: registers the inert provider, then the real extension with the real identity
 * path so the owner-minted ticket still validates. Used only because tests must not call a live model.
 */
export const REAL_EXTENSION = fileURLToPath(new URL('../../../extensions/p2o/index.ts', import.meta.url));

export default async function (pi: ExtensionAPI) {
  const installed = process.env.P2O_TEST_INSTALLED_EXTENSION;
  const register = installed ? (await import(installed)).registerP2O : registerP2O;
  registerInertProvider(pi, 'worker');
  register(pi, { extensionPath: installed ?? REAL_EXTENSION });
}
