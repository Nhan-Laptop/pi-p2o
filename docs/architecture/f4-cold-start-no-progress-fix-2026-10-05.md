# F4 fix — cold start decoupled, no-progress breaker, budget truth, terminal states

- **Date:** 2026-10-05 · **Scope:** the F4 fix list only (items 1-4 + regressions + one bounded live run).
- **Ownership honored:** only the assigned files were edited. `src/application/**`, `src/interface/**`,
  `extensions/**`, `README.md`, `src/policy/**`, `src/evidence/**`, `tests/end-to-end/**` were **not** touched.
- **Attribution warning:** the working tree at verification time also contained concurrent edits by another
  actor (`src/application/onboarding/service.ts`, `src/application/onboarding/types.ts`,
  `src/application/onboarding/runtime-prerequisites.ts`, `src/interface/command.ts`, `src/interface/index.ts`,
  `tests/command/text-print.test.ts`, `tests/packaging/**`). They are **not** part of this change set and are
  not attributed to it. The live run below therefore executed a tree that contained both change sets; every
  F4 receipt cited here was also reproduced in isolation by the owned unit and Docker suites.
- **Nothing committed** (parent commits).

## 1. Files changed (this change set)

| File | Change |
|---|---|
| `src/tools/registry.ts` | `DEFAULT_STARTUP_BUDGET_MS = 30_000`, per-capability `descriptorStartupBudgetMs`, and `CapabilityRegistry.startupBudgetMs(id)` with a hard 30s..300s floor. Operation caps stay untouched (`timeoutMs` 15s). |
| `src/tools/container.ts` | Optional `startupBudgetMs` (default 30s, validated 1s..300s) and a phase-aware per-CLI timeout: `create`/`inspect`/`version`/`image` and the probe run (`operation:"preflight"` request bytes) get the bring-up budget; steady-state work keeps the fixed 15s CLI cap; termination proofs stay at 1s. |
| `src/tools/broker.ts` | Bring-up runs under its own bounded budget (raced against abort, so a sandbox that ignores the signal cannot overrun it) **before** the 15s operation timer starts; a failed bring-up is no longer cached forever. `chargeCall` moved to dispatch. New per-attempt no-progress breaker: N consecutive `TIMEOUT`/`CANCELLED`/`UNAVAILABLE` refusals with zero collected receipts halt the attempt (`NO_PROGRESS_HALT` marker + structured `NoProgressReport` via `broker.noProgress()`/`onNoProgress`), fast-failing without dispatch or budget charge; any collected receipt or policy denial resets the streak. |
| `src/orchestrator/types.ts` | `SupervisorOptions.noProgress?: { windowMs?; minToolCalls? }`. |
| `src/orchestrator/supervisor.ts` | (a) `enforceNoProgress`: terminates a live attempt that never collected a non-runtime/log observation and never produced an accepted packet once it charged ≥ `minToolCalls` calls and the marker stayed unchanged for `windowMs` (default 300s / 3 calls; `windowMs: 0` disables) — termination stops the owned runtime, so provider turns stop. (b) `terminalizeBlockedTasks`: queued tasks whose dependencies are terminally unsatisfied are cancelled with the exact blockers instead of waiting for the deadline. (c) `dependencyBlocked` durable adjudication and run classification: such a run finishes **failed** (`truncation: dependency-failed`), never `completed`; cancellation/deadline/spend-truncation semantics unchanged. |
| `tests/tools/broker-progress.node.ts` *(new)* | 10 regressions: default caps, cold bring-up vs operation deadline (narrowed-cap proof), operation deadline still bounds work, uncooperative-sandbox bound, bring-up retry, halt after N refusals, collected receipt disables halt, denial resets the streak, breaker disabled, budget truth (pre-dispatch refusals cost 0; dispatched calls cost 1; no target reservation for offline work). |
| `tests/orchestrator/no-progress.test.ts` *(new)* | 5 regressions: breaker termination + runtime stop + durable reason, collected evidence prevents halting, disable/threshold behaviour, dependency-failure terminalization + failed run, cancellation semantics preserved. |
| `tests/orchestrator/fixtures.ts` | `noProgress` passthrough for the harness. |
| `tests/live/container-coldstart.test.ts` *(new)* | Docker-gated real-pack cold start through the broker, with an explicit skip receipt for missing docker/engine/pack image/base pin; asserts collection, unchanged 15s cap, ≥30s descriptor budget, single charge, no halt. |
| `tests/live/run.mjs` | Compiles/runs the new cold-start test; excludes private `.runs` artifacts (unix sockets) from the compiled slice copy. |

## 2. Exact commands and observed receipts

```
npm run typecheck                     # clean
npm run test:tools                    # 66/66 pass (10 new)
npm run test:orchestrator             # 65/65 pass (5 new)
npm run test:live-lab                 # 10/10 pass, 0 skip  → real Docker pack
   ℹ real pack bring-up took 1767 ms
   ℹ first source.analyze through the real pack took 2919 ms (bring-up 1767 ms)
npm run build                         # dist rebuilt
npx vitest run                        # 18 files / 211 tests pass
npm run test:integration              # pass (inert worker, clean shutdown)
npm run test:budget                   # 37/37 pass
```
No existing timing assertion was weakened: the descriptor operation cap stays 15000 ms (asserted), the
container work cap stays 15 s, termination proofs stay 1 s, and the 300s/3-call breaker only ends attempts
that never collected anything.

