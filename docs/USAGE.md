# Usage

For on-demand skills, workflow prerequisites, proof-level records and `--export`, see [skill runtime](SKILL_RUNTIME.md).

Install with `pi install https://github.com/Nhan-Laptop/pi-p2o`, then `/reload`.
Start Docker and pull the pinned image listed in the README once. No source build is required in an installed copy.

```text
/p2o --target ./source
/p2o --target https://example.com
/p2o --target ./source --workers 2
/p2o --target ./source --loop event-driven --executors isolated --target-ops 2

/p2o pause
/p2o resume
/p2o stop
```

One dialog confirms ownership/permission, scope, sandbox limits, the worker plan, extra event-driven model rounds
when requested and isolated executor resource multiplication. Manual + shared is default; see [Engine contract](PLANNER_ENGINE.md). In delegated mode the current Pi plans/reviews and cannot execute target commands; solo investigates. Declining starts no sandbox, worker or model turn.

For source: a regular-file-only copy at `/target` is read-only (≤64 MiB / 20000 entries; symlinks, special files,
`.git` and `node_modules skipped`), `/work` is writable scratch. Commands run through `p2o_shell`, never host shell.
For web: `p2o_http` sends any HTTP method with headers, cookies and a bounded body to the confirmed origin, resolving
and pinning the destination per hop and stopping before any redirect leaves that origin. `p2o_net` runs network commands
(connect scans, probes, user-space tool installs) in the same container, with unrestricted egress, not an origin firewall. A GitHub URL does not clone source. See [HTTP/session/network details](HTTP_TRANSPORT.md).

