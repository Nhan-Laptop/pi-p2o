# P18 proposal — long-horizon loop: rounds as fresh sessions

Status: **proposal, nothing here is implemented.** This file replaces the P17 text; that text is unchanged in git at
`git show bacbb6d:planning_update.md` and its implementation landed in `431b916`, `0eeda8a`, `aaa8ed0`, `bacbb6d`
(impact-goal admission, worker stance, grey-box brief, scoped severity, foothold, skill ladder, fixtures). P18 does not
reopen P17's decisions D32–D43; it changes the machine those texts run on.

Owner request (2026-10-28): *"base on the current propose: B — planner run mới mỗi round, rehydrate từ ledger + graph;
round budget + pha wrap-up; hard floor ở tầng engine cho cả hai mode; model routing theo pha; các chi tiết vay được
(debounce 800 ms, drain + final round, cold-digest, nudge cap 2). Deeply research and give me the plan to update this
extension. Replace all new plan into planning_update.md."* This document is that research and plan.

Scope: **the loop, not the doctrine.** P18 adds no permission, target tool, role, skill, effect class or finish gate. It
also carries one owner decision that removes a branch rather than adds one: the `manual` loop mode is deleted, so every
run is the automatic loop (D48) and a start requires a worker backend.
It changes when a planner round starts, what context it starts with, how it is bounded, how it ends, and which model
runs it. The campaign itself stays uncapped: no token, spend, elapsed-time or round-count ceiling on the run (owner
decision 2026-10-24, preserved). It does not fix provider-failure recovery or worker liveness; those are named as the
next pass (P19) in §9.2 so they cannot be assumed fixed by accident.

---

## 1. Why this pass

### 1.1 The loop as it is, verified

Line references are at `HEAD a392f2b`. The loop has three layers: Pi's inner tool loop, the deterministic
`AssessmentEngine` (`src/engine.ts`), and the worker process. The engine starts and bounds nothing; the planner owns
the conversation for the entire campaign.

| Fact | Evidence | Consequence for a long campaign |
| --- | --- | --- |
| Default loop is `manual`; a committed worker report only raises a UI notice | `src/roles.ts:156`, `src/engine.ts:220`, `extensions/p2o/index.ts:3545-3552` | The "loop" is a human typing. Autonomy is opt-in. |
| Automatic rounds exist only in `event-driven`, which requires Herdr | `extensions/p2o/index.ts:3245` | The autonomy path is not portable to a headless or RPC measurement run. |
| Wakes come from committed events, paced debt, and a heartbeat; two quiet rounds with nothing owed pause the campaign | `src/engine.ts:219-242`, `:261-279`; `src/campaign.ts:12-14` | The loop stops when the model runs out of ideas, which is exactly when a different mechanism is needed. |
| A planner outcome other than `completed` pauses the campaign with no retry | `extensions/p2o/index.ts:3748-3751` | One provider error or abort ends the paid run's remaining hours. |
| There is one planner conversation for the whole run; prompt sections are pinned at 14,200/13,200/13,500/1,650/2,600 chars | `tests/minimal/recon.test.ts:211` | Context grows monotonically (Context Rot); ending a round asks the planner to rebuild from the ledger but the transcript stays. |
| `p2o_loop wait` is the documented way to end a round and it suppresses the debt wake | `src/prompts.ts:163`; `src/engine.ts:232` | A planner that waits for a slow worker can sleep until an event or a human, with work still owed. |
| Round progress is four monotone counters plus remaining obligations; no severity or impact counter | `extensions/p2o/index.ts:483-489` | The loop optimises obligation closure. Depth is prompt will, not loop structure. |
| Completion is derived from plan obligations; `p2o_finish` has no gate (owner decision) | `src/completion.ts`, `src/finish-preflight.ts:14-28`, `extensions/p2o/index.ts:2924-2930` | An honest but shallow run can finish incomplete; nothing makes the loop try the next rung. |
| The measurement instrument cannot see this architecture: one prompt, `delegation:false`, no `--loop` | `scripts/benchmark-skills.mjs:107,564` | No clean number exists for the current loop. Effectiveness stays UNVERIFIED. |

### 1.2 The mechanism chain that loses high/critical yield

High/critical findings are chain-shaped: recon → primitive → bypass → effect → depth. That chain needs several
consecutive rounds on one line of reasoning, each carrying the previous round's exact payload and state. The current
loop makes each round expensive in context and fragile in continuity:

1. Round N's reasoning stays in the conversation; round N+1 re-reads it through a growing transcript, so the planner's
   attention per ledger fact falls as the campaign succeeds (Context Rot is measured, not asserted, §2.3).
2. A quiet round pauses; a stalled round pauses at 3 with debt; a wait suppresses the debt wake. Three independent
   off-ramps from the state that precedes a breakthrough.
3. A single provider failure — likely once in a 1–3 hour run — ends autonomy and asks a human to restart.
4. Nothing bounds a round, so a round that is going nowhere is indistinguishable from one that is nearly there, and
   nothing makes it write back before it ends.
5. Model choice is fixed for the whole run, so the cheap model does the hard link (or the expensive model does
   triage).

### 1.3 What P18 changes

Rounds become the unit of work, and a round becomes an object the harness can start, bound, and end:

- **A fresh planner session per automatic round**, rehydrated from the ledger and graph by a deterministic briefing.
  The conversation stops being the campaign's memory; the ledger already is (`docs/PLANNER_ENGINE.md` "Rounds").
- **A round budget with a wrap-up phase**: soft bounds that force write-back while tools are still available, and a
  classified hard stop that ends the round without ending the campaign.
- **A demand floor**: while the host can name owed work, a quiet round cannot silently pause, and `wait` cannot be
  used to sleep through it.
- **One loop mode**: the `manual` mode, its settings value, its CLI flag and its prompt branch are removed; a run is
  always the consented automatic loop, and without a worker backend the start is refused instead of starting a run that
  can never execute.
- **Per-round model/thinking routing**, recorded, with an escalation rule that is visible in the report.
- The ARTEX details that survive translation: a short burst debounce, a bounded nudge for text-only endings, a
  per-round cold digest of old ledger material, and one closing round before an operator stop.

What it deliberately does not change: the planner still holds no target tool, workers still own execution and claims,
a finding still needs receipts, severity still stops at demonstrated depth, and `p2o_finish` still has no gate.

---

## 2. Research

### 2.1 ARTEX v0.3.15 (`my_references/ARTEX/`)

The closest peer. P17 ported ARTEX's *worker doctrine*; P18 ports its *round machinery*. Verified against Go source.

