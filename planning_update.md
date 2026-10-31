# P24 — Persist the exploration graph, then make exploitation chain-native (plan of record, 2026-10-30)

Status: **plan written on owner instruction (2026-10-30) after the ARTEX comparison; no P24 code exists yet.** The owner chose
option B from the evaluation — persist the exploration graph in the run store (schema 8), derive edges on write, keep per-round
digests, inherit a prior run's graph read-only, and expose bounded graph reads to planner and worker — to make the chain
emergent instead of plan-row-only and to make our exploitation loop as strong as the reference system's. This file replaces
the P23 plan of record. P23 is recoverable at `git show 2448ca4:planning_update.md`; its F-P23-* rows and the C2 measurement
stay in [docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md) and [docs/HISTORY.md](docs/HISTORY.md), and the C2 measurement is
restated in §1 and §10 here. The uncommitted C2-fix-1/C2-fix-2 code and the C2 measurement docs are carried into Phase A as
the first commit instruction, before any P24 code.

Basis for this plan:

- Owner decision 2026-10-30: package B, "Persist exploration graph" (schema 8, auto-edges, digests, inherited graph, bounded
  graph read tools), chosen after the two-run C2 measurement and the ARTEX capability comparison (§1, §2).
- Repository state at plan time: HEAD `2448ca4` (B1 landed, local only), working tree carries C2-fix-1/C2-fix-2 and their tests
  plus the C2 measurement in the plan/matrix/HISTORY (all uncommitted; `git status` also shows the owner's `AGENTS.md`, the
  pptx and `.transcribe_tmp/`, which are never staged). Gates recorded for that tree (§12): tsc clean, full suite 168 passed /
  5 skipped files (173), 1,490 passed / 13 skipped tests (1,503), 0 fail; `npm run build` and `check:build` green; surface audit
  35 registered / 35 model-visible / 0 hidden / 10 tool verbs, 0 contradictions; declarations planner 45,049 / 45,500, worker
  40,935 / 41,400, validation 40,124 / 40,500, reporting 6,282 / 6,500; `validate_library.py` PASS 336.
- Reference system: local ARTEX checkout `~/artex/ARTEX` (`e6ec569`, changelog 0.3.15) plus its live PostgreSQL at
  `localhost:8787`; the numbers quoted in §2 are read from that source and that database, not from a pentest claim.
- Measurement stance: §1 is observation from two exploit-mode runs; nothing in this plan is an effectiveness claim about the
  target. P24's success is defined as mechanism observations (§7) on the next authorized runs, never as "the target fell".

## 0. Executive summary

Two live exploit-mode runs showed the same shape: the run can *record* a chain (2 chains / 2 links in both runs) and, after
C2-fix-2, a chain-owned worker finally receives `CHAIN`/`CHAIN PATH`/`NEXT LINK` lines — but the chain is still a **plan-row
artifact**. In run 1 the successor was authored 30 ms after the link and the brief lost the lines to two identity defects (now
fixed); in run 2 the successor was dispatched **11 minutes before** its link existed, so no brief could carry the context and
the link was walled 16 s after being written. The missing layer is a persisted graph: knowledge nodes and typed edges that the
run writes as a projection of its own records, so that "which demonstrated primitive is this attempt standing on, what did it
derive from, what did it yield, and how was this finding reached" is answerable from the store by a node identity instead of
by re-deriving ad-hoc joins from plan rows.

P24 delivers, in dependency order:

1. **Phase A — chain-native dispatch (order rule + carry-over).** Commit the measured C2 fixes; forbid (by host refusal) the
   exploit-mode dispatch that cited demonstrated claims without a recorded link; make `chainPlan` compose every ready frontier
   path, not one; then re-measure. This is the smallest change that fixes the measured W1/W2 defects before the graph exists.
2. **Phase B — store schema 8 and the write-side projection.** `exploration_nodes` / `exploration_edges` /
   `exploration_anchors`, written in the same transaction as each record by a new `indexExploration` beside the existing
   `indexKnowledge`; deterministic node identity; idempotent edges; a pure replay derivation that the incremental projection
   must equal (differential test, the pattern already used by the ledger builder).
3. **Phase C — read model and bounded surfaces.** `p2o_board board=graph` (overview page and node lineage sub-DAG, ≤24 KiB with
   tail trimming and `truncated`), `p2o_graph action=lineage` for the worker/planner, byte-capped brief sections, and the report
   `## Attack graph — recorded ancestry, bounded` section with a per-round digest timeline.
