# Policy, tool broker, and execution boundaries

Implemented owned slice of [UPGRADE-PROPOSAL](UPGRADE-PROPOSAL.md) §3D / phase 2: `src/policy/**`, `src/tools/**`, `containers/**`, `tests/policy/**`, `tests/tools/**`. Node 22+ TypeScript ESM, built-ins only; no Pi/private Herdr dependency, installer, second model loop or host networking mutation. This API was published before implementation for the separate runtime/control agents.

## Stable integration API

Imports use `.js` suffixes after compilation:

```ts
import { createPolicy, TargetBudget } from '../../src/policy/index.js';
import type { Scope as ExecutionScope, BudgetJournal } from '../../src/policy/index.js';
import {
  createToolBroker, createDefaultRegistry, doctor,
  createLocalFixtureSandbox, createContainerSandbox, ToolExecutionError,
} from '../../src/tools/index.js';
```

- `createPolicy(scope: unknown, { now? })`: strict runtime validation, canonical deeply frozen scope/digest, `authorize(request)`, `authorizeAddress(issuedDecision, ip)`, `assertActive(context)`. Forged decisions, unknown fields, duplicate/ambiguous target origins, unknown accounts, wildcard hosts, /0 networks and control/report role escalation are rejected. Expiry is checked at dispatch, connection and collection; a backward clock cannot reopen observed expiry.
- `new TargetBudget(scope.targets, { now?, runId?, journal?, freshRun? })`: one supervisor-owned instance per run, shared by **all** attempts/adapters. Atomic synchronous admission for target-wide requests, bytes, concurrency and sliding-window rates, plus grant-wide call/artifact budgets. Known-identity tool attempts, including malformed/denied inputs, consume call budgets. Failed connection/request reservations are not refunded.
- `createToolBroker({ policy, budgets, sandbox, registry?, credentials?, secrets?, resolver?, receiptSink?, browser?, proxy?, fuzz?, sessionFence? })`: `await broker.execute({ context, tool, input, signal? })`. Context is **supervisor-supplied**, never an LLM input: `{ runId, taskId, attemptId, grantId }`. Calls return `{ data, artifact, receipt }`. Failures throw `ToolExecutionError` with stable `code` and immutable `receipt` (including denial/cancellation/spent budgets).
- `browser`/`proxy` are owner-supplied pack instances so the same objects can be released by the runtime, `fuzz` is the owner-approved fuzz configuration, and `sessionFence` is the attempt-liveness gate the broker consults before any capability that can create or drive a `browser.*`/`proxy.*` session (`browser.session open`, `browser.act`, `proxy.session start`, `proxy.history`). Session *cleanup* (`close`/`stop`) is deliberately not fenced. A fence refusal is a normal denial with its receipt, never a silent skip.
- `doctor({ registry, sandbox, required, budgets?, signal? })`: checks actual Node/platform, safe roots, provisioned tool identity/versions/qualification and sandbox preflight. Operational container mode requires durable budget persistence; missing tools/isolation/persistence block launch, with no installation/fallback.
- `createDefaultRegistry({ native?: boolean, limits?: ... })`: only implemented named adapters; overrides can **lower**, never widen, built-in limits. Descriptors include version `1.0.0`, actual implementation-file digest (including policy/broker dependencies), repository source, schemas, platforms, side effects, actions, timeout/input/output/file/redirect limits and collector identity. Both input and output schemas run; unknown tool fields are denied. Native is absent by default.

The execution scope is deliberately richer than `src/contracts`' admission scope. The integrator must supply an owner-approved execution policy, not silently infer allow-all permissions from target locators. Map shared `authorization.reference / authorizedBy / validFrom / expiresAt` to policy `reference / approvedBy / notBefore / expiresAt`. Exact origins, paths, CIDRs, accounts, methods, exclusions and expiring task/attempt grants require additional explicit approval. Map shared action/capability strings only when exactly supported; no implicit alias/widening. Source roots must be approved immutable input snapshots and their collected hashes must match approved shared input references.

Set grant expiry to the **minimum** of authorization, task/attempt absolute deadline and account approval, respecting reporting reserve. A scope/grant is not a cryptographic/legal proof of permission: the trusted supervisor owns authorization-reference verification and minting. Revoke/quiesce old brokers when replacing a scope; no automatic permission renewal or worker-authored grants.

## Scope shape

`Scope` v1 contains:

- `runId`, `authorization: { reference, approvedBy, expiresAt, notBefore? }` (UTC timestamps).
- `targets[]: { id, origins[], pathPrefixes[], allowedCidrs[], excludedCidrs?, methods[], actions[], accounts[], limits }`. Origins are exact scheme/host/port identities; path prefixes are segment-bounded. Only one budgeted target may own an origin.
- `limits: { maxRequests, maxBytes, maxConcurrent, rate: { requests, windowMs } }` per target.
- Global `exclusions[]: { origin, pathPrefixes[] }`; exclusion wins over allow.
- `accounts[]: { id, targetIds[], actions[], expiresAt, kind: 'anonymous' | 'credential' }`. Even anonymous actors must be explicitly approved.
- `grants[]: { id, taskId, attemptId, role, capabilities[], targetIds[], actions[], accountIds[], expiresAt, maxCalls, maxArtifactBytes }`. Roles `worker`/`verifier` can receive execution grants; `orchestrator`/`reporter` cannot.
- Actions: `read`, `mutate`, `inventory`, `analyze`, `native`. POST/PUT/PATCH/DELETE require explicit `mutate` at grant, target and account. Read/observation cannot be relabelled to authorize mutation.

Typed definitions and runtime validators are the authoritative field contract; no target/account/capability defaults exist. Target URLs and HTTP responses are untrusted data, never instructions.

## Implemented adapters

| Tool | Input | Collected evidence / qualification |
|---|---|---|
| `source.analyze` | `{ paths: string[], contains?: string }` | Bounded explicit files, SHA-256/line counts, literal search, lexical imports/exports/routes, package dependency declarations and redacted secret/dynamic-execution indicators. Never imports target code or executes package hooks. **Not** AST/taint/CVE analysis or confirmed vulnerabilities. |
| `http.request` | `{ url, accountId, method?, action?, headers?, body?, maxResponseBytes?, maxRedirects? }` | Each hop's canonical URL, method, approved account/action, DNS set, pinned peer IP, status, redacted headers/body, original body hash and traffic budget. No ambient credentials/proxy/global agent. |
| `web.observe` | `{ url, accountId }` | Constrained static HTML browser through the broker: title, links/forms with `scopeDecision`, HTTP evidence and explicit limits. No JS/eval, shell, profile, service worker, subresource fetch or form submission. |
| `api.map` | `{ url, accountId }` | JSON/OpenAPI operations annotated allowed/blocked/template-not-expanded; no server URLs, external `$ref`, templates or discovered operations automatically fetched/tested. Non-JSON remains explicitly unmapped HTTP evidence. |
| `service.inventory` | `{ urls: string[], accountId }` | At most 16 unique, pre-authorized HTTP(S) endpoints, sequential bounded HEAD observations, shared target rates. Not LAN/TCP/UDP scanning or protocol guessing. |
| `native.inspect` | `{ path }` | Opt-in qualified dedicated offline container only; read-only ELF/PE/Wasm header/string inspection and input hash verification. Never executes/traces/fuzzes binaries; no crash-reproduction claims. |

Browser integration is a real broker-backed **static observation capability**, not a full Chromium/agent-browser capability disguised as sandboxed. A live-JS browser is not provisioned. Unknown `eval`, shell, browser arguments or alternate URLs are denied. A future engine must confine/attest every navigation, subrequest, session and process before it can be registered; a navigation-only URL filter is insufficient.

## Connection-time egress policy

1. Normalize absolute HTTP(S) destinations, IDNA/IP spellings and default ports; forbid userinfo, controls/backslashes, nested escapes, encoded separators/dots, matrix parameters and decoded delimiter ambiguity. Decode unreserved paths, normalize compatibility characters and collapse duplicate separators; **send the same canonical path that was checked**. Fragments are not sent. Paths/queries remain bounded.
2. Check active authorization/grant, capability, explicit target/path/exclusion, method/action and approved account at every hop. Read tools can use GET/HEAD only (generic HTTP also supports approved OPTIONS); unsafe methods cannot claim read authority.
3. Resolve the hostname at dispatch **and immediately inside the connection creator**. Every answer (including IPv4-mapped IPv6) must be in allowed CIDRs and outside exclusions/unspecified/multicast/link-local ranges. Any DNS-set change between checks fails closed, including changes inside an allowed network. Resolve again on later requests/hops; no connection/TLS-session pooling or retry to another address.
4. Connect only to an approved pinned IP, preserve the original Host/TLS name, validate normal TLS trust/hostname (no insecure switch) and inspect the actual peer address/port before releasing queued HTTP bytes. Recheck expiry/qualification during response collection.
5. Reauthorize and charge every redirect. Only same-origin read/inventory redirects are followed, within the configured cap; cross-origin/account/downgrade escapes, excluded paths, ambiguity, loops and mutation replay are denied. No authority or credentials follow a cross-origin redirect.

