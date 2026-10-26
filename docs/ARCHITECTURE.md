# Architecture: Planner / Engine / Worker

```text
/p2o --target …  parse → classify → human consent (scope, resources, models)
  → PLANNER   the current Pi conversation: plans, reviews, dispatches, decides wait/blocked/finish
  → ENGINE    deterministic TypeScript, no model: accepted frontier → slot → fresh worker
  → WORKER    fresh Pi process in a visible Herdr pane, one bounded intent, brokered execution
  → EXECUTOR  shared (one serial queue, default) or isolated (own sandbox per assignment)
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

- Shared executor: `Sandbox.enqueue` serializes target operations; cancelling can remove the executor and interrupt peers.
  Isolated: fresh source copy, scratch, cookies and container per assignment, gated by a separate target-operation semaphore.
- HTTP follows redirects to any http(s) host and pins the destination; shell/net are not origin-filtered either
  ([boundaries](HTTP_TRANSPORT.md)). Containers: root with a writable rootfs and all capabilities, read-only `/target`,
  no host or provider credentials. Docker shares the host kernel; this is not VM isolation.

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
| `src/tool-policy.ts`, `src/prompts.ts` | Tool loadouts (planner 23, worker 17, validation 16, reporter 6); role prompts state the same split |
| `src/tasks.ts`, `src/board.ts` | Task board, readiness, atomic reservation, `LedgerBoard` mutation queue |
| `src/executors.ts`, `src/sandbox.ts`, `src/http-session.ts`, `src/source.ts` | Executors, containers, actor-local HTTP state, bounded source snapshots |
| `src/broker.ts`, `src/ticket.ts` | Socket authority, command accounting, fresh tickets |
| `src/records.ts`, `src/evidence.ts`, `src/authority.ts`, `src/report.ts`, `src/report-export.ts`, `src/cvss.ts`, `src/finish-preflight.ts` | Provenance, evidence, authority counters, report parts, deterministic OWASP-shaped report, CVSS 3.1, finish preflight |
| `src/state/*` | SQLite store, graph, adapter, artifacts, bundles |
| `src/herdr.ts`, `src/roles.ts`, `src/target.ts` | Panes, model/config validation, CLI parsing |

ARTEX and Strix inform the design but are never run, packaged or trusted. Passing mechanics tests does not show
assessment effectiveness or superiority over ARTEX.
