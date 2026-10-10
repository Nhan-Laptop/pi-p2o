# Hoạch định p2o: output từng pha, checklog/checkpoint và knowledge graph

> **Trạng thái thiết kế: PROPOSED; checkout đã implement/nối một số slices K0–K6, chưa hoàn tất K0–K7 và chưa publish/install.**
> Baseline: p2o **0.5.0**, commit `e6390291cee071919ca260804080c434610726ce`.
> Tài liệu này thay roadmap cũ tại cùng đường dẫn, **không** tuyên bố các API/schema bên dưới đã tồn tại.
> Contract đã ship: [docs/PLANNER_ENGINE.md](docs/PLANNER_ENGINE.md). Acceptance baseline: [research/runtime/planner-engine/README.md](research/runtime/planner-engine/README.md).
> Triển khai đang diễn ra theo từng gate: [implementation status / ADR K0](docs/KNOWLEDGE_WORKSPACE.md). Scope mới được duyệt là K0–K7, durable-local mặc định với confirmation; không coi toàn bộ roadmap đã hoàn thành.
> Những link/hashes lịch sử trỏ đến bản plan trước phải được đọc tại commit tương ứng; không sửa acceptance cũ để hợp thức hóa plan mới.

## 0. Kết luận điều hành

**Không cần viết lại Planner/Engine/Worker một lần nữa. Cần nâng lớp state và sản phẩm người dùng nhìn thấy.**

p2o hiện đã có task board, ledger, evidence receipts, candidate revisions, worker reports, event-driven Engine và cleanup. Nhưng thông tin vẫn rời rạc, phần lớn phải yêu cầu model gọi tool mới thấy, và full ledger thường chỉ sống đến cleanup. Vì vậy người dùng có cảm giác “không có output, không biết đã làm gì, pha nào xong, có bị làm lại không”.

Thứ tự đề xuất:

1. **Hiển thị tiến độ và output ngay:** bảng task/worker, nhật ký sự kiện, bàn giao từng nhánh, review pending, lý do đang chờ.
2. **Lưu công việc bền vững:** checklog có thứ tự, artifact registry, checkpoint nhất quán, đọc lại sau stop/reload mà không phục hồi quyền thực thi.
3. **Asset Graph + Exploration Graph:** resource identity tách khỏi mục tiêu/câu hỏi/quan sát/kết luận. “Vuln Graph” là một view của Exploration Graph liên kết assets/evidence/reviews.
4. **Chống trùng đúng tầng:** chống ghi lặp, trùng asset, trùng assignment và trùng finding là bốn bài toán khác nhau; validation/retest hợp lệ không được bị chặn như việc thừa.
5. **Planner đọc tri thức có chọn lọc:** delta + outstanding review + known facts/counterevidence + frontier + kế hoạch dài hạn; không chỉ last-N task và chat history.
6. **Tháo nút thắt có đo lường:** phân trang, index, artifact spill, archive; không bỏ giới hạn bảo vệ hoặc tăng budget ngầm.

Đầu ra mong muốn của một run không phải chỉ một câu trả lời cuối, mà là một **hồ sơ assessment sống**, có thể trả lời:

- Scope và mục tiêu hiện tại là gì?
- Đã phát hiện tài nguyên nào, từ evidence nào?
- Đã hỏi/test câu nào, ai làm, phương pháp nào, trên phiên bản/actor nào?
- Cái gì chỉ được worker báo, cái gì đã review, cái gì thiếu proof?
- Tại sao chọn bước tiếp theo; tại sao không lặp bước trước?
- File/receipt/report nằm đâu; checkpoint nào còn nguyên và còn hiện hành?
- Run đang chờ worker, chờ review, chờ prerequisite, hết allowance hay lỗi storage?

### Quy ước bằng chứng

- **SOURCE-CONFIRMED:** đọc implementation trong snapshot hiện có; không đồng nghĩa đã chạy end-to-end.
- **DESIGN-INFERENCE:** chẩn đoán/hệ quả kiến trúc có cơ sở, chưa có đo lường người dùng hoặc benchmark.
- **PROPOSED:** schema, API, UX, thuật toán và ngưỡng nghiệm thu của bản cập nhật này.
- **UNVERIFIED:** chưa có bằng chứng đủ, nhất là hiệu quả pentest, giảm trùng ngữ nghĩa, chi phí, chất lượng findings.

Thiết kế mới từ §4 trở đi là **PROPOSED**, trừ chỗ ghi rõ baseline/source; trạng thái thực hiện authoritative nằm trong [implementation checklog](docs/KNOWLEDGE_WORKSPACE.md), [store contract](docs/STATE_STORE.md) [graph K3](docs/ASSET_GRAPH.md), [work/planning K4](docs/WORK_ADMISSION.md), [case/coverage K5](docs/CASE_REVIEW.md), [indexed context K6](docs/CONTEXT_PACKETS.md) và [acceptance matrix K7](docs/ACCEPTANCE_MATRIX.md). Không suy từ slice đã code sang việc mọi API/schema/gate trong thiết kế đã có. Ví dụ thiết kế là fixture giả định, không phải một cuộc kiểm thử thật.

---

## 1. Phạm vi nghiên cứu và provenance

### 1.1. Nguồn thực tế

File người dùng nhắc được tìm thấy tại `my_references/ARTEX/ARTEX_AGENTIC_CORE.vi.md`, không phải trực tiếp dưới `my_references/`. Đã đọc đủ 1.364 dòng và đối chiếu các implementation trọng yếu bên dưới.

- SHA-256 bài phân tích: `db70fdd06bda7994f9cb07f6deaccea8ca86c4dbfd3294441cde1bd1e8cc91fa`.
- Manifest reference: `my_references/ARTEX/research_sources/source_manifest.json`.
- Đối chiếu **332 file trong manifest: 0 thiếu, 0 lệch hash**. Điều này chứng minh tính nhất quán với manifest local, không xác thực tác giả/upstream và không phải 332 file đã được audit từng dòng.
- Nhãn ARTEX 0.3.15/norma v0.4.3 lấy từ snapshot/bài phân tích; không tự khẳng định deployment hay commit upstream đã xác thực. Kết quả 404 upstream là ghi nhận trong nghiên cứu trước, không phải kiểm tra mạng mới ở lượt này.
- Đã đọc toàn bộ **20 module `src/*.ts` và `extensions/p2o/index.ts`** của p2o; đọc contract/docs và các regression liên quan. Với ARTEX, kiểm kê cây source rồi trace core storage/planning/worker/activity/finding/digest và một số UI paths; không tuyên bố audit toàn bộ frontend/vendor/security surface.

Reference là **dữ liệu không tin cậy, chỉ đọc tĩnh**. Không chạy ARTEX/norma, không import/build source reference, không thêm dependency từ reference, không dùng IP/credentials/campaign artifacts làm mục tiêu. Không chạy assessment/paid benchmark trong công việc hoạch định này.

### 1.2. Phân biệt ba loại graph

1. **GitNexus code graph:** phục vụ đọc source và impact analysis trong repo phát triển.
2. **Asset Graph runtime:** tri thức về tài nguyên của assessment được phép.
3. **Exploration/Vulnerability Graph runtime:** công việc, kết luận, evidence và quan hệ của assessment.

GitNexus không tự cung cấp graph assessment. Tạo thêm edge trong graph code không làm Planner nhớ assets/vulns tốt hơn.

Graph query/context đã dùng để tìm đường đọc; kết quả có nhiễu từ reference lớn, một số liên kết tên phổ thông xuyên file không đúng ngữ nghĩa, và thiếu process coverage cho p2o. Vì vậy kết luận implementation dựa thêm vào source trực tiếp, không coi đồ thị là proof. Impact của `planning_update.md` trước khi tạo trả `UNKNOWN/target not found` vì file đã bị xóa; đã kiểm tra các liên kết từ README, contract, acceptance và package manifest. Lượt này chỉ thay tài liệu, không chỉnh executable code.

---

## 2. Chẩn đoán p2o 0.5.0: có gì, thiếu gì?

### 2.1. Không đúng nếu nói “hoàn toàn chưa có log/output”

| Nhu cầu | SOURCE-CONFIRMED trong baseline | Thiếu/gây khó sử dụng |
|---|---|---|
| Tool output | `output()` trả exit/output/Evidence ID; `EvidenceStore.receipt()` ghi observation | Output bị cap; không có artifact store giữ phần đã mất; không có bảng output theo pha |
| Nhật ký | `records.jsonl`, 10 record kinds, lifecycle/note/evidence/task/report | Trộn audit và knowledge; không có durable typed checklog/correlation thống nhất |
| Tiến độ worker | `ProgressState` ghi queued/running/returned/error/reported; `p2o_workers` truy vấn | Map chỉ giữ latest event mỗi actor; không phải lịch sử, chưa có persistent widget |
| Task completion | `TaskBoard`: proposed → reserved → running → reported → reviewed → closed, kèm blocked/cancelled/expired | Task board chưa dễ xem trực tiếp; reported/worker complete rất dễ bị hiểu nhầm là reviewed |
| Handoff | Report chuẩn hóa, hashed parts + manifest; coverage/open items được ghi | Findings/evidence trong WorkerReport còn arrays of strings; không có typed output contract theo nhánh |
| Candidate | Policy basis, evidenceRefs, negativeControls, supersedes, independent currentness | Identity do model đặt; chưa có asset/fact/hypothesis graph hay semantic duplicate review |
| Chống cùng làm | Reserve serialize; active overlap theo trimmed surface + normalized risk; validation exception | Đổi alias có thể lọt; hai phương pháp khác trên cùng surface/risk có thể bị chặn quá rộng; lịch sử completed không phải khóa dedup |
| Planner state | Request-local capsule + engine delta/frontier + 10 task cuối; wait/blocked có provenance | Chưa có goal tree, durable strategic todo, indexed retrieval theo asset/question/fact |
| Stop/report | `freezeReport()` tạo bounded projection; `--export` giữ ledger JSON | Không có checkpoint giữa run; full temporary records bị xóa khi cleanup nếu không export |
| UI | Status target/worker, notify, tool text/details, pane thật | Không có `/p2o status/tasks/log/checkpoints`, phase card, checklist output hoặc renderer riêng |