| Mechanism | Where | Why it matters | P18 landing |
| --- | --- | --- | --- |
| Planner is a fresh LLM session per wake; the plan survives in a per-task todo store | `agent/planner.go:44-49,355-472` | Context per round is constant, so attention on the current frontier does not decay over a 5-hour run. | D45, P18.2 |
| A round ends when `Plan()` returns; signals are typed (`done`/`finding`/`goal`/`hint`/kill/resume) plus a ≥600 s heartbeat; bursts coalesce through an 800 ms debounce | `server/engine.go:781-912,390`; `db/tasks.go:81-83` | A round knows *what changed*, not just "something happened". | D49, P18.4 |
| Hard floor: with an unmet goal and no open/running intent, the round **must** produce at least one intent | `agent/planner.go:303-304,455-459` | The loop cannot rest while the goal is open; "0 intents" is legal only with a stated reason (covered / waiting on a dependency). | D48, P18.3 |
| Typed terminal states: `max_turns`/timeout → `exhausted`, model/API error → `blocked`, normal → `done`; `NotifyDone` wakes the planner with the intent id | `server/engine.go:1128-1155` | Budget exhaustion is *replannable*, not a failure of the campaign. | D47, P18.3 |
| Settlement at the budget wall: hide Bash → inject "write back everything now" → 10 extra turns → terminate as `exhausted` | `agent/worker.go:424-462`; `agent/wrapup.go:28-40,90-106` | A bounded run still lands its evidence instead of dying mid-thought. | D47, P18.3 |
| Per-agent `max_turns`/`run_seconds` are configuration, not code; task deadline clamps a run's wall clock | `server/server.go:296-320`; `agent/taskclock.go` | Bounds live in operator settings; the campaign stays open-ended. | D44 |
| Model pool with health/cooldown failover | `llmpool/pool.go`, `llmpool/health.go` | A provider failure swaps models instead of stopping the campaign. | **Out of scope (P19)**; note in §9.2 |
| Graph cold-digest: nodes idle ≥6 planner rounds are summarised, hidden from the view, expandable on demand | `agent/coldgraph.go:40-45`, `agent/compaction.go:68-103` | Old material stays available without crowding the current decision. | D46, P18.2 (ledger digest) |
| Thinking-only turn gets a Stop-hook nudge, capped at two | `server/engine.go:547-620` | A silent end-of-turn is retried rather than lost. | D49, P18.5 |
| Timed shutdown: stop new claims → drain in-flight 90 s → one final planner round for goal judgment | `server/engine_timeout.go:16-18,199-233` | A stop is an evidence-preserving transition, not a kill. | P18.7 (operator stop path) |

**What not to copy.** ARTEX's findings are self-attested (`report_finding` needs only vulnclass/severity/summary;
evidence optional, `agent/tools.go:1220-1226`), no dedup, severity unvalidated at write time, `max_turns` defaults to
0 (unlimited), and `Options.TokenBudget` is never set. Its budget story is narrower than it looks: the *worker run* is
bounded, the planner round is not, and cost is metered, not capped. pi-p2o stays stricter on evidence and takes only
the round machinery.

### 2.2 Strix (`my_references/strix/`)

Strix runs one long SDK run per agent and defends it differently: plain text never terminates a run — only the
lifecycle tools (`finish_scan`/`agent_finish`) do, and a text-only ending is re-driven with a nudge
(`strix/core/execution.py:534,643,985`). It bounds the run with two axes — 500 turns per agent
(`strix/config/settings.py:14`) and dollars per scan — and injects progressive wrap-up directives at 70/85/95 % of
each, with a 90 % subagent reserve (`strix/core/hooks.py:50,255-277,399-407`). Its compaction is security-shaped: keep
8,000 tokens verbatim, summarise the head under an anti-loss rubric (findings, credentials, dead ends, next move),
and snap the split so no tool call is left open (`strix/llm/compaction.py:35,96-143,208-221,340`). Evidence fields are
gated in code at the report tool (`strix/tools/reporting/tool.py:183-330`).

What P18 takes: the *progressive, content-bearing wrap-up* (a warning that says what to write, not just "hurry"),
and the nudge-as-default for text-only endings. What it does not take: one immortal session, and a wall-clock-free
run. Weaknesses Strix shares with the current pi-p2o loop: no wall-clock bound on a run, methodology enforced by
prompt volume, headless runs can die quietly (`runner.py:633-646`), and no in-repo reproducible benchmark.

### 2.3 Industry evidence (numbers already recorded in P17 §2.2, Appendix D)

