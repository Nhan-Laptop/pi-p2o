# Canonical case review và proof-aware coverage — checkout K5

**Đã nối vào runtime, đã push và cài (không có release/version riêng); K0–K7 chưa hoàn tất.**
K5 xây trên candidate/evidence/TaskBoard/Asset Graph hiện có. Nó không tạo finding store,
execution queue, scope grant hay goal-completion engine thứ hai.

## Claim, case và finding là ba mức khác nhau

1. `p2o_candidate` là **attributed claim** của owner/Worker. `closure=confirmed` vẫn chỉ
   “claimed confirmed — pending review”. Revision mới dùng `supersedes`; lịch sử không bị xóa.
2. `p2o_case` là revision do owner viết trên canonical records, pin exact candidate record IDs,
   asset/task/hypothesis revisions, evidence/report IDs, contradictions và limitations.
3. Chỉ case `reviewStatus=accepted`, `verdict=confirmed`, canonical (không `duplicateOf`) và
   `currentness=current` mới được đếm là **unique accepted-current finding**. Đây vẫn không
   hoàn thành assessment goal hoặc chứng minh toàn target an toàn.

Worker/reporting không có `p2o_case`/`p2o_coverage`. Imported history/checkpoints/ACKs chỉ là
knowledge; không restore review authority, Worker, ticket, cookie, socket, queue hay allowance.

## Case identity, review và currentness

```text
case ID + revision
policy key + optional reviewed root-cause key
asset/variant IDs@revision + optional hypothesis@revision
exact candidate claim record IDs
exact task@revision/report/evidence references
contradictions + affected variants + related/duplicate case IDs
verdict + review status + limitations + remediation/retest state
```

`title`, CWE/severity hoặc prose không phải duplicate key. Case có root cause chưa chắc chắn phải
ở `relatedCaseIds`; accepted `duplicateOf` cần cùng non-empty `policyKey` + `rootCauseKey`, target
là current accepted canonical finding, và duplicate chain phải acyclic. Original submission và mọi
revision vẫn còn. Một duplicate accepted không tăng unique-finding count.

Review transition explicit:

- Create chỉ `pending`; `accepted|disputed|withdrawn` cần revision mới với expected revision.
- `accepted` không được giữ contradiction `open`.
- `confirmed` cần current tested claim có non-inferred policy basis.
- `ruled_out` cần current ruled-out claim và control cụ thể.
- Optional independent badge cần receipt của Worker khác và current matching runtime candidate.
  Validator withdrawal/supersession làm badge, case và report projection stale.
- Asset/hypothesis/task/claim/case revision đổi làm support stale. Không tự copy sang revision mới.
- Remediation `implemented` không đồng nghĩa fixed. `accepted` remediation cần exact reviewed
  retest task + evidence; trạng thái này vẫn tách khỏi case verdict và goal.

Candidate supersession ghi `support.invalidated` cùng transaction với claim revision và liệt kê
bounded affected case heads. Event-driven Engine nhận semantic hint **sau commit**; manual mode
không gọi model. Retained request replay không phát event/wake thứ hai.

## Tool contract

`p2o_case` có root-object schema tương thích provider projection:

```json
{"action":"create","requestId":"owner-case-1","entry":{...}}
{"action":"revise","id":"case-...","revision":1,"entry":{...}}
{"action":"list","cursor":0,"limit":20,"status":"pending"}
{"action":"view","id":"case-..."}
{"action":"rate","id":"case-...","revision":2,"finding":{"severity":"medium","basis":"...","cvssVector":"CVSS:3.1/AV:N/...","cwe":["CWE-639"],"remediationSteps":"...","references":["wstg-athz-04"],"reproductionEvidenceRefs":["..."]}}
```

**Rating (P3).** `rate` ghi một **note riêng của owner** (`data.caseRating`) gắn với revision case đã nêu; nó không phải revision của case, nên **không đổi verdict, review status hay revision và không làm stale các coverage cell đã pin case**. `severity` ∈ critical/high/medium/low/informational là thang p2o cố định (xem rubric ở `skills/remediation/references/risk-rating-criteria.md`); `basis` bắt buộc; `cvssVector` tùy chọn và **host tự tính điểm** CVSS 3.1 (`src/cvss.ts`); `cwe` (`CWE-<số>`), `references` (khóa WSTG hoặc URL https, in dạng code) là chuỗi owner ghi, host không tra MITRE. Case dựa trên policy `inferred` không được rate trên Medium. Rating lưu `caseRevision`; khi case đổi revision, rating cũ vẫn còn nhưng báo cáo và preflight (`STALE_RATING`) đánh dấu để owner xác nhận lại. Case chưa rate vẫn đọc như cũ (không có trường `finding`).

Host bind action, logical input, ID/revision và transport payload vào request HMAC. Lost ACK đọc
retained result; không chạy lại builder/target. Changed input cùng request ID →
`IDEMPOTENCY_CONFLICT`. Concurrent head revision chỉ một mutation thắng.

## Coverage plan: denominator explicit, hai axes riêng

`p2o_coverage` duy trì plan và cell revisions trên cùng canonical records:

```text
execution:  unplanned | planned | running | attempted | tested | blocked | not_applicable
assessment: unreviewed | confirmed_claim | ruled_out_bounded | open_gap | accepted | stale
```

Cell identity version 1:

```text
target/source revision + asset/variant@revision
+ question/policy key + actor/tenant context + method family
```

Không hash prose. Identity đổi phải retire cell cũ rồi add cell mới; plan revision ghi denominator
`+1/-1`, không overwrite lịch sử. Add/revise/retire cell commit **plan revision + cell revision**
trong một transaction. Fault trước commit rollback cả packet; fault sau commit chỉ inspect/replay
hai ACKs, không tăng denominator lần nữa.

Gates:

- `tested` cần exact reviewed/closed task revision và same-run evidence.
- `blocked` phải giữ `open_gap` + open-record reference.
- `confirmed_claim` pin exact confirmed candidate claim; chưa phải accepted finding.
- `ruled_out_bounded` cần current accepted ruled-out case, evidence và negative controls.
- `accepted` cần current owner-accepted case revision.
- Superseded candidate/case/task, changed asset/target, missing/resolved gap hoặc missing evidence làm
  effective assessment `stale`; chỉ downgrade, không auto-upgrade.
- Discovered graph assets ngoài denominator và `unknownScope` hiển thị riêng. 100% plan cells không
  có nghĩa toàn hệ thống an toàn; blocked/untested/not-applicable không tự thành clean.

Actions:

```text
plan-create | plan-revise
cell-create | cell-revise | cell-retire
list | view
```

Plan `reviewed/closed` chỉ mô tả lifecycle của denominator. Empty queue/case close/plan close không
complete goal hoặc assessment outcome.

## Human views và final bundle

```text
/p2o findings [cursor]
/p2o finding <case-id>
/p2o coverage [cursor]
/p2o coverage-cell <cell-id>
/p2o report
/p2o checkpoints <checkpoint-id>
```

Các view chỉ đọc canonical snapshot, không model/target call hay durable mutation. Historical open
có cùng projections nhưng no authority. `reportProjection`/cleanup export và checkpoint chứa:

- candidate submissions versus canonical cases;
- unique accepted-current, duplicates, pending/disputed/stale cases;
- independent-current state và support pins;
- plan/cell execution + effective-assessment counts;
- stale cells, discovered-unplanned assets, unknown scope/open gaps.

Repeated report delivery có thể tăng report history nhưng không tăng unique cases/findings. Final
bundle vẫn labelled attributed/bounded; cleanup outcome, task completion, case acceptance, coverage
review và assessment goal là các axes độc lập.

## Default / min / max

| Bound / option | Default | Min | Max / semantics |
|---|---:|---:|---|
| Live non-withdrawn cases | — | 0 | 100; terminal history không bị xóa |
| Assets / claims / tasks / reports per case | explicit | assets 1, claims 1 | 10 mỗi list |
| Independent refs / contradictions / related cases | `[]` | 0 | 10 |
| Affected variants | `[]` | 0 | 20 |
| Live coverage plans | — | 0 | 10 |
| Cells / plan denominator | `[]` | 0 | 100 current IDs |
| Cell task/claim/case/evidence/control/gap refs | `[]` | 0 | 10 mỗi list |
| Case/coverage list | 20 | 1 | 100; encoded tool result ≤24 KiB |
| Human page | 20 | 1 | 20 snapshot-relative items |
| Owner knowledge allowance | 400 | — | shared với graph/plan; retained ACK không charge lần hai |
| Row / mutation | — | 1 row | 16 KiB/row; 128 rows/128 KiB canonical packet |
| Added elapsed TTL / retry | none | — | none; không renew budgets/authority |

## Qualification scope và phần còn mở

Unit/runtime/actual-Pi fixtures cover current claim acceptance, independent withdrawal, contradiction,
root-cause duplicate gate, asset staleness, request replay/concurrency, explicit denominator, blocked
and ruled-out gates, atomic denominator rollback, report-count separation, checkpoint/historical views
và root-object provider schema. Provider/target đều inert; không paid/live effectiveness hoặc finding
correctness proof.

K5 còn phụ thuộc K6 cho indexed large-history/relevance/context packets và archive policy. K2 còn
ancestor/import/archive/privacy hardening; K4 còn richer branch output review. K7 phải requalify toàn
checkout, package/source/install hashes và release checklist. Mechanics không chứng minh savings,
optimality hoặc superiority so với ARTEX.
