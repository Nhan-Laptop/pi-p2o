# Hoạch định p2o giai đoạn W0–W8: tin cậy, vận hành và hiệu quả của workspace đánh giá

> **Trạng thái: thiết kế PROPOSED; một phần đã triển khai trong working tree, chưa commit** (xem §0.1 để biết slice nào đã có code/test và phần nào lệch khỏi thiết kế). Soạn 2026-10-10 trên `main` @ `7e204c3` (đã push, đã cài vào Pi 1.1.0). Chưa có gì của giai đoạn này được publish/install hay đo trên bản cài; hiệu quả pentest vẫn UNVERIFIED.
> Tài liệu này **thay** bản hoạch định K0–K7 trước đó. Bản gốc (PROPOSED, đã implement một phần, 875 dòng) đọc tại commit `7e204c3`: `git show 7e204c3:planning_update.md`. Các contract [STATE_STORE](docs/STATE_STORE.md), [ASSET_GRAPH](docs/ASSET_GRAPH.md), [WORK_ADMISSION](docs/WORK_ADMISSION.md), [CASE_REVIEW](docs/CASE_REVIEW.md), [CONTEXT_PACKETS](docs/CONTEXT_PACKETS.md), [PLANNER_ENGINE](docs/PLANNER_ENGINE.md) vẫn trích dẫn "planning_update.md" cho thiết kế K0–K7: đọc các trích dẫn đó theo bản gốc. Trạng thái triển khai nằm ở [KNOWLEDGE_WORKSPACE](docs/KNOWLEDGE_WORKSPACE.md). §13 giữ nguyên acceptance baseline K0–K7 mà [ACCEPTANCE_MATRIX](docs/ACCEPTANCE_MATRIX.md) và guard test tham chiếu.
> Những link/hash lịch sử trỏ đến bản plan trước phải được đọc tại commit tương ứng; không sửa acceptance cũ để hợp thức hóa plan mới.

## 0. Kết luận điều hành

**Không cần thêm một subsystem lớn nữa.** K0–K7 đã đưa vào store canonical, graph, chống trùng, case/coverage, context packet và ma trận acceptance. Giai đoạn tiếp theo phải làm cho những thứ đó **đáng tin, điều khiển được và thật sự được dùng**, rồi mới tối ưu chi phí và quy mô.

Bốn kết luận có bằng chứng trực tiếp trong source (§4):

1. **Danh tính runtime chưa bao phủ code đang chạy (D1).** Cổng "ticket extension identity", `runtimeHash` của run và `extensionSha256` trong export chỉ băm `extensions/p2o/index.ts`, trong khi hành vi nằm ở 46 module `src/**`. Sửa nhỏ, nhưng làm các receipt kiểu "hash khớp" nói quá.
2. **Model chưa được dạy workflow mới (D2, D3).** `src/prompts.ts` không nhắc `p2o_case`, `p2o_plan`, `p2o_coverage`, `p2o_graph`, `p2o_state`, `p2o_capture`, `p2o_artifact`; không tool nào khai báo `promptGuidelines`; `p2o_delegate` không `taskId` không có work identity nên không đi qua K4. Nếu model không dùng các tool này thì phần lớn giá trị K3–K6 không xuất hiện trong output (**UNVERIFIED**, cần đo có ủy quyền).
3. **Người dùng chưa có mặt điều khiển và sản phẩm cuối của riêng mình (D4, D5, D7).** Không có lệnh dừng một worker hay giữ thao tác target mà không kết thúc run; `/p2o log` không lọc dù store đã hỗ trợ; tín hiệu "worker im lặng" chỉ tới model; chưa có báo cáo đọc được sinh deterministic.
4. **Chi phí cố định mỗi request lớn và sản phẩm chưa đo (D6).** Planner delegated nạp 18 tool = 35.514 B khai báo + 5.488 B chính sách; worker 14 tool = 20.458 B + ≈5,9 KB (**MEASURED**, §8). Chưa có số token/cost theo role, chưa dùng `getContextUsage()`.

Thứ tự đề xuất (§7): **W0** toàn vẹn + dọn trùng (đã làm một phần) → **W1** quan sát ∥ **W3** chính sách/admission → **W2** điều khiển → **W5** báo cáo deterministic → **W4** tìm kiếm → **W6** chi phí (chính sách mutation chỉ khi được duyệt) → **W7** quy mô/cấu trúc (xen kẽ) → **W8** acceptance, release, đo hiệu quả khi được ủy quyền.

**MVP có giá trị rõ cho người dùng mà không đổi hành vi model: W0 + W1 + W2 + W5.**

**Không làm** (chốt ở §2 và §5): viết lại Planner/Engine/Worker; dashboard web; retry/fallback hay pool model; heartbeat hoặc ép sinh việc; tự mở scope từ asset phát hiện được; xóa vật lý lịch sử; cap token/cost khi chưa có ủy quyền riêng.

### 0.1. Trạng thái triển khai (cập nhật 2026-10-10, working tree chưa commit)

| Slice | Trạng thái | Lệch khỏi thiết kế / ghi chú | Bằng chứng |
|---|---|---|---|
| W0 | **Đã làm** | Digest closure `entry + src/** + version` (`src/runtime-digest.ts`) dùng cho cổng ticket, `profile.runtimeHash` và export; hiển thị ở hộp xác nhận và `status`. Ticket digest cũ bị từ chối. Gộp helper trùng, `registerExecTool`, nâng timeout test | `runtime-digest.test.ts`; mục verification trong KNOWLEDGE_WORKSPACE |
| W1 | **Phần lớn** | Có: `log` lọc task/actor/operation (+ `tail` ở store), bảng worker + `QUIET` trong `status`/widget, dòng ngữ cảnh Planner từ `getContextUsage()`. **Chưa làm:** thẻ render gọn (`registerToolRenderer`) vì Pi đã thu gọn mặc định và chưa có số đo nhu cầu; sự kiện `planner.admitted` ghi usage chỉ khi có wake hợp lệ (chưa có fixture wake) | `operator-visibility.test.ts` |
| W2 | **Đã làm** | `hold`/`release`/`workers`/`stop-worker`; cổng ở broker, executor queue, tool owner, launch và hàng đợi dispatch; chỉ người dùng gọi được. Không thêm steer của người (câu hỏi §11.9 chưa trả lời) | `operator-controls.test.ts` (đã mutation-check) |
| W3 | **Đã làm; guidance tắt mặc định theo benchmark** | **Lệch:** chính sách không nằm trong prompt của lead vì `recon.test.ts`/`native.test.ts` ghim prompt không chứa tên tool, `<5000` ký tự và hash guidance worker; lần thử đầu đặt vào prompt làm 12 test fail và đã hoàn nguyên. Guidance gắn theo **từng tool** (`promptGuidelines`, `src/tool-guidelines.ts`, v1: 1.003 B Planner / 314 B worker), bật bằng `p2o.toolGuidance`. **Benchmark (§0.2): guidance đổi hành vi nhưng +≈70% chi phí và +2 run không hợp lệ/16, không tăng chất lượng → mặc định TẮT.** `p2o_delegate` nhận `work/decision/outputContract` + `workMatch` + event `delegate.unstructured`. Guard tên/loadout/ngân sách. **Chưa làm:** schema thô hơn cho `p2o_graph/task/case/coverage`, nên mục tiêu ≤≈28 KB **không đạt**: khai báo thực tế tăng +2,1% (§8) | `workflow-policy.test.ts`; receipt benchmark cục bộ |
| W4 | **Bản lite** | **Lệch:** không FTS5/schema 8; quét có giới hạn trên ledger đã memo (phương án B của §6/W4): chuỗi con literal, 2–80 ký tự, ≤20 hit, total chính xác, cursor theo vị trí; không tìm bytes artifact. p95 ≈18 ms @100k synthetic | `search.test.ts` |
| W5 | **Đã làm** | `/p2o report export <dir>` (cả run đang chạy lẫn lịch sử đã mở): `REPORT.md`, `cases.csv`, `coverage.csv`, manifest; tất định, vô hiệu hóa markup/công thức, ghi nguyên tử | `report-export.test.ts`, `bundle-fault.test.ts` |
| W6a | **Đã làm** | Usage theo role từ Pi, op `usage` có xác thực ở broker, event `usage.reported` khi kết thúc; không cap | `usage.test.ts` |
| W6b | **Bỏ khỏi phạm vi theo quyết định của người dùng** | Không làm chính sách chặn/hỏi trước mutation | — |
| W7 | **Một phần** | Đã gộp helper trùng và đăng ký `p2o_shell`/`p2o_net`; timeout test tập trung chưa gộp harness. **Chưa:** đếm status từ heads/SQL, TUI render p95, replay lớn, archive >64 MiB, tách `index.ts` (vẫn ~1,8 nghìn dòng) | KNOWLEDGE_WORKSPACE |
| W8 | **Một phần** | Đã chạy benchmark trả phí có trần (§0.2). Chưa version/CHANGELOG/tag, chưa cập nhật bản cài, chưa Herdr thật | receipt benchmark cục bộ |

### 0.2. Kết quả benchmark trả phí có trần (2026-10-10)

**Câu hỏi:** guidance theo tool (W3) và phần còn lại của giai đoạn W có làm model dùng workflow K3–K6 tốt hơn không, và với chi phí nào? **Cấu hình:** runner `scripts/benchmark-skills.mjs` (hermetic `verify` 8/8 biến thể pass trước khi chạy), model `deepseek/deepseek-flash` (mặc định của runner, khóa API trực tiếp, thinking `off`), solo, sandbox Docker thật, 4 fixture synthetic (`fastapi-parity`, `object-authorization`, `output-context`, `route-inventory`) × biến thể `vulnerable`/`fixed` × 2 lần lặp, seed `20261010`, trần mỗi run 15 phút / 60 lượt / 120 lệnh target / $2, `--no-export` cho mọi nhánh. `HOME` riêng chỉ chứa `settings.json` của benchmark (manual/shared/ephemeral) và symlink tới cấu hình provider của người dùng để ép đúng chế độ solo; không đọc hay sao chép khóa. **Nhánh:** A = `7e204c3` (bản đã cài), C-on = working tree với `toolGuidance` bật, C-off = working tree với `toolGuidance` tắt (suite riêng cùng seed, nên thứ tự chạy khác nhau). Nhãn "baseline-4321f2b" trong receipt là tên mặc định của runner; đường dẫn thật nằm ở `extensionPath`.

