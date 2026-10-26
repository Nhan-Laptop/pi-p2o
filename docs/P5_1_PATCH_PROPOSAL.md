# P5.1 — Patch proposal sau measured gate 2026-10-26

**Trạng thái: đã implement 2026-10-26 (P0–P3 code + hermetic), chờ lần rerun đo.** Tài liệu này bắt đầu là proposal
(không sửa code, không gọi model, không liên hệ target, không đổi `planning_update.md`); phần §1–§8 giữ nguyên nội dung
đã được owner duyệt, §9 ghi as-built + kết quả rerun. Quyết định của owner: Q1a (reset streak khi resume), Q2a (bỏ cả fact
trước round đầu), Q3-A cho `risk`/`surface` + B cho field ngữ nghĩa, Q4 có (host auto-fill), **Q5b** (rerun trên target thật
`https://hcmussh.edu.vn/`, cap **$2**, heartbeat **600 s** như production — khác với đề xuất (a) fixture/300 s/$1,50 trong §5).

Bằng chứng nền: `tmp/p2o-live/gate-verdict.md`, `tmp/p2o-live/REPORT-final.md`, `tmp/p2o-live/final-metrics.txt`,
`tmp/p2o-live/monitor.jsonl`, `tmp/p2o-live/operator-actions.log` — run `run-74c4e640-d2ee-4dce-b4e4-886f0914b90b`,
`https://hcmussh.edu.vn/`, 56,6 phút, $0,54, 3 planner round / 4 stall-escalation / 3 operator resume / 0 heartbeat wake.

---

## 1. Kết luận gate (tóm tắt)

| Tiêu chí P5 | Kết quả đo | Hệ quả patch |
| --- | --- | --- |
| ≥3 planner round không human turn | **FAIL** — 3 round, cả 3 chỉ mở được sau `/p2o resume` | P0 |
| ≥1 debt/heartbeat continuation | **PARTIAL** — debt 3, heartbeat **0** | P0 |
| ≥1 hướng mới sau roadmap cạn | PASS — 4 discovery + 2 validation | không cần patch |
| Không refusal loop ở case đầu | PASS có điều kiện — 5 refusal `independent-support-stale`, dừng partial | P3 (chỉ message) |
| Report trung thực goal/partial | PASS | P1 (thêm số liệu để gate tự chứng minh) |

Ngoài gate: F-A2-9 **FAIL** (task-create 11/16 = 68,8 %), F-A3-11 PASS, F-A4-10 PASS.

**Mục tiêu P5.1:** một campaign 60–90 phút đạt ≥3 round **không cần resume**, ≥1 heartbeat wake, và report tự
chứng minh được "0 human resume" — mà không nới bất kỳ gate an toàn nào.

---

## 2. Nguyên nhân gốc (đọc code + đối chiếu ledger)

### R1 — Escalation latch: `stalls` không bao giờ reset (nguyên nhân chính)

- `src/engine.ts:61` — `private stalls = 0;` là bộ đếm **đơn điệu**.
- `src/engine.ts:224-236` — mỗi round stall: `this.stalls += 1`; escalation khi `this.stalls >= 3 && debt.gateable > 0 && live()` → `pause(...)`.
- `src/engine.ts:297-300` — `resume()` chỉ xoá `paused`/`decision`, re-arm heartbeat, `kick()` — **không reset `stalls`**.

Hệ quả: sau escalation #1, điều kiện `stalls >= 3` luôn đúng ⇒ **mỗi round stall tiếp theo đều pause ngay**.
Ledger khớp chính xác: escalation tại stalls 3 (07:05:20), 4 (07:18:22), 5 (07:34:04), 6 (07:50:40) — đúng một
stall sau mỗi lần resume.

### R2 — Hai stall "ma" ở startup (trước khi có round nào)

