# Usage

Cài: `pi install https://github.com/Nhan-Laptop/pi-p2o` rồi `/reload`. Bật Docker và `docker pull` ảnh sandbox ghim trong README một lần. Không cần build trong bản đã cài.

```text
/p2o --target ./source
/p2o --target https://example.com
/p2o --target ./source --workers 2
/p2o --target ./source --loop event-driven --executors isolated --target-ops 2
/p2o --target ./source --goal "Kiểm tra authorization của API đơn hàng"

/p2o pause
/p2o resume
/p2o stop
```

Một hộp thoại xác nhận quyền sở hữu, scope, giới hạn sandbox, kế hoạch worker, retention và (nếu chọn) các vòng Planner tự động. Từ chối thì không có sandbox,
worker hay model turn nào. Delegated: Pi hiện tại là Planner, **không** chạy lệnh target; `--solo`: Pi tự điều tra.

- **Source**: bản sao regular-file ở `/target` (read-only, ≤64 MiB / 20.000 entry; bỏ symlink, file đặc biệt, `.git`, `node_modules`), `/work` là scratch ghi được. Lệnh chạy qua `p2o_shell`, không bao giờ qua shell của host.
- **Web**: `p2o_http` gửi mọi method/header/cookie/body tới đúng origin đã xác nhận, ghim IP từng hop, dừng trước redirect ra ngoài origin; `p2o_net` chạy lệnh mạng trong cùng container (egress thật, không phải firewall). URL GitHub **không** được clone. Chi tiết: [HTTP_TRANSPORT](HTTP_TRANSPORT.md).
- Lead gọi `p2o_finish` trước báo cáo: nó từ chối tới khi mọi worker đã report hoặc bị rút, rồi xóa sandbox, xác minh container đã gỡ và báo số pane Herdr đã đóng. `/p2o stop` làm tay cùng đường đó.

## Các option khi start

`MAX_SAFE` = 9007199254740991 (giới hạn parser, **không** phải mức tài nguyên khả thi).

| Option | Mặc định | Giá trị hợp lệ | Ghi chú |
|---|---|---|---|
| `--target <path-or-url>` | bắt buộc | thư mục local hoặc URL HTTP(S), ≤4096 ký tự | đặt trước các option khác; quote đường dẫn có dấu cách |
| `--workers N` | 3 | 1…`MAX_SAFE` | trần worker đồng thời, không phải tổng assignment; tắt delegation bằng `--solo` hoặc `--max-depth 0` |
| `--loop MODE` | `manual` | `manual` \| `event-driven` | event-driven cần Herdr và consent lúc start |
| `--executors MODE` | `shared` | `shared` \| `isolated` | shared tuần tự; isolated tách sandbox theo assignment |
| `--target-ops N` | shared 1 · isolated 3 | shared 1; isolated 1…`MAX_SAFE` | trần thao tác target đồng thời — không phải số worker hay số vòng Planner; shared mà truyền >1 bị từ chối |
| `--max-depth D` | 2 | 0–3 | 0 tắt delegation; delegation luôn phẳng (không worker nào được spawn con) |
| `--solo` | tắt | flag | Pi tự điều tra, phải dùng loop manual |
| `--export` | tắt | flag | giữ bounded redacted ledger ở `.p2o-reports/` lúc cleanup (không phải checkpoint giữa run) |
| `--goal "text"` | không | 1–600 ký tự, trong dấu nháy, không ký tự điều khiển | mục tiêu bằng lời của bạn, hiện trong confirmation và vào prompt lead như dữ liệu trích dẫn; không mở rộng/thu hẹp scope; được ghi vào ledger và in trong REPORT.md; bỏ qua thì prompt không đổi một byte |
| `--avoid "text"` | không | lặp lại tối đa 5 lần, mỗi lần 1–300 ký tự, trong dấu nháy, không ký tự điều khiển | điều worker nên tránh (ví dụ `--avoid "không đụng luồng thanh toán"`); hiện trong confirmation, thêm vào mọi worker brief dưới khối `OPERATOR CONSTRAINTS` dạng trích dẫn, ghi vào ledger và REPORT.md; chỉ là hướng dẫn cho model, không phải enforcement — ranh giới vẫn là target đã xác nhận, scope check, ticket và broker; bỏ qua thì brief không đổi một byte |
| `--retention MODE` | `durable-local` | `durable-local` \| `ephemeral` | luôn hiện trong confirmation; không tạo store trước consent |
| `--refer-workspace [GIÁ-TRỊ]` | không dùng | không giá trị → `latest`; hoặc `all`; hoặc tối đa 10 `run-id` phân tách dấu phẩy | đọc tối đa các run cũ cùng target làm context; không bao giờ tính là same-run evidence — xem mục dưới |

