# Planner / Engine contract

How the planner's decisions become scheduled, attributable work. The system map is [ARCHITECTURE](ARCHITECTURE.md); this
page is the operator-facing contract for tasks, rounds and the plan board.

## Controls and defaults

```text
/p2o --target ./source --workers 3
/p2o --target ./source --workers 3 --round-steps 25 --round-seconds 600 --executors isolated --target-ops 2 --export
/p2o pause    /p2o resume    /p2o stop
```

- Defaults are the automatic loop (the manual loop was removed by P18/D48), `shared` executor, 3 model slots, and a
  40-step / 900-second round budget. Without Herdr a run refuses to start: the planner holds no target tools, so there is no
  manual fallback for target work.
- `--workers N` caps concurrent model slots; `--target-ops N` caps concurrent target operations. `--max-depth` is kept for
  compatibility only: workers propose tasks and never spawn children.
- Automatic planner rounds are extra requests to the existing model. The campaign has **no round ceiling**; each round is
  bounded by the round budget instead, so a long campaign becomes many bounded rounds rather than one growing conversation.
  Each round opens in a fresh Pi session by default (P18/D45) and can be routed to a base or escalation model and thinking
  level through `p2o.plannerModels` (P18/D50); `/p2o status` names the round in flight.
  Two quietly unproductive rounds, or the operator, end a run. There is no command spend limit either: the broker counts every
  admitted target command for the ledger and refuses none.
- Settings live under `p2o` in `~/.pi/agent/settings.json`: `maxWorkers`, `plannerRound`, `plannerModels`, `executorMode`,
  `maxTargetOperations`, `roles.<role>.model` and the rest of the list in [USAGE](USAGE.md). Precedence is CLI → settings →
  default for a new run; bad CLI values are rejected, bad settings fall back.

## Who does what

- **Planner — the current Pi conversation.** Chooses bounded directions, writes the question and stop condition, reviews
  evidence, dispatches, steers or withdraws, decides `wait` / `blocked` / finish. It has no target, lab or claim tool in any
  mode.
- **Engine — deterministic TypeScript, no model.** Admits accepted work when a slot and reviewed prerequisites allow, owns
  executors, coalesces committed signals and guards extra rounds. It never invents work; an empty frontier with unmet goals
  is explained, not silently dropped.
- **Worker — a fresh Pi process in a visible pane.** Runs one intent with its own ticket and context, is the only executor
  and the only author of a claim, note or surface record, and reports attributed observations and gaps.
- **Reporter — a read-only second reader.** Reads an accepted case, its evidence and artifacts and writes the report; no
  target, lab or claim tool.

## Tasks are intents

`p2o_task_author` stores an intent, not a work order: no `id` creates one, `id`+`revision` revises the existing one. The planner
says what it wants to learn (question, surface, risk, role, and optionally a structured `work` identity), and the host derives
the rest in the same canonicalize-and-anchor step for both halves:

| Field | Derived from | Value |
|---|---|---|
| `work.purpose` | role when omitted | recon→mapping, discovery→discovery, validation→validation, exploit→exploitation, reporting→reporting, else investigation |
| `outputContract` | purpose | fixed shape (mapping→assets/evidence/gaps, discovery→candidates/evidence/controls, validation→evidence/controls/gaps, reporting→coverage/gaps, …) |
| `decision` | the anchors the `entry` names | `new` by default, `validate` with `validationOf`, `refine` with a prior task; retest and unanchored refinement need it stated |

`create` also runs the duplicate/history preflight on that identity, so an exact active or reusable attempt comes back as a
match payload instead of a second task (`already_covered_by`, `reuse_candidates`, `partial`, `overlaps`). Limiting the `entry`
to the question is the intended path; prose entries without `work` are a legacy tail.

**The first intent of a run is always legal:** it is recon/mapping, which needs nothing earlier to cite. A validation in that
position is refused in both shapes (`PURPOSE_NEEDS_PREDECESSOR`, `legalNext: create a recon task first`), and so is a first
structured discovery/exploitation/chaining/retest. After recon the anchor rules apply:

| Purpose | Required anchor |
|---|---|
| mapping, reporting | none |
| discovery | a worker claim in `work.claimRefs`, or a pinned prerequisite reviewed before the task runs |
| exploitation | `work.claimRefs` of a demonstrated claim |
| chaining | two composed claims |
| investigation, refinement | a claim, a pinned asset revision, or a prior task |
| validation, retest | `validationOf` (a reviewed task ID or a worker claim ID) |

`validationOf` accepts a worker claim because the host stamped `data.taskRef` on it: the host resolves the claim to its
discovery task, pins the reviewed revision, rewrites the link and derives `decision=validate`. A validation is never
revalidated, and each confirmed+tested claim produces exactly one host-created validation task. `p2o_candidate` is
worker-only: a planner call is refused with `WORKER_ONLY` and a legal next.