4. **Phase D — digests and inherited graph.** Write one host-derived digest node per round (a bounded summary whose `covers`
   edges name the round's members), read a prior run's graph from the same project/target read-only and trim it (≤400 nodes /
   800 edges) with every row labeled `inherited`, and prove the inherited rows never satisfy readiness, proofs, ratings or
   coverage.
5. **Phase E — exploitation strength.** Graph ancestry in the exploit brief, chain-frontier in the planner brief, case-chain ↔
   graph join in the report, and the completion/debt wording that points at the next link instead of only counting it.
6. **Phase F — measured live runs C3/C4.** C3 is the exploit-mode chain run on the owner-authorized target with the order rule
   active; C4 is a second run in the same project that reads the inherited graph. Both stop on the §13 line, on
   `opencode-go/deepseek-v4.1-flash` only, and record absence as a finding when nothing executes.

Non-goals are named in §9. Nothing in this plan lets the graph act as authority: records and ratings remain the only evidence,
exactly as the current chain layer already states.

## 1. Where the run stands (measured, not inferred)

### 1.1 The two exploit-mode C2 runs

| Run | Build / digest | Chain activity | Chain context in a worker brief | Effect |
|---|---|---|---|---|
| `run-38e983c0…` (cwd `~/tmp/p2o-live-c2`) | A5-fix-4 build, digest `425dea875f4a` | link `todo-95d01ebd…@r1` (`cms-forwarder-chain` step 2, effect `confidentiality-read`, claim `0dda6d86…`, needs `http.request`); successor `task-31e4d7e3…` authored **30 ms after** the link, dispatched 08:56:33Z | **none** — superseded record of the same claim made the link `waiting` (C2-fix-1) and the grey-box block was purpose-gated while the successor was authored `discovery` (C2-fix-2) | none; the residual SSRF task had no override, the case stayed pending (0 accepted), the successor blocked on a provider usage limit |
| `run-11badbea…` (cwd `~/tmp/p2o-live-c2d`) | C2-fix-1/2 build, digest `4396de5333ef` | 2 chains / 2 links; link 1 `cms-anon-metadata-oracle` step 1 authored 12:29:32.467Z; link 2 12:30:04.882Z, walled 12:30:20.709Z | **present for the first time**, on two *other* chain-owned tasks: `CHAIN: cms-auth-mount-to-session step 1/1 (blocked)` and `CHAIN: cms-anon-metadata-oracle step 1/1 (done)`, each with a truthful `NEXT LINK: not recorded; this is the last recorded step` | none; 0 accepted cases; both goals settled blocked (no reachable `data.read` proof; case acceptance refused three times on independent-environment mismatch) |

Run 2 numbers: 11:38:52Z–13:23:02Z, 9 rounds, 377 records / 1,288 events, 6 tasks (1 recon, 3 discovery, 2 validation),
5 candidate claims (4 confirmed+tested, 1 `open_proof_gap`), coverage plan r10 with 7 tested cells (106 excluded assets),
2 plan chains / 2 links, 0 accepted cases, `RESEARCH_DEBT 27`. Report:
`~/tmp/p2o-live-c2d/.p2o-reports/report-run-11badbea-…-final/`. The model stayed on `opencode-go/deepseek-v4.1-flash`
in every round and the run stopped cleanly with `/p2o stop`.

**The measured order defect:** the successor `task-94d6b988…` was authored 12:18:52Z and dispatched 12:19:08Z; link 2 that
records the successor exists was authored 12:30:04Z. A link cannot reach a brief that was already rendered, so the brief of
the only successor that ran carried no chain context by construction. The host has no rule that requires the link before the
dispatch; the prompt only says "author a link … dispatch the ready step" (§1.3), which the two runs read differently.

### 1.2 What p2o already has (so P24 extends, not replaces)

| Capability | Implementation | Anchor |
|---|---|---|
| Capability join over claims: primitives, ready claims, uncovered needs, shortest primitive→claim frontier paths | `chainJoin` | `src/chain-view.ts:57` |
| Chain readiness from plan rows + demonstrated claims, with `ready/waiting/done/blocked/deferred/cancelled`, typed needs, `satisfiedBy` | `chainBoard` | `src/chain-board.ts:77` |
| Chain context in a worker brief (`CHAIN`, `CHAIN PATH`, `NEXT LINK`) | `chainBriefFor`, `chainBriefLines`, `workerBrief` | `src/chain-brief.ts:48`, `src/prompts.ts:380-420` |
| Chain composition that writes plan todos from the single shortest frontier path, without dispatching | `chainPlan` (`p2o_graph_plan action=chain plan=true`) | `extensions/p2o/index.ts:525-568` |
| Round brief: ready/waiting steps, unmet needs, unchained primitives, case chains, graph delta | `readySection`, `unchainedSection`, `buildRoundBrief` | `src/round-brief.ts:355-440`, `:33-62` |
| Derived knowledge heads/links projection in the store (auto-indexed on commit) | `indexKnowledge`, `knowledge_heads`, `knowledge_links` | `src/state/store.ts:357-366`, `src/state/schema.ts:40-51` |
| Lineage walk over knowledge records (bounded depth 2 / 24 rows, same run) | `lineageOf`, `lineagePage` | `src/exploration-view.ts:238-300`, `:355-372` |
| Attack-path report (plan chains + accepted case chains, executed vs "not executed") | `attackPathSection` | `src/report-export.ts:495-547` |
| Case-chain projection from accepted, current-rated cases | `projectCaseChains` | `src/case-chain-view.ts:99` |
| Recon asset graph (assets/assertions/relations/anchors, 24 KiB reads, graph tools) | `src/state/graph.ts`, `src/state/graph-tool.ts` | `src/state/graph.ts:13-33`, `graph-tool.ts:45-103` |
| Store schema 7, refusal to migrate in place, bundle export/import, checkpoints | `AssessmentStore`, `exportBundle`/`importBundle` | `src/state/schema.ts:2-106`, `src/state/store.ts:189-204`, `bundle.ts:47,175` |
| Project knowledge (per-project identity history, suggested only) | `ProjectKnowledge` | `src/project-knowledge-db.ts:1-45` |

### 1.3 The gap, stated as invariants

1. **W1 — chain identity is not emergent.** A chain exists only while a `todo` plan row carries `chainOf`/`step`; if the
   planner writes the row after dispatch, or rewrites the frontier and drops the row, the chain and its brief lines vanish
   (measured in both runs). Nothing records "this task yielded this claim, which the link stood on" once the row is superseded.
2. **W2 — no host ordering rule.** `src/prompts.ts:182` asks the planner to author the link and dispatch the ready step but
   does not define the order; `src/state/store.ts:380-470` validates the task and the plan row separately, never that the
   link for a dispatched successor exists. Run 2 proves the gap is reachable in normal operation.
3. **W3 — ancestry is re-derived per read and bounded to two hops.** `lineageOf` walks current heads only, same run, depth ≤4
   (default 2), limit ≤80, and skips `supersedes`/`resolves` as edges (`src/exploration-view.ts:238-300`); no prompt uses it
   (grep of `src/prompts.ts`, `src/round-brief.ts`). A finding cannot be traced to the primitive it actually derives from.
4. **W4 — no persisted exploration graph.** The only persisted graph is the recon asset graph (`assets/assertions/relations/`
   `anchors`); claims, cases, plans and tasks are JSON rows with ad-hoc reference fields. There are no typed edges, no digest
   rows, and no cross-run graph reuse (project knowledge stores finding/asset identities only, no edges).
5. **W5 — graph→context asymmetry.** A worker brief gets the recon graph slice (`src/prompts.ts:416-417`, 20 rows) but not the
   claim/case ancestry; the planner round brief gets counters plus 3 assets and 2 hypotheses (`extensions/p2o/index.ts:676-691`);
   lineage is exposed only as a board verb (`src/board-verbs.ts:39`) and no prompt calls it.
6. **W6 — operator visibility is post-hoc.** The only graph-shaped output is the report's attack path, written at stop. There is
   no per-round digest row, no cumulative graph read during the run, no "how was this finding reached" view.

## 2. Reference model — what ARTEX has, and what to copy

Corrected premise from reading the source: **ARTEX's UI graph is not per-round.** Each task has one cumulative exploration graph;
a "round" is one planner wake (graph-change debounce or heartbeat, `server/engine.go:800-819`), rounds survive only as transcript
separators, and digest nodes are background compactions at round boundaries (`agent/compaction.go:104-110`, `db/digest.go:17-145`).
What is per-round is the **planner's context**: every wake the prompt is built with a bounded `graphOverviewData()` snapshot
(`agent/planner.go:382`, `agent/tools.go:354-585`). So the capability to copy is cumulative typed graph + bounded per-round
projection + lineage query + digest + inheritance, not a UI feature.

| ARTEX capability | Mechanism | Source | P24 counterpart |
|---|---|---|---|
| Typed nodes, closed kinds/states | `exploration_nodes`, kinds `goal/intent/fact/finding/hint/digest/origin` (begin deprecated), `UNIQUE` state sets | `db/schema.sql:170-191`, `db/constants.go:4-30` | §3.2–§3.3, node kinds `origin/goal/link/intent/fact/finding/digest` |
| Typed parent→child edges, closed rel vocabulary | `spawns`, `derived_from`, `yields`, `proves`, `covers`; anchors are provenance, not visibility | `db/schema.sql:248-257`, `agent/coldgraph.go:11-13` | §3.4, same five rels plus `anchors` |
| Edges written automatically when knowledge is created | `add_intent(parent_ids)→derived_from`, `record_fact→intent yields fact`, `report_finding→intent yields finding`, `prove_goal→proves`, digest→`covers` | `agent/tools.go:1078,1347,1467,1183`; `db/finding_traffic.go:376`; `db/digest.go:142` | §3.4 — host derivation on record commit, no model write |
| Bounded per-round projection pre-injected into the planner prompt | goals/hints/open intents with parents/yields, running/recent intents, findings with `from_intent`, recent facts, cold digests, coverage; caps 30/20/10/12/15 | `agent/tools.go:354-585`, `agent/planner.go:382` | §3.7 `overview` + §4 Phase C brief section |
| Lineage sub-DAG "how was this finding reached" | recursive CTE over edges backwards, returns node+ancestors+internal edges; exposed per finding; UI tab | `db/exploration.go:1027-1086`, `server/server.go:2217-2251` | §3.7 `lineage`, §4 Phase C board verb + tool |
| Digest compaction of cold regions | digest node with body/member ids, `covers` edges, supersede on major compaction | `db/digest.go:17-215`, `agent/compaction.go:386-403` | §3.5 one digest node per round, `covers` members |
| Cross-task/source graph inheritance, trimmed read-only | direct source stores merged, trimmed to terminal intents | `server/server.go:2434-2456,2509-2527` | §3.6 inherited overlay selected by the existing `--refer-workspace` prior-run selection (`extensions/p2o/index.ts:396-425`), trimmed, never authority |
| Agent-side graph reads | `graph_overview/list_facts/list_findings/node_detail/expand_digest`; no SQL tool | `agent/tools.go:2033-2055` | §3.7 bounded `p2o_graph`/`p2o_board` reads; no raw SQL |
| Measured scale on a real task | task #22 "nitendo": 184 nodes (1 goal met, 74 intent, 83 fact, 8 finding, 17 digest) / 269 edges (145 derived_from, 90 yields, 32 covers, 1 spawns, 1 proves); finding #715 lineage = 27 nodes / 37 edges | live PostgreSQL `artex` db, `exploration_nodes/edges` | bounds in §3.9 sized against this scale |

What P24 deliberately does **not** copy: ARTEX's UI canvas, its model-authored graph writes (p2o keeps host-only derivation),
its digest body as a model summary (p2o digests are host-derived), and its single-level intent vocabulary (p2o keeps the extra
`link` authored by the planner because chain readiness is a separate authority we do not want to lose).

## 3. Design — the persisted exploration graph

### 3.1 Authority and invariants

- **Records remain the only authority.** Every graph row is a projection of committed ledger records plus the host's closed
  derivation rules. Deleting and rebuilding the graph from `records` must produce byte-identical rows (differential test).
- **No model writes the graph.** There is no tool that inserts a node or an edge; the only writers are the store commit path
  and the two host calls (round digest, inherited overlay). A model can read the graph and can write the records that cause
  edges; it cannot state an edge directly.
- **The graph never satisfies anything.** Readiness (`chainBoard`), goal proof (`goal-proof.ts`), case verdict/rating, coverage
  cells and completion stay computed from records exactly as today. Graph reads are labeled `derived`; an accepted case rating
  remains the only executed-chain evidence (`src/report-export.ts:495-547`).
- **Inherited rows are marked and inert.** `inherited_from` is set on every imported row; no inherited row participates in
  readiness, frontier, proof, rating, completion or a brief's actionable lines (only a count line).
- **Bounded everywhere.** 24 KiB is the read bound (`src/state/graph.ts:31`, `extensions/p2o/index.ts:292`), 8 KiB the round
  brief (`src/round-brief.ts:33`), and every new page trims tail-first and reports `truncated`/omitted counts; a page that
  cannot fit even at its floor is refused by name, never returned over the bound.
- **Deterministic identity.** `nodeId = ${kind}-${sha256(runId + NUL + kind + NUL + entityId).slice(0,24)}`; digest
  `digest-${runId.slice(0,8)}-${round}`. Re-committing the same record never duplicates a node; the same record packet yields
  the same rows in the same sequence order.

### 3.2 Schema 8 additions (`src/state/schema.ts`)

`STATE_SCHEMA_VERSION` becomes `8`; the rest of the schema is unchanged. New tables are added before the `PRAGMA user_version`
line and follow the existing `STRICT` + JSON-check style:

```sql
CREATE TABLE exploration_nodes(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES events(sequence),
  kind TEXT NOT NULL, state TEXT NOT NULL, entity_id TEXT NOT NULL, record_id TEXT REFERENCES records(id),
  body TEXT NOT NULL CHECK(json_valid(body)), bytes INTEGER NOT NULL,
  inherited_from TEXT, source_node_id TEXT,
  created_sequence INTEGER NOT NULL, updated_sequence INTEGER NOT NULL
) STRICT;
CREATE INDEX exploration_nodes_run ON exploration_nodes(run_id, kind, state, sequence);
CREATE INDEX exploration_nodes_entity ON exploration_nodes(run_id, kind, entity_id);
CREATE TABLE exploration_edges(
  run_id TEXT NOT NULL, src_id TEXT NOT NULL REFERENCES exploration_nodes(id), rel TEXT NOT NULL,
  dst_id TEXT NOT NULL REFERENCES exploration_nodes(id), sequence INTEGER NOT NULL REFERENCES events(sequence),
  inherited_from TEXT, PRIMARY KEY(run_id, src_id, rel, dst_id)
) STRICT;
CREATE INDEX exploration_edges_src ON exploration_edges(run_id, src_id, rel);
CREATE INDEX exploration_edges_dst ON exploration_edges(run_id, dst_id, rel);
CREATE TABLE exploration_anchors(
  run_id TEXT NOT NULL, node_id TEXT NOT NULL REFERENCES exploration_nodes(id), asset_entity TEXT NOT NULL,
  sequence INTEGER NOT NULL REFERENCES events(sequence), inherited_from TEXT,
  PRIMARY KEY(run_id, node_id, asset_entity)
) STRICT;
CREATE INDEX exploration_anchors_asset ON exploration_anchors(run_id, asset_entity);
```

Rationale for three tables and not five: a digest is a node kind whose body is the bounded round summary and whose `covers`
edges name the members — exactly ARTEX's shape, one fewer table to migrate and test. `exploration_anchors` is a separate table
because a node→asset link is many-to-many and orthogonal to the edge DAG (the recon graph already keeps anchors separate for
the same reason). Per-table caps are enforced in code, not by DDL: `EXPLORATION_NODE_LIMIT = 4000`, `EXPLORATION_EDGE_LIMIT =
8000`, `EXPLORATION_ANCHOR_LIMIT = 8000` per run, with capacity multiplier support like `graphCeilings` only if a measurement
needs it (not in v1).

### 3.3 Node kinds and record mapping

| Node kind | Created from | State mapping | Body (bounded, ≤8 KiB) |
|---|---|---|---|
| `origin` | run manifest, once per run | `current` | `{objective, targetIdentityHash, mode, engineVersion}` |
| `goal` | `note` + `data.plan.kind='goal'` (each revision) | plan status + `met` when a `proves` edge exists or a coverage proof holds | `{planId, revision, status, title, proofLabel}` |
| `link` | `note` + `data.plan` with `chainOf`/`step` (each revision) | plan status (`open/done/deferred/blocked/cancelled`) | `{planId, revision, chainOf, step, status, effect?, needs[], claimRefs[], title}` |
| `intent` | `task` (each revision) | task status (`proposed/reserved/running/reported/reviewed/closed/blocked/cancelled/expired`) | `{taskId, revision, role, purpose, status, claimRefs[], methodFamily?, title}` |
| `fact` | `candidate` (each revision, head = slug) | `demonstrated` iff closure `confirmed` **and** execution `tested` (`src/claims.ts:66-68`), else closure | `{slug, recordId, closure, execution, gained[], needs[], surface, risk, proof}` |
| `finding` | `note` + `data.case` (each revision) | review status/verdict | `{caseId, revision, reviewStatus, verdict, severity, claimRefs[], taskRefs[]}` |
| `digest` | host at round open / stop (§3.5) | `active` | `{round, window:[from,to], counts, additions, text}` |

`hint` is deliberately deferred: p2o records operator steering as campaign/brief facts today, and inventing a hint node without
a record to project would create a second authority. If a later phase gives steering a record kind, §3.4 grows a `hint` node
then (a documented successor decision, not a hidden gap). Coverage cells/plans are also **not** nodes in v1: coverage is its
own board with its own derivation (`src/coverage.ts`), and the graph's chain job does not need them; asset anchors on
intent/fact/finding nodes carry the asset linkage the report needs.

### 3.4 Edge derivation (host-only, on record commit)

Edges are derived in a new `src/exploration-graph.ts` pure module and written by `AssessmentStore.indexExploration(row,
event.sequence)`, called once per record immediately after `indexKnowledge` (`src/state/store.ts:450`). Direction is
parent→child, as in ARTEX (`agent/coldgraph.go:11-13`).

**Precedent, not a new power.** The asset graph already derives structure inside the write path: `recordGraph` runs a
host-written `deriveContainment` pass (`src/state/store.ts:1142-1163`, rule `P21/A3/D-P21-10`) that is bounded, skips when
capacity is full, never lets a derived row shadow an asserted one, and never fails the graph write it describes. P24 copies
those mechanics for the exploration graph. The difference is scope: every `exploration_edges` row is host-derived by
construction — there is no model-asserted edge for it to coexist with — so the table needs no `basis` column; the asset
graph keeps `basis` because a worker can assert a relation there.

| Rel | From → To | Rule |
|---|---|---|
| `spawns` | `origin` → `goal` | every goal revision; and `origin` → top-level `intent` when the task cites no claim, no prerequisite and no parent (ARTEX uses `derived_from` for that fallback, `agent/tools.go:1085`; p2o keeps the distinct rel so a spawn is not mistaken for a derivation) |
| `derived_from` | `fact` → `intent` | each `task.work.claimRefs` entry that resolves to a claim node; resolution through `recordIds` of the claim slug (`src/chain-view.ts:155`, `:190-210`) so a superseded record still resolves to its head |
| `derived_from` | `intent` → `intent` | `task.prerequisites`, `task.parentTaskId`, `task.validationOf`, `task.retestOf` |
| `derived_from` | `fact` → `link` | each `data.plan.claimRefs` entry |
| `derived_from` | `link` → `intent` | `data.plan.taskIds` contains the task id |
| `yields` | `intent` → `fact` | `candidate.data.taskRef` |
| `yields` | `intent` → `finding` | each `data.case.taskRefs` entry |
| `derived_from` | `fact` → `finding` | each `data.case.claimRefs` entry (the case stands on the claims) |
| `proves` | `fact`/`finding` → `goal` | goal proof is satisfied for a capability/case proof (§3.4.1); a coverage-plan proof writes no edge and is recorded in the goal body as `proofHolds:'coverage'` |
| `covers` | `digest` → node | every node whose `created_sequence`/`updated_sequence` falls inside the digest window (§3.5) |
| (anchors) | node → asset | `task.work.assetRefs`, `candidate.data.assetRefs`, `data.case.assetRefs` |

Unknown targets are dropped **and counted** in a per-commit diagnostic, never fabricated as placeholder nodes; the read model
reports the count (`unresolved`) so a short lineage is not read as a complete one, matching the `resolved:false` convention
already used by `lineageOf` (`src/exploration-view.ts:288-290`).

#### 3.4.1 `proves` evaluation and its bound

`proves` edges are projection hints, never authority: the report and completion keep using the full resolver in
`src/goal-proof.ts` over records. To keep the write path cheap and deterministic:

- goal revision: evaluate against the goal's proof (`capability` → latest `fact` nodes with typed `gained`; `case` → the
  `finding` node of that case), and insert exactly one edge from the newest source that satisfies it. One edge per satisfied
  goal keeps a capability demonstrated by many facts from fanning in without bound; the other demonstrations stay fact nodes.
