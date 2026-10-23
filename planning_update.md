# planning_update.md — duty clarity, real-bug evidence, and graph-driven chaining

Status: **planning only. No code changed in this pass.** Written 2026-10-22; the live plan is Parts 1–6.
The 2026-10-21 pass is retired: its Q1/Q2 duty-sentence idea is subsumed by P1 here, its Q3 text-only composition note was
replaced by the `chain` payload plus P5/P9, and its Q4 question is answered. Its S3/P3/P4 items survive in §6, and its full
text is archived at `tmp/planning_update-2026-10-21-appendix.md`. That pass also assumed a boundary this project no longer
has: p2o now builds, records and rates chains (`Candidate.provides`/`requires`, `CaseFinding.chain`, chain rendering in
reports, rewritten `exploitability-assessment` and `HANDOFFS.md` H4).

**The prompt that started this pass:** the project is clueless about each agent's duty in the current workflow. It should
find real bugs, including ones that are hard to analyse, and once one is found it should know how to validate it and how to
take the exploit. Look at how ARTEX designs its prompts, its skills, its vulnerability/asset graph, how it links findings
together, how it ranks criticality deterministically, and what its skill equivalent is. Then propose the update.

---

## 1. Analysis — where the workflow is actually blind

### 1.1 What the workflow is, in the code

PLANNER = the live Pi conversation (plans, reviews, dispatches, decides wait|blocked|finish); ENGINE = deterministic TS,
no model (accepted frontier → slot → fresh worker); WORKER = fresh Pi process in a Herdr pane with one bounded intent
(`docs/ARCHITECTURE.md`). The owner prompt section is rebuilt on every turn from `OwnerPromptFacts`
(`extensions/p2o/index.ts:1753-1765`), and the worker prompt is a static body plus a per-ticket brief
(`src/prompts.ts:93-142`). Authority is enforced by loadouts (`src/tool-policy.ts`), not by prose.

So p2o is not missing machinery. It is missing **the words that make the machinery legible to the model**: a duty per
purpose, the situation between rounds, and a way to read the graph back. The evidence below is all of that shape.

### 1.2 Duty is nowhere in the prompt (the actual "clueless")

- E1. The only role text a worker ever sees is the last line: `Identity: you are ${workerId} (role ${ticket.role}, …)`
  (`src/prompts.ts:110`), and `role` is a bare enum (`src/roles.ts:6`). `workerInstructions` branches only on
  `role === 'reporting'` (`src/prompts.ts:100-101,104`), so a `recon` and a `discovery` worker receive **byte-identical**
  instructions; only their default skill differs (`src/roles.ts:17-23`).
- E2. The lead is told the same nothing. `p2o_delegate`'s description (`extensions/p2o/index.ts:1211`) never says what
  recon, discovery or validation are for, so role choice is inferred from a free-text `focus` (≤60 chars).
- E3. The precise vocabulary already exists and is invisible. `WORK_PURPOSES` has seven values
  (`src/work.ts:8`): mapping, discovery, investigation, refinement, validation, retest, reporting. They feed the work
  fingerprint and duplicate detection (`docs/WORK_ADMISSION.md`) but appear in **no prompt and no tool description**. The
  host keys dedup on purpose+questionKey+methodFamily while the model only knows a 60-character focus string.
- E4. The rules the host enforces are never stated to the agent that must satisfy them: a validation task needs a
  different worker and a reviewed predecessor with the same question (`src/tasks.ts:187`), independence needs another
  worker's receipt, inferred policy cannot rate above medium (`src/cases.ts`), and `rate` is owner-only
  (`docs/CASE_REVIEW.md`). Agents learn these from rejected calls.

### 1.3 The chain dies between rounds

- E5. Every wake is four generic lines (`src/planner-bridge.ts:12-16`) with no state; the frontier, ready prerequisites,
  unmatched chain requirements and coverage exist only behind tool calls. ARTEX injects triggers, a graph overview and a
  persistent todo into **every** planner wake (`agent/planner.go:405`), which is why its chain survives between rounds.
- E6. `priority` is a lead-chosen integer 0-100 (`src/engine.ts:54-56,91`) with no rubric, so dispatch order is
  deterministic but arbitrary.
- E7. `Candidate.provides`/`requires` are recorded (`src/evidence.ts`) and never read back. Nothing computes which claim
  satisfies which open requirement, so a chain step is "ready" only if the lead remembers. `p2o_graph` relations are
  owner-written and no prompt line asks for them.

### 1.4 Real-bug finding has no stated standard of proof

- E8. The worker's reporting-discipline line asks for a closure state per candidate (`src/prompts.ts:106`), but nothing
  says what makes a claim worth making in the first place: which observation is a bug, which is a policy question, and
  which is a version match that must be marked `inferred`. ARTEX states this as a red line on `report_finding`
  ("严禁把版本/指纹匹配到 CVE、参数看起来可注入…当已确认"); p2o states the mechanical fields and leaves the judgement to the skill.
- E9. Discovery's default skill is a method card (`source-code-auditing`); the *pipeline* (surface → hypothesis →
  candidate → separate validation → case) is enforced in code and documented in `docs/CASE_REVIEW.md`, but is not in any
  prompt, so a discovery worker has no reason to produce a claim a validator can act on.

### 1.5 Ranking: one half is already deterministic

- E10. Severity is deterministic and better than ARTEX: CVSS 3.1 base score computed host-side from the owner's vector
  (`src/cvss.ts`), plus a required `basis`, plus the inferred-policy ceiling, plus `demonstratedThrough` bounding a chain's
  severity to the steps actually executed. ARTEX has no CVSS at all: severity is a free-text enum sorted by
  `report/report.go:46 sevRank`, and intent order is `ORDER BY priority DESC, id ASC` (`db/exploration.go:1136`).
  What p2o lacks is the **other** half: a stated derivation for priority, so triage order is explainable and repeatable.

---

## 2. What ARTEX actually does (and what to copy)

| Axis | ARTEX | p2o today | Verdict |
| --- | --- | --- | --- |
| Agent kinds | 6 seeded templates, one per kind (`agent/promptcatalog.go:113`), DB-overridable, code segments never seeded | 5 roles, one shared prompt, one `reporting` fork | copy the *idea* of a per-kind body, not the 6 forks |
| Duty sentence | worker: "唯一职责：完成这一条意图、把发现写回知识图谱、然后停止返回"; planner: "你是规划者、不是执行者…绝不在 plan 里把活干了" | none (E1) | **copy verbatim pattern — P1** |
| Where the task lives | intent in the **system** prompt so compaction cannot drop it (`agent/worker.go:416-460`) | brief's `TASK:` last, static body first | already safe; keep |
| Continuity | one `TodoStore` per task across wakes (`agent/planner.go:40-44`), rendered into each wake | plan board exists, never injected | **copy — P3** |
| Serial chains | "串行利用链：分步派，别拆成并行", dispatch only the step whose prerequisites are satisfied, ≤4 per call | prose line added in the chain pass; no cap | **extend — P6** |
| Anti-stall | hard floor: "产出 0 意图=任务停摆" | none | copy a soft version — P6 |
| Recombination | `add_intent parent_ids` records which facts produced a direction (`derived_from`) | `provides`/`requires` recorded, never joined (E7) | **copy as a deterministic join — P5** |
| Lineage gate | an intent may only list `fact`/`finding` parents, and an unparented intent is auto-linked to the origin (`agent/tools.go:1032-1090`), so "plans are evidence-driven" is a schema property you can query | `taskRefs`/`assetRefs` exist but nothing requires a task to cite the claim it builds on | **copy — P9** |
| Terminal states | `done` / `blocked` / `exhausted` / `stopped` / `paused` (`server/engine.go:1135-1145`), because "撞步数上限 ≠ 完成" | task statuses exist; "the worker ran out of budget" is not distinguishable from "this direction is covered" | **copy — P10** |
| Truncation honesty | every capped list is paired with a total (`frontier_open`, `findings_total`; `agent/tools.go:411-470`) so an empty window is not read as an empty board | list caps exist, no shown/total pair in any projection | **copy — P11** |
| Liveness | prose only: "产出 0 意图=任务停摆" — the engine never checks it, so a planner that ignores the paragraph idles | none | **assert in code — P6** |
| Skills | 3 skills, one meta-tool, listing capped 8000 chars, body injected as a separate guidance message so compaction re-injects it, selection by **role** from a DB table | 30 docs, two read tools, catalog with kinds/workflows, `workflow` validated against assigned skills | p2o ahead; missing purpose→skill binding — P7 |
| Assets | one global typed `assets` table + `task_scope` + `exploration_anchors`; coverage denominator in SQL (`db/task_scope.go:299-317`) | asset/assertion/relation graph with revisions and pinning, coverage cells with an explicit denominator | p2o ahead; keep |
| Severity | free-text enum + sort | CVSS 3.1 host-computed + basis + inferred ceiling + chain depth | p2o ahead; keep |
| Priority | LLM picks 5 by default, 9 for findings; sort is deterministic | LLM picks 0-100; sort is deterministic | both weak — P4 |
| Verification | `evidence_version` staleness, manual `finding_retests`, separate reporter agent | candidate closure enum, independent receipt, preflight gate, reviewer-owned `rate` | comparable; p2o ahead on independence |

**Copy:** the duty sentence per kind (P1), state injected into every wake (P3), the serial-chain dispatch rule with a
batch cap and an anti-stall floor (P6), and fact-recombination as an explicit edge (P5).

**Do not copy:** ARTEX's goal decomposer that forbids attack steps (`agent/goals.go`), its free-text severity without a
score, its prompt rule discouraging the untested-asset list, DB-editable prompt bodies (p2o's prompts are hashed
package bytes — reproducibility is worth more than runtime editing), its in-memory planner todo store (a restart loses the
chain — p2o's plan board is durable), its prose-only duplicate control (p2o's `duplicateOf` needs a shared policyKey +
rootCauseKey), and its two ID spaces for one finding (`finding_id` vs `finding_node_id`).

---

## 3. Proposal

Each item states what changes, where, why, and how it is verified. Effort is S (≤1 file of code + tests), M (2-4 files),
L (touches dispatch or schema).

### P1 — Purpose-keyed duty (S) — the core fix for E1/E2/E9

Add `src/duties.ts` exporting one record keyed by `WORK_PURPOSES`:

```ts
export const DUTIES: Record<WorkPurpose, { duty: string; forbids: string; produces: string }>
```

Draft text (one line each, ≤150 chars):

- mapping — "Map the reachable surface and its trust boundaries; produce assets, anchors and labelled unknowns, not
  vulnerability claims."
- discovery — "Turn one mapped surface into a falsifiable hypothesis and try to break it; produce candidates with closure,
  proof level and policy basis."
- investigation — "Given someone else's concrete anomaly, find the root cause and the smallest trigger; produce the fact
  plus the invariant it establishes."
- refinement — "Tighten a claim another worker left open or noisy; produce the narrower claim or the negative control that
  kills it."
- validation — "Reproduce another worker's claim from its own evidence with a negative control and an independent receipt;
  produce a confirmed or ruled-out closure, never a new discovery."
- retest — "Re-run the stated reproduction against the changed revision; produce the same-or-different verdict with
  receipts."
- reporting — "Convert accepted cases into a reader-ready report; produce no new claim and execute nothing."

Wiring: `Ticket` gains optional `purpose` (`src/ticket.ts:18`), set from `work.purpose` when the lead supplied structured
work and derived from `role` otherwise; `workerInstructions` renders `Your duty (<purpose>): … Forbidden: … Expected
output: …` immediately after the objective line (`src/prompts.ts:102`); `p2o_delegate`'s description gains the same seven
phrases in compressed form (`extensions/p2o/index.ts:1211`).