- XBOW: thousands of short-lived narrow agents + a persistent coordinator + deterministic validation; alloy model
  routing 68.8 % vs 57.5 % for the best single model, with a hard cap near **80 iterations because restarts beat
  accumulated false assumptions** — [xbow.com/blog/alloy-agents](https://xbow.com/blog/alloy-agents).
- Context Rot: performance degrades monotonically with input length across 18 models; distractors compound —
  [trychroma.com/research/context-rot](https://www.trychroma.com/research/context-rot).
- Naptime / Big Sleep: harness redesign (including auto-verification and multi-trajectory sampling) improved results
  up to 20×; one explicit exploit-intent sentence moved 0.26 → 0.72 —
  [projectzero.google/2024/06/project-naptime.html](https://projectzero.google/2024/06/project-naptime.html).
- CyberGym: best agent+model reproduces 11.9 % of 1,507 real vulnerabilities — [arxiv.org/abs/2506.02548](https://arxiv.org/abs/2506.02548).
- AutoPenBench: 21 % autonomous vs 64 % human-assisted — [aclanthology.org/2025.emnlp-industry.114/](https://aclanthology.org/2025.emnlp-industry.114/).
- Decoupling recon from exploitation: up to 90.0 % functional success when context is accurate vs ≈ 50.0 %
  autonomous recall — [arxiv.org/abs/2606.25332](https://arxiv.org/abs/2606.25332).
- AIxCC: engineering between rounds moved synthetic vuln discovery 37 % → 86 % — [darpa.mil/news/2025/aixcc-results](https://www.darpa.mil/news/2025/aixcc-results).

The consistent lesson: **bounded runs, durable external state, fresh context per decision, and routing**. That is
exactly the pair (fresh session, round budget) ARTEX and Strix each implement from different ends. P17 already fixed
the doctrine; P18 fixes the machine.

### 2.4 The Pi SDK can carry this design — verified in the installed package

This is the load-bearing research: the design below is only legal if the extension can start and end a model context.
`@earendil-works/pi-coding-agent` **1.1.0** is installed in-repo; the following was read from its declarations and
compiled runtime.

| Capability | Evidence | P18 use |
| --- | --- | --- |
| An extension can dispatch its own command programmatically: `pi.sendUserMessage('/p2o-round …', {expandPromptTemplates:true})` runs the registered command handler and does **not** send a model prompt | `dist/core/agent-session.js:1526-1532` ("Extension command executed, no prompt to send"), `:1636-1648`; `dist/core/extensions/types.d.ts:1241-1245` | The wake path can call an internal command instead of injecting a model message. `sendUserMessage` is fire-and-forget and, while streaming, **throws** if `deliverAs` is omitted (`:1551-1554`) — the dispatch must be guarded by `ctx.isIdle()`. |
| Command handlers get session control: `newSession({setup, withSession})`, `fork`, `switchSession`, `navigateTree` | `dist/core/extensions/types.d.ts:286-320`; `RegisteredCommand.handler(args, ctx: ExtensionCommandContext)` `:1147-1153` | A round can begin in a **new session** without an external process. |
| A new session is created by `newSession`, which first emits a cancellable `session_before_switch`, then tears down and rebinds the runtime, then calls `withSession(replacedCtx)` | `dist/core/agent-session-runtime.js:147-170`, `:120-127` | Our existing "stop the run on session change" handler must allow an *internal* switch and rebind `run.ctx`. |
| In `withSession`, `sendMessage(..., {triggerTurn:true})` starts a turn; `before_agent_start` fires once per **user prompt**, not per continuation | `dist/core/agent-session.js:1588,1591` | The planner system-prompt section and wake parsing keep working inside the fresh session; boundary continuations reuse the run's prompt, so a round must carry everything its continuation needs. |
| After a replacement, the old context is invalidated ("stale after session replacement") and command handlers are re-entrant/undocumented mid-run | `dist/core/agent-session.js:1003`; `runner.js:724-758`; `docs/extensions.md` (session changes "command-only") | Round start must move post-switch work into `withSession` and rebind; the self-dispatch escape hatch is the design's main risk (D45, §9.1) and needs the fallback. |
| Continuation at settlement: returning `{entries:[{type:'custom_message',…}], continue:true}` is the only way to add a turn; `continue` alone is refused unless the projected context ends non-assistant, and the settle loop is otherwise **unbounded** | `dist/core/extensions/types.d.ts:729-771`; `dist/core/agent-session.js:616-648,1389-1413` | The nudge must append a `custom_message` draft each time, and the extension — not Pi — owns the nudge budget (D49: max 2/round). |
| Context usage and manual compaction are exposed on the event context: `getContextUsage()` → `{tokens, contextWindow, percent}`; `compact({customInstructions, onComplete, onError})` | `dist/core/extensions/types.d.ts:197-262`; `dist/core/agent-session.js:2168-2169` | Wrap-up triggers on context percentage; compaction **aborts the current run first**, so it is only legal between rounds, never mid-turn. |
| Model and thinking level are switchable at runtime: `pi.setModel(model): Promise<boolean>`, `pi.setThinkingLevel(level)`, `pi.getThinkingLevel()`; `pi.registerVirtualModel(...).route()` runs before every request with `reason` (`user|continuation|retry|direct`) and persisted state | `dist/core/extensions/types.d.ts:1274-1290,1371-1378`; `dist/core/agent-session.js:1946-1963` | Round-level routing via `setModel` at round start (a fresh session has no cache to lose, and it appends a recorded `model_change`); per-request escalation inside a round can use a virtual model later without transcript entries. |
| Tool loadout is swappable mid-run: `pi.setActiveTools(names)`; the live loadout is authoritative for the next request | `dist/core/extensions/types.d.ts:1263-1267`; `dist/core/agent-session.js:1592-1600` | A closing loadout can remove dispatch tools during wrap-up without touching authority. |
| Step counting: one `message_end` per assistant message; the ending message's `stopReason` distinguishes `stop` from `error`/`aborted`; `turnIndex` resets per low-level run and is not a budget | `extensions/p2o/index.ts:3708-3729` (existing use); `agent-session.js:878-899` | Round budget, nudges and classified aborts all have a hook; the counter must be the extension's own. |
| Abort and idle: `ctx.abort()`, `ctx.isIdle()`, `hasPendingMessages()`; usage (tokens + cost) arrives on every assistant `message_end`; no aggregate usage API | `dist/core/extensions/types.d.ts:213-262`; `pi-ai/dist/types.d.ts:291-312` | A hard-stop backstop, a safe switch window, and per-round cost accounting from the messages the extension already records. |

What the SDK does **not** provide, and must not be promised: no extension-initiated session switch outside a command
context (event handlers get the plain `ExtensionContext`), no in-turn timer or extra turn after a hard abort, no cost
cap, no way to disable auto-compaction or set keep budgets from code (`pi.getSettings()` is read-only), and no way to
reopen a previous session's planner context automatically. The design works around each: the command indirection for
switching, the `context`-hook injected directive for wrap-up, `getContextUsage()` + step counts for bounds, and the
ledger for recovery. An external `pi --mode json -p --no-session` subprocess per round would remove the re-entrancy
risk but adds a second process, a second model surface and a worker-style transport; it is recorded as the fallback
architecture if the command route fails its real-Pi gate (§9.1).

---

## 3. Constraint census 3.0 — what still caps the horizon

Legend: **HARD** = code refuses; **SOFT** = prose; **ABSENT** = mechanism missing; **KEEP** = invariant.

| # | Where | Current | Why it caps duration or severity | P18 |
| --- | --- | --- | --- | --- |
| L1 | `src/roles.ts:156`, `src/engine.ts:220` | `manual` is the default; no automatic round | A campaign needs a human at the keyboard; latency is human attention | D45/D48: rounds-as-sessions run in the only loop mode; the mode choice is removed and the start refuses without a worker backend |
| L2 | `src/engine.ts:219-242` | Wake only on events/debt/heartbeat | No strategy-driven continuation: a planner cannot schedule "do the next rung in 10 minutes" except via a revisit condition | D46/D48: demand wake while work owed; revisit unchanged |
| L3 | `src/prompts.ts:163`, `src/engine.ts:232` | `wait` ends the round and suppresses the debt wake | Correct for "waiting on a dependency", wrong when work is still owed and unnamed | D48: `wait` records a demand signature; a changed obligation set re-arms the wake |
| L4 | `src/engine.ts:224-225,261-279` | Quiet with nothing owed pauses; 3 stalls + debt pauses | The loop exits at the moment a change of mechanism is required | D48: quiet + owed ⇒ demand wake; pause only when nothing is owed or the planner declares `blocked` |
| L5 | `extensions/p2o/index.ts:3748-3751` | Non-`completed` outcome pauses | One provider error ends autonomy | Out of scope (P19); P18 must not make it worse (round-budget aborts are classified, not paused) |
| L6 | `extensions/p2o/index.ts:3708-3729` | One long conversation; no round lifecycle object | Context Rot and no per-round accounting | D45: a fresh session per automatic round with a generated briefing; D47: round records |
| L7 | absence of a round budget | A round can run for hours or stop in one step | No write-back pressure, no graceful close, no way to distinguish stuck from nearly-there | D44/D47: soft steps/seconds/context bands + wrap-up + classified hard stop |
| L8 | `src/completion.ts`; `extensions/p2o/index.ts:483-489` | Progress counters have no severity/impact axis | Completion can be reached with no high/critical attempt | D46: the briefing carries the impact obligation and the untried-mechanism demand; no new gate |
| L9 | `src/tools/...` (no routing) | One model per run | The hard link and the triage run on the same model | D50: per-round model/thinking with an escalation rule, recorded |
| L10 | `extensions/p2o/index.ts:3730-3744` | Worker silence only surfaces when Pi settles | A dead worker holds a slot; finish refuses | Out of scope (P19); P18 keeps the demand visible in the briefing |
| L11 | `scripts/benchmark-skills.mjs:107,564` | Single prompt, `delegation:false`, no `--loop` | Cannot measure the autonomous loop | D52: bench support for a multi-round event-driven arm |
| L12 | `src/engine.ts:90` (`debounceMs=100`) | Signal bursts wake after 100 ms | Three reports in a second can cost three rounds at full model price | D49: 800 ms fixed window, deterministic tests |

---

## 4. Invariants for a loop pass

Each is stated so a test can fail on it.

1. **Authority unchanged.** Planner still holds no target, lab or claim tool; dispatch is the only path to execution;
   one start consent; no per-action consent. A round session is still the planner role.
2. **Evidence unchanged.** Receipts, review, independent validation, severity bounded by demonstrated depth,
   version/banner match never proof.
3. **The campaign is uncapped.** No token, spend, elapsed-time or round-count ceiling on the run. A *round* is bounded
   (D44); the campaign is not. `/p2o resume` never refuses because a budget ran out.
4. **No finish gate.** `p2o_finish` keeps its existing refusals only (queued intents, campaign frame); preflight stays
   advisory.
5. **No invented work.** A demand may only name obligations the host already derives (`deriveCompletion`,
   `chainObligations`, research debt, planned goal proof); the engine never writes target prose.
6. **The ledger is the campaign's memory.** A fresh session must be reconstructible from committed records plus the
   graph; the briefing is a projection, never a second store.
7. **One round, one reservation, one session.** No overlapping planner turns; a session switch happens only while
   idle and only for a valid reserved wake.
8. **Prompt budget is paid.** New static prompt lines are offset by removing duplication; a ceiling changes only with
   a dated comment naming the capability that grew. Runtime-injected texts (briefing, wrap-up, nudge) have their own
   byte caps and are not part of the pinned prompt.
9. **A failed optimization degrades to today's loop.** If session switching, model setting or the budget cannot run
   (mode, auth, platform), the run falls back to the in-session wake path and records the fallback.

---

## 5. Decisions (D44–D52, proposed)

Each was asked in chat with its recommended form; the answers are recorded in Appendix A (2026-10-28) and this table
carries the resulting form. D44 amends a recorded allowance decision and D48 deletes a mode, so both carry their cost in
§9; each decision is isolated behind one workstream so a later reversal stays local.

| ID | Decision | Recommended form | Why |
| --- | --- | --- | --- |
| D44 | **Round budget exists, campaign stays uncapped.** A round is bounded by assistant steps (`roundSteps`, default 40), wall clock (`roundSeconds`, default 900) and context percentage (wrap at 80 %, hard at 92 %). The bound is recorded on the round and never on the run; `/p2o resume` and the report do not treat it as an allowance. Applies to every round, because there is only one loop mode (D48). `--round-steps 0 --round-seconds 0` restores unbounded rounds. Settings under `p2o.plannerRound`. | Amend the recorded "no round allowance" decision: it protected the campaign, and that protection is kept; a round is a work package, not the engagement. |
| D45 | **Rounds are sessions.** Each round starts a fresh Pi session: `p2o-round` internal command → `validWake` → `newSession` → `withSession` rebinds `run.ctx` and sends the briefing with `triggerTurn`. The planner system-prompt section is rebuilt by `before_agent_start` in the new session. Session name `p2o <runId> round N`. The dispatch is guarded: only when the engine holds a valid reservation and `ctx.isIdle()`, never while streaming; a cancelled/failed switch falls back to today's in-session wake and records `planner.round-session-fallback`. `roundSessions` is a setting so the whole route can be turned off. | Fresh context per round is the single measured defence against Context Rot, and it is what makes the briefing (not the transcript) the unit of continuity; the fallback keeps a failed experiment from costing a round. |
| D46 | **The round briefing is deterministic.** `src/round-brief.ts` builds a bounded (≤ 8 KiB) projection from ledger + graph: campaign frame, objective and constraints, completion line and named demand, goals and proof status, ready chain steps, unchained primitives, coverage gaps and route monoculture hint, unreviewed tasks/claims/cases, worker states, round delta since the last round, research debt, revisit conditions, and the round's model/budget. No model call, no second store, no authority. Old material is folded into a per-round digest (cold-digest analogue) rather than truncated silently. | The 90 %-vs-50 % evidence says accurate context is the largest fixable yield loss; a deterministic projection is testable and cannot hallucinate. |
| D47 | **Wrap-up phase and classified hard stop.** At `roundSteps − wrapSteps` (default 6) steps, or `roundSeconds × 0.9`, or 80 % context: inject a wrap-up directive via the `context` hook and switch to a closing loadout (read board/ledger, author write-back, `p2o_loop`; dispatch removed). At the hard bound: record `planner.round-budget`, set a flag, `ctx.abort()`; `agent_before_settle` classifies an aborted outcome under this flag as `round-budget` (never a pause), consumes the reservation, and lets the next wake start a new round. The next brief names the unfinished obligations. Compaction is only triggered between rounds (`ctx.compact()` aborts the current run by design); inside a round the only context lever is the closing loadout and the round bound. | ARTEX's settlement 10 turns is the proven shape; Pi cannot grant post-abort turns, so write-back must be *inside* the round and the stop must be classified rather than treated as a provider abort. |
| D48 | **One loop mode, and a demand floor in it.** Owner decision 2026-10-28 (custom, stricter than the recommendation): the `manual` loop mode is **removed**. No `--loop` choice, no `loopMode` setting, no manual-only engine branch, prompt branch, help line or test path: every run is the consented automatic loop. `--loop` is still parsed only so an old script gets a clear refusal/`event-driven` no-op; a resumed run stored with `loopMode: manual` maps to the automatic loop and records one lifecycle warning. A start without a worker backend is refused before the run exists (today's `DELEGATION_UNAVAILABLE` path becomes the only path) instead of starting a run that can never execute. The engine keeps the demand floor: while `remaining > 0` (completion obligations, unchained primitives, ready chain steps, gateable debt) it never pauses for quiet; it demands by name. `p2o_loop wait` records a demand signature; the debt wake is suppressed only while that signature is unchanged, and re-arms when a new obligation appears. | With rounds-as-sessions there is no second loop to maintain; deleting it removes a branch from the engine, the prompts, the settings, the CLI, the docs and the tests, and removes the half-configured state where a run starts without a worker backend. Cost, stated in §9.2: pi-p2o can no longer run without Herdr. |
| D49 | **Bounded continuation and coalescing.** Burst debounce 800 ms (fixed window, no periodic polling); a text-only round ending with demand and no `blocked` declaration gets a nudge at settlement, at most 2 per round. The nudge must be a `custom_message` boundary draft plus `continue:true` (a bare `continue` is refused by Pi unless the projected context ends non-assistant); Pi's settle loop is otherwise unbounded, so the counter lives in the extension and is recorded. Revisit and heartbeat semantics unchanged. | Cheapest two fixes from the peer review; each is testable with fake timers and a fake settle event. |
| D50 | **Per-round model and thinking routing.** Before the round turn: resolve the configured round model via `ctx.modelRegistry` and `pi.setModel`/`setThinkingLevel`; record `planner.round-model`. Default rule: base model for rounds whose demand is review/mapping/validation; escalation model for rounds whose demand is exploitation/chaining, or after two consecutive rounds that closed nothing, or when the round's brief carries an unchained primitive or ready chain step. A fresh session has no cache to lose and `setModel` appends a recorded `model_change` entry, so round-level switching is cheap; per-request escalation *inside* a round, if it is ever needed, uses `registerVirtualModel().route()` instead of a second session entry. No auth/model → keep current model, record `planner.round-model-fallback`. Operator stop path gets one closing round (§P18.7); no campaign deadline. | Alloy's routing result (68.8 % vs 57.5 %) is the best-evidenced lever after context; recording the choice keeps it honest and auditable. |
| D51 | **Instrumentation without migration.** New lifecycle records only (`lifecycle` with `data.engine.event`): `planner.round-start`, `planner.round-end`, `planner.round-budget`, `planner.round-nudge`, `planner.round-session`, `planner.round-model`, `planner.round-session-fallback`, `planner.round-fallback`. `src/authority.ts` counts them for `/p2o status` and report provenance. No schema bump, no new `EVENT_KINDS`, no new DB column. | The report must be able to say how many rounds ran, how many hit a budget and which model ran them, without a migration. |
| D52 | **Measurement is a separate, owner-authorized step.** The bench runner gains a multi-round, event-driven arm; P18 ships an A/B protocol (single-session vs rounds-as-sessions; 2 fixtures × 2 variants × 2 arms × 3 reps = 24 runs) and does **not** run it. Effectiveness of P18 stays UNVERIFIED until that campaign. | P17's rule stands: hermetic tests decide correctness, a clean owner-authorized campaign decides penetration effectiveness. |

---

## 6. Workstreams

Each names its decision, exact seams, hermetic gate and the measured criterion it feeds. Workstream P18.1 must land
before P18.2/P18.3 can be exercised end to end; P18.0 and P18.4 are independent. P18.0 also lands D48's code half: the
loop-mode removal and the start refusal without a worker backend.

### P18.0 — Round lifecycle in the engine (D44, D49, D51)

- `src/engine.ts`: add `roundBudget` to `EngineDeps` (read lazily like `heartbeatSeconds`) and a `RoundBudget` type
  (`steps`, `seconds`, `wrapSteps`, `contextWrapPercent`, `contextHardPercent`); add `roundStartedAt`/`budget` to
  `snapshot()`; add `reserveWake`/`fireHeartbeat` demand-signature comparison (D48 lives here too); change the
  constructor debounce default from 100 ms to 800 ms and pass it explicitly from `extensions/p2o/index.ts:3352`.
  Keep `QUIET_ROUNDS`, `stallStreak`, revisit and heartbeat semantics intact.
- New `src/round-budget.ts` (pure): `judgeRound({steps, startedAt, contextPercent, budget})` →
  `{state:'open'|'wrap'|'exhausted', reason}`; `demandSignature(demand)`; both tested with a matrix of boundaries.
- `src/state/schema.ts`: **no change**; records ride the existing `lifecycle` kind through `deps.persist`.
- D48 code half: `src/roles.ts` drops `LoopMode`/`loopMode` from `P2OSettings` and `blank()`; `src/target.ts:128` stops
  accepting `manual` (`--loop event-driven` is a recorded no-op, `--loop manual` is refused with the removal reason);
  `src/prompts.ts` drops the `loopMode` fact and the manual branch (`:66,159-160`) — a net prompt saving; the engine
  keeps one internal mode constant so `snapshot()`/consumers do not churn; `extensions/p2o/index.ts` drops the
  `loopMode` resolution (`:3233`), turns `:3245` into the start refusal when no worker backend is available, deletes
  the manual-report UI branch (`:3549-3552`) and the `--loop` help lines (`:114,2998`); `/p2o open`/resume maps a
  stored `loopMode: manual` profile to the automatic loop and records one lifecycle warning.
- Gate: `tests/minimal/engine.test.ts` (new budget/demand cases; existing pins still pass — the "no automatic wake
  ceiling" test must be re-read as "no campaign ceiling"; the manual-storm test moves to the removed-mode suite), new
  `tests/minimal/round-budget.test.ts`, new `tests/minimal/loop-mode-removed.test.ts` (start refuses without a backend,
  `--loop manual` refused, resume mapping recorded, no manual prompt branch remains).
- Measured: rounds per audit row; budget-hit rate.

### P18.1 — Rounds as fresh sessions (D45, D51)

- `extensions/p2o/index.ts`: register an internal `p2o-round` command (registered but hidden from `/help`; description
  says internal). Handler: `validWake(parse args)` → `current.ctx.isIdle()` and no `roundSwitchInFlight` → record
  `planner.round-start`/`planner.round-session` → `ctx.newSession({ setup: seed session name, withSession: async
  replaced => { rebind run.ctx; record session id; replaced.sendMessage(briefing, {triggerTurn:true}); } })` → on
  `{cancelled:true}` or throw, fall back to `pi.sendUserMessage(plannerWakePrompt(wake))` in the current session and
  record `planner.round-session-fallback`. Never dispatch while streaming (`sendUserMessage` throws without
  `deliverAs`) and never while operator messages are pending (deliver them first, then let the next wake switch).
- `wake` dep (`extensions/p2o/index.ts:3359-3366`): in event-driven mode with `roundSessions` on, dispatch
  `pi.sendUserMessage('/p2o-round ' + JSON.stringify(wake), {expandPromptTemplates:true})`; otherwise keep today's
  followUp wake. A wake delivered from `agent_before_settle` stays a `continue` `custom_message` draft (no nested
  command dispatch, and the draft is what makes the continuation acceptable to Pi).
- `session_before_switch`/`session_before_fork` handlers (`:3759-3769`): allow an internal round switch while
  `roundSwitchInFlight` is set (and rebind `run.ctx` inside `withSession`); any operator switch/fork during an active
  run keeps today's stop + cleanup behavior. Add a `ctx` staleness guard: no captured old ctx after a switch.
- `src/planner-bridge.ts`: add `roundBriefPrompt(briefing)` / `parseRoundBrief`; keep the wake marker path for the
  fallback so `before_agent_start` and the stale-wake abort at `:3674-3681` keep working.
- Gate: `tests/minimal/helpers/fake-pi.ts` gains `newSession`/`withSession` doubles, a command-dispatching
  `sendUserMessage` (`expandPromptTemplates`), `getContextUsage`, `compact`, `setModel`/`setThinkingLevel` and
  boundary-draft handling for `continue`; new `tests/minimal/round-session.test.ts` (switch allowed while idle, wake
  validated, streaming/pending-message guards, fallback path, stale-ctx refusal, no double dispatch, operator switch
  still stops). Existing extension tests unchanged. Opt-in real-Pi test: one scripted-provider run (existing real-Pi
  harness) proving the round command produces a second session and a planner turn; this test is the gate for keeping
  `roundSessions` on by default.
- Measured: session count per run; fallback rate.

### P18.2 — Round briefing and digest (D46)

- New `src/round-brief.ts` (pure, no I/O): `buildRoundBrief(input)` with the sections in D46, each with a byte cap and
  a truncation marker; `buildRoundDigest(records, since)` for material older than the last N rounds. Reuse
  `deriveCompletion`, `completionDemand`, `chainObligations`, `planFrontier`, `taskFrontier`, `runDebt`,
  `routeMonoculture`, `situation.ts` — do not re-derive rules.
- `extensions/p2o/index.ts`: the briefing is attached by the round command from the same `roundProgress` read path
  (`:470-496`), so engine progress and brief cannot disagree. Cap ≤ 8 KiB, tested. It is a **user message**, not a
  system prompt mutation, so `before_agent_start` still owns policy.
- Gate: new `tests/minimal/round-brief.test.ts` (golden sections on a fixture ledger; empty-ledger case; byte caps;
  no target prose invented; `remaining` agrees with `deriveCompletion`); `tests/minimal/context-budget.test.ts`
  unchanged.
- Measured: first-action latency per round; duplicate tasks per round.

### P18.3 — Wrap-up and classified stop (D47)

- `extensions/p2o/index.ts`: a per-round `RoundState` (`steps`, `startedAt`, `nudges`, `wrapSent`, `budgetAbort`).
  Step increment in `message_end` (owner role only). Trigger in the `context` hook: inject a `p2o_round_directive`
  custom message (not persisted as authority) when `judgeRound` says `wrap`, and call `pi.setActiveTools(CLOSING_TOOLS)`
  where `CLOSING_TOOLS` = planner tools minus `p2o_task_dispatch` and `p2o_task_author` (authoring write-back stays
  possible). At `exhausted`: record `planner.round-budget`, set `budgetAbort`, `ctx.abort()`.
- `agent_before_settle` (`:3748-3751`): branch order — budgetAbort first (record `planner.round-end` with reason
  `round-budget`, consume the reservation with the current progress via `engine.consume(wake.through, progress)`,
  **do not pause**, return undefined); then today's `outcome !== 'completed'` pause; then the boundary continuation.
  After settle, `engine.settled()` → kick → the demand wake opens the next round (session).
- `src/prompts.ts`: ≤ 6 new static lines (one wrap-up line, one "a round is a work package" line) paid by dedupe;
  ceilings may move only with a dated comment in `tests/minimal/recon.test.ts`.
- Gate: new `tests/minimal/round-wrapup.test.ts` (wrap at each boundary, closing loadout, abort classified as
  round-budget, no pause, reservation consumed once, `planner.round-end` recorded); `tests/minimal/authority.test.ts`
  extended for the new counters; prompt ceilings updated with the dated comment.
- Measured: budget-hit rounds that recorded write-back; rounds ending without a `p2o_loop` action.

### P18.4 — Demand floor, wait semantics, coalescing (D48, D49)

- `src/engine.ts`: with one mode, delete the `this.mode !== 'event-driven'` guards in `armHeartbeat`/`reserveWake` and
  the manual branch in `stallRound` (`:266`); `reserveWake` keeps the quiet+owed demand branch and pauses for quiet only
  when nothing is owed (the completion reason text names the completion); the debt-wake suppression compares
  `demandSignature` recorded by `disposition('wait')` (store on the decision) instead of suppressing unconditionally;
  quiet streak no longer prevents a debt wake while owed (it already carries the demand text).
- `extensions/p2o/index.ts` `p2o_loop` (`:2770-2819`): `action=wait` with a non-empty current demand and no
  `blocked` declaration → return `terminate:false` with the demand and the two legal next actions (dispatch, declare
  blocked) **once per round** (nudge counter); a second wait is accepted and the round ends with `planner.stalled`
  recorded by the existing settle path. `action=blocked` unchanged (pauses).
- Nudge (D49): a `stopReason==='stop'` ending with demand and no `p2o_loop` call → `agent_before_settle` returns
  `{entries:[{type:'custom_message', content:<demand>}], continue:true}` (a bare `continue` is refused by Pi), max 2
  per round, recorded as `planner.round-nudge`; after that the round settles and the stall fact is recorded as today.
- Gate: `tests/minimal/engine.test.ts` (demand re-arm after a new obligation; wait no longer suppresses a changed
  demand; complete run still pauses), `tests/minimal/loop-actions.test.ts` (wait refusal once, second wait accepted,
  blocked unchanged), nudge tests with fake timers and fake settle events.
- Measured: quiet rounds with owed work; runs that pause while `remaining > 0`.

### P18.5 — Wake dispatch and operator visibility (D45, D51)

- `/p2o status` and `/p2o state` (`src/ui/state.ts`, `src/ui/dashboard.ts`): print round number, current round session
  id, budget state, model, last nudge/budget fact; keep the existing executor/queue lines.
- `docs/PLANNER_ENGINE.md`: rewrite "Controls and defaults" (no `--loop`, no manual default; a start needs a worker
  backend) and "Rounds: quiet, stalled, woken" for rounds-as-sessions, round budgets, the demand floor and the
  classified stop; each round is a bounded work package while the campaign is uncapped. `docs/ARCHITECTURE.md` bounds
  table: add the round budget rows. `docs/USAGE.md`: `p2o.plannerRound`, `p2o.plannerModels`, and the removal of
  `loopMode`. `docs/HISTORY.md`: amend the recorded "no round allowance" decision (round is bounded, campaign is not)
  and record the manual-mode removal.
- Gate: `tests/minimal/help-commands.test.ts`, `context-runtime.test.ts` (state rendering), docs parity checks.
- Measured: operator-visible round count in the report provenance.

### P18.6 — Model routing (D50)

- `src/roles.ts`: `plannerModels` setting (`{base?: string, escalate?: string, thinkingBase?, thinkingEscalate?}`),
  parsed defensively like role settings; validate against `allowedWorkerModels`-style catalogue plus the current
  model id.
- `extensions/p2o/index.ts`: a `routeRound(brief)` pure function in `src/round-model.ts` returns
  `{modelId, thinking, reason}` from the brief's demand; the round command resolves it via `ctx.modelRegistry` and
  calls `pi.setModel`/`setThinkingLevel` **before** sending the briefing; `false` → keep current model, record
  fallback.
- Gate: `tests/minimal/round-model.test.ts` (rule table, escalation trigger, fallback), extension test that
  `setModel` is called with the resolved model and recorded; docs.
- Measured (campaign only): cost per closed obligation by model; share of escalation rounds that closed something.

### P18.7 — Operator stop path: one closing round (D50-adjacent, from ARTEX §2.1)

- `/p2o stop` (`extensions/p2o/index.ts:3180-3186`): if an active round is in flight, do not kill it: set
  `engine.pause('operator stop')`, wait for the current round to settle (≤ 30 s; then today's hard stop), record
  `planner.round-end reason=operator-stop` and drain worker reports for ≤ 90 s before cleanup. No new campaign timer.
- Gate: extension stop tests (in-flight round settles, drain bounded, cleanup verified, no authority restored),
  existing `shutdown` tests unchanged.
- Measured: evidence records preserved across stop (count of reports committed after the stop request).

### P18.8 — Measurement support and protocol (D52)

- `scripts/benchmark-skills.mjs`: a live run now needs a worker backend, so the runner requires Herdr
  (`HERDR_ENV=1` + server status) and passes `--workers` in the composed prompt (today it deliberately omits them,
  `:564`); it waits for campaign end/pause instead of the first assistant stop and records round count and
  round-budget facts from the ledger. The old non-delegating single-prompt path can no longer start an assessment
  (D48); it is kept only as a unit-test double, and the P17 24-run protocol is recorded as superseded rather than
  silently re-run.
- `bench/README.md`: P18 protocol — A/B rounds-as-sessions on/off, multi-round event-driven arm, same fixtures as P17
  (2 fixtures × 2 variants × 2 arms × 3 reps = 24 runs), budgets: 60 min / 200 assistant turns / 240 target operations
  per run, cost cap set by the owner; seeded order; no fallback. Status: **ready, not run**.
- Gate: `tests/minimal/benchmark.test.ts` (prompt composition, fixture isolation, truth isolation), scoring unit tests.
- Measured: rounds per run, rungs reached, accepted-current high/critical, false-claim rate.

### P18.9 — Docs, matrix, migration (D51)

- `docs/HISTORY.md`: new milestone row recording P18 and the amended round-budget decision.
- `docs/ACCEPTANCE_MATRIX.md`: rows for rounds-as-sessions, round budget/wrap-up, demand floor, routing.
- `README.md` / `HANDOFFS.md`: one line each where they describe loop behaviour.
- `tests/minimal/truth.test.ts` retired-phrase scan: no stale "no round budget" sentence may survive in docs/prompts.
- Gate: full suite, `check:library` unaffected, `git diff --check`, GitNexus `detect-changes` before any commit.

---

## 7. Phases

| Phase | Scope | Hermetic gate | Measured criterion |
| --- | --- | --- | --- |
| P18.0 | round budget + demand signature in the engine; debounce 800 ms; **manual loop mode removed** (settings/CLI/prompt/engine branches, start refusal) | engine/round-budget/loop-mode-removed tests; existing pins | rounds; budget-hit rate |
| P18.1 | `p2o-round` command + fresh session + fallback | round-session tests; opt-in real-Pi smoke | sessions per run; fallback rate |
| P18.2 | deterministic briefing + digest | round-brief tests; context-budget unchanged | duplicate tasks per round; first-action latency |
| P18.3 | wrap-up + closing loadout + classified stop | round-wrapup tests; authority counters; prompt ceiling comment | rounds that wrote back before ending |
| P18.4 | single-mode demand floor + wait semantics + nudge | engine/loop-actions tests | quiet rounds with owed work |
| P18.5 | status/state/docs | context-runtime; help; docs parity | report provenance round count |
| P18.6 | per-round routing | round-model tests; extension routing test | cost per closed obligation (campaign only) |
| P18.7 | operator stop closing round | stop/shutdown tests | reports preserved across stop |
| P18.8 | bench support + protocol | benchmark/scoring tests | the 24-run campaign (owner) |
| P18.9 | docs/matrix/history | full suite; retired-phrase scan | — |

P18.1 must precede P18.2/P18.3 end-to-end; P18.0 and P18.4 are independent; P18.6 needs P18.2's brief; P18.8 needs
P18.1–P18.4. Every phase's gate also includes `npm run typecheck`, `npm run build`, `npm run check:build`, full
`npx vitest run`, `npm run check:library`, `git diff --check`, and GitNexus `detect-changes --scope all` before any
commit.

---

## 8. Migrations and compatibility

| Surface | Change | Compatibility |
| --- | --- | --- |
| Loop mode | `manual` is removed (D48): no `--loop` choice, no `loopMode` setting, no manual prompt/engine branch; every run is the automatic loop; rounds are sessions | A start without Herdr is refused before a run exists (the same message the old event-driven rejection used); a stored `loopMode: manual` profile resumes as the automatic loop with one lifecycle warning; `--loop manual` gets the removal reason instead of silently changing behaviour |
| Herdr requirement | the extension no longer has a Herdr-free operating mode | Operators without Herdr can no longer run an assessment; this is stated in the start refusal, USAGE and PLANNER_ENGINE. Tests, scripts and bench that relied on a manual run now provide a worker-backend double or run inside Herdr |
| Round budget | new operator settings/flags; `0` restores unbounded rounds; defaults bounded for automatic rounds only | Existing runs read settings at start; no stored data changes; a resumed run uses the new defaults unless the operator narrows them |
| Prompt text | ≤ 6 new static planner lines; the rest is runtime-injected | Ceilings move only with the dated comment; runtime texts have their own byte caps |
| Engine API | `roundBudget` dep, demand signature, `judgeRound`, new snapshot fields | `EngineDeps` additions are optional so a test double that omits them behaves like today |
| Records | new `lifecycle` events only | No schema version bump, no new `EVENT_KINDS`, no column; old builds ignore unknown `data.engine.event` |
| Sessions | one Pi session file per automatic round | Operator-visible session list gains round sessions; ledger/report unchanged; session-name prefix identifies them |
| `p2o_loop wait` | may be refused once per round while demand is owed | Still returns `terminate:true` when accepted; the refusal names the two legal next calls, so no planner can be trapped |
| Stop path | waits for the in-flight round and drains worker reports before cleanup | Bounded (30 s + 90 s); `shutdown` keeps the hard path; cleanup verification unchanged |
| Docs | PLANNER_ENGINE/ARCHITECTURE/USAGE/HISTORY/ACCEPTANCE_MATRIX updated | `truth.test.ts` keeps retired phrases out |

---

## 9. Risks, non-goals, metrics

### 9.1 Risks

| Risk | Mitigation |
| --- | --- |
| Session churn fragments the operator's transcript | Name every round session `p2o <runId> round N`; `/p2o status` lists rounds; the report and ledger remain the single narrative |
| A fresh session loses something the transcript held | The briefing is generated from the same rules the board/report use and is tested against `deriveCompletion`; nothing may exist only in the transcript (invariant 6) |
| `newSession` cancels or is unavailable (mode, platform) | Fallback to today's in-session wake is first-class, recorded as `planner.round-session-fallback`; no wake is lost |
| The command route is a re-entrant, undocumented use: a timer dispatches a command that replaces the session mid-idle | Gate it behind `roundSessions` + the opt-in real-Pi scripted test; guards `isIdle()`/no pending messages/`roundSwitchInFlight`; a failed switch falls back to the in-session wake. If the real-Pi gate fails, P18 ships the in-session fallback plus forced compaction bands and records the external `pi --mode json -p --no-session` per-round process as the next architecture (§2.4) |
| Budget converts "refuse to stop" into "stop early" | Wrap-up forces write-back; the next brief names unfinished obligations; the campaign is uncapped and the demand floor re-arms the next round; D43's criteria stay the arbiter |
| Classified abort masks a real provider failure | The classification is a flag set only by the extension's own budget path in the same round; any other aborted outcome still pauses |
| Model routing raises cost or breaks an account | Routing is opt-in config; `setModel` returning `false` keeps the current model and records the fallback; campaigns pin model/thinking |
| Removing manual mode removes the only Herdr-free path | This is the owner decision, not a side effect: the start refusal names the backend requirement, USAGE/PLANNER_ENGINE/README state it, and the bench runner refuses with the same message instead of producing an unrunnable campaign. If a Herdr-free mode is wanted later it comes back as a headless worker backend (P19), not as a second loop semantics |
| The P17 24-run protocol becomes unrunnable (it ran with `delegation:false`) | Recorded as superseded in bench/README; the fixtures and scoring stay, and every live arm now requires Herdr. No result from the old protocol is compared with a P18 result |
| Prompt bloat | New static lines are paid by dedupe; ceilings pinned; runtime texts have byte caps and their own tests |
| Stale extension context after a switch | All post-switch work happens inside `withSession`; a stale-ctx guard refuses anything captured before the switch |
| New per-round bound re-creates the very churn it fights | One run per round, one reservation, no retry inside a round; a stuck round ends and the next one starts with a different demand, not a longer thread |
| Owner decisions in §5 are answered differently | Each decision is isolated in one workstream; the plan states where an alternative answer lands, and no phase depends on more than one |

### 9.2 Non-goals and named follow-ups

- **No provider-failure recovery, no worker liveness watchdog** (both are the earlier option A): a provider error
  still pauses, and a silent worker still holds its slot. P18 must not be read as fixing them. P19 is the intended
  pass.
- No finish gate, no campaign deadline, no token/spend ceiling.
- No manual loop mode and no Herdr-free mode: P18 removes the first and does not replace the second (owner decision A11).
- No new permission, tool, role, skill, effect class or target kind; no authority text change.
- No model fine-tuning; no cross-run negative memory (separate item).
- No binary/AD/cloud-takeover scope; no real-target campaign without owner authorization.
- No claim that rounds-as-sessions raises yield; D52 measures that.

### 9.3 Metrics to add (reported, never scored as a gate)

| Metric | Source |
| --- | --- |
| Rounds per run; rounds per obligation closed | `planner.round-start/end` lifecycle rows |
| Rounds that hit steps / seconds / context budgets | `planner.round-budget` rows |
| Rounds that wrote back anything before ending | `planner.round-end` + ledger delta |
| Nudges per round; stalled rounds with demand | `planner.round-nudge`, `planner.stalled` |
| Session switches and fallbacks | `planner.round-session`, `-session-fallback` |
| Model per round; escalation rounds that closed something | `planner.round-model` + closure rows |
| Quiet rounds with owed work (must trend to 0) | engine snapshot at wake + `planner.wake` rows |
| Cost per closed obligation (campaign only) | usage receipts + closures |

---

## Appendix A — owner decisions (recorded 2026-10-28)

Asked in chat with the recommended form and alternatives; the owner answered before implementation. One answer is
deliberately stricter than the recommendation and changes the plan as noted.

| # | Question | Owner decision | Effect on the plan |
| --- | --- | --- | --- |
| A9 | Round budget vs "no round allowance" | **Yes — a round is a bounded work package by default (40 steps / 900 s / wrap at 80 % context); the campaign stays uncapped** | D44/P18.0/P18.3 as written; `--round-steps 0 --round-seconds 0` still restores unbounded rounds |
| A10 | Session switch route | **(a) internal command + `newSession`**, with the re-entrancy risk accepted behind `roundSessions`, the guards and the real-Pi scripted gate | D45/P18.1 as written; the in-session fallback (b) and external `pi --mode json` (c) stay documented as the fallbacks if the gate fails |
| A11 | Manual loop mode | **Remove it entirely** (custom, stricter than "refuse wait once + nudge") | D48/P18.0/P18.4/P18.5 rewritten: no `--loop`, no `loopMode` setting, no manual prompt/engine branch; a start without Herdr is refused; a resumed `manual` run maps to the automatic loop with a warning; the P17 bench protocol is superseded; the Herdr-free path is gone (recorded cost) |
| A12 | Model routing default | **Opt-in config, same model by default** | D50/P18.6 as written; escalation only when `p2o.plannerModels` is configured |
| A13 | Measurement in this phase | **Ship fixtures + the 24-run protocol, do not run it** | D52/P18.8 as written; effectiveness stays UNVERIFIED until the owner authorizes the campaign and its cost cap |

## Appendix B — how to re-verify this proposal

```sh
git show bacbb6d:planning_update.md                   # the P17 record this file replaces
npx vitest run tests/minimal/engine.test.ts            # demand floor + no campaign ceiling
npx vitest run tests/minimal/round-budget.test.ts tests/minimal/round-brief.test.ts
npx vitest run tests/minimal/round-session.test.ts tests/minimal/round-wrapup.test.ts
npx vitest run tests/minimal/loop-mode-removed.test.ts                  # D48: no manual mode, start needs a backend
npx vitest run tests/minimal/recon.test.ts tests/minimal/context-budget.test.ts   # prompt/declaration budgets
npm run check:library
npx vitest run                                        # full hermetic gate
```

Pi SDK capability claims re-verify against the installed 1.1.0:

```sh
grep -n "newSession" node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
grep -n "Extension command executed" node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
grep -n "setModel(model" node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
grep -n "requested continuation without runnable model context" node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
grep -n "registerVirtualModel" node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
```

Measured gate (owner-authorized, not run by this proposal): `node scripts/benchmark-skills.mjs prepare`, then the P18
protocol with pinned model/thinking, cost cap and seeded order; read rounds, rungs and accepted-current high/critical
from the ledger, never from the narrative.

## Appendix C — what this proposal does not claim

- It does not claim a fresh session per round finds more bugs. It claims the transcript stops being the campaign's
  memory, which is the measured Context Rot seam; D52 decides whether it helps.
- It does not claim ARTEX or Strix is better than pi-p2o; both have weaker evidence models (self-attested findings,
  no dedup, unvalidated severity). The comparison is a mechanism floor.
- It does not claim a round budget improves yield; it claims it makes a round finishable and write-back forced, which
  is a precondition for running many of them.
- It does not claim model routing raises yield in this harness; the 68.8 % figure is XBOW's, not ours.
- It does not fix provider failure, worker death, or cross-run memory; those are P19.
- It does not claim the campaign was measured; effectiveness stays UNVERIFIED until the owner runs D52.
- It does not claim pi-p2o still runs without Herdr: with the manual mode removed, a worker backend is a precondition
  for starting a run, and the plan does not add a headless one (P19 candidate).

## Appendix D — sources

- P17 record — `git show bacbb6d:planning_update.md`; implementation `431b916`, `0eeda8a`, `aaa8ed0`, `bacbb6d`
- ARTEX — https://github.com/Autumn-27/ARTEX (local snapshot `my_references/ARTEX/`, v0.3.15; planner loop
  `agent/planner.go`, wrap-up `agent/wrapup.go`, deadlines `agent/taskclock.go`, terminal states
  `server/engine.go`, pool `llmpool/`)
- Strix — https://github.com/usestrix/strix (local snapshot `my_references/strix/`; `strix/core/execution.py`,
  `core/hooks.py`, `llm/compaction.py`, `tools/reporting/tool.py`)
- Pi SDK — `@earendil-works/pi-coding-agent` 1.1.0, `dist/core/extensions/types.d.ts`,
  `dist/core/agent-session.js`, `dist/core/agent-session-runtime.js` (read in-repo, §2.4)
- CyberGym — https://arxiv.org/abs/2506.02548
- Naptime — https://projectzero.google/2024/06/project-naptime.html ; Big Sleep —
  https://projectzero.google/2024/10/big-sleep.html
- AXE — https://arxiv.org/abs/2602.14345
- AutoPenBench — https://aclanthology.org/2025.emnlp-industry.114/
- XBOW 1,060 attacks — https://xbow.com/blog/we-ran-1060-autonomous-attacks ; alloy —
  https://xbow.com/blog/alloy-agents ; HackerOne #1 — https://xbow.com/blog/top-1-how-xbow-did-it
- DARPA AIxCC — https://www.darpa.mil/news/2025/aixcc-results
- Anthropic cyber ranges — https://www.anthropic.com/research/cyber-toolkits-update
- Refusal study — https://arxiv.org/abs/2606.02644
- Context Rot — https://www.trychroma.com/research/context-rot
- Decoupling recon/exploitation — https://arxiv.org/abs/2606.25332
- Agentic architectures for offensive security — https://arxiv.org/abs/2604.18718
- Anthropic Agent Skills — https://www.anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills
