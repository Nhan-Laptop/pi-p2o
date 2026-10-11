# Work admission, kế hoạch và phase packet — checkout K4

**Đã nối vào runtime, đã push và cài (không có release/version riêng); chưa hoàn tất K0–K7.**
Đây là slice của [roadmap](../planning_update.md), dùng TaskBoard/Engine/candidate gates hiện có.
Không có task/finding store thứ hai, Planner ẩn, target retry hoặc ngân sách tự tái cấp.
“Goal” trong tài liệu này là record mục tiêu assessment; không kích hoạt Goal mode của coding harness.

## Một nguồn canonical và phân quyền

- Store schema **6**, exchange records **v2**, graph identity policy **1**, bundle **2**.
- Tasks vẫn là owner-authored revision records. `work_history` và `work_reservations` là index/constraint trong **cùng transaction/database**, không queue có quyền thực thi riêng.
- TaskBoard giữ các cổng active owner, 100 live tasks, accepted/pinned prerequisites, runtime identity, cancellation, verified cleanup, evidence và independent-support.
- `p2o_task`/`p2o_plan` chỉ owner. Delegated Planner được làm knowledge/planning nhưng không target-execute. Worker/reporting không sửa goal/todo/decision hay tự dispatch.
- Imported bytes/checkpoints/reconciliation/history/ACKs chỉ là knowledge. Không tạo worker/ticket/cookie/socket, restore scope/queue/reservation authority hoặc renew run allowance.
- Schema 3/4/5 và unknown schema chỉ metadata-only historical inspection; writer/domain reads bị từ chối, không migrate in place. Bundle v1/v2 compatibility là cơ chế khác, không mở writer cho store cũ.

## Work identity: không hash prose rồi gọi là semantic matching

Optional `draft.work` chứa:

| Field | Ý nghĩa |
|---|---|
| `assetRefs` | Graph entity IDs cùng run, optional revision/variant label; chưa có asset phải record graph trước |
| `questionKey`, `policyKey?` | Key có chủ đích cho câu hỏi/policy, không câu văn tự do |
| `actorContext`, `tenantContext` | Non-secret opaque handles; không credential, permission hay session selector |
| `methodFamily` | Family đã khai báo, không suy từ method rationale |
| `purpose` | `mapping/discovery/investigation/refinement/validation/retest/reporting` |

Fingerprint versioned kết hợp namespace của canonical run, confirmed target/source revision,
asset/variant IDs và revisions đã sort, question/policy key, actor/tenant context,
method family, pinned prerequisite revisions và purpose. Prose `question/surface/risk` không tham gia fingerprint.
Thay chữ/paraphrase của cùng structured identity không tạo exact work mới.

Thiếu work metadata, asset/prerequisite pin hoặc explicit actor/tenant context ⇒
`dedupConfidence:unknown`, không fabricated exact match. Reserve pin current asset/accepted
prerequisite revisions và kiểm tra lại trước launch; stale asset/prerequisite không được command-admit.
Keys là bounded NFC ASCII identifiers; không trim/lowercase/URL-normalize hay tự merge alias.
Dùng opaque handles không chứa secret; redaction vẫn không phải secret-free guarantee.

### Lookup và quyết định

`p2o_task {"action":"match","draft":...}` đọc active **và indexed retained heads/history**, không recent display tail.

- `already_covered_by`: exact active task IDs; create trùng trả navigation result, không tạo task/spawn mới.
- `reuse_candidates`: current closed/reviewed coordination result, record/evidence refs, revision và limitations. Không chứng minh goal met hay finding verified.
- `partial`: prior blocked/cancelled/expired attempt cần inspect gaps; không tự replay target.
- `overlaps`: same canonical asset/question/policy nhưng identity khác (method, actor, pins, purpose…). Warning không phải exact duplicate.
- Omissions được trả rõ. Admission không đoán an toàn khi exact lookup vượt bounded view.

