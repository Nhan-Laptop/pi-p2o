# Kế hoạch thu hẹp điểm nghẽn workflow — tham khảo ARTEX/Strix

Tiếp theo đánh giá workflow (`/p2o --target` → Planner → task → worker) trong phiên trước. Tài liệu này chỉ **đọc tĩnh**
`my_references/ARTEX/` và `my_references/strix/` để lấy pattern tham khảo — không chạy, không import, không đóng gói
code của chúng (giữ nguyên quy ước ở [ASSET_GRAPH.md](docs/ASSET_GRAPH.md)). Mỗi đề xuất ghi rõ pattern nguồn, cách áp
vào p2o và khác biệt/lý do không bê nguyên. Đây là **kế hoạch**, chưa triển khai; không đổi hành vi hiện tại.

## Tám điểm nghẽn đã xác định (phiên trước)

1. Cỗ máy tri thức K3–K6 (graph/case/coverage/context packet) nặng hơn mức model thực sự dùng — benchmark cho thấy ép
   dùng (`toolGuidance`) tăng chi phí +73% mà không tăng recall/precision.
2. `p2o_task create` đòi hỏi quá nhiều field bắt buộc (question/surface/risk/roleReason/expectedTrue/False/stopCondition/
   method.reason) cho một câu hỏi recon nhỏ → model né sang `p2o_delegate` không cấu trúc.
3. Recon (khâu chọn hướng tiếp theo quan trọng nhất) chỉ có `p2o_note` tự do, không identity/dedup, trong khi tầng
   downstream (task/case/coverage) lại rất chặt.
4. Manual loop (mặc định) không có gì chủ động nhắc Planner sau khi worker report; người dùng phải tự quay lại gõ tiếp.
5. Spawn worker luôn cold-start (pane mới + tiến trình Pi mới + brief + poll 15s), không có warm reuse — chi phí/latency
   tích lũy theo số task.
6. `--workers N` với `shared` executor dễ bị hiểu nhầm là N-way target throughput.
7. Validate độc lập nhân đôi chi phí spawn, không có fast-path cho finding rủi ro thấp.
8. Context packet bị bound theo từng turn, nhưng transcript Pi của Planner vẫn phình theo toàn bộ lịch sử assessment;
   không có cơ chế compact tri thức cũ, chỉ có số đo `%` hiển thị ở `/p2o status`.

## Pattern tham khảo từ ARTEX và Strix

| # | Nguồn | Pattern | Khác với p2o hiện tại |
|---|---|---|---|
| A | ARTEX `agent/planner.go` | Planner event-driven: mỗi lần graph đổi (debounced) thì đọc route + asset graph, xét goal, phát **0..N intent** — không phải tạo một "task" đầy đủ field mỗi lần | p2o `p2o_task` là record nặng, không có khái niệm "intent nhẹ" tách khỏi "task đầy đủ" |
| B | ARTEX `agent/worker.go` | Worker nhận đúng **một intent**, ghi FACT trở lại graph, dừng — không tự sinh hướng mới | p2o Worker đã giống vậy (role tactical), nhưng input nó nhận (`question` field) không mang theo cấu trúc contrast/stop condition trực tiếp trong brief |
| C | ARTEX `agent/goals.go` | Bước đầu tiên của goal-decomposer là **tách constraint deny/allow** từ mô tả người dùng, ghi riêng (`set_constraints`) *trước khi* chia goal | p2o `--goal` chỉ đưa text vào prompt như "dữ liệu trích dẫn", không có bước tách constraint có cấu trúc |
| D | ARTEX `agent/retester.go` | Agent retest riêng, phạm vi hẹp: đọc đúng context của 1 finding, verdict cố định `reproduced/fixed/inconclusive`, tự cập nhật trạng thái khi `fixed`, không cho tạo task/finding mới | p2o có `decision.disposition=retest` chung trong `p2o_task`, không có vai trò/prompt retest riêng và không có verdict enum ép buộc |
| E | ARTEX `agent/compaction.go` | Compaction hai tầng: **maintain** (rẻ, đồng bộ, mỗi round, chỉ bookkeeping hot/cold, không gọi LLM) và **minor/major** (nền, LLM digest cụm cold-node, có mutex + cooldown + recheck liveness lúc commit) | p2o K6 chỉ bound *theo turn*; không có tầng "cold" được digest — record cũ vẫn giữ nguyên dạng thô mãi, Planner context cứ phình |
| F | ARTEX `agent/side_questions.go` | Kênh phụ cho agent hỏi người dùng một câu ngắn, gắn với `task/exploration/intent` hiện tại, không phá luồng chính | p2o chưa có; worker muốn hỏi phải block hoặc `p2o_request_subtask` rồi chờ Planner relay |
| G | Strix `strix/tools/notes/*`, `coverage/*` | Tool chuyên biệt, nhỏ, có schema riêng cho từng loại dữ liệu (note/coverage) thay vì một tool gộp | p2o `p2o_note` gộp note/coverage/observation/open vào một tool với field tùy chọn lỏng |
| H | Strix `view_agent_graph`, `wait_for_agents` | Xem toàn bộ cây agent + chờ có điều kiện | p2o đã có tương đương (`p2o_workers waitFor`) — không cần đổi |

## Đề xuất, theo thứ tự ưu tiên

**Trạng thái (2026-10-12):** P1.1–P1.4 và P2.2 đã triển khai (code + test, xem ghi chú ĐÃ XONG trong mỗi mục). P2.1
không cần thêm cơ chế mới — đọc lại `src/work.ts`/`src/case-types.ts`/`src/cases.ts` trước khi code cho thấy p2o đã có
đúng thứ P2.1 muốn (xem ghi chú dưới). P2.3 và P3 vẫn chưa làm, giữ đúng lý do "cần thiết kế/đo thêm" đã ghi khi viết
kế hoạch.

### P1 — Rẻ, không đổi kiến trúc, giảm ma sát ngay

**P1.1 Task "nhẹ" cho recon, tách khỏi task "đầy đủ" cho discovery/validation** (tham khảo A)
Thêm một biến thể draft tối thiểu cho `role=recon`: chỉ bắt buộc `question`, `surface`, `risk`; `expectedTrue/False`,
`stopCondition`, `method.reason` trở thành tùy chọn khi `role==='recon'` (mặc định rỗng có cảnh báo, không chặn).
Giữ nguyên yêu cầu đầy đủ cho discovery/validation/reporting — nơi contrast thật sự cần. Không đổi schema atomic
reserve/dedup; chỉ nới điều kiện `validate()` theo role. Việc này giảm trực tiếp lý do model né `p2o_task`.
**ĐÃ XONG:** `src/tasks.ts` `validate()`, `src/tool-schemas.ts` `taskDraftSchema`, `extensions/p2o/index.ts` (default
hóa field thiếu); test trong `tests/minimal/extension.test.ts`.

**P1.2 Dedup rẻ ở lớp note/recon trước khi cần `work` đầy đủ** (tham khảo G)
Thêm một tool nhỏ `p2o_surface` (tách khỏi `p2o_note`) cho đúng một việc: ghi surface inventory với key chuẩn hóa
(`component` + `entryPoint`, NFC, trim, lowercase) và trả cảnh báo nếu key đã tồn tại trong run — không phải fingerprint
đầy đủ như `work`, chỉ là hàng rào rẻ bắt được phần lớn trùng lặp thô. `p2o_note` giữ nguyên cho note/coverage/open tự do.
**ĐÃ XONG:** tool mới `p2o_surface` (owner + worker, không qua `appendGeneratedRecords`/idempotent replay — cố ý ở mức
rẻ hơn `p2o_note`), `surfaceKey`/`recordSurface` trong `src/records.ts`, case `'surface'` trong `src/broker.ts`; test
trong `tests/minimal/extension.test.ts` (owner path) và `tests/minimal/worker.test.ts` (worker path qua broker).

**P1.3 Nhắc Planner chủ động hơn ở manual loop** (không cần pattern ngoài, chỉ là UX)
Khi `p2o_report` tạo handoff ở manual mode, thêm một dòng rõ ràng trong `ctx.ui.notify` kiểu
`"N worker đã report, chưa được Planner review — gõ bất kỳ để tiếp tục"`, và `/p2o status` hiển thị số report chờ
review ngay đầu output (không chỉ nằm trong bảng worker). Không đổi cơ chế event-driven, không tốn thêm round.
**ĐÃ XONG:** `reportCommitted` trong `extensions/p2o/index.ts` (chỉ ở `engine.mode==='manual'`), dòng cảnh báo mới ngay
sau title trong `statusView()` (`src/ui/state.ts`); test trong `tests/minimal/extension.test.ts` và
`tests/minimal/visibility.test.ts`.

**P1.4 Cảnh báo rõ ở confirm dialog khi `--workers > 1` + `shared`**
Thêm một dòng trong hộp xác nhận: "shared: N worker suy luận song song nhưng dùng chung một hàng đợi target — muốn
thực thi song song thật, chọn `--executors isolated`". Chỉ sửa text, không đổi default.
**ĐÃ XONG:** dòng điều kiện mới trong confirm dialog (`extensions/p2o/index.ts`, phần "Executors:"); không có pin test
nào khớp đúng chuỗi này nên không cần cập nhật test, đã xác nhận bằng grep trước khi sửa.

### P2 — Trung hạn, thêm cơ chế mới nhưng cục bộ

