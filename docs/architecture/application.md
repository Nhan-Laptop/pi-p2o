# Application composition and local end-to-end fixture

Status: **implemented and verified** (2026-10-02). Owned paths: `src/application/**`, `examples/**`,
`tests/end-to-end/**`, this document. Other modules (`src/contracts`, `src/store`, `src/orchestrator`,
`src/runtime`, `src/policy`, `src/tools`, `src/evidence`, `src/reporting`, `src/interface`, `extensions/**`,
root packaging) are owned by their own agents and are **consumed, never modified** here.

## 1. Purpose

The upgrade proposal's vertical slice is: *an explicitly scoped local fixture, a mapping worker, two independent
hypothesis workers, one verifier, and a report that includes accepted findings and untested gaps*. This slice owns
the **composition root** that wires the real sibling modules into one runnable application, plus an **inert local
end-to-end fixture** that exercises the whole chain without any external target, model call, container or host
execution.

| Layer | Real module wired |
|---|---|
| Durable state | `src/store` `openStore` (SQLite, migrations, leases, gates, outbox) |
| Schedule/enforcement | `src/orchestrator` `createSupervisor` with an owner-verifying `Authority` |
| Worker transport | `src/runtime` `createHeadlessRuntime` (real guardian, RPC, receipts, process ownership, hard stop) |
| Tool provisioning | `src/tools` `createToolBroker` + `createLocalFixtureSandbox` (loopback-only) |
| Egress/authorization | `src/policy` `createPolicy` + `TargetBudget` (per-attempt grants, one run writer) |
| Evidence | `src/evidence` `openEvidenceVault`, `createResultCollectorBridge`, `publishHandoffReviews`, `replayFinding` |
| Interface | `src/interface` `createSupervisorBackend` + an application `SupervisorPort` |
| Reporting | `src/reporting` `buildReport` + `renderMarkdown`/`renderJson`, fed only authenticated reviews |

What is deliberately **inert** in the local fixture: the worker program. It is a deterministic, owner-authored
scripted worker (no model), launched through the *real* headless runtime adapter with a pinned inert binary. The
runtime still owns the process, guardian journal, RPC readiness, runtime-selection receipts, deadlines and hard
stop; only the "reasoning" is a scripted step list. This is stated in every artifact and never presented as a
model run. A **real operational Pi bridge extension** exists for model workers (see §4); the inert worker speaks
the same bridge protocol directly and re-verifies the pinned extension digest before running any step.

## 2. Public API (`src/application/index.ts`)

```ts
import {
  createApplication,            // composition root over the real modules
  createOwnerAuthority,         // explicit, digest-bound owner approval; denies everything not pre-approved
  assertOwnerGrant, ownerGrantFor, validateApplicationConfig, loadApplicationConfig,
  createWorkerBridge, callBridge,               // supervisor-side worker RPC over a unix socket
  createCollectorBridge, controllerToolIdentity, // broker/controller evidence admission helper
  createIndependentVerifier,                     // thin adapter over evidence `replayFinding`
  OwnedHeadlessRuntime, createOwnedHeadlessRuntime, // headless adapter with an ownership/attestation barrier
  buildAssessmentArtifacts, coverageRecords, coverageReviews, producerFinding, acceptedPacket, acceptedResult,
  createP2OBackend,             // Pi interface entry point (P2O_CONTROL_MODULE)
  type ApplicationConfig, type AssessmentApplication, type AssessmentArtifacts, type OwnerGrant,
} from '../../src/application/index.js';
```

### 2.1 `createApplication(config, overrides?)`

