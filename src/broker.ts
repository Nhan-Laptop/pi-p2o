import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { MutationRequest } from './state/store.js';
import { join } from 'node:path';
import type { ProcessResult } from './process.js';
import { httpRequest, taskTimeout, type HttpRequest } from './target.js';
import { isOutcome, isRecordKind, type AssessmentRecord, type CoverageOutcome, type LedgerPage, type RecordAck } from './records.js';
import { scratchOffset, scratchPath } from './scratch.js';
import { graphObject, validateGraphBatch, type GraphAck, type GraphBatch } from './state/graph.js';
import type { ContextCursor, ContextPacket } from './context.js';
import type { AssessmentTask } from './tasks.js';
import { TEXT_CONTROL_G } from './validate.js';
export type { GraphBatch } from './state/graph.js';

/**
 * Owner-served broker. Strix shares one sandbox session with every agent; Pi workers are separate
 * processes, so the owner exposes exactly the same session over a private unix socket and keeps the
 * policy, the operation accounting and the single cleanup path in one place. Workers never receive a Docker client.
 */
export const MAX_LINE_BYTES = 64 * 1024;

/** How a worker's assignment ended, as it states it in p2o_report; the host never infers success from it. */
export const WORKER_OUTCOMES = ['completed', 'prerequisite-blocked', 'provider-error', 'cancelled', 'expired', 'unknown'] as const;
export interface WorkerReport {
  summary: string;
  findings: string[];
  evidence: string[];
  coverage: Array<{ surface: string; risk: string; outcome: CoverageOutcome }>;
  openItems: string[];
  confidence: 'high' | 'medium' | 'low';
  blocked?: string;
  outcome?: typeof WORKER_OUTCOMES[number];
  /**
   * A7.5/D19: hold the ticket, pane and session for the successor step. Bounded to one sentence so a hold is a claim of
   * "the next step continues this exact work", never an unbounded parking spot.
   */
  holdFor?: { brief: string };
  /** P10/WF-11: how many continuation briefs this hold authorizes (0..3, default 1). 0 records the successor brief without
   *  keeping the ticket. A malformed value falls back to 1 rather than widening anything. */
  holdContinuations?: number;
}

export interface WorkerRegistration {
  workerId: string;
  name: string;
  paneId: string;
  role: string;
  depth: number;
  parentWorkerId: string | null;
  token: string;
  /** Observations, not limits: how many commands this worker has run and what it is for. Nothing compares them to a ceiling. */
  purpose?: string;
  used: number;
  startedAt: number;
  stopped: boolean;
  paneClosed?: boolean;
  reported?: WorkerReport;
  taskId?: string;
  /** A7.2: the one session this worker's ticket holds. Owner-side state; a worker cannot name another. */
  session?: string;
  /** A7.5/P10: the brief a reported worker is holding its ticket, pane and session for; one continuation consumes one count. */
  holdBrief?: string;
  /** P10/WF-11: remaining continuation briefs this hold authorizes; absent means the pre-WF-11 single hold. */
  holdContinuations?: number;
  /** A7.5: true once the hold is used up (or a continuation was accepted for a single-hold report), so a hold-continue is refused. */
  holdConsumed?: boolean;
  /** P10/WF-11: a continuation under this hold is in flight, so the worker may report the successor without waiting for a brief. */
  holdActive?: boolean;
  requestedRuntime?: { model?: string; thinking?: string };
  /** M8: how many continuations this worker's conversation has taken. One by default; a reported worker takes none. */
  continues?: number;
  effectiveRuntime?: { model?: string; thinking?: string; verified: boolean };
}

export interface DelegateInput { focus: string; task: string; context?: string; role?: string; skills?: string[]; model?: string; workflow?: string; thinking?: string; taskId?: string; work?: Record<string, unknown>; decision?: Record<string, unknown>; outputContract?: Record<string, unknown>;
  /** A7.5/D19: dispatch this successor onto the named held worker's ticket, pane and session instead of spawning a new worker. */
  continueWorkerId?: string }
export interface DelegateResult { workerId: string; name: string; paneId: string; role: string; model?: string; depth: number }

