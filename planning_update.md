# P23 — Chain activation: a demonstrated primitive must become the next dispatched link (plan of record, 2026-10-30)

Status: **plan written on owner instruction (2026-10-30); B1 landed in code, B2–B5 and Package C not started. P22/A1–A4 are
delivered (`7e5a0c3`, `548e716`, `d272786`) and P22/A5 is closed by measurement — two assess-mode live runs against
`https://ise.uit.edu.vn/`, with the numbers in §10. B1 records that measurement and fixes the one new measured defect
(A5-fix-5, the coverage-view bound); B2–B4 are hermetic; B5 is the live activation measurement. A second owner decision the
same day adds Package C (weaponization): an exploit-mode run against the same owner-authorized target, gated on the written
authorization being filed in C1/§12 first.** This file replaces the P22 plan of record. The P22 revision
stays recoverable at `git show 4aa1e05:planning_update.md`, and its F-P22-* rows stay in
[docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md) and its delivered rows in [docs/HISTORY.md](docs/HISTORY.md). Where
other pages cite `planning_update.md` §5/A1–A5, D-P22-*, or an appendix, they describe that revision of the file, not this
one.

Basis for this plan:

- p2o at commit `4aa1e05` (p2o 0.5.0, closure digest `425dea875f4a`): A1–A4 and A5-fix-1..4 delivered; `npx tsc --noEmit`
  clean; full suite 167 passed / 5 skipped files (172), 1,483 passed / 13 skipped tests (1,496), 0 fail; `npm run build` and
  `npm run check:build` green; surface audit 35 registered / 35 model-visible / 0 hidden / 10 board verbs with 0
  contradictions; declarations planner 45,049/45,500, worker 40,935/41,400, validation 40,124/40,500.
- the A5 measurement this plan starts from (§0, §10): `run-51d84fce-b16f-4a68-8e14-e9170cebd455` (cwd `~/tmp/p2o-live-a5`,
  the A5-fix-1..3 build) and `run-06fde84d-6b26-48b7-a8a2-494e9df8a70c` (cwd `~/tmp/p2o-live-run2`, the A5-fix-4 build),
  both assess mode, read-only, 2 workers, target-ops 2.
- the owner's decisions of 2026-10-30 (§11): package A (chain activation plus closing A5), repeated assess-mode live runs as
  the measurement channel, and docs updated and committed now with push on a separate instruction.

**Measurement stance.** Every statement in §2 is read from those two runs and from code; §0 is the measurement, not an
effectiveness claim. One host, one planner configuration and two runs cannot say what p2o can do in general, and no run has
yet dispatched a worker after authoring the chain link it stands on. The plan's own success is therefore defined as a
mechanism observation (§7), never as pentest effectiveness.

## 0. What the A5 measurement found

