# Planner — target-driven plan proposal, owner batch approval, threat model, coverage gate

Implements workstream P1 from [strix-engine.md](strix-engine.md): the model proposes a target-driven plan
(tasks + owner-bound observations + skills + caps), the owner approves the whole batch in one digest-bound
document, and deterministic code admits it. Nothing in this path grants authority; the planner is a proposal
source, like every other model output.

Reference points in Strix (`/tmp/strix-arch`, commit recorded in [strix-engine.md](strix-engine.md)):
`strix/skills/coordination/root_agent.md` (root proposes, never touches the target),
`strix/tools/threat_model/tools.py` (run-scoped shared model, normalized target key, size caps, attributed
append-only addenda), `strix/tools/coverage/tools.py` + `strix/report/coverage.py` (open cells reconciled
before finishing), `strix/tools/todo/tools.py` (priority/status carried on proposed tasks).

## 1. Contracts (`src/contracts/`)

| Contract | File | Shape |
|---|---|---|
| `PlanProposal` | `plan.ts` | `proposalId` + run request (scope/targets/accounts/budgets/deadline), `tasks[{question,surfaceId,surface,actor,targetIds,skills,allowedActions,requiredCapabilities,dependencies,priority,depth}]`, `observations[{observationId,taskId,tool,input,expectation,kind,classification,summary,requests}]`, `coverage[{cellId,taskId,surfaceId,actorId,question,riskArea}]`, `caps{maxTasks,maxDepth,maxObservations,maxRequests}`, `provenance{plannerAttemptId,plannerKind,requestedSelection,inputDigests,producedAt,packetDigest}`, optional `threatModel` draft. |
| `ThreatModel` | `threat-model.ts` | `runId`, normalized `targetKey`, `body` + `bodyDigest`, `revision`, `createdByAttemptId`, `amendments[{amendmentId,authorAttemptId,at,digest,text}]`, `caps{maxBodyChars,maxAmendmentChars,maxAmendments}`. |
| `PlanApprovalDocument` | `plan.ts` | Owner-authored: `approvalId`, `proposalId`, `proposalDigest`, `runId`, `approvedBy`, `reference`, `approvedAt`, `expiresAt`, `taskCount`, `observationCount`. |
| `PlanCoverageResolution` / `CoverageReconciliation` | `plan.ts` | One resolution per planned cell (`resolved`/`needs_follow_up`/`not_applicable`/`untested`/`blocked`, explicit `carried`), reconciled into a per-cell view with `resolved`/`carried`/`unresolved` and a `canFinalize` gate. |

Runtime validators are `makeSchema` products, not just TypeScript types: `planProposalSchema`,
`threatModelSchema`, `planApprovalDocumentSchema`, `planCoverageResolutionSchema` plus the semantic
`validatePlanProposal(input, { caps, run })`. Rejection codes are stable and explicit:

```
plan-schema, plan-empty, plan-task-count, plan-depth, plan-observation-count, plan-request-budget,
plan-caps-wide, plan-run-budget, plan-run-deadline, plan-run-identity, plan-run-scope, plan-run-targets,
plan-run-capabilities, plan-run-actions, plan-duplicate-task, plan-dependency, plan-task-question,
plan-task-targets, plan-task-capabilities, plan-task-actions, plan-task-actor,
plan-duplicate-observation, plan-observation-task, plan-observation-tool, plan-observation-bound,
plan-observation-target, plan-observation-account, plan-duplicate-cell, plan-coverage-task,
plan-coverage-cell, plan-coverage-gap, plan-threat-model*, plan-packet-digest, plan-attempt-mismatch,
plan-proposal-conflict, plan-proposal-limit
```

