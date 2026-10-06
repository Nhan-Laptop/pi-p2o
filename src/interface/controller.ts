import { resolve } from 'node:path';
import { startDashboard, type DashboardHandle } from './dashboard.js';
import { projectEvents, projectPage, projectPreflight, projectReport, projectSnapshot, publicValue } from './presentation.js';
import { validate, type Action, type Input } from './schemas.js';
import type { TargetEntryPort } from './target-entry.js';
import { InterfaceError, type BackendFactory, type CancellationReceipt, type ControlBackend, type PlanAuthorSlot, type RunHandle, type StartInput, type SubtaskRequestInput, type SwitchModelInput } from './types.js';
export class InterfaceController {
  private backendPromise?: Promise<ControlBackend>;
  private cwd?: string;
  private closed = false;
  private closing?: Promise<void>;
  private dashboard?: DashboardHandle;
  private dashboardRun?: string;
  private dashboardQueue: Promise<void> = Promise.resolve();
  private launches = new Set<Promise<unknown>>();
  private launchSignals = new Set<AbortController>();
  private ownedRuns = new Set<string>();
  /**
   * Session-scoped, mutable model-author slot. The backend factory is built once, but the host model
   * author is only known when a `/p2o` command runs: the composition reads this slot at plan time, so a
   * status/tool call first can never leave a later `--target` command without the session author (and
   * the first call that does supply one upgrades the already-created backend without rebuilding it).
   */
  private readonly planAuthorSlot: PlanAuthorSlot = {};
  private readonly onboardingSlot: import('./types.js').OnboardingSlot = {};

  constructor(private readonly factory: BackendFactory, private readonly ownerStorageRoot?: string) {}

  private backend(cwd: string, planAuthor?: unknown): Promise<ControlBackend> {
    if (this.closed) throw new InterfaceError('CLOSED', 'interface session is closed');
    const canonical = resolve(cwd);
    if (this.cwd && this.cwd !== canonical) throw new InterfaceError('SESSION_CWD_CHANGED', 'reload the interface before changing projects');
    if (planAuthor !== undefined) this.planAuthorSlot.current = planAuthor;
    if (!this.backendPromise) {
      this.cwd = canonical;
      this.backendPromise = Promise.resolve().then(() => this.factory({ cwd: canonical,
        planAuthor: this.planAuthorSlot.current, planAuthorSlot: this.planAuthorSlot,
        onboarding: this.onboardingSlot.current, onboardingSlot: this.onboardingSlot,
        ...(this.ownerStorageRoot ? { ownerStorageRoot: this.ownerStorageRoot } : {}) }));
      // A failed lazy factory is retryable; it never silently creates a fixture fallback.
      this.backendPromise.catch(() => { if (!this.closed) this.backendPromise = undefined; });
    }
    return this.backendPromise;
  }

