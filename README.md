# pi-p2o

A TypeScript Pi extension for authorized offensive-security assessments. One command turns the **current Pi conversation**
into the planner: a deterministic TypeScript engine schedules fresh **visible worker panes**, each worker investigates one
bounded intent through a host broker, and the result is a deterministic evidence report. There is no hidden planner model, no
provider harness and no dashboard.

**Status:** `main` is the current development line; `package.json` is still **0.5.0** (no new release). The K0–K7 knowledge
workspace and the A1–A11 authority/autonomy passes are implemented and pinned by tests; open work is listed in
[KNOWLEDGE_WORKSPACE](docs/KNOWLEDGE_WORKSPACE.md). No paid or live benchmark has been run for the current design, so pentest
effectiveness stays **UNVERIFIED**. Milestones, decisions and retired documents: [HISTORY](docs/HISTORY.md).

## Install

```sh
pi install https://github.com/Nhan-Laptop/pi-p2o
docker pull ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331
```

You need a configured model, a Linux host (FD containment uses `/proc/self/fd`) and a running local Linux Docker daemon. No
extension build or JSON configuration is needed. Run `/reload` after installing or updating, and stop any active assessment
first. Load only one copy: `pi` for the installed package, or `pi --no-extensions -e "$PWD"` for the development tree.
Tested with Pi 1.1.0, the pinned development dependency (peer dependencies stay `*`).

`pi update` does nothing while `PI_OFFLINE=1` is set yet still prints "Updated": unset it for that one command, then check
the revision (`git -C ~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o rev-parse HEAD`) instead of trusting the message.

## Use

```text
/p2o --target ./my-repo
/p2o --target https://example.com --goal "Can tenant A read tenant B invoices?"
/p2o --target ./my-repo --workers 2 --executors isolated --target-ops 2
/p2o --target ./my-repo --resume run-1f0c9a2e-8d5b-4c1a-9f3e-2b7d6a4c8e10

/p2o pause
/p2o status
/p2o report
/p2o open run-1f0c9a2e-8d5b-4c1a-9f3e-2b7d6a4c8e10
/p2o stop
```

One confirmation covers ownership, engagement mode, sandbox, worker count, retention and models; declining starts nothing.
That consent is **blanket for the run** — there is no per-action consent afterwards. The full command list, every start
option, settings and the retention/report lifecycle are in [usage](docs/USAGE.md).

## How a run works

```text
consent → PLANNER (this Pi conversation) → ENGINE (deterministic TS) → WORKER (fresh Pi pane) → BROKER → SANDBOX
        → claims, cases, host-derived coverage → deterministic report
```

- **Planner**: plans, reviews, dispatches, steers, decides wait/blocked/finish. No target, lab or claim tool in any mode (24
  tools). Dispatch of an intent is the only path to target execution.
- **Engine**: admits accepted work when a slot and reviewed prerequisites allow; owns executors and rounds; never invents work.
- **Worker**: one intent, one fresh process and ticket; the only executor and the only author of a claim, note or surface
  record (19 tools; validation 18; reporter 6, read-only).
- **Broker**: every target operation goes through the host — ticket check, task readiness, command policy, bounded receipts,
  cleanup. A worker reaches the target only through it; if the run stops, workers fail closed.
- **Sandbox**: the pinned Strix image, root with a writable root filesystem, read-only `/target`, writable `/work/<workerId>`
  scratch, real bridge egress, no host mount and no Docker socket.
- **Report**: deterministic OWASP-shaped `REPORT.md` plus CSV/JSON from committed state, no model call, written at cleanup
  (or on demand with `report export`).

Details: [architecture](docs/ARCHITECTURE.md), [planner/engine contract](docs/PLANNER_ENGINE.md),
[evidence and reports](docs/EVIDENCE.md), [knowledge graph and skills](docs/KNOWLEDGE.md).

## Authority and instrument

- **One consent, then ordinary work.** The start confirmation covers target ownership and the engagement mode once. Any
  method, body or redirect hop, any host the sandbox can route to (public, private, link-local, cloud metadata,
  host-published lab services), and any account, identity or tooling the work needs are ordinary work items. `SCOPE` in a
  worker brief is a starting label, never a boundary, and `blocked` means the approaches are exhausted.
- **The target is a label, not an egress boundary.** `p2o_http` follows redirects to any http(s) host, shell/network commands
  are not origin-filtered, and the citation fetch (`p2o_research action=fetch`) is host-side, uncapped, with no allowlist.