**DESIGN-INFERENCE:** vấn đề lớn là thiếu một “mặt tiền vận hành” và domain model thống nhất, không phải thiếu mọi primitive. Thêm prompt “hãy ghi log” sẽ không giải quyết retention, canonical identity, race, currentness hay UI.

### 2.2. Các điểm source cụ thể cần đưa vào backlog

1. **Note không trả record ID:** `appendRecord()` tự sinh ID nhưng trả `void`; `p2o_note`/broker `note` chỉ ACK. Description nói ID dùng để link, nhưng caller phải đọc ledger để tìm lại. API ghi mới phải trả `{id, revision, sequence}` sau commit.
2. **Progress mất lịch sử:** `src/progress.ts` giữ latest event/command count/last problem, không giữ các cặp tool-start/tool-end. Không suy ra một operation đã xong chỉ từ actor chuyển trạng thái.
3. **Chưa có security phase state:** `Phase = starting|active|stopping|finished` trong extension là lifecycle tài nguyên, không phải recon/discovery/validation/reporting.
4. **Report chưa phải atomic assessment packet:** `persistReport()` commit parts/manifest trước các task/coverage/open writes; transition task được `.catch(() => {})`. Broker đã có thứ tự ACK/revoke/notify, nhưng nhiều write không phải một transaction chung. Lỗi giữa các bước cần packet status/recovery rõ, không được UI tuyên bố mọi nhánh đã đồng bộ.
5. **Finish không phải chứng nhận hoàn thành nghiên cứu:** `p2o_finish` chặn queued intents và workers chưa report, nhưng không yêu cầu tất cả task đã reviewed/closed. Đây là operational finish; cần thêm outcome `completed|partial|blocked|cancelled|incomplete` cho assessment, không cấm người dùng stop khi còn gap.
6. **Lưu trữ ngắn hạn:** cleanup xóa control directory kể cả export lỗi; export cap 16 MiB nhỏ hơn ledger read bound 64 MiB. Cần tách evidence retention khỏi ticket/socket/scratch cleanup và biểu thị retention failure.
7. **Đọc lặp toàn ledger:** task mutation/readiness/worker objective/candidate/export dùng `readLedger()`. Context owner còn gọi `board.list()` nhiều lần. Cost tăng theo history; chưa có incremental index.
8. **Budget coordination có thể bóp phần graph mới:** worker dùng chung counter 200 cho skill/note/candidate/proposal, knowledge dừng ở 160; owner knowledge 400. Không nhét hàng loạt asset/fact writes vào đó mà không đo và thiết kế reserve cho report/checkpoint.
9. **Coverage hiện là entry counts:** có thể có note coverage rồi report coverage cho cùng nội dung. `coverageTotal` không phải số test cells duy nhất, không phải % assessment an toàn.
10. **Liveness và result khác nhau:** pane idle, tool exit 0, worker reported, receipt persisted, review accepted, goal satisfied là sáu điều khác nhau.
11. **Capsule không có toàn bộ known knowledge:** task gần nhất không đủ ngăn một worker khác tìm lại endpoint/fact đã có ở lịch sử sâu.
12. **Output checksum không cứu phần đã truncate:** process capture cap 48 KiB; receipt lưu input 2.000, stdout 4.000, stderr 1.000 ký tự rồi bound JSON bytes. Hash receipt được tính trên output truyền vào store, có thể đã truncated ở process layer; không gọi đó là hash của toàn bộ output ban đầu.

### 2.3. Không được làm mất phần đã ship

Giữ nguyên mặc định manual/shared; event-driven opt-in; Planner delegated không target-execute; solo vẫn thực thi; Worker không tự dispatch/review; reporting synthesis-only. Giữ fresh ticket/session mỗi assignment, runtime mismatch gate, reviewed prerequisite revisions, cancellation/revocation, verified cleanup và source snapshot consistency.

Không đưa trở lại worker cap sáu hoặc cumulative `2× maxWorkers`. Không thêm assessment TTL, worker TTL, default command timeout, hidden retry/provider fallback, model heartbeat hay buộc sinh việc khi hết hướng khả thi. Full HTTP/network hiện có vẫn phải giữ.

---

## 3. ARTEX thật sự làm gì, nên học phần nào?

### 3.1. Asset Graph: identity + attributes + relational projection

**SOURCE-CONFIRMED** qua `db/schema.sql`, `db/assets.go`, `agent/tools_insert.go`, `db/task_scope.go`:

- Sáu asset types: `root_domain`, `ip`, `subdomain`, `app`, `service`, `endpoint`.
- Ports, technology, credentials, params là fields/arrays trong snapshot này; không phải tất cả đều là node riêng.
- Natural unique keys và SQL upsert làm hard dedup tài nguyên: endpoint `(url, method)`, HTTP service `url`, IP `ip`, subdomain `(domain, record_type)`…
- `insert_assets` do agent gọi tường minh; handler runtime gán task identity, normalize/merge, anchor vào intent và ghi source metadata.
- `BuildCoverageGraph()` dựng **child → parent containment view** từ fields; không có persisted asset-edge table tương đương exploration edges. Chọn parent đại diện, không mô tả đủ mọi DNS/network relationship.
- Asset discovery có các đường `AddAutoScope`; **không sao chép vào p2o**. Phát hiện asset khác origin không cấp quyền kiểm thử nó.

**Bài học:** canonical ID dùng chung + provenance + scoped retrieval quan trọng hơn chọn graph database hay vẽ sơ đồ đẹp. Cần thêm source-code assets cho p2o; bê nguyên sáu type thiên network sẽ không đủ.

### 3.2. Exploration Graph rộng hơn “Vuln Graph”

**SOURCE-CONFIRMED:** `exploration_nodes`, `exploration_edges`, `exploration_anchors` lưu goals, intents, facts, findings, hints, digests và legacy begin. Các đường hiện tại:

```text
origin fact ──spawns───────> goal
origin/fact/finding ──derived_from──> intent
intent ──yields───────────> fact hoặc finding
fact/finding ──proves─────> goal
digest ──covers───────────> member nodes
node ──anchor────────────> asset
```

- `addOneIntent()` chỉ chấp nhận parent kind fact/finding; không phải DAG scheduler tổng quát.
- `Frontier()` priority DESC, ID ASC; `ClaimIntent()` atomic open→running chống hai worker claim **cùng intent**, không chống hai intent có cùng ý nghĩa.
- `record_fact` ghi observation/kết luận âm tính; fact state `confirmed` không bảo đảm payload observed hay evidence đã được kiểm chứng.
- `RecordFindingTx()` gom finding node + standalone finding row + anchors + yields + traffic binding trong transaction. `finding_id` khác `finding_node_id`.
- Standalone findings có triage status (`pending`, `confirmed`, `fixed`, `duplicate`…); state của exploration finding không phải cùng lifecycle với triage.
- Handler `report_finding` không tự tái hiện để xác minh bug. `prove_goal` không phải oracle kiểm tra nội dung proof.
- Một số intent/fact/proof paths link riêng và bỏ qua lỗi; không suy ra mọi edge luôn atomic chỉ vì finding path có transaction.
- Schema cấm self-loop nhưng không enforce acyclic toàn graph. p2o phải giữ cycle checking của task dependencies hiện có.

**Bài học:** giữ riêng resource, fact/hypothesis, task, candidate, review và goal. Không đồng nhất “recorded” với “true” hoặc “done” với “verified”.

### 3.3. Giao việc và context

**SOURCE-CONFIRMED:** `Planner.Plan()` nhận trigger + bounded overview + shared TodoStore; model tạo natural-language intent. Worker nhận một intent + target assets + overview, tự chọn tactical steps/tools.

- Planner fresh Session mỗi wake; todo qua rounds nằm trong map của process, **không phải durable DB-backed todo**.
- Worker transcript stable theo intent và có Resume; không suy ra reuse session an toàn giữa mọi assignment.
- Overview có open/running/recent done, facts, findings, goals, digests, linked source tasks; retrieval drill-down qua IDs.
- Open intents cap 30, recent facts 20, recent done 12, finding details 10; một số “total” dựa read cap 1.000. Đây là lý do phải ghi count semantics rõ.
- Fact/asset write không tự wake mọi lần; report finding và worker completion có callbacks. Engine có heartbeat riêng. Không sao chép heartbeat trả phí vào p2o.
- Prompt yêu cầu tránh lặp và dùng todo nhưng **không có semantic unique constraint tổng quát** trên intent/finding trong các paths đã trace.

**Bài học:** làm cho Planner có thông tin để quyết định, cộng exact admission checks ở Engine; không hứa graph tự tìm ra next target tối ưu hoặc triệt tiêu việc lặp.

### 3.4. Checklog, output và digests

**SOURCE-CONFIRMED:** `agent/capture.go` bắt tool-use/tool-result/text/result/usage; `server/engine.go::emitActivity` append rồi publish; UI sessions ghép history/live events theo sequence. Broadcaster có thể drop khi buffer đầy, nên DB + cursor catch-up mới là nền tảng, không phải notification in-memory.

