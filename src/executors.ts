import type { Sandbox } from './sandbox.js';

export type ExecutorMode = 'shared' | 'isolated';

/** Run-owned executors; each isolated assignment has fresh scratch/cookies/process lifetime.
 * Global admission limits target pressure independently of model slots. No automatic restart.
 */
export class ExecutorPool {
  private leases = new Map<string, {sandbox:Sandbox; start:Promise<void>}>();
  private closed = false;
  private running = 0;
  private waiters: Array<() => void> = [];
  constructor(readonly mode: ExecutorMode, readonly maxOperations: number, private primary: Sandbox,
    private factory: () => Sandbox, private active: () => boolean) {}
  private gate() { if (this.closed || !this.active()) throw Error('Executor ownership inactive'); }
  async acquire(id: string) {
    this.gate(); if (this.mode === 'shared' || this.leases.has(id)) return;
    const sandbox = this.factory();
    // Publish before start: failed/partial starts remain owned until verified removal.
    const start = (async () => {
      await sandbox.start(); this.gate();
      const stable = (m:Record<string,string>) => JSON.stringify(Object.entries(m).sort(([a],[b]) => a.localeCompare(b)));
      if (stable(sandbox.sourceManifest) !== stable(this.primary.sourceManifest) || sandbox.sourceSkipped !== this.primary.sourceSkipped) throw Error('Source snapshot changed; isolated assignment blocked, no execution');
    })();
    this.leases.set(id,{sandbox,start});
    await start;
  }
  async release(id: string) {
    const lease = this.leases.get(id); if (!lease) return;
    await lease.start.catch(() => {});
    await lease.sandbox.stop(); // stop verifies its OWN container names; no whole-run sweep here.
    this.leases.delete(id);
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
      const sandbox = this.mode === 'shared' || id === 'owner' ? this.primary : this.leases.get(id)?.sandbox;
      if (!sandbox || sandbox.isStopped) throw Error('Assignment executor unavailable; report partial, no automatic restart');
      signal?.throwIfAborted(); return await work(sandbox);
    } finally { this.running -= 1; for (const wake of [...this.waiters]) wake(); }
  }
  async stop() {
    this.closed = true; for (const wake of [...this.waiters]) wake();
    const results = await Promise.allSettled([...this.leases.keys()].map(id => this.release(id)));
    if (results.some(r => r.status === 'rejected')) throw Error('Isolated executor cleanup unresolved; retry /p2o stop');
  }
  snapshot() { return {mode:this.mode,maxTargetOperations:this.maxOperations,runningTargetOperations:this.running,waitingTargetOperations:this.waiters.length,ownedAssignmentExecutors:this.leases.size}; }
}
