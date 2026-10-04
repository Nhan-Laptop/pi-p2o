# pi-p2o

`pi-p2o` is a Pi package for **authorized, scoped security assessments**: a deterministic assessment runtime
for Pi plus a 17-skill research method library. **The model proposes; deterministic code admits runs, enforces
scope and budgets, accepts evidence and verifies findings.** Target pages, worker messages and model prose are
untrusted data — none of them grants permission or turns a hypothesis into a verified finding.

- **Extension** — one human command `/p2o`, 14 `p2o_*` agent tools, owned worker runtimes, a supervisor-only
  evidence vault, durable SQLite state, and an opt-in loopback read-only dashboard.
- **Skills** — 17 technique-oriented Agent Skills (see the [skill router](#skill-router)).

## Install

Install with `pi install /absolute/path/to/pi-p2o` (user settings), `pi install -l .` (project settings in
`.pi/settings.json`) or `pi -e .` (temporary, from the repo root).

From a source checkout: `npm ci --no-audit --no-fund`, then `npm run build` (required for managed workers).
Requires **Node >= 24.19.0**, a configured Pi model provider, and the qualified local Docker pack for
container-backed execution. Both the extension host and pinned managed workers target Pi 1.0.0.
`pi --skill ./skills` loads only the method library.

## `/p2o` — the human entrypoint

```text
/p2o --target <local-dir|github-https-repo|http(s)-URL>
     [--purpose "..."] [--depth quick|standard|deep] [--plan-only]
     [--budget <USD>] [--concurrency <N>]
/p2o status|stop|resume|report [runId]
/p2o approve <planId>
```

One target per run, parsed without a shell: no expansion, no globbing, no `eval`; unknown or duplicate flags,
out-of-range budgets/concurrency and ambiguous runs are refused with an explicit code. `--depth` only sets
planning/analysis intensity for the same target and scope: it never selects a different application mode, and
it is not a permission. The target is classified and **prepared and planned without any request to the
target and without spawning a worker**. Bare `/p2o` shows help and the current run.

- `--plan-only` sends **zero target requests**, but the planning step still asks the configured model author
  for one bounded plan — a provider call, and therefore possible provider cost, even in plan-only mode.
- You review the scope digest, action allowlist, spend, concurrency, mode and plan, then confirm in a dialog.
  The confirmation mints the exact, digest-named owner approval artifact for that sealed proposal inside the
  owner window; a model tool, a JSON field or a replayed string can never do it.
- `--plan-only` prints `planId`; `/p2o approve <planId>` admits it once after a second review. Headless runs
  may still supply an owner-authored `plan-approval-<digest>.json` / `request-approval-<digest>.json` under
  `<approvalDirectory>`; entry never overwrites one and the owner ledger still verifies every binding.
- No `p2o_*` tool can approve a plan or reach the target workflow, and `stop` requires verified termination.
  A target list, a prepared plan, a dialog or an admitted run is **not** authorization.

### First run

Without saved owner scope, `/p2o --target …` asks for the target, authorization basis, permitted actions,
budget and deadline through Pi's UI. Confirmed consent is saved privately under `~/.p2o/onboarding/`;
the bundled backend generates its run configuration. **No manual JSON or `P2O_*` variables are required.**
Advanced owner-controlled composition overrides remain available.

You explicitly select a supported, priced assessment model, review its cost and the proposed plan, then
approve execution. Saved scope is reused for equal/narrower requests; expansions require renewed consent.
Local/GitHub source is copied into a bounded immutable snapshot. GitHub acquisition is followed by
approval of the resolved commit/tree; the actual snapshot is mounted read-only into the qualified container.
Repository scripts, hooks, dependency installation and builds do not run by default.

Reports distinguish observations, static findings and independently replayed findings. See
[operator usage](docs/USAGE.md), [qualification evidence](docs/first-use-qualification.md) and
[verification limits](docs/first-use-verification.md).

### Current limits

- Bundled first-use supports read/static assessment; script execution and state-changing tests remain unsupported.
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
npm run typecheck       # strict TypeScript over src/, extensions/, tests/
npm run build           # dist/ (JS + .d.ts), then check:build imports every entry point
npm run test:command    # /p2o grammar, dispatch, approval and lifecycle tests
npm test                # fail-fast aggregate: typecheck → build → suites → editorial checks
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