- fact/finding revision: evaluate only goals that have no `proves` edge yet (`state <> 'met'` and body `proofHolds` absent),
  at most `PROVES_GOAL_SCAN = 200` goals, against at most `PROVES_FACT_SCAN = 500` newest demonstrated facts. A capability
  goal is the only one that needs a scan; a `case` proof resolves its finding node by identity, so it never scans findings.
- a proof satisfied only by an older source outside those scans is left to the read/rebuild path (`rebuildExploration()` uses
  the complete derivation), and the goal body records `provesTruncated:true` so the state stays honest.

Every rule is a pure function of `(record, context)`; the store never reads the wall clock, the network or another run.

### 3.5 Round digests

A digest node is written by the host when the next round opens and at stop. Site: where the round window is already recorded
(`extensions/p2o/index.ts:4631`, `current.roundWindow = {round, records, sequence}`) — the host already knows the ledger
barrier; no new authority is invented.

- Window: `from = previous digest.lastSequence ?? 0`, `to = current.store.sequence()` at round open; on stop, `to = sequence()`.
- Body: `{round, window, counts: {nodes by kind, edges by rel, anchors}, additions: {facts: ≤8 {slug, summary≤120}, findings: ≤4
  {caseId, severity, summary≤120}, links: ≤6 {chainOf, step, state}}, text: ≤600 chars}`. The text is a host sentence, never a
  model summary: "round 3: 2 facts, 1 finding, 1 link authored, 0 links ready, 4 coverage cells tested".
- `covers` edges connect the digest to every node created or updated in the window (bounded by the window itself; a digest over
  a very large window still writes at most `DIGEST_COVERS_MAX = 200` edges and records `coversTruncated`).
- One digest per round, never rewritten. `DIGEST_LIMIT = 500` per run; if a run ever exceeds it, the oldest digests are marked
  `state='superseded'` (kept, not deleted) and a final range digest is written at stop. No model-authored digest body.

### 3.6 Inherited graph (cross-run reuse)

The run already has an owner opt-in for reading prior runs: `--refer-workspace [latest|all|<run-id>[,<run-id>...]]` selects
prior stored runs on the same target through `priorRunsOnTarget` (sibling `run-*/` directories under the state root, bounded to
20 scanned, manifest match on target kind/display; `extensions/p2o/index.ts:391-425`), reports "Referencing N prior workspace
run(s) on this same target … never counted as same-run evidence, and no scope, worker or ticket authority is restored"
(`:4176`), and derives a reference gap report (`deriveReferenceGaps` `:427`, used at `:4550`). P24 rides that selection instead
of adding a second discovery path:

- **Source = the referenced runs.** No `--refer-workspace` selection means no inherited graph; the overview prints "Inherited
  graph: none (no --refer-workspace selection)" so absence is explicit, not clean.
- **Per run:** open the referenced run's store read-only. A schema-8 run is read through `explorationSnapshot()`; a schema-7 run
  (incompatible under the new build) is read through the raw read-only reader of §3.8 and its graph is derived from `records`.
  This keeps cross-run reuse working across the schema boundary without rewriting old stores.
- **Trim:** newest `INHERIT_RUNS = 2` referenced runs; per run at most `INHERIT_NODES = 400` nodes and `INHERIT_EDGES = 800`
  edges, priority findings → facts → links → intents → goals → digests; an edge is copied only when both endpoints are copied;
  node bodies are re-capped at 2 KiB with the original size recorded. Deduplication is by `source_node_id` so two referenced runs
  that share a claim slug produce two labeled copies, never a silent merge.
- **Marking:** every imported row carries `inherited_from = <priorRunId>` and `source_node_id`; edges/anchors carry the same
  marker. The overview prints one line: "Inherited graph: N node(s) / M edge(s) from run `<id>` — read-only, suggested context,
  never a fact".
- **Inert by construction:** inherited rows are excluded from readiness, frontier, proves evaluation, goal proof, case rating,
  coverage cells, completion and every brief's actionable line. Only a count line and an explicitly labeled read page show
  them. Dedicated tests assert each exclusion (§5).
- **Controls:** `p2o.inheritGraph` setting (default `true` when `--refer-workspace` is set), run manifest records
  `inheritGraph` and the referenced run ids so a report can state which mode ran; `--no-inherit` forces a clean run even with
  `--refer-workspace`.

### 3.7 Read model and bounded surfaces

New `src/exploration-graph.ts` exports pure readers over a snapshot (`store.explorationSnapshot()` returns nodes/edges/anchors
bounded to the caps) and a store-backed reader for the pages:

- `explorationOverview(snapshot, options)` → `{counts, origin, goals, links, openIntents, recentFacts, recentFindings,
  latestDigest, inherited}` plus a `renderOverviewLines(overview, byteCap)` for briefs/report. Byte-capped by the caller;
  rows drop tail-first and the rendered text says what it dropped.
- `explorationLineage(snapshot, seeds, {direction:'up'|'down'|'both', depth≤6, limit≤60})` → `{root, rows, edges, omitted,
  unresolved}` — the sub-DAG equivalent of ARTEX `FindingLineage`. The walk is pure over the snapshot the store already
  returns (no `WITH RECURSIVE` read path and no second query surface): one relation table decides the ancestor side
  (`spawns`/`yields`/`derived_from` run ancestor→descendant; `proves`/`covers` name the goal/digest as the ancestor), so up
  and down are inverses. Rows are `{relation, direction, kind, state, id, depth, summary≤160}`; the page is trimmed to fit
  `GRAPH_RESPONSE_BYTES` (24 KiB) with `truncated` and omitted counts, and the store's `explorationPage(id)` resolves a node
  id, a record id or the entity id a reader already holds (plan/task/case/claim/run).
- `explorationFrontier(snapshot, links, claims)` → the open `link` nodes plus their derived readiness from `chainBoard`; this is
  a read-only join of graph and board, never a second readiness authority.
- `explorationDigestPage(snapshot, {round?, cursor, limit})` → digest nodes newest-first, body capped 2 KiB, list page ≤24 KiB.

Surfaces (no new tool; AGENTS.md says extend before adding):

1. `p2o_board board=graph`: planner-only (p2o_board is already planner-only). No `id` → overview page; `id=<node|record|claim|
   case|task|plan id>` → lineage page (direction/depth/limit are fixed host bounds: both, depth 6, limit 60). Board dispatcher
   `extensions/p2o/index.ts:3073-3096` gains one branch; `BOARD_NAMES` gains `'graph'` (`src/board-verbs.ts:39`), the parameter
   enum `:89-93` and the host field whitelist `:3075` are updated, and the page uses the existing `boundedResult` helpers
   (`extensions/p2o/index.ts:292-312`).
2. `p2o_graph action=lineage`: worker/validation/planner (all hold `p2o_graph`). Fields `{action:'lineage', id, direction?,
   limit?}` — depth is host-fixed at 6 and limit clamps to 60, so the declaration grows by one enum value and one optional key
   instead of a query surface; 24 KiB trimming as in (1). The `p2o_graph` description stays ≤900 chars
   (`tests/minimal/graph-response-bounds.test.ts:20-24`) and gains a `lineage:` clause while keeping the moved verbs
   unadvertised.
3. No raw SQL/graph_query tool: the bounded reads above are the whole agent surface, matching ARTEX's choice
   (`agent/tools.go:2033-2055`).

### 3.8 Migration, old stores and rebuild

The current rule is deliberate and stays: a writable open refuses a version it does not own (`Unsupported state schema N;
inspect read-only, never migrate in place`, `src/state/store.ts:181-204`, refusal `:198`) and a schema-7 store opens read-only
with `compatible=false`, `records()` throwing (`tests/minimal/assessment-store.test.ts:98-107`). P24 therefore:

- **New runs create schema 8.** Nothing else about the store lifecycle changes; the tests' version-fence case is extended with
  version 8.
- **Old runs stay historical read-only in the normal path.** They keep reporting what they recorded; they do not gain graph
  pages through the normal store API.
- **A raw read-only reader** `src/state/legacy.ts:readRecordsReadOnly(path)` opens the sqlite file directly
  (`PRAGMA query_only=ON`, `journal_mode=delete`, no symlink/hardlink substitutions, byte/path guards like the existing
  `PrivateDirectory` checks), verifies `user_version ∈ {7,8}`, and returns bounded `{records, manifest, journal, bytes}` rows
  validated through the immutable `indexRecords` path. It exists for exactly two consumers: inherited-graph derivation from a
  prior schema-7 run, and an optional explicit upgrade. It never writes.
- **Rebuild is a test-visible method first:** `AssessmentStore.rebuildExploration()` deletes this run's exploration rows and
  replays every committed record through the same pure derivation in one transaction. The differential test asserts
  `rebuildExploration()` output equals the incremental projection byte-for-byte after an arbitrary record stream (the
  precedent is the ledger builder / `indexRecords` differential described in `src/records.ts:180-190`).
- **Bundles and checkpoints are unchanged and are not an upgrade path.** `exportBundle` (`src/state/bundle.ts:47-98`) keeps
  graph rows only as bundle segments; `importBundle` (`:175-198`) re-ingests every file as an immutable artifact and writes one
  provenance note — it never replays records or graph rows into the store (`tests/minimal/bundle.test.ts:115-127` pins
  `graphSummary().assets === 0` after import). P24 does not change that; §9 states it so "export then import" is not read as a
  migration story.
- **A schema-7 run cannot be reopened writable by a schema-8 build.** `recover` opens the run writable
  (`extensions/p2o/index.ts:3918-3922`) and `AssessmentStore.connect` refuses the foreign version before any read
  (`src/state/store.ts:198`); `--resume` already opens read-only first and refuses by name ("Stored run schema N cannot be
  resumed by this build; inspect it read-only with /p2o state", `extensions/p2o/index.ts:4125-4129`). Phase B therefore adds
  no new refusal code: it pins the existing messages with a test so a later edit cannot turn them into raw SQLite errors, and
  the docs say a run is recoverable only by the build with the same schema version.
- **In-place upgrade is an explicit, deferred option (Phase F only if the owner wants old runs graph-readable).** It would
  be an operator command (`/p2o store upgrade`), never the open path: verified sha256 backup, refuses if a writer lock exists
  or the run is not stopped, one-way, writes a `metadata` row describing the upgrade, then backfills via the same derivation.
  Default P24 does **not** ship it; inherited-graph derivation covers cross-run reuse without rewriting history.

### 3.9 Bounds and budgets

| Surface | Bound | Where enforced |
|---|---|---|
| Any graph read response | 24 KiB hard (trim rows tail-first, `truncated` + omitted counts, refuse by name at floor) | `boundedResult` pattern `extensions/p2o/index.ts:292-312`, `GRAPH_RESPONSE_BYTES` `src/state/graph.ts:31` |
| Board `graph` overview / lineage page | 24 KiB shared with the board frame; lineage rows ≤60, depth ≤6 | new `graph` branch, same helpers |
| Planner round brief | 8 KiB total (`ROUND_BRIEF_MAX_BYTES` `src/round-brief.ts:33`); new `exploration` section cap 1,024 B, ordered last and first on the omit order (renders nothing when the caller supplied no projection) | `src/round-brief.ts:35-67,616-630`, caller `extensions/p2o/index.ts:718-728` |
| Worker brief ancestry | one block ≤480 B, ≤3 lines ≤240 chars | `src/prompts.ts:403-427`, reader at `src/exploration-graph.ts:652-700`, facts assembled at `extensions/p2o/index.ts:1594-1606` |
| Round digest body | ≤2 KiB stored, ≤600 chars text; ≤200 `covers` edges | §3.5, read page trims |
| Inheritance | ≤400 nodes / ≤800 edges / 2 prior runs | §3.6 |
| Declaration budget | **no new tool**: board name + one graph action; must fit the pinned ceilings without raising any (planner 45,500 / worker 41,400 / validation 40,500 / reporter 6,500 / model 75,600; `tests/minimal/context-budget.test.ts:44`, `tests/minimal/surface-audit.test.ts:18,48`) | measure with `node scripts/audit-surface.mjs --json`; if a ceiling would be exceeded, first trim duplicated prose in the same edit, and only then ask the owner to re-pin one ceiling with a before/after measurement (the D-S1-5 rule) |
| Store growth | nodes ≤4,000 / edges ≤8,000 / anchors ≤8,000 per run, digests ≤500; counts exposed in `p2o_state` health | new caps constants in `src/exploration-graph.ts` |

Reservation measured at plan time, so the declaration work is sized before it starts: `p2o_graph`'s description is 554 chars
(cap 900), leaving 346 for the `lineage:` clause; the action enum gains `lineage` (+10 chars) and one optional `direction`
key (≈90), so the net addition is ≈200 chars against the tightest holder — validation, whose pinned headroom is 376
(`40,500 - 40,124`). `p2o_board`'s description is 523 chars and gains `graph` in its list plus one lineage sentence (≈120
chars) against planner headroom 451 minus the same ≈200. No ceiling moves; if the measured total still exceeds one of them,
trim duplicated prose in the same edit first and only then ask the owner to re-pin one ceiling with a before/after
measurement (D-S1-5). The brief and report strings are not declarations, so their 8 KiB / 24 KiB caps are unaffected.

