# Hoạch định lại p2o: Planner rõ vai trò, Engine giữ loop, Worker thực hiện intent

> **Trạng thái: core MVP 0.5.0 đã commit/push và cài bằng `pi install`; chưa phải hoàn tất toàn bộ P0–P6.**
> Runtime: `4d21f267c780562e2a07fb5cefe76d8cd746dab2`. Installed mechanics acceptance: [research/runtime/planner-engine](research/runtime/planner-engine/README.md). P5 và effectiveness/provider-wide studies vẫn chưa hoàn tất.
> Các phần phân tích bên dưới giữ baseline `6f02060` và proposal gốc; không đọc mọi tên API/gate đề xuất thành capability đã ship. Contract thực tế: [docs/PLANNER_ENGINE.md](docs/PLANNER_ENGINE.md).

## Tiến độ hiện thực hóa

- **P0:** đã chốt schema additive (giữ ledger v2/TaskStatus, revision queued optional), state/epoch và spike Pi thật với inert provider: idle wake, settlement continuation, human follow-up priority, stale-wake veto. Loại adapter `sendMessage(triggerTurn)` vì mất scoped prompt; idle dùng normal prompt pipeline có typed semantic entry. Không khẳng định cancellation/billing của provider thương mại.
- **P1:** enforced Planner/solo/reporting loadouts, worker subtask proposal, batch dispatch qua TaskDraft hiện có; chưa có một schema thin IntentDraft riêng hoặc đầy đủ review-packet redesign.
- **P2:** logical slot reuse bằng fresh process/ticket; bỏ cumulative 2× spawn ceiling/max-6. Test 30 assignments/capacity 3; policy/retention và command reserve không reset. Live frontier 100, history terminal >100 được test; registrations vẫn bounded 1000.
- **P3:** manual default; consented event-driven Engine, committed events, coalescing, một reservation, human priority, wait/blocked, pause/resume/stop epoch; provider error pause, không retry/fallback.
- **P4:** shared-serial default giữ nguyên; opt-in isolated assignment executors + target-operation semaphore, snapshot consistency và teardown. Local Docker fixture xác nhận B không chờ A, cancel A giữ B, cleanup mọi executor; không phải live assessment.
- **P5:** mới có live/closed frontier separation và bounded request-local snapshots/decision provenance. Incremental indexes, archival checkpoints, durable structured todo, warm session/process reuse và long-history performance vẫn **chưa triển khai**.
- **P6:** typecheck/build/import/library/provenance pass; Vitest **179 pass/9 opt-in skips**, Python **143 run/1 skip/OK**, source Docker/native **8 pass**. Package private inputs excluded; graph change review gồm cả file mới qua temporary index. Installed runtime đã pass **6 checks** (Pi thật/inert provider, normal/quota worker, idle/boundary/human-priority wake và Docker), với **32 selected runtime/document hashes** khớp tại runtime revision. Publication chỉ cập nhật tài liệu/artifacts; provider/version matrix và effectiveness/cost studies vẫn là bước riêng. Không chạy live/paid benchmark, không thực thi ARTEX/norma.

Mọi scope/ticket/evidence/currentness/cleanup/budget safeguards và unlimited elapsed lifetime được giữ; số round, retention và resource budget không phải TTL. [Runtime contract](docs/PLANNER_ENGINE.md) là nguồn cho API hiện có.
> Baseline p2o: `6f02060f22109df4ff360956adffc5213ad857a0`.
> Lập kế hoạch từ source local và `my_references/ARTEX/ARTEX_AGENTIC_CORE.vi.md`, không từ suy đoán về một chiến dịch thực tế.
> Turn lập kế hoạch gốc chỉ đọc/phân tích, không chạy ARTEX/norma hay assessment và không commit/push/install. Các bước triển khai/fixture acceptance và publication sau đó được ghi riêng ở phần tiến độ trên.

## 1. Kết luận cần chốt trước

**Vấn đề chính không phải agent thiếu một prompt dài hơn hoặc thiếu thời gian. p2o thiếu một outer loop điều phối độc lập với conversation, đồng thời giao quá nhiều trách nhiệm cho cùng một LLM.**

Hiện nay lead vừa làm chiến lược, vừa recon/discovery, vừa dispatch, đọc/review mọi handoff, xử lý lỗi, chờ worker và viết báo cáo. Trong khi đó:

- Worker có cap đồng thời, nhưng còn có **cap tổng số lần spawn**, nên không thể tạo nhiều đợt liên tiếp dù các worker trước đã xong.
- Nhiều worker LLM có thể hoạt động, nhưng **shell và HTTP thực thi tuần tự qua cùng một executor queue**.
- Worker report được lưu, **không tự đánh thức lead thành một planning round mới**.
- `p2o_workers waitFor=...` giúp chờ không tốn model turn trong khoảng chờ, nhưng vẫn là công cụ lead phải tự gọi; không phải scheduler thường trực.
- Không có assessment deadline không đồng nghĩa có auto-continuation, worker pool tái sử dụng hay context bền vững cho nhiều vòng.

**Kiến trúc đề xuất:**

```text
Human: mục tiêu, scope, consent, ngân sách, stop
                        |
                        v
Owner / Assessment Engine [TypeScript, không phải LLM]
  authority + events + frontier + admission + dispatch + cleanup
                        |
              +---------+------------------------+
              |                                  |
              v                                  v
Planner LLM                              Worker slots x N
strategic decisions                      một intent / một assignment
selected snapshot + delta                tactical model/tool loop
              |                                  |
              +---- intents/review/steer          +---- observations/report
              |                                  |
              +---------- shared run state <-----+
                             |
                    commit event -> wake Planner
```

**Khuyến nghị MVP:** Pi conversation hiện tại là **Planner**, không còn là “lead AND working investigator” khi delegation hoạt động. Engine thực hiện công việc cơ khí. Không bắt buộc thêm một Planner agent trả phí hoặc một dashboard. `--solo` vẫn có working-agent mode rõ ràng, không giả vờ có subagent.

Planner riêng chạy qua SDK/RPC là lựa chọn giai đoạn sau nếu cần tách hoàn toàn human chat khỏi planning rounds. Không đưa cả hai mô hình vào MVP cùng lúc.

---

## 2. Phạm vi, nguồn và mức chắc chắn

### 2.1. Những gì đã đối chiếu