The lead calls `p2o_finish` before its report; that refuses until every worker has reported or been stopped, then
removes the sandbox, verifies container removal with the daemon, and reports how many worker panes Herdr actually
closed (a pane it refuses to close is named, and by then that worker's ticket is already revoked). `/p2o stop` cancels manually and does the same.

## Giải thích cấu hình: loop, workers và executors

Các option loop/executor dưới đây có từ baseline **0.5.0** (`e639029`). Nhãn **K1–K6** đánh dấu phần thêm sau baseline: đã nằm trong `main` từ `7e204c3` nên `pi install`/cập nhật lấy về, nhưng `package.json` vẫn 0.5.0, chưa có release riêng và installed acceptance mới là 6 test inert ([chi tiết](KNOWLEDGE_WORKSPACE.md)). Các gate K0–K7 chưa hoàn tất.

### Đọc một lệnh hoàn chỉnh

```text
/p2o --target ./source --loop event-driven --executors isolated --target-ops 2
```

| Thành phần | Ý nghĩa |
|---|---|
| `--target ./source` | Kiểm tra source code trong thư mục `./source`, tính từ thư mục làm việc của Pi. Thay bằng đường dẫn repo thật của bạn. Có thể dùng URL HTTP(S) thay thư mục. |
| `--loop event-driven` | Cho phép hệ thống tự gọi Planner tiếp khi có sự kiện phù hợp đã commit, như worker report hoặc subtask proposal. Không cần nhắn “tiếp tục” mỗi vòng; có thể phát sinh phí model. |
| `--executors isolated` | Mỗi assignment của worker có sandbox riêng, scratch/cookie state riêng. Tốn tài nguyên hơn shared; hủy một assignment không xóa sandbox của peers. |
| `--target-ops 2` | Tối đa 2 thao tác target được broker cho workers thực thi đồng thời, chẳng hạn shell/net/HTTP. Không phải 2 workers, 2 model requests hay 2 vòng Planner. |

Bốn lựa chọn này độc lập về mục đích: **target = kiểm tra gì; loop = khi nào Planner tiếp tục; executors = chia sandbox thế nào; target-ops = mức đồng thời của thao tác thực thi**.

### Mặc định, min và max của các option

Các mặc định dưới đây là **package defaults khi chưa override settings**. `MAX_SAFE = 9007199254740991` (`Number.MAX_SAFE_INTEGER`) là giới hạn parser của số nguyên JavaScript, **không phải mức tài nguyên khả thi hoặc khuyến nghị**.

| Option lúc start | Mặc định | Min | Max / giá trị hợp lệ | Ghi chú |
|---|---|---|---|---|
| `--target <path-or-url>` | Không có; bắt buộc khi start | Một target không rỗng | Một thư mục local hoặc URL HTTP(S); chuỗi tối đa 4096 ký tự | Đặt `--target` trước các option khác; quote đường dẫn có dấu cách. Các scope/source limits vẫn áp dụng. |
| `--workers N` | `3` | `1` | `MAX_SAFE` | Cap workers đồng thời, không phải tổng assignments. `0` không hợp lệ; dùng `--solo` hoặc `--max-depth 0` để tắt delegation. |
| `--loop MODE` | `manual` | Không áp dụng | `manual` hoặc `event-driven` | Event-driven cần Herdr delegation đang khả dụng và consent lúc start. |
| `--executors MODE` | `shared` | Không áp dụng | `shared` hoặc `isolated` | Shared tuần tự; isolated tách executor theo assignment. |
| `--target-ops N` | Shared: **1**; isolated: **3** | `1` | Shared: **1**; isolated: `MAX_SAFE` | Truyền `--target-ops 2` với shared sẽ bị từ chối; muốn lớn hơn 1 phải chọn isolated. |
| `--max-depth D` | `2` | `0` | `3` | `0` tắt delegation. Hiện delegation là flat: 1, 2 hoặc 3 không cấp quyền cho workers tự spawn children. |
| `--solo` | Không bật | Không áp dụng | Flag không nhận giá trị | Pi hiện tại trực tiếp điều tra, không spawn workers. Phải dùng loop manual. |
| `--export` | Không bật | Không áp dụng | Flag không nhận giá trị | Lưu bounded redacted ledger/export lúc cleanup vào `.p2o-reports/`; không phải checkpoint giữa run. |
| `--retention MODE` (**K2**) | `durable-local` | — | `durable-local`, `ephemeral` | Luôn hiển thị trong confirmation; không tạo store trước consent. |

Số N/D phải là số nguyên trong khoảng cho phép; CLI không chấp nhận số âm, số thập phân hoặc từ `unlimited`. Không có `--min-workers`, `--max-workers` hay `--max-planner-rounds`: dùng `--workers` cho concurrency; `maxPlannerRounds` là **settings-only** như phần dưới.

`--target-ops` là **trần**, không bảo đảm luôn có đủ việc chạy hoặc tương đương tổng TCP connections/requests mà một shell command có thể tạo. Một command có thể tự chạy nhiều subprocess/network requests. Semaphore này không phải rate limiter hay egress firewall. Trong solo mode, target tools dùng sandbox chính tuần tự; chọn isolated không tự tạo parallel solo agents.

### Manual và event-driven khác nhau thế nào?

| | `manual` | `event-driven` |
|---|---|---|
| Worker gửi report khi Planner đang idle | Không tự gọi model; bạn tương tác để Planner review tiếp | Có thể tự gọi Planner nếu event hợp lệ, chưa pause/stop và còn allowance |
| Task đã được Planner dispatch | Engine vẫn tự admit khi slot/prerequisite cho phép | Tương tự |
| Periodic model polling/heartbeat | Không | Không |
| Cần Herdr | Không; không có delegation thì làm solo | Có delegation khả dụng; không dùng với `--solo` hoặc `--max-depth 0` |

**Manual không có nghĩa phải launch từng worker bằng tay.** Engine vẫn thực hiện hàng đợi đã được chấp nhận. Khác biệt là quyền tự bắt đầu **vòng Planner mới**, không phải việc có Engine hay không. Bất kể mode, start đã xác nhận vẫn gửi kickoff cho Pi hiện tại.

**`p2o_loop` là tool cho Planner, không phải slash command hay công tắc bật event-driven.** Các tool calls tương ứng:

```text
p2o_loop {"action":"status"}
p2o_loop {"action":"wait","reason":"Đang chờ report từ các workers đã giao việc"}
p2o_loop {"action":"blocked","reason":"Thiếu prerequisite; cần người dùng xử lý trước"}
```

Bạn có thể yêu cầu Planner dùng các tool này; không gõ `/p2o_loop`. `wait` kết thúc vòng planning hiện tại, không kết thúc assessment. Trong manual mode nó không tự cấp quyền wake. `blocked` pause dispatch/automatic wakes, cần human `/p2o resume` khi đã xử lý được blocker.

Task review/revise do Planner thực hiện sẽ kick Engine để xét lại readiness; không phải mọi task/note mutation đều tạo thêm một paid Planner round. Report/proposal được coalesce; event không bảo đảm wake nếu human input đang chờ, run đã pause/stop hoặc allowance đã hết.

### Shared và isolated: ví dụ 3 workers, 2 target operations

```text
/p2o --target ./my-repo --workers 3 --loop event-driven --executors isolated --target-ops 2
```

- Tối đa **3 worker agents** cùng làm việc, mỗi assignment có executor riêng.
- Worker A và B có thể đang thực thi; thao tác của C chờ target-operation slot.
- Các agents không bị giới hạn chỉ còn 2 model requests bởi `--target-ops`. Chúng có thể suy luận/ghi kết quả khi không chờ tool của chính mình; worker đang đợi một tool call hoàn tất thường phải đợi result đó để tiếp tục.
- Report được commit có thể đánh thức Planner; logical worker capacity chỉ tái sử dụng sau verified retirement. Assignment sau dùng process/session/ticket mới.
- Isolated tăng resource envelope: mỗi container có limit 2 GiB RAM/2 CPUs, còn có sandbox chính và HTTP containers. Đây là per-container limits, không phải tổng 2 GiB cho run.

Với **shared**, workers dùng chung executor tuần tự. Hủy/timeout shell có thể phá shared sandbox và ảnh hưởng peers. Isolated giảm ảnh hưởng đó, nhưng không mở rộng scope hoặc tăng command allowance.

### Các cấu hình dễ chọn

**1. Tiết kiệm tài nguyên, tự tương tác để Planner tiếp tục:**

```text
/p2o --target ./my-repo --loop manual --executors shared
```

**2. Tự tiếp tục sau report, vẫn thực thi tuần tự:**

```text
/p2o --target ./my-repo --loop event-driven --executors shared
```

**3. Tự tiếp tục, tối đa 3 workers và 2 thao tác target đồng thời:**

```text
/p2o --target ./my-repo --workers 3 --loop event-driven --executors isolated --target-ops 2 --export
```

**4. Không dùng workers/Herdr:**

```text
/p2o --target ./my-repo --solo --loop manual --executors shared --export
```

Ghi rõ mode trong ví dụ để không phụ thuộc settings riêng đã đổi trước đó. Không cần dùng max parser để có parallelism; bắt đầu với 2–3 workers và 1–2 target operations rồi cân nhắc RAM/CPU/provider cost.

### Đổi mặc định trong settings

File runtime đọc mặc định: `~/.pi/agent/settings.json`. **Merge phần `p2o` vào file hiện có**, không ghi đè các packages/providers/settings khác:

```json
{
  "p2o": {
    "maxWorkers": 3,
    "maxDepth": 2,
    "loopMode": "event-driven",
    "maxPlannerRounds": 100,
    "executorMode": "isolated",
    "maxTargetOperations": 2
  }
}
```

Với cấu hình này, `/p2o --target ./my-repo` dùng event-driven/isolated/3 workers/2 operations. Nếu không có Herdr delegation, start bị từ chối vì event-driven; dùng ví dụ solo/manual ở trên. Hộp xác nhận vẫn xuất hiện — settings không thay consent.

| Setting dưới `p2o` | Package default | Min | Max / giá trị |
|---|---|---|---|
| `maxWorkers` | `3` | `1` | `MAX_SAFE` |
| `maxDepth` | `2` | `0` | `3` |
| `loopMode` | `manual` | — | `manual`, `event-driven` |
| `maxPlannerRounds` | `100` | `1` | `MAX_SAFE`; không có giá trị `0 = unlimited` |
| `executorMode` | `shared` | — | `shared`, `isolated` |
| `maxTargetOperations` | `3` | `1` | `MAX_SAFE`; **shared luôn ép effective cap về 1** |
| `retention` (**K2**) | `durable-local` | — | `durable-local`, `ephemeral` |
| `storageQuotaMiB` (**K2**) | `256` | `8` | `1024`; private bytes + conservative journal/growth reserve; artifact/record thường dừng trước `finalizationReserve` để outcome/checkpoint cuối còn chỗ, usable payload nhỏ hơn quota |
| `artifactCaptureKiB` (**K2**) | `1024` | `1` | `8192`; tổng capture prefix stdout+stderr/operation trước display truncation, đồng thời là bound cho `p2o_capture`; visible cap vẫn 48 KiB |
| `toolGuidance` (**W3**) | `false` | — | `true`/`false`; bật lời khuyên quy trình knowledge gắn theo tool (`src/tool-guidelines.ts`). Đọc khi extension nạp: đổi xong cần `/reload`. **Mặc định tắt** vì benchmark cho thấy tăng chi phí ≈70% mà chưa tăng chất lượng (xem mục dưới) |

Precedence của option start: **CLI cho run đó → settings → package defaults**. `maxPlannerRounds` hiện không có CLI override (`--max-planner-rounds` bị parser từ chối). Settings được đọc khi start run mới, không hot-update run đang chạy. Numeric setting sai kiểu/ngoài khoảng quay về fallback của field; CLI sai thì báo lỗi, không tự clamp. Xem kỹ effective profile trong confirmation.

`maxPlannerRounds` đếm allowance cho automatic Planner wakes, **không phải tổng model turns, tổng tokens/cost hoặc TTL**. Worker turns và các inner tool/model turns vẫn tính riêng. Hết allowance thì Engine pause; `/p2o resume` không renew và sẽ từ chối khi allowance đã cạn. Manual review bằng tương tác vẫn có, nhưng không đồng nghĩa queue đã được unpause. Muốn đổi profile/allowance phải kết thúc run cũ và start run mới với confirmation; history không tự phục hồi authority.

### Pause, resume và stop

| Lệnh | Tác dụng |
|---|---|
| `/p2o pause` | Pause dispatch và automatic wakes; abort lượt Planner hiện tại. **Workers đã admit vẫn có thể tiếp tục và gửi report.** Không phải pause toàn bộ target execution. |
| `/p2o resume` | Mở lại scheduling/wakes của run hiện tại nếu allowance còn; giữ mode đã chọn lúc start. Không renew budget, retry failed task ngầm hoặc đổi manual thành event-driven. |
| `/p2o stop` | Revoke worker authority, cancel operations và cleanup; không cần đợi mọi task thành công. |
| `/p2o hold [lý do]` | **Giữ thao tác lên target** mà không kết thúc run: lệnh mới `p2o_shell`/`p2o_net`/`p2o_http`/`p2o_capture` của worker lẫn solo bị từ chối (`TARGET_OPS_HELD`, **không trừ allowance**), `p2o_delegate`/dispatch không launch worker mới (task đã accept vẫn nằm chờ, không bị bỏ). Lệnh **đang chạy hoàn tất** (không mất dữ liệu); lệnh đã xếp hàng chờ executor nhưng chưa bắt đầu cũng bị từ chối. Notes, `p2o_report`, cleanup và `/p2o stop` luôn mở. Không gọi model, không đổi scope/budget; Planner thấy `operatorHold` trong state. Chỉ người dùng gọi được: không có tool nào cho model. |
| `/p2o release` | Gỡ hold sau khi **xác nhận**; không renew budget hay scope. Task đã accept được admit lại. |
| `/p2o workers` | Bảng worker chỉ đọc: id, role, task, trạng thái, lệnh đã dùng/ngân sách, thời gian im lặng và cờ `QUIET` (quan sát cục bộ, không phải timeout, không kết luận worker chết, không đánh thức model). |
| `/p2o stop-worker <worker-id> [lý do]` | Rút **một** worker sau khi xác nhận: revoke ticket, hủy lệnh đang chạy, đóng pane, task chuyển `cancelled`. Cùng đường với tool `p2o_stop_worker` của model. Với executor shared, hủy lệnh đang chạy có thể ảnh hưởng peers (hộp xác nhận nói rõ). |

`pause`, `hold` và `stop` khác nhau: **pause** dừng lập lịch/wake và abort lượt Planner nhưng workers đã admit vẫn chạy lệnh; **hold** chặn lệnh target mới và launch nhưng giữ Planner, report và hàng đợi; **stop** kết thúc run. Hold trong lúc `/p2o stop` vẫn cleanup bình thường.

Worker/report/proof state vẫn cần review dù resources đã cleanup. Baseline 0.5.0 chỉ cho xem qua agent: yêu cầu agent dùng `p2o_loop {"action":"status"}` hoặc `p2o_workers` (vẫn dùng được ở chế độ delegated; ở `--solo` tool này không được bật, dùng `p2o_loop` hoặc lệnh `/p2o workers`). Từ `7e204c3` có thêm các human commands dưới đây, đã nằm trong bản `pi install` lấy về.

## Xem tiến độ trực tiếp — K1/K2

Các lệnh mới **không gọi model**, không thực thi target và không đổi mode/budget/authority:

```text
/p2o status
/p2o tasks
/p2o tasks live
/p2o tasks awaiting-review
/p2o tasks blocked
/p2o tasks done
/p2o tasks all 20
/p2o task <task-id>
/p2o log
/p2o log 0
/p2o log 20
/p2o report
```

- `status`: task counts, chờ review/blocker, loop/executor profile, allowances, retention và trạng thái reconciliation; **bảng worker** (live/quiet/reported/stopped, tối đa 12 dòng), `HOLD` nếu đang giữ, dòng `Runtime: p2o <version> · <12 hex> … tool guidance v<n>` (digest của entry file **và** toàn bộ `src/**` + version), `Planner context` (% và token theo `getContextUsage()` của Pi, `unknown` khi Pi không có; chỉ đo, p2o không tự compact/summarize) và **model usage** theo role (xem dưới).
- `tasks`: 20 tasks/trang; filter mặc định `all`; `done` chỉ có nghĩa task closed, không phải finding verified. Cursor min `0`, max là số tasks trong filtered snapshot; sau mutation, bắt đầu lại từ `0`.
- `task <id>`: câu hỏi, expected contrast, stop condition, receipts, prerequisites và tối đa 20 revision gần nhất.
- `log [cursor] [task=<id>] [actor=<id>] [operation=<id>]`: canonical typed checklog, tối đa 20 events/trang; bộ lọc dùng index sẵn có, total/omitted đúng **theo bộ lọc**, `Next:` mang theo bộ lọc, và bản mặc định có bộ lọc mở bằng các event khớp **mới nhất** (`log 0 task=…` để duyệt từ cũ nhất); id sai định dạng bị từ chối; bỏ cursor xem tail; `log 0` bắt đầu traversal. Cursor là committed sequence, không offset/timestamp; min `0`, max sequence hiện có; follow `Next`. Task/detail view vẫn dùng record exchange v2 từ cùng store.
- `report`: index các handoffs/candidate claims hiện có; không tự sinh final narrative hoặc nâng proof. `report export <absolute-dir>` ghi báo cáo tất định ra file (xem mục dưới).
- TUI có widget gọn và màn hình read-only; cuộn bằng ↑↓/PageUp/PageDown, đóng bằng Esc/q. RPC nhận text notification; không cần TUI custom screen.
- Widget chỉ quét ledger khi Pi chạy ở chế độ TUI; mỗi lần quét cách lần trước ít nhất `max(25 ms, 4× chi phí lần quét trước)`, tối đa 5 s, và không bao giờ gọi model. `status`/`tasks`/`report` đọc snapshot ledger tăng dần (không quét lại toàn lịch sử mỗi lần); refresh p95 đo được ≤114 ms ở 100k records trên corpus synthetic, chưa gồm TUI render ([số đo và giới hạn](CONTEXT_PACKETS.md#legacy-status-and-widget-path)).
- `p2o_note` trả Record ID, `sequence`, `storeVersion` (= store schema hiện hành, hiện là 7) để truy đúng committed row; ACK là domain commit, không checkpoint hay proof.

**K2 đã handover:** SQLite canonical owner writer, không JSONL replica; durable-local là mặc định và luôn confirm vị trí, quota, sensitivity. Worker startup/note/report đi qua authenticated broker; atomic handoff vẫn cần owner review. Baseline 0.5.0 không có thay đổi này; từ `7e204c3` nó nằm trong `main` và bản cài, còn các gate K2 hardening vẫn mở.

### Giữ tri thức và đọc lại — K2

```text
/p2o --target ./source --retention durable-local
/p2o --target ./source --retention ephemeral
/p2o checkpoint [lý do]
/p2o checkpoints [checkpoint-id]
/p2o artifact <artifact-id> [byte-offset]
/p2o open <run-id>
/p2o recover <run-id>
/p2o reconcile <run-id> [reason]
/p2o close
/p2o export /absolute/path/bundle   (host path, human only)
/p2o import "/absolute/path with spaces/bundle"
```

- **Durable-local:** `<cwd thực>/.p2o-state/<run-id>/`; dir 0700/file 0600. Commit trong run, giữ sau stop/finish. Scope confirmation nêu đường dẫn chính xác; dữ liệu redacted vẫn có thể nhạy cảm. Source clone bỏ private state/control/export roots, kể cả store cũ có marker SQLite/lock; không mount kho vào container.
- **Ephemeral:** cùng backend canonical nhưng đặt trong control riêng, xóa sau cleanup. Checkpoint in-run có thể xem trước stop; chỉ `--export` giữ thêm bounded legacy exchange, chưa portable bundle chứa mọi artifact.
- **Checkpoint:** snapshot ở transaction boundary, inspection có hash/missingness/pending reviews/gaps/in-flight. `integrity` kiểm tra retained hash; `dataStatus` riêng, partial khi capture thiếu/interrupted/lossy hoặc operation còn unknown/in-flight. Integrity không phải evidence freshness hay goal acceptance. List hiển thị 20 checkpoint cuối; ID cũ có trong checklog và inspect riêng được.
- **Open:** chỉ mở durable root hiện tại, không nhận arbitrary host path/`--resume`. Sau reload không auto-open, không tự gọi model hoặc tạo Engine/broker/workers/tickets/cookies/queued requests. Historical running/in-flight là interrupted/unknown, không live.
- **Reconcile:** confirmation riêng; đọc counts trước (task non-terminal, operation unknown/in-flight, pending review) rồi mở writable trong thời gian ngắn để ghi **một** `lifecycle` record có `by`/reason/`asOfSequence`/danh sách ID (cap 100 mỗi loại, reason ≤2000 ký tự). Không rewrite task status/revision, không resume Engine/worker, không khôi phục scope/ticket/cookie/budget. Live writer (run đang chạy) hoặc schema lạ bị từ chối; sau đó store được mở lại read-only và dòng `Reconciled @…` xuất hiện trong `open`. Record lặp lại được phép nhưng chỉ thêm lịch sử, không sửa lịch sử cũ.
- **Recover:** confirmation riêng cho writable **infrastructure** handle để SQLite hot-journal rollback rồi đóng/mở read-only; writer đang sống hoặc unknown schema bị từ chối, không migration/target replay. Không phải khôi phục assessment.
- **Export/import (K2):** bundle gồm `manifest.json` (ghi sau cùng) + `segments/{records,events,graph}-NNNNN.ndjson` (bundle v2; v1 vẫn đọc được) (≤4 MiB/segment) + `artifacts/<artifact-id>.txt`, tổng ≤64 MiB/4096 file, mỗi file có bytes+SHA256. Export cần đường dẫn tuyệt đối **ngoài** private state root, từ chối ghi đè/merge, dùng temp dir 0700 → fsync → rename; đây là bản sao tri thức đã redacted, không có ticket/token/cookie/socket/queue/budget. Import xác minh manifest + hash/size từng file và từ chối bundle partial; bytes được **giữ nguyên** (không redact lại để không phá hash) thành artifact bất biến kèm `importedFrom` + **một** note provenance; import trùng bị từ chối, file ngoài index bị bỏ qua và báo rõ, quota/finalization reserve vẫn áp dụng. Imported bytes **không** phải same-run evidence, không tự resolve open item, không khôi phục authority; freshness/currentness vẫn phải review. Chỉ chạy được trong run owner đang active; historical reader là read-only cho cả export/import.
- **Artifact:** human text view mặc định 16 KiB, byte cursor, verify retained hash. Shell/net/curl đã capture prefix trong host memory có bound **trước** visible cap 48 KiB; owner redact rồi publish immutable artifact. Tổng input capture stdout+stderr dùng `artifactCaptureKiB`; hai streams giữ order riêng, HTTP nối các hop theo thứ tự thực hiện, không giả cross-stream ordering. Raw buffers không vào tool/RPC result và được zero sau retention/failure. Model tool `p2o_artifact {id, offset?, length?}` đọc same-run ID, default/max 8 KiB/range (min 1 byte), theo `nextOffset`; không arbitrary host paths, target command hay restored authority. Model reads vẫn là tool/context trong lượt model bình thường, không human inspect trả phí tự động. Validated scratch ingest và bounded portable bundle đã có (K2); host disk spill/archive >64 MiB vẫn thiếu và không cứu bytes đã mất ở baseline.
- **`p2o_capture`:** đọc file text trong scratch của chính assignment (`/work` hoặc `/work/<workerId>`), relative path 1..2048 bytes/≤32 component/≤255 bytes mỗi component, không URL-decode/normalize. `offset` (integer 0..1 GiB, mặc định 0) đọc **segment** tiếp theo của cùng file: mỗi segment vẫn ≤ `artifactCaptureKiB` (≤8 MiB) và tạo một artifact riêng có `captureSource.offset`, `totalBytes`, `prefixSha256` theo đúng range; offset bắt đầu giữa ký tự UTF-8 bị từ chối (`INVALID_UTF8_PREFIX`); trailing prefix trước EOF có thể decode lossy và phải giữ partial và `offset > size` bị từ chối (`OFFSET_BEYOND_EOF`). Vì vậy file scratch dài được giữ thành nhiều artifact bounded thay vì cắt cụt ở prefix đầu tiên — workflow: cho lệnh dài ghi ra `/work/out.txt` rồi gọi `p2o_capture` với `offset` tăng dần. Host-side command output vẫn chỉ capture prefix trong bộ nhớ theo bound; không có host disk spill. Reader Python stdlib cố định chạy isolated: pin từng ancestor bằng `O_DIRECTORY|O_NOFOLLOW`, file `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, chỉ regular single-link, prefix UTF-8 hợp lệ, ghi `st_dev/ino/size/mtime_ns/ctime_ns/nlink` trước+sau cùng `stable`. File ngoài scratch, symlink (kể cả ancestor), hardlink, FIFO/device, directory, binary, missing đều bị từ chối và không tạo artifact. Nội dung file không bao giờ thành shell/code — argv chỉ mang JSON. Dùng chung admission/budget/cancellation; Planner và reporting-role bị từ chối (đọc lại artifact bằng `p2o_artifact`). Preview trả model là phần đã redact (≤8 KiB), không phải raw hay toàn file. Artifact đã publish bất biến dù scratch đổi sau đó; file đổi giữa capture được label `stable:false` và data partial, không phải snapshot atomic. Host disk spill vẫn chưa có; portable bundle bounded đã có. Cắt segment qua credential key/value có thể làm redaction thiếu context; đây không phải secret-free guarantee.
- Hash `sha256` là retained redacted bytes; `beforeRedactionSha256` chỉ **captured prefix** trước redaction, không toàn output. Hash raw prefix vẫn có thể nhạy cảm (dictionary matching); không coi manifest/export đã hết secret. Byte cap, UTF-8 loss và interruption được label; unknown key formats vẫn chỉ best-effort redaction.
- Stop revoke/cancel và verify resource removal trước final checkpoint. Storage/quota failure đóng target authority; checkpoint/export fail không giữ quyền để chờ ghi. Retained bytes có thể partial; outcome cleanup và assessment riêng. Finish hiện conservative `incomplete`; explicit goal coordination review không phải proof-aware case/assessment acceptance K5.

`status` sau stop vẫn có final summary in-memory/no authority; để xem detail sau reload dùng explicit `open`. `close` chỉ đóng reader. Không dùng checkpoint hoặc copied ticket để khôi phục target access. Graph typed queries, K4 plan/phase cards, K5 case/coverage và K6 indexed context packets đã nối; typed incremental branch-output review, fuzzy duplicate suggestions, affected-variant policy, segmented archive >64 MiB, domain re-import, segment privacy hardening, TUI render p95 và large mixed replay fixtures vẫn chưa hoàn tất.

Xem [trạng thái triển khai, ADR và các gate còn lại](KNOWLEDGE_WORKSPACE.md). Reported ≠ reviewed; resources cleaned ≠ assessment complete.

### Model usage — chỉ hiển thị

`status` cộng số Pi báo cho từng assistant message (input/output/reasoning/cache/total và giá nếu model có giá) theo role: Planner/solo từ chính phiên, mỗi worker gửi bộ đếm qua broker xác thực (`usage`, không tốn command allowance, không nhận attribution từ payload, tối đa 50.000 report/actor). Message không có usage hợp lệ được **đếm là unknown**, không bị tính 0 hay ước lượng; model không có giá không hiện chi phí giả. Không có trần, retry hay chặn nào dựa trên usage. Worker bị rút giữ phần đã báo; usage sau lần report cuối không được thu. Khi run kết thúc, một event `usage.reported` (tổng theo role, ≤16 KiB) được ghi vào checklog; chỉ ghi khi đã có usage.

### Báo cáo tất định — `/p2o report export`

```text
/p2o report export /absolute/path/report-dir
```

Người dùng gọi, **xác nhận**, đích là thư mục **mới** ngoài private state root (không ghi đè). Sinh `REPORT.md`, `cases.csv`, `coverage.csv` và `report-manifest.json` (hash từng file, `asOfSequence`, runtime digest) từ state đã commit — **không gọi model, không chạy gì lên target**, cùng sequence cho cùng byte (không có giờ/random trong nội dung). Cũng dùng được với run lịch sử đã `open` (chỉ đọc, không ghi vào store).

Nội dung theo thứ tự: tuyên bố "không phải verification/không phải bảo đảm an toàn" → provenance và reconciliation → bảng tổng → **coverage và gaps trước** (ô blocked/untested/stale đứng đầu) → case accepted-current → case khác và lý do → claims của worker (chưa phải finding) → task/handoff → giới hạn. Run rỗng ghi "chưa có case accepted-current; không có nghĩa target an toàn", không bao giờ "0 lỗ hổng". Mọi chuỗi do target/model sinh ra bị vô hiệu hóa: không link/ảnh/HTML/fence/autolink, không điều khiển/bidi, CSV chặn công thức (`'=`…). Danh sách bị giới hạn (200 dòng/mục, 500 case) và phần bị bỏ được đếm; dữ liệu đầy đủ ở bundle `/p2o export`. Ghi file nguyên tử (thư mục tạm 0700 → fsync → rename; lỗi ENOSPC không để lại đích hay thư mục tạm) và kèm marker để không bị clone vào source của lần assess sau.

Khi có cell coverage dùng khóa test WSTG (`wstg-…`, xem [WSTG_MAP](WSTG_MAP.md)), báo cáo thêm mục **WSTG checklist** ngay sau coverage và gaps: một mức L0–L3 cho từng test trong 108 test (chỉ phản ánh các cell đã ghi, không phản ánh target), danh sách test chưa có cell làm mẫu số kèm mức hỗ trợ của thư viện (D/T/N/O), và các khóa `wstg-` không có trong bản đồ. Không có khóa `wstg-` nào thì báo cáo không đổi một byte.

## Work admission / kế hoạch / phase cards — K4

Owner dùng `p2o_task action=match` trước dispatch với structured `work` (asset/policy/question keys, actor/tenant, method family, pins, purpose). Thiếu metadata ⇒ unknown, không hash prose thành semantic match. Exact active duplicate trả `already_covered_by`, historical reviewed/closed result trả `reuse_candidates` với refs/limitations; không auto-spawn hoặc goal met. Structured task cần explicit decision/output contract; retry/validation/retest có prior IDs và reasons, reserve kiểm tra lại trong canonical transaction.

`p2o_plan create/revise/list/view` (owner only) giữ goal/todo/decision trên cùng records. Goal review/close cần expected revision và same-run evidence; decision không dispatch, không renew allowance. Worker settle không report/provider-error tạo partial phase card qua fallback report hiện có, không thêm model turn. [Contract + default/min/max + giới hạn K4](WORK_ADMISSION.md).

```text
/p2o plans [cursor]
/p2o plan <id>
/p2o phases [cursor]
/p2o phase <id>
```

Human reads không target/model work; phase counts/contract chưa được owner review không phải verified output. Sau finish/settle hoặc stop, explicit `open <run-id>` đọc durable detail, không hồi authority. Schema hiện 7; store schema 3–6 chỉ inspect metadata, không tự migrate.

## Canonical case và proof-aware coverage — K5

Owner dùng `p2o_case create/revise/list/view` để review exact candidate/asset/task/evidence revisions. Worker claim không tự thành finding; accepted-current canonical case mới vào unique count. Duplicate cần reviewed policy/root-cause identity; nếu chưa chắc dùng related case. Validator/claim/asset/task revision đổi làm case và dependent coverage stale, không tự tái-accept.

`p2o_coverage plan-create/plan-revise/cell-create/cell-revise/cell-retire/list/view` giữ denominator explicit. Execution (`planned/attempted/tested/blocked…`) tách assessment (`unreviewed/confirmed_claim/ruled_out_bounded/accepted/stale`). Identity đổi retire/add, packet plan+cell atomic; blocked/untested/discovered-unplanned không thành clean.

```text
/p2o findings [cursor]
/p2o finding <case-id>
/p2o coverage [cursor]
/p2o coverage-cell <cell-id>
```

Reads không gọi model/target. `/p2o report` và checkpoints tách candidate submissions, unique cases, duplicates/pending/stale và coverage currentness. [Contract, defaults và giới hạn K5](CASE_REVIEW.md).

**Khóa test OWASP WSTG:** dùng ID viết thường (ví dụ `wstg-athz-04`) làm `questionKey` của work identity và của cell coverage; `methodFamily` là id workflow của skill, `policyKey` vẫn là chính sách của ứng dụng. [WSTG_MAP](WSTG_MAP.md) liệt kê 108 test với mức hỗ trợ của thư viện (D: có skill gọi tên đúng lớp lỗi, T: chỉ kỹ thuật chung, N: chưa có skill, O: ngoài scope) và hai cờ (B: cần browser, I: cần identity do operator cấp); bảng này là độ phủ kiến thức, không phải khả năng phát hiện. Lead và worker tìm thấy nó qua tài liệu dùng chung `shared:wstg-map` và quy ước trong `shared:handoffs`; prompt không đổi.

## Asset/fact graph — K3

```text
/p2o graph
/p2o graph page <cursor>
/p2o graph <asset-id> [cursor]
/p2o graph export [limit] [cursor]
```

`p2o_graph` model tool có `record/view/page/export`, root object schema + host action/role validation. Owner/delegated Planner record/read knowledge, không target execution; Worker ghi assets/facts/anchors, owner giữ hypotheses/relations; reporting được read-only ở tool/broker. Read page/view default 20/max 100 (view tính sequence groups), export default 200/max 500, encoded result ≤24 KiB; mutations ≤128 effective rows tính cả nested anchors. Scoped IDs/revision pins/provenance/history, negative/counterevidence và stale heads không tự grant scope hoặc verified findings. Public `id` map RPC `assetId`, không correlation `id`.

Human commands là read-only, không model call; export hiển thị JSON/Mermaid thật (TUI cần scroll), không ghi host path. Historical store schema 7 (hiện hành) mở bằng `open` rồi inspect; schema 3/4/5/6 chỉ metadata-only, không migrate. Graph bytes trong checkpoint/tail và bundle v2; import giữ foreign knowledge artifacts, không writable graph/evidence/authority. [Contract, defaults/min/max và qualification](ASSET_GRAPH.md).

## Indexed knowledge và context packets — K6

```text
/p2o heads [domain|all] [cursor] [limit]
/p2o heads gap 0 20
/p2o digest
```

Hai lệnh là indexed reads read-only: không model request, không target operation, **không ACK** delivery cursor, dùng được sau `open` historical. `heads` liệt kê current heads theo `domain` (`task`, `goal`, `todo`, `decision`, `case`, `coverage-plan`, `coverage-cell`, `candidate`, `gap`, `phase`, `report`, `evidence`) với exact matching total, shown/omitted và cursor theo sequence; `cursor` mặc định/min `0`, `limit` mặc định 20 (1–100). `digest` là bản tóm tắt deterministic cỡ cố định (≤16 KiB), không phải model summary. Head status `accepted/reported` chỉ là nhãn điều hướng: proof/currentness vẫn đọc qua `p2o_case`/`p2o_coverage` và exact evidence/task/asset pins.

```text
/p2o search <text> [cursor=N]
```

`search` (và `p2o_state {"action":"search","q":"…","cursor":0,"limit":10}`) tìm **chuỗi con thường, không phân biệt hoa/thường**, 2–80 ký tự, trên text/surface/risk/outcome/title của record đã commit (bỏ `report_part`; **không** tìm trong bytes artifact). Không có regex/SQL/glob — mọi ký tự là literal; điều khiển/bidi bị từ chối. Trả tối đa 20 hit (mặc định 10) dạng con trỏ `{id, kind, by, position, snippet ≤100 ký tự đã redact}` với total chính xác của snapshot đã commit và cursor theo vị trí (không hở/chồng); hit **không** phải evidence hay proof, đi tiếp bằng `p2o_ledger`/`/p2o task` theo ID. Là đọc chỉ-đọc: không model call, không target operation, không schema mới, dùng được với run lịch sử đã `open`; qua broker nó dùng chung ngân sách 160 lượt đọc knowledge của worker (reporting cũng được đọc). Đo trên corpus synthetic: p95 ≈5,6 ms @10k và ≈18,3 ms @100k record (máy dev, chưa gồm render); với text thật dài hơn có thể chậm hơn.

`p2o_state {"action":"heads","domain":"case","cursor":0,"limit":20}` là tool tương ứng (lead + worker, kể cả reporting; read-only). Drill-down bằng `p2o_ledger` (record ID), `p2o_graph` (asset ID) hoặc owner review API. Gọi tool vẫn nằm trong knowledge budgets hiện có; không cấp target-command allowance.

Mỗi request, Planner (12 KiB) và Worker/reporting (8 KiB) nhận **một** context packet request-local thay cho packet cũ (không append dump, không sửa system prompt/tools). Delivery cursor chỉ được ACK ở assistant `message_end` thành công, không ở `agent_start`; error/abort/inactive run không ACK và không retry ngầm. ACK là delivery receipt, **không** chứng minh model đã hiểu hay review. Schema 7 là index rebuildable trên cùng `assessment.sqlite`, không competing store. [Contract, bounds, hot/cold policy và microbench](CONTEXT_PACKETS.md).

## Focused state and review

The lead can use `p2o_task` to record a question, contrast, role/method and stop condition; accept a reported packet with receipts; then delegate its `taskId` with reviewed prerequisite revisions. Workers cannot accept owner packets or spawn children. `p2o_task dispatch` queues accepted batches until slots and reviewed support permit admission; `p2o_loop wait/blocked` expresses the Planner disposition. `p2o_ledger {cursor:0}` traverses complete bounded run state; `p2o_workers {cursor}` returns changes. Request-local objective refresh never starts another turn or renews scope. Full reports use committed hashed parts; final projection/export states omissions and failures. See [assessment state](ASSESSMENT_STATE.md) for limits and compatibility.

## Reconnaissance

Start by reading existing ledger/coverage and building a bounded surface inventory. Record entry/input, observed
actor, gate/handler if known, sensitive consumer, Evidence IDs and extraction method; label inferences and gaps.
For URL targets only the confirmed origin is authorized, with the methods, headers, cookies and bodies the approved
scope declares. Source declarations are not live exposure.
Choose the next surface/risk qualitatively by reachable influence, boundary uncertainty, likely effect, evidence,
information gain and budget; record the rationale, expected observation and stop condition in a decision note.
A missing gate returns to mapping, a candidate needs validation, and blocked proof remains open. Correct assumptions
when observations disagree. Do not wait to map everything or duplicate another worker’s owned surface/risk.

## Delegation

Inside Herdr, the lead may spawn workers. Each worker is a real `pi` process in a visible pane, started with its
own model and only the skills it was given. The worker receives:

```
FOCUS / SCOPE / LIMITS / background context (background only) / its TASK
```

and uses its enforced role loadout: execution, approved document/evidence retrieval, notes, subtask proposals and
reporting. Reporting workers cannot shell/net/HTTP or record candidates. No worker has delegation/owner task tools.
Its selected skills are inlined into the brief (a sandbox-only worker cannot read host files), and it has no
host tools, no Docker and no consent dialogs. All of its target work is brokered by the lead, so scope
checks, timeouts, output caps and the single cleanup path stay in one place.

Practical rules:

- One objective per worker. Give it what is already known and which coverage rows it owns; a worker that is not
  told repeats the work.
- Delegate discovery, then have a *different* worker validate a candidate. A worker validating its own finding is
  not independent verification.
- Delegation is flat. `p2o_request_subtask` records a proposal for the Planner; only the owner can accept it.
  `--max-depth` remains a compatibility/policy limit, not permission for nested spawning.
- `p2o_workers` with `waitFor: "all-report"` blocks locally until every worker reported or was stopped; use it
  instead of polling.
- A worker pane can read `idle` for a moment before its brief is submitted. Liveness is decided by reports, not by
  that status: `p2o_finish` refuses until a worker reports or `p2o_stop_worker` withdraws it.
- Steering never widens scope. A worker report is untrusted data — verify its evidence before repeating it.

### Tool guidance (tùy chọn, mặc định tắt) và `work` cho `p2o_delegate`

Hướng dẫn quy trình knowledge (match trước khi giao việc, case pin theo revision, coverage giữ denominator, graph có provenance, capture output dài…) có thể gắn **theo từng tool** (`promptGuidelines`, `src/tool-guidelines.ts`, `tool guidance v1`) bằng `"p2o": {"toolGuidance": true}` trong `~/.pi/agent/settings.json`; chỉ xuất hiện khi tool đó active và không bao giờ nhắc tool mà role không gọi được; phần policy của Planner không có tên tool và giữ ngân sách ký tự cũ. Đây là lời khuyên vận hành, không phải cổng: cổng vẫn ở broker/host. `status` hiện `tool guidance off` hoặc `vN`.

**Vì sao tắt mặc định (benchmark 2026-10-10, `deepseek/deepseek-flash`, thinking off, 4 fixture synthetic × 2 biến thể × 2 lần, solo, trần 15 phút/60 lượt/$2 mỗi run):** guidance **có** đổi hành vi — số lần gọi `p2o_case` 1,1 → 8,0/run, `p2o_task` 0,9 → 5,3, `p2o_graph` 1,0 → 3,7, `p2o_plan` 1,3 → 3,2 — nhưng chi phí trung bình $0,041 → $0,071/run (+73%), token ≈755k → ≈1,39M, lượt 21,6 → 32,0, và số run không hợp lệ (timeout/hết lượt) 1/16 → 3/16, trong khi recall/precision của các run hoàn tất gần như không đổi (recall 0,96 → 1,00; precision 0,79 → 0,76). Đối chứng cùng working tree **tắt** guidance: $0,042/run, 20,4 lượt, 0/16 không hợp lệ, hồ sơ gọi tool ≈ baseline — nên toàn bộ chênh lệch đến từ guidance, không phải các thay đổi W0/W1/W2/W4/W5/W6a. Mẫu nhỏ (16 run/nhánh, một model, fixture nhỏ), nên đây là tín hiệu chi phí rõ chứ không phải kết luận về chất lượng; bật guidance chỉ khi bạn muốn quy trình knowledge chặt hơn và chấp nhận chi phí đó. Chi tiết và giới hạn: [planning_update §0.2](../planning_update.md).

`p2o_delegate` nhận thêm `work`, `decision`, `outputContract` tùy chọn (cùng hình dạng `p2o_task create`): có `work` thì chạy cùng kiểm tra exact-work active/history/overlap như `p2o_task` + reserve (`ASSIGNMENT_CONFLICT`, `REUSE_CANDIDATE`); không có thì kết quả trả `workMatch: "unknown"`, kèm cảnh báo và event `delegate.unstructured`, vì khi đó chỉ còn guard bề mặt/risk cũ.

### Roles and models

`p2o_delegate` accepts `role` (`recon`, `discovery`, `validation`, `reporting`, `general`), up to 3 `skills`, and
an optional `model`. Named skills override the role default; omitting them uses it, so a specialist always runs with
at least one technique skill, while `general` runs with none. An unknown skill name is refused before any pane is
created, and each selected skill's instructions are inlined into the worker's brief. Precedence mirrors pi-herdr: per-spawn `model` → `p2o.roles.<role>.model` in
`~/.pi/agent/settings.json` → package default → the lead's own model. Package defaults:

| Role | Default model | Typical skills |
|---|---|---|
| `recon` | `opencode-go/deepseek-v4-flash` | attack-surface-mapping |
| `discovery` | `opencode-go/deepseek-v4-flash` | source-code-auditing |
| `validation` | `opencode-go/kimi-k3` | exploitability-assessment |
| `reporting` | `opencode-go/kimi-k3` | remediation |
| `general` | the lead's model | none |

```json
{ "p2o": { "maxWorkers": 3, "maxDepth": 2, "roles": { "validation": { "model": "opencode-go/kimi-k3" } } } }
```

Limits: `--workers` positive safe integer (default 3), `--max-depth` 0..3 (default 2); no cumulative 2× spawn cap.
Fresh assignments reuse logical capacity, not processes/tickets. 200 commands/worker and 90% of default 600
worker commands persist across identities. Owner commands and provider cost are separate. 100 live tasks/pending
intents and 1,000 retained registrations remain bounded; pane cleanup failure blocks new admission.

## Sandbox limits

Pinned Strix tools image; user 65532; read-only root filesystem; capabilities dropped; no-new-privileges;
Docker default seccomp; 512 PIDs; 2 GiB memory; two CPUs; `/tmp` and `/work` tmpfs (larger when delegation is
enabled). The shell container has bridge networking with real egress, including private and loopback addresses;
unprivileged connect scans work, raw-socket scans do not (no capabilities). HTTP requests run in ephemeral
containers with **only fixed curl arguments**, never model-controlled code, no proxy, and the destination resolved
and pinned per hop. No source mounts, Docker socket, host home or provider credentials are mounted.
Assessment, lead and worker lifetime: **no elapsed-time limit** while the live owner retains authority. Shell/network and HTTP task timeouts default to `0` (unlimited); optional positive integer seconds have no 60/300-second ceiling. HTTP also accepts optional `connectTimeout`; zero uses underlying library/network defaults. Response 8 MiB, request body 32 KiB and visible output 48 KiB remain.
Use `/p2o stop`, `p2o_finish` or worker withdrawal to end work. Infrastructure connection/startup/control/cleanup watchdogs remain, not investigation deadlines. An explicit shell timeout/cancellation removes the affected executor/background processes; shared mode can interrupt peers, isolated mode does not remove peers. Losing a worker socket revokes its ticket and cancels its in-flight operations. Continuation is opt-in on semantic events only; no automatic retry/provider fallback or periodic paid polling.
No application-level model token/cost cap; Pi/provider accounting is unchanged.

This is container isolation, not a virtual machine. The trusted Pi process, other installed extensions and
the Docker daemon are outside this containment boundary. Tool gates restrict model calls, not malicious
extension code or host-kernel compromise.

## Cleanup trouble

If Docker is unavailable during cleanup, tools stay gated. Restore Docker and retry `/p2o stop`.
Reload/session navigation attempts cleanup; failed cleanup cancels navigation. An abrupt process kill can leave
containers or worker panes behind. List only this extension's containers:

```sh
docker ps -a --filter label=pi-p2o=minimal
```

After checking that no active assessment needs them, remove their specific names with `docker rm -f <name>`.
Worker panes can be closed from Herdr. The extension does not silently reclaim old containers on startup.

## Troubleshooting

- Missing image: run the pinned `docker pull` from README. No automatic download happens during assessment.
- Docker permissions: ensure your account can use the local Unix socket. Remote Docker daemons are unsupported.
- Delegation unavailable: Pi is not inside Herdr, or `--solo`/limits disabled it. The confirmation dialog says which.
- Worker rejected its ticket: the pane shows `p2o worker ticket rejected …`; the worker keeps no target access.
  Version-2 tickets explicitly declare `lifetime: "until-stopped"`; they remain owner-private, extension/image-bound and require a live owner registration. Stop, report or socket loss revokes access. Old/implicit lifetime formats are rejected, not upgraded silently.
- Target unavailable: choose an existing directory, or an HTTP(S) URL whose hostname resolves to a reachable address; IPv6 depends on Docker routing.
- Duplicate tools: load either the installed package or `pi --no-extensions -e /path/to/pi-p2o`, never both.
- `pi update` seems to succeed but the old code still runs: `PI_OFFLINE=1` (for example exported in a shell profile) makes it return immediately while still printing "Updated". Unset `PI_OFFLINE` for that single command, then confirm the installed revision with `git -C ~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o rev-parse HEAD`; the CLI message is not evidence. Stop any active assessment before `/reload`.
- Legacy flags/configurations from 0.2 (plan approval, profiles, manifests) are removed. Use `--target` with the supported startup options documented above; do not use the old flags.