- Planner có round marker; output không chỉ nằm trong final finding.
- Worker artifact directory theo task/intent; large-output spill có đường lưu và đọc lại.
- Asset graph, exploration graph, sessions, findings là các view khác nhau, không một màn hình “mọi thứ”.
- Cold digest là projection có member IDs/content version; original nodes còn tồn tại và có expand path.
- Compaction có LLM call riêng, có thể chạy background; **không sao chép thành hidden paid service**.

**Bài học:** audit event và domain knowledge là hai lớp. Tóm tắt/diagram không thay thế raw evidence. p2o không cần copy thinking trace; chỉ lưu action metadata, observations, decision summaries được công bố và evidence references.

### 3.5. Những thứ không nên bê nguyên

| Không bê nguyên | Lý do / hướng p2o |
|---|---|
| Global assets mặc định mọi task dùng | Namespace theo workspace/engagement, explicit cross-run import; tránh lẫn tenant/project |
| Credentials plaintext vào `assets.auth` | Chỉ actor label/secret handle; không đưa credential value vào graph/context/checklog |
| Auto-scope từ asset insertion | Discovery ≠ authorization; gate target vẫn dựa human confirmation |
| `confirmed` ngay lúc report | Giữ candidate claim/proof/review/currentness độc lập |
| Coverage = asset có fact anchor | Chỉ là touched proxy; dùng test-cell coverage có method/actor/version |
| Phải sinh intent khi frontier rỗng | `wait`, `blocked`, `human-needed`, partial finish đều hợp lệ |
| Todo in-process là “checkpoint” | Durable plan/checkpoint phải có commit/version/digest và đọc lại sau restart |
| Silent link errors / giả định mọi write atomic | Transaction + idempotency + explicit incomplete packet |
| Full transcript hoặc toàn graph vào prompt | Bounded projections + retrieval, không mất access tới history |
| PostgreSQL/Next.js như prerequisite bắt buộc | p2o là extension local; storage adapter nhỏ và TUI trước |
| Permission bypass, automatic retry/resume | Giữ các boundary/lifecycle hiện hành của p2o |

---

## 4. Kiến trúc đích: một state store, nhiều views

```text
Human: scope + goals + persistence consent + limits + stop
                    │
             Owner authority (live)
                    │
          Planner ↔ AssessmentEngine ↔ fresh Workers
                    │ broker / owner writer
                    ▼
             AssessmentStore (canonical)
        ┌───────────┼──────────────┬──────────────┐
        │           │              │              │
     event log   asset records  exploration    artifact refs
     checklog    + relations    + candidates   + evidence
                                + reviews
        └───────────┼──────────────┴──────────────┘
                    ▼
     deterministic projections + indexed retrieval
       ├── human: status / tasks / log / phase cards
       ├── Planner: delta / todo / gaps / known work
       ├── Worker: assignment packet / relevant knowledge
       ├── graph views: assets / exploration / vulnerabilities
       └── checkpoint / report / archive
```

### 4.1. Quyết định thiết kế

- **Một nguồn canonical.** Không thêm ba JSON files mutable với trạng thái khác nhau; UI, model và report đọc cùng `asOfSequence`.
- **Tách knowledge khỏi authority.** Store ghi lại run history; không lưu usable tokens/cookies/socket authority và không mint lại ticket khi replay.
- **Owner là writer của assessment state.** Worker gửi structured mutations qua broker; server gắn run/task/worker identity. Chuyển lifecycle append trực tiếp lúc worker startup sang broker event, thay vì để nhiều process tự ghi canonical log.
- **Không có graph writer LLM ẩn.** Worker/Planner submit typed assertions; host validate, normalize, resolve IDs, commit. Parser deterministic chỉ extract dữ liệu có nguồn, không nâng output thành vulnerability.
- **TaskBoard và Engine tiếp tục là cơ chế điều phối.** Exploration view tham chiếu chính task IDs/revisions, không nhân đôi một hệ intent state khác.
- **Vuln Graph là view**, không thêm một finding store độc lập cạnh `p2o_candidate` gây hai nguồn sự thật. Có thể thêm metadata finding/case, nhưng proof revision vẫn nối về candidate/evidence/review canonical.
- **Không ép pipeline toàn cục tuyến tính.** Recon của nhánh B có thể song song validation nhánh A; phase nằm trên workstream/task/artifact, còn run có overview tổng hợp.

### 4.2. Lựa chọn storage

**Khuyến nghị:** local SQLite-backed `AssessmentStore` với single owner writer, transaction cho domain mutation + event + outbox. JSONL/Markdown/graph exports là định dạng trao đổi/view, không phải replica writable thứ hai.

Lý do: cần atomic multi-entity write, index unique keys, historical lookup, snapshot query, stable cursor và checkpoint. Chưa cần Neo4j/PostgreSQL hoặc network service.

**Gate trước implementation:** spike driver tương thích Node/Pi đang hỗ trợ, jiti load, package distribution, crash/disk-full, sync latency và WAL. Không mặc nhiên dựa vào một `node:sqlite` API/flag/version chưa test. Driver/build/dependency trade-off phải chốt bằng ADR; nếu không đạt, phase UI dùng adapter ledger v2 trong khi storage gate còn blocked, không lén triển khai dual-write không atomic.

Canonical layout đề xuất khi người dùng chọn durable mode:

```text
<private-p2o-data>/engagements/<engagement-id>/
  manifest.json                 # schema, project identity, retention policy
  assessment.sqlite            # canonical event/domain state
  artifacts/<artifact-id>      # immutable bounded retained bytes
  checkpoints/<checkpoint-id>/ # immutable snapshot manifest + rendered summary
  reports/<report-id>/         # deterministic index + reviewed narrative
```

Control directory/tickets/socket/executor scratch vẫn riêng và bị cleanup. Durable store không mount vào target sandbox. Root 0700, files 0600; đường dẫn sinh bởi host, không nhận host path tùy ý từ model. User phải biết data ở đâu và retention mode ngay khi confirm.

---

## 5. Domain model tối thiểu

### 5.1. Identity và revision

Mọi entity cần ID opaque ổn định; label ngắn để UI hiển thị. Revision identity khác entity identity. UUID baseline được giữ qua adapter; không renumber evidence chỉ để đẹp.

Common metadata:

```text
id, revision, engagementId, sourceRunId, createdSequence, updatedSequence
producer { workerId?, taskId?, operationId?, actor: owner|worker|system }
provenance { evidenceRefs[], artifactRefs[], importedFrom? }
validity { current|stale|superseded|withdrawn|unknown, reason? }
```

Foreign references bị kiểm tra theo namespace/explicit import policy. Không chấp nhận worker tự gán `producer=owner`, run ID hay review quyền cao hơn.

### 5.2. Asset Graph

Tối thiểu hỗ trợ cả URL và source assessment:

| Type đề xuất | Identity / ví dụ | Ghi chú |
|---|---|---|
| `host` | domain hoặc IP canonical có namespace | Không tự resolve/probe để tạo node |
| `service` | host + transport + port + logical service identity | Same IP không đồng nghĩa same app/tenant |
| `endpoint` | origin + exact path + HTTP method; identity policy versioned | Method custom giữ semantics; route template là grouping riêng |
| `source_component` | source snapshot + relative path + symbol/location | Không tự coi source handler là deployed endpoint |
| `data_resource` | typed resource key trong app/namespace | Collection/topic/object class khi evidence cho phép |
| `principal` | operator-defined actor/tenant/role label | Không lưu bearer token/password/cookie value |

Technology/parameter hints là attributes có provenance; chỉ tách node khi cần relation/query riêng. `in_scope` là view từ **live scope policy**, không field model có thể set để cấp quyền.

Relations đề xuất: `contains`, `resolves_to`, `exposes`, `implemented_by`, `consumes`, `authenticates_as`, `alias_of`. Mỗi edge có type, source, evidence/assertion status; không suy ra network reachability/authorization từ containment. Alias cần review và có undo, không merge destructive.

**Normalization thận trọng:**

- Lowercase host/scheme và chuẩn hóa default port theo contract transport; giữ raw observed spelling riêng.
- Không lower path, không decode percent-encoding tùy tiện, không bỏ query values/order hoặc collapse `/a` với `/a/` một cách tổng quát.
- Giữ exact request variant có query/body/actor trong operation/test-case record; endpoint grouping không được làm mất sự khác biệt cần kiểm tra.
- `/objects/1` và `/objects/2` có thể cùng route template nhưng khác object ownership. Grouping ≠ exact identity ≠ coverage equivalence.
- Non-standard HTTP method spelling không bị uppercase chỉ để dedup nếu transport giữ nguyên token đó.
- Secret-bearing URL/attribute phải redact hoặc dùng opaque handle; không dùng secret làm public key/hash dễ dò.
- Source component identity gắn snapshot hash; đổi code làm facts/tests liên quan stale, không chỉ update timestamp.

### 5.3. Exploration Graph và goal/todo

Nodes tối thiểu: `goal`, `task`, `fact`, `hypothesis`, `candidate`, `review`, `decision`, `gap`, `checkpoint`, `digest`.

- `task`: chính entity từ TaskBoard, không tạo queue thứ hai.
- `fact`: assertion có support; classification `observed|inferred`; review riêng `unreviewed|accepted|disputed|withdrawn`. Negative observation ghi điều kiện kiểm tra, không nói tuyệt đối “không có bug”.
- `hypothesis`: câu hỏi cần kiểm chứng, predicted contrast, linked facts/asset IDs; có thể bị disproved hoặc remain open.
- `goal`: acceptance criteria + explicit exclusions + current reviewed support. Goal satisfaction không được tính chỉ bằng finding count.
- `decision`: lý do ngắn, inputs/revisions, options đã xét, chosen/deferred task IDs, revisit condition; không yêu cầu lưu hidden chain-of-thought.
- `gap`: thiếu account/browser/dependency/policy/scope/proof, owner action cần thiết và workstream bị ảnh hưởng.
- `plan/todo`: durable strategic steps tham chiếu goals/tasks/gaps; status được derive từ review hoặc ghi attribution, không có checkbox tự “chứng minh” completion.

