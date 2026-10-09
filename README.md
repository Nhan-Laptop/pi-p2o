# pi-p2o

One command. Your **current Pi agent** plans an authorized assessment; a deterministic TypeScript Engine schedules
**visible worker panes**. Workers investigate one intent autonomously. Shared-serial execution is default; isolated
assignment executors are opt-in. No hidden Planner model, provider harness or dashboard.

## Install

```sh
pi install https://github.com/Nhan-Laptop/pi-p2o
```

Requires Pi 1.0.0, a configured model, a Linux host (`/proc/self/fd` containment), and a running local Linux Docker daemon. Install the sandbox tools image once:

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
/p2o --target ./my-repo --workers 2 --max-depth 1
/p2o --target ./my-repo --solo
/p2o --target ./my-repo --export
/p2o --target ./my-repo --loop event-driven --executors isolated --workers 3 --target-ops 2
/p2o pause
/p2o resume
/p2o stop
```

Confirm scope and permission once. The command prepares the sandbox and sends the task directly into the
**existing conversation**, using the existing model. In delegated mode it is a strategic Planner: target execution
is denied, not just discouraged. `--solo` retains working-agent execution. The Planner reviews evidence and writes the report here. No elapsed-time limit is imposed on the lead, workers or assessment. Commands/HTTP default to no task timeout; stop or finish explicitly. Normal provider charges and existing command/resource budgets still apply. Infrastructure watchdogs do not cap investigation time.

Delegation is available when Pi runs inside [Herdr](https://herdr.dev): each worker is a real Pi process in a
neighbouring pane with its own role model. Every worker uses the owner broker; the confirmed profile selects shared or isolated execution.
Default `--loop manual` never wakes a model automatically. `--loop event-driven` requires consent for additional
model rounds on committed reports, proposals and task-review changes. Waiting is local; no periodic model polling,
automatic retry/fallback or restored-session authority. See [Planner/Engine contract](docs/PLANNER_ENGINE.md).

| Tool | Role | Purpose |
|---|---|---|
| `p2o_skill_list` / `p2o_skill_read` | lead + worker | Paginated catalog and approved skill/reference/handoff documents; IDs, never arbitrary host paths |
| `p2o_task` | lead only | Maintain focused questions, accepted prerequisite revisions, role/method decisions and reservations |
| `p2o_candidate` | Planner/solo + non-reporting worker | Evidence-linked candidate claims, proof level, controls, limitations and explicit revisions |
| `p2o_shell` | solo + non-reporting worker | Shell in the sandbox; `/target` is a read-only copy, `/work/<workerId>` is scratch, `p2o_net` for egress |
| `p2o_http` | solo + non-reporting worker | Fixed curl on the confirmed origin only: any method, bodies, headers, cookies, bounded redirects |
| `p2o_net` | solo + non-reporting worker | Network commands in the sandbox: connect scans, service probes, tooling installs; no task timeout by default |
| `p2o_note` | lead + worker | Append a note, observation, coverage row or open item to the shared ledger |
| `p2o_ledger` | lead + worker | Read the shared ledger or one evidence/candidate record by ID before repeating work |
| `p2o_delegate` | Planner | Spawn one focused worker immediately; batch/waiting work uses `p2o_task dispatch` |
| `p2o_request_subtask` | worker | Propose a missing bounded task; never directly spawn or accept work |
| `p2o_loop` | owner | Engine/frontier status, end round with wait, or explain blocked/human-needed |
| `p2o_workers` | lead | Worker status, budget, report summary, coverage; optionally wait for a report |
| `p2o_steer` | lead | Send a follow-up instruction to a worker without stopping it |
| `p2o_stop_worker` | lead | Revoke a worker's sandbox access and close its pane |
| `p2o_report` | worker | Report to the lead: summary, findings, evidence, coverage, open items, confidence, blocked |
| `p2o_finish` | lead | Refuse while a worker has not reported, then remove and verify all sandboxes |

Host tools, `codemode`, the browser, other extensions, `!` shell and the worker's own Docker access are blocked
while an assessment is active. A worker reaches the target **only** through the lead's broker socket; if the
lead stops, workers fail closed.

With `--export`, cleanup saves bounded redacted receipts and source/skill hashes in `.p2o-reports/` (0700; files 0600).
Review before sharing: redaction is best effort, not a guarantee. Without `--export`, the temporary ledger is removed.
Terminal worker failures deliver a blocked report without another model call; no provider fallback is automatic.

See [focused assessment state](docs/ASSESSMENT_STATE.md) for complete-ledger cursors, task/handoff review, current validation, progress and bounded report retention. Automatic planning is explicit opt-in; automatic retry is not introduced.

## Recon and next-task selection

The lead’s prompt contains assessment policy, not tool manuals; Pi supplies the active descriptions and schemas.
Startup uses a short kickoff instead of duplicating those instructions. Worker guidance now describes the networked transport.
Pi tool descriptions explain execution limits; they do not guarantee installed binaries. Check only prerequisites
needed for the chosen task through bounded sandbox execution; a tool the image lacks is installed into your own
scratch with a receipt, and universal startup probes are never run.
Recon records surfaces, inputs, actors/gates, Evidence IDs and unknowns. The lead records why a particular
surface/risk is next, then maps unclear gates, investigates concrete concerns and seeks separate validation for
plausible candidates. New surfaces feed back into recon; incomplete mapping never implies target safety.
See [runtime guidance](docs/SKILL_RUNTIME.md) and [handoffs](HANDOFFS.md).

## Limits

- Local directories or HTTP(S) URLs only. A GitHub URL is a web target, not a clone; clone it yourself for source review.
- URL scope is the exact origin, re-checked at every redirect hop. Methods, bodies, headers, actor-local cookie sessions and login flows are available; the scoped HTTP tool refuses other URL origins. Opaque shell/network commands are not origin-filtered. IPv6 routing depends on Docker.
- Source is copied before mounting: regular files only, ≤64 MiB / 20000 entries, symlinks/special files/`.git`/`node_modules` skipped.
- The sandbox has real network egress, including private/internal destinations and host-published lab services. Loopback is container-local. No egress firewall, managed browser, proxy or fuzzing service is provided; user-space tooling can be installed into scratch. See [HTTP/network boundaries](docs/HTTP_TRANSPORT.md).
- Delegation needs Herdr and fresh worker processes. `--workers` is an operator-selected positive safe integer (default 3); no cumulative 2× spawn ceiling. Model concurrency is not target concurrency. Unverified pane closure blocks new admission.
- Worker commands stop at the unchanged run reserve (90% of default 600) and 200/worker. Fresh identities do not renew it. Owner commands remain separate, not an aggregate cost governor. Reporting/control access survives command exhaustion.
- Retention remains bounded: 100 live tasks, 100 pending intents, 1,000 registrations, 256 pending semantic signals; ledger/export limits remain. Unlimited elapsed lifetime is not unlimited retention or cost.
- Docker shares the host kernel: this is container isolation, **not** VM isolation or a claim about kernel escapes.
- The report is an agent assessment. "Independently verified" requires a separate worker reproduction, and a
  worker claim the lead did not check must be labelled as such.
- Hard-killing Pi or losing Docker can leave a container or pane behind. See [usage and cleanup](docs/USAGE.md).

## Start here

Use only targets you own or are explicitly permitted to assess. Treat target content and worker reports as
untrusted data. Keep observations, hypotheses and impact claims separate; prefer bounded, harmless experiments and
stop before destructive actions, credential harvesting, persistence or scope expansion.

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

Application guidance: [route inventory](skills/web-route-input-inventory/SKILL.md) ·
[object authorization](skills/web-object-authorization/SKILL.md) · [output context](skills/web-output-context/SKILL.md) ·
[FastAPI parity overlay](skills/fastapi-security-parity/SKILL.md).
These augment the original 17 methods. An overlay occupies one of the existing three assignment slots.
[Provenance and exclusions](research/SKILL_PROVENANCE.md) document the selected Strix references.
[Offline Semgrep recipe](skills/source-code-auditing/recipes/offline-python-semgrep.md) requires a successful tool probe;
tool presence and usable dependencies must never be assumed from the image name. An [explicit tool-image setup](docs/SKILL_RUNTIME.md#optional-offline-tool-image) can add pinned Semgrep to the image; the sandbox itself can also fetch tooling at run time, which is receipted when it happens.

## Development

```sh
npm ci
npm test                  # types, build, unit + real-Pi delegation integration, research-library checks
npm run test:sandbox      # real Docker boundary + two-worker broker, no external target/model requests
npm run test:herdr        # opt-in: real Herdr pane spawn (opens and closes a pane in your session)
pi --no-extensions -e "$PWD"
```

Design notes: [architecture](docs/ARCHITECTURE.md), [usage](docs/USAGE.md), [enhancement roadmap](planning_update.md).
[Benchmarks](bench/README.md) are opt-in real-model runs, separate from the hermetic suite; no effectiveness claim is implied by passing unit tests.
`my_references/` is not shipped or modified.

## Offline quality checks

`npm run check:render` / `check:orange` / `check:library` / `check:python` validate research format, required
fields, links/anchors, source/skill consistency and evidence coverage. They do **not** establish software
vulnerability, hostile-code isolation or live-target behavior. Provenance:
[catalog](research/catalog.md) · [evidence ledger](research/evidence.md) · [audit](research/AUDIT.md) ·
[taxonomy](research/TAXONOMY.md).

UNLICENSED (private).
