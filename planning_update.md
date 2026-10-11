# planning_update.md — Nâng cấp workflow pentest pi-p2o: không bỏ sót bước, báo cáo chuẩn OWASP

> **Trạng thái: ĐÃ TRIỂN KHAI P0–P7 trong working tree (2026-10-11), chưa commit/push/install.** Các mục §A–§F bên dưới là phần **phân tích tại thời điểm viết** (số đo MEASURED lấy từ lệnh chỉ đọc liệt kê ở §H, trên mã trước thay đổi). Kết quả triển khai, quyết định G đã dùng và các điểm lệch so với kế hoạch nằm ở **§0** ngay dưới. Chưa chạy benchmark trả phí; không dùng provider codex proxy.
> **Bản này thay thế hoàn toàn mọi kế hoạch trước** (owner đã xóa bản cũ). Kế hoạch cũ chỉ còn trong git: `git show 41e8157:planning_update.md` (W0–W8), `git show 6cfb89d:planning_update.md` (S0–S7). Phụ lục §13 ở cuối được giữ nguyên vì `tests/minimal/acceptance-matrix.test.ts` đọc đúng hai khối của nó (xem G-1).

## 0. Trạng thái triển khai (2026-10-11, chưa commit)

**Đã làm (hermetic, không gọi model, không chạm target):** P0 tách baseline sang `docs/ACCEPTANCE_BASELINE.md` (G-1), sửa các trích dẫn treo; P1 `src/finish-preflight.ts` + `p2o.finishGate`; P2 báo cáo tự ghi lúc cleanup + `p2o.autoReport`/`reportRoot`, `/p2o report export` có đường dẫn mặc định; P3 `src/cvss.ts` + `p2o_case action=rate`; P4 báo cáo v2 (+ `narrative` của `p2o_finish`, `findings.json/csv`, `wstg-checklist.csv`, `p2o.reportFormat`, `p2o.report`); P5 `p2o.reviewIntegrity`; P6a `p2o_coverage action=suggest` và bỏ capsule trùng khỏi brief worker; P7 docs, `docs/ACCEPTANCE_MATRIX.md` mục P, `docs/VERIFICATION_LOG.md`. Tệp mới: `src/finish-preflight.ts`, `src/cvss.ts`, `docs/ACCEPTANCE_BASELINE.md`, `tests/minimal/{cvss,finish-preflight,case-rating,report-auto,review-integrity,coverage-suggest}.test.ts`, `tests/minimal/helpers/report-fixture.ts`. `npm test` (typecheck, build, check:build, vitest, Python) xanh: vitest 545 pass / 12 skip (557, trong đó 12 là test opt-in Docker/Herdr), Python 155 test. `node .gitnexus/run.cjs detect-changes --scope all --repo .` báo 26 tệp, 123 symbol, "critical" với 983 flow: số này do đồ thị chỉ index `extensions/p2o/index.ts` (không index `src/*.ts`), nên là cận trên theo mô hình đồ thị chứ không phải đo ảnh hưởng thật; caller của các hàm đổi đã xác nhận bằng grep và bằng bộ test.

**Quyết định G đã dùng (theo cột "Khuyến nghị"):** G-1 tách; G-2 bật mặc định cho durable-local, ephemeral tắt, không làm P2b; G-3 `warn`; G-4 thang p2o bắt buộc cho case accepted ở mức preflight (blocking), CVSS/CWE tùy chọn; G-5 chỉ liên kết (địa chỉ trang ghim, in dạng code); G-6 `narrative` + khung tất định; G-7 Markdown + JSON + CSV; G-8 chỉ P6a, **không P6b** nên lead/worker prompt và hash ghim không đổi; G-9 hành vi tool mô tả trong `description`; G-10 `annotate`; G-11 `p2o.report` tùy chọn; G-12 không benchmark trả phí; G-13 `p2o.reportRoot` tùy chọn.

**Điểm lệch so với kế hoạch (có chủ đích):**
1. **Rating không nằm trong `CaseDraft`** như E.2 viết, mà là note owner riêng (`data.caseRating`) gắn `caseRevision`. Lý do tìm ra khi test: nếu rating là revision mới của case thì mọi coverage cell đã pin revision cũ bị `stale` và preflight báo `STALE_CELL` ngay sau khi rate. Hệ quả tốt: bản p2o cũ đọc run mới vẫn thấy case bình thường (note lạ bị bỏ qua), nên không còn rủi ro `exact()` loại case như E.2 từng cảnh báo.
2. Chỉ `p2o_case action=rate` (không có `finding` trong `entry`), để khai báo không phình; tổng khai báo tăng 3,8% (delegated 36.268 → 37.656 B, solo 36.967 → 38.355 B), worker không đổi, các số ghim trong `workflow-policy.test.ts` và `measure-context.test.ts` được nâng có chủ đích.
3. `p2o_task review` nhận thêm `externalEvidence` (P5); `enforce` chỉ kiểm tác giả receipt, còn khoảng trống hợp đồng luôn là thông tin vì chỉ ánh xạ được evidence/gaps/candidates/coverage (assets, facts, controls, artifacts nằm ở store khác và được báo là "unchecked", không phải "thiếu").
4. Mã preflight chưa làm: `OPEN_GOAL`, `UNMAPPED_NOTE_COVERAGE`. `WSTG_APPLICABLE_UNPLANNED` chỉ xét test có trigger `any` và chỉ khi run có cell `wstg-`; trigger theo feature cần model nêu feature, dùng `suggest`.
5. Start thất bại (`reason=failed`) không ghi báo cáo. `scripts/measure-context.mjs` chưa thêm số đo capsule/báo cáo.
6. **Đo:** render báo cáo median 5 ms @10k, 31 ms @100k bản ghi synthetic; preflight 4 ms / 42 ms (xem `docs/VERIFICATION_LOG.md`). Capsule: brief worker bớt đúng một bản capsule (2,6–5,5K ký tự ước lượng ở B.1); chưa đo lại bằng worker thật.

**Chưa kiểm chứng:** hiệu quả của cổng kết thúc và báo cáo lên độ đầy đủ của benchmark pentest (cần benchmark được duyệt); hành vi trên pane Herdr thật (`test:herdr` cần đồng ý riêng); mô hình thật có gọi `rate`/`suggest` hay không khi `toolGuidance` tắt (đây là lý do cổng `warn` nối thẳng vào kết quả `p2o_finish` thay vì dựa vào lời khuyên).

---

## Tóm tắt

1. **Lõi vòng lặp chặt về an toàn và provenance nhưng không có gì ép tính đầy đủ.** `p2o_finish` chỉ từ chối khi còn intent xếp hàng hoặc worker chưa báo cáo (`extensions/p2o/index.ts:1235-1242`). Nó không kiểm tra case chờ review, claim `confirmed` chưa thành case, coverage plan, cell chưa terminal, gap mở hay mục tiêu chưa đóng.
2. **Xác nhận giả thuyết của owner.** `renderReport` chỉ có một call site: lệnh người dùng `/p2o report export` (`index.ts:1316`), sau một hộp xác nhận. `p2o_finish`, `/p2o stop`, shutdown và đổi session đều dọn dẹp rồi đóng store mà không render. Nguyên nhân gốc: quyết định thiết kế "người dùng gọi và xác nhận" (docs/USAGE.md §Báo cáo tất định) cộng với việc không có điểm gọi nào trong `cleanupOwnerPass` (§C.3).
3. **Lượt trả lời cuối của lead bị đói trạng thái đã review.** Sau `p2o_finish`, mọi tool p2o bị chặn (`index.ts:1618-1628`); thứ duy nhất lead thấy là chuỗi kết quả finish, chỉ chứa 12 dòng coverage dạng note, 8 open item và trạng thái worker, **không có case, coverage plan hay WSTG** (`index.ts:1247-1251`). Báo cáo trong chat vì vậy có thể lệch khỏi báo cáo tất định, và đó cũng là văn bản mà bộ chấm benchmark đọc (`bench/lib/score.mjs`).
4. **Báo cáo tất định hiện tại là chỉ mục tốt nhưng chưa phải báo cáo OWASP.** Thiếu so với WSTG §5: mức nghiêm trọng gán cho từng finding (chỉ in thang tiêu chí), khả năng khai thác, tác động, CVSS, CWE, khuyến nghị, bước tái hiện, executive summary, phạm vi, giới hạn, timeline. `CaseDraft` không có trường nào cho các mục đó (§E).
5. **Prompt:** trùng nguyên văn giữa prompt, mô tả tool và skill gần như bằng 0 (đã có test chặn). Trùng thật là khối recon (1.899 ký tự = 33,8% prompt lead đại diện và 32% prompt worker). Khối đó chứa 732 ký tự định tuyến của Planner nằm trong prompt mọi worker (mâu thuẫn với "TACTICAL AUTONOMY") và 596 ký tự chiến thuật của worker nằm trong prompt lead. Capsule mục tiêu (2,6–5,5K ký tự trong mẫu tổng hợp) được gửi hai lần mỗi request cho worker. **Khai báo tool (36K/21K byte) lớn gấp 6–7 lần prompt**, nên cắt prompt có ROI thấp (§B).
6. **WSTG hiện là phụ lục báo cáo, không điều khiển workflow:** `trigger`, `phase`, `owner` của 108 test không được runtime nào dùng ngoài `report-export.ts`; `p2o_coverage` là tùy chọn (§C, W-04).
7. **So với ARTEX và strix:** p2o hơn ở provenance, consent, độ an toàn của báo cáo. p2o thua ở (i) báo cáo tự động khi kết thúc, (ii) preflight kết thúc đối soát coverage (strix `finish_scan`), (iii) schema finding giàu (strix tính CVSS từ 8 chỉ số, CWE, counterevidence, update history), (iv) wrap-up khi cạn ngân sách (ARTEX), (v) nghiệm thu mục tiêu định lượng (§D).
8. **Đề xuất 8 pha P0–P7**, hầu hết ở phía host và có thể kiểm bằng test hermetic, không đụng prompt lead. Mỗi pha có công tắc setting và rollback bằng revert. Chỉ P6b (tùy chọn) sửa văn bản prompt và phải đổi hash ghim có chủ đích (§F).
9. **13 quyết định cần owner chốt** (§G), quan trọng nhất: bật báo cáo tự động mặc định hay không (G-2), cổng kết thúc `off/warn/confirm` (G-3), mô hình mức nghiêm trọng (G-4).

## Nguồn đã đọc, cách đo, giới hạn

**Nhãn bằng chứng:** `READ` đã đọc code hoặc tài liệu (có file:dòng) · `MEASURED` lệnh chỉ đọc chạy hôm nay · `INFERRED` suy ra hợp lý, chưa chạy · `UNKNOWN` không đủ bằng chứng.