Dispatch is the only way work starts: `p2o_task_dispatch {ids:[…]}` accepts 1–25 proposed tasks and the Engine spawns each
worker when capacity and reviewed prerequisites allow (queue: 100 accepted intents, priority then insertion order). A
`revise` that keeps the question, role, workload identity and refs keeps its queue slot; one that changes them invalidates
the entry and needs a new dispatch. A dispatch with no executor is refused (`DELEGATION_UNAVAILABLE`), and a failure after
reserve moves the task to `blocked` with the missing prerequisite — never a planner execution path.

## Plan board: goals, todos, decisions

Goals, todos and decisions are records on one plan board (`p2o_goal_author` creates with no `id` and revises with
`id`+`revision`; `p2o_board board=plans` reads it),
not a second task queue.

- A goal is a promise about the target and needs proof: `GOAL_UNPROVEN` unless it names a `capability` (a confirmed+tested
  claim that gained it), a `case` (accepted, confirmed, current) or a `coverage` plan whose remaining cells are terminal.
  The same resolver runs on the board and in derived completion, so a goal cannot be settled in one and unproven in the other.
- Decisions (`new|reuse|refine|validate|retest|defer`) record direction; they do not dispatch. Todos carry advisory criteria
  and exclusions, never a completion gate. Closing a goal needs an explicit revision and its proof must still hold.
- Every mutation is idempotent by `(run, actor, requestId)`: the same payload returns the original acknowledgement, a
  different payload is `IDEMPOTENCY_CONFLICT`.

## Coverage is a projection

The host derives every coverage cell from committed work — a reviewed task with `work.assetRefs`, the worker claim stamped
with that task, the accepted case and the pinned graph asset revision — and re-derives it on each read for the board, the
report, the situation line, goal proof and the finish preflight. `p2o_coverage_plan` writes scope only (title, exclusions,
unknown scope, review state); no model authors a cell. A task without an asset is an `unmapped` gap, never a clean cell.
Details, state table and legacy plans: [EVIDENCE](EVIDENCE.md).

## Chain board and frontier

An exploitation chain lives on the plan board: each step is a todo with `chainOf`, `step` (1-based, no maximum),
`claimRefs` (the claims it stands on), `needs` (typed capabilities it consumes) and an optional `environmentRef`.
`p2o_graph_plan {action:"chain", plan:true}` writes exactly those rows (done steps as `done`, the next as `open`) and returns
the `entry` for the deepest ready step. Readiness is derived, not stored: a step is ready when every `needs` capability is gained
by a confirmed+tested claim that an earlier step of the same chain cites. `p2o_board board=plans` prints one line per chain:

```text
chain <id> 2/4 · next: step 3 (ready) · waiting on: http.request (internal-api)
```

Frontier obligations are enforced where work is opened, not at finish: `p2o_task_author` refuses a new direction on a
surface that has a ready, undispatched chain step (`CHAIN_READY_UNDISPATCHED`) or a confirmed+tested claim nothing consumes
(`PRIMITIVE_UNCHAINED`), unless the `entry` cites the provider or records a deferred/blocked row with a reason. The same
condition appears as a `REMAINING WORK` advisory, so "what is left" has one source. Cancelled or expired work never counts
as having consumed a claim.

## Rounds: sessions, budgets and demand

- A round is a bounded work package, not a transcript. By default each admitted round opens a fresh Pi session (P18/D45):
  the engine dispatches an internal `p2o-round` command with the wake it is about to deliver, the host replaces the session,
  and the round opening is the first user message there. When the host is streaming or holds queued operator input the round
  stays in the current session as a marked follow-up prompt and `planner.round-session-fallback` records why; the same wake
  is never dispatched twice.
- The round opening is deterministic and bounded (≤ 8 KiB): campaign frame, completion and demand, goals and proof, ready
  chain steps, workers, round facts, the previous round's delta and a digest of older records. The round's own records are the
  live window; everything before the previous opening folds into the digest instead of vanishing with the replaced session.
- Each engine round keeps monotonic counters (tested cells, confirmed claims, assets, chain depth) plus the host-computed
  `remaining` obligations. A round is **quiet** when all four counters fail to increase.
- Two quiet rounds with obligations left still get a wake that names the demand (ready step, unreviewed goal, …): the loop is
  not paused while work is owed. Two quiet rounds with nothing owed pause the campaign and say the completion state is
  `complete`.
