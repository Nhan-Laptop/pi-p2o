# planning_update.md — ARTEX / Strix / incident-report study and proposed p2o updates

Status: **planning only. No code changed.** Written 2026-10-21. Supersedes the `--refer-workspace` plan (implemented as `7088bfa`).
It builds on, and does not repeat, the 2026-10-11 study (`git show 656843d:planning_update.md`; of its Phase 3, items 3.1/3.3/3.4 shipped,
3.2/3.5/3.7/3.8 stayed open and are folded in below where the new evidence changes them).

The question set: (1) how ARTEX delegates, keeps a long-term target, and runs its asset and vulnerability graphs; (2) how Strix plans by
use case and situation; (3) what the piyolog article adds; (4) where p2o stands; (5) what to change.

## 0. Method, sources, limits

| Source | How it was read | Grade |
|---|---|---|
| `my_references/ARTEX/ARTEX_AGENTIC_CORE.vi.md` (2026-10-08, own CONFIRMED / STRONGLY INFERRED / UNKNOWN tags) | Read in full for §1–§8; cited as `[core §n]` | Secondary, but it cites its own source lines |
| ARTEX source | Opened directly: `agent/planner.go:150-345` (trigger rendering + Planner prompt), `agent/finding_workflow.go`, `finding_recorder.go`, `retester.go`, `constraints.go`, `guard/guard.go`, `db/schema.sql:1081-1175` | Primary |
| Strix | A research agent read `strix/` and wrote `strix_analysis.md`; file:line values are its own (marked `~` where approximate) | Primary, agent-reported, not re-opened by me except where stated |
| piyolog article, 2026-10-06 (updated to 10-20) | Fetched; summarized in §3 | Secondary news aggregation; attribution in it is explicitly unconfirmed |
| p2o | Read from files: `docs/*.md`, `src/prompts.ts`, `src/engine.ts`, `src/target.ts`, `src/wstg-map.ts`, `src/state/store.ts:461`, `src/case-types.ts`, `extensions/p2o/index.ts` | Primary |

**Limit that matters:** the first ARTEX research agent was stopped by a safety classifier mid-write and left nothing usable. A second
Sonnet 5.5 agent, scoped to architecture only and read-only, then re-read the ARTEX tree against the core document and wrote a cited report
(~5.9K words, every claim with a file:line; session scratch file, not in the repo). Its corrections are folded into §1.1–§1.4 and its
additions are in §1.6. I spot-read the same files earlier (see table) but did not re-open each of its new citations; a few it marks
unverified because they depend on the private agent SDK that is not in the tree. Nothing in either reference tree was run, built or
installed. Both are used only for architecture ideas; the prompt text that tells a model to ignore authorization (Strix `scope.jinja`,
`REFUSAL AVOIDANCE`) is not borrowed, consistent with `src/prompts.ts:14-16`. Mechanics-level evidence says nothing about effectiveness; no
benchmark was run (standing rule: no paid runs).

---

## 1. ARTEX — what it does

### 1.1 Task delegation  `[core §3, §7]`

```text
goal decomposer (round 0, one shot) → goals + constraints + scope        agent/goals.go
Planner LLM  (fresh session every wake)  → add_intent (batch ≤4), prove_goal, steer_work, kill_work, todo
   intent = graph node kind=intent, state=open, payload {summary, asset_ids}, priority
N workerLoops claim atomically open→running (priority, id)               server/engine.go
Worker LLM (one session per intent, resumable by intent id) → insert_assets / record_fact / report_finding
settle: done | blocked | exhausted | stopped → debounce (800 ms fixed window; 600 s heartbeat fallback) → Planner wakes
```

- No agent calls another; the graph is the only channel (blackboard). The Planner is **memoryless between wakes**: each wake renders
  *what changed* (`renderTriggers`: finished intent + worker conclusion ≤800 runes + IDs of facts it yielded; finding; goal added/edited/deleted;
  hint; cancelled intent) plus a pre-fetched graph overview plus the in-memory todo (`planner.go:154-285`).
- **There is no dependency-aware scheduler**: `claimNext` takes `state='open'` by priority. Serial chains are the Planner's job: write the chain
  into the todo and dispatch only the step whose prerequisite fact exists (`planner.go` prompt, "串行利用链"). `[core §7.1]`
- **Steering without killing**: `steer_work` queues a message; a PreToolUse hook blocks the worker's *next* tool call and returns the redirect.
- **Human in the loop**: a thin MainAgent adds hints, goals, constraints and priority 8–10 intents; the Planner is re-woken with a typed trigger.
- **Guard** (`guard/guard.go`): every tool call passes PreToolUse → audit log → DB intercept rules → LLM fallback judge → optional human `ask`
  (blocks if refused or timed out). Deny messages are rewritten as *"ARTEX platform governance, not a target defense… this operation is
  forbidden"* so the agent does not treat them as a WAF to bypass (`systemBlockMessage`). A PostToolUse hook classifies results into
  ok / blocked / error by regex (`403|waf|429|captcha…`) so the Planner changes tactics instead of giving up (G5 attribution).
- Role boundary is mostly **prompt policy**, not hard enforcement: only "Worker has no `add_intent`" is a real tool-surface limit; the Planner
  also holds Bash, and the Planner and MainAgent sessions get no Guard hooks (only the Worker does; `planner.go:405-440`, `mainagent.go:135-166`, `worker.go:471-473`). Verified in source.

