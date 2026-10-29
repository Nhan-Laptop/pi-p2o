# Architecture: Planner / Engine / Worker / Broker

```text
/p2o --target …  parse → classify → one human consent (ownership, engagement mode, resources, retention)
  → PLANNER   the current Pi conversation: plans, reviews, dispatches, decides wait/blocked/finish
  → ENGINE    deterministic TypeScript, no model: accepted frontier → slot → fresh worker
  → WORKER    fresh Pi process in a visible Herdr pane, one bounded intent, brokered execution
  → EXECUTOR  shared (one serial queue by default; an explicit --target-ops N lifts it), isolated (own sandbox per
              assignment) or session (long-lived run-owned executor: shell cwd/state, optional PTY, listeners)
  → stop/finish: close the Engine gate → drain/cancel → revoke → close panes → verify containers
```

The planner is the model the operator already selected; Pi owns its inner tool loop and `AssessmentEngine` owns the outer
scheduling loop. Nothing runs at load time and nothing polls: event wakes are finite coalescing windows (800 ms) that need
explicit event-driven consent. Engine/task semantics: [PLANNER_ENGINE](PLANNER_ENGINE.md).

## Roles and authority

| Role | Tools | Power | Never |
|---|---|---|---|
| planner | 23 | creates/revises/dispatches/reviews/settles intents, writes plans, cases, coverage scope; reads ledger/graph/state; steers, waits, blocks, finishes | any target, lab or claim tool; execution of target work |
| worker | 20 | one intent: shell/net/http/capture/session, lab, candidate claim, note, surface, graph write-back, report | create/dispatch tasks, review, inherit another worker's authority |
| validation | 19 | the worker set without the surface writer; reproduces another worker's reviewed claim | record new surfaces or widen the question |
| reporter | 6 | read-only second reader: ledger, artifact, skills, state, report | target operations, candidate authorship, verdicts, plan changes |

The lists live in `src/tool-policy.ts` (35 registered tools, all model-visible). The graph surface is split by authority:
`p2o_graph` is the shared read, `p2o_graph_record` takes the worker/validation batch, `p2o_graph_review` lets the planner
settle or promote one retained row, and `p2o_graph_plan` is the planner's `chain`/`ingest` coordination verb. Enforcement is
the loadout, not the prompt: a role is restricted by *not activating* a tool, so a model that calls it gets Pi's unknown-tool
result. Role prompts (`src/prompts.ts`) state the same split in one line each, and dispatch of an intent is the only path to
target execution. A round that ends with an open goal, no open intent and no recorded wall is recorded as a `planner.stalled`
report fact; a round that records a wall (a deferred or blocked todo citing the debt ids it answers) is progress, not a stall.

Only the live owner process holds consent, the broker, executors and cleanup. Transcripts, ledgers and summaries never
recreate authority after a restart. Worker tickets bind identity, token, run, image, extension bytes and the runtime
profile; they last until stopped and are revoked by report, withdrawal or socket loss. Every target operation re-checks its
ticket and task readiness — that is admission, not per-action consent.

One module states the instrument: `src/truth.ts` carries the network, HTTP, credential, authorization, browser and
risk-label facts. Tool descriptions, planner/worker prompts, worker briefs and the consent text compose the same facts, so
no surface can quietly restore a ceiling another surface dropped (`tests/minimal/truth.test.ts` pins it).

## Execution

- **Shared executor (default):** `Sandbox.enqueue` serializes target operations. An explicit `--target-ops N` (N>1) lifts
  that queue for the run, is stated in the confirmation and recorded in the ledger. Provisioning, scratch and cleanup stay
  serial; cancelling can remove the executor and interrupt peers.
- **Isolated:** fresh source copy, scratch, cookies and container per assignment, gated by a separate target-operation
  semaphore. Cancelling one assignment leaves peers untouched.
- **Session:** `--executors session[:N]` keeps N run-owned containers alive (default and ceiling: the target-operation
  cap). Each holds shell cwd/state and one optional PTY, so a chain step starts where the previous one stopped.
  `p2o_session` opens/lists/execs/snapshots/closes them; `p2o_shell session=<id>` drives the PTY. A dead session fails
  closed — nothing is resumed or recreated automatically.
- **Containers:** the pinned image `ghcr.io/usestrix/strix-sandbox@sha256:f6906c…`, root, writable root filesystem,
  Docker's default capability set (raw sockets and SYN scans work), no pid/memory/CPU limit, no host mount, no Docker socket,
  no provider credentials. `/target` is a read-only copy, `/work/<workerId>` is scratch. Egress is the bridge network:
  private, link-local, host-published lab and cloud-metadata addresses are reachable; loopback is container-local. Commands
  and HTTP default to no timeout; stop or finish explicitly.
- **Source snapshot:** regular files only, ≤64 MiB / 20,000 entries; symlinks, special files, `.git`, `node_modules`, state and
  report roots are skipped.
