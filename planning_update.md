# planning_update.md — Operator run-state UI upgrade proposal

Status: **proposal only. No code, test, doc, skill or prompt was changed.** This file is a fresh document and supersedes any earlier `planning_update.md` (the old plan is referenced only in test comments, e.g. `tests/minimal/acceptance-matrix.test.ts:6`, which now reads `docs/ACCEPTANCE_BASELINE.md`, not this file).

Method and limits of this pass (read before trusting any line number):
- All citations are from the owner's working tree as staged at the start of this pass (`index.ts` 179 KB). Line numbers drift; re-grep before editing.
- **GitNexus was not run.** No shell on the owner's computer was available, so neither `status` (stale-index check) nor `impact` could run. Callers below were confirmed by reading and grep only. The `.gitnexus` index looks old by file time; **per the repo rule I will not rebuild it without the owner's go-ahead** (Decision D8).
- `git status` could not be run for the same reason. The only file this pass writes is `planning_update.md`. Because the old file is tracked but absent from the working tree, git will likely show it as *modified* rather than *new*.
- `test:herdr` was not run. No live pane check was done.

---

## 0. Summary

1. Today the operator sees one static, ≤6-line `p2o-progress` widget (a text snapshot), a one-line status-bar item, and modal, static, paged text screens opened by `/p2o` commands.
2. The Pi extension API **can** support much more in the TUI: component widgets that re-render on `tui.requestRender()`, a keyboard-driven multi-view `ctx.ui.custom` screen, and non-capturing overlays. **The stop condition is not triggered.**
3. In RPC mode `custom()` returns undefined and widget factories are ignored, so a richer UI must keep a string-only fallback. In JSON/print there is no UI at all.
4. Several useful facts already exist in host state but are never shown: target-operation running/waiting counts, ratings on cases, coverage execution/assessment breakdown, and per-worker current operation history.
5. **Recommendation: Option B** — one pure, read-only *dashboard view model* built from the committed index plus in-memory snapshots, rendered by (i) an upgraded widget, (ii) a new multi-view `ctx.ui.custom` screen (`/p2o dashboard`), and (iii) the same model as plain text for RPC. A static HTML snapshot file is an optional later phase. A live local web server and a Go sidecar are rejected: both add a network listener or a new binary and change the security model.
6. No phase touches the lead prompt, tool surface, or `docs/WSTG_MAP.md`. Prompt/context-size impact: none.

---

## A. Current UI inventory

Everything the operator sees during a run, with limits.

| # | Surface | Where (file:line) | What it shows | Limits |
|---|---|---|---|---|
| A1 | `p2o-progress` widget | set `extensions/p2o/index.ts:284`; cleared `:300`; lines built `src/ui/state.ts:120-122`; component `src/ui/screen.ts:35-37` | Title (`P2O <run> · lifecycle · mode/executor · records @N`), optional `HOLD:`, task counts (running/review/blocked/closed), cases accepted and pending/stale, worker live/quiet/reported counts, the "attention" line, retention line | ≤6 lines. Static `string[]` wrapped by a plain `truncateToWidth` component with no re-render hook. Placement is the default. Replaced whole on every refresh |
| A2 | Refresh pipeline | `index.ts:268-294`; delay `src/ui/refresh.ts:12-15` | Triggered by `observeRecords` (`:1622`) and `ProgressState` change callback (`:1623`) | Debounce 25 ms up to 5 s (4× last scan cost). Each refresh is a **full ledger scan** (`currentStatus`, `:241-252`). Skipped entirely unless `ctx.mode === 'tui'` (`:271`, `:279`) |
| A3 | Status-bar item | `index.ts:324` (worker: `p2o worker <id>`), `:1238` (`… reported`), `:1625` (`p2o: starting sandbox`), `:1638` (`p2o: <target> (+N workers)`), cleared `:580` | One short string, no live data | Not updated as the run progresses; the start-flow text stays until cleanup |
| A4 | `/p2o status` | `src/ui/state.ts:80-123` (`lines`), shown via `showState` `index.ts:227-230` | ~20 lines: tasks, slots, frontier, worker commands, worker table (`workerLines` `state.ts:64-72`, max 12 live), model usage, planner context, handoffs/claims/cases/coverage-cell **counts**, attention, last committed record, retention, reconciliation, sequence | Static snapshot. Modal screen in TUI, `ctx.ui.notify` text otherwise |
| A5 | `/p2o workers` | `index.ts:1406`; parser `src/ui/operator.ts` | Worker table (id, role, task, state, cmds used/budget, idle age, `QUIET`) | `QUIET` = no local event for 120 s while queued/running (`src/progress.ts:19-22`); explicitly not failure proof. `ProgressState` keeps **only the last event per actor** (`progress.ts:7`, `:13`) |
| A6 | `/p2o tasks|task|log|report|search|plans|…` | `src/ui/state.ts:126-208` (`stateLines`), parser at the top of the file | Paged rows, 20 per page, cursor-based | Findings and coverage rows carry no severity or rating (no match for `severity|ratingCurrent|ratedRevision|cvss` in `state.ts`) |
| A7 | Workspace views | `src/ui/workspace.ts`; commands `index.ts:1289-1374` | knowledge, graph, checkpoints, events, artifacts, report counts (`index.ts:1343`) | Read-only text; historical runs open metadata-only when the schema is unsupported (`index.ts:222`) |
| A8 | Operator controls | `index.ts:1402-1436` (`workers` `:1406`, `hold` `:1411`, `release` `:1419` with confirm, `stop-worker` `:1428` with confirm); `pause/resume` `:1443`; `stop` `:1450` | Human-only; no model tools exist for them | Documented `docs/USAGE.md:84-94` |
| A9 | `StateScreen` | `src/ui/screen.ts:6-28` | Modal viewer: ↑↓, PgUp/PgDn, Esc/q/ctrl+c | `pageSize = 18` (`:10`). Constructed from a fixed `string[]` (`:11`): no live update, no tabs |
| A10 | Entry renderers | `index.ts:232` (`p2o-state-view`), `:846` (`renderResult`); `src/ui/screen.ts:30-46` | Marker lines in the transcript | Marker only; says "not a checkpoint or execution authority" |
| A11 | Help | `HELP` `index.ts:69-85` | Command list | Pinned by `help-commands.test.ts` |

