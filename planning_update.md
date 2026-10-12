# Kế hoạch thu hẹp 4 điểm chồng chéo trong core agent loop (a/b/c/d)

Tiếp theo đánh giá lại core agent loop sau khi P1.1–P1.4/P2.2 đã merge (`dffcb96`). Bốn vấn đề dưới đây được tìm ra bằng
cách đọc trực tiếp source hiện tại của p2o, rồi đối chiếu với cách `my_references/strix/` và `my_references/ARTEX/`
xử lý cùng vấn đề, cộng thêm vài nguồn ngoài. Tài liệu này **chỉ đọc tĩnh** strix/ARTEX, không chạy/import/đóng gói
code của chúng. Đây là **kế hoạch**, chưa triển khai; không đổi hành vi hiện tại.

**Quy ước trích dẫn:** `path:line` cho p2o/strix/ARTEX (snapshot đọc trong phiên này, có thể lệch nếu upstream đổi).
Nguồn ngoài ghi link kèm tên bài. Không có claim nào ở đây được coi là "đã verify" nếu không có trích dẫn cụ thể.

## Tóm tắt 4 vấn đề

- **(a) Coverage tách rời:** `p2o_note{kind:'coverage'}` (tự do, worker ghi được) chỉ cần tồn tại để thoả
  `CONTRACT_KINDS.coverage` (`src/tasks.ts:87`), nhưng báo cáo cuối (`src/report.ts:104-112`) **chỉ đọc**
  `CoverageBoard`/`coverageViews()` (`src/coverage.ts`) — owner-only, structured, gate chặt. `finish-preflight.ts`
  (`NO_COVERAGE_PLAN`, dòng 33/65) chỉ bắt "chưa có plan nào", không đối chiếu từng note-coverage với CoverageCell —
  worker có thể "cảm thấy đã cover" mà report thật không thấy gì.
- **(b) 4 chỗ dùng "decision"/"disposition" khác nghĩa:** `Engine.decision` (`src/engine.ts:38`, wait/blocked cấp run),
  `AssessmentTask.decision`/`WorkDecision` (`src/work.ts:18-20`, dedup cấp task: new/refine/validate/retest/retry),
  `PlanEntry` kind=`decision`/`PlanDecision` (`src/planning.ts:10-13`, cấp goal: new/reuse/refine/validate/retest/defer),
  và `p2o_note` mô tả "note (fact or decision)" (`extensions/p2o/index.ts:1045`) hoàn toàn tự do. Thêm `p2o_plan` label
  "Maintain goals, todo and decisions" (dòng 900) và `p2o_loop` label "Planner loop disposition" (dòng 1171/1176).
- **(c) Dedup nhiều lớp:** string-match surface+risk tự động, override bởi fingerprint `work`/`decision` chính xác
  (`src/tasks.ts:197-202`), và lớp mới `p2o_surface` (P1.2, `src/records.ts` + `extensions/p2o/index.ts:1068-1079`) —
  advisory, **không** nối vào `ASSIGNMENT_CONFLICT`/`workIdentity`. Tự phê bình: đây là lớp tôi vừa thêm.
- **(d) `p2o_plan` không bị enforce ở đâu cả:** `PlanBoard.references()` (`src/planning.ts`) chỉ check ID tồn tại;
  `finish-preflight.ts` không `import` gì từ `planning.ts` — không có preflight code nào nhắc tới goal/todo/decision.
  Nếu Planner không tự giác dùng, nó biến mất khỏi luồng thật, không ồn ào, không fail gì.

## Strix và ARTEX xử lý 4 vấn đề này thế nào

