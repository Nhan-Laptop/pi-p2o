# AssessmentStore — nền tảng K0/K2, graph K3 và work/planning K4

**Runtime đã handover sang canonical store, đã push và cài (không có release/version riêng). K2 còn các gates artifact/import/export/context, không coi full roadmap đã hoàn tất.**
Xem [trạng thái toàn roadmap](KNOWLEDGE_WORKSPACE.md) và [thiết kế K0–K7](../planning_update.md).

## ADR K0-002: SQLite, một owner writer, rollback journal

- Driver: `node:sqlite` / `DatabaseSync`, không addon hay database service.
- Schema store **7** độc lập với exchange record **v2**. Giữ IDs/revision/supersedes/evidence gates cũ. Schema 7 thêm index K6 rebuildable (`knowledge_heads`, `knowledge_links`, `context_cursors`) trong cùng database; không có store thứ hai.
- Chọn `journal_mode=DELETE`, `synchronous=FULL`, foreign keys bật, `trusted_schema=OFF`.
- Không dùng WAL/SHM trong layout này. Store có journal mode khác bị từ chối; không tự đổi journal hay migrate.
- `writer.lock` là database khóa hạ tầng riêng, giữ `BEGIN EXCLUSIVE` suốt đời writer. Nó **không** chứa task/finding hay authority. Writer thứ hai bị SQLite từ chối; OS nhả khóa khi process chết. Không đoán stale lock từ PID/TTL rồi xóa khóa.
- `assessment.sqlite` mới là nguồn domain/event canonical. Outbox/request results nằm cùng database/transaction.
- Store/lock không tạo Engine, broker, workers, tickets, cookies, sockets, queued requests hoặc model turn.

DELETE giảm surface WAL/SHM và đơn giản hóa quotas/path qualification. Đổi lại commit synchronous vẫn có thể chặn event loop; cần batch và đo latency. Không suy ra UI latency từ query nhỏ.

### Layout và threat model

```text
<operator-selected private root>/<host-generated run-id>/
  assessment.sqlite
  writer.lock
  artifact-<opaque-id>.txt
  checkpoint-<opaque-id>.json
```

Root/run directory 0700; regular files 0600, đúng UID, một hard link. Linux `/proc/self/fd` là prerequisite có sẵn của package.

`PrivateDirectory` đi qua từng ancestor với `O_DIRECTORY|O_NOFOLLOW`, pin FD trước lookup tiếp theo. File dùng `O_NOFOLLOW|O_NONBLOCK`; symlinks, devices, hard links, traversal và mode không phù hợp bị từ chối. Publish bytes qua private temporary file → fsync → hard-link publish không overwrite → unlink temp → fsync directory. SQLite được cấp filename qua FD-root đã pin.

Kiểm thử thay directory đã mở bằng symlink chứng minh SQLite **fail closed** (`SQLITE_READONLY_DBMOVED`), không ghi journal vào directory ngoại vi và không mất commit trước. Không coi việc pass static symlink test là proof chống mọi race.

Boundary bảo vệ dữ liệu khỏi target/container và model paths không được cấp quyền. Nó không chống root, malicious host code/extension hay process khác có cùng UID và filesystem privileges. Durable directory tuyệt đối không mount vào sandbox. Runtime truyền control/state exclusion paths cho shared/isolated source clones; bỏ reserved private roots, prior/custom stores có `assessment.sqlite` + `writer.lock`, recognized portable bundle roots (marker mới hoặc bounded v1 index) và temporary `.p2o-export-*`, cả khi chọn trực tiếp làm target. Quotas và skipped counts không phải proof toàn target đã kiểm thử.

## Module/API host hiện có

