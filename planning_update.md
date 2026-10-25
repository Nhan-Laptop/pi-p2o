# planning_update.md — make the run reachable, then make it truthful

**Status: L0, L1, L2 and the L3 re-measure are implemented in the working tree (2026-10-25), uncommitted. L2 independence met; the L1 <10% error target did not.**
This file records the plan. The implementation changes `src/`, `extensions/`, tests and docs (see Appendix D), starts no
model, contacts no target, and commits nothing.

**Why this revision exists.** Parts I–XI built the right vocabulary — typed plans, chain steps, candidate claims, cases,
coverage cells, a durable graph, derived completion. Two paid runs then measured what a real model does with it. The
binding constraint is no longer a missing board. It is that the run is often **unreachable** (workers cannot execute), the
tool contract is **hard to call correctly** (31.7% of calls fail on shape or lifecycle), and the closing report is **not
final** (it is an early snapshot, sometimes declared as the final one). ARTEX's most transferable lesson is not another
graph: it is that **shape belongs in the host, judgment belongs in the prompt, and a report is a projection, never a
termination verb.**

**Owner decisions in force** (they outrank anything below):

1. **No work budgets.** No command ceiling, per-purpose allowance, admission reserve or planner-round cap.
2. **No finish gate.** A report is not termination; completion is derived.
3. **No scope/origin enforcement.** The start action is the authorization; the container is the boundary.
4. **Evidence rules stay.** A claim is demonstrated only by confirmed + tested evidence; leads are not evidence;
   interruption is recorded, never laundered into coverage.
5. **This revision does not add a new board.** It makes the existing boards provisionable, callable and final.

---

## 0. What changed, and what this revision replaces

### 0.1 The two measured runs

| Run | Shape | Result | What it exposed |
|---|---|---|---|
| **S9 benchmark** (`tmp/s9-report.md`) | `fastapi-parity` vulnerable, arm C, `deepseek-v4.1-flash`, 45 min / $29 cap | 41 turns, 5 target commands, $0.0736, recall 1.00, precision 0.75, proof/gap/evidence 1.00; fixed variant 18 turns, $0.0354, precision 1.00 | finish exported before the run was settled; a worker lost its executor; the benchmark's no-delegation flag did not prevent delegation |
| **Live lab** (`run-01bba710-52ab-4408-af57-3e4b2c9e17f9`; findings at `/tmp/claude-1000/-home-nhanlaptop-project-pi-p2o/55ffdbef-fb6b-4620-b2e5-4c2366e91a72/scratchpad/live-run-findings.md`) | local `lab-server.mjs`, `deepseek-v4-flash` thinking max, 2 workers, isolated, target-ops 2, 37m37s, $0.3820 | 87 lead turns, 126 tool calls, **40 errors (31.7%)**, 2 accepted findings + 1 ruled-out control, 25 open gaps; **3/3 workers blocked, 19/19 worker operations failed** | the executor provisioning chain (below), the tool contract, the missing validation split, the non-final report, and the operator's inability to inspect a finished run |

Both runs found the seeded defects and reported honest gaps. Neither failed because the model could not reason about the
target. They failed because the host made the next correct action unavailable, ambiguous, or invisible.

### 0.2 The thesis

> **A run is only as good as its ability to provision the next executor, name the next legal transition, and write the
> final snapshot from the final sequence.** Everything else — more prompts, more boards, more tools — is secondary until
> those three are true.

ARTEX reaches the same place from the other direction: its planner cannot mark a goal met without `prove_goal`; its worker
cannot claim an intent whose parent is not a `fact`/`finding`; its report is generated from the graph; its tool surface is
a set of verbs with typed parents. The mechanisms are small and mostly host-side. That is the model for this revision.

### 0.3 What is replaced

Parts I–XI and phases A–K/B–K/S1–S9 are **condensed into Appendix A**; their full text remains in git history and the
`tmp/` archives. Nothing in this revision re-opens the no-budget, no-gate, no-scope or evidence decisions. It replaces the
*plan of work* with four workstreams and three phases, each with a hermetic acceptance test and a measured target.

---

## Part I — Evidence, restated as failure chains

### I.1 S9, in one line

A 41-turn run found all three expected authorization defects and no overclaims, but exported a report while one obligation
was open, then failed to obtain independent replay because its only delegated worker could not execute. The benchmark's
`--delegation` flag was not an enforced runtime control.

### I.2 The lab run, in one line

A 87-turn run found both seeded defects with live owner receipts and negative controls, but **no worker ever executed a
target operation**, **no validation task survived the admission gate**, the tool layer rejected 40 of 126 calls, and the
final report on disk was a draft exported twelve records before the run ended.

### I.3 The five failure chains

Each chain is stated as observed → cause → host fix. Evidence ids are from the run above; file/line references are the
current tree at `056606f`.

**F1 — Executor provisioning kills the executor.**

- Observed: the container runs as `pentester` (uid 1000); `/work` is `root:root` 755. `mkdir -p /work/<worker>` fails
  (`Could not prepare the sandbox working directory /work/p2o-discovery-…`). The next operation says
  `Assignment executor unavailable; report partial, no automatic restart`. 19 worker operations, all `exit -1`; zero
  successful worker operations.
- Cause: `src/sandbox.ts` adds no `--user`, so the image's default user runs. `Sandbox.ensureWorkdir` runs
  `mkdir -p /work/<id>` as that user. Its caller `Sandbox.exec` catches **any** error, sets `stopped = true`,
  cancels and calls `removeAll()`. `ExecutorPool.acquire` publishes the lease before the first command, so a single
  permission error destroys the executor and every later `use(id)` fails closed.
- Host fix: **provision once, before the lease is usable; never let a provisioning error tear down a sandbox that was
  successfully started.** Run the container as root (explicit `--user root`, matching Part XI) and create
  `/work/<assignment>` during `acquire`, before `leases.set`. If the image's tooling refuses root (measured, not
  assumed), fall back to a one-time `docker exec --user root mkdir` + `chown pentester` and record which path ran.
  A failed provision fails the assignment **before a worker pane, ticket or model turn exists**, and records a host-owned
  prerequisite on the task; it never produces `Assignment executor unavailable` on a later operation.

**F2 — The tool contract is an action bag, and the model pays for it.**

- Observed: 40/126 errors, concentrated in `p2o_task` 12/22, `p2o_case` 13/22, `p2o_coverage` 9/17, `p2o_plan` 4/6.
  Six consecutive `p2o_coverage cell-create` calls returned the identical `Missing or stale coverage plan revision`;
  `p2o_case create` was used to accept a case; `p2o_task start` and `dispatch` were given a `reason` field the schema
  forbids; `p2o_case rate` failed five times on reference order, unknown evidence and a 200-character note.
