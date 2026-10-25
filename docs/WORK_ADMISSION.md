# Work admission, kế hoạch và phase packet (K4)

Dùng TaskBoard/Engine/candidate gates sẵn có; không có task store hay Planner thứ hai, không retry target, không tự cấp lại
ngân sách. "Goal" ở đây là record mục tiêu của assessment. Bản chi tiết cũ: `git show 656843d:docs/WORK_ADMISSION.md`.

## Công nghệ cốt lõi

- Task vẫn là revision do owner viết; `work_history` và `work_reservations` chỉ là index/constraint trong **cùng transaction**
  SQLite, không phải hàng đợi có quyền thực thi. các task/plan verb chỉ dành cho owner; Worker/reporting không sửa kế hoạch.
- **Work identity có cấu trúc**, không hash văn xuôi: `draft.work` gồm `assetRefs` (entity ID graph cùng run), `questionKey`,
  `policyKey?`, `actorContext`/`tenantContext` (handle mờ, không secret), `methodFamily`, `purpose`
  (`mapping|discovery|investigation|refinement|validation|retest|exploitation|chaining|reporting`), và từ P14.10 thêm `needs`
  (capability có kiểu mà bước này tiêu thụ — copy từ `p2o_graph` chain, không phải quyền) cùng `environmentRef` (environment P14.3
  mà bước phải chạy trong đó). Fingerprint = run + target revision + asset/variant đã sort + keys + context + method + prerequisite
  pins + purpose + `needs`/`environmentRef`. Đổi câu chữ không đổi identity; thiếu metadata → `dedupConfidence:unknown`.
- **Không còn ngân sách lệnh** (quyết định owner 2026-10-24): trường `work.budget`, mức 200/400 theo purpose, nghĩa vụ `wrapUp` và
  các chia read/coordination của broker đã bị xóa. Broker vẫn **đếm** mỗi lệnh target cho ledger và report nhưng không từ chối lệnh nào;
  một vòng build/run/crash/adjust của exploitation không bị cắt giữa chừng. Ticket cũ còn `commandBudget` vẫn đọc được (trường bị bỏ
  qua), nên `p2o open <runId>` của run cũ không hỏng.
- **Từ frontier ra task, không tự dispatch**: `p2o_graph {"action":"chain","plan":true,"assetRefs":[…]}` trả về đúng object
  `p2o_task_create` cho bước sâu nhất đã sẵn sàng (purpose `exploitation`, `claimRefs` = record id của các provider trên đường đi ngắn
  nhất + claim của chính bước đó, `needs` = capability đang tiêu thụ, `environmentRef` = environment của provider sâu nhất có ghi) và ghi
  toàn bộ chuỗi thành `p2o_plan_create` todo, mỗi bước một todo. Không có task nào được tạo, không có gì được chạy: draft là đề xuất, todo là
  điều hướng; owner tự gọi `p2o_task_create`. Không truyền `assetRefs` thì draft bỏ `work` và nói rõ lý do thay vì đoán asset từ chuỗi
  `surface`.
- **Reserve nguyên tử**: task revision + event + history + fingerprint duy nhất commit chung; hai đề xuất đua nhau thì cái sớm hơn
  thắng, conflict rollback cả packet. Pin được kiểm tra lại trước mỗi lệnh; sau crash reservation không tự kích hoạt lại.

## Dùng

`p2o_board {"board":"tasks","match":…}` tra cả task đang chạy và lịch sử có index (không phải đuôi hiển thị) trước khi giao việc:

| Kết quả | Ý nghĩa |
|---|---|
| `already_covered_by` | task active trùng đúng identity — trả điều hướng, không tạo task mới |
| `reuse_candidates` | kết quả đã review/đóng có refs và limitations; không chứng minh goal hay finding |
| `partial` | lần trước bị blocked/cancelled/expired — xem gaps, không tự replay |
| `overlaps` | cùng asset/question/policy nhưng khác method/actor/pin — chỉ là cảnh báo |