| Module | Trách nhiệm đã implement |
|---|---|
| `src/state/files.ts` | Private FD containment, kiểm tra file, immutable-ID publication, bounded reads/usage |
| `src/state/schema.ts` | Versioned record/event/outbox/request/artifact/checkpoint/graph/work schema, K6 knowledge index/cursor tables và indexes |
| `src/state/store.ts` | Atomic writes, request results, event/graph queries, artifact/checkpoint foundation, writer lock/read-only handles |
| `src/state/graph.ts` / `graph-tool.ts` | Scoped exact-byte identities, typed validated batches/provenance/revision pins, bounded JSON/Mermaid và read-only snapshot/tail rebuild |
| `src/state/registry.ts` | Bind đúng một owner adapter cho alias `.sqlite`; không suy ra adapter từ filename |
| `src/state/adapter.ts` | TaskBoard/EvidenceStore/report đọc cùng SQLite, không ghi thêm JSONL; đọc qua snapshot bất biến của ledger incremental (`AssessmentStore.recordsSince`), bằng `indexRecords(store.records())` |
| `src/records.ts` | Chung integrity validator cho v2 JSONL và canonical projection (`indexRecords` một lần hoặc `IncrementalLedger` append-only); ACK bổ sung sequence/store version |
| `src/report.ts` | Whole-report redaction rồi framing/hashing; packet parts/manifest; host-generated idempotent IDs |
| `src/tasks.ts` | Existing TaskBoard + structured matching/current pins; `handoff()` commit report/task/coverage/open/phase cùng packet; không tự review |
| `src/work.ts` / `work-tool.ts` | Host-bound work fingerprint, output/disposition schemas, bounded model tool contract |
| `src/planning.ts` / `phase.ts` | Owner goal/todo/decision notes + immutable host phase card trên canonical records, không competing queue |
| `src/artifacts.ts` / `src/process.ts` | Host-only bounded raw prefixes trước display cap; metadata-only receipts; disposal/partial/redaction-prefix handling |
| `src/ledger-memo.ts` | Cache dẫn xuất theo mảng `records` của snapshot (task heads/revisions); thuần, tự bỏ nếu mảng dài thêm |
| `src/board.ts` | `LedgerBoard`: hàng đợi mutation tuần tự dùng chung cho TaskBoard/PlanBoard/CaseBoard/CoverageBoard — mỗi mutation đọc một index đầy đủ và kiểm authority trước **và** sau khi đọc; board con chỉ thêm frontier và record của riêng nó |
| `src/validate.ts` | Validator đầu vào dùng chung: `CONTROL` (một dòng) và `TEXT_CONTROL` (văn bản nhiều dòng) cùng từ chối C0/DEL/C1 và bidi override, `sha256Hex`, `plain`/`exact`, `fieldValidators(noun)` |
| `src/schema-kit.ts` / `src/tool-schemas.ts` | `choices()` khai báo enum thành `{type:'string', enum}` thay vì `anyOf` của `const` (nhỏ hơn mỗi lượt và provider không hỗ trợ `anyOf/const` vẫn dùng được); schema tham số của các tool còn lại nằm ở `tool-schemas.ts` (plan/case/coverage/graph giữ ở `*-tool.ts` cạnh validator) |
| `src/context.ts` | Deterministic record→knowledge-head descriptor và passive checkpoint+tail index audit; không I/O, không authority. Xem [K6 context packets](CONTEXT_PACKETS.md) |

API trên là **host service**, không generic model SQL/filesystem tool. Extension đã bind một owner backend ở new run boundary; ticket dùng `control/records.sqlite` làm alias không-file, còn DB thật nằm trong knowledge root. Worker startup/notes/handoff gửi qua authenticated broker. Actor/role/depth/task do owner registry gắn, không lấy quyền từ payload. Graph batch schema và host/broker role gates đã nối qua `p2o_graph`; reporting read-only. Xem [contract graph K3](ASSET_GRAPH.md); host/runtime/actual-Pi/Docker fixtures có qualification scopes riêng.

`bindAssessmentStore(alias, store)` chỉ hoạt động khi host đã tạo/mở handle. Alias không phải file replica hay usable authority. Sau unbind, `.sqlite` alias bị từ chối, không fallback sang `appendFile()` để tạo JSONL thứ hai.

### Commit, ACK và delivery

1. Validate same-run IDs, owned task revisions, references và bounds.
2. BEGIN IMMEDIATE; ghi domain rows + event sequence + outbox + request result.
3. COMMIT; phát process-local UI hints; trả committed IDs/sequence.

ACK canonical: `{recordId, version:2, sequence, storeVersion:6}`. ACK legacy v2 chỉ là append ID, không được nhận thêm fsync/sequence claim.

Request identity `(run, actor, requestId)` nằm trong namespace store/run. Same key/same canonical payload trả kết quả gốc; different payload báo `IDEMPOTENCY_CONFLICT`. Key order không làm payload khác nhau. Request hash dùng HMAC key private; key không vào checkpoint/report và không cấp target authority.

