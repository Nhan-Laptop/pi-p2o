# Runtime adapters — integration contract

Status: implementation complete for the headless and Herdr adapters; the runtime suite is green (see [Verification](#verification)). Owned paths: `src/runtime/**`, `tests/runtime/**`, this file. No dependency on private pi-herdr modules or shared store/contracts.

## Early API report to the parent

Import from `src/runtime/index.ts` (TypeScript ESM, Node >=22):

```ts
interface RuntimeAdapter {
  readonly kind: "headless" | "herdr" | "plan";
  readonly capabilities: RuntimeCapabilities;
  preflight(request: RuntimeRequest): Promise<PreflightReceipt>;
  start(request: RuntimeRequest): Promise<RuntimeHandle>; // launch, NOT research completion
  observe(handle: RuntimeHandle, options?: ObserveOptions): Promise<RuntimeObservation>;
  checkpoint(handle: RuntimeHandle, options?: CheckpointOptions): Promise<RuntimeCheckpoint>;
  stop(handle: RuntimeHandle, options?: StopOptions): Promise<StopReceipt>;
  resume(checkpoint: RuntimeCheckpoint, request: RuntimeRequest): Promise<RuntimeHandle>;
  collect(handle: RuntimeHandle): Promise<RuntimeCollection>;
  reconcile(handle: RuntimeHandle): Promise<ReconciliationReceipt>;
}
```

- `RuntimeRequest` carries run/task/attempt IDs, canonical workspace, input/scope digests, prompt, explicitly requested `{provider, model, thinking}`, **one absolute `deadlineAt` (epoch milliseconds)** and an explicit tool policy. Replacement uses a new attempt ID and the original deadline, scope/input identity, and session provenance.
- `RuntimeHandle` is a JSON-serializable versioned ownership receipt, not a child-process object. It includes attempt identity, a random ownership token, adapter kind, controller/session paths and native process/Herdr identity when known. Persist it through the injected `RuntimeHooks.persistHandle` **before dispatch**. Updated handles are published through that hook.
- `RuntimeHooks` also supplies transactional `claim`/`release` writer fencing, `emit` durable lifecycle receipts, `loadHandle` for reconciliation, and `validateResume` for current authorization/input validation. Store owners implement these interfaces without runtime imports of store internals. Default filesystem fencing supports local standalone use; an uncertain/stale handle is quarantined, never automatically duplicated.
- Capabilities explicitly distinguish lifecycle ownership, verified hard stop, conversation resume, event streaming, runtime selection attestation, checkpoints and sandbox-bound tools. Plan-only does not own, stop, resume, attest or imply isolation.
- `observe` returns a bounded event page and cursor/gap information; optional waiting is bounded by the absolute deadline. `collect` is a non-waiting snapshot of process outcome, bounded log tail, and requested/observed runtime receipts; it is **not** artifact acceptance or finding verification.
- Checkpoint is a controller-owned snapshot of a quiesced/stopped attempt and its Pi session digest. Resume copies that immutable conversation into a new attempt session; it does not restore browser, shell, tool processes, mounts or network state. A replacement is blocked until the previous writer's termination is verified.
- Headless uses public Pi **RPC JSONL** (LF framing only), `get_state` for actual provider/model/thinking, assistant events for actual response model, and `agent_settled` rather than `agent_end` as settlement. `start` launches a background initialization pipeline and promptly returns the durable handle.
- Herdr uses the installed public CLI's JSON envelopes, serializes only pane topology operations, and performs independent starts/prompts concurrently. TUI status is not model attestation; a small explicitly loaded runtime receipt extension provides actual Pi event receipts. Owned pane close is followed by independent process/descendant verification.
- All logs, frames and observer buffers are bounded. Stop covers cancellation, SIGTERM/SIGKILL process-group escalation and descendant verification within the remaining total budget; uncertain termination keeps the writer fence.

## Deadline, startup and termination semantics

- There is exactly one absolute budget: `RuntimeRequest.deadlineAt`. Preflight, preparation, readiness, prompting, observation waits and stop all share it; nothing renews it.
- `startupTimeoutMs` bounds only post-dispatch readiness (the receipt + `get_state` handshake). It never bounds preflight. A short `startupTimeoutMs` therefore produces an attempt that fails with a readiness `startupError`; it cannot make `start()` reject before a durable handle exists. Genuine preflight refusals (invalid configuration, unverified boundary, unusable `/proc`, already-exhausted deadline) still reject `start()` before any dispatch.
- Stop escalation is bounded by the same deadline: SIGTERM, then SIGKILL at the grace boundary, then a single bounded late-cancellation verification window (`deadlineAt + 100 ms`). `ProcessFamily.terminate` takes one authoritative `ProcessProbe.snapshot()` per iteration and derives both current ownership and newly discovered descendants from that pass; duplicate scans consumed the verification window and produced false unverified outcomes under load.
- A termination that cannot be positively verified is never reported as clean: the attempt is quarantined and the writer fence is retained. A later controller may reconcile, but must not duplicate the writer.

## Security contract

There is no implicit sandbox. `trusted-fixture` requires explicit acknowledgment and may enable host built-in tools only for trusted inert local fixtures. `sandbox-extension` requires a pinned, caller-approved extension and an exact non-built-in tool allowlist; built-in tools (including **normal host Bash**) are disabled. The caller/tool broker supplies and verifies the actual sandbox boundary. Runtime configuration alone is not a security-boundary audit.

Workers get a fresh private HOME/config, disabled resource/context discovery, explicit extensions/tools, no inherited platform credentials or host provider auth, and a small fixed environment allowlist. Model access must be intentionally configured through a credential-owning gateway/provider bridge; this runtime never copies the caller's `auth.json`, arbitrary environment or host HOME. Controller-owned receipts are not written into the task workspace; same-UID filesystem separation is hygiene, not hostile-code isolation.

## Session release receipts (attempt-owned pack sessions)

An attempt's pack sessions (browser, capture) live under a durable per-attempt session lease that the runtime
opens before dispatch. Release rules that a reader can check against the code:

* A release verdict is computed from the **registered** pack releasers only. With **no** registered releaser and
  an existing lease the verdict is `failed`/`verified: false` ("No session pack is registered") and the lease
  stays open so a later release (with a pack registered) can retry. It is never reported `released`.
* An attempt that never leased anything is a release of nothing: `released` with zero releaser entries and an
  explicit "nothing was leased" note.
* Releases of one attempt are **serialized** per attempt key. Two terminal paths can reach the same attempt
  (the runtime's own settle path and the supervisor's stop path); without serialization both would call the
  packs and the second, empty call could overwrite the durable verdict with a misleading zero count. The later
  caller now observes the first verdict and replays it as `already-released`.
* The verdict names each pack it asked (`browser-pack`, `proxy-pack`, or the composition's explicit
  `no-session-owning-packs` declaration), the killed-session count and the pack's own surviving-session probe;
  a surviving session makes the verdict `orphaned`, a failed/throwing pack makes it `failed`.

## Reference inspection

The upstream upgrade proposal and the local `pi-ctf-solver/extensions/ctfctl/delegate.ts` were used as references, not imported. The implementation uses installed Pi `0.85.1` public RPC/session/extension contracts and installed Herdr help/API metadata; no private modules are imported. No scans, external targets or provider calls are performed by the tests.

## Verification

Last verified 2025-10-02 on Linux with Node `v24.19.0`, TypeScript `5.9.3` and project-local Pi `0.85.1`.

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass — 0 errors (includes the `override` requirements in `herdr.ts`) |
| `npm run test:runtime` | pass — 26/27 passed, 1 opt-in skip; green across four consecutive runs (~19 s each) |
| `P2O_TEST_PI_BINARY=<local pi cli> npm run test:runtime` | pass — 27/27, 0 skipped |
| `npm run test:integration` | pass — interface ↔ supervisor seam, verified termination, clean shutdown |
| `npm run test:orchestrator` | pass — 29/29 |
| `npm run test:vitest` | pass — 58/58 (contracts, store, reporting) |
| `npm run test:tools` | pass — 52/52 (policy/tool brokering) |

The opt-in test launches the **project-local** Pi binary in RPC mode with `tests/runtime/fixtures/inert-provider.mjs`: an in-process `streamSimple` provider whose gateway URL is `http://127.0.0.1:1/never-contacted`. It performs no network or model call. It verifies public RPC framing, `get_state` provider/model/thinking attestation, `agent_settled` settlement, the public receipt extension, checkpoint/resume provenance and a verified stop.

### Known gaps (explicitly not claimed)

- Herdr coverage runs against an in-process CLI/schema stub, not a live Herdr server; pane topology, agent rename/readiness and socket routing are stub-verified only.
- Headless isolation is same-UID process/fence hygiene plus a fixed environment, not hostile-code isolation; container/broker enforcement is outside this path.
- Linux with `/proc` and Node >= 22 are hard requirements; other platforms fail closed.
- `sandbox-extension` requires a caller-supplied boundary verifier; runtime configuration alone is not a boundary audit.
- Bounded behavior is asserted on one host; no sustained-load or multi-host soak was run.
- Node 22 compatibility follows from the engine floor and APIs used; it was not executed on Node 22 here.
- The test runner enforces a 180 s spawn timeout per suite; a regression that leaves a test promise pending will surface as a cancelled file rather than a clean failure.
