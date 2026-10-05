# R1–R4 fixes and bounded live verification (2026-10-05)

- **Scope:** R1 (sandbox configuration digest), R2 (reservation release), R3 (authoring-contract drift),
  R4 (`.runs` compile filter), plus the verifier replay wiring this exposed.
- **Provider runs:** stopped after the third bounded run, per instruction. The last harness fix below is
  therefore **not yet live-verified**.
- **Nothing committed** (parent commits).
- **Attribution:** the tree also contains concurrent edits by another actor (`README.md`, `docs/USAGE.md`,
  `docs/first-use-qualification.md`, `package.json`, `src/application/first-use.ts`,
  `src/application/onboarding/**`, `tests/packaging/**`). They are not part of this change set.

## Files changed (this assignment)

| File | Change |
|---|---|
| `src/tools/container.ts` | **R1** — the configuration digest no longer folds in the run-scoped lifecycle marker; it now digests `{...options, runner: undefined, lifecycle: undefined, controllerLifecycle: undefined, mode, nodeVersion, packVersion, imagePin}` with a comment stating lifecycle ownership is attested by runtime/guardian receipts and container labels, never by the approved-config digest. |
| `src/store/types.ts` / `src/store/store.ts` | **R2** — `BudgetRelease` and `releaseBudget()`: lease-fenced, non-negative, never widens a limit, decrements `target_usage`, records a durable `budget.released` event with a bounded reason. |
| `src/orchestrator/types.ts` / `src/orchestrator/supervisor.ts` | **R2** — `releaseBudget(attemptId, delta)` on the supervisor (same fencing as `consumeBudget`). |
| `src/tools/broker.ts` | **R2** — `ToolExecutionError.dispatched` (true only after the dispatch boundary), so the owner can release exactly the reservations that never dispatched. |
| `src/application/composition.ts` | **R2** — exported pure helper `preDispatchReservationRelease(error, offline)`; the bridge catch releases the reservation for a pre-dispatch refusal, logs `entry.broker-release-failed` if the release itself fails, and still throws the refusal. Reservation-before-dispatch is preserved. |
| `examples/live-lab/contract-enums.json` *(new)* | **R3** — single source of truth for the worker crib: per contract `rootKeys`, `requiredRootKeys`, `detailsKeys`, `required` scopes and `enums`, generated from the handoff schema. |
| `examples/live-lab/scenario.ts` | **R3** — `readContractEnumTable`, `schemaContractEnumTable`, `assertContractEnumCoverage` (exact equality for root keys, required root keys, details keys and enums; no invented/missing required field) called from `buildScenario` so drift fails **before** any worker launches. |
| `examples/live-lab/bridge-extension.js` | **R3** — the authoring crib renders the exact required fields, root key set and enum values, and `p2o_packet` now refuses a drifting packet at authoring time (`cribViolations`) with exact paths (unknown root key, missing required field, invalid enum) instead of letting it reach admission. |
| `tests/end-to-end/compile.mjs` | **R4** — excludes `examples/**/.runs` (unix sockets) from the compiled slice copy. |
| `examples/live-lab/replay-environment.ts` | **Verifier wiring** — the environment receipt now carries `independentSession: true`, `targetReset: false` and `recipeDigest: request.recipeDigest` (the exact bindings `src/evidence/replay.ts:116–118` require; the local-assessment harness already did this). **Not live-verified.** |
| `tests/tools/container.node.ts` | **R1 regressions** — digest invariant to `lifecycle`/`controllerLifecycle`; digest still changes for image pin, layer pin, base pin, worker identity, seccomp, filesystem limits, input root, qualification and engine release. |
| `tests/tools/broker-progress.node.ts` | **R2 regressions** — pre-dispatch refusals report `dispatched === false` (capability, input, bring-up timeout, halt fence); a dispatched failure reports `dispatched === true` and stays charged. |
| `tests/evidence/sandbox-digest-admission.node.ts` *(new)* | **R1 admission regression** — a receipt whose sandbox carried a controller lifecycle is admitted against the owner-approved scope digest; a genuinely different configuration is still refused (`broker-input`). |
| `tests/orchestrator/budget-release.test.ts` *(new)* | **R2 regressions** — release restores task/target counters; exhausted task and target-wide budgets still refuse before dispatch; underflow/missing-target/empty-reason releases are refused; only a provably pre-dispatch broker failure releases. |
| `tests/live/live-lab.test.ts` | **R3 tests** — crib enumerates the exact enums/required fields/root keys; drifted or incomplete tables are refused; a packet with a stray root key, a guessed enum or a missing required field is refused at authoring time with exact paths. |