Host-generated UUID/timestamp chỉ tạo **sau** request lookup. `persistReport()`/`TaskBoard.handoff()` bind logical report, actor, run, task và metadata vào payload; lost ACK không tạo report parts mới.

Subscriber có thể lỗi/drop/duplicate. Outbox/events vẫn còn; callback lỗi không rollback/mask commit. Replay idempotent không phát lại semantic effects. UI hints và Engine semantic wake vẫn là hai consumer khác nhau; store không tự gọi Planner.

**Không có exactly-once target execution.** Nền tảng này chỉ idempotent domain writes. Không được dùng request key để tự replay POST/shell/network. Host operation IDs nối requested/started/returned/failed/cancelled/unknown-terminal với actor/task/receipt trong runtime. `started` là executor dispatch, không remote success; cancellation không đảm bảo rollback. Giữ unknown outcomes và không tự replay. `receiptOnly` broker connection chỉ query retained mutation ACK (note/start/report/graph) trên registry hiện sống; không command, mutation, budget renewal hay restored ticket authority. Mất socket bình thường vẫn revoke worker; đóng ACK-only reader không revoke active worker khác.

### Handoff và completion axes

`TaskBoard.handoff()` dùng chính task IDs/revisions hiện có:

- running assigned worker → report packet + task `reported`;
- reserved worker chưa investigation → task `blocked`, giữ report/gap để owner review;
- coverage/open entries chỉ được thêm một lần trong canonical transaction;
- handoff ID nối task với normalized report; `phasePacketId` nối immutable delivery card;
- phase card/counts/required-output contract giữ pending owner review; provider-error/reportless fallback không thêm model turn;
- wrong assignee/stale revision/inactive owner bị từ chối;
- không auto-accept receipts, không auto-review/close task/candidate/goal.

Extension callback đã gọi `handoff()` trực tiếp, không swallow task-transition failure hoặc append coverage/open ngoài transaction. Authenticated replay trả ACK gốc; notification/semantic wake không lặp. Native service fault tests và Unix-broker runtime tests có scopes riêng, không đồng nghĩa installed/paid-provider acceptance.

## Artifact/checkpoint contract hiện có

### Artifacts

- Host ingest bounded text bytes, mặc định redacted; không nhận arbitrary host path.
- Kind/media type/producer/operation/evidence refs/captured input range/total bytes/size/hash được giữ; scratch source giữ path/root/stat/hash/stable.
- `sha256` là hash **retained redacted bytes**. `beforeRedactionSha256`/`hashScope` chỉ hash captured prefix trước redaction, không toàn output; pre-redaction hash vẫn có thể nhạy cảm qua dictionary matching. Không tuyên bố manifest hết secret.
- Media type hiện chỉ `text/plain|application/json`; binary/no-redaction không được mở mặc định.
- Retrieval theo opaque artifact ID và byte range; verify toàn retained object trước trả range.
- File có thể bị host cùng UID sửa/xóa; hash/missing check phát hiện và không báo complete.

**Đã nối checkout:** `runFixed` gọi trusted host `onOutput` trước 48 KiB display cap; Sandbox shell/net/curl truyền đúng target streams (không infrastructure stdout). Operation sở hữu `OutputCapture`, tổng used prefix bytes ≤ configured bound, fixed buffers tránh descriptor growth cho endless/tiny chunks; allocation tối đa 2×bound, chưa disk spill. Raw bytes chỉ ở host memory, không gắn vào serializable process/broker result; zero trong finally. Store redact toàn prefix trước file publication, gồm cut-off PEM private key và scratch boundary context (`redactionVersion:3` cho artifact mới); retained artifact v1/v2 giữ nguyên metadata/bytes, không migrate/redact lại. Post-redaction byte cap không cắt codepoint UTF-8; raw-prefix decode loss vẫn label riêng. Hai streams giữ order riêng; HTTP capture nối các hop, không đồng nghĩa last response excerpt. Empty runner thật được announce; custom runner không observe được label unavailable, không reconstruct từ excerpt.

Owner/broker result + evidence receipt + operation event giữ artifact IDs/counts/hash/partial, không raw buffers. Normal return, cancellation và runner failure có capture outcomes riêng; interrupted prefix không khẳng định toàn stream/remote rollback. Known executor return + ingest failure giữ retention-incomplete return, revoke ngay, không target retry. Quota/publish/commit fault có thể để private orphan như contract chung; không fabricated pointer.