- Cause: one tool per board with an `action` enum, a union schema, and a state machine whose legal transitions are
  discovered by trying. Error text names the symptom, not the current revision or the legal next verb. `p2o_task`'s
  description still advertises `start … ONLY in solo mode` after `--solo` was removed in `056606f`.
- Host fix: **verbs, not action bags** (Part IV W2). Each transition is its own tool with a closed schema, an explicit
  precondition and an error that returns the current revision plus the legal next verbs.

**F3 — Independence never happened, and the lab could not be replayed across sandboxes.**

- Observed: 3 tasks, all `discovery`, 0 validation tasks. Four `p2o_task create` calls with `disposition: validate` were
  refused with `Validation overlap needs a matching predecessor`. Both accepted findings carry
  `independent validation: none` and a waiver naming the worker executor defect. Workers could not read the owner's
  payload/environment (`Invalid payload ID`; `fetch http://127.0.0.1:18081/healthz failed`).
- Cause: `src/tasks.ts` requires a validation draft to name the prior task **revision** and pass `sameQuestion`; the
  owner had no reviewed predecessor when it tried, and the gate has no host-built path. `p2o_lab` is run-scoped and
  reachable through the broker, but the worker is told to reuse an id that belongs to another sandbox's lifecycle; a
  worker that has never created the environment cannot verify it.
- Host fix: **a portable recipe and a host-created validation assignment.** The worker materializes the recipe in its
  own sandbox; the engine, not the operator, creates the one validation task per confirmed claim for a different worker.

**F4 — The report is not final, and the final path cannot replace it.**

- Observed: the first `p2o_finish {export:true}` wrote `report-run-…` as of sequence 436 with `NONTERMINAL_CELLS (3)`
  and one open obligation. The run continued (control case, plan revision) to sequence 449. At cleanup,
  `writeAutoReport` found the directory already existed, set `current.reportPath` to it and returned **as if it had
  written the report**. The disk report stayed the 436 snapshot; its banner says “a report was exported while the run
  stayed active”. `finalize('finished')` hardcodes `assessmentOutcome: incomplete`, while the completion line says
  `complete: no goal, primitive or ready step is left open`.
- Cause: `extensions/p2o/index.ts` `writeAutoReport` treats “directory exists” as “report already final”; the hardcoded
  `finalize` outcome ignores `deriveCompletion`.
- Host fix: **a final snapshot with its own name, written after the run has stopped, from the final sequence; drafts are
  drafts.** No export can suppress it. The final report renders the stored outcome next to the derived completion and
  flags a mismatch; replacing the stored constant is a separate, unadopted decision (parking).

**F5 — The operator cannot inspect the run at the point it ends.**

- Observed: `/p2o tasks` is not a command (it falls through to the start usage line); `/p2o log` and `/p2o workers` refuse
  after the final finish; `/p2o status` serves an in-memory historical summary. A read-only `/p2o open <run-id>` works.
  `docs/USAGE.md` has a corrupted settings row (“Các dòng còn lại026-10-10…”).
- Cause: `src/ui/state.ts` `parseStateCommand` knows only `status`, `log`, `report`; `workers` lives in
  `parseOperatorCommand` and requires an active run; the finished view is a `lastStatus` cache, not a store read.
- Host fix: **not adopted in this pass** (owner chose final-snapshot only). It stays on the parking lot with an explicit
  consequence: until a store-backed inspector exists, post-run evidence is read through `/p2o open`, and the final report
  must carry the sequence and outcome that `status` would otherwise be asked for.

### I.4 What the evidence does not say

- It does not say the model is too weak or the target too hard. Both runs found the seeded defects with live receipts.
- It does not say the unused tools are dead. `p2o_state`, `p2o_artifact`, `p2o_delegate` and `p2o_loop` were unused by
  the lead in one run; that is one sample, not a deletion argument. Part X's no-merge decision stands.
- It does not justify a new board, a new budget or a new gate. Every fix below is host-side correctness or observability.
- It does not prove the `/work` fix alone is sufficient: the report and validation chains are independent of it.

---

## Part II — What ARTEX does, and what transfers

Read from the design report (`tmp/artex-design-report.md`), not from its marketing docs.

### II.1 The five transferable patterns

| # | ARTEX pattern | Where it lives | p2o today | Transfer decision |
|---|---|---|---|---|
| A1 | **Provision the worker's run dir once, before the worker runs.** `ensureRunDir(base, taskID, intentID)` builds `<base>/tasks/<taskID>/i<intentID>`; the engine owns the root. | `agent/worker.go:308`, engine claim path | `Sandbox.ensureWorkdir` is lazy, inside `exec`, and its failure destroys the sandbox | **Adopt.** W1. |
| A2 | **Tools are verbs with typed parents.** `add_intent`, `record_fact`, `report_finding`, `prove_goal`; an intent may only parent on a `fact`/`finding`. | `agent/tools.go:1032-1090` | one `action` bag per board; union schemas; legality discovered by error | **Adopt.** W2. |
| A3 | **Shape in the host, judgment in the prompt.** Node kinds, state enums, edge kinds, revision/`ON CONFLICT` and proof are schema; prose only advises. | `db/schema.sql`, `db/constants.go` | revision and transition rules exist, but errors do not expose them; some prose is stale | **Adopt.** W2 (errors carry current revision and legal verbs). |
| A4 | **A report is a projection; there is no finish verb.** `prove_goal` is the only completion act; the report is rendered from the graph. | `agent/planner.go:315`, `report/report.go` | `p2o_finish {export}` and the auto report can disagree; a draft can masquerade as final | **Adopt.** W3. |
| A5 | **The second reader is a role, and evidence has a version.** The reporter agent is read-only w.r.t. discovery; a report stores the evidence version it read, and staleness is computed. | `server/orchestration.go:729`, `db/finding_traffic.go:238`, `report/findings.go:181` | cases carry revisions and claims, but a validated case can be accepted on owner-only receipts with a waiver | **Adopt in part.** W4 (independent validation + portable replay); evidence-version stamping is a later candidate, not this pass. |

### II.2 Secondary patterns worth keeping in mind

- **Truncated views announce their total** (`frontier_open`, `findings_total`, `done_intents_total`). p2o already has
  `omittedCells` and `SEGMENT_FIELDS`; W2's `p2o_board` must return `total` and `shown` together, never a bare slice.
