import type { DelegateInput } from './broker.js';
import type { LoopMode } from './roles.js';
import type { AssessmentTask } from './tasks.js';

export interface EngineEvent { sequence: number; kind: string; id: string; reason?: string }
export interface QueuedIntent { taskId: string; revision: number; priority: number; input: DelegateInput; reason?: string }
export interface PlannerWake { runId: string; epoch: number; through: number; round: number; /** P16.2: the named obligations a stalled-but-unfinished round still owes. */ demand?: string }
/**
 * M6: what a round is judged on. Monotone counters, so equality means the round added nothing — no tested cell, no candidate
 * closure, no asset and no chain depth. The owner computes them at its own consumption barrier; the engine only compares.
 */
export interface RoundProgress {
  testedCells: number; closures: number; assets: number; chainDepth: number;
  /** P16.3-adjacent P16.2: what the completion still owes at this barrier. Zero pauses; anything else demands by name. */
  remaining: number;
  /** The named obligations, built by the owner from the ledger. The engine never invents work or target prose. */
  demand?: string;
}
const QUIET_ROUNDS = 2;
export interface EngineDeps {
  active(): boolean;
  list(): Promise<AssessmentTask[]>;
  readiness(id: string): Promise<{ready: boolean; reason?: string}>;
  capacity(): number;
  reap(): Promise<boolean>;
  spawn(input: DelegateInput): Promise<unknown>;
  persist(text: string, data: unknown): Promise<void>;
  wake(wake: PlannerWake): void;
  idle(): boolean;
  problem(reason: string): void;
}

/** Deterministic owner-local scheduler. Journal/projections never reconstruct execution authority.
 * No model, target traffic, timer or process is started by construction.
 */
