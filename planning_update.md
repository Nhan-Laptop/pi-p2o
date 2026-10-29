# P20 — The knowledge projection layer: lineage, learnings and the write-back contract (plan of record, 2026-10-29)

Status: **planned, nothing implemented yet.** P19 is delivered (three commits, §0) and its documentation pass is written but
still uncommitted (§0.3). P20 addresses the second half of the owner's original question — "why can ARTEX run for hours?" —
now that the first half (a fresh session per round, P18.1/D45 + P19/H) is done. The owner chose to plan **A + B + C** with
schema changes allowed where the projection genuinely cannot be derived, and to treat **both** multi-hour continuity and
cross-run readiness as priorities (D-P20-1..3). No live or paid run is authorized (D-P20-4). Base commit `46db381` plus the
uncommitted P19 documentation pass; the owner's `AGENTS.md` edit and the untracked `pi-p2o-defense-vi.pptx` are outside this
plan.

Owner request that produced this plan (2026-10-29, Vietnamese, abridged):

> "…tại sao artex có thể đi qua được nhiều giờ liền thứ nhất: vì mỗi lần planner là một session khác nhau và nó sẽ đọc lại
> những phần cũ, nên coi như round mới. Thứ 2 bộ khung assets-graph và vulns-graph nó rất chắc chắn - bộ skill đề connect
> các graph hướng dẫn rất chi tiết. Ok thì bây giờ điều đầu tiên chúng ta đã làm được rồi bây giờ tôi cần bạn nhìn nhận lại
> phần thứ 2, chúng ta đã làm được những gì và có những lợi thế hay khuyết điểm nào từ đó có cần nâng cấp phần này so với
> ARTEX không. Hãy giúp tôi thực hiện một cuộc phân tích, inpect toàn diện, deeply và từ đó đưa ra hương phát triển."

Follow-up request (same day): write the whole new plan into this file, replacing the previous content, and ask in chat for
anything still unclear. The P19 plan of record, decisions D-P19-1…D-P19-9 and the verification record it carried are
preserved in git (`git show 46db381:planning_update.md`); D-P19-10 and the P19/G→P19/H rename existed only in the
uncommitted pass this file replaces, and are summarized in §0 so no delivered fact is lost.

Research inputs: the owner's local ARTEX snapshot `~/tmp/ARTEX` (Go backend + `norma` SDK, AGPL-3.0, version 0.3.15,
commit `e6ec569`; `my_references/ARTEX/` is an older gitignored copy and was not used); the shipped p2o tree at base commit
`46db381`; three read-only deep audits of p2o's graph/claim layer, of ARTEX's knowledge layer, and of p2o's skill/prompt
teaching layer, cross-checked by the lead against the code. Every file:line below was read, not quoted from another audit.

---

## 0. What P19 delivered (recap, not reopened)

1. **Round-session model (P18.1/D45, verified by P19/H).** Every planner round opens in a fresh Pi session, and continuity is
   the deterministic round brief built from the ledger (≤8 KiB, per-section caps, own section list), not a transcript.
   `p2o.roundSessions: true` is the default; `false` keeps the round in the current session as a follow-up and gives up the
   brief. Documented in [docs/USAGE.md](docs/USAGE.md) and [docs/PLANNER_ENGINE.md](docs/PLANNER_ENGINE.md).
2. **Three P19 tranches delivered.** `a5c6aaf` P19/A+B3+F (validation dispatch, runtime profile, dispatch refusals),
   `5d08c06` P19/C+D+E (a recorded wall is progress, debt backlog is a planning signal, measurable goal proof and the blocked
   settle), `46db381` P19/H (the stale-`ctx` progress render that exited `pi`; the commit subject says "P19/G" because the id
   was corrected to P19/H after the commit, and history is not rewritten for that). Acceptance rows F-P19-* and the P19 rows
   in [docs/HISTORY.md](docs/HISTORY.md) carry the details; the P19 verification numbers (tsc, 154 files / 1,365 tests, build,
   audit-surface, GitNexus) are in git at `46db381:planning_update.md` §7.
3. **Uncommitted documentation pass (D-P19-10).** The round-session model, the `roundSessions` setting, the debt split, the
   blocked-goal settlement and the P19/H crash symptom were added to `docs/USAGE.md`, `docs/HISTORY.md`,
   `docs/PLANNER_ENGINE.md`, `docs/ACCEPTANCE_MATRIX.md`, plus comment-only renames in `extensions/p2o/index.ts` and two test
   files. It is verified (doc suites green) but **not committed**: the next commit needs its own owner instruction (D-P20-4).
   This file replaces that pass's `planning_update.md` edits and keeps their substance in this section.

