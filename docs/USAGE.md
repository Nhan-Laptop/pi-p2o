# pi-p2o operator usage

Use one command, `/p2o`. See [README](../README.md) for installation and skills.

## Prerequisites

- Node >=24.19.0, project dependencies installed, and `npm run build` completed. A **git/local install is a copy
  of the source tree**: build it in place once (`npm install --include=dev && npm run build`) and check it with
  `npm run check:runtime`; `pi update <source>` removes that build again, so rebuild after every upgrade.
- A configured Pi provider with a supported gateway protocol and a pinned price quote.
- The qualified local Docker image for container-backed execution. Assessment never pulls or re-pins it automatically.
- An interactive Pi UI or a human-operated RPC UI for initial consent and plan approval.

Load exactly one copy at a time: the installed package (`pi`) or this repository
(`pi --no-extensions -e /abs/path/to/pi-p2o`). Loading both registers the 15 `p2o_*` tools twice; Pi reports
tool conflicts and exits `1` before `/p2o` runs. Host-only owner overrides for the bundled runtime are
`P2O_PI_BINARY` (worker `pi` binary) and `P2O_RUNTIME_DIST` (built dist directory); worker binary order is
`P2O_PI_BINARY` → package `node_modules/.bin/pi` → `pi` on `PATH`.

The supported baseline is Pi 1.0.0 for both host and managed worker. Availability of a model in Pi does not prove its gateway protocol or pricing is supported here.

## Human entrypoint `/p2o`

```text
/p2o --target ./project
/p2o --target https://github.com/owner/repo
/p2o --target https://authorized.example
/p2o --target ./project --purpose "Review authorization" --depth deep
/p2o --target ./project --headless --profile ceiling --full-rights   # widest validated caps, both separate rights
/p2o --target https://authorized.example --plan-only
  /p2o --target ./project --advanced                    # ask every question separately
/p2o approve <planId>
/p2o status|stop|resume|report [runId]
```

Arguments are parsed without a shell. `--depth quick|standard|deep` changes analysis intensity, never permissions. A run ID is optional only when the session has an unambiguous current run.

### First-use consent

With no saved scope, **one** consent dialog shows the exact target/scope, authorization basis (with your attestation text), separate rights and the operational limits being consented to. Model usage is informational: **no application token/USD quota is asked for or enforced**, and completions are bounded by the selected provider/model's own context/output limits plus durable, informational usage accounting. `--concurrency`, `--deadline`, `--profile`, `--basis` and `--full-rights` set those values inside that same dialog, so no numeric prompt is required. `--profile conservative|ceiling` is an explicit opt-in to the legacy bounded policy; `--budget` was removed from the ordinary UX. `--advanced` restores the full guided questionnaire. Saved consent is owner-only under `~/.p2o/onboarding/` and is reused with **zero** dialogs when it already covers the request; a wider request always re-asks the human and is labelled as a renewal/expansion. The bundled backend generates the application/run documents, so **you do not need to edit JSON or set `P2O_APP_CONFIG`/`P2O_CONTROL_MODULE`.**

Public-source-review consent permits only reading/cloning and static analysis of public source. It does not authorize testing the GitHub service, executing repository scripts, or state-changing actions. Repository execution and mutation require separate rights and remain unsupported by bundled first-use even if requested.

An equal or narrower request reuses saved scope. Expanding the target, rights, concurrency or authorization window requires renewed consent; a legacy bounded consent is never silently widened into informational mode. Your authorization statement is recorded, not independently verified ownership.

### Current Pi foreground workspace

Interactive TUI is foreground by default. The command collects scope consent, prepares offline planning facts,
then asks for separate native-session model/context consent before releasing an orchestration prompt into the
**same Pi conversation** (a cold-start refusal therefore costs no native-session dialog). The visible agent calls `p2o_orchestrate` to read facts and seal its draft; it
does not make a hidden planning completion. You review `/p2o approve <planId>` to dispatch the exact plan.
After approval the agent coordinates sandboxed workers here, with a live widget and qualified reporting.
Use the editor to steer within the approved scope; new scope/actions require new human review.

`p2o_orchestrate watch` waits for meaningful durable changes (or a bounded timeout) without a model
busy-poll loop. Host shell/file/other-extension tools are blocked, including nested/codemode calls.
`finish` requires observed terminal state and no unresolved ownership; it returns the trusted qualified
report, not a model-invented verification. The original tool set is restored after final settlement.
Abort, model/thinking changes, branch/session changes and shutdown cancel or clean up the owned work;
unverified termination remains a blocker. No replayed session entry activates orchestration.

Native usage is recorded in Pi entries and, for bundled runs, `control/foreground-usage.json`; reports
show it separately from worker gateway accounting. Native turns cannot enforce that gateway's financial
phase caps, so bounded/legacy consent must use `--headless` (otherwise `FOREGROUND_BOUNDED_UNSUPPORTED`).

`--headless` preserves the previous nested planner/background flow. RPC keeps that flow by default;
`--foreground` opts an RPC client with human UI into native-session orchestration (no terminal widget).
No-UI/print clients still cannot confirm/launch, and no missing bridge silently falls back to headless.

### Planning and execution

1. Explicitly choose a supported assessment model and review cost/readiness. Unsupported or unpriced selections fail; no model is substituted silently.
2. The model proposes bounded work inside the approved envelope. Planning makes zero target requests and launches no assessment worker, but the provider call can cost money even with `--plan-only`.
3. Review and approve the sealed plan. Human confirmation issues a single-use controller capability for its exact digest; no model tool can self-approve.
4. The supervisor admits workers, enforces deadlines/budgets, collects evidence, and generates the qualified report.
5. Where a supported replay recipe exists, a separate verifier attempt checks it. Observations and static inferences are not automatically promoted to verified vulnerabilities.

