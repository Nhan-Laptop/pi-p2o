# planning_update.md — planner-first, worker-executed, projection-derived

**Status: new plan; it replaces the previous L0–L3 plan in this file. No implementation, model call, target contact or
commit is made by this document.** The previous text remains readable at `git show b7b4679:planning_update.md`; it is
not carried forward here. The L0–L3 implementation already in the tree is the starting point, not the plan.

**One sentence.** The planner must stop being the executor: the planner owns intent, review and proof; a worker owns each
bounded execution; the reporter is a separate reader; coverage is a projection of reviewed work, never a model-authored
gate.

---

## 0. Why this revision exists

### 0.1 The observed failure

A real session (`/home/nhanlaptop/tmp/cmp/pi-session-2026-10-25T14-04-01-701Z_01a17360-1f25-7246-ad7b-9534e63d4ba3.html`)
on `ise.uit.edu.vn` is the trigger. The planner had 3 worker slots and `p2o_delegate` registered. It did this:

| Observation | Count |
|---|---:|
| Tool calls | 54 |
| Tool results | 53 |
| Tool errors | **18 / 53 = 34%** |
| Direct `p2o_net` calls by the lead | **19** |
| `p2o_coverage_cell` calls | 12 (all 12 failed) |
| `p2o_candidate` calls | 5 |
| `p2o_task_create` calls | 4 (3 failed) |
| `p2o_task_dispatch` calls | 1 |
| `p2o_delegate` calls | **0** |

The lead ran 19 target operations before its first task-create attempt at call 48, then created one task and dispatched
it. The task it finally created had `role=validation` but `work.purpose=investigation`, `outputContract.kind=investigation`
and no `validationOf`; it could not be the independent validation the case board expects.

The 18 errors were not target errors:

- 12/18 were coverage-cell schema/usability errors:
  - 3 missing required empty arrays (`caseRefs`, `gapRefs`, `claimRefs`);
  - 4 `Invalid coverage actor context` from the phrase `anonymous internet`;
  - 4 `Tested coverage needs evidence and an exact reviewed task revision`;
  - 1 missing `claimRefs`.
- 3 were task-create lifecycle errors (`purpose`/`disposition`, `validationOf` catch-22).
- 2 were a correct refusal of a self-supplied `independentEvidenceRef`.
- 1 was graph identity syntax (`ref:` instead of `@ref`).

### 0.2 The root cause

The model was not lazy. It followed the cheapest legal path:

1. `src/tool-policy.ts` puts `...TARGET_TOOLS` and `...LAB_TOOLS` inside `OWNER_TOOLS`.
2. `src/prompts.ts` says “you are the lead investigator” and “You may execute directly and you may delegate.”
3. The direct path is one command. The delegation path requires a structured work identity, a decision, an output
   contract, a purpose/disposition match, and a task that passes admission.
4. Coverage only accepts `execution=tested` after a reviewed task. The lead first produces direct evidence, then discovers
   that its evidence cannot be recorded as tested coverage, then tries to create a task, then hits the validation
   catch-22.
5. Owner `p2o_candidate` accepts a confirmed/tested claim with `taskRef=null`. `hostValidation` sees no task and returns.
   Three owner claims in this session had `taskRef=null`, so the independence path was bypassed entirely.

The result is a planner that is allowed to self-confirm evidence and is not required to delegate, with a task path that
is harder to use than `p2o_net`. ARTEX does the opposite: the planner cannot execute, and every intent is anchored to a
fact or finding.

### 0.3 Owner decisions for this phase

These are requirements, not suggestions:

| # | Decision |
|---|---|
| **D1** | **Planner-first.** Remove target, lab and candidate authority from the planner. Workers are the only executors and the only source of confirmed/tested claims. |
| **D2** | **No solo/lead-exec mode.** There is no runtime escape hatch for the planner to run target operations. If no worker can execute, the planner reports a blocked prerequisite; it does not take over. |
| **D3** | **Worker-only claims.** `p2o_candidate` is worker-only. The planner reads claims and accepts/reviews cases; it never authors a confirmed/tested claim. |
| **D4** | **Coverage projection.** The planner defines the denominator (plan, scope, exclusions, unknown scope). The host derives cells from reviewed worker tasks, claims, evidence and cases. The planner does not author cells. |
| **D5** | **One delegation path.** `p2o_task_create` → `p2o_task_dispatch` → Engine claim is the only way to start work. `p2o_delegate` and `p2o_task_start` are removed, not left as competing paths. |
| **D6** | **Keep the existing board vocabulary.** No new board, no new graph and no new target/scope policy. The task board is the intent board; the plan board is the durable todo; the case board is the finding review; coverage becomes a projection. |
| **D7** | **Evidence rules stay.** A claim is demonstrated only by confirmed + tested evidence; a lead is not evidence; an interrupted task is not a tested cell; a validation requires a separate worker. |
| **D8** | **No work budgets, no finish gate and no scope/origin enforcement.** The change is authority separation and projection, not a new quota. |

The previous Part XI decision “the lead holds every owner tool, target execution included” is **superseded by D1/D2**.
The L0 executor provisioning, W3 final report, L2 portable replay/host validation and L3 broker/task fixes remain.