`p2o_capture` đọc file text trong scratch đã cấp qua fixed isolated Python FD reader: pin ancestor `O_DIRECTORY|O_NOFOLLOW`, file single-link regular `O_NOFOLLOW|O_NONBLOCK`, UTF-8 prefix, `st_dev/ino/size/mtime/ctime/nlink` before+after → `stable`; `offset` (0..1 GiB) đọc segment tiếp theo bằng `lseek` nên file dài được giữ thành nhiều artifact ≤8 MiB, mỗi artifact có `offset`/`capturedBytes`/`prefixSha256` riêng; offset bắt đầu giữa ký tự UTF-8 và offset vượt EOF bị từ chối. Reader mới chỉ emit prefix gồm codepoint đầy đủ: có thể giữ ít hơn bound ≤3 bytes; tiếp tục bằng `offset + capturedBytes`, không `offset + configured cap`. Bound không đủ một codepoint → `UTF8_BOUND_TOO_SMALL`, EOF invalid UTF-8 vẫn bị từ chối; không success 0 byte/no-progress cho file chưa EOF. Từ chối symlink/hardlink/FIFO/device/directory/binary/missing và path ngoài root/cap. Store chỉ nhận provenance khi `root` khớp producer (`/work` cho owner, `/work/<workerId>` cho worker), `capturedBytes`/`totalBytes`/`prefixSha256` khớp bytes. Nội dung file không bao giờ thành shell/code; argv chỉ JSON. Empty file được giữ thành artifact 0 byte; deny hoàn tất không hủy executor, còn lỗi transport/cancel/protocol thì retire executor và không tự đọc lại. Preview trả model là bản redacted ≤8 KiB, không raw.

Scratch protocol mới **v2** thêm flags-only `redactionContext`: tối đa 8192 preceding bytes đọc qua pinned FD, leading-line fragment và private-key ancestry `none/open/unknown`; lookahead ≤128 bytes **đã capture** chỉ để nhận marker nằm ngang offset, không tăng bound. Preceding bytes không gửi/giữ trong metadata. Segment bắt đầu giữa credential/header line bị thay first fragment bằng marker; known open PEM continuation bị redact qua END marker. Ancestry ngoài bounded context label unknown, suppress base64-compatible lines và mark partial, không đoán secret-free. Legacy snapshot v1 vẫn inspect được; nonzero offset thiếu context dùng conservative unknown handling. File thay đổi vẫn partial, flags không chứng minh atomic/current snapshot.

| Bound/behavior | Default | Min | Max / semantics |
|---|---:|---:|---|
| Segment offset | 0 | 0 | 1 GiB, host/path admission không đổi |
| Redaction preceding context | fixed 8192 bytes | 0 khi offset 0 | min(offset,8192), không model/operator override |
| Crossing-marker lookahead | ≤128 captured bytes | 0 | 128, không thêm source read |
| UTF-8 trailing trim | automatic | 0 | 3 bytes; next offset theo capturedBytes |

Artifact **byte ranges** có thể cắt codepoint khi offset/length arbitrary; snippet decode có thể có replacement character. Điều đó khác retained bytes bị lossy: `artifactBytes`/portable export giữ verified bytes; ranged snippet không phải byte-exact full decode.

`p2o_artifact` đọc same-run IDs/ranges qua authenticated knowledge channel, reporting-role cũng được đọc; không target command allowance hoặc durable writes. Model default/max 8 KiB giữ JSON escaped worst-case trong 64 KiB broker frame. Public tool `id` map sang domain `artifactId`; RPC envelope `id` dành cho correlation, không trộn identities. Stopped/revoked/receipt-only/history không cấp thêm authority.

**Finalization reserve:** ordinary artifact/record writes dừng trước `finalizationReserve` (`max(256 KiB, min(4 MiB, quota/16))`); chỉ final outcome/`run.stopped` và explicit checkpoint được dùng phần chừa. Health trả `finalizationReserveBytes`; quota không tăng. Nếu snapshot cuối không thể ghi trong quota/physical capacity, checkpoint fail rõ và assessment giữ `incomplete`/retention failure — không hứa điều vượt bound.