Relations đề xuất và hướng:

```text
goal ──decomposes_to──> subgoal
fact/hypothesis ──motivates──> task
task ──depends_on──> prerequisite task@revision
task ──produces──> fact/candidate/artifact
evidence ──supports|contradicts──> assertion@revision
review ──reviews──> candidate/task@revision
accepted result ──satisfies──> goal@revision
candidate ──affects──> asset
entity revision ──supersedes──> older revision
candidate ──duplicate_of──> canonical candidate
digest ──summarizes──> member@revision
```

Không enforce DAG cho mọi edge: contradictions/asset relations có thể cyclic. Enforce acyclic cho task dependencies, goal decomposition và duplicate canonical chain. Edge tới version không tồn tại hoặc namespace không được phép phải bị từ chối atomic.

### 5.4. Candidate/vulnerability case

Giữ các axes baseline `closure`, `execution`, `proof`, `policyBasis`, controls, limitations, supersedes và independent support. Bổ sung:

- stable case ID; asset/component IDs, hypothesis ID và root-cause key **nếu biết**;
- task/attempt/operation IDs và exact claim revision;
- `reviewStatus` tách khỏi worker `closure` claim;
- `duplicateOf`, related cases, affected variants, contradictory evidence;
- report content version và evidence version đã đọc;
- remediation/retest status riêng, không “fixed” chỉ vì text report được cập nhật.

Worker `closure=confirmed` hiển thị **“claimed confirmed — pending review”**, không tự “verified”. Static trace vẫn có giá trị với label static; không giả vờ runtime và không bắt mọi source finding phải có live exploit. Independent badge chỉ có khi separate validator, matching current claim, method/result và receipts đạt contract hiện có; cùng receipt copy lại không được tính độc lập.

Report có thể partial hoặc blocked và vẫn là output hợp lệ. “Không tìm được finding” cũng phải có test coverage/gaps, không ép sinh bug.

### 5.5. Coverage matrix

Coverage cell:

```text
(asset/variant, security question or risk family, actor/tenant,
 method family, relevant target revision/environment)
```

Giữ hai axes riêng:

- execution: `unplanned|planned|running|attempted|tested|blocked|not_applicable`;
- assessment: `unreviewed|confirmed_claim|ruled_out_bounded|open_gap|accepted|stale`.

Mẫu số là test cells trong **assessment plan version**, không “mọi bug có thể tồn tại”. Hiển thị thêm discovered-but-unplanned assets và unknown scope, để 100% planned cells không bị hiểu thành toàn hệ thống an toàn. Denominator đổi phải có event; blocked/waived không tự tính tested. Coverage notes legacy vẫn xem được nhưng không tự migrate thành accepted test cells.

---

## 6. Output contract cho từng pha/nhánh

### 6.1. “Hoàn thành” phải nói rõ hoàn thành cái gì

```text
command returned ≠ observation understood
worker reported ≠ task reviewed
task closed ≠ vulnerability confirmed
candidate reviewed ≠ entire goal satisfied
checkpoint committed ≠ state still current
resources cleaned ≠ assessment complete
```

Mỗi phase packet cần `packetId`, task/attempt/revision, status, evidence/artifact refs, new/reused IDs, limitations, review state, next eligible actions và `asOfSequence`.

| Pha | Output phải có | Điều kiện báo phase completed | Output khi thiếu điều kiện |
|---|---|---|---|
| Scope/bootstrap | Scope manifest, target identity/snapshot, goals/exclusions, executor/retention/budget profile | Human confirmation + setup verified | setup failed/cancelled, không tự bắt đầu |
| Recon theo surface | Asset inventory delta, observed/inferred facts, entry/actor/boundary map, unknowns, ranked question queue | Bounded recon objective được bàn giao/review, không cần map toàn target | partial map + missing prerequisite/gaps |
| Planning | Durable decision + linked todo/task IDs + reused knowledge + dedup disposition | Accepted plan delta hoặc wait/blocked có lý do | No feasible next action/human-needed |
| Investigation | Hypothesis/test attempts, positive/negative observations, controls, receipts/artifacts, candidate/gap | Đáp ứng stop condition và có handoff; review vẫn riêng | partial-budget, blocked, provider error, no-result |
| Validation | Case revision checked, independent observations/control matrix, reproducibility limits, verdict | Evidence review theo mức proof thực tế | inconclusive/disputed/stale, không nâng claim |
| Reporting | Human report + machine-readable index + coverage/gaps + linked current reviews | Snapshot reconciled; all required review criteria met hoặc explicit partial label | draft/partial report có missing IDs/reasons |
| Stop/cleanup | Final checkpoint, retention status, revoked tickets, pane/container cleanup status | Resource removal verified; outcome assessment ghi riêng | cleanup unresolved và hướng retry, không mất gap |

Phase packets là **materialized views từ canonical records**; không buộc model viết lại 7 files text ở mỗi bước. Chỉ packet đủ nghĩa mới publish; incremental events vẫn thấy ngay. Empty result ghi `no-new-information` với scope/method/limitation, không tạo fact rỗng để qua gate.

### 6.2. UX trước graph canvas

Các slash commands dưới đây **chưa có ở baseline**:

```text
/p2o status                   # trạng thái hiện tại, không gọi model
/p2o tasks [filter]            # live / awaiting-review / blocked / done
/p2o task <id>                 # assignment, attempts, artifacts, history
/p2o log [since]               # committed checklog, stable cursor
/p2o assets [query]            # inventory và evidence-linked relations
/p2o findings [query]          # claim/review/duplicate/stale phân biệt rõ
/p2o checkpoints               # list/inspect, không resume authority
/p2o checkpoint [label]        # tạo snapshot tại commit barrier
/p2o report                   # xem latest report/draft, không gọi model ngầm
```

Widget gọn (số liệu minh họa):

```text
P2O run-R · ACTIVE · manual/shared · state @184
Tasks 12: queued 2 | running 2 | review 3 | blocked 1 | closed 4
Assets 18 | hypotheses 5 | cases 2 pending / 1 reviewed / 1 stale
Last: T7 handoff committed → review required
Checkpoint C4 @170 · 14 events newer · durable OK
Next: review T7; T9 waiting on T7@r3; user action: test actor B
```

Mặc định hiển thị counts/last meaningful event/next blocker/output location; drill-down theo ID. Không spam mọi token/stdout vào chat. Mỗi phase packet có một card được update theo revision, không append vô hạn cùng một nội dung.

**Pi integration:**

- TUI: `ctx.ui.setStatus`, `setWidget`, custom command screen; dùng width helpers, handle Unicode/resize, không thay editor/footer của extension khác.
- Non-context durable session marker: `pi.appendEntry` + entry renderer, chứa IDs/summary/pointer. Không dùng `sendUserMessage` để cập nhật progress UI, vì nó có thể kích model turn.
- Model context: request-local projection qua hook đang có; renderer không quyết định permission.
- JSON/RPC: structured status/events và readable tool results; không phụ thuộc custom TUI. Start confirmation giữ contract UI/RPC hiện có.
- Session marker không thay external assessment store. Tree/fork chỉ đổi conversation branch; không rewind side effects hay phục hồi workers.
- Không network dashboard mặc định. Web graph là bước sau, read-only/loopback/auth rõ nếu được duyệt; Mermaid/JSON export trước.

---

## 7. Checklog: lịch sử thật, không một dòng status cuối

### 7.1. Event envelope

```text
sequence, eventId, schemaVersion, engagementId, runId
kind, occurredAt, committedAt
actorId, taskId?, attemptId?, operationId?, correlationId?
entityId?, entityRevision?, payloadRefs[], summary, redactionVersion
```

`sequence` do store cấp, không tin timestamp model hoặc số đếm từ nhiều worker. UUID dedup event delivery; `operationId` ghép lifecycle của một invocation; task ID không đủ vì cùng task có nhiều attempts.

Groups cần có:

- run started/paused/stopping/stopped; worker admitted/runtime-verified/revoked/retired;
- task created/queued/reserved/running/reported/reviewed/closed/blocked; queue rejected/invalidation;
- operation requested/started/returned/failed/cancelled/unknown-terminal;
- asset upserted, fact/candidate revised, review accepted/disputed, support invalidated;
- phase packet committed, checkpoint committed/failed, artifact retained/missing;
- decision committed, planner wake admitted/vetoed, limit/backpressure reached;
- cleanup step/result và export/retention failure.

Tool status là host observation, kết luận security là attributed assertion. Không dùng stream silence làm timeout authority hay automatic retry. Nếu process chết giữa start/end, giữ operation `unknown-terminal`, không giả returned success.

### 7.2. Commit và delivery

- Domain mutation + event + outbox trong cùng transaction.
- Notify UI/Engine **sau commit**; success ACK gồm committed IDs/sequence.
- Subscriber có thể nhận trùng/drop; replay từ durable cursor với idempotent merge. Snapshot `@S` + tail `>S` phải không bỏ khoảng.
- UI event stream và semantic Planner wake là **hai consumer khác nhau**. Mỗi command event cập nhật UI nhưng không gọi LLM.
- Manual mode: zero automatic model rounds từ các event mới.
- Event-driven mode: coalesce candidate needing review, handoff, prerequisite change, material blocker; chỉ wake theo consent/quota/current epoch. Không wake từng asset field hoặc mỗi log row.
- Kiểm tra backlog của notification riêng storage capacity. Nếu queue overflow, ghi health warning và catch-up; không mất canonical event rồi nói đã complete.

