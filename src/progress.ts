export type ProgressKind = 'queued' | 'running' | 'returned' | 'error' | 'reported' | 'cancelled' | 'expired';
export interface ProgressEvent { sequence: number; at: number; kind: ProgressKind; operation?: string; error?: string }

/** Observable local events only. No timers, dispatch, retries or models. */
export class ProgressState {
  private sequence = 0;
  private events = new Map<string, ProgressEvent>();
  private commands = new Map<string, number>();
  private outcomes = new Map<string,string>();
  constructor(private now = () => Date.now(), private changed?: () => void) {}
  record(by: string, kind: ProgressKind, operation?: string, error?: string) {
    const event = { sequence: ++this.sequence, at: this.now(), kind, operation, error: error?.slice(0, 600) };
    this.events.set(by,event);
    if (['cancelled','expired','error'].includes(kind)) this.outcomes.set(by,kind);
    if (kind === 'queued') this.commands.set(by,(this.commands.get(by) ?? 0)+1);
    try { this.changed?.(); } catch { /* Rendering must not change operation authority/outcome. */ }
    return event;
  }
  view(by: string, quietMs = 120000) {
    const last = this.events.get(by);
    return { last, commandsSubmitted:this.commands.get(by) ?? 0,
      state:last?.kind ?? 'unknown', lastProblem:this.outcomes.get(by), stallSuspected:Boolean(last && this.now()-last.at > quietMs && ['queued','running'].includes(last.kind)),
      warning:'Quiet time is not proven failure; queued work is not execution proof. Lead commands and worker commands are counted separately, never capped.' };
  }
}