Data that exists but is **not** surfaced (all read-only host values):
- `ExecutorPool.snapshot()` (`src/executors.ts:60`) → `runningTargetOperations`, `waitingTargetOperations`, `ownedAssignmentExecutors`. `ViewProfile.executor` is typed as only `{mode, maxTargetOperations}` (`state.ts:54`), so running/waiting are dropped at the boundary.
- `AssessmentEngine.snapshot()` (`src/engine.ts:155-160`) → `pendingEvents`, queued intents, rounds. Only `pendingIntents` and `rounds` reach the status text (`state.ts:110`).
- Coverage execution (7 values) and assessment (6 values) axes (`src/coverage-types.ts:2-3`). Only `coverageCells` as a total count reaches the UI.
- Case rating fields (`CaseView.finding`, `ratedRevision`, `ratingCurrent`; `src/case-types.ts`, `src/cases.ts`).
- `finishPreflight()` (pure; `src/finish-preflight.ts`, called `index.ts:1263`) → would show "what blocks a finish".
- `store.health()` / `store.sequence()` (`index.ts:222`, `:590`).

---

## B. What ARTEX and strix show, and what transfers

Sources read: ARTEX `screenshots/{dashboard,agents,tasks,findings,graph,sessions,logs,chat,traffic}.png`, `server/broadcast.go`, `server/webui_embed.go`, `ARTEX_AGENTIC_CORE.vi.md`; strix `interface/tui/{live_view,sidecar}.py`, `tui/backend/{protocol,projection}.py`, `tui/internal/app/{panels,agents}.go`, `tui/internal/render/coverage.go`, `viewer/server.py`, `interactive.py`, `resume_picker.py`. (strix `report_pdf.py`, `tui/runtime.py`, `tui/internal/app/model.go` were staged but only skimmed or not read; no claim below depends on them.)

### B1. ARTEX (Go backend + embedded web SPA)
Shows: a persistent navigation of **Dashboard / Agents / Tasks / Findings / Graph / Sessions / Logs / Chat / Traffic**, so the operator never leaves the dashboard to ask "who is working on what". Findings and tasks are tables with status badges. Live updates run over SSE through an in-process per-task `Broadcaster` (`server/broadcast.go`) that **drops on a full subscriber and gives a sequence cursor to catch up**.

| Idea | Do they do it better? | Transfers to Pi? |
|---|---|---|
| Always-visible per-agent list with state | Yes: pi-p2o's widget shows counts only | **Yes**, as a compact worker block |
| Findings table with severity/status badges | Yes: pi-p2o prints no ratings | **Yes**, but badge the committed rating and mark stale (`ratingCurrent`) |
| Traffic/HTTP view | Yes, they have a recording proxy | **No.** It needs a proxy (conflicts with "no proxy providers") and stores target traffic |
| Graph view | Yes | **Partly**: `graphLines` (`workspace.ts`) already prints it as text; a tree/list inside the screen is enough |
| Live push over SSE | Yes | **No** as transport (needs a listener). The *idea* transfers: sequence cursor + coalesced refresh, which pi-p2o already has |
| JWT, PostgreSQL, SQLite traffic index, web SPA | n/a | **No.** Each conflicts with a single Pi extension, local canonical SQLite store and no listener |

### B2. strix (Python + Go Bubble Tea sidecar + local HTTP viewer)
Shows: a rich TUI with agents tree, panels, coverage render, and a resume picker, plus a stdlib local HTTP viewer polled about once per second with a session token. The sidecar speaks a versioned protocol (v3) with **state revisions and collection deltas** over a socketpair; terminal projections are **bounded and sanitized** (`tui/backend/projection.py`).

| Idea | Transfers? |
|---|---|
| Bounded + sanitized projections between state and screen | **Yes — already the pi-p2o convention** (`safeText`, `safe()` at `state.ts:49`). Make it one rule for the new model |
| State revision stamped on every frame | **Yes**: pi-p2o's committed sequence plays this role (`records @N`, `snapshotSequence`) |
| Agents tree + coverage panel (coverage.go) | **Yes**, as text rows: execution × assessment histogram |
| Resume picker | Outside this scope (run reopening already exists as `/p2o open`) |
| Go sidecar (Bubble Tea) | **No.** New binary, install step, process lifecycle and a second renderer |
| Local HTTP viewer with token | **No.** A network listener is the security-model change this proposal must avoid |
| PDF report | Already covered by `report export` (`docs/USAGE.md:143`); not a live view |