---

## 8. Checkpoint, artifacts và khả năng tiếp tục công việc

### 8.1. Ba khái niệm không được nhập làm một

1. **Progress marker:** UI/notification cho biết vừa xảy ra gì; không phải backup.
2. **Checkpoint:** snapshot nhất quán tại sequence S, có references/hashes/health; dùng inspect/reconcile.
3. **Continuation:** run mới được human confirm, chọn tri thức từ checkpoint để revalidate; không resurrect run cũ.

Checkpoint không phải VM snapshot, không chứa network session/cookie jar/ticket, không rollback HTTP side effects.

### 8.2. Checkpoint manifest

```text
checkpointId, schemaVersion, project/targetIdentity, sourceRunId
asOfSequence, createdAt, reason, store/schema/profile hashes
entity revision heads, task/attempt states, reviewed support refs
coverage plan version, open gaps, pending reviews, pending proposals
artifact manifest [{id, size, sha256, availability, redactionVersion}]
accepted intent history, planner decisions/todo references
integrityStatus, missingRefs[], omissions[], retentionStatus
```

- Snapshot bắt tại transaction boundary; không nhất thiết dừng tất cả workers. Work đang chạy ghi rõ in-flight tại S; result sau S thuộc checkpoint sau.
- Checkpoint logical có thể tạo nhanh mỗi handoff/review/phase/stop; portable bundle lớn chỉ khi request hoặc retention policy, tránh copy toàn DB mỗi event.
- Ghi manifest/file temp trong cùng filesystem, flush/fsync phù hợp rồi atomic rename và commit pointer; verify referenced bytes. Crash trước publish không được hiện như checkpoint thành công.
- Không đưa raw credentials, tickets, sockets hay host environment vào manifest.
- Integrity (đủ/hash đúng) khác currentness (support còn hiện hành). UI cần cả hai.
- Tạo lại cùng idempotency key trả cùng checkpoint, không tạo N bản duplicate khi ACK mất.

### 8.3. Artifact pipeline

`artifact ≠ asset`: asset là đối tượng kiểm thử; artifact là file/output sinh ra hoặc thu thập để chứng minh.

- Registry lưu kind/media type/producer/size/hash/sensitivity/retention, evidence references và captured range.
- Model dùng artifact IDs, không arbitrary host filesystem paths. Lấy file từ worker scratch qua owner-controlled validated path, no symlinks/devices/path traversal; không mở host write capability.
- Output dài: stream bounded bytes sang artifact **trước** capture truncation; trả excerpt + `artifactId` + total/captured bytes + `truncated`/reason. Không thể khôi phục phần output baseline đã mất bằng hash.
- Không cần lưu mọi raw response vô hạn. Có max bytes/object, storage quota/run, redaction/sensitivity choices; raw secret-bearing capture phải explicit opt-in, mặc định redacted artifact hoặc no-retain.
- Retained artifact do owner ingest bất biến; scratch file có thể sửa nhưng không rewrite artifact đã referenced.
- Hash trước/sau redaction ghi rõ; export không redact lại serialized fragments làm hỏng manifest.
- Missing evidence bytes, read failure, disk full hoặc capture giới hạn phải giữ `partial/missing`, không checkpoint “complete”.

### 8.4. Retention và restart

**Đề xuất UX:** lúc confirm chọn rõ `ephemeral` hoặc `durable-local`; giới thiệu durable-local như lựa chọn phù hợp công việc dài, nhưng không âm thầm thay consent retention cũ. Không cần bắt người dùng nhớ `--export` mới có output thấy được trong phiên.

- Ephemeral: UI/checklog/checkpoint in-run vẫn có; cảnh báo trước cleanup rằng full data sẽ mất, chỉ được giữ nếu người dùng chọn save.
- Durable-local: log/domain/artifacts được commit trong run; cleanup xóa authority/scratch, không xóa knowledge store. Không đợi đến finish mới cố export một file khổng lồ.
- `/p2o stop` luôn revoke/cancel trước. Storage lỗi không được giữ target access để “chờ ghi xong”; báo retention failure và retained/missing bytes rõ.
- Restart/reload: mở hồ sơ read-only với banner “historical — no active authority”. Historical running tasks không trở thành live; đánh dấu interruption/unknown qua reconciliation record có attribution.
- Muốn tiếp tục: human xác nhận target/scope/profile/retention mới; run mới, worker mới, ticket mới, allowance theo confirmation mới. Old knowledge chỉ là imported evidence có provenance, cần freshness review; không vượt same-run receipt gate bằng copy IDs.
- Cấm hai owner writers đồng thời vào cùng active run. Lock ownership không phục hồi execution authority; read-only sessions được phép.

---

## 9. Chống trùng: bốn tầng, không một hàm similarity

### 9.1. Transport idempotency

`(runId, actorId, requestId)` là unique mutation key. Same key/same canonical payload trả original result; same key/different payload báo conflict. Bao gồm report/asset/fact/candidate/checkpoint mutations.

Đây không phải exactly-once target execution. Network operation ACK mất thì outcome có thể unknown; không tự replay POST/command vì request ID trùng. Lấy retained result/status trước; nếu chưa biết thì Planner/human quyết định attempt mới.

### 9.2. Asset dedup

Canonical resource key theo §5; exact duplicates merge provenance, không tăng count. Alias grouping có audit/undo. Upsert ghi chỉ delta; unchanged observation không sinh vô hạn semantic events. Conflicting attributes giữ nguồn/version, không last-write-wins xóa contradiction.

### 9.3. Work dedup và admission

Exact work fingerprint đề xuất:

```text
namespace + targetRevision + sorted(asset/variant IDs)
+ question/policy key + actor/tenant context + method family
+ prerequisite revisions + declared purpose
```

Không hash raw prose làm “ngữ nghĩa”. Nếu metadata thiếu, `dedupConfidence=unknown`; không giả exact match.

1. Query active **và history indexed**, không chỉ 10 task gần nhất.
2. Exact active duplicate: return `already_covered_by=taskId`, không spawn.
3. Exact historical match có current reviewed result: return `reuse_candidate` cùng refs/revision/limitations; không tự suy ra goal met.
4. Historical blocked/partial: đọc last attempt/gap trước; chỉ đề xuất retry khi prerequisite/environment/material evidence thay đổi hoặc explicit retry decision có lý do. Không blanket suppress vì đã từng làm.
5. Same surface/risk nhưng method/actor khác: overlap warning + resource conflict policy, không coi mặc định trùng.
6. Independent validation: explicit `validationOf`, separate attempt/worker, không tái sử dụng discovery receipt để chứng minh độc lập.
7. Retest: `retestOf`, changed target/policy/config revision hoặc explicit reason; retain old result, không overwrite history.
8. Fuzzy match chỉ đưa suggestions để Planner chọn `reuse|refine|new|validate|retest|defer`, kèm lý do. Không auto-merge từ embeddings/LLM confidence.
9. Sau duplicate decision, check lại ở **atomic reserve** trước launch để chống hai parallel calls cùng pass. Read-only lookup không phải admission lock.

Finite duplicate rules không bảo đảm hai câu diễn đạt khác nhau luôn được nhận ra. Mục tiêu đo được: giảm repeat-on-unchanged-input, không chặn các khác biệt an ninh quan trọng.

### 9.4. Finding dedup

- Group candidate by reviewed asset/component identity + policy violated + root cause/control location + affected variant family, **không chỉ title/CWE/severity**.
- Exact known case thêm evidence/variant hoặc revision; semantically similar case yêu cầu review trước `duplicate_of`.
- Nếu root cause chưa rõ, giữ hai candidates linked `possibly_related`; không ép merge sớm.
- Merge tạo alias/relationship reversible, giữ original IDs/producers/reviews. Same CVE không đủ chứng minh same instance.
- Validator disagreement là disputed support, không phải finding mới chỉ để né revision protocol.
- Root-cause shared across endpoints có thể một canonical case + affected instances; report phải giữ endpoint-specific tested/untested status.
- UI/report count tách unique canonical cases, duplicate submissions, open candidates và current reviewed findings.

---

## 10. Planner/Worker sử dụng state mới thế nào?

### 10.1. Planner context packet

Builder deterministic, bounded, cùng store snapshot:

1. confirmed scope/target identity references và original goals;
2. health: incomplete storage, stale refs, retention problems trước;
3. changes since last consumed cursor;
4. unreviewed handoffs/candidates, contradictions, invalidated support;
5. active/ready/blocked frontier và decision/todo cần xử lý;
6. relevant assets/facts/negative results cùng IDs/revisions;
7. exact counts + displayed counts + omitted counts + retrieval cursors;
8. run allowance/executor pressure, không giả tổng monetary budget.

Selection ưu tiên relevance/open work, không đơn giản newest-N. Deep detail qua typed query theo ID/asset/task/risk/actor/status; không expose SQL hoặc graph query tùy ý có host effects. Token/byte budget rõ; bị omitted vẫn query được.

Consumption cursor phải phản ánh packet đã thật sự cung cấp cho request; không mất event nếu build/context/request abort. Re-delivery read-only an toàn; effects chỉ xảy ra qua validated mutation/admission, không qua replay packet.

### 10.2. Planner round output

Một round có thể kết thúc bằng:

```text
reviewed results + knowledge delta references
accepted/reused/deferred tasks + reasons
updated strategic todo
next trigger or blocker
wait | blocked | continue-existing-work | finish-with-outcome
```

Không cần mỗi round sinh tasks/findings. Khuyến nghị qualitative ranking: authorized reachability, concrete unresolved boundary, evidence strength, information gain, dependency readiness, overlap, environment readiness và cost/resource estimate có uncertainty. Không tạo fake scoring formula dự đoán xác suất bug.

