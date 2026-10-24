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
  shared always 1; isolated multiplies resources. `--max-depth` is kept for compatibility only: workers
  propose tasks, they never spawn children.
- Settings live under `p2o` in `~/.pi/agent/settings.json`: `maxWorkers`, `loopMode`, `executorMode`,
  `maxTargetOperations`, `maxPlannerRounds`, `roles.<role>.model` (full list in [USAGE](USAGE.md)). Bad settings fall
  back to conservative defaults; bad CLI values are rejected. Precedence: CLI → settings → defaults.
- Automatic Planner rounds are extra requests to the existing model, bounded by the confirmed round count (not by
  time or money); `resume` cannot renew a spent count. Command spend is not capped at all (owner decision 2026-10-24). No heartbeat polling, provider fallback or launch replay.

## Who does what

- **Planner** chooses bounded directions, writes questions/contrasts/stop conditions, reviews evidence, dispatches,
  steers or withdraws, and decides `wait` / `blocked` / finish. Delegated Planner has no shell/net/HTTP.
- **Engine** admits ready accepted work, owns slots and executors, coalesces committed signals, guards extra rounds.
  It has no model and never invents work; an empty frontier with unmet goals stays explained-blocked.
- **Worker** runs one intent with a fresh process, ticket and context, and reports attributed observations and gaps.
  `p2o_request_subtask` only proposes.

`p2o_task {action:"dispatch", ids:[...]}` accepts 1–25 proposed tasks; `p2o_delegate` stays available for immediate
single dispatch. A failed launch drops the attempt and records a blocked signal; a retry needs an explicit Planner
decision. A terminal report frees capacity only after verified retirement; new assignments get new identities and
renew nothing, because there is no command allowance to renew (owner decision 2026-10-24). `p2o_loop wait` ends a round, not the assessment; `blocked` pauses admission and wakes.
`/p2o pause` leaves admitted workers running; `/p2o stop` revokes them.

### Chain board (M1)

Chuỗi khai thác sống trên plan board, không có bảng cạnh riêng: mỗi bước là một `todo` với `chainOf`, `step` (1..8),
`claimRefs` (record candidate cùng run mà bước đó đứng trên), `needs` (capability có kiểu) và `environmentRef` nếu có.
`p2o_graph {action:"chain", plan:true}` ghi đúng các dòng đó — bước đã demonstrated ghi `done`, bước kế tiếp ghi `open` —
rồi trả `chainOf` để lần sau revise đúng chỗ.

Readiness **được suy ra khi đọc**, không lưu: bước *n* ready khi mọi `needs` của nó được gain bởi một claim
confirmed+tested mà một bước *trước đó* của cùng chain cite trong `claimRefs` (cùng `capabilityMatches` với graph join).
Bước không có `needs` ready theo định nghĩa — nó là primitive mà chuỗi bắt đầu. Trạng thái settled (`done`, `blocked`,
`deferred`, `cancelled`) do lead quyết và readiness không mở lại. `p2o_plan list` vì thế trả thêm một dòng mỗi chain:

`chain <id> 1/3 · next: step 2 (ready) · waiting on: http.request (internal-api)`

Từ chối: `CHAIN_LINEAGE: a chain step must cite the claim it consumes (claimRefs); a plan row with no lineage cannot hold a
link`, và `Duplicate chain step <n> in <chain>` cho hai dòng cùng vị trí. Hệ quả cho vận hành: đóng một bước = một lần
revise (`status: done`) với claim vừa demonstrated, không phải ghi cạnh; segment `chain` trong situation line đọc từ chính
board đó nên số bước ready/waiting trong prompt và trong plan view không thể lệch nhau.

### Frontier obligation (M2 + M4)

Create là chỗ duy nhất obligation được thi hành; finish không có gate. `src/obligations.ts` đọc plan + claim head + task
rồi trả hai danh sách thuần:

- **M2 — `ready`**: bước chain đang ready trên một surface. Một `p2o_task create` mới trên surface đó bị từ chối trừ khi
  draft cite đúng provider trong `work.claimRefs`, hoặc có một dòng plan `deferred`/`blocked` cite step đó (hoặc provider)
  làm lý do đã ghi. Từ chối: `CHAIN_READY_UNDISPATCHED: step <n> of chain <id> consumes <capability> that claim <recordId>
  already gains; dispatch it, cite it as a parent, or defer it with a reason`.
