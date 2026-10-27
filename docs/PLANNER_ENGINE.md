# Planner / Engine runtime contract

Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md). This page is the operator-facing contract.

## Controls

```text
/p2o --target ./source --workers 3 --loop manual
/p2o --target ./source --workers 3 --loop event-driven --executors isolated --target-ops 2 --export
/p2o pause    /p2o resume    /p2o stop
```

- Defaults are manual + shared. Without Herdr there is no worker backend: target work is blocked, the planner reports
the blocked prerequisite instead of taking over, and event-driven is rejected.
- `--workers N` is a positive integer cap on concurrent model slots. `--target-ops N` is a separate target-operation
  cap: `shared` defaults to 1 and an explicit N in shared mode lifts that serial queue (recorded in the run); isolated
  multiplies resources. `--max-depth` is kept for compatibility only: workers
  propose tasks, they never spawn children.
- Settings live under `p2o` in `~/.pi/agent/settings.json`: `maxWorkers`, `loopMode`, `executorMode`,
  `maxTargetOperations`, `roles.<role>.model` (full list in [USAGE](USAGE.md)). Bad settings fall
  back to conservative defaults; bad CLI values are rejected. Precedence: CLI → settings → defaults.
- Automatic Planner rounds are extra requests to the existing model with **no round ceiling**: only two quietly
  unproductive rounds (M6) or the human stop them, and `resume` never meets a spent count. Command spend is not capped
  either (owner decision 2026-10-24). No heartbeat polling, provider fallback or launch replay.

## Who does what

- **Planner** chooses bounded directions, writes questions/contrasts/stop conditions, reviews evidence, dispatches,
  steers or withdraws, and decides `wait` / `blocked` / finish. The planner has no shell/net/HTTP, lab or claim tools
  in any mode: it creates and dispatches intents, and a worker executes them.
- **Engine** admits ready accepted work, owns slots and executors, coalesces committed signals, guards extra rounds.
  It has no model and never invents work; an empty frontier with unmet goals stays explained-blocked.
- **Worker** runs one intent with a fresh process, ticket and context, is the only executor and the only author of a
  candidate claim, note or surface record, and reports attributed observations and gaps. `p2o_request_subtask` only proposes.
- **Reporter** is a read-only second reader: it reads the accepted case, its evidence and artifacts and writes the
  report; it has no target, lab or claim tool.

Each role's prompt states its rule in short literal lines, not as a manual. The planner's `p2o_assessment` section states its first action
(create and dispatch one recon/mapping intent), that it has no target, lab or claim tools, that a confirmed or tested
claim must come from a worker task, that coverage is a projection of reviewed work, and that a zero-intent round is not
progress. The worker prompt says "One intent, write back, report, stop". The reporter prompt says "Read-only second reader: no
target operations, no candidate authorship, no verdict or plan changes." Those lines are *advisory*: the enforcement is
the role loadout in `src/tool-policy.ts` (planner 24 tools, worker 19, validation 18, reporter 6), where the planner's
list contains no target or claim tool at all, and the same rule is repeated on the tool boundaries in
`src/tool-guidelines.ts` so the model reads it where it reads the tool.

`p2o_task_dispatch {ids:[...]}` accepts 1–25 proposed tasks and is the only way to start work: the Engine spawns the
worker for each dispatched intent. A failed launch drops the attempt and records a blocked signal; a retry needs an explicit Planner
decision. A terminal report frees capacity only after verified retirement; new assignments get new identities and
renew nothing, because there is no command allowance to renew (owner decision 2026-10-24). `p2o_loop wait` ends a round, not the assessment; `blocked` pauses admission and wakes.
`/p2o pause` leaves admitted workers running; `/p2o stop` revokes them.

The dispatch queue keeps an accepted intent until capacity and reviewed prerequisites allow, up to 100 queued intents (P9/B), and
launches in priority then insertion order. A queued intent survives a `revise` that keeps its identity — question, role,
expected true/false, stop condition, work fingerprint or overlap key, claim/asset refs, prerequisites, parent/validation/retest
links, method skills and workflow — so only its revision number follows the edit; a revision that changes any of those, or a
task that stops being `proposed`, invalidates the queued entry and needs a new explicit dispatch. `p2o_finish` without `export`
is refused while a queued intent remains (`INTENTS_QUEUED`): it names each entry as `taskId@rN (reason)` plus the omitted count
and never drains the queue; `p2o_finish {export:true}` is unaffected. A pane-cleanup uncertainty while reaping workers records one
`PANE_REAP_UNVERIFIED` fact and skips that dispatch round without pausing the campaign — the next kick retries the reaper, so
accepted intents and semantic events stay live (P10/TR-H11).