```ts
const app = await createApplication(config: ApplicationConfig, overrides?: ApplicationOverrides): Promise<AssessmentApplication>;

interface AssessmentApplication {
  store: DurableStore; supervisor: SupervisorApi; vault: EvidenceVault; authority: Authority;
  sandbox: ExecutionSandbox; config: ApplicationConfig; collector: CollectorBridge; bridge: WorkerBridge;
  verifier: IndependentVerifier; interfaceBackend: ControlBackend; runtimes: Record<string, RuntimeAdapter>;
  policyFor(attemptId): Policy; grantIdFor(taskId): string; brokerFor(attemptId): ToolBroker;
  admitApprovedRun(): Promise<RunManifest>;
  admitApprovedTasks(): Promise<TaskManifest[]>;
  collectAccepted(taskId): StoredResult | undefined;
  acceptedPacket(taskId): HandoffPacket | undefined;
  artifacts(runId): AssessmentArtifacts;
  /** The composition-owned pack instances of one attempt (present only when a pack is enabled). */
  packInstancesFor?(attemptId): { browser?: BrowserPack; proxy?: ProxyPack };
  /** Hosted planner ledger + materializer, present only when the caller configured the seam. */
  requestPlan?: { ledger: RequestPlanLedger; materialize: typeof materializeRequestPlan };
  close(): Promise<void>;
}
```

Wiring order (the exact seam order the sibling modules require):

1. `validateApplicationConfig` (strict, closed schema; fixture fallbacks are refused, not defaulted).
2. Construct the sandbox from the approved configuration and verify `sandbox.identityDigest` when supplied.
3. `openStore`, `openEvidenceVault` (vault root outside every worker-writable root; artifact roots take their
   configured ids plus `worker-workspaces` for the workspace root).
4. `createOwnerAuthority(ownerGrantFor(config))`; `createSupervisor({ store, authority, controlRoot,
   workspaceRoot, runtimes: {}, results: collectorBridge, ownerId, reviewerId })`.
5. One run-wide `TargetBudget` journaled through `supervisor.budgetJournal()` (single writer; `freshRun` only
   for a run not already durable).
6. Real runtime adapters constructed **after** the supervisor so `supervisor.runtimeHooks()` (and
   `verifySandbox`) are attached before any launch; `runtimes[name] = createOwnedHeadlessRuntime(...)`.
7. Per-attempt `Policy` from the owner-approved `grantTemplates` + the durable attempt id; per-attempt
   `ToolBroker` sharing the run budget and the pinned registry.
8. `createWorkerBridge` bound to `controlRoot/handles/<attemptId>.json`; the composition writes each task
   workspace's `p2o-bridge.json` and (fixture mode) `worker-plan.json` before launch.
9. `createSupervisorBackend({ store, supervisor: port, render })` where `port` uses the interface-supplied
   manifest for admission and the **owner-approved** per-target concurrency map.

### 2.2 `createOwnerAuthority(grant)`

The authority holds the owner's own copies of the approved run and task proposals and approves only a proposal
whose canonical SHA-256 digest equals an approved digest, whose authorization reference/authorizer match, and
whose window is current. Replacements and control transfer are denied unless explicitly listed. Worker proposals
(messages, child tasks) never widen it. Denials throw `SupervisorError` with code `permission-denied` /
`permission-expired`; there is no warn-and-continue path.

### 2.3 `createWorkerBridge` — worker protocol

An owned worker is a separate process, so the supervisor-side bridge authenticates every call against the
**controller-owned** runtime handle (task id resolved through the durable lease, owner token compared in constant
time) and exposes exactly:

| Operation | Trusted action |
|---|---|
| `broker.execute { observationId }` | resolves the **owner-approved observation check**, pre-authorizes, charges absolute run/task/target limits **before** dispatch, executes the owner-approved input through the broker, evaluates the owner-approved expectation over the collected bytes, admits the artifact through the vault collector capability, stores the receipt and returns redacted data + controller-derived `evidenceId`/`outcome` |
| `worker.acceptedInputs {}` | returns only the accepted dependency packets of the attempt's task |
| `attempt.state {}` | returns the durable attempt/task scope, question, requested runtime, observed runtime and lifecycle |
| `verify.finding { findingId }` | runs the independent verifier for the verifier attempt using the **owner-approved recipe** from `reporting.verification` (worker-supplied recipes, deadlines and reviewer identities are rejected) |