## Commands and observed results

```
npm run typecheck       # clean
npm run test:tools      # 69/69 pass (3 new R2, 2 new R1, plus the F4 suite)
npm run test:orchestrator # 69/69 pass (4 new R2)
npm run test:evidence   # 61/61 pass (1 new R1 admission)
npm run test:live-lab   # 13/13 pass (real Docker cold start + R3 crib/packet gates)
npm run build           # ok, check:build imports every entry point
```

### Bounded live runs (real `deepseek/deepseek-flash`, all with `.runs` present → R4 exercised)

| Run | State | Accepted packets | broker-input | broker-refused | Committed spend | Remaining acceptance reason |
|---|---|---|---|---|---|---|
| `ll-3NXdDn` | failed | 0 (packets rejected: root `peerTopology`) | 0 | 0 | 70 098 tok / $0.034870 | task packet shape (fixed by R3) |
| `ll-wyUeNf` | completed (terminal) | **3** | **0** | **0** | 160 738 tok / $0.075016 | `no finding reached independently-validated` (`clean-environment`: missing `independentSession`/`targetReset`) |
| `ll-CqdQGB` | completed (terminal) | **3** | **0** | **0** | 179 802 tok / $0.078596 | `no finding reached independently-validated` (`replay-recipe-binding`: missing `metadata.recipeDigest`) |

- R1 live receipt: the first run in which tool calls **executed and their evidence was admitted** —
  `map-source-*` (source.analyze, kind=source) and `map-health-*` / `map-read-own-*` /
  `map-export-secure-*` / `map-export-admin-*` (http.request, kind=observation). Before R1 every call died
  as `broker-input`.
- R3 live receipt: accepted H1 + H2 packets (`result.accepted` = 3) after the crib/packet gate landed; the
  first run failed with the exact root-key error the gate now names at authoring time.
- R2 live receipts: 0 `broker-refused`, 0 `broker-release-failed`, `budget.consumed` = 23 in the last run
  (the release path is only taken on a pre-dispatch refusal, which no longer occurred).
- **This turn's provider spend: 410 638 tokens / $0.188482 across 3 real live runs.**

## Blockers still visible

1. **Independent validation (P0, live harness).** `src/evidence/replay.ts:118` requires
   `environment.metadata.recipeDigest === digestJson(recipe)`; `examples/live-lab/replay-environment.ts`
   omitted it (and previously the two session flags). Fixed this turn, **not live-verified** because
   provider runs are paused. The next bounded run should either reach independently-validated or name the
   next gate; do not relax the check.
2. **Authoring type drift (P1, visible by design).** Run `ll-CqdQGB` recorded 2
   `orchestrator.result-rejected` with `$/details/composition/encoding: Expected a string` (both retried
   and later accepted). The authoring gate checks root/required keys and enums but not value *types*; the
   model wrote a non-string for an optional H2 field. Candidate fix: carry per-field JSON types in
   `contract-enums.json` and enforce them in `cribViolations`.
3. **Reviewer note.** `src/tools/broker.ts` (added `dispatched`) and
   `src/orchestrator/{types,supervisor}.ts` (added `releaseBudget`) were touched this turn while the F4
   review is in flight; the F4 behaviour itself is unchanged (the dispatch flag is set once, immediately
   after the existing `chargeCall` at the dispatch boundary).
4. `tests/end-to-end/compile.mjs` needed `sep` in its `node:path` import for the R4 filter — fixed after
   the first launch attempt failed loudly (`ReferenceError: sep is not defined`); the run was relaunched
   and R4 is exercised by every run above.

## F4 review response (F-1, F-2, F-3) — 2026-10-05

All three findings were reproduced, fixed, and re-checked with the reviewer's own repro files
(`/tmp/f4-review-repro/source/tests/orchestrator/{f4review,f4review3}.test.ts`, run against the fixed tree and
then removed). No provider run was made; the live acceptance gap remains the replay `recipeDigest` wiring
(fixed, unverified).