---

## 1. The finding this plan is built on

ARTEX runs for hours because it **externalizes state and re-derives context every round**, not because its graphs are richer
than p2o's. Its assets graph is structurally thinner than p2o's (one wide six-type table, no asset→asset edge table, mutable
rows), its exploration graph is a mutable node/edge store, and its evidence layer is materially weaker than p2o's (goal proof
is an edge write, evidence is free text, there is no immutable ledger or independent replay). What ARTEX does better is the
**projection**: each wake receives a bounded, self-describing knowledge view — recent facts and findings with the intent that
produced them, intent parents/yields, hints, cold digests, truncation totals — and its prompts and tool descriptions teach the
model how to write into that view. p2o has more trustworthy knowledge and a much stronger coverage/evidence model, but its
round projection is obligation-shaped ("what is owed") rather than knowledge-shaped ("what was learned, from where"), and its
teaching layer barely mentions the graph.

So the second half is **not** "make the asset graph stronger". It is: expose the knowledge p2o already records as a bounded,
lineage-aware projection, and teach the model how to keep the links current. This plan does that in three tranches: a
derived-on-read projection (A), a write-back/navigation contract (B), and — only where a projection cannot synthesize the
fact — a minimal additive provenance change (C). A supporting documentation-truth item (D) and a small cross-run readiness
sub-item (A5) complete the owner's "both priorities" choice.

---

## 2. Evidence: what each side actually has

### 2.1 ARTEX asset graph (one wide table, no relation model)

`db/schema.sql:40-103`: six types in one `assets` table (`root_domain|ip|subdomain|app|service|endpoint`) with per-type
nullable columns and seven partial unique indexes for dedupe. Upsert keeps existing non-null scalars, appends arrays with
DISTINCT, unions `task_ids` and bumps `last_seen` (`db/assets.go:295,760-766,1017-1024`). There is **no asset→asset edge
table**; containment is derived at query time (`db/task_scope.go:304-390`). Provenance is per task↔asset link
(`task_asset_links`, `db/schema.sql:648-660`), not per row, and asset columns are last-write-wins with no revision history.
Enrichment is operational and rich (technologies, params, auth, favicon, ports, company/scope, intercepts), which is the part
p2o does not match.

### 2.2 ARTEX exploration graph, edges and anchors

`db/schema.sql:153-286`: `exploration_nodes` with CHECKed kinds `begin|goal|intent|fact|finding|hint|digest` and a state set
per kind; `exploration_edges` with `spawns|derived_from|yields|proves|covers`, PK on all four columns and no self-edges;
`exploration_anchors(node_id, asset_id)`; `content_version` and `cold_since_round` on nodes. Direction is uniform: `From` is
upstream, `To` is downstream for every relation (`agent/coldgraph.go:10-13`). Anchors are explicitly lineage, "not
visibility" (`db/exploration.go:245-254`). Facts carry summary/detail/evidence and a self-declared `observed|inferred`
confidence, including negative results; hints are operator text with `active|consumed`; digests are LLM-folded cold regions
whose members stay restorable.

### 2.3 ARTEX's projection, trigger diff and cold digest

Every planner wake prefetches `graph_overview` into the user turn (`agent/planner.go:282-292,380-382,453-464`): goals, hints,
open/running intents, `recent_done_intents` **plus true totals** (`frontier_open`, `done_intents_total`), `recent_facts` (20,
each with `from_intent` and confidence), `finding_list` (10, each with `from_intent`), cold digest bodies (15) plus more ids,
coverage, root task and related tasks (`agent/tools.go:354-520`). Triggers spell out the actual change that fired the wake
(`agent/planner.go:173-280`). Cold regions are compressed after six quiet rounds with blocks of at least two nodes, via
`covers` edges and a background compactor, and enumerated members can be restored (`agent/coldgraph.go:34-42,91-131`;
`agent/compaction.go:40-100,180-257`; `db/digest.go:128-230`). The planner prompt supplies the hard baseline ("zero intents is
a stall unless the goal is met or work is running"), the one-recheck-then-respect rule for negatives, the serial-chain todo
discipline and a quantitative check before proving a goal (`agent/planner.go:129-143,303-305,312`).

### 2.4 ARTEX's teaching layer (a correction)

ARTEX ships **three** skills (`skills/api-recon`, `skills/playwright-cli`, `skills/scopesentry`). The detailed graph-connection
guidance lives in the role prompts — editable rows in `agent_prompts`, seeded from `agent/promptcatalog.go:110-122`, with the
DB row winning (`agent/prompt.go:38-53`) — and in tool descriptions. The worker prompt's "three write-backs, don't mix the
graphs" block (assets → `insert_assets`; conclusions → `record_fact` with `intent_id`; confirmed vulnerabilities →
`report_finding`; one merged fact per intent, incremental-only, suspicion stays an inferred fact) is
`agent/worker.go:230-243`, and the planner's `asset_ids`/`parent_ids` contract plus its host-side kind validation is
`agent/tools.go:1038-1100`. So the owner's memory of "very detailed connecting guidance" is correct, but it is a
**prompt/tool contract**, not a skill library.