  async execute<A extends Action>(action: A, raw: unknown, cwd: string, signal?: AbortSignal,
    privateDashboardLink?: (accessUrl: string) => void, origin: 'tool' | 'command' = 'tool'): Promise<unknown> {
    const input = validate(action, raw);
    if (action === 'orchestrate') throw new InterfaceError('ORCHESTRATION_SESSION_REQUIRED', 'foreground controls require the live Pi session bridge; the backend cannot activate one');
    // Plan approval is a human decision, never a model tool call. Only the `/p2o approve <planId>` command
    // passes origin 'command'.
    if (action === 'plan' && (input as Input<'plan'>).action === 'approve' && origin !== 'command') {
      throw new InterfaceError('APPROVAL_HUMAN_ONLY', 'plan approval is an explicit human command; run /p2o approve <planId> and never approve from a tool');
    }
    if (action !== 'stop' && action !== 'dashboard') this.assertNotCancelled(signal);
    if (action === 'dashboard') {
      const d = input as Input<'dashboard'>;
      const operation = this.dashboardQueue.then(async () => {
        if (d.action === 'close') { await this.closeDashboard(); return { closed: true, assessmentStopped: false }; }
        if (!privateDashboardLink) throw new InterfaceError('DASHBOARD_UI_REQUIRED', 'open from a user-facing Pi command/UI; the access token is never returned to the model');
        this.assertNotCancelled(signal);
        const backend = await this.backend(cwd);
        if (this.dashboard && this.dashboardRun !== d.runId) await this.closeDashboard();
        if (!this.dashboard) {
          const handle = await startDashboard({ backend, runId: d.runId!, enabled: true });
          if (this.closed || signal?.aborted) { await handle.close(); throw new InterfaceError('CANCELLED', 'dashboard opening cancelled'); }
          this.dashboard = handle;
          this.dashboardRun = d.runId;
        }
        privateDashboardLink(this.dashboard.accessUrl);
        return { url: this.dashboard.url, runId: d.runId, readOnly: true, tokenDelivery: 'private-user-notification' };
      });
      this.dashboardQueue = operation.then(() => {}, () => {});
      return operation;
    }
    const backend = await this.backend(cwd);
    this.assertOpen();
    if (action === 'start' || action === 'resume') {
      const request = input as Input<'start'> | Input<'resume'>;
      const normalized = { ...request, manifestPath: resolve(cwd, request.manifestPath.replace(/^@/, '')) };
      return this.launch(backend, action, normalized, signal);
    }
    if (action === 'preflight' || action === 'doctor') {
      const request = input as StartInput;
      const normalized = { ...request, manifestPath: resolve(cwd, request.manifestPath.replace(/^@/, '')) };
      const operation = action === 'doctor' && backend.doctor ? backend.doctor(normalized, signal) : backend.preflight(normalized, signal);
      return projectPreflight(await operation);
    }
    if (action === 'stop') {
      const s = input as Input<'stop'>;
      // Cancellation cleanup is deliberately not tied to the parent/tool abort signal.
      return publicValue(await this.stop(backend, s.runId, s.reason ?? 'user-requested cancellation'));
    }
    if (action === 'status') return projectSnapshot(await backend.status((input as Input<'status'>).runId));
    if (action === 'tasks' || action === 'evidence') {
      const p = input as Input<'evidence'>;
      const page = { offset: p.offset ?? 0, limit: p.limit ?? 50 };
      return projectPage(action === 'tasks' ? await backend.tasks(p.runId, page) : await backend.evidence(p.runId, page, p.evidenceId), action);
    }
    if (action === 'switch_model') {
      if (!backend.switchModel) throw new InterfaceError('INTEGRATION_REQUIRED', 'this composition does not expose owner-gated model switches');
      return publicValue(await backend.switchModel(input as SwitchModelInput));
    }
    if (action === 'subtask') {
      if (!backend.requestSubtask) throw new InterfaceError('INTEGRATION_REQUIRED', 'this composition does not expose supervisor-adjudicated subtask requests');
      return publicValue(await backend.requestSubtask(input as SubtaskRequestInput));
    }
    if (action === 'plan') {
      if (!backend.plan) throw new InterfaceError('INTEGRATION_REQUIRED', 'this composition does not expose the planner approval path');
      const p = input as Input<'plan'>;
      if (p.action === 'propose') {
        return publicValue(await backend.plan({ action: 'propose', runId: p.runId, proposalPath: resolve(cwd, p.proposalPath!.replace(/^@/, '')) }, signal));
      }
      if (p.action === 'approve') {
        return publicValue(await backend.plan({ action: 'approve', runId: p.runId, proposalDigest: p.proposalDigest!, approvalPath: resolve(cwd, p.approvalPath!.replace(/^@/, '')) }, signal));
      }
      return publicValue(await backend.plan({ action: 'read', runId: p.runId, ...(p.proposalId ? { proposalId: p.proposalId } : {}) }, signal));
    }
    if (action === 'report') {
      const p = input as Input<'report'>;
      return projectReport(await backend.report(p.runId, p.format ?? 'json'));
    }
    const p = input as Input<'events'>;
    return projectEvents(await backend.events(p.runId, { afterSequence: p.afterSequence ?? 0, limit: p.limit ?? 50 }));
  }
  /** Optional target-entry workflow from the composition. Absent means the target commands fail closed. */
  async entryPort(cwd: string, planAuthor?: unknown, onboarding?: import('../application/onboarding/types.js').OnboardingReady): Promise<TargetEntryPort | undefined> {
    if (onboarding) this.onboardingSlot.current = onboarding;
    const backend = await this.backend(cwd, planAuthor);
    this.assertOpen();
    return backend.entry;
  }

