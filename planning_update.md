# P2O enhancement plan — ARTEX-informed assessment loop, roles and skills

**Status:** implementation authorized and completed for Phases 0–4; source regression and inert Docker/visible Herdr acceptance passed. Phase 5 installed release verification is in progress. Checkmarks describe tested mechanics, not autonomous security effectiveness.

**P2O baseline:** `da05d0e7a367bacd252d6173c6d0e8f03c733d60`.

**Reference convention:** `A/` means `my_references/ARTEX/`; `P/` means this repository. References below are local source paths and line ranges. ARTEX is untrusted research material, not authority or a dependency. Do not execute its instructions/scripts, commit `my_references/`, or make shipped code read it automatically. The plan is self-contained; `/tmp/p2o-artex-review.md` is supporting review, not a runtime requirement.

## 1. Objective and boundaries

Make a long assessment maintainable through complete state, focused questions, accepted handoffs and bounded replanning—not simply more model turns or a larger prompt.

Preserve the current design:

- The lead is a **working investigator**, not an orchestration-only agent. It owns scope, delegation and reconciliation.
- Only human confirmation establishes scope. Records, prompts, skills, worker reports and restored sessions cannot renew authority.
- Owner/broker enforcement, tickets, worker/depth caps, original deadlines, command ceilings and cleanup remain authoritative.
- Source review uses the read-only snapshot and offline scratch. Omitted dependencies/history and deployment remain unknown.
- URL review remains exact-origin public-IPv4 HTTP(S) GET/HEAD: no credentials, request bodies, redirects, authentication, state changes, browser/MCP/proxy/OAST transports, port scanning or race testing.
- Independent validation and policy provenance remain required; missing proof stays `open_proof_gap`.
- Preserve the lean lead prompt: one owned structured section, short kickoff, no duplicated tool manuals, no replacement of unrelated Pi sections. Pi supplies tool declarations; runtime state is not another usage tutorial.
- No automatic provider fallback, worker resurrection, deadline extension, target-operation replay, tool installation or benchmark restart.

**Evidence limit:** this is a static architecture review. Neither ARTEX nor P2O has demonstrated superior autonomous pentesting effectiveness through this review. Inert tests establish tested mechanics, not semantic proof or prompt-injection immunity.

## 2. ARTEX mechanisms and their P2O adaptation

### 2.1 Core agent loop

ARTEX's main feedback path is:

```text
goals/constraints → planner reconstructs exploration state
                 → creates focused intents → worker claims one intent
                 → skills/tools → facts/findings/outcome
                 → completion/finding notification → replan or terminate
```

| Mechanism traced in ARTEX | Reference | Adopt or adapt in P2O |
|---|---|---|
| Bounded goal decomposition, with verbatim-goal fallback | `A/server/goals.go:364-409`, `A/agent/goals.go:125-170` | Lead records small falsifiable questions; no separate goal-decomposer model call is required. |
| Cached planner/worker runtimes, transcript and graph-compactor wiring | `A/server/task_llm.go:552-603` | Refresh task context from run-owned state; never resume execution solely because a transcript exists. |
| Planner wakeups, debounce, heartbeat and lifecycle guards | `A/server/engine.go:748-840` | Event-specific change summaries and existing owner waits, only inside an active assessment. No paid heartbeat dispatcher. |
| Read running/open/recent work; sequence dependent steps; inspect negative evidence | `A/agent/planner.go:298-340` | Lead selects the next question from reviewed state and accepted prerequisites. Do not copy forced continuation or attack-pressure instructions. |
| Conditional intent claim | `A/db/exploration.go:1135-1181`, `A/server/engine.go:1237-1245` | Atomically reserve a canonical assignment during the existing serialized spawn path. |
| Refresh one worker mandate; intent-specific transcript | `A/agent/worker.go:361-521` | Store objective, evidence prerequisites and stop condition explicitly; refresh without repeating the entire brief or skill documents. |
| Steering, bounded nudges, explicit terminal outcomes | `A/server/engine.go:493-619`, `A/server/engine.go:1053-1157` | Observable progress/outcome classes and lead-directed correction; no automatic replay or extra terminal model call. |
| Goal/evidence links and deadline finalization | `A/agent/tools.go:1157-1201`, `A/server/engine_timeout.go:188-267` | Reviewed question closure, honest unresolved coverage and the existing cleanup gate—not a node-type check as proof. |