- Đọc toàn bộ bản phân tích tiếng Việt của bạn.
- Đọc đường core của ARTEX: `Engine.Run/plannerLoop/workerLoop/runIntent`, `Planner.Plan`, `Worker.execute`, `Task.Notify*`, task-agent assembly, frontier/atomic claim, overview, intent admission và goal proof.
- Đối chiếu norma `Session.Prompt/Resume`, `harness.loop.run`, tool execution và settlement. Không thực thi source tham khảo.
- Đọc toàn bộ entrypoint p2o và các thành phần roles, prompts, tasks, progress, Herdr, sandbox; đối chiếu broker, evidence, ledger và regression liên quan.
- Đọc Pi 1.0.0 docs `extensions.md`, `sdk.md`, `message-types.md`, `cli-integration.md`, `compaction.md`, examples và declarations của boundary/message APIs.
- Khảo sát cấu trúc repo ARTEX: `agent`, `server`, `db` là core; `guard/intercept/traffic/evidence/report` là enforcement/evidence support; `web` là UI; norma là harness.

Đây là **review kiến trúc xuyên các đường source liên quan**, không phải audit từng dòng của toàn bộ UI, mọi API/provider/MCP hoặc mọi package trong ARTEX. Không tuyên bố đã kiểm chứng ARTEX end-to-end. File review hashes cục bộ: `tmp/planner-redesign/review-hashes.json` (không phải artifact release).

### 2.2. Phân loại dùng trong tài liệu

- **SOURCE-CONFIRMED:** đọc thấy implementation trong snapshot hiện có; không đồng nghĩa đã đo hành vi runtime.
- **DESIGN-INFERENCE:** hệ quả hoặc nguyên nhân khả dĩ từ kiến trúc; cần test/measurement.
- **PROPOSED:** thay đổi cho p2o, chưa có trong runtime.
- **UNVERIFIED:** effectiveness, deployment/config thực tế hoặc tính đúng tuyệt đối chưa được chứng minh.

`my_references/` là dữ liệu tham khảo không tin cậy: không chạy script/tests từ đó, không import, không commit/package, không trở thành runtime dependency. Chỉ rút ra ý tưởng, viết implementation p2o riêng.

Snapshot ARTEX không có provenance commit upstream đã xác thực. Nhãn 0.3.15/norma v0.4.3 trong tài liệu không chứng minh campaign sử dụng đúng snapshot này. Bài báo, tên/comment và prompt không thay thế handler đang chạy.

Hashes neo review hiện tại:

| Artifact | SHA-256 |
|---|---|
| `ARTEX_AGENTIC_CORE.vi.md` | `db70fdd06bda7994f9cb07f6deaccea8ca86c4dbfd3294441cde1bd1e8cc91fa` |
| `agent/planner.go` | `a4c6dca3b5da2843f87602df5ee16182d3b21e6d541d3b339f2fca0a0dbacc30` |
| `agent/worker.go` | `3b23500bc9025876f1c06fdfd3d60b43965de7f62b718b3d010ce3c67c62b0cf` |
| `server/engine.go` | `aa93f45a53222465240e809a77ab6c163cfb868e4ff65b8cc66271048e928b03` |

### 2.3. GitNexus và blast radius

Đã rebuild index bằng `--index-only`, dùng graph query/context và CLI fallback để đối chiếu `plannerLoop`, `spawnWorkerLocked`, `TaskBoard`.

- `TaskBoard`: **HIGH**, 22 symbols upstream; direct consumers gồm extension, report projection và tests; các flow handler/cleanup/delegation bị ảnh hưởng.
- `spawnWorkerLocked`: graph trả LOW/1 caller trực tiếp, nhưng **không dùng kết quả nhỏ này để kết luận refactor tổng thể ít rủi ro**: callbacks/plain-object dispatch cần đọc source.
- Rebuild báo BM25/FTS disabled; một số MCP calls lỗi. CLI context/impact và source trực tiếp được dùng thay thế. Không coi query rỗng hoặc graph output bị giới hạn là all-clear.

**Chỉ có kế hoạch được viết ở turn này.** Khi triển khai phải chạy impact lại cho symbol thực sự đổi; đặc biệt ticket/broker, task transitions, cancellation và shared executor. Trước commit phải detect changes, cùng regression thực tế; graph không phải chứng nhận an toàn.

---

## 3. ARTEX thực sự giao việc và giữ loop thế nào?

### 3.1. Hai vòng, không phải một agent chạy vô hạn

**Inner loop — trong một Planner/Worker run:**

```text
model -> tool_use -> handler -> tool_result ghép đúng ID
      -> append vào session messages -> model request tiếp
      -> ... -> natural completion / error / budget / cancellation
```

Norma giữ vòng này; Worker tự chọn tools và tactical steps. Planner không biên dịch intent thành command, Worker không chỉ là process runner.

**Outer loop — giữa Planner và workers:**

```text
Engine wake Planner
  -> Planner đọc delta + overview + todo
  -> add_intent tạo frontier entries
  -> worker slot claim một entry
  -> Worker thực hiện inner loop và ghi tri thức
  -> report_finding / worker terminal -> NotifyFinding / NotifyDone
  -> Engine gom signals -> planning round mới
```

Source: ARTEX `server/engine.go:748–1156,1237–1245`; `agent/planner.go:355–473`; norma `harness/query.go:366–579`, `harness/tools.go:28–133`.

### 3.2. Planner “ngồi chờ” nghĩa chính xác là gì?

**SOURCE-CONFIRMED:** `plannerLoop` block trên Go channel `t.notify`, heartbeat timer hoặc cancellation. Sau `Plan()` trả về, Engine vẫn sống. Không cần model viết “tiếp tục” hoặc một human message mới để nhận worker completion.

- Coalesce mặc định 800 ms, một cửa sổ cố định; không reset timer với mọi signal.
- Heartbeat tối thiểu/mặc định 600 giây, re-arm sau planning wake.
- `NotifyDone` tích lũy intent ID; `NotifyFinding` có summary và có thể wake khi worker chưa kết thúc.
- Human goal/hint edits có signals riêng.
- Không phải mọi `record_fact/insert_assets` đều trực tiếp wake Planner; không có bằng chứng một watcher tổng quát cho mọi graph mutation.

**Quan trọng:** đợi signal là chờ bằng runtime, không tốn model call trong thời gian đó. Heartbeat của ARTEX có thể tạo model call nếu task còn runnable; không đồng nhất heartbeat với “miễn phí”.

Source: `server/engine.go:780–914`; `server/manager.go:1751–1860`.

### 3.3. Planner giao “hướng + lý do”, không giao mọi bước nhỏ

Planner:

1. Xem goal, trigger và state hiện có.
2. Đọc evidence/fact chi tiết khi cần.
3. So sánh hướng mới với open/running/recent-done để hạn chế duplicate.
4. Tạo một hoặc nhiều intents: natural-language summary, asset IDs, parent fact/finding IDs, priority.
5. Nếu bước sau phụ thuộc kết quả bước trước, giữ todo và chờ kết quả thật rồi mới giao bước sau.
6. Có thể steer/kill worker, đánh giá goal.

Worker:

