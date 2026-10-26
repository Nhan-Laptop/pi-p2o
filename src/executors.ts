import type { Sandbox } from './sandbox.js';

export type ExecutorMode = 'shared' | 'isolated' | 'session';

/** Run-owned executors; each isolated assignment has fresh scratch/cookies/process lifetime.
 * Global admission limits target pressure independently of model slots. No automatic restart.
 *
 * A7.2 (planning_update.md P7.4): `session` keeps one long-lived sandbox per session id instead of one per assignment.
 * The operation gate is unchanged, so a session multiplies *state* (files, processes, a credential, a PTY) and not target
 * pressure. Every session is opened explicitly, bound to an assignment only while the owner says so, and closed by the
 * verified removal path; nothing is resumed or re-created after a fault.
 */
export class ExecutorPool {
  private leases = new Map<string, {sandbox:Sandbox; start:Promise<void>}>();
  /** Session mode only: assignment/worker id → the session it may use. A worker never names a session it was not bound to. */
  private assignments = new Map<string, string>();
  private closed = false;
  private running = 0;
  private waiters: Array<() => void> = [];
  /** Re-checked after any wait for a target-operation slot and before the work starts, so an operator hold also stops commands that were queued. */
  beforeStart?: () => void;
  constructor(readonly mode: ExecutorMode, readonly maxOperations: number, private primary: Sandbox,
    private factory: (session?: string) => Sandbox, private active: () => boolean, private sessionLimit: number = maxOperations) {}
  private gate() { if (this.closed || !this.active()) throw Error('Executor ownership inactive'); }
  /** Host-side consistency check: a child executor may only see the source snapshot the confirmation sealed. */
  private assertSameSource(sandbox: Sandbox) {
    const stable = (m:Record<string,string>) => JSON.stringify(Object.entries(m).sort(([a],[b]) => a.localeCompare(b)));
    if (stable(sandbox.sourceManifest) !== stable(this.primary.sourceManifest) || sandbox.sourceSkipped !== this.primary.sourceSkipped) throw Error('Source snapshot changed; isolated assignment blocked, no execution');
  }
  /** The sandbox an operation id routes to, or undefined. Root/owner keeps the run's primary shell; a session is only
   * reachable by its own id or by an assignment the owner bound to it. */
  private sandboxFor(id: string): Sandbox | undefined {
    if (this.mode === 'shared' || id === 'owner') return this.primary;
    if (this.mode === 'isolated') return this.leases.get(id)?.sandbox;
    const session = this.leases.has(id) ? id : this.assignments.get(id);
    return session ? this.leases.get(session)?.sandbox : undefined;
  }
  private missing(): never {
    throw Error(this.mode === 'session'
      ? 'SESSION_UNAVAILABLE: no session is bound to this assignment; open one with p2o_session action=open (no implicit executor, no automatic restart)'
      : 'Assignment executor unavailable; report partial, no automatic restart');
  }
  async acquire(id: string) {
    this.gate();
    if (this.mode === 'session') throw Error('SESSION_MODE: this run uses session executors; open a session with p2o_session action=open instead of an isolated assignment executor');
    if (this.mode === 'shared' || this.leases.has(id)) return;
    const sandbox = this.factory();
    try {
      await sandbox.start(); this.gate();
      this.assertSameSource(sandbox);
      await sandbox.provision(id); this.gate();
    } catch (error) {
      // A failed start/provision is never a usable lease. The caller records a host prerequisite and must not
      // start a worker: publishing the lease first is what turned a mkdir failure into a dead executor.
      // If verified removal itself fails, retain the lease so /p2o stop can retry instead of leaking ownership.
      let cleanup: string | undefined;
      try { await sandbox.stop(); }
      catch (stopError) { cleanup = stopError instanceof Error ? stopError.message : String(stopError); this.leases.set(id,{sandbox,start:Promise.resolve()}); }
      const reason = error instanceof Error ? error.message : String(error);
      throw Error(`EXECUTOR_PROVISION_FAILED: ${reason}${cleanup ? `; cleanup unresolved: ${cleanup}` : ''}`);
    }
    this.leases.set(id,{sandbox,start:Promise.resolve()});
  }
  /**
   * A7.2: open one long-lived session sandbox. The session count is capped by the same target-operation ceiling, so the
   * operator does not get a second, invisible concurrency budget: N default is exactly `maxOperations`.
   */
  async openSession(id: string) {
    this.gate();
    if (this.mode !== 'session') throw Error('SESSION_MODE: no session executor is enabled; start with --executors session[:N]');
    if (this.leases.has(id)) throw Error(`SESSION_EXISTS: ${id} is already open; list it or close it first`);
    const limit = Math.min(this.sessionLimit, this.maxOperations);
    if (this.leases.size >= limit) throw Error(`SESSION_LIMIT: ${this.leases.size} open session(s) already use the session cap ${limit} (target-operation cap ${this.maxOperations}); close one first`);
    const sandbox = this.factory(id);
    try {
      await sandbox.start(); this.gate();
      this.assertSameSource(sandbox);
      await sandbox.provision(id, '/work/sessions'); this.gate();
    } catch (error) {
      let cleanup: string | undefined;
      try { await sandbox.stop(); }
      catch (stopError) { cleanup = stopError instanceof Error ? stopError.message : String(stopError); this.leases.set(id,{sandbox,start:Promise.resolve()}); }
      const reason = error instanceof Error ? error.message : String(error);
      throw Error(`SESSION_OPEN_FAILED: ${reason}${cleanup ? `; cleanup unresolved: ${cleanup}` : ''}`);
    }
    this.leases.set(id,{sandbox,start:Promise.resolve()});
  }
  /** Bind one assignment to an already-open session. The binding is owner-side state, never a ticket claim. */
  bind(assignment: string, session: string) {
    if (this.mode !== 'session') throw Error('SESSION_MODE: this run does not use sessions');
    if (!this.leases.has(session)) throw Error(`SESSION_UNKNOWN: ${session} is not open`);
    this.assignments.set(assignment, session);
  }
  unbind(assignment: string) { this.assignments.delete(assignment); }
  /** The session bound to this assignment, if any. Read-only display and ledger facts use it. */
  bound(assignment: string): string | undefined { return this.assignments.get(assignment); }
  /** A7.8: the container name a lab-network peer can resolve for this session, if the executor has one. */
  containerName(id: string): string | undefined { return this.sandboxFor(id)?.containerName; }
  /** Host coordination, not a target operation: materialize bytes in the assignment's own scratch without consuming an admission slot. */
  async writeScratch(id: string, path: string, bytes: Buffer, signal: AbortSignal | undefined, workdir: string, mode = 0o500) {
    this.gate(); signal?.throwIfAborted();
    const sandbox = this.sandboxFor(id);
    if (!sandbox || sandbox.isStopped) this.missing();
    // A session owns one persistent home; assignment scratch inside it is the same directory so a later step finds the bytes.
    const root = this.mode === 'session' && sandbox.session ? sandbox.sessionWorkdir : workdir;
    return sandbox.writeScratch(path, bytes, signal, root, mode);
  }
  /** Close one session (or release one isolated assignment). The verified removal path is the only path that stops it. */
  async release(id: string) {
    const lease = this.leases.get(id); if (!lease) return;
    await lease.start.catch(() => {});
    await lease.sandbox.stop(); // stop verifies its OWN container names; no whole-run sweep here.
    this.leases.delete(id);
    for (const [assignment, session] of [...this.assignments]) if (session === id) this.assignments.delete(assignment);
  }
  async use<T>(id: string, signal: AbortSignal | undefined, work: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    this.gate(); signal?.throwIfAborted();
    while (this.running >= this.maxOperations) {
      await new Promise<void>((resolve,reject) => {
        const wake = () => {cleanup(); resolve();};
        const abort = () => {cleanup(); reject(Error('Cancelled while queued for executor'));};
        const cleanup = () => {signal?.removeEventListener('abort',abort);this.waiters=this.waiters.filter(w => w!==wake);};
        this.waiters.push(wake);signal?.addEventListener('abort',abort,{once:true});
        if (signal?.aborted) abort();
      });
      this.gate(); signal?.throwIfAborted();
    }
    this.gate(); this.running += 1;
    try {
      const sandbox = this.sandboxFor(id);
      if (!sandbox || sandbox.isStopped) this.missing();
      signal?.throwIfAborted(); this.beforeStart?.(); return await work(sandbox);
    } finally { this.running -= 1; for (const wake of [...this.waiters]) wake(); }
  }
  async stop() {
    this.closed = true; for (const wake of [...this.waiters]) wake();
    const results = await Promise.allSettled([...this.leases.keys()].map(id => this.release(id)));
    if (results.some(r => r.status === 'rejected')) throw Error(this.mode === 'session' ? 'Session executor cleanup unresolved; retry /p2o stop' : 'Isolated executor cleanup unresolved; retry /p2o stop');
    this.assignments.clear();
  }
  /** Whether the session's interactive PTY child is alive; display-only. */
  livePty(id: string): boolean { return this.sandboxFor(id)?.hasLivePty === true; }
  /** Open session ids, sorted; empty for the other modes. A session is never reported as owned after its removal. */
  openSessions(): string[] { return this.mode === 'session' ? [...this.leases.keys()].sort() : []; }
  snapshot() { return {mode:this.mode,maxTargetOperations:this.maxOperations,runningTargetOperations:this.running,waitingTargetOperations:this.waiters.length,ownedAssignmentExecutors:this.leases.size,openSessions:this.openSessions()}; }
}
