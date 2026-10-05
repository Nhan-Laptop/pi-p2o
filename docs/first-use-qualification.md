# Independent first-use qualification

## Autonomous integration checks

`npm run check:autonomous` passes the current first-use, model-budget, physical checkpoint,
two-process default-command recovery, pack-readiness and phase-accounting suites. These use
inert loopback models and automated consent, not paid assessments or public-target testing.

Verified behavior includes per-claim receipt selection, post-admission independent replay,
protected verifier spending, original-source recovery without replanning or budget reset,
and refusal to remove a live controller's evidence-writer lock.

Limits remain explicit:

- The finite worker turn allowance is not renewed on restart. Mid-program interruption may
  exhaust it; the recovery test proves refusal without borrowing or resetting spend.
- Restart after producer acceptance/deferred-verifier activity remains blocked rather than
  silently losing dynamic findings. URL recovery is not established by source-run tests.
- First-use browser/proxy/fuzz mixed-boundary execution is still unsupported; pack readiness
  tests do not establish that default-command workflow.
- The latest full `check:upgrade` run failed at Chrome/proxy startup; the focused proxy rerun
  passed. This is not a clean full-regression result.
- Live assessment qualification still requires explicit model and total-budget approval.

## Bundled-runtime packaging gate

A git/local `pi install` copy is a source checkout: it has no `dist/` and no `node_modules/`, and Pi installs
it with `npm install --omit=dev --legacy-peer-deps`, so a `prepare`-style build cannot run during install.
The human `/p2o` path previously resolved `node_modules/.bin/pi` and
`dist/src/runtime/{guardian,pi-receipts}.js` directly and died with a raw `ENOENT` **after** the owner had
already consented (F2), while the README-documented `pi -e .` produced 14 `p2o_*` tool conflicts and exit 1
when the same package was also installed (F1).

The bundled runtime is now resolved and checked **before any consent dialog and before any provider or plan
work**:

- The check fails closed with `BUNDLED_RUNTIME_MISSING` and lists **every** missing path
  (`examples/local-assessment/bridge-extension.js`, `containers/pack.lock.json`, `containers/seccomp.json`,
  `dist/src/runtime/guardian.js`, `dist/src/runtime/pi-receipts.js`, and the worker binary when no tier
  resolves). No raw `ENOENT` reaches the user, and nothing is consented, planned or launched.
- Worker `pi` binary order: `P2O_PI_BINARY` → `<copy>/node_modules/.bin/pi` → `pi` on `PATH` (no shell).
  An explicit but unusable override is refused rather than silently replaced.
- Guardian/receipt dist order: `<copy>/dist/src/runtime/` → `P2O_RUNTIME_DIST` override → named refusal.
- The same paths feed `runtime.piBinary`, `runtimePaths` and the bridge policy in `prepare()` and restart, so
  no path is joined ad hoc and no later `realpathSync` can raise `ENOENT`.
- A git/local copy is documented as needing one explicit build (`npm install --include=dev && npm run
  build`), verified by the read-only `npm run check:runtime` doctor; `pi update` removes that build and the
  docs say to rebuild. `dist/` stays git-ignored.

Regression coverage: `npm run test:packaging` (2026-10-05 run on this tree: 3 files, 17 passed, 1 skipped, exit 0). It
asserts a simulated installed layout (shipped tree copied without `dist/`/`node_modules/`) refuses with the
named code and zero consent dialogs, each worker-binary precedence tier, dist resolution order, and that a
real `pi --no-extensions -e <abs copy>` process loads exactly one extension copy, dispatches `/p2o`, and
makes no model call (no provider is configured) and no target request.

The separate installed-host qualification harness below has not been requalified by these checks.

```sh
node --test tests/qualification-first-use/harness.test.mjs
node tests/qualification-first-use/run.mjs --github
# Single case: --case decline-onboarding|decline-plan|url|local|github|stop-stale-reuse (alias stop-resume)
# Keep receipts in a NEW directory: --artifacts /tmp/p2o-qualification-NEW
node tests/qualification-first-use/run.mjs --require-live
# Parent-authorized live model runs (opt-in, bounded; one run per target):
#   node tests/qualification-first-use/run.mjs --live --live-preflight --case url     # $0 wiring check
#   node tests/qualification-first-use/run.mjs --live --case local
#   node tests/qualification-first-use/run.mjs --live --case github --github
```