1. Nhận đúng một intent và target rows.
2. Tự xác định tactical steps, chọn tool, đọc kết quả.
3. Ghi assets/facts/findings tường minh; không tự mở chiến lược khác.
4. Hoàn tất hoặc trả trạng thái lỗi/partial; slot quay lại claim việc khác.

`add_intent` handler kiểm tra parent **fact/finding**, không chấp nhận tùy ý goal/intent/hint làm parent. Frontier chọn priority DESC, ID ASC và atomic `open -> running`. Không có prerequisite-ready DAG scheduler tổng quát trong đường claim: phần sequencing còn dựa nhiều vào Planner.

Source: `agent/planner.go:298–473`; `agent/tools.go:1021–1202`; `db/exploration.go:1136–1182`.

### 3.4. Worker slots khác với worker tasks

ARTEX `Engine.Run` tạo N worker loops. Mỗi loop thực hiện:

```text
claim -> execute intent -> settle -> notify -> claim tiếp
```

N là **số slot đồng thời**, không phải tổng số intents được xử lý suốt task. `Manager.Workers()` mặc định 3; `SetWorkers()` trong đường đã đọc chỉ yêu cầu N > 0, không có hard cap 6 như p2o. Không suy ra rằng mọi API/UI hoặc mọi deployment đều không có giới hạn khác.

`WorkerSessionID` theo exploration + intent ID, không theo `work#N`. Do đó slot tái sử dụng không có nghĩa conversation của intent A bị đưa nguyên sang intent B. Cùng intent có transcript/resume; intent mới có session riêng.

Source: `server/manager.go:319–337`; `server/engine.go:916–1156`; `agent/worker.go:94–96,361–535`.

### 3.5. Vì sao duy trì nhiều vòng mà context không phải một chat khổng lồ?

- Planner tạo session mới mỗi round, nhận projection/delta/todo, không replay toàn bộ Worker conversation.
- Todo của Planner sống qua rounds **trong process**; không thấy bảo đảm load lại nguyên todo từ DB sau restart.
- Worker mandate/target được dựng ở system mỗi run; overview ở user context chỉ để hiểu tình hình.
- Tool output có cap/spill; session compaction là một lớp, cold-graph digests là lớp khác.
- Facts/resources/evidence ở ngoài conversation, có ID để drill-down.
- Overview có cửa sổ: open 30, recent facts 20, recent ended 12; bounded counts không luôn là absolute totals.

Không cần PostgreSQL/graph database để học nguyên lý này. Giá trị là **state ngoài chat + projection có provenance + retrieval theo nhu cầu**.

### 3.6. ARTEX cũng có giới hạn và recovery, không phải unlimited hoàn toàn

Các đường đã đọc có:

- MaxTurns configurable, 0 = không giới hạn theo setting đó.
- Worker run timeout configurable; fallback `agentRunSeconds` là **1200 giây**, có thể đặt 0. Task deadline có thể clamp run.
- Harness defensive guard **10000 iterations**.
- Max-turns/time settlement để ghi checkpoint, không giả vờ completed.
- Engine model-error retry mặc định 2 lần thêm, backoff 3 giây; router-handled errors có ngoại lệ chống replay side effects.
- Thinking-only turn có bounded stop-hook nudge (mặc định 2 cho intent), không phải unconditional “cứ tiếp tục”.

Source: `server/server.go:296–322`; `server/engine.go:71–85,531–650,1028–1156`; norma `harness/query.go:261–263,366–579`.

**Bài học:** duration dài đến từ Engine sống qua nhiều run, pool nhận việc tiếp, checkpoint và compaction. Không chỉ đến từ bỏ timeout. Không copy retry/failover/nudge policy sang p2o mà không có consent, budget và side-effect model.

### 3.7. Những phần không nên sao chép nguyên xi

- Planner ARTEX vẫn được assemble generic tools/Bash; “chỉ lập kế hoạch” phần lớn là prompt policy. p2o nên enforce tool surface rõ hơn.
- Asset auto-scope không tương đương quyền human-confirmed scope của p2o; **không đem auto-widen scope vào extension**.
- `confirmed` graph state không tự chứng minh vulnerability; goal proof còn phụ thuộc model và có writes không kiểm tra đủ lỗi.
- Khi goal chưa đạt và frontier trống, prompt ARTEX thúc tạo hướng mới; p2o phải cho phép **blocked/no-feasible-work**, không ép model bịa thêm việc để giữ loop.
- Không sao chép campaign workflow, credentials, unsafe actions hoặc `PermissionModeBypass` thành host authority.

---

## 4. Chẩn đoán p2o ở baseline hiện tại

### 4.1. Role đang bị lẫn ở đâu?

`src/prompts.ts::ownerInstructions` tuyên bố **“lead AND a working investigator”** và **“not a dispatcher”**. Đây là quyết định hiện tại, không phải lỗi Pi tự gây ra.

`ROLES` chỉ gồm recon/discovery/validation/reporting/general. Chúng là presets model/skills; tất cả workers nhận gần như cùng tool set, kể cả nested delegation. Chưa có capability boundary theo vai trò reporting/validation/planning.

**DESIGN-INFERENCE:** lead phải đổi liên tục giữa tactical trace và strategic state, dễ bỏ lỡ report, over-plan một task hoặc ôm phần việc nên giao worker. Cần đo trước/sau, không gọi đây là benchmark đã xác nhận.

### 4.2. Những giới hạn thực sự còn lại

| Giới hạn hiện tại | Implementation | Hệ quả |
|---|---|---|
| Concurrent workers mặc định 3, hard max 6 | `src/roles.ts:27–30`; parser/settings | Tuning bị chặn bởi constant chung |
| Tổng successful spawns ≤ 2 × maxWorkers | `spawnWorkerLocked` | Default chỉ 6 assignments; max chỉ 12, dù trước đó đã report |
| Map-size guard ≤ 2 × cap + 4 | `spawnWorkerLocked` | Historical registrations tiếp tục góp vào giới hạn |
| Depth mặc định 2, max 3 | `src/roles.ts`; spawn admission | Tree depth, không phải tổng capacity hay pipeline depth |
| Mỗi worker 200 target commands | `src/broker.ts:15` | Assignment dài có thể partial-budget |
| Worker command pool 600 × 90% = 540 mặc định | extension `totalBudget`; `Broker.spend` | Nhiều đợt vẫn chia cùng run allowance |
| Lead knowledge 400; worker shared knowledge/coordination counter 160/200 | extension; broker | Cần tách read/report/control reserve khi tăng số vòng |
| Task lifetime-count cap 100 | `TaskBoard.create` | Đã closed vẫn tính; không phải chỉ active backlog |
| Single sandbox queue cho shell + HTTP | `src/sandbox.ts::enqueue` | Head-of-line blocking; LLM concurrency ≠ target execution concurrency |
| Shell abort/opt-in timeout xóa shared executor | `Sandbox.exec` | Một worker bị revoke có thể làm peers mất executor |
| `p2o_workers` wait tối đa 300 giây, default 120 | tool schema + `waitForWorkers` | Chỉ giới hạn một lần đợi; **không dừng assessment/worker** |
| Report revoke ticket, worker phase finished | broker report + `p2o_report` | Không có “giao thêm intent mới” cho chính worker session đã xong |
| Ledger reconciliation ≤64 MiB /100000 records; bounded receipts/exports | records/evidence/report | Duration unlimited không có nghĩa retention unlimited |

