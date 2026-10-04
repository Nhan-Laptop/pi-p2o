# Executable contracts and durable store

Integration contract for the active upgrade. These modules are TypeScript ESM, Node-only, have no Pi dependency, and never execute target traffic. Imports use `.js` specifiers so emitted ESM works without a loader. The integrator owns the root ESM/package/test configuration; this work does not modify it.

## Stable entry points

- `src/contracts/index.ts`: versioned types, strict runtime schemas, lifecycle/packet/finding transitions, scope/runtime checks, H1–H6 acceptance, canonical JSON/digests.
- `src/store/index.ts`: `DurableStore`, `openStore`, store errors, reconciliation/outbox/result types, migration version and conservative export redaction.
- Schemas: `runSchema`, `taskSchema`, `attemptSchema`, `evidenceSchema`, `handoffSchema`, `coverageSchema`, `findingSchema`. Each exposes `jsonSchema`, `parse(unknown)`, `safeParse(unknown)` and `validate(unknown)`. Invalid input is never coerced. JSON objects are closed except explicitly declared JSON metadata.
- Ancillary schemas: `authorizationSchema`, `scopeSchema`, `requestedRuntimeSchema`, `observedRuntimeSchema`, `budgetUsageSchema`, `gateDecisionSchema`. Evidence reference, coverage and finding proof checks are exported separately as `validateEvidenceReferences`, `validateCoverageEvidence` and `validateFindingEvidence`.
- Gates: `evaluateHandoff(packet, { authorization, evidence, reviewerId, now, task?, attempt? })` returns an immutable-content acceptance digest or `returned-for-evidence` with codes and bounded unanswered questions. Evidence is supplied from the trusted receipt store, not from packet prose. Runtime binding: with only `task`, `packet.requestedRuntime` must equal `task.requestedRuntime`; when `attempt` is supplied the packet binds to `attempt.requestedRuntime` instead — the task value remains the initial audit request, so a managed-handoff replacement attempt may legitimately differ — and exactly one `runtime-request` issue is produced per evaluation.
- `validateTaskScope(task, run, now)` checks authorization reference, expiry, target/action/capability subsets, artifact identities, and budget containment. This is admission validation, **not** a network sandbox.
- `compareRuntime(requested, observed)` preserves requested versus observed provider/model/thinking and capability discrepancies. Reported runtime is not attestation.

## Data model

Identifiers and SHA-256 digests are explicit; timestamps are UTC ISO-8601. Runs carry an authorization reference, authorizer, validity window, exact target identities, exclusions, actions, global/per-target budgets, runtime request, and granted capability names. A target list is not itself proof of permission: callers must supply an owner-approved authorization reference.

Tasks carry actor/privileges, bounded question/predictions, input revisions/digests, isolation/recovery/configuration identity, allowed actions, skills, capability requests, deadline/budgets, dependencies and a private absolute workspace. Attempts have separate IDs, lease fencing tokens, sequence numbers, lifecycle observations, optional runtime receipts/checkpoints/exit information, and usage. An attempt records the task's requested runtime, or a validated selection-only override supplied at launch: a replacement attempt may change provider/model/thinking but must keep the task adapter and required capability set.

Evidence receipts are immutable references to externally preserved artifacts. They record digest, byte length, collection identity/method/time, tool version/options, environment/configuration/input identities, original versus modified environment, classification, and collector-versus-worker provenance. The store does not inspect artifact bytes or make worker-authored receipts trustworthy. Evidence/tool modules must authenticate collectors and verify actual bytes before `putEvidence`.

Lifecycle (`queued`, `starting`, `running`, `waiting`, `reconciling`, `exited`, `failed`, `timed-out`, `cancelled`), packet (`draft`, `ready`, `schema-valid`, `accepted`, `returned-for-evidence`), and finding (`candidate`, `supported-static`, `reproduced`, `independently-validated`, `rejected`, `unresolved`) states are independent. Process exit never accepts a packet; packet acceptance never independently validates a finding.

## Handoff outcomes

H1–H6 are discriminated contracts, not a mandatory pipeline. All require authorized identity-matched scope, evidence references, honest classification/limits, runtime selection and a bounded next action.

- `supported`: the contract's observed-evidence gate must pass. H2 requires distinguishable observables, known prerequisites and a successful known-good baseline in the declared safe lab. H6 requires source/build/deployment/active-enforcement receipts plus accepted/forbidden controls under original policy; hashes must agree.
- `static-only`: source-backed, explicitly limited inference; it is not dynamic reproduction, operational closure, or demonstrated impact. Missing dynamic/deployment checks must remain in untested scope. H6 closure must be `unverified`.
- `unresolved`: an evidence-backed gap with an explicit reason, untested scope and a bounded next question; it is accepted only as unresolved, not as successful verification. H6 closure must be `unverified`.

Malformed packets, missing/foreign evidence, expired authorization, hidden modifications, identical H2 observables, and unsupported H6 closure are returned with specific questions. Acceptance is a deterministic check of supplied receipts, **not** an independent reproducer.