Every dispatch re-authorizes against durable live state, not only the stored handle token: the run must be active,
the attempt non-terminal, its deadline must remain, and it must still hold the current unexpired workspace lease.
Stale/cancelled/expired/released attempts are denied with `bridge-stale-attempt` on every operation, and a
liveness watchdog aborts in-flight tool work (as do request timeout, request deadline, worker socket close and
bridge close, which destroys sockets *before* awaiting the listener and is time-bounded).

There is deliberately **no** `worker.submit`: an accepted result must come from the evidence module's preserved
result-collector bridge, not a direct worker RPC write. The worker writes `<workspace>/handoff.packet.json`; the
supervisor's `results` collector preserves those bytes and admits the result through its fenced store path.

### 2.3.1 Owner-approved observation checks

A worker never supplies tool inputs, evidence kinds, summaries, test outcomes or claim metadata. The owner
document declares `checks: [{ checkId, taskId, observationId, tool, input, kind, classification, summary,
expectation?, test?, claim?, surfaceId?, actorId? }]`; the controller:

1. resolves `(attempt.taskId, observationId)` and rejects anything not in the owner document;
2. executes the owner-approved `input` (a worker cannot vary the URL, method, account or body);
3. evaluates `expectation` (`{type:'http', status, bodyIncludes?, mustMatch?}` or `{type:'source', contains?}`)
   over the *collected broker bytes* and derives `passed`/`failed`/`inconclusive`;
4. mints an attempt-scoped `evidenceId` (`<checkId>-<attemptId>`), the `test` receipt denominator, and
   `metadata.claimDigest`/`surfaceId`/`actorId` from the check alone.

Worker prose, a worker-claimed `test: {outcome: 'passed'}` or a forged claim digest therefore cannot become
collector-trusted evidence; the strict payload parser rejects unknown fields such as `test`, `evidence`,
`metadata` or `outcome` before any dispatch.

#### 2.3.2 Owner-configured capability packs (`packs`)

The browser, capture and fuzzing packs are **broker-level** modules; this composition is what makes them
*application-reachable*, and only when the owner document asks for them:

| document | effect |
|---|---|
| `sandbox.mode: "host-browser"` + the exact `host-browser-not-container-isolated` acknowledgement, owner, expiry, egress policy, private profile root and the pinned Chrome `identity` | the acknowledged host boundary; only valid in `authorized-assessment` mode and re-verified at preflight |
| `packs.browser: true` | provisions `browser.session`/`browser.act` (requires the host boundary) |
| `packs.proxy: true` | provisions/owns the capture pack (qualified on `local-fixture`/`host-browser`; `container` refuses it) |
| `packs.fuzz: { templates? }` | provisions `fuzz.differential`/`fuzz.template`; templates are validated by the pack's own `validateApprovedTemplates` |

Nothing is enabled by default and a pack is never enabled by a sandbox mode. When a session-owning pack is not
enabled, `browser.*`/`proxy.*` are refused for every attempt (`CAPABILITY_DENIED`) even if the owner grant names
them: a session created by a broker-owned pack would have no registered releaser, so the runtime could not
prove it was killed.

Per attempt the composition creates exactly one instance of each enabled pack and hands the **same instance**
to the attempt's `ToolBroker` and to the runtime's release hooks (`registerSessionReleaser`). The
`application.packInstancesFor(attemptId)` accessor exposes those objects for operators and tests; it is not a
worker surface, because dispatching to a pack directly bypasses the broker's policy check and the
attempt-liveness fence (live durable attempt + controller-private runtime handle + open runtime session lease)
that gates session creation and use.

Release receipts are explicit: one releaser per enabled session-owning pack (or the declared
`no-session-owning-packs` when the composition enables none), the killed-session count, the pack's own
outstanding probe, and a durable lease verdict. A release over an empty releaser registry is reported
`failed`/unverified by the runtime, never `released`, and concurrent releases of one attempt are serialized.

### 2.4 `createIndependentVerifier`

