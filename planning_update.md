# P19 — Phase progression, evidence independence and the dispatch walls (plan of record, 2026-10-29)

Status: **P19/A (the validation-dispatch wall), P19/B3 (the runtime-profile wall) and P19/F (dispatch refusals and
resumability made visible) are implemented, verified and committed together on the owner's instruction (D-P19-5).
P19/C (a recorded wall is progress), P19/D (research-debt backlog is a planning signal) and P19/E (measurable goal proof
and the blocked settle) are implemented, verified and committed in the same day's second pass (D-P19-7); the commit and
push followed the owner's later "commit và push luôn đi" instruction (D-P19-8).** Base commit `b43e131` (S1/C5; that plan
of record is unchanged in git at `git show b43e131:planning_update.md`). The owner's `AGENTS.md` edit and the untracked
`pi-p2o-defense-vi.pptx` are outside this plan.

Owner request (2026-10-29, Vietnamese, truncated):

> "nghiên cứu lại cách mà ARTEX hoạt động như thế nào đối với phase recon và các phase tiếp theo, từ đó tổng hợp so với
> điểm nghẻn hiện tại, và cả A. Sửa bug validation dispatch. Từ đó giúp tôi hoạch định để có thể update được project để
> sửa những lỗi sai hiện tại."

Research inputs: the owner's local **ARTEX snapshot** under `my_references/ARTEX/` (untracked and gitignored;
AGPL-3.0; Go backend + `norma` SDK, snapshot labelled 0.3.15) and the local analysis
`my_references/ARTEX/ARTEX_AGENTIC_CORE.vi.md`; the live run below. No ARTEX target was contacted and no model was run for
this research.

Decisions carried forward:

- **D-P19-1 — ARTEX is a reference, not a target.** P19 borrows mechanisms (wake discipline, wall semantics, walling
  negative branches) and compares behaviour; it does not copy code or weaken p2o's deterministic evidence ladder.
- **D-P19-2 — Verification stays deterministic and hermetic** (S1/D-S1-3). No live benchmark run in P19 unless separately
  authorized; every item is proven with `tsc`, the vitest suites, `build`/`check:build`, the declaration budget and
  `detect_changes`.
- **D-P19-3 — Commits remain owner-initiated** (AGENTS.md); identity is the repository's and no attribution lines are
  added.
- **D-P19-4 — The pinned prompt/declaration ceilings are not raised casually.** A prompt change that exceeds the pinned
  ceiling is re-pinned only from a measured number with a dated comment (S1/D-S1-5 precedent).
- **D-P19-5 — The owner chose option 1 (§6) and one commit (2026-10-29).** Fix the two observed dispatch walls (A and B3)
  plus visibility/resume (F) now; C/D/E wait for the next pass so their prompt changes are measured. The three fixes are
  committed together under the owner's explicit "commit it" instruction; commit identity/attribution rules are unchanged.
- **D-P19-6 — B3, not B1/B2.** Thinking is role configuration, not a per-task or per-dispatch choice. The host refuses a
  per-task `thinking` request instead of reconciling it (B1) or downgrading the mismatch to a note (B2). Trade-off accepted:
  the planner loses per-task thinking tuning, in exchange for never accepting a level the selected model will clamp, which
  is exactly what stranded four live tasks. Model identity stays an exact-match wall.
- **D-P19-7 — C/D/E are the second pass, after A/B3/F (2026-10-29).** The owner said "ok làm đi P19/C, D, E": implement,
  cover with hermetic tests and update the plan/matrix; the tranche stayed uncommitted until a later owner instruction,
  because commits remain owner-initiated (D-P19-3).
- **D-P19-8 — Commit and push the C/D/E tranche on the owner's instruction (2026-10-29).** The owner said "commit và push
  luôn đi": one commit for the verified tranche with a plain message, repository identity and no attribution lines, then
  push. The owner's `AGENTS.md` and the untracked slides are never staged; no live run is authorized by this decision.

## 1. What the live run shows (evidence first)

Run `run-5367910f-7f14-4357-a983-8eaa6ebfde21`: `https://ise.uit.edu.vn/vi`, durable-local, 2026-10-29
06:21:19Z–07:34:50Z (73 minutes), **7 planner rounds**, ledger `assessment.sqlite` (read-only queries in §8).

**1.1 The round shape.** 21 tasks were authored: 13 recon, 6 validation, 2 discovery. Final status: 7 closed, 4 blocked,
1 reviewed, 1 running, **8 still proposed**. 10 candidate claims, 3 cases pending (never accepted), 2 goals still
`active`. Research debt was **3 → 119 → 196 → 212 → 222** across rounds; every round's wait was refused with the same
sentence: "the round still owes 2 goal(s) not reviewed or closed; 222 research debt item(s) with no discharge".