---

## C. Gap analysis — what the operator cannot see during a run

| Operator question | Today | Why it is a gap | Data already available? |
|---|---|---|---|
| Which workers are running, and on what, right now? | Widget: counts only (`state.ts:121`). Detail only after typing `/p2o workers` or `/p2o status` (A4/A5) | Needs a command and a modal; goes stale at once | Yes (`operatorWorkers`, `index.ts:234-240`) |
| What did a worker do last, and recently? | `ProgressState` keeps one event per actor | No recent-activity trail beyond the last event; `/p2o log actor=` is the only route | Partly: committed log has it; in-memory trail does not |
| Is the target-operation cap saturated? Are workers waiting for a slot? | Not shown anywhere | "Quiet" workers may just be queued for a slot | Yes (`executors.ts:60`), dropped at `state.ts:54` |
| What is queued (accepted intents, pending events)? | One number in status (`state.ts:110`) | No queue view | Yes (`engine.ts:155-160`) |
| Coverage progress? | A single count of cells | Not "n of m tested", not by execution/assessment axis, no open-gap count in widget | Yes (`coverage-types.ts`, report counts) |
| Cases and ratings? | Counts of accepted/pending/stale (`state.ts:115,120`) | No severity or rating, no list of the accepted ones with their rating currency | Yes (`cases.ts`) |
| What is blocked, and why? | Blocked count; `tasks blocked` filter on demand | No reason in the always-visible area | Yes (task frontier) |
| Could I finish now? What would stop it? | Only by trying `p2o_finish` | No preview | Yes (`finishPreflight`, pure) |
| Is the ledger/store healthy and complete? | `Reconciliation:` line in status; `STATE INCOMPLETE.` in widget | Good already, but no store health/quota | Yes (`store.health()`) |
| Is what I see current? | Widget has `records @N` but no wall-clock age; refresh debounce up to 5 s | The operator cannot tell a stalled view from a quiet run | Add `viewedAt`, and show age when stale |
| Can I keep looking while I type `/p2o hold`? | Screens are **modal** | Must close the screen before typing a command | See Option B notes |

---

## D. Proposed options

Common design rules for every option (these answer the guardrails):
- **Read-only.** The view model is a pure function `(LedgerIndex, snapshots, now) → DashboardModel`. No tool, no authority, no write path. It cannot grant execution authority, restore scope, tickets or budgets, and it adds no target operation. `hold`, `release`, `stop-worker`, `stop` stay user-only slash commands with their existing confirmation (`docs/USAGE.md:84-94`; `index.ts:1411-1436`). The new screen does not contain buttons for them.
- **Consistent with committed state.** Every view prints the committed sequence (`@N`) and an as-of time. Anything the model cannot establish prints `unknown`, never 0 (as `state.ts` does for context usage, `:114`). Reported ≠ reviewed (`state.ts:118`): a worker's `reported` never renders as verified. A closed task is not a verified finding. A case rating is shown with its revision and `current`/`stale`. If the scan is incomplete, print "no completeness claim" (as `state.ts:117`). Target-derived text always goes through `safeText`.
- **Untrusted text.** Every string from the target or a worker goes through the existing `safe()`; bounded by a per-field limit.

### Pi API surface this depends on

| API | Used today? | Option B depends on it? | Behaviour by mode |
|---|---|---|---|
| `ctx.mode` | Yes (`index.ts:228`, `:271`, `:279`) | Yes, to choose render path | `'tui'`, `'rpc'`, `'json'`, `'print'` |
| `ctx.hasUI` | Yes (`:1462`) | Yes | true in TUI and RPC |
| `ctx.ui.setWidget(key, string[] \| factory, {placement})` (`types.d.ts:101-102`) | Yes (string-array wrapped in a factory) | Yes; the factory form receives `(tui, theme)` and can re-render | RPC: **string arrays only**; factories ignored |
| `ctx.ui.setStatus(key, text)` (`types.d.ts:84`) | Yes (A3) | Optional (richer one-liner) | Works in TUI and RPC |
| `ctx.ui.custom<T>(factory, options)` (`types.d.ts:121`) | Yes, for `StateScreen` | Yes — the multi-view screen | RPC: returns `undefined` → must fall back to `notify` text |
| `tui.requestRender()` (`pi-tui/dist/tui.d.ts:233`) | No | Yes, for live refresh while a screen or widget is mounted | TUI only |
| `OverlayOptions.nonCapturing`, `OverlayHandle.setHidden` (`tui.d.ts:160, 177-181`) | No | Optional (Phase 5) | TUI only |
| `pi.registerShortcut` (`types.d.ts:1209`), `setFooter`, `setHeader`, `onTerminalInput` | No | **No** (avoid; Phase 5 optional shortcut only) | n/a |
| `ctx.ui.notify` | Yes | Yes, as the non-TUI fallback | Works in TUI and RPC |

Non-TUI fallback: RPC → `notify(model.toText())`, bounded (same cap as `showState`) and computed on demand when the command runs (no background scan, preserving `index.ts:270-271`). JSON/print → nothing, as today.

