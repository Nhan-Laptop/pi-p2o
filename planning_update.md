# Visual graph and findings screens — ARTEX comparison, owner decisions and the path (a) implementation plan (plan of record v4, decisions closed 2026-11-03)

This revision replaces the v3 draft in full. v3 compared ARTEX's graph and findings screens with pi-p2o's data and
recommended path (b) (in-Pi surfaces only). The owner has since decided the other way, in this session, on
2026-11-03: **path (a) — a standalone, read-only dashboard outside Pi, with a rewrite of the README mission line**,
built as a Next.js client over a new in-repo read model, shipped with both a localhost service mode and a frozen
snapshot/export mode. The comparison work in v3 is retained (§3–§4); the proposal, phases, tests and open decisions are
rewritten for the chosen path.

What this document is not: it is **analysis and plan only**. No code, test, schema, store, report or target has been
changed for this revision, and no suite has been run (the only modified file is this one, by the owner's instruction).
Every cost below is an estimate, not a commitment; every phase becomes work only after the owner's explicit go-ahead,
and nothing is committed or pushed without a fresh instruction.

Continuity: the committed plan of record is still v2 at HEAD `3a7b0eb` (`git show 3a7b0eb:planning_update.md`); the
working tree was clean at that commit, so that blob is the complete v2. v3 was an uncommitted draft replaced by this
file; its comparison content is carried into §3–§4, so nothing of it is lost that this document does not restate. The
v2 §8 decided entries (W-Q A; W-R A + W-S C + W-T A; W-U B + W-V C; W-W A; W-X C; W-Y A; W-Z C then A; W-AA B; W-AB B;
W-P A) remain in force with their code and tests, and are not re-litigated here. In particular v2 §3.4's rule "copy
mechanisms, not the philosophy" still governs how ARTEX is borrowed below.

Confidence labels: **C** — confirmed by direct file, screenshot or type read; **I** — inferred from code structure but
not proven by a run; **U** — unknown, needs a live measurement. ARTEX claims are source-snapshot claims only. The
screenshots in `my_references/ARTEX/screenshots/` come from the project's demo mode (`README.md:8` online demo;
`README.md:268` demo mode emits synthetic, clearly labelled records), so they demonstrate the UI shape, not ARTEX's
measured pentest capability.

## 0. Executive summary

1. **The stop condition was not triggered, and path (a) does not change that.** pi-p2o already commits the exploration
   graph (node kinds, relations, anchors, digest folding, inherited copies) and per-run findings data that is a
   superset of ARTEX's findings fields. The missing piece was a presentation layer. The owner has now chosen to pay for
   a standalone one, so the question is no longer "can the data carry a view" (yes, shown in §4) but "what is the
   smallest defensible way to build a read-only standalone UI over committed records" (§6).
2. **The owner's decisions, recorded in §1 in three rounds, fix the shape**: path (a); both the localhost service and
   the frozen snapshot/export mode in the first delivery programme (P2/P3, not "later"); a **Next.js** client like
   ARTEX's web app; data read **read-only from both run state databases and report bundles**; findings shown at **full
   report-level evidence detail**; the README:5–6 mission line **replaced by a feature description** (the approved
   shorter sentence is in §5.5); the exploration projection gains a **`hint` node kind with
   `EXPLORATION_GRAPH_VERSION` 2 → 3**; node priority shows **"not recorded"** rather than inventing a value; cross-run
   findings aggregation is in scope now; the human command stays **`/p2o map`**, whose snapshot export writes into an
   **absolute, operator-given directory**; and the remaining implementation choices are closed too — **npm workspace**
   layout, **loopback + per-launch token** from P3, **artifact bodies copied into snapshots**, a **standalone server
   with 5 s polling plus a manual refresh button**, a **directory snapshot**, the automatic `counts.byKind.hint` key,
   and the **acceptance matrix + AGENTS.md + HISTORY** updates (§1.3, §8.1).
3. **Architecture in one paragraph.** A new in-repo TypeScript module (`src/dashboard/`) builds a deterministic read
   model: for each retained run it opens the store **read-only** and re-derives the exploration graph in memory from
   committed records with the existing `deriveExploration` oracle; findings are projected by the **same code the report
   uses** (extracted from the extension's `renderStoreReport`), so the dashboard and `findings.json` cannot drift.
   Cross-run findings come from those store projections plus `findings.json` in report bundles (verified against their
   `report-manifest.json` sha256), merged by the existing host-derived finding identity. A second new module is a thin
   **Node `node:http` server**, loopback-bound, GET/HEAD-only, read-only, that serves a Next.js static export client
   and the same JSON paths from either live state roots or a frozen snapshot directory. The client lives in a standalone
   `dashboard/` npm project and is compiled to static assets by `next build` (`output: 'export'`); it is a **build-time**
   dependency only, so the Pi extension's runtime dependency set stays empty.
4. **The mission line changes, honestly and minimally.** "…and no dashboard" becomes the approved sentence
   "There is no hidden planner model and no provider harness. An optional local, read-only dashboard renders committed
   records and holds no execution authority." (§5.5). The edit lands in the same change as the first runnable viewer
   (P2), never earlier: the repo must not document a surface that does not exist yet. This is the product-boundary cost
   the owner accepted with decisions D1/D5/m1.
5. **Phases (estimates, not commitments).** **P1** read model + projection v3 (`hint`), no UI: ~1.5–2 days. **P2**
   Next.js shell, graph screen, snapshot export mode, mission-line edit: ~2–3 days. **P3** findings screen at full
   evidence detail + live service mode + `/p2o map` wiring: ~2.5–3.5 days. **P4** hardening, security tests, docs and
   acceptance: ~1–1.5 days. **P5** is optional scope (LAN `--host`, single-file export, spawn-from-Pi, asset-graph tab, priority
   persistence) and is not assumed. Total: roughly one and a half to two working weeks of focused work plus review, with no paid/live
   assessment needed.
6. **What the owner is buying, stated plainly**: a browser UI across runs, shareable with a reviewer, at the cost of a
   new listening process, a new data access path, browser-side XSS/redaction review, a frontend workspace, and a
   mission-line change. The mitigations are structural, not promises: loopback-only plus a per-launch bearer token on
   data routes (from P3), GET/HEAD-only, read-only store opens (`PRAGMA query_only=ON` already enforced by the store),
   no external assets/URLs in the client, a strict CSP, React's default escaping with a static ban on
   `dangerouslySetInnerHTML`, and evidence shown with the report's own "redacted best effort, may contain target data"
   warning (§6.3, §6.4). Snapshot copies contain redacted-but-sensitive artifact bodies by decision m4 and carry a
   "do not publish" banner.
7. **No design decision is still open.** The owner closed every item in §8 in this session (§1.3, §8.1). The
   §8.2 watch items (packaging for a future release, optional P5 scope, browser E2E, version pinning) are noted so they
   are not rediscovered as surprises; none blocks P1.

## 1. Owner decisions recorded (superseding v3 §7 and this session's second round)

The owner answered the decision list directly in chat on 2026-11-03, in three rounds: product boundary and scope
(§1.1), implementation shape (§1.2), then the remaining build/exposure choices (§1.3). The options are restated so the
record is self-contained; the chosen option is the decision, and a recommendation that was overridden is noted as such,
not argued with again.

### 1.1 First round — product boundary, scope, vocabulary

| Id | Question | Chosen option | Consequence |
|---|---|---|---|
| Q1 | Mission line: keep "no dashboard", narrow it, or allow the service? | **Allow the dashboard service (path a)** | README.md:5–6 is rewritten to describe the feature (§5.5). The line is no longer a constraint to work around; it is a claim to keep true. |
| Q2 | Which path: in-Pi surfaces (b) or a standalone UI (a)? | **(a) standalone UI outside Pi** | New process, new data path, frontend project, security review. v3's recommendation (b) is recorded as overridden (§5.4). |
| Q3 | Findings scope: per-run first, or cross-run now? | **Cross-run now** | G3 (below) is in scope from P1: aggregate across retained run stores and report bundles. |
| Q4 | Command name and snapshot destination | **`/p2o map`, exporting into an absolute directory the operator names** | The name is reused for the new human command; export path rule follows the existing `bundlePath` precedent (`src/state/bundle.ts:25`) and never overwrites. |
| Q5 | Hint nodes (G1): text line only or real kind? | **Add the `hint` node kind to the projection, version 2 → 3** | Projection, store commit path, node text, board/overview JSON and tests change in P1; old runs repair on writable open and read stale on read-only open until re-derived. |
| Q6 | Per-node priority (G2) | **Render "not recorded"** | No schema change and no invented badge; the legend/detail says why (§4.6). |

### 1.2 Second round — implementation shape

| Id | Question | Chosen option | Consequence |
|---|---|---|---|
| D1 | Deployment | **Both from the start: localhost service + frozen export** | P2 delivers export mode end-to-end, P3 delivers service mode; neither is optional/deferred. "From the start" means the same delivery programme, not the same commit. |
| D2 | Data sources | **Combined: state DB for graph/live, report bundles for cross-run findings** | The read model scans both roots; report bundles cover runs whose ephemeral store is already gone; provenance is shown and conflicts are surfaced. |
| D3 | Client stack | **Next.js like ARTEX** | A `dashboard/` workspace project (workspace layout closed as m2 in §1.3) with a pinned Next.js/React toolchain, built to static assets; build-time dependency only for the extension package (§6.9). |
| D4 | Findings detail | **Full evidence as the report shows it** | Reproduction steps, operation/by/exit codes, bounded input/output, capture artifact metadata, chain, limitations, retest and remediation are shown; the report's redaction wording travels with them. |
| D5 | Mission line wording | **Drop "no dashboard" and replace it with a feature description** | The approved sentence (m1, §1.3) is quoted in §5.5; it lands at P2 and describes the read-only local viewer and the authority it does not hold. |
| D6 | Next step after this plan | **Update this document only; then stop** | Nothing below is executed in this revision. Implementation starts only on a fresh owner instruction. |

### 1.3 Third round — remaining implementation choices

| Id | Question | Chosen option | Consequence |
|---|---|---|---|
| m1 | Exact mission-line sentence | **Shorter approved sentence**: "There is no hidden planner model and no provider harness. An optional local, read-only dashboard renders committed records and holds no execution authority." | The sentence lands in P2 (§5.5); the stronger design rules (no edit, no model call, no control route) remain enforced even though the sentence does not enumerate them. |
| m2 | Dashboard project and packaging | **npm workspace/monorepo**, single root lockfile; dashboard toolchain build-time only; `files` unchanged for now | Root `package.json` gains `"workspaces": ["dashboard"]`; root install pulls the Next.js deps; root `npm test` sequence unchanged; `dashboard/out` stays out of the package (§6.9), revisit on a release (§8.2). |
| m3 | Service lifecycle and refresh | **Standalone server**; client polls every 5 s and has a manual refresh button; no spawn/PID bookkeeping from Pi | `/p2o map` prints the standalone command; `--serve` spawning is P5 scope (§6.7 P5). |
| m4 | Evidence artifacts | **Copy cited artifact bodies into snapshots too**, not only serve them live | Snapshot export writes bounded, redacted body copies with bytes/sha256/truncated metadata; frozen mode serves them through the same `/api/artifact` route; docs carry a "do not publish" warning (§6.2, P3). |
| m5 | Network exposure | **Loopback + per-launch bearer token from P3** | Server binds `127.0.0.1`; data/API routes require the token printed in the terminal URL fragment, never logged; LAN `--host` stays P5 (§6.3). |
| m6 | Snapshot packaging | **Directory data tree + static assets** (zip-able) | No single-file HTML in P1–P4; frozen mode is served by our server or any static file server; single-file remains P5 (§8.2). |
| m7 | Board hint surface | **Accept `counts.byKind.hint` automatically; no extra board text line** | One small model-visible key, no new board rows or text; projection/board tests updated (§6.5). |
| m8 | Acceptance and maintenance surfaces | **ACCEPTANCE_MATRIX rows + AGENTS.md `dashboard:*` lines + one HISTORY entry** | P4 adds the matrix rows; the AGENTS.md line is added with the owner's approved diff; HISTORY records the boundary change (§6.6, P4). |

What v3 had proposed and what changed: v3 recommended keeping the line and staying inside Pi; it scoped findings to
per-run; it treated `hint` as a text line and priority as "omit or not recorded"; it described a static HTML snapshot
instead of a served Next.js app. Each of those is superseded by the tables above, and the third round closed the
remaining build/exposure choices, so no design decision is outstanding (watch items only, §8.2). The stop condition in
the original task brief ("stop if the data genuinely cannot represent ARTEX's screens") is unaffected by the path
choice and remains unmet in the good sense: the data can represent them (§4.5).

## 2. Evidence base, method and limits

### 2.1 What was read

- **Real screenshots**, not filenames: `my_references/ARTEX/screenshots/graph.png` (2880×1800) and
  `my_references/ARTEX/screenshots/findings.png` (2880×1800), read as images and inventoried element by element
  (§3.1, §3.2). Adjacent screens were noted but not analysed: `assets_test.png` (asset coverage graph, force-directed)
  and `dashboard.png`.
- **ARTEX architecture and code**: `README.md:343–419` (dual-graph architecture, planner/worker split);
  `ARTEX_AGENTIC_CORE.vi.md` §4.1–§4.2 (asset graph types and derived containment), §5.1–§5.5 (exploration node kinds,
  states, edge directions, DAG caveats, activity history), §8.1–§8.6 (memory and context); `db/schema.sql:170,248,276,1081`;
  `db/exploration.go:67–84,975–999`; `db/findings.go:17–70,152–205,526–560,754–800`; `server/server.go:756–773,1913–1953,2493–2534`;
  `server/findings_groups.go:28–80`; `server/finding_workflow.go:118–172`; `web/src/components/exploration-graph.tsx:60–330`;
  `web/src/app/(main)/function/findings/page.tsx:120–130,754–761,907–930` and `_components/findings-table.tsx:146–164`.
- **pi-p2o data, reads and build surface**: `src/exploration-graph.ts` (constants, `RecordedRow:91`, `ExplorationOrigin:93`,
  `explorationDelta:286`, `deriveExploration:568`, `EXPLORATION_PROJECTION_LABEL:587`, `explorationNodeText:608`,
  `explorationOverview:648`); `src/state/store.ts` (`open:180`, `records:481`, `artifacts:639`, `artifact:665`,
  `explorationOrigin:734` private, `explorationSnapshot:904`, `rebuildExploration:930`, `explorationPage:1027`,
  `graphExport:1604`); `src/state/{files,schema,inherit,bundle,graph}.ts` (`PrivateDirectory:11` with the mode-0700
  check at `:15`; `STATE_SCHEMA_VERSION = 8` at `schema.ts:2`; read-only reopen precedent in `inherit.ts:200–215`;
  `bundlePath:25`, `exportBundle:47`; asset-graph `renderGraph:249`); `src/report-export.ts` (`FINDINGS_FORMAT_VERSION:43`,
  `CASE_ROWS:44`, `findingIdentityFor:342`, `findingFiles:396`, `renderReport:689`, `report-manifest.json` emitted at
  `:922`); `src/report.ts:123`; `src/cases.ts` (`CaseView:33`, `caseRatings:114`, `caseViews:122`, `CaseBoard:187`);
  `src/case-types.ts:5–8,21–47`; `src/project-knowledge-db.ts:13–15,26,72`; `src/ui/{dashboard,screen,state,workspace}.ts`
  (`dashboardLines:15`; `statusView:100`; `stateLines:161`; `StateScreen:6`; `graphLines:120`, `graphExportLines:142`;
  export-path quote handling `:44–45`); `src/board-verbs.ts:40`; `extensions/p2o/index.ts` (`HELP:136–148`,
  `showState:491–493`, `statusView` call `:507`, `setWidget('p2o-progress'):1083`, `renderStoreReport:2036`,
  `defaultReportDirectory:2172–2173`, steering write `:4280–4296`, `steeringFacts:1931–1940`); `src/engine.ts:7,160–170`;
  `src/priority.ts`; `src/validate.ts` (`sha256Hex`, `validId`); `package.json` (no runtime deps; build is `tsc`;
  `engines.node >= 22.19`; `files` list has no dashboard entry); `src/broker.ts:1,288–292` (the only existing server
  is a `node:net` control socket — there is no HTTP server in the repo today).
- **Tests whose contracts this plan must respect**: `tests/minimal/help-commands.test.ts:11–13` (documented `/p2o`
  commands must appear in the help text), `tests/minimal/docs-truth.test.ts:25–28` (scans README/HANDOFFS/docs for
  `p2o_*` verbs that are not model tools), `tests/minimal/surface-audit.test.ts` and
  `tests/minimal/context-budget.test.ts` (model tool declaration budget), `tests/minimal/acceptance-matrix.test.ts`
  (`file :: title` references), `tests/minimal/dashboard.test.ts` (the *existing* text dashboard lines — new test files
  must not collide with this name), plus the projection/board suites listed in §7.
- **Pi extension API**: `@earendil-works/pi-coding-agent@1.1.0` type declarations (`ExtensionContext.mode`,
  `hasUI`, `ExtensionUIContext.custom`/`setWidget`), used by `StateScreen` today. Path (a) deliberately does not use
  the TUI overlay; the in-Pi surface stays the existing widget/screen and a text command.

### 2.2 GitNexus is a floor for caller claims here (C)

`node .gitnexus/run.cjs status` reports the index up to date at commit `3a7b0eb`, 707 covered files. Caller probes are
incomplete for TypeScript presentation symbols, so **every caller claim in this document was confirmed with grep**:

- `impact "dashboardLines"` returns `epistemic: "exact"`, `direct: 1` — matches the single grep caller at
  `src/ui/state.ts:155`.
- `impact "statusView"` returns `risk: "UNKNOWN"`, `direct: 0`, "No callers resolved" — but grep finds a real caller at
  `extensions/p2o/index.ts:507` (`statusView(ledger, {…})`). The src/→extensions/ boundary is not resolved by the index.

Treat GitNexus caller counts as lower bounds for this area; do not delete or rename a presentation symbol on a zero.
Before P1 edits `renderStoreReport` (extraction), the implementation must run impact/detect-changes and re-check callers
with grep, per AGENTS.md.

### 2.3 Limits

- No ARTEX run transcript and no browser session were available: screen behaviour is read from a static screenshot and
  the source snapshot, not observed. Where screenshot and current web code disagree, both are recorded (§2.4).
- No p2o suite was run for this revision (documentation-only change). The test impact in §7 is a plan, not a result.
- Browser behaviour of the proposed client is unverified until P2; there is no browser E2E harness in the repo today.
- The threat model assumes the dashboard runs as the same OS user on the operator's own machine and is reachable only
  over loopback (§6.3). It does not pretend to be safe on a shared or hostile host, and it does not add auth.
- Estimates are ordering devices, not schedule commitments.

### 2.4 Screenshot/code drift in ARTEX (C, recorded rather than smoothed)

- **Findings tiles:** the screenshot shows five tiles — total 10, high 4, medium 4, low 2, **tasks involved 3**. Current
  page code defines six stat cards — total, **pending**, **critical**, high, medium, low (`findings/page.tsx:754–761`),
  backed by `FindingStats` (`db/findings.go:526–536`); "tasks involved" is not one of those cards. Both facts are true
  of their own snapshot; the dashboard picks its tiles from what p2o can count (§6.4), not by copying either list.
- **Findings columns:** the screenshot table is severity · vulnerability type · summary · owning task · time. Current
  `findings-table.tsx:146–164` renders severity · vulnerability name · **assets** · **status** · owning task · time ·
  **actions**. The extra columns are real capabilities in current code, not in the screenshot.
- **Graph legend:** the screenshot legend names six node types (start/goal/intent/fact/finding/hint) and four edge kinds;
  the component's `typeMeta` also defines `task`, `begin` and `digest` (`exploration-graph.tsx:60–79`) — `begin` is the
  origin fact rendered as "start", digest nodes are fold targets. The proposal mirrors the component, not the legend.

## 3. (A) What ARTEX's graph and findings screens show

### 3.1 Graph screen (`screenshots/graph.png`) — the "exploration chain" tab

**Context**: a single task "Acme 官网与后台外部渗透 (acme.com)" tagged `t-acme-web`; header shows `LLM 已配置` (green)
and `探索中` (blue) with a `暂停` button. Task-detail tabs: 会话 / 总览 / **探索链路** (active) / 发现 / 测试资产 /
拦截审批 / 报告. The page describes itself as the exploration lineage of one task.

**Canvas** (C):

- A **layered, left-to-right DAG** on a dotted background: origin and hint at the left, goals next, intents in the
  middle, facts and findings to the right, with curved labelled edges coloured by relation (派生 / 意图链 / 产出 / 证明).
- **Legend overlay** top-left: node types 起点 (start), 目标 (goal), 意图 (intent), 事实 (fact), 漏洞 (finding), 提示
  (hint); edge kinds 派生 (green), 意图链 (blue), 产出 (orange), 证明 (red).
- **Zoom/pan affordances**: `+`, `−`, `⤢` (fit) buttons bottom-left; a **minimap** bottom-right; the dotted canvas and
  minimap imply panning.
- **Node cards** carry a type icon and label, an id (`#root`, `#g1`, `#m1`, `#f1`, `#v1`…), a one-line summary, a state
  chip (`● 达成` met, `● 进行中` in progress, `● 已完成` done, `● 执行中` running), and for goals/intents a `P<n>`
  priority badge (P6/P8/P9 visible) whose tone changes with the number.

**Concrete node inventory in the shot** (C): start "根: acme.com 外部渗透" `#root`; hint
`{"summary":"后台是 Element-UI，优先跑默认口令表"}` `#m1` (purple); goals "获取后台管理权限" P9 `#g1` (met) and
"读取用户敏感数据" P8 `#g2` (in progress); five intents with `P` badges and ids #1–#5; facts `#f1` "发现子域
admin.acme.com（Element-UI 后台）", `#f2` "search q 参数为 error-based 注入点(MSSQL)"; findings `#v1` "后台默认口令
admin/admin123", `#v2` "SQL 注入（search q）可读 acme_prod 库" (a third, api.acme.com finding, is cut off at the
right edge).

