import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessResult } from './process.js';
import { isOutcome, isRecordKind, type AssessmentRecord, type CoverageOutcome, type LedgerPage } from './records.js';

/**
 * Owner-served broker. Strix shares one sandbox session with every agent; Pi workers are separate
 * processes, so the owner exposes exactly the same session over a private unix socket and keeps the
 * policy, the budgets and the single cleanup path in one place. Workers never receive a Docker client.
 */
export const MAX_LINE_BYTES = 64 * 1024;
export const WORKER_BUDGET_RESERVE = 0.9;
export const DEFAULT_WORKER_COMMAND_BUDGET = 200;

export interface WorkerReport {
  summary: string;
  findings: string[];
  evidence: string[];
  coverage: Array<{ surface: string; risk: string; outcome: CoverageOutcome }>;
  openItems: string[];
  confidence: 'high' | 'medium' | 'low';
  blocked?: string;
  outcome?: 'completed' | 'partial-budget' | 'prerequisite-blocked' | 'provider-error' | 'cancelled' | 'expired' | 'unknown';
}

export interface WorkerRegistration {
  workerId: string;
  name: string;
  paneId: string;
  role: string;
  depth: number;
  parentWorkerId: string | null;
  token: string;
  commandBudget: number;
  used: number;
  startedAt: number;
  stopped: boolean;
  reported?: WorkerReport;
  taskId?: string;
  requestedRuntime?: { model?: string; thinking?: string };
  effectiveRuntime?: { model?: string; thinking?: string; verified: boolean };
}

export interface DelegateInput { focus: string; task: string; context?: string; role?: string; skills?: string[]; model?: string; workflow?: string; thinking?: string; taskId?: string }
export interface DelegateResult { workerId: string; name: string; paneId: string; role: string; model?: string; depth: number }

export interface BrokerDeps {
  exec(command: string, seconds: number, workdir: string, signal: AbortSignal): Promise<ProcessResult>;
  http(url: string, method: 'GET' | 'HEAD', signal: AbortSignal, workerId?: string): Promise<ProcessResult>;
  note(record: AssessmentRecord): Promise<void>;
  ledger(limit: number, id?: string, cursor?: number): Promise<AssessmentRecord[] | LedgerPage>;
  objective?(worker: WorkerRegistration): Promise<unknown>;
  beforeCommand?(worker: WorkerRegistration): Promise<void>;
  onBudget?(workerId: string, reason: string): void;
  delegate(input: DelegateInput, parent: WorkerRegistration): Promise<DelegateResult>;
  report(workerId: string, report: WorkerReport): Promise<void>;
  knowledge?(op: string, request: Record<string, unknown>, worker: WorkerRegistration): Promise<unknown>;
  candidate?(input: unknown, worker: WorkerRegistration): Promise<unknown>;
  onProblem?(message: string): void;
}

export interface BrokerLimits { totalCommandBudget: number; maxLineBytes?: number }

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return clean.length > limit ? clean.slice(0, limit) : clean;
}

function stringList(value: unknown, count: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => text(item, limit)).filter((item): item is string => Boolean(item)).slice(0, count);
}

/** Reports are untrusted input: shape them here so no later consumer has to trust worker JSON. */
export function normalizeReport(raw: unknown): WorkerReport {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const coverage: WorkerReport['coverage'] = [];
  if (Array.isArray(input.coverage)) {
    for (const entry of input.coverage.slice(0, 40)) {
      const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const surface = text(item.surface, 200); const risk = text(item.risk, 200);
      if (!surface || !risk || !isOutcome(item.outcome)) continue;
      coverage.push({ surface, risk, outcome: item.outcome as CoverageOutcome });
    }
  }
  const confidence = input.confidence === 'high' || input.confidence === 'medium' || input.confidence === 'low' ? input.confidence : 'low';
  return {
    summary: text(input.summary, 4000) ?? '(no summary supplied)',
    findings: stringList(input.findings, 20, 1000),
    evidence: stringList(input.evidence, 40, 500),
    coverage,
    openItems: stringList(input.openItems, 20, 1000),
    confidence,
    blocked: text(input.blocked, 1000),
    ...(typeof input.outcome === 'string' && ['completed','partial-budget','prerequisite-blocked','provider-error','cancelled','expired','unknown'].includes(input.outcome) ? { outcome: input.outcome as WorkerReport['outcome'] } : {}),
  };
}