| # | Strix (`my_references/strix/`) | ARTEX (`my_references/ARTEX/`) |
|---|---|---|
| a | **Một ledger chung** (`_coverage_storage`, `tools/coverage/tools.py:378-535`), chặn trùng surface+risk_area ngay lúc ghi (`_duplicate_of_locked`, dòng 171-188, trả về id cũ thay vì cho ghi đè âm thầm). Đối chiếu tách riêng ở `report/coverage.py`: `skill_coverage_gaps` (dòng 230) bắt agent có skill nhưng không ghi entry nào, `_silent_agent_gaps` (dòng 270) bắt agent chạy xong mà không ghi gì, `_completeness` (dòng 314) đánh dấu `complete:false` khi exit bất thường. | **Một aggregate derive trực tiếp** từ chính `record_fact` mà mọi role đã dùng cho mọi việc (`db/task_scope.go:304-313`, join `exploration_anchors` → `exploration_nodes WHERE kind='fact'`). Không có object "coverage plan" riêng để điền song song. Đổi lại: tự ghi chú "Reference figure only" (dòng 326), fail-open khi lỗi (dòng 291-299), không ai gate review độc lập. |
| b | Không tồn tại — không có enum decision/disposition nào trong `tools/`. Khái niệm gần nhất là note category `plan` (`tools/notes/tools.py:23`), chỉ là tag tự do. | Không tồn tại ngoài phạm vi access-control (`acperm.Decision` ở `agent/tools.go:285`, `DecisionSource` ở `db/intercept.go:39` — audit log cho phép/chặn tool call, không liên quan planning). `goals.go`/`planner.go`/`retester.go` không dùng từ này. |
| c | Chỉ một tầng: đúng string-match surface+risk_area ở (a), không có gì khác — yếu hơn p2o. | Gần như không có dedup cấu trúc: `CountFinishedIntents`/`CountOpenIntents` (`db/exploration.go:802-816`) chỉ show số/mục gần đây cho model tự judge "đã thử chưa", tự nhận "planner stays cautious... purely via visibility" (dòng 802) — yếu hơn p2o. |
| d | Không có goal/plan hierarchy. `finish_scan` (`tools/finish/tool.py:16-38`) chỉ cần 4 string không rỗng, không check todos/notes gì — enforce bằng 0, kém hơn p2o (`p2o_plan` ít nhất *có cấu trúc* để enforce nếu muốn). | **Mạnh nhất trong 2 nguồn:** `startTaskEngine` (`server/goals.go:42-58`) luôn chạy `createGoals(...)` làm "round 0" **chặn** trước khi Planner engine được phép start — comment dòng 24-27 nói rõ mục đích là tránh race "planner chạy trước khi goal sẵn sàng". `launchTask` (dòng 27-38) áp dụng trên mọi đường tạo task. Constraint (`agent/constraints.go:14-48`) được nhúng vào prompt ở mức "self-check ưu tiên cao nhất trước mỗi intent/action" — vẫn là prompt-level, không phải runtime gate cứng, nhưng **bắt buộc theo thứ tự**, không phải tool có thể bỏ qua. |

**Kết luận rút ra:** Strix và ARTEX đều né (b)/(c) bằng cách *không xây* tính năng đó, không phải bằng cách giải nó
tốt hơn — với (c) cả hai còn yếu hơn p2o hiện tại (p2o là hệ dedup chặt nhất trong 3 hệ thống). (a) và (d) có một
pattern thật, đáng tham khảo:
- (a): cả hai né việc nuôi hai store song song cần đồng bộ tay — Strix đối chiếu tự động ở thời điểm report, ARTEX
  derive sống từ cùng một record workers đã ghi. p2o hiện không làm cái nào trong hai.
- (d): ARTEX chặn cứng engine chờ goal sẵn sàng. Không hợp với nguyên tắc "chỉ con người đổi scope" của p2o nếu áp
  dụng y nguyên (ARTEX tự trị hoàn toàn, không có human confirm dialog như p2o), nhưng *thứ tự bắt buộc* là ý hay có
  thể mượn ở mức nhẹ hơn (nudge/preflight, không phải hard block).

## Nguồn ngoài (web)

