# Hoạch định p2o: workflow gọn, mạch lạc và có chuẩn rõ ràng (đối chiếu OWASP WSTG)

> **Chỉ lập kế hoạch** (2026-10-11, cây `41e8157`): chưa sửa code, skills, prompts, tests; chưa commit. Tài liệu này **thay** bản W0–W8. Đọc bản cũ ở git: `git show 41e8157:planning_update.md` (W0–W8: §0.1 trạng thái, §0.2 benchmark, §8 chi phí ngữ cảnh, §14 điều kiện F-W; docs và `src/roles.ts` vẫn trích các mục này) và `git show 7e204c3:planning_update.md` (K0–K7). §13 được giữ nguyên bên dưới vì `tests/minimal/acceptance-matrix.test.ts` đọc nó. Phần mới nằm sau §13 và đánh số bằng chữ (A đến G) để không trùng số mục mà docs đang trích.

> **Cập nhật 2026-10-11, khi viết `implement.md` (tài liệu triển khai ở thư mục gốc, chưa chắc được commit):** các thay đổi đã được thử trong một bản sao cô lập của cây `41e8157` và một số con số, lựa chọn ở §A và §D được hiệu chỉnh; bảng đối chiếu nằm ở `implement.md` §11 (A7 còn 12 dòng sai hoặc thiếu; S1 giảm −1.923 / −1.947 ký tự; S4 thêm `src/wstg-map.ts`; tài liệu S5 dài 11.595 ký tự; S3b hoãn). Owner đã quyết **không dùng benchmark trả phí** (Q8 đóng): S7 được thay bằng kiểm chứng miễn phí ở `implement.md` §8. Khi hai tài liệu lệch nhau, `implement.md` (đã chạy thật) là bản đúng.

## Tóm tắt

1. **Audit (§A):** prompt, skills và tool vốn sạch hơn strix (lead 0 tên tool, `skills/**` 0, 24 tool đăng ký khớp loadout, không tool mồ côi), nhưng có **10 điểm lệch đo được** (A1–A10), chủ yếu: worker recon nhận khối recon hai lần (1.869 ký tự, 22% ngữ cảnh), prompt worker nêu tool ngoài loadout, ghim dưới 5.000 ký tự chỉ phủ lead solo (lead delegated 5.220–5.613), loadout solo mang 4 tool điều phối worker (3.636 B, 9,0%), HELP thiếu `/p2o graph`, 13 dòng docs còn ghi trạng thái cũ (bản cài `7e204c3`, "chưa publish/install", "chưa commit"). 5 điểm khác giữ nguyên có lý do (A11–A15).
2. **WSTG (§B), đọc trực tiếp `master` `28553f8`:** 108 test còn hiệu lực trong 12 nhóm (không phải "Input Validation": nay là `Injection`, tiền tố `INJT`). Theo catalog hiện có: 26 test có skill gọi tên đúng lớp lỗi, 35 chỉ có kỹ thuật chung, 43 chưa có, 4 ngoài scope theo thiết kế; 20 bị chặn ở mức chứng minh vì p2o không có browser; 39 cần identity do operator cấp (suy diễn từ mô tả catalog).
3. **Không tạo hệ thống song song:** ID WSTG là `questionKey` chữ thường (`wstg-athz-04`). "Đã kiểm" là cell `tested` có evidence; "đã chứng minh" là case `confirmed` và `accepted` với claim đã `tested`, `policyBasis` khác `inferred`. Toàn bộ dùng trường và cổng có sẵn: 0 trường hay trạng thái schema mới.
4. **Tham chiếu (§C):** 14 điểm so với strix và ARTEX: Adopt 4, Adapt 4, Reject 6.
5. **Kế hoạch (§D):** 8 slice. S0 đến S2 (MVP) không đổi hành vi pentest, kiểm bằng test hermetic: −1.869 ký tự cho worker recon, −3.636 B khai báo solo, sửa các chỗ lệch. S4 đến S6 là dữ liệu, tài liệu và báo cáo tất định. S3 tùy chọn. S7 là benchmark trả phí, chỉ đề xuất.
6. **Giới hạn:** mọi mục tiêu ở đây là kích thước, nhất quán và độ phủ tài liệu. Hiệu quả pentest là **UNVERIFIED** tới S7; benchmark hiện có chỉ chạy solo trên 4 fixture source nên không chạm prompt worker.

## 13. Acceptance matrix: baseline K0–K7, không được regress

Mọi slice dưới đây phải giữ nguyên các fixture và điều kiện này ([ACCEPTANCE_MATRIX](docs/ACCEPTANCE_MATRIX.md) ánh xạ từng hàng tới test thật và có guard tự động). Fixture của giai đoạn W đọc ở §14 của bản `41e8157` (`git show 41e8157:planning_update.md`).

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
| Khai báo + chính sách theo loadout | §8, M1 (bản `41e8157`) | probe 2026-10-10 |

Phương pháp giữ nguyên: corpus deterministic 10k/100k, công bố phần cứng và corpus; báo p50/p95, RSS, kích thước on-disk; không lược bỏ dữ liệu rồi vẫn ghi "complete"; dedup phải báo cả suppression đúng lẫn **false suppression**; inert fixture chỉ chứng minh cơ chế, còn "pentest tốt hơn" cần benchmark có ủy quyền (cùng model/scope/budget, chạy lặp, control giữ lại, chấm độc lập), **chưa được thực hiện**. Số đo chi phí ngữ cảnh của giai đoạn W (§8, M1 và M1b) đọc ở bản `41e8157`; mục tiêu hiện hành ở §D.0 của file này.

### 13.3. Không đạt acceptance nếu

- Có graph nhưng không trả lời được “task nào chưa review, vì sao blocked, output ở đâu”.
- Checkpoint chỉ là model summary không có snapshot/version/refs.
- Finish xóa toàn bộ result mà user tưởng đã lưu.
- Graph dữ liệu được coi như authorization hoặc replay history tự chạy lại request.
- Mọi `confirmed` đều lên badge verified, hoặc “100% coverage” dựa touched assets.
- Dedup suppress validator/retest hoặc merge hai bug chỉ vì cùng CWE/title.
- Thêm background LLM hay đổi budgets/mode mà confirmation không nói.

---

## A. Audit hiện trạng

Phạm vi: `src/prompts.ts`, `src/skills.ts`, `src/tool-guidelines.ts`, `src/tool-policy.ts`, `src/roles.ts`, `skills/` (21 `SKILL.md` và `catalog.json`), `extensions/p2o/index.ts`, `docs/`. Cây `41e8157`. Nhãn: **MEASURED** (có cách tái lập ở §G), **SOURCE-CONFIRMED** (đã đọc file:line), **DESIGN-INFERENCE** (suy luận thiết kế), **UNVERIFIED** (chưa đo). Ký tự là độ dài chuỗi JS; B là byte. Dấu chấm ngăn nghìn, dấu phẩy thập phân.

### A.1. Ai đọc gì, khi nào

