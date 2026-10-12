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
- `src/tool-policy.ts` enforces loadouts: a delegated Planner cannot shell/net/HTTP; workers cannot accept, review or
  dispatch; reporting workers cannot execute or record candidates.
- Worker tickets bind identity, token, run, image, extension bytes and runtime profile; they last until stopped and are
  revoked by report, withdrawal or socket loss. A wrong model/thinking profile fails closed.
- Every target operation re-checks scope, ticket, task readiness and budget. Scope is agent policy, not an egress
  firewall; same-user processes can copy a live token (no same-user isolation is claimed).

## Tasks, reports, wakes

- Tasks are owner-authored revisions; dispatch pins reviewed support atomically and every worker command rechecks it.
- A report persists (hashed parts, manifest, task transition, coverage, open items) **before** revocation and
  notification. Capacity is reused only after verified pane/executor retirement; each assignment is a fresh process.
- Manual loop (default) dispatches accepted work but never calls a Planner model by itself. Event-driven wakes use Pi's
  normal `sendUserMessage` path with a marked extension-origin prompt, so scope instructions stay intact. A provider
  error pauses automatic wakes without retry.

## Execution

- Shared executor: `Sandbox.enqueue` serializes target operations; cancelling can remove the executor and interrupt peers.
  Isolated: fresh source copy, scratch, cookies and container per assignment, gated by a separate target-operation semaphore.
- HTTP is exact-origin checked on every redirect with the destination pinned; shell/net are not origin-filtered
  ([boundaries](HTTP_TRANSPORT.md)). Containers: non-root, read-only root and source, dropped capabilities, no host or
  provider credentials. Docker shares the host kernel; this is not VM isolation.

## Persistence, budgets, teardown

- Canonical state is one SQLite file per run ([AssessmentStore](STATE_STORE.md)); the older JSONL ledger is still read.
- Defaults: 3 model slots (operator-selected, no hard ceiling), 100 live tasks, 1,000 registrations, 256 pending signals,
  200 commands/worker (90% reserve of 600). No elapsed deadline anywhere; unknown cost is not zero.
- Stop closes the Engine gate first, then drains, revokes, closes panes and verifies containers. Finish refuses while
  workers are unreported, runs the finish preflight (`p2o.finishGate`), freezes state, cleans up and writes the
  deterministic report (`p2o.autoReport`); a report or preflight failure never blocks cleanup. Hard kills can leave
  containers or panes behind; nothing reclaims them automatically.

## Implementation map

| File | Responsibility |
|---|---|
| `extensions/p2o/index.ts` | Pi adapter: commands, tools, lifecycle, consent, loadouts, cleanup |
| `src/engine.ts`, `src/planner-bridge.ts` | Frontier, slots, semantic signals, rounds, wake encoding |
| `src/tool-policy.ts`, `src/prompts.ts` | Capability enforcement; Planner/solo/worker responsibilities |
| `src/tasks.ts`, `src/board.ts` | Task board, readiness, atomic reservation, `LedgerBoard` mutation queue |
| `src/executors.ts`, `src/sandbox.ts`, `src/http-session.ts`, `src/source.ts` | Executors, containers, actor-local HTTP state, bounded source snapshots |
| `src/broker.ts`, `src/ticket.ts` | Socket authority, budgets, fresh tickets |
| `src/records.ts`, `src/evidence.ts`, `src/report.ts`, `src/report-export.ts`, `src/cvss.ts`, `src/finish-preflight.ts` | Provenance, evidence, report parts, deterministic OWASP-shaped report, CVSS 3.1, finish preflight |
| `src/state/*` | SQLite store, graph, adapter, artifacts, bundles |
| `src/herdr.ts`, `src/roles.ts`, `src/target.ts` | Panes, model/config validation, CLI parsing |

ARTEX and Strix inform the design but are never run, packaged or trusted. Passing mechanics tests does not show
assessment effectiveness or superiority over ARTEX.