**Planner rules worth knowing** (`planner.go` prompt, my translation): *hard floor* — goal unmet and nothing open/running ⇒ must emit ≥1 intent
(an empty round is a stall); zero intents is fine only if covered or waiting on a dependency; never re-send a `done` intent unless the mechanism
is materially new; for `exhausted`/`blocked`, read the worker trace first and continue from real progress; a negative observation is re-checked
**at most once**; **depth over coverage**; keep 2–3 mechanistically different routes alive; operator constraints outrank every heuristic;
a quantitative goal (e.g. coverage 100%) must be checked against the measured value before `prove_goal`.

### 1.2 Keeping the long-term target  `[core §8]`

| Layer | What persists | Used how |
|---|---|---|
| Goals | `goal` nodes (`open/met/abandoned`) + operator **constraints** (allow/deny) + scope, written once at round 0 | Goals are in every overview; **constraints are injected into every Planner and Worker system prompt**, framed above all heuristics (`constraints.go`); constraints must be self-contained (no "the current target") |
| Exploration graph | intents, facts, findings, hints, digests; edges `spawns / derived_from / yields / proves / covers` | Overview windows: 30 open intents, 20 facts, 12 recent-done, 10 finding details |
| Compaction | Cold nodes (≥6 planner rounds) summarized by an LLM into `digest --covers--> members`; originals kept, `expand_digest` restores | Separate from conversation compaction |
| Cross-task | Direct source tasks' blackboard, read-only, tagged inherited (≤8 sources, 48k runes) | Already mirrored by p2o's `--refer-workspace` |
| Todo | Planner todo is **in-process memory only** | Lost on restart `[core §8.1]` |
| Completion | `prove_goal(goal, evidence)` per goal; the last goal auto-finishes the task. The judge is the Planner LLM, not code | |

SDK long-term memory exists but is not enabled in the default Planner/Worker options (UNKNOWN for any deployment). `[core §8.1]`

### 1.3 Asset graph  `[core §4]`

- One global Postgres `assets` table, **six types** (`root_domain, ip, subdomain, service, endpoint, app`); port, technology, credential and
  parameter are *fields*, not nodes. **No asset-edge table**: parent links are fields, and `BuildCoverageGraph` derives a child→parent
  containment view on demand.
- **Natural-key upsert-merge** (`ON CONFLICT DO UPDATE`): endpoint = `url+method`, HTTP service = `url`, subdomain = `domain+record_type`.
  Normalization is deliberately light (host lower-cased, trailing dot dropped, scheme/host lower-cased; no full URL canonicalization).
- LLM proposes, Go writes: `insert_assets` → `Upsert*` (infers domain/port/root, merges arrays) → `anchorOwner` links the intent to the asset →
  auto-scope for directly registered hosts. **Nothing turns stdout into assets automatically.**
- **Asset graph ≠ exploration graph**: assets answer "what exists", the exploration graph answers "what was concluded, from where";
  they join through `exploration_anchors(node, asset)`.
- Coverage proxy = `tested / denominator` where *tested* = asset anchored by a `fact` node (no check on confidence or method); `list_untested_assets`
  returns a backlog the Planner may act on. Honest in its own doc: a coarse proxy, not certification.
- Weaknesses it admits: tool-facing reads are task-scoped but the Worker bootstrap reads intent assets unscoped; `Link` errors are ignored on the
  intent/fact paths, so edges can be missing after a failed write.

### 1.4 Vulnerability / finding graph  `[core §5]` + source

- A finding is **three things written atomically** (`RecordFindingTx`): an exploration node `kind=finding` (`confirmed/dismissed`), a row in
  `findings` (disposition `pending, in_progress, confirmed, resolved, fixed, false_positive, ignored, duplicate, risk_accepted`; markdown `report`;
  `asset_ids`), and the edges `intent --yields--> finding` and (when used) `finding --proves--> goal`.
- The agent never writes evidence bodies: a host-owned `FindingRecorder` does. HTTP evidence is bound through `finding_traffic_bindings`
  (`role ∈ baseline | proof | verification | supporting`, ordered `position`, unique per finding+snapshot, optional `version`) — `finding_workflow.go`,
  `schema.sql:1163-1174`. A **reporter agent binds traffic first, then writes the report**, citing the binding `version` it actually read.
  Domain and timestamp are only candidate filters, never proof of belonging.
- **Retest is its own entity** (`finding_retests`, `schema.sql:1112-1129`): a snapshot of the finding is frozen at start; one active retest per
  finding (partial unique index); verdict `reproduced | fixed | inconclusive`; `fixed` needs a comparable environment, the original trigger no longer
  working, **and a still-working normal control**; one failed request or an unreachable target is `inconclusive`, never `fixed`; a `fixed`
  verdict flips the disposition automatically, the other two leave it (`retester.go`).
- Weaknesses: `report_finding` only *requires* `vulnclass, severity, summary`; "confirmed" is the agent's assertion; no PoC is re-run by code;
  I found **no structural duplicate fingerprint** in what I read (`duplicate` is a human-set disposition) — not proven absent. `[core §5.1]`

### 1.5 ARTEX vs p2o, in one line each

ARTEX optimizes **autonomy and throughput** (stateless planner, claim-by-priority, graph as channel, LLM judges goal completion). p2o optimizes
**honest closure** (human-confirmed authority, structured work identity, claim → case → finding, explicit coverage denominator, nothing counts as
clean without a named control). The useful transfers are therefore *inputs and plumbing*, not ARTEX's acceptance logic.

### 1.6 Fresh source sweep — corrections and additions

Corrections to the core document and to my first reading:

- The task-level scheduler is `Engine` plus `admitTaskWhen` / `reconcileConcurrency` (`server/goals.go:99-285`). `server/scheduler.go` is only a
  5 s ticker for user-defined custom-agent triggers (the reporter runs from it).
