/** Responsibility is enforced independently of prompt/model selection. */
export const TARGET_TOOLS = ['p2o_shell', 'p2o_net', 'p2o_http', 'p2o_capture'];
export const OWNER_TOOLS = ['p2o_task', 'p2o_plan', 'p2o_case', 'p2o_coverage', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_skill_list', 'p2o_skill_read', 'p2o_candidate', ...TARGET_TOOLS, 'p2o_note', 'p2o_surface', 'p2o_delegate', 'p2o_workers', 'p2o_loop', 'p2o_finish'];
export const WORKER_TOOLS = ['p2o_skill_list', 'p2o_skill_read', 'p2o_candidate', ...TARGET_TOOLS, 'p2o_note', 'p2o_surface', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_request_subtask', 'p2o_report'];
export const ALL_TOOLS = [...new Set([...OWNER_TOOLS, ...WORKER_TOOLS])];
/** Tools that only make sense when workers exist; a solo owner (--solo, no Herdr, --max-depth 0) is not offered them. `p2o_loop` stays because it reports engine and frontier status. */
export const DELEGATION_TOOLS = ['p2o_delegate', 'p2o_workers'];
export function ownerTools(delegated: boolean): string[] { return delegated ? OWNER_TOOLS.filter(t => !TARGET_TOOLS.includes(t)) : OWNER_TOOLS.filter(t => !DELEGATION_TOOLS.includes(t)); }
export function workerTools(role: string): string[] { return role === 'reporting' ? WORKER_TOOLS.filter(t => !TARGET_TOOLS.includes(t) && t !== 'p2o_candidate') : [...WORKER_TOOLS]; }
export function reportingOperationDenied(role: string, op: string): boolean { return role === 'reporting' && ['exec', 'net', 'http', 'capture', 'candidate', 'delegate', 'graph_record'].includes(op); }
