import { digest } from '../../policy/validation.js';
import type { ContainerSandboxOptions } from '../../tools/container.js';
import type { HostBrowserSandboxOptions, FixtureSandboxOptions } from '../../tools/sandbox.js';

type ContainerConfig = Omit<ContainerSandboxOptions, 'runner' | 'fixtureAcknowledgement' | 'lifecycle' | 'controllerLifecycle' | 'approvedSource'>;
export type PackBoundaryConfiguration =
  | { kind: 'container'; settings: ContainerConfig }
  | { kind: 'host-browser'; settings: HostBrowserSandboxOptions }
  | { kind: 'trusted-local'; settings: FixtureSandboxOptions; trustedOwnerModules: true };

/** Config is operator-reviewed data, never executable extensions or repository-authored callbacks. */
export function packConfigurationDigest(config: PackBoundaryConfiguration): string {
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === undefined) return;
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('PACK_CONFIG_NOT_DATA');
    if (value && typeof value === 'object') {
      if (seen.has(value) || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('PACK_CONFIG_NOT_DATA');
      seen.add(value);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (descriptor.get || descriptor.set || ['runner', 'fixtureAcknowledgement', 'lifecycle', 'controllerLifecycle', 'approvedSource', '__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('PACK_CONFIG_NOT_DATA');
        visit(descriptor.value);
      }
      seen.delete(value);
    }
  };
  visit(config);
  if (!config || !['container', 'host-browser', 'trusted-local'].includes(config.kind)) throw new Error('PACK_CONFIG_INVALID');
  return digest(config);
}