### 10.3. Worker assignment packet

Giữ autonomous tactical worker nhưng brief có:

- one question + role + expected contrasts + stop condition;
- asset IDs/versions, known observations và exact sources;
- prior attempts/controls **không cần làm lại**, kèm giới hạn của chúng;
- selected method/skills hashes, dependencies reviewed revisions;
- desired output type, partial-report contract, artifact policy;
- relevant gaps and forbidden scope expansion;
- refs để retrieve thêm, không toàn bộ graph/chat khác.

Worker có batch structured writes để không mất thời gian ghi từng field. Broker gắn task/actor, validate references rồi trả IDs. Facts/hypotheses incremental được lưu khi có ý nghĩa; không đợi final report, không ép “một intent chỉ đúng một fact” như luật cứng.

Material candidate/gap có thể notify Planner trước worker kết thúc, nhưng worker slot chưa free cho tới report/revocation/verified retirement hiện hành. Reporter chỉ đọc và tổng hợp, không target-execute hay tự upgrade proof.

### 10.4. API roadmap tối giản

Tên **đề xuất**, không phải commands/tools đang ship:

| API | Vai trò |
|---|---|
| `p2o_state` | Typed read query: overview/tasks/assets/facts/cases/events/checkpoints, filters/cursor — checkout có slice `heads` read-only (K6: domain/status filter, exact totals, sequence cursor), chưa phải full typed query |
| `p2o_record` | Worker/solo batch assets/facts/hypotheses/gaps/artifact metadata; action-specific schemas và broker allowlist |
| `p2o_task` mở rộng | Giữ action cũ, thêm asset/question refs, dedup disposition, desired output contract |
| `p2o_candidate` + checkout `p2o_case` | Candidate vẫn là attributed claim; owner-only stable case revisions, reviewed duplicate/root-cause relation và current support; không bypass evidence gates |
| `p2o_plan` | Owner goal/todo/decision/review operations theo quyền tách rõ — checkout có slice create/revise/list/view, chưa full K5 review/support-currentness |
| `p2o_checkpoint` | Owner commit/list/inspect; worker chỉ propose hoặc read permitted state |
| `p2o_report` mở rộng | Typed output packet refs + outcome; legacy strings giữ labelled compatibility. Checkout final projection đã mang bounded case/coverage index, chưa phải full K6 relevance packet |

Không bật tất cả schemas dài ở mọi role. Dùng discriminated action schemas/tool-loadout đúng Pi API, test hidden/deferred execution boundary trước khi đổi exposure. `p2o_record` không nhận generic `set arbitrary entity` vượt quyền owner.

### 10.5. Trace minh họa: không tìm lại từ đầu sau mỗi worker

**Fixture giả định, không chạy request:** một source snapshot có route đọc tài liệu và một export handler; chính sách export chưa rõ. IDs ngắn dưới đây chỉ là nhãn minh họa.

| Bước | Canonical write / quyết định | Người dùng thấy |
|---|---|---|
| 1. Confirm | Run R1, target snapshot S1, goal G1 “đánh giá boundary truy cập tài liệu”, persistence choice | Scope card; chưa có kết luận bug |
| 2. Recon T1 | Worker đọc source; receipt E1; assets A1 route, A2 handler; fact F1 về đường đăng ký/gate; gap X1 về intended export policy | Recon delta: 2 assets, 1 fact, 1 gap; IDs click/read được |
| 3. Handoff | Packet P1 committed; T1 reported; checkpoint C1@42 | “T1 awaiting review”, không “assessment complete” |
| 4. Review/plan | Owner accepts bounded mapping T1@r3; decision D1 chọn kiểm tra contract policy trước; task T2 dựa F1/X1 | T1 reviewed; T2 queued; lý do chưa validate vulnerability |
| 5. Tránh trùng | Một proposal khác gọi A1 bằng alias nhưng cùng mapping S1/method; lookup trả T1/E1/F1 | “Reuse mapping T1; no new worker”; không tăng tested count |
| 6. Context mới | T2 nhận A1/A2/F1, prior receipt E1 và gap X1; không cần enumerate lại routes | Brief có known work và output contract “policy evidence hoặc explicit unknown” |
| 7a. Policy chưa rõ | T2 trả gap X1 còn mở; candidate H1 vẫn inferred/open_proof_gap | Partial investigation output; không ghi confirmed chỉ vì hai route khác nhau |
| 7b. Nếu có evidence mới | Receipt E2 thiết lập explicit policy; hypothesis H1 được cập nhật; D2 tạo bounded test T3 | UI ghi rõ evidence nào làm hướng mới hợp lệ |
| 8. Nếu có candidate | T3 ghi claim V1@r1 + controls/receipts; handoff pending review; proposed validation T4 | “Claimed finding, validation pending”; không tự badge independent |
| 9. Validator | T4 do worker khác, target/method/actor ghi rõ; tự thu E4, không copy E3; review RV1 pin V1/E4 revisions | Reviewed support hoặc disputed/inconclusive; cả hai là kết quả hợp lệ |
| 10. Báo cáo | Report B1 tham chiếu current reviews, coverage cells, X1 nếu còn mở; checkpoint C2 | Finding/gap/untested tách rõ, đủ đường drill-down |
| 11. Stop/reopen | Revoke/cleanup như hiện tại; durable data giữ lại; mở lại chỉ historical | “R1 stopped — resources cleaned; knowledge retained; no authority” |
| 12. Source đổi S2 | New run R2 cần confirmation; import mapping như prior knowledge; affected support stale | Retest có change reason; không tái dùng S1 để claim S2 đã tested |

Hai nhánh 7a/7b là điều kiện, không buộc run phải tìm thấy bug. Nếu finding không tồn tại, hồ sơ vẫn hữu ích nhờ bounded negative results, policy evidence và gaps. Đây là lợi ích mục tiêu của graph: **giữ identity, provenance, trạng thái và lý do làm tiếp**, không phải tự động biến route khác biệt thành vulnerability.

---

## 11. “Bị giới hạn nhiều”: xử lý đúng loại giới hạn

| Baseline cap/constraint | Vấn đề | Đề xuất |
|---|---|---|
| 48 KiB captured output; receipts nhỏ hơn | Evidence dài mất trước khi có cơ hội drill-down | Artifact streaming/spill có quotas, excerpt + range retrieval |
| 64 MiB/100k-row ledger; 16 MiB export | Run dài đọc lại đắt, export có thể lỗi dù ledger hợp lệ | Indexed store, segmented export/checkpoints, storage health/backpressure |
| 100 live tasks / 100 queued intents | Backlog dài chiếm active frontier | Separate durable backlog vs admitted frontier; pagination. Không bỏ cap admission trước resource tests |
| 1.000 retained registrations | Runtime memory/lifecycle retention | Archive verified terminal assignment metadata; keep budget counters/tombstones/revocation correctness; fresh IDs vẫn bắt buộc |
| 200 commands/worker; 90% reserve của default 600 | Có thể hết trước khi plan mong muốn hoàn tất | Show remaining + block reason; future explicit budget policy, không auto-renew bằng worker mới |
| 160/200 worker coordination; 400 owner knowledge | Structured state cần nhiều interactions | Batch writes/reads, delta projections, reserved finalization path; benchmark trước policy adjustment |
| Last-N views và 16 KiB row / 64 KiB broker frame | Người dùng tưởng lịch sử mất hoặc không thấy work cũ | Stable pagination/IDs/blobs; giữ transport bounds, không tăng vô hạn |
| Shared executor serial | Workers LLM đồng thời nhưng target operations chờ | Giữ isolated opt-in đã có; UI phân biệt model slot và target slot |
| 100 automatic Planner wakes mặc định | Long run dừng automatic scheduling | Status rõ exhaustion; manual review vẫn có, không TTL và không tăng quota ẩn |
| Một confirmed origin | Discovery ra link khác nhưng không được test | Record out-of-scope observation; human scope workflow riêng nếu cần, không graph-driven widening |
| No durable todo/checkpoint | Lặp vì mất tri thức/khó biết done | Ưu tiên release này trước tăng số worker |

**Không đặt mục tiêu “unlimited mọi thứ”.** Unlimited elapsed lifetime vẫn giữ; disk/RAM/provider/request size phải bounded. Quota cần observable, operator-controlled theo policy, và đủ đường để report/stop khi hết. Archive không xóa counter để lách run budget.

---

## 12. Rollout: giao vertical slices, không big-bang rewrite

Dùng nhãn **K0–K7** để không nhầm P0–P6 của roadmap cũ đã có core 0.5.0.

### K0 — Contract và storage spike

**Deliverables:** ADR identity/state/retention/SQLite driver; migration map; current UX fixtures; event/correlation/idempotency schemas; assessment outcome semantics.

**Gate:** thống nhất `reported/reviewed/closed`, candidate claim/review, artifact/asset và checkpoint/authority. Driver load/package/crash test đạt hoặc storage phase blocked rõ. Không sửa runtime trước impact review các core paths.

### K1 — Visibility đầu tiên, dùng được ngay trên state v2

**Deliverables:** `/p2o status/tasks/task/log` read-only, compact widget, grouped tool renderers, review-pending badge, output path và cap/retention warnings; note ACK có IDs; clear operational/assessment completion labels.

**Gate:** người dùng không cần gọi model để biết ai làm gì/đang chờ gì. Adapter v2 chỉ hiển thị log hiện có; thiếu operation correlation/history thì ghi unknown, không invent events cũ. Không gọi đây là durable checkpoint release.

### K2 — Canonical store + checklog + checkpoint/artifact foundation

**Deliverables:** single owner writer, typed events, transaction/outbox, request idempotency, persistence consent, durable local storage, operation lifecycle, checkpoint barrier, immutable artifact ingest/export, read-only reopen.