**Đã đọc (pi-p2o):** `src/prompts.ts`, `roles.ts`, `tool-guidelines.ts`, `tool-policy.ts`, `engine.ts`, `tasks.ts`, `work.ts`, `phase.ts`, `evidence.ts`, `cases.ts`, `case-types.ts`, `coverage.ts`, `coverage-types.ts`, `report.ts`, `report-export.ts`, `skills.ts`, đầu `wstg-map.ts`, `extensions/p2o/index.ts` (các đoạn tool, cleanup, command, hook), `docs/USAGE.md` (mục báo cáo), `docs/ARCHITECTURE.md`, `docs/SKILL_RUNTIME.md`, `bench/lib/score.mjs` (phần đầu), `scripts/benchmark-skills.mjs` (phần đầu), các test ghim.
**Đã đọc (tham chiếu):** ARTEX `ARTEX_AGENTIC_CORE.vi.md` (§1–8), `guard/guard.go`, `report/report.go`, `report/findings.go`, `agent/finding_workflow.go`, `agent/wrapup.go`, `agent/terminalreason.go`, `agent/planner.go` (mẫu prompt), `server/orchestration.go` (seed reporter); strix `tools/finish/tool.py`, `report/writer.py`, `report/coverage.py` (đầu và hàm `_completeness`), `tools/reporting/tool.py` (hàm CVSS/CWE/trường bắt buộc), `skills/README.md`, `benchmarks/README.md`, `AGENTS.md`; WSTG `5-Reporting/01-Reporting_Structure.md`, `02-Naming_Schemes.md` và đo cấu trúc trang chương 4.
**Không làm:** không chạy ARTEX hay strix; không đọc thân kỹ thuật của skill tấn công trong `strix/skills/` (không cần để so cơ chế); không chạy target, model, Docker hay Herdr; không chạy full `npm test` (chỉ các test hermetic liên quan tới file này, ở §H).

**Giới hạn đã biết.** Snapshot ARTEX không có `.git` riêng và chính tài liệu của nó ghi upstream trả 404, nên "0.3.15" chỉ là nhãn changelog. Con số benchmark của strix (XBEN 96%, ~$337, ~19 phút/bài) là tự công bố trong README, chưa kiểm. Đo trùng lặp dùng shingle 7 từ và regex theo cụm khái niệm: đây là ước lượng có phương pháp, không phải đo ngữ nghĩa. Quy đổi token = ký tự / 4 (văn bản tiếng Anh), chỉ để so cỡ.

**Câu hỏi của owner → mục trả lời**

| Câu hỏi | Trả lời ở |
|---|---|
| A. Prompt lead/worker: trùng, mâu thuẫn, đủ context | §B |
| B. Điểm yếu gây bỏ sót khi chạy benchmark | §C.1–C.2 |
| C. Vì sao xong pentest vẫn chỉ có output chat; tự động xuất | §C.3, §E.7 |
| D. Báo cáo chuẩn OWASP | §E |
| So sánh ARTEX và strix | §D |
| Lộ trình, nghiệm thu, rollback; quyết định | §F, §G |

---

## A. Hiện trạng core loop và hai cơ chế prompt

### A.1. Bản đồ thành phần (READ)

| Thành phần | Dòng | Vai trò |
|---|---|---|
| `extensions/p2o/index.ts` | 1.798 | Vòng đời owner/worker, 24 tool, lệnh `/p2o`, mọi hook Pi |
| `src/engine.ts` | 164 | Scheduler tất định (không model): hàng intent, debounce 100 ms, wake có đánh số epoch |
| `src/tasks.ts` + `work.ts` + `phase.ts` | 260 + 119 + 19 | TaskBoard, danh tính công việc có cấu trúc, phase packet khi worker bàn giao |
| `src/evidence.ts` | 135 | Biên nhận evidence, luật đóng candidate, export JSON legacy |
| `src/cases.ts` + `case-types.ts` | 106 + 53 | Case do owner review, currentness chỉ hạ, trùng lặp theo rootCauseKey |
| `src/coverage.ts` + `coverage-types.ts` | 75 + 42 | Plan và cell: mẫu số tường minh, execution tách khỏi assessment |
| `src/report.ts`, `report-export.ts` | 119, 204 | Đóng băng/chiếu trạng thái; sinh REPORT.md, cases.csv, coverage.csv, manifest |
| `src/prompts.ts`, `roles.ts`, `tool-guidelines.ts` | 126, 118, 24 | Prompt lead/worker, vai trò và skill mặc định, guidance theo tool (mặc định tắt) |
| `src/skills.ts`, `skills/catalog.json` | 124, 309 tài liệu | Chỉ phục vụ tài liệu đăng ký theo ID; 30 skill (17 technique, 12 playbook, 1 overlay) |
| `src/wstg-map.ts` | 403 | 108 test WSTG ghim ở commit `28553f8`, mức hỗ trợ D/T/N/O, cờ B/I, trigger, owner, card |

### A.2. Sơ đồ luồng (READ)

```text
Người dùng:  /p2o --target … [--solo|--workers N] [--loop manual|event-driven] [--export] [--retention …]
   │  hộp xác nhận bắt buộc (cần ctx.hasUI; index.ts:1441, 1461)  → OwnerRun{store, broker, sandbox, engine, board, cases, coverage}
   ▼
LEAD (phiên Pi hiện tại)                       prompt: sections['p2o_assessment'] = ownerInstructions(facts)   [ghim]
   │  tin nhắn kích hoạt: "Begin the confirmed assessment now … report evidence, coverage and unresolved gaps." (index.ts:1605)
   │  mỗi request: + p2o_objective_state + p2o_knowledge_state(≤12 KiB) + p2o_planner_state (hook context, index.ts:1657-1691)
   │  p2o_task create/revise/match → TaskBoard (từ chối trùng theo fingerprint công việc)
   │  p2o_task dispatch → Engine.enqueue (≤100 intent)
   ▼
ENGINE (TypeScript, không LLM):  kick → drain: reap pane → sắp theo priority → readiness (prerequisite đã review) → capacity → spawn
   ▼
spawnWorkerLocked (index.ts:328-441): hold/pause/sandbox/depth/cap/ngân sách 90% → resolveRole (≤3 skill; trang đầu SKILL.md được nhúng vào brief)
   ▼  ticket + pane Herdr + Pi worker (--no-extensions --no-skills --no-context-files)
WORKER:  system += workerInstructions(ticket)  ·  brief = workerBrief(focus, scope, limits, context≤4000, skills, task, capsule)
   │  p2o_shell/net/http/capture · p2o_candidate (host kiểm: evidence cùng run, luật proof/closure) · p2o_note · p2o_request_subtask
   ▼  p2o_report → TaskBoard.handoff: report_part + manifest + coverage/open (legacy) + phase packet; task → reported (tasks.ts:196+)
LEAD:  p2o_task review (cần evidence ID cùng run) → p2o_case create/revise accepted → p2o_coverage cell → vòng lại
   ▼
p2o_finish: từ chối nếu còn intent xếp hàng / worker chưa báo cáo → cleanupOwnerPass
   (engine.stop → revoke → đóng pane → dừng sandbox → freezeReport → [--export: JSON ledger] → usage event → store.finalize('incomplete') → checkpoint → store.close)
   ▼
Lead viết "báo cáo cuối" trong chat; mọi tool p2o đã bị chặn.            renderReport: KHÔNG được gọi ở đây.
```

Báo cáo tất định chỉ có đường: `người dùng → /p2o open <run> (nếu run đã đóng) → /p2o report export <abs-dir> → xác nhận → renderReport → publishReportFiles` (`index.ts:1310-1324`).

### A.3. Máy trạng thái task và các cổng "reviewed" (READ)

`proposed → reserved → running → reported → reviewed → closed`, nhánh `blocked/cancelled/expired` (`src/tasks.ts:185`). Cổng `reviewed`: có prerequisite thiếu thì từ chối; worker phải `reported` trước; cần 1–10 evidence ID là bản ghi `evidence` **cùng run** (`tasks.ts:187-190`). Host **không** kiểm evidence thuộc worker/task đó, cũng không kiểm `outputContract` (§C, W-06).

### A.4. Điều kiện dừng (READ)

| Đường | Ai kích hoạt | Lượt model cuối | Báo cáo tất định |
|---|---|---|---|
| `p2o_finish` | lead | có (tool đã bị chặn) | không |
| `/p2o stop` | người dùng, `ctx.abort()` (`index.ts:1429-1436`) | không | không |
| `session_shutdown`, đổi/fork/tree session | Pi (`index.ts:1741-1757`) | không | không |
| `storage-failed` | host (`index.ts:620-627`) | không | không |
| Engine `pause` (vòng tự động cạn `maxPlannerRounds`, backlog sự kiện >256, lỗi scheduler, provider lỗi) | host | không | không; `resume` bị từ chối khi hết vòng (`engine.ts:147`) |
| `p2o_loop blocked/wait` | lead | kết thúc lượt, không kết thúc run | không |
| Crash/kill | — | không | không; store không finalize, dùng `/p2o reconcile` |

Run kết thúc bình thường vẫn ghi `assessmentOutcome='incomplete'` (`index.ts:598`): hệ thống chủ ý không bao giờ tự tuyên bố "hoàn tất". **Không có tiêu chí dừng khách quan nào** ngoài quyết định của lead hoặc người dùng; prompt ghi "No elapsed-time limit; stop or finish explicitly" (`prompts.ts:49`).

### A.5. Cơ chế prompt #1 — lead (READ + MEASURED)

Thành phần theo thứ tự: (1) một section `p2o_assessment` thay thế mỗi lượt (`index.ts:1637-1654`) = `ownerInstructions` (`prompts.ts:48-81`): vai trò, danh tính mục tiêu, scope, kỷ luật dữ liệu không tin cậy, khối recon, ủy quyền, bằng chứng và đóng candidate, dọn dẹp và báo cáo; (2) khai báo tool của lead; (3) `promptGuidelines` từng tool (**mặc định tắt**: `p2o.toolGuidance=false`, `roles.ts:38`, vì benchmark 2026-10-10 cho thấy +73% chi phí, không tăng chất lượng); (4) ba message request-local mỗi lượt: objective, knowledge packet (≤12 KiB), planner state; (5) skill đọc theo yêu cầu.

| Đại lượng (MEASURED `scripts/measure-context.mjs --source`) | Giá trị |
|---|---|
| Prompt lead solo directory / url | 4.826 / 4.977 ký tự (trần ghim <5.000) |
| Prompt lead delegated directory / url / url event-driven | 5.221 / 5.372 / 5.617 ký tự (trần 5.326 / 5.480 / 5.730) |
| Khai báo tool: delegated Planner / solo owner | 18 tool, 36.268 / 36.967 byte |
| Tool lớn nhất | `p2o_graph` 7.248, `p2o_task` 5.816, `p2o_case` 4.697, `p2o_coverage` 4.403, `p2o_plan` 2.710 byte |
| `p2o_skill_list` nếu lướt hết 4 trang | 13.254 + 11.927 + 7.865 + 5.613 = 38.659 ký tự |

### A.6. Cơ chế prompt #2 — worker (READ + MEASURED)

`workerInstructions` (`prompts.ts:83-100`) được nối vào system prompt (`index.ts:1653`), brief gửi qua Herdr (`index.ts:414`). System prompt 5.315–5.912 ký tự theo vai trò; brief tối thiểu 553–584 ký tự cộng context do lead viết (≤4.000), trang đầu của 1–3 skill (6.073–7.981 ký tự cho skill mặc định), và capsule mục tiêu. Khai báo tool của worker 20.750 byte (vai trò `reporting`: 13.974 byte). Mỗi request còn có `p2o_objective_state` và knowledge packet.