### 2.5 What ARTEX lacks (so parity never justifies trading it away)

No deterministic goal proof (`prove_goal` links a node and sets `met`, `agent/tools.go:1176-1185`); free-text evidence with a
self-declared confidence (`agent/tools.go:1360-1373`); no immutable ledger (activity rows are deleted on intent cleanup and
goals are hard-deleted, `db/exploration.go:296-309,547`); no content uniqueness in the exploration graph; the serial-chain
todo store is in-process and dies on restart (`agent/planner.go:44-48`); coverage is a rough self-referential percentage
(`agent/tools.go:531`); digest bodies are unchecked prose.

### 2.6 p2o's knowledge layer today

| Layer | p2o has | Verdict against ARTEX |
|---|---|---|
| Asset graph | 12 kinds, **16 asset→asset relation kinds**, 7 anchor kinds, content-addressed identity, revision + `supersedes` + `expectedRevision`, host-stamped provenance, anchored evidence; `src/state/graph.ts:7-52`; caps in `:13-33`, schema `src/state/schema.ts:2,70-105` | Structurally **stronger** (real topology, revisions, provenance); weaker only in operational enrichment and cross-run accumulation |
| Graph access | `p2o_graph` reads view/query/summary/**path**/export (`src/state/graph-tool.ts:45-58`), worker `p2o_graph_record` batch, planner `p2o_graph_review` for one hypothesis/inferred relation (`:88-93`), `p2o_graph_plan` chain/ingest (`:99-110`), extractor ingest (`src/graph-ingest.ts`) | Read surface comparable; review loop narrower than "settle any assertion" |
| Facts/hypotheses | Assertions hang off **one asset** and cite evidence (`src/state/graph.ts:37-39`); stored `unverified:true`; no claim/task link; no review state (`src/state/store.ts:1109,1118`) | Weaker than ARTEX's intent-anchored facts: cross-cutting observations have no proper home |
| Claims/cases | Worker-only claims with closure/execution/proof, evidence + negative controls + limitations + policy basis, typed `gained`/`needs` capabilities, host-stamped `taskRef`/`assetRefs` (`src/evidence.ts:14-44,102-185`); cases with review independence, severity capped by chain depth, retest notes (`src/case-types.ts:43-50`; `src/cases.ts`) | **Much stronger** than ARTEX's model assertions |
| Coverage | Host-projected cells: asset × `questionKey` × policy × actor × tenant × method family, execution/assessment axes, refs, stale/retired, unmapped tasks, L0–L3 (`src/coverage.ts:45-51,103-158`; `src/coverage-types.ts:17-22`); 108 WSTG tests, 102 at support level D (`src/wstg-map.ts`, [docs/WSTG_MAP.md](docs/WSTG_MAP.md)) | **Much stronger**; the "assets graph + vulns graph" strength the owner remembered is real, it just is not projected |
| Plans/chain/tasks | Plan board goal/todo/decision with `claimRefs`/`needs`/`route`/`environmentRef`/`chainOf`/`step`/`debtRefs` (`src/planning.ts:17-39`), wall = deferred/blocked todo, capability-typed chain join derived on read with **no candidate→candidate edge store** (`src/chain-view.ts:1-8`), task identity with question/surface/risk/expectedTrue/False/stopCondition/prerequisites/validationOf/retestOf/parentTaskId (`src/tasks.ts:18`) | **Stronger** than ARTEX's in-process todo |
| Knowledge links | Rebuildable `knowledge_links` index: task→asset/prerequisite/parent/validation, case→asset/claim/task, coverage-cell→asset/claim/case/gap, **candidate→evidence only** (`src/context.ts:49-64`); it is used only to invalidate stale heads (`src/state/store.ts:358-371`) and has **no model-facing read** | Underused: the topology exists, unexposed and missing two candidate edges |
| Round projection | Brief 8 KiB with 13 sections and explicit caps (`src/round-brief.ts:30,40-43`); its graph delta is counts + up to 3 new assets + 3 findings + 2 hypotheses (`:364-376`); the worker gets a surface-keyed graph slice at dispatch (`src/graph-slice.ts:1-35`; `extensions/p2o/index.ts:1051,1411-1432`) | **This is the gap**: planner never sees recent facts/findings with their source intent or asset |
| Cross-run | `--refer-workspace` reopens prior runs, computes reference coverage/gaps and stores one lifecycle record (`extensions/p2o/index.ts:375,4007-4012,4406-4421`; `src/project-knowledge-db.ts:1-30` is export-only suggested context); neither is rendered into the round brief | Partially built, unprojected |