**1.2 The recon loop is breadth creep, not repetition.** Recon questions were each new: Next.js/NextAuth build ids →
`/api/admin-*` routes → admin segments → build-debug artefacts → OPTIONS/TRACE → admin namespace reachability →
NextAuth CSRF-mint behaviour → RSC-prefetch differential → a second worker re-observing the same surface. No single step
repeated; the loop repeats the *decision* "probe one more anonymous variant" because that is the only action the round
demand leaves open. Mechanism in p2o: the demand floor refuses one `wait` while completion work is owed
(`extensions/p2o/index.ts` ~3538, fact `planner.round-nudge`), and research debt is derived from unplanned assets, unrun
cells and WSTG-mapping gaps (`src/debt.ts`). Each new asset and each new recon observation adds debt instead of
discharging any, so the demand never clears and the planner answers with another probe.

**1.3 Validation never started (wall A).** All 6 validation tasks are `proposed` and were never reserved (task ids
`validation-734eed3c…`, `validation-9cef3166…`, `validation-72fb38c0…`, `validation-2996ffd5…`, `validation-d4c5a16f…`,
`task-553a06d7…`). The planner's own round-close record names it: "Fresh spawns and host validation keep failing
(DELEGATION_SPAWN_FAILED, TASK_METHOD_STALE), so blocked rows have no receipts to review and cases stay pending until an
independent replay lands." Consequence: three cases cannot earn independence (`src/cases.ts`), so the planner keeps
authoring recon peers to "independently" re-observe — the observable recon treadmill.

Root cause (fixed in P19/A): `validationDraft` declares `method.skills: []` (`src/validation.ts:40`) while dispatch
recomputes the method from the same purpose and `work.needs`, which is non-empty because the draft copies the discovery
work (`src/roles.ts:119`: a validation with needs gets the exploitation ladder). The dispatch guard compares the declared
and resolved skill hashes (`extensions/p2o/index.ts:945`) and refuses with `TASK_METHOD_STALE`, so the auto-enqueued
replay never spawns. The defect was latent on recon-only discoveries (no needs) and fired on every needs-bearing claim.

**1.4 Spawn wall B (runtime profile mismatch).** Four tasks were blocked with outcome "Runtime profile mismatch;
investigation not started."; all four carried `runtime.thinking: "medium"`. Every worker that did start ran with
thinking `max` or `high`. Pi's own model catalog for `opencode-go/deepseek-v4.1-flash` maps only `low/high/max`
(`thinkingLevelMap`; `medium` is null and is clamped), while the worker's runtime check requires thinking to be exactly
equal to the requested level and otherwise reports "prerequisite-blocked" (`src/broker.ts:413`,
`extensions/p2o/index.ts:816-823`). The host validates `runtime.thinking` only against the generic seven-level list
(`src/roles.ts:298`), not against the level the selected model actually supports, so a legal-looking planner choice can
brick a task.

**1.5 Goal economy.** Both goals stayed `active` because their proofs were not reachable by the branches the run
took: goal `goal-d2bbefdb…` proof is coverage of the whole anonymous surface; goal `goal-b82462b4…` proof is
`data.read` capability. `GOAL_OPEN` is itself a completion obligation and keeps the demand floor live forever; nothing
in the run walled a goal whose proof the target cannot produce, and `p2o_finish partial` was never reached.

**1.6 Dispatch failures are invisible after the fact.** The Engine catches a failed spawn and only raises an in-memory
UI notification (`src/engine.ts:210`); no ledger record names the refusal. The planner inferred `TASK_METHOD_STALE` from
a tool error and wrote it in prose. A resumed run cannot explain why a task stayed `proposed` from its own ledger.

**1.7 Crash and resume.** The durable-local store survived the crash, but `pi --resume` restores only a transcript and
`session_start` deliberately strips the p2o tools when no in-process run exists; the supported path is
`/p2o --resume <runId>` from the same working directory (`docs/USAGE.md:93`, `tests/minimal/resume.test.ts`). Nothing in
session start points at the recoverable run, which is the UX half of the owner's report.

## 2. How ARTEX runs recon and the phases after it (reference model)

**2.1 There is no phase state machine.** ARTEX decomposes the goal into **final, verifiable outcomes**, and its goals
agent is explicitly told that information gathering, reconnaissance and endpoint scanning are **not** goals
(`agent/goals.go:19`); scope extraction is a separate code-owned tail. A task then runs one `plannerLoop` plus N
`workerLoop`s (`server/engine.go`); the planner is the sole intent generator and a worker owns exactly one intent
(`agent/worker.go:230`). "Recon", "exploitation", "validation" are therefore emergent labels on intents, not stages the
engine advances through.