**Đã có:** bounded portable bundle mang verified artifact bytes. **Chưa có:** disk spill và general sensitivity/raw opt-in. Boundary/context redaction không bảo đảm nhận diện mọi encoding/format/context ngoài bound; foreign preserved bytes không được coi secret-free. Để không mất plain-text first-line fragments, chọn segment tại newline/UTF-8 boundary; không có raw-secret bypass. Không thể cứu bytes baseline đã bị truncate chỉ bằng registry mới.

### Interruption reconciliation (historical knowledge only)

- `interruptedState()` chỉ đọc: task `reserved|running` (kèm revision), operation `requested|started|unknown-terminal`, worker IDs đã từng ghi, pending reviews, và reconciliation record mới nhất.
- `reconcileInterruption(actorId, reason)` append **một** `lifecycle` record có `data.reconciliation` (`asOfSequence`, `by`, `reason` đã redact, danh sách ID cap 100, `authorityRestored:false`, `resume:false`). Không tạo task revision, không đổi status, không ghi ticket/socket/cookie/queue, không tăng allowance.
- Human `/p2o reconcile <run-id> [reason]` yêu cầu không có active run, preview counts rồi confirmation; live writer bị SQLite từ chối (không đoán stale lock), unknown schema bị từ chối, và store được mở lại read-only sau khi ghi.
- Đây là **evidence của gián đoạn**, không phải currentness/proof: candidate/evidence gate vẫn cần receipt của chính run hiện tại.

### Portable bundle (export/import)

```text
<absolute host dir>/
  manifest.json                     (index; written last)
  segments/records-NNNNN.ndjson     ≤4 MiB/segment
  segments/events-NNNNN.ndjson      ≤4 MiB/segment
  segments/graph-NNNNN.ndjson       ≤4 MiB/segment (bundle v2)
  .p2o-knowledge-bundle / .npmignore (owner export/source/pack protection)
  artifacts/artifact-<id>.txt       ≤8 MiB/artifact
```