### A.7. Skills và WSTG khi chạy (READ)

`SkillLibrary` chỉ phục vụ tài liệu có trong `skills/catalog.json` theo ID, viết lại link tương đối thành `p2o-skill:<id>` nếu đích đã đăng ký (`src/skills.ts:78-108`); 309 tài liệu: 104 trang WSTG thô (`wstg-source:`), 101 tài liệu thuộc skill, 94 mục bằng chứng, 10 tài liệu chung. Vai trò chọn skill mặc định (`roles.ts:15-21`): recon → `attack-surface-mapping`, discovery → `source-code-auditing`, validation → `exploitability-assessment`, reporting → `remediation`; lead có thể chỉ định ≤3 skill/task (`roles.ts:28`). Skill sở hữu một test WSTG chỉ được dùng nếu lead tự chọn nó.

**WSTG trong runtime:** `WSTG_MAP` chỉ được `src/report-export.ts` nhập (dòng 9, 76–111). Các trường `trigger` (đặc trưng recon làm test đáng lập kế hoạch), `phase`, `owner`, `card`, `modes` không được tool hay prompt nào dùng. Khóa `wstg-*` chỉ có tác dụng khi lead tự đặt làm `questionKey` của cell.

### A.8. Ràng buộc do test ghim (READ)

| Ràng buộc | Nơi | Hệ quả cho kế hoạch |
|---|---|---|
| Prompt lead solo <5.000 ký tự, không chứa `p2o_*`; delegated có trần riêng | `recon.test.ts:29,47,86-88` | Không thể thêm chính sách vào prompt lead; còn ~105–113 ký tự dư ở bản delegated |
| SHA-256 của `workerInstructions` và `workerBrief` (url, directory) | `recon.test.ts:50-60` | Mọi sửa văn bản worker phải đổi hash có chủ đích |
| `p2o_*` không được xuất hiện ngoài loadout của vai trò | `recon.test.ts`, `workflow-policy.test.ts` | Guidance theo tool không được nhắc tool khác loadout |
| Mỗi dòng guidance ≤260 ký tự; tổng ≤1.200 (lead) / ≤800 (worker) | `workflow-policy.test.ts:76-78` | Ngân sách guidance hiện 1.003 / 921 / 314 / 217 |
| Khai báo và guidance mỗi loadout không tăng quá 2% | `workflow-policy.test.ts:105-114` | Thêm tham số tool phải nâng số ghim có chủ đích |
| §13.1 đúng 22 hàng, §13.3 đúng 7 gạch đầu dòng trong file này | `acceptance-matrix.test.ts:31-46` | Giữ nguyên phụ lục §13 (G-1) |
| Đếm D/T/N/O/B/I của bản đồ WSTG | `wstg-map.test.ts:39-42` | Không đổi mức hỗ trợ khi chưa có chủ đích |
| Bộ chấm benchmark đọc chuỗi kết quả `p2o_finish` ("Coverage:", "Open items:") | `bench/lib/score.mjs`, `benchmark.test.ts:413+` | Chỉ **nối thêm** vào chuỗi finish, không đổi thứ tự cũ |

### A.9. Ba đầu ra hiện có (READ)

| Đầu ra | Khi nào | Nội dung | Ai gọi |
|---|---|---|---|
| Báo cáo cuối trong chat | sau `p2o_finish` | văn bản tự do của lead; nguồn duy nhất là chuỗi kết quả finish và trí nhớ hội thoại | model |
| `.p2o-reports/<run>-<uuid>.json` | lúc cleanup, **chỉ khi `--export`** (`index.ts:585-591`, `evidence.ts:86-118`) | toàn bộ ledger đã redact; không phải báo cáo | host |
| `REPORT.md` + `cases.csv` + `coverage.csv` + `report-manifest.json` | **chỉ khi người dùng chạy `/p2o report export <abs-dir>`** | chỉ mục tất định, an toàn markup | người dùng |

---

## B. Phân tích trùng lặp, mâu thuẫn, mơ hồ (câu hỏi A)

### B.1. Đo trùng lặp (MEASURED, script chỉ đọc trong thư mục scratch)

| Cặp so sánh | Kết quả |
|---|---|
| Lead (delegated url event-driven, 5.617) × worker discovery (5.910) | 243 shingle 7-từ chung = 32,9% của lead, 29,6% của worker |
| Lead × worker reporting (5.355) | 243 chung = 32,9% / 32,4% |
| Prompt × mô tả+schema của 10 tool chính | 0 shingle chung, trừ `p2o_report` × prompt worker: 5 shingle (2,8% của tool) |
| Prompt × trang đầu 4 skill mặc định | 0 |
| Prompt × `shared:handoffs` (7.940) | 9 shingle (1,2%) |

Toàn bộ 243 shingle chung là **khối `reconInstructions`**: 1.899 ký tự trong lead, 1.893 trong worker, 7 dòng (80, 159, 274, 322/316, 342, 390, 326 ký tự). Chia theo người dùng thật của từng dòng:

| Dòng | Ký tự | Của ai | Trong lead delegated | Trong worker |
|---|---|---|---|---|
| Tiêu đề, "Read the ledger…", "Recon handoff…" | 80 + 159 + 326 | cả hai | cần | cần |
| "URL/Source recon: map responses…" và "inventory…" | 274 + 316 | tác nghiệp worker | **thừa 596** (lead bị cấm chạy lệnh target, `prompts.ts:67`) | cần |
| "Choose a surface… Rank next tasks…", "Unclear entry/gate → …" | 342 + 390 | định tuyến của Planner | cần | **thừa 732** (worker "does not choose new run strategy", `prompts.ts:94`) |

Vai trò `validation` và `reporting` không lập bản đồ bề mặt: toàn bộ khối 1.893 ký tự là thừa (35% prompt `reporting`).

**Trùng theo khái niệm** (regex theo cụm, ước lượng): luật đóng candidate (closure) nằm ở prompt lead 338, prompt worker 436, mô tả `p2o_candidate` 41; "gap/untested không phải clean" ở lead 618, worker 582, `p2o_report` 203, `p2o_coverage` 225, `p2o_candidate` 41; "chỉ người dùng mới mở rộng scope" ở lead 136, worker 148, `p2o_coverage` 107, `p2o_delegate` 77; "dừng retry không đổi" ở lead 411, worker 402, brief 55. Phần lặp **trong cùng một context** chỉ khoảng 380 ký tự (worker) và 500 ký tự (lead), tức ~95–125 token.

**Ước lượng ký tự và token thừa**

| Nguồn thừa | Ký tự | Token (≈/4) | Tần suất | Mức |
|---|---|---|---|---|
| Tác nghiệp worker trong prompt lead delegated | 596 | ~150 | mỗi request của lead | thấp |
| Định tuyến Planner trong prompt mọi worker | 732 | ~183 | mỗi request của worker | thấp–vừa |
| Toàn bộ khối recon trong worker `validation`/`reporting` | 1.893 | ~473 | mỗi request của worker hai vai trò đó | vừa |
| Capsule mục tiêu gửi hai lần (brief + `p2o_objective_state`) | 2.555–5.510 (mẫu tổng hợp 0,5×–2×) | ~640–1.380 | **mỗi request của worker** (`index.ts:414` và `1679-1690`) | **cao nhất trong nhóm prompt** |
| Lặp khái niệm trong một context | ~380–500 | ~95–125 | mỗi request | rất thấp |
| *So sánh:* khai báo tool | 36.268 / 20.750 byte | ~9K / ~5K | mỗi request | gấp 6–7 lần prompt |

Kết luận đo được: tối ưu lớn nhất không nằm ở chính sách trong prompt mà ở (1) capsule trùng, (2) schema tham số của `p2o_graph`, `p2o_task`, `p2o_case`, `p2o_coverage`, (3) khối recon sai người nhận. Cắt chữ trong prompt lead sẽ rất tốn công (bị ghim) để lấy vài chục token.

### B.2. Mâu thuẫn và mơ hồ

| ID | Phát hiện | Bằng chứng | Hệ quả | Hướng sửa (ràng buộc) |
|---|---|---|---|---|
| B-1 | Worker vừa được dặn "Rank next tasks, record the choice in a decision note" vừa "You do not choose new run strategy or accept/spawn subtasks" | `prompts.ts:29-31` vs `94` | Worker `validation`/`reporting` có thể tự mở hướng mới thay vì dừng ở intent | Tách khối recon (P6b); đổi hash ghim có chủ đích |
| B-2 | Prompt lead delegated chứa hướng dẫn tự chạy recon ("map responses, headers, links/forms") dù lead bị cấm chạy lệnh | `prompts.ts:26-28` vs `67`; `index.ts:461` | Nhiễu; lead có thể cố "tự thăm dò" rồi bị `PLANNER_ONLY` | Như B-1 |
| B-3 | Hai từ vựng coverage không cầu nối: worker được dặn `p2o_note kind=coverage` (legacy), lead được dặn "Record coverage" nhưng công cụ thật là `p2o_coverage` cell; prompt worker còn ghi note legacy "không phải bảo đảm an toàn" | `prompts.ts:9,96,78` | Coverage của worker không thành mẫu số; finish hiển thị đúng thứ legacy (`index.ts:1247`) | P1 (hiển thị cả hai), P6 (gợi ý cell từ note) |
| B-4 | Không có tiêu chí dừng nhưng cũng không gọi tên cách kết thúc: "stop or finish explicitly", "complete verified cleanup before the final report"; chỉ tin nhắn kích hoạt nói "report evidence, coverage and unresolved gaps" | `prompts.ts:49,79`; `index.ts:1605` | Lead có thể kết thúc bằng văn xuôi mà không gọi `p2o_finish`; run vẫn `active`, sandbox còn sống tới khi người dùng `/p2o stop` (INFERRED: không có đường code tự kết thúc) | P1 (mô tả `p2o_finish`), P2 (báo cáo cả khi dừng tay) |
| B-5 | "Independent verification requires a separate worker" nhưng chấp nhận case không đòi `independentCurrent`; chế độ solo không thể có | `prompts.ts:77` vs `cases.ts:86-91` | "Đã xác minh độc lập" phụ thuộc kỷ luật của lead | P5 (luật theo mức nghiêm trọng, có waiver) |
| B-6 | Prompt bảo "Report findings with reproduction and evidence…" nhưng khi viết báo cáo cuối lead không còn tool và chuỗi finish thiếu case/coverage plan | `prompts.ts:79` vs `index.ts:1618-1628,1251` | Báo cáo chat dựa trí nhớ hội thoại (có thể bị compaction) | P1 |
| B-7 | `outputContract` có tên "contract" nhưng chỉ mô tả; phase packet đặt tên `unreviewedRequired` như danh sách việc nhưng không ai tính phần thiếu | `phase.ts:17-18`; không có chỗ nào so sánh | Worker giao thiếu mà vẫn review được | P5 |
| B-8 | Hướng dẫn nhúng `KNOWLEDGE` nói "Main documents are inlined" nhưng trang đầu skill bị cắt ở giới hạn trang; chỉ có dòng "Continued: p2o_skill_read id=… offset=…" | `prompts.ts:5`; `index.ts:359-360` | Worker có thể bỏ phần sau (ví dụ "Validation", "Handoffs") | Đã có chỉ dẫn; chỉ cần đo độ dài trang đầu của các playbook WSTG trước khi P6 |