**2.2 Wake discipline — the mechanism p2o lacks.** ARTEX's planner prompt (`agent/planner.go:298`) makes a zero-intent
wake the normal case: the hard baseline requires at least one intent only when the goal is unmet **and** the frontier and
running sets are both empty; otherwise 0 intents is legal with a stated reason — already covered, or waiting on a
dependency that is currently running. The README states it plainly: "most wakes dispatch 0 intents — no new direction
means stop". p2o instead treats a zero-intent round as a stall and refuses the wait while any obligation remains, so the
planner is pushed to manufacture the cheapest admissible action.

**2.3 Recon is emergent and time-boxed.** At the start the planner may run at most a few read-only probes itself, and
only to sharpen an intent description; once any worker fact exists it may not probe, and enumeration/exploitation is
worker work. After that, recon intents are just the first round of the same loop.

**2.4 Negative-observation discipline (prevents breadth creep).** ARTEX treats a worker's negative result as an
observation, not a verdict: the planner must read the evidence, trust the branch as closed only when the observation is
`observed` and the means were exhausted, and may re-check a negative direction **at most once** before respecting it and
stopping. p2o has `ruled_out` and `CHAIN OR WALL` (`src/prompts.ts`) but no "one re-check then wall" rule, so a bounded
negative does not stop the next variant.

**2.5 The later "phases" are the same loop under different policies.** Depth over breadth; 2–3 mechanism families; a
serial exploitation chain is written once into the planner's persistent todolist and only the next step whose
prerequisite fact exists is dispatched; `prove_goal` checks quantitative acceptance before marking met; the last met goal
ends the task and cancels workers. Separate agents handle the post-work phases: a **report writer** on finding
(`agent/promptcatalog.go`), a **retester** with reproduced/fixed/inconclusive verdicts (`agent/retester.go`); when a
budget runs out the run enters a **settlement phase** with its own wrap-up prompt, and an exhausted intent is retried or
re-routed by the planner rather than treated as a failure (`agent/wrapup.go`).

**2.6 Two graphs, and what coverage means there.** The asset graph is global (six asset types); the exploration graph is
per task (`goal/intent/fact/finding/hint/digest`, edges `spawns/derived_from/yields/proves`) and is linked to assets by
`exploration_anchors` (`db/exploration.go`). Coverage is a projection of anchors/facts used as a **planner signal**, not
an obligation that can keep a task alive. Context is a bounded overview projection plus cold digests, never the whole
graph.

**2.7 Boundaries of the borrowing.** ARTEX has no deterministic completion checker (goal proof is model-judged), no
durable per-round ledger or durable todolist (the todo store is in-process), and no independent-replay requirement for
claims. p2o's evidence ladder and replay independence are deliberately stricter; P19 must not trade them away.

## 3. ARTEX vs p2o at the decision points

| Decision | ARTEX | p2o today |
|---|---|---|
| Unit of continuity | per-task exploration graph + in-process planner todo | durable ledger + plan board + round brief |
| Wake discipline | zero intents normal; hard baseline only when no open/running intent | zero-intent round recorded as stall; one wait refused per round while work is owed |
| Recon | emergent first intents; planner probes ≤ a few times at start only | mapping/recon is an admitted role and the cheapest action the round demand leaves |
| Negative branch | evidence-checked, one re-check maximum, then walled | `ruled_out` exists; no one-recheck-then-wall rule |
| Serial chain | persistent planner todolist, next step gated on prerequisite fact | plan board + chain steps with pinned prerequisites and claim citations |
| Coverage | planner signal from fact/asset anchors | derived coverage cells; unplanned cells become gateable research debt |
| Goal settlement | judge by planner with quantitative check; last goal ends task | host-verified proof; open/unprovable goal keeps completion incomplete |
| Independence | not modeled | independent replay required by the evidence ladder (stricter) |
| Failure semantics | exhausted = resume/re-route; blocked = retry or change mechanism | task `exhausted`/`blocked` records exist; dispatch refusals are UI-only |
| Memory/context | bounded overview + cold digests + trace retrieval | bounded round brief + ledger + graph reads |

Already borrowed from ARTEX in earlier passes (keep): `DEPTH OVER BREADTH`, `MECHANISM FAMILIES`, `CHAIN OR WALL` and
round hygiene (`src/prompts.ts:170-177`, comments cite ARTEX `agent/planner.go:304-331`).

## 4. Plan of record

Each item states the defect, the smallest change, actual acceptance, and what must not change. Items are ordered by
observed impact per unit of risk.

### P19/A — validation dispatch (implemented; committed with B3 and F)