### 2.7 p2o's teaching layer today (measured)

- `src/prompts.ts` is ~2,098 non-comment words with one graph sentence ("Then read the board and graph", `:117`) and one
  write-back sentence (`:288`); the actionable read vocabulary lives only in the `p2o_graph` tool description and one boundary
  line (`src/tool-guidelines.ts:15`).
- The skill library is 38 skills / 255,705 B of methodology. It contains **zero** p2o tool names (checked with a repo-wide
  grep): skills are deliberately tool-agnostic, and their "surface IDs" are not graph identities — `p2o_surface` has no asset
  field (`src/records.ts:260-272`). The only bridge to the asset model in repo prose is `HANDOFFS.md:43,57`.
- `HANDOFFS.md` **is not injected into any prompt**: no prompt or extension text references it (`grep HANDOFFS src extensions`
  finds one comment in `src/wstg-map.ts:145`), and workers run `--no-context-files`. It is only a catalog document
  (`shared:handoffs`, `skills/catalog.json`) the model must know to open, so the role contract it holds is not in front of a
  worker by default.
- The worker brief drops information the host already validated: `taskCapsule` (`src/tasks.ts:569-572`) serializes asset refs,
  predictions and the stop condition, but it is used only for the planner context packet
  (`extensions/p2o/index.ts:4661,4663`); `workerBrief` (`src/prompts.ts:334`, called at `index.ts:1054`) receives the question
  text and a surface-substring slice instead. Workflow `steps/observe/wall` from the catalog never reach the brief
  (`src/prompts.ts:357-361` renders only id/description/prerequisites).
- Feedback is advisory only: `NO_GRAPH_WRITE`, `MAPPING_UNRECORDED`, `UNPROMOTED_COVERAGE_NOTE` (`src/finish-preflight.ts`).
- Dead handles in the teaching layer: nine skill files link `research/TOOLING.md`, which is not a catalog document, and the
  catalog's `HANDOFFS.md` points at `docs/EVIDENCE.md`, which is not one either. `p2o_skill_read` serves catalog documents, so
  a path-style link is not a handle the model can follow; the sectioned `research/evidence.md` is catalogued, which shows the
  fix is small.
- Three documentation claims contradict the code: [docs/KNOWLEDGE.md](docs/KNOWLEDGE.md) says the planner settles "a fact"
  (only a hypothesis or an inferred relation can be settled, `extensions/p2o/index.ts:3425-3431`), says the reporter "reads
  only" (the reporter has no `p2o_graph`, `src/tool-policy.ts:60`), and `src/finish-preflight.ts:53,55` tells the model to
  revise/retire a stale cell although projected cells have no model-facing writer (`src/tool-policy.ts:21`;
  `src/coverage.ts:171`).

### 2.8 The measured gaps this plan closes

- **G1 — the planner re-derives instead of remembering.** The brief is obligation-shaped; recent claims/findings with their
  source task and asset are not in it. (ARTEX prefetches exactly that.)
- **G2 — lineage is data, not a read.** Links exist as loose refs plus an unexposed index; `p2o_graph path` only walks the
  asset graph. "Why does this intent exist" takes several reads across three record families.
- **G3 — assertions are asset-bound and unverified forever.** A cross-cutting observation has no correct home, a fact cannot be
  settled, and a negative recheck is a heuristic (`src/evidence.ts:144-155`) with no recorded pair.
- **G4 — the write-back hygiene rules are untaught.** One sentence; no one-conclusion-per-intent, merge, incremental-only,
  suspicion-is-not-a-finding or cross-asset-spill rule like ARTEX's `agent/worker.go:230-243`.
- **G5 — the worker brief throws away structured handoff.** Asset refs, predictions, stop condition and workflow steps are
  dropped although already validated.
- **G6 — no per-asset "which questions are answered" projection.** The dossier lists at most ten cells and some booleans
  (`src/graph-dossier.ts:15,71-73`); no questionKey→answered/unanswered index; no signal for assets missing the `feature`
  attribute that makes WSTG tests applicable.
