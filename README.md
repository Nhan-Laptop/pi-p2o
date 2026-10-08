# pi-p2o

One command. Your **current Pi agent** leads an authorized assessment through sandbox tools and can delegate
**visible worker panes** that share the same sandbox. No separate orchestrator, planning wizard, manifests,
plan IDs or dashboard.

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
/p2o stop
```

Confirm scope and permission once. The command prepares the sandbox and sends the task directly into the
**existing conversation**, using the existing model. The lead investigates, shows progress through ordinary Pi
tool calls, and writes the report here. Normal provider charges apply.

Delegation is available when Pi runs inside [Herdr](https://herdr.dev): each worker is a real Pi process in a
neighbouring pane with its own role model, and every worker shares this sandbox through the owner.

| Tool | Role | Purpose |
|---|---|---|
| `p2o_skill_list` / `p2o_skill_read` | lead + worker | Paginated catalog and approved skill/reference/handoff documents; IDs, never arbitrary host paths |
| `p2o_candidate` | lead + worker | Evidence-linked candidate claims, proof level, controls, limitations and explicit revisions |
| `p2o_shell` | lead + worker | Offline shell in the sandbox; `/target` is a read-only copy, `/work/<workerId>` is scratch |
| `p2o_http` | lead + worker | Fixed curl, GET/HEAD on the authorized origin only; public IPv4, no redirects/credentials |
| `p2o_note` | lead + worker | Append a note, observation, coverage row or open item to the shared ledger |
| `p2o_ledger` | lead + worker | Read the shared ledger or one evidence/candidate record by ID before repeating work |
| `p2o_delegate` | lead + worker | Spawn one focused worker (objective, context, role, 1-3 skills, optional model) |
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

## Recon and next-task selection

The lead’s prompt contains assessment policy, not tool manuals; Pi supplies the active descriptions and schemas.
Startup uses a short kickoff instead of duplicating those instructions. Worker guidance is unchanged.
Pi tool descriptions explain execution limits; they do not guarantee installed binaries. Check only prerequisites
needed for the chosen task through bounded offline shell execution, without installation or universal startup probes.
Recon records surfaces, inputs, actors/gates, Evidence IDs and unknowns. The lead records why a particular
surface/risk is next, then maps unclear gates, investigates concrete concerns and seeks separate validation for
plausible candidates. New surfaces feed back into recon; incomplete mapping never implies target safety.
See [runtime guidance](docs/SKILL_RUNTIME.md) and [handoffs](HANDOFFS.md).

## Limits

- Local directories or HTTP(S) URLs only. A GitHub URL is a web target, not a clone; clone it yourself for source review.
- URL scope is the exact origin. No login, custom headers, credentials, POST, redirects, private/loopback targets or IPv6 yet.
- Source is copied before mounting: regular files only, ≤64 MiB / 20000 entries, symlinks/special files/`.git`/`node_modules` skipped.
- The offline shell has no network; browser automation, proxy capture and fuzzing harnesses are not provided.
- Delegation needs Herdr plus one visible pane per worker (cap `--workers`, default 3, max 6; total spawns ≤ 2× the cap).
- Workers stop at the shared command reserve (90 %), leaving the remainder for the lead's report.
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
tool presence and usable dependencies must never be assumed from the image name. An [explicit tool-image setup](docs/SKILL_RUNTIME.md#optional-offline-tool-image) can add pinned Semgrep without enabling network access during assessments.

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
