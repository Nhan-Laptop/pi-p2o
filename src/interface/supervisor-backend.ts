import { readFile } from 'node:fs/promises';
import { runSchema, digestJson, canonicalJson, type RunManifest } from '../contracts/index.js';
import type { DurableStore, DurableEvent, StoredResult } from '../store/index.js';
import { InterfaceError, type CancellationReceipt, type ControlBackend, type EventPage, type EventRecord, type Events,
  type Issue, type Page, type Preflight, type RecordPage, type Report, type ResumeInput, type RunHandle, type RunMode,
  type PlanInput, type Snapshot, type StartInput, type SubtaskRequestInput, type SwitchModelInput } from './types.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MODE_EVENT = 'run.admitted';
/**
 * Bounded run identity. Resume may not renegotiate scope, budget or runtime grants: the supplied
 * manifest is compared field-for-field against the durable admitted run, not only by runId.
 */
const IDENTITY_FIELDS = ['authorization', 'budgets', 'requestedRuntime', 'allowedCapabilities'] as const;
/**
 * Structural port implemented (typically by a thin composition adapter) around the deterministic
 * supervisor's public API. Methods are optional only where the supervisor legitimately may not
 * support an operation; absence fails closed, it never degrades into a fabricated receipt.
 */
export interface SupervisorPort {
  /** Admission must independently revalidate scope/budget/role; never a plan or dry run. */
  admitRun(input: { manifest: RunManifest; mode: RunMode; perTargetConcurrency?: number }): Promise<unknown> | unknown;
  /** Launch owned execution and return promptly. Must not report research/verification completion. */
  start(runId: string): Promise<unknown> | unknown;
  /** Owned cancellation plus verified reconciliation of every attempt it owns. */
  cancel(runId: string): Promise<unknown> | unknown;
  /** Restart reconciliation: never launches or kills, and never replays a conversation. */
  recover(runId: string): Promise<unknown> | unknown;
  snapshot(runId: string): Promise<unknown> | unknown;
  /** Optional read-only admission/preflight hook. Must not mutate durable state. */
  preflight?(input: { manifest: RunManifest; mode: RunMode }): Promise<{ issues?: readonly Issue[]; warnings?: readonly string[] }> | { issues?: readonly Issue[]; warnings?: readonly string[] };
  /** Optional owner-gated control actions; absence is an explicit integration failure, never a fallback. */
  switchModel?(input: SwitchModelInput): Promise<unknown> | unknown;
  requestSubtask?(input: SubtaskRequestInput): Promise<unknown> | unknown;
  /** Optional planner port; the approval document always comes from an owner file, never from the model. */
  plan?(input: PlanInput, signal?: AbortSignal): Promise<unknown> | unknown;
  /** Optional owned teardown, invoked by the interface's close after cancel attempts. */
  dispose?(): Promise<void> | void;
}

/**
 * [T2] Credential-availability port for authenticated target access. The interface layer never holds a
 * secret: it only re-proves at preflight and again at dispatch that the owner-provisioned credential for
 * each approved account/target/action is present and unexpired. Any negative result is an explicit DENY
 * code and no run is admitted or started.
 */
export interface CredentialAvailabilityPort {
  availability(input: { accountId: string; targetId: string; action: string; at: string }): Promise<
    { ok: true; identity: { accountId: string; version: string; ref: string; expiresAt: string } }
    | { ok: false; code: string; message: string }>;
}

/** Owner-supplied requirement list. Never derived from worker input, manifests or workspace files. */
export interface CredentialRequirement { accountId: string; targetId: string; action: string }
export interface SupervisorBackendOptions {
  store: DurableStore;
  supervisor: SupervisorPort;
  /** Vault-backed report rendering supplied by the composition; required for `report` and for a ready preflight. */
  render?: (runId: string, format: Report['format']) => Promise<unknown> | unknown;
  now?: () => number;
  perTargetConcurrency?: number;
  closeStore?: boolean;
  /** [T2] Dispatch-time credential resolution boundary; absent fails closed when a plan exists. */
  credentials?: CredentialAvailabilityPort;
  /** [T2] Approved account/target/action requirements resolved at every dispatch. */
  credentialPlan?: readonly CredentialRequirement[];
  /** Optional planner port; absent makes p2o_plan fail closed with INTEGRATION_REQUIRED. */
  plan?: (input: PlanInput, signal?: AbortSignal) => Promise<unknown> | unknown;
}