- **G7 — history is compressed only as ledger-record text.** The brief digest folds records (`src/round-brief.ts:497-521`), not
  knowledge regions. Deliberately low priority: p2o does not call a model during projection, and that trade-off is kept.
- **G8 — negative branches are not recorded as branches.** A wall is a plan row; the first and second negative are unlinked.
- **G9 — cross-run knowledge is stored but unprojected.** The reference record and the project-knowledge identities never reach
  the round brief.

---

## 3. Decisions

- **D-P20-1 — Scope is A + B + C (owner choice, 2026-10-29).** A: lineage/learnings projection. B: write-back and navigation
  contract. C: the minimal additive provenance that a projection cannot synthesize. D (documentation truth) and the A5
  cross-run sub-item are supporting items sized to the same owner choice ("both priorities").
- **D-P20-2 — Schema changes are allowed only when needed, additive, and in the existing store.** No second store, no
  duplicated ledger truth, no big-bang. Every added field must be read by a projection and covered by a migration test; the
  derived-on-read route is tried first (D-P20-6).
- **D-P20-3 — Both acceptance bars apply.** Multi-hour continuity (the projection answers "what was learned / why this intent"
  without tool spelunking) **and** cross-run readiness (referenced prior runs are visible, labelled context-only).
- **D-P20-4 — No live or paid run; no commit or push without a fresh owner instruction.** This inherits P19's D-P19-3/D-P19-10.
  The P19 documentation pass stays uncommitted until that instruction exists.
- **D-P20-5 — p2o's evidence layer is not traded away.** The evidence ladder, independent replay, deterministic goal proof,
  host-derived coverage and the immutable ledger stay exactly as strict after P20 as before it (inherits D-P19-1). ARTEX
  parity never justifies a model assertion replacing a host check.
- **D-P20-6 — No copy of ARTEX's exploration schema.** A parallel node/edge table that duplicates what the ledger already
  records is refused. New storage is either a rebuildable derived cache (like `knowledge_links`) or an additive field on an
  existing record; the store stays the single source of truth.
- **D-P20-7 — Documentation is part of the tranche, not a later pass.** The three known inaccuracies (§2.7) are closed in
  P20/D; no doc may describe a verb or a projection before it exists.
- **D-P20-8 — Every projection stays bounded and self-describing.** New sections have byte caps and print totals plus omissions;
  a truncated list must never read as "nothing more". The whole brief stays at 8 KiB, and the declaration/prompt ceilings are
  not raised casually (inherits D-P19-4).

---

## 4. Plan of record

Each item states the defect, the smallest change, observable acceptance, and what must not change. Ordered by impact per unit
of risk; A can land without B, C only after A proves where derivation stops.

### P20/A — Lineage and learnings projection (derived; the core)

- **Defect:** G1, G2, G9. The planner round is told what it owes but not what the run just learned, from which intent, on
  which asset; the topology to answer that exists in the ledger and in an unexposed index.
- **Change:**
  1. Extend the rebuildable knowledge index's candidate descriptor to carry the host-derived `task` (`data.taskRef`) and
     `asset` (`data.assetRefs`) links, and the plan descriptor to carry `claimRefs` as claim links (`src/context.ts:49-64`); no
     new table, same invalidation behavior. **Shipped.**
  2. New pure module `src/exploration-view.ts`: `recentLearnings(index, {since, limit})` (claims with closure/proof/source task
     and pinned assets, owner-accepted cases, walls with their debt ids; `since` is the ledger position the round window records,
     one row per claim slug), `lineageOf(index, id, {depth, limit})` (upstream and downstream over the descriptors the index
     derives: task prerequisites/parent/validation/retest, plan task/goal/claim refs, claim task/asset refs, case claim/task/asset
     refs, coverage cell refs; a target that is not a knowledge head is reported `resolved:false`, not dropped), `whyPlanRow(index,
     planId)` built on the same walk, and `priorRunContext(index)` for A5. Open hypotheses are not re-derived here: the brief's
     graph delta section is the one projection that already renders them, and a second copy would only spend bytes. No I/O, no
     model, no truth upgrade. **Shipped.**
  3. Round brief: a **learned** section (cap 900 B) filled from `recentLearnings`, displayed after the delta and dropped after it
     in the omission order, every line a label plus a record id, `shown`/`omitted` against the true count, and a
     background-only sentence; the total cap stays 8 KiB. **Shipped.**
  4. Surface `lineageOf` through a bounded read — either a new `p2o_graph` action (`lineage`) or a `p2o_board` view — only if
     the declaration audit shows room. It does (planner declarations 44,348 of 45,500), so A4 ships as one bounded
     `p2o_board board=lineage id=<planId|recordId>` page (≤24 KiB, rows trimmed tail-first with `truncated` set, labelled
     background) rather than a second verb; measured cost +222 chars of planner declarations (44,570/45,500). **Shipped.**
  5. Cross-run readiness (A5, read-only): reduce the `reference` lifecycle record (`extensions/p2o/index.ts:406,4417-4421`, the
     record shape written at run start) to run identities and covered/open/stale/never-reached/unknown counts, and render one
     bounded brief line labelled "Prior run (context only, never evidence)"; a run without the flag renders nothing, and
     project-knowledge identities stay lookup hints, not rows. **Shipped.**