**Important distinctions:** conditional claiming prevents duplicate claims of one row, not semantic duplication or dependency sufficiency. ARTEX's serial-chain and prioritization rules are mainly prompt guidance. Its planner is mostly coordinating, but permits limited initial probing; role names are not a security boundary. Not every graph write wakes planning. Its quota router suppresses replay after committed output, but does not provide general exactly-once target execution (`A/server/task_llm.go:297-385`). Do not import automatic failover.

### 2.2 How roles are decided

ARTEX separates goal decomposition, planning, execution and reporting. Its MainAgent does not continuously investigate (`A/agent/mainagent.go:84-101`). Workers receive intent-specific objectives and configured tools; final tools depend on bindings/overrides and skill resolution (`A/server/assembly.go:240-294`). Its per-intent CWD is organizational separation, not an OS confinement guarantee.

P2O must retain its working lead and existing roles (`P/src/roles.ts:9-27`, `P/src/roles.ts:78-89`). The lead chooses a role from the unanswered question, not merely a task's age, an alarming keyword or a desired finding count:

| Question/context | Assigned role | Required output | Next decision |
|---|---|---|---|
| Entry, actor, gate or consumer is unclear | `recon` | Evidence-linked inventory and smallest unknown | Focused mapping, or discovery of a concrete boundary hypothesis |
| A specific boundary/invariant concern needs investigation | `discovery` | Trace/hypothesis, contrasting predictions, controls and limitations | Separate validation, ruled-out control, or open gap |
| A plausible candidate needs a different worker's reproduction | `validation` | Attributed receipt and current candidate conclusion | Lead reviews effect and counterevidence; no self-validation |
| Claims/evidence are ready for synthesis, including partial results | `reporting` | Reviewed findings, coverage, gaps and limitations | Formatting does not create proof or erase unresolved work |
| A bounded support question fits none of the above | `general` | Explicit narrow deliverable | Explain why a specialist is unnecessary |

Keep model/thinking precedence: explicit spawn override → user role settings → package default → parent. Keep skill-ID validation and the current maximum starting skill count. Record the chosen role and evidence-based reason; do not replace lead judgment with a classifier or automatic stage switch. A recon/discovery pipeline is **per surface**, not a requirement to map the whole target first.

### 2.3 How the loop is maintained

Useful ARTEX mechanisms are durable intent state, completion/finding events, retrievable worker history, retained planner todos and expandable cold-graph digests (`A/agent/planner.go:106-145`, `A/agent/compaction.go:49-102`, `A/agent/tools_digest.go:117-130`).

Adapt them conservatively:

1. Rebuild a deterministic view of current questions, evidence, assignments and unresolved work.
2. Provide the lead a bounded **delta since its last cursor**, not the entire history again.
3. Refresh the active worker's objective after context rebuilding, without changing scope or expiry.
4. Preserve explicit partial/blocked outcomes; the lead may select another feasible branch or stop.
5. Use existing blocking waits when waiting on work. A timer, silence or an idle pane is not proof of progress/failure.
6. During stopping/finished, only reconciliation and cleanup may continue. No queued follow-up may revive the assessment.

ARTEX todos are retained in a cached planner instance; cross-process persistence is not established. Its graph/overview scans are capped and compaction is lossy. P2O should implement complete deterministic projections before considering model-generated digests. No detached summarizer, global asset graph, automatic process restart or new background planner is proposed.

## 3. Both skill systems and technique improvements

### 3.1 ARTEX skill behavior

ARTEX skills can expose configured MCP names/schemas through a shared unlock set; history restores those unlocks (`A/server/assembly.go:25-148`, `A/agent/deferred.go:29-49`). Connections/tool listing can happen before invocation, so this is deferred exposure—not necessarily deferred transport setup.

Its API-recon method usefully separates static candidates from runtime observations, requires controlled sample comparisons, records adapted-script provenance, bounds context output and stops repeated failed commands (`A/skills/api-recon/SKILL.md:30-124`).