Số phải là số nguyên trong khoảng cho phép (không âm/thập phân/`unlimited`); giá trị sai bị từ chối, không tự clamp. Không có `--max-planner-rounds`: đó là setting.
`--target-ops` chỉ là **trần**: một lệnh vẫn có thể tự sinh nhiều subprocess/request; nó không phải rate limiter hay egress firewall.

### Manual và event-driven

| | `manual` (mặc định) | `event-driven` |
|---|---|---|
| Worker report khi Planner idle | không tự gọi model; bạn tương tác để Planner review tiếp | có thể tự gọi Planner nếu event hợp lệ, chưa pause/stop, còn allowance (tốn phí model) |
| Task đã dispatch | Engine vẫn tự admit khi có slot và prerequisite | giống nhau |
| Polling/heartbeat | không | không |

Manual **không** có nghĩa phải launch worker bằng tay; khác biệt chỉ là quyền tự bắt đầu **vòng Planner mới**. `p2o_loop` là tool của Planner (`status` / `wait` / `blocked`),
không phải slash command: `wait` kết thúc vòng hiện tại chứ không phải assessment; `blocked` tạm dừng dispatch và wake cho tới khi bạn `/p2o resume`.
Một report/proposal được coalesce và không bảo đảm đánh thức nếu có input người đang chờ, run đã pause/stop hoặc hết allowance.

### Shared hay isolated

Shared: mọi worker dùng chung một executor tuần tự — hủy/timeout shell có thể phá sandbox và ảnh hưởng worker khác. Isolated: mỗi assignment có container, scratch, cookie riêng,
hủy một cái không đụng peer, nhưng tốn tài nguyên (mỗi container giới hạn 2 GiB RAM / 2 CPU, chưa kể sandbox chính và container HTTP) và vẫn chung kernel host. Ví dụ
`--workers 3 --executors isolated --target-ops 2`: tối đa 3 worker; thao tác target của worker thứ ba chờ slot; worker vẫn suy luận được khi không chờ tool. Bắt đầu với 2–3 worker và 1–2 target-op rồi cân nhắc RAM/CPU/chi phí provider.

### Settings (`~/.pi/agent/settings.json`, khóa `p2o`)

Merge vào file hiện có, không ghi đè phần khác. Precedence: **CLI cho run đó → settings → mặc định**; settings chỉ đọc lúc start run mới; số sai kiểu/ngoài khoảng quay về mặc định của field. Hộp xác nhận luôn xuất hiện — settings không thay consent.