- **Defect:** host validation declares `method.skills: []` (`src/validation.ts:40`) while dispatch resolves the needs
  ladder (`src/roles.ts:119`) and the staleness guard refuses the replay (`extensions/p2o/index.ts:945`).
- **Change:** in `hostValidation`, resolve `resolveRole({role:'validation', purpose:'validation', context:{kind, needs:
  workNeeds(draft.work)}})` and `prepareMethod` once, and store that method on the draft before `board.create`. Creation
  and dispatch now compute the same skills and hashes; the guard is not weakened and manual validation authoring is
  unchanged.
- **Acceptance (met):** a new hermetic test in `tests/minimal/chain-economy.test.ts` seeds a needs-bearing discovery
  claim, reviews it, asserts the host validation declares the resolved ladder
  (`['exploit-design','credential-and-pivot']` with 64-hex hashes), then lets the host's own enqueue dispatch it and
  asserts the task leaves `proposed` with a `p2o-validation-*` assignee and no `TASK_METHOD_STALE` event. With the fix
  stashed the test fails on the method assertion; with the fix it passes. `docs/EVIDENCE.md` and the acceptance matrix
  (row 14b) were updated in the same change, so the dispatched replay has a pinned citation. Full suite: 154 files /
  1,348 tests passed, 13 skipped; `tsc`, `build`, `check:build`, `audit-surface` (0 contradictions) and the declaration
  budget are unchanged (44,134 / 40,124 / 39,313 / 6,282).
- **Must not change:** the evidence ladder, the replay independence rules, the authoring path, and the pinned ceilings.

### P19/B — remove the per-task thinking axis (B3; implemented)

- **Defect:** a planner-authored `runtime.thinking` level the selected model does not support (e.g. `medium` on
  `opencode-go/deepseek-v4.1-flash`) is clamped by pi, and the worker then reports `prerequisite-blocked` with no
  investigation (four live tasks).
- **Owner decision (D-P19-6):** B3 — remove per-task and per-dispatch thinking overrides; the worker level is role
  configuration (`settings.roles.*.thinking` → package default → planner session). B1 (catalog clamp) and B2 (verified-with-
  note) were rejected because both keep accepting a level the model may not run.
- **Change:**
  - `src/tasks.ts`: the task runtime vocabulary is `{model?}`; an unknown key (including `thinking`) is refused.
  - `src/roles.ts`: `validateTaskRuntime` validates the model only and refuses extra keys rather than silently dropping one;
    `resolveRole` no longer takes a per-spawn thinking input, so the level is always
    `settings.roles.<role>.thinking` → package default → parent session.
  - `src/tool-schemas.ts`, `src/board-verbs.ts`: the task-author runtime and the dispatch parameters drop `thinking`; the
    planner prompt names the configured model list only (`src/prompts.ts`).
  - `extensions/p2o/index.ts`: spawn, dispatch and held-continuation paths drop the thinking override; a runtime mismatch
    report now carries the requested and effective model/thinking so a role-settings mistake is explainable; the worker task
    brief says `requested worker model`.
  - `src/broker.ts`: `DelegateInput.thinking` is gone; `requestedRuntime`/`effectiveRuntime` and the exact broker
    verification stay, because role-level thinking still reaches the worker through `--thinking`.
- **Acceptance (met):** `roles.test.ts` and `operator-controls.test.ts` prove a task/dispatch cannot name a thinking level
  (refused, not silently stripped) while the model path still validates and a dispatch still overrides the model;
  `workflow-policy.test.ts` proves the planner prompt offers the model list only; `extension.test.ts` proves a spawn carries
  no per-spawn thinking override and launches the role/parent level.
- **Must not change:** the broker's exact model match (a wrong model still blocks); role-configured thinking still launches
  the worker and is still verified.
- **Residual risk:** an operator role setting naming a level the role model does not support still fails the broker's exact
  check; B3 makes that failure name both sides instead of removing the class. A catalog-aware clamp is B1's rejected scope
  and can return if operator configuration proves to be the failure source.

### P19/C — wake demand: let a wall count as progress

- **Defect:** the demand floor refuses the wait whenever completion work is owed, and the only legal next actions it
  names are "create and dispatch" or "blocked" (recorded as a stall). The planner therefore manufactures probes instead
  of walling a branch.
- **Change (behavioral, no new tool):** make "record the wall" a first-class legal response in the round: a
  `deferred`/`blocked` todo that cites the debt ids it answers discharges that debt (`src/planning.ts` already requires
  `debtRefs` for discharge). In the engine/demand path, a round that records such a wall is progress, not a stall; the
  hard baseline stays the ARTEX one — dispatch an intent only when the goal is unmet and no open/running intent can carry
  the work, and the frontier is genuinely empty. Prompt text must state the same rule and the one-recheck-then-wall
  discipline (P19/C2).