Caller headers are narrowly allowlisted (`accept`, `accept-language`, `content-type`, conditional/idempotency headers). Host/auth/cookie/proxy/transfer-control headers cannot be supplied by a worker. `CredentialProvider.headers({ accountId, targetId, origin, action, signal })` stays in the supervisor and supplies approved auth/cookie/API-key/CSRF headers only. URL auth parameters and known body/form authentication/secret fields are unsupported/denied; login/role/account-changing flows need an application-specific approved action adapter, not a nominal `accountId` claim. Application-specific actor semantics, server-side aliasing/side effects and arbitrary encoded payload interpretation cannot be inferred from an HTTP method; explicit owner approval and independent verification remain necessary.

Target traffic is separate from model/docs/provider traffic. Only target traffic is implemented here. Do not expose an unrestricted docs/browser/model gateway as an alternative target-egress channel. Traffic-byte counters cover charged request representations, response headers and raw payload bytes; they are **not** TCP/TLS/DNS wire-byte billing. Requests are pessimistically reserved even if DNS/connection fails.

## Persistent budgets / supervisor ownership

Operational mode requires a trusted **synchronous transactional** `BudgetJournal`:

```ts
interface BudgetJournal {
  load(runId: string): unknown;                // saved BudgetState, or absent
  save(state: Readonly<BudgetState>): void;   // commit before returning, never async
}
const budgets = new TargetBudget(policy.scope.targets, {
  runId: policy.scope.runId, journal,
  freshRun: true, // ONLY newly admitted runs; omit for restart
});
```

Use the shared durable store/transaction layer under a single supervisor writer fence. `save` runs on call/reservation/byte/artifact/release transitions before dispatch can advance. Persistence failure poisons the instance and blocks further work; a missing restart state, changed limits identity or attempted fresh reset of an existing run fails closed. `bindRun` rejects foreign runs and looser-than-scope counters. This hook is a trusted integration contract, not proof that an arbitrary callback actually fsyncs or fences writers.

`exportState` preserves totals, grant usage and rate timestamps. Unknown active reservations survive restart; call `clearActiveAfterReconciliation(targetId, { terminationVerified: true, reference })` **only after** runtime-owned independent termination proof. No request/byte refunds or blind lease clearing. Multiple processes must funnel calls through the one supervisor, not instantiate separate in-memory counters. Default memory-only budgets are allowed solely in explicitly selected fixture mode.

## Filesystem, output and receipt boundary

- Sandbox accepts absolute, canonical, disjoint input/output roots. Inputs are a supervisor-owned **immutable trusted snapshot**. Only explicit relative paths may be read; traversal, percent/backslash/drive ambiguity, symlink files/ancestors, nonregular files and hardlinks are denied. Opens use no-follow, identity checks and bounded reads; no writes/imports/install hooks into source.
- Output root must be owner-only; generated per-run/task/attempt directories are 0700, exclusive no-follow artifact files 0600. Byte/count reservations are atomic across concurrent calls; limits apply before publication. Outputs never share a writable run directory with containers.
- Known secrets (including credential-provider values and encoded echoes), common credential fields, auth/cookie/private-key/password/token indicators are redacted **before** result/artifact publication. Evidence input/original-body hashes intentionally identify the original bytes. Redaction is defense in depth, not universal DLP or permission to export an arbitrary sensitive checkout. Protect manifests, hashes and artifact-store access separately.
- Receipts are deeply frozen and bind scope/config/input/tool identities, actual target budgets, output SHA-256/size, context, outcome and time. `receiptSink` must preserve them outside worker write authority. A sink failure is not returned as successful collection; the exception includes a failure receipt for durable retry. Orphaned private artifacts may exist after a sink failure/cancellation and must not be admitted automatically.
- Shared evidence admission must authenticate this collector and verify/copy actual artifact bytes outside worker write authority. `collected` means **observation**, not accepted handoff or independently validated finding. Source observations support only qualified static inference; HTTP success/exit/model agreement does not confirm a vulnerability.
- Pass an AbortSignal. Cancellation prevents later dispatch, aborts DNS waits/sockets, waits for owned container cleanup and cannot return collected success after cancellation. Reporting/receipt flush is supervisor-owned. Node filesystem checks on trusted local snapshots are not an openat2 or hard-kernel-I/O-stop guarantee against malicious same-UID races/NFS; runtime hard-stop ownership remains separate.