**Không được viết “600 aggregate commands bao gồm lead”**: hiện lead target commands được thống kê riêng, không bị `Broker.spend` debit. 90% là reserve trên worker pool, không phải một aggregate lead/worker cost governor đã enforce.

### 4.3. Outer loop thiếu chính xác phần nào?

`Broker.report` callback hiện persist report/coverage/open items và transition task thành reported. Không queue model message/wakeup cho owner. `ProgressState` chỉ advisory, không có timer/dispatch/retry. Hook owner `agent_before_settle` không yêu cầu continuation khi completed; lỗi owner hiện dừng assessment.

Do đó:

```text
worker report -> ledger updated -> [lead phải còn đang chạy/chủ động đợi/human prompt]
```

Chưa có:

```text
worker report committed -> semantic event -> schedule một planning round
```

Chỉ thay câu “hãy chờ subagent” trong prompt không tạo được đường thứ hai.

### 4.4. State nền tảng nên giữ

p2o đã có nhiều invariant tốt hơn một raw “graph fact”:

- Task revisions, owner-only mutations, reservations, cycle checks.
- Prerequisite yêu cầu **reviewed revision + same-run receipts**; revised support làm dependency stale.
- Candidate closure, proof level, controls, inferred-policy gap và current independent reproduction.
- Ticket runtime-profile verification, owner active gate, revocation/socket-loss shutdown.
- Ledger diagnostics, report parts/manifests, freeze/export và verified cleanup.

Không rewrite bỏ những thứ này để “giống ARTEX hơn”.

**Một hạn chế riêng:** hiện `create/revise` đã đòi prerequisites được reviewed, nên chưa thể đăng ký cả một chain chưa-ready rồi để Engine chờ. Cần tách **dependency schema validity** khỏi **dispatch readiness**, giữ reviewed-evidence gate ở admission/command time.

---

## 5. Role contract mới: giảm tải thay vì chỉ đổi tên

### 5.1. Tách hai trục

- **Authority/lifecycle actor:** human, owner service, assignment worker. Đây là enforcement.
- **LLM responsibility:** planner, recon, discovery, validation, reporting, support. Đây là quyết định và chuyên môn; phải có capability loadout tương ứng.

Owner service giữ scope/tickets/cleanup, không phải một model “toàn quyền”. Planner quyết định chiến lược, không tự quản lý Docker/process hay ghi file broker tùy ý.

### 5.2. Ma trận trách nhiệm đề xuất

| Thành phần | Làm | Không làm |
|---|---|---|
| Human | Confirm scope/loop policy/resource budget, pause/stop, đổi mục tiêu | Không phải polling mỗi worker để loop tiếp |
| Engine/owner service | Admit tasks, claim/reserve, worker slots, wake coalescing, budgets, snapshots, revoke/cleanup | Không phát minh security hypothesis, không tự xác nhận finding |
| Planner LLM | Decompose goal, chọn hướng/role/priority, đọc evidence chọn lọc, accept/return handoff, steer, chọn wait/blocked/finish | Không tự recon/test target trong delegated mode; không gọi host Docker |
| Recon worker | Một surface/entry/actor question; inventory có evidence | Không chờ map toàn bộ target rồi mới giao discovery |
| Discovery worker | Một hypothesis/intent, tactical tool loop, candidate + counterevidence | Không tự independent-validate mình; không mở chiến lược run mới |
| Validation worker | Reproduce matching current claim, controls/limits, return conclusion riêng | Không coi metadata/current status là proof |
| Reporting worker | Tổng hợp evidence/candidate/coverage có sẵn, draft report | Không target execution mặc định, không tự nâng proof/severity/goal status |
| General/support worker | Bounded prerequisite/helper intent | Không trở thành orchestrator thứ hai |

Planner có thể batch directions, chờ, xử lý delta và đọc packet. Validator/reporter làm phần nặng; **Planner vẫn chịu trách nhiệm review quyết định**, không nhắm mắt nhận summary.

### 5.3. Hard boundary đề xuất

- Planner: state read, plan/task submit, review, steer/cancel, loop control, finish proposal; không shell/net/HTTP khi delegated mode.
- Worker execution: sandbox tools + approved knowledge/state reads + incremental observations + report; không trực tiếp spawn.
- Worker cần trợ giúp: `request_subtask` tạo **proposal** gửi Planner. Runtime không mặc nhiên biến worker text thành accepted intent/authority.
- Reporting: read/retrieve/draft/report only; cần reproduction thì trả request cho validation.
- Model-generated IDs/role/priority phải validate; authority không lấy từ message hoặc file state.

`--solo`: current Pi là working agent với inner loop hiện có; không thêm Planner model ẩn. Nếu không có Herdr, giữ solo/manual fallback rõ ràng. SDK/RPC backend chỉ thay thế khi đã có acceptance riêng.

---

## 6. Intent frontier và worker capacity

### 6.1. Giữ task evidence contract, thêm một thin strategic intent API

Không buộc Planner viết một biểu mẫu dài cho mọi helper step. Tool mới có thể batch intent drafts, owner service normalize defaults và liên kết về TaskBoard.

Ví dụ **schema đề xuất**, không phải payload hiện tại:

```text
IntentDraft:
  question / purpose
  surfaceIds, risk, role
  priority + reason
  supportingRecordIds
  prerequisites: taskId + accepted revision requirement
  expectedObservation, stopCondition, expectedOutput
  validationOf? / parentTaskId?
  method: skills/workflow + recorded selection reason
  noveltyReason? (khi quay lại hướng đã xử lý)
```

Runtime có thể derive skill hashes/default role profile; không derive hoặc bịa evidence. Helper/task thiếu contrasting predictions được đánh dấu quality gap, không tự tạo “scientific certainty”. Giữ structured minimum cho discovery/validation.

### 6.2. Queued khác runnable

```text
queued -> waiting_prerequisite -> ready -> reserved -> running
                                      -> reported -> reviewed -> closed
                       \-> blocked / cancelled / partial-budget / provider-error
```

Đây là **logical views/events đề xuất**, không tùy tiện thay TaskStatus hiện tại. P0 phải quyết định mapping/version trước khi đổi enum và `readLedger` parser.