export class Broker {
  private server?: Server;
  private readonly clients = new Set<Socket>();
  private readonly registrations = new Map<string, WorkerRegistration>();
  /** Commands in flight per worker, so revoking a worker ends its wait instead of letting it run on. */
  private readonly inFlight = new Map<string, Set<AbortController>>();
  private totalUsed = 0;
  private readonly knowledgeUsed = new Map<string, number>();
  private readonly reporting = new Set<string>();
  private readonly socketPath: string;
  constructor(private readonly control: string, private readonly deps: BrokerDeps, private readonly limits: BrokerLimits) {
    this.socketPath = join(control, 'sandbox.sock');
  }

  get socket(): string { return this.socketPath; }
  get workers(): WorkerRegistration[] { return [...this.registrations.values()]; }
  registration(workerId: string): WorkerRegistration | undefined { return this.registrations.get(workerId); }

  register(registration: WorkerRegistration): void {
    if (this.registrations.has(registration.workerId)) throw new Error(`Worker ${registration.workerId} is already registered`);
    this.registrations.set(registration.workerId, registration);
  }

  revoke(workerId: string): void {
    const registration = this.registrations.get(workerId);
    if (registration) registration.stopped = true;
    for (const controller of this.inFlight.get(workerId) ?? []) controller.abort();
    this.inFlight.delete(workerId);
  }