- **Gate by omission** (`DropCoverageTools`, `stripTrafficParameters`). p2o's role lists already do this; W2 must keep the
  worker loadout unchanged and must not expose owner transition verbs to workers.
- **Five terminal states** (`done/blocked/exhausted/stopped/paused`). p2o has `blocked/stopped/exhausted` and a derived
  completion; W1's failed provision becomes a host-owned `blocked` prerequisite, not a fake worker result.

### II.3 What not to copy

- **Model-chosen priority integers.** p2o keeps derived `suggestPriority`.
- **An in-memory planner todo store.** p2o's plan board is in the ledger.
- **Prompt-only liveness** (“0 intents = stalled”). If kept, assert it in the engine; do not rely on prose.
- **No dedup and no evidence gate on findings.** p2o already has stricter claim/case rules; keep them.
- **Two ID spaces for one object.** ARTEX's `finding_id` vs `finding_node_id` costs a permanent guidance paragraph; W2
  must use one id per board and name the kind in the error.
- **A prompt field the code stopped emitting.** W2's parity test exists so this cannot recur.

---

## Part III — Decisions

Owner decisions, 2026-10-25. Chosen mechanisms are requirements; unchosen ones are explicit non-goals for this pass.

| # | Decision | Consequence |
|---|---|---|
| D1 | **Executor: provision-once + root/chown.** Run the container as root (`--user root`) and create `/work/<assignment>` before the lease is published. If a required tool refuses root, fall back to a one-time root `mkdir` + `chown pentester`. | W1; the fallback is a measured gate, not a silent choice. |
| D2 | **Tool surface: split the four high-error mega-tools into transition verbs.** No `action=check`; each verb's schema is the check. | W2; 25 → 37 registered tools (23 → 35 owner-active); the new transition verbs are owner-only. |
| D3 | **Report: final snapshot at cleanup.** Auto-report writes `report-<runId>-final` after the run stops, from the final sequence; exports are drafts with their own names. The final report carries both the stored `assessmentOutcome` and the derived completion line, and flags a mismatch; changing the stored outcome is a separate decision (parking). | W3; the existing-dir early return is removed. |
| D4 | **Independence: portable recipe + host-created validation task.** A worker materializes the payload/environment in its own sandbox; the engine creates exactly one validation task per confirmed claim for a different worker. | W4; the manual predecessor gate is bypassed by the host path, not deleted. |
| D5 | **Not adopted in this pass:** store-backed `/p2o tasks` and post-run `log`/`workers`; a live cost cap; a manual predecessor-gate relaxation; resume re-dispatch; `action=check`; moving scratch to `/workspace`; removing or merging unused tools; global error enrichment outside the split; changing the stored `assessmentOutcome` constant. | Parking lot §IV.5. Each stays visible with its evidence, not silently dropped. |
| D6 | **No work budgets, no finish gate, no scope enforcement.** The cost cap is not re-introduced; the existing display-only usage ledger stays display-only. | Any spend guard remains external to p2o, as in both runs. |
| D7 | **One id per board, one kind per error.** A transition error names the board, the current id/revision and the legal next verbs. | W2's error contract; no second node-id space. |
| D8 | **A failed provision is a host prerequisite, not a worker result.** No worker pane, ticket or model turn is created for a failed assignment. | W1; the task is `blocked` with a host reason, re-dispatchable. |
| D9 | **Measure the plan on the same lab fixture.** The acceptance run is the local `lab-server.mjs` with 2 workers, isolated, target-ops 2, `deepseek-v4-flash` thinking max, capped externally. | §V phases; no benchmark file changes. |

---

## Part IV — Workstreams

### W1 — Executor provisioning and failure isolation

**Rule.** An assignment executor exists only after its scratch directory exists and is writable. A provisioning failure
never creates a worker and never leaves a half-live lease.

**Mechanism.**

1. `Sandbox` gains `provision(assignment: string): Promise<void>` and a `provisioned` set. `provision` creates
   `/work/<assignment>` and verifies `test -w` with one command; it is idempotent.
2. Container start uses explicit root (`--user root`) so `/work` is writable. The existing `HOME=/root`, writable rootfs
   and full capabilities are unchanged. A smoke test (`id -u`, `mkdir /work/probe`, `node --version`, `python3 --version`,
   `curl --version`) decides whether root is viable; if not, `provision` runs the root `mkdir` + `chown pentester` path and
   records `provisioner: 'chown'` in the executor snapshot.
3. `ExecutorPool.acquire(id)`:
   - create the sandbox and `await sandbox.start()`;
   - `await sandbox.provision(id)`;
   - only then publish the lease (`leases.set`), so `use(id)` can never observe a lease whose scratch is absent;
   - on failure: `sandbox.stop()`, remove the lease, throw `EXECUTOR_PROVISION_FAILED` with the underlying stderr.
4. `Sandbox.exec` no longer calls `removeAll()` for a workdir/provision error. It distinguishes:
   - `ensureWorkdir`/permission failure → throw, leave the sandbox alive, mark the executor unusable only for that
     assignment;
   - a target command that may leave background processes and is cancelled/timed out → the existing fail-closed path
     (stop and remove) stays.
5. `spawnWorker` awaits `acquire` before minting a ticket, registering a worker or starting a pane. On
   `EXECUTOR_PROVISION_FAILED` it records a `lifecycle` note and a host-owned task `blocked` reason
   (`missing prerequisite: writable /work/<id>`), then returns a typed failure. No model turn is spent.
6. `p2o_workers list` and the status snapshot expose `executor: {state: 'ready'|'provision-failed', provisioner}` so the
   operator sees the cause without reading the transcript.

**Files.** `src/sandbox.ts` (`LIMITS`, `provision`, `exec` catch), `src/executors.ts` (`acquire`, `use`, `snapshot`),
`extensions/p2o/index.ts` (`spawnWorker`, worker registration), `src/broker.ts` (workdir remains `/work/<workerId>`),
`src/ticket.ts` (no shape change; a failed provision never mints one).

**Acceptance (hermetic, no Docker).**

- `ExecutorPool.acquire` with a fake sandbox whose `provision` rejects: promise rejects with
  `EXECUTOR_PROVISION_FAILED`, `leases` is empty, no ticket is minted, no worker registration exists, and the task is
  `blocked` with the host prerequisite.
- A command that exits 1 after a successful provision leaves the executor usable for the next command.
- A `provision` failure does not call `removeAll`; a cancelled command still does.
- Docker smoke (existing isolated-docker fixture): `id -u` is 0 with the root path, `mkdir /work/probe` succeeds, and a
  worker shell reports `pwd` = `/work/<workerId>`.