History stats query toàn index; response chọn current heads, ưu tiên active/reusable/partial.
Task revisions vẫn nằm trong canonical records. Superseded task review không thành current reusable result.
Standalone JSONL compatibility reader dùng bounded full scan, không có SQLite index hay authority.

Nếu đã có structured work, `decision` và `outputContract` là bắt buộc:

- `new`: lý do công việc mới; không tự gắn prior task.
- `refine`: purpose `refinement`, matching `relatedTaskId`.
- `validate`: purpose `validation`, role validation, explicit matching `validationOf/relatedTaskId`, reviewed predecessor và separate worker/attempt.
- `retest`: purpose `retest`, `retestOf/relatedTaskId`, reviewed predecessor và `changeReason` rõ.
- `retry`: prior blocked/cancelled/expired task, reason và change/retry rationale sau khi inspect gaps. Không automatic retry.

Reuse/defer được ghi thành **decision record** qua `p2o_plan`, không task giả chỉ để spawn.
Different fully structured actor/method có thể có assignment riêng; executor semaphore/profile vẫn giới hạn target-operation concurrency.
Với unknown metadata giữ conservative surface/risk conflict rule cũ. Shared mặc định vẫn serial.

### Atomic reserve

Lookup không phải lock. Reserve lặp checks; task revision + event/outbox + indexed history + unique fingerprint reservation commit chung.
Hai proposals đua nhau: proposed head sớm hơn được ưu tiên; unique constraint ngăn double assignment.
Conflict packet rollback cả packet, không để nửa reservation/ACK. Running command tiếp tục kiểm tra current pins.
Reservation/history sau crash không tự tái kích hoạt; muốn investigation cần run/confirmation/ticket mới.

## Desired output và phase card

`outputContract` khai báo `kind`, `required`, `partialAllowed`, `artifactPolicy` và optional notes.
Kind: `inventory/policy/investigation/validation/retest/report/custom`.
Required fields: `assets/facts/evidence/controls/gaps/candidates/artifacts/coverage`.
Đây là yêu cầu delivery/review, **không oracle** tự xác nhận field đúng, đủ hoặc independently proven.

Atomic handoff hiện thêm một owner-generated `data.phase` note bên cạnh report parts/manifest,
coverage/open entries và task revision. Task giữ `phasePacketId`. Card có assignment/task revision,
worker/report ID, delivery, reported-output counts, desired contract, unreviewed required fields và blocked/outcome.

- Card `reviewStatus:pending` là lịch sử tại delivery; UI còn hiển thị **current task status** riêng.
- Reserved/no-investigation ⇒ blocked task. Running report ⇒ reported task, kể cả provider-error/partial delivery; owner review vẫn bắt buộc.
- Worker settle không report/provider lỗi dùng fallback lifecycle report **đã có**, nay cũng tạo phase card trong cùng packet. Không thêm model turn hay retry target.
- Retained ACK replay không thêm card/parts/event/wake; after-commit fault đọc ACK, before-commit rollback không giả successful delivery.
- Checkpoint có planning/phase counts và pending phase IDs; counts không làm assessment complete.

## Durable goal/todo/decision

`p2o_plan` root-object schema, host kiểm tra action-specific fields:

```json
{
  "action": "create",
  "requestId": "operator-goal-1",
  "entry": {
    "kind": "goal",
    "title": "Đánh giá một boundary đã khai báo",
    "status": "active",
    "reason": "Cần review policy và control trước kết luận",
    "criteria": ["Review receipt và một effective control"],
    "exclusions": ["Không mở rộng scope"],
    "taskIds": ["task-<retained-id>"]
  }
}
```

ID trong ví dụ là placeholder; phải dùng retained IDs thật. `create` sinh ID;
`revise` cần `id`, expected `revision` và entry đầy đủ. `list` có kind/cursor/limit, `view` lấy một ID.
Same requestId/logical fields/submitted payload ⇒ ACK/result gốc; changed input ⇒ `IDEMPOTENCY_CONFLICT`.
Host bind action/input/expected revision vào request hash; IDs/timestamps sinh sau retained lookup.
ACK recovery không cấp lại authority hoặc tiêu thêm knowledge allowance.