**What the screen needs from storage** (C): nodes with kind/state/payload/priority/id and edges with relation/src/dst,
served by `GET /api/exploration/graph` (`server/server.go:2493–2534`: up to 2000 nodes, 5000 edges, inherited source
tasks merged). Layout is client-side (`exploration-graph.tsx:194` `computeLayout`), digest nodes collapse into a
super-node that rewires edges (`:141` `collapseDigestGraph`), and the payload field shown per kind is fixed (`:97`
`summaryFields`: goal→text, intent/fact→summary, finding→name/summary, digest→body, origin→summary/description). There
is no graph database: `ARTEX_AGENTIC_CORE.vi.md` §4.1 confirms a Postgres asset table plus exploration tables, and §4.2
confirms asset containment is derived in Go, not persisted as edges.

### 3.2 Findings screen (`screenshots/findings.png`) — global, cross-task

(C) Header "发现" with subtitle "跨任务漏洞汇总" (cross-task vulnerability summary). The page is **global, not per-task**:
a filter can narrow to one task, but the default table is every task's findings. This is the screen the owner's
cross-run decision (Q3) targets.

- **Five count tiles**: 发现总数 10, 高危 4 (red), 中危 4 (orange), 低危 2 (grey), 涉及任务 3 (tasks involved).
- **Filter row**: severity segmented control (全部 / 高危 / 中危 / 低危), a vulnerability-type dropdown ("全部类型"), a
  sort dropdown ("按严重度"), a result total on the right ("共 10 条"), plus global search in the page header (`⌘J`).
- **Table columns**: 严重度 (severity badge) · 漏洞类型 (type badge) · 摘要 (one-line summary) · 所属任务 (owning task,
  truncated, external-link icon) · 时间 (MM/DD HH:mm). Rows have an expand chevron; pagination is "20 条/页 · 1–10 /
  共 10 条".
- **Rows in the shot**: Default Credentials/high, Weak JWT/high, IDOR/high, SQL Injection/high, Reflected XSS/medium,
  Exposed .git/medium, Missing Rate Limit/medium, Outdated Component/medium, Verbose Error/low, Open Redirect/low.
- **Detail/actions beyond the table** (C from code): row expansion and an actions column; a per-finding detail page with
  retest, evidence and report; table/grouped/asset-tree views; bulk export (md single / md split zip / csv / json);
  finding detail lineage on the graph (`findings/detail/lineage.tsx`).

**What backs it** (C): a standalone `findings` table (`db/schema.sql:1081`) that survives task deletion, with
`DBFinding` fields id/task/node/vulnclass/name/severity/summary/evidence/worker/asset_ids/status/report/created_at and
traffic binding counters (`db/findings.go:17–45`); nine triage `status` values (`:43–56`); four severities
critical/high/medium/low (`:63–69`); a shared filter struct severity/status/vulnclass/task/q/sort/asset_scope
(`:152–168`, parsed in `server/findings_groups.go:28–40`); a whole-table stats query (`:526–560`) and a task-group page
(`findings_groups.go:58–80`); endpoints `GET /api/exploration/findings`, `/groups`, `/asset-tree`, `/stats`, `/{id}`,
`/{id}/lineage`, retest routes (`server/server.go:756–769`).

**Correcting the task brief's file list** (C): `server/asset_intercept.go:1–156` is the **asset blocklist rule CRUD**
(拦截规则: exact/fuzzy domain·ip·url + CIDR), not the graph/findings screens. `server/finding_workflow.go:145–172` binds
traffic evidence to a finding; `server/findings_groups.go` is the findings filter/group/asset-tree API layer. The graph
screen's API handler is `server/server.go:2493`; the findings screen's API is the `/api/exploration/findings*` family.

**Live behaviour** (I): ARTEX is server+DB; its engine holds a broadcaster for live activity pub/sub (SSE) and the web
page re-fetches/polls per view. p2o's new dashboard keeps the pull model: the server re-reads committed records on
request/poll; there is no event bus, no websocket and no push in P1–P4.

### 3.3 Architecture statements from the ARTEX docs (C)

- `README.md:347–349`: two graphs — the **asset graph** (global, shared across tasks; node types root_domain /
  subdomain / ip / service / app / endpoint, dedupe keys computed by code) and the **exploration graph** (per task;
  goal / intent / fact / finding / hint nodes connected by `spawns / derived_from / yields / proves` lineage edges,
  `exploration_anchors` pinning nodes to assets). The split answers "which direction came from which observations and
  produced what".
- `ARTEX_AGENTIC_CORE.vi.md` §5.1: node states — goal open/met/abandoned; intent open/running/paused/done/blocked/
  exhausted/stopped/deleted; fact and finding confirmed/dismissed; hint active/consumed; digest active/superseded;
  `begin` legacy. A node carries payload JSON, **priority**, origin, owner, blocked/delete reasons, anchors, timestamps
  and inherited/source metadata (`db/exploration.go:67–84`).
- §5.2: edge directions — `spawns` (origin fact → goal), `derived_from` (fact/finding upstream → new intent; the label
  reads backwards in the UI), `yields` (intent → fact or finding), `proves` (evidence fact/finding → goal), `covers`
  (digest → member). The UI legend maps these as 派生 / 意图链 / 产出 / 证明 (`broadcast-tab.tsx:99–102`); `covers` is
  structural and is not drawn (`exploration-graph.tsx:141`).
- §5.5 / §8: the graph stores conclusions and coordination units, not every tool call or thought; tool calls live in an
  `activity` table and raw conversations in transcripts. A renderer must not present node count as reasoning history or
  as verification.

## 4. (B) What pi-p2o already has today

### 4.1 Exploration-graph data (C)

The projection is committed and replayable, not a render-time invention:

- Node kinds: `origin, goal, link, intent, fact, finding, hint, digest` — `src/exploration-graph.ts:24` (v3, owner Q5,
  adds `hint` for committed operator steering). Relations:
  `spawns, derived_from, yields, proves, covers, leads_to` — `:28` (`leads_to` is p2o-only: recorded chain order).
- Closed state vocabulary per kind — `:34–42` (goal proposed/active/met/reviewed/closed/blocked/cancelled; intent
  proposed/reserved/running/reported/reviewed/closed/blocked/cancelled/expired; fact demonstrated/confirmed/
  open_proof_gap/ruled_out/unknown; finding pending/accepted/disputed/withdrawn; hint active; digest active/superseded; link
  open/in-progress/done/deferred/blocked/cancelled; origin current).
- Bounded row/projection types — `:62–90` (node row with id/kind/state/entityId/recordId/sequence/body/inheritedFrom/
  sourceNodeId; edge row srcId/rel/dstId; anchor row nodeId/assetEntity; projection with `unresolved` and `overflow`
  counters that must be rendered as "stopped early", never dropped). `RecordedRow`/`ExplorationOrigin` inputs:
  `:91`, `:93`.
- Caps: 4000 nodes, 8000 edges, 8000 anchors, 8 KiB per node body — `:43–57`; deterministic node id — `:123`; digest id
  — `:127`.
- Derivation from committed records — `explorationDelta` `:286` (the bounded per-record projection the store applies),
  `deriveExploration` `:568` (the complete in-memory oracle; the rebuild path and the tests use it, and it is byte-for-byte
  deterministic — "no clock, network or second run is read").
- Read projections: `explorationOverview` `:648`, frontier `:694`, lineage `:751`, `explorationPage` on the store
  (`src/state/store.ts:1027`), `explorationAncestryLines` `:813`, `renderOverviewLines` `:887`, digest page `:998`,
  report facts `:1045`.
- Persistence: derived SQLite tables `exploration_nodes`/`exploration_edges`/`exploration_anchors`
  (`src/state/schema.ts:106–130`, schema version 8 at `:2`) and the store read API `explorationSnapshot()`
  (`src/state/store.ts:904`), with the read-only-safe rebuild oracle `rebuildExploration()` at `:932`. Inherited copies
  are trimmed and labelled at `src/state/inherit.ts:34,147–210`; the read-only reopen precedent is `inherit.ts:200–215`.
