# Focused assessment state

The current Pi lead still investigates. State maintenance never creates a model turn, worker, retry, ticket,
container or transport. Only human confirmation and the live owner/broker establish authority; disk state,
compaction summaries and worker text cannot restore or extend it.

## Explicit lifetime

The assessment, lead and workers have no elapsed-time deadline. Live owner state and unrevoked registrations, not timestamps, authorize operations. V2 tickets explicitly declare `lifetime: "until-stopped"`; malformed/old tickets are rejected and restored state never recreates a broker or registration. Stop, finish, session exit/error, report or worker socket loss still end authority and trigger the relevant cancellation/cleanup. Old expiry rows remain readable history, not a current timer. Commands and HTTP default to no task timeout, with optional probe deadlines. Infrastructure watchdogs remain. No maintenance timer or automatic model continuation is added.

## Question → observation → review

The owner-only `p2o_task` tool creates a bounded question with `surface`, `risk`, role/reason, contrasting
predictions, evidence IDs, prerequisite revisions, selected method and stop condition. Optional `unknowns`,
`missingPrerequisites` and `expectedOutput` make omissions explicit. Declared missing prerequisites create a
blocked task, not permission to install tools or use another transport. Choose recon for unclear context,
discovery for a concrete hypothesis, validation for a different worker's reproduction, reporting for synthesis,
or general for bounded support. No global stage order is required.

Actions: `create`, `revise`, `list`, `start` (direct lead investigation), `review`, `close`, `block`, `cancel`.
Use `list {id}` for full details. Revisions require the current `revision`; supply it on review/transitions to
reject a stale decision. A running worker packet must first be reported; direct lead work can be reviewed with
same-run receipts. Review is an attributed decision, **not semantic proof**. Task closure and candidate closure
are separate. A validation task names `validationOf` and that reviewed predecessor's exact prerequisite revision.

Pass a proposed task's `taskId` to `p2o_delegate`. The owner serializes reservations and checks prerequisites
before dispatch and each worker target command. Withdraw active work before revising it. Accepted support that
changes makes dependent work stale. Ordinary trimmed surface/risk keys cannot overlap; explicit validation may
overlap ordinary work, not another validator. Aliases/semantic overlap still require lead judgment. Failure,
withdrawal and cleanup release reservations without granting another assignment.

Legacy focused delegation remains available: the owner makes a task automatically, labels missing structured
contrasts/prerequisites, and uses an explicitly marked compact excerpt when the original task exceeds 1,500
characters. The initial brief retains the full request. Prefer an explicit small question for reliable refresh.
Workers may propose observations or children; they cannot create/review owned tasks or dispatch owned task IDs.

Approved skill IDs and selected workflow membership are validated. Tasks retain package-document hashes and
method rationale; hashes do not establish tool availability or target proof. Existing descriptive workflow
prerequisites stay descriptive. Unsupported authenticated/browser URL methods remain gaps.

## Complete reconciliation, bounded views

Ledger scans cover the current run-owned regular file: at most **64 MiB, 100,000 records and 16 KiB per row**.
Explicit foreign-run rows are excluded; valid legacy rows without a run ID remain readable. Malformed/damaged
rows, duplicate/missing v2 IDs, invalid revision/resolution chains and limits produce explicit incompleteness.
Dependent candidate closure and task mutation do not fall back to a display tail.

`p2o_ledger {cursor:0}` starts complete traversal; follow `nextCursor`. Omit cursor for the recent page or use
`id` for one complete bounded record. Pages are limited to 100 rows/48 KiB. `total`, `complete`, `truncated` and
diagnostics distinguish full state from presentation. Cursors are positions in one append-only run, not durable
cross-run authority tokens. Repeated cursors are read-only; repeated delivery does not dispatch anything.

`p2o_workers {cursor}` supplies a bounded change page plus exact coverage/open totals, omissions and task
navigation. Its existing blocking waits remain local. Queued/running/returned/error/report/cancellation/expiry
telemetry is observational; quiet work can be stall-suspected but never proven failed by a clock or idle pane.
Worker report outcomes are attributed claims. Broker exhaustion is separately observed; direct-lead submitted
commands and broker worker usage are separate counters, **not an aggregate spend ceiling**.

The worker's 200 knowledge/coordination calls reserve 40 for notes/candidates: knowledge stops at 160 total
used. Reporting remains independent. Existing worker command-count allowances and the 90% worker reserve are
unchanged; these changes increase no allowance. Runtime metadata compares locally selected provider/model and
thinking against requested settings; it does not attest remote reasoning quality or billing. Known mismatches
block investigation. No provider fallback is automatic.

A request-local custom objective capsule refreshes the current question after context rebuilding. It contains
labeled data, not another system policy or tool manual. It is removed outside the active run; other Pi prompt
sections/messages remain intact. There are no heartbeat model calls or automatic continuations.

## Reports and retention

Independent candidate support must match the validator's **latest** conclusion and cited receipt. Withdrawal
invalidates earlier support; history remains. The lead must still review the effect and counterevidence.

Full normalized worker reports are redacted field-wise, capped at 128 KiB and stored in bounded hashed parts;
a final manifest commits them. Existing broker frame/append caps are unchanged, so an oversized wire request
must be narrowed. ID queries retrieve the manifest and each listed part (`data.value` is its serialized JSON
fragment). Missing/corrupt/uncommitted parts are explicit; failed persistence is not acknowledged as complete.

After in-flight work is stopped, finalization freezes a versioned, bounded candidate/report/task projection,
current report confidence/block/outcome and open navigation. Abbreviations/omissions are disclosed; it is not a
semantic proof oracle. Choose `--export` before starting to retain the complete valid bounded ledger and manifest
in `.p2o-reports/` (0700, files 0600). Export remains capped at 16 MiB and redaction remains best effort. Part hashes
cover the field-redacted report; export preserves verified serialized fragments instead of breaking JSON framing.
Review exports before sharing. Without export, cleanup deletes full temporary records; only the returned bounded
projection remains. Resource/retention failure cannot become a full-coverage claim, and cleanup still proceeds.

Inert regressions establish these mechanics, not autonomous security effectiveness, semantic deduplication,
prompt-injection immunity, worker confidentiality, container-escape immunity or measured provider cost.