- **Acceptance:** pure unit tests for `recentLearnings`/`lineageOf`/`whyPlanRow`; a brief test proves a new claim appears with
  its source task and asset without a tool call and fits the cap; a `--refer-workspace` fixture proves the prior-run line
  appears and carries the context-only label; nothing in it can satisfy a claim or a coverage cell. No schema change.
- **Must not change:** no second store; learned rows are background, never proof; brief ≤8 KiB; same-run references only.

### P20/B — Write-back and navigation contract (the teaching layer)

- **Defect:** G4, G5, and the dead/contradictory teaching references in §2.7.
- **Change:**
  1. One shared "Recording what you learned" document (~1.5 KB) reachable through the skill reader: the three write-back
     destinations (asset via `p2o_graph_record`; assertion `fact:observed|inferred`/hypothesis with evidence; claim via
     `p2o_candidate` plus a `no-new` note), one merged conclusion per intent, incremental-only, no re-recording an existing
     row, suspicion is a hypothesis or an inferred fact and never a finding, a cross-asset link is an assertion the planner
     can read.
  2. Replace the single write-back sentence in `src/prompts.ts:288` with a literal batch example (~900 B) and add two planner
     lines: read the learned section, settle what evidence allows with `p2o_graph_review`, do not re-derive what the section
     lists; name the lower-case WSTG id as `questionKey` when the question is a WSTG test (the `feature` attribute vocabulary
     is already in `src/prompts.ts:52`).
  3. Pass `taskCapsule` (`src/tasks.ts:569-572`) into `workerBrief`: asset ids, expectedTrue/expectedFalse/stopCondition and
     prerequisites, plus the catalog workflow's `steps/observe/wall` when present.
  4. Fix the observable defects: `p2o_note kind=coverage` no longer suggests it creates a cell; the nine
     `research/TOOLING.md` skill links and the catalog `HANDOFFS.md`'s `docs/EVIDENCE.md` link become handles the model can
     actually open (catalog document or a sectioned shared doc) or are removed; and the role contract HANDOFFS.md holds is
     injected into the worker brief instead of depending on the model choosing to open it.
  5. Keep every prompt inside the pinned ceilings (measured before P20: planner prompt 44,348 chars of 45,500, model union
     73,577 of 75,600): trim duplicates first, then record the measured delta; a ceiling increase is a separate owner decision.
- **Acceptance:** prompt-parity tests pin the new contract lines and the worker-brief capsule fields; a link check proves every
  referenced document is reachable; the surface audit still reports the same tool count and no contradiction; no authority,
  capability or evidence rule changes.
- **Must not change:** skills stay methodology-first (no target-tool instructions); no widening of authority; no new truth
  claim; ceilings respected.

### P20/C — Provenance a projection cannot synthesize (additive, only where proven)

- **Defect:** G3, G6, G8 support data does not exist. A and B can expose relationships, but not a fact's provenance, a
  recheck pair, a hint lifecycle, or a per-question answer index.
- **Change (each sub-item is independent; drop any the earlier tranches make unnecessary):**
  1. Optional `claimRefs`/`taskRef` on fact/hypothesis inputs plus review state (`reviewedBy`, `outcome`), settled by
     `p2o_graph_review` exactly as a hypothesis is today — additive store migration, same evidence requirements, dossier and
     brief read it.
  2. Negative-branch record: a second `ruled_out` claim names the first (`recheckOf`) and the host enforces the one-recheck
     bound; debt and the report read the pair instead of re-deriving it from scan order (`src/evidence.ts:144-155`).
  3. Hint lifecycle: an append-only ledger note (`data.hint`) with `active|consumed`, injected into the brief and the worker
     ticket; no graph node table (single source stays the ledger).
  4. Per-asset question projection: `questionKey → answered/unanswered` in the dossier and summary, derived from cells, claims
     and facts (pure read, no schema); plus an advisory "assets missing a `feature` attribute" signal for WSTG applicability
     (planning hint, never gateable debt — the P19/D split stays).