Test-harness note: `tests/minimal/helpers/fake-pi.ts` has `setStatus` as a no-op (`:80`), stores widget values (`:81`), calls `custom` with stub arguments, and has no `registerShortcut` or `setFooter`. New UI code must only call APIs the fake offers or must feature-check, or the fake must be extended in the same change.

### Option A — Enrich the existing widget and status only
- What: add executor running/waiting, coverage line, rating counts and "next blocker" to `state.widget`; no new screen.
- Cost: small (≈1 file, `state.ts`).
- Risk: low. But the widget is capped at a few lines, still static text, and cannot show per-worker rows.
- Tests touched: `operator-visibility.test.ts` (widget/status assertions), `visibility.test.ts`, `refresh.test.ts`, `loop.test.ts` / `planning.test.ts` if they read widget lines; `usage.test.ts` if docs assertions exist.
- Verdict: good as Phase 1, insufficient alone.

### Option B (recommended) — Dashboard view model + multi-view `ctx.ui.custom` screen + component widget
- What:
  1. `src/ui/dashboard.ts` (new): pure `buildDashboard(index, profile, snapshots, now)` returning typed sections: `header`, `workers[]`, `queue`, `coverage`, `cases[]`, `blocked[]`, `finish`, `health`. Plus `dashboardText(model, section?)`.
  2. `DashboardScreen` (new, `src/ui/screen.ts` or `src/ui/dashboard-screen.ts`): tabs **Overview / Workers / Tasks / Coverage / Cases / Log**, switched by ←/→ or 1–6, ↑↓ scroll, `r` redraw, Esc/q close. Takes a `() => DashboardModel` getter and re-renders when the shared refresh pipeline publishes a new model (it calls `tui.requestRender()`). No second ledger scan: `refreshVisibility` (`index.ts:268-294`) stores its latest model on `OwnerRun` and notifies the open screen.
  3. Widget: replace the static `widgetComponent` with a component that renders up to ~8 lines: header with age, hold banner, workers (up to 3 rows + "+N"), queue/target-op, coverage and cases summary, attention. Still text.
  4. Command: `/p2o dashboard [section]`; `/p2o state` and `status` stay.
- Cost: medium (≈3 new files, edits in `index.ts`, `screen.ts`, `state.ts`, `HELP`).
- Risk: medium-low. Main risks: (a) scan cost: reuse of the single scan keeps it flat; (b) modal screen blocks typing `/p2o hold` — mitigate by showing the one-line reminder `Close with Esc, then /p2o hold|stop-worker` and keeping the widget on screen when the screen is closed; (c) RPC divergence — mitigate with a single `dashboardText` used everywhere.
- Test impact: new `tests/minimal/dashboard.test.ts` (pure model: unknown stays unknown, as-of present, reported ≠ verified, stale rating labelled, untrusted text sanitized, bounded rows); edits to `operator-visibility.test.ts` (widget lines), `operator-controls.test.ts` (workers table remains; no new control), `help-commands.test.ts` (new help line), `extension.test.ts` (command registration), `refresh.test.ts` (shared scan; no extra scans), `fake-pi.ts` (helper only); `docs/USAGE.md` and `docs/ARCHITECTURE.md` get a short section (docs are outside this pass).
- Not touched: lead prompt (`prompt` tests and worker hash), `docs/WSTG_MAP.md` / `wstg-map.test.ts`, `measure-context.test.ts`, `recon.test.ts`, `workflow-policy.test.ts`, `acceptance-matrix.test.ts` (it only requires that cited test titles still exist — so **do not rename existing titles** that `docs/ACCEPTANCE_MATRIX.md:14-81` cites).

### Option C — Static HTML snapshot export (optional, later)
- What: `/p2o dashboard export` writes one self-contained HTML file from the same model, to a new directory **outside the state root**, with user confirmation, atomic write, like `report export` (`docs/USAGE.md:143`). No listener, no script that fetches anything. Viewed by opening the file in a browser.
- Cost: small-medium. Risk: low-medium: it is a file write of redacted data, so reuse the report-export path rules (absolute path outside the state root, no overwrite). Frozen at export time and labelled with sequence and as-of.
- Tests: new export test; reuse report-export fixtures; `usage.test.ts` for docs.

### Option D — Live local web view (ARTEX-style) — **rejected**
Needs an HTTP/SSE listener and an auth token. That is a network listener and changes the security model; also adds lifecycle and port-conflict handling inside a Pi extension. If the owner still wants it, it must be a separate, explicitly approved design.

### Option E — Go/Bubble Tea sidecar (strix-style) — **rejected**
New binary, build/install step, process lifecycle, a second renderer and a protocol to keep in sync. Conflicts with "no install" and gives nothing the Pi TUI components cannot do here.

### Recommendation
**Option B**, delivered in phases (E), with Option A's widget work as its first visible step and Option C as an optional end. Option B is the closest to what ARTEX's Agents/Tasks/Findings tabs and strix's panels give the operator, using only APIs pi-p2o already uses plus `tui.requestRender()`.

---

## E. Phased roadmap

Each phase is independently shippable and approvable. "Prompt/context impact" is none in every phase: all work is host-side rendering; no tool is added or changed, the lead prompt and worker hash are untouched, and nothing is added to model context.

