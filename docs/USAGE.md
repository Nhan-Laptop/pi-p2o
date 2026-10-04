# pi-p2o operator usage

Use one command, `/p2o`. See [README](../README.md) for installation and skills.

## Prerequisites

- Node >=24.19.0, project dependencies installed, and `npm run build` completed.
- A configured Pi provider with a supported gateway protocol and a pinned price quote.
- The qualified local Docker image for container-backed execution. Assessment never pulls or re-pins it automatically.
- An interactive Pi UI or a human-operated RPC UI for initial consent and plan approval.

Qualification records the installed Pi 1.0.0 host and the pinned Pi 0.85.1 worker separately. Availability of a model in Pi does not prove its gateway protocol or pricing is supported here.

## Human entrypoint `/p2o`

```text
/p2o --target ./project
/p2o --target https://github.com/owner/repo
/p2o --target https://authorized.example
/p2o --target ./project --purpose "Review authorization" --depth deep --budget 1
/p2o --target https://authorized.example --plan-only
/p2o approve <planId>
/p2o status|stop|resume|report [runId]
```

Arguments are parsed without a shell. `--depth quick|standard|deep` changes analysis intensity, never permissions. A run ID is optional only when the session has an unambiguous current run.

### First-use consent

With no saved scope, Pi asks for the target, authorization basis, permitted actions, budgets, deadline and concurrency. You confirm these before planning. Saved consent is owner-only under `~/.p2o/onboarding/`; the bundled backend generates the application/run documents. **You do not need to edit JSON or set `P2O_APP_CONFIG`/`P2O_CONTROL_MODULE`.**

Public-source-review consent permits only reading/cloning and static analysis of public source. It does not authorize testing the GitHub service, executing repository scripts, or state-changing actions. Repository execution and mutation require separate rights and remain unsupported by bundled first-use even if requested.

An equal or narrower request reuses saved scope. Expanding the target, rights, budget, concurrency or authorization window requires renewed consent. Your authorization statement is recorded, not independently verified ownership.

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

`/p2o stop` is terminal cancellation and requires verified resource termination. A stopped/completed run cannot be resumed; `RUN_TERMINAL` is expected.

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
npm run check:first-use       # onboarding + source/container + lifecycle + first-use + verifier suites
npm run check:upgrade         # existing aggregate and tool-pack integration suites
npm run qualify:first-use    # installed Pi host, real command/backend/processes; inert model by default
```

The qualification harness explicitly separates automated RPC consent, mechanical inert-model evidence, live provider runs and public GitHub acquisition. Live provider qualification is opt-in and costs money. Read [qualification results](first-use-qualification.md) and [verification support](first-use-verification.md) before interpreting a passing test.

## Troubleshooting

| Failure | Meaning |
|---|---|
| `ONBOARDING_UI_UNSUPPORTED` | Initial consent needs a supported interactive UI; no setup/execution was authorized. |
| Unsupported model/pricing/protocol | Select a qualified model; availability in the host alone is insufficient. |
| `ENTRY_SOURCE_UNBOUND` / source digest mismatch | The approved source identity cannot be bound or restored; execution is refused. |
| `STOP_UNVERIFIED` / unresolved resource inventory | Cleanup is not proven. Inspect status/events; do not assume the worker or pack stopped. |
| `RUN_TERMINAL` | Stop/completion is terminal; create a new approved run instead of reusing stale sessions. |

[Container qualification](../containers/QUALIFICATION.md) · [Target entry](architecture/target-entry.md) · [Handoff contracts](../HANDOFFS.md)
