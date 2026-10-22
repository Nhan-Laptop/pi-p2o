import type { Counted } from './counts.js';
import type { TaskTerminalState } from './tasks.js';
import type { ChainJoin } from './chain-view.js';

/**
 * planning_update.md P13(h): the shapes a tool hands back as `details` were inferred per call site, so a payload could lose a field
 * without any test or caller noticing — the same failure mode P11 fixed for counts and P13(a) fixed for claim identity. These
 * interfaces are the declaration; the call sites annotate their returns with them, so `npm run typecheck` refuses a payload that
 * drops a field the lead reads. They describe what the owner sees, not new authority: nothing here is stored or validated.
 */

/** `p2o_task list`: navigation summaries. The full task is read by `id`, never inferred from this page. */
export interface TaskListPage extends Counted {
  tasks: Array<{ id: string; recordId: string; revision: number; status: string; role: string; assignee: string | undefined; terminal: TaskTerminalState | undefined; question: string }>;
  warning: string;
}

/** `p2o_case list`: the review queue with its derived readiness, not the finding bodies. */
export interface CaseListPage extends Counted {
  entries: Array<{ id: string; recordId: string; revision: number; title: string; verdict: string; reviewStatus: string; currentness: string;
    acceptedFinding: boolean; readyToRate: boolean; independentCurrent: boolean; canonicalCaseId: string; severity?: string; staleReasons: string[] }>;
  warning: string;
}

/** `p2o_graph {action:"chain"}`: the join plus the per-list denominators that make the page self-describing. */
export interface ChainViewPage extends ChainJoin {
  counts: { primitives: number; ready: number; unmet: number; frontier: number };
  shown: { primitives: number; ready: number; unmet: number; frontier: number };
  next: string;
}

/** `p2o_workers`: two counted summaries and the reconciliation omissions, kept apart so neither reads as the other. */
export interface WorkersNavigation {
  engine: unknown;
  executors: unknown;
  complete: boolean;
  changes: Counted & { items: Array<{ id?: string; by: string; kind: string; text: string }> };
  tasks: Counted;
  taskItems: unknown[];
  diagnostics: string[];
  reconciliation: { omitted: number };
  budgets: { workerUsed: number; workerCeiling: number; leadSubmitted: number };
  progress: Array<{ id: string; state: string; lastProblem?: string; stallSuspected: boolean; outcome?: string }>;
  warning: string;
}
