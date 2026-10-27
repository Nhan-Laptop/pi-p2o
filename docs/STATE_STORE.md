# AssessmentStore — SQLite canonical (K0/K2)

Mỗi run có **một** database SQLite do process owner ghi; đã push và cài (không có version riêng). Roadmap: [KNOWLEDGE_WORKSPACE](KNOWLEDGE_WORKSPACE.md).

## Công nghệ cốt lõi

- `node:sqlite` (`DatabaseSync`), không addon. Store schema **7**, record exchange **v2**. `journal_mode=DELETE`,
  `synchronous=FULL`, foreign keys bật; store có journal mode khác bị từ chối, không có WAL/SHM.
- `writer.lock` giữ `BEGIN EXCLUSIVE` suốt đời writer: writer thứ hai bị từ chối, OS nhả khóa khi process chết; không đoán stale lock.
- `assessment.sqlite` là nguồn canonical cho record, event, outbox và kết quả request (cùng một transaction). Store không tạo
  Engine, broker, worker, ticket, cookie hay model turn; nó **không** chứa quyền thực thi.
- Idempotency theo `(run, actor, requestId)`: cùng payload trả kết quả gốc, khác payload → `IDEMPOTENCY_CONFLICT`. Chỉ idempotent
  *domain write*; không có exactly-once cho target operation và không replay POST/shell/network. `started` chỉ là dispatch.
- ACK canonical `{recordId, version:2, sequence, storeVersion}`. Subscriber lỗi không rollback commit.

```text
<private root>/<run-id>/   assessment.sqlite  writer.lock  artifact-<id>.txt  checkpoint-<id>.json
```

Thư mục 0700, file 0600, đúng UID, một hard link. Mọi đường dẫn đi qua FD đã pin (`O_DIRECTORY|O_NOFOLLOW`); symlink, device,
hard link và traversal bị từ chối; đổi directory giữa chừng làm SQLite fail closed. Boundary chống target/container/model, **không**
chống root hay process cùng UID. Thư mục này không bao giờ mount vào sandbox; source clone bỏ mọi state/bundle/export root.

## Module chính

| Module | Vai trò |
|---|---|
| `src/state/{files,schema,store,registry,adapter}.ts` | FD containment, schema, ghi nguyên tử, bind một owner adapter, TaskBoard/Evidence/report đọc cùng SQLite |
| `src/state/graph.ts`, `graph-tool.ts` | Graph K3 ([ASSET_GRAPH](ASSET_GRAPH.md)) |
| `src/records.ts`, `src/ledger-memo.ts` | Validator chung, ledger tăng dần `IncrementalLedger`, memo theo snapshot |
| `src/tasks.ts`, `src/board.ts` | TaskBoard + `LedgerBoard` (mutation tuần tự dùng chung Task/Plan/Case/Coverage) |
| `src/work.ts`, `src/planning.ts`, `src/phase.ts` | K4 ([WORK_ADMISSION](WORK_ADMISSION.md)) |
| `src/artifacts.ts`, `src/process.ts`, `src/scratch.ts` | Capture output, artifact, đọc scratch |
| `src/context.ts` | Heads/packets K6 ([CONTEXT_PACKETS](CONTEXT_PACKETS.md)) |
| `src/validate.ts`, `src/schema-kit.ts`, `src/tool-schemas.ts` | Validator đầu vào dùng chung, schema tool (`choices()` → `enum`) |

## Handoff

`TaskBoard.handoff()` commit trong một transaction: report parts + manifest, task revision (`reported`, hoặc `blocked` nếu
chưa điều tra), coverage/open (coverage ở đây là note/handoff của worker, không phải cell; từ A3 cell coverage do host chiếu từ
công việc đã review), phase card. Sai assignee/revision cũ/owner không hoạt động bị từ chối; không tự review hay đóng gì.
Replay trả ACK gốc, không phát lại notification.

## Artifact và capture

- Output lệnh được capture (prefix, mặc định 1 MiB, tối đa 8 MiB) **trước** khi cắt hiển thị 48 KiB, redact rồi mới publish
  immutable. `sha256` là hash bytes đã redact; `beforeRedactionSha256` chỉ hash prefix, không toàn output. Redaction là
  best-effort, không bảo đảm hết secret.
- `p2o_capture` đọc file text trong scratch của assignment (FD-relative, single-link, UTF-8, `offset` 0..1 GiB để chia
  segment ≤ bound); `maxKiB` hạ trần capture cho **một** lần gọi nhưng không bao giờ vượt `artifactCaptureKiB` của run;
  `p2o_artifact {id, offset?, length?}` đọc lại ≤48 KiB/lần (mặc định 8 KiB); người dùng có `/p2o artifact <id> [offset]`.
- Finalization reserve `max(256 KiB, min(4 MiB, quota/16))` chỉ dành cho outcome cuối và checkpoint. Quota mặc định 256 MiB (8–1024).

## Checkpoint, bundle, reconcile

- **Checkpoint**: snapshot tại transaction boundary (records, events, artifact manifest, graph) + hash, missingness, pending
  review, in-flight. `integrity` (hash) tách khỏi `dataStatus` (partial khi capture thiếu/interrupted/lossy). Không chứa authority.
- **Bundle** (`/p2o export|import <absolute-dir>`): `manifest.json` ghi cuối, `segments/{records,events,graph}-NNNNN.ndjson`
  (≤4 MiB), `artifacts/`; tối đa 64 MiB/4096 file, SHA256 từng file, ghi qua temp dir → rename. Import verify hết rồi giữ bytes
  thành artifact bất biến + một note provenance; dữ liệu import không là same-run evidence và không khôi phục authority.
- **Reconcile** (`/p2o reconcile <run-id>`): ghi một record lifecycle liệt kê việc dở dang (`authorityRestored:false`); không đổi task.
- **Recover** (`/p2o recover <run-id>`): rollback hot journal bằng infrastructure writer rồi mở lại read-only.

## Migration

JSONL v1/v2 cũ vẫn đọc, không tự migrate. Schema 3–6 chỉ xem metadata (writer bị từ chối, không migrate in place); schema lạ bị từ chối.
Rollback = dừng thực thi, giữ store mới read-only, chạy run mới có confirmation.

## Reproduce

```sh
npm run build
npx vitest run tests/minimal/assessment-store.test.ts tests/minimal/state-adapter.test.ts tests/minimal/artifacts.test.ts tests/minimal/scratch.test.ts
node scripts/check-assessment-store.mjs --source          # thêm --records=10000|100000
node scripts/check-assessment-graph.mjs --source          # thêm --assets=4000
```

Chạy trên Node 22.19 (SQLite 3.50.4) và 24.19 (3.53.4). Số đo lịch sử trên i7-1355U: 100k record — commit batch 100 hàng
p95 ≈26 ms, event page p95 ≈13 ms, checkpoint ≈0,5 s, RSS ≈435 MB. Đây là một lần chạy cục bộ, không phải cam kết hiệu năng.
Bảng giới hạn đầy đủ: `git show 656843d:docs/STATE_STORE.md`.
