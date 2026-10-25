/**
 * Workflow guidance attached to the tool it is about, so it appears in the model's instructions exactly when that tool is active and a
 * role never reads advice about a tool it cannot call. The lead's own policy section stays free of tool names and inside its size budget;
 * these lines are operational advice only and never grant, widen or replace a gate the host enforces.
 * Bump POLICY_VERSION when any line changes: it is part of the runtime closure digest and is shown to the operator.
 */
export const POLICY_VERSION = 4;

export const TOOL_GUIDELINES: Readonly<Record<string, readonly string[]>> = {
  p2o_task: ['Run p2o_task action=match with a structured work identity before creating or dispatching new work, so an exact active duplicate or reviewable history is reported instead of repeated.'],
  p2o_delegate: ['Pass work with decision and outputContract (the shape p2o_task create uses) so exact duplicate and history checks run; without work the identity is unknown and nothing is checked.'],
  p2o_case: ['Record a reviewed outcome as a case pinned to exact claim, task and asset revisions; a worker claim is not a finding until its case is accepted and current.'],
  p2o_coverage: ['Keep the denominator explicit so blocked, untested and unplanned cells stay visible as gaps, never as clean.'],
  p2o_graph: ['Record resources and facts with provenance and evidence IDs, and query them before rediscovering an asset.'],
  p2o_state: ['List current heads to find open work, gaps and reviews before repeating work; drill down with p2o_ledger by ID.', 'When --refer-workspace was used, prior-run context shows up as domain=reference heads here: context only, never same-run evidence for a case or coverage cell.'],
  p2o_capture: ['Keep long scratch output as a retained artifact and cite its ID instead of pasting it into notes.'],
  p2o_lab: ['Store the payload before you run it and verify the environment recipe before you trust it, then name both in the claim so a second worker replays the same bytes in the same recipe.'],
  p2o_plan: ['Keep goals, todos and decisions that span rounds here rather than in chat.'],
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
  p2o_research: ['Technique and CVE context only: a cited source is not evidence, and a CVE lead never confirms a claim; playbooks come from p2o_skill_read.'],
  p2o_skill_list: ['Find an approved playbook before assigning or starting work; the catalog text is tool-agnostic by design.'],
  p2o_skill_read: ['Read one catalog document by ID and follow nextOffset; materialize copies a registered script into your own scratch.'],
  p2o_request_subtask: ['Propose, never spawn: a bounded missing question with its reason; the lead decides whether it becomes work.'],
  p2o_report: ['Report what you ran, what it supports and what it does NOT; a blocked result is valid, an invented finding is not.'],
  p2o_loop: ['wait ends this planning round; blocked records the human prerequisite instead of polling. Worker state is listed per worker, not here.'],
  p2o_workers: ['One row per worker: commands, last write and report state; continue resumes the same ticket, stop revokes it.'],
};

export function withGuidelines<T extends { name: string; promptGuidelines?: string[] }>(tool: T): T {
  const lines = TOOL_GUIDELINES[tool.name];
  return lines && !tool.promptGuidelines ? { ...tool, promptGuidelines: [...lines] } : tool;
}