- `src/engine.ts:225` chỉ cần `openGoal && openIntents === 0`; round do lệnh `/p2o` của người kết thúc cũng thoả.
- Ledger: `planner.stalled` tại 06:56:18.929 (`rounds:0`) và 06:56:24.560 (`rounds:0`) — 6 giây sau `campaign.created`,
  chưa có round nào được admit. Escalation đầu tiên (07:05:20) cũng có `rounds:0`.
- Report hiện đếm các fact này ("stalled rounds 6") nên con số vừa sai ngữ nghĩa vừa góp 2/3 ngưỡng escalation.

### R3 — Heartbeat thua race với escalation (heartbeat 600 s không bao giờ fire)

- `src/engine.ts:248` — mỗi `consume()` (round boundary / mỗi lần ACK context) gọi `armHeartbeat()` **reset** timer.
- `src/engine.ts:294-296` — `pause()` gọi `clearHeartbeat()`.
- `extensions/p2o/index.ts:2636-2638` — round ACK chạy `consume()` rồi **ngay sau đó** `stallRound()`; round không có
  intent ⇒ heartbeat vừa arm bị `pause()` xoá.
- Ledger: 3 wake `reason=debt` (đều sau resume), **0 wake `reason=heartbeat`** trong 56 phút.

### R4 — Task-create bị từ chối 68,8 % (F-A2-9)

Nguồn từ chối quan sát được (planner, 16 call / 11 lỗi):

| Lỗi | Nguồn | Số lần |
| --- | --- | --- |
| `draft.risk: must not have more than 200 characters` | `src/tool-schemas.ts:20` (Pi validate args trước handler) | 1 |
| `Validation overlap needs a matching predecessor` | `src/tasks.ts:355` | 4 |
| `New work cannot claim a prior task/change reason` | `src/work.ts:92` | 4 |
| `Structured decision/retest/output contract requires a work identity` | `src/work.ts:152` | 2 |
| `UNKNOWN_PREDECESSOR: validationOf=claim-…` | admission `validationOf` | 1 |
| thiếu/sai `work.assetRefs`, `legalNext`, `Validation failed` khác | `src/tasks.ts:123` + harness schema | 3 |

Hai lỗi đầu là **host có thể tự suy** (validationOf ⇒ prerequisites + work), hai lỗi sau là **message không actionable**
(model gửi lại draft gần như nguyên trạng).

### R5 — Case acceptance từ chối mờ (không phải lỗi an toàn, chỉ là message)

- `src/cases.ts:82` — khi không có claim nào cite `data.independentEvidenceRef`, reason rơi về fallback
  `independent-support-stale:<evidenceId>` dù nguyên nhân thật là "chưa có claim peer cite receipt này".
- `src/cases.ts:139` — `Case review is stale/incomplete: <danh sách reason>` in nguyên list, không nêu hành động hợp lệ.
- Hệ quả trong run: 5/5 `p2o_case_revise` bị từ chối, model chọn partial stop và ghi đúng lý do ⇒ **giữ nguyên độ chặt**,
  chỉ sửa message.

---

## 3. Patch plan P5.1

### P0 — Continuation không cần resume (blocking gate)

**P0.1 — Reset escalation streak khi có human decision.** `src/engine.ts`

- Đổi ngữ nghĩa `stalls` thành *streak*: comment ghi rõ "số round stall liên tiếp kể từ lần resume gần nhất; tổng số
  fact vẫn đếm từ ledger cho report".
- `resume()`: `this.stalls = 0;` (cùng chỗ với `this.decision = undefined`).
- Không đổi tên field snapshot `stalls` (tránh churn schema/test); report giữ nguyên vì `authority.ts:77` đếm
  lifecycle `planner.stalled` từ ledger, không đọc engine counter.
- Test mới `engine-campaign.test.ts`: "resumes with a fresh stall streak, so a later pause needs three new stalled
  rounds" — 3 stall ⇒ pause; `resume()`; 1–2 stall ⇒ **không** pause; stall thứ 3 ⇒ pause.

