# Knowledge workspace — trạng thái K0–K7

**Đang triển khai; K0–K7 chưa hoàn tất.** Phần đã làm nằm trong `main` và đã cài vào Pi 1.1.0 của tác giả; `package.json` vẫn **0.5.0**, chưa có
release riêng (baseline đã phát hành: 0.5.0 / `e639029`). Thiết kế K0–K7 gốc: `git show 7e204c3:planning_update.md`. Acceptance lịch sử không bị thay bằng receipt của code mới.
Mọi con số kiểm thử cũ nằm ở [VERIFICATION_LOG](VERIFICATION_LOG.md).

## Ràng buộc đã chốt

- Thực hiện toàn bộ K0–K7 theo vertical slice có gate; không viết lại Engine.
- Retention mặc định **durable-local, luôn nằm trong human confirmation**; có `ephemeral`.
- **Commit, push và install chỉ do chủ repo yêu cầu** (một lần đồng ý không kéo sang lần sau); không chạy paid/live assessment hay reference code.
- Lịch sử/checkpoint chỉ phục hồi tri thức, không worker/ticket/cookie/socket/request/quyền thực thi.
- Giữ manual + shared và vòng đời không giới hạn thời gian; không heartbeat/retry/fallback, không tự cấp lại budget.

## Các lát đã nối vào checkout

| Lát | Có gì | Tài liệu |
|---|---|---|
| K0/K2 store | SQLite canonical một writer, durable-local, checkpoint/recover/reconcile, capture trước khi cắt, scratch segment, bundle export/import, finalization reserve | [STATE_STORE](STATE_STORE.md) |
| K1 visibility | `/p2o status|tasks|task|log|report`, widget `p2o-progress`, không cần model call | [USAGE](USAGE.md) |
| K3 graph | Asset/fact/hypothesis có identity, revision pin, provenance, JSON/Mermaid | [ASSET_GRAPH](ASSET_GRAPH.md) |
| K4 work | Fingerprint có cấu trúc, `match`/reserve nguyên tử, goal/todo/decision, phase card | [WORK_ADMISSION](WORK_ADMISSION.md) |
| K5 case/coverage | Case pin chính xác, currentness, duplicate theo root cause, rating, coverage hai trục | [CASE_REVIEW](CASE_REVIEW.md) |
| K6 context | Knowledge heads/links/cursors (schema 7), packet request-local, `heads`/`digest`/`search`, status tăng dần | [CONTEXT_PACKETS](CONTEXT_PACKETS.md) |
| K7 acceptance | Ma trận 22 fixture §13.1 + 7 điều kiện §13.3 → test thật, có guard tự động | [ACCEPTANCE_MATRIX](ACCEPTANCE_MATRIX.md) |
| Workflow + báo cáo (P0–P7) | Finish preflight, báo cáo tự động, rating case, báo cáo OWASP v2, WSTG map | [USAGE](USAGE.md), [WSTG_MAP](WSTG_MAP.md) |

Cleanup giữ tri thức bền, xóa quyền dùng một lần. Stop assessment đang chạy trước khi reload extension.

## Còn mở (không coi là xong)

| Mảng | Còn thiếu |
|---|---|
| K2 | Archive/checkpoint phân đoạn >64 MiB, hardening TOCTOU/partial-import/privacy, re-ingest theo typed domain, ma trận lỗi/platform rộng hơn |
| K3 | Hạ tầng audit/platform/installed của K7 |
| K4 | Gợi ý alias/fuzzy, review typed branch-output, biến thể crash/interruption |
| K5 | Chính sách affected-variant rộng hơn |
| K6 | TUI render p95, đếm status từ heads/SQL, fixture replay hỗn hợp lớn |
| K7 | Audit đầy đủ từng requirement trên native/Docker/RPC/UI/pack; installed acceptance mới là 6 test inert; Herdr thật/paid/live; version/release chỉ khi được yêu cầu riêng |

Mechanics pass không chứng minh hiệu quả pentest, độ đúng finding hay tiết kiệm chi phí. Reported ≠ reviewed; resources cleaned ≠ assessment complete.