**Measured acceptance.** On the lab fixture: 3/3 workers execute at least one operation; zero
`Assignment executor unavailable`; zero `Could not prepare the sandbox working directory`.

**Risk.** Root can change tool behavior (browsers, package managers). The smoke test is the gate; the chown fallback keeps
the measured pentester runtime. Either way, the Part XI text must say which path is active.

---

### W2 — Transition verbs for the four boards

**Rule.** A board transition is a named tool with a closed schema, not an `action` value. The schema and the error are the
documentation.

**Surface.** Replace the four action bags with 16 verbs. The registered tool count moves 25 → 37; the active owner
loadout moves 23 → 35 because `p2o_report` and `p2o_request_subtask` remain worker-only. The worker loadout is unchanged.

| Old tool | New verbs |
|---|---|
| `p2o_task` | `p2o_task_create`, `p2o_task_revise`, `p2o_task_start`, `p2o_task_dispatch`, `p2o_task_review`, `p2o_task_settle` |
| `p2o_case` | `p2o_case_create`, `p2o_case_revise`, `p2o_case_rate` |
| `p2o_coverage` | `p2o_coverage_plan`, `p2o_coverage_cell`, `p2o_coverage_cell_retire`, `p2o_coverage_suggest` |
| `p2o_plan` | `p2o_plan_create`, `p2o_plan_revise` |
| four `list`/`view` actions, plus task `match` | `p2o_board` (read: `tasks`, `cases`, `coverage`, `plans`; `id` views; `match=<draft>` on `tasks` runs the old read-only match) |

**Corrections to the first draft of this table.** The earlier table listed `p2o_plan_review` and `p2o_plan_close`, which
do not exist as plan actions; goal review/close is a status in `p2o_plan_revise`. It also folded `match` into create and
deleted `start`. The implemented surface keeps `match` as a read-only branch of `p2o_board` and keeps `start` as an owner
verb: Part XI removed the separate solo *loadout*, not the owner's ability to execute a task directly. These corrections
are the reason the count is 35 active owner tools, not 37; 37 is the registered total including the two worker-only tools.

**Rules.**

- `p2o_task_settle` takes `outcome: closed|blocked|cancelled`; `p2o_case_revise` carries the review decision
  (accepted/disputed/withdrawn) in the revised entry and requires `id`+`revision`. `p2o_plan_revise` covers goal status
  review/close; there is no separate plan review/close verb.
- Every mutating verb uses `id` + `revision` (create excepted). A stale revision is refused with the held revision and a
  `legalNext` string naming the verb and revision to use; the stored error type is unchanged.
- `p2o_coverage_plan` creates without `id` and revises with `id`+`revision`; `p2o_coverage_cell` creates with
  `planId`+`planRevision` and revises with `id`+`revision`. `p2o_coverage_cell_retire` requires
  `id`+`revision`+`reason`. `p2o_coverage_suggest` is a read-only verb, not a board filter.
- `p2o_board` is read-only and **owner-only**; workers keep their existing `p2o_ledger`/`p2o_state`/`p2o_graph` reads.
- Descriptions are rewritten per verb: purpose, precondition, return shape and refusal. Each verb has its own
  boundary sentence at registration, so splitting a bag cannot leave a verb unguarded.
- Parity test: every `TOOL_BOUNDARIES` key is a registered tool; no active tool or prompt names an old action bag; no
  `solo` wording; a deliberately injected old name or `solo` makes the test fail.

**Files.** `src/board-verbs.ts` (16 closed schemas and the action→verb map), `src/tool-policy.ts` (`OWNER_TOOLS`),
`extensions/p2o/index.ts` (registrations and retained action bodies), `src/tool-guidelines.ts` (family boundaries),
`src/prompts.ts` (no old names), tests (`.call`/native-provider migration), `README.md`, `docs/`.

**Acceptance.** Hermetic: mapping of every old action to one verb or `p2o_board`; stale revision text contains
`currentRevision` and `legalNext`; 37 registered tools, 35 owner-active, worker loadout exactly unchanged; parity test
fails on `solo` or a removed tool. Lab/paid: tool-result error rate **< 10%**, zero coverage-plan errors, zero
create-as-accept; that measurement needs a separate owner-approved cap.

**Risk.** More tools increase selection cost and prompt bytes. `p2o_board` keeps reads in one place and descriptions stay
one paragraph; if selection worsens, merge plan/cell create+revise by `id` presence (already the coverage shape), not
back into action bags.

### W3 — The final report is written at the end, and the outcome is derived

**Rule.** A draft export is a draft. The final snapshot has its own directory, is written after the run stops, reads the
final sequence, records the stored outcome and the derived completion, and flags a mismatch between them.

**Mechanism.**

1. `p2o_finish {export:true}` writes `report-<runId>-draft-<sequence>` (or `-export-N` for compatibility) and marks the
   manifest `kind: 'draft'`, `asOfSequence`, `completion`. It still ends nothing.
2. `writeAutoReport` writes `report-<runId>-final` after `cleanupOwnerPass` has recorded `run.stopped` and the final
   checkpoint. If the directory exists (a retry), it writes `-final-2`, never returns “already done”. It never treats a
   draft directory as the final report.
3. The final report renders from the final sequence, with:
   - `kind: 'final'`, `endReason`, `asOfSequence`;
   - the derived completion state and every remaining item (code + ids);
   - the run outcome (`assessmentOutcome`/`resourceOutcome`/`reason`) **and** the derived completion line, with an explicit
     `outcome/completion mismatch` note when they disagree;
   - no “a report was exported while the run stayed active” banner.
4. `store.finalize` keeps its current stored outcome. The final report is the place where the mismatch is made visible; it
   does not silently change the stored value. Changing the constant (`finalize('finished')` → `completion.state`) is a
   separate decision in §IV.5, not part of this pass.
5. The report manifest gains `draft|final` and `sequence`; `findings.json`/CSV keep their current shape. `/p2o open`
   continues to read the durable store; the final report is an index of it, not a second source of truth.

**Files.** `extensions/p2o/index.ts` (`writeAutoReport`, `defaultReportDirectory`, `cleanupOwnerPass`, `finalize`),
`src/state/bundle.ts` (`publishReportFiles`, manifest), `src/report.ts` (banner and end reason), `src/report-export.ts`
(if the manifest type lives there), `docs/ASSESSMENT_STATE.md`, `docs/USAGE.md`.

**Acceptance.**

- Two draft exports followed by a final finish produce two draft directories and one `-final` directory; the final
  `asOfSequence` is ≥ the `run.stopped` sequence; the draft banner never appears in the final.
