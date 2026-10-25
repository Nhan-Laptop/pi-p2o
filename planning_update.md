# planning_update.md — a researcher that does not stop until the chain is taken

**Status: planning only. No `src/`, prompt, test or doc file is changed by this pass, and no target is contacted.**
This revision **reuses** the 2026-10-24 diagnosis (kept in full at `tmp/planning-2026-10-24-diagnosis-early-finish.md`) and
the P14/P15 implementation record (archived at `tmp/planning-2026-10-23-p14-p15-archive.md`), and changes what the plan
*aims at*: not "a longer run", but **a researcher that keeps taking the next link of an attack chain until the chain is
either demonstrated or walled by evidence**.

**Owner decisions in force** (they outrank anything below):

1. **No budgets.** No command ceiling, no per-purpose allowance, no admission reserve, no planner-round cap, no
   `work.budget.commands`, no wrap-up obligation caused by an allowance ending. Not tuned down — removed.
2. **No context ceilings and no test pins that fail because a prompt grew.** `tests/minimal/helpers/budgets.ts` goes.
3. **Coverage is a floor, never a dispatch rank.** A run must not chase a percentage; it must take the next link.
4. **No finish gate.** `warn`/`confirm` is removed, not retuned: a run ends by derived completion or by a human stop, and
   exporting a report is not the act that ends it (ARTEX has no such act either).

**The thesis, in one paragraph.** p2o is *ahead* of ARTEX on chain typing — typed capabilities, byte-exact payloads,
environment fingerprints, severity computed from what a step demonstrated, and independent replay (P14.1–P14.12) — and
*behind* it on durability: ARTEX has no `finish` verb, its units are typed intents claimed from a frontier, and a chain
survives because every new intent must anchor on a fact/finding already produced. p2o has the chain *vocabulary* but no
chain *obligation*: the frontier is one line of the situation block (`src/situation.ts:97,117`), and when the task list
drains, `0 open` is enough to close. So this plan does not add persistence features to a planner; it moves the unit of
work from "a task someone thought of" to "the next link the ledger already proves is ready".

---

## 0. What this revision does to the previous proposals

| Previous | Verdict | Why |
|---|---|---|
| D1 `finishGate` (`warn`/`confirm`/`off`) | **dropped — no gate at all** | A gate that may be refused once and then passed is exactly the shape that let the measured run close as "finished, incomplete". Owner decision: remove it. Replaced by derived completion and a report that ends nothing. §IV M3. |
| D2 coverage denominator mandatory | **rewritten as backlog + denominator** | The cell board supplies the backlog and the report's denominator; it never refuses and never orders dispatch (§II.4). A goal that wants a coverage floor declares it in its own bounded `criteria`. §IV M3. |
| D3 open gaps converted or deferred | **keep** | Same escape (a `deferred` todo with `revisitCondition`), cap 10. |
| D4 depth contract + `GOAL_UNSETTLED` | **rewrite** | The old form read "≥25 % budget left", a counter that no longer exists. Depth becomes *chain closure*, not a per-surface count. §IV M4. |
| D5 wake allowance (`--wake-budget N`) | **drop as budget, rebuild as condition** | An allowance is spend by another name. Replaced by a *condition-bounded revisit* that is not counted against anything. §IV M7. |
| D6 resumable worker conversation | **keep** | Cheapest persistence in the whole list; `steer` is already the transport. §IV M8. |
| D7 chain-first rule (prompt only) | **upgrade to host-checked** | A prompt rule is what ARTEX itself lists under "what not to transplant". Becomes `CHAIN_READY_UNDISPATCHED`. §IV M2. |
| D8 admission tax visibility | **keep** | Pure accounting; also removes one prompt obligation by deriving purpose from role. §IV M6. |
| — | **new**: M1 chain board, M5 interrupt honesty, M9 prompt/view parity | The three mechanisms that make "tireless" structural rather than aspirational. |

---

## Part I — Reused evidence (condensed; full text in the archive)

### I.1 The measured run, in numbers
Run `run-e3eb38e8-…`, `url` target, `event-driven · isolated · maxWorkers 3 · maxDepth 2 · maxTargetOperations 2 ·
totalCommandBudget 600 · maxPlannerRounds 100`, started `08:33:45Z`, finished `09:21:44Z` (**47 m 59 s**).

| Metric | Value |
|---|---|
| Planner rounds / context | 15 of 100; 173,616 of 1,000,000 tokens (**17.36 %**) |
| Command budget used | **192 of 600 (32 %)** |
| Tasks | 13 created · 12 reported · 12 reviewed · **1 blocked** |
| Candidates | 23 → 12 `ruled_out`, 11 `open_proof_gap`, **0 confirmed** |
| Graph | 9 assets, 10 anchors, 9 assertions, **0 relations** |
| Coverage | **0 plans, 0 cells**, 142 `coverage` notes, 78 `open` notes |
| Plan | **1 goal (never revised), 0 todo, 0 decisions** |
| Purposes | **0** `exploitation`, **0** `chaining` |
| Tool calls / refusals | 109 calls, **20 refused (18 %)** |

### I.2 The moment it closed (verbatim, abridged)
`[T 09:17:00]` *"all earlier branches are reviewed and no new target work is warranted … then I close"* ·
`[T 09:21:44]` `FINISH PREFLIGHT (host check, gate warn): 1 blocking code(s), 3 advisory — NO_COVERAGE_PLAN (1),
FOREIGN_EVIDENCE (2), OPEN_GAP_UNREFERENCED (89), ORPHAN_TASK (1)`. The report says the same in its own words:
*"No coverage plan was recorded. Without a denominator nothing can be called covered."*

### I.3 Causes, re-statused against today's tree
| # | Cause | Status now |
|---|---|---|
| B1 | The stop was a judgement, not a limit | **open** — M4/M6 give the judgement a host-checked alternative |
| B2 | No coverage denominator, so "enough" was unmeasurable | **open** — M3 |
| B3 | `NO_COVERAGE_PLAN` is blocking in code but the default gate is `warn` (`src/finish-preflight.ts:52,91`, `src/roles.ts:103`, `extensions/p2o/index.ts:1580`) | **superseded** — the gate is removed entirely (decision 4), so the code becomes a report fact and the run's length must come from M1/M2/M4 instead |
| B4 | Zero todos/decisions; the frontier lived in 78 notes | **open** — M1 |
| B5 | Units were single-request questions; nothing could compose | **open** — M1/M2 (P14 substrate unused) |
| B6 | Rate-limiting converted half the plan to `blocked`; pacing instead of substitution | **open** — M7/M8 (revisit condition, research breaker) |
| B7 | 18 % of tool calls were shape refusals; one real primitive died on `Validation overlap needs a matching predecessor` | **partly fixed** by P15/R1–R7 admission work; **open** — M6 (derived purpose) |
| B8 | The prompt defined "enough" as "queue drained" | **fixed** by P15 (`src/prompts.ts:94` is now conditional); the *host* still does not require anything |
| B9 | Unknown whether more time finds more | unchanged, and unanswerable by construction |

### I.4 What the evidence does not say
It does not say the run needed more time, a bigger budget or more context: all three were under a third used. It does not
show that any of the 11 gaps is exploitable. It says the run had no obligation it could not satisfy by writing prose.

---

## Part II — What ARTEX actually teaches

Read from `my_references/ARTEX` in the design report (`tmp/artex-design-report.md`), not from its docs.

### II.1 The four durability properties
1. **No `finish` verb.** Completion is per-goal: `prove_goal(goal_id, evidence_id, reason)`; the *last* proof ends the
   task (`agent/planner.go:315`, "收官只由逐个 prove_goal 驱动,没有别的'一键完成'手段"). A planner cannot close a task by
   judging its own queue empty.
2. **Units are claimed, not recalled.** `exploration_nodes(kind='intent')` with `open/running/blocked/done`, claimed by an
   optimistic CAS (`db/exploration.go:1173-1181`), ordered `priority DESC, id ASC` (`db/exploration.go:1136-1142`).
3. **A chain can only grow by consuming shown output.** `add_intent` refuses a parent that is not a `fact`/`finding`
   (`agent/tools.go:1032-1090`), so "evidence-driven planning" is a schema property, not a request; a parentless intent is
   auto-anchored to the origin fact.
4. **Interrupt ≠ covered.** Five terminal states where "exhausted" means *tried but not finished*, and the planner is told
   to change angle for it rather than skip the direction (`server/engine.go:1135-1145`).

### II.2 The gap in our tree, with the file that would close it
| Property | p2o today | Missing |
|---|---|---|
| Chain is an object | `chainJoin` computes `ready`/`unmet`/`frontier`/`depth`/`providers` in memory (`src/chain-view.ts:17-43`); the draft is produced on demand by `p2o_graph {action:'chain', plan:true}` (P14.10) | nothing persists a chain across wakes; the plan board has no link to it (`src/planning.ts:15`) |
| Dispatch from the frontier | `situationSegments` renders `chain: N steps ready, M unmet needs` and a `next:` suggestion from `suggestPriority` (`src/situation.ts:97,117`) | it is a *sentence*, not an obligation; a ready step loses to any breadth task the lead prefers |
| Write gate on lineage | exploitation ≥1 claim, chaining ≥2 (`src/tasks.ts:234-235`) | a `p2o_plan` todo needs no lineage at all, so the board cannot hold a chain even when the claim frontier is ready |
| Interrupt honesty | `TASK_TERMINAL_STATES` = `done/exhausted/blocked/stopped` (`src/tasks.ts:44`), where `exhausted` is *derived from the budget hint* (`src/tasks.ts:49-50`) | with budgets gone the state needs a new meaning, and nothing forbids a partial report from marking its cell `tested` |
| Coverage as floor | `COVERAGE_EXECUTION`/`COVERAGE_ASSESSMENT` + `coverageViews` counts (`src/coverage-types.ts:2-3`, `src/coverage.ts:17`) | the measured run used none of it, and the gate defaults to `warn` |
| Truncated views that announce themselves | `omittedCells`, `discoveredUnplannedAssets` exist (`src/coverage.ts:17`); `SEGMENT_FIELDS` drift test exists (`src/situation.ts:102-113`) | other lists (open gaps, frontier) have no paired total |

### II.3 The invariant to adopt
> **An admitted unit must cite the demonstrated output it consumes, and a claim that is ready to advance outranks any
> unit that opens a new surface.**

That single sentence replaces every counter this plan removes. It is host-checkable from the ledger we already write
(`claimRefs`, `providers`, `needs`, `gained`), it is what ARTEX enforces at write time, and it makes "tireless" the
default: as long as a claim is `ready`, there is a *named* next unit — no judgement required and none permitted.