**Gate:** failure injection trước/sau commit/ACK/checkpoint; replay không duplicate state; kill/restart không restore authority; cleanup không xóa retained knowledge. K1 UI chuyển adapter sang store mới, không chạy hai canonical writers.

### K3 — Asset + fact/hypothesis graph

**Deliverables:** versioned identities, scoped queries, anchors/typed relations, batch recording, source + URL fixtures, negative/counterevidence state, graph JSON/Mermaid, per-asset history.

**Gate:** asset concurrency dedup, unsafe normalization tests, imported/foreign scope rejection, stale references. Discovery không tự cấp permission.

### K4 — Work dedup + durable planning + phase packets

**Deliverables:** exact active/history matching, overlap warnings, explicit reuse/validation/retest, atomic reservation, goal/todo/decision records, per-workstream output contracts và checkpoint cards.

**Gate:** paraphrase/alias fixture, intentional validator/retest vẫn hoạt động, stale prerequisite blocks như baseline; completed worker không tự mark reviewed goal. Reportless exit ra partial packet không cần extra model call.

### K5 — Vulnerability view + review/currentness

**Deliverables:** canonical cases/duplicates, revision-pinned reviews, contradictions, affected variants, review queue, bounded proof-aware coverage và final report bundle.

**Gate:** independent validator withdrawal làm badge/report stale; repeated report delivery không tăng findings; uncertain root cause không merge sai; blocked/untested không thành clean. Case close không tự goal complete.

**Checkout source hiện tại:** gate mechanics trên đã có unit/runtime/actual-Pi inert fixtures, canonical record revisions, atomic ACK replay và read-only UI/checkpoint/final projection; xem [K5 contract](docs/CASE_REVIEW.md). Đây không phải live finding-effectiveness, installed hay publication qualification; K6/K7 và các hardening còn mở.

### K6 — Indexed context + long-history optimization

**Deliverables:** Planner/Worker packets, exact counts/cursors, historical duplicate lookup, deterministic digest/index, archival policy; optional model-generated summaries chỉ sau explicit budget/consent riêng.

**Gate:** no dropped old gap; checkpoint + event tail rebuild tương đương snapshot; hot data không bị stale digest che; UI/context budgets không tăng theo toàn history. Không warm-session reuse trong scope này.