### F-3 (P0) — refunded refusals made the watchdog unreachable

Root cause exactly as reviewed: the R2 release left `usage.toolCalls` at 0, and the window rule gated on
that counter, so the breaker could never fire on the live-lab dead-loop shape.

Fix: a **non-refundable per-attempt refusal streak** (`Supervisor.refusalStreak`), incremented by
`releaseBudget` — the only path a provably pre-dispatch refusal takes — and consumed by
`enforceNoProgress` **before** the window rule. It requires zero collected observations and no accepted
packet, so refunds hide the refusal from the budget but not from the breaker. The window backstop now also
counts refunded refusals (`charged = usage.toolCalls + refundedRefusals`) and is disabled once the attempt
has collected anything. No budget counter was un-refunded; the fail-closed reservation is unchanged.

Receipt (reviewer repro 3, now obsolete by design): `BUG-3 state: {"lifecycle":"failed","usage":{..."toolCalls":0},
"watchdogFired":true,"runtimeStops":1}` — the repro fails only because it asserts the old buggy behaviour
(`halt === false`). My equivalent regression asserts the halt, the 6-refusal streak, the explicit reason and
the stopped runtime.

### F-1 (P1) — collected work could still be halted

Fix: `enforceNoProgress` now skips (and clears) any attempt with `collected > 0 || accepted > 0` before either
rule, so an attempt that ever collected an observation is never reported as "zero collected observations".

Receipt: reviewer repro 1 now passes (`BUG-1 halt event: null`, attempt stays `running`); regression
`[F-1] an attempt that collected an observation is never halted as no-progress`.

### F-2 (P1) — dependents terminalized while the producer could still retry

Fix: `terminalizeBlockedTasks` now requires `dependencyCannotBeRenewed()`: no live lease, no controller
approval, attempts exhausted (`>= maxAttempts`) or no time left for one more launch (`now + minLaunchBudgetMs
>= deadline`). A producer waiting out `retryAfter` is not a permanent blocker.

Receipt: reviewer repro 2 now passes (`{"producerLifecycle":"failed","producerAttempts":2,"maxAttempts":3,
"dependent":"queued"}`); regressions `[F-2] dependents wait until the dependency can no longer be renewed` plus
the existing "dependency that fails without an accepted packet terminalizes its dependents" (attempts exhausted →
still cancelled, run `failed`).

### Verification after the fixes

```
npm run typecheck        # 0 errors
npm run test:orchestrator # 72/72 pass (3 new: F-1, F-2, F-3)
npm run test:tools        # 69/69 pass
npm run test:evidence     # 61/61 pass
npm run test:live-lab     # 13/13 pass
npm run build && check:build # ok
```

Files touched by this response: `src/orchestrator/supervisor.ts`,
`src/orchestrator/types.ts` (`noProgress.consecutiveRefusals`), `tests/orchestrator/fixtures.ts`,
`tests/orchestrator/no-progress.test.ts`. `src/tools/broker.ts` and the R2 store/composition release path are
unchanged by this response. `docs/architecture/f4-independent-review-2026-10-05.md` was not modified.

## Second review round response (R-1 … R-4) — 2026-10-05

F-1/F-2/F-3 were confirmed fixed; these four findings in the same lane were then fixed and re-checked with
the reviewer's `/tmp/f4-recheck` repros (mechanically adapted to the new release signature, assertions
untouched, then removed). No provider run was made.

- **R-1 (denials counted as refusals).** A release now carries a structural refusal identity
  (`refusal: { code, toolPlane }`); `isToolPlaneRefusal()` is exported by `src/tools/broker.ts` (the module
  that owns the set) and the composition classifies the broker code with it. The supervisor increments only
  for tool-plane codes and **deletes** the streak for a denial — exactly the broker's own rule.
  Receipt: reviewer case D passes; regression `[R-1] a policy-denial release resets the streak…`.
- **R-2 (in-memory streak).** `derivedRefusalStreak()` re-derives the streak from durable `budget.released`
  events (bounded paged scan; `toolPlane` increments, a denial resets), seeded once per attempt per
  controller. Receipt: reviewer case E passes — two releases before the restart, one after, then the halt
  (`runtime.stops.length === 1`). Regression `[R-2] a restarted supervisor re-derives …`.
