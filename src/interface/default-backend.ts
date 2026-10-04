import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InterfaceError, type BackendFactoryContext, type ControlBackend } from './types.js';

const methods = ['preflight', 'start', 'resume', 'stop', 'status', 'tasks', 'evidence', 'report', 'events', 'close'] as const;
export function assertBackend(value: unknown): asserts value is ControlBackend {
  if (!value || typeof value !== 'object' || methods.some(m => typeof (value as Record<string, unknown>)[m] !== 'function')) {
    throw new InterfaceError('INTEGRATION_INVALID', 'trusted control composition must implement the complete ControlBackend contract');
  }
}

/** Bundled first-use backend by default; explicit owner-private modules remain advanced overrides.
 * Never selects fixtures, executable target config or unsandboxed host tools as a fallback. */
export async function createDefaultBackend(context: BackendFactoryContext): Promise<ControlBackend> {
  const path = process.env.P2O_CONTROL_MODULE;
  if (!path) {
    const { createP2OBackend } = await import('../application/backend.js');
    return createP2OBackend(context);
  }
  if (!isAbsolute(path) || !/\.(mjs|js)$/.test(path)) throw new InterfaceError('INTEGRATION_INVALID', 'control module must be an absolute ESM .mjs/.js file');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new InterfaceError('INTEGRATION_UNTRUSTED', 'control composition must be an owner-controlled regular file, not a link or group/world-writable file');
  }
  if (await realpath(path) !== path) throw new InterfaceError('INTEGRATION_UNTRUSTED', 'control composition path must be canonical');
  const module = await import(pathToFileURL(path).href) as { createP2OBackend?: (context: BackendFactoryContext) => Promise<unknown> | unknown };
  if (typeof module.createP2OBackend !== 'function') throw new InterfaceError('INTEGRATION_INVALID', 'missing createP2OBackend export');
  // The full host context (cwd plus the opaque plan-author seam/slot) is forwarded unchanged: the
  // composition may late-bind the session model author, and it never receives anything else here.
  const backend = await module.createP2OBackend(context);
  assertBackend(backend);
  return backend;
}
