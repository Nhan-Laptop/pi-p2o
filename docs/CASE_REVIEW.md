# Canonical case review và proof-aware coverage (K5)

Xây trên candidate/evidence/TaskBoard/graph hiện có; không có finding store, queue hay goal-completion engine thứ hai.
Bản chi tiết cũ: `git show 656843d:docs/CASE_REVIEW.md`.

## Ba mức: claim → case → finding

1. `p2o_candidate`: **claim có gán tác giả** của owner/Worker; `confirmed` chỉ là "claimed confirmed — pending review".
2. `p2o_case` (owner): revision pin chính xác candidate record, asset/task/hypothesis revision, evidence/report, contradiction, limitation.
3. Chỉ case `accepted` + `confirmed` + canonical (không `duplicateOf`) + `currentness=current` mới đếm là **unique accepted-current finding**
   — vẫn không có nghĩa assessment xong hay target an toàn.

Worker/reporting không có `p2o_case`/`p2o_coverage`. Dữ liệu import/checkpoint chỉ là tri thức.

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
{"action":"rate","id":"case-…","revision":2,"finding":{"severity":"medium","basis":"…","cvssVector":"CVSS:3.1/AV:N/…","cwe":["CWE-639"],"remediationSteps":"…","references":["wstg-athz-04"],"reproductionEvidenceRefs":["…"]}}
```

**`rate`** ghi một note riêng (`data.caseRating`) gắn revision case đã nêu — không đổi verdict/revision và không làm stale coverage.
`severity` ∈ critical/high/medium/low/informational (thang p2o, xem `skills/remediation/references/risk-rating-criteria.md`); `basis` bắt buộc;
`cvssVector` tùy chọn, host tự tính điểm CVSS 3.1 (`src/cvss.ts`); CWE và references do owner ghi, host không tra MITRE. Case dựa policy `inferred`
không rate trên Medium. Case đổi revision thì rating cũ bị báo `STALE_RATING` ở báo cáo/preflight. Mọi mutation bind action + input + revision vào request HMAC.

## Coverage: mẫu số tường minh, hai trục tách biệt

```text
execution:  unplanned | planned | running | attempted | tested | blocked | not_applicable
assessment: unreviewed | confirmed_claim | ruled_out_bounded | open_gap | accepted | stale
```

Cell identity = target/source revision + asset@revision + question/policy key + actor/tenant + method family (không hash văn xuôi); đổi identity
thì retire cell cũ, thêm cell mới, plan revision ghi mẫu số +1/−1. Plan + cell commit **một transaction**. Actions của `p2o_coverage`:
`plan-create|plan-revise|cell-create|cell-revise|cell-retire|list|view`.

- `tested` cần task đã review/đóng + evidence cùng run; `blocked` giữ `open_gap` + open record; `ruled_out_bounded` cần case ruled-out accepted + negative control;
  `accepted` cần case accepted-current. Candidate/case/task bị supersede, asset đổi hoặc thiếu evidence → `stale` (chỉ hạ, không tự nâng).
- Asset khám phá ngoài mẫu số và `unknownScope` hiện riêng. 100% cell không có nghĩa an toàn; blocked/untested/not-applicable không phải clean.

## Xem và giới hạn

```text
/p2o findings [cursor]   /p2o finding <case-id>   /p2o coverage [cursor]   /p2o coverage-cell <id>   /p2o report
```

Chỉ đọc snapshot canonical, không gọi model/target. Báo cáo tách candidate submission / case duy nhất / duplicate / pending / stale và coverage currentness.

100 case live (không rút lịch sử); 10 mục mỗi danh sách ref; 20 affected variant; 10 plan live; 100 cell/plan; list 20 (≤100, ≤24 KiB);
hàng ≤16 KiB, packet ≤128 hàng; owner knowledge 400 dùng chung với graph/plan. Không TTL, không retry.

Test: unit/runtime/actual-Pi inert. Còn mở: chính sách affected-variant rộng hơn, projection large-history (K6), audit K7. Không chứng minh finding đúng hay hơn ARTEX.
