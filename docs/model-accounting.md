# Ordinary `/p2o --target` runs: informational model accounting

## What changed

Ordinary Pi-native `/p2o --target …` runs no longer have application-level token or USD quotas:

- No `--budget` flag, no token/USD consent dialogs, no mandatory phase pools, no `partial-report.json`
  extension demand. `--budget` is now an unknown flag; an explicit numeric budget request through the
  onboarding API is refused with `ONBOARDING_BUDGET_REMOVED` instead of being silently ignored.
- The planning completion bound is the selected model's own capability:
  `selectedModelCompletionLimit(model, inputTokensUpperBound) = min(model.maxTokens, contextWindow - input)`
  in `src/runtime/completion-capability.ts`. No fixed 4096 planner constant and no thinking-level table.
- Model/thinking selection, scope/action consent, credential isolation, owned-runtime cancellation,
  no-progress/lifecycle controls, deadlines, target-request/tool/attempt/concurrency controls and evidence
  verification are unchanged.
- Observed provider usage (input, output, reasoning, cache, cost) is still written durably and
  cumulatively — as information. It is not an admission gate in this mode: a request is never refused
  because a token/USD number would be exceeded.

## Explicit persisted mode

Accounting-only is an explicit, durable policy (`{ mode: 'accounting-only' }`), never inferred from a
missing legacy number:

- Run/task manifests carry `modelAccounting: 'informational'` together with `maxTokens: null` /
  `maxCostUsd: null`; the schema refuses null financial caps without that explicit marker.
- An **unpriced** selected model is allowed: tokens are recorded, the cost is reported as unknown
  (`costPolicy: 'unpriced-informational'`, `committed.costUsd: null`, and `accountedCostUsd: null`
  unless all settlements are priced or provider-reported), and nothing is refused on price. Bounded legacy consent still
  refuses an unpriced selection before any provider request.
- The ordinary profile provisions a single-digit per-task attempt budget (3, shown in the consent dialog) and
  a durable consecutive-failure brake per task (`orchestrator.retry-brake`) so repeated worker failures cannot
  pay until the deadline. Legacy numeric attempt budgets are preserved where an owner explicitly chose one.
- The durable model ledger persists the mode in its `limits` and `limitsDigest`; restoring a bounded
  journal under an accounting-only policy (or the reverse) is refused as an identity mismatch.
- Reports render one cumulative informational snapshot (`modelBudget.accounting`); they do not fabricate
  four isolated phase reserves that no longer exist.
- Unknown/failed usage still fails closed: an unpersisted charge keeps its hold, and a failed commit
  refuses further dispatch until reconciliation.
- The gateway clamps each turn's completion ceiling to what the **actual transmitted request** leaves in the
  model context window (and refuses only when the payload itself cannot fit), instead of denying a long worker
  turn against the launch-time prompt estimate.
- The no-progress breaker no longer exempts an attempt merely because it once collected an observation: the
  last durable collector timestamp must stay inside the window (or the packet must be accepted).
  A controller restart does not reset that window. The consecutive-failure brake is derived from the
  durable attempt table even when the task permits 10,000 attempts, and a braked run is explicitly failed.

## Legacy bounded runs

Already-saved bounded consent and manifests stay bounded:

- `--profile conservative|ceiling` remains an explicit opt-in numeric policy, and legacy documents with
  numeric caps keep their original phase pools, turn caps and `GATEWAY_BUDGET_DENIED` refusals.
- Guided renewal of a legacy bounded consent preserves its numeric caps verbatim (the financial dialogs
  are gone, so renewal must not strip them).
- A bounded child task can never become accounting-only under a bounded parent
  (`modelAccountingNarrows`), and a bounded journal cannot silently migrate to accounting-only.
- `tests/checkpoint-default` verifies that a bounded mid-execution run is still refused further provider
  turns across a restart without resetting spend, while an ordinary accounting-only run continues on its
  same durable ledger after a fresh-process restart.

## Evidence

- `npm run test:review-repros`: exact retry-braked A→B→C cancellation/run-failure regression
  (2 attempts despite a 10,000-attempt budget), exact wire output 558 versus initial ceiling 1200
  with pre-dispatch durable admission/unknown-usage settlement/restart, and immutable legacy ceilings.
  The observed-output counterexample (initial 1200, effective 558, reported 600, total only 700) must
  notify a native-bound failure despite fitting the total byte allowance. `RuntimeHandle.modelBoundFailure`
  and gateway `MODEL_NATIVE_BOUND_EXCEEDED` receipts track this separately from spend exhaustion;
  no informational `budgetOutcome` or monetary-extension demand is fabricated.
- Focused runtime receipt: `P2O_TEST_RUNTIME_SUITE=runtime P2O_TEST_RUNTIME_PATTERN='native output overshoot'
  npm run test:runtime` verifies durable native failure and verified failed stop, with financial outcome absent.
- `tests/command/*`: grammar/HELP removal, refusal of the removed budget request, completion-capability unit
  tests, onboarding-contract behavior.
- `tests/onboarding/*`: no budget dialogs, explicit refusal, legacy preservation, no silent widening.
- `tests/first-use/*`: backend/worker/Docker mechanics and mock-host loopback coverage; these are not
  independent live installed-host RPC proof. That qualification must record the pushed SHA, installed
  revision, selected model/thinking and producer/verifier/report receipts separately.
- `tests/qualification-first-use/rpc-contract.test.mjs`: current real-host informational model confirmation
  title, cancellation of unknown prompts, and private-root ancestor/symlink fences (offline contract test).
- `tests/real-worker/spend-gate.test.ts`: growing/shrinking loopback request payloads recompute native
  completion capacity and use the exact wire bound for admission/assumed charges.
- `tests/budget/accounting-only.node.ts`: durability, restart, informational usage above former caps, and
  refusal to migrate bounded journals.
- `tests/autonomous-integration`, `tests/first-use-verification`, `tests/checkpoint-default`: ordinary and
  legacy paths end to end.
- `npm run test:live-loopback` (opt-in, spends real provider credit): live selected model at thinking `max`
  against a loopback target; asserts the native bound (not 4096), observed usage/cost, and no quota dialog.
