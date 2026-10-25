/** Responsibility is enforced independently of prompt/model selection. */
export const TARGET_TOOLS = ['p2o_shell', 'p2o_net', 'p2o_http', 'p2o_capture'];
/** P14.2: the payload artifact is execution evidence. An executing role creates it; a reviewing owner may read or verify it; a reporting worker gets neither (the op guard below denies both directions). */
export const LAB_TOOLS = ['p2o_lab'];
export const OWNER_TOOLS = ['p2o_task', 'p2o_plan', 'p2o_case', 'p2o_coverage', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_skill_list', 'p2o_skill_read', 'p2o_research', 'p2o_candidate', ...LAB_TOOLS, ...TARGET_TOOLS, 'p2o_note', 'p2o_surface', 'p2o_delegate', 'p2o_workers', 'p2o_loop', 'p2o_finish'];
export const WORKER_TOOLS = ['p2o_skill_list', 'p2o_skill_read', 'p2o_research', 'p2o_candidate', ...LAB_TOOLS, ...TARGET_TOOLS, 'p2o_note', 'p2o_surface', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_request_subtask', 'p2o_report'];
export const ALL_TOOLS = [...new Set([...OWNER_TOOLS, ...WORKER_TOOLS])];
// 2026-10-25 (planning_update.md Part XI): one owner role. The lead holds every owner tool, target execution included,
// whether or not a worker backend exists; there is no solo loadout and no reporting filter.
export const DELEGATION_TOOLS = ['p2o_delegate', 'p2o_workers'];
export function ownerTools(): string[] { return [...OWNER_TOOLS]; }
export function workerTools(_role?: string): string[] { return [...WORKER_TOOLS]; }
