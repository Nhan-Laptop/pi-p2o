/**
 * 2026-10-25 (planning_update.md Part XI): there is no separate guidance layer. These boundary sentences are appended to
 * the tool's own description at registration, so the model sees them exactly where it sees the tool and the operator has
 * no flag to set. They never grant, widen or replace a gate the host enforces.
 */
export const TOOL_BOUNDARIES: Readonly<Record<string, readonly string[]>> = {
  p2o_task_create: ['Run p2o_board board=tasks match=<draft> before create so an exact active duplicate or reviewable history is reported instead of repeated.'],
  p2o_task_revise: ['Revise at the current revision; identity and history are not rewritten, and a stale refusal names the held revision and legal next verb.'],
  p2o_task_start: ['Start only a proposed task the owner will execute directly; it is not a worker spawn, scope change or proof.'],
  p2o_task_dispatch: ['Dispatch proposed task IDs only; the frontier waits for reviewed prerequisites and free worker slots.'],
  p2o_task_review: ['Review with same-run receipts; review is coordination, not proof, case acceptance or goal completion.'],
  p2o_task_settle: ['Settle only a reviewed task; blocked records the human prerequisite instead of pretending the question was answered.'],
  p2o_delegate: ['Pass work with decision and outputContract (the shape p2o_task_create uses) so exact duplicate and history checks run; without work the identity is unknown and nothing is checked.'],
  p2o_case_create: ['Create stays pending; acceptance, dispute or withdrawal needs an explicit revise at the current revision.'],
  p2o_case_revise: ['Record a reviewed outcome pinned to exact claim, task and asset revisions; a worker claim is not a finding until its case is accepted and current.'],
  p2o_case_rate: ['Rate without changing verdict or review; the rating stays pinned to the case revision it evaluated.'],
  p2o_coverage_plan: ['Keep the denominator explicit so blocked, untested and unplanned cells stay visible as gaps, never as clean.'],
  p2o_coverage_cell: ['One cell per explicit identity; tested needs reviewed receipts, accepted needs a current accepted case, blocked stays a gap.'],
  p2o_coverage_cell_retire: ['Retirement preserves history and removes the cell from the denominator; it never marks the surface clean.'],
  p2o_coverage_suggest: ['Read-only planning aid from the shipped WSTG map; suggestions are not cells, coverage, permission or findings.'],
  p2o_graph: ['Record resources and facts with provenance and evidence IDs, and query them before rediscovering an asset.'],
  p2o_state: ['List current heads to find open work, gaps and reviews before repeating work; drill down with p2o_ledger by ID.', 'When --refer-workspace was used, prior-run context shows up as domain=reference heads here: context only, never same-run evidence for a case or coverage cell.'],
  p2o_capture: ['Keep long scratch output as a retained artifact and cite its ID instead of pasting it into notes.'],
  p2o_lab: ['Store the payload before you run it and verify the environment recipe before you trust it, then name both in the claim so a second worker replays the same bytes in the same recipe.', 'Use materialize=true to put a stored payload in your own scratch instead of reading its body; an environment id from another sandbox must be registered locally before verify.'],
  p2o_plan_create: ['Create goals with a proof contract; decisions record a choice and never dispatch work.'],
  p2o_plan_revise: ['Revise at the current revision; goal review/close is a status transition, not automatic proof or completion.'],
  p2o_board: ['Read the live board before writing: list without an id, then view the exact id; summaries are not authority or proof.'],
  p2o_finish: ['export writes the report and ends nothing; the final finish stops workers. Review pending/stale cases and list unresolved gaps.'],
  // 2026-10-25 audit: every tool carries one boundary line, so a role never has to infer the split from two descriptions alone.
  p2o_shell: ['Generic sandbox shell; use p2o_net for anything that contacts the target or downloads tooling, and p2o_http for origin-scoped requests.'],
  p2o_net: ['Network-facing commands and installs stay in your own scratch; a blocked hop is a gap, never a clean surface.'],
  p2o_http: ['Use for the target origin only: any method, headers and body, bounded redirects; every hop is checked, so another origin is out of scope.'],
  p2o_candidate: ['One closure per claim; receipts are observations. A claim citing a lead stays open_proof_gap with policyBasis inferred and cannot be confirmed.'],
  p2o_note: ['Use the narrow kind: note for rationale, coverage for a surface×risk×outcome row, open for an unresolved item. Surfaces belong in p2o_surface.'],
  p2o_surface: ['One component+entryPoint per row; duplicate=true is a cheap hint, not a block. Keep detail and evidence in p2o_note.'],
  p2o_artifact: ['Reads a retained artifact by ID, written by the capture step. Cite the ID instead of pasting the text again.'],
  p2o_ledger: ['Read complete records by ID (report parts included). p2o_state narrows heads/search; p2o_graph holds typed assets and facts.'],
  p2o_research: ['Citation and fetch: action=fetch retrieves any URL, technique search reads the corpus, and a CVE lead never confirms a claim; playbooks come from p2o_skill_read.'],
  p2o_skill_list: ['Find an approved playbook before assigning or starting work; the catalog text is tool-agnostic by design.'],
  p2o_skill_read: ['Read one catalog document by ID and follow nextOffset; materialize copies a registered script into your own scratch.'],
  p2o_request_subtask: ['Propose, never spawn: a bounded missing question with its reason; the lead decides whether it becomes work.'],
  p2o_report: ['Report what you ran, what it supports and what it does NOT; a blocked result is valid, an invented finding is not.'],
  p2o_loop: ['wait ends this planning round; blocked records the human prerequisite instead of polling. Worker state is listed per worker, not here.'],
  p2o_workers: ['One row per worker: commands, last write and report state; continue resumes the same ticket, stop revokes it.'],
};

export function withBoundaries<T extends { name: string; description: string }>(tool: T): T {
  // L1/W2: a verb inherits its family boundary, so splitting a bag never leaves the new tool without its guardrail.
  const family = Object.keys(TOOL_BOUNDARIES).find(name => tool.name.startsWith(`${name}_`));
  const lines = TOOL_BOUNDARIES[tool.name] ?? (family ? TOOL_BOUNDARIES[family] : undefined);
  return lines?.length ? { ...tool, description: `${tool.description} ${lines.join(' ')}` } : tool;
}