## 4. Workstreams (phases, each with its own acceptance)

Phase order is dependency order. Each phase ends in its own commit on owner instruction (no push), after its gates.

### Phase A — Chain-native dispatch and carry-over (smallest fix for W1/W2)

Scope:
- Commit the measured C2-fix-1/C2-fix-2 code, tests and the C2 measurement docs (the plan/matrix/HISTORY edits in this tree)
  first, as one commit, so the P24 baseline is clean.
- **Order rule (C2-fix-3):** in `mode=exploit`, refuse to dispatch a task whose `work.claimRefs` cite a demonstrated claim unless
  at least one current plan row with `chainOf`/`step` also cites one of those claims (a link exists for the successor the task
  is taking). Scope: `role ∈ {discovery, exploit}`; exempt `role=validation`, `task.retestOf`, and tasks with no demonstrated
  claim refs. Refusal code `CHAIN_LINK_REQUIRED` naming the claim, the remedy (`p2o_goal_author` entry kind=todo with
  `chainOf/step/claimRefs/needs/effect` first, then dispatch) and the wall alternative (a decision/wall record) so a plan that
  does not want a chain is not forced into a fake one. Site: the dispatch handler in `extensions/p2o/index.ts` where
  `p2o_task_dispatch` resolves the task (the same place that already reads `candidateClaims` for brief facts, ~line 1120-1140),
  plus the matching refusal text/tests. No new tool, no schema change.
- **Multi-path `chainPlan`:** extend `chainPlan` (`extensions/p2o/index.ts:525-568`) from `chainJoin.frontier[0]` to
  `slice(0, 3)` ready paths: write todos for each, return `entries: entry[]` (bounded 3) instead of one draft, keep "nothing is
  dispatched from this list", refuse by name when a path claim has no same-run record (today the whole chain goes flat). Tests
  pin the bound and the no-dispatch property.
- **Prompt truth:** `src/prompts.ts:182` says author-then-dispatch as the order; add the refusal name and the wall alternative
  in the same sentence so a model reading only the prompt knows the rule (within the recorded prompt-text ceiling; measure with
  `recon.test.ts` budgets).

Acceptance (hermetic): a dispatched discovery/exploit task citing a demonstrated claim with no link is refused with
`CHAIN_LINK_REQUIRED`; with a link it dispatches and the brief carries `CHAIN`/`CHAIN PATH`/`NEXT LINK` (existing
`brief-context.test.ts` shape); validation/retest tasks are never refused; `chainPlan` writes ≤3 paths and dispatches nothing;
the prompt-text budget holds; existing suites green. Live: C3 (§7) proves the rule in a real run.

### Phase B — Schema 8, projection, rebuild

Scope:
- `src/state/schema.ts`: version 8 + the three tables/indexes of §3.2; `src/state/store.ts`: `indexExploration` called beside
  `indexKnowledge` (`:450`), `explorationSnapshot()`, `rebuildExploration()`, health counters.
- `src/exploration-graph.ts` (new): the closed kind/rel/state vocabularies, the pure `deriveExploration(records)` projection,
  and the per-record delta used by the store. One derivation, two consumers, differentially tested.
- `src/state/legacy.ts` (new): the raw read-only reader of §3.8 for old stores/inheritance.
- Tests: schema-8 create/version fence (extend `assessment-store.test.ts:94-104` with 7→8 cases); projection determinism and
  idempotency (same packet twice = same rows, same bytes); differential `incremental === rebuild` over a generated record
  stream (records of every kind, supersessions, walled links, cases, goals); edge rules per record kind; unresolved-target
  counting; caps and overflow behavior; raw legacy reader refuses symlink/hardlink, foreign journal and out-of-bound rows.
  The digest node's round hook stays in Phase D (§3.5); Phase B ships the `digest` kind, its state vocabulary and its caps so
  Phase D adds the write site without another schema change.
- Docs: `docs/KNOWLEDGE.md` and `docs/ARCHITECTURE.md` gain the store-authority paragraph for the graph (derived, no model
  writes, never authority) and the schema-8 statement; `docs-truth.test.ts`-visible docs must not claim a verb that is not live.

Acceptance: full suite green including the new tests; `detect_changes` reviewed; no change to any existing record format; a
schema-7 store still opens read-only with `compatible:false`; an incremental projection equals `rebuildExploration()` in the
differential test; store size growth inside the caps on a 1,000-record fixture.

### Phase C — Read model, board verb, lineage tool, briefs

Scope:
- `p2o_board board=graph` overview + lineage page (§3.7), with `boundedResult` trimming; unknown id refused by name; a board
  page never writes.
- `p2o_graph action=lineage` for worker/validation/planner, 24 KiB trimmed, `p2o_graph` description ≤900 chars and the moved
  verbs stay unadvertised; no new tool count (surface stays 35 registered / 35 model-visible / 0 hidden).
- Planner round brief `exploration` section (§3.9, title "Exploration graph (derived)") with overview lines: counts,
  origin/goals, ready/waiting links joined from the board, recent facts, latest digest, inherited count; cap 1,024 B, last in
  `SECTION_ORDER` and first on `OMIT_ORDER`, and it renders nothing at all when the caller supplied no projection so every
  existing brief stays byte-identical.
- Worker brief ancestry block: up to three lines `ANCESTRY: fact#… ← intent#… ← link#…` and `NODE: …` for the claims a task
  cites (two claims at most, reader-capped at ≤480 B / ≤240 chars per line), appended after the chain block; omitted when no
  graph row resolves; never replaces the plan-row chain block.
- Tests: board overview/lineage within 24 KiB under a dense fixture and over a floor it refuses by name; brief section stays
  inside the 8 KiB total and is omitted first under pressure; ancestry block absent/present/omitted; declaration budget and
  surface audit unchanged or re-pinned by the owner only; docs updated (`docs/USAGE.md` board list, `docs/PLANNER_ENGINE.md`
  context section, `docs/KNOWLEDGE.md`).

Acceptance: `node scripts/audit-surface.mjs --json` shows 35 registered / 35 model-visible / 0 hidden / 10 tool verbs and every
role total ≤ its pinned ceiling; `context-budget.test.ts` green; `round-brief.test.ts`/`brief-context.test.ts` green; a graph
page cannot exceed 24 KiB; docs-truth green.

### Phase D — Digests, inheritance, report

Scope:
- Round digest hook (§3.5) at the round-open site and at stop; `digest` nodes and `covers` edges; `p2o_board board=graph` lists
  digests and the latest one is in the planner section; `p2o_graph action=lineage` can root on a digest id.
- Inheritance loader (§3.6): reuse of the existing `--refer-workspace`/`priorRunsOnTarget` selection (no second discovery
  path), manifest match by target identity, raw-reader derivation for schema-7 sources, trimming,
  `inherited_from` marking, one overview line; `p2o.inheritGraph` setting + `--no-inherit` + manifest record; tests for the
  trim, for "never authority" (inherited claim does not make a chain step ready, does not satisfy a goal, does not appear in
  completion or readiness), and for the off switch.
- Report `## Attack graph — recorded ancestry, bounded` in `src/report-export.ts` after `attackPathSection`: graph counts, per-round
  digest timeline (round, records/nodes/edges added, facts/findings/links, ≤2 text lines each, ≤20 rounds + omitted count),
  ancestry for each accepted current case (lineage summary `origin → goal# → link# → intent# → fact# → finding#`, depth ≤6,
  ≤10 rows per case, ≤20 cases), and the inherited-graph line; labels "derived projection, not evidence; only the recorded
  receipt/rating is evidence" so it can never read as a path claim. Absent when the run recorded no graph row (byte-stable
  reports for old fixtures).
- Tests: digest per round from a fake round sequence (including an empty round), `covers` membership and `coversTruncated`;
  inheritance trim/never-authority/off switch; report section bounded and byte-stable when absent; `attack-path.test.ts`
  byte parity for prior fixtures.

