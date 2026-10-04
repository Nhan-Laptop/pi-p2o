# Deterministic supervisor (ORCHESTRATOR)

Status: implemented. Owned paths: `src/orchestrator/**`, `tests/orchestrator/**`, this document. Node 22+ TypeScript ESM, built-ins only, no Pi/private-Herdr dependency, no target traffic, no process launches in tests.

Implements [UPGRADE-PROPOSAL](UPGRADE-PROPOSAL.md) §3B/§3C/§3E/§3F: admission, bounded task graph per **question** (not per skill), accepted-handoff dependency gating, bounded global/per-target concurrency and graph size, workspace leases with attempt generations, absolute deadlines with startup/checkpoint/replacement/report reserves, capability profiles, nonblocking parallel starts, owned cancellation with verified termination, restart reconciliation, and durable events/outbox integration. The LLM proposes; this module enforces and records.

## Stable API

```ts
import { createSupervisor } from '../../src/orchestrator/index.js';
```

```ts
interface SupervisorApi {
  admitRun(proposal: { manifest: RunManifest; mode: 'managed' | 'plan'; perTargetConcurrency: Record<string, number> }): Promise<RunManifest>;
  admitTask(proposal: { manifest: TaskManifest; role: Role; exclusiveKeys?: string[] }): Promise<TaskManifest>;
  workspaceFor(taskId: string): string;
  start(runId: string): ManagedRun;                       // returns promptly; does not wait for research
  tick(runId: string): Promise<RunSnapshot>;              // one deterministic scheduler pass
  wait(runId: string): Promise<RunSnapshot>;
  cancel(runId: string): Promise<RunSnapshot>;            // snapshot exposes draining/outstandingLeases/attempts
  recover(runId: string): Promise<ReconciliationReport>;  // never launches or kills
  replace(attemptId: string, selection: RuntimeSelection, options?: { continuity?: 'resume' | 'successor' }): Promise<ReplacementResult>;
  snapshot(runId: string): RunSnapshot;
  preview(runId: string): PlanPreview;                    // plan mode: unmanaged, launches nothing
  worker(attemptId: string): WorkerPort;                  // least-authority worker surface
  submitResult(attemptId: string, candidate: ResultCandidate): Promise<ResultAdmission>;
  runtimeHooks(): RuntimeHooks;                           // inject into managed adapters BEFORE construction
  budgetJournal(): BudgetJournal;                         // durable TargetBudget state behind one writer
  consumeBudget(attemptId: string, delta: Partial<BudgetUsage> & { targetId?: string }): BudgetUsage;
  flushOutbox(): Promise<{ delivered: number; retried: number }>;
  dispose(): void;
}
```

- `createSupervisor({ store, authority, controlRoot, workspaceRoot?, runtimes, ownerId?, reviewerId?, clock?, results?, events?, pollMs?, leaseMs?, startupTimeoutMs?, operationTimeoutMs?, stopReserveMs?, automatic?, ackWithoutSink? })`. `controlRoot` is a private controller directory for durable restart metadata; `workspaceRoot` is the approved canonical root of per-task private workspaces and is required for managed admission. `runtimes` may be populated after construction so `runtimeHooks()` can be attached. `ownerId`/`reviewerId` are controller ownership only: each attempt gets its own producing identity (`attempt.ownerId`), so a worker attempt and a verifier attempt never share one.
- `worker(attemptId)` returns `{ identity, submit, proposeChild, acceptedInputs }`. `identity.producerId` is that attempt's own producing identity (never the controller identity). It can submit one handoff packet and *request* child tasks; it cannot admit runs/tasks, grant capabilities, cancel, replace, insert evidence, or read other tasks' results.
- `src/interface/orchestrator-port.ts` (`createOrchestratorPort(api)`) type-checks against this API unchanged and derives its cancellation receipt from `snapshot()`.

## Enforcement guarantees