- **Ingress is operator-provided.** `--callback <url>` records the out-of-band destination the target is expected to reach
  (a fact, not a listener); `--lab-network <name>` joins the sandbox to a throwaway docker network so
  `p2o_session action=listen {port}` can start a bounded logging catcher inside the session container (`<container>:<port>`,
  tcp only, at most four per session). No host port is ever published and no tunnel or pivot is provided; the report names
  which ingress path existed.

### Sandbox capability matrix

Distilled from the 2026-10-27 probe in `planning_update.md` §2.4 and the code that enforces each row; prose that promises
capability must agree with this table.

| Axis | Measured, enforced | Where |
|---|---|---|
| Container | uid 0 (`--user root`, `HOME=/root`), writable rootfs, Docker's default 14-capability set (CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, SETPCAP, NET_BIND_SERVICE, NET_RAW, SYS_CHROOT, MKNOD, AUDIT_WRITE, SETFCAP); not privileged; shares the host kernel; no pid/memory/CPU limit | `src/sandbox.ts:17-19`, `src/truth.ts:15` |
| Filesystem | `/target` is a read-only bind mount of the bounded source copy; `/work` is writable scratch; no other host path is mounted; the Docker socket is never exposed | `src/sandbox.ts:99` |
| Network | bridge egress unrestricted, including public, private, link-local, cloud-metadata and host-published addresses (`host.docker.internal`); loopback is container-local; no inbound path by default; `--lab-network` plus a session listener is the only ingress (at most four per session, TCP, logs bytes and never answers); no published host port, no tunnel or pivot | `src/sandbox.ts:93,100`, `src/truth.ts:18`, `extensions/p2o/index.ts:1436-1490` |

| Bound | Value | Where |
|---|---|---|
| Visible command output | 48 KiB | `src/process.ts:3` |
| HTTP request body | 48 KiB | `src/target.ts:284` |
| Lab payload | 48 KiB | `src/lab.ts:20` |
| Upload into scratch | 48 KiB | `extensions/p2o/index.ts:1408` |
| Scratch write | 64 KiB | `src/scratch.ts:143` |
| Command string | 32 KiB | `src/sandbox.ts:160` |
| Capture | reads up to 8 MiB, stores 1 MiB by default, returns an 8 KiB preview | `src/scratch.ts:4`, `src/roles.ts:105`, `src/sandbox.ts:213` |
| Receipt | 16 KiB stdout / 4 KiB stderr | `src/evidence.ts:61` |
| Time | no command or elapsed-time budget by default; an opt-in command timeout that fires retires the sandbox | `src/target.ts:279-282`, `src/sandbox.ts:171-181` |
| Planner round | 40 steps or 900 s by default, wrapping at the last 6 steps, 90 % of the time axis or 80 % of the reported context, hard stop at 92 % context; `0` disables an axis and the campaign itself is uncapped | `src/round-budget.ts:22,40-54` |
| Round opening | deterministic, ≤ 8 KiB, with older records folded into a bounded digest | `src/round-brief.ts:30`, `tests/minimal/round-brief.test.ts` |

**Installed vs installable.** The image ships gcc 15.3.0, objdump/readelf/nm/objcopy, gdb 17.2, nmap 7.99, nuclei 3.11,
ffuf, sqlmap 1.10.6, httpx, subfinder, nc/ncat, Python 3.13 with pip, Node, Chromium 150 and agent-browser 0.26; gcc's
ASan works out of the box. The preinstalled `nmap` launcher carries CAP_NET_ADMIN file capabilities that the default
bounding set refuses (exec fails with EPERM); a copy of `/usr/lib/nmap/nmap` in scratch, with its file capabilities
stripped, runs as root and SYN scans work. g++/make/clang/rustc, AFL++, pwntools, radare2/ghidra, metasploit and
strace/socat/ssh/tcpdump install into scratch from the unrestricted egress; `scripts/setup-sandbox-tools.sh --with`
preinstalls its fixed `--with` list at build time (angr, z3, binwalk, mitmproxy, unicorn, pwntools 4.15.0, strace,
socat, ssh, afl++, radare2, tcpdump, java): python packages carry exact pins, apt packages are named against the rolling
base and only the image ID pins them, and `--with` is operator convenience rather than a capability gate — the running
container is unchanged and the agent can still install into scratch. A missing tool is a work item, not a wall.

**Prompt-safe claims.** Prompts, tool descriptions and docs may assert: a root shell on a writable root filesystem with
the Docker default capability set (raw sockets and SYN scans work); compilers, a debugger and recon tooling present; a
browser installed; egress to any address the container routes to; `/target` read-only; no host path or Docker socket; no
command or elapsed-time budget by default; 1 MiB capture of otherwise truncated output; the container as the only blast
radius (not a VM; host-kernel escape untested).

