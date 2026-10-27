# Architecture: Planner / Engine / Worker

```text
/p2o --target …  parse → classify → human consent (scope, resources, models)
  → PLANNER   the current Pi conversation: plans, reviews, dispatches, decides wait/blocked/finish
  → ENGINE    deterministic TypeScript, no model: accepted frontier → slot → fresh worker
  → WORKER    fresh Pi process in a visible Herdr pane, one bounded intent, brokered execution
  → EXECUTOR  shared (one serial queue by default; an explicit --target-ops N lifts it), isolated (own sandbox per assignment) or session
              (long-lived run-owned executor: shell cwd/state, optional PTY, listeners)
  → stop/finish: close Engine gate → drain/cancel → revoke → close panes → verify containers
```

**Core idea.** The Planner is the model the operator already selected. Pi owns its inner tool loop;
`AssessmentEngine` owns the outer scheduling loop. Nothing runs at load time and nothing polls: event wakes are
finite coalescing windows (100 ms) that need explicit event-driven consent. See [Planner/Engine contract](PLANNER_ENGINE.md).

## Authority

- Only the live owner process holds consent, broker, executors and cleanup. Transcripts, ledger history and
  summaries never recreate authority after a restart.
- `src/tool-policy.ts` gives each role its own loadout: the planner creates, dispatches and reviews intents and has no
  target, lab or claim tool; a worker holds the target/lab/candidate/note/surface set and is the only claim author; a
  reporting worker is a read-only second reader. Workers cannot accept, review or dispatch.
- The role prompts (`src/prompts.ts`) state the same split as short, literal role lines: planner first action is one
  recon/mapping intent, no target operations, no candidate authorship, coverage as a projection of reviewed work and a
  zero-intent round as not progress; worker "one intent, write back, report, stop"; reporter read-only with no target
  operations, no candidate authorship and no verdict or plan change. The prompt is advisory; the loadout is the
  enforcement, and dispatch of an intent is the only path to target execution.
- Worker tickets bind identity, token, run, image, extension bytes and runtime profile; they last until stopped and are
  revoked by report, withdrawal or socket loss. A wrong model/thinking profile fails closed.
- Every target operation re-checks scope, ticket and task readiness. Scope is agent policy, not an egress
  firewall; same-user processes can copy a live token (no same-user isolation is claimed).

## Tasks, reports, wakes

- Tasks are planner-authored revisions; dispatch pins reviewed support atomically and every worker command rechecks it. A task
  also states what it stands on: validation/retest cite the claim they reproduce (`work.claimRefs`) or the task they revisit,
  investigation/refinement cite a claim, a pinned asset revision or a prior task, and mapping/reporting are exempt because they
  are the starting point. The refusal is a field on the task, not an inference by the reader.
- A claim may declare typed `gained`/`needs` capabilities (`kind` plus optional `subject`/`scope`); `p2o_graph action=chain`
  joins them into ready/unmet steps so the planner reads one frontier instead of reconstructing the chain from prose. A pre-P14
  claim that still carries free-text `provides`/`requires` stays readable, is reported as legacy, and joins to nothing.
- A report persists (hashed parts, manifest, task transition, coverage, open items) **before** revocation and
  notification. Capacity is reused only after verified pane/executor retirement; each assignment is a fresh process.
- A planner round that ends with an open goal and no open/running intent is recorded as a `planner.stalled` report fact
  (one lifecycle record per occurrence, counted in the engine snapshot) instead of passing silently; it schedules nothing —
  no wake, queue entry, pause or budget.
- Coverage is a read-time projection, not a stored denominator: the host derives each cell from a reviewed task with a work
  identity, the worker claim stamped with that task (`data.taskRef`), the current accepted case and the pinned graph asset
  revision. `p2o_coverage_plan` records scope and review state only; a task without any work asset is an unmapped gap, and
  staleness only downgrades a derived cell.
- Manual loop (default) dispatches accepted work but never calls a Planner model by itself. Event-driven wakes use Pi's
  normal `sendUserMessage` path with a marked extension-origin prompt, so the objective context stays intact. A provider
  error pauses automatic wakes without retry.

## Execution