**P0.2 — Không ghi escalation trước round đầu tiên.** `src/engine.ts:224`

- Đầu `stallRound`: `if (this.rounds === 0) return false;` — trước khi có wake nào được admit thì chưa có "round" để
  đánh giá; lệnh `/p2o` của người không phải một round của campaign.
- Quyết định kèm theo (Q2): bỏ **cả fact** hay chỉ bỏ escalation. Đề xuất: bỏ cả fact (report "stalled rounds" sẽ là 3
  thay vì 6, đúng ngữ nghĩa), và ghi rõ trong comment.
- Test cập nhật: 2 test hiện có trong `engine-campaign.test.ts` phải reserve một round trước
  (`f.engine.boundary()`), thêm assert "stall trước round đầu tiên không thành fact".

**P0.3 — (tuỳ chọn, Q1) Escalation chỉ khi round không có tiến bộ.** Nếu owner muốn chắc chắn hơn: dùng `quiet`/`judge`
(M6 đã có: `quietRounds()`) — escalation khi 3 **quiet round** liên tiếp + debt, thay vì 3 stall. P0.1+P0.2 thường đã đủ;
P0.3 làm ngưỡng "không tiến bộ" chính xác hơn nhưng đổi nhiều test hơn.

**P0.4 — Heartbeat không bị vô hiệu hoá bởi stall (hệ quả của P0.1/P0.2).** Không cần sửa timer; chỉ thêm test hồi quy:
`src/engine.ts:84-108` — "một round kết thúc không intent, sau 600 s idle ⇒ heartbeat wake debt; không pause trước đó"
(hiện chỉ test heartbeat với zero event). Nếu vẫn thấy pause trước heartbeat trong harness run ⇒ mở P0.3.

### P1 — Report tự chứng minh được gate (observability)

**P1.1 — Ghi `campaign.resumed`.** `extensions/p2o/index.ts` nhánh `/p2o resume` (hiện chỉ `current.engine.resume()`),
append một lifecycle record `{ event:'campaign.resumed' }` theo đúng cách `campaign.created` đang làm
(`extensions/p2o/index.ts:2326-2327`). Không cần field mới, không đổi authority.

**P1.2 — Đếm và in ra.** `src/authority.ts:26-33, 77-81`: thêm `campaignResumes` (lifecycle `campaign.resumed`) và
`stallEscalations` (lifecycle `planner.stall-escalation`); in trong `## Campaign` (`src/report-export.ts:286-291`) và
provenance (`src/report-export.ts:332`): `human resumes N; stall escalations N`.

**P1.3 — Acceptance matrix.** Thêm hàng F-A6-24 (resume được record + report đếm) và F-A6-25 (escalation counter) với
test hermetic; cập nhật F-A6-23 sau lần chạy lại.

Test ảnh hưởng: `tests/minimal/finish-campaign.test.ts` (byte-exact section), `report-export.test.ts`,
`acceptance-matrix.test.ts` (citation), `engine-campaign.test.ts` (nếu P0 đổi test cũ).

### P2 — Hạ task-create error rate xuống <5% (F-A2-9)

**P2.1 — Cap "cosmetic" không nên là hard error.** `src/tool-schemas.ts:20` (`risk`/`surface` 200, `roleReason` 1000) +
`src/tasks.ts:123` (`bounded()`).

- Phương án A (đề xuất): nới `maxLength` schema của `risk`/`surface` lên 4 × cap, và trong `validate()` **cắt** về cap
  kèm advisory `truncated:risk` trong ACK (model thấy warning, không bị refusal). Không áp dụng cho field ngữ nghĩa
  (`question`, `expectedTrue/False`, `stopCondition`, `work.*`).
- Phương án B: giữ refusal nhưng message nêu `{field, length, limit, legalNext}` + ví dụ draft tối thiểu.