1. **Admission.** Run manifests are schema-validated, must be inside their authorization window, must leave the reporting reserve, and require an owner approval bound by SHA-256 to the exact canonical proposal (`Authority.verifyRun`). An approval that does not cover the full execution budget is rejected. Managed admission requires an approved workspace root; plan mode is preview-only (`start` throws) and never leases or launches.
2. **Bounded task graph.** A task is one bounded question with contrasting predictions, scope, skills, actions, capabilities, budgets, dependencies, depth and a derived private workspace. Admission rejects scope/capability/depth/budget widening, expired/over-reserve deadlines, control-role tool capabilities, state-changing tasks without explicit serialization keys, and unrestricted host tools (including `bash`, even in fixture mode — a worker never receives host execution beside a nominally restricted broker).
3. **Permissions are never self-granted.** Every task admission, every worker-proposed child, and every replacement calls the injected owner authority and validates the returned digest, provenance, expiry and (for replacements) the exact parent attempt. Workers can only propose children of their own task at depth+1; successor tasks created by replacement require a second owner approval.
4. **Scheduling.** One pass = observe → reconcile → schedule → drain → complete. Ready tasks launch in parallel; dependencies require **accepted packets**; state-changing/exclusive keys serialize overlapping work; global and per-target concurrency bound simultaneous leases; unknown leases always count against concurrency. `perTargetConcurrency` must name every approved target.
5. **Deadlines and budgets.** Each runtime request carries one absolute `deadlineAt = min(task deadline, authorization expiry, run deadline − report reserve)`. Startup is bounded by `startupTimeoutMs`, stop/checkpoint by `stopReserveMs`/`operationTimeoutMs`, and no launch or replacement happens when less than the minimum launch budget remains. Reporting time is reserved and never consumed by execution; `consumeBudget` delegates accounting to the durable store before broker dispatch.
6. **Verified termination only.** The supervisor releases a workspace lease only after the owning adapter returns a verified stop (or reconciliation proves termination/non-launch with a collector receipt). Unverified termination keeps the fence: the attempt is marked `reconciling`, the lease is retained, the attempt is reported as outstanding, and the run cannot reach a terminal state. Expiry never grants a takeover.
7. **Runtime honesty.** Observed runtime metadata comes from the adapter (`rpc-state` receipts); a packet's own `observedRuntime` is *overwritten* from the durable controller observation before admission, so a worker cannot forge its runtime. Any adapter receipt that does not match the requested provider/model/thinking fails closed: the attempt is stopped and marked failed. `compareRuntime`/capability discrepancies from the contracts gate remain authoritative.
8. **Idempotent results.** `submitResult`/collector admission is transactional and idempotent per packet digest; exact replays are harmless duplicates, different content under an existing packet identity is rejected, and a released lease cannot publish new content (`stale-lease`). Returned-for-evidence packets are correctable with a new packet ID/key on the next attempt.
9. **Restart recovery.** Controller state (control claim, launches, handles, receipts, budget journal) is written atomically under `controlRoot`; authoritative lifecycle/fencing state stays in SQLite. On restart the supervisor must be granted control by an owner-attested `transferControl` (which asserts the previous controller is fenced), `recover` re-adopts live workers by reconciling process identity (no prompt replay, no duplicate writer), releases only proven-terminated attempts, and **does not launch anything**. Further launches require owner re-admission of the task in the new session; there is no automatic permission renewal. A finished run is never resurrected (`run-not-active`).
10. **Model handoff.** `replace` requires an owner approval bound to the exact proposal and parent attempt, verifies termination, persists the checkpoint artifact reference on the previous attempt, and starts a new attempt with the approved selection under the *original* deadline and scope/input fingerprints. `continuity: 'resume'` (default) resumes the checkpointed conversation through `RuntimeHooks.validateResume`; `continuity: 'successor'` (for runtimes without resume, or for a deliberately fresh session) admits an owner-approved successor task that keeps the parent's question, scope, input revision, deadline, dependencies and exclusive keys, with lineage recorded as `parentTaskId` plus an `orchestrator.task-superseded` event.
11. **Durable events/outbox.** Every transition appends a durable event in the same transaction as its state change; `flushOutbox` claims/delivers/acknowledges in bounded batches with retry, and `exportJsonl` output is the store's redacted export. Runtime handle snapshots and controller receipts live in `controlRoot` (0700/0600, atomic rename); only status transitions and bounded redacted error text become events.
12. **Plan vs managed.** A run admitted as `plan` is a documented no-execution preview (`PlanPreview.guarantees = 'unmanaged-no-execution'`). A managed run rejects a plan/non-owning adapter before any launch (`orchestrator.runtime-rejected`) instead of inheriting unmanaged guarantees.
13. **Separated identities.** Controller ownership and per-attempt production are distinct identities. `ownerId`/`reviewerId` in `SupervisorOptions` identify the *controller*: they own the control claim (`orchestrator.control-claimed`/`control-transferred`), outbox claims, and controller-authored runtime receipts (`provenance.collectorId`). Every attempt is instead stamped with its own durable producing identity, `attempt.ownerId = <controllerId>.<role>.<attemptId>` (the controller prefix is truncated to keep the 128-character contract ID bound), recorded in the attempt, the workspace lease and the `controlRoot/launches` record. That identity is what `packet.producer.id` must equal, what `worker(attemptId).identity.producerId` returns, and what the task prompt names; `runtimeHooks().claim` refuses a launch record whose `producerId` disagrees with the durable attempt. A third attempt identity is never substituted, and a replaced attempt's identity cannot publish for the new lease. Because each attempt — including a `verifier` task attempt — gets a distinct identity, `src/evidence/replay.ts` can be satisfied with `verifierId = verifierAttempt.ownerId` while `verifierId !== finding.producerId` still holds; no verifier gate is relaxed.

