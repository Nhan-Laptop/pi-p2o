/**
 * planning_update.md P13(f): the prompt ceilings were the same numbers written by hand in three test files
 * (`recon.test.ts`, `measure-context.test.ts`, `workflow-policy.test.ts`), so every prompt change required three coordinated edits and
 * one of them was applied with a substitution that damaged a history comment. One table now owns the numbers; the tests read it.
 *
 * Rules for editing this file, in the spirit of the surrounding pins:
 * - Raise a number here on purpose, with a dated comment naming the change that grew the prompt. Never raise one to make a test pass.
 * - `lead` ceilings are counts of characters. `declaration` and `guidance` are serialized bytes summed over a loadout's tools.
 * - The budget test keeps a 2 % tolerance on declarations and guidance; these values are the measured size, not the tolerance.
 */
export const LEAD_CEILINGS = {
  /**
   * 2026-10-22 (planning_update.md P10): the lead's DELEGATION block gained one sentence per terminal state (done / exhausted /
   * blocked / stopped), because "hit the allowance" was being read as "answered". Static bodies grew to 5,611 (directory) /
   * 5,762 (url) / 6,579 (hybrid); every ceiling below is static + the 240-character situation allowance.
   */
  /**
   * 2026-10-23 (planning_update.md P15, deliberate): the lead prompt gained three clarifications and lost one duplication. The stall
   * rule became conditional, the independence sentence now names the payload hash and the environment fingerprint the host actually
   * compares, severity became computed rather than chosen, and the assigned objective gained the one sentence that says how far it
   * reaches; in exchange the URL and hybrid scope lines no longer repeat "only the human can widen scope" or "tool repositories are
   * not extra targets", which the next line already states. Static bodies are now 5,892 (directory) / 5,970 (url) / 6,769 (hybrid),
   * delegated 6,538 / 6,616 and 6,861 event-driven; every ceiling below keeps the 240-character situation allowance and the usual margin.
   */
  soloDirectory: 6_150,
  soloUrl: 6_250,
  hybridSolo: 7_050,
  delegatedDirectory: 6_800,
  delegatedUrl: 6_900,
  delegatedEventDriven: 7_150,
} as const;