| Ai | Khi nào | Nhận gì | Nguồn |
|---|---|---|---|
| Lead solo | mỗi lượt khi run active | section `p2o_assessment` 4.824 ký tự (dir) / 4.972 (url), thực đo 4.968 (trung vị 48 run); khai báo 40.603 B (22 tool) | `prompts.ts:43`, `index.ts:1588,1642` |
| Lead delegated | như trên | 5.220 (dir) / 5.368 (url) / 5.613 (url, event-driven) ký tự; khai báo 36.268 B (18 tool) | như trên |
| Lead tra skill | khi cần | `p2o_skill_list` 3 trang 9.613 + 7.261 + 4.578 = 21.452 ký tự; `p2o_skill_read` trả trang ≤8 KiB | `skills.ts:12,66` |
| Worker recon | lúc spawn | system 5.917 + brief 2.426 + skill mặc định `attack-surface-mapping` 7.534 = 15.877 ký tự (dir); khai báo 20.750 B (14 tool) | `prompts.ts:78-122`, `roles.ts:16`, `index.ts:359,413,1652` |
| Worker discovery, validation | lúc spawn | 13.151 và 12.568 ký tự (dir) | như trên |
| Worker reporting | lúc spawn | 13.340 ký tự (dir); khai báo 13.974 B (9 tool) | như trên |

Brief đo với focus và task giả nên là cận dưới (chưa gồm context kế thừa và capsule). Biến thể url dài hơn dir khoảng 37 ký tự.

### A.2. Phát hiện

Cần xử lý:

| ID | Phát hiện | Bằng chứng | Nhãn | Slice |
|---|---|---|---|---|
| A1 | Khối recon xuất hiện hai lần trong ngữ cảnh của worker recon | `prompts.ts:81` (trong `workerInstructions`) và `:118` (trong `workerBrief`, role recon) giống từng byte: 1.869 ký tự (dir) / 1.893 (url) = 22% của 8.344 / 8.418 | MEASURED | S1 |
| A2 | Prompt worker nêu tool ngoài loadout | `prompts.ts:6` nêu `p2o_workers` (không thuộc `WORKER_TOOLS`, `tool-policy.ts:4`) và `p2o_candidate` cho role reporting (`tool-policy.ts:7` loại nó); nguyên nhân: `prompts.ts:82` đưa KNOWLEDGE và EVIDENCE cho mọi role | SOURCE-CONFIRMED | S1 |
| A3 | Role reporting nhận khối recon dù không có tool target | `prompts.ts:81,85-86`: 1.869 ký tự trong system prompt 5.529 (34%). Có cần hay không: Q2 | MEASURED | Q2 |
| A4 | Ghim dưới 5.000 ký tự chỉ phủ lead solo; lead delegated đã vượt mốc và không bị ghim | `recon.test.ts:18-29,42-47` dùng `delegation.enabled=false`; delegated 5.220 / 5.368 / 5.613 | MEASURED | S1 |
| A5 | Loadout solo mang 4 tool điều phối worker (và `p2o_loop`) trong khi prompt nói không có delegation | `tool-policy.ts:6` (`ownerTools(false)` trả cả 22), áp dụng ở `index.ts:1588`, đối chiếu `prompts.ts:60`. Khai báo: `p2o_delegate` 2.213 + `p2o_workers` 599 + `p2o_steer` 410 + `p2o_stop_worker` 414 = 3.636 B (9,0% của 40.603), `p2o_loop` thêm 680 B. Trong 48 run solo của benchmark W model gọi `p2o_workers` 12 lần (A 4, C 2, C tắt guidance 6) | MEASURED | S2 |
| A6 | HELP thiếu `/p2o graph` | HELP `index.ts:63-78`; lệnh có thật ở `src/ui/workspace.ts:29,48` và `index.ts:1348`; có trong `README.md:59-61`, `docs/USAGE.md:297-300`. Danh sách lệnh nằm ở 3 nơi, không có guard | SOURCE-CONFIRMED | S0 |
| A7 | Docs còn mô tả trạng thái cũ ở 13 dòng, trong khi `main` và bản cài đều ở `41e8157` (W0–W6a; `git rev-parse HEAD` của bản cài trong `~/.pi/agent/git/…/pi-p2o`) | `7e204c3` là bản đang cài: `README.md:7,15`, `docs/USAGE.md:34`, `docs/KNOWLEDGE_WORKSPACE.md:3,136`; banner "chưa publish/install": dòng 3 của `WORK_ADMISSION.md`, `STATE_STORE.md`, `ACCEPTANCE_MATRIX.md`, `CASE_REVIEW.md`, `ASSET_GRAPH.md`; mục nhật ký "chưa commit": `KNOWLEDGE_WORKSPACE.md:82-84`. Không test nào ghim các cụm này. Dòng 136 và các mục nhật ký là ghi chép có ngày: giữ, chỉ thêm ghi chú | SOURCE-CONFIRMED | S0 |
| A8 | Catalog lặp workflow | 48 workflow entry nhưng chỉ 16 khác nhau; `source-review` ×17 và `offline-reproduction` ×17 giống hệt: ≈7.888 / 39.620 ký tự (20%). Mô phỏng liệt kê mỗi workflow chung một lần: 21.452 → 15.385 (−28%); trang 1 chỉ 9.613 → 8.334 (−13%) | MEASURED (mô phỏng) | S3 |
| A9 | Workflow của 4 skill phi-technique khai báo ở hai nơi | `skills/<tên>/skill.json` ×4 và `skills/catalog.json`; drift được kiểm bằng `scripts/validate_library.py:148-152` và `tests/test_library.py`. Vì vậy gộp ở nguồn là việc lớn hơn gộp ở đầu ra | SOURCE-CONFIRMED | S3 |
| A10 | Rò tên tool duy nhất ở tầng kiến thức | `skills/catalog.json:28,219,499` nêu `p2o_http`; `skills/**` 0 lần; lead delegated không có `p2o_http` (`tool-policy.ts:6`) | SOURCE-CONFIRMED | S3 |

Giữ nguyên, không cần hành động:

| ID | Phát hiện | Bằng chứng | Nhãn |
|---|---|---|---|
| A11 | Skill chỉ inline trang 8 KiB đầu là chủ ý, không phải lỗi | `skills.ts:12`, `index.ts:359`: 2 trong 21 skill dài hơn một trang (`web-object-authorization` 7.864 / 9.553, `web-route-input-inventory` 7.655 / 8.821 ký tự); phần còn lại tới worker qua dòng "Continued" | MEASURED |
| A12 | Guidance theo tool phải giữ tắt và không mở rộng | `roles.ts:38` mặc định false. Benchmark W (n=16 mỗi nhóm, `deepseek/deepseek-flash`, solo): A $0,041/run, 21,6 turn, hợp lệ 15/16; guidance bật $0,071, 32,0 turn, 13/16; guidance tắt $0,042, 20,4 turn, 16/16. Bật guidance thêm 1.127 ký tự vào `<rules>` (1.224 so với 97) | MEASURED (receipt cục bộ, gitignored) |
| A13 | Trùng nguyên văn giữa các lớp thấp | 8 từ liền: prompt×skill 0, prompt×docs 66 ký tự, README×docs 592 ký tự / 7 đoạn (chủ yếu danh sách lệnh); 6 từ liền: prompt×khai báo tool ≤1% (56 / 5.711), guidance×khai báo 0. Trùng còn lại là diễn đạt lại cùng ý, không đo tự động được | MEASURED / UNVERIFIED |
| A14 | Đăng ký tool khớp loadout; chi phí khai báo nằm ở schema | 24 tool đăng ký = hợp của loadout owner (22) và worker (14), không tool mồ côi; `p2o_objective_state` là kiểu message (`index.ts:1668-1689`), không phải tool. Khai báo 43.005 B nhưng phần mô tả chỉ 11.314 ký tự; lớn nhất `p2o_graph` 7.248 B, `p2o_task` 5.816, `p2o_case` 4.697, `p2o_coverage` 4.403. Tái hiện đúng ngân sách đã ghi (36.268 / 40.603 / 20.750 / 13.974 B) | MEASURED |
| A15 | Chưa có tool nào xóa được trên bằng chứng log | 48 run solo (4 fixture là thư mục source, 1 model): không gọi `p2o_http` (không có fixture url), `p2o_capture`, `p2o_steer`, `p2o_stop_worker`, `p2o_delegate`; gọi ít: `p2o_artifact` 3, `p2o_loop` 3. `p2o_request_subtask` và `p2o_report` là tool worker nên không thể xuất hiện ở solo. Fixture không chạm các tool đó nên không kết luận được | MEASURED; kết luận UNVERIFIED |

### A.3. Điểm khó theo hoặc dễ lệch (chưa phải lỗi)

- Lead không biết tên tool (đúng lời hứa ở `README.md:131`, có test ghim) nhưng đọc catalog có `p2o_http` (A10).
- Cùng một "handoff contract" recon nằm ở 3 nơi: lead (`prompts.ts:56`), system worker (`:81`), brief (`:118`). Dùng chung là chủ ý (`prompts.ts:15`), nhưng trong ngữ cảnh của một worker recon hai bản sau là cùng một văn bản (A1).
- Từ vựng đóng ba trạng thái nằm ở 3 chỗ: prompt lead (`prompts.ts:72`), EVIDENCE của worker (`:6,91`) và cổng host (`evidence.ts:127-134`, `cases.ts:47`). Nguồn thật là host; prompt chỉ nhắc. Skills 0 lần: giữ vậy, không thêm lớp thứ tư.
- Hai lớp coverage (ghi chú `p2o_note kind=coverage` của worker và cell của lead) chưa có khóa chung; khóa WSTG ở §B.3 làm việc này mà không đổi schema.
- Lead solo và delegated dùng cùng một hàm prompt, chỉ khác phần DELEGATION, nhưng loadout solo vẫn giữ tool delegation (A5).

### A.4. Giới hạn của audit

- Log gọi tool chỉ từ benchmark W: solo, 4 fixture thư mục source, một model rẻ. Không đại diện cho run delegated, url, native hay firmware, và **benchmark hiện có không chạm prompt worker** (chạy `--solo`).
- Phân loại WSTG (§B.2) dựa trên tiêu đề test và mô tả skill trong catalog; chưa đọc từng `SKILL.md` ở mức câu, chưa đọc mục "How to Test" của từng test.
- ARTEX không có `.git` nên không có commit (CHANGELOG ghi 0.3.15, 2026-10-07); strix 1.7.0 (`pyproject.toml:3`). Với strix chỉ đọc `prompt.py`, `skills/__init__.py`, đầu `system_prompt.jinja`, các skill `analysis/` và `scan_modes/`, đầu `report/dedupe.py`; không chạy gì.
- Số liệu ký tự của prompt tính với nhãn target giả; sai lệch vài chục ký tự so với run thật.

---

## B. Chuẩn pentest từ OWASP WSTG

### B.1. Nguồn đã đọc trực tiếp

| Nguồn | Phiên bản | Đã đọc | Chưa đọc |
|---|---|---|---|
| OWASP WSTG | `master` `28553f878d48358767892916d53e59a9d664811c` (2026-10-10); tag `v4.0`, `v4.1`, `v4.2` (`dd33419e1…`) | cây `document/4-Web_Application_Security_Testing/` (13 chương, 108 test còn hiệu lực), bảng ID của từng trang, `checklists/checklist.json`, `5-Reporting/01-Reporting_Structure.md`, `3-The_OWASP_Testing_Framework/1-Penetration_Testing_Methodologies.md`, 4 trang mẫu | nội dung "How to Test" từng test; tag `v4.2` |
| OWASP FSTM | `ec666e8f8b9f7618a248a1c354469893abf0edb2` (2025-10-04) | cấu trúc 9 stage trong `README.md` | nội dung từng stage |

Điểm lệch cần biết (SOURCE-CONFIRMED trong repo WSTG ở commit trên):

- Nhóm bạn gọi là "Input Validation" nay là `07-Injection` với tiền tố `INJT` (22 test); bản `v4.2` dùng `INPV` (UNVERIFIED ánh xạ từng ID, chưa đọc tag).
- 12 nhóm có ID (`INFO`, `CONF`, `IDNT`, `ATHN`, `ATHZ`, `SESS`, `INJT`, `ERRH`, `CRYP`, `BUSL`, `CLNT`, `APIT`) = 108 test; chương `13-WebAssembly_Testing` chỉ có overview, **không có ID**.
- 6 ID đã gộp vẫn còn trong `checklist.json` (114 ID = 108 + 6): `INFO-09`, `CONF-03`, `ATHN-01`, `IDNT-05`, `INJT-03`, `ERRH-02`. 3 ID đã bỏ: `CONF-08`, `CLNT-08`, `INJT-13` (Buffer Overflow). `INJT-13` nay thuộc Format String Injection nên đụng ID với trang stub: khóa ánh xạ phải là cặp (ID, tiêu đề).
- Cấu trúc mỗi trang test (đếm trên 108 trang): Summary 108, Test Objectives 107, How to Test 108; Remediation chỉ 56.

### B.2. Ánh xạ nhóm WSTG sang p2o (không tạo hệ thống song song)

Mức bao phủ của catalog hiện có (DESIGN-INFERENCE, theo tiêu đề test và mô tả skill):

| Mã | Ý nghĩa |
|---|---|
| D | có skill mà mô tả gọi tên đúng lớp lỗi của test (ví dụ IDOR với `web-object-authorization`) |
| T | chỉ có kỹ thuật chung (`attack-surface-mapping`, `data-flow-analysis`, `source-code-auditing`, `authorization-auditing`) |
| N | chưa có skill nào |
| O | ngoài scope của p2o theo thiết kế: cần origin khác, DNS hoặc công cụ tìm kiếm bên thứ ba (`prompts.ts:53-54`: chỉ người dùng mới mở rộng scope) |
| cờ B | hiệu ứng xảy ra ở trình duyệt; p2o không có browser (`catalog.json:477`) nên bằng chứng tối đa là `offline_reproduction` |
| cờ I | cần identity do operator cấp (`prompts.ts:87`: credentials phải do operator cung cấp) |