- Shared executor: `Sandbox.enqueue` serializes target operations by default; an explicit `--target-ops N` (N>1) with shared
  sets `concurrentOperations` on that one sandbox so up to N target operations overlap, while provisioning/scratch/cleanup stay
  serial. Cancelling can remove the executor and interrupt peers.
  Isolated: fresh source copy, scratch, cookies and container per assignment, gated by a separate target-operation semaphore.
- HTTP follows redirects to any http(s) host and pins the destination; shell/net are not origin-filtered either
  ([boundaries](HTTP_TRANSPORT.md)). Containers: root with a writable rootfs and the Docker default capability set (raw sockets work), read-only `/target`,
  no host or provider credentials. Docker shares the host kernel; this is not VM isolation.
- `--executors session[:N]` adds a third mode: `N` (default `= --target-ops`, never above it) long-lived, run-owned
  executors each holding one shell cwd/state and one optional PTY, so a chain step can start where the previous one
  stopped without shipping every byte through a fresh container. `p2o_session` opens/lists/execs/snapshots/closes them,
  and `send`/`read` drive the PTY of the current assignment; `src/pty.ts` is the in-process PTY family (cursor, bounded
  tail, fail-closed cleanup) and the broker carries the same verbs to the worker. Cleanup removes sessions with their
  containers; a session that dies fails closed, so the next step must open a new one — nothing is resumed or recreated
  automatically.
- Ingress is operator-provided, never host-published: `--callback <url>` records the out-of-band destination the target
  reaches (a recorded fact, not a listener), and `--lab-network <name>` joins the sandbox to a throwaway docker network so
  `p2o_session action=listen {port}` can start a bounded logging catcher inside the session container
  (`<container>:<port>`, tcp only, at most four per session). No port is ever published and no tunnel/pivot is provided;
  the report names which ingress path existed.

## Access ladder, policy and identity

- The campaign record (v2) carries the engagement shape the whole run is held to: `mode` `exploit` (default) or
  `assess` (opt-in, no exploitation step is admitted and the report prints one line instead of a ladder) and the
  authorized `effectClasses` (default: every `CASE_EFFECTS` class except `availability-loss`). Admission reads that
  record; a mode/effect it does not admit is refused with the legal next, and the recorded frame is immutable.
- Evidence is bounded at the receipt: a bounded, best-effort-redacted excerpt (input ≤2000 B, stdout ≤16 KiB, stderr
  ≤4 KiB), so a claim cites a receipt rather than an unbounded transcript. `src/ladder.ts` derives the rungs
  (`observed`, `executed`, `controlled`, `crossed`, `impact`) from reviewed claims and their `gained`/`needs` edges at
  report time; it is a projection, never stored state. `## Access ladder` prints the derivation or the honest reason there is none.
- One dispatch seam (`executeWithReceipt`) runs the command-policy gate **before** any secret substitution or target
  operation: 8 seed deny rules (disable-able per seed, disabled seeds are named in the report) plus operator rules evaluated for
  `shell`, `net`, `http` and `send`; the PTY write path goes through the same seam. A deny refuses with the rule and origin; an ask is written to the ledger and waits
  for `/p2o approve policy-ask-<id>` or `/p2o deny <id>`, and a decision binds to the exact request hash, so it can never
  authorize a different command. Policy lives in the `p2o.commandPolicy` setting.
- Identity is one operator JSON file (`--identity`): the host seals a copy plus sha256 in the control directory, keeps
  values out of every model-visible surface (`p2o_secret` lists metadata only, a ticket only carries the count), and
  substitutes values at the seam after policy allows — shell-quoted for shell/net, raw for PTY `send`, request-side for
  HTTP with the `principal` cookie-jar dimension. Every use is audited; exports and reports carry redacted text only.
  Redaction is best-effort: a worker can print or encode a value and the container sees the resolved command line, and
  the report states that limit.
