# Local assessment fixture

Runnable vertical slice for the pi-p2o application composition. It exercises the **real** supervisor, durable
store, headless runtime adapter, tool broker, evidence vault, interface backend and reporting pipeline against a
**loopback-only** HTTP fixture. Nothing here calls a model provider, an external target, a container or a host
shell.

```sh
node examples/local-assessment/run.mjs           # compile this slice and run the full chain (exit 0 on success)
node examples/local-assessment/run.mjs --keep    # keep the temporary run directory and print its path
node examples/local-assessment/run.mjs --run-root /tmp/p2o-run   # choose the run directory explicitly
```

The chain: mapping worker (H1 surface map) → two parallel hypothesis workers (H2) → independent verifier
(`replayFinding` in a freshly created fixture environment) → qualified report with accepted findings, ruled-out
claims and an explicit untested coverage cell.

Files:

| File | Role |
|---|---|
| `fixture-server.ts` | Loopback fixture with a guarded read route and a seeded export-route defect. |
| `scenario.ts` | Owner-approved run/task/policy document, finding/coverage/verification plans and worker plans. |
| `inert-worker.mjs` | Deterministic scripted worker (no model) speaking the public Pi RPC subset and the bridge protocol. |
| `bridge-extension.js` | Real operational Pi extension exposing `p2o_broker` and `p2o_packet`; pins its own digest. |
| `replay-environment.ts` | Clean replay provider: fresh fixture instance, verifier-owned environment receipt, termination receipt. |
| `main.ts` | `prepareLocalAssessment` / `runLocalAssessment` plus the CLI entry point. |
| `run.mjs` | Compile-and-run wrapper (provisioned TypeScript/Node types only; installs nothing). |

Report output: the run directory contains `assessment.json` (the owner document), `run-manifest.json`,
`report.json`, `report.md`, plus the durable store, vault, controller metadata and per-task workspaces.

Tests: `node tests/end-to-end/run.mjs` runs the fixture plus owner-authority, configuration-refusal,
bridge-authentication, interface-refusal, bridge-close/abort, stale-attempt, payload-injection, safe-fixture-variant
and pre-dispatch budget regressions. See
[docs/architecture/application.md](../../docs/architecture/application.md) for the full API and integration seams.