Borrow the methodology, not the scripts or authority: mocked frontend login does not establish backend permission; static endpoints do not establish deployment; single samples do not establish parameter requirements. Browser/WS/SSE/crawler/mock-login workflows and mandatory script order are inapplicable to P2O's current URL contract.

### 3.2 P2O skill behavior

P2O skills are **approved methodology, not tool-unlocking permissions**. Preserve catalog-ID-only access, FD-relative/no-symlink reads, bounded pages and document hashes (`P/src/skills.ts:15-38`, `P/src/skills.ts:82-114`). Package hashes identify documents, not target evidence or installed binaries. Do not restore the removed capability registry.

A selected method should carry: skill/workflow ID, document hash, selection reason, accepted prerequisite packet, missing prerequisites, expected observation, evidence output and stop condition. Initially reuse current workflow `id`, `description` and descriptive `prerequisites`. Put task-specific acceptance state in owned task records; richer catalog fields would require an explicit schema migration in both runtime and library validators.

### 3.3 Concrete library updates

| Existing P2O documents | Enhancement |
|---|---|
| `skills/attack-surface-mapping/SKILL.md`, `skills/web-route-input-inventory/SKILL.md` | Record extraction method, static/observed distinctions, stable surface IDs, next question and branch stop condition. Avoid whole-target completeness claims. |
| `skills/source-code-auditing/SKILL.md`, `skills/data-flow-analysis/SKILL.md` | Hand off the minimal controllable-input → gate → consumer slice; name competing predictions and missing edges instead of re-running a broad audit. |
| `skills/authorization-auditing/SKILL.md`, `skills/web-object-authorization/SKILL.md`, `skills/fastapi-security-parity/SKILL.md` | State intended-policy provenance, actor/object matrix and effective route/consumer enforcement. Unsupported live authenticated comparison stays a gap. |
| `skills/parser-differential-auditing/SKILL.md`, `skills/state-and-lifetime-auditing/SKILL.md` | Preserve representation/state transitions, failed assumptions and the smallest next observation; do not broaden into unauthorized race testing. |
| `skills/dynamic-analysis/SKILL.md`, `skills/exploitability-assessment/SKILL.md` | Record known-good baseline, controls, repetitions/denominator, original versus modified environment and bounded impact. A simulation or crash is not deployment/execution proof. |
| `skills/remediation/SKILL.md`, `HANDOFFS.md`, `templates/handoff.json` | Consume reviewed current claims; distinguish repair proposals from deployed fixes and reporting from independent reproduction. |

Keep main skills concise; detailed methodology belongs in approved references and owned recipes. Shared coordination conventions can live in handoff/state documentation. Add a new technique skill only for a demonstrated recurring method gap, not merely to hide a scheduler inside a prompt. Never copy ARTEX scripts into a runtime recipe or add an implicit installation/download step.

## 4. P2O gaps and target design

### 4.1 Current gaps

| Gap at the baseline | Existing implementation | Proposed fix |
|---|---|---|
| Tail reads and capped summaries are not complete reconciliation | `P/src/records.ts:38-101`, `P/extensions/p2o/index.ts:267-285`, `P/extensions/p2o/index.ts:501-515` | Full run index; bound/paginate only display; expose exact totals and omissions. |
| Old evidence/revisions can fall outside lookup/export windows | `P/src/evidence.ts:49-66`, `P/src/evidence.ts:87-98` | Stable full-ledger ID/revision lookup; no silent tail export. |
| Full normalized report is held in memory but only partly recorded | `P/src/broker.ts:278-285`, `P/extensions/p2o/index.ts:716-726` | Attributed complete bounded report plus reporting manifest before cleanup. |
| Objective and selected workflow are mostly startup prose | `P/src/prompts.ts:77-111`, `P/extensions/p2o/index.ts:175-221` | Refreshable per-surface question and explicit method/handoff state. |
| Worker budgets/settlement lack detailed progress and attempt lineage | `P/src/broker.ts:187-200`, `P/src/broker.ts:217-244`, `P/extensions/p2o/index.ts:787-801` | Observable terminal classes, separate worker/lead counters and bounded closure reserve. |
| Independence can reference an earlier validator confirmation | `P/src/evidence.ts:49-66` | Latest-revision-aware validation and stale-link warnings. |

