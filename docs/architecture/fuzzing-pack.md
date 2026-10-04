# Fuzzing pack (`fuzz.differential` / `fuzz.template`) and the external-tool runner contract

Two brokered capabilities for owner-supplied, bounded fuzzing:

* **`fuzz.differential`** — deterministic, seeded, in-process differential testing over owner-supplied
  local modules (two implementations of the same parser/canonicalizer/validator, or one implementation
  plus an invariant). Divergences are shrunk to a minimal reproducer. It is an **offline** capability:
  it never receives network or account authority.
* **`fuzz.template`** — bounded request-template mutation against **owner-approved templates**. Only
  the parts a template declares (query parameters, allowlisted headers, body) are mutated; every
  mutated request is re-authorized, DNS-pinned and budgeted by the existing broker HTTP path.

Plus an **external-tool runner contract** for coverage-guided fuzzers/scanners (ffuf/nuclei/sqlmap/…)
with version pinning, identity verification and fail-closed refusal. **Nothing is installed by this
repository, and no external runner is provisioned**: the contract, the pinned lab-image recipe and the
refusal path are the deliverable (see the last section).

Neither capability is provisioned implicitly. `createDefaultRegistry()` does **not** include them; a
run must pass `{ fuzz: true }`. The broker wires the pack itself (`createToolBroker({ fuzz: { templates } })`),
so a worker can never choose the adapter, the templates or the runner.