| Khóa | Mặc định | Ghi chú |
|---|---|---|
| `maxWorkers` / `maxDepth` | 3 / 2 | như `--workers` / `--max-depth` |
| `loopMode` | `manual` | `manual` \| `event-driven` |
| `maxPlannerRounds` | 100 | 1…`MAX_SAFE`, chỉ là allowance cho **vòng Planner tự động** (không phải tổng turn/token/chi phí/TTL); hết thì Engine pause và `/p2o resume` không cấp lại |
| `executorMode` | `shared` | `shared` \| `isolated` |
| `maxTargetOperations` | 3 | shared luôn ép về 1 |
| `retention` / `storageQuotaMiB` | `durable-local` / 256 | quota 8–1024 MiB (gồm journal và reserve cuối) |
| `artifactCaptureKiB` | 1024 | 1–8192; tổng prefix stdout+stderr được capture mỗi thao tác trước khi cắt hiển thị 48 KiB |
| `toolGuidance` | `false` | bật lời khuyên quy trình knowledge theo từng tool (`src/tool-guidelines.ts`); đọc lúc nạp nên cần `/reload`. Tắt mặc định vì benchmark 2026-10-10 (deepseek-flash, 16 run/nhánh) cho thấy chi phí +≈73% mà recall/precision gần như không đổi |
| `finishGate` | `warn` | `off`; `warn` nối khối `FINISH PREFLIGHT` vào kết quả `p2o_finish`; `confirm` từ chối **một lần** cho mỗi tập blocking, lần gọi lại giống hệt thì kết thúc |
| `autoReport` | durable: bật · ephemeral: tắt | ghi báo cáo tất định lúc run kết thúc |
| `reportRoot` | `<cwd>/.p2o-reports` | đường dẫn tuyệt đối; báo cáo ở `<reportRoot>/report-<runId>/` |
| `reportFormat` | `2` | `2` = báo cáo kiểu OWASP (xem dưới); `1` = bộ tệp cũ |
| `reviewIntegrity` | `annotate` | `off` \| `annotate` (ghi ai tạo receipt cho từng review) \| `enforce` (từ chối receipt không do assignee tạo, trừ khi review gửi `externalEvidence=true`) |
| `report` | — | `author`, `organization`, `team`, `classification`, `disclaimer` (≤400 ký tự), in vào Provenance với nhãn "operator-supplied, unverified" |
| `roles.<role>.model` | xem bảng role | model theo role |

### Pause, hold, stop

| Lệnh | Tác dụng |
|---|---|
| `/p2o pause` | dừng dispatch và wake tự động, abort lượt Planner; worker đã admit vẫn chạy và report |
| `/p2o resume` | mở lại scheduling của run hiện tại nếu allowance còn; không cấp lại budget, không đổi mode |
| `/p2o stop` | revoke worker, hủy thao tác, cleanup; không cần mọi task thành công |
| `/p2o hold [lý do]` | chặn lệnh target **mới** (`TARGET_OPS_HELD`, không trừ allowance) và launch worker mới; lệnh đang chạy hoàn tất; notes, report, cleanup và stop luôn mở. Chỉ người dùng gọi được |
| `/p2o release` | gỡ hold sau xác nhận; task đã accept được admit lại |
| `/p2o workers` | bảng worker chỉ đọc (lệnh đã dùng, thời gian im lặng, cờ `QUIET` — quan sát cục bộ, không phải timeout) |
| `/p2o stop-worker <worker-id> [lý do]` | rút **một** worker sau xác nhận: revoke ticket, hủy lệnh, đóng pane, task → `cancelled` |

## Xem tiến độ (không gọi model, không đổi quyền)

```text
/p2o status
/p2o dashboard [overview|workers|tasks|coverage|cases|log]
/p2o tasks [all|live|awaiting-review|blocked|done] [cursor]
/p2o task <task-id>
/p2o log [cursor] [task=<id>] [actor=<id>] [operation=<id>]
/p2o report
/p2o search <text> [cursor=N]
```