- Cho phép ghi dependency tới task có thật nhưng chưa-reviewed; cycle/missing-ID vẫn fail.
- Engine chỉ dispatch khi prerequisite **current reviewed revision**, matching receipts và assignment reservation hợp lệ.
- Nếu predecessor revise/withdraw, dependent bị invalidated; đang chạy phải ngừng nhận target commands, không tự nâng stale support.
- Exact surface/risk/method/actor reservation là hard duplicate gate; semantic similarity chỉ advisory.
- Follow-up phải chỉ rõ mới ở evidence/method/actor hoặc delta nào; đổi câu chữ không tạo novelty.

### 6.3. Tách ba capacity, không dùng một số cho mọi thứ

1. `maxConcurrentWorkers`: model/session slots đang active.
2. `maxConcurrentTargetOps`: execution pressure, độc lập với số models.
3. `maxPendingIntents`/retention limits: memory/disk/frontier bounds.

**Tổng assignments trong lifetime run không bị buộc = 2 × concurrency nữa.** Budget và retained-history limits vẫn giới hạn tài nguyên; queue đầy thì backpressure với lý do, không “không được làm thêm vì từng có 6 workers”.

MVP vẫn default concurrency 3. Bỏ constant hard max 6 theo hướng **operator-controlled positive integer + preflight resource/provider policy**, không mặc định spawn vô hạn. Ví dụ 8/12 chỉ được dùng nếu profile, pane/backend và resource envelope chấp nhận; các số này chưa được benchmark.

- Chưa cần tăng depth: khuyến nghị flat Planner -> Worker; chain depth không phải spawn-tree depth.
- Nested task requests quay về cùng frontier; tránh parent giữ slot chờ child trong pool đã đầy. Có dependency-wait/yield contract, không tự tăng quota để chữa deadlock.
- Total task cap chuyển từ “mọi tasks lịch sử” sang bounded live frontier + indexed archived history, không xóa proof/lineage để tiết kiệm chỗ.

### 6.4. Pool về logic trước, warm process sau

Bước đầu: slot được giải phóng khi report committed/assignment ended; Engine có thể dùng slot cho worker process mới, đóng pane đã xong theo policy. **Đã đạt outer-loop pool semantics mà chưa phải reuse Pi process.**

Bước sau mới warm SDK/RPC/process reuse:

- `slotId != workerIdentity != assignmentId != taskId`.
- Intent mới: fresh Pi session/context, ticket/token generation mới, scratch mới; không reuse phase=finished hoặc ticket cũ.
- Cùng intent resume: transcript có provenance, effective runtime recheck, **authority mới được owner admit**; transcript không tự cấp quyền.
- Late report/old socket không được ghi vào assignment mới.
- Independence dựa attributed assignment identity, lineage và reproduction, không dựa “khác pane name” hoặc slot reuse.

Giữ Herdr visibility ở MVP. Không biến mỗi closed task thành một pane lịch sử tồn tại mãi.

---

## 7. Assessment Engine: outer loop thực sự

### 7.1. Trách nhiệm tối thiểu

Engine nằm trong owner extension runtime, bắt đầu sau human confirmation và shutdown cùng assessment. Không tạo watcher/timer/process trong extension factory.

State tối thiểu:

```text
runId, epoch, authorityPhase
loopMode = manual | event-driven
plannerState = idle | scheduled | running | waiting | blocked | finishing
eventSequence, consumedSequence, pending semantic events
frontier, current claims, worker slots
budgets, runtime profile, snapshot completeness
```

`plannerState=waiting` **không phải** run finished; không phát final report/cleanup chỉ vì Planner trả một assistant turn ngắn.

### 7.2. Chỉ wake theo semantic event đã commit

Events ưu tiên:

- assignment report committed (completed/blocked/partial/provider-error).
- candidate ready for validation/review, control/evidence withdrawal.
- prerequisite reviewed/revised, slot/capacity change cần quyết định.
- accepted human hint/goal change.
- executor failure hoặc budget state change.

Không wake mỗi stdout chunk, skill read, raw note hoặc timer tick. Facts chỉ wake sớm khi có **explicit actionable handoff**; findings/candidates vẫn là claims cần review.

Persist state trước, emit event sau. Report commit phải nhất quán với assignment terminal flag/revocation; callback persist report hiện nằm trước `registration.reported/revoke`, nên **không được gắn wake naïvely ngay giữa callback**. Engine cần completion commit boundary/idempotent outbox để không thấy worker vừa reported vừa live rồi double-dispatch.

Coalesce có bounded queue và sequence cursor; event mới trong khi Planner running không mất, được xử lý round tiếp theo. Không có hai Planner rounds đồng thời cho một run.

### 7.3. Wait không phải model polling

Planner có thể kết thúc round bằng disposition:

```text
dispatch / wait_for_events / request_review / blocked / finish_proposal
```

- Nếu còn workers làm relevant work: Engine giữ waiting, không tự đẻ request “hãy kiểm tra status” đều đặn.
- Event hợp lệ đến: một wake đủ cho cả batch.
- Frontier ready + slot trống: Engine dispatch accepted tasks không cần LLM lặp lại spawn từng cái.
- Không có ready work/worker/event mà goal chưa đạt: Planner có một no-feasible-work decision có lý do; chuyển blocked/human-needed, **không ép invent task**.
- Quiet time chỉ observation, không bằng provider failure/dead worker.

Heartbeat mặc định chỉ kiểm tra local lifecycle/transport. Model-consuming supervision heartbeat là opt-in, rate-limited và có consent; không copy heartbeat 600s của ARTEX thành compulsory paid loop.

### 7.4. Tích hợp đúng Pi 1.0.0 boundary

Pi đã có inner loop; **không viết LLM/tool harness mới**.

- `agent_end` có thể còn retry/queued work; không dùng làm terminal truth.
- `agent_settled` notification-only; không return continuation ở đó.
- `agent_before_settle` có `BoundaryResult {entries?, continue?}`, `context.canContinue`, pending messages và outcome.
- Khi có pending actionable event, run còn active, loop authorized, outcome hợp lệ và không đụng human queued input: có thể append **typed custom boundary entry** rồi `continue: true` cho đúng một next request.
- Sau khi Pi thực sự idle, event bridge dùng `pi.sendMessage(..., {triggerTurn:true, deliverAs:'followUp'})` qua coalesced wake adapter; semantics busy/idle phải được integration-test, không assume từ tên method.
- `context` inject request-local snapshot, không tự trigger model/process và không thay toàn bộ Pi system prompt.
- Không gọi command-only `ctx.waitForIdle/newSession/reload` từ lifecycle handler; tránh deadlock.

Nếu muốn fresh Planner session mỗi round như ARTEX, dùng explicit SDK/RPC adapter ở phase sau. Không reset session chính để giả lập fresh rounds, không gán `agent.state.messages=[]`, không phá human conversation hoặc tool-call/result pairs.

### 7.5. Continuation guard không được thiếu