A thin adapter over `src/evidence/replay.ts`. It re-derives the producer finding from the durable accepted packet
on every call (a promoted review from an earlier attempt is never fed back as the producer state) and calls
`replayFinding({ ..., verifierId: verifierAttempt.ownerId })`. No identity, clean-environment, admission or
promotion check is reimplemented here. When the verifier attempt is not yet durably `running`/`waiting`, the
adapter forces bounded supervisor ticks so the authoritative replay guard sees a live verifier.

### 2.5 `buildAssessmentArtifacts`

Consumes only supervisor/store data plus vault-authenticated `HandoffReview`/`FindingReview`/`CoverageReview`
records and controller-attested runtime receipts from `publishHandoffReviews`; produces `AssessmentReport` plus
Markdown/JSON. Coverage starts from an explicit planned universe; omitted cells become `untested`. A completed run
is never rendered as comprehensive coverage.

## 3. `createP2OBackend` — default composition

`createP2OBackend({ cwd })` is the composition `src/interface/default-backend.ts` uses. This section documents the
**advanced operator override**: a pre-authored control module plus owner-authored JSON. The bundled default needs
neither — `/p2o --target` collects consent through the UI and synthesizes the same configuration (see
[docs/USAGE.md](../../docs/USAGE.md)).

```sh
P2O_CONTROL_MODULE=/abs/path/to/control-module.mjs   # re-exports createP2OBackend
P2O_APP_CONFIG=/abs/path/to/assessment.json
```

- `P2O_APP_CONFIG` must be an absolute canonical owner-controlled regular file (not a symlink, not
  group/world-writable, same UID) — validated like the control module itself.
- An override that is present but invalid fails closed (`INTEGRATION_REQUIRED`); with no override the bundled
  first-use path is used. There is no fixture or ambient fallback in either case.
- `mode: "inert-local-fixture"` requires the exact acknowledgement and a `local-fixture` sandbox;
  `mode: "authorized-assessment"` requires a `container` sandbox and must not claim the inert bridge mode.

Document shape (strict; unknown fields are rejected):

```jsonc
{
  "schemaVersion": 1,
  "mode": "inert-local-fixture",                      // or "authorized-assessment"
  "acknowledgement": "inert-inside-marker-no-hostile-code-isolation",   // inert mode only
  "roots": { "state": "/abs/state/p2o.sqlite", "control": "/abs/control", "workspace": "/abs/workspaces",
             "vault": "/abs/vault",
             "artifacts": { "controller-artifacts": "/abs/artifacts", "broker-artifacts": "/abs/broker",
                            "worker-workspaces": "/abs/workspaces", "input-snapshot": "/abs/snapshot" },
             "workerWriteRoots": ["/abs/workspaces"] },
  "run": { /* contracts RunManifest, state "created" */ },
  "tasks": [ { "manifest": { /* TaskManifest, parent/dependency ids, depth */ },
               "role": "worker", "exclusiveKeys": [],
               "toolPolicy": { "mode": "sandbox-extension",
                               "extension": { "path": "/abs/bridge-extension.js", "sha256": "…", "approval": "…" },
                               "boundaryId": "…", "tools": ["p2o_broker", "p2o_packet"] },
               "boundaryReceipt": "…",
               "workerPlan": { /* inert fixture only */ } } ],
  "runtime": { "adapter": "headless", "piBinary": "/abs/pinned/worker", "piVersion": "1.0.0",
               "gateway": { "approval": "…", "baseUrl": "…", "api": "openai-completions", "models": [ … ] } },
  "sandbox": { "mode": "local-fixture", "acknowledgement": "local-fixtures-only-not-hostile-code-isolation",
               "inputRoot": "/abs/snapshot", "outputRoot": "/abs/broker",
               "identityDigest": "<expected sandbox configuration digest>" },
  "policy": { /* src/policy authorization/targets/accounts + per-task grantTemplates */ },
  "checks": [ { "checkId": "…", "taskId": "…", "observationId": "…", "tool": "http.request",
                "input": { "url": "…", "accountId": "…" },
                "kind": "reproduction", "classification": "independently-observed", "summary": "…",
                "expectation": { "type": "http", "status": 200, "bodyIncludes": "…" },
                "test": { "purpose": "reproduction", "invariant": "…", "originalPolicy": true, "targetId": "…" },
                "claim": "…", "surfaceId": "…", "actorId": "…" } ],
  "bridge": { "socketPath": "/abs/run/worker-bridge.sock",
              "controllerArtifactRootId": "controller-artifacts", "brokerArtifactRootId": "broker-artifacts",
              "inertLocalOnly": true },
  "reporting": { "coverage": [ … ], "findings": [ … ], "verification": [ { "recipe": { … } } ] },
  "interface": { "perTargetConcurrency": { "<target>": 2 } },
  "vaultLimits": { "maxAgeMs": 3600000 }
}
```