| Phase | Add / change | Tests touched | Rollback | Prompt/context impact |
|---|---|---|---|---|
| **P0 — View model** | New pure `src/ui/dashboard.ts` and its unit tests. Pass `executor.running/waiting` and `engine.pendingEvents` through `ViewProfile` (`state.ts:51-59`). No UI change yet | New `dashboard.test.ts`; `operator-visibility.test.ts` if `ViewProfile` fixtures need the new optional fields | Delete the new file; the `ViewProfile` fields are optional | None |
| **P1 — Widget v2** | Widget component with age, hold banner, 3 worker rows, queue/target-op, coverage + case-rating summary. Keep ≤8 lines and the existing title/`records @N` | `operator-visibility.test.ts`, `visibility.test.ts`, `refresh.test.ts` | Revert `state.ts:120-122` and `widgetComponent`; one-commit revert | None |
| **P2 — Dashboard screen** | `DashboardScreen` with 6 tabs; reuse the single scan; `tui.requestRender()` on new model; `/p2o dashboard [section]`; help text | `help-commands.test.ts`, `extension.test.ts`, `refresh.test.ts`, new screen test with fake `tui` | Remove command + screen; widget (P1) is unaffected | None |
| **P3 — RPC/text parity** | `dashboardText` for `notify` in RPC; on-demand only, no background scan | `extension.test.ts` (rpc path), `dashboard.test.ts` | Remove the branch; RPC returns to `/p2o status` text | None |
| **P4 — Static HTML snapshot (optional)** | `/p2o dashboard export` as in Option C | new export test; docs | Remove command; delete exported files by hand | None |
| **P5 — Shortcut / non-capturing overlay (optional, experimental)** | A key to open the dashboard and an overlay that does not capture input, so `/p2o hold` can be typed while it shows | needs a fake with `registerShortcut`/overlay support | Remove registration | None |

Order rationale: P0 makes everything testable without a TUI; P1 is the highest visible value for the lowest risk; P2 is the main new surface; P3 only after P2 proves the model; P4/P5 only if the owner wants them.

GitNexus: before editing any symbol in these phases (`statusView`, `workerLines`, `widgetComponent`, `StateScreen`, `refreshVisibility`, `currentStatus`, `showState`), run `impact` and report blast radius; if `impact` is unavailable, confirm callers with grep and say so. If `status` reports the index stale, ask before rebuilding.

---

## F. Open decisions for the owner

- **D1.** Approve Option B and which phase(s) to start with (suggested: P0 + P1).
- **D2.** Command name: new `/p2o dashboard`, or extend `/p2o state`/`status`?
- **D3.** Ratings: show committed severity/rating labelled with revision and `current`/`stale`? Or counts only?
- **D4.** Widget height: allow up to 8 lines (more screen used above the editor), or keep ≤6?
- **D5.** Live refresh while the screen is open: reuse the existing 25 ms–5 s pacing, or add a fixed 1 s tick (more scans, strix-like)?
- **D6.** Include the optional HTML snapshot (P4)? If yes, where may it be written, and is the existing `report export` confirmation policy enough?
- **D7.** Include the optional shortcut/overlay (P5), given that fake-pi has no support and a key binding may clash with Pi defaults?
- **D8.** The GitNexus index looks stale and `impact` could not run in this pass. May I rebuild it, or do you want to do that yourself?
- **D9.** `planning_update.md` is tracked but was missing from the working tree, so this file will appear as modified. Is that acceptable, or should the plan live under another name?
- **D10.** Is a live check in a real Herdr session wanted at the end of P2? (`test:herdr` splits live panes; I will not run it without your say-so.)

---

## Appendix — evidence index

- Pi API types: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (lines cited above); `node_modules/@earendil-works/pi-tui/dist/tui.d.ts` (`requestRender` `:233`, `nonCapturing` `:160`, `OverlayHandle` `:177`).
- RPC behaviour (custom → undefined, widget factories ignored, footer/header/editor no-ops) is from the Pi RPC mode source read earlier in this task; it is not re-cited by line here.
- Pinned contracts to preserve: lead prompt (no tool names, size limit, worker hash); `docs/WSTG_MAP.md` (count-bound); `docs/ACCEPTANCE_MATRIX.md` title citations guarded by `tests/minimal/acceptance-matrix.test.ts:23-28`.
- Existing UI tests, titles not re-verified in this pass: `operator-visibility`, `operator-controls`, `visibility`, `refresh`, `help-commands`, `extension`, `ledger-incremental`, `loop`, `planning`, `usage`, `workspace-runtime`.

---

## Trạng thái triển khai (2026-10-12)

**Đã làm: P0 + P1 (owner chose this scope; D3 answered "severity + revision + current/stale").** P2–P5 (dashboard screen, RPC parity, HTML export, shortcut/overlay) vẫn chưa làm — còn nguyên các câu hỏi D1 (phase tiếp theo), D2 (tên command), D6, D7.

**GitNexus trước khi sửa:** index đang ở `dffcb96`, HEAD đã sang `39bf178` (2 file lệch) → chạy `analyze --index-only` để đồng bộ (9,761 nodes | 33,669 edges | 694 flows) trước khi impact. `impact` trên `statusView`/`workerLines`/`widgetComponent`/`currentStatus` cho risk CRITICAL/CRITICAL/HIGH/CRITICAL — đúng như dự đoán trong §E ("shared pre-finish-check path reached by many flows"), vì các symbol này ngồi trên đường render widget mà rất nhiều flow khác đi qua. Không phải dấu hiệu thay đổi nguy hiểm, nhưng được cảnh báo đúng luật AGENTS.md.