`--plan-only` retains the plan without target execution; `/p2o approve <planId>` reviews and admits it later.

### Source identity

Local source is exported to a bounded immutable snapshot after acquisition permission. GitHub uses a hardened clone without hooks, submodules, credential helpers, installation or repository scripts. You then approve the actual full commit and filtered tree identity before execution.

The approved snapshot—not the mutable original checkout—is mounted read-only at `/inputs` in the qualified container. Broker receipts, source digests and evidence configuration describe that same input. A changed commit/tree or unverifiable binding is refused.

### Stop and resume

`/p2o stop` cancels foreground preparation before admission without claiming runtime termination. For an admitted run it is terminal cancellation and requires verified resource termination. A stopped/completed run cannot be resumed; `RUN_TERMINAL` is expected.

Supported runtime checkpoint/replacement paths create new attempt/session identities and reject stale handles. **Fresh-controller source restoration is not implemented**; restart cannot silently re-clone HEAD or bless a serialized snapshot. Re-prepare and approve a new run where restoration cannot be proved.

## Owner approval documents and the planning author

The controller writes digest-bound approval artifacts only after human confirmation, with owner-only permissions and an expiry bounded by the saved authorization. These are internal records, not files a normal user must author.

Generated run data lives under `~/.p2o/runs/assessment-<id>/`: application/run manifests, planning-spend records, approvals, immutable source identity, durable store, vault, worker workspaces and report artifacts. Credentials must not appear in these documents.

## Operator composition (advanced override)

Existing operators may still supply `P2O_APP_CONFIG`, `P2O_CONTROL_MODULE` or `P2O_PLAN_AUTHOR_MODULE`. These are optional overrides, not first-use prerequisites. Modules/documents must remain canonical, owner-controlled and validated; an invalid override fails rather than falling back to broader authority.

See [application composition](architecture/application.md) for the low-level contracts; the bundled default and
the optional pre-authored override are documented there.

## Current support limits

- Bundled first-use: read-only HTTP observations and static source analysis.
- Independent first-use replay: bounded literal-loopback read-only differentials with approved baseline, negative control and reproduction; no generic external exploitation verifier.
- Source findings remain static; scanning source does not prove exploitability.
- Browser/proxy/fuzz packs require explicit qualified composition. First-use does not automatically grant these packs.
- No VM runtime or hostile-code isolation claim. Containers share the host kernel; trusted-local differential modules are not a sandbox for hostile code.
- A model can fail to produce an admissible plan/packet. That is a failed or incomplete run, not a clean security result.

## Validation

```sh
npm run check:runtime         # read-only doctor: worker pi + guardian/receipt + lock/seccomp/bridge
npm run test:packaging        # installed-layout gate, worker-pi precedence, real Pi CLI /p2o dispatch
npm run check:first-use       # onboarding + source/container + lifecycle + first-use + verifier suites
npm run check:upgrade         # existing aggregate and tool-pack integration suites
npm run qualify:first-use     # installed Pi host, real command/backend/processes; inert model by default
```

The qualification harness explicitly separates automated RPC consent, mechanical inert-model evidence, live provider runs and public GitHub acquisition. Live provider qualification is opt-in and costs money. Read [qualification results](first-use-qualification.md) and [verification support](first-use-verification.md) before interpreting a passing test.

## Troubleshooting

| Failure | Meaning |
|---|---|
| `BUNDLED_RUNTIME_MISSING` | The bundled runtime is incomplete (worker `pi`, `dist/src/runtime/guardian.js`, `dist/src/runtime/pi-receipts.js`, or the pinned lock/seccomp/bridge). The message lists every missing path and the fix; it is raised before any consent dialog, never as a raw `ENOENT`. Build the copy (`npm install --include=dev && npm run build`, then `npm run check:runtime`) or set `P2O_PI_BINARY`/`P2O_RUNTIME_DIST`. Nothing was consented, planned or launched. |
| `Tool "p2o_*" conflicts with …` / exit 1 | Two copies of this package are loaded (installed copy plus an explicit `-e`). Use `pi` alone or `pi --no-extensions -e <abs repo>`; never both. |
| Unsupported model/pricing/protocol | Select a qualified model; availability in the host alone is insufficient. |
| `ENTRY_SOURCE_UNBOUND` / source digest mismatch | The approved source identity cannot be bound or restored; execution is refused. |
| `STOP_UNVERIFIED` / unresolved resource inventory | Cleanup is not proven. Inspect status/events; do not assume the worker or pack stopped. |
| `FOREGROUND_BOUNDED_UNSUPPORTED` | Native Pi cannot enforce gateway financial caps. Use `--headless` for existing bounded consent; do not silently widen it. |
| `FOREGROUND_INTEGRATION_REQUIRED` | An advanced composition lacks the offline proposal-only bridge; execution does not fall back silently. |
| `ORCHESTRATION_ACTIVE` | Finish or stop the current foreground workspace before starting another target. |
| `RUN_TERMINAL` | Stop/completion is terminal; create a new approved run instead of reusing stale sessions. |

[Container qualification](../containers/QUALIFICATION.md) · [Target entry](architecture/target-entry.md) · [Handoff contracts](../HANDOFFS.md)
