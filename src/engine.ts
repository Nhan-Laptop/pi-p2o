import type { DelegateInput } from './broker.js';
import { demandSignature, type RoundBudget } from './round-budget.js';
import type { LoopMode } from './roles.js';
import type { AssessmentTask } from './tasks.js';

export interface EngineEvent { sequence: number; kind: string; id: string; reason?: string }
export interface QueuedIntent { taskId: string; revision: number; priority: number; input: DelegateInput; reason?: string; /** P10/TR-H12: the work identity accepted at enqueue time, so a cosmetic/status-only revision keeps the queue. */ identity: string }
/**
 * P10/TR-H12: what makes an accepted intent mean the same work. A revision that leaves this unchanged (a cosmetic edit or a
 * status-only advance) does not discard the queued intent; a changed question/work identity does require a new explicit dispatch.
 */
export function intentIdentity(task: AssessmentTask): string {
  return JSON.stringify([task.question, task.role, task.expectedTrue ?? '', task.expectedFalse ?? '', task.stopCondition ?? '',
    task.workFingerprint ?? task.workOverlapKey ?? '', task.work?.claimRefs ?? [], task.work?.questionKey ?? '', task.work?.assetRefs ?? [],
    (task.prerequisites ?? []).map(p => `${p.taskId}@${p.revision ?? '*'}`), task.validationOf ?? '', task.retestOf ?? '', task.parentTaskId ?? '',
    (task.method?.skills ?? []).map(skill => skill.id), task.method?.workflow?.id ?? '']);
}
/** A6.3: why a wake was reserved, so status and the P6 metrics count wakes without re-deriving them. */
export type WakeReason = 'event' | 'debt' | 'heartbeat';
export interface PlannerWake { runId: string; epoch: number; through: number; round: number; /** P16.2: the named obligations a stalled-but-unfinished round still owes. */ demand?: string; /** A6.3: what caused this wake; a heartbeat is not an event. */ reason?: WakeReason }
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
  /** A6.2: the derived research-debt numbers behind `remaining`; carried so A6.3 can pace a debt wake without re-reading. */
  debt?: { gateable: number; total: number };
}
/** A4: what a round's ending looks like to the stall rule. Both facts are read from the ledger by the caller, never invented here. */
export interface RoundStall { openGoal: boolean; openIntents: number }
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
  /** A6.3: the caller's clock, so fake timers can drive the heartbeat deterministically. Defaults to `Date.now`. */
  now?(): number;
  /** A6.3: the campaign heartbeat in seconds; `0`/absent disables it. Read lazily so the campaign record stays the one source. */
  heartbeatSeconds?(): number;
  /** P18/A9: the round budget in force, or `undefined` when the caller did not supply one. Reported in the snapshot only. */
  roundBudget?(): RoundBudget | undefined;
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
  /**
   * P5.1 (A6.3): consecutive stalled rounds *since the last human decision*. This is a streak, not a lifetime total:
   * `/p2o resume` resets it, so one stale round after a resume cannot immediately re-pause the campaign (the measured
   * gate run paused on stalls 4, 5 and 6 because a cumulative counter could never fall back below the threshold).
   * The cumulative fact count stays ledger-derived (`planner.stalled` records), never this counter.
   */
  private stallStreak = 0;
  private quiet: number[] = [];
  /** P10/TR-H11: the unverified-removal fact is recorded once per episode, not on every retry. */
  private reapUnverified = false;
  private readonly revisits = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  /** P18/A9: the demand a `wait` answered, so only an unchanged demand is suppressed by it (a new obligation can wake). */
  private decision?: { disposition: 'wait' | 'blocked'; reason: string; demand: string };
  /** A6.3: the single unref'd campaign heartbeat timer, its next fire time and the last debt wake (for pacing). */
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAt?: number;
  private lastDebtWakeAt?: number;
  private lastWake?: { reason: WakeReason; round: number };
  /** A6.5: the wall-clock at which the current round was reserved, so status can say how long it has been running. */
  private roundStartedAt?: number;
  /**
   * P18/D48: `mode` is recorded for readers of older snapshots; a live run is always the automatic loop. P18: the fixed
   * debounce window is 800 ms so a burst of committed events becomes one round instead of several.
   */
  constructor(readonly runId: string, readonly mode: LoopMode, private deps: EngineDeps, private debounceMs = 800) { this.armHeartbeat(); }
  private live() { return !this.stopped && this.deps.active(); }
  /** A6.5: one place that starts a round, so the counter and the round-start timestamp cannot drift apart. */
  private beginRound(): number { this.roundStartedAt = this.clock(); return ++this.rounds; }
  private gate() { if (!this.live()) throw Error('Assessment engine inactive'); }
  /** A6.3: the clock is the caller's, never read directly, so a fake timer can move it. */
  private clock(): number { return (this.deps.now ?? Date.now)(); }
  private heartbeat(): number { const seconds = this.deps.heartbeatSeconds?.() ?? 0; return Number.isFinite(seconds) && seconds > 0 ? seconds : 0; }
  /**
   * A6.3: arm exactly one heartbeat. It is not a poll: it fires once, re-arms from the fire path, and is disposed by
   * pause/stop. A run has one loop mode (P18/D48), so the heartbeat is never suppressed by a mode test.
   */
  private armHeartbeat() {
    clearTimeout(this.heartbeatTimer); this.heartbeatTimer = undefined; this.heartbeatAt = undefined;
    if (this.stopped || this.paused) return;
    const seconds = this.heartbeat(); if (!seconds) return;
    this.heartbeatAt = this.clock() + seconds * 1000;
    this.heartbeatTimer = setTimeout(() => { this.heartbeatTimer = undefined; this.heartbeatAt = undefined; this.fireHeartbeat(); }, seconds * 1000);
    this.heartbeatTimer.unref?.();
  }
  private clearHeartbeat() { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = undefined; this.heartbeatAt = undefined; }
  /**
   * A6.3: a heartbeat wake continues a campaign that still owes work when no event arrived. It never fires inside a turn,
   * never resurrects a stopped/inactive run and never wakes a run whose last judged round was complete.
   */
  private fireHeartbeat() {
    if (!this.live() || this.paused) return;
    this.armHeartbeat();
    if (this.busy || this.reservation) return;
    const owed = this.progress.remaining > 0 || (this.progress.debt?.gateable ?? 0) > 0;
    if (!owed && this.rounds > 0) return;
    const seconds = this.heartbeat();
    const demand = `heartbeat ${seconds}s${this.progress.demand ? `; ${this.progress.demand}` : this.progress.remaining > 0 ? `; ${this.progress.remaining} obligation(s) remain` : ''}`;
    const wake: PlannerWake = { runId: this.runId, epoch: this.epoch, through: this.sequence, round: this.beginRound(), demand, reason: 'heartbeat' };
    this.lastWake = { reason: 'heartbeat', round: wake.round };
    this.reservation = wake; this.deps.wake(wake);
  }
  /** A6.3: arm the campaign heartbeat once the owner phase is active; nothing is dispatched here. */
  start() { this.gate(); this.armHeartbeat(); }
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
        return {taskId:task.id,revision:task.revision,priority,input:{...i.input},identity:intentIdentity(task)};
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
    // P10/TR-H11: an unverified pane removal is capacity backpressure, not a campaign failure. It is recorded once as a fact and
    // the dispatch round is skipped; the next kick retries the reaper, so accepted intents and semantic events stay live.
    if (!await this.deps.reap()) {
      if (!this.reapUnverified) {
        this.reapUnverified = true;
        await this.deps.persist('PANE_REAP_UNVERIFIED: completed pane removal unverified; dispatch waits for the next kick instead of pausing the campaign',
          { event: 'engine.reap-unverified', runId: this.runId, sequence: this.sequence });
      }
      return;
    }
    this.reapUnverified = false;
    // A stop/finish can land while reaping workers. That is not a scheduler failure: the gate is closed, so leave quietly.
    if (!this.live() || this.paused) return;
    for (const job of [...this.queue.values()].sort((a,b) => b.priority-a.priority)) {
      if (!this.live() || this.paused || this.deps.capacity() <= 0) break;
      const task = (await this.deps.list()).find(t => t.id === job.taskId); this.gate(); if (this.paused) break;
      // P10/TR-H12/Q32: withdrawing the task or changing its work identity invalidates the accepted intent; a revision that
      // leaves the identity unchanged (a status-only or cosmetic edit) updates it and keeps dispatching.
      if (!task || task.status !== 'proposed') {
        this.queue.delete(job.taskId); this.notify('intent-invalidated',job.taskId,task ? `Task is ${task.status}; planner must explicitly dispatch a new intent` : 'Task withdrawn; planner must explicitly dispatch a new intent'); continue;
      }
      if (intentIdentity(task) !== job.identity) {
        this.queue.delete(job.taskId); this.notify('intent-invalidated',job.taskId,'Question or work identity changed; planner must explicitly dispatch the new revision'); continue;
      }
      if (task.revision !== job.revision) job.revision = task.revision;
      const readiness = await this.deps.readiness(job.taskId); this.gate(); if (this.paused) break;
      if (!readiness.ready) {job.reason = readiness.reason; continue;}
      try { await this.deps.spawn(job.input); }
      catch (error) {
        // P19/F: a refused dispatch used to be a UI notification only, so a task left `proposed` had no ledger row saying why.
        // The bounded fact is written before the notification, and the "never retry automatically" rule is unchanged.
        // `fail()` throws Error("CODE: message"), so the message (not String(error)'s "Error: " prefix) carries the code.
        const raw = error instanceof Error ? error.message : String(error);
        const reason = raw.slice(0,300), code = /^([A-Z][A-Z0-9_]+):/.exec(reason)?.[1] ?? 'DISPATCH_REFUSED';
        await this.deps.persist(`dispatch refused for ${job.taskId}: ${reason}`, { event: 'intent-blocked', taskId: job.taskId, code, reason }).catch(() => { /* The fact is best effort; dispatch never retries target/pane launch. */ });
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
    if (!this.live() || this.paused || this.reservation) return;
    const quiet = this.quietText(); let demand: string | undefined, reason: WakeReason = 'event';
    if (this.events.size) {
      if (quiet) {
        if (this.progress.remaining > 0) demand = `quiet ${quiet}; ${this.progress.demand ?? `${this.progress.remaining} obligation(s) remain`}`;
        else {this.pause(`${quiet}; the completion is complete, so no automatic wake is scheduled — add work and /p2o resume`);return;}
      }
    } else {
      // A6.3 debt wake: nothing new arrived, but the round ended owing work. This is the branch that would have continued the
      // observed run at 04:00 instead of stopping once its first roadmap was exhausted. It is paced by the heartbeat interval
      // and suppressed by a `p2o_loop wait` that still answers the same demand (P18/A9: new named demand wakes again).
      const owed = this.progress.remaining > 0 || (this.progress.debt?.gateable ?? 0) > 0;
      if (!owed || (this.decision?.disposition === 'wait' && this.decision.demand === demandSignature(this.progress.demand))) return;
      const seconds = this.heartbeat();
      if (seconds && this.lastDebtWakeAt !== undefined && this.clock() < this.lastDebtWakeAt + seconds * 1000) return;
      reason = 'debt'; this.lastDebtWakeAt = this.clock();
      const owedText = this.progress.demand ?? (this.progress.remaining > 0 ? `${this.progress.remaining} obligation(s) remain` : 'research debt remains');
      demand = quiet ? `quiet ${quiet}; ${owedText}` : owedText;
    }
    const wake: PlannerWake = {runId:this.runId,epoch:this.epoch,through:this.sequence,round:this.beginRound(),...(demand?{demand}:{}),reason};
    this.lastWake = {reason,round:wake.round};
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
  /** A4: record a stalled round as a durable report fact — never a wake, queue entry, pause or new work budget. A round that
   * ends with an open goal, no open/running intent and no blocked declaration is not progress, so it must not be silent.
   * Every such round is recorded; the caller's `persist` writes the lifecycle record and the engine shapes nothing else.
   * P5.1: a round only exists once the engine admitted one. The human `/p2o` command turn that ends before the first wake is
   * not a campaign round, so it cannot be a stalled round and cannot consume two of the three escalation steps (the measured
   * gate run escalated on stalls 1-3 with `rounds: 0`, i.e. before any planner round existed).
   * P5.1: the escalation counter is a streak reset by `resume()`, not a lifetime total.
   */
  async stallRound(facts: RoundStall): Promise<boolean> {
    if (!this.live() || this.paused || this.decision?.disposition === 'blocked' || !facts.openGoal || facts.openIntents > 0) return false;
    // No admitted round yet: the human command turn that ends before the first wake is not a campaign round, so it can be
    // neither a stalled round nor one of the three escalation steps (P5.1; one automatic loop mode since P18/D48).
    if (this.rounds === 0) return false;
    this.stallStreak += 1;
    await this.deps.persist(
      'planner.stalled: the round ended with an open goal, no open/running intent and no blocked declaration; recorded as a report fact, never a wake or new budget',
      { event: 'planner.stalled', openGoal: true, openIntents: 0, rounds: this.rounds, sequence: this.sequence, stalls: this.stallStreak });
    // A6.3: three stalled rounds with gateable debt is no longer a report fact. The loop pauses for a human decision; nothing
    // is retried, restarted or spent automatically, and /p2o resume clears it.
    if (this.stallStreak >= 3 && (this.progress.debt?.gateable ?? 0) > 0 && this.live()) {
      await this.deps.persist('planner.stall-escalation: three stalled rounds while research debt remains; the loop needs a human decision',
        { event: 'planner.stall-escalation', stalls: this.stallStreak, debt: this.progress.debt, sequence: this.sequence });
      this.pause('three rounds with no open intent while research debt remains; the loop needs a human decision (/p2o resume or /p2o stop)');
    }
    return true;
  }
  /** Delivery ACK only: never discard events committed after the projected barrier. */
  consume(through = this.sequence, progress?: RoundProgress) {
    if (!Number.isSafeInteger(through) || through < 0 || through > this.sequence) throw Error('Invalid semantic consumption barrier');
    const delta = [...this.events.values()].filter(event => event.sequence <= through).sort((a,b) => a.sequence-b.sequence);
    for (const [key,event] of this.events) if (event.sequence <= through) this.events.delete(key);
    this.consumed = Math.max(this.consumed,through);
    if (this.reservation && this.reservation.through <= through) this.reservation = undefined;
    if (progress) this.judge(progress);
    // A6.3: a round boundary is when the campaign heartbeat is (re)armed; the model is no longer inside a turn once consume runs.
    this.armHeartbeat();
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
  /**
   * P18.2/D46: the counters the last judged round left behind, or nothing before a round was judged. The round briefing's
   * "delta since the last round" reads this copy, so it compares against the same numbers `judge` compared instead of
   * keeping a second counter that could drift.
   */
  previousProgress(): RoundProgress | undefined { return this.rounds > 1 ? { ...this.progress } : undefined; }
  /**
   * P18.2/D46: the revisits that are still scheduled, read from the same map the timers live in, so a brief cannot name a
   * revisit that already fired. Order is by condition, never by scheduler insertion.
   */
  pendingRevisits(): Array<{ condition: string; at: string }> {
    return [...this.revisits].sort(([left], [right]) => left.localeCompare(right)).map(([condition, entry]) => ({ condition, at: new Date(entry.at).toISOString() }));
  }
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
  /** A revisit is a scheduled wake; pause, stop and epoch still win. */
  private fireRevisit() {
    if (!this.live() || this.paused) return;
    const wake = { runId: this.runId, epoch: this.epoch, through: this.sequence, round: this.beginRound() };
    this.reservation = wake; this.deps.wake(wake);
  }
  async disposition(disposition: 'wait' | 'blocked', reason: string) {
    if (!reason.trim() || reason.length > 1000) throw Error('Disposition needs a bounded reason');
    return this.serialize(async () => {
      const demand = demandSignature(this.progress.demand);
      await this.deps.persist(`Planner ${disposition}: ${reason}`,{decision:{disposition,reason}}); this.gate();
      this.decision = {disposition,reason,demand};
      if (disposition === 'blocked') this.pause(reason);
      return this.snapshot();
    });
  }
  pause(reason: string) {
    this.paused = reason; this.epoch += 1; this.reservation = undefined;
    clearTimeout(this.timer); this.timer = undefined; this.clearHeartbeat(); this.deps.problem(reason);
  }
  resume() {
    this.gate();
    // P5.1 (A6.3): a human decision is a new baseline. The escalation streak starts over, otherwise `stallStreak >= 3` stays
    // true forever and every later stalled round re-pauses the campaign without any new evidence.
    this.paused = undefined; this.decision = undefined; this.stallStreak = 0; this.armHeartbeat(); this.kick();
  }
  stop() {
    this.stopped = true; this.epoch += 1; this.reservation = undefined;
    for (const entry of this.revisits.values()) clearTimeout(entry.timer);
    this.revisits.clear();
    clearTimeout(this.timer); this.timer = undefined; this.clearHeartbeat(); this.events.clear(); this.queue.clear();
  }
  async join() { await this.mutations; await this.pumping; }
  snapshot() {
    const intents = [...this.queue.values()].map(({taskId,revision,priority,reason}) => ({taskId,revision,priority,reason}));
    const events = [...this.events.values()];
    return {runId:this.runId,mode:this.mode,epoch:this.epoch,state:this.stopped ? 'stopped' : this.paused ? 'blocked' : this.busy ? 'running' : this.reservation ? 'scheduled' : 'waiting',
      paused:this.paused,rounds:this.rounds,decision:this.decision,stalls:this.stallStreak,
      // P18.4/D48: the demand floor reads these two without a ledger scan: the last judged round's obligation count and the name
      // the owner gave it. `remaining` is always present so a consumer cannot read absence as "unknown".
      remaining:this.progress.remaining,...(this.progress.demand?{demand:this.progress.demand}:{}),
      heartbeat:{seconds:this.heartbeat(),...(this.heartbeatAt!==undefined?{nextAt:new Date(this.heartbeatAt).toISOString()}:{})},lastWake:this.lastWake,
      ...(this.roundStartedAt!==undefined?{roundStartedAt:new Date(this.roundStartedAt).toISOString()}:{}),
      ...(this.deps.roundBudget?.()!==undefined?{roundBudget:this.deps.roundBudget!()}:{}),
      sequence:this.sequence,consumedSequence:this.consumed,pendingEvents:events.length,events:events.slice(-20),eventsOmitted:Math.max(0,events.length-20),
      pendingIntents:intents.length,intents:intents.slice(0,20),intentsOmitted:Math.max(0,intents.length-20),
      warning:'Owner-local coordination, not evidence or restored authority. Read the runtime executor profile for target concurrency. Automatic rounds are extra provider requests, not a hard monetary/token cap.'};
  }
}