function textField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || !value) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function issues(value: unknown): Issue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap(entry => {
    const code = textField(entry, 'code'), message = textField(entry, 'message');
    return typeof code === 'string' && code.length > 0 && code.length <= 120
      ? [{ code, message: typeof message === 'string' ? message.slice(0, 512) : '' }] : [];
  });
}

/** First bounded identity field whose supplied value differs from the durable admitted run. */
function identityMismatch(supplied: RunManifest, stored: RunManifest): string | undefined {
  for (const field of IDENTITY_FIELDS) {
    if (canonicalJson(supplied[field]) !== canonicalJson(stored[field])) return field;
  }
  return undefined;
}

function identityIssue(supplied: RunManifest, stored: RunManifest): Issue | undefined {
  const field = identityMismatch(supplied, stored);
  return field === undefined ? undefined : { code: 'RUN_IDENTITY_MISMATCH',
    message: `supplied manifest ${field} does not match the durable admitted run; resume never renegotiates scope, budget or runtime identity` };
}

function cancellation(runId: string, result: unknown): CancellationReceipt {
  const schedulingStopped = textField(result, 'schedulingStopped') === true;
  const terminationVerified = textField(result, 'terminationVerified') === true;
  const failures = issues(textField(result, 'failures'));
  if ((!schedulingStopped || !terminationVerified) && !failures.some(failure => failure.code === 'TERMINATION_UNVERIFIED')) {
    failures.unshift({ code: 'TERMINATION_UNVERIFIED',
      message: `supervisor cancel did not attest scheduling stop and verified termination for ${runId}` });
  }
  return { runId, schedulingStopped, terminationVerified, failures: failures.slice(0, 20) };
}