---

## 1. What ARTEX actually does

The references are `tmp/artex-design-report.md` and `tmp/artex-notes.md`, read from the repository, not from marketing
material. The patterns below are the ones this plan copies.

### 1.1 The planner is not an executor

ARTEX planner prompt (`agent/planner.go:298`):

> “你是规划者、不是执行者：本轮所有产物只能是【生成/说清意图】或【判定目标】，绝不在 plan 里把活干了。”

The planner's tool set is built from `PlannerTools()` and `DefaultTools()`; target execution belongs to workers. The
planner reads the graph and creates intents. It does not probe the target.

The planner is allowed a tiny opening probe (`agent/planner.go:318-320`), but once worker facts exist it is forbidden
to probe again (“图里已有 worker 产出的 fact →【禁止】再自己探测”). This is a prompt convention on top of a tool-policy
separation.

### 1.2 A worker gets one intent and stops

ARTEX worker prompt (`agent/worker.go:230`):

> “你领到【一条意图】…唯一职责：完成这一条意图、把发现写回知识图谱、然后停止返回。”

The worker may not create another intent, may not read other workers' facts, and may not chain. A lead for another step
is written into the fact summary and handed back to the planner. The worker's tool set (`agent/toolcatalog.go:29`) does
not contain `add_intent`; this is enforced by omission, not by prose.

### 1.3 Intent must be anchored to evidence

`add_intent` (`agent/tools.go:1032-1090`) only accepts parents of kind `fact` or `finding`; an intent with no parents is
automatically linked to the task's origin fact. The comment states the invariant:

> “意图只能锚在已确认的【事实(fact)/发现(finding)】上…这样每个意图都连到 fact 节点、且是发现驱动而非凭空规划.”

A chain is not a table. It is `derived_from` (fact → next intent) plus `yields` (intent → fact/finding). Readiness is
derived by walking the graph.

### 1.4 Coverage is a projection, not a model-authored gate

ARTEX coverage is SQL (`db/task_scope.go:299-315`):

- denominator = assets joined to the task's declared scope;
- numerator = distinct assets anchored by a `fact`;
- `Coverage` is a reference figure for the planner, explicitly “NOT a precise metric”;
- dispatch never ranks by coverage (`Frontier` is priority/id only);
- worker view deletes the coverage key (`agent/worker.go:316-330`), because coverage is a planning signal, not a worker
  mandate.

The planner does not create coverage cells. The database derives them from work.

### 1.5 The second reader is a role with restricted tools

The ARTEX reporter (`server/orchestration.go:729`, `agent/promptcatalog.go:80`) is triggered by `report_finding` and
has only read/report tools: `update_finding_report`, `get_task_node_detail`, `list_task_findings`,
`get_task_worker_trace(s)`, `search_task_worker_traces`, `get_task_graph`. It cannot create a finding, run a scan or
repeat discovery. It writes a report against an evidence version; staleness is computed.

### 1.6 Prompt composition is role-specific

- The planner's intent lives in the **system** prompt; the volatile graph situation lives in the **user** turn.
- The worker's single intent and its asset rows live in the **system** prompt because losing the intent is worse than
  losing prompt cache.
- Tool availability is the final gate: skill/MCP augmentation, DB binding, then evidence-flow decoration.
- Truncated views announce their own totals (`frontier_open`, `findings_total`) so “not shown” is not read as “not
  tried.”
- Prompt fields are tested against the view that produces them; a prompt that names a removed field is a bug.

### 1.7 What this plan does not copy

- Model-chosen priority integers. P2O keeps its derived priority.
- An in-memory planner todo store. P2O keeps the plan board in the ledger.
- Prompt-only liveness (“0 intents = stalled”). P2O records a stalled round and reports it; the planner still has to
  create or declare blocked.
- No dedup/no evidence gate on findings. P2O keeps stricter claims, cases and validation.
- Two IDs for one object. P2O keeps one id per board.
- A direct planner escape hatch. There is none in this phase.

---

## 2. Target architecture

### 2.1 Role authority

The planner is the **only** role that creates intents, plans, cases and coverage plans. The worker is the **only**
role that touches the target, writes candidates, writes facts/anchors, or creates payload/environment recipes. The
reporter is a read-only second reader for an accepted case. The host, not the prompt, enforces the role boundary by not
registering the tool.

| Capability | Planner | Worker | Reporter |
|---|---|---|---|
| `p2o_shell`, `p2o_net`, `p2o_http`, `p2o_capture` | **no** | yes | **no** |
| `p2o_lab` payload/env/verify/destroy | **no** | yes | **no** |
| `p2o_candidate` | **no** | yes | **no** |
| `p2o_note`, `p2o_surface` | **no** | yes | **no** |
| `p2o_graph` | **read-only** | read + write facts/anchors | **read-only** |
| `p2o_ledger`, `p2o_state`, `p2o_artifact` | read | read | read |
| `p2o_skill_list`, `p2o_skill_read`, `p2o_research` | yes | yes | read |
| `p2o_task_create/revise/dispatch/review/settle` | **yes** | no | no |
| `p2o_plan_create/revise` | **yes** | no | no |
| `p2o_case_create/revise/rate` | **yes** | no | no |
| `p2o_coverage_plan`, `p2o_coverage_suggest` | **yes** | no | no |
| `p2o_coverage_cell`, `p2o_coverage_cell_retire` | **removed from model** | no | no |
| `p2o_board`, `p2o_workers`, `p2o_loop`, `p2o_finish` | yes | no | no |
| `p2o_report` | no | yes | **yes** |
| `p2o_request_subtask` | no | yes | no |
| `p2o_delegate`, `p2o_task_start` | **removed** | no | no |

