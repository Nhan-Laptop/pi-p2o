# pi-p2o

`pi-p2o` is a Pi package for **authorized, scoped security assessments**: a deterministic assessment runtime
for Pi plus a 17-skill research method library. **The model proposes; deterministic code admits runs, enforces
scope and operational limits, accepts evidence and verifies findings.** Target pages, worker messages and model prose are
untrusted data — none of them grants permission or turns a hypothesis into a verified finding.

- **Extension** — one human command `/p2o`, 14 `p2o_*` agent tools, owned worker runtimes, a supervisor-only
  evidence vault, durable SQLite state, and an opt-in loopback read-only dashboard.
- **Skills** — 17 technique-oriented Agent Skills (see the [skill router](#skill-router)).

## Install

Install as a user package with `pi install /absolute/path/to/pi-p2o` (user settings), as a project package
with `pi install -l .` (`.pi/settings.json`), or from git with `pi install git:github.com/<owner>/pi-p2o`.

### One copy at a time

An installed copy and an explicit `-e` path are **two copies**: both register the same 14 `p2o_*` tools, Pi
reports one `Tool "p2o_*" conflicts with …` error per tool and exits `1` without running `/p2o`. Use exactly
one copy:

| You want | Invocation |
|---|---|
| the installed copy | `pi` (no `-e`) |
| this repository (development) | `pi --no-extensions -e /abs/path/to/pi-p2o` |

`--no-extensions` disables discovery of the installed copy while explicit `-e` paths still load. A relative
`-e .` is not enough once a copy is installed, and `pi -e .` **without** `-ne` is the fatal combination.

### Build the bundled runtime once per copy (managed workers)

A git/local install copies the **source tree only**: `pi install` runs `npm install --omit=dev
--legacy-peer-deps`, so the copy has neither `dist/` nor the TypeScript compiler. Managed workers need the
compiled guardian/receipt runtime and the pinned worker bridge, so after installing a copy that will run
`/p2o`:

```sh
cd /path/to/the/copy          # e.g. ~/.pi/agent/git/github.com/<owner>/pi-p2o
npm install --include=dev --no-audit --no-fund
npm run build
npm run check:runtime         # read-only doctor: worker pi, guardian/receipts, lock/seccomp/bridge
```

Without it `/p2o --target …` fails closed with **`BUNDLED_RUNTIME_MISSING`** listing every missing path —
before any consent dialog, and never as a raw `ENOENT` after you have consented. `pi update <source>` (or
`pi update --extensions`) reconciles a git checkout with `git clean -fdx` plus a production-only install, so
a previous build is removed: **rebuild after every upgrade**. The repository itself needs the same build
(`npm ci --no-audit --no-fund && npm run build`).

Host-only owner overrides for an already-built runtime: `P2O_PI_BINARY` pins the worker `pi` binary and
`P2O_RUNTIME_DIST` points at a built dist directory. Worker binary order is `P2O_PI_BINARY` →
`<copy>/node_modules/.bin/pi` → `pi` on `PATH` (resolved without a shell). They are never read from command
arguments or model output.

Requires **Node >= 24.19.0**, a configured Pi model provider, and the qualified local Docker pack for
container-backed execution. Both the extension host and pinned managed workers target Pi 1.0.0.
`pi --skill ./skills` loads only the method library.

## `/p2o` — the human entrypoint

```text
/p2o --target <local-dir|github-https-repo|http(s)-URL>
     [--purpose "..."] [--depth quick|standard|deep] [--plan-only]
     [--concurrency <N>] [--deadline <minutes>]
     [--profile conservative|wide|ceiling] [--basis <owner|written-permission|published-program|public-source-review>]
     [--repo-scripts] [--state-changes] [--full-rights] [--advanced]
/p2o status|stop|resume|report [runId]
/p2o approve <planId>
```

**A target is the only required input.** One consent dialog then shows the exact scope, authorization basis,
separate rights and the operational limits being consented to. Model usage is informational: ordinary runs
have **no application token/USD quota** and are bounded by the selected provider/model's own context/output
capability, with durable informational accounting of observed usage. Read/static is the default; repository scripts and state
changes stay OFF unless this invocation requests them, and they are always displayed in that dialog before you
approve it. `--full-rights` is the one-flag convenience for both separate rights on a target you own, never a
third kind of grant. `--advanced` asks every question separately instead.

Operational limits stay finite, visible and provider-independent:

| profile | model token/USD | deadline | requests / tool calls / attempts | concurrency |
|---|---|---|---|---|
| `wide` (default) | informational accounting; no application cap | 12 h | validated maximum requests/tool calls; **3 attempts** | 8 |
| `conservative` | explicit legacy cap: $5 / 100k tokens | 1 h | 20 / 20 / 2 | 1 |
| `ceiling` | explicit legacy cap: validated maximum | validated maximum | validated maximum | validated maximum |

`--concurrency` and `--deadline` set an individual operational value inside the same single dialog, so no
numeric prompt is ever required. `--budget` was removed: the ordinary path records observed usage and never
refuses a provider turn on a token/USD number. Saved legacy bounded consent remains bounded and is never
silently widened.

One target per run, parsed without a shell: no expansion, no globbing, no `eval`; unknown or duplicate flags,
out-of-range concurrency and ambiguous runs are refused with an explicit code. `--depth` only sets
planning/analysis intensity for the same target and scope: it never selects a different application mode, and
it is not a permission. The target is classified and **prepared and planned without any request to the
target and without spawning a worker**. Bare `/p2o` shows help and the current run.

- `--plan-only` sends **zero target requests**, but the planning step still asks the configured model author
  for one bounded plan — a provider call, and therefore possible provider cost, even in plan-only mode.
- You review the scope digest, action allowlist, informational model cost, concurrency, mode and plan, then confirm in a dialog.
  The confirmation mints the exact, digest-named owner approval artifact for that sealed proposal inside the
  owner window; a model tool, a JSON field or a replayed string can never do it.
- `--plan-only` prints `planId`; `/p2o approve <planId>` admits it once after a second review. Headless runs
  may still supply an owner-authored `plan-approval-<digest>.json` / `request-approval-<digest>.json` under
  `<approvalDirectory>`; entry never overwrites one and the owner ledger still verifies every binding.
- No `p2o_*` tool can approve a plan or reach the target workflow, and `stop` requires verified termination.
  A target list, a prepared plan, a dialog or an admitted run is **not** authorization.

### First run

Without saved owner scope, `/p2o --target …` asks for the target, authorization basis, permitted actions and
the operational deadline through Pi's UI; model usage is informational and provider-limited. Confirmed consent is saved privately under `~/.p2o/onboarding/`;
the bundled backend generates its run configuration. **No manual JSON or `P2O_*` variables are required.**
Advanced owner-controlled composition overrides remain available.

You explicitly select a supported assessment model, review its informational cost and the proposed plan, then
approve execution. Saved scope is reused for equal/narrower requests; expansions require renewed consent.
Local/GitHub source is copied into a bounded immutable snapshot. GitHub acquisition is followed by
approval of the resolved commit/tree; the actual snapshot is mounted read-only into the qualified container.
Repository scripts, hooks, dependency installation and builds do not run by default.

Reports distinguish observations, static findings and independently replayed findings. See
[operator usage](docs/USAGE.md), [qualification evidence](docs/first-use-qualification.md) and
[verification limits](docs/first-use-verification.md).

### Current limits

- Bundled first-use supports read/static assessment; script execution and state-changing tests remain unsupported.
- An installed copy must be built once (`npm install --include=dev && npm run build`). Otherwise `/p2o` refuses
  with `BUNDLED_RUNTIME_MISSING`, naming every missing path, before consent and without a raw `ENOENT`.
- Load either the installed copy or the repository copy, never both: two copies collide on the 14 `p2o_*` tools.
- Independent first-use replay currently covers bounded loopback read-only differentials, not arbitrary external exploits.
- `/p2o stop` cancels terminally. Cross-process source resume is not supported; stale sessions are refused.
- Browser/proxy/fuzz packs require explicit qualified composition; they are not automatically granted by first-use consent.
- Missing model pricing, supported gateway protocol or Docker qualification blocks execution rather than selecting a fallback.

The 14 `p2o_*` tools (`start`, `resume`, `preflight`, `doctor`, `status`, `stop`, `tasks`, `evidence`,
`events`, `report`, `dashboard`, `switch_model`, `subtask`, `plan`) are the agent surface, not the human one.
They take strict JSON and return projections capped at 48 KiB (pages at most 100 items); `p2o_start`/
`p2o_resume` require an owner-approved manifest and explicit `fixture|assessment` mode; `p2o_plan` cannot approve.

## Skill router

Pick the skill that answers the **current unresolved question**, not the whole library:
[Attack surface](skills/attack-surface-mapping/SKILL.md) · [Source auditing](skills/source-code-auditing/SKILL.md) ·
[Binary auditing](skills/binary-auditing/SKILL.md) · [Patch diffing](skills/patch-diff-analysis/SKILL.md) ·
[Data flow](skills/data-flow-analysis/SKILL.md) · [Dynamic analysis](skills/dynamic-analysis/SKILL.md) ·
[Fuzzing](skills/fuzzing/SKILL.md) · [Parser differentials](skills/parser-differential-auditing/SKILL.md) ·
[State/lifetime](skills/state-and-lifetime-auditing/SKILL.md) · [Race auditing](skills/race-condition-auditing/SKILL.md) ·
[Memory safety](skills/memory-safety-auditing/SKILL.md) · [Authorization](skills/authorization-auditing/SKILL.md) ·
[Deserialization/dispatch](skills/deserialization-and-dispatch-auditing/SKILL.md) · [Compiler invariants](skills/compiler-invariant-auditing/SKILL.md) ·
[Sandbox boundaries](skills/sandbox-boundary-analysis/SKILL.md) · [Exploitability assessment](skills/exploitability-assessment/SKILL.md) · [Remediation](skills/remediation/SKILL.md).

## Start here

Skills are composed, not run as a fixed pipeline: a task maps to one bounded `(question, surface, actor, input
revision)`, and one worker may load several skills. Establish explicit authorization, target/version, actors,
intended boundary and an isolated, recovery-capable environment; treat source pages and target artifacts as
untrusted data, keep facts/hypotheses/inferences separate, and budget each question. Carry failed assumptions
and untested scope forward; an emulated result is not unmodified-target proof, and a passed preflight is not permission.

## Development

```sh
pi --no-extensions -e "$PWD"   # load exactly this repo copy (single-copy dev invocation)
npm run check:runtime           # doctor: worker pi + guardian/receipt + lock/seccomp/bridge readiness
npm run typecheck               # strict TypeScript over src/, extensions/, tests/
npm run build                   # dist/ (JS + .d.ts), then check:build imports every entry point
npm run test:command            # /p2o grammar, dispatch, approval and lifecycle tests
npm run test:packaging          # installed-layout gate, worker-pi precedence and real CLI /p2o dispatch
npm test                        # fail-fast aggregate: typecheck → build → suites → editorial checks
```

`test:runtime` runs the real pinned `pi` binary against an in-process inert provider; `test:sandbox` runs the
live Docker qualification. Standard tests make **no external target requests and no model/provider calls**;
see [docs/USAGE.md](docs/USAGE.md) and [interface contracts](docs/architecture/interface.md).

## Offline quality checks

`npm run check:render` / `check:orange` / `check:library` / `check:python` validate format, required fields,
links/anchors, source/skill consistency and evidence coverage; they do **not** establish software
vulnerability, hostile-code isolation or live-target behavior. Provenance: [catalog](research/catalog.md) ·
[evidence ledger](research/evidence.md) · [audit](research/AUDIT.md) · [taxonomy](research/TAXONOMY.md).

UNLICENSED (private). See [package.json](package.json).