- [Escape Cascade — Multi-Agent Pentest](https://docs.escape.tech/documentation/ai-pentesting/multi-agent-pentest/):
  một "coverage agent" tách khỏi exploitation tools, và một "reporter" verify lại từng finding trên target thật,
  **cố tình cách ly khỏi** kênh message giữa các worker để giữ tính độc lập — rồi *hai lớp này được gộp lại* thành
  một báo cáo, khác p2o (hai lớp coverage của p2o không gộp).
- [ArkForge — "Multi-Agent Blindness: When Your Orchestrator Can't See What Workers Actually Did"](https://arkforge.tech/en/blog/multi-agent-blindness-orchestrator-verification/):
  orchestrator nhiều hệ multi-agent chỉ có *log/claim* của worker, không có *evidence* rằng worker đã làm — đúng
  triệu chứng của (a) ở p2o; khuyến nghị verify độc lập bên thứ ba.
- Idempotency nhiều lớp cho LLM agent — [tianpan.co, "LLM agents event stream idempotency"](https://tianpan.co/blog/2026/04/19/llm-agents-event-stream-idempotency)
  và [bài liên quan về idempotency pipeline](https://tianpan.co/blog/2026-04-20-idempotency-llm-pipelines): điểm
  quan trọng nhất là "store nên là *quyết định đã đưa ra*, không chỉ việc event đã được xử lý" — gợi ý hướng cho (c):
  gom các lớp dedup về **một** khái niệm work-identity có nhiều mức confidence, thay vì nhiều tool rời rạc.
- "Impossible states"/một nguồn-sự-thật-duy-nhất cho state — [dev.to, "Stop Impossible States"](https://dev.to/iprajapatiparesh/stop-impossible-states-state-machines-in-react-3djn),
  [joshka.net, "Identify Anemic State Machines"](https://www.joshka.net/practice/rules/boundary/boundary-identify-anemic-state-machines/):
  nhiều enum/field rời rạc cho cùng một khái niệm "trạng thái/quyết định" tạo ra các tổ hợp không hợp lệ và logic
  chuyển trạng thái bị rải ra nhiều nơi — đúng mô tả của (b).
- [GoalAct (arXiv 2504.16563)](https://arxiv.org/pdf/2504.16563): planning toàn cục được *cập nhật liên tục và gắn
  chặt với execution* (không phải một bước tùy chọn tách biệt), báo cáo +12.22% success rate trên LegalAgentBench so
  với ReAct thường — ủng hộ hướng (d): gắn `p2o_plan` chặt hơn vào luồng thật, không để nó là một tool có thể không
  bao giờ gọi.

## Đề xuất hướng phát triển

### (a) Coverage — thêm đối chiếu tự động, không thay thế CoverageBoard

**Không chọn** hướng ARTEX (derive coverage từ note tự do) vì sẽ làm mất độ chặt mà `CoverageBoard` đang có (evidence
refs, case link, execution/assessment enum, staleness) — với báo cáo an ninh, "note nói sạch" và "cell đã review
confirm sạch" là hai mức tin cậy khác nhau, không nên trộn lẫn.

**Chọn hướng Strix** (đối chiếu tự động ở điểm report/finish, giữ hai lớp riêng): thêm một `PreflightCode` mới, ví dụ
`UNPROMOTED_COVERAGE_NOTE`, vào `src/finish-preflight.ts` — advisory, không blocking (để không đổi default nghiêm
ngặt hơn mà chưa đo). Logic: với mỗi `p2o_note{kind:'coverage'}`/`p2o_surface` record có `surface`/`component`+
`entryPoint` không khớp bất kỳ `CoverageCellEntry.assetRef`/`questionKey` nào trong plan hiện hành → liệt kê (giới
hạn 5 như các code khác). Tái dùng đúng pattern `NO_COVERAGE_PLAN`/`UNPLANNED_ASSETS` đã có, không cần cơ chế mới.

### (b) "Decision" — đơn giản hoá tên, không mượn pattern nào (vì không ai có pattern để mượn)

Cả Strix và ARTEX hội tụ về cùng một kết luận: họ không có vấn đề này vì không xây tính năng đó. Hướng đúng là làm
cho đặt tên của p2o rõ hơn, không phải tìm cơ chế hợp nhất phức tạp từ nơi khác.

**Mức rẻ, nên làm trước:** đổi *label/description hiển thị cho model* (không đổi field/type nội bộ, không đổi test
pin cấu trúc dữ liệu) để không còn 4 chỗ cùng gọi là "decision":
- `p2o_loop` label "Planner loop disposition" → ví dụ "Planner pause/resume state" (đây là trạng thái run, không
  phải một "quyết định" theo nghĩa lựa chọn).
- `p2o_note` description "note (fact or decision)" → bỏ chữ "decision", chỉ còn "note (fact or rationale)" — tránh
  worker/Planner tưởng đây là nơi ghi quyết định có cấu trúc.
- Giữ `AssessmentTask.decision` (`WorkDecision`) và `PlanEntry` kind=`decision` (`PlanDecision`) như tên nội bộ (đổi
  sẽ động tới nhiều test/schema), nhưng trong mô tả tool `p2o_task`/`p2o_plan` nói rõ một câu sự khác biệt: "task
  decision = dedup disposition cho một task cụ thể; plan decision = ghi lại việc đã chọn/hoãn task nào cho một goal".

**Mức cần owner quyết trước khi làm:** `PlanEntry` kind=`decision` có đáng giữ không, nếu (d) cho thấy `p2o_plan`
nói chung hiếm khi được dùng? Chưa có số đo thực tế việc này được gọi bao nhiêu lần trong các run thật. Trước khi
cân nhắc bỏ, nên đo (xem phần (d) dưới) rồi quyết — không tự ý xoá một kind khỏi `PLAN_KINDS` chỉ vì suy luận.

### (c) Dedup nhiều lớp — không cần cơ chế mới, p2o đã chặt nhất trong 3 hệ; chỉ cần một câu rõ hơn

Cả Strix (chỉ string-match) và ARTEX (gần như không dedup, tự nhận "planner stays cautious... purely via visibility")
đều yếu hơn p2o hiện tại. Không có pattern bên ngoài đáng copy; nếu có bài học thì là *cảnh báo ngược* — đừng làm
yếu đi thứ p2o đang làm tốt.

Rủi ro thật duy nhất là **tôi vừa tự thêm lớp thứ 4** (`p2o_surface`) nằm ngoài `workIdentity`/`ASSIGNMENT_CONFLICT`.
Mô tả tool đã có câu "Not the exact work identity of p2o_task match" (`extensions/p2o/index.ts:1069`) — tức rủi ro
đã được giảm một phần bằng prompt, không phải bằng code. Theo gợi ý từ nguồn ngoài (tianpan.co, "store nên là decision
đã đưa ra, không chỉ việc đã xử lý"), hướng sạch hơn về lâu dài là gộp `p2o_surface`'s key vào chính `WorkIdentity`
(`src/work.ts`) như một mức `confidence` thứ ba (`'advisory'`, dưới `'unknown'`/`'exact'`) thay vì một tool tách biệt
hoàn toàn — nhưng đây là refactor cấu trúc cho lợi ích chủ yếu là triết học/nhất quán, không sửa một bug cụ thể nào.
**Không làm ngay** theo CLAUDE.md (không refactor thứ chưa hỏng); để như ghi chú cho lần sau nếu `p2o_surface` sinh
ra nhầm lẫn thật trong thực tế dùng.

### (d) `p2o_plan` không bị enforce — mượn "thứ tự bắt buộc" của ARTEX ở mức nhẹ, không hard-block

ARTEX chặn cứng Planner engine chờ `createGoals` xong mới cho chạy (`server/goals.go:42-58`) — **không áp dụng y
nguyên** được vì ARTEX tự trị hoàn toàn, còn p2o luôn có human confirm dialog ở đầu run và nguyên tắc "chỉ con người
đổi scope/budget"; chặn cứng Planner chờ một goal do *model* tự ghi sẽ vi phạm nguyên tắc đó. Thay vào đó, mượn đúng
*tinh thần thứ tự bắt buộc*, không phải cơ chế gate cứng — khớp với benchmark cũ của p2o (`toolGuidance` ép dùng tăng
chi phí +73% không tăng chất lượng, nên p2o có lý do thực nghiệm để tránh ép buộc runtime cứng cho model).

Hai việc rẻ, không đổi default, cộng dồn (không phải chọn một):
1. Khi `--goal` được dùng: câu nhắc đã có trong `ownerInstructions()` ("Turn it into goals with acceptance criteria
   and explicit exclusions...") nên **đặt sớm hơn trong thứ tự đọc của prompt** — hiện nó nằm sau phần SCOPE nhưng
   trước phần recon; kiểm tra lại nó không bị chìm giữa các đoạn dài khác (đo bằng
   `tests/minimal/recon.test.ts` đã có, không cần test mới).
2. Thêm `PreflightCode` mới `NO_GOAL_RECORDED` vào `finish-preflight.ts` — advisory, chỉ kích hoạt khi
   `facts.statedObjective` (từ `--goal`) được dùng VÀ không có `PlanEntry` kind=`goal` nào trong ledger khi finish.
   Giống đúng pattern `NO_COVERAGE_PLAN` đã có — tái dùng cơ chế, không thêm khái niệm mới. Đây là cách "enforce nhẹ"
   khả thi nhất: không chặn Planner lúc đang chạy (giữ tự do chiến thuật), nhưng không để việc bỏ qua `--goal` đã
   khai báo trôi qua êm re lúc finish.

**Số đo còn thiếu trước khi quyết sâu hơn:** cả (b)'s câu hỏi "giữ `decision` kind không" và (d)'s câu hỏi "có cần
enforce mạnh hơn nữa không" đều nên dựa trên số lần `p2o_plan` thực sự được gọi qua các run thật — hiện chưa có số
đo này (không có log aggregation nào tổng hợp use rate của từng tool qua nhiều run). Nếu muốn đo, cách rẻ nhất là
thêm một dòng vào `docs/VERIFICATION_LOG.md` mỗi lần quan sát một run thật, không cần xây dashboard mới.

## Không làm

- Không chạy/import/đóng gói code ARTEX/Strix; chỉ tham khảo pattern đọc được.
- Không thay `CoverageBoard` bằng coverage derive-từ-note (mất rigor cho báo cáo an ninh).
- Không hard-block Planner chờ goal như ARTEX (vi phạm nguyên tắc "chỉ con người đổi scope" của p2o).
- Không tự ý xoá `PlanEntry` kind=`decision` hay đổi `PLAN_KINDS`/`WORK_DISPOSITIONS` nội bộ chỉ từ suy luận — cần số
  đo use rate trước.
- Không đổi default `toolGuidance`, loop, hay executor mode trong bất kỳ mục nào ở trên.

## Thứ tự triển khai đề xuất

1. (a) `UNPROMOTED_COVERAGE_NOTE` trong `finish-preflight.ts` — rẻ, độc lập, giá trị cao nhất (đóng silent-gap thật).
2. (d).2 `NO_GOAL_RECORDED` trong `finish-preflight.ts` — rẻ, cùng file, làm cùng lúc với (1) hợp lý.
3. (d).1 kiểm tra lại vị trí câu nhắc STATED OBJECTIVE trong `ownerInstructions()` — rẻ, chỉ đọc lại thứ tự.
4. (b) đổi label/description "decision" ở `p2o_loop`/`p2o_note` — rẻ, text-only, cần cập nhật test pin liên quan.
5. Đo use rate `p2o_plan` qua các run thật (ghi vào `docs/VERIFICATION_LOG.md`) trước khi quyết (b)'s câu hỏi giữ/bỏ
   `decision` kind, và trước khi cân nhắc (d) enforce mạnh hơn mức advisory.
6. (c): không code gì bây giờ; chỉ giữ ghi chú này làm tham khảo nếu `p2o_surface` sinh nhầm lẫn thật khi dùng.

Mỗi mục khi triển khai: chạy `impact` trước khi sửa hàm liên quan (theo AGENTS.md), thêm test, cập nhật đúng một dòng
`docs/VERIFICATION_LOG.md` thay vì mở rộng lại các doc đã được rút gọn.

## Trạng thái triển khai (2026-10-12)

1–4 **đã code + test, chưa commit.** Hai điều chỉnh thật so với thiết kế ban đầu, phát hiện khi đọc lại code trước
khi sửa (đúng tinh thần "impact trước khi edit"):

- **(a) thiết kế lại, không match theo assetRef/questionKey như đã viết ở dòng 80-82 trên.** Đọc `src/coverage-types.ts`
  cho thấy `CoverageCellEntry.assetRef.id` là `asset-<sha256(scope,kind,key)>` sống trong store SQLite riêng
  (`src/state/store.ts`, `assets` table) — hoàn toàn tách khỏi `LedgerIndex` mà `finishPreflight` đọc; `questionKey` là
  slug owner tự chọn (hạng mục câu hỏi), không phải định danh surface. Không có cách rẻ để resolve asset hash ngược
  về text surface mà không thêm một dependency mới (graph store handle) vào `PreflightContext` — vượt phạm vi "advisory
  rẻ, tái dùng pattern cũ" đã đề ra. Đã triển khai bản đơn giản hơn nhưng trung thực với dữ liệu: `UNPROMOTED_COVERAGE_NOTE`
  liệt kê mọi record `kind:'coverage'`/`kind:'surface'` khi có plan tồn tại (`plans.length>0`) nhưng plan đó chưa có một
  cell nào (`cells.length===0`) — bắt đúng triệu chứng gốc ("report thật không thấy gì") ở mức thô hơn per-entry, không
  bắt được từng entry lệch cụ thể khi plan đã có ít nhất 1 cell. Test: `tests/minimal/finish-preflight.test.ts`.
- **(d).2 cần thêm field mới.** `statedObjective` chỉ tồn tại trong state runtime của extension
  (`extensions/p2o/index.ts`, field `current.statedObjective`), không phải trong ledger — đã thêm
  `PreflightContext.statedObjective` và truyền `current.statedObjective` vào lúc gọi `finishPreflight` (dòng gọi ở
  `extensions/p2o/index.ts`, trong handler `p2o_finish`). `NO_GOAL_RECORDED` chỉ bắn khi có statedObjective (từ
  `--goal`) VÀ không có `PlanEntry` kind=`goal` nào qua `planFrontier()`.
- **(d).1 xác nhận không cần sửa:** đọc lại `ownerInstructions()` — câu STATED OBJECTIVE đang ở dòng ngay sau SCOPE/
  "never bypass scope" và trước `reconInstructions()`, tức đúng vị trí đã mô tả ở trên; không bị chìm.
- **(b) thu hẹp phạm vi so với dòng 89-97 trên:** chỉ đổi `p2o_note` description ("fact or decision" → "fact or
  rationale", đây là field **model thực sự đọc**) và `p2o_loop` label. Đọc lại
  `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:452` xác nhận `label` là
  "Human-readable label for UI" — KHÔNG gửi cho model; chỉ `description` mới là "Description for LLM". Đổi label vẫn
  làm (vô hại, đúng y yêu cầu, không ảnh hưởng test) nhưng không giải quyết nhầm lẫn của model như dòng 91 trên đã kỳ
  vọng. Không thêm câu phân biệt "task decision/plan decision" vào `p2o_task`/`p2o_plan` như dòng 96-97 đề xuất: đọc
  lại description hiện tại của `p2o_task` thấy nó đã dùng chữ "disposition" (không dùng "decision") — hai tool đã dùng
  hai từ khác nhau, nên câu phân biệt thêm vào sẽ tốn byte mà không giải quyết nhầm lẫn thật nào còn tồn tại.

Đã chạy `impact finishPreflight --direction upstream` trước khi sửa (risk LOW, 1 caller duy nhất:
`extensions/p2o/index.ts` handler `p2o_finish`). `npx tsc --noEmit` sạch; `npx vitest run tests/minimal` 567 passed/12
skipped (5 test mới, không có pin nào vỡ — budget byte trong `workflow-policy.test.ts` vẫn trong dung sai 2%).
`detect-changes --scope all` báo risk **high** (4 files/11 symbols/15 flows) — đúng với phạm vi thay đổi thật
(2 PreflightCode mới + 1 context field mới + call site), không phải dấu hiệu lỗi.

**Mục 5 và 6 vẫn chưa làm**, giữ nguyên như kế hoạch gốc (cần số đo thật trước khi quyết).