### Intent admission (P1/A2)

The planner states what to learn; the host derives the rest. `p2o_task_create` stores the purpose the role names
(`purposeFromRole`), the output contract that purpose implies (`PURPOSE_OUTPUT_CONTRACTS`) and the only disposition the
anchors allow (`defaultWorkDecision`: `new` by default, `validate` with `validationOf`, `refine` with a prior task; `retest`
and an unanchored refinement still need an explicit decision). `revise` canonicalizes and anchors through the same code, and
`create` runs the duplicate/history preflight on that identity: an exact active or reusable attempt comes back as a match
payload instead of a new task.

The first intent of a run is recon/mapping — the intent that needs nothing earlier in the run to cite, which is why a new run
always has a legal first intent. A first validation is refused in both shapes (`PURPOSE_NEEDS_PREDECESSOR`,
`legalNext: create a recon task first`); a first structured discovery/exploitation/chaining/retest is refused with the same
recon-first legal next. After recon, a structured discovery needs `work.claimRefs` (the worker claim it builds on) or pinned
prerequisites; exploitation needs a demonstrated claim, chaining two; investigation/refinement need a claim, a pinned asset
revision or a prior task.

A validation names `validationOf` = a reviewed task ID or a worker claim ID; the claim carries the `data.taskRef` the host
stamped from the worker's assignment. The host resolves the claim to its discovery task, pins the reviewed revision as the
prerequisite, rewrites the link to the task and derives `decision=validate`; a validation is never revalidated. When a worker
claim is confirmed+tested and its discovery task is reviewed, the host creates exactly one validation task (deterministic key) —
or a visibly blocked one when no worker backend exists. `p2o_candidate` is worker-only: a planner call fails `WORKER_ONLY`, and
the worker's claim gets the host `taskRef`. A dispatch with no executor is a blocked prerequisite (`DELEGATION_UNAVAILABLE`),
and a failed executor/pane provisioning moves the reserved task to `blocked`; neither is a planner execution path. Detail:
[work admission](WORK_ADMISSION.md).

### Coverage projection (P2/A3)

Coverage không phải bảng planner viết: **host chiếu** cell từ công việc đã commit — task head có `work.assetRefs`, claim worker của
task đó (`data.taskRef`), case accepted cùng run và revision asset trong graph — rồi trả cùng một projection cho
`p2o_board board=coverage`, báo cáo, situation line, goal proof và finish preflight. `p2o_coverage_plan` chỉ ghi scope (title,
exclusions, unknownScope) và trạng thái review; không có verb tạo/sửa/retire cell. Plan tạo sau A3 mang marker host-owned
`derivation:'projected'`; plan tạo trước A3 (không marker) vẫn được đọc đúng cell đã lưu, read-only.

Task không có `work.assetRefs` không thành cell: nó là `unmapped` gap trên board coverage, trong `unmappedTasks`/`unmappedCoverageTasks`
của báo cáo và advisory `UNMAPPED_TASK` của finish preflight. Cell dẫn xuất chỉ đi từ `planned`/`blocked` sang `tested` khi task đã
review và claim/case đã accepted; staleness (`stale-asset`, `superseded-claim`, `stale-case`, `superseded-task`, `stale-target`) chỉ hạ.
Chi tiết bảng suy ra và plan legacy: [case review](CASE_REVIEW.md).

### Goal proof (P16.1)

Một goal là một lời hứa về target, không phải một hoạt động. `p2o_plan_create` từ chối goal không có `proof`
(`GOAL_UNPROVEN: a goal needs proof (capability, case or coverage)`), và `revise` lên `reviewed`/`closed` chỉ thành công khi
proof còn đúng; `supportRefs` không còn là điều kiện thứ hai — khi caller bỏ trống, host ghi đúng refs của proof đã settle
(claim record cho `capability`, case/plan id cho `case`/`coverage`) và `supportRefs` chấp nhận mọi work record cùng run
(evidence, candidate, task, plan) (P10/TR-L07, P10/TR-L09). Ba loại proof (`src/goal-proof.ts`):