  async start(): Promise<string> {
    await rm(this.socketPath, { force: true });
    const server = createServer(socket => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    // Only the owner may speak on this socket; the directory is already 0700.
    const { chmodSync } = await import('node:fs');
    chmodSync(this.socketPath, 0o600);
    return this.socketPath;
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    let buffer = '';
    let workerId: string | undefined;
    let chain: Promise<void> = Promise.resolve();
    const send = (payload: unknown) => { if (!socket.destroyed) socket.write(`${boundedResponse(payload)}\n`); };
    const fail = (message: string) => { this.deps.onProblem?.(message); send({ ok: false, error: message }); };
    socket.on('data', chunk => {
      buffer += chunk;
      // Serialize per connection so two tool calls cannot interleave around shared budgets.
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > (this.limits.maxLineBytes ?? MAX_LINE_BYTES)) { fail('Request too large'); socket.destroy(); return; }
        chain = chain.then(async () => {
          let request: any;
          try { request = JSON.parse(line); } catch { fail('Malformed request'); socket.destroy(); return; }
          if (!workerId) {
            const registration = this.authenticate(request?.token);
            if (!registration) { fail('Unauthorized'); socket.destroy(); return; }
            workerId = registration.workerId;
            send({ ok: true, workerId });
            return;
          }
          const response = await this.dispatch(workerId, request).catch(error => ({ok:false,error:errText(error)}));
          send({ id: request?.id, ...response });
        }).catch(error => { fail(String(error instanceof Error ? error.message : error).slice(0, 400)); });
      }
      if (buffer.length > (this.limits.maxLineBytes ?? MAX_LINE_BYTES)) { fail('Request too large'); socket.destroy(); }
    });
    socket.on('error', error => this.deps.onProblem?.(`worker socket error: ${error.message}`));
    socket.on('close', () => this.clients.delete(socket));
  }

  private authenticate(token: unknown): WorkerRegistration | undefined {
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return undefined;
    for (const registration of this.registrations.values()) {
      if (registration.token === token) return registration.stopped ? undefined : registration;
    }
    return undefined;
  }

  private async dispatch(workerId: string, request: any): Promise<Record<string, unknown>> {
    const registration = this.registrations.get(workerId);
    if (!registration || registration.stopped) return { ok: false, error: 'This worker was stopped by the owner' };
    const op = text(request?.op, 32);
    if (this.reporting.has(workerId) && op !== 'status') return {ok:false,error:'Worker report persistence in progress; no further requests'};
    if (registration.effectiveRuntime?.verified === false && !['runtime','report','status'].includes(op ?? '')) return { ok:false,error:'Runtime profile mismatch; report blocked, no investigation' };
    switch (op) {
      case 'skill_list': case 'skill_read': {
        const used = this.knowledgeUsed.get(workerId) ?? 0;
        if (used >= 160) return { ok: false, error: 'Knowledge read budget exhausted; 40 coordination calls reserved for notes/candidates (200 total)' };
        this.knowledgeUsed.set(workerId, used + 1);
        if (!this.deps.knowledge) return { ok: false, error: 'Knowledge service unavailable' };
        try { return { ok: true, value: await this.deps.knowledge(op, request, registration) }; }
        catch (error) { return { ok: false, error: errText(error) }; }
      }
      case 'candidate': {
        const used = this.knowledgeUsed.get(workerId) ?? 0;
        if (used >= 200) return { ok: false, error: 'Coordination budget exhausted' };
        this.knowledgeUsed.set(workerId, used + 1);
        if (!this.deps.candidate) return { ok: false, error: 'Candidate service unavailable' };
        try { return { ok: true, value: await this.deps.candidate(request?.candidate, registration) }; }
        catch (error) { return { ok: false, error: errText(error) }; }
      }
      case 'objective':
        return { ok: true, value: await this.deps.objective?.(registration) };
      case 'runtime': {
        const model = text(request?.model,200), thinking = text(request?.thinking,16);
        const expected = registration.requestedRuntime;
        const modelMatches = !expected?.model || (expected.model.includes('/') ? model === expected.model : model?.split('/').slice(1).join('/') === expected.model);
        const verified = Boolean(model && thinking && modelMatches && (!expected?.thinking || thinking === expected.thinking));
        registration.effectiveRuntime = { model,thinking,verified };
        return { ok:true,verified };
      }
      case 'status':
        return { ok: true, workerId, used: registration.used, budget: registration.commandBudget, reported: Boolean(registration.reported) };
      case 'ledger': {
        // Workers may read the shared ledger: it is how a nested worker sees its parent's notes.
        const limit = Number.isInteger(request?.limit) ? Math.min(Math.max(request.limit, 1), 100) : 50;
        const slice = await this.deps.ledger(limit, text(request?.recordId, 80), Number.isInteger(request?.cursor) ? request.cursor : undefined);
        if (!Array.isArray(slice)) return { ok:true,...slice };
        const records: AssessmentRecord[] = []; let bytes = 0;
        for (const record of slice.slice().reverse()) {
          const size = Buffer.byteLength(JSON.stringify(record));
          if (bytes + size > 48 * 1024) break;
          bytes += size; records.unshift(record);
        }
        return { ok: true, records, truncated: records.length < slice.length };
      }
      case 'exec': {
        if (typeof request?.command !== 'string' || request.command.length > 8192) return { ok: false, error: 'command must be 1..8192 characters' };
        const command = text(request.command, 8192);
        const seconds = Number.isInteger(request?.timeout) ? request.timeout : 30;
        if (!command || !command.trim()) return { ok: false, error: 'command must be 1..8192 characters' };
        if (seconds < 1 || seconds > 60) return { ok: false, error: 'timeout must be 1..60 seconds' };
        const spent = await this.prepareCommand(registration);
        if (spent) return spent;
        return this.whileRunning(workerId, async signal => {
          try {
            const result = await this.deps.exec(command, seconds, `/work/${workerId}`, signal);
            return { ok: true, ...result };
          } catch (error) { return { ok: false, error: errText(error) }; }
        });
      }
      case 'http': {
        if (typeof request?.url !== 'string' || request.url.length > 4096) return { ok: false, error: 'url must be 1..4096 characters' };
        const url = text(request.url, 4096);
        const method = request?.method === 'HEAD' ? 'HEAD' : 'GET';
        if (!url) return { ok: false, error: 'url must be 1..4096 characters' };
        const spent = await this.prepareCommand(registration);
        if (spent) return spent;
        return this.whileRunning(workerId, async signal => {
          try {
            const result = await this.deps.http(url, method, signal, workerId);
            return { ok: true, ...result };
          } catch (error) { return { ok: false, error: errText(error) }; }
        });
      }
      case 'note': {
        const used = this.knowledgeUsed.get(workerId) ?? 0;
        if (used >= 200) return { ok: false, error: 'Coordination budget exhausted' };
        this.knowledgeUsed.set(workerId, used + 1);
        if (!isRecordKind(request?.kind) || !['note', 'coverage', 'observation', 'open'].includes(request.kind)) return { ok: false, error: 'kind must be note, coverage, observation or open' };
        const body = text(request?.text, 2000);
        if (!body) return { ok: false, error: 'text is required' };
        const outcome = isOutcome(request?.outcome) ? request.outcome : undefined;
        if (request.kind === 'coverage' && (!text(request?.surface, 200) || !text(request?.risk, 200) || !outcome)) return { ok: false, error: 'coverage needs surface, risk and outcome' };
        await this.deps.note({
          at: new Date().toISOString(), by: workerId, kind: request.kind, text: body,
          workerId, role: registration.role, depth: registration.depth,
          ...(text(request?.surface, 200) ? { surface: text(request?.surface, 200) } : {}),
          ...(text(request?.risk, 200) ? { risk: text(request?.risk, 200) } : {}),
          ...(outcome ? { outcome } : {}),
          ...(stringList(request?.refs, 10, 200).length ? { refs: stringList(request?.refs, 10, 200) } : {}),
        });
        return { ok: true };
      }
      case 'delegate': {
        const focus = text(request?.focus, 60); const task = text(request?.task, 4000);
        if (!focus || !task) return { ok: false, error: 'focus and task are required' };
        try {
          const worker = await this.deps.delegate({
            focus, task, context: text(request?.context, 4000), role: text(request?.role, 32),
            skills: stringList(request?.skills, 3, 64).filter(skill => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)),
            model: text(request?.model, 200), workflow: text(request?.workflow, 64), thinking: text(request?.thinking, 16), taskId: text(request?.taskId,80),
          }, registration);
          return { ok: true, worker };
        } catch (error) { return { ok: false, error: errText(error) }; }
      }
      case 'report': {
        if (registration.reported) return { ok: false, error: 'this worker already reported' };
        const report = normalizeReport(request?.report);
        if (this.reporting.has(workerId)) return {ok:false,error:'Report persistence already in progress'};
        this.reporting.add(workerId);
        try {
          await this.deps.report(workerId, report);
          registration.reported = report;
          // Reporting ends this worker's authority: a copied ticket cannot retain target access.
          this.revoke(workerId);
          return { ok: true };
        } finally { this.reporting.delete(workerId); }
      }
      default:
        return { ok: false, error: 'unsupported broker operation' };
    }
  }

  private async whileRunning(workerId: string, run: (signal: AbortSignal) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const pending = this.inFlight.get(workerId) ?? new Set<AbortController>();
    pending.add(controller); this.inFlight.set(workerId,pending);
    try { return await run(controller.signal); }
    finally { pending.delete(controller); if (!pending.size && this.inFlight.get(workerId) === pending) this.inFlight.delete(workerId); }
  }

  private async prepareCommand(registration: WorkerRegistration): Promise<Record<string,unknown> | undefined> {
    try { await this.deps.beforeCommand?.(registration); } catch (error) { return {ok:false,error:errText(error)}; }
    if (registration.stopped || this.reporting.has(registration.workerId)) return {ok:false,error:'Worker revoked or reporting; no new target command'};
    return this.spend(registration);
  }

  /** Workers stop at the reserve so the owner keeps budget for reconciliation and the final report. */
  private spend(registration: WorkerRegistration): Record<string, unknown> | undefined {
    const reserve = Math.floor(this.limits.totalCommandBudget * WORKER_BUDGET_RESERVE);
    const reason = registration.used >= registration.commandBudget ? 'worker command budget exhausted; report what you have with p2o_report'
      : this.totalUsed >= reserve ? 'assessment worker budget reserve reached; report what you have with p2o_report' : undefined;
    if (reason) { this.deps.onBudget?.(registration.workerId,reason); return {ok:false,error:reason}; }
    registration.used += 1; this.totalUsed += 1;
    return undefined;
  }

  get used(): number { return this.totalUsed; }

  async stop(): Promise<void> {
    for (const pending of this.inFlight.values()) for (const controller of pending) controller.abort();
    this.inFlight.clear();
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(this.socketPath, { force: true });
    for (const registration of this.registrations.values()) registration.stopped = true;
  }
}