Cost: ~1.2 KB across the two surfaces. Budget impact: the worker declaration bytes pinned in
`tests/minimal/workflow-policy.test.ts` move (currently 19254 worker / 34325 delegated Planner / 35423 solo owner), and
the recon instruction hashes in `tests/minimal/recon.test.ts` move again. Both get a dated comment, as established.

Not proposed: seven full prompt forks (ARTEX has six templates). Start with one line per purpose; fork only if bench runs
show the line being ignored.

### P2 — Validation contract in words (S) — E4

One line in `ownerInstructions`' DELEGATION block: validation is a different worker from the claim's author, it cites the
claim it reproduces, it keeps its negative control, and it may not widen the question — the same three rules the host
already enforces (`src/tasks.ts:187`, `src/cases.ts`). Verifies with: a prompt assertion test, no behaviour change.

### P3 — Situation summary in every lead turn (M) — E5

Extend `OwnerPromptFacts` with `situation` computed at `before_agent_start` from state already loaded there:
`{ open, running, readyAfterPrerequisite, blocked, openContradictions, chainReady, chainUnmet, pendingRating, coverageTested, coverageCells }`.
Render exactly one line, hard-capped at 240 characters:

```
Situation: 2 running (discovery, validation) · 3 ready · 1 blocked on evidence · chain: 1 step ready, 2 unmet requires · 4 cases pending rating · coverage 12/31.
```

Constraints: the owner section must not name a tool (`/\bp2o_[a-z_]+\b/` guard in `tests/minimal/workflow-policy.test.ts`),
it must stay under the pinned ceiling (solo URL is 5202 with a 5300 cap today, so this needs the cap raised to 5600 with the
same dated comment), and the numbers must come from a pure snapshot function so the line is testable without an engine.

Add the test ARTEX lacks (`agent/planner.go:309` promises a key the code never emits): assert that every counter named in
the situation line exists in the snapshot object, so prompt and renderer cannot drift.

### P4 — Stated priority derivation (S) — E6/E10

Add `src/priority.ts`, a pure function from recorded facts to a suggested 0-100 priority, with the weights written in the
source and in `docs/PLANNER_ENGINE.md`:

| Signal | Delta |
| --- | --- |
| prerequisites unmet | −30 |
| purpose is validation or retest (cheap, unlocks a case) | +15 |
| a confirmed+tested claim's `provides` satisfies this claim's `requires` | +20 |
| target asset already has an accepted finding | +10 |
| questionKey already covered by a non-stale cell | −20 |

Surfaced as a suggestion next to each ready intent in the situation line; the lead's explicit `priority` still wins and
nothing auto-dispatches by score. This is the piece ARTEX does not have — its findings can only be sorted by an enum.

### P5 — Chain-ready join over the claim graph (M) — E7 — "how the vulns graph is used"

Add `src/chain-view.ts`: normalize `provides`/`requires` strings into tokens, then compute deterministically:
`ready` (an open claim whose every `requires` token is provided by some confirmed+tested claim in the same run), `unmet`
(open claims with tokens nothing provides), and `frontier` (the shortest ready path from a primitive to an effect). Expose
as a read-only section of `p2o_graph` — delivered as the `chain` **action** rather than a new `view` property, so the tool
schema does not grow past the property list pinned in `tests/minimal/graph.test.ts:25` — and as the two counts in the
situation line. No new persistence, no new authority, no candidate→candidate edges.

Why this shape: it is ARTEX's `add_intent parent_ids`/`derived_from` recombination expressed in the vocabulary p2o already
records, and it makes "which step is next" a query instead of a memory.

### P6 — Serial-chain dispatch rule, batch cap, anti-stall floor (S) — E5/E6

Three lines in `ownerInstructions`: (a) a step that consumes an earlier step's actual output is its own task with pinned
prerequisites — dispatch the ready step, review its claim, then the next; (b) dispatch at most four intents per call,
highest value first; (c) if the goal is unmet and nothing is open, the wake must produce at least one intent (ARTEX's
"产出 0 意图=任务停摆"). (a) exists in part; (b) and (c) are new. (c) stays prose only if the engine also surfaces the stall: when the goal is open and
nothing is open or running, the situation line must say `0 open` rather than leaving the lead to infer it from an empty list.

### P7 — Purpose→skill binding (S) — E9

Add `PURPOSE_SKILLS: Record<WorkPurpose, readonly string[]>` (≤3 each) beside `ROLE_DEFAULTS` (`src/roles.ts:17`), used as
the default when the lead omits `skills`. Example: discovery → `source-code-auditing` + the matching WSTG playbook;
validation → `exploitability-assessment`; mapping → `attack-surface-mapping`; reporting → `remediation`. `role` keeps the
model/authority axis. The existing `MAX_SKILLS = 3` and workflow validation stay unchanged.

### P8 — Rate-readiness instead of rate-by-feeling (S) — E10

`caseViews` (`src/cases.ts`) already computes `independentReceiptCurrent` and stale reasons. Add `readyToRate` = all claims
current + independent receipt present + chain depth stated or explicitly absent, and include it in the `p2o_case list`
projection (`extensions/p2o/index.ts:997`, today only `entry.finding.severity`). Preflight keeps its final gate.

### P9 — Parent-typed lineage gate (M) — E7/E9 — "what the plan is allowed to stand on"

ARTEX refuses an intent whose parents are not `fact`/`finding` (`agent/tools.go:1032-1090`) and auto-links an unparented
intent to the origin node, which makes evidence-driven planning a query instead of a request. p2o already records
`taskRefs`, `claimRefs`, `assetRefs` and `CaseHypothesisRef`; what is missing is the refusal. Proposal: a created or revised
task with `purpose ∈ {discovery, investigation, refinement, validation, retest}` must cite at least one same-run claim,
fact or asset revision it builds on, and a `dispatch` of such a task without one is rejected with a message naming the
missing reference. Mapping and reporting tasks are exempt. This is also what makes P5's join trustworthy: the join reads
declared lineage instead of guessing from prose.

Risk: an over-strict gate blocks legitimate first-step exploration. Mitigate by allowing an asset revision as the parent
(a surface is a legitimate starting point) and by exempting `mapping`.

### P10 — Terminal-state taxonomy for intents (S) — E5

Separate the ways a task ends: done (the question was answered), exhausted (turn/command budget ran out), blocked (a
prerequisite is missing), stopped (withdrawn or cancelled). Today the lead sees a settled task and cannot tell "this
direction is covered" from "this direction was cut short and needs another angle", which is exactly the retry-vs-abandon
decision. Add the state, carry it in `p2o_task list` and the situation line (`1 exhausted` ≠ `1 done`), and give each state
one sentence in the lead prompt.

### P11 — Show the denominator on every capped list (S) — E5

Every projection the lead reads (`p2o_task list`, `p2o_case list`, `p2o_graph`, `p2o_plan`) should emit the count it is
showing against the total, so an empty or short page is never read as an empty board. ARTEX's in-code reason is worth
quoting: "两键并排即自描述，让 planner 去重时别把「没显示」当成「没派过」" (`agent/tools.go:429-431`). Cost is one cheap
count per render; the limit constants already exist (`docs/CASE_REVIEW.md` list 20, ≤24 KiB per page).

### P12 — Owner decision, not proposed now

If P1's single line is still ignored in real runs, the next step is ARTEX-style per-purpose bodies (seven forks) at the cost
of prompt maintenance and sibling cache sharing. Do not do this before bench evidence exists.

### P13 — One owner per vocabulary (S–M each) — audit of the P11 root cause, 2026-10-22

P11 was fixed at its cause (one `Counted` contract in `src/counts.ts`), which prompted an audit for the same shape elsewhere: a rule
restated in several places, no owner, no test that would notice the drift. Eight were found. They are listed in fix order, not severity
order, because the first three block later phases.

**(a) Two identifiers for one primitive (bug, blocks P9).** `chainJoin` keys on the candidate *slug* — `candidateClaims` maps
`row.data.candidate` — while `CaseFinding.chain.steps[].claimRef` requires the candidate *record* id (`src/cases.ts:123`). `p2o_graph
{action:"chain"}` therefore prints an identifier that `p2o_case rate` rejects with `Unknown same-run chain claim`. Each half is tested
alone, so both suites stay green. Fix: emit both identities from the join (`claimId` + `recordId`) and let the rating accept either,
resolving to one canonical id; test the round trip (read the frontier, rate a chain with what it printed).

**(b) Two enums share the field name `execution` (highest safety impact).** `CANDIDATE_EXECUTIONS` (`src/evidence.ts:11`:
`tested, not_tested, blocked, not_applicable`) and `COVERAGE_EXECUTION` (`src/coverage-types.ts:2`: `unplanned, planned, running,
attempted, tested, blocked, not_applicable`) overlap on three values with different meanings — "this primitive actually ran" versus
"this cell was attempted and settled". Reads happen on untyped ledger JSON: `src/cases.ts:29`, `src/evidence.ts:81`,
`src/chain-view.ts:34`, `extensions/p2o/index.ts:276`, `src/situation.ts:61`, `src/wstg-map.ts:397`, so TypeScript never checks the
domain. Fix: brand the two types, and put the only definition of "demonstrated" in `src/claims.ts` (`isDemonstrated`, `isOpenGap`),
imported by the chain join, the case gate and coverage; test that the two enums are never compared across domains.

**(c) The task-status vocabulary has two owners and three local sets.** `TaskStatus` (`src/tasks.ts:22`) plus its transition map
(`src/tasks.ts:211`) are authoritative, but `src/records.ts:126` hardcodes the same nine statuses again for ledger-load validation,
`src/situation.ts:37-39` declares `SETTLED`/`SATISFIED`/`EXECUTING` locally, and `['reviewed','closed']` is respelled five times in the
task domain (`src/tasks.ts:178`, `:188`, `src/coverage.ts:52`, `src/report.ts:110`, `src/context.ts:74`). Adding a status would make the
loader reject a ledger it wrote, while the situation line counts it open and coverage treats it as unreviewed. Fix: export
`TASK_STATUSES`, `isSatisfied`, `isSettled` from `src/tasks.ts`, import them everywhere, and test that the union, the set and the
transition map agree.

**(d) Bound constants with several owners.** The ledger row cap `16 * 1024` appears three times in `src/records.ts` (`:62` writer,
`:111` loader, `:220` stream) while `LEDGER_BYTES` has a name; raising one makes the loader reject rows the writer just accepted. And
`skills.length > 3` (`src/tasks.ts:79`) hardcodes what `MAX_SKILLS` owns (`src/roles.ts:46`). Fix: name each bound once and test that
the write bound equals the read bound.

**(e) Action → allowed-parameters is a hand-written ternary, nine times.** `graphObject(params, …)` at `extensions/p2o/index.ts:848,
853,922,936,987,1010,1027,1186,1645`; each ends in a default branch, so a new action silently inherits it. Fix: `Record<Action, readonly
string[]>` per tool so a missing key is a type error and the default branch disappears.

**(f) Prompt ceilings live in three test files.** The same numbers sit in `tests/minimal/recon.test.ts:71,154`,
`tests/minimal/measure-context.test.ts:24`, `tests/minimal/workflow-policy.test.ts:125`; P3/P6/P7 each required three coordinated edits
and one substitution damaged a history comment. Fix: one exported ceiling table in a test helper.

**(g) The reporting-role policy is restated ten times.** `src/tool-policy.ts:9-10` is the owner; `src/prompts.ts:17,110,114`,
`src/state/store.ts:469`, `extensions/p2o/index.ts:1066,1200,1633,1683` restate it. A new tool added to `WORKER_TOOLS` without the
reporting exclusion silently gives a synthesis-only worker target access. Fix: derive the prompt sentence and the guards from the one
policy module; test that no reporting-allowed tool is target-facing.