## 4. Local end-to-end fixture (runnable)

```sh
node examples/local-assessment/run.mjs           # compile + run the full fixture, print the report
node examples/local-assessment/run.mjs --keep    # keep the run directory for inspection
node tests/end-to-end/run.mjs                    # offline node:test job (5 tests) over the same fixture
```

Fixture surfaces (loopback only, one origin per environment):

- `GET /api/v1/items/{id}?tenant={tenant}` — guarded read: exact tenant equality, else `403 tenant_mismatch`.
- `GET /api/v1/export?item={id}` — export route with **no tenant check** (the seeded defect); returns a neutral
  `value` field so the tool redactor cannot mask the observation.
- `GET /healthz` — fixture identity/configuration/instance document.

Chain, all through the real modules:

1. **Mapping task (`H1`)**: `source.analyze` over a hashed input snapshot plus bounded HTTP observations; submits
   two prioritized interfaces.
2. **Two parallel hypothesis tasks (`H2`, both depending on the accepted map)**: one confirms the export bypass
   (`supported`, `reproduction` + `negative-control` receipts evaluated by the controller), one disproves an
   uppercase-tenant claim (`supported` observation, finding `rejected`). A safe fixture variant (the export route
   enforces the tenant boundary) makes the controller evaluate the reproduction as `failed`, so the finding is
   returned with `reproduction-denominator` instead of being reported as confirmed.
3. **Verifier task (`H2`)**: the worker requests `verify.finding`; `replayFinding` creates a fresh fixture
   instance on the reserved verifier origin, qualifies it with a verifier-owned environment receipt, performs
   baseline/negative-control/probe through the real broker, and promotes the finding to
   `independently-validated` under a distinct producing identity (`p2o-supervisor.verifier.<attemptId>`).
4. **Report**: 4 accepted packets, the confirmed finding, the rejected finding, an explicit `untested` cell for
   the unauthenticated actor, all attempts `exited` with controller-attested runtime receipts, and
   `assessmentStatus: "incomplete"`.

`examples/local-assessment/bridge-extension.js` is the real operational Pi extension for model workers: it pins
its own SHA-256 against the tool policy, registers `p2o_broker` (broker RPC) and `p2o_packet` (bounded
`handoff.packet.json` write), and is loaded by Pi with `--extension`. The inert worker does not load Pi
extensions; it re-verifies the same pinned digest before running any step, so the pin is operationally true in
both modes.

Constraints held: loopback only, no external target, no model provider call, no container/VM, no host built-in
tools, no installation, no root package edit.

## 5. Integration seams