- An existing `report-<runId>` from a previous draft cannot suppress the final; a retry writes `-final-2`.
- Goal `reviewed` + no remaining obligations → the derived `completion` is `complete`; if the stored `assessmentOutcome` is
  still `incomplete`, the final report prints both and flags the mismatch. Fixing the constant is deferred.
- A stop without export still writes the final snapshot and records the same outcome/completion pair.
- The report contains the completion line and the `run.stopped` reason; a reader can tell which sequence it represents.

**Measured acceptance.** On the lab fixture, the final report is the one produced after the last record; its sequence is
the final store sequence, and any `outcome/completion` mismatch is visible in the report (the constant itself is out of
scope for this pass).

**Risk.** Report-directory growth (two drafts + final per run). The retention policy is unchanged; drafts are still
bounded, redacted artifacts and can be pruned by the operator. No automatic deletion in this pass.

---

### W4 — Portable replay and host-created validation

**Rule.** A worker never needs another sandbox's live object. It materializes a recipe in its own sandbox. The host, not
the operator, creates the one validation task a confirmed claim is owed.

**Mechanism.**

1. **Payload materialization.** `p2o_lab {action:'payload', id, materialize:true}` (worker and owner) writes the stored
   bytes into `/work/<assignment>/payload/<id>` through `Sandbox.writeScratch`, verifies the sha256, and returns
   `{path, sha256, bytes}`. Reading the body remains available for the owner, but the worker does not need 32 KiB in the
   prompt. A wrong id is a typed error naming `payload-…` as the expected kind.
2. **Environment materialization.** `p2o_lab {action:'env', name, setup, services, seed}` is idempotent per
   `(name, fingerprint)`; a worker calling it in its own sandbox gets the same `environmentRef` and `verify` runs there.
   An id from another sandbox is refused with a message that says to create the recipe locally, not “Invalid payload ID”.
   The recipe may reference `/target` and `/work` only; host paths are already refused by `compose.ts`.
3. **Auto validation.** When `p2o_candidate` commits a claim with `closure:'confirmed'` and tested execution, the host:
   - computes a deterministic validation key from `runId + claimId`;
   - if no task with that key exists, creates one via the same `TaskBoard.create` path with `role:'validation'`,
     `decision:{disposition:'validate'}`, `validationOf:<discovery task>`, `work.claimRefs:[claimId]`,
     `prerequisites:[{taskId:<discovery task>, revision:<current>}]`, and `expectedTrue/expectedFalse/stopCondition` from
     the claim;
   - dispatches it through the engine; a fresh worker is spawned (not the claim's author; the pool excludes the original
     worker id when one is available);
   - never creates a second task for the same key, and never re-validates a validation task.
4. **Admission gate.** `src/tasks.ts` keeps the manual `validationOf` rule for operator-created tasks. The host-created
   task satisfies it by construction (role, prerequisite, same question, reviewed prior), so
   `Validation overlap needs a matching predecessor` no longer blocks the automatic path. A host-created validation task
   that is blocked records a prerequisite gap; it does not create a waiver by itself.
5. **Case independence.** A case's `independent` flag is true only when a validation task for that claim is reviewed
   accepted with its own evidence. Otherwise the report shows `independent: none` and the exact reason (blocked
   executor, blocked recipe, no worker). The waiver remains visible; it is never silently removed.

**Files.** `src/lab.ts` (`PayloadStore`, `EnvironmentStore`, materialize/write path), `src/broker.ts`
(`payload_read`/`environment` ops), `extensions/p2o/index.ts` (`p2o_lab` worker path, candidate hook), `src/tasks.ts`
(host-created validation admission), `src/engine.ts` (create/dispatch hook), `src/claims.ts`/`src/cases.ts`
(independence), `src/tool-schemas.ts` (`materialize`, `planRef`).

**Acceptance.**

- A worker materializes the owner's payload by id: the bytes on disk, sha256 and byte count match; the prompt does not
  contain the body.
- A worker creates the same environment recipe in its own sandbox and `verify` reports healthy; an owner-only id is
  refused with a “create it locally” message.
- One confirmed claim produces exactly one validation task, for a different worker, after the discovery task is reviewed;
  a duplicate candidate does not produce a second task.
- A reviewed validation report makes the case `independent: true`; a blocked validation leaves `independent: none` with
  the prerequisite reason.
- The manual `validationOf` path still refuses a mismatched draft; the host path passes with the same task-shaped input.

**Measured acceptance.** On the lab fixture, at least one finding is reproduced by a second worker, with no independence
waiver; if the executor is unavailable, the case is not marked independent and the final report names the prerequisite.

**Risk.** Auto-validation doubles model spend for each confirmed claim. The rule is one task per claim, no retry loop;
the operator can stop the validation worker. A recipe that needs a service the sandbox cannot run fails closed with a
recipe error, not a fake replay.

---

### IV.5 Parking lot (visible, not adopted)

| Item | Why it is not in this pass | What would bring it back |
|---|---|---|
| Derived `assessmentOutcome` from completion | Owner selected final-snapshot only; changing the stored constant is a separate decision | A run where the final report's visible mismatch is not enough for the reader |
| Store-backed `/p2o tasks`, post-run `log`/`workers` | Owner chose final-snapshot only; `/p2o open` remains the read path | A run where the final report is insufficient to answer “what is still owed?” |
| Live cost aggregation and `--max-cost-usd` | Part XI keeps spend display-only; the run harness capped externally | A provider bill above the external cap, or an operator request for a host cap |
| Manual predecessor-gate relaxation | Auto validation supplies the host path; the manual rule stays | A validation task the operator must create by hand that cannot satisfy the rule |
| Resume re-dispatch of interrupted tasks | Not chosen; resume keeps interrupted work interrupted | A resumed run where the operator must reconstruct more than a few tasks |
| `action=check` preflight | The verb split gives the schema the same information | A verb whose schema still cannot express the precondition |
| `/workspace` for isolated scratch | Provision-once addresses the ownership cause | A future image where `/work` cannot be made writable at all |
| Removing or merging unused tools | One run is not evidence; Part X's no-merge decision stands | A second run with the same zero-use pattern and a measured prompt cost |
| Global error enrichment outside the split | The split rewrites the errors where they matter | A remaining tool with the same repeated-error pattern |

---

## Part V — Phases and acceptance

Every phase keeps the standing verification: `npm run typecheck`, `npm run build`, `npm run check:build`,
`npx vitest run tests/minimal/`, `python3 scripts/validate_library.py`, and the pytest baseline (116 passed, 1 skipped,
1 pre-existing R1 provenance failure). Each phase adds hermetic tests; none calls a paid model or a target.

