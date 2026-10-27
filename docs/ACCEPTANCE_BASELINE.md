# Acceptance baseline K0–K7

Các fixture và điều kiện dưới đây là hợp đồng không-được-regress của mọi giai đoạn sau K7. Chúng từng nằm ở §13 của `planning_update.md`; từ 2026-10-11 chúng ở đây để việc viết lại kế hoạch không còn phải ghép byte-identical một phần của nó.
[ACCEPTANCE_MATRIX](ACCEPTANCE_MATRIX.md) ánh xạ từng hàng tới test thật, và `tests/minimal/acceptance-matrix.test.ts` đọc **tệp này**: đúng 22 hàng ở §13.1 và đúng 7 gạch đầu dòng ở §13.3.

## Baseline K0–K7 (đánh số §13 theo kế hoạch gốc)

Mọi giai đoạn P0–P7 của kế hoạch này phải giữ nguyên các fixture và điều kiện này ([ACCEPTANCE_MATRIX](ACCEPTANCE_MATRIX.md) ánh xạ từng hàng tới test thật và có guard tự động). Fixture của giai đoạn W đọc ở §14 của bản `41e8157` (`git show 41e8157:planning_update.md`); các slice S0–S7 đã triển khai đọc ở bản `6cfb89d`.

### 13.1. Fixture scenarios bắt buộc (baseline K0–K7, không được regress)

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

### 13.2. Measurements: đã có và mục tiêu mới

Đã đo (synthetic, không phải hiệu quả pentest; phương pháp và giới hạn ở docs tương ứng):

| Số đo | Kết quả | Nguồn |
|---|---|---|
| Status/widget refresh p95 @100k (simple / mixed) | 114,01 / 110,31 ms (full rescan trước đó 580–642 / 620–668 ms) | `scripts/check-assessment-status.mjs`, KNOWLEDGE_WORKSPACE |
| Live heap giữ lại | ≈16 MiB @10k, ≈80 MiB @100k | CONTEXT_PACKETS |
| Event page p95 / checkpoint / RSS @100k | 13,49 ms / ≈498 ms / ≈435 MB | STATE_STORE |
| Graph 4000 asset: page / history / export p95, checkpoint | 2,89 / 0,76 / 6,32 ms; 475,53 ms | ASSET_GRAPH |
| Khai báo + chính sách theo loadout | §8, M1 (bản `41e8157`) | probe 2026-10-10 |

Phương pháp giữ nguyên: corpus deterministic 10k/100k, công bố phần cứng và corpus; báo p50/p95, RSS, kích thước on-disk; không lược bỏ dữ liệu rồi vẫn ghi "complete"; dedup phải báo cả suppression đúng lẫn **false suppression**; inert fixture chỉ chứng minh cơ chế, còn "pentest tốt hơn" cần benchmark có ủy quyền (cùng model/scope/budget, chạy lặp, control giữ lại, chấm độc lập), **chưa được thực hiện**. Số đo chi phí ngữ cảnh của giai đoạn W (§8, M1 và M1b) đọc ở bản `41e8157`; mục tiêu hiện hành (kích thước, nhất quán, độ phủ tài liệu) ở §E của file này; hiệu quả pentest vẫn **chưa được đo**.

### 13.3. Không đạt acceptance nếu

- Có graph nhưng không trả lời được “task nào chưa review, vì sao blocked, output ở đâu”.
- Checkpoint chỉ là model summary không có snapshot/version/refs.
- Finish xóa toàn bộ result mà user tưởng đã lưu.
- Graph dữ liệu được coi như authorization hoặc replay history tự chạy lại request.
- Mọi `confirmed` đều lên badge verified, hoặc “100% coverage” dựa touched assets.
- Dedup suppress validator/retest hoặc merge hai bug chỉ vì cùng CWE/title.
- Thêm background LLM hay đổi budgets/mode mà confirmation không nói.

---
