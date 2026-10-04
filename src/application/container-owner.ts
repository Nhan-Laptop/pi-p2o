import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SessionReleaseRegistry } from '../runtime/sessions.js';
import { LinuxProcessProbe } from '../runtime/processes.js';
import { registerPackSessionFamily } from '../runtime/pack-lifecycle.js';
import type { SessionScope } from '../runtime/types.js';
import { recoverContainerResources, type ContainerLifecycleBinding, type ContainerRecoveryOptions, type SourceContainerSandbox } from '../tools/container.js';

/** Separate durable controller lease: preflight probes must never borrow a worker's authority. */
export async function createControllerContainerOwner(controlRoot: string, runId: string, engine: ContainerRecoveryOptions) {
  const probe = new LinuxProcessProbe();
  const owner = (await probe.snapshot()).find(row => row.pid === process.pid);
  if (!owner) throw new Error('CONTROLLER_IDENTITY_UNAVAILABLE: no exact kernel process identity');
  const scope: SessionScope = { runId, taskId: 'controller-preflight', attemptId: `controller-${randomUUID()}` };
  const token = randomUUID();
  const registry = new SessionReleaseRegistry({ root: join(controlRoot, 'container-controller-sessions'), probe, now: Date.now, monoNow: () => performance.now() });
  const sandboxes = new Set<SourceContainerSandbox>();
  const pack = {
    async releaseAttempt(candidate: SessionScope) { let released = 0; for (const sandbox of sandboxes) released += await sandbox.releaseAttempt(candidate); return released; },
    outstanding(candidate: SessionScope) { return [...sandboxes].reduce((sum, sandbox) => sum + sandbox.outstanding(candidate), 0); },
    async close() { for (const sandbox of sandboxes) await sandbox.close(); },
  };
  registerPackSessionFamily(registry, {
    name: 'container-pack', lookup: candidate => candidate.attemptId === scope.attemptId ? pack : undefined,
    recover: (resources, candidate, previous) => recoverContainerResources(resources, candidate, previous, engine),
    shutdown: () => pack.close(),
  });
  const swept = await registry.sweepStale(owner);
  if (!swept.verified) throw new Error('CONTROLLER_CLEANUP_UNVERIFIED: unresolved prior container resources block new preflight');
  await registry.open(scope, token, owner);
  const binding: ContainerLifecycleBinding = { scope, lifecycle: registry.binding(scope, token, 'container-pack') };
  return {
    binding, registry,
    attach(value: SourceContainerSandbox) { if (sandboxes.size >= 16 && !sandboxes.has(value)) throw new Error('Controller sandbox instance bound exceeded'); sandboxes.add(value); },
    async close() {
      const receipt = await registry.release(scope, token, 'completed');
      if (!receipt.verified) throw new Error(`CONTROLLER_CLEANUP_UNVERIFIED: ${receipt.evidenceNote ?? JSON.stringify(receipt.releasers)}`);
      await pack.close();
    },
  };
}
export type ControllerContainerOwner = Awaited<ReturnType<typeof createControllerContainerOwner>>;