Task có `work` bắt buộc `decision` (`new|refine|validate|retest|retry`, kèm lý do/prior ID tương ứng) và `outputContract`
(`kind`, `required` ⊂ assets/facts/evidence/controls/gaps/candidates/artifacts/coverage, `partialAllowed`, `artifactPolicy`);
đây là yêu cầu giao nhận, không phải oracle. `p2o_delegate` nhận cùng `work/decision/outputContract`; thiếu `work` thì kết quả
`workMatch:"unknown"` và dùng lại guard surface/risk cũ.

**Goal / todo / decision** qua `p2o_plan_create` (không có `id`), `p2o_plan_revise` (`id` + `revision`) hoặc `p2o_board board=plans` (list/view): `entry:{kind, title, status, reason, criteria, exclusions, taskIds}`; goal đóng cần revision tường minh và evidence cùng run; todo không được tạo chu trình; decision
(`new|reuse|refine|validate|retest|defer`) chỉ ghi lại, không tự dispatch. Cùng `requestId` + payload trả ACK gốc, khác payload → `IDEMPOTENCY_CONFLICT`.

**Phase card**: handoff nguyên tử thêm một note `data.phase` (task revision, worker/report, số output, contract, field chưa review) và
task giữ `phasePacketId`. Worker kết thúc không report hoặc provider lỗi vẫn có card từ báo cáo fallback; không thêm model turn.
Card `pending` là lịch sử tại thời điểm giao; trạng thái task hiện tại hiển thị riêng.

```text
/p2o heads goal [cursor]   /p2o heads todo [cursor]   /p2o heads decision [cursor]   /p2o heads phase [cursor]   /p2o heads task [cursor]
/p2o show <domain> <id>
```

Đọc không gọi model/target. Sau finish dùng `/p2o open <run-id>` để xem dữ liệu bền.

## Giới hạn chính

Asset ref ≤10, prerequisite ≤10; key ≤160 ký tự; output field ≤8; decision reason 10–1000 ký tự; work history 20 (≤100) head;
Không còn trần 100 task/goal live; plan list 20 (≤100, ≤24 KiB); knowledge owner 400; hàng ≤16 KiB, packet ≤128 hàng.
Không có TTL hay timeout mặc định.

Test: `work.test.ts`, `planning.test.ts`, `workspace-runtime.test.ts`, `work-native.test.ts` (provider inert). Còn thiếu: gợi ý alias/fuzzy,
typed branch-output review, biến thể crash/interruption. Mechanics pass không chứng minh finding đúng hay tiết kiệm chi phí.

## Frontier obligation lúc create (M2 + M4)

`p2o_task_create` từ chối một draft mở hướng mới trên surface đang có bước chain ready
(`CHAIN_READY_UNDISPATCHED`) hoặc đang có claim confirmed+tested chưa được consume (`PRIMITIVE_UNCHAINED`). Hai đường thoát,
đều là dữ liệu chứ không phải lời hứa: cite claim trong `work.claimRefs`, hoặc ghi một todo `deferred`/`blocked` nêu claim
đó kèm lý do. Breadth ở surface khác vẫn được nhận; task `cancelled`/`expired`/`closed` không được tính là đã consume.

## Admission refusal được ghi lại (M6)

Một `create` bị từ chối vì obligation không biến mất khỏi transcript: tool ghi một lifecycle note
`admission refused: <CODE>: …` rồi mới ném lỗi. Preflight đếm các note đó thành advisory `ADMISSION_REFUSALS`, nên
"thuế admission" hiện ra trong báo cáo thay vì chỉ nằm trong hội thoại. Con số này là quan sát, không phải hạn mức.

`work.purpose` được điền từ role khi draft bỏ trống (`purposeFromRole`), nên lead không phải nhớ một trường chỉ để qua
validate; `match` chạy trước `create` nên cả hai đường đều canonicalize trước khi kiểm.

## Continuation (M8)

Một worker còn sống được nối **bao nhiêu lần cũng được** trên cùng ticket; cái chặn là ticket, không phải số lần.
`WORKER_CLOSED` khi worker đã report, đã stop hoặc pane đã đóng — lúc đó hội thoại không còn để nối, và câu trả lời là một
task mới. Không có bộ đếm nào bị trừ và không có lệnh nào bị chặn vì số lần nối.