- **Acceptance:** a hermetic scenario test with three bounded-negative recon variants and one walled todo shows debt
  stable (not growing) across rounds and the engine does not escalate a stall; a round with a real ready direction still
  cannot be a quiet round.
- **Must not change:** the demand floor still names the obligation; a completely idle round with no wall and no intent is
  still a stall.
- **Implemented (2026-10-29, second pass; verified and committed, D-P19-8).** `walls` is a fifth counter in `RoundProgress` and
  `judge` (`src/engine.ts`), so a round that adds only a wall clears the quiet streak; `RoundStall.wallRecorded` makes
  `stallRound` return false and reset the escalation streak instead of recording `planner.stalled`. `roundRead` counts
  `wallRows(planFrontier(index))` and hands the delta against the last judged round to both paths
  (`extensions/p2o/index.ts`). The demand floor refuses the first wait only when the round has owed work, no wall recorded
  this round and no `openIntents`; its `legalNext` names the wall first, then dispatch, then blocked; the same sentence is
  in the settlement nudge. `src/prompts.ts` gains the `WALL THE BRANCH` line (one recheck, then wall; a walled round is
  progress, an invented probe is not) and `src/round-brief.ts` states that a deferred/blocked todo citing the ids is the
  wall. Recorded wall = a `deferred`/`blocked` todo with non-empty `debtRefs` (`wallRows`, `src/debt.ts`).
- **Acceptance (met):** `engine-campaign.test.ts` proves the walled round is progress, is not stalled, resets the streak
  and does not escalate across three recon-shaped rounds; `loop-actions.test.ts` proves the wall makes the first wait
  legal and the walled round writes no `planner.stalled`; the `keeps a round with a real ready direction quiet` test
  proves the rule cannot sleep through owed work.

### P19/D — research-debt accounting: separate obligations from backlog

- **Defect:** debt kinds are all gateable; observation-derived backlog (unplanned assets, unrun cells, WSTG gaps) grows
  with every recon asset and no admissible task can close it in one decision, so completion can never be reached.
- **Change:** classify debt kinds that a decision row/wall can discharge (goal, plan, chain, triage) from kinds that are
  a planning signal only (`SCOPE_UNPLANNED_ASSET`, `CELL_NOT_RUN`, `WSTG_UNPLANNED`, `MAPPING_UNRECORDED`); the latter
  stay in the report and the brief but do not alone keep the demand floor alive. Give every gateable item a
  "how to discharge" sentence in the brief; walling a branch must discharge its own items.
- **Acceptance:** fixture with prior recon breadth shows gateable debt does not grow when branches are walled; the finish
  preflight still refuses a run with un-triageable existing work; report counts unchanged.
- **Implemented (2026-10-29, second pass; verified and committed, D-P19-8).** `src/debt.ts` splits the vocabulary into
  `OBLIGATION_KINDS` / `SIGNAL_KINDS` + `ADVISORY`; `gateable` is true only for obligation kinds, so
  `gateableIds`/`debtFor`/completion/preflight/demand floor stop counting the four observation-derived kinds. The report
  keeps them: `items`, `totals`, `total` and the new `backlog` count are unchanged in meaning, and `debtSummary` names
  `planning signal (not owed work)` separately. Every obligation kind carries a `DEBT_DISCHARGE` sentence; the round
  brief prints it with each gateable item, plus one sentence naming the wall record. A wall may cite any current id
  (gateable or signal) — considered and kept, because answering one branch of the map is a legitimate discharge; the
  preflight/`RESEARCH_DEBT` list follows gateable ids only.
- **Acceptance (met):** `debt.test.ts` proves three new recon assets grow `total`/`backlog` while `gateable` stays flat,
  the preflight names only owed ids, one wall row discharges its gateable and signal items, and every obligation kind has
  a discharge sentence; `round-brief.test.ts` pins the signal line, the discharge sentence and the wall sentence.

### P19/E — goal economy: author measurable proof, allow a blocked settle

- **Defect:** two live goals proved impossible to satisfy by the executed branches (whole-surface coverage; a
  `data.read` capability) yet stayed `active`, so completion could never be reached and the demand floor never slept.
- **Change:** goal authoring guidance and validation require a proof the run can actually measure (bounded
  denominator/known target capability) and state what would make it unreachable; allow a goal to settle `blocked` with a
  reason when its proof is unreachable, and account that as settled-with-debt in completion rather than silently open.
  Keep the transition itself a plan revision (`src/planning.ts` already allows `active → blocked` without proof).
- **Acceptance:** fixture with an unreachable goal: goal becomes blocked with a reason, completion counts it as
  settled-with-debt, `p2o_finish partial` path works; a provable goal still cannot be settled without proof.
