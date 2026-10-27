/**
 * planning_update.md A1/A4: there is no separate guidance layer. These boundary sentences are appended to the tool's own
 * description at registration, so the model sees them exactly where it sees the tool. They never grant, widen or replace
 * the role loadout the host enforces, and a tool removed from the model surface has no boundary line here.
 */
export const TOOL_BOUNDARIES: Readonly<Record<string, readonly string[]>> = {
  p2o_task_create: ['The planner has no target or claim tools; create and dispatch an intent and a worker executes it, then the planner reviews the handoff. The host derives the purpose from the role, the output contract from the purpose and the decision from the anchors you supply. The first intent of a run is recon/mapping; a discovery intent needs work.claimRefs or a reviewed prerequisite, and a validation intent names a reviewed task or a worker claim in validationOf (the host pins the reviewed revision). Create performs the exact-work duplicate/history check itself: an exact active or reusable attempt returns the match payload instead of creating, and a match is coordination evidence, never authority or proof.'],
  p2o_task_revise: ['Revise at the current revision; identity and history are not rewritten, and a stale refusal names the held revision and legal next verb.'],
  p2o_task_dispatch: ['Dispatch proposed task IDs only; the Engine starts the worker, and the frontier waits for reviewed prerequisites and free worker slots. Naming workerId reuses one held worker\'s ticket, pane and session for this task; p2o_workers action=continue sends a brief on the same ticket without a task record, so name the task here when the successor must be a task.'],
  p2o_task_review: ['Review with same-run receipts; review is coordination, not proof, case acceptance or goal completion.'],
  p2o_task_settle: ['Settle only a reviewed task; blocked records the human prerequisite instead of pretending the question was answered.'],
  p2o_case_create: ['Create stays pending; acceptance, dispute or withdrawal needs an explicit revise at the current revision.'],
  p2o_case_revise: ['Record a reviewed outcome pinned to exact claim, task and asset revisions; a worker claim is not a finding until its case is accepted and current.'],
  p2o_case_rate: ['Rate without changing verdict or review; the rating stays pinned to the case revision it evaluated.'],
  p2o_coverage_plan: ['You write scope, exclusions and unknown scope only: the host derives the denominator cells from reviewed tasks, their worker claims and current accepted cases, and a task without a work asset is an unmapped gap, never a clean cell. Blocked, untested, stale and unmapped work is never clean.'],
  p2o_coverage_suggest: ['Read-only planning aid from the shipped WSTG map; suggestions are not cells, coverage, permission or findings.'],
  p2o_graph: ['Record resources and facts with provenance and evidence IDs, and query them before rediscovering an asset. Typed assets/facts live here; task, case, coverage-plan and plan entities are read through p2o_board, and raw record bytes through p2o_ledger.'],
  p2o_state: ['List current heads to find open work, gaps and reviews before repeating work; drill down with p2o_ledger by ID. For task, case, coverage-plan and plan entities the list/view reader is p2o_board; heads is the indexed knowledge view.', 'When --refer-workspace was used, prior-run context shows up as domain=reference heads here: context only, never same-run evidence for a case or coverage cell.'],
  p2o_capture: ['Keep long scratch output as a retained artifact and cite its ID instead of pasting it into notes.'],
  p2o_lab: ['Store the payload before you run it and verify the environment recipe before you trust it, then name both in the claim so a second worker replays the same bytes in the same recipe.', 'Use materialize=true to put a stored payload in your own scratch instead of reading its body; an environment id from another sandbox must be registered locally before verify.'],
  p2o_plan_create: ['Create goals with a proof contract; decisions record a choice and never dispatch work. Two host paths also write plan rows: a loop wait with notBefore records a deferral decision and chain planning records one todo per step, so board=plans lists rows this tool did not author.'],
  p2o_plan_revise: ['Revise at the current revision; goal review/close is a status transition, not automatic proof or completion.'],
  p2o_board: ['Read the live board before writing: list without an id, then view the exact id; board=coverage returns host-derived cells and unmapped gaps, never a planner-authored cell. This is the list/view reader for the four entity boards; p2o_state lists indexed heads/search and p2o_ledger reads record bytes by ID. Summaries are not authority or proof.'],
  p2o_finish: ['export writes the report and ends nothing; the final finish stops workers. Review pending/stale cases and list unresolved gaps.'],
  // 2026-10-25 audit: every tool carries one boundary line, so a role never has to infer the split from two descriptions alone.
  p2o_shell: ['Generic sandbox shell; use p2o_net for anything that contacts the target or downloads tooling, and p2o_http for HTTP requests. The image already carries Chromium and the agent-browser CLI, so a browser-driven page is another command in this same sandbox and its receipt is execution evidence, not an assumption.'],
  p2o_net: ['Network-facing commands and installs stay in your own scratch; opaque commands are not origin-filtered, and a blocked hop is a gap, never a clean surface.'],
  p2o_session: ['A session keeps state between steps, never authority: every command still passes the operation gate and the command policy, a ticket binds exactly one session, and stop/finish verifies container removal.'],
  p2o_secret: ['List only: ids, kinds, labels and scopes the operator sealed. A value is never shown, never echoed by this tool, and only reaches a target through a ${P2O_SECRET:<id>} placeholder the host substitutes after the command policy allows it.'],
  p2o_http: ['HTTP client for any http(s) URL and any redirect hop; the authorized target is a starting label, not an egress boundary.'],
  p2o_candidate: ['Worker-only: one closure per claim, host-stamped to the executing task; receipts are observations. A claim citing a lead stays open_proof_gap with policyBasis inferred and cannot be confirmed.'],
  p2o_note: ['Worker-only: use the narrow kind: note for rationale, coverage for a surface×risk×outcome display row, open for an unresolved item. Surfaces belong in p2o_surface, and the host derives coverage cells from reviewed claims, never from a coverage note.'],
  p2o_surface: ['Worker-only: one component+entryPoint per row; duplicate=true is a cheap hint, not a block. Keep detail and evidence in p2o_note.'],
  p2o_artifact: ['Reads a retained artifact by ID, written by the capture step. Cite the ID instead of pasting the text again.'],
  p2o_ledger: ['Read complete records by ID (report parts included). p2o_state narrows heads/search; p2o_graph holds typed assets and facts; p2o_board lists and views the four entity boards.'],
  p2o_research: ['Citation and fetch: action=fetch retrieves any URL, technique search reads the corpus, and a CVE lead never confirms a claim; playbooks come from p2o_skill_read.'],
  p2o_skill_list: ['Find an approved playbook before assigning or starting work; the catalog text is tool-agnostic by design.'],
  p2o_skill_read: ['Read one catalog document by ID and follow nextOffset; materialize copies a registered script into your own scratch.'],
  p2o_request_subtask: ['Propose, never spawn: a bounded missing question with its reason; the lead decides whether it becomes work.'],
  p2o_report: ['Worker: one intent, write back, report, stop. Reporter: read-only second reader, no target operations and no candidate authorship. Report what you ran, what it supports and what it does NOT; a blocked result is valid, an invented finding is not.'],
  p2o_loop: ['wait ends this planning round; blocked records the human prerequisite instead of polling. Worker state is listed per worker, not here.'],
  p2o_workers: ['One row per worker: commands, last write and report state; continue resumes the same ticket without a task record (p2o_task_dispatch with workerId is the task-backed continuation), stop revokes it.'],
};

export function withBoundaries<T extends { name: string; description: string }>(tool: T): T {
  // L1/W2: a verb inherits its family boundary, so splitting a bag never leaves the new tool without its guardrail.
  const family = Object.keys(TOOL_BOUNDARIES).find(name => tool.name.startsWith(`${name}_`));
  const lines = TOOL_BOUNDARIES[tool.name] ?? (family ? TOOL_BOUNDARIES[family] : undefined);
  return lines?.length ? { ...tool, description: `${tool.description} ${lines.join(' ')}` } : tool;
}