  /** Only extension message_end events call this; no model/tool can mint a usage receipt. */
  async recordForegroundUsage(runId: string, receipt: import('./types.js').ForegroundUsageReceipt, cwd: string): Promise<void> {
    const backend = await this.backend(cwd);
    await backend.recordForegroundUsage?.(runId, receipt);
  }

  private launch(backend: ControlBackend, action: 'start' | 'resume', input: StartInput | Input<'resume'>, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    this.launchSignals.add(controller);
    const work = (async () => {
      this.assertNotCancelled(controller.signal);
      const preflight = await backend.preflight(input, controller.signal);
      this.assertNotCancelled(controller.signal);
      if (!preflight.ok || preflight.issues.length) {
        throw new InterfaceError('PREFLIGHT_BLOCKED', preflight.issues.map(i => i.code).slice(0, 10).join(', ') || 'scope/runtime prerequisites failed');
      }
      const handle: RunHandle = action === 'start' ? await backend.start(input, controller.signal)
        : await backend.resume(input as Input<'resume'>, controller.signal);
      this.ownedRuns.add(handle.runId);
      if (handle.runId !== preflight.runId || handle.mode !== input.mode || controller.signal.aborted || this.closed) {
        await this.stop(backend, handle.runId, 'cancelled during interface dispatch');
        throw new InterfaceError('CANCELLED', 'dispatch cancelled or returned an inconsistent run identity');
      }
      return { ...handle, launched: true, resultAcceptance: 'not-evaluated', findingVerification: 'not-evaluated', requested: preflight.requested,
        observed: { attestation: 'unavailable', note: 'Read p2o_status for actual worker receipts; requests are not attestation.' } };
    })();
    this.launches.add(work);
    return work.finally(() => {
      signal?.removeEventListener('abort', abort);
      this.launchSignals.delete(controller);
      this.launches.delete(work);
    });
  }

  private async stop(backend: ControlBackend, runId: string, reason: string): Promise<CancellationReceipt> {
    const receipt = await backend.stop(runId, reason);
    if (receipt.runId !== runId || !receipt.schedulingStopped || !receipt.terminationVerified || receipt.failures.length) {
      throw new InterfaceError('STOP_UNVERIFIED', 'runtime termination is unresolved; ownership/fences must be retained');
    }
    this.ownedRuns.delete(runId);
    return receipt;
  }
  private assertOpen(): void { if (this.closed) throw new InterfaceError('CLOSED', 'interface session is closed'); }
  private assertNotCancelled(signal?: AbortSignal): void {
    this.assertOpen();
    if (signal?.aborted) throw new InterfaceError('CANCELLED', 'operation cancelled');
  }
  private async closeDashboard(): Promise<void> {
    const dashboard = this.dashboard;
    this.dashboard = undefined;
    this.dashboardRun = undefined;
    await dashboard?.close();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const c of this.launchSignals) c.abort();
    this.closing = (async () => {
      const errors: unknown[] = [];
      await this.dashboardQueue;
      try { await this.closeDashboard(); } catch (error) { errors.push(error); }
      await Promise.allSettled([...this.launches]);
      if (this.backendPromise) {
        let backend: ControlBackend | undefined;
        try { backend = await this.backendPromise; } catch { /* failed factory acquired no runtime ownership */ }
        if (backend) {
          for (const runId of this.ownedRuns) {
            try { await this.stop(backend, runId, 'Pi session shutdown'); } catch (error) { errors.push(error); }
          }
          try { await backend.close(); } catch (error) { errors.push(error); }
        }
      }
      if (errors.length) throw new InterfaceError('CLEANUP_UNVERIFIED', 'cleanup encountered unresolved runtime/resource failures; no termination success is claimed');
    })();
    return this.closing;
  }
}