**(h) Tool result payloads have no declared shape.** `textResult(text, details)` accepts any literal. `Counted` now covers pages, but
candidate/note/task/workers payloads are untyped, which is why `p2o_workers` navigation was previously only a string and therefore
untestable. Fix: declare result interfaces per tool and type the handlers.

Order: (a) → (b) → (c) → (d) → (e) → (f) → (g) → (h). (a) is a real defect; (b) is the one that can misstate what was proven; the rest
are drift prevention. None changes CLI text, caps or authority, so the gates are type-level plus one round-trip test per item.

---

## 4. Order, gates, budgets

| Step | Items | Gate |
| --- | --- | --- |
| 1 | P1 + P2 | prompt assertions + updated byte/hash pins; no behaviour change |
| 2 | P6 | prompt assertions only |
| 3 | P3 | situation line appears, ≤240 chars, ceiling raised deliberately, no tool names |
| 4 | P5 | unit tests for the join (ready/unmet/frontier), `p2o_graph` view test |
| 5 | P4 | pure-function table test; no auto-dispatch path |
| 6 | P7 | delegate defaults change only when `skills` is omitted |
| 7 | P8 | case list projection test |
| 8 | P11 | shown/total pairs in every projection; list caps unchanged |
| 9 | P10 | one terminal state per settled task; prompt has one sentence per state |
| 10 | P9 | gate rejection tests; asset-revision escape hatch test; `mapping` exemption |
| 11 | P13(a) | round-trip test: frontier identity accepted by `rate` |
| 12 | P13(b) | branded enums; one `isDemonstrated` owner; cross-domain comparison test |
| 13 | P13(c) | union/set/transition agreement test; loader accepts every member |
| 14 | P13(d) | write bound equals read bound; Base on Agent's demand  |
| 15 | P13(e) | exhaustive `Record<Action, …>`; no default branch |
| 16 | P13(f) | one ceiling table |
| 17 | P13(g) | derived reporting policy; no target tool reachable |
| 18 | P13(h) | typed tool results |

**Done so far — step 1 (P1 + P2), 2026-10-22.** `src/duties.ts` (the seven duties plus `purposeFromRole`), `Ticket.purpose`
(optional, validated on read), the worker duty line in the per-worker tail, `p2o_delegate`'s purpose sentence, and the
delegated lead's validation-contract line. Tests: `tests/minimal/duties.test.ts` (5 assertions on the duties, the role
fallback, the tail placement and the contract's presence only when delegation is on); pins moved on purpose in
`tests/minimal/recon.test.ts` (worker instruction hashes, delegated ceilings), `workflow-policy.test.ts` (delegated
declaration budget) and `measure-context.test.ts`, each with a dated comment. Measured: worker prompt 6.79-6.92 KB per
role, solo lead unchanged at 5,051/5,202, delegated lead 5,697/5,848/6,093.

**Done so far — step 2 (P6), 2026-10-22.** Two new lines in the shared DELEGATION block, right after the chain-step rule:
`Dispatch at most four intents per call, highest value first; a fifth waits for a slot instead of riding along unready.` and
`An open goal with nothing open or running must produce at least one intent this round: a round that adds none is a stall, not a wait.`
The chain-step rule (a) was already present from the chain pass, so it was kept verbatim. Measured after the edit: solo
5,304/5,455, delegated 5,950/6,101/6,346 (hybrid solo 6,253, delegated hybrid 6,907); ceilings raised deliberately to
solo 5,600, delegated 6,070/6,225/6,475, hybrid 6,700 in `tests/minimal/recon.test.ts`,
`tests/minimal/measure-context.test.ts` and `tests/minimal/workflow-policy.test.ts`, each with a dated comment. New
`tests/minimal/dispatch-discipline.test.ts` (3 tests) asserts all three rules in the solo, delegated and event-driven
prompt, that the cap is not written above four, and that the lead prompt still carries no `p2o_` tool name. Known tension
left on purpose for the step that changes behaviour: `p2o_task` dispatch still accepts 1..25 IDs (the cap is a prompt rule,
not a schema limit), and the `0 open` situation line waits for P3.

**Done so far — step 3 (P3), 2026-10-22.** `src/situation.ts`: `summarizeSituation({tasks, cases, coverage, claims})` (pure) and
`situationLine(snapshot)` with `SITUATION_LIMIT = 240` and `SEGMENT_FIELDS` naming the counters each segment renders.
`OwnerPromptFacts.situation` renders one line above the plan line; `extensions/p2o/index.ts` builds the snapshot at
`before_agent_start` from the task frontier, case views, coverage cells and confirmed candidate heads, and drops the line
rather than blocking the turn if a read fails. Rendered: `Situation: 2 running (discovery, validation) · 3 ready · 1 blocked
on evidence · 1 open contradiction · chain: 1 step ready, 2 unmet requires · 4 cases pending rating · coverage 12/31.`
(184 chars). An empty frontier renders `Situation: 0 open.` — the anti-stall marker P6 referred to. Ceilings moved by the
240-char allowance only: solo 5600 -> 5700, delegated 6070/6225/6475 -> 6190/6341/6586, hybrid 6700 unchanged, because the
static-body pins stay measured without a snapshot and the two budgets are asserted separately. Tests:
`tests/minimal/situation.test.ts` (5) covers the rendered line, the cap under crowding, the stall case, the counter
definitions, and the drift guard that every `SEGMENT_FIELDS` entry is a real snapshot field and every nonzero counter is
rendered; `tests/minimal/recon.test.ts` gained the with-line worst case and the `0 open` assertion.

**Done so far — step 4 (P5), 2026-10-22.** `src/chain-view.ts`: `chainTokens(value)` normalizes prose into lowercase word
tokens minus a stop list (deduped, sorted, order-free); `chainJoin(claims)` returns `primitives` (confirmed+tested claims
with no `requires`), `ready` (open claims — `closure === 'open_proof_gap'` — whose every required token some other
confirmed+tested claim provides), `unmet`, `uncovered` (the missing tokens, ≤8 per claim), `depth` (shortest distance from a
primitive via a memoized recursion with a `seen` cycle guard, `MAX_DEPTH = 12`), and `frontier` (ready claims, deepest first
then by id, each with the breadth-first shortest provider path; `MAX_FRONTIER = 10`). A claim can never satisfy its own
requirement, and a rule-out or untested claim is not a provider. `src/situation.ts` dropped its loose substring `satisfies`
helper and now reads `chainJoin.ready.length` / `chainJoin.unmet.length`, so the situation line and the graph view cannot
diverge; `SituationClaim` gained optional `candidate`/`execution`. The graph view landed as a new **action**
(`GRAPH_ACTIONS` = `['record','view','page','export','chain']`) rather than a new `view` property, because
`tests/minimal/graph.test.ts:25` pins the tool's exact property list and an action costs no schema growth; the handler at
`extensions/p2o/index.ts` shares one `candidateClaims(current)` helper with the situation snapshot, charges the knowledge
budget, bounds every list by `limit` (default 20), returns `counts` plus a `next` sentence (`<claim> at depth N (path)`), and
refuses workers with `PLANNER_ONLY` — the join is coordination, not a worker read. The `p2o_graph` description gained one
sentence naming the action (+95 B in all four loadouts, since every loadout carries the graph tool; declaration pins moved to
34,665 / 35,518 / 19,349 / 12,477 with a dated comment, guidance and `POLICY_VERSION` unchanged). Tests:
`tests/minimal/chain-view.test.ts` (6) covers tokenization, ready/unmet/primitives, the self-provide and provider-status
guards, the shortest-path frontier with depth/path agreement, a provider cycle, order-independence and the caps, and the
end-to-end `p2o_graph {action:'chain'}` read; `tests/minimal/situation.test.ts` was rewritten to the new semantics (an open
claim is the pending work; confirmed+tested is the provider) and `tests/minimal/graph.test.ts:25` now expects the five
actions. Known seam left for P9: the chain a finding records (`CaseFinding.chain.steps[].claimRef`) names the candidate
*record* id, while the join keys on the `candidate` slug, so the two identities do not join; P9's lineage gate is the step
that reconciles them.

**Done so far — step 5 (P4), 2026-10-22.** `src/priority.ts` is complete: `suggestPriority` starts at `PRIORITY_BASE` (50), adds each
`PRIORITY_WEIGHTS` block whose fact holds (the purpose block keys off `UNLOCKING_PURPOSES`, not a boolean), and clamps to
0–100 — today's extremes are 0 (prerequisites unmet plus an answered question) and 95, so the clamp is a guard for future
weight edits rather than a live one. `tests/minimal/priority.test.ts` passes 6/6. The surfacing went into the situation line
rather than a new field on the task schema: `SituationSnapshot.suggested` and the `next:` segment (`next: validation 65`), fed
by a `suggestNext` helper in `src/situation.ts` that applies the derivation to the ready tasks and to a ready chain step. Two
honest limits are recorded in `docs/PLANNER_ENGINE.md`: a ready chain step receives the +20 block because being ready *is* the
fact, while a task cannot, because a task record carries no link to the claim it will produce — that is P9's lineage gate. The
`next:` segment is the last thing dropped when the line nears `SITUATION_LIMIT`, so the suggestion survives crowding. Gate
respected: the function is pure with no dispatch path, and nothing reads the score back. Verification after the change:
`npx vitest run tests/minimal/{priority,situation,recon}.test.ts` → 27 passed.

**Done so far — step 6 (P7), 2026-10-22.** `PURPOSE_SKILLS` sits beside `ROLE_DEFAULTS` in `src/roles.ts` and is consulted between an
explicit request and the role default: `requested → roles.<role>.skills → PURPOSE_SKILLS[purpose] → ROLE_DEFAULTS[role].skills`.
An empty purpose list means "keep the role default", which is why `investigation` deliberately ships none — a general-role worker
keeps the empty set it has today instead of silently inlining a 19 KB skill into every legacy brief. Both call sites now pass
the purpose: `spawnWorkerLocked` derives it as `assigned?.work?.purpose ?? input.work?.purpose` (narrowed through `isWorkPurpose`,
because the schema delivers it untyped) and reuses the same variable for `ticket.purpose`, so the skill default and the duty line
cannot disagree; `p2o_task create|revise|match` passes `draft.work?.purpose`, so a task's pinned `method.skills` is purpose-derived
when the lead omits `skills` — without that, a task-driven spawn would have pinned the role default and P7 would never bite.
`p2o_delegate`'s description now names purpose as the source of the default set (+52 B, delegated Planner only). Tests:
`tests/minimal/roles.test.ts` grew three cases (6 total) — every id checked against `skills/catalog.json` and capped at
`MAX_SKILLS`, the four pre-existing role defaults pinned equal to their purpose entry so the table cannot silently redefine recon /
discovery / validation / reporting, explicit `skills` and the operator role setting still winning over purpose, and `role` still
choosing the model (validation keeps kimi-k3 under `purpose: 'retest'`). Gate respected: defaults move only when `skills` is
omitted, and every previously shipped default resolves to the same list.

**Done so far — step 7 (P8), 2026-10-22.** `CaseView` now carries a derived `readyToRate` (`src/cases.ts`): `currentness === 'current'` +
`independentCurrent` + chain depth stated or explicitly absent. `p2o_case list` projects it beside `independentCurrent`, so the lead reads
readiness instead of inferring it from the verdict. It is computed in `caseViews` only — no ledger field, no new authority, no stored flag that
can go stale — and it drops to `false` the moment cited support is superseded, which `staleReasons` already explains (so no second reason list
was added; a boolean plus the existing reasons was the minimum honest surface).

