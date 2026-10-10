# Indexed knowledge packets — source slice K6

**Checkout/schema 7, chưa install/publish; toàn K0–K7 vẫn mở.**
[Roadmap](../planning_update.md), [canonical store](STATE_STORE.md), [cases/coverage](CASE_REVIEW.md).

## Nguồn duy nhất, không competing store hoặc Planner

- `assessment.sqlite` giữ nguyên records/events/outbox/request transactions.
- `knowledge_heads` là **rebuildable index** của task/plan/case/cell/candidate/gap/phase/report/evidence heads;
  `knowledge_links` chỉ nối exact retained IDs. Không xóa cold revisions hoặc raw observations.
- Candidate heads tách theo actor + candidate handle; hai Worker cùng label không bị collapse thành một claim.
- `src/context.ts` cung cấp deterministic descriptor và passive checkpoint+tail audit. Nó không dispatch,
  tạo Worker/ticket/socket/queue hay đọc target. Context/human indexed reads không gọi full-history replay làm fallback.
- Case/cell support invalidation đi qua current links trong cùng transaction, bao gồm dependent cases/cells.
  Asset/assertion/claim/task revisions hoặc resolved gap chỉ **downgrade**; không tự nâng finding proof.
- Head status `accepted/reported` là navigation label của record. Muốn dùng proof/currentness phải đọc
  `p2o_case`/`p2o_coverage` và exact evidence/task/asset pins; digest không thay những gates đó.

## Role packet và bounds

Packet v1 giữ run/consumer/role/task IDs, sequence barrier, exact counts, shown/omitted, canonical retrieval IDs,
changes, attention, rotating unresolved-gap/review pages và deterministic relevance rows. SHA256 nhận diện
**packet bytes/data**, không chứng minh model hiểu dữ liệu hoặc control có hiệu lực.

| Bound | Default | Min | Max |
|---|---:|---:|---:|
| Host `contextPacket.maxBytes` | 20 KiB | 4 KiB | 48 KiB |
| Runtime Planner packet | 12 KiB, cố định | — | 12 KiB |
| Runtime Worker/reporting packet | 8 KiB, cố định | — | 8 KiB |
| Human digest | 16 KiB, cố định | — | 16 KiB |
| Head page `limit` | 20 | 1 | 100 |
| Head page `cursor` | 0 | 0 | `Number.MAX_SAFE_INTEGER` |
| Head page encoded row payload | ≤48 KiB | — | 48 KiB |
| Changes / attention / rotating gaps / rotating reviews / relevance | 20 / 10 / 10 / 10 / 20 | 0 | cùng giới hạn bên trái |

Đây không phải operator settings mới. Packet trim trả omissions chính xác và chỉ tiến tới item đã giữ.
Cold record count gồm revisions cũ và raw rows chưa có hot head; không suy ra chúng vô dụng hoặc được review.
SQL exact counts có thể scan indexes; bounded bytes **không** có nghĩa computational time O(1).

- Planner: open/review/stale heads và kế hoạch hiện hành; Engine/frontier/executor metadata vẫn riêng,
  không thay Engine bằng persistent queue. Engine projection giữ tối đa 5 events/intents và omitted counts.
- Worker: objective lookup đúng assigned task + exact related/prerequisite/evidence IDs, own attributed rows;
  reporting packet nhấn case/coverage/report/gaps. Global unresolved attention/changes vẫn là shared-run knowledge,
  giống shared ledger, không thêm target permission. Worker không chọn consumer/task/authority trong RPC payload.
- Context hook thay request-local packet cũ thay vì append các instruction dump. Không sửa system/tools,
  không tạo model turn, target operation, retry, hidden Planner hoặc idle polling.
- Unavailable/index/schema/storage state ghi rõ gap; không silent full-history fallback hoặc fabricated currentness.

## Delivery cursor không phải review hay authorization

`contextPacket()` là **read-only**. Pi `agent_start` xảy ra trước context transform, nên không được dùng làm ACK.
Extension giữ ephemeral prepared packet và chỉ ACK ở successful assistant `message_end`, trước tool execution.
Error/abort hoặc inactive run không ACK; không thêm model request để sửa delivery.

