# Verification log — tóm tắt receipt lịch sử

Bản này chỉ giữ mốc và con số chính. **Toàn văn từng receipt** (lệnh, số đo, ghi chú từng lát) vẫn nằm nguyên trong git:
`git show 656843d:docs/VERIFICATION_LOG.md` (và `docs/KNOWLEDGE_WORKSPACE.md` cùng commit cho receipt S1–S6 mới nhất). Mỗi dòng đúng **tại thời điểm của nó**
(chưa commit/chưa cài/Pi cũ); không dòng nào thay cho kiểm chứng của code hiện tại — chạy `npm test` để biết trạng thái thật.

| Mốc | Ngày | Commit | Kết quả đáng nhớ |
|---|---|---|---|
| K1 visibility | — | — | 194 Vitest passed / 9 skipped; Docker cục bộ 2 pass |
| K2 canonical store → artifact/scratch/bundle/reconcile | — | `7e204c3` | Store chạy trên Node 22.19 (SQLite 3.50.4) và 24.19 (3.53.4); fixture 10k/100k record; fault matrix (before/after commit, SQLITE_FULL, SIGKILL, symlink, corrupt bytes) |
| K3 graph (schema 5) | — | `7e204c3` | 297 Vitest / 12 skipped, Python 143; Docker opt-in 5 pass; 4.000 asset đo được |
| K4 work/planning (schema 6) | — | `7e204c3` | 321 → 324 Vitest / 12 skipped sau hardening; Docker opt-in 5 pass; pack dry-run 353 file |
| K6 context (schema 7) | — | `7e204c3` | 357 Vitest / 12 skipped, Python 143; microbench 10k/100k ([CONTEXT_PACKETS](CONTEXT_PACKETS.md)) |
| K6 status/widget incremental | 2026-10-10 | `7e204c3` | refresh p95 ≤ 114 ms ở 100k; 17 test differential, 16/16 mutant bị giết |
| Pi 1.0.0 → 1.1.0 | 2026-10-10 | `007ee58` | Baseline 357 pass trước khi đổi; devDependencies pin 1.1.0 |
| K7 acceptance matrix | 2026-10-10 | `7e204c3` | Ma trận 22 + 7 điều kiện có guard tự động; +3 fixture lấp khoảng trống |
| Commit/push/cài K2–K7 | 2026-10-10 | `007ee58`, `7e204c3` | Theo yêu cầu rõ của chủ repo; không đổi version |
| Giai đoạn W0–W6a | 2026-10-10 | `b7cfa6f`, `41e8157` | Digest runtime, điều khiển operator (`hold`/`release`/`stop-worker`), báo cáo tất định, tìm kiếm, usage; đã push và cài |
| Benchmark trả phí W (có trần) | 2026-10-10 | — | `deepseek/deepseek-flash`, solo: tool guidance tăng chi phí ≈ +73% mà không tăng chất lượng → tắt mặc định (`p2o.toolGuidance`). **Từ 2026-10-11 không chạy benchmark trả phí nữa** |
| Prompt/skill/WSTG S0–S6 | 2026-10-11 | tới `4bd7674` | 481 Vitest / 12 skipped, Python 143; ngữ cảnh worker recon 8.338 → 6.415 ký tự; bản đồ WSTG 108 test (D/T/N/O chưa được owner rà soát) |
| Workflow đầy đủ + báo cáo OWASP (P0–P7) | 2026-10-11 | `be959d5` | `npm test` xanh (Python 155); finish preflight, báo cáo tự động, rating case, báo cáo v2 |
| Kiểm toán extension S1–S6 | 2026-10-11 | `656843d` | 556 → 558 Vitest / 12 skipped, Python 155; khai báo 24 tool 44.393 → 38.587 B (−13,1%), `extensions/p2o/index.ts` 1.856 → 1.803 dòng; 3 thay đổi hành vi có chủ đích (từ chối C1/bidi trong văn bản tự do, `planFrontier` chặt hơn, `openGapIds` tính cả candidate gap) |
| `--goal`, nudge skill, thẻ severity | 2026-10-12 | `656843d` | 558 Vitest / 12 skipped, Python 155; `/p2o --goal "…"` (1–600 ký tự), nudge nằm trong mô tả `p2o_skill_list` |

## Ghi chú còn giá trị

- Ba test `planner-native` (Pi thật) thỉnh thoảng lỗi khi chạy song song dưới tải; chạy riêng thì qua — tăng timeout, đừng thu nhỏ dữ liệu.
- Index GitNexus bị hỏng khi thiếu node `Function` cho `src/*.ts` (impact trả `UNKNOWN`): rebuild đầy đủ bằng
  `node .gitnexus/run.cjs analyze --force --no-parse-cache --index-only`; `.gitnexusignore` loại `my_references/`.
- Audit phụ thuộc cũ còn `@vitest/mocker` moderate, `brace-expansion` high, `tinypool`/`vitest` critical; không tự `audit fix`.
- Chưa có Herdr thật, `--live`, hay benchmark trả phí cho các thay đổi sau W; hiệu quả pentest vẫn **UNVERIFIED**.