- `status`: đếm task, review/blocker, profile loop/executor, allowance, retention, bảng worker, dòng `Runtime: p2o <version> · <12 hex>` (digest entry file **và** `src/**`), `Planner context` (từ Pi, chỉ đo, p2o không tự compact) và **model usage** theo role (chỉ hiển thị: không có trần/retry nào dựa trên nó; message không có usage được đếm là *unknown*, không phải 0).
- `dashboard`: màn hình đa tab (Overview/Workers/Tasks/Coverage/Cases/Log, phím số 1-6 hoặc ←→, ↑↓/PageUp/PageDown cuộn, `r` vẽ lại, Esc/q đóng) dựng từ đúng một lần quét ledger mà `status`/widget đã dùng — mở thêm tab không quét ledger lần hai. Cập nhật sống khi còn mở (planning_update.md P2); trong RPC trả text cho tab đang chọn, không mở màn hình (P3). Phím tắt **F2** bật/tắt một overlay cùng nội dung nhưng không giữ phím (non-capturing): overlay vẫn hiện trong khi gõ `/p2o hold` hay lệnh khác ở editor (P5, thực nghiệm).
- `tasks`/`log` 20 mục/trang; cursor là vị trí trong snapshot hoặc sequence đã commit (`log 0` duyệt từ đầu; không cursor xem đuôi; bộ lọc `task=`/`actor=`/`operation=` mang theo qua `Next:`). `done` chỉ nghĩa task đã đóng, không phải finding đã verified.
- `report` là index các handoff/claim; không tự viết kết luận hay nâng proof. TUI có widget gọn và màn hình cuộn (↑↓/PageUp/PageDown, Esc/q); RPC nhận text.

## Tri thức bền và đọc lại (K2)

```text
/p2o checkpoint [lý do]
/p2o checkpoints [checkpoint-id]
/p2o artifact <artifact-id> [byte-offset]
/p2o open <run-id>
/p2o recover <run-id>
/p2o reconcile <run-id> [reason]
/p2o close
/p2o export /absolute/path/bundle
/p2o import "/absolute/path with spaces/bundle"
```

- **durable-local**: `<cwd>/.p2o-state/<run-id>/` (0700/0600), giữ sau stop/finish; **ephemeral**: cùng backend nhưng xóa sau cleanup. Dữ liệu đã redact vẫn có thể nhạy cảm. Source clone bỏ toàn bộ state/export root; kho không bao giờ được mount vào container.
- **checkpoint**: snapshot tại transaction boundary có hash, thiếu sót, review/gap chờ, thao tác in-flight. `integrity` (hash) khác `dataStatus` (partial khi capture thiếu/lossy/interrupted) và đều không phải bằng chứng còn mới.
- **open / close**: chỉ mở run bền hiện có (không nhận đường dẫn tùy ý, không `--resume`), read-only; không tạo Engine, worker, ticket hay model turn. Trạng thái running trong lịch sử là *interrupted/unknown*.
- **recover**: xác nhận riêng, rollback hot journal rồi mở lại read-only. **reconcile**: ghi **một** record lifecycle liệt kê việc dở dang; không đổi task, không khôi phục authority.
- **export / import**: bundle redacted có manifest + SHA256 từng file, ≤64 MiB, đường dẫn tuyệt đối **ngoài** state root, không ghi đè; import verify rồi giữ bytes nguyên dạng như artifact bất biến + một note provenance — **không** là evidence cùng run. Chỉ người dùng, trong run owner đang hoạt động.
- **artifact**: xem 16 KiB mỗi lần, verify hash; model dùng `p2o_artifact {id, offset?, length?}` (≤8 KiB). `p2o_capture` đọc file text trong scratch của chính assignment theo `offset` để giữ file dài thành nhiều artifact. Chi tiết: [STATE_STORE](STATE_STORE.md).

Stop revoke/cancel rồi xác minh container trước checkpoint cuối. Lỗi storage đóng authority target. Chi tiết trạng thái triển khai: [KNOWLEDGE_WORKSPACE](KNOWLEDGE_WORKSPACE.md).

### `--refer-workspace` (ngữ cảnh từ run cũ, không bao giờ là evidence)

Không truyền thì hành vi giống hệt trước đây. Khi dùng:

- **Điều kiện khớp**: cùng `targetKind`; thư mục phải cùng path tuyệt đối, URL chỉ cần cùng origin (rộng hơn so khớp tuyệt đối — khớp "hiện hành"/currency thì chặt hơn, xem `gaps` dưới). Enumerate tối đa 20 run mới nhất dưới state root, mở read-only từng cái chỉ để đọc manifest rồi đóng ngay.
- `latest` chọn đúng 1 run mới nhất đủ điều kiện; `all` chọn tối đa 5; liệt kê id thì chỉ giữ các id vừa được yêu cầu vừa khớp (id không tồn tại/không khớp bị bỏ, có lý do trong `gaps.unknown`, không bao giờ âm thầm bỏ qua).
- Hộp xác nhận start thêm một đoạn nêu tên các run được chọn, hoặc báo "không tìm thấy" nếu dùng flag mà không có kết quả.
- Sau khi sandbox khởi tạo, ghi **một** record lifecycle (`data.reference`) gồm `runs` (run id + trạng thái `current`/`stale`, so theo `sourceSnapshotSha256` với thư mục hoặc URL chính xác) và `gaps` 5 nhóm: **covered** (cell đã `tested`, còn khớp target hiện tại), **leftOpen** (candidate `open_proof_gap` + cell `blocked`), **stale** (từng `tested` nhưng target đã đổi — không gộp vào covered), **neverReached** (test WSTG chưa cell nào chạm tới, hợp trên mọi run được chọn), **unknown** (lý do rõ ràng: không có run đủ điều kiện, run thiếu/sai schema, reconciliation chưa xong — không bao giờ coi là "clean").
- Đọc lại qua `p2o_state {action:'heads', domain:'reference'}` hoặc `digest`; **không** đẩy vào prompt lead/worker. Không bao giờ là same-run evidence, không khôi phục scope/ticket/worker/budget — cùng nguyên tắc với `/p2o export|import`. Chi tiết thiết kế: [planning_update.md](../planning_update.md).

## Báo cáo tất định

Run durable-local tự ghi báo cáo lúc cleanup (finish, `/p2o stop`, shutdown, đổi session, lỗi storage) vào `<cwd>/.p2o-reports/report-<runId>/` — thư mục nằm trong project nên **đừng commit**. Kết quả `p2o_finish` có dòng `REPORT: <path>`;
lỗi ghi báo cáo không chặn cleanup. Crash thì dùng `/p2o open <run-id>` rồi:

```text
/p2o report export [absolute-dir]
```

Sau xác nhận, sinh `REPORT.md`, `cases.csv`, `coverage.csv`, `report-manifest.json` (hash từng file, `asOfSequence`, digest runtime) từ state đã commit — **không gọi model, không chạm target**, cùng sequence ra cùng byte, ghi nguyên tử vào thư mục mới ngoài state root.
Chuỗi do target/model sinh ra bị vô hiệu hóa (không link/HTML/fence, CSV chặn công thức). Thứ tự: tuyên bố "không phải bảo đảm an toàn" → provenance → **coverage và gap trước** → case accepted-current → case khác → claim worker → task/handoff → giới hạn. Run rỗng ghi "chưa có case accepted-current", không bao giờ "0 lỗ hổng".

Định dạng v2 (theo OWASP WSTG §5) thêm Scope and limitations, Executive summary (đếm tất định; đoạn `narrative` của lead nếu có luôn gắn nhãn *chưa được host kiểm chứng*), bảng findings và chi tiết từng finding (severity do owner gán bằng `p2o_case action=rate`, CVSS 3.1 host tự tính từ vector, CWE, khuyến nghị, WSTG, mức proof, ai tạo receipt, bước tái hiện từ receipt đã redact), cùng `findings.json`, `findings.csv` và
`wstg-checklist.csv` (khi có cell `wstg-…`). **Finish preflight** (`src/finish-preflight.ts`, thuần, không model) liệt kê mục chưa xong — blocking: `UNREVIEWED_TASK`, `UNREVIEWED_CLAIM`, `PENDING_CASE`, `STALE_CASE`, `STALE_CELL`, `NO_COVERAGE_PLAN`, `NONTERMINAL_CELLS`, `UNRATED_ACCEPTED_CASE`; advisory: `STALE_RATING`, `OPEN_GAP_UNREFERENCED`, `ORPHAN_TASK`, `UNPLANNED_ASSETS`, `WSTG_APPLICABLE_UNPLANNED`, `FOREIGN_EVIDENCE`, `CONTRACT_GAP`, `HIGH_WITHOUT_INDEPENDENCE` (blocking khi `reviewIntegrity=enforce`), `NEGATIVE_MAY_BE_BLOCKED` (kết luận `ruled_out` chỉ dựa trên receipt `p2o_http` kết thúc bằng 401/403/429 hoặc không có phản hồi — có thể là kiểm soát truy cập hay rate limit chứ chưa chứng minh lỗi không tồn tại; chỉ cảnh báo, tắt khi `reviewIntegrity=off`; receipt shell/net, 2xx và 404 không bao giờ bị gắn cờ). Đây không phải finding và không phải kết luận an toàn.