ACK ghi `context.consumed` + `context_cursors` + request result trong một canonical transaction:

- Host validates packet hash, run, bounds và prior cursor. Competing stale ACK bị từ chối.
- Before-commit failure rollback tất cả; lost after-commit ACK replay đúng một retained result/event effect.
- Events đến sau projected barrier vẫn pending. Engine ACK chỉ tới semantic sequence đã projected,
  không clear sự kiện mới đến trong lúc model chạy.
- Gap/review cursors rotate về đầu sau cuối page để unresolved old items có thể xuất hiện lại sau compaction.
  Delivery không resolve gap, accept case, close goal hoặc replenish bất kỳ allowance nào.
- Broker chỉ ACK hash của host-prepared packet cho authenticated, active, runtime-verified assignment.
  Forged hash/consumer/task, profile mismatch và revoked/copied tickets không advance cursor.
- Receipt-only mutation recovery không mở context mutation/target rights.
- Một response thành công chỉ là delivery receipt theo host hook, **không proof model hiểu/đã review**.
  Missing ACK vẫn cho explicit inspection/redelivery; không automatic retry.

Checkpoint giữ index/cursor knowledge + digest riêng. Passive `replayKnowledgeIndex()` nhận checkpoint index,
contiguous same-run event tail và exact canonical record lookup; foreign/non-contiguous tail bị từ chối.
Rebuild không apply queue, ticket, scope, cookie, retry allowance, Worker hoặc budget vào runtime.

## Human/model navigation

```text
/p2o heads [domain|all] [cursor] [limit]
/p2o heads gap 0 20
/p2o digest
```

Hai human commands dùng indexed queries, không model request và **không ACK** consumption cursor.
Có thể dùng sau explicit historical `open`; historical reader vẫn không có mutation/execution authority.

```json
{"action":"heads","domain":"case","cursor":0,"limit":20}
```

Đây là input của `p2o_state` (read-only, owner/Worker/reporting). `status` là optional exact navigation filter,
không proof gate. Head page trả matching total, shown, omitted, sequence cursor và canonical record IDs.
Drill-down bằng `p2o_ledger` exact record ID, `p2o_graph` asset ID hoặc owner review API.
Model calls vẫn nằm trong existing knowledge budgets (owner 400; Worker read ceiling 160 / coordination 200),
không target-command allowance. Fixed request-local metadata delivery không tạo paid/target work.

## Hot/cold/archive policy

Hot heads luôn query canonical indexed state, không bị summary/digest cũ che. Cold revisions/observations
vẫn immutable và retrievable; không automatic TTL, purge, destructive compaction hoặc model-generated summary.
Quota/finalization reserve và explicit retention consent không đổi. Không auto raise quota hoặc xóa history
để tiếp tục target work. Portable archive vẫn là knowledge copy; re-ingest không thành same-run evidence.