- "Priority 8–10 for the MainAgent" is prompt guidance only (`mainagent.go:92`); code takes any 0–10 and turns a 0 into 5, so "lowest priority"
  cannot be expressed (`tools.go:1047-1049`).
- `ClaimIntent` is a single `UPDATE … WHERE state='open'` with no lease or heartbeat; orphaned `running` rows are reset to `open` only at process
  start (`db/exploration.go:1173-1181`, `server/server.go:269-275`). Single-process assumption.

Additions that bear on p2o's design:

| ARTEX fact | Source | Why it matters here |
|---|---|---|
| Operator constraints are prompt text only. The LLM judge is documented as receiving no task goal and no constraints; the MainAgent does not get the block either; the RoE scope mechanism "was removed" | `constraints.go:14-48`, `intercept/prompt.go:12`, `mainagent.go:134`, `guard.go:4` | Confirms U1 should stay *soft* and never be described as enforcement. p2o's hard edge stays the human-confirmed target and scope |
| The planner has a `goal_met` tool that ends the task, while its own prompt says only `prove_goal` finishes; `prove_goal` accepts any fact or finding as evidence, including `inferred` ones | `tools.go:1205-1214, 1179-1182`, `planner.go:315` | A model-judged close is exactly what p2o's deterministic engine avoids. Strengthens the "not proposed" row for LLM-judged completion |
| Agents widen their own scope: every top-level `insert_assets` item adds a scope row, and the planner owns `add_task_scope` | `tools_insert.go:359-364`, `tools.go:2047-2050` | p2o's scope is human-only. Keep it that way; do not add an agent-side "extend scope" path |
| A resumed worker no longer receives the global overview (the first user turn becomes "continue") | `worker.go:488, 508-511` | p2o workers are fresh per assignment, so this class of bug does not apply. A point for U1 (re-send the objective on every worker) |
| Pending triggers, steer queue and planner todo are RAM-only; hints have a `consumed` state that nothing sets | `manager.go:1762-1860`, `engine.go:134`, `schema.sql:191` | The "what changed" block disappears on restart. p2o's packet is rebuilt from the store, which is the stronger design (U5 builds on it) |
| The graph reports `false_positive` findings anyway: node state and `findings.status` are never reconciled, the Markdown report ignores triage status, and there is no finding de-duplication | `server/server.go:3847-3858`, `tools.go:444-446` | p2o's claim → case → finding with review verdicts already avoids this; no transfer needed |
| Coverage "tested" counts any anchoring fact, including negative or inferred; the planner is nevertheless told to use the percentage as an acceptance check | `db/task_scope.go:319-324`, `planner.go:316` | Reinforces keeping p2o's two-axis coverage with a named control |
| Retest is reachable only from an HTTP handler; `reproduced` and `inconclusive` change no state; only `completed + fixed` flips status | `server/finding_retests.go:119`, `db/finding_retests.go:208-251` | Supports U9 as an operator-started, advisory flow rather than an engine-scheduled one |
| Denials: a human refusal and an approval timeout produce the same message; the block text names the platform, not the target | `guard.go:119, 138-141` | For U2, keep the "scope policy, not a target defense" wording and, in p2o, make a timeout distinguishable from a refusal |
| The G5 result classifier (`blocked`/`error`/`ok`) is write-only: nothing under `agent/` reads the counters | `guard.go:143-163`, `server/server.go:3870` | The idea only pays when something consumes it. U6 consumes it (a closure warning), so it is not just a dead counter |
| The planner prompt names an `asset_neighbors` tool that is not registered | `planner.go:313` | Prompt/tool-surface drift. No p2o change proposed; any new worker-facing text in U1/U2 should name only tools that exist |

None of these changes the ordering in §6. They change the *reasons*: U1 keeps the "soft, not enforcement" label, U9 stays operator-initiated,
and nothing is proposed that lets a model judge completion or widen scope.

---

## 2. Strix — how it plans by use case and situation

**Planning is prompt-driven; there is no planner code.** Python decides only which text and skills the root receives
(`core/inputs.py:107 build_root_task`, `core/runner.py:396-401`, `agents/prompt.py:58 _resolve_skills`).

| Situation | What changes | Mechanism |
|---|---|---|
| Target type (repo, local code, web app, IP, API spec) | Root task lists targets under typed headings; repos are cloned, API specs parsed for base URLs | `interface/utils.py:1140-1207`, `scan_setup.py` |
| Depth (`quick / standard / deep`, default `deep`) | A **scan-mode skill** is always loaded; quick = time-boxed, six priority classes, one pivot; deep = six phases, storyboard of flows, chaining, "parallel swarm" | `skills/scan_modes/*.md` |
| White-box (`local_code`) | Four extra skills; must do static **and** dynamic work; static floor = one semgrep, one secrets, one `trivy fs`, one AST pass | `runner.py:398`, SP:109-123 |
| Combined code + live | "Use code to steer live tests, live anomalies to steer code review" | SP:125-128 |
| Multi-target | Build a **Target Map** first, cross-correlate code and endpoints, one subagent per asset × vulnerability class | SP:92-100 |
| Diff-scoped | `scan_modes/diff` overlay: only bugs *introduced or newly reachable* by the diff; "read the code, not the PR story" | `diff.md` |
| API spec | Baseline each operation, track every `METHOD path`, probe undocumented sibling verbs, two-account diffs | `custom/api_spec_testing.md` |
| Operator text | `--instruction` appended **as free text** to the root task; no parser | `inputs.py:~185` |
| Black-box | Recon and mapping first, then per-vulnerability work; threat model written from recon results | SP:294-300, `coordination/root_agent.md:28-36` |

**Delegation**: root is told to orchestrate and never test (SP:3-11). `create_agent(name, task, inherit_context=True, skills≤5)`; the child gets the
**parent's whole history** as JSON background and shares sandbox, proxy history, notes, coverage and threat model; todos stay private. Each
vulnerability gets a **Discovery → Validation → Reporting** chain (white-box: the reporting agent also files the patch). `finish_scan` is the only
exit and refuses while children are alive, then echoes coverage gaps. **No cap on agent count or concurrency** in code; control is budget bands
(warn at 70/85/95 %, subagents stopped at 90 % of the dollar budget so the root can report: `core/hooks.py:49-53`).

**Skills** are chosen by the model from an `<available_skills>` list (~85 files), 1–3 pinned per agent (max 5, enforced `skills/__init__.py:224`).
A post-hoc check (`report/coverage.py:230 skill_coverage_gaps`) flags any carried skill with no matching coverage row. Prompt layout is
**shared prefix → requested skills → scope**, with a second cache point so sibling agents share a cached prefix.

**State**: shared notes, per-agent todo, a **threat model** (`save_` replaces, `amend_` appends attributed addenda), a coverage ledger keyed by
(surface, risk_area) with `agent_reported` kept apart from `machine_observed`. Findings: the agent supplies eight CVSS metrics and code computes
the score; mandatory `counterevidence, confidence, assumptions, severity_change_conditions`; `http_exchange_ids` verified against the proxy;
dedupe is an LLM judge ("when uncertain lean NOT duplicate"). Premature finish is blocked three ways (text-only turns re-prompted, only
lifecycle tools end a run, `finish_scan` fails with live children).

**Weaknesses (agent-reported):** no agent-count cap; rules like "only reporting agents file reports" contradict code (`factory.py`); skill choice
is unguided (no technology→skill map); `is_whitebox` appears to ignore cloned repo targets (**unverified**); no cross-run memory; full-history
inheritance is expensive; one old CTF benchmark (XBEN 100/104, v0.4.0, ≈$337, ≈19 min/challenge) is the only evaluation.

---

## 3. The piyolog article — what it adds

Summary (secondary source; the article itself says attribution is unconfirmed): ARTEX was a Go/Next.js/Postgres multi-agent pentest system
(asset graph + exploration graph, planner/worker, recording proxy, approval gate, chat intervention). It won Baidu's "Agent+" final on 2026-09-03.
Public reporting then tied ARTEX artifacts to the late-September attacks on two Korean banks (a title string on attacker web servers; CrowdStrike
reported ARTEX config and Claude Code session history in an attacker-controlled directory, with an ARTEX-running backend plus extra Claude Code
sessions on other models). The developer announced closed-source on 10-08 and the repository vanished by 10-09; forks, mirrors and Docker images
were already circulating (≥12 000 displayed fork count, not de-duplicated); a commercial version appeared later.

What a pentest-agent builder should take from it (design lessons, not attribution claims):

| Fact in the article | Lesson for p2o |
|---|---|
| Policy text ("personal learning only; do not attack systems, authorized or not") was the first control; **a consent gate and a default `.gov/.edu` block came in v0.3.13**, three weeks before the incident | Controls must be in the product's startup path, not the README. p2o already requires a typed human confirmation naming scope, resources and models (`ARCHITECTURE.md`); keep that the only source of authority |
| Approval gate began rule-only; a **model-judged fallback** for unmatched calls came in v0.3.3 | p2o's equivalent is the broker re-checking scope/ticket/budget per operation. A model judge is *not* proposed: it would make a security boundary probabilistic |
| Proxy default listen address moved to localhost-only in v0.3.12; 359–900 exposed instances were counted | p2o's authority is a local socket + per-worker tickets; no listening service. Worth a one-line statement in docs, nothing to build |
| Attacker directory held **session histories and config** | `--export` writes `.p2o-reports/` into the working directory (`evidence.ts:95`, `roles.ts:60`), redaction is "best effort". See U11 |
| Takedown did not stop distribution; "defensive" and localized forks appeared | Open-source release of an offensive loop is irreversible. p2o is a private Pi package; do not publish skills that embed exploit sequences (already the rule in `HANDOFFS.md`) |

Nothing from the article changes what p2o should *do on a target*; it changes how strongly the start-up path and the artifacts it leaves should
defend the operator.

---

## 4. p2o today, against the four questions

| Question | ARTEX | Strix | p2o now (verified) | Verdict |
|---|---|---|---|---|
| **Delegation** | Planner LLM → intents → claim pool | Root spawns agents freely, history copied | Operator's Pi conversation is the Planner; deterministic `AssessmentEngine` (`src/engine.ts`) admits an **accepted, reviewed, fingerprint-reserved** frontier into ≤N slots; fresh worker process per assignment; workers only *propose* (`p2o_request_subtask`); pinned prerequisites; wake windows 100 ms, no polling | **Ahead** on control, dedupe, authority. Behind on: backlog suggestions when the frontier is empty |
| **Long-term target** | goals + constraints in DB, injected everywhere | free-text instruction + threat model | `--goal` → request-local `STATED OBJECTIVE` in the **lead prompt only** (`prompts.ts:63`); `p2o_plan` goals/todos/decisions in SQLite (revisioned, evidence-gated closure); packet header refreshes state; `NO_GOAL_RECORDED` preflight. **Workers never see the objective or any operator exclusion** unless the lead copies it into a brief (`prompts.ts:105-128`, `index.ts:527`). The objective is **not stored** (`OwnerRun.statedObjective` only, `index.ts:95,1649`) and is absent from REPORT.md | **Gap** (U1) |
| **Asset graph** | 6 types, natural-key merge, derived containment view | none (notes + coverage rows) | SQLite graph, 12 kinds, identity = scope+kind+exact key, revision pins, provenance, stale propagation (`ASSET_GRAPH.md`). Keys are **exact bytes, no normalization** by design. `coverage` knows `discoveredUnplannedAssets` only as a **count** (`coverage.ts:35`) | **Ahead** on rigor. Two gaps: no canonical host/URL form (U7), no pointer backlog (U5) |
| **Vulnerability graph** | node + row + traffic bindings + retest entity | report tool with mandatory counterevidence fields, CVSS computed | candidate → case → unique accepted-current finding; duplicate by `policyKey`+`rootCauseKey`; `rate` with host-computed CVSS; coverage two-axis; remediation `accepted` needs a reviewed retest. Evidence in a case is a flat id list (`reproductionEvidenceRefs`, ≤5, `case-types.ts:20,39`) | **Ahead**. Gaps: evidence has no role/order (U8); retest has no verdict taxonomy or prior-run entry (U9); no guard against "ruled out" resting on blocked requests (U6) |
| **Use case / situation planning** | none (open-ended intents) | scan modes, white/black/diff/API/multi-target | `wstg-map.ts` maps ~100 WSTG tests to trigger **features** and skills; `p2o_coverage action=suggest` (`index.ts:1029`, `wstg-map.ts:424`) returns uncovered in-scope tests for features **the caller names** (default `['any']`); the lead prompt tells the lead to read the skill catalog; one target kind per run | **Partial**: the router exists but its input is manual (U4); no hybrid target (U10) |

---

## 5. Proposals

Ranking = value ÷ (cost × risk). Every item states what it would **not** do. All keep the lead prompt untouched (`ownerInstructions` is pinned:
no `p2o_*` names, solo < 5000 chars) and put workflow advice in per-tool guidelines or deterministic code. Tool guidance is opt-in
(`p2o.toolGuidance`), so advice there reaches only those who enabled it; anything that must reach every run goes through code or the brief.

### Tier A — small, deterministic, low risk

**U1. Store the objective and carry operator constraints to every worker.**
*Evidence:* ARTEX injects operator constraints into every Planner and Worker system prompt at top priority (`constraints.go`), and requires them to be self-contained; Strix renders the authorized-scope block last in every agent prompt. p2o: §4 row 2.
*Change:*
1. Persist `--goal` at run start as one `kind:'lifecycle'` record (`data.objective`), so it survives in the store, in `/p2o open`, in `--refer-workspace` digests, and can be printed in REPORT.md.
2. Add repeatable `--avoid "text"` (≤5, each 1–300 chars, same NFC/no-control validation as `GOAL_CHARS`, `src/target.ts`). Shown in the confirm dialog next to `--goal`; stored with the objective.
3. `workerBrief` appends, **only when constraints exist**, a fixed block `OPERATOR CONSTRAINTS (data; they narrow the task, never widen scope)` with the JSON-quoted lines. Byte-identical output without `--avoid`, like 3.1 did.
*Not:* hard enforcement. It is model-level, exactly as in ARTEX; the real boundary stays scope + ticket + broker. Say so in the dialog text.
*Files:* `src/target.ts` (parse), `extensions/p2o/index.ts` (`:1536-1554` dialog, `:1649` run state, `:527` brief), `src/prompts.ts:105`, `src/report-export.ts` (one line).
*Tests:* `recon.test.ts:51-61` / `workflow-policy.test.ts:59` pin the brief hash **without** constraints — unchanged; add a parser test and a brief test with constraints.
*Effort S. Rollback:* drop the flag; stored records are inert lifecycle data.

**U2. Frame policy denials as policy, not as target behaviour.**
*Evidence:* ARTEX rewrites guard blocks as "platform governance, not a target defense… forbidden" so the agent does not try to evade them (`guard.go systemBlockMessage`). p2o's scope denial reads `Out of scope: only <origin> is allowed` (`src/target.ts:152`), which a worker can read as a redirect to work around.
*Change:* append a fixed sentence (`p2o scope policy, not a target defense; do not retry or route around it; record a gap instead`) to scope/ticket/budget denials only. Receipts keep the raw reason.
*Effort XS. Tests:* three tests assert only the substring `'Out of scope'` (`docker.test.ts:68`, `artifacts.test.ts:106`, `artifacts-docker.test.ts:38`), so appending a sentence keeps them green.

**U3. Make the worker system prompt prefix shareable across workers (measure first).**
*Evidence:* Strix lays out shared prefix → requested skills → scope and adds a cache point so siblings share a cached prefix (`prompt.py:161`, SP:519-527). In p2o, `workerInstructions` begins with a per-worker line (`workerId`, `depth`, parent: `src/prompts.ts:88`), so the first characters differ for every worker and the large static body (recon, knowledge, evidence rules) cannot share a provider-side prefix with its siblings.
*Step 1 (free):* compute the common prefix length of two workers' full instruction text for one run. If the shared prefix is already large (Pi's own base prompt dominates), stop.
*Step 2 (only if it pays):* move the identity line to the end of `workerInstructions`. The instruction hash in `recon.test.ts` / `workflow-policy.test.ts` moves **on purpose** and is re-pinned.
*Not:* any claim of dollars saved; that needs a paid run, which is out of bounds. Report the prefix length only.
*Step 1 measured (2026-10-21, `dist/` build, no model call):* the worker system prompt is Pi's base prompt, then `\n\n`, then `workerInstructions` (`index.ts:1843`); all panes share one cwd, so Pi's part is the same for every worker. Inside `workerInstructions` two sibling workers share **85 of 5,966 characters (1.4 %)**; the other 5,816 characters (about 1,450 tokens at 4 chars/token) sit after the per-worker line and cannot be shared. Pi's base prompt is small here: 1.8 KB with no tool snippets, about 2.7 KB with 110-character snippets for the seven worker tools (an estimate: real snippets and the tool declarations that precede the system prompt were not measured). Pi's base therefore does **not** dominate, so the stop condition did not fire.
*Simulated step 2:* with the identity line moved to the end, two siblings share **5,901 characters** of the p2o text (5,895 across roles), roughly 1,450 more tokens, taking the shared prefix from about 450–700 tokens to about 2,000. That crosses the roughly 1,024-token minimum that common prompt caches use (confirm for the provider in use). Whether it saves anything depends on that provider's caching and on siblings starting within its TTL, which was not measured and cannot be without a paid run.
*Verdict:* worth doing; expected effect is real but unquantified. **Implemented 2026-10-21, uncommitted:** `workerInstructions` now opens with a static `P2O WORKER — …` line and ends with `Identity: you are <id> (role, depth); your parent is …`; the two instruction hashes in `recon.test.ts` were re-pinned on purpose (brief hashes unchanged) and a test asserts siblings share over 95 % of the text. The brief repeats `You are <id>`, so the identity is not lost by moving the line.
*Effort XS–S.*

**U4. Feed the WSTG router from recorded features instead of from the caller.**
*Evidence:* Strix's situation→skills mapping is flag-driven; p2o already has the better table (`WSTG_MAP`, trigger features) but `p2o_coverage action=suggest` only sees features the model types in, defaulting to `['any']` (`index.ts:1029`, `wstg-map.ts:424`). `HANDOFFS.md` H1 already tells recon to record each observed feature as an asset attribute named `feature` or as an observed fact.
*Change:* when the suggest call omits `features` (today it falls back to `['any']`), derive them from the run's graph: attribute `feature` values (and observed-fact tokens) that are members of `WSTG_FEATURES`; report which features were used so the result is auditable. Explicit `features` still wins.
*Not:* auto-creating cells or tasks. A suggestion is not coverage (`wstg-map.ts` comment).
*Effort S. Tests:* extend the suggest test with a fixture graph.
*Implemented 2026-10-21, uncommitted.* `featuresFromAttributeValues` (`wstg-map.ts`) and `recordedFeatureValues` (store, current heads only, bounded) feed the suggest handler when `features` is omitted. The result adds `featureSource` (`explicit`/`graph`/`default`) and `ignoredFeatureWords`. **Deviation:** only the `feature` attribute is read, not observed-fact text: a word like `api` or `roles` appears in most facts, so token matching would inflate the suggestions. No attribute means the old `['any']` behaviour, unchanged.

### Tier B — moderate, evidence-backed

**U5. Give the Planner pointers when the frontier runs dry.**
*Evidence:* ARTEX forbids an empty round while goals are open and exposes `list_untested_assets`; Strix's `finish_scan` echoes coverage gaps. p2o's stance (no invented work; empty frontier ⇒ explained-blocked, `PLANNER_ENGINE.md`) is right, but the Planner packet's `attention` list holds only **open gaps and pending reviews** (`src/state/store.ts:461`) and `discoveredUnplannedAssets` is a bare count (`coverage.ts:35`). So "blocked" arrives with nothing to choose from.
*Change:* add a bounded `backlog` section to the request-local packet (inside the existing ≤12 KiB cap), derived by SQL: (a) graph assets with no live coverage cell, (b) `open_proof_gap` / `blocked` cells whose `requirement` references a task that is now reviewed, (c) count of uncovered WSTG suggestions matching recorded features (U4). IDs only, with the usual shown/omitted counts.
*Not:* a dispatch, a score, or a model summary. The Planner still decides, and may still say `blocked`.
*Effort M. Risk:* packet-size tests (`context.test.ts`, the `maxBytes` accounting at `store.ts:470`). *Rollback:* remove the section; counts remain.
*Implemented 2026-10-21, uncommitted.* `ContextPacket.backlog` (planner role only) holds `unplannedAssets`, `cellsNotRun` and `wstgSuggestions` (a count plus the features used). Totals are exact and at most 5 IDs are listed per item; under a tight `maxBytes` the IDs are dropped first and the totals stay. With nothing waiting the key is absent and the packet is unchanged. **Deviation from item (b):** a cell has no `requirement` field, so "cells whose requirement references a now-reviewed task" could not be built; it became "cells declared `planned`/`unplanned` that nobody has run". Tests: a store-level test for the three items, the worker/reporting exclusion, a 4 KiB packet and the 900-byte backlog bound.

**U6. Advisory guard against "ruled out" that rests on blocked requests.**
*Evidence:* Strix's `counterevidence.md` lists "control on a different path", "missing information" and "difficulty" as **invalid** reasons to rule a candidate out; ARTEX's G5 hook classifies 403/429/WAF/captcha results as *blocked*, not *ok*. p2o's rule is the same in prose (`prompts.ts:79`) but nothing mechanical checks it.
*Change:* in case review / finish preflight, annotate (never reject) a `ruled_out` closure or a `ruled_out_bounded` cell whose every `negativeControls`/`evidenceRefs` receipt carries an HTTP status in {401, 403, 429} or a transport error; warning code e.g. `NEGATIVE_MAY_BE_BLOCKED`. Follows the existing `integrity: off | annotate | enforce` switch.
*First check:* where the HTTP status lives in the receipt (`evidence.ts:47` stores `exitCode`, `input`, `target`; confirm HTTP status is in `data` before relying on it).
*Effort S–M.*

**U7. Canonical form for host/URL asset keys (measure first).**
*Evidence:* ARTEX merges on lower-cased host / normalized URL + method, so the same service never becomes two rows. p2o keys are exact bytes by design (`ASSET_GRAPH.md`), which preserves truth for paths but lets `https://Example.com` and `https://example.com`, or `:443` vs none, become different assets and therefore different coverage cells, work fingerprints, and `--refer-workspace` matches.
*Step 1 (free):* scan existing durable-local run stores for asset-key pairs equal after the proposed rules (lower-case scheme+host, drop default port, drop fragment; **never** touch path, query or case of the path). If none, stop.
*Step 2:* only if it fires: bump `GRAPH_IDENTITY_VERSION` to 2 and apply the rules to kinds `host`, `service`, `endpoint` whose key parses as a URL. The version is already inside the scope hash, so older runs show as foreign/stale in `--refer-workspace`, which is truthful.
*Step 1 measured (2026-10-21, read-only, every `assessment.sqlite` under any `.p2o-state` on this machine):* 205 stores found, 133 readable (the other 72 predate the `assets` table), 130 asset heads in all, 42 with an http(s) key, **0 pairs** of keys that become equal after the rules, within a scope or across stores. Three real hosts appear (every revision counted: about 37, 8 and 7 keys); the rest are test fixtures. The rules would have changed 7 keys: one service key with an explicit default port (`https://host:443`), and six endpoint keys that are route templates (`/post/{id}`).
*Lesson from the scan:* a naive WHATWG `URL.href` rewrites `{id}` to `%7Bid%7D`, which breaks the "never touch the path" rule, and endpoint keys can be templates, not URLs. Any real implementation must canonicalize only scheme, host and port by hand and leave path and query bytes alone.
*Verdict:* the gate says stop when nothing fires, and nothing fired. **Dropped on current evidence**, with the caveat that the sample is small (three real hosts); revisit if a `--refer-workspace` match is ever missed because of case or a default port. *Risk if revived:* identity change; needs the owner's decision. *Effort M.*

**U8. Roles and order for reproduction evidence.**
*Evidence:* ARTEX binds evidence with `role ∈ baseline | proof | verification | supporting` and an explicit order; the reporter must read the binding version before writing. p2o's `reproductionEvidenceRefs` is an unordered id list (≤5).
*Change:* accept `{ref, role, note?}` entries (the plain-id form stays valid), keep the same-run check (`cases.ts:122`), and render the ordered steps in the report. Roles are labels for the reader, not proof levels.
*Effort S–M.* Touches `case-types.ts`, `cases.ts`, `report-export.ts`; `rate` already writes a separate note so revision semantics are unaffected.

### Tier C — need an owner decision before any code

**U9. Retest of a prior finding, built on `--refer-workspace`.**
*Evidence:* ARTEX models retest as a separate session that starts from a frozen snapshot of one finding, with the three-verdict gate in §1.4. p2o has `purpose:'retest'`, `decision:'retest'`, "remediation `implemented` ≠ fixed", and — since `7088bfa` — a way to read prior same-target runs as context. The old 3.5 stalled on `retestOf` plumbing.
*Sketch:* `--refer-workspace <run> --retest <case-id>` seeds **one** validation task whose brief quotes the prior case's claim and reproduction steps as *leads*; the verdict is a new case in the new run with a lifecycle link to the prior case id. Verdict gates go into `skills/remediation` (reproduced / fixed / inconclusive; `fixed` needs comparable environment, trigger inactive, working control; one failed request is `inconclusive`). Nothing from the prior run counts as same-run evidence.
*Decision needed:* new flag vs a `/p2o retest` sub-command; whether the doc-only verdict taxonomy (zero code) ships first. *Recommendation:* ship the doc part now, decide the flag after U1 lands.

**U10. Hybrid target (source snapshot + deployed origin).**
*Evidence:* Strix treats "code guides live testing, live anomalies guide code review" as a first-class situation and builds a Target Map across assets. p2o runs exactly one target kind, so static findings and live probes cannot share one graph, one coverage plan or one report.
*Why not now:* identity (`scope = target + sourceSnapshotSha256`), tickets, sandbox mount and the HTTP origin check are all single-target. A hybrid is a design change across scope, store and report, not a feature flag.
*Decision needed:* is the cross-correlation worth reopening scope? Cheaper substitute available today: run two linked assessments and use `--refer-workspace` (leads only, never evidence).

**U11. Hygiene the incident points at (all optional).**
1. Create `.p2o-reports/.gitignore` containing `*` when the directory is first made, and tell the operator once that exports are best-effort redacted. (`evidence.ts:95`.)
2. In the confirm dialog, add one extra paragraph when the URL host ends in `.gov`, `.mil`, `.edu` or a country variant (`.gov.xx`, `.edu.xx`). This is friction, not a boundary; the human remains the only authority. ARTEX's own default was a hard block; p2o should **not** copy a block, only the prompt.
3. An opt-in setting `p2o.attributionHeader` adding a run-id header to scoped HTTP so the asset owner's defenders can tell authorized testing from an attack. Off by default (it can change WAF behaviour).
*Effort XS each; the owner decides which, if any.*

### Considered and not proposed