And the corollary, taken literally from ARTEX: **a run is not ended by a call.** It is `complete` when the obligations
that sentence creates are settled, `blocked/human-needed` when progress stops, or `stopped` when a human stops it.
Exporting a report is a reporting action, never a termination verb — which is why there is no gate to tune.

### II.4 Depth outranks breadth, and that constrains the reporting
ARTEX's planner is told: *"深度优先于覆盖度：coverage 是下限/验收项、不是探索目标本身；发现高价值入口后优先把那条路打穿，而不是为拉平覆盖度去铺广"*
(`agent/planner.go:330`), and the worker never sees coverage at all (`agent/worker.go:322`). Consequences for us:

- coverage may **refuse a finish** (no denominator ⇒ nothing is covered) but may **never order dispatch**;
- the depth obligation is expressed in **chains**, not in tested-cells-per-surface (that was D4's weak point and would
  create busywork);
- the worker brief never carries the coverage block. It already does not, and that must be asserted, not assumed.

### II.5 What not to copy
Priority as a model-chosen integer (`agent/tools.go` "优先级 0-10") — we keep the derived `suggestPriority` instead.
Serial chains as a prompt convention (`agent/planner.go:333`) — that is exactly the failure we are fixing. An in-memory
todo store (`agent/planner.go:108`) — our board is the ledger. A prompt key the code stopped emitting
(`agent/planner.go:309`) — M9 exists so we cannot repeat it.

---

## Part III — Reuse map: what is already built and stays