Trước mọi continuation/dispatch kiểm tra:

1. Current owner instance, run ID, epoch, active phase.
2. Consent cho event-driven loop + configured resource/model policy.
3. New actionable sequence/disposition, không unconditional “keep working”.
4. Không finalizing/stopped/revoked/provider-blocked; không lặp unchanged failure.
5. Pending human input ưu tiên; steer phải được nhận ở safe boundary.
6. State/ledger complete; known policy/method prerequisites còn current.
7. Budget còn allowance; report/control không bị target-command budget chặn.

Stop tăng epoch và đóng gate **trước** cancel/drain. Timer, spawn, report và queued wake cũ không thể reauthorize run. Một message đã queue trước stop cũng không được mở lại target; P0 phải chứng minh queue suppression/cancellation bằng Pi thật, không chỉ fake event. Nếu API không đủ để đảm bảo không có paid stale turn, adapter phải đổi thiết kế trước rollout.

Không can thiệp `/goal`; assessment loop là workflow p2o riêng. Goal mode của harness vẫn inactive, không gọi goal tools.

### 7.6. Failure/retry policy

- Worker natural stop không report: giữ blocked lifecycle report hiện tại; có thể thêm tối đa một report-only repair turn **chỉ khi được cấu hình/consent**. Không biến mọi completion thành “cứ tiếp tục”.
- Worker provider error: commit partial report/event; không tự replay target actions.
- Planner provider error: ngừng auto scheduling; giữ scope gate/control/cleanup, thông báo paused/blocked. Default vẫn không unattended retry/fallback.
- User abort/stop: revoke/cancel, không coi là retryable error.
- Retry chỉ khi policy cho phép, classified failure, bounded attempts và explicit replay-safe checkpoint; auth/profile mismatch fail closed.
- Hết target command budget: report partial, giữ unresolved proof; không sinh worker mới để reset allowance.

---

## 8. Executor và cancellation: không để nhiều workers cùng nghẽn một hàng

### 8.1. Không chỉ bỏ `enqueue`

Global queue hiện bảo vệ shell lifecycle, HTTP sessions và teardown. Xóa nó naïvely có thể tạo races/cross-worker contamination và background processes không được dọn.

**PROPOSED staged execution:**

1. Engine queue riêng theo assignment + global semaphore `maxConcurrentTargetOps`.
2. HTTP ephemeral container ownership/session mutation locks đúng actor; cancellation của A không đụng B.
3. Shell execution độc lập theo worker slot/assignment container nếu muốn concurrent + isolated cancellation đáng tin cậy.
4. Source mount vẫn là bounded read-only snapshot; scratch và cookie state không dùng lẫn actors/assignments.
5. Teardown đóng admission, cancel mọi queue/in-flight, rồi verify all run-labelled containers/panes gone.

Một directory `/work/<id>` trong shared container không phải file/process isolation. Per-slot executor là thay đổi resource/isolation model, cần update consent và acceptance, không tuyên bố VM sandbox.

### 8.2. Trade-offs cần công khai

- N containers tăng RAM/CPU/disk và tool setup cost; không nhân 2 GiB × N âm thầm.
- Tool installs/artifacts: shared approved base image; scratch riêng; không tự merge credentials/tool state.
- Target state-changing operations có thể tranh chấp dù containers độc lập; per-origin/actor/surface execution policy và controls cần serialize khi phù hợp.
- Nếu vẫn dùng shared shell trong MVP, UI phải nói **shared-serial executor**; cancel fail-closed có thể làm run execution unavailable. Không dùng nhiều pane để quảng cáo target parallelism chưa có.

---

## 9. Shared state và context cho run dài

### 9.1. Học dual-state, không copy PostgreSQL stack

Giữ ba lớp tách biệt:

| Lớp | Nội dung | Quyền/ý nghĩa |
|---|---|---|
| Resource/surface inventory | Source route, endpoint/method, actor/gate/consumer, identity, unknowns | Resource knowledge; không tự mở scope |
| Exploration/task state | Goals/questions, intents, prerequisites, claims, observations, reviewed outcomes, lineage | Coordination và reasoning support |
| Evidence/report store | Receipts, proof level, controls, candidate revisions, report parts/export | Evidence-linked claims, không truth oracle |

Bắt đầu từ JSONL hiện có + owner-owned typed indexes/projections. Không cần Neo4j/PostgreSQL, vector DB hoặc graph visualizer để có outer loop.

### 9.2. Snapshot riêng theo role

**Planner snapshot:** goal/acceptance, loop policy, budgets, queue counts/ready/waiting, live assignment status, delta event IDs, review-needed packets, accepted/new facts, unresolved candidate links và decision journal.

**Worker snapshot:** đúng mandate/current revision, prerequisites/evidence, assigned resources/actor, method/skills, remaining allowance, stop condition; sibling knowledge chỉ đọc để tránh redo, không nhận “hãy mở mọi mặt chưa test”.

**Reporter snapshot:** current candidate/validation/coverage/report records + omissions/diagnostics; không raw chat history.

Mọi bounded view phải có total, shown, omitted, cursor, completeness, retrieval IDs. Không lấy `len(recent_window)` làm absolute total hoặc absence proof.

### 9.3. Chống full-scan và context growth

Hiện TaskBoard/command readiness/candidate/context refresh có thể scan toàn ledger lặp lại. Đây là scalability concern từ source, chưa có benchmark latency.

- Incremental owner index/cursors + append revision serialization; indexes là derived, journal mới là provenance.
- Verified snapshot/checkpoint và segmented retention khi cần; không xóa raw proof refs để “compact graph”.
- Corrupt tail/missing segment/version mismatch => incomplete/fail closed, không fallback sang recent tail rồi claim complete.
- Decision journal/todo phải lưu qua rounds; session compaction không được làm mất authority/mandate/current dependency revision.
- Cold digest là navigational derived summary, có covered IDs; không được dùng thay receipt hoặc independent validation.
- Full evidence spill/export có thể là phase sau: receipt hiện chỉ giữ bounded output/hash, hash không phục hồi phần đã bỏ. Không hứa full artifacts đã tồn tại.

Durable history **không đồng nghĩa durable authority**. Sau process/session restart: read-only reconstruction, explicit human re-confirmation/new run admission mới được execute. Không tự phục sinh tickets từ journal.

---

## 10. Budget policy: nới giới hạn sai, giữ kiểm soát đúng

**Giữ yêu cầu đã ship:** không assessment/worker/container TTL và không mandatory task timeout. Timer debounce/local health check không phải duration ceiling. Optional timeout vẫn explicit.

Tách cấu hình/telemetry:

```text
concurrent model assignments
concurrent target operations
total worker target-command allowance (không reset khi đổi slot)
lead/planner model rounds + known usage/cost
knowledge reads / state writes
control/report reserve
pending frontier / retained evidence limits
```