| | A (7e204c3) | C-on (guidance bật) | C-off (guidance tắt) |
|---|---|---|---|
| Số run / hoàn tất / không hợp lệ | 16 / 15 / 1 timeout | 16 / 13 / **3** (2 timeout, 1 hết lượt) | 16 / 16 / 0 |
| Chi phí trung bình mỗi run (trung vị) | $0,041 ($0,037) | **$0,071** ($0,064) | $0,042 ($0,042) |
| Token trung bình (trung vị) | 755k (587k) | **1.393k** (1.294k) | 709k (688k) |
| Lượt model trung bình | 21,6 | **32,0** | 20,4 |
| Thời gian trung bình / trung vị (giây) | 159 / 83 | 238 / 153 | 88 / 88 |
| Recall trung bình, biến thể vulnerable (run hoàn tất) | 0,96 (n=7) | 1,00 (n=7) | 0,94 |
| Precision trung bình, vulnerable | 0,79 | 0,76 | 0,78 |
| False positive trên biến thể fixed (số FP / số run hoàn tất) | 7 / 8 | 4 / 6 | 8 / 8 |
| Gọi tool mỗi run: `p2o_case` / `p2o_task` / `p2o_graph` / `p2o_plan` / `p2o_coverage` | 1,1 / 0,9 / 1,0 / 1,3 / 5,1 | **8,0 / 5,3 / 3,7 / 3,2 / 8,6** | 1,9 / 0,9 / 1,1 / 0,6 / 4,8 |

**Đọc kết quả (không đọc quá mức):** (1) Guidance **làm đúng việc nó được viết để làm** — model gọi tool case/task/graph/plan nhiều gấp 2–7 lần — nhưng việc đó tốn ≈+70% chi phí và +≈50% lượt, và 3/16 run bị cắt bởi trần thời gian/lượt (so với 1/16 và 0/16; chênh lệch số run không hợp lệ **không có ý nghĩa thống kê** ở cỡ mẫu này). (2) Chất lượng các run hoàn tất **không** tăng: recall/precision và false positive trên biến thể fixed nằm trong nhiễu giữa ba nhánh. Mọi nhánh còn báo lỗi giả trên mã đã vá ở mức cao (≈1 FP/run) — vấn đề chất lượng chung, không phải của W. (3) C-off ≈ A về chi phí, lượt và hồ sơ gọi tool, nên W0/W1/W2/W4/W5/W6a **không** làm đổi hành vi hay chi phí của model trong benchmark này (đúng thiết kế: chúng không đổi prompt). (4) **Giới hạn:** 16 run mỗi nhánh, một model rẻ, một cấu hình thinking, fixture nhỏ synthetic, một seed; không có adjudication độc lập ngoài scorer từ vựng của runner; recall/precision dựa trên scorer đó. Đây là bằng chứng chi phí/hành vi, **không** là bằng chứng chất lượng pentest và không so sánh với ARTEX. **Quyết định:** `toolGuidance` mặc định **tắt** (người dùng bật bằng `p2o.toolGuidance: true`); hỏi lại khi có benchmark lớn hơn hoặc fixture phức tạp hơn nơi workflow nặng có thể đáng giá.

**Chi tiêu và vận hành:** tổng ≈$2,55 (A/B $1,80 + ablation $0,68 + preflight $0,08 + một preflight thất bại không tính phí đáng kể). Một preflight đầu qua provider `openai-codex-account-3` của người dùng **thất bại sau 17 giây** (`provider_error`: `terminated` rồi `Provider is not configured`, ≈10 nghìn token): hệ proxy nhiều tài khoản của người dùng ghi đè `auth.json`/`models.json` đúng lúc đó và cần các extension riêng của họ, nên không dùng cho benchmark; giữ nguyên receipt (`preflight-codex-provider-error`) và không đánh giá là kết quả. Dọn dẹp: 48 run không rò container nào (`leakedContainers` rỗng, số container `p2o-*` vẫn 4); cleanup được xác minh 44/48 — 4 run còn lại chính là các run bị cắt bởi timeout/hết lượt (trong đó một run nhánh A), cleanup của chúng không được runner xác nhận dù không thấy container rò. Receipt (`bench/results/w-phase-20261010/`) là cục bộ và gitignored; HOME benchmark ở `bench/.work/`.

### Quy ước bằng chứng

- **SOURCE-CONFIRMED:** đọc source/test/doc trong snapshot; không đồng nghĩa đã chạy end-to-end.
- **MEASURED:** có phép đo tái lập được, ghi phương pháp; không phải hiệu quả pentest.
- **DESIGN-INFERENCE:** hệ quả kiến trúc có cơ sở, chưa có số đo người dùng/benchmark.
- **PROPOSED:** schema, API, UX, ngưỡng nghiệm thu của bản này.
- **UNVERIFIED:** chưa đủ bằng chứng, nhất là hiệu quả pentest, chất lượng finding, chi phí thực.

Nhãn: `D#` chẩn đoán, `W#` slice, `F-…` fixture, `A#`/`P#`/`PI#`/`M#` nguồn (§15).

---

## 1. Trạng thái hiện tại và cách đọc tài liệu này

### 1.1. Snapshot 2026-10-10

| Hạng mục | Giá trị | Nhãn |
|---|---|---|
| Release | `package.json` vẫn **0.5.0**; `main` @ `7e204c3` đã push; bản cài `~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o` = `7e204c3`, 120 file giống byte với source, 6 test inert trên bản cài pass; chưa có tag, version hay CHANGELOG mới | SOURCE-CONFIRMED |
| Chưa commit | README/USAGE/KNOWLEDGE_WORKSPACE cập nhật trạng thái; `src/validate.ts` + gộp helper trùng; `registerExecTool` cho `p2o_shell`/`p2o_net`; nâng timeout test; plan này; `AGENTS.md` (chưa track, có quy tắc không gắn attribution AI vào commit/PR) | SOURCE-CONFIRMED |
| Test | `npm test` exit 0: **388 Vitest passed / 12 skipped** (44 file pass / 6 skipped), Python **143 / 1 skipped**; opt-in Docker 11/11 trên Pi 1.1.0 (chạy trước lần gộp helper, chưa chạy lại) | SOURCE-CONFIRMED |
| Pi | 1.1.0 (devDependencies pin và managed install); thay đổi API 1.0→1.1 chỉ additive | SOURCE-CONFIRMED |
| Quy mô | 46 module `src/**` (5.880 dòng), `extensions/p2o/index.ts` 1.668 dòng, 24 tool, 50 file test, 13 tài liệu `docs/` | MEASURED |
| Store | SQLite schema 7, rollback journal `DELETE`/FULL sync, heads/links/cursors rebuildable trong cùng database | SOURCE-CONFIRMED |
| Status path | refresh p95 ≤114 ms @100k records synthetic (mục tiêu <200 ms); live heap ≈80 MiB @100k; chưa gồm TUI render | MEASURED |

### 1.2. Gates còn mở của K0–K7 và slice nhận chúng

| Gate còn mở | Nguồn trạng thái | Slice |
|---|---|---|
| Archive/checkpoint segmented >64 MiB; typed domain re-import cho bundle; ancestor/TOCTOU/read bounds/partial-import atomicity/foreign sensitivity | K2 trong KNOWLEDGE_WORKSPACE | W7 |
| Broader crash/platform acceptance | K2, K3 | W8 |
| Alias/fuzzy **gợi ý** (không chặn), typed incremental branch-output refs, biến thể interruption/reservation/crash | K4 | W3, W7 |
| Affected-variant policy cho case | K5 | W7 |
| TUI render p95; đếm status từ heads/SQL; large mixed replay fixtures; import atomicity/privacy/platform matrix | K6 | W7 |
| Full per-requirement installed/Herdr thật/paid audit | K7 | W8 |
| Provider/version stop races | PLANNER_ENGINE (P5/P6 còn lại) | W8 |
| Warm session reuse | PLANNER_ENGINE | **Không làm**: giữ fresh ticket/session mỗi assignment |
| Token/cost governance | PLANNER_ENGINE: cần ủy quyền riêng | W6 chỉ **hiển thị**; mọi cap cần quyết định riêng |

### 1.3. Cách đọc

Mỗi slice ở §6 có mục tiêu, thiết kế, điều không làm, gate, rủi ro và cỡ (S/M/L theo số module và test bị chạm, **không** phải ước lượng thời gian). Slice chưa được duyệt thì chưa được tính là "đã quyết". Câu hỏi cần người dùng trả lời ở §11.

---

## 2. Nguyên tắc bất biến

Các nguyên tắc 1–12 kế thừa từ bản K0–K7 và `docs/*`; 13–16 là mới của giai đoạn này.

1. **Manual/shared mặc định;** event-driven, isolated và mọi vòng model tự động chỉ khi có consent trong hộp xác nhận.
2. **Delegated Planner không target-execute;** solo mới thực thi. Worker không dispatch/review; reporting là synthesis-only.
3. **Fresh ticket/session cho mỗi assignment,** runtime mismatch gate, reviewed prerequisites, revoke/cancel, verified cleanup, source snapshot nhất quán.
4. **Không** trần worker cố định, không `2× maxWorkers`, không TTL assessment/worker, không timeout lệnh mặc định, không retry/fallback provider ngầm, không heartbeat model, không ép sinh việc khi hết hướng (`wait`/`blocked`/human-needed hợp lệ).
5. **Scope chỉ đến từ xác nhận của người.** Discovery, import, graph, checkpoint, đầu vào từ model **không** cấp quyền hay mở rộng scope.
6. **Tri thức không phải authority:** replay, checkpoint, bundle không khôi phục ticket/socket/cookie/budget/worker.
7. **Append-only:** không xóa vật lý bằng chứng hay lịch sử; dùng revision, `withdrawn`, `superseded`, `stale`.
8. **Nhãn phải đúng:** `reported ≠ reviewed ≠ closed ≠ verified`; `blocked/untested ≠ clean`; rỗng ≠ an toàn; checkpoint committed ≠ còn hiện hành; resources cleaned ≠ assessment complete.
9. **Không background LLM, không đổi budget/mode, không compaction trả phí** mà hộp xác nhận không nói rõ.
10. **Reference là dữ liệu không tin cậy, đọc tĩnh:** không chạy, import, build, đóng gói; không dùng IP/credential/campaign artifact; chỉ học kiến trúc workflow.
11. **Acceptance lịch sử bất biến;** receipt mới ghi riêng, lần fail đầu giữ riêng, không sửa hash để "pass".
12. **Commit/push/install chỉ khi người dùng yêu cầu** và không kéo dài sang lần sau; không gắn attribution AI vào commit/PR (`AGENTS.md`); impact GitNexus trước khi sửa symbol (`UNKNOWN` ≠ an toàn, xác nhận bằng text search); `detect_changes` trước khi commit.
13. **Nội dung do target/model sinh ra là không tin cậy khi render ra ngoài:** mọi export phải vô hiệu hóa markup hoạt động (link, ảnh, HTML, fence, công thức CSV, ANSI/bidi). Bài học trực tiếp từ đợt hardening thông báo của ARTEX 0.3.15 (A4).
14. **Nới lỏng và ghi ra host chỉ do người quyết định:** `release`, `approve`, `report export`, đổi mode/budget không có đường nào cho model. Việc siết (dừng worker, `blocked`) có thể có cả đường của người lẫn của model; `hold` là lệnh của người.
15. **Số đo token/cost chỉ để hiển thị:** nguồn là provider; thiếu dữ liệu là `unknown`, không phải 0 và không phải ước lượng giả làm số thực. Cap hoặc chặn theo chi phí cần quyết định riêng.
16. **Mỗi thay đổi khai báo tool/prompt phải qua ngân sách byte** (§8) để chi phí cố định không tăng im lặng.