The runner uses the **installed Pi extension host in RPC mode**, real `registerP2O(pi)`
and the default backend. It does not replace the backend, entry port, runtime, model
registry, Git, Docker or filesystem. Each case starts with an empty HOME/Pi config
root and an environment allowlist: no inherited `P2O_CONFIG*`, application/control
module, credentials or preseeded application JSON. Runtime-created worker config
is expected, not a bootstrap bypass. Dependencies/image/build must already exist;
the runner does not install, pull, build or repin them.

**Consent is automated human-consent simulation:** the driver answers actual
`extension_ui_request` records, records every prompt/response, and cancels unknown
prompts. Repository scripts/state changes stay denied. This is not a human-operated
TUI qualification. **The provider is deterministic and inert, not live AI.** Its
loopback transport scripts planning/tool turns; usage counters and the existing
fixture price quote are explicitly synthetic. The invoking implementation session's
selection is read from its own env (`PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL`) and kept separate;
from the inert assessment selection; the actual assessed host/worker models are
never taken from it but from receipts (versions, hostState, worker config, planning receipts, worker sessions).

Cases cover onboarding/plan refusal; URL plan-only then approval against one owned
loopback `/exact`; local immutable source approval, real worker/broker/collector
and pinned Docker; and stop safety (the negative stale-reuse case asserts terminal
cancellation and a refused resume). `--github` separately
opts into real HTTPS GitHub acquisition, **without a transport rewrite**, only for
public `octocat/Hello-World`. The commit pin is an **owner-authorization input,** not a
harness constant to repin: the run records *repository-access* consent (the onboarding
authorization-basis selection and saved scope receipt) separately from the *exact
immutable commit* approval (the `Approve immutable source for the exact model plan?`
confirm, whose body carries `Commit: <sha>`). A resolved commit that differs from the
authorized pin is declined, not repinned, and no worker/container is dispatched. The
per-case `result.json` `approvals` block records both dialogs, the offered commit and
the authorized pin. No push, issue creation, repository execution or network scanning.

An additional Docker canary uses the **actual generated snapshot mount**, verifies
SHA-256/readback and uid 65532 write denial, and checks survival of deliberate
harness-only original-tree drift. It is labeled separately from the production
broker invocation. Inotify detects local source OPEN/ACCESS/writes, **not stat()
or complete network telemetry**. Kernel PID/start/boot identities, exact container
IDs/mounts, source/commit hashes, approval/lifecycle receipts, worker/provider/version
observations, packet admission, findings classification and reports are retained.
The current host and repository worker both target **Pi 1.0.0**. Older qualification artifacts below used a 0.85.1 worker and are historical, not evidence for the new worker pin.
Assertions track the **current** production contract, not an older projection:
packet admission reads the supervisor's own `packets[].decision.status === 'accepted'`
bound by `attemptId` to an observed attempt, worker runtime attestation reads the
`process.attempts[].observedRuntime` projection (not a top-level `attempts` field), and
the qualified report must reproduce the worker-declared limitation text verbatim rather
than match a keyword. The local case passes its harness-owned source directory as the
canonical absolute `--target`. These are fixture/reader corrections; no validator,
backend, entry port or runtime is relaxed.

Current qualification results (artifact roots under `/tmp` are session-local scratch and are not shipped;
re-run the harness to regenerate them):

- **GitHub passes.** The owner-authorized pin was corrected to the verified upstream commit
  `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`; the mechanical `github` case now passes end to end (hardened
  read-only clone, exact-commit approval confirmed, source readback authenticated). The superseded hash that
  does not exist upstream is retained **only** as the negative mismatch test, and production never auto-repins.
- **Stop is terminal and passes as a negative test.** `/p2o stop` cancels; the case is `stop-stale-reuse` and
  asserts `RUN_TERMINAL` on resume with no new attempt, exchange or worker and zero stale resources. No
  resumable-stop capability is claimed. `stop-resume` remains a CLI alias.
- **Mechanical suite: 6/6 PASS, exit 0 on the final frozen tree**, captured at
  `/tmp/p2o-qualification-final/summary.json` with matching start/end source hashes.
  The older pre-fix capture at `/tmp/p2o-qualification-current` is not the final qualification record.