Phase và role mặc định theo p2o: recon → discovery → validation → reporting (`prompts.ts:56-68`, `roles.ts:9,16-19`).

| Nhóm | Live | D/T/N/O | B | I | Phase và role | Skill hiện có | Khoảng trống chính |
|---|---|---|---|---|---|---|---|
| INFO | 9 | 2/6/0/1 | 0 | 0 | recon | `attack-surface-mapping`, `web-route-input-inventory` | `INFO-01` (công cụ tìm kiếm) ngoài scope |
| CONF | 13 | 1/5/4/3 | 2 | 0 | recon, discovery | `attack-surface-mapping`, `parser-differential-auditing` (`CONF-13`) | header và cấu hình: `CONF-07`, `09`, `12`, `14`; `CONF-01`, `10`, `11` ngoài scope |
| IDNT | 4 | 1/3/0/0 | 0 | 3 | discovery | `web-object-authorization`, `authorization-auditing` | cần identity |
| ATHN | 10 | 2/0/8/0 | 1 | 9 | discovery, validation | `authorization-auditing` | lockout, reset, MFA, default credentials, remember-me; lockout có tác dụng phụ |
| ATHZ | 5 | 3/1/1/0 | 0 | 4 | discovery, validation | `web-object-authorization`, `authorization-auditing`, `fastapi-security-parity` (khi là FastAPI) | OAuth (`ATHZ-05`) |
| SESS | 11 | 0/0/11/0 | 1 | 10 | discovery, validation | chưa có | nhóm trống lớn nhất: cookie, fixation, logout, timeout, JWT, CSRF |
| INJT | 22 | 10/12/0/0 | 2 | 1 | discovery, validation | `web-output-context`, `parser-differential-auditing`, `deserialization-and-dispatch-auditing`, `data-flow-analysis`, `memory-safety-auditing` | `INJT-19` (SSRF) chỉ chứng minh trong origin đã xác nhận; XSS cần browser để chứng minh thực thi |
| ERRH | 1 | 0/0/1/0 | 0 | 0 | quan sát phụ khi chạy test khác | chưa có | không có skill riêng |
| CRYP | 4 | 0/1/3/0 | 0 | 0 | recon, discovery | `source-code-auditing` (`CRYP-04`) | TLS, padding oracle, kênh không mã hóa |
| BUSL | 10 | 1/2/7/0 | 0 | 10 | discovery, validation | `race-condition-auditing` (`BUSL-05`) | cần chính sách nghiệp vụ có nguồn; suy diễn thì chỉ được `open_proof_gap` (`evidence.ts:127`) |
| CLNT | 14 | 3/4/7/0 | 14 | 0 | discovery | `web-output-context` | không có browser: tối đa `offline_reproduction` |
| APIT | 5 | 3/1/1/0 | 0 | 2 | recon, discovery | `web-route-input-inventory`, `web-object-authorization` | GraphQL (`APIT-99`) |
| **Tổng** | **108** | **26/35/43/4** | **20** | **39** | | | |

Đọc kết quả: trong 104 test thuộc scope, 61 (59%) có ít nhất một skill liên quan và 26 (25%) có skill gọi tên đúng lớp lỗi. Đây là độ phủ **tài liệu và kiến thức**, không phải khả năng phát hiện (UNVERIFIED tới S7).

### B.3. Khóa và trường dùng lại (không đổi schema)

- **Khóa test:** `questionKey = wstg-<nhóm>-<nn>` chữ thường (ví dụ `wstg-athz-04`), vì `key()` chỉ nhận `[a-z0-9._:/-]` (`validate.ts:16`). `questionKey` đã có ở work identity (`work.ts:15,59`) và cell coverage (`coverage-types.ts:13`).
- **`methodFamily`** giữ id workflow của skill (`source-review`, `offline-reproduction`...). **`policyKey`** giữ nghĩa chính sách của ứng dụng (`case-types.ts:13`), không dùng cho ID WSTG.
- **Hệ quả (DESIGN-INFERENCE):** `questionKey` đi vào vân tay trùng lặp (`work.ts:113-117`), nên hai worker cùng thử một test WSTG trên cùng asset sẽ bị phát hiện trùng chính xác thay vì phụ thuộc cách đặt tên tự do. Đây cũng là khóa chung nối ghi chú coverage của worker với cell của lead (A.3).
- Không thêm trường, trạng thái hay bảng; bản đồ D/T/N/O nằm ngoài runtime (S4).

### B.4. "Đã kiểm" và "đã chứng minh"

WSTG không định nghĩa hai khái niệm này; ánh xạ dưới đây dùng trường và cổng có sẵn (cổng: SOURCE-CONFIRMED; cách đặt tên mức: DESIGN-INFERENCE).

| Mức | Điều kiện trên trường có sẵn | Bằng chứng tối thiểu | Không được suy ra |
|---|---|---|---|
| L0 chưa kiểm | không có cell, hoặc cell `unplanned`, `planned`, `running` (`coverage-types.ts:2`) | không | "không thấy lỗi" nghĩa là an toàn (§13.1 hàng 1) |
| L1 đã thử, chưa xong hoặc bị chặn | cell `attempted` hoặc `blocked`; `blocked` bắt buộc assessment `open_gap` và ≥1 `gapRefs` (`coverage.ts:53`); claim `blocked` của worker cần requirement ≥10 ký tự và chỉ đóng bằng `open_proof_gap` (`evidence.ts:132-133`) | lệnh hoặc request nguyên văn, lý do chặn | sạch |
| L2 đã kiểm | cell `tested` bắt buộc ≥1 `evidenceRefs` và task revision đã `reviewed` hoặc `closed` có receipt (`coverage.ts:52`), kèm actor, tenant, method của lần thử; kết quả âm: `ruled_out_bounded` cần `evidenceRefs`, `negativeControlRefs` và case `ruled_out` đã accepted, còn hiệu lực (`coverage.ts:55`); claim `ruled_out` của worker cần tên control và vị trí (`evidence.ts:129`) | receipt (Evidence ID), kiểm soát âm, giới hạn | an toàn ngoài ngữ cảnh đã thử (§13.1 hàng 22) |
| L3 đã chứng minh | case `confirmed` và `reviewStatus accepted`, trích claim `confirmed` và `tested` có `policyBasis` khác `inferred` (`cases.ts:47`, `evidence.ts:127`); cell `accepted` cần case accepted còn hiệu lực (`coverage.ts:56`); mức `proof` (`static_trace`, `offline_reproduction`, `live_reproduction`) luôn hiển thị cạnh L3 | reproduction, kiểm soát âm, `expectedPolicy` có nguồn | chứng minh tĩnh là bằng chứng runtime (`prompts.ts:6,70`); browser đã thực thi |
| L3 độc lập | thêm worker khác có `proof` khác `static_trace` và receipt còn hiệu lực (`evidence.ts:73`, `cases.ts:30`) | receipt của validator | còn độc lập sau khi validator bị withdraw (§13.1 hàng 14) |

