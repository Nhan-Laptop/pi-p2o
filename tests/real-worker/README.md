# Real-Pi worker end-to-end test

Runs the project-pinned Pi binary as the assessment worker for real; no scripted worker program stands in for it.
It also drives the **controller-owned model gateway** and the **durable model spend ledger** (T8 + R1
scope expansion S1/S2/S3 + T9 per-turn enforcement). Eight tests run in one job: five real-Pi worker runs and
three gateway-level witnesses that drive the real gateway, the real supervisor gate and the real ledger without
spawning a worker.

## What is real

- The **worker process** is the installed `@earendil-works/pi-coding-agent` package's own `bin.pi`
  (`node_modules/.bin/pi`, 0.85.1), launched by the runtime's headless adapter in `--mode rpc` with
  `--no-builtin-tools --extension examples/local-assessment/bridge-extension.js
  --tools p2o_context,p2o_broker,p2o_packet` plus the runtime receipt extension (`src/runtime/pi-receipts.ts`).
- **Worker identity is content-pinned** (`pi-pin.mjs`): the runner and the test verify that the resolved binary
  is the pinned package's declared `bin.pi` and that its bytes hash to the pinned SHA-256, so a wrapper that
  merely prints `0.85.1` cannot masquerade as the worker.
- **Pi's provider HTTP boundary**: the isolated `models.json` points the worker provider at the loopback
  **controller-owned gateway** mount with a minted attempt placeholder, so the real request build, streaming
  parse, tool-call loop, extension load and tool execution all run inside Pi, and the controller gateway injects
  the (synthetic, secret-shaped) owner credential only on the upstream hop to the loopback fixture.
- **The tool allowlist**: the durable runtime handle pins `["p2o_context","p2o_broker","p2o_packet"]`, the worker
  config disables built-in tools, and the Pi receipt attests `getActiveTools()` equals that list with every tool
  sourced from the pinned extension file.
- **Bridge framing and policy**: every call travels over the real supervisor bridge (`attempt.state`,
  `broker.execute`); the controller authorizes the owner-approved observation, executes it, mints the receipt and
  admits evidence. A denied observation is refused before dispatch.
- **Evidence and admission**: the baseline receipt is controller-minted with `provenance.tool.name ===
  'http.request'`; the out-of-scope probe mints nothing; the worker-written `handoff.packet.json` is preserved by
  the collector bridge into the vault and accepted by the real H2 contract gates.
- **Model spend ledger (T9 per-turn enforcement)**: enforcement is fail-closed and always on for a managed
  run — the ledger is built from the owner-approved run budgets whether or not the document declares `spend`
  bounds. The tests assert:
  (a) the durable attempt hold exists **before every provider request** (the gateway handler reads the journal
  while the request is in flight); (b) an unaffordable attempt worst case is **refused before dispatch** with
  **zero** gateway requests and a stable `BUDGET_EXCEEDED` code; (c) a run that declares only its budgets (no
  plan, no override) is still enforced with the default bounds (`prompt-bytes` + `min(4096,remaining)`);
  (d) a selection the pinned catalog cannot price refuses the owner document before any admission;
  (e) **every provider turn is admitted at the gateway before it is forwarded**, against the payload-derived
  worst case (`request bytes + the supervisor-declared max output`) plus the spend already committed, and is
  charged per turn from the usage the provider reported for that turn — asserted against Pi's own per-turn
  `session.jsonl` record, which is produced by a different component; (f) a run whose budget is nearly
  exhausted **refuses the next provider turn at the gateway** with `GATEWAY_BUDGET_DENIED`, zero upstream
  requests for that turn, and the earlier turns still charged (the failed attempt is charged for what it
  consumed, never released uncharged); (g) a provider response without readable usage is charged the admitted
  worst case and recorded as an explicit assumption; (h) doctor/preflight reports the effective plan
  (`spend enforcement=on … price=… bounds=…`) without contacting a model.
- **Credential isolation**: the durable worker config must contain exactly the 14-key runtime environment
  allowlist, its isolated `auth.json` must be `{}`, its `models.json` must carry only a minted
  `p2o-gw.v1.<8hex>.<32hex>` placeholder against the loopback gateway mount, the worker cwd must be its private
  workspace, the synthetic upstream secret must appear only on the controller→fixture hop, and no artifact under
  the run root (plus argv and env) may contain a host credential or a secret-shaped token.
- **Lifecycle phases**: the durable runtime handle must record `prompt-delivered` before `pi:agent_start` before
  `pi:agent_settled`, with a native process identity for the working phase, and the durable store must record the
  `running` transition before the packet state before `result.accepted`.

## What is scripted

- The **gateway model turns** (`inert-gateway.mjs`): it answers `POST /chat/completions` with fixed SSE chunks
  scripting `p2o_context` -> broker baseline -> broker source -> broker denied -> `p2o_packet` -> stop, derived
  from transcript tool results (never prompt prose).
- The **provider usage**: each turn ends with the standard `stream_options.include_usage` chunk carrying
  deterministic `prompt_tokens`/`completion_tokens` derived from the exact request/delta bytes. The numbers are
  synthetic but checkable, and they flow through real Pi into the settlement assertion.
- The gateway binds `127.0.0.1` only, contacts no model, and sees only the controller-owned upstream credential.

## What is NOT covered

- Live providers/models, real credentials or credential-owning gateways.
- Hostile-code isolation: the local-fixture sandbox is explicitly not a hostile-code boundary.
- Pi's interactive/TUI paths, and any model quality or planning behaviour.
- Per-turn admission for a run with **no controller gateway** (a fixture/direct-provider configuration): there is
  no controller-side egress to gate, so only the attempt-level launch hold bounds it and its observed usage is
  charged by the monotonic session catch-up. The egress witness covers every managed run with a controller
  gateway.
- Run-level status naming: the supervisor reports a run whose task never produced a packet as `completed`
  (its meaning is "orchestration finished") with `accepted: 0` in the `orchestrator.run-finished` event, even
  when the attempt itself is durably `failed`. The refusal is named on the attempt, in the gateway attestation
  and in the ledger release reason.
- **Real Herdr**: `run.mjs --herdr` launches one worker through the runtime's real Herdr adapter when a live
  local Herdr context is available. On this tree that run fails before dispatch (a supervisor reconcile probe
  races the Herdr launch pipeline); the raw event trail and the out-of-ownership fix are described in the
  KNOWN FAILURE note in `herdr-sanity.ts`. The default job stays green.

## Run

```bash
cd /home/nhanlaptop/project/pi-p2o && node tests/real-worker/run.mjs
# strict mode: a missing pinned pi binary fails instead of an honest SKIP
cd /home/nhanlaptop/project/pi-p2o && node tests/real-worker/run.mjs --require-real-pi
# opt-in real-Herdr sanity (needs HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID, HERDR_BIN_PATH)
cd /home/nhanlaptop/project/pi-p2o && node tests/real-worker/run.mjs --require-real-pi --herdr
```

The runner first verifies the pinned worker identity (package, version, declared `bin.pi`, content hash) and
prints `worker pin package=… version=… cli=… sha256=…`; a present-but-wrong or missing binary is never an honest
`SKIP` (only a *missing* binary is). It then compiles the slice with `tests/end-to-end/compile.mjs` into a
private temporary build, runs `node --test --test-concurrency=1`, and removes the build. Only loopback sockets
and temp directories are used. Wiring this runner into `npm test` is owned by the packaging module, not this one
(it is already exposed as `npm run test:real-worker`).