| Phase | Workstreams | Hermetic acceptance | Measured acceptance |
|---|---|---|---|
| **L0 — Reachability and finality** | W1 + W3 | fake executor provision failure blocks before spawn; command exit 1 leaves the executor alive; final report is `-final` after stop; existing draft cannot suppress it; outcome/completion mismatch is rendered, not hidden | lab fixture: all dispatched workers execute (target says 3/3 for three tasks; the measurement dispatched 2 and got 2/2); 0 executor failures; final sequence = store end; mismatch visible if present |
| **L1 — Contract** | W2 | old action → new verb mapping test; stale revision returns `legalNext`; parity test fails on `solo` or a removed tool; 37 registered tools (35 owner-active), worker list unchanged | lab fixture: tool error rate < 10%; zero coverage-plan errors; zero create-as-accept |
| **L2 — Independence** | W4 | worker materializes payload/env; one validation task per claim; independent flag only after a reviewed validation | lab fixture: at least one finding independently reproduced without waiver |
| **L3 — Re-measure** | all | same lab script, same model/thinking, same external cap; record cost, turns, error rate, executor failures, final sequence, independent findings | compare with the baseline table in §0.1; no benchmark file changes |

**Order rationale.** L0 is first because a tool cannot be measured while its workers cannot run, and a report cannot be
trusted while a draft can impersonate the final. L1 is next because the error rate is the largest model-visible tax. L2
is last because independence depends on an executor that runs and a lab that materializes. L3 is a measurement, not a
new mechanism; it decides whether L1's tool split actually pays for its extra tools.

**Rollback rule.** Each phase is mergeable alone. If L1's 37-tool surface makes selection worse, keep the W1/W3 fixes and
revert only the split; if L2's auto-validation is too expensive, keep portable replay and make validation operator-started
with the same host-built task shape.

---

## Part VI — Deletions and migrations

| Site | Change |
|---|---|
| `p2o_task`, `p2o_case`, `p2o_coverage`, `p2o_plan` registrations and their action enums | delete from the model surface; replace with the 16 verbs and `p2o_board` |
| `p2o_task start` and its handler | keep as `p2o_task_start`: the owner may still execute a task directly; only the separate solo loadout is gone |
| `p2o_task` description “start … ONLY in solo mode” | delete; the new verb descriptions carry the real preconditions |
| `writeAutoReport` early return on an existing directory | delete; drafts never suppress `-final` |
| `finalize('finished')` constant `incomplete` | keep in this pass; the final report renders the stored outcome next to the derived completion and flags the mismatch; changing it is a parking-lot decision |
| `docs/USAGE.md` corrupted `toolGuidance` row | repair in the W2 docs pass |
| `src/prompts.ts` names for the removed tools and actions | rewrite; parity test pins it |
| `tests/minimal/` fixtures that construct the old action shapes | migrate to the new verbs; keep the semantics, not the shape |

**Kept deliberately.** All 25 existing boundaries and their one-sentence descriptions (renamed where a verb replaces an
action); the worker loadout; the evidence/case/coverage semantics; the no-budget/no-gate/no-scope decisions; the
display-only usage ledger; the current `p2o_lab` run-private storage rules (payload bytes are never exported).

---

## Part VII — Risks, non-goals and success metrics

### VII.1 Risks

1. **Root breaks a tool.** Mitigated by the smoke gate and the chown fallback; either path records which one ran.
2. **Tool explosion.** 37 tools can cost selection accuracy. Mitigated by `p2o_board` for reads, one-line descriptions,
   owner-only transition verbs, and the L1 measured gate; the fallback is folding create/revise by `id` presence (as coverage already does), not `action=check`.
3. **Auto-validation spend.** One task per claim, no retry loop; the operator can stop it; the final report names a
   blocked validation rather than inventing independence.
4. **Final report growth.** Two drafts + one final per run; retention is unchanged; the operator may prune drafts.
5. **Portable recipe is not portable enough.** A recipe with a host-only path or a service the sandbox cannot run fails
   closed with a recipe error; it never becomes a fake replay.

### VII.2 Non-goals

- No new board, no new graph, no new scope/origin enforcement.
- No work budget, finish gate, planner-round cap or admission reserve.
- No model/provider switch, no benchmark edit, no commit/push/install in this pass.
- No removal of unused tools, no merge of existing boundaries.
- No change to the evidence vocabulary: a lead is not evidence, a waiver is not independence, an interrupted task is not
  a tested cell.

### VII.3 Success metrics

| Metric | Baseline (lab run) | Target after L2 |
|---|---|---|
| Tool-result error rate | 40/126 = **31.7%** | **< 10%** |
| Executor provisioning failures | 3/3 workers blocked, 19/19 ops failed | **0**, 3/3 workers execute |
| Final report sequence | draft at 436 of 449 | **final = final store sequence** |
| Outcome vs completion | `incomplete` + `complete` line | **mismatch rendered in the final report** (fixing the constant is deferred) |
| Independent validation | 0/2 findings, waiver on both | **≥ 1 finding independently reproduced** |
| Stale contract text | `solo` in `p2o_task`, corrupted doc row | **0 references**, parity test green |
| Cost | $0.3820, not a target | observe; external cap unchanged |

---

## Appendix A — Prior record (condensed)

The full text of Parts I–XI remains in git history (`git show fe0eeb4:planning_update.md`,
`git show f74286c:planning_update.md`, `git show 056606f:planning_update.md`) and in the `tmp/` archives.

| Part / phase | What it settled | Commit |
|---|---|---|
| P13–P16, Parts IX–X | typed chain vocabulary, derived completion, frontier floor, graph as medium, CVE leads, route diversity, tool boundary map | `5f969ff`, `5fab024`, `8b86858`, `fe0eeb4`, `f74286c` |
| Phase A–F | budgets out, interrupt honesty, chain board, dispatch obligation, derived completion, quiet-round escalation, revisit, continuation | commits in `5f969ff..fe0eeb4` |
| Phase G–K | goals that prove themselves, frontier floor/continue, graph write-back, CVE leads, routes/negation | commits in `8b86858..fe0eeb4` |
| Part XI S1–S8 | no solo, no frontier cap, research fetch, root/full privileges, no scope, reporting equals worker, no export confirm, resume | `056606f` |
| S9 | one paid weakness run on `fastapi-parity`; recall 1.00, precision 0.75/1.00; findings recorded in `tmp/s9-report.md` | `056606f` working tree |

