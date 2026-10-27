# Indexed knowledge và context packets (K6)

Schema 7. Đã push và cài; toàn K0–K7 vẫn mở. Bản chi tiết (kể cả bảng số đo đầy đủ): `git show 656843d:docs/CONTEXT_PACKETS.md`.

## Công nghệ cốt lõi

- `knowledge_heads` là **index dựng lại được** (task/plan/case/cell lưu legacy/candidate/gap/phase/report/evidence head) và `knowledge_links` nối các
  ID đã giữ, nằm trong `assessment.sqlite`; không có store hay Planner thứ hai, không xóa revision cũ hay observation thô. Candidate head tách theo actor + handle.
- `src/context.ts` thuần: sinh descriptor và kiểm tra checkpoint + tail; không dispatch, không I/O, không authority. Support của case và cell lưu legacy bị vô hiệu
  theo link trong cùng transaction (chỉ **hạ**, không nâng proof); cell dẫn xuất của A3 không nằm trong ledger nên currentness của nó được chiếu lại khi đọc. Nhãn head `accepted/reported` chỉ để điều hướng — proof vẫn đọc qua `p2o_board board=cases|coverage`.
- **Packet request-local** (Planner ≤20 KiB, Worker/reporting ≤20 KiB, digest cho người ≤16 KiB): run/role/task, sequence barrier, số đếm chính xác,
  shown/omitted, ID để truy xuất, thay đổi, attention, các trang gap/review xoay vòng và hàng relevance. Mỗi request thay packet cũ (không append, không sửa system prompt/tools,
  không tạo model turn hay retry). Hash chỉ nhận diện bytes, không chứng minh model hiểu.
- **`backlog` (chỉ packet Planner, chỉ khi có gì đang chờ):** con trỏ để chọn việc khi frontier cạn — `unplannedAssets` (tài sản hiện hành chưa có cell dẫn xuất còn hiệu lực), `cellsNotRun` (cell dẫn xuất đang `planned`/`running`, hoặc `unplanned` của plan legacy, chưa chạy) và `wstgSuggestions` (số test WSTG khớp feature đã ghi, xem `docs/WSTG_MAP.md`). Backlog đọc chính projection mà board coverage và báo cáo đọc. Chỉ có `total` và tối đa 5 ID mỗi mục; không điểm số, không task, không dispatch — Planner vẫn tự quyết, kể cả `blocked`. Khi packet vượt ngưỡng, ID bị bỏ trước mọi mục khác, `total` giữ nguyên. Không có gì chờ thì không có khóa `backlog` và packet không đổi một byte.
- **Delivery cursor** chỉ được ACK ở assistant `message_end` thành công (không ở `agent_start`): ghi `context.consumed` + cursor + kết quả request trong một transaction;
  ACK stale/forged/aborted/revoked không làm cursor tiến. ACK là biên nhận giao, không phải review.

## Dùng

```text
/p2o heads [domain|all] [cursor] [limit]      /p2o digest      /p2o search <text> [cursor=N]
p2o_state {"action":"heads","domain":"case","cursor":0,"limit":20}      # | "search" với "q"
```

Đọc có index, không gọi model/target, không ACK cursor, dùng được sau `open` lịch sử. `domain` ∈ task, goal, todo, decision, case, coverage-plan,
coverage-cell (chỉ cell lưu legacy; cell dẫn xuất đọc qua `p2o_board board=coverage`), candidate, gap, phase, report, evidence; limit mặc định 20 (1–100); trang ≤48 KiB. `search` là chuỗi con 2–80 ký tự, không phân biệt hoa/thường, không
regex, trên text/surface/risk/outcome/title của record (không tìm trong artifact); trả ≤20 con trỏ đã redact — không phải evidence. `p2o_state` chia ngân sách đọc
knowledge hiện có (planner 400, Worker 160/200).

Hot head luôn đọc từ index canonical; revision cũ vẫn bất biến và truy xuất được; không TTL, purge hay tóm tắt do model. Thiếu index/schema thì ghi rõ gap,
không fallback quét toàn lịch sử. Còn mở: checkpoint/archive >64 MiB, TUI render p95, đếm status từ heads/SQL, fixture replay hỗn hợp lớn.

## Legacy status and widget path

`/p2o status|tasks|report` và widget TUI vẫn đọc ledger v2 (`readLedger()` → `statusView()`), không qua heads. Ba thay đổi giảm chi phí mà không đổi nội dung:
(1) `IncrementalLedger` + `AssessmentStore.recordsSince()` — mỗi row chỉ validate/index một lần, snapshot bất biến dùng chung; (2) memo theo snapshot trong
`src/ledger-memo.ts` (bỏ quét toàn bộ cho mỗi task ref); (3) digest `reportProjection().version` tính lazy. Widget chỉ quét ở TUI, cách lần trước ≥ `max(25 ms, 4× chi phí)` (≤5 s).

```sh
node --expose-gc scripts/check-assessment-status.mjs --source --records=100000 --quota-mib=512 [--mixed]
```

Corpus synthetic 100k: refresh p50/p95 ≈ 94/114 ms (đường cũ ≈ 580/640 ms), đạt mục tiêu < 200 ms; vẫn O(lịch sử) và bị chặn bởi cap 100.000 row; chưa gồm TUI render.

## Verification scope

Bounds: `contextPacket.maxBytes` 20 KiB (4–48), 53 lookup chính xác tối đa mỗi context, 0 cold materialization. Microbench (`scripts/check-assessment-context.mjs --source --records=10000|100000`)
trên i7-1355U: context p95 ≈ 24 ms, head page p95 ≈ 0,7 ms ở 100k, packet ≤ 17,6 KB (fixture quota 512 MiB, không đổi default runtime). Test: 10 foundation + 3 runtime + fixture Pi thật inert
(packet tới provider, schema, delivery event, không thêm request cho view lịch sử). Không phải UI/proof/installed/paid acceptance.