**P2.2 — Host suy field khi `validationOf` có mặt.** `src/tasks.ts:340-360`, `src/work.ts:152`

- Nếu `role==='validation' && validationOf` (A2 đã resolve claim/task → task): host tự điền
  `prerequisites:[{taskId: prior.id, revision: prior.revision}]` và suy `work` từ predecessor nếu thiếu
  (assetRefs/questionKey/policyKey) — đúng tinh thần F-A2-4 (host resolve, model không tự khai).
- Giữ refusal khi `sameQuestion` lệch, nhưng message nêu key lệch: `assetRefs|questionKey|policyKey` + giá trị hai bên.
- Xoá được 6/11 lỗi đã đo (4 overlap + 2 work identity).

**P2.3 — Message actionable.** `src/work.ts:92`: nêu field thừa cụ thể ("drop `work.linked`/`work.result.changeReason`
for disposition=new") kèm legalNext.

Test: `validation.test.ts` (message cũ đang được pin), `intent.test.ts`, `workflow-policy.test.ts` (schema/masking),
thêm test auto-fill và truncation warning. Đo lại F-A2-9 ở lần rerun.

### P3 — Case acceptance message (không đổi độ chặt)

`src/cases.ts:82`: fallback đổi thành `independent-support-uncited:<id>` kèm hint 2 đường hợp lệ (claim peer có
`data.independentEvidenceRef`, hoặc validation task đã review mà case cite qua `taskRefs`). `src/cases.ts:139`: bound
danh sách reason (3 + "+N more") và kèm hint. Cập nhật test case review đang pin chuỗi cũ.

---

## 4. Ngoài phạm vi (không làm trong P5.1)

- Không nới gate case-acceptance, không hạ chuẩn independent support, không đổi role/authority.
- Không thêm budget/round cap mới; heartbeat vẫn là timer, không phải allowance.
- Không sửa `planning_update.md`, không đổi gate A3/A4.
- Không tự tăng cap tiền; mọi lần chạy live vẫn cần owner authorization.

---

## 5. Verify + chạy lại gate

**Hermetic (bắt buộc):** `npx tsc --noEmit`; `npx vitest run` (toàn bộ); guard `acceptance-matrix.test.ts`;
`git diff --check`. Trước khi sửa code: chạy `node .gitnexus/run.cjs analyze --force` (index hiện **9 commit sau HEAD**,
`stallRound`/`resume` chưa có trong graph nên `impact` trả UNKNOWN), rồi `impact` cho `AssessmentEngine.stallRound`,
`resume`, `armHeartbeat`, `TaskBoard` admission, `caseViews`; sau khi sửa: `detect_changes --scope all`.

**Gate rerun (sau khi owner duyệt):** dùng harness có sẵn cap thay vì monitor tay:

```
node scripts/benchmark-skills.mjs run --live --workers 3 --max-minutes 90 --max-cost-usd 1.50 --max-turns 60 \
  --start-flag "--loop" --start-flag "event-driven" --start-flag "--heartbeat-seconds" --start-flag "300" \
  --start-flag "--executors" --start-flag "isolated" --start-flag "--target-ops" --start-flag "2"
```

- Target: lab fixture `./target` của harness (không cần target thật) — hoặc `https://hcmussh.edu.vn/` nếu owner muốn
  so sánh trực tiếp (cần authorization lại).
- Heartbeat 300 s ở lần đo để chứng minh continuation trong 90 phút; mặc định production vẫn 600 s.
- Ước tính chi phí: đo được **$0,0095/phút** ⇒ 90 phút ≈ **$0,86**; cap $1,50 là biên an toàn.
- **Exit criteria:** report có ≥3 round, `wake reasons` có ≥1 heartbeat, `human resumes 0`, escalations 0–1, không
  refusal loop; nếu đạt ⇒ F-A6-23 chuyển PASS kèm số đo; nếu không ⇒ giữ FAIL và ghi số mới (không chỉnh ngưỡng).

---

## 6. Thứ tự và ước lượng

| Bước | Nội dung | Ước lượng |
| --- | --- | --- |
| 1 | P0 (+test hồi quy, chạy engine-campaign) | 2–3 h |
| 2 | P1 (record resume + counters + report/test bytes) | 1–2 h |
| 3 | P2 (schema/host auto-fill/message + test) | 2–3 h |
| 4 | P3 (message + test) | ≈1 h |
| 5 | full suite + tsc + detect_changes + docs | ≈1 h |
| 6 | rerun gate 90 phút + báo cáo | 90 phút + $≤1,50 |

Thứ tự bắt buộc: P0 → P1 → (P2, P3 có thể song song vì khác file) → verify → rerun.

---

## 7. Câu hỏi cần owner quyết

| # | Câu hỏi | Đề xuất |
| --- | --- | --- |
| Q1 | Escalation sau resume: chỉ reset streak (a), reset cả khi round có tiến bộ (b), hay đổi sang "3 quiet wake liên tiếp" (c) | (a) trước; đo lại rồi mới cân nhắc (c) |
| Q2 | Stall trước round đầu tiên: bỏ cả fact (a) hay chỉ bỏ escalation, vẫn ghi fact (b) | (a) — "stalled rounds" mới đúng ngữ nghĩa |
| Q3 | Cap cosmetic: truncate + warning (A) hay refusal + message tốt hơn (B) | (A) cho `risk`/`surface`, giữ (B) cho field ngữ nghĩa |
| Q4 | `validationOf` ⇒ host tự điền prerequisites/work | Có — theo F-A2-4 |
| Q5 | Rerun: lab fixture + heartbeat 300 s + cap $1,50 (a), hay target thật (b) | (a) |

---

## 8. Write scopes (dùng để chia task an toàn)

| Nhóm | File |
| --- | --- |
| P0 | `src/engine.ts`, `tests/minimal/engine-campaign.test.ts` |
| P1 | `extensions/p2o/index.ts`, `src/authority.ts`, `src/report-export.ts`, `tests/minimal/{finish-campaign,report-export,acceptance-matrix}.test.ts`, `docs/ACCEPTANCE_MATRIX.md` |
| P2 | `src/tasks.ts`, `src/work.ts`, `src/tool-schemas.ts`, `tests/minimal/{validation,intent,workflow-policy}.test.ts` |
| P3 | `src/cases.ts`, test case review tương ứng |
| Rerun | `scripts/benchmark-skills.mjs` (không sửa), `tmp/p2o-live/` (evidence) |

---

## 9. As-built (2026-10-26)

### 9.1 Thay đổi so với proposal

- **P0.** Field nội bộ `stalls` → `stallStreak`; snapshot vẫn expose `stalls` (giữ nguyên churn schema/test). `resume()`
  reset streak về 0. `stallRound` bỏ **cả fact** khi `mode === 'event-driven' && rounds === 0` (Q2a) — scope hẹp hơn
  "mọi mode" để không đổi hành vi A4 `manual` (test A4 giữ nguyên).
- **P0.4.** Không sửa timer heartbeat: chỉ thêm test hồi quy "một round stall rồi idle 600 s ⇒ heartbeat wake, không
  pause". R3 được xử lý gián tiếp bởi P0.2 (không còn pause trước round đầu) + P0.1 (một round stall không pause ngay nên
  timer 600 s có cửa sổ fire), đúng điều kiện "nếu vẫn thấy pause trước heartbeat trong harness run thì mở P0.3".
