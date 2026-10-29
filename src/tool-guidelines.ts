/**
 * planning_update.md A1/A4: there is no separate guidance layer. These boundary sentences are appended to the tool's own
 * description at registration, so the model sees them exactly where it sees the tool. They never grant, widen or replace
 * the role loadout the host enforces, and a tool removed from the model surface has no boundary line here.
 */
export const TOOL_BOUNDARIES: Readonly<Record<string, readonly string[]>> = {
  p2o_task_author: ['The planner has no target or claim tools: dispatch the intent and let a worker execute it; reviewing the handoff is not proof. A match instead of a create is coordination evidence, never proof. A revise never rewrites identity or history; a stale refusal names the held revision and the legal next verb.'],
  p2o_task_dispatch: ['Name workerId to continue one held worker on this task: same ticket, pane and session. p2o_workers action=continue sends a brief without a task record, so name the task here when the successor must be a task. A successor brief carries IDs and excerpts verbatim, never a summary.'],
  p2o_task_review: ['Accept only what the receipt shows; an unsupported review is blocked. outcome=closed/blocked/cancelled settles the reviewed task (blocked records the prerequisite).'],
  p2o_case_author: ['A worker claim is not a finding until its case is accepted and current; acceptance never completes a goal. Record one decision at the current revision; keep contradictions and limitations exact.'],
  p2o_case_rate: ['Rate without changing verdict or review; the rating stays pinned to the case revision it evaluated. A tested, observed effect on inferred policy provenance rates at demonstrated depth with the INFERRED_POLICY flag and a limitation naming the inference; above that depth is refused.'],
  p2o_case_retest: ['A retest reports one observation at the case revision it evaluated; it never re-accepts, re-rates or proves the remediation. cannot_confirm is honest when the environment moved.'],
  p2o_coverage_plan: ['A task without a work asset is an unmapped gap, never a clean cell; blocked, untested, stale or unmapped work is never clean. Coverage stops at the declared denominator.'],
  p2o_wstg_suggest: ['Planning aid from the shipped WSTG map; suggestions are not cells, coverage, permission or findings.'],
  p2o_graph: ['Bounded reads only: query before rediscovering, and treat rows, dossiers and paths as background, never a finding or proof.'],
  p2o_graph_record: ['Worker write: batch one observation with provenance and evidence IDs, and leave observed relations and settled hypotheses to owner review.'],
  p2o_graph_review: ['Owner review: settle or promote a row a read named; it judges knowledge and never re-accepts a case, proves a remediation or creates a finding.'],
  p2o_graph_plan: ['Planner coordination: chain and plan file a task draft and todos without dispatching, and ingest writes extractor rows; neither starts target work.'],
  p2o_state: ['List heads to find open work, gaps and reviews before repeating work, and read once rather than re-listing; drill down with p2o_ledger by ID. Entity boards are a planner read; heads is the shared knowledge view.', 'With --refer-workspace, prior-run context appears as domain=reference heads: context only, never same-run evidence.'],
  p2o_capture: ['Keep long scratch output as a retained artifact and cite its ID instead of pasting it into notes.'],
  p2o_lab: ['The order is store the payload, verify the recipe, then claim: an unverified environment is not a replay, and the claim must name both.'],
  p2o_goal_author: ['A goal is settled only when its proof holds, never by the status field alone. A proof is measurable: a capability the run can gain, an accepted case, or a bounded coverage denominator; a blocked settlement states in exclusions and reason what made the proof unreachable. Loop waits and chain planning also write plan rows, so the board lists rows this tool did not author.'],
  p2o_board: ['Read the live board before you write: one list per round, then view the exact ids you are about to revise; a plan cell is host-derived, so no read creates one.'],
  p2o_finish: ['export writes and ends nothing; the final finish stops workers; review pending/stale cases and list gaps.'],
  // 2026-10-25 audit: every tool carries one boundary line, so a role never has to infer the split from two descriptions alone.
  p2o_shell: ['Generic sandbox shell; use p2o_net for anything that contacts the target or downloads tooling, and p2o_http for HTTP requests. The image already carries Chromium and the agent-browser CLI, so a browser-driven page is another command in this same sandbox and its receipt is execution evidence, not an assumption.'],
  p2o_net: ['Network-facing commands and installs stay in your own scratch; a blocked hop is a gap, never a clean surface.'],
  p2o_session: ['Session state is not evidence: nothing a session holds counts unless a receipt or artifact records it. The foothold is one connection per session, lab-network only, with no host port and no tunnel or pivot; its identity probe is recorded, and its transcript reaches you as a bounded preview plus a capture artifact.'],
  p2o_secret: ['A sealed id is the only handle you get: a missing credential is work to provision, never a prompt for the operator, and a value you write literally is model-authored with no redaction guarantee.'],
  p2o_http: ['The starting label is not an allowlist: only the command policy can refuse a request, never the target label.'],
  p2o_candidate: ['Worker-only: one closure per claim, host-stamped to the executing task; receipts are observations and policy provenance follows your evidence rules. A claim citing a lead cannot be confirmed, and a negative is an observation to recheck once, never proof.'],
  p2o_note: ['Worker-only: use the narrow kind: note for rationale, coverage for a surface×risk×outcome display row, open for an unresolved item. A surface belongs in the surface-inventory row, never a note; the host derives coverage cells from reviewed claims, never from a coverage note.'],
  p2o_surface: ['Worker-only: one component+entryPoint per row; duplicate=true is a cheap hint, not a block. Keep detail and evidence in p2o_note.'],
  p2o_artifact: ['Reads a retained artifact by ID, written by the capture step. Cite the ID instead of pasting the text again.'],
  p2o_ledger: ['Read complete records by ID (report parts included); a reply names its records plus nextCursor. p2o_state covers heads/search; graph rows hold assets and facts; planner boards list authored entities.'],
  p2o_research: ['Citation and fetch: action=fetch retrieves any URL, technique search reads the corpus, and a CVE lead never confirms a claim; playbooks come from p2o_skill_read.'],
  p2o_skill_list: ['Find an approved playbook before assigning or starting work; the catalog text is tool-agnostic by design.'],
  p2o_skill_read: ['Read one catalog document by ID and follow nextOffset; materialize copies a registered script into your own scratch.'],
  p2o_request_subtask: ['Propose, never spawn: a bounded missing question with its reason; the lead decides whether it becomes work. Over-report adjacent leads (another actor, object or route) with the primitive that would consume them.'],
  p2o_report: ['Worker: one intent, write back, report, stop. Reporter: read-only second reader, no target operations and no candidate authorship. Report only what the receipts show; a blocked result is valid, an invented finding is not.'],
  p2o_loop: ['wait ends this planning round; blocked records the human prerequisite instead of polling. Worker state is listed per worker, not here.'],
  p2o_workers: ['One row per worker: commands, last write, report state; continue resumes that ticket without a task record (p2o_task_dispatch workerId is the task route), stop revokes it.'],
};

export function withBoundaries<T extends { name: string; description: string }>(tool: T): T {
  // L1/W2: a verb inherits its family boundary, so splitting a bag never leaves the new tool without its guardrail.
  const family = Object.keys(TOOL_BOUNDARIES).find(name => tool.name.startsWith(`${name}_`));
  const lines = TOOL_BOUNDARIES[tool.name] ?? (family ? TOOL_BOUNDARIES[family] : undefined);
  return lines?.length ? { ...tool, description: `${tool.description} ${lines.join(' ')}` } : tool;
}