These are static conditional gaps, not reproduced live loss. Existing candidate policy/provenance checks, ledger-by-ID retrieval, independent worker requirements and cleanup are already implemented; do not describe them as absent.

### 4.2 Complete state, bounded presentation

Use the run-owned ledger as source of truth and a deterministic index/projection for navigation. Proposed pure modules: `src/tasks.ts`, `src/progress.ts`, `src/report.ts`; exact APIs are implementation decisions, not tools already available.

- Preserve valid legacy rows without `runId` only when read from the current run-owned ledger; reject explicit foreign-run rows.
- Track real counts, current revisions, unresolved IDs and stable record lookup independently of page length.
- Bound file processing, memory, record sizes and responses. On resource/integrity limits, disclose incomplete reconciliation and refuse dependent proof closure; do not silently substitute a tail.
- Damaged tails, duplicate/missing IDs, invalid revisions and missing report parts need explicit diagnostics.
- Preserve full **normalized** reports, not unlimited raw transcripts. A report can exceed the existing 16 KiB append-record ceiling: use bounded parts plus a hashed final manifest, or another bounded representation. Do not increase broker/record caps to make one oversized append succeed. Incomplete persistence must not be acknowledged as complete.
- Freeze the final candidate/report frontier before temporary cleanup. Opt-in export stays opt-in and redacted; failed/truncated retention remains visible even when cleanup must proceed.

### 4.3 Task and handoff state

Each bounded task records:

- run/task IDs, parent/predecessor, surface and risk;
- one falsifiable question and expected true/false observations;
- evidence IDs, known unknowns and accepted prerequisite versions;
- selected role/reason, skill/workflow IDs/hashes and stop condition;
- assignee, reservation type, status, outcome and last observable event;
- revision/validation lineage and remaining allowance information.

Separate task status from candidate closure and run lifecycle. A reported task is not necessarily reviewed or closed. Preserve existing run phases `starting`, `active`, `stopping`, `finished`.

**Writer boundary:** only owner-controlled service operations may create/accept tasks, change assignments or reserve authority. Worker notes/reports may propose observations or requests, but cannot forge owner task state. Do not simply add owner-only kinds to the generic worker-writable note enum. Evidence acceptance is an attributed lead decision, not a worker's self-declared “done.”

Reserve canonical surface/risk assignments atomically with spawn. Exact-key reservations are not a claim of semantic deduplication; the lead still checks aliases/overlap. Independent validation may deliberately overlap through a separate explicit reservation. Reject dependency cycles and stale/missing packets; release reservations on failure, withdrawal, expiry and cleanup.

### 4.4 Lead-maintained decision loop

```text
                    reconcile current state + new events
                                  ↓
                  select one next question and explain why
                                  ↓
             investigate directly OR reserve/delegate focused work
                                  ↓
                 bounded observation → report → lead review
                                  ↓
           validation / new question / ruled-out control / open gap
                                  ↓
           continue within scope OR wait OR finalize and clean up
```

Prioritize qualitatively by reachable influence, sensitive boundary, evidence strength, information gain and remaining budget. Record expected/disconfirming observations; do not use arbitrary vulnerability scores as proof.

Successor decisions:

- unclear gate/actor → return the smallest mapping question;
- concrete hypothesis → bounded discovery;
- plausible candidate → different-worker validation when available;
- conflicting/new evidence → revise state and invalidate stale acceptance;
- no new information → stop the branch, preserving tested/untested distinctions;
- unsupported prerequisite → open gap and another feasible question, not tool installation;
- outstanding dependency → bounded wait, not premature parallel work;
- no feasible work, exhausted budget, human stop or expiry → partial reporting and cleanup.

Completion is not “found something” or “all workers idle.” Reconcile all assignments and unresolved items; retain limits and verify cleanup. No mandatory new task merely because a question remains unanswered.

## 5. Implementation phases and acceptance gates

### Phase 0 — freeze contracts and failure fixtures (P0)

**Files:** existing minimal records/evidence/broker/roles/extension tests; proposed pure state fixtures.

