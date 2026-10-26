# Focused assessment state

The Planner works from bounded **questions** and attributed **reviews**, not from chat memory. Only the human
confirmation and the live owner establish authority; disk state, summaries and worker text cannot restore it.

## Question → observation → review

- `p2o_task_create` (planner only) creates a bounded question: surface, risk, role, contrasting predictions, evidence IDs,
  prerequisite revisions, method and stop condition. Missing prerequisites create a **blocked** task.
- Verbs: `p2o_task_create`, `p2o_task_revise` (needs current `revision`), `p2o_task_dispatch`, `p2o_task_review`,
  `p2o_task_settle`; `p2o_board` is the only list/view reader and runs `match` on tasks ([work admission](WORK_ADMISSION.md)). Use the board `id` view for one task in full.
- A running worker packet must be reported first. Review is an attributed decision, **not proof**; closing a task and
  closing a candidate are separate. A validation task names `validationOf` and the reviewed predecessor revision.
- Dispatch pins accepted support; revised support makes dependents stale. Surface/risk keys cannot overlap between
  ordinary tasks (explicit validation may overlap), but aliases still need Planner judgment.
- Workers propose via `p2o_request_subtask`; they cannot create, review or dispatch tasks.
- Skill IDs and workflow membership are validated; hashes identify package documents, not tool availability or proof.

## Reading state in bounded pieces

- Ledger scans cover the run's own file: ≤64 MiB, 100,000 records, 16 KiB/row. Damage, duplicates and broken chains
  produce explicit incompleteness; mutations never fall back to a display tail.
- `p2o_ledger {cursor:0}` starts a complete traversal (follow `nextCursor`, ≤100 rows/48 KiB per page); `id` returns one
  full record. `total`/`shown`/`omitted`/`complete`/`truncated` distinguish state from presentation: every capped list
  (`p2o_board`, `p2o_graph` page/export/chain, `p2o_ledger`) reports what it shows
  against what exists, so a short or empty page is never read as an empty board. Caps are unchanged; the pair is one count.
  Test: `tests/minimal/projection-counts.test.ts`.
- `p2o_workers {cursor}` returns a change page with exact coverage/open totals. Quiet work can be *suspected* stalled,
  never proven failed by a clock.
- Counters are observations, not ceilings: worker command/usage counts are shown and reported, and nothing refuses a
  command because of one. Provider/model/thinking are compared locally against the request; a known mismatch blocks
  investigation; no provider fallback. A run stops because two rounds added nothing (M6), not because a total ran out.
- `src/authority.ts` derives the run's authority counters from committed records only (no model, no target): planner and
  worker target operations, tasks created/dispatched with the first dispatch timestamp, owner and worker claims, validation
  tasks and stalled rounds, plus the static role matrix (planner 23, worker 17, validation 16, reporter 6) and the run mode.
  `plannerTargetOps` and `ownerClaims` are the two measured invariants (0 after P0/A1 and P1/A2); a legacy run keeps its
  honest >0, and no counter refuses a command, wakes a model or finishes a run.
- A request-local objective capsule refreshes the current question after context rebuild; it is data, not policy.

## Hoàn tất được suy ra (M3)

Run không có "lệnh hoàn tất". `src/completion.ts` suy ra `complete` chỉ khi: mọi goal đã `reviewed`/`closed` **và proof của nó
còn đúng** (`src/goal-proof.ts`), không còn claim `confirmed`+`tested` nào chưa được consume, và không còn bước chain nào ready
(trừ bước đang được một task sống nhận). Goal `reviewed` mà proof không còn đúng (case bị `disputed`, coverage plan không còn mọi
cell terminal — cell dẫn xuất được chiếu lại khi đọc, plan legacy mở lại cell đã lưu — hoặc row cũ không có `proof`) là
`GOAL_UNPROVEN`, không phải đã settled.
`remaining` là tổng số nghĩa vụ đó; mỗi nghĩa vụ có mã (`GOAL_UNSETTLED`, `GOAL_UNPROVEN`, `PRIMITIVE_UNCHAINED`, `CHAIN_READY`) và id.

Hai verb tách quyền: `p2o_finish {export:true}` reconcile rồi ghi `REPORT.md`/CSV và **không kết thúc gì** (worker, sandbox,
run giữ nguyên; export lại được, thư mục mới `-export-N`); `p2o_finish` không có `export` vẫn là báo cáo cuối (dừng worker,
dọn sandbox). `/p2o stop` ghi nghĩa vụ còn lại vào outcome (`run.stopped` summary + `remaining`) nên người đọc sau biết run
dừng giữa đâu. `REPORT.md` có mục `## REMAINING WORK` với trạng thái hoàn tất và bảng nghĩa vụ; preflight codes là **fact của
báo cáo**, không phải điều kiện từ chối — p2o không có finish gate.

Situation line thêm cặp backlog của coverage: `coverage <tested>/<cells> (planned <n> unreached, <m> omitted)`, để "không
hiển thị" không bị đọc thành "không nằm trong kế hoạch". `<cells>` là cell hiện hành của projection (cell dẫn xuất từ A3, hoặc
cell lưu của plan legacy); `<m> omitted` chỉ khác 0 với plan legacy vì plan projected không có cell lưu để bỏ.

## Reports and retention

- Independent support must match the validator's **latest** conclusion and receipt; withdrawal invalidates it.
- Full worker reports are redacted field-wise (≤128 KiB), stored as hashed parts and committed by a manifest; missing
  or corrupt parts are explicit, failed persistence is never acknowledged.
- A planner round that ends with an open goal, no open/running intent and no blocked declaration is recorded as one
  `planner.stalled` lifecycle fact; every such round is recorded (no dedupe) and it is a report fact, never a wake, queue
  entry, pause or budget. It shows up as `stalled rounds N` in the status Frontier line and in REPORT.md provenance, next
  to the authority counters and role matrix, so the report says which policy produced the run.
- After in-flight work stops, finalization freezes a bounded projection. `--export` keeps the full valid ledger in
  `.p2o-reports/` (0700/0600, ≤16 MiB, best-effort redaction: review before sharing); without it, temporary records are deleted.

Inert tests establish these mechanics, not security effectiveness, deduplication, prompt-injection immunity or cost.