| Idea | Source | Why not |
|---|---|---|
| Fresh Planner session every wake | ARTEX | The Planner is the operator's own Pi conversation by contract; the K6 packet already gives a request-local projection |
| Free agent spawning, "2000+ steps" mandate, "never refuse" framing | Strix | Conflicts with human-only authority, bounded slots and honest `blocked` |
| LLM-judge duplicate detection | Strix | p2o's structural fingerprints and `rootCauseKey` rule are stricter and free |
| LLM goal decomposer at start; LLM-judged `prove_goal` | ARTEX | Costs a call; p2o goals close only with same-run evidence and an explicit revision |
| Cold-digest model summaries of old graph regions | ARTEX | p2o's design forbids model-written summaries as state (`CONTEXT_PACKETS.md`) |
| Coverage = fact-anchored assets ÷ denominator | ARTEX | Weaker than p2o's two-axis cells |
| Full parent-history inheritance | Strix | p2o's brief + request-local packet is the cheaper contract |
| OpenAPI → coverage cells importer | Strix `api_spec_testing` | A skill already covers route inventory; no evidence the Planner spends enough turns on this to justify a new owner action |
| Scan-mode profiles `quick/standard/deep` | Strix | p2o has no time/cost concept by design; revisit if a cost governor ever lands |
| Technology/framework skills (django, nextjs…) | Strix | Old 3.8; still no demand signal. Add one only when a real run needs it, with provenance |
| Threat-model note (old 3.2) | Strix | Not re-argued here; U1's stored objective plus `p2o_plan` covers the "shared, correctable framing" need at lower cost |

---

## 6. Order, gates, and what would change my mind

| Step | Items | Gate before the next step |
|---|---|---|
| 1 | U1, U2 | **Implemented, uncommitted (2026-10-21):** `--avoid` parser, worker-brief block, ledger record, dialog and REPORT.md lines, scope-denial wording. Vitest 599 passed / 12 skipped; no change without the flags. One Python test (`test_provenance_record_matches_review_snapshot`, R1) fails on a clean tree too: the local `my_references/strix` snapshot no longer matches the pinned hash |
| 2 | U3 step 1, U7 step 1 | **Done 2026-10-21.** U3: shared prefix 85 of 5,966 chars today, 5,901 if the identity line moves; stop condition not met, effect unquantified. U7: 0 collisions in 130 assets, dropped |
| 3 | U4, then U5 | **Done 2026-10-21, uncommitted.** U4 first, U5 reuses its derivation; packet-size tests hold (Vitest 603 passed / 12 skipped) |
| 4 | U6, U8 | Confirm the receipt carries HTTP status (U6); keep the plain-id evidence form (U8) |
| 5 | U9 doc part | Owner picks the flag shape |
| later | U10, U11 | Owner decisions |

Standing constraints honored: commit/push/install stay owner-initiated; no attribution lines; GitNexus `impact` before any edit (run it for
`workerBrief`, `parseCommand`, `wstgSuggest`, `contextPacket`/`store.ts:461` — not run in this planning pass, so no blast-radius numbers are claimed);
no paid or live runs; no reference code executed.

**Would change the ranking:** a free-prefix measurement showing U3 is already shared (drop it); zero near-duplicate keys in existing stores (drop U7);
a real run where a worker ignored an operator exclusion the lead had not copied (raises U1's value); a `ruled_out` later overturned because the
control was a 403 (raises U6).

## Appendix — evidence index

- ARTEX: `ARTEX_AGENTIC_CORE.vi.md` §1–§8; `agent/planner.go:150-345`; `agent/finding_workflow.go`; `agent/finding_recorder.go`; `agent/retester.go`;
  `agent/constraints.go`; `guard/guard.go` (`applyIntercept`, `systemBlockMessage`, `postToolUse`, `reBlocked`); `db/schema.sql:1081-1129,1163-1174`.
  Second sweep (agent-reported, §1.6): `server/engine.go:800-960,1030-1156`; `server/goals.go:99-285`; `agent/tools.go:1032-1089,1157-1214`; `agent/tools_insert.go:209-364`;
  `agent/worker.go:361-535`; `agent/mainagent.go:87-195`; `db/finding_traffic.go:27-409`; `db/finding_retests.go:77-259`; `intercept/intercept.go:338-688`; `intercept/prompt.go:10-47`.
- Strix (agent-reported): `strix/core/inputs.py:107,344`; `core/runner.py:396-401`; `agents/prompt.py:58`; `agents/prompts/system_prompt.jinja` SP:3-11,92-128,206,290-378,507-527;
  `tools/agents_graph/tools.py:495`; `tools/finish/tool.py`; `tools/coverage/tools.py:40`; `tools/threat_model/tools.py`; `tools/reporting/tool.py:135,982`; `report/dedupe.py:330`;
  `report/coverage.py:230`; `skills/__init__.py:224`; `core/hooks.py:49-53`; `benchmarks/README.md`.
- p2o: `src/prompts.ts:63,86-128`; `src/engine.ts`; `src/target.ts:15-70,81-101,152`; `src/wstg-map.ts:148,372,419-429`; `src/state/store.ts:461-470`;
  `src/coverage.ts:35`; `src/case-types.ts:20,39`; `src/cases.ts:122`; `src/state/graph.ts:7-12,37`; `src/finish-preflight.ts:89`; `src/evidence.ts:47,95`;
  `src/tool-guidelines.ts`; `extensions/p2o/index.ts:95,527,1029,1536-1554,1649`; `docs/ARCHITECTURE.md`, `ASSET_GRAPH.md`, `WORK_ADMISSION.md`, `CASE_REVIEW.md`,
  `CONTEXT_PACKETS.md`, `PLANNER_ENGINE.md`; `HANDOFFS.md` H1.
- Prior study: `git show 656843d:planning_update.md`; memory notes on pinned lead prompt, opt-in tool guidance, `--refer-workspace` (`7088bfa`).
