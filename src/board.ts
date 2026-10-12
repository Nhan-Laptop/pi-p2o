import { readLedger, type LedgerIndex } from './records.js';

/**
 * What the owner-side boards (tasks, plans, cases, coverage) share: mutations run one at a time, each against a complete, freshly read index,
 * and the board's authority is checked before the read and again after it, so a run that has stopped cannot commit a late write.
 * The subclass supplies its own heads (frontier) and its own records; nothing here widens what a board may write.
 */
export abstract class LedgerBoard {
  protected pending: Promise<unknown> = Promise.resolve();
  /** `authority` names the board in the refusal ("Case review authority inactive"); `noun` names its records ("Case reconciliation incomplete"). */
  protected constructor(readonly runId: string, readonly path: string, private readonly active: () => boolean, private readonly authority: string, private readonly noun: string) {}
  protected gate(): void { if (!this.active()) throw new Error(`${this.authority} authority inactive`); }
  protected serialized<T>(work: (index: LedgerIndex) => Promise<T>): Promise<T> {
    const next = this.pending.then(async () => {
      this.gate();
      const index = await readLedger(this.path, this.runId);
      if (!index.complete) throw new Error(`${this.noun} reconciliation incomplete`);
      this.gate();
      return work(index);
    });
    this.pending = next.catch(() => {});
    return next;
  }
}