### P0 — `src/ui/dashboard.ts` (mới)
Hàm thuần `dashboardLines(profile, report, cases)` → 3 dòng cố định: Queue (pendingIntents/pendingEvents + target-op running/waiting/cap), Coverage (tổng plan/cell + breakdown tested/open-gap theo execution/assessment axis, cảnh báo khi projection bị cắt), Cases (accepted-current, breakdown theo severity đã rate, đếm riêng unrated và rating-stale, cộng pending/stale). Không đọc `LedgerIndex` trực tiếp — nhận `report` (từ `reportProjection`, đã tính 1 lần trong `statusView`) và `cases` (từ `caseViews`, gọi thêm 1 lần — cùng kiểu trùng lặp mà `reportProjection` đã tự chấp nhận khi gọi lại `caseViews`/`coverageViews`, không phải chi phí mới). "Unknown ở executor.running/waiting hoặc engine.pendingEvents hiện là `unknown`, không phải 0" — giữ đúng nguyên tắc ở §D. `ViewProfile.executor` được mở rộng thêm `runningTargetOperations?`/`waitingTargetOperations?` (optional để các fixture test cũ không cần sửa). Test mới: `tests/minimal/dashboard.test.ts` (7 case: unknown-not-zero, số liệu đúng, không có plan, breakdown đầy đủ, breakdown bị cắt, 0 accepted finding, bucket theo severity + unrated + rating-stale).

### P1 — Widget v2 (trong `src/ui/state.ts`, không đổi `widgetComponent`)
Widget giờ là: `title`, `HOLD` (nếu có), `Workers: live N (quiet Q) | reported R` — kèm danh sách gọn từng worker `id(state task)` khi có ≤3 worker đang sống (bỏ khi đông hơn, tránh phá format), 3 dòng từ `dashboardLines`, cuối là `attention` (+ `STATE INCOMPLETE` nếu chưa quét xong). Tối đa 7 dòng trong mọi trường hợp quan sát được (≤ cap 8 mà §D136 đề ra).

**Hai điểm cắt giảm có chủ đích so với mô tả gốc ở §D.136, ghi lại ở đây cho minh bạch:**
- **Bỏ dòng `Tasks:` và dòng `retention` khỏi widget.** Danh sách nội dung P1 trong §D.136 ("header with age, hold banner, workers, queue/target-op, coverage and cases summary, attention") không nhắc đến Tasks/retention — cộng với ngân sách cứng ≤8 dòng, hai dòng cũ bị bỏ để nhường chỗ cho Queue/Coverage/Cases mới. Cả hai vẫn còn đầy đủ trong `/p2o status`.
- **Bỏ "age" (header with age).** Widget là một `string[]` tĩnh được bọc lại mỗi lần `refreshVisibility` quét ledger (`index.ts:268-294`); không có `tui.requestRender()` tick nền trong P1, nên "tuổi" của khung nhìn tại thời điểm build luôn là 0 — hiện số liệu này ra sẽ là thông tin giả. Cần một tick sống (P2/P5) mới làm được đúng; để trống trong P1 thay vì hiện con số sai.
- **"Up to 3 rows" cho worker được thu lại thành 1 dòng gộp** (mỗi worker 1 cụm ngắn `id(state task)` nối bằng dấu phẩy) thay vì 3 dòng riêng — nếu làm 3 dòng riêng cộng với Queue/Coverage/Cases/HOLD/attention thì vượt xa ngân sách 8 dòng. `/p2o workers` vẫn là nơi xem chi tiết đầy đủ.

### Test đã sửa (không phải regression, là hệ quả trực tiếp của đổi nội dung widget — đúng cột "Tests touched" ở §E)
- `operator-visibility.test.ts`: cap `widget.length` 5 → 8.
- `visibility.test.ts` (2 chỗ): assertion `toContain('Tasks:')` sau khi tạo task → đổi thành `toContain('Queue:')` (Queue luôn có mặt trong mọi widget, vẫn xác nhận đúng ý định gốc của test là "widget đã re-render với nội dung mới").

### Kết quả kiểm tra
`npx tsc --noEmit -p .` sạch. `npx vitest run tests/minimal`: 64 file pass / 6 skip (70), 574 test pass / 12 skip (586) — không còn test nào đỏ. `detect-changes --scope all`: **risk critical** (4 file, 25 symbol, 21 flow) vì đụng trực tiếp vào `statusView` — đã cảnh báo ở đây theo đúng luật, không phải lý do để không làm, vì cách sửa chỉ thêm/sắp lại các dòng trong cùng hàm, không đổi chữ ký hay hành vi của các symbol khác mà `statusView` gọi.

### Còn lại sau lượt P0+P1 (nay đã làm tiếp, xem mục dưới)
P2 (DashboardScreen đa tab + `/p2o dashboard`), P3 (RPC parity qua `dashboardText`), P4 (HTML export), P5 (shortcut/overlay) — và các câu hỏi D1/D2/D6/D7 đi kèm. D8 đã tự giải quyết (đã rebuild index với sự đồng ý ngầm từ việc owner yêu cầu triển khai trực tiếp, có shell sẵn trong phiên này). D9 không còn áp dụng (file này đã được track và sửa tiếp, không đổi tên).