The third clause needed a reading, because the plan sentence is one line and the data model is narrower than it sounds: the only chain record is
`CaseFinding.chain` **on the rating**, so before a rating exists there is nothing to inspect. Implemented as: `chainDepthStated = !rating?.finding.chain
|| chain.demonstratedThrough !== undefined || chain.steps.every(step => step.claimRef === undefined)` — i.e. an unrated case passes (nothing claimed yet),
a rating with a reasoned-only chain passes (depth explicitly absent), and a rating that binds steps to claims while omitting `demonstratedThrough`
fails (executed-looking steps with no stated stop). That last case is the vague one P8 targets, and it is reachable: `validateFinding` requires a
`claimRef` for every step *up to* `demonstratedThrough`, never the reverse. The alternative reading — requiring each executed primitive to state
`provides` before rating — was rejected for this step because it would gate every single-primitive case on a field that only matters once a chain exists.

Tests: `tests/minimal/cases.test.ts` grew a `rate-readiness is derived, not asserted (P8)` block (2 tests: current support without an independent receipt
is `false`, accepted with a current validator receipt is `true`, a later superseding claim flips it back to `false`, and a withdrawn case is always
`false`); `tests/minimal/case-rating.test.ts` asserts the `p2o_case list` projection carries the field and strips it when feeding a view back into
`revise` (the draft validator is strict, so a derived field must not leak into an entry). `docs/CASE_REVIEW.md` gained a `readyToRate` paragraph.
Note for step P11: the shared report fixture accepts and rates a case with `independentEvidenceRefs: []`, so its projection now reads
`readyToRate: false` — that is the honest reading, and it is the same gap `HIGH_WITHOUT_INDEPENDENCE` guards at finish.

**Done so far — step 8 (P11), 2026-10-22.** Three projections were still silent about their denominator, and each now carries the pair:
`p2o_task list` gained `shown`/`omitted` beside its existing `total` (`extensions/p2o/index.ts`, the list action); `LedgerPage`
(`src/records.ts`) gained `shown`/`omitted` so `p2o_ledger` distinguishes "17 of 5,000" from "17"; and `p2o_graph {action:"chain"}`
gained a `shown` map alongside `counts`, which previously reported three totals for four lists (the `frontier` array was sliced by
`limit` with no count at all). `listPage`, `SearchPage`, `graphPage`/`graphExport` and the coverage/plan/case projections already had
the pair, so nothing else moved and **no cap changed** — P11 is a reporting step, not a paging redesign.

Two details worth keeping: the ledger pair is named `omitted` (= total − shown) even though the recent view's cursor defaults to the
end, because the agent's question is "how much am I not seeing", not "how much is behind me"; and the empty-page case is asserted
explicitly (cursor past the end → `total` still 2, `shown` 0) since that is exactly the reading P11 exists to prevent.
Tests: `tests/minimal/projection-counts.test.ts` (2 tests) walks every lead-facing list through the shared report fixture and asserts
`shown ≤ total`, `omitted === total − shown`, per-kind `shown ≤ counts` for the graph export and the chain join, and that a truncated
page stays navigable through `nextCursor` without changing the denominator across pages. `docs/ASSESSMENT_STATE.md` records the rule.

**Cause found for the P11 gap (and fixed at the cause, 2026-10-22).** The three silent projections were not three oversights. The count
pair had **no owner**: it was hand-written in seven places — `listPage` (`extensions/p2o/index.ts`), `ledgerPage` (`src/records.ts`),
`searchRecords` (`src/search.ts`), `events`/`graphPage`/`graphExport` (`src/state/store.ts`), the knowledge-head page (`src/context.ts`)
and two inline payloads — under four different names (`omitted`, `omittedAfter`, `omittedCells`, `matched`). Six separate interfaces
declared their own field list, so the compiler had nothing to compare a new page against; the arithmetic was duplicated, so it could be
half-copied; and no test enumerated page shapes, so a missing key produced no failure. `p2o_workers` showed the drift plainly: its
navigation payload carried `total` without `shown`, a nested `omitted` that meant *reconciliation omissions* rather than *items not
shown*, and a `tasks.slice(-10)` tail whose count lived in a differently named field (`tasksTotal`).