- Bỏ lifetime spawn cap gắn với concurrency; không bỏ command budgets bằng stealth.
- Per-assignment allowance có thể cấp từ run budget thay fixed 200 cho mọi task; có thể request thêm khi có material progress.
- Renewal chỉ từ operator policy/explicit approval, persisted decision; Planner không tự mint budget vô hạn.
- Worker báo partial-budget là đúng; Engine không đánh completed/confirmed.
- Control/report/revoke/cleanup và emergency gap reporting còn dùng được khi target-command allowance hết.
- Usage/cost thu từ Pi/provider và nested calls khi có; unknown không coi là 0. Không hứa hard monetary cap nếu provider không có accounting đủ.

Ví dụ cấu hình hướng tới (tên/schema **chưa tồn tại**, P0 phải chốt): `loopMode`, `maxConcurrentWorkers`, `maxConcurrentTargetOps`, `workerCommandAllowance`, `maxPendingIntents`, `supervisionHeartbeat`, `retryPolicy`. Không thêm mặc định runtime chỉ bằng document này.

---

## 11. Roadmap triển khai với acceptance gates

### P0 — Contract, characterization và Pi wake spike

**Ưu tiên P0.**

- Characterize role/toolsets, spawn caps, report commit order, natural settlement, command budgets, shared queue/abort và current cleanup.
- Chốt intent/task schema version/migration; queue admission vs reviewed dependency readiness.
- Dùng scripted/inert provider để chứng minh busy/idle wake, boundary continuation, human priority, stop race, pending queue cancellation, compaction và SDK compatibility.
- Đo current baseline: lifetime assignments, model rounds/polling, target-op queue wait, lead vs worker task counts.

**Gate:** có state machine, typed event contract và real-Pi trace; không chỉ fake handlers. Không commercial calls/target traffic.

### P1 — Role split và giảm thao tác Planner

- Owner prompt thành strategic Planner khi delegated; solo working-agent riêng.
- Enforced role-specific tool loadouts; reporting read-only default; worker subtask proposals, không direct spawning.
- Batch/thin intent submission; Engine normalize defaults, preserve task/method/evidence provenance.
- Worker/report packet nav compact; validator/reporter được giao phần nặng.

**Gate:** Planner không target execute trong delegated mode; Worker không tự dispatch accepted work; solo không bị khóa nhầm. Independent proof và stale-support tests không giảm chuẩn.

### P2 — Frontier + logical pool, bỏ lifetime spawn choke

- Tách total historical assignments khỏi active slot capacity; close/recycle finished pane safely.
- Queue ready/waiting/blocked; atomic reservations, priority + fairness, dependency currentness.
- Operator-configurable concurrency qua settings/CLI; same validation source, explicit resource/profile policy.
- Budget exhaustion/backpressure trả reasons; không bypass bằng fresh worker identity.

**Gate:** ít nhất 30 sequential assignments trên concurrency=3 bằng inert provider, không vượt active cap; xử lý được hơn old 6/12 spawn ceiling. Test một cấu hình >6 khi preflight cho phép và rejection khi không cho phép. Không cần tăng live workers trong turn lập kế hoạch này.

### P3 — Event-driven Planner loop và wait đúng nghĩa

- Add Engine/event bridge, report-after-commit outbox, coalescing/sequence cursors.
- Opt-in event-driven mode với consent mô tả thêm paid rounds; manual mode vẫn hoạt động.
- Single Planner in-flight; pending events survive round; no paid idle polling by default.
- Wait/blocked/finish disposition và cancellation epoch; provider error default block, không replay/fallback.

**Gate:** report đến sau Pi idle tự wake đúng một planning round trong mode đã consent; signal burst coalesced; no follow-up after stop; human queued message không bị overwrite; duplicate/late event không dispatch thêm.

### P4 — Execution concurrency và isolated cancellation

- Per-assignment/per-slot executor ownership + semaphores; HTTP actor/session locks.
- Giữ bounded source, fixed image/runtime verification, network authorization boundaries và verified sweeps.
- Resource consent/progress nói đúng number of executors, queue/running/returned.

**Gate:** worker A long command không chặn independent B trong profile parallel; cancel A không xóa B executor; stop run dọn cả A/B, queued work không chạy. Nếu chưa đạt, ship shared-serial rõ ràng, không claim parallel target execution.

### P5 — Long-run state, role projections và resumable work

- Incremental index/snapshot + durable decision/todo, bounded frontier/history retention.
- Resource inventory/query, typed observations, digests chỉ để navigation.
- Warm SDK/RPC backend/reuse chỉ sau fresh assignment/session/ticket-generation isolation.
- Resume history không resume authority; installed artifact/runtime-profile checks tiếp tục fail closed.

**Gate:** multi-round + compaction vẫn thấy correct mandate/revisions; >100 historical closed tasks nếu live-frontier policy cho phép; old ticket/socket/report không ảnh hưởng assignment mới; incomplete archive không biến thành complete.

### P6 — Acceptance, rollout và effectiveness study riêng

- Typecheck/build/import, focused/full regressions và library/provenance/package checks.
- Real Pi + inert provider, visible Herdr opt-in, Docker/lab-only acceptance; installed version/hash match.
- Update README/USAGE/ARCHITECTURE/ASSESSMENT_STATE/HANDOFFS để bỏ câu working lead/total spawn assumptions đúng phase.
- Versioned receipts, qualified limits, rollback manual/solo; historical studies giữ nguyên.

**Gate:** cơ chế loop/role/control được kiểm chứng trên shipped artifact. Chất lượng phát hiện, token/cost reduction hoặc superiority so với ARTEX là **study riêng**, không suy ra từ unit tests. Paid benchmark/live target chỉ sau authorization riêng.

---

## 12. File map cho implementation sau khi được duyệt

| File/module | Hướng thay đổi |
|---|---|
| `extensions/p2o/index.ts` | Adapter mỏng: commands/tools/events, consent, session guards; rút runtime orchestration ra service |
| `src/engine.ts` (mới, tên tạm) | Run state machine, admission, scheduling, semantic event pump, round gate |
| `src/planner-bridge.ts` (mới) | Pi busy/idle boundary/wake coalescing; không tự viết provider loop |
| `src/tasks.ts` | Queued dependency validity vs readiness, current revisions, capacity/claim views |
| `src/roles.ts` + `src/prompts.ts` | Strategic/solo responsibility, role capabilities, configurable capacity/profile |
| `src/broker.ts` + `src/ticket.ts` | Assignment identity/generation, authority gate, commit event ordering, control reserve |
| `src/herdr.ts` | Pane lifecycle/backend interface; fresh process slots trước, warm reuse sau |
| `src/sandbox.ts` + `src/process.ts` + `src/http-session.ts` | Executor ownership, concurrency, abort isolation, actor/session serialization |
| `src/records.ts` + `src/progress.ts` | Indexed state/events/projections; progress vẫn không coi silence là failure |
| `src/evidence.ts` + `src/report.ts` | Current support, review packets, bounded complete reconciliation/export; không auto-proof |
| Docs + `tests/minimal/*` | Contract migration, compatibility, fixtures, recorded acceptance |