export interface BrokerDeps {
  exec(command: string, seconds: number, workdir: string, signal: AbortSignal, session?: string, by?: string): Promise<ProcessResult>;
  /** Network-egress command: identical executor, separately labelled so its receipts are auditable. */
  net?(command: string, seconds: number, workdir: string, signal: AbortSignal, session?: string, by?: string): Promise<ProcessResult>;
  /** A7.3: interactive session PTY. The owner keeps the child and the cursor; the worker names only the session it holds. */
  pty?(action: 'send' | 'read', request: { session?: string; data?: string; waitMs?: number }, worker: WorkerRegistration): Promise<unknown>;
  /** A7.2: session lifecycle and one-shot operations, bound by the worker's ticket. */
  session?(action: string, request: Record<string, unknown>, worker: WorkerRegistration): Promise<unknown>;
  http(request: HttpRequest, signal: AbortSignal, workerId?: string): Promise<ProcessResult>;
  /** Fixed scratch read under this authenticated assignment; no caller-selected root/host path. */
  capture?(path: string, seconds: number, workerId: string, signal: AbortSignal, offset: number, session?: string, maxBytes?: number): Promise<ProcessResult>;
  /** Owner-bound asset graph writes and reads; actor identity never comes from the payload. */
  graphRecord?(batch: GraphBatch, worker: WorkerRegistration, request: MutationRequest): Promise<GraphAck[]>;
  graphReplay?(batch: GraphBatch, worker: WorkerRegistration, request: MutationRequest): Promise<GraphAck[] | undefined>;
  graphRead?(op: string, params: Record<string, unknown>, worker: WorkerRegistration): Promise<unknown>;
  note(record: AssessmentRecord, request?: MutationRequest): Promise<void | RecordAck>;
  /** Cheap recon surface-inventory dedup hint (src/records.ts recordSurface); never a reservation or gate. */
  surface?(input: { component: string; entryPoint: string; text?: string; refs?: string[] }, worker: WorkerRegistration): Promise<RecordAck & { duplicate: boolean; priorRecordId?: string }>;
  ledger(limit: number, id?: string, cursor?: number): Promise<AssessmentRecord[] | LedgerPage>;
  objective?(worker: WorkerRegistration): Promise<unknown>;
  /** Fixed host-selected assignment projection/receipt only, never worker-selected scope or cursor. */
  context?(worker:WorkerRegistration):Promise<{packet:ContextPacket;objective?:AssessmentTask}>;
  contextAck?(packetSha256:string,worker:WorkerRegistration):Promise<ContextCursor>;
  /** Startup lifecycle is persisted by the authenticated owner, never the worker filesystem. */
  started?(worker: WorkerRegistration, request?: MutationRequest): Promise<void | RecordAck>;
  /** Retained record/handoff ACK lookup. Graph results use graphReplay, so report recovery is type-safe. */
  replayMutation?(worker: WorkerRegistration, op: string, request: MutationRequest): Promise<RecordAck[] | undefined>;
  beforeCommand?(worker: WorkerRegistration): Promise<void>;
  /** Display-only model usage counters the worker's Pi reported for one assistant message. Never a limit, budget or gate. */
  usage?(worker: WorkerRegistration, usage: unknown): boolean;
  /** A7.4: the sealed-secret list by id and kind. Listed through the owner's identity; a value never crosses this socket. */
  secretList?(worker: WorkerRegistration): Promise<unknown>;
  delegate(input: DelegateInput, parent: WorkerRegistration): Promise<DelegateResult>;
  report(workerId: string, report: WorkerReport, request?: MutationRequest): Promise<void | RecordAck[]>;
  /** Commit boundary: report persisted, registration terminal and authority revoked. */
  reportCommitted?(worker: WorkerRegistration): Promise<void>;
  requestSubtask?(input: DelegateInput, parent: WorkerRegistration): Promise<unknown>;
  knowledge?(op: string, request: Record<string, unknown>, worker: WorkerRegistration): Promise<unknown>;
  /** planning_update.md P14.8: citation lookup over the committed corpus, plus a curated source fetch. Never a target op. */
  research?(request: Record<string, unknown>, worker: WorkerRegistration): Promise<unknown>;
  candidate?(input: unknown, worker: WorkerRegistration): Promise<unknown>;
  /** planning_update.md P14.2/P14.3: run-scoped payload artifacts and environment recipes (`op` names the action). */
  lab?(op: 'payload_write' | 'payload_read' | 'payload_materialize', request: Record<string, unknown>, worker: WorkerRegistration): Promise<unknown>;
  /**
   * P14.3: the environment is orchestrated by the host, but every command it runs is an ordinary admitted target command in the
   * caller's own sandbox. `control.admit`/`control.exec` are the broker's own admission path, so a recipe cannot bypass it.
   */
  environment?(op: 'create' | 'verify' | 'destroy', request: Record<string, unknown>, worker: WorkerRegistration,
    control: { exec: (command: string) => Promise<{ code: number }> }): Promise<unknown>;
  onProblem?(message: string): void;
}

export interface BrokerLimits { maxLineBytes?: number }

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(TEXT_CONTROL_G, '');
  return clean.length > limit ? clean.slice(0, limit) : clean;
}

/** A ticket binds exactly one session: a worker cannot name a session it was not given. */
function heldSession(registration: WorkerRegistration, requested: unknown): string | undefined {
  if (requested === undefined) return registration.session;
  if (typeof requested !== 'string' || !/^session-[a-f0-9]{8}$/.test(requested)) throw Error('Invalid session id');
  if (registration.session !== requested) throw Error(`SESSION_NOT_HELD: this ticket holds ${registration.session ?? 'no session'}, not ${requested}`);
  return requested;
}