Exit 1 means an exact failed stage is in `summary.json` and
`/tmp/p2o-qualification-blockers.md`; no mock success replaces it. A successful
mechanical case does **not** prove independent exploit replay: packet/evidence gates
and the independent verifier are reported separately. Stop/completion cleanup must
be observed, not inferred from an empty map or controller exit. Cleanup is limited
to spawned children/exact owned canary IDs; never `pkill` or foreign prefix cleanup.
`/tmp/p2o-qualification-handoff.md` records the actual command, exit and artifact root.

`--require-live` is a **NO-CALL readiness refusal**, not permission to spend. Live mode
(`--live --case url|local|github [--github]`) is opt-in and parent-authorized with an aggregate cap of
US$1 / 400k tokens, one run per target plus one corrective retry total. It selects
`deepseek/deepseek-flash` at thinking `max` in the real UI, reads the installed model credential in memory,
never prints or persists it (host-persisted copies are scrubbed and residue-checked), and fails closed instead
of substituting a model or downgrading thinking. `--live --live-preflight` is a $0 wiring check that aborts at
the thinking dialog with no provider call. The mechanical suite never makes a paid call.

## Live DeepSeek/max status (frozen tree, 2026-10-03)

Per-run cap **US$0.32 / 130k tokens**, aggregate US$1 / 400k, one run per target plus one corrective retry; an
explicit owner grant authorized one post-refreeze URL retry without resetting the budget history. The cap, its
planning quarter and the worker remainder must all be two-decimal (production validates owner USD limits that
way), so the runner fails fast (`LIVE_LIMIT_SHAPE_INVALID`) rather than spending on an unrepresentable shape.
Every attempt is archived in its own `<target>-attempt<N>` folder and an existing `--artifacts` root is reused
so the aggregate ledger spans the whole qualification.

| attempt | result | evidence |
|---|---|---|
| url 1 | blocked — **harness defect** (fixed) | Cap `$0.30` produced planning `0.075` / remainder `0.225`, refused by the two-decimal USD validation. Real planning call made and counted. |
| url 2 | blocked — **production bound mismatch** (since fixed and verified) | Interface rejected a correct live plan for 160-char steps vs the 300-char authoring bound. |
| url 3 — post-refreeze retry (owner grant) | blocked — **model/provider-class budget refusal** | Plan **approved**; the live worker ran and made a **real broker observation** (`GET /exact` → 200, evidence id, exactly 1 target request); the live model wrote a 6,758-byte `handoff.packet.json`. The 4th provider turn was then **denied before dispatch** by the credential-owning gateway: `403 GATEWAY_BUDGET_DENIED [BUDGET_EXCEEDED]: Model token budget cannot cover the next provider turn's worst case`. |

Exact numbers from the durable gateway attestation: charged turns 1,040+39, 1,897+372 and **2,617+25,425**
(the packet turn spent 23,581 reasoning tokens) = **31,390 tokens / 32,672 µUSD charged against limits 97,500
tokens / $0.24**; the packet turn's 25,425 output tokens against the production per-turn bound
`spend.maxOutputTokens: 4096` produced a tracked overshoot of **14,110 tokens / 23,429 µUSD**, after which the
next turn's worst case could not be covered and the gateway failed closed. No accepted packet, no report, no
findings, no verification claim: the run ended `failed` with `packets: []`.

Live spend, all failed attempts included: **US$0.0367881 / 33,851 tokens** (prior US$0.0028356 / 3302 plus
US$0.0339525 / 30,549), well inside the US$1 / 400k aggregate; ledger `attempts {url: 3}`, `corrections 1`, the
URL grant consumed once and marked used. Freeze integrity: **zero source drift** across
`src`/`extensions`/`containers`. **0 credential-residue files** across the live artifact root. Cleanup verified:
host exit 0, 0 surviving workers, every owned container `absent: true`, no p2o containers left in Docker.

`local` and `github` live attempts were **not** started: the refusal is a model/provider-class condition
(deepseek-flash/max burns far more reasoning tokens per turn than the configured per-turn bound expects) that
will recur on the same worker chain, and the parent directed stopping rather than looping. Both authorized
attempts remain unused. Independent verification remains **not** claimed — a live model call and a real broker
observation are not exploit replay.
