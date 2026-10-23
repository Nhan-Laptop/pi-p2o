# Planner / Engine runtime contract

Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md). This page is the operator-facing contract.

## Controls

```text
/p2o --target ./source --workers 3 --loop manual
/p2o --target ./source --workers 3 --loop event-driven --executors isolated --target-ops 2 --export
/p2o pause    /p2o resume    /p2o stop
```

- Defaults are manual + shared. Without Herdr, or with `--solo`, Pi stays the working agent and event-driven is rejected.
- `--workers N` is a positive integer cap on concurrent model slots. `--target-ops N` is a separate target-operation
  allowance (shared always 1; isolated multiplies resources). `--max-depth` is kept for compatibility only: workers
  propose tasks, they never spawn children.
- Settings live under `p2o` in `~/.pi/agent/settings.json`: `maxWorkers`, `loopMode`, `executorMode`,
  `maxTargetOperations`, `maxPlannerRounds`, `roles.<role>.model` (full list in [USAGE](USAGE.md)). Bad settings fall
  back to conservative defaults; bad CLI values are rejected. Precedence: CLI → settings → defaults.
- Automatic Planner rounds are extra requests to the existing model, bounded by the confirmed round allowance (not by
  time or money); `resume` cannot renew an exhausted allowance. No heartbeat polling, provider fallback or launch replay.

## Who does what

- **Planner** chooses bounded directions, writes questions/contrasts/stop conditions, reviews evidence, dispatches,
  steers or withdraws, and decides `wait` / `blocked` / finish. Delegated Planner has no shell/net/HTTP.
- **Engine** admits ready accepted work, owns slots and executors, coalesces committed signals, guards extra rounds.
  It has no model and never invents work; an empty frontier with unmet goals stays explained-blocked.
- **Worker** runs one intent with a fresh process, ticket and context, and reports attributed observations and gaps.
  `p2o_request_subtask` only proposes.

`p2o_task {action:"dispatch", ids:[...]}` accepts 1–25 proposed tasks; `p2o_delegate` stays available for immediate
single dispatch. A failed launch drops the attempt and records a blocked signal; a retry needs an explicit Planner
decision. A terminal report frees capacity only after verified retirement; new assignments get new identities and do
not renew the command allowance. `p2o_loop wait` ends a round, not the assessment; `blocked` pauses admission and wakes.
`/p2o pause` leaves admitted workers running; `/p2o stop` revokes them.

### Priority suggestion

`src/priority.ts` derives a suggested 0-100 dispatch priority from recorded facts, so triage order is explainable and
repeatable instead of a number picked by feel. It is a **suggestion only**: the lead's explicit `priority` always wins
and nothing auto-dispatches by score. Starting from a neutral base of **50**, each signal shifts it:

| Signal | Delta |
| --- | --- |
| a reviewed prerequisite is still unmet | −30 |
| purpose is validation or retest (cheap, unlocks a case) | +15 |
| a confirmed+tested claim already gains every capability this claim needs | +20 |
| the target asset already has an owner-accepted finding | +10 |
| the questionKey is already answered by a non-stale coverage cell | −20 |

The result is clamped to 0–100. The weights live in `PRIORITY_WEIGHTS` and are mirrored here; `tests/minimal/priority.test.ts`
reads the constants so the table and the source cannot drift.

The derivation is applied to the work that can start now and surfaced as one segment of the situation line
(`next: validation 65`). Two facts only exist where their data lives: a **ready chain step** is by definition the claim whose
every required token an existing confirmed+tested claim provides, so the +20 block applies to it; a **task record** carries no
link to the claim it will produce, so a task never receives that block until the lineage gate (P9) joins them. That gap is
why the segment names only the purpose and the score — the lead compares it with `p2o_graph {action:"chain"}` and then
decides. Nothing reads the suggestion back: no admission path, no reordering.

## Pi boundary

Only event-driven consent allows extra rounds. Committed reports, proposals and review/revise/withdraw produce
signals; stdout, notes and reads do not. A reserved round is void after pause, stop or epoch change; input veto and
context/abort guards cover late delivery. An accepted remote request cannot be un-charged by stop.

## State, rollback

Ledger v2, task statuses, owner-only writes, report manifests, evidence/independence gates and until-stopped tickets
are unchanged; there is no authority recovery from disk. Stop any active assessment before reloading the extension
(tickets bind its bytes). Rollback = stop, use manual + shared or solo, start a newly confirmed assessment; a failed
cleanup stays disclosed and `/p2o stop` retries it.

Still open: incremental indexes and archival checkpoints, durable Planner todo at scale, warm process reuse,
provider stop races, token/cost governance. No paid benchmark has been run for this design.
