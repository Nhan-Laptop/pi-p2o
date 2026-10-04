import { HeadlessRuntimeAdapter, type ManagedRuntimeOptions } from '../runtime/index.js';
import type { RuntimeHandle, RuntimeRequest, RuntimeStatus } from '../runtime/types.js';

const SETTLED_STATUSES: RuntimeStatus[] = ['settled', 'completed', 'failed', 'cancelled', 'timed-out', 'stopped', 'quarantined'];

/**
 * Headless adapter with a readiness barrier.
 *
 * The runtime adapter persists a launch intent, then spawns the guardian and captures its kernel identity in a
 * background pipeline. The deterministic supervisor reconciles every newly leased attempt on its first pump
 * (`!probed.has(attemptId)`), and an attempt whose launch intent exists but whose guardian identity is not yet
 * captured is correctly reported as unverifiable, which quarantines a healthy launch.
 *
 * This subclass waits (bounded by the startup timeout, inside `adapter.start`) until the launch pipeline has
 * both a native guardian identity and an effective runtime-selection receipt (`get_state`), or has settled.
 * Only then can the supervisor build a schema-valid observed-runtime record for its first observation. Research
 * completion is still nonblocking; only the ownership/attestation readiness step moves before the return.
 */
export class OwnedHeadlessRuntime extends HeadlessRuntimeAdapter {
  override async start(request: RuntimeRequest): Promise<RuntimeHandle> {
    const handle = await super.start(request);
    const end = Math.min(handle.deadlineAt, Date.now() + (this.options.startupTimeoutMs ?? 10_000));
    for (;;) {
      const entry = await this.owned(handle);
      try { await this.refresh(entry); }
      catch { /* a receipt failure is reported through the handle and observed by the supervisor */ }
      const owned = entry.h.native.guardian || entry.h.native.processes.length || entry.h.launchIntent === false;
      const attested = entry.h.observed.some(receipt => receipt.thinking !== undefined);
      // Prompt delivery means the owned process is executing; 'running' (agent started) is equivalent for
      // runtimes that emit the agent_start event. Both are required so the supervisor's first observation
      // cannot regress a lifecycle the reconciliation pass already advanced to 'running'.
      const started = entry.h.status === 'running' || entry.h.status === 'prompt-delivered' || SETTLED_STATUSES.includes(entry.h.status);
      if (entry.h.stopReceipt || entry.h.startupError || SETTLED_STATUSES.includes(entry.h.status)) return structuredClone(entry.h);
      if (owned && attested && started) return structuredClone(entry.h);
      if (Date.now() >= end) return structuredClone(entry.h);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

export function createOwnedHeadlessRuntime(options: ConstructorParameters<typeof HeadlessRuntimeAdapter>[0]): OwnedHeadlessRuntime {
  return new OwnedHeadlessRuntime(options);
}

export type { ManagedRuntimeOptions };