/**
 * Serialized tool declarations and prompt guidelines per loadout, measured 2026-10-22.
 *
 * 2026-10-22 (planning_update.md P14.1, deliberate): `p2o_candidate`'s two prose strings became `gained`/`needs`, each an array of
 * `{kind, subject?, scope?}` with `kind` an enum of the fifteen capability kinds. The same object is inlined twice per list, so the
 * declaration cost is real: delegated Planner 34,717 -> 36,130 (+414 B markup, +999 B enum), solo owner 35,518 -> 36,931, worker
 * 19,349 -> 20,646 (a worker carries no p2o_case, so the delta is smaller), reporting worker unchanged at 12,477 because it carries
 * no p2o_candidate. A shared `$defs`/`$ref` for the capability shape would declare it once and save ~600 B per loadout; it is not
 * taken here because the provider must dereference the ref for the schema to reach the model, and a silently unexpanded `$ref`
 * would be a worse failure than 1.4 KB. Revisit only with a measured provider check.
 *
 * 2026-10-22 (planning_update.md P14.2, deliberate): `p2o_lab` declares one action plus the payload request schema, and every
 * executing loadout carries it: delegated Planner 36,130 -> 37,654, solo owner 36,931 -> 38,455, worker 20,646 -> 22,170. The
 * reporting worker stays without it (synthesis executes nothing) and only moved 12,477 -> 12,486 with the P14.1 graph wording.
 *
 * 2026-10-22 (planning_update.md P14.3, deliberate): the same tool gained the environment recipe — three actions, a service
 * object with name/command/port/healthcheck/environment, and the compose flag — and its description now states what the
 * compose filter refuses. Delegated Planner 37,654 -> 39,736 (+2,082), solo owner 38,455 -> 40,537, worker 22,170 -> 24,252.
 * That is the largest single declaration added in this phase; it is kept because the alternative is an agent that either
 * cannot author a recipe or learns the refusal rules by hitting them one at a time. Reporting worker is unchanged again.
 *
 * 2026-10-22 (planning_update.md P14.4, deliberate): `work.purpose` gained `exploitation` and `chaining`, so the enum the task
 * and work schemas inline grew in every loadout, and `p2o_delegate` names the two new purpose outcomes. Delegated Planner
 * 39,736 -> 39,842, solo owner 40,537 -> 40,573, worker 24,252 -> 24,262, reporting worker 12,486 -> 12,496.
 *
 * 2026-10-23 (planning_update.md P14.8, deliberate): `p2o_research` is a new tool in every loadout — a curated-corpus
 * lookup that may fetch the top hits' own source pages inside the sandbox — so each loadout grew by the same 1,010 bytes:
 * delegated Planner 40,200 -> 41,210, solo owner 40,931 -> 41,941, worker 24,620 -> 25,630, reporting worker
 * 12,854 -> 13,864. The declaration is kept rather than trimmed further because the description is where a worker learns
 * that fetched text is quoted data and that an adapted payload still needs its own control. The prompt line that says the
 * same thing is out of this budget (it is prompt text, not a declaration). Guidance is unchanged.
 *
 * 2026-10-23 (planning_update.md P14.7, deliberate): `p2o_skill_read` gained `materialize` — one optional boolean plus the
 * sentence that says what it copies and what it refuses — so every loadout that carries the knowledge tool grew by the same
 * 358 bytes: delegated Planner 39,842 -> 40,200, solo owner 40,573 -> 40,931, worker 24,262 -> 24,620, reporting worker
 * 12,496 -> 12,854. The wording was trimmed once already (a longer first draft cost 581 B) because a worker that cannot
 * discover materialization still cannot run the harness it was given. Guidance is unchanged and POLICY_VERSION stays 2.
 *
 * 2026-10-23 (planning_update.md P14.9, deliberate): the rate schema of `p2o_case` describes the chain a case is rated on, so a step
 * gained `gained`/`needs` (the capability object is inlined twice per step, as in P14.1), an `effect` enum and a `reach` group.
 * Delegated Planner 41,210 -> 43,418 and solo owner 41,941 -> 44,149 (+2,208 each); the worker and reporting loadouts carry no
 * `p2o_case` and are unchanged. The descriptions were trimmed once (a first draft cost 2,384 B) by leaning on the enum to name the
 * effects instead of repeating them in prose. `reach` is kept rather than folded into `effect`: without it every hand-assembled chain
 * would score at the least favourable reach, so an owner who executed an easy path would have to overstate the effect to rate it.
 *
 * 2026-10-23 (planning_update.md P14.10, deliberate): two declarations grew. The work identity gained `needs` (one capability list,
 * the same object as above) and `environmentRef`, so a task can name what a step consumes and where it must run: that is +950 B in the
 * two loadouts that carry `p2o_task` (delegated Planner 43,418 -> 44,368, solo owner 44,149 -> 45,099). `p2o_graph`'s `chain` action
 * gained `plan` and `assetRefs`, which is +423 B in all four loadouts because every loadout carries the graph tool: delegated Planner
 * 44,368 -> 44,791, solo owner 45,099 -> 45,522, worker 25,630 -> 26,053, reporting worker 13,864 -> 14,287 — plus the 140 B the graph
 * description needed to say that `plan:true` drafts and never dispatches (44,931 / 45,662 / 26,193 / 14,427), because an action nobody
 * is told about is an action nobody uses. Passing the environment
 * as prose was rejected because P14.11 compares it with the environment a worker actually ran in, and a comparison against prose is not
 * a check; taking the asset refs from the caller was chosen over matching a surface string to an asset key, because a draft that names
 * the wrong asset is worse than one that names none and says so.
 *
 * 2026-10-23 (planning_update.md P14.11, deliberate): the work identity gained `budget.commands` (+256 B in the two loadouts that carry
 * `p2o_task`) and the worker report gained `wrapUp` (+216 B in the two worker loadouts, which carry `p2o_report`): delegated Planner
 * 44,931 -> 45,187, solo owner 45,662 -> 45,918, worker 26,193 -> 26,409, reporting worker 14,427 -> 14,643. Guidance is unchanged: the
 * wrap-up duty is prompt text in the worker brief (`dutyLine`), not a tool guideline, so it does not appear here.
 *
 * 2026-10-23 (planning_update.md P15, deliberate): `p2o_lab`'s trial-and-error contract was rewritten tighter (-100 B in every loadout that
 * carries it: delegated Planner 45,187 -> 45,087, solo owner 45,918 -> 45,818, worker 26,409 -> 26,309; the reporting worker does not carry
 * the tool and stays 14,643), and the same tool gained one guidance line (+180 B) because storing the payload before running it is advice,
 * not a schema fact. Guidance: delegated Planner 1,162 -> 1,342, solo owner 1,080 -> 1,260, worker 473 -> 653, reporting worker 376
 * unchanged. The owner guidance ceiling moved 1,200 -> 1,400 in `workflow-policy.test.ts` for that line; the worker cap did not need to move.
 * Net prompt effect of the same pass is negative (a trimmed evidence tail pays for three clarified rules), so the lead ceilings stand.
 */
export const DECLARATION_BUDGET = {
  'delegated Planner': [45_087, 1_342],
  'solo owner': [45_818, 1_260],
  'worker': [26_309, 653],
  'reporting worker': [14_643, 376],
} as const;