Quy tắc đếm độ phủ: một test WSTG chỉ vào "đã kiểm" khi cell ở L2 trở lên và vào "đã chứng minh" khi ở L3; test cờ O luôn là `not_applicable` kèm lý do; test cờ B không bao giờ có `live_reproduction` bằng trình duyệt.

### B.5. Đầu ra báo cáo (WSTG `5-Reporting/01-Reporting_Structure.md`) so với báo cáo của p2o

| Mục WSTG | p2o có sẵn | Thiếu |
|---|---|---|
| Scope, Limitations | plan `exclusions` và `unknownScope` (`coverage-types.ts:10`); mục "Limits of this report" (`report-export.ts:125`) | nhóm theo WSTG |
| Findings summary và detail (ID, title, risk, mô tả, khắc phục) | "Accepted current cases" (`report-export.ts:99`), `cases.csv` | thang rủi ro có giải thích (WSTG yêu cầu nêu rõ thang) |
| Checklist các test đã làm (phụ lục) | `coverage.csv`, mục "Coverage and gaps" (`report-export.ts:80`) | gom theo ID WSTG, cột mức L0–L3 và D/T/N/O |
| Reproducible artifacts (curl, HAR) | receipt và artifact đã retain | không |
| Human factors (phishing, social engineering) | không | **để trống có chủ đích**: p2o không kiểm con người |

### B.6. Phần ngoài WSTG

| Phần p2o nhắm tới | WSTG | Chuẩn bổ trợ | Trạng thái |
|---|---|---|---|
| Firmware | không | OWASP FSTM, 9 stage, không có ID từng test (WSTG tự trỏ tới: `3-…/1-Penetration_Testing_Methodologies.md`) | dùng tên stage gợi ý cho `methodFamily`; stage 2 (lấy firmware vật lý) và 9 (binary exploitation) bị giới hạn bởi scope và guardrail; ánh xạ stage → skill: UNVERIFIED |
| Binary, native, memory safety | không | chưa chọn; CWE hoặc SEI CERT chưa đọc | **để trống có chủ đích** (Q5) |
| Kernel, hypervisor, sandbox | không | không có chuẩn OWASP tương ứng trong nguồn đã đọc | để trống có chủ đích |
| Mobile | không | OWASP MAS (WSTG nêu tên, chưa đọc) | ngoài phạm vi: target chỉ là thư mục hoặc URL (`prompts.ts:33`) |
| WebAssembly | chỉ overview, không ID | không | không tạo ID (Q9) |
| Quy trình, báo cáo | `5-Reporting` (đã đọc, §B.5) | PTES, NIST Technical Guide to Information Security Testing and Assessment (WSTG nêu tên, chưa đọc) | không áp dụng thêm |

---

## C. Đối chiếu `my_references/strix` và `my_references/ARTEX`

Chỉ đọc tĩnh. Đường dẫn strix tính từ `my_references/strix/strix/` (mã, `agents/`, `skills/`) và `my_references/strix/skills/` (skill cho người dùng, mục 11); ARTEX tính từ `my_references/ARTEX/`; "CORE" là `ARTEX_AGENTIC_CORE.vi.md`. Ràng buộc p2o dùng để phán xét: Engine tất định, không Planner model ẩn, prompt lead không nêu tên tool và bị ghim (`recon.test.ts`), quyền do host cưỡng chế (`tool-policy.ts:1`).

| # | Điểm so sánh | strix | ARTEX | p2o hiện tại | Kết luận và lý do |
|---|---|---|---|---|---|
| 1 | Phân tầng prompt | một template `system_prompt.jinja` 46.922 B, thẻ section ở dòng 4/13/20/61/233/271/420/498/508 | thân [A] sửa được qua DB, đuôi [B] và [C] cố định trong code (`agent/prompt.go:20-38`, `agent/promptcatalog.go:3-8`) | lead 4,8–5,6 nghìn ký tự chỉ có policy; quyền ở host | **Reject** nguyên khối và prompt sửa qua DB: prompt bị ghim, đổi chính sách ngoài test; nguyên tắc "đuôi do code giữ" đã có sẵn |
| 2 | Nạp skill | luôn nạp `counterevidence` 9.153 B và `severity_calibration` 5.620 B cho mọi agent (`agents/prompt.py:59-60`), ≤5 skill (`skills/__init__.py:215`), liệt kê toàn bộ tên (`system_prompt.jinja:508-517`) | skill vận hành lớn (`api-recon` 18.375 B) | ≤3 skill, trang 8 KiB đầu; catalog tra theo yêu cầu | **Reject**: cố định ≈14,8 KB mỗi agent trong khi closure đã ở host; liệt kê catalog vào prompt tốn 21.452 ký tự |
| 3 | Tham chiếu tool trong prompt và skill | 100 lần trong system prompt; 66 lần ở 21 / 76 file skill | không đo | lead 0 (`recon.test.ts:28`), skills 0, catalog 3, prompt worker 2 tool ngoài loadout | **Adapt**: giữ cách của p2o, vá 5 chỗ rò (A2, A10) và mở rộng guard tên tool ↔ loadout của `workflow-policy.test.ts` từ guidance sang prompt đã lắp (S1) |
| 4 | Chế độ độ sâu | `scan_modes` quick / standard / deep / diff = skill 3.103 / 4.023 / 7.354 / 3.861 B (`agents/prompt.py:54-56`) | stop, retry, timeout là vòng quản lý Go, không phải câu trong prompt (CORE §7.4) | độ sâu do lead chọn qua task | **Adapt**: độ sâu thành mẫu coverage plan theo nhóm WSTG (S5), không thành chế độ trong prompt |
| 5 | Ranh giới role | không đo | ranh giới là tool surface thật (CORE §7.2) | loadout theo role, broker `beforeCommand`, `ExecutorPool.beforeStart` | **Adopt** (đã có): giữ; không chuyển ràng buộc nào sang prompt |
| 6 | Ba trạng thái đóng | `analysis/counterevidence.md:16` | không | cùng từ vựng (`prompts.ts:8-12` ghi nguồn Strix) nhưng cưỡng chế ở host (`evidence.ts:127-134`, `cases.ts:47`) | **Adopt** (đã có): không thêm skill 9 KB; host mạnh hơn prompt |
| 7 | Chứng minh goal | không | `prove_goal` do Planner LLM đánh giá là chính (CORE §7.4) | cổng cơ học + review của owner | **Reject**: p2o không để model tự xác nhận bằng chứng |
| 8 | Nhãn độ tin cậy trong tài liệu | không | CONFIRMED / STRONGLY INFERRED / UNKNOWN (CORE §12) | nhãn MEASURED / SOURCE-CONFIRMED / UNVERIFIED | **Adopt**: dùng trong mọi tài liệu kế hoạch và báo cáo |
| 9 | Dedupe báo cáo | `report/dedupe.py` dùng thiết lập model (`DedupeSettings.reasoning_effort`); chỉ đọc đầu file | không | `duplicateOf` cần cùng `policyKey` và `rootCauseKey` (`docs/CASE_REVIEW.md:33`) | **Reject**: không model ẩn |
| 10 | Chống làm trùng | không | claim nguyên tử open → running (CORE §7.3) | vân tay work identity (`work.ts:113-117`) | **Adapt**: đưa ID WSTG vào `questionKey` (B.3) để trùng được phát hiện chính xác |
| 11 | Tuyên bố độ phủ trung thực | `skills/owasp-top-10-testing/SKILL.md`: bảng "what is and is not testable by an agent" | không | có denominator nhưng không theo chuẩn | **Adopt** ý tưởng: bảng D/T/N/O + cờ B/I của B.2 vào phụ lục báo cáo (S6); cấm câu "phủ 100%" |
| 12 | Planner phiên mới mỗi lần thức | không | Planner fresh, Worker transcript ổn định theo intent (CORE §7.1); lợi ích tự xếp "STRONGLY INFERRED" (§12.2) | Planner là phiên Pi của người dùng | **Reject**: đổi kiến trúc, chưa có số đo |
| 13 | Tách prompt để cache | `<cache_point>` (`agents/prompt.py:21`, `system_prompt.jinja:520`) | không | Pi ghép section prompt (`index.ts:1642`) | **Reject**: không thuộc extension |
| 14 | Tổ chức skill | 76 file `.md` theo thư mục (vulnerabilities, frameworks, protocols, tooling...) | 3 skill vận hành | 21 skill phẳng, `kind` technique / playbook / overlay | **Adapt** cấu trúc, **không** chép nội dung: nếu viết playbook cho nhóm N (SESS, ATHN, CONF-header), dùng mẫu playbook sẵn (`SKILL.md` + `skill.json` + catalog) |