- [x] Define state/authority boundaries, backward compatibility and bounded schemas.
- [x] Add synthetic histories crossing 100/500/10,000 records, stale validation and damaged/incomplete report cases.
- [x] Specify lifecycle and reservation transitions; validate immutable scope/deadline fields.
- [x] Define requested/effective model and thinking metadata without reading credentials.

**Gate:** baseline regression remains intact. Tests distinguish data formatting/enforcement from unproved semantic quality. No runtime import of ARTEX.

### Phase 1 — evidence integrity and reporting projection (P0)

**Files:** `src/records.ts`, `src/evidence.ts`, proposed `src/report.ts`, `extensions/p2o/index.ts`.

- [x] Stream/index the complete valid run ledger; add bounded cursor traversal and stable ID lookup.
- [x] Replace tail-dependent candidate/reference/revision checks and export selection.
- [x] Make independence refer to the latest relevant validator conclusion/receipt; detect withdrawn or superseded support.
- [x] Persist complete normalized worker reports through bounded parts/manifests where necessary.
- [x] Freeze current candidates, controls, confidence, blocked/open coverage and retention warnings before cleanup.

**Gate/tests:** old unresolved IDs remain visible; all pages reconcile exact counts; foreign-run records are excluded; invalid/missing state is disclosed. Validator confirm → supersede → ruled-out/open-gap cannot silently retain independent confirmation. Crash during report persistence and oversized export cannot masquerade as complete evidence. Keep append-only history and opt-in retention.

### Phase 2 — focused tasks, role decisions and accepted handoffs (P1)

**Files:** proposed `src/tasks.ts`, `src/roles.ts`, `src/broker.ts`, `src/prompts.ts`, extension spawn wiring, handoff template.

- [x] Record a question, known evidence, contrast, selected role/method, expected output and stop condition.
- [x] Add owner-only task/acceptance operations; reuse H1/H2 and other relevant envelopes without requiring a universal pipeline.
- [x] Atomically reserve ordinary assignments and explicit separate validation assignments.
- [x] Validate prerequisite versions and release reservations on all failure/terminal paths.
- [x] Pass the selected workflow into the worker brief; preserve model/settings override precedence.

**Gate/tests:** concurrent reservations, aliases requiring lead review, missing/stale prerequisites, cycle, validation overlap, spawn rollback, cancellation during spawn and report revocation. Worker input cannot alter owner-only fields; a role label/report cannot certify proof.

### Phase 3 — long-task refresh and bounded maintenance (P1)

**Files:** proposed `src/progress.ts`, `src/prompts.ts`, `src/records.ts`, broker/wait/settlement wiring.

- [x] Expose change cursors and compact event summaries through existing owner coordination.
- [x] Refresh the current question/worker objective inside an already-active run after context rebuilding.
- [x] Keep scope/expiry immutable; retained state after restart is report-only, not execution authorization.
- [x] Classify observed completion, partial budget, prerequisite block, process/provider error, cancellation/expiry; use unknown/stall-suspected when telemetry is insufficient.
- [x] Reserve existing coordination capacity for notes/candidates and keep reporting independent of knowledge exhaustion.
- [x] Expose worker and direct-lead command usage separately; the current broker counter is worker-only, not an aggregate spend ceiling.

**Gate/tests:** fake clocks and event bursts, duplicate cursor delivery, queued versus quiet versus failed, no new evidence, budget exhaustion, terminal quota error and stop while waiting. No timer-triggered model call, hidden retry, queued follow-up, new ticket/container, increased allowance or target operation during finalization. Preserve one lead policy section and actual tool schemas; refresh observations as labeled data, not new policy.

### Phase 4 — skill methods, references and acceptance packets (P2)

**Files:** skills listed in §3.3, `src/skills.ts`, `src/roles.ts`, catalog/sidecars, `HANDOFFS.md`, `templates/handoff.json`.

- [x] Update role/method selection and handoff outputs with question, evidence, controls and smallest missing field.
- [x] Record document hashes and validated workflow metadata; distinguish package text from target evidence.
- [x] Preserve descriptive prerequisites, safe pagination and ID-only document access.
- [x] Add relevant controlled-sample/provenance/stop-repeat methodology adapted from ARTEX, not its scripts or mandatory browser stages.
- [x] Update both TypeScript/Python validators if owned schemas change; no silent new catalog keys.