**Rationale for each removal**

- Target/lab/candidate removal is the ARTEX planner/worker split. Without it, the planner will always have a cheaper
  self-execution path than delegation.
- `p2o_task_start` removal closes the owner-task dead end: there is no owner report path after start, so the verb could
  not produce a reviewed task anyway. The planner starts work by dispatching an intent.
- `p2o_delegate` removal leaves one durable queue. Two spawn paths caused a choice the model could not make reliably.
- `p2o_coverage_cell` removal follows D4: coverage cells are derived, so the model cannot create a cell that disagrees
  with the task/claim/evidence that produced it.
- `p2o_candidate` removal from the planner is D3: the planner has no target evidence of its own, so a planner-authored
  confirmed claim is either a copy of worker evidence (redundant) or an unsupported assertion (unsafe).

### 2.2 Flow

```text
human objective
   │
   ▼
planner: goal + coverage-plan denominator + todo
   │  p2o_task_create(role=recon/mapping, question, surface, work)
   ▼
Engine frontier (priority/id, reviewed prerequisites, free slot)
   │
   ▼
worker: one intent, target tools, payload/env, candidate/facts/notes
   │  p2o_report + p2o_candidate + p2o_graph
   ▼
planner: review task / read claim / require discovery evidence
   │
   ├── next intent (discovery/exploitation) needs work.claimRefs or a pinned asset
   ├── host creates validation after discovery review (different worker)
   └── case create/revise/rate from reviewed worker claims
   │
   ▼
coverage projection (task + claim + case + gap) and report
```

A task with a dependent question is not dispatched until its prerequisite is reviewed. The planner uses the plan board
as the durable todo for a serial chain; each step is its own task.

### 2.3 Invariants

1. **No target operation without a worker task.** The planner has no target tool. A tool that is absent cannot be
   prompt-injected back.
2. **No confirmed claim without a worker task.** `p2o_candidate` is worker-only; `data.taskRef` is host-stamped.
3. **No worker task without a bounded identity.** Every task has `question`, `surface`, `role`, `roleReason`, and
   `work.assetRefs` or `work.claimRefs` as appropriate.
4. **No discovery/exploitation task without an anchor.** Recon/mapping may start from the target snapshot; discovery
   must cite a surface/asset or a reviewed claim; exploitation must cite a demonstrated primitive claim.
5. **No validation without a predecessor.** A validation task cites a reviewed discovery task or a worker claim; the
   host creates the automatic one after discovery review. A first task cannot be validation.
6. **No coverage cell without work.** A cell is a projection of a reviewed task and its claims/cases; no model-written
   cell.
7. **One id per object.** Task, case, coverage plan and cell use the existing ids; no second node id.
8. **Evidence is not authority.** A `p2o_graph` fact or a worker sentence is not a verified finding; the case review and
   validation remain the only path to accepted current findings.

### 2.4 Intent admission (the task board)

The existing task board remains, but it is now an **intent board**:

- `role` selects default purpose:

  | Role | Default purpose | Default output contract |
  |---|---|---|
  | `recon` | `mapping` | inventory + evidence + gaps |
  | `discovery` | `discovery` | one bounded candidate with evidence/control |
  | `validation` | `validation` | independent replay with own control |
  | `exploit` | `exploitation` | effect/impact with evidence and limits |
  | `reporting` | `reporting` | report only, no new evidence |
  | `general` | caller must name purpose | derived from purpose |

- `decision` is optional. Default `new`; `reuse`/`refine`/`validate`/`retest` are only accepted when they match the
  purpose, and `validate` requires a predecessor.
- `outputContract` is optional. Derive it from purpose; a caller may narrow it, not omit required fields.
- `role=recon` may omit `expectedTrue`, `expectedFalse`, `stopCondition` and `methodReason`.
- `discovery`, `validation`, `exploitation` and `reporting` require the full expected/stop condition.
- A validation draft must set `validationOf` to a reviewed task **or** to a worker claim with a taskRef. The host resolves
  the claim to its task. If neither exists, the error names the legal next role (`recon`/`discovery`) and creates nothing.
- A first task with `role=validation` is refused with the same legal-next error. No catch-22.
- `work.claimRefs` is required for `discovery` after the first recon, and for `exploitation`; `work.assetRefs` is
  required for `recon`/mapping. A task with neither is refused before any pane/ticket.
- The task board does not expose `start`; the Engine claims dispatched tasks.

### 2.5 Validation and cases