export class AssessmentEngine {
  private epoch = 0;
  private sequence = 0;
  private consumed = 0;
  private events = new Map<string, EngineEvent>();
  private queue = new Map<string, QueuedIntent>();
  private timer?: ReturnType<typeof setTimeout>;
  private pumping?: Promise<void>;
  private mutations: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private paused?: string;
  private busy = false;
  private reservation?: PlannerWake;
  private rounds = 0;
  private progress: RoundProgress = { testedCells: 0, closures: 0, assets: 0, chainDepth: 0, remaining: 0 };
  private quiet: number[] = [];
  private readonly revisits = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  private decision?: { disposition: 'wait' | 'blocked'; reason: string };
  constructor(readonly runId: string, readonly mode: LoopMode, private deps: EngineDeps, private debounceMs = 100) {}
  private live() { return !this.stopped && this.deps.active(); }
  private gate() { if (!this.live()) throw Error('Assessment engine inactive'); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(async () => {this.gate(); return work();});
    this.mutations = next.catch(() => {}); return next;
  }
  async enqueue(inputs: Array<{taskId: string; input: DelegateInput; priority?: number}>) {
    return this.serialize(async () => {
      if (!inputs.length || inputs.length > 25) throw Error('Queue batches require 1..25 intents');
      const tasks = await this.deps.list(); this.gate();
      const additions = inputs.map(i => {
        const task = tasks.find(t => t.id === i.taskId);
        if (!task || task.status !== 'proposed') throw Error('Queued intent requires a proposed owner task');
        if (i.input.taskId !== task.id) throw Error('Intent identity mismatch');
        const priority = i.priority ?? 0;
        if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw Error('Invalid intent priority');
        return {taskId:task.id,revision:task.revision,priority,input:{...i.input}};
      });
      if (new Set(additions.map(i => i.taskId)).size !== additions.length || additions.some(i => this.queue.has(i.taskId))) throw Error('Intent already queued');
      await this.deps.persist('Planner accepted intents into the frontier; no new scope or authority', {intents:additions}); this.gate();
      for (const i of additions) this.queue.set(i.taskId,i);
      this.kick(); return this.snapshot();
    });
  }
  /** Only call after a semantic state commit (never for stdout/skill reads/noisy notes). */
  notify(kind: string, id: string, reason?: string) {
    if (!this.live()) return;
    const key = `${kind}:${id}`;
    if (!this.events.has(key) && this.events.size >= 256) {this.pause('Semantic event backlog overflow; inspect complete ledger before resuming'); return;}
    this.events.set(key,{sequence:++this.sequence,kind,id,reason:reason?.slice(0,300)});
    this.kick();
  }
  kick() {
    if (!this.live() || this.paused || this.timer) return;
    // Fixed window, not a reset-on-each-signal debounce. No periodic paid polling.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump().then(() => this.wakeIdle()).catch(error => this.pause(`Scheduler blocked: ${String(error).slice(0,400)}`));
    },this.debounceMs);
    this.timer.unref?.();
  }
  private async pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    const work = this.drain(); this.pumping = work;
    try { await work; } finally {this.pumping = undefined;}
  }
  private async drain() {
    if (!this.live() || this.paused) return;
    if (!await this.deps.reap()) {this.pause('Completed pane removal unverified; capacity backpressure, retry with /p2o resume');return;}
    // A stop/finish can land while reaping workers. That is not a scheduler failure: the gate is closed, so leave quietly.
    if (!this.live() || this.paused) return;
    for (const job of [...this.queue.values()].sort((a,b) => b.priority-a.priority)) {
      if (!this.live() || this.paused || this.deps.capacity() <= 0) break;
      const task = (await this.deps.list()).find(t => t.id === job.taskId); this.gate(); if (this.paused) break;
      if (!task || task.revision !== job.revision || task.status !== 'proposed') {
        this.queue.delete(job.taskId); this.notify('intent-invalidated',job.taskId,'Task revised or withdrawn; planner must explicitly dispatch the new revision'); continue;
      }
      const readiness = await this.deps.readiness(job.taskId); this.gate(); if (this.paused) break;
      if (!readiness.ready) {job.reason = readiness.reason; continue;}
      try { await this.deps.spawn(job.input); }
      catch (error) {
        if (this.live()) this.notify('intent-blocked',job.taskId,String(error));
        // Never retry target/pane launch automatically. Partial spawn is cleaned by the adapter.
      }
      this.queue.delete(job.taskId);
    }
  }
  /** M6: two quiet rounds in a row have to be explained; nothing here counts commands or time. */
  private quietText(): string | undefined {
    if (this.quiet.length < QUIET_ROUNDS) return;
    return `rounds ${this.quiet.join(' and ')} added nothing measurable (no tested cell, candidate closure, asset or chain depth)`;
  }
  /**
   * P16.2 frontier floor: a quiet round does not end an unfinished run. Work owed outranks "added nothing", so the wake
   * carries the obligation by name and the loop stays live; only a complete run (or a lead-recorded blocked) goes quiet.
   */
  private reserveWake(): PlannerWake | undefined {
    if (!this.live() || this.paused || this.mode !== 'event-driven' || this.reservation || !this.events.size) return;
    const quiet = this.quietText(); let demand: string | undefined;
    if (quiet) {
      if (this.progress.remaining > 0) demand = `quiet ${quiet}; ${this.progress.demand ?? `${this.progress.remaining} obligation(s) remain`}`;
      else {this.pause(`${quiet}; the completion is complete, so no automatic wake is scheduled — add work and /p2o resume`);return;}
    }
    const wake = {runId:this.runId,epoch:this.epoch,through:this.sequence,round:++this.rounds,...(demand?{demand}:{})};
    this.reservation = wake; return wake;
  }
  private wakeIdle() {
    if (this.busy || !this.deps.idle()) return;
    const wake = this.reserveWake(); if (wake) this.deps.wake(wake);
  }
  /** A boundary custom entry supplies runnable context even after a final assistant message. */
  boundary(): PlannerWake | undefined { return this.reserveWake(); }
  validWake(wake: PlannerWake): boolean { return this.live() && !this.paused && wake.runId === this.runId && wake.epoch === this.epoch && this.reservation?.through === wake.through && this.reservation?.round === wake.round; }
  forget(taskId: string) {this.queue.delete(taskId);}
  started() { this.busy = true; }
  settled() { this.busy = false; this.kick(); }
  /** Delivery ACK only: never discard events committed after the projected barrier. */
  consume(through = this.sequence, progress?: RoundProgress) {
    if (!Number.isSafeInteger(through) || through < 0 || through > this.sequence) throw Error('Invalid semantic consumption barrier');
    const delta = [...this.events.values()].filter(event => event.sequence <= through).sort((a,b) => a.sequence-b.sequence);
    for (const [key,event] of this.events) if (event.sequence <= through) this.events.delete(key);
    this.consumed = Math.max(this.consumed,through);
    if (this.reservation && this.reservation.through <= through) this.reservation = undefined;
    if (progress) this.judge(progress);
    return delta;
  }
  /** One judgement per round: a round that repeats the previous counters is quiet, anything else clears the streak. */
  private judge(progress: RoundProgress) {
    const quiet = progress.testedCells === this.progress.testedCells && progress.closures === this.progress.closures
      && progress.assets === this.progress.assets && progress.chainDepth === this.progress.chainDepth;
    this.progress = { ...progress };
    if (!quiet) { this.quiet = []; return; }
    if (!this.rounds || this.quiet.includes(this.rounds)) return;
    this.quiet = [...this.quiet, this.rounds].slice(-QUIET_ROUNDS);
  }
  /** Rounds judged quiet right now, oldest first. Read-only: escalation is decided when the next wake is reserved. */
  quietRounds(): number[] { return [...this.quiet]; }
  /** M7: the pending revisit for a condition, if one is already scheduled. The caller decides how to refuse a duplicate. */
  revisitAt(condition: string): number | undefined { return this.revisits.get(condition)?.at; }
  /**
   * M7: exactly one revisit, tied to a stated condition and never re-armed by itself. The timer only fires a wake; it restores
   * nothing and it stays silent while the run is paused, blocked or stopped.
   */
  scheduleRevisit(condition: string, notBefore: number): { condition: string; at: string } {
    this.gate();
    if (!Number.isSafeInteger(notBefore) || notBefore <= Date.now()) throw Error('A revisit needs a future timestamp');
    const pending = this.revisits.get(condition);
    if (pending) throw Error(`REVISIT_DUPLICATE: condition ${condition} already has a pending revisit at ${new Date(pending.at).toISOString()}`);
    const timer = setTimeout(() => { this.revisits.delete(condition); this.fireRevisit(); }, notBefore - Date.now());
    timer.unref?.();
    this.revisits.set(condition, { at: notBefore, timer });
    return { condition, at: new Date(notBefore).toISOString() };
  }
  /** A revisit is a scheduled wake, so it is not gated on event-driven mode; pause, stop and epoch still win. */
  private fireRevisit() {
    if (!this.live() || this.paused) return;
    const wake = { runId: this.runId, epoch: this.epoch, through: this.sequence, round: ++this.rounds };
    this.reservation = wake; this.deps.wake(wake);
  }
  async disposition(disposition: 'wait' | 'blocked', reason: string) {
    if (!reason.trim() || reason.length > 1000) throw Error('Disposition needs a bounded reason');
    return this.serialize(async () => {
      await this.deps.persist(`Planner ${disposition}: ${reason}`,{decision:{disposition,reason}}); this.gate();
      this.decision = {disposition,reason};
      if (disposition === 'blocked') this.pause(reason);
      return this.snapshot();
    });
  }
  pause(reason: string) {
    this.paused = reason; this.epoch += 1; this.reservation = undefined;
    clearTimeout(this.timer); this.timer = undefined; this.deps.problem(reason);
  }
  resume() {
    this.gate();
    this.paused = undefined; this.decision = undefined; this.kick();
  }
  stop() {
    this.stopped = true; this.epoch += 1; this.reservation = undefined;
    for (const entry of this.revisits.values()) clearTimeout(entry.timer);
    this.revisits.clear();
    clearTimeout(this.timer); this.timer = undefined; this.events.clear(); this.queue.clear();
  }
  async join() { await this.mutations; await this.pumping; }
  snapshot() {
    const intents = [...this.queue.values()].map(({taskId,revision,priority,reason}) => ({taskId,revision,priority,reason}));
    const events = [...this.events.values()];
    return {runId:this.runId,mode:this.mode,epoch:this.epoch,state:this.stopped ? 'stopped' : this.paused ? 'blocked' : this.busy ? 'running' : this.reservation ? 'scheduled' : 'waiting',
      paused:this.paused,rounds:this.rounds,decision:this.decision,
      sequence:this.sequence,consumedSequence:this.consumed,pendingEvents:events.length,events:events.slice(-20),eventsOmitted:Math.max(0,events.length-20),
      pendingIntents:intents.length,intents:intents.slice(0,20),intentsOmitted:Math.max(0,intents.length-20),
      warning:'Owner-local coordination, not evidence or restored authority. Read the runtime executor profile for target concurrency. Automatic rounds are extra provider requests, not a hard monetary/token cap.'};
  }
}
