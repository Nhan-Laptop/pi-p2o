# P5 → P7 proposal — campaign horizon (closed), then the access ladder: internal network → RCE → LPE

**Status: the P5 half is implemented and measured; the P7 half is a proposal.** This document now has three parts and one
purpose. **Part I** (§1–§7, Appendices A–C) is the P5 campaign-horizon revision: implemented in `18c0427`, `6439eec` and
`49930d5`, measured 6/6 on `run-615f7a9a-412e-47ed-81d0-5059406dc5ef` (69.8 min, $1.5703, 12 rounds, heartbeat 1 + event 9
wakes, 0 stall/escalation/resume, one accepted Low case, honest partial report). It is kept as the closed record and is not
rewritten. **Part II** (§8–§17, Appendices D–F) is **P7: the access ladder** — the extension's actual purpose in the owner's
words: research bugs and vulnerabilities to get into the internal network, to RCE, then LPE, or something else
critical/high. Part II is a proposal only; nothing below §8 is implemented. **Part III** (§18–§26, Appendices G–H) is
**P8: the tool-surface review** — a read-only audit of the 37 registered tools for duplicate or overlapping features, the
control gaps the same pass found, and the owner decisions those need; proposal only, nothing below §18 is implemented. No
code, model call, target contact or commit is made by this document.

**How to read it.** Part I is history and measured evidence for the loop. Part II §8 diagnoses why the current workflow cannot
climb, §9 sets ARTEX as the mechanism floor, §10 states the invariants, §11 the decisions, §12 the code corrections that
shape the design, §13 the workstreams with exact seams, §14 what the measured gate must prove, §15–§17 migrations, risks and
the owner's answers. Part III §18 states the question and the method, §19 how the surface is generated, §20 the verified
findings, §21 the decisions, §22 the workstreams, §23 the phases, §24–§26 migrations, risks and open questions. The
owner-decided constraints
carry over unchanged: no token/wall-clock/round budget, no auto-resume, no host-side scope widening, and commit/push plus any
paid or target-touching run remain owner-initiated only.

**Owner decision Q1 (2026-10-26): the final-finish refusal is approved** (Part I, D9). It narrows exactly one clause of the
old D8; no work budget, planner-round cap or scope/origin enforcement is added, the heartbeat is a timer rather than an
allowance, and export is never refused.

Evidence used (Part I — P5, closed):

| Source | What it establishes |
| --- | --- |
| `tmp/p2o-logs/session-postmortem.md` (494 lines) | Turn/call/wait/token accounting for the 2026-10-26 run, admit/refuse counters, plan-board state, stop sequence |
| `/home/nhanlaptop/tmp/cmp/pi-session-2026-10-26T03-35-19-777Z_01a17646-….html` | The model's own messages: initial roadmap, self-imposed scope and probe budget, wrap-up reasoning |
| `/home/nhanlaptop/tmp/cmp/.p2o-state/run-3dcd0a27-…/assessment.sqlite` | Goals 0, 4 closed tasks, 5 claims, 1 case, 5 cells, 26 gaps, 11 assets, plan board contents, timestamps |
| `/home/nhanlaptop/tmp/cmp/.p2o-reports/report-run-3dcd0a27-…-final/REPORT.md` | What the final report could and could not claim |
| `my_references/ARTEX/` (Go, ~336 files) + `tmp/p2o-logs/artex-long-horizon.md` | The mechanisms that keep an ARTEX task alive for hours, and which of them do not exist there |
| `run-615f7a9a-412e-47ed-81d0-5059406dc5ef` + `tmp/p2o-live/gate-verdict3.md` | The measured P5.1 gate: 6/6 criteria, plus the two infrastructure defects recorded, not patched |

The ARTEX study is a source read, not a benchmark. Nothing in it proves ARTEX finds more bugs than
P2O; it only shows which *continuation* machinery it has and which it lacks. Do not quote P5 as
"ARTEX finds RCE in hours" — it is quoted here as "ARTEX has these mechanisms, P2O does not".

Evidence used (Part II — P7, all read-only; no model call, target contact or commit made by the study):

| Source | What it establishes |
| --- | --- |
| `tmp/p2o-live/REPORT-run5-final.md`, `tmp/p2o-live/final-metrics-run5.txt` | What the 70-minute campaign actually did: 20 tasks, 217 worker target operations, 0 exploitation/chaining tasks, 1 accepted Low case, the run's own exclusions |
| `tmp/p2o-live/gate-verdict3.md` | The measured P5.1 result and the two infrastructure defects that must be fixed before a ladder gate run |
| `tmp/p2o-research/p2o-constraints.md` (482 lines) | Census of every hard/default/prompt-level constraint in `src/`, `extensions/p2o/`, `docs/`, with `file:line` |
| `tmp/p2o-research/artex-offense.md` (454 lines) | ARTEX source read for execution sessions, PTY family, network/pivot absence, guards, budgets and evidence/severity |
| current `src/`, `extensions/p2o/`, `docs/`, `skills/` (read-only) | The seams the workstreams touch, re-verified; §12 records the four places the census was corrected by the code |

The same disclaimer extends to Part II: it reads ARTEX source to establish a mechanism floor, not an effectiveness
benchmark, and its own §12 records where the reference and the census were wrong.

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
| Intent terminal states are semantically distinct and resumable: `done` / `exhausted` (budget cut) / `blocked` (external failure) / `stopped` (killed), with reopen-from-transcript | `db/exploration.go:322-336`; `agent/planner.go:327`; `agent/worker.go:500-514` | A cut-short direction is retried or continued next round, not written off | Statuses `reported\|reviewed\|closed\|blocked\|cancelled\|expired` (`src/tasks.ts`) plus live-pane reuse `p2o_workers action=continue`; after teardown nothing resumes — acceptable for P5, debt items carry the re-entry work instead |
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
| **P5 — Campaign horizon (A6)** | Campaign frame, research debt + discharge, obligation/heartbeat wake, feature matrix + depth prompts, round hygiene, finish/report semantics | A6.1–A6.6 suites green; `tsc --noEmit` clean; full vitest green; `detect_changes` clean; `git diff --check`; docs parity (`docs/WSTG_MAP.md`, `docs/ACCEPTANCE_MATRIX.md` P5 section added with exact `<file>.test.ts :: <title>` citations) | **Measured: PASS 6/6** on `run-615f7a9a-412e-47ed-81d0-5059406dc5ef` — 69.8 min, $1.5703, 12 planner rounds, heartbeat 1 + event 9 wakes, 0 stall/escalation/resume, one accepted Low case, honest partial report; `tmp/p2o-live/gate-verdict3.md`. Two infrastructure defects were recorded and deliberately not patched: storage `BUSY` under a concurrent external reader, and `campaignFold()` scanning only the newest 100 lifecycle records (`src/state/store.ts:694-702`). |
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
- No scope widening by the host, no new target authority. **Amended in Part II (P7, owner decision 2026-10-26):** an exploit campaign — now the default mode — automates an authorized exploit chain on the authorized target: that is what Part II designs and what its measured gate checks; `--mode assess` keeps this Part I non-goal exactly as written.
- No chapter-2 rewrite: A1–A4 remain as committed; A6 is additive and gated, and P7 is additive to both.
- **No auto-resume after a process restart.** Recovering a run opens knowledge and restores no
  execution authority; P5 adds no engine revival, no suspended queue and no automatic re-dispatch.
  A long campaign is one uninterrupted process; a restart ends it and leaves a debt report for the
  next run.
- **No automatic surface expansion in P5** (no asset-enrichment sweep, no traffic archive/recorder,
  no api-recon skill port). ARTEX grows the surface mechanically; P2O first has to keep a campaign
  honest on the surface it already has. Revisit as P6+ if the measured gate shows the loop is stable
  but the denominator is the bottleneck.
- No promise of RCE/LPE gain for P5. P5 makes a campaign continue and report honestly; whether it finds deeper
  bugs is what the deferred measured gate is for. **Part II (§14) supersedes this non-goal for ladder runs:** it
  proposes the mechanics and a measured access-ladder gate, without promising a result and without running anything
  un-authorized.

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

---

# Part II — P7 proposal: the access ladder (internal network → RCE → LPE)

**Status: proposal only.** Nothing below is implemented. Part I (§1–§7 and appendices A–C) is the P5 campaign-horizon
revision: it was implemented in `18c0427`, `6439eec` and `49930d5`, and its measured gate now passes 6/6 on
`run-615f7a9a-412e-47ed-81d0-5059406dc5ef` (69.8 min, $1.57, 12 rounds, 0 escalation, 0 human resume, one accepted Low
case, honest partial report). Part I is kept as the closed record; everything from §8 down is the new revision this
document exists for.

The goal this revision answers is the extension's actual purpose, in the owner's words: **research bugs and
vulnerabilities to get into the internal network, to RCE, then LPE — or something else critical/high.** A campaign that
returns a set of true read-only observations has not answered that question.

**What this revision does not do:** it does not add a token, wall-clock or round budget (Part I D8 stands), and it does
not promise exploitation performance. It adds the *mechanics* a run needs to climb an access ladder at all, plus the
policy layer that makes it safe to authorize. Whether the ladder gets climbed is what the measured lab gate of §14.2
is for.

Evidence used in this part (all read-only; no model call, target contact or commit made by the study):

| Source | What it establishes |
| --- | --- |
| `tmp/p2o-live/REPORT-run5-final.md`, `tmp/p2o-live/final-metrics-run5.txt` | What the 70-minute campaign actually did: 20 tasks, 217 worker target operations, 0 exploitation/chaining tasks, 1 accepted Low case, the run's own exclusions |
| `tmp/p2o-live/gate-verdict3.md` | The measured P5.1 gate: 6/6 criteria, plus the two infrastructure defects (storage BUSY, campaign fold) |
| `tmp/p2o-research/p2o-constraints.md` (2026-10-26) | Census of every hard/default/prompt-level constraint in `src/`, `extensions/p2o/`, `docs/`, with `file:line` |
| `tmp/p2o-research/artex-offense.md` | ARTEX source read for execution sessions, network/pivot mechanics, budgets, guard rules and evidence/severity |
| `my_references/ARTEX/` (Go, ~336 files) | The reference implementation behind that study |
| `tmp/p2o-logs/artex-long-horizon.md`, Part I §2 | The continuation mechanisms already ported (or deliberately not) by P5 |

## 8. Why the current workflow cannot reach the goal today

### 8.1 The goal, and what "proof" means here

The engagement this revision serves is not "more coverage". It is a **demonstrated path from the exposed surface into the
internal network and forward to code execution and privilege escalation** — typically: an entry bug (injection, file
write, SSRF, deserialization, auth bypass) → code execution or a session on a host → discovery of an internal-only
service → a second boundary crossing (lateral host, database, admin panel) → local privilege escalation. "Critical/high"
is whatever the report can demonstrate at the furthest executed rung; below that it is a hypothesis.

Three definitions make the rest of this part testable:

- **Rung.** What the run *did* to the target, not what it believes: `observed` (a response was returned), `executed` (a
  payload ran and produced an effect), `controlled` (two chosen inputs, two named outcomes), `crossed` (a
  privilege/tenant/network boundary was crossed and seen from the far side), `impact` (the crossing reached the
  campaign's accepted impact: shell, internal reach, root).
- **Session.** A run-owned execution context that outlives one assignment: a container, its processes/listeners and its
  working files, with an id the ledger can name.
- **Ladder.** The ordered capabilities between the starting surface and the impact proof. P2O already has the vocabulary
  (`src/capabilities.ts:11-15`: `net.egress`, `http.request`, `file.read/write`, `exec.code`, `host.shell`, `cred.session`,
  `cred.secret`, `auth.bypass`, `cloud.role`, `admin.ui`, `data.read`, `db.query`, `deserialize`, `dns.resolve`) and a goal
  can name a capability as its proof (`src/goal-proof.ts:16-19`). What does not exist is the machinery that lets a run
  *climb* that vocabulary: a session to climb in, a credential to climb with, and a chain that is admitted as a chain.

### 8.2 What the measured campaigns actually did

| Measurement (`run-615f7a9a`, 69.8 min, $1.57) | Value |
| --- | --- |
| Tasks | 20 created/dispatched: 3 recon, 12 discovery, 5 validation |
| Tasks with `purpose=exploitation` or `chaining` | **0** |
| Goals whose proof was a typed capability | **0** (the campaign recorded goals, but no impact proof) |
| Worker target operations | 217 (all returned exit 0) |
| Accepted cases | 1 (Low: zone-wide cookie name collision) |
| Coverage | 38 live cells, 29 tested, 78 open gaps, 254 named debt items |
| The run's own exclusions (recorded by the lead) | "State-changing probes … outside the read-only risk limit used throughout this …"; "Authenticated or credentialed functionality … an operator credential is required for the CMS admin area and CAS SSO …"; "Non-HTTP services and ports whose only proof would be exploitation outside an HTTP evidence contract" |

The run produced a genuinely good read-only assessment. It never attempted a rung above `observed`, and the phrase
"read-only risk limit" that limited it exists nowhere in the code — it was the model's own risk appetite written into an
undefined field (§8.6).

The earlier observed session in Part I §1.1 shows the same shape one level down: the model's first-turn roadmap declared
*"anonymous, read-only, non-destructive observation only"* and *"Explicitly out of scope: credential attacks, injection
payloads, authenticated flows, brute force, or any state-changing request"*. Nothing in the workflow asked it to; the
plan then recorded those as exclusions, which the debt system treats as settled scope.

So the loop is healthy (Part I's measured gate passes) and the model is capable. What is missing is the substrate and the
demand: **nothing in the workflow can hold a foothold, and nothing requires an executed rung.**

### 8.3 Constraint census — what is actually strict

Legend: **open** = no host limit; **default** = a shipped value the operator can change; **hard** = code refuses or
ignores; **absent** = the mechanism does not exist.

| Dimension | Today | Verdict | Why it weakens the ladder | Where |
| --- | --- | --- | --- | --- |
| Wall-clock, tokens, turns | No elapsed-time limit; no token/turn/spend cap; commands default `timeout=0` | **open** | Time is *not* the constraint — a run may work for hours | `src/prompts.ts:67`; consent text `extensions/p2o/index.ts:2291`; `src/sandbox.ts:122-123` |
| Sandbox privilege | root, writable rootfs, default cap set, no pids/mem/cpu limits; arbitrary shell ≤8192 chars | **open** | Tooling install, compilation, exploit code execution all possible *inside* the sandbox | `src/sandbox.ts:13-19,111,123` |
| Network egress | bridge; public/private/link-local/metadata/host-published services reachable; opaque commands not origin-filtered; `p2o_http` any URL/hop/method/header | **open** | Internal scanning, callbacks out, and SSRF-style pivots are already possible | `src/target.ts:181-195`; `extensions/p2o/index.ts:1714-1718` |
| Network ingress | bridge NAT, no published ports, no listener/tunnel verb (`grep tunnel src/*.ts` → comments only); `p2o_lab` services run inside the same sandbox, so they are not a callback endpoint either | **absent** | A real target cannot call back: no reverse shell, no beacon, no port-forward held by the run | `src/sandbox.ts:76-83`; `src/lab.ts:308-321` |
| Session / state across assignments | fresh container per assignment; released at report; ticket revocable; `shared` mode forces target-ops 1 and peers' cancellations kill it | **hard** | A shell gained in step N cannot be used in step N+1; the only persistent mode serializes everything | `src/executors.ts:8-43,45-68`; `extensions/p2o/index.ts:738-748,2280-2281` |
| Interactive execution | one blocking command with a 48 KiB output window; background services only via a declared environment recipe with healthcheck; no stdin cursor | **absent** | `sudo -S`, `mysql`, `ssh`, `gdb`, `nc`-style shell work and post-exploitation are not expressible | `src/process.ts:3`; `extensions/p2o/index.ts:1592,1685` |
| Credentials / identity | no credential or secret field in `StartOptions` or `P2OSettings`; cookie jar keyed `[actor,session,origin]`; jar never exported | **absent** | Authenticated footholds (the usual first hop into an internal network) are ad-hoc pastes in a prompt | `src/target.ts:17`; `src/roles.ts:102-122`; `src/http-session.ts:40`; `src/sandbox.ts:322` |
| Chain admission | one task per chain step; reviewed predecessor; one host-created validation task per demonstrated claim, replayed by a *different* worker (payload/env compared only when the claim names those artifacts) | **hard** | A 4-rung chain costs ≥8 worker runs and ≥4 rounds; measured rung latency in run 5 was ~5–6 min | `src/prompts.ts:115`; `src/tasks.ts:236-245,311-314`; `extensions/p2o/index.ts:1270-1316`; `src/evidence.ts:136-141`; `src/validation.ts:51-76` |
| Severity / policy basis | severity ≤ furthest demonstrated rung; `policyBasis=inferred` forces `open_proof_gap`; critical/high refused on inferred policy. `boundary_invariant` exists in the vocabulary, but the worker prompt only teaches `inferred` | **hard** | For an undocumented internal service the prompt's only move is "inferred", so the honest headline caps at Medium even when RCE is proven | `src/cases.ts:173-182`; `src/evidence.ts:17,202-204`; `src/prompts.ts:17`; `docs/SKILL_RUNTIME.md:99` |
| Planner observation | planner has no target tool at all | **hard** | Every pivot the planner spots mid-review costs a full dispatch round (steering exists, but observation does not) | `src/tool-policy.ts:21-29`; `extensions/p2o/index.ts:2557-2560` |
| Parallelism | `--workers` default 3; `--target-ops` default 3 isolated / 1 shared; 1000 retained assignments | **default** | Adequate for recon, thin for "scan the internal range while a foothold stays open" | `src/roles.ts:84-88,139`; `extensions/p2o/index.ts:610` |
| Rounds / wakes | round must end with `p2o_loop wait`; 2 quiet rounds pause; 3 stalled rounds with debt escalate; revisit ≤24 h; no auto-resume | **hard** | Long interactive work is pushed out of the turn into the ledger, where a fresh worker must rebuild it | `src/prompts.ts:109`; `src/engine.ts:245-249,281-290` |
| Browser | no browser tool (`grep playwright\|puppeteer\|chrom src extensions` → none) | **absent** | Client-side/browser-oracle chains (XSS→CSRF, some SSO flows) cannot be tested | census §12 |
| Traffic recorder / enrichment | no recording proxy, no automatic asset probe | **absent** | Every request is re-derived; blind spots in multi-request exploit flows; ARTEX has both (§9.1) | Part I §7.2 non-goal; census §11 |
| Evidence bounds | 48 KiB visible output; receipt keeps 4000/1000 chars; artifact page 8 KiB; capture 1 MiB default (8 MiB max) | **hard** | Long exploit transcripts, `dmesg`, hashes and dumps lose the bytes a validator needs | `src/process.ts:3`; `src/evidence.ts:69-70`; `extensions/p2o/index.ts:1684-1692`; `src/roles.ts:95,142` |
| Risk semantics | `risk` is a required, undescribed free-text string on task drafts and coverage cells, used as a join key | **hard (undefined)** | The model filled it with a self-imposed "read-only risk limit"; the field cannot be audited or summarised | `src/tool-schemas.ts:23,182`; `src/tasks.ts:427` |

**Verdict.** The workflow is not weak because it is slow or locked down. Time, egress, shell, root and arbitrary
commands are open. The binding weaknesses are **state (no session), identity (no credentials), ingress (no callback),
chain economy (every rung is a task + review + replay), and semantics (nothing demands an executed rung, and one
undefined field let the model write its own ceiling).**

### 8.4 What is not the bottleneck (do not "fix" these)

- **Time.** There is no elapsed-time, token, turn or spend ceiling anywhere (`src/prompts.ts:67`; the consent block says
  "No elapsed-time limit for the assessment, lead or workers"). Commands and HTTP default to `timeout=0`. The only
  timers are infrastructure watchdogs (30 s per Docker CLI call, `src/process.ts:36-37`; broker RPC 60 s/120 s,
  `src/broker.ts:621`, `extensions/p2o/index.ts:530`). A worker may already run for hours.
- **Capability inside the sandbox.** root, writable rootfs, default capability set, no resource limits, `apt`/`pip`/
  downloads/user-space installs allowed, arbitrary 8 KiB commands (`src/sandbox.ts:13-19,111,123`). Adding a "bigger
  exploit environment" is not the missing piece.
- **Egress.** The sandbox reaches public, private, link-local and cloud-metadata addresses and host-published services;
  opaque commands are not origin-filtered; `p2o_http` accepts any URL, hop, method and header
  (`src/target.ts:181-195`; consent text). Internal-network reachability from the sandbox is not blocked.
- **Spend.** No cap (`src/engine.ts:332`; consent). Provider cost is the operator's ceiling, not a workflow limit.

### 8.5 The six binding constraints

1. **A worker dies when it reports.** `p2o_report` → `revoke(workerId)` → the reaper releases the executor, removes the
   ticket and closes the pane (`src/broker.ts:475,644-648`; `extensions/p2o/index.ts:738-748`). `p2o_workers continue`
   is refused once a report exists. The next step is a new worker with a new scratch, a new cookie jar and a new
   host identity. There is no verb that keeps a session alive across an assignment, and the one long-lived mode
   (`shared`) serializes target operations to 1 and lets one peer's cancellation kill the container
   (`src/executors.ts:8-43,45-68`; `extensions/p2o/index.ts:2280-2281`).
2. **There is no interactive execution.** `p2o_shell`/`p2o_net` run one blocking command with a 48 KiB window
   (`src/process.ts:3`); background processes exist only inside a declared environment recipe with a port/healthcheck
   (`p2o_environment`, `extensions/p2o/index.ts:1592`), not as an ad-hoc listener or tunnel owned by the run; stdin is
   not addressable. Exploit→LPE work is routinely interactive (`sudo -S`, `mysql`, `ssh`, `gdb`, `socat`), and the
   workflow models none of it.
3. **The chain tax.** Every chain step is its own task with a reviewed predecessor (`src/prompts.ts:115`;
   `src/tasks.ts:236-245,311-314`), and every demonstrated claim auto-creates exactly one validation task for a *different*
   worker (`extensions/p2o/index.ts:1270-1316`). Independence is effect-level: a claim that names a payload or environment must
   be replayed with the same sha256 and fingerprint, while a claim that names neither is reproduced by the peer's own
   demonstrated claim against the cited receipt (`src/evidence.ts:136-141`; `src/cases.ts:47-53`; `src/validation.ts:51-76`).
   A four-rung chain is therefore
   ≥8 worker runs and ≥4 plan rounds; run 5 measured ~5–6 min per round, so 4 rungs is ~30+ min of orchestration before
   any payload is written. The independence rule is honest and should stay — but it should validate the *effect*, not
   every packaged intermediate.
4. **There is no identity channel.** `StartOptions` has no credential/secret field (`src/target.ts:17`), `P2OSettings`
   has none either (`src/roles.ts:102-122`), and the cookie jar is keyed by actor, so a validated session cannot be
   reused by the next worker (`src/http-session.ts:40`; `src/sandbox.ts:322`). Prompts assert an operator-supplied
   credential that code cannot deliver (`src/prompts.ts:169`). Run 5 walled a whole class of work on "an operator
   credential is required" while the workflow offered nowhere to put one.
5. **There is no ingress.** The sandbox is on a bridge with no published ports and no listener verb, so a real target
   cannot call back: no reverse shell, no beacon, no SSH/chisel forward held by the run. Internal-network work is
   therefore limited to destinations the sandbox can *reach directly*; the case "only the compromised host can reach
   the internal service" is not expressible.
6. **The semantics suppress depth.** `risk` is a required but undescribed free-text field on every task and coverage cell
   (`src/tool-schemas.ts:23,182`); the model filled it with a self-imposed "read-only risk limit" and then propagated
   that phrase into plan exclusions. The `p2o_http` description still claims origin scoping that code removed
   (`extensions/p2o/index.ts:1718` vs `src/target.ts:181-195`); a skill still asserts a non-root sandbox
   (`skills/race-condition-auditing/SKILL.md:40`); `--avoid` has no `allow` counterpart (`src/campaign.ts:87-101,180`);
   and although `proof.kind='capability'` exists (`src/goal-proof.ts:16-19`), no measured campaign recorded one — the
   planner has no instruction, template or debt item that asks "what capability would settle this, and what is the next
   rung?".

### 8.6 How the constraint surface produces the behaviour

The model is not refusing depth out of caution about the target; it is filling a vacuum. It reads (a) an objective shaped
as coverage, (b) an undefined `risk` field it interprets as risk appetite, (c) a `p2o_http`/sandbox description that
understates what the sandbox can do, (d) an evidence model whose only depth instruction is "severity stops at the
furthest executed step", and (e) a debt model where a demonstrated primitive can be settled with a `deferred` todo
rather than a successor (`src/obligations.ts:96-111`). It then writes a defensible read-only plan. The fix is not a
stronger warning; it is an object that requires an executed rung, a session to execute it in, and an identity to execute
it with.

A secondary, measurable cost: run 5's admission friction (31/49 `p2o_task_create` refusals, 63.3%) spent planner turns on
schema correction rather than depth. P2.4 (actionable messages for the remaining three groups: `Invalid work variant`,
`Invalid case affected variant`, "Structured decision/retest/output contract requires a work identity") remains worth
doing, but it is not the lever this revision turns.

## 9. ARTEX as the standard

### 9.1 The mechanisms relevant to depth

Citations are against `my_references/ARTEX/` at the snapshot in this repo. The prior P5 study (`tmp/p2o-logs/artex-long-horizon.md`)
already covers continuation; this table covers *execution, network, policy and loss*.

| Mechanism | ARTEX | Why it matters for internal network → RCE → LPE | P2O today |
| --- | --- | --- | --- |
| Persistent interactive shell family | `db/config.go:452` (interactive_shell = "持久 PTY 会话工具族"); default-on for planner/worker/mainagent/auto `db/db.go:246-251` | A foothold is a *place you stay*, not a command you repeat. Post-exploitation, `sudo -S`, DB clients and tunnels all need a session | no PTY, no stdin; one blocking command per call |
| Per-intent session resume | `agent/worker.go:497-508` — deterministic transcript ID per intent, `s.Resume()` continues a paused/blocked/exhausted intent | A cut-short exploit continues from its own context instead of restarting from a brief | `p2o_workers continue` exists but only before a report; a reported worker is terminal (§8.5-1) |
| Background-task manager per session | `agent/worker.go:498` (`s.Close()` releases the session's temp dir + processes); `DisableBackgroundTasks` exists for non-worker agents `agent/goals.go:158` | Listeners, tunnels and long jobs belong to the session, not to one command | background services exist only inside a verified environment recipe with a healthcheck |
| Budget settlement instead of a kill | `agent/worker.go:521-530` (MaxTurns/MaxDuration → wrap-up turn, terminal `exhausted`); wrap-up prompts `db/config.go:453-455`; per-intent `run_seconds` `db/schema.sql:798`, `agent/planner.go:327` | A 20-minute exploitation intent ends by writing back what it learned and saying how far it got — resumable | no per-intent limit at all; a cancellation destroys the executor and the in-flight state |
| Recording proxy + traffic archive | worker prompt carries a proxy address (`db/db.go:203-209`); `agent/proxyenv_test.go`; `traffic/traffic.go:1-4,78-84` | Multi-request exploit flows are opaque today; a recorder gives replay, search and evidence | absent (Part I §7.2 non-goal) |
| Guard / intercept layer | PreToolUse hook + audit log (`guard/guard.go:1-14`); DB-backed rules with `allow`/`deny`/`ask` and human approval (`intercept/intercept.go:1-25`); built-in deny seeds for destructive commands (`db/db.go:350-430`) | Deep exploitation needs a policy layer that can say "yes to RCE, no to `rm -rf`", auditable and operator-editable | nothing: arbitrary commands, no policy, constraints are model-level text only |
| Runtime steering and policy edits | `steer_work`, `add_hint`, `set_goals`, `set_constraints` (`agent/tools_insert.go:665-700`) | Mid-exploit correction without killing the session; operator can raise/lower authorization while work runs | `p2o_workers action=steer` exists (good); no runtime goal/constraint edit |
| Scope and surface management | `add_task_scope`, `add_company_scope`, `list_untested_assets`, enrichment (`db/db.go:203-211`; `agent/tools_insert.go:645-665`) | Internal discovery must be able to *add* a range/host to the denominator while the campaign runs | scope is a start-time label; no runtime scope object |
| Single-agent full-chain mode | built-in "独立渗透" agent runs recon → exploit → verify → wrap-up in one chain (`db/db.go:212-213`) | Contrast: one long-lived chain vs P2O's strict delegation; a middle path is chain-in-session | strict planner/worker split, one intent per worker |
| Retester role | `agent/retester.go` | Re-verification is a first-class actor | `retest` purpose exists; no dedicated role |
| Cold-graph digests / compaction | `agent/coldgraph.go`, `agent/compaction.go` | Already ported by P5 (round hygiene, context packets) | done |

### 9.2 What ARTEX does not have, or deliberately removed

- **No scope enforcement.** The RoE authorization-scope mechanism was removed (`guard/guard.go:5-8`); safety rests on
  configurable intercept rules plus audit. P2O should keep its "target is a label, not a boundary" model, but add an
  **operator-declared allow list** so that depth has a recorded permission rather than only prohibitions (D18).
- **No spend cap** (metered only) — Part I's D8 also keeps no budget; this revision adds none.
- **Its shell, browser and file tools come from the `norma` harness**, not from ARTEX's own tree; ARteX's skills include a
  playwright CLI (`my_references/ARTEX/skills/playwright-cli/`). "ARTEX parity" therefore means *granting a persistent
  execution surface*, not copying a container design.
- **Planning is a fresh LLM session per wake**; P2O's durable plan board is stronger and stays (Part I §2).
- **Restart resumes execution loops** (`server/server.go:264-292`); P2O deliberately does not restore authority after a
  restart (Part I invariant 9). That divergence stays.

### 9.3 What "standard" means here

A standard is a floor of mechanisms, not a benchmark. This revision takes ARTEX's *session, steering, guard and
settlement* mechanics, keeps P2O's stronger honesty rules (independent validation, severity ≤ demonstrated rung, one
ledger), and does not claim ARTEX's results. Nothing in this part proves ARTEX finds more bugs; it says "ARTEX has these
mechanisms and P2O does not".

## 10. Invariants for a ladder run (A7)

These extend Part I §3. Each is stated so a test can fail on it.

1. **A ladder run records an impact objective.** Before the first exploitation dispatch, the plan board holds a goal whose
   proof is a typed `capability` (`src/goal-proof.ts:16-19`) — the capability is the rung the run promises to gain — and
   the campaign mode is recorded in the campaign frame. Coverage goals remain, but cannot be the only goal.
2. **A session is a run-owned object with a lifecycle.** It is created only by the host, named in the ledger, attached to
   the tasks that use it, counted against target-operation admission while open, and closed (with verified container
   removal) by finish/stop. No session survives the run, and no session is implicit.
3. **A session can outlive an assignment without outliving the run.** A chain successor that consumes the predecessor's
   actual output may run on the predecessor's session and ticket; a *new surface* still needs a new task. The runtime is
   counted, never hidden.
4. **Rungs are recorded, and severity is bounded by them.** The host derives the rung actually executed
   (`observed|executed|controlled|crossed|impact`) from the claim and chain fields that already exist, and the report prints it;
   no new ledger field is added. The existing severity ceiling stays (`src/cases.ts:173-181`). A step recorded as executed must
   point at a confirmed, tested claim (already true for chain entries; this revision extends it to session steps).
5. **Credentials are host-injected, never model-carried.** A secret reference resolves at execution time; the secret's
   bytes appear in no record, prompt, ticket, report or export; every use is an attributed record naming the task and the
   command class. An `--identity` file is the only operator channel (D18).
6. **Every target command passes the policy layer.** Deny rules are hard refusals with a stated reason; ask rules pause
   the operation until an operator decision; allow rules are recorded as the authorization they are. The audit covers
   command text, rule id and decision for every exec/net/http call. No tool bypasses it.
7. **Independence stays real.** Validation still uses a different worker; the replay is of the *effect* — same target
   revision and, where a payload exists, the same payload sha256 and environment fingerprint, or (for live effects with
   no packaged payload) the same reproduction steps. The mode used is recorded, so a reviewer can tell which kind of
   independence was established.
8. **No silent narrowing.** An exclusion that blocks the impact goal must be operator-sourced; a model-authored exclusion
   cannot settle a rung. `risk` becomes a closed category vocabulary, not a risk appetite.
9. **No new budget, no auto-resume.** D8 stands: no token, wall-clock or round allowance. A restart still restores no
   execution authority; sessions are runtime objects, not durable ones.
10. **The report states the ladder honestly.** Executed rungs, the wall that stopped each unfinished rung, the furthest
    proven impact, the sessions used and cleaned, and every secret reference used (by id, never by value).

## 11. Decisions (D15–D24)

| ID | In one line |
| --- | --- |
| D15 | **Engagement mode is explicit, exploit by default.** `--mode exploit` (the default; access ladder, owner decision 2026-10-26) and `--mode assess` (opt-in read-only assessment) with operator-confirmed effect classes; the host refuses an exploitation/chaining task until the plan board holds a capability-proof goal, and assess mode refuses exploitation intents outright. |
| D16 | **Session primitive.** `p2o_session` (open/exec/listen/upload/download/snapshot/close) and `--executors session[:N]`: run-owned persistent sandboxes, counted against target-operation admission; `N` defaults to the target-operation cap so sessions can run in parallel up to that cap (owner decision 2026-10-26); close is verified and run by stop/finish. |
| D17 | **Interactive PTY.** `p2o_shell` gains `session=<id>` with `send`/`read` cursor semantics backed by one long-lived PTY process per session; output is bounded and audited; no host shell is ever created. |
| D18 | **Credential channel.** `--identity <file>` read by the host (never by the model), sealed 0600 in the run's private control directory, materialized only at dispatch through `${P2O_SECRET:<id>}` with redaction and a per-use audit; `p2o_secret` lists ids only; cookie jars are keyed `[principal, session, origin]` so a validated session is reusable inside the same live session; `cred.session`/`cred.secret` capabilities may bind to secret ids. |
| D19 | **Chain-in-session economy.** A `chaining` successor may execute on the predecessor's session/ticket when it consumes the predecessor's actual output; each step still records its own claim; a new surface still needs a task. |
| D20 | **Effect ladder, taught and printed.** Rungs are derived host-side (no new ledger field); receipt stdout/stderr bounds rise to 16 KiB / 4 KiB with `p2o_capture` as the long-output citation; the already-existing `policyBasis=boundary_invariant` is *taught* for effect-established boundaries (unauth RCE, root-owned write, metadata SSRF) so an undocumented service no longer forces `inferred` + Medium; report gains `## Access ladder`. |
| D21 | **Command policy layer (guard).** A host-side policy evaluated before every exec/net/http call: seeded deny rules (destructive system commands), operator rules from settings (`ask`/`deny`/`allow`), `/p2o approve` for pending ask decisions, complete audit. Seeds are disable-able by the operator, like ARTEX's built-ins. |
| D22 | **Ingress and callback.** Operator-declared out-of-band endpoint (`--callback <http(s) URL>`) and a session listener registration; `--lab-network <name>` attaches the sandbox to the operator's throwaway docker network so reverse shells and pivots are testable end to end; no host port is published, and the no-callback fallbacks for real NAT'd targets are documented. |
| D23 | **Runtime steering and permissions.** `p2o_loop` gains `hint` and `constrain` (append-only records rendered into the next prompt) and `--allow` produces a recorded `rule:'allow'` constraint; goals stay on the plan board (`p2o_plan_revise`); `p2o_workers action=steer` is kept. |
| D24 | **Semantics truth pass.** `risk` keeps its name for record compatibility and gains a definition (a grouping label, not a risk appetite); stale capability text is regenerated from `src/sandbox.ts`/`src/target.ts` (p2o_http origin scoping, root/capabilities, raw sockets, non-root skill claims, report scope/severity claims). |

## 12. What the census asked for, and what the code actually says

Drafting this part corrected four items in the census, and the corrections change the work. They are recorded first so the
workstreams do not "fix" a problem the code does not have.

| Census claim | What the code says | Consequence for P7 |
| --- | --- | --- |
| "Unpackaged chains can never be independent" (census §12.4) | Independence has a fallback: when a claim names no `payloadRef`/`environmentRef`, a peer's own demonstrated claim against the cited receipt is enough (`src/evidence.ts:136-141`; `src/cases.ts:48-53`); a reviewed validation task is a second independence path (`src/cases.ts:87-94`; `src/validation.ts:51-76`). Payload/environment must match only when the claim names them. | The cost is orchestration (a task, a review, a replay per demonstrated claim), not an unreachable gate. A7.5 reduces orchestration without weakening effect-level independence. |
| "`boundary_invariant` must be added" (D20 as first drafted) | It already exists in the closed vocabulary (`src/evidence.ts:17`) and is documented (`docs/SKILL_RUNTIME.md:99`); the test suite uses it as the default fixture basis. What is missing is *teaching*: the worker prompt says "set policyBasis=inferred and open_proof_gap until the contract is established" (`src/prompts.ts:17`) and never mentions the effect-established alternative. | D20 is narrowed to teaching and exercising the existing vocabulary, plus the report section and receipt ceiling. No new policy vocabulary, no new effect enum. |
| "Severity is limited by policyBasis" | True but narrower than stated: `inferred` forces `open_proof_gap` (`src/evidence.ts:202-204`), a chain step must be a confirmed tested claim (`src/cases.ts:173-175`), and a case resting on an inferred basis cannot be rated above medium (`src/cases.ts:182`). `boundary_invariant` is accepted by the same code path today. | For an undocumented internal service, the run needs to *use* `boundary_invariant` when the effect itself proves the boundary. That is a prompt/tool-description change, not a validator change. |
| "No ingress" needs a host port | Correct, and stronger: `docker create` publishes nothing (`src/sandbox.ts:76-83`) and `p2o_lab` environment services are launched *inside the same sandbox* (`src/lab.ts:308-321`), so they are not a callback endpoint either. ARTEX has the same gap — no pivot/tunnel/SOCKS subsystem exists in its tree (artex study §2). | D22 is a P2O addition, not ARTEX parity: an operator-declared callback plus an optional shared docker network. Neither is "publish a host port". |

Two further facts the workstreams depend on:

- `risk` is cosmetic prose, not a control: it is clamped at 200 characters on admission (`src/tasks.ts:143-148,120`), used as
  an assignment-conflict key (`src/tasks.ts:427-428`) and printed as a `surface × risk` label (`src/tasks.ts:457-458`), and
  `src/coverage.ts` never reads it. The self-imposed "read-only risk limit" was the model giving an undescribed field a meaning.
- The evidence ceiling is a bound, not a gate: visible output is 48 KiB (`src/process.ts:3`), but the citable receipt keeps
  4000 stdout / 1000 stderr characters (`src/evidence.ts:69-70`), while `p2o_capture` can read up to 8192 KiB of scratch
  (`src/roles.ts:95,142`; `extensions/p2o/index.ts:1684-1692`). Long exploit transcripts therefore *exist* and are *not citable*
  in the receipt a reviewer reads.

## 13. A7 workstreams

Each workstream names the decision it implements (§11), the exact seams it changes, the hermetic gate that proves it, and the
measured-gate criterion (§14.2) it feeds. Nothing here is implemented by this document.

### A7.1 — Engagement mode and the impact objective (D15)

**Change.**

- `StartOptions` gains `mode?: 'assess' | 'exploit'` (default `exploit`, owner decision 2026-10-26) and `effectClasses?: CaseEffect[]` (`src/target.ts:17`).
  `parseCommand` gains `--mode assess|exploit` and repeatable `--effect <class>` (`src/target.ts:40-107`); `--effect` is legal
  only with `--mode exploit`, is validated against `CASE_EFFECTS` (`src/cvss.ts:38`), and defaults to every effect except
  `availability-loss`.
- `CampaignRecord` gains `v: 2` with `mode`, `effectClasses`, `callback?`, `labNetwork?` fields; `parseCampaign` keeps accepting
  `v: 1` and reads it as `mode: 'assess'` (`src/campaign.ts:16-25,113-141`). `campaignFrom` takes the new fields
  (`src/campaign.ts:143-156`) and `campaignStartLine` prints them (`src/campaign.ts:174-187`).
- The confirmation dialog states the mode and the authorized effect classes in the same block that already discloses egress,
  root, credentials and spend (`extensions/p2o/index.ts:2291-2292`).
- **Admission rule (host, not prompt).** In `exploit` mode (the default), `p2o_task_create` refuses a task whose `work.purpose` is
  `exploitation` or `chaining` until the plan board holds a `goal` row with `proof.kind === 'capability'` or `'case'`
  (`src/planning.ts:110-113`; `src/goal-proof.ts:16-19`). The refusal names the missing goal and legal next step, in the style of
  `CHAIN_READY_UNDISPATCHED` (`src/obligations.ts:96-111`). In `assess` mode the same tool refuses an exploitation/chaining
  purpose with `ASSESS_MODE_REFUSES_EXPLOITATION` and a legal next step. `assessment` and `validation` purposes are unaffected.
- Prompt side: an `EXPLOIT MODE` block in the planner instructions names the goal contract ("an impact goal is a capability
  proof; the ladder starts at the surface you were given") and a worker `PURPOSE` line for exploitation/chaining. The
  `risk` sentence is replaced by a label definition (A7.10).
- The final report names the mode and the effect classes; `## Scope and limitations` stops claiming a read-only instrument
  (A7.10).

**Why it changes depth.** Today the only statement of the engagement's shape is the model's own reading of a coverage objective
(§8.2), and the one undefined field let it write a ceiling. A mode makes the intent a host-checkable object; the capability-proof
goal gives "depth" a definition the ledger can settle, because `goalProofRefusal` already refuses a goal that no demonstrated
claim satisfies (`src/goal-proof.ts:38-60`).

**Not in scope.** No seatbelt on what the planner may plan in assess mode beyond exploitation/chaining purposes; no change to
how many workers or rounds a run gets.

**Hermetic gate.** Parser unit tests (mode/effect validation, effect without mode refused, unknown effect refused); campaign v1
record reads as assess, v2 round-trips; task admission refuses exploitation without a capability goal and accepts it with one;
refusal text carries a legal next step; report prints the mode. Existing task-admission tests keep passing unchanged in assess
mode.

**Measured gate.** Negative control N1 (assess mode refuses the six exploitation intents, 0 exploitation tasks). Main gate
criterion G1 (a capability-proof goal is settled by a demonstrated claim).

### A7.2 — Session primitive and the `session` executor mode (D16)

**Change.**

- `ExecutorMode` becomes `'shared' | 'isolated' | 'session'` (`src/executors.ts:3`). The session pool keeps a long-lived
  sandbox per session id instead of one per assignment: `acquire(sessionId)` creates once, `use(sessionId, …)` routes to it,
  `release(sessionId)` is the only path that stops it (`src/executors.ts:8-43,45-68`). The target-operation gate still applies
  to every command (`use` keeps the `maxOperations` semaphore, `src/executors.ts:56-68`), so a session multiplies *state*, not
  *target pressure*.
- `Sandbox` gains a session label and a per-session workdir: the existing `create(network, …)` path is reused
  (network `bridge` by default, replaced only by A7.8's `--lab-network`) with
  `--label pi-p2o.session=<id>` and `workdir /work/sessions/<id>` (`src/sandbox.ts:76-83,110-127`). Session removal is the
  existing verified `removeAll()`/`stop()` path (`src/sandbox.ts:313-330`); no new sweep logic.
- `StartOptions.executorMode` accepts `'session'` and the parser gains `--executors session[:N]` (`src/target.ts:17,40-107`;
  `src/roles.ts:106,138`); N defaults to the target-operation cap (owner decision 2026-10-26), so one live session per concurrently
  allowed target operation, and it is still capped by `maxTargetOperations` rather than a new setting.
- New host tool `p2o_session` with `open|list|exec|listen|upload|download|snapshot|close` (registered beside
  `registerExecTool`, `extensions/p2o/index.ts:1698-1711`), added to `TARGET_TOOLS` and `WORKER_TOOLS`
  (`src/tool-policy.ts:12-15,30-34`). The planner does **not** get it. A validation worker gets `open` only: it must never
  attach to the discovery session (A7.5), so independence is not bought by inheriting a shell.
- `p2o_shell`/`p2o_net` gain `session?: string`; the ticket records the session it is bound to; every receipt gains
  `sessionRef` next to the existing `http.session` field (`src/evidence.ts:65-77`). Broker gains `session` verbs; tickets carry
  the session id so a worker cannot name a session it was not given (`extensions/p2o/index.ts:1698-1711`).
- Lifecycle: sessions are opened only while the run is active, counted in owner snapshots, listed by `p2o_session list`, closed
  by `stop`/`finish`, and their verified removal is a finish fact. A session has no timer and does not survive the run.

**Why it changes depth.** A foothold is a place, not a command. Every current executor is fresh per assignment and released when
the worker reports (`extensions/p2o/index.ts:738-748`; `src/broker.ts:475-476`), so the credentialed session, the uploaded
payload, the listening tunnel and the working files of step N cannot be used by step N+1 (§8.5-1). `shared` is not a
substitute: it serializes target operations to 1 and lets one peer's cancellation kill the container
(`src/executors.ts:8-43,45-68`).

**Not in scope.** No sessions that survive `stop`; no session resumption after a restart (D8/invariant 9); no host mount, no
Docker socket, no published port in this workstream (A7.8 handles inbound).

**Hermetic gate.** Pool state machine with a fake sandbox: one container per session, reuse across assignments, op-gate
accounting, release exactly once, cleanup failure surfaces as unresolved rather than silent; a session is never routable after
stop; shared/isolated regressions unchanged; `p2o_session` refuses a session id the ticket does not hold; report and snapshot
list open sessions.

**Measured gate.** G3 (a chain successor executes in the predecessor's session), G6 (verified cleanup: no `p2o-*` container
left).

### A7.3 — Interactive PTY (D17)

**Change.**

- New `src/pty.ts`: one long-lived child per session, `docker exec -i -t <container> /bin/sh` over pipes (the container needs
  no new tooling; `-t` gives the target-side TTY that `sudo -S`, `mysql`, `ssh`, `gdb` and REPLs expect). `runFixed` stays for
  one-shot commands (`src/process.ts:10-45`); the PTY uses its own streaming wrapper, owned by the host, tracked for cleanup.
- `p2o_shell` gains `send` and `read` semantics on a session: `send` writes bytes and returns output up to a sentinel or the
  timeout; `read` returns bytes after a cursor. The cursor lives host-side, never in the model. Retained buffer is bounded
  (64 KiB per read, 256 KiB ring) and every `send` records one receipt segment so the transcript remains citable.
- Output redaction and secret substitution apply to PTY I/O exactly as to one-shot commands (A7.4). The policy layer evaluates
  each `send` (A7.7). A session object without a live PTY opens one lazily; a dead PTY fails closed and asks for a new session,
  never a silent re-exec.
- Cleanup: closing a session kills its PTY child before the container is removed; a killed run never leaves a live
  `docker exec` grandchild (`src/sandbox.ts:313-330` is the removal path).

**Why it changes depth.** Post-exploitation is interactive: `sudo -S`, a database client, an SSH session with a password
prompt, `gdb`, a reverse-shell handler. Today one blocking command with a 48 KiB window is the entire execution model
(`src/sandbox.ts:110-127`; `src/process.ts:3`), so the steps that turn code execution into *control* are not expressible
(§8.5-2). ARTEX treats a persistent PTY family (`shell_open/send/read/close/list`, gated by `agents.interactive_shell`,
`server/assembly.go:310-318`) as a default tool for its planner and workers; this is the one ARTEX mechanism whose absence most
directly limits a ladder.

**Not in scope.** No host shell, ever: the PTY child is `docker exec` into the run's own container, and the command text is
audited. No browser terminal, no GUI.

**Hermetic gate.** Fake docker runner drives the streaming wrapper: send/read cursor semantics, sentinel not required for raw
`read`, bounded buffer, output truncation flagged, kill-on-close, dead-child fail-closed, policy evaluation called for every
send; no PTY survives `stop`.

**Measured gate.** G2 (an interactive rung: a `sudo -S` or database REPL step executed and evidenced in a session).

### A7.4 — Identity and credential channel (D18)

**Change.**

- `StartOptions` gains `identityPath?: string` (the *path*, never a value) (`src/target.ts:17`); the parser gains
  `--identity <file>` (`src/target.ts:40-107`). The host validates an absolute regular file ≤64 KiB, parses a bounded JSON
  schema (`principals: {id: {label?, secrets: {id: {kind, value}}[]}}`), and seals a 0600 copy in the run's private control
  directory through the same path discipline as the payload store (`src/lab.ts:1-40`). Only secret ids, kinds and principal ids
  ever enter a prompt, brief, task, receipt or report.
- New worker tool `p2o_secret` with `list` (ids/labels/kinds only) and nothing that returns a value. Substitution is host-side
  at dispatch: `${P2O_SECRET:<id>}` in a command, header or body is replaced with the value after the policy layer approves the
  use; the placeholder text is what the ledger and the model see. The exact value bytes are redacted from stdout/stderr before a
  receipt, a capture or model output is written (`src/evidence.ts:65-77` redaction path), and every use writes a bounded
  `secretUse` lifecycle record naming secret id, task ref, operation and command class.
- `p2o_http` gains `principal?: string`; the cookie jar is keyed by `[principal, session, origin]` instead of `[actor, session,
  origin]`, so a session validated by worker A is reusable by a chained worker B *in the same session executor*
  (`src/http-session.ts:40`). The 64-jar × 64-cookie × 8 KiB caps stay. No jar export: reuse needs the same live session, which
  is honest about what "same identity" means.
- `cred.session` / `cred.secret` capabilities may name a secret id in their `subject`/`scope` (`src/capabilities.ts:11-15`), so a
  chain step's need can be "a session as alice" rather than "a session".
- Prompt and consent text change from the false claim ("Credentials must be operator-supplied",
  `src/prompts.ts:169`; "Supplied credentials … may reach your model provider", `extensions/p2o/index.ts:2291`) to what the run
  actually does, including the limitation below.

**Honest limitation, stated in the report.** The worker is root in its sandbox and can print a substituted secret; exact-byte
redaction is best-effort against a model that encodes it. The real controls are: the operator declares which principals exist,
the policy layer can deny a secret for a command class (A7.7), every use is audited, and secrets are absent from exports and
reports by construction. P7 does not claim a secret cannot be exfiltrated by the worker that is authorized to use it.

**Why it changes depth.** Authenticated footholds are the usual first hop into an internal network. Today there is no channel at
all (no field in `StartOptions`, `src/target.ts:17`; none in `P2OSettings`, `src/roles.ts:102-122`), so a run either ignores
authenticated surfaces or pastes a credential into a prompt — which run 5 recorded as a wall ("an operator credential is
required", `tmp/p2o-live/REPORT-run5-final.md:22`). Cookie jars are actor-keyed, so the next worker starts as a stranger
(`src/http-session.ts:40`).

**Not in scope.** No credential store beyond the run; no secret auto-discovery; no identity for target-side password changes.

**Hermetic gate.** Identity file validation (size, mode, schema, missing/unknown secret id); substitution with correct quoting
for shell/HTTP; refused use outside an approved class; exact-byte redaction in receipt/capture/report/export (a store-wide byte
scan test); audit record per use; per-principal jars; no value in any prompt string or ledger record; v2 consent text no longer
claims a channel that is absent.

**Measured gate.** G4 (an authenticated step that reaches a privileged surface), G8 (zero secret bytes in the exported report;
every use audited).

### A7.5 — Chain economy: hold, chain-in-session, effect-level validation (D19)

**Change.**

- `p2o_report` gains `holdFor?: {brief: string}` (bounded, one sentence). A report with `holdFor` keeps the ticket, pane and
  session alive for exactly one follow-up `p2o_workers action=continue` with that brief; the reaper leaves it alone
  (`src/broker.ts:475-476` does not revoke; `continuationRefusal` accepts the first continue when `heldFor` is set,
  `src/broker.ts:644-648`; `extensions/p2o/index.ts:738-748` skips held entries). After the continuation reports — with or
  without a hold — the worker is terminal as today. `stop`/`finish` force-release held workers; preflight adds an advisory
  `HELD_WITHOUT_SUCCESSOR` so a forgotten hold is visible in the report (`src/finish-preflight.ts:14-24` adds a code, it never
  refuses).
- A `chaining` successor that consumes a predecessor's actual output may be dispatched to the predecessor's held worker and
  session: `p2o_task_create` accepts `work.claimRefs` citing the predecessor claim and the dispatch names the held worker
  (`src/tasks.ts:305-316` admission keeps its refusal for a *new surface*; the refusal is not applied to the ready step).
  The successor is still its own task with a reviewed predecessor, its own claim and its own receipt trail
  (`src/tasks.ts:236-245`). What is removed is the state loss, not the review.
- Validation economy: `hostValidation` (`extensions/p2o/index.ts:1270-1316`) still creates one validation task per
  *demonstrated* claim, but skips a claim that is only a chain *intermediate* when a successor claim on the same surface in the
  same run is demonstrated; the deepest claim a case rests on always gets its replay, with the skip reason recorded in a
  lifecycle note. This is the effect-level independence rule of §10.7 made operational: the case's headline effect is validated
  by a different worker; every packaged intermediate is not.
- Round cost: a 4-rung chain becomes 4 tasks + 3 reviews + 1 validation replay + 3 continuations, versus today's ≥8 dispatches
  and ≥4 full rounds (§8.5-3). Run 5's measured ~5–6 min per round (`tmp/p2o-live/gate-verdict3.md`) is the number this
  targets.

**Why it changes depth.** The chain tax is the reason a run cannot climb while it finds: every rung costs a dispatch, a review
and a replay from a stranger with a fresh scratch. The independence rule is honest and stays; what was never justified is
throwing away the session, the ticket and the conversation between two steps of the same chain.

**Not in scope.** No auto-continuation without a planner decision (D8: no work budget, no automatic loops); no nested workers;
no revalidation of a validation (`src/tasks.ts:239` refuses that and stays).

**Hermetic gate.** Report-with-hold keeps ticket/session/pane; continue accepted exactly once with the matching brief; second
continue refused; reaper/stop/finish force-release; successor dispatched on the predecessor session; new-surface admission still
refused; validation skip only for intermediates, never for the deepest claim; preflight advisory present; no expiry timer
introduced.

**Measured gate.** G3 (successor on the same session), G5 (validation independence preserved: ≥1 reviewed validation by a
different worker for the headline effect), G10 (chain steps per hour).

### A7.6 — Evidence ceiling, `boundary_invariant`, and the access ladder in the report (D20)

**Change.**

- Receipt ceiling: stdout bound 4000→16384, stderr 1000→4096 (`src/evidence.ts:69-70`), keeping the 2000-char input bound, the
  existing redaction path and the 48 KiB visible cap. The worker prompt gains one line: output above the citable bound must be
  `tee`d to scratch and cited through `p2o_capture` (up to 8 MiB, `src/roles.ts:95,142`), whose artifact id is citable next to
  the receipt. No new artifact store.
- Policy basis teaching, not vocabulary: `EVIDENCE_TAIL` (`src/prompts.ts:17`) is rewritten to say when the *effect* establishes
  the boundary — unauthenticated code execution, a read/write across a principal or tenant boundary that needs no credential, a
  metadata/private-network reach from an attacker-influenced URL, a root-owned write from an unprivileged context — and that
  these take `policyBasis=boundary_invariant` with `expectedPolicy` naming the invariant; `inferred` keeps its current meaning
  (sibling-route comparisons, placeholder credentials, CVE leads) and stays `open_proof_gap`. The same rule is added to the
  `p2o_candidate` description (`extensions/p2o/index.ts:1575-1579`) and to `docs/SKILL_RUNTIME.md:99`.
- Ladder derivation, no new ledger field: the host derives a rung for every claim and chain step from what already exists —
  `observed` (a receipt, claim not demonstrated), `executed` (demonstrated, `src/claims.ts:44-46`), `controlled` (demonstrated
  with ≥1 negative control), `crossed` (a demonstrated claim whose gained capability carries a `scope`, or whose chain step's
  effect is `authentication-bypass`/`cross-tenant-read`/`sandbox-escape`), `impact` (the deepest demonstrated chain step with
  `effect` `code-execution`/`integrity-write` and a reach that names local or adjacent access). Severity continues to be bounded
  by the demonstrated depth exactly as today (`src/cases.ts:177-181`); no new `CASE_EFFECTS` value is introduced — LPE is
  `code-execution` reached with `PR=L`, internal reach is a `confidentiality-read`/`integrity-write` step with `AV=A`
  (`src/cvss.ts:41-57`).
- Report: a deterministic `## Access ladder` section in `src/report-export.ts` (after `## Campaign`, around `:288-300`) printing
  the start surface, one line per chain step with rung/effect/capability/reach, the furthest demonstrated rung and its severity,
  every rung not reached with the recorded wall, the sessions used and closed, secrets used by id, and the callback endpoint if
  any. Composed from committed state, never from the narrative.

**Why it changes depth.** The run's honesty rule ("severity stops at the furthest executed step") is right, but it currently has
no escape from the Medium ceiling for an undocumented internal service, and it hides long exploit evidence from the citable
record. Teaching the existing `boundary_invariant` basis is the cheapest change in this whole part that can make a proven RCE
reportable as Critical, and it is a semantics fix, not a new feature.

**Not in scope.** No severity computed from exploit evidence (P2O keeps owner-attributed ratings, which is stronger than
ARTEX's self-declared severity — artex study §5); no new effect or reach enum; no change to the independence rule.

**Hermetic gate.** Receipt bounds and redaction tests; a capture citation is admissible as reproduction evidence; prompt and
tool-description pins for the boundary_invariant rule; rung derivation table tests (one per rung, plus "cannot pass a rung
without the evidence"); severity refusals unchanged for inferred basis; `## Access ladder` golden report for a synthetic chain;
no stored rung field.

**Measured gate.** G1/G2/G5 (high/critical case with `boundary_invariant` and a demonstrated chain), G10 (ladder report complete
and honest).

### A7.7 — Command policy layer (D21)

**Change.**

- New `src/policy.ts`, pure and host-side: `parseCommandPolicy(settings)` (operator rules) + `seededRules()` (fixed deny
  list: `rm -rf /`, `mkfs`, `dd of=/dev/`, `shutdown`/`reboot`, fork bombs, writes to host-mounted paths, `docker` CLI,
  `pkill -9 1`-class self-destruction) + `decide(request)` returning `{action:'allow'|'deny'|'ask', ruleId, reason}`. Rules are
  ordered: operator `deny` → seeded `deny` → operator `ask` → operator `allow` → default `allow` for target operations.
  Seeds are disable-able by the operator (ARTEX parity, `db/db.go:350-430` in the reference), and a disabled seed is named in
  the report.
- One evaluation point, not four: the host's dispatch seam for `exec`/`net`/`http`/PTY `send`
  (`extensions/p2o/index.ts:1698-1711` owner path and the broker worker path, `src/broker.ts:503-506`), called before any
  bytes reach a container. This is deliberately stronger than the reference: ARTEX's intercept rules cover only some tools, and
  its MCP/custom tools can bypass them (artex study §4, `[INFERRED]`). A test asserts every execution path calls the evaluator.
- `ask` does not block a pane forever: it records a bounded pending decision and refuses with `POLICY_ASK_PENDING:<id>` and a
  legal next step. The operator resolves it with `/p2o approve <id>` or `/p2o deny <id>` (new `parseCommand` actions,
  `src/target.ts:40-107`), which writes an owner-attributed decision record; the same command then re-evaluates to allow once.
  The run never waits on a UI dialog inside a worker.
- Audit: every deny/ask writes one lifecycle record with command text (bounded), rule id, decision and task ref; allows are
  counted per round/rule in a digest rather than one record per operation, because receipts already carry every command's text
  (`src/evidence.ts:65-77`) and a run issues hundreds of operations. The report prints decisions by rule.

**Why it changes depth.** "Yes to RCE, no to `rm -rf`" needs a layer that is not model text. Today the only constraint is
`--avoid` text in a prompt (`src/campaign.ts:87-101,200-215`), and a cancellation destroys the shared executor
(`src/sandbox.ts:110-127`). The policy layer is also what makes it safe to authorize a *deep* run: it converts a blanket "no"
into an auditable per-operation decision.

**Not in scope.** No egress firewall or scope enforcement (the target stays a label, Part XI/E: ARTEX removed RoE; P2O keeps
the operator's authorization as the boundary). No prevention of every catastrophic command — a root shell can encode anything;
the seed list covers irreversible host-level mistakes and the audit makes the rest attributable.

**Hermetic gate.** Rule precedence and matching; every exec path routes through the evaluator (fake call counts); deny/ask/allow
flows; `/p2o approve` and `/p2o deny`; seeds disable; audit records and digest; policy text cannot be model-edited.

**Measured gate.** G7 (deny, ask and allow each exercised and audited; an approved ask executes exactly once).

### A7.8 — Ingress: operator callback and lab network (D22)

**Change.**

- `--callback <http(s) URL>` (validated like `--origin`, no credentials/fragment; `src/target.ts:40-107`), recorded in the
  campaign frame v2, rendered in the planner prompt and every worker brief as the endpoint to use for out-of-band proof of
  blind effects. It is a destination, not a listener.
- `--lab-network <name>` (docker network name: `[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}`; verified with
  `docker network inspect` at start, refused when absent), stored in the campaign frame and passed as `SandboxOptions.network`
  so session/isolated containers join the operator's lab network instead of `bridge` (`src/sandbox.ts:25,56-71,76-83`). No
  port is ever published; host isolation from the sandbox is unchanged.
- `p2o_session action=listen` starts and healthchecks an in-sandbox listener (port + optional protocol), records the address it
  told the target to use, and lists it under the session. A reverse shell lands in the sandbox, which is the blast radius the
  operator already accepted at start.
- Documents both fallbacks honestly: on a real NAT'd target with no lab network and no operator callback, inbound is
  unavailable and blind RCE is proven by side effects/timing or not at all. The report states which ingress path existed. ARTEX
  has no pivot/tunnel subsystem either, so this is a P2O addition, not parity (artex study §2).

**Why it changes depth.** Without inbound, "only the compromised host can reach the internal service" — the canonical lateral
step — is not expressible, and a blind command-injection/RCE has no terminating proof (§8.5-5). The absence is hard: no
listener verb, no published port, and `p2o_lab` services run in the same sandbox (`src/lab.ts:308-321`).

**Not in scope.** No tunnel/chisel/port-forward to the host; no automatic target stack; the operator brings the lab.

**Hermetic gate.** Flag validation, network inspect refusal path, campaign frame and prompt rendering, session listen lifecycle
(fake docker), no published port is ever added to `create`, report states the ingress path.

**Measured gate.** G3b (a reverse shell or callback proven by the lab listener/collaborator), G6 (no leftover listener).

### A7.9 — Runtime steering and `--allow` (D23)

**Change.**

- `p2o_loop` gains `hint` and `constrain` actions (bounded text ≤300 chars each, at most 12 constraints and 24 hints per run),
  written as append-only lifecycle records rendered into the next planner prompt by an extended campaign block; the campaign
  record itself stays immutable (`src/campaign.ts:16-25`; `src/tool-schemas.ts:163-165`). `p2o_workers action=steer` already
  exists and is kept.
- **No `goal` action**: goals are plan-board records with a proof (`src/planning.ts:110-113`), and `p2o_plan_revise` already
  edits them. Adding a second goal channel would create two authorities for the same promise. A7.1's admission rule reads the
  plan board, so a mid-run goal change is already visible to it.
- `--allow "<text>"` parses exactly like `--avoid` (`src/target.ts:40-107`; `MAX_AVOID`/`AVOID_CHARS` become shared limits),
  producing `CampaignConstraint {rule:'allow'}` through `campaignFrom` (`src/campaign.ts:14,143-156`). The prompt already prints
  allow as "permission only" and deny as absolute (`src/campaign.ts:200-215`), and `campaignStartLine` already counts both
  (`src/campaign.ts:174-187`) — the schema and renderer exist, only the parser has no way to produce an allow.

**Why it changes depth.** Mid-exploit correction and a recorded permission are how an operator raises authorization without
killing the run. Today constraints can only narrow: there is no allow counterpart, so "you may exploit the upload endpoint"
cannot be recorded, only "don't do X".

**Not in scope.** Allow is a recorded permission, not a policy bypass: A7.7 deny still wins, and an allow never authorizes a
different target.

**Hermetic gate.** Parser for `--allow` and the new loop actions; bounds and encoding; prompt rendering order; lifecycle records
survive restart read-only; allow does not override deny.

**Measured gate.** G7 (an operator allow is recorded and used; a deny still refuses).

### A7.10 — Semantics truth pass (D24)

**Change.**

- One module, `src/truth.ts`, holds the sentences the model is told about its own instrument, so a description cannot drift from
  `src/sandbox.ts`/`src/target.ts` again: root and full capability set, writable rootfs, no pids/mem/cpu cap, unrestricted
  bridge egress including private/link-local/metadata/host-published services (`src/sandbox.ts:16-21`; `src/target.ts:136-195`),
  no origin scoping for `p2o_http` (the description at `extensions/p2o/index.ts:1717-1720` still claims per-hop origin matching
  and must be regenerated), no raw-socket lie (`:1715` says "no raw-socket capabilities" while the container is root with the
  default set including `NET_RAW`), no inbound unless A7.8 configured it, and the credential channel when A7.4 is present.
- Stale strings replaced with the truth or deleted: `docs/USAGE.md:214` ("raw-socket thì không"), `docs/HTTP_TRANSPORT.md:14`
  ("no root, no raw sockets"), `skills/race-condition-auditing/SKILL.md:39-40` ("whose non-root user has no kernel-tracing
  privilege"), `src/report-export.ts:225-231` ("assessed target only", "third-party origins and DNS are outside the tool's
  scope", "severity … not computed from exploit evidence" — contradicted by `src/cases.ts:177-181`).
- `risk` keeps its name for record compatibility and stops being undefined: the description on `taskDraftSchema`
  (`src/tool-schemas.ts:23`) and the coverage cell (`:182`) says "a category label for grouping (injection, authz, exec, lpe,
  pivot, …); it is not a risk appetite, a ceiling or an instruction to stay read-only", the planner prompt repeats it, and
  §8.6's failure mode gets a sentence of its own ("the objective and the operator allow/deny list bound this run; a surface
  label does not").
- Pins: a test asserts the four surfaces (tool descriptions, consent text, worker prompt, report limits) contain the truth
  sentences and no longer contain the removed claims, so a later edit fails loudly.

**Why it changes depth.** This is the cheapest workstream and the one with measured evidence: run 5 invented a "read-only risk
limit" out of an undescribed field and wrote it into the report as scope (§8.2). Undersold capability plus an undefined label is
a self-imposed ceiling. No new mechanism is added; the instrument is described as it is.

**Not in scope.** No prompt-length growth for its own sake; the sentences replace, not add.

**Hermetic gate.** Description/prompt/report pins; no stale claim survives (`grep`-based test over `src`, `extensions`, `docs`,
`skills` for the four phrases); consent text matches the sandbox actually created.

**Measured gate.** Indirect: no measured run may record a self-imposed scope item that the code does not enforce (gate G9's
honesty check).

## 14. Phases and the measured access-ladder gate

### 14.1 Phases

Ordering rule: semantics first (cheapest, unblocks the rest), then admission, then the evidence ceiling, then the mechanics the
ladder needs, then policy before any new execution surface, then ingress, then measurement. Every phase is additive and gated
on its own; no phase depends on the measured run.

| Phase | Scope | Hermetic gate | Measured gate |
| --- | --- | --- | --- |
| **P7.0 — Truth pass** (A7.10) | `src/truth.ts`, tool descriptions, consent, docs, skill strings, `risk` semantics | pins for four surfaces; stale-phrase grep test; `tsc --noEmit`; full vitest | none |
| **P7.1 — Mode and impact goal** (A7.1) | mode/effects in `StartOptions` + parser + campaign v2, admission rule, prompts, report mode line | parser/campaign v1→v2 tests; admission refusal/acceptance; report line | N1 negative control |
| **P7.2 — Evidence ceiling and ladder report** (A7.6) | receipt bounds, capture citation line, `boundary_invariant` teaching, rung derivation, `## Access ladder` | bound/redaction tests; rung table tests; golden report; `docs/SKILL_RUNTIME.md` parity | none |
| **P7.3 — Policy layer** (A7.7) | `src/policy.ts`, single dispatch seam, seeds, `/p2o approve` and `/p2o deny`, audit | matcher + route-coverage + flows + audit tests | G7 |
| **P7.4 — Session and PTY** (A7.2, A7.3) | `session` executor mode, `p2o_session`, `p2o_shell send/read`, `src/pty.ts`, cleanup | pool state machine; PTY cursor/cleanup; op-gate accounting; no orphan containers | G3a, G6 |
| **P7.5 — Identity** (A7.4) | `--identity`, sealed store, `p2o_secret`, substitution/redaction, principal jars | validation, quoting, redaction byte-scan, audit, jar tests | G4, G8 |
| **P7.6 — Chain economy** (A7.5) | report hold, chain-in-session dispatch, intermediate validation skip, preflight advisory | hold/continue/release tests; successor-session test; validation-skip test | G3, G5, G10 |
| **P7.7 — Ingress** (A7.8) | `--callback`, `--lab-network`, session listener registration, doc fallbacks | flag/network validation; campaign/prompt render; listen lifecycle | G3b, G6 |
| **P7.8 — Steering and allow** (A7.9) | `p2o_loop hint/constrain`, `--allow`, prompt rendering | parser/renderer/record tests; deny precedence | G7 |
| **P7.9 — Measured access ladder** (§14.2) | the lab, the run, the verdict | — | G1–G10, N1 |

Hermetic gate of every phase also includes: `npm run build` clean, `tsc --noEmit`, full `vitest`, `detect_changes` clean,
`git diff --check`, and documentation parity (`docs/ACCEPTANCE_MATRIX.md` entries citing exact `<file>.test.ts :: <title>`).

### 14.2 The measured access-ladder gate

**Authorisation and cost.** Paid, target-contact, owner-authorized only; it is not run by this proposal. Budget guidance: one
60–90 minute campaign, one negative-control 20–30 minute campaign, plus a 10-minute approval exercise. The owner supplies the
lab and authorizes the run; nothing in the gate requires a paid call to design or implement.

**Lab (operator-provided, throwaway, local).** A docker compose stack on a private network `p2o-lab`:

| Service | Role | Properties |
| --- | --- | --- |
| `edge` | public-facing entry, the "exposed surface" | one deliberate entry bug that yields code execution as `www-data` (file-upload-to-exec or an injection), reachable from the attacker sandbox on `p2o-lab`; no host port needed |
| `internal` | internal-only service | on a second network `p2o-lab-internal` only; **no published port**; reachable from `edge` but not from the attacker sandbox directly |
| `edge` privilege state | local escalation | a `sudo` misconfiguration or a setuid binary on `edge` that lifts `www-data` to root |
| `collab` (V1 out-of-band path) | callback receiver | tiny HTTP listener that proves out-of-band execution when the reverse shell cannot land; either this or the lab-network reverse shell must be proven for V1 |

The attacker runs with `--executors session`, `--lab-network p2o-lab`, `--identity` (one principal for the `edge` admin
surface), `--mode exploit` (the default; named explicitly so the frame assertion is unambiguous), and `--goal` naming an
internal-network impact. **Variant V1 is mandatory** (owner decision 2026-10-26): it proves RCE with a reverse shell into the
sandbox and pivots from `edge` to `internal`, and its ingress proof is what makes the gate falsifiable. Variant V2 is optional
secondary evidence for the no-reverse-shell path (SSRF from `edge` to `internal`, LPE with a setuid binary). A run that cannot
prove ingress fails the gate; it does not pass on an honest wall.

**Success criteria (falsifiable, asserted from ledger + report, not from the narrative).**

| ID | Criterion | How it is checked |
| --- | --- | --- |
| G1 | A capability-proof goal is settled by a demonstrated claim; the campaign frame says `exploit` with its effect classes | `goalProofRefusal` returns undefined for the goal; frame v2 fields match the invocation |
| G2 | ≥2 rungs recorded `executed` or above, each backed by a confirmed tested claim | derived rung view; claims `closure=confirmed`, `execution=tested` |
| G3 | (a) a chain successor executes in the predecessor's session; (b) at least one rung is `crossed` (internal reach or auth bypass) | receipts carry `sessionRef`; the crossing claim's evidence shows a response from the internal-only host |
| G3b | **Mandatory V1 ingress**: a reverse shell or out-of-band callback lands on the session listener or the collaborator | listener/collaborator receipt; the report line that names the ingress path |
| G4 | The internal-only service is reached from `edge` (not from the attacker sandbox) and an LPE reaches root | response bytes from `internal`; `id` shows `uid=0` through the exploited path |
| G5 | ≥1 independently validated effect: a reviewed validation by a different worker, case `independentCurrent` | `caseViews().independentCurrent` true for the headline case |
| G6 | Sessions and listeners are closed with verified container removal; no `p2o-*` container remains | `docker ps` after finish; snapshot `ownedAssignmentExecutors: 0` |
| G7 | Policy deny, ask and allow are each exercised and audited; an approved ask executes exactly once | lifecycle `policyDecision` records; `/p2o approve` outcome |
| G8 | Secrets used by id only; zero secret bytes in `REPORT.md`, `findings.json`, the export and the ledger | byte scan for the seeded fixture values |
| G9 | The report's `## Access ladder` states executed rungs, the furthest proven impact, every unproven rung with its wall, sessions, secrets by id, ingress path, and does not claim beyond demonstrated depth | section completeness check; severity ≤ demonstrated depth (`src/cases.ts:177-181`) |
| G10 | Economy: at least one chain step per ~10 minutes of target work, and ≥1 high/critical case with `policyBasis=boundary_invariant` | timestamps in the ledger; case rating |
| N1 | Negative control: in `assess` mode the same exploitation intents are refused with a legal next step, and the run records 0 exploitation tasks | refusal records; task purposes |

**Failure conditions.** Any rung claimed without a demonstrated claim; any secret value in an export; any policy bypass; a
leftover container or listener; a report claiming more than the demonstrated depth; a run that stops only because it self-scoped
(a scope exclusion authored by the model, not the operator); **no proven ingress for V1**. A lab the exploit cannot climb is not
a failure of the ladder mechanics, but the gate is still not passed (V1 is mandatory); the report must then name the rung, the
attempt made and the evidence that it failed — a different result from run 5, which never attempted.

## 15. Migrations and compatibility

| Surface | Change | Compatibility |
| --- | --- | --- |
| Campaign record | `v: 2` adds `mode`, `effectClasses`, `callback`, `labNetwork`; `v: 1` parses as `assess` (`src/campaign.ts:113-141`) | Old runs read unchanged; new fields absent mean defaults |
| Start options | `mode`, `effectClasses`, `identityPath`, `callback`, `labNetwork`, `executorMode: 'session'` (`src/target.ts:17`) | Optional; existing invocations identical |
| Settings | `p2o.commandPolicy` (deny/ask/allow arrays, bounded); no new work ceiling | Absent = seeded rules only |
| Ledger records | new lifecycle kinds `campaignHint`, `campaignConstraint`, `policyDecision`, `secretUse`, `sessionOpened`/`sessionClosed`; receipts gain `sessionRef`/`secretRefs`; claims/tasks/cases unchanged (`risk` stays) | Additive; readers ignore unknown kinds; no rung field stored |
| Broker protocol | `session` and `secretUse` request classes; PTY streaming frames | New workers only; older workers never see the new tools |
| Tool surface | +`p2o_session`, +`p2o_secret`; `p2o_shell` params `session`/`send`/`read`; `p2o_loop` +`hint`/`constrain`; `p2o_report` +`holdFor`; `p2o_http` +`principal` (`src/tool-policy.ts:12-34`; `src/tool-schemas.ts:163-176`) | Planner and validation loadouts updated deliberately; reporter loadout unchanged |
| Parser | `/p2o approve <id>`, `/p2o deny <id>`, `--mode`, `--effect`, `--allow`, `--identity`, `--callback`, `--lab-network`, `--executors session[:N]` (`src/target.ts:40-107`) | Unknown-option error text gains the new flags |
| Report | +`## Access ladder`; `## Scope and limitations` corrected (A7.10) | Additive sections; existing consumers of headings unaffected |
| Docs | `docs/USAGE.md`, `docs/HTTP_TRANSPORT.md`, `docs/SKILL_RUNTIME.md`, `docs/ACCEPTANCE_MATRIX.md`, `docs/KNOWLEDGE_WORKSPACE.md` if the control-dir layout gains the identity seal | Documentation gate per phase |
| Tests | new suites per workstream; existing description/prompt pins updated where A7.10 replaces text | Hermetic gate includes the full suite |

No data migration is required: every change is an optional field or a new record kind. A run started before P7 remains readable
and reportable; it simply has no ladder to print.

## 16. Risks, non-goals and metrics

### 16.1 Risks

| Risk | Why it is real | Mitigation |
| --- | --- | --- |
| Exploit mode is the default and an operator starts without reading the dialog | The default now authorizes a ladder instead of a read-only assessment | The start dialog prints mode and effect classes; a capability-proof goal gates the first exploitation task; the policy layer gauges each command; `--mode assess` is one flag away; the report prints the mode |
| Policy layer is read as a security boundary | Seeds are a heuristic; a root shell can encode around any matcher | Documented as an authorization/attribution layer, not an egress firewall; deny/ask decisions audited; operator rules override; the report prints disabled seeds |
| Secret redaction is best-effort | The authorized worker can print or encode a secret; the container sees the resolved command line | Exact-byte redaction + command-class policy + per-use audit + no value in exports; the limitation is stated in the report (A7.4) |
| `boundary_invariant` is abused to rate high on weak effects | A vocabulary value cannot judge evidence | The existing gates stay: confirmed+tested claim, chain depth bounds severity, owner-attributed rating, review; inferred stays Medium-capped |
| Held workers or PTYs leak panes/processes | A forgotten hold has no timer by design (D8) | Preflight advisory, stop/finish force-release, verified container removal, hermetic cleanup tests |
| Session executor raises target pressure | A long-lived container can be used for many commands | Every command still consumes the `maxOperations` semaphore; sessions do not multiply it |
| Lab network exposes other lab services | The sandbox joins an operator network as root | Operator-provided throwaway lab; no host port published; blast radius disclosed at start |
| The measured gate fails because the lab is too hard | Difficulty is not a code defect | Gate requires the honest wall (rung, attempts, evidence), not a forced success; the ladder mechanics are independently tested hermetically |
| Prompt-only changes are ignored (the model self-scopes again) | Run 5 is exactly that | Mode admission, goal proof and chain obligations are host-checked; prompts are not the only lever |
| Two goal authorities (plan board vs a new action) | Duplicate state is how drift starts | A7.9 deliberately adds no `goal` action; the plan board stays the one promise |

### 16.2 Non-goals

- No token, wall-clock, turn or spend budget (D8), and no automatic continuation of a run.
- No egress firewall, no target scope enforcement (the target remains a label; authorization is the operator's).
- No browser, recording proxy, SOCKS/VPN or tunnel-to-host subsystem.
- No exploit database, no automatic CVE exploitation, no artifact of a third-party offensive tool.
- No session or authority restored after a restart.
- No host mount, Docker socket or published host port.
- No claim that a secret is hidden from the authorized worker process.
- No new CVSS/effect vocabulary: the existing `CASE_EFFECTS`/`CHAIN_REACH_METRICS` are expressive enough for internal reach and
  LPE when the step's `reach` is recorded honestly (`src/cvss.ts:38-57`).

### 16.3 Metrics to add

Measured per campaign and printed in the report: rungs executed/controlled/crossed per run; time from start to first executed
rung; chain steps completed per hour; sessions opened/closed and target operations per session; policy decisions by rule
(deny/ask/allow); secret uses by id; callback/listener proofs; high/critical cases with `boundary_invariant`; validation latency
and independence mode; model-authored scope exclusions that block a rung (must be 0 or operator-sourced); ladder report
completeness. These extend Part I §7.3; they do not replace the P5 continuation metrics.

## 17. Owner decisions on Q8–Q18 (2026-10-26)

All eleven questions are answered; the table below is the record. Three answers deliberately depart from the recommended
default — **exploit is the default mode (Q8)**, **session count defaults to the target-operation cap (Q10)** and **V1 ingress
is mandatory for the measured gate (Q12)** — and are propagated through §11 D15/D16, §13 A7.1/A7.2 and §14.2. The others
accept the recommended default.

| # | Question | Owner decision |
| --- | --- | --- |
| Q8 | Default mode | **`exploit` is the default**; `--mode assess` is the opt-in read-only assessment. Exploitation stays authorized: the start dialog names the mode and effect classes, and no exploitation/chaining task is admitted before a capability-proof goal exists. |
| Q9 | Default effect classes | All except `availability-loss`; DoS requires `--effect availability-loss` explicitly. |
| Q10 | Session count | `--executors session` defaults `N` to the target-operation cap, so sessions can run in parallel up to that cap; every command still counts against the op cap (sessions multiply state and parallelism, not target pressure). |
| Q11 | Identity file | Bounded JSON `principals → secrets → {kind, value}`; command-class restrictions come from the policy layer only. |
| Q12 | Callback/ingress in the gate | **V1 is mandatory**: a reverse shell or out-of-band callback must land on the session listener or the collaborator. V2 (no reverse shell) is optional secondary evidence. A run that cannot prove ingress fails the gate instead of passing on a wall. |
| Q13 | Seed deny list | Fixed seeds in §A7.7 plus operator rules; disable-able per seed, and the report names disabled seeds. |
| Q14 | Hold expiry | No timer: a hold ends at the next continue, stop or finish; the preflight advisory makes a forgotten hold visible. |
| Q15 | Rung storage | Derived host-side from existing claim/chain fields; no stored `rung` field. |
| Q16 | LPE representation | `code-execution` effect with local reach (`PR=L`); no new effect value. |
| Q17 | Validation attachment | Validation never attaches to the discovery session; it opens its own session and replays the steps. |
| Q18 | Ladder in assess mode | One line in assess mode ("no ladder: assess mode"); the full section in exploit mode. |

## Appendix D — Traceability: constraint → decision → workstream

| Binding constraint (§8.5) or census item | Decision | Workstream | Invariant (§10) | Gate |
| --- | --- | --- | --- | --- |
| Worker dies at report | D16, D19 | A7.2, A7.5 | 2, 3 | G3, G6 |
| No interactive execution | D17 | A7.3 | 3 | G2 |
| Chain tax (task + review + replay per rung) | D19 | A7.5 | 3, 7 | G5, G10 |
| No identity channel / actor-keyed jars | D18 | A7.4 | 5 | G4, G8 |
| No ingress | D22 | A7.8 | 2, 10 | G3b, G6 |
| Undefined `risk`, stale capability text | D24 | A7.10 | 8 | G9 |
| No explicit mode or impact goal | D15 | A7.1 | 1 | G1, N1 |
| Severity capped by inferred policy + receipt ceiling | D20 | A7.6 | 4, 10 | G1, G5, G9 |
| No guard on arbitrary commands | D21 | A7.7 | 6 | G7 |
| Constraints can only narrow (`--avoid`) | D23 | A7.9 | 8 | G7 |
| Planner cannot observe, pivots cost a round | (deferred; §8.5-6) | not in P7 | — | measured as report wall |
| Admission friction 31/49 refusals (P2.4) | (Part I P2.4, not P7) | not in P7 | — | Part I gate |

## Appendix E — ARTEX citations for the mechanisms P7 takes (and the ones it refuses)

| Mechanism | ARTEX citation (from `my_references/ARTEX/`) | P7 workstream | Takes / refuses |
| --- | --- | --- | --- |
| Persistent PTY family | `norma/tool/shell_tools.go:19-33,77-165`; gated by `agents.interactive_shell`, `server/assembly.go:310-318` | A7.3 | Takes the session-shaped shell; refuses a host shell |
| Background task manager | `norma/tool/bash.go:104-151`, `norma/tool/monitor.go:1-55`; dies with the session (`norma/agentcore/agentcore.go:337-345`) | A7.2/A7.8 | Takes listener-as-session-object; keeps the run as the owner |
| Per-intent budget + settlement | `agent/worker.go:144-154`; `server/engine.go:1135-1155`; `run_seconds` `db/schema.sql:798`, `agent/planner.go:327` | none (D8) | Refuses the budget; keeps Part I's no-budget decision |
| Resumable intent conversation | `agent/worker.go:500-514`; `db/schema.sql:184-193` | A7.5 (one hold) | Takes a bounded hold, refuses resume-after-restart |
| Serial-chain staging | `agent/planner.go:333,43-49` | A7.1/A7.5 | Takes the ready-step obligation P2O already has; adds the in-session continuation |
| Guard/intercept layer | `guard/guard.go:1-14`; `intercept/intercept.go:1-25,141-147`; seeds `db/db.go:350-430`; judge prompt `intercept/prompt.go:42-128` | A7.7 | Takes allow/deny/ask + audit + disable-able seeds; refuses the optional LLM judge (P2O's gate is deterministic) |
| Runtime steering | `agent/tools_insert.go:665-700` | A7.9 | Takes hint/constrain; refuses `set_goals` (the plan board owns goals) |
| Evidence bound to what ran | `agent/tools.go:1220-1227`; `db/finding_traffic.go:342-408`; `evidence/store.go:35-58` | A7.6 | Takes hash-bound evidence; keeps P2O's stronger severity rule (ARTEX severity is self-declared) |
| Recording proxy / traffic archive | `db/db.go:203-209`; `traffic/traffic.go:78-84` | none | Refuses (Part I §7.2 non-goal) |
| Single full-chain agent | `db/db.go:212-213` | A7.5 (chain-in-session) | Takes the chain economy, not the solo agent |
| Ingress / pivot | none in the tree (searched pivot, tunnel, port-forward, socks5, chisel, frp → no hits); only `docker-compose.bench.yml:20-23` host networking | A7.8 | P2O addition; ARTEX has no pivot subsystem to copy |
| Retester role | `agent/retester.go` | none in P7 | Out of scope; `retest` purpose already exists |

The reference's known holes are why A7.7 evaluates at one host seam: ARTEX's intercept covers only some tools
(`intercept/intercept.go:141-147`), and custom/MCP tools can bypass it (artex study §4, `[INFERRED]`). P2O's single dispatcher
is a deliberate improvement, and the provenance note says so.

## Appendix F — what this part does not claim

- It does not implement, test or measure anything. Every workstream is a proposal.
- It does not claim the measured gate will pass. It claims the gate is falsifiable, and that a failure still has to produce the
  honest wall that run 5 did not produce.
- It does not claim P7 will find RCE or LPE on any real target. A lab that is climbable by a human is the precondition; target
  difficulty is not a property of the tool.
- It does not claim ARTEX parity or superiority. ARTEX has no pivot subsystem and self-declared severity; P2O has stronger
  validation and no budget; the comparison is mechanism-by-mechanism (Appendix E).
- It does not fix the two infrastructure defects recorded in the P5 measured gate (storage BUSY under a concurrent reader;
  `campaignFold()` scanning only the newest 100 lifecycle records, `src/state/store.ts:694-702`). They are prerequisites for a
  clean P7.9 run and are listed as such, not absorbed.
- It does not pretend the owner's answers are free: defaulting to exploit, allowing a session per target-operation slot, and
  requiring V1 ingress each widen the default surface. Their mitigations are named in §11 D15/D16, §16.1 and §14.2, and
  `--mode assess` stays one flag away.
- It does not add a budget, a firewall or a security boundary the owner did not authorize.

---

# Part III — P8 proposal: tool surface review — deduplicate the real overlaps, keep the deliberate ones, close the control gaps

**Status: P8.0–P8.4 implemented in the working tree on 2026-10-27 (Appendix I records what landed and where it deviates);
P8.2 is closed at the truth layer because the owner re-confirmed Part XI for the citation fetch, and P8.5–P8.7 remain proposed.** Part III records a read-only review of the extension's registered
tool surface at `main` @ `a1de686` — 37 tools: 35 model-visible across four role loadouts plus 2 hidden legacy verbs — requested
by the owner on 2026-10-27 after P7 was committed. The ask was narrow: *the extension registers many helper tools; they may
duplicate or overlap in feature; inspect each tool deeply so the overlap can be evaluated and fixed.* The answer separates
three things such a request tends to conflate: a **real duplicate implementation**, a **deliberate façade** (the L1/W2 per-verb
split, the layered read paths), and a **legacy or dead path** (the two hidden verbs, the unreachable owner branches of the
target tools). It also records three **control gaps** the same pass found — one of them a report-correctness bug — which should
not wait for a consolidation decision. The audit made no code change, model call, target contact or commit; it was a
static read plus the repository's own green suite (Appendix H). Appendix I then records the implementation pass the owner approved.

## 18. The question, the scope and the method


Owner's question, verbatim intent: the extension's helper tools may be duplicated or overlapping in feature; inspect the
feature of each tool deeply so the overlap can be evaluated and fixed; ask when clueless.

**Scope.** All 37 registrations, their schemas, loadouts, boundary sentences, prompts, handlers and the tests that pin them.
Out of scope: the broker protocol, sandbox/executor internals except where a tool's control claim lives there, and any change
of authority or scope.

**Method.** Static read at `a1de686`: §19 re-verifies how the surface is built, §20 carries a `file:line` for every finding.
Three independent cluster reads (governance; target/lab; knowledge/report) were then reconciled against the tree; two claims
were corrected by that pass (§20.5). The analysis changed no file; the scratch inventory under `tmp/` was deleted.

**What this part is not.** It does not re-run the suite (it was green at `a1de686`: 1,031 tests pass, 12 skipped files), it
executes no tool, no model call and no target operation, and it does not decide the owner's product tradeoffs — §21 puts those
in front of the owner with recommended defaults.

## 19. The surface as built today

**Counts and roles.**

| Surface | Count | Definition |
| --- | --- | --- |
| Registered | 37 | `ALL_TOOLS` = `MODEL_TOOLS` + `HIDDEN_TOOLS` (`src/tool-policy.ts:56-61`) |
| Model-visible | 35 | the union of the four role loadouts (`MODEL_TOOLS`) |
| Hidden | 2 | `p2o_delegate`, `p2o_task_start`; `exposure:'hidden'`, absent from every role matrix |
| Planner | 24 | coordination only: no target, lab, claim or note tool (`src/tool-policy.ts:24-32`) |
| Worker | 19 | the only executing role and the only candidate author (`:35-38`) |
| Validation | 18 | worker minus `p2o_surface` (`:44`) |
| Reporter | 6 | read-only second reader (`:48`) |

**How it is generated.** Four per-verb generators (`extensions/p2o/index.ts:2028-2041`) wrap the retained action
implementations; per-verb closed schemas live in `src/board-verbs.ts`; one boundary sentence per tool is appended at
registration (`src/tool-guidelines.ts`, `withBoundaries`, and the inheritance rule at `:45-49`). Hidden verbs carry no boundary
by convention (`src/tool-guidelines.ts:4`: a tool removed from the model surface has no line here).

**L1/W2, the decision this part must not silently reverse.** The four owner board bags (`task`, `case`, `coverage`, `plan`) were
split into one verb per decision; the rationale is `src/board-verbs.ts:11-15` ("Action bags made the model choose an action
before it could read the shape, and every stale revision had to be narrated in prose"), and the old-action→verb map is
`BOARD_ACTION_VERBS` (`:30-41`). Consequence: 12 of the 35 model-visible tools are board verbs, and "too many tools" is mostly
this split working as designed. Any consolidation must say whether it is reversing L1/W2 (§21 D25) or not.

## 20. Verified findings

Severity: **high** = a duplicated execution/record path or a control claim the code does not honour; **medium** = two
model-visible doors to one decision, or a write with weaker identity; **low** = vocabulary or shape drift with one consumer.

### 20.1 Real duplication

**F1 (medium) — `p2o_shell` and `p2o_net` are one implementation with two labels.** The code says it: "p2o_shell and p2o_net
share one executor, receipt and broker path; only the receipt class and the guidance shown to the model differ"
(`extensions/p2o/index.ts:2234-2236`). Both pass the same `execParameters` object (`src/tool-schemas.ts:125`), and enforcement
cannot distinguish them: operator rules parsed at `src/policy.ts:76-88` **drop** the `kinds` field, and all eight seeds declare
`['shell','net']` (`:37-44`). The split of *guidance* is deliberate (the 2026-10-25 audit at `src/tool-guidelines.ts:25` requires
one boundary line per tool); what is accidental is that the split is the only difference. The one real difference is the
evidence/report `operation` string (`src/report-export.ts:277`). → D26.

**F2 (medium) — `p2o_shell session=<id> command=…` and `p2o_session action=exec` are the same code path.** Both call
`sessionExecFor` (`:1345`): the shell owner path at `:2259`, the session action at `:2296`; both record a `shell` receipt. The
`p2o_session` description itself advertises both spellings (`:2274-2280`). Related dead vocabulary: `send` is a declared policy
kind (`src/policy.ts:16`) but no call site evaluates it — PTY send is gated as `shell` (`:1353`). → A8.3, A8.5.

**F3 (medium) — `p2o_board board=tasks match` is an exact dry-run of `p2o_task_create`.** Both call `board.match` (`:1922`);
create returns the match payload *instead of creating* on a hit (`:1923-1924`); the input schema is the same `taskDraftSchema`
(`src/board-verbs.ts:97` vs `:63`). The only behavioural difference is the `work` gate (`:1921`): create preflights only when
structured work exists, so board match is the only way to preflight a draft without it. Cost: a create with `work` computes work
identity twice (`:1922`, then `src/tasks.ts:315`). → A8.3.

**F4 (low) — `p2o_graph page` and `export` are two read doors to one store.** Same parameters
(`src/state/graph-tool.ts:31-34`), different shapes: `page` returns raw asset rows with `uniqueAssets` and limit ≤100
(`src/state/store.ts:891-898`); `export` returns current heads across four tables as a rendered graph with limit ≤500
(`:900-908`). Not a strict subset (§20.5). → A8.3.

**F5 (medium) — `p2o_workers action=list` re-emits three other tools' payloads.** It returns `engine: engine.snapshot()`,
a task projection identical to `p2o_board board=tasks` (`:933` vs `:1893`), and a ledger page that appears twice
(`changes` and `navigation.changes`, `:2598-2612`) and that `p2o_ledger` returns directly (`:2476-2477`). Shape is pinned by
`tests/minimal/projection-counts.test.ts:38-44` and `tests/minimal/extension.test.ts:233`. → D30.

**F6 (medium) — one held worker, two continuation verbs, one single-use hold.** `p2o_task_dispatch {workerId}` consumes the hold
at `:788`; `p2o_workers action=continue` consumes the same hold at `:2582` (``consumeHeldContinuation``,
`src/broker.ts:744-751`). Guards differ: dispatch demands a proposed owner task, the same role and `work.claimRefs` lineage
(`:776-787`); continue sends free text with no task (`:2584`). Whichever runs first burns the hold for the other
(`WORKER_NOT_HELD`, `:774`). → A8.3 (boundary) or D30.

**F7 (medium) — task status `cancelled` has two writers with different guards.** `p2o_task_settle {outcome:'cancelled'}` passes
the expected revision (`:1937`); `stopWorker` transitions the same status with no revision and swallows a failure
(`:850`, `.catch(() => {})`). The two half-operations are opposed: settle-cancelled leaves the worker running, stop revokes the
sandbox and closes the pane. → A8.4.

**F8 (low) — plan/decision records have three authors.** `p2o_plan_create` (`:1962`); `p2o_loop wait + notBefore` writes a
`decision` with `disposition:'defer'` (`:2542`); `p2o_graph action=chain plan:true` writes one todo per step (`:2429`, `:441`).
Intentional and documented, but `p2o_board board=plans` shows rows the planner did not author. → A8.4 (boundary line only).

**F9 (medium) — three write paths record "surface X, outcome Y", and only one is consumed.** `p2o_note kind=coverage`,
`p2o_surface` and `p2o_candidate` all carry a surface; only the claim feeds the proof chain, cases and derived coverage.
`p2o_surface` output is consumed by the duplicate hint and the unpromoted-coverage advisory; the completion preflight itself
warns "surface/coverage note recorded but the plan still has no derived cell" (`src/finish-preflight.ts:63`). Worse, the worker
prompt routes workers to the weak path — "Record coverage with p2o_note kind=coverage" (`src/prompts.ts:244`) — while the
boundary says "Surfaces belong in p2o_surface" (`src/tool-guidelines.ts:32-33`). → A8.1 (prompt), A8.4 (retire, larger).

**F10 (low) — vocabulary and dead code.** `p2o_note kind=note` and `kind=observation` are one record with one counter
(`src/records.ts:355`); `lab action=env compose=true` is unreachable (refused for workers, and the only role allowed to use it
holds no lab tool); `session` names two different things (container id enforced as `^session-[a-f0-9]{8}$` at `:1290`, vs the
HTTP cookie jar, `src/tool-schemas.ts:158`); `timeout` carries four meanings and the PTY form clamps to 60 s (`:2244`) against
the "no 60-second ceiling" description; `skillListParameters`, `skillReadParameters` and `ledgerParameters` omit
`additionalProperties:false` like the rest. → A8.5.

**F11 (medium, structural) — the owner branch of every target/lab handler is unreachable.** `TARGET_TOOLS`/`LAB_TOOLS` are not
in `PLANNER_TOOLS` (`src/tool-policy.ts:14-32`), and the owner receives exactly `plannerTools()`; the planner is blocked at
`tool_call` (`tests/minimal/extension.test.ts:552-556`). Yet five handlers keep `if (role === 'owner')` execution branches
(`:2249`, `:2294`, `:2352`, capture `:2228-2231`, lab `:2166-2218`) and fixtures call them directly. This is dead authority
kept for tests, not live surface. → D31.

### 20.2 Deliberate façades — do not "fix" without a decision

| Façade | Where it is stated | Verdict |
| --- | --- | --- |
| 12 board verbs from 4 bags | `src/board-verbs.ts:11-15,30-41` | Keep (D25); it is the L1/W2 product |
| board / state / ledger / graph read layering | `src/tool-guidelines.ts:18,23,35` | Keep the layering (D30); the boundaries do not name each other — add a sentence |
| artifact (read) vs capture (write) | `src/tool-guidelines.ts:19,34` | Complementary, keep |
| lab payload/env vs candidate `payloadRef`/`environmentRef` | `src/tool-guidelines.ts:20,31` | Complementary, keep |
| report (worker→lead) vs finish (owner→run end) | `src/tool-guidelines.ts:24,40` | Different roles, keep |
| `p2o_secret` list-only | `src/tool-guidelines.ts:29` | No duplicate identity surface |
| `p2o_http` principal-local cookie jars | `docs/HTTP_TRANSPORT.md` | Complementary transport, keep |
| coverage plan (write) vs coverage suggest (read-only WSTG) | `src/tool-guidelines.ts:15-16` | Different verbs, keep |
| `p2o_note kind=open` | `src/records.ts:348` | Feeds open gaps; not dead |

One gap inside the layering is real: `p2o_state` search returns record ids (`src/search.ts:47`) while `p2o_board` returns entity
ids, and only `p2o_ledger id=` accepts the record id — a naming trap, not a duplicate. A boundary sentence fixes it (A8.3).

### 20.3 Legacy and dead paths

- **Hidden `p2o_delegate`** — comment: "A1/D5: removed from the model surface … Hidden until A2 deletes the handler"
  (`:2482-2483`); the body still creates a task, reserves it, transitions to `running` and spawns, bypassing the frontier
  (`:678-680,682,733,2491`). It is a second execution path, kept alive by tests: ~21 test files and ~82 references, including a
  fixture that depends on the synchronous spawn (`tests/minimal/helpers/report-fixture.ts:77` uses `p2o_task_start`).
- **Hidden `p2o_task_start`** — `HIDDEN LEGACY` (`:2048`); the handler at `:1936` still performs owner execution;
  `src/board-verbs.ts:21,45` keeps the only internal mapping. The two hidden verbs are absent from every role matrix and from
  the prompts (`tests/minimal/board-verbs.test.ts:128`, `tests/minimal/authority.test.ts:100-108`).
- **Decision**: deletion belongs to A2, not to this part (D28). Part III adds only a guard test and records the fixture cost.

### 20.4 Control gaps the same pass found

**G1 (high) — `p2o_research action=fetch` is an uncontrolled host-side fetch.** `fetchPage` (`:1592-1598`) is a plain Node
`fetch` with `redirect:'follow'`; no allowlist, no read or return cap, no sandbox, no policy kind (`POLICY_KINDS`,
`src/policy.ts:16`, has no `fetch`), no receipt/evidence id — only a `research` ledger record (`:1650-1663`). The tool
description is candid ("no allowlist and no size cap", `:2099`), but a worker can reach `127.0.0.1`, RFC1918 and
`169.254.169.254` from the Pi host, and the fetched body enters the result uncapped. A stale P14.8 comment above the function
(`:1585-1590`) still claims the fetch "runs inside the caller's own sandbox" — it does not. → D29, A8.2.

**G2 (high) — the worker prompt under-describes its own loadout.** `WORKER_TOOL_LINE` (`src/prompts.ts:210`) lists 13 of the 19
active tools: it omits `p2o_skill_list`, `p2o_skill_read`, `p2o_research`, `p2o_capture`, `p2o_session` and `p2o_state`
(loadout: `src/tool-policy.ts:35-38`); `VALIDATION_TOOL_LINE` (`:211`) is the same minus surface. It also says "No host tools"
while G1 gives every worker a host-side network path, and a later worker line tells it to call `p2o_session action=open`
(`:241`) — a tool the inventory line never names. → A8.1.

**G3 (medium) — `p2o_finish{export:true}` does not flush the policy digest.** The finish-export branch renders the report
without `flushPolicyDigest` (`:2694-2701`); the manual `/p2o report export` flushes first with the explicit comment "a manual
export flushes the allow digest first, so the report counts the operations that already ran" (`:2779`); cleanup also flushes
(`:1156`). Grep confirms no flush on the finish-export path. Two export surfaces therefore can print different operation
counts for the same run. → A8.0.

**G4 (medium) — "every command still passes the operation gate and the command policy" is true for three operations, not four.**
`shell|net|http` are enforced at the one dispatch seam (`:1494`); PTY writes ride the `shell` kind (`:1353`) although `send` is a
declared kind; `pty-read` is deliberately ungated (no bytes written, `:1369-1370`); `capture` dispatches as `capture`, not a
policy kind, while its description says "Uses normal target command admission" (`:2223`) — the sentence is true of admission and
silent about policy. The `p2o_http` decision text is `requestLabel()` (`:225-228`, `:2352`), which names method, URL, body size
and header **names** only, so an operator rule can never match a header or body value on that path. → A8.5 (wording) and §21
D30 (accept the asymmetry explicitly).

**G5 (low, to confirm) — the `p2o_http` "8 MiB curl transfer limit" claim has no matching cap in the sandbox call**
(`:2342` vs `src/sandbox.ts:286-296`, per the target/lab cluster read). Not re-verified by execution. Recorded as an open item
(§26 Q23), not a workstream.

### 20.5 Corrections made by this pass

- The target/lab cluster read called `p2o_graph page` a strict subset of `export`; the store shows two different result shapes
  (`src/state/store.ts:891-908`). Recorded as two doors (F4), not a subset.
- The governance cluster read counted three work-identity computations per create; it is two — the handler preflight (`:1922`)
  and `TaskBoard.create` (`src/tasks.ts:315`); `:472` is the body of the match the handler already called.
- The same read called `shell`/`net` "accidental duplication"; this part records it as "deliberate guidance split, accidental
  alias" — the boundary text is the product, the shared implementation is the debt.

## 21. Decisions (D25–D31, proposed; defaults recommended)

| ID | Decision | Recommended default | Cost of the other choice |
| --- | --- | --- | --- |
| D25 | Keep L1/W2: one verb per decision; do **not** merge the task/case/plan/coverage families | Keep | Reversing it collapses 12 verbs into 4 action tools, deletes per-verb schemas and boundary inheritance, and touches every count pin, prompt and doc — for a duplication that is façade, not feature |
| D26 | Merge `p2o_shell` + `p2o_net` into one exec tool with a required `kind` enum | Merge (37→36) | Two slots for one capability, distinguishable only in prose; the report keeps its granularity either way because `kind` preserves the receipt class and the evidence `operation` |
| D27 | Merge `p2o_skill_list` + `p2o_skill_read` into one `action` tool | Merge (36→35) | Two slots for one library, carried in four role matrices; the broker already treats them as one family (`src/broker.ts:324-328`) |
| D28 | Hidden verbs: deletion stays with A2 | Defer; add only a guard test | The two hidden handlers and their fixtures remain until A2 |
| D29 | `p2o_research` fetch: allowlist + read/return caps + explicit record now; policy/receipt integration later | **Answered 2026-10-27: keep Part XI — truth layer only, no allowlist and no cap (Appendix I)** | Leaving it open keeps a host-side fetch with no allowlist; routing it through policy now costs more and policy is still not an egress firewall (`src/policy.ts:31-37`). Part XI, however, records the opposite owner decision: the target is a label, not an egress boundary, and a citation fetch is any http(s) URL with no response cap |
| D30 | Read surfaces: no merge; boundary sentences + one canonical read order | Boundary-only | Four model-visible doors remain and a model can still pick the wrong one; F5's duplicated payload stays |
| D31 | Dead owner branches / `lab compose`: extract the test driver, then delete | Defer extraction; remove `compose=true` with it | Dead authority code and a tool description that advertises a path no role can reach |

**No owner decision needed (fix as part of P8.0–P8.5):** G3 (report parity bug), G2 (prompt truth), F3/F4 (read dedup), F6
(boundary rule), F7 (single `cancelled` writer), F10 (dead vocabulary). **Status (Appendix I):** G3, G2, F3/F4 and F7 are fixed; F10
(P8.5) is not started; D29 was reclassified from "fix" to an owner decision because Part XI already answered the other way, and the
owner re-confirmed Part XI on 2026-10-27, so only the truth layer changed.

## 22. Workstreams (A8.0–A8.8)

Each workstream names its seam, the change, the reason, what breaks and the effort (S ≤ 1 day, M 1–3 days, L > 3 days per the
owner's review budget; all estimates are static-read judgments).

**A8.0 — Report parity (G3).** Seam: `:2694-2701` (no flush) vs `:2779` (flush) vs `:1156` (cleanup). Change: flush the digest
before `renderStoreReport` in the finish-export branch; add a test that both export paths report the same policy-digest numbers.
Breakage: none expected. Effort S.

**A8.1 — Prompt truth (G2, prompt half of F9).** Seam: `src/prompts.ts:210-211`, `:241`, `:244`. Change: complete both loadout
lines to the real 19/18 names; correct "No host tools"; route coverage recording to `p2o_surface`/`p2o_candidate` + derived
cells and keep `kind=open`. Breakage: the recon prompt hashes (`tests/minimal/recon.test.ts:109-110`, `url` and `directory`),
any test pinning prompt text, docs that quote the line. Effort S. **Done (Appendix I):** the loadout sentence is now "The sandbox is
your only execution surface: no host shell, host filesystem, Docker socket or consent dialogs", the coverage sentence is
role-aware (validation holds no `p2o_surface`), and both instruction hashes were re-pinned twice — once here, once for the
P8.2 wording fix. The "once D29 caps the fetch" condition was dropped: the line is true whether or not a cap exists.

**A8.2 — Fetch control (G1).** Seam: `:1585-1598`, description `:2099`, record `:1650-1663`. Change: a fixed allowlist constant
(`services.nvd.nist.gov`, `nvd.nist.gov`, `www.cve.org`, `cve.org`), a body cap (read ≤1 MiB, return ≤48 KiB), reject a redirect
that lands off the allowlist, record `hostFetch:true`, delete the stale P14.8 comment. Breakage: `tests/minimal/research.test.ts`,
the fetch paragraph in `docs/USAGE.md`. Effort S/M. **Closed in Appendix I:** only the truth half landed — the stale comment now
says host-side/no-allowlist/no-cap and the loadout line no longer claims a cap. The allowlist, caps and redirect refusal would
reverse **Part XI** (any http(s) destination and redirect is allowed; the citation fetch is host-side with no response cap), and
on 2026-10-27 the owner re-confirmed Part XI, so the behavioural half is **declined by decision**, not pending.

**A8.3 — Read dedup (F3, F4, F6, boundary half of D30).** Seam: `src/board-verbs.ts:43,97`; `:2071-2072,1921`;
`src/state/graph-tool.ts:31-34`; `src/tool-guidelines.ts:18,23,35`. Change: drop `match` from `boardParameters` and always
preflight in create (drop the `&& input.work` gate in the same change); retire `graph page` in favour of `export` with a cursor;
add the four cross-boundary sentences (board/state/ledger/graph; dispatch names a task vs continue names a brief). Breakage:
`tests/minimal/board-verbs.test.ts:40`, `tests/minimal/workspace-runtime.test.ts:511`, descriptions, `docs/WORK_ADMISSION.md`,
`docs/ASSESSMENT_STATE.md`, `docs/USAGE.md`, graph tests. Effort S/M. **Done in Appendix I with two deviations:** board `match` is
gone end to end and create owns the preflight, but the `&& input.work` gate was **kept** (a draft with no `work` has no
structured identity, so the preflight returns an empty payload and creates nothing — the removed verb was that payload's only
consumer), and `graph page` was **kept** because it returns raw rows plus `uniqueAssets`, a shape `graph export` does not
produce; tests and three docs consume it.

**A8.4 — Canonical writers (F7, F8, larger half of F9).** Seam: `:1937` vs `:850`; `:2542`; `:2429,440`. Change: one writer for
`cancelled` (either stop passes `taskId`+`expectedRevision` and returns it, or stop stops transitioning and settle owns it);
document loop/chain plan authorship in the `p2o_plan_create` boundary; decide whether `note kind=coverage` retires (larger, if
D30 keeps it, say so in the boundary). Breakage: stop tests (none assert the status today), chain/loop tests, docs. Effort S/M.
**Done (Appendix I):** the first option was taken — stop reads the task, transitions at the revision it observed and returns
`taskWithdrawn:{taskId,revision}`; a refusal is a lifecycle note, no longer swallowed. `p2o_plan_create`'s boundary names the
loop-`notBefore` decision and the chain-planning todos. `note kind=coverage` stays (D30) and its boundary now says the note is
display context while cells come from reviewed claims. A planner fixture asserts the stopped worker's task is `cancelled`.

**A8.5 — Vocabulary and dead code (F10, G4 wording).** Seam: `src/policy.ts:16`; `src/records.ts:355`; `src/tool-schemas.ts:49-50,125-131,158,176`;
`:2244`. Change: delete or use the `send` kind; collapse `note`/`observation`; add the three missing
`additionalProperties:false`; rename the PTY wait (`waitSeconds`) and the HTTP jar (`jar`); align `refs`/`command`/`body` caps;
reword the capture admission sentence to match what it enforces. Breakage: schema-level tests, the timeout pin at
`tests/minimal/workflow-policy.test.ts:66`, note tests. Effort S.

**A8.6 — Optional surface reduction (D26, D27).** Seam: `src/tool-policy.ts:24-48`, `src/tool-guidelines.ts:6-43`, prompts,
docs counts. Change: one `p2o_skill` action tool; one `p2o_exec` with `kind`. Breakage (all in one commit): counts at
`tests/minimal/board-verbs.test.ts:29,61-66`, `tests/minimal/authority.test.ts:71-72`,
`tests/minimal/workflow-policy.test.ts:82`; registry `tests/minimal/extension.test.ts:85`; worker pins
`tests/minimal/worker.test.ts:101,115`; boundary keys; prompt hashes; docs counts (`docs/USAGE.md`, `docs/ACCEPTANCE_MATRIX.md`,
`README.md`). Effort M.

**A8.7 — Hidden deferral guard (D28).** Change: a test that `HIDDEN_TOOLS` ∩ every role matrix = ∅ and no prompt contains a
hidden name (the second half exists at `tests/minimal/board-verbs.test.ts:128`); record the A2 fixture-migration plan in the
test comment (synchronous spawn, 21 files). Effort S.

**A8.8 — Dead authority (D31).** Seam: the five owner branches and `lab compose` (`:2155-2157`). Change: extract the owner-branch
execution into host-side helpers the fixtures call, then delete the branches; remove `compose`. Breakage: five fixture families
(session, identity-runtime, artifacts-docker, operator-controls, lab). Effort S/M extract + L delete.

## 23. Phases and hermetic gate

Ordering rule: the bug first, then the model-facing truth, then the control gap, then dedup and canonical writes, then
vocabulary, then the two merges the owner must approve, then the deferred work. Every phase is independently gated; no phase
depends on a campaign run.

| Phase | Scope | Hermetic gate | Measured gate | Status 2026-10-27 (Appendix I) |
| --- | --- | --- | --- | --- |
| **P8.0 — Report parity** (A8.0) | flush before finish-export; parity test | parity test; full vitest | none | **Done** |
| **P8.1 — Prompt truth** (A8.1) | loadout lines, host-tools sentence, coverage routing | recon hashes; prompt pins; full vitest | none | **Done** (hashes re-pinned) |
| **P8.2 — Fetch control** (A8.2) | allowlist, caps, redirect rule, record, stale comment | allowlist/cap/redirect tests; no host network in tests | none | **Done at the truth layer — owner re-confirmed Part XI; behavioural half declined** |
| **P8.3 — Read dedup** (A8.3) | board match, graph page, boundary sentences | mapping tests; docs parity; full vitest | none | **Done with two deviations** (graph page kept, `input.work` gate kept) |
| **P8.4 — Canonical writers** (A8.4) | `cancelled` writer, plan authorship, coverage path decision | stop/settle tests; full vitest | none | **Done** |
| **P8.5 — Vocabulary** (A8.5) | `send`, `observation`, `additionalProperties`, param names, caps | schema tests; timeout pin; full vitest | none | Not started |
| **P8.6 — Surface reduction** (A8.6, owner gate D26/D27) | skill merge; shell/net merge with `kind` | all count pins, prompts, docs | none | Not started, owner gate |
| **P8.7 — Deferred** (A8.8, A8.7, A2) | dead branches, hidden deletion | fixture migration; registry equality | none | Not started |

The standard hermetic gate of every phase is the Part II §14.1 set: `npm run typecheck`, `npm run build`,
`npm run check:build`, full `npx vitest run`, `git diff --check`, `detect_changes` clean, and documentation parity in
`docs/ACCEPTANCE_MATRIX.md` with exact `<file>.test.ts :: <title>` citations. **There is no measured gate in Part III**: it
changes no target behaviour, needs no paid call, no lab and no campaign run. One commit per phase, owner-initiated, per the
repository rule.

## 24. Migrations and compatibility

| Surface | Change | Compatibility |
| --- | --- | --- |
| Tool count | 37 → 36 (D26) → 35 (D27); after A2 → 33 | Every count pin updated in the same commit as the merge; nothing else reads the number |
| Tool schemas | `board.match` removed; `graph.page` retired; `session` action `exec` removed (if D25 path chosen) | Model-visible, so it is a breaking schema change for a model that used them; the replacement is named in the refusal/description |
| Tool descriptions/boundaries | loadout lines corrected; cross-boundary sentences added; capture wording fixed | Prompt hashes change (`tests/minimal/recon.test.ts:109-110`); prompt-cache prefix changes once (cost only) |
| `p2o_research` | allowlist + caps on `action=fetch` | A URL outside the allowlist is refused with a legal next step; `action=technique`/`cve`/`triage` unchanged |
| Stored data | none | No record shape, id or status changes; every phase is reversible by reverting its commit |
| Reports | finish export now includes the flushed digest | Counts can go up for runs whose digest was pending; that is the fix, not a regression |
| Docs | USAGE, ACCEPTANCE_MATRIX, ARCHITECTURE, README counts, WORK_ADMISSION | Documentation parity gate per phase |
| Tests | count pins, prompt hashes, registry equality, projection shape | Same-phase updates; no test is deleted to make a phase pass |

No data migration is required: the only stored-byte change is the additive `hostFetch:true` data field on future research
records.

## 25. Risks, non-goals and metrics

**Risks.** (1) Every merge touches six count pins plus the registry-equality test — do them as one commit per phase, not in a
batch with other work. (2) Prompt edits invalidate the recon hashes and the static prompt-cache prefix; that is a cost, not a
bug, but P8.1 must land the hash update in the same commit. (3) Removing `board match` loses the work-less preflight unless the
gate change ships with it (A8.3 names both). (4) An allowlist could refuse a legitimate citation mirror the description
advertises — the four hosts are the description's own set, and Q22 keeps the override question open. (5) Deleting the dead owner
branches churns five fixture families; extract-then-delete is the mitigation, not a bigger diff. (6) A future refactor could
re-expose a hidden verb; A8.7's guard test is the mitigation until A2 deletes the handlers.

**Non-goals.** No family merge (D25); no read-surface unification (D30); no new tool; no authority, scope, budget or credential
change; no target contact, no campaign run, no measured gate; no HTML/dashboard rendering change.

**Metrics to record.** Registered tool count (37 → 35, or 33 after A2); duplicate doors per operation (exec 2→1, skill 2→1,
board match 2→1, graph read 2→1, continuation 2→1 or documented); worker prompt inventory coverage (13/19 → 19/19, validation
18/18); policy-gated dispatch classes (3/4 → 4/4 or documented); tests added per phase; and the count of findings closed
(F1–F11, G1–G4) versus explicitly accepted (D30's read doors).

## 26. Open questions for the owner (Q19–Q25)

- **Q19 — L1/W2.** Keep one verb per decision and reject the family merge (recommended), or does surface economy outweigh the
  per-verb schema and boundary? Reversing it is the largest single change in this part.
- **Q20 — `shell`/`net`.** Merge into one exec tool with `kind` (recommended), or keep two tools because the two boundary
  sentences are the product?
- **Q21 — skills.** Merge `skill_list`/`skill_read` into one action tool (recommended), or keep the pair?
- **Q22 — fetch.** Allowlist + caps only (recommended), or also route the fetch through `executeWithReceipt`/policy for a
  receipt and audit — and if so, is a host-level `ask` acceptable for a citation fetch? **Answered 2026-10-27: keep Part XI
  (any http(s) destination, no allowlist, no cap); the truth layer was fixed and the behavioural half was declined (Appendix I).**
- **Q23 — hidden verbs.** Defer deletion to A2 (recommended), or delete now and migrate the ~21 test files in the same phase?
- **Q24 — scope of this pass.** Land P8.0–P8.4 now and defer P8.5–P8.7 (recommended), or do the whole part? **Answered
  2026-10-27: the owner said "do it"; P8.0–P8.4 are implemented (Appendix I) and P8.5–P8.7 were left for a later pass.**
- **Q25 — commit cadence.** One commit per phase, owner-initiated — acceptable? No commit or push happens from this
  document. **Status: no commit or push was made; the working tree holds the change for the owner's review.**

Also to confirm in Q22/Q26-spirit: whether the `p2o_http` "8 MiB curl transfer limit" claim in the description is enforced
anywhere (G5) — the audit could not find a matching cap.

## Appendix G — traceability: finding → decision → workstream → phase

| Finding | Severity | Decision | Workstream | Phase |
| --- | --- | --- | --- | --- |
| F1 shell ≡ net alias | medium | D26 | A8.6 | P8.6 |
| F2 session exec alias; `send` kind dead | medium | D25, A8.5 | A8.3, A8.5 | P8.3, P8.5 |
| F3 board match = create dry-run | medium | — | A8.3 | P8.3 |
| F4 graph page/export two doors | low | D30 | A8.3 | P8.3 |
| F5 workers list re-emits three payloads | medium | D30 | — (accepted) | — |
| F6 continuation two consumers | medium | D30 | A8.3 | P8.3 |
| F7 `cancelled` two writers | medium | — | A8.4 | P8.4 |
| F8 plan records three authors | low | — | A8.4 | P8.4 |
| F9 coverage write paths | medium | — | A8.1, A8.4 | P8.1, P8.4 |
| F10 vocabulary / dead code | low | — | A8.5 | P8.5 |
| F11 dead owner branches | medium | D31 | A8.8 | P8.7 |
| G1 research fetch uncontrolled | high | D29 closed: keep Part XI (owner 2026-10-27) | A8.2 (truth half only) | P8.2 |
| G2 prompt inventory drift | high | — | A8.1 | P8.1 |
| G3 finish export digest parity | medium | — | A8.0 | P8.0 |
| G4 gate-coverage wording | medium | D30 | A8.5 | P8.5 |
| G5 http 8 MiB claim | low | — | open question | — |
| Legacy hidden verbs | medium | D28 | A8.7 + A2 | P8.7 |
| Implementation status (Appendix I) | — | — | A8.0–A8.4: P8.0/P8.1/P8.3/P8.4 done, P8.2 truth half only | P8.5–P8.7 open |

## Appendix H — what this part does not claim

- It did not execute the tools, a model call, a target operation or a campaign run. Every finding is a static read at
  `a1de686`; the suite was green there (1,031 tests pass, 12 skipped files) and was not re-run for the audit.
- It does not claim any run behaves differently after P8. It claims the code paths named are the code paths that run.
- It does not claim the two hidden verbs are unreachable by every Pi API path. Their `exposure:'hidden'` contract is asserted by
  the repository's tests and comments; the Pi runtime was not read to prove it (D28 keeps the guard-test mitigation).
- It does not provide measured breakage. Effort and breakage lists are static-read judgments (`S/M/L`), and the exact test
  impact of the two merges must be counted at implementation time.
- It does not reverse L1/W2 or any owner decision by implication: D25–D31 are proposals with defaults, and every default is
  one the owner can refuse without the analysis becoming invalid.
- It does not claim the analysis is the owner's only view: two cluster reads were reconciled into §20.5's corrections, and
  severity ranks are judgment, not measurement.
- It does not change authority, scope, credentials, budgets or the record format, and it makes no commit or push.
- §18–§26 are the audit and stay a static read; only Appendix I records the later implementation pass the owner approved, and even
  that pass made no commit or push.

## Appendix I — implementation record (2026-10-27, after the owner said "do it")

The owner read §18–§26 and said "do it". That approved the recommended defaults for **P8.0–P8.4**; P8.5–P8.7 — the
owner-gated merges of D26/D27 and the deferred cleanup — were left unstarted. This is what is actually in the working tree,
next to where it deviates from the proposal above. The proposal text is kept unchanged so the reasoning can still be audited;
this table is the implementation of record.

| Phase | Status | What landed | Deviation from the proposal |
| --- | --- | --- | --- |
| P8.0 report parity (G3) | **Done** | `flushPolicyDigest` before the finish-export render (`extensions/p2o/index.ts`, finish branch); regression test in `tests/minimal/policy.test.ts` — it failed before the fix (`allow 0`) and passes after (`allow 2`) | none |
| P8.1 prompt truth (G2, prompt half of F9) | **Done** | `src/prompts.ts`: both loadout lines name the real 19/18 tools; "No host tools" replaced by "The sandbox is your only execution surface: no host shell, host filesystem, Docker socket or consent dialogs"; coverage recording routed to `p2o_surface` for a component/entry point and `p2o_candidate` for an outcome, role-aware because validation holds neither; rewording note in place and both recon instruction hashes re-pinned deliberately | the proposal conditioned the wording on "once D29 caps the fetch"; that coupling proved unnecessary — the truth of the loadout line does not depend on a cap, and Part XI keeps the fetch uncapped |
| P8.2 fetch control (G1, D29) | **Done at the truth layer; behavioural half declined by owner decision** | deleted the stale P14.8 comment claiming the fetch "runs inside the caller's own sandbox" (`extensions/p2o/index.ts`, above `fetchPage`), replaced with one comment stating host-side, no allowlist, no response cap (Part XI); removed the false "a capped citation fetch" phrase from the worker/validation loadout line; recon hashes re-pinned again; truth guard pins the true statement and retires the two false ones | the allowlist, the ≤1 MiB/≤48 KiB caps and the redirect refusal are **not** implemented. On 2026-10-27 the owner re-confirmed **Part XI** (the target is a label, not an egress boundary; the citation fetch is host-side with no response cap), so D29 is closed as a decision rather than implemented. The behavioural half would need an explicit reversal of Part XI for citation fetches — it is declined, not pending |
| P8.3 read dedup (F3, F4, F6, boundary half of D30) | **Done, one deviation** | board `match` removed end to end (`TASK_ACTIONS`, `BOARD_ACTION_VERBS`, `boardParameters`, handler branch and description); create keeps its own duplicate/history preflight and returns the match payload on an exact active or reusable hit; cross-reference boundary sentences for the five read/write surfaces (board, state, ledger, graph, workers) plus dispatch-names-a-task vs continue-names-a-brief; two test call sites and the real-Pi fixture migrated | `graph page` was **kept**: it returns raw asset rows plus `uniqueAssets`, a shape `graph export` does not return, and is still consumed by `tests/minimal/workspace-runtime.test.ts`, `projection-counts.test.ts` and three docs. Retiring it would break real readers to save one slot. The create preflight's `&& input.work` gate was **kept** as well: a draft with no `work` has no stable identity to match, so the call returns an empty payload and creates nothing, and the `match` verb (its only consumer) is gone |
| P8.4 canonical writers (F7, F8, larger half of F9) | **Done** | the `cancelled` writer chosen is the first option: stop passes the revision it observed (`expectedRevision`) and returns `taskWithdrawn:{taskId,revision}`; a refused withdrawal (`Invalid task transition` on a closed task, a stale revision) is recorded as a lifecycle note instead of being swallowed by `.catch(() => {})`. `p2o_plan_create` boundary documents that loop waits with `notBefore` and chain planning also author plan rows. `note kind=coverage` is **kept** per D30, and its boundary now says the note is display context while the host derives cells from reviewed claims. New test in `tests/minimal/planner.test.ts` proves a stopped worker's task ends `cancelled` at the returned revision | none |
| P8.5 vocabulary (F10, G4 wording) | Not started | — | — |
| P8.6 surface reduction (D26/D27) | Not started — owner gate | — | — |
| P8.7 deferred (D28, A2, A8.8) | Not started | — | — |

Gate at this point, all run on 2026-10-27: `npm run typecheck` clean; `npm run build` and `npm run check:build` clean;
`git diff --check` clean; the touched suites green (policy, recon, workflow-policy, board-verbs, workspace-runtime,
projection-counts, planner, extension, work-native, truth); full `npx vitest run` **1,034 passed, 12 skipped in 6 skipped
files**, no failures (the 1,031 baseline plus three new tests: policy P8.0, planner P8.4, truth P8.2). `detect_changes` also
ran: it lists the expected hub reach through `registerP2O` and the changed files match this pass, but the graph index was
older than the working tree, so it is a reach signal only, not behavioural proof.

Documentation parity was part of the change: `docs/ACCEPTANCE_MATRIX.md` gained a P8/A8 section with exact
`file.test.ts :: title` citations (its own guard test passes), and the `match` docs were migrated in `README.md`,
`docs/USAGE.md`, `docs/WORK_ADMISSION.md`, `docs/ASSESSMENT_STATE.md` and `docs/PLANNER_ENGINE.md`. Migrating the real-Pi
fixture was part of the change too: it drove the removed board `match` verb and now drives a repeated `p2o_task_create`
instead (`tests/minimal/fixtures/inert-provider.ts`, `tests/minimal/work-native.test.ts`). **No commit and no push were
made** — the repository rule leaves that to the owner, and the pre-existing dirty `AGENTS.md` plus untracked files from
other sessions were left untouched and unstaged.

# Part IV — P9 proposal: capability audit — where the instrument is stricter than its own authority model, and what to lift

## 27. The question, the scope and the method

The owner's request (2026-10-27): *"analyze are there any existing things strict — make the capabilities of workers/planners
more weak. I need you improve"*, and on the follow-up: **both axes** — the workflow layer (prompt, skills, flow) and the
tools-register layer (schema, handler, description). This part is the research; it does not implement anything.

**What "strict" means here.** A rule is a defect when it prevents a role from doing something the run has *already
authorized*, or when it contradicts another surface that promises the same capability, or when a ceiling is hard-coded
below what the host already supports. A rule that simply enforces a recorded decision (planner has no target tools, workers
cannot spawn, coverage is host-derived) is not a defect and is not listed as one. Every finding carries one class:

| class | meaning |
| --- | --- |
| **A** | deliberately strict, and it enforces a decision — keep; listed only so the audit is honest |
| **B** | conservative ceiling: the host supports more than its model surface or handler allows, and no setting exposes it |
| **C** | inconsistency: two surfaces disagree, or the code defeats its own stated contract (the capability is lost silently) |
| **D** | missing knob: a hard-coded ceiling with no operator setting, even where the surrounding design already has settings |

**Severity (capability cost)** — high: changes whether an authorized campaign can reach evidence it is entitled to;
med: repeated friction or lost detail on a normal run; low: ergonomics only.

**Method.** Four read-only sweeps over code *and* its model-facing text: execution surface (target tools, sandbox, HTTP,
PTY, session), admission/lifecycle (tasks, engine, queue, review, finish), runtime/model/context (roles, skills, context
packets, prompts), knowledge/record/reporting (cases, coverage, plans, graph, search, artifacts, report). Evidence is
`file:line` in the working tree at `01144a3`. No model call, no Docker run, no test run, no file changed by the audits.
Where an effect depends on runtime frequency it is stated as an inference, not measured.

## 28. Headline: the ten constraints that cost the most capability

| # | finding | axis | evidence | class | cost |
| --- | --- | --- | --- | --- | --- |
| 1 | The operator's campaign frame stops at the delegation boundary: a worker never sees the stated objective, the `--allow` permissions or the planner's steering; the brief carries only the avoid-list. | WF | `index.ts:735`, `prompts.ts:214-253` | C | high |
| 2 | Default start (`shared` executor) forces `maxTargetOperations=1`; three workers raise model concurrency, never target throughput. | TR | `index.ts:2973-2974`, `roles.ts:127` | D | high |
| 3 | Every target command re-verifies the task's pinned asset revisions, so any worker (or sibling) that updates an asset makes its own next command fail `STALE_WORK_REFERENCE`. | TR | `tasks.ts:266-268`, `tasks.ts:420-435` | C | high |
| 4 | The planner cannot choose a worker's model or thinking; those fields exist only on the hidden `p2o_delegate` schema, and role defaults are hard-coded. | WF | `roles.ts:22-29`, `tool-schemas.ts:179-191`, `tool-policy.ts:56` | D | high |
| 5 | Case authoring demands two opaque host UUIDs the host already joins internally (asset id and candidate record id) at create time. | TR | `case-types.ts:109,120`, `cases.ts:126-128` | C | high |
| 6 | Workers are told their skills are "already loaded"; only the first 8 KiB page of each playbook is inlined, and the default recon playbook is 8,591 B. | WF | `skills.ts:12`, `index.ts:669-670`, `prompts.ts:270-274` | C | med-high |
| 7 | `p2o_research action=fetch` is described as returning "the full body ... no size cap" but the visible text is silently cut at 48 KiB while bytes/sha256 describe the full body. | TR | `index.ts:2110`, `index.ts:2120`, `process.ts:3,82-84` | C | high |
| 8 | One lingering pane pauses the whole campaign scheduler; any task revision edit drops the queued intent; `p2o_finish` refuses while an intent is queued. | TR | `engine.ts:162-163`, `engine.ts:169-170`, `index.ts:2662` | C | med-high |
| 9 | Skills are silently sliced to three (the exploit ladder can be cut mid-sequence) and the worker/planner context packets are hard-coded at 8 and 12 KiB against a store default of 20 KiB. | WF | `roles.ts:91,68,196`, `index.ts:3237`, `index.ts:3400` | C/B | med-high |
| 10 | The coverage plan view cannot be paged: the whole view goes through a 24 KiB `boundedResult` that throws, so a large plan's cells are unreachable. | TR | `index.ts:218,2013-2017` | B | med-high |

## 29. Axis 1 — Workflow: prompt · skills · flow

| ID | capability lost | rule and evidence | cost | class | lift |
| --- | --- | --- | --- | --- | --- |
| WF-01 | Worker does not know the operator frame | brief passes `constraints: current.avoid` only (`index.ts:735`); worker prompt adds mode/effects/ingress/secrets (`prompts.ts:230-240`) but not `statedObjective` (`prompts.ts:138`), `--allow` permissions or recorded steering (`prompts.ts:90-95`) | high | C | pass objective + allow + steering to the brief as data lines (guidance, no enforcement change) |
| WF-02 | Planner cannot pick worker model | hard-coded `ROLE_DEFAULTS` (`roles.ts:22-29`); per-role settings only, no per-task field (`roles.ts:138-175`); `model`/`thinking` only on the hidden delegate schema (`tool-schemas.ts:179-191`) | high | D | optional `model`/`thinking` on the task draft + dispatch |
| WF-03 | Thinking level is inherited, not chosen | `resolveRole` receives `parentThinking` (`index.ts:656`); no per-task requirement | med | D | same as WF-02 |
| WF-04 | Skills silently sliced to 3 | `MAX_SKILLS=3` (`roles.ts:91`), slice in `resolveRole` (`roles.ts:196`) and in `exploitationSkills` (`roles.ts:68`); no warning or record when a requested skill is dropped | med-high | C | record a note + surface the dropped ids in the create response, or raise the cap (option B) |
| WF-05 | Playbooks are one page | `PAGE_BYTES=8 KiB` (`skills.ts:12`); only `page.text` is inlined (`index.ts:669-670`); `skills/attack-surface-mapping/SKILL.md` is 8,591 B; the catalog says "Main documents are inlined" (`prompts.ts:11`) and the brief says "already loaded for you; follow them" (`prompts.ts:270-274`) | med-high | C | 24 KiB page (broker frame is 64 KiB), inline up to N pages, and name the continuation pointer in the brief |
| WF-06 | Worker context packet 8 KiB | hard-coded `maxBytes:8192` (`index.ts:3237`); store default 20 KiB, max 48 KiB (`store.ts:474`); omitted heads are counted as omitted without being shown | med | B | 20 KiB |
| WF-07 | Planner context packet 12 KiB | hard-coded `maxBytes:12*1024` (`index.ts:3400`) | low-med | B | 20 KiB |
| WF-08 | No autonomous planning rounds by default | `loopMode:'manual'` (`roles.ts:127,140`); the planner cannot switch; only the operator can start `--loop event-driven` | med | A | keep — it is the operator's cost decision, and the knob exists |
| WF-09 | Validation prompt advertises verbs it does not hold | `VALIDATION_TOOL_LINE` lists session `open/list/exec/upload/download/listen/snapshot/close` (`prompts.ts:212`); the host allows `action=open` only (`index.ts:3116`) | med | C | name `open` only in the validation line |
| WF-10 | Every step is a cold start | one intent, write back, report, stop (`prompts.ts:226,248`); each next step is a new spawn + brief + packet | med-high | A | keep the intent discipline (it is what makes review possible), but see WF-11 |
| WF-11 | Hold = exactly one continuation | `holdFor` is a single brief (`tool-schemas.ts:221-222`); `consumeHeldContinuation` is one-shot (`index.ts:788`); a second continue is refused (`index.ts:774`) | med | D | `holdContinuations` 0..3, default 1 |
| WF-12 | Effective caps have no single source | `truth.ts` covers sandbox/network/http/credential/risk only; byte ceilings live per handler/description and six have already drifted (TR-D section) | med | C | one cap block composed into every description/prompt, from the exported constants |
| WF-13 | Planner prompt omits effective caps and queue semantics | the confirmation dialog states executor caps to the operator (`index.ts:2991`), but the planner prompt only says "read the executor profile" (`prompts.ts:144`); queued-intent invalidation (`engine.ts:169-170`) is in no prompt | low-med | C | add one line: shared executor is serial, queued intents are dropped on a revision edit |
| WF-14 | Planner cannot author an `open` unresolved row | `PLANNER_TOOLS` has no `p2o_note` (`tool-policy.ts:24-32`) | low-med | A | keep — a plan decision or a task gap carries it |
| WF-15 | Two claim-join languages | case `claimRefs` takes record UUIDs only (`cases.ts:126`); the chain `claimRef` takes a record id **or** a slug (`cases.ts:172-174`) | med | C | accept a slug in both |
| WF-16 | Brief objective is an excerpt | task `question` max 1500 (`tool-schemas.ts:24`); a 4000-char delegate task is sliced and the remainder recorded only as an "unknown" (`index.ts:678`) | low-med | B/C | raise the cap or record the full text as a fact |
| WF-17 | Worker cannot see its own effective runtime | `requestedRuntime` is on the ticket (`index.ts:710`) but the worker prompt renders only the executor profile (`prompts.ts:242`), not its model/thinking or the effective capture cap | low-med | C | add one identity line |
| WF-18 | Finish preflight shows five ids | `SHOWN=5` (`finish-preflight.ts:44,177`) | low | B | 20 |

## 30. Axis 2 — Tools register: schema · handler · description

### 30.1 Schema ceilings

| ID | ceiling | evidence | cost | class | lift |
| --- | --- | --- | --- | --- | --- |
| TR-S01 | artifact read `length` max 8192 | schema `tool-schemas.ts:175`; store default 16 KiB, max 48 KiB (`store.ts:575-576`) | med | B | 48 KiB |
| TR-S02 | `maxRedirects` max 5 | `tool-schemas.ts:155`; the manual redirect loop honours the number (`sandbox.ts:287`) but `HTTP_TRUTH` promises "any redirect hop" (`truth.ts`) and the guideline repeats it (`tool-guidelines.ts:30`) | med-high | C | default 5, max 20, and make the descriptions agree |
| TR-S03 | HTTP body 32 KiB, URL 4 KiB, header values 4 KiB | `tool-schemas.ts:152-164` | med | B | knob or raise |
| TR-S04 | exec command/send 8 KiB | `tool-schemas.ts:125-133` | med | B | knob (session upload exists, so this is friction not a wall) |
| TR-S05 | session upload 32 KiB | `tool-schemas.ts:139-145`, `index.ts:1387` | med | B | knob |
| TR-S06 | lab payload 32 KiB | `lab.ts:20` | med | B | knob |
| TR-S07 | artifact capture 1 MiB default / 8 MiB max, no per-call size | `roles.ts:96,145`, `index.ts:2234` | med | D | optional per-call size bounded by the setting |
| TR-S08 | ledger page limit 100 and 48 KiB | `records.ts:284-287`, `broker.ts:404` | low-med | A | keep (truncation is honest) |
| TR-S09 | declared maxima do not match enforced maxima | state `limit` declared 100 (`tool-schemas.ts:18`) but search enforces 20 (`search.ts:13,43`); graph declared 500 (`graph-tool.ts:40`) but view/page enforce 100 (`store.ts:857,893`); dispatch `ids` has no `maxItems` (`board-verbs.ts:67-70`) but the engine requires 1..25 (`engine.ts:123`) | low | C | pin declarations to enforcement |
| TR-S10 | report summary 4000 / narrative 6000 / item 1000 | `tool-schemas.ts:212-230` | low | A | keep — findings are arrays and the ledger is the long-form store |
| TR-S11 | worker steering message 2000, continue brief 2000 | `tool-schemas.ts:207-209` | low-med | B | 4000 for a steering sentence that must carry a fact |
| TR-S12 | loop hint/constrain 300 chars | `tool-schemas.ts:197` | low | B | keep — it is one sentence by design |

### 30.2 Handler caps and silent clipping

| ID | cap / behaviour | evidence | cost | class | lift |
| --- | --- | --- | --- | --- | --- |
| TR-H01 | research fetch text cut at 48 KiB (description says full body, no cap) | `index.ts:2110` vs `index.ts:2120` + `process.ts:3,82-84`; `bytes`/`sha256` are computed before the cut (`index.ts:1607-1609`) | high | C | when the body exceeds the cap, save it as an artifact and return the artifact id plus a head, or state the cap; never return a count that does not match the text |
| TR-H02 | coverage plan view unpaged, 24 KiB throw | `boundedResult` (`index.ts:218`) used at `index.ts:2013-2017` | med-high | B | cursor/limit over cells instead of a throw |
| TR-H03 | research `web=true` fetches only the top 2 hits | `index.ts:1692` | med | B | `min(limit,5)` |
| TR-H04 | listener callback log keeps the first 400 B | `index.ts:1437` (`data[:400]`), `index.ts:1458` (`tail -c 400`) | med | B | 4-8 KiB |
| TR-H05 | PTY send/read wait clamped to 60 s | `index.ts:2255`; sandbox allows 120 s (`sandbox.ts:349,374`) | med | B | 120 s |
| TR-H06 | lab environment healthcheck waits 10 s | 20 polls x 0.5 s (`lab.ts:139,323-325`) | med | B | 60 polls |
| TR-H07 | receipt excerpt 16 KiB stdout / 4 KiB stderr / 2000 B input | `evidence.ts:61` | low-med | A | keep — the capture artifact is the reproduction record |
| TR-H08 | graph entity ceilings hard-coded | 5000 asset revisions, 10000 assertions, 2000 relations, 20000 anchors, 40000 provenance (`graph.ts:13-21`) | med-high | D | operator knob with raised ceilings |
| TR-H09 | shared executor forces target ops = 1 | `index.ts:2973-2974`; the settings default is 3 (`roles.ts:127,142`) and becomes dead in shared mode | high | D/A | isolated default, or allow `shared --target-ops N` with the serial guarantee removed by explicit choice |
| TR-H10 | stale asset revision re-checked on every command | pinned at admission (`tasks.ts:266-268`) and re-verified per assignment (`tasks.ts:420-435`, `tasks.ts:480-486`) | high | C | verify at reserve time and on an explicit re-pin request; a body change should warn, not freeze |
| TR-H11 | engine pauses the campaign on reap failure | `engine.ts:162-163` (`deps.reap()` false -> pause) | med-high | C | pause only capacity, keep pumping other work; surface the unverified pane as a fact |
| TR-H12 | queued intent invalidated by any revision change; finish refuses while queued | `engine.ts:169-170`; `index.ts:2662` | med-high | C | status-only revisions keep the queue; finish lists the pending intents or drains them |
| TR-H13 | graph slice for the worker brief fails silently | `graphSlice` catches and returns `[]` (`index.ts:871-884`) | low | C | record one lifecycle fact when the slice is unavailable |
| TR-H14 | secret placeholder only as a standalone shell word or HTTP value | `identity.ts:189-251` | med | B | keep the substitution strict; the worker prompt already states the exact forms (`prompts.ts:239`) |
| TR-H15 | live frontier caps: 100 cases, 10 coverage plans | `cases.ts:156`, `coverage.ts:171` | low | B | raise, or report remaining |
| TR-H16 | broker line frame 64 KiB | `broker.ts:21` | low-med | A | keep — every surface cap above is lower |

### 30.3 Description vs code (the contradiction set)

| ID | claim | reality | cost | class | lift |
| --- | --- | --- | --- | --- | --- |
| TR-D01 | research returns "the full body ... no size cap" (`index.ts:2110`) | 48 KiB visible text (`process.ts:3,82-84`) | high | C | fix the text, or return the artifact (TR-H01) |
| TR-D02 | artifact "default/max 8 KiB" (`index.ts:2413`) | store default 16 KiB, max 48 KiB (`store.ts:575-576`) | med | C | make both say 48 KiB |
| TR-D03 | HTTP "Curl transfer limit 8 MiB" (`index.ts:2354`) and "bounded redirect following" | no `--max-filesize` in the curl args (`sandbox.ts:286-287`); `HTTP_TRUTH` says any redirect hop | med | C | delete the 8 MiB claim; state the real redirect default/max |
| TR-D04 | `p2o_net` "keep assessment traffic to the human-confirmed target ... Scope is agent policy" (`index.ts:2283`) | Part XI: the target is a label, not a boundary (`prompts.ts:121`, `truth.ts NETWORK_TRUTH`) | med | C | reword to the Part XI sentence |
| TR-D05 | `p2o_state` says "titles" are searchable (`index.ts:1888`) | `data.title` is indexed (`search.ts:15,30`) but no writer sets it | low | C | drop the word, or index case/plan titles |
| TR-D06 | `p2o_graph` says "hypotheses/relations are owner work" (`index.ts:2427`) | no per-kind role check on the worker record path (`index.ts:2454`, `store.ts:746-776`) | low-med | C | enforce it, or say "workers write assets/facts/anchors; hypotheses and relations are guidance" |
| TR-D07 | catalog "Main documents are inlined" (`prompts.ts:11`) | only the first page (`index.ts:669`) | med | C | see WF-05 |
| TR-D08 | worker prompt "the artifact (up to 8 MiB)" (`prompts.ts:18`) | default capture is 1 MiB (`roles.ts:96`) | med | C | state the effective cap from settings |
| TR-D09 | a narrower research fetch exists | `fetchResearch` is https-only, 32 KiB, 20 s (`sandbox.ts:233-251`) and production-dead; `RESEARCH_PAGE_BYTES` is exported unused (`research.ts:18`) | low | A | delete both in the cleanup pass, so an old policy cannot be revived by accident |

### 30.4 Admission and lifecycle

| ID | constraint | evidence | cost | class | lift |
| --- | --- | --- | --- | --- | --- |
| TR-L01 | case create needs two opaque host ids | `assetRefs` min 1 `asset-[a-f0-9]{24}` and `claimRefs` min 1 candidate UUID (`case-types.ts:109,120`, `cases.ts:126-128`); coverage already joins reviewed claims and pins revisions (`coverage.ts:75-78,107-113`, `cases.ts:121`) | high | C | derive both from `taskRefs`, or accept the candidate slug |
| TR-L02 | assignment conflict is coarse | exact active duplicate refused (`tasks.ts:285`); any surface/risk overlap with unknown identity refused (`tasks.ts:428,498`) even for a method-different mechanism | med | B | allow the overlap when the method differs, recorded as a decision |
| TR-L03 | purpose lineage refusals | exploitation/chaining need `work.claimRefs` (`tasks.ts:373-414`) | med | A | keep — this is the authority the run recorded |
| TR-L04 | validation identity must match predecessor | `VALIDATION_IDENTITY_MISMATCH` and pinned prerequisites (`tasks.ts:373-414`) | med | A | keep — the host derives the identity, so the friction is one "omit work" |
| TR-L05 | create-time constants must be sent | case `reviewStatus` pending-only (`cases.ts:156`), coverage `status` draft/active (`coverage.ts:171`), goal create proposed/active (`planning.ts:176`) | low | C | default on the host when omitted |
| TR-L06 | required empty fields | task `evidenceIds`+`prerequisites` (`tool-schemas.ts:30`), coverage `exclusions`+`unknownScope` (`coverage-types.ts:28`), case `remediation{status,reason>=10,evidenceRefs}` (`case-tool.ts:133`) | low | C | default `[]` / `unplanned` |
| TR-L07 | goal close needs `supportRefs` even when proof is a case or coverage plan | `planning.ts:183,153`; `goal-proof.ts:33-49` | med | C | let the proof alone settle the status; supportRefs optional |
| TR-L08 | a todo cannot state criteria | "Only goals define criteria/exclusions" (`planning.ts:114`, `work-tool.ts:29`) | med | C | allow criteria/exclusions on todos |
| TR-L09 | support refs are evidence-only | plan support must be same-run evidence (`planning.ts:153`); candidates only as `claimRefs` on todos (`planning.ts:83`) | med | C | widen to candidate/plan/task record ids |
| TR-L10 | preflight lists five ids | `finish-preflight.ts:44,177` | low | B | 20 |

## 31. What is deliberately strict and must stay

This is the audit's anchor; lifting anything below would be an authority change, not a capability fix.

- Planner holds no target/lab/claim/surface/report tools (`tool-policy.ts:14,24-32`); the planner plans, reviews and proves.
- Workers cannot spawn or dispatch (`index.ts:3251`, `tool-policy.ts:34-38`); a worker may only request an unaccepted subtask.
- Worker is the only claim author; a confirmed claim carries a host-stamped task ref (`index.ts:2130-2133`).
- `p2o_delegate` and `p2o_task_start` stay hidden (`tool-policy.ts:56`).
- Coverage cells remain host-derived; no role holds a cell writer (`tool-policy.ts:21`).
- Review is not proof (`tool-guidelines.ts:10`); receipts are observations (`prompts.ts:20`).
- Validation loses `p2o_surface` and gets `p2o_session action=open` only.
- Reporter is read-only (`tool-policy.ts:48`, `prompts.ts:182-200`).
- Secrets are list-only; a value never crosses `p2o_secret` (`tool-schemas.ts:148`).
- A CVE lead never confirms a claim (`tool-guidelines.ts:31`).
- Case create is pending-only; host-bound owner attribution (`cases.ts:109`).
- The report is deterministic and authoritative; the planner only narrates.
- Part XI unchanged: the target is a starting label, not an egress boundary; citation fetch has no allowlist and no response cap.

## 32. Options (each with what it buys and what it costs)

**Option A — truth and plumbing (recommended first).**
Fix the contradiction set (TR-D01..D08), return over-cap research bodies as artifacts (TR-H01), and lift only the ceilings
that sit below what the host already supports: artifact read 8->48 KiB, skill page 8->24 KiB, worker packet 8->20 KiB,
planner packet 12->20 KiB, PTY wait 60->120 s, listener log 400 B->8 KiB, environment verify 10->30 s, research web
top-2->min(limit,5), redirect max 5->20 with honest text, pin declared maxima to enforced ones (TR-S09). Workflow side:
the brief carries the stated objective, `--allow` lines and steering (WF-01), the worker prompt states its effective
runtime and capture cap (WF-17), the validation tool line names `open` only (WF-09), and a sliced skill list records a
warning (WF-04). Delete the dead narrow fetch path (TR-D09). No authority change, no new setting, ~10 files plus tests.
*Trade-off:* removes the lies and the cheap friction, but the four high-cost behavioural items (serial executor, per-command
re-stale, engine pause/queue loss, case refs) remain; a campaign still pays them.

**Option B — ceilings become operator settings.**
Turn the hard-coded ceilings that a real engagement can hit into settings with raised defaults: HTTP body/URL/redirects,
session upload, lab payload, artifact read, skill page, receipt excerpt, graph entity ceilings (TR-H08), ledger page,
research pages, preflight shown. Each gets a clamp, a docs row in `docs/USAGE.md` and a pinning test. *Trade-off:* the
configuration surface grows by roughly ten knobs, and each knob is a new compatibility promise; it also does not fix a
contradiction by itself, so A is still required. Better as a second pass driven by observed need than as a first move.

**Option C — scheduler and authoring pass (needs your sign-off).**
Behavioural fixes that buy the most capability: shared/isolated default (TR-H09), stale check at reserve only (TR-H10),
engine keeps pumping when one pane lingers (TR-H11), the queue survives a status-only revise and finish drains or lists
pending intents (TR-H12), `holdContinuations` (WF-11), per-task model/thinking (WF-02/WF-03), host-derived case refs
(TR-L01), paged coverage view (TR-H02), wider search, reporter board read, goal proof settles close (TR-L07), todo criteria
(TR-L08), conflict granularity (TR-L02), and the search/creation constants defaulted (TR-L05/L06). These touch
`engine.ts`, `tasks.ts`, `cases.ts`, `coverage.ts`, `planning.ts`, `tool-policy.ts` and the tool schemas; each item is small
but they change invariants the current tests pin, so they need decisions and a dedicated test pass. *Trade-off:* highest
capability gain and highest review cost; three of the items (executor default, stale semantics, finish semantics) are
operator-visible behaviour changes, not bug fixes.

**Recommended sequence:** A now (a day, no decisions needed beyond wording), then C's scheduler half as P10, and B only
where a run actually hits a ceiling (artifact read and graph ceilings first).

## 33. Open questions for the owner (Q26-Q32)

- **Q26.** Is `shared` + serial the intended default, or should a new run default to `isolated`? (TR-H09)
- **Q27.** Should a worker receive the operator's objective, `--allow` lines and steering verbatim (as data), or a derived
  one-line campaign summary? Verbatim is more faithful and longer; derived is cheaper and loses the operator's words. (WF-01)
- **Q28.** Should the planner be able to choose a worker's model/thinking per task (cost/quality control), or stay with
  per-role settings? (WF-02)
- **Q29.** Graph ceilings: raise the hard caps, expose a setting, or add a prune/archive path? (TR-H08)
- **Q30.** Case create: derive asset/claim refs from `taskRefs` (host joins reviewed claims already), or keep both explicit
  and only accept the candidate slug? (TR-L01)
- **Q31.** Skill slice: warn only, or raise `MAX_SKILLS` to 5? (WF-04)
- **Q32.** Finish with queued intents: keep the refusal, list them, or drain them? (TR-H12)

## Appendix J - traceability: finding -> option

| finding group | option |
| --- | --- |
| TR-D01..D08, TR-S09, TR-H01, TR-H03..H06, WF-01, WF-04, WF-05, WF-17 | A |
| TR-S01..S07, TR-H08, TR-L10, WF-06, WF-07 | B |
| TR-H09..H12, TR-L01, TR-L02, TR-L05..L09, WF-02, WF-03, WF-11 | C |
| WF-08, WF-10, WF-14, TR-L03, TR-L04, TR-H07, TR-S08, TR-S10, TR-H16 | keep |

## Appendix K - what this part does not claim

It does not claim any of these rules is *unnecessary* — only that its cost is not matched by a recorded decision (class A
items are the ones that are matched). It does not measure how often a run hits a given refusal; the sweeps are static. It
does not propose widening target authority, scope, or the egress model of Part XI. And it does not implement anything:
`planning_update.md` is the only file this pass touches.

## Appendix L - P9 implementation record (2026-10-27)

Option A of Part IV was implemented on 2026-10-27, without widening authority: the planner still holds no target/lab/claim
tool, workers still cannot spawn or dispatch, coverage stays host-derived, review is not proof, and the citation fetch stays
host-side with no allowlist and no response-size cap (Part XI). A worked example of what changed, by axis:

**Workflow layer (prompt · skills · flow).** `KNOWLEDGE_CATALOG` now states the real 24 KiB page and that a longer document
continues via `nextOffset`; `EVIDENCE_CEILING` says the configured capture cap (default 1 MiB) instead of a hard-coded
8 MiB; the validation loadout line limits `p2o_session` to `action=open`; `workerBrief` accepts optional
`hints/objective/permissions` and renders `OPERATOR OBJECTIVE/PERMISSIONS/CONSTRAINTS/HINTS` before `TASK:`; a worker who
was given a task now receives the operator's own stated objective, allow lines and mid-run steering as data (WF-01);
`workerInstructions` prints `Capture cap:` and `Requested runtime:` only when the ticket carries them, so legacy tickets
render byte-identically; the ticket gains the validated `captureKiB` field; and a requested skill list sliced by
`MAX_SKILLS` now leaves a lifecycle note naming requested vs delivered (WF-04).

**Tools-register layer (schema · handler · description).** Artifact read ceiling 8 KiB -> 48 KiB in the schema, the host
check and the description; `p2o_http` `maxRedirects` 5 -> 20 (schema, host, description; default stays 3); task dispatch
declares its real `1..25` id batch; `p2o_state` search reaches 100; `p2o_research action=fetch` keeps the uncapped fetch but
retains a body larger than the 8 KiB inline head as a same-run `research-fetch` artifact and returns its id; the web lookup
fetches `min(limit, 5)` pages instead of the top two; `p2o_net`, `p2o_http`, `p2o_graph`, `p2o_artifact` and `p2o_state`
descriptions were corrected against the code; dead code that contradicted Part XI was deleted (`Sandbox.fetchResearch`,
`RESEARCH_PAGE_BYTES`, its inert-sandbox override); lab environment polling waits 30 s; PTY wait clamps at 120 s; listener
logs keep an 8 KiB tail; worker and planner context packets are 20 KiB; finish preflight shows 20 rows.

Gates, run on the working tree (nothing committed or pushed): `npm run typecheck`, `npm run build` and `npm run check:build`
clean; `git diff --check` clean for every file of this pass (the pre-existing `AGENTS.md` edit still carries its own trailing
whitespace and was left untouched); full `npx vitest run` 1,038 passed / 12 skipped in 6 skipped files, no failures. The new
pins are listed in `docs/ACCEPTANCE_MATRIX.md` under "P9/A9".

Owner decisions this pass relied on: scope = Option A (fix contradictions and lift the cheap caps); Q26 for the future P10
scheduler pass = keep `shared` as the default executor and add `--target-ops N`; P8.2's behavioural half stays closed by
Part XI. Deferred to their own passes: Q26/P10 scheduler work, the graph/artifact store ceiling raises (the graph half was
taken by P9/B, Appendix M), stale/finish semantics and per-task model/thinking (Option C). The other files in the working tree (`AGENTS.md`, `Claude outputs/`,
`pi-p2o-defense-vi.pptx`) predate this pass and are not part of it.

## Appendix M - P9/B implementation record (2026-10-27)

Option B of Part IV was implemented the same day under two owner decisions: the remaining request ceilings are **raised
constants**, not new settings; the graph ceilings are an **operator setting with a raised default** (Q29). Nothing widened
authority: the sandbox, Part XI and the role loadouts are untouched, and `graphCapacity` only scales how much typed graph
data one run may retain.

**Request ceilings (TR-S03..07), broker-safe.** exec command 8 -> 32 KiB, PTY send 8 -> 16 KiB, session upload 32 -> 48 KiB,
HTTP body 32 -> 48 KiB, HTTP URL 4096 -> 8192 characters, request headers 8 -> 16 KiB total and 4 -> 8 KiB per value, lab
payload 32 -> 48 KiB. The schema maximum, the handler check and the broker frame now agree, so a declaration cannot accept a
value the transport will reject; the broker's own exec/PTY checks were raised with the schema instead of being left behind.
`p2o_capture` gained `maxKiB`, a per-call bound that can only lower the run's `artifactCaptureKiB`: the owner clamps it in
the handler, and a worker request is clamped again by the owner-side broker handler before the capture runs.

**Graph capacity (TR-H08, Q29).** New `p2o.graphCapacity` setting, integer 1..4, default 2, parsed with the usual
fallback; it multiplies the five hard ceilings (assets, assertions, relations, anchors, provenance) and is read when the
store opens, so a resumed run gets the current setting. `AssessmentStore` exposes `graphCapacity`/`graphLimits` and refuses a
bad capacity before touching the database; a library caller that opens a store without the option keeps capacity 1, so
direct store users keep the old ceilings. The capacity error stays honest and no prune path was added.

**Truth.** `docs/USAGE.md` (setting row plus the capture per-call note), `docs/HTTP_TRANSPORT.md`, `docs/STATE_STORE.md`,
`docs/ASSET_GRAPH.md`, `docs/SKILL_RUNTIME.md`, `README.md`, and the stale `docs/CONTEXT_PACKETS.md` packet sizes left over
from P9/A (Planner/Worker 20 KiB) now state the numbers the code enforces; the `p2o_http`, `p2o_lab` and `p2o_capture`
descriptions state the new limits too.

Gates on the working tree (nothing committed or pushed): `npm run typecheck`, `npm run build` and `npm run check:build`
clean; full `npx vitest run` 1,041 passed / 12 skipped in 6 skipped files, no failures; `git diff --check` clean for every
file of this pass. The matrix rows live in `docs/ACCEPTANCE_MATRIX.md` under "P9/B". Two boundary tests were retargeted to the
new numbers on purpose (`broker.test.ts` oversized command/body, `sandbox.test.ts` URL length), and the new pins are the P9/B
schema test, the per-call capture test and the graph-capacity store test.

Still open, unchanged by this pass: Q26/P10 scheduler work (owner chose to keep `shared` as the default and allow
`--target-ops N`), Option C semantics (stale check, engine pause/queue, finish with queued intents, per-task
model/thinking, host-derived case refs), and the artifact-store ceiling itself — the TR-S07 lift added the per-call bound,
while the 8 MiB store maximum was not raised. Working-tree files that predate both passes (`AGENTS.md`,
`Claude outputs/`, `pi-p2o-defense-vi.pptx`) remain untouched.

## Appendix N - P10 implementation record (2026-10-27)

**Option C** of Part IV was implemented the same day, on top of P9/A and P9/B, under the owner's instruction to do the
**whole** option ("Toàn bộ Option C"), not a subset: the scheduler/executor/queue half (TR-H09..H12, WF-11, WF-02/03, WF-13,
TR-L02) and the authoring half (TR-L01, TR-L05..L09, TR-H02). Nothing widened authority: the planner still holds no
target/lab/claim tool, workers still cannot spawn or dispatch, coverage still has no model cell writer (host-derived only),
review is still not proof, finish still has no gate, and the citation fetch stays host-side with no allowlist and no response
cap (Part XI). What changed is information and legal paths: the queue keeps an accepted intent across identity-preserving
revisions, an explicit `--target-ops N` lifts the shared serial queue and is recorded, a held worker can be continued more
than once, a per-task runtime is validated instead of inferred, and the authoring verbs stop demanding fields the host can
derive.

**Scheduler, executor and queue.** `src/sandbox.ts` gains an opt-in `concurrentOperations` bound and a per-target queue used
by `exec`/`captureScratch`/`http` (provision/write/cleanup stay serial); `extensions/p2o/index.ts` resolves the effective cap
as explicit CLI → stored profile → default (shared default stays 1), records one `executor profile: shared executor with an
explicit target-operation cap of N; the default serial guarantee was removed by the operator (--target-ops N)` lifecycle line
only for that explicit choice, and the confirmation says the same. `src/engine.ts` drains accepted intents against a stable
identity (`intentIdentity`) instead of any revision change, records one `PANE_REAP_UNVERIFIED` backpressure fact and skips the
round when a pane reap is unverified instead of pausing the campaign, and a final finish still refuses with `INTENTS_QUEUED`,
naming each queued intent and the omitted count (it never drains the queue). `src/tasks.ts` makes `assertReady` a structural
check and records one `STALE_WORK_REFERENCE` warning per drifted (task, asset, pinned revision) rather than freezing the
worker; admission still pins and refuses. `src/broker.ts`/`src/tool-schemas.ts` add `holdContinuations` 0..3 (default 1) so
one hold can authorize several briefs: a held worker may report until its first continuation is consumed, each `continue`
spends one, and `0` retires the ticket while the report still names the successor. `src/roles.ts` adds
`allowedWorkerModels`/`validateTaskRuntime`, and `src/tasks.ts`/`src/tool-schemas.ts`/`src/board-verbs.ts`/`extensions/p2o`
carry an optional `runtime:{model,thinking}` on the task draft plus a one-dispatch `model`/`thinking` override, validated
against the configured role models and `THINKING_LEVELS` (`MODEL_UNAVAILABLE`/`THINKING_INVALID` with legalNext); a held
ticket keeps the runtime it started with (`RUNTIME_FIXED`), and the planner prompt lists the configured models only when
delegation is enabled. `src/prompts.ts` adds the `EXECUTOR AND QUEUE` line (cap, serial default, queue identity, finish
refusal; no tool names). `src/tasks.ts` also allows a same-surface/risk reservation when both tasks declare different
`work.methodFamily`, recording `method-different-overlap:<taskId>` on the reserved revision instead of refusing.

**Authoring.** Case creation derives `assetRefs`/`claimRefs` from the cited reviewed `taskRefs` when the caller omits them
and accepts a candidate record id **or** slug in `claimRefs` (stored resolved), with actionable refusals; a case with no
`reviewStatus` is `pending` and no `remediation` is recorded honestly as `unplanned` with a fixed reason. A coverage plan
with no status is a `draft` with empty scope lists, and `p2o_board board=coverage id=<plan>` pages its derived `cells`
(cursor/limit, `nextCursor`, stable totals) instead of throwing at 24 KiB. A goal created without a status is `active`
(completion already reads every non-settled goal as open work), a goal may be settled by its proof alone with the host
recording the demonstrating claim or case/plan id as support, plan `supportRefs` accept same-run evidence, candidate, task,
plan (and case id/case record id, so the host-written TR-L07 row round-trips), a todo may carry an advisory
`criteria`/`exclusions` list that never gates completion, and an omitted `evidenceIds`/`prerequisites` on a task draft is
stored as `[]`. All of it is host-side derivation or defaults: no new authoring authority, and review/acceptance remains as
strict as before.

**Owner decisions this pass relied on:** scope = the whole Option C; Q26 = keep `shared` as the default executor and honour
an explicit `--target-ops N` (the serial guarantee is removed only by that explicit choice, and the ledger says so); Q28 =
per-task and one-dispatch worker model/thinking are allowed and host-validated against the configured set; Q32 = a final
finish with queued intents keeps refusing and lists them instead of draining; Q30/TR-L01 = derive both case reference lists
from `taskRefs` **and** accept a candidate slug in `claimRefs`; TR-L05 = created goal defaults `active`; TR-L06 = honest
defaults; TR-L07 = a settled proof alone may close a goal, with host-recorded proof refs; TR-L08 = todo criteria are
advisory; TR-L09 = support refs widen to same-run evidence/candidate/task/plan ids; TR-H02 = paged coverage plan view.

**Scope note.** §32's prose also mentions a "wider search" and a "reporter board read", but neither has a §28/§29/§30
finding id in the traceability list (Appendix J); they appear only inside the Option C prose, so this pass implemented the
items that do have ids and invented no scope for the two that do not.

Gates on the working tree (nothing committed or pushed): `npm run typecheck`, `npm run build` and `npm run check:build`
clean; `git diff --check` clean for every file of this pass (the pre-existing `AGENTS.md` edit still carries its own trailing
whitespace and was left untouched); full `npx vitest run` 1,069 passed / 12 skipped in 6 skipped files (124 files), no
failures. The new pins are listed in `docs/ACCEPTANCE_MATRIX.md` under "P10/C"; one stale citation (the renamed
`engine.test.ts` queue test) was updated in the same pass. Boundary tests retargeted on purpose: `frontier.test.ts`,
`loop.test.ts` and `planning.test.ts` bodies (admission/drift ordering, proof-before-support), and the finish-preflight /
completion fixtures where the new defaults changed counts.

Not claimed or not done: no target/scope/authority widening of any kind, Part XI unchanged; the artifact-store ceiling
itself is still not raised (P9/B added only the per-call bound); TR-L07 records the proof support it can derive, it does not
accept a caller-invented note id as support (TR-L09 stays within same-run work records); the "wider search" and "reporter
board read" scope above remains unimplemented by design. Working-tree files that predate every pass (`AGENTS.md`,
`Claude outputs/`, `pi-p2o-defense-vi.pptx`) remain untouched.

## Appendix O - P11 implementation record (2026-10-27)

**What happened.** A measured run ended by asking a human for three permissions — one read-only POST to a server action,
reachability of the internal host `192.168.43.110` for an SSRF check, and one provisioned user/admin account — and reported
"no credentials granted, no internal host, no browser". The owner's instruction was unqualified: the agent may do anything
it needs to reach the target, remove the strict/banned doctrine. Three questions were put to the owner and answered:
**Option C** (all three workstreams: prompt+skill rewrite, host authorization frame, browser and identity capability), the
third-party guardrails in the skill library are **removed** ("bỏ luôn"), and the verification configuration is
**exploit default, no `--avoid`, no `--identity`** — so every blocker has to be text/doctrine, never operator configuration.

**Diagnosis.** Part XI and `src/truth.ts` were already permissive: the target is a starting label, no origin filtering, any
method/body, private/metadata hosts reachable. The blockers were elsewhere: (1) worker-facing skill doctrine told the model to
"stop before any state-changing request", to "contact nothing outside the confirmed origin", and to require
"operator-supplied credentials"; (2) `HANDOFFS.md` said "other origins, hosts and ports are out of scope"; (3) the planner and
worker prompts contained escalation vocabulary ("report blocked/human-needed", "report the blocked prerequisite", "keep the
human informed") that turned a work item into a permission request; (4) the report and the WSTG matrix asserted "there is no
browser" and "no operator identity means the test is out of reach" — and the browser claim was simply false.

**What the image actually provides (verified, not assumed).** `ghcr.io/usestrix/strix-sandbox` at the pinned digest already
ships Chromium 150 (`/usr/bin/chromium`, `AGENT_BROWSER_EXECUTABLE_PATH`, UA and args preconfigured), Node v24.18.0, npm
11.16.0, Python 3.13 and the `agent-browser` 0.26.0 CLI on PATH (open/click/type/fill/press/wait/snapshot/get/find/eval/
screenshot/pdf/tabs/network route+requests+har/cookies+storage/set headers/auth vault/`--state`/`--session-name`/console/
errors/trace/record/batch). Running `agent-browser --session t1 open http://127.0.0.1:8123/index.html` inside the image works
headless as root with no extra flags and no install step.

**Implementation.** `src/truth.ts` gains `AUTHORIZATION_TRUTH` (blanket authorization for the run; no per-action consent;
only a refusing tool/host or an exhausted approach is a wall) and `BROWSER_TRUTH` (the installed Chromium and agent-browser
transport, and how it is driven), and `CREDENTIAL_TRUTH` gains the self-provisioned-principal sentence without weakening the
sealed channel or its redaction/audit rules. `src/prompts.ts` composes those facts into the planner prompt, the worker/validation
loadout lines and **every** `workerBrief` (which also loses "SCOPE is a boundary" and the per-action ceiling), adds one short
worker/validation AUTHORIZATION rule, rewrites the escalation lines so `blocked` means "approaches exhausted, with what was
tried", and states that a missing credential/account/browser is provisioned, not requested. `src/tool-guidelines.ts`,
`extensions/p2o/index.ts` (shell/network descriptions), `src/tool-schemas.ts` (candidate `requirement` now means a real wall,
not a missing dependency), `src/report-export.ts` (Tool limits + severity wording + WSTG flag semantics) and `src/debt.ts`
(browser/identity default to available; an explicit `false` still narrows) carry the same truth. `HANDOFFS.md`,
`docs/WSTG_MAP.md`, `docs/HTTP_TRANSPORT.md`, `docs/USAGE.md` and `README.md` are corrected; the skill library is rewritten by
the delegated owner of `skills/**` (scope/egress → starting label, no separate mutation-scope approval, no operator-credential
requirement, browser transport available, third-party guardrail stop-lines deleted, honesty/proof-level lines kept, `<8000`
character first-page target preserved).

**What was deliberately not done.** No new tool and no new broker operation: the browser and identity are already image
capabilities and go through the existing shell/network command, receipt, capture, command-policy and cleanup path, so a
wrapper would only have duplicated them. Authority is unchanged (planner has no target/lab/claim tools, worker is the only
executor and claim author, reporter is read-only, coverage is host-derived, review is not proof, Part XI fetch stays host-side
uncapped), sandbox isolation is unchanged (no host mount, no Docker socket), and start-time ownership confirmation stays.
Availability-loss (DoS) effect classes remain excluded from the default set; that is a separate owner decision, not part of
this pass.

**Owner decisions this pass relied on:** Option C for all three workstreams; third-party guardrails removed from the skill
library; verification run uses exploit default / no `--avoid` / no `--identity`; keep the existing authority architecture and
Part XI; commit/push only on the owner's explicit request.

Gates on the working tree (nothing committed): `npm run typecheck`, `npm run build`, `npm run check:build` clean; full
`npx vitest run` **1.071 pass / 12 skip / 6 skipped files (124 files), 0 fail**, after the two pinned-guidance hashes were
re-pinned on purpose; `git diff --check` clean for every file of this pass (the pre-existing `AGENTS.md` edit keeps its own
trailing whitespace and was not touched); `npm run check:library` passes and the skill-hygiene/wstg-skills/skills suites cover
the rewritten library. `npm run check:python` passes `check:render`, `check:orange`, `check:orange-validate`, `check:library`
and 154 of its 155 python tests: the one failure is pre-existing environment drift, not this pass —
`test_library.SkillProfileTests.test_provenance_record_matches_review_snapshot` compares the local `my_references/strix`
checkout (HEAD `fde37a1`, newer than the reviewed 1.7.0 snapshot) against `research/SKILL_PROVENANCE.json`, and R1/A1/A2/A3
drift while LICENSE/pyproject match; `my_references/` is gitignored, has not changed since 2026-10-21 and was not touched
here, so recording a new provenance hash would assert a review that did not happen. Three library invariants that pinned the
retired doctrine were updated with the pass (the browser workflow prerequisite now names Chromium/agent-browser, the
output-context document must show live-vs-offline proof, and `chromium` is no longer treated as a benchmark-specific word).
One new test title anchors the pass in `docs/ACCEPTANCE_MATRIX.md` ("P11/A11" section): blanket authorization/browser/identity
on every model surface, the WSTG denominator including B/I rows by default, and the report/skill docs truth.

Not claimed: no target was touched and no paid model was run for this pass; `agent-browser` was exercised headless against a
local fixture page inside the pinned image, not against a target. Removing the third-party guardrails is an owner decision,
not a claim that sandbox, command policy and ownership confirmation replace them. The real gate — a re-run exploit-default
campaign that no longer stops to ask for a POST, an internal host or an account — is still the owner's to run.