**Checkout source hiện tại:** schema 7 thêm rebuildable `knowledge_heads`/`knowledge_links`/`context_cursors` trong cùng database; role packets Planner/Worker/reporting bounded, human `/p2o heads|digest`, read-only `p2o_state`, delivery ACK sau assistant `message_end` thành công, rotating old gap/review pages và passive checkpoint+tail index replay đã có unit/runtime/actual-Pi inert fixtures cùng microbench 10k/100k; xem [K6 contract](docs/CONTEXT_PACKETS.md). Đường legacy `/p2o status|tasks|report` + widget đã chuyển sang ledger incremental bất biến + memo task lookups + digest lazy + pacing quét: refresh p95 ≤114 ms ở 100k records (simple và mixed cases/coverage; trước đó ~0.98 s đến ~1.8 s), **đạt** mục tiêu §13.2 (<200 ms) trên corpus synthetic, nhưng vẫn suy counts từ snapshot trong bộ nhớ (O(lịch sử), bị chặn bởi cap 100000 rows) và chưa đo TUI render; xem [số đo và bằng chứng tương đương](docs/CONTEXT_PACKETS.md#legacy-status-and-widget-path). Còn mở: TUI render p95, (nếu cần) đếm status từ heads/SQL, large mixed graph/case/review replay fixtures, segmented archive >64 MiB; model-generated summaries không có và cần budget/consent riêng. Đây không phải installed, paid-provider hay finding-effectiveness qualification.

### K7 — Qualified acceptance / publication riêng

**Deliverables:** reproducible fixtures, regression matrix, docs/settings help, pack exclusions, source/install hash acceptance và release checklist.

**Gate:** test inert mechanics trước; real-Pi load/render/manual/event-driven tests; Docker lifecycle regressions nếu executable change; real Herdr acceptance được ghi riêng nếu thực hiện. Paid/live effectiveness test chỉ khi có authorization mới.

**Checkout source hiện tại (một phần K7):** [ACCEPTANCE_MATRIX](docs/ACCEPTANCE_MATRIX.md) ánh xạ đủ 22 fixture của §13.1 và 7 điều kiện của §13.3 tới test thật, kèm guard tự động (`acceptance-matrix.test.ts`) fail khi test được dẫn bị đổi tên/xóa hoặc khi plan thêm scenario mà ma trận chưa có hàng. Ba khoảng trống phát hiện khi lập ma trận đã có test mới: manual-mode event storm (#19), fork/tree navigation (#12), ENOSPC khi export bundle (#11). Đây là bằng chứng cơ chế inert; chưa phải hiệu quả pentest, real Herdr, installed-package hay publication.

**MVP có giá trị cho yêu cầu này:** K0–K2 + output contracts cơ bản. **Knowledge-driven planning MVP:** thêm K3–K5. Không chờ canvas/UI web hoặc perfect semantic dedup mới giải quyết việc thiếu output.

### 12.1. File/module impact map cho implementation sau

| Existing / proposed module | Trách nhiệm thay đổi |
|---|---|
| `src/records.ts` | v2 reader compatibility; không âm thầm coi new kinds là valid legacy records |
| `src/tasks.ts` | store adapter, identity refs, reserve/dedup/currentness; giữ prerequisite/cycle/role invariants |
| `src/evidence.ts`, `src/report.ts` | receipts/artifact refs, proof gates, transaction packets, current report projection |
| `src/broker.ts` | authenticated typed writes, IDs, idempotency, operation correlation, report ACK semantics |
| `src/engine.ts` | state-committed signals, queue visibility, revised support invalidation; không thành strategy model |
| `src/progress.ts` | derived latest progress từ event log, không source of truth độc lập |
| `src/process.ts`, `src/sandbox.ts` | bounded artifact capture/ingest, abort integrity; giữ cancellation và cleanup semantics |
| `src/ticket.ts`, `src/executors.ts`, `src/herdr.ts` | regression-sensitive ownership/retirement; không cần rewrite nếu contract không đổi |
| `src/prompts.ts`, `src/tool-policy.ts` | knowledge packet guidance, role-specific writes; không dùng prompt thay broker gates |
| `extensions/p2o/index.ts` | command/UI integration, hooks/consent/lifecycle; tách rendering/store service khỏi file lớn |
| **Mới đề xuất** `src/state/*` | store/schema/migrations/events/checkpoints/query projections |
| **Mới đề xuất** `src/knowledge/*` | assets/facts/relations/identity/dedup/coverage |
| **Mới đề xuất** `src/ui/*` | status/task/phase cards và renderers, không execution authority |
| **Mới đề xuất** `src/artifacts.ts`, `src/context.ts` | artifact manifests và bounded role projections |
| Tests/docs/library | adapter + adversarial state tests; update runtime knowledge recipes khi API thật được ship |

Tên module mới là đề xuất tổ chức, không yêu cầu tạo đủ mọi file rỗng. Trước mỗi slice chạy graph impact; HIGH/CRITICAL lifecycle/store changes phải review riêng. Graph incomplete/UNKNOWN không phải all-clear.

---

## 13. Acceptance matrix: chứng minh cơ chế, rồi mới đo chất lượng

### 13.1. Fixture scenarios bắt buộc

| Case | Kỳ vọng |
|---|---|
| Start chưa có task/asset | Empty state nói đúng, không giả 0 bugs = safe |
| Worker làm lâu, chưa có result | Hiện running op/start time; không timeout vì quiet và không model polling |
| Hai workers ghi cùng endpoint | Một asset ID, hai provenance entries, count không tăng đôi |
| Hai task aliases cho cùng work | Exact known identity conflict ở reserve; fuzzy trường hợp unknown đưa review |
| Same endpoint khác method/actor/tenant | Không collapse thành cùng security test |
| Handoff committed, chưa review | `reported / awaiting review`, không completed goal |
| Worker provider-error/no report | Partial lifecycle packet, gap retained, không cần model retry để có output |
| Report ACK mất rồi submit lại | Một canonical packet/event effect, không nhân coverage/open/finding |
| Crash giữa report parts/domain writes | Chỉ committed transaction hiển thị complete; partial có diagnostics |
| Stop khi operation in flight | Revoke/abort giữ nguyên; checkpoint ghi cancellation/unknown, không fabricated output |
| Disk full lúc checkpoint/export | No success claim, no authority extension, rõ retained/missing data |
| Reload/tree/fork đọc checkpoint | Chỉ historical state; không broker/ticket/container/network/model turn mới |
| Old review bị superseded | Dependent task/candidate/report/digest stale đúng IDs/revisions |
| Independent validator bị withdraw | Independent badge mất hiệu lực; history không bị xóa |
| Out-of-scope asset từ response | Có thể ghi observation ngoại vi, không dispatch/probe hay auto-widen scope |
| Artifact symlink/path traversal/secret | Denied/redacted theo policy, không leak host files hoặc raw token |
| Same content event delivered N lần | UI merge theo ID/sequence, không N phase cards |
| History vượt display windows | Exact totals + omitted + drill-down; old blockers vẫn tìm được |
| Manual mode event storm | Zero automatic paid requests; UI vẫn update |
| Event-driven pause/stop race | Late wake veto, no dispatch after pause/stop; human pending input priority |
| Normalization adversarial set | Path case, query repeats/order, `%2F`, trailing slash, IPv6, custom method không merge sai |
| Negative result reused | Chỉ cùng tested context/method/version; không biến thành global “clean” |

### 13.2. Measurements đề xuất, chưa có kết quả

- Corpus deterministic: 10k và 100k domain/events; stress lớn hơn là opt-in có disk budget.
- Đo p50/p95 query/render/commit/checkpoint latency, RSS, bytes/on-disk và query count; công bố hardware/corpus.
- Budget projection đề xuất: khoảng 16 KiB overview ban đầu, drill-down riêng; exact count không tính từ truncated list.
- Responsiveness target ban đầu: status local p95 <200 ms với corpus/hardware đã công bố; nếu chưa đạt phải profile/index, không lược bỏ dữ liệu rồi vẫn ghi “complete”.
- Retest/dedup oracle corpus có labels: exact duplicates, aliases, changed snapshot, validation, controls, different actors, related-but-distinct root causes.
- Báo cả duplicate suppression đúng và **false suppression** của test hợp lệ. Không tối ưu “ít tool calls” bằng bỏ kiểm chứng.
- Đo finding completeness/proof correctness, unresolved-gap recall, task review accuracy và evidence retrieval; không chỉ số nodes hoặc số bugs model tự báo.
- Inert fixtures chỉ chứng minh mechanics. Muốn nói “pentest tốt hơn”, cần authorized benchmark với cùng model/scope/budget, repeated runs, held-out controls và independent adjudication. Chưa được thực hiện/ủy quyền ở đây.

### 13.3. Không đạt acceptance nếu

- Có graph nhưng không trả lời được “task nào chưa review, vì sao blocked, output ở đâu”.
- Checkpoint chỉ là model summary không có snapshot/version/refs.
- Finish xóa toàn bộ result mà user tưởng đã lưu.
- Graph dữ liệu được coi như authorization hoặc replay history tự chạy lại request.
- Mọi `confirmed` đều lên badge verified, hoặc “100% coverage” dựa touched assets.
- Dedup suppress validator/retest hoặc merge hai bug chỉ vì cùng CWE/title.
- Thêm background LLM hay đổi budgets/mode mà confirmation không nói.

---

## 14. Migration, compatibility và release discipline

1. Giữ `0.5.0` acceptance bất biến; new schema/store có version mới, không rewrite history cũ tại chỗ.
2. Import v2 exports qua explicit read-only adapter: giữ original record IDs/hash/provenance; không fabricate typed asset/fact quan hệ từ prose. Mapping đề xuất có thể được review sau.
3. `note`, legacy coverage và report strings không tự promote thành observed fact/verified finding. Source marker `legacy-unstructured` và missingness rõ.
4. Adapter giữ existing task/candidate APIs hoạt động; đổi semantics phải version và migration test. Stop/reload assessment cũ trước khi đổi extension bytes.
5. Chuyển canonical backend tại new run boundary. Không dual-write hai stores rồi dùng tùy chỗ làm authority; legacy export có thể generate từ new committed store.
6. Runtime settings mới (retention, storage/output quotas, context budgets…) phải có schema/help/default/confirmation; tên trong plan chưa phải API.
7. Rollback: stop, giữ retained store read-only, new explicitly confirmed baseline run nếu cần. Baseline không đọc được schema mới phải báo unsupported, không xóa file.
8. Test/impact review → commit phase-scoped → source acceptance → push/install chỉ khi được yêu cầu → installed hash/real-Pi mechanics acceptance. Không suy ra install pass từ CLI “Updated”.
9. Reference, private config, credentials và `tmp/` không commit/package. Không để validation hashes lịch sử “pass” bằng thay hash sau khi code/docs đổi.

---

## 15. Source map để triển khai và review tiếp

Line numbers áp dụng baseline/snapshot trên; symbol/file là anchor chính khi source đổi.

| ID | Source | Nội dung đã đối chiếu |
|---|---|---|
| P1 | `src/records.ts:10–134,148–181` | Record kinds, append/scan/page, coverage summaries và caps |
| P2 | `src/tasks.ts:1–166` | Task draft/status, reserve conflict, reviewed prerequisites, revisions/capsule |
| P3 | `src/evidence.ts:8–132` | Candidate policy/proof/currentness, bounded receipts và opt-in export |
| P4 | `src/report.ts:10–93` | Report parts/manifest, integrity reconstruction, frozen projection |
| P5 | `src/progress.ts:1–24` | Latest observational state, không history log |
| P6 | `src/engine.ts:24–161` | Queue, semantic events, wake reservation, pause/stop/round limits |
| P7 | `src/broker.ts:19–106,191–379` | Worker reports, normalization, op gating/budgets, ACK/revoke boundary |
| P8 | `extensions/p2o/index.ts:339–475,687–804,821–1011,1060–1140` | Views, cleanup/export, note ACK, reports, context refresh, lifecycle |
| P9 | `src/prompts.ts`, `src/tool-policy.ts`, `src/roles.ts` | Policy/loadouts/settings; existing structured recon guidance |
| P10 | `src/process.ts`, `src/sandbox.ts`, `src/source.ts`, `src/http-session.ts`, `src/target.ts` | Output capture, snapshot, HTTP scopes/sessions, no-default task timeout |
| P11 | `src/executors.ts`, `src/herdr.ts`, `src/ticket.ts`, `src/planner-bridge.ts`, `src/skills.ts` | Ownership, transport, fresh identities, wakes, packaged knowledge |
| P12 | `tests/minimal/loop.test.ts`, `frontier.test.ts`, `engine.test.ts`, `planner.test.ts` | Existing integrity/currentness/admission regressions, không effectiveness proof |
| A1 | `my_references/ARTEX/ARTEX_AGENTIC_CORE.vi.md` | Bài phân tích người dùng, đã đọc đầy đủ |
| A2 | `my_references/ARTEX/db/schema.sql:40–110,153–280,1081–1174` | Assets unique keys, exploration kinds/edges/anchors, standalone findings |
| A3 | `my_references/ARTEX/db/assets.go:164–195,453–554,683–808,939–1061` | Normalize/upsert/host side effects; endpoint identity |
| A4 | `my_references/ARTEX/agent/tools_insert.go:79–375` | Explicit registration, owner anchors, metadata và auto-scope |
| A5 | `my_references/ARTEX/db/task_scope.go:367–584`, `db/task_assets_context.go:12–198` | Derived containment, direct-source context, touched-fact coverage |
| A6 | `my_references/ARTEX/agent/tools.go:354–551,1021–1405` | Bounded overview, intent parents, fact/finding/proof writes |
| A7 | `my_references/ARTEX/db/exploration.go:172–270,1136–1182` | Node/anchor transaction, separate links, priority frontier/atomic claim |
| A8 | `my_references/ARTEX/agent/planner.go:23–51,108–295,355–472` | In-process todos, triggers, fresh context/session, planner round |
| A9 | `my_references/ARTEX/agent/worker.go:260–342,361–535` | Artifact directories, mandate/assets, per-intent transcript/resume |
| A10 | `my_references/ARTEX/agent/capture.go:28–160`, `server/engine.go:640–704,748–963`, `server/broadcast.go` | Activity capture/persist/publish, round markers, heartbeat và live stream |
| A11 | `my_references/ARTEX/db/finding_traffic.go:328–415`, `db/findings.go:14–109` | Atomic finding records/traffic, IDs riêng, triage states |
| A12 | `my_references/ARTEX/agent/finding_workflow.go`, `agent/finding_recorder.go`, `server/findings_groups.go` | Evidence handoff/version guidance, drill-down/grouping/explicit follow-up |
| A13 | `my_references/ARTEX/agent/compaction.go:35–145,514–548`, `agent/tools_digest.go`, `db/digest.go:122–253` | Cold-digest lifecycle, background model call, expansion/member refs |
| A14 | `my_references/ARTEX/web/src/app/(main)/function/tasks/detail/_tabs/{graph-tab,coverage-graph-tab,sessions-tab}.tsx` | Separate views, folding và sequence/history/live UI design |
| PI1 | Pi 1.0 docs `extensions.md`, `tui.md`, `sessions.md`, `session-format.md`, `how-pi-works.md` | State vs context vs external store, branch behavior, renderers, mode separation |
| PI2 | Pi examples `extensions/todo.ts`, `extensions/widget-placement.ts` | Branch-sensitive UI state và widget integration, không assessment authority recovery |

ARTEX paths ghi rút gọn `db/...`, `agent/...`, `server/...` trong cùng một hàng vẫn nằm dưới `my_references/ARTEX/`. Các reference paths là navigation local, không yêu cầu đóng gói source reference. Pi docs/examples đã đọc từ installation release 1.0.0, không giả public API của phiên bản khác.

## 16. Quyết định chốt cho bản update

**Xây “observable, evidence-linked assessment workspace” trên Engine hiện có.**

- Human có bảng công việc và checklog thật, không phải đoán từ chat.
- Mỗi pha/nhánh bàn giao được output có ID, trạng thái, proof/gaps và đường dẫn.
- Knowledge có resource identity và exploration lineage để Planner dùng lại, không tìm lại từ đầu.
- Dedup chặn exact duplicate có cơ sở, vẫn cho validation/retest/variant exploration hợp lệ.
- Checkpoint giữ state và evidence để inspect/continue có kiểm soát, không biến lịch sử thành quyền thực thi.
- Không tuyên bố tăng hiệu quả pentest chỉ vì thêm graph; đo bằng evidence correctness, gap recall và duplicate/false-suppression metrics.

**Scope của lượt nghiên cứu tạo bản plan:** nghiên cứu tĩnh + tạo mới tài liệu này; khi đó chưa implement các API/store/UI ở trên, không chạy assessment hay commit/push/install. Trạng thái triển khai sau đó được ghi riêng tại `docs/KNOWLEDGE_WORKSPACE.md`, không thay các facts/acceptance baseline của bản nghiên cứu.