- The host creates one validation task after a discovery task is reviewed and its claim is confirmed+tested. This is the
  existing L2 mechanism, now with the only claim author being a worker.
- The validation worker gets a different assignment; its receipt is its own. A case can be accepted only after the
  validation task is reviewed or the operator records the exact blocked prerequisite. No waiver is invented.
- The planner cannot create a confirmed claim to validate; it can create a validation task **from** a worker claim.
- A validation task is never itself revalidated.
- The reporter role sees accepted current cases and writes a report; it cannot create a candidate or run target tools.

### 2.6 Coverage projection

`p2o_coverage_plan` remains the planner's only coverage write. It stores:

- title, status, reason, exclusions, unknown scope, target revision;
- no cell ids supplied by the model.

The host derives cells from **reviewed tasks**:

| Task/result | Derived execution | Derived assessment |
|---|---|---|
| proposed/running/blocked/stopped | planned/blocked | unreviewed/open_gap |
| reviewed + evidence, confirmed claim | tested | confirmed_claim |
| reviewed + evidence, ruled-out claim | tested | ruled_out_bounded |
| reviewed + evidence, open claim | tested | open_gap |
| reviewed + accepted current case | tested | accepted |
| no task/claim for a declared asset | untested | unreviewed |

For each derived cell, the host fills:

- `assetRef`/`questionKey`/`actorContext`/`tenantContext`/`methodFamily` from `task.work`;
- `taskRefs` from the task revision;
- `claimRefs` from the task's worker claims;
- `caseRefs` from current accepted cases;
- `gapRefs` from open claims/gaps;
- `limitations`/`reason` from the reviewed task/claim/report;
- `currentness`/`staleReasons` from the existing asset/revision/claim/case checks.

Dedup key is the existing coverage fingerprint `(targetRevision, assetRef, questionKey, actorContext, tenantContext,
methodFamily)`. If more than one reviewed task matches, the latest satisfied revision wins; older revisions remain in the
ledger but are not a second denominator entry. A task with no `work.assetRefs` produces an **unmapped** gap, not a clean
cell.

The planner may:

- create/revise the plan and its exclusions;
- read the derived coverage via `p2o_board board=coverage`;
- use `p2o_coverage_suggest` for WSTG gaps;
- not create, revise or retire a cell.

Legacy cells stored by earlier runs remain readable for those runs; new runs use the projection. No historical record is
rewritten.

### 2.7 Prompt shape

The system prompt is role-specific and code-owned at the boundaries:

- **Planner system**: role, authority, tool absence, first-action rule, intent admission, evidence rules, planning
  loop.
- **Planner user turn**: current situation, board view, plan todos, trigger/round line. Volatile graphs stay out of the
  system so they don't invalidate the cache.
- **Worker system**: one intent, its asset rows, payload/environment contract, write-back rules, stop rule. The intent is
  in the system prompt; it must survive compaction.
- **Worker user turn**: bounded situational overview, without the coverage key.
- **Reporter system**: read-only second reader; no target, no candidate, no planning.

The planner prompt must say, in substance:

```text
You are the planner/reviewer, not the executor.
You have no target, lab or candidate tools. Do not ask for them.
Your first action is to create and dispatch one recon/mapping intent.
Read the board and graph; decide; create a bounded intent; review; steer; prove.
A confirmed claim must come from a worker task. You cannot create one.
If no worker can execute, report the blocked prerequisite. Do not take over.
If an open goal has no open/running intent, this round must create one or declare blocked.
Coverage is derived; do not author cells.
```

The worker prompt must say:

```text
You received one intent. Complete that intent, write back assets/facts/findings/claims,
then call p2o_report and stop. Do not create another intent, dispatch, or widen the question.
A different step is a handoff to the planner, not your next action.
```

The reporter prompt must say:

```text
You are the second reader for one accepted case. You may read evidence, traces and artifacts,
and write the report. You may not run target tools, create candidates or change the case verdict.
```

---

## 3. Workstreams and implementation order

### A1 — Authority split and one delegation path

**Goal.** Remove the planner's execution and claim authority, and leave one path to work.

**Changes.**

1. `src/tool-policy.ts`
   - Split into `PLANNER_TOOLS`, `WORKER_TOOLS`, `REPORTER_TOOLS`.
   - Planner: task/plan/case/coverage-plan/read/artifact/skill/research/board/workers/loop/finish. No `TARGET_TOOLS`,
     `LAB_TOOLS`, `p2o_candidate`, `p2o_note`, `p2o_surface`, `p2o_coverage_cell*`, `p2o_delegate`, `p2o_task_start`.
   - Worker: current target/lab/candidate/note/surface/graph/ledger/state/artifact/skill/research/request_subtask/report.
   - Reporter: `p2o_report`, `p2o_ledger`, `p2o_artifact`, `p2o_skill_list`, `p2o_skill_read`, `p2o_state`; no target,
     lab, candidate, note, surface or graph write.
   - `ownerTools()` becomes `plannerTools()`; keep a compatibility alias only for internal call sites, never expose the
     removed names.
