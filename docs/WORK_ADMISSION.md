# Work admission, kế hoạch và phase packet (K4)

Dùng TaskBoard/Engine/candidate gates sẵn có; không có task store hay Planner thứ hai, không retry target, không tự cấp lại
ngân sách. "Goal" ở đây là record mục tiêu của assessment. Bản chi tiết cũ: `git show 656843d:docs/WORK_ADMISSION.md`.

## Công nghệ cốt lõi

- Task vẫn là revision do owner viết; `work_history` và `work_reservations` chỉ là index/constraint trong **cùng transaction**
  SQLite, không phải hàng đợi có quyền thực thi. `p2o_task`/`p2o_plan` chỉ dành cho owner; Worker/reporting không sửa kế hoạch.
- **Work identity có cấu trúc**, không hash văn xuôi: `draft.work` gồm `assetRefs` (entity ID graph cùng run), `questionKey`,
  `policyKey?`, `actorContext`/`tenantContext` (handle mờ, không secret), `methodFamily`, `purpose`
  (`mapping|discovery|investigation|refinement|validation|retest|reporting`). Fingerprint = run + target revision + asset/variant
  đã sort + keys + context + method + prerequisite pins + purpose. Đổi câu chữ không đổi identity; thiếu metadata → `dedupConfidence:unknown`.
- **Reserve nguyên tử**: task revision + event + history + fingerprint duy nhất commit chung; hai đề xuất đua nhau thì cái sớm hơn
  thắng, conflict rollback cả packet. Pin được kiểm tra lại trước mỗi lệnh; sau crash reservation không tự kích hoạt lại.

## Dùng

`p2o_task {"action":"match","draft":…}` tra cả task đang chạy và lịch sử có index (không phải đuôi hiển thị) trước khi giao việc:

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

**Goal / todo / decision** qua `p2o_plan {action: create|revise|list|view, requestId, entry:{kind, title, status, reason, criteria, exclusions, taskIds}}`:
`revise` cần `id` + `revision`; goal đóng cần revision tường minh và evidence cùng run; todo không được tạo chu trình; decision
(`new|reuse|refine|validate|retest|defer`) chỉ ghi lại, không tự dispatch. Cùng `requestId` + payload trả ACK gốc, khác payload → `IDEMPOTENCY_CONFLICT`.

**Phase card**: handoff nguyên tử thêm một note `data.phase` (task revision, worker/report, số output, contract, field chưa review) và
task giữ `phasePacketId`. Worker kết thúc không report hoặc provider lỗi vẫn có card từ báo cáo fallback; không thêm model turn.
Card `pending` là lịch sử tại thời điểm giao; trạng thái task hiện tại hiển thị riêng.

```text
/p2o plans [cursor]   /p2o plan <id>   /p2o phases [cursor]   /p2o phase <id>   /p2o task <id>
```

Đọc không gọi model/target. Sau finish dùng `/p2o open <run-id>` để xem dữ liệu bền.

## Giới hạn chính

Asset ref ≤10, prerequisite ≤10; key ≤160 ký tự; output field ≤8; decision reason 10–1000 ký tự; work history 20 (≤100) head;
100 task live và 100 goal/todo live (decision không tính); plan list 20 (≤100, ≤24 KiB); knowledge owner 400; hàng ≤16 KiB, packet ≤128 hàng.
Không có TTL hay timeout mặc định.

Test: `work.test.ts`, `planning.test.ts`, `workspace-runtime.test.ts`, `work-native.test.ts` (provider inert). Còn thiếu: gợi ý alias/fuzzy,
typed branch-output review, biến thể crash/interruption. Mechanics pass không chứng minh finding đúng hay tiết kiệm chi phí.