Tổng: 14 điểm, **Adopt 4** (5, 6, 8, 11), **Adapt 4** (3, 4, 10, 14), **Reject 6** (1, 2, 7, 9, 12, 13).

---

## D. Kế hoạch theo slice

### D.0. Mục tiêu đo được

| Chỉ số | Hiện tại | Mục tiêu | Slice |
|---|---|---|---|
| Ngữ cảnh worker recon (dir) | 15.877 ký tự | 14.008 (−1.869) | S1 |
| Tên tool ngoài loadout trong prompt đã lắp | 2 | 0 | S1 |
| Biến thể lead được ghim kích thước | 2 (solo dir, solo url) | 5 (thêm delegated dir, url, url event-driven) | S1 |
| Khai báo loadout solo | 40.603 B | ≈36.967 B (−3.636, −9,0%) | S2 |
| Lệnh thiếu trong HELP; dòng docs ghi trạng thái cũ | 1; 13 | 0; 0 | S0 |
| `p2o_skill_list` duyệt hết 3 trang | 21.452 ký tự | ≈15.385 (−28%, mô phỏng) | S3 (tùy chọn) |
| Test WSTG đã phân loại; trường schema mới | 0 / 108; 0 | 108 / 108; 0 | S4 |
| Cell `wstg-*` có trong phụ lục báo cáo | n/a | 100%, đầu ra tất định | S6 |
| Hiệu quả pentest | **UNVERIFIED** | không tuyên bố cho tới S7 | S7 |

Thứ tự: S0 độc lập → S1 → S2 (làm sau S1 để cập nhật pin một lần) → S4 → S5 → S6 → S7. S3 tùy chọn, làm sau S6 hoặc bỏ. MVP giảm chi phí cố định và sửa lệch: S0 + S1 + S2.

### S0. Đồng bộ tài liệu và HELP (giữ nguyên hành vi)

| Trường | Nội dung |
|---|---|
| Hành động | **Sửa** 13 dòng ở A7: thay cách ghi cứng hash bằng cách kiểm (`git rev-parse HEAD` trong thư mục package đã cài); bỏ banner "chưa publish/install" nhưng **giữ** "K0–K7 vẫn mở" nếu còn đúng (rà từng file); thêm ghi chú vào các mục nhật ký có ngày thay vì xóa; **thêm** `graph` vào HELP (A6); **thêm** test: mọi lệnh `/p2o <x>` ở README và USAGE đều có trong HELP |
| Mục tiêu đo | lệnh thiếu 1 → 0; dòng docs ghi trạng thái cũ 13 → 0 |
| File và test | `README.md`, `docs/USAGE.md`, `docs/KNOWLEDGE_WORKSPACE.md`, bốn docs có banner, chuỗi HELP ở `extensions/p2o/index.ts`, một test hermetic mới; receipt lịch sử có ngày giữ nguyên |
| Xác minh | `npm test`; `grep` các cụm cũ chỉ còn trong ngữ cảnh lịch sử có ngày |
| Rủi ro | thấp: không test nào ghim các cụm docs (đã grep `tests/` và `scripts/`); test hiện có có thể so chuỗi HELP (UNVERIFIED, cần grep trước khi sửa); `README.md` là nguồn của tài liệu `shared:scope` và hash tính trên cả file (`skills.ts:95`), nên mọi sửa README đổi hash: task method đang mở sẽ stale (`TASK_METHOD_STALE`, `index.ts:349`), chỉ ảnh hưởng giữa các run |
| Phụ thuộc | không |
| Hoàn thành | test mới xanh, grep sạch, không đổi hành vi runtime |

### S1. Prompt: bỏ bản trùng, đúng loadout, ghim cả bản delegated

| Trường | Nội dung |
|---|---|
| Hành động | **Xóa** bản recon thứ hai trong `workerBrief` (`prompts.ts:118`); **chuyển** câu nêu `p2o_workers` ra khỏi EVIDENCE và biến câu `p2o_candidate` thành điều kiện theo role (A2); **giữ** lead không có tên tool; **thêm** ghim kích thước cho 3 biến thể delegated ở mức hiện tại +2%; **thêm** `scripts/measure-context.mjs` (chỉ đọc) để các số ở §A tái lập được |
| Mục tiêu đo | recon worker −1.869 / −1.893 ký tự (−22%); tên tool ngoài loadout 2 → 0; biến thể lead được ghim 2 → 5 |
| File và test | `src/prompts.ts`; `tests/minimal/recon.test.ts` (cập nhật **cả 4 hash** ở dòng 51-52 cùng lúc, có chủ đích); `workflow-policy.test.ts` thêm guard: mọi `p2o_*` trong prompt đã lắp theo role phải thuộc loadout của role đó; `native.test.ts` giữ nguyên ràng buộc "không tên tool" |
| Xác minh | chạy lại kịch bản render trước và sau (§G); `npm test`; tùy chọn có sự đồng ý của owner: benchmark delegated (Herdr) vì benchmark solo hiện có **không** chạm prompt worker |
| Rủi ro | trung bình: đổi prompt worker mà chưa có số đo chất lượng (UNVERIFIED); brief có thể dựa vào vị trí gần `TASK` (UNVERIFIED) nên giữ bản ở system prompt và xóa bản ở brief |
| Phụ thuộc | không |
| Hoàn thành | số đo mục tiêu đạt; 4 hash cập nhật kèm lý do trong thông điệp commit; guard mới xanh; lead solo vẫn dưới 5.000 ký tự; không nói "chất lượng tốt hơn" |

