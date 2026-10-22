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