The prior plan's mechanisms (M1–M9, P16.1–P16.9) remain implemented unless a row in Part VI deletes them. This revision
does not re-open them; it fixes the path that made them hard to exercise.

## Appendix B — Traceability

| Evidence | Failure chain | Workstream | Test |
|---|---|---|---|
| 19/19 worker ops `exit -1`; `Could not prepare … /work/<id>` | F1 | W1 | fake provision failure; docker smoke |
| 40/126 tool errors; six identical coverage revisions | F2 | W2 | verb mapping; stale-revision `legalNext`; parity |
| 0 validation tasks; `independent: none`; `Invalid payload ID` | F3 | W4 | materialize payload/env; one validation per claim |
| draft at 436, final at 449; auto-report early return; constant `incomplete` | F4 | W3 (+ parking) | draft vs final; final sequence; mismatch rendered |
| `/p2o tasks` absent; `log`/`workers` after finish; stale `solo` text; corrupted docs row | F5 | parking + W2 | parity test for the text; post-run read via `/p2o open` |

## Appendix C — Open items for the owner

1. **Root vs chown.** The plan picks explicit root with a measured chown fallback. If the smoke test shows a required tool
   refuses root, the fallback becomes the default and Part XI's “root” sentence is corrected to “pentester with a
   root-provisioned `/work`”.
2. **Auto-validation cost.** One task per confirmed claim is the rule. If the first measured run shows validation
   doubling cost without a second finding, the next revision may make it operator-started; that would be a new owner
   decision, not a silent setting.
3. **Report retention.** Drafts are kept; if a run produces many exports, the operator may prune them. No automatic
   deletion is introduced here.
4. **Parking-lot items.** Store-backed inspection, live cost cap, resume re-dispatch, tool removal and the stored
   `assessmentOutcome` constant remain unadopted; each has a trigger in §IV.5. A later revision can promote one without
   reopening this plan.

---

## Appendix D — L0 implementation log (working tree, uncommitted)

**W1 — executor provisioning.** `Sandbox` now starts with `--user root`, exposes `provision(assignment)`, and verifies
`/work/<assignment>` is writable before `ExecutorPool.acquire` publishes a lease. A failed start/provision stops the
sandbox, publishes no lease and throws `EXECUTOR_PROVISION_FAILED`; `spawnWorker` calls `acquire` before any Herdr pane or
ticket, marks the task `blocked` with the host reason and spends no model turn. `Sandbox.exec`, `captureScratch` and
`writeScratch` no longer retire the executor when only `ensureWorkdir` fails; target-command cancellation still fails
closed. Tests: `executors.test.ts` (provision failure leaves zero leases), `workspace-runtime.test.ts` (no pane/ticket,
task blocked), `sandbox.test.ts` (`--user root`).

**W3 — final snapshot.** The automatic report is now `report-<runId>-final` (or `-final-N`), written after
`store.finalize` and the final checkpoint. A mid-run `p2o_finish {export:true}` writes
`report-<runId>-draft-<sequence>` with manifest `kind: 'draft'`; an existing draft can never suppress the final. The final
manifest carries `kind`, `completion`, `remaining` and the stored `outcome`; `REPORT.md` prints the derived completion next
to the stored outcome and flags a `MISMATCH` rather than hiding it (the stored `assessmentOutcome` constant is not changed,
per the owner decision). Tests: `report-auto.test.ts`, `completion.test.ts` (mismatch rendered).

**Verification run.** `npm run typecheck`, `npm run build`, `npm run check:build`,
`npx vitest run tests/minimal/` (799 passed, 12 skipped), `P2O_TEST_DOCKER=1 npx vitest run tests/minimal/isolated-docker.test.ts`
(1 passed), a bounded `docker run --user root` smoke (`id -u` = 0, `/work` writable), `python3 scripts/validate_library.py`
(PASS), and `python3 -m pytest tests/ -q` (153 passed, 1 skipped, 1 pre-existing R1 provenance failure).

**Measured L0 runs (2026-10-25, `opencode-go/deepseek-v4-flash`, thinking max, cap $2.00 each; total $0.7430).**

- `run-c0785fb9-a4d5-47d6-b91d-e048f3db1606` (manual, 2 workers): 19 lead turns, lead $0.0867, total $0.2191; **2/2
  dispatched workers executed** (discovery 304cbc: 2 net + 6 shell; discovery 4c48b5: 3 capture + 5 shell), **0 executor
  errors**; final `-final` as-of **357 = store 357**; the run hit the 40-minute wall with two reports awaiting owner review.
- `run-b8d8b38e-7c7d-4b3a-810b-b1c0cd5a05b1` (event-driven, 3 slots / 2 dispatched tasks): 72 lead turns, total $0.5239;
  **2/2 dispatched workers executed** (discovery 5a7882: 8 ops; validation 55e518: 7 ops, one command exit 1), **0 executor
  errors**; final `-final` as-of **440 = store 440**; **2 accepted-current cases**; `/p2o stop` wrote the final after a
  finish-export left the run active.
- The §V "3/3" wording assumes three dispatched tasks. These runs dispatched two, so the applicable criterion is **2/2**,
  not 3/3; the third slot was idle by task count, not by executor failure.
- Both runs ended with stored `cancelled` and derived `incomplete`, so the `MISMATCH` line was not triggered; the mismatch
  rendering is covered by the hermetic `completion.test.ts` case (stored `incomplete` + derived `complete`).
- Both runs left 0 containers for their run label; settings were restored byte-identically. The first run's target was
  initially mistyped as `/tmp/p2o-l0-lab` and made no model call ($0); the corrected target was the sha256-pinned
  `/tmp/p2o-live-lab/lab-server.mjs` (`ff8b2575…`).

**L1 — board verbs (working tree).** Added `src/board-verbs.ts` with 16 closed verb schemas and the old-action→verb
map; extracted the four retained action bodies behind `executeTaskAction`/`executePlanAction`/`executeCaseAction`/
`executeCoverageAction`; registered `p2o_task_{create,revise,start,dispatch,review,settle}`,
`p2o_case_{create,revise,rate}`, `p2o_coverage_{plan,cell,cell_retire,suggest}`, `p2o_plan_{create,revise}` and
`p2o_board`. `p2o_board` views by id and runs task `match` as a read-only branch. `OWNER_TOOLS` is 35; `ALL_TOOLS` is 37;
the worker loadout remains 17. Stale refusals append `currentRevision` and `legalNext`. The four old bag names are gone
from the active surface and from `TOOL_BOUNDARIES`; every verb carries its own boundary sentence. Tests were migrated at the
call site (including the native scripted provider); `board-verbs.test.ts` pins the mapping, counts, stale hint, parity
failure and worker loadout. Full minimal suite: **804 passed, 12 skipped**. `npm run typecheck`, `npm run build`, `npm run check:build`,
`python3 scripts/validate_library.py` (PASS) and `python3 -m pytest tests/ -q` (153 passed, 1 skipped, 1 baseline R1
provenance failure) all match the L0 baseline.