### S2. Loadout solo không mang tool điều phối worker

| Trường | Nội dung |
|---|---|
| Hành động | **Gỡ** `p2o_delegate`, `p2o_workers`, `p2o_steer`, `p2o_stop_worker` khỏi `ownerTools(false)` (`tool-policy.ts:6`); **giữ** `p2o_loop` cho tới khi có Q3 |
| Mục tiêu đo | khai báo solo 40.603 → ≈36.967 B (−9,0%); số lần gọi tool điều phối khi không có worker: 12 / 48 run (baseline W) → 0 |
| File và test | `src/tool-policy.ts`; `workflow-policy.test.ts:90` (ngân sách solo); các test gọi `p2o_workers` hoặc `p2o_delegate` (`planner.test.ts`, `operator-controls.test.ts:120-124`, `workflow-policy.test.ts:131-132`) cần xác nhận chạy ở chế độ delegated (UNVERIFIED); `extension.test.ts:73,95` |
| Xác minh | `npm test`; đo lại khai báo bằng kịch bản §G; benchmark solo nhỏ: 16 run ≈ $0,66 theo $0,041/run đã đo ở W (**cần owner đồng ý**) |
| Rủi ro | thấp đến trung bình: `p2o_workers` có thể đang được dùng để xem trạng thái engine ở solo (UNVERIFIED); nếu có thì giữ lại |
| Phụ thuộc | S1 (gộp cập nhật pin) |
| Hoàn thành | ngân sách mới được ghi có chủ đích; prompt "Delegation is NOT available" khớp với loadout |

### S3. Catalog gọn (ưu tiên thấp, tùy chọn)

| Trường | Nội dung |
|---|---|
| Hành động | **Gộp** workflow trùng trong *kết quả* `list()` (khai báo một lần, entry trỏ id), không đổi `catalog.json` và `skill.json` nên không đụng `validate_library.py` (A9); **thay** `p2o_http` ở 3 prerequisite bằng mô tả trung tính (A10) |
| Mục tiêu đo | duyệt hết 21.452 → ≈15.385 ký tự (−28%); trang 1 chỉ −13%; tên tool trong catalog 3 → 0 |
| File và test | `src/skills.ts` (`list`), `skills/catalog.json`, test skill runtime (UNVERIFIED tên file), `npm run check:library` |
| Xác minh | kịch bản mô phỏng ở §G, `npm run check:library`, `npm test` |
| Rủi ro | đổi hình dạng đầu ra tool nên so sánh với benchmark cũ không cùng điều kiện; giá trị thấp: lead gọi `p2o_skill_list` khoảng 1 lần mỗi run (16–17 lần / 16 run) |
| Phụ thuộc | nên sau S6 |
| Hoàn thành | chỉ làm nếu S7 chỉ ra catalog là chi phí đáng kể; nếu không thì ghi quyết định bỏ |

### S4. Dữ liệu ánh xạ WSTG (không đổi runtime)

| Trường | Nội dung |
|---|---|
| Hành động | **Thêm** `docs/WSTG_MAP.md`: 108 hàng (ID, tiêu đề, D/T/N/O, cờ B/I, skill, phase) với header ghi commit WSTG `28553f8`; **thêm** test offline: đủ 108 ID không trùng, skill nêu tên có trong catalog, khóa `wstg-*` hợp lệ theo `validate.ts:16`, header khớp commit đã ghim |
| Mục tiêu đo | 0 → 108 / 108 test phân loại; trường schema mới 0 (diff của `src/state/schema.ts`, `case-types.ts`, `coverage-types.ts`, `work.ts` rỗng) |
| File và test | `docs/WSTG_MAP.md` (mới), một test mới trong `tests/minimal/`; không động `src/` |
| Xác minh | test mới; owner rà soát 108 phân loại (Q6) |
| Rủi ro | phân loại sai vì suy diễn từ mô tả catalog (DESIGN-INFERENCE); WSTG đổi ID giữa các bản (đã thấy `INPV` → `INJT`) nên phải ghim commit và làm mới thủ công khi cần mạng |
| Phụ thuộc | không |
| Hoàn thành | test xanh; owner xác nhận bảng; `package.json` `files` đã gồm `docs/` nên được đóng gói |

### S5. Đưa ánh xạ vào luồng làm việc mà không đổi prompt lead

| Trường | Nội dung |
|---|---|
| Hành động | **Thêm** tài liệu `shared:wstg-map` (≤6.000 ký tự, chỉ ID, tên, mức theo nhóm, không tên tool) vào `documents` của catalog; **ghi** quy ước khóa `wstg-*` vào `HANDOFFS.md` (3–4 dòng); **thêm** mẫu coverage plan theo nhóm WSTG (JSON trong docs) để lead truyền vào `p2o_coverage` |
| Mục tiêu đo | chi phí cố định mỗi request +0 B (tài liệu đọc theo yêu cầu); độ dài tài liệu ≤6.000 ký tự; mức worker thực sự dùng khóa `wstg-*`: chỉ đo được ở S7 |
| File và test | `skills/catalog.json`, `HANDOFFS.md`, `docs/`; hash tài liệu đổi nên task method đang mở sẽ stale (`TASK_METHOD_STALE`, `index.ts:349`), chỉ ảnh hưởng giữa các run |
| Xác minh | `npm run check:library`, `npm test`; S7 |
| Rủi ro | worker không biết tới tài liệu nếu không được dẫn tới: `prompts.ts:5` chỉ nêu `shared:handoffs` và `shared:scope`, nên quy ước phải nằm trong `HANDOFFS.md`, không sửa prompt (giữ hash) |
| Phụ thuộc | S4 |
| Hoàn thành | tài liệu hiển thị trong `sharedDocuments` của `p2o_skill_list`; lead prompt không đổi byte nào |

### S6. Báo cáo theo khung WSTG (tất định, không gọi model)

| Trường | Nội dung |
|---|---|
| Hành động | **Thêm** vào `REPORT.md` phụ lục "Checklist kiểm theo WSTG" (gom cell `wstg-*` theo nhóm, cột mức L0–L3 và D/T/N/O) và "Thang rủi ro" cố định; không đổi header `coverage.csv` |
| Mục tiêu đo | 100% cell `wstg-*` có mặt (phần bị cắt hiển thị đúng "omitted"); xuất hai lần cho cùng hash `report-manifest.json` |
| File và test | `src/report-export.ts`, `tests/minimal/report-export.test.ts` |
| Xác minh | test tất định và an toàn markup (đã có `mdText`), `npm test` |
| Rủi ro | thấp; thêm mục mới không đổi thứ tự mục cũ, nhưng hash manifest cũ không so sánh được |
| Phụ thuộc | S4 (S5 tùy chọn) |
| Hoàn thành | phụ lục có mặt; không dùng câu "phủ 100%"; test xanh |