Fix: one contract and one constructor in `src/counts.ts` — `interface Counted {total, shown, omitted, cursor, nextCursor?}`,
`counted(selected, {cursor, limit, key, bytes, project, label, beyond})` for position pages, `countedTail(items, tail)` for a fixed tail,
and `assertCounted(value)` as a compile-time gate for hand-built payloads. `listPage`, `ledgerPage`, the task list, the coverage suggest
page, `LedgerPage`, `SearchPage`, `KnowledgePage` and `StorePage` now route through it (`SearchPage.omittedAfter` → `omitted`, the suggest
payload's `matched` → `total` + `omitted`), so `npm run typecheck` refuses a page that omits a key it claims to state. `p2o_workers`
navigation now nests `changes` and `tasks` as two counted summaries and keeps reconciliation omissions under their own name; the payload is
also exposed as `details.navigation`, since it was previously only a string for the model to read and therefore untestable.

Cost and limits: no cap, cursor rule or byte ceiling changed (`counted` keeps 23 KiB by default, `ledgerPage` passes 48 KiB). Tests:
`tests/minimal/projection-counts.test.ts` now covers the suggest page and both `p2o_workers` lists, and asserts the constructor's own
contract (empty page keeps the denominator, cursor past the end throws, `nextCursor` only when items remain). Renaming fallout fixed in
`tests/minimal/search.test.ts` (`omittedAfter`) and `tests/minimal/coverage-suggest.test.ts` (payload `matched` → `total`; the
`wstgSuggest` return value still uses `matched`, which is an internal function's name, not a page field).

**Done so far — P13(a)–(g), 2026-10-22.** (a) `ChainClaim.recordId`/`ChainPath.recordId` travel with the slug, and `CaseBoard.rate`
accepts either identity, resolving a slug to its candidate head — `tests/minimal/case-chain.test.ts` reads the frontier and cites what it
printed. (b) `src/claims.ts` now owns the rule (`isDemonstrated`, `isConfirmedClaim`, `isOpenGap`, `isOpenClaim`, `isTestedCell`,
`demonstratedProvides`); the eight literal comparisons across both `execution` vocabularies were replaced, and
`tests/minimal/claims.test.ts` fails if one reappears outside the owner. (c) `TASK_STATUSES` plus `SATISFIED`/`SETTLED`/`EXECUTING`
sets and their predicates live in `src/tasks.ts`; the loader, situation line, coverage, report, context, store, cases and tasks import
them, and the coverage-plan and goal vocabularies got named sets of their own instead of borrowing the words —
`tests/minimal/status-vocabulary.test.ts` pins all three. (d) `LEDGER_ROW_BYTES` and `MAX_SKILLS` are the only statements of their
bounds. (e) `TASK_ACTION_PARAMETERS`, `CASE_ACTION_PARAMETERS`, `COVERAGE_ACTION_PARAMETERS`, `PLAN_ACTION_PARAMETERS`,
`GRAPH_ACTION_PARAMETERS` are exhaustive `Record<Action, readonly string[]>` tables, so no action falls through a default branch.
(f) `tests/minimal/helpers/budgets.ts` owns the lead ceilings and the declaration budget; the three tests read it. (g)
`TARGET_FACING_OPERATIONS` in `src/tool-policy.ts` maps each denied broker operation to its tool and says whether the whole tool or
only its write operation is denied; `reportingOperationDenied` derives from it and `tests/minimal/reporting-policy.test.ts` ties the map
to the loadout and the prompt.

Two findings worth keeping. `graph_record` is the one denied operation whose tool (`p2o_graph`) reporting legitimately keeps for reads —
a flat op→tool map would have hidden that. And `p2o_delegate` is an owner-only spawn path reached over the broker, so the map records it
without claiming a worker loadout carries it. Remaining: **P13(h)** (typed tool results), which is the broad one and belongs with P9's
identity work rather than before it.

**Done so far — step 9 (P10), 2026-10-22.** How a task ended is now a closed vocabulary in `src/tasks.ts`:
`TASK_TERMINAL_STATES = ['done','exhausted','blocked','stopped']`, `terminalState(task, {budgetExhausted})` and
`terminalCounts(tasks, predicate)`. `done` is `isSatisfiedTask` (reviewed/closed), `expired` is `exhausted`, `blocked` and
`cancelled` become `exhausted` **only** when the worker's progress record says `budget-exhausted`, and open work returns
`undefined` rather than a fifth state. The state is derived, never stored: `AssessmentTask.outcome` already carries the human
reason for a transition, so reusing it as the taxonomy would have made the two agree by accident at best.

Why the predicate exists: the task record has no field for "the allowance ran out" — only `ProgressState.view(workerId).lastProblem`
knows, and it is per worker, not per task. So the extension supplies `budgetExhausted(current, task.assignee)` at both call sites
(`p2o_task list` projection and `situationSnapshot`), which keeps the rule in `src/tasks.ts` while letting the one piece of evidence
a record does not carry come from the process that observed it.

Surfaced in two places, both deliberately before the droppable tail: the `p2o_task list` projection gained `terminal`, and the
situation line renders `${n} exhausted` right after `next` because it changes what the lead does next. `blocked` in that line is now
disjoint from `exhausted` — a task that stopped because the allowance ran out is not something the lead can unblock, and counting it
twice would have made the line read as more pending work than exists.

The lead prompt gained one sentence naming all four (shared DELEGATION block, so solo owners see it too): "Each settled task reports
one terminal state: done (answered and reviewed), exhausted (the allowance ran out first — retry the direction differently, never read
it as answered), blocked (a prerequisite is missing; reopen only when it exists), stopped (you withdrew it, which says nothing about
the target)." That sentence is why every lead ceiling moved: static bodies are now 5,611 / 5,762 / 6,579 characters and
`tests/minimal/helpers/budgets.ts` records `soloDirectory 5900, soloUrl 6050, hybridSolo 6900, delegatedDirectory 6550,
delegatedUrl 6700, delegatedEventDriven 6950` (static + the 240-character situation allowance). `recon.test.ts`'s hash comment was
extended rather than replaced, so the P6/P3 history stays readable.

Tests: `tests/minimal/terminal-state.test.ts` (5) — the rule table including "the free-text reason never decides the state", the
budget hint flipping blocked/cancelled, exactly-once counting, the situation line keeping `exhausted`/`blocked` disjoint, and the
`p2o_task list` projection reading `done` for a reviewed task while an open task states nothing. `docs/ASSESSMENT_STATE.md` and
`docs/CASE_REVIEW.md` were not touched: the taxonomy belongs to tasks, and neither document claims a task outcome.

**Done so far — step 10 (P9 + P13h), 2026-10-22.** Lineage is now a field, not an inference. `WorkSpec.claimRefs` (`src/work.ts`) holds
1..10 same-run candidate record ids, validated (`Unknown`/`Duplicate`/`1..10`), deduplicated and sorted, exposed in
`workSpecSchema` (`src/work-tool.ts`), and a task's stored work is re-validated once (`TaskBoard.canonical`) so the record holds the
canonical order — the earlier code validated a copy and stored the author's order.

The refusal lives in `TaskBoard.verifyLineage`, called from `checkDependencies`, so create, revise, `match` and the ready-time checks
(`reserve`, dispatch) share one rule:

- `validation` and `retest` must cite the claim they reproduce (`work.claimRefs`) or the predecessor task (`validationOf`/`retestOf`).
- `investigation` and `refinement` must cite a claim, a pinned asset revision, or a prior task — but only when the draft carries a
  structured work identity, because a legacy prose draft has no field to fill and refusing it would name something unfillable.
- `mapping` and `reporting` are exempt: they are the starting point, not something that stands on another.

One conditional is deliberate and worth re-reading before anyone "tightens" it: the validation refusal only fires once the run holds
a claim (`index.records.some(row => row.kind === 'candidate')`). Asking for a claim reference on an empty run would demand a citation
of something that does not exist, and the first validation-shaped intent on a fresh target *is* the discovery that produces the
claim; the message says so explicitly instead of pointing at an empty field. This is also what keeps the shipped delegate fixtures
(which spawn a validation worker on a hunch) honest rather than exempt.

**P13(h)** closes the audit list: `src/tool-results.ts` declares `TaskListPage`, `CaseListPage`, `ChainViewPage` and
`WorkersNavigation`, and all four producing sites annotate their returns — `p2o_graph {action:"chain"}`, the `p2o_workers` navigation,
and (via a widened `counted<T, P, K>` / `listPage<T, P, K>` that carries the page key and the projected item type) `p2o_task list`
and `p2o_case list`. The annotation immediately caught one real drift — `changes.items[].id` can be absent for a record the ledger
has not assigned an id to, which the hand-written payload had been silently asserting as `string`.

A declaration only earns its place if it can fail, so it was verified by removing `recordId` from the task projection: `npm run
typecheck` now refuses it. The first attempt at that check passed, which exposed the second half of the problem — `assignee?: string`
(field-optional) let the projection drop a key the producer always writes, so the declared fields are `string | undefined` unless the
key really can be absent (`CaseListPage['entries'][number]['severity']`, spread only when a finding exists). Rule for the next page:
declare `T | undefined` when the key is always written, `?` only when it is conditionally spread.

Tests: `tests/minimal/lineage.test.ts` (5) — refusal for validation with no parent once a claim exists, acceptance with
`claimRefs`, `Unknown same-run parent claim` for an unknown id and for an evidence receipt, revision that drops the predecessor
refused, mapping/reporting exempt, asset revision accepted as lineage, and the bounds/sorting matrix. `tests/minimal/projection-counts.test.ts`
grew a runtime check that the declared chain and navigation keys are the ones sent. Suite: 664 passed / 12 skipped, 82 files.

Standing constraints for whoever implements this: run GitNexus `impact` before editing a symbol and `detect-changes`
before committing; keep every pinned measurement deliberate and dated; `DEFAULT_TOOL_GUIDANCE=false` means TOOL_GUIDELINES
is **not** a reliable channel for new policy — use the prompt, the tool description, or a schema field; do not edit
`research/**` (knowledge-library editorial policy) or `bench/.arms/**` / `bench/.work/**` (frozen snapshots); commit,
push and install stay owner-initiated.

## 5. Non-goals

- No new store, queue, or goal engine: every proposal reads structures that already exist.
- No automatic dispatch, no automatic severity, no model-free severity change: the lead keeps authority.
- No candidate→candidate dependency store: `provides`/`requires` prose plus the P5 join is the honest minimum.
- No live-target benchmark in this pass; bench runs stay owner-initiated.

---

Retired passes are archived outside the tree under `tmp/` (gitignored) so this file holds one live proposal only.
## 6. P14 — typed capabilities, replayable payloads, severity from demonstration (implemented)

> **Reconstructed 2026-10-23.** The working copy of this file was overwritten with the audit appendix before this section was
> committed, and git HEAD predates the phase. The items below are rebuilt from the shipped code, its docs and the surviving
> per-item status paragraphs; they record what exists, not a fresh proposal.

### P14.1 — Typed capability vocabulary (S)
`src/capabilities.ts` replaces free-text `provides`/`requires` with fifteen closed kinds (`net.egress`, `http.request`,
`auth.bypass`, `cred.session`, `cred.secret`, `file.read`, `file.write`, `exec.code`, `db.query`, `deserialize`, `cloud.role`,
`host.shell`, `dns.resolve`, `admin.ui`, `data.read`). One match rule (`capabilityMatches`: same kind; subject and scope compare
only when both name one; a legacy string never matches). Write path `parseCapability`/`capabilityList` (1..10 items, subject 80 B,
scope 40 B, legacy 300 B, canonical sort+dedup); read path `readCapabilities` also accepts the stored `{legacy}` form it wrote.
`src/evidence.ts` refuses the pre-P14 fields by name; `src/chain-view.ts` reports `uncovered` per kind and lists legacy tokens
instead of silently joining them.
*Status — done.* Gate: `tests/minimal/capabilities.test.ts`, `chain-view.test.ts`.

### P14.2 — Payloads that survive the worker (S)
`src/lab.ts` `PayloadStore` keeps `payload-<uuid>.json` under `<control>/lab/payloads` (dir 0700, file 0600, `O_EXCL|O_NOFOLLOW`,
sha256 verified on read: `Payload integrity failure`, `Unknown payload ID`, `Invalid payload ID`). `Candidate.payloadRef` requires
`execution: 'tested'` and an existing payload; the report projection prints a `Replayable` column.
*Status — done.* Gate: `tests/minimal/lab.test.ts`.

### P14.3 — Environments as a recipe, not a claim (M)
`src/compose.ts` reads a bounded YAML subset under a closed allowlist and refuses by name (`privileged: true`, `cap_add`, `devices`,
host `network_mode|pid|ipc`, `restart`, host mounts, `build:`, foreign images, unknown keys). `EnvironmentStore` keeps one
environment per name, one revision per fingerprint, idempotent `put`, and recomputes the fingerprint on `get`
(`Environment integrity failure`). `runEnvironment`/`stopEnvironment` run in the caller's own sandbox under `/work` (or
`/work/<workerId>`). `p2o_lab env|verify|destroy`; broker op `environment` charges `prepareCommand` per command.
Deviation recorded: no `environment` graph asset kind — two revision counters would be worse than one.
*Status — done.* Gate: `tests/minimal/lab.test.ts` (compose refusals), `broker.test.ts`.

### P14.4 — Purposes and the exploit role (S)
`WORK_PURPOSES` gains `exploitation` and `chaining`; `DUTIES` gains one entry each; `purposeFromRole('exploit')` is
`exploitation`, so the exploit role no longer inherits the investigation duty; `ROLES` gains `exploit`
(`ROLE_DEFAULTS.exploit = {model: 'opencode-go/kimi-k3'}`).
*Status — done.* Gate: `tests/minimal/duties.test.ts`, `roles.test.ts`.

### P14.5 — Lineage for exploitation and chaining (S)
`verifyLineage` refuses an exploitation task with no `work.claimRefs` and a chaining task with fewer than two, naming the missing
primitive or the missing composition; a pinned asset revision or a prior task is not a primitive.
*Status — done.* Gate: `tests/minimal/lineage.test.ts` (9).

### P14.6 — Procedure skills (M)
Five procedure skills ship (`exploit-design`, `web-injection-to-exec`, `ssrf-to-internal`, `binary-exploit-ladder`,
`credential-and-pivot`), each with Entry conditions / Gates / Completion definition / The wall, 8 reference docs and 4 scripts.
`src/skills.ts` gains the `procedure` kind (rank playbook < overlay < procedure < technique) and `scripts/validate_library.py`
validates its sections and the additive, bounded recipe fields (`steps` 2..12, `observe` 1..12, `wall` 0..12).
*Status — done.* Gate: `python3 scripts/validate_library.py`, `tests/minimal/skills.test.ts`.

### P14.7 — Materialize a script into the sandbox (S)
`SkillLibrary.materialize(id)` copies a registered `skills/**/scripts/*.py` (64 KiB bound, `.`/`..` refused) through a fixed
FD-pinned writer that re-reads and hashes it; `p2o_skill_read {materialize: true}` returns `{path, sha256, bytes}` under
`/work/<by>/skills/`. No `docker cp`, no host path.
*Status — done.* Gate: `tests/minimal/skills.test.ts` (6), `extension.test.ts`.

### P14.8 — Cited research channel (M)
`knowledge/techniques/` holds 14 corpus cards plus a committed `index.json` (`scripts/techniques/build-index.mjs --check` is the
drift gate). `src/research.ts` limits a query (≤200 chars, ≤6 terms), labels injection signals in fetched text, and only fetches
URLs the corpus already cites (`curatedSource`), https only, 32 KiB, inside the caller's sandbox. Research is unbudgeted, is
recorded as its own record kind, and is never evidence.
*Status — done.* Gate: `tests/minimal/research.test.ts` (8).

### P14.9 — Severity from demonstration (L)
`src/cvss4.ts` implements the CVSS 4.0 base score (EQ1–EQ6, macrovector lookup, `max_severity`/`max_composed`, FIRST/Red Hat
BSD-2-Clause attribution), validated against FIRST's own `cvss_score.js` on all 104,976 base vectors (the run found and fixed an
EQ5 denominator bug: 9.2 vs 9.3). `src/cvss.ts` maps seven demonstrated effects to a minimum impact, scores the chain at the
easiest reach any executed step reported, and computes impact on every validation. `p2o_case rate` refuses a severity above what
the furthest executed step demonstrated, naming that step.
*Status — done.* Gate: `tests/minimal/cvss4.test.ts` (15), `case-chain.test.ts`, `case-rating.test.ts`.

### P14.10 — Chain → task draft (M)
`p2o_graph {action: 'chain', plan: true, assetRefs, requestId}` returns a draft (role `exploit`, `work.purpose: 'exploitation'`,
`work.claimRefs` = the providers on the shortest path plus the own claim, `work.needs`, `work.environmentRef`) and records one
`p2o_plan` todo per step, replay-safe by `requestId`. It never dispatches, never invents an asset identity, and says
`Nothing ready to plan` when the frontier is empty.
*Status — done.* Gate: `tests/minimal/chain-plan.test.ts` (4).

### P14.11 — Budget class (S)
`commandBudgetFor(purpose, declared)` gives exploitation and chaining 400 commands; `work.budget.commands` (1..5000) overrides it
and is deliberately not part of the work fingerprint. A wrap-up purpose whose report says `partial-budget` (or reached the
allowance) without a `wrapUp` is refused rather than annotated, and `dutyLine` appends the wrap-up duty (461/458 chars, so those
two duty lines have a 470-character ceiling instead of 400).
*Status — done.* Gate: `tests/minimal/budget-class.test.ts` (3), `broker.test.ts`, `extension.test.ts`.

### P14.12 — Independent replay is a reproduction (M)
`src/evidence.ts` stamps `payloadSha256` and `environmentFingerprint` on the candidate record after the caller's input is spread
(they cannot be asserted) and refuses a mismatch. `src/cases.ts` compares the peer's latest claim against the cited receipt and
requires the same payload hash and the same environment fingerprint, replacing the old generic `independent-support-stale` with
named reasons (`independent-receipt-missing|uncited|withdrawn|different-surface:<id>`, `independent-payload-missing|mismatch:<a>!=<b>`,
`independent-environment-missing|mismatch:<a>!=<b>`). An artifact-less claim keeps the peer-claim rule; naming only one half fails
loudly; the case stays ratable while `independentCurrent`/`readyToRate` stay false with the reason.
*Status — done.* Gate: `tests/minimal/cases.test.ts`, `case-rating.test.ts`.

### P14 gate as measured (2026-10-23)
`npm run typecheck` clean; `npm run build` + `check:build` OK; `npx vitest run tests/minimal/` 737 passed / 12 skipped (749 tests,
89 files); `python3 scripts/validate_library.py` PASS; `python3 -m pytest tests/test_library.py -q` 116 passed, 1 skipped, one
pre-existing failure (`SkillProfileTests::test_provenance_record_matches_review_snapshot`, R1 `b4d7a8ce…` vs `3e729859…`).
GitNexus `detect-changes --scope all`: 61 files / 378 symbols / 237 processes, risk **critical** (expected for a phase of this
size); `impact caseViews` CRITICAL with 26 callers, reviewed before the change.

## 7. P15 — prompt, skill and tool corrections from the 5-dimension audit (implemented)