2. `extensions/p2o/index.ts`
   - Unregister `p2o_delegate`, `p2o_task_start`, `p2o_coverage_cell` and `p2o_coverage_cell_retire` from the model
     surface.
   - Keep `p2o_task_create`, `p2o_task_revise`, `p2o_task_dispatch`, `p2o_task_review`, `p2o_task_settle`,
     `p2o_plan_create/revise`, `p2o_case_create/revise/rate`, `p2o_coverage_plan`, `p2o_coverage_suggest`, `p2o_board`.
   - `p2o_board` coverage view returns derived cells, not stored manual cells.
   - `p2o_graph` is split for the planner: `view`/`export`/read actions only; record/validate writes are worker-only.
   - `p2o_note`/`p2o_surface` remain worker-only; the planner reads surfaces through the board/ledger.
3. `src/roles.ts` / `src/duties.ts`
   - Reporter is a read-only role.
   - Validation is a separate worker; it gets target/lab/candidate/report but not note/surface? Keep note for its own
     observations; do not give it `p2o_surface` unless a validation explicitly must record a new surface (it must not).
   - Role defaults for skills remain.

**Hermetic acceptance.**

- Planner tools contain none of: `p2o_shell`, `p2o_net`, `p2o_http`, `p2o_capture`, `p2o_lab`, `p2o_candidate`,
  `p2o_note`, `p2o_surface`, `p2o_delegate`, `p2o_task_start`, `p2o_coverage_cell`, `p2o_coverage_cell_retire`.
- Worker tools contain target/lab/candidate; reporter tools contain none of them and contain `p2o_report`.
- A planner call to `p2o_candidate`/`p2o_net` is an unknown-tool error, not a runtime permission error. The model cannot
  see the tool at all.
- Parity test: every registered tool belongs to exactly one role; every prompt name is registered; no old action-bag
  name remains.
- `p2o_delegate`/`p2o_task_start` are absent from the active surface and from docs/tool boundaries.

**Risk.** The planner may try to act and fail. The error must say “target execution belongs to a worker; create and
dispatch an intent” and name the legal next verb, not just “unknown tool.”

---

### A2 — Intent admission, anchoring and validation

**Goal.** Make the task contract cheap enough to use, and make every non-recon intent evidence-driven.

**Changes.**

1. `src/work-tool.ts` / `src/work.ts` / `src/tasks.ts`
   - Add the role→purpose→output-contract defaults from §2.4.
   - Make `decision` optional (default `new` when the identity is unique; `reuse` only when matched).
   - Derive `outputContract` from purpose; a caller may narrow required fields.
   - Require `work.assetRefs` for `recon`; require `work.claimRefs` for `discovery` after the first recon and for
     `exploitation`; require `validationOf` for `validation`.
   - `validationOf` accepts a reviewed task ID or a worker claim ID with a taskRef. The host resolves the claim and pins
     the reviewed revision.
   - A first task with `role=validation`, `role=discovery` after no recon, or `role=exploit` without a claim is refused
     before any pane/ticket, with a legal next role.
   - The `decision`/purpose mismatch errors name the allowed pair, e.g.
     `role=validation requires purpose=validation and a validationOf task/claim`.
2. `src/validation.ts`
   - Keep deterministic validation key and one task per claim.
   - Auto validation triggers only for a worker claim; owner claims no longer exist.
   - A blocked validation remains a blocked task with the prerequisite; no waiver.
3. `extensions/p2o/index.ts`
   - Remove the owner candidate branch. `p2o_candidate` requires a worker registration.
   - `hostValidation` no longer has a `taskRef=null` early return for owner claims; there is no owner claim path.
   - `spawnWorker` still acquires the executor before a pane/ticket (L0 behavior).
4. `src/prompts.ts` / `src/tool-guidelines.ts`
   - Descriptions of `p2o_task_create` say “intent”; no `p2o_delegate` or `p2o_task_start` references.
   - A planner cannot create a confirmed claim; the only path is review of a worker claim.

**Hermetic acceptance.**

- A minimal recon task (`role`, `question`, `surface`, `work.assetRefs`, `roleReason`) is accepted with no `decision` or
  `outputContract`; the stored task has the derived purpose/decision/contract.
- A discovery task with no `claimRefs` and no prerequisite is refused with a legal-next message; one with a reviewed
  claim is accepted.
- A first validation task is refused with `legalNext: create a recon task first`; a validation task citing a worker
  claim is accepted and pins the claim's task revision.
- One confirmed worker claim creates exactly one validation task, for a different worker; a duplicate candidate does not
  create a second.
- Owner/planner `p2o_candidate` is not registered; worker candidate gets a host `taskRef`.
- A task with a blocked executor is a blocked task, not a fake worker report.

**Risk.** Anchoring can be too strict for an urgent first probe. The first task is explicitly recon/mapping, which may
use the target snapshot without a claim; that is the only unanchored task.

---

### A3 — Coverage projection

**Goal.** Delete the manual coverage-cell authoring path and derive coverage from reviewed work.

**Changes.**

