# P5 proposal — campaign horizon: why the run stops after the roadmap, and what to change

**Status: proposal only; this file is the plan for the P5 update, and nothing else.** The pre-P5 plan (P0–P4, A1–A5,
D1–D8) is merged at `ae551a4` and remains readable with `git show ae551a4:planning_update.md`; it is not carried forward
here, so this document stays small enough to act on. No code, model call, target contact or commit is made by it.

**Owner decision Q1 (2026-10-26): the final-finish refusal is approved.** D9 below is a decision, not a question. It
narrows exactly one clause of the old D8 ("no finish gate"); no work budget, planner-round cap or scope/origin
enforcement is added, the heartbeat is a timer rather than an allowance, and export is never refused.

Evidence used:

| Source | What it establishes |
| --- | --- |
| `tmp/p2o-logs/session-postmortem.md` (494 lines) | Turn/call/wait/token accounting for the 2026-10-26 run, admit/refuse counters, plan-board state, stop sequence |
| `/home/nhanlaptop/tmp/cmp/pi-session-2026-10-26T03-35-19-777Z_01a17646-….html` | The model's own messages: initial roadmap, self-imposed scope and probe budget, wrap-up reasoning |
| `/home/nhanlaptop/tmp/cmp/.p2o-state/run-3dcd0a27-…/assessment.sqlite` | Goals 0, 4 closed tasks, 5 claims, 1 case, 5 cells, 26 gaps, 11 assets, plan board contents, timestamps |
| `/home/nhanlaptop/tmp/cmp/.p2o-reports/report-run-3dcd0a27-…-final/REPORT.md` | What the final report could and could not claim |
| `my_references/ARTEX/` (Go, ~336 files) + `tmp/p2o-logs/artex-long-horizon.md` | The mechanisms that keep an ARTEX task alive for hours, and which of them do not exist there |

The ARTEX study is a source read, not a benchmark. Nothing in it proves ARTEX finds more bugs than
P2O; it only shows which *continuation* machinery it has and which it lacks. Do not quote P5 as
"ARTEX finds RCE in hours" — it is quoted here as "ARTEX has these mechanisms, P2O does not".

---

## 1. The campaign failure this revision answers

### 1.1 What the run did

One human turn against `https://hcmussh.edu.vn/`, event-driven mode, isolated executor, 3 workers,
`maxTargetOperations 2`, `maxDepth 2`, no token/time/round cap, planner
`opencode-go/deepseek-v4.1-flash`.

| Measurement | Value |
| --- | --- |
| Wall clock | 25 min 52.6 s (`03:35:19.777Z` → `04:01:12.327Z`) |
| Human turns / assistant turns / tool calls | 1 / 41 / 56 (all `p2o_*`; 12 refused; 0 bash, read or web calls) |
| Engine rounds / stalled rounds | **0 / 0** |
| Model time vs tool-wait time | 353.6 s (22.8 %) vs 1163.3 s (74.9 %); `p2o_workers` waits 1161.4 s, three of them hit the 300 s cap |
| Planner tokens | 311.0 k in / 38.4 k out; all roles 7.81 M, $0.298 |
| Goals recorded | **0** |
| Plan board | 0 goal, 0 todo, 1 decision |
| Tasks | 4 created, 4 reviewed, 4 closed, 0 open |
| Claims | 5: 1 confirmed, 1 ruled out, 3 `open_proof_gap` |
| Cases / coverage cells | 1 accepted case (r2, low, CWE-614); 5 cells (3 accepted, 2 `open_gap`) over only 2 question keys |
| Graph | 11 assets, 0 relations, 0 anchors; 6 assets unplanned in the projection |
| Open gaps | 26, of which 25 referenced by no plan row and no case |
| Coverage plan created | `03:59:54` — after all four tasks had closed |
| Stop | `04:00:58` `p2o_finish{narrative}` → `run.stopped`, outcome `incomplete/cleaned/finished` |

The model produced a correct-looking four-phase roadmap in its first turn — recon → deployment
hygiene → browser trust controls/CORS → validation — with an explicit self-imposed boundary:
"anonymous, read-only, non-destructive observation only" and "Explicitly out of scope: credential
attacks, injection payloads, authenticated flows, brute force, or any state-changing request". It then
executed that roadmap once and stopped.

It did not stop because the work ran out. At `03:59` these already-permitted, already-in-scope
directions were still open and were never dispatched:

1. a CORS/Origin probe on `/api/state`, whose `Access-Control-Allow-Origin: *` the run had already
   recorded as an asset attribute;
2. sibling `/api/*` routes adjacent to the one it had found;
3. `/chuong-trinh-dao-tao` and `/view-all`, already in the crawled surface;
4. per-node nginx version drift (1.23.2 on one node, 1.27.1 on another) and intermittent 502s;
5. the 500-vs-404 error-boundary difference;
6. identifying the SSR framework behind the rendered pages;
7. linking assets to the evidence that already cited them.

Six further directions were genuinely blocked on human grants (CMS subdomain scope, a known private
article id, whether the HTML header policy is intentional, field-exposure policy, admin paths, a
browser oracle). None of them was recorded as a *wall* either; they simply disappeared at stop time.

### 1.2 What the stop looked like from inside

- `04:00:27` — `p2o_finish{export:true}`. Output: `STATE: incomplete: 1 obligation(s) —
  PRIMITIVE_UNCHAINED 1` and, in the same message, `FINISH PREFLIGHT: 0 open obligation(s), 8
  advisory`. Two host checks over the same state disagreed about whether anything was owed.
- `04:00:41` — the model tried to answer the obligation with a plan row:
  `p2o_plan_create kind=decision disposition=defer reason="No successor step is warranted…"`. The row
  was recorded and the obligation did **not** clear, because only a `todo` can hold the chain link
  that clears it (`src/obligations.ts:45-52`, `src/planning.ts:80`).
- `04:00:58` — `p2o_finish{narrative}`. The final path tore everything down and the run ended
  `incomplete`. No goal existed, so nothing could have been proven.
- Model text at the end: "Given budget, I should wrap up." Earlier: "Remaining context budget: I've
  used a fair amount", and on the idea of declaring a block: "record blocked via `p2o_loop blocked`?
  That pauses dispatch. Better not — I want to finish."

So the run ended for three independent reasons at once: the loop had nothing scheduled to continue it,
the debt that did exist was advisory text, and the model's own context — one giant 41-turn session —
was running out. Any one of the three would have ended the campaign; all three needed fixing.

### 1.3 Why this is a horizon bug, not a prompt bug

The model was not lazy and was not confused about the target. It built a plan, dispatched four
tasks, got one accepted case, and correctly identified the boundary of its self-imposed scope. What it
lacked was a *host* that treats research as a campaign with an outstanding objective rather than a
batch of tasks: no goal to prove, no debt ledger to discharge, no wake that fires without a new
event, no round boundary that resets context, and no finish semantics that distinguish "done" from
"stopped early". Adding more prompt text cannot fix a loop whose next wake depends on an event that
the exhausted state will never produce.

The same shape appears one level up in the failure that produced P0–P3 (recorded at §0.1 of
`git show ae551a4:planning_update.md`): then the planner held target authority and never delegated; here it
delegates correctly and never continues.

### 1.4 Proposed direction in one screen

Six decisions, then workstreams A6.1–A6.6 to implement them (§4):

| ID | In one line |
| --- | --- |
| D9 | The run records a **campaign** (objective + operator constraints + heartbeat), the planner sees the constraints every round, round 1 must record a goal and a coverage plan, and a **final** finish with no goal is refused with a legal next (export exempt) — **owner approved the refusal on 2026-10-26 (Q1)** |
| D10 | **Research debt** is derived by the host with stable ids and discharged only by a record (tested cell, accepted case, goal proof, or a `deferred`+reason+`debtRefs` todo); decision rows and prose do not discharge — the observed `04:00:41` failure becomes a regression test |
| D11 | The loop wakes on events **or** outstanding debt **or** a **heartbeat** (default 600 s, event-driven only, disclosed, 0 disables); the first debt wake is immediate, repeats are paced, `p2o_loop wait` suppresses only the immediate one, and 3 stalled rounds with debt pause for a human |
| D12 | Assets carry **WSTG feature tags**; applicable tests are derived and listed as debt; the planner is told depth-over-coverage, 2–3 mechanism-different routes, and chain-or-wall for a demonstrated primitive |
| D13 | The **round**, not the turn, is the unit of context: end with `p2o_loop wait`, keep blocking joins short, create plan todos in round 1, checkpoint a closed phase as a plan `decision` |
| D14 | Status/report/finish carry **campaign + debt + partial-stop** sections; `p2o_finish` gains an optional `partial` reason; export unchanged and never refused |

No token, wall-clock, round or target-operation budget is added. The heartbeat is a timer, not an
allowance; that keeps D8's "no work budgets" intact and still gives the run a reason to continue.

---

## 2. What ARTEX has that this revision must take, and what it does not have

Read against `my_references/ARTEX/` (Go). Line references are against that snapshot. The study also
corrected three claims that had been circulating in the brief; record the corrections so the port does
not rebuild machinery that is not there.