**Application wiring (opt-in).** `createApplication` provisions the pack only for `packs.fuzz: { templates? }`
in the owner document, and it passes the owner-approved templates (validated by `validateApprovedTemplates`,
i.e. the pack's own contract) to the broker. Without the opt-in, `fuzz.differential` is not provisioned at all
(`CAPABILITY_DENIED`), and with it the capability still needs a boundary that qualifies trusted local modules:
on `host-browser` it is refused (`UNAVAILABLE`) even though the owner opted in, and on `container` only
`fuzz.template` is qualified. The pack owns no process and no session, so a fuzz-only (or pack-free) composition
registers the explicit `no-session-owning-packs` release declaration instead of leaving the runtime's session
release verdict unprovable.

## Capabilities

| capability | actions | isolation | input | output |
|---|---|---|---|---|
| `fuzz.differential` | `analyze` | `local-fixture` only | `subject` (module pair or module + invariant), `strategy`, `seed`, `cases?`, `maxInputBytes?`, `timeoutMs?` | `fuzz-differential` evidence: normalized outcomes, minimized reproducer, divergence digest |
| `fuzz.template` | `read` / `mutate` | `local-fixture`, `container` | `templateId`, `seed`, `axes?`, `cases?` | `fuzz-template` evidence: baseline, bounded observations, classifications, caps/stopped |

The adapter declarations live in `src/tools/registry.ts`; the descriptor identity digest covers the
pack implementation (`fuzz/prng`, `fuzz/generator`, `fuzz/shrink`, `fuzz/differential`,
`fuzz/template`, `fuzz/external-tool`, `fuzz/pack`, plus `sandbox`, `http`) and the policy modules, so
a tampered descriptor is refused by `new CapabilityRegistry(...)` (tested). The policy plumbing adds
the two capabilities to `CAPABILITIES` and classifies `fuzz.differential` as offline
(`src/policy/scope.ts`); `fuzz.template` is admitted to the mutating-request family because every
request it issues is rebuilt from an approved template and re-authorized per request.

## What is refused, hard (never a warning)

| attempt | outcome |
|---|---|
| `fuzz.differential` on a boundary whose `codeExecution` is not `trusted-local-modules` | `UNAVAILABLE` |
| `url`, `host`, `target`, `accountId`, `method` … anywhere in differential input | `INVALID_INPUT` (schema rejects unknown fields) |
| differential module specifier with a scheme (`http://…`, `node:fs`, `data:…`) | `TARGET_DENIED` |
| differential module path absolute, `..`, or a symlink/escaping path | `FILESYSTEM_DENIED` |
| `fuzz.template` with a `templateId` that is not owner-approved | `CAPABILITY_DENIED` |
| template input trying to set `url`/`accountId`/`method`/`host`/`headers` | `INVALID_INPUT` |
| owner template declaring `host`/`authorization`/`cookie` header, or an identity query parameter | `ACCOUNT_DENIED` |
| owner template declaring a body for `GET`/`HEAD`/`OPTIONS` | `ACTION_DENIED` |
| expired template approval | `EXPIRED` |
| template whose origin is outside the grant | `TARGET_DENIED` before any request |
| external runner absent, identity absent, no pin, pin mismatch, tag-pinned image, expired pin | `UNAVAILABLE` / `IDENTITY_DENIED` / `EXPIRED` — **before** `run()` |

`fuzz.differential` is refused on `container` and `host-browser` sandboxes by its descriptor isolation;
the acknowledgement is additionally re-checked at execution time so a custom `ExecutionSandbox` that
forgets `codeExecution` fails closed.

## Isolation honesty: in-process, trusted modules only

`fuzz.differential` imports the named modules **into the controller process** with dynamic `import()`.
That is the whole design (the Strix `hypothesis` skill's local property testing), and it is not a
sandbox:

* Modules are resolved only inside the sandbox's immutable trusted input root; the specifier must be a
  relative path, the file is verified by `SandboxFilesystem.readInput` (containment, no symlink
  components, single-link regular file, size bound, byte identity before/after read) and re-hashed
  after import; a changed file is `FILESYSTEM_DENIED`.
* The `local-fixture` acknowledgement `local-fixtures-only-not-hostile-code-isolation` means exactly
  what it says. `ExecutionSandbox.codeExecution: 'trusted-local-modules'` is the explicit statement
  that owner-supplied code may run on the host kernel; it is **not** container or VM isolation, and
  `fuzz.differential` refuses any boundary where that statement is absent.
* Top-level module code runs at import time. A module that hangs cannot be preempted in-process (no
  `worker_threads`, no signals); the pack bounds cases, input bytes, outcome bytes and wall-clock time
  between cases, and documents the limit rather than hiding it. Untrusted or hostile binaries belong
  behind a VM boundary — see `docs/architecture/vm-boundary.md`.

## Differential design

**Strategies** (`FUZZ_STRATEGIES`) generate bytes; the module under test decides how to decode them, so
the differential is about the parser's interpretation, not the generator's:

| strategy | axes |
|---|---|
| `bytes` | uniform bytes plus NUL/CR/LF/`%`/`.`/`/`/`\`/quotes/replacement bytes; length 0–max |
| `utf8` | ASCII, 2/3/4-byte code points, overlong forms, encoded surrogates, truncated sequences, BOM, NUL |
| `json` | nested objects/arrays, duplicate and empty keys, `__proto__`/`constructor`, `1e999`, `\ud800`, trailing commas, keyless objects |
| `url` | scheme/authority fragments, `//`, `..`, `%2f`/`%252f`/`%00`, `@`, `[`/`]`, `\`, `#`, `?` |
| `header-value` | CRLF/CR/LF/TAB/space, separators, quotes, obs-fold, `%0d%0a`, NUL, DEL, non-ASCII |
| `path` | `/`, `..`, `.`, `%2f`/`%5c`/`%252f`, `C:`, `\`, `;`, `~`, NUL |

**Determinism.** `sha256(seed NUL strategy-label)` seeds sfc32 (pure 32-bit integer mixing — no
`Math.random`, time, locale or environment). The seed is recorded verbatim in evidence, and case order
is fixed, so the first divergence and the minimized reproducer are replayable. The pack stops at the
first diverging case; a re-run with the same seed and modules produces byte-identical evidence
(asserted in the suite).

**Outcome normalization.** Ordinary rejection is an outcome, never a test failure:

* `accept` — the canonical JSON of the return value (sorted keys, depth-bounded), or
* `reject` — the error `name` only (messages are not compared), or
* `oversize` — the canonical value exceeded `maxOutcomeBytes` (4096), recorded as a byte count, or
* `invariant-violation` — the module's `invariant(raw)` returned a non-empty string.

A module-pair divergence is `digest(outcomeA) !== digest(outcomeB)`. For `module-invariant`, the module
must export `outcome(...)` and `invariant(...)`; the invariant must return `true` or a violation string,
and an invariant that throws is a harness error (`INVALID_INPUT`), not a finding.

**Shrinking** is deterministic deletion-based minimization (ddmin-lite): half-size chunks down to single
bytes, kept only while the divergence reproduces, ending 1-minimal (no single-byte deletion still
diverges). No PRNG is involved, so the minimal reproducer is a pure function of the failing case. The
evidence records the initial and minimal sizes, the shrink step count, the reproducer hex/preview/sha256
and a `divergence.digest` over seed + strategy + reproducer + both outcome digests.

**Bounds.** `cases ≤ 4096` (default 256), `maxInputBytes ≤ 65536` (default 512), outcome ≤ 4096 bytes,
shrink ≤ 4096 steps, wall clock ≤ 90 % of the capability deadline, and the whole call is still cut off by
the broker's descriptor timer. Divergence evidence is written as a redacted, digest-addressed JSON
artifact in the private output root.

## Template design

An owner-approved template is validated once at pack construction:

```ts
interface ApprovedFuzzTemplate {
  id: string; accountId: string; method: string; url: string;      // the exact approved request
  query:   { name: string; base?: string; tokens: string[]; maxLength: number }[];
  headers: { name: string; base: string;  tokens: string[]; maxLength: number }[]; // caller headers only
  body?:   { base: string; tokens: string[]; maxLength: number };
  maxRequests: number; rate: { requests: number; windowMs: number }; // per-template caps
  approvedBy: string; expiresAt: string;                            // owner approval window
}
```

* **Mutation model**: the unmutated template is sent first as the classification baseline; each case
  replaces exactly one declared part (round-robin over the axes the worker selected) with a seeded value
  built from that part's owner-supplied tokens, bounded by `maxLength`.
* **Never host/scheme/port/path/account**: every request URL is rebuilt from the approved base and the
  pack asserts `origin` and `pathname` are unchanged; header names must be in the adapter's caller
  allowlist (so `host`/`authorization`/`cookie` cannot be set by construction); `accountId` always comes
  from the template, never from worker input. Query values are URL-encoded by `URLSearchParams`, so a
  token cannot introduce a delimiter or a new parameter.
* **No blind floods**: per-template `maxRequests`, a per-template rate window, the descriptor deadline
  and the target `TargetBudget` all bind. The broker's HTTP adapter re-authorizes every individual
  request (scope, method, account, DNS pin, address/CIDR, budgets, response/redirect limits), so a
  mutation that escapes the approved scope is a denial, never an observation.
* **Classification is a heuristic observation**, compared against the baseline: `status-diff`,
  `structure-diff` (JSON shape), `length-diff` (> max(32 bytes, 10 %)), `digest-diff`, `same`, or
  `error` with the policy code. Request-splitting header payloads are refused by the adapter's
  control-character check and never leave the host. The output is an observation, not a verified
  finding; the receipt classification stays `observation-not-verified-finding`.

## External-tool runner contract (no installs)

`src/tools/fuzz/external-tool.ts` defines the port and the verification gate:

```ts
interface ExternalFuzzRunner { readonly identity: ExternalRunnerIdentity | undefined; run(request, signal): Promise<ExternalRunnerResult> }
interface ExternalRunnerIdentity { tool; version; imageRef /* name@sha256:<64 hex> */; binarySha256; seccompProfileSha256; networkPolicy: 'none' | 'scope-only'; platform }
```

`assertExternalRunnerQualified(runner, pins)` refuses — before any work — when the runner is absent or
cannot prove its identity, when no owner pin exists, when the pin expired, when any of tool/version/
imageRef/binary sha256/seccomp sha256/network policy/platform differs, when the image is referenced by a
mutable tag, or when the network policy is anything other than `none`/`scope-only`. Only then does
`runExternalTool` call `runner.run()` and record a receipt-shaped evidence object with the runner's
identity digest, exit code, request count and stdout/stderr/artifact digests.

**Pinned lab-image recipe** (documented, not executed here; nothing is installed by this repository):

1. Resolve the base image **by digest**, never by tag:
   `docker buildx imagetools inspect <distro>` → record the index and the platform manifest digest.
2. Build with both digests passed as build args and verified inside the Dockerfile; download each tool
   release over TLS, check its published `sha256`, then install it. No `curl | sh`, no mutable mirrors,
   no package manager meta-versions.
3. `COPY` the seccomp profile and record its `sha256`; the image must reject socket/mount/ptrace/BPF/
   module-loading syscalls, matching `containers/seccomp.json` in spirit.
4. Record the content identity, not the tag:
   `docker image inspect --format '{{.Id}} {{json .RootFS.Layers}}' <ref>` plus the in-image tool hash
   (`docker run --rm --entrypoint sha256sum <ref> /usr/local/bin/<tool>`), and store them in an owner
   lock file exactly like `containers/pack.lock.json` does for the offline pack.
5. Run only pinned, hardened, networkless-by-default:
   `docker run --rm --pull=never --network=none --read-only --user 65532:65532 --cap-drop=ALL
   --security-opt no-new-privileges:true --security-opt seccomp=<pinned.json> --pids-limit=64
   --memory=512m --cpus=1 --log-driver=none <ref>@sha256:<id> …`
   When scoped traffic is required, the container gets the broker egress proxy as its only route
   (`networkPolicy: 'scope-only'`); every request is authorized and charged to the same `TargetBudget`.
6. Feed the recorded identity into `ExternalRunnerPin` and let `assertExternalRunnerQualified` gate every
   run. Any drift — including a rebuilt image with copied labels — refuses execution.
7. Evidence: `{ identityDigest, exitCode, requestsMade, durationMs, stdoutSha256, stderrSha256,
   artifactDigest }`; the runner's output is an observation and must still clear the separate
   verification state before it can be reported as a finding.

## Files

`src/tools/fuzz/{prng,generator,shrink,differential,template,external-tool,pack,index}.ts`;
shared plumbing additions in `src/policy/{types,scope}.ts`, `src/tools/{types,registry,broker,sandbox,container,index}.ts`;
tests in `tests/fuzz/**` (`fuzz.node.ts`, `fixtures.ts`, `run.mjs`, `fixtures/*.mjs`).

## Verification (raw output)

### Fuzz pack suite — `node tests/fuzz/run.mjs`

```
✔ differential fuzzing finds a seeded divergence in a local module pair and shrinks it to a minimal reproducer (49.984685ms)
✔ differential fuzzing compares one local implementation against an invariant oracle (26.537837ms)
✔ differential fuzzing refuses network targets, module URLs and host paths and opens no socket (29.428724ms)
✔ differential fuzzing fails closed without a trusted-local-code acknowledgement and is absent by default (75.212595ms)
✔ fuzz capability descriptors cannot be widened or re-identified by registry metadata (37.741973ms)
✔ template fuzzing mutates only declared parts inside scope and records classified observations (84.016613ms)
✔ template fuzzing enforces per-template caps, rate windows and the target budget (88.780521ms)
✔ template fuzzing refuses host/account mutation, unapproved templates and expired approvals (46.640921ms)
✔ external tool execution refuses an inert unqualified runner and only runs with a matching pin (2.570235ms)
✔ doctor fails the fuzz-pack check when the boundary does not acknowledge trusted local code (8.534604ms)
✔ demo: deterministic fuzz evidence for the docs (38.23183ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 593.466351
```

### Seeded divergence, shrinking and evidence (printed by the suite, `seed=b3-differential-1`)

```
seed=b3-differential-1 strategy=bytes casesMax=64 casesRun=1 outcome=divergence
subjectA=strict-header.mjs sha256=e90c58c32aca8bc1a166f796162831ee5e8b3434ad4914390905c33051961165
subjectB=lenient-header.mjs sha256=d53e1414d1065f89c38124d66616a25afa19fff1b8663f4ad260252abcf13263
foundAtCase=0 shrinkSteps=10 initialBytes=12 reproducer.hex=8e reproducer.bytes=1 reproducer.sha256=949f94d858ef6ad1333164d796a0d777fd82f9155ece7d6fad68c0b992f0e7af
subjectA.outcome={"kind":"reject","name":"TypeError"} digest=085e5c174139829fec908b15fe550ace305803793985d2f553f8e97d12e7e1d6
subjectB.outcome={"kind":"accept","value":"\"�\""} digest=82a1341b8269f518eadef464f7100aadeaa1f0d3e14c27da544212a904ca313e
divergence.digest=ae6c9083a36b5400c49220437af78f7fd5623aa2307f5cec229a003be250a9f8
artifact=fuzz-run/fuzz-task/fuzz-attempt/000001-b230dd688b706f508a230a13fe50d4da69dc907c04df13db0dc8f8c5798f062e.json sha256=b230dd688b706f508a230a13fe50d4da69dc907c04df13db0dc8f8c5798f062e
receipt.tool=fuzz.differential@1.0.0 implementationDigest=9d508422092bb8f07345a197d24e5f29ccf136df57b474736a4b84367cd88a89 outcome=collected classification=observation-not-verified-finding
```

The pair diverges on one invalid UTF-8 byte (`0x8e`): the strict canonicalizer rejects it
(`TypeError`, fatal decoder + control-character policy) while the lenient one decodes it to U+FFFD and
accepts it. The 12-byte generated case shrinks to the single byte in 10 steps; the same seed replays to
the same reproducer and digest. The invariant subject (`oracle-header.mjs`, one implementation plus an
invariant) shrinks a silent `;`-truncation to the single byte `3b`.

### Template evidence and the refusal path (same run)

```
template kind=fuzz-template templateId=tpl-query method=GET stopped=completed casesMax=4 casesRun=4 attemptsUsed=5/16 baseline.status=200
template.classifications=[{"name":"length-diff","count":1},{"name":"same","count":1},{"name":"structure-diff","count":2}]
template.observation[0]={"case":0,"axis":"query","name":"q","value":"JSONJSONx","valueSha256":"74bf1314822eecdb5cc0b93f05b59e77707b89c7ed7c1845c503e0ee1587a59f","url":"http://127.0.0.1:41833/tpl?q=JSONJSONx","status":200,"bytes":27,"bodySha256":"8ea48f8a09cc2e3ded0e086516a2f3f2c901a35ef84f5ff3bd9533bb031e292f","classification":"structure-diff","detail":"baseline is not JSON; mutation parses as JSON","responseFingerprint":"b5e2c9932189a9bc70a96753a1c2a6ceaecfcb79963ce96cb98078f08c82c888"}
template.receipt.targets=["fixture-target"] requests=5
refusals:
differential input.url -> INVALID_INPUT
differential module http:// -> TARGET_DENIED
template input.url -> INVALID_INPUT
template input.accountId -> INVALID_INPUT
template unknown id -> CAPABILITY_DENIED
external runner absent -> UNAVAILABLE
template host header -> ACCOUNT_DENIED
```

### Existing suites

```
$ npx tsc --noEmit -p tsconfig.json        → clean (exit 0)

$ node tests/tools/run.mjs                 → ℹ tests 56  ℹ pass 56  ℹ fail 0
$ node tests/orchestrator/run.mjs          → ℹ tests 59  ℹ pass 59  ℹ fail 0
$ node tests/fuzz/run.mjs                  → ℹ tests 11  ℹ pass 11  ℹ fail 0
$ node tests/interface/run.mjs             → ℹ tests 51  ℹ pass 51  ℹ fail 0 + JITI: PASS (14 tools/commands)
$ node tests/budget/run.mjs                → ℹ tests 37  ℹ pass 37  ℹ fail 0
$ node tests/sandbox/run.mjs --allow-missing → PASS live sandbox smoke: 35/35 checks passed

$ node tests/end-to-end/run.mjs            → ℹ tests 14  ℹ pass 14  ℹ fail 0
```

`node tests/end-to-end/run.mjs` passes 14/14 on an idle tree (observed twice with this pack in the tree).
Under concurrent load from other workstreams it can flake on the known load-sensitive assertion
`attempt.state === 'exited'` (line 60), which passed on the immediate re-run and has been documented as
load-sensitive in `docs/architecture/browser-pack.md`; nothing in this pack is on that path.

## What is real vs inert

* **Real**: deterministic seeded generation; in-process module import from the verified trusted snapshot;
  outcome normalization and digest comparison; deterministic deletion shrinking to a 1-minimal
  reproducer; divergence evidence artifacts and receipts; owner template validation; one-axis mutation
  with the origin/path/header-name/account invariants re-asserted per request; per-template caps and
  rate windows; per-request policy authorization, DNS pinning and target-budget charging through the
  existing HTTP adapter; descriptor identity/schema/isolation/action/side-effect tamper refusal;
  external-runner identity verification with refusal before `run()`.
* **Inert / not provided**: no external fuzzer or scanner runner (the contract has no implementation on
  purpose), no VM/hypervisor runtime, no container-based differential execution, no network access for
  `fuzz.differential`, and no sandbox for hostile module code. The template and differential tests use
  loopback fixtures with inert local modules.

## Known limits

* Differential modules execute on the host kernel inside the controller process; there is no preemption
  for a synchronous module that never returns (bounded between cases only). Untrusted code is refused,
  not contained.
* Module identity is verified around `import()` (read → import → re-hash), not atomically; the input
  snapshot is owner-controlled and immutable by contract, so a same-user race is a detection, not a
  prevention. The pack documents this instead of claiming a stronger guarantee.
* Outcome comparison uses error *names*; two implementations that throw the same type for different
  reasons are reported as agreeing. Messages and stack traces are deliberately not compared.
* Template classification is heuristic (status/structure/length/digest) and cannot distinguish an
  intentional variant from a defect; results are observations for a verifier, never findings.
* Header-value mutation operates inside the adapter's CRLF-refusing caller-header boundary, so
  request-splitting payloads are refused by construction rather than explored.
