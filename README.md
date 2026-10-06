# pi-p2o

One command. Your **current Pi agent** investigates an authorized target directly using sandbox tools.
No separate orchestrator, AI workers, manifests, profiles, plan IDs, model-selection wizard or dashboard.

## Install

```sh
pi install https://github.com/Nhan-Laptop/pi-p2o
```

Requires Pi 1.0.0, a configured model, and a running local Linux Docker daemon. Install the sandbox tools image once:

```sh
docker pull ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331
```

No extension build or JSON configuration is needed. Use `/reload` after installing/updating. Load only one copy:
`pi` for the installed package, or `pi --no-extensions -e "$PWD"` for development.

## Use

```text
/p2o --target ./my-repo
/p2o --target "./directory with spaces"
/p2o --target https://example.com
/p2o stop
```

Confirm scope and permission once. The command prepares a sandbox and sends the task directly into the
**existing conversation**, using the existing model. The agent explains its plan, investigates, shows progress
through ordinary Pi tool calls, and writes its report here. Normal provider charges apply.

Only three tools:
- **p2o_shell** — offline shell in an unprivileged Docker container; directory target at `/target` (read-only), scratch at `/work`.
- **p2o_http** — fixed curl in a disposable container, GET/HEAD on the authorized origin only; public IPv4, pinned DNS, no redirects.
- **p2o_finish** — verify sandbox removal, then let the agent write the final report.

Host tools and other extensions' tools are blocked while an assessment is active. `/p2o stop` removes the
sandboxes and restores the previous tool set. Abort, session navigation, shutdown and a 30-minute timeout
also clean up. If cleanup cannot be verified, the gate stays closed: fix Docker and retry `/p2o stop`.
Nothing is restarted from session history.

## Limits

This is an intentionally small, **breaking replacement** for the previous supervisor architecture:
- Local directories or HTTP(S) URLs only. A GitHub URL is a web target, not a repository clone; clone a repo yourself and select its directory for source review.
- URL scope is the exact origin (scheme, host, port), not just the initial path. No login, custom headers, credentials, POST, redirects, private/loopback targets or IPv6 in this version.
- The offline shell has no network. Arbitrary network scanners/browser automation are not provided.
- Source is copied before mounting: regular files only, up to 64 MiB / 20000 entries; symlinks, special files, `.git` and `node_modules` are skipped. This is a copied view, not a Git/atomic snapshot. Select a specific source folder, not `/`, your home or a secrets directory. Files read may reach your model provider.
- Docker shares the host kernel; this is **not VM-grade isolation** or a claim that hostile code cannot escape a vulnerable kernel/runtime. The networking container runs only fixed curl, never agent shell commands.
- Temporary scratch is deleted at finish/stop. The report remains in the Pi transcript. No independent evidence verifier, durable worker state, resume engine or financial gateway remains.
- Findings are agent assessments, not independently verified results. Untested coverage and uncertainty must be reported.
- Hard-killing Pi or losing Docker can leave a container behind. See [usage and cleanup](docs/USAGE.md).

## Start here

Use only targets you own or are explicitly permitted to assess. Treat target content as untrusted data.
Keep observations, hypotheses and impact claims separate; prefer harmless, bounded experiments and stop
before destructive actions, credential harvesting, persistence or scope expansion.

The research-method library remains available independently of the extension. See [handoff contracts](HANDOFFS.md),
[skill router](#skill-router), [catalog](research/catalog.md) and [evidence](research/evidence.md).

## Skill router

[Attack surface](skills/attack-surface-mapping/SKILL.md) · [Source auditing](skills/source-code-auditing/SKILL.md) ·
[Binary auditing](skills/binary-auditing/SKILL.md) · [Patch diffing](skills/patch-diff-analysis/SKILL.md) ·
[Data flow](skills/data-flow-analysis/SKILL.md) · [Dynamic analysis](skills/dynamic-analysis/SKILL.md) ·
[Fuzzing](skills/fuzzing/SKILL.md) · [Parser differentials](skills/parser-differential-auditing/SKILL.md) ·
[State/lifetime](skills/state-and-lifetime-auditing/SKILL.md) · [Races](skills/race-condition-auditing/SKILL.md) ·
[Memory safety](skills/memory-safety-auditing/SKILL.md) · [Authorization](skills/authorization-auditing/SKILL.md) ·
[Deserialization](skills/deserialization-and-dispatch-auditing/SKILL.md) · [Compiler invariants](skills/compiler-invariant-auditing/SKILL.md) ·
[Sandbox boundaries](skills/sandbox-boundary-analysis/SKILL.md) · [Impact](skills/exploitability-assessment/SKILL.md) · [Remediation](skills/remediation/SKILL.md).

## Offline quality checks

`npm run check:python` validates research format, links and provenance. It does not qualify isolation,
vulnerability findings or live-provider quality. Research tools are independent of the extension runtime.

## Development

```sh
npm ci
npm test                  # types, build, unit + inert real-Pi integration, research-library checks
npm run test:sandbox      # real Docker boundary checks, no external target/model requests
pi --no-extensions -e "$PWD"
```

See [architecture](docs/ARCHITECTURE.md). `my_references/` is not shipped or modified.

UNLICENSED (private).