- **P1.** Ghi `campaign.resumed` cho **mọi** `/p2o resume` (kể cả run không có campaign frame), record được **await trước**
  `engine.resume()` — fail closed, không resume khi fact không ghi được. Authority thêm `campaignResumes`/`stallEscalations`;
  REPORT.md `## Campaign` in `Human resumes: N; stall escalations: M`, provenance in cùng cặp số.
- **P2.** Không có generic ACK warning channel, nên trace truncation nằm ở task field optional
  `admissionWarnings: string[]` (vd `truncated:risk (stored 200 of N characters)`), trả trong ACK và lưu trong ledger
  record. Schema `risk`/`surface` nới `maxLength` 200 → 2000 rồi host cắt về cap khi lưu (Q3-A); field ngữ nghĩa giữ
  refusal nhưng message nêu field/value hai bên (`VALIDATION_IDENTITY_MISMATCH: … assetRefs|questionKey|policyKey
  draft=<v> predecessor=<v>`). Host tự điền prerequisite từ `validationOf` và suy `work` từ predecessor (Q4/F-A2-4);
  `NEW_WORK_HAS_PRIOR_CLAIM` nêu field thừa + `legalNext`.
- **P3.** Fallback `independent-support-stale:<id>` → `independent-support-uncited:<id>` (chỉ khi **chưa claim peer nào
  trích** receipt; còn claim trích nhưng không current thì giữ `independent-receipt-*` cụ thể). Refusal acceptance bound 3
  reason + `(+N more)` + hint nêu đúng hai đường independence hợp lệ. Không nới gate.
