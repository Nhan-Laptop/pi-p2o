# Knowledge workspace — trạng thái triển khai K0–K7

**Work in progress; K0–K7 chưa hoàn tất.** Từ 2026-10-10 phần đã làm nằm trong `main` (`007ee58`, `7e204c3`, `b7cfa6f`, `41e8157`, đã push) và đã được cài vào Pi 1.1.0 của tác giả; `package.json` vẫn **0.5.0**, chưa có release/version riêng. Baseline đã phát hành: 0.5.0 / `e639029`.
Thiết kế K0–K7 gốc đọc tại commit `7e204c3` (`git show 7e204c3:planning_update.md`); [planning_update.md](../planning_update.md) hiện là **kế hoạch audit prompt/skills và chuẩn OWASP WSTG (S0–S6 đã triển khai)** và giữ nguyên acceptance baseline K0–K7 ở §13; kế hoạch giai đoạn W0–W8 đọc tại `git show 41e8157:planning_update.md`. Acceptance lịch sử không được thay bằng receipt của code mới. Các mục "Verification" cũ (chuyển sang [VERIFICATION_LOG.md](VERIFICATION_LOG.md)) ghi trạng thái **tại thời điểm của chúng** (chưa commit, chưa installed, Pi cài vẫn 1.0.0); mục mới nhất ngay dưới "Verification mới nhất" thay thế các trạng thái đó và không sửa receipt cũ.

## Scope và consent đã chốt

- Thực hiện **toàn bộ K0–K7**, chia vertical slices có gate; không viết lại Engine.
- Retention đích: **durable-local mặc định, luôn nằm trong human confirmation**, có lựa chọn ephemeral.
- Không tự commit/push/install, chạy paid/live assessment hoặc execute reference code. Commit/push/install chỉ khi người dùng yêu cầu rõ; yêu cầu đó đã được đưa ra cho `007ee58`/`7e204c3` ngày 2026-10-10 và không kéo dài sang lần sau.
- Lịch sử/checkpoint chỉ phục hồi tri thức, không workers/tickets/cookies/sockets/requests/execution authority.
- Manual/shared và unlimited elapsed lifetime được giữ; không model heartbeat/retry/fallback, không tự renew budgets.