- **R-3 (transitive chain).** `dependencyCannotBeRenewed()` now treats a `cancelled` dependency as
  permanent (nothing relaunches it) and mirrors the launch gate for a last attempt in any state other than
  `failed`/`timed-out`. Receipt: reviewer case F passes (`task-c` cancelled promptly, run `failed`);
  regression `[R-3] a cancelled dependency permanently blocks its transitive dependents`.
- **R-4 (no reservation identity).** `releaseBudget` now enforces the strict R2 shape: only the two reserved
  counters (`toolCalls`, `requests`) may be reverted (`budget-release-shape`), a structured `refusal` is
  mandatory, and the code must match `^[A-Z][A-Z0-9_]{0,63}$` (`invalid-input`). Byte/token/cost accounting
  is never refunded, and a free-form reason can no longer feed the breaker.
  Receipt: reviewer probe G now fails with `budget-release-shape: Only the reserved toolCalls/requests
  counters may be released` — the probe asserted the primitive this hardening removed; regression
  `[R-4] a release may only revert the reserved counters and requires a structured refusal`.

Verification: `typecheck` 0 errors · `test:orchestrator` **76/76** (4 new) · `test:tools` 69/69 ·
`test:evidence` 61/61 · `test:live-lab` 13/13 · `build` + `check:build` OK. Reviewer recheck results
(adapted): A, B, C, D, E, F pass; G fails by design.

Files changed by this round: `src/tools/broker.ts` (exported classifier), `src/orchestrator/supervisor.ts`
(strict release, streak rules, durable derivation, R-3 predicate), `src/orchestrator/types.ts` (API
signature), `src/store/types.ts` + `src/store/store.ts` (durable `code`/`toolPlane` in `budget.released`),
`src/application/composition.ts` (structured refusal), `tests/orchestrator/{budget-release,no-progress}.test.ts`.

Still open and unchanged: the live acceptance gap (replay `metadata.recipeDigest` wiring fixed in
`examples/live-lab/replay-environment.ts`, still unverified live) and the authoring type-drift rejections
(`$/details/composition/encoding: Expected a string`) that the key/enum gate does not cover.

## Third round (R-4 residual + R-5) and the fault-injected live proof — 2026-10-05

Recheck #2 confirmed R-1/R-2/R-3 fixed and F-1/F-2/F-3 preserved; the two remaining P3 residuals were fixed
rather than only documented.

- **R-4 corrected: reservation identity + exactly-once release.** Restricting the refund *shape* was
  explicitly **not** sufficient: a shape-valid release could still be replayed against a later charge. The
  charge side now mints a durable reservation identity — `SupervisorApi.reserveBudget()` →
  `DurableStore.reserveBudget()` records the id in the `budget.consumed` event — and the release side is
  `releaseBudget({ reservationId, reason, refusal: { code } })` → `DurableStore.releaseReservation()`:
  - the released counters come **from the recorded reservation**, never from the caller (a release cannot name
    amounts or counters at all);
  - the same id can be released **once**; a replay is refused (`reservation-already-released`) and changes
    nothing, so it can never refund another call's charge (`reservation-unknown` for an id that was never
    minted here, including a reservation minted by another attempt);
  - the refusal class is derived from the code inside the supervisor via the broker's exported
    `isToolPlaneRefusal()`; a caller-supplied class is refused (`invalid-input`);
  - the reservation is durable, so it survives a controller restart and is still releasable exactly once.
  No schema bump was needed (the identity lives in the existing durable event ledger), which also keeps the
  non-owned `STORE_SCHEMA_VERSION === 4` assertion intact.
  Regressions: `[R-4/G]` (exactly-once replay, cross-charge replay, unknown/foreign id, no caller counters or
  class), `[R-2/reservation]` (release after restart), plus `[R-1/D]`, `[R-2/E]`, `[R-2/handover]`, `[R-5]`,
  and the composition helper `isPreDispatchRefusal()`.
  **Not claimed:** a controller that names another *unreleased* reservation refunds exactly that reservation's
  charge once — accounting stays truthful, and the reservation is then spent. Reservation-before-dispatch
  remains fail-closed (an exhausted task/run/target budget refuses before any traffic).
