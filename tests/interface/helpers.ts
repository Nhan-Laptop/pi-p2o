import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ControlBackend, EventPage, Events, Page, Preflight, RecordPage, Report, ResumeInput, RunHandle, Snapshot, StartInput } from '../../src/interface/types.js';
import { InterfaceError } from '../../src/interface/types.js';
import type { EntryApproveInput, EntryApprovalReceipt, EntryPlan, EntryPreparation, EntryReadPlan, EntryRun, EntryStartInput, TargetEntryPort } from '../../src/interface/target-entry.js';
import type { EntryHumanApproval, EntryPlanInput, EntryPrepareInput, EntryRunSummary, EntryStopReceipt } from '../../src/interface/target-entry.js';

export const requested = { provider: 'requested-provider', model: 'requested-model', thinking: 'max' as const };
export const input = { manifestPath: 'approved.json', mode: 'fixture' as const, selection: requested };
export function snapshot(): Snapshot {
  return {
    mode: 'fixture',
    run: { runId: 'run-1', state: 'active', requestedRuntime: { adapter: 'headless', selection: requested }, authorization: { reference: 'password=DO_NOT_EXPOSE' } },
    tasks: [{ taskId: 'task-1', lifecycleState: 'exited', packetState: 'returned-for-evidence', question: { text: '<img src=x onerror="alert(1)">' }, workspace: '/private/worker', raw: 'DO_NOT_EXPOSE' }],
    attempts: [{ attemptId: 'attempt-1', taskId: 'task-1', lifecycleState: 'exited', requestedRuntime: { selection: requested },
      observedRuntime: { adapter: 'headless', selection: { provider: 'observed-provider', model: 'observed-model', thinking: 'low' }, attestation: 'reported', receiptEvidenceIds: ['receipt-1'] }, leaseToken: 'DO_NOT_EXPOSE',
      sessionFile: '/private/auth.json', logTail: 'Authorization: Bearer DO_NOT_EXPOSE' }],
    packets: [{ packetId: 'packet-1', taskId: 'task-1', status: 'returned-for-evidence', decision: { status: 'returned-for-evidence', reasons: [{ code: 'MISSING_BASELINE' }] }, raw: 'DO_NOT_EXPOSE' }],
    findings: [{ findingId: 'finding-1', title: '<script>alert(1)</script>', state: 'unresolved', classification: 'unresolved', limitations: ['Not independently reproduced'], apiKey: 'DO_NOT_EXPOSE' }],
    coverage: [{ coverageId: 'c-1', question: 'unknown route', state: 'untested', basis: 'worker-asserted', reason: 'Missing capability' }],
    failures: [{ code: 'WORKER_FAILED', taskId: 'task-2', message: 'password=DO_NOT_EXPOSE failed' }],
  };
}
export class FakeBackend implements ControlBackend {
  calls: string[] = [];
  ready = true;
  dispatchAllowed = true;
  verifiedStop = true;
  closeFailure = false;
  foregroundReceipts: import('../../src/interface/types.js').ForegroundUsageReceipt[] = [];
  async recordForegroundUsage(_runId: string, receipt: import('../../src/interface/types.js').ForegroundUsageReceipt) { this.foregroundReceipts.push(receipt); }
  startWait?: () => Promise<void>;
  snapshotValue = snapshot();
  eventValues: Events['items'] = [{ sequence: 1, eventId: 'event-1', occurredAt: '2026-10-02T00:00:00Z', type: 'runtime.exited',
    display: { redacted: true, kind: 'log', text: '<img src=x onerror=alert(1)> token=DO_NOT_EXPOSE' } }];
  async preflight(request: StartInput | ResumeInput): Promise<Preflight> {
    this.calls.push('preflight');
    return { ok: this.ready, mode: request.mode, runId: 'run-1', requested: { adapter: request.runtime ?? 'headless', selection: request.selection ?? requested },
      issues: this.ready ? [] : [{ code: 'SCOPE_EXPIRED', message: 'Expired' }], warnings: ['Fixture is not a process sandbox'] };
  }
  async start(request: StartInput): Promise<RunHandle> {
    this.calls.push('start');
    await this.startWait?.();
    if (!this.dispatchAllowed) throw new InterfaceError('SCOPE_EXPIRED', 'dispatch denied; password=DO_NOT_EXPOSE');
    return { runId: 'run-1', mode: request.mode };
  }
  async resume(request: ResumeInput): Promise<RunHandle> { this.calls.push('resume'); return this.start(request); }
  async stop(runId: string): Promise<import('../../src/interface/types.js').CancellationReceipt> {
    this.calls.push(`stop:${runId}`);
    return { runId, schedulingStopped: true, terminationVerified: this.verifiedStop, failures: [] };
  }
  async status(runId: string): Promise<Snapshot> {
    this.calls.push('status');
    if (runId !== 'run-1') throw new InterfaceError('NOT_FOUND', 'No run');
    return this.snapshotValue;
  }
  async tasks(_runId: string, p: Page): Promise<RecordPage> { this.calls.push('tasks'); return { items: this.snapshotValue.tasks.slice(p.offset, p.offset + p.limit), total: this.snapshotValue.tasks.length, offset: p.offset }; }
  async evidence(_runId: string, p: Page, evidenceId?: string): Promise<RecordPage> {
    this.calls.push('evidence');
    const items = [{ evidenceId: evidenceId ?? 'receipt-1', kind: 'source', redacted: true, summary: 'api_key=DO_NOT_EXPOSE',
      locator: '/private/receipt', metadata: { token: 'DO_NOT_EXPOSE' }, provenance: { collectorId: 'collector-1', trust: 'collector', tool: { name: 'source.analyze', options: ['token=DO_NOT_EXPOSE'] } } }];
    return { items, total: 1, offset: p.offset };
  }
  async doctor(request: StartInput | ResumeInput): Promise<Preflight> {
    this.calls.push('doctor');
    return { ok: this.ready, mode: request.mode, runId: 'run-1', requested: { adapter: request.runtime ?? 'headless', selection: request.selection ?? requested },
      issues: this.ready ? [] : [{ code: 'SCOPE_EXPIRED', message: 'Expired' }],
      warnings: ['fixture is not a process sandbox', 'vault-backed report renderer is wired; supervisor owns admission'] };
  }
  async report(_runId: string, format: Report['format']): Promise<Report> {
    this.calls.push('report');
    return { format, content: format === 'markdown' ? '# Qualified report\n<script>alert(1)</script>\npassword=DO_NOT_EXPOSE' : { coverage: this.snapshotValue.coverage, findings: this.snapshotValue.findings, password: 'DO_NOT_EXPOSE' } };
  }
  async events(_runId: string, p: EventPage): Promise<Events> {
    this.calls.push('events');
    const items = this.eventValues.filter(e => e.sequence > p.afterSequence).slice(0, p.limit);
    return { items, nextSequence: items.at(-1)?.sequence ?? p.afterSequence, gap: false };
  }
  /** Optional owner-gated actions: absent by default so the interface fails closed. */
  switchModel?: (input: import('../../src/interface/types.js').SwitchModelInput) => Promise<unknown>;
  requestSubtask?: (input: import('../../src/interface/types.js').SubtaskRequestInput) => Promise<unknown>;
  /** Optional target-entry workflow; absent by default so target commands fail closed. */
  entry?: TargetEntryPort;
  async close(): Promise<void> {
    this.calls.push('close');
    if (this.closeFailure) throw new Error('cleanup failed');
  }
}