/** Runs one service call and answers with its value, or with the error text instead of throwing into the socket handler. */
async function attempt(work: () => Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error: errText(error) }; }
}

function stringList(value: unknown, count: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => text(item, limit)).filter((item): item is string => Boolean(item)).slice(0, count);
}
/**
 * A report list is bounded by bytes, not by how many items the worker found: a worker that observed 25 findings is not
 * lying, and dropping the tail at an arbitrary count would hide work instead of shrinking it. Each item keeps its own
 * length bound; the list stops only when the bytes the report can carry are spent.
 */
const REPORT_LIST_BYTES = 256 * 1024;
function reportList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = []; let used = 0;
  for (const entry of value) {
    const item = text(entry, limit); if (!item) continue;
    const size = Buffer.byteLength(item) + 1;
    if (used + size > REPORT_LIST_BYTES) break;
    used += size; out.push(item);
  }
  return out;
}

/** A1: the stored bounds of report prose. normalizeReport enforces them and reportProseWarnings names what it will cut. */
export const REPORT_PROSE_CAPS = { summary: 4000, findings: 1000, evidence: 500, coverageSurface: 200, coverageRisk: 200, openItems: 1000, blocked: 1000 } as const;

/** A1 (owner decision 2026-10-28): a long report field is stored truncated, not refused; this names each cut for the worker. */
export function reportProseWarnings(report: WorkerReport): string[] {
  const warnings: string[] = [];
  const cut = (field: string, value: string | undefined, limit: number) => {
    if (typeof value === 'string' && value.length > limit) warnings.push(`truncated:${field} (stored ${limit} of ${value.length} characters)`);
  };
  cut('summary', report.summary, REPORT_PROSE_CAPS.summary);
  report.findings.forEach((value, index) => cut(`findings[${index}]`, value, REPORT_PROSE_CAPS.findings));
  report.evidence.forEach((value, index) => cut(`evidence[${index}]`, value, REPORT_PROSE_CAPS.evidence));
  report.coverage.forEach((item, index) => { cut(`coverage[${index}].surface`, item.surface, REPORT_PROSE_CAPS.coverageSurface); cut(`coverage[${index}].risk`, item.risk, REPORT_PROSE_CAPS.coverageRisk); });
  report.openItems.forEach((value, index) => cut(`openItems[${index}]`, value, REPORT_PROSE_CAPS.openItems));
  cut('blocked', report.blocked, REPORT_PROSE_CAPS.blocked);
  return warnings;
}

/** Reports are untrusted input: shape them here so no later consumer has to trust worker JSON. */
export function normalizeReport(raw: unknown): WorkerReport {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const coverage: WorkerReport['coverage'] = [];
  if (Array.isArray(input.coverage)) {
    let used = 0;
    for (const entry of input.coverage) {
      const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const surface = text(item.surface, REPORT_PROSE_CAPS.coverageSurface); const risk = text(item.risk, REPORT_PROSE_CAPS.coverageRisk);
      if (!surface || !risk || !isOutcome(item.outcome)) continue;
      used += surface.length + risk.length + 16; if (used > REPORT_LIST_BYTES) break;
      coverage.push({ surface, risk, outcome: item.outcome as CoverageOutcome });
    }
  }
  const confidence = input.confidence === 'high' || input.confidence === 'medium' || input.confidence === 'low' ? input.confidence : 'low';
  return {
    summary: text(input.summary, REPORT_PROSE_CAPS.summary) ?? '(no summary supplied)',
    findings: reportList(input.findings, REPORT_PROSE_CAPS.findings),
    evidence: reportList(input.evidence, REPORT_PROSE_CAPS.evidence),
    coverage,
    openItems: reportList(input.openItems, REPORT_PROSE_CAPS.openItems),
    confidence,
    blocked: text(input.blocked, REPORT_PROSE_CAPS.blocked),
    ...(typeof input.outcome === 'string' && (WORKER_OUTCOMES as readonly string[]).includes(input.outcome) ? { outcome: input.outcome as WorkerReport['outcome'] } : {}),
    // A7.5: the hold is one bounded sentence, and only a well-formed request can create one.
    ...(holdFor(input.holdFor) ? { holdFor: holdFor(input.holdFor)! } : {}),
    // P10/WF-11: how many continuations that hold authorizes. Absent means the single hold; malformed (or out-of-range)
    // input falls back to 1 instead of widening it, and a count without holdFor is meaningless and dropped.
    ...(holdFor(input.holdFor) && holdContinuations(input.holdContinuations) !== undefined ? { holdContinuations: holdContinuations(input.holdContinuations)! } : {}),
  };
}

/** P10/WF-11: 0..3 continuation briefs a report-with-hold authorizes; anything else falls back to the single default. */
function holdContinuations(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : 1;
}