Acceptance: a run of the fixture harness shows digest nodes for every round; the report has the section when the run has graph
rows; inherited rows never flip a readiness/proof/rating assertion in tests; 24 KiB page holds on a dense fixture.

### Phase E — Exploitation strength

Scope:
- **Exploit brief from the graph**: `exploitBriefBlock` (`src/prompts.ts:385-401`) gains `ANCESTRY` (from §3.7, for the
  claims the ticket cites) and `NEXT LINK` remains from the chain board; `TARGET FACTS` stays the bounded slice. Byte caps are
  measured, no duplication with `== CHAIN CONTEXT ==`.
- **Chain-frontier in the planner brief**: the ready section already lists ready/waiting steps; add the graph-overview line
  "Ready frontier: N link(s) ready, M waiting, K unchained primitives (graph)" derived from board+graph so the planner sees the
  same frontier the worker brief will name; cap stays inside the existing `ready` section.
- **Case-chain ↔ graph join in the report**: the ancestry block of each accepted case chain is printed from the persisted graph
  when the nodes exist, and from the case rating fields otherwise; no claim of execution is added from graph rows.
- **Completion/debt wording**: `PRIMITIVE_UNCHAINED`/`CHAIN_READY` stay the same codes (`src/completion.ts:18-47`); the text gains
  the graph node id of the primitive/link so the operator can open `p2o_board board=graph id=…`. Existing `GRAPH_UNREVIEWED`
  debt kind (`src/debt.ts:31`) is the only "unreviewed graph" signal; no new completion code.
- **Live C3** (§7): the exploit-mode run that exercises Phases A–E.

Acceptance: hermetic tests for the brief/report strings and bounds; C3 measurement (§7) records link-before-dispatch, the
ancestry line in the successor brief, `p2o_board board=graph` lineage for the executed chain, digest rows per round, report
section, and either an executed effect or the recorded absence; zero out-of-scope actions.

### Phase F — C4 cross-run measurement and optional old-run upgrade

Scope:
- **C4** (§7): a second authorized run in the same project reads the inherited graph; measurement: inherited node/edge counts,
  the overview line in the planner brief, and proof that no inherited row changed readiness/proof/rating; a clean `/p2o stop`.
- Optional, only on a separate owner decision after C4: the explicit `/p2o store upgrade` command of §3.8 (verified backup,
  refuses active writer, metadata row, rebuild via the same derivation) if the owner wants old runs graph-readable. Not shipped
  by default.
- Docs: matrix rows F-P24-A…/F-P24-B… matching the landed behaviors (each row cites existing test titles — the matrix guard
  `tests/minimal/acceptance-matrix.test.ts:11-27` refs real tests); HISTORY rows per commit; README/ARCHITECTURE/KNOWLEDGE
  surface text if a verb/behavior changed; plan §10 rows completed.

Acceptance: C4 report and measurement recorded; matrix/HISTORY rows exist and cite real tests; no push; no commit without a
fresh instruction.

## 5. Test matrix (planned; names are the intended titles, not landed ones)

| Area | Test file | Intended assertions |
|---|---|---|
| Schema 8 | `tests/minimal/assessment-store.test.ts` | version fence accepts 8, refuses 7 writable with the exact message, read-only 7 keeps `compatible:false` and `records()` refuses, unknown versions unchanged; the three `storeVersion: 7` create-ACK literals move to `8` (`tests/minimal/assessment-store.test.ts:25`, `tests/minimal/state-adapter.test.ts:32`, `tests/minimal/visibility.test.ts:89`) and the version loop (`assessment-store.test.ts:98-107`, `[3,4,5,6,77]`) gains `7` as an incompatible case |
| Recover across schemas | `tests/minimal/assessment-store.test.ts`, `tests/minimal/workspace-runtime.test.ts` | pins that a schema-7 run reopened writable by a schema-8 build fails by name through the existing refusal (`src/state/store.ts:198`), not an SQLite error, with the fixture byte-identical afterwards and no migration attempted; `recover` (`extensions/p2o/index.ts:3918-3922`) and `--resume` (`:4125-4129`) surface their named messages |
| Projection determinism | `tests/minimal/exploration-graph.test.ts` | same packet twice = identical rows/bytes; node ids deterministic; no clock/network input |
| Differential replay | `tests/minimal/exploration-graph.test.ts` | incremental projection === `rebuildExploration()` over a generated stream (all 13 record kinds, supersessions, walled links, goals, cases) |
| Edge rules | `tests/minimal/exploration-graph.test.ts` | each rel from §3.4 on a minimal fixture; superseded claim record still resolves through `recordIds`; unknown target counted, not fabricated |
| Proves bound | `tests/minimal/exploration-graph.test.ts` | capability/case proof edge written on goal or source commit; scan bound recorded as `provesTruncated`; coverage proof writes no edge |
| Digest | `tests/minimal/exploration-digest.test.ts` | one digest per round, window boundaries by sequence, covers membership, empty round, 500-digest cap/supersede, stop digest |
| Inheritance | `tests/minimal/exploration-inherit.test.ts` | reuse of the existing `--refer-workspace`/`priorRunsOnTarget` selection (no second discovery path), manifest target match, schema-7 source through the raw reader, trim 400/800, `inherited_from` on every row, never satisfies readiness/proof/rating/completion, `--no-inherit` + manifest flag, absent prints "none" |
| Legacy reader | `tests/minimal/legacy-store.test.ts` | reads schema-7 records read-only; refuses symlink/hardlink, non-DELETE journal, version outside 7/8, oversized rows |
| Board graph | `tests/minimal/workspace-runtime.test.ts`, `tests/minimal/exploration-graph.test.ts` | `board=graph` overview/lineage, ≤24 KiB page, trim/`truncated`, unknown id refused by name, page writes nothing (snapshot byte-identical after reads) |
| Graph tool lineage | `tests/minimal/workspace-runtime.test.ts`, `tests/minimal/graph-response-bounds.test.ts` | `action=lineage` within 24 KiB, description ≤900 chars and moved verbs unadvertised, host clamps on direction/depth/limit, owner path equals the board page |
| Planner brief | `tests/minimal/round-brief.test.ts` | `exploration` section cap/order/omission, overview lines, absent input renders nothing, 8 KiB total |
| Worker brief ancestry | `tests/minimal/brief-context.test.ts` | ancestry block present for a cited demonstrated claim, absent without, ≤480 B, no duplication with `== CHAIN CONTEXT ==` |
| Dispatch order | `tests/minimal/authority.test.ts` / new `chain-dispatch.test.ts` | `CHAIN_LINK_REQUIRED` for discovery/exploit, allowed with a link, validation/retest exempt, wall alternative recorded |
| Multi-path chainPlan | `tests/minimal/chain-plan.test.ts` | ≤3 paths composed from the frontier, one chain per path with its todos, no dispatch, no flat chain when a step claim has no record |
| Report graph | `tests/minimal/attack-path.test.ts` | section bounded, digest timeline, ancestry rows, absent when no graph row (byte-stable), labels derived/not-evidence |
| Budgets/surface | `tests/minimal/context-budget.test.ts`, `surface-audit.test.ts` | 35 tools / 0 hidden / 10 tool verbs unchanged, every role ≤ pinned ceiling |
| Docs truth | `tests/minimal/docs-truth.test.ts` | current docs name only live verbs; graph/lineage text matches the implemented behavior |
| Eva guards | `tests/minimal/acceptance-matrix.test.ts` | every new F-P24-* row references an existing test title |

Gates for every phase (from `package.json:14-30`): `npx tsc --noEmit`, `vitest run`, `npm run build`, `npm run check:build`,
`node scripts/audit-surface.mjs --json`, `python3 scripts/validate_library.py`, `git diff --check` (owner files excluded), plus
GitNexus `impact` before each edit and `detect_changes --scope all` before each commit (the index must be refreshed first when
stale, as measured in P23/B1).

## 6. Files (planned write scopes; disjoint per phase)

| Phase | New files | Modified files |
|---|---|---|
| A | `tests/minimal/chain-dispatch.test.ts` | `extensions/p2o/index.ts` (dispatch refusal, chainPlan), `src/prompts.ts`, `src/chain-view.ts` (if a pure helper is needed), tests, docs |
| B | `src/exploration-graph.ts`, `src/state/legacy.ts`, `tests/minimal/exploration-graph.test.ts`, `tests/minimal/legacy-store.test.ts` | `src/state/schema.ts`, `src/state/store.ts`, `tests/minimal/assessment-store.test.ts`, `tests/minimal/state-adapter.test.ts`, `tests/minimal/visibility.test.ts` (the `storeVersion` literals), `docs/KNOWLEDGE.md`, `docs/ARCHITECTURE.md`, `docs/KNOWLEDGE_WORKSPACE.md` (K0/K2 recovery paragraph: a run is recoverable only by the build with the same schema version) |
| C | `tests/minimal/board-graph.test.ts` | `src/board-verbs.ts`, `src/state/graph-tool.ts`, `extensions/p2o/index.ts`, `src/round-brief.ts`, `src/prompts.ts`, `src/tool-policy.ts` (only if a role loadout changes — it should not), tests, `docs/USAGE.md`, `docs/PLANNER_ENGINE.md` |
| D | `src/exploration-digest.ts`, `src/exploration-inherit.ts`, `tests/minimal/exploration-digest.test.ts`, `tests/minimal/exploration-inherit.test.ts` | `extensions/p2o/index.ts` (round hook, settings, and the prior-run selection it reuses at `:396-425`, `:4138`, `:4550`), `src/exploration-view.ts` (only if the prior context line is extended), `src/round-brief.ts`, `src/report-export.ts`, `src/roles.ts` (setting), tests, docs |
| E | tests for brief/report wording | `src/prompts.ts`, `src/round-brief.ts`, `src/report-export.ts`, `src/completion.ts` (text only), `src/debt.ts` (text only), tests |
| F | C4 measurement notes | `docs/ACCEPTANCE_MATRIX.md`, `docs/HISTORY.md`, this plan's §10, README if the run flow changed |