**L2 — portable replay and host validation (working tree).** `PayloadStore` gained verified scratch materialization:
`p2o_lab {action:'payload', id, materialize:true}` writes the stored bytes through `Sandbox.writeScratch` to
`payload/<id>` under the caller's own `/work` or `/work/<assignment>`, and returns only `{path, sha256, bytes}`. The worker
path uses the host executor (`ExecutorPool.writeScratch`) through a new `payload_materialize` broker op, so the body need
not enter the prompt. `EnvironmentStore.put` now marks the registering sandbox; worker `verify`/`destroy` refuse an id
first registered elsewhere with a “create the same recipe locally with action=env” message. The recipe itself is unchanged
and idempotent per `(name, fingerprint)`, so two workers still receive the same `environmentRef` and each verify in its
own sandbox.

`src/validation.ts` owns the host-created validation shape and the read-only independence projection. A confirmed, tested
claim recorded against a discovery task is picked up when that task is reviewed; the host creates one task with
`role:'validation'`, `validationOf:<discovery>`, `decision:{disposition:'validate'}`, `work.claimRefs:[claimId]`,
`prerequisites:[{taskId:<discovery>, revision:<reviewed revision>}]` and the discovery’s committed question identity, then
queues it through `AssessmentEngine`. The task id is deterministic from `runId + discovery + claim slug`, so a duplicate
candidate cannot create a second one. A validation task is never itself re-validated. Without a worker backend the task is
created `blocked` with the prerequisite reason instead of a waiver; owner claims recorded during a task are included by
the review-time hook. Case independence is `true` only when a linked validation task is reviewed/closed with evidence
authored by its separate assignee; otherwise `CaseView.independenceReason` and the report name the exact missing/blocked
validation. The older peer-receipt path remains compatible. `AssessmentEngine.drain` now returns quietly when a stop/finish
lands during its worker reap, instead of surfacing an inactive-gate error from a timer that was already being torn down.

Tests: `validation.test.ts` (3 cases) pins deterministic task creation through normal `TaskBoard` admission, duplicate
refusal, case independence before/after reviewed validation, blocked prerequisite reason, same-actor refusal and the
manual `validationOf` mismatch rule. `lab.test.ts` adds payload scratch materialization and environment registration marks.
Full minimal suite: **809 passed, 12 skipped**. `npm run typecheck`, `npm run build`, `npm run check:build`,
`python3 scripts/validate_library.py` (PASS) and `python3 -m pytest tests/ -q` (153 passed, 1 skipped, 1 baseline R1
provenance failure) match the L0/L1 baseline.

**Docs touched.** `docs/USAGE.md`, `README.md`, `docs/ACCEPTANCE_MATRIX.md`, `src/prompts.ts` and `src/tool-guidelines.ts`
describe the final/draft split, board verbs, payload materialization and host-created validation; the remaining tool
tables/examples were updated to the new names.

**L3 — re-measure (2026-10-25, same lab, model/thinking, cap $2.00 planner-session and 40-minute wall).** Run 1
(`run-a19faf89-e104-4690-8ecd-e252bb4564c4`) was not a clean measurement: 43 planner turns, 86 calls, 17 errors
(19.8%), total $0.7168; discovery workers closed their tasks (revision 5→6) after the validation tasks were pinned to
revision 5, so both validation workers looped on `Missing or stale task revision` (85 and 106 errors) and the run hit the
40-minute wall with 0 independent findings. It exposed four host defects, all fixed and regression-tested before run 2:
the broker correlation field collided with a payload/environment `id` (`src/broker.ts`); a status-only terminal close
invalidated a pinned prerequisite (`src/tasks.ts`); coverage/case task references treated that close as superseded
(`src/cases.ts`, `src/coverage.ts`); and a stale coverage-cell plan error did not name the current plan revision and
legal next call (`extensions/p2o/index.ts`). Run 2 also exposed a false-negative independence projection: a lead claim
could be stamped with the validation task while the case cited the discovery and validation tasks, so
`reviewedValidation` returned `validation-missing`; `caseValidation` now accepts a reviewed, case-cited validation whose
assignee differs from the discovery assignee and who authored its receipt.

Run 2 (`run-b7c62120-4644-4a21-8509-96a6ef705228`, workdir `/tmp/p2o-l3-2026-10-25T13-09-43-329Z`) did not hit the
cap or wall (finish seen after ~30 minutes; manual stop at ~33 minutes): **62 planner turns, 161 tool calls, 58 errors =
36.0%**; **$0.497733 total**, planner **$0.205269** (156 messages across four roles); **5/5 workers reported**, **0
executor failures**, 5 tasks all reviewed; **2 accepted-current cases, both independently validated**; 6 coverage cells
and 31 open gaps; final report as-of **721 = store event 721**; 0 containers for the run label; settings restored
byte-identically. The 58 planner errors were dominated by the model repeating a stale coverage plan (20
`p2o_coverage_cell`), invalid goal-plan status (11 `p2o_plan_create`) and board-shape/dedup errors (7 `p2o_board`, 6
`p2o_plan_revise`), not by executor/lifecycle failures. A read-only re-export with the fixed projection
(`/tmp/p2o-l3-recheck-report`) reports both cases `Independent validation: current`; it used no model turn.

The full minimal suite after these fixes is **814 passed, 12 skipped**; typecheck/build/check and
`validate_library.py` pass. **Result against §VII.3.** Reachability improved from 3/3 workers blocked (19/19 operations failing) to 5/5 reporting
with 0 executor failures; the final snapshot moved from a draft at 436/449 to a final at 721/721; independent validation
moved from 0/2 to 2/2; cost moved from $0.3820 to $0.4977 (cap unchanged). The L1 target is **not met**: 36.0% tool
errors is worse than the 31.7% baseline. Coverage-plan creation produced zero errors, and no case was created already
accepted (both were created pending and accepted by an explicit revision), but the `<10%` gate stands unmet. The L2
target is **met** without a waiver.

**Not done.** No commit or benchmark edit was made. The remaining L1 work is contract/selection quality, not another
executor or report fix.

---

*End of plan. L0, L1 and L2 are implemented in the working tree; no L1/L2 paid run and no commit were made.*