## Công cụ tri thức K3–K6 (đọc, không gọi model)

```text
/p2o plans [cursor]            /p2o plan <id>           /p2o phases [cursor]       /p2o phase <id>
/p2o findings [cursor]         /p2o finding <case-id>   /p2o coverage [cursor]     /p2o coverage-cell <id>
/p2o graph                     /p2o graph page <cursor> /p2o graph <asset-id>      /p2o graph export [limit] [cursor]
/p2o heads [domain|all] [cursor] [limit]                /p2o digest
```

| Mảng | Tool của model (owner) | Tài liệu |
|---|---|---|
| Work admission, goal/todo/decision, phase card | `p2o_task action=match`, `p2o_plan` | [WORK_ADMISSION](WORK_ADMISSION.md) |
| Case, rating, coverage | `p2o_case`, `p2o_coverage` | [CASE_REVIEW](CASE_REVIEW.md) |
| Graph tài sản/fact | `p2o_graph` | [ASSET_GRAPH](ASSET_GRAPH.md) |
| Heads, digest, search, packet theo role | `p2o_state` (cả worker, read-only) | [CONTEXT_PACKETS](CONTEXT_PACKETS.md) |

**Khóa test OWASP WSTG**: dùng ID viết thường (ví dụ `wstg-athz-04`) làm `questionKey` của work identity và của cell coverage; `methodFamily` là workflow id của skill. [WSTG_MAP](WSTG_MAP.md) liệt kê 108 test với mức hỗ trợ của thư viện (D/T/N/O) và cờ browser/identity — đây là độ phủ kiến thức, không phải khả năng phát hiện. Lead và worker tìm thấy nó qua `shared:wstg-map` và `shared:handoffs`.

## Delegation

Trong Herdr, lead có thể spawn worker: mỗi worker là một tiến trình `pi` thật trong pane nhìn thấy được, với model riêng và chỉ các skill được giao (nội dung skill được nhúng vào brief). Worker không có tool của host, Docker hay hộp consent; mọi thao tác target đều do lead (broker) làm trung gian nên kiểm tra scope, timeout, giới hạn output và cleanup nằm ở một chỗ.

- Một mục tiêu cho mỗi worker; nói cho nó biết đã biết gì và nó sở hữu hàng coverage nào, nếu không nó sẽ lặp việc.
- Discovery và validation do **hai worker khác nhau**; worker tự validate finding của chính nó không phải xác minh độc lập.
- Delegation phẳng: `p2o_request_subtask` chỉ là đề xuất, chỉ owner mới accept. Steering không mở rộng scope; report của worker là dữ liệu chưa tin cậy — kiểm tra evidence trước khi lặp lại.
- `p2o_workers` với `waitFor: "all-report"` chờ cục bộ tới khi mọi worker đã report hoặc bị rút. Pane có thể hiện `idle` ngắn trước khi brief được nộp: sống/chết do report quyết định, và `p2o_finish` từ chối tới khi worker report hoặc bị `p2o_stop_worker`.
- `p2o_delegate` nhận `role` (`recon`, `discovery`, `validation`, `reporting`, `general`), tối đa 3 `skills`, `model`, `thinking`, và tùy chọn `work`/`decision`/`outputContract` (cùng hình dạng `p2o_task create`; không có `work` thì kết quả trả `workMatch:"unknown"`). Skill nêu rõ ghi đè mặc định của role; skill lạ bị từ chối trước khi tạo pane.