- Goal: criteria/exclusions, task/goal/support refs; tạo proposed/active/blocked, review/close phải explicit revision và same-run evidence support. Không automatic goal completion.
- Todo: open/in-progress/done/deferred/blocked/cancelled, optional goal/task refs. Goal graph không được cycle.
- Decision: recorded/withdrawn; disposition `new/reuse/refine/validate/retest/defer`, reasons, chosen/deferred task IDs, optional revisit condition. Không tự enqueue/dispatch.
- Decision history không tính vào 100 live goal/todo cap; history vẫn chịu canonical record/storage quota. Không thêm TTL.
- Planner context có bounded open-plan navigation và latest decision IDs/omissions, không full role/relevance/consumed-cursor packet của K6.

## Human read-only views

```text
/p2o plans [cursor]
/p2o plan <id>
/p2o phases [cursor]
/p2o phase <id>
/p2o task <id>
/p2o checkpoints <id>
```

Không target/model call, consume Engine semantic events hoặc ghi execution authority.
Sau finish, final status giữ in-memory; để xem durable detail, hoàn tất settle/stop rồi
explicit `/p2o open <run-id>`. Historical running states là interrupted/unknown, không live.
TUI có scroll; RPC trả notify text. Model retrieve phase note qua `p2o_ledger` với phase ID.

## Default / min / max

| Bound/option | Default | Min | Max / semantics |
|---|---:|---:|---|
| Structured work metadata | absent/unknown | — | explicit; không prose/LLM inference |
| Work asset refs / prerequisites | required array / `[]` | 1 / 0 | 10 / 10, unique identities/task IDs |
| Work key / actor / tenant | không inferred default | 1 char | 160 chars (family 80, variant 120) |
| Output required fields | explicit khi structured | 1 | 8 distinct fields |
| Decision reason / changeReason | explicit | 10 chars | 1000 chars |
| Work history query | 20 | 1 | 100 current heads; exact omissions, indexed history stats |
| Live task frontier | 100 | — | không lifetime terminal-history limit |
| Live goal/todo frontier | 100 | — | decision history không tính, không reopen bypass |
| Model plan list | 20 | 1 | 100 items / 24 KiB encoded result |
| Human plan/phase page | 20 | — | 20; snapshot-relative cursor |
| Owner knowledge/plan allowance | 400 | — | finalization còn dùng được; retained plan ACK không charged lần nữa |
| Phase row / packet | — | — | canonical 16 KiB/row, 128 rows/packet |
| Assessment/Worker elapsed deadline | không | — | không thêm TTL/default task timeout |

## Qualification và phần chưa đóng

Tests: `work.test.ts`, `planning.test.ts`, workspace-runtime và actual-Pi `work-native.test.ts`.
Covers structured/paraphrase/actor-method identities, full-history lookup, partial/retry,
atomic conflict rollback, stale pins, separate validation/retest, owner spoof refusal,
request conflicts/faults, reportless provider phase, read-only cards và no extra target/model work.
Native provider là scripted/inert; không paid-provider/schema-all-provider/installed acceptance.

K4 vẫn cần broader alias/fuzzy suggestion + explicit review tooling, typed incremental branch-output
references/contract review và interrupted/reservation/crash variants. Canonical case/support-currentness/coverage slice K5 đã nối theo [CASE_REVIEW.md](CASE_REVIEW.md); broader variant/review policy vẫn cần qualification. Indexed role/relevance/UI packets, old-gap recall, consumption cursors và large-history/RSS thuộc K6.
K2 privacy/TOCTOU/partial-import/archive hardening và K7 full release matrix vẫn mở.
Passing mechanics không chứng minh finding correctness, savings, effectiveness hay tối ưu hơn ARTEX.