**Gate/tests:** unknown workflow/skill, wrong selected-skill membership, changed hash, Unicode pagination, missing actor/control/provenance, unsafe symlink/path and incompatible URL method. Skill text cannot enable tools or change scope. No dependency download or universal startup binary probes; existing task-relevant bounded checks remain allowed.

### Phase 5 — installed acceptance, documentation and release (P2)

**Files:** runtime/usage/skill docs, README, tests and a new bounded acceptance directory under `research/runtime/`.

- [x] Add an inert end-to-end scenario: map a surface → accept a handoff → delegate discovery → separate validation → revise a conclusion → reconcile gaps → finish/verify cleanup.
- [x] Add partial-budget, terminal-provider-error, stale-prerequisite and cleanup-failure variants.
- [x] Update docs for new state, role/method decisions, progress, retention and compatibility; preserve the lean prompt contract.
- [x] Run full regression/library checks and package exclusions, then selected inert Docker/visible Herdr checks where prerequisites exist.
- [ ] Commit → push → `pi install` → match installed revision/runtime hashes → run installed-path native normal/quota/Docker acceptance.
- [ ] Publish bounded reviewed receipts, recording skips/limitations honestly; never rewrite previous studies or session exports.

**Gate:** complete reconciliation or explicit incompleteness; no silent stale validation; original authority/deadlines preserved; report-only finalization; revoked worker access; verified container removal and honest pane failures. Inert results do not establish autonomous security effectiveness.

## 6. Validation and execution rules

Planned existing checks: `npm test`, `npm run check:library`, `npm pack --dry-run --json`, `npm run test:sandbox`, `npm run test:herdr`. These are implementation regression checks; provider-facing fixtures are scripted/inert. No live benchmark is included.

No live agent, paid test, external target, credential collection, new dependency or fresh benchmark is included. Any later explicitly authorized live agent must use:

```sh
pi --model gpt-6.1-sol --provider openai-codex-account-3 --thinking xhigh
```

Verify effective provider/model/thinking before substantive work; do not assume a role default or a task instruction sets thinking. Inert scripted providers are separate mechanical fixtures, not live agents or billing evidence.

Measure contract outcomes: complete cursor traversal, stale-link rejection, reservation release, objective recovery, explicit partial coverage and cleanup. Do not substitute turn counts, lexical benchmark scores, nominal SDK cost or worker status for security quality.

## 7. Explicitly out of scope

ARTEX-style orchestration-only lead; forced generation of new work; automatic provider failover/replay; global cross-target asset authority; model-generated summaries as proof; persistent execution resurrection; broader transport/credential/scanning features; unlimited budgets; detached summarizers; database/framework replacement; installation-driven capability registry; copy-pasted ARTEX code or scripts. Shared container/scratch organization does not imply worker-to-worker confidentiality or container-escape immunity.

## 8. Definition of done and next action

The enhancement is complete only when shipped, installed-path evidence shows:

- [ ] All relevant valid state is reconcilable despite bounded views; omitted/damaged state is explicit.
- [ ] Full normalized reports and current candidate/validation versions survive final reporting, within documented retention limits.
- [ ] The working lead can recover the current question and select a justified next step.
- [ ] Dependencies are accepted by evidence; reservations prevent exact duplicate dispatch and allow deliberate independent validation.
- [ ] Role/skill/workflow selection is explainable and cannot grant authority.
- [ ] Progress distinguishes observable outcomes from unknown silence and preserves closure capacity.
- [ ] Compaction, replay, worker text and terminal hooks cannot renew scope or continue target work after stop/expiry.
- [ ] Source/URL restrictions, worker revocation and verified cleanup remain unchanged.
- [ ] ARTEX remains reference-only; existing historical evidence remains intact.

**Recommended order:** evidence integrity first (including stale validation), then task/handoff state, then maintenance/skills integration and installed acceptance. The remaining step is installed acceptance and bounded receipt publication, not an autonomous campaign.