The owner files (`AGENTS.md`, `pi-p2o-defense-vi.pptx`, `.transcribe_tmp/`) are never staged; no AI attribution; the repository
identity is `Nhom 03 <nguyentrongnhan06cm@gmail.com>`.

## 7. Live measurement plan (C3/C4)

Preconditions: Phase A landed and committed; schema 8 build loaded by `pi` (copy the changed files into
`~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o`, re-read the runtime digest at the consent dialog); authorization C1 unchanged
(§12) — a **fresh owner instruction** is required to start another run (the C1 validity clause); model pinned to
`opencode-go/deepseek-v4.1-flash` (owner policy) with `/multi-account reset` if a cooldown blocks it; 2 workers, target-ops 2,
round-steps 30; stop on `/p2o stop` at budget or on target instability.

- **C3 (exploit mode, chain-native):** objective text asks for one chained effect where the successor is dispatched only after
  its link exists and its brief names the chain the attempt belongs to. Expected observations, all recorded from the store:
  (a) the dispatch order refusal fires if the planner tries to skip the link; (b) the successor's brief carries `CHAIN`/`CHAIN
  PATH`/`NEXT LINK` and the graph `ANCESTRY` line; (c) `p2o_board board=graph id=<case|claim>` returns the lineage sub-DAG;
  (d) a digest node exists for every round; (e) the report has `## Attack graph`; (f) either an executed chain step with an
  effect and a receipt, or the recorded absence (a wall, a refusal, a budget stop) stated as a finding. A run that does not
  execute is still a valid measurement as long as each mechanism above is observed or its absence is explained.
- **C4 (cross-run reuse):** a second run in the same project/state root after C3, started with `--refer-workspace latest`;
  expected: inherited counts printed once in
  the overview, `board=graph` pages show `inherited:true` rows, and no inherited row altered a readiness/proof/rating assertion
  (checked by the same tests the hermetic suite runs plus a re-read of the C4 store).
- Measurement queries (as in P23 §12): chain links via `records where body like '%chainOf%'`; tasks via `kind='task'`; A2 via
  grep of worker sessions for `CHAIN PATH`; new: `exploration_nodes/edges` counts by kind/rel, digest rows per round, lineage
  page bytes from the tool result, inherited counts. Routes: `p2o_board board=graph`, `p2o_graph action=lineage`.
- A measurement that shows the graph page over bound, a projection/rebuild mismatch, or an inherited row affecting authority is
  a P24 defect and blocks Phase F, not a note.

## 8. Risks and mitigations

| # | Risk | Mitigation / decision |
|---|---|---|
| 1 | Schema bump breaks existing stores | schema-7 stays readable read-only (existing rule kept); no implicit migration; rebuild is a test-visible method first; legacy reader is read-only and guards symlink/journal; upgrade is explicit and deferred |
| 2 | Incremental projection drifts from replay | one derivation, two consumers, differential test over generated streams; `rebuildExploration` used by the test as the oracle |
| 3 | `proves` evaluation makes writes O(goals×facts) | hard scan caps (200 goals / 500 facts / 100 findings), `provesTruncated` recorded; full evaluation on rebuild and on the report's existing resolver |
| 4 | Graph reads break the 24 KiB / 8 KiB bounds | every page uses `boundedResult`-style trimming with `truncated`/omitted counts; a page that cannot fit refuses by name; dense-fixture tests press the bound |
| 5 | Declaration budget is tight (~451 chars planner headroom) | no new tool; one board name + one graph action; reuse existing schema prose; measure with `audit-surface --json`; if over, trim duplicate description text in the same edit and only then ask the owner to re-pin with before/after (D-S1-5) |
| 6 | Test surface grows a lot | phases are disjoint; each phase extends named existing files plus one new file; matrix guard keeps rows honest; no skipped tests and no deleted assertions |
| 7 | Inherited graph contaminates authority | `inherited_from` rows excluded by construction from readiness/proof/rating/completion/brief actionable lines; dedicated never-authority tests; C4 re-read |
| 8 | Digest ambiguity (host vs model narrative) | digest body is host-derived from records with fixed schema; no model text; `text` is a host sentence; `covers` edges are the membership truth |
| 9 | Provider quota / drift during measurement | practice model `opencode-go/deepseek-v4.1-flash` only; `/multi-account reset` on cooldown; stop on usage limit and record the block as a finding (measured in C2 run 1) |
| 10 | Live target instability or a scope edge | stop rules from C1 §12 (destructive/availability etc. prohibited); `/p2o stop`; report the absence instead of extending scope |
| 11 | Old P23 references break | this plan states the recovery path (`git show 2448ca4:planning_update.md`); HISTORY/matrix keep the P23 rows; docs citing the plan are updated in Phase C/D where their subject changes |
| 12 | Graph becomes a second source of truth for the agent | graph is read-only in tools; no tool writes nodes/edges; report and brief label everything `derived`; readiness/proofs/ratings keep their existing resolvers |

## 9. Non-goals and explicit refusals

- No UI/web app: p2o's surfaces remain the terminal, the board/read verbs, the report and the bundle. ARTEX's graph canvas is
  not copied.
- No model-authored graph writes: no `p2o_graph` action adds a node or edge; a model cannot assert lineage.
- No graph-derived authority: no inherited/projected row can satisfy readiness, a goal proof, a case rating, a coverage cell or
  completion.
- No raw SQL or generic graph query tool; the bounded reads in §3.7 are the whole surface.
- No change to the evidence ladder, case rating rules, coverage derivations or the chain readiness rules in this plan; P24 adds
  a read model and fixes one dispatch-order gap.
- No in-place schema migration in the open path; no bundle/checkpoint format change in v1, and no claim that a bundle import
  rebuilds a store (it keeps files as artifacts, `src/state/bundle.ts:175-198`); the exploration tables are rebuilt only by the
  in-store replay method and, optionally later, by the explicit upgrade command.
- No push and no commit without a fresh owner instruction; no live run without a fresh instruction under C1's validity clause.

## 10. Records

| Tranche | Date | Commit / run | Commands and results | Not done / next |
|---|---|---|---|---|
| P24 plan | 2026-10-30 | docs record (this file) | Owner chose package B after the ARTEX evaluation; this plan replaces the P23 plan of record; P23 recoverable at `git show 2448ca4:planning_update.md`; no P24 code written | Phase A |
| P23/C2 rerun (carried) | 2026-10-30 | `run-11badbea-c08b-4d45-be7e-9b891a66064c` on the C2-fix-1/2 build (`4396de5333ef`) | A2 lines rendered live for the first time on two chain-owned briefs (blocked and settled chains); 2 plan chains / 2 links; 0 accepted cases; 0 executed effects; measured order defect (successor dispatched 12:19:08Z, link authored 12:30:04Z, walled 12:30:20Z); 377 records / 1,288 events, 9 rounds, flash-only; report `~/tmp/p2o-live-c2d/.p2o-reports/report-run-11badbea-…-final/` | Phase A (C2-fix-3 order rule) |
| P24/A | 2026-10-30 | commit `df57acd` | `CHAIN_LINK_REQUIRED` order rule (`chainLinkGap`), multi-path `chainPlan` (≤3 paths, dispatch none), prompt sentence; new `chain-dispatch.test.ts`; tsc clean, suite 169 files pass / 5 skip (174), 1,497 pass / 13 skip (1,510), 0 fail; surface 35/35/0, 10 verbs, declarations unchanged (planner 45,049 / worker 40,935 / validation 40,124 / reporting 6,282); planner prompt 16,692/16,700 | Phase B |
| P24/B | 2026-10-30 | commit `aad1622` | Schema 8 (`exploration_nodes`/`edges`/`anchors`), pure `deriveExploration` + per-record delta, `indexExploration`/`explorationSnapshot`/`rebuildExploration`/`explorationHealth`, raw read-only `src/state/legacy.ts`; new `exploration-graph.test.ts` (13) and `legacy-store.test.ts` (6); differential incremental === rebuild; 1,000-record fixture 1,001 nodes / 1,500 edges, overflow 0; tsc/build/check:build clean, suite 171 files pass / 5 skip (176), 1,516 pass / 13 skip (1,529), 0 fail; surface and declarations unchanged; `validate_library.py` PASS 336; schema-7 stores stay read-only `compatible:false` (version fence extended with 7) | commit on fresh instruction; Phase C |
| P24/C | 2026-10-31 | working tree (commit awaits owner instruction) | §3.7 read model: pure bounded snapshot readers (`explorationOverview`, `explorationFrontier` joined to `chainBoard`, `explorationLineage` up/down/both, `explorationAncestryLines`, `renderOverviewLines`), store `explorationPage` resolving a node/record/plan/task/case/claim id; `p2o_board board=graph` overview + lineage page and `p2o_graph action=lineage` (host depth 6 / limit 60 / 24 KiB tail-first trim, description still ≤900); round-brief `exploration` section (1,024 B, last in order, first omitted, absent input renders nothing so existing briefs stay byte-identical); worker `ANCESTRY` block ≤480 B appended after the chain/exploit block; tests +13 (exploration-graph 18, round-brief 20, brief-context 15, workspace-runtime live board/tool read, graph root-object pins); tsc/build/check:build clean; suite 171 files pass / 5 skip (176), 1,527 pass / 13 skip (1,540), 0 fail; surface 35/35/0, 10 verbs; declarations planner 45,471/45,500, worker 41,213/41,400, validation 40,402/40,500, reporting 6,282/6,500; `validate_library.py` PASS 336; detect_changes 18 files / 257 symbols / 54 flows (risk critical: additive edits on hub handlers and the brief), no partial/truncated; docs USAGE/PLANNER_ENGINE/KNOWLEDGE updated | commit on fresh instruction; Phase D |
| P24/D | — | — | — | planned |
| P24/E | — | — | — | planned |
| P24/F | — | — | — | planned |