- `capability` — một claim `confirmed`+`tested` trong run đã gain đúng capability đó;
- `case` — case cùng run đã `accepted`, `confirmed` và `current` (case `disputed`/`stale` không settle được goal);
- `coverage` — coverage plan cùng run mà mọi cell chưa retire đều ở `tested`/`blocked`/`not_applicable` (cell dẫn xuất nếu plan
  `derivation:'projected'`, cell lưu nếu plan legacy; dùng cho goal mapping — goal tuyên bố reachability vẫn phải dùng capability
  hoặc case). Plan projected không có cell dẫn xuất nào thì proof không bao giờ "settled".

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
`deferred`, `cancelled`) do planner quyết và readiness không mở lại. `p2o_board board=plans` vì thế trả thêm một dòng mỗi chain:

`chain <id> 1/3 · next: step 2 (ready) · waiting on: http.request (internal-api)`

Từ chối: `CHAIN_LINEAGE: a chain step must cite the claim it consumes (claimRefs); a plan row with no lineage cannot hold a
link`, và `Duplicate chain step <n> in <chain>` cho hai dòng cùng vị trí. Hệ quả cho vận hành: đóng một bước = một lần
revise (`status: done`) với claim vừa demonstrated, không phải ghi cạnh; segment `chain` trong situation line đọc từ chính
board đó nên số bước ready/waiting trong prompt và trong plan view không thể lệch nhau.

### Frontier obligation (M2 + M4)

Create là chỗ duy nhất obligation được thi hành; finish không có gate. `src/obligations.ts` đọc plan + claim head + task
rồi trả hai danh sách thuần:

- **M2 — `ready`**: bước chain đang ready trên một surface. Một `p2o_task_create` mới trên surface đó bị từ chối trừ khi
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
`business-logic`). `p2o_plan_create` todo có field `route`; khi planner không nêu, nó lấy từ method family của claim mà bước đó cite
(`risk` trước, rồi `needs`/`gained` kind). Situation in `routes: N open (a, b), M done`; preflight thêm advisory
`ROUTE_MONOCULTURE` khi chỉ có **một** route open và capability đã chứng minh khiến họ khác khả dĩ — và demand wake của
vòng im lặng nói thêm `every open step is on route X — plausible elsewhere: …`. Tất cả chỉ là advisory: tập trung vào một
route là hợp lệ khi route đó đã cho hiệu ứng được chứng minh.

Negative evidence là checkpoint: `ruled_out` thứ hai trên cùng surface+capability bị từ chối (`RULED_OUT_RECHECK`) trừ khi
có evidence mới hoặc control/cơ chế khác — tức tối đa **một** lần re-check, đúng luật ARTEX. Một `ruled_out` ghi với
`execution:not_tested` hiện là `unproven-negation` trên situation line để planner biết phải dispatch đúng một lần kiểm chứng.

### CVE lead: host fetch, host gợi ý (P16.4)

`p2o_research action=cve` nhận `product`/`version` (kèm `vendor`/`cpe` tuỳ chọn) và `assetRefs`; **host** dựng URL NVD và tự
fetch — bốn host gợi ý chỉ là lời khuyên, không phải allowlist; `action=fetch` còn cho phép tải thẳng bất kỳ URL http(s), không giới hạn kích thước response (Part XI). Kết quả ghi `lead` record với provenance `{url, retrievedAt, sha256}`, trạng thái
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
`chainDepth`) **và** `remaining`/`demand` do host tính từ đúng `deriveCompletion` mà kết quả finish in ra. Round **im lặng**
khi cả bốn bộ đếm không tăng so với round trước. Hai round im lặng liên tiếp thì:

- **còn nghĩa vụ** (`remaining > 0`): `reserveWake()` vẫn cấp wake, mang thêm `demand` nêu tên nghĩa vụ cụ thể
  (ví dụ `quiet rounds 3 and 4 added nothing measurable (…); step 2 of chain login ready and undispatched; 1 goal(s) not
  reviewed or closed`). Engine **không** pause; vòng lặp tiếp tục chạy. Đây là frontier floor: "không có gì mới" không
  bao giờ thắng "vẫn còn việc phải làm".
