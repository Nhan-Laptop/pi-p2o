# Asset / fact / hypothesis graph (K3)

Graph là tri thức của run — không phải scope authorization, không phải finding đã verified, không phải task store thứ hai.
Chi tiết bản cũ: `git show 656843d:docs/ASSET_GRAPH.md`.

## Công nghệ cốt lõi

- Lưu trong **cùng SQLite** ([STATE_STORE](STATE_STORE.md)): asset, assertion (fact/hypothesis), relation, anchor và provenance
  commit cùng event/outbox/ACK. Không có graph DB hay writer thứ hai. Lấy ý từ ARTEX (identity duy nhất, ghi theo transaction,
  context theo task) nhưng không chạy hay copy code của nó.
- **Identity**: scope hash = identity version (1) + target + SHA256 snapshot source đã xác nhận; asset ID = hash(scope, kind, key)
  24 hex, revision `<entityId>-rN`. Key là bytes chính xác — không tự normalize path/URL/case/IPv6. Nội dung y hệt không sinh
  revision mới; producer khác nhau giữ observation riêng.
- **Provenance** (actor/task/role/depth) do owner/Worker registry gắn, batch không tự khai quyền.
- **Pin revision**: `expectedRevision`, `assetRevision`, `fromRevision/toRevision`, `supersedes` được kiểm tra trước commit;
  stale write rollback cả batch. Asset đổi làm claim stale; relation kiểm tra cả hai đầu. Lịch sử và counterevidence được giữ.
- Mọi fact/hypothesis luôn `unverified:true`. Nhiều producer không đồng nghĩa evidence độc lập. Fact observed/configuration cần
  receipt cùng run; ID thiếu/foreign/imported bị từ chối. Label và attribute được redact best-effort, không hứa nhận diện mọi secret.

## Dùng

```text
p2o_graph {action:"record", requestId, batch:{assets:[{ref, asset:{kind,key,anchors?}}], facts:[{assetId:"@ref", kind, statement, confidence}]}}
p2o_graph {action:"view", id:<asset>, cursor?, limit?, asOfSequence?}   # page | export tương tự
p2o_graph {action:"chain", limit?}   # owner-only: join typed gained/needs → ready | unmet | frontier
/p2o graph   |   /p2o graph page <cursor>   |   /p2o graph <asset-id> [cursor]   |   /p2o graph export [limit] [cursor]
```

`@ref` chỉ có nghĩa trong batch. Quyền: owner/Planner ghi và đọc (Planner vẫn không chạy target); Worker ghi
assets/facts/anchors, còn hypothesis/relation do owner; reporting **chỉ đọc**. Đọc dùng SQL có index, pin `asOfSequence`
khi duyệt nhiều trang. Export hiện JSON/Mermaid thật trong màn hình read-only, không ghi file ra host (`/p2o export` là bundle riêng).

`chain` là join chỉ-đọc trên chính các claim đã ghi: `ready` (claim đang mở mà mọi capability trong `needs` đã có claim
confirmed+tested khai `gained`), `unmet` (còn capability chưa ai cấp; gap nêu đúng `kind` còn thiếu), `legacy` (claim còn chữ
tự do `provides`/`requires` từ trước P14: vẫn đọc được, báo ra, nhưng không khớp gì), `frontier` (đường ngắn nhất từ một
primitive tới claim đó). Không lưu gì mới, không thêm quyền, và worker không đọc được — đó là điều phối của lead.

| Giới hạn | Giá trị |
|---|---|
| Page / history / export | 20 (≤100) / 20 nhóm sequence (≤100) / 200 head (≤500); kết quả ≤24 KiB |
| Batch | ≤128 hàng (tính cả anchor lồng, ≤10/asset), payload ≤128 KiB, mỗi hàng ≤8 KiB |
| Mỗi run | 5.000 asset rev · 10.000 assertion · 2.000 relation · 20.000 anchor · 40.000 provenance |
| Đếm lệnh Worker | chỉ là quan sát cho ledger/report; không có ngưỡng nào chặn lệnh (bỏ ngân sách 2026-10-24) |

## Checkpoint và bundle

Checkpoint chứa graph revisions + provenance; `applyGraphEvents(snapshot, tail)` dựng lại tri thức, từ chối run/scope lạ,
không ghi store hay gọi target. Bundle v2 có `segments/graph-*.ndjson` (v1 vẫn đọc); import giữ chúng như artifact ngoại lai,
không nạp lại thành graph ghi được.

## Kiểm chứng

`npx vitest run tests/minimal/graph.test.ts tests/minimal/graph-native.test.ts tests/minimal/chain-view.test.ts` và `node scripts/check-assessment-graph.mjs --source`
(`--assets=1000|4000`). Microbench cục bộ ở 4.000 asset: commit batch p95 ≈29 ms, page ≈3 ms, export ≈6 ms, checkpoint ≈0,5 s.
Không đo effectiveness, tiết kiệm token hay độ đúng của finding.
