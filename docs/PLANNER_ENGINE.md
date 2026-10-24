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
  `maxTargetOperations`, `roles.<role>.model` (full list in [USAGE](USAGE.md)). Bad settings fall
  back to conservative defaults; bad CLI values are rejected. Precedence: CLI → settings → defaults.
- Automatic Planner rounds are extra requests to the existing model with **no round ceiling**: only two quietly
  unproductive rounds (M6) or the human stop them, and `resume` never meets a spent count. Command spend is not capped
  either (owner decision 2026-10-24). No heartbeat polling, provider fallback or launch replay.

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

### Goal proof (P16.1)

Một goal là một lời hứa về target, không phải một hoạt động. `p2o_plan create` từ chối goal không có `proof`
(`GOAL_UNPROVEN: a goal needs proof (capability, case or coverage)`), và `revise` lên `reviewed`/`closed` chỉ thành công khi
supportRefs cùng tồn tại **và** proof còn đúng. Ba loại proof (`src/goal-proof.ts`):

- `capability` — một claim `confirmed`+`tested` trong run đã gain đúng capability đó;
- `case` — case cùng run đã `accepted`, `confirmed` và `current` (case `disputed`/`stale` không settle được goal);
- `coverage` — coverage plan cùng run mà mọi cell chưa retire đều ở `tested`/`blocked`/`not_applicable` (dùng cho goal
  mapping; goal tuyên bố reachability vẫn phải dùng capability hoặc case).

Cùng một resolver chạy ở plan board và ở `deriveCompletion`, nên một goal không thể "settled" ở chỗ này mà "unproven" ở chỗ
khác. `REPORT.md` in bảng `Goal | Status | Proof | Settled` để người đọc phân biệt status với demonstration.

### Chain board (M1)

Chuỗi khai thác sống trên plan board, không có bảng cạnh riêng: mỗi bước là một `todo` với `chainOf`, `step` (đánh số từ 1, không có trần),
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

### Route diversity và negative evidence (P16.5/P16.6)

Một **route** là họ cơ chế mà một bước chain thử (`upload`, `auth`, `sqli`, `deser`, `ssrf`, `path`, `injection`,
`business-logic`). `p2o_plan` todo có field `route`; khi lead không nêu, nó lấy từ method family của claim mà bước đó cite
(`risk` trước, rồi `needs`/`gained` kind). Situation in `routes: N open (a, b), M done`; preflight thêm advisory
`ROUTE_MONOCULTURE` khi chỉ có **một** route open và capability đã chứng minh khiến họ khác khả dĩ — và demand wake của
vòng im lặng nói thêm `every open step is on route X — plausible elsewhere: …`. Tất cả chỉ là advisory: tập trung vào một
route là hợp lệ khi route đó đã cho hiệu ứng được chứng minh.

Negative evidence là checkpoint: `ruled_out` thứ hai trên cùng surface+capability bị từ chối (`RULED_OUT_RECHECK`) trừ khi
có evidence mới hoặc control/cơ chế khác — tức tối đa **một** lần re-check, đúng luật ARTEX. Một `ruled_out` ghi với
`execution:not_tested` hiện là `unproven-negation` trên situation line để lead biết phải dispatch đúng một lần kiểm chứng.

### CVE lead: host fetch có allowlist (P16.4)

`p2o_research action=cve` nhận `product`/`version` (kèm `vendor`/`cpe` tuỳ chọn) và `assetRefs`; **host** dựng URL NVD và tự
fetch — model không bao giờ đưa ra địa chỉ. Kết quả ghi `lead` record với provenance `{url, retrievedAt, sha256}`, trạng thái
`untriaged`; `action=triage` chuyển sang `tasked`/`ruled_out` (kèm lý do) bằng một revision `supersedes`. Một lead là con trỏ
để kiểm chứng: claim cite lead chỉ được `policyBasis:"inferred"` + `open_proof_gap`, và `closure:"confirmed"` bị từ chối
(`LEAD_NOT_EVIDENCE`). Situation có segment `leads: N untriaged (M critical)`; preflight/report hiện advisory
`LEAD_UNTRIAGED` (không phải cổng) và `REPORT.md` có mục `## LEADS` in kèm source + sha256.

