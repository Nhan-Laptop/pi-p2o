import type { SessionScope } from '../runtime/types.js';

/** Supervisor-supplied binding. Never inferred from a grant, a PID, or an ambient singleton. */
export interface PackSessionLifecycle {
  /** Checked inside actual creation/actions (including queued actions), not only by the broker. */
  check(context: SessionScope): Promise<void>;
  /** Durable creation intent BEFORE allocating a process/listener/container. IDs are pack session IDs. */
  enroll(context: SessionScope, id: string, data?: Record<string, unknown>): Promise<void>;
  /** Identity evidence can be completed after sealing; this never grants permission to create/use. */
  update(context: SessionScope, id: string, data: Record<string, unknown>): Promise<void>;
  /** Only after resource absence has been proved. Failure must remain attributable/retryable. */
  resolve(context: SessionScope, id: string): Promise<void>;
}

export const packScopeKey = (scope: SessionScope): string => JSON.stringify([scope.runId, scope.taskId, scope.attemptId]);
export const samePackScope = (a: SessionScope, b: SessionScope): boolean => packScopeKey(a) === packScopeKey(b);

/** Shared local creation fence: teardown waits for in-flight creators and cannot publish an empty count early. */
export class PackCreationFence {
  private readonly sealed = new Set<string>();
  private readonly pending = new Map<string, Set<Promise<unknown>>>();
  private closed = false;
  constructor(private readonly lifecycle?: PackSessionLifecycle) {}

  async check(context: SessionScope): Promise<void> {
    if (this.closed || this.sealed.has(packScopeKey(context))) throw new Error('Pack attempt is sealed; a stale session cannot be reused');
    await this.lifecycle?.check(context);
    if (this.closed || this.sealed.has(packScopeKey(context))) throw new Error('Pack attempt is sealed; a stale session cannot be reused');
  }

  create<T>(context: SessionScope, work: () => Promise<T>): Promise<T> {
    const key = packScopeKey(context);
    const pending = this.pending.get(key) ?? new Set<Promise<unknown>>();
    this.pending.set(key, pending);
    const result = (async () => { await this.check(context); return await work(); })();
    pending.add(result);
    void result.finally(() => { pending.delete(result); if (!pending.size) this.pending.delete(key); }).catch(() => {});
    return result;
  }

  async seal(context: SessionScope): Promise<void> {
    const key = packScopeKey(context);
    this.sealed.add(key);
    await Promise.allSettled([...this.pending.get(key) ?? []]);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()].flatMap(set => [...set]));
  }
}
