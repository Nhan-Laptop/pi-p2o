/**
 * planning_update.md A1/A4: there is no separate guidance layer. These boundary sentences are appended to the tool's own
 * description at registration, so the model sees them exactly where it sees the tool. They never grant, widen or replace
 * the role loadout the host enforces, and a tool removed from the model surface has no boundary line here.
 */
export const TOOL_BOUNDARIES: Readonly<Record<string, readonly string[]>> = {
  p2o_task_author: ['The planner has no target or claim tools: dispatch the intent and let a worker execute it, and reviewing the handoff is not proof. A match returned instead of a create is coordination evidence, never authority or proof. A revise never rewrites identity or history, and a stale refusal names the held revision and the legal next verb.'],
  p2o_task_dispatch: ['Name workerId to continue one held worker on this task: same ticket, pane and session. p2o_workers action=continue sends a brief on the same ticket without a task record, so name the task here when the successor must be a task.'],
  p2o_task_review: ['Accept only what the receipt shows and name the rest as a gap; an unsupported review is blocked, not reviewed.'],
  p2o_task_settle: ['Settle only a reviewed task; blocked records the human prerequisite instead of pretending the question was answered.'],
  p2o_case_author: ['A worker claim is not a finding until its case is accepted and current, and acceptance never completes a goal or assessment: record one decision at the current revision and keep contradictions and limitations exact.'],
  p2o_case_rate: ['Rate without changing verdict or review; the rating stays pinned to the case revision it evaluated.'],
  p2o_coverage_plan: ['A task without a work asset is an unmapped gap, never a clean cell; blocked, untested, stale and unmapped work is never clean, and coverage stops at the declared denominator.'],
  p2o_coverage_suggest: ['Read-only planning aid from the shipped WSTG map; suggestions are not cells, coverage, permission or findings.'],
  p2o_graph: ['Record resources and facts with provenance and evidence IDs, and query them before rediscovering an asset. Typed assets/facts live here; task, case, coverage-plan and plan entities are read through p2o_board, and raw record bytes through p2o_ledger.'],
  p2o_state: ['List current heads to find open work, gaps and reviews before repeating work; drill down with p2o_ledger by ID. For task, case, coverage-plan and plan entities the list/view reader is p2o_board; heads is the indexed knowledge view.', 'When --refer-workspace was used, prior-run context shows up as domain=reference heads here: context only, never same-run evidence for a case or coverage cell.'],
  p2o_capture: ['Keep long scratch output as a retained artifact and cite its ID instead of pasting it into notes.'],
  p2o_lab: ['Store the payload before you run it and verify the recipe before you trust it: an unverified environment is not a replay, and the claim must name both.'],
  p2o_plan_author: ['A goal is settled only when its proof holds, never by the status field alone; this is coordination, not automatic proof or assessment completion. Two host paths also write plan rows — a loop wait with notBefore records a deferral decision and chain planning records one todo per step — so p2o_board board=plans lists rows this tool did not author.'],
  p2o_board: ['Read the live board before you write: list without an id, then view the exact id you are about to revise; a plan cell is host-derived, so no read creates one.'],
  p2o_finish: ['export writes the report and ends nothing; the final finish stops workers. Review pending/stale cases and list unresolved gaps.'],
  // 2026-10-25 audit: every tool carries one boundary line, so a role never has to infer the split from two descriptions alone.
  p2o_shell: ['Generic sandbox shell; use p2o_net for anything that contacts the target or downloads tooling, and p2o_http for HTTP requests. The image already carries Chromium and the agent-browser CLI, so a browser-driven page is another command in this same sandbox and its receipt is execution evidence, not an assumption.'],
  p2o_net: ['Network-facing commands and installs stay in your own scratch; opaque commands are not origin-filtered, and a blocked hop is a gap, never a clean surface.'],
  p2o_session: ['Session state is not evidence: nothing a session holds counts unless a receipt or artifact records it.'],
  p2o_secret: ['A sealed id is the only handle you get: a missing credential is work to provision, never a prompt for the operator, and a value you write literally is model-authored with no redaction guarantee.'],
  p2o_http: ['The starting label is not an allowlist: only the command policy can refuse a request, never the target label.'],
  p2o_candidate: ['Worker-only: one closure per claim, host-stamped to the executing task; receipts are observations. A claim citing a lead stays open_proof_gap with policyBasis inferred and cannot be confirmed.'],
  p2o_note: ['Worker-only: use the narrow kind: note for rationale, coverage for a surface×risk×outcome display row, open for an unresolved item. Surfaces belong in p2o_surface, and the host derives coverage cells from reviewed claims, never from a coverage note.'],
  p2o_surface: ['Worker-only: one component+entryPoint per row; duplicate=true is a cheap hint, not a block. Keep detail and evidence in p2o_note.'],
  p2o_artifact: ['Reads a retained artifact by ID, written by the capture step. Cite the ID instead of pasting the text again.'],
  p2o_ledger: ['Read complete records by ID (report parts included). p2o_state narrows heads/search; p2o_graph holds typed assets and facts; p2o_board lists and views the four entity boards.'],
  p2o_research: ['Citation and fetch: action=fetch retrieves any URL, technique search reads the corpus, and a CVE lead never confirms a claim; playbooks come from p2o_skill_read.'],
  p2o_skill_list: ['Find an approved playbook before assigning or starting work; the catalog text is tool-agnostic by design.'],
  p2o_skill_read: ['Read one catalog document by ID and follow nextOffset; materialize copies a registered script into your own scratch.'],
  p2o_request_subtask: ['Propose, never spawn: a bounded missing question with its reason; the lead decides whether it becomes work.'],
  p2o_report: ['Worker: one intent, write back, report, stop. Reporter: read-only second reader, no target operations and no candidate authorship. Report only what the receipts show; a blocked result is valid, an invented finding is not.'],
  p2o_loop: ['wait ends this planning round; blocked records the human prerequisite instead of polling. Worker state is listed per worker, not here.'],
  p2o_workers: ['One row per worker: commands, last write and report state; continue resumes the same ticket without a task record (p2o_task_dispatch with workerId is the task-backed continuation), stop revokes it.'],
};

export function withBoundaries<T extends { name: string; description: string }>(tool: T): T {
  // L1/W2: a verb inherits its family boundary, so splitting a bag never leaves the new tool without its guardrail.
  const family = Object.keys(TOOL_BOUNDARIES).find(name => tool.name.startsWith(`${name}_`));
  const lines = TOOL_BOUNDARIES[tool.name] ?? (family ? TOOL_BOUNDARIES[family] : undefined);
  return lines?.length ? { ...tool, description: `${tool.description} ${lines.join(' ')}` } : tool;
}