## DurableStore API

`openStore({ path, clock?, busyTimeoutMs? })` opens SQLite and applies ordered transactional migrations. `node:sqlite` is available on the checked Node `v24.19.0`; deploy on Node >=22.13 (or an older 22 release with its experimental SQLite flag). No third-party SQLite driver is required. File databases use foreign keys, WAL, FULL synchronous commits and a bounded busy timeout.

Primary operations:

- `createRun`, `getRun`, `listRuns`, `setRunState`.
- `createTask`, `getTask`, `listTasks`.
- `beginAttempt({ taskId, ownerId, attemptId?, leaseMs, requestedRuntime? })`, `getAttempt`, `listAttempts`, `updateAttempt`, `heartbeat`, `getLease`, `releaseLease`. The optional `requestedRuntime` is a selection-only replacement override: it is schema-validated and must keep the task's adapter and required capability set (compared as an order-insensitive set); provider/model/thinking may differ, and the resulting value is what the attempt persists and what result admission binds packets to. Without the override the attempt keeps `task.requestedRuntime` exactly as before.
- `consumeBudget`: atomic cumulative attempt/task/run/per-target accounting across retries.
- `putEvidence`/`getEvidence`/`listEvidence`; `putCoverage`/`listCoverage`; `putFinding`/`getFinding`/`listFindings`.
- `admitResult({ packet, idempotencyKey, leaseToken, reviewerId })`, `getResult`, `listResults`.
- `appendEvent`, `listEvents`, `claimOutbox`, `ackOutbox`, `retryOutbox`, `listOutbox`.
- `reconcileRun(runId, observations, { leaseMs? })`, `transaction(callback)`, `exportJsonl({ runId?, afterSequence? })`, `schemaVersion`, `close`.

Writes and their event/outbox entries commit together. Nested synchronous transactions use savepoints; async callbacks are rejected. Results bind idempotency keys to packet digests; exact replays survive release/restart, different content under the same key is rejected. A returned packet can be corrected using a new packet ID/key; at most one accepted result is allowed per attempt. Dependencies consume accepted packets, not process exit.

Workspace leases are exclusive and fenced. Starting an attempt atomically claims its canonical workspace and current-task ownership. Expiry **does not** grant permission to launch a replacement: an expired or unknown worker retains the workspace until trusted reconciliation proves termination/non-launch. An accepted result also retains its lease until process termination is confirmed. Existing workspace ancestors are realpath-resolved to prevent symlink aliases.

Restart reconciliation performs no launching/killing. Missing/unknown observations become `reconciling` and keep leases. Runtime observations must be backed by collector receipts. A matching live process may renew its existing fenced lease; a confirmed terminal/non-started attempt releases it and can expose a retryable task if authorization/deadline/attempt budgets still allow it. The runtime/supervisor owns process identity verification and termination.

Outbox claiming is transactional with expiry and fencing tokens. Delivery is at-least-once; consumers deduplicate by event ID. JSONL exports keep identifiers, states, digests and numeric receipt fields, redact sensitive fields, and omit unknown/free-text payload fields by default. Raw database/receipt artifacts are not redacted or encrypted; protect their access separately.

## Integration requirements and boundaries

1. Root package: ESM (`type: module`), TypeScript, Node types supporting `node:sqlite`, Vitest; no runtime dependency is added by these modules.
2. Policy owner validates actual human authorization and enforces destinations, redirects/DNS, capabilities and sandbox boundaries at execution time.
3. Runtime owner supplies requested/observed selection and honest capability receipts; stop/resume semantics cannot be inferred from plan-only delegation.
4. Evidence owner preserves bytes outside worker write authority, verifies hashes, authenticates collectors, and supplies independent reproduction receipts.
5. Orchestrator handles scheduling/process termination and calls budget admission **before** each action; store accounting alone cannot intercept traffic.
6. Reporter uses accepted output and explicit coverage/finding classifications, including unresolved/blocked/untested gaps.

## Verification

Verified on Node `v24.19.0`, Vitest `3.2.7`: **54 tests across three files passed** after the managed-handoff runtime override change (47 before it). Strict TypeScript checking of sources, fixtures, tests and test config also passed (`strict`, `noUnusedLocals`, `noUnusedParameters`). An emitted-ESM smoke test, with no TypeScript/Pi loader, passed run/task creation → lease → source receipt → static acceptance → observed exit → release → run completion → reopen → idempotent replay → redacted JSONL.

Tests include invalid scope/capabilities/budgets/URLs; non-JSON/accessor/oversized input; H1–H6 acceptance/return rules; insufficient H2 baseline and H6 deployed/active evidence; controls tied to deployed hashes; independent replay/negative controls; duplicate, expired, symlink-aliased and parent/descendant leases; stale results and conflicting idempotency keys; nested rollback and injected outbox failure; migration/reopen/corruption checks; unknown/PID-reused worker reconciliation; cross-handle budget/outbox fencing; multi-page export; committed and uncommitted WAL recovery after local test-process SIGKILL; and selection-only runtime overrides (replacement selection admitted with a matching packet, adapter/capability rejection leaving no attempt/lease/fence row, order-insensitive capability comparison, persisted override with the task audit request unchanged, and no fencing-token leak in redacted export).