- **không còn nghĩa vụ** (`remaining === 0`, completion `complete`): pause, câu lý do nêu cả hai round id và nói rõ
  completion đã complete nên không lên lịch wake tự động nữa.
- Planner đã ghi `blocked` bằng `p2o_loop` thì pause như cũ — đó là quyết định của con người, không phải suy đoán của máy.

Một bộ đếm tăng là đủ để xoá chuỗi im lặng; `manual` mode không tự chấm round vì không có round tự động nào để chấm.
`demand` được ghi vào event `planner.admitted` (summary + data) và vào message wake, nên lý do đánh thức đọc lại được từ
ledger. Không có từ "budget"/"allowance"/"quota" nào trong các câu này.

Hệ quả: engine chỉ dừng khi completion đã complete hoặc con người bảo dừng — không vì hết hạn mức và không vì một vòng
"không có gì mới" trong khi việc vẫn còn. Không còn `maxPlannerRounds`.

### Vòng không tạo intent: `planner.stalled` (P3/A4, siết lại ở P5.1)

Một vòng planner kết thúc khi goal vẫn mở (`proposed`/`active`), không còn intent nào mở/chờ/chạy
(`proposed`/`reserved`/`running`) và planner không ghi `blocked` thì không phải progress. Host ghi một lifecycle record
`planner.stalled: …` (text bắt đầu bằng `planner.stalled:`, `data.engine.event='planner.stalled'`, kèm `openGoal`,
`openIntents:0`, số round/sequence và streak stall hiện tại) qua đúng `persist` sẵn có, sau khi round ACK context. Nó không
wake, không xếp queue, không pause và không cấp budget mới; round đó hiện ở dòng `Frontier: … stalled rounds N` của
`/p2o status` cùng provenance REPORT.md. Mọi vòng như vậy đều được ghi (không dedupe) vì vòng không tạo intent không được
im lặng; goal `blocked`, decision `blocked`, run pause hoặc engine không live thì không ghi. Đây là fact của báo cáo —
không cổng, không wake, không hạn mức — và việc ghi nó không đổi cách M6 chấm vòng im lặng.

Hai siết của **P5.1** (đo từ gate 2026-10-26, run `run-74c4e640`):

- **Chỉ round đã được engine admit mới là round.** Ở `event-driven`, lượt `/p2o` của người kết thúc trước wake đầu tiên
  (`rounds: 0`) không ghi fact và không tính vào escalation; trước P5.1 hai fact `rounds:0` như vậy đốt 2/3 ngưỡng và
  escalation bắn trước khi có bất kỳ planner round nào. `manual` giữ nguyên A4 vì ở đó con người lái từng lượt.
- **Chỉ message kết thúc lượt mới kết thúc round** (`stop`, không phải `toolUse`). Host ACK context sau mỗi assistant
  message, nhưng phán "round không tạo intent" chỉ ở message cuối của lượt: một bước tool-calling chưa kịp tạo intent nào
  là *chưa* có intent, không phải round stall. Gate rerun 2026-10-26 (`run-e16db138`) ghi 3 fact `planner.stalled` trong
  **cùng một** round đã admit (09:41:14/18/36, cách 22 s) và escalate trước khi round đó kịp dispatch — round đó sau đó tạo
  4 intent. Từ P5.1, `stallRound` chỉ chạy với message `stopReason==='stop'`; mỗi round đã admit có tối đa một fact.
- **Bộ đếm escalation là streak, không phải tổng đời.** `snapshot().stalls` = số vòng stall liên tiếp kể từ lần
  `/p2o resume` gần nhất; `resume()` reset về 0, nên một vòng stall sau resume không pause lại ngay (trước P5.1 escalation
  bắn ở stalls 3, 4, 5, 6 — mỗi lần resume chỉ cần thêm một stall). Tổng số stall của cả run vẫn suy từ ledger
  (`planner.stalled` records), tức `authorityCounters.stalledRounds`, không đọc biến đếm trong bộ nhớ.