- The budget bounds one round, never the campaign (P18/D47): 40 steps or 900 s by default, wrapping once at the last six
  steps, 90 % of the time axis or 80 % of the reported planner context, and a hard stop at 92 % context. A wrap switches the
  loadout to the closing set (no authoring, no dispatch) and injects one wrap-up directive, so the round writes back instead
  of starting work it cannot finish. A hard stop aborts the turn and settlement records
  `planner.round-end reason=round-budget`: a classified round end, not a failure and not a pause, so the next round opens
  normally. `--round-steps 0 --round-seconds 0` disables the step and time axes; the context axes stay.
- `/p2o stop` is an evidence-preserving transition, not a kill: the loop pauses (no new dispatch or wake), a round that is
  mid-turn settles for up to 30 s and closes as `planner.round-end reason=operator-stop` instead of being nudged onward, and
  live workers get up to 90 s to deliver the blocked report their own settle writes before the hard teardown runs. A round
  that misses the bound takes the hard stop.
- A round that ends without a single tool call while obligations remain gets up to two settlement nudges
  (`planner.round-nudge kind=settle`). The first demand-floor `wait` of a round while obligations remain is refused once with
  the demand, the legal next actions and `terminate:false`; the second is accepted (`kind=wait`). Both replace the removed
  manual mode (P18/D48) with a fixed shape instead of an unbounded polling turn.
- Per-round routing (P18/D50): when `p2o.plannerModels` names a base or escalation model and thinking level, the round is
  routed before its first turn — base for review/mapping/validation demand, escalation for exploitation/chaining, a ready
  chain step, an unchained primitive or two consecutive rounds that closed nothing. A model the host cannot resolve or set
  keeps the current loadout and records `planner.round-model-fallback`; routing never fails a round.
- A planner round that ends with an open goal, no open/running intent and no `blocked` declaration is recorded as one
  `planner.stalled` lifecycle fact — report material, never a wake, queue entry, pause or budget. Only engine-admitted rounds
  count, and only the message that ends the turn can stall (a tool-calling step is not a round). The escalation counter is a
  streak since the last `/p2o resume`, not a lifetime total; three stalled rounds plus gateable research debt pause and ask a
  human.
- `p2o_loop {action:'wait', reason:'block-decay'|'cooldown-expiry', notBefore}` records one decision and schedules exactly one
  revisit for that condition (future, within 24 h, one pending revisit per condition). `wait` ends a round, not the
  assessment; `blocked` pauses admission and wakes until the operator resumes.
- The loop is automatic: committed events, owed research debt and the campaign heartbeat wake a new round through Pi's
  normal message path with a marked extension-origin prompt, and only an admitted round can stall. A provider error pauses
  automatic wakes without retry; committed signals coalesce in a fixed 800 ms window, so a burst becomes one round.
- Every round lifecycle fact rides the existing `lifecycle` kind with `data.engine.event` (no schema bump):
  `planner.round-start`, `round-end` (`reason`: `round-budget`/`operator-stop`), `round-budget` (`state`: `wrap`/`exhausted`),
  `round-nudge` (`kind`: `settle`/`wait`), `round-session`, `round-model`, `round-model-fallback`, `round-session-fallback`,
  beside `planner.wake`, `planner.stalled` and `planner.stall-escalation`. `/p2o status` prints the round number, its
  session, the budget state, the routed model and the newest round fact.

## Priority suggestion

`src/priority.ts` derives a suggested 0–100 dispatch priority from recorded facts so triage order is explainable. It is a
suggestion only: the planner's explicit `priority` wins and nothing auto-dispatches by score. From a neutral 50: an unmet
reviewed prerequisite −30, validation/retest +15, a confirmed+tested claim already gains every needed capability +20, an
asset with an accepted finding +10, a non-stale cell that already answers the question −20, clamped to 0–100. The weights
live in `PRIORITY_WEIGHTS` and `tests/minimal/priority.test.ts` reads them, so the table cannot drift.

## Status and authority counters

`src/authority.ts` reads committed records only (no model, no target) and reports planner target operations (must be 0),
worker target operations, tasks created and dispatched with the first dispatch time, owner claims (must be 0), worker claims,
validation tasks, stalled rounds, wake kinds, campaign resumes and stall escalations, plus the static role matrix. The same
object feeds `/p2o status`, report provenance and live previews. A legacy run keeps its honest non-zero owner counts; no
counter refuses a command, wakes a model or finishes a run.

## Pi boundary and state

Only event-driven consent allows extra rounds: committed reports, proposals and review/revise/withdraw produce signals;
stdout, notes and reads do not. A reserved round is void after pause, stop or epoch change. There is no authority recovery
from disk: ledgers, checkpoints and summaries restore knowledge, never a ticket, cookie, socket or worker. Stop an active
assessment before reloading the extension (tickets bind its bytes); rollback means stop, then start a newly confirmed run.