/** A7.5: one bounded sentence naming the successor this worker is worth holding for; malformed input is dropped, not guessed. */
function holdFor(value: unknown): { brief: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const brief = text((value as Record<string, unknown>).brief, 300)?.replace(/\s+/g, ' ').trim();
  return brief && brief.length >= 3 ? { brief } : undefined;
}

export class Broker {
  private server?: Server;
  private readonly clients = new Set<Socket>();
  private readonly registrations = new Map<string, WorkerRegistration>();
  /** Commands in flight per worker, so revoking a worker ends its wait instead of letting it run on. */
  private readonly inFlight = new Map<string, Set<AbortController>>();
  private totalUsed = 0;
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
    let workerId: string | undefined, receiptOnly = false;
    let chain: Promise<void> = Promise.resolve();
    const send = (payload: unknown) => { if (!socket.destroyed) socket.write(`${boundedResponse(payload)}\n`); };
    const fail = (message: string) => { this.deps.onProblem?.(message); send({ ok: false, error: message }); };
    socket.on('data', chunk => {
      buffer += chunk;
      // Serialize per connection so two tool calls cannot interleave around shared counters.
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
            receiptOnly = request?.receiptOnly === true;
            const registration = this.authenticate(request?.token, receiptOnly);
            if (!registration) { fail('Unauthorized'); socket.destroy(); return; }
            workerId = registration.workerId;
            send({ ok: true, workerId });
            return;
          }
          const brokerRequestId = request?.brokerRequestId;
          const response = receiptOnly && request?.op !== 'mutation_ack' ? {ok:false,error:'Receipt-only connection; no execution or mutation authority'} : await this.dispatch(workerId, request).catch(error => ({ok:false,error:errText(error)}));
          send({ brokerRequestId, ...response });
        }).catch(error => { fail(String(error instanceof Error ? error.message : error).slice(0, 400)); });
      }
      if (buffer.length > (this.limits.maxLineBytes ?? MAX_LINE_BYTES)) { fail('Request too large'); socket.destroy(); }
    });
    socket.on('error', error => this.deps.onProblem?.(`worker socket error: ${error.message}`));
    // A lost worker connection cannot leave an unbounded command or copied ticket running.
    socket.on('close', () => { this.clients.delete(socket); if (workerId && !receiptOnly) this.revoke(workerId); });
  }

  private authenticate(token: unknown, receiptOnly = false): WorkerRegistration | undefined {
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return undefined;
    for (const registration of this.registrations.values()) {
      if (registration.token === token) return registration.stopped && !(receiptOnly && (this.deps.replayMutation || this.deps.graphReplay)) ? undefined : registration;
    }
    return undefined;
  }

  private async dispatch(workerId: string, request: any): Promise<Record<string, unknown>> {
    const registration = this.registrations.get(workerId);
    if (!registration) return {ok:false,error:'Worker is not registered'};
    const op = text(request?.op, 32);
    const {brokerRequestId:_brokerRequestId,op:_op,requestId:_requestId,...submitted} = request;
    // The correlation field is transport, not payload: knowledge/graph/lab validators must not see it.
    if (request && typeof request === 'object') delete request.brokerRequestId;
    const mutation = (kind: string, payload: unknown): MutationRequest => {
      if (request?.requestId !== undefined && (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(request.requestId))) throw Error('Invalid mutation request ID');
      return {actorId:workerId,requestId:request.requestId ?? randomUUID(),payload:{op:kind,submitted:payload}};
    };
    if (op === 'mutation_ack') {
      if (!['note','report','started','graph_record'].includes(request?.mutationOp) || !request?.requestId || !request.original || typeof request.original !== 'object' || Array.isArray(request.original)) return {ok:false,error:'Invalid retained mutation ACK query'};
      const delivery=mutation(request.mutationOp,request.original);
      const acks=request.mutationOp==='graph_record' ? await this.deps.graphReplay?.(request.original.batch,registration,delivery)
        : await this.deps.replayMutation?.(registration,request.mutationOp,delivery);
      return acks ? {ok:true,acks,replayed:true} : {ok:false,error:'Mutation result unknown; no execution/mutation was replayed'};
    }
    const delivery = ['note','report','started','graph_record'].includes(op ?? '') ? mutation(op!,submitted) : undefined;
    if (delivery && (!registration.stopped || registration.reported)) {
      if(op==='graph_record') {const prior=await this.deps.graphReplay?.(request.batch,registration,delivery);if(prior)return {ok:true,value:prior,replayed:true};}
      else {const prior=await this.deps.replayMutation?.(registration,op!,delivery);if(prior)return op==='report'?{ok:true,acks:prior,replayed:true}:{ok:true,...prior[0],replayed:true};}
    }
    if (registration.stopped) return { ok: false, error: 'This worker was stopped by the owner' };
    if (this.reporting.has(workerId) && op !== 'status') return {ok:false,error:'Worker report persistence in progress; no further requests'};
    if (registration.effectiveRuntime?.verified === false && !['runtime','report','status','usage'].includes(op ?? '')) return { ok:false,error:'Runtime profile mismatch; report blocked, no investigation' };
    switch (op) {
      case 'skill_list': case 'skill_read': case 'artifact_read': case 'knowledge_heads': case 'knowledge_search': {
        if (!this.deps.knowledge) return { ok: false, error: 'Knowledge service unavailable' };
        return attempt(() => this.deps.knowledge!(op, request, registration));
      }
      case 'research': {
        // planning_update.md P14.8: research is not a target operation, so it counts as neither a target command nor a
        // separate counter; it is still recorded in the ledger, which is what keeps a citation auditable afterwards.
        if (!this.deps.research) return { ok: false, error: 'Research service unavailable' };
        return attempt(() => this.deps.research!(request ?? {}, registration));
      }
      case 'candidate': {
        if (!this.deps.candidate) return { ok: false, error: 'Candidate service unavailable' };
        return attempt(() => this.deps.candidate!(request?.candidate, registration));
      }
      case 'payload_write': case 'payload_read': case 'payload_materialize': {
        // Reading a payload is a bounded read of run state, writing one is coordination, and materializing one is a host
        // scratch write; none is a target operation.
        if (!this.deps.lab) return { ok: false, error: 'Payload service unavailable' };
        graphObject(submitted, op === 'payload_write' ? ['kind', 'name', 'body'] : ['id'], 'Payload request');
        return attempt(() => this.deps.lab!(op as 'payload_write' | 'payload_read' | 'payload_materialize', submitted, registration));
      }
      case 'environment': {
        if (!this.deps.environment) return { ok: false, error: 'Environment service unavailable' };
        const action = text(request?.action, 16);
        if (!action || !['create', 'verify', 'destroy'].includes(action)) return { ok: false, error: 'Environment action must be create, verify or destroy' };
        graphObject(submitted, action === 'create' ? ['action', 'name', 'recipe'] : ['action', 'id'], 'Environment request');
        // Each recipe command is one admitted target command in the caller's sandbox; nothing here bypasses admission.
        const control = { exec: async (command: string) => {
          const spent = await this.prepareCommand(registration);
          if (spent) throw Error(String(spent.error));
          const bound = registration.session;
          const result = await this.whileRunning(workerId, async signal => ({ ...(await this.deps.exec(command, 0, bound ? `/work/sessions/${bound}` : `/work/${workerId}`, signal, bound, registration.workerId)) }));
          if (typeof (result as { code?: unknown }).code !== 'number') throw Error('Environment command did not run');
          return { code: (result as { code: number }).code };
        } };
        return attempt(() => this.deps.environment!(action as 'create' | 'verify' | 'destroy', submitted, registration, control));
      }
      case 'context_read': {
        if(registration.effectiveRuntime?.verified!==true)return {ok:false,error:'Verified runtime required before context delivery'};
        graphObject(submitted,[],'Assignment context request');if(!this.deps.context)return {ok:false,error:'Indexed context service unavailable; no hidden fallback'};
        return {ok:true,value:await this.deps.context(registration)};
      }
      case 'context_ack': {
        if(registration.effectiveRuntime?.verified!==true)return {ok:false,error:'Verified runtime required before context receipt'};
        graphObject(submitted,['packetSha256'],'Context delivery ACK');if(typeof submitted.packetSha256!=='string'||!/^[a-f0-9]{64}$/.test(submitted.packetSha256)||!this.deps.contextAck)return {ok:false,error:'Invalid context delivery receipt'};
        return {ok:true,value:await this.deps.contextAck(submitted.packetSha256,registration)};
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
      case 'started': {
        if (!registration.effectiveRuntime?.verified) return {ok:false,error:'Verified runtime required before startup lifecycle'};
        const ack = await this.deps.started?.(registration, delivery);
        return {ok:true,...(ack ?? {})};
      }
      case 'status':
        return { ok: true, workerId, used: registration.used, reported: Boolean(registration.reported) };
      case 'secret_list': {
        // Ids, kinds, labels and scopes only. The owner answers from its sealed identity; there is no path from here to a value.
        if (!this.deps.secretList) return { ok: false, error: 'Secret listing unavailable' };
        return attempt(() => this.deps.secretList!(registration));
      }
      case 'usage':
        // Counters only, attributed by the authenticated registration (never by the payload); it is not a target command and gates nothing.
        return { ok: true, recorded: this.deps.usage?.(registration, request?.usage) === true };
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
      case 'exec':
      case 'net': {
        if (typeof request?.command !== 'string' || request.command.length > 32 * 1024) return { ok: false, error: 'command must be 1..32768 characters' };
        const command = text(request.command, 32 * 1024);
        let seconds: number;
        try { seconds = taskTimeout(request?.timeout); } catch (error) { return {ok:false,error:errText(error)}; }
        if (!command || !command.trim()) return { ok: false, error: 'command must be 1..32768 characters' };
        let session: string | undefined;
        try { session = heldSession(registration, request?.session); } catch (error) { return { ok: false, error: errText(error) }; }
        const spent = await this.prepareCommand(registration);
        if (spent) return spent;
        return this.whileRunning(workerId, async signal => {
          try {
            const workdir = session ? `/work/sessions/${session}` : `/work/${workerId}`;
            const runner = op === 'net' ? this.deps.net : undefined;
            const result = runner ? await runner(command, seconds, workdir, signal, session, workerId)
              : await this.deps.exec(command, seconds, workdir, signal, session, workerId);
            return { ok: true, ...result };
          } catch (error) { return { ok: false, error: errText(error) }; }
        });
      }
      case 'pty': {
        if (!this.deps.pty) return { ok: false, error: 'Interactive session unavailable' };
        const action = request?.action;
        if (action !== 'send' && action !== 'read') return { ok: false, error: 'pty action must be send or read' };
        if (action === 'send' && (typeof request?.data !== 'string' || !request.data.length || Buffer.byteLength(request.data) > 16 * 1024)) return { ok: false, error: 'send must be 1..16384 bytes of text' };
        let session: string | undefined;
        try { session = heldSession(registration, request?.session); } catch (error) { return { ok: false, error: errText(error) }; }
        if (!session) return { ok: false, error: 'SESSION_UNBOUND: open a session first (p2o_session action=open)' };
        const waitMs = typeof request?.waitMs === 'number' && Number.isSafeInteger(request.waitMs) ? request.waitMs : 5000;
        const spent = await this.prepareCommand(registration);
        if (spent) return spent;
        return this.whileRunning(workerId, async signal => {
          try {
            void signal;
            return { ok: true, ...(await this.deps.pty!(action, { session, data: request?.data, waitMs }, registration) as Record<string, unknown>) };
          } catch (error) { return { ok: false, error: errText(error) }; }
        });
      }
      case 'session': {
        if (!this.deps.session) return { ok: false, error: 'Session service unavailable' };
        const action = request?.action;
        if (!['open', 'list', 'exec', 'snapshot', 'close', 'upload', 'download', 'listen'].includes(action)) return { ok: false, error: 'Unknown session action' };
        // The ticket binds exactly one session; anything but opening a new one must name a session this ticket holds.
        let session: string | undefined;
        if (action !== 'open') {
          try { session = heldSession(registration, request?.session); } catch (error) { return { ok: false, error: errText(error) }; }
          if (!session) return { ok: false, error: 'SESSION_UNBOUND: open a session first (p2o_session action=open)' };
        }
        return attempt(() => this.deps.session!(action, { ...(request ?? {}), ...(session ? { session } : {}) }, registration));
      }
      case 'capture': {
        let path: string, seconds: number;
        let offset: number;
        try {path=scratchPath(request?.path);seconds=taskTimeout(request?.timeout);offset=scratchOffset(request?.offset);} catch(error) {return {ok:false,error:errText(error)};}
        const requestedMax=request?.maxBytes;
        if (requestedMax !== undefined && (typeof requestedMax !== 'number' || !Number.isSafeInteger(requestedMax) || requestedMax < 1 || requestedMax > 8192*1024)) return {ok:false,error:'maxBytes must be 1..8388608 bytes'};
        const capture=this.deps.capture;if (!capture) return {ok:false,error:'Scratch capture unavailable; no fallback read'};
        let session: string | undefined;
        try { session = heldSession(registration, request?.session); } catch (error) { return { ok: false, error: errText(error) }; }
        const spent=await this.prepareCommand(registration);if(spent)return spent;
        return this.whileRunning(workerId,async signal=>{
          try {return {ok:true,...await capture(path,seconds,workerId,signal,offset,session,requestedMax)};} catch(error) {return {ok:false,error:errText(error)};}
        });
      }
      case 'graph_record': {
        if (!this.deps.graphRecord) return {ok:false,error:'Graph service unavailable'};
        if(registration.effectiveRuntime?.verified!==true)return {ok:false,error:'Verified runtime required before graph recording'};
        try { graphObject(submitted,['batch'],'Graph recording request'); validateGraphBatch(request?.batch); return {ok:true,value:await this.deps.graphRecord(request.batch, registration, delivery!)}; }
        catch (error) {const prior=await this.deps.graphReplay?.(request?.batch,registration,delivery!);return prior?{ok:true,value:prior,replayed:true}:{ok:false,error:errText(error)};}
      }
      case 'graph_read': {
        if (!this.deps.graphRead) return {ok:false,error:'Graph service unavailable'};
        return attempt(() => this.deps.graphRead!(text(request?.graphOp,32) ?? 'page', (request ?? {}) as Record<string,unknown>, registration));
      }
      case 'http': {
        let parsed: HttpRequest;
        try {
          parsed = httpRequest(request);
        } catch (error) { return { ok: false, error: errText(error) }; }
        const spent = await this.prepareCommand(registration);
        if (spent) return spent;
        return this.whileRunning(workerId, async signal => {
          try {
            const result = await this.deps.http(parsed, signal, workerId);
            return { ok: true, ...result };
          } catch (error) { return { ok: false, error: errText(error) }; }
        });
      }
      case 'note': {
        if (!isRecordKind(request?.kind) || !['note', 'coverage', 'observation', 'open'].includes(request.kind)) return { ok: false, error: 'kind must be note, coverage, observation or open' };
        const body = text(request?.text, 2000);
        if (!body) return { ok: false, error: 'text is required' };
        const outcome = isOutcome(request?.outcome) ? request.outcome : undefined;
        if (request.kind === 'coverage' && (!text(request?.surface, 200) || !text(request?.risk, 200) || !outcome)) return { ok: false, error: 'coverage needs surface, risk and outcome' };
        const ack = await this.deps.note({
          at: new Date().toISOString(), by: workerId, kind: request.kind, text: body,
          workerId, role: registration.role, depth: registration.depth,
          ...(text(request?.surface, 200) ? { surface: text(request?.surface, 200) } : {}),
          ...(text(request?.risk, 200) ? { risk: text(request?.risk, 200) } : {}),
          ...(outcome ? { outcome } : {}),
          ...(stringList(request?.refs, 10, 200).length ? { refs: stringList(request?.refs, 10, 200) } : {}),
        }, delivery);
        return { ok: true, ...(ack ?? {}) };
      }
      case 'surface': {
        if (!this.deps.surface) return { ok: false, error: 'Surface inventory unavailable' };
        const component = text(request?.component, 200), entryPoint = text(request?.entryPoint, 200);
        if (!component || !entryPoint) return { ok: false, error: 'component and entryPoint are required' };
        try { return { ok: true, ...await this.deps.surface({ component, entryPoint, text: text(request?.text, 1000), refs: stringList(request?.refs, 10, 200) }, registration) }; }
        catch (error) { return { ok: false, error: errText(error) }; }
      }
      case 'request_subtask': {
        if (!this.deps.requestSubtask) return {ok:false,error:'Subtask proposals unavailable'};
        const focus = text(request?.focus,60), task = text(request?.task,4000);
        if (!focus || !task) return {ok:false,error:'focus and task are required'};
        return {ok:true,value:await this.deps.requestSubtask({focus,task,context:text(request?.context,4000),role:text(request?.role,32)},registration)};
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
        // A7.5/P10: an idle held worker waits for the lead's brief; a worker already running a consumed continuation may report it.
        if (registration.reported && !registration.holdConsumed && !registration.holdActive) return { ok: false, error: registration.holdBrief ? 'this worker reported and is held; wait for the lead brief instead of reporting again' : 'this worker already reported' };
        const report = normalizeReport(request?.report);
        if (this.reporting.has(workerId)) return {ok:false,error:'Report persistence already in progress'};
        this.reporting.add(workerId);
        try {
          let acks: void | RecordAck[];
          try { acks = await this.deps.report(workerId, report, delivery); }
          catch (error) {
            // Post-commit delivery failure is not a target retry. Lookup only; never run report builder twice.
            acks = delivery ? await this.deps.replayMutation?.(registration,'report',delivery) : undefined;
            if (!acks) throw error;
          }
          registration.reported = report;
          const authorized = report.holdFor ? report.holdContinuations ?? 1 : 0;
          if (report.holdFor && authorized > 0) {
            // A7.5/D19 + P10/WF-11: the ticket, pane and session stay alive for the authorized number of follow-up briefs (0..3,
            // default 1). The reaper skips this worker while it holds; stop/finish force-releases it exactly like any worker.
            registration.holdBrief = report.holdFor.brief;
            registration.holdContinuations = authorized;
            registration.holdConsumed = false; registration.holdActive = false;
          } else {
            // Reporting ends this worker's authority: a copied ticket cannot retain target access. A hold named with
            // holdContinuations=0 records the successor brief in the report but keeps no ticket, pane or session.
            registration.holdBrief = undefined; registration.holdContinuations = 0; registration.holdConsumed = false; registration.holdActive = false;
            this.revoke(workerId);
          }
          // Notification failure must not make an already committed report replayable.
          try { await this.deps.reportCommitted?.(registration); }
          catch (error) { this.deps.onProblem?.(`Report committed but notification failed: ${errText(error)}`); }
          return { ok: true, ...(acks ? {acks} : {}) };
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

  /** One target command. Counted for the ledger and the report; never refused, because a run has no allowance (owner decision 2026-10-24). */
  private spend(registration: WorkerRegistration): Record<string, unknown> | undefined {
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
    : JSON.stringify({ brokerRequestId: value.brokerRequestId, ok: false, error: 'Response exceeds broker frame limit; narrow the request' });
}

function errText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 600); }

export interface BrokerClientOptions { connectMs?: number; requestMs?: number; receiptOnly?: boolean }

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
          const waiter = this.pending.get(record.brokerRequestId);
          if (!waiter) continue;
          this.pending.delete(record.brokerRequestId);
          if (record.ok === true) waiter.resolve(record);
          else waiter.reject(new Error(String(record.error ?? 'broker request failed')));
        }
        if (buffer.length > MAX_LINE_BYTES) this.fail('owner broker response exceeded the line limit');
      });
      socket.write(`${JSON.stringify({ token: this.token, ...(this.options.receiptOnly ? {receiptOnly:true} : {}) })}\n`);
    });
  }

  private fail(message: string): void {
    this.broken = `${message}. Do not retry host-side work; call p2o_report with blocked.`;
    for (const waiter of this.pending.values()) waiter.reject(new Error(this.broken));
    this.pending.clear();
    this.socket?.destroy();
    this.socket = undefined;
  }

  request<T = any>(op: string, payload: Record<string, unknown> = {}, options: { timeoutMs?: number | null; signal?: AbortSignal; requestId?: string } = {}): Promise<T> {
    const run = async (): Promise<T> => {
      options.signal?.throwIfAborted();
      await this.connect();
      options.signal?.throwIfAborted();
      const socket = this.socket;
      if (!socket) throw new Error(this.broken ?? 'owner broker unavailable');
      const brokerRequestId = ++this.sequence, requestId = options.requestId ?? randomUUID();
      if (Buffer.byteLength(JSON.stringify({ ...payload,brokerRequestId,op,requestId })) > MAX_LINE_BYTES - 1) throw new Error('Request exceeds broker frame limit; narrow the report or request');
      const timeoutMs = options.timeoutMs === null ? null : options.timeoutMs ?? this.options.requestMs ?? 60_000;
      return new Promise<T>((resolve, reject) => {
        const abort = () => this.fail('worker request cancelled; revoke its executor access');
        const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort',abort); };
        const timer = timeoutMs === null ? undefined : setTimeout(() => { this.pending.delete(brokerRequestId); cleanup(); reject(new Error(`p2o ${op} request timed out after ${timeoutMs}ms`)); }, timeoutMs);
        this.pending.set(brokerRequestId, {
          resolve: value => { cleanup(); resolve(value as T); },
          reject: error => { cleanup(); reject(error); },
        });
        options.signal?.addEventListener('abort',abort,{once:true});
        if (options.signal?.aborted) { abort(); return; }
        socket.write(`${JSON.stringify({ ...payload, brokerRequestId, op, requestId })}\n`);
      });
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  close(): void { this.fail('worker session ended'); }
}

/**
 * M8/A7.5: a live worker may be continued as often as it is useful. A reported worker cannot be continued unless it reported with
 * a hold, and that hold authorizes exactly one continuation (the successor run on the same ticket, pane and session).
 */
export function continuationRefusal(registration: { stopped?: boolean; paneClosed?: boolean; reported?: unknown; holdBrief?: string; holdConsumed?: boolean; continues?: number }): string | undefined {
  if (registration.stopped || registration.paneClosed) return 'WORKER_CLOSED: the worker is stopped or its pane is gone; start a new task rather than continuing a closed conversation';
  if (registration.reported && registration.holdBrief) return undefined;
  if (registration.reported && registration.holdConsumed) return 'HELD_CONTINUATION_USED: this worker already used every held continuation this report authorized; wait for its next report, then create a new task for another question';
  if (registration.reported) return 'WORKER_CLOSED: the worker already reported and its ticket is retired; its conversation cannot be continued — create a new task for the same question instead';
  return undefined;
}

/**
 * A7.5/P10: consume one continuation a hold authorizes. Returns the brief that was held (the owner sends it as the successor
 * brief) or undefined when this worker held nothing. The last continuation retires the hold exactly like the original single
 * hold; a multi-brief hold keeps the ticket held for the remaining briefs. Pure state transition, so the handler and the tests
 * share one rule.
 */
export function consumeHeldContinuation(registration: WorkerRegistration): string | undefined {
  if (!registration.holdBrief) return undefined;
  const brief = registration.holdBrief, remaining = Math.max(1, registration.holdContinuations ?? 1);
  registration.continues = (registration.continues ?? 0) + 1;
  registration.holdActive = true;
  if (remaining > 1) { registration.holdContinuations = remaining - 1; return brief; }
  registration.holdBrief = undefined; registration.holdContinuations = 0; registration.holdConsumed = true;
  return brief;
}