- **Implemented (2026-10-29, second pass; verified and committed, D-P19-8).** Measurability is enforced where the state can check
  it: `goalProofRefusal` refuses a coverage plan with no live cells (an empty denominator would hold vacuously), the
  capability vocabulary is still the closed `capabilityList`, and a `blocked` settle must carry non-empty `exclusions`
  (`PlanBoard.references` -> `GOAL_UNREACHABLE`); reviewed/closed still require `goalProofRefusal` to hold. Guidance is
  prompt/tool text: `GOAL PROOF` in `src/prompts.ts`, the `p2o_goal_author` description and its boundary line state the
  measurable proof and what would make it unreachable. `deriveCompletion` excludes `blocked` goals from `GOAL_UNSETTLED`
  and returns `settledBlocked` (id + reason); `completionLine` and the report print `settled with debt`, the report's
  goal table shows the reason instead of "no", and `p2o_finish partial` records the partial reason next to that
  completion. The settle stays a plan revision (`active -> blocked` was already legal).
- **Acceptance (met):** `completion.test.ts` proves blocked counts as settled-with-debt (not open work), an empty
  coverage denominator is refused, and an unreachable goal settles blocked + partial finish records it; a reviewed goal
  with an unproven capability still lands in `GOAL_UNPROVEN`. `round-brief.test.ts` pins the brief sentence;
  `dispatch-discipline.test.ts` pins the prompt contract.

### P19/F — make dispatch walls visible and make resume discoverable (implemented)

- **Defect:** engine spawn refusals were UI-only (`src/engine.ts`), and a crashed run's durable state was not surfaced at
  session start.
- **Change:**
  - `src/engine.ts`: the drain catch now persists a bounded lifecycle fact before the notification:
    `dispatch refused for <taskId>: <CODE>: <reason>` with `data.engine = {event:'intent-blocked', taskId, code, reason}`.
    The code is read from `Error.message`'s `CODE:` prefix (`fail()` throws `CODE: message`) and falls back to
    `DISPATCH_REFUSED`; the no-automatic-retry rule and the existing UI event are unchanged.
  - `extensions/p2o/index.ts`: `durableRunHint` reads the newest `run-*/assessment.sqlite` under the workspace state root. A
    `session_start` with no live run and no ticket notifies once with the run id and `/p2o --resume <runId>`, stating that
    only knowledge returns. It never adopts authority, never opens a store writable and never resumes.
  - `docs/USAGE.md` troubleshooting: the resume command (not `pi --resume`) and the ledger fact a stuck `proposed` task
    carries.
- **Acceptance (met):** `engine.test.ts` and `chain-economy.test.ts` prove a failed spawn leaves exactly that fact (generic
  failure and the realistic `WORKER_NOT_HELD`); `resume.test.ts` proves a startup in a workspace with a durable run names it
  and adopts nothing; the docs authority scan and acceptance matrix stay clean.

### P19/G — explicitly out of scope

ARTEX's cross-worker trace search (`search_all_worker_traces`, `get_worker_trace`) does not map onto p2o today: p2o
workers are token-bounded model turns, not recorded sessions with a step store; the equivalent evidence is the ledger's
candidate claims, receipts/artifacts and worker reports. Revisit only if a session/step store becomes a requirement.
No new tools are added in P19.

## 5. Sequence, budget and gates

Order: **A (done) → B3 (done) → F (done) → C (done) → D (done) → E (done)**. B3 and F were local, testable and unblocked the
resume; C/D/E are behavioral and carry prompt-budget risk, so they went last with before/after measurements (D-P19-7).
Every item keeps the S1 verification protocol (`tsc`, focused suites, full suite, `build`/`check:build`, `audit-surface` +
declaration budget, `git diff --check`, GitNexus `impact` before an edit and `detect_changes` before commit). Prompt text
changes measure the planner ceiling (45,500 chars) and re-pin only from a measured number (D-P19-4).

## 6. Owner options

1. **Recommended — A + B + F now.** Fix the two observed dispatch walls and make the failure/resume visible; smallest
   diff, all hermetic, unblocks the crashed run and any future needs-bearing validation. C/D/E next pass with measured
   prompt changes.
2. **Full behavior pass — A + B + C + D + E.** Also changes the wake/debt/goal economy now; larger behavioral surface,
   needs new scenario tests for "quiet round is legal" and more review time; higher risk of a lazy campaign.
3. **Stop at A.** Commit only the validation fix, resume the run, finish it partial, and let the report record the walls;
   no further code this pass.