**Forbidden claims.** A later edit must not assert: the root filesystem is mounted read-only; the container runs
unprivileged; capabilities have been removed or restricted; egress is filtered to the authorized origin; an inbound path
exists without `--lab-network`; a host port is published or a tunnel/pivot exists; a command, elapsed-time or token budget
exists by default; VM isolation or a proven host-kernel compromise; or the retired "no shell" / "no browser" ceilings.

## Command policy and identity

One dispatch seam (`executeWithReceipt`) evaluates the command-policy gate **before** any secret substitution or target
operation. The policy is 8 seed deny rules plus operator rules (`p2o.commandPolicy`), evaluated for `shell`, `net`, `http` and
PTY `send`; `ask` returns `POLICY_ASK_PENDING:<id>` and waits for `/p2o approve` or `/p2o deny`, and a decision binds to the
exact request hash. A deny is absolute; an operator `--allow` is a recorded permission, never a widening of the target.

`--identity` seals one operator JSON file: the host keeps a copy plus sha256 in the control directory, exposes ids, kinds,
labels and scopes (never values) to models, and substitutes `${P2O_SECRET:<id>}` only after the policy allows the operation —
shell-quoted for shell/net, raw for PTY `send`, request-side for HTTP. Every use is audited by id; receipts and reports carry
redacted text only, and redaction is best-effort (a worker can print or encode a value). Sealing is convenience, not a
ceiling: a worker provisions a disposable principal when the work needs one (see [HTTP transport](HTTP_TRANSPORT.md)).

## Persistence and teardown

- Canonical state is one SQLite file per run (`node:sqlite`, schema 7): records, events, outbox and request results commit
  in one transaction. A `writer.lock` holds `BEGIN EXCLUSIVE` for the writer's lifetime; a second writer is refused and the
  OS releases the lock when the process dies. The directory is 0700/0600, reached through pinned FDs (`O_DIRECTORY`,
  `O_NOFOLLOW`), and is never mounted into the sandbox. An older JSONL ledger is still read.
- Retention is `durable-local` (default: `<cwd>/.p2o-state/<run-id>/` survives stop/finish, quota 256 MiB by default) or
  `ephemeral` (deleted at cleanup). Checkpoint, `recover`, `reconcile`, portable `export`/`import` and the deterministic
  report are described in [USAGE](USAGE.md); retention holds knowledge only, never a ticket, cookie, socket or authority.
- Defaults: 3 model slots, 1,000 worker registrations, 256 pending signals, 100 queued intents, no live-task ceiling.
  `src/authority.ts` derives the counters (target operations by planner/worker, tasks created/dispatched, owner/worker
  claims, validation tasks, stalled rounds, wakes, resumes) from committed records only; the planner-target-operation and
  owner-claim counters must be 0, and nothing gates on a counter.
- Stop closes the Engine gate first, then drains, revokes, closes panes and verifies containers. Finish refuses while a
  worker has not reported, then removes and verifies every sandbox; a report or preflight failure never blocks cleanup.
  A hard kill can leave containers or panes behind; nothing reclaims them automatically.

## Implementation map

| File | Responsibility |
|---|---|
| `extensions/p2o/index.ts` | Pi adapter: commands, tools, lifecycle, consent, loadouts, cleanup |
| `src/engine.ts`, `src/planner-bridge.ts` | Frontier, slots, semantic signals, rounds, stalled-round facts, wake encoding |
| `src/round-budget.ts`, `src/round-brief.ts`, `src/round-model.ts` | Round budget judge, deterministic round opening, per-round model/thinking routing |
| `src/tool-policy.ts`, `src/prompts.ts` | Tool loadouts and role prompts |
| `src/tasks.ts`, `src/board.ts` | Task board, readiness, atomic reservation, shared mutation queue |
| `src/executors.ts`, `src/sandbox.ts`, `src/pty.ts`, `src/source.ts`, `src/http-session.ts` | Executors, containers, PTY family, bounded source snapshots, actor-local HTTP state |
| `src/policy.ts`, `src/identity.ts`, `src/truth.ts` | Command-policy gate and seeds; sealed identity, substitution and redaction; instrument facts |
| `src/campaign.ts`, `src/ladder.ts`, `src/evidence.ts`, `src/completion.ts` | Engagement frame, derived access ladder, bounded receipts, derived completion |
| `src/broker.ts`, `src/ticket.ts` | Socket authority, command accounting, fresh tickets |
| `src/report.ts`, `src/report-export.ts`, `src/finish-preflight.ts`, `src/cvss.ts`, `src/cvss4.ts` | Report parts, deterministic OWASP-shaped report, preflight, CVSS |
| `src/state/*` | SQLite store, graph, adapter, artifacts, bundles |
| `src/herdr.ts`, `src/roles.ts`, `src/target.ts` | Panes, model/settings validation, CLI parsing |

ARTEX and Strix inform the design but are never run, packaged or trusted. Mechanics tests do not show assessment
effectiveness or superiority over either.