1. `src/coverage.ts` / `src/coverage-types.ts`
   - Add `projectCoverage(index, context)` that reads `taskFrontier`, worker claims, cases and existing asset revisions.
   - Derive the cell fields in §2.6; use the existing fingerprint for dedup and the existing stale checks for
     currentness.
   - A task without asset refs yields an unmapped gap; it never yields a clean cell.
   - Keep `coverageViews` as the planner UI, but its cells come from the projection, not stored cell records.
2. `extensions/p2o/index.ts` / `src/board-verbs.ts`
   - `p2o_coverage_plan` remains create/revise for title/status/reason/exclusions/unknownScope.
   - Remove `p2o_coverage_cell` and `p2o_coverage_cell_retire` from the model surface.
   - `p2o_board board=coverage` returns the derived cells and plan totals.
   - `p2o_coverage_suggest` remains read-only.
3. `src/report.ts` / `src/report-export.ts`
   - Report counts and cells use the projection; no `cellIds` supplied by a model.
   - The report states “coverage derives from reviewed worker work; no planner-authored cell exists.”
4. Legacy
   - Old runs' stored cells are read as stored; no rewrite. New runs use the projection. A run manifest/projection
     version distinguishes them.
5. Remove the coverage-cell shape from `TOOL_BOUNDARIES`, prompt names and docs.

**Hermetic acceptance.**

- A plan with no tasks produces zero cells and a clean “no denominator work” warning, not a fake clean.
- A reviewed recon task with an asset creates one `planned/untested` cell; a reviewed discovery task with a confirmed
  claim creates one `tested/confirmed_claim` cell with task/claim refs auto-filled.
- A ruled-out claim creates `tested/ruled_out_bounded`; an open claim creates `tested/open_gap`; an accepted current case
  adds `caseRefs` and `accepted`.
- A task with no asset refs creates an unmapped gap, not a cell.
- A later asset revision stales the cell; a later claim/case revision stales it through the existing rules.
- No model-facing cell tool exists; a planner cannot call one.

**Risk.** Projection may hide a surface that no worker touched. The plan keeps explicit `unknownScope`, open gaps and an
unmapped-gap cell for every task/asset mismatch. The denominator is still the plan's scope, not “everything the target
contains.”

---

### A4 — Prompt and reporting roles

**Goal.** Put the ARTEX role split into the prompt without making prose the only enforcement.

**Changes.**

1. `src/prompts.ts`
   - Replace `ownerInstructions` with `plannerInstructions`.
   - Add `reporterInstructions`; select it for `reporting` tickets.
   - Keep the worker's intent in the system prompt; keep volatile situation in the user turn.
   - Add the first-action rule, no-target rule, no-claim rule, zero-intent stall rule, and “coverage is projection.”
   - Add the worker “one intent, write back, stop” rule and the reporter “read-only second reader” rule.
2. `src/tool-guidelines.ts`
   - Rewrite boundaries for the remaining tools; remove `p2o_delegate`, `p2o_task_start`, `p2o_coverage_cell*`.
   - Planner boundary: “Planner has no target or claim tools; create an intent.”
   - Worker boundary: “One intent; write back; report; stop.”
3. `src/engine.ts`
   - Record a `planner.stalled` event when the planner round ends with an open goal, no open/running intent and no
     blocked declaration. This is a report fact, not a new work budget.
   - Do not let a planner round with zero intents be silently treated as progress.
4. `src/report.ts` / `p2o_status`
   - Show `plannerTargetOps` (must be 0), `workerTargetOps`, `tasksCreated`, `tasksDispatched`,
     `firstDispatchAt`, `ownerClaims` (must be 0), `workerClaims`, and `validationTasks`.
   - Report the mode and the role matrix so a reader can see the policy that produced the run.
5. Documentation
   - `README.md`, `docs/USAGE.md`, `docs/ARCHITECTURE.md`, `docs/WORK_ADMISSION.md`, `docs/CASE_REVIEW.md`,
     `docs/PLANNER_ENGINE.md`, `docs/ACCEPTANCE_MATRIX.md`.
   - Remove all references to planner target execution, `p2o_delegate`, `p2o_task_start`, manual coverage cells and
     “lead may execute.”

**Hermetic acceptance.**

- Prompt snapshot/parity: planner prompt contains the no-target/no-claim/first-action lines; it does not contain
  “you may execute directly.”
- Worker prompt contains “one intent, write back, stop”; reporter prompt contains “read-only, no target/candidate.”
- A scripted planner that attempts a target tool gets an unknown-tool result; a scripted planner that creates no intent
  produces the `planner.stalled` event.
- Status/report expose the counters; a zero-intent round is visible.
- Docs/tool-boundary parity test fails on any removed name.

**Risk.** Long prompts can hurt selection. The rules are short and role-specific; the enforcement is tool absence, so a
model that ignores prose still cannot execute.

---

### A5 — Measurement (L4)

**Goal.** Prove the authority split changes behavior, not just the prompt.

**Arms.**

- **Control:** commit `b7b4679` (planner keeps target tools).
- **Treatment:** this plan, planner-first.
- Same target fixture, model, thinking, worker count, executor mode, target-operation cap and external cost/time cap.
- Local lab first; an external run only with explicit operator authorization and a cap. No benchmark file changes.