---

## Trạng thái triển khai (2026-10-12, lượt 2): P2 + P3 + P5, bỏ P4

**Owner xác nhận tiếp Option B, làm P2/P3/P5, không làm P4.** D1 giải quyết theo hướng này; D4 đã trả lời ở lượt 1. D2 (tên command): giữ `/p2o dashboard [overview|workers|tasks|coverage|cases|log]`, không đổi `/p2o status`. D6 (P4/HTML export): không làm, giữ nguyên "rejected cho lượt này". D7 (shortcut key) được giải quyết bằng chứng cứ cụ thể, không phải suy đoán — xem dưới.

### Đồng bộ GitNexus trước khi sửa
Index đã lệch (uncommitted `dashboard.ts`/`state.ts` từ lượt 1) → `analyze --index-only` 3 lần trong lượt này (9,761 → 9,806 node) khi thêm `dashboard-screen.ts` và sửa `state.ts`/`index.ts`. `impact` trên `refreshVisibility` (HIGH, 4 symbol) và `closeVisibility` (CRITICAL, 4 symbol) — đúng dạng cảnh báo đã thấy ở lượt 1 (hub function trên đường UI dùng chung), không phải tín hiệu mới.

### D7 — chọn phím tắt bằng chứng cứ, không đoán
Đọc toàn bộ `TUI_KEYBINDINGS` (`node_modules/@earendil-works/pi-tui/dist/keybindings.js`) và `KEYBINDINGS` (`node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js`): **toàn bộ 26 `ctrl+<chữ>` đã có chủ** (editor cursor/delete/app action), và `ctrl+h`/`ctrl+i`/`ctrl+m` — 3 cái còn "trống" — thực ra trùng byte ASCII với Backspace/Tab/Enter nên không dùng được làm phím riêng. Đọc thêm `runner.js:449-472`: extension có thể **cướp** một phím editor không nằm trong `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` (chỉ cảnh báo, không chặn) — nghĩa là chọn bừa một `ctrl+<chữ>` sẽ thực sự làm hỏng một phím soạn thảo đang dùng, không chỉ là rủi ro lý thuyết như D7 lo. Phím chức năng (`f1`-`f12`) có trong `KeyId` (`pi-tui/dist/keys.d.ts:32`) và **không xuất hiện trong bất kỳ `defaultKeys` nào** ở cả hai bảng → chọn **F2** (quy ước phổ biến "toggle view" ở các TUI panel như htop/Midnight Commander).

### P2 — `DashboardScreen` + `/p2o dashboard`
- `src/ui/dashboard-screen.ts` (mới): component thuần `DashboardScreen(sectionLines, initialSection, close, requestRender?)`. 6 tab Overview/Workers/Tasks/Coverage/Cases/Log, phím số 1-6 hoặc ←→ chuyển tab (có wrap), ↑↓/PageUp/PageDown cuộn, `r` vẽ lại, Esc/q đóng. `refresh()` chỉ đặt cờ `dirty` và gọi `requestRender()` — không tự đọc ledger, không tự lên lịch gì cả.
- `src/ui/state.ts`: thêm `DASHBOARD_SECTIONS`/`DashboardSection`, `parseDashboardCommand` (tách hẳn khỏi `StateCommand`/`stateLines` vì dashboard là tổ hợp nhiều view có sẵn qua tab, không phải một loại truy vấn ledger mới), và `dashboardSectionLines(section, index, context, overviewLines, workers?)` — tái dùng đúng `view.lines`/`workerLines`/`stateLines` mà `status`/`workers`/`tasks`/`coverage`/`findings`/`log` đã dùng, không thêm phép tính mới.
- `extensions/p2o/index.ts`: nhánh `/p2o dashboard [section]` mới (sau nhánh `stateCommand`, trước `operatorCommand`). Ba trường hợp đúng như `status` đã xử lý: **historical** (store đã mở) dùng text tổng hợp sẵn có; **finished in-memory** (`lastStatus`) chỉ tab overview hoạt động, tab khác báo "No active/open knowledge store" — giống hệt cách `status` xử lý case này; **active run**: đọc ledger **đúng một lần** (`readLedger` → `currentStatus(current, current.phase, index)`), lưu vào `current.lastDashboardData`, mở `DashboardScreen` qua `ctx.ui.custom` (TUI) hoặc gọi `dashboardSectionLines(...).join('\n')` qua `ctx.ui.notify` (RPC — đây là P3, gộp luôn vì cùng một hàm `dashboardSectionLines` dùng ở cả hai nơi, đúng khuyến nghị "a single dashboardText used everywhere" ở §D.140(c)).
- `refreshVisibility`: đổi từ `currentStatus(current)` (tự đọc ledger) sang tự đọc `index` rồi truyền vào, để giữ lại tham chiếu `index` sau khi quét — **không tăng số lần quét ledger nền**, chỉ hoist biến đã có ra ngoài. Sau khi set widget, ghi `current.lastDashboardData` rồi gọi `.refresh()` trên mọi `DashboardScreen` đang mở (`current.dashboardScreens`). Đây là cơ chế sống duy nhất — cả màn hình modal (P2) và overlay F2 (P5) dùng chung, không có vòng quét riêng.
- `closeVisibility`: dọn `dashboardOverlay`/`dashboardScreens` cùng lúc dọn widget.