- **Acceptance:** an additive migration test that opens an old run read-only; a review settles a fact only with same-run
  evidence; the recheck bound is enforced by a test; a hint appears in the brief and in the worker ticket; the question
  projection answers the empty, partial and complete cases; capacities are unchanged in behavior.
- **Must not change:** the evidence ladder, coverage derivation, debt gateability and capacity ceilings. A stored hint or
  provenance row never becomes proof or authority.

### P20/D — Documentation truth pass (supporting)

- Close the three inaccuracies in §2.7 in the same change that makes each statement true (or reword it before the code lands).
- When each tranche lands, add its `docs/ACCEPTANCE_MATRIX.md` rows (F-P20-*), `docs/HISTORY.md` row and the USAGE/architecture
  text; no doc claims an unimplemented verb (D-P20-7).

---

## 5. Sequence and gates

1. **A1 + A2** — index links and the pure builders, with unit tests; no visible projection yet.
2. **A3 + A5** — brief learned section and the prior-run line; golden + byte-cap tests; measure the brief on a seeded round.
3. **A4** — decision point: measure the declaration budget, ship a `lineage` read only if it fits, otherwise defer.
4. **B2 + B1** — prompt contract and the shared document; ceiling audit; prompt-parity tests.
5. **B3 + B4** — worker brief capsule/workflow, the delivered role contract, and the defect fixes (coverage note, dead handles).
6. **C1 → C2 → C3 → C4** — each with its migration/read test; C4 (the per-asset question projection and the feature signal) can land independently of C1–C3.
7. **D** — documentation pass last, in the same change as the behavior it describes.

**Status 2026-10-29:** steps 1–3 landed (A1, A2, A3, A5, and the A4 bounded read); the verification record is §8. B, C and
the rest of D are still to do.

Every step: `npx tsc --noEmit`, the targeted vitest files, the full hermetic suite before a tranche closes,
`scripts/audit-surface.mjs`, `git diff --check`, and `detect_changes --scope all` before any commit. Commit and push happen
only on a fresh owner instruction (D-P20-4), with the repository identity and no attribution lines.

---

## 6. Acceptance bars

- **Multi-hour continuity:** after a worker claim lands, the next round's brief names the claim, its source task and its asset
  without a tool call; `whyPlanRow`/`lineageOf` answers "why does this intent exist" in one bounded read; the run still
  survives a session switch (P19/H) and the brief still fits 8 KiB.
- **Write-back hygiene:** the worker brief carries the validated handoff (asset ids, predictions, stop condition) and the
  workflow steps; the graph contract is one measured block reachable from the worker prompt; the dead handles are gone.
- **Cross-run readiness:** with `--refer-workspace`, the brief shows what prior runs covered and left open, labelled
  prior-run context only; no prior-run row is counted as evidence, coverage or authority; project-knowledge identities remain
  suggested context.
- **Non-regression:** full hermetic suite green; declared tool count and contradiction count unchanged; no live run needed;
  no authority, evidence or coverage semantics changed.
- **Not claimed:** target effectiveness stays UNVERIFIED until an allowed live run; P20 improves continuity and legibility,
  never detection.

---

## 7. Risks and refusals

- **Schema creep (C).** Additive only, same store, one field at a time, each read by a projection and covered by a test; if A
  already answers the question, the field is dropped.
- **Prompt-budget creep (B).** Trim duplicates before adding; never raise a ceiling without a measured number and a separate
  owner decision.
- **Projection bloat (A).** New sections pay for themselves from the existing caps; totals plus omissions are mandatory.
- **Truth creep.** A projection is background; a hint is not authority; a prior run is not evidence; a lineage edge is not
  proof.
- **Tempting but refused:** copying ARTEX's exploration-node store, replacing deterministic goal proof with a model judgement,
  storing a second coverage source, or making a hint/prior-run row gateable.

---

## 8. Verification record (to be filled as tranches land)

Per tranche, record here: the exact commands, tsc result, test counts (files/tests passed/skipped/failed), build/check:build,
audit-surface tool count and declaration chars, `git diff --check`, GitNexus `detect_changes` (files/symbols/flows,
partial/truncated flags), and the commit hash once the owner authorizes one. Do not record a live run here until one is
authorized (D-P20-4).

### P20/A — landed 2026-10-29 (uncommitted)