/** Bound the serialized wire frame, not just raw output bytes. Keep oversize errors request-correlated. */
export function boundedResponse(payload: unknown): string {
  const value = { ...(payload as Record<string, unknown>) };
  let encoded = JSON.stringify(value);
  while (Buffer.byteLength(encoded) > MAX_LINE_BYTES - 512 && (typeof value.stdout === 'string' && value.stdout.length || typeof value.stderr === 'string' && value.stderr.length)) {
    if (typeof value.stdout === 'string') value.stdout = value.stdout.slice(0, Math.floor(value.stdout.length / 2));
    if (typeof value.stderr === 'string') value.stderr = value.stderr.slice(0, Math.floor(value.stderr.length / 2));
    value.truncated = true;
    encoded = JSON.stringify(value);
  }
  return Buffer.byteLength(encoded) <= MAX_LINE_BYTES - 512 ? encoded
    : JSON.stringify({ id: value.id, ok: false, error: 'Response exceeds broker frame limit; narrow the request' });
}

function errText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 600); }

export interface BrokerClientOptions { connectMs?: number; requestMs?: number }

/** Worker side: one connection, sequential requests, and fail-closed behaviour after any socket loss. */
export class BrokerClient {
  private socket?: Socket;
  private chain: Promise<unknown> = Promise.resolve();
  private broken?: string;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  constructor(private readonly socketPath: string, private readonly token: string, private readonly options: BrokerClientOptions = {}) {}

