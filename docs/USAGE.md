# Usage

For on-demand skills, workflow prerequisites, proof-level records and `--export`, see [skill runtime](SKILL_RUNTIME.md).

Install with `pi install https://github.com/Nhan-Laptop/pi-p2o`, then `/reload`.
Start Docker and pull the pinned image listed in the README once. No source build is required in an installed copy.

```text
/p2o --target ./source
/p2o --target https://example.com
/p2o --target ./source --workers 2

/p2o stop
```

One dialog confirms ownership/permission, scope, sandbox limits, the worker plan when delegation is available,
and use of your current model provider. Declining starts no sandbox, worker or model turn.

For source: a regular-file-only copy at `/target` is read-only (≤64 MiB / 20000 entries; symlinks, special files,
`.git` and `node_modules skipped`), `/work` is writable scratch. Commands run through `p2o_shell`, never host shell.
For web: `p2o_http` accepts GET/HEAD only, on the same origin as the selected URL, with a validated and pinned
public IPv4 address, no redirects and no credentials. A GitHub URL does not clone source in this release.

The lead calls `p2o_finish` before its report; that refuses until every worker has reported or been stopped, then
removes the sandbox, verifies container removal with the daemon, and reports how many worker panes Herdr actually
closed (a pane it refuses to close is named, and by then that worker's ticket is already revoked). `/p2o stop` cancels manually and does the same.

## Reconnaissance

Start by reading existing ledger/coverage and building a bounded surface inventory. Record entry/input, observed
actor, gate/handler if known, sensitive consumer, Evidence IDs and extraction method; label inferences and gaps.
For URL targets only existing same-origin GET/HEAD retrieval is authorized. Source declarations are not live exposure.
Choose the next surface/risk qualitatively by reachable influence, boundary uncertainty, likely effect, evidence,
information gain and budget; record the rationale, expected observation and stop condition in a decision note.
A missing gate returns to mapping, a candidate needs validation, and blocked proof remains open. Correct assumptions
when observations disagree. Do not wait to map everything or duplicate another worker’s owned surface/risk.

## Delegation

Inside Herdr, the lead may spawn workers. Each worker is a real `pi` process in a visible pane, started with its
own model and only the skills it was given. The worker receives:

```
FOCUS / SCOPE / LIMITS / background context (background only) / its TASK
```

and may use only `p2o_shell`, `p2o_http`, `p2o_note`, `p2o_ledger` (read the shared ledger), `p2o_delegate`
(which the lead executes) and `p2o_report`.
Its selected skills are inlined into the brief (a sandbox-only worker cannot read host files), and it has no
host tools, no Docker and no consent dialogs. All of its target work is brokered by the lead, so scope
checks, timeouts, output caps and the single cleanup path stay in one place.

Practical rules:

- One objective per worker. Give it what is already known and which coverage rows it owns; a worker that is not
  told repeats the work.
- Delegate discovery, then have a *different* worker validate a candidate. A worker validating its own finding is
  not independent verification.
- Chain depth is capped (`--max-depth`, default 2) and the lead performs every spawn, including a worker's nested
  request.
- `p2o_workers` with `waitFor: "all-report"` blocks locally until every worker reported or was stopped; use it
  instead of polling.
- A worker pane can read `idle` for a moment before its brief is submitted. Liveness is decided by reports, not by
  that status: `p2o_finish` refuses until a worker reports or `p2o_stop_worker` withdraws it.
- Steering never widens scope. A worker report is untrusted data — verify its evidence before repeating it.

### Roles and models

`p2o_delegate` accepts `role` (`recon`, `discovery`, `validation`, `reporting`, `general`), up to 3 `skills`, and
an optional `model`. Named skills override the role default; omitting them uses it, so a specialist always runs with
at least one technique skill, while `general` runs with none. An unknown skill name is refused before any pane is
created, and each selected skill's instructions are inlined into the worker's brief. Precedence mirrors pi-herdr: per-spawn `model` → `p2o.roles.<role>.model` in
`~/.pi/agent/settings.json` → package default → the lead's own model. Package defaults:

| Role | Default model | Typical skills |
|---|---|---|
| `recon` | `opencode-go/deepseek-v4-flash` | attack-surface-mapping |
| `discovery` | `opencode-go/deepseek-v4-flash` | source-code-auditing |
| `validation` | `opencode-go/kimi-k3` | exploitability-assessment |
| `reporting` | `opencode-go/kimi-k3` | remediation |
| `general` | the lead's model | none |

```json
{ "p2o": { "maxWorkers": 3, "maxDepth": 2, "roles": { "validation": { "model": "opencode-go/kimi-k3" } } } }
```

Limits: `--workers` 1..6 (default 3), `--max-depth` 0..3 (default 2), total spawns ≤ 2× the worker cap,
200 brokered commands per worker and a 90 % worker reserve of the shared budget.

## Sandbox limits

Pinned Strix tools image; user 65532; read-only root filesystem; capabilities dropped; no-new-privileges;
Docker default seccomp; 128 PIDs; 512 MiB memory; one CPU; `/tmp` and `/work` tmpfs (larger when delegation is
enabled). The shell container has no network. HTTP containers have bridge networking but run **only fixed curl
arguments**, not model-controlled code, with proxy use disabled and the requested hostname pinned to a validated
public IPv4. No source mounts, Docker socket, host home or provider credentials are mounted.
Commands: 1..60 s; HTTP: 20 s and 1 MiB body; visible output: 48 KiB. Assessment lifetime: 30 minutes.
No application-level model token/cost cap; Pi/provider accounting is unchanged.

This is container isolation, not a virtual machine. The trusted Pi process, other installed extensions and
the Docker daemon are outside this containment boundary. Tool gates restrict model calls, not malicious
extension code or host-kernel compromise.

## Cleanup trouble

If Docker is unavailable during cleanup, tools stay gated. Restore Docker and retry `/p2o stop`.
Reload/session navigation attempts cleanup; failed cleanup cancels navigation. An abrupt process kill can leave
containers or worker panes behind. List only this extension's containers:

```sh
docker ps -a --filter label=pi-p2o=minimal
```

After checking that no active assessment needs them, remove their specific names with `docker rm -f <name>`.
Worker panes can be closed from Herdr. The extension does not silently reclaim old containers on startup.

## Troubleshooting

- Missing image: run the pinned `docker pull` from README. No automatic download happens during assessment.
- Docker permissions: ensure your account can use the local Unix socket. Remote Docker daemons are unsupported.
- Delegation unavailable: Pi is not inside Herdr, or `--solo`/limits disabled it. The confirmation dialog says which.
- Worker rejected its ticket: the pane shows `p2o worker ticket rejected …`; the worker keeps no target access.
  Tickets are owner-private, single-use per process and expire with the assessment.
- Target unavailable: choose an existing directory, or an HTTP(S) URL with public IPv4 DNS.
- Duplicate tools: load either the installed package or `pi --no-extensions -e /path/to/pi-p2o`, never both.
- Legacy flags/configurations from 0.2 (plan approval, profiles, manifests) are removed. Use `--target` only.