## 11. Owner decisions recorded (2026-10-30)

1. **Package B.** After the two-run C2 measurement and the ARTEX comparison, the owner chose "Persist exploration graph"
   (schema 8, auto-edges, digest records, inherited graph, bounded graph read tools) as the way to make the chain emergent and
   the exploit loop stronger.
2. **Plan file.** The owner instructed that this update plan be written into the plan file, replacing the current plan of
   record; this document is that replacement.
3. **Practice model (carried from P23 §11 #9).** Only `opencode-go/deepseek-v4.1-flash` in practice; a provider usage limit is
   a stop-and-wait, never a reason to drift to another provider.
4. **Commit/push.** No commit and no push happen on the strength of the plan; each phase's commit waits for a fresh owner
   instruction, and the uncommitted C2-fix-1/2 work is the first candidate (Phase A) once that instruction is given.
5. **Live runs.** C3/C4 start only on a fresh owner instruction under the C1 validity clause; the authorization recorded in P23
   §12 (host `https://ise.uit.edu.vn/` only, default ladder minus `availability-loss`, the prohibitions and volume limits)
   carries no automatic renewal.

## 12. Evidence and anchors

- **C2 runs:** `run-38e983c0-3853-4992-adda-fd0d73a4f868` at `~/tmp/p2o-live-c2/.p2o-state/…` (report
  `.p2o-reports/report-run-38e983c0-…-final/`); `run-11badbea-c08b-4d45-be7e-9b891a66064c` at
  `~/tmp/p2o-live-c2d/.p2o-state/…` (report `.p2o-reports/report-run-11badbea-…-final/`, sessions under
  `~/.pi/agent/sessions/--home-nhanlaptop-tmp-p2o-live-c2d--/`, A2-bearing sessions opened 12:32:18Z and 12:53:10Z). The
  C2-fix-1 verification replayed the first store copy through `chainBoard`/`chainBriefFor`.
- **ARTEX reference:** `~/artex/ARTEX` (`e6ec569`); node/edge model `db/schema.sql:170-281`; edge writes
  `agent/tools.go:1078,1345-1347,1467,1183`, `db/finding_traffic.go:376`; per-round projection
  `agent/tools.go:354-585`, `agent/planner.go:382`; lineage `db/exploration.go:1027-1086`, `server/server.go:2217-2251`;
  digests `db/digest.go:17-215`, `agent/compaction.go:104-110`; graph page `server/server.go:2492-2529`; live task #22
  numbers in §2 (184 nodes / 269 edges; finding #715 lineage 27 nodes / 37 edges).
- **Plan-time repository gates:** HEAD `2448ca4`; tsc clean; full suite 168 passed / 5 skipped files (173), 1,490 passed / 13
  skipped tests (1,503), 0 fail; `npm run build` + `check:build` green; surface audit 35/35/0, 10 tool verbs, 0 contradictions;
  declarations planner 45,049/45,500, worker 40,935/41,400, validation 40,124/40,500, reporting 6,282/6,500;
  `validate_library.py` PASS 336; GitNexus index refreshed (`node .gitnexus/run.cjs analyze --index-only`).
- **Prior-run and inheritance anchors:** `--refer-workspace` grammar `extensions/p2o/index.ts:126`; `openHistorical`
  `:384-390`; `priorRunsOnTarget` `:391-425` (cap 20, manifest target match on kind/display); reference notice `:4176`;
  `deriveReferenceGaps` `:427`, used `:4550`; prior context `src/exploration-view.ts:171-200`; store open/reopen
  `src/state/store.ts:173-204`; `recover` opens writable `extensions/p2o/index.ts:3913-3922`; bundle export/import
  `src/state/bundle.ts:47`, `:175` (import keeps files as artifacts, never rebuilds the store —
  `tests/minimal/bundle.test.ts:124` pins `graphSummary().assets === 0` after import).
- **Schema-bump and docs anchors:** `storeVersion` literals `tests/minimal/assessment-store.test.ts:25`,
  `tests/minimal/state-adapter.test.ts:32`, `tests/minimal/visibility.test.ts:89`; version fence
  `tests/minimal/assessment-store.test.ts:98-107`; `docs/ARCHITECTURE.md:223` (persistence paragraph, schema number),
  `docs/KNOWLEDGE.md:93` (schema-7 knowledge paragraph), `docs/KNOWLEDGE_WORKSPACE.md:28` (K6 row), `docs/USAGE.md:177-197`
  if a command/flag is added; `docs/HISTORY.md` keeps its historical rows and gains a P24 row only.
- **Code anchors:** schema `src/state/schema.ts:2-106`; commit path `src/state/store.ts:335-470`; knowledge projection
  `src/state/store.ts:357-366`, `src/context.ts:49`; knowledge tables `src/state/schema.ts:40-51`; store open/refusal
  `src/state/store.ts:173-204`; bundle `src/state/bundle.ts:47,175`; graph limits `src/state/graph.ts:13-33`; graph tool
  `src/state/graph-tool.ts:45-103`; board `src/board-verbs.ts:36-39,89`; board dispatch
  `extensions/p2o/index.ts:3073-3096`; bounded helpers `extensions/p2o/index.ts:292-312`; round brief
  `src/round-brief.ts:33-62,612-630`; graph projection in the round brief `extensions/p2o/index.ts:676-713`; worker brief
  `src/prompts.ts:380-425`; chain core `src/chain-view.ts:57`, `src/chain-board.ts:77`, `src/chain-brief.ts:48`; chainPlan
  `extensions/p2o/index.ts:525-568`; planning schema `src/planning.ts:22-41,96-110,187-195`; case chain
  `src/case-types.ts:27-39`, `src/case-chain-view.ts:99`; report `src/report-export.ts:495-547`; completion
  `src/completion.ts:18-47`; goal proof `src/goal-proof.ts:1-40`; project knowledge `src/project-knowledge-db.ts:1-45`;
  tool policy `src/tool-policy.ts:24-67`; ceilings `tests/minimal/context-budget.test.ts:44`,
  `tests/minimal/surface-audit.test.ts:18,48`; doc guards `tests/minimal/docs-truth.test.ts:20-27`,
  `tests/minimal/acceptance-matrix.test.ts:11-27`.

## 13. Runbook (build, gates, measurement)

1. **Build under test:** copy the changed source files into `~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o` after every code
   change; the consent dialog prints the runtime digest — confirm it changed and record it.
2. **Gates before each commit:** `npx tsc --noEmit`; `npx vitest run`; `npm run build`; `npm run check:build`;
   `node scripts/audit-surface.mjs --json`; `python3 scripts/validate_library.py`; `git diff --check` (only the changed files);
   GitNexus `impact` pre-edit and `detect_changes --scope all` pre-commit (refresh the index when stale). No gate may be
   weakened: no deleted assertions, no new skips, no raised ceiling without the owner's measured re-pin.
3. **C3 start (only on a fresh owner instruction):** `/p2o --target https://ise.uit.edu.vn/ --mode exploit --goal "<chain-native
   objective from §7>" --avoid "No destructive or availability-impacting action" --avoid "No persistence, no anti-forensics, no
   evasion beyond minimal proof" --avoid "No bulk user-data access or exfiltration; minimal proof only" --avoid "No credential
   theft beyond an owner-designated test account" --avoid "No lateral movement off ise.uit.edu.vn" --workers 2 --target-ops 2
   --round-steps 30 --export`; confirm the consent dialog (scope, ladder, mode, digest, model) with Enter; verify the status line
   says `(opencode-go) deepseek-v4.1-flash`. **C4** repeats the same command after C3 with `--refer-workspace latest` added and
   everything else unchanged; its measurement is the inherited-graph evidence, so do not hand-pick a run id.
4. **During the run:** watch for the dispatch-order refusal (it is the rule firing), the successor brief's `CHAIN`/`ANCESTRY`
   lines, the digest counts and `board=graph` lineage; stop with `/p2o stop` at budget, at the first out-of-scope temptation, or
   when the chain evidence is complete; never let the model drift to another provider.
5. **After the run:** freeze the report, copy the measurement rows into §10 and the matrix/HISTORY on owner instruction, run
   the same queries as §12, and compare against §7's expected observations. Record absence as a finding; do not claim an effect
   the receipt does not show.