Không tách thành nhiều module chỉ để đẹp sơ đồ. P0/P1 giữ nhỏ; các module trên là seam/responsibility, không phải phải tạo tất cả ngay.

---

## 13. Regression matrix tối thiểu

| Case | Expected invariant |
|---|---|
| 3 slots, 30 assignments nối tiếp | Active ≤3, completed slots reusable; không lifetime spawn error |
| Batch intents > free slots | Queued, không lỗi cap như spawn trực tiếp |
| Prerequisite chưa-reviewed / revised giữa claim và command | Không execute dependent; stale support được chặn |
| Same surface/risk/actor/method duplicated | Hard exact reservation gate; khác wording không tự đủ novelty |
| Worker report event trước/sau registration terminal | Một commit/slot release/wake; không double assignment |
| Report đến trong Planner round và ngay sau idle | Không mất event, không overlapping rounds |
| 100 noisy notes / stdout chunks | Không 100 paid Planner wakes |
| Waiting vài giờ bằng fake clock, không semantic event | Không auto expiry và không model polling |
| Human steer/stop tại boundary | Human ưu tiên; stop gate đóng trước cleanup |
| Stop trong debounce/spawn/HTTP/DNS/pending wake | Không late execution, ticket resurrection hoặc paid stale wake |
| Worker provider quota, Planner error, auth/profile mismatch | Blocked/partial đúng nguyên nhân; không implicit fallback/replay |
| Command/coordination/retention budget exhausted | Report/stop vẫn dùng được; không mint fresh worker để bypass |
| A long exec, B short exec; cancel A | Parallel profile không HOL và không hủy B; serial profile báo đúng limits |
| Reporting role thử shell/delegate; Planner thử HTTP | Denied ở enforcement, không chỉ prompt |
| Slot tái dùng; old socket/report/ticket; compaction | Assignment/token/context tách biệt; no restored authority |
| Corrupt ledger, missing report part/archive, old validation revoked | Incomplete/gap, không confirmed/complete false-positive |
| All workers settled nhưng open proof gaps còn | Report partial/gaps, không full-target safe hoặc “goal met” chỉ theo counts |
| Session switch/reload/shutdown/hard-kill recovery | Idempotent verified cleanup; unresolved teardown công khai |

Các tests này là **yêu cầu tương lai**, không phải kết quả đã pass của turn này.

---

## 14. Đo sự cải thiện, không lấy “loop lâu” làm thành công

Trên cùng inert/lab fixtures, model/profile/budget và stop conditions:

- Assignments processed / active-cap violations / duplicate assignments.
- Event-to-round scheduling và target queue wait, tách model latency khỏi scheduler latency.
- Planner rounds không có material delta; idle model calls (mặc định phải 0).
- Tỷ lệ lead target commands trong delegated mode (mục tiêu 0), review calls trên packet vs raw stdout.
- Unresolved prerequisite, partial-budget, provider failure, stale-support và cleanup diagnostics.
- Context bytes/tokens theo round và retrieval completeness, không chỉ snapshot size.
- Usage/cost biết được và unknown accounting; keep/renew policy.
- Finding correctness/negative controls/independence trên labeled authorized fixture, không dùng số lượng findings để tự chấm goal.

Không cam kết “nhiều worker hơn = tốt hơn”. Concurrency có thể tăng chi phí, rate limits, duplicate effort hoặc target contention; phải đo.

---

## 15. Quyết định kiến trúc đề nghị duyệt

1. **Current Pi = strategic Planner trong delegated mode; solo là working agent.** Engine không phải một LLM orchestrator nữa.
2. **Event-driven outer loop** có explicit consent, wait không paid polling, no unconditional continuation, manual compatibility.
3. **Frontier + reusable capacity**, bỏ lifetime spawn cap gắn với N; command/resource/retention policies vẫn explicit.
4. **Worker tactical autonomy trong một intent**, incremental evidence; subtask request qua Planner, không uncontrolled spawn tree.
5. **Per-role capabilities và executor concurrency/cancellation isolation**, không chỉ đổi prompt hoặc nâng hard cap.
6. **Giữ và mở rộng TaskBoard/EvidenceStore/ledger**, không import ARTEX/norma hay copy cả server/DB/UI stack.

Thứ tự nên làm: **P0 -> P1 -> P2 -> P3** để giải quyết role và loop trước; **P4** cần trước khi claim parallel target execution; **P5/P6** hoàn thiện long-run/rollout. Không gom cả redesign thành một giant commit.

### Source navigation

- ARTEX scheduler/wait/pool: `my_references/ARTEX/server/engine.go:748–1245`.
- ARTEX signals: `my_references/ARTEX/server/manager.go:1751–1860`.
- ARTEX strategy/context/todo: `my_references/ARTEX/agent/planner.go:23–51,108–473`.
- ARTEX tactical mandate/resume: `my_references/ARTEX/agent/worker.go:94–96,230–535`.
- ARTEX intents/overview/proofs: `my_references/ARTEX/agent/tools.go:354–551,1021–1405,2033–2054`.
- ARTEX claim: `my_references/ARTEX/db/exploration.go:1136–1182`.
- ARTEX role sessions/settings: `my_references/ARTEX/server/task_llm.go:552–606`; `server/server.go:296–322`; `server/manager.go:319–337`.
- Norma inner loop/settlement: `my_references/ARTEX/research_sources/norma-v0.4.3/harness/query.go:366–579`; `agentcore/agentcore.go:364–529`.
- p2o spawn/report/settle: `extensions/p2o/index.ts:181–285,329–348,746–898,956–979`.
- p2o constraints/state: `src/roles.ts`, `src/tasks.ts`, `src/broker.ts`, `src/sandbox.ts`, `src/prompts.ts`, `src/records.ts`, `src/evidence.ts`, `src/report.ts`, `src/progress.ts`.
- Pi contract: installed 1.0.0 `docs/extensions.md`, `docs/sdk.md`, `docs/compaction.md`, `docs/message-types.md`; project `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:709–762,1212–1227`.

**Mental model cuối:** Planner quyết định *việc đáng làm tiếp*, Worker quyết định *cách làm việc đã nhận*, Engine quyết định *khi nào/có quyền/còn capacity để chạy*; evidence/state giúp rounds sau hiểu đúng kết quả. Đây mới là cơ sở cho một loop dài và trơn tru — không phải để một orchestrator ôm mọi việc rồi chỉ bỏ đồng hồ.