- Escalation vẫn là `streak >= 3` **và** debt gateable > 0: pause, persist `planner.stall-escalation`, và người quyết định
  bằng `/p2o resume` hoặc `/p2o stop`. Heartbeat vẫn là timer 600 s (A6.3) và không bị đổi ngưỡng bởi P5.1.

### Authority counters (P3/A4)

`src/authority.ts` là module read-only: `authorityCounters`/`authorityReport` đọc ledger đã commit (không model, không
target) và trả `plannerTargetOps` (evidence receipt không có worker attribution — **phải 0** sau P0/A1), `workerTargetOps`,
`tasksCreated` (task id phân biệt), `tasksDispatched` (task id đã từng `running`) cùng `firstDispatchAt` (record `running`
sớm nhất), `ownerClaims`/`workerClaims` (candidate theo attribution; owner **phải 0** sau P1/A2), `validationTasks`,
`stalledRounds`, `heartbeatWakes`/`debtWakes` (wake theo reason, A6.3), `campaignPartial` (final finish ghi partial thay
completion, A6.6), `campaignResumes` (lifecycle `campaign.resumed`, ghi trước khi loop chạy lại ở mỗi `/p2o resume`) và
`stallEscalations` (lifecycle `planner.stall-escalation` — quyết định pause xin người, **không** phải mọi round stall; P1),
cộng `ROLE_COUNTS` tĩnh (planner 24 · worker 19 · validation 18 · reporter 6) và mode chạy. Hai bất biến
0 là thứ gate đo của P0–P3 sẽ đọc; run legacy giữ số owner >0 trung thực thay vì bị viết lại, nên >0 trên run cũ không
phải lỗi hồi quy. Cùng một object đi vào `reportProjection().authority`, `statusView().authority` và provenance REPORT.md;
các con số không từ chối lệnh, không kết thúc run và không cấp quyền. P1 dùng đúng hai counter mới để gate "0 human
resume" tự chứng minh: `## Campaign` in `Human resumes: N; stall escalations: M` và provenance in `human resumes N; stall
escalations M` — cùng nguồn ledger với mọi counter khác, không đọc console history. Bề mặt người đọc: [USAGE](USAGE.md).

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
repeatable instead of a number picked by feel. It is a **suggestion only**: the planner's explicit `priority` always wins
and nothing auto-dispatches by score. Starting from a neutral base of **50**, each signal shifts it:

| Signal | Delta |
| --- | --- |
| a reviewed prerequisite is still unmet | −30 |
| purpose is validation or retest (cheap, unlocks a case) | +15 |
| a confirmed+tested claim already gains every capability this claim needs | +20 |
| the target asset already has a planner-accepted finding | +10 |
| the questionKey is already answered by a non-stale coverage cell | −20 |

The result is clamped to 0–100. The weights live in `PRIORITY_WEIGHTS` and are mirrored here; `tests/minimal/priority.test.ts`
reads the constants so the table and the source cannot drift.

The derivation is applied to the work that can start now and surfaced as one segment of the situation line
(`next: validation 65`). Two facts only exist where their data lives: a **ready chain step** is by definition the claim whose
every required token an existing confirmed+tested claim provides, so the +20 block applies to it; a **task record** carries no
link to the claim it will produce, so a task never receives that block until the lineage gate (P9) joins them. That gap is
why the segment names only the purpose and the score — the planner compares it with `p2o_graph {action:"chain"}` and then
decides. Nothing reads the suggestion back: no admission path, no reordering.

## Pi boundary

Only event-driven consent allows extra rounds. Committed reports, proposals and review/revise/withdraw produce
signals; stdout, notes and reads do not. A reserved round is void after pause, stop or epoch change; input veto and
context/abort guards cover late delivery. An accepted remote request cannot be un-charged by stop.

## State, rollback

Ledger v2, task statuses, planner-only board writes, report manifests, evidence/independence gates and until-stopped tickets
are unchanged; there is no authority recovery from disk. Stop any active assessment before reloading the extension
(tickets bind its bytes). Rollback = stop, use manual + shared, start a newly confirmed assessment; a failed
cleanup stays disclosed and `/p2o stop` retries it.

Still open: incremental indexes and archival checkpoints, durable Planner todo at scale, warm process reuse,
provider stop races, token/cost governance. No paid benchmark has been run for this design.
