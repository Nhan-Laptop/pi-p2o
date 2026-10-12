import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { MutationRequest } from './state/store.js';
import { join } from 'node:path';
import type { ProcessResult } from './process.js';
import { httpRequest, taskTimeout, type HttpRequest } from './target.js';
import { isOutcome, isRecordKind, type AssessmentRecord, type CoverageOutcome, type LedgerPage, type RecordAck } from './records.js';
import { reportingOperationDenied } from './tool-policy.js';
import { scratchOffset, scratchPath } from './scratch.js';
import { graphObject, validateGraphBatch, type GraphAck, type GraphBatch } from './state/graph.js';
import type { ContextCursor, ContextPacket } from './context.js';
import type { AssessmentTask } from './tasks.js';
import { TEXT_CONTROL_G } from './validate.js';
export type { GraphBatch } from './state/graph.js';

/**
 * Owner-served broker. Strix shares one sandbox session with every agent; Pi workers are separate
 * processes, so the owner exposes exactly the same session over a private unix socket and keeps the
 * policy, the budgets and the single cleanup path in one place. Workers never receive a Docker client.
 */
export const MAX_LINE_BYTES = 64 * 1024;
export const WORKER_BUDGET_RESERVE = 0.9;
export const DEFAULT_WORKER_COMMAND_BUDGET = 200;

/** How a worker's assignment ended, as it states it in p2o_report; the host never infers success from it. */
export const WORKER_OUTCOMES = ['completed', 'partial-budget', 'prerequisite-blocked', 'provider-error', 'cancelled', 'expired', 'unknown'] as const;
export interface WorkerReport {
  summary: string;
  findings: string[];
  evidence: string[];
  coverage: Array<{ surface: string; risk: string; outcome: CoverageOutcome }>;
  openItems: string[];
  confidence: 'high' | 'medium' | 'low';
  blocked?: string;
  outcome?: typeof WORKER_OUTCOMES[number];
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
  paneClosed?: boolean;
  reported?: WorkerReport;
  taskId?: string;
  requestedRuntime?: { model?: string; thinking?: string };
  effectiveRuntime?: { model?: string; thinking?: string; verified: boolean };
}

export interface DelegateInput { focus: string; task: string; context?: string; role?: string; skills?: string[]; model?: string; workflow?: string; thinking?: string; taskId?: string; work?: Record<string, unknown>; decision?: Record<string, unknown>; outputContract?: Record<string, unknown> }
export interface DelegateResult { workerId: string; name: string; paneId: string; role: string; model?: string; depth: number }

export interface BrokerDeps {
  exec(command: string, seconds: number, workdir: string, signal: AbortSignal): Promise<ProcessResult>;
  /** Network-egress command: identical executor, separately labelled so its receipts are auditable. */
  net?(command: string, seconds: number, workdir: string, signal: AbortSignal): Promise<ProcessResult>;
  http(request: HttpRequest, signal: AbortSignal, workerId?: string): Promise<ProcessResult>;
  /** Fixed scratch read under this authenticated assignment; no caller-selected root/host path. */
  capture?(path: string, seconds: number, workerId: string, signal: AbortSignal, offset: number): Promise<ProcessResult>;
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
  onBudget?(workerId: string, reason: string): void;
  delegate(input: DelegateInput, parent: WorkerRegistration): Promise<DelegateResult>;
  report(workerId: string, report: WorkerReport, request?: MutationRequest): Promise<void | RecordAck[]>;
  /** Commit boundary: report persisted, registration terminal and authority revoked. */
  reportCommitted?(worker: WorkerRegistration): Promise<void>;
  requestSubtask?(input: DelegateInput, parent: WorkerRegistration): Promise<unknown>;
  knowledge?(op: string, request: Record<string, unknown>, worker: WorkerRegistration): Promise<unknown>;
  candidate?(input: unknown, worker: WorkerRegistration): Promise<unknown>;
  onProblem?(message: string): void;
}