## Integration seams (injected, never LLM-visible)

| Seam | Owner | Contract |
|---|---|---|
| `Authority` | owner/policy | Authenticates the human authorization reference and returns digest-bound approvals for runs, tasks, replacements and control transfer. Root/worker messages are proposals, never grants. |
| `DurableStore` | store | Transactions, workspace leases/fencing generations, budget accounting, evidence, gates, events, outbox, reconciliation. |
| `RuntimeAdapter` | runtime | `preflight/start/observe/checkpoint/stop/resume/collect/reconcile` plus capability advertisement. The supervisor never assumes a plan adapter owns anything. |
| `runtimeHooks()` | store/interface | `claim` = durable launch intent + fence check before dispatch; `persistHandle` = bounded handle snapshot; `loadHandle` = restart adoption; `emit` = durable bounded runtime events; `validateResume` = replacement authorization/identity check; `release` deliberately does **not** clear the store lease. |
| `results` | evidence | Optional preserved-result collector; absence is fail-closed (the supervisor then records no acceptance). Collected packets still pass the store's receipt-based gate. |
| `events` | reporting/interface | Optional outbox sink; without one, durable events are retained and acknowledged (`ackWithoutSink`, default true). |
| `budgetJournal()` | policy/tools | Synchronous durable `BudgetState` storage for the single supervisor-owned `TargetBudget`. |
| `consumeBudget` | tools | Pre-dispatch call/byte accounting in the store. |

## Exact integration changes for other owners