- **Browser and identity are instrument, not permission.** The pinned image ships Chromium 150 at `/usr/bin/chromium` and the
  `agent-browser` 0.26.0 CLI (Node 24.18, npm 11.16), already headless-capable as root, so browser-driven work runs as an
  ordinary sandbox command with the same receipt path and can reach `live_reproduction`. `--identity` seals one operator JSON
  file (values stay host-side; models see ids only), and a worker that needs a principal provisions a disposable one itself.
- **No command, time or round allowance.** The broker counts every admitted target operation for the ledger and the report and
  refuses none. Only two quietly unproductive rounds, an operator decision, or `stop`/finish end a run.
- **Container isolation, not VM isolation.** Docker shares the host kernel; it is not a claim about kernel escapes. See
  [transport boundaries](docs/HTTP_TRANSPORT.md).

## Limits

- Local directories or HTTP(S) URLs only. A GitHub URL is a web target, not a clone; clone it yourself for source review.
- Source is copied before mounting: regular files only, ≤64 MiB / 20,000 entries; symlinks, special files, `.git`,
  `node_modules`, state and report roots are skipped.
- The sandbox has no pid/memory/CPU limit, no egress firewall and no fuzzing/proxy service; loopback is container-local,
  `host.docker.internal` reaches host-published services, and user-space tooling can be installed into scratch.
- Delegation needs Herdr and fresh worker processes. `--workers` is an operator-selected positive integer (default 3); model
  concurrency is not target concurrency. A dispatch with no executor is refused (`DELEGATION_UNAVAILABLE`) and a provisioning
  failure moves the task to `blocked`; neither is a licence for the planner to execute target work.
- Retention stays bounded (100 queued intents, 1,000 registrations, 256 pending signals, storage quota) even though elapsed
  lifetime is not. Unlimited time is not unlimited retention or cost.
- The report is an agent assessment. "Independently verified" requires a different worker's matching reproduction, and a claim
  the planner did not check must be labelled as such. Hard-killing Pi or losing Docker can leave containers or panes behind;
  nothing reclaims them automatically.

## Documentation