### B.3. Worker có nhận đủ context không?

| Cần | Có không | Ghi chú |
|---|---|---|
| Scope, giới hạn lệnh, hạn chế quyền | Có | brief + system |
| Mục tiêu, kỳ vọng đúng/sai, điều kiện dừng, prerequisite, output contract | Có | capsule JSON (`tasks.ts:257-260`) |
| Danh sách bằng chứng đã biết | Chỉ ID | phải gọi `p2o_ledger`/`p2o_state` để lấy nội dung |
| Inventory bề mặt đã lập | Không tự động | chỉ qua `context` ≤4.000 do lead viết hoặc truy vấn `p2o_graph` |
| Danh tính/credential do operator cấp | **UNKNOWN** | prompt nói "Credentials must be operator-supplied" nhưng không thấy kênh chuyển chúng vào brief; cần đọc `http-session.ts` trước P6 |
| Ngân sách còn lại | Một phần | thấy `commandBudget` cố định, không thấy đã dùng bao nhiêu (INFERRED) |
| Test WSTG tương ứng với intent | Chỉ khi lead đặt `work.questionKey` | không được gợi ý tự động (W-04) |
| Chính sách xử lý kết quả dở (exhausted/blocked) của các worker trước | Không | ARTEX có, p2o chỉ có enum `outcome` |

Kết luận: đủ cho một intent chiến thuật đơn lẻ; **không đủ** cho (i) danh tính, (ii) học chéo giữa bề mặt, (iii) nhận biết ngân sách.

---

## C. Điểm yếu gây bỏ sót (câu hỏi B) và vì sao không có báo cáo sau pentest (câu hỏi C)

### C.1. Bảng xếp hạng

| ID | Mức | Điểm yếu | Pha |
|---|---|---|---|
| W-01 | Nghiêm trọng | `p2o_finish` không có cổng hoàn tất | P1 |
| W-02 | Nghiêm trọng | Lượt báo cáo cuối không thấy case, coverage plan, WSTG | P1 |
| W-03 | Cao | Báo cáo tất định không tự sinh; đường dừng không để lại báo cáo | P2 |
| W-04 | Cao | Mẫu số coverage tùy chọn, không được gieo; WSTG không điều khiển workflow | P6 |
| W-05 | Cao | Chấp nhận finding dựa trên một actor và evidence không kiểm liên quan | P3, P5 |
| W-06 | Cao | Review task chỉ cần evidence cùng run; output contract không thực thi | P5 |
| W-07 | Vừa | Hai từ vựng coverage không có cầu nối | P6 |
| W-08 | Vừa | `ephemeral` không `--export` mất sạch; crash không có báo cáo | P2 |
| W-09 | Vừa | Mục tiêu (`p2o_plan`) không liên quan tới kết thúc | P1 |
| W-10 | Vừa | Kết quả worker dở (`partial-budget`, `prerequisite-blocked`, `provider-error`) không có chính sách; vòng tự động cạn không có wrap-up | P1, P2 |
| W-11 | Vừa | Prompt mâu thuẫn và capsule trùng | P6 |
| W-12 | Thấp | `report export` thoát im lặng khi `ctx.hasUI` false | P2 |
| W-13 | Thấp | Tham chiếu treo tới kế hoạch cũ (README, docs, bench) | P0 |
| W-14 | Thấp | Chi phí khám phá skill (38,7K ký tự) và không gắn test WSTG với skill sở hữu | P6 |

### C.2. Chi tiết từng điểm (kịch bản, bằng chứng, đề xuất)

**W-01 — Không có cổng hoàn tất.** *Kịch bản:* lead dispatch ba task, hai worker báo cáo `confirmed`, lead không tạo case, không mở coverage plan, gọi `p2o_finish`. *Kết quả hiện tại:* thành công, dọn dẹp, lead viết báo cáo; ledger có hai claim `confirmed` chưa review, không có denominator. *Bằng chứng:* chỉ hai từ chối `INTENTS_QUEUED` (`index.ts:1235`) và `WORKERS_ACTIVE` (`1237-1242`); không đọc `caseViews`, `coverageViews`, `taskFrontier`. *Đề xuất:* P1, một hàm thuần `finishPreflight` trả danh sách mã có kiểu (xem §F P1), cổng mềm `off/warn/confirm`. *Tái hiện hermetic:* `createFakePi` + `InertSandbox` + ledger có candidate `confirmed` không case, gọi `p2o_finish`, mong đợi `FINISH_PREFLIGHT` ở chế độ `confirm`.

**W-02 — Lượt cuối đói trạng thái.** *Bằng chứng:* chuỗi kết quả (`index.ts:1251`) dựng từ `workerView` (`492-519`), trong đó `coverage` = `summary.coverage.slice(-12)` (note legacy) và `open` = 8 mục cuối; `details.report` (có đếm case/coverage) nằm ở `details`, không ở `content` (INFERRED: `details` dành cho UI và log, chỉ `content` tới model; chưa xác minh bằng request thật); sau finish `phase='finished'` nên `tool_call` chặn mọi tool p2o (`index.ts:1618-1628`). *Hệ quả:* "báo cáo cuối" đọc từ trí nhớ; sau compaction các case đã review có thể mất. *Đề xuất:* P1 nối thêm vào `content` một khối đếm tất định (case accepted/pending/stale, cell theo execution và assessment, mức WSTG L0–L3, gap mở chưa có cell, đường dẫn báo cáo) — **nối thêm**, không đổi dòng cũ (bộ chấm benchmark đọc chúng).

**W-03 — Báo cáo không tự sinh.** Xem §C.3.

**W-04 — Mẫu số tùy chọn và không gieo.** *Kịch bản:* run trên ứng dụng có login, JWT, upload; lead chỉ kiểm vài thứ; báo cáo ghi "No coverage plan was recorded" (`report-export.ts:138`) nhưng run vẫn kết thúc. *Bằng chứng:* `WSTG_MAP.trigger/owner/card` không được runtime dùng (§A.7); prompt lead không nhắc coverage plan; guidance `p2o_coverage` mặc định tắt. *Đề xuất:* P6, hành động chỉ đọc `p2o_coverage action=suggest` (liệt kê test WSTG khớp đặc trưng recon, chưa có cell, kèm skill sở hữu/card) và P1 liệt kê "test áp dụng mà chưa có cell" ở mức advisory. Gieo qua kết quả tool và cổng, **không qua prompt**.

**W-05 — Finding dựa trên một actor.** *Bằng chứng:* `candidate()` chỉ kiểm evidence ID tồn tại trong run (`evidence.ts:57-59`) và không kiểm tác giả hay nội dung; `confirmed` hợp lệ khi `execution='tested'`, `policyBasis!='inferred'` (`cases.ts:47`); chấp nhận case chỉ đòi `currentness='current'` (`cases.ts:86-91`); `independentEvidenceRefs` có thể rỗng. Báo cáo có in "independent validation current: yes/no" (`report-export.ts:50`) nên **trung thực nhưng không ép**. Mục "Accepted current cases" không in proof level (`static_trace/offline/live`) và không có mức nghiêm trọng. *Đề xuất:* P3 thêm `finding.rating` cho case; P5 luật: mức High/Critical cần `independentCurrent` hoặc `independenceWaiver` ghi lý do (solo mặc định có waiver "single-actor"); báo cáo in proof level và tác giả evidence (self/other).

**W-06 — Review task và output contract.** *Bằng chứng:* `tasks.ts:190` chỉ kiểm `kind==='evidence'` và `runId`; `phase.ts:17-18` chỉ đếm; `grep` xác nhận không còn nơi nào dùng `outputContract.required/partialAllowed` ngoài validate và hiển thị. *Đề xuất:* P5 tính `contractGap` (trường `required` mà báo cáo không giao) và lưu vào bản ghi review; chế độ mềm (chú thích + preflight BLOCKING khi `partialAllowed=false`), chế độ cứng sau (G-10). Liên kết evidence với worker được giao (hoặc owner khi solo) trừ khi khai `externalEvidence` kèm lý do.

**W-07 — Hai từ vựng coverage.** Worker ghi `coverage[]` kiểu `{surface, risk, outcome}` (legacy) vào ledger lúc bàn giao (`tasks.ts:196-205`); lead phải tự chuyển thành cell. *Đề xuất:* P6 đưa vào preflight số note coverage chưa được cell nào tham chiếu (advisory) và cho `suggest` gợi ý cell từ note.

**W-08 — Đường ngắt và `ephemeral`.** Xem bảng §A.4 và §C.3. *Đề xuất:* P2.

**W-09 — Mục tiêu không nối với kết thúc.** `p2o_plan` có goal với tiêu chí chấp nhận nhưng được mô tả là "owner coordination, not automatic proof or assessment completion" (`index.ts:827`); finish không đọc goal. ARTEX buộc đóng mục tiêu bằng `prove_goal` (doc §7.4); strix có checklist coverage reconciliation. *Đề xuất:* P1 mã `OPEN_GOAL` (advisory, nâng lên blocking theo setting).

**W-10 — Kết quả dở.** `p2o_report.outcome` có `partial-budget`, `prerequisite-blocked`, `provider-error`, `cancelled`, `expired`; phase packet đặt `delivery='blocked'` (`phase.ts:15-16`) nhưng prompt lead không có chính sách (ARTEX phân biệt exhausted/blocked và chọn "tiếp tục" hay "đổi cách" dựa trên trace, `planner.go:298+`). Khi `maxPlannerRounds` cạn Engine chỉ `pause` (`engine.ts:109`) rồi `resume` bị từ chối (`147`) nên chỉ còn `/p2o stop`. *Đề xuất:* P1 liệt task `blocked/cancelled/expired` không có task thay thế phủ cùng bề mặt (`ORPHAN_TASK`); P2 bảo đảm `/p2o stop` để lại báo cáo; lời khuyên chính sách cho lead đặt vào `promptGuidelines` của `p2o_task` (mặc định tắt, ghi rõ).

**W-11, W-14** xem §B, §A.7. **W-12:** `if (!ctx.hasUI || !await ctx.ui.confirm(…)) return;` (`index.ts:1313`) thoát im lặng; chỉ xảy ra ngoài giao diện, nhưng nên báo lý do. **W-13:** 30 dòng trong 19 file (README, docs, `bench/README.md`, `scripts/benchmark-skills.mjs`, `src/`, `tests/`; MEASURED bằng grep) còn nhắc `planning_update.md`, trong đó nhiều chỗ trỏ tới mục (§0.1, §0.2, §13.x, §14, "Phase 5") không còn trong bản này.

### C.3. Vì sao pentest xong vẫn chỉ có output chat (câu hỏi C): XÁC NHẬN

**Giả thuyết của owner đúng**, với một chỉnh sửa nhỏ: `renderReport` có một call site (`index.ts:1316`) và còn dùng được cho run lịch sử đã `open`, nhưng vẫn hoàn toàn do người dùng gọi.

