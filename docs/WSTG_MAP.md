# Ánh xạ OWASP WSTG sang thư viện p2o

Bảng 108 test còn hiệu lực của [OWASP WSTG](https://github.com/OWASP/wstg) (commit `28553f878d48358767892916d53e59a9d664811c`, `master` ngày 2026-10-10) với kiến thức mà p2o đang mang. Đây là **độ phủ kiến thức của thư viện**, không phải khả năng phát hiện và không phải kết quả của một lần assessment (hiệu quả pentest vẫn là UNVERIFIED cho tới khi có benchmark được phép). Lý do thiết kế: [planning_update.md](../planning_update.md) §B.

Dữ liệu nằm ở `src/wstg-map.ts` cùng hai hàm thuần `wstgKey` và `wstgEvidence`. Bảng ở cuối trang là bản đọc được; `tests/minimal/wstg-map.test.ts` ép hai bản bằng nhau. Không có trường schema, trạng thái hay tool mới: khóa test chỉ là một giá trị của `questionKey` sẵn có.

## Cách dùng khóa

- Dùng ID WSTG viết thường làm `questionKey` (ví dụ `wstg-athz-04`) cho work identity (`p2o_task`, `p2o_delegate` với `work`) và cho cell coverage (`p2o_coverage`). `key()` chỉ nhận `[a-z0-9._:/-]` nên dạng viết hoa không hợp lệ.
- `methodFamily` giữ id workflow của skill (`source-review`, `offline-reproduction`...). `policyKey` giữ nghĩa chính sách của ứng dụng, không dùng cho ID WSTG.
- `questionKey` đi vào vân tay trùng lặp, nên hai worker cùng thử một test WSTG trên cùng asset và cùng ngữ cảnh sẽ bị phát hiện trùng chính xác.
- ID WSTG đã đổi giữa các bản (nhóm Input Validation `INPV` nay là Injection `INJT`; `INJT-13` được gán lại cho Format String). Luôn đọc ID cùng tiêu đề và commit đã ghim.

## Mức hỗ trợ của thư viện (cột Support)

| Mã | Ý nghĩa | Số test |
|---|---|---|
| D | có skill mà mô tả gọi tên đúng lớp lỗi của test | 26 |
| T | chỉ có kỹ thuật chung (`attack-surface-mapping`, `data-flow-analysis`, `source-code-auditing`, `authorization-auditing`) | 35 |
| N | chưa có skill nào | 43 |
| O | ngoài scope của p2o theo thiết kế: cần origin khác, DNS hoặc bên thứ ba | 4 |

Cờ B (20 test): hiệu ứng xảy ra ở trình duyệt; p2o không có browser nên bằng chứng tối đa là `offline_reproduction`. Cờ I (39 test): cần identity do operator cấp. Phân loại là suy luận từ tiêu đề test và mô tả skill trong catalog (DESIGN-INFERENCE), chưa đọc từng `SKILL.md` ở mức câu; owner rà soát được (planning_update.md câu hỏi Q6).

## Mức bằng chứng của một assessment (L0 đến L3)

Hàm `wstgEvidence` tính mức cao nhất mà các cell có khóa của test đạt tới; báo cáo xuất (`/p2o report export`, slice S6) dùng nó cho phụ lục WSTG. Mức chỉ phản ánh các cell đã ghi, không phản ánh target.

| Mức | Điều kiện |
|---|---|
| L0 chưa kiểm | không có cell còn hiệu lực, hoặc chỉ có cell `unplanned`, `planned`, `running` |
| L1 đã thử | cell `attempted` hoặc `blocked`, hoặc cell `tested` đã stale hay chưa xác minh được tính hiện hành |
| L2 đã kiểm | cell `tested` còn hiện hành (cổng ở `coverage.ts`: có evidence và task đã review); không suy ra "an toàn" ngoài ngữ cảnh đã thử |
| L3 đã chứng minh | cell `tested` còn hiện hành và dẫn tới case `confirmed` đã được accept, còn hiệu lực (`acceptedFinding` ở `cases.ts`); mức `proof` luôn phải hiển thị cạnh L3 |
| n/a | mọi cell của test là `not_applicable` (dùng cho test cờ O) |

## Làm mới khi WSTG đổi

1. Clone WSTG ở commit mới (chỉ đọc), rút ID từ bảng ID của từng trang trong `document/4-Web_Application_Security_Testing/` và đối chiếu `checklists/checklist.json` (có cả ID đã gộp).
2. Cập nhật `src/wstg-map.ts` và `WSTG_COMMIT`; phân loại test mới theo bảng trên.
3. `npm run build`, rồi `node scripts/render-wstg-map.mjs` (hoặc thêm `--source`) và dán kết quả đè lên các hàng dưới "WSTG map table".
4. Cập nhật số đếm D/T/N/O/B/I ở trên và trong test.

## Ví dụ cell coverage

Một cell kế hoạch cho `wstg-athz-04` (IDOR) so sánh hai danh tính do operator cấp. `assetRef.id` là ID tài sản thật từ `p2o_graph`; test `wstg-map.test.ts` kiểm ví dụ này hợp lệ theo `validateCoverageCellDraft`, dùng khóa có trong bảng và `methodFamily` là workflow của skill mà bảng gắn cho test đó.

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
Use the key (lower case) as the questionKey of a work identity or of a coverage cell, and a skill workflow id as methodFamily.
Support describes what this library carries, not what the target has: D = a skill names this class of test; T = only generic techniques apply; N = no skill; O = outside this tool's scope by design (other origins, DNS, third parties).
Flags: B = the effect happens in a browser and none is available, so proof stops at offline reproduction; I = needs identities supplied by the operator; - = none.
Phase is where the test starts (recon or discovery); a confirmed claim still needs an independent validation worker.

| Key | WSTG ID | Test | Support | Flags | Phase | Skills |
|---|---|---|---|---|---|---|
| wstg-info-01 | WSTG-INFO-01 | Conduct Search Engine Reconnaissance for Information Leakage | O | - | recon | - |
| wstg-info-02 | WSTG-INFO-02 | Fingerprint Web Server | T | - | recon | attack-surface-mapping |
| wstg-info-03 | WSTG-INFO-03 | Review Webserver Metafiles for Information Leakage | T | - | recon | attack-surface-mapping, web-route-input-inventory |
| wstg-info-04 | WSTG-INFO-04 | Attack Surface Identification | T | - | recon | attack-surface-mapping |
| wstg-info-05 | WSTG-INFO-05 | Review Web Page Content for Information Leakage | T | - | recon | attack-surface-mapping, source-code-auditing |
| wstg-info-06 | WSTG-INFO-06 | Identify Application Entry Points | D | - | recon | web-route-input-inventory |
| wstg-info-07 | WSTG-INFO-07 | Map Execution Paths Through Application | D | - | recon | web-route-input-inventory, data-flow-analysis |
| wstg-info-08 | WSTG-INFO-08 | Fingerprint Web Application Framework | T | - | recon | attack-surface-mapping |
| wstg-info-10 | WSTG-INFO-10 | Map Application Architecture | T | - | recon | attack-surface-mapping |
| wstg-conf-01 | WSTG-CONF-01 | Network Infrastructure Configuration | O | - | discovery | - |
| wstg-conf-02 | WSTG-CONF-02 | Application Platform Configuration | T | - | discovery | source-code-auditing, attack-surface-mapping |
| wstg-conf-04 | WSTG-CONF-04 | Review Old Backup and Unreferenced Files for Sensitive Information | T | - | discovery | source-code-auditing, attack-surface-mapping |
| wstg-conf-05 | WSTG-CONF-05 | Enumerate Infrastructure and Application Admin Interfaces | T | - | recon | attack-surface-mapping, web-route-input-inventory |
| wstg-conf-06 | WSTG-CONF-06 | HTTP Methods | T | - | recon | attack-surface-mapping |
| wstg-conf-07 | WSTG-CONF-07 | HTTP Strict Transport Security | N | - | recon | - |
| wstg-conf-09 | WSTG-CONF-09 | File Permissions | N | - | discovery | - |
| wstg-conf-10 | WSTG-CONF-10 | Subdomain Takeover | O | - | discovery | - |
| wstg-conf-11 | WSTG-CONF-11 | Cloud Storage | O | - | discovery | - |
| wstg-conf-12 | WSTG-CONF-12 | Content Security Policy | N | B | recon | - |
| wstg-conf-13 | WSTG-CONF-13 | Path Confusion | D | - | discovery | parser-differential-auditing |
| wstg-conf-14 | WSTG-CONF-14 | Other HTTP Security Header Misconfigurations | N | B | recon | - |
| wstg-conf-15 | WSTG-CONF-15 | Feature Flag Security Bypass | T | - | discovery | source-code-auditing |
| wstg-idnt-01 | WSTG-IDNT-01 | Role Definitions | D | I | discovery | web-object-authorization |
| wstg-idnt-02 | WSTG-IDNT-02 | User Registration Process | T | I | discovery | authorization-auditing |
| wstg-idnt-03 | WSTG-IDNT-03 | Account Provisioning Process | T | I | discovery | authorization-auditing |
| wstg-idnt-04 | WSTG-IDNT-04 | Account Enumeration and Guessable User Account | T | - | discovery | authorization-auditing |
| wstg-athn-02 | WSTG-ATHN-02 | Default Credentials | N | I | discovery | - |
| wstg-athn-03 | WSTG-ATHN-03 | Weak Lock Out Mechanism | N | I | discovery | - |
| wstg-athn-04 | WSTG-ATHN-04 | Bypassing Authentication Schema | D | I | discovery | authorization-auditing, fastapi-security-parity |
| wstg-athn-05 | WSTG-ATHN-05 | Vulnerable Remember Password | N | I | discovery | - |
| wstg-athn-06 | WSTG-ATHN-06 | Browser Cache Weaknesses | N | B | discovery | - |
| wstg-athn-07 | WSTG-ATHN-07 | Weak Authentication Methods | N | I | discovery | - |
| wstg-athn-08 | WSTG-ATHN-08 | Weak Security Question Answer | N | I | discovery | - |
| wstg-athn-09 | WSTG-ATHN-09 | Weak Password Change or Reset Functionalities | N | I | discovery | - |
| wstg-athn-10 | WSTG-ATHN-10 | Weaker Authentication in Alternative Channel | D | I | discovery | authorization-auditing |
| wstg-athn-11 | WSTG-ATHN-11 | Multi-Factor Authentication (MFA) | N | I | discovery | - |
| wstg-athz-01 | WSTG-ATHZ-01 | Directory Traversal File Include | T | - | discovery | data-flow-analysis, source-code-auditing |
| wstg-athz-02 | WSTG-ATHZ-02 | Bypassing Authorization Schema | D | I | discovery | web-object-authorization, authorization-auditing, fastapi-security-parity |
| wstg-athz-03 | WSTG-ATHZ-03 | Privilege Escalation | D | I | discovery | web-object-authorization, authorization-auditing |
| wstg-athz-04 | WSTG-ATHZ-04 | Insecure Direct Object References | D | I | discovery | web-object-authorization |
| wstg-athz-05 | WSTG-ATHZ-05 | OAuth Weaknesses | N | I | discovery | - |
| wstg-sess-01 | WSTG-SESS-01 | Session Management Schema | N | I | discovery | - |
| wstg-sess-02 | WSTG-SESS-02 | Cookies Attributes | N | - | discovery | - |
| wstg-sess-03 | WSTG-SESS-03 | Session Fixation | N | I | discovery | - |
| wstg-sess-04 | WSTG-SESS-04 | Exposed Session Variables | N | I | discovery | - |
| wstg-sess-05 | WSTG-SESS-05 | Cross Site Request Forgery | N | BI | discovery | - |
| wstg-sess-06 | WSTG-SESS-06 | Logout Functionality | N | I | discovery | - |
| wstg-sess-07 | WSTG-SESS-07 | Session Timeout | N | I | discovery | - |
| wstg-sess-08 | WSTG-SESS-08 | Session Puzzling | N | I | discovery | - |
| wstg-sess-09 | WSTG-SESS-09 | Session Hijacking | N | I | discovery | - |
| wstg-sess-10 | WSTG-SESS-10 | JSON Web Tokens | N | I | discovery | - |
| wstg-sess-11 | WSTG-SESS-11 | Concurrent Sessions | N | I | discovery | - |
| wstg-injt-01 | WSTG-INJT-01 | Reflected Cross Site Scripting | D | B | discovery | web-output-context |
| wstg-injt-02 | WSTG-INJT-02 | Stored Cross Site Scripting | D | B | discovery | web-output-context |
| wstg-injt-04 | WSTG-INJT-04 | HTTP Parameter Pollution | D | - | discovery | parser-differential-auditing |
| wstg-injt-05 | WSTG-INJT-05 | SQL Injection | T | - | discovery | data-flow-analysis, source-code-auditing |
| wstg-injt-06 | WSTG-INJT-06 | LDAP Injection | T | - | discovery | data-flow-analysis |
| wstg-injt-07 | WSTG-INJT-07 | XML Injection | T | - | discovery | data-flow-analysis, source-code-auditing |
| wstg-injt-08 | WSTG-INJT-08 | SSI Injection | T | - | discovery | data-flow-analysis |
| wstg-injt-09 | WSTG-INJT-09 | XPath Injection | T | - | discovery | data-flow-analysis |
| wstg-injt-10 | WSTG-INJT-10 | IMAP SMTP Injection | T | - | discovery | data-flow-analysis |
| wstg-injt-11 | WSTG-INJT-11 | Code Injection | T | - | discovery | data-flow-analysis, source-code-auditing |
| wstg-injt-12 | WSTG-INJT-12 | Command Injection | T | - | discovery | data-flow-analysis |
| wstg-injt-13 | WSTG-INJT-13 | Format String Injection | D | - | discovery | memory-safety-auditing |
| wstg-injt-14 | WSTG-INJT-14 | Incubated Vulnerability | T | - | discovery | data-flow-analysis |
| wstg-injt-15 | WSTG-INJT-15 | HTTP Response Splitting | D | - | discovery | parser-differential-auditing |
| wstg-injt-16 | WSTG-INJT-16 | HTTP Request Smuggling | D | - | discovery | parser-differential-auditing |
| wstg-injt-17 | WSTG-INJT-17 | Host Header Injection | T | - | discovery | attack-surface-mapping, data-flow-analysis |
| wstg-injt-18 | WSTG-INJT-18 | Server-side Template Injection | D | - | discovery | deserialization-and-dispatch-auditing |
| wstg-injt-19 | WSTG-INJT-19 | Server-Side Request Forgery | T | - | discovery | data-flow-analysis |
| wstg-injt-20 | WSTG-INJT-20 | Mass Assignment | D | I | discovery | authorization-auditing |
| wstg-injt-21 | WSTG-INJT-21 | CSV Injection | T | - | discovery | data-flow-analysis |
| wstg-injt-22 | WSTG-INJT-22 | Prototype Pollution | D | - | discovery | deserialization-and-dispatch-auditing |
| wstg-injt-23 | WSTG-INJT-23 | Insecure Deserialization | D | - | discovery | deserialization-and-dispatch-auditing |
| wstg-errh-01 | WSTG-ERRH-01 | Improper Error Handling | N | - | discovery | - |
| wstg-cryp-01 | WSTG-CRYP-01 | Weak Transport Layer Security | N | - | discovery | - |
| wstg-cryp-02 | WSTG-CRYP-02 | Padding Oracle | N | - | discovery | - |
| wstg-cryp-03 | WSTG-CRYP-03 | Sensitive Information Sent via Unencrypted Channels | N | - | discovery | - |
| wstg-cryp-04 | WSTG-CRYP-04 | Weak Cryptographic Primitives | T | - | discovery | source-code-auditing |
| wstg-busl-01 | WSTG-BUSL-01 | Business Logic Data Validation | N | I | discovery | - |
| wstg-busl-02 | WSTG-BUSL-02 | Ability to Forge Requests | N | I | discovery | - |
| wstg-busl-03 | WSTG-BUSL-03 | Integrity Checks | N | I | discovery | - |
| wstg-busl-04 | WSTG-BUSL-04 | Process Timing | T | I | discovery | source-code-auditing |
| wstg-busl-05 | WSTG-BUSL-05 | Number of Times a Function Can Be Used Limits | D | I | discovery | race-condition-auditing |
| wstg-busl-06 | WSTG-BUSL-06 | Circumvention of Work Flows | T | I | discovery | source-code-auditing, data-flow-analysis |
| wstg-busl-07 | WSTG-BUSL-07 | Defenses Against Application Misuse | N | I | discovery | - |
| wstg-busl-08 | WSTG-BUSL-08 | Upload of Unexpected File Types | N | I | discovery | - |
| wstg-busl-09 | WSTG-BUSL-09 | Upload of Malicious Files | N | I | discovery | - |
| wstg-busl-10 | WSTG-BUSL-10 | Payment Functionality | N | I | discovery | - |
| wstg-clnt-01 | WSTG-CLNT-01 | DOM-Based Cross Site Scripting | D | B | discovery | web-output-context |
| wstg-clnt-02 | WSTG-CLNT-02 | JavaScript Execution | D | B | discovery | web-output-context |
| wstg-clnt-03 | WSTG-CLNT-03 | HTML Injection | D | B | discovery | web-output-context |
| wstg-clnt-04 | WSTG-CLNT-04 | Client-side URL Redirect | T | B | discovery | data-flow-analysis |
| wstg-clnt-05 | WSTG-CLNT-05 | CSS Injection | T | B | discovery | data-flow-analysis |
| wstg-clnt-06 | WSTG-CLNT-06 | Client-side Resource Manipulation | T | B | discovery | data-flow-analysis |
| wstg-clnt-07 | WSTG-CLNT-07 | Cross Origin Resource Sharing | N | B | discovery | - |
| wstg-clnt-09 | WSTG-CLNT-09 | Clickjacking | N | B | discovery | - |
| wstg-clnt-10 | WSTG-CLNT-10 | WebSockets | N | B | discovery | - |
| wstg-clnt-11 | WSTG-CLNT-11 | Web Messaging | N | B | discovery | - |
| wstg-clnt-12 | WSTG-CLNT-12 | Browser Storage | N | B | discovery | - |
| wstg-clnt-13 | WSTG-CLNT-13 | Cross Site Script Inclusion | N | B | discovery | - |
| wstg-clnt-14 | WSTG-CLNT-14 | Reverse Tabnabbing | N | B | discovery | - |
| wstg-clnt-15 | WSTG-CLNT-15 | Client-side Template Injection | T | B | discovery | data-flow-analysis |
| wstg-apit-01 | WSTG-APIT-01 | API Reconnaissance | D | - | recon | web-route-input-inventory |
| wstg-apit-02 | WSTG-APIT-02 | API Broken Object Level Authorization | D | I | discovery | web-object-authorization |
| wstg-apit-03 | WSTG-APIT-03 | Excessive Data Exposure | T | - | discovery | data-flow-analysis |
| wstg-apit-04 | WSTG-APIT-04 | API Broken Function Level Authorization | D | I | discovery | web-object-authorization, authorization-auditing |
| wstg-apit-99 | WSTG-APIT-99 | GraphQL | N | - | discovery | - |