**Checkout đã nối K2, graph K3, K4, slice K5 và slice K6 (schema 7):** durable-local mặc định/luôn confirm, canonical owner writer, authenticated mutations/atomic handoff, operation checklog, checkpoint/recovery, bounded pre-truncation capture, scratch segments, finalization reserve và portable bundle đã có. [Graph K3](ASSET_GRAPH.md) thêm scoped versioned identities, anchors/assertions/relations/provenance, revision pins, bounded history/JSON/Mermaid và snapshot/tail. [Work/planning K4](WORK_ADMISSION.md) nối structured active/history matching, atomic fingerprint reservation, goal/todo/decision records và phase/checkpoint cards. [Case review K5](CASE_REVIEW.md) nối exact support pins, canonical duplicate/currentness review, explicit coverage denominator/cells và final report/checkpoint views. [Indexed context K6](CONTEXT_PACKETS.md) (schema 7) thêm rebuildable knowledge heads/links/cursors trong cùng database, human `/p2o heads|digest`, read-only `p2o_state` và request-local Planner/Worker packets với delivery ACK sau assistant `message_end` thành công. Cleanup giữ durable knowledge, xóa disposable authority. Đã có trong `main`/bản cài `7e204c3` (chưa có version mới). Đường status/widget legacy đã incremental ([K6](CONTEXT_PACKETS.md#legacy-status-and-widget-path)) và [acceptance matrix K7](ACCEPTANCE_MATRIX.md) đã lập. Vẫn mở: K2 hardening, broader K4 branch-output/alias/fuzzy/crash gates, K5 affected-variant policy, K6 TUI render p95 + đếm status từ heads/SQL + large mixed replay fixtures, và K7 full per-requirement installed/Herdr/paid audit. Không coi slice này là hoàn tất K0–K7.

## K1/K2: visibility đã chuyển sang canonical backend

```text
/p2o status
/p2o tasks [all|live|awaiting-review|blocked|done] [cursor]
/p2o task <task-id>
/p2o log [cursor]
/p2o report
```

- TUI: read-only screen, arrows/PageUp/PageDown, Esc/q; Unicode/resize/reflow.
- RPC: notification dễ đọc; không cần model call hay consent mới để inspect.
- Widget `p2o-progress`: committed-write/progress hints; chỉ quét khi `ctx.mode === 'tui'`; local one-shot coalescer `max(25 ms, 4× chi phí lần quét trước)` tối đa 5 s trên ledger incremental ([đo và giới hạn](CONTEXT_PACKETS.md#legacy-status-and-widget-path)); không model polling hoặc Engine signal consumer.
- `p2o_note` trả record ID/committed sequence/storeVersion (= store schema, hiện 7) từ owner/broker; legacy JSONL API vẫn label ACK v2 không sequence.
- Task renderer compact/expanded; **reported ≠ reviewed**. Report view là attributed index, không tự viết final narrative hay nâng proof.
- Stop tháo subscriptions/widget. Final summary in-memory vẫn mất khi reload, nhưng durable detail mở lại bằng explicit `open <run-id>`; không phục hồi authority. Ephemeral full data bị xóa; optional legacy export là riêng.
- Session entries chỉ navigation markers, không model-visible messages, checkpoint bytes hoặc recovery tokens.

### Bounds/missingness

Task/log page 20 items; task detail giữ 20 revisions cuối. `log 0` bắt đầu duyệt, mặc định log là tail. Canonical `log` dùng stable event sequence; standalone legacy reader vẫn dùng record offsets, không fabricated durable events. Task cursor theo filtered snapshot; sau mutation nên bắt đầu lại zero.

Incomplete/corrupt/legacy-correlation-unknown được label. Counts là tasks/handoffs/claims/open entries, không unique tested cells hay validated findings. Operational cleanup, assessment outcome, review, integrity và currentness là các axes khác nhau.

## K0/K2: foundation mới đã implement và source-test

Contract/ADR chi tiết: [AssessmentStore](STATE_STORE.md).

### Những phần có code thật

- `src/state/{files,schema,store,registry,adapter}.ts`: SQLite single owner writer; private pinned FD paths; OS/SQLite lock; record/event/outbox/request commit chung; stable event cursor/exact counts.
- Store schema 7, record exchange v2; schema 3/4/5/6 và unknown schema writer/domain queries denied, historical metadata-only inspection; không migrate in place.
- Chọn rollback journal `DELETE` / FULL sync; journal policy khác bị từ chối. Đây là quyết định sau WAL feasibility spike, không tuyên bố runtime dùng WAL.
- Domain idempotency có conflict checks và retained ACK; host UUID/timestamp sinh sau lookup. Không replay target operations.
- Bounded redacted artifact manifests + hash/range reads; immutable-ID file publication; missing/tampered bytes làm integrity partial.
- Transaction-boundary logical checkpoints, hashes, missingness, in-flight work, gaps/pending reviews; snapshot + event tail consistency.
- Adapter cho TaskBoard/EvidenceStore/report dùng **một SQLite source**, không JSONL replica. Unbound `.sqlite` alias denied thay vì silent fallback.
- `TaskBoard.handoff()`: atomic report parts/manifest + task revision + coverage/open/phase card; reserved/no-investigation → blocked; running → reported; owner review vẫn bắt buộc.
- Shared integrity validator và baseline evidence/prerequisite/current independent-support gates được giữ.

**Runtime integration đã có:** extension bind một adapter, ticket chỉ giữ alias `control/records.sqlite` không-file; workers không append trực tiếp. Handoff/report/coverage/open/task revision commit một packet. Notes/start/report có authenticated request keys và retained ACK-only replay; không lặp Engine effects/budgets hay khôi phục target authority. Host operation IDs nối actor/task/receipt; started chỉ executor dispatch, cancellation không remote rollback.

Human APIs: `/p2o checkpoint [reason]`, `checkpoints [id]`, `artifact <id> [offset]`, `open <run-id>`, `recover <run-id>`, `close`. Default `<cwd thực>/.p2o-state/<run-id>`; dir 0700/file 0600, không tạo trước confirmation. Durable final checkpoint sau revoke/cancel/resource verification; storage failure đóng authority trước optional finalization. Historical read-only không tạo Engine/worker/model/target; explicit infrastructure recovery không migration hay authority restore.

Source clone bỏ current control/state roots, reserved private roots, marker-paired prior/custom stores, recognized portable bundle roots (marker mới/bounded v1 index) và temporary exports, cả khi chọn private root làm target. Nested TMPDIR không khiến clone tự copy đệ quy. Package canary đã phát hiện `.gitignore` không override broad `files`; đã thêm explicit package exclusions và retest.

### Artifact pipeline đã nối checkout
- `OutputCapture` operation-owned/host-only, capture trước 48 KiB display cap, tổng used bytes stdout+stderr theo confirmed setting 1–8192 KiB (default 1024). Fixed buffers tránh descriptor growth cho endless/tiny chunks; allocation tối đa 2×bound, zero trong finally, không raw buffers qua tool/RPC.
- Owner redact prefix trước immutable publication; source/retained hash scopes riêng, cut-off PEM và UTF-8 loss được label. Stream/cancellation/unknown outcome và retained bytes không được gọi finding proof.
- Artifact IDs/counts/partial đi cùng receipt/checklog/owner-broker result. `p2o_capture` chỉ đọc file text trong scratch đã cấp (relative path, FD walk, single-link regular, UTF-8) rồi redact trước publication; symlink/hardlink/FIFO/device/directory/binary/ngoài-root bị từ chối, nội dung file không thành code; Planner/reporting bị từ chối. `offset` (0..1 GiB) cho phép giữ file dài thành nhiều artifact bounded theo segment (không host disk spill); output lệnh host vẫn chỉ capture prefix theo bound. Scratch protocol 2 giữ codepoint đầy đủ và next offset theo `capturedBytes`; artifact mới redaction 3 dùng bounded flags-only line/PEM context và cap sau redaction không cắt codepoint. Leading fragments/unknown ancestry được label partial, không secret-free guarantee; [bounds/limitations](STATE_STORE.md#artifacts). Model `p2o_artifact` đọc same-run ≤8 KiB theo byte cursor; reporting-role được read, không target command allowance hoặc execution authority. Revocation/foreign IDs/oversized JSON/bad ranges fail closed.
- Finalization reserve được chừa trong quota: artifact/record thường dừng trước ngưỡng, còn final outcome/`run.stopped`/explicit checkpoint vẫn ghi được; quota không tăng.
- `/p2o reconcile <run-id> [reason]` (human, confirm, không có active run): đọc counts non-terminal/unknown rồi ghi **một** lifecycle record có attribution; không rewrite task status, không resume, live writer/unknown schema bị từ chối, sau đó mở lại read-only và hiển thị `Reconciled @…`.
- `/p2o export <absolute-dir>` / `import <absolute-dir>` (human-only, ngoài private state root): bundle segmented có bytes+SHA256 từng file, manifest ghi sau cùng, không overwrite; import verify hash/size rồi giữ exported bytes thành artifact bất biến + một provenance note (không authenticate foreign redaction claims), từ chối bundle partial/trùng và file ngoài index chỉ được báo. Không khôi phục authority và không vượt same-run evidence gate.
- Checkpoint hash integrity khác `dataStatus`: capture thiếu/lossy/interrupted/unavailable hoặc unknown operations giữ data partial. Lỗi trusted host retention đóng authority ngay, kể cả không mang SQLite code; known target return không bị đổi thành target failure hoặc replay.

### Gate K2 còn phải hoàn thiện
- Archive segmented >64 MiB cho bundle (hiện fail rõ khi vượt bound); host-side capture vẫn là prefix trong bộ nhớ theo thiết kế, file dài đi qua scratch + segment capture.
- Broader crash/platform acceptance và re-ingest typed domain cho bundle (K3–K5); attributed interruption reconciliation đã nối.
- Basic phase/checkpoint cards và durable planning K4 đã nối; typed incremental branch-output review/support heads K4–K5 và indexed bounded role/model/UI packets K6 còn mở.
- Segment UTF-8/credential/PEM boundary hardening đã có protocol 2/redaction 3; unknown ancestry vẫn best-effort/partial. Bundle ancestor/TOCTOU/read bounds/partial-import atomicity và foreign sensitivity còn cần adversarial hardening; ASCII round-trip không đóng privacy gate.

Đây là canonical runtime handover, **không** full K2 artifact/import/export release và không đóng toàn objective.

## Verification mới nhất

- **Cập nhật prompt/skill/WSTG (S0–S6, 2026-10-11, Pi 1.1.0, source checkout):** `b823e8c` (docs và HELP), `0c432bf` (recon contract một lần, tên tool đúng loadout), `2ff5c33` (loadout solo không có tool điều phối worker), `4b5cf3a` (catalog không tên tool), `a71bd78`/`fe91ae6`/`dfc4ed6` (bản đồ OWASP WSTG 108 test, tài liệu `shared:wstg-map`, mục WSTG checklist trong báo cáo), `dd2a8ea` (docs, hàng F-S0…F-S6), `b134e39` (`scripts/measure-context.mjs`). Chạy tại cây làm việc trước khi commit: `npm test` exit 0, **481 Vitest passed / 12 skipped**, Python **143 OK**; `scripts/measure-context.mjs --source` trước/sau: ngữ cảnh worker recon 8.338 → 6.415 ký tự (dir), khai báo solo 40.603 → 36.967 B, prompt lead không đổi. Không chạy benchmark trả phí, Herdr hay `--live`; hiệu quả pentest vẫn UNVERIFIED; phân loại D/T/N/O của 108 test chưa được owner rà soát.
- Các receipt trước đó (2026-10-10 trở về trước: giai đoạn W, K2–K7, benchmark, pin Pi 1.1.0, qualification audit/graph) nằm nguyên văn ở [VERIFICATION_LOG.md](VERIFICATION_LOG.md); không receipt nào bị sửa hay xóa.

## Requirement checklog — toàn objective vẫn đang mở

| Milestone | Đã có | Còn cần acceptance |
|---|---|---|
| K0 contract/spike | Identity/authority/retention ADR; SQLite hai Node versions; final foundation schema, paths/locks/failure tests, migration map, initial measurements | Runtime handover/recovery/import/retention qualification; broader matrix, không all-clear từ spike |
| K1 visibility | Human commands/widget/canonical IDs/sequence, no model wake, missingness labels, checkpoint views | Full phase/packet views, indexed bounded queries K6 |
| K2 canonical workspace | Atomic canonical owner runtime, authenticated retained ACK, operation checklog, durable consent/default, cleanup/checkpoint/read-only reopen/recover, bounded pre-truncation capture/model ranges, validated scratch ingest + segment capture, finalization reserve, portable bundle export/import có integrity gate, attributed interruption reconciliation và explicit partial data | Archive segmented >64 MiB, broader failure/platform qualification |
| K3 assets/facts/hypotheses | Versioned exact identities/source scope; canonical atomic batches/provenance; anchors/assertions/relations/history; negative/counterevidence/stale pins; role-gated `p2o_graph`, human JSON/Mermaid; checkpoint/tail/bundle graph bytes; concurrent Unix broker + actual-Pi fixtures | K7 broader audit/platform/installed gates; K2 archive/import/privacy hardening; K6 task/role relevance packets, không gọi graph retrieval là full context optimization |
| K4 dedup/planning/phase packets | Scoped structured fingerprint/unknown metadata, indexed active/history matching, unique atomic reserve/current asset pins, overlap/reuse/explicit retry/validation/retest; canonical owner goal/todo/decision + request ACK/conflicts; phase card atomic with handoff, reportless/provider-error fallback không thêm model turn, checkpoint/human/native views | Broader alias/fuzzy suggestion/review, typed incremental branch-output refs/contract review, interruption/reservation/crash variants; bounded role/relevance/large-history performance K6 |
| K5 cases/reviews/currentness | Canonical owner case revisions; exact claim/asset/task/hypothesis support pins; independent withdrawal/currentness; contradiction/related/acyclic root-cause duplicate gates; remediation/retest axis; versioned coverage denominator + separate execution/assessment cells; atomic plan+cell packet/replay; bounded tool/human/checkpoint/final report views; actual-Pi inert schema fixture | Broader affected-variant policy and K6 indexed large-history projections; K7 full/platform/installed gates. No finding correctness/effectiveness claim |
| K6 indexed context/history | Indexed event page + exact counts; schema 7 rebuildable knowledge heads/links/cursors; bounded Planner/Worker/reporting context packets, human `heads`/`digest` và read-only `p2o_state`; delivery ACK sau assistant `message_end` (stale/forged/aborted/revoked không advance); rotating old gap/review pages; checkpoint+tail knowledge-index replay; 10k/100k microbench ([K6](CONTEXT_PACKETS.md#verification-scope)) | TUI render p95 và (nếu cần) đếm status từ heads/SQL thay vì snapshot trong bộ nhớ (đường legacy đã incremental + memo + lazy digest: refresh p95 ≤114 ms ở 100k, đạt mục tiêu 200 ms trên corpus synthetic, nhưng vẫn O(lịch sử) trong giới hạn cap 100000 rows), large mixed graph/case/review **replay** fixtures, segmented checkpoint/archive >64 MiB, broader import atomicity/privacy/platform matrix. Microbench không phải UI/proof/installed acceptance |
| K7 qualified acceptance | Source regressions/foundation failure fixtures; [ACCEPTANCE_MATRIX](ACCEPTANCE_MATRIX.md) ánh xạ 22 fixture §13.1 + 7 điều kiện §13.3 tới test thật, có guard tự động | Full per-requirement native/Docker/RPC/UI/pack/source-hash audit; installed acceptance hiện chỉ 6 test inert + file giống byte (120 file tại `7e204c3`, 127 file tại `41e8157`); real Herdr/paid/live; version/release chỉ khi được yêu cầu riêng |

Tiếp tục triển khai các gates còn lại, không gọi goal hoàn thành ở một partial slice. Stop active assessment trước khi manually reload extension bytes mới.