export function fakePi(hasUI = true) {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const messages: Array<{ customType: string; content: unknown; details?: unknown }> = [];
  const deliveries: Array<{ triggerTurn?: boolean; deliverAs?: string } | undefined> = [];
  const userMessages: string[] = [];
  const widgets: Array<{ key: string; content?: string[] }> = [];
  const loadouts: string[][] = [];
  let activeTools = ['read', 'bash', 'edit', 'write', 'codemode'];
  let idle = true, aborts = 0;
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text?: string }> = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const sessionEntries: Array<{ type: 'custom'; customType: string; data?: unknown }> = [];
  let confirmResult = true;
  const api = {
    sendUserMessage(content: string | unknown[]) { userMessages.push(typeof content === 'string' ? content : JSON.stringify(content)); },
    registerTool(definition: ToolDefinition) { if (tools.has(definition.name)) throw new Error('Duplicate tool'); tools.set(definition.name, definition); activeTools.push(definition.name); },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, command); },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    sendMessage(message: { customType: string; content: unknown; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: string }) { messages.push(message); deliveries.push(options); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools = [...names]; loadouts.push([...names]); },
    appendEntry(customType: string, data?: unknown) { sessionEntries.push({ type: 'custom', customType, data }); },
  } as unknown as ExtensionAPI;
  const context = { cwd: process.cwd(), hasUI, isIdle: () => idle, abort: () => { aborts++; idle = true; }, thinkingLevel: 'max', model: { provider: 'parent', id: 'parent-model' },
    ui: { notify(message: string, type?: string) { notifications.push({ message, type }); },
      setStatus(key: string, text?: string) { statuses.push({ key, text }); },
      setWidget(key: string, content?: string[]) { widgets.push({ key, content }); },
      confirm(title: string, message: string) { confirmCalls.push({ title, message }); return Promise.resolve(confirmResult); } },
    sessionManager: { getBranch: () => [...sessionEntries] },
  } as unknown as ExtensionCommandContext;
  return { api, tools, commands, handlers, messages, deliveries, userMessages, widgets, loadouts, notifications, statuses, context, confirmCalls, sessionEntries,
    setIdle(value: boolean) { idle = value; }, aborts: () => aborts,
    setConfirm(value: boolean) { confirmResult = value; },
    async call(name: string, args: unknown, signal?: AbortSignal) {
      return tools.get(name)!.execute('call-1', args, signal, undefined, {
        ...context, tools: [],
        async executeTool() { throw new Error('Nested tool execution is not provided by this test fixture'); },
      });
    },
    async command(name: string, args: string) { await commands.get(name)!.handler(args, context); },
    async event(name: string, event: unknown = { type: name }) { const results: unknown[] = []; for (const handler of handlers.get(name) ?? []) results.push(await handler(event, context)); return results; },
    setHasUI(value: boolean) { (context as unknown as { hasUI: boolean }).hasUI = value; },
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** Test double for the target workflow. Counts simulated target requests so tests can prove none happen. */
export class FakeEntry implements TargetEntryPort {
  calls: string[] = [];
  targetRequests = 0;
  plans = new Map<string, EntryReadPlan>();
  approved = new Set<string>();
  current: EntryRunSummary | null = null;
  lastApproval?: EntryHumanApproval;
  lastStart?: EntryStartInput;
  prepareOverrides: Record<string, unknown> = {};
  planOverrides: Record<string, unknown> = {};
  runOverrides: Record<string, unknown> = {};
  approveReceipt: Record<string, unknown> = {};
  approveFailure?: Error;

  async prepare(input: EntryPrepareInput): Promise<EntryPreparation> {
    this.calls.push(`prepare:${input.target.kind}`);
    this.targetRequests += typeof this.prepareOverrides.targetRequests === 'number' ? this.prepareOverrides.targetRequests : 0;
    return {
      runId: 'run-1',
      target: input.target,
      mode: input.target.kind === 'http-url' ? 'assessment' : 'fixture',
      scopeDigest: 'a'.repeat(64),
      actions: ['read', 'analyze'],
      spend: { maxCostUsd: 5, maxRequests: 20, maxTokens: 100_000, maxToolCalls: 20, maxAttempts: 2 },
      concurrency: input.concurrency ?? 1,
      warnings: [],
      requiresHumanApproval: true,
      targetRequests: 0,
      planOnly: input.planOnly,
      ...this.prepareOverrides,
    } as unknown as EntryPreparation;
  }

  async plan(input: EntryPlanInput): Promise<EntryPlan> {
    this.calls.push('plan');
    const plan = { planId: 'plan-1', runId: input.preparation.runId, digest: 'b'.repeat(64), steps: ['snapshot', 'delegate'], targetRequests: 0, ...this.planOverrides } as unknown as EntryPlan;
    this.plans.set(plan.planId, { preparation: input.preparation, plan });
    return plan;
  }

  async planContext(input: EntryPlanInput): Promise<import('../../src/application/entry/types.js').EntryPlanAuthorInput> {
    this.calls.push('planContext');
    return { preparation: input.preparation, depth: 'standard', techniques: ['source.analyze'], skills: ['source-code-auditing'], available: { ownerMenu: true, generatedRequests: false },
      facts: { targetKind: input.preparation.target.kind, locator: input.preparation.target.locator, targetId: 'target-1', samplePaths: [],
        ownerObservations: [{ taskId: 'task-1', observationId: 'source-inventory', tool: 'source.analyze', summary: 'bounded approved observation', targetIds: ['target-1'], capabilities: ['source.analyze'], actions: ['analyze'] }],
        generatedTasks: [], accounts: ['anonymous'], allowedActions: ['analyze'], allowedCapabilities: ['source.analyze'], limits: { maxSteps: 16, maxStepChars: 300, maxSelections: 32, maxGeneratedRequests: 16 } } };
  }
  async proposePlan(input: EntryPlanInput, output: import('../../src/application/entry/types.js').EntryPlanAuthorOutput): Promise<EntryPlan> {
    this.calls.push('proposePlan');
    const plan: EntryPlan = { planId: 'plan-1', runId: input.preparation.runId, digest: 'b'.repeat(64), steps: output.steps, targetRequests: 0 };
    this.plans.set(plan.planId, { preparation: input.preparation, plan });
    return plan;
  }

  async start(input: EntryStartInput): Promise<EntryRun> {
    this.calls.push('start');
    this.lastApproval = input.approval;
    this.lastStart = input;
    return { runId: input.preparation.runId, state: 'admitted', ...(input.plan ? { planId: input.plan.planId } : {}), approvalRef: input.approval.approvalRef, ...this.runOverrides } as EntryRun;
  }

  async resume(runId: string): Promise<EntryRun> {
    this.calls.push(`resume:${runId}`);
    return { runId, state: 'resumed', ...this.runOverrides } as EntryRun;
  }

  readPlan?: (planId: string) => Promise<EntryReadPlan | null> = async planId => {
    this.calls.push(`readPlan:${planId}`);
    return this.plans.get(planId) ?? null;
  };

  async approve(input: EntryApproveInput): Promise<EntryApprovalReceipt> {
    this.calls.push(`approve:${input.planId}`);
    if (this.approveFailure) throw this.approveFailure;
    const already = this.approved.has(input.planId);
    this.approved.add(input.planId);
    this.lastApproval = input.approval;
    return { planId: input.planId, approved: true, admittedOnce: !already, run: { runId: 'run-1', state: 'admitted' }, ...this.approveReceipt } as EntryApprovalReceipt;
  }

  async currentRun(): Promise<EntryRunSummary | null> { this.calls.push('currentRun'); return this.current; }

  stop?: (runId: string) => Promise<EntryStopReceipt> = async runId => {
    this.calls.push(`stop:${runId}`);
    return { runId, schedulingStopped: true, terminationVerified: true, failures: [] };
  };
}