| # | Nguyên nhân gốc | Bằng chứng | Loại |
|---|---|---|---|
| R1 | Quyết định thiết kế W5: "Người dùng gọi, xác nhận… không gọi model"; lệnh `report` chỉ là chỉ mục | `docs/USAGE.md` mục Báo cáo tất định; `README.md:78` | chủ ý |
| R2 | `cleanupOwnerPass` đóng store ở `index.ts:606` và không có lệnh gọi `renderReport`; `renderReport` cần store mở (`assetRevision`, `graphScope`) | `index.ts:558-611` | thiếu điểm gọi |
| R3 | `p2o_finish` trả hướng dẫn "Write the final report now" cho model thay vì đường dẫn báo cáo | `index.ts:1251` | thiết kế |
| R4 | Lấy lại báo cáo sau run đóng cần hai lệnh (`/p2o open`, `/p2o report export <đường dẫn tuyệt đối>`) và một hộp xác nhận | `index.ts:1295-1323` | UX |
| R5 | `--export` tạo JSON ledger, không phải báo cáo; mặc định tắt và dễ bị hiểu nhầm | `index.ts:585-591`, `README.md:125` | tài liệu |
| R6 | `retention=ephemeral` không `--export`: kho tri thức bị xóa, không còn gì để render | `index.ts:1461` (chuỗi xác nhận) | mất dữ liệu |
| R7 | Đường ngắt (`stop`, shutdown, đổi session, lỗi lưu trữ, crash) không có lượt model cuối và không render | §A.4 | thiếu điểm gọi |

**Đề xuất:** thêm một điểm gọi duy nhất trong `cleanupOwnerPass` (§E.7, P2), sau khi tài nguyên target đã đóng và `freezeReport` xong, trước `store.finalize`; đồng ý (consent) lấy ở hộp xác nhận bắt đầu run chứ không phải cuối run, giống cách `--export` đang làm.

---

## D. So sánh với ARTEX và strix

### D.1. Phương pháp và giới hạn

So từng cơ chế bằng code và tài liệu đã đọc (xem phần "Nguồn"). Không chạy hai dự án. Nhãn: **Thua / Ngang / Hơn** là so với pi-p2o hiện tại.

### D.2. Bảng so sánh

| Cơ chế | pi-p2o | ARTEX | strix | Đánh giá | Đáng học |
|---|---|---|---|---|---|
| Mô hình điều phối | Lead Planner + Engine tất định + worker mới mỗi intent; hàng ≤100 intent | Planner LLM + N worker goroutine; claim nguyên tử; debounce 800 ms | Agent graph, root + subagent, coordinator | Ngang | — |
| Tránh việc trùng | Fingerprint công việc có cấu trúc, host từ chối trùng đang chạy | Chủ yếu prompt + context (doc §4.6) | LLM judge `dedupe.py` cho báo cáo | **Hơn** | Giữ; không nhập LLM judge |
| Điều kiện dừng | Không khách quan; lead hoặc người dùng | Mục tiêu + `prove_goal`; heartbeat; timeout + vòng planner cuối | `finish_scan` có checklist | **Thua** | Preflight kết thúc (P1) |
| Cổng trước khi kết thúc | Chỉ queue + worker chưa báo cáo | Ép kiểm định lượng trong prompt (planner.go:298+) | Từ chối khi còn agent; trả coverage, gap, rủi ro chưa kiểm ngay trong kết quả (`finish/tool.py:86-135`) | **Thua** | P1 |
| Vòng đời finding | claim → review → case có currentness, trùng theo rootCauseKey, hạ khi cũ | finding `confirmed` ngay khi ghi; doc §5.1 thừa nhận | `create_vulnerability_report` bắt buộc counterevidence, rationale, PoC | Hơn (độ chặt) / Thua (độ giàu trường) | P3 |
| Toàn vẹn bằng chứng | ID cùng run do host cấp, hash, redact, proof level | `evidence/store.go`: blob băm SHA-256, phiên bản bằng chứng, cờ báo cáo cũ (`report/findings.go:178-200`) | `http_exchange_ids` được xác thực | Ngang–Hơn | Cờ "báo cáo cũ hơn bằng chứng" (P4) |
| Guard / chính sách tác dụng phụ | Broker, ticket, scope, hold/release, cổng sandbox | Hook PreToolUse: audit, luật chặn, quyết định `ask`, phân loại lỗi (`guard/guard.go`) | Sandbox Docker | Ngang (khác hướng) | Khung thông báo "chặn do nền tảng, không phải phòng thủ target" (`guard.go:138-141`) |
| Cạn ngân sách/ngắt | Worker: `agent_before_settle` ghi báo cáo chặn; lead: không | Wrap-up theo lý do (hết lượt / hết giờ) với bộ công cụ bị khóa và 10 lượt riêng (`wrapup.go`) | Trạng thái `complete: false` ghi caveat (`report/coverage.py:314`) | **Thua** | P2 (render khi ngắt) |
| Phân loại điểm kết thúc | enum `outcome` | `reasonHint` chi tiết và công cụ đang chạy dở (`terminalreason.go`) | thoát mã 0/1/2 | Ngang | Hiển thị tool đang chạy dở trong báo cáo ngắt |
| Nạp skill | ≤3/task, trang đầu nhúng vào brief, đọc theo ID | tool/skill theo vai trò từ DB | ≤5 skill nhúng vào system prompt | Ngang | — |
| Coverage | Plan/cell tường minh, execution tách assessment, cũ thì hạ | `coverage.pct` thô: asset có fact neo (doc §4.6) | `coverage.json` tách `agent_reported` và `machine_observed`, báo "gap" khi agent mang skill mà không ghi (`report/coverage.py`) | Hơn (mô hình) / Thua (đối soát tự động) | Gap từ skill/WSTG được giao mà chưa có cell (P1, P6) |
| Kích hoạt báo cáo | Chỉ lệnh người dùng | Trigger tool-call: `report_finding` → agent `reporter` chạy song song (`orchestration.go:755-780`) | `finish_scan` luôn ghi `.md`, `.csv`, `.json`, SARIF, `run.json` | **Thua** | P2 |
| Nội dung finding | tiêu đề, verdict, policy, tài sản, claims, giới hạn | tóm tắt, bằng chứng, báo cáo chi tiết, liên kết lưu lượng | ID, mức, CVSS (tính từ 8 chỉ số), CWE/CVE, confidence+lý do, counterevidence, PoC, remediation, update history (`report/writer.py:223-361`) | **Thua** | P3–P4 |
| An toàn đầu ra | Vô hiệu hóa markup, công thức CSV, bidi, ANSI | Không rõ | `csv_safe`, `safe_fence` | **Hơn** | Dùng fence động cho khối tái hiện (P4) |
| Retest | disposition `retest`, `remediation.status` | agent retester riêng với 3 kết luận (`retester.go`) | `fix_verification` | Ngang | — |
| Benchmark | harness cô lập, mù đáp án; kết quả cũ bị nhiễm (bench/README) | không rõ | XBEN 104 bài, tự công bố | Không so được | Không kết luận hiệu quả |

### D.3. Nhận / sửa / loại

| Mục | Quyết định | Lý do |
|---|---|---|
| Preflight kết thúc đối soát coverage và gap (strix) | **Nhận (P1)** | Cheap, tất định, không prompt |
| Báo cáo tự ghi khi kết thúc (strix) và khi có finding (ARTEX reporter) | **Sửa (P2)**: chỉ khi cleanup, không gọi model | Giữ tính tất định; ARTEX dùng LLM, p2o không |
| CVSS tính từ 8 chỉ số, CWE hợp lệ hóa (strix) | **Nhận (P3)**, tự cài hàm thuần, không thêm dependency | Giữ ít dependency |
| Counterevidence, confidence rationale bắt buộc (strix) | Đã có một phần trong luật closure; **bổ sung** `finding.basis` | Tránh trường trùng |
| Bảng `agent_reported` vs `machine_observed` (strix coverage) | **Nhận (P4)** cho phần "Phạm vi và giới hạn" | Đúng tinh thần p2o |
| Wrap-up khi cạn (ARTEX) | **Sửa (P2)**: thay bằng render báo cáo khi dừng | Lead không có vòng model sau khi dừng |
| Quy tắc "sàn cứng" phải sinh intent khi frontier rỗng (ARTEX) | **Loại** | Mâu thuẫn nguyên tắc p2o "không bịa việc"; xem prompts.ts:70 |
| Auto-ghi `confirmed` (ARTEX) | **Loại** | Trái mô hình case |
| LLM judge dedupe (strix) | **Loại** | p2o đã có fingerprint và rootCauseKey |
| Trường PoC script tự do (strix) | **Loại** | Rủi ro an toàn; thay bằng tham chiếu evidence ID đã redact |
| Khung "chặn do nền tảng" (ARTEX) | **Cân nhắc** sau P2 | Chỉ khi lead thường cố vượt lỗi chặn; chưa có bằng chứng |
| Tự gom SARIF (strix) | **Hoãn** (G-7) | Hợp với target mã nguồn, không phải web black-box |

---

## E. Thiết kế báo cáo chuẩn OWASP (câu hỏi D)

### E.1. Đối chiếu WSTG §5 với đầu ra hiện tại

Nguồn chuẩn: `my_references/wstg/5-Reporting/01-Reporting_Structure.md` (WSTG nói rõ đây là gợi ý, không phải quy tắc cứng).

