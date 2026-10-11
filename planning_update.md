# Hoạch định p2o: nâng bộ skills/workflow lên chuẩn OWASP WSTG (phân tích, ma trận phủ, lộ trình)

> **Chỉ lập kế hoạch** (2026-10-11, HEAD `6cfb89d`): chưa sửa `skills/`, `src/`, `tests/`, chưa commit/push/cài. Tài liệu này **thay** bản S0–S7 (đã triển khai; đọc ở `git show 6cfb89d:planning_update.md`; các bản cũ hơn ở `git show 41e8157:planning_update.md` và `git show 7e204c3:planning_update.md`). §13 được giữ nguyên bên dưới vì `tests/minimal/acceptance-matrix.test.ts` đọc nó. Các trích dẫn "§D" của `docs/ACCEPTANCE_MATRIX.md:92` và "§0.1/§0.2" của `src/roles.ts:35`, `docs/VERIFICATION_LOG.md` trỏ tới các bản cũ đó; chưa sửa trong lượt này (việc X0.2).

> Nhãn bằng chứng: **MEASURED** (đo lại được, có lệnh hoặc file:dòng), **SOURCE-CONFIRMED** (đã đọc trực tiếp nguồn), **DESIGN-INFERENCE** (suy luận thiết kế), **UNVERIFIED** (chưa kiểm). Ký tự là độ dài chuỗi JS, B là byte. WSTG viết tắt cho OWASP Web Security Testing Guide, bản `master` `28553f878d48358767892916d53e59a9d664811c` (2026-10-10).

## Tóm tắt

1. **Cây đang đỏ vì hai việc không thuộc kế hoạch này (MEASURED):** `skills/wstg/` (bản raw 5,2 MB, 193 file) nằm trong thư mục mà `scripts/validate_library.py` quét, nên validator báo 156 lỗi (158 khi tính cả M1; `check:library` đỏ); `planning_update.md` bị xóa nên `acceptance-matrix.test.ts` fail (ENOENT) và hai link (README.md, `research/runtime/planner-engine/README.md`) gãy. Hệ quả: `npm test` đỏ ở cả hai chỗ. Đề xuất dời bản raw sang `my_references/wstg/` (X0.1), không đóng gói.
2. **Bản raw giống từng byte upstream `master` `28553f8`** (chương 4 và 5), và 108 ID test còn hiệu lực khớp 100% với `docs/WSTG_MAP.md` (MEASURED). Giấy phép upstream là CC BY-SA 4.0 (đọc LICENSE trực tiếp), nên "chắt lọc" phải viết lại bằng lời của p2o, trích dẫn ID, không chép văn bản.
3. **Ma trận phủ chấm lại có bằng chứng:** Đủ 21 / Một phần 40 / Thiếu 43 / Ngoài phạm vi 4. Bản đồ S4 ghi 26/35/43/4; 5 test `D` bị hạ xuống `T` vì skill được gán không nêu lớp lỗi ở thân văn bản (IDNT-01, INJT-04, INJT-13, INJT-15, BUSL-05). "Đủ" nghĩa là đủ tri thức phương pháp, không phải khả năng phát hiện (**UNVERIFIED**).
4. **Khoảng trống lớn nhất:** Session 11/11 thiếu, Authentication 8/10 thiếu, Business Logic 7/10 thiếu, Client-side 7/14 thiếu, Configuration 4/13 thiếu; Injection có 15/22 test chỉ mới có kỹ thuật chung (không có thẻ riêng cho SQL, XML, lệnh, SSRF); Identity Management, GraphQL, WebAssembly và pha Reporting chưa có hướng dẫn riêng.
5. **Đề xuất (§D):** 9 playbook mới (sở hữu 75 test) + 7 mục bổ sung vào skill hiện có (6 test được nâng mức; một mục cho pha Reporting), mỗi test WSTG có **đúng một** chủ sở hữu; không tool, trường, trạng thái schema hay dòng nào trong lead prompt. Mỗi skill nhỏ (SKILL.md ≤ 7.000 ký tự, thẻ test nằm ở `references/` đọc theo yêu cầu).
6. **Hai rào cản kỹ thuật phải làm trước (X0):** provenance hiện chỉ cho **một** upstream (Apache-2.0, `validate_library.py:439`), nên skill dẫn xuất từ WSTG (CC BY-SA 4.0) cần schema v2; và bản đồ phải được chấm lại (X0.4).
7. **Phát hiện đo được ngoài dự kiến:** Chromium 150 headless chạy được trong chính sandbox đã ghim (read-only, cap-drop ALL, uid 65532, không mạng) và thực thi JS. p2o chủ ý không có transport trình duyệt có quản lý, nên cờ B (20 test) vẫn đúng theo chính sách, nhưng "offline local browser run" khả thi với image hiện có (Q5).
8. **Lộ trình X0–X5:** X0 nền và guard; X1 hygiene, session, credential và các bổ sung nhỏ (41 test, ít rủi ro nhất); X2 injection, logic, token; X3 trình duyệt và API; X4 crypto và báo cáo; X5 đo lường nâng cao chỉ khi owner cho phép. Đích: **Đủ 102/108**, Một phần 2 (INFO-04, INFO-10), Ngoài 4.
9. **Không tuyên bố hiệu quả pentest.** Nghiệm thu chỉ bằng kiểm tra miễn phí (validator, test cấu trúc, đo kích thước); benchmark trả phí vẫn bị cấm.
10. **Cần chốt 12 quyết định (§F.2)**, quan trọng nhất: vị trí bản raw, lập trường giấy phép, schema provenance v2, chính sách trình duyệt, và mức mutation cho các test có tác dụng phụ.

## Mở đầu: tình trạng cây và nguồn đã đọc

| # | Phát hiện | Bằng chứng | Nhãn |
|---|---|---|---|
| M1 | `planning_update.md` đã bị xóa khỏi cây làm việc (còn ở `HEAD`) | `git status`: ` D planning_update.md`. `npx vitest run tests/minimal/acceptance-matrix.test.ts` fail với `ENOENT ... planning_update.md`; `validate_library.py` báo `README.md: broken local link planning_update.md` và `research/runtime/planner-engine/README.md: broken local link ../../../planning_update.md` | MEASURED |
| M2 | `skills/wstg/` làm hỏng validator và `npm test` | 193 file (151 md, 42 ảnh, 5,2 MB); `scripts/validate_library.py` in 156 dòng FAIL thuộc `skills/wstg/` (158 khi `planning_update.md` còn thiếu, M1): ≥83 `prohibited executable recipe fence`, 38 `document exceeds focused reading budget`, 8 `CVE-specific skill content`, 8 `source-specific endpoint`, link và anchor gãy tới `6-Appendix/`. Nguyên nhân: `validate_library.py:726` lấy mọi `skills/**/*.md`; quy tắc ở `:60-68` cấm code fence, CVE, IP-URL, hex; `:808` giới hạn 1.500 từ. `package.json` chạy `check:library` trong `npm test`, và `tests/test_library.py:128` khẳng định `validate(ROOT) == []`. `files` của package gồm `skills/` nên bản raw sẽ bị đóng gói. Kiểm chứng: bản sao repo **không có** `skills/wstg/` (và có `planning_update.md` mới) cho `validate_library.py` `PASS` và `python3 -m unittest tests.test_library` OK (106 test, 2 skipped); trong cây thật, `npx vitest run` toàn bộ 482 passed / 12 skipped | MEASURED |
| M3 | Bản raw = upstream `master` `28553f8` | `diff -rq` giữa `skills/wstg/{4-Web_Application_Security_Testing,5-Reporting}` và bản shallow clone `OWASP/wstg` (đọc ngày 2026-10-11, `HEAD` upstream vẫn `28553f8`, 2026-10-10): rỗng. Thiếu `6-Appendix` nên 3 link `../../6-Appendix/*` gãy. Bản raw không kèm LICENSE; `LICENSE` upstream là Attribution-ShareAlike 4.0 International | MEASURED |
| M4 | 108 ID test còn hiệu lực không trôi | Tách ID từ bảng ID mỗi trang: 108 ID, 9 trang stub (`This content has been merged/removed`: INFO-09, CONF-03, CONF-08, IDNT-05, ATHN-01, INJT-03, INJT-13 bản Buffer Overflow, ERRH-02, CLNT-08); tập ID trùng khớp tập ID của `docs/WSTG_MAP.md` (0 thừa, 0 thiếu) | MEASURED |
| M5 | Sandbox đã ghim có sẵn nhiều công cụ web, kể cả trình duyệt | Image local `ghcr.io/usestrix/strix-sandbox` có repo digest `sha256:f6906c3114e5…` đúng bằng digest ghim ở `scripts/setup-sandbox-tools.sh:11`. Probe với cờ như `src/sandbox.ts:12-17` (read-only, cap-drop ALL, no-new-privileges, uid 65532, tmpfs, `--network none`): có `curl`, `openssl`, `python3` 3.13 (requests, httpx, websockets, PyJWT, bs4, lxml, cryptography), `node` 24 (WebSocket, WebAssembly, fetch), `jq`, `nc`, `dig`, `sqlmap` 1.10.6, `ffuf`, `nuclei`, `nmap` cùng các NSE `ssl-enum-ciphers`, `http-security-headers`, `http-cors`, `http-cookie-flags`, `http-methods`, `http-enum`, `http-git`, và **Chromium 150**. Không có `sslscan`, `testssl.sh`, `sslyze`, `websocat`, `wabt`, `semgrep`, Playwright. `nmap` thất bại `exec ... Operation not permitted` (file capability bị cap-drop chặn), khớp lời cảnh báo ở `docs/HTTP_TRANSPORT.md`. Chromium `--headless=new --no-sandbox --dump-dom` trên trang `data:` chạy JS và in `p2o-dom-ok:42` | MEASURED (probe tại máy owner, không mạng) |
| M6 | OWASP Top 10 2025 | Đọc `top10.owasp.org/2025`: A01 Broken Access Control, A02 Security Misconfiguration, A03 Software Supply Chain Failures, A04 Cryptographic Failures, A05 Injection, A06 Insecure Design, A07 Authentication Failures, A08 Software or Data Integrity Failures, A09 Security Logging and Alerting Failures, A10 Mishandling of Exceptional Conditions. Chỉ 4/108 trang WSTG trích một hạng mục `A0x:2025` (A01, A04, A05), nên Top 10 không phải chỉ mục của WSTG; ở đây chỉ dùng làm tín hiệu ưu tiên (§E) | SOURCE-CONFIRMED |
| M7 | Cơ chế skill, cổng và ngân sách đã chốt | Playbook cần 11 mục (`validate_library.py:27`), `provenance_refs` và ≥ 1 reference được liên kết; skill kỹ thuật cần ≥ 3 nguồn blog độc lập nên **không** dùng cho nội dung WSTG; `non-blog skill cites blog source` (`:801`); ≤ 3 skill mỗi task (`docs/SKILL_RUNTIME.md`); 600 tài liệu tối đa (`src/skills.ts:48` và validator), hiện 141; trang đầu 8 KiB được inline vào brief worker (`extensions/p2o/index.ts:359`) | SOURCE-CONFIRMED |
| M8 | Chỉ ghim §13 | Test duy nhất đọc `planning_update.md` là `acceptance-matrix.test.ts` (22 hàng ở §13.1, 7 gạch đầu dòng ở §13.3). Các chỗ khác chỉ trích dẫn bằng chữ (`src/wstg-map.ts:8`, `src/roles.ts:35`, README, docs); `research/runtime/planner-engine/installed.json:116` chứa hash cũ của file như biên nhận lịch sử, không test nào đọc | SOURCE-CONFIRMED |

Giới hạn của lần đọc này: **không đọc lại `my_references/`** (một lệnh liệt kê thư mục bị bộ phân loại an toàn chặn, nên tôi không chạy lại); phần so sánh với strix và ARTEX ở §D.1 dùng kết luận đã đo ở bản trước (`git show 6cfb89d:planning_update.md`, §C), chưa đọc bổ sung. Chưa đọc từng "How to Test" của 108 test ở mức câu; thẻ test sẽ cần đọc chúng khi triển khai (X1 trở đi).

---

## A. Phân tích framework WSTG

### A.1. Cấu trúc theo nhóm (đo trên bản raw)

| Mục | Thư mục | md | Kích thước | Test hiệu lực | Ghi chú |
|---|---|---|---|---|---|
| 4.0 | `00-Introduction_and_Objectives` | 1 | 4.715 B | 0 | phương pháp luận, không có ID |
| 4.1 | `01-Information_Gathering` | 12 | 126.358 B | 9 (`INFO`) | + 1 stub (INFO-09), 1 trang tổng quan |
| 4.2 | `02-Configuration_and_Deployment_Management` | 16 | 176.809 B | 13 (`CONF`) | + 2 stub (CONF-03, CONF-08) |
| 4.3 | `03-Identity_Management` | 6 | 22.148 B | 4 (`IDNT`) | + 1 stub (IDNT-05) |
| 4.4 | `04-Authentication` | 12 | 85.749 B | 10 (`ATHN`) | + 1 stub (ATHN-01) |
| 4.5 | `05-Authorization` | 8 | 69.404 B | 5 (`ATHZ`) | + 2 trang con OAuth (05.1, 05.2) |
| 4.6 | `06-Session_Management` | 12 | 111.657 B | 11 (`SESS`) | |
| 4.7 | `07-Injection` | 34 | 340.717 B | 22 (`INJT`) | + 2 stub (INJT-03, INJT-13 cũ), 9 trang con (SQL theo hệ CSDL 05.1–05.8, File Inclusion 11.1). Mã nhóm cũ `INPV` nay là `INJT` |
| 4.8 | `08-Error_Handling` | 3 | 6.654 B | 1 (`ERRH`) | + 1 stub (ERRH-02) |
| 4.9 | `09-Weak_Cryptography` | 5 | 33.130 B | 4 (`CRYP`) | |
| 4.10 | `10-Business_Logic` | 12 | 92.162 B | 10 (`BUSL`) | + trang tổng quan |
| 4.11 | `11-Client-side` | 17 | 89.753 B | 14 (`CLNT`) | + 1 stub (CLNT-08), 1 trang con (01.1 Self DOM XSS) |
| 4.12 | `12-API_Testing` | 7 | 77.800 B | 5 (`APIT`) | + trang tổng quan; ID cuối là `APIT-99` (GraphQL) |
| 4.13 | `13-WebAssembly_Testing` | 2 | 6.331 B | 0 | chỉ tổng quan, **không có ID** |
| 5 | `5-Reporting` | 3 | 19.782 B | 0 | cấu trúc báo cáo và sơ đồ đặt tên lỗ hổng |

Tổng: **108 test** trong 12 nhóm có ID, hơn 1,09 MB văn bản của các trang test, 42 ảnh (3,9 MB). Nhóm có nhiều test nhất: Injection (22), Client-side (14), Configuration (13), Session (11).

### A.2. Cấu trúc một trang test (108 trang hiệu lực)

| Phần | Số trang có | Dùng cho p2o |
|---|---|---|
| Bảng ID (`WSTG-<NHÓM>-<nn>`) | 108 (106 dạng bảng một cột) | khóa `questionKey` (đã dùng: `wstg-sess-03`) |
| Summary | 108 | ngữ cảnh; không chép |
| Test Objectives | 107 (CLNT-14 không có); tổng 236 gạch đầu dòng, trung bình 2,2, tối đa 6 | **phần có hành động nhất**: mỗi mục tiêu là một điều kiện kết luận |
| How to Test | 108 (107 viết "How to Test", 1 viết "How To Test") | nguồn của các bước và dấu hiệu quan sát; chứa payload, ví dụ dài, hướng dẫn công cụ (không mang theo) |
| Remediation | 56 | đã có skill `remediation`; chỉ trỏ nguyên tắc |
| References | 88 | ghi vào provenance, không chép |
| Tools | 64 | chỉ chọn công cụ có thật trong sandbox (M5), mỗi công cụ một câu |
| Related Test Cases | 14 | dùng làm cạnh handoff giữa các skill |

Kích thước trang: trung vị 8,2 KB, p90 17,3 KB, lớn nhất 44,6 KB (INJT-05 SQL Injection). Chắt lọc đúng nghĩa là giữ khoảng 20% (DESIGN-INFERENCE; mục tiêu, điều kiện kích hoạt, dấu hiệu phân biệt, cách kết luận, bằng chứng) và bỏ phần còn lại.

### A.3. Phương pháp luận (chương 4.0) so với p2o

| WSTG | p2o | Hệ quả cho thiết kế skill |
|---|---|---|
| Black-box: người kiểm thử có ít hoặc không có thông tin | p2o có thêm **white-box** (`source-review` trên bản sao mã nguồn) và bậc bằng chứng `static_trace`/`offline_reproduction`/`live_reproduction` | mỗi thẻ test phải nói rõ chế độ nào áp dụng và trần chứng minh của nó |
| Passive rồi active testing | recon (passive) → discovery → validation → reporting (`src/roles.ts`) | cột `Phase` của bản đồ đã mô tả; thêm điều kiện kích hoạt từ kết quả recon |
| 12 nhóm kiểm thử độc lập, không có thứ tự bắt buộc | `questionKey` + cell coverage cho từng (tài sản × câu hỏi × actor × tenant) | một test = một khóa; không cần kiểu "chạy cả nhóm" |
| Business logic "không tự động hóa được, cần sáng tạo" (`10-Business_Logic/00-…`) | p2o có quy tắc nguồn chính sách (`policyBasis`), suy diễn chỉ được `open_proof_gap` | skill logic nghiệp vụ phải bắt đầu từ nguồn chính sách, không từ payload |
| Công cụ tự động là phụ trợ | sandbox có `sqlmap`, `ffuf`, `nuclei` (M5) nhưng tài liệu R3/R4 đã loại payload catalog và dò tự động | mặc định không dùng scanner; xem Q7 |

### A.4. Quan hệ với Reporting (chương 5)

WSTG `5-Reporting/01-Reporting_Structure.md` đề xuất: (1) Giới thiệu (version, mục lục, đội, scope, giới hạn, timeline, disclaimer); (2) Executive Summary theo ngôn ngữ kinh doanh; (3) Findings gồm bảng tóm tắt (ID, tiêu đề, mức rủi ro) và chi tiết (ID, tiêu đề, khả năng khai thác, tác động, rủi ro **kèm thang được giải thích ở phụ lục**, mô tả, bước khắc phục, tài nguyên); (4) mục "Human Factors"; (5) "Reproducible Test Artifacts" (curl, PoC, HAR, script); (6) Phụ lục: phương pháp, thang rủi ro, đầu ra công cụ (đã làm sạch), **checklist các test đã làm** (liên kết tới `checklists/` của WSTG). `02-Naming_Schemes.md` mô tả CPE, SWID, PURL để định danh phần mềm. WSTG nói rõ đây là gợi ý cho báo cáo tư vấn, không phải quy tắc cứng. So sánh với `/p2o report export` hiện tại ở §B.5 và §C.

---

## B. Ma trận phủ: WSTG → skill hiện có → mức phủ

### B.1. Định nghĩa mức (dùng chung cho cả 108 test)

Giữ nguyên hệ thống `Support` đã được test ghim ở `src/wstg-map.ts` (không tạo hệ thống thứ hai) và đặt tên lại theo yêu cầu: **D = Đủ**, **T = Một phần**, **N = Thiếu**, **O = Ngoài phạm vi**. Điều kiện chấm (áp dụng cho văn bản thân của SKILL.md và các `references/`, không tính frontmatter):

| Mức | Điều kiện | Bằng chứng yêu cầu |
|---|---|---|
| Đủ | có đoạn gọi tên lớp lỗi hoặc đối tượng được kiểm của test **và** cho phương pháp, tiêu chí kết luận hoặc kiểm tra dương tính giả cho lớp đó, chạy được bằng ít nhất một workflow hiện có | trích file:dòng |
| Một phần | chỉ có phương pháp chung dùng lại được (dò nguồn tới sink, so sánh hai tầng phân tích, ma trận actor × đối tượng) hoặc chỉ nhắc lớp lỗi một dòng, nên worker phải tự bổ sung tri thức của lớp | nêu rõ phần còn thiếu |
| Thiếu | không đoạn nào nhắc đối tượng được kiểm | tìm kiếm văn bản rỗng |
| Ngoài | cần origin khác, DNS hoặc bên thứ ba (`src/prompts.ts` giới hạn scope vào origin đã xác nhận) | theo thiết kế |

"Đủ" là **đủ tri thức phương pháp**, không phải đủ để phát hiện lỗi (**UNVERIFIED** cho tới khi có benchmark được phép). Chấm bằng hai bước: quét từ khóa theo lớp lỗi trên toàn bộ `skills/**` (không tính `skills/wstg/`), rồi đọc các dòng trúng; kết quả từ khóa thô có nhiễu (chữ "trace", "options" trúng hàng trăm dòng không liên quan), nên **không** dùng số lần trúng làm bằng chứng, chỉ dùng dòng đã đọc.

### B.2. Ma trận theo nhóm (sau khi chấm lại)

Cột "S4" là bản đồ hiện có (`docs/WSTG_MAP.md`); cột "Nay" là kết quả chấm lại (B.3); cột "Đích" là mức khi toàn bộ §D hoàn tất. Mỗi ô là Đủ/Một phần/Thiếu/Ngoài.

| Nhóm | Test | S4 (Đủ/MP/Thiếu/Ngoài) | Nay | Đích | B | I | Skill hiện có chính | Khoảng trống chính |
|---|---|---|---|---|---|---|---|---|
| INFO Thông tin | 9 | 2/6/0/1 | 2/6/0/1 | 6/2/0/1 | 0 | 0 | `web-route-input-inventory`, `attack-surface-mapping` | fingerprint, metafile, rò nội dung trang (INFO-02,03,05,08); INFO-01 ngoài scope |
| CONF Cấu hình | 13 | 1/5/4/3 | 1/5/4/3 | 10/0/0/3 | 2 | 0 | `parser-differential-auditing` (CONF-13) | header, HSTS, giao diện quản trị, file sao lưu, cấu hình nền tảng, cờ tính năng; CONF-01,10,11 ngoài scope |
| IDNT Danh tính | 4 | 1/3/0/0 | 0/4/0/0 | 4/0/0/0 | 0 | 3 | `web-object-authorization` (một phần) | đăng ký, cấp tài khoản, liệt kê người dùng |
| ATHN Xác thực | 10 | 2/0/8/0 | 2/0/8/0 | 10/0/0/0 | 1 | 9 | `authorization-auditing`, `fastapi-security-parity` | mật khẩu mặc định, khóa tài khoản, đặt lại, MFA, câu hỏi bảo mật, nhớ đăng nhập |
| ATHZ Phân quyền | 5 | 3/1/1/0 | 3/1/1/0 | 5/0/0/0 | 0 | 4 | `web-object-authorization`, `authorization-auditing` | traversal (một phần), OAuth (thiếu) |
| SESS Phiên | 11 | 0/0/11/0 | 0/0/11/0 | 11/0/0/0 | 1 | 10 | không có | toàn bộ nhóm: token, cookie, cố định, đăng xuất, hết hạn, JWT, CSRF |
| INJT Injection | 22 | 10/12/0/0 | 7/15/0/0 | 22/0/0/0 | 2 | 1 | `web-output-context`, `deserialization-and-dispatch-auditing`, `parser-differential-auditing` | SQL, XML/XPath/LDAP, lệnh, SSRF, SSI, mail, CSV: chỉ có truy vết nguồn tới sink chung |
| ERRH Xử lý lỗi | 1 | 0/0/1/0 | 0/0/1/0 | 1/0/0/0 | 0 | 0 | không có | không có skill riêng |
| CRYP Mật mã | 4 | 0/1/3/0 | 0/1/3/0 | 4/0/0/0 | 0 | 0 | `source-code-auditing` (chung) | TLS, padding oracle, kênh không mã hóa, primitive yếu |
| BUSL Logic nghiệp vụ | 10 | 1/2/7/0 | 0/3/7/0 | 10/0/0/0 | 0 | 10 | `race-condition-auditing` (một phần) | dữ liệu, giả mạo request, toàn vẹn, quy trình, thanh toán, upload |
| CLNT Phía client | 14 | 3/4/7/0 | 3/4/7/0 | 14/0/0/0 | 14 | 0 | `web-output-context` (CLNT-01,02,03) | CORS, clickjacking, WebSocket, messaging, storage, XSSI, tabnabbing, chuyển hướng, CSS |
| APIT API | 5 | 3/1/1/0 | 3/1/1/0 | 5/0/0/0 | 0 | 2 | `web-route-input-inventory`, `web-object-authorization` | GraphQL (thiếu); lộ trường dữ liệu (một phần) |
| **Tổng** | **108** | **26/35/43/4** | **21/40/43/4** | **102/2/0/4** | **20** | **39** | | |

Đọc kết quả:

- **Nay: Đủ 21 (19%), Một phần 40 (37%), Thiếu 43 (40%), Ngoài 4 (4%).** 104 test thuộc scope; 61 có ít nhất một skill liên quan, 21 có skill gọi tên đúng lớp lỗi.
- Nhóm hầu như chưa có tri thức riêng: **SESS (0/11)**, **ATHN (2/10)**, **BUSL (0/10)**, **CRYP (0/4)**, **ERRH (0/1)**, **CLNT (3/14)**.
- Nhóm có skill nhưng chỉ ở dạng kỹ thuật chung: **INJT** (7 Đủ, 15 Một phần). Việc "dò dữ liệu tới sink" có sẵn (`data-flow-analysis`) nhưng không có tri thức riêng của từng bộ thông dịch (SQL, XML, lệnh hệ điều hành, URL fetch).
- Nhóm đã tốt: **ATHZ (3/5)**, **APIT (3/5)**: dùng `web-object-authorization` và `web-route-input-inventory`.

### B.3. Chấm lại so với bản đồ S4 (bằng chứng)

Bản đồ S4 chấm `D` theo **mô tả** skill. Khi đọc thân văn bản, 15/26 hàng `D` có câu gọi tên lớp lỗi hoặc đối tượng, 6 hàng khác trùng ý bằng chữ khác, và 5 hàng không có gì:

| Test | Skill được gán | Điều tìm thấy ở thân văn bản | Chấm lại |
|---|---|---|---|
| IDNT-01 Role Definitions | `web-object-authorization` | chỉ dùng "documented role" làm nguồn chính sách (`SKILL.md:23`); không có phương pháp lập kho vai trò, thử chuyển vai, đánh giá độ mịn quyền (mục tiêu của test) | D → **T** |
| INJT-04 HTTP Parameter Pollution | `parser-differential-auditing` | `SKILL.md:22-24` nói delimiter, độ dài, giá trị rỗng; chỉ một câu "repeated-field policy" trong `references/cache-selection.md:9` về khóa cache; không có phương pháp cho tham số lặp ở tầng ứng dụng | D → **T** |
| INJT-13 Format String Injection | `memory-safety-auditing` | `SKILL.md:3` nói biểu diễn số, vùng đệm, khởi tạo, vòng đời; không có "format string" hay conversion specifier ở bất kỳ skill nào | D → **T** |
| INJT-15 HTTP Response Splitting | `parser-differential-auditing` | không có CR/LF hay chèn header ở bất kỳ skill nào; chỉ có cách tiếp cận so sánh tầng chung (`SKILL.md:22-26`) | D → **T** |
| BUSL-05 Number of Times a Function Can Be Used | `race-condition-auditing` | `SKILL.md:3` là double-fetch, lock-drop, TOCTOU; giới hạn số lần dùng tuần tự (không cần đua) không được nêu | D → **T** |

Giữ `D`, đã xác nhận bằng chữ ở thân văn bản (15): INFO-06 (`web-route-input-inventory/SKILL.md:6,11`), INFO-07 (`references/route-inventory-method.md:3,17`), CONF-13 (`parser-differential-auditing/SKILL.md:20`, `references/cache-selection.md`), ATHN-04 (`authorization-auditing/SKILL.md:20`), ATHN-10 (`:24`), ATHZ-04 (`web-object-authorization/SKILL.md:20`), INJT-01 và INJT-02 (`web-output-context/SKILL.md:6,11`), INJT-16 (`parser-differential-auditing/SKILL.md:26`, chỉ ở mức "framing"), INJT-18 (`deserialization-and-dispatch-auditing/SKILL.md:14`), INJT-20 (`authorization-auditing/SKILL.md:24,31`), INJT-22 (`:30`), INJT-23 (`:6`), CLNT-01 (`web-output-context/SKILL.md:11`), APIT-01 (`web-route-input-inventory/references/route-inventory-method.md:7`). Giữ `D`, trùng ý bằng chữ khác (6): ATHZ-02 và ATHZ-03 (`web-object-authorization/SKILL.md:11`, `authorization-auditing/SKILL.md:24,27`), CLNT-02 và CLNT-03 (`web-output-context/SKILL.md:20`: "HTML text, quoted attribute, URL, script string, style rule"), APIT-02 và APIT-04 (`web-object-authorization/SKILL.md:11`).

Hai điểm cần owner xem lại (Q4): `APIT-03` (Excessive Data Exposure) vẫn `T` nhưng `web-object-authorization/SKILL.md:11` đã nêu "serializer field policy", gần như cùng đối tượng; và `INJT-16` được giữ `D` chỉ nhờ chữ "framing" (không có CL/TE, H2). Thêm mục `roles-and-field-exposure` ở §D.4 sẽ giải quyết cả IDNT-01, INJT-20 và APIT-03 mà không thêm skill.

### B.4. Khả năng thực thi hôm nay (độc lập với tri thức)

| Cách thực thi | Điều kiện | Số test bị ảnh hưởng | Trần chứng minh |
|---|---|---|---|
| `source-review` | có bản sao mã nguồn chỉ đọc | hầu hết (mọi test có đường mã hoặc cấu hình trong repo) | `static_trace` |
| HTTP ẩn danh cùng origin (`p2o_http`, `session: none`) | origin đã xác nhận | các test header, cookie, method, lỗi, metafile | `live_reproduction` |
| HTTP có danh tính (`p2o_http`, session đặt tên) | tài khoản do operator cấp (**cờ I: 39 test**) | SESS, ATHN, IDNT, BUSL, ATHZ, APIT-02/04 | `live_reproduction` |
| Mạng trong sandbox (`p2o_net`) | host:port đã xác nhận; công cụ người dùng tự cài hoặc có sẵn (`openssl`, Python `websockets`, Node `WebSocket`) | CRYP-01, CLNT-10, một phần CRYP-03 | `live_reproduction` (không lọc origin) |
| Trình duyệt | p2o **không** có transport có quản lý (`docs/SKILL_RUNTIME.md`, workflow `browser-execution-proof`) | **cờ B: 20 test** (19 chỉ B + SESS-05 là BI) | `offline_reproduction` |
| Ngoài phạm vi | DNS, tìm kiếm, origin khác | 4 test (INFO-01, CONF-01, CONF-10, CONF-11) | `not_applicable` |

Giao: 1 test vừa cờ B vừa cờ I (SESS-05). 50 test không cờ (46 trong scope + 4 Ngoài). Trình duyệt: xem M5 và Q5; Chromium có sẵn trong image cho phép chạy cục bộ bản sao fixture (là `offline_reproduction` theo định nghĩa hiện có), nhưng chạy qua shell thì không có ghim origin hay biên nhận có cấu trúc nên **không** được coi là `live_reproduction`.

### B.5. Pha Reporting: WSTG §5 so với `/p2o report export`

| Mục WSTG §5 | p2o hiện có | Mức |
|---|---|---|
| Version control, mục lục, đội | `## Provenance`: run, sequence, schema, runtime digest (`src/report-export.ts:104-109`) | Một phần (không có bảng phiên bản/tác giả; không áp dụng cho công cụ tự động) |
| Scope | exclusions và unknownScope của plan trong `## Coverage and gaps` (`:116`) | Đủ |
| Limitations, disclaimer | `## Limits of this report` (`:163-167`) và câu "Read this first" | Đủ |
| Timeline | không có | Thiếu (thấp) |
| Executive Summary theo ngôn ngữ kinh doanh | `## Summary` chỉ là bảng đếm (`:110`) | Thiếu; chủ ý không tự sinh (mô hình dễ nói quá) |
| Findings summary (ID, tiêu đề, **rủi ro có thang**) | `## Accepted current cases` (`:137`) | Một phần: có ID, tiêu đề, verdict; không có mức rủi ro |
| Findings detail (khả năng khai thác, tác động, rủi ro, mô tả, bước khắc phục, tài nguyên) | `caseSection` (`:47-55`): verdict, review, policy, tham chiếu bằng chứng, remediation trạng thái, lý do, giới hạn; `risk` chỉ là chuỗi tự do của worker (`src/evidence.ts:10`) | Một phần: thiếu khả năng khai thác, tác động, thang |
| Human Factors | không | Ngoài (p2o không kiểm con người, quyết định có từ trước) |
| Reproducible Test Artifacts | biên nhận lệnh/request, artifact giữ lại; không lưu giá trị header/body (`docs/HTTP_TRANSPORT.md`) | Đủ về thực chất, khác dạng (ID biên nhận, không phải lệnh curl) |
| Phụ lục: checklist test đã làm | mục `WSTG checklist` (`:70`, slice S6) | Đủ |
| Phụ lục: phương pháp, giải thích thang rủi ro | không có | Thiếu |
| Naming Schemes (CPE, SWID, PURL) | loại tài sản `package` có sẵn (`src/state/graph.ts:7`) nhưng không có quy ước định danh | Thiếu (tùy chọn) |

---

## C. Khoảng trống chưa được phủ

### C.1. Theo cụm kịch bản

"Test" là số test WSTG; "Đủ/MP/Thiếu" là mức hiện tại (Nay). Cột cuối là skill đề xuất ở §D.

| Cụm | Test (Đủ/MP/Thiếu) | Vì sao đáng làm | Ràng buộc thực thi | Skill đề xuất |
|---|---|---|---|---|
| **Identity Management** (IDNT-01..04) | 4 (0/4/0) | đăng ký, cấp tài khoản, liệt kê người dùng là cửa vào của A07 | tài khoản thử hoặc đăng ký mở; gửi email thật | `web-credential-lifecycle` (+ `roles-and-field-exposure`) |
| **Authentication** (ATHN-02,03,05,07,08,09,11) | 7 (0/0/7) + ATHN-06 | khóa tài khoản, đặt lại mật khẩu, MFA, mật khẩu mặc định | nguy cơ khóa tài khoản thật, email/SMS ngoài | `web-credential-lifecycle` |
| **Session Management** (SESS-01,02,03,04,06,07,08,09,11) | 9 (0/0/9) | 11/11 test không có tri thức nào | cần danh tính; chờ timeout dài | `web-session-management` |
| **Token và federation** (SESS-10, ATHZ-05) | 2 (0/0/2) | JWT/OAuth/OIDC phổ biến trong ứng dụng hiện đại | đúng origin của target, không tấn công IdP bên thứ ba | `web-token-and-federation` |
| **Server-side injection** (INJT-05..14,19,21, ATHZ-01) | 13 (0/13/0) | A05; chỉ có truy vết nguồn tới sink chung | probe trực tiếp có tác dụng phụ (SQL ghi, lệnh, SSRF) | `web-server-side-injection` |
| **Business Logic và upload** (BUSL-01..04,06..10) | 9 (0/2/7) | A06; WSTG nói rõ không tự động hóa được | cần nguồn chính sách; thanh toán, upload có tác dụng phụ | `web-business-logic-misuse` |
| **Client-side và kiểm soát cross-origin** (CLNT-04..07,09..15, SESS-05, CONF-12) | 13 (0/4/9) | CORS, CSRF, clickjacking, postMessage, storage | cờ B: chứng minh trình duyệt bị chặn | `web-browser-trust-controls` |
| **Cấu hình, lộ thông tin, header, TLS, lỗi** (INFO-02,03,05,08, CONF-02,04..07,09,14,15, ATHN-06, CRYP-01,03, ERRH-01) | 16 (0/9/7) | A02; chi phí thấp nhất, thụ động, hầu hết chỉ cần GET | TLS cần `openssl`/NSE; `nmap` có thể không chạy | `web-deployment-hygiene` |
| **API: GraphQL** (APIT-99) | 1 (0/0/1) | lược đồ tự mô tả, độ sâu/batching | không DoS | `web-graphql-testing` |
| **API: lộ trường dữ liệu** (APIT-03, INJT-20) | 2 (1/1/0) | trường đọc/ghi thừa | cần hai danh tính | bổ sung `web-object-authorization` |
| **Crypto sử dụng** (CRYP-02,04) | 2 (0/1/1) | primitive yếu, padding oracle | oracle trực tiếp rủi ro, có thể chỉ đọc nguồn | `web-crypto-usage-review` |
| **WebAssembly** (chương 13, không ID) | 0 test | khung khái niệm: import/export, bộ nhớ tuyến tính, bảng, WASI | chỉ có tổng quan | bổ sung `binary-auditing` |
| **Reporting** (WSTG §5) | 0 test | thang rủi ro, chi tiết finding, phụ lục phương pháp | báo cáo xuất tất định, không mô hình ẩn | bổ sung `remediation` (E7) + phụ lục xuất |

### C.2. Khoảng trống về cơ chế (không phải thiếu skill)

| # | Khoảng trống | Bằng chứng | Hướng xử lý |
|---|---|---|---|
| G1 | Provenance chỉ cho một upstream; mọi reference phải trùng giấy phép upstream | `validate_library.py:439` (`license differs from upstream`), `:413` (5–20 reference), `:420` (id `[RA]\d{1,2}`); `research/SKILL_PROVENANCE.json` có một khối `upstream` Apache-2.0 | schema v2 (X0.3) |
| G2 | Skill kỹ thuật không có workflow HTTP trực tiếp; nhiều test WSTG cần so sánh qua HTTP | catalog: các skill kỹ thuật chỉ có `source-review` và `offline-reproduction` (`skills/catalog.json`); `p2o_delegate` kiểm workflow theo skill được gán (`docs/SKILL_RUNTIME.md`) | thêm workflow `public-http-review` vào `parser-differential-auditing` (đã có ở `attack-surface-mapping`) |
| G3 | Lead không có cầu nối từ kết quả recon tới danh sách test cần lập kế hoạch | `shared:wstg-map` (S5) chỉ có ID, tên, mức, skill; không có điều kiện kích hoạt | thêm cột `Kích hoạt` và `Chế độ` (X0.4) |
| G4 | Thang rủi ro và chi tiết finding theo WSTG §5 | B.5 | skill báo cáo + phụ lục xuất |
| G5 | `p2o_skill_list` sắp playbook trước kỹ thuật, tối đa 8 mục mỗi trang, tìm theo tên và mô tả (`src/skills.ts:66-77`); thêm 9 playbook đẩy 17 skill kỹ thuật xuống trang 2–4 và kéo dài lượt duyệt | đo hôm nay: 21.659 ký tự cho 3 trang; mục playbook trung bình 1.273 ký tự (`skills/catalog.json`) | mô tả ngắn có mã nhóm WSTG để `query` tìm được; hoãn S3b đã nêu ở bản trước nếu vượt ngân sách (F.1 R4) |
| G6 | Không có cơ chế chặn hoặc hỏi trước khi mutation (W6b đã bị bỏ) | `docs/HTTP_TRANSPORT.md`: hộp thoại bắt đầu cho phép method ghi, body, xác thực cho cả run | mức mutation M0/M1/M2 chỉ ở dạng hướng dẫn trong Stop Conditions của skill (D.1) |
| G7 | Trình duyệt | M5, B.4 | quyết định Q5 trước X3 |
| G8 | Danh sách test của kế hoạch không có kiểm tra tự động | không có | test sở hữu duy nhất 108 test (X0.5) |

### C.3. Ngoài WSTG (không làm ở đây)

Top 10 2025 có hai hạng mục gần như không có test tương ứng trong WSTG: **A03 Software Supply Chain Failures** và **A09 Security Logging and Alerting Failures** (nhìn thấy khi đối chiếu M6; p2o không có dữ liệu lỗ hổng phụ thuộc offline, và nhật ký chỉ nhìn được qua cấu hình trong mã nguồn; `CONF-02` chỉ nhắc rà soát cấu hình nhật ký). Cũng ngoài phạm vi: SAML/SSO, tấn công bộ nhớ đệm web, đặc thù HTTP/2 ngoài INJT-16, overlay cho framework khác ngoài FastAPI (Express, Django, Spring, Rails, Laravel). Ghi lại để không bị hiểu là "đã phủ mọi kịch bản": mục tiêu ở đây là **108 test WSTG**, không phải mọi kịch bản có thể có.


---

## D. Đề xuất skill: tái sử dụng hay xây mới

### D.1. Khuôn mẫu, giới hạn và nguyên tắc chắt lọc

**Ánh xạ yêu cầu → cơ chế sẵn có** (không tạo cơ chế song song; mọi skill mới là `playbook`, vì `technique` đòi ≥ 3 nguồn blog độc lập và `Research Heuristics` có trích dẫn `B###`, không áp dụng được cho WSTG):

| Yêu cầu của brief | Đặt ở mục nào của playbook (`validate_library.py:27`) | Ràng buộc có sẵn |
|---|---|---|
| Điều kiện kích hoạt | Applicability | nêu sự kiện recon (D.5.2), không nêu tên tool |
| Input cần có | Workflow Prerequisites | mỗi workflow một dòng; mục này phải nhắc mọi workflow đã khai (`:475-480`) |
| Các bước | Baseline + Bounded Comparison | đổi **một biến** mỗi lần; làm kiểm soát trước |
| Tiêu chí kết luận | Controls + Expected Observations + False-Positive Checks | cần kiểm soát dương tính **và** âm tính (`:462-466`); `confirmed` cần `policyBasis` ≠ `inferred` |
| Bằng chứng cần thu | Evidence Fields | ≥ 3 quan sát có tên (`:470-472`) |
| Giới hạn an toàn | Stop Conditions | ≥ 2 quy tắc (`:467-469`) |
| Cách ghi vào state/report | Handoffs + thẻ test | khóa `wstg-*`, cell coverage, case, đồ thị; không trường mới |
| Phần chưa kiểm | Gaps | phải nêu "untested/gap" (`:473-474`) |

**Giới hạn cứng mà mọi skill mới phải qua** (đều do `scripts/validate_library.py` kiểm; mọi tài liệu dưới `skills/**`): frontmatter chỉ có `name` và `description` (20–1.024 ký tự, không chứa `": "`); ≤ 1.500 từ mỗi tài liệu (`:808`); không code fence, CVE, URL IP, hex `0x…`, chuỗi byte mã hóa, reverse shell (`:60-68`); không `TODO/TBD/FIXME`; không đoạn ≥ 18 từ trùng nguyên văn với tài liệu khác (`:810-816`); playbook không trích `B###` (`:801`); không tên `p2o_*` (guard `tests/minimal/skill-hygiene.test.ts`); mỗi reference nằm trong `skill.json` và được liên kết từ SKILL.md (`:481-483`); `provenance_refs` hợp lệ và reference phải ghi skill vào `used_by` (`:359-367`). Mục tiêu kích thước (đề xuất): SKILL.md ≤ 7.000 ký tự, vì trang đầu 8 KiB được inline vào brief của worker (`extensions/p2o/index.ts:359`); mỗi reference ≤ 6.000 ký tự (một trang đọc).

**Quy tắc chắt lọc (không chép WSTG):**

- **Giữ:** mục tiêu của test (đổi thành điều kiện kết luận), điều kiện tiên quyết, dấu hiệu phân biệt hành vi đúng với sai, kiểm soát, bằng chứng, giới hạn an toàn, liên hệ giữa các test (`Related Test Cases`, 14 trang).
- **Bỏ:** payload và chuỗi mẫu, hướng dẫn từng công cụ, ảnh chụp, ví dụ dài, cú pháp riêng của sản phẩm, đoạn Summary diễn giải.
- **Cách ghi nhận nguồn:** viết lại bằng lời của p2o, mỗi thẻ ghi ID WSTG như tham chiếu; ghi attribution theo đúng cách R1–R6 đã làm (tiêu đề tài liệu + sha256 của trang tại commit `28553f8`), với `usage_boundary` "chỉ để review, không có văn bản upstream nào được đóng gói". Lập trường pháp lý (CC BY-SA 4.0 cho phần dẫn xuất) cần owner chốt (Q2); **UNVERIFIED** về mặt pháp lý, đây không phải tư vấn pháp lý.

**Mức mutation** (chỉ là hướng dẫn trong Stop Conditions; không có cưỡng chế ở host vì W6b đã bị bỏ, và hộp thoại bắt đầu đã cho phép method ghi cho cả run theo `docs/HTTP_TRANSPORT.md`):

| Mức | Nghĩa | Quy tắc |
|---|---|---|
| M0 | chỉ đọc: GET, HEAD, OPTIONS, đọc nguồn | không cần xác nhận thêm |
| M1 | thay đổi đảo ngược được trong fixture do assessment tạo (đăng nhập, đăng xuất, tạo rồi xóa đối tượng của chính tài khoản thử) | nêu trong `decision` của task |
| M2 | hiển thị ra ngoài hoặc khó đảo ngược: email/SMS thật, khóa tài khoản không phải của mình, thanh toán, file upload còn lưu và có thể thực thi, probe có thể làm lệch kết nối dùng chung (request smuggling), tải lớn | chỉ khi văn bản task của operator xác nhận rõ; nếu không: `execution: blocked`, `closure: open_proof_gap` |

**Thẻ test** (đơn vị nội dung của `references/*.md`; mỗi thẻ ≤ 150 từ, tám dòng cố định; ba thẻ mẫu dưới đây viết dài hơn mức mục tiêu để dễ đọc, thẻ thật phải nén lại). Dòng đầu của mỗi file reference là `Tests: wstg-xxx-nn, …` để một test hermetic đối chiếu với bản đồ (X0.5).

| Dòng | Nội dung | Ánh xạ sang trường sẵn có |
|---|---|---|
| Kích hoạt | đặc điểm recon làm test này đáng lập kế hoạch | cột `Kích hoạt` của bản đồ |
| Đầu vào | tài sản, danh tính, nguồn chính sách cần có | workflow + cờ I |
| Bước | 3–6 bước, đổi một biến mỗi lần, kiểm soát trước | `methodFamily` = id workflow |
| Kết luận | khi nào `confirmed`, `ruled_out`, `open_proof_gap` | `closure`, `policyBasis` |
| Bằng chứng | các quan sát cần có biên nhận | `evidenceRefs`, `negativeControlRefs` |
| Ghi state | cell, case, tài sản, quan hệ cần tạo | `questionKey`, `policyKey`, loại tài sản |
| Dừng | giới hạn riêng của test (kèm mức M) | Stop Conditions |
| Dương tính giả | các trường hợp hay nhầm | False-Positive Checks |

**Ba thẻ mẫu** (diễn đạt lại để minh họa mức chắt lọc; không phải nội dung đã viết vào skill):

1. `wstg-sess-03` Session Fixation (skill `web-session-management`, thẻ `fixation-and-hijack`).
   - Kích hoạt: có token phiên được cấp **trước** đăng nhập và có luồng đăng nhập.
   - Đầu vào: một tài khoản do operator cấp; route đăng nhập; workflow `controlled-identity-comparison`.
   - Bước: (1) lấy token T0 bằng session đặt tên `pre`; (2) đăng nhập mang theo T0; (3) so token sau đăng nhập T1 với T0; (4) gọi một route cần đăng nhập bằng T0; (5) lặp với dạng token nhận qua URL nếu ứng dụng chấp nhận.
   - Kết luận: `confirmed` khi T1 = T0 hoặc T0 dùng được sau đăng nhập, kèm kiểm soát dương tính (route cần đăng nhập thành công với T1) và âm tính (T0 bị từ chối khi chưa đăng nhập); `ruled_out` khi T1 ≠ T0 và T0 bị từ chối, cả hai có biên nhận. `policyBasis`: `boundary_invariant` (định danh phiên phải đổi khi mức đặc quyền đổi).
   - Bằng chứng: ID biên nhận của bốn request, tên cookie và thuộc tính; **không** ghi giá trị token.
   - Ghi state: cell `wstg-sess-03` × tài sản route đăng nhập, `actorContext` `actor:user-a`, `methodFamily` `controlled-identity-comparison`.
   - Dừng (M1): không dùng token của người khác; không gửi tới origin khác.
   - Dương tính giả: phiên phi trạng thái như JWT (chuyển sang `web-token-and-federation`); proxy gán lại cookie.
2. `wstg-injt-05` SQL Injection (skill `web-server-side-injection`, thẻ `sql-nosql-orm`).
   - Kích hoạt: tham số chạm truy vấn (đặc điểm `db-query`) hoặc mã nguồn dựng truy vấn bằng nối chuỗi/ORM thô.
   - Chế độ ưu tiên: `source-review` tìm chỗ nối chuỗi; `offline-reproduction` dựng lại sink trên CSDL cục bộ; trực tiếp chỉ khi scope cho phép.
   - Bước (trực tiếp): (1) baseline hợp lệ và kiểm soát âm tính (giá trị vô hại khác); (2) đổi **một** thứ mỗi lần: thêm ký tự phá cú pháp, so status, độ dài, thông báo; (3) cặp biểu thức boolean luôn đúng/luôn sai, hành vi khác biệt ổn định ≥ 3 lần; (4) chỉ khi (3) không phân biệt: trễ có giới hạn ≤ 3 giây; (5) nhận diện hệ CSDL từ lỗi hoặc hàm phiên bản rồi **dừng** (không đọc dữ liệu, không ghi).
   - Kết luận: `confirmed` khi có hành vi khác biệt quy được cho bộ thông dịch và tái hiện được trên fixture cục bộ; lỗi 500 đơn lẻ chỉ là `open_proof_gap`. `policyBasis`: `boundary_invariant` (đầu vào không được đổi cấu trúc truy vấn).
   - Dừng (M1): không câu lệnh ghi hoặc xóa; không dùng công cụ khai thác tự động theo mặc định (Q7).
3. `wstg-conf-07` HTTP Strict Transport Security (skill `web-deployment-hygiene`, thẻ `headers-methods-and-transport`).
   - Kích hoạt: origin HTTPS đã xác nhận và có cookie phiên.
   - Bước: (1) GET gốc qua HTTPS, ghi `Strict-Transport-Security`; (2) so `max-age` và `includeSubDomains` với nguồn chuẩn operator chỉ định (mặc định tham chiếu một năm; phải ghi nguồn); (3) request HTTP cổng 80: có chuyển hướng cùng host sang HTTPS không, header HSTS **không** nên xuất hiện trên HTTP; (4) kiểm lớp route khác (lỗi, API, tĩnh).
   - Kết luận: thiếu header trên origin HTTPS có cookie nhạy cảm là phát hiện mức thấp; `ruled_out` chỉ cho các lớp route đã đo, kèm kiểm soát dương tính (cùng lớp route khác có header).
   - Dương tính giả: HSTS đặt ở CDN/edge; môi trường phát triển; thiếu header nhưng không có phiên nhạy cảm. Dừng (M0): chỉ đọc.

**So sánh với tham chiếu và nơi lệch** (kế thừa kết luận bản trước, §C cũ, chưa đọc lại `my_references/`):

| Điểm | WSTG / strix / ARTEX | Quyết định | Lý do lệch |
|---|---|---|---|
| Tổ chức tri thức theo lớp lỗi | strix: thư mục `vulnerabilities/`, `frameworks/`, `protocols/` (76 file) | Adapt: playbook theo cụm WSTG, thẻ theo test | WSTG đã có ID ổn định để khóa dữ liệu |
| Nạp skill cố định | strix luôn nạp 2 skill phân tích (≈14,8 KB mỗi agent) | Reject | p2o nạp theo task, ≤ 3 skill, `Lead prompt` không đổi |
| Tên tool trong skill/prompt | strix: 66 lần trong 21 file skill | Reject | `skill-hygiene.test.ts` cấm; giữ tri thức độc lập loadout |
| Bảng "agent làm được gì / không" | strix `owasp-top-10-testing` | Adopt (đã có: cờ B/I/O và `Support`) | giữ nguyên, thêm `Chế độ` |
| Danh mục payload, quét tự động | WSTG How to Test chứa payload; sandbox có sqlmap/ffuf/nuclei | Reject mặc định | nguồn R3/R4 đã loại payload catalog và dò tự động; validator cấm chuỗi mã hóa (Q7) |
| Ranh giới vai trò bằng bề mặt tool | ARTEX | Adopt (đã có `tool-policy.ts`) | mức mutation chỉ là hướng dẫn (G6) vì W6b bị bỏ |

### D.2. Tổng quan skill mới

| ID | Skill | Phase | Test sở hữu | Workflow (dùng lại id sẵn có) | Thẻ (reference) | Ước tính | Mutation tối đa |
|---|---|---|---|---|---|---|---|
| N7 | `web-deployment-hygiene` | X1 | 16 | `source-review`, `offline-reproduction`, `public-http-review`, `sandbox-network-review` (mới) | 5 | 35 KB | M0 |
| N1 | `web-session-management` | X1 | 9 | `source-review`, `offline-reproduction`, `public-http-review`, `controlled-identity-comparison` | 3 | 24 KB | M1 |
| N3 | `web-credential-lifecycle` | X1 | 10 | `source-review`, `offline-reproduction`, `authenticated-navigation` | 4 | 29 KB | M2 (khóa tài khoản, email) |
| N4 | `web-server-side-injection` | X2 | 13 | `source-review`, `offline-reproduction`, `public-http-review` | 7 | 46 KB | M1 |
| N2 | `web-token-and-federation` | X2 | 2 | `source-review`, `offline-reproduction`, `controlled-identity-comparison` | 2 | 18 KB | M1 |
| N5 | `web-business-logic-misuse` | X2 | 9 | `source-review`, `offline-reproduction`, `authenticated-navigation` | 4 | 29 KB | M2 (thanh toán, upload) |
| N6 | `web-browser-trust-controls` | X3 | 13 | `source-review`, `offline-reproduction`, `public-http-review`, `sandbox-network-review`, `browser-execution-proof` (nếu Q5 cho phép) | 4 | 29 KB | M1 |
| N8 | `web-graphql-testing` | X3 | 1 | `source-review`, `offline-reproduction`, `public-http-review` | 1 | 13 KB | M0 |
| N9 | `web-crypto-usage-review` | X4 | 2 | `source-review`, `offline-reproduction` | 2 | 18 KB | M0 |

Tổng: 9 playbook, 32 reference, khoảng 240 KB văn bản mới (DESIGN-INFERENCE: 7 KB cho mỗi SKILL.md cộng 5,5 KB cho mỗi thẻ), tức khoảng 22% của 1,09 MB trang WSTG nguồn. Catalog thêm 41 tài liệu (141 → 182, thêm 7 reference từ D.4 là 189; trần 600). `sandbox-network-review` là workflow mới duy nhất: "tương tác TCP/TLS/WebSocket có giới hạn với host:port đã xác nhận qua công cụ mạng sandbox; lệnh opaque không lọc origin nên chỉ gửi tới mục tiêu đã xác nhận". Các workflow khác dùng lại id đã có (nội dung điều kiện tiên quyết khớp từng chữ với skill đang giữ id đó, để không sinh biến thể mới).

### D.3. Đặc tả từng skill

Mỗi khối dưới đây là **hợp đồng** để viết skill, không phải nội dung skill. "Kích hoạt" lấy từ đặc điểm recon (D.5.2).

**N7 `web-deployment-hygiene`** (X1, role recon, 16 test: INFO-02,03,05,08; CONF-02,04,05,06,07,09,14,15; ATHN-06; CRYP-01,03; ERRH-01)

- Trách nhiệm duy nhất: xác định thứ triển khai **tự nói ra và tự rò ra**, và chính sách header/cookie/method/TLS nó khai báo, bằng ít request nhất. Không gửi payload tấn công.
- Kích hoạt: mọi origin đã xác nhận (luôn); bản sao nguồn có cấu hình máy chủ/ứng dụng.
- Bước cốt lõi: (1) bộ baseline cố định theo lớp route (gốc, đăng nhập, tài nguyên tĩnh, API, 404, 405) ghi status/header/cookie; (2) đối chiếu từng kiểm soát với chuẩn đã nêu (không "thiếu header = lỗi"); (3) metafile và file sao lưu chỉ theo danh sách tên đã quan sát (≤ 20 request, không từ điển); (4) lỗi: hai request sai chủ ý, so thân; (5) TLS bằng `openssl s_client` (giao thức, chuỗi chứng chỉ, thuật toán ký) và NSE `ssl-enum-ciphers` nếu `nmap` chạy được; (6) chế độ nguồn: cờ debug, thông tin đăng nhập mặc định, CORS, cờ cookie, cấu hình TLS, cờ tính năng.
- Kết luận: `ruled_out` chỉ với kiểm soát dương tính (cùng lớp route khác có kiểm soát); header thiếu là phát hiện chỉ khi có bối cảnh phơi nhiễm (ví dụ cookie nhạy cảm trên origin có thể hạ cấp).
- Dừng: không từ điển, không `ffuf`/`nuclei` mặc định; cấm NSE kiểu từ chối dịch vụ (`http-slowloris`); không thử xác thực.
- Dương tính giả: header do CDN/WAF chèn; môi trường staging; header chỉ có trên HTML.
- Handoff: `web-route-input-inventory` (route mới), `web-browser-trust-controls` (nghĩa của CSP/CORS), `remediation`.

**N1 `web-session-management`** (X1, role discovery, 9 test: SESS-01,02,03,04,06,07,08,09,11)

- Trách nhiệm: vòng đời của token phiên: cấp, thuộc tính, cố định, lộ, hủy, hết hạn, đồng thời.
- Kích hoạt: đặc điểm `session-token` (cookie hoặc header) và luồng đăng nhập/đăng xuất.
- Đầu vào: ≥ 1 tài khoản do operator cấp (2 cho đồng thời), route đăng nhập và đăng xuất.
- Bước cốt lõi: kho token (tên, vị trí, định dạng, thuộc tính); entropy và cấu trúc trên ≤ 30 token đã cấp (phân tích cục bộ, không dò); so định danh trước/sau đăng nhập; phát lại token cũ sau đăng xuất; hết hạn qua thuộc tính và hành vi máy chủ **có giới hạn thời gian chờ** (không chờ hàng giờ: nếu quá giới hạn, `open_proof_gap` và đọc chính sách từ cấu hình); chiếm phiên chỉ bằng cách phát lại **token của chính mình** từ ngữ cảnh thứ hai.
- Kết luận: theo thẻ mẫu 1; `policyKey` như `policy:session-invalidation-on-logout`.
- Dừng (M1): không dùng hay thu thập token người khác; không brute-force; ghi rõ giới hạn chờ.
- Dương tính giả: phiên phi trạng thái (JWT) → `web-token-and-federation`; SameSite mặc định của trình duyệt; token "nhớ tôi" khác loại.
- Handoff: `web-token-and-federation`, `web-browser-trust-controls` (CSRF), `authorization-auditing`.

**N3 `web-credential-lifecycle`** (X1, role discovery, 10 test: IDNT-02,03,04; ATHN-02,03,05,07,08,09,11)

- Trách nhiệm: cách một danh tính ra đời, được xác thực, bị khóa và được khôi phục.
- Kích hoạt: `registration`, `login`, `password-reset`, `mfa`, `remember-me`.
- Đầu vào: tài khoản thử do operator cấp hoặc đăng ký mở; hộp thư thử nếu kiểm tra đặt lại/MFA; chính sách mật khẩu được ghi nhận (nguồn bắt buộc).
- Bước cốt lõi: quy tắc tạo tài khoản và vai trò mặc định; liệt kê tài khoản qua khác biệt status/độ dài/thông báo/thời gian trên đăng nhập, đăng ký, đặt lại (có kiểm soát và số mẫu cố định); mật khẩu mặc định chỉ **mặc định đã công bố của sản phẩm đã nhận diện**, 1–3 lần mỗi tài khoản, không danh sách; khóa tài khoản: số lần thử **dưới** ngưỡng đã nêu, dừng khi có dấu hiệu khóa; đặt lại: đặc tính token (entropy, hết hạn, dùng một lần, gắn với tài khoản); câu hỏi bảo mật: chỉ đánh giá độ mạnh, không đoán; MFA: đường vòng qua kênh phụ.
- Kết luận: thiếu giới hạn tốc độ là phát hiện khi **không** có hạn chế nào sau số lần thử đã cố định; chính sách chỉ suy diễn → `open_proof_gap`.
- Dừng (M2): không thử trên tài khoản không thuộc fixture; không gửi email/SMS tới địa chỉ ngoài hộp thư thử; không từ điển mật khẩu; một lần khóa ngoài kế hoạch là dừng.
- Handoff: `web-session-management`, `authorization-auditing`, `remediation`.

**N4 `web-server-side-injection`** (X2, role discovery, 13 test: INJT-05,06,07,08,09,10,11,12,13,14,19,21; ATHZ-01)

- Trách nhiệm: đầu vào không tin cậy đổi cấu trúc của một bộ thông dịch phía máy chủ (SQL/NoSQL/ORM, XML/XPath/LDAP, shell/mã/SSI, đường dẫn, URL gọi ra, thư, bảng tính, chuỗi định dạng). Khác `web-output-context` (đầu ra trình duyệt) và `deserialization-and-dispatch-auditing` (chọn kiểu/hàm).
- Kích hoạt: đặc điểm `db-query`, `xml-input`, `os-command`, `file-path`, `outbound-fetch`, `mail-send`, `export-csv`, `template-render`, hoặc sink tương ứng trong nguồn (recon của `web-route-input-inventory`).
- Phương pháp lõi dùng chung: **thăm dò vi sai bằng điểm đánh dấu vô hại** (cặp đầu vào tương đương/bất tương đương, biểu thức cho giá trị phân biệt, trễ có giới hạn); ưu tiên `source-review` để tìm sink rồi `offline-reproduction` trên bản dựng cục bộ (đã có `python3` và `node`; mô-đun `sqlite3` chuẩn của Python: chưa kiểm); trực tiếp chỉ khi scope cho phép. SSRF không có OAST (p2o không cung cấp): chứng minh bằng listener do sandbox sở hữu nếu định tuyến cho phép, ngược lại `open_proof_gap`.
- Kết luận: `confirmed` cần hành vi khác biệt quy được cho bộ thông dịch, kiểm soát âm tính, và tái hiện cục bộ; một lỗi 500 đơn lẻ là gợi ý.
- Dừng (M1): không đọc dữ liệu quá một giá trị phân biệt (phiên bản/đếm), không ghi/xóa, không gọi ra ngoài trừ listener sandbox, không dump; scanner tự động chỉ khi Q7 cho phép.
- Dương tính giả: WAF chặn tạo lỗi; phản xạ không diễn giải; cache.
- Handoff: `data-flow-analysis`, `parser-differential-auditing` (HPP), `exploitability-assessment`, `remediation`.

**N2 `web-token-and-federation`** (X2, 2 test: SESS-10, ATHZ-05)

- JWT: phân tích cấu trúc cục bộ (PyJWT có sẵn trong sandbox), xử lý `alg`, `kid`/`jwk`, `exp`/`aud`/`iss`, và kiểm tra chữ ký bằng cách gửi **token tự giữ** đã sửa tới đúng origin; không đoán bí mật ngoài bí mật mặc định đã công bố.
- OAuth/OIDC: kiểm `redirect_uri` khớp chính xác, `state`/`nonce`, PKCE, phạm vi, rò token qua referrer, luồng implicit; chỉ trên endpoint của target, không tấn công IdP bên thứ ba. SAML ngoài phạm vi (C.3).
- Dừng (M1): chỉ với client đã đăng ký cho assessment.

**N5 `web-business-logic-misuse`** (X2, 9 test: BUSL-01,02,03,04,06,07,08,09,10)

- Bắt đầu từ **nguồn chính sách** (tài liệu hoặc lời operator), không từ payload: bảng bất biến × bước × quy tắc kỳ vọng × ca lạm dụng; chọn ca có giới hạn; chạy trong fixture; upload dùng tệp lành tính có dấu hiệu văn bản (kiểm loại tệp, phần mở rộng kép, kiểu nội dung, kích thước, vị trí lưu, có thực thi không), không bao giờ tệp thực thi; thanh toán chỉ ở chế độ thử.
- Kết luận: vi phạm cần chính sách `explicit_contract`; suy diễn → `open_proof_gap` (đã là quy tắc của `evidence.ts`).
- Dừng (M2): dừng trước mọi giao dịch tài chính hoặc đơn hàng thật; vòng lặp vượt giới hạn có số lần cố định.
- Handoff: `race-condition-auditing` (BUSL-05 khi đua), `state-and-lifetime-auditing`, `web-object-authorization`.

**N6 `web-browser-trust-controls`** (X3, 13 test: SESS-05, CONF-12, CLNT-04,05,06,07,09,10,11,12,13,14,15)

- Trách nhiệm: những gì máy chủ **nói cho trình duyệt** về tin cậy chéo origin và những gì mã phía trình duyệt làm với đầu vào.
- Phần quan sát được từ phía máy chủ là chứng minh trực tiếp (CORS qua `Origin` giả, nhận request đổi trạng thái thiếu token CSRF/Origin lạ, kiểm tra Origin khi nâng cấp WebSocket, CSP và `frame-ancestors`): `live_reproduction` hợp lệ vì hành vi máy chủ là thứ được chứng minh. Phần cần trình duyệt (thực thi chuỗi khai thác): trần `offline_reproduction`, nếu Q5 cho phép thì chạy Chromium cục bộ trên bản sao fixture.
- Rà tĩnh JS (nguồn hoặc bundle tải về): sink chuyển hướng, CSS, tài nguyên, bộ xử lý `postMessage` kiểm Origin, lưu trữ nhạy cảm, `target=_blank` thiếu `noopener`, mẫu phía client.
- Dừng (M1): không tương tác origin thứ ba; không dựng trang tấn công công khai.

**N8 `web-graphql-testing`** (X3, 1 test: APIT-99): trạng thái introspection, gợi ý trường, giới hạn độ sâu/độ phức tạp/batching/alias (có chặn trên nhỏ, không truy vấn gây từ chối dịch vụ), kiểm soát truy cập theo trường (chuyển cho `web-object-authorization`), tham số truyền vào (chuyển cho N4), CSRF qua GET, điểm cuối gỡ lỗi. Mutation M0.

**N9 `web-crypto-usage-review`** (X4, 2 test: CRYP-02, CRYP-04): primitive yếu (băm không phù hợp, chế độ khối không an toàn, IV tĩnh, khóa viết cứng, nguồn ngẫu nhiên không mật mã, mật mã tự chế), padding oracle bằng phát hiện tĩnh (CBC có lỗi padding phân biệt được) và, nếu owner cho phép, một kiểm tra oracle có giới hạn; mặc định chỉ `source-review` và `offline-reproduction`. Mutation M0.

### D.4. Bổ sung vào skill hiện có (tái sử dụng)

| ID | Skill | Thay đổi | Test được nâng | Dư địa từ (cap 1.500) | Ghi chú |
|---|---|---|---|---|---|
| E1 | `web-object-authorization` | thêm `references/roles-and-field-exposure.md`: kho vai trò, thử chuyển vai (IDNT-01), ghi trường không được ghi (INJT-20), đọc trường thừa (APIT-03); một dòng liên kết trong SKILL.md | IDNT-01, APIT-03 (INJT-20 đã Đủ) | 162 | chỉ đủ chỗ cho một dòng liên kết; cần provenance W (X0.3) |
| E2 | `parser-differential-auditing` | thêm `references/http-framing-and-parameters.md`: tham số lặp, chèn CR/LF vào header, phát hiện lệch khung an toàn (INJT-16 giữ ở mức phát hiện, **không** xác nhận bằng đầu độc hàng đợi); thêm workflow `public-http-review` vào catalog | INJT-04, INJT-15 | 696 | smuggling thật là M2 |
| E3 | `attack-surface-mapping` | mở rộng `references/intermediary-trust.md`: tin cậy `Host` và `X-Forwarded-*` | INJT-17 | 929 (reference) | |
| E4 | `race-condition-auditing` | thêm `references/usage-limit-bypass.md`: giới hạn số lần dùng cả tuần tự lẫn đua | BUSL-05 | 854 | |
| E5 | `web-route-input-inventory` | thêm `references/workflow-paths.md`: lập bản đồ luồng nhiều bước (điều kiện tiên quyết của BUSL-06) | không đổi mức | 316 | tùy chọn, X3 |
| E6 | `binary-auditing` | thêm `references/webassembly-modules.md`: import/export, bộ nhớ tuyến tính, bảng và `call_indirect`, không ASLR trong module, WASI; phân tích bằng `WebAssembly` của Node (có sẵn, M5), không có `wabt`; liên kết từ `memory-safety-auditing` | chương 13 (không ID) | 680 | không tạo ID tạm (Q12) |
| E7 | `remediation` | thêm `references/risk-rating-criteria.md`: thang Informational/Low/Medium/High/Critical, khả năng khai thác × tác động, khi nào "chưa đánh giá"; cộng với phụ lục xuất (D.5.4) | pha Reporting | 654 | |

### D.5. Tích hợp vào workflow recon → kiểm → xác minh → báo cáo

**D.5.1. Luồng** (mọi thứ dùng công cụ và trường sẵn có):

| Giai đoạn | Việc | Công cụ/skill đã có | Thêm vào |
|---|---|---|---|
| Recon | lập kho route/tham số; ghi tài sản `endpoint`, `config`, `identity`; ghi **đặc điểm** quan sát được | `web-route-input-inventory`, `attack-surface-mapping`, `p2o_graph`, `p2o_note` | từ vựng đặc điểm trong `HANDOFFS.md` (X0.4) |
| Lập kế hoạch | lead đọc `shared:wstg-map`, chọn test có `Kích hoạt` đúng, tạo plan coverage: cờ O → `not_applicable`; cờ I thiếu danh tính → `blocked` kèm gap; cờ B → trần `offline_reproduction` | `p2o_coverage`, `p2o_task` | hai cột mới của bản đồ |
| Kiểm | giao việc với `work.questionKey = wstg-…`, một skill chủ sở hữu (+ ≤ 2 skill phụ), workflow theo điều kiện thực tế | `p2o_delegate`, `p2o_skill_read` | không |
| Xác minh | validator độc lập; `policyBasis` ≠ `inferred`; mức L0–L3 qua `wstgEvidence` | `p2o_candidate`, `p2o_case` | không |
| Báo cáo | phụ lục WSTG (S6), phụ lục thang rủi ro (E7) | `/p2o report export` | xem D.5.4 |

**D.5.2. Từ vựng đặc điểm (đề xuất, 25 mã chữ thường, không đổi schema):** `login`, `session-token`, `registration`, `password-reset`, `mfa`, `remember-me`, `jwt`, `oauth`, `upload`, `xml-input`, `template-render`, `outbound-fetch`, `db-query`, `os-command`, `file-path`, `mail-send`, `export-csv`, `websocket`, `graphql`, `payment`, `workflow`, `cors`, `frames`, `postmessage`, `client-storage`. Ghi như thuộc tính tài sản (`attributes.feature`) hoặc câu của `fact` (`observed`). Bản đồ thêm hai cột: `Kích hoạt` (đặc điểm nào đủ để lập kế hoạch test) và `Chế độ` (`S` nguồn, `H` HTTP ẩn danh, `A` HTTP có danh tính, `N` mạng sandbox, `B` cần trình duyệt). Kích thước `shared:wstg-map` tăng khoảng +4 K ký tự, vẫn đọc theo yêu cầu (+0 B chi phí cố định).

**D.5.3. Lời khuyên workflow nằm ở `promptGuidelines`, không ở lead prompt.** Lead prompt không đổi một byte (`recon.test.ts` ghim cỡ và hash; 5 biến thể lead đã có trần). Hai dòng đề xuất cho `TOOL_GUIDELINES` (`src/tool-guidelines.ts`), ≤ 400 B tổng, bật bởi `p2o.toolGuidance` (mặc định `false`) và tăng `POLICY_VERSION` lên 2:

- `p2o_coverage`: khi một cell trả lời một test WSTG, dùng ID chữ thường (ví dụ `wstg-sess-03`) làm `questionKey` và id workflow làm `methodFamily`; skill sở hữu nằm ở `shared:wstg-map`.
- `p2o_task`: đặt khóa WSTG vào `work.questionKey` để kiểm tra trùng áp dụng, và gán skill mà `shared:wstg-map` nêu cho test đó.

Cảnh báo bằng chứng: benchmark W cho thấy guidance **tăng chi phí 73% mà không tăng chất lượng** (`docs/USAGE.md:379`, bản trước §0.2). Vì vậy mặc định vẫn là quy ước ở `HANDOFFS.md` và `shared:wstg-map` (chi phí cố định bằng 0); hai dòng guidance chỉ là tùy chọn, và nếu thêm phải cập nhật ngân sách `workflow-policy.test.ts` có chủ đích (Q8).

**D.5.4. Pha Reporting (thay đổi nhỏ, tất định, không gọi mô hình):** (1) E7 cho worker báo cáo; (2) `src/report-export.ts`: thêm phụ lục "Risk rating" tĩnh (năm mức và tiêu chí), thêm cột khóa WSTG và mức bằng chứng vào bảng case, hiển thị `risk` của worker như **văn bản có quy gán, chưa đánh giá** (`src/evidence.ts:10`) thay vì một xếp hạng, và dòng "Executive summary: không tự sinh, viết tay"; (3) không đổi tiêu đề `coverage.csv`; hash `report-manifest.json` cũ không so sánh được (đã chấp nhận ở S6). Caller của `renderReport`: duy nhất `extensions/p2o/index.ts:1316` (grep; GitNexus không lập chỉ mục `src/*.ts` nên `impact` trả UNKNOWN, **không** coi là an toàn). Quy ước PURL cho tài sản `package` ghi ở `HANDOFFS.md` (3 dòng), tùy chọn.

**D.5.5. Tác động mã (xác nhận bằng grep, không bằng GitNexus):**

| Thay đổi | Caller/đối tượng phụ thuộc đã grep | Test cần cập nhật có chủ đích |
|---|---|---|
| `src/wstg-map.ts`: thêm `trigger`, `modes`, chấm lại 5 hàng | `src/report-export.ts:9,68-84`, `scripts/render-wstg-map.mjs`, `tests/minimal/wstg-map.test.ts` | số đếm D/T/N/O (26/35/43/4 → 21/40/43/4), bảng tài liệu |
| `scripts/validate_library.py`: provenance v2 | `tests/test_library.py` (nhiều dòng quanh `:403-436`, `:479`, `:579`, `:754`) | thêm ca: giấy phép lệch, thiếu bản sao giấy phép, hash lệch |
| `src/report-export.ts`: phụ lục | `extensions/p2o/index.ts:1316` | `tests/minimal/report-export.test.ts` (+3 ca) |
| `src/tool-guidelines.ts` (tùy chọn) | `tests/minimal/workflow-policy.test.ts`, digest runtime qua `POLICY_VERSION` | ngân sách guidance |
| `skills/**`, `skills/catalog.json` | `src/skills.ts` (đọc), `tests/minimal/knowledge.test.ts`, `skill-hygiene.test.ts`, `scripts/validate_library.py` | số tài liệu; số trang của `p2o_skill_list` |


---

## E. Lộ trình theo giai đoạn, nghiệm thu và cách kiểm thử

### E.1. Tín hiệu ưu tiên

Xếp theo: số test chưa có thẻ riêng, tín hiệu rủi ro của Top 10 2025 (M6; ánh xạ nhóm WSTG sang hạng mục là **DESIGN-INFERENCE**), nhu cầu danh tính, cờ trình duyệt, mức mutation tối đa, và khả năng tái sử dụng. Giai đoạn càng sớm càng ít rủi ro và càng rẻ.

| Skill | Hạng mục Top 10 2025 gần nhất | Test cần thẻ (Một phần + Thiếu) | Cần danh tính | Trình duyệt | Mutation | Phase |
|---|---|---|---|---|---|---|
| `web-deployment-hygiene` | A02, A04, A10 | 16 | không | 2 | M0 | X1 |
| `web-session-management` | A07, A01 | 9 | có (8) | 0 | M1 | X1 |
| `web-credential-lifecycle` | A07 | 10 | có (9) | 0 | M2 | X1 |
| 6 bổ sung skill hiện có (E1–E4) | A01, A05, A06 | 6 | một phần | 0 | M0–M1 | X1 |
| `web-server-side-injection` | A05 | 13 | không | 0 | M1 | X2 |
| `web-token-and-federation` | A07, A01 | 2 | có (2) | 0 | M1 | X2 |
| `web-business-logic-misuse` | A06 | 9 | có (9) | 0 | M2 | X2 |
| `web-browser-trust-controls` | A02, A01, A05 | 13 | một (1) | 13 | M1 | X3 |
| `web-graphql-testing` | A01, A05 | 1 | không | 0 | M0 | X3 |
| `web-crypto-usage-review` | A04 | 2 | không | 0 | M0 | X4 |
| Báo cáo (E7 và phụ lục) | — | 0 | không | 0 | M0 | X4 |

Hai hạng mục gần như không có test WSTG tương ứng (A03 chuỗi cung ứng, A09 nhật ký/cảnh báo) nằm ngoài kế hoạch (C.3).

### E.2. Các giai đoạn

| Giai đoạn | Nội dung | Test đổi mức | Đủ sau giai đoạn |
|---|---|---|---|
| **X0** Nền | X0.1 dời bản raw; X0.2 chốt tài liệu kế hoạch và các trích dẫn cũ; X0.3 provenance v2; X0.4 chấm lại bản đồ và thêm cột `Kích hoạt`/`Chế độ`; X0.5 test sở hữu | 5 hàng D → T (số đếm: 21/40/43/4) | 21 |
| **X1** Hygiene, session, credential | N7, N1, N3 + E1–E4 | 41 | 62 |
| **X2** Injection, logic, token | N4, N2, N5 | 24 | 86 |
| **X3** Trình duyệt và API | N6, N8 (+ E5, E6 không đổi mức) | 14 | 100 |
| **X4** Crypto và báo cáo | N9, E7, phụ lục xuất | 2 | 102 |
| **X5** Đo lường nâng cao | tùy chọn, cần phê duyệt riêng | — | — |

Đích: **Đủ 102/108, Một phần 2 (INFO-04, INFO-10), Ngoài 4** (D.2 và Phụ lục H). Mỗi giai đoạn tự đứng được: dừng sau X1 vẫn có giá trị (41 test có thẻ, rủi ro thấp nhất).

### E.3. Việc, nghiệm thu và kiểm thử từng giai đoạn

**X0 — Nền (không đổi hành vi pentest)**

| Việc | Nghiệm thu (đều miễn phí) | Kiểm thử |
|---|---|---|
| X0.1 Dời `skills/wstg/` ra ngoài `skills/` và ngoài `files` (đề xuất `my_references/wstg/`, Q1) | `python3 scripts/validate_library.py` in `PASS`; `npm test` xanh; `npm pack --dry-run` không chứa văn bản WSTG raw; `git status` không còn `skills/wstg` | lệnh có sẵn |
| X0.2 Chốt `planning_update.md` này; ghi chú hoặc sửa 2 trích dẫn cũ nếu owner muốn (`docs/ACCEPTANCE_MATRIX.md:92`, `src/roles.ts:35`); receipt lịch sử trong `docs/VERIFICATION_LOG.md` giữ nguyên | `acceptance-matrix.test.ts` 3/3 xanh; hai link README hết gãy | test có sẵn |
| X0.3 Provenance v2: `upstreams[]` (Strix Apache-2.0; WSTG CC-BY-SA-4.0), mỗi reference khai `upstream`, id `W1…` cho trang WSTG đã dùng (sha256 trang tại `28553f8`); vendored `research/licenses/cc-by-sa-4.0.md` và notice; schema 1 vẫn đọc được; nâng giới hạn 5–20 reference (`validate_library.py:413`) và regex id (`:420`) có chủ đích. Phương án nhẹ hơn: file riêng `research/WSTG_PROVENANCE.json` với hàm kiểm riêng (Q3) | `tests/test_library.py` hiện có xanh; ≥ 6 ca mới: giấy phép lệch upstream, thiếu bản sao giấy phép, hash lệch, reference không ghi skill vào `used_by`, id upstream trùng, schema 1 vẫn pass | unittest Python |
| X0.4 Chấm lại 5 hàng; thêm `trigger` và `modes` vào `src/wstg-map.ts`; `docs/WSTG_MAP.md` sinh lại; từ vựng đặc điểm ở `HANDOFFS.md` | `wstg-map.test.ts` xanh với 21/40/43/4; bảng khớp dữ liệu (`render-wstg-map.mjs`); `shared:wstg-map` ≤ 16.000 ký tự; lead prompt không đổi byte (`recon.test.ts` xanh, 5 biến thể có trần) | cập nhật có chủ đích số đếm trong test |
| X0.5 `tests/minimal/wstg-skills.test.ts`: dữ liệu chủ sở hữu (skill, thẻ) nằm trong `src/wstg-map.ts`; test chỉ ép các skill **đã có trong catalog**: thẻ tồn tại, dòng `Tests:` đầu file khớp bản đồ, mỗi test trong scope xuất hiện đúng một lần trong tất cả dòng `Tests:`, `Đủ` chỉ được ghi khi thẻ tồn tại | xanh ở mọi giai đoạn, siết dần khi skill xuất hiện | vitest |

**X1–X4 — mỗi skill mới** phải qua cùng một cửa (Định nghĩa hoàn thành, DoD):

1. `scripts/validate_library.py` PASS: 11 mục playbook, giới hạn từ, không fence/CVE/hex, không đoạn trùng, provenance hợp lệ, reference được liên kết.
2. `wstg-skills.test.ts` và `wstg-map.test.ts` xanh; số đếm trong bản đồ và `docs/WSTG_MAP.md` cập nhật có chủ đích (D tăng đúng số test của skill).
3. `skill-hygiene.test.ts` xanh: không tên `p2o_*` trong skill; mục "chuyển giao" không trỏ tới skill không tồn tại.
4. Kích thước: SKILL.md ≤ 7.000 ký tự; mỗi reference ≤ 6.000; `scripts/measure-context.mjs --source` cho lượt duyệt `p2o_skill_list` ≤ ngưỡng của giai đoạn (X1 ≤ 27.500, X2 ≤ 32.000, X3 ≤ 35.000, X4 ≤ 36.500 ký tự; **DESIGN-INFERENCE** từ 21.659 hiện tại cộng khoảng 1.450 mỗi mục playbook); lead prompt và prompt worker không đổi (hash, trần); khai báo tool không đổi (24 tool, ngân sách `workflow-policy.test.ts`).
5. Kiểm đột biến (như các lượt trước): thêm một code fence, đổi tên skill chủ sở hữu, bỏ liên kết reference, thêm tên `p2o_*`, nhân đôi một test sang hai thẻ; mỗi lần phải có đúng một guard đỏ.
6. Tài liệu: `docs/WSTG_MAP.md` sinh lại; một đoạn ngắn ở `docs/USAGE.md` (cách chọn skill theo test); hàng acceptance mới (đặt tên `F-X1…F-X4`, trỏ test thật) ở `docs/ACCEPTANCE_MATRIX.md` trong mục riêng, **không** chạm §13.
7. `npm test` đầy đủ xanh; số test ghi lại, không tự ghi cứng trong README.

| Giai đoạn | Thêm | Kiểm thử đặc thù |
|---|---|---|
| X1 | N7, N1, N3, E1–E4 | `Chế độ` của N7 chỉ `S`/`H`/`N`, không `A`/`B`; test kiểm thẻ N1 nhắc "token của chính mình"; E2 không cho phép xác nhận smuggling bằng đầu độc hàng đợi (guard văn bản) |
| X2 | N4, N2, N5 | thẻ N4 không chứa payload (guard validator); thẻ N5 buộc "nguồn chính sách"; thẻ N2 chỉ trên origin của target |
| X3 | N6, N8, E5, E6 (sau khi chốt Q5) | nếu Q5 cho phép Chromium cục bộ: thêm fixture hermetic chạy `chromium --headless` trong sandbox và so DOM với kết quả kỳ vọng (opt-in Docker như `P2O_TEST_DOCKER=1`); trần chứng minh của thẻ B vẫn `offline_reproduction` |
| X4 | N9, E7, phụ lục xuất | `report-export.test.ts`: phụ lục thang rủi ro có mặt, `risk` hiển thị là văn bản có quy gán, xuất hai lần cho cùng hash manifest, báo cáo không có khóa `wstg-` không đổi byte |

### E.4. Phụ thuộc

X0.1 trước mọi việc khác (hiện `npm test` đỏ). X0.3 trước mọi văn bản dẫn xuất từ WSTG, kể cả E1–E4 (mọi reference cần `provenance_refs` hoặc ghi nhận nguồn). X0.4–X0.5 trước X1 (bảng định tuyến và guard). Q5 chỉ chặn phần trình duyệt của X3. Q7 chặn phần quét tự động của N4. Q2 chặn toàn bộ X1 trở đi (cách ghi nhận nguồn).

### E.5. Điều không thể kiểm miễn phí

Hiệu quả pentest (tỷ lệ phát hiện, dương tính giả, chi phí, độ ổn định của worker khi có skill mới) là **UNVERIFIED**; benchmark hiện có chỉ chạy `--solo` trên 4 fixture thư mục nguồn, không có fixture HTTP, session, injection hay client-side, và việc chạy trả phí đang bị cấm. Nghiệm thu ở trên chỉ chứng minh: cấu trúc đúng, không phình ngữ cảnh cố định, ánh xạ nhất quán, ranh giới an toàn được viết ra. Nếu sau này owner cho phép (X5): (a) phòng thí nghiệm fixture hermetic (ứng dụng web mẫu có lỗi và bản vá, kiểm tra oracle tất định ở phía fixture); (b) benchmark có trần chi phí với model/ngân sách/ngưỡng do owner chọn, không dùng provider `openai-codex-account-*`; (c) "sổ mục tiêu": 236 mục tiêu WSTG mỗi mục ánh xạ tới ≥ 1 dòng thẻ hoặc bị loại trừ có lý do (kiểm được miễn phí và có thể làm sớm hơn nếu owner muốn).

---

## F. Rủi ro và quyết định cần chốt

### F.1. Rủi ro

| # | Rủi ro | Dấu hiệu / bằng chứng | Giảm thiểu |
|---|---|---|---|
| R1 | Giấy phép: WSTG là CC BY-SA 4.0; phần dẫn xuất có thể kéo theo ShareAlike; repo là `private`, `UNLICENSED` (`package.json`) | M3; **UNVERIFIED** về pháp lý | viết lại độc lập, không chép; attribution bằng tiêu đề + hash; `usage_boundary` như R1–R6; vendored license; Q2 |
| R2 | Thay đổi provenance v2 làm vỡ validator hoặc test Python | `validate_library.py:371-447` và nhiều dòng `tests/test_library.py` | thêm test trước, đọc được schema 1, hoặc phương án file riêng (Q3) |
| R3 | Chất lượng skill không được chứng minh | E.5 | tuyên bố đúng mức; không viết "pentest tốt hơn"; X5 chỉ khi được phép |
| R4 | Phình ngữ cảnh: lượt duyệt `p2o_skill_list` tăng từ 21.659 lên khoảng 34.700 ký tự (+60%); playbook xếp trước kỹ thuật nên 17 skill kỹ thuật xuống trang 2–4; trang đầu SKILL.md inline vào brief (khoảng +7 K ký tự khi được gán) | đo `scripts/measure-context.mjs`; `src/skills.ts:66-77` | mô tả ngắn có mã nhóm WSTG để `query` tìm được; `shared:wstg-map` làm bộ định tuyến; ngưỡng theo giai đoạn; làm S3b (gộp workflow trùng trong đầu ra `list`) nếu vượt (bản trước đo −28% khi duyệt hết) |
| R5 | Lead chọn sai skill hoặc lập quá nhiều test | số test lớn, mỗi task chỉ 3 skill | mỗi test đúng một chủ sở hữu; cột `Kích hoạt`, `Chế độ`; test sở hữu |
| R6 | Test có tác dụng phụ (khóa tài khoản, email/SMS, thanh toán, upload, smuggling) | W6b đã bị bỏ; hộp thoại bắt đầu cho phép method ghi cho cả run (`docs/HTTP_TRANSPORT.md`) | mức M0/M1/M2 trong Stop Conditions; M2 mặc định `blocked`; fixture riêng; Q6 |
| R7 | Công cụ quét tự động có sẵn trong image (`sqlmap`, `ffuf`, `nuclei`, NSE gồm `http-slowloris`) gây nhiễu hoặc hại | M5 | không mặc định; cấm NSE từ chối dịch vụ trong thẻ; Q7 |
| R8 | Nhầm lẫn bằng chứng trình duyệt: Chromium chạy qua shell không có ghim origin hay biên nhận có cấu trúc | M5; `docs/HTTP_TRANSPORT.md` | trần `offline_reproduction`; Q5; test opt-in |
| R9 | Đổi README, catalog hoặc `HANDOFFS.md` làm đổi hash tài liệu → task method đang mở bị stale (`TASK_METHOD_STALE`, `extensions/p2o/index.ts:349`) | đã gặp ở các lượt trước | chỉ áp dụng giữa các run (`/p2o stop` trước) |
| R10 | Trùng đoạn nguyên văn giữa các thẻ (validator `duplicate paragraph`) | `validate_library.py:810-816` | văn bản riêng cho từng thẻ; phần chung đặt ở Stop Conditions của playbook |
| R11 | WSTG đổi ID giữa các bản (INPV → INJT; INJT-13 gán lại) | A.1, M4 | ghim commit; khóa là cặp (ID, tiêu đề); quy trình làm mới ở `docs/WSTG_MAP.md` |
| R12 | Hiểu nhầm "phủ 100% WSTG" là "phát hiện được mọi thứ" | nhãn Đủ là tri thức | báo cáo cấm câu "phủ 100%" (đã có); tài liệu ghi rõ ngoài WSTG (C.3) |
| R13 | Công cụ trong image khác nhau giữa các image (`--p2o-image`); `nmap` không chạy do file capability | M5 | thẻ nói "kiểm công cụ bằng probe có biên nhận" (đã là quy tắc ở `docs/SKILL_RUNTIME.md`); không phụ thuộc cứng vào một công cụ |
| R14 | Phạm vi lớn (khoảng 240 KB văn bản, 41 tài liệu) | D.2 | phân giai đoạn; mỗi giai đoạn tự đứng được; X1 là điểm dừng hợp lý |
| R15 | Nếu không làm X0.1, `npm test` tiếp tục đỏ và che các hồi quy khác | M2 | X0.1 là việc đầu tiên |

### F.2. Quyết định cần owner chốt

| # | Câu hỏi | Mặc định đề xuất |
|---|---|---|
| Q1 | Bản raw WSTG đặt ở đâu? (ngoài `skills/` và `files`) | `my_references/wstg/` (đúng quy ước tham chiếu tĩnh, không bị quét, không đóng gói) |
| Q2 | Lập trường giấy phép cho phần dẫn xuất từ WSTG: (a) viết lại độc lập + attribution + vendored license; (b) ghi nhãn CC BY-SA 4.0 cho phần dẫn xuất; (c) chỉ dùng ID, không dùng ý | (a) |
| Q3 | Provenance: (a) schema v2 nhiều upstream trong `SKILL_PROVENANCE.json`; (b) file riêng cho WSTG | (a) nếu chấp nhận sửa validator; (b) nếu muốn blast radius nhỏ |
| Q4 | Chấp nhận chấm lại 5 hàng D → T (IDNT-01, INJT-04, INJT-13, INJT-15, BUSL-05) và xem lại APIT-03, INJT-16? | chấp nhận |
| Q5 | Trình duyệt: (a) giữ chính sách không có trình duyệt, nhưng cho Chromium cục bộ chạy fixture như bằng chứng `offline_reproduction`; (b) không dùng Chromium; (c) nghiên cứu transport có quản lý (ngoài kế hoạch này) | (a) sau khi có thiết kế an toàn; chưa cần trước X3 |
| Q6 | Mức mutation: chỉ hướng dẫn trong skill, hay cần cưỡng chế ở host (mở lại W6b)? | chỉ hướng dẫn |
| Q7 | Công cụ quét tự động có sẵn (`sqlmap`, `ffuf`, `nuclei`): cấm mặc định hay cho phép có giới hạn cho một vài test? | cấm mặc định |
| Q8 | Hai dòng `promptGuidelines` (D.5.3) có bật không, hay chỉ quy ước ở `HANDOFFS.md` và `shared:wstg-map`? | chỉ quy ước (benchmark W: guidance +73% chi phí) |
| Q9 | Benchmark trả phí sau X2 và X4: có hay không, model, ngân sách, ngưỡng không hồi quy | không (đang cấm) |
| Q10 | Độ mịn: chín playbook, hay gộp bớt? Có chấp nhận lượt duyệt +60% hoặc làm S3b? | chín playbook; S3b chỉ khi vượt ngưỡng |
| Q11 | Báo cáo: phụ lục thang rủi ro tất định và `risk` hiển thị như văn bản có quy gán; có muốn enum cho `risk` (đổi schema)? Có muốn cột Top 10 2025 làm nhóm báo cáo (tùy chọn)? | phụ lục tất định, không enum, không cột Top 10 |
| Q12 | Chương WebAssembly (không ID): chỉ reference ở `binary-auditing`, hay tạo khóa tạm `wstg-wasm-*`? | chỉ reference |

---

## G. Tái lập số đo

| Số đo | Cách tái lập |
|---|---|
| Tình trạng cây (M1, M2) | `git status --short`; `python3 scripts/validate_library.py \| wc -l`; `npx vitest run tests/minimal/acceptance-matrix.test.ts` |
| Bản raw so với upstream (M3) | `git clone --depth 1 https://github.com/OWASP/wstg <thư mục tạm>`; `diff -rq <tạm>/document/4-Web_Application_Security_Testing skills/wstg/4-Web_Application_Security_Testing`; tương tự `5-Reporting`; `git -C <tạm> log -1` |
| 108 ID và cấu trúc trang (M4, A.2) | tách `WSTG-<NHÓM>-<nn>` từ bảng ID đầu mỗi trang; trang dưới 800 byte là stub; đếm tiêu đề H2 `Summary`, `Test Objectives`, `How to Test`, `Remediation`, `References`, `Tools` |
| Mức phủ (B) | đọc `docs/WSTG_MAP.md`; tìm từ khóa theo lớp lỗi trên `skills/**` (loại `skills/wstg/`), đọc các dòng trúng, ghi file:dòng; **không** dùng số lần trúng |
| Sandbox (M5) | `docker run --rm --network none --user 65532:65532 --cap-drop ALL --read-only --tmpfs /tmp:rw,exec --security-opt no-new-privileges --entrypoint sh <image-id> -c 'command -v curl openssl nmap sqlmap chromium …'`; image-id từ `docker images` (digest phải bằng `scripts/setup-sandbox-tools.sh:11`) |
| Top 10 2025 (M6) | đọc `https://top10.owasp.org/2025` |
| Kích thước lượt duyệt skill, prompt, khai báo | `node scripts/measure-context.mjs --source` (hiện: duyệt 3 trang 9.710 + 7.316 + 4.633 = 21.659 ký tự; lead dir 5.221, url 5.372) |
| Trích dẫn kế hoạch | `git grep -n "planning_update" -- . ':!planning_update.md'` |

---

## H. Phụ lục: chủ sở hữu và mức phủ của 108 test

Dữ liệu sinh từ `docs/WSTG_MAP.md` (cột S4) cộng đề xuất ở B.3 (cột Nay) và D.2–D.4 (chủ sở hữu, thẻ). **Mỗi test trong scope có đúng một chủ sở hữu**; 4 test ngoài scope không có. "Thẻ" là tên file trong `references/` của skill chủ sở hữu; dấu `+` đánh dấu reference mới trong skill hiện có (D.4). Mã: D đủ, T một phần, N thiếu, O ngoài; cờ B cần trình duyệt, I cần danh tính do operator cấp. Đây là **đề xuất, chưa áp dụng**; test `wstg-skills.test.ts` (X0.5) sẽ ép bảng này ngay khi dữ liệu vào `src/wstg-map.ts`.

| Key | Test | S4 | Nay | Đích | Cờ | Chủ sở hữu | Thẻ | Phase |
|---|---|---|---|---|---|---|---|---|
| wstg-info-01 | Conduct Search Engine Reconnaissance for Info… | O | O | O | - | - | - | - |
| wstg-info-02 | Fingerprint Web Server | T | T | D | - | `web-deployment-hygiene` | fingerprint-and-metafiles | X1 |
| wstg-info-03 | Review Webserver Metafiles for Information Le… | T | T | D | - | `web-deployment-hygiene` | fingerprint-and-metafiles | X1 |
| wstg-info-04 | Attack Surface Identification | T | T | T | - | `attack-surface-mapping` | intermediary-trust | - |
| wstg-info-05 | Review Web Page Content for Information Leaka… | T | T | D | - | `web-deployment-hygiene` | content-and-backup-exposure | X1 |
| wstg-info-06 | Identify Application Entry Points | D | D | D | - | `web-route-input-inventory` | route-inventory-method | - |
| wstg-info-07 | Map Execution Paths Through Application | D | D | D | - | `web-route-input-inventory` | route-inventory-method | - |
| wstg-info-08 | Fingerprint Web Application Framework | T | T | D | - | `web-deployment-hygiene` | fingerprint-and-metafiles | X1 |
| wstg-info-10 | Map Application Architecture | T | T | T | - | `attack-surface-mapping` | intermediary-trust | - |
| wstg-conf-01 | Network Infrastructure Configuration | O | O | O | - | - | - | - |
| wstg-conf-02 | Application Platform Configuration | T | T | D | - | `web-deployment-hygiene` | platform-config-and-flags | X1 |
| wstg-conf-04 | Review Old Backup and Unreferenced Files for … | T | T | D | - | `web-deployment-hygiene` | content-and-backup-exposure | X1 |
| wstg-conf-05 | Enumerate Infrastructure and Application Admi… | T | T | D | - | `web-deployment-hygiene` | content-and-backup-exposure | X1 |
| wstg-conf-06 | HTTP Methods | T | T | D | - | `web-deployment-hygiene` | headers-methods-and-transport | X1 |
| wstg-conf-07 | HTTP Strict Transport Security | N | N | D | - | `web-deployment-hygiene` | headers-methods-and-transport | X1 |
| wstg-conf-09 | File Permissions | N | N | D | - | `web-deployment-hygiene` | platform-config-and-flags | X1 |
| wstg-conf-10 | Subdomain Takeover | O | O | O | - | - | - | - |
| wstg-conf-11 | Cloud Storage | O | O | O | - | - | - | - |
| wstg-conf-12 | Content Security Policy | N | N | D | B | `web-browser-trust-controls` | cross-origin-policy | X3 |
| wstg-conf-13 | Path Confusion | D | D | D | - | `parser-differential-auditing` | - | - |
| wstg-conf-14 | Other HTTP Security Header Misconfigurations | N | N | D | B | `web-deployment-hygiene` | headers-methods-and-transport | X1 |
| wstg-conf-15 | Feature Flag Security Bypass | T | T | D | - | `web-deployment-hygiene` | platform-config-and-flags | X1 |
| wstg-idnt-01 | Role Definitions | D | T | D | I | `web-object-authorization` | +roles-and-field-exposure | X1 |
| wstg-idnt-02 | User Registration Process | T | T | D | I | `web-credential-lifecycle` | account-creation-and-enumeration | X1 |
| wstg-idnt-03 | Account Provisioning Process | T | T | D | I | `web-credential-lifecycle` | account-creation-and-enumeration | X1 |
| wstg-idnt-04 | Account Enumeration and Guessable User Account | T | T | D | - | `web-credential-lifecycle` | account-creation-and-enumeration | X1 |
| wstg-athn-02 | Default Credentials | N | N | D | I | `web-credential-lifecycle` | credential-policy-and-defaults | X1 |
| wstg-athn-03 | Weak Lock Out Mechanism | N | N | D | I | `web-credential-lifecycle` | lockout-and-recovery | X1 |
| wstg-athn-04 | Bypassing Authentication Schema | D | D | D | I | `authorization-auditing` | - | - |
| wstg-athn-05 | Vulnerable Remember Password | N | N | D | I | `web-credential-lifecycle` | mfa-and-remember-me | X1 |
| wstg-athn-06 | Browser Cache Weaknesses | N | N | D | B | `web-deployment-hygiene` | headers-methods-and-transport | X1 |
| wstg-athn-07 | Weak Authentication Methods | N | N | D | I | `web-credential-lifecycle` | credential-policy-and-defaults | X1 |
| wstg-athn-08 | Weak Security Question Answer | N | N | D | I | `web-credential-lifecycle` | lockout-and-recovery | X1 |
| wstg-athn-09 | Weak Password Change or Reset Functionalities | N | N | D | I | `web-credential-lifecycle` | lockout-and-recovery | X1 |
| wstg-athn-10 | Weaker Authentication in Alternative Channel | D | D | D | I | `authorization-auditing` | - | - |
| wstg-athn-11 | Multi-Factor Authentication (MFA) | N | N | D | I | `web-credential-lifecycle` | mfa-and-remember-me | X1 |
| wstg-athz-01 | Directory Traversal File Include | T | T | D | - | `web-server-side-injection` | path-and-file-inclusion | X2 |
| wstg-athz-02 | Bypassing Authorization Schema | D | D | D | I | `web-object-authorization` | - | - |
| wstg-athz-03 | Privilege Escalation | D | D | D | I | `web-object-authorization` | - | - |
| wstg-athz-04 | Insecure Direct Object References | D | D | D | I | `web-object-authorization` | - | - |
| wstg-athz-05 | OAuth Weaknesses | N | N | D | I | `web-token-and-federation` | oauth-oidc-flows | X2 |
| wstg-sess-01 | Session Management Schema | N | N | D | I | `web-session-management` | token-issuance-and-attributes | X1 |
| wstg-sess-02 | Cookies Attributes | N | N | D | - | `web-session-management` | token-issuance-and-attributes | X1 |
| wstg-sess-03 | Session Fixation | N | N | D | I | `web-session-management` | fixation-and-hijack | X1 |
| wstg-sess-04 | Exposed Session Variables | N | N | D | I | `web-session-management` | token-issuance-and-attributes | X1 |
| wstg-sess-05 | Cross Site Request Forgery | N | N | D | BI | `web-browser-trust-controls` | request-forgery-and-origin-checks | X3 |
| wstg-sess-06 | Logout Functionality | N | N | D | I | `web-session-management` | logout-timeout-concurrency | X1 |
| wstg-sess-07 | Session Timeout | N | N | D | I | `web-session-management` | logout-timeout-concurrency | X1 |
| wstg-sess-08 | Session Puzzling | N | N | D | I | `web-session-management` | fixation-and-hijack | X1 |
| wstg-sess-09 | Session Hijacking | N | N | D | I | `web-session-management` | fixation-and-hijack | X1 |
| wstg-sess-10 | JSON Web Tokens | N | N | D | I | `web-token-and-federation` | jwt-validation | X2 |
| wstg-sess-11 | Concurrent Sessions | N | N | D | I | `web-session-management` | logout-timeout-concurrency | X1 |
| wstg-injt-01 | Reflected Cross Site Scripting | D | D | D | B | `web-output-context` | source-sink-context | - |
| wstg-injt-02 | Stored Cross Site Scripting | D | D | D | B | `web-output-context` | source-sink-context | - |
| wstg-injt-04 | HTTP Parameter Pollution | D | T | D | - | `parser-differential-auditing` | +http-framing-and-parameters | X1 |
| wstg-injt-05 | SQL Injection | T | T | D | - | `web-server-side-injection` | sql-nosql-orm | X2 |
| wstg-injt-06 | LDAP Injection | T | T | D | - | `web-server-side-injection` | xml-xpath-ldap | X2 |
| wstg-injt-07 | XML Injection | T | T | D | - | `web-server-side-injection` | xml-xpath-ldap | X2 |
| wstg-injt-08 | SSI Injection | T | T | D | - | `web-server-side-injection` | command-code-ssi | X2 |
| wstg-injt-09 | XPath Injection | T | T | D | - | `web-server-side-injection` | xml-xpath-ldap | X2 |
| wstg-injt-10 | IMAP SMTP Injection | T | T | D | - | `web-server-side-injection` | mail-formula-second-order | X2 |
| wstg-injt-11 | Code Injection | T | T | D | - | `web-server-side-injection` | command-code-ssi | X2 |
| wstg-injt-12 | Command Injection | T | T | D | - | `web-server-side-injection` | command-code-ssi | X2 |
| wstg-injt-13 | Format String Injection | D | T | D | - | `web-server-side-injection` | format-strings | X2 |
| wstg-injt-14 | Incubated Vulnerability | T | T | D | - | `web-server-side-injection` | mail-formula-second-order | X2 |
| wstg-injt-15 | HTTP Response Splitting | D | T | D | - | `parser-differential-auditing` | +http-framing-and-parameters | X1 |
| wstg-injt-16 | HTTP Request Smuggling | D | D | D | - | `parser-differential-auditing` | - | - |
| wstg-injt-17 | Host Header Injection | T | T | D | - | `attack-surface-mapping` | intermediary-trust (+Host/Forwarded) | X1 |
| wstg-injt-18 | Server-side Template Injection | D | D | D | - | `deserialization-and-dispatch-auditing` | - | - |
| wstg-injt-19 | Server-Side Request Forgery | T | T | D | - | `web-server-side-injection` | outbound-request-ssrf | X2 |
| wstg-injt-20 | Mass Assignment | D | D | D | I | `web-object-authorization` | +roles-and-field-exposure | - |
| wstg-injt-21 | CSV Injection | T | T | D | - | `web-server-side-injection` | mail-formula-second-order | X2 |
| wstg-injt-22 | Prototype Pollution | D | D | D | - | `deserialization-and-dispatch-auditing` | - | - |
| wstg-injt-23 | Insecure Deserialization | D | D | D | - | `deserialization-and-dispatch-auditing` | - | - |
| wstg-errh-01 | Improper Error Handling | N | N | D | - | `web-deployment-hygiene` | error-disclosure | X1 |
| wstg-cryp-01 | Weak Transport Layer Security | N | N | D | - | `web-deployment-hygiene` | headers-methods-and-transport | X1 |
| wstg-cryp-02 | Padding Oracle | N | N | D | - | `web-crypto-usage-review` | padding-oracle | X4 |
| wstg-cryp-03 | Sensitive Information Sent via Unencrypted Ch… | N | N | D | - | `web-deployment-hygiene` | headers-methods-and-transport | X1 |
| wstg-cryp-04 | Weak Cryptographic Primitives | T | T | D | - | `web-crypto-usage-review` | weak-primitives | X4 |
| wstg-busl-01 | Business Logic Data Validation | N | N | D | I | `web-business-logic-misuse` | invariants-and-misuse-cases | X2 |
| wstg-busl-02 | Ability to Forge Requests | N | N | D | I | `web-business-logic-misuse` | invariants-and-misuse-cases | X2 |
| wstg-busl-03 | Integrity Checks | N | N | D | I | `web-business-logic-misuse` | invariants-and-misuse-cases | X2 |
| wstg-busl-04 | Process Timing | T | T | D | I | `web-business-logic-misuse` | workflow-and-timing | X2 |
| wstg-busl-05 | Number of Times a Function Can Be Used Limits | D | T | D | I | `race-condition-auditing` | +usage-limit-bypass | X1 |
| wstg-busl-06 | Circumvention of Work Flows | T | T | D | I | `web-business-logic-misuse` | workflow-and-timing | X2 |
| wstg-busl-07 | Defenses Against Application Misuse | N | N | D | I | `web-business-logic-misuse` | workflow-and-timing | X2 |
| wstg-busl-08 | Upload of Unexpected File Types | N | N | D | I | `web-business-logic-misuse` | file-upload-handling | X2 |
| wstg-busl-09 | Upload of Malicious Files | N | N | D | I | `web-business-logic-misuse` | file-upload-handling | X2 |
| wstg-busl-10 | Payment Functionality | N | N | D | I | `web-business-logic-misuse` | payment-and-pricing | X2 |
| wstg-clnt-01 | DOM-Based Cross Site Scripting | D | D | D | B | `web-output-context` | source-sink-context | - |
| wstg-clnt-02 | JavaScript Execution | D | D | D | B | `web-output-context` | source-sink-context | - |
| wstg-clnt-03 | HTML Injection | D | D | D | B | `web-output-context` | source-sink-context | - |
| wstg-clnt-04 | Client-side URL Redirect | T | T | D | B | `web-browser-trust-controls` | client-side-sinks | X3 |
| wstg-clnt-05 | CSS Injection | T | T | D | B | `web-browser-trust-controls` | client-side-sinks | X3 |
| wstg-clnt-06 | Client-side Resource Manipulation | T | T | D | B | `web-browser-trust-controls` | client-side-sinks | X3 |
| wstg-clnt-07 | Cross Origin Resource Sharing | N | N | D | B | `web-browser-trust-controls` | cross-origin-policy | X3 |
| wstg-clnt-09 | Clickjacking | N | N | D | B | `web-browser-trust-controls` | cross-origin-policy | X3 |
| wstg-clnt-10 | WebSockets | N | N | D | B | `web-browser-trust-controls` | request-forgery-and-origin-checks | X3 |
| wstg-clnt-11 | Web Messaging | N | N | D | B | `web-browser-trust-controls` | messaging-storage-and-links | X3 |
| wstg-clnt-12 | Browser Storage | N | N | D | B | `web-browser-trust-controls` | messaging-storage-and-links | X3 |
| wstg-clnt-13 | Cross Site Script Inclusion | N | N | D | B | `web-browser-trust-controls` | cross-origin-policy | X3 |
| wstg-clnt-14 | Reverse Tabnabbing | N | N | D | B | `web-browser-trust-controls` | messaging-storage-and-links | X3 |
| wstg-clnt-15 | Client-side Template Injection | T | T | D | B | `web-browser-trust-controls` | client-side-sinks | X3 |
| wstg-apit-01 | API Reconnaissance | D | D | D | - | `web-route-input-inventory` | route-inventory-method | - |
| wstg-apit-02 | API Broken Object Level Authorization | D | D | D | I | `web-object-authorization` | - | - |
| wstg-apit-03 | Excessive Data Exposure | T | T | D | - | `web-object-authorization` | +roles-and-field-exposure | X1 |
| wstg-apit-04 | API Broken Function Level Authorization | D | D | D | I | `web-object-authorization` | - | - |
| wstg-apit-99 | GraphQL | N | N | D | - | `web-graphql-testing` | schema-and-limits | X3 |

---

## 13. Acceptance matrix: baseline K0–K7, không được regress

Mọi giai đoạn X0–X5 của kế hoạch này phải giữ nguyên các fixture và điều kiện này ([ACCEPTANCE_MATRIX](docs/ACCEPTANCE_MATRIX.md) ánh xạ từng hàng tới test thật và có guard tự động). Fixture của giai đoạn W đọc ở §14 của bản `41e8157` (`git show 41e8157:planning_update.md`); các slice S0–S7 đã triển khai đọc ở bản `6cfb89d`.

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

Phương pháp giữ nguyên: corpus deterministic 10k/100k, công bố phần cứng và corpus; báo p50/p95, RSS, kích thước on-disk; không lược bỏ dữ liệu rồi vẫn ghi "complete"; dedup phải báo cả suppression đúng lẫn **false suppression**; inert fixture chỉ chứng minh cơ chế, còn "pentest tốt hơn" cần benchmark có ủy quyền (cùng model/scope/budget, chạy lặp, control giữ lại, chấm độc lập), **chưa được thực hiện**. Số đo chi phí ngữ cảnh của giai đoạn W (§8, M1 và M1b) đọc ở bản `41e8157`; mục tiêu hiện hành (kích thước, nhất quán, độ phủ tài liệu) ở §E của file này; hiệu quả pentest vẫn **chưa được đo**.

### 13.3. Không đạt acceptance nếu

- Có graph nhưng không trả lời được “task nào chưa review, vì sao blocked, output ở đâu”.
- Checkpoint chỉ là model summary không có snapshot/version/refs.
- Finish xóa toàn bộ result mà user tưởng đã lưu.
- Graph dữ liệu được coi như authorization hoặc replay history tự chạy lại request.
- Mọi `confirmed` đều lên badge verified, hoặc “100% coverage” dựa touched assets.
- Dedup suppress validator/retest hoặc merge hai bug chỉ vì cùng CWE/title.
- Thêm background LLM hay đổi budgets/mode mà confirmation không nói.

---
