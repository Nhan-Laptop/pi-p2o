# Asset/fact/hypothesis graph — K3 trong source checkout

**Đã implement và nối runtime; chưa publish/install.** Không coi K3 là hoàn tất [K0–K7](../planning_update.md).
Graph là tri thức của run, không phải scope authorization, finding đã verified hay một writable task/finding store khác.

## Tham khảo ARTEX, không bê nguyên kiến trúc

Lượt nghiên cứu chỉ đọc bản static `my_references/ARTEX/`; không chạy/import/package reference code.
Các điểm source-confirmed trong `db/schema.sql`, `db/assets.go`, `db/task_assets_context.go`:

| Pattern ARTEX | Áp dụng vào p2o | Khác biệt/gate |
|---|---|---|
| Unique identity, ví dụ endpoint `(url, method)` | Một entity ID; nhiều revision/provenance, batch transaction | Identity policy v1 dùng exact bytes trong confirmed target/source scope; không tự normalize slash/case/query/method/IPv6 |
| Node/anchor writes trong transaction | Asset/assertion/relation/anchor + event/outbox/retained ACK commit cùng SQLite | Không thêm graph DB hoặc JSONL writer thứ hai; task/candidate vẫn dùng state hiện có |
| Context theo task/source-task | Host gắn task/role/depth vào provenance; indexed bounded per-asset views | Bounded role/task packets và relevance selection đầy đủ vẫn là K6, không giả đã có vì graph query nhỏ nhanh |
| Relational graph views | JSON/Mermaid, current heads và history tách biệt | `alias_of` chỉ là assertion; không destructive merge, không proof hay permission |

Không sao chép worker TTL/retry, credential plaintext, automatic scope widening hay finding acceptance.
Không có hidden graph-writer model. Giống một pattern ARTEX không chứng minh p2o tối ưu hơn ARTEX.

## Identity, revision và attribution

- Store schema hiện **6** (K4 thêm indexed work/planning), identity policy **1**, record exchange **v2**; schema 3/4/5 chỉ metadata-only read-only inspection, writer/domain queries bị từ chối. Không migrate in place. [Work/planning K4](WORK_ADMISSION.md).
- Scope hash từ identity version + target kind/identity + confirmed source snapshot SHA256. Không lấy scope từ model; source sealing không được đổi identity sau khi assets đã tồn tại.
- Asset ID từ scope + kind + key, SHA256 prefix 24 hex; revision ID `<entityId>-rN`. Content hash canonical không phụ thuộc object key insertion order, actor, timestamp hay locale.
- Path case, URL percent encoding/query order/repeated parameters, slash, method case và IPv6 spelling không tự collapse. Cần opaque operator handle khi key chứa secret hoặc representation không được hỗ trợ; không silently redact identity thành collision.
- Descriptive labels/attributes/locators redact best effort; common secret-bearing identities, URL userinfo/sensitive query names, unknown/host-owned fields, prototype keys, controls/bidi/NFD bị từ chối. Đây không phải lời hứa nhận diện mọi secret format.
- Content giống nhau không sinh revision mới. Producer/assignment khác giữ observation riêng cho revision đó. Same actor/task/content với request mới không sinh observation lặp; cùng authenticated request ID/payload trả ACK gốc.
- Provenance do current owner/Worker registry gắn: actor/task/role/depth. Batch không được tự khai authority/producer/scope.
- `expectedRevision`, claim `assetRevision`, relation `fromRevision/toRevision`, và `supersedes` kiểm tra head hiện tại trước commit. Stale write rollback cả batch; không tự retry/refresh pin.
- Fact/hypothesis history và counterevidence được giữ. Correction/withdrawal có revision; asset change làm claim stale, relation kiểm tra **cả hai endpoint**. Anchor có history riêng; metadata correction không tự thành target proof.

## Công cụ model và đường broker

`p2o_graph` dùng root object schema để Pi legacy Anthropic projection không làm mất `properties/required` như root `anyOf`.
Host vẫn enforce action-specific fields, required arguments, limits và role gates; schema không thay authorization.