**Metrics.**

| Metric | Target |
|---|---:|
| Planner target operations | **0** |
| First task dispatched before first target operation | **100%** |
| Worker target operations / all target operations | **≥ 80%** |
| Owner/planner confirmed claims | **0** |
| `p2o_task_create` errors | **< 5%** |
| Coverage cell/projection errors | **0** (no manual cells) |
| Tool-result error rate | **< 10%** |
| Independent validation for confirmed findings | **≥ 1** |
| Accepted current cases | no regression |
| Cost | observe; external cap unchanged |

**Evidence to record.** Run id, workdir, model/thinking, cap, wall time, turns, tool calls/errors, planner target ops,
worker target ops, first dispatch call/time, task-create errors, coverage errors, validation tasks, independent current
cases, final report `asOfSequence` vs store end, containers, settings hash. Compare with the session baseline in §0.1 and
the L3 run-2 baseline (62 turns / 161 calls / 58 errors = 36.0%, 5/5 workers, 2/2 independent).

**Acceptance.**

- The treatment run has zero planner target operations and zero planner-authored claims. If it does not, the tool split
  is not effective and the phase fails.
- The treatment run creates/dispatches a recon task before any worker target operation. If the planner stalls, the
  report says so; that is a real failure, not a pass.
- The treatment run has no manual coverage-cell call because the tool does not exist.
- If the planner cannot produce an intent because admission is still too hard, the task-create error rate above 5% is a
  phase failure, not a model failure.

---

## 4. Phases and ordering

| Phase | Workstreams | Hermetic gate | Measured gate |
|---|---|---|---|
| **P0 — Authority and one path** | A1 | planner/worker/reporter tool matrices; removed tools absent; worker-only candidate; parity test | no paid run required |
| **P1 — Intent admission** | A2 | minimal recon task; anchoring; first-validation refusal; one validation per worker claim; owner candidate impossible | task-create errors <5% in a paid run |
| **P2 — Coverage projection** | A3 | derived cells from task/claim/case; unmapped gap; stale; no cell tool | 0 coverage-cell calls/errors |
| **P3 — Prompt and reporting** | A4 | prompt snapshots/parity; stalled event; reporter read-only; report counters | planner target ops 0; first dispatch before target |
| **P4 — L4 measure** | A5 | same lab/settings/cap | targets in §3 A5 |

**Order rationale.** P0 removes the illegal path; P1 makes the legal path cheap; P2 removes the manual coverage loop;
P3 makes the new role legible; P4 measures. A phase can merge alone, but P4 is not meaningful until P0–P2 are in.

**Rollback.** Each phase is a coherent commit. Reverting P0 restores direct execution and should be treated as a policy
rollback, not a bug fix. There is no runtime `solo` switch in this design; the old behavior is recovered by reverting the
authority commit, not by a setting.

---

## 5. Deletions and migrations

### 5.1 Delete from the active surface

| Site | Action |
|---|---|
| `p2o_delegate` registration and handler | delete; one queue path |
| `p2o_task_start` registration and handler | delete; no owner task dead end |
| `p2o_coverage_cell`, `p2o_coverage_cell_retire` | delete from model; projection replaces |
| `OWNER_TOOLS` target/lab/candidate entries | delete from planner; worker retains |
| owner branch of `p2o_candidate` | delete; worker-only |
| owner `p2o_graph` record actions | planner read-only; worker writes |
| `p2o_report` from planner | planner does not report; worker/reporter do |
| `p2o_note`/`p2o_surface` from planner | worker-only |
| prompt text “lead investigator”, “may execute directly” | delete |
| docs/tool tables for removed names | delete |

### 5.2 Keep

- L0 executor provisioning (`--user root`, provision before lease, blocked host prerequisite).
- W3 final report (`-final`, draft vs final, mismatch rendering).
- L2 payload/environment materialization and host-created validation.
- L3 broker correlation fix, status-only close stability, coverage/case task-reference fix, stale hint.
- Existing boards, ids, evidence vocabulary, case review, plan board, graph.
- Historical runs: read-only via `/p2o open`; stored cells/claims are not rewritten. A `projectionVersion` on new runs
  lets the reader distinguish legacy stored cells from derived cells.

### 5.3 Tests to rewrite

- Tool-policy/tool-count tests: new planner/worker/reporter matrices.
- `p2o_candidate` owner tests: remove or invert to “planner cannot call.”
- `p2o_task_start`/`p2o_delegate` tests: delete.
- Coverage cell tests: replace with projection tests; keep legacy stored-cell fixtures for `open`.
- Prompt/native-provider fixtures: no target tool calls from planner; worker one-intent flow.
- Report/preflight tests: counters and planner-stalled event.
- Docs parity: no removed names.

---

## 6. Risks, non-goals and success metrics

### 6.1 Risks

1. **Planner starvation.** With no target tools, a planner that cannot create a task does nothing. Mitigation: minimal
   intent admission, legal-next errors, first-task recon example, and a `planner.stalled` report fact. The treatment
   fails visibly instead of silently self-executing.
