# Ánh xạ OWASP WSTG sang thư viện p2o

Bảng 108 test còn hiệu lực của [OWASP WSTG](https://github.com/OWASP/wstg) (commit `28553f878d48358767892916d53e59a9d664811c`, `master` ngày 2026-10-10) với kiến thức mà p2o đang mang. Đây là **độ phủ kiến thức của thư viện**, không phải khả năng phát hiện và không phải kết quả của một lần assessment (hiệu quả pentest vẫn là UNVERIFIED cho tới khi có benchmark được phép). Lý do thiết kế: [HISTORY](HISTORY.md) và bản đầy đủ trong git (`git show f5015fd:planning_update.md` §B).

Dữ liệu nằm ở `src/wstg-map.ts` cùng hai hàm thuần `wstgKey` và `wstgEvidence`. Bảng ở cuối trang là bản đọc được; `tests/minimal/wstg-map.test.ts` ép hai bản bằng nhau. Không có trường schema, trạng thái hay tool mới: khóa test chỉ là một giá trị của `questionKey` sẵn có.

## Cách dùng khóa

- Dùng ID WSTG viết thường làm `questionKey` (ví dụ `wstg-athz-04`) cho work identity trong intent (`p2o_task_create` với `work`). Từ A3, host tự chiếu coverage cell từ công việc đã review (task đã review + claim worker + case accepted + revision asset), ghép cùng khóa đó; model không có verb tạo/sửa/retire cell. `key()` chỉ nhận `[a-z0-9._:/-]` nên dạng viết hoa không hợp lệ.
- `methodFamily` giữ id workflow của skill (`source-review`, `offline-reproduction`...). `policyKey` giữ nghĩa chính sách của ứng dụng, không dùng cho ID WSTG.
- `questionKey` đi vào vân tay trùng lặp, nên hai worker cùng thử một test WSTG trên cùng asset và cùng ngữ cảnh sẽ bị phát hiện trùng chính xác.
- ID WSTG đã đổi giữa các bản (nhóm Input Validation `INPV` nay là Injection `INJT`; `INJT-13` được gán lại cho Format String). Luôn đọc ID cùng tiêu đề và commit đã ghim.

## Mức hỗ trợ của thư viện (cột Support)

| Mã | Ý nghĩa | Số test |
|---|---|---|
| D | có skill nêu đối tượng của test ở thân văn bản và cho phương pháp, tiêu chí kết luận hoặc kiểm dương tính giả cho nó (đã kiểm bằng cách đọc, không chỉ theo mô tả) | 102 |
| T | chỉ có kỹ thuật chung (`attack-surface-mapping`, `data-flow-analysis`, `source-code-auditing`, `authorization-auditing`) hoặc chỉ nhắc lớp lỗi một dòng | 2 |
| N | chưa có skill nào | 0 |
| O | ngoài phạm vi tri thức của thư viện theo thiết kế: cần thu thập ngoài target (search engine, hạ tầng DNS/cloud của bên thứ ba) — không phải giới hạn của run | 4 |

Cờ B (20 test): hiệu ứng xảy ra ở trình duyệt; image sandbox đã có Chromium 150 + `agent-browser` CLI nên worker drive transport và bằng chứng đạt `live_reproduction`. Cờ I (39 test): cần một principal đã xác thực — operator niêm phong qua `--identity` hoặc worker tự tạo. Phân loại ban đầu suy ra từ tiêu đề test và mô tả skill (DESIGN-INFERENCE); lần chấm lại đọc thân văn bản từng skill (bản lịch sử: `git show f5015fd:planning_update.md` §B.3). Hiện chỉ 2 test ở mức T (`wstg-info-04`, `wstg-info-10`) vì chưa skill nào nêu riêng đối tượng của chúng. D vẫn chỉ nói về **tri thức phương pháp**, không phải khả năng phát hiện lỗi (UNVERIFIED).

## Chủ sở hữu, thẻ, điều kiện kích hoạt và chế độ

Mỗi test trong scope có đúng **một skill chủ sở hữu** và, khi skill đó đã có thẻ cho test, tên thẻ: một file ở `references/` của skill, dòng đầu của file là `Tests: wstg-…` liệt kê các khóa mà thẻ lo. Dữ liệu (`owner`, `card`) nằm ở `src/wstg-map.ts`. `tests/minimal/wstg-skills.test.ts` ép: thẻ chỉ được tính khi skill và file tồn tại và dòng `Tests:` có khóa; test đã có thẻ phải ở mức D; mỗi khóa xuất hiện trong đúng một dòng `Tests:`; các skill tên trong dữ liệu mà chưa tồn tại là kế hoạch, không phải khẳng định. Trong cột **Skills** của bảng, tên **in đậm** là chủ sở hữu (skill phải nêu đối tượng và phương pháp của test); các tên thường sau đó chỉ là skill liên quan/chạm tới test này trong lúc làm việc khác, không lo test này — một dòng nhiều tên không phải là nhiều skill cùng sở hữu.

Cột **Trigger** liệt kê các đặc điểm recon làm test đáng lập kế hoạch (từ vựng ở đầu bảng bên dưới; ghi như thuộc tính `feature` của tài sản hoặc câu của một fact quan sát được). `p2o_coverage_suggest` không truyền `features` sẽ tự lấy các từ trong thuộc tính `feature` (phân tách bằng khoảng trắng , ; |) của tài sản hiện hành; kết quả có `featureSource` (`explicit`, `graph` hoặc `default`) và `ignoredFeatureWords` cho từ không thuộc từ vựng. Danh sách truyền tay luôn thắng; câu trong fact không được dò vì từ như `api` xuất hiện ở khắp nơi. Cột **Modes** cho biết transport có thể mang test: S đọc nguồn, H HTTP ẩn danh, A HTTP với principal đã xác thực (operator niêm phong hoặc worker tự tạo), N mạng trong sandbox (TCP, TLS, WebSocket), B cần browser transport để chứng minh. A có mặt đúng khi cờ I, B đúng khi cờ B. Cả hai chỉ là nhãn lập kế hoạch, không phải giới hạn của run: authorization đã blanket từ lúc start nên không cần cấp quyền theo hành động; operator chỉ thu hẹp bằng constraint đã ghi, còn ticket và task readiness quyết định cái gì chạy.

### Test áp dụng được suy ra (A6.4)

Từ P5/A6.4, feature của **từng asset** (không phải câu fact) là thứ làm một test WSTG trở nên áp dụng được. Hai hàm thuần trong `src/wstg-map.ts` biến dữ liệu đó thành kế hoạch đọc được, không phải coverage:

- `applicableTests(assets, {browser, identity})` gộp feature của các asset in-scope (asset không có feature, hoặc đã hết scope, bị bỏ), trả một row cho mỗi test theo đúng thứ tự `WSTG_MAP`, kèm `assets` đã sort/unique của asset đã kích hoạt. Row cờ **B** và **I** chỉ là nhãn lập kế hoạch: image sandbox đã có sẵn trình duyệt headless và worker tự tạo principal khi operator không niêm phong identity, nên một run mặc định truyền `browser: true, identity: true` và chỉ bỏ row khi caller nói rõ nó không có khả năng đó (`false`).
- `unplannedTests(featureAssets, {covered, browser, identity})` trả các row chưa có cell cùng `questionKey`, mỗi row một câu detail ASCII dưới 300 ký tự kèm `assetIds` kích hoạt. Đây là nguồn của debt kind `WSTG_UNPLANNED` trong báo cáo research debt: một test áp dụng được mà không ai lập kế hoạch là **nghĩa vụ còn nợ**, không phải "coverage sạch" và không phải finding.

Token lạ trong thuộc tính `feature` chỉ được báo (advisory) và không bao giờ là refusal; từ vựng là danh sách Trigger ở bảng dưới. `tests/minimal/wstg-applicable.test.ts` pin cả hai hàm, thứ tự map, biên detail và luật lọc B/I.

## Mức bằng chứng của một assessment (L0 đến L3)

Hàm `wstgEvidence` tính mức cao nhất mà các cell có khóa của test đạt tới; báo cáo xuất (`/p2o report export`, slice S6) dùng nó cho phụ lục WSTG. Mức chỉ phản ánh cell host chiếu từ công việc đã review (hoặc cell lưu legacy), không phản ánh target.

| Mức | Điều kiện |
|---|---|
| L0 chưa kiểm | không có cell còn hiệu lực, hoặc chỉ có cell `unplanned`, `planned`, `running` |
| L1 đã thử | cell `attempted` hoặc `blocked`, hoặc cell `tested` đã stale hay chưa xác minh được tính hiện hành |
| L2 đã kiểm | cell `tested` còn hiện hành (host chiếu từ task đã review + claim/case theo bảng ở [EVIDENCE](EVIDENCE.md); plan legacy đọc cell lưu); không suy ra "an toàn" ngoài ngữ cảnh đã thử |
| L3 đã chứng minh | cell `tested` còn hiện hành và dẫn tới case `confirmed` đã được accept, còn hiệu lực (`acceptedFinding` ở `cases.ts`); mức `proof` luôn phải hiển thị cạnh L3 |
| n/a | mọi cell của test là `not_applicable` (dùng cho test cờ O) |

## Làm mới khi WSTG đổi

1. Clone WSTG ở commit mới (chỉ đọc), rút ID từ bảng ID của từng trang trong `document/4-Web_Application_Security_Testing/` và đối chiếu `checklists/checklist.json` (có cả ID đã gộp).
2. Cập nhật `src/wstg-map.ts` và `WSTG_COMMIT`; phân loại test mới theo bảng trên.
3. `npm run build`, rồi `node scripts/render-wstg-map.mjs` (hoặc thêm `--source`) và dán kết quả đè lên các hàng dưới "WSTG map table".
4. Cập nhật số đếm D/T/N/O/B/I ở trên và trong test.

## Ví dụ cell coverage

**HOST-DERIVED (A3):** shape dưới đây là shape host dựng khi chiếu coverage từ công việc đã review — input là task đã review, claim worker của task đó (`data.taskRef`), case accepted và revision asset. Plan tạo trước A3 không có marker `derivation:'projected'` vẫn đọc cell lưu đúng shape này (legacy, read-only); test `wstg-map.test.ts` dùng `validateCoverageCellDraft` như parser của stored-cell legacy. Model không có verb tạo/sửa/retire cell. Ví dụ cho `wstg-athz-04` (IDOR) so sánh hai principal (operator niêm phong hoặc worker tự tạo); `assetRef.id` là ID tài sản thật từ `p2o_graph`, `methodFamily` là workflow id của skill mà bảng gắn cho test đó.

```json
{
  "assetRef": { "id": "asset-0123456789abcdef01234567", "revision": 1 },
  "questionKey": "wstg-athz-04",
  "policyKey": "policy:invoice-owner-only",
  "actorContext": "actor:user-a",
  "tenantContext": "tenant:t1",
  "methodFamily": "controlled-identity-comparison",
  "execution": "planned",
  "assessment": "unreviewed",
  "taskRefs": [],
  "claimRefs": [],
  "caseRefs": [],
  "evidenceRefs": [],
  "negativeControlRefs": [],
  "gapRefs": [],
  "reason": "Planned comparison of invoice objects between two controlled users",
  "limitations": "Not run yet; no evidence is recorded for this cell"
}
```

## WSTG map table

Pinned to OWASP WSTG commit 28553f878d48358767892916d53e59a9d664811c (https://github.com/OWASP/wstg).
Use the key (lower case) as the questionKey of a work identity; coverage cells carry the same key when the host derives them from reviewed work. Use a skill workflow id as methodFamily.
Support describes what this library carries, not what the target has: D = a skill names the object of the test and gives a method, conclusion rules or false-positive checks for it; T = only generic techniques apply; N = no skill; O = outside this library's knowledge scope by design: the test needs collection beyond the target (search engines, third-party DNS or cloud infrastructure), which is a knowledge-planning note, not a limitation of the run.
Flags: B = the effect happens in a browser; the sandbox image provides Chromium and the agent-browser CLI, so the worker drives the transport and proof can reach live_reproduction; I = needs an authenticated principal, which is the operator's sealed identity or one the worker provisions; - = none. Neither flag is a limitation of a shipped run.
Trigger: the features seen during recon that make the test worth planning (any = always; - = outside scope). Record a feature as an asset attribute named feature or as an observed fact, using these words: login, session-token, registration, password-reset, mfa, remember-me, jwt, oauth, roles, object-id, upload, xml-input, template-render, dynamic-code, outbound-fetch, db-query, os-command, file-path, mail-send, export-csv, serialized-input, crypto-use, reflected-input, stored-input, intermediary, redirect, client-js, client-storage, postmessage, websocket, graphql, api, payment, workflow, cors, frames, https, config, any.
Modes: S = source review, H = anonymous same-origin HTTP, A = HTTP with an authenticated principal (operator-sealed or worker-provisioned), N = sandbox network (TCP, TLS, WebSocket), B = needs the browser transport to prove the effect. Modes plan work; the run's blanket authorization already grants the access, and operator constraints can only narrow it.
Phase is where the test starts (recon or discovery); a confirmed claim still needs an independent validation worker.

| Key | WSTG ID | Test | Support | Flags | Phase | Skills | Trigger | Modes |
|---|---|---|---|---|---|---|---|---|
| wstg-info-01 | WSTG-INFO-01 | Conduct Search Engine Reconnaissance for Information Leakage | O | - | recon | - | - | - |
| wstg-info-02 | WSTG-INFO-02 | Fingerprint Web Server | D | - | recon | **web-deployment-hygiene**, attack-surface-mapping | any | H |
| wstg-info-03 | WSTG-INFO-03 | Review Webserver Metafiles for Information Leakage | D | - | recon | **web-deployment-hygiene**, attack-surface-mapping, web-route-input-inventory | any | SH |
| wstg-info-04 | WSTG-INFO-04 | Attack Surface Identification | T | - | recon | **attack-surface-mapping** | any | H |
| wstg-info-05 | WSTG-INFO-05 | Review Web Page Content for Information Leakage | D | - | recon | **web-deployment-hygiene**, attack-surface-mapping, source-code-auditing | any | SH |
| wstg-info-06 | WSTG-INFO-06 | Identify Application Entry Points | D | - | recon | **web-route-input-inventory** | any | SH |
| wstg-info-07 | WSTG-INFO-07 | Map Execution Paths Through Application | D | - | recon | **web-route-input-inventory**, data-flow-analysis | workflow | SH |
| wstg-info-08 | WSTG-INFO-08 | Fingerprint Web Application Framework | D | - | recon | **web-deployment-hygiene**, attack-surface-mapping | any | SH |
| wstg-info-10 | WSTG-INFO-10 | Map Application Architecture | T | - | recon | **attack-surface-mapping** | any | SH |
| wstg-conf-01 | WSTG-CONF-01 | Network Infrastructure Configuration | O | - | discovery | - | - | - |
| wstg-conf-02 | WSTG-CONF-02 | Application Platform Configuration | D | - | discovery | **web-deployment-hygiene**, source-code-auditing, attack-surface-mapping | config | SH |
| wstg-conf-04 | WSTG-CONF-04 | Review Old Backup and Unreferenced Files for Sensitive Information | D | - | discovery | **web-deployment-hygiene**, source-code-auditing, attack-surface-mapping | any | SH |
| wstg-conf-05 | WSTG-CONF-05 | Enumerate Infrastructure and Application Admin Interfaces | D | - | recon | **web-deployment-hygiene**, attack-surface-mapping, web-route-input-inventory | any | SH |
| wstg-conf-06 | WSTG-CONF-06 | HTTP Methods | D | - | recon | **web-deployment-hygiene**, attack-surface-mapping | any | H |
| wstg-conf-07 | WSTG-CONF-07 | HTTP Strict Transport Security | D | - | recon | **web-deployment-hygiene** | https | H |
| wstg-conf-09 | WSTG-CONF-09 | File Permissions | D | - | discovery | **web-deployment-hygiene** | config | S |
| wstg-conf-10 | WSTG-CONF-10 | Subdomain Takeover | O | - | discovery | - | - | - |
| wstg-conf-11 | WSTG-CONF-11 | Cloud Storage | O | - | discovery | - | - | - |
| wstg-conf-12 | WSTG-CONF-12 | Content Security Policy | D | B | recon | **web-browser-trust-controls** | any | HB |
| wstg-conf-13 | WSTG-CONF-13 | Path Confusion | D | - | discovery | **parser-differential-auditing** | any | SH |
| wstg-conf-14 | WSTG-CONF-14 | Other HTTP Security Header Misconfigurations | D | B | recon | **web-deployment-hygiene** | any | HB |
| wstg-conf-15 | WSTG-CONF-15 | Feature Flag Security Bypass | D | - | discovery | **web-deployment-hygiene**, source-code-auditing | config | SH |
| wstg-idnt-01 | WSTG-IDNT-01 | Role Definitions | D | I | discovery | **web-object-authorization** | roles | SA |
| wstg-idnt-02 | WSTG-IDNT-02 | User Registration Process | D | I | discovery | **web-credential-lifecycle**, authorization-auditing | registration | SHA |
| wstg-idnt-03 | WSTG-IDNT-03 | Account Provisioning Process | D | I | discovery | **web-credential-lifecycle**, authorization-auditing | registration, roles | SA |
| wstg-idnt-04 | WSTG-IDNT-04 | Account Enumeration and Guessable User Account | D | - | discovery | **web-credential-lifecycle**, authorization-auditing | login, registration, password-reset | SH |
| wstg-athn-02 | WSTG-ATHN-02 | Default Credentials | D | I | discovery | **web-credential-lifecycle** | login | SHA |
| wstg-athn-03 | WSTG-ATHN-03 | Weak Lock Out Mechanism | D | I | discovery | **web-credential-lifecycle** | login | SHA |
| wstg-athn-04 | WSTG-ATHN-04 | Bypassing Authentication Schema | D | I | discovery | **authorization-auditing**, fastapi-security-parity | login | SHA |
| wstg-athn-05 | WSTG-ATHN-05 | Vulnerable Remember Password | D | I | discovery | **web-credential-lifecycle** | remember-me | SA |
| wstg-athn-06 | WSTG-ATHN-06 | Browser Cache Weaknesses | D | B | discovery | **web-deployment-hygiene** | session-token | HB |
| wstg-athn-07 | WSTG-ATHN-07 | Weak Authentication Methods | D | I | discovery | **web-credential-lifecycle** | login, registration | SA |
| wstg-athn-08 | WSTG-ATHN-08 | Weak Security Question Answer | D | I | discovery | **web-credential-lifecycle** | password-reset | SA |
| wstg-athn-09 | WSTG-ATHN-09 | Weak Password Change or Reset Functionalities | D | I | discovery | **web-credential-lifecycle** | password-reset | SHA |
| wstg-athn-10 | WSTG-ATHN-10 | Weaker Authentication in Alternative Channel | D | I | discovery | **authorization-auditing** | login | SA |
| wstg-athn-11 | WSTG-ATHN-11 | Multi-Factor Authentication (MFA) | D | I | discovery | **web-credential-lifecycle** | mfa | SA |
| wstg-athz-01 | WSTG-ATHZ-01 | Directory Traversal File Include | D | - | discovery | **web-server-side-injection**, data-flow-analysis, source-code-auditing | file-path | SH |
| wstg-athz-02 | WSTG-ATHZ-02 | Bypassing Authorization Schema | D | I | discovery | **web-object-authorization**, authorization-auditing, fastapi-security-parity | login, roles | SA |
| wstg-athz-03 | WSTG-ATHZ-03 | Privilege Escalation | D | I | discovery | **web-object-authorization**, authorization-auditing | roles | SA |
| wstg-athz-04 | WSTG-ATHZ-04 | Insecure Direct Object References | D | I | discovery | **web-object-authorization** | object-id | SA |
| wstg-athz-05 | WSTG-ATHZ-05 | OAuth Weaknesses | D | I | discovery | **web-token-and-federation** | oauth | SA |
| wstg-sess-01 | WSTG-SESS-01 | Session Management Schema | D | I | discovery | **web-session-management** | session-token | SA |
| wstg-sess-02 | WSTG-SESS-02 | Cookies Attributes | D | - | discovery | **web-session-management** | session-token | SH |
| wstg-sess-03 | WSTG-SESS-03 | Session Fixation | D | I | discovery | **web-session-management** | session-token, login | SA |
| wstg-sess-04 | WSTG-SESS-04 | Exposed Session Variables | D | I | discovery | **web-session-management** | session-token | SA |
| wstg-sess-05 | WSTG-SESS-05 | Cross Site Request Forgery | D | BI | discovery | **web-browser-trust-controls** | session-token, workflow | SAB |
| wstg-sess-06 | WSTG-SESS-06 | Logout Functionality | D | I | discovery | **web-session-management** | session-token, login | SA |
| wstg-sess-07 | WSTG-SESS-07 | Session Timeout | D | I | discovery | **web-session-management** | session-token | SA |
| wstg-sess-08 | WSTG-SESS-08 | Session Puzzling | D | I | discovery | **web-session-management** | session-token, workflow | SA |
| wstg-sess-09 | WSTG-SESS-09 | Session Hijacking | D | I | discovery | **web-session-management** | session-token | SA |
| wstg-sess-10 | WSTG-SESS-10 | JSON Web Tokens | D | I | discovery | **web-token-and-federation** | jwt | SA |
| wstg-sess-11 | WSTG-SESS-11 | Concurrent Sessions | D | I | discovery | **web-session-management** | session-token, login | SA |
| wstg-injt-01 | WSTG-INJT-01 | Reflected Cross Site Scripting | D | B | discovery | **web-output-context** | reflected-input | SHB |
| wstg-injt-02 | WSTG-INJT-02 | Stored Cross Site Scripting | D | B | discovery | **web-output-context** | stored-input | SHB |
| wstg-injt-04 | WSTG-INJT-04 | HTTP Parameter Pollution | D | - | discovery | **parser-differential-auditing** | any | SH |
| wstg-injt-05 | WSTG-INJT-05 | SQL Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis, source-code-auditing | db-query | SH |
| wstg-injt-06 | WSTG-INJT-06 | LDAP Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis | db-query | SH |
| wstg-injt-07 | WSTG-INJT-07 | XML Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis, source-code-auditing | xml-input | SH |
| wstg-injt-08 | WSTG-INJT-08 | SSI Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis | template-render | SH |
| wstg-injt-09 | WSTG-INJT-09 | XPath Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis | xml-input | SH |
| wstg-injt-10 | WSTG-INJT-10 | IMAP SMTP Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis | mail-send | SH |
| wstg-injt-11 | WSTG-INJT-11 | Code Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis, source-code-auditing | dynamic-code | SH |
| wstg-injt-12 | WSTG-INJT-12 | Command Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis | os-command | SH |
| wstg-injt-13 | WSTG-INJT-13 | Format String Injection | D | - | discovery | **web-server-side-injection**, memory-safety-auditing | dynamic-code | S |
| wstg-injt-14 | WSTG-INJT-14 | Incubated Vulnerability | D | - | discovery | **web-server-side-injection**, data-flow-analysis | stored-input | SH |
| wstg-injt-15 | WSTG-INJT-15 | HTTP Response Splitting | D | - | discovery | **parser-differential-auditing** | reflected-input | SH |
| wstg-injt-16 | WSTG-INJT-16 | HTTP Request Smuggling | D | - | discovery | **parser-differential-auditing** | intermediary | SN |
| wstg-injt-17 | WSTG-INJT-17 | Host Header Injection | D | - | discovery | **attack-surface-mapping**, data-flow-analysis | intermediary | SH |
| wstg-injt-18 | WSTG-INJT-18 | Server-side Template Injection | D | - | discovery | **deserialization-and-dispatch-auditing** | template-render | SH |
| wstg-injt-19 | WSTG-INJT-19 | Server-Side Request Forgery | D | - | discovery | **web-server-side-injection**, data-flow-analysis | outbound-fetch | SHN |
| wstg-injt-20 | WSTG-INJT-20 | Mass Assignment | D | I | discovery | **web-object-authorization**, authorization-auditing | api | SA |
| wstg-injt-21 | WSTG-INJT-21 | CSV Injection | D | - | discovery | **web-server-side-injection**, data-flow-analysis | export-csv | SH |
| wstg-injt-22 | WSTG-INJT-22 | Prototype Pollution | D | - | discovery | **deserialization-and-dispatch-auditing** | api, client-js | SH |
| wstg-injt-23 | WSTG-INJT-23 | Insecure Deserialization | D | - | discovery | **deserialization-and-dispatch-auditing** | serialized-input | SH |
| wstg-errh-01 | WSTG-ERRH-01 | Improper Error Handling | D | - | discovery | **web-deployment-hygiene** | any | SH |
| wstg-cryp-01 | WSTG-CRYP-01 | Weak Transport Layer Security | D | - | discovery | **web-deployment-hygiene** | https | SHN |
| wstg-cryp-02 | WSTG-CRYP-02 | Padding Oracle | D | - | discovery | **web-crypto-usage-review** | crypto-use | SH |
| wstg-cryp-03 | WSTG-CRYP-03 | Sensitive Information Sent via Unencrypted Channels | D | - | discovery | **web-deployment-hygiene** | any | SHN |
| wstg-cryp-04 | WSTG-CRYP-04 | Weak Cryptographic Primitives | D | - | discovery | **web-crypto-usage-review**, source-code-auditing | crypto-use | S |
| wstg-busl-01 | WSTG-BUSL-01 | Business Logic Data Validation | D | I | discovery | **web-business-logic-misuse** | workflow | SA |
| wstg-busl-02 | WSTG-BUSL-02 | Ability to Forge Requests | D | I | discovery | **web-business-logic-misuse** | workflow | SA |
| wstg-busl-03 | WSTG-BUSL-03 | Integrity Checks | D | I | discovery | **web-business-logic-misuse** | workflow | SA |
| wstg-busl-04 | WSTG-BUSL-04 | Process Timing | D | I | discovery | **web-business-logic-misuse**, source-code-auditing | workflow | SA |
| wstg-busl-05 | WSTG-BUSL-05 | Number of Times a Function Can Be Used Limits | D | I | discovery | **race-condition-auditing** | workflow | SA |
| wstg-busl-06 | WSTG-BUSL-06 | Circumvention of Work Flows | D | I | discovery | **web-business-logic-misuse**, source-code-auditing, data-flow-analysis | workflow | SA |
| wstg-busl-07 | WSTG-BUSL-07 | Defenses Against Application Misuse | D | I | discovery | **web-business-logic-misuse** | workflow | SA |
| wstg-busl-08 | WSTG-BUSL-08 | Upload of Unexpected File Types | D | I | discovery | **web-business-logic-misuse** | upload | SA |
| wstg-busl-09 | WSTG-BUSL-09 | Upload of Malicious Files | D | I | discovery | **web-business-logic-misuse** | upload | SA |
| wstg-busl-10 | WSTG-BUSL-10 | Payment Functionality | D | I | discovery | **web-business-logic-misuse** | payment | SA |
| wstg-clnt-01 | WSTG-CLNT-01 | DOM-Based Cross Site Scripting | D | B | discovery | **web-output-context** | client-js | SHB |
| wstg-clnt-02 | WSTG-CLNT-02 | JavaScript Execution | D | B | discovery | **web-output-context** | client-js | SHB |
| wstg-clnt-03 | WSTG-CLNT-03 | HTML Injection | D | B | discovery | **web-output-context** | reflected-input | SHB |
| wstg-clnt-04 | WSTG-CLNT-04 | Client-side URL Redirect | D | B | discovery | **web-browser-trust-controls**, data-flow-analysis | redirect | SHB |
| wstg-clnt-05 | WSTG-CLNT-05 | CSS Injection | D | B | discovery | **web-browser-trust-controls**, data-flow-analysis | reflected-input | SHB |
| wstg-clnt-06 | WSTG-CLNT-06 | Client-side Resource Manipulation | D | B | discovery | **web-browser-trust-controls**, data-flow-analysis | client-js | SHB |
| wstg-clnt-07 | WSTG-CLNT-07 | Cross Origin Resource Sharing | D | B | discovery | **web-browser-trust-controls** | cors | HB |
| wstg-clnt-09 | WSTG-CLNT-09 | Clickjacking | D | B | discovery | **web-browser-trust-controls** | frames | HB |
| wstg-clnt-10 | WSTG-CLNT-10 | WebSockets | D | B | discovery | **web-browser-trust-controls** | websocket | SNB |
| wstg-clnt-11 | WSTG-CLNT-11 | Web Messaging | D | B | discovery | **web-browser-trust-controls** | postmessage | SHB |
| wstg-clnt-12 | WSTG-CLNT-12 | Browser Storage | D | B | discovery | **web-browser-trust-controls** | client-storage | SHB |
| wstg-clnt-13 | WSTG-CLNT-13 | Cross Site Script Inclusion | D | B | discovery | **web-browser-trust-controls** | client-js | HB |
| wstg-clnt-14 | WSTG-CLNT-14 | Reverse Tabnabbing | D | B | discovery | **web-browser-trust-controls** | client-js | SHB |
| wstg-clnt-15 | WSTG-CLNT-15 | Client-side Template Injection | D | B | discovery | **web-browser-trust-controls**, data-flow-analysis | client-js | SHB |
| wstg-apit-01 | WSTG-APIT-01 | API Reconnaissance | D | - | recon | **web-route-input-inventory** | api | SH |
| wstg-apit-02 | WSTG-APIT-02 | API Broken Object Level Authorization | D | I | discovery | **web-object-authorization** | api, object-id | SA |
| wstg-apit-03 | WSTG-APIT-03 | Excessive Data Exposure | D | - | discovery | **web-object-authorization**, data-flow-analysis | api | SH |
| wstg-apit-04 | WSTG-APIT-04 | API Broken Function Level Authorization | D | I | discovery | **web-object-authorization**, authorization-auditing | api, roles | SA |
| wstg-apit-99 | WSTG-APIT-99 | GraphQL | D | - | discovery | **web-graphql-testing** | graphql | SH |