```json
{
  "action": "record",
  "requestId": "knowledge-001",
  "batch": {
    "assets": [{
      "ref": "entry",
      "asset": {
        "kind": "file",
        "key": "src/auth.py",
        "anchors": [{"kind": "symbol", "value": "check_gate", "locator": {"line": "12"}}]
      }
    }],
    "facts": [{
      "assetId": "@entry",
      "kind": "inferred",
      "statement": "Cần kiểm tra policy cho actor khác; chưa có runtime proof.",
      "confidence": "low"
    }]
  }
}
```

`@entry` là ref local trong batch; khác revision ID và stable `entityId` trong ACK.

```text
p2o_graph {action:"view", id:<asset entity ID>, cursor?, limit?, asOfSequence?}
p2o_graph {action:"page", cursor?, limit?, asOfSequence?}
p2o_graph {action:"export", cursor?, limit?, asOfSequence?}
```

- Owner/solo/delegated Planner: record/read knowledge; delegated Planner vẫn không target execution.
- Worker: assets/facts/anchors; hypotheses/relations là owner review work. Graph writes cần verified runtime và current assignment, storage/admission gates vẫn giữ.
- Reporting: graph **read-only** trong model loadout và broker; record bị synthesis-only gate chặn ở cả hai đường.
- Reads dùng `graph_read`; public tool `id` map sang RPC **`assetId`**, không ghi đè correlation envelope `id`.
- Worker knowledge dừng ở 160 trong coordination cap 200, chừa 40 cho coordination/report; owner knowledge cap 400. Retained owner ACK lookup không charge lại. Đây không phải turn/token/billing budget.
- `graphReplay` trả `GraphAck[]`, report replay vẫn `RecordAck[]`; không cast graph ACK thành report ACK. Lost delivery chỉ lấy kết quả đã commit, không target replay.
- Stop/revocation/history không cấp model authority mới. Receipt-only ACK inspection vẫn cần active owner/current registry và không được query graph hoặc mutate/renew budgets.

Observed/configuration/contract facts, observed relations và resolved hypotheses cần same-run receipts theo rule tương ứng; missing/foreign/imported evidence IDs bị từ chối.
Mọi fact/hypothesis vẫn `unverified:true`; nhiều submissions/producers không đồng nghĩa independent evidence hay finding verification.

## Human visibility và bounded queries

```text
/p2o graph
/p2o graph page <cursor>
/p2o graph <asset-id> [cursor]
/p2o graph export [limit] [cursor]
```

Human export hiển thị **JSON/Mermaid thật** trong read-only screen/RPC notification, không tạo host file hay model turn.
TUI scroll/PageUp/PageDown/reflow như các state views; JSON có thể dài hơn viewport đầu tiên.
`/p2o export <absolute-dir>` là portable file bundle riêng, human confirmation, không phải graph canvas/dashboard.

| Giới hạn | Default | Min | Max / semantics |
|---|---:|---:|---|
| Model asset page | 20 | 1 | 100; lịch sử asset revisions, không chỉ unique heads |
| Per-asset history | 20 sequence groups | 1 | 100 groups; row + provenance cùng sequence không tách trang |
| Graph JSON/Mermaid export | 200 | 1 | 500 selected heads; byte cap có thể giảm số hiển thị |
| Encoded graph read result | — | — | 24 KiB; counts/cursor/omissions nằm trong response |
| Mutation batch | — | 1 row | 128 effective rows, **tính cả nested anchors**; canonical payload ≤128 KiB, broker frame vẫn 64 KiB |
| Retained graph row | — | — | 8 KiB, chừa metadata; dài hơn phải dùng artifact |
| Nested anchors/asset input | — | 0 | 10; standalone anchors vẫn chịu batch/global caps |
| Asset revisions/run | — | — | 5000; không phải số unique assets hay elapsed TTL |
| Assertion revisions/run | — | — | 10000 |
| Relation revisions/run | — | — | 2000 |
| Anchor revisions/run | — | — | 20000 |
| Provenance rows/run | — | — | 40000; hết capacity không tự archive/nâng quota |

Views dùng indexed SQL và retained head/history, không load toàn graph để trả một page.
History chứa provenance của asset **và** linked assertions/relations/anchors. Cursors là sequence; pin `asOfSequence` khi duyệt snapshot nhiều trang.
Export dùng current heads; `countScope` nói rõ assertions/anchors chỉ thuộc selected assets, relations cần cả hai endpoints selected.
Cross-page/byte-omitted data vẫn retrieve bằng asset history; không suy ra absent/clean từ một partial graph.
Mermaid dùng full entity IDs/distinct assertion nodes, escaped labels, stale/withdrawn edge labels; không execute input text.