- **R-5 (bounded derivation).** The durable derivation is no longer a capped forward page scan: the store
  gained `attemptReleaseStreak(runId, attemptId)`, one indexed query over that attempt's own
  `budget.released` rows (tool-plane counts consecutively, a non-tool-plane release resets, latest code
  returned). Regression `[R-5]` seeds >20 100 events, takes two releases, restarts, takes a third and
  asserts the halt — passing where the page-capped scan lost it.
- **Controller handover (harness seam).** `Supervisor.handover()` (optional on `SupervisorApi`) stops pumping
  and drops local references **without** aborting the owned executions, so a replacement controller can adopt
  a live runtime; `dispose()` stays the fencing shutdown. Regression `[R-2/handover]`. The live-lab harness
  exposes the fault proof behind `P2O_LIVE_FAULT=refuse-broker` and `P2O_LIVE_RESTART_ON=first-refusal`
  (default off).

### Fault-injected live-lab runs (real provider; the sandbox bring-up is forced to fail so every broker call
is a tool-plane refusal before dispatch)

| Run | Fault | Restart | Supervisor halts (refusals) | Attempts | Run state | Spend |
|---|---|---|---|---|---|---|
| `ll-4gOSSc` | ✓ | not reached (25 s window missed; run ends in ~20 s) | 2 × 3, `lastCode` UNAVAILABLE | 2 failed | **failed (terminal)** | 7 644 tok / $0.002961 |
| `ll-OJL2rk` | ✓ | `dispose()` → runtime fenced | none | 1 cancelled | failed | 3 856 tok / $0.001509 |
| `ll-FroSE8` | ✓ | `handover()` at 6015 ms | 1 × 3 | 1 failed, 1 reconciling | **active (I stopped it)** | gateway charges only |

Receipts from `ll-4gOSSc` (the clean fault proof): every `entry.broker-refused` is `UNAVAILABLE`
("Sandbox preflight failed") or `CANCELLED`; the broker's own breaker additionally reports
`NO_PROGRESS_HALT: no-progress: 5 consecutive tool-plane refusals ...`; the supervisor recorded **10
`budget.released` events, all `toolPlane: true`, each with `{toolCalls: 1, requests: 0|1}`** against 10
`budget.consumed`; both attempts failed with `refusals: 3`; the run reached `failed`; the harness logged
`FAULT PROOF halt observed after 2 provider charges; no further provider turn is expected`.

### Open, visible

1. **Controller handover + retry seam (live).** After the handover, the replacement inherited the control
   record and halted attempt 1, but its retry collided with the previous attempt's workspace fence:
   `adapter.start-failed Workspace fenced or attempt already exists; reconcile rather than duplicate`, leaving
   attempt 2 in `reconciling` and the run `active` until I stopped it (`ll-FroSE8`). This is a
   fault-injected harness path, not the normal path, but it shows the handover/retry ordering needs an
   explicit reconcile-before-retry step (or a harness-side wait) before a live restart proof can be claimed.
   The durable-streak restart itself is proven offline (`[R-2/E]`, `[R-2/handover]`, reviewer case E).
2. **Live acceptance gap (unchanged).** Replay `metadata.recipeDigest` wiring is fixed in
   `examples/live-lab/replay-environment.ts`, still unverified live; authoring type-drift
   (`$/details/composition/encoding: Expected a string`) is not covered by the key/enum gate.

Offline verification after this round: `typecheck` 0 errors · `test:orchestrator` **78/78** ·
`test:tools` 69/69 · `test:evidence` 61/61 · `test:live-lab` 13/13 · `build` + `check:build` OK.
No further provider runs after `ll-FroSE8`; `docs/architecture/f4-independent-review-2026-10-05.md` was not
modified.

## Provider-run status (2026-10-05, after the R-4 correction)

- Real provider runs are **paused** pending parent authorization. The three fault-injected runs above
  (`ll-4gOSSc`, `ll-OJL2rk`, `ll-FroSE8`) used the pre-reservation-identity release API, so the *composition
  wiring under fault* has not yet been re-exercised with reservation ids; the store/supervisor mechanics are
  covered offline by the regressions listed above. The `P2O_LIVE_FAULT`/`P2O_LIVE_RESTART_ON` harness modes
  remain available for one bounded run when authorized.