- Chain economy removes the per-rung tax without weakening independence: a worker may report with `holdFor` and keep its
  ticket/pane/session for `holdContinuations` successors (0..3, default 1; 0 retires the ticket), the owner dispatches a
  successor onto the same worker
  (`p2o_task_dispatch {workerId}`, task `proposed`, same role, citing that worker's claims), and `p2o_workers continue`
  consumes one held continuation. No timer expires a hold; stop/finish release it, and the finish preflight advises
  `HELD_WITHOUT_SUCCESSOR`. A demonstrated successor also lets the host skip replaying one intermediate validation claim;
  the deepest rung always keeps its replay.
- Runtime steering is append-only: `p2o_loop hint|constrain {text}` records a bounded operator sentence in the ledger
  (caps 24 hints / 12 constraints), rendered into the next planner prompt. Constraints narrow absolutely, hints never
  widen the frame, and `--allow` is a recorded permission only — a deny still wins. There is one goal authority (the plan
  board); `p2o_loop` has no goal action.

## Persistence, accounting, teardown

- Canonical state is one SQLite file per run ([AssessmentStore](STATE_STORE.md)); the older JSONL ledger is still read.
- Defaults: 3 model slots (operator-selected, no hard ceiling), 1,000 registrations, 256 pending signals; no live-task ceiling.
  **No command allowance exists** (owner decision 2026-10-24): the broker counts every admitted target command for the ledger and the
  report, and refuses none of them. The retired class allowance (200, or 400 for `exploitation`/`chaining`) and its `wrapUp`
  obligation are gone with it, as are the per-worker read/coordination splits, `work.budget` and `maxPlannerRounds`. No count in
  the loop is a ceiling: two quietly unproductive rounds (M6) or the human end a run, and transport bytes bound what a record can
  carry. **Count caps on tool input are gone too** (owner decision 2026-10-24, second pass): a chain may have more than eight
  steps, a recipe more than eight commands, a report more than twenty findings, a worker more than one continuation.
- `src/authority.ts` is the read-only authority view: target operations by planner vs worker, tasks created/dispatched and
  the first dispatch, owner vs worker claims, validation tasks and stalled rounds, plus the static role matrix. The same
  object feeds `reportProjection`, `/p2o status` and REPORT.md provenance. `plannerTargetOps` and `ownerClaims` are the
  measured invariants that must be 0 after P0/A1 and P1/A2; legacy runs keep their real numbers, and nothing gates on a
  counter.
- Stop closes the Engine gate first, then drains, revokes, closes panes and verifies containers. Finish refuses while
  workers are unreported, runs the finish preflight (report only — there is no `p2o.finishGate`), freezes state, cleans up and writes the
  deterministic report (`p2o.autoReport`); a report or preflight failure never blocks cleanup. Hard kills can leave
  containers or panes behind; nothing reclaims them automatically.

## Implementation map

| File | Responsibility |
|---|---|
| `extensions/p2o/index.ts` | Pi adapter: commands, tools, lifecycle, consent, loadouts, cleanup |
| `src/engine.ts`, `src/planner-bridge.ts` | Frontier, slots, semantic signals, rounds, stalled-round facts, wake encoding |
| `src/tool-policy.ts`, `src/prompts.ts` | Tool loadouts (planner 24, worker 19, validation 18, reporter 6); role prompts state the same split |
| `src/tasks.ts`, `src/board.ts` | Task board, readiness, atomic reservation, `LedgerBoard` mutation queue |
| `src/executors.ts`, `src/sandbox.ts`, `src/pty.ts`, `src/http-session.ts`, `src/source.ts` | Executors (shared/isolated/session), containers, PTY family, actor-local HTTP state, bounded source snapshots |
| `src/policy.ts`, `src/identity.ts`, `src/truth.ts` | Command-policy gate and seeds; sealed identity, substitution and redaction; the instrument facts composed into descriptions, prompts and consent |
| `src/campaign.ts`, `src/ladder.ts`, `src/evidence.ts` | Engagement frame v2, derived access ladder, bounded evidence receipts |
| `src/broker.ts`, `src/ticket.ts` | Socket authority, command accounting, fresh tickets |
| `src/records.ts`, `src/evidence.ts`, `src/authority.ts`, `src/report.ts`, `src/report-export.ts`, `src/cvss.ts`, `src/finish-preflight.ts` | Provenance, evidence, authority counters, report parts, deterministic OWASP-shaped report, CVSS 3.1, finish preflight |
| `src/state/*` | SQLite store, graph, adapter, artifacts, bundles |
| `src/herdr.ts`, `src/roles.ts`, `src/target.ts` | Panes, model/config validation, CLI parsing |

ARTEX and Strix inform the design but are never run, packaged or trusted. Passing mechanics tests does not show
assessment effectiveness or superiority over ARTEX.