| Mechanism | Where it lives | Why it matters for a multi-hour campaign | P2O today |
| --- | --- | --- | --- |
| Campaign identity as a durable object; task + exploration row with status, deadline, paused flag | `db/schema.sql:505-534`, `:153-160`; restart rebuild `server/server.go:264-292` | The engagement is an object that can be idle, resumed and inspected, not a conversation | Run record exists (`src/state/store.ts`), but it holds no objective, constraints or heartbeat; a run has status, not a campaign |
| Round-0 goal decomposition that extracts operator **constraints** (allow/deny) and target **scope**, then goals as the final deliverable | `agent/goals.go:36-130` | The objective and the rules survive every round; they are not retyped by a model that forgets | `--avoid` reaches the worker brief (`extensions/p2o/index.ts:669`); planner prompt has no constraints block, no campaign objective |
| Constraints re-injected from the store into **both** planner and worker system prompts every round, as the highest-priority block | `agent/constraints.go:38-48`; `db/constraints.go:16-45` | Policy memory survives compaction and context reset — this is the only reason a long run stays inside its authorization | Absent for the planner |
| Hard floor: goal unmet + no open and no running intent ⇒ this round **must** emit ≥1 intent | `agent/planner.go:303`, per-round message `:461` | An empty frontier is not a stop condition; it is the state the floor exists to break | Planner prompt already says a zero-intent round must add a question or declare blocked (`src/prompts.ts:104-106`), but nothing checks it and nothing wakes the planner to apply it |
| Heartbeat that fires a planner round with zero external events, floor 600 s, re-armed after every wake | `server/engine.go:779-812`, `:901-913`, `:907-912` | Deadlock backstop and periodic supervision; the loop cannot go permanently quiet | No timer in `src/engine.ts`; `reserveWake` returns unless `events.size > 0` (`src/engine.ts:134-147`) |
| Goal-proof-only success exit | `agent/tools.go:1157-1203`; `server/engine.go:885-894` | "Done" means a goal was proven, not that the task list emptied | Completion is derived from goals *if any exist* (`src/completion.ts:44-64`), and goal creation is optional; observed goals 0 ⇒ denominator 0 |
| Deadline settle sequence: stop claiming → drain ≤90 s → one final planner round → terminal | `server/engine_timeout.go:183-267` | A hard stop still ends with a decision round and a writable state, not a silent truncation | None; task ceiling is unlimited by design (D8) |
| Cold-graph digests: settled subgraphs folded into addressable summaries, hot-set revive rule | `agent/compaction.go:34-46`, `:64-144`; `db/digest.go:17-21`, `:122-147` | Bounded planner context over hundreds of rounds without losing navigability | Ledger + context packet already do the bounding (`src/state/store.ts:475-485`); what is missing is a *round boundary* so each round starts from the ledger rather than from one long transcript |
| Depth over coverage; 2–3 mechanism-different routes while the goal is unmet; negative fact re-checked at most once | `agent/planner.go:312`, `:330-331` | Prevents the campaign from spending hours re-walking one surface and calling it exhausted | Absent; the observed run ran one direction per phase and never had two mechanism-different routes in flight |
| Untested-asset backlog tool `list_untested_assets`, coverage overview with true counts | `agent/tools_insert.go:489`; `agent/tools.go:354-560` | The planner can see what remains without inventing it | Data exists (`contextBacklog`: unplanned assets, cells not run, WSTG suggestions — `src/state/store.ts:653-671`) but it is passive context with no obligation and no discharge |
| Findings wake the planner mid-run; hints/goals can revive a terminal task | `server/manager.go:1771-1808`; `server/goals.go:349-362` | A discovery redirects the next round immediately rather than at intent end | Worker reports do produce events, so this half already works in event-driven mode |
| Intent terminal states are semantically distinct and resumable: `done` / `exhausted` (budget cut) / `blocked` (external failure) / `stopped` (killed), with reopen-from-transcript | `db/exploration.go:322-336`; `agent/planner.go:327`; `agent/worker.go:500-514` | A cut-short direction is retried or continued next round, not written off | Statuses `reported|reviewed|closed|blocked|cancelled|expired` (`src/tasks.ts`) plus live-pane reuse `p2o_workers action=continue`; after teardown nothing resumes — acceptable for P5, debt items carry the re-entry work instead |
| Automatic surface expansion: asset insert enqueues DNS/HTTP probe; traffic archive with FTS body search | `enrich/enrich.go:1-6`, `:117-122`; `traffic/traffic.go:1-4`, `:78-84`; `agent/worker.go:250-255` | Turns one discovered host into a larger testable surface without a human-written plan | Manual/model recon only. **Out of P5 scope** (see §7.2 non-goals); the P5 loop must be honest before the surface grows mechanically |
| Metered LLM usage, retry policy, quota park/reopen | `db/llm_usage.go:9-48`; `server/engine.go:1027-1046`; `server/manager.go:1052-1080` | Long runs survive transient failures; spend is measured, not capped | Usage ledger exists in the ledger/report; no retry/park policy (out of scope for P5) |
| Per-intent budget with settlement that flushes findings then marks the intent `exhausted` (resumable), `run_seconds` 1200 | `db/schema.sql:798`; `agent/worker.go:151-154`; `server/engine.go:1135-1145`; `agent/planner.go:327` | One run can be cut without losing the campaign; the next round reads the trace and continues or switches | Workers report before they end; no settlement prompt, no `exhausted`-like state, but the ledger keeps the report — acceptable |
| Retests as human-initiated conversations with evidence snapshots | `db/finding_retests.go:74-124`; `db/schema.sql:1112-1160` | Re-verification is an explicit act, not a scheduler | `retest` work purpose exists (`src/work.ts`); cadence is out of scope |

**Corrections to the brief, recorded so they are not ported as if they were real:**

- There is **no exploration-token / exploration budget** in ARTEX. `db/exploration_tokens.go` does not
  exist; the only match is a statistics aggregation test (`db/exploration_tokens_test.go`). Spend is
  metered, never capped (`db/llm_usage.go:9-48`). This *confirms* D8's "no work budgets": autonomy is
  produced by continuation rules, not by a larger allowance.
- There is **no plateau detector and no yield-rate strategy switch**. Repetition is made expensive by
  prompt rules plus state signals (`agent/planner.go:304-331`); 0 intents is legal only with a stated
  reason. Do not port a numeric "yield" heuristic.
- `db/exploration_sources.go` is **task-context inheritance**, not a budget; `db/side_questions.go` is
  a human `/btw` channel that never queues work. Neither is a continuation mechanism.
- The intent floor is **prompt-level only**. The ARTEX engine "will happily let a task sit with an
  empty frontier forever if the planner ignores the rule" (study §13, caveat). P2O runs a host loop
  with a ledger, so it can and should assert this in code rather than only in prose — that is the one
  place where the port can be strictly stronger than the original.

**What P2O must not copy:** in-memory planner scratchpads (`agent/planner.go:43-49`) — P2O's plan
board is durable and should stay so; model-chosen priority order; a fresh LLM session per wake with no
durable plan at all (P2O already keeps the ledger); SQLite/PG assumptions; the web UI; the
multi-provider quota pool; a scheduler-driven reporter. And one refusal, not a skip: ARTEX's restart
path re-starts the engine loops for non-terminal tasks (`server/server.go:264-292`, `db/exploration.go:312-320`).
P2O intentionally never reconstructs execution authority after a restart (`extensions/p2o/index.ts:115`,
`:2437`; `src/engine.ts:32-35`). P5 must not import auto-resume; the cross-run handoff is the ledger and
the debt report (A6.2), read by the next run.

---

## 3. Invariants for a campaign run

These extend the invariants of the pre-P5 plan (§2.3 of `git show ae551a4:planning_update.md`). Each is stated so a
test can fail on it.

1. **A campaign has a recorded objective.** An event-driven run has exactly one `campaign` record
   (objective, operator constraints, target revision, heartbeat interval, started-at). It is written
   before the first dispatch and is not editable by model prose.
2. **Completion has a non-empty denominator.** At the first round, the plan board holds ≥1 goal with
   bounded criteria and a proof kind; the coverage plan exists before the first task is dispatched,
   not after the last one closes.
3. **Owed work wakes the planner.** A round may be woken by an event, by outstanding gateable debt, or
   by the heartbeat. "No new events" is never by itself a reason to be idle while debt is outstanding.
4. **Every obligation is a record with a discharge.** Debt items are derived by the host with
   deterministic ids. An item is discharged by the record that answers it (tested cell, accepted case,
   goal proof) or by a `deferred`/`blocked` todo naming it and giving a reason. A `decision` row and
   free-text prose do not discharge — that mismatch is what the observed run hit at `04:00:41`.
5. **The round, not the turn, is the unit of context.** A planning round ends with `p2o_loop wait`;
   the next round starts from the ledger. One 41-turn transcript is not a campaign.
6. **Stopping is explicit.** A final finish records either "goals proven" or an acknowledged partial
   stop with its reason and remaining debt. There is no third path where the run ends because a turn
   settled.
7. **Constraint text is injected by the host every round**, for the planner as it already is for
   workers; it outranks planning heuristics and the planner may not silently narrow it.
8. **No new budget.** P5 adds no token, command, round or wall-clock allowance; the heartbeat is a
   timer, not an allowance. The only possible new refusal is a missing campaign frame at *final*
   finish (D9), and export is never refused.
9. **Continuity is in-process.** A process restart does not resume execution: `/p2o recover` and
   `reconcile` open a run as historical knowledge and never restore authority
   (`extensions/p2o/index.ts:115`, `:2007-2027`, `:2437`; `src/engine.ts:32-35` comment). ARTEX
   restarts its engine loops for non-terminal tasks (`server/server.go:264-292`); P2O deliberately
   does not, and P5 keeps that. What survives is the ledger plus the debt report, which the *next*
   run reads as knowledge — not as a resumed queue.

---

## 4. A6 — Campaign horizon

Workstream numbering continues A1–A5 of the pre-P5 plan (`ae551a4`). Same style: what changes, where, and how a
hermetic test knows it worked.

### A6.1 — Campaign frame (objective, constraints, heartbeat)

**Goal.** A run carries its campaign identity in the ledger so continuation, prompting and reporting
all read one record instead of inferring intent from prose.

**Changes.**
- `src/campaign.ts` (new, pure): `CampaignRecord` type `{v:1, objective, constraints:[{rule:'allow'|'deny', text}], targetRevision, heartbeatSeconds, startedAt, createdBy:'operator'|'default'}`;
  `parseCampaign` / `campaignFrom(args, targetRevision)`; `DEFAULT_HEARTBEAT_SECONDS = 600` (ARTEX
  parity, `:779-787`), `MIN_HEARTBEAT_SECONDS = 120`, `0` disables.
- `extensions/p2o/index.ts`: `/p2o --goal "<text>" [--avoid "<rule>"]… [--heartbeat-seconds N]`, persisted
  through `store.persist('lifecycle', {event:'campaign.created', campaign})`. When `--goal` is absent
  in event-driven mode, derive the objective from `--target` plus the first planner turn's stated
  objective — recorded once, never rewritten.
- `src/state/store.ts`: `campaign()` reader that folds the lifecycle record (last wins by sequence) plus
  `campaignRevision`; exposed in `reviewContext()` and in `ContextPacket` (planner only, ≤600 bytes).
- `src/prompts.ts`: `PlannerPromptFacts.campaign` ⇒ a `CAMPAIGN` block above the heuristics —
  objective, operator constraints (`deny` listed as absolute, `allow` as permission), and a line
  saying the planner may widen but not silently narrow the operator objective. `reconInstructions`
  unchanged; worker brief already receives `avoid`.
- Start confirmation (`extensions/p2o/index.ts:2216`) discloses objective, constraint count, heartbeat,
  and that heartbeats consume paid rounds.

**Acceptance (hermetic).** `tests/minimal/campaign.test.ts`: parse/round-trip; objective defaults are
recorded once and never rewritten by a later `plan` write; planner prompt snapshot contains the
objective and every deny rule and no worker-only text; start confirmation string contains the
interval; a campaign record cannot be created by a worker role.

**Risk.** Low. It is data plus prompt composition; no new authority. When `--goal` is absent the run is
in "no campaign" mode and A6.3/A6.6 degrade exactly to today's behaviour.

### A6.2 — Research debt: derived, deterministic, dischargeable

**Goal.** Turn the advisory backlog into an obligation ledger the loop and the report can both use,
without inventing work from nothing.

**Changes.**
- `src/debt.ts` (new, pure, read-only; no I/O, no clock): `deriveDebt(index, {campaign, coverage, wstg, limits}) → DebtReport {items: DebtItem[], totals, byKind}`, item =
  `{id, kind, subject, detail, gateable, source}`. `id = 'debt-' + kind.toLowerCase().replaceAll('_','-') + '-' + fp12(subject)` (stable across runs; tests pin it).
  Kinds, each with a source and a discharge rule:

| Kind | Derived from | Gateable | Discharge |
| --- | --- | --- | --- |
| `CAMPAIGN_MISSING` | no campaign record in event-driven mode | yes | creating the record (operator/CLI) |
| `GOAL_MISSING` | campaign exists, no `goal` plan row | yes | a goal row with criteria + proof |
| `GOAL_OPEN` | goal row not reviewed/closed | yes | review or close (existing goal settlement) |
| `PLAN_MISSING` | no coverage plan, or plan created after the last task closed | yes | a coverage plan with cells |
| `SCOPE_UNPLANNED_ASSET` | graph asset absent from the coverage denominator (`coverageViews().discoveredUnplannedAssets`) | yes | project a cell covering it |
| `CELL_NOT_RUN` | projected cell not terminal (open_gap / unreviewed) | yes | terminal cell |
| `GAP_UNTRIAGED` | open gap not referenced by any plan row or case (`OPEN_GAP_UNREFERENCED`) | yes | cite in a plan todo or a case |
| `WSTG_UNPLANNED` | applicable WSTG test (feature-triggered) with no cell; excludes `browser` rows with no browser oracle and `identity` rows with no operator identity | yes (when features are recorded) | a cell keyed `wstg-…` |
| `FEATURES_MISSING` | mapped asset with no `feature` attribute value | no (advisory) | recon records `feature` |
| `TASK_UNMAPPED` | non-mapping task closed with no work identity → mapping | yes | mapped task, or a deferred/blocked todo reason |
| `MAPPING_UNRECORDED` | mapping/recon task closed with no graph write (`writeBack` empty) | yes | graph write or reason |
| `PRIMITIVE_UNCHAINED` | confirmed+tested claim with no successor step and no wall (existing `unchained`, `src/obligations.ts:78-89`) | yes | chained todo or walled todo |
| `CLAIM_UNTRIAGED` | candidate still `open_proof_gap` after its task closed | yes | confirmation, rule-out, or wall |

  Bounded: top 5 per kind by recency + full totals (the context packet is 12 KiB, `src/state/store.ts:475-485`).