- The clean fault proof (`ll-4gOSSc`) stands as recorded: every broker call refused with a tool-plane code
  before dispatch, 10 durable releases vs 10 consumes, both attempts halted by the supervisor with
  `refusals: 3`, run terminal `failed`, billing stopped.
- Still open: the live acceptance gap (replay `metadata.recipeDigest`, unverified live) and the
  handover/retry seam that left `ll-FroSE8` in `reconciling`.

## E2E contract update (2026-10-05, after the parent's `npm test` stopped at test:e2e)

`tests/end-to-end/end-to-end.test.ts` — the probe test now asserts the new reservation contract instead of
"refused but still charged":
- denial (`TARGET_DENIED`), zero fixture traffic and no evidence receipt are preserved unchanged;
- the pre-dispatch refusal refunds **exactly one** reservation: the refund names the reservation id recorded on
  its own `budget.consumed` charge, reverts exactly `{requests: 1, toolCalls: 1}`, carries
  `code: TARGET_DENIED` with `toolPlane: false`, and restores the same scoped target reservation;
- the refused call is net-zero in the attempt usage, a **replay** of the refund is refused
  (`reservation-already-released`) and leaves no second release record;
- dispatched work stays charged: the worker's own observations still own consumed reservations with no refund,
  and the attempt usage still counts them.
A paged `readAttemptEvents()` helper was added so a long run cannot hide the probe's own records.

`npm run test:e2e` → **14/14 pass** (no provider/model calls). No product code changed for this update.

## Verification-policy seam fix (2026-10-05, product seam)

**Problem (parent diagnosis confirmed):** the live-lab passes `replayEnvironment` as an application override and
the composition invoked it directly, so only the built-in `dynamicReplayFactory` minted a
`ScopedVerificationPolicy`; the harness session had none and `src/evidence/replay.ts` failed
`verification-policy`, leaving the run without an independently-validated finding.

**Fix — the controller is the sole authority for the verifier's policy, for any replay environment:**
- New exported seam `bindControllerVerificationPolicy({ run, scopeFor, now })` in
  `src/application/composition.ts`. It wraps *whatever* broker the composition resolved (override or built-in)
  and, per `prepare(request)`, sets `session.verificationPolicy =
  createScopedVerificationPolicy(run, scopeFor(request.attempt.attemptId), now)` — computed from the ACTUAL
  verifier attempt's broker scope.
- An environment may omit the policy (controller injects it); if it supplies one whose `runId` or `scopeDigest`
  differs, the seam **refuses by name** (`ApplicationError('replay-policy-conflict', …)`) and releases the fresh
  environment (`session.close`) instead of silently overwriting it.
- **Ordering (review fix):** the expected policy is computed *before* `broker.prepare`, so a defective scope (or
  run binding) refuses while no environment exists. Computing it afterwards would create an environment this
  seam cannot return, silently leaking it.
- **Bounded release (review fix):** `closePreparedReplaySession()` races the `close()` await against a 1s
  deadline and aborts the signal at it — an `AbortSignal` only bounds an abort-*aware* close, never the await.
  The refusal message records the release outcome (`prepared environment release: closed|timeout|failed`) so a
  leaked environment is visible in receipts instead of being assumed.
- The built-in `dynamicReplayFactory` path is unchanged and still goes through the factory (its
  `unapproved-verification` plan refusal propagates untouched; no double registration, no bypass). The
  owner-approved plan gate (`approvedVerification`) is untouched.
- `examples/local-assessment/main.ts` gained a test-only `replaySessionDecorator` seam (default behaviour
  unchanged) so the regressions run the real store/broker/vault chain with an override that omits or conflicts.

**Regressions** (`tests/end-to-end/end-to-end.test.ts`, inert local fixtures, no external traffic):
(a) omit-policy override → the chain still reaches `independently-validated` (controller policy injected);
(b) conflicting-policy override → the finding stays unresolved and the refusal is named
`replay-policy-conflict` in its limitations, with no finding validated;
(c) the seam propagates an environment's own `unapproved-verification` refusal unchanged;
(d) a scope defect refuses with the store's own error and **zero** `broker.prepare` calls (no environment can be
created before the controller has a policy to bind);
(e) an environment whose `close()` ignores the signal and never settles still cannot stall the refusal: the
refusal lands in ~1.0s (test measured 1059ms), the release was attempted once, and the message records
`release: timeout` rather than asserting an outcome.

