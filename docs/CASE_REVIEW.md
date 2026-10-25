# Canonical case review và proof-aware coverage (K5)

Xây trên candidate/evidence/TaskBoard/graph hiện có; không có finding store, queue hay goal-completion engine thứ hai.
Bản chi tiết cũ: `git show 656843d:docs/CASE_REVIEW.md`.

## Ba mức: claim → case → finding

1. `p2o_candidate`: **claim có gán tác giả** của owner/Worker; `confirmed` chỉ là "claimed confirmed — pending review".
2. `p2o_case_create` / `p2o_case_revise` (owner): revision pin chính xác candidate record, asset/task/hypothesis revision, evidence/report, contradiction, limitation.
3. Chỉ case `accepted` + `confirmed` + canonical (không `duplicateOf`) + `currentness=current` mới đếm là **unique accepted-current finding**
   — vẫn không có nghĩa assessment xong hay target an toàn.

Worker/reporting không có case/coverage verbs. Dữ liệu import/checkpoint chỉ là tri thức.

## Quy tắc review

- Create luôn `pending`; `accepted|disputed|withdrawn` cần revision mới với `revision` kỳ vọng; không accept khi còn contradiction `open`.
- `confirmed` cần claim đã tested có policy basis không phải `inferred`; `ruled_out` cần claim ruled-out hiện tại + control cụ thể.
- Huy hiệu độc lập cần receipt của Worker khác; validator rút lại thì case/report stale. Asset/task/claim/case đổi → support stale, không tự copy.
- Duplicate không dựa title/CWE/severity: `duplicateOf` cần cùng `policyKey` + `rootCauseKey`, đích là finding accepted-current, chuỗi không chu trình;
  chưa chắc thì dùng `relatedCaseIds`. Duplicate không tăng số finding duy nhất.
- Supersede candidate ghi `support.invalidated` cùng transaction và liệt kê case bị ảnh hưởng; mode event-driven nhận hint sau commit.
- Remediation `implemented` ≠ fixed: `accepted` cần retest task đã review + evidence.

```json
{"action":"create","requestId":"owner-case-1","entry":{}}
{"action":"revise","id":"case-…","revision":1,"entry":{}}
{"action":"list","cursor":0,"limit":20,"status":"pending"}
{"action":"rate","id":"case-…","revision":2,"finding":{"severity":"medium","basis":"…","cvssVector":"CVSS:3.1/AV:N/…","cwe":["CWE-639"],"remediationSteps":"…","references":["wstg-athz-04"],"reproductionEvidenceRefs":["…"],"chain":{"objective":"…","demonstratedThrough":2,"steps":[{"order":1,"step":"…","claimRef":"cand-…","gained":[{"kind":"exec.code","subject":"fixture-rce"}]},{"order":2,"step":"…","claimRef":"cand-…","needs":[{"kind":"exec.code","subject":"fixture-rce"}],"effect":"code-execution","reach":{"AV":"N","AC":"L","AT":"N","PR":"L","UI":"N"}},{"order":3,"step":"…","needs":[{"kind":"file.write","subject":"/etc/cron.d"}]}]}}}
```

**`rate`** ghi một note riêng (`data.caseRating`) gắn revision case đã nêu — không đổi verdict/revision và không làm stale coverage.
`severity` ∈ critical/high/medium/low/informational (thang p2o, xem `skills/remediation/references/risk-rating-criteria.md`); `basis` bắt buộc;
`reproductionEvidenceRefs` (≤5 id receipt cùng run) vẫn hợp lệ; thay bằng `reproductionSteps` `[{ref, role, note?}]` (1–5 bước, `role` ∈ baseline/proof/verification/supporting, `note` ≤200 ký tự) để ghi thứ tự cần làm theo và nhãn cho người đọc — vai trò chỉ là nhãn, không phải mức proof; nếu truyền cả hai thì danh sách id phải khớp thứ tự các bước. Report đánh số bước khi có `reproductionSteps`, không thì giữ nguyên.
`cvssVector` tùy chọn, host tự tính điểm CVSS 3.1 (`src/cvss.ts`); CWE và references do owner ghi, host không tra MITRE. Case dựa policy `inferred`
không rate trên Medium. Case đổi revision thì rating cũ bị báo `STALE_RATING` ở báo cáo/preflight. Mọi mutation bind action + input + revision vào request HMAC.

**`chain`** (tùy chọn, trong cùng payload `finding`) ghi chuỗi khai thác đã dựng: `{objective, steps:[{order, step, claimRef?, gained?, needs?, effect?, reach?}], demonstratedThrough?}` — 1–8 bước, `order` phải đúng 1..n, `claimRef` trỏ candidate cùng run. Cạnh nối hai bước là capability có kiểu (`gained` của bước trước thoả `needs` của bước sau, xem `src/capabilities.ts`); văn xuôi cũ `provides`/`requires` vẫn đọc được nhưng chỉ hiện là `untyped text` và không bao giờ được nối hay tính điểm. Bước đã thực sự chạy (mọi bước ≤ `demonstratedThrough`) phải có `claimRef` với `closure=confirmed` và `execution=tested`; thiếu thì host từ chối rate.

**Severity tính từ thứ đã chứng minh, không phải thứ đã kể** (P14.9). Bước ở đúng `demonstratedThrough` phải khai `effect` (`confidentiality-read`, `integrity-write`, `availability-loss`, `authentication-bypass`, `code-execution`, `cross-tenant-read`, `sandbox-escape`); host map effect đó sang impact CVSS 4.0 (`VC/VI/VA/SC/SI/SA`) rồi tính điểm bằng thuật toán CVSS 4.0 thật (`src/cvss4.ts`). Exploitability lấy theo `reach` dễ nhất mà các bước đã chạy khai; bước không khai `reach` bị tính ở mức bất lợi nhất (`AV:P/AC:H/AT:P/PR:H/UI:A`), nên thiếu bằng chứng chỉ có thể hạ điểm. Kết quả nằm ở `chain.impact` (do host ghi, không nhận từ input) và có ba hệ quả: chuỗi chưa chạy bước nào, hoặc bước đã chạy không khai `effect`, thì **không được rate trên `informational`**; rate cao hơn mức đã chứng minh bị từ chối kèm vector + điểm; rate thấp hơn hoặc bằng thì được. Bước chưa chạy vẫn giữ nguyên là gap trong `limitations`. Report in chuỗi theo thứ tự kèm claim, `gained`/`needs`, `effect` từng bước, dòng `Demonstrated impact` và bước dừng; `findings.json` xuất cùng cấu trúc.

**Từ frontier ra task** (P14.10): `p2o_graph {"action":"chain","plan":true,"assetRefs":[{"id":"asset-…","revision":1}]}` trả về `draft` — đúng
object `p2o_task_create` cho bước sâu nhất đang sẵn sàng (role `exploit`, `work.purpose` `exploitation`, `work.claimRefs` = record id các
provider trên đường đi ngắn nhất + claim của chính bước đó, `work.needs` = capability đang tiêu thụ, `work.environmentRef` nếu provider sâu
nhất có ghi, kèm `decision` + `outputContract`) — và ghi cả chuỗi thành `p2o_plan_create` todo, mỗi bước một todo. Tool **không** tạo task, **không**
spawn worker: draft là đề xuất, todo là điều hướng, owner tự gọi `p2o_task_create`. Không truyền `assetRefs` thì draft bỏ `work` và `planNote`
nói rõ lý do, thay vì đoán asset từ chuỗi `surface`; frontier rỗng thì từ chối với `Nothing ready to plan`.

**Từ chuỗi ra bước tiếp theo** (P14.10): `p2o_graph {"action":"chain","plan":true,"assetRefs":[{"id":"asset-…","revision":1}]}` trả về
`draft` — đúng object `p2o_task_create` cho bước sâu nhất đã sẵn sàng (role `exploit`, `work.purpose` `exploitation`,
`work.claimRefs` = record id các provider trên đường đi ngắn nhất + claim của chính bước đó, `work.needs` = capability đang tiêu thụ,
`work.environmentRef` khi provider sâu nhất có environment) — và ghi cả chuỗi thành `p2o_plan_create` todo, mỗi bước một todo (replay cùng
`requestId` trả lại đúng các todo cũ). Không có gì được dispatch: draft chỉ là đề xuất, todo chỉ là điều hướng, và `p2o_task_create` vẫn
là một lời gọi riêng của owner. Không truyền `assetRefs` thì `draft` bỏ `work` (kèm `planNote` nói rõ lý do) chứ không đoán asset từ
chuỗi `surface`; frontier rỗng thì lời gọi bị từ chối với `Nothing ready to plan`.

**Tính độc lập của bước tái hiện** (P14.12): một receipt chỉ được coi là độc lập khi worker khác có *claim đã được chứng minh của chính nó*
trích receipt đó, cùng surface/risk. Nếu claim của tác giả có nêu artifact (`payloadRef`/`environmentRef`) thì claim của worker kia phải
chạy **cùng sha256 payload** và **cùng fingerprint recipe môi trường** — so sánh hai giá trị host đóng dấu lúc ghi (`payloadSha256`,
`environmentFingerprint`), không so sánh văn xuôi. Lệch hash payload → `independent-payload-mismatch:<a>!=<b>`; lệch fingerprint →
`independent-environment-mismatch:<a>!=<b>`; claim của tác giả chỉ nêu một nửa artifact → `independent-payload-missing`; worker kia chưa có
claim trích receipt → `independent-receipt-uncited:<evidence>`; claim mới nhất của worker kia không còn được chứng minh (rút lại) →
`independent-receipt-withdrawn:<evidence>`. Không nêu artifact nào thì không có gì để replay và độc lập vẫn là claim đã chứng minh của
worker kia. Case vẫn rate được khi thiếu bằng chứng độc lập, nhưng `independentCurrent` giữ `false` và reason nói rõ thiếu gì.

**Validation do host tạo** (W4): sau khi task discovery được review, host tạo đúng một task `role=validation` cho mỗi claim
`confirmed + tested`, với `validationOf`, prerequisite đã pin revision và `work.claimRefs` trỏ claim gốc; task đi qua
`TaskBoard`/Engine như mọi task khác và worker mới không thể trùng assignee. Task id là hash của run + discovery + claim slug,
nên candidate lặp lại không sinh task thứ hai và task validation không bao giờ tự validate tiếp. Case chỉ `independentCurrent`
khi task đó đã `reviewed/closed`, có receipt do chính assignee viết; nếu thiếu worker, executor hoặc recipe, task bị `blocked`
với prerequisite reason và `independenceReason`/report giữ `independent: none` thay vì waiver. Khi case trích trực tiếp cả
task discovery và task validation, validation đó vẫn được tính dù claim dẫn của lead bị host gắn nhầm `taskRef` vào task
validation: assignee phải khác assignee của discovery và receipt phải do chính assignee viết. Đường receipt độc lập cũ vẫn
được đọc để tương thích. Test: `tests/minimal/validation.test.ts`.

**`readyToRate`** (P8) là trường *dẫn xuất* trong `caseViews` và projection của `p2o_board board=cases`, không lưu xuống ledger và không phải quyền
mới: `currentness=current` + có receipt độc lập đang còn hiệu lực (`independentCurrent`) + độ sâu chuỗi đã nêu hoặc vắng mặt tường minh
(rating đã có `chain` mà các bước có `claimRef` nhưng thiếu `demonstratedThrough` thì coi là chưa nêu). Case `withdrawn` luôn `false`.
Đọc `false` kèm `staleReasons` để biết thiếu gì; rate sớm vẫn bị host từ chối ở các điều kiện cứng (evidence/claim/inferred-policy), và
`finishPreflight` giữ nguyên cổng cuối. Test: `tests/minimal/cases.test.ts` (dẫn xuất, mất hiệu lực khi support stale, withdrawn) và
projection trong `tests/minimal/case-rating.test.ts`.

## Coverage: mẫu số tường minh, hai trục tách biệt

```text
execution:  unplanned | planned | running | attempted | tested | blocked | not_applicable
assessment: unreviewed | confirmed_claim | ruled_out_bounded | open_gap | accepted | stale
```

Cell identity = target/source revision + asset@revision + question/policy key + actor/tenant + method family (không hash văn xuôi); đổi identity
thì retire cell cũ, thêm cell mới, plan revision ghi mẫu số +1/−1. Plan + cell commit **một transaction**. Coverage verbs: `p2o_coverage_plan` (create/revise), `p2o_coverage_cell` (add/revise), `p2o_coverage_cell_retire`; reads use `p2o_board board=coverage`, planning uses `p2o_coverage_suggest`.

- `tested` cần task đã review/đóng + evidence cùng run; `blocked` giữ `open_gap` + open record; `ruled_out_bounded` cần case ruled-out accepted + negative control;
- **Task kết thúc không có verdict** (`blocked`/`stopped`/`exhausted`, ghim đúng revision mà cell cite) không được đẩy cell qua `attempted`: lần ghi
  `tested` hoặc assessment thuộc `VERDICT_ASSESSMENTS` bị từ chối (`INTERRUPT_NOT_EVIDENCE: task <id> ended as <state> without a verdict; cell
  <questionKey> stays attempted, not tested`), còn cell đã lỡ lưu verdict đó được đọc lại là `attempted` + `open_gap`, `stale` với lý do
  `interrupted-task:<id>:<state>`, không `reviewed`. Nó quay lại backlog và `finishPreflight` nêu dưới mã `INTERRUPTED_CELL` (trước `STALE_CELL`,
  vì cách sửa là dispatch lại chứ không phải ghim lại evidence). Revision sau có satisfied cũng không xoá dấu, vì cell ghim revision đã dùng.
  `accepted` cần case accepted-current. Candidate/case/task bị supersede, asset đổi hoặc thiếu evidence → `stale` (chỉ hạ, không tự nâng).
- Asset khám phá ngoài mẫu số và `unknownScope` hiện riêng. 100% cell không có nghĩa an toàn; blocked/untested/not-applicable không phải clean.

## Xem và giới hạn

```text
/p2o heads case [cursor]   /p2o heads coverage-cell [cursor]   /p2o show <domain> <id>   /p2o report
```

Chỉ đọc snapshot canonical, không gọi model/target. Báo cáo tách candidate submission / case duy nhất / duplicate / pending / stale và coverage currentness.

100 case live (không rút lịch sử); 10 mục mỗi danh sách ref; 20 affected variant; 10 plan live; 100 cell/plan; list 20 (≤100, ≤24 KiB);
hàng ≤16 KiB, packet ≤128 hàng; owner knowledge 400 dùng chung với graph/plan. Không TTL, không retry.

Test: unit/runtime/actual-Pi inert. Còn mở: chính sách affected-variant rộng hơn, projection large-history (K6), audit K7. Không chứng minh finding đúng hay hơn ARTEX.