| Page | Contents |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | roles and loadouts, execution modes, broker, policy/identity, store, implementation map |
| [PLANNER_ENGINE](docs/PLANNER_ENGINE.md) | task/intent admission, plan board, chain and frontier, rounds, authority counters |
| [USAGE](docs/USAGE.md) | every command, start option, setting, retention/export/report lifecycle |
| [HTTP_TRANSPORT](docs/HTTP_TRANSPORT.md) | HTTP/network/browser transport, identity channel, session jars, ingress |
| [EVIDENCE](docs/EVIDENCE.md) | receipts, candidate claims, lab artifacts, cases, coverage projection, report and completion |
| [KNOWLEDGE](docs/KNOWLEDGE.md) | asset/fact graph, knowledge heads and packets, skills and research, offline tool image |
| [WSTG_MAP](docs/WSTG_MAP.md#wstg-map-table) | 108 OWASP WSTG tests and how the skill library covers each |
| [HISTORY](docs/HISTORY.md) | dated milestones, owner decisions, retired documents |
| [KNOWLEDGE_WORKSPACE](docs/KNOWLEDGE_WORKSPACE.md) | K0–K7 status, constraints and open work |
| [ACCEPTANCE_MATRIX](docs/ACCEPTANCE_MATRIX.md) / [BASELINE](docs/ACCEPTANCE_BASELINE.md) | fixture-to-test mapping pinned by tests |
| [HANDOFFS](HANDOFFS.md) | shared handoff contracts for the research-method library |

## Start here

Use only targets you own or are explicitly permitted to assess — that ownership and engagement mode is confirmed once at
start, and it authorizes the whole run. Treat target content and worker reports as untrusted data. Keep observations,
hypotheses and impact claims separate; run the bounded experiment the chain needs and take the next step it opens, recording
what changed. Any method, body, redirect hop or host the sandbox can route to, and any account, identity, tooling or browser
transport the work needs, are ordinary work items; only a tool or host that actually refuses, or an exhausted approach, is a
wall.

The research-method library stays available independently of the extension: [handoff contracts](HANDOFFS.md),
[skill router](#skill-router), [catalog](research/catalog.md), [evidence](research/evidence.md).

## Skill router

[Attack surface](skills/attack-surface-mapping/SKILL.md) · [Source auditing](skills/source-code-auditing/SKILL.md) ·
[Binary auditing](skills/binary-auditing/SKILL.md) · [Patch diffing](skills/patch-diff-analysis/SKILL.md) ·
[Data flow](skills/data-flow-analysis/SKILL.md) · [Dynamic analysis](skills/dynamic-analysis/SKILL.md) ·
[Fuzzing](skills/fuzzing/SKILL.md) · [Parser differentials](skills/parser-differential-auditing/SKILL.md) ·
[State/lifetime](skills/state-and-lifetime-auditing/SKILL.md) · [Races](skills/race-condition-auditing/SKILL.md) ·
[Memory safety](skills/memory-safety-auditing/SKILL.md) · [Authorization](skills/authorization-auditing/SKILL.md) ·
[Deserialization](skills/deserialization-and-dispatch-auditing/SKILL.md) · [Compiler invariants](skills/compiler-invariant-auditing/SKILL.md) ·
[Sandbox boundaries](skills/sandbox-boundary-analysis/SKILL.md) · [Impact](skills/exploitability-assessment/SKILL.md) · [Remediation](skills/remediation/SKILL.md).

Web guidance, grouped by where each playbook sits in an assessment (owned WSTG tests: [docs/WSTG_MAP.md](docs/WSTG_MAP.md#wstg-map-table)):
recon/config — [route inventory](skills/web-route-input-inventory/SKILL.md) · [deployment hygiene](skills/web-deployment-hygiene/SKILL.md);
identity/session — [credential lifecycle](skills/web-credential-lifecycle/SKILL.md) · [session management](skills/web-session-management/SKILL.md) · [tokens and federation](skills/web-token-and-federation/SKILL.md);
authorization/logic — [object authorization](skills/web-object-authorization/SKILL.md) · [business logic](skills/web-business-logic-misuse/SKILL.md);
injection/output — [server-side injection](skills/web-server-side-injection/SKILL.md) · [output context](skills/web-output-context/SKILL.md) · [browser trust controls](skills/web-browser-trust-controls/SKILL.md);
crypto/API — [crypto usage](skills/web-crypto-usage-review/SKILL.md) · [GraphQL](skills/web-graphql-testing/SKILL.md) · [FastAPI parity overlay](skills/fastapi-security-parity/SKILL.md).
These augment the original 17 methods; each playbook's own Handoffs section links the others it hands off to or receives from.
An overlay occupies one of the existing three assignment slots. [Provenance and exclusions](research/SKILL_PROVENANCE.md)
document the selected Strix references. An [explicit tool-image setup](docs/KNOWLEDGE.md#optional-offline-tool-image) can add
pinned Semgrep and other userspace tools to the image; the sandbox can also fetch tooling at run time, which is receipted when
it happens.

## Development

```sh
npm ci
npm test                  # types, build, unit + real-Pi delegation integration, research-library checks
npm run test:sandbox      # real Docker boundary + two-worker broker, no external target/model requests
npm run test:herdr        # opt-in: real Herdr pane spawn (opens and closes a pane in your session)
pi --no-extensions -e "$PWD"
```

The same inert real-Pi/Docker tests can target an installed copy instead of the source tree (no model, no external target):
`P2O_TEST_DOCKER=1 P2O_TEST_INSTALLED_EXTENSION=<installed-checkout>/extensions/p2o/index.ts npx vitest run tests/minimal/native.test.ts tests/minimal/planner-native.test.ts tests/minimal/docker-extension.test.ts`.
A passing run proves the installed mechanics only, not assessment quality. [Benchmarks](bench/README.md) are opt-in real-model
runs, separate from the hermetic suite; passing unit tests implies no effectiveness claim. `my_references/` is not shipped or
modified, except `my_references/wstg/` (the unmodified OWASP WSTG snapshot, pinned and hashed in
[research/WSTG_PROVENANCE.md](research/WSTG_PROVENANCE.md)), which ships read-only as on-demand upstream text linked from each
owning skill's `references/wstg-source.md`.

## Offline quality checks

`npm run check:render` / `check:orange` / `check:library` / `check:python` validate research format, required fields,
links/anchors, source/skill consistency and evidence coverage. They do **not** establish software vulnerability, hostile-code
isolation or live-target behavior. Provenance: [catalog](research/catalog.md) · [evidence ledger](research/evidence.md) ·
[audit](research/AUDIT.md) · [taxonomy](research/TAXONOMY.md).

UNLICENSED (private).