**Never give a worker unrestricted host Bash, filesystem, Node imports, Docker socket, browser or credential tools beside this broker**, including when claiming a broker-bound fixture assessment. Expose a narrow authenticated RPC surface with trusted context; replace/remove Pi built-in execution/filesystem/network tools. The runtime must enforce its worker/process boundary independently. Same-UID directories and a constrained HTTP function alone do not isolate a hostile host worker. There is no Pi extension code in these owned modules; the extension agent must use public pinned APIs and fully read Pi docs before implementing that bridge.

## Explicit isolation modes and pinned pack

`createLocalFixtureSandbox({ inputRoot, outputRoot, trustedInputSnapshot: true, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation', ...limits })` is limited to inert trusted local inputs and **loopback-only HTTP**, even when the manifest approves non-loopback CIDRs. It executes no target code/processes and has no native pack. It is **not** a worker/process sandbox and never a fallback for failed isolation.

`createContainerSandbox(...)` uses only fixed Docker operations, no host shell or inherited host HOME/Docker config. Required: digest-pinned local image, exact client/server version, Node **22.14.0**, pack **1.0.0**, worker/source/seccomp SHA-256 identities, named unexpired dedicated-lab qualification and explicit `containers-share-host-kernel-not-hostile-code-isolation` acknowledgement. Native additionally requires `nativeEnabled` and a native capability grant. See [pack qualification/build inputs](../../containers/QUALIFICATION.md).

Container runs have read-only rootfs/input, private bounded tmpfs scratch outputs, no credential/home/device/socket mounts, non-root uid 65532, dropped capabilities, no-new-privileges, explicit CPU/memory/PID/output limits, `--network=none`, `--pull=never`, a pinned default-errno seccomp profile denying sockets/namespaces (thread clone flags constrained; clone3 denied). Target egress occurs **outside** that offline pack only through this broker. Preflight performs loopback-only socket-denial/mount/identity probes and verifies removal with an explicit no-such-object response; arbitrary inspect/daemon failure is not termination proof. Missing image/engine/profile, unsupported version, wrong identity or uncertain cleanup fail closed. No image pull/build, privileged installation or host networking change is performed during assessment.

**Containers do not guarantee hostile-code isolation.** The trusted fixed pack never executes untrusted source/binaries. Dedicated hostile execution requires a separately qualified VM/hardened boundary; a VM driver, live-JS browser and fuzzing/tracing pack are not advertised as implemented. Pinned reproducibility does not attest that a dependency is vulnerability-free; operator security review/update and a real isolated pack smoke test are prerequisites for operational deployment.

## Verification

Standalone local-only job (intentionally `.node.ts`, not fake Vitest suites):

```sh
node tests/tools/run.mjs
```

The runner compiles only owned source/tests into an owner-private temporary ESM directory and removes it afterward. It installs nothing and does not edit the root package. `P2O_TSC` / `P2O_NODE_TYPE_ROOT` can select an already provisioned compiler/types. Integrators should run this as a separate test job beside the shared Vitest suites.

Injected engine runners are a test-only seam: `fixtureAcknowledgement: 'inert-engine-fixture-not-container-isolation'` is mandatory, receipts/preflight identify an inert, **non-attested** boundary and egress is forced to loopback. No implicit unsandboxed fallback or production-isolation inference is permitted from fixture driver success.

Verified harness selection: `openai-codex-account-3 / gpt-6.1-sol / max` (session model/thinking records and environment; not provider-side quality attestation). Host Node `v24.19.0`, TypeScript `5.2.2`; compatibility target Node 22. No Node 22 executable was available in the checked local paths, so a Node 24 run is **not** a Node 22 runtime receipt. No live Docker/VM isolation, model-provider calls, external target requests or security audit are claimed. Test Docker operations use an inert injected local engine fixture, never the host daemon.

Final command results are recorded below after the final owned-scope check.
