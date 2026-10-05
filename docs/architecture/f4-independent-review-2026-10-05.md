# F4 independent review — final pre-commit status (2026-10-05)

- **Supersedes** all earlier snapshots of this document. This round rechecks **only the changed refund path**:
  the worker's `reserveBudget` / `releaseReservation` identity API and its callers. F-1/F-2/F-3 and
  R-1/R-2/R-3 were already verified fixed and are not reopened here (one-line receipts in §1).
- **Method:** read-only over the frozen tree (`src/store/store.ts`, `src/store/types.ts`,
  `src/orchestrator/{supervisor,types}.ts`, `src/application/composition.ts`, `tests/end-to-end/end-to-end.test.ts`,
  `examples/live-lab/main.ts`); 9 independent API-safety probes compiled from the current sources into
  `/tmp/f4-api` and executed. No provider run, no live-lab run, no code edit (this document is the only change).
- **Independent suite status:** `npm run typecheck` clean, `npm run test:orchestrator` 81/81,
  `npm run test:tools` 69/69.
- **Bottom line:** the reservation identity closes the R-4 residual and the per-attempt streak query closes
  R-5. No refund-path finding remains; the only residual is the intended controller-side dispatch/no-dispatch
  trust decision, documented in §3.

## 1. Previously verified fixes (not re-litigated)

F-1 collected attempts survive the quiet window · F-2 retryable producers no longer cancel dependents ·
F-3 refunded refusals halt and stop the runtime · R-1 policy denials reset the streak · R-2 the streak is
durable across controller restart · R-3 transitive blocked chains terminalize promptly. Receipts: probes
A–F in the earlier rounds plus the worker's `tests/orchestrator/{no-progress,budget-release}.test.ts`.

## 2. Reservation API safety (this round, all independently verified)

| Property | Implementation | Probe result |
|---|---|---|
| **Identity** — a release names exactly one charge | `reserveBudget` mints `randomUUID()` and records it on the `budget.consumed` event (`store.ts:274-280`, `282-313`); `releaseReservation` looks the id up and releases only the **recorded** delta (`store.ts:315-350`) | **PASS** (S5): 3 charges, 1 release → `toolCalls` 3→2, target usage 3→2, released event names the exact id/delta; sibling charges untouched |
| **Exactly once** — replay is refused, not refunded | `budget.released` marker per reservation; second release throws `reservation-already-released` | **PASS** (S2, S8): replay refused with usage unchanged and no second release event; also refused from a restarted supervisor |
| **Per-attempt binding** — no cross-attempt refund | lookup filtered by `run_id` + `attempt_id`; unknown/mismatched ids throw `reservation-unknown` | **PASS** (S3): attempt B cannot release attempt A's id; A's own release then succeeds |
| **Caller cannot choose counters** | release accepts only `{reservationId, reason, refusal:{code}}`; unknown fields (`toolCalls: 5`, `refusal.toolPlane`) and malformed codes are `invalid-input` | **PASS** (S4) |
| **Reservation shape** | `reserveBudget` is exactly 1 tool call and ≤1 target request (`reservation-shape`) | **PASS** (S4): `toolCalls: 3` and `requests: 2` refused |
| **Refusal class derived, not asserted** | `toolPlane = isToolPlaneRefusal(code)` in the supervisor (`supervisor.ts:2008-2035`); denials delete the streak | **PASS** (S6): TIMEOUT, TARGET_DENIED, TIMEOUT, TIMEOUT stays `running` (reset at the denial); persisted event has `toolPlane:false` for the denial |
| **Live-lease fence** | release requires the current attempt's unexpired lease (`store.ts:222-228`) | **PASS** (S9): after `cancel`, release throws `stale-lease` and refunds nothing |
| **Long-run durability (R-5)** | `attemptReleaseStreak` answers from this attempt's own `budget.released` rows, no run-wide page cap (`store.ts:358-372`; `supervisor.ts:2038-2042`) | **PASS** (S7): 20 100 filler events, 2 releases, restart, 1 more → halt, `runtime.stops = 1` |
| **End-to-end exact-once receipt** | `tests/end-to-end/end-to-end.test.ts` asserts one refund per denied probe, exact recorded delta/target, one `budget.consumed` per refunded id, replay refused, dispatched observations stay charged | present in the tree; parent will run the aggregate |

## 3. Current residuals (no blockers)

1. **Trust boundary, by design:** the store proves *which* recorded reservation is being released, once, from
   a live lease — it cannot itself know that the call never dispatched. The composition holds the reservation
   id in a local and releases only when `ToolExecutionError.dispatched === false`
   (`composition.ts:1511-1532`). The worker bridge exposes no release operation (`bridge.ts:122-141`), so a
   worker or target cannot reach this path. Keep this as the documented controller contract.
2. **Minor performance note (not a finding):** the release lookup scans the attempt's own
   `budget.consumed`/`budget.released` events linearly (`store.ts:324-327`); at attempt-scale call volumes
   this is negligible, and it is the mechanism that makes replay detection exact.
3. **Live acceptance still to be run by the parent:** `examples/live-lab/main.ts` now carries the bounded
   fault proof — `P2O_LIVE_FAULT=refuse-broker` perturbs the pinned seccomp identity so every broker call
   fails the bring-up preflight `UNAVAILABLE` before dispatch, and `P2O_LIVE_RESTART_ON=first-refusal` hands
   the run over to a replacement controller so the streak must be re-derived. The live run should assert:
   ≥3 `budget.released` events with `toolPlane:true` for the attempt, `orchestrator.no-progress-halt`, a
   verified runtime stop, and no gateway charge after the halt. Not verified here (no provider runs, per
   instruction).

## 4. Repro artifacts

- `/tmp/f4-api/source/tests/orchestrator/api-safety.test.ts` — S1–S9 (all pass on the frozen tree).
- Compile/run as in the earlier rounds: copy `src` + `tests/orchestrator/{fixtures,fake-runtime}.ts`, `tsc`
  with the repo's provisioned compiler, then `node --test` the emitted JS. `/tmp` is transient; S2–S9 are the
  canonical API-safety recipes if they should be promoted into `tests/orchestrator/budget-release.test.ts`.

## 5. Pre-commit recommendation

The refund path now satisfies the reviewed invariants: per-reservation identity, exactly-once release,
recorded amounts only, derived refusal class, live-lease fence, durable long-run streak. **No residual
identity/replay finding remains.** Proceed with the parent's aggregate run and the fault-injected real
Pi live-lab run as the final billing-stop acceptance gate.