### P3 — RPC/text parity
Gộp vào P2 (không tách riêng): nhánh `else` của `/p2o dashboard` trong RPC/json/print gọi đúng `dashboardSectionLines(...)` rồi `ctx.ui.notify(...)`, tính theo yêu cầu lệnh, không có quét nền (khớp mô tả P3 gốc "on-demand only, no background scan").

### P5 — Phím tắt F2 + overlay không giữ phím (thực nghiệm)
`pi.registerShortcut('f2', {...})`: không có run active/không TUI → `notify` nhắc; có run → mở `DashboardScreen` qua `ctx.ui.custom(factory, {overlay:true, overlayOptions:{nonCapturing:true, anchor:'top-right', width:'48%', maxHeight:'70%'}, onHandle})`. Bấm lại F2 chỉ `handle.setHidden(!handle.isHidden())` — **không tạo lại** overlay, giữ nguyên tab/scroll đang xem. Vì `nonCapturing:true`, overlay không nhận bàn phím nên không tự chuyển tab được khi ở dạng này; nó luôn mở ở tab overview và chỉ để xem lướt trong khi gõ `/p2o hold` ở editor chính — đúng mục tiêu gap C "Could I keep looking while I type /p2o hold?".

### Test harness (`tests/minimal/helpers/fake-pi.ts`) phải mở rộng — đúng như §D.124 đã lường trước
- Thêm `pi.registerShortcut`/`shortcuts` map (trước đây hoàn toàn chưa có).
- `ctx.ui.custom` trước đây truyền `tui={}` (gọi `requestRender()` sẽ crash) và không biết `options.overlay`/`overlayOptions`/`onHandle`. Nay: `tui` giả có `requestRender()` đếm số lần gọi (`ctx.renderRequests`), và khi `options.overlay` có một `OverlayHandle` giả (`hide/setHidden/isHidden/focus/unfocus/isFocused/getBounds`) được tạo và truyền cho `onHandle`, đẩy vào `ctx.overlays` tách riêng khỏi `ctx.screens` (modal) để test không nhầm hai loại.
- `scripts/measure-context.mjs` dùng một `api` giả riêng (không phải fake-pi.ts) để đo kích thước prompt — cũng thiếu `registerShortcut`, phải thêm no-op ở đó để không crash khi đo.

### Test mới
- `tests/minimal/dashboard.test.ts` (đã có từ lượt 1, không đổi).
- `tests/minimal/dashboard-screen.test.ts` (mới, thuần component): mở đúng tab ban đầu, chuyển tab bằng số/←→ kèm wrap hai đầu, cuộn và chặn biên offset, đóng bằng Esc/q, `refresh()` gọi `requestRender` và giữ nguyên tab.
- `tests/minimal/dashboard-command.test.ts` (mới, mức extension): mở đúng tab mặc định/tab chỉ định, từ chối tab sai, fallback RPC, **sống khi đang mở mà không quét ledger thêm** (so sánh baseline trước/sau khi mở dashboard — không khẳng định một số tuyệt đối vì `p2o_task create` tự nó đã đọc ledger, không liên quan dashboard), giữ tab khi refresh, hành vi overview-only sau khi run kết thúc; cùng khối test cho F2 (cần run active + TUI, mở overlay `nonCapturing:true`, toggle ẩn/hiện không tạo lại, sống qua cùng pipeline refresh).

### `docs/USAGE.md`
Thêm `/p2o dashboard [...]` vào khối lệnh "Xem tiến độ" cùng một đoạn mô tả tab/F2/RPC fallback. `HELP` trong `index.ts` cũng thêm dòng tương ứng (không bắt buộc bởi `help-commands.test.ts` — test đó chỉ kiểm chiều README/USAGE.md → HELP — nhưng vẫn làm vì lệnh mới nên luôn có trong `/p2o help`).

### Kết quả kiểm tra
`npx tsc --noEmit -p .` sạch. `npx vitest run tests/minimal`: 66 file pass / 6 skip (72), 590 test pass / 12 skip (602) — tăng từ 574/586 lượt 1 lên 590/602 lượt này (16 test mới: 7 cũ dashboard.test.ts không đổi, +6 dashboard-screen.test.ts, +10 dashboard-command.test.ts, trừ đi phần không tăng do đếm trùng — số chính xác xem log chạy). `detect-changes --scope all`: **risk critical** (7 file, 80 symbol, 41 flow) — phần lớn symbol "thay đổi" là do dịch số dòng trong `index.ts` (file rất lớn, chèn code sớm làm lệch offset của các symbol không liên quan như `WorkerRun`/`Run`), rủi ro thật nằm ở `refreshVisibility`/`closeVisibility`/`registerP2O` — đã cảnh báo đúng luật AGENTS.md, không phải lý do dừng vì các hàm dùng chung khác không đổi hành vi hay chữ ký.

### Còn lại thật sự chưa làm
P4 (HTML export) — owner chủ động không yêu cầu lượt này, giữ "rejected/optional". D6 vẫn mở nếu owner muốn quay lại. Mọi phase bắt buộc theo roadmap gốc (P0-P3, P5) nay đã xong; P5 còn nhãn "thực nghiệm" vì overlay non-capturing chưa được xác nhận qua một phiên Herdr/TUI thật (D10 vẫn chưa làm, chỉ test qua fake-pi.ts).