### Bounded real live run

```
npm run demo:live        # examples/live-lab/run.mjs --require-live --keep, real deepseek/deepseek-flash
```
- one run only: `live-lab-muulk83p` (run dir `examples/live-lab/.runs/ll-yjZ1xf`); durable ledger: 15 gateway
  exchanges (15 forwarded / 0 denied), observed selection `deepseek/deepseek-flash/low match=true`,
  77 454 tokens / $0.031602 committed; acceptance `ok=false`, coverage tested=0.
- **before (pre-fix run `live-lab-muukozn3`)**: first `source.analyze` `TIMEOUT: Tool deadline exceeded`
  (17.39 s) → 24 `CANCELLED` cascade refusals → task budget exhausted → run left `active`, 0 findings.
- **after (post-fix run)**: **0 `broker-refused`**, no `CANCELLED` cascade; both attempts settled normally
  (`no accepted packet after settlement`); the run reached a terminal state without waiting for its deadline:
  `state=failed`, all 4 tasks terminal, `truncation=dependency-failed`, blocked dependents explicitly
  recorded (`orchestrator.task-blocked`) with `blockedTaskIds: [task-hyp-export, task-hyp-idor, task-verify-replay]`.
- the real-pack cold start itself is proven by the Docker-gated test above (bring-up 1767 ms, first
  `source.analyze` collected in 2919 ms, no timeout).

## 3. Remaining weaknesses (prioritized)

1. **R1 (P0, blocks the live acceptance bar) — evidence admission identity mismatch (`broker-input`).**
   In the post-fix run every worker tool call executed and then failed admission with
   `Broker policy/configuration/operation-input identity differs` (`src/evidence/broker.ts:33`), 17 times.
   The decisive comparison is `receipt.configurationDigest === binding.configurationDigest`: the binding uses
   the owner-approved `task.scope.configurationDigest` (verified: `4289b36d…`, identical to the harness's
   `createContainerSandbox(sandboxOptions).configurationDigest`), while the receipt carries the digest of the
   **runtime** sandbox. `src/application/composition.ts:798-800` rewrites the container options by adding the
   per-run `controllerLifecycle` binding before creating that runtime sandbox, and `createContainerSandbox`
   includes `containerLifecycle` in its digest (`src/tools/container.ts:147`), so the two digests can never be
   equal. This is **pre-existing and previously unreachable** — before the F4 fix the call timed out before
   admission, which is why the live path never surfaced it. Candidate fixes (owner decision, mostly outside
   my ownership): (a) derive the consent/scope digest from the lifecycle-bound options document, or (b) exclude
   run-scoped lifecycle bookkeeping from the sandbox configuration digest in `container.ts`. I did **not**
   change the digest unilaterally: the lifecycle protocol is a real boundary property and (b) narrows an
   existing identity binding.
2. **R2 (P1) — pre-dispatch charges in the application layer.** `src/application/composition.ts:1501` still
   calls `supervisor.consumeBudget({ toolCalls: 1, requests: 1 })` for every bridge call *before* the broker
   runs, including calls that never dispatch. The broker now charges only at dispatch, but the task/run-level
   counter still advances on refused calls, and the store has no refund API (negative deltas are rejected),
   so this cannot be corrected inside my ownership. Minimal owner patch: move that charge behind the broker
   result (offline tools) or release `requests` on a pre-dispatch refusal. The supervisor no-progress breaker
   bounds the harm meanwhile.
3. **R3 (P2) — live-lab worker packet schema drift.** Both attempts' packets were rejected with
   `$/details/interfaces/0/reachability: Unknown enum value` (H1 allows `observed|inferred`,
   `src/contracts/schemas.ts:125`). The authoring bridge (`examples/live-lab/bridge-extension.js`, owned)
   does not enumerate that enum for the model. Fix in the owned bridge prompt plus a scenario assertion.
4. **R4 (P2) — `examples/live-lab/.runs` breaks the next `demo:live`.** `tests/end-to-end/compile.mjs`
   (not owned) copies `examples/**` and aborts with `ERR_FS_CP_SOCKET` on the unix socket a kept run leaves
   in `.runs`; only `tests/live/run.mjs` (owned) is fixed here. Owner patch: add the same `.runs` filter to
   `tests/end-to-end/compile.mjs:46`. Until then the documented `npm run demo:live --keep` needs
   `rm -rf examples/live-lab/.runs` first.
5. **R5 (P3) — breaker tuning.** The supervisor breaker defaults (300 s window, 3 tool calls, never any
   collected observation) are deliberately conservative; once R1/R2 land, revisit with real timing data.

## 4. Evidence index

- Before evidence (preserved): `tmp/p2o-e2e-ancient-bookshelf/artifacts/before-ll-iAoq4d/` (run manifest,
  receipts, state snapshot, `summary.txt`); cascade log `tmp/p2o-e2e-ancient-bookshelf/logs/live-lab.out`.
- After evidence: `tmp/p2o-e2e-ancient-bookshelf/logs/live-lab-after.out` (0 refusals, terminal failed,
  dependency-blocked events, spend) and `examples/live-lab/.runs/ll-yjZ1xf/` (report.json/report.md/live-summary.json).
- Diagnostic context: `docs/architecture/e2e-diagnostic-ancient-bookshelf-2026-10-05.md`.