Commands used (external tooling avoids modifying the root package):

```sh
TOOLS=/home/nhanlaptop/project/pi-ctf-solver/node_modules
P2O_VITEST_ENTRY="$TOOLS/vitest/dist/index.js" \
  "$TOOLS/.bin/vitest" run --config tests/store/vitest.config.ts
"$TOOLS/.bin/tsc" --noEmit --target ES2022 --module ES2022 \
  --moduleResolution bundler --strict --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node,chai --typeRoots "$TOOLS/@types" --baseUrl "$TOOLS" \
  src/contracts/*.ts src/store/*.ts tests/contracts/*.ts tests/store/*.ts
```

Compilation for the smoke test used `--rootDir . --outDir tests/store/.esm-smoke` for sources and `tests/contracts/fixtures.ts`; Node imported the emitted `.js` files with `--input-type=module`. The generated build/cache and temporary fixture databases were removed. No target traffic, scans, Pi worker launches, downloads, or package changes were performed.

Harness selection was checked in environment and active session metadata: `openai-codex-account-3 / gpt-6.1-sol / max`. This is the implementing session's verified selection, not an attestation for any future assessment worker. The managed-handoff follow-up change itself ran in a session reporting `deepseek / deepseek-flash`; the requested handoff selection above was not the active selection for that change, and it too is a runtime check rather than a packet attestation.

## Operational details and residual boundaries

- `clock` is a synchronous `() => string` returning a real UTC timestamp; lease expiry is exclusive. The database parent directory must already exist. IDs are globally unique per database; idempotency keys are run-scoped.
- `beginAttempt.ownerId` is the producing execution identity; packet `producer.id` must match it. `getLease` accepts a **task ID**. Renew/updates/admission require the current token. Unknown execution cannot clear reconciliation through `updateAttempt`. Expired termination is recorded with receipt-backed `reconcileRun`, not an automatic lease takeover.
- `beginAttempt.requestedRuntime` is validated before any attempt, lease or fence row is written: a different adapter or a different required-capability set throws `runtime-override-adapter` / `runtime-override-capabilities` (schema-invalid runtime input throws the contracts `ValidationError`), and the rejected call leaves existing attempts/leases/fence generations untouched. Selection fields are allowlisted machine strings and survive JSONL redaction; the lease/fence token remains redacted.
- Optional `markPacketReady({ attemptId, leaseToken })` publishes readiness, never acceptance. Admission transactionally records `packet.schema-valid` followed by the gate outcome. `cancelQueuedTask(taskId)` explicitly cancels unstarted work; `getTargetUsage(runId, targetId)` exposes cumulative traffic accounting. Terminal run state requires terminal tasks and no outstanding leases; it does not establish comprehensive coverage.
- Admit a collected result **before releasing its lease**. Returned content is immutable: corrections use a new packet ID/key. Exact previously admitted replays remain harmless even after expiry or run completion. Restart reconciliation does not salvage unknown/unadmitted worker files or replay a conversation; an unknown worker must first be observed or stopped by the owned runtime.
- H6 passing control receipts require `test.targetId` and `test.artifactDigest` matching each verified deployment. Matching controls must all pass with consistent denominators under original policy; failed/inconclusive samples cannot be hidden behind a passing one. Source/build/deployment hashes and active enforcement must agree. Partial repair needs a verified subset plus explicit residual/unverified scope. Static/unresolved H6 remains `unverified`.
- Finding reproduction receipts declare an invariant; negative controls match its environment/configuration. Independent replay requires the same invariant/input identity, a distinct attempt/environment, and an authenticated verifier collector identity. The store cannot establish those facts by executing checks itself.
- Exported JSON schemas describe structure. `parse`/`safeParse`, scope validators and gates add cross-field/semantic checks; **do not replace these with JSON-schema-only validation**. JSON input is bounded in depth, node count, property count and aggregate text, and rejects accessors, cycles, sparse arrays, unsafe keys, non-finite numbers and unknown fields.
- JSONL export is intentionally conservative and returns the event snapshot as an in-memory string. Free text/unknown payload fields are omitted; credentials/paths are redacted. IDs/model names are retained machine fields, so callers must not encode secret material in them. The SQLite DB and `listEvents`/`listOutbox` APIs are not redacted; protect access and rendering.
- Deployment has been exercised on the installed Linux/Node 24 runtime, not separately on Node 22 or Windows. SQLite remains subject to the deployment filesystem's durability guarantees; no distributed leader election, filesystem sandbox, credential validation, target enforcement, process control or artifact-byte verifier is claimed by these modules. Those are explicit integration responsibilities, not placeholder implementations.