---

## 3. Phương pháp, nguồn và provenance

**Đã đọc (tĩnh):**

- p2o: `extensions/p2o/index.ts` (lifecycle, đăng ký tool, hook `context`/`message_end`, lệnh `/p2o`), `src/broker.ts`, `src/engine.ts`, `src/tasks.ts`, `src/prompts.ts`, `src/tool-policy.ts`, `src/ticket.ts`, `src/progress.ts`, `src/roles.ts`, `src/state/schema.ts`, `src/state/store.ts` (events, context ACK), `src/ui/state.ts`, `src/ui/workspace.ts`, `src/ui/screen.ts`, các docs contract; bản kế hoạch K0–K7 từ git.
- Pi 1.1.0: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`.
- ARTEX (`my_references/ARTEX`, snapshot nhãn 0.3.15): `README.md`, `CHANGELOG.md` (0.3.15 và các mục UX 0.3.x), `my_requirement.md`, `guard/guard.go`, `intercept/intercept.go`, `report/report.go`, `report/findings.go`, `agent/tools.go` (trace search), `db/exploration.go` (`CancelIntent`), `server/manager.go` (`ApplyTaskPause`), `sidequestion/CONTEXT_BUDGET.md`, `llmrec/llmrec.go`, `db/schema.sql` (bảng rule/pending), danh sách `skills/`.

**Provenance reference (kiểm lại 2026-10-10, chỉ băm file):** SHA-256 bài phân tích `ARTEX_AGENTIC_CORE.vi.md` = `db70fdd06bda7994f9cb07f6deaccea8ca86c4dbfd3294441cde1bd1e8cc91fa` (không đổi so với bản K0–K7); `research_sources/source_manifest.json` liệt kê **332 file: 332 khớp, 0 thiếu, 0 lệch**. Điều này chỉ chứng minh nhất quán với manifest local, không xác thực tác giả/upstream và không phải audit từng dòng.

**Đo:** probe tạm một test Vitest nạp extension bằng fake Pi, cộng byte UTF-8 của `JSON.stringify({name, description, parameters})` theo từng loadout và độ dài chuỗi `ownerInstructions`/`workerInstructions` (M1, §8). Đơn vị là **byte, không phải token**.

**Không làm trong lượt hoạch định này:** chạy ARTEX, assessment, benchmark trả phí, Herdr thật; không commit/push/install thêm; không sửa `~/.pi/agent/settings.json`. GitNexus không có function node cho `src/*.ts` nên impact của symbol trong `src/` là `UNKNOWN`; mọi nhận định về caller dựa trên text search. Kết luận về hiệu quả pentest của ARTEX hay của p2o: **UNVERIFIED**.

---

## 4. Chẩn đoán workflow

### 4.1. Phát hiện (SOURCE-CONFIRMED trừ khi ghi khác)

| ID | Phát hiện | Bằng chứng | Mức | Slice |
|---|---|---|---|---|
| D1 | Runtime identity chỉ băm `index.ts`. Thay đổi chỉ ở `src/**` không đổi digest nên worker mở sau khi cập nhật gói vẫn qua cổng ticket dù chạy code khác owner; `runtimeHash`/`extensionSha256` trong receipt nói quá so với tài liệu "ticket bind extension bytes" | `extensionDigest(readFile(extensionPath))` dùng ở `readTicket` expectation, `profile.runtimeHash`, `extensionSha256` khi export | Cao (toàn vẹn) | W0 |
| D2 | Chính sách không dạy workflow K3–K6; tool không có `promptSnippet`/`promptGuidelines`; `EVIDENCE` chỉ gọi `p2o_note` coverage là "legacy"; bản K0–K7 từng hứa "knowledge packet guidance" cho `src/prompts.ts` (§12.1 cũ) nhưng chưa làm | `src/prompts.ts` chỉ nhắc `p2o_ledger`, `p2o_workers`; 0 lần `promptGuidelines` trong extension. Hệ quả cho hiệu quả: **DESIGN-INFERENCE/UNVERIFIED** | Cao (hiệu quả) | W3 |
| D3 | `p2o_delegate` không `taskId` tạo task legacy không có `work` nên K4 không có fingerprint, history reuse hay overlap warning; chỉ còn guard baseline so khớp chuỗi `focus`+role khi task đang reserved/running; đổi cách đặt `focus` là lọt | `spawnWorkerLocked` → `board.create` legacy; `reserve` → `ASSIGNMENT_CONFLICT: surface/risk already reserved with unknown structured identity` | Trung bình | W3 |
| D4 | Người dùng không có điều khiển theo worker hay giữ thao tác target; `p2o_stop_worker`/`p2o_steer` chỉ là tool của model; `/p2o pause` để worker đã admit tiếp tục (đã ghi trong PLANNER_ENGINE), `/p2o stop` kết thúc cả run | `HELP` chỉ có `stop`, `pause`, `resume` cho điều khiển run | Cao (an toàn vận hành) | W2 |
| D5 | Quan sát: `/p2o log` chỉ nhận cursor dù `AssessmentStore.events()` lọc được `actorId`/`taskId`/`operationId` (có index `events_actor/task/operation`); `stallSuspected` (`progress.view`, cửa sổ 120 s) chỉ tới model qua `p2o_workers`; `/p2o status` và widget không liệt kê worker; chỉ `p2o_task` có `renderResult`, 23 tool còn lại dùng hiển thị mặc định của Pi (nội dung là text, thường là JSON) trong transcript | `src/ui/workspace.ts::eventLines`, `src/progress.ts`, `src/ui/state.ts`, đăng ký tool | Trung bình | W1 |
| D6 | Chi phí cố định/request: Planner delegated 18 tool = 35.514 B + chính sách 5.488 B; solo 22 tool = 39.904 B; worker 14 tool = 20.458 B + ≈5,9 KB; reporting 9 tool = 13.627 B + 5.546 B. `p2o_graph` một mình 7.248 B (schema 6.301 B), `p2o_task` 5.816 B, `p2o_case` 4.697 B, `p2o_coverage` 4.403 B. Không có token/cost theo role; `getContextUsage()` chưa dùng | M1 (§8) | Trung bình | W1, W3, W6 |
| D7 | Không có báo cáo đọc được sinh deterministic: `/p2o report` là index, export là bundle NDJSON hoặc JSON receipts, bản tường thuật phụ thuộc model | `src/report.ts`, `.p2o-reports`, `src/state/bundle.ts` | Cao (sản phẩm) | W5 |
| D8 | Không có tìm kiếm văn bản trên record/artifact; `p2o_ledger` chỉ cursor/id, `p2o_state` chỉ domain/status | tham số hai tool | Trung bình | W4 |
| D9 | Hai read-model: status/widget/report dựng từ ledger v2 incremental, K6 dựng heads cho packet/`heads`/`digest`; cùng đếm task/case/coverage ở hai nơi, bị chặn ở 100k record | K6 trong KNOWLEDGE_WORKSPACE | Thấp–TB | W7 |
| D10 | Cấu trúc/bảo trì: một file 1.668 dòng; 24 tool; 17 nhánh `role === 'owner'` và 19 `client.request` (working tree sau khi gộp `p2o_shell`/`p2o_net`; 18 và 20 ở `7e204c3`), tức nhiều tool viết hai lần cho hai đường truyền; sáu bản harness real-Pi trong test với timeout lệch nhau; đoạn K2 lặp ở README, USAGE, STATE_STORE | đếm trực tiếp | Trung bình | W7 |
| D11 | Kỷ luật release: `main` khác baseline rất nhiều nhưng version vẫn 0.5.0, không CHANGELOG, bản cài chỉ phân biệt bằng commit; `PI_OFFLINE=1` làm `pi update` im lặng no-op (gặp ở 0.5.0 lẫn `7e204c3`) | `package.json`, receipt 0.5.0, phiên cài `7e204c3` | Trung bình | W0, W8 |
| D12 | Hai lớp coverage (`p2o_note kind=coverage` của worker và cell K5 của owner) và ba đường đọc chồng chức năng (`p2o_ledger`, `p2o_state`, các `list` của `p2o_task/plan/case/coverage`) mà chính sách không nói dùng khi nào | prompts, mô tả tool | Thấp | W3 |
| D13 | Consent cho phép mọi request đổi trạng thái; không có chính sách tùy chọn; egress sandbox mở, `p2o_http` chỉ kiểm origin | hộp xác nhận start; PLANNER_ENGINE, README | **Quyết định sản phẩm** | W6 (tùy chọn) |
| D14 | Test nhạy tải: timeout cứng 10–15 s fail khi load ≈6,8 (cả trên HEAD gốc). **Đã xử lý trong working tree** (W0) | KNOWLEDGE_WORKSPACE (receipt 2026-10-10) | Thấp | W0 |

### 4.2. Sổ trùng lặp/overlap

| Mục | Trạng thái | Ghi chú |
|---|---|---|
| 8 hàm kiểm tra đầu vào giống hệt trong `case-types.ts` và `coverage-types.ts` | **Đã gộp** (`src/validate.ts::fieldValidators(noun)`) | Thông báo lỗi giữ nguyên |
| SHA-256 hex ở `state/store.ts`, `state/bundle.ts`, `state/graph.ts`, `report.ts`; `validId` ở `context.ts`, `state/store.ts` | **Đã gộp** (`sha256Hex`, `validId`) | Còn 8 chỗ gọi `createHash('sha256')` một dòng, không cần gộp |
| `p2o_shell` và `p2o_net` | **Đã gộp đăng ký** (`registerExecTool`) | Cùng executor, receipt path và broker handler; chỉ khác nhãn receipt và hướng dẫn cho model. Giữ cả hai tên (tương thích, receipt, prompt). Mô tả của hai tool còn nhắc trần "60 s" và "300 s" (đã bỏ, và không nhất quán giữa hai tool) → W3 |
| `p2o_delegate` với `p2o_task dispatch` | Còn (D3) | Hai đường vào cùng `spawnWorker`; khác admission |
| Status/widget với heads | Còn (D9) | Giữ legacy làm oracle khi chuyển |
| Sáu harness real-Pi trong test | Còn (D10) | `planner-native`, `graph-native`, `work-native`, `case-native` đã cùng nâng timeout; gộp ở W7 |
| Đoạn K2 lặp giữa README/USAGE/STATE_STORE | Còn | README chỉ nên là tổng quan + link |
| `p2o_ledger`/`p2o_state`/`list` các tool | Giữ có chủ đích | Khác độ sâu (record đầy đủ, chỉ mục head, danh sách lọc); cần chính sách nói rõ (D12) |

---

## 5. Học từ tham chiếu

### 5.1. ARTEX: nhận, chỉnh hoặc bỏ

ARTEX là hệ thống pentest tự động (Go + Next.js, PostgreSQL). Chỉ kiến trúc workflow được dùng làm tham chiếu; không dùng bất kỳ năng lực tấn công hay dữ liệu chiến dịch nào. Số dòng theo snapshot 0.3.15.

| Chủ đề | ARTEX (nguồn tĩnh) | p2o hôm nay | Quyết định | Slice |
|---|---|---|---|---|
| Báo cáo render từ DB | `report/report.go::Markdown` (49–93), `report/findings.go::FindingsCSV` (145–168): render deterministic, sắp theo severity, CSV | Không có | **Nhận ý tưởng, đổi ngữ nghĩa:** ARTEX viết "chưa xác nhận lỗ hổng" khi rỗng, coi bản ghi là "confirmed", đặt PoC trong fence thô, CSV không chống công thức → p2o dùng nhãn claim/review/proof/currentness, không bao giờ nói "an toàn", escape đầy đủ | W5 |
| Bảng "playback" có lọc/tìm/unread | CHANGELOG 0.3.12 "探索链路播报板" (#144–#150): lọc loại, tìm từ khóa/ID, đếm bản tin mới, node ID trên mỗi dòng | `/p2o log` chỉ cursor | **Nhận** (TUI, không web) | W1, W4 |
| Tìm trace toàn task | `agent/tools.go::searchAllWorkerTraces` (1927–): trả mã định danh + tóm tắt ≤100 ký tự, loại bước của chính người gọi, mô tả tự nhận là công cụ dự phòng; kèm `list_worker_traces` | Không có | **Nhận:** trả con trỏ, drill-down riêng, gắn nhãn dự phòng | W4 |
| Điều khiển từng worker | `server/manager.go::ApplyTaskPause` (1235), `db/exploration.go::CancelIntent` (428–): tạm dừng/hủy có bảo toàn trạng thái hàng đợi | Chỉ run-level; tool của model | **Nhận bề mặt điều khiển; bỏ xóa vật lý:** `CancelIntent` xóa node con độc quyền, p2o phải append-only | W2 |
| Hàng đợi duyệt thao tác | `intercept/intercept.go` (`Decision` 285–, `HandleAsk` 584–668), schema `intercept_rules`, `intercept_pending`: allow/deny/ask, pending bền, hành động khi hết giờ | Không có | **Chỉnh, tùy chọn:** chỉ cho `p2o_http`, không timeout, không modal; **bỏ** "model thẩm phán" (mặc định `llm_judge_fail_action=allow`, tức fail-open) và việc cho người dùng tắt luật | W6b |
| Phạm vi | `guard/guard.go` ghi rõ "cơ chế RoE authorization-scope đã bị gỡ" | Scope = xác nhận của người | **Bỏ:** giữ nguyên nguyên tắc 5 | — |
| Usage theo "lane" | `llmrec/llmrec.go`, thống kê token theo planner/worker/judge trên dashboard | Không có | **Nhận phần hiển thị;** bỏ lưu toàn bộ request/response | W6a |
| Ngân sách ngữ cảnh | `sidequestion/CONTEXT_BUDGET.md`: ngân sách đầu ra riêng, cửa sổ gần đây + tóm tắt cuộn, phục hồi tràn đúng một lần, cộng dồn usage kể cả lần lỗi | Packet bounded (K6) | **Chỉ đo** (`getContextUsage()`); compaction là LLM call trả phí nên cần consent riêng | W1, W6 |
| Thông báo ra ngoài | CHANGELOG 0.3.15: outbox + lease, redact credential trong lỗi, escape markdown nội dung không tin cậy, chống SSRF | p2o đã có outbox, redaction | **Nhận bài học escape** cho export; **bỏ** push IM/webhook (extension không mở egress) | W5 |
| Phiên bản prompt | CHANGELOG 0.3.5: `reseedPlannerPrompt`/`reseedWorkerPrompt`, giữ lịch sử phiên bản | Prompt nằm trong code | **Chỉnh:** ghi `policyVersion` vào profile, đi cùng runtime digest | W0, W3 |
| Heartbeat và ép sinh ý định khi frontier rỗng | CHANGELOG 0.3.8 "停摆兜底" | Cấm (nguyên tắc 4) | **Bỏ** | — |
| Pool model, retry nhiều tầng, backoff | CHANGELOG 0.3.3 "LLM Pool", 0.3.9 "重试与退避" | Cấm (nguyên tắc 4) | **Bỏ** | — |
| Tự mở scope từ asset phát hiện được | Đã phân tích ở K0–K7 | Cấm (nguyên tắc 5) | **Bỏ** | — |
| Credential plaintext, asset toàn cục dùng chung, tự cập nhật làm gián đoạn task | README/CHANGELOG | Không | **Bỏ** | — |
| Nhập asset từ công cụ khác (ScopeSentry) | README, `skills/scopesentry` | Chỉ bundle p2o | **Để sau, tùy chọn:** danh mục do người cung cấp thành asset "declared", không mở scope | Sau W7 |

### 5.2. Pi 1.1.0: điểm tựa API (SOURCE-CONFIRMED trong `types.d.ts`)

| API | Dùng cho |
|---|---|
| `ExtensionAPI.registerToolRenderer(resolver)`, `renderCall`/`renderResult` | Thẻ gọn cho tool đọc (W1). Pi 1.0 không có: phải feature-detect |
| `ToolDefinition.promptSnippet`, `promptGuidelines`; `ToolLoadout.getPromptGuidelines` | Chính sách theo tool (W3). Chỉ dùng nếu không nhân đôi byte với `prompts.ts` |
| `ExtensionContext.getContextUsage()` (tokens, contextWindow, percent) | Đo ngữ cảnh Planner mỗi lần wake (W1, W6) |
| `ExtensionContext.compact(options)` | **Không dùng tự động** (gọi model trả phí; nguyên tắc 9) |
| `tool_execution_end.durationMs`, `agent_settled.aborted` | Thời lượng thao tác, hiển thị và usage (W1, W6) |

---

## 6. Thiết kế theo slice

Cỡ: **S** ≈ 1–3 module và vài test; **M** ≈ 4–8 module hoặc có thay đổi store/UI; **L** ≈ nhiều module, cần chiến lược cắt nhỏ. Mọi slice theo kỷ luật §12.

### W0. Toàn vẹn runtime và dọn nền (S; đã làm một phần)

**Đã làm trong working tree (chưa commit):** gộp helper trùng (`src/validate.ts`); `registerExecTool`; nâng timeout test (`testTimeout` 10→60 s, RPC/polling real-Pi →60 s, giới hạn từng test real-Pi →180 s; vẫn có trần để deadlock thật không treo vô hạn); cập nhật README/USAGE/KNOWLEDGE_WORKSPACE; `npm test` exit 0 sau thay đổi.

**Còn lại:**

- **Runtime closure digest (D1).** `runtimeDigest(packageRoot)` băm theo thứ tự byte của đường dẫn tương đối: `extensions/p2o/index.*` + `src/**/*.{ts,js}` + trường `version` của `package.json`. Không băm `skills/`, `HANDOFFS.md` (đã có hash riêng trong method receipt, `TASK_METHOD_STALE`). Không phụ thuộc đường dẫn tuyệt đối/mtime; từ chối symlink; giới hạn số file/kích thước; **fail closed** nếu không đọc được. Dùng cho: cổng ticket, `profile.runtimeHash`, `extensionSha256` (giữ tên trường, thêm `runtimeDigestVersion: 2`). Ticket digest cũ bị từ chối rõ ràng (đúng với quy ước "stop assessment trước khi reload").
- **Hiển thị danh tính:** `/p2o status` và hộp xác nhận hiện `p2o <version> · runtime <12 hex>`.
- Mô tả `p2o_shell`/`p2o_net` còn nhắc trần 60 s/300 s đã bỏ và không nhất quán: sửa ở W3 cùng đợt gọn khai báo.

**Gate:** F-W0-1…5 (§14), `npm test`, installed acceptance sau khi publish (W8).

**Rủi ro:** test dùng đường dẫn extension giả (`extensionPath` fixture) cần suy ra package root đúng; layout `dist/`; chi phí đọc ≈46 file mỗi lần start run/worker (nhỏ, đo khi làm).

### W1. Quan sát cho người dùng (S–M; chỉ đọc, không gọi model)

- **`/p2o log [cursor] [task=<id>] [actor=<id>] [operation=<id>]`.** Dùng sẵn `AssessmentStore.events()`; id kiểm bằng `validId`; "Next:" mang theo bộ lọc; tổng/omitted đúng theo bộ lọc. Dấu "N sự kiện mới từ lần xem trước" lưu trong bộ nhớ phiên, không phải authority.
- **Bảng worker** trong `/p2o status` và widget: id, role, task, trạng thái, lệnh đã dùng/ngân sách, tuổi hoạt động cuối, cờ `quiet` (từ `progress.view`, cửa sổ 120 s). `quiet` **không** phải timeout, không đánh thức model, không kết luận worker chết.
- **Thẻ render gọn** (`registerToolRenderer`, feature-detect Pi ≥1.1) cho tool đọc `p2o_ledger`, `p2o_state`, `p2o_graph view/page`, `p2o_case|coverage|plan list/view`, `p2o_workers`; mở rộng khi cần. **Nội dung gửi model không đổi** (golden).
- **Dòng ngữ cảnh/chi phí** (`getContextUsage()` mỗi lần Planner wake, thời lượng thao tác từ `durationMs`): ghi dạng bộ đếm vào provenance của vòng; thiếu dữ liệu = `unknown`.

**Không làm:** dashboard web, thông báo ra ngoài, gọi model để tóm tắt.

**Gate:** F-W1-1…6. **Rủi ro:** độ rộng widget, Unicode/resize (đã có test `refresh`/`visibility`), tương thích Pi 1.0.

### W2. Điều khiển cho người dùng (M; an toàn vận hành)

- `/p2o workers` (đọc).
- `/p2o stop-worker <worker-id> [reason]` (xác nhận): đi cùng đường với tool `p2o_stop_worker` (revoke ticket → hủy in-flight → đóng pane → verify); task chuyển theo luật hiện hành; record `by: human`; cảnh báo khi executor shared (hủy có thể ảnh hưởng peers).
- `/p2o hold [reason]` và `/p2o release`: **cờ `held`** chặn lệnh target mới (`exec`/`net`/`http`/`capture`) ở `prepareCommand`/`beforeCommand` của broker và ở đường solo; `spawnWorker` trả `OPERATOR_HOLD`; đường báo cáo/điều khiển/cleanup vẫn mở (`p2o_report`, `/p2o stop`). Mặc định lệnh **đang chạy tiếp tục** đến khi xong (không mất dữ liệu); tùy chọn hủy in-flight. Khác `pause` (dừng lập lịch và wake) và `stop` (kết thúc run): bảng so sánh vào USAGE.
- Ghi sự kiện bền cho hold/release/stop-worker (thêm kind vào `EVENT_KINDS`; không đổi SQL schema). Widget hiện `HOLD: <lý do>`.
- **Không có** tool nào để model gọi `hold`/`release` (nguyên tắc 14); `/p2o stop-worker` của người dùng chung đường dừng với tool `p2o_stop_worker` sẵn có. `/p2o steer` do người gửi: để ngỏ ở §11.

**Gate:** F-W2-1…6. **Rủi ro:** TOCTOU giữa hold và admit (đóng bằng kiểm tra trong `prepareCommand` + test đua), executor dùng chung, nhầm lẫn pause/hold/stop.

### W3. Chính sách workflow, admission đồng nhất, gọn khai báo (M; cần đo có ủy quyền)

- **Chính sách workflow ≤≈1,2 KB cho Planner và ≤≈0,8 KB cho worker** (không viết thành sổ tay tham số): `p2o_task match` trước dispatch; sau review báo cáo thì dựng/sửa case bằng `p2o_case` từ revision đúng; giữ denominator bằng `p2o_coverage` để blocked/untested không bị tóm thành clean; ghi tài nguyên/fact có provenance bằng `p2o_graph` (worker ghi asset/fact/anchor, owner giữ hypothesis/relation); tra `p2o_state`/`p2o_ledger` trước khi lặp việc; coverage note của worker là bản tóm tắt legacy nuôi cell của owner; điều kiện kết thúc (không còn case chờ review/stale, hoặc liệt kê như gap). Worker: dùng `p2o_capture` cho output dài trong scratch.
- **`policyVersion`** là hằng trong `prompts.ts`, đi cùng runtime digest và được ghi vào profile (D2, W0).
- **`p2o_delegate` đồng nhất admission (D3):** tham số `work` tùy chọn (dùng chung schema với `p2o_task create`); có `work` thì chạy cùng kiểm tra exact/overlap/history như `p2o_task`; không có thì kết quả trả `workMatch: 'unknown'` và ghi sự kiện `delegate.unstructured`, không bịa fingerprint. Vẫn tương thích.
- **Gọn khai báo (D6):** (1) bỏ câu thừa/lỗi thời (trần 60/300 s, câu lặp giữa `p2o_task/case/coverage/plan`) bằng hằng chia sẻ; (2) schema gốc thô hơn cho `p2o_graph`, `p2o_task`, `p2o_case`, `p2o_coverage` **chỉ** nếu validator ở host đã chặt tương đương (phải chứng minh bằng test, không giả định); (3) guard ngân sách byte theo loadout. Mục tiêu tạm: Planner delegated ≤≈28 KB (−20%), **UNVERIFIED về khả thi**.
- `promptSnippet`/`promptGuidelines`: chỉ thêm nếu đo cho thấy không nhân đôi byte với `prompts.ts`.

**Không làm:** dùng prompt thay cổng broker; bất kỳ thay đổi nào về authority/scope.

**Gate cơ chế:** F-W3-1…5 (guard "mọi tên tool trong prompt tồn tại và mọi tool K3–K6 được nhắc hoặc có lý do miễn", ngân sách byte, admission). **Gate hiệu quả:** benchmark có ủy quyền ở W8; trước đó W3 không được mô tả là "cải thiện kết quả".

**Rủi ro:** đổi hành vi model, không kiểm chứng được bằng test inert; khai báo thô hơn làm tăng tỉ lệ gọi tool sai (đo ở W8).

### W4. Truy hồi và tái sử dụng (M; cần spike như K0)

- Chỉ mục văn bản **dẫn xuất, dựng lại được** (cùng triết lý heads của K6) trên text đã redact của record và artifact. Ứng viên: SQLite FTS5 tokenizer `trigram` (đã xác nhận có trên Node 24.19.0/SQLite 3.53.4; **chưa xác nhận trên Node 22.19**). Cần store schema 8 cho run mới; run schema ≤7 giữ chỉ-đọc, không migrate tại chỗ. Phương án B nếu spike không đạt: quét có giới hạn từ `recordsSince`, gắn nhãn partial.
- API: `p2o_state {action:'search', q, domains?, limit≤20}` (chỉ đọc; lead và worker, kể cả reporting) trả `{id, kind, actorId, taskId?, sequence, snippet≤100}` + total/omitted chính xác; drill-down bằng `p2o_ledger`/`p2o_artifact`. Mô tả ghi rõ là công cụ dự phòng sau `heads`/`ledger`. Người dùng: `/p2o search <text> [cursor]`.
- Truy vấn là chuỗi thường, được escape (không nhận toán tử FTS/SQL từ model); kết quả là dữ liệu không tin cậy.

**Không làm:** index bytes chưa redact; kết quả tự thành bằng chứng hay quyền.

**Gate:** F-W4-1…5; p95 mục tiêu <200 ms @100k record (**UNVERIFIED** đến khi đo). **Rủi ro:** phình kích thước, ghi thêm trong transaction commit nóng, thay đổi schema.

### W5. Sản phẩm cuối tất định (M)

- **`/p2o report export <absolute-dir>`** (người dùng, xác nhận; ngoài private state root; không ghi đè; thư mục tạm 0700 → fsync → rename, tái dùng cơ chế `exportBundle`): `REPORT.md`, tùy chọn `cases.csv`, `coverage.csv`, `manifest.json` (hash từng file, `asOfSequence`, runtime digest).
- Nội dung: profile và scope đã xác nhận; trạng thái toàn vẹn/`dataStatus` và diagnostics; case accepted-current (verdict, mức proof, evidence → artifact ID, giới hạn, trục remediation); case pending/disputed/stale/withdrawn tách riêng; ma trận coverage với blocked/untested **đứng trước**; open gaps; chỉ mục task/handoff (reported ≠ reviewed); tóm tắt worker/operation; mục "báo cáo này **không** là gì" (không phải verification, không phải bảo đảm an toàn; redaction best effort).
- **Tất định:** cùng `asOfSequence` và cùng code → cùng byte; không đưa giờ hệ thống vào thân báo cáo.
- **Ngữ nghĩa:** danh sách rỗng ghi "không có case được chấp nhận tại sequence N; xem coverage và gap; thiếu phát hiện không phải bằng chứng an toàn".
- **Vô hiệu hóa markup** (nguyên tắc 13): fence dài hơn mọi chuỗi backtick trong nội dung, bỏ link/ảnh/autolink/HTML/`javascript:`, bỏ control/bidi/ANSI, CSV chặn công thức đầu ô; giới hạn độ dài dòng.
- Cho phép xuất từ store historical chỉ-đọc (chỉ đọc, không ghi vào store): chờ xác nhận ở §11.

**Gate:** F-W5-1…6 (tái dùng harness lỗi ENOSPC của bundle). **Rủi ro:** nhãn sai ngữ nghĩa (dùng fixture stale/disputed/duplicate của K5), kích thước ở 100k record (phân trang/giới hạn đếm).

### W6. Chi phí và (tùy chọn) chính sách mutation

**W6a: hiển thị usage (M).** Owner cộng `usage` từ `message_end`; worker gửi op `usage` qua broker (xác thực, giới hạn tần suất, chỉ bộ đếm). Hiển thị theo role/actor trong `/p2o status`: token vào/ra/cache, số vòng Planner trên allowance, % ngữ cảnh. **Không cap**, không chặn. Thiếu usage = `unknown`; worker bị kill giữ phần đã báo. Sự kiện `usage.reported` bị giới hạn (không mỗi token).

**W6b: chính sách mutation và loại trừ cho `p2o_http` (tùy chọn, cần quyết định sản phẩm; D13).** `--mutations allow|ask|deny` (mặc định `allow` = hành vi và câu chữ consent hiện tại) và danh sách loại trừ host/CIDR cho redirect/origin. `ask` tạo pending bền, **không timeout**, duyệt không modal bằng `/p2o approvals`, `/p2o approve <id>`, `/p2o deny <id>`; `stop` hủy mọi pending; worker chỉ nhận mã lỗi. **Không phải egress firewall:** `p2o_shell`/`p2o_net` không bị chặn và tài liệu phải nói thẳng điều đó.

**Gate:** F-W6-1…5. **Rủi ro:** `ask` trong chạy không giám sát thành "human-needed" (dùng `problem()` notify sẵn có); người dùng hiểu nhầm là boundary.

### W7. Quy mô, cấu trúc, khử trùng lặp (M–L; xen kẽ, mỗi lần một PR nhỏ)

1. Đếm status từ heads/SQL sau oracle differential (giữ projection legacy làm oracle trong test; seed corpus, mọi batch prefix) → bỏ read-model thứ hai dần (D9).
2. Đo TUI render p95; replay lớn hỗn hợp graph/case/review ở 10k/100k; archive/checkpoint segmented >64 MiB (bundle v3); các hardening bundle (ancestor, TOCTOU, atomic import một phần, độ nhạy foreign); affected-variant policy của case.
3. **Tách `extensions/p2o/index.ts`** theo strangler: adapter hai đường truyền `defineTool({name, schema, owner, worker})` (xóa nhánh owner/worker lặp, D10), module lifecycle, lệnh, hook; mỗi bước giữ **snapshot khai báo tool byte-identical** và toàn bộ test; mục tiêu ≤≈600 dòng cho file vào.
4. Harness test real-Pi dùng chung (`tests/minimal/helpers/real-pi.ts`) để timeout nằm ở một chỗ.
5. README gọn thành tổng quan + link; đoạn K2 chỉ sống ở USAGE/STATE_STORE.

**Gate:** F-W7-1…3. **Rủi ro:** chạm vùng lifecycle HIGH (`refreshVisibility` đã HIGH khi sửa trước đó); impact `UNKNOWN` ở `src/` nên phải dựa text search và test.

### W8. Acceptance có chứng nhận, release, đo hiệu quả (cần ủy quyền cho phần trả phí/Herdr)

- Sau W0–W2 (và W5): version **0.6.0**, `CHANGELOG.md`, git tag (người dùng thực hiện); cập nhật với `PI_OFFLINE` bỏ đặt; kiểm revision và byte bằng closure digest; chạy 6 test inert trên bản cài; Docker opt-in; `npm run test:herdr` (**cần đồng ý**, mở/đóng pane trong session Herdr đang dùng).
- Ma trận installed theo từng requirement; ma trận provider/version cho stop races.
- **Giao thức benchmark có ủy quyền** (trả phí, chỉ trên target thuộc quyền người dùng): các nhánh baseline `7e204c3` / +W3 chính sách / +W3 gọn khai báo; cùng model, scope, budget; chạy lặp; control giữ lại; chấm độc lập; chỉ số gồm các mục §13.2 cộng tỉ lệ gọi tool hợp lệ và token/cost trên mỗi case được chấp nhận; báo cả **false suppression**. Dùng harness `bench/` sẵn có. **Không chạy khi chưa có ủy quyền.**

---

## 7. Thứ tự, phụ thuộc và MVP

```text
W0 ──┬─> W1 ──> W2 ──> W5 ──> W8 (release 0.6.0)
     ├─> W3 (cơ chế)  ·····> W8 (đo hiệu quả, có ủy quyền)
     └─> W4 (sau spike) ──┐
