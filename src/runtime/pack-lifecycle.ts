import { alive, LinuxProcessProbe, sameProcess } from './processes.js';
import type { AttemptSessionPack, SessionReleaseRegistry } from './sessions.js';
import type { ProcessIdentity, SessionLeaseOwner, SessionReleaser, SessionResourceRecord, SessionScope } from './types.js';
import { samePackScope } from '../tools/pack-session.js';

export interface PackFamilyRegistration {
  name: string;
  /** Exact instances shared with dispatch, never a newly constructed empty pack. */
  lookup(scope: SessionScope): AttemptSessionPack | undefined;
  recover(resources: readonly SessionResourceRecord[], scope: SessionScope, owner: SessionLeaseOwner): Promise<{ released: number; resolved: readonly string[] }>;
  shutdown(): Promise<void>;
}

/** Bounded by SessionReleaseRegistry. Useful for browser/proxy and container daemon-backed families. */
export function registerPackSessionFamily(registry: SessionReleaseRegistry, family: PackFamilyRegistration): SessionReleaser {
  const releaser: SessionReleaser = {
    name: family.name,
    async release(scope) {
      const pack = family.lookup(scope);
      if (pack) return await pack.releaseAttempt(scope);
      const lease = await registry.read(scope);
      if (!lease || lease.resources === undefined) throw new Error(`No durable ${family.name} inventory; a missing live instance is not absence proof`);
      if ((await registry.inventory(scope, family.name)).length) throw new Error(`No live ${family.name} instance for enrolled resources; identity-checked recovery is required`);
      return 0;
    },
    async outstanding(scope) {
      const pack = family.lookup(scope);
      if (pack && !pack.outstanding) throw new Error(`${family.name} has no attributable outstanding proof`);
      return Math.max(pack ? await pack.outstanding!(scope) : 0, (await registry.inventory(scope, family.name)).length);
    },
    async sweep(scope, owner) {
      const lease = await registry.read(scope);
      if (!lease || lease.resources === undefined) throw new Error('No durable resource inventory; legacy pack absence cannot be proved by empty responders');
      const resources = await registry.inventory(scope, family.name);
      if (!resources.length) return 0; // enrollment-before-allocation proves this family created no unresolved resource
      const result = await family.recover(resources, scope, owner);
      if (result.resolved.some(id => !resources.some(resource => resource.id === id))) throw new Error('Recovery returned a foreign resource identity');
      for (const id of result.resolved) await registry.resolveResource(scope, owner.token, family.name, id);
      return result.released;
    },
    shutdown: () => family.shutdown(),
  };
  registry.register(releaser);
  return releaser;
}

/** A capture listener lives in the controller, not in an independent helper/daemon. The exact dead kernel
 * identity proves its sockets closed at exit. A reused PID or port is never signalled or otherwise touched. */
export async function recoverControllerListeners(resources: readonly SessionResourceRecord[], scope: SessionScope, owner: SessionLeaseOwner): Promise<{ released: number; resolved: string[] }> {
  if (!resources.length) throw new Error('Only a durable registry lease can prove an empty listener family');
  const rows = await new LinuxProcessProbe().snapshot();
  if (rows.some(row => sameProcess(row, owner.process) && alive(row))) throw new Error('Listener controller is still live');
  for (const resource of resources) {
    const controller = resource.data.controller as ProcessIdentity | undefined;
    const recordedScope = resource.data.scope as SessionScope | undefined;
    if (resource.state !== 'active' || !/^px-[a-f0-9]{24}$/.test(resource.id) || resource.data.version !== 1 ||
      resource.data.sessionId !== resource.id || !recordedScope || !samePackScope(recordedScope, scope) ||
      resource.data.kind !== 'controller-listener' || !controller || !sameProcess(controller, owner.process) ||
      !Array.isArray(resource.data.ports) || resource.data.ports.some(port => !Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('Listener controller/session/scope identity is unverified');
  }
  return { released: resources.length, resolved: resources.map(resource => resource.id) };
}