Observation inputs are bound to a **concrete URL, account or path**: URLs must be absolute, wildcard-free,
credential/query/fragment-free and inside the proposal target set (and their task's target subset);
`accountId` values must be in the owner-approved account list. Workers can only select an
`observationId`; they never supply the input. Task capabilities/actions/actors must be subsets of the plan
request, which itself must be a subset of the admitted run authorization and budgets.

## 2. Planner path (`src/application/planner.ts`)

- `createPlanLedger({ controlRoot, authority, clock, caps })` stores proposals durably under the run control
  root (`plans/<proposalId>.json`) and computes the canonical digest with `planProposalDigest`. A proposal
  packet can come from a scripted fixture or a real worker (`plannerKind: 'scripted' | 'worker'`); the store
  injects/verifies `provenance.packetDigest` against the exact received packet and requires
  `provenance.plannerAttemptId` to equal the attempt that submitted it.
- Rejections are recorded (`plan-rejections/<packetDigest>.json`, bounded) so an over-cap attempt is
  auditable rather than silently dropped.
- `createPlanPort(...)` is the interface-facing adapter: it reads a bounded planner packet from disk
  (`propose`), the stored proposal + threat model + coverage from durable state (`read`), and an
  owner-authored approval document from disk (`approve`). Approval is always file-sourced; the tool never
  receives an inline approval.
- `materializePlan(proposal, { run, approval, now, workspaceFor })` is a **pure function**: it re-parses the
  proposal, checks the approval binding, derives one queued `TaskProposal` per plan task (budget divided from
  the run budget, deadline shortened by the reporting reserve) and one `ObservationCheck` per observation
  (controller-bound input, `claim` from the task question), plus the `CoveragePlanEntry[]` universe.

## 3. Owner batch approval

`createOwnerAuthority` now accepts `planApprovals: PlanApprovalDocument[]` in the owner grant (an absent or
empty list approves nothing). `authority.approvePlan(proposal, document, { runId, now })`:

1. looks up the owner grant's **own copy** of the document by its canonical digest;
2. requires `document.proposalDigest === digestJson(proposal)` and matching `proposalId`;
3. requires the document's run to be the current run and the window unexpired;
4. returns a frozen `PlanApproval` bound to the proposal, document and authorization reference.

The supervisor's `admitPlan(batch)` then re-validates the full proposal against the admitted run budget and
caps, re-checks the approval (digest, document digest, provenance, expiry covering the run deadline, tasks
matching the proposal question/scope/depth/capabilities/dependencies), validates the composition-supplied
tool policy and boundary receipt with the same `validateTools` rules as ordinary tasks, derives the private
workspace, and admits each task with `TaskRecord`-equivalent durable state and an
`orchestrator.task-admitted` event carrying `planProposalId`/`planProposalDigest`. A
`orchestrator.plan-admitted` record lists the admitted task ids and coverage cell ids.

Idempotence is structural: tasks are keyed by `taskId` in the durable store and compared by bounded identity,
so replay or a supervisor restart re-admits the same task set exactly once; the approval record under
`plan-approvals/<proposalId>.json` is idempotent on the document digest and conflicts if a different
document is presented. A mutated stored proposal fails the digest recomputation (`plan-digest-mismatch`)
before any admission.

## 3b. Generated request proposals (`src/contracts/plan-request.ts`, separate from the plan path)

The plan path above **selects** owner-prewritten observations; it never authors a new target request. The
generated-request path is the deliberate opposite and is kept separate: the model authors a concrete
`http.request` (method, URL, account, bounded headers/body) for a path or query the owner menu never
enumerated, and only an owner-approved exact digest can execute.

| Contract | Shape |
|---|---|
| `PlanRequestProposal` | `proposalId`, `runId`, `generator{generatorAttemptId,generatorKind,requestedSelection,producedAt,packetDigest}`, `requests[{requestId,taskId,tool:'http.request',method,url,action,accountId,headers?,body?,expectation,kind,classification,summary,purpose,requests}]`. |
| `PlanRequestEnvelope` | Controller-derived owner envelope: `targets`, `taskGrants{taskId,targetIds,allowedActions,allowedCapabilities}`, `accounts`, optional `accountGrants`, `allowedCapabilities`, `allowedActions`, policy `exclusions`. |
| `PlanRequestApprovalDocument` | Owner-authored: `approvalId`, `proposalId`, `proposalDigest`, `runId`, `approvedBy`, `reference`, `approvedAt`, `expiresAt`, `requestCount`. |

`validatePlanRequestProposal(proposal, { run, envelope, caps })` is the gate before storage. Constant codes:

```
request-plan-schema, request-plan-empty, request-plan-count, request-plan-duplicate-request,
request-plan-task, request-plan-tool, request-plan-capability, request-plan-action, request-plan-url,
request-plan-target, request-plan-account, request-plan-header, request-plan-body,
request-plan-expectation, request-plan-budget, request-plan-run-identity
```

What the validator enforces:

- **No scripts, no shell, no arbitrary tools.** `tool` is the literal `http.request`; the strict object rules
  reject unknown fields (`shell`, `command`, `script`, ...) at the schema.
- **New path/query is the point; scope still holds.** The URL is absolute `http(s)`, wildcard-free,
  credential/fragment-free; `planRequestBinding` resolves it to one owner target whose origin matches and
  whose locator path prefix contains the request path, inside the task's `targetIds`. Owner policy exclusions
  are refused before storage.
- **Action cannot be mislabelled.** `action` must be in the owner task/envelope/run grant and match the
  method class (`GET/HEAD/OPTIONS` = `read`; `POST/PUT/PATCH/DELETE` = `mutate`).
- **Account stays owner-bound.** The account must be in `accounts` (and in `accountGrants` when supplied) for
  that target and action.
- **Bounded body/headers.** Headers are limited to the broker's own caller-header allowlist, ≤8 entries and
  ≤8 KiB; bodies are mutate-only, ≤16 KiB, and may not carry credential/identity fields (JSON, form or
  multipart). No body on a read.
- **Costs are bounded.** Per-draft and summed `requests` are checked against the caps and the run budget,
  including `run.budgets.targetRequestLimits`.

`createRequestPlanLedger({ controlRoot, authority, clock, caps })` stores proposals under
`request-plans/<proposalId>.json`, records rejected packets under `request-rejections/<packetDigest>.json` and
approvals under `request-approvals/<proposalId>.json`, and seals the normalized proposal with
`planRequestProposalDigest` (canonical JSON SHA-256). `approve` re-derives the digest from the stored bytes,
checks the document binding (proposal id, digest, run, request count) and window, then delegates to the owner
gate. `materialize` is the only path that yields executable checks: it refuses an unapproved proposal with
`request-plan-unapproved` and never contacts a target.

The owner gate is `createRequestApprovalAuthority({ approvals })` (or `createOwnerAuthority`, which reads an
optional `requestApprovals` list structurally from the owner grant). It accepts only its **own copy** of the
exact document digest, requires proposal digest/identity/run/window to match, and evaluates the window against
its own clock. `assertOwnerGrant` accepts and validates the `requestApprovals` field; an absent or empty list
approves nothing, and there is no API that appends to the owner list. `approveRequestProposal` returns a frozen
`PlanRequestApproval`; the model has no approve tool and no way to mint one.

`materializeRequestPlan(proposal, { run, approval, document, envelope, taskFor, now })` is pure and
deterministic:

- it re-parses the proposal, requires the owner-gate approval output to hash-match the presented document,
  and re-checks the approval binding and window;
- it re-validates against the current envelope, so a target/account/capability narrowed or revoked after
  approval refuses execution with `request-plan-envelope-changed`;
- it derives deterministic identities `rchk-*`/`rob-*`/`reqg-*` from the **proposal digest** + request id, so a
  model-chosen `requestId` never becomes a controller identity and restart/replay reproduces the same ids;
- it emits one `ObservationCheck` (tool `http.request`, controller-built input, owner expectation) plus one
  `ApprovedRequestGrant` per request (digest, URL digest, target, method, action, account, cost, approval id).

Composition wiring (owned by the composition workstream, not by this path): the composition holds the ledger,
passes its owner `requestApprovals` into `createOwnerAuthority`, and merges materialized checks into the
per-task check lookup (plus the runtime menu) after approval. Until that wiring lands, `createApplication`
does not enable generated requests; the ledger/materializer are exercised end to end below.

### Generated-request evidence (raw)

```
$ node tests/planner/run.mjs
 ✓ tests/planner/request-plan-broker.test.ts (4 tests)
 ✓ tests/planner/request-plan.test.ts (11 tests)
 Test Files  5 passed (5)
      Tests  28 passed (28)
exit=0
```

```
$ node examples/live-lab/request-plan.mjs
=== generated request demo (local fixtures; no live model, no live target) ===
materialized check=rchk-ce77288d25c9e2b17408b7e5e7bf3ebb observation=rob-bf1155a8e8e5228d5db70c06cc74dd90 tool=http.request target=lab-web
lab target (loopback fixture, owner-approved origin): http://127.0.0.1:45591
owner menu enumerated only: /api/v1/items/i-100?tenant=alpha
scripted author: SCRIPTED-MODEL-AUTHOR (lab-only deterministic stand-in; not a live model)
  NEW request: GET http://127.0.0.1:45591/api/v1/items/i-200?tenant=beta account=anonymous (query and path were never in the menu)
  proposal=reqplan-demo digest=e805e22f697c752ca3702fdf3b82a051c464a2a2a59bc4bc6255f3c46629552a
scripted owner gate: SCRIPTED-LAB-OWNER (lab-only scripted approval; not an independent approver)
refusals (each with the fixture untouched):
  materialize before approval: REFUSED request-plan-unapproved
  approval signed by the author: REFUSED permission-denied
  materialize old approval over mutated URL: REFUSED request-plan-approval-binding
  propose mutated (unapproved) account: REFUSED request-plan-account
  propose off-scope origin: REFUSED request-plan-target
  propose owner-excluded path: REFUSED request-plan-target
broker execution: status=200 beta-secret=true pinned=127.0.0.1
restart/replay: proposals=1 approvals=1 duplicateApproval=true identicalIdentities=true
no live model call was made (0 calls, $0.00 spent); the scripted approval covers only this loopback fixture
ACCEPTANCE ok=true
exit=0
```

Honest limits of this path: no live model produced a proposal here (the author stand-in and the approving
principal are scripted lab fixtures, labeled as such in the demo output); the composition wiring above is
pending; the validator bounds what the model may *propose*, while execution authority remains the broker's
policy/DNS/budget gate at dispatch.

## 4. Run-scoped threat model

`createThreatModelStore({ controlRoot, runId, caps, maxAmendmentsPerAttempt, amendmentWindowMs,
minAmendmentChars })` keeps one document per `(runId, normalized targetKey)`:

- `read(targetKey)` returns a bounded projection (body cap, amendment cap, explicit truncation flags).
  Equivalent target spellings collapse through `normalizeTargetKey`; credentials/query/fragment are refused.
- `save({ targetKey, body, attemptId, replace })` writes the baseline; it refuses to overwrite an existing
  model unless `replace: true` (which mirrors Strix's fold-back and explicitly drops amendments).
- `amend({ targetKey, attemptId, text })` appends an attributed, digest-bound addendum. It refuses thin
  amendments (`threat-model-thin`), over-cap text (`threat-model-amendment-size`), a missing model
  (`threat-model-missing`), the amendment-count cap (`threat-model-amendments`) and per-attempt rate limits
  (`threat-model-rate-limit`). Amendments are append-only: no API removes one.
- A fresh run starts with **no** model: the storage key includes the run id, and an absent document reads as
  `found: false`.

Workers reach the model through the authenticated bridge. `BridgeOperation` gained
`threat-model.read` / `threat-model.amend`; `WorkerBridgeOperations.context?: WorkerContextPort` serves them
(the bridge still authorizes the attempt against its runtime handle + live lease first, and serializes amend
per attempt). `createWorkerContextPort({ ledger, runId })` is the concrete port: `read` returns every model
for the run (or one target key), `amend` strictly parses `{targetKey,text}` and attributes the attempt id.
Absent a context port the bridge fails closed with `context-unavailable`. The same documents and amendments
appear in `ledger.read(runId).threatModels`, which is the report context a report finalizer consumes.

## 5. Coverage reconciliation gate

`reconcileCoverage(cells, resolutions, { runId })` is the gate. Every planned cell appears in the result;
nothing is silently dropped. A cell with no resolution, or a `needs_follow_up`/`untested`/`blocked` cell
without an explicit `carried: true`, lands in `unresolved` and raises `coverage-unresolved-cell`, so
`canFinalize` is false. `resolved` and `not_applicable` close a cell; `carried` `untested`/`blocked` cells
stay in the report (with reasons in `limitations`) as reported-unresolved. Resolutions for unplanned cells
are refused (`coverage-unknown-cell`), a second conflicting resolution is refused (`coverage-conflict`), and
a `resolved` cell without evidence fails schema validation (`coverage-missing-evidence`).

## 6. Interface

`p2o_plan` is the 14th tool/command (schema in `src/interface/schemas.ts`, description and guidelines in
`extensions/p2o/index.ts`, dispatch in `src/interface/controller.ts`, optional `ControlBackend.plan` via
`createSupervisorBackend`). Actions:

| Action | Input | Behaviour |
|---|---|---|
| `propose` | `runId`, `proposalPath` | Stores and digests the packet; returns `ok`, `proposalDigest`, counts. Nothing is admitted. |
| `read` | `runId`, optional `proposalId` | Proposal summaries (or the exact proposal), approvals, bounded threat models, coverage reconciliation. |
| `approve` | `runId`, `proposalDigest`, `approvalPath` | Owner file must be a canonical regular file, current UID, not group/world-writable, <=256KiB; then materializes and admits once. |

Schema refinements reject `approve` without `proposalDigest` + `approvalPath`, `propose` without
`proposalPath`, and `read` carrying approval fields — the tool has no inline-approval form. When the
composition supplies no planner port the action fails closed with `INTEGRATION_REQUIRED`.

## Evidence (raw)

### Typecheck

```
$ npx tsc --noEmit -p tsconfig.json
(node:2598521) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
(Use `node --trace-deprecation ...` to show where the warning was created)
exit=0
```

### Planner acceptance suite (vitest, verbose)

```
$ npx vitest run tests/planner --reporter=verbose
 ✓ tests/planner/plan.test.ts > p2o_plan is the 14th tool and never accepts an approval without a digest and owner file 54ms
 ✓ tests/planner/plan.test.ts > over-cap, over-depth, over-observation and over-budget proposals are rejected with explicit codes 246ms
 ✓ tests/planner/plan.test.ts > an unapproved proposal admits no task 127ms
 ✓ tests/planner/plan.test.ts > an approved batch admits its tasks once and replays idempotently across restart 336ms
 ✓ tests/planner/plan.test.ts > a proposal mutated after approval is refused by the ledger, the authority and admission 136ms
 ✓ tests/planner/plan.test.ts > threat-model amendments are attributed, size-capped, rate-limited and visible to a second worker 164ms
 ✓ tests/planner/plan.test.ts > the coverage gate blocks a final report with an unresolved cell unless it is carried as untested 109ms
 ✓ tests/planner/plan.test.ts > needs_follow_up stays unresolved until it is explicitly carried as blocked 99ms
 ✓ tests/planner/plan.test.ts > the plan port stores a worker packet and admits it once from an owner approval file 285ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

### Existing suites

```
$ npx vitest run
 Test Files  5 passed (5)
      Tests  67 passed (67)

$ node tests/orchestrator/run.mjs
ℹ tests 59
ℹ pass 59
ℹ fail 0

$ node tests/interface/run.mjs
ℹ tests 51
ℹ pass 51
ℹ fail 0
JITI: PASS — 14 tools/commands registered through jiti, no work at load (p2o_start,p2o_resume,p2o_preflight,p2o_doctor,p2o_status,p2o_stop,p2o_tasks,p2o_evidence,p2o_report,p2o_events,p2o_switch_model,p2o_subtask,p2o_plan,p2o_dashboard)

$ node tests/credentials/run.mjs
ℹ tests 7
ℹ pass 7
ℹ fail 0

$ node tests/budget/run.mjs
ℹ tests 37
ℹ pass 37
ℹ fail 0

$ node tests/end-to-end/run.mjs
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

Transient note (honest): while the concurrent live-slice workstream was running a live lab on the same host,
one in-place attempt could not copy the tree (`ERR_FS_CP_SOCKET` on generated `examples/live-lab/.runs/*.sock`
files) and another reported `maxConcurrent 1` for the suite's fixture-overlap timing assertion. With the live
run idle the in-place suite passed 14/14 above, and the same source also passed 14/14 from a socket-free copy.

## Unproven / integration boundaries

- **Composition wiring — closed** (see the status section below). The default composition builds a
  composition-owned `PlanLedger` behind `ControlBackend.plan` when the owner document supplies a `planner`
  document; without one, `p2o_plan` still fails closed with `INTEGRATION_REQUIRED`. The bundled first-use path
  plans through the host author instead (see [docs/USAGE.md](../../docs/USAGE.md)). The port is exercised end to
  end in `tests/planner` against a real store, authority and supervisor.
- **Report finalizer.** `reconcileCoverage(...).canFinalize` is the gate the report path must call; wiring it
  into `src/reporting/**` (not owned by this workstream) is not done, so the gate is proven at the
  reconciliation API level, not inside a rendered report.
- **Bridge round-trip.** The new bridge operations are implemented and unit-exercised through
  `createWorkerContextPort`, but a live worker calling `threat-model.read`/`amend` through the socket was not
  run here (no real Pi worker was launched in this workstream's tests).
- **Planner runtime.** No real model provider produced a proposal packet here; the production path accepts
  and validates a real worker packet (`plannerKind: 'worker'`), but only fixture/scripted packets were used
  in tests.

## Results — P2 planner integration + live plan demo (workstream P2)

This section closes the three boundaries the P1 planner workstream left open. Everything below is raw output from
this checkout; no step is fixture-only.

What changed, and where:

| Gap | Resolution |
|---|---|
| `createPlanPort` was exported but the shipped composition never passed it to `createSupervisorBackend`, so `p2o_plan` failed closed with `INTEGRATION_REQUIRED`. | `src/application/composition.ts` now validates an owner `planner` document (`toolPolicy`, `boundaryReceipt`, `role`, `caps`, `threatModelCaps`, `planApprovals`) and builds one composition-owned `PlanLedger` + `PlanPort` behind the real `ControlBackend.plan`. Absent planner ⇒ still `INTEGRATION_REQUIRED`; invalid planner, approval file or approval binding ⇒ refused before any admission. |
| `reconcileCoverage(...).canFinalize` was never consulted by the report path. | `buildReport` now takes an optional `planCoverage: CoverageReconciliation`, calls `assertPlanCoverageFinalizable` and refuses to finalize (`coverage-unresolved-cell`) while a planned cell is open/`needs_follow_up` and not explicitly carried as untested/blocked. `createApplication`'s `artifacts()` feeds the gate from the same ledger the plan port writes. |
| No real worker ever invoked the threat-model bridge ops; planner packets were fixture/scripted only. | The default composition wires `createWorkerContextPort` into the bridge and appends an attempt-attributed durable diagnostic event (`worker.threat-model-read`, `worker.threat-model-amend`) for every served context op. The live demo's workers read the run threat model and both hypothesis workers appended attributed amendments. |
| No real model produced a proposal packet, and no report ever consumed a plan. | `examples/live-lab/plan.mjs` (+ `plan-main.ts`, `plan-extension.mjs`) runs a real planner worker that reads the owner menu and writes a proposal, stores it through the real `p2o_plan propose` dispatch, takes an owner-authored batch approval into the owner grant, materializes/admits the batch through `p2o_plan approve`, executes it with the live-lab composition, records the controller-derived coverage resolutions, and refuses/builds the report through the gate. |

Ownership note: this workstream touched `src/application/**`, `src/reporting/**`, `extensions/p2o` (untouched in the
end), `tests/planner/**`, `examples/live-lab/plan*.{ts,mjs}` and this document. `src/tools/**`, `src/runtime/**`,
`src/policy/**` and `examples/live-lab/{lab-server.mjs,scenario.ts,run.mjs,main.ts}` were not modified.

### 1–2. Composition wiring and the report coverage gate (regression)

`tests/planner/composition-plan.test.ts` drives the real composition: without a planner document
`interfaceBackend.plan` still fails closed with `INTEGRATION_REQUIRED`; unknown planner fields, a non-sandbox
planner tool policy and out-of-range caps are refused by `validateApplicationConfig`; with a planner document
`p2o_plan read` answers over the durable run, `planLedger` is exposed, a missing owner approval file is refused
(`plan-path`) and an unknown run is refused (`plan-run-unknown`).

`tests/planner/coverage-gate.test.ts` drives the real `buildReport`: an open cell, a `needs_follow_up` cell, and a
falsely `carried: true` `needs_follow_up` cell all refuse finalization with `coverage-unresolved-cell`; a
`carried` `untested` cell finalizes and its reason appears in the report limitations; resolved/not-applicable
cells close the gate.


### 3. Live planner demo — `node examples/live-lab/plan.mjs --require-live --keep`

One owner-approved run, two compositions over the same durable roots. **Phase 1** launches a real pinned `pi`
worker (`deepseek/deepseek-flash`, thinking `low`, controller-owned credential gateway, pinned container pack for
brokered capabilities) as the run's planner: it maps the surface to one H1 packet, reads the (empty) run threat
model through the bridge, reads the owner planning menu through the bridge, writes a threat-model baseline draft
and a plan proposal through `p2o_plan_propose`. The proposal is stored by the real `p2o_plan propose` dispatch with
its exact digest and validated/capped by the ledger. The owner then authors a batch approval document for that
digest and it is placed in the **phase 2** owner grant. Phase 2 calls `p2o_plan approve`, which re-binds the digest,
materializes the batch (narrowed to the owner-approved observations the plan selected), admits it under the
owner-approved plan tool policy, re-admits the owner verifier task, and executes. The plan workers read the shared
threat model and append attributed amendments; the verifier task independently replays the claims. Finally the
harness records controller-derived coverage resolutions from durable accepted evidence, demonstrates that the
report gate refuses finalization before those resolutions, and builds the qualified report.

`plan-extension.mjs` is a **superset** of the pinned live-lab bridge extension: the same worker surface plus
`p2o_threat_model` (bridge read/amend), `p2o_plan_context` (planner-only, enforced by the pinned tool policy) and
`p2o_plan_propose` (expands a model-authored selection against that menu and writes the packet 0600). It is
hash-pinned exactly like the live-lab extension and re-hashes itself against the policy at load.

Design decisions worth naming:

* **The plan narrows, it never widens.** Every planned observation must map to an owner-approved check for the
  same `(taskId, observationId)` with the same tool, and its declared binding must be covered by the
  owner-approved input (`plan-observation-unapproved` otherwise). The plan contract binds query-free target keys,
  so an HTTP observation binds the owner-approved origin + account and the owner-approved check input is what
  executes; source observations bind an owner-approved input path. A plan-admitted task's runtime menu is narrowed
  to exactly the observation ids the approved plan selected (`attempt.state` and `broker.execute` both enforce it).
* **Approval is owner-file-sourced, twice over.** The interface never accepts an inline approval; the approval
  document is read from an owner-only canonical file, and the owner authority only accepts its own copy of that
  exact document digest. The proposal digest is re-derived from the stored bytes on every approve.
* **The demo cannot seal its own run.** A plan-materialized batch only exists in phase 2, but the owner approval
  document contains the phase-1 proposal digest, so the composition restarts once. A small owner-approved
  *sentinel* task (dependency on the planner task, deadline seconds out) keeps the durable run active across the
  restart without ever launching; phase 2 cancels it before the run may complete, and it contributes no process
  to the report. The owner verifier task (which depends on the planned claims) is re-admitted in phase 2 and
  executes normally.
* **The planner derives plan-local depth.** The owner manifest's depth counts already-accepted work (the surface
  map); the plan's task graph is flattened by the planner tool unless a selected task depends on another selected
  task, and the owner verifier is declared as a plan root whose ordering constraint is its dependency list.

Raw output of the green run (run 6 of this workstream; `EXIT=0`):

```
=== live planner demo evidence ===
run live-plan-murtz6w4 state=completed terminal=true assessmentStatus=incomplete
ACCEPTANCE ok=true
plan proposal (real worker packet):
  proposal=plan-live-plan-murtz6w4-f92e8a86c5d56b13 digest=0e270a8c45dc9a0be66f54186a70592485dc6148fa03527e71a6fa11f8991b98 plannerKind=worker plannerAttempt=fb922876-769c-433f-ba4c-c5cad43cacc6
  purpose=Decide the two owner-approved authorization hypotheses for the loopback lab: whether the item read route authorizes on the client-supplied tenant parameter (task-hyp-idor) and whether the export route enforces the documented admin role and tenant boundary (task-hyp-export). Select the source, baseline, negative-control and reproduction observations that decide both claims for the approved acct-guest member in scope lab-live-a, so the batch can be reviewed and admitted before any task runs.
  tasks=[task-hyp-idor,task-hyp-export] observations=[hyp-idor-source,hyp-idor-baseline,hyp-idor-control,hyp-idor-reproduction,hyp-export-source,hyp-export-baseline,hyp-export-control,hyp-export-reproduction] cells=[cov-task-hyp-idor-0,cov-task-hyp-export-0] threats=1 path=/home/nhanlaptop/project/pi-p2o/examples/live-lab/.runs/lp-zSrLon/workspaces/task-surface-map/plan.proposal.json
  caps declared={"maxDepth":1,"maxObservations":10,"maxRequests":10,"maxTasks":3} counts={"tasks":2,"observations":8,"coverage":2,"requests":8,"maxDepth":0} withinCaps=true
owner batch approval:
  approval=approval-plan-live-plan-murtz6w4-f92e8a86c5d56b13 reference=owner-plan-approval-live-lab approvedBy=live-lab-owner expiresAt=2026-10-03T04:11:57.701Z duplicate=false
  admitted=[task-hyp-idor,task-hyp-export] observations=8 cells=[cov-task-hyp-idor-0,cov-task-hyp-export-0] document=/home/nhanlaptop/project/pi-p2o/examples/live-lab/.runs/lp-zSrLon/plan-approval.json
phase1 planner: task=task-surface-map attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 state=exited/accepted proposalWritten=true
coverage gate:
  before resolutions: REFUSED coverage-unresolved-cell — Report cannot finalize: 2 planned coverage cell(s) are open or needs_follow_up and are not explicitly carried as untested/blocked (cov-task-hyp-idor-0, cov-task-hyp-export-0); Coverage cell is open and is neither resolved nor explicitly carried into the report (coverage-unresolved-cell)
  reconciliation before: canFinalize=false cells=2 unresolved=[cov-task-hyp-idor-0,cov-task-hyp-export-0]
  resolution cell=cov-task-hyp-idor-0 outcome=resolved basis=runtime-observed carried=false evidence=4 author=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87
  resolution cell=cov-task-hyp-export-0 outcome=resolved basis=runtime-observed carried=false evidence=4 author=8761dd53-08e0-4594-87c7-f1b3a4326cfc
  reconciliation after: canFinalize=true resolved=[cov-task-hyp-idor-0,cov-task-hyp-export-0] carried=[] unresolved=[]
threat model (run-scoped, shared):
  model targetKey=http://127.0.0.1:38259/ revision=1 bodyChars=1203 amendments=2
    amendment amd-5c49a7a8bde03e471d68054facfebe0d author=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 durableAttempt=true at=2026-10-03T03:28:06.914Z digest=c4637e2d0e3cfb07… text="Baseline missed that the same-tenant read (i-100?tenant=alpha -> 200, hyp-idor-baseline) cannot distinguish parameter-vs-session authorization. Negative control i-200?tenant=alpha -> 403 tenant_mismatch (hyp-idor-control) proves comparison "
    amendment amd-be46ba5dba69a2e009e1b2843c828be9 author=8761dd53-08e0-4594-87c7-f1b3a4326cfc durableAttempt=true at=2026-10-03T03:28:09.593Z digest=e43a23895350cf5a… text="Baseline gap: the member own-tenant export (alpha i-100, 200/alpha-live-value) cannot by itself distinguish an enforced boundary from its absence, since a correctly guarded route would return the same own-tenant payload. The receipts that c"
bridge context events (2):
  seq=56 worker.threat-model-read task=task-surface-map attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 payload={"found":false,"models":0}
  seq=57 worker.plan-context-read task=task-surface-map attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 payload={"capsMaxTasks":3,"targets":3,"tasks":3}
```

The green run's printed `bridge context events (2)` section was truncated by the harness's event pagination (the
default `listEvents` page is 1000 rows and a live two-phase run emits more). The durable rows are below, read
straight from that run's SQLite store (`examples/live-lab/.runs/lp-zSrLon/state/p2o.sqlite`), and the pagination
was fixed afterwards (`plan-main.ts` pages the event log; the later run prints all six events — see the honest
failure run below). Real worker reads and both attributed amendments:

```
{"sequence":56,"type":"worker.threat-model-read","taskId":"task-surface-map","attemptId":"fb922876-769c-433f-ba4c-c5cad43cacc6","payload":{"found":false,"models":0},"occurredAt":"2026-10-03T03:27:01.383Z"}
{"sequence":57,"type":"worker.plan-context-read","taskId":"task-surface-map","attemptId":"fb922876-769c-433f-ba4c-c5cad43cacc6","payload":{"capsMaxTasks":3,"targets":3,"tasks":3},"occurredAt":"2026-10-03T03:27:01.390Z"}
{"sequence":1113,"type":"worker.threat-model-read","taskId":"task-hyp-export","attemptId":"8761dd53-08e0-4594-87c7-f1b3a4326cfc","payload":{"found":true,"models":1},"occurredAt":"2026-10-03T03:28:02.133Z"}
{"sequence":1204,"type":"worker.threat-model-read","taskId":"task-hyp-idor","attemptId":"0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87","payload":{"found":true,"models":1},"occurredAt":"2026-10-03T03:28:04.898Z"}
{"sequence":1268,"type":"worker.threat-model-amend","taskId":"task-hyp-idor","attemptId":"0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87","payload":{"amendmentId":"amd-5c49a7a8bde03e471d68054facfebe0d","ok":true,"targetKey":"http://127.0.0.1:38259/"},"occurredAt":"2026-10-03T03:28:06.915Z"}
{"sequence":1341,"type":"worker.threat-model-amend","taskId":"task-hyp-export","attemptId":"8761dd53-08e0-4594-87c7-f1b3a4326cfc","payload":{"amendmentId":"amd-be46ba5dba69a2e009e1b2843c828be9","ok":true,"targetKey":"http://127.0.0.1:38259/"},"occurredAt":"2026-10-03T03:28:09.594Z"}
```

The amendment artifact (control dir `examples/live-lab/.runs/lp-zSrLon/control/threat-models/tm-2770a8….json`,
abridged to the baseline body and the two append-only amendments; the full document also carries
`bodyDigest`/`revision`/`caps`):

```json
{
    "amendments": [
        {
            "amendmentId": "amd-5c49a7a8bde03e471d68054facfebe0d",
            "at": "2026-10-03T03:28:06.914Z",
            "authorAttemptId": "0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87",
            "digest": "c4637e2d0e3cfb072b479765d05f4fe322be41d4b55c5812aa9f9a365cb9ea0f",
            "text": "Baseline missed that the same-tenant read (i-100?tenant=alpha -> 200, hyp-idor-baseline) cannot distinguish parameter-vs-session authorization. Negative control i-200?tenant=alpha -> 403 tenant_mismatch (hyp-idor-control) proves comparison is against the item record, not the session, and reproduction i-200?tenant=beta -> 200 returns beta item with sessionTenant alpha (hyp-idor-reproduction) confirms the IDOR on api.read for acct-guest."
        },
        {
            "amendmentId": "amd-be46ba5dba69a2e009e1b2843c828be9",
            "at": "2026-10-03T03:28:09.593Z",
            "authorAttemptId": "8761dd53-08e0-4594-87c7-f1b3a4326cfc",
            "digest": "e43a23895350cf5afd6a0c3fe72542ef4cd29ba2d517ed653a13da81fc8fa176",
            "text": "Baseline gap: the member own-tenant export (alpha i-100, 200/alpha-live-value) cannot by itself distinguish an enforced boundary from its absence, since a correctly guarded route would return the same own-tenant payload. The receipts that close the gap: negative control hyp-export-control-8761dd53-08e0-4594-87c7-f1b3a4326cfc shows the guarded sibling /api/v1/export/secure returns 403 for cross-tenant i-200, and reproduction hyp-export-reproduction-8761dd53-08e0-4594-87c7-f1b3a4326cfc shows /api/v1/export returns 200 with tenant=beta value=beta-live-value to the alpha session (requestedBy acct-guest), confirming the missing admin-role and tenant checks."
        }
    ],
    "body": "In-scope assets for scope lab-live-a: the loopback live-lab HTTP service at http://127.0.0.1:38259 (target lab-live-a) and its source artifact lab-server.mjs (snapshot-1). The approved actor is acct-guest with read privilege only. Trust boundaries: the client/session identity boundary between the authenticated member session and request-supplied parameters such as the tenant parameter, and the object-ownership boundary between the alpha member tenant and the beta/other tenant records. Likely weaknesses under test: the item read route comparing the caller-supplied tenant parameter instead of the authenticated session tenant (IDOR), and the export route serializing any tenant item secret to an authenticated member with neither the documented admin-role check nor a tenant boundary check. The plan will not test: any external or non-loopback destination, any write or state-changing request, any credential or privilege escalation, any denial-of-service or load condition, tenants or accounts beyond acct-guest on lab-live-a, and it will not touch scope lab-live-b or the verifier replay tasks. Only read and analyze actions, broker-only loopback egress, and read-only HTTP requests are in scope.",
    "createdByAttemptId": "fb922876-769c-433f-ba4c-c5cad43cacc6",
    "revision": 1,
    "runId": "live-plan-murtz6w4",
    "schemaVersion": 1,
    "targetKey": "http://127.0.0.1:38259/"
}
```

The same amendment is visible to the plan interface (report context): `p2o_plan read` returns
`threatModels[0].amendments` for the run, which is what the report/planner context consumes; the run's
`plan-summary.json` and `report.json`/`report.md` are written into the kept run directory.

```
gateway id=f859b06c exchanges=26 forwarded=26 denied=0
spend limits maxTokens=400000 maxCostUsd=1 committed tokens=207007 cost=$0.086111 overshoot tokens=0 cost=$0.000000
  turn model-spend-0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87:turn-1 attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 selection=deepseek/deepseek-flash/low in=1527 out=32 tokens=1559 cost=$0.000498 basis=provider-usage
  turn model-spend-0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87:turn-2 attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 selection=deepseek/deepseek-flash/low in=2683 out=223 tokens=2906 cost=$0.001073 basis=provider-usage
  turn model-spend-0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87:turn-3 attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 selection=deepseek/deepseek-flash/low in=4495 out=75 tokens=4570 cost=$0.001439 basis=provider-usage
  turn model-spend-0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87:turn-4 attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 selection=deepseek/deepseek-flash/low in=4922 out=336 tokens=5258 cost=$0.001881 basis=provider-usage
  turn model-spend-0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87:turn-5 attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 selection=deepseek/deepseek-flash/low in=5334 out=53 tokens=5387 cost=$0.001665 basis=provider-usage
  turn model-spend-0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87:turn-6 attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 selection=deepseek/deepseek-flash/low in=7449 out=2786 tokens=10235 cost=$0.005579 basis=provider-usage
  turn model-spend-0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87:turn-7 attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 selection=deepseek/deepseek-flash/low in=10397 out=580 tokens=10977 cost=$0.003816 basis=provider-usage
  turn model-spend-8761dd53-08e0-4594-87c7-f1b3a4326cfc:turn-1 attempt=8761dd53-08e0-4594-87c7-f1b3a4326cfc selection=deepseek/deepseek-flash/low in=1499 out=43 tokens=1542 cost=$0.000502 basis=provider-usage
  turn model-spend-8761dd53-08e0-4594-87c7-f1b3a4326cfc:turn-2 attempt=8761dd53-08e0-4594-87c7-f1b3a4326cfc selection=deepseek/deepseek-flash/low in=2682 out=148 tokens=2830 cost=$0.000983 basis=provider-usage
  turn model-spend-8761dd53-08e0-4594-87c7-f1b3a4326cfc:turn-3 attempt=8761dd53-08e0-4594-87c7-f1b3a4326cfc selection=deepseek/deepseek-flash/low in=3743 out=290 tokens=4033 cost=$0.001471 basis=provider-usage
  turn model-spend-8761dd53-08e0-4594-87c7-f1b3a4326cfc:turn-4 attempt=8761dd53-08e0-4594-87c7-f1b3a4326cfc selection=deepseek/deepseek-flash/low in=5181 out=731 tokens=5912 cost=$0.002433 basis=provider-usage
  turn model-spend-8761dd53-08e0-4594-87c7-f1b3a4326cfc:turn-5 attempt=8761dd53-08e0-4594-87c7-f1b3a4326cfc selection=deepseek/deepseek-flash/low in=8020 out=3276 tokens=11296 cost=$0.006338 basis=provider-usage
  turn model-spend-8761dd53-08e0-4594-87c7-f1b3a4326cfc:turn-6 attempt=8761dd53-08e0-4594-87c7-f1b3a4326cfc selection=deepseek/deepseek-flash/low in=11446 out=675 tokens=12121 cost=$0.004244 basis=provider-usage
  turn model-spend-fb922876-769c-433f-ba4c-c5cad43cacc6:turn-1 attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 selection=deepseek/deepseek-flash/low in=1854 out=84 tokens=1938 cost=$0.000658 basis=provider-usage
  turn model-spend-fb922876-769c-433f-ba4c-c5cad43cacc6:turn-2 attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 selection=deepseek/deepseek-flash/low in=5073 out=826 tokens=5899 cost=$0.002514 basis=provider-usage
  turn model-spend-fb922876-769c-433f-ba4c-c5cad43cacc6:turn-3 attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 selection=deepseek/deepseek-flash/low in=6073 out=140 tokens=6213 cost=$0.001990 basis=provider-usage
  turn model-spend-fb922876-769c-433f-ba4c-c5cad43cacc6:turn-4 attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 selection=deepseek/deepseek-flash/low in=7440 out=116 tokens=7556 cost=$0.002372 basis=provider-usage
  turn model-spend-fb922876-769c-433f-ba4c-c5cad43cacc6:turn-5 attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 selection=deepseek/deepseek-flash/low in=9133 out=243 tokens=9376 cost=$0.003032 basis=provider-usage
  turn model-spend-fb922876-769c-433f-ba4c-c5cad43cacc6:turn-6 attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 selection=deepseek/deepseek-flash/low in=11686 out=8192 tokens=19878 cost=$0.013337 basis=provider-usage
  turn model-spend-fb922876-769c-433f-ba4c-c5cad43cacc6:turn-7 attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 selection=deepseek/deepseek-flash/low in=19938 out=2961 tokens=22899 cost=$0.009536 basis=provider-usage
  turn model-spend-fb922876-769c-433f-ba4c-c5cad43cacc6:turn-8 attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 selection=deepseek/deepseek-flash/low in=23054 out=582 tokens=23636 cost=$0.007616 basis=provider-usage
  turn model-spend-ff6dc2f7-db35-40db-bfdc-c6073716cd34:turn-1 attempt=ff6dc2f7-db35-40db-bfdc-c6073716cd34 selection=deepseek/deepseek-flash/low in=1542 out=65 tokens=1607 cost=$0.000541 basis=provider-usage
  turn model-spend-ff6dc2f7-db35-40db-bfdc-c6073716cd34:turn-2 attempt=ff6dc2f7-db35-40db-bfdc-c6073716cd34 selection=deepseek/deepseek-flash/low in=2472 out=162 tokens=2634 cost=$0.000937 basis=provider-usage
  turn model-spend-ff6dc2f7-db35-40db-bfdc-c6073716cd34:turn-3 attempt=ff6dc2f7-db35-40db-bfdc-c6073716cd34 selection=deepseek/deepseek-flash/low in=5708 out=606 tokens=6314 cost=$0.002441 basis=provider-usage
  turn model-spend-ff6dc2f7-db35-40db-bfdc-c6073716cd34:turn-4 attempt=ff6dc2f7-db35-40db-bfdc-c6073716cd34 selection=deepseek/deepseek-flash/low in=6918 out=2990 tokens=9908 cost=$0.005664 basis=provider-usage
  turn model-spend-ff6dc2f7-db35-40db-bfdc-c6073716cd34:turn-5 attempt=ff6dc2f7-db35-40db-bfdc-c6073716cd34 selection=deepseek/deepseek-flash/low in=10087 out=436 tokens=10523 cost=$0.003551 basis=provider-usage
  worker attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 task=task-hyp-idor tools=[p2o_context,p2o_broker,p2o_authoring,p2o_packet,p2o_threat_model] turns=7 in=36807 out=4085
  worker attempt=8761dd53-08e0-4594-87c7-f1b3a4326cfc task=task-hyp-export tools=[p2o_context,p2o_broker,p2o_authoring,p2o_packet,p2o_threat_model] turns=6 in=32571 out=5163
  worker attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 task=task-surface-map tools=[p2o_context,p2o_broker,p2o_authoring,p2o_packet,p2o_threat_model,p2o_plan_context,p2o_plan_propose] turns=8 in=84251 out=13144
  worker attempt=ff6dc2f7-db35-40db-bfdc-c6073716cd34 task=task-verify-replay tools=[p2o_context,p2o_broker,p2o_authoring,p2o_verify,p2o_packet] turns=5 in=26727 out=4259
result decisions (4):
  task=task-surface-map attempt=fb922876-769c-433f-ba4c-c5cad43cacc6 status=accepted contract=H1 outcome=supported packet=packet-task-surface-map-c5cad43cacc6
  task=task-hyp-idor attempt=0b7d49ae-a2f1-43ed-ad6a-bc7b0c7f5e87 status=accepted contract=H2 outcome=supported packet=packet-task-hyp-idor-bc7b0c7f5e87
  task=task-hyp-export attempt=8761dd53-08e0-4594-87c7-f1b3a4326cfc status=accepted contract=H2 outcome=supported packet=packet-task-hyp-export-f1b3a4326cfc
  task=task-verify-replay attempt=ff6dc2f7-db35-40db-bfdc-c6073716cd34 status=accepted contract=H2 outcome=unresolved packet=packet-task-verify-replay-c6073716cd34
  verifier.outcome accepted evidence=5 issues=none
  verifier.outcome returned-for-evidence evidence=0 issues=replay-blocked:fetch failed
packets: task-hyp-export/H2/supported/independently-observed, task-hyp-idor/H2/supported/independently-observed, task-surface-map/H1/supported/independently-observed, task-verify-replay/H2/unresolved/unresolved
findings: finding-export-missing-authorization=unresolved/unresolved evidence=4 verifier=none, finding-idor-client-tenant-parameter=independently-validated/independently-observed evidence=4 verifier=p2o-supervisor.verifier.ff6dc2f7-db35-40db-bfdc-c6073716cd34
coverage (report): tested=2, ruled-out=0, blocked=0, untested=1, not-applicable=0
scope: approved=[http://127.0.0.1:38259,http://127.0.0.1:37595] observed=[http://127.0.0.1:37595,http://127.0.0.1:38259] escapes=0
leak-audit: provider-credential ABSENT (155 files scanned, absent); lab-session-tokens ABSENT (155 files scanned, absent)
report: /home/nhanlaptop/project/pi-p2o/examples/live-lab/.runs/lp-zSrLon/report.json | /home/nhanlaptop/project/pi-p2o/examples/live-lab/.runs/lp-zSrLon/report.md | /home/nhanlaptop/project/pi-p2o/examples/live-lab/.runs/lp-zSrLon/plan-summary.json
run directory: /home/nhanlaptop/project/pi-p2o/examples/live-lab/.runs/lp-zSrLon
EXIT=0
```
### 3b. A live run that did not meet the bar (honest failure, no fakes)

A later independent run (`node examples/live-lab/plan.mjs --require-live --keep`, `EXIT=2`) had one plan worker
fail to produce an accepted packet. The demo did not fabricate anything: the plan gate refused the report, the
affected cell was carried as untested with a reason, and the acceptance line reports the reasons. Its full
pagination shows all six bridge events:

```
run live-plan-muru5mfb state=cancelled terminal=true assessmentStatus=incomplete
ACCEPTANCE ok=false reasons=only 1/2 admitted plan tasks produced an accepted packet | no finding reached independently-validated
coverage gate:
  before resolutions: REFUSED coverage-unresolved-cell — Report cannot finalize: 2 planned coverage cell(s) are open or needs_follow_up and are not explicitly carried as untested/blocked (cov-task-hyp-idor-0, cov-task-hyp-export-0); Coverage cell is open and is neither resolved nor explicitly carried into the report (coverage-unresolved-cell)
  reconciliation before: canFinalize=false cells=2 unresolved=[cov-task-hyp-idor-0,cov-task-hyp-export-0]
  resolution cell=cov-task-hyp-idor-0 outcome=resolved basis=runtime-observed carried=false evidence=4 author=ce9854c7-5ff4-4dc5-b9a5-22fc1a823c43
  resolution cell=cov-task-hyp-export-0 outcome=untested basis=reviewer-validated carried=true evidence=0 author=p2o-plan-finalizer
  reconciliation after: canFinalize=true resolved=[cov-task-hyp-idor-0] carried=[cov-task-hyp-export-0] unresolved=[]
findings: none
coverage (report): tested=1, ruled-out=0, blocked=0, untested=2, not-applicable=0
run directory: /home/nhanlaptop/project/pi-p2o/examples/live-lab/.runs/lp-c214LC
```

```
bridge context events (6):
  seq=45 worker.threat-model-read task=task-surface-map attempt=78152ee3-18eb-47f0-8f27-85d09b5a3f66 payload={"found":false,"models":0}
  seq=46 worker.plan-context-read task=task-surface-map attempt=78152ee3-18eb-47f0-8f27-85d09b5a3f66 payload={"capsMaxTasks":3,"targets":3,"tasks":3}
  seq=843 worker.threat-model-read task=task-hyp-export attempt=8744f2df-d546-41df-b88b-ea68762163ef payload={"found":true,"models":1}
  seq=850 worker.threat-model-read task=task-hyp-idor attempt=ce9854c7-5ff4-4dc5-b9a5-22fc1a823c43 payload={"found":true,"models":1}
  seq=1033 worker.threat-model-amend task=task-hyp-export attempt=8744f2df-d546-41df-b88b-ea68762163ef payload={"amendmentId":"amd-4d1967b6055425b6ea946752712a475d","ok":true,"targetKey":"http://127.0.0.1:34305/"}
  seq=1052 worker.threat-model-amend task=task-hyp-idor attempt=ce9854c7-5ff4-4dc5-b9a5-22fc1a823c43 payload={"amendmentId":"amd-5359f376e2177a894dfa168514c19b4a","ok":true,"targetKey":"http://127.0.0.1:34305/"}
```

Observed live-lab replay limit (not faked, not worked around): in both plan runs the **second** independent
replay (the export finding) failed inside the live-lab replay environment with `replay-blocked:fetch failed`
(the controller-side health fetch of the freshly re-bound environment-B instance), while the **first** replay
qualified and was accepted. The affected finding stays `unresolved` in the report instead of being promoted; the
live-lab slice's replay environment is owned by that workstream and was not modified here.

### 4. Suite evidence

```
$ npx tsc --noEmit -p tsconfig.json
(no output; exit 0)
```

### 5. Root vitest and the acceptance runners

```
$ npx vitest run
 FAIL  tests/runtime/sessions.test.ts [ tests/runtime/sessions.test.ts ]
 Test Files  1 failed | 7 passed (8)
      Tests  71 passed (71)
   Duration  11.07s (transform 3.18s, setup 0ms, collect 6.27s, tests 10.46s, environment 4ms, prepare 1.28s)
```

All 71 collected tests pass. The single failing *suite* is `tests/runtime/sessions.test.ts`: a `node:test` file
added by the runtime workstream today (mtime 09:32, 35KB) that vitest collects because its include pattern names
`tests/runtime/**/*.test.ts` while the exclude list only names `tests/runtime/runtime.test.ts`. It contains no
`vitest` suite, so vitest reports `No test suite found`; it is not owned or modified by this workstream (the
planner suites were green before it landed and remain green).

```
$ node tests/planner/run.mjs
 ✓ tests/planner/coverage-gate.test.ts (3 tests) 1592ms
 ✓ tests/planner/plan.test.ts (9 tests) 984ms
 ✓ tests/planner/composition-plan.test.ts (1 test) 199ms
 Test Files  3 passed (3)
      Tests  13 passed (13)
   Duration  4.92s (transform 2.12s, setup 0ms, collect 3.84s, tests 2.78s, environment 1ms, prepare 326ms)
```

```
$ node tests/live/run.mjs
ℹ tests 9
ℹ pass 9
ℹ fail 0
ℹ skipped 0
```

```
$ node tests/end-to-end/run.mjs
ℹ tests 14
ℹ pass 14
ℹ fail 0
ℹ skipped 0
```

```
$ node tests/orchestrator/run.mjs
ℹ tests 59
ℹ pass 59
ℹ fail 0
ℹ skipped 0
```

```
$ node tests/interface/run.mjs
ℹ tests 51
ℹ pass 51
ℹ fail 0
ℹ skipped 0
JITI: PASS — 14 tools/commands registered through jiti, no work at load (p2o_start,p2o_resume,p2o_preflight,p2o_doctor,p2o_status,p2o_stop,p2o_tasks,p2o_evidence,p2o_report,p2o_events,p2o_switch_model,p2o_subtask,p2o_plan,p2o_dashboard)
```

### 6. Status of the previous "Unproven / integration boundaries" list

* **Composition wiring — closed.** `createPlanPort` now runs inside the default composition when the owner
  document supplies a `planner` document; `p2o_plan propose/read/approve` are served by the real interface
  backend and the live demo exercised all three actions. Without a planner the action still fails closed with
  `INTEGRATION_REQUIRED`, and the planner document, its tool policy and every approval document are validated
  before any admission.
* **Report finalizer — closed.** `buildReport` consults the plan reconciliation and refuses to finalize an open
  cell; `tests/planner/coverage-gate.test.ts` is the regression and the live demo shows the refusal on a real run
  (`REFUSED coverage-unresolved-cell`) before the controller-derived resolutions close the gate.
* **Bridge round-trip — closed with a real worker.** A real pinned `pi` worker read the run threat model through
  the bridge (`worker.threat-model-read`, `found:false` for the planner before the baseline existed, `found:true`
  for the plan workers) and two plan-materialized workers appended attributed amendments
  (`worker.threat-model-amend`). Every served context op also appends an attempt-attributed durable diagnostic
  event, so the read/amend is independently visible in the run event stream.
* **Planner runtime — closed.** A real provider/model (`deepseek/deepseek-flash`, thinking `low`) produced a
  worker packet (`plannerKind: 'worker'`) that the ledger validated, capped and stored with its exact digest; the
  owner approved that digest and the batch was materialized and executed to a qualified report.

Honest remaining limits of this slice:

* **One plan binds one scope.** `PlanProposal.run` carries a single `Scope`, so a plan cannot mix the
  environment-A claims and the environment-B verifier task. The live demo plans the two A-side hypothesis tasks
  and the owner admits the B-side verifier task separately (its dependencies are the planned claims). A future
  plan revision that carries per-task scopes would remove this restriction.
* **The plan's declared observation input is a query-free binding.** The plan contract refuses URLs with
  credentials, query or fragment, so the plan binds the owner-approved origin + account (or an approved input
  path) while the owner-approved check input is what executes. The composition verifies that mapping
  (`plan-observation-unapproved`) and narrows each plan-admitted task's runtime menu to the plan's selected
  observation ids, so a plan can only narrow the owner document; it can never introduce a request the owner
  document did not approve.
* **Two-phase execution is a harness/operator pattern, not a supervisor feature.** The owner approval document
  contains the proposal digest, so it cannot exist in the composition that produced the proposal. The demo
  restarts the composition over the same durable roots with the approval in the owner grant; the supervisor
  reactivation itself is the same owner-approved admission digest (no scope, budget or identity changes). A
  small owner-approved sentinel task (never launched, cancelled before completion) keeps the run active in
  between. Operators should adopt the same explicit two-phase review step rather than expecting an in-process
  approve.
* **The second live-lab replay is currently flaky** (`replay-blocked:fetch failed` on the fresh environment-B
  instance's controller-side health fetch in two plan runs). The demo does not retry or hide it: the affected
  finding stays `unresolved`, and the acceptance bar requires at least one independently-validated finding, which
  the first replay produced. The live-lab replay environment is owned by that workstream.
* **Cost.** The green plan run settled at 207,007 tokens / `$0.086111` against the owner-declared
  `maxTokens: 400000` / `maxCostUsd: 1.00` (worst-case reservations, provider-usage settlement, zero overshoot).

Files added by this workstream: `examples/live-lab/plan.mjs`, `examples/live-lab/plan-main.ts`,
`examples/live-lab/plan-extension.mjs`, `tests/planner/run.mjs`, `tests/planner/coverage-gate.test.ts`,
`tests/planner/composition-plan.test.ts`. Files edited: `src/application/composition.ts`,
`src/application/planner.ts`, `src/application/types.ts`, `src/application/bridge.ts`, `src/application/report.ts`,
`src/reporting/coverage.ts`, `src/reporting/report.ts`, this document.