### Graph slice, write-back và NO_GRAPH_WRITE (P16.3/P16.8)

Brief của mỗi worker mang một slice từ graph — asset khớp `task.surface`, fact mới nhất (kèm evidence và người ghi), open
lead/gap, và chain step đang ready — trong khối `== Graph context from this run ==`, nhãn background. Worker instruction
yêu cầu ghi lại khi biết (`p2o_graph`, fact kèm evidence, hoặc note `no-new`). Host đếm per-worker bằng
`src/write-back.ts` và hiển thị ở ba nơi: `p2o_workers list`, dòng handoff trong `REPORT.md`, và advisory
`NO_GRAPH_WRITE` của preflight/`## REMAINING WORK`. Không có cổng: review và finish không bị từ chối vì worker ghi ít.

### Vòng im lặng, frontier floor và demand wake (M6 + P16.2)

Mỗi round engine giữ một `RoundProgress`: bốn bộ đếm đơn điệu (`testedCells`, `closures` — chỉ `confirmed` —, `assets`,
`chainDepth`) **và** `remaining`/`demand` do owner tính từ đúng `deriveCompletion` mà kết quả finish in ra. Round **im lặng**
khi cả bốn bộ đếm không tăng so với round trước. Hai round im lặng liên tiếp thì:

- **còn nghĩa vụ** (`remaining > 0`): `reserveWake()` vẫn cấp wake, mang thêm `demand` nêu tên nghĩa vụ cụ thể
  (ví dụ `quiet rounds 3 and 4 added nothing measurable (…); step 2 of chain login ready and undispatched; 1 goal(s) not
  reviewed or closed`). Engine **không** pause; vòng lặp tiếp tục chạy. Đây là frontier floor: "không có gì mới" không
  bao giờ thắng "vẫn còn việc phải làm".
- **không còn nghĩa vụ** (`remaining === 0`, completion `complete`): pause, câu lý do nêu cả hai round id và nói rõ
  completion đã complete nên không lên lịch wake tự động nữa.
- Lead đã ghi `blocked` bằng `p2o_loop` thì pause như cũ — đó là quyết định của con người, không phải suy đoán của máy.

Một bộ đếm tăng là đủ để xoá chuỗi im lặng; `manual` mode không tự chấm round vì không có round tự động nào để chấm.
`demand` được ghi vào event `planner.admitted` (summary + data) và vào message wake, nên lý do đánh thức đọc lại được từ
ledger. Không có từ "budget"/"allowance"/"quota" nào trong các câu này.

Hệ quả: engine chỉ dừng khi completion đã complete hoặc con người bảo dừng — không vì hết hạn mức và không vì một vòng
"không có gì mới" trong khi việc vẫn còn. Không còn `maxPlannerRounds`.

### Revisit theo điều kiện (M7)

`p2o_loop {action:'wait', reason:'block-decay'|'cooldown-expiry', notBefore}` không phải một khoản chờ: nó ghi **một**
`decision` (`disposition:'defer'` + `revisitCondition`) lên plan board và hẹn **một** wake tại đúng thời điểm đó. Ba chặn:
`notBefore` phải ở tương lai và trong 24 giờ (biên của một hẹn giờ, không phải quota), reason phải thuộc hai giá trị trên, và mỗi điều kiện chỉ có một hẹn đang chờ
(`REVISIT_DUPLICATE: condition <c> already has a pending revisit at <iso>`). Revisit không tự hẹn lại, không tính vào gì, và
không bắn khi run đang pause/stop. Wake bắn một lần rồi biến mất khỏi `revisitAt()`.

### Continuation và research breaker (M8)

`p2o_workers {action:'continue', workerId, brief}` dùng lại hội thoại của worker cho **cùng** ticket: đây là cách rẻ nhất để
"thử lại giả thuyết bị chặn theo hướng khác" mà không phải spawn lại và đọc lại context. Luật nằm trong một hàm
(`continuationRefusal`): chỉ `WORKER_CLOSED` khi worker đã report/stop/pane đóng. Một ticket còn sống được nối bao nhiêu
lần cũng được — số lần nối không phải một allowance — và mỗi lần nối được ghi thành lifecycle note để báo cáo đếm được.

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