- The label every read prints: `EXPLORATION_PROJECTION_LABEL` — `src/exploration-graph.ts:587`.
- Version semantics already in place: a stored row's graph version is read back (`src/state/store.ts:864–900`) and a
  writable open repairs an older derived projection once; a read-only open never writes. This machinery is why a
  version bump (`hint`) is a known operation rather than a new migration system (§6.5).

### 4.2 Asset-graph data and its text renderer (C)

`src/state/graph.ts:8–11` defines 12 asset kinds (endpoint/route/file/symbol/binary/package/identity/config/data/host/
service/other), 16 relation kinds and 7 anchor kinds; `:17–31` the ceilings and the `graphCapacity` multiplier; `:100–110`
the typed inputs; `:249` `renderGraph` renders a bounded **Mermaid** `graph LR` plus JSON; `src/state/store.ts:1604`
`graphExport`; `src/ui/workspace.ts:120` `graphLines` and `:142` `graphExportLines` are the human reads. This is the
second graph ARTEX shows (asset/coverage screen) and it is already text-rendered. It is not the primary subject of the
owner's ask, but the dashboard's graph screen can expose it as a second tab in P3+ without new data work (`graphExport`
JSON is already bounded and attributed).

### 4.3 Findings/cases data (C)

- Case finding fields: severity (`critical/high/medium/low/informational`), basis, likelihood, impact, CVSS vector, CWE
  list, remediation steps, references, reproduction evidence/steps, independence waiver, chain, limitations —
  `src/case-types.ts:8`, `:21–47`. Verdicts open/confirmed/ruled_out/inconclusive, review statuses
  pending/accepted/disputed/withdrawn, remediation statuses unplanned…failed — `:5–7`.
- Views: `CaseView` carries currentness, staleness reasons, independent currency, acceptedFinding, readyToRate,
  canonical id, owner rating + flags, retest + evidence version — `src/cases.ts:33`; `caseViews` `:122`;
  `caseRatings` `:114`; `CaseBoard` (text list/view) `:187`.
- Report and export: report case rows `src/report.ts:123`; `findings.json`/`findings.csv` with per-finding severity,
  CVSS, CWE, WSTG, ATT&CK techniques, retest verdict, review/currentness, independence, policy/root-cause keys,
  remediation, references, reproduction receipts, evidence version and traffic citations — `src/report-export.ts:396–421`,
  format constants `:42–44`, finding identity derivation `:342`; the report manifest (`:922`) lists every report file with
  `bytes` and `sha256`, which the dashboard uses as an integrity check (§6.2).
- The report projection is **accepted-current only** by design (`findingFiles` iterates `orderedAccepted`;
  `findings.json` note: "Accepted, current cases only"). Full case coverage (pending/disputed/stale) exists only inside a
  retained store, which is why the dashboard shows two finding scopes rather than one (§6.2).
- Cross-run store: `ProjectKnowledge` merges opt-in, accepted finding observations (findingId, policyKey, rootCauseKey,
  severity, state, caseRef) plus cited assets into a host-only SQLite DB on `report export --project-knowledge`; it is
  explicitly "suggested context only: never a graph fact, never a receipt" — `src/project-knowledge-db.ts:13–15,26–39,72`.
  It is **not** the aggregation source for the dashboard: it is opt-in, accepted-only and host-write-only. The dashboard
  reads report bundles and retained stores directly, read-only.

### 4.4 Existing read and presentation surfaces (C)

| Surface | Entry point | What the operator/model gets | Audience |
|---|---|---|---|
| Progress widget | `extensions/p2o/index.ts:1083` (`setWidget('p2o-progress')`), lines built by `src/ui/state.ts:150–158` and `src/ui/dashboard.ts:15` (`dashboardLines`) | one-line Work/Queue/Coverage/Cases/Round dashboard above the editor, refreshed on a scan | operator |
| Full-screen read viewer | `extensions/p2o/index.ts:491–493` `showState` → `ctx.ui.custom` (TUI only, `ctx.mode === 'tui'`), `src/ui/screen.ts:6` `StateScreen` | paged, reflowing text screen with ↑↓/PgUp/PgDn and Esc/q | operator |
| `/p2o status` | `src/ui/state.ts:100` `statusView` (called at `extensions/p2o/index.ts:507`) | tasks/frontier/round/authority/workers/retention lines | operator |
| `/p2o report` index | `src/ui/state.ts:161` `stateLines`, extension `:4656` | handoffs, candidate claims, case rows, coverage plans; not the final report | operator |
| `/p2o log`, `heads`, `show`, `digest`, `search`, `artifact(s)` | `src/ui/workspace.ts` and `extensions/p2o/index.ts` | bounded committed-record/artifact reads | operator |
| `/p2o graph …` asset graph | `src/ui/workspace.ts:120` `graphLines`, `:142` `graphExportLines`; Mermaid renderer `src/state/graph.ts:249` | asset page/view lines, and JSON+Mermaid export printed in place | operator |
| `p2o_board board=graph` exploration graph | `extensions/p2o/index.ts:3640–3660`; board names `src/board-verbs.ts:40`; docs `docs/USAGE.md:223–225,240–246` | bounded overview (`explorationOverview`, frontier, digest page) or one lineage page (depth 6, limit 60, 24 KiB) | **planner model only** |
| `p2o_board board=lineage`, `board=cases`, `tasks`, `coverage`, `plans` | extension board dispatch `:3661+`, `src/board-verbs.ts:40` | bounded JSON/rows for authoring reads | planner model only |
| Report "Attack graph — recorded ancestry, bounded" | `src/report-export.ts:617–652` | digest table, per-accepted-case ancestry, chain order, inherited line — all labelled a derived projection | report reader |
| `findings.json` / `findings.csv` | `src/report-export.ts:396–421` | the richest per-finding export in the repo | report consumer |
| Project-knowledge DB | `src/project-knowledge-db.ts:72` | opt-in cross-run accepted findings + cited assets, host-only | operator/report |

The gap the dashboard fills is visible in the table: **there is no human entry point for the exploration graph**
(`board=graph` is a planner tool, `/p2o graph` is the asset graph), there is no visual surface for either graph, and
there is no cross-run findings screen. Findings exist as cases (text), report sections and export files.

### 4.5 Field-by-field overlap

Legend: **E** exact/equivalent; **R** p2o is richer; **D** same role, different vocabulary (needs mapping, not data);
**G** real gap (data absent or not representable).

#### Table 1 — exploration node kinds and attributes

| ARTEX node kind (source) | p2o node kind (source) | p2o states | Verdict | Notes |
|---|---|---|---|---|
| origin/root fact `state=origin`, rendered as 起点, plus component type `task`/`begin` (`exploration-graph.tsx:60–82`) | `origin` (`exploration-graph.ts:24`) | `current` (`:34`) | E | p2o body: targetKind/targetDisplay/objective/mode; one run = one campaign root. The component's extra `task`/`begin` render aliases are UI-only. |
| `goal` (doc §5.1) | `goal` | proposed/active/met/reviewed/closed/blocked/cancelled (`:35`) | R | p2o adds a typed proof contract (`proof.kind` capability/case/coverage, `exploration-graph.ts:370–398`); ARTEX goal proof is model-evaluated and `goal_met` is unbound by default (ARTEX doc §7.4). |
| `intent` | `intent` | proposed/reserved/running/reported/reviewed/closed/blocked/cancelled/expired (`:37`) | D/E | Same scheduling unit (ARTEX intent ↔ p2o task); vocabulary differs — mapping note below. p2o body: taskId/revision/role/purpose/status/claimRefs/methodFamily/title. |
| `fact` | `fact` | demonstrated/confirmed/open_proof_gap/ruled_out/unknown (`:38`) | R | p2o body: slug/recordId/closure/execution/gained/needs; ARTEX fact states confirmed/dismissed. p2o can demonstrate false-ness (`ruled_out`) as a first-class state. |
| `finding` | `finding` | pending/accepted/disputed/withdrawn (`:39`) | D | p2o finding node = a case; the standalone finding detail lives in the case rating (Table 3). ARTEX finding node state confirmed/dismissed; its triage status is a separate findings-row concept. |
| `hint` | **planned: `hint` (P1)** | planned: `active` (see §6.5) | **G1 → closing** | Steering hints are committed as lifecycle records (`extensions/p2o/index.ts:4280–4296`, data `{steering:{kind,text}}`; read back in `steeringFacts:1931–1940`; limits 24 hints / 12 constraints per run) but the projection does not derive them today. The owner chose the projection addition (Q5); it lands in P1 with version 2 → 3. |
| `digest` | `digest` | active/superseded (`:40`) | E | p2o body: round/window/counts/additions/text; `covers` edges; the client can fold members like ARTEX (`exploration-graph.tsx:141`). |
| `begin` (legacy) | covered by `origin` | — | E | No separate p2o kind needed; the renderer labels origin as start. |
| — (ARTEX has no link node) | `link` | open/in-progress/done/deferred/blocked/cancelled (`:36`) | **R** | p2o records chain steps as nodes with `leads_to` order and effect/needs/gained — more than ARTEX's graph shows. |
| node `priority` (`db/exploration.go:74`; UI badge `exploration-graph.tsx:302`) | **none** | — | **G2** | p2o dispatch priority is transient in the engine queue (`src/engine.ts:7,160–170`) and a suggestion-only derivation (`src/priority.ts`); it is not a persisted node/task attribute. Owner decision Q6: render "not recorded", never invent. |
| `anchors` (node ↔ asset ids, `db/schema.sql:276`) | `anchor` row nodeId/assetEntity (`exploration-graph.ts:75`; schema `src/state/schema.ts:125–130`) | — | E | Both graphs link exploration nodes to assets; p2o anchors are bounded (8000) with `unresolved` counting. |
| timestamps: `created_at` (`db/exploration.go:81`) | sequence/createdSequence/updatedSequence + `recordId` → record `at` | — | E | Time rendering needs one ledger lookup by recordId (available in the same read path); no new field. |
| inherited/source metadata (`db/exploration.go:82–83`) | `inheritedFrom`/`sourceNodeId` (`exploration-graph.ts:62–74`) | — | E | p2o labels inherited rows and the overview counts them apart; ARTEX merges source-task nodes into the graph API (`server/server.go:2493–2534`). |

