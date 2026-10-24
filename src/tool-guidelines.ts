/**
 * Workflow guidance attached to the tool it is about, so it appears in the model's instructions exactly when that tool is active and a
 * role never reads advice about a tool it cannot call. The lead's own policy section stays free of tool names and inside its size budget;
 * these lines are operational advice only and never grant, widen or replace a gate the host enforces.
 * Bump POLICY_VERSION when any line changes: it is part of the runtime closure digest and is shown to the operator.
 */
export const POLICY_VERSION = 3;

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
};

export function withGuidelines<T extends { name: string; promptGuidelines?: string[] }>(tool: T): T {
  const lines = TOOL_GUIDELINES[tool.name];
  return lines && !tool.promptGuidelines ? { ...tool, promptGuidelines: [...lines] } : tool;
}