### S7. Đo hiệu quả (chỉ đề xuất; cần owner chọn model và ngân sách)

| Trường | Nội dung |
|---|---|
| Hành động | (a) hermetic trước: `node scripts/benchmark-skills.mjs plan` và `verify` trên 4 fixture hiện có; (b) trả phí: A/B trước-sau S1–S2 (và S5 nếu đã làm); solo cho S2, delegated có Herdr cho S1 |
| Mục tiêu đo | recall, precision, FP, chi phí mỗi run, số turn, tỉ lệ run hợp lệ. Baseline W: $0,041/run, 21,6 turn, 15/16 hợp lệ; ngưỡng không-hồi-quy do owner chốt (Q8) |
| Giới hạn | fixture hiện có chỉ là 4 thư mục source; không có fixture url, native hay firmware; nhóm SESS, ATHN, CLNT không có fixture, nên "độ phủ WSTG" chỉ là độ phủ tài liệu (S4), **không** là khả năng phát hiện |
| Chi phí | solo ≈ $0,66 cho 16 run (đã đo ở W); delegated **UNVERIFIED** (chưa có số): chạy thử 2 run trước |
| Rủi ro | không dùng provider `openai-codex-account-*` cho chạy tự động (proxy ghi lại `auth.json`); ô nhiễm fixture (cảnh báo ở `bench/README.md`) |
| Phụ thuộc | S1, S2 đã triển khai; sự đồng ý của owner |
| Hoàn thành | receipt cục bộ trong `bench/results/` và tóm tắt trong docs; không tuyên bố cải thiện nếu hai nhóm chồng lấn trong dao động đo |

---

## E. Non-goals

- Không sửa code, skills, prompts, tests trong lượt lập kế hoạch này; không commit; không `pi update` hay cài lại.
- Không thêm chính sách chặn hay hỏi trước khi mutation (W6b đã bị bỏ); không thêm tool, tool browser, trường hay trạng thái schema.
- Không thêm tên tool vào prompt lead; không đổi prompt nếu không cập nhật hash và ngưỡng ghim cùng lúc.
- Không mở rộng `toolGuidance` (đang tắt vì +73% chi phí không tăng chất lượng).
- Không chép nội dung strix, ARTEX hay WSTG vào skills; `my_references/` chỉ đọc, không chạy, không import, không đóng gói.
- Không nói "pentest tốt hơn" hay "phủ WSTG" khi chưa benchmark; mọi mục tiêu ở §D.0 là kích thước, nhất quán, độ phủ tài liệu.
- Không viết lại lịch sử `007ee58` và `7e204c3` (còn trailer cũ): chỉ owner quyết định.
- Không dùng `npm run test:herdr` và không chạy benchmark trả phí khi chưa được đồng ý.

---

## F. Câu hỏi mở

| # | Câu hỏi | Mặc định đề xuất |
|---|---|---|
| Q1 | Lead delegated: ghim ở mức hiện tại +2%, hay cắt khối recon của lead delegated thành "recon handoff" (−≈1,5 nghìn ký tự, cần benchmark delegated)? | ghim (S1) |
| Q2 | Role reporting có cần khối recon trong system prompt không (34% của 5.529)? | giữ cho tới khi đo |
| Q3 | `p2o_loop` (680 B) ở solo có dùng được không? | giữ |
| Q4 | Neo WSTG ở `master` (`INJT`) hay tag `v4.2` (`INPV`)? | `master` `28553f8`, ghi alias nếu cần |
| Q5 | Chuẩn cho native, kernel, hypervisor (CWE, SEI CERT...)? | để trống tới khi chọn và đọc trực tiếp |
| Q6 | Owner rà soát 108 phân loại D/T/N/O, nhất là các hàng T và N có thể thực ra đã có skill phù hợp | làm trong S4 |
| Q7 | Khóa `wstg-*`: quy ước hay lint cứng (từ chối khóa sai dạng)? | quy ước; lint cần thêm code, ngoài kế hoạch này |
| Q8 | Benchmark trả phí: model, ngân sách, có dùng Herdr delegated không, ngưỡng không-hồi-quy? | chờ owner |
| Q9 | Chương WebAssembly không có ID: tạo khóa tạm `wstg-wasm-*` hay để trống? | để trống |
| Q10 | Nhóm N lớn (SESS 11 / 11, ATHN 8 / 10, BUSL 7 / 10, CLNT 7 / 14, CRYP 3 / 4): viết playbook mới sau S6 hay chấp nhận N? Giá trị chưa đo, cần fixture | chưa quyết |

---

## G. Tái lập số đo

Các kịch bản dưới đây hiện nằm ở scratchpad của phiên làm việc (sẽ mất); S1 đề xuất đưa phần đo kích thước vào `scripts/measure-context.mjs`.

| Số đo | Cách tái lập |
|---|---|
| Kích thước prompt đã lắp (A.1) | biên dịch `src/prompts.ts` bằng `tsc` ra thư mục tạm, gọi `ownerInstructions`, `workerInstructions`, `workerBrief` với facts như `recon.test.ts:18-19`, đếm `.length` |
| Khai báo theo loadout (A5, A14) | nạp `dist/extensions/p2o/index.js` với Pi giả chỉ có `registerTool`, tính `Buffer.byteLength(JSON.stringify({name, description, parameters}))` như `workflow-policy.test.ts:26`; kết quả phải trùng 36.268 / 40.603 / 20.750 / 13.974 B |
| Trang skill, mô phỏng gộp workflow (A8, A11) | `new SkillLibrary(root).list(offset)` và `.read(id)` (`src/skills.ts`), sau đó thay workflow trùng bằng id |
| Trùng nguyên văn (A13) | shingle 6 và 8 từ giữa prompt, `HANDOFFS.md`, skills, docs và mô tả khai báo tool |
| Tên tool và loadout (A2, A10, A14) | so `p2o_[a-z_]+` trong prompt, skills, catalog với `OWNER_TOOLS`, `WORKER_TOOLS` và danh sách `registerTool` |
| Gọi tool thực tế (A5, A15) | đếm khối `toolCall` trong `bench/results/w-phase-20261010/**/*.messages.json` (48 run, cục bộ, gitignored) |
| Baseline benchmark (A12) | `bench/results/w-phase-20261010/all-rows.json` |
| WSTG (§B) | `git clone --depth 1 https://github.com/OWASP/wstg` (commit `28553f8`), rút ID từ bảng ID của từng trang trong `document/4-…`, đối chiếu `checklists/checklist.json`; phân loại D/T/N/O/B/I là thủ công |