**Còn mở:** segmented checkpoint/archive lớn hơn 64 MiB, broader import atomicity/privacy/platform matrix,
TUI render p95 và indexed (heads/SQL) status nếu cần (đường legacy đã incremental+memo, p95 ≤ 114 ms ở 100k: [Legacy status and widget path](#legacy-status-and-widget-path)) và large mixed graph/case/review replay fixtures.
Passing bounded head/context queries không đóng toàn K6 hoặc K7.

## Legacy status and widget path

`/p2o status`, `tasks`, `report` và widget TUI vẫn đọc **legacy v2 `LedgerIndex`** (`readLedger()` → `statusView()`), không đi qua indexed heads;
context packets và `heads` ở trên cũng không đi qua đường này. Ba thay đổi source slice (cùng schema 7) giảm chi phí mà không đổi nội dung hiển thị:

1. **Incremental ledger** — `IncrementalLedger` + `AssessmentStore.recordsSince()` + `src/state/adapter.ts`. Canonical rows là append-only nên mỗi row được validate/index **một lần**;
   mỗi lần đọc chỉ tốn phần row mới. Snapshot bất biến (rows deep-frozen, arrays frozen) và dùng chung khi ledger không đổi. Kết quả bằng `indexRecords(store.records())`,
   gồm diagnostics, bound 64 MiB và cap 100000 rows. Lỗi giữa chừng bỏ cache và rebuild từ store, không tin trạng thái nửa vời.
2. **Memo theo snapshot** — `src/ledger-memo.ts`, `taskFrontier`/`taskHead`/`taskRevisionAt`. Trước đây `taskRevision`, `taskAt` và `taskFrontier` quét toàn bộ records cho **mỗi** task ref
   trong `caseViews`/`coverageViews` (≈75% thời gian `statusView` khi có cases/cells). Cache khoá theo mảng `records` của snapshot, tự bỏ nếu mảng dài thêm.
3. **Digest lazy** — `reportProjection().version` (SHA-256 mọi record) chỉ tính khi đọc `version`; status/widget không đọc. Giá trị, JSON và spread không đổi.

```sh
npm run build
node --expose-gc scripts/check-assessment-status.mjs --source --records=10000 [--mixed]
node --expose-gc scripts/check-assessment-status.mjs --source --records=100000 --quota-mib=512 [--mixed] [--incremental-only]
```

Corpus synthetic như script context (200 task heads, 20 open gaps); `--mixed` thêm 12 claims, 9 owner cases (5 task pins mỗi case, một phần đã superseded) và một coverage plan 40 cells qua `CaseBoard`/`CoverageBoard` thật.
7 lần lặp, một lần chạy cục bộ trên Linux x64, i7-1355U, 12 logical CPUs, 33.3 GB RAM, máy còn chạy IDE/browser nên số dao động giữa các lần. **Refresh** = đúng công việc của widget sau một commit
(`readLedger()` + `statusView()`); cột *full rescan* là đường cũ (`store.records()` → `indexRecords()` → `statusView()`) nhưng chạy với projection mới, nên **đánh giá thấp** chi phí gốc.

| Source jiti / corpus | Full rescan p50 / p95 | Refresh mới p50 / p95 | Cold load (một lần) | Đọc sau 1 commit | Live heap giữ lại |
|---|---:|---:|---:|---:|---:|
| Node 24.19.0 / simple 10k | 50.43 / 70.07 ms | **8.98 / 13.25 ms** | 57.57 ms | 0.89 ms | 15.7 MiB |
| Node 24.19.0 / mixed 10k | 54.28 / 68.45 ms | **10.84 / 11.64 ms** | 65.26 ms | 0.89 ms | 16.4 MiB |
| Node 22.19.0 / mixed 10k | 63.14 / 82.09 ms | **13.20 / 22.97 ms** | 65.29 ms | 0.88 ms | — |
| Node 24.19.0 / simple 100k (quota 512 MiB) | 579.81 / 641.61 ms | **93.49 / 114.01 ms** | 584.89 ms | 8.57 ms | 80.7 MiB |
| Node 24.19.0 / mixed 100k (quota 512 MiB) | 620.34 / 668.30 ms | **103.66 / 110.31 ms** | 621.17 ms | 8.61 ms | 80.3 MiB |

Số gốc trước thay đổi, cùng máy: simple 10k widget path 77.92 / 97.04 ms (Node 22: 81.80 / 124.52), simple 100k 846.79 / 977.02 ms (lần thăm dò đầu 672 / 689),
mixed 10k full rescan 162 / 197 ms; mixed 100k với incremental ledger nhưng **lookup cũ** 1692.9 / 1780.6 ms, tức memo một mình cho ≈16×.
Live heap là `heapUsed` sau GC (RSS còn giữ trang V8 chưa trả cho OS nên không dùng làm bằng chứng); peak RSS của đường cũ ở 100k ≈ 1.23–1.31 GB, đường mới ≈ 0.77–0.82 GiB gồm cả overhead loader/store.

Mục tiêu kế hoạch §13.2 (status local p95 < 200 ms) **đạt trên corpus này ở 10k và 100k** (≤ 114 ms). Giới hạn còn lại, không che:
- `statusView` vẫn suy counts từ **toàn bộ snapshot trong bộ nhớ** (O(lịch sử) mỗi refresh, bị chặn bởi cap 100000 rows của ledger); chưa đếm từ `knowledge_heads`/SQL.
  Đổi sang heads cần differential test để giữ nghĩa nhãn accepted-current/pending-review/complete; chưa làm.
- Cold load ≈ 0.6 s ở 100k xảy ra một lần trên mỗi store mở; microbench không gồm TUI render, I/O terminal hay corpus thật có nhiều cases/cells hơn.
- Pacing UI (`src/ui/refresh.ts`): widget chỉ quét khi `ctx.mode === 'tui'`, chờ `max(25 ms, 4× chi phí lần quét trước)` ≤ 5 s; chỉ giới hạn tần suất, không đổi nội dung hay authority.

Bằng chứng tương đương: 17 tests differential (scanner cũ nguyên văn làm oracle trên 80 corpora valid/corrupt; incremental = full scan ở **mọi prefix** của 60 cách chia batch; bound byte/row; adapter với store thật;
projection + `version`; lookups với index dựng tay), tất cả 16 mutants thử trên bản copy cô lập đều bị giết, và differential cross-version giữa source trước/sau
(100 seeds × 60 thao tác qua board thật, **6000 so sánh giống hệt**, gồm 203 trạng thái có accepted finding và 3581 trạng thái có stale case). Script cross-version là công cụ tạm, không ship.

## Verification scope

- Full schema-7 source: **357 Vitest passed / 12 skipped** (40 passing files / 6 skipped), Python
  **143 / 1 skipped**, typecheck/build/import pass. Initial stale schema-literal failures được giữ riêng,
  không hạ assertions để pass; schema 3/4/5/6 + unknown vẫn metadata-only, không migration.
- Context foundation 10 tests, runtime 3 tests: no cold-history materialization, exact counts/bytes,
  37 old gaps/reviews rotation, resolutions on unindexed carrier, separate actor claims,
  pre/post-commit ACK faults, later events, current task relevance, transitive case/cell staleness,
  read-only reopen và checkpoint+tail equality. Runtime uses real SQLite/Unix socket + inert executor,
  profile/revocation/forged-ACK/abort/provider-error/no-extra-request tests.
- Actual Pi inert native fixtures verify role packet reaches provider context, schema projection,
  delivery events and no additional model calls for human historical views. Không paid/live/installed proof.

Microbench tái tạo (không target/provider/reference execution):

```sh
npm run build
node --expose-gc scripts/check-assessment-context.mjs --source --records=10000
node --expose-gc scripts/check-assessment-context.mjs --source --records=100000 --quota-mib=512
```

`records`: default 32, choices 32/10000/100000. Fixture `quota-mib`: default 256, min 8, max 1024;
100k receipt dưới đây dùng **explicit 512 MiB fixture quota**, không sửa operator settings/runtime default.
Corpus: 200 hot task heads, 20 unresolved gaps, 9780/99780 cold task revisions; 100 records/batch,
64 repeated context/head/line queries. Linux x64, i7-1355U, 12 logical CPUs, 33.3 GB RAM.
Node-24 runs đồng thời full regression/corpus khác nên không là controlled cross-version speed comparison.

| Source jiti / corpus | Context p95 | Head page p95 | Human head lines p95 | Max packet | RSS sau query+GC |
|---|---:|---:|---:|---:|---:|
| Node 22.19.0 / 10k / quota 256 MiB | 3.53 ms | 0.48 ms | 0.72 ms | 17488 B | 97263616 B |
| Node 24.19.0 / 10k / quota 256 MiB | 11.41 ms | 1.50 ms | 1.92 ms | 17488 B | 128053248 B |
| Node 24.19.0 / 100k / quota 512 MiB | 24.29 ms | 0.67 ms | 0.62 ms | 17613 B | 190353408 B |

Mỗi context tối đa 53 exact record lookups; context+page+lines tối đa 93, cold materializations 0.
Head lines ≤2542 B; encoded head page ≤6479 B trong corpus này. Đây là microbench, **không** full
status/UI TUI-render p95, proof-quality, paid cancellation/billing, installed release hay superiority over ARTEX.
Receipts tạm: `tmp/knowledge-implementation/k6-*`; không stage/package các logs/private state đó.
