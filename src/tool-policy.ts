/** Responsibility is enforced independently of prompt/model selection. */
export const TARGET_TOOLS = ['p2o_shell', 'p2o_net', 'p2o_http', 'p2o_capture'];
/** P14.2: the payload artifact is execution evidence, so only an executing role may create or read one. */
export const LAB_TOOLS = ['p2o_lab'];
export const OWNER_TOOLS = ['p2o_task', 'p2o_plan', 'p2o_case', 'p2o_coverage', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_skill_list', 'p2o_skill_read', 'p2o_research', 'p2o_candidate', ...LAB_TOOLS, ...TARGET_TOOLS, 'p2o_note', 'p2o_surface', 'p2o_delegate', 'p2o_workers', 'p2o_loop', 'p2o_finish'];
export const WORKER_TOOLS = ['p2o_skill_list', 'p2o_skill_read', 'p2o_research', 'p2o_candidate', ...LAB_TOOLS, ...TARGET_TOOLS, 'p2o_note', 'p2o_surface', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_request_subtask', 'p2o_report'];
export const ALL_TOOLS = [...new Set([...OWNER_TOOLS, ...WORKER_TOOLS])];
/** Tools that only make sense when workers exist; a solo owner (--solo, no Herdr, --max-depth 0) is not offered them. `p2o_loop` stays because it reports engine and frontier status. */
export const DELEGATION_TOOLS = ['p2o_delegate', 'p2o_workers'];
export function ownerTools(delegated: boolean): string[] { return delegated ? OWNER_TOOLS.filter(t => !TARGET_TOOLS.includes(t)) : OWNER_TOOLS.filter(t => !DELEGATION_TOOLS.includes(t)); }
// A reporting worker keeps p2o_research: a citation lookup is not target execution and not a work slot, and the shared
// knowledge prompt names the tool, so hiding it here would make the prompt promise a tool the role cannot call.
// P15: `DUTIES.reporting` says the same thing in the worker's own duty line ("run no target command"), so the tool allowance and the
// duty cannot read as a contradiction the worker has to resolve for itself.
export function workerTools(role: string): string[] { return role === 'reporting' ? WORKER_TOOLS.filter(t => !TARGET_TOOLS.includes(t) && !LAB_TOOLS.includes(t) && t !== 'p2o_candidate') : [...WORKER_TOOLS]; }
/**
 * P13(g): the reporting guard repeated its own list of denied broker operations, so a new target-facing tool could be added to
 * `WORKER_TOOLS` without the RPC guard learning about it (the tool list alone only hides the tool; the op stays callable).
 * The map below is the single statement of "this op is target-facing or consumes a work slot", and the guard derives from it.
 */
export const TARGET_FACING_OPERATIONS: Readonly<Record<string, { tool: string; whole: boolean }>> = {
  exec: { tool: 'p2o_shell', whole: true }, net: { tool: 'p2o_net', whole: true }, http: { tool: 'p2o_http', whole: true },
  capture: { tool: 'p2o_capture', whole: true }, candidate: { tool: 'p2o_candidate', whole: true }, delegate: { tool: 'p2o_delegate', whole: true },
  // A payload is what ran, so both directions belong to an executing role (P14.2).
  payload_write: { tool: 'p2o_lab', whole: true }, payload_read: { tool: 'p2o_lab', whole: true },
  // Reporting keeps `p2o_graph` for reads; only its write operation is denied.
  graph_record: { tool: 'p2o_graph', whole: false },
};
/** Reporting is synthesis-only: no target contact, no new claim, no new work. Derived, never restated. */
export function reportingOperationDenied(role: string, op: string): boolean { return role === 'reporting' && Object.hasOwn(TARGET_FACING_OPERATIONS, op); }