export interface BrokerLimits { totalCommandBudget: number; maxLineBytes?: number }

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(TEXT_CONTROL_G, '');
  return clean.length > limit ? clean.slice(0, limit) : clean;
}

const READ_CALLS = 160, COORDINATION_CALLS = 200;
/** Runs one service call and answers with its value, or with the error text instead of throwing into the socket handler. */
async function attempt(work: () => Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error: errText(error) }; }
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
    ...(typeof input.outcome === 'string' && (WORKER_OUTCOMES as readonly string[]).includes(input.outcome) ? { outcome: input.outcome as WorkerReport['outcome'] } : {}),
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
  /**
   * One unit of a worker's knowledge allowance. Reads stop at 160 so that 40 calls stay reserved for notes, candidates and graph records (200 in all).
   * Returns the refusal to send back, or undefined once the unit is spent.
   */
  private charge(workerId: string, cap: typeof READ_CALLS | typeof COORDINATION_CALLS, exhausted: string): { ok: false; error: string } | undefined {
    const used = this.knowledgeUsed.get(workerId) ?? 0;
    if (used >= cap) return { ok: false, error: exhausted };
    this.knowledgeUsed.set(workerId, used + 1);
    return undefined;
  }
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
            receiptOnly = request?.receiptOnly === true;
            const registration = this.authenticate(request?.token, receiptOnly);
            if (!registration) { fail('Unauthorized'); socket.destroy(); return; }
            workerId = registration.workerId;
            send({ ok: true, workerId });
            return;
          }
          const response = receiptOnly && request?.op !== 'mutation_ack' ? {ok:false,error:'Receipt-only connection; no execution or mutation authority'} : await this.dispatch(workerId, request).catch(error => ({ok:false,error:errText(error)}));
          send({ id: request?.id, ...response });
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
    const {id:_id,op:_op,requestId:_requestId,...submitted} = request;
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
    if (reportingOperationDenied(registration.role,op ?? '')) return {ok:false,error:'Reporting role is synthesis-only; request separate execution/validation'};
    switch (op) {
      case 'skill_list': case 'skill_read': case 'artifact_read': case 'knowledge_heads': case 'knowledge_search': {
        const refused = this.charge(workerId, READ_CALLS, 'Knowledge read budget exhausted; 40 coordination calls reserved for notes/candidates (200 total)');
        if (refused) return refused;
        if (!this.deps.knowledge) return { ok: false, error: 'Knowledge service unavailable' };
        return attempt(() => this.deps.knowledge!(op, request, registration));
      }
      case 'candidate': {
        const refused = this.charge(workerId, COORDINATION_CALLS, 'Coordination budget exhausted');
        if (refused) return refused;
        if (!this.deps.candidate) return { ok: false, error: 'Candidate service unavailable' };
        return attempt(() => this.deps.candidate!(request?.candidate, registration));
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
        return { ok: true, workerId, used: registration.used, budget: registration.commandBudget, reported: Boolean(registration.reported) };
      case 'usage':
        // Counters only, attributed by the authenticated registration (never by the payload); it spends no command budget and gates nothing.
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
        if (typeof request?.command !== 'string' || request.command.length > 8192) return { ok: false, error: 'command must be 1..8192 characters' };
        const command = text(request.command, 8192);
        let seconds: number;
        try { seconds = taskTimeout(request?.timeout); } catch (error) { return {ok:false,error:errText(error)}; }
        if (!command || !command.trim()) return { ok: false, error: 'command must be 1..8192 characters' };
        const spent = await this.prepareCommand(registration);
        if (spent) return spent;
        return this.whileRunning(workerId, async signal => {
          try {
            const workdir = `/work/${workerId}`;
            const runner = op === 'net' ? this.deps.net : undefined;
            const result = runner ? await runner(command, seconds, workdir, signal)
              : await this.deps.exec(command, seconds, workdir, signal);
            return { ok: true, ...result };
          } catch (error) { return { ok: false, error: errText(error) }; }
        });
      }
      case 'capture': {
        let path: string, seconds: number;
        let offset: number;
        try {path=scratchPath(request?.path);seconds=taskTimeout(request?.timeout);offset=scratchOffset(request?.offset);} catch(error) {return {ok:false,error:errText(error)};}
        const capture=this.deps.capture;if (!capture) return {ok:false,error:'Scratch capture unavailable; no fallback read'};
        const spent=await this.prepareCommand(registration);if(spent)return spent;
        return this.whileRunning(workerId,async signal=>{
          try {return {ok:true,...await capture(path,seconds,workerId,signal,offset)};} catch(error) {return {ok:false,error:errText(error)};}
        });
      }
      case 'graph_record': {
        const refused = this.charge(workerId, COORDINATION_CALLS, 'Coordination budget exhausted');
        if (refused) return refused;
        if (!this.deps.graphRecord) return {ok:false,error:'Graph service unavailable'};
        if(registration.effectiveRuntime?.verified!==true)return {ok:false,error:'Verified runtime required before graph recording'};
        try { graphObject(submitted,['batch'],'Graph recording request'); validateGraphBatch(request?.batch); return {ok:true,value:await this.deps.graphRecord(request.batch, registration, delivery!)}; }
        catch (error) {const prior=await this.deps.graphReplay?.(request?.batch,registration,delivery!);return prior?{ok:true,value:prior,replayed:true}:{ok:false,error:errText(error)};}
      }
      case 'graph_read': {
        const refused = this.charge(workerId, READ_CALLS, 'Knowledge read budget exhausted; 40 coordination calls reserved');
        if (refused) return refused;
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
        const refused = this.charge(workerId, COORDINATION_CALLS, 'Coordination budget exhausted');
        if (refused) return refused;
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
        const refused = this.charge(workerId, COORDINATION_CALLS, 'Coordination budget exhausted');
        if (refused) return refused;
        if (!this.deps.surface) return { ok: false, error: 'Surface inventory unavailable' };
        const component = text(request?.component, 200), entryPoint = text(request?.entryPoint, 200);
        if (!component || !entryPoint) return { ok: false, error: 'component and entryPoint are required' };
        try { return { ok: true, ...await this.deps.surface({ component, entryPoint, text: text(request?.text, 1000), refs: stringList(request?.refs, 10, 200) }, registration) }; }
        catch (error) { return { ok: false, error: errText(error) }; }
      }
      case 'request_subtask': {
        const refused = this.charge(workerId, COORDINATION_CALLS, 'Coordination budget exhausted; include request in final report');
        if (refused) return refused;
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
        if (registration.reported) return { ok: false, error: 'this worker already reported' };
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
          // Reporting ends this worker's authority: a copied ticket cannot retain target access.
          this.revoke(workerId);
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
          const waiter = this.pending.get(record.id);
          if (!waiter) continue;
          this.pending.delete(record.id);
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
      const id = ++this.sequence, requestId = options.requestId ?? randomUUID();
      if (Buffer.byteLength(JSON.stringify({ ...payload,id,op,requestId })) > MAX_LINE_BYTES - 1) throw new Error('Request exceeds broker frame limit; narrow the report or request');
      const timeoutMs = options.timeoutMs === null ? null : options.timeoutMs ?? this.options.requestMs ?? 60_000;
      return new Promise<T>((resolve, reject) => {
        const abort = () => this.fail('worker request cancelled; revoke its executor access');
        const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort',abort); };
        const timer = timeoutMs === null ? undefined : setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error(`p2o ${op} request timed out after ${timeoutMs}ms`)); }, timeoutMs);
        this.pending.set(id, {
          resolve: value => { cleanup(); resolve(value as T); },
          reject: error => { cleanup(); reject(error); },
        });
        options.signal?.addEventListener('abort',abort,{once:true});
        if (options.signal?.aborted) { abort(); return; }
        socket.write(`${JSON.stringify({ ...payload, id, op, requestId })}\n`);
      });
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  close(): void { this.fail('worker session ended'); }
}