| Measure | Value (2026-10-30) |
|---|---|
| Run A — `run-51d84fce…` (cwd `~/tmp/p2o-live-a5`, assess, 2 workers, target-ops 2, quota 1024 MiB, runtime digest `b590bdff…` = the A5-fix-1..3 build) | 25 min and 4 rounds before the stale-context crash that measured A5-fix-4; the owner then resumed the run for 3 more rounds until a provider 402 (deepseek balance; the session's planner was `deepseek/deepseek-v4-pro`) paused it. Final store: **291 records / 1,024 events**, 4 claim records, 26 coverage judgments, 1 case awaiting review (confirmed/pending, rated informational), coverage plan active at r5. |
| Chain rows, run A | **2** — `todo-bda6a4ba…` (`chainOf: media-upload-read`, `step: 1`, `effect: confidentiality-read`, claimRefs `3564fa4c…`, needs `data.read`, taskIds `task-f3284c98…`) and the readiness row `todo-3e7969c0…` (`chainOf: chain-3c3dd3c8dd03`, step 1). This is the first live chain authoring on any build. |
| A2 lines, run A | **0**. The successor task (`task-f3284c98…`) was created 39 minutes before the link; its brief had already been sent when the link existed, so `CHAIN`/`CHAIN PATH`/`NEXT LINK` could not render. |
| Run B — `run-06fde84d…` (cwd `~/tmp/p2o-live-run2`, assess, 2 workers, target-ops 2, round-steps 30, runtime digest `425dea875f4a` = the A5-fix-4 build) | 1 h 46 min and 6 rounds (wake reasons: event 3, debt 1, heartbeat 2). **335 records / 1,072 events**, 74 worker target operations, 6 task records (1 recon + 1 discovery + 4 validation), all reported and reviewed; 9 worker claims; coverage plan closed with **8/8 cells tested**; 67 discovered assets outside the plan; 45 open gaps; 4 cases awaiting review and 0 accepted. No stale-context crash, no retention failure, clean stop and deterministic report. |
| Chain rows / A2 lines, run B | **0 / 0**. At stop the report counts **PRIMITIVE_UNCHAINED 4** ("a confirmed and tested claim has no successor step and no recorded wall"), **RESEARCH_DEBT 52** and **GRAPH_UNREVIEWED 1**. |
| A5-fix-4 under load | Held across three round-session replacements in run B; the scheduler read the invalidated host surface, skipped the wake it could not serve, and the campaign continued. No uncaught exception and no stale-context crash was recorded in either run after the fix. |
| New measured defect | `p2o_board board=coverage id=<plan> limit=10 cursor=0` returned **"Coverage result exceeds 24 KiB"** even though the coverage view pages cells. The page budget is applied to the cell array only (`src/counts.ts:44-53`, 23 KiB) and the frame plus the page is then passed to the 24 KiB `boundedResult` (`extensions/p2o/index.ts:291-292`); a closed plan with eight derived cells and a long frame cannot be read at any default limit, and the refusal names no remedy. |
| Bookkeeping tax observed | Goal-proof kind confusion (assess mode without a recorded operator policy); `TASK_UNMAPPED` at cold start (the first recon task must be bare because no asset exists yet, and a bare task can never be mapped, so the coverage denominator excludes it); `GAP_UNTRIAGED` debt ids are `debt-<kind>-<sha256(subject)[:12]>` (`src/debt.ts:95-97`) and the planner cannot derive that id from the gap ids it sees; the `confirmed-verdict-lacks-current-tested-claim` case refusal (`src/cases.ts:128,216`) names no claim to cite. |
| Provider note | The first resume's planner session ran `deepseek/deepseek-v4-pro` and its planner turn failed with HTTP 402 (empty balance). That is a provider failure, not a p2o defect: the documented rule is "a provider error pauses automatic wakes without retry" (`docs/PLANNER_ENGINE.md`), the store stayed intact and resumable, and no fallback was attempted. Live runs must be started with a working model; `opencode-go` served both the workers and run B's planner. |

**What the measurement could not tell us.** No run has ever dispatched a worker after authoring its chain link, so the A2
render has hermetic evidence only and no live observation. Assess mode demonstrated `data.read`-class primitives but refuses
exploitation and chaining intents, so activation is measured on whatever primitive the run finds and on a
discovery/validation successor citing it — not on an exploitation step. Run A's chain rows were authored 39 minutes after
the successor task, which is exactly the cadence defect S2 names; no other live run produced a link at all.

## 1. How to read this plan

- **Activation** is a demonstrated primitive becoming an authored successor link and then a dispatched task whose brief
  names that link. It is not a new chain representation: the link already exists as a plan row (`chainOf`/`step`), the
  brief already renders it (P22/A2) and the report already prints it (P22/A4).
- **Cadence** is the order of authoring relative to dispatch. A2 derives the link from the plan board and claim heads at
  brief time (`src/chain-brief.ts:60-84`); a link authored after its successor's brief was sent can never reach that brief.
- **Bookkeeping tax** is a step a round spends deriving a fact the host already holds — an id mapping, a legal next verb, an
  expected exception. A fix deletes the derivation; it never deletes the judgement or softens a review.
- Each B-row is a tranche with its own tests and a row in §10. A tranche is not done until its F-P23-* matrix row, its
  HISTORY row and the measured gates land with it (D-P23-8).
- Nothing in this plan moves authority. A recipe line, a hint, a debt-subject mapping or a paged view never satisfies a
  claim, case, coverage cell or goal, and nothing is dispatched or authored automatically (D-P22-2, D-P23-2).

## 2. Diagnosis — five measured seams

### 2.1 S1 — A demonstrated primitive becomes a debt row, not a next action

Run B finished with four confirmed-and-tested claims and no link: `PRIMITIVE_UNCHAINED 4` in the report
(`src/debt.ts:194,268`), and the round-4 end demand already said "4 demonstrated primitive(s) with no successor step"
(`src/completion.ts:46,71,93`). The host does print a discharge rule — "add the successor chain step, or wall it in a
deferred todo naming the ruled-out successors" (`src/debt.ts:268`) — and the planner prompt states the same rule
(`src/prompts.ts:190`). What the demand does not print is the *call*: for each primitive, the claim slug and retained record
id, the capability it gained, the typed needs a successor would consume and the exact `p2o_goal_author` create shape. The
planner must reconstruct all of it (the measured rounds show it re-deriving ids) while a round is already expensive, so the
cheapest action it finds is another review. That is a host gap, not a model failure: the host owns every field of the
recipe, and an un-reconstructed recipe is the measured reason the primitive stays a debt row.

### 2.2 S2 — The link is authored after the successor's brief was sent

In run A the successor task (`task-f3284c98…`) was created at 03:49Z and the link that names it was authored at 04:28Z — 39
minutes later, in the resumed session. A2's matcher (`src/chain-brief.ts:60-84`) identifies the step from a plan row that
lists the task, a ready step whose providers the task cites, or the step whose claim the task cites; by the time the link
existed, that brief was a retained record. Nothing in the host made link-before-task the cheap order: a create that cites a
demonstrated claim succeeds and dispatches whether or not a link names it, and the later link cannot reach a sent brief.
No live run has ever read `CHAIN`/`CHAIN PATH`/`NEXT LINK`; the mechanism is unit-tested, the cadence is not enforced.

### 2.3 S3 — The bookkeeping tax crowds out the next link

Run B's six rounds are dominated by derivations the host could answer: the goal-proof rule for a run without a recorded
operator policy (the campaign block's "with a recorded operator policy a coverage-plan proof needs a terminal cell under it;
without one the measurable proof is mapping") cost steps in the first planning turn; the cold-start `TASK_UNMAPPED` gap has
no stated exception, so the planner reasoned about a task that can never gain a work identity; `GAP_UNTRIAGED` debt ids are
hash-suffixed (`src/debt.ts:95-97`) and the planner tried to derive them instead of using the mapping; the case-acceptance
refusal `confirmed-verdict-lacks-current-tested-claim` (`src/cases.ts:128`) only says "Fix the listed reasons and revise
again" (`src/cases.ts:216`), so the planner spent a round rediscovering which candidate to cite. Each item is small; together
they consumed the rounds in which the four demonstrated primitives could have been chained.

### 2.4 S4 — The coverage result cannot be read when it closes

The measured call and its failure are in §0: the coverage view's page budget ignores the frame, and the whole result is then
refused by a second bound. The failure lands exactly when the planner closes a plan and needs to read its own denominator, so
the host removes the one read that would let the next round plan coverage-derived work; the refusal text names nothing the
planner can do next. This is the only defect in the measurement that is a pure bound-composition bug, not a behaviour
choice.

### 2.5 S5 — Mechanism versus behaviour

A1/A3/A4 carry hermetic evidence in `docs/ACCEPTANCE_MATRIX.md` and held in both runs' read paths: run A authored a branch
link from a demonstrated claim with `chainOf`/`step`/`effect` exactly as A4 teaches, and the report rendered plan chains and
counted `PRIMITIVE_UNCHAINED` correctly. A2 has unit evidence only, because no successor was ever dispatched after a link.
The missing quantity is not another chain representation; it is the cadence that lets the existing representation reach a
brief, plus the bookkeeping that currently outcompetes it.

## 3. What the A5 measurement changes about P22

- A1's branching rule worked on a live run: the link cited a demonstrated claim, named its typed need and its target effect,
  and the readiness row appeared. The chain vocabulary is therefore not the bottleneck, and P23 adds none.
- A2 is untriggered, not broken: no successor was dispatched after a link existed. A fixture where the link already exists
  cannot observe the cadence defect, which is why B3 tests the order rather than the render.
- A3/A4 read-side output was exercised indirectly (the run-B report printed plan chains and counted the unchained
  primitives); no new projection is needed.
- The measured defects are a read bound (S4) and id/next-verb derivations (S3), not chain semantics. So the next package is
  activation and economy, not a bigger chain model.

## 4. Decisions

- **D-P23-1 — A5 is closed by measurement.** Both runs are recorded in §10 and the HISTORY row; the absence of a fresh-run
  chain row is the finding the P22 acceptance bar allowed, and it is the input to this plan. A5 is not re-opened; its one
  new defect becomes B1 (A5-fix-5).
- **D-P23-2 — Activation, not representation.** No new chain store, tool, role, verb, loadout or authority. Every fact B1–B4
  adds is derived on read or host-printed text, labelled as such, and can never satisfy a claim, case, cell or goal.
- **D-P23-3 — The host names the next authoring call.** For every demonstrated primitive the debt/brief line carries the
  claim slug and retained id, the gained capability, the surface and the exact create shape (`chainOf`, `step`, `claimRefs`,
  `needs`, optional `effect` from the P22/A4 table) plus the wall alternative. It is bounded, it never authorizes or
  dispatches, and it is rendered only from records the run owns.
- **D-P23-4 — Link-before-dispatch is advisory, not enforced.** A task create that cites a demonstrated primitive no link
  consumes returns a bounded `chainHint` naming the link to author first and the order to re-dispatch; the create is not
  refused, because the validation replay path also cites claims and breadth must stay possible. A link authored after its
  successor was dispatched records `CHAIN_LINK_AFTER_DISPATCH` as a measured lifecycle fact, so the cadence is observable
  without enforcing it.
- **D-P23-5 — Every bookkeeping fix removes a host-derivable fact.** None may weaken review, widen scope or hide a gap; a
  prompt rewording with no measured host line is not a fix.
- **D-P23-6 — A2 live evidence is read from the dispatched worker's own brief.** B5 acceptance is checked in the first user
  message of that worker's session log (and cross-checked against the store's task/link records), never in the planner's
  narration of it.
- **D-P23-7 — Live measurement stays assess-mode and read-only.** `https://ise.uit.edu.vn/` is authorized by the owner; each
  measurement run uses workers 2, target-ops 2, round-steps 30 and ≤90 minutes, starts from a fresh scratch cwd with a
  verified working planner model, is stopped cleanly and keeps its deterministic report. No exploit-mode run against the
  live target (inherits D-P22-7).
- **D-P23-8 — Gates, docs truth and repo hygiene are unchanged from P22.** tsc, focused tests, full suite, build and
  `check:build`, surface audit, `validate_library.py`, `git diff --check`, GitNexus impact before an edit and
  `detect_changes` before a commit; matrix F-P23-* rows, a HISTORY row and USAGE/PLANNER_ENGINE text land with the tranche;
  commit and push only on a fresh owner instruction, with the repository identity and no attribution (inherits D-P22-8,
  D-P22-9).
- **D-P23-9 — The P22 plan is retired.** This file is the only plan of record; the P22 revision stays recoverable at
  `4aa1e05` and in the HISTORY/matrix rows that describe it.

## 5. Package B — chain activation

Goal: on one live assess run, a demonstrated primitive becomes an authored successor link and then a dispatched task whose
brief names that link — without a new authority, store or tool.

### B1 — Close A5's record and make the coverage view readable at close (A5-fix-5)

- **Where:** `docs/ACCEPTANCE_MATRIX.md` (new F-P22-A5 row), `docs/HISTORY.md` (A5 measurement row), §10/§12 here; code in
  `src/counts.ts` (`counted`) and the coverage view branch of `extensions/p2o/index.ts` (`executeCoverageAction` view,
  `boundedResult`); new test `tests/minimal/coverage-view-bound.test.ts`.
- **What:** (1) record both runs with their numbers, the defect list and the A5-fix-1..4 outcome — measurement only, no new
  claims about the target. (2) Fix the bound composition: the coverage view passes the encoded frame size into the page
  budget (`bytes: 24*1024 - frameBytes - slack`), keeps `total`/`shown`/`omitted`/`nextCursor` truthful, and when the frame
  alone cannot fit returns a bounded summary that names the remedy instead of a bare refusal; a plan view never silently
  truncates. No schema, tool declaration or ledger shape change.
- **Tests:** a plan whose eight derived cells plus frame exceed 24 KiB returns a page inside the bound with truthful
  counters and a cursor walk that reaches every cell; a frame that alone cannot fit returns the bounded summary naming the
  remedy; the ordinary coverage view is byte-identical when it already fits.
- **Acceptance:** the measured call shape from run B (`board=coverage`, `id=<plan>`, `limit=10`, `cursor=0`) returns a page
  instead of a refusal, totals are unchanged, and the hermetic test reproduces the shape red then green.

### B2 — A demonstrated primitive carries its authoring recipe

- **Where:** `src/debt.ts` (per-primitive detail and order), `src/completion.ts` and `src/situation.ts` demand lines,
  `src/round-brief.ts` debt render, `src/effects.ts` (reused, not extended) and `tests/minimal/chain-demand.test.ts`.
- **What:** for each `PRIMITIVE_UNCHAINED`, the reported line carries the claim slug and retained record id, the capability
  gained, the surface, and the exact create shape: `p2o_goal_author` todo with `chainOf`, `step` (1 for a new branch, or the
  next index when extending), `claimRefs: [<record id>]`, `needs` derived from what the successor consumes, and `effect` when
  `src/effects.ts` suggests one; the wall alternative prints the deferred-todo shape with its debt ref and revisit condition.
  The line is bounded per primitive and in total (omission counted), and it never authorizes, dispatches or satisfies.
- **Tests:** a confirmed+tested claim with a gained capability prints the recipe with real ids and typed needs; a claim with
  no gained capability prints the wall recipe; ten primitives stay bounded with the omission count; a plan row created from
  the recipe is accepted by `validatePlanDraft` and makes no step ready by itself.
- **Acceptance:** reconstructing run A's primitive prints `media-upload-read`, `3564fa4c…` and `data.read` inside the bound;
  the create shape round-trips through the planner schema; no auto-dispatch and no auto-authoring.

### B3 — The link comes before the brief (cadence)

- **Where:** the task-create path (`p2o_task_author`) and link-write path (`p2o_goal_author` create/revise) in
  `extensions/p2o/index.ts`, plus a recorded lifecycle fact; test `tests/minimal/chain-cadence.test.ts`.
- **What:** when an intent task is created with `work.claimRefs` citing one or more demonstrated primitives that no current
  plan row consumes, the create response carries a bounded `chainHint` naming the link to author first and the order to
  dispatch; the create is not refused (validation replays and breadth stay legal). When a link later names a claim whose
  successor task was already dispatched, the host records `CHAIN_LINK_AFTER_DISPATCH` with the task, link and dispatch
  sequence. No auto-authoring, no auto-dispatch, no authority.
- **Tests:** link first → no hint; task first → hint present, dispatch succeeds and the later link records the fact; a
  validation task citing a claim is exempt; a task citing an open (undemonstrated) claim gets no hint; the hint is bounded
  and names ids.
- **Acceptance:** a hermetic flow shows A2-shaped brief data is reachable only when the link precedes the task, and the
  host's own record proves the cadence when it did not (the fact exists).

### B4 — Remove the measured derivations (bookkeeping tax)

- **Where:** `src/debt.ts` (ids and details), `src/planning.ts` (`debtRefs` validation), `src/round-brief.ts` render,
  `src/cases.ts:128,216`; test `tests/minimal/bookkeeping-tax.test.ts`.
- **What:** (a) cold start — when the campaign had no asset at task creation, the `TASK_UNMAPPED` detail says this is the
  expected cold-start exception and names the remedy (map the discovered assets with the next task; record the coverage-plan
  exclusion); with assets present the existing detail stands. (b) `GAP_UNTRIAGED` — `debtRefs` accepts either the debt id or
  its subject id (the gap/case/task id the line names), resolved host-side through the existing `debtId` rule, and the brief
  prints the `subject → debtRef` mapping beside the gap. (c) case acceptance — the
  `confirmed-verdict-lacks-current-tested-claim` refusal names the current tested candidate(s) the case could cite (record id
  and slug) and the taskRefs path, bounded, like a stale revision's legal next; strictness is unchanged.
- **Tests:** the cold-start detail appears only when the host can prove no asset existed at creation; a deferred todo citing
  the gap subject id discharges the same item as its debt id and an unrelated id still fails; the case refusal names the id
  that accepts it while an inferred-basis claim stays refused.
- **Acceptance:** each of the three measured error lines names its remedy with real ids; no review, ladder or authority rule
  changes.

### B5 — The live activation measurement

- **What:** one fresh assess-mode run from a scratch cwd on the build of record (B1–B4 landed), started with a verified
  working planner model and the D-P23-7 budget, stopped cleanly after the chain activity is observable or the budget is
  spent. Read in this order: the store (`$.data.plan.chainOf` rows, the successor task and its dispatch sequence, any
  `CHAIN_LINK_AFTER_DISPATCH` fact), the dispatched worker's session brief (its first user message), and the deterministic
  report (`PRIMITIVE_UNCHAINED`, `## Attack path`).
- **Acceptance (§7):** ≥1 chain row authored from a demonstrated primitive; ≥1 successor task authored **after** the link and
  dispatched; that worker's brief contains `CHAIN`/`CHAIN PATH`/`NEXT LINK` with the right id, step and state; at least one
  demonstrated primitive is chained or walled in the ledger (so `PRIMITIVE_UNCHAINED` falls below the demonstrated-claim
  count); no stale-context, retention or storage defect; run id, budget, numbers and the brief excerpt written into §10 and
  the HISTORY row.
- **If the run again authors no chain row:** that absence is the recorded finding, S1/S3 are re-diagnosed from the new
  evidence, and no success is invented.

## 5b. Package C — weaponization (owner scope C, recorded 2026-10-30)

The owner's second instruction the same day was "bắt đầu vơi B1 và weaponization, vì cách phòng thủ tốt nhất là tấn công."
Asked what weaponization means here, the owner chose **C: an exploit-mode run against `https://ise.uit.edu.vn/`**, said the
owner supplies the lab/VM, and said the written authorization exists. This package therefore turns the previous hard
non-goal ("no exploit-mode run against the live target") into a gated tranche. It does not widen Package B: B still adds no
authority and still claims no effect.

### C1 — File the authorization and fix the run scope (no target traffic)

- **Where:** §12 here (the authorization record), §13 (the exact start line), `docs/ACCEPTANCE_MATRIX.md` F-P23-C1 row. No
  code unless a hermetic test or the C2 run proves a gap.
- **What:** record the written authorization the owner holds: document reference (file name/id or mail subject and date),
  issuer and the authority they act for, validity window, in-scope hosts/routes (`https://ise.uit.edu.vn/` and nothing
  else), the permitted methods and `--effect` classes, the prohibitions listed below, and the owner's per-run confirmation.
  Write the exact exploit-mode start line and the evidence to read afterwards. If the document cannot be cited, C1 stays
  incomplete and C2 does not run — a verbal scope does not substitute.
- **Acceptance:** every field above is filled from the owner's document, not inferred, and the run line names the same host,
  methods and effect classes.

### C2 — The authorized exploit run (live, owner-present)

- **Where:** one run started by the C1 line; no code change expected. A measured defect becomes its own tranche with a
  hermetic test before any second run (the A5-fix pattern).
- **What:** a fresh exploit-mode run inside the C1 scope. The chain layer must show, in the store and the report: a
  demonstrated primitive; a successor link authored from it; a successor task authored after the link and dispatched with the
  three A2 lines; the worker executes that link's effect step on the authorized target through the existing lab/target tools,
  with the receipt and the effect verdict recorded; `## Attack path` prints an executed step, not "not executed". Stop on the
  first action that would leave the C1 record, on a measured defect, or at the D-P23-7 budget.
- **Acceptance:** ≥1 executed chain step with evidence and an effect verdict; the successor brief carries `CHAIN`/`CHAIN
  PATH`/`NEXT LINK` with the right ids; nothing outside the C1 scope was touched; clean stop and report; authorization
  reference, run id and numbers in §10 and HISTORY. If the run ends without an executed effect, that absence is the finding
  and no capability claim is made.

**C's own non-goals (refusal conditions, not advice):** no destructive or availability-impacting action; no persistence; no
credential theft beyond the owner-designated test account; no lateral movement off the in-scope hosts; no bulk user-data
access; no evasion or anti-forensics work; no run before the C1 record exists.

## 6. Sequence and gates

Order: B1 (landed: docs + A5-fix-5, no live run) → C1 (authorization record, no target traffic) → B2/B3/B4 (hermetic;
may land as one phase) → B5 (assess live run) → C2 (authorized exploit live run). C2 may move before B5 if the owner prefers;
it then measures the same activation under exploit mode and any gap it exposes feeds B2–B4 first. Every tranche:

1. `npx tsc --noEmit`, the focused vitest files, then the full hermetic suite (`npx vitest run`);
2. `npm run build` and `npm run check:build`; `node scripts/audit-surface.mjs` (registered/model-visible/hidden/board counts
   and contradictions must not move; declarations may not pass their baselines — re-pin only from a fresh measurement);
3. `python3 scripts/validate_library.py` when documents change; prompt/brief ceilings re-measured wherever teaching text
   moves;
4. `git diff --check`, GitNexus `detect_changes --scope all` before any commit, `git status` audited (never stage the
   owner's `AGENTS.md` edit or `pi-p2o-defense-vi.pptx`);
5. docs rows in the same change: `docs/ACCEPTANCE_MATRIX.md` F-P23-*, a `docs/HISTORY.md` row, and USAGE/PLANNER_ENGINE text
   where model-facing behaviour changed;
6. commit and push only on a fresh owner instruction, with the repository identity and no attribution lines.

## 7. Acceptance bars (mechanism, not pentest effectiveness)

- **B1:** the measured refusal becomes a page; counters stay truthful; a frame-only overflow names its remedy; nothing is
  silently truncated.
- **B2:** every demonstrated primitive's line carries its slug, retained id, gained capability and the authoring call or the
  wall alternative, inside the measured bound; a plan row created from it passes the planner schema and makes no step ready
  by itself.
- **B3:** a hermetic flow proves the hint/record sequence for link-first and task-first; the validation path is exempt; the
  host never auto-authors or auto-dispatches.
- **B4:** the three measured lines name their remedy with real ids; review, ladder and authority rules are unchanged.
- **B5:** one live assess run shows a link authored from a demonstrated primitive, a successor authored after the link and
  dispatched, and that worker's brief carrying the three chain lines; at least one primitive chained or walled; no
  stale-context, retention or storage defect. One host, one planner, one run — a mechanism observation, not a capability
  claim.
- **C1:** the §12 record names the document, issuer, dates, host, methods/effect classes and prohibitions, and the §13 line
  matches it; no target traffic while C1 is incomplete.
- **C2:** one authorized exploit run executes at least one chain step on the recorded target with evidence and an effect
  verdict, the successor brief carries the three chain lines, nothing leaves the C1 scope, and the run stops cleanly. One
  target under one authorization — an observation, never a claim of general effectiveness.
- Never a claim about real-world effectiveness: assess mode demonstrates no effect, and the report still says an assessment
  is not a safety statement.

## 8. Non-goals and refusals

- No new tool, role, verb, loadout, authority, finding kind or second attack-path store; no schema mutation (additive
  optional fields only, and only if a hermetic test needs one).
- No auto-dispatch and no auto-authoring: the host names the next call, the planner makes it; a hint is never a command.
- No hard refusal of a task that cites a demonstrated claim (advisory only); the validation replay path and breadth stay
  legal.
- No exploit-mode run before C1's authorization record is filed in §12 and the owner confirms that run; no host outside the
  record, no destructive or availability-impacting action, no persistence, no credential theft beyond the designated test
  account, no lateral movement, no bulk user-data access (Package C's refusal conditions).
- No lowering of the evidence ladder, depth ladder, rating ceiling, case review or coverage derivation to make activation
  easier to observe.
- No prompt-only "fix" without a measured host line; no success claim from a run that wrote no chain row.

## 9. Risks

- **B3's hint becomes noise or blocks breadth.** It is advisory and validation-exempt, bounded, and tested for both the
  task-first and link-first shapes; the create is never refused.
- **B2's recipe grows the brief.** Per-primitive and total bounds are measured, omissions are counted, and the field set is
  derived only from records the run already holds.
- **The cold-start wording hides a real gap.** The exception is printed only when the host can prove no asset existed at
  creation; otherwise the ordinary `TASK_UNMAPPED` detail stands and the gap is not laundered.
- **The coverage-view fix trades a refusal for silent truncation.** Counters, cursor and an explicit remedy keep the read
  honest, and the boundary test pins both sides.
- **The live run is expensive or slow.** Budget per D-P23-7, stop at evidence, and verify a working planner model before
  starting (the deepseek 402 is a known provider state, not a p2o failure).
- **Assess mode may not demonstrate a primitive worth chaining.** Activation is measured on the closest legal shape a
  `data.read`-class primitive allows; the absence is allowed as a finding.
- **Debt-subject acceptance widens what a wall may cite.** It is bookkeeping resolution only (no authority), and the test
  pins that an unrelated id still fails.
- **C's authorization is mis-scoped or assumed.** C1 records issuer, dates, hosts, methods and prohibitions before any
  traffic, and the runbook stops on the first step that would leave them; a verbal scope never substitutes for the record.
- **An exploit run damages the target or its users.** C2 prohibits destructive, availability, persistence, lateral and
  bulk-data actions, and every step stays inside the written methods; the owner is present for the run.
- **A weaponization run is read as a capability claim.** It is one target under one authorization; the report and this plan
  claim no general effectiveness and still print the assessment boundary.

## 10. Verification record (to be filled as tranches land)

| Tranche | Date | Commit | Commands and results | Not done / next |
|---|---|---|---|---|
| A5 (P22 closure) | 2026-10-30 | docs record (this file; no code change) | Measurement delivered, no code delta. Run A `run-51d84fce…` (assess, 2 workers/target-ops 2, digest `b590bdff…` = A5-fix-1..3 build): 291 records / 1,024 events, 4 claim records, 26 coverage judgments, 1 case awaiting review (confirmed/pending, rated informational), coverage plan active at r5; **2 chain rows** authored in the resumed rounds (`media-upload-read` step 1 with `effect: confidentiality-read` and claim `3564fa4c…`; readiness row `chain-3c3dd3c8dd03` step 1); **0 A2 lines** because the successor task predates the link by 39 min; the run ended on a provider 402 (deepseek balance), not a p2o defect. Run B `run-06fde84d…` (assess, 2 workers/target-ops 2/round-steps 30, digest `425dea875f4a` = A5-fix-4 build): 1 h 46 min, 6 rounds (event 3, debt 1, heartbeat 2), 335 records / 1,072 events, 74 worker target ops, 6 tasks (1 recon + 1 discovery + 4 validation) all reviewed, 9 worker claims, coverage plan closed 8/8 cells tested, 67 unplanned assets, 45 open gaps, 4 cases awaiting review / 0 accepted, **0 chain rows, 0 A2 lines**; report debt at stop `PRIMITIVE_UNCHAINED 4`, `RESEARCH_DEBT 52`, `GRAPH_UNREVIEWED 1`; no stale-context crash (fix-4 held across three session replacements), no retention/storage defect, clean stop and report. One new defect measured: coverage view >24 KiB refusal (§0/S4) → A5-fix-5 in B1. P22/A5 acceptance satisfied: a run is written down, the absence of chain activity is the recorded finding, and the previously measured defects (A5-fix-1..4) already landed with hermetic tests | A5-fix-5 in B1; then B2–B5 |
| B1 | 2026-10-30 | local commit (this change) | A5-fix-5 landed: `coverageView` budgets the page against `24 KiB − frame − 256`, keeps the count pair and `nextCursor` truthful, and returns a bounded summary + remedy when the frame alone cannot carry a cell; `tests/minimal/coverage-view-bound.test.ts` reproduces the measured refusal red, then green. Full suite 168 passed / 5 skipped files (173), 1,485 passed / 13 skipped tests (1,498), 0 fail; `npx tsc --noEmit`, `npm run build` and `check:build` green; surface audit 35 registered / 35 model-visible / 0 hidden / 10 board verbs, 0 contradictions, declarations unchanged (planner 45,049; worker 40,935; validation 40,124; reporting 6,282); `validate_library.py` PASS 336; GitNexus impact `executeCoverageAction` LOW (2 direct callers) before the edit; index refreshed, then `detect_changes --scope all`: 5 files / 41 changed symbols / 7 affected processes (all on the coverage read path), risk high from the `registerP2O` hub, no non-coverage process moved; `git diff --check` clean for this pass; no live run and no target traffic | C1 then B2–B5 |
| C1 | — | — | — | pending: owner documents the authorization (document reference, issuer, dates, host, methods/effects, prohibitions) |
| B2 | — | — | — | planned |
| B3 | — | — | — | planned |
| B4 | — | — | — | planned |
| B5 | — | — | — | planned |
| C2 | — | — | — | blocked on C1; may run before or after B5 |

## 11. Owner decisions recorded (answered in chat, 2026-10-30)

1. **Package B (chain activation) and A5 closure.** The owner chose option A: record the A5 measurement, fix the measured
   defect (A5-fix-5), and make the chain layer actually fire in a live assess run rather than adding a new chain model.
2. **Measurement channel.** A repeated assess-mode live run on `https://ise.uit.edu.vn/` is the channel; no exploit-mode run
   against the live target.
3. **Docs and commit.** The plan replacement, the A5 record and the matrix/HISTORY rows are written now and committed locally
   on this instruction; push happens only on a separate owner instruction.
4. **Inherited decisions.** The target is authorized for assess-mode runs; provider cost is the owner's; the planner holds
   no target tool; commit/push remain owner-initiated; `AGENTS.md` rules on attribution and the owner's uncommitted files
   stand.
5. **Provider state.** The deepseek account was empty on 2026-10-30 (HTTP 402); live runs must set a verified working planner
   model. `opencode-go` served the workers and the successful run; the exact model choice is an operator decision per run.
6. **Weaponization (Package C).** Asked after the B1 instruction, the owner scoped weaponization as option C — an
   exploit-mode run against `https://ise.uit.edu.vn/` — said the owner supplies the lab/VM, and said the written
   authorization exists. Package C was added with C1 filing that authorization and C2 the run; until C1 is filed, no exploit
   traffic is sent, and no target outside the record is touched.
7. **B1 commit.** The owner approved committing B1 locally once the gates are green; push stays on a separate instruction.

## 12. Evidence and reproduction

- **Run A:** `~/tmp/p2o-live-a5/.p2o-state/run-51d84fce-b16f-4a68-8e14-e9170cebd455/assessment.sqlite` and its artifacts;
  sessions under `~/.pi/agent/sessions/--home-nhanlaptop-tmp-p2o-live-a5--/`. The chain rows are the `note` records with
  `data.plan.chainOf`; the final planner session that hit the 402 is the `01a18b14…` session log.
- **Run B:** `~/tmp/p2o-live-run2/.p2o-state/run-06fde84d-6b26-48b7-a8a2-494e9df8a70c/assessment.sqlite`; report at
  `~/tmp/p2o-live-run2/.p2o-reports/report-run-06fde84d-6b26-48b7-a8a2-494e9df8a70c-final/` (`REPORT.md`, `cases.csv`,
  `coverage.csv`, `findings.json`); worker and round session logs under
  `~/.pi/agent/sessions/--home-nhanlaptop-tmp-p2o-live-run2--/`.
- **Measurement queries used:** `select body from records where body like '%chainOf%'` then read
  `$.data.plan.chainOf/step/effect/claimRefs/needs`; `select kind,count(*) from records group by kind`; grep worker session
  logs for `CHAIN PATH|NEXT LINK`; the report's `PRIMITIVE_UNCHAINED` row and the store's `manifest` for the runtime digest.
- **P22 revision:** `git show 4aa1e05:planning_update.md`; its F-P22-* matrix rows and HISTORY rows remain the P22 record.
- **Authorization for Package C (to be filed in C1):** document reference, issuer and authority, validity window, in-scope
  hosts (`https://ise.uit.edu.vn/` only), permitted methods and `--effect` classes, prohibitions, owner per-run confirmation.
  Not yet filed as of this plan revision: the owner holds the document and C2 stays blocked until it is written here.
- **Code anchors quoted in §2:** `src/debt.ts:95-97,156,180,194,268`; `src/completion.ts:18,46,71,93`;
  `src/prompts.ts:182,190,192`; `src/chain-brief.ts:60-84`; `src/chain-board.ts:72`; `src/counts.ts:44-53`;
  `extensions/p2o/index.ts:291-292` and the coverage view branch; `src/cases.ts:128,216`; `src/planning.ts:114-115`.

## 13. Appendix — live-run runbook (B5)

Run from a scratch cwd so the durable store and the report do not land in the repository, and never in the cwd of a paused
run (its writer lock is held):

```bash
mkdir -p ~/tmp/p2o-live-<name> && cd ~/tmp/p2o-live-<name>
pi --model opencode-go/deepseek-v4-pro        # any verified working provider/model; workers keep their p2o.roles model
```

In the TUI (the operator confirms the single consent dialog; the agent does not confirm it on the owner's behalf):

```text
/p2o --target https://ise.uit.edu.vn/ --mode assess --goal "Map the external attack surface of ise.uit.edu.vn: reachable services, exposed routes, authentication boundaries and exposure gaps, each with recorded evidence" --workers 2 --target-ops 2 --round-steps 30 --export
```

Check the consent preview prints the expected runtime digest (the build under test; `425dea875f4a` for the A5-fix-4
generation) before confirming. While it runs: `/p2o status`, `/p2o digest`, `/p2o report`; do not send other prompts into a
round session. `/p2o pause` then `/p2o stop` stops scheduling and ends the run cleanly; the stop is an evidence-preserving
transition with fixed bounds (a 30 s round settle, a 90 s worker-report drain, then pane/container teardown), so it can take
minutes for a run with several worker panes — a second `/p2o stop` is idempotent, not required.

Read, in this order: `.p2o-state/<runId>/assessment.sqlite` (records, `$.data.plan.chainOf` rows, tasks and their dispatch
sequence, claims), the dispatched successor's session log (its first user message is the brief; check the three A2 lines),
and `.p2o-reports/report-<runId>-final/REPORT.md` (`PRIMITIVE_UNCHAINED`, `## Attack path`, coverage section). Record the run
id, cwd, budget, digest and the numbers in §10 and the HISTORY row; if the run authored no chain row, record that as the
finding rather than re-running until it looks right.

### C2 — authorized exploit run (only after C1 is filed)

Same scratch-cwd rule and the same single consent dialog. The start line is the one C1 records, shaped like:

```text
/p2o --target https://ise.uit.edu.vn/ --mode exploit --effect <recorded classes> --goal "<recorded objective>" --workers 2 --target-ops <recorded> --round-steps <recorded> --export
```

Check the consent preview prints the runtime digest and the authorized effect classes before confirming. Stop immediately if a
step would leave the C1 record (host, method, effect or action), if the target shows instability, or at the D-P23-7 budget.
Read: `.p2o-state/<runId>/assessment.sqlite` (chain link rows, the successor task and its dispatch sequence, receipts and
effect verdicts), the successor worker's first user message (the three A2 lines), and `REPORT.md` (`## Attack path` must print
the executed step). Record the authorization reference, run id, numbers and any refusal in §10 and HISTORY; a run that ends
without an executed effect is recorded as the finding, never re-run until it looks right.