- Tổng ≤64 MiB và ≤4096 file; manifest ≤1 MiB; `bundleSha256` là hash canonical của run/createdAt/counts/files, không phải hash toàn directory.
- Export chỉ nhận absolute host path **ngoài** private state root, từ chối destination đã tồn tại; ghi vào temp dir 0700 → fsync FD directory → `rename`. Manifest ghi sau cùng nên bundle dở dang không có index (`Bundle manifest missing or oversized`).
- Bundle v2 thêm typed graph history/provenance segments; v1 vẫn inspect/import được. Mỗi file có bytes+SHA256; export dùng host-only verified artifact bytes (không decode/re-encode independent ranges); `inspectBundle` trả `missing`/`tampered`/`extra` và `integrityStatus`; manifest sai hash được báo tampered, không silent accept.
- File entry phải match `segments/(records|events|graph)-NNNNN.ndjson` hoặc `artifacts/artifact-<uuid>.txt`; traversal/tên khác bị từ chối; counts phải khớp số file và tổng bytes.
- Import: verify toàn bộ trước, mở từng file `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, kiểm tra regular/single-link/size rồi mới đọc, hash lại lần nữa; đổi sau verify ⇒ từ chối. Bytes lưu bằng `preserveBytes` **chỉ khi** có provenance `importedFrom` hợp lệ (`hashScope: preserved-exported-bytes`), không redact lại.
- Import tạo artifact bất biến + **một** note record (refs tới artifact IDs) chứa `bundleSha256`/counts/integrity; import cùng bundle lần hai bị từ chối; file ngoài index không được import (chỉ báo `extras`).
- Imported knowledge **không** là same-run evidence, không resolve open item, không tạo writable graph heads/ticket/worker/scope/budget/authority, và vẫn chịu quota + finalization reserve của run nhận. Foreign hash/redactionVersion không authenticate secret-free bytes; cần operator review.
- Còn thiếu: disk spill, archive segmented >64 MiB, re-ingest theo typed domain (K3–K5) và currentness review tự động sau import.

### Checkpoints

Snapshot tạo tại transaction boundary `S`, chứa manifest, records, events, artifact manifests và graph revisions/provenance (scope/identity version/hash/head counts). Checkpoint event/pointer commit sau publish/fsync snapshot; crash/fault trước pointer không tạo checkpoint thành công. Idempotent request trả checkpoint gốc.

Manifest giữ source run/target identity, `asOfSequence`, reason, hash/bytes, integrity, missing refs, omissions, pending handoff reviews, open gaps, in-flight operations, artifact refs, retention label và planning/phase counts/pending phase IDs. Snapshot **không chứa** usable execution authority hay request replay state.

- Snapshot `<=S` + event tail `>S` đã được kiểm thử không bỏ/nhân event; `applyGraphEvents` rebuild graph tương đương canonical state, reject foreign run/scope, không hồi execution authority.
- `dataStatus` riêng với hash `integrityStatus`: capture truncated/interrupted/lossy, unavailable runner hoặc in-flight/unknown operations làm data partial. Compatible old snapshot thiếu field được label unknown, không upgrade thành full capture.
- Integrity và `changed-since-checkpoint` tách biệt; đây chưa phải đầy đủ support-currentness của K5.
- Interrupted/in-flight không bị gọi returned/success chỉ vì có checkpoint.
- Missing/tampered artifact/snapshot làm inspection partial.
- File publish xong nhưng DB commit lỗi có thể để orphan private file. Không có committed pointer; file vẫn tính quota. Không tự delete/repair để giả successful checkpoint.

Human checkpoint/list/inspect/open/recover/close đã nối; durable cleanup tạo final checkpoint sau revocation/cancellation/resource verification. Recovery dùng explicit confirmed infrastructure writer, không Engine/target restore. K4 đã thêm goal/todo/decision records và phase/checkpoint cards; [contract và gates](WORK_ADMISSION.md). **Chưa có:** segmented portable snapshots khi vượt 64 MiB, legacy/domain import, full proof-aware coverage/review heads K5 và typed incremental branch-output contract acceptance.

## Default/min/max — API host và runtime checkout

| Giới hạn | Default | Min | Max / semantics |
|---|---:|---:|---|
| `maxBytes` store | 256 MiB | 8 MiB | 1024 MiB; physical private-file usage + conservative journal/growth reserve |
| Artifact capture/object | 1 MiB | 1 byte | 8 MiB; redaction/capture truncation được label |
| Finalization reserve | quota/16 | 256 KiB | 4 MiB; chỉ outcome/final checkpoint được dùng |
| Scratch segment offset | `0` | `0` | 1 GiB; `offset+capturedBytes` phải ≤ file size |
| Bundle segment | — | 1 byte | 4 MiB/segment; line lớn hơn bị từ chối |
| Bundle tổng | — | — | 64 MiB và 4096 file; index ≤1 MiB |
| Artifact host/human returned range | 16 KiB | 1 byte | 48 KiB |
| Model `p2o_artifact` range | 8 KiB | 1 byte | 8 KiB; bound JSON escaping trong broker frame |
| Runtime prefix stdout+stderr/operation | 1024 KiB | 1 KiB | 8192 KiB; allocation ≤2×bound, no disk spill |
| Record packet | — | 1 row | 128 rows; mỗi row ≤16 KiB |
| Idempotency canonical payload | — | — | 128 KiB |
| Record payload/run | — | — | 64 MiB / 100000 rows; observable backpressure |
| Checkpoint snapshot | — | — | 64 MiB; vượt bound lỗi rõ, không silently omit |
| Event query page | 20 | 1 | 100 và ≤48 KiB response rows |
| Private file count/run | — | — | 4096 |
| Writer/assessment/worker TTL | Không | — | Không thêm elapsed deadline |

SQLite database page cap dành tối đa khoảng 1/3 `maxBytes`; phần còn lại cho rollback journal và retained files. Vì overhead/reserve, usable domain capacity không bằng full quota. Disk full/quota failure không tự tăng allowance hay retry target.

Checkout runtime đã đọc `retention` (default durable-local), `storageQuotaMiB` (256, min 8/max 1024) và `--retention durable-local|ephemeral`. Luôn confirm trước store creation; default root `<cwd thực>/.p2o-state`, ephemeral trong disposable control. `artifactCaptureKiB` (1024, min 1/max 8192) đã nối pre-truncation prefix capture và per-object ingest cap; visible output vẫn 48 KiB. Retained redaction có thể tăng byte count và chạm object cap riêng, phải báo partial. Chi tiết ở [Usage](USAGE.md).

## Migration/rollback map

| Input | Hành vi hiện tại / gate còn lại |
|---|---|
| Legacy v1/v2 JSONL | Reader cũ vẫn chạy, cùng integrity checks; không tự migrate sang SQLite |
| `note/observation/coverage/open` prose | Giữ unstructured claims; không tự tạo observed facts/accepted cells |
| Task/evidence/candidate v2 | IDs/revisions và same-run receipt gates được giữ qua adapter; không phục hồi live assignments |
| Normalized report parts/manifest | Giữ framing/hash sau whole-payload redaction; không redact lại fragment để làm hỏng bytes |
| Schema 7 compatible store | Human `open <run-id>` read-only; graph/history/knowledge heads available, không Engine/scope/worker/request replay |
| Prior schema 3/4/5/6 | Metadata-only historical inspection; domain queries/writer denied, không migrate in place. Store schema 6 từ checkout trước K6 **không** còn mở được như compatible store |
| Unknown schema (fixture 77) | Writer từ chối; metadata-only read-only health; không rewrite/delete/migrate |
| Killed uncommitted transaction | Explicit **infrastructure writer** reopen để SQLite rollback; không tạo Engine/ticket/worker; reader sau đó thấy prior commit |
| Hot rollback journal cần recovery | Human `recover <run-id>` cần confirmation; infrastructure writer rollback rồi read-only open; active writer/unknown schema bị từ chối, không hồi authority |
| Rollback package | Stop execution; giữ new store read-only; baseline/new run cần confirmation mới; không mở schema mới bằng JSONL fallback |

Portable bundle byte/hash/provenance và attributed interruption reconciliation đã nối. Legacy/domain import, broader path/byte/privacy/partial-import qualification và segmented archives vẫn là K2 work; historical UI label interrupted/unknown, không rewrite task states. Không copy historical receipt vào run mới để vượt same-run evidence gate.

## Reproduce và kết quả source qualification

```sh
npm run build
npx vitest run tests/minimal/assessment-store.test.ts tests/minimal/state-adapter.test.ts
npx vitest run tests/minimal/artifacts.test.ts tests/minimal/scratch.test.ts tests/minimal/workspace-runtime.test.ts
P2O_TEST_DOCKER=1 npx vitest run tests/minimal/artifacts-docker.test.ts tests/minimal/docker-extension.test.ts tests/minimal/isolated-docker.test.ts
node scripts/check-assessment-store.mjs --source
npm exec --offline --package=node@22.19.0 -- node scripts/check-assessment-store.mjs --source
node scripts/check-assessment-store.mjs --records=10000
node scripts/check-assessment-store.mjs --records=100000
node scripts/check-assessment-graph.mjs --source
node scripts/check-assessment-graph.mjs --assets=4000
```

Fixtures private/disposable, chỉ native Node/SQLite; không target/provider traffic, Docker, paid models, reference execution hay authority replay. Node 22 binary phải có trong local npm cache cho lệnh offline; không suy ra mọi installation đã có nó.

Jiti/source TS đã chạy trên Node **22.19.0 / SQLite 3.50.4** và **24.19.0 / SQLite 3.53.4**. Node 22 có experimental SQLite warning.

Measurements **lịch sử schema 3, không requalify K4/schema 6/7/UI/context bằng các số này** (microbench K6/schema 7 riêng ở [CONTEXT_PACKETS.md](CONTEXT_PACKETS.md#verification-scope)), native ESM trên Linux x64, Intel i7-1355U, 12 logical CPUs, RAM 33.3 GB; deterministic inert notes/events, 100 rows/commit:

| Corpus | Commit batch p50/p95 | Event page p50/p95 | Checkpoint | RSS sau inspect | Private bytes |
|---|---|---|---|---|---|
| 10k records/events | 12.40 / 14.30 ms | 0.78 / 1.28 ms | 55.80 ms | 128950272 | 12498368 |
| 100k records/events | 16.66 / 25.84 ms | 10.27 / 13.49 ms | 497.84 ms | 435515392 | 131740434 |

Event query trả 20 rows, **exact total**, không tính total từ tail. Đây là single local runs, không performance guarantee, không p95 status/render hoặc K6 acceptance: adapter TaskBoard/UI vẫn rebuild full record index; checkpoint synchronous/RSS còn cần tối ưu/segmentation. Không gọi finding correctness, gap recall hay cost savings là đã đo.

Fault matrix gồm before commit, after commit/ACK loss, checkpoint/artifact publish faults, `SQLITE_FULL`, quota exhaustion, SIGKILL, writer conflict, unknown schema, symlink/hardlink/renamed-directory, corrupt/missing bytes và observer failure. Toàn runtime/native/Docker matrix cần requalify khi backend được nối.