- **P0.5 (phát hiện bởi rerun đầu, đã fix).** Lần rerun thứ nhất (`run-e16db138`) pause sau 9 phút vì host ghi 3 fact
  `planner.stalled` **trong cùng một round** đã admit (09:41:14, :18, :36 Z — cách 22 s) rồi escalate, trước khi round đó kịp
  tạo intent (round đó sau đó tạo 4 intent ở 09:44–09:46). Nguyên nhân: `stallRound` được gọi ở **mỗi** `message_end`, tức
  mỗi assistant message, nên một bước `toolUse` chưa tạo intent bị tính là "round stall". Fix: chỉ phán khi message kết thúc
  lượt (`stopReason === 'stop'`); mỗi round đã admit có tối đa một fact. Test mở rộng trong `prompt-roles.test.ts`; matrix
  thêm F-A6-27. Đây là bổ sung cho P0.2/P0.4, không đổi ngưỡng escalation.
- **Q5.** Rerun theo (b): target thật, cap **$2**, heartbeat **600 s** như production. Không dùng
  `scripts/benchmark-skills.mjs` (contract của harness cấm target ngoài và cần fixture `--start-flag`); chạy live bằng Pi
  interactive trong Herdr với `-ne -e dist/extensions/p2o/index.js` để chỉ load bản build đã patch (worker thừa hưởng
  đúng path này), cùng bộ flag như lần đo FAIL trước.

### 9.2 Hermetic verify (trước rerun)

- `npm run typecheck` · `npm run build` · `npm run check:build` → clean (`build import OK`).
- `vitest run`: **105 file pass / 6 skip, 904 test pass / 12 skip, 0 fail**. Guard `acceptance-matrix.test.ts` 3/3.
  `git diff --check` sạch.
- `detect_changes --scope all`: 18 file / 191 symbol / 78 flow, risk `critical` (hub engine, cases, authority,
  report-export, tasks — đúng phạm vi patch; không có thay đổi ngoài scope).
- Test mới/đổi: `engine-campaign.test.ts` (streak reset; không fact trước round đầu; heartbeat sau một stall),
  `finish-campaign.test.ts` (2 test P1), `authority.test.ts` (2 counter mới), `cases.test.ts` (2 test P3),
  `validation/intent/workflow-policy.test.ts` (P2), `prompt-roles.test.ts` (post-resume `stalls===1`).
- `docs/ACCEPTANCE_MATRIX.md`: F-A6-11 citation đổi theo test rename + wording streak; thêm **F-A6-24/F-A6-25** (P1),
  **F-A6-26** (P3), **F-A2-10/F-A2-11** (P2).

