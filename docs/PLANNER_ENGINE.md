# Planner/Engine runtime contract (0.5.0)

This implements the core of [planning_update.md](../planning_update.md), not every long-run/rollout requirement.
Historical acceptance artifacts remain baseline-specific. Source mechanics acceptance is not installed acceptance,
paid-provider cancellation proof, assessment effectiveness or an ARTEX comparison.

## Operator controls

```text
/p2o --target ./source --workers 3 --loop manual
/p2o --target ./source --workers 3 --loop event-driven --executors isolated --target-ops 2 --export
/p2o pause
/p2o resume
/p2o stop
```

All startup flags are opt-in/confirmed. Manual + shared is default. Without Herdr or with `--solo`, Pi remains the
working agent; event-driven mode is rejected without delegation. `--workers` accepts positive safe integers,
not unlimited workers or a guarantee the host/provider can afford them. `--target-ops` is a separate positive target-operation allowance, not a model-slot setting. Shared mode enforces
one operation; isolated multiplies the resource envelope. Actual per-assignment queues can further reduce parallelism.
`--max-depth` remains parsed for compatibility/policy, but workers propose tasks rather than spawn children.

Supported settings under `p2o`:

```json
{
  "maxWorkers": 3,
  "loopMode": "manual",
  "executorMode": "shared",
  "maxTargetOperations": 1,
  "maxPlannerRounds": 100,
  "roles": { "validation": { "model": "opencode-go/kimi-k3" } }
}
```

These are actual keys; `maxConcurrentWorkers`, `maxConcurrentTargetOps`, `supervisionHeartbeat`, `retryPolicy`
and `workerCommandAllowance` from the original plan are not APIs. Malformed settings fail to conservative defaults;
invalid explicit CLI values are rejected. Automatic rounds are extra existing-model requests, bounded by the
confirmed round allowance, not by elapsed time or monetary/token cost. Resume cannot renew an exhausted allowance.
There is no heartbeat model polling, provider fallback, automatic launch replay or implicit restored authority.

## Responsibilities and workflow

- **Planner:** choose meaningful bounded directions, author methods/questions/contrasts/stop conditions, retrieve
  evidence, accept/review/steer/withdraw, and decide wait/blocked/finish. No delegated shell/net/HTTP or direct start.
- **Engine:** admit ready accepted work, own async lifecycle/slots/executors, coalesce committed signals and guard
  additional rounds. It has no model and cannot invent questions.
- **Worker:** autonomously execute one intent with a fresh process/ticket/context. Report attributed observations
  and gaps. `p2o_request_subtask` records a proposal; it never accepts work. Reporting has no execution/candidates.

Create an owner task, then `p2o_task {action:"dispatch", ids:[...], priority:0}` accepts 1–25 proposed tasks.
Dependencies may be queued before review; revision can be omitted until atomic reservation pins reviewed support.
Revised support is rechecked before every worker command. Failed launch drops the queued attempt and records a
blocked signal; a new attempt needs an explicit Planner decision. Immediate `p2o_delegate` remains compatible,
with missing structured information explicitly labeled rather than invented as proof.

A terminal committed report frees logical capacity only after pane/executor retirement is verified. A new
assignment gets a new worker ID/token/ticket/session; it does not inherit old conversation, scratch or budget.
Fresh identities do not renew the run command allowance. 30 sequential assignments at capacity 3 are covered by
regressions; this is not warm Pi/process reuse. Retained registrations remain bounded at 1,000.

`p2o_loop {action:"wait", reason:...}` records a decision and ends the current round, not the assessment.
`blocked` pauses admission and automatic wakes. `/p2o pause` leaves already admitted workers active; `/p2o stop`
revokes them and closes the epoch before cancellation. Human input takes priority at eligible settlement boundaries.
An empty feasible frontier with unmet goals must stay explained blocked/human-needed, never fabricated work.

## Pi boundary contract

Only explicit event-driven consent allows additional Planner rounds. Reports notify after persistence, terminal
registration state and revocation. Proposals and reviewed/revised/withdrawn tasks signal separately. Ordinary
stdout/note/read activity is not a wake. Signals use a fixed 100 ms coalescing window, not periodic paid polling.
A reserved round is invalid after pause/stop/epoch change; input veto and context/abort guards protect late delivery.

Real Pi 1.0 tests cover idle wake, settlement continuation, pending human follow-up priority, prompt/loadout
preservation and obsolete-wake veto before accepted inert provider requests. Idle wake uses one clearly marked
extension-origin **user-role semantic prompt**, followed by a typed custom entry, so Pi's normal prompt pipeline
reinstates scope. It is not represented as human authorization or periodic polling. Direct custom-message
`triggerTurn` was rejected by the spike because it bypassed `before_agent_start` and lost scoped instructions.
The adapter never clears conversation messages or calls command-only session APIs in event handlers.

Stop is not a way to undo an already accepted/charged remote request. Inert tests cannot prove a provider honors
abort or reverses billing; the input veto prevents queued obsolete requests from being admitted. Context abort and
all-tool denial are defense in depth for an input-to-request race. Provider errors pause automatically, not retry.

## State, migration and remaining work

Ledger v2, task statuses, owner-only writes, report manifests, evidence/review/independence gates, HTTP scope and
until-stopped tickets are preserved. Optional queued revisions are additive. Legacy reviewed revisions remain
readable; old expiry rows remain history. There is no authority migration/recovery from disk. Stop an older active
assessment before reload; do not hot-swap an extension whose worker tickets bind its bytes.

Live task cap is now 100 (closed/cancelled/expired history does not consume it); reopening cannot bypass the cap.
Pending queue cap is 100; event backlog 256; bounded ledger/export/control/retention limits remain. Request-local
capsules navigate current tasks/frontier/deltas and persist round decisions to provenance outside chat. They are
not receipt substitutes, a full durable todo database, incremental indexes or automatic restart/resume.

Remaining P5/P6 work: incremental indexes/archival checkpoints, durable structured Planner todo, large-history
performance measurements, warm assignment-safe process/session reuse, broad provider/version stop races and
installed publication/hash acceptance. Token/cost governance and effectiveness/labeled-control studies are
separate work requiring explicit authorization; no live/paid benchmark has been run for this redesign.

Rollback without restoring old authority: stop, use manual loop + shared executor or solo, and start a newly
confirmed assessment. Never reuse old tickets/sockets/sessions to repair a run. Failed cleanup stays disclosed and
requires `/p2o stop` retry after infrastructure recovery.