W6a (sau W1) ─────────────┴─> W8
W7: xen kẽ, một PR nhỏ mỗi slice, không chặn các slice khác
W6b: chỉ khi được duyệt
```

- **W0 trước hết:** sửa lỗ toàn vẹn rẻ, làm digest dùng được cho mọi receipt sau.
- **W1 trước W2:** W2 dùng chung bảng worker và sự kiện.
- **W3 cơ chế** có thể song song vì không phụ thuộc UI; phần "hiệu quả" chỉ chốt được ở W8.
- **W5 độc lập** sau W0; đáng làm sớm vì là thứ người dùng mang đi.
- **W4 cần spike** (FTS5 trên Node 22.19; ảnh hưởng schema 8) nên đặt sau.
- **MVP không đổi hành vi model:** W0 + W1 + W2 + W5.

---

## 8. Chi phí ngữ cảnh và hiệu năng

**M1: chi phí cố định mỗi request (MEASURED 2026-10-10; byte, không phải token; nạp cả khai báo lẫn chính sách):**

| Loadout | Số tool | Khai báo (B) | Chính sách (B) |
|---|---|---|---|
| Planner delegated | 18 | 35.514 | 5.488 |
| Owner solo | 22 | 39.904 | 5.085 |
| Worker (recon/discovery/validation/general) | 14 | 20.458 | ≈5.935 (5.934–5.939 theo role) |
| Worker reporting | 9 | 13.627 | 5.546 |

Tool lớn nhất theo khai báo: `p2o_graph` 7.248 (mô tả 896 + schema 6.301), `p2o_task` 5.816, `p2o_case` 4.697, `p2o_coverage` 4.403, `p2o_plan` 2.710, `p2o_candidate` 2.441, `p2o_delegate` 1.806, `p2o_http` 1.751, `p2o_report` 1.630. Tổng 24 tool = 42.306 B. Mỗi worker mới còn inline tối đa 3 skill (21 file `SKILL.md`: ≈5,0–9,5 KB, trung vị ≈6,8 KB) và brief.

**DESIGN-INFERENCE:** prompt caching của provider có thể giảm *tiền* cho phần lặp lại nhưng không giảm mức chiếm cửa sổ ngữ cảnh; Planner chạy trong chính phiên của người dùng nên lịch sử chat các vòng tích lũy và do cơ chế compaction của Pi xử lý. Vì vậy W1 chỉ **đo** (`getContextUsage()`), không tự compaction.

**M1b: sau W3/W4 (MEASURED 2026-10-10, cùng phương pháp):** khai báo Planner delegated 36.268 B (+2,1% so với 35.514), owner solo 40.603 B (+1,8%), worker 20.750 B (+1,4%), reporting 13.974 B (+2,5%); guidance gắn theo tool 1.003 / 1.100 / 314 / 217 B. Phần tăng đến từ `work/decision/outputContract` của `p2o_delegate` (+≈0,4 KB) và `search` của `p2o_state` (+≈0,35 KB); bớt các trần 60 s/300 s đã lỗi thời giảm ≈55 B. **Mục tiêu ≤≈28 KB không đạt:** muốn đạt phải làm schema thô hơn cho `p2o_graph/task/case/coverage`, và chưa có bằng chứng validator host tương đương nên chưa làm. Guard `workflow-policy.test.ts` ghim các số này (+2%).

**Mục tiêu (PROPOSED):**

| Chỉ số | Hiện tại | Mục tiêu |
|---|---|---|
| Khai báo Planner delegated | 36.268 B (sau W3/W4; 35.514 B trước giai đoạn W) | ≤≈28 KB (**UNVERIFIED** khả thi, chưa đạt); guard: không tăng quá +2% mỗi slice nếu không có ngoại lệ có lý do |
| Guidance thêm bởi W3 (theo tool) | 1.003 B Planner / 314 B worker (đạt) | ≤≈1,2 KB Planner, ≤≈0,8 KB worker |
| Status/widget refresh p95 @100k | ≤114 ms | giữ <200 ms; mục tiêu mới sau W7: không phụ thuộc kích thước snapshot |
| Tìm kiếm p95 @100k (W4) | ≈18,3 ms (10k: ≈5,6 ms), corpus synthetic, quét có giới hạn | <200 ms (đạt trên corpus synthetic) |
| Export báo cáo @100k (W5) | n/a | công bố số đo cùng corpus và phần cứng; không đặt mục tiêu trước khi đo |
| Overhead usage (W6a) | 1 op broker (fire-and-forget) mỗi message assistant mỗi worker, chỉ bộ đếm | ≤1 op broker mỗi message assistant mỗi worker, chỉ bộ đếm (đạt) |

---

## 9. An toàn cho các bề mặt mới

| Bề mặt | Mối đe dọa | Biện pháp |
|---|---|---|
| W0 digest | Đọc ngoài root, symlink, file quá lớn, digest rỗng khi lỗi | Root cố định, từ chối symlink, giới hạn, fail closed |
| W1 log/render | Nội dung target/model chứa ANSI, markup, ký tự điều khiển | Dùng `cleanText`/`redact` hiện có; cắt theo độ rộng; renderer không đổi dữ liệu gửi model |
| W2 hold/stop-worker | Model hoặc worker tự gỡ hold, vượt cờ bằng ticket cũ | `hold`/`release` chỉ của người; cổng ở broker (không ở UI); đường báo cáo/cleanup luôn mở; test đua admit/hold |
| W3 chính sách | Prompt bị coi là cổng bảo mật | Giữ nguyên tắc: cổng ở broker/host; prompt chỉ là chính sách vận hành |
| W4 tìm kiếm | Lộ secret qua index, injection qua cú pháp truy vấn | Chỉ index text đã redact; escape toàn bộ truy vấn; kết quả là dữ liệu không tin cậy |
| W5 export | Markup/CSV từ target thành link, ảnh, công thức; ghi đè/rò file | Nguyên tắc 13; đường dẫn tuyệt đối ngoài state root, không ghi đè, quyền 0700/0600, rename nguyên tử |
| W6a usage | Số liệu giả hoặc bị worker làm sai lệch | Chỉ bộ đếm, xác thực qua broker, giới hạn tần suất; `unknown` không phải 0 |
| W6b mutation | Hiểu nhầm là egress firewall; `ask` bị worker giả mạo | Tài liệu nói rõ phạm vi; ID pending không đoán được; worker chỉ nhận mã lỗi |

---

## 10. Migration, tương thích và kỷ luật release

1. **Store:** W4 là slice duy nhất cần schema 8, chỉ cho run mới; run schema 3–7 giữ nguyên tắc "inspect chỉ đọc, không migrate tại chỗ". Thêm event kind chỉ đổi hằng `EVENT_KINDS` (không CHECK ở SQL), vẫn cần test replay/checkpoint tail.
2. **Ticket/digest:** W0 làm ticket phiên bản cũ bị từ chối; chấp nhận được vì quy ước đã yêu cầu stop assessment trước khi reload.
3. **Pi:** tính năng 1.1 phải feature-detect. README hiện chỉ tuyên bố đã kiểm trên 1.1.0 (bộ 388 test và kiểm tra bản cài chưa chạy lại trên 1.0.0). Cần quyết định: bỏ 1.0.0 khỏi tuyên bố hay thêm dry run cô lập 1.0.0 (§11).
4. **Release:** tag + `CHANGELOG.md` + version hiển thị trong `/p2o status`; cập nhật bản cài luôn với `PI_OFFLINE` bỏ đặt cho riêng lệnh đó và kiểm revision/byte, không tin thông báo "Updated".
5. **Acceptance lịch sử** (6 receipt 0.5.0, `installed.json`, các receipt K) giữ nguyên; receipt mới ở thư mục/tên khác.
6. **Rollback:** stop, giữ store chỉ-đọc, chạy lại run mới với cấu hình trước đó; bản cũ không đọc được schema mới phải báo unsupported, không xóa file.
7. Commit theo slice; `detect_changes` trước commit; `git log` kiểm không có dòng attribution trước khi push.

---

## 11. Câu hỏi mở và quyết định cần người dùng

1. **Thứ tự và MVP:** duyệt W0 → W1 → W2 → W5 làm MVP không đổi hành vi model?
2. **W6b (mutation/loại trừ cho `p2o_http`):** làm hay không? Nếu làm, mặc định `allow` có chấp nhận được không?
3. **Version 0.6.0 và CHANGELOG:** bump ngay sau W0 hay sau W2/W5?
4. ~~Ủy quyền benchmark trả phí cho W3~~ — **đã trả lời** (người dùng cho phép đo benchmark trả phí bình thường): chạy 2026-10-10 với trần chi phí, xem §0.2; kết quả khiến guidance **tắt mặc định**. Còn mở: có muốn benchmark lớn hơn (nhiều lần lặp, model khác, thinking cao, fixture phức tạp) không?
5. **Hỗ trợ Pi 1.0.0:** tiếp tục tuyên bố hay chỉ 1.1.0?
6. **`hold` mặc định:** để lệnh đang chạy hoàn tất (đề xuất) hay hủy in-flight?
7. **Xuất báo cáo từ store historical chỉ-đọc:** cho phép (đề xuất, vì chỉ đọc) hay giữ như bundle (chỉ run đang active)?
8. **Tìm kiếm (W4):** chấp nhận store schema 8 cho run mới, hay chỉ làm quét có giới hạn không đổi schema?
9. **`/p2o steer <worker> <text>` do người gửi:** có cần không (rủi ro: tăng bề mặt chỉ dẫn vào worker)?
10. **Danh mục asset do người cung cấp** (kiểu ScopeSentry của ARTEX) thành asset "declared": có muốn sau W7 không?

---

## 12. Kỷ luật triển khai cho mỗi slice

1. GitNexus `impact` cho từng symbol sửa; ghi `UNKNOWN` và caller xác nhận bằng text search; cảnh báo HIGH/CRITICAL (ví dụ `refreshVisibility`).
2. Viết test trước hành vi; guard mới phải qua mutation check trên bản sao cô lập; thay một phép tính bằng phép tính khác phải có oracle differential.
3. Cập nhật contract tương ứng, USAGE/README (chỉ phần cần), và mục verification trong `docs/KNOWLEDGE_WORKSPACE.md` (kèm lần fail đầu nếu có).
4. Khi một scenario của §14 có test thật thì thêm vào `docs/ACCEPTANCE_MATRIX.md` và mở rộng guard; không thêm hàng chưa có test.
5. `npm test` + bộ opt-in liên quan (Docker); Herdr thật và trả phí **chỉ khi có đồng ý riêng**.
6. `detect_changes` trước commit; commit/push/install chỉ khi được yêu cầu; không dòng attribution AI.
7. Sau publish: cập nhật bản cài (bỏ `PI_OFFLINE` cho riêng lệnh), kiểm revision + byte, chạy test inert trên bản cài; ghi receipt mới.

---

## 13. Acceptance matrix: baseline K0–K7, không được regress

Mọi slice W phải giữ nguyên các fixture và điều kiện dưới đây ([ACCEPTANCE_MATRIX](docs/ACCEPTANCE_MATRIX.md) ánh xạ từng hàng tới test thật và có guard tự động). Fixture mới của giai đoạn này ở §14.

### 13.1. Fixture scenarios bắt buộc (baseline K0–K7, không được regress)

| Case | Kỳ vọng |
|---|---|
| Start chưa có task/asset | Empty state nói đúng, không giả 0 bugs = safe |
| Worker làm lâu, chưa có result | Hiện running op/start time; không timeout vì quiet và không model polling |
| Hai workers ghi cùng endpoint | Một asset ID, hai provenance entries, count không tăng đôi |
| Hai task aliases cho cùng work | Exact known identity conflict ở reserve; fuzzy trường hợp unknown đưa review |
| Same endpoint khác method/actor/tenant | Không collapse thành cùng security test |
| Handoff committed, chưa review | `reported / awaiting review`, không completed goal |
| Worker provider-error/no report | Partial lifecycle packet, gap retained, không cần model retry để có output |
| Report ACK mất rồi submit lại | Một canonical packet/event effect, không nhân coverage/open/finding |
| Crash giữa report parts/domain writes | Chỉ committed transaction hiển thị complete; partial có diagnostics |
| Stop khi operation in flight | Revoke/abort giữ nguyên; checkpoint ghi cancellation/unknown, không fabricated output |
| Disk full lúc checkpoint/export | No success claim, no authority extension, rõ retained/missing data |
| Reload/tree/fork đọc checkpoint | Chỉ historical state; không broker/ticket/container/network/model turn mới |
| Old review bị superseded | Dependent task/candidate/report/digest stale đúng IDs/revisions |
| Independent validator bị withdraw | Independent badge mất hiệu lực; history không bị xóa |
| Out-of-scope asset từ response | Có thể ghi observation ngoại vi, không dispatch/probe hay auto-widen scope |
| Artifact symlink/path traversal/secret | Denied/redacted theo policy, không leak host files hoặc raw token |
| Same content event delivered N lần | UI merge theo ID/sequence, không N phase cards |
| History vượt display windows | Exact totals + omitted + drill-down; old blockers vẫn tìm được |
| Manual mode event storm | Zero automatic paid requests; UI vẫn update |
| Event-driven pause/stop race | Late wake veto, no dispatch after pause/stop; human pending input priority |
| Normalization adversarial set | Path case, query repeats/order, `%2F`, trailing slash, IPv6, custom method không merge sai |
| Negative result reused | Chỉ cùng tested context/method/version; không biến thành global “clean” |

### 13.2. Measurements: đã có và mục tiêu mới

Đã đo (synthetic, không phải hiệu quả pentest; phương pháp và giới hạn ở docs tương ứng):

| Số đo | Kết quả | Nguồn |
|---|---|---|
| Status/widget refresh p95 @100k (simple / mixed) | 114,01 / 110,31 ms (full rescan trước đó 580–642 / 620–668 ms) | `scripts/check-assessment-status.mjs`, KNOWLEDGE_WORKSPACE |
| Live heap giữ lại | ≈16 MiB @10k, ≈80 MiB @100k | CONTEXT_PACKETS |
| Event page p95 / checkpoint / RSS @100k | 13,49 ms / ≈498 ms / ≈435 MB | STATE_STORE |
| Graph 4000 asset: page / history / export p95, checkpoint | 2,89 / 0,76 / 6,32 ms; 475,53 ms | ASSET_GRAPH |
| Khai báo + chính sách theo loadout | §8, M1 | probe 2026-10-10 |

Phương pháp giữ nguyên: corpus deterministic 10k/100k, công bố phần cứng và corpus; báo p50/p95, RSS, kích thước on-disk; không lược bỏ dữ liệu rồi vẫn ghi "complete"; dedup phải báo cả suppression đúng lẫn **false suppression**; inert fixture chỉ chứng minh cơ chế, còn "pentest tốt hơn" cần benchmark có ủy quyền (cùng model/scope/budget, chạy lặp, control giữ lại, chấm độc lập), **chưa được thực hiện**. Mục tiêu mới nằm ở §8.

### 13.3. Không đạt acceptance nếu

- Có graph nhưng không trả lời được “task nào chưa review, vì sao blocked, output ở đâu”.
- Checkpoint chỉ là model summary không có snapshot/version/refs.
- Finish xóa toàn bộ result mà user tưởng đã lưu.
- Graph dữ liệu được coi như authorization hoặc replay history tự chạy lại request.
- Mọi `confirmed` đều lên badge verified, hoặc “100% coverage” dựa touched assets.
- Dedup suppress validator/retest hoặc merge hai bug chỉ vì cùng CWE/title.
- Thêm background LLM hay đổi budgets/mode mà confirmation không nói.

---

## 14. Acceptance của giai đoạn W (PROPOSED; phần đã có test được ánh xạ ở ACCEPTANCE_MATRIX)

Các mã đã có test thật nằm ở mục "Giai đoạn W" của [ACCEPTANCE_MATRIX](docs/ACCEPTANCE_MATRIX.md) (có guard tự động); các mã còn lại ở bảng dưới **chưa có test**. Chỉ chứng minh cơ chế bằng fixture inert; hiệu quả pentest, Herdr thật và chi phí thật cần ủy quyền riêng (W8).

| Mã | Slice | Case | Kỳ vọng |
|---|---|---|---|
| F-W0-1 | W0 | Sửa một byte trong `src/` (không đụng `index.ts`) giữa lúc owner bắt đầu và lúc spawn worker | Worker bị từ chối ở cổng ticket (runtime mismatch); không lệnh target; lý do được ghi |
| F-W0-2 | W0 | Hai cây source giống hệt ở hai đường dẫn | Digest bằng nhau, độc lập mtime và đường dẫn tuyệt đối; thứ tự file ổn định |
| F-W0-3 | W0 | Layout `dist/` và layout source; symlink trong closure | Closure đúng cho cả hai; symlink bị từ chối; không đọc ngoài package root |
| F-W0-4 | W0 | Không đọc được một file trong closure | Run không bắt đầu (fail closed); không có digest rỗng |
| F-W0-5 | W0 | Ticket mang digest phiên bản cũ | Bị từ chối rõ ràng, không nâng cấp ngầm |
| F-W1-1 | W1 | `/p2o log task=<id>` / `actor=<id>` với 3 worker, 10k và 100k event | Total/omitted chính xác theo bộ lọc, cursor ổn định, dùng index (kiểm kế hoạch truy vấn), không model call |
| F-W1-2 | W1 | Bộ lọc có id sai định dạng hoặc chứa ký tự injection | Bị từ chối trước khi truy vấn |
| F-W1-3 | W1 | Worker im lặng quá cửa sổ yên lặng | Status/widget hiện `quiet`; không timeout, không wake, không polling model |
| F-W1-4 | W1 | Widget với 3 worker ở 80 cột | Không quá 5 dòng, không tràn ngang, Unicode/resize đúng |
| F-W1-5 | W1 | Renderer bật/tắt; Pi không có `registerToolRenderer` | `content` gửi model giống hệt (golden); thiếu API thì bỏ qua im lặng |
| F-W1-6 | W1 | Planner wake | `getContextUsage()` ghi như bộ đếm vào provenance của vòng; thiếu dữ liệu ghi `unknown` |
| F-W2-1 | W2 | `/p2o stop-worker` khi worker có lệnh đang chạy | Ticket revoke, in-flight hủy, pane đóng và verify, task chuyển đúng, record `by: human`; cảnh báo peers khi shared |
| F-W2-2 | W2 | `hold` trong lúc worker gọi `exec`/`net`/`http`/`capture` | Lệnh mới bị từ chối `TARGET_OPS_HELD` và không trừ budget; lệnh đang chạy hoàn tất; `p2o_report` vẫn gửi được |
| F-W2-3 | W2 | `hold` rồi Planner gọi `p2o_delegate`/dispatch, hoặc event-driven wake | Từ chối `OPERATOR_HOLD`; không dispatch |
| F-W2-4 | W2 | `hold` rồi `/p2o stop` | Cleanup bình thường, không kẹt |
| F-W2-5 | W2 | Model cố `hold` hoặc `release` | Không có tool nào; chỉ người. `p2o_stop_worker` của model vẫn dùng chung đường dừng worker với lệnh của người |
| F-W2-6 | W2 | Đua: `hold` đồng thời với admit/command | Không lệnh target mới nào chạy sau khi `hold` được ghi nhận |
| F-W3-1 | W3 | Guard prompt↔tool | Mọi tên `p2o_*` trong prompt tồn tại trong `ALL_TOOLS`; mọi tool K3–K6 được nhắc hoặc có lý do miễn; lệch thì fail |
| F-W3-2 | W3 | Ngân sách khai báo theo loadout | Vượt ngân sách (+2% headroom) thì fail; ngoại lệ phải có lý do trong test |
| F-W3-3 | W3 | `p2o_delegate` có `work` trùng task đang active | `ASSIGNMENT_CONFLICT`/`already_covered_by` như `p2o_task` |
| F-W3-4 | W3 | `p2o_delegate` không `work` | Kết quả có `workMatch: 'unknown'`, có sự kiện `delegate.unstructured`; không bịa fingerprint |
| F-W3-5 | W3 | Đổi `policyVersion` | Runtime digest đổi; profile/checkpoint ghi version |
| F-W4-1 | W4 | Tìm kiếm | Total/omitted đúng, ≤ limit, snippet ≤100, cursor ổn định |
| F-W4-2 | W4 | Secret đã redact trong output | Không tìm thấy trong index |
| F-W4-3 | W4 | Dựng lại index từ checkpoint + tail | Giống index live |
| F-W4-4 | W4 | FTS5 không có | Fallback có giới hạn, nhãn partial rõ |
| F-W4-5 | W4 | Truy vấn chứa toán tử FTS/SQL | Được escape; không lỗi cú pháp; không lộ dữ liệu ngoài run |
| F-W5-1 | W5 | Xuất hai lần cùng `asOfSequence` (hai thư mục tạm khác nhau) | Byte giống hệt |
| F-W5-2 | W5 | Corpus markup/CSV/ANSI/bidi từ target | Không tạo link, ảnh, HTML, công thức hoạt động; fence không bị thoát |
| F-W5-3 | W5 | Run rỗng hoặc chỉ có gap | Không có câu "không có lỗ hổng"; nêu coverage, gap, giới hạn |
| F-W5-4 | W5 | Case stale/disputed/duplicate/withdrawn | Gắn nhãn đúng; không vào "accepted-current" |
| F-W5-5 | W5 | ENOSPC ở mọi lần ghi file | Không thư mục đích, không manifest, không thư mục tạm (tái dùng harness `bundle-fault`) |
| F-W5-6 | W5 | Xuất từ store historical chỉ-đọc (nếu được duyệt) | Store không bị ghi; kết quả giống run đang active cùng sequence |
| F-W6-1 | W6a | Cộng usage | Tổng theo role = tổng usage các message của fixture; thiếu usage là `unknown`, không phải 0 |
| F-W6-2 | W6a | Worker bị kill giữa chừng | Giữ usage đã báo; không bịa phần còn lại |
| F-W6-3 | W6a | Không cap | Không đường code nào từ chối hay ngắt vì usage (kiểm tĩnh + hành vi) |
| F-W6-4 | W6b | `--mutations deny` | Request đổi trạng thái bị từ chối trước khi gửi và được ghi; tài liệu/hộp xác nhận không nhận là chặn `p2o_shell`/`p2o_net` |
| F-W6-5 | W6b | `ask` | Pending bền, không timeout; `stop` hủy; worker chỉ nhận mã lỗi, không nhận quyền |
| F-W7-1 | W7 | Đếm từ heads/SQL so với legacy | Giống hệt trên corpus seed, mọi batch prefix |
| F-W7-2 | W7 | Tách module/adapter hai đường truyền | Snapshot khai báo tool byte-identical; toàn bộ test pass; file vào ≤≈600 dòng |
| F-W7-3 | W7 | TUI render và replay lớn ở 10k/100k | Số đo công bố kèm corpus/phần cứng; không vượt ngân sách |
| F-W8-1 | W8 | Bản cài sau publish | Closure digest và byte giống source; 6 test inert trên bản cài pass |
| F-W8-2 | W8 | Benchmark có ủy quyền | Chỉ chạy khi được ủy quyền; báo cả false suppression, tỉ lệ gọi tool hợp lệ và token/cost |

### 14.1. Không đạt acceptance của giai đoạn W nếu

- Lệnh nới lỏng hoặc ghi ra host của người (`hold`/`release`, `approve`, `report export`) có thể bị model gọi, hoặc worker vượt qua được cổng ở broker.
- Export hay widget biến nội dung do target/model sinh thành markup hoạt động (link, ảnh, HTML, công thức CSV).
- Báo cáo hay widget nói "không có lỗ hổng/clean/an toàn" từ danh sách rỗng hoặc từ coverage blocked/untested.
- Thêm model call, compaction, retry hay fallback mà hộp xác nhận không nói.
- Hiển thị ước lượng như số thực, hoặc `unknown` như 0; hoặc có cap/chặn theo chi phí khi chưa được quyết định riêng.
- Runtime digest vẫn bỏ sót code đang chạy, hoặc fail-open khi không đọc được.
- Khai báo tool hoặc prompt tăng vượt ngân sách mà không có đo và lý do.

---

## 15. Source map

Số dòng áp dụng cho snapshot `7e204c3` + working tree và ARTEX 0.3.15; **symbol/file là neo chính** khi source đổi.

| ID | Nguồn | Nội dung đã đối chiếu |
|---|---|---|
| P1 | `src/ticket.ts::extensionDigest`, `readTicket` (cổng identity); `extensions/p2o/index.ts` (`extensionSha`, `profile.runtimeHash`, export `extensionSha256`); `src/skills.ts::packageRoot` | D1: phạm vi digest |
| P2 | `src/prompts.ts` (`KNOWLEDGE`, `EVIDENCE`, `ownerInstructions`, `workerInstructions`); `src/tool-policy.ts`; `extensions/p2o/index.ts` (không có `promptGuidelines`) | D2: chính sách và loadout |
| P3 | `extensions/p2o/index.ts::spawnWorkerLocked`; `src/tasks.ts::reserve`, `workIdentity` | D3: admission của delegate |
| P4 | `src/broker.ts::prepareCommand`, `deps.beforeCommand`; `src/engine.ts::pause`, `disposition` | D4/W2: cổng lệnh, pause/blocked |
| P5 | `src/ui/workspace.ts::eventLines`; `src/state/store.ts::events`; `src/state/schema.ts` (index `events_*`, `EVENT_KINDS`); `src/progress.ts::view`; `src/ui/state.ts` | D5: lọc log, stall, widget |
| P6 | `extensions/p2o/index.ts` (`renderResult` chỉ ở `p2o_task`; hook `context`, `message_end`; `registerExecTool`) | D5/D10 |
| P7 | `src/state/store.ts::acknowledgeContext`, `contextPacket`; `src/context.ts` | Packet: chỉ lưu hash/đếm, không nội dung |
| P8 | `docs/PLANNER_ENGINE.md`, `docs/KNOWLEDGE_WORKSPACE.md`, `docs/CONTEXT_PACKETS.md`, `docs/STATE_STORE.md` | Gates còn mở, giới hạn đã công bố |
| P9 | `src/validate.ts` (mới), `src/case-types.ts`, `src/coverage-types.ts` | Helper đã gộp |
| P10 | `tests/minimal/{planner,graph,work,case}-native.test.ts`, `vitest.config.ts` | Harness trùng và timeout |
| A1 | `my_references/ARTEX/ARTEX_AGENTIC_CORE.vi.md`, `research_sources/source_manifest.json` | Provenance (332/0/0) |
| A2 | `report/report.go` (49–93), `report/findings.go` (145–168) | Render báo cáo/CSV |
| A3 | `agent/tools.go::searchAllWorkerTraces` (1927–), `listWorkerTraces` | Tìm trace |
| A4 | `CHANGELOG.md` 0.3.15 (thông báo: escape, SSRF, outbox lease; chặn xóa theo đường dẫn; usage của thẩm phán); "探索链路播报板" 0.3.12 #144–#150; "LLM Pool" 0.3.3; "重试与退避" 0.3.9; "停摆兜底" 0.3.8; reseed prompt 0.3.5 | Bài học vận hành và UX |
| A5 | `intercept/intercept.go` (285–335, 584–668); `db/schema.sql` (`intercept_rules`, `intercept_pending`, `asset_intercept_rules`, `task_intercept_rules`); `guard/guard.go` | Hàng đợi duyệt, rule, ghi chú gỡ RoE |
| A6 | `db/exploration.go::CancelIntent` (428–); `server/manager.go::ApplyTaskPause` (1235) | Điều khiển worker/task |
| A7 | `sidequestion/CONTEXT_BUDGET.md`; `llmrec/llmrec.go` | Ngân sách ngữ cảnh, usage |
| A8 | Các nguồn A1–A14 của bản K0–K7 (graph, planner, worker, capture, finding, digest, UI) | `git show 7e204c3:planning_update.md` §15 |
| PI1 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (`registerToolRenderer`, `promptGuidelines`, `getContextUsage`, `compact`, `agent_settled`) | API 1.1.0 |
| M1 | Probe tạm (test Vitest + fake Pi, đã xóa) | Byte khai báo/chính sách theo loadout (§8) |
| M2 | KNOWLEDGE_WORKSPACE (mục verification 2026-10-10) | Test: 388/12, Python 143/1; fail đầu do timeout dưới tải |

Các reference path chỉ là điều hướng local, không yêu cầu đóng gói source reference. Pi API đọc từ bản 1.1.0 đang pin, không giả định phiên bản khác.

---

## 16. Quyết định chốt cho bản update

**Làm cho workspace đánh giá hiện có đáng tin, điều khiển được và thật sự được dùng, rồi mới tối ưu và mở rộng.**

- Danh tính runtime phải bao phủ code đang chạy; receipt không được nói quá.
- Người dùng có thể xem (lọc log, bảng worker), điều khiển (dừng một worker, giữ thao tác target) và mang đi (báo cáo tất định, an toàn markup) mà không cần gọi model.
- Model được dạy workflow K3–K6 bằng chính sách ngắn và có ngân sách byte; hiệu quả chỉ được tuyên bố sau benchmark có ủy quyền.
- Chi phí cố định, usage và ngữ cảnh được **đo và hiển thị**; không cap, không compaction ngầm.
- Cấu trúc code giảm trùng lặp theo từng bước nhỏ có test và snapshot khai báo.
- Không có gì ở đây thay đổi nguyên tắc scope, authority hay lifecycle; không tuyên bố tăng hiệu quả pentest, và không so sánh hơn ARTEX.

**Scope của lượt soạn plan này:** nghiên cứu tĩnh, đo khai báo bằng probe tạm, kiểm lại hash reference và tạo lại tài liệu này. Không chạy assessment/ARTEX, không commit/push/install. Trạng thái triển khai các slice ghi riêng tại [docs/KNOWLEDGE_WORKSPACE.md](docs/KNOWLEDGE_WORKSPACE.md) khi có công việc thật.
