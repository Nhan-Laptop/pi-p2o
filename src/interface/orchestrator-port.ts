import type { RunAdmission, SupervisorApi } from '../orchestrator/types.js';
import { InterfaceError, type CancellationReceipt, type Issue } from './types.js';
import type { SupervisorPort } from './supervisor-backend.js';

/** The registered adapter surface needed to answer readiness without launching anything. */
export interface RegisteredRuntime {
  readonly kind: string;
  readonly capabilities: { readonly ownsLifecycle: boolean };
}

export interface OrchestratorPortOptions {
  /** Exact per-target concurrency granted to every approved target, clamped by the run's global budget. Default 1 (conservative). */
  perTargetConcurrency?: number;
  /**
   * Registered runtime adapters. When supplied, `preflight` reports real readiness (a missing or
   * non-owning adapter is an issue) instead of deferring every adapter check to dispatch. When
   * absent, readiness is explicitly reported as unverified rather than assumed.
   */
  runtimes?: Readonly<Record<string, RegisteredRuntime>>;
  /** Extra hook after cancel, e.g. an owner-side termination attestation. */
  verifyCancellation?: (snapshot: unknown) => { terminationVerified: boolean; failures?: readonly { code: string; message: string }[] };
}
const terminal = new Set(['exited', 'failed', 'timed-out', 'cancelled']);
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || !value) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function derivedCancellation(snapshot: unknown): CancellationReceipt | undefined {
  const attempts = field(snapshot, 'attempts');
  const leases = field(snapshot, 'outstandingLeases');
  if (!Array.isArray(attempts) || !Array.isArray(leases)) return undefined;
  const live = attempts.filter(a => !terminal.has(String(field(a, 'lifecycleState'))));
  const draining = field(snapshot, 'draining') === true;
  const failures: { code: string; message: string }[] = [];
  if (draining) failures.push({ code: 'DRAINING', message: 'supervisor still reports draining owned execution' });
  if (live.length) failures.push({ code: 'ATTEMPT_NOT_TERMINAL', message: `${live.length} attempt(s) have no terminal lifecycle state` });
  if (leases.length) failures.push({ code: 'OUTSTANDING_OWNERSHIP', message: `${leases.length} workspace lease(s) still held pending verified termination` });
  return { runId: '', schedulingStopped: !draining, terminationVerified: !draining && !live.length && !leases.length, failures };
}
/** A grant is exact: invalid options fail closed instead of being silently widened or rounded. */
function requestedLimit(option: unknown): number {
  if (option === undefined) return 1;
  if (typeof option !== 'number' || !Number.isSafeInteger(option) || option < 1) {
    throw new InterfaceError('INTEGRATION_INVALID', 'perTargetConcurrency must be a positive safe integer; the interface never rounds or widens a concurrency grant');
  }
  return option;
}
/**
 * Exact mapping from the deterministic supervisor's public `SupervisorApi` onto the interface port.
 * Admission stays the supervisor's decision: this adapter always requests managed ownership mode and
 * supplies one exact per-target limit per approved target, never above `budgets.maxConcurrency`.
 * The interface's own `run.admitted` receipt keeps the fixture/assessment label; the supervisor
 * records ownership `mode` and `safetyMode` in `orchestrator.run-admitted`. `start` returns promptly
 * and never waits for settlement; `cancel` reports verified termination only from the supervisor's
 * own snapshot of draining state, non-terminal attempts and outstanding leases.
 */
export function createOrchestratorPort(api: SupervisorApi, options: OrchestratorPortOptions = {}): SupervisorPort {
  const requested = requestedLimit(options.perTargetConcurrency);
  return {
    admitRun({ manifest }) {
      // At most the option, and never above the run's own global concurrency budget.
      const perTarget = Object.fromEntries(manifest.authorization.targets.map(target => [target.id, Math.min(requested, manifest.budgets.maxConcurrency)]));
      const admission: RunAdmission = { manifest, mode: 'managed', perTargetConcurrency: perTarget };
      return api.admitRun(admission);
    },
    preflight({ manifest }) {
      const issues: Issue[] = [];
      const warnings: string[] = [];
      if (!options.runtimes) {
        warnings.push('registered runtime adapters were not supplied to the interface port; adapter readiness is rechecked at dispatch and is not attested here');
      } else {
        const adapter = manifest.requestedRuntime.adapter;
        const runtime = options.runtimes[adapter];
        if (!runtime) issues.push({ code: 'RUNTIME_NOT_REGISTERED', message: `no registered runtime adapter for ${adapter}; managed admission would reject this manifest` });
        else if (runtime.kind === 'plan' || runtime.capabilities.ownsLifecycle !== true) {
          issues.push({ code: 'UNMANAGED_RUNTIME_REJECTED', message: `runtime ${adapter} does not own lifecycle; it cannot own stop, resume or verification` });
        }
      }
      return { issues, warnings };
    },
    start(runId) { return api.start(runId); },
    async cancel(runId) {
      const snapshot = await api.cancel(runId);
      const external = options.verifyCancellation?.(snapshot);
      if (external) return { runId, schedulingStopped: true, terminationVerified: external.terminationVerified, failures: [...(external.failures ?? [])] };
      const derived = derivedCancellation(snapshot);
      return derived ? { ...derived, runId } : { runId, schedulingStopped: false, terminationVerified: false,
        failures: [{ code: 'TERMINATION_UNVERIFIED', message: 'supervisor snapshot did not expose draining/lease/attempt ownership state' }] };
    },
    recover(runId) { return api.recover(runId); },
    snapshot(runId) { return api.snapshot(runId); },
    dispose() { api.dispose(); },
  };
}