**Owner chose option 1 (2026-10-29, "A + B + F ngay"), together with B3 and the commit.** A, B3 and F are committed as one
tranche; the same day's second pass ("ok làm đi P19/C, D, E") implemented C/D/E with the measured prompt changes (D-P19-7),
and C/D/E were committed after the owner's "commit và push luôn đi" instruction (D-P19-8).

## 7. Verification record for P19/A + B3 + F

- `npx tsc --noEmit` — pass.
- Focused suites (`roles`, `operator-controls`, `chain-economy`, `engine`, `resume`, `extension`, `workflow-policy`,
  `prompt-roles`, `acceptance-matrix`, `authority`, `context-budget`, `recon`, `truth`, `surface-audit`) — pass. The
  per-task-thinking and spawn-override tests were rewritten against B3, and the two dispatch-refusal facts plus the resume
  hint are new assertions.
- Full suite — 154 files passed, 5 skipped (159); 1,349 tests passed, 13 skipped (1,362); 0 failed.
- `npm run build` and `npm run check:build` — pass; `scripts/audit-surface.mjs` — 35 tools / 0 contradictions; declaration
  budget — planner 43,968 / worker 40,124 / validation 39,313 / reporting 6,282 chars (planner −166 from the removed
  `runtime.thinking` schema text; model union 73,197), all under the pinned ceilings; `git diff --check` — clean.
- GitNexus: `impact` upstream on `validateTaskRuntime`, `resolveRole` and `spawnWorkerLocked` reports CRITICAL at file-edge
  granularity — every importer of the shared modules shows up as a d=1 file, the known inflation for exported helpers; the
  concrete change is a signature narrowing that `tsc` verifies, plus the focused suites. `detect_changes --scope all`
  names the expected symbols (`resolveRole`, `validateTaskRuntime`, `spawnWorkerLocked`, `continueHeldWorker`,
  `executeTaskAction`, engine `drain`, `activateWorker`, the new `durableRunHint`) with the round/resume processes, plus the
  doc/test files and the owner's `AGENTS.md` (never staged); no `partial`/`truncated`.
- Each fix carries a reproducing test: the A test fails when the `hostValidation` resolution is reverted; the B3 tests fail
  against the old per-task/`runtime.thinking` contract; the F tests fail without the ledger fact and the startup hint.

## 7b. Verification record for P19/C + D + E (2026-10-29, second pass)

- `npx tsc --noEmit` — pass.
- Focused suites (`debt`, `completion`, `engine`, `engine-campaign`, `loop-actions`, `round-brief`, `dispatch-discipline`,
  `finish-preflight`, `recon`, `context-budget`, `acceptance-matrix`) — pass. The new assertions are the C wall/progress
  and demand-floor tests, the D backlog/discharge tests and the E blocked-settle/partial-finish tests; the debt fixture
  expectations moved from 4 to 3 gateable items because the unrun cell is planning signal now.
- Full suite — 154 files passed, 5 skipped (159); 1,364 tests passed, 13 skipped (1,377); 0 failed (baseline before the
  tranche: 1,349 passed / 1,362; the tranche adds 15 tests).
- `npm run build` and `npm run check:build` — pass (`build import OK`); `scripts/audit-surface.mjs` — 35 tools / 0
  contradictions; declaration budget — planner 44,348 / worker 40,124 / validation 39,313 / reporting 6,282 chars, model
  union 73,577, all under the unchanged ceilings (planner +380 from the `p2o_goal_author` boundary text); `git diff
  --check` — clean with the owner's `AGENTS.md` excluded.
- Prompt ceilings: the planner instruction section grew 14,279 -> 15,126 (url, delegated) for the two new lines, so
  `tests/minimal/recon.test.ts` re-pins planner 14,400 -> 15,600 from that measured number with a dated comment
  (D-P19-4). The other four prompt ceilings and all five declaration ceilings are unchanged.
- GitNexus: `impact` upstream on `deriveDebt`, `debtSummary` and `deriveCompletion` reports CRITICAL at file-edge
  granularity — the known inflation for exported modules whose every importer appears as a d=1 file — and `stallRound`
  reports UNKNOWN with 16 receiver-typing call sites dropped (a text search confirms the two real call sites in
  `extensions/p2o/index.ts`); every concrete change is an opaque counter/read plus a signature narrowing that `tsc`
  verifies. After the local index rebuild (17,379 nodes / 77,878 edges), `detect_changes --scope all` names the expected
  symbols — `roundRead` (`walls`, `openIntents`), engine `judge`/`stallRound`/`snapshot`/`RoundProgress`/`RoundStall`,
  debt `DebtReport.backlog` and `DEBT_DISCHARGE`, completion `settledBlocked`, `PlanBoard.references`, `TOOL_BOUNDARIES`
  and `registerP2O` — plus the doc/test files and the owner's `AGENTS.md` (never staged); no `partial` or `truncated`.