## Checkpoint, portable data và authority

- Checkpoint barrier S chứa graph revisions + toàn provenance và canonical graph hash/scope/head counts. `applyGraphEvents(snapshot, tail)` chỉ rebuild knowledge, reject foreign run/scope; không store write hoặc target call.
- Portable bundle **v2** thêm `segments/graph-NNNNN.ndjson`; v1 vẫn inspect/import được. Artifact export dùng verified **bytes**, không decode từng range rồi encode lại làm hỏng UTF-8 boundary.
- Import giữ graph segments như foreign immutable artifacts + provenance note, **không** nạp lại thành writable graph/evidence/current supports. Hash integrity không authenticate foreign redaction claims; bytes có thể nhạy cảm.
- New bundle có `.p2o-knowledge-bundle`/`.npmignore`; source clone bỏ recognized bundle roots (kể cả markerless v1/temporary export), source/private roots đã chọn và prior stores. Packaging canary kiểm tra nested bundles trong broad `files/` paths.
- Segmentation >64 MiB, ancestor-race/partial-import hardening, broader archive/legacy-domain import và currentness là gates K2/K5/K6 còn mở; không dùng checkpoint/import để renew execution.

## Qualification và số đo

Receipt **K3/schema 5 trước K4**: đã chạy full source checkout **297 Vitest / 12 skipped**, Python **143 / 1 skipped**, typecheck/build/import; Docker opt-in **5 tests**. Fixture Pi graph/native cùng planner-native đã qua **4 tests**.
Actual Pi RPC fixture chạy graph record/replayed ACK/view/export qua tool validator với inert provider/sandbox; human historical graph reads không thêm model request/message.
Đây không phải commercial-provider API, installed acceptance, live Herdr/cancellation/billing hoặc assessment correctness proof.

Reproduce (local inert fixtures, không reference/target/provider activity):

```sh
npm test
npx vitest run tests/minimal/graph.test.ts tests/minimal/graph-native.test.ts tests/minimal/workspace-runtime.test.ts
P2O_TEST_DOCKER=1 npx vitest run tests/minimal/artifacts-docker.test.ts tests/minimal/docker-extension.test.ts tests/minimal/isolated-docker.test.ts
node scripts/check-assessment-graph.mjs --source
npm exec --offline --package=node@22.19.0 -- node scripts/check-assessment-graph.mjs --source
node scripts/check-assessment-graph.mjs --assets=1000
node scripts/check-assessment-graph.mjs --assets=4000
```

Native source loaded qua Pi jiti trên Node 22.19.0/SQLite 3.50.4 và Node 24.19.0/SQLite 3.53.4 (200 assets).
Measurements ESM Node 24, Linux x64/i7-1355U/12 logical CPUs/RAM 33.3 GB; mỗi asset có inferred assertion + anchor, hai producers, ~N/4 relations, 5% asset revisions. 32 read samples:

| Assets | Commit p50/p95 (batch 16 assets + claims/anchors/relations) | Page p50/p95 | History p50/p95 | Export p50/p95 | Checkpoint | RSS sau inspect/rebuild |
|---|---|---|---|---|---|---|
| 1000 | 15.65 / 18.44 ms | 0.56 / 0.63 ms | 0.55 / 0.75 ms | 3.04 / 4.94 ms | 120.71 ms | 273117184 B |
| 4000 | 21.74 / 28.96 ms | 2.70 / 2.89 ms | 0.67 / 0.76 ms | 5.03 / 6.32 ms | 475.53 ms | 351649792 B |

Results ≤24 KiB; private usage ~30.7/122.2 MB. Graph page tránh bốn count queries không cần thiết; export không duplicate anchor arrays.
Single local synthetic runs, không paired benchmark chứng minh speedup, UI/context p95, stable RSS hay global optimality. Snapshot còn synchronous/full-history; K6 phải đo và tối ưu riêng.
Không chạy ARTEX để so sánh và chưa đo effectiveness, token savings hoặc finding correctness.