1. **Done (verified in this session).** Store/contracts: `BeginAttemptInput.requestedRuntime` + `resolveRequestedRuntime` (selection may change; adapter and required capabilities stay pinned) and the gate comparison against `attempt.requestedRuntime` when an attempt context exists. Model handoff with conversation resume therefore works end to end; my tests assert the accepted packet after replacement.
2. **Interface.** `createOrchestratorPort` should clamp `perTargetConcurrency` to `min(option, run.budgets.maxConcurrency)`: this supervisor rejects a per-target limit above the global limit (`target-concurrency`) rather than silently widening. Also pass the run's `mode` through only as ownership (`managed`); the interface's fixture/assessment label belongs to its own `run.admitted` event (the supervisor records `safetyMode` in `orchestrator.run-admitted`).
3. **Store/runtime.** Nothing further required for this slice. Runtime owners must keep `hooks.claim` failing closed on a foreign/stale fence and must not treat `hooks.release` as permission to drop the store lease.
4. **Evidence (identity bridge now available; gates unchanged).** Wire a `ResultCollector` that only returns packets whose bytes/provenance were preserved by the evidence owner; the supervisor does not verify artifact bytes and cannot create worker receipts. Runtime observations are admitted by the supervisor itself as collector receipts (bounded documents under `controlRoot/receipts/`), because it owns the adapter and process identity — those receipts keep `provenance.collectorId = controller ownerId`, which is deliberately *not* the attempt's producing identity. `replayFinding` no longer needs a workaround for verifier identity: pass `verifierId = verifierAttempt.ownerId` for the verifier task's own attempt. That value satisfies `attempt.ownerId === verifierId`, differs from `finding.producerId` (the producing attempt's identity), and the producing attempt is distinct, so `verifier-identity`, `clean-environment` and `replay-cleanup` stay exactly as enforced in `src/evidence/replay.ts`. Do not relax those checks.
5. **Tools/policy.** Map the task's `requiredCapabilities` and the execution scope to broker capabilities explicitly; no aliasing or widening. Keep the reservation/`consumeBudget` call before dispatching target traffic.
6. **Reporting.** Treat `RunState.completed` as "all admitted tasks are terminal", not coverage. Use `results`/`findings`/`coverage` plus `orchestrator.*` events; return-for-evidence, `reconciling`, unverified termination and failed attempts remain visible.
7. **Root configuration.** The integrator must add the orchestrator test job (`node tests/orchestrator/run.mjs`) and a root ESM/test configuration. This slice adds no runtime dependency and does not modify `package.json`.
8. **Application composition.** `application.md` §5.1 described this seam: the composition may now use the verifier attempt's `attempt.ownerId` as the verifier collector/verifier identity for the replay path instead of composing a private identity, and may cite guarantee 13 as the resolved contract. Producer packets keep using the producing attempt's `attempt.ownerId` (`packet.producer.id`) exactly as before.

## Verification

Host: Node `v24.19.0`, TypeScript `5.9.3` (provisioned toolchain, no installation). Node 22 remains the compatibility target; a Node 24 run is not a Node 22 runtime receipt.

```sh
TOOLS=/home/nhanlaptop/project/pi-ctf-solver/node_modules
"$TOOLS/.bin/tsc" --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --strict \
  --noUnusedLocals --noUnusedParameters --skipLibCheck --types node --typeRoots "$TOOLS/@types" \
  src/orchestrator/*.ts
"$TOOLS/.bin/tsc" --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --strict \
  --noUnusedLocals --noUnusedParameters --skipLibCheck --types node --typeRoots "$TOOLS/@types" \
  src/interface/orchestrator-port.ts
node tests/orchestrator/run.mjs
```

`tests/orchestrator/run.mjs` compiles an owner-private snapshot of `src/` plus `tests/orchestrator/` into a temporary ESM directory, runs `node --test --test-concurrency=1`, and removes the snapshot. It installs nothing and edits no package. Last result: **36 tests passed, 0 failed** (≈5 s), plus strict type-checking of the module and of the interface port.

Covered behaviours (inert fake runtime, real `DurableStore`, manual clock — no processes, no network, no model calls):

- admission: unapproved/expired-limit run refusal, digest-bound task approval, derived-workspace enforcement, role escalation, serialization keys, host-tool denial, scope/capability/depth/deadline bounds, plan-mode no-execution, non-owning-runtime rejection, worker child proposals requiring owner approval;
- scheduling: two independent questions genuinely overlap (max concurrency 2); per-target concurrency serializes; dependencies wait for an accepted packet and are surfaced to the consumer; exclusive-key serialization; cancel with verified termination; unverified termination retains the fence and never resumes cancelled work; expired-deadline drain through receipt-backed reconciliation; collector-path acceptance and exit observation; outbox delivery/redaction;
- integrity: invalid evidence returned rather than accepted (then corrected and accepted); forged runtime claim refused; exact replay is a harmless duplicate while a stale lease cannot publish new content;
- identity: each attempt gets a unique, contract-valid producer identity (`<controller>.<role>.<attemptId>`) distinct from the controller identity, stable across ticks/recovery/control transfer and through a `reconciling` attempt (the fencing lease, launch record and worker port keep the same identity while a result is refused `stale-result`), mirrored in `worker().identity.producerId` and the durable launch record, and refused by `hooks.claim` when the launch record disagrees; controller receipts/outbox ownership stay with `ownerId`; a verifier attempt is a distinct identity from the producer it replays while cross-attempt producer claims and identity-substituted replays are still returned-for-evidence; resume replacement keeps fencing and gives the new attempt a fresh identity. The evidence suite's `tests/evidence/verifier-identity.node.ts` is the cross-module receipt: real supervisor worker/verifier attempts, real `replayFinding` accepted with `verifierId = verifierAttempt.ownerId`, every replay receipt collected by that identity, and `verifierId = producer.ownerId` refused with `verifier-identity` before any broker execution;
- recovery: live worker re-adopted without duplication and terminated by the new controller; a recovered retryable task is not relaunched without fresh owner approval; a completed run is not duplicated or resurrected; control transfer without an owner fence is refused;
- replacement: approval required before any stop/checkpoint, approval bound to the parent attempt, checkpoint capability required, budget-reserve refusal, resume handoff (new attempt, approved selection, original deadline, scope/input fingerprints preserved, packet accepted) and successor handoff (lineage task, packet accepted).

## Residual boundaries

- Same-host, same-UID trust: `controlRoot` files, the SQLite database and adapter receipts are controller-owned artefacts, not a hostile-code sandbox. Worker tool isolation is the runtime/tool-broker boundary, not this module.
- One supervisor per store and run. Concurrent supervisors must use `transferControl`; multi-writer/distributed leases are out of scope.
- Recovery cannot adopt a live process whose identity was never durably recorded; such an attempt stays `reconciling` until termination is proven.
- `RunState.completed` means all admitted tasks reached a terminal state. Untested, blocked, returned-for-evidence and failed work stays visible; no completeness claim is made here.
- The suite exercises inert fake runtimes. No live Pi/Herdr worker, container, target traffic, scan, provider call or security audit was performed.

Implementing harness selection: `openai-codex-account-3 / gpt-6.1-sol / max`, read from `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` in this session's environment. This is the implementing session's verified selection, not a provider-side quality attestation for future assessment workers.