| Mục WSTG §5 | Hiện có | Thiếu | Nguồn dữ liệu đề xuất |
|---|---|---|---|
| 1.1 Version control | `report-manifest.json` (format, runtime digest, `asOfSequence`) | Bảng phiên bản/ngày/tác giả | manifest + `p2o.report.author` (G-11); ngày = bản ghi cuối của ledger (tất định) |
| 1.2 Mục lục | Không | Mục lục | sinh từ tiêu đề |
| 1.3 Nhóm thực hiện | Không | Thành viên, chuyên môn | **không có dữ liệu**: cấu hình tùy chọn hoặc ghi "do người vận hành cung cấp" |
| 1.4 Phạm vi | "Target" một dòng, exclusions và unknownScope của plan | Phạm vi theo origin/đường dẫn, thứ nằm ngoài | `manifest.targetDisplay`, `CoveragePlan.exclusions/unknownScope`, loại target |
| 1.5 Giới hạn | Mục "Limits" chung chung, gap, cell chưa kiểm | Giới hạn của công cụ (không có trình duyệt, OAST), test WSTG cờ B/I/N/O, lý do run kết thúc, worker lỗi, ngân sách | `WSTG_MAP` cờ, `usage`, outcome worker, `endReason`, lifecycle `hold` |
| 1.6 Timeline | Không | Thời lượng | bản ghi đầu và cuối, sự kiện finalize |
| 1.7 Disclaimer | Dòng "not a verification" | Tuyên bố "point in time" | văn bản cố định của p2o (tự viết, không chép WSTG) |
| 2 Executive summary | Bảng đếm | Mục tiêu, phát hiện chính theo bối cảnh kinh doanh, khuyến nghị chiến lược | khung tất định (đếm, top theo mức) + đoạn văn **lead viết, gắn nhãn chưa kiểm chứng** (G-6) |
| 3.1 Findings summary | Bảng "Other cases", không có cho accepted | Bảng Ref/Title/Risk | `cases` accepted-current + `finding.severity` |
| 3.2 Chi tiết: Ref ID | `case id` | — | giữ |
| — Title | có | — | — |
| — Likelihood/exploitability | không | các yếu tố (độ dễ, mã khai thác, quyền truy cập, động cơ) | `finding.likelihood` (văn bản có cấu trúc) |
| — Impact | không | tác động hệ thống | `finding.impact` |
| — Risk (Info/Low/Medium/High/Critical; CVSS tùy chọn) | chỉ in thang `RISK_LEVELS` (`report-export.ts:65-71`), không gán cho case | mức cho từng case, CVSS, CWE | `finding.severity`, `finding.cvss`, `finding.cwe` (E.2) |
| — Mô tả, cách khai thác, tác hại (dữ liệu nhạy cảm che) | tiêu đề, policy, lý do review, giới hạn | mô tả; tái hiện | case + biên nhận evidence đã redact (lệnh/yêu cầu `data.input`) trong khối fence an toàn |
| — Remediation | `remediation.status/reason` (trạng thái, không phải khuyến nghị) | các bước, cải tiến, thiếu thực hành | `finding.remediation.steps` + liên kết trang WSTG của test (G-5) |
| — Tài nguyên bổ sung | không | CVE, hướng dẫn ngoài | `finding.references` (danh sách cho phép) |
| Human factors | không | quy trình phục hồi, 2FA… | **ngoài phạm vi tự động**; mục tùy chọn do lead/reporting worker nêu trong case, có nhãn |
| Reproducible test artifacts | ID evidence/artifact | lệnh/yêu cầu tái hiện | `evidence.data.input` đã redact, bound; không xuất HAR/script (không có transport trình duyệt) |
| Phụ lục: phương pháp | không | phương pháp | văn bản tất định (quy trình p2o, WSTG commit ghim) |
| Phụ lục: thang rủi ro | có (khi có accepted) | giải thích CVSS | giữ + chú thích |
| Phụ lục: output công cụ | không | đầu ra đã làm sạch | chỉ biên nhận được case dẫn, giới hạn kích thước |
| Phụ lục: checklist test | `wstgAppendix` (L0–L3 trên 108 test) | liên kết trang WSTG, nhóm | giữ + liên kết pinned |
| Naming schemes (CPE/SWID/PURL) | không | định danh phần mềm | **hoãn**: p2o không có inventory phần mềm có cấu trúc |

**Đã chắc:** WSTG chương 4 (đo hôm nay trên `my_references/wstg`): 129 trang `.md` (không tính README và `00-*`); 61 trang có mục `## Remediation`, 101 có `## References`, 16 nhắc CWE (24 mã duy nhất), **0 nhắc CVSS**. Hệ quả: khuyến nghị theo WSTG chỉ có sẵn cho khoảng một nửa số trang; CWE rải rác; CVSS không có nguồn trong WSTG nên phải do `finding.cvss` cung cấp có kiểm tra.

### E.2. Mô hình dữ liệu đề xuất (phụ thuộc G-4)

Thêm trường **tùy chọn** `finding` vào `CaseDraft` (`src/case-types.ts`), do owner ghi sau khi worker `reporting` soạn (kỹ năng `remediation` đã có thang rủi ro, `skills/remediation/references/risk-rating-criteria.md`):

| Trường | Kiểm tra | Ghi chú |
|---|---|---|
| `severity` | enum `critical/high/medium/low/informational` | bắt buộc nếu case sẽ `accepted` ở chế độ chuẩn (preflight BLOCKING khi thiếu) |
| `basis` | văn bản ≤1.000 | yếu tố khả năng/tác động từng dẫn tới mức, trích đúng evidence case đã dẫn |
| `likelihood`, `impact` | văn bản ≤800 mỗi trường | khớp mục WSTG 3.2 |
| `cvss` | `{vector}` CVSS:3.1 hợp lệ; host **tính điểm** | hàm thuần trong `src/cvss.ts`; test bằng vector tham chiếu của FIRST (xác minh lại với đặc tả khi cài) |
| `cwe[]` | `^CWE-[1-9][0-9]{0,4}$`, ≤5 | không tra cứu trực tuyến; báo cáo ghi "do người báo gán, chưa kiểm với MITRE" |
| `remediation.steps` | ≤2.000 | khác `remediation.status` hiện có |
| `references[]` | ≤5; chỉ khóa WSTG hoặc URL https của miền cho phép; in dạng code, không thành link | tránh link lừa đảo |
| `reproduction.evidenceRefs[]` | ≤5 ID evidence cùng run | báo cáo lấy `input` đã redact |
| `independenceWaiver` | văn bản ≤300 | P5; bắt buộc ghi lý do nếu High/Critical không có validator độc lập |

Luật nhất quán lấy từ thang đã phát hành: policy `inferred` không được cao hơn Medium (nêu trong tài liệu rubric); `severity` không thay đổi `verdict`/`reviewStatus`; CVSS và thang p2o có thể khác nhau, báo cáo in cả hai và giải thích (WSTG: CVSS tùy chọn).

**Tương thích:** `validateStoredCase` dùng `exact()` (từ chối khóa lạ), nên bản p2o cũ đọc run mới sẽ loại case có `finding` (ghi chú không được "promote"). Run cũ vẫn đọc bình thường vì trường tùy chọn. Cần ghi vào docs và tăng `POLICY_VERSION` khi phát hành P3.

### E.3. Cấu trúc báo cáo v2 (Markdown chính; định dạng khác ở G-7)

```text
REPORT.md
  0. Đọc trước (giữ tuyên bố "chỉ mục tất định")      [banner KẾT THÚC: finished / INTERRUPTED(stop|shutdown|storage-failed)]
  1. Giới thiệu: 1.1 Phiên bản · 1.2 Mục lục · 1.3 Nhóm · 1.4 Phạm vi · 1.5 Giới hạn · 1.6 Timeline · 1.7 Miễn trừ
  2. Tóm tắt điều hành: khung tất định (đếm theo mức, bao phủ, phạm vi, nhận định) + đoạn lead (nhãn "chưa kiểm chứng")
  3. Bao phủ và khoảng trống (đứng TRƯỚC finding, giữ nguyên nguyên tắc hiện tại): plan/cell, gap, WSTG L0–L3, chưa kiểm
  4. Phát hiện: 4.1 Bảng tóm tắt (Ref, Title, Severity, CVSS, CWE, WSTG, trạng thái review) · 4.2 Chi tiết từng case
       Mỗi case: Ref · Title · Severity + basis · Likelihood · Impact · Mô tả · Tái hiện (evidence đã redact, fence an toàn) ·
       Khuyến nghị · Tham chiếu · Proof level · Độc lập · Mâu thuẫn · Giới hạn · Lịch sử revision
  5. Case khác (pending/disputed/stale/duplicate/withdrawn) và lý do
  6. Claims của worker (chưa phải finding)
  7. Phụ lục: A phương pháp · B thang rủi ro và CVSS · C biên nhận trích dẫn · D checklist WSTG (liên kết ghim) · E nhiệm vụ và bàn giao
findings.json   toàn bộ trường có kiểu (schema versioned)        findings.csv   tóm tắt, công thức CSV vô hiệu hóa
cases.csv  coverage.csv  wstg-checklist.csv  report-manifest.json (hash từng file, format 2, endReason, complete)
```

Giữ các thuộc tính hiện có: không giờ hệ thống, không random, cùng sequence cho cùng byte (`report-export.ts:12`), mọi chuỗi từ target/model đi qua `mdText`/`csvCell`; khối tái hiện dùng hàm fence động (độ dài rào lớn hơn dãy backtick dài nhất bên trong; tham khảo `safe_fence` của strix) và loại ký tự điều khiển.

### E.4. CVSS và CWE

`src/cvss.ts` (≈40 dòng, không dependency): parse vector `CVSS:3.1/AV:·/AC:·/PR:·/UI:·/S:·/C:·/I:·/A:·`, tính điểm cơ sở và làm tròn lên một chữ số theo đặc tả. Test bắt buộc: vector tham chiếu (ví dụ `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` kỳ vọng 9,8; các vector 7,5; 5,3; 6,5; 6,1 phổ biến; **xác minh lại từng giá trị với đặc tả CVSS v3.1 khi cài, không tin trí nhớ**), vector sai, trường thiếu, scope changed, làm tròn biên. Strix làm tương tự bằng thư viện `cvss` (`tools/reporting/tool.py:135-153`).

### E.5. Khuyến nghị theo WSTG và giấy phép

Mặc định **chỉ liên kết** tới trang test ở commit ghim: `https://github.com/OWASP/wstg/blob/28553f878d48358767892916d53e59a9d664811c/document/4-Web_Application_Security_Testing/<nhóm>/<tệp>.md` (cây `document/` theo `research/WSTG_PROVENANCE.json`). Nhúng nguyên văn mục Remediation vào báo cáo cần ghi công và share-alike (CC BY-SA 4.0) ảnh hưởng giấy phép của báo cáo: quyết định G-5. 104 trong 108 test có trang đã đăng ký (`wstg-source:`), nên bảng test → đường dẫn tạo được từ catalog.

### E.6. An toàn đầu ra

Thêm: (1) khối fence cho lệnh tái hiện; (2) liên kết tạo bởi host (CWE/WSTG) in dạng code, không phải link; (3) CSV `findings.csv` dùng `csvCell`; (4) kiểm hostile fixture mới cho `finding.*` (markup, fence, bidi, công thức); (5) giới hạn kích thước theo trường và theo báo cáo (đã có 16 MiB trong `publishReportFiles`).

### E.7. Tự động xuất báo cáo

| Mục | Đề xuất |
|---|---|
| Điểm gọi | `cleanupOwnerPass`, ngay sau khối `--export` (`index.ts:585-591`) và trước `store.finalize` (`598`); chạy sau khi sandbox đã dừng nên không có thao tác target nào |
| Lý do kích hoạt | `finished`, `stopped`, `shutdown`, `session-change`, `storage-failed`, `failed`; banner khác nhau cho từng lý do |
| Đồng ý | Một dòng trong hộp xác nhận đầu run ("báo cáo sẽ ghi vào …"); cờ `--report` hoặc setting `p2o.autoReport` (mặc định: G-2) |
| Đường dẫn | `<cwd>/.p2o-reports/report-<runId>/` (thư mục mới 0700, tệp 0600, rename nguyên tử qua `publishReportFiles`); nếu thư mục đã có (cleanup chạy lại) thì giữ, không ghi đè |
| Lỗi | Bọc try/catch như `--export`: ghi `reportError`, thông báo, vẫn hoàn tất dọn dẹp và finalize; không dựng thư mục dở |
| Kết quả cho model | Dòng nối thêm trong chuỗi `p2o_finish`: đường dẫn, số tệp, bytes, `complete`, đếm accepted/pending/stale |
| Ephemeral | Báo cáo nằm ngoài thư mục control nên còn sau khi store bị xóa; ghi rõ trong hộp xác nhận |
| Run bị ngắt | Cùng điểm gọi bao phủ stop/shutdown/switch; crash thì dùng `/p2o open` + `/p2o report export`, và lệnh này sẽ có đường dẫn mặc định và thông báo khi không có UI |
| Tùy chọn P2b | Bản "checkpoint" khi Engine `pause`/`blocked`/`wait` để crash giữa chừng vẫn để lại bản gần nhất; cần hàm thay thế nguyên tử mới, nên tách riêng (G-2b) |
| Chi phí | Hàm tất định O(records); đo p95 ở 10k/100k bản ghi trước khi bật mặc định |
| Rủi ro riêng tư | Thư mục nằm trong project có thể bị commit; chỉ cảnh báo, không sửa `.gitignore` của người dùng |

### E.8. Đoạn văn tường thuật (executive summary, khuyến nghị chiến lược)

Khung tất định không thể viết "tác động kinh doanh". Lựa chọn (G-6): **(a)** tham số tùy chọn `narrative` của `p2o_finish` (≤6K ký tự, được `mdText` vô hiệu hóa, gắn nhãn "do lead viết, chưa kiểm chứng"), giống strix nhận bốn trường văn bản lúc kết thúc; **(b)** worker `reporting` soạn rồi lead dán vào case; **(c)** chỉ khung tất định. Khuyến nghị là (a) cộng khung tất định, vì lead có đủ ngữ cảnh lúc cuối và không cần thêm vòng worker; chi phí là +~350 byte khai báo `p2o_finish`.

---

## F. Lộ trình theo giai đoạn

Nguyên tắc: (1) **đóng vòng bằng code, không bằng prompt** vì prompt lead bị ghim và guidance mặc định tắt vì không thấy lợi; (2) mọi thay đổi thêm hành vi đều sau công tắc setting, mặc định giữ hành vi hiện tại cho tới khi owner chốt; (3) chỉ **nối thêm** vào chuỗi kết quả cũ; (4) test hermetic dùng `createFakePi` + `InertSandbox` + SQLite thật như `report-export.test.ts`; (5) GitNexus không có node cho `src/*.ts`, nên impact là **UNKNOWN**: trước mỗi sửa chạy lệnh impact để ghi nhận, rồi liệt kê caller bằng grep (số liệu hôm nay: `renderReport` 3 dòng/0 test trực tiếp, `caseViews` 15 dòng, `reportProjection` 7, `freezeReport` 5, `workerBrief` 5, `taskCapsule` 5, `p2o_finish` 12 dòng và 14 file test); trước commit chạy `node .gitnexus/run.cjs detect-changes --scope all --repo .` và báo cả khi "critical".

| Pha | Quy mô | Phụ thuộc | Đụng prompt ghim? |
|---|---|---|---|
| P0 Nền và ghim | S | — | không |
| P1 Preflight kết thúc | M | P0 | không |
| P2 Báo cáo tự động khi dọn dẹp | M | P0 | không |
| P3 Mô hình rating cho case | M | P0 | không |
| P4 Báo cáo v2 chuẩn OWASP | L | P2, P3 | không |
| P5 Toàn vẹn review | M | P3 | không |
| P6 Hỗ trợ lập kế hoạch (+P6b tùy chọn) | M | P1 | **P6b có** |
| P7 Kiểm chứng và tài liệu | S | tất cả | không |

### P0 — Nền và ghim

*Việc:* (1) giữ phụ lục §13 và chạy lại `acceptance-matrix.test.ts` (đã ghép sẵn trong file này); (2) theo G-1, hoặc giữ nguyên hoặc chuyển hai khối baseline sang `docs/ACCEPTANCE_BASELINE.md` và trỏ test sang đó; (3) sửa tham chiếu treo (W-13): README.md:202, docs/*, `bench/README.md`, help của `scripts/benchmark-skills.mjs` trỏ sang `git show` của commit tương ứng như `src/roles.ts:35` đã làm; (4) lưu số đo nền (`measure-context.mjs`, script đo trùng) vào docs làm mốc.
*Test:* `acceptance-matrix.test.ts` giữ xanh; thêm guard "không còn link tới mục không tồn tại của planning_update.md".
*Nghiệm thu:* test hermetic liên quan xanh; không đổi hành vi runtime.
*Rủi ro:* thấp. *Rollback:* revert docs.

### P1 — Preflight kết thúc

*Việc:* `src/finish-preflight.ts` (hàm thuần trên `LedgerIndex` + `CaseContext` + `CoverageContext` + snapshot Engine + danh sách worker) trả `{blocking, advisory, counts}`; mã cố định:

| Mã | Điều kiện | Mức mặc định |
|---|---|---|
| `UNREVIEWED_TASK` | task `reported` hoặc `blocked` có handoff chờ owner | blocking |
| `UNREVIEWED_CLAIM` | head candidate `confirmed` không thuộc case nào | blocking |
| `PENDING_CASE` | case `pending` hoặc `disputed` | blocking |
| `STALE_CASE`, `STALE_CELL` | `currentness='stale'` | blocking |
| `NO_COVERAGE_PLAN` | không có plan nào | blocking (G-3) |
| `NONTERMINAL_CELLS` | cell `planned/running/attempted` | blocking |
| `OPEN_GAP_UNREFERENCED` | gap mở không cell/case nào tham chiếu | advisory |
| `ORPHAN_TASK` | task `blocked/cancelled/expired` không task khác phủ cùng bề mặt | advisory |
| `OPEN_GOAL` | goal `p2o_plan` chưa đóng | advisory |
| `UNMAPPED_NOTE_COVERAGE` | note coverage của worker chưa cell nào tham chiếu | advisory |
| `UNPLANNED_ASSETS` | `discoveredUnplannedAssets>0` | advisory |
| `WSTG_APPLICABLE_UNPLANNED` | test áp dụng theo trigger mà chưa có cell (cần P6) | advisory |
| `UNRATED_ACCEPTED_CASE`, `HIGH_WITHOUT_INDEPENDENCE` | cần P3/P5 | blocking sau khi có |

`p2o_finish`: tính preflight; nối khối tóm tắt vào `content` (cả ba chế độ); cổng `p2o.finishGate`: `off` (hiện trạng), `warn` (chỉ nối khối), `confirm` (lần gọi đầu có mục blocking: từ chối `FINISH_PREFLIGHT` kèm danh sách; ghi một note lifecycle của owner; **lần gọi thứ hai với cùng tập blocking thì chạy tiếp** và đưa các mục đó vào báo cáo "chưa giải quyết lúc kết thúc"). Không đổi `Type.Object({})` của `p2o_finish` ở P1 (không tăng khai báo).
*Test mới:* `finish-preflight.test.ts` (đơn vị: mỗi mã bật đúng khi cần, run sạch không mã nào; ngưỡng ledger lớn); mở rộng `extension.test.ts`/`worker.test.ts` cho ba chế độ; `benchmark.test.ts` thêm fixture chuỗi finish có khối mới, bộ chấm vẫn đọc "Coverage:"/"Open items:". *Test sửa:* không đổi dòng cũ nên các test finish hiện có phải xanh nguyên văn.
*Nghiệm thu:* (1) `off` cho cùng byte đầu ra cũ; (2) `confirm` từ chối tối đa một lần cho mỗi tập blocking, không vòng lặp vô hạn; (3) mọi mã có test dương và âm; (4) không gọi model, không chạm target.
*Rủi ro:* chặn nhầm gây thêm một lượt model mỗi run; thay đổi hành vi benchmark nên coi là cánh mới khi so sánh (không chạy trả phí nếu chưa được duyệt). *Rollback:* `finishGate: off`; revert một file mới + một khối trong `p2o_finish`.

### P2 — Báo cáo tự động khi dọn dẹp

*Việc:* mục §E.7; thêm `current.reportPath/reportError`, cờ/setting, dòng nối trong chuỗi finish và thông báo khi dừng; `ReportMeta` thêm `endReason` để banner; `/p2o report export` có đường dẫn mặc định và báo rõ khi không có UI (W-12).
*Test mới:* `report-auto.test.ts`: (1) finish → thư mục đủ tệp, manifest khớp hash, hai lần render cùng sequence cùng byte; (2) `/p2o stop`, shutdown, đổi session → có báo cáo với banner ngắt; (3) render lỗi (ledger không đầy đủ) → cleanup vẫn xong, `reportError` hiện, không có thư mục dở; (4) ENOSPC theo mẫu `bundle-fault.test.ts`; (5) `ephemeral` → báo cáo còn sau khi kho bị xóa; (6) đích trong private state bị từ chối; (7) cleanup chạy lại không ghi đè. *Test sửa:* `report-export.test.ts` (golden thêm banner), `help-commands.test.ts` (mô tả lệnh).
*Nghiệm thu:* thời gian render p95 đo ở 10k và 100k bản ghi (báo cáo số, không đặt ngưỡng tùy ý); mọi đường dừng của §A.4 có báo cáo, trừ crash.
*Rủi ro:* kéo dài cleanup (khi shutdown có hạn giờ của Pi); lộ dữ liệu vì ghi vào cwd (cùng mức nhạy cảm với `.p2o-state`, đã được redact best effort). *Rollback:* tắt setting; xóa một khối chèn.

### P3 — Mô hình rating cho case

*Việc:* §E.2, `src/cvss.ts`, validator, hiển thị trong `p2o_case view`, tài liệu `docs/CASE_REVIEW.md`; preflight `UNRATED_ACCEPTED_CASE`. Đo trước: khai báo `p2o_case` hiện 4.697 byte; thêm `finding` có thể vượt 2% của loadout (≈725 byte) nên cân nhắc chuyển thành hành động riêng `p2o_case action=rate` hoặc rút gọn mô tả schema; nâng số ghim có chủ đích nếu cần.
*Test mới:* `case-rating.test.ts` (ma trận hợp lệ/không hợp lệ, hostile string, giới hạn kích thước, tương thích ngược với ledger tạo bởi bản `4bd7674`), `cvss.test.ts` (§E.4).
*Nghiệm thu:* case cũ không có `finding` đọc y hệt; case mới bị từ chối khi `severity` trái luật `inferred ≤ Medium`; không thay đổi `verdict`/`reviewStatus`.
*Rủi ro:* bản p2o cũ loại case mới (E.2); tăng khai báo tool. *Rollback:* trường tùy chọn nên chỉ cần revert; run đã ghi `finding` sẽ mất trường khi mở bằng bản cũ (ghi vào docs).

### P4 — Báo cáo v2

*Việc:* §E.3, `REPORT_FORMAT_VERSION=2`, thêm `findings.json`, `findings.csv`, `wstg-checklist.csv`; liên kết WSTG ghim; khối tái hiện; cờ "báo cáo cũ hơn bằng chứng"; tham số `narrative` của `p2o_finish` (G-6); setting `p2o.reportFormat: 1|2` để quay lại v1.
*Test mới:* golden cho v2 (run sạch, run nhiều case, run ngắt); hostile fixture cho mọi trường `finding.*`; tất định hai lần; kiểm kích thước và giới hạn hàng; mapping từng mục WSTG §5 → vị trí trong REPORT.md bằng test cấu trúc (tiêu đề đúng thứ tự). *Test sửa:* `report-export.test.ts`, `help-commands.test.ts`, `acceptance-matrix` (hàng mới F-P4).
*Nghiệm thu:* mỗi mục ở bảng §E.1 có mặt hoặc có dòng "không có dữ liệu" tường minh; `report-manifest.json` khớp hash; không có chuỗi đầu vào thù địch nào thành link, ảnh, HTML, fence thoát hoặc công thức.
*Rủi ro:* kích thước báo cáo, độ dài tiêu đề; người dùng quen v1. *Rollback:* `reportFormat: 1`.

### P5 — Toàn vẹn review

*Việc:* (1) `TaskBoard.transition(reviewed)`: yêu cầu evidence do worker được giao (hoặc owner khi solo) tạo ra, trừ khai `externalEvidence`; (2) `contractGap` tính từ `outputContract.required` theo bảng ánh xạ trường → bản ghi (evidence→evidence của worker; gaps→open; candidates→candidate; coverage→coverage; artifacts→artifact; facts/assets/controls→bản ghi graph), lưu vào bản ghi review; chế độ `annotate` trước, `enforce` sau (G-10); (3) mức High/Critical cần `independentCurrent` hoặc `independenceWaiver`; (4) báo cáo hiển thị tác giả evidence (self/other) và proof level.
*Test mới:* `review-integrity.test.ts` (bao gồm evidence của worker khác, contract thiếu, `partialAllowed` true/false, solo).
*Nghiệm thu:* không chặn nhầm trường hợp hợp lệ trong bộ fixture K0–K7 (§13 vẫn xanh); `annotate` không thay đổi quyết định nào.
*Rủi ro:* chặn nhầm khi evidence hợp lệ đến từ worker khác (mitigation: `externalEvidence`). *Rollback:* setting `reviewIntegrity: off`.

### P6 — Hỗ trợ lập kế hoạch

*P6a:* `p2o_coverage action=suggest` (chỉ đọc, bounded): đầu vào `features[]` (từ vựng `WSTG_FEATURES`), `modes?`, `limit`; đầu ra test WSTG khớp trigger mà chưa có cell (khóa, tiêu đề, `support`, cờ B/I, skill sở hữu, card, phase); `WSTG_APPLICABLE_UNPLANNED` ở preflight dùng cùng hàm; cầu nối `UNMAPPED_NOTE_COVERAGE`. *Capsule:* bỏ bản capsule trong brief (giữ bản request-local mới hơn) để bớt 2,6–5,5K ký tự mỗi request của worker; kiểm `P2O STATE GAP` fallback. Brief không còn trùng, hash brief ghim dùng input không có `objective` nên không đổi.
*P6b (tùy chọn, đụng prompt ghim):* tách `reconInstructions` thành hợp đồng bàn giao chung (~565 ký tự), phần định tuyến Planner (chỉ lead/solo) và phần tác nghiệp worker (chỉ worker/solo); worker `validation` và `reporting` chỉ nhận hợp đồng bàn giao. Ước lượng: lead delegated −596 ký tự, worker −732, `validation/reporting` −1.328 đến −1.893. Phải đổi hash ghim và trần kích thước **có chủ đích** kèm số đo; chỉ làm nếu G-8 cho phép.
*Test mới:* `coverage-suggest.test.ts`; sửa `worker.test.ts` (capsule một lần); P6b sửa `recon.test.ts` pins.
*Nghiệm thu:* `suggest` không ghi gì; kết quả bounded; số ký tự đo lại bằng `measure-context.mjs` giảm đúng như ước lượng.
*Rủi ro:* mô hình không gọi `suggest` nếu không có lời khuyên (nên preflight `WSTG_APPLICABLE_UNPLANNED` là lưới an toàn); P6b làm lệch so sánh với benchmark cũ. *Rollback:* revert; hash cũ khôi phục.

### P7 — Kiểm chứng và tài liệu

*Việc:* cập nhật `docs/USAGE.md` (báo cáo, finish gate), `ARCHITECTURE.md` (luồng), `CASE_REVIEW.md`, `SKILL_RUNTIME.md`, thêm hàng F-P1..F-P6 vào `docs/ACCEPTANCE_MATRIX.md` (giữ 22 + 7 hàng baseline), nhật ký ở `docs/VERIFICATION_LOG.md`, `scripts/measure-context.mjs` thêm số đo capsule và báo cáo.
*Kiểm chứng miễn phí:* `npm test` (build, vitest, python), `scripts/measure-context.mjs --source`, `scripts/benchmark-skills.mjs plan` và `verify`, `node scripts/render-wstg-map.mjs`, Docker opt-in chỉ dùng ảnh đã có. **Không** claim hiệu quả pentest từ các kiểm này. Benchmark trả phí chỉ khi owner nói rõ (G-12).
*Nghiệm thu:* toàn bộ test xanh; số đo mới ghi cạnh số đo nền; GitNexus `detect_changes` chạy và kết quả (kể cả "critical" do mô hình đồ thị) được báo lại.
*Rollback:* theo từng pha.

**Việc không làm trong kế hoạch này (non-goals):** không thêm lời gọi model từ host; không mở rộng scope hay quyền; không thay đổi ticket/broker; không chạy benchmark trả phí; không dùng provider codex proxy; không commit, push, install khi chưa được duyệt; không thêm trailer AI attribution vào commit/PR nếu sau này commit.

---

## G. Các quyết định cần owner chốt

| ID | Quyết định | Khuyến nghị | Hệ quả nếu khác |
|---|---|---|---|
| G-1 | Quan hệ plan ↔ test: giữ §13 ở file này hay tách baseline sang `docs/ACCEPTANCE_BASELINE.md` và đổi test | Tách ở P0 (bớt ràng buộc plan↔test) | Giữ: mọi lần viết lại plan phải ghép §13 nguyên văn |
| G-2 | Báo cáo tự động: mặc định bật/tắt, cờ (`--report`) hay setting, vị trí `.p2o-reports/report-<runId>/`; có làm P2b (checkpoint) không | Bật mặc định cho `durable-local`; đồng ý ở hộp xác nhận đầu run; P2b để sau | Tắt mặc định: nhiều người vẫn chỉ thấy chat |
| G-3 | Cổng kết thúc mặc định `off/warn/confirm`; mục nào blocking (nhất là `NO_COVERAGE_PLAN`) | `warn` ở P1, nâng `confirm` sau khi có kiểm chứng miễn phí | `confirm` ngay: thêm một lượt model nhưng chặn bỏ sót sớm |
| G-4 | Mô hình mức nghiêm trọng: chỉ thang p2o; thêm CVSS tùy chọn; CVSS bắt buộc; CWE bắt buộc | Thang p2o bắt buộc cho case accepted, CVSS và CWE tùy chọn (WSTG nói CVSS tùy chọn) | Bắt buộc CVSS: tăng ma sát, mô hình dễ chọn vector tùy ý |
| G-5 | Khuyến nghị WSTG: chỉ liên kết hay nhúng đoạn Remediation | Chỉ liên kết | Nhúng: phải ghi công và áp dụng share-alike lên báo cáo |
| G-6 | Đoạn tường thuật: tham số `narrative` của `p2o_finish`, worker `reporting`, hay chỉ khung tất định | `narrative` cộng khung tất định | Chỉ khung: executive summary nghèo ý nghĩa kinh doanh |
| G-7 | Định dạng ngoài Markdown: JSON, CSV (khuyến nghị), HTML (cần sanitizer, hoãn), SARIF (hợp target mã nguồn, hoãn), PDF (không) | Markdown + JSON + CSV | HTML/SARIF: thêm bề mặt tấn công và công việc kiểm thử |
| G-8 | Cho phép P6b (sửa văn bản prompt worker/lead và đổi hash ghim)? | Chỉ capsule một lần (P6a); P6b hoãn | Làm: giảm ~600–1.900 ký tự nhưng phá so sánh với benchmark cũ |
| G-9 | Hành vi của tool (cổng, tham số, chuỗi kết quả) được mô tả trong `description` luôn bật; lời khuyên quy trình ở `promptGuidelines` (mặc định tắt) | Đồng ý | Nếu mọi mô tả phải qua guidelines thì hành vi mới chỉ hiện khi bật `toolGuidance` |
| G-10 | Độ nghiêm của toàn vẹn review: `annotate` hay `enforce`; waiver cho High/Critical ở chế độ solo | `annotate` trước, `enforce` sau | `enforce` ngay: nguy cơ chặn nhầm |
| G-11 | Siêu dữ liệu báo cáo (tác giả, tổ chức, nhóm, phân loại, miễn trừ) lấy từ `settings.json` `p2o.report`? | Có, tùy chọn; mặc định chung | Không: mục 1.1–1.3, 1.7 luôn "do người vận hành cung cấp" |
| G-12 | Có chạy benchmark trả phí sau P1–P2 không, với model/ngân sách nào | Chưa; chờ owner | — |
| G-13 | Báo cáo trong `cwd` có thể bị commit nhầm: chỉ cảnh báo, hay cho phép đặt `p2o.reportRoot` ngoài project | Thêm `p2o.reportRoot` tùy chọn ở P2 | Chỉ cảnh báo: rủi ro rò rỉ nếu người dùng quên |

---

## H. Phụ lục — tái lập số đo (tất cả chỉ đọc, không model, không mạng, không target)

| Số đo | Lệnh |
|---|---|
| Kích thước prompt lead/worker, khai báo tool theo loadout, trang skill | `node scripts/measure-context.mjs --source` (thêm `--json` để máy đọc) |
| Trùng lặp prompt ↔ tool ↔ skill, cụm khái niệm, dòng khối recon | script tạm trong thư mục scratch của phiên (shingle 7 từ trên `ownerInstructions`, `workerInstructions`, mô tả tool đăng ký bằng Pi giả); nếu cần tái lập vĩnh viễn, P0 đề xuất `scripts/measure-overlap.mjs` |
| Kích thước capsule mục tiêu | mẫu tổng hợp qua `taskCapsule` (độ dài thật phụ thuộc task) |
| Cấu trúc trang WSTG chương 4 | `grep -rlE '^## Remediation' my_references/wstg/4-Web_Application_Security_Testing` (và tương tự cho `## References`, `CWE`, `CVSS`) |
| Số tool và dòng | `wc -l src/*.ts extensions/p2o/*.ts` |
| Test hermetic liên quan tới file này | `npx vitest run tests/minimal/acceptance-matrix.test.ts tests/minimal/wstg-skills.test.ts tests/minimal/wstg-map.test.ts tests/minimal/measure-context.test.ts` |

---

## 13. Acceptance matrix và baseline

Baseline K0–K7 (22 fixture bắt buộc, các phép đo, 7 điều kiện không đạt) đã chuyển sang [docs/ACCEPTANCE_BASELINE.md](docs/ACCEPTANCE_BASELINE.md) (quyết định G-1). Mọi giai đoạn P0–P7 giữ nguyên chúng; [ACCEPTANCE_MATRIX](docs/ACCEPTANCE_MATRIX.md) ánh xạ từng hàng tới test thật. Kế hoạch này không còn bị `acceptance-matrix.test.ts` đọc.

---