### 9.3 Rerun gate

**Lần 1 — `run-e16db138-432a-4994-9ce0-0b6ccff6512a` (dừng sau 13 phút, $0,124):** bắt đầu 2026-10-26T09:34:18Z trên
`https://hcmussh.edu.vn/`, event-driven/isolated, 3 worker, target-ops 2, heartbeat 600 s. Kết quả: 1 planner round
(`reason=event`), 0 debt/heartbeat wake, **3 stall fact trong cùng round 1** rồi 1 `planner.stall-escalation` ở 09:41:36Z
(không có human resume) ⇒ pause. Đây là **bug P0.5** (mục 9.1): host phán round stall ở mỗi assistant message thay vì ở
message kết thúc lượt. Bằng chứng: `tmp/p2o-live/final-metrics-run1-bug.txt`, `tmp/p2o-live/REPORT-run1-bug-final.md`,
`tmp/p2o-live/monitor2.jsonl`. Run đã stop sạch (`sandbox removal verified`) và report final được lưu.

**Lần 2 — `run-934e2a2a-89ee-40a4-9fe5-0d3d6aff3c8c` (rerun chính thức, sau fix P0.5 + build lại):** cùng flag cấu hình,
bắt đầu 2026-10-26T09:52Z. Bằng chứng: `tmp/p2o-live/monitor3.jsonl`. Kết quả đo + verdict: xem §9.4 và
`docs/ACCEPTANCE_MATRIX.md` hàng F-A6-23/F-A2-9.

### 9.4 Kết quả đo + verdict (2026-10-26)

| Tiêu chí P5 (§461) | Đo được ở `run-934e2a2a` | Verdict |
| --- | --- | --- |
| Campaign 60–90 phút không người trực | 38,7 phút, 0 human turn / 0 resume / 0 escalation, nhưng lead tự `p2o_finish {partial}` sớm | **FAIL (thời lượng)** |
| ≥3 planner round không human turn | 5 round (`planner.admitted` 5) | PASS |
| ≥1 debt/heartbeat continuation | heartbeat 1 + event 4 wake; debt 0 | PASS |
| ≥1 hướng mới sau roadmap cạn | round 3–5 dispatch hostname in-zone, owner_id/jobs, cms-test, cookie origin, `/view-all` escaping | PASS |
| Không refusal loop ở case đầu | 0 refusal acceptance; 2 case_create bị từ chối rồi partial (không lặp) | PASS |
| Report trung thực goal/partial | `Human resumes: 0; stall escalations: 0`; rounds 5; lý do partial được trích; completion `incomplete` | PASS |

- **F-A2-9:** 15/25 call `p2o_task_create` lỗi = **60,0%** (trước patch 68,8%) → vẫn **FAIL** ngưỡng <5%. Các nhóm P2
  nhắm đã hết; nhóm trội mới là "Invalid task method" 7/15 do draft thiếu `methodReason` cho `role=discovery`, message
  cũ không nêu field. Chính vì vậy lead ghi *"Discovery role is currently unusable"*, block Phase 3 và partial ở phút
  38,7 — ma sát admission là nguyên nhân trực tiếp của tiêu chí thời lượng fail. Message đã được làm actionable **sau**
  lần đo (commit-less working tree, hermetic test `validation.test.ts :: names draft.methodReason …`) nhưng **chưa đo
  lại**.
- **Chi phí:** run 1 $0,1241 + run 2 $0,7895 = **$0,9136 / cap $2**. Burn $0,0204/phút ⇒ một campaign ≥60 phút cần
  ≥$1,22, vượt phần ngân sách còn lại ($1,086) ⇒ không có thêm lần đo nào trong cap.
- Chi tiết bằng chứng + bảng per-criterion: `tmp/p2o-live/gate-verdict2.md`; chấm trên
  `docs/ACCEPTANCE_MATRIX.md` F-A6-23 + F-A2-9.