Resolved in this session (with the owning agents' landing changes):

1. **Verifier identity vs controller ownership** — the orchestrator now assigns each attempt its own producing
   identity (`attempt.ownerId = <controller>.<role>.<attemptId>`), so `replayFinding` is used verbatim with
   `verifierId: verifierAttempt.ownerId`. No duplicate replay logic remains in `src/application`.
2. **Interface `start` admitted only the run** — the application supplies a `SupervisorPort` that admits the
   interface-supplied manifest (so an unapproved run identity is refused by the owner authority) and then the
   owner-approved task set, without letting the interface widen the owner per-target limits.
3. **Result preservation** — the supervisor's `results` port is the evidence module's
   `createResultCollectorBridge`; direct worker submission was removed from the bridge protocol.

Still open (reported to the owning agents):

4. **Runtime `RuntimeKind` is a closed union** (`headless | herdr | plan`) and the supervisor maps unknown
   adapter names to `plan`, while `compareRuntime` requires `observed.adapter` to equal the runtime *kind*. A
   managed non-Pi runtime (in-process harness, VM driver, remote worker) cannot be registered without a runtime
   change. Desired: an advertised kind string plus capability-based acceptance.
5. **First-observation race (runtime + supervisor)** — the supervisor reconciles every newly leased attempt on
   its first pump (`!probed.has(attemptId)`), before `ManagedRuntime` has captured the guardian identity; the
   adapter correctly reports "no verifiable native identity", which quarantines a healthy launch. A second
   variant: the first `observe` can happen before any runtime-selection receipt exists, so
   `observedRuntimeFor` emits `{attestation: "reported"}` without a selection, which the contract schema rejects
   (`Reported runtime must report its selection`), and a later observation can try to move the durable lifecycle
   backwards (`running -> starting`). Workaround in this slice: `OwnedHeadlessRuntime` waits (bounded by the
   startup timeout) for a native guardian identity **and** an effective selection receipt **and** the `running`
   status before returning from `start`. Suggested fixes: the supervisor should not reconcile an attempt whose
   launch has no native identity yet (or should treat "launch in progress" as unknown rather than quarantine),
   `observedRuntimeFor` should use `unavailable` when it has no selection, and non-progressing lifecycle
   transitions should be ignored instead of raising a store error.
6. **Blocked replay and report admission (evidence/reporting)** — when a replay is blocked, `replayFinding`
   returns an `unresolved` finding whose `evidenceIds` include the replay receipts but which has no `verifier`
   field; `buildReport` then rejects the finding with `finding-not-admitted` because those ids are neither in the
   producing packet nor in `verifier.evidenceIds`. Desired: report unresolved replay receipts as visible but
   unadmitted, or keep replay receipts out of `evidenceIds` for blocked outcomes.
7. **Inert-local gateway is mandatory (runtime)** — `ManagedRuntimeOptions.gateway` is required even when the
   pinned binary is an explicitly inert worker that makes no provider call; the composition must pass a
   documentation-only gateway. A documented `gateway: "none"` (inert-local) mode would remove the misleading
   configuration requirement.
8. **No adapter provenance label (runtime)** — durable records cannot distinguish an inert fixture worker from a
   real Pi worker when both use `kind: "headless"`. Desired: an advertised attestation/provenance label carried
   into `ObservedRuntime`, so a report cannot present a fixture worker as a model run.
9. **Abandoned dependencies block run completion (supervisor)** — when a task exhausts its attempts without an
   accepted packet, its dependents stay `queued` and the run never reaches a terminal state, so `wait()` runs to
   its bound instead of surfacing the abandoned branch. Desired: dependents of a permanently failed dependency
   reach an explicit terminal/blocked state. The fixture's budget regression test drives the store directly to
   avoid this.
10. **[resolved] Generated-plan (request-plan) execution path** — `planner.ts` owns the generated-request API
    (`createRequestPlanLedger`, `materializeRequestPlan`, `ApprovedRequestGrant`). This composition builds one
    ledger from the owner gate plus the owner approval directory (`createOwnerDirectoryAuthority`) and hosts
    the planner's own materializer through the optional `requestPlan` seam (forwarding every plan-port option
    it does not own through `planPortOptions`). The target-workflow `entrySeams` register
    `materialized.checks` + `materialized.grants`: each check must be covered by its task's owner policy
    grant, each grant must name an owner-approved target/action/account, registered checks join the
    per-attempt observation menu (generated checks additively, owner-menu selections narrowing it) and the
    registration is recorded under `<roots.control>/entry-registrations/` (plus a durable `entry.plan-registered`
    event when the run already exists). Generated checks therefore execute through the same broker, fence and
    release path as owner-menu observations.