| Role | Model mặc định | Skill mặc định |
|---|---|---|
| `recon` | `opencode-go/deepseek-v4-flash` | attack-surface-mapping |
| `discovery` | `opencode-go/deepseek-v4-flash` | source-code-auditing |
| `validation` | `opencode-go/kimi-k3` | exploitability-assessment |
| `reporting` | `opencode-go/kimi-k3` | remediation |
| `general` | model của lead | không |

Thứ tự chọn model: `model` của lần spawn → `p2o.roles.<role>.model` → mặc định gói → model của lead. Giới hạn: 200 lệnh/worker và 90% của 600 mặc định tồn tại qua các identity; lệnh của owner và chi phí provider tách riêng; 100 task/intent chờ, 1.000 registration; cleanup pane thất bại thì chặn admission mới.

## Sandbox

Ảnh Strix ghim; user 65532; root filesystem read-only; bỏ hết capability; `no-new-privileges`; seccomp mặc định của Docker; 512 PID; 2 GiB RAM; 2 CPU; `/tmp` và `/work` là tmpfs. Container shell có bridge network với egress thật (kể cả private/loopback); quét TCP connect chạy được, raw-socket thì không. Request HTTP chạy trong container tạm với **chỉ tham số curl cố định**, không proxy, đích được resolve và ghim từng hop. Không mount source, Docker socket, home host hay credential provider.
Không có thời hạn cho assessment/lead/worker khi owner còn authority; timeout shell/HTTP mặc định `0` (không giới hạn), số dương tùy chọn không bị trần; watchdog hạ tầng vẫn còn. Không có trần token/chi phí ở tầng ứng dụng. Đây là cô lập container, **không phải VM**: tiến trình Pi, extension khác và Docker daemon nằm ngoài ranh giới này.

## Cleanup và xử lý sự cố

- Docker không khả dụng lúc cleanup: tool vẫn bị khóa — khôi phục Docker rồi `/p2o stop` lại. Reload/đổi session thử cleanup, thất bại thì hủy việc điều hướng. Kill cứng có thể để lại container/pane; liệt kê của extension: `docker ps -a --filter label=pi-p2o=minimal`, kiểm tra không còn run nào cần chúng rồi `docker rm -f <name>`; pane đóng từ Herdr. Extension không tự thu hồi lúc khởi động.
- Thiếu ảnh: `docker pull` đúng ảnh trong README; không tải tự động. Quyền Docker: tài khoản phải dùng được Unix socket local (không hỗ trợ daemon từ xa).
- Delegation không khả dụng: Pi không chạy trong Herdr, hoặc `--solo`/giới hạn đã tắt — hộp xác nhận nói rõ lý do. Worker báo `p2o worker ticket rejected`: nó không còn quyền target (ticket v2 `until-stopped`, gắn extension/image, cần owner đang sống; định dạng cũ bị từ chối).
- Target không dùng được: chọn thư mục tồn tại hoặc URL HTTP(S) có hostname resolve được; IPv6 phụ thuộc routing Docker.
- Nạp trùng tool: chỉ dùng **một** trong bản cài hoặc `pi --no-extensions -e /path/to/pi-p2o`.
- `pi update` báo thành công nhưng vẫn chạy code cũ: `PI_OFFLINE=1` (ví dụ export trong shell profile) làm nó thoát ngay mà vẫn in "Updated". Bỏ biến đó cho riêng lệnh này, rồi kiểm tra bằng `git -C ~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o rev-parse HEAD` — thông báo của CLI không phải bằng chứng. Stop assessment đang chạy trước `/reload`.
- Cờ/cấu hình cũ từ 0.2 (plan approval, profile, manifest) đã bị xóa; chỉ dùng `--target` và các option ở trên.