Note — intent/state mapping for display (D, not data): proposed/reserved → open; running → running; reported/reviewed
→ done-pending-review (p2o's report is not accepted work); closed → done; blocked/expired/cancelled → blocked/cancelled;
deferred link states fold to waiting. The mapping must be printed in the view legend so a reader cannot confuse an
ARTEX "done" with a p2o "closed".

#### Table 2 — edge relations

| ARTEX relation (doc §5.2) | ARTEX UI label (`broadcast-tab.tsx:99–102`) | p2o relation (`exploration-graph.ts:28`) | p2o direction in the projection | Verdict |
|---|---|---|---|---|
| `spawns` | 派生 | `spawns` | origin → goal (`:391`), origin → intent when no lineage (`:456`) | E |
| `derived_from` | 意图链 | `derived_from` | fact/link → intent (`:458`, `:403`), fact → finding (`:429`) | E (same upstream→derived direction; ARTEX doc §5.2 warns the label reads backwards) |
| `yields` | 产出 | `yields` | intent → fact (`:475`), intent → finding (`:427`) | E |
| `proves` | 证明 | `proves` | fact → goal (`:392`, `:483`), finding → goal (`:434`) | E |
| `covers` | not drawn | `covers` | digest → member (`:353`) | E |
| — | — | `leads_to` | link → next link (`:415`) | **R** (p2o-only recorded chain order) |

#### Table 3 — finding/case fields

| ARTEX field (`db/findings.go:17–45`) | p2o equivalent | Verdict | Notes |
|---|---|---|---|
| id / node_id | case id; exploration node id is deterministic (`explorationNodeId('finding', runId, caseId)`) | E | p2o also exports a host-derived `findingId` (identity over target/policy/root-cause/assets, `report-export.ts:342`) used for cross-run merge. |
| task_id | `CaseDraft.taskRefs` (pinned task ids) — and the run itself | D | ARTEX has a global task table; p2o cases cite the tasks whose claims they stand on; the run is the campaign. |
| vulnclass | `policyKey`, `rootCauseKey`, `finding.cwe[]` | D | No single p2o vulnclass: the vocabulary is policy/root-cause keys plus CWE. A type column shows policyKey/rootCauseKey/cwe, not ARTEX labels. |
| name | `CaseEntry.title` | E | |
| severity (critical/high/medium/low) | `CaseFinding.severity` (critical/high/medium/low/informational) | R | p2o is a superset (adds informational). |
| summary | `title` + `finding.basis`/`impact`/`likelihood` | D/R | ARTEX wants one free-text summary; p2o separates the evidence basis, impact and likelihood — the row summary is the title. |
| evidence (free text) | `independentEvidenceRefs` + `reproductionEvidenceRefs` (record ids) + reproduction steps with roles/snapshotRefs | R | p2o cites evidence ids and the host-frozen traffic version; it does not store a free-text evidence blob. |
| worker | no case field | D | p2o attribution is through claim/task records and review receipts (`reviewIntegrity`), not a single worker string; the UI shows the case as owner-attributed, optionally listing contributors. |
| asset_ids | `assetRefs` (id + pinned revision + variant) | R | Revisions are pinned; staleness is first-class. |
| status (9 triage states: pending/in_progress/confirmed/resolved/fixed/false_positive/ignored/duplicate/risk_accepted) | `reviewStatus` (pending/accepted/disputed/withdrawn) + `verdict` + `remediation.status` (7) + `retest.verdict` | D | This is the deliberate p2o difference: evidence review, remediation and retest are separate attributed layers, not one disposition. Do not copy ARTEX's 9 states (v2 §3.4 already rejects its unconditional `confirmed`). |
| report (Markdown) | `reportRefs` + the deterministic report's finding block | D | p2o reports per accepted case from committed records; no per-finding free-text Markdown field is stored on the case. |
| created_at | case record `at` (via `recordId`) | E | Derivable without a schema change; the read path has the index. |
| task_description | run target + campaign objective | D | One target per run; different aggregation unit; the cross-run view uses target + finding identity. |
| traffic_count / evidence_version / traffic bindings | `ratingEvidenceVersion` + `ratingTraffic` (W-Y), plus evidence refs | R | p2o versions the evidence a rating was recorded against; ARTEX binds traffic rows to findings. |
| FindingStats: total/pending/critical/high/medium/low/vulnclasses/tasks (`db/findings.go:526–560`) | counts over `caseViews` (accepted current, pending, stale) + severity counts from `finding.severity`; no `vulnclasses` list, use policyKey/rootCauseKey/CWE; no tasks list, use taskRefs/runs | D | Tile set is chosen from countable p2o facts (§6.4), never copied. |

#### Table 4 — screen capabilities

| ARTEX capability | p2o status | Where it comes from now |
|---|---|---|
| Layered DAG canvas with pan/zoom/minimap | absent | new Next.js client over the read model (§6.4) |
| Node icons per kind, ids, state chips | absent (data present) | node kind/state + `explorationNodeText` (`exploration-graph.ts:608`) |
| Priority badge P<n> | **G2** data gap | Q6: shown as "priority: not recorded"; no invention |
| Hint node kind | **G1**, closing in P1 | committed steering records projected as `hint` (§6.5) |
| Digest fold / rewire | absent (data present) | digest nodes + `covers`; fold in the client |
| Edge labels/colours by relation | absent (data present) | relations list + label mapping (§3.1) |
| Findings global table, cross-task | **G3**, in scope | cross-run aggregation over retained stores + report bundles (§6.2) |
| Count tiles | absent for findings; `status` has task/case counters | `caseViews`/`findings.json` counts (§6.4) |
| Filters severity/type/status/time, sort, pagination | partial text/board reads | new client filters over the aggregated rows |
| Row expand + detail (report/evidence/retest) | partial text reads | report projection re-used verbatim (§6.2, §6.4) |
| Asset tree / asset-scoped filter | absent for findings | assetRefs + asset graph; optional P5 |
| Cross-task aggregation | **G3**, in scope | merged by `findingId` (§6.2) |
| Live streaming updates | absent by design | pull-refresh by polling committed records (§6.3) |
| Export md/zip/csv/json | partial: `findings.json`/`csv`, per-run `REPORT.md`; no zip | snapshot export tree + client-side CSV/JSON of the aggregated view (P3) |

**Overlap verdict**: the graph screen is a **presentation gap** (data E/R on every node kind; G1 closes in P1; G2 is a
deliberate "not recorded"); the findings screen is a **presentation gap plus an aggregation-scope task** (G3), which the
owner placed in scope and which §6.2 solves from existing read-only sources. The stop condition is not met.

### 4.6 The named real gaps and the chosen resolution

- **G1 — hint nodes.** Committed as bounded steering lifecycle records (`p2o_loop hint|constrain`:
  `extensions/p2o/index.ts:4280–4296`, data `{steering:{kind,text}}`; read back as prompt facts at `:1931–1940`; caps 24
  hints / 12 constraints per run, text 3–300 chars). The projection did not derive them. **Owner chose the projection
  addition (Q5)**: new `hint` kind, `EXPLORATION_GRAPH_VERSION` 2 → 3, one state (`active`; p2o has no consumption
  semantics — later planner rounds keep reading all steering), derivation from the lifecycle record, no schema change
  (the tables have no CHECK on `kind`, `src/state/schema.ts:106–130`). Old runs: a writable open repairs the derived
  projection (existing path, `src/state/store.ts:864–900`); a read-only open reports `stale`, and the dashboard does not
  depend on the stored projection because it re-derives in memory (§6.2). Cost: P1, ledger-to-graph tests, one extra
  `byKind` key on the model-visible board JSON (§6.5).
- **G2 — per-node priority.** Not persisted; transient queue field (`src/engine.ts:7,160–170`) plus suggestion-only
  derivation (`src/priority.ts`). **Owner chose "not recorded" (Q6).** The client shows a muted "priority: not recorded"
  chip on goals/intents and the source of the statement in the legend; it never computes a ranking at render time.
- **G3 — cross-run findings.** ARTEX aggregates in one database across tasks; p2o writes one ledger per run and one
  report bundle per finished run. **Owner chose cross-run now (Q3)**; the source of truth is the combination the owner
  chose (D2): retained run stores (all case states, newest sequence) + `findings.json` from report bundles (accepted-current,
  survives ephemeral-store cleanup, integrity-checked against `report-manifest.json` sha256). Merge rules and conflict
  display are specified in §6.2. The opt-in project-knowledge DB remains what it is (suggested context) and is not the
  dashboard's source.
- **G4 — ARTEX's nine triage states.** Deliberate non-goal, unchanged: p2o's evidence model is review status + verdict +
  remediation status + retest verdict, each attributed and separately staleable. The client shows those, with a legend
  mapping; it does not introduce a triage state machine.
- **G5 — live push.** Deliberate non-goal: the service is pull-based; "live" means the server re-reads committed records
  and the client polls (interval in §8), not a pushed stream. This is the honest meaning of "live" for a ledger that the
  Pi process writes.

## 5. (C) The README constraint, the two paths, and the owner's choice

### 5.1 What the line says, and what it has always meant in the code

`README.md:5–6`: "…each worker investigates one bounded intent through a host broker, and the result is a deterministic
evidence report. **There is no hidden planner model, no provider harness and no dashboard.**" The line names three
things the product deliberately does not add: a hidden model deciding for the planner, an external provider harness, and
a dashboard. It never said the extension may not render text or a full-screen view — and it already does both: a
progress widget (`extensions/p2o/index.ts:1083`) and a full-screen read-only `StateScreen` through `ctx.ui.custom`
(`:491–493`). The operational meaning that survived the code to date is: **no separate dashboard product/service** with
its own process, storage, listener and lifecycle.

### 5.2 Path (a) — the chosen path: rewrite the line and build a standalone read-only dashboard

What it buys: an ARTEX-like browser app — layered graph with pan/zoom/minimap, cross-run findings screen with filters
and report-level evidence detail — usable while the run is live and after it finished, shareable with a reviewer outside
the terminal.

What it costs (C/I), and how this plan pays each cost:

- **A listener.** A new HTTP server process. Mitigation: loopback-bound by default, GET/HEAD-only, a per-launch bearer
  token on data/API routes (no persistent accounts, no cookies), no write endpoints, no execution authority, no model
  calls, no external network from the browser; the complete control list is §6.3's table. It is a new failure mode
  (port conflict, stale process, browser tab left open), documented in `docs/USAGE.md` in P3.
- **A data path.** Two read-only sources: retained `assessment.sqlite` stores opened read-only with `PRAGMA query_only`
  (the store already enforces read-only semantics: `AssessmentStore.open(..., {readOnly:true})`
  `src/state/store.ts:180`, `query_only=ON` in `connect`), and report bundles. No new database, no migration, no
  aggregate index. The read model re-derives the exploration graph in memory from committed records, so it never
  depends on the persisted projection being fresh.
- **A frontend build.** A standalone Next.js project (`dashboard/`), build-time only, pinned, with its own lockfile.
  The extension keeps zero runtime dependencies: the server serves already-built static assets; Next is not installed
  for the operator unless they build the UI.
- **Browser-side risk.** Target-derived text is rendered in a browser. Mitigations: React's default escaping; a static
  ban on `dangerouslySetInnerHTML` (checked by a source test, §7); no external URLs/fonts/CDNs; a strict
  `Content-Security-Policy` (`default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'`); every
  evidence string carries the report's "redacted best effort, may contain target data" banner and the view is read-only.
- **A mission-line rewrite.** §5.5 gives the exact sentence; it is a product-boundary statement, not a footnote.
- **Verification surface.** New tests: read model, aggregation/merge, server access control, projection v3, artifact
  route, escaping/static bans, docs/command contracts (§7). Browser E2E is a documented manual checklist in P2–P4;
  adding Playwright later is a separate decision.

### 5.3 Path (b) — the rejected path (v3's recommendation)

v3 proposed four in-Pi surfaces only: a text exploration map, a `ctx.ui.custom` TUI overlay graph, a static
self-contained HTML snapshot, and a findings text/HTML view — no listener, no DB, no separate process. It would have
been cheaper to verify and kept the mission line literally true. The owner rejected it (Q1/Q2) because the ask is a
browser UI like ARTEX's, shareable outside the terminal. It is recorded here as the fallback if the listener scope
proves unacceptable after P2/P3: the read model (§6.2) is reusable by a static HTML renderer, so a retreat costs the
client/server work, not the data work.

### 5.4 Recommendation history and the decision, recorded honestly

v3's §4.4 recommended (b). The owner answered the decision list directly and chose (a) plus a rewritten line. This
document does not relitigate that choice; it records it and plans it. The consequence is accepted explicitly: the
"no dashboard" claim in README.md:5–6 will be **replaced**, not reinterpreted, and the replacement claims are the ones
the code must keep true (§5.5). If the owner later reverses, the fallback in §5.3 applies.

### 5.5 The mission-line replacement (approved, lands with P2)

Current sentence (`README.md:5–6`):

> There is no hidden planner model, no provider harness and no dashboard.

Approved replacement (owner decision m1, 2026-11-03), dropping the now-false clause and describing what exists instead:

> There is no hidden planner model and no provider harness. An optional local, read-only dashboard renders committed
> records and holds no execution authority.

What this commits the code to (all are design constraints in §6.3/§6.4, not aspirations): loopback-only by default plus
a per-launch token on data routes; read-only store opens; no write endpoint; no control route; no model call from the
dashboard path; no target operation; the view's own UI states "derived projection, not evidence/authority" and
"redacted best effort, may contain target data". The approved sentence claims less than the implementation enforces,
which is the safe direction: the extra rules (no edit, no model call, no pause/stop control) are still built and
documented. The edit is made in the same change as the first runnable viewer (P2) so the README never describes a
surface that does not exist, and it is the only README sentence that changes in this programme unless the dashboard's
install/development section is added (P2, README Development).

## 6. (D) Phased implementation plan for path (a)

### 6.1 Architecture

```
state roots (.p2o-state/<runId>/assessment.sqlite) ─┐  read-only, node:sqlite via AssessmentStore.open
                                                    ├─► src/dashboard/read-model.ts ─► data tree (JSON)
report roots (.p2o-reports/report-<runId>/) ────────┘        │
                                                              ├─ live: node:http server (loopback, GET/HEAD)
                                                              │   serves /dashboard/out (Next static export) + /data/*.json
                                                              └─ frozen: /p2o map --out writes the same tree to an
                                                                  absolute new directory; same server serves it in
                                                                  --snapshot mode (or any static file server)
```

Three components, in dependency order:

1. **Read model — in-repo TypeScript (`src/dashboard/`), no new runtime dependency.** Deterministic, bounded, read-only,
   testable with fixtures. Produces the JSON data tree described in §6.2.
2. **Server — in-repo TypeScript (`src/dashboard/server.ts` + `src/dashboard/main.ts`), `node:http`.** Loopback,
   GET/HEAD-only, read-only, serves the client assets and generates the data tree on demand (live) or from disk
   (frozen). Exposes no write route. §6.3.
3. **Client — Next.js workspace project (`dashboard/`).** App-router pages compiled with `output: 'export'` to static
   assets. Build-time only. §6.4.

Reused machinery is deliberately large; new code is deliberately thin:

| Concern | Reused (file:line) | New |
|---|---|---|
| Exploration graph derivation | `deriveExploration` (`src/exploration-graph.ts:568`), `RecordedRow:91`, `ExplorationOrigin:93`, `explorationDelta:286` (cross-check only) | read-only in-memory derivation wrapper (`src/dashboard/read-model.ts`) — no store write path |
| Run discovery / privacy checks | `PrivateDirectory` ownership+mode check (`src/state/files.ts:11,15`), `validId` (`src/validate.ts`), read-only reopen precedent (`src/state/inherit.ts:200–215`) | root scan, mtime/sequence cache, symlink rejection |
| Store reads | `AssessmentStore.open(..., {readOnly:true})` (`src/state/store.ts:180`), `manifest():222`, `sequence():289`, `records():481`, `health():290`, `outcome():246`, `artifacts():639`, `artifact():665` | per-run summary and bounded body reads |
| Report projection (findings) | `renderReport` (`src/report-export.ts:689`), `findingFiles` (`:396`), `findingIdentityFor` (`:342`), `CASE_ROWS`/`FINDINGS_FORMAT_VERSION` (`:43–44`), report manifest (`:922`), extension builder `renderStoreReport` (`extensions/p2o/index.ts:2036`) | extraction of the builder into `src/store-report.ts` so the extension and dashboard share it (P1, behaviour-preserving) |
| Cases | `caseViews` (`src/cases.ts:122`), `caseRatings` (`:114`), `CaseView` (`:33`), `case-types.ts:21–47` | full-case (not only accepted) projection for retained stores |
| Export path rule | `bundlePath` (`src/state/bundle.ts:25`), `/p2o export` quote/absolute-path handling (`src/ui/workspace.ts:44–45`) | `/p2o map --out <abs-dir>` parse + help line |
| Human command shell | `/p2o` parser/help (`extensions/p2o/index.ts:136–148`), `showState` notices (`:491–493`) | `map` command dispatch |
| Projection v3 (`hint`) | version/state/derivation machinery (`src/exploration-graph.ts:23–42,286,568`), repair/stale path (`src/state/store.ts:864–900`), store commit indexing | one kind, one state, one delta branch, node text |
| Server skeleton | — (the only server today is a `node:net` control socket, `src/broker.ts:1,288–292`) | `node:http` server, static serving, data routes, security guards |
| Client | ARTEX's screen structure and layout/fold ideas (`exploration-graph.tsx:97,141,194`, `findings-table.tsx:146–164`, findings page `754–761,907–930`) | Next.js app, SVG graph canvas, findings table/detail |

### 6.2 Read model specification (`src/dashboard/`)

**Inputs and discovery (C).**

- Default roots: `<workspace>/.p2o-state` for stores (the default `stateRoot`, `extensions/p2o/index.ts:393`) and
  `<workspace>/.p2o-reports` for report bundles (default report root, `extensions/p2o/index.ts:2172–2173`). Both are
  overridable by repeated `--state-root` / `--report-root` arguments; the standalone entry and `/p2o map` share the
  parser.
- Store scan: a run is a directory whose name passes `validId` and contains `assessment.sqlite`; open with
  `AssessmentStore.open(root, runId, { readOnly: true })` so the existing ownership/mode/schema/journal read-only checks
  apply (`src/state/files.ts:15`, `src/state/store.ts:196–214`). Symlinks are refused; non-regular files are ignored;
  a store that cannot open is reported in `warnings[]` (reason, path), never silently dropped. Incompatible schema
  version → warning row, not read.
- Report scan: a bundle is a directory containing `report-manifest.json` (**format `p2o-report`**). `runId` comes from
  the manifest (user-named export directories are allowed, so directory-name matching is not enough); `findings.json`
  is verified against the manifest's `files[].sha256`/`bytes` before parsing (`sha256Hex`, `src/validate.ts`). A
  corrupt/tampered file is reported and skipped.
- Limits (defaults, recorded in `limits` when truncated): 200 runs scanned, 500 cases per retained run (the report's
  `CASE_ROWS`), 8 MiB serialized data tree per run, a 64 MiB snapshot cap including the copied artifact bodies, at most
  64 artifact bodies per run and 1 MiB per body (long bodies are truncated with an explicit flag plus the sha256 of the
  bytes actually copied), per-run read timeout, per-root directory cap. Every truncation is an explicit
  `omitted`/`warnings` entry — a short page is never presented as a complete one.

**Per-run graph.** The dashboard must not depend on the persisted projection being current (it can be stale after the
v3 bump and is absent in older stores), so it re-derives in memory:

1. `const records = store.records()` and `const origin = { runId, targetKind, targetIdentityHash: sha256Hex(targetIdentity),
   targetDisplay, mode? }` — the same construction the store's private `explorationOrigin` performs
   (`src/state/store.ts:734–738`; the read model builds it from `manifest()` rather than reaching into the class).
   Implementation note: add a small read-only store accessor (for example `derivedExploration(asOfSequence?)`) that
   assembles `RecordedRow[]` and calls `deriveExploration`, so the derivation input lives in one place and the
   read-only invariant is enforced by the store class. The existing `explorationSnapshot()`/`rebuildExploration()`
   stay untouched.
2. `deriveExploration({ records, origin })` → nodes/edges/anchors/unresolved/overflow, plus `EXPLORATION_PROJECTION_LABEL`
   in the payload. Display text uses `explorationNodeText` (`:608`); bodies are trimmed to the contract's display cap
   (suggested 600 chars) with `bodyOmitted: true` when trimmed, because a full 4000×8 KiB body dump is not a web payload.
3. `asOfSequence` is the store's current sequence; a run that is actively written is read at that sequence and marked
   `live: true` (polling re-reads).

**Per-run findings (two scopes, both honest).**

- **Accepted findings (report parity).** Build the same projection the report uses by calling the extracted
  `buildStoreReport(store, records, extra)` (`src/store-report.ts`, produced by moving the body of
  `extensions/p2o/index.ts:2036–2170` without behaviour change) and taking the `findings.json` body; parse and attach
  provenance. This guarantees the dashboard cannot disagree with `REPORT.md`/`findings.json` about an accepted case.
- **All cases (retained stores only).** `caseViews(indexRecords(records, runId), context)` gives every case with
  verdict/review/currentness/remediation/rating/retest and evidence refs. Detail uses the bounded reproduction builder
  shared with `findingFiles` (extract the `reproduce()` logic in P1 alongside `buildStoreReport`), so input/output
  lengths and artifact metadata follow the report's bounds. Pending/disputed/stale cases are shown as such; the report's
  accepted-only rule is not weakened for the report.
- Report bundles carry accepted-current findings only (by design); the UI labels this scope difference rather than
  pretending report-only runs have all cases.

**Cross-run aggregation rules (G3 resolution).**

| Rule | Definition |
|---|---|
| Identity | `findingId` from the host derivation (`findingIdentityFor`, `src/report-export.ts:342`: target scope + policyKey + rootCauseKey + resolved assets). Fallback when absent (unresolved asset ids): `(targetNormalized, policyKey, rootCauseKey, titleNormalized)`. The report states when an id is run-scoped; the UI repeats it. |
| Occurrence | One row per (run, finding): runId, source (`store` | `report`), retention, asOfSequence/retrievedAt, severity, verdict, reviewStatus, currentness, accepted, remediation status, retest verdict, case id/revision, time. |
| Aggregate | First/last seen, run count, `runs[]`, worst severity by the ordered set critical > high > medium > low > informational > not-rated, status sets, accepted count, latest occurrence. |
| Conflict | Same identity but divergent severity/title/root cause across occurrences → `conflicts[]` on the aggregate; the UI shows each value with its run and never silently picks one. |
| Deduplication | Occurrences from a store and a report bundle for the same `runId` are not duplicated: the store occurrence wins when its sequence ≥ report `asOfSequence`; otherwise both are kept with `both` provenance and any divergence is a warning. |
| Scope labelling | `source: 'store'` rows show all case states; `source: 'report'` rows show accepted-current only; report-only runs (ephemeral store cleaned) are marked `retention: ephemeral, store: gone`. |

**Data tree contract (deterministic, versioned; JSON only, no HTML).**

```
index.json
  format: 'p2o-dashboard', version: 1
  generatedAt            // latest committed record time, never a wall clock
  labels                 // projection label + redaction caveat + "not evidence/authority"
  runs[]                 // runId, target, retention, mode, startedAt, lastRecordAt, sequence, schemaVersion,
                         // graphVersion, complete/outcome, live, counts {nodes, edges, anchors, cases, findings},
                         // source (store|report|both), warnings[]
  findings[]             // aggregated rows per the rules above (bounded; omitted counts)
  totals                 // run count, finding count, severity counts, runs involved, accepted count
  limits/warnings[]      // truncations and skipped inputs, each with a reason
runs/<runId>.json
  run                    // same summary as index
  graph                  // nodes[{id,kind,state,text,body?,bodyOmitted?,inherited?,recordId?}],
                         // edges[{srcId,rel,dstId,inherited?}], anchors, unresolved, overflow, chainOrderTruncated
  cases[]                // retained stores only: CaseView-level rows + bounded reproduction detail
  findings[]             // accepted findings for this run (report parity)
  artifacts[]            // snapshot mode: copies of cited, bounded, redacted artifact bodies
                         // {artifactId, bytes, sha256, truncated, file}
```

The server serves these paths live; the export writes the same tree to disk. In snapshot mode the export also writes
`artifacts/<runId>/<artifactId>.txt` for the bounded, redacted artifact bodies cited by the served findings (owner
decision m4), and the frozen server serves the same `/api/artifact` route from those files, so the client's evidence
control works offline. The client does not know which mode it is in.

### 6.3 Server specification (`src/dashboard/server.ts`, `src/dashboard/main.ts`)

- **Binding and exposure.** Loopback only: the server binds `127.0.0.1` (no `--host` in P1–P4; LAN sharing is P5 scope,
  §8.2). The port is chosen by the operator (`--port 0` prints the ephemeral port). From P3 every data/API route
  requires the per-launch bearer token (owner decision m5); static client assets are not secret and may be served
  without it.
- **Routes (all GET/HEAD; anything else returns 405).**
  - `GET /`, `/graph/`, `/findings/`, and `/_next/*` → static assets from the built client (`dashboard/out`), served
    with an explicit content-type allowlist (`text/html`, `text/css`, `text/javascript`, `application/javascript`,
    `application/json`, `image/svg+xml`, `image/png`, `font/woff2`) and no directory listing. Non-existent or
    non-file paths → 404.
  - `GET /index.json`, `/runs/<runId>.json`, `/runs/<runId>/cases/<caseId>.json` (bounded detail) — generated from the
    read model in live mode, read from the snapshot tree in frozen mode. The routes are deliberately file-shaped so the
    static export is the same tree.
  - `GET /api/artifact?run=<runId>&id=<artifactId>&offset=<n>` — serves a retained, redacted artifact body chunk for an
    evidence ref that appears in the served findings. Live mode reads the store (`artifact(id, offset, length)`,
    `src/state/store.ts:665`, 16 KiB default) with a response cap; frozen mode serves the copied body file from the
    snapshot (`artifacts/<runId>/<artifactId>.txt`). Refuses ids not cited by a served case. Owner decision m4: both
    modes expose the bodies, bounded and labelled; the snapshot carries the copies. Requires the token like every other
    data route.
- **Read-only invariants.** Every store is opened with `{readOnly: true}`; the server never calls a store mutation;
  it never opens `writer.lock` for writing; it never creates, upgrades or repairs a store. A per-request assertion
  `store.readOnly === true` guards accidental misuse.
- **Caching and freshness.** Data generation is cached per (root set, runId, sequence, schemaVersion, file
  mtime/size). Default poll: client fetches `index.json` every 5 s (or the operator's `--refresh` value) and the
  focused run's file on change; the server regenerates only what changed. A run being written can hit
  `SQLITE_BUSY` (the store uses `busy_timeout=0`); the server retries a bounded number of times and marks the run
  `busy` with a warning instead of failing the whole view.
- **Security controls.** Loopback bind; GET/HEAD only; bearer token on data/API routes; no cookies or persistent
  sessions; no CORS headers (same-origin only, so another local web page cannot read responses even when it can attempt
  requests); `Cache-Control: no-store` for data, immutable for hashed `_next` assets; `Content-Security-Policy` as in
  §5.2 plus `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; strict path handling driven by a path→asset
  map, never by concatenating user input into a filesystem path; snapshot directory symlinks refused; response size
  caps; request URLs logged only as paths, never with the token or query values.
- **Authentication (m5).** The token is a launch-time secret: `main.ts serve` generates 32 random bytes, prints the URL
  with the token in the fragment (not the query string, so it is not in request lines or access logs) and the client
  keeps it in memory and sends it as an `Authorization: Bearer` header on every fetch. Missing or invalid token → 401
  with no data body. The token is not persisted, rotates every launch, and is compared in constant time; `--print-token`
  is deliberately not offered because the operator already has the terminal. Static assets stay public: they contain no
  run data.
- **No authority.** No write route, no control route (pause/stop/dispatch are not exposed), no model call, no target
  operation, no shell. The server reads committed records and serves files.

### 6.4 Client specification (`dashboard/`, Next.js)

- **Project shape (workspace).** Under owner decision m2 the repo becomes an npm workspace: the root `package.json`
  gains `"workspaces": ["dashboard"]`, the dashboard's dependencies (`next`, `react`, `react-dom`, `typescript`,
  `@types/*`) live in `dashboard/package.json`, and the single root `package-lock.json` installs both trees.
  `dashboard/` holds `next.config.mjs` (`output: 'export'`, `images.unoptimized: true`, `trailingSlash: true`),
  `app/**` (layout, overview, graph, findings pages), `components/**`, `lib/**` (fetch helpers, layout, filters,
  formatting), `test/**` (its own vitest for pure layout/filter logic) and `vitest.config.ts`. Build:
  `npm run dashboard:build` (wraps `npm run build --workspace dashboard`) → `dashboard/out`. Root `npm test` does not
  build the dashboard (§6.9).
- **Routing compatible with static export.** Pages: `/` (index: runs, totals, recent findings, warnings), `/graph/?run=<runId>`
  (graph canvas; `node=<nodeId>` opens the detail), `/findings/` (cross-run table; filter/sort/paging via query params),
  `/findings/?id=<findingId>` (detail), `/cases/?run=<runId>&id=<caseId>` (retained-store case detail if expanded beyond
  the findings detail). No dynamic segments, no server-side rendering, no `next start`; the client fetches `index.json`
  and per-run files relative to itself.
- **Graph screen (parity with §3.1, built from p2o vocabulary).**
  - Deterministic layered layout computed client-side: column 0 hint/origin, column 1 goals, column 2 links/intents,
    column 3 facts/findings; digest nodes folded by default into a super-node that rewires `covers` edges (toggle to
    expand); inherited rows drawn distinctly and labelled with their source run.
  - Node cards: kind icon + label (origin → "start"), deterministic id, one-line text from `explorationNodeText`, state
    chip mapped through the legend table (§4.5 note), `priority: not recorded` chip on goals/intents (G2); hint nodes
    rendered with the steering kind (`hint`/`constraint`) and their text.
  - Edges: relation colour + label mapping (spawns/派生, derived_from/意图链, yields/产出, proves/证明; `covers` not
    drawn except as digest membership; `leads_to` drawn as p2o's chain order).
  - Interaction: wheel/buttons zoom, drag pan, fit-to-screen, minimap, node select → detail panel (text/body excerpt,
    state, kind, record pointer, incoming/outgoing relations with labels, inherited provenance), digest toggle,
    filter by kind/state, "showing X of Y" counter with unresolved/overflow/inherited warnings.
  - The canvas is a viewport over a bounded window (suggested 400 rendered nodes, one run at a time); larger runs show
    the counter and a focus control. A 4000-node canvas is not a use case.
- **Findings screen (parity with §3.2 plus p2o honesty).**
  - Tiles from countable facts: runs involved, total findings, accepted-current, pending review, severity counts
    (critical/high/medium/low/informational + "not rated" separately), stale count, conflict count. No tile is copied
    from the ARTEX screenshot unless p2o can count it.
  - Filters: severity, review status, verdict, currentness, source (store/report), run, target, free-text over title
    (client-side, bounded list); sort by severity/time/run; pagination with explicit totals.
  - Table columns: severity · title · policy/root-cause/CWE · verdict/review status · currentness · assets · runs ·
    source · time; expandable rows; retained-store cases show review/remediation layers, report-only findings say
    "accepted-current from report".
  - Detail: the report's finding block at full detail (D4) — basis, likelihood, impact, limitations, CVSS vector +
    computed score, CWE, WSTG keys/pages, ATT&CK techniques, reproduction steps with role/note/operation/by/exit/input/
    output/captures (bounded strings exactly as `findings.json`), retest block, evidence version/traffic citations,
    remediation, references, chain, contradictions/independence flags, occurrence provenance (run, retention,
    asOfSequence, report path, conflict list).
  - Evidence actions: "show retained artifact" loads an artifact body chunk through `/api/artifact` in both modes — live
    from the store, frozen from the snapshot copy (owner decision m4) — bounded, redacted best effort, with its own
    "do not publish" label. The snapshot's copied bodies carry bytes/sha256/truncated metadata so the UI can state
    exactly what it is not showing.
- **Renderer safety.** React escaping only; no `dangerouslySetInnerHTML` anywhere (source-checked); no Markdown→HTML
  rendering of target text in P1–P4 (report prose stays in the report; the dashboard renders fields as text); no
  external URLs/fonts/CDNs/telemetry; system font stack; all assets local; client-side CSV/JSON export of the
  aggregated view (P3) generated in memory from the same bounded data.
- **Honesty banners.** Every page carries the run/provenance header and the two labels: the projection label
  (`src/exploration-graph.ts:587`) and the report's redaction caveat ("best effort; may contain target data — do not
  publish"). Priority absence and scope differences are explained inline, not hidden.

### 6.5 Projection v3 — `hint` node kind (owner Q5)

- **Data (C).** `p2o_loop action=hint|constrain` commits one `lifecycle` record with `text: "operator hint: …"` and
  `data.steering = { kind: 'hint' | 'constraint', text }` (`extensions/p2o/index.ts:4280–4296`), capped at 24 hints /
  12 constraints per run, text 3–300 chars, deduplicated. It is read back for prompts by `steeringFacts`
  (`:1931–1940`). Nothing in the projection reads it today.
- **Rule (design, to be implemented in P1).** For every committed `lifecycle` record whose `data.steering` has a
  `kind` in the closed set and a non-empty text, derive one node: `kind: 'hint'`, deterministic id
  (`explorationNodeId('hint', runId, recordId)`), `state: 'active'` (p2o has no consumption marker; steering remains
  read by every later planner round, so "active" is the faithful state), body
  `{ steeringKind: 'hint' | 'constraint', text: bounded 300, sequence, recordId }`. No edges are derived: steering is
  guidance to the planner loop, not lineage, and inventing an edge would misstate the record.
- **Version and repair.** `EXPLORATION_GRAPH_VERSION` 2 → 3 (`src/exploration-graph.ts:23`) so a writable open of an
  older store re-derives the projection once (`src/state/store.ts:864–900`), and a read-only open reports `stale` as
  today. The dashboard does not depend on the stored projection (it re-derives), so it shows hints on old runs
  immediately; the board/lineage text reads of an old run keep the existing stale line until repaired by a writable
  open (unchanged semantics, documented in `docs/KNOWLEDGE.md` in P1).
- **Surfaces that must change with the kind.** `EXPLORATION_NODE_KINDS`/`EXPLORATION_STATES` (`:24,34`), the
  `explorationDelta` lifecycle branch (`:286` region), `explorationNodeText` (`:608`), the store's commit-path
  indexing (`src/state/store.ts` exploration index), and any test or board output that enumerates kinds. The
  model-visible `p2o_board board=graph` overview JSON gains `counts.byKind.hint` automatically because
  `explorationOverview` maps over the kinds list (`:648–652`); that is one small key and does not add rows or exceed the
  existing view byte bound. Under decision m7 the key appears, but the board text gains no `Hints:` line; adding
  one later would be its own decision.
- **No schema change.** The exploration tables have no CHECK constraint on `kind`/`state` (`src/state/schema.ts:106–130`),
  and the schema version stays 8. Only the derived-projection version changes.

### 6.6 Mission line and documentation changes

| Change | When | Why |
|---|---|---|
| README.md:5–6 replacement (§5.5) | P2 (same change as the first runnable viewer) | The line must become true when, and only when, the viewer exists. |
| README Development: dashboard build/serve commands | P2 | A second toolchain must be documented where build/test commands already live. |
| docs/USAGE.md: `/p2o map --out <abs-dir>` and standalone `serve`/`snapshot` commands, ports, loopback rule, redaction caveat | P2/P3 | The human command and the service are operator-facing; `help-commands.test.ts` requires the help text and USAGE to agree. |
| docs/ARCHITECTURE.md: read model → server → client, read-only/no-authority rule, data contract version | P2 | The repo's component doc must name the new component and its boundary. |
| docs/KNOWLEDGE.md: projection version 3 / `hint` semantics and stale/repair | P1 | The projection is a knowledge-workspace surface. |
| docs/EVIDENCE.md: dashboard displays report evidence; snapshots carry redacted artifact copies | P3 | Evidence handling is described there today; m4 makes the snapshot itself an evidence copy. |
| docs/ACCEPTANCE_MATRIX.md rows for the dashboard programme | P4 (decided, m8) | Keeps the feature tracked where acceptance is tracked. |
| AGENTS.md `dashboard:build`/`dashboard:test` line | P2 (decided, m8; owner sees the diff in the phase change) | The hand-maintained build/test section must name the workspace scripts. |
| docs/HISTORY.md entry: product boundary changed (local read-only dashboard added) | P2/P4 (decided, m8) | A boundary change is worth one historical line, not silence. |

### 6.7 Phases

Each phase is independently reviewable, has its own tests and docs, and ends with the full `npm test` green. "Exit gate"
is what makes the phase reviewable; nothing is committed or pushed without a fresh owner instruction.

#### P1 — Read model + projection v3 (no UI)

Goal: a deterministic, bounded, read-only JSON data plane that P2/P3 consume, and the `hint` projection addition.

Deliverables:

- Extract the report builder from `extensions/p2o/index.ts:2036` into `src/store-report.ts` as
  `buildStoreReport(store, records, extra)` returning `{ rendered, index, manifest }`; the extension's
  `renderStoreReport` becomes a thin wrapper. Behaviour-preserving: the report suites must produce identical bytes.
  Extract the bounded reproduction builder so both `findings.json` and dashboard case detail share it.
- `src/dashboard/contract.ts` — types + `DASHBOARD_FORMAT_VERSION = 1` (pure; no I/O).
- `src/dashboard/read-model.ts` — discovery, per-run derivation (in-memory exploration from records; shared report
  projection; full case rows for retained stores), cross-run aggregation/merge/conflict rules (§6.2), bounds/warnings,
  deterministic ordering (sequence then id; never object iteration order).
- Small read-only store accessor for derived exploration (e.g. `derivedExploration(asOfSequence?)`), implemented by
  assembling `RecordedRow[]` and calling `deriveExploration`; no change to `explorationSnapshot()`.
- Projection v3 (`hint`): constants, state, delta branch, node text, version bump, store commit-path indexing; store
  rebuild path already re-derives.
- `src/dashboard/main.ts` — standalone entry with `snapshot --out <abs-new-dir> [--state-root ...] [--report-root ...]`,
  writing the data tree only (no client assets yet); prints the absolute path and a one-line summary (runs, findings,
  omissions). No server yet.
- Tests: `tests/minimal/dashboard-read-model.test.ts` (fixtures: empty root, one run, mixed runs, report-only run,
  corrupted report hash, conflicting severity, duplicate store+report occurrence, truncation bounds), plus
  `tests/minimal/dashboard-snapshot.test.ts` (deterministic bytes for a fixture, new-directory-only, absolute path
  validation), plus projection/ledger tests for `hint`.
- Docs: `docs/KNOWLEDGE.md` projection v3; no README mission-line change yet.

Exit gate: read model and snapshot are deterministic byte-for-byte across two runs on the same fixtures; no store is
opened writable (asserted); report bytes unchanged; v3 hint derivation equals a rebuild-then-diff oracle; all existing
projection tests updated and green.

P1 as built (implementation notes):

- **The extraction is real.** `src/store-report.ts` holds `buildStoreReport(store, records, extra)` — the whole former
  `renderStoreReport` body, synchronous — and `extra` carries only what committed state cannot: the operator `settings`
  (`reportFormat`/`report` labels), optional live `owner` facts (workers/engine), `runtimeVersion`, pre-resolved
  `wstgPages` and the export options. The extension's `renderStoreReport` is now a five-line wrapper that resolves the
  store-bound ledger, the skill catalog and the operator settings. `findingReproduction()` moved the bounded reproduction
  rows out of `findingFiles`, so `findings.json` and the dashboard case rows share one builder. The report suites
  (`report-export`, `report-auto`, `report-assets`, `reporting-policy`) pass unchanged, byte-identity tests included.
- **Store accessor.** `AssessmentStore.derivedExploration(asOfSequence)` assembles `RecordedRow[]` from `records` and calls
  `deriveExploration`; it writes nothing and is the read model's only new store path. `explorationSnapshot()` and
  `rebuildExploration()` are untouched.
- **Read-model deviations from the sketch**, each for determinism or portability: `index.json` warnings are
  `{code, detail, runId?, file?}` and never carry an absolute filesystem path (a frozen snapshot may be shared);
  a run file sets `graph.graphVersion: 0` when its source carries no derivation (report-only bundle) instead of claiming
  an empty graph from the current version; report bundles record no target, retention or time, so those summary fields are
  `null`/`unknown` and the run is labelled report-only; the per-run data-tree bound drops detail in a fixed order (node
  bodies and reproduction rows, then case rows, then graph rows, then finding rows) and every drop is written to `omitted`
  and a warning. Cross-run identity is the host finding id (32 hex, `FINDING_ID_PATTERN`) with the documented fallback;
  store-vs-report dedupe keeps the store row unless the bundle's barrier is later.
- **Scope kept.** P1 writes no client assets (P2) and no artifact copies (P3/m4); `artifacts: []` is present so the tree
  shape does not change then. `counts.byKind.hint` appears automatically on `p2o_board board=graph` (m7) with no new
  board line.
- **Built entry path** is `dist/src/dashboard/main.js` (the build keeps the `src/` prefix under `rootDir: "."`); the m3
  wording and §6.3/§6.7 references are corrected to that path.
- **Tests.** `dashboard-read-model.test.ts` (discovery, store projection + hint rows, report parity, report-only scope,
  store/report dedupe, tampered hash, format-1 bundle, conflicts, fallback identity, finding cap, no-write assertion),
  `dashboard-snapshot.test.ts` (byte-identical trees, new-directory-only, absolute-path refusal, snapshot cap, CLI parser
  and end-to-end entry), plus the v3 `hint` cases in `exploration-graph.test.ts`. Full `npm test` result recorded in §9.

#### P2 — Next.js client shell + graph screen + export mode + mission line

Goal: the first runnable viewer, from a snapshot directory, including the rewritten mission line.

Deliverables:

- `dashboard/` Next.js project installed through the new npm workspace (pinned deps, app router, static export
  config), shell with dataset header/labels/warnings, overview page, graph page with the §6.4 interactions, node detail
  panel, digest folding, priority "not recorded", hint nodes, inherited styling, unresolved/overflow counters.
- Client-side layout/filter logic in `dashboard/lib/` with its own vitest; no `dangerouslySetInnerHTML`; no external
  URLs (the static source-intake test listed in §7 starts here and is completed in P3).
- Export mode wiring: `src/dashboard/main.ts snapshot --out <abs-new-dir>` copies the built client assets and writes the
  data tree; frozen serving via `src/dashboard/server.ts --snapshot <dir>` (thin static-file mode, no live reads and no
  token yet — the m5 token gate lands in P3) so the operator can open the UI without any file-serving assumption. The
  directory is zip-able as it stands (m6).
- README.md:5–6 mission-line replacement (§5.5) and README Development commands; docs/USAGE.md sections; help line for
  the command when the `/p2o map --out` wrapper lands (the wrapper itself is P3; P2's user path is the standalone
  `node dist/src/dashboard/main.js snapshot` command, documented in USAGE).
- Tests: `tests/minimal/dashboard-export.test.ts` (snapshot tree shape, client assets present, no overwrite, size cap),
  workspace build/typecheck of the client, `dashboard` project tests for layout determinism and filter logic; a
  checklist for manual browser verification (open the frozen snapshot, pan/zoom, fold digest, open detail).
- Mission-line edit lands here, with the README sentence and the USAGE/ARCHITECTURE text that make it true.

Exit gate: a frozen snapshot built from a fixture store opens in a browser (`serve --snapshot`), shows the graph with the
documented interactions, contains no external URL, and the README's new sentence is accurate against the shipped
behaviour.

P2 as built (implementation notes):

- **Workspace (m2).** The root `package.json` gains `"workspaces": ["dashboard"]`; `dashboard/package.json` pins
  `next@16.4.4`, `react`/`react-dom@19.3.1`, `@types/react`/`@types/react-dom@19.3.0`, `typescript@^5.9.3`, `vitest@^3.2.7`,
  and the single root `package-lock.json` installs both trees. `dashboard/out`, `dashboard/.next` and `*.tsbuildinfo` are
  ignored; `files` is unchanged (§8.2). New root scripts: `dashboard:build`, `dashboard:test`, `dashboard:serve`. Root
  `npm test` still does not build the dashboard. Next telemetry is disabled twice (the build script exports
  `NEXT_TELEMETRY_DISABLED=1` and `next.config.mjs` sets it before loading), because a build that phones home would be the
  external call the design says the surface does not make.
- **Client (`dashboard/`, Next 16 app router).** `output: 'export'` + `trailingSlash`; pages `/` (overview) and `/graph/`
  (graph). All data access is `fetch('/index.json')` / `fetch('/runs/<runId>.json')` through `lib/use-json.ts` — relative
  only, `cache: 'no-store'`. Every link is a plain anchor, so navigation is full-page and the artifact needs no router
  request; the RSC payload files the export emits are still shipped and served as `text/plain`. React renders every
  committed value as text; there is no `dangerouslySetInnerHTML` anywhere.
- **Graph screen.** Deterministic layered layout (`lib/layout.ts`, pure and unit-tested): guidance/start → goals → links and
  intents → facts and findings → digests. Digest rows fold by default into one super-node carrying the digest and covered-row
  counts; unfolding draws the rows and their `covers` edges (dashed, labelled in the legend). Kind and state filters, a
  two-hop focus window, a hard 400-node page with "showing X of Y" plus filter/bounds/folded counters, inherited rows dashed
  and labelled with their source run, hint cards with the steering text from the projection, `priority: not recorded` printed
  on goal/intent cards (no value invented), pan/zoom/fit/minimap, a node detail panel with body, relations and asset anchors.
  Toolbar/counter and the honesty labels ("derived projection…", "redacted best effort…") travel with every page. The
  findings screen with report-level evidence is P3, so the overview page lists runs, totals, the severity ledger and
  warnings only.
- **Contract mirror.** The client cannot import the extension's module graph, so `dashboard/lib/model.ts` mirrors the subset
  of `src/dashboard/contract.ts` it consumes. Drift is caught in the root suite: `tests/minimal/dashboard-export.test.ts`
  assigns the host's real `index.json` and run-file values to the mirror types (a renamed/dropped field fails the root
  typecheck) and compares `KIND_ORDER`/`RELATION_ORDER`/`SEVERITY_ORDER` with the host constants.
- **Export wiring.** `snapshot` now requires the built client: default `<cwd>/dashboard/out`, `--client <dir>` to override,
  and a missing directory fails with "run npm run dashboard:build first" (a data-only snapshot was the P1 artifact, not the
  P2 product). The client tree is read into memory, sorted by directory walk, then written under the same root as the data
  tree. Before `mkdir` the writer refuses symlinks, non-regular files, a client file that would shadow `index.json`/`runs/`/
  `artifacts/`, more than 5,000 files, depth beyond 24, and the existing `snapshotBytes` cap; two writes of the same build
  stay byte-identical. The result is one zippable directory (m6) that any static file server or `serve --snapshot` opens.
- **Frozen server.** `src/dashboard/server.ts` binds `127.0.0.1` only, accepts GET/HEAD (405 otherwise), maps a closed
  path set (`/` and directory routes to `index.html`, `/graph` redirects 308 to `/graph/`, `..`/encoded separators/control
  characters/non-allowlisted extensions refused), checks the resolved real path is still under the snapshot root, refuses
  symlinks and non-regular files, sends a fixed content-type allowlist with `nosniff`, `no-referrer`, `frame-ancestors
  'none'`, no CORS and `no-store` for data (`immutable` for hashed `_next/static` assets), and has no write or control
  route. `main.ts` gains `serve --snapshot <dir> [--port 0-65535]`; `--port 0` picks a free port and prints the URL.
- **CSP deviation from §5.2, recorded.** The policy is `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src
  'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none';
  frame-ancestors 'none'`. A static Next export inlines its hydration bootstrap, so a literal `script-src 'self'` would
  block the client; §5.2's example had no `script-src` at all. The compensating controls are the no-injection source test,
  React text rendering, and a `default-src`/`connect-src`/`img-src` set that admits no external origin.
- **Other deviations recorded.** (a) The folded digest super-node is one node whose text states the counts; while folded the
  `covers` edges are suppressed rather than rewired to the super-node (drawing up to 200 membership edges would be noise,
  and the plan's "folded membership" is the compact summary in practice). (b) The first paint fits at a ≥80% floor so card
  text is legible; the `fit` button computes the true whole-graph scale (smaller for wide runs), with pan/minimap and the
  counter covering the difference. (c) Plain anchors instead of `next/link`, and `window.location.search` read in an effect
  instead of `useSearchParams`, so the static export needs no Suspense boundary or router payload.
- **Manual browser verification (the P2 exit gate).** A fixture run (`populate` plus one `p2o_loop action=hint`) was
  snapshotted with the real built client — 31 files, ~709 KB — served by `node dist/src/dashboard/main.js serve --port 0`,
  and opened in headless Chromium at 1440×900: the overview rendered totals, the severity ledger, the run row and warnings;
  the graph rendered 8 nodes / 9 edges at 81% with the hint card text, `priority: not recorded` on goal/intent cards, relation
  colours, minimap and counters; `/`, `/graph/`, `/index.json`, `runs/<runId>.json` and hashed assets answered 200 with the
  expected content types, POST answered 405, encoded traversal 404, a symlink outside the root 404, `/graph` answered 308,
  and the HTML carried no external `src`/`href`. Not automated: pointer zoom/pan, fold toggle and focus via the UI (manual
  checklist), and no Playwright was added (§7).
- **Docs.** README mission line replaced with the §5.5 sentence and the Development commands added; `docs/USAGE.md` gained a
  dashboard section (Vietnamese, matching that file); `docs/ARCHITECTURE.md` gained the component and implementation-map
  rows; `AGENTS.md` names `dashboard:build`/`dashboard:test` (m8); `docs/HISTORY.md` records the product-boundary change.
  `/p2o map` is deliberately not mentioned anywhere: `help-commands.test.ts` fails if README/USAGE documents a `/p2o`
  command the help text does not list, and the wrapper is P3.
- **Tests.** New root `tests/minimal/dashboard-export.test.ts` (8 tests: deterministic tree with the client, no-overwrite and
  missing/shadow/symlink/cap refusals, run-file mirror, frozen-server behaviour and refusals, client source intake, contract
  and vocabulary parity), updated `tests/minimal/dashboard-snapshot.test.ts` (4 tests: writer, cap, CLI end-to-end with
  `--client`, both CLI parsers), plus `dashboard/test/layout.test.ts` (13) and `dashboard/test/format.test.ts` (8) run by
  `npm run dashboard:test`. Gate numbers are in §9.

#### P3 — Findings screen (full evidence) + live service mode + `/p2o map`

Goal: the cross-run findings screen the owner asked for, at report-level evidence detail, against live state, and the
in-Pi wrapper.

Deliverables:

- Findings page (§6.4): tiles, filters, table, expand/detail with full evidence, provenance/conflicts,
  retained-store case detail, client-side CSV/JSON of the aggregated view.
- Snapshot evidence (m4): the export now also copies the bounded, redacted artifact bodies cited by served findings
  into `artifacts/<runId>/` with bytes/sha256/truncated metadata, inside the 64 MiB snapshot cap; the frozen server
  serves them through `/api/artifact`; docs state plainly that the copy is sensitive.
- `src/dashboard/server.ts` live mode: static client serving + `/index.json`, `/runs/<runId>.json`,
  `/runs/<runId>/cases/<caseId>.json`, `/api/artifact`; caching/refresh (client polls every 5 s and has a manual refresh
  button — m3); `SQLITE_BUSY` handling; loopback bind; and the m5 bearer-token gate on every data/API route (401
  without a valid token; token printed in the URL fragment and never logged).
- `/p2o map` human command: `--out <abs-dir>` builds the snapshot via the P1/P2 path and prints the standalone
  `node dist/src/dashboard/main.js serve …` command (no process spawn and no PID bookkeeping from the Pi host — m3);
  `--run <runId>` filter; help text (`extensions/p2o/index.ts:136–148`) and USAGE.
- Security tests: `tests/minimal/dashboard-server.test.ts` — loopback bind, 405 for non-GET/HEAD, 401 without the
  token / 200 with it, token never in logs or the query string, path traversal attempts, symlink snapshot entries, no
  write route, `query_only`/read-only assertion, response caps, CSP/nosniff headers, artifact allowlist (uncited id →
  404, offset bounds, frozen-mode copy bounds), concurrent-writer busy path.
- Tests: extend read-model tests for artifact provenance; `tests/minimal/dashboard-static.test.ts` — source checks for
  `dangerouslySetInnerHTML`, external `http(s)://` in client code, `node:fs`/write imports in client, and the honest
  labels.
- Docs: USAGE (service lifecycle, port, snapshot warning, "may contain redacted target data, do not commit"), README
  Development update, ARCHITECTURE component/security section, EVIDENCE cross-reference.

Exit gate: live mode shows a run being written (polling updates the sequence), a request without the token gets 401,
a snapshot built earlier renders its evidence from the copied artifact bodies offline, findings aggregate across a
retained run and a report-only run with correct provenance/conflict display, the security test set is green, and
`/p2o map` is documented and help-synced.

**P3 as built** (owner instruction `ok do | P3 | findings full detail + live server + /p2o map | …`, 2026-11-03). The
phase is implemented on top of the committed P1/P2 tree; nothing is committed yet.

- **Contract + read model.** Every accepted-current finding now reaches the client at the report's evidence detail: basis,
  likelihood, impact, rating limitations/provenance/flags, the host-frozen traffic evidence version and ordered citations,
  claims/independent evidence/references, contradictions, independence state and waiver, the chain (objective, impact, steps
  with gained/needs/effect/reach), the full retest block and remediation steps — parsed field by field with bounds, so a
  damaged bundle cannot inflate the payload. The case record's committed time is carried into each cross-run occurrence, so
  `firstSeen`/`lastSeen` are record times, not a wall clock. A store held by a concurrent writer is retried (3 attempts) and
  then listed as `busy: true` with a `store-busy` warning instead of disappearing or failing the scan. With `artifacts: true`
  the model collects the retained artifact bodies the served findings/cases cite (bounded per run and per body), and the
  snapshot writer copies them under `artifacts/<runId>/<artifactId>.txt` with bytes/sha256/truncated metadata in the run file.
- **Server.** One listener, two modes: `serve --snapshot <dir>` serves a frozen directory; bare `serve` (or with
  `--state-root`/`--report-root`/`--refresh`) reads the live roots and rebuilds through the read model on a cached interval
  (default 5 s, one shared in-flight build). Loopback only, `GET`/`HEAD` only, public static client, and the m5 per-launch
  bearer token on every data/API route (`/index.json`, `/runs/<runId>.json`, `/runs/<runId>/cases/<caseId>.json`,
  `/api/artifact`) — constant-time comparison, 401 with no data body, token only in the URL fragment, never logged. The
  artifact route serves a bounded chunk (16 KiB default, 48 KiB max, `nextOffset`) only for an id the served run cites, from
  the snapshot copy in frozen mode and from a read-only store open in live mode; others are 400/404/416 as appropriate, and
  direct `/artifacts/...` paths are never public. A store that stays locked answers 503 after bounded retries, while a busy
  run in the cached index still serves normally.
- **`/p2o map`.** Parser accepts `--out <absolute-directory>` (quoted paths allowed, absolute/NFC/control-free) and a
  repeatable `--run <run-id>`, with one confirmation that states the snapshot can contain target data. It builds the snapshot
  through the same read model/snapshot writer (citation-copied bodies included), then prints the standalone
  `node dist/src/dashboard/main.js serve --snapshot …` command. The host neither spawns nor supervises the server and never
  prints the token (m3). The command works while a run is active (all reads are read-only; a locked run is stated as busy)
  and states plainly when the client is not built (data-only snapshot plus the build command).
- **Findings screen** (`dashboard/app/findings/` + components): tiles from countable facts (runs, findings, accepted,
  pending, severity buckets with "not rated" separate, stale, conflicts), filters (severity/review/verdict/currentness/
  source/run/target/free text), sort, pagination with explicit totals, a table with expandable detail, and a detail panel that
  joins the aggregate to its run files: aggregate provenance, per-run conflicts shown value-by-value, retained-store case
  layers, then the full report evidence block, with an artifact viewer (`/api/artifact` chunks, metadata, 401/404 messaging),
  in-memory CSV/JSON of the filtered view, 5 s polling with `?refresh=` override and a manual reload. The launch token is kept
  in module memory only, sent as an `Authorization` header, and preserved across the plain anchors in the `#fragment`; the
  renderer stays text-only (no HTML injection, no external origin) and a source test pins that.
- **Tests.** New `tests/minimal/dashboard-server.test.ts` (4 tests: frozen auth/headers/traversal/symlink/artifact chunks,
  live refresh/busy/artifact errors), `dashboard-consistency.test.ts` (3: dashboard rows vs `findings.json` and all-case rows
  vs `caseViews`, occurrence times are committed), `dashboard-busy.test.ts` (1: concurrent writer becomes a busy row and the
  view recovers), `dashboard-map.test.ts` (2: snapshot + printed command, overwrite refusal), plus updated
  `dashboard-export` (7, including the artifact-body copy and the extended client source intake), `dashboard-snapshot` (4,
  new serve parser), `workspace-runtime` (map parser) and `dashboard/test/findings.test.ts` (18 pure filter/sort/CSV/JSON
  tests; the dashboard project is 39 tests).
- **Docs.** README Development describes both serve modes, the token and the snapshot sensitivity; `docs/USAGE.md` has the
  operator-facing section (Vietnamese); ARCHITECTURE has the P2/P3 component and security description; EVIDENCE has the
  dashboard-evidence cross-reference (m4).
- **Deviations, stated rather than hidden.** (a) Live mode serves the built client from `<cwd>/dashboard/out` because the
  agreed server API has no client-root option; without a build the data routes work and static routes 404. (b) `--snapshot`
  is mutually exclusive with the live flags; a bare `serve` is live. (c) An offset past the retained bytes is 416, invalid
  parameters are 400, and there is no write/control route at all. (d) Artifact bodies are collected eagerly only for
  snapshots; live mode reads them on demand. (e) The token gates frozen-mode data routes too (the plan says every data route
  from P3), so a snapshot directory is token-gated when our server opens it, though the directory itself is not encrypted and
  its files remain readable by anyone who has the directory — the docs say so. (f) Manual browser verification used a
  populated fixture snapshot (38 files, ~796 KB, one unrated accepted finding) served by the built CLI with a known test
  token: `/`, `/graph/`, `/findings/` and `/findings/?id=…` render, the token-less request is 401 while the UI loads and
  polls, the uncited-artifact probe is 404, POST is 405 and no page carries an external origin.

#### P4 — Hardening, acceptance, performance

Goal: close the security/performance/documentation edges before the feature is called done.

Deliverables:

- Threat-model pass written into ARCHITECTURE (same-user loopback trust, browser extensions/other local processes,
  snapshot copies leaving the machine, XSS/redaction limits).
- Performance: scan bounds and cache behaviour measured on a fixture root with many runs; document the limits; refuse
  rather than hang; a run with an incompatible schema/old version is a warning row.
- Consistency guards: dashboard vs report parity test on a fixture run (same accepted findings, same bounded strings);
  `caseViews` parity for all-case rows; deterministic data tree across two scans.
- Acceptance matrix rows (decided m8), the owner-approved AGENTS.md `dashboard:*` build/test lines, one HISTORY entry
  for the boundary change (decided m8), README/USAGE/ARCHITECTURE final read-through, mission-line claim audit (does
  the shipped code match the approved sentence in §5.5?).
- Optional P5 scope is not started here; it stays in §8.2.

Exit gate: full `npm test` green plus the dashboard project's own test/build, `detect-changes --scope all` clean of
unexpected effects, and every claim in the new README sentence demonstrably true.

#### P5 (optional, not assumed) — extra scope

LAN sharing via `--host` (the token already exists from P3), a single self-contained HTML export, an asset-graph tab in
the client, persistence of node priority, spawn-from-Pi `/p2o map --serve` convenience, and planner-facing dashboard
reads. Each is a separate decision with its own tests and docs; none is required for the owner's ask and none should
ride silently inside P1–P4.

### 6.8 Sequence and effort (estimates, not commitments)

| Phase | Scope | Estimate | Main risk |
|---|---|---|---|
| P1 | read model + projection v3 | ~1.5–2 days | report-builder extraction must not change report bytes; projection tests enumerate kinds |
| P2 | Next.js client + graph + export mode + mission line | ~2–3 days | first UI; browser-backed layout/folding; workspace install/build reproducibility |
| P3 | findings full detail + live server + `/p2o map` | ~2.5–3.5 days | cross-run merge semantics; token gate; artifact route security (live + copied snapshot bodies); concurrent writer handling |
| P4 | hardening, acceptance, docs | ~1–1.5 days | security review depth; consistency between three copies of "what a finding is" (report, dashboard, project DB) |

### 6.9 Build, dependency and packaging notes (C for current state)

- The extension itself stays free of runtime dependencies: the root `package.json` keeps only peer dependencies and
  `tsc` for the build. Owner decision m2 turns the repo into an **npm workspace** — the root gains
  `"workspaces": ["dashboard"]`, the single root `package-lock.json` installs the Next.js toolchain declared in
  `dashboard/package.json`, and the dashboard is **build-time only**: the served artifacts are static files, and
  `node:http`/`node:sqlite` are platform modules (Node ≥22.19 per `engines`).
- Root `npm test` keeps its current sequence (typecheck, build, import check, vitest, python checks) and does not build
  the dashboard, so a normal test run is unchanged after the root install. The workspace install happens once at the
  root; root `tsc` does not compile the dashboard because root `tsconfig.json` includes only
  `src/extensions/examples/tests` (§6.4 has the dashboard's own config).
- New root scripts: `dashboard:build` (`npm run build --workspace dashboard` → `dashboard/out`), `dashboard:test`
  (`npm run test --workspace dashboard`), `dashboard:serve` (the documented standalone command); CI/owner instructions
  go in README Development.
- Packaging: the root `files` list stays as it is for now, so `dashboard/out` is **not** shipped in an installed copy.
  The package is private/unreleased and this is a watch item (§8.2), not a release blocker; if a release ever ships the
  UI, adding the built assets (and their cache headers) is a packaging change with its own review.
- POSIX-only paths are inherited, not introduced: the store resolves `/proc/self/fd` and requires 0700 directories
  (`src/state/files.ts:11–31`); the dashboard reads the same roots, so it runs where p2o runs today.
- The only existing network-facing code is the internal `node:net` broker socket (`src/broker.ts:1,288–292`); the new
  server is the first HTTP listener in the repo and is treated as a new boundary in docs and tests. Its token gate (m5)
  is a launch-time secret, not persistent authentication.

## 7. (E) Test and documentation impact per phase

Global notes:

- **No new model tools.** Every new surface is human-facing; `MODEL_TOOLS`, `PLANNER_TOOLS` and the declaration totals
  stay unchanged (`tests/minimal/surface-audit.test.ts`, `tests/minimal/context-budget.test.ts`). The one model-visible
  change is the automatic `counts.byKind.hint` key on `p2o_board board=graph` (§6.5), verified against the existing
  view byte bounds and the board/record-shape tests rather than a new tool.
- **Command list contract.** `tests/minimal/help-commands.test.ts` requires every `/p2o <command>` shown in README.md and
  docs/USAGE.md to appear in the `/p2o` help text. `/p2o map` lands with its help line and both docs in the same change
  (P3).
- **Docs truth.** `tests/minimal/docs-truth.test.ts` scans README.md, HANDOFFS.md and `docs/*.md` (except HISTORY and
  ACCEPTANCE_MATRIX) for `p2o_*` verbs that are not model tools and for pinned claims. New docs must not invent
  `p2o_*` names; the mission-line replacement contains none. The dashboard's labels ("derived projection…",
  "redacted best effort…") should match the code strings so a future docs-truth pass can pin them.
- **Acceptance matrix.** `tests/minimal/acceptance-matrix.test.ts` only validates `file :: title` references cited in
  `docs/ACCEPTANCE_MATRIX.md`; the dashboard programme adds rows at P4 by owner decision m8, so a new test cited in the
  matrix must be added together with its row.
- **Dashboard project tests are separate.** Deterministic data logic lives in root `src/dashboard/` and is tested by
  root vitest; the thin Next.js rendering/layout layer is built by `npm run dashboard:build` (workspace, m2) and tested
  by `dashboard`'s own vitest for pure functions (layout determinism, filters, formatting). Root `npm test` does not
  build the dashboard; the workspace dependency is installed once at the root.
- **Read-only guarantee.** Every phase's tests assert that reads do not change store sequence/record counts and never
  open a store writable (the store's `readOnly` flag and `PRAGMA query_only` are the mechanism; tests use a temp store
  and compare sequences before/after).
- **Browser coverage.** No Playwright in P1–P4; the manual checklist is part of P2/P3 acceptance. Adding browser E2E is
  an explicit later decision, not a hidden gap.
- **GitNexus.** Run `impact` before editing `renderStoreReport`/`explorationDelta`/`EXPLORATION_NODE_KINDS` consumers and
  `detect-changes --scope all` before any commit; treat TS caller counts as a floor (§2.2) and re-check with grep.
- **Suite cadence.** Full `npm test` (typecheck, build, import check, vitest, python checks) at the end of every phase;
  it runs alone (~310 s). Docker/Herdr suites are not needed (no sandbox/worker change).

| Phase | New/updated tests | Existing contracts touched | Docs | Risk notes |
|---|---|---|---|---|
| P1 read model | `dashboard-read-model.test.ts` (discovery, per-run derivation, cross-run merge/conflict/fallback, report-only runs, corrupted manifest hash, truncation/warnings, determinism, no writable opens), `dashboard-snapshot.test.ts` (byte determinism, absolute new dir, no overwrite, bounds); projection/ledger tests for `hint` (`exploration-graph.test.ts`, `exploration-version.test.ts`, `projection*.test.ts`, `graph-record-shape.test.ts` — verify which enumerate kinds); report parity (`report-export`/`report-auto` unchanged) | `EXPLORATION_GRAPH_VERSION` semantics, store repair/stale path, `byKind` JSON shape, report file bytes | `docs/KNOWLEDGE.md` | report-builder extraction is the main regression risk; projection version bump touches old-run stale expectations |
| P2 client + graph + export | `dashboard-export.test.ts` (tree shape/assets/no overwrite/size cap), workspace build/typecheck, `dashboard` vitest for layout determinism/folding/filters, static no-external-URL check | snapshot path rule (`bundlePath`), command docs (only the standalone entry documented now), root `package.json` workspace field | README.md:5–6 + Development, `docs/USAGE.md` (standalone commands), `docs/ARCHITECTURE.md` component, AGENTS.md build/test line (m8) | first browser surface; workspace install/build reproducibility; mission-line accuracy |
| P3 findings + live + `/p2o map` | `dashboard-server.test.ts` (loopback, 405, 401 without token, token not logged, traversal, symlink, no write route, caps, headers, artifact allowlist live+frozen, busy run), `dashboard-consistency.test.ts` (dashboard vs report parity, all-case rows), `dashboard-static.test.ts` (no `dangerouslySetInnerHTML`, no external URLs, no client fs/write imports), snapshot-artifact copy test, command parse/help tests, `dashboard` vitest for filters/detail formatting | help-commands contract; USAGE command list; HTTP/security headers; evidence redaction wording; snapshot size caps | `docs/USAGE.md`, README Development, `docs/ARCHITECTURE.md`, `docs/EVIDENCE.md` | token UX, artifact serving incl. snapshot copies, and XSS are the highest-risk items; concurrent writer handling needs a real fixture |
| P4 hardening/acceptance | performance/bounds fixtures (many runs, large run), threat-model assertions, mission-line claim audit test (README sentence ↔ code invariants), acceptance rows (m8) | acceptance matrix, docs-truth scan, AGENTS.md, HISTORY.md | README/USAGE/ARCHITECTURE final pass; matrix rows; AGENTS.md; HISTORY entry | design review of the trust model, not new features |

## 8. (F) Decisions closed and watch items

No design decision remains open: the owner answered every item in three rounds on 2026-11-03 (§1.1–§1.3), and the plan
above is written against those answers. This section restates the closed choices with pointers, then lists watch items —
things to revisit at a named point, not questions that block P1.

### 8.1 Closed choices

| Id | Decision | Specified in |
|---|---|---|
| m1 | Approved mission sentence: "There is no hidden planner model and no provider harness. An optional local, read-only dashboard renders committed records and holds no execution authority." | §5.5; lands at P2 |
| m2 | npm workspace/monorepo with a single root lockfile; dashboard is build-time only; `files` unchanged for now | §6.4, §6.9 |
| m3 | Standalone server invocation (`node dist/src/dashboard/main.js serve` printed by `/p2o map`); client polls every 5 s with a manual refresh button; no spawn/PID bookkeeping from the Pi host | §6.3, P3 |
| m4 | Snapshots also copy the cited artifact bodies (bounded, redacted, bytes/sha256/truncated metadata); live mode serves from the store | §6.2, P3 |
| m5 | Loopback only, with a per-launch bearer token on data/API routes from P3 (no persistent accounts) | §6.3, P3 |
| m6 | Directory snapshot (data tree + static assets, zip-able); no single-file HTML in P1–P4 | §6.2, P2 |
| m7 | `counts.byKind.hint` appears automatically in `p2o_board board=graph`; no extra board text line | §6.5, P1 |
| m8 | ACCEPTANCE_MATRIX rows at P4; `dashboard:*` build/test lines in AGENTS.md when the scripts land (P2); one HISTORY entry for the boundary change | §6.6, P4 |

### 8.2 Watch items (no decision needed now)

- **`dashboard/out` in `package.json` `files`** if a release ever ships the UI. m2 keeps it out today; the package is
  private and unreleased, so nothing is blocked.
- **Single-file HTML snapshot**, **LAN `--host`**, and **spawn-from-Pi `/p2o map --serve`**: deferred P5 scope (§6.7 P5).
  LAN sharing reuses the token that already exists from P3.
- **Browser E2E (Playwright)**: the manual checklist covers P2–P4; an automated browser suite is its own change.
- **Pinned versions**: the exact Next.js/React versions are pinned in `dashboard/package.json` at P2; upgrades are a
  normal dependency decision, not a design one.
- **Project-knowledge DB**: remains opt-in suggested context (`src/project-knowledge-db.ts:13–15,26,72`), not the
  dashboard's aggregation source; changing that would be a semantic (accepted-only) decision, not a read path.
- **Snapshot retention**: operator-chosen directories may contain redacted-but-sensitive target data and, by m4, copied
  artifact bodies. Docs carry a "do not publish / do not commit" warning; the P4 threat-model pass re-checks the
  wording and the default caps.

## 9. Records and continuity

- This revision started as analysis/plan only (owner instruction D6): no code was changed and no suite was run while the
  document was written. The owner then closed the remaining decisions in a third round (§1.3), authorized P1 with
  `ok do P1`, authorized its commit plus P2 with `ok commit and do the next P2` (P1 is `85a1be7`, P2 is `355ec19`, neither
  pushed), and authorized P3 with `ok do | P3 | findings full detail + live server + /p2o map | …`. The P3 work sits
  uncommitted in the working tree, and the owner's pre-existing untracked files `.gitnexusrc`, `.transcribe_tmp/` and
  `pi-p2o-defense-vi.pptx` are never staged.
- **P1 implemented** (owner instruction `ok do P1`): projection v3 with the `hint` kind
  (`src/exploration-graph.ts`, `src/state/store.ts` `derivedExploration`), the behaviour-preserving report-builder
  extraction (`src/store-report.ts`, `findingReproduction()` in `src/report-export.ts`, thin extension wrapper), the
  read model / snapshot writer / standalone CLI under `src/dashboard/` (`contract`, `read-model`, `snapshot`, `main`),
  the new `dashboard-read-model`/`dashboard-snapshot` tests and the v3 cases in `exploration-graph.test.ts`, plus the
  `docs/KNOWLEDGE.md` v3 section and the `graphVersion` text in `docs/ARCHITECTURE.md`/`docs/USAGE.md`. Details and
  deviations are in §6.7 "P1 as built".
- **P1 gate evidence.** `npm run typecheck`, `npm run build` and `npm run check:build` clean; `vitest run` on the final
  tree: 188 test files passed / 5 skipped, 1,755 tests passed / 13 skipped, 0 failed; the report suites stay
  byte-identical after the extraction (they pin the bytes). Two local-environment caveats, both reproduced on the
  committed `3a7b0eb` and therefore not P1 regressions: (a) with the owner's real `~/.pi/agent/settings.json` role
  runtimes, 8 `artifact-ingest` fake-pi tests stop at the worker "Runtime profile mismatch" branch because that harness
  reads the real Pi settings instead of an isolated one — the same `vitest run` is green under `HOME=$(mktemp -d)`;
  (b) `check:python` keeps its known owner-local `my_references/strix` provenance drift (1 failure). No store was opened
  writable by the read model (asserted by the fixture test), and no commit or push happened.
- **P2 implemented** (owner instruction `ok commit and do the next P2`): the npm workspace with the pinned Next 16 static
  client (`dashboard/`: overview and graph screens, pure layout/filter modules and their tests); the frozen exporter now
  copies the built client next to the data tree and refuses symlinks/collisions/an existing directory before writing; the
  loopback frozen-mode server (`src/dashboard/server.ts`) and the `serve` command on `src/dashboard/main.ts`; the README
  mission-line replacement (§5.5), the README Development commands, the USAGE dashboard section, the ARCHITECTURE component
  and implementation-map rows, the AGENTS.md build/test line and the HISTORY boundary entry. Details, deviations (the CSP
  inline-script exception, the folded-digest super-node, the ≥80% first paint) and the manual browser verification are in
  §6.7 "P2 as built".
- **P2 gate evidence.** `npm run typecheck`, `npm run build` and `npm run check:build` clean; `npm run dashboard:build`
  clean (Next 16 static export, three pages, no external request — telemetry disabled at build); `npm run dashboard:test`
  21 tests passed; full `vitest run` on the final tree under `HOME=$(mktemp -d)`: 189 test files passed / 5 skipped,
  1,763 tests passed / 13 skipped, 0 failed (P1 baseline 188 / 1,755; the two new root files add 8 tests to the root glob
  and the dashboard project's 21 tests run under `dashboard:test`, not the root glob). The report suites keep their pinned
  bytes. The same two local-environment caveats as P1 remain and are not P2 regressions: with the owner's real
  `~/.pi/agent/settings.json` role runtimes the 8 `artifact-ingest` fake-pi tests stop at the worker profile mismatch
  (reproduced on committed `3a7b0eb`), and `check:python` keeps the owner-local `my_references/strix` provenance drift.
  No store is opened writable by any read path (asserted by the read-model test), the frozen server opens no store at all,
  and no commit or push happened for P2.
- **P3 implemented** (owner instruction `ok do | P3 ...`): the findings data at report-evidence detail in
  `src/dashboard/contract.ts`/`read-model.ts` (plus occurrence times from case records, `busy` rows for a locked store, and
  eager cited-artifact collection in snapshot mode), artifact-body copies in `src/dashboard/snapshot.ts`, the two-mode
  live/frozen loopback server with the m5 bearer token and the data/case/artifact routes in `src/dashboard/server.ts` (plus
  the `serve` parser/wiring in `src/dashboard/main.ts`), the `/p2o map` parser/dispatch/help line in
  `src/ui/workspace.ts`/`src/state/bundle.ts`/`extensions/p2o/index.ts`, the findings screen and token helpers in `dashboard/`,
  the new `dashboard-server`/`dashboard-consistency`/`dashboard-busy`/`dashboard-map` suites, and the README/USAGE/
  ARCHITECTURE/EVIDENCE updates. Details, deviations and the manual browser pass are in §6.7 "P3 as built".
- **P3 gate evidence.** `npm run typecheck`, `npm run build` and `npm run check:build` clean; `npm run dashboard:build`
  clean (Next 16 static export: `/`, `/_not-found`, `/findings`, `/graph`; telemetry disabled at build);
  `npm run dashboard:test` 39 tests passed (18 new findings/auth/query tests); `npm run typecheck --workspace dashboard`
  clean from the generated route types; full `vitest run` on the final tree under `HOME=$(mktemp -d)`: 193 test files
  passed / 5 skipped (198), 1,772 tests passed / 13 skipped (1,785), 0 failed. The report suites keep their pinned bytes;
  the dashboard/server suites assert the read-only invariant (a `readOnly !== true` handle is an error; a locked store is a
  `busy` row, never a write) and the new server test holds `BEGIN EXCLUSIVE` to prove the live view still serves. The same
  two local-environment caveats as P1/P2 remain (owner-local `artifact-ingest` profile mismatch and `my_references/strix`
  provenance drift in `check:python`) and are not P3 regressions; neither was exercised by the clean-HOME run. Manual
  verification used the built CLI against a populated fixture snapshot served on loopback: the token-less data request is
  401, the UI loads and polls with its `#token=` URL, uncited artifact is 404, POST is 405, and `/`, `/graph/`, `/findings/`
  and `/findings/?id=…` render (screenshots in the ignored `tmp/`). GitNexus on the re-indexed final tree
  (`analyze --index-only`, then `detect-changes --scope all`) reports 25 files / 628 symbols / 43 affected flows and
  `risk critical` — that is the combined P3 change set across the read model, server, `/p2o map` dispatch and client fetch
  path, not a single hub: the per-symbol upstream checks for `buildDashboard` (5), `parseWorkspaceCommand` (1) and
  `serveDashboard` (3) are all `LOW`/`exact`, and the full suite, dashboard build and manual browser pass are the
  mitigation. No commit or push happened for P3.
- **Next step.** The P3 tree needs a fresh owner instruction before any commit. P4 (hardening, acceptance matrix rows,
  threat-model pass, performance bounds) is the remaining planned phase; the watch items in §8.2 stay deferred.
- Continuity: v2 is committed at `3a7b0eb` (`git show 3a7b0eb:planning_update.md`) and its v2 §8 decisions remain in force.
  The v3 draft was uncommitted and is replaced by this file; §3–§4 carry its comparison forward, and §5.4 records its
  recommendation and the owner's reversal instead of deleting the disagreement.
- Confidence discipline: claims marked (C) are direct reads of the files/screenshots cited in §2.1; (I) items are
  structural inferences; (U) items are unknown until measured. The ARTEX comparison remains a source-snapshot
  comparison, not a measured capability claim. Effort figures are estimates.
- Honest limits of this plan: no browser session, no dashboard prototype, no security review has happened yet; the
  threat model in §6.3 is a design position to be tested in P3/P4, not a result. The report-builder extraction (P1) is
  the highest-regression-risk step because report bytes are pinned by tests.
- Next step: the decision log is closed (§8.1) and the approved mission sentence is fixed (§5.5). The owner authorizes
  P1 as a work item with its own tests and docs; P1 starts, and any commit or push happens, only on that fresh
  instruction.