11. **Coverage `tested` does not require a passing test (reporting)** — `reviewCoverage` accepts a `tested` cell
    whose only test receipt has `outcome: 'failed'`. A failing check is still "tested", but the report should not
    read as confirmation; the fixture keeps its coverage reason outcome-neutral and relies on the finding
    classification for confirmation.

## 6. Trust boundary and non-claims

- The composition is same-host, same-UID. The bridge, vault, control files and SQLite are controller-owned
  artifacts, not hostile-code isolation. The inert fixture explicitly does **not** claim hostile-code isolation.
- Workers never receive host Bash, filesystem or provider credentials; the tool policy is a pinned
  `sandbox-extension` allowlist whose extension is re-hashed by `verifySandbox`, by the extension itself and by
  the inert worker. The inert worker ignores Pi arguments, so its tool-policy attestation is a fixture property,
  not a Pi verification.
- No external target traffic, scans, model/provider calls, container/VM execution, installation or security audit
  is performed by the fixture or its tests.
- A completed run means "all admitted tasks are terminal". The fixture's report deliberately retains an
  `untested` cell and reports `assessmentStatus: "incomplete"`.

## 7. Verification

```sh
node tests/end-to-end/run.mjs        # offline job: compile + 5 node:test tests, ~13 s
node examples/local-assessment/run.mjs   # exit 0, prints the qualified report
npm run typecheck                    # root program includes src/application and tests/end-to-end
```

`tests/end-to-end/run.mjs` compiles `src/**` (entry points plus the standalone runtime entries
`src/runtime/guardian.ts`/`pi-receipts.ts`), `examples/**` and `tests/end-to-end/**` into an owner-private
temporary ESM directory with the provisioned toolchain, runs the tests, and removes the build. Nothing is
installed and no root package file is edited. The runner reads `P2O_TSC` and `P2O_NODE_TYPE_ROOT` to select
already provisioned tooling.

Last results (this session, Node `v24.19.0`):

- `node tests/end-to-end/run.mjs`: **10/10 passed** (~17 s) —
  full chain (4 accepted packets, `finding-export-bypass` → `independently-validated`, 1 tested / 1 ruled-out /
  1 untested, every attempt `exited` with a controller-attested runtime receipt and no runtime discrepancy,
  JSON round-trip, `incomplete` status); owner authority denials; strict config refusals (fixture fallback,
  acknowledgement, unknown fields, fixture-only worker plans, sandbox identity mismatch); worker-bridge
  authentication (wrong token, unknown attempt, unresolved lease identity); interface refusals
  (`UNMANAGED_RUNTIME_REJECTED`, `FIXTURE_SCOPE_INVALID`, ENOENT manifest, unapproved run identity rejected with
  no durable run created);
  **audit regressions**: bridge close is time-bounded with an open socket and aborts in-flight work; stale
  (cancelled/completed-run/expired/released/foreign-lease) attempts are denied on every dispatch; worker payloads
  carrying `test`/`evidence`/`metadata`/`outcome` are rejected; a safe fixture variant cannot be reported as a
  confirmed finding (the controller evaluates `reproduction` as `failed` and the finding is returned); absolute
  request limits are enforced before any target traffic (exactly one approved request reaches the fixture under a
  one-request run budget).
- `node examples/local-assessment/run.mjs`: exit `0`; `accepted=4 returned=0`, ~30 preserved evidence
  receipts and ~140 durable events (attempt/retry dependent);
  `findings: finding-export-bypass=independently-validated`; `coverage: tested=1, ruled-out=1, untested=1`;
  `assessmentStatus: incomplete`.
- `npm run typecheck` (root program, which includes `src/application/**` and `tests/end-to-end/**`): no errors.

Root packaging request (owner: root toolchain agent): add `"test:end-to-end": "node tests/end-to-end/run.mjs"`
and call it from the aggregate `test` script. The root Vitest project intentionally does not collect
`tests/end-to-end/**/*.test.ts` (it is a `node:test` file run by its own runner).