**This seam has NOT been exercised live.** The last real-Pi run (`ll-m8bkq1`) failed *before* the replay stage:
the `task-hyp-idor` packet was rejected at admission by the handoff schema (`adapter-error:
$/details/composition/representationChanges: Expected an array; $/details/composition/writersReaders: Expected
an array`), so its verifier was cancelled and no replay ran. The absence of a `verification-policy` error in that
run is therefore **not** evidence that the injection works — it is evidence the verifier never reached the replay
environment. The only live validation to date that a controller-computed policy admits an independent replay
predates this seam; the next live run is the first live exercise of `bindControllerVerificationPolicy`.

**Commands / results:** `typecheck` 0 errors · `test:evidence` 61/61 · `test:orchestrator` 81/81 ·
`test:e2e` **19/19** (5 new) · `test:live-lab` 13/13. No live/provider run was made.

**Item 5 (now required — done): authoring type gate.** The live acceptance bar was blocked by schema TYPE drift
on optional `details.composition` fields (`$/details/composition/representationChanges: Expected an array`, …),
so the crib now carries and enforces exact types:
- `examples/live-lab/generate-contract-enums.mjs` (new) generates `contract-enums.json` from
  `handoffSchema` (`npm run build && node examples/live-lab/generate-contract-enums.mjs`); the JSON is byte-stable
  across regenerations and now records, per contract, a details-relative `types` table (accepted JSON
  type(s), array item types, required/optional, human description, exact pointer scope) alongside the root keys,
  required scopes and enums. 21 H1 + 31 H2 type entries.
- `scenario.assertContractEnumCoverage()` re-derives the same table from the schema and refuses any drift by
  name (`authoring crib value-type drift for <contract>`), so a stale JSON fails at scenario build, before any
  worker launches.
- `bridge-extension.js` `cribViolations()` enforces the table at authoring time with the field's JSON pointer:
  `$/details/composition/representationChanges: expected array of string, received string`, and element pointers
  for array items (`$/details/composition/writersReaders/0: expected string, received number`). The crib's
  guidance now renders the exact types (optional composition fields marked), and the H1 semantic gates the crib
  can express without lying: the `peerTopology[]` membership/authority evidence rule and the `interfaces[]`
  rule (required keys, `actorId === scope.actor.id`, `observed` needs observation|trace evidence, `inferred`
  needs `proposedCheck` + source evidence) — authoring guidance mirroring `src/contracts/gates.ts`, never a bypass.
- **Omission guidance (review fix):** `renderTypeGuidance()` renders the table for the worker in three
  scopes — required, **conditional** and optional — because listing the fields of an optional scope as
  unconditional requirements is what pushes an author to fabricate it. `composition` (and `peerTopology`) and
  their fields are stated as *"required only when `<scope>` is present — omit `<scope>` entirely when you have no
  evidence for it"*; `interfaces[]` element fields as *"required inside each `interfaces` element — omit the
  element itself when you have no evidence for it"*; the optional line states that an omitted optional field is
  valid and correct, and that a speculative value, guessed enum spelling or empty placeholder written only to
  fill the schema is not. The exact enforcement types (`representationChanges = array of string`, …) are still
  named, in the conditional line. Enforcement is unchanged; `cribViolations` still refuses a present-but-wrong
  value at its pointer.
- Regressions (`tests/live/live-lab.test.ts`): prose-level assertions that `composition`/`peerTopology` never
  appear on the required line while their exact types appear in the conditional line; a scalar where an array is
  required is refused at its pointer; a
  wrong array element type is refused at its element pointer; a type-valid packet built from the table passes;
  a hand-edited type table is refused by the drift guard; the rendered crib contains the type line and both H1
  semantic rules.

**Commands / results (item 5):** `typecheck` 0 errors · `test:live-lab` **13/13** · `test:e2e` **17/17** ·
`build` + `check:build` OK. No paid live run (parent runs exactly one).
