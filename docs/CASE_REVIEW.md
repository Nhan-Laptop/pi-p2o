# Canonical case review và proof-aware coverage (K5)

Xây trên candidate/evidence/TaskBoard/graph hiện có; không có finding store, queue hay goal-completion engine thứ hai.
Bản chi tiết cũ: `git show 656843d:docs/CASE_REVIEW.md`.

## Ba mức: claim → case → finding

1. `p2o_candidate`: **claim có gán tác giả** của worker — worker thi hành là tác giả claim duy nhất, planner không có claim tool; `p2o_candidate` là **worker-only** (`WORKER_ONLY` kèm `legalNext` tạo/dispatch intent rồi review claim), host đóng dấu `data.taskRef` của assignment lên claim để validation neo đúng task discovery; `confirmed` chỉ là "claimed confirmed — pending review".
2. `p2o_case_create` / `p2o_case_revise` (planner): revision pin chính xác candidate record, asset/task/hypothesis revision, evidence/report, contradiction, limitation.
3. Chỉ case `accepted` + `confirmed` + canonical (không `duplicateOf`) + `currentness=current` mới đếm là **unique accepted-current finding**
   — vẫn không có nghĩa assessment xong hay target an toàn.

Worker và reporter không có case/plan/coverage verb; reporter là người đọc thứ hai chỉ đọc. Dữ liệu import/checkpoint chỉ là tri thức.

## Quy tắc review

- Create luôn `pending`; `accepted|disputed|withdrawn` cần revision mới với `revision` kỳ vọng; không accept khi còn contradiction `open`.
- `confirmed` cần claim đã tested có policy basis không phải `inferred`; `ruled_out` cần claim ruled-out hiện tại + control cụ thể.
- Huy hiệu độc lập cần receipt của Worker khác; validator rút lại thì case/report stale. Asset/task/claim/case đổi → support stale, không tự copy.
- Duplicate không dựa title/CWE/severity: `duplicateOf` cần cùng `policyKey` + `rootCauseKey`, đích là finding accepted-current, chuỗi không chu trình;
  chưa chắc thì dùng `relatedCaseIds`. Duplicate không tăng số finding duy nhất.
- Supersede candidate ghi `support.invalidated` cùng transaction và liệt kê case bị ảnh hưởng; mode event-driven nhận hint sau commit.
- Remediation `implemented` ≠ fixed: `accepted` cần retest task đã review + evidence.

```json
{"action":"create","requestId":"planner-case-1","entry":{}}
{"action":"revise","id":"case-…","revision":1,"entry":{}}
{"action":"list","cursor":0,"limit":20,"status":"pending"}
{"action":"rate","id":"case-…","revision":2,"finding":{"severity":"medium","basis":"…","cvssVector":"CVSS:3.1/AV:N/…","cwe":["CWE-639"],"remediationSteps":"…","references":["wstg-athz-04"],"reproductionEvidenceRefs":["…"],"chain":{"objective":"…","demonstratedThrough":2,"steps":[{"order":1,"step":"…","claimRef":"cand-…","gained":[{"kind":"exec.code","subject":"fixture-rce"}]},{"order":2,"step":"…","claimRef":"cand-…","needs":[{"kind":"exec.code","subject":"fixture-rce"}],"effect":"code-execution","reach":{"AV":"N","AC":"L","AT":"N","PR":"L","UI":"N"}},{"order":3,"step":"…","needs":[{"kind":"file.write","subject":"/etc/cron.d"}]}]}}}
```

**`rate`** ghi một note riêng (`data.caseRating`) gắn revision case đã nêu — không đổi verdict/revision và không làm stale coverage.
`severity` ∈ critical/high/medium/low/informational (thang p2o, xem `skills/remediation/references/risk-rating-criteria.md`); `basis` bắt buộc;
`reproductionEvidenceRefs` (≤5 id receipt cùng run) vẫn hợp lệ; thay bằng `reproductionSteps` `[{ref, role, note?}]` (1–5 bước, `role` ∈ baseline/proof/verification/supporting, `note` ≤200 ký tự) để ghi thứ tự cần làm theo và nhãn cho người đọc — vai trò chỉ là nhãn, không phải mức proof; nếu truyền cả hai thì danh sách id phải khớp thứ tự các bước. Report đánh số bước khi có `reproductionSteps`, không thì giữ nguyên.
`cvssVector` tùy chọn, host tự tính điểm CVSS 3.1 (`src/cvss.ts`); CWE và references do planner ghi, host không tra MITRE. Case dựa policy `inferred`
không rate trên Medium. Case đổi revision thì rating cũ bị báo `STALE_RATING` ở báo cáo/preflight. Mọi mutation bind action + input + revision vào request HMAC.

**`chain`** (tùy chọn, trong cùng payload `finding`) ghi chuỗi khai thác đã dựng: `{objective, steps:[{order, step, claimRef?, gained?, needs?, effect?, reach?}], demonstratedThrough?}` — 1–8 bước, `order` phải đúng 1..n, `claimRef` trỏ candidate cùng run. Cạnh nối hai bước là capability có kiểu (`gained` của bước trước thoả `needs` của bước sau, xem `src/capabilities.ts`); văn xuôi cũ `provides`/`requires` vẫn đọc được nhưng chỉ hiện là `untyped text` và không bao giờ được nối hay tính điểm. Bước đã thực sự chạy (mọi bước ≤ `demonstratedThrough`) phải có `claimRef` với `closure=confirmed` và `execution=tested`; thiếu thì host từ chối rate.

**Severity tính từ thứ đã chứng minh, không phải thứ đã kể** (P14.9). Bước ở đúng `demonstratedThrough` phải khai `effect` (`confidentiality-read`, `integrity-write`, `availability-loss`, `authentication-bypass`, `code-execution`, `cross-tenant-read`, `sandbox-escape`); host map effect đó sang impact CVSS 4.0 (`VC/VI/VA/SC/SI/SA`) rồi tính điểm bằng thuật toán CVSS 4.0 thật (`src/cvss4.ts`). Exploitability lấy theo `reach` dễ nhất mà các bước đã chạy khai; bước không khai `reach` bị tính ở mức bất lợi nhất (`AV:P/AC:H/AT:P/PR:H/UI:A`), nên thiếu bằng chứng chỉ có thể hạ điểm. Kết quả nằm ở `chain.impact` (do host ghi, không nhận từ input) và có ba hệ quả: chuỗi chưa chạy bước nào, hoặc bước đã chạy không khai `effect`, thì **không được rate trên `informational`**; rate cao hơn mức đã chứng minh bị từ chối kèm vector + điểm; rate thấp hơn hoặc bằng thì được. Bước chưa chạy vẫn giữ nguyên là gap trong `limitations`. Report in chuỗi theo thứ tự kèm claim, `gained`/`needs`, `effect` từng bước, dòng `Demonstrated impact` và bước dừng; `findings.json` xuất cùng cấu trúc.

**Từ frontier ra task** (P14.10): `p2o_graph {"action":"chain","plan":true,"assetRefs":[{"id":"asset-…","revision":1}]}` trả về `draft` — đúng
object `p2o_task_create` cho bước sâu nhất đang sẵn sàng (role `exploit`, `work.purpose` `exploitation`, `work.claimRefs` = record id các
provider trên đường đi ngắn nhất + claim của chính bước đó, `work.needs` = capability đang tiêu thụ, `work.environmentRef` nếu provider sâu
nhất có ghi, kèm `decision` + `outputContract`) — và ghi cả chuỗi thành `p2o_plan_create` todo, mỗi bước một todo. Tool **không** tạo task, **không**
spawn worker: draft là đề xuất, todo là điều hướng, planner tự gọi `p2o_task_create`. Không truyền `assetRefs` thì draft bỏ `work` và `planNote`
nói rõ lý do, thay vì đoán asset từ chuỗi `surface`; frontier rỗng thì từ chối với `Nothing ready to plan`.

**Từ chuỗi ra bước tiếp theo** (P14.10): `p2o_graph {"action":"chain","plan":true,"assetRefs":[{"id":"asset-…","revision":1}]}` trả về
`draft` — đúng object `p2o_task_create` cho bước sâu nhất đã sẵn sàng (role `exploit`, `work.purpose` `exploitation`,
`work.claimRefs` = record id các provider trên đường đi ngắn nhất + claim của chính bước đó, `work.needs` = capability đang tiêu thụ,
`work.environmentRef` khi provider sâu nhất có environment) — và ghi cả chuỗi thành `p2o_plan_create` todo, mỗi bước một todo (replay cùng
`requestId` trả lại đúng các todo cũ). Không có gì được dispatch: draft chỉ là đề xuất, todo chỉ là điều hướng, và `p2o_task_create` vẫn
là một lời gọi riêng của planner. Không truyền `assetRefs` thì `draft` bỏ `work` (kèm `planNote` nói rõ lý do) chứ không đoán asset từ
chuỗi `surface`; frontier rỗng thì lời gọi bị từ chối với `Nothing ready to plan`.

**Tính độc lập của bước tái hiện** (P14.12): một receipt chỉ được coi là độc lập khi worker khác có *claim đã được chứng minh của chính nó*
trích receipt đó, cùng surface/risk. Nếu claim của tác giả có nêu artifact (`payloadRef`/`environmentRef`) thì claim của worker kia phải
chạy **cùng sha256 payload** và **cùng fingerprint recipe môi trường** — so sánh hai giá trị host đóng dấu lúc ghi (`payloadSha256`,
`environmentFingerprint`), không so sánh văn xuôi. Lệch hash payload → `independent-payload-mismatch:<a>!=<b>`; lệch fingerprint →
`independent-environment-mismatch:<a>!=<b>`; claim của tác giả chỉ nêu một nửa artifact → `independent-payload-missing`; worker kia chưa có
claim trích receipt → `independent-receipt-uncited:<evidence>`; claim mới nhất của worker kia không còn được chứng minh (rút lại) →
`independent-receipt-withdrawn:<evidence>`. Không nêu artifact nào thì không có gì để replay và độc lập vẫn là claim đã chứng minh của
worker kia. Case vẫn rate được khi thiếu bằng chứng độc lập, nhưng `independentCurrent` giữ `false` và reason nói rõ thiếu gì.

**Message khi accept case chưa current** (P5.1/P3): `p2o_case_revise` sang `accepted` mà view chưa current vẫn bị từ chối
nguyên độ chặt, nhưng message được bound và actionable: `Case review is stale/incomplete: <tối đa 3 reason> (+N more).` kèm
hint. Nếu có reason `independent-*`/`validation-*`, hint nêu đúng hai đường hợp lệ (claim peer đã review có
`data.independentEvidenceRef` trỏ evidence id, hoặc validation task đã review mà case cite qua `taskRefs`); còn lại là "fix the
listed reasons and revise again". Một receipt **không claim peer nào trích** (kể cả claim chưa current) mang nhãn
`independent-support-uncited:<evidence>` — thiếu bước citation, không phải receipt stale; nếu có claim trích nhưng không còn
current thì reason vẫn là `independent-receipt-*` cụ thể từ `independentReceiptCurrent`.

**Validation do host tạo** (W4): sau khi task discovery được review, host tạo đúng một task `role=validation` cho mỗi claim
`confirmed + tested`, với `validationOf`, prerequisite đã pin revision và `work.claimRefs` trỏ claim gốc; task đi qua
`TaskBoard`/Engine như mọi task khác và worker mới không thể trùng assignee. Validation viết tay vào cùng đường admission đó:
`validationOf` nhận task id đã review **hoặc** claim id của worker — host tự resolve claim qua `data.taskRef` sang task
discovery, pin đúng revision đã review làm prerequisite, ghi lại `validationOf` + `decision.relatedTaskId` và suy ra
`decision.disposition=validate`. Claim không do worker viết bị `OWNER_CLAIM_NOT_ANCHORABLE`, claim thiếu `data.taskRef` bị
`CLAIM_WITHOUT_TASK`, task/claim chưa review bị `UNREVIEWED_PREDECESSOR`, và một validation không bao giờ được validate lại
(`NO_REVALIDATION`) — mỗi claim đã confirm chỉ một validation. Task id là hash của run + discovery + claim slug,
nên candidate lặp lại không sinh task thứ hai và task validation không bao giờ tự validate tiếp. Case chỉ `independentCurrent`
khi task đó đã `reviewed/closed`, có receipt do chính assignee viết; nếu thiếu worker, executor hoặc recipe, task bị `blocked`
với prerequisite reason (ghi trong `missingPrerequisites`) và `independenceReason`/report giữ `independent: none` thay vì waiver. Khi case trích trực tiếp cả
task discovery và task validation, validation đó vẫn được tính dù claim dẫn bị host gắn nhầm `taskRef` vào task
validation: assignee phải khác assignee của discovery và receipt phải do chính assignee viết. Đường receipt độc lập cũ vẫn
được đọc để tương thích. Test: `tests/minimal/validation.test.ts`.

**`readyToRate`** (P8) là trường *dẫn xuất* trong `caseViews` và projection của `p2o_board board=cases`, không lưu xuống ledger và không phải quyền
mới: `currentness=current` + có receipt độc lập đang còn hiệu lực (`independentCurrent`) + độ sâu chuỗi đã nêu hoặc vắng mặt tường minh
(rating đã có `chain` mà các bước có `claimRef` nhưng thiếu `demonstratedThrough` thì coi là chưa nêu). Case `withdrawn` luôn `false`.
Đọc `false` kèm `staleReasons` để biết thiếu gì; rate sớm vẫn bị host từ chối ở các điều kiện cứng (evidence/claim/inferred-policy), và
`finishPreflight` giữ nguyên cổng cuối. Test: `tests/minimal/cases.test.ts` (dẫn xuất, mất hiệu lực khi support stale, withdrawn) và
projection trong `tests/minimal/case-rating.test.ts`.

## Coverage: host chiếu từ công việc đã review, hai trục tách biệt

```text
execution:  unplanned | planned | running | attempted | tested | blocked | not_applicable
assessment: unreviewed | confirmed_claim | ruled_out_bounded | open_gap | accepted | stale
```

Từ A3 (P2), coverage là **projection của công việc đã review**, không phải bảng do model viết. Host đọc task head, claim worker của
task đó (`data.taskRef`), case accepted cùng run và revision asset trong graph, rồi dựng một cell cho mỗi `work.assetRefs` — mọi lần
đọc đều chiếu lại, không ghi ledger. Model chỉ ghi **scope** của plan qua `p2o_coverage_plan` (create/revise: `title`, `status`,
`reason`, `exclusions`, `unknownScope`); không có verb tạo/sửa/retire cell và plan+cell không còn là một transaction. Plan tạo sau A3
mang marker host-owned `derivation:'projected'` (revise giữ marker); `p2o_board board=coverage` và báo cáo đọc cell dẫn xuất kèm count
dẫn xuất và danh sách `unmapped`, còn list coverage trả `derivation` là `projected` (plan sau A3) hay `legacy` (plan cũ).

Cell identity = target revision + asset@revision + question/policy key + actor/tenant + method family (không hash văn xuôi). Id dẫn
xuất tất định `coverage-cell-<24hex>` (recordId `derived-<32hex>`, revision 1, retired false) từ fingerprint đó. Mỗi plan projected
chia cùng một bộ cell dẫn xuất của run; cell pin `targetRevision` của plan và `work.assetRefs` pin revision asset, nên target/asset đổi
là cell stale. Khi nhiều task trùng fingerprint, task satisfied thắng task chưa satisfied, rồi revision lớn hơn, rồi record mới hơn —
revision cũ không thành dòng mẫu số thứ hai. Cell dẫn xuất chỉ dùng `planned`/`blocked`/`tested`; các execution khác trong bảng trên
là giá trị đến từ cell lưu legacy (và `attempted` là kết quả downgrade M5).

| Trạng thái task head (có `work.assetRefs`) | execution | assessment |
|---|---|---|
| `proposed` / `reserved` / `running` / `reported` | `planned` | `unreviewed` |
| `blocked` / `cancelled` / `expired` (kết thúc, không verdict) | `blocked` | `open_gap` |
| satisfied (reviewed/closed) + evidence + case accepted-current trích dẫn nó | `tested` | `accepted` |
| satisfied + evidence + claim `confirmed` | `tested` | `confirmed_claim` |
| satisfied + evidence + claim `ruled_out` có negative control | `tested` | `ruled_out_bounded` |
| satisfied + evidence + claim còn mở (kể cả ruled-out thiếu control) | `tested` | `open_gap` |
| satisfied + evidence nhưng không claim/case verdict | `planned` | `unreviewed` |

Claim chỉ được tính khi task đã satisfied và claim được ghi **trước** head record mà review đã accept, nên claim revision sau supersede
claim đã pin (`superseded-claim`). Precedence: accepted > confirmed_claim > ruled_out_bounded > open_gap. Mọi cờ currentness —
`superseded-claim`, `stale-case`, `stale-asset`, `superseded-task`, `stale-target` — chỉ **hạ** cell xuống `stale`/effective assessment
tương ứng, không tự nâng.

- `tested` cần task đã review/closed + evidence cùng run; `blocked` giữ `open_gap` + open record; `ruled_out_bounded` cần claim ruled-out
  có negative control thật; `accepted` cần case accepted-current.
- **Unmapped không phải cell.** Task không có `work.assetRefs` (prose legacy hoặc task lưu thiếu work identity) vào
  `CoveragePlanView.unmapped` dạng `{taskId, revision, question, role, status, reason}`, hiện trên board coverage
  (`unmapped`/`unmappedCount`), trong báo cáo (`unmappedTasks` từng plan, `unmappedCoverageTasks` trong counts) và là advisory
  `UNMAPPED_TASK` của finish preflight — không bao giờ thành cell sạch. Asset có trong graph mà chưa có cell dẫn xuất vẫn chỉ là
  `discoveredUnplannedAssets` (đếm, không tự đặt question/method). `unknownScope` hiện riêng.
- **Plan legacy**: plan lưu trước A3 không có `derivation:'projected'` nên vẫn được đọc đúng các cell đã lưu (`cellIds`), read-only,
  không rewrite; currentness và M5 interrupted-verdict downgrade áp cho chúng như trước. Plan projected không có `cellIds` và
  `omittedCells` của nó luôn 0.
- **Task kết thúc không verdict** (`blocked`/`stopped`/`exhausted`, đúng revision cell cite) không bao giờ thành `tested`: cell dẫn xuất
  của task đó đứng ở `blocked/open_gap`; cell legacy đã lỡ lưu verdict được đọc lại thành `attempted` + `open_gap`, `stale` với lý do
  `interrupted-task:<id>:<state>`, không `reviewed`, và `finishPreflight` nêu `INTERRUPTED_CELL` (trước `STALE_CELL`, vì cách sửa là
  dispatch lại chứ không phải ghim lại evidence). Revision sau có satisfied cũng không xoá dấu, vì cell ghim revision đã dùng.
- Plan chỉ review/close được khi có **ít nhất một cell dẫn xuất**; run chưa có task nào khai asset thì plan không review được và view
  cảnh báo `no denominator work: ... not clean`. 100% cell không có nghĩa an toàn; blocked/untested/stale/not-applicable/unmapped
  không phải clean.

## Xem và giới hạn

```text
/p2o heads case [cursor]   /p2o heads coverage-cell [cursor]   /p2o show <domain> <id>   /p2o report
```

Chỉ đọc snapshot canonical, không gọi model/target. Báo cáo tách candidate submission / case duy nhất / duplicate / pending / stale và coverage currentness; coverage trong báo cáo là projection từ công việc đã review — báo cáo tự nói "no planner-authored cell exists". `/p2o heads coverage-cell` chỉ còn cell lưu legacy; cell dẫn xuất đọc qua `p2o_board board=coverage` và report.

100 case live (không rút lịch sử); 10 mục mỗi danh sách ref; 20 affected variant; 10 plan live; 100 cell/plan (giới hạn của plan legacy
lưu cell; cell dẫn xuất không lưu); list 20 (≤100, ≤24 KiB); hàng ≤16 KiB, packet ≤128 hàng; planner knowledge 400 dùng chung với
graph/plan. Không TTL, không retry.

Test: unit/runtime/actual-Pi inert, gồm `tests/minimal/projection.test.ts` (A3: chiếu coverage, unmapped, stale theo revision). Còn mở:
chính sách affected-variant rộng hơn, projection large-history (K6), audit K7. Không chứng minh finding đúng hay hơn ARTEX.