- **Code:** `src/context.ts` (candidate `task`/`asset` links, plan `claim` links), new `src/exploration-view.ts`
  (`recentLearnings`, `lineageOf`, `whyPlanRow`, `priorRunContext`, `lineagePage`), `src/round-brief.ts` (learned section,
  cap 900 B, section order/omission order, `BriefLearned` input), `src/board-verbs.ts` (`BOARD_NAMES` gains `lineage`),
  `extensions/p2o/index.ts` (`roundBriefing` passes the learned projection and the prior-run counts; `p2o_board
  board=lineage` handler; description sentence).
- **Tests:** new `tests/minimal/exploration-view.test.ts` (15); `tests/minimal/round-brief.test.ts` +3 (learned input, empty
  learned/prior-run text, truncation with shown/omitted) and updated section list/golden brief; `round-session.test.ts`
  asserts the learned section in both round openings; `workspace-runtime.test.ts` asserts the `--refer-workspace` reference
  record reduces to prior-run counts and that `board=lineage` answers a plan row and a record id (bounded, labelled, refuses
  missing ids by name).
- **Commands and results (repo root, 2026-10-29):** `npx tsc --noEmit` clean; `npx vitest run` → **155 passed / 5 skipped
  files (160), 1,384 passed / 13 skipped tests (1,397), 0 fail** (baseline before A was 154/5 files, 1,365/13 tests; +1 file,
  +19 tests, no deleted or skipped test); `npm run build` and `npm run check:build` → `build import OK`; `node
  scripts/audit-surface.mjs` → 35 registered / 35 model-visible / 0 hidden / 10 board verbs, 0 contradictions, planner 44,570
  chars of the 45,500 declaration ceiling (+222 for the bounded lineage clause; worker 40,124, validation 39,313, reporter
  6,282, model union inside 75,600 — `context-budget.test.ts` green); `git diff --check` clean (owner files excluded from any
  staging); GitNexus `detect_changes --scope all` → 112 changed symbols across 14 files, 46 affected symbols and 47 affected
  processes, `risk_level: critical` from the `handler`/`roundBriefing` hubs and no `partial`/`truncated` flag (the index was
  built before the uncommitted P19 pass, so its file set includes those changes too; the P20/A files are `src/context.ts`,
  `src/round-brief.ts`, `src/board-verbs.ts`, `extensions/p2o/index.ts` and the new `src/exploration-view.ts`).
- **A4 decision, measured:** the declaration audit showed 1,152 chars of planner headroom, so the plan's condition was met and
  the bounded read shipped instead of being deferred; it is one `p2o_board` view rather than a new `p2o_graph` action, because
  `p2o_graph` declares one clause per read verb under a 900-char pin and the board already owns record reads.
- **Not changed:** brief total cap (8 KiB) and every existing section cap; declaration ceilings; evidence ladder, coverage
  derivation, completion, debt gateability, authority and the tool count. A learned/lineage/prior-run row can satisfy nothing.
- **Not done / next:** commit and push await a fresh owner instruction (D-P20-4); the P19 documentation pass is still
  uncommitted in the same working tree. P20/B (write-back contract and teaching layer) and P20/C (provenance) are not started.

---

## 9. Owner decisions recorded (answered in chat, 2026-10-29)

1. **Scope:** A + B + C — all three tranches, not just the projection.
2. **Schema:** allowed if genuinely needed (additive, same store), with derived-on-read tried first.
3. **Priority:** both — multi-hour continuity and cross-run readiness are acceptance bars, not alternatives.
4. **Commit/push/live run:** none authorized by this plan; each needs a fresh owner instruction. The P19 documentation pass
   therefore stays uncommitted until then.
5. **Open questions** are raised in chat and are not decided or recorded here.

---

## 10. Evidence and reproduction

- **ARTEX snapshot:** `~/tmp/ARTEX` (0.3.15, `e6ec569`, AGPL-3.0, read-only). Key files in §2.1–2.4 above.
- **p2o at base `46db381`:** key files in §2.6–2.7 above.
- **Measured teaching-layer numbers** (`bash`, repo root): `grep -rho "p2o_[a-z_]*" skills/ | wc -l` → 0 tool references;
  `wc -c skills/*/SKILL.md` → 255,705 B over 38 skills; `sed -n '105,160p' src/prompts.ts` for the planner block; the
  `workerBrief` signature and call site for G5.
- **Prior plan:** the P19 plan of record and the verification record it carried are preserved at
  `git show 46db381:planning_update.md`; D-P19-10 and the P19/H rename existed only in the uncommitted pass and are
  summarized in §0. Delivered behavior is summarized in [docs/HISTORY.md](docs/HISTORY.md) and
  [docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md).
