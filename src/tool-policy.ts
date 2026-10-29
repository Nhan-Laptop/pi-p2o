/**
 * Authority is a property of the role's tool loadout and is enforced independently of prompt/model selection.
 *
 * planning_update.md D1/D2/D3 (planner-first, no solo mode, worker-only claims): the planner plans, reviews and proves;
 * a worker is the only executor and the only author of a candidate claim; the reporter is a read-only second reader.
 * A role is enforced by *not activating* a tool (`pi.setActiveTools`), so a model that asks for a tool it does not hold
 * gets Pi's unknown-tool result, not a runtime permission error.
 */

/**
 * Target execution. A worker owns these; the planner never receives them.
 * A7.2: `p2o_session` is a target tool too — it creates and drives a run-owned container, so it is never planner-visible.
 */
export const TARGET_TOOLS = ['p2o_shell', 'p2o_net', 'p2o_http', 'p2o_capture', 'p2o_session'];
/** P14.2: the payload artifact is execution evidence. An executing role creates it; the planner reads it at most. */
export const LAB_TOOLS = ['p2o_lab'];

/**
 * Planner loadout: intent, plan, case, coverage-plan, review, read, skill/research, worker control and finish.
 * Deliberately absent: every target/lab tool, p2o_candidate, p2o_note, p2o_surface, p2o_report and p2o_request_subtask.
 * Coverage cells are host-derived (A3), so no role holds a cell writer.
 * `p2o_graph` stays in the planner loadout for read/query/chain coordination; worker-only write enforcement is in the
 * owner broker (`extensions/p2o/index.ts`), so this loadout does not enforce it by itself.
 */
export const PLANNER_TOOLS = [
  'p2o_task_author', 'p2o_task_dispatch', 'p2o_task_review',
  'p2o_goal_author',
  'p2o_case_author', 'p2o_case_rate', 'p2o_case_retest',
  'p2o_coverage_plan', 'p2o_wstg_suggest',
  'p2o_board', 'p2o_ledger', 'p2o_state', 'p2o_artifact', 'p2o_graph',
  'p2o_skill_list', 'p2o_skill_read', 'p2o_secret', 'p2o_research',
  'p2o_workers', 'p2o_loop', 'p2o_finish',
];

/**
 * P18.3/D47: the closing loadout a wrapping round switches to. Reading the board/ledger, authoring write-back and the loop stay
 * available; creating or dispatching a new intent is what a wrapping round must not start, because the next round owns the next
 * work package. Authority is unchanged: this is the planner loadout with two verbs removed, never a wider one.
 */
export const CLOSING_TOOLS = PLANNER_TOOLS.filter(name => name !== 'p2o_task_dispatch' && name !== 'p2o_task_author');

/** Executing worker loadout: one intent, target tools, write-back and report. Workers never create or dispatch work. */
export const WORKER_TOOLS = [
  'p2o_skill_list', 'p2o_skill_read', 'p2o_secret', 'p2o_research', 'p2o_candidate', ...LAB_TOOLS, ...TARGET_TOOLS,
  'p2o_note', 'p2o_surface', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_request_subtask', 'p2o_report',
];

/**
 * A1: a validation worker reproduces another worker's claim. It keeps note/graph/report for its own observations but not
 * `p2o_surface`: validation must not record a new surface or widen the question it was given.
 */
export const VALIDATION_TOOLS = WORKER_TOOLS.filter(name => name !== 'p2o_surface');
/** A7.2: the validation worker keeps the tool but the handler allows `action=open` only, so it never inherits a shell. */

/** Read-only second reader for an accepted case: evidence, traces, artifacts, report. No target, lab, claim or plan tool. */
export const REPORTER_TOOLS = ['p2o_report', 'p2o_ledger', 'p2o_artifact', 'p2o_skill_list', 'p2o_skill_read', 'p2o_state'];

/** Every tool the model may ever see, once, across all roles. S1/B10 deleted the two hidden legacy verbs, so this set is
 * also every registered tool: registration and model visibility are the same surface now. */
export const MODEL_TOOLS = [...new Set([...PLANNER_TOOLS, ...WORKER_TOOLS, ...VALIDATION_TOOLS, ...REPORTER_TOOLS])];

export function plannerTools(): string[] { return [...PLANNER_TOOLS]; }
/** P18.3/D47: the loadout a round uses once it is wrapping up. */
export function closingTools(): string[] { return [...CLOSING_TOOLS]; }
export function reporterTools(): string[] { return [...REPORTER_TOOLS]; }
/** Role loadout: the reporting role is read-only; validation loses the surface writer; every other worker gets the full set. */
export function workerTools(role?: string): string[] {
  if (role === 'reporting') return reporterTools();
  if (role === 'validation') return [...VALIDATION_TOOLS];
  return [...WORKER_TOOLS];
}