The audit in **Appendix A** read the composed prompt (lead and worker policy, duty lines, tool declarations, inlined skills) and
named nine weaknesses, eight conflicts, seven sources of friction and nine duplications. This pass applies its seven refactors
(R1–R7). Nothing here adds a tool, a store or a gate: every fix is text plus one derivation function.

### R1 — The stall rule stopped demanding invented work (`src/prompts.ts`)
The old line — *"An open goal with nothing open or running must produce at least one intent this round: a round that adds none is a
stall, not a wait"* — had no host enforcement, contradicted the blocked/human-needed rule two lines above, and sat next to a host
segment that renders `0 open` (`src/situation.ts:121`). It now reads: *"A round that adds no intent is a stall only when a feasible
question exists: add that one; when none exists, report blocked/human-needed with the missing prerequisite instead of inventing
work."* The scheduling intent survives; the fabrication pressure does not.
Gates: `tests/minimal/dispatch-discipline.test.ts` (the anti-stall assertion moved to the conditional sentence and keeps the
batch-cap and serial-chain assertions).

### R2 — The prompt now names what the host actually checks (`src/prompts.ts`)
Two host gates landed after the prompt text was written, so the model could only learn them from a refusal:
- **Independence (P14.12)**: the prompt said "a separate worker reproducing the effect with a current matching conclusion and
  reviewable receipt"; `src/cases.ts` compares the peer claim's `payloadSha256` and the environment fingerprint. The line now says
  the second worker must reproduce the effect *"in an environment whose recipe fingerprint matches, with its own receipt and the same
  payload sha256"*, and that a missing half keeps a case ratable but not independent.
- **Severity (P14.9)**: "limit severity to demonstrated impact" became *"Severity is computed, not chosen: rate each executed chain
  step with the effect it showed, and no case scores above the furthest step that actually ran."*
Gates: `tests/minimal/recon.test.ts` (the sentence assertion and the two worker-instruction hashes).

### R3 — One boundary for "your objective" (`src/prompts.ts`)
`Your assigned objective is your whole job` and `follow the chain that intent opens … instead of stopping at the edge of the brief`
stated two different boundaries, and the duty line a third. The objective line now says *"Follow it into the effects it directly
enables when your duty covers them"*, and tactical autonomy says *"take the next step only when this step's actual output is its
input and your duty covers that purpose; otherwise report the link."* The duty line is now the single owner of how far a purpose
reaches.

### R4 — Default skills follow the target and the need (`src/roles.ts`)
- `purposeSkills(purpose, {kind, needs})` is the one derivation: a URL run maps with `web-deployment-hygiene` and discovers with
  `web-route-input-inventory`; a directory or hybrid run keeps the source methods (a hybrid target still has the snapshot); no
  context keeps the pre-P15 base table, so a caller without target info behaves exactly as before.
- `exploitationSkills(kind, needs)` derives the ladder from `work.needs`: `net.egress` → `ssrf-to-internal`, `exec.code` →
  `binary-exploit-ladder` (directory) or `web-injection-to-exec`, `cred.session`/`cred.secret` → `credential-and-pivot`, with
  `exploit-design` first so the 3-skill cap never drops the general procedure.
- `validation` and `reporting` lose their defaults **in both tables** (`PURPOSE_SKILLS` and `ROLE_DEFAULTS`), because leaving the
  role default in place would silently restore the skill the purpose just removed. Consequence, recorded on purpose:
  `exploitability-assessment` and `remediation` are now reachable only by explicit request, and the library ships no
  reproduction/replay procedure skill — that gap is the honest follow-up, not a reason to keep a default that teaches the forbidden
  failure.
- Plumbing: `p2o_delegate` and `p2o_task create` pass `context: {kind: current.target.kind, needs: workNeeds(work)}`, where
  `workNeeds` reads only `kind` strings from an untyped draft (the real validation stays in `validateWorkSpec`).
Gates: `tests/minimal/roles.test.ts` (two new tests over kind, needs, cap and explicit-request precedence), `measure-context`.

### R5 — Reporting's duty and its tools agree (`src/duties.ts`, `src/tool-policy.ts`)
The duty said "execute nothing" while the reporting role keeps `p2o_research`, which fetches a curated page inside the sandbox. The
duty is now *"produce no new claim and run no target command. A curated citation lookup is not target execution."*, and the
tool-policy comment points at the duty so the two cannot drift apart.

### R6 — One copy of each rule (`src/prompts.ts`)
- `EVIDENCE_TAIL` lost two benchmark-derived sentences already covered elsewhere (`a simulated bot is not a browser`, the legacy
  `p2o_note` caveat) and the duplicated export/placeholder wording, so the remaining rules are the ones that change behaviour.
- `reconInstructions` gained `forLead`: the recon-handoff queue is rendered only into the lead prompt, because a worker cannot
  delegate and the queue it was told to rank had no consumer.
- The URL and hybrid scope lines no longer repeat `Only the human can widen scope` and `Tool repositories are not extra targets`;
  the next line states both once.

### R7 — Payload procedure moved out of the declaration (`src/tool-guidelines.ts`, `extensions/p2o/index.ts`)
`p2o_lab` gained one guidance line (store the payload before running it, verify the recipe before trusting it, name both in the
claim) and its description was tightened by 100 B without dropping the compose refusal list — the refusals are contract (what the
sandbox cannot honour), the order of operations is advice. `POLICY_VERSION` is now 3.

### Measured effect
| Loadout | Declarations (B) | Guidance (B) |
|---|---|---|
| delegated Planner | 45,087 (−100) | 1,342 (+180) |
| solo owner | 45,818 (−100) | 1,260 (+180) |
| worker | 26,309 (−100) | 653 (+180) |
| reporting worker | 14,643 (0) | 376 (0) |

Lead prompt static bodies: 5,892 (directory) / 5,970 (url) / 6,769 (hybrid), delegated 6,538 / 6,616 / 6,861 event-driven. The
three clarified rules cost more than the removed duplication saved, so `LEAD_CEILINGS` moved on purpose (6,150 / 6,250 / 7,050 /
6,800 / 6,900 / 7,150) and the owner guidance ceiling moved 1,200 → 1,400 for the new `p2o_lab` line. Every number is dated in
`tests/minimal/helpers/budgets.ts`.

### P15 gate as measured (2026-10-23)
`npm run typecheck` clean; `npm run build` + `check:build` OK; `npx vitest run tests/minimal/` **739 passed / 12 skipped** (751
tests, 89 files, 83 passed + 6 skipped) — two more than P14 because of the new role tests; `python3 scripts/validate_library.py`
PASS (17 skills, 81 catalog entries, 65 evidence sources); `python3 -m pytest tests/test_library.py -q` 116 passed, 1 skipped, one
pre-existing failure (`SkillProfileTests::test_provenance_record_matches_review_snapshot`, R1 `b4d7a8ce…` vs `3e729859…`).
GitNexus `impact`: `resolveRole` **HIGH** (2 direct callers, 3 processes — reviewed; the change is additive, every new field
optional), `ownerInstructions`/`workerInstructions`/`reconInstructions` LOW.

*Status — done.* R1–R7 applied; the audit that motivated them is preserved below as **Appendix A**.


---

