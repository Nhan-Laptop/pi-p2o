# Knowledge workspace — trạng thái K0–K7

K0–K7 đã nối vào `main` và được test pin; `package.json` vẫn **0.5.0**, chưa có release mới. Acceptance installed hiện là
6 test inert, chưa phải ma trận đầy đủ, chưa có Herdr thật và chưa có benchmark trả phí cho thiết kế hiện tại — hiệu quả
pentest vẫn **UNVERIFIED**. Tài liệu hiện hành: [ARCHITECTURE](ARCHITECTURE.md), [PLANNER_ENGINE](PLANNER_ENGINE.md),
[USAGE](USAGE.md), [HTTP_TRANSPORT](HTTP_TRANSPORT.md), [EVIDENCE](EVIDENCE.md), [KNOWLEDGE](KNOWLEDGE.md),
[WSTG_MAP](WSTG_MAP.md), [ACCEPTANCE_MATRIX](ACCEPTANCE_MATRIX.md). Mốc lịch sử và số đo cũ: [HISTORY](HISTORY.md).

## Ràng buộc đã chốt

- Triển khai theo vertical slice có gate; không viết lại Engine.
- Retention mặc định **durable-local**, luôn nằm trong human confirmation; có `ephemeral`.
- **Commit, push và install chỉ do chủ repo yêu cầu** (một lần đồng ý không kéo sang lần sau); không chạy paid/live
  assessment, không chạy reference code.
- Lịch sử/checkpoint chỉ phục hồi tri thức, không worker/ticket/cookie/socket/request/quyền thực thi.
- Giữ manual + shared làm mặc định và vòng đời không giới hạn thời gian; không heartbeat mặc định, không retry/fallback,
  không tự cấp lại quyền.

## Các lát đã nối vào checkout

| Lát | Có gì | Tài liệu |
|---|---|---|
| K0/K2 store | SQLite canonical một writer, durable-local, checkpoint/recover/reconcile, capture trước khi cắt, bundle export/import, finalization reserve | [ARCHITECTURE](ARCHITECTURE.md), [USAGE](USAGE.md) |
| K1 visibility | `status`/`log`/`report`, widget `p2o-progress`, không cần model call | [USAGE](USAGE.md) |
| K3 graph | Asset/fact/hypothesis có identity, revision pin, provenance, JSON/Mermaid, `chain` join | [KNOWLEDGE](KNOWLEDGE.md) |
| K4 work | Work identity có cấu trúc, reserve nguyên tử, goal/todo/decision, phase card, chain board | [PLANNER_ENGINE](PLANNER_ENGINE.md) |
| K5 case/coverage | Case pin chính xác, currentness, duplicate theo root cause, rating, coverage hai trục do host chiếu | [EVIDENCE](EVIDENCE.md) |
| K6 context | Knowledge heads/links/cursors (schema 7), packet request-local, `heads`/`digest`/`search` | [KNOWLEDGE](KNOWLEDGE.md) |
| K7 acceptance | Ma trận 22 fixture §13.1 + 7 điều kiện §13.3 → test thật, có guard tự động | [ACCEPTANCE_MATRIX](ACCEPTANCE_MATRIX.md) |
| P0–P7 | Finish preflight, báo cáo tự động, case rating, báo cáo OWASP v2, WSTG map | [EVIDENCE](EVIDENCE.md), [WSTG_MAP](WSTG_MAP.md) |

Cleanup giữ tri thức bền và xoá quyền dùng một lần. Stop assessment đang chạy trước khi reload extension.

## Còn mở (không coi là xong)

- K2: archive/checkpoint phân đoạn >64 MiB, hardening TOCTOU/partial-import/privacy, ma trận lỗi/platform rộng hơn.
- K3: hạ tầng audit/platform/installed của K7.
- K4: gợi ý alias/fuzzy, review typed branch-output, biến thể crash/interruption.
- K5: chính sách affected-variant rộng hơn.
- K6: TUI render p95, đếm status từ heads/SQL, fixture replay hỗn hợp lớn.
- K7: audit đầy đủ từng requirement trên native/Docker/RPC/UI/pack; installed acceptance mới là 6 test inert; Herdr
  thật/paid/live; version/release chỉ khi được yêu cầu riêng.

Mechanics pass không chứng minh hiệu quả pentest, độ đúng finding hay tiết kiệm chi phí. Reported ≠ reviewed; resources
cleaned ≠ assessment complete.