  private connect(): Promise<void> {
    if (this.broken) return Promise.reject(new Error(this.broken));
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.setEncoding('utf8');
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error('p2o owner broker did not answer; the assessment owner may have stopped. Report blocked with p2o_report.'));
      }, this.options.connectMs ?? 5000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      socket.on('error', error => { this.fail(`owner broker connection failed: ${error.message}`); finish(new Error(this.broken!)); });
      socket.on('close', () => {
        const current = this.socket === socket;
        if (current) this.socket = undefined;
        if (!this.broken) this.fail('owner broker connection closed; the assessment owner may have stopped');
        finish(new Error(this.broken!));
      });
      socket.on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) { this.fail('owner broker response exceeded the line limit'); return; }
          let record: any;
          try { record = JSON.parse(line); } catch { continue; }
          if (this.socket !== socket) {
            if (record.ok === true) { this.socket = socket; finish(); }
            else { this.fail(String(record.error ?? 'owner rejected the worker ticket')); finish(new Error(this.broken!)); }
            continue;
          }
          const waiter = this.pending.get(record.id);
          if (!waiter) continue;
          this.pending.delete(record.id);
          if (record.ok === true) waiter.resolve(record);
          else waiter.reject(new Error(String(record.error ?? 'broker request failed')));
        }
        if (buffer.length > MAX_LINE_BYTES) this.fail('owner broker response exceeded the line limit');
      });
      socket.write(`${JSON.stringify({ token: this.token })}\n`);
    });
  }

  private fail(message: string): void {
    this.broken = `${message}. Do not retry host-side work; call p2o_report with blocked.`;
    for (const waiter of this.pending.values()) waiter.reject(new Error(this.broken));
    this.pending.clear();
    this.socket?.destroy();
    this.socket = undefined;
  }

  request<T = any>(op: string, payload: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    const run = async (): Promise<T> => {
      await this.connect();
      const socket = this.socket;
      if (!socket) throw new Error(this.broken ?? 'owner broker unavailable');
      const id = ++this.sequence;
      if (Buffer.byteLength(JSON.stringify({ ...payload,id,op })) > MAX_LINE_BYTES - 1) throw new Error('Request exceeds broker frame limit; narrow the report or request');
      const timeoutMs = options.timeoutMs ?? this.options.requestMs ?? 60_000;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`p2o ${op} request timed out after ${timeoutMs}ms`)); }, timeoutMs);
        this.pending.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value as T); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        socket.write(`${JSON.stringify({ ...payload, id, op })}\n`);
      });
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  close(): void { this.fail('worker session ended'); }
}