**P2.1 Vai trò retest chuyên biệt, verdict cố định** (tham khảo D)
Thêm role/prompt `retest` riêng (không dùng chung `validation`): chỉ nhận đúng context của một case đã accepted
(qua `taskCapsule`-như packet, giới hạn vào đúng case đó), verdict ép buộc enum `reproduced | fixed | inconclusive`
thay vì prose tự do. `fixed` với evidence đủ thì tự động đề xuất case chuyển `remediation.accepted` (vẫn cần owner
review, không tự accept) — giữ nguyên gate K5 hiện có, chỉ thêm một lối vào hẹp và rõ hơn `decision.disposition=retest`
chung hiện tại.
**KHÔNG LÀM — đã có rồi:** đọc kỹ `src/work.ts`, `src/case-types.ts`, `src/cases.ts` trước khi code lộ ra là p2o đã có
đúng cơ chế này, chặt hơn cả ARTEX: `WORK_PURPOSES`/`WORK_DISPOSITIONS` đã có `'retest'` với `retestOf` + `changeReason`
bắt buộc (`src/work.ts` `validateWorkDecision`); `REMEDIATION_STATUSES` đã có `'retest-pending'|'retested'|'accepted'|
'failed'` — chính là verdict enum muốn thêm; `cases.ts` đã ép `remediation.status==='accepted'` phải có `retestTask`
đã pin + evidence + task đang ở trạng thái `reviewed`/`closed` (`retest-not-currently-reviewed` check) — tức "fixed có
evidence thì owner mới accept, không bao giờ tự động" đã đúng nguyên tắc K5. Thêm một "role" mới ở đây sẽ là
abstraction trùng lặp, không theo nguyên tắc đơn giản của CLAUDE.md — nên dừng ở đây, không code thêm.

**P2.2 Tách constraint deny/allow khỏi `--goal`** (tham khảo C)
Khi `--goal` được dùng, prompt Planner gọi `p2o_plan` để ghi *constraint* (deny/allow) như một `kind` riêng — tách
khỏi goal/todo/decision hiện có — trước khi phân rã goal thành task. Không đổi cơ chế xác nhận scope (constraint vẫn
chỉ là ghi chú có cấu trúc, không tự nới/hẹp scope đã confirm, giữ đúng nguyên tắc "chỉ con người đổi scope").
**ĐÃ XONG (thu nhỏ hơn đề xuất gốc) — không cần `kind` mới:** đọc `src/planning.ts` trước khi code lộ ra `goal` đã có
sẵn field `criteria`/`exclusions` (exclusions = đúng "deny constraint" muốn thêm), chỉ thiếu một câu nhắc Planner dùng
nó cho STATED OBJECTIVE. Đã sửa một câu trong `ownerInstructions()` (`src/prompts.ts`): "Turn it into goals with
acceptance criteria and keep them in the plan" → "...and explicit exclusions (what it does not authorize) in the
plan". Hash/length pin trong `tests/minimal/recon.test.ts` không bị ảnh hưởng (chỉ áp dụng khi có `statedObjective`).

**P2.3 Kênh hỏi nhanh từ worker lên Planner/người dùng** (tham khảo F)
Thêm action `ask` cho `p2o_request_subtask` (hoặc tool mới `p2o_ask`): worker gắn câu hỏi ngắn vào đúng `taskId`,
Planner thấy nó như một event ưu tiên cao (không chờ report), trả lời qua `p2o_steer`. Khác ARTEX: không trả lời tự
động bằng model phụ — người dùng hoặc Planner vẫn là người quyết, giữ nguyên "chỉ con người đổi scope/budget".


## Không làm

- Không copy `agent/compaction.go`, `agent/retester.go`, `agents_graph` hay bất kỳ code ARTEX/Strix nào; chỉ tham khảo
  pattern mô tả ở trên.
- Không đổi default `toolGuidance=false`, không đổi default loop/executor mode trong P1–P2.
- Không tự ý mở rộng/thu hẹp scope qua constraint (P2.2) hay qua ask-channel (P2.3) — quyết định scope vẫn chỉ ở
  confirm dialog của người dùng.

## Thứ tự triển khai đề xuất

P1.1 → P1.2 → P1.3 → P1.4 (không phụ thuộc nhau, làm song song được) → P2.1 và P2.2 (độc lập) → P2.3 → đo P3.2 →
quyết P3.1 dựa trên số đo. Mỗi mục khi triển khai: chạy `impact` trước khi sửa hàm liên quan (theo AGENTS.md), thêm
test, và cập nhật đúng một dòng trong `docs/VERIFICATION_LOG.md` thay vì mở rộng lại các doc đã được rút gọn.

**Còn lại (chưa làm, đúng như kế hoạch gốc):** P2.3 (kênh ask từ worker) và cả P3 (compaction hai tầng, warm worker) —
vẫn cần thiết kế/đo thêm trước khi code, như đã ghi khi viết kế hoạch này.
