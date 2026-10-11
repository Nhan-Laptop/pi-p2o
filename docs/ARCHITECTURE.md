# Planner / Engine / Worker architecture

```text
/p2o --target … [--solo] [--workers N] [--loop manual|event-driven]
                [--executors shared|isolated] [--target-ops N]
  parse → classify → human scope/resource/model consent → owner + ledger + broker + sandbox
  → current Pi conversation: strategic PLANNER (working investigator only in solo mode)
       task create/revise/review/dispatch, evidence retrieval, steer/withdraw, wait/blocked/finish
  → TypeScript ENGINE (not another LLM)
       accepted frontier → readiness + fresh atomic reservation → available model slot → fresh worker
       committed semantic signal → local coalescing → optional authorized Planner round
  → WORKER (fresh real Pi process in visible Herdr pane, --p2o-worker <private ticket>)
       one bounded intent, tactical tool choice, brokered execution, attributed observation/report
       subtask needs → proposal to Planner, never nested dispatch
  → run-owned EXECUTOR POOL
       shared default: one serial shell/HTTP queue
       isolated opt-in: fresh assignment-owned sandbox + separate target-operation semaphore
  → stop/finish: close Engine epoch/gate → drain/cancel → revoke → close panes → verify all containers
```

The Planner is the existing user-selected model, not a hidden SDK/RPC agent. Pi owns its model/tool inner loop;
`AssessmentEngine` owns the deterministic outer scheduling/waiting loop. No timer/process is created by the
extension factory or Engine constructor. Event timers are run-owned, finite coalescing windows, not paid polling.
See [runtime contract and remaining roadmap](PLANNER_ENGINE.md).

## Authority and capabilities

The live owner owns consent, control directory, task board, broker, executor lifetimes and cleanup. Transcript,
compaction, ledger history and summaries never recreate registrations or authority after restart.
`tool-policy.ts` supplies enforced loadouts: delegated Planner cannot shell/net/HTTP or start direct investigation;
solo can. Workers cannot accept/review/dispatch tasks. Reporting workers cannot execute target operations or
record candidates, including through direct broker requests. Discovery cannot certify itself as independent
validation. All target operations still require scope, ticket, owner, current task readiness and budget checks.

Worker tickets bind fresh identity/token, run, image, extension bytes and runtime profile. V2 lifetime is
`until-stopped`: no elapsed deadline, no restored authority. Report, withdrawal or socket loss revokes the
registration. Wrong model/thinking fails closed: **Runtime profile mismatch; report blocked, no investigation**.
Another same-host-user process can copy a live token; same-user isolation is not claimed.

## Tasks, completion and wakes

TaskStatus and ledger v2 are retained; prerequisite revision is additively optional for queued work. Missing IDs
and dependency cycles remain invalid. Dispatch pins reviewed same-run support atomically; every worker command
rechecks current revisions. A revised/withdrawn prerequisite blocks its dependent. Exact surface/risk reservation
is not semantic deduplication. Queue and task lists are separate bounded projections.

Reports persist normalized hashed parts, manifest, task transition, coverage and open items **before** terminal
registration/revocation and completion notification. Engine admission reaps completed panes/executors before
reusing capacity; failed cleanup causes backpressure. Fresh processes are not warm sessions.

Default manual mode dispatches explicitly accepted ready work but never automatically calls a Planner model.
Event-driven mode requires explicit consent and a positive automatic-round allowance. Committed reports,
proposals, reviews/revisions/withdrawals produce semantic signals; stdout, skill reads and noisy notes do not.
One reservation is in flight; signals coalesce and are consumed only by the next request-local projection.

Pi 1.0 idle wakes use the normal `sendUserMessage` pipeline, with a clearly marked extension-origin semantic
prompt and typed custom entry. Direct `sendMessage(triggerTurn)` bypasses `before_agent_start` and loses
structured scope instructions; the real-Pi spike rejected that adapter. Input veto checks current epoch before
any model request. The context hook aborts a late stale wake defensively and denies all tools in that stale turn.
At settlement, a custom entry plus continuation is allowed only with active consent/actionable events, an eligible
boundary and no pending human input. `agent_settled` is observation, not terminal truth or a place to launch work.
Provider error pauses automatic dispatch/wakes without retry or fallback; explicit stop still cleans up.

## Execution and transport

The default shared executor keeps `Sandbox.enqueue` intact. Multiple panes do not mean parallel target execution;
shell cancellation/timeout can remove the shared executor and interrupt peers. Isolated mode multiplies resources:
each assignment has fresh source copy, scratch, cookies, background processes and owned container names. Source
hashes/skipped counts must match the primary bounded snapshot. The target-operation semaphore is independent of
model slots; per-sandbox serialization prevents cookie/session races. No automatic restart occurs after cancellation.

HTTP remains exact-origin checked on every redirect, with arbitrary valid methods, bounded bodies/auth headers,
actor-local cookies, private/internal/IPv6 support and destination pinning. Opaque shell/net egress is not
origin-filtered: scope is agent policy, not an egress firewall. All executors preserve non-root UID, immutable image,
read-only source/root, dropped capabilities, resource/output caps and no host/provider-credential mounts.
See [HTTP boundaries](HTTP_TRANSPORT.md). Docker shares the host kernel; this is not VM isolation.

## Persistence, budgets and teardown

JSONL provenance remains authoritative evidence input, not an authorization database. Complete bounded ledger
reconciliation, revision chains, receipt hashes, current independent conclusions and report-part integrity are
unchanged. Request-local task/frontier/delta capsules navigate evidence and survive chat compaction while the
owner is live. They are not proof, new system policy or unbounded history. Incremental durable indexes, archival
checkpoints and warm-session reuse remain future work; full scans retain their existing bounds.

Capacity defaults to 3 operator-selected model slots. There is no six-worker hard ceiling or cumulative 2× spawn
ceiling. Limits remain: 100 live tasks/pending intents, 1,000 retained registrations, 256 pending semantic signals,
64 MiB/100,000-row ledger and bounded exports. Unverified cleanup prevents reuse. 200 commands/worker and the
unchanged 90% worker reserve of default 600 do not reset with identities. Owner commands are separate; neither
command counts nor automatic-round counts are an aggregate monetary/token governor. Unknown cost is not zero.

Stop closes the Engine gate/increments epoch before draining async work; cancellation cannot reauthorize queued
operations. Cleanup is idempotent/retryable; failure keeps tools gated and is disclosed. Finish refuses unreported
live workers, runs the host preflight (`src/finish-preflight.ts`, gate `p2o.finishGate`), and freezes current state before verified cleanup/export; cleanup then writes the deterministic report (`p2o.autoReport`) before the store is finalized. A report or preflight failure never blocks cleanup. Session navigation/shutdown use the same
cleanup path. Hard kills or Docker loss may leave containers/panes; no automatic startup reclamation is claimed.
Assessment, worker and target operations have no mandatory elapsed timeout; explicit optional timeouts and
infrastructure watchdogs remain. Pausing scheduling does not revoke active workers; stopping does.

## Implementation map

| File | Responsibility |
|---|---|
| `extensions/p2o/index.ts` | Pi command/tool/lifecycle adapter, consent, loadouts, owner/worker activation, cleanup |
| `src/engine.ts` / `src/planner-bridge.ts` | Frontier, slots, semantic signals, epochs/rounds, guarded Pi wake encoding |
| `src/tool-policy.ts` / `src/prompts.ts` | Capability enforcement and strategic/solo/worker responsibilities |
| `src/tasks.ts` | Questions, validity/readiness, atomic reservation, revisions, live frontier and capsules |
| `src/executors.ts` / `src/sandbox.ts` | Assignment ownership, semaphore, serialized container operations, verified removal |
| `src/source.ts` / `src/http-session.ts` | FD-contained bounded source snapshots and actor-local HTTP state |
| `src/broker.ts` / `src/ticket.ts` | Socket authority, budgets/control reserve, post-commit report notification, fresh tickets |
| `src/records.ts` / `src/evidence.ts` / `src/report.ts` | Provenance, complete bounded retrieval, current support, receipts and exports |
| `src/report-export.ts` / `src/cvss.ts` / `src/finish-preflight.ts` | Deterministic OWASP-shaped report (v2: scope, executive summary, rated findings, JSON/CSV), CVSS 3.1 base score, pre-finish check of unfinished review/coverage |
| `src/progress.ts` | Observable diagnostics only; quiet time is not proven failure |
| `src/herdr.ts` / `src/roles.ts` / `src/target.ts` | Fresh pane lifecycle, model/config validation and target/CLI contract |

ARTEX/Strix sources inform architecture, not runtime dependencies or authorization. No reference scripts are
executed or packaged; forced work invention, scope widening, permission bypass and automatic retry are not copied.
Passing mechanics tests does not prove assessment effectiveness, finding correctness or superiority over ARTEX.