/** Maps durable store + supervisor state onto the interface port. Never launches without admission. */
export function createSupervisorBackend(options: SupervisorBackendOptions): ControlBackend {
  const { store, supervisor } = options;
  const now = options.now ?? (() => Date.now());

  // [T2] Credential readiness is resolved at preflight and re-resolved at every dispatch. The plan is
  // owner-supplied; a worker-supplied manifest field is never consulted. A missing boundary with a
  // non-empty plan fails closed rather than degrading into an unauthenticated request.
  const credentialPlan = options.credentialPlan ?? [];
  async function credentialIssues(at: string): Promise<Issue[]> {
    if (!credentialPlan.length) return [];
    if (!options.credentials) {
      return [{ code: 'CREDENTIAL_BOUNDARY_UNAVAILABLE', message: 'credential-owning boundary is not wired; credential-tier accounts cannot be dispatched' }];
    }
    const port = options.credentials;
    const found: Issue[] = [];
    for (const requirement of credentialPlan.slice(0, 64)) {
      try {
        const result = await port.availability({ ...requirement, at });
        if (!result.ok) found.push({ code: result.code.slice(0, 120), message: `account ${requirement.accountId} on target ${requirement.targetId}: ${result.message.slice(0, 384)}` });
      } catch (error) {
        found.push({ code: 'CREDENTIAL_BOUNDARY_UNAVAILABLE', message: `credential boundary failed: ${error instanceof Error ? error.message.slice(0, 256) : 'unknown error'}` });
      }
    }
    return found;
  }
  async function requireCredentials(): Promise<void> {
    const issues = await credentialIssues(new Date(now()).toISOString());
    if (issues.length) throw new InterfaceError(issues[0]!.code, issues[0]!.message);
  }


  async function manifest(input: StartInput | ResumeInput): Promise<RunManifest> {
    if (input.mode !== 'fixture' && input.mode !== 'assessment') throw new InterfaceError('INVALID_INPUT', 'explicit fixture/assessment mode required');
    const bytes = await readFile(input.manifestPath);
    if (bytes.byteLength > MAX_MANIFEST_BYTES || bytes.byteLength === 0) throw new InterfaceError('MANIFEST_INVALID', 'manifest must be a non-empty file under 1MiB');
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw new InterfaceError('MANIFEST_INVALID', 'manifest is not valid JSON'); }
    const manifest = runSchema.parse(parsed);
    if (input.selection !== undefined) {
      // A caller override is a request for the supervisor; it never rewrites approved authorization.
      manifest.requestedRuntime = { ...manifest.requestedRuntime, selection: { ...input.selection } };
    }
    if (input.runtime !== undefined && input.runtime !== manifest.requestedRuntime.adapter) {
      manifest.requestedRuntime = { ...manifest.requestedRuntime, adapter: input.runtime };
    }
    // Source-assisted fixtures retain approved, identity-bound read-only artifact inputs. The mode
    // never grants authority or network scope: web/service targets cannot use this fixture path.
    if (input.mode === 'fixture' && manifest.authorization.targets.some(t => t.kind !== 'lab' && t.kind !== 'artifact')) {
      throw new InterfaceError('FIXTURE_SCOPE_INVALID', 'fixture mode permits declared lab fixtures and approved read-only source artifacts only; web/service targets require assessment mode and independent approval');
    }
    // Managed-only guard: any explicitly non-owning adapter name is refused here; unknown adapters
    // are still rejected by the supervisor's registered-runtime admission.
    if (/^(?:plan|preview|dry[-_]?run|unmanaged)\b/i.test(manifest.requestedRuntime.adapter)) {
      throw new InterfaceError('UNMANAGED_RUNTIME_REJECTED', 'managed runs require an owning runtime adapter; a plan/dry-run adapter cannot own stop, resume or verification');
    }
    return manifest;
  }
  /**
   * Read-only readiness facts. Never mutates and never grants authority. A missing trusted
   * composition piece is a blocking issue, not a passing warning: preflight must not report a
   * run as ready when the reporting path or durable state cannot support it.
   */
  async function readinessFacts(result: Preflight): Promise<void> {
    if (!options.render) result.issues.push({ code: 'INTEGRATION_REQUIRED',
      message: 'vault-backed report renderer is not wired; p2o_report fails closed until the trusted composition supplies it' });
    if (store.schemaVersion < 1) result.issues.push({ code: 'INTEGRATION_INVALID',
      message: 'durable store schema version is unavailable; admission fails closed' });
  }
  function assertRunnable(run: RunManifest, at = new Date(now()).toISOString()): void {
    if (Date.parse(run.authorization.expiresAt) <= Date.parse(at)) throw new InterfaceError('AUTHORIZATION_EXPIRED', 'authorization window has ended; scope is not renewed automatically');
    if (Date.parse(run.authorization.validFrom) > Date.parse(at)) throw new InterfaceError('AUTHORIZATION_NOT_YET_VALID', 'authorization is not yet valid');
    if (Date.parse(run.budgets.deadlineAt) <= Date.parse(at)) throw new InterfaceError('DEADLINE_PASSED', 'absolute run deadline has passed; it cannot be extended by resume');
  }
  function admittedMode(runId: string): RunMode {
    let mode: RunMode = 'assessment';
    for (const event of store.listEvents({ runId })) {
      if (event.type !== MODE_EVENT) continue;
      const payload = textField(event.payload, 'mode');
      mode = payload === 'fixture' ? 'fixture' : 'assessment';
    }
    return mode;
  }
  function requireRun(runId: string): RunManifest {
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 160) throw new InterfaceError('INVALID_INPUT', 'invalid runId');
    const run = store.getRun(runId);
    if (!run) throw new InterfaceError('RUN_NOT_FOUND', `no durable run ${runId}`);
    return run;
  }

  return {
    async preflight(input): Promise<Preflight> {
      const run = await manifest(input);
      const result: Preflight = { ok: true, mode: input.mode, runId: run.runId,
        requested: { adapter: run.requestedRuntime.adapter, selection: run.requestedRuntime.selection }, issues: [], warnings: [] };
      try { assertRunnable(run); } catch (error) { result.issues.push({ code: error instanceof InterfaceError ? error.code : 'MANIFEST_INVALID', message: error instanceof Error ? error.message : 'unrunnable manifest' }); }
      // [T2] Read-only credential readiness: a negative result blocks readiness entirely.
      result.issues.push(...await credentialIssues(new Date(now()).toISOString()));
      if ('runId' in input) {
        if (input.runId !== run.runId) result.issues.push({ code: 'RUN_IDENTITY_MISMATCH', message: 'resume runId does not match the supplied manifest' });
        else {
          const stored = store.getRun(run.runId);
          if (!stored) result.issues.push({ code: 'RUN_NOT_FOUND', message: `no durable run ${run.runId}; resume cannot recreate an admitted run` });
          else {
            const mismatch = identityIssue(run, stored);
            if (mismatch) result.issues.push(mismatch);
            const mode = admittedMode(run.runId);
            if (input.mode !== mode) result.issues.push({ code: 'MODE_MISMATCH',
              message: `supplied mode ${input.mode} does not match the durable run.admitted mode ${mode}` });
          }
        }
      } else if (store.getRun(run.runId)) {
        result.issues.push({ code: 'RUN_EXISTS', message: 'runId already exists durably; a new run requires a new approved manifest' });
      }
      if (!supervisor.preflight) result.warnings.push('supervisor supplies no read-only preflight hook; scope/runtime admission is rechecked at dispatch');
      else {
        try {
          const hook = await supervisor.preflight({ manifest: run, mode: input.mode });
          result.issues.push(...issues(textField(hook, 'issues')));
          for (const warning of Array.isArray(textField(hook, 'warnings')) ? textField(hook, 'warnings') as unknown[] : []) {
            if (typeof warning === 'string') result.warnings.push(warning.slice(0, 512));
          }
        } catch (error) { result.issues.push({ code: 'PREFLIGHT_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : 'preflight hook failed' }); }
      }
      await readinessFacts(result);
      result.ok = result.issues.length === 0;
      return result;
    },
    async start(input): Promise<RunHandle> {
      const run = await manifest(input);
      assertRunnable(run);
      if (store.getRun(run.runId)) throw new InterfaceError('RUN_EXISTS', 'runId already exists durably; refusing a duplicate writer');
      // [T2] Dispatch-time re-resolution: preflight readiness is never reused as authority.
      await requireCredentials();
      await supervisor.admitRun({ manifest: run, mode: input.mode, ...(options.perTargetConcurrency ? { perTargetConcurrency: options.perTargetConcurrency } : {}) });
      store.appendEvent({ runId: run.runId, type: MODE_EVENT, payload: { mode: input.mode, manifestDigest: digestJson(run) } });
      await supervisor.start(run.runId);
      return { runId: run.runId, mode: input.mode };
    },
    async resume(input): Promise<RunHandle> {
      const run = await manifest(input);
      if (input.runId !== run.runId) throw new InterfaceError('RUN_IDENTITY_MISMATCH', 'resume runId does not match the supplied manifest');
      const stored = requireRun(run.runId);
      assertRunnable(stored);
      const field = identityMismatch(run, stored);
      if (field) throw new InterfaceError('RUN_IDENTITY_MISMATCH',
        `supplied manifest ${field} does not match the durable admitted run; resume never renegotiates scope, budget or runtime identity`);
      const mode = admittedMode(run.runId);
      if (input.mode !== mode) throw new InterfaceError('MODE_MISMATCH', `supplied mode ${input.mode} does not match the durable run.admitted mode ${mode}`);
      if (['completed', 'failed', 'cancelled'].includes(stored.state)) throw new InterfaceError('RUN_TERMINAL', 'terminal runs are not resumable; start a newly admitted run');
      // [T2] Resume is a dispatch: re-resolve credentials immediately before recovery/start.
      await requireCredentials();
      await supervisor.recover(run.runId);
      assertRunnable(requireRun(run.runId));
      await supervisor.start(run.runId);
      store.appendEvent({ runId: run.runId, type: 'run.resumed', payload: { mode } });
      return { runId: run.runId, mode };
    },
    async stop(runId): Promise<CancellationReceipt> {
      const run = requireRun(runId);
      const result = await supervisor.cancel(run.runId);
      return cancellation(run.runId, result);
    },
    async status(runId): Promise<Snapshot> {
      const run = requireRun(runId);
      const tasks = store.listTasks(run.runId);
      const attempts = store.listAttempts(run.runId);
      const results: StoredResult[] = store.listResults(run.runId);
      const problem = attempts.filter(a => ['failed', 'timed-out', 'cancelled', 'reconciling'].includes(a.lifecycleState));
      const returned = results.filter(r => r.decision.status !== 'accepted');
      const failures: Issue[] = [
        ...problem.map(a => ({ code: a.lifecycleState.toUpperCase(), message: `attempt ${a.attemptId} on task ${a.taskId}`, taskId: a.taskId, attemptId: a.attemptId, state: a.lifecycleState })),
        ...returned.flatMap(r => r.decision.reasons.slice(0, 4).map(reason => ({ code: reason.code, message: `packet ${r.packet.packetId}: ${reason.message}`, taskId: r.taskId, attemptId: r.attemptId, state: 'returned-for-evidence' }))),
      ];
      const supervisorState = await (async () => {
        if (!supervisor.snapshot) return undefined;
        try { return await supervisor.snapshot(run.runId); } catch { return undefined; }
      })();
      const leases = textField(supervisorState, 'outstandingLeases');
      if (textField(supervisorState, 'draining') === true) failures.push({ code: 'DRAINING', message: 'supervisor still reports draining owned execution' });
      for (const lease of Array.isArray(leases) ? leases.slice(0, 20) : []) {
        const identity = typeof lease === 'string' ? lease : textField(lease, 'taskId');
        if (typeof identity === 'string' && identity.length > 0 && identity.length <= 160) failures.push({ code: 'OUTSTANDING_OWNERSHIP', message: `workspace lease retained for ${identity} pending verified termination` });
      }
      return { mode: admittedMode(run.runId), run, tasks, attempts, packets: results, findings: store.listFindings(run.runId),
        coverage: store.listCoverage(run.runId), failures };
    },
    async tasks(runId, page: Page): Promise<RecordPage> {
      const run = requireRun(runId);
      const tasks = store.listTasks(run.runId);
      const attempts = store.listAttempts(run.runId);
      const items = tasks.slice(page.offset, page.offset + page.limit).map(task => ({ ...task, attempts: attempts.filter(a => a.taskId === task.taskId) }));
      return { items, total: tasks.length, offset: page.offset };
    },
    async evidence(runId, page: Page, evidenceId?: string): Promise<RecordPage> {
      const run = requireRun(runId);
      const items = evidenceId !== undefined ? [store.getEvidence(evidenceId)].filter((e): e is NonNullable<typeof e> => !!e && e.runId === run.runId)
        : store.listEvidence(run.runId).slice(page.offset, page.offset + page.limit);
      return { items, total: evidenceId !== undefined ? items.length : store.listEvidence(run.runId).length, offset: page.offset };
    },
    async report(runId, format): Promise<Report> {
      requireRun(runId);
      if (!options.render) throw new InterfaceError('INTEGRATION_REQUIRED', 'report rendering requires the vault-backed reporting port from the trusted composition');
      return { format, content: await options.render(runId, format) };
    },
    async events(runId, page: EventPage): Promise<Events> {
      const run = requireRun(runId);
      const rows = store.listEvents({ runId: run.runId, afterSequence: page.afterSequence, limit: page.limit + 1 });
      const gap = rows.length > page.limit;
      const bounded = rows.slice(0, page.limit);
      const items: EventRecord[] = bounded.map((event: DurableEvent) => {
        // Free text is only surfaced when a trusted collector explicitly marked it redacted.
        const displayText = textField(event.payload, 'redactedText');
        const display = textField(event.payload, 'redacted') === true && typeof displayText === 'string'
          ? { redacted: true as const, kind: (textField(event.payload, 'redactedKind') === 'log' ? 'log' : 'event') as 'log' | 'event', text: displayText.slice(0, 4096) }
          : undefined;
        return { sequence: event.sequence, eventId: event.eventId, occurredAt: event.occurredAt, type: event.type.slice(0, 120),
          ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.attemptId ? { attemptId: event.attemptId } : {}), ...(display ? { display } : {}) };
      });
      return { items, nextSequence: items.at(-1)?.sequence ?? page.afterSequence, gap };
    },
    async switchModel(input): Promise<unknown> {
      if (!supervisor.switchModel) throw new InterfaceError('INTEGRATION_REQUIRED', 'the supervisor port does not expose model switches; no switch is applied');
      if (!store.getAttempt(input.attemptId)) throw new InterfaceError('RUN_NOT_FOUND', `no durable attempt ${input.attemptId}`);
      return await supervisor.switchModel(input);
    },
    async requestSubtask(input): Promise<unknown> {
      if (!supervisor.requestSubtask) throw new InterfaceError('INTEGRATION_REQUIRED', 'the supervisor port does not expose subtask requests; none is admitted');
      if (!store.getAttempt(input.attemptId)) throw new InterfaceError('RUN_NOT_FOUND', `no durable attempt ${input.attemptId}`);
      return await supervisor.requestSubtask(input);
    },
    async plan(input, signal): Promise<unknown> {
      if (!options.plan) throw new InterfaceError('INTEGRATION_REQUIRED', 'the composition supplies no planner port; no proposal is stored and no plan task is admitted');
      return await options.plan(input, signal);
    },
    async close(): Promise<void> {
      await supervisor.dispose?.();
      if (options.closeStore) store.close();
    },
  };
}