- Discharge mechanics: `src/planning.ts` — `p2o_plan_create/revise` accepts optional
  `debtRefs: string[]` **on todo rows only** (one more link field; still "only a todo holds a chain
  link"); validation refuses an id that is not in the current debt report, and refuses `debtRefs` on
  goal/decision rows. `deferred`/`blocked` + `reason` + `debtRefs` is the only prose wall.
- Integration: `src/completion.ts` — `CompletionInput` gains `debt`; `remaining` and `demand` include
  gateable debt; existing codes keep their meaning (A6 does not renumber them). `src/finish-preflight.ts` —
  one new code `RESEARCH_DEBT` (advisory list, in `OPEN_OBLIGATION` only if D9 is approved), and
  `UNMAPPED_TASK` narrowed to read "a non-mapping task with no work identity".
- `src/state/store.ts`: `contextBacklog()` becomes `debtReport()`; the skip/caps points that mutate
  `packetBase.backlog` are updated to the debt shape.
- `src/ui/state.ts` + `src/report-export.ts`: debt totals by kind; report table (A6.6).
- Interruption handoff: the existing `reconcileInterruption` path (operator resume of an interrupted
  run) records the campaign objective and the debt summary in its lifecycle record, so a run that was
  cut by a restart leaves a debt report behind. It still restores no authority — the next run reads it
  as knowledge (`extensions/p2o/index.ts:2227`, `:2023`).

**Acceptance (hermetic).** `tests/minimal/debt.test.ts`: each kind derives from a scripted index and
only from it; ids are stable across two calls and change when the subject changes; a tested cell and an
accepted case each discharge their item; a `decision` row does **not** discharge (regression for
`04:00:41`); a `deferred` todo with `debtRefs` does; unknown `debtRef` refused; goal/decision
`debtRefs` refused; totals bounded to N per kind; debt never mutates the ledger. Plus a fixture test
that the observed run's final state now yields ≥1 goalable item and the 25 unreferenced gaps appear as
`GAP_UNTRIAGED`.

**Risk.** Medium. This is the largest new surface: it can flood the prompt if unbounded, and it can
become a second source of truth about coverage. Mitigation: it derives only from existing projections
(`coverageViews`, `proofViews`, `planFrontier`) and keeps no state of its own.

### A6.3 — Obligation-driven continuation (wake, heartbeat, stall escalation)

**Goal.** The loop continues because work is owed, not because an event happened to arrive.

**Changes.**
- `src/engine.ts`: `RoundProgress` gains `debt?: {gateable: number; total: number}`; `EngineDeps` gains
  `now?: () => number` (default `Date.now`, so fake timers control it).
- `reserveWake()` gains two branches after the event branch (order: events → debt → quiet handling):
  1. **debt wake** — `remaining > 0` (or `debt.gateable > 0`) and no open/running intent and no
     reservation. First occurrence after a round ends reserves immediately (this is the branch that
     would have continued the observed run at `04:00`); subsequent ones are paced: not before
     `heartbeatSeconds` since the last debt wake, and suppressed when the last explicit disposition was
     `p2o_loop wait` (events and heartbeat still wake).
  2. **heartbeat** — engine arms one `setTimeout(unref)` on `start()`/`resume()`/after each `consume()`;
     on fire it clears the reservation gate and wakes with `demand: 'heartbeat <n>s; <debt demand>'`
     and the max round duration of the campaign (sorted `started_at`/`reported_at` pairs: total, max,
     mean). Disposed on `pause()`, `stop()`, `paused` decision and teardown. A heartbeat never fires
     while `busy` (the model is inside a turn) and never resurrects a stopped run.
- `stallRound` escalation: keep recording `planner.stalled` exactly as today
  (`src/engine.ts:159-166`); when `stalls >= 3` and `debt.gateable > 0`, `pause('three rounds with no
  open intent while research debt remains; the loop needs a human decision (/p2o resume or /p2o stop)')`
  and persist `planner.stall-escalation` with the debt summary. No new budget, no auto-restart.
- `snapshot()` gains `heartbeat: {seconds, nextAt}` and `lastWake: {reason: 'event'|'debt'|'heartbeat',
  round}` (fields only; no new authority), so status and the P6 metrics can count wakes by reason
  without re-deriving them. `disposition('wait')` already records `decision.disposition = 'wait'`
  (`src/engine.ts:211-219`) — that field is the suppression signal, and `resume()` already clears it
  (`:220-223`), so the debt branch needs no new state.
- `extensions/p2o/index.ts`: `roundProgress()` (line ~426) computes `debt` from the same ledger read as
  completion; wake dependency at `:2268` unchanged in shape but carries the heartbeat/debt demand text;
  `p2o_loop` description and `src/prompt-bridge` text updated; start confirmation lists the effective
  heartbeat and the 3-stall pause rule.
- `src/planner-bridge.ts`: `wake.demand` rendering already exists; the heartbeat message names the
  reason so the planner cannot read it as an event.

**Acceptance (hermetic).** `tests/minimal/engine-campaign.test.ts` with fake timers: zero-event +
`remaining>0` reserves a wake at the round boundary; `remaining=0` + zero events does not; second debt
wake inside the interval is suppressed, one after it fires; `p2o_loop wait` suppresses the immediate
debt wake but not event wakes; heartbeat fires at T with zero events and carries its demand; heartbeat
does not fire when paused/stopped/busy; three stalled rounds with gateable debt pause with a human-needed
reason and a persisted fact, and `/p2o resume` clears the pause; no budget field is written anywhere;
opening/recovering a historical run arms no timer and wakes nothing (the recover path has no engine).

**Risk.** Medium-high. A heartbeat that fires while an operator is away spends money — hence the
explicit consent disclosure at start plus `--heartbeat-seconds 0`. Wakes with nothing new can also cause
loop churn; the 3-stall pause and quiet-round demand already bound that, and the falsifiable P5 gate is
"wakes per hour ≤ intervals + events".

### A6.4 — Depth ladder and WSTG feature matrix

**Goal.** Give the planner a denominator and a direction beyond "more assets": which tests apply, which
routes exist, and what a demonstrated primitive owes.

**Changes.**
- Feature contract: recon task brief (`src/prompts.ts:31-41` via worker brief) requires recording
  `attributes.feature` on every mapped asset using `WSTG_FEATURES` vocabulary; the host validates with
  `featuresFromAttributeValues` (`src/wstg-map.ts:424-435`) and records unknown tokens as an advisory in
  the debt report (`FEATURES_INVALID` folded into `FEATURES_MISSING` detail). No host refusal.
- Applicable-test derivation (pure, `src/wstg-map.ts`): `applicableTests(assets, {browser:boolean,
  identity:boolean})` = rows whose `trigger` intersects an asset's features, minus `browser` rows when
  no oracle exists, minus `identity` rows when no identity was granted; `unplannedTests()` feeds
  `WSTG_UNPLANNED`.
- Planner prompt (`src/prompts.ts:59-114`): three lines translated from `agent/planner.go:304-331`, kept
  short — (a) while the goal is unmet, prefer depth on a live finding over breadth on a new asset;
  (b) keep 2–3 mechanism-different routes open, and open a genuinely different one when all are on the
  same mechanism; (c) a confirmed+tested primitive must be chained (a follow-up todo) or walled (deferred
  todo with reason and revisit condition). No new tool; the debt report names the specific tests.
- Primitive triage: `unchained` (`src/obligations.ts:78-89`) stays the source; `PRIMITIVE_UNCHAINED`
  becomes gateable and its repair path is a `todo` with `chainOf`/`step` or a wall with `debtRefs`.
- Exploitation gating stays as in A2 (exploit work requires a demonstrated primitive); P5 does not
  loosen it.

**Acceptance (hermetic).** `tests/minimal/wstg-applicable.test.ts`: feature vocabulary round-trip;
`applicableTests` filters exactly the browser/identity rows; a run whose assets record `cors` and `api`
gets `cors-*`/`api-*` cells suggested as debt; prompt snapshot contains the three lines and the
vocabulary sentence; `PRIMITIVE_UNCHAINED` in the observed-run fixture is gateable and clearing it
requires a todo, not a decision.

**Risk.** Medium. A feature vocabulary is a taxonomy and taxonomies drift; it must stay advisory except
where a recorded feature already makes a test applicable. Do not make WSTG coverage a goal proof — the
goal proof stays the run's own cells (`src/goal-proof.ts:46-49`), which is what keeps D8's "coverage is
a projection" intact.

### A6.5 — Round hygiene and campaign memory

**Goal.** Make the round — not the transcript — the unit of work, so context can be rebuilt from the
ledger instead of dying with one long turn.

**Changes.**
- Planner guidance (`src/prompts.ts` planner block, and `p2o_loop` description): after dispatching or
  reviewing, end the round with `p2o_loop wait`; use `p2o_workers waitFor=all-report` only for a bounded
  join you are about to act on (the observed run spent 74.9 % of wall time inside three 300 s waits, and
  ended with 0 rounds because the whole campaign lived in one turn). No host cap in this phase; counting
  waiting time as a failure mode in the P5 measured gate is the falsifiable part.
- First-round contract: the first round creates the goal, the coverage plan and one `todo` per campaign
  phase (serial phases as `chainOf`/`step` steps) before the first `p2o_task_create`; a second dispatch
  with no todo referencing it is an admission advisory (`admissionRefusal` unchanged in shape — A2's
  measured error target is not re-litigated here).
- Checkpoint on phase close: the planner records a plan `decision` with the next phase's starting
  question and the closures since the last checkpoint. This is the durable analogue of ARTEX's cold
  digest: the next round reads it from the ledger, not from the transcript.
- `src/ui/state.ts`: status shows campaign phase, round number, last wake reason (event/debt/heartbeat)
  and round-start timestamp.

**Acceptance (hermetic).** Fixture test on the observed session's scripted calls: the same plan now
requires a goal before the first dispatch (refusal text names the legal next call), and a closed phase
with no recorded checkpoint is surfaced in status as debt (`CHECKPOINT_MISSING` optional/advisory);
prompt snapshot contains the round-ending guidance; a toy 3-round scripted loop produces 3 engine rounds
and 3 fresh context packets rather than 1.

**Risk.** Medium. Prompt guidance may be ignored — hence the measured gate counts rounds and wait time.
Do not add a host cap on `p2o_workers wait` in P5 (it is the only short-join primitive; a cap is a
deferral to P6 if measurement shows it is needed).

### A6.6 — Finish and report semantics

**Goal.** The report and the finish cannot claim more than the campaign did, and cannot call "ran out of
turn" a completion.

**Changes.**
- `src/tool-schemas.ts:184-188`: `finishParameters` gains `partial?: string` (operator-facing reason,
  ≤600 chars); `src/tool-schemas.ts:158-160` loop unchanged.
- Final `p2o_finish` (export path unchanged, `extensions/p2o/index.ts:1945-1985`):
  - **D9 (approved 2026-10-26, Q1 = refuse):** if a campaign record exists and no goal has ever been
    recorded, the final path fails with `CAMPAIGN_FRAME_MISSING` and a legal next (`p2o_plan_create
    kind=goal …`, or `p2o_finish{export:true}`, or `p2o_finish{partial:"…"}`); if a goal exists but the
    completion is `incomplete`, the final path records `campaign.partial` with the reason from
    `partial` (required in that case) and proceeds. There is exactly one new refusal, only on the final
    path, only when a campaign exists. Export is never refused (existing comment at `:1966` preserved
    and extended: "p2o has one campaign-frame refusal, never a work gate").
  - The rejected alternative was acknowledgment-only (print the missing frame, never fail); it stays
    recorded here so the reversal is a one-line change if the refusal turns out to be in the way.
- `src/report.ts` / `src/report-export.ts`: `ReportMeta.campaign` (`objective`, `constraints count`,
  `heartbeatSeconds`, `rounds`, `wakeReasons`, `startedAt`, `endedAt`, `partialReason`); report gains
  `## Campaign`, `## Research debt at stop` (by kind, discharged/remaining) and, for a partial stop, a
  `### Why the run stopped` section that quotes the recorded reason and never asserts coverage.
- REPORT.md stays deterministic: sorting by `(kind, subject)`, ids printed, no timestamps inside tables
  other than the recorded ones.
- `src/authority.ts`: counters `heartbeatWakes`, `debtWakes`, `campaignPartial`, kept in the existing
  shape so existing invariants do not renumber.

**Acceptance (hermetic).** `tests/minimal/finish-campaign.test.ts`: final finish with campaign and no
goal refuses with `CAMPAIGN_FRAME_MISSING` and lists the three legal next calls (D9, approved 2026-10-26);
`partial` required when completion is incomplete; `campaign.partial` lifecycle record written once with
the reason; export path never refuses and never tears down (existing `export` test extended); report
renders campaign/debt/stop sections deterministically across two renders; a run with no campaign record
behaves exactly as today.

**Risk.** Medium because it touches the one owner-decision boundary (D8). Mitigation: gated entirely on
a campaign record existing; non-campaign and manual runs are untouched; export remains unconditional.

---

## 5. Phases

P0–P4 are merged at `ae551a4` and are not repeated in this file. This proposal adds:

| Phase | Scope | Hermetic gate | Measured gate |
| --- | --- | --- | --- |
| **P5 — Campaign horizon (A6)** | Campaign frame, research debt + discharge, obligation/heartbeat wake, feature matrix + depth prompts, round hygiene, finish/report semantics | A6.1–A6.6 suites green; `tsc --noEmit` clean; full vitest green; `detect_changes` clean; `git diff --check`; docs parity (`docs/WSTG_MAP.md`, `docs/ACCEPTANCE_MATRIX.md` P5 section added with exact `<file>.test.ts :: <title>` citations) | Deferred/paid and authorization-gated: one unattended campaign 60–90 min in the local lab profile; success = ≥3 planner rounds without a human turn, ≥1 debt/heartbeat continuation, ≥1 new goal-directed direction dispatched after the roadmap is exhausted, no refusal loop on the first case, report states goal/partial honestly. **Not run in this proposal.** |
| **P6 — L4 measurement (A5 re-based)** | Metrics only; no behaviour change | Metric derivation tests over a recorded run | Campaign metrics per §7.3: rounds within human input, wakes by reason, target ops per phase, WSTG classes tried, mechanism routes, primitive→chain depth, time-to-first-primitive, debt discharged per round, wall share inside blocking waits, refusals per create, $ and tokens per campaign |

A5/P4 measurement remains unmeasured. P5 does not replace it; P6 defines the campaign-level version of
it, because the metric set that judged a 25-minute batch is not the one that judges a 90-minute
campaign.

## 6. Migrations

- No deletions. `contextBacklog()` is renamed/re-shaped into `debtReport()`; the old shape is not kept.
- `UNMAPPED_TASK` semantics narrow to "non-mapping task with no work identity"; mapping/recon tasks get
  `MAPPING_UNRECORDED`. Preflight code list grows by `RESEARCH_DEBT` (and only that one).
- Vocabulary unification (fixes the observed contradiction): `OPEN_OBLIGATION` in
  `src/finish-preflight.ts:68` must be derived from the same `REMAINING_CODES`/debt source as
  `deriveCompletion` (`src/completion.ts:17`), so "N obligation(s)" and "M open obligation(s)" can never
  disagree again. The observed `1 vs 0` is the acceptance fixture.
- Legacy runs: absent a campaign lifecycle record, `deriveCompletion`/preflight/engine behave exactly as
  today (no debt wake, no heartbeat, no goal requirement). Store detection is by lifecycle event
  presence only; no manifest version bump is needed.
- Tests to update (mechanical, same commit as the code): `tests/minimal/prompt-roles.test.ts` (planner
  prompt snapshot), `intent.test.ts` (`debtRefs` on todo), `projection.test.ts` (debt projection),
  `extension.test.ts` and `dispatch-discipline` (first-round goal/plan refusal text),
  `finish-preflight.test.ts`, `report-export.test.ts`, `acceptance-matrix.test.ts` (new P5 section;
  existing row counts F-L1-5 98/840 may change — update the doc row and the test together), plus
  `docs/KNOWLEDGE_WORKSPACE.md` if the CLI surface (`--goal`, `--avoid`, `--heartbeat-seconds`) is
  documented there.

## 7. Risks, non-goals and metrics

### 7.1 Risks

| Risk | Mitigation |
| --- | --- |
| Heartbeat spends paid rounds while nobody watches | disclosed at start; `--heartbeat-seconds 0` disables; 3-stall pause; P5 gate measures wake count |
| Debt list becomes a second coverage truth and drifts from the projection | debt derives only from existing projections, keeps no state; contract test asserts equality with `coverageViews` |
| A campaign-frame refusal feels like the finish gate D8 removed | gated on campaign presence, final path only, export exempt; owner approved 2026-10-26 (Q1) |
| Prompt rules (depth/route/round) ignored, as ARTEX's floor can be | the host asserts the debt/wake side in code; prompt side is measured in P5/P6, not assumed |
| Feature taxonomy produces false "applicable" tests | advisory by default; gateable only where a recorded feature makes the test applicable; browser/identity filtered |
| Keep-alive waits replaced by premature `p2o_loop wait` churn | short joins still allowed; measured gate counts rounds and idle wakes |

### 7.2 Non-goals

- No token, wall-clock, round or target-operation budget; `--heartbeat-seconds` is a timer, not an
  allowance. Rated-run ceilings remain the operator's call at launch.
- No automatic retest schedule; retests stay explicit (`RETEST` work purpose).
- No exploit automation, no scope widening by the host, no new target authority.
- No chapter-2 rewrite: A1–A4 remain as committed; A6 is additive and gated.
- **No auto-resume after a process restart.** Recovering a run opens knowledge and restores no
  execution authority; P5 adds no engine revival, no suspended queue and no automatic re-dispatch.
  A long campaign is one uninterrupted process; a restart ends it and leaves a debt report for the
  next run.
- **No automatic surface expansion in P5** (no asset-enrichment sweep, no traffic archive/recorder,
  no api-recon skill port). ARTEX grows the surface mechanically; P2O first has to keep a campaign
  honest on the surface it already has. Revisit as P6+ if the measured gate shows the loop is stable
  but the denominator is the bottleneck.
- No promise of RCE/LPE gain. P5 makes a campaign continue and report honestly; whether it finds deeper
  bugs is exactly what the deferred measured gate is for, and it needs authorization.

### 7.3 Metrics to add

Per campaign: rounds; rounds without human input; wakes by reason (event/debt/heartbeat); target ops by
phase; distinct WSTG classes with cells; distinct mechanism routes; primitive→chain depth (max); time to
first primitive; debt created/discharged per round; wall share inside blocking waits; task-create
refusals per attempt; tokens/$; and the two honesty metrics: goal proof present at finish, partial reason
recorded when incomplete.

---

## Appendix A — open questions for the owner (defaults recommended)

| # | Question | Recommended default |
| --- | --- | --- |
| Q1 | Is one campaign-frame refusal at final finish acceptable, or acknowledgment-only? | **Resolved 2026-10-26: refusal approved**, and D9 in §1.4 is the decision |
| Q2 | Heartbeat default 600 s (ARTEX parity) vs 300 s | 600 s, min 120, `--heartbeat-seconds 0` disables |
| Q3 | Should event-driven mode require `--goal`? | No: absent → "no campaign" mode with today's behaviour; present → full P5 semantics |
| Q4 | Can one `deferred` todo discharge many debt ids (bulk)? | Yes, with mandatory reason; cap 25 per row so a wall carries meaning |
| Q5 | Are feature tags mandatory for mapped assets or advisory? | Mandatory in the recon contract, advisory in preflight (no refusal), gateable only via clearly applicable tests |
| Q6 | Do we ever add a campaign ceiling (`--max-hours`/`--max-rounds`)? | No in P5. Revisit only if P6 measurement shows unbounded spend without value; ARTEX's task timeout also defaults to unlimited |
| Q7 | Is `CHECKPOINT_MISSING` a debt kind or advisory? | Advisory in P5 (D13 is guidance); promote to gateable in P6 if rounds churn |
| Q8 | Should the planner see raw debt ids or human kinds? | Both: kind+subject in the prompt, ids only in `debtRefs` echo, so the model cites rather than invents |

## Appendix B — how to re-verify the evidence

```sh
# session → transcript numbers (base64 JSON in the <script id="session-data"> block)
python3 - <<'PY'
import base64,json,re
html=open('/home/nhanlaptop/tmp/cmp/pi-session-2026-10-26T03-35-19-777Z_01a17646-e3df-71a0-ba58-70a95e16a45c.html',encoding='utf-8').read()
data=json.loads(base64.b64decode(re.search(r'<script id="session-data"[^>]*>([^<]+)</script>',html).group(1)))
print(len(data.get('messages',[])), data.get('startTime'), data.get('endTime'))
PY

# run store: goals 0, tasks, claims, cells, gaps, plan board
sqlite3 /home/nhanlaptop/tmp/cmp/.p2o-state/run-3dcd0a27-8ec3-4516-ab96-66b208f0651d/assessment.sqlite \
  "select kind,count(*) from records group by kind;"
```

The postmortem at `tmp/p2o-logs/session-postmortem.md` already contains the per-call table, the wait
breakdown and the extracted quotes; use it rather than re-deriving them.

## Appendix C — what this proposal does *not* claim

- It does not claim ARTEX's effectiveness: the local study and the upstream doc do not measure
  end-to-end results; P5 copies mechanisms, not outcomes.
- It does not claim P5 will find RCE or LPE. That needs the deferred measured gate, a lab profile and
  authorization.
- It does not change code: this file is a plan, and implementing A6 is a separate, owner-initiated phase.
- It does not re-open A1–A4 or D1–D7. D8 is the only earlier decision narrowed, only by D9 (refusal, approved by the
  owner on 2026-10-26).