- **M4 — `unchained`**: claim `confirmed`+`tested` mà không có bước kế tiếp nào consume capability nó gain, không task sống
  nào đứng trên nó, và không dòng `deferred`/`blocked` nào nêu nó. Từ chối: `PRIMITIVE_UNCHAINED: claim <recordId>
  (<capability>) is confirmed and tested on <surface> and nothing consumes it; take the next step or record which successors
  were ruled out and why`. Cùng điều kiện đó hiện trong `FINISH PREFLIGHT` dưới mã advisory `PRIMITIVE_UNCHAINED`, nên "việc
  còn lại" chỉ có một nguồn.

Phạm vi **theo surface**, không toàn cục: breadth ở surface khác vẫn được admit, nên obligation không đóng băng run. Task bị
`cancelled`/`expired`/`closed` không tính là "đã đứng trên", nên một lần thử chết không xoá nợ. Revise và dispatch không bị
kiểm lại — luật chỉ chặn việc mở hướng mới.

### Vòng im lặng và escalate (M6)

Mỗi round engine giữ một `RoundProgress` gồm bốn bộ đếm đơn điệu: `testedCells`, `closures` (chỉ `confirmed`), `assets`,
`chainDepth` (độ sâu lớn nhất của chain join). Round **im lặng** khi cả bốn không tăng so với round trước. Hai round im lặng
liên tiếp thì `reserveWake()` không cấp wake nữa và `escalated()` trả về một câu duy nhất nêu **cả hai** round id cùng
quyết định của con người — mở rộng scope, cấp credential, hoặc đổi môi trường — chứ không có từ "budget" nào trong đó. Một
bộ đếm tăng là đủ để xoá chuỗi im lặng; `manual` mode không tự chấm round vì không có round tự động nào để chấm.

Hệ quả: engine dừng vì *không có gì mới*, không vì hết hạn mức. Con số `maxPlannerRounds` vẫn còn nhưng chỉ là phanh cuối;
M6 là lý do thường gặp hơn để dừng và lý do đó nói được bằng chứng cứ.

### Revisit theo điều kiện (M7)

`p2o_loop {action:'wait', reason:'block-decay'|'cooldown-expiry', notBefore}` không phải một khoản chờ: nó ghi **một**
`decision` (`disposition:'defer'` + `revisitCondition`) lên plan board và hẹn **một** wake tại đúng thời điểm đó. Ba chặn:
`notBefore` phải ở tương lai và trong 24 giờ, reason phải thuộc hai giá trị trên, và mỗi điều kiện chỉ có một hẹn đang chờ
(`REVISIT_DUPLICATE: condition <c> already has a pending revisit at <iso>`). Revisit không tự hẹn lại, không tính vào gì, và
không bắn khi run đang pause/stop. Wake bắn một lần rồi biến mất khỏi `revisitAt()`.

### Continuation và research breaker (M8)

`p2o_workers {action:'continue', workerId, brief}` dùng lại hội thoại của worker cho **cùng** ticket: đây là cách rẻ nhất để
"thử lại giả thuyết bị chặn theo hướng khác" mà không phải spawn lại và đọc lại context. Luật nằm trong một hàm
(`continuationRefusal`): `WORKER_CLOSED` khi worker đã report/stop/pane đóng, `CONTINUATION_LIMIT` sau một lần nối —
một ticket, một brief thêm, không phải một allowance. Lần nối được ghi thành lifecycle note để báo cáo đếm được.

Khi một mắt xích bị chặn, `p2o_graph {action:'chain'}` trả thêm `research` hint cho tối đa ba claim chưa thoả: cặp
`needs → gained`, câu query dựng từ đúng hai capability đó, và procedure skill sở hữu bước chuyển (`TRANSITION_SKILLS`).
Đây là breaker cho vòng "biết mình thiếu gì nhưng không biết tra gì": hint nêu *bước chuyển*, không nêu chủ đề.

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