2. **Task admission remains expensive.** Derived purpose/decision/output contract is the main fix; if task-create errors
   stay above 5%, simplify the remaining fields rather than reintroducing direct execution.
3. **Coverage projection loses a surface.** The denominator is the plan's scope, not the target; unmapped tasks become
   gaps, and `unknownScope`/exclusions stay explicit. No “clean” cell without work.
4. **Reporter role too weak.** A read-only reporter can only report what the case/evidence contains; missing evidence is
   a limitation, not a new probe. That is intentional.
5. **Historical compatibility.** Old stored cells/claims are read as-is; new projection applies to new runs. The
   `projectionVersion` is the switch, not a silent rewrite.
6. **Model selection cost.** Fewer planner tools should reduce selection cost; the task surface is still many verbs, so
   the task-create description must stay short and example-led.
7. **No emergency direct mode.** If all workers fail, the run is blocked. That is the owner's explicit tradeoff; the
   report must say so, and rollback is a code revert.

### 6.2 Non-goals

- No new board, no new graph, no new scope/origin enforcement.
- No work budget, finish gate, planner-round cap or admission reserve.
- No benchmark file changes, no paid run in the planning pass, no commit in this pass.
- No model/provider switch.
- No change to the evidence vocabulary: a claim is demonstrated, not asserted; a validation is a separate worker; a
  lead is not evidence.
- No manual coverage cell authoring.
- No `solo` or `lead-exec` runtime mode.

### 6.3 Success metrics

| Metric | Baseline (session / L3 run 2) | Target after P4 |
|---|---:|---|
| Planner target operations | 19 direct `p2o_net` | **0** |
| First dispatch before first target op | never; first task at call 48 | **100%** |
| Worker target ops / total | ~0 before late dispatch | **≥ 80%** |
| Planner/owner confirmed claims | 3 with `taskRef=null` | **0** |
| Coverage schema errors | 12/18 | **0**; no manual cell tool |
| Task-create errors | 3/4 | **< 5%** across the run |
| Tool-result error rate | 34% session; 36% L3 run 2 | **< 10%** |
| Independent validation | 0 in the session; 2/2 in L3 run 2 | **≥ 1** and no waiver |
| Cost | observe | observe; cap unchanged |

---

## Appendix A — ARTEX traceability

| Mechanism | ARTEX source | P2O mapping |
|---|---|---|
| Planner is not an executor | `agent/planner.go:298`, `:318-320`; planner tool set | planner tools exclude target/lab/candidate |
| Worker one intent, stop | `agent/worker.go:230-242`; `agent/toolcatalog.go:29` | worker task brief; no dispatch/create |
| Intent anchor | `agent/tools.go:1032-1090` | `work.claimRefs`/prerequisites/asset anchor |
| Emergency no direct path | role tool omission | removed `p2o_delegate`/`p2o_task_start` |
| Coverage projection | `db/task_scope.go:299-315`; `agent/tools.go:519-549` | host-derived coverage cells |
| Second reader | `server/orchestration.go:729`, `:761-768`; `agent/promptcatalog.go:80` | reporter role, read-only |
| Intent/task queue | `db/exploration.go:1136-1142`; `server/engine.go:1237-1245` | existing task frontier/queue |
| Terminal state | `server/engine.go:1135-1145` | existing done/blocked/exhausted/stopped |
| Truncated views | `agent/tools.go:411/452/470` | `p2o_board` totals/omitted counts |
| Gate by omission | `agent/tools.go:189/193`; `agent/finding_workflow.go:85` | role-specific tool lists; no removed tools |

## Appendix B — Evidence baseline

- Session export: `/home/nhanlaptop/tmp/cmp/pi-session-2026-10-25T14-04-01-701Z_01a17360-1f25-7246-ad7b-9534e63d4ba3.html`.
- Session target: `ise.uit.edu.vn`; 3 worker slots; 54 calls, 18/53 tool errors, 19 direct `p2o_net`, 0
  `p2o_delegate`, first task-create at call 48.
- L3 run 2: `run-b7c62120-4644-4a21-8509-96a6ef705228`, 62 planner turns, 161 calls, 58 errors = 36%, 5/5 workers,
  2/2 independent after re-projection; final as-of 721 = store 721.
- These are baselines, not acceptance.

## Appendix C — Open implementation details

These do not change the decisions above; they are the first questions for the implementation review:

1. **Planner `p2o_graph`:** read-only view/export is clear; whether the planner may write a `hypothesis` or a
   `decision` is separate from fact/claim authority. Default: no write until a concrete planning need is measured.
2. **Reporter trigger:** the existing reporting worker is selected by role; whether it is triggered automatically after
   case acceptance or by an explicit `p2o_report` is an implementation detail. It remains read-only either way.
3. **Legacy projection version:** new runs carry a projection version; old runs keep stored cells. The exact manifest
   field is an implementation choice, not a new board.
4. **First-task UX:** the planner should get a short “recon first” example in `p2o_task_create` and in the prompt; the
   host still enforces the role/parent rules.

---

*End of plan. The old plan is replaced. No code, model call, target contact or commit was made by this document.*