| Primitive | Where | What it gives this plan | Work it still needs |
|---|---|---|---|
| Typed capabilities + `chainJoin` | `src/capabilities.ts`, `src/chain-view.ts:52` | the frontier, `depth`, `uncovered`, `providers`, `environmentRef` — **ARTEX has no equivalent** | M1/M2 consume it instead of rendering it |
| Chain → task draft | `p2o_graph {action:'chain', plan:true}` (P14.10) | one `p2o_plan` todo per step, replay-safe | M1 makes the board the chain's home, not a side effect |
| Payload + environment stores | `src/lab.ts`, `src/compose.ts` | a link that ran is replayable byte-exactly | M5 cites them when a step is carried |
| Severity from demonstration | `src/cvss4.ts`, `src/case-tool.ts` | a finding cannot exceed what the step showed | chain steps must feed it (M2's dispatch cites `max_severity`) |
| Independent replay | `src/evidence.ts`, `src/cases.ts` | second worker proves the first | unchanged |
| Procedure skills (5) + research corpus | `skills/exploit-design` …, `knowledge/techniques/` | the *how* when a link blocks | M8 wires research to a wall |
| `suggestPriority` + situation segments | `src/priority.ts:41`, `src/situation.ts:97` | a derived next-step score, already tested | M2 makes the suggestion binding |
| Coverage cell board | `src/coverage*.ts` | denominator, assessment vocabulary, staleness | M3 gates on it; M5 forbids `tested` from a partial |

---

## Part IV — Build: nine mechanisms

Each is stated as a host rule with its refusal text, its files, and the hermetic test that proves it. No mechanism reads
a spend counter; every one reads ledger state that already exists or is one field away.

### M1 — The chain lives on the plan board
`p2o_plan` todo gains `claimRefs` (1..8), `needs` (typed), `environmentRef`, `chainOf` (a chain id shared by its steps)
and `step` (1..8). `p2o_graph chain plan:true` writes those links instead of a flat todo list, and the plan view renders a
chain as `chain <id> 2/5 · next: step 3 (ready) · waiting on: capability X`. Prerequisite edges are **derived, not
stored twice**: step *n* is ready when every `needs` entry is gained by a confirmed+tested claim cited in step *n−
k*'s `claimRefs` — i.e. `chainJoin` over the board.
*Refusal:* `CHAIN_LINEAGE: a chain step must cite the claim it consumes (claimRefs); a plan row with no lineage cannot
hold a link`.
*Files:* `src/planning.ts` (draft + validation), `src/state/graph-tool.ts` (chain draft writer), `src/situation.ts`
(chain segment reads the board), `src/tool-schemas.ts` (`p2o_plan` params).
*Test:* hermetic — a 3-step draft yields 3 todos with edges; step 2 is `waiting`, step 3 is `waiting`, then closing step 1
with a confirmed claim makes step 2 `ready` in the next view, and step 3 still waiting.

### M2 — Dispatch from the frontier, not from recall
When `chainJoin.frontier` holds a ready path whose `needs` are satisfied by confirmed+tested claims, `p2o_task {action:
'create'}` refuses a **new-surface** task on the same surface unless the draft cites that provider in `work.claimRefs`, or
records a `deferred` todo naming why the link is not being taken.
*Refusal:* `CHAIN_READY_UNDISPATCHED: step <n> of chain <id> consumes <capability> that claim <recordId> already gains;
dispatch it, cite it as a parent, or defer it with a reason`.
*Scope rule:* per surface, not global — breadth elsewhere stays allowed (fixation guard, §VIII).
*Files:* `src/tasks.ts` (`verifyLineage`), `src/chain-view.ts` (expose `frontier[].providers` — already there), plus the
prompt line that tells the lead the refusal exists.
*Test:* a ledger with two confirmed primitives + one ready chaining claim refuses a mapping task on that surface and
accepts it once the draft cites the provider or the deferral todo exists.

### M3 — Completion is derived; exporting a report is not termination
Three states, all host-computed, none of them a call:
- **`complete`** — every goal is `reviewed`/`closed` with same-run support (`src/planning.ts:101`), no confirmed+tested
  primitive is unchained (M4), and no chain step is ready (M1/M2).
- **`blocked/human-needed`** — M6 escalated, or an obligation needs a decision only a human can take (widen scope,
  supply a credential, change the environment).
- **`stopped`** — a human stopped the run; the report lists every unmet obligation.

The preflight codes stay, but as **report facts**, not as a refusal predicate: `BLOCKING`
(`src/finish-preflight.ts:52`) becomes `OPEN_OBLIGATION` and is rendered under `REMAINING WORK` in `REPORT.md`. Nothing
refuses, nothing is refused once and passed on the second call. Delete the setting itself: `FinishGate` /
`DEFAULT_FINISH_GATE` (`src/roles.ts:103`), `settings.finishGate` (`src/roles.ts:131,152`), the `gate === 'confirm'` branch
plus `finishRefused`'s signature (`extensions/p2o/index.ts:1580`).

`p2o_finish` splits into two verbs with different authority:
- `p2o_finish {export}` — reconciliation + `REPORT.md` / `coverage.csv` / `findings.csv`. Allowed at any time, refuses
  nothing, **ends nothing**; it writes the current obligation list and leaves the run as it was.
- `p2o stop` — cleanup, worker teardown, `run.stopped`, and the unresolved list. Human-only (see §VII 6).

Coverage's role is the second half of this mechanism: `coverageViews` counts (`src/coverage.ts:17`) supply the backlog pair
in the situation line — `coverage <tested>/<cells> (planned <n> unreached, <m> omitted)` — and the report's denominator, so
"not shown" is never read as "not planned" (ARTEX `agent/tools.go:436-440`). A goal that wants a coverage floor states it
in its own bounded `criteria`; its settlement then checks that criterion against cells. Nothing else reads coverage on an
enforcement path.
*Files:* `src/roles.ts`, `extensions/p2o/index.ts`, `src/finish-preflight.ts`, `src/report-export.ts`, `src/situation.ts`.
*Test:* exporting a report on a ledger holding one unchained primitive writes the files and leaves the run `incomplete`
with `remaining: 1 obligation`; the same ledger reaches `complete` only after the obligation is settled; `p2o stop` on the
same ledger records `stopped` plus the obligation.

### M4 — Every demonstrated primitive is taken further or walled
Two state conditions, both host-computed. They do **not** refuse a finish (there is no gate); they are what keeps
`complete` false and what M2 enforces at dispatch:
- `GOAL_UNSETTLED` — a goal is `active` and has no revision citing same-run support (`src/planning.ts:101` already
  requires support refs for `reviewed`/`closed`, so the condition only asks the question).
- `PRIMITIVE_UNCHAINED` — **every** claim that is `confirmed` + `tested` has **neither** a successor step in a chain **nor**
  a recorded ruled-out successor naming what was tried. This is the depth obligation in chain terms: each demonstrated
  primitive is either taken further or walled with evidence. Owner decision: applies to every such claim, not only those
  with an accepted case.
*Refusal* (from M2's dispatch path, not from a finish): `PRIMITIVE_UNCHAINED: claim <recordId> (<capability>) is confirmed
and tested on <surface> and nothing consumes it; take the next step or record which successors were ruled out and why`.
*Test:* one confirmed primitive with no successor ⇒ listed as remaining work and refuses breadth on its surface; with a
`deferred` todo naming the ruled-out successor ⇒ cleared; with a ready chain step dispatched ⇒ cleared.

### M5 — Interrupt honesty
- `exhausted` is re-defined: only `status === 'expired'` (lease expiry, `src/tasks.ts:46`) maps to it; the
  `budgetExhausted` hint and the blocked/cancelled remapping go (`src/tasks.ts:41,49-50`).
- A task that ends without a verdict (`blocked`, `stopped`, `expired`) may **not** drive its coverage cell past
  `attempted`; the cell's assessment stays `open_gap`/`unreviewed` and its execution goes back to `planned` with a
  `revisitCondition`, so the work is re-dispatchable rather than consumed.
- The report gains a `carried` column: a link that was demonstrated but not taken forward, with the reason and the payload
  reference when one exists.
*Refusal:* `INTERRUPT_NOT_EVIDENCE: task <id> ended as <state> without a verdict; cell <questionKey> stays attempted, not
tested`.
*Test:* a `blocked` report on a `running` cell leaves `execution='attempted'`, `assessment='open_gap'`, and the same cell
appears in the backlog query.

### M6 — No-progress escalation, and the admission tax
- A round is **quiet** when it added no tested cell, no candidate closure, no asset and no chain depth. Two consecutive
  quiet rounds stop automatic wakes and report `blocked/human-needed` with both round ids (`src/engine.ts:109,147` are the
  sites that currently pause on `maxRounds`).
- Refusals become `lifecycle` records counted by a new advisory `ADMISSION_REFUSALS` preflight code, so the 18 % tax is
  visible in the report instead of invisible in the transcript.
- `p2o_task create` fills `work.purpose` from the role when the draft omits it (removes one prompt obligation, B7).
*Test:* a loop fixture with two quiet rounds stops with both ids named and no budget word in the message; a refusal is
counted once.

### M7 — Condition-bounded revisit (not an allowance)
`p2o_loop {action:'wait', reason:'block-decay'|'cooldown-expiry', notBefore}` schedules **one** revisit tied to a stated
condition and records it as a `decision` on the plan board. It is not counted against anything, it cannot re-arm itself,
and it is refused if the same condition already has a pending revisit.
*Refusal:* `REVISIT_DUPLICATE: condition <reason> already has a pending revisit at <time>`.
*Test:* one wait writes one decision and one scheduled wake; a second identical wait is refused; expiry of the condition
wakes **once**; nothing fires when the run is paused or held.

### M8 — Continuation and the research breaker
- `p2o_workers {action:'continue', workerId, brief}` re-uses the worker's conversation for the same ticket (default once),
  which is what makes "retry the blocked hypothesis differently" cheap (D6 unchanged).
- When a chain link blocks, the lead is told to run `p2o_research` with the *transition* it needs (`needs X → gained Y`)
  and the procedure skill that owns that transition; the corpus is already indexed and fetched through the curated channel
  (`src/research.ts`, P14.8). The measured run used it once, for nothing.
*Test:* `continue` after a report is refused (`WORKER_CLOSED`) unless the ticket is still live; a blocked-link fixture
renders the research hint with the two capability kinds named.

### M9 — Prompt/view parity, extended
`SEGMENT_FIELDS` (`src/situation.ts:102`) already walks the drift. Extend it: every prompt line that names a field must
resolve to a key in the view struct, and every truncated list must ship its total. This is the ARTEX bug
(`agent/planner.go:309` promises `sites_without_endpoints`, never emitted) turned into a test.
*Test:* the existing drift test plus a new assertion that each `situation`/plan-view key named in `src/prompts.ts` exists.

---

## Part V — Deletions that unblock all of the above

Budget semantics must go **first**, because M4/M5/M6 read state that currently means "allowance".

| Symbol / site | Line | Action |
|---|---|---|
| `DEFAULT_WORKER_COMMAND_BUDGET`, `EXPLOITATION_COMMAND_BUDGET`, `commandBudgetFor`, `budgetWrapUpRequired` | `src/broker.ts:24,30,31,37` | delete |
| `WorkerRegistration.commandBudget`, `.used`; status RPC `used`/`budget`; report gate on `wrapUp`; exhaustion path | `src/broker.ts:65,371,497,540-542` | delete (op classification stays) |
| `Ticket.commandBudget` + validation | `src/ticket.ts:37,114` | delete; **read old tickets leniently** |
| `totalCommandBudget` option, `totalBudget ?? 600`, `workerUsed/workerCeiling`, `budgetExhausted()`, 90 % reserve, `commandsUsed/commandBudget`, `budgets` view, `p2o_workers` `N/M cmds`, `workerBudget` fact | `extensions/p2o/index.ts:12,162,213,320,399,537,583,589,703,715,1528,1813,1972,2052` | delete; the dialog and manifest lose the allowance sentence |
| `budgetExhausted` hint and remapping | `src/tasks.ts:41,49-50,56`; `src/situation.ts:50` | drop the hint; `exhausted` = expired only |
| `Duty.wrapUp` + `Before you stop:` + `reportParameters.wrapUp` | `src/duties.ts:18,56,62,92`; `src/tool-schemas.ts:170` | delete |
| prompts: `worker command allowance with 90 % admission reserve`, `exhausted (the allowance ran out first…)`, `LIMITS: N brokered commands` | `src/prompts.ts:81,95,136` | reword to state and condition, never a number |
| `WorkSpec.budget`, `WorkerView.commandBudget` | `src/work.ts`, `src/ui/state.ts` | delete |
| `LEAD_CEILINGS`, `DECLARATION_BUDGET`, and the size assertions that import them | `tests/minimal/helpers/budgets.ts`, `recon.test.ts`, `measure-context.test.ts`, `workflow-policy.test.ts`, `duties.test.ts` | delete the file and the imports; `scripts/measure-context.mjs` stays as a **reporting** tool that gates nothing |
| `FinishGate` type, `DEFAULT_FINISH_GATE = 'warn'`, `settings.finishGate` parse/validate, `gate === 'confirm'` branch, `finishRefused` signature, the dialog sentence that names the gate | `src/roles.ts:103,131,152`; `extensions/p2o/index.ts:1580` and the start dialog | delete the setting; `p2o_finish` becomes export-only, `p2o stop` takes the cleanup path |
| budget test suite | `tests/minimal/budget-class.test.ts` and the budget cases in `broker/terminal-state/extension/ticket/duties/situation` tests | delete/trim; add "201 operations never refused" and "an old ticket with `commandBudget` still authenticates" |

Docs to restate, not renumber: `docs/ARCHITECTURE.md`, `docs/WORK_ADMISSION.md`, `docs/PLANNER_ENGINE.md`,
`docs/USAGE.md`, `README.md`, `docs/SKILL_RUNTIME.md`.

---

## Part VI — Roadmap with acceptance criteria

Every phase keeps `npm run typecheck`, `npm run build`, `npx vitest run tests/minimal/`,
`python3 scripts/validate_library.py` and the pytest baseline (116 passed, 1 pre-existing R1 provenance failure —
`b4d7a8ce…` vs `3e729859…`) green, and adds at least one **hermetic** test (no paid model, no target, no network).

| Phase | Content | Hermetic acceptance |
|---|---|---|
| **A** | Part V deletions: budgets out, `exhausted` = expired, prompts say state not numbers, context pins out | 201 operations never refused; no result or report text contains `allowance`; an old ticket still authenticates; nothing imports `helpers/budgets.ts` |
| **B** | M5 + M9: interrupt honesty, parity | a `blocked` report leaves its cell `attempted`/`open_gap` and re-appears in the backlog; parity test fails on a prompt field the view does not emit |
| **C** | M1: chain board with derived edges | 3-step draft ⇒ edges; closing step 1 makes step 2 ready in the next view; a lineage-free plan row is refused |
| **D** | M2 + M4: frontier obligation, settlement conditions | ready chain step refuses a breadth task on that surface, accepts it when cited or deferred; one unchained primitive is listed as remaining work and refuses breadth on its surface, clears when walled |
| **E** | M3: derived completion, report/stop split, backlog pair | export on a ledger with one unchained primitive writes files and leaves the run `incomplete` with `remaining: 1`; `complete` only after it settles; `p2o stop` records the obligation; situation renders `tested/cells (planned n unreached)`; no `finishGate` symbol remains |
| **F** | M6 + M7 + M8: quiet-round escalation, revisit condition, continuation, research breaker | two quiet rounds stop with both ids and no budget word; duplicate revisit refused; `continue` after report refused; blocked link renders the research hint |

Order rationale: **A is a deletion** (no dependency, removes the vocabulary everything else would have to lie about); B
makes state mean what C–F read; C and D are the chain obligation itself (the thesis); E is the floor that stops a drained
queue from closing a run; F is the fuel when a link is walled.

### Phase A — done (2026-10-24)

Landed in one pass, purely subtractive except for report wording:

- **Spend caps gone.** `src/broker.ts` lost `WORKER_BUDGET_RESERVE`, `DEFAULT_WORKER_COMMAND_BUDGET`,
  `EXPLOITATION_COMMAND_BUDGET`, `commandBudgetFor`, `WRAP_UP_PURPOSES`, `budgetWrapUpRequired`, the per-worker
  `READ_CALLS`/`COORDINATION_CALLS` splits and `charge()`, `BrokerDeps.onBudget`, `BrokerLimits.totalCommandBudget`,
  `registration.commandBudget`, the report gate on `wrapUp`, the reserve path in `spend()`, and `'partial-budget'` from
  `WORKER_OUTCOMES`; `spend()` now only counts. `src/ticket.ts` lost the field and its validation (an old ticket with the
  extra key still reads: unknown keys are carried, not rejected). The extension lost `totalCommandBudget`, the 90 % reserve
  refusal (`COMMAND_BUDGET`), the `commandBudgetFor` wiring, `budgets` in the workers view, `workerUsed/workerCeiling`, and
  the owner's own `OWNER_KNOWLEDGE_BUDGET`/`chargeKnowledge`/`chargedKnowledge` allowance.
- **Wrap-up obligation gone.** `Duty.wrapUp`, the `Before you stop:` tail, `reportParameters.wrapUp`, and `WorkSpec.budget`
  (+ its schema) are deleted; `dutyLine()` is one sentence again.
- **`exhausted` re-defined.** `terminalState(task)` takes no hint: `expired` → `exhausted`, `blocked` → `blocked`,
  `cancelled` → `stopped`. The `budgetExhausted` input and the disjointness rule left `summarizeSituation`.
- **No finish gate.** `FinishGate`, `DEFAULT_FINISH_GATE`, `settings.finishGate`, `finishRefused` and the `confirm` branch
  are deleted; `renderPreflight(result)` takes no gate and always appends its block, headed `FINISH PREFLIGHT (host check)`.
  The structural `BLOCKING` set stays for Phase E, where it becomes `OPEN_OBLIGATION` in the report.
- **Context pins gone.** `tests/minimal/helpers/budgets.ts` deleted with every `LEAD_CEILINGS`/`DECLARATION_BUDGET` import and
  assertion; `budget-class.test.ts` deleted; size comments removed from `recon`/`measure-context`/`workflow-policy`/`duties`.
  `scripts/measure-context.mjs` stays as a reporting tool that gates nothing.
- **Regression tests pin the absence**, not the old numbers: 201 admitted commands on one worker and 300 on another, 200
  knowledge reads plus 200 notes, a report accepted with no `wrapUp`, a ticket with no `commandBudget`, and a stale settings
  file still carrying `finishGate: 'confirm'` changing nothing.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **733 passed,
12 skipped (745)** · `python3 scripts/validate_library.py` PASS · pytest 116 passed with only the pre-existing R1 provenance
mismatch. `detect-changes --scope all`: 47 files, 243 symbols, 179 processes, risk **critical** — expected for a
cross-cutting deletion; `impact budgetWrapUpRequired` reported **HIGH** (it sat on every exec path) and `terminalState` LOW.

### Phase B — done (2026-10-24)

M5 and M9 are structural now, not advice.

- **M5, writer side.** `src/coverage.ts` gained `INTERRUPTED_TASK_STATES`, `interruptedCellTasks(index, cell)` and
  `interruptedVerdict(index, cell)`; `addCell`/`reviseCell` refuse a cell that asserts a verdict (`execution: 'tested'`
  or an assessment in `VERDICT_ASSESSMENTS`) while a task it cites ended `blocked`/`stopped`/`exhausted`, with the pinned
  revision (a later satisfied revision cannot launder it):
  `INTERRUPT_NOT_EVIDENCE: task <id> ended as blocked without a verdict; cell question:object-access stays attempted, not tested`.
  `isTestedCell` now reads `effectiveExecution ?? execution`, so "tested" has one definition for views, situation and preflight.
- **M5, view side.** `effectiveExecutionOf` downgrades stored `tested` → `attempted` when the cited task was interrupted, the
  assessment falls back to `open_gap`, the cell is `stale` with `interrupted-task:<id>:<state>`, `reviewed` is false, the
  counts loop uses `effectiveExecution`, and `finishPreflight` names it under a new advisory `INTERRUPTED_CELL` (checked
  before generic `STALE_CELL`, because re-dispatch is a different repair than re-pinning evidence). A cell that ended
  interrupted therefore re-appears in the backlog instead of being consumed by a verdict nobody reached.
- **M9, parity as a test.** `tests/minimal/situation-parity.test.ts` (4 assertions) closes the ARTEX drift class from three
  sides: every `SEGMENT_FIELDS` key is emitted by some state, no segment renders a field `summarizeSituation` does not
  populate and nothing undeclared is emitted, a quiet/open frontier says exactly one sentence, and the lead prompt prints
  exactly `situationLine(snapshot)` once (no second count of its own).

Deviations, recorded: the cell stays `attempted` rather than returning to `planned` — `planned` would claim nothing was
tried, which is less honest than "an attempt exists, the direction is open". `planned` remains the state for a cell nothing
ran against. The report's `carried` column is deferred to Phase E, where the report becomes a projection of the ledger; adding
a column twice would be wasted work, and the backlog plus `INTERRUPTED_CELL` already carry the information.

Measured: `npm run typecheck` clean · `npx vitest run tests/minimal/` **739 passed, 12 skipped (751, 89 files)** ·
`python3 scripts/validate_library.py` PASS. `npx vitest run tests/minimal/claims.test.ts` caught a real regression during the
pass: my first view downgrade wrote a raw `execution === 'tested'` literal into `src/coverage.ts`, which the P13b one-owner test
forbids; the fix routes it through `isTestedCell`.

### Phase C — done (2026-10-24)

- **The board holds the link.** `PlanDraft`/`PlanEntry` (`src/planning.ts`) gained `claimRefs` (1..8), `needs` (typed,
  1..8), `environmentRef`, `chainOf`, `step` (1..8); `p2o_plan`'s schema and projection carry them. Validation refuses a
  chain row with no lineage (`CHAIN_LINEAGE: a chain step must cite the claim it consumes (claimRefs); a plan row with no
  lineage cannot hold a link`), a half-declared position (`A chain step needs both chainOf and step`), a link on a goal, a
  claim reference that is not a same-run candidate record, and a second row at the same position
  (`Duplicate chain step <n> in <chain>`).
- **The edge is derived, one rule.** New `src/chain-board.ts`: `chainBoard(plans, claims)` groups todos by `chainOf`, and a
  step is `ready` when every `needs` entry is gained by a `confirmed`+`tested` claim cited in an *earlier* step's
  `claimRefs` (same `capabilityMatches` as the graph join, same `isDemonstrated` as every other provider check). A step with
  no needs is ready; `done`/`blocked`/`deferred`/`cancelled` stay as the lead left them. Each step carries `waitingOn` and
  `satisfiedBy` (need key → the earlier record id), and each chain renders one sentence:
  `chain <id> 1/3 · next: step 2 (ready) · waiting on: http.request (internal-api)`.
- **Writer.** `p2o_graph {action:"chain", plan:true}` writes one linked todo per step (demonstrated steps `done`, the ready
  step `open`, deterministic `chainOf = chain-<sha12(requestId)>` for replay) and returns `chainOf`; if any path claim has no
  same-run record it falls back to flat todos rather than writing a row the validator would refuse halfway through.
- **One number per question.** `p2o_plan list` adds `chains: string[]`; `situation` gained `chainSteps`,
  `chainReadySteps`, `chainWaitingSteps` fed from the same board, and the `chain` segment prefers the board and falls back to
  the candidate-level join only when no step is planned. `SEGMENT_FIELDS.chain` now names all five fields.

Deviations, recorded: a demonstrated step is written `done` at creation — the work it names is already recorded, and leaving
it `open` would make the board report step 1 as next forever. Readiness deliberately allows any earlier step rather than only
`n−1`, as M1 specifies (`n−k`). Two rows at one position are refused at write time; the reader does not try to arbitrate.

Measured: `npm run typecheck` clean · `npx vitest run tests/minimal/` **748 passed, 12 skipped (760, 90 files)** ·
`python3 scripts/validate_library.py` PASS. New tests: `tests/minimal/chain-board.test.ts` (9 — readiness, any-earlier
provider, settled states, plan lines, situation segment, refusal set, the acceptance flow "closing step 1 makes step 2 ready
and leaves step 3 waiting", duplicate position) and `chain-plan.test.ts` updated for linked writer output.

### Phase D — done (2026-10-24)

- **One reader for claims.** `claimHeadClaims(index, runId?)` moved into `src/chain-view.ts`; the extension's private
  `candidateClaims` and the new obligation module both call it, so the situation counts, the graph view, the plan board and
  the dispatch obligation cannot drift about what a claim is or where it lives.
- **Two derived conditions, no new record kind.** New `src/obligations.ts`: `chainObligations({plans, claims, tasks})` returns
  `ready` (a chain step whose need is already gained by a demonstrated provider, with that provider named) and `unchained`
  (every `confirmed`+`tested` claim with no successor chain row consuming what it gains, no live task standing on it, and no
  `deferred`/`blocked` row naming it). A cancelled/expired/closed task does not consume: a dead attempt must not clear the debt.
- **M2 at create.** `TaskBoard.create` refuses a draft on a surface with a ready step unless it cites the provider
  (`work.claimRefs`) or a plan row records the deferral:
  `CHAIN_READY_UNDISPATCHED: step <n> of chain <id> consumes <capability> that claim <recordId> already gains; dispatch it, cite it as a parent, or defer it with a reason`.
  **M4 at create**, when nothing is ready but a primitive is unconsumed:
  `PRIMITIVE_UNCHAINED: claim <recordId> (<capability>) is confirmed and tested on <surface> and nothing consumes it; take the next step or record which successors were ruled out and why`.
  Both are per surface (`sameSurface`, trimmed/case-insensitive), so breadth elsewhere is still admitted; revise and dispatch
  are untouched; nothing refuses a finish.
- **Listed as remaining work.** `finishPreflight` gained the advisory `PRIMITIVE_UNCHAINED` fed by the same function, so the
  report and Phase E's `complete` read one list rather than two stories.
- **The prompt says the exit, not just the rule.** `src/prompts.ts` gained one line: a ready step or demonstrated primitive
  owns its surface, so a new task there cites the claim it stands on or the plan records the deferral.

Deviations, recorded: the deferral is a structured row (`deferred`/`blocked` + `claimRefs` naming the claim) rather than a
free-text note, because a text match is a rule nobody can audit; deferring the step row itself also clears M2, since the board
then no longer reports it ready. `PRIMITIVE_UNCHAINED` is advisory in the preflight (there is no gate); Phase E is where it
decides `complete`.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **753 passed,
12 skipped (765, 91 files)** · `validate_library.py` PASS. New `tests/minimal/obligations.test.ts` (5: M2 refusal and both
exits, scope rule, M4 listing with successor/wall/live-task clearing and a cancelled task not clearing, plus the integration
flow through `p2o_task create`). One existing test changed because the new rule bites:
`finish-preflight.test.ts`'s "clean block" now asserts `0 blocking, 1 advisory` + `PRIMITIVE_UNCHAINED (1)` — the fixture's
demonstrated claim has no successor, and that is the condition working.

### Phase E — done (2026-10-24)

- **Completion is derived.** New `src/completion.ts`: `deriveCompletion({plans, claims, tasks})` is `complete` only when no goal
  is outside `reviewed`/`closed`, no `confirmed`+`tested` claim is unconsumed, and no chain step is ready — a step a live task
  is already taking is not owed (`chainObligations.ready` now excludes it). `remaining` is one number, each item names its
  code (`GOAL_UNSETTLED` / `PRIMITIVE_UNCHAINED` / `CHAIN_READY`) and ids, and `completionLine` is the sentence the result,
  the report and the stop outcome all print.
- **Export is not termination.** `p2o_finish {export:true}` skips every refusal (no `INTENTS_QUEUED`, no `WORKERS_ACTIVE`),
  reconciles, writes `REPORT.md`/CSV to a fresh directory (`-export-N` when the default exists), returns `state` + `remaining`
  + the preflight block, and ends nothing: workers, sandboxes and the run stay exactly as they were. The call without `export`
  keeps the final path and now also reports the completion state. `p2o stop` records what the run owes: `finalize` gained an
  optional `note`, so the single `run.stopped` record carries `remaining: incomplete: N obligation(s) — …` instead of only
  "resources cleaned; assessment cancelled".
- **Preflight is a report fact.** `BLOCKING` → `OPEN_OBLIGATION`, `FinishPreflight.blocking` → `.obligations`, level
  `'blocking'` → `'obligation'`. `REPORT.md` renders `## REMAINING WORK` (completion line + obligation table + the preflight
  table at export or stop) instead of "Unresolved when the lead finished". Nothing refuses a finish and nothing refuses an
  export.
- **Backlog pair.** The situation coverage segment is `coverage <tested>/<cells> (planned <n> unreached, <m> omitted)` from
  `counts`/`omittedCells`, with the pair dropped when both are zero, so "not shown" never reads as "not planned".
- **Gate symbols stay dead.** A source scan over `src/` and `extensions/` fails if `FinishGate`, `DEFAULT_FINISH_GATE` or
  `finishGate` reappears.

Deviations, recorded: `p2o_finish` without `export` still ends the run (the human's terminal report), because removing the
only end-call would leave `/p2o stop` as the sole exit and break the "final assistant response" contract; the M3 split is
implemented where it matters — the **export** verb has no authority and no refusal. `GOAL_UNSETTLED` is "not reviewed/closed"
rather than "active without support", which is stricter and matches M3's `complete` definition.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **760 passed,
12 skipped (772, 92 files)** · `validate_library.py` PASS. New `tests/minimal/completion.test.ts` (7). Two older tests moved
with the rename (`finish-preflight.test.ts`, `docs/ACCEPTANCE_MATRIX.md`), the `p2o_finish` guideline stayed inside its 1400-byte
ceiling by folding the export fact into one line instead of two, and one regression was mine: a second
`run.stopped` event in the stop path pushed the read-only banner off the first screen of `/p2o reconcile`; the fix is to keep
the single `finalize` record and carry the note there.

Two deliberate deviations, recorded rather than hidden:

1. **The Planner's automatic-round count survives Phase A.** It is a spend cap (`maxPlannerRounds`, default 100) but also the
   loop's only automatic brake; M6's quiet-round guard replaces it in Phase F. Removing it now would leave a run that cannot
   stop on its own at all.
2. **Counters stay, ceilings go.** `registration.used`, `workerUsed` in the state view and `12 cmds` in the worker panel are
   kept as observations (the report counts operations from events anyway); every comparison against a maximum is gone.

### Phase F — done (2026-10-24)

- **Quiet rounds (M6).** `src/engine.ts` keeps a `RoundProgress` of four monotone counters (`testedCells`, `closures` — only
  `confirmed`, `assets`, `chainDepth`). A round is quiet when all four are unchanged; `QUIET_ROUNDS = 2` consecutive quiet
  rounds stop `reserveWake()` and `escalated()` names *both* round ids with the human decision (widen the scope, supply a
  credential, change the environment). One counter moving clears the streak; `manual` mode never judges, because it has no
  automatic round to judge. The counters are computed in one `readLedger` pass at the acknowledgement barrier
  (`roundProgress` in `extensions/p2o/index.ts`, passed to `engine.consume`), and they reuse the same predicates as the plan
  board (`isDemonstrated`, `isTestedCell`), so the report, the frontier and the streak cannot disagree.
- **Purpose filled, not demanded.** `TaskBoard.canonical` fills `work.purpose` from `purposeFromRole(role)`; `create`,
  `revise` and `match` canonicalize before `validate`. A draft that omits the field is accepted with the role's purpose
  instead of failing the admission check.
- **The admission tax is a record (M6).** A refused `create` writes `admission refused: <CODE>: …` as a `lifecycle` note
  before rethrowing; preflight reports the count as advisory `ADMISSION_REFUSALS`. This is an observation, not a limit: the
  next create is judged on the same frontier, not on how many before it failed.
- **One condition-bound revisit (M7).** `p2o_loop {action:'wait', reason:'block-decay'|'cooldown-expiry', notBefore}` writes
  one `decision` (`disposition:'defer'` + `revisitCondition`) and schedules exactly one wake; `REVISIT_DUPLICATE` refuses a
  second pending revisit for the same condition, `notBefore` must be in the future and within 24 hours, and nothing re-arms
  itself. `AssessmentEngine` keeps the schedule (`revisitAt`, `scheduleRevisit`, `fireRevisit`), fires once, stays silent while
  paused or stopped, and clears on `stop()`. `src/planning.ts` now accepts a decision whose only content is a
  `revisitCondition`.
- **Cheap retry and the research breaker (M8).** `p2o_workers {action:'continue', workerId, brief}` reuses the worker's own
  conversation for the same ticket; `continuationRefusal` is the single rule (`WORKER_CLOSED` for reported/stopped/pane
  closed, `CONTINUATION_LIMIT` after one continuation per ticket) and records a lifecycle note. A blocked chain link now
  arrives with up to three `research` hints from `p2o_graph {action:'chain'}`: the `needs → gained` pair, a query built from
  exactly those two capability kinds, and the procedure skill that owns the transition (`TRANSITION_SKILLS` in
  `src/research.ts`). A hint states the transition, never a topic.

Deviations, recorded: (1) a round is judged at `consume`, not on a timer — the engine has no clock of its own, and a
timer-based streak would fire on a run that is simply idle between messages; (2) `p2o_loop wait` schedules the wake without
consulting `event-driven` mode (that is the point: nothing will arrive to wake the lead) but still refuses while paused or
stopped; (3) the duplicate check reads the engine's pending map rather than the decision rows — a plan row can be revised
away, and the condition's pending wake is the fact that matters; (4) a continuation cap is a per-ticket count, not a budget:
nothing is subtracted from a total and no command is refused because of it.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **769 passed,
12 skipped (781, 93 files)** · `validate_library.py` PASS · pytest 116 passed, 1 skipped (only the pre-existing R1
provenance failure). New `tests/minimal/phase-f.test.ts` (11) plus two tool-path tests for the revisit and continuation
wiring (`REVISIT_DUPLICATE` after one wait; `WORKER_UNKNOWN` for an unregistered continue).

### Phase G — no count cap remains (2026-10-24)

The owner's rule, after the research tool refused an eight-word question: **đếm số mục là biên giả; biên thật là byte**.
A cap on how many steps, findings, receipts, headers or continuations an agent may have is a guess about the work; a byte
bound is a fact about the record. Every count cap on tool input was removed rather than raised.

- **Laboratory** (`src/lab.ts`, `src/compose.ts`): `ENVIRONMENT_STEPS` (8) is gone; setup/seed/services are lists of any
  length, each command still bounded at 4 KiB and each service still validated. A compose file no longer loses services to a
  count.
- **Claims and capabilities** (`src/evidence.ts`, `src/capabilities.ts`): `evidenceRefs`, `negativeControls`, `resolves`,
  `gained`, `needs` are lists with no length limit; `capabilityList` keeps its duplicate/identity rules. `validateWorkSpec`
  and the plan board accept any number of `claimRefs`/`assetRefs`/`needs` (min 1).
- **Reports** (`src/broker.ts`): findings/evidence/openItems/coverage are bounded by **256 KiB of bytes per list**, not by
  20/40 items. `stringList` keeps its count form for internal projections; the report path uses `reportList`.
- **Plan and tasks** (`src/planning.ts`, `src/tasks.ts`, `src/work-tool.ts`): no live-frontier 100, no `step ≤ 8`, no
  `claimRefs ≤ 8`, no `ids ≤ 25`, no `evidenceIds/unknowns/prerequisites ≤ 10`, no `skills ≤ 3`.
- **Engine and workers** (`src/engine.ts`, `src/broker.ts`): `maxPlannerRounds` is deleted (settings, engine argument, status
  profile, docs); M6 is the only automatic stop. `CONTINUATIONS_PER_WORKER` is deleted — a live ticket can be continued as
  often as it is useful, and only `WORKER_CLOSED` refuses. The pending-intent cap (100) and the revisit cap (8) are gone; the
  24-hour `notBefore` horizon stays because it bounds a timer, not a workload.
- **Prompt** (`src/prompts.ts`): "dispatch at most four intents per call" became "dispatch the highest-value intents first; a
  slot opens as one settles, so a longer batch simply waits its turn and nothing is dropped".

Kept deliberately: per-item byte/length bounds (4 KiB command, 8 KiB header block, 32 KiB payload/body, 200-char query),
page sizes (`p2o_ledger` 100, graph 20/200, `p2o_state` `q` 2..80), storage quota, and the authority caps (`--workers`,
`maxTargetOperations`, redirects inside the origin). Case and coverage record shapes keep their structural limits (1..8
chain steps, 1..10 asset refs) because they describe one retained record, not an agent's input.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **775 passed,
12 skipped (787, 93 files)**. Tests updated where the old cap *was* the assertion (`capabilities`, `lab`, `lineage`,
`phase-f`, `dispatch-discipline`, `engine`, `broker`) and two new ones hold the line: a 25-finding report keeps all 25 and a
report list stops only at its byte budget.

---

### Phase G (ARTEX plan) — done: goals that have to be proved (2026-10-24)

The goals-proof work of Part IX, not the count-cap block above (the letters are reused; §IX.4 has the acceptance).

- **`proof` on the plan row (P16.1).** `p2o_plan create` refuses a goal without one: `GOAL_UNPROVEN: a goal needs proof
  (capability, case or coverage); name what would settle it`. The field is `{kind, capability?, ref?}` and the parser is
  `exact`, so a typo is a refusal rather than a silently ignored field. A non-goal may not carry it.
- **One resolver, two callers.** `src/goal-proof.ts` `goalProofRefusal(proof, data)` — capability needs a `confirmed`+`tested`
  claim whose `gained` matches under the single capability rule; case needs `accepted` + `confirmed` + `current`; coverage
  needs a same-run plan whose non-retired cells are all `tested`/`blocked`/`not_applicable`. `proofData(index)` reads the
  same three sources for the plan board; `proofViews(cases, coverage)` lets the report and finish paths pass their own
  context-aware views instead of default ones that cannot tell freshness. `revise` to `reviewed`/`closed` requires the
  supportRefs **and** a proof that holds.
- **Completion cannot be fooled by status.** `deriveCompletion` gains `GOAL_UNPROVEN` and reads `cases`/`coverage`; a goal is
  settled only when the status says so *and* the proof still holds. A reviewed row whose case was later disputed, whose
  coverage plan was re-opened, or that predates the field is owed work again. The three call sites
  (`src/report-export.ts`, `extensions/p2o/index.ts` finish and export paths) pass real views.
- **The report prints it.** `## REMAINING WORK` carries `| Goal | Status | Proof | Settled |`, with `no — GOAL_UNPROVEN: …`
  when the proof does not hold, so a reader can separate a status from a demonstration.
- Owner decisions recorded in §IX.5 are requirements; this phase only implements decision 2 (`coverage` is legal for a
  mapping goal, never for a reachability claim).

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **774 passed,
12 skipped (788, 93 files)** with only the pre-existing `planner-native` harness flake under parallel load (3/3 in
isolation) · `validate_library.py` PASS · pytest 116 passed, 1 skipped (only the pre-existing R1 provenance failure). New
cases: create refused without proof; review refused while the proof does not hold; `GOAL_UNPROVEN` for a legacy settled row;
a case proof settles; a coverage proof settles; the report prints the proof.

### Phase H (ARTEX plan) — done: frontier floor and continue (2026-10-24)

- **The frontier floor replaces the stall pause (P16.2).** `RoundProgress` now carries `remaining` and `demand`, computed by
  the owner from the *same* `deriveCompletion` the finish result prints; `completionDemand` names the obligation
  (`step 2 of chain login ready and undispatched; 1 goal(s) not reviewed or closed`). Two quiet rounds with
  `remaining > 0` produce a **demand wake** that carries that text (`PlannerWake.demand`, shown in the wake message and in
  the `planner.admitted` event) and the engine stays live. Two quiet rounds with `remaining === 0` pause with a sentence
  naming both rounds and saying the completion is complete; a lead-recorded `blocked` pauses as before. `manual` mode still
  judges nothing.
- **Continue from the trace (P16.7).** The terminal-state guidance no longer says "retry the direction differently": an
  `exhausted` task's progress is in the ledger and its conversation is resumable — continue it on the same ticket with a
  brief that starts where it stopped, or dispatch a new task with a different mechanism (the lead prompt keeps its
  no-tool-name vocabulary; the verb lives in the tool). `p2o_workers list` gains `lastWrite` (last evidence, fact/note or
  graph provenance row authored by that worker) and per-worker `commands`, `lastFact`, `lastEvidence`, `lastOperation`,
  and `continueHint` for an `expired` lease; the text line prints `last write: <kind> <id>` and the expired hint.
- Owner decision 5 (§IX.5) is what the engine now implements: pause on `complete` and on a recorded `blocked/human-needed`,
  keep waking while an obligation remains.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **780 passed,
12 skipped (793, 94 files)**, with only the pre-existing `planner-native` harness flake under parallel load (3/3 in
isolation) · `validate_library.py` PASS · pytest 116 passed, 1 skipped (only the pre-existing R1 provenance failure). New
`tests/minimal/phase-h.test.ts` (5): demand wake names the step and does not pause; count fallback; recorded blocked pauses;
`completionDemand` names step and goal; the prompt names continue and keeps its vocabulary. `worker.test.ts` asserts
`lastWrite` from a real candidate record.

### Phase I (ARTEX plan) — done: the graph is the medium (2026-10-24)

- **Write back as you go (P16.3).** The worker instruction gains the ARTEX rule: an asset with `p2o_graph`, a
  `fact:observed`/`fact:inferred` assertion with its evidence, or a note whose text starts with `no-new` when the surface
  added nothing. A worker that learned something and wrote nothing has not finished. The reporting role, which is denied
  graph recording, does not receive the rule. The two pinned instruction hashes moved on purpose; the brief hashes did not,
  because the slice is an optional argument.
- **The brief carries the slice (P16.3).** `src/graph-slice.ts` renders a bounded block (`assets` matching `task.surface`
  with a recent-assets fallback, latest `fact:*` assertions with their evidence and author, open leads/gaps, ready chain
  steps) under `== Graph context from this run (recorded state, background, never a finding) ==`. The spawn path builds it
  from the same ledger read and graph snapshot the worker list uses; a failed read yields no slice, never a failed spawn.
- **The host counts (P16.3/P16.8).** `src/write-back.ts` counts per worker: asset/assertion observations from
  `graph_provenance`, `evidence` receipts from the ledger, reported findings from the live report. The counts appear in
  `p2o_workers list` (`wrote 2 asset(s), …` / `NO_GRAPH_WRITE`), next to each handoff in `REPORT.md`, and as the preflight
  advisory `NO_GRAPH_WRITE` — which `## REMAINING WORK` already prints. Zero writes is an advisory in every one of those
  places and never a refusal: review, export and finish are untouched. Decision 4 in §IX.5 is exactly this shape.
- **Worker progress becomes actionable.** The list also carries `lastFact`, `lastEvidence`, `lastOperation`, `lastWrite`
  and the per-worker counts in its navigation data, so a lead deciding to continue or stop a worker has the record ids.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **787 passed,
12 skipped (801, 95 files)**, with only the two pre-existing load-sensitive harness flakes (`planner-native`,
`extension` “engine inactive”), each green in isolation · `validate_library.py` PASS · pytest 116 passed, 1 skipped (only
the pre-existing R1 provenance failure). New `tests/minimal/phase-i.test.ts` (8): slice filters by surface, falls back and
bounds, brief labels it background, instruction carries the rule (not for reporting), counters per worker, `no-new` clears
the advisory, preflight keeps it advisory, and the report prints the counts next to the handoff.

### Phase J (ARTEX plan) — done: CVE leads (2026-10-24)

- **The host fetches; the model names no destination (P16.4, decision 1).** `p2o_research action=cve` takes
  `product`/`version` (+ optional `vendor`/`cpe`/`assetRefs`), builds the NVD query itself, and fetches from an allowlist
  (`services.nvd.nist.gov`, `nvd.nist.gov`, `cve.org`; https only, redirects refused, 2 MiB bound). The transport is a
  parameter of `lookupCves`, so tests are hermetic and no test process touches the network.
- **A lead record, never a confirmation.** `src/cve.ts` parses NVD (severity from CVSS v3.1→v3.0→v2, affected ranges from
  `cpeMatch`, rejected entries dropped) and writes `lead` records with `{product, version, cve, severity, affected,
  source:{url, retrievedAt, sha256}, assetRefs, state:'untriaged', reason?}`. A failed fetch writes only the failed
  `research` row: no lead is invented from an error page. `action=triage` supersedes the lead into `tasked`/`ruled_out`
  (a reason is required for `ruled_out`), and `leadFrontier` reads the latest revision.
- **The claim rule, verbatim.** `leadRefs` join the candidate schema; a claim that cites a lead must use
  `policyBasis:'inferred'` and cannot be `confirmed` (`LEAD_NOT_EVIDENCE: a CVE lead names a published issue, not an
  executed effect`), checked before the other closure rules so the message names the real reason.
- **Visible, advisory, printed.** The situation line gains `leads: N untriaged (M critical)` (with `SEGMENT_FIELDS`
  parity), preflight adds `LEAD_UNTRIAGED` as an **advisory** that clears when the latest revision is triaged, and
  `REPORT.md` gains `## LEADS` with product/version/CVE/severity/affected/state and the source URL plus its sha256.
- Routing diversity (`## ROUTES`) is P16.5, Phase K, and is not part of this block.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **796 passed,
12 skipped (809, 96 files)**, with only the pre-existing `planner-native` harness flake (3/3 in isolation) ·
`validate_library.py` PASS · pytest 116 passed, 1 skipped (only the pre-existing R1 provenance failure). New
`tests/minimal/phase-j.test.ts` (8): query/allowlist, NVD parsing, provenance from fetched bytes and no lead from a failed
fetch, lead record shape + latest revision, `LEAD_NOT_EVIDENCE` and the inferred-only rule, situation counts, preflight
advisory clearing on triage, and `## LEADS` rendering.

### Phase K (ARTEX plan) — done: routes and negation (2026-10-24)

- **Routes are a plan dimension (P16.5).** `p2o_plan` todos carry `route` (`upload`, `auth`, `sqli`, …). When the lead does
  not name one, `src/routes.ts` derives it from the method family of what the row cites (`risk`, then `needs`/`gained`), so
  every stored todo states its route and two readers derive the same one. The situation line gains
  `routes: N open (a, b), M done`, `REPORT.md` gains `## ROUTES`, and preflight adds `ROUTE_MONOCULTURE` as an **advisory**
  when one open route exists and a demonstrated capability makes another family plausible. The demand wake for a stalled
  round appends `every open step is on route X — plausible elsewhere: …`. Nothing refuses a dispatch: concentration after a
  demonstrated effect is the ARTEX rule, and the host only counts.
- **Negative evidence is a checkpoint (P16.6).** A second `ruled_out` on the same surface+capability is refused with
  `RULED_OUT_RECHECK` unless it cites evidence the earlier negative did not, or a different `control`/mechanism — at most
  one re-check, then the earlier claim must be revised or cited. A `ruled_out` recorded with `execution:not_tested` is
  counted as `unproven-negation` on the situation line so the lead can dispatch the one verification.
- Both are computed from the ledger/plan board only (no model, no clock); the rule literals live in `src/claims.ts`
  (`isRuledOutClaim`) so the "one owner for claim literals" check stays green.

Measured: `npm run typecheck` clean · `npm run build` + `check:build` OK · `npx vitest run tests/minimal/` **801 passed,
12 skipped (814, 97 files)**, with only the pre-existing `planner-native` harness flake (3/3 in isolation) ·
`validate_library.py` PASS · pytest 116 passed, 1 skipped (only the pre-existing R1 provenance failure). New
`tests/minimal/phase-k.test.ts` (5): route default + explicit route + non-todo refusal, monoculture/route counts, situation
sentence + preflight advisory + `## ROUTES`, duplicate ruled-out refusal and its two exits, `unproven-negation`.

This closes the ARTEX plan's phases A–K. Standing rules unchanged: no command/time allowance, no finish gate, completion
derived, a report ends nothing, transport bytes bound records, no count caps on tool input, and nothing refuses a human stop.

## Part VII — Decisions

### Settled by the owner, 2026-10-24 (these are now requirements, not options)
| # | Decision | Effect on §IV |
|---|---|---|
| 1 | Chain-first refusal is **per surface** | M2 refuses only on the surface where the primitive was demonstrated; breadth elsewhere stays legal |
| 2 | A quiet round is **no tested cell, no candidate closure (a `ruled_out` counts as progress), no new asset, no chain-depth increase**; **two** consecutive quiet rounds stop automatic wakes | M6 |
| 3 | `PRIMITIVE_UNCHAINED` applies to **every** `confirmed` + `tested` claim | M4 |
| 4 | **No `finishGate` at all** — remove the setting, not retune it; completion is derived and a report ends nothing | M3 + the Part V deletions |

### Still open (defaults proposed; each is one line to overturn)
1. **Who may stop (M3).** Default taken from ARTEX, where `stopped` means killed or externally ended: exporting a report
   never ends a run, and **only the human may `stop`**. A lead that cannot progress escalates through M6
   (`blocked/human-needed`) instead of stopping itself. This is the one place where "tireless" depends on the human being
   the only one allowed to give up.
2. **Revisit conditions (M7).** Proposed closed list: `block-decay`, `cooldown-expiry`. Add `human-answer`,
   `external-change`?
3. **Continuation count (M8).** Proposed once per worker, void when the ticket is revoked.

---

## VIII — Non-goals and the two new risks

**Non-goals.** No heartbeat or periodic timer (M7 is condition-triggered and single-shot). No Metasploit/C2. No real
credential harvesting. No dispatch, commit, push or install without the owner. No automated platform submission. No
relaxation of existing evidence tests to make a phase pass.

**Risk 1 — fixation.** A chain-first rule can lock the run onto one primitive. Guard: per-surface scope, the deferral exit
in M2, and `PRIMITIVE_UNCHAINED` accepting a *walled* primitive as settled.

**Risk 2 — livelock.** With no ceiling, a non-converging loop can wake forever. This is the trade the no-budget decision
buys; the only automatic brake is M6, and it measures progress, not money. If that proves insufficient, the fix must be a
*named, visible* stop condition — never a hidden constant.

---

# Part IX — Depth, breadth and the graph: what ARTEX does that p2o does not

Proposed 2026-10-24 after the 45-minute run against `https://cntt.uit.edu.vn/`. The owner's question was three
questions: why did the workers never use the asset/fact graph, why did the run settle so quickly instead of digging,
and why can an agent not search the CVE record that recon just made relevant. This part answers them from the code
(`/home/nhanlaptop/artex/ARTEX`, `src/`, and the run's own ledger) and turns the answer into mechanisms P16.1–P16.9
and phases G–K.

## IX.0 What the run actually did

Read from the run's ledger (`run-ff934701-f5f4-41e3-8c40-11494bd8f05d`) and the session export
(`pi-session-2026-10-24T05-07-55-478Z…html`).

| Fact | Value | Why it matters |
|---|---|---|
| Wall clock / requests / tool calls / errors | 45 m 06 s · 145 · 86 · 26 | The run was not short of turns; it decided it was done |
| Candidates | 13: 6 `open_proof_gap`+tested, 5 `ruled_out`, 1 `not_tested`, 1 `blocked` | **Zero confirmed primitives** in three quarters of an hour |
| Coverage notes / open items | 61 / 41 | The real product of the run was breadth bookkeeping |
| Plan board | **2 rows**: one `goal` (`active`) and the same goal `reviewed` | No todo, no decision, no chain step: the chain board was never used |
| Goal text | “Assess … origin: evidence-backed candidate set with explicit coverage and gaps” | A *process* goal, satisfiable by reviewing coverage |
| Assets / facts / relations in the graph | **5 / 9 / 0** | All written in one batch by one worker at 05:14:45 (minute 7) |
| Who wrote them | `p2o-recon-e5b76f`, one `p2o_graph` call | No other worker wrote an asset or a fact for the remaining 38 minutes |
| Outcome | goal `reviewed` with 6 evidence refs → finish | `deriveCompletion` saw no open goal, no confirmed primitive and no ready chain step → `complete` |

So the run did not stop because a brake fired. It stopped because **the schema said it was finished**: a process goal
was reviewed, and with no confirmed claim there was nothing for `PRIMITIVE_UNCHAINED` to hold open. The graph was used
once as a dumping ground for a recon batch and never read back; the chain board was never populated; nothing in the
prompt or in the tool contract made depth the cheaper path than settlement.

## IX.1 What ARTEX does instead

Source references are to `/home/nhanlaptop/artex/ARTEX`.

- **A1 — Goals are verifiable deliverables, and process goals are forbidden.** The goals decomposer splits the task
  into “final, verifiable results” and explicitly refuses to list reconnaissance, analysis, attack steps or
  verification steps as goals (`agent/goals.go:38-52`). It also lifts the operator's constraints (`set_constraints`,
  deny/allow) and the authorized asset scope (`add_task_scope`) once, then injects the constraints into every agent
  (`goalsScopeTail`).
- **A2 — `prove_goal` is the only completion verb.** The planner marks a goal met with `prove_goal(goal_id,
  evidence_id, reason)`; “when the goal you mark is the last unmet one, the system declares the task complete”
  (`agent/planner.go:322-330`). Quantified goals must be checked against the live metrics before marking — “coverage
  100 % required and coverage.pct=40 % → not met, dispatch more” (`planner.go:323-325`).
- **A3 — Hard floor on an empty frontier.** If the goal is unmet and there is no open/running intent, the planner
  **must** emit at least one intent; emitting zero is legal only with a stated reason (already covered, or waiting on a
  dependency) (`planner.go:302-305`). There is no “two quiet rounds then stop” that can end an unfinished task.
- **A4 — The graph is the only medium a worker writes to.** A worker claims one intent and its outputs are
  `insert_assets` (asset graph), `record_fact(intent_id)` (exploration graph, `confidence=observed|inferred`) and
  `report_finding(intent_id)` (only after a real trigger) (`agent/worker.go:232-249`). Every worker receives a
  read-only **global exploration overview** so the next worker does not re-derive what the last one found
  (`worker.go:325-338`). Write-back is counted per kind, and “an intent that explored but persisted nothing is not
  mistaken for done” (`worker.go:340-348`).
- **A5 — Depth-first, with two or three mechanism-different routes.** “Depth comes before coverage: after a high-value
  entry, push that path through rather than flatten coverage” (`planner.go:330-333`); “keep the routes diverse and do
  not converge early — ideally two or three mechanistically different routes coexist (e.g. upload chain vs auth
  bypass); concentrate only after one shows evidence of approaching the goal” (`planner.go:333-335`). A serial chain is
  written as todos and dispatched one step per wake, the satisfied step marked completed (`planner.go:335-342`).
- **A6 — A negative observation is not a conclusion.** Workers are told that “the first block is not exhaustion: walk
  every bypass before you conclude” (`worker.go:233`). The planner treats a worker's “not injectable” as an
  observation: it reads `node_detail(id)` for the evidence, accepts a negation only when the evidence is solid and the
  technique was genuinely exhausted, and otherwise dispatches **one** re-check intent — “at most one re-check per
  negative direction” (`planner.go:313-318`).
- **A7 — A day-long task is many short runs.** Each round has a turn/time budget; when it fires, a settlement prompt
  forces the agent to write back before it stops (`agent/wrapup.go`). A run cut by its budget ends `exhausted`, and
  `exhausted` is a checkpoint, not a failure: the planner reads `get_worker_trace` and dispatches “continue from where
  it stopped” (`planner.go:326-329`). Worker conversations are persisted per intent and resumed
  (`WorkerSessionID`, `worker.go:88-92`); context is kept small by cold-digest compaction (`agent/compaction.go`).
- **A8 — CVE matching generates leads, never evidence.** Every agent may have a web-search backend (ddgs, Brave,
  Tavily, DeepSeek) (`worker.go:38-52`). The rule is explicit in both the planner and worker prompts: matching a
  version/fingerprint to a CVE, an advisory, a changelog or a diff **is not a finding**; the worker records an
  `inferred` fact for the planner, and only a real trigger can become a finding (`worker.go:240`, `promptcatalog.go:40,104`).

## IX.2 The eight gaps in p2o

- **G1 — p2o accepts process goals.** `PlanDraft` has `criteria` but no typed acceptance; a goal about “an
  evidence-backed candidate set with explicit coverage” is a legal goal and a `reviewed` goal settles it.
- **G2 — Settlement is a status, not a proof.** `deriveCompletion` asks “is any goal outside reviewed/closed”
  (`src/completion.ts:41-43`); it never asks whether the goal was *demonstrated*. A goal can be reviewed with six
  evidence refs and zero primitives and the run reads `complete`.
- **G3 — M6 stops instead of demanding work.** Two quiet rounds pause the engine (`src/engine.ts:116-125`); ARTEX's
  equivalent situation is a hard floor that **requires** a new direction. The M6 message even names “blocked/human-needed”
  while a ready chain step or an unchained primitive may still exist.
- **G4 — The graph is not in the loop.** `src/prompts.ts` never mentions `p2o_graph`; the brief carries no graph slice;
  the worker contract never asks for a write; the report does not count writes. `p2o_graph` also demands typed batches
  with revisions and provenance, which is a much higher ceremony than `record_fact(summary, evidence, confidence)`.
- **G5 — No CVE/lead pipeline.** `p2o_research` is a citation lookup over the committed corpus and `curatedSource`
  refuses every other URL (`src/research.ts`); `p2o_net` could reach NVD but nothing asks for it, nothing structures
  the answer, and nothing stores provenance. A recon asset with `php 5.3.3` and `Apache/2.2.15` produces no lead.
- **G6 — No route dimension.** Chain steps model one chain (`chainOf`/`step`), not the *approach family*; nothing asks
  for two or three mechanism-different routes, and nothing notices when every open path is the same mechanism.
- **G7 — `exhausted` is read as failure.** The lead prompt says an exhausted task is “retry the direction differently,
  never read it as answered” (`src/prompts.ts:96`) — the opposite of “continue from its trace”. The `continue` verb
  exists (M8) but the guidance points away from it.
- **G8 — Nothing forces write-back at settlement.** A worker can report “nothing new” after digging, and the ledger has
  no per-worker count of assets/facts/evidence to contradict it. The run above is exactly that: 70 evidence receipts
  but 5 assets and 9 facts, all from one batch.

## IX.3 Mechanisms P16.1–P16.9

**P16.1 — Deliverable goals, proven before they settle.**
A goal gains `proof: { kind: 'capability' | 'case' | 'coverage', capability?, ref? }`. `p2o_plan` refuses `reviewed`
or `closed` for a goal without proof: `GOAL_UNPROVEN: goal <id> is a statement about the target, not about the run; cite
a confirmed primitive, an accepted case or the coverage plan that settles it`. The schema refuses a goal title that
carries no `proof` at all. `deriveCompletion` adds `GOAL_UNPROVEN` (goal settled by status but not by proof) so the
report and `p2o_finish` show it. Nothing refuses a finish — the state simply stays `incomplete`.
*Test:* a process goal without proof is refused at create; a reviewed goal with a confirmed+tested claim is accepted; a
reviewed goal with only notes stays `incomplete` with `GOAL_UNPROVEN`.

**P16.2 — The frontier floor (revision of M6).**
Two quiet rounds do not pause an unfinished run. The engine receives `completionRemaining` with the round progress and:
if a goal is unsettled, a chain step is ready or a primitive is unchained, it emits a **demand** wake that names the
specific obligation (`quiet round 3 and 4 added nothing; step 2 of chain <id> is ready and undispatched`) and keeps the
loop live; it pauses only when the completion is `complete` or the lead recorded `blocked/human-needed` with the missing
prerequisite. A paused engine with remaining work is exactly the “run went quiet while work was owed” failure.
*Test:* quiet rounds with a ready step produce a wake whose text names the step, not `pause`; quiet rounds on a complete
run pause; a lead-recorded blocked decision pauses.

**P16.3 — The graph is the medium, and a write is visible (ARTEX rule, no gate).**
The worker instruction gains the ARTEX rule: “record what you learn as you learn it — an asset with `p2o_graph`, a
`fact:observed`/`fact:inferred` assertion with evidence, or a `p2o_note` when there is nothing new; a worker that learned
something and wrote nothing did not finish.” The brief carries a slice: assets on the task surface (≤20), the latest
facts from other workers (≤20), open leads, and the chain frontier. The host computes `wrote: {assets, facts, evidence}`
per worker for the run and returns it in `p2o_workers list` and the report; zero writes without a `no-new` note is
`NO_GRAPH_WRITE` (advisory), visible to the lead and in `REMAINING WORK`. Review is never refused for it.
*Test:* a brief carries the slice; the counters match the ledger per worker; `NO_GRAPH_WRITE` appears only without the
note.

**P16.4 — CVE leads from recon, never evidence.**
`p2o_research` gains `action:'cve'` with `product`, `version`, `vendor?` and optional `cpe`; it returns CVEs with
severity, affected range and the source URL + `retrievedAt` + sha256, and writes a `lead` record:
`{product, version, cve, severity, affected, source:{url, retrievedAt, sha256}, assetRefs:[{id, revision}], state:'untriaged'|'tasked'|'ruled_out', reason?}`.
A claim may cite a lead only as `policyBasis:'inferred'` and stays `open_proof_gap` until triggered — the ARTEX rule,
verbatim. The situation view gains `leads: N untriaged (M critical)`; a wake after a new version-bearing asset says which
leads it unlocked. At export/stop, untriaged leads on in-scope assets appear as `LEAD_UNTRIAGED` (advisory, not a gate);
`REPORT.md` gains `## LEADS` and `## ROUTES`.
*Test:* `product/version` produces lead records with provenance and no candidate confirmation; a claim citing a lead
cannot be `confirmed`; the segment counts untriaged leads.
*Open decision:* the source. (a) host-side fetch with an allowlist (`nvd.nist.gov`, `cve.org`, vendor security pages);
(b) worker-side fetch through `p2o_net` plus a `record-lead` write; (c) an offline curated mirror. (a) is the only option
that works for a solo run and keeps provenance under host control; it needs the egress decision below.

**P16.5 — Route diversity as a visible dimension.**
`p2o_plan todo` gains `route` (slug: `upload`, `auth`, `sqli`, `deser`, `ssrf`, …; default `methodFamily`). The
situation view gains `routes: 2 open (upload, auth), 1 done`. While the goal is unmet and every open chain step shares
one route, the wake says so and names the unexplored families that the current facts make plausible; on a run with a
single open route and a plausible alternative, `ROUTE_MONOCULTURE` appears in the report (advisory). Concentration is
allowed once a route shows a demonstrated effect — the ARTEX rule.
*Test:* two routes render; a single-route run produces the advisory; the wake names the alternative family.

**P16.6 — Negative evidence is a checkpoint, not a wall.**
A `ruled_out` claim already requires its control; a second `ruled_out` on the same surface + capability is refused
unless it cites a different mechanism or new evidence (`RULED_OUT_RECHECK`), which encodes “at most one re-check”.
A negation recorded with `execution:not_tested` or without a control is shown as `unproven-negation` in the situation
view so the lead can dispatch the one re-check.
*Test:* a duplicate ruled-out is refused; an untested negation is shown as unproven.

**P16.7 — Continue from the trace, never “retry differently”.**
The exhausted/expired guidance becomes: “its progress is in the ledger and its conversation is resumable; continue it
with `p2o_workers continue` and a brief that starts where it stopped, or dispatch a new task with a different mechanism.”
`p2o_workers list` gains `lastWrite` and `progress` (commands, last fact, last evidence) per worker. An `expired`
worker's record carries the last in-flight operation so the brief can name it.
*Test:* the prompt line names `continue`; a worker list shows the last write; a worker that reported `expired` yields a
continue hint rather than a retry-different hint.

**P16.8 — Write-back accounting at settlement.**
Host-computed per-worker counters (assets, facts, evidence, findings) are attached to the report and shown in the worker
list; a worker with zero writes and no `no-new` note is flagged `NO_GRAPH_WRITE` (advisory). The report's
`## REMAINING WORK` lists it next to the obligations.
*Test:* counters match the ledger; the flag appears only without a note.

**P16.9 — The lead sees what ARTEX's planner sees.**
The wake text becomes a situational snapshot with the pieces it currently lacks: `graph` (assets and facts on the
run's surfaces), `leads`, `routes`, `writes` since the last wake, and the chain frontier. `SEGMENT_FIELDS` is extended
for every new key so the drift test keeps the prompt and the view in step.
*Test:* the drift test covers each new key; a wake after a fact shows it.

## IX.4 Phases and acceptance

| Phase | Mechanisms | Acceptance (hermetic) |
|---|---|---|
| **G** — Goals that have to be proved | P16.1, P16.9 (goal/leads fields) | create refuses a goal without `proof`; `reviewed` without proof stays `incomplete` with `GOAL_UNPROVEN`; a proven goal leaves `complete`; the report prints the proof |
| **H** — Frontier floor and continue | P16.2, P16.7 | quiet rounds with a ready step wake with the step named and do not pause; `exhausted` guidance names `continue`; worker list shows the last write |
| **I** — Graph as the medium | P16.3, P16.8 | brief carries the slice; the report and worker list count the writes per worker; `NO_GRAPH_WRITE` is advisory and never a refusal |
| **J** — CVE leads | P16.4 | version→CVE writes `lead` records with provenance and never a confirmation; a lead-citing claim cannot be confirmed; `LEAD_UNTRIAGED` is advisory; `## LEADS` renders |
| **K** — Routes and negation | P16.5, P16.6 | two routes render; `ROUTE_MONOCULTURE` fires on a single-route run; a duplicate ruled-out is refused; an untested negation is shown |

Each phase keeps the standing rules: no command/time allowance, no finish gate, completion derived, a report is not
termination, transport bytes bound records, and nothing refuses a human stop.

## IX.5 Decisions — settled by the owner, 2026-10-24

1. **CVE source: host-side fetch with an allowlist** (`nvd.nist.gov`, `cve.org`, vendor security pages). The host records
   the URL, the retrieval time and the hash; the model never supplies a destination. Offline mirror later if a target
   requires it.
2. **Mapping goals may prove with `proof.kind:'coverage'`** — a plan whose cells are all terminal. A goal whose text
   claims reachability still needs a capability or an accepted case; coverage cannot stand in for a demonstrated effect.
3. **Route diversity is advisory** (`ROUTE_MONOCULTURE`): “a plausible alternative exists” is the model's judgement, so
   the host reports it and never refuses a dispatch over it.
4. **Graph write-back follows ARTEX, not a gate.** No review refusal. Instead: the worker prompt requires writing as it
   goes; the host computes `wrote: {assets, facts, evidence}` per worker and returns it in `p2o_workers list` and the
   report; a worker with zero writes and no `no-new` note is shown as `NO_GRAPH_WRITE` (advisory) everywhere the lead and
   the report can see it. ARTEX's own line is “an intent that explored but persisted nothing is not mistaken for done”
   (`agent/worker.go:340-348`) — a fact the next reader can see, not a refusal.
5. **M6 pauses on `complete` and on a recorded `blocked/human-needed`, and keeps waking while an obligation remains.**
   Two quiet rounds with a ready step, an unchained primitive or an unsettled goal produce a demand wake that names the
   obligation; only a run with nothing owed, or one whose lead recorded the missing prerequisite, goes quiet.

Recorded above as requirements, not options. Phase G starts with 1–2.

## IX.6 Expected effect on the measured run

With G alone, the goal would have been refused at create unless it named a proof; the review at 45 minutes would have
stayed `incomplete` and the wake for the next round would have named `GOAL_UNPROVEN`. With H, the two quiet rounds
would have woken a direction instead of settling. With I, the 70 evidence receipts would have been accompanied by facts
and assets from every worker, and the second and third workers would have started from them. With J, `php 5.3.3`,
`Apache/2.2.15` and the undisclosed Joomla version would have produced leads the next wake had to triage. With K, the
run would have shown that all its approaches were the same route before it called the surface mapped.


## Part X — Tool surface direction (2026-10-25)

Measured before changing anything: 25 registered tools; registration and `ALL_TOOLS` agree in both directions; 65 top-level
`src/*.ts` helpers, every one with a production importer (0 dead); the per-role cross-check finds no prompt naming a tool the
role cannot call, and the lead prompt still names none. The audit's only real defects were documentation and guidance gaps,
not a missing or dead surface.

### X.1 Decisions (owner, 2026-10-25)

1. **No merges.** Overlapping tools stay separate. The split is stated in each tool's guideline and pinned by a test, because a
   merge would move the prompt, the worker hashes and the docs for a benefit no measured run has demonstrated.
2. **`p2o_lab` keeps its delegated-lead access.** The comment was wrong, not the policy: an executing role creates a payload, a
   reviewing owner may read or verify it, and a reporting worker gets neither. No permission changed.
3. **Every registered tool carries exactly one boundary line** in `TOOL_GUIDELINES` (25/25, `POLICY_VERSION` 4). The guidance
   ceilings rise on purpose, from measured bytes rather than estimates: owner 2,850 B (2,608 delegated / 2,798 solo), worker
   2,350 B (2,244 discovery / 1,443 reporting).
4. **The reporting branch names the tools it carries** (`p2o_note`, `p2o_surface`, `p2o_request_subtask`, `p2o_report`, plus the
   knowledge and ledger readers) instead of describing them as "append notes" and "propose follow-ups".

### X.2 Boundary map — the clusters that stay separate

| Cluster | Tools | Stated split |
| --- | --- | --- |
| Read | `p2o_state`, `p2o_ledger`, `p2o_graph` | narrow heads/search → complete record by id → typed assets and facts |
| Knowledge | `p2o_research`, `p2o_skill_read`, `p2o_skill_list` | technique/web/CVE context (never evidence) → approved playbook by id |
| Ledger write | `p2o_note`, `p2o_surface` | free text with a narrow kind → one component+entryPoint row with a duplicate hint |
| Retained bytes | `p2o_capture`, `p2o_artifact` | writes retained text → reads it back by id instead of pasting |
| Execution | `p2o_shell`, `p2o_net`, `p2o_http` | generic sandbox → target contact and scratch installs → origin-scoped requests |

### X.3 Pins added

- `tests/minimal/workflow-policy.test.ts`: every `ALL_TOOLS` entry has a guideline, no guideline names a tool outside the
  policy, and the measured ceilings above are asserted.
- `tests/minimal/reporting-policy.test.ts`: the reporting prompt must name the tools the reporting loadout carries, so a future
  prose-only rewrite fails instead of silently hiding them.
- The two pinned recon instruction hashes did not move: the edited branch is reporting-only and both pinned tickets are recon.

### X.4 Deferred

- No tool was removed, merged or renamed, and no permission was widened. If a cluster still confuses a measured run, the next
  move is evidence from that run, not another rename.
- Docs stay in sync one step behind the surface: `README.md` now lists all 25 tools with their real role sets, and
  `docs/USAGE.md` records that every tool has one boundary line.

---

Retired plans stay outside the tree under `tmp/` (gitignored): `planning-2026-10-22-retired-chain-lineage.md`,
`planning-2026-10-23-p14-p15-archive.md`, `planning-2026-10-24-diagnosis-early-finish.md`.