- Each fix carries a reproducing test: the C tests fail without the `walls` counter, `wallRecorded` and the demand-floor
  wall branch; the D tests fail if the four observation-derived kinds are gateable again (the owed count grows with
  assets); the E tests fail if a blocked goal counts as open or an empty-denominator coverage proof is accepted.
- Doc truth pass after the code landed (same pass): `docs/ARCHITECTURE.md` (a walled round is progress, not a
  `planner.stalled`), `docs/PLANNER_ENGINE.md` (five progress counters; the conditional demand floor with wall-first legal
  answers; a walled round resets the escalation streak; only gateable debt wakes the loop; bounded/blocked goal proof),
  `docs/EVIDENCE.md` (`RESEARCH_DEBT` counts gateable debt; a blocked goal prints as settled with debt), `docs/WSTG_MAP.md`
  (`WSTG_UNPLANNED` is planning signal) and `docs/USAGE.md` (conditional wait refusal). After those edits `npx tsc
  --noEmit`, the doc-sensitive suites (acceptance-matrix, authority, truth, wstg-applicable, knowledge — 37 tests) and the
  full suite re-ran green with the same counts, and `git diff --check` stayed clean.
- Commit and push (D-P19-8, after the owner's "commit và push luôn đi"): one commit for the tranche, plain subject/body,
  repository identity, no attribution lines, `AGENTS.md` and the untracked slides never staged; verified with `git log -n 1
  --format=%B` before pushing. `detect_changes --scope all` was run again on the final tree (134 changed symbols, 27 changed
  files, no `partial`/`truncated`) immediately before staging.
- Not run, deliberately (D-P19-2): no paid model call, no target traffic and no live campaign for the new behaviour; the
  live-run evidence in §1/§8 is still the pre-fix baseline.

## 8. How to reproduce the live-run evidence

Read-only SQLite queries against the crashed run's durable store (no writes, no target contact):

```sh
RUN=~/tmp/cmp/.p2o-state/run-5367910f-7f14-4357-a983-8eaa6ebfde21/assessment.sqlite
sqlite3 "file:$RUN?mode=ro" "SELECT json_extract(body,'\$.data.task.role'), json_extract(body,'\$.data.task.status'),
  COUNT(*) FROM records WHERE kind='task' GROUP BY 1,2;"
sqlite3 "file:$RUN?mode=ro" "SELECT json_extract(body,'\$.data.task.outcome') FROM records WHERE kind='task'
  AND json_extract(body,'\$.data.task.status')='blocked' AND json_extract(body,'\$.data.task.outcome') LIKE '%Runtime profile%';"
sqlite3 "file:$RUN?mode=ro" "SELECT json_extract(body,'\$.text') FROM records WHERE kind='lifecycle'
  AND json_extract(body,'\$.text') LIKE 'planner.round-nudge%' ORDER BY sequence DESC LIMIT 3;"
```

The blocked-task `runtime.thinking` values come from the same records; the supported thinking levels for the configured
model are in the installed pi catalog (`@earendil-works/pi-ai/dist/providers/data/opencode-go.json`).

## 9. Owner decisions (answered in chat, 2026-10-29)

1. **Option and sequence (§6):** option 1 — A + B + F now.
2. **Commit:** yes — one commit for A + B3 + F, plain message, repository identity, no attribution lines; verified with
   `git log -n 1 --format=%B` and never staging the owner's `AGENTS.md` or the untracked slides.
3. **P19/B choice:** B3 — remove per-task thinking overrides and keep the configured role level.
4. **Live re-run for C/D/E:** not authorized in this pass; C/D/E acceptance stays deterministic/hermetic until the measured
   prompt changes are reviewed. The crashed run can be reopened with `/p2o --resume run-5367910f-7f14-4357-a983-8eaa6ebfde21`
   from `~/tmp/cmp` (knowledge only; no ticket, worker or authority returns).
5. **P19/C–E implementation (2026-10-29, second pass):** the owner said "ok làm đi P19/C, D, E". Implement, cover with
   hermetic tests and update the plan/matrix; the commit stayed owner-initiated and was not authorized at that point
   (D-P19-7). The pass kept all declaration ceilings (measured planner 44,348) and re-pinned only the
   `recon.test.ts` planner prompt ceiling from a measured number (14,400 -> 15,600, D-P19-4); no live re-run was
   authorized.
6. **Commit and push for P19/C–E (2026-10-29):** the owner said "commit và push luôn đi". The verified tranche is one
   commit with a plain message, repository identity and no attribution lines, then pushed (D-P19-8). The owner's
   `AGENTS.md` edit and the untracked `pi-p2o-defense-vi.pptx` are never staged. No live run was authorized by the push.