## Appendix A — Audit of the prompt, skill and tool architecture (2026-10-23, unchanged)

 Phân tích prompt/skill/tool của pi-p2o

 Phạm vi. "System Prompt" ở repo này không phải một khối duy nhất. Nó là 4 tầng hợp thành:

 ┌─────────────────────────────┬─────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────┐
 │ Tầng                        │ Nguồn                                               │ Kích thước đo được                                       │
 ├─────────────────────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Lead policy                 │ src/prompts.ts:60-104 (ownerInstructions)           │ 5,611 B (directory) · 5,762 (url) · 6,579 (hybrid) —     │
 │                             │                                                     │ LEAD_CEILINGS                                            │
 ├─────────────────────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Worker policy               │ src/prompts.ts:106-127 + dutyLine                   │ ~5.7 KB + 250–470 B duty                                 │
 │                             │ (src/duties.ts:88-93)                               │                                                          │
 ├─────────────────────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Tool declarations +         │ 19 tool, extensions/p2o/index.ts,                   │ 45,187 B tổng khai báo; 9,293 B riêng description        │
 │ guidelines                  │ src/tool-guidelines.ts                              │                                                          │
 ├─────────────────────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Skills inline               │ skills/*/SKILL.md (35 file, 234,994 B)              │ tối đa 3 file = 27,201 B worst case, trung bình ~20 KB   │
 └─────────────────────────────┴─────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘

 Tổng worst case một worker nhận ~59 KB text hướng dẫn trước dòng TASK (≈15K token). Đó là bối cảnh cho mọi kết luận dưới đây.

 ────────────────────────────────────────────────────────────────────────────────

 1. Điểm yếu & Edge cases

 W1 — Luật "stall" là mệnh lệnh không thể kiểm chứng và đẩy model tới bịa việc.
 src/prompts.ts:93: "An open goal with nothing open or running must produce at least one intent this round: a round that adds none is a stall,
 not a wait." Host không cưỡng chế luật này (không có cap intent trong src/tasks.ts; chỉ p2o_finish kiểm pendingIntents,
 extensions/p2o/index.ts:1552). Ngược lại host còn đẩy tín hiệu stall: src/situation.ts:121 render segment 0 open. Edge case: manual mode,
 surface đã cạn, budget worker đã dùng hết → model buộc phải sinh intent mới để "không stall", đúng thứ mà dòng kế bên cấm ("never invent work to
 sustain the loop"). Đây là đường ngắn nhất từ prompt tới hallucination.

 W2 — Prompt chưa cập nhật gate P14.9/P14.12; model sẽ tuyên bố điều host từ chối.
 src/prompts.ts:98 nói independence chỉ cần "a separate worker reproducing the effect with a current matching conclusion and reviewable receipt".
 Nhưng src/cases.ts:independentReceiptCurrent (P14.12) đòi thêm cùng payloadSha256 và cùng environmentFingerprint. src/prompts.ts:99 nói "limit
 severity to demonstrated impact" trong khi p2o_case rate (P14.9) đòi mỗi bước chain có effect (src/case-tool.ts:6) + reach, và từ chối mức cao
 hơn effect đã chứng minh. Edge case: chain 3 bước, bước cuối effect=code-execution; lead đọc prompt, rate critical, bị host trả về lỗi nêu tên
 bước — lead không được báo trước luật nào.

 W3 — PURPOSE_SKILLS không biết target kind → skill sai ngữ cảnh.
 src/roles.ts:38-46 là map tĩnh. Với --url:
 - mapping → attack-surface-mapping (8,591 B, mở đầu bằng "Use before choosing code to audit or designing a harness") thay vì
   web-deployment-hygiene (7,901 B, "Use first") hay web-route-input-inventory (8,855 B).
 - discovery → source-code-auditing dù không có /target. Edge case hybrid: worker nhận skill nói về source, brief không nói phần nào của bài áp
   cho origin.

 W4 — 4/5 procedure skill của P14.6 không bao giờ được chọn mặc định.
 src/roles.ts:44-45 chỉ gán exploit-design. binary-exploit-ladder, web-injection-to-exec, ssrf-to-internal, credential-and-pivot chỉ tới được
 worker nếu lead tự truyền skills:[...]. Mà lead không được nhắc về skills: grep "p2o_skill|skill" src/prompts.ts:60-104 = 0. Edge case: exploit
 worker nhận exploit-design chung chung trong khi primitive là SQL injection → phải tự suy ra nhánh ladder.

 W5 — Duty và skill mặc định nói hai việc khác nhau.

 ┌──────────────────┬──────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────┐
 │ Purpose          │ Duty (src/duties.ts)                             │ Skill mặc định (src/roles.ts)                                          │
 ├──────────────────┼──────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
 │ validation       │ "never a new discovery"                          │ exploitability-assessment = đánh giá impact, tổng hợp primitive →      │
 │ (42-46)          │                                                  │ chính là phân tích mới                                                 │
 ├──────────────────┼──────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
 │ reporting        │ "produce no new claim and execute nothing"       │ remediation = viết fix, regression test, detection → claim mới         │
 │ (64-68)          │                                                  │                                                                        │
 ├──────────────────┼──────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
 │ retest (47-51)   │ "Re-run the stated reproduction…                 │ remediation (viết fix, không phải chạy lại)                            │
 │                  │ same-or-different verdict"                       │                                                                        │
 └──────────────────┴──────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────┘

 W6 — p2o_lab nằm trong tay lead nhưng lead không được chạy gì.
 src/tool-policy.ts:2-4: LAB_TOOLS vào cả OWNER_TOOLS; comment nói payload là "execution evidence, so only an executing role may create or read
 one". Guard TARGET_FACING_OPERATIONS.payload_write (tool-policy.ts:24) chỉ chặn reporting. Edge: lead delegated tạo payload rồi không có worker
 nào chạy nó → payload mồ côi, và isReplayable vẫn true vì chỉ so 2 ref.

 W7 — "Execute nothing" của reporting vs p2o_research có fetch mạng.
 src/duties.ts:65 ("execute nothing"), src/tool-policy.ts:12-14 cố ý giữ p2o_research, và extensions/p2o/index.ts:927-931 chạy
 sandbox.fetchResearch(...) thật. Chặn bởi curatedSource() (chỉ URL trong corpus) nên không chạm target — nhưng câu chữ trong duty và tool-policy
 đang nói dối nhau; edge case: corpus chứa URL trùng origin target thì "synthesis-only" vẫn phát request ra ngoài.

 W8 — Không có trần tổng cho skill inline.
 MAX_SKILLS = 3 (roles.ts:54) chỉ giới hạn số, mỗi body không bị chặn tổng: 3 file lớn nhất = 27,201 B (web-object-authorization 9,755 +
 web-route-input-inventory 8,855 + attack-surface-mapping 8,591). resolveRole còn câm lặng cắt: roles.ts:164 .slice(0, MAX_SKILLS) — operator cấu
 hình 4 skill thì mất 1 mà không cảnh báo.

 W9 (edge) — Boilerplate trùng trong 35/35 SKILL.md. 34 file mở đầu bằng đúng một câu "Before first use, read the [scope baseline]… and [handoff
 contracts]…". Link được rewrite thành p2o-skill:shared:scope (src/skills.ts:114-120) nên resolve được (không phải link chết — tôi đã kiểm),
 nhưng 3 skill inline = 3 lần cùng hai pointer = 2 lượt gọi tool thừa nếu model tuân thủ.

 ────────────────────────────────────────────────────────────────────────────────

 2. Xung đột & Mâu thuẫn

 ┌────┬────────────────────────────────────────────────────┬─────────────────────────────────────┬──────────────────────────────────────────────┐
 │ #  │ Cặp mâu thuẫn                                      │ Vị trí                              │ Bản chất                                     │
 ├────┼────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────┤
 │ C1 │ "must produce at least one intent" ↔ "no feasible  │ prompts.ts:93 ↔ prompts.ts:80       │ Một luật bắt hành động, một luật bắt dừng;   │
 │    │ direction means blocked/human-needed, never invent │                                     │ không nói luật nào thắng. Host không phân    │
 │    │ work"                                              │                                     │ xử.                                          │
 ├────┼────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────┤
 │ C2 │ "Your assigned objective is your whole job" ↔      │ prompts.ts:110 ↔ prompts.ts:116     │ Biên của "objective" bị xoá; duty line lại   │
 │    │ "follow the chain that intent opens … instead of   │                                     │ nói "nothing that belongs to another         │
 │    │ stopping at the edge of the brief"                 │                                     │ purpose" (duties.ts:88-93). Ba phát biểu, ba │
 │    │                                                    │                                     │ biên khác nhau.                              │
 ├────┼────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────┤
 │ C3 │ reporting duty "execute nothing" ↔ role giữ        │ duties.ts:65 ↔                      │ Vi phạm chữ nghĩa của chính duty.            │
 │    │ p2o_research (fetch trong sandbox)                 │ tool-policy.ts:12-14,               │                                              │
 │    │                                                    │ extensions/p2o/index.ts:927-931     │                                              │
 ├────┼────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────┤
 │ C4 │ Validation "never a new discovery" ↔ skill mặc     │ duties.ts:42-46,64-68 ↔             │ Skill dạy đúng việc duty cấm.                │
 │    │ định exploitability-assessment; reporting "no new  │ roles.ts:42,46                      │                                              │
 │    │ claim" ↔ remediation                               │                                     │                                              │
 ├────┼────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────┤
 │ C5 │ Independence = "matching conclusion + receipt" ↔   │ prompts.ts:98 ↔ src/cases.ts        │ Prompt lỏng hơn gate → lead khai             │
 │    │ host đòi cùng sha256 payload + fingerprint         │ (P14.12)                            │ independence, host từ chối, tốn 1 vòng.      │
 ├────┼────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────┤
 │ C6 │ "limit severity to demonstrated impact" ↔ rate đòi │ prompts.ts:99 ↔                     │ Model phải học luật qua thông báo lỗi.       │
 │    │ effect/reach/demonstratedThrough                   │ case-tool.ts:6,28-29, cvss.ts:38    │                                              │
 ├────┼────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────┤
 │ C7 │ Ba skill cùng nhận vai "làm trước":                │ skills/*/SKILL.md frontmatter       │ Trigger chồng lấn; chỉ một cái là default    │
 │    │ web-deployment-hygiene "Use first",                │                                     │ của mapping, nên thứ tự đúng không bao giờ   │
 │    │ web-route-input-inventory "Use before behaviorally │                                     │ được chọn tự động.                           │
 │    │ testing", attack-surface-mapping "Use before       │                                     │                                              │
 │    │ choosing code to audit"                            │                                     │                                              │
 ├────┼────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────┤
 │ C8 │ "Run p2o_task action=match … before creating" ↔    │ tool-guidelines.ts:13 ↔             │ Một bên đòi lượt gọi trước, một bên thưởng   │
 │    │ p2o_delegate "immediately spawn one focused worker │ p2o_delegate description            │ cho sự tức thời; p2o_delegate không có work  │
 │    │ when capacity is free"                             │                                     │ chỉ trả workMatch:'unknown'                  │
 │    │                                                    │                                     │ (extensions/p2o/index.ts:1463).              │
 └────┴────────────────────────────────────────────────────┴─────────────────────────────────────┴──────────────────────────────────────────────┘

 ────────────────────────────────────────────────────────────────────────────────

 3. Hành vi làm giảm năng lực / friction

 D1 — Nghi thức 3–4 lượt cho một câu hỏi. match → create → reserve/dispatch → (sau đó) review. p2o_task description (786 B) mô tả 4 action;
 guideline bắt buộc match trước. Không có host gate nào cần lượt match — nó là lễ nghi prompt-only, tăng latency tuyến tính theo số task.

 D2 — Đường chain tốn 3 lượt và không được quảng bá. p2o_graph {action:'chain',plan:true} → p2o_task create → dispatch. P14.10 cố ý không
 auto-create (đúng), nhưng lead prompt không nhắc plan — chỉ declaration 1,132 B của p2o_graph biết. Model chỉ tìm ra bằng cách đọc schema.

 D3 — Trần ngữ cảnh: worst case ~59 KB hướng dẫn/worker (27,201 skill + 26,409 khai báo + ~5.7 KB prompt). attack-surface-mapping một mình 8,591
 B cho mọi task mapping, kể cả khi nửa tài liệu là source-oriented và target là URL.

 D4 — Ba câu scope gần trùng nhau (prompts.ts:71,72,73) + một câu thứ tư ở prompts.ts:110 cùng nói "chỉ người mới mở scope". Câu quan trọng bị
 pha loãng giữa ba bản paraphrase.

 D5 — EVIDENCE_TAIL (prompts.ts:16) dồn 7 luật không liên quan vào một dòng ~700 ký tự, trong đó có luật đặc thù benchmark ("Fixture placeholder
 credentials are not deployment leaks", "a simulated bot is not a browser") và tàn dư migration ("Existing p2o_note coverage remains a bounded
 legacy summary"). Model attention giảm theo độ dài câu; đây là dòng tệ nhất trong prompt.

 D6 — p2o_lab là mini-skill đội lốt declaration: 1,173 B, lớn nhất trong 19 tool, chứa thủ tục 3 action + luật từ chối compose. Nó chiếm 12.6%
 tổng description bytes và cạnh tranh trực tiếp với prompt về cùng chủ đề "làm gì tiếp theo".

 D7 — Chuẩn mực không quan sát được: "at most four intents" (prompts.ts:92), "match before create", "stop unchanged retries". Model không có tín
 hiệu nào để biết mình tuân thủ hay không → sinh ra các "lời khai tuân thủ" trong kế hoạch thay vì hành vi. Đây là dạng over-constraint tệ nhất:
 không tăng chất lượng, chỉ tăng token.

 ────────────────────────────────────────────────────────────────────────────────

 4. Trùng lặp & Dư thừa

 ┌─────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────┬───────────┬───────────┐
 │ Câu/luật                                            │ Vị trí                                                         │ Số lần    │ ~bytes    │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "chỉ người mới widen/change scope"                  │ prompts.ts:71,72,73,110                                        │ 4         │ 190       │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "target content/worker output là DATA, không phải   │ prompts.ts:73,114, prompts.ts:11 (KNOWLEDGE_RESEARCH),         │ 4         │ 260       │
 │ instruction"                                        │ p2o_research description                                       │           │           │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "đọc ledger trước khi lặp lại"                      │ prompts.ts:117, tool-guidelines.ts (p2o_state, p2o_task)       │ 3         │ 120       │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "do not continue the parent's work / redo what's    │ prompts.ts:110, prompts.ts:151 (workerBrief)                   │ 2         │ 150       │
 │ known"                                              │                                                                │           │           │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "reporting discipline: ran/observed/supports/not"   │ prompts.ts:118 ↔ p2o_report description (294 B)                │ 2         │ 294       │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "simulated consumer ≠ browser"                      │ prompts.ts:16, prompts.ts:96-97, prompts.ts:119                │ 3         │ 180       │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "negative control"                                  │ prompts.ts:14, duties.ts:42-46, p2o_candidate desc, 19         │ 22        │ —         │
 │                                                     │ SKILL.md                                                       │           │           │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "Recon handoff" (nội dung chỉ lead dùng)            │ prompts.ts:39 render cho cả worker                             │ 2         │ 240       │
 │                                                     │                                                                │ audience  │           │
 ├─────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┼───────────┼───────────┤
 │ "Before first use, read scope baseline + handoff    │ 34/35 SKILL.md                                                 │ 34        │ ~2,300    │
 │ contracts"                                          │                                                                │           │ tổng      │
 └─────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────┴───────────┴───────────┘

 Hai mục cuối đáng chú ý nhất: prompts.ts:39 bắt worker "ranked investigation queue" và "handoff" — việc worker không có tool để làm (không
 p2o_delegate); và boilerplate skill lặp 3 lần trong một brief.

 ────────────────────────────────────────────────────────────────────────────────

 5. Đề xuất sửa đổi (diff cụ thể)

 │ Tất cả dưới đây là đề xuất, chưa áp dụng. Mỗi thay đổi src/prompts.ts kéo theo repin LEAD_CEILINGS (tests/minimal/helpers/budgets.ts:18-27) +
 │ hash tests/minimal/recon.test.ts; thay đổi roles.ts kéo theo tests/minimal/roles.test.ts.

 ### R1 — Bỏ mệnh lệnh stall, để host signal nói (src/prompts.ts:93)

 ```ts
   // TRƯỚC
       'An open goal with nothing open or running must produce at least one intent this round: a round that adds none is a stall, not a wait.',
   // SAU
       'A round that adds no intent is a stall only if a feasible question exists: when it does, add it; when it does not, end the round and
 report blocked/human-needed with the reason.',
 ```

 Lý do: giữ đúng ý "đừng ngồi không", bỏ mệnh lệnh tuyệt đối, và trỏ về nhánh blocked đã có ở prompts.ts:80. Host vẫn render 0 open
 (situation.ts:121) nên tín hiệu không mất.

 ### R2 — Đồng bộ prompt với gate P14.9/P14.12 (src/prompts.ts:98-99)

 ```ts
   // TRƯỚC (98)
       'Give each candidate explicit closure: confirmed with evidence, ruled_out with the specific effective control and location, or
 open_proof_gap. Independent verification requires a separate worker reproducing the effect with a current matching conclusion and reviewable
 receipt; withdrawn or stale support cannot validate a revised claim.',
   // SAU (98)
       'Give each candidate explicit closure: confirmed with evidence, ruled_out with the specific effective control and location, or
 open_proof_gap. Independent verification means another worker reproduced the same effect with its own receipt and the same payload sha256 in an
 environment with the same recipe fingerprint: without those the case stays ratable but not independent. Withdrawn or stale support cannot
 validate a revised claim.',
 ```

 ```ts
   // TRƯỚC (99)
       'Preserve evidence links, controls, limitations and revision history. Record coverage, including ruled-out and unresolved surfaces. Argue
 counterevidence, calibrate confidence and limit severity to demonstrated impact.',
   // SAU (99)
       'Preserve evidence links, controls, limitations and revision history. Record coverage, including ruled-out and unresolved surfaces. Argue
 counterevidence and calibrate confidence. Severity is computed, not chosen: rate each executed chain step with the effect it showed, and the
 case cannot score above the furthest step that actually ran.',
 ```

 Đây là finding quan trọng nhất về mặt vận hành: hai gate mới nhất đang dạy model qua thông báo lỗi thay vì prompt.

 ### R3 — Giải mâu thuẫn objective ↔ chain (src/prompts.ts:110,116)

 ```ts
   // TRƯỚC (110)
       'Your assigned objective is your whole job. Do not continue the parent\u2019s work, do not re-derive what the brief lists as already
 known, and do not widen scope — only the human can change scope.',
   // SAU (110)
       'Your assigned objective is your whole job. Follow it into the effects it directly enables (the duty line names how far); do not continue
 the parent\u2019s work, do not re-derive what the brief lists as already known, and do not widen scope — only the human can change scope.',
 ```

 và bỏ vế xung đột ở dòng 116:

 ```ts
   // TRƯỚC (116, nhánh non-reporting)
       'TACTICAL AUTONOMY: choose the steps/tools for your intent, and follow the chain that intent opens — when one step\u2019s actual output is
 the input of the next, take the next step instead of stopping at the edge of the brief. Record material observations …',
   // SAU
       'TACTICAL AUTONOMY: choose the steps/tools for your intent, and take the next step only when this step\u2019s actual output is its input
 and the duty line\u2019s purpose covers it; otherwise report the link. Record material observations …',
 ```

 Nguyên tắc: biên của "objective" phải được duty line định nghĩa, không phải một câu thứ hai trong prompt.

 ### R4 — Skill mặc định theo target kind và theo capability (src/roles.ts:37-47)

 ```ts
   // TRƯỚC
   export const PURPOSE_SKILLS: Record<WorkPurpose, readonly string[]> = {
     mapping: ['attack-surface-mapping'],
     discovery: ['source-code-auditing'],
     investigation: [],
     refinement: ['source-code-auditing'],
     validation: ['exploitability-assessment'],
     retest: ['remediation'],
     exploitation: ['exploit-design'],
     chaining: ['exploit-design'],
     reporting: ['remediation'],
   };
   // SAU
   export const PURPOSE_SKILLS: Record<WorkPurpose, readonly string[]> = {
     mapping: ['attack-surface-mapping'],       // source; URL/hybrid override below
     discovery: ['source-code-auditing'],
     investigation: [],
     refinement: ['source-code-auditing'],
     // Reproduction is not impact assessment: the duty forbids new discovery.
     validation: [],
     retest: [],
     exploitation: ['exploit-design'],
     chaining: ['exploit-design'],
     // Synthesis only: no fix authoring while the reader-ready report is the deliverable.
     reporting: [],
   };

   /** W3: a URL or hybrid run maps the deployment, not the source tree, and validation/retest get no method skill. */
   export function purposeSkills(purpose: WorkPurpose, kind: 'directory' | 'url' | 'hybrid'): readonly string[] {
     if (purpose === 'mapping' && kind !== 'directory') return ['web-deployment-hygiene'];
     if (purpose === 'discovery' && kind === 'url') return ['web-route-input-inventory'];
     return PURPOSE_SKILLS[purpose];
   }

   /** W4: the ladder follows the primitive a step consumes, so it is derived where the need is known. */
   export function exploitationSkills(kind: 'directory' | 'url' | 'hybrid', needs: readonly { kind: string }[]): readonly string[] {
     const ladder: string[] = [];
     if (needs.some(n => n.kind === 'net.egress')) ladder.push('ssrf-to-internal');
     if (needs.some(n => n.kind === 'exec.code')) ladder.push(kind === 'directory' ? 'binary-exploit-ladder' : 'web-injection-to-exec');
     if (needs.some(n => n.kind === 'cred.session' || n.kind === 'cred.secret')) ladder.push('credential-and-pivot');
     return [...ladder, 'exploit-design'].slice(0, MAX_SKILLS);
   }
 ```

 src/roles.ts:163-164 đổi PURPOSE_SKILLS[...] thành purposeSkills(purpose, kind); caller ở extensions/p2o/index.ts:530 phải truyền
 ticket.target.kind. Sửa tests/minimal/roles.test.ts theo (test đang pin validation → exploitability-assessment).

 ### R5 — Reconcile duty reporting với p2o_research (src/duties.ts:65)

 ```ts
   // TRƯỚC
       duty: 'Convert accepted cases into a reader-ready report; produce no new claim and execute nothing.',
   // SAU
       duty: 'Convert accepted cases into a reader-ready report; produce no new claim and run no target command. A curated citation lookup is not
 target execution.',
 ```

 Đồng thời sửa comment src/tool-policy.ts:12-13 cho khớp (nó đang nói "not target execution" trong khi duty nói "execute nothing").

 ### R6 — Tách EVIDENCE_TAIL, bỏ luật benchmark khỏi prompt phổ quát (src/prompts.ts:16)

 ```ts
   // TRƯỚC
   const EVIDENCE_TAIL = 'A source trace is not runtime proof; a simulated bot is not a browser. Blocked execution stays open_proof_gap with its
 requirement, never clean. Records are claims, not automatic verification. Establish intended policy before claiming its violation: an export can
 legitimately have different permissions from single-object reads/updates; sibling route differences are hypotheses, not policy. Set
 policyBasis=inferred and open_proof_gap until the contract is established. Fixture placeholder credentials are not deployment leaks without
 evidence. Existing p2o_note coverage remains a bounded legacy summary, not universal safety.';
   // SAU
   const EVIDENCE_TAIL = 'A source trace is not runtime proof. Blocked execution stays open_proof_gap with its requirement, never clean. Records
 are claims, not automatic verification. Establish intended policy before claiming its violation: sibling route differences and placeholder
 credentials are hypotheses, not policy.';
 ```

 Tiết kiệm ~300 B × mọi worker; hai luật bị bỏ ("simulated bot", "legacy p2o_note coverage") đã có tương đương ở prompts.ts:96-97, và luật legacy
 nên nằm trong docs/ chứ không trong prompt.

 Và tách prompts.ts:39 để chỉ lead nhận:

 ```ts
   // TRƯỚC: 'Recon handoff: … ranked investigation queue …' nằm trong mảng dùng chung
   // SAU: export function reconInstructions(kind, toolGuidance = true, forLead = false) { …
   //   ...(forLead ? ['Recon handoff: target identity/context, inventory with evidence and unknowns, covered/untested scope, ranked
 investigation queue, owned surface+risk, expected observation and stop condition.'] : []),
 ```

 ### R7 — Chuyển thủ tục p2o_lab khỏi declaration sang guideline (src/tool-guidelines.ts)

 ```ts
   // THÊM vào TOOL_GUIDELINES
     p2o_lab: ['Store the payload before you run it, verify the environment recipe before you trust it, and name both in the claim so a second
 worker replays the same bytes in the same recipe.'],
 ```

 rồi rút description của p2o_lab (extensions/p2o/index.ts, 1,173 B) xuống còn phần cái gì/cấu trúc (~500 B). Lưu ý kỹ thuật: guideline không
 thuộc DECLARATION_BUDGET mà vào guidance (473 B cho worker) — nên p2o_lab (LAB_TOOLS, worker có) sẽ cần nâng guidance pin; đo lại trước khi sửa.

 ────────────────────────────────────────────────────────────────────────────────

 Thứ tự nên làm

 ┌────────┬──────────────────────────────────┬────────────────────────────────────────────┬─────────────────────────────────────────────────────┐
 │ Ưu     │ Việc                             │ Rủi ro                                     │ Gate kiểm                                           │
 │ tiên   │                                  │                                            │                                                     │
 ├────────┼──────────────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────────┤
 │ 1      │ R1 + R2 (an toàn chống           │ Thay đổi bytes prompt → repin              │ npx vitest run tests/minimal/recon.test.ts          │
 │        │ hallucination, chi phí thấp)     │ LEAD_CEILINGS, hash recon.test.ts          │ tests/minimal/measure-context.test.ts               │
 ├────────┼──────────────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────────┤
 │ 2      │ R3 (biên objective)              │ Tranh chấp với duty line — phải sửa cùng   │ dutyLine drift test + linear worker prompt          │
 │        │                                  │ lúc duties.ts                              │                                                     │
 ├────────┼──────────────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────────┤
 │ 3      │ R4 (skill theo kind/capability)  │ Đổi hành vi chọn skill; roles.test.ts phải │ tests/minimal/roles.test.ts, wstg-skills.test.ts    │
 │        │                                  │ viết lại                                   │                                                     │
 ├────────┼──────────────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────────┤
 │ 4      │ R5 + R6 (chữ nghĩa + cắt nhiễu)  │ Prompt ngắn hơn → pin giảm, không được tự  │ python3 scripts/validate_library.py                 │
 │        │                                  │ ý nới                                      │                                                     │
 ├────────┼──────────────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────────┤
 │ 5      │ R7 (declaration ↔ guideline)     │ Ảnh hưởng DECLARATION_BUDGET/guidance      │ chỉ số đo lại, không đoán                           │
 └────────┴──────────────────────────────────┴────────────────────────────────────────────┴─────────────────────────────────────────────────────┘

 Bốn phát hiện tôi đánh giá cao nhất về rủi ro thực tế: W1/C1 (luật stall đẩy bịa việc), W2/C5-C6 (prompt lệch hai gate mới nhất nên model chỉ
 học qua lỗi), W3-W5 (skill mặc định dạy sai việc duty cấm), W8/D3 (trần skill inline không tồn tại, worst case 27 KB/brief). Ba nhóm này đều sửa
 được mà không cần thêm tool hay bảng dữ liệu mới — chỉ cần sửa văn bản và một hàm dẫn xuất.