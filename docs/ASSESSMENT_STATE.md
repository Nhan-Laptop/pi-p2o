# Focused assessment state

The Planner works from bounded **questions** and attributed **reviews**, not from chat memory. Only the human
confirmation and the live owner establish authority; disk state, summaries and worker text cannot restore it.

## Question → observation → review

- `p2o_task_create` (owner only) creates a bounded question: surface, risk, role, contrasting predictions, evidence IDs,
  prerequisite revisions, method and stop condition. Missing prerequisites create a **blocked** task.
- Actions: `create`, `revise` (needs current `revision`), `list`, `start`, `dispatch`, `review`, `close`,
  `block`, `cancel`, plus `match` ([work admission](WORK_ADMISSION.md)). Use `list {id}` for one task in full.
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
  (`p2o_board`, the task/case/plan/coverage verbs, `p2o_graph` page/export/chain, `p2o_ledger`) reports what it shows
  against what exists, so a short or empty page is never read as an empty board. Caps are unchanged; the pair is one count.
  Test: `tests/minimal/projection-counts.test.ts`.
- `p2o_workers {cursor}` returns a change page with exact coverage/open totals. Quiet work can be *suspected* stalled,
  never proven failed by a clock.
- Counters are observations, not ceilings: worker command/usage counts are shown and reported, and nothing refuses a
  command because of one. Provider/model/thinking are compared locally against the request; a known mismatch blocks
  investigation; no provider fallback. A run stops because two rounds added nothing (M6), not because a total ran out.
- A request-local objective capsule refreshes the current question after context rebuild; it is data, not policy.

## Hoàn tất được suy ra (M3)

Run không có "lệnh hoàn tất". `src/completion.ts` suy ra `complete` chỉ khi: mọi goal đã `reviewed`/`closed` **và proof của nó
còn đúng** (`src/goal-proof.ts`), không còn claim `confirmed`+`tested` nào chưa được consume, và không còn bước chain nào ready
(trừ bước đang được một task sống nhận). Goal `reviewed` mà proof không còn đúng (case bị `disputed`, cell của coverage plan
được mở lại, hoặc row cũ không có `proof`) là `GOAL_UNPROVEN`, không phải đã settled.
`remaining` là tổng số nghĩa vụ đó; mỗi nghĩa vụ có mã (`GOAL_UNSETTLED`, `GOAL_UNPROVEN`, `PRIMITIVE_UNCHAINED`, `CHAIN_READY`) và id.

Hai verb tách quyền: `p2o_finish {export:true}` reconcile rồi ghi `REPORT.md`/CSV và **không kết thúc gì** (worker, sandbox,
run giữ nguyên; export lại được, thư mục mới `-export-N`); `p2o_finish` không có `export` vẫn là báo cáo cuối (dừng worker,
dọn sandbox). `/p2o stop` ghi nghĩa vụ còn lại vào outcome (`run.stopped` summary + `remaining`) nên người đọc sau biết run
dừng giữa đâu. `REPORT.md` có mục `## REMAINING WORK` với trạng thái hoàn tất và bảng nghĩa vụ; preflight codes là **fact của
báo cáo**, không phải điều kiện từ chối — p2o không có finish gate.

Situation line thêm cặp backlog của coverage: `coverage <tested>/<cells> (planned <n> unreached, <m> omitted)`, để "không
hiển thị" không bị đọc thành "không nằm trong kế hoạch".

## Reports and retention

- Independent support must match the validator's **latest** conclusion and receipt; withdrawal invalidates it.
- Full worker reports are redacted field-wise (≤128 KiB), stored as hashed parts and committed by a manifest; missing
  or corrupt parts are explicit, failed persistence is never acknowledged.
- After in-flight work stops, finalization freezes a bounded projection. `--export` keeps the full valid ledger in
  `.p2o-reports/` (0700/0600, ≤16 MiB, best-effort redaction: review before sharing); without it, temporary records are deleted.

Inert tests establish these mechanics, not security effectiveness, deduplication, prompt-injection immunity or cost.
