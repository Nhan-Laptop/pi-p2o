# Sử dụng

Cài: `pi install https://github.com/Nhan-Laptop/pi-p2o` rồi `/reload`. Cần Docker đang chạy và một lần
`docker pull` ảnh sandbox ghim trong [README](../README.md#install). Không cần build khi đã cài. Tài liệu kiến trúc:
[ARCHITECTURE](ARCHITECTURE.md); engine/task: [PLANNER_ENGINE](PLANNER_ENGINE.md); transport: [HTTP_TRANSPORT](HTTP_TRANSPORT.md);
bằng chứng/báo cáo: [EVIDENCE](EVIDENCE.md); tri thức: [KNOWLEDGE](KNOWLEDGE.md).

## Bắt đầu và điều khiển

```text
/p2o --target ./source
/p2o --target https://example.com --goal "Tenant A có đọc được hoá đơn của tenant B?"
/p2o --target ./source --workers 2 --executors isolated --target-ops 2
/p2o --target ./source --mode assess --retention ephemeral
/p2o --resume run-1f0c9a2e-8d5b-4c1a-9f3e-2b7d6a4c8e10

/p2o pause
/p2o resume
/p2o stop
/p2o hold [lý do]
/p2o release
/p2o workers
/p2o stop-worker <worker-id> [lý do]
/p2o approve <policy-ask-id>
/p2o deny <policy-ask-id>
```

Một hộp xác nhận duy nhất nêu quyền sở hữu target, engagement mode, sandbox, worker, retention và model — từ chối thì
không có sandbox, worker hay model turn nào. Consent đó **authorization blanket cho cả run**: không có per-action consent
sau đó (xem [Tự chủ](#tự-chủ-authorization-browser-identity)). Pi hiện tại là planner/reviewer; nó tạo và dispatch intent,
review và chứng minh, còn worker thi hành target và là tác giả duy nhất của claim/note/surface. Không có worker backend
(Herdr) thì **không start được run**: manual mode đã bị xoá nên planner không có đường thi hành target, và lệnh start bị
từ chối trước khi run tồn tại.

`pause` dừng dispatch và wake tự động (worker đã admit vẫn chạy tới khi report); `resume` mở lại scheduling, không cấp lại
quyền; `stop` revoke worker, huỷ thao tác và cleanup — nếu một round đang chạy, loop pause trước, round đó được settle tối
đa 30 s và ghi `planner.round-end reason=operator-stop` thay vì bị kill giữa lượt, rồi worker còn sống có tối đa 90 s để
gửi report đã hứa trước khi teardown cứng (quá hạn thì dừng cứng như cũ); `hold` chặn lệnh target **mới** và launch worker
mới nhưng không kết
thúc run; `release` gỡ hold sau xác nhận; `stop-worker` rút một worker (task → `cancelled`). `approve`/`deny` xử lý một
command-policy ask đang chờ, quyết định gắn với đúng hash request và chỉ ghi một lần.

## Xem tiến độ (không gọi model, không đổi quyền)

```text
/p2o status
/p2o log [cursor] [task=<id>] [actor=<id>] [operation=<id>]
/p2o report
/p2o search <text> [cursor=N]
/p2o heads [domain|all] [cursor] [limit] [status]
/p2o show <domain> <id>
/p2o digest
/p2o graph [asset-id] [cursor]
/p2o graph page <cursor>
/p2o graph export [limit] [cursor]
```

- `status` in task/review/blocker, profile loop/executor, số lệnh đã chạy, retention, bảng worker, dòng `Runtime:`,
  `Planner context` (Pi báo, chỉ hiển thị), model usage theo role, dòng `Frontier:` (gồm `stalled rounds N`), dòng
  `Round:` khi đã có round được admit (số round, session thay thế, trạng thái ngân sách kèm trục đã chạm, model/thinking
  đã route và round fact mới nhất) và dòng
  `Authority:` (planner target ops phải 0, worker ops, task, claim, validation, role matrix). Tất cả đọc từ record đã
  commit; không counter nào từ chối hay kết thúc run.
- `log` 20 mục/trang, cursor là vị trí snapshot hoặc sequence đã commit; `report` là index handoff/claim, không tự viết kết
  luận; `search` là substring 2–80 ký tự trên record đã commit, trả pointer đã redact (không phải evidence).
- `heads`/`show` đọc index knowledge theo domain (`task`, `goal`, `todo`, `decision`, `case`, `coverage-plan`,
  `coverage-cell` — chỉ cell lưu legacy, `candidate`, `gap`, `phase`, `report`, `evidence`, `reference`); `digest` là bản tóm
  tắt cho người. Cell coverage hiện hành do host suy ra, đọc qua `p2o_board board=coverage` hoặc report.
- `/p2o graph …` là bản đọc graph tài sản/fact (read-only); export in JSON/Mermaid tại chỗ, không ghi file host.

## Option khi start

| Option | Mặc định | Giá trị hợp lệ | Ghi chú |
|---|---|---|---|
| `--target <path-or-url>` | bắt buộc | thư mục local hoặc URL HTTP(S), ≤4096 ký tự | đặt trước các option khác; quote đường dẫn có dấu cách |
| `--origin <http(s)-URL>` | — | 1 URL, ≤2048 ký tự, không khoảng trắng/ký tự điều khiển | chỉ đi với `--target <thư mục>`; tạo target **hybrid** (source snapshot + đúng 1 origin), chia sẻ một graph/report. Origin là starting label, không phải biên |
| `--workers N` | 3 | 1…`Number.MAX_SAFE_INTEGER` | trần worker đồng thời, không phải tổng assignment; `--max-depth 0` tắt delegation |
| `--max-depth D` | 2 | 0–3 | giữ cho tương thích: delegation luôn phẳng, worker không spawn con |
| `--round-steps N` / `--round-seconds N` | 40 / 900 | steps 0–200, seconds 0–7200; `0` tắt trục đó | ngân sách **một round** (work package), không phải trần campaign; wrap sớm ở 6 step cuối / 90% thời gian / 80% context, dừng cứng ở 92% context |
| `--executors MODE[:N]` | `shared` | `shared` \| `isolated` \| `session[:N]` (N 1–99) | shared mặc định tuần tự; isolated tách sandbox theo assignment; `session` giữ N container sống suốt run, N mặc định và trần là `--target-ops` |
| `--target-ops N` | shared 1 · isolated/session 3 | ≥1 | trần thao tác target đồng thời, không phải số worker/vòng planner. Shared chỉ nới khi nêu rõ N>1 (confirmation và ledger ghi lại) |
| `--mode MODE` | `exploit` | `exploit` \| `assess` | `exploit` cho phép access ladder; `assess` chỉ ghi exposure, từ chối intent khai thác và in một dòng thay cho ladder |
| `--effect CLASS` | mọi class trừ `availability-loss` | `confidentiality-read`, `integrity-write`, `availability-loss`, `authentication-bypass`, `code-execution`, `cross-tenant-read`, `sandbox-escape` | lặp lại được; **thay** bộ mặc định (thu hẹp, không cộng thêm), chỉ đi với `exploit` |
| `--goal "text"` | — | 1–600 ký tự, không ký tự điều khiển | mục tiêu bằng lời của operator; vào confirmation, prompt planner (dạng dữ liệu trích dẫn) và REPORT.md; không mở/thu hẹp scope |
| `--avoid "text"` / `--allow "text"` | — | lặp lại, tổng cộng ≤5 lần, mỗi lần 1–300 ký tự | `avoid` là constraint gửi kèm brief (guidance, không enforcement); `allow` là permission được ghi, deny vẫn thắng |
| `--identity <abs path>` | — | 1 đường dẫn tuyệt đối tới JSON, ≤64 KiB, ≤256 secret | kênh credential operator niêm phong; model chỉ thấy id/kind/label/scope. Là tiện lợi, không phải trần — xem [HTTP_TRANSPORT](HTTP_TRANSPORT.md) |
| `--policy <abs-path\|standard:NAME>` | — | 1 đường dẫn tuyệt đối tới file UTF-8 ≤256 KiB, hoặc `standard:OWASP-ASVS-L2\|OWASP-WSTG\|OWASP-Top10` | policy baseline operator ghi vào campaign frame `{kind,id,sha256,bytes}` lúc start; body ở lại host (không vào ledger/prompt/report), start preview và report in source + sha để operator đối chiếu. Claim demonstrated vi phạm policy cites `policyBasis=operator_contract` + `policyRef=<id>`; host chỉ nhận đúng id đã record. Standard là vocabulary đo, không phải permission hay checklist bắt buộc |
| `--callback <http(s)-URL>` | — | 1 URL tuyệt đối ≤2048 ký tự, không credential/fragment | fact về điểm đến ngoài băng mà target được kỳ vọng gọi; không mở listener |
| `--lab-network <name>` | — | tên docker network do operator tạo, 1–64 ký tự `[a-zA-Z0-9_.-]` | sandbox join network để listener trong session nhận được traffic target; không publish port, không tunnel |
| `--heartbeat-seconds N` | — | `0` (tắt) hoặc ≥120 | heartbeat trả phí: mỗi wake mở một planner round trong campaign frame |
| `--refer-workspace [latest\|all\|<run-id>,…]` | — | tối đa 10 run-id | đọc tối đa 20 run cũ cùng target làm context; không bao giờ là same-run evidence, không vào prompt |
| `--retention MODE` | `durable-local` | `durable-local` \| `ephemeral` | luôn hiện trong confirmation; không tạo store trước consent |
| `--export` | tắt | flag | thêm bản sao bounded redacted receipt/hash vào `.p2o-reports/` lúc cleanup (khác bundle `/p2o export`) |
| `--resume <run-id>` | — | id `run-…` | mở lại một run durable-local dưới cùng runId: giữ record, sandbox/worker mới, **không** phục hồi ticket/operation; source phải khớp snapshot đã niêm phong |

Số phải là số nguyên trong khoảng cho phép; giá trị sai bị từ chối, không tự clamp. Không có trần cho cả campaign (không
`--max-planner-rounds`, không trần lệnh/thời gian): round budget chỉ giới hạn một round làm việc, `--target-ops` chỉ là trần
đồng thời, không phải rate limiter hay egress firewall.

## Cấu hình (`~/.pi/agent/settings.json`, khóa `p2o`)

Merge vào file hiện có. Precedence: **CLI cho run đó → settings → mặc định**; settings chỉ đọc lúc start run mới; số sai
kiểu/ngoài khoảng quay về mặc định. Hộp xác nhận luôn xuất hiện — settings không thay consent.

| Khóa | Mặc định | Ghi chú |
|---|---|---|
| `maxWorkers` / `maxDepth` | 3 / 2 | như `--workers` / `--max-depth` |
| `plannerRound` | `{steps:40,seconds:900,wrapSteps:6,contextWrapPercent:80,contextHardPercent:92}` | ngân sách một round; `0` tắt từng trục; `--round-steps`/`--round-seconds` override cho run đó |
| `roundSessions` | `true` | mỗi round planner mở một Pi session mới và nhận round brief ≤8 KiB tất định (campaign frame, completion/demand, goals & proof, ready chain, workers, round facts, delta round trước, learned trong window, digest phần cũ) thay vì nối transcript — "bộ nhớ" của planner là ledger + brief, không phải hội thoại. `false` = round đến như follow-up trong session hiện tại: giữ được transcript nhưng context phình/compaction và brief tất định không còn là cơ chế chính. Settings chỉ đọc lúc start run mới |
| `plannerModels` | — | `{base?, escalate?, thinkingBase?, thinkingEscalate?}`, model id dạng `provider/model`. Round được route trước lượt đầu: base cho review/mapping/validation, escalate cho exploitation/chaining, chain step đã ready, primitive chưa nối hoặc hai round liền không đóng gì; model không resolve/set được thì giữ loadout hiện tại và ghi `planner.round-model-fallback` |
| `executorMode` | `shared` | `shared` \| `isolated` \| `session` |
| `maxTargetOperations` | 3 | trần target-op cho isolated/session; shared mặc định 1 và settings **không** tự nới shared của run mới |
| `commandPolicy` | 8 seed deny rule | `{rules:[{action:'allow'\|'deny'\|'ask', match:'<literal>', reason, kinds?:['shell'\|'net'\|'http'\|'send']}], disableSeeds:[…]}`; tối đa 20 rule; seed tắt được nêu tên trong report |
| `retention` / `storageQuotaMiB` | `durable-local` / 256 | quota 8–1024 MiB, gồm journal và finalization reserve |
| `artifactCaptureKiB` | 1024 | 1–8192; tổng prefix stdout+stderr capture mỗi thao tác trước khi cắt hiển thị 48 KiB |
| `graphCapacity` | 2 | 1–4; nhân trần graph mỗi run (5.000 asset rev · 10.000 assertion · 2.000 relation · 20.000 anchor · 40.000 provenance) |
| `autoReport` | durable: bật · ephemeral: tắt | ghi báo cáo tất định lúc run kết thúc |
| `reportRoot` | `<cwd>/.p2o-reports` | thư mục nhận `report-<runId>/` và `report-<runId>-final/` |
| `reportFormat` | `2` | `2` = báo cáo OWASP + `findings.json/csv` + WSTG checklist; `1` = bộ file gốc |
| `reviewIntegrity` | `annotate` | `off` \| `annotate` \| `enforce` (từ chối receipt không do assignee tạo, trừ khi review gửi `externalEvidence`) |
| `report` | — | `author`, `organization`, `team`, `classification`, `disclaimer` (mỗi trường ≤400 ký tự), in vào Provenance với nhãn operator-supplied, unverified |
| `roles.<role>.model` / `.skills` | xem `src/roles.ts` | model/skill mặc định cho recon, discovery, exploit, validation, reporting, general |

Các khóa cũ `toolGuidance`, `finishGate` không còn tác dụng và bị bỏ qua.

## Tự chủ: authorization, browser, identity

Consent lúc start là blanket cho cả run: mọi method/body/redirect hop, mọi host sandbox route tới (public, private,
link-local, cloud metadata, lab service do host publish), mọi account/identity/tooling công việc cần đều là work item bình
thường; `SCOPE` trong brief worker là starting label, không phải boundary. `blocked` nghĩa là **approach đã cạn**, không bao
giờ là "chưa được cấp quyền". Operator constraint (`--avoid`, `constrain`, command policy) vẫn thu hẹp tuyệt đối và sandbox
vẫn là blast radius duy nhất.

Browser có sẵn trong image (Chromium 150 + CLI `agent-browser` 0.26.0), không phải năng lực thiếu; identity có thể do
operator niêm phong qua `--identity`, hoặc worker tự tạo principal dùng một lần khi công việc cần. Chi tiết cách drive và
giới hạn redaction: [HTTP_TRANSPORT](HTTP_TRANSPORT.md).

## Vòng lặp tự động và round budget

Loop chỉ còn một chế độ: **tự động** (manual mode đã bị xoá — P18/D48). Worker report/proposal đã commit có thể tự mở một
lượt planner trả phí; pause/stop hoặc input người đang chờ chặn điều đó. Task đã dispatch vẫn được engine admit khi có slot
và prerequisite đã review. Polling bị cấm: planner kết thúc lượt bằng `wait` thay vì giữ lượt chờ, và heartbeat campaign
(mặc định 600 s) là wake có nhịp khi campaign còn nợ việc.

Planner **không giữ hội thoại giữa các round**: mặc định mỗi round mở một Pi session mới, round mở bằng round brief ≤8 KiB
tất định — campaign frame, completion & demand, goals/proof, ready chain, workers, round facts, delta round trước, section
"Learned this round" (claim/case/wall mà window vừa ghi, kèm source task + asset; có `--refer-workspace` thì thêm một dòng
prior-run context-only) và digest các record cũ hơn. Section ready còn in `Case chains (derived)` (P22/A3): chain của case đã
accepted + rated đúng revision hiện tại, kèm các link đã chạy (claim, effect, gained/needs) và typed capability mà link đã chạy
để lại chưa link nào sau đó consume — câu "left to chain" để planner viết successor row hoặc wall. Khối này là **rating
record, không phải plan**: nó không tạo plan row/task/case, không phải readiness input và không thỏa claim/cell/goal nào.
Một round mở mỗi wake (worker report/proposal đã commit, debt gateable, heartbeat) hoặc sau round trước;
khi host đang stream hoặc có input người đang chờ thì round ở lại session hiện tại và ghi `planner.round-session-fallback`.
Đổi session không làm mất dữ liệu: mọi record đã commit vẫn ở `<cwd>/.p2o-state/<run-id>/`; cái không mang sang là mạch suy
luận tự do và output tool không được ghi thành record. Backlog recon (asset chưa lập kế hoạch, cell chưa chạy, WSTG
suggestion, mapping chưa ghi) chỉ là planning signal chứ không phải việc owed, nên không tự mở round. Lưu ý: session của
round **cũng chính là session anh đang chat trong TUI**, nên mỗi round TUI mở một session mới; transcript cũ vẫn nằm trên đĩa
và `pi --resume` mở lại được để đọc, nhưng campaign không quay lại nó — muốn giữ mạch chat liền thì đặt `roundSessions:
false` (đánh đổi ở bảng cấu hình).

Mỗi round là một work package có ngân sách: mặc định 40 step / 900 s, bắt đầu wrap ở 6 step cuối, 90% thời gian hoặc 80%
context, dừng cứng ở 92% context. `--round-steps 0 --round-seconds 0` tắt cả hai trục. Ngân sách này **không** giới hạn
campaign: không có trần round/token/thời gian cho cả chiến dịch. Round đang chạy hiện số round, session, trạng thái ngân sách,
model được route và round fact mới nhất trong `/p2o status`. `p2o_loop` là tool của planner (`wait`/`blocked`,
thêm `hint`/`constrain` 3–300 ký tự, trần 24 hint và 12 constraint); trạng thái Engine đọc qua `p2o_workers` (snapshot
`status` đã bị xoá ở S1/B2), và đây không phải slash command; `wait` kết thúc lượt chứ
không kết thúc assessment — `wait` đầu tiên của round bị từ chối một lần kèm demand và legal next khi campaign còn
obligation chưa xong, round chưa ghi wall nào và intent vẫn đang chạy (legal next đặt wall trước: todo deferred/blocked dẫn
debt id, rồi dispatch, rồi `blocked`), lần hai được chấp nhận — một round ghi wall là tiến độ chứ không phải round stalled;
một round kết thúc mà không có tool call nào nhận tối đa hai nudge nhắc ghi lại kết quả;
`blocked` là quyết định dừng có chủ đích và chờ `/p2o resume`. Event được coalesce và không bảo
đảm đánh thức khi có input người đang chờ, run đã pause/stop hoặc campaign đã kết thúc.

## Tri thức bền và báo cáo

```text
/p2o checkpoint [lý do]
/p2o checkpoints [checkpoint-id]
/p2o artifact <artifact-id> [byte-offset]
/p2o open <run-id>
/p2o recover <run-id>
/p2o reconcile <run-id> [reason]
/p2o close
/p2o export /absolute/path/bundle
/p2o import /absolute/path/bundle
/p2o report export [absolute-dir]
```

- **durable-local**: `<cwd>/.p2o-state/<run-id>/` (0700/0600) giữ sau stop/finish; **ephemeral** xoá sau cleanup. Dữ liệu đã
  redact vẫn có thể nhạy cảm. Store không bao giờ được mount vào container.
- **checkpoint** là snapshot tại transaction boundary (hash, thiếu sót, review/gap đang chờ, thao tác in-flight);
  `integrity` (hash) khác `dataStatus` (partial khi capture thiếu/lossy/interrupted) và cả hai đều không phải evidence mới.
- **open/close** chỉ mở run bền đã có, read-only, không tạo Engine/worker/model turn; trạng thái running trong lịch sử là
  interrupted/unknown. **recover** rollback hot journal rồi mở read-only; **reconcile** ghi một record lifecycle liệt kê việc
  dở dang, không đổi task, không khôi phục authority.
- **export/import** là bundle redacted có manifest + SHA256 từng file, ≤64 MiB, đường dẫn tuyệt đối ngoài state root, không
  ghi đè; import verify rồi giữ bytes thành artifact bất biến + một note provenance — không phải same-run evidence.
- **report export** sinh `REPORT.md`, `cases.csv`, `coverage.csv`, `report-manifest.json` (và `findings.*`,
  `wstg-checklist.csv` khi có) từ state đã commit, không gọi model, không chạm target, ghi vào thư mục mới. Bản tự động lúc
  cleanup nằm ở `.p2o-reports/report-<run-id>-final/`; bản export tay mặc định `report-<run-id>/`. Thư mục nằm trong project
  nên **đừng commit**. Chi tiết nội dung/ladder/completion: [EVIDENCE](EVIDENCE.md).
- **Research debt** trong brief/report tách hai nhóm. **Nghĩa vụ gateable** (goal/plan/chain/triage… — 9 kind) là việc còn nợ:
  giữ completion, demand floor, debt wake và finish preflight sống, và mỗi item trong brief có một câu "discharge". **Planning
  signal** (`SCOPE_UNPLANNED_ASSET`, `CELL_NOT_RUN`, `WSTG_UNPLANNED`, `MAPPING_UNRECORDED`) chỉ là tín hiệu lập kế hoạch sinh
  ra từ recon: vẫn hiện trong report nhưng không phải việc owed và không tự đánh thức loop. Một goal mà run không thể chứng
  minh được settle `blocked` kèm lý do + exclusions, và report ghi **settled with debt** thay vì coi là goal còn mở.
- **Worker nhận gì và ghi gì:** brief của task đã dispatch mang thêm contract suy từ chính task record (asset id kèm revision
  đã pin, hai dự đoán IF TRUE/IF FALSE, stop condition, prerequisite), recipe `steps/observe/wall` của workflow được chọn khi
  catalog có, và role contract (worker là executor/author duy nhất; reporting là read-only) — tất cả là background của task
  record, không thêm quyền. Worker/validation prompt có ví dụ batch literal cho `p2o_graph_record` (assets trước vì fact cần
  `assetId`, assertion kèm `evidenceRefs`); luật ghi chép đầy đủ nằm ở `shared:recording` (một kết luận gộp mỗi intent, nghi
  ngờ là hypothesis/inferred fact chứ không phải finding, cross-asset link là assertion planner đọc được). `p2o_note`
  kind=coverage chỉ là display row: host derive coverage cell từ reviewed work, không từ note. Muốn tra vì sao một row tồn tại:
  `p2o_board board=lineage id=<planId|recordId>`; muốn xem projection "run vừa học gì": section learned trong round brief.
- **Bằng chứng host ghi lại (P21/A):** sau mỗi operation target được admit, host ghi replay unit — method, final URL, header
  (sort), body, hoặc command text thực sự được admit — vào file riêng 0600 của run, **trước** khi operator placeholder được
  thay, nên ledger chỉ giữ `{payloadRef, sha256, bytes, environmentFingerprint}` và không bao giờ giữ secret hay byte payload
  trong export; unit quá trần 48 KiB hoặc chứa control character là gap thấy được (`captured:false` kèm lý do), không làm hỏng
  request. Claim kế thừa stamp này từ receipt được cite, nên report in `host replay \`payload-…\`` thay vì "not replayable", và
  situation line có counter `replay: N replayable claim(s), M derived edges, K validation current` cùng `unmet needs`. Muốn
  validation độc lập, worker replay đúng request rồi ghi claim của mình với `reproduces=<claim-id|slug>` — host tự resolve
  claim gốc, đòi actor khác, cùng surface/risk, claim gốc demonstrated, receipt tested riêng và payload sha khớp. Containment
  suy từ anchor (host ← route ← endpoint) được đánh dấu `derived` trong graph/export và không phải evidence; claim negative
  không có control chỉ nhận warning `admissionWarnings` cạnh claims table, không bị từ chối.
- **Policy baseline (P21/B):** operator có thể ghi policy ngay lúc start bằng `--policy <abs-path>` hoặc `--policy standard:<name>`;
  host băm file (bounded 256 KiB, đọc một lần) và campaign frame giữ `{kind,id,sha256,bytes}`, không giữ body — body không vào
  ledger, prompt hay report, chỉ source + sha được in ở confirmation và report. Claim demonstrated vi phạm policy đã ghi cites
  `policyBasis=operator_contract` cùng `policyRef=<id>` (sai/thiếu id bị từ chối kèm id hợp lệ); case confirmed accept basis này
  cùng `explicit_contract`/`boundary_invariant`, còn `inferred` vẫn chỉ là observation. Rating depth, scope và authority không đổi;
  một run không `--policy` hành xử y như trước.
- **Research breadth và never-idle (P21/C):** round brief có section `## Unplanned work` và situation line có segment
  `breadth`: đếm asset chưa nằm trong cell nào được plan, câu hỏi WSTG chưa hỏi, gap chưa triage và capability need chưa ai
  đáp (sample ≤3 mỗi row). Một row khác 0 cần disposition: revise coverage plan, tạo intent có `questionKey` hỏi đúng câu đó,
  hoặc ghi exclusion; demand line nêu `the coverage plan owes a revision for N unplanned asset(s)` khi discovery thêm asset
  plan chưa cover, và quiet judgement tính feature/câu hỏi coverage mới là progress thay vì tuyên bố quiet. `p2o_wstg_suggest`
  trả thêm `queue` (≤20 cặp asset × test kèm `expectedObservation`, `planId`) — chỉ là gợi ý, không phải cell/claim/coverage.
  Section Ready của brief in frontier đang chờ kèm unmet capability needs để planner plan capability task thay vì thêm asset,
  và planner được khuyến khích dispatch nhiều task độc lập mỗi round (host nhận tới 25 intent mỗi call). Trước finish,
  preflight in `SETTLEMENT PACKET` cho mỗi debt kind còn nợ với disposition (plan task / out-of-scope / defer + `debtRefs`) —
  chỉ để thấy việc còn lại trước khi dừng, không gate finish và không đổi completion. Credential ladder nằm trong
  `shared:recording`: đọc public JS/source map/config được serve công khai, đúng một default-credential attempt có tên như đã
  ghi, tự đăng ký tenant/account, hoặc dùng `p2o_secret` của operator; cấm brute force, spraying, credential stuffing, reset
  abuse và lockout; không có cách nào thì ghi `needs: cred.secret` kèm các acquisition path đã thử.
- `--refer-workspace` chỉ thêm context read-only từ run cũ cùng target (khớp path/origin; `gaps` gồm covered, leftOpen,
  stale, neverReached, unknown) và không bao giờ tính là same-run evidence hay khôi phục authority. Round brief in các count đó
  thành một dòng "Prior run (context only, never evidence)"; muốn xem chi tiết vì sao một plan row tồn tại, planner dùng read
  bounded `p2o_board board=lineage id=<planId|recordId>` (row ≤24 KiB, background, không phải evidence).

## Dọn dẹp và sự cố

- Stop/finish revoke, huỷ thao tác, đóng pane rồi xác minh container đã gỡ. Hard-kill Pi hoặc mất Docker có thể để lại
  container/pane; không có gì tự thu hồi — chạy `/p2o stop` lại, hoặc `docker ps` để kiểm tra.
- Không start assessment thứ hai trên cùng lúc; stop run đang chạy trước khi `/reload` (ticket bind bytes extension).
- Pi khởi động lại sau khi crash: nếu workspace còn durable-local run, `session_start` chỉ hiện một hint read-only nêu
  `runId` và đúng lệnh `/p2o --resume <run-id>`. Chỉ lệnh p2o này mở lại knowledge dưới cùng runId; `pi --resume` chỉ
  phục hồi transcript, và không ticket, worker hay authority nào trở lại — việc dở phải được dispatch lại.
- Pi thoát giữa lúc chuyển round với `This extension ctx is stale after session replacement or reload`: đó là bug của
  progress widget rơi đúng cửa sổ đổi session (P19/H, sửa ở commit `46db381`). Cập nhật extension rồi chạy campaign mới;
  run đã crash không khôi phục ticket/worker/authority, chỉ mở để đọc bằng `/p2o --resume <run-id>`.
- Task kẹt `proposed` sau một dispatch bị từ chối: ledger có lifecycle fact `dispatch refused for <taskId>: <CODE>: …`
  (`data.engine = {event:'intent-blocked', taskId, code, reason}`) cùng mã lỗi mà planner thấy trong prompt; đây là wall
  của host, không phải task bị mất — sửa nguyên nhân (model/role setting, executor, prerequisite) rồi dispatch lại.
- Không có worker backend thì dispatch bị từ chối `DELEGATION_UNAVAILABLE`; pane provisioning lỗi thì task chuyển `blocked`
  kèm prerequisite thiếu.
- `PI_OFFLINE=1` làm `pi update` không làm gì nhưng vẫn in "Updated": unset biến đó cho lần chạy đó rồi kiểm tra revision.
- Lỗi storage đóng authority target; report ghi thất bại không chặn cleanup.

## Giới hạn chính

Target chỉ là thư mục local hoặc URL HTTP(S). Source snapshot ≤64 MiB / 20.000 entry (regular files, bỏ symlink, special
file, `.git`, `node_modules`). Container chạy root với rootfs ghi được, không trần pid/RAM/CPU, chia sẻ kernel host: là cô
lập container, **không phải** VM và không phải claim về kernel escape. Không có egress firewall; loopback là container-local;
`p2o_http`/`p2o_net` không bị lọc theo origin. Retention bị chặn (queue 100 intent, 1.000 registration, 256 pending signal,
quota/run) dù thời gian chạy không có trần. Report là đánh giá của agent: "independently verified" cần một worker khác tái
lập, và claim worker chưa được planner kiểm phải được ghi đúng như vậy.

### Sandbox: điều có thể dựa vào và điều không có

Đo 2026-10-27 trên đúng image pin và argv trong `src/sandbox.ts:17-19` (matrix đầy đủ:
[ARCHITECTURE](ARCHITECTURE.md#sandbox-capability-matrix)):

- **Container:** uid 0, `HOME=/root`, rootfs ghi được, giữ 14 capability mặc định của Docker (gồm `NET_RAW` nên raw
  socket/SYN scan chạy), không privileged, chia sẻ kernel host, không trần pid/RAM/CPU. `/target` là bản bind mount
  chỉ đọc; `/work` ghi được; không mount host path nào khác và không mount Docker socket.
- **Mạng:** bridge, egress không lọc — public, private, link-local, cloud metadata và service host publish qua
  `host.docker.internal` đều tới được; loopback là container-local. Mặc định **không có inbound**. Chỉ khi start với
  `--lab-network`, sandbox join network đó và `p2o_session action=listen` mở listener trong container (tối đa 4/session,
  TCP, ghi bytes và không bao giờ trả lời); không publish host port, không tunnel/pivot.
- **Foothold tương tác (A17.8/D40):** cũng chỉ trong `--lab-network`, `p2o_session action=foothold-open port=<port>` mở
  một foothold thật: relay do host sinh (không mở shell), accept **đúng một** peer rồi đóng listener — peer thứ hai không
  bao giờ vào được. Worker phải `foothold-identify` (probe cố định `whoami; id`) và identity được ghi lại trước khi
  `foothold-send`/`foothold-read` mở; tối đa một foothold/session, không cap per-send hay idle do foothold đặt (chỉ còn
  trần 32 KiB của lệnh shell trong sandbox, refusal nói rõ), preview 8 KiB cho model còn transcript đầy đủ nằm trong log
  để `p2o_capture` lấy; foothold sống qua các step và report, chết cùng session. Không publish host port.
- **Công cụ:** image có sẵn compiler, gdb, recon và Chromium/agent-browser; nmap có sẵn nhưng launcher bị file-capability
  chặn, copy `/usr/lib/nmap/nmap` vào scratch để chạy; tool thiếu thì cài vào scratch, còn
  `scripts/setup-sandbox-tools.sh --with` chỉ cài trước danh sách pin lúc build (angr, z3, binwalk, mitmproxy, unicorn, pwntools 4.15.0, strace, socat, ssh, afl++, radare2, tcpdump, java; python package pin chính xác, apt package chỉ pin bằng image ID). Đây là tiện ích operator, không phải capability gate: container đang chạy không đổi và agent vẫn tự cài được tool vào scratch.

| Trần | Giá trị | Enforce tại |
|---|---|---|
| Output hiển thị | 48 KiB | `src/process.ts:3` |
| HTTP body / payload lab / upload | 48 KiB mỗi loại | `src/target.ts:284`, `src/lab.ts:20`, `extensions/p2o/index.ts:1408` |
| Ghi scratch | 64 KiB mỗi lần | `src/scratch.ts:143` |
| Command | 32 KiB | `src/sandbox.ts:160` |
| Capture | đọc ≤8 MiB, lưu 1 MiB mặc định, preview 8 KiB | `src/scratch.ts:4`, `src/roles.ts:105`, `src/sandbox.ts:213` |
| Receipt | 16 KiB stdout / 4 KiB stderr | `src/evidence.ts:61` |

**Không được cấp** (đừng hứa trong prompt, tool description hay tài liệu):

- per-action consent: consent lúc start là blanket cho cả run (`src/truth.ts:28`);
- host port publish và inbound mặc định: sandbox chỉ join bridge trừ khi operator nêu `--lab-network`, và argv không có
  `--publish` (`src/sandbox.ts:17-22,100`, `src/truth.ts:18`);
- tunnel/pivot: listener chỉ log bytes và không trả lời, còn foothold là một kết nối reverse duy nhất do model điều
  khiển trong `--lab-network` (`src/foothold.ts`); không có port forward, proxy, SOCKS hay pivot subsystem;
- trần lệnh hay thời gian: `timeout` mặc định 0 (tắt) và chỉ khi opt-in mới áp; timeout fire thì sandbox bị retire
  (`src/target.ts:279-282`, `src/sandbox.ts:171-181`);
- cô lập kiểu VM hay kernel escape: đây là cô lập container, chia sẻ kernel host (`src/truth.ts:15`).
