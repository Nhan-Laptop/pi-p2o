# P25 — Derive the attack chain from the recorded store and read it as one object (plan of record, 2026-10-31)

Status: **plan written on owner instruction (2026-10-31) after the deep ARTEX comparison; Phase 1 is implemented in the working
tree (commit awaits a fresh owner instruction), and the
owner reviews this plan before Phase 1 starts.** The
owner picked three workstreams — **A** visibility plus a canonical attack-chain read, **B** graph-derived successor synthesis,
**C** host-derived chain-order relations — and fixed the authority boundary: a read call may propose candidates but **plan rows
are written only when the planner explicitly calls `plan:true`** (no auto-draft, no model-authored graph write). The owner also
ordered the work: **code first, live measurement after**. On the same review the owner added one small workstream, **F-lite**:
a prior run's bounded chain summary travels into the inherited finding body so the chain survives a run boundary as labelled
context (Phase 2, §3.4.1). This file replaces the P24 plan of record. P24 is recoverable at
`git show 52c5ac8:planning_update.md`; P23 remains recoverable at `git show 2448ca4:planning_update.md`. The P24 rows in
[docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md) and [docs/HISTORY.md](docs/HISTORY.md) stay; P24 Phase F (live C3/C4)
never ran and is carried into Phase 5 here.

Basis for this plan:

- **Owner decisions 2026-10-31** (§11): tracks A+B+C; `plan:true` is the only synthesis write; code before measurement; this
  file replaces the P24 plan.
- **P24 landed, Phase F did not.** HEAD `52c5ac8` ("Read the recorded graph into the briefs, report, completion and debt",
  P24/E), local only, not pushed. The working tree holds only the owner's `AGENTS.md`, `pi-p2o-defense-vi.pptx` and
  `.transcribe_tmp/`, which are never staged. The two exploit-mode C2 runs that motivated P24 remain the only live chain
  measurements (§1.1).
- **ARTEX deep dive (local checkout `~/artex/ARTEX`, commit `e6ec569`, v0.3.15), read-only.** Headline correction to the P24
  premise: ARTEX has **no chain entity at all** — `attack_chain|attackchain|exploit_chain|killchain|kill_chain|attack_path`
  matches zero files in Go/TS/Markdown, its only recursive query is the finding-lineage ancestor CTE, and its "chain" is
  one-hop DAG adjacency (`parents`/`yields`) inside a per-round projection plus prompt prose. What is copyable is narrower and
  more precise than "a chain feature": host-owned edge authority, a type-whitelisted anchor rule, a canonical lineage view, a
  host-created next hop, and a watermark event fan-out (§2).
- **Repository state at plan time:** HEAD `52c5ac8`; P24/A–E committed; gates recorded for that tree (§10, P24/E row): tsc
  clean, full suite 173 files passed / 5 skipped (178), 1,558 tests passed / 13 skipped (1,571), 0 failed; `npm run build` and
  `check:build` green; surface audit 35 registered / 35 model-visible / 0 hidden / 10 tool verbs, 23 planner actions, 0
  contradictions; declarations planner 45,471 / 45,500, worker 41,213 / 41,400, validation 40,402 / 40,500, reporting 6,282 /
  6,500; `validate_library.py` PASS 336.
- **Measurement stance:** P25's success is defined as mechanism observations on the next authorized runs (§7), never as an
  effectiveness claim about the target.

## 0. Executive summary

P24 made the exploration graph persist and readable: typed nodes and host-derived edges, per-round digests, a read-only
inherited overlay, and bounded graph reads in the board, the tool, the briefs and the report. The gap the owner named next is
that the **chain itself still is not a store object**: its order exists only in mutable plan rows (`chainOf`/`step`) and in a
case rating, the derived graph cannot express "this step leads to that step", and the host never proposes the next step from
what the run has recorded. The ARTEX deep dive shows the reference system solves the *context* half of this accidentally
(edges enforced at write time + adjacency injected every round + cold-graph ancestors), while p2o already solves the
*authority* half (typed readiness, dispatch refusal, evidence ratings) and lacks the derived-chain half.

P25 delivers, in dependency order:

1. **Phase 1 — chain-order relations and derived-graph versioning (track C plus the enabler).** Add one host-derived relation,
   `leads_to` (`link` step → next recorded step of the same chain), so the graph can walk recorded order; bump
   `EXPLORATION_GRAPH_VERSION` to 2, expose the derived version in health, and repair only the derived rows on a writable open
   when an older store is replayed (derived rows are a pure function of records; read-only opens never write).
2. **Phase 2 — canonical `AttackChain` read and adjacency (track A).** One read-only projection that merges the plan chain, the
   current accepted case rating, the graph node ids and the typed capabilities into one ordered object, surfaced through the
   existing `p2o_board board=graph` page, `p2o_graph action=lineage`, one optional round-brief line, one optional worker-brief
   line, and one report block — all bounded, all labelled derived, none of them authority. **F-lite** (owner addition) rides
   the same phase: the bounded chain summary of an accepted rating is written into the inherited finding body, so the next
   run's graph can show the prior chain as labelled context, never as its own execution (§3.4.1).
3. **Phase 3 — graph-derived successor synthesis (track B).** Extend `p2o_graph_plan action=chain` so a read returns ranked
   candidates from four sources: the ready claim frontier (today's only source), demonstrated-but-unchained primitives, bounded
   asset-graph reachability, and accepted case/finding lineage. Candidates are labelled `planable` or `gap`; **nothing is
   written by a read**; `plan:true` stays the only write and keeps its ≤3-path cap and no-dispatch promise.
4. **Phase 4 — hermetic acceptance, docs, matrix/HISTORY.** Gates, new test groups, doc truth, acceptance-matrix rows that cite
   real tests, and the P24/F close-out record.
5. **Phase 5 — live C3/C4 measurement (deferred, fresh owner authorization).** Re-runs the chain-native and cross-run
   observations on the new build; adds the P25 observables (order edges, canonical chain, synthesis candidates, `plan:true`
   writes) on `opencode-go/deepseek-v4.1-flash` only. Absence is recorded as a finding.

Nothing in P25 lets the graph or a synthesized candidate satisfy readiness, a goal proof, a case rating, a coverage cell or
completion; no new tool is registered and no declaration ceiling is raised.

## 1. Where the run stands (measured, not inferred)

### 1.1 P24 delivered a persisted graph, not a persisted chain

| Phase | Commit | What it delivered | Chain-relevant limit it left |
|---|---|---|---|
| P24/A | `df57acd` | `CHAIN_LINK_REQUIRED` dispatch order; multi-path `chainPlan` (≤3 paths, dispatches nothing) | order enforced at dispatch, still authored by the planner |
| P24/B | `aad1622` | schema 8 `exploration_nodes/edges/anchors`, one derivation for commit + rebuild | relation vocabulary has no chain order |
| P24/C | `f3409b9` | `board=graph`, `p2o_graph action=lineage`, round-brief `exploration` section, worker `ANCESTRY` block | reads show ancestry, not an ordered chain |
| P24/D | `770bfb8` | per-round digest nodes, inherited overlay, report graph section | digest is a round summary, not a chain view |
| P24/E | `52c5ac8` | exploit brief ancestry, planner ready-frontier line, report case↔graph pointer, completion/debt pointers | a chain still reads as three separate views |
| P24/F | — | live C3/C4 never ran (no fresh authorization) | no live evidence for P24 mechanisms |

The two C2 runs still bound the evidence: run 2 recorded 2 plan chains / 2 links, the successor's brief carried
`CHAIN`/`CHAIN PATH`/`NEXT LINK` for the first time (P23/C2), yet the link could not describe execution order beyond itself,
and the graph could not say "this claim is step 2, which came from step 1". P24 made that ancestry readable; it did not make
the order a store fact.

### 1.2 What p2o already has (so P25 extends, not replaces)

| Capability | Implementation | Anchor |
|---|---|---|
| Typed capability join over claims: primitives, ready, unmet, uncovered, frontier paths | `chainJoin` | `src/chain-view.ts:57` |
| Chain readiness from plan rows + demonstrated claims (`ready/waiting/done/blocked/deferred/cancelled`) | `chainBoard` | `src/chain-board.ts:77` |
| Chain context in a worker brief (`CHAIN`, `CHAIN PATH`, `NEXT LINK`) | `chainBriefFor`, `workerBrief` | `src/chain-brief.ts:48`, `src/prompts.ts` |
| Chain composition from the ready frontier that writes plan todos, dispatches nothing | `chainPlan` (`p2o_graph_plan action=chain plan:true`) | `extensions/p2o/index.ts:543`, `:550`, `:3709` |
| Dispatch-order rule and unchained-primitive obligations | `chainLinkGap`, `chainObligations`, `dispatchRefusal` | `src/chain-view.ts`, `src/obligations.ts` |
| Case-chain rating projection (accepted current ratings only) | `projectCaseChains` | `src/case-chain-view.ts:99` |
| Persisted exploration projection: nodes, edges, anchors, digest, inheritance, rebuild oracle | `deriveExploration`, `explorationDelta`, `rebuildExploration`, `explorationHealth` | `src/exploration-graph.ts:1-60`, `src/state/store.ts:809`, `:846` |
| Bounded graph read model: overview, frontier, lineage, digest page, page by node/record id | `explorationOverview`, `explorationFrontier`, `explorationLineage`, `explorationPage` | `src/exploration-graph.ts:631`, `:688`, `:798`; `src/state/store.ts:939` |
| Board and tool surfaces for the projection | `p2o_board board=graph`, `p2o_graph action=lineage` | `extensions/p2o/index.ts:3183`, `:3187`, `:3613`; broker `src/broker.ts:517`, host callback `:4560` |
| Report joins | `attackPathSection`, `attackGraphSection`, `explorationReportFacts` | `src/report-export.ts` |
| Typed needs and target effect on plan rows, with validation | `validatePlanDraft` | `src/planning.ts:78-110` |
| Incomplete client-side effect table (suggestion only, never authority) | `DERIVED_EFFECTS` | `src/effects.ts` |

### 1.3 The gap, stated as invariants

1. **G1 — recorded order is not in the graph.** The exploration relations are `spawns`, `derived_from`, `yields`, `proves`,
   `covers` (`src/exploration-graph.ts:27`). A chain's step order lives only in mutable plan rows and a case rating, so a graph
   walk cannot answer "what came next in the recorded chain"; two runs holding the same records would answer differently if
   the plan rows were revised.
2. **G2 — the host never synthesizes a successor from the store.** `chainPlan` composes only ready *claim* paths from
   `chainJoin.frontier` (`extensions/p2o/index.ts:3732`). A demonstrated primitive with no open claim consuming it appears as
   debt (`PRIMITIVE_UNCHAINED`) and nothing else; asset-graph reachability and finding lineage are never used to propose the
   next step. This is the largest distance to ARTEX's write-time anchoring plus host-created next hop.
3. **G3 — the chain is three views, not one object.** The report prints plan chains, case chains and a graph node pointer
   side by side; the briefs show the plan chain and the graph ancestry separately; no read returns the ordered chain with its
   claims, capabilities, effects and node ids together.
4. **G4 — derived-graph version has no policy.** `EXPLORATION_GRAPH_VERSION` is written into the origin body
   (`src/exploration-graph.ts:23`, `:212`) but nothing reads it: no health field, no open-time comparison, no repair path.
   Adding a relation or changing a derivation rule would strand every existing schema-8 store with a silently stale projection
   (P24 non-goal "no in-place migration" was about schema, and this gap is the derived-row counterpart).
5. **G5 — per-round context has counts and ancestry, not order.** `renderOverviewLines` prints counts, goals, links, facts,
   findings and the latest digest; the worker block prints ≤3 ancestry lines. Neither prints "step 2 of this chain is ready"
   or "this finding extends the chain that ran". The planner must reconstruct order from the plan board.
6. **G6 — synthesis has no provenance.** A composed chain says which claim is next but not why the host believes it is the
   next recorded step (which primitive, which asset edge, which finding). A candidate without provenance cannot be audited.
7. **G7 — the chain does not survive a run boundary.** P24/D inherits a finding as case identity, verdict, severity and its
   claim/task refs, but not how the chain was reached; the next run's graph can show that a finding existed, not the executed
   steps behind it. F-lite (§3.4.1) closes this with a bounded, inert chain summary in the inherited finding body.

## 2. Reference model — what ARTEX actually has (deep dive 2026-10-31)

**Corrected premise.** ARTEX does not model a chain. Its storage is one kind-tagged node table and one attribute-free edge
table with five relations, direction by convention (`parent → child` for all relations, `agent/coldgraph.go:11-14`), no cycle
constraint, no hop/order/weight column, and no chain record anywhere. The searches that would find a chain entity return
nothing; the only recursive query is the finding-lineage ancestor CTE (`db/exploration.go:1032-1085`). Its "chain" is:

- **host-owned edge authority**: `add_intent` accepts only `fact`/`finding` parents, verified by kind at write time, and
  auto-links a top-level intent to the origin fact (`agent/tools.go:1037-1046`, `:1078`, `:1083-1086`); every intent therefore
  traces back to recorded state by construction;
- **one-hop adjacency in every round projection**: `graphOverviewData()` returns, for each intent, `parents` and `yields`, and
  for each fact/finding its `from_intent` (`agent/tools.go:354-552`), pre-injected into the planner prompt each wake
  (`agent/planner.go:382`); caps 30 open intents / 20 recent facts / 10 findings / 12 recent-done / 15 cold digests;
- **cold graph as long-chain memory**: a node stays hot iff it is an ancestor of a live intent, the intent itself, or its direct
  child (`agent/coldgraph.go:105-132`); folded fact/intent groups become digest nodes with `covers` edges, and `covers` is
  deliberately excluded from causality (`agent/coldgraph.go:66`);
- **host-created next hop**: `deepenFinding` creates a priority-10 intent from a finding, copies anchors and writes
  `finding --derived_from--> intent` (`server/findings_groups.go:92-159`, `db/findings.go:374-441`); a watermark event fan-out
  (`server/scheduler.go:150-181`) wakes on new findings exactly once;
- **prompt prose instead of a plan**: the planner prompt asks for a serial exploitation chain recorded in TodoWrite
  (`agent/planner.go:333`), but the todo store is an in-process map (`agent/planner.go:106-117`), so a restart loses the chain
  plan while the graph survives.

Its limits are instructive: `report_finding` omits the `yields` edge when the caller supplies no intent id
(`db/finding_traffic.go:375-379`), so planner-reported findings are lineage orphans; `proves` is written
(`agent/tools.go:1183`) but never projected to the planner (`:387-395`); the graph load is `LIMIT 5000` without `ORDER BY`
(`db/exploration.go:986`), so lineage silently degrades at scale; cross-task parents keep the current exploration id with a
foreign source id (`db/exploration_sources.go:161-183`), producing dangling lineage rows.

| ARTEX mechanism | What it gives | What p2o should do |
|---|---|---|
| Write-time parent whitelist + root anchor | every step derives from recorded state | p2o already requires chain lineage (`CHAIN_LINEAGE`) and dispatch order; P25 adds provenance to candidates, not new authority |
| One-hop `parents`/`yields`/`from_intent` in each wake | chain context without a query | P25 adds the same adjacency shape (optional, bounded) to the planner/worker context; G5 |
| Canonical lineage view behind one item | "how was this reached" answer | P25 extends the existing lineage page with the ordered chain block; G3 |
| Host-created next hop from a finding | next step exists without model recall | P25 Phase 3 proposes candidates from the store, but keeps `plan:true` as the only write (owner decision) |
| Cold graph keeps ancestors hot | long chains fit the context | p2o digests already summarise rounds; P25 keeps chain lines bounded instead of adding a cold-graph mechanism |
| No chain record, no readiness, no evidence | the chain is narrative | **not copied**: p2o keeps typed readiness, dispatch refusal and evidence ratings; P25 adds a *derived ordered chain*, not a second authority |

What P25 deliberately does not copy: model-authored edges, a model-authored digest body, an in-memory plan list, and a
UI canvas.

## 3. Design

### 3.1 Authority and invariants

- **Records remain the only authority.** Every new row and every candidate is derived from committed records; deleting and
  rebuilding the derived graph from `records` must reproduce it byte for byte (the P24 differential test stays the oracle).
- **No model writes the graph.** No tool adds a node or an edge, including `leads_to`; the host derives chain order from plan
  rows. A model can write records that cause edges; it cannot state an edge.
- **The derived chain satisfies nothing.** Readiness (`chainBoard`), goal proof (`goal-proof.ts`), case verdict/rating,
  coverage and completion keep reading records. An `AttackChain` row is a read-only projection; only the executed case chain
  in the rating record remains executed-chain evidence (`src/report-export.ts`).
- **Synthesis writes only on an explicit call.** A `p2o_graph_plan action=chain` read returns candidates and writes nothing;
  `plan:true` composes plan rows for planable candidates only (≤3), exactly the current behavior. No task is dispatched.
- **Inherited rows stay inert.** Every own read keeps filtering `inherited_from IS NULL`; an inherited `leads_to` edge or chain
  step never participates in order, readiness or a brief's actionable lines.
- **Bounded everywhere.** 24 KiB per graph read (tail-trimmed with `truncated`/omitted), 8 KiB round brief, ≤480 B worker
  ancestry, ≤6 chains and ≤12 steps per chain in a read, ≤4,000 nodes / 8,000 edges / 8,000 anchors per run.
- **Deterministic.** No wall clock, network or another run in any derivation; identity is derived from `(runId, kind, entityId)`
  as today; read order sorts by explicit keys.
- **No new tool, no new board verb, no new graph action in v1.** P25 extends payloads of `p2o_board board=graph`,
  `p2o_graph action=lineage` and `p2o_graph_plan action=chain`. The declaration ceilings are hard; if a description cannot
  stay inside them with surgical prose, the text is trimmed in the same edit before any re-pin is asked (§3.6).

### 3.2 `leads_to`: the chain-order relation

Add one relation to the closed vocabulary in `src/exploration-graph.ts`:

```ts
export const EXPLORATION_RELATIONS = ['spawns','derived_from','yields','proves','covers','leads_to'] as const;
export const CHAIN_ORDER_MAX_STEPS = 12; // one group, not one run
export const CHAIN_ORDER_GROUP_SCAN = 200; // links scanned per group refresh
```

Direction is parent→child as for every other relation (`agent/coldgraph.go:11-14`): the earlier recorded step is the source,
the later recorded step the destination.

| Rule | Detail |
|---|---|
| Group | own `link` nodes whose body carries the same `chainOf`; identity is the plan row id, so a revision updates the same node |
| Edge | for each group, sort links by `step`; write one `leads_to` edge from step *k* to the next recorded step (consecutive recorded steps, not necessarily `k+1`, so a withdrawn step leaves a truthful successor) |
| Bounds | at most `CHAIN_ORDER_MAX_STEPS` links considered per group; a larger group stops at the bound and records `chainOrderTruncated` in the projection counters (exposed by health and the snapshot), never a silent cut |
| Writes | only `link` creation/update emits them; no model call reaches them |
| Revisions | a link revision (`step`, `chainOf`, status) names `refreshChains: [chainOf]` in its delta; the store deletes this run's own `leads_to` edges touching the group and re-adds the current consecutive pairs, so order is a function of the head rows, not of history |
| Read side | `ancestorSide('leads_to') = 'src'`; `explorationLineage` walks it up/down like the other relations; `byRelation` counts it; `explorationNodeText`/summary need no change |
| Case-rating order | **not** duplicated as edges in v1: a case rating is mutable, and the canonical read (Phase 2) reads its order directly from the rating record. Adding rating edges would make a mutable record a graph writer for no gain; revisit only if the live measurement shows the plan chain missing while the case chain exists |
| Schema | no DDL change: `exploration_edges` has no CHECK on `rel` (`src/state/schema.ts:118-130`), the vocabulary is enforced in code, so `STATE_SCHEMA_VERSION` stays 8 |

The node body of a `link` gains no order copy: the edge is the order; a body copy would be a second truth. The canonical read
resolves order from the edges and falls back to `step` only when the edge is absent (e.g. a truncated group), and says which it
used.

### 3.3 Derived-graph versioning and repair (G4)

**Version.** `EXPLORATION_GRAPH_VERSION = 2`; the origin body already carries it (`src/exploration-graph.ts:212`), and the
snapshot gains a `graphVersion` field read from the origin node. No origin (a fresh run before its first record) means
"current": the first record writes the v2 origin.

**Health.** `AssessmentStore.explorationHealth()` gains `graphVersion: number | undefined`, `stale: boolean`,
`derivedRebuilds: number`, `deferred: number` (records committed while the projection could not be maintained), and keeps
`nodes/edges/anchors/unresolved/overflow/failures/limits`. `p2o_state` health and `p2o status` render them; a stale graph is
named, never silently read as current.

**Open policy (writable).** On a writable open of a store whose own origin names an older version, the store replays its
derived rows once in one transaction via the existing `rebuildExploration()` (the same oracle the differential test uses),
bumps `derivedRebuilds`, and emits one host event `exploration.graph.repaired` for the `/p2o log`. This is **not** schema
migration: `PRAGMA user_version` and every table shape are untouched, the rows are a pure function of `records`, imported
(inherited) copies are preserved exactly as the existing rebuild does, and no record, evidence, rating or authority changes.
If the replay fails (quota, lock), the store continues with `stale: true`, skips incremental projection (counts `deferred`)
and refuses nothing: the run still works from records, and the derived reads say they are stale. Read-only opens never write;
they report `graphVersion` and `stale: true` and keep serving whatever rows exist.

**Why not an operator command.** A separate `/p2o store rebuild-graph` would add a command surface and an operator step for a
row set the host can regenerate deterministically. If the owner later prefers no write on open, the fallback is exactly that
command (parser change plus the same replay); the store method, health fields and tests do not change.

**Rejected.** Silently mixing v1 and v2 rows (a v1 store that keeps committing records would produce a projection that cannot
be reproduced by replay) and auto-migrating the schema (the existing refusal stays).

### 3.4 Canonical `AttackChain` read (G3, G5)

New pure module `src/attack-chain.ts`, no store dependency, no authority:

```ts
export interface AttackChainStep {
  order: number;
  origin: 'plan' | 'case';
  step: string;                 // the recorded step text, ≤160 chars
  claimId?: string; claimRef?: string;
  title?: string;
  effect?: CaseEffect;
  gained: readonly Capability[]; needs: readonly Capability[];
  state: 'done' | 'ready' | 'waiting' | 'blocked' | 'deferred' | 'cancelled' | 'recorded';
  executed: boolean;            // covered by the current rating's demonstratedThrough
  nodeRefs: { link?: string; fact?: string; finding?: string; intent?: string };
  orderEdge?: 'recorded' | 'step-only'; // whether a leads_to edge joined this step to the next
}
export interface AttackChain {
  id: string;                   // chainOf when a plan chain exists, else case-<caseId>
  sources: Array<'plan' | 'case'>;
  objective?: string; steps: readonly AttackChainStep[];
  demonstratedThrough?: number; status: string;
  next?: AttackChainStep; leftover: readonly Capability[];
  nodes: { links: string[]; facts: string[]; findings: string[] };
  omittedSteps: number; truncated: boolean;
}
```

Builders:

- `planChainSteps(plans, claims, progress)` — from the current plan rows (chain groups as `chainBoard` sees them) plus
  `chainJoin`/`claimCapabilities` for gained/needs and `recordIds` resolution; nodeRefs resolved through the snapshot
  (`link` entityId = plan id, `fact` entityId = claim slug, `intent` entityId from `taskIds`).
- `caseChainSteps(caseView)` — from `projectCaseChains`/`CaseChain` order (executed steps carry `executed: true` up to
  `demonstratedThrough`; reasoned steps after it stay `recorded` and are never executed).
- `attackChains({snapshot, plans, claims, cases}, options)` — merge rule: a plan chain and a case chain are **one chain** only
  when a case step's `claimRef` resolves to a claim slug the plan chain also names; then the plan chain is the spine (order,
  state, effect) and the case rating supplies `executed`/`demonstratedThrough`. No intersection means two chains, labelled
  `plan` and `case`. Ambiguity (one claim in two plan chains) keeps them separate and says so; it is never resolved by guess.
- Adjacency: consecutive steps get `orderEdge: 'recorded'` when the snapshot holds the `leads_to` edge (Phase 1) and
  `'step-only'` otherwise; the page prints which. Order itself accepts `step-only` only when no edge was recorded, so an
  un-repaired older store reads honestly.
- Caps: `ATTACK_CHAIN_MAX_CHAINS = 6`, `ATTACK_CHAIN_MAX_STEPS = 12`, `ATTACK_CHAIN_LINE_CHARS = 240`, per-chain render
  `ATTACK_CHAIN_BYTES = 3,072`; counts and `omitted` always accompany a cap.

Rendering `attackChainLines(chain, {byteCap})` (host sentences, no model prose):

```
CHAIN chain-ab12cd34ef56 (3 steps; plan+case; executed through 2) — objective: <≤120>
1. <claim> [done] needs net.egress gained cred.session effect confidentiality-read — nodes: link-… fact-…
2. <claim> [ready] needs cred.session gained file.read — nodes: link-… fact-… finding-…
NEXT: step 2 <claim> (all needs demonstrated)
Derived from recorded rows; only receipts and the case rating are evidence.
```

Surfaces (all existing; no declarations growth required):

1. `p2o_board board=graph id=<root>` — the lineage page gains `chain` when the resolved root is part of a chain; page budget
   stays the shared 24 KiB with the existing 1 KiB frame reserve, and the chain block is trimmed before rows like every other
   page. The `p2o_board` description gains at most one short clause only if the audit has room; otherwise the page is
   self-describing and the description is untouched (§3.6).
2. `p2o_graph action=lineage` — same block for owner and worker (broker `graph_read`), same budget. The worker path reads the
   same ledger index it already reads for other graph reads; no second query surface.
3. Planner round brief `exploration` section — optional `chainOrder` input renders ≤2 lines inside the existing
   `ROUND_BRIEF_SECTION_CAPS.exploration` (1,024 B): `Chain order: <chain> 1→2→3 (next: step 2 <claim>)`. Absent input renders
   nothing, so every earlier fixture's brief stays byte-identical (P24/C pattern).
4. Worker brief — one optional `CHAIN ORDER:` line inside the existing `ANCESTRY` block (≤480 B, appended only when it fits;
   never displaces an ancestry line); the plan-row `CHAIN`/`CHAIN PATH` block is unchanged.
5. Report — `explorationReportFacts` gains `chains`; the P24/D `## Attack graph — recorded ancestry, bounded` section prints up
   to 6 chains × 12 steps with node ids and the recorded/step-only marker. The section is absent when the run recorded neither
   digest, inherited rows nor chains, so old reports stay byte-identical; `attackPathSection` keeps its rating-derived rows
   unchanged.

#### 3.4.1 F-lite — the chain survives inheritance (owner addition)

P24/D inherited a finding as `{caseId, revision, reviewStatus, verdict, severity, claimRefs, taskRefs}` (a bounded re-cap of the
node body, `src/state/inherit.ts`), so the next run can see that a finding existed but not how it was reached. F-lite adds one
bounded, inert field:

- **Source of truth stays the rating record.** While trimming a source run's finding node, the collector reads the source's
  current accepted case rating (the same `CaseChain`/`projectCaseChains` inputs the report already reads; a schema-8 source
  through `explorationSnapshot`/`reviewContext`, a schema-7 source through the existing read-only reader/`indexRecords` path).
  No source store is written.
- **Body field.** `chain?: {objective ≤120, demonstratedThrough?, impact?, totalSteps, steps ≤6 {order, step ≤160, claimRef?,
  effect?, gained[], needs[]}, omittedLinks}`; only **executed** links are copied (up to `demonstratedThrough`), so a reasoned
  step cannot enter the next run looking executed; a cap that cuts the executed list is named by `omittedLinks`.
- **Bounds.** `INHERIT_CHAIN_STEPS = 6`, `INHERIT_CHAIN_CHARS = 160`, `INHERIT_CHAIN_BYTES = 1,024` inside the existing 2 KiB
  inherited body cap; if the chain block does not fit next to the identity fields the body is written without it and gains
  `chainOmitted: 'bytes'`; a missing/foreign/unparseable rating writes `chainOmitted: '<reason>'` rather than a guess. The
  collector only reads cases whose finding nodes are already selected for inheritance (≤ the existing `INHERIT_NODES`
  priority set), so start cost stays bounded.
- **Inert by construction.** The inherited chain is context only. The new run's canonical `AttackChain` does **not** merge it
  as its own steps (the merge reads current-run ratings only), readiness/proof/rating/completion never read it, and the
  `--no-inherit` control produces no inherited rows at all. The lineage page renders the inherited finding body as any other
  node body (now with the chain block); the overview's inherited line gains `, K inherited chain summary(ies)` only when K > 0.
  A rebuild preserves the copies unchanged because they are not derivable from this run's records.
- **No version bump of its own.** The body field is additive to the inheritance copy pass, not a derivation rule; a store that
  has old inherited copies simply reads no `chain` field. The Phase 1 `graphVersion: 2` already covers the derivation change
  that copied bodies follow.
- **Tests.** `tests/minimal/exploration-inherit.test.ts`: executed-only copying, reasoned steps never marked executed,
  `demonstratedThrough`/`omittedLinks`, the 2 KiB body still holds with several findings, exact byte determinism for the same
  source, missing/unparseable rating names its reason, schema-7 source path, `--no-inherit` has none, and an inherited chain
  never satisfies readiness or enters the current canonical chain.

### 3.5 Graph-derived successor synthesis (G2, G6)

Extend the existing `p2o_graph_plan action=chain`; **no new tool, no new action, no new parameter** in v1 (the page uses the
existing `limit`, `plan`, `assetRefs`, `requestId`). A read returns:

```ts
export interface ChainCandidate {
  source: 'frontier' | 'primitive' | 'asset' | 'finding';
  planable: boolean;            // true only when a same-run claim record exists and all needs are demonstrated
  rank: number;                 // deterministic sort key; derived, not model-set
  claimId?: string; recordId?: string;
  step?: { chainId: string; nextStep: number; previousStepNode?: string };
  needs: readonly Capability[]; gained: readonly Capability[];
  effect?: CaseEffect;
  path?: { assets: readonly string[]; relations: readonly string[]; effect?: string; depth: number };
  findingId?: string; caseId?: string;
  nodeRefs?: { link?: string; fact?: string; finding?: string };
  why: string;                  // host sentence ≤200 chars: which record/edge makes this candidate true
  planRefusal?: string;         // why a candidate is not planable (no record, no needs provider, asset-only)
}
export interface ChainSynthesis {
  label: string; candidates: readonly ChainCandidate[]; gaps: readonly ChainCandidate[];
  counts: Record<'frontier'|'primitive'|'asset'|'finding', number>;
  shown: { candidates: number; gaps: number }; omitted: number;
  next?: string; research: TransitionHint[];
}
```

Sources:

| Source | Rule | Writes? |
|---|---|---|
| `frontier` | today's `chainJoin.frontier` paths; each keeps the existing `ChainPath` fields and adds the canonical chain position when one exists | planable, written only by `plan:true` |
| `primitive` | demonstrated claims with typed `gained` that no ready frontier path consumes (the `chainObligations` unchained set) joined against `chainJoin.unmet`: the candidates are the open claims the primitive partially unlocks plus the missing capability kinds | gap only (no claim record for the missing capability), `plan:true` ignores them |
| `asset` | for up to 2 unchained demonstrated claims (and for the deepest frontier claim), one bounded reachability read from the claim's starting asset with `effect` set to the capability kinds that would extend it; reuse `pathWalkFor`/broker `graph_read path`, depth ≤4, nodes ≤120, ≤2 paths; the candidate names the assets and relations traversed | gap only (a path is not a claim), `plan:true` ignores it |
| `finding` | accepted current cases: last executed link's gained/leftover capabilities used to walk one bounded asset path; the candidate names the finding node and the next plausible effect class | gap only unless a frontier claim already exists, in which case the frontier candidate is annotated with the finding node |

Ranking (deterministic): planable first by frontier depth desc then claim id; gaps by source order
`primitive → finding → asset`, then fewer missing capabilities, then claim/asset id. Caps: candidates ≤9 (frontier ≤3,
primitive ≤3, finding ≤2, asset ≤2; `fitChainPage` still trims the whole page to 24 KiB and reports `shown`/`counts`).
`plan:true` behavior is unchanged in contract: ≤`CHAIN_PLAN_PATHS = 3` composed chains, one task draft per path, nothing
dispatched, `CHAIN_STEP_UNRECORDED` refusal by name when a path claim has no same-run record. If no candidate is planable,
`plan:true` refuses with the existing "Nothing ready to plan" message extended to name the gap sources.

Provenance (`G6`): every candidate's `why` names the exact record/edge, e.g. `demonstrated fact-… gains cred.session; open
claim c-… needs cred.session + file.read; the frontier path c-1 → c-2 is ready` or `asset path asset-… -[hosts]→ asset-… reaches
data.read; no claim records it yet`. The page is labelled `derived`; none of it can satisfy readiness, a rating or completion.

### 3.6 Bounds and budgets

| Surface | Bound | Where |
|---|---|---|
| Any graph read page | 24 KiB hard, tail-trimmed, `truncated` + omitted counts; a page that cannot fit below the floor refuses by name | `boundedResult`/`fitChainPage`, `extensions/p2o/index.ts:292-320`, `:3709` |
| Board graph page (overview / lineage + chain block) | 24 KiB shared with the frame; existing `budget: 24*1024-1024` (board) and `24*1024-512` (tool) keeps the warning line inside the bound | `extensions/p2o/index.ts:3187-3202`, `:3613`; broker host `:4566` |
| Round brief `exploration` chain line | ≤2 lines, inside the 1,024 B section cap and the 8 KiB total; last in order, first omitted when absent input (P24/C) | `src/round-brief.ts` |
| Worker ancestry `CHAIN ORDER` line | one line ≤240 chars inside the existing 480 B block; appended only when it fits | `src/prompts.ts` |
| Canonical chain | ≤6 chains × ≤12 steps read per page; per-chain render ≤3 KiB; `omittedSteps`/`omittedChains` always reported | `src/attack-chain.ts` |
| Chain-order edges | ≤12 steps per group; ≤200 links scanned per refresh; overflow counted and reported, never silently dropped | `src/exploration-graph.ts` |
| Derived rows | 4,000 nodes / 8,000 edges / 8,000 anchors per run (unchanged; `leads_to` counts against edges) | `src/exploration-graph.ts:37-39` |
| Health | `graphVersion`, `stale`, `derivedRebuilds`, `deferred` exposed on `p2o_state`/`p2o status` | `src/state/store.ts:809` |
| F-lite inherited chain | only executed links, ≤6 steps, step ≤160 chars, chain block ≤1 KiB inside the existing 2 KiB inherited body; `chainOmitted` names why it is absent | `src/state/inherit.ts`, §3.4.1 |
| Declarations | **no new tool, verb, action or parameter**; planner headroom at plan time is 29 chars, so P25 adds no required description text and trims duplicated prose in the same edit if a clause is needed; a ceiling is re-pinned only by the owner with a before/after measurement (D-S1-5) | `node scripts/audit-surface.mjs --json`; `tests/minimal/context-budget.test.ts:44`, `surface-audit.test.ts:18,48` |

### 3.7 Old stores, repair and why this is not schema migration

- **Schema stays 8.** `STATE_SCHEMA_VERSION` is not touched; `exploration_edges` needs no DDL change for a new relation (no
  CHECK on `rel`). A schema-7 store keeps its existing read-only `compatible:false` behavior (`src/state/store.ts:181-204`).
- **Only derived rows replay.** `leads_to` rows, chain bodies and `graphVersion` are projections of `records`; the repair path
  is the existing `rebuildExploration()` used by the differential test (`src/state/store.ts:846`), which already preserves
  inherited copies. No record is written, edited or deleted by the repair, and the event it emits is an audit event, not a
  projected node.
- **Bundles and checkpoints are unchanged** and are not an upgrade path; `importBundle` keeps files as artifacts and never
  replays a store (`src/state/bundle.ts:175-198`).
- **Version mismatch is named.** A store whose origin is v1 and cannot be repaired runs with `stale: true`; every surface that
  reads the graph prints the version, and the run's own records still drive readiness and ratings.

## 4. Workstreams (phases, each with its own acceptance)

Owner track mapping: **Phase 1 = track C** (chain-order relations) plus the versioning enabler; **Phase 2 = track A plus
F-lite** (visibility, canonical chain, cross-run chain summary); **Phase 3 = track B** (synthesis); Phase 4 closes
acceptance/docs; Phase 5 is the deferred live measurement. Each phase ends in its own commit on a fresh owner instruction (no
push), after its gates.

### Phase 1 — Chain-order relations and derived-graph versioning (track C + enabler)

Scope:
- `src/exploration-graph.ts`: add `leads_to` to `EXPLORATION_RELATIONS`, `CHAIN_ORDER_MAX_STEPS = 12`,
  `CHAIN_ORDER_GROUP_SCAN = 200`; derive the edge in `deriveExploration` and in `explorationDelta`; add
  `refreshChains?: string[]` to `ExplorationDelta`; `lookup.chainLinks(chainOf, limit)`; `ancestorSide('leads_to') = 'src'`;
  bump `EXPLORATION_GRAPH_VERSION` to 2; snapshot gains `graphVersion`.
- `src/state/store.ts`: `explorationHealth()` fields `graphVersion/stale/derivedRebuilds/deferred`; extend the
  `exploration-counters` metadata with `deferred` and `derivedRebuilds`; the writable-open repair hook of §3.3 (one
  transaction, `exploration.graph.repaired` host event, failure degrades to stale + deferred); `indexExploration` skips and
  counts `deferred` while stale; `explorationPage`/`explorationSnapshot` unchanged in shape except the new fields.
- Tests: new group in `tests/minimal/exploration-graph.test.ts` — 3-step chain → 2 `leads_to` edges; non-consecutive steps
  (a withdrawn step) link to the next recorded step; two chains never join; a revision moving a step re-derives the group
  (edges match a rebuild byte for byte); inherited link nodes emit no edge; the group scan bound records truncation; the
  differential test covers the new relation; store tests in `tests/minimal/assessment-store.test.ts`/new
  `tests/minimal/exploration-version.test.ts` — a v1 origin reopened writable is repaired once (`derivedRebuilds: 1`,
  `stale:false`, edges include `leads_to`), read-only open never writes (snapshot byte-identical, no counter change), a failed
  repair leaves `stale:true` + `deferred` and does not block record writes.
- Docs: `docs/KNOWLEDGE.md` relation list, `docs/ARCHITECTURE.md` derived-version paragraph, `docs/PLANNER_ENGINE.md` graph
  section; docs-truth stays green.
- Acceptance: tsc/build/check:build clean; full suite green including the new tests; differential incremental === rebuild over
  the existing generated stream; surface audit unchanged (no declarations); `validate_library.py` PASS 336; GitNexus
  `detect_changes --scope all` reviewed with `partial:false`, `truncated:false`.

### Phase 2 — Canonical `AttackChain` and adjacency (track A + F-lite)

Scope:
- New `src/attack-chain.ts` (§3.4): types, `planChainSteps`, `caseChainSteps`, `attackChains`, `attackChainFor`,
  `attackChainLines`, `attackChainPage` with caps and trimming; pure, no store import.
- Surfaces: `p2o_board board=graph id=…` attaches `chain` (§3.4 surface 1); `p2o_graph action=lineage` owner + broker attach it
  (surface 2); round-brief optional `chainOrder` input (surface 3); worker `CHAIN ORDER` line inside `ANCESTRY` (surface 4);
  `explorationReportFacts`/`attackGraphSection` chain rows (surface 5). All inputs optional so absent data renders the previous
  bytes exactly.
- F-lite (§3.4.1): `src/state/inherit.ts` and the `collectInheritedGraph` collector write the bounded chain summary of a
  source run's current accepted rating into the inherited finding body (executed links only, ≤6 steps, ≤1 KiB, `chainOmitted`
  reason when absent); the new run's canonical chain never merges those steps. Tests extend `exploration-inherit.test.ts`.
- Tests: new `tests/minimal/attack-chain.test.ts` (merge rules: plan-only, case-only, plan+case on claim intersection, ambiguity
  stays separate; order edge read vs step-only fallback; executed flags from `demonstratedThrough`; caps and trimming) plus
  additions to `exploration-graph.test.ts` (board page chain block within 24 KiB, absent chain keeps the page bytes),
  `round-brief.test.ts` (chain line cap/omission, absent input unchanged), `brief-context.test.ts` (ancestry `CHAIN ORDER`
  line fits 480 B and never displaces an ancestry line), `attack-graph-report.test.ts` (chain rows + byte stability when
  absent), `workspace-runtime.test.ts` (live board/tool read with a chain fixture both owner and worker), and
  `exploration-inherit.test.ts` for F-lite (§3.4.1: executed-only steps, caps/`chainOmitted` reasons, schema-7 source,
  determinism, inertness).
- Acceptance: every read page ≤24 KiB under a dense fixture; no new tool/verb/action/parameter and no declaration ceiling
  change; no write path added to any read handler (snapshot byte-identical before/after a read); old golden briefs/reports
  byte-identical when the new input is absent; F-lite inherited bodies stay ≤2 KiB, carry only executed links of a current
  accepted source rating, and never enter the current canonical chain; tsc/build/check:build; suite green.

### Phase 3 — Graph-derived successor synthesis (track B)

Scope:
- `p2o_graph_plan action=chain` (§3.5): add the four candidate sources and provenance, the deterministic ranking, the caps and
  the `planable`/`gap` distinction; `plan:true` unchanged in contract (≤3 composed chains, one task draft per path, nothing
  dispatched) but consumes planable candidates from the same ranked list; a read call writes nothing (the existing `plan`
  branch is the only write site).
- Reuse existing bounded reads: `chainJoin`, `chainObligations`, `pathWalkFor`/broker `graph_read path`, `projectCaseChains`,
  `chainBoard`, and the Phase 2 canonical chain. No new tool, no new declaration text; if a description clause proves
  necessary, trim duplicated prose in the same edit and only then ask the owner to re-pin with a measurement (D-S1-5).
- Tests: new `tests/minimal/chain-synthesis.test.ts` (a fixture with a demonstrated primitive and no successor → a `primitive`
  gap naming the missing capability; an asset-graph path to an effect → an `asset` gap with the exact relations; an accepted
  case chain → a `finding` gap with the finding node; the ready frontier → planable candidates; deterministic ranking and
  caps; `plan:true` writes ≤3 chains and only planable ones; a read leaves `store.sequence()` unchanged and writes no record)
  plus additions to `chain-plan.test.ts`/`chain-dispatch.test.ts` for the unchanged write/refusal contract and to
  `graph-response-bounds.test.ts` for the 24 KiB page bound.
- Acceptance: a read call never changes store sequence; `plan:true` writes only planable candidates and dispatches nothing;
  the page reports `shown` vs `counts` under pressure; the existing `CHAIN_STEP_UNRECORDED` refusal still fires; no declaration
  ceiling change; suite green.

### Phase 4 — Hermetic acceptance, docs, matrix/HISTORY

Scope:
- Gate run on the merged tree: `npx tsc --noEmit`; full `npx vitest run` alone (the `round-wrapup` time-axis flake is known:
  re-run alone before calling it a failure); `npm run build`; `npm run check:build`;
  `node scripts/audit-surface.mjs --json`; `python3 scripts/validate_library.py`; `git diff --check` with the owner files
  excluded; GitNexus `impact` pre-edit and `detect_changes --scope all` pre-commit after an index refresh.
- Docs: `docs/KNOWLEDGE.md` (relations/version/repair), `docs/PLANNER_ENGINE.md` (chain order, canonical chain, synthesis
  sources), `docs/USAGE.md` (board/tool read examples and the stale-graph health line), `docs/ARCHITECTURE.md` (schema still 8,
  derived graph v2); docs-truth must not claim a verb that is not live.
- Records: acceptance-matrix rows `F-P25-A…`/`F-P25-B…` that cite real test titles (the matrix guard
  `tests/minimal/acceptance-matrix.test.ts:11-27` enforces this); HISTORY rows per commit; this plan's §10 rows filled;
  P24/F recorded as not run (the live measurement is P25 Phase 5, not a P24 commit).
- Acceptance: all gates green; no deleted assertion, no new skip, no raised ceiling; docs-truth/matrix guards pass; the plan
  and matrix name the same tests.

### Phase 5 — Live C3/C4 measurement (deferred; fresh owner authorization)

Scope:
- Carry P24/F here. On the P25 build, two authorized runs in exploit mode on the recorded C1 target: **C3** the chain-native
  run (order rule + chain read + synthesis active) and **C4** a second run in the same project with `--refer-workspace latest`
  (inherited graph), plus the `--no-inherit` control. Model pinned to `opencode-go/deepseek-v4.1-flash`; the C1 scope, ladder
  and prohibitions carry no automatic renewal, so this phase starts only on a **fresh owner instruction**.
- Observables: `leads_to` edge count in graph health; the chain block in `board=graph` and the briefs; the round-brief chain
  line; the canonical chain merge (`sources: plan+case`) for any executed step; synthesis candidates by source and at least
  one `plan:true` write with links (or the recorded refusal); a read call that provably wrote nothing; inherited rows inert
  (`--no-inherit` control has zero inherited rows and the recorded reason); the report chains block; every absence recorded as
  a finding. No effectiveness claim is made; the target's state is not the measure.
- Acceptance: measurement rows in §10 and the matrix/HISTORY updated on a fresh instruction; the run stopped cleanly with
  `/p2o stop`; no provider drift; no out-of-scope action.

## 5. Test matrix

| Area | Test file | Intended assertions |
|---|---|---|
| Chain-order derivation | `tests/minimal/exploration-graph.test.ts` | 3-step chain → 2 edges in order; gaps link to the next recorded step; two chains independent; inherited links emit none; group cap records truncation; `byRelation.leads_to` counts |
| Chain-order revision | `tests/minimal/exploration-graph.test.ts` | revising `step`/`chainOf` refreshes the group and the differential equals a rebuild byte for byte; a cancelled step keeps its node but reorders successors truthfully |
| Graph version + repair | `tests/minimal/exploration-version.test.ts`, `assessment-store.test.ts` | writable open of a v1 origin repairs once (`derivedRebuilds:1`, `stale:false`), preserves inherited copies, writes no record; read-only open never writes (snapshot byte-identical); a failed repair leaves `stale:true` + `deferred` and record writes still succeed; a fresh run writes a v2 origin |
| Differential replay | `tests/minimal/exploration-graph.test.ts` | incremental === `rebuildExploration()` over the generated stream with `leads_to` included |
| Canonical chain | `tests/minimal/attack-chain.test.ts` | plan-only, case-only, plan+case merge on claim intersection, ambiguity stays separate; `orderEdge` recorded vs step-only; executed flags from `demonstratedThrough`; caps/`omittedSteps`; render lines ≤240 chars and per-chain byte cap |
| Board/tool chain read | `tests/minimal/workspace-runtime.test.ts`, `graph-response-bounds.test.ts` | `board=graph id=…` chain block within 24 KiB; `action=lineage` owner and worker return the same chain; read writes nothing; unknown id refused by name |
| Planner brief | `tests/minimal/round-brief.test.ts` | optional chain line inside the `exploration` cap, omitted first under pressure, absent input leaves the golden brief byte-identical |
| Worker ancestry | `tests/minimal/brief-context.test.ts` | `CHAIN ORDER` line fits the 480 B block, never displaces an ancestry line, absent without a chain |
| Report chains | `tests/minimal/attack-graph-report.test.ts`, `attack-path.test.ts` | chain rows cap/trim, recorded/step-only marker, derived label; absent data keeps prior reports byte-identical; `attackPathSection` bytes unchanged |
| F-lite inheritance chain | `tests/minimal/exploration-inherit.test.ts` | executed links only (reasoned steps never marked executed); ≤6 steps / ≤1 KiB inside the 2 KiB body; `chainOmitted` reason when absent or over budget; schema-7 source read path; same source gives identical bytes; `--no-inherit` has none; inherited steps never satisfy readiness or enter the current canonical chain |
| Synthesis | `tests/minimal/chain-synthesis.test.ts` | each source produces/does not produce a candidate on a fixture; provenance names the record/edge; ranking and caps; `planable` only with a same-run record; `plan:true` writes ≤3 planable chains and dispatches nothing; a read leaves `store.sequence()` unchanged; `CHAIN_STEP_UNRECORDED` still fires |
| Write contract | `tests/minimal/chain-plan.test.ts`, `chain-dispatch.test.ts` | multi-path write cap and no-dispatch unchanged; `CHAIN_LINK_REQUIRED` order rule unchanged; validation/retest exempt |
| Budgets/surface | `tests/minimal/context-budget.test.ts`, `surface-audit.test.ts` | 35 tools / 35 model-visible / 0 hidden / 10 tool verbs / 23 planner actions unchanged; every role ≤ pinned ceiling; no new declaration required |
| Docs truth / matrix | `tests/minimal/docs-truth.test.ts`, `acceptance-matrix.test.ts` | docs name only live verbs; every `F-P25-*` row cites an existing test title |

Gates for every phase (from `package.json`): `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `npm run check:build`,
`node scripts/audit-surface.mjs --json`, `python3 scripts/validate_library.py`, `git diff --check` (owner files excluded), plus
GitNexus `impact` before each edit and `detect_changes --scope all` before each commit (refresh the index first when stale).
No gate may be weakened: no deleted assertions, no new skips, no raised ceiling without the owner's measured re-pin.

## 6. Files (planned write scopes; disjoint per phase)

| Phase | New files | Modified files |
|---|---|---|
| 1 | `tests/minimal/exploration-version.test.ts` | `src/exploration-graph.ts` (relation, derivation, refresh, version, snapshot), `src/state/store.ts` (health, counters, open repair, deferred), `tests/minimal/exploration-graph.test.ts`, `tests/minimal/assessment-store.test.ts`, `docs/KNOWLEDGE.md`, `docs/ARCHITECTURE.md`, `docs/PLANNER_ENGINE.md` |
| 2 | `src/attack-chain.ts`, `tests/minimal/attack-chain.test.ts` | `extensions/p2o/index.ts` (board page, lineage action, round-brief input, worker brief input, `collectInheritedGraph` F-lite), `src/broker.ts`/host graphRead callback (lineage attach), `src/round-brief.ts`, `src/prompts.ts`, `src/exploration-graph.ts` (read helpers if needed), `src/state/inherit.ts` (F-lite body field/caps), `src/report-export.ts`/`src/report.ts`, `tests/minimal/{exploration-graph,round-brief,brief-context,attack-graph-report,workspace-runtime,exploration-inherit}.test.ts`, docs |
| 3 | `tests/minimal/chain-synthesis.test.ts` | `extensions/p2o/index.ts` (`p2o_graph_plan` chain action, candidate assembly, `chainPlan` call), `src/chain-view.ts` (pure helpers only if needed), `tests/minimal/{chain-plan,chain-dispatch,graph-response-bounds}.test.ts`, docs |
| 4 | — | `docs/ACCEPTANCE_MATRIX.md`, `docs/HISTORY.md`, this plan §10, README/ARCHITECTURE/KNOWLEDGE/PLANNER_ENGINE/USAGE surfaces as the behavior lands |
| 5 | measurement notes | this plan §10, matrix/HISTORY rows on owner instruction |

The owner files (`AGENTS.md`, `pi-p2o-defense-vi.pptx`, `.transcribe_tmp/`) are never staged; no AI attribution; the repository
identity is `Nhom 03 <nguyentrongnhan06cm@gmail.com>`.

## 7. Live measurement plan (C3/C4, Phase 5)

Preconditions: Phases 1–3 committed; the changed files copied into `~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o` and the
runtime digest recorded at the consent dialog; a **fresh owner instruction** under the C1 validity clause (host
`https://ise.uit.edu.vn/` only, default ladder minus `availability-loss`, the prohibitions and volume limits); model pinned to
`opencode-go/deepseek-v4.1-flash`; 2 workers, target-ops 2, round-steps 30; stop on `/p2o stop` at budget or on target
instability.

- **C3 (chain-native):** objective text asks for one chained effect where the successor is dispatched only after its link
  exists and its brief names the chain position. Expected observations, all read from the store: (a) the dispatch-order refusal
  fires if the planner skips the link; (b) the successor brief carries `CHAIN`/`NEXT LINK` and, when a chain node resolved, the
  `CHAIN ORDER` line; (c) the round brief prints the chain-order line; (d) `board=graph id=<case|claim>` returns the canonical
  chain with node ids and `recorded`/`step-only` markers; (e) `leads_to` edges exist for the plan chain (`p2o_state` health);
  (f) the `action=chain` read lists candidates by source with provenance, and at least one `plan:true` call writes ≤3 plan rows
  (or the refusal is recorded); (g) the report has the graph chains block; (h) either an executed step with an effect and a
  receipt, or the recorded absence (wall, refusal, budget stop) stated as a finding.
- **C4 (cross-run reuse):** a second run after C3 with `--refer-workspace latest`; expected: the manifest records
  `explorationInheritance {inheritGraph, runs}`; inherited counts print once; `board=graph` labels imported rows with the source
  run id; no inherited row (including an inherited `leads_to` edge) changed readiness, proof, rating or completion; and, for
  F-lite, at least one inherited finding body carries the prior run's bounded executed-chain summary (or the recorded
  `chainOmitted` reason), while no inherited step appears in the current canonical chain. The control repeats C4 with
  `--no-inherit` and expects zero inherited rows, no chain summary, and the recorded reason.
- **New P25 measurements:** `leads_to` edges by chain vs `graphVersion: 2`; number of canonical chains and `sources: plan+case`
  merges; synthesis candidates by source and how many were planable; the store sequence before/after each read-only chain call
  (must be identical); brief/report line bytes under pressure.
- Measurement queries: plan chains via `records where kind='note'` with `data.plan.chainOf`; graph counts via
  `p2o_state`/`store.explorationHealth()`; briefs via worker session grep for `CHAIN ORDER`/`NEXT LINK`; report via the final
  report directory. A measurement that shows a read writing state, a page over bound, a projection/rebuild mismatch, or an
  inherited row affecting authority is a P25 defect and blocks Phase 5 sign-off, not a note.

## 8. Risks and mitigations

| # | Risk | Mitigation / decision |
|---|---|---|
| 1 | `leads_to` goes stale when a plan row is revised | `refreshChains` deletes and re-derives the whole group from head rows in the same transaction; the differential test pins incremental === rebuild byte for byte |
| 2 | Repair-on-open writes rows during open | derived-only replay of `records` (never a record, never a schema change), one transaction, inherited copies preserved, audit event plus `derivedRebuilds`, failure degrades to `stale`+`deferred`, read-only opens never write; tests pin all four |
| 3 | Canonical merge attributes a case chain to the wrong plan chain | merge only on a real claim-slug intersection; ambiguity keeps chains separate and says so; the object is labelled derived; report keeps rating-derived rows unchanged |
| 4 | Synthesis reads like an order | every candidate is labelled `candidate` with a `why`, `planable` is host-computed, a read leaves the store sequence unchanged, `plan:true` is the only write and dispatches nothing |
| 5 | Declaration ceilings (planner headroom 29 chars) | no new tool/verb/action/parameter; output-only extension; if any clause is required, trim duplicated prose in the same edit and only then ask the owner to re-pin with a before/after measurement (D-S1-5) |
| 6 | Byte-stability regressions in briefs/reports | every new input is optional and absent renders the previous bytes; golden tests for the absent case; page-budget tests under a dense fixture |
| 7 | Extra reads slow the lineage page | one bounded ledger read plus the existing snapshot read per page, 24 KiB cap; the page is a planner/worker occasional read, not per round; the live measurement checks latency qualitatively |
| 8 | Version bump strands fixtures/old runs | repair-on-open for writable stores; read-only stores labelled stale; fixtures regenerate; no committed evidence of a schema-8 v1 live run exists at plan time (P24/F never ran), so the expected blast radius is test fixtures and dev stores — the repair path covers any store that does exist |
| 9 | Group scan cap hides order in a large chain | truncation recorded on the node/health and reported by the read; a chain longer than 12 steps is out of the current bounded design and is named, not silently cut |
| 10 | Live measurement cost/quota | flash only; stop rules from C1; usage-limit block recorded as a finding (measured in C2 run 1) |
| 11 | P24 references break after this replacement | recovery path stated at the top; HISTORY/matrix keep the P24 rows; docs that cite the plan are updated where their subject changes |
| 12 | The derived chain becomes a second source of truth for the agent | graph/tool/brief text says derived in every surface; no readiness/proof/rating/completion reads it; tests pin the exclusions |
| 13 | F-lite inherited chain reads as this run's execution | copies only the source rating's executed links with `demonstratedThrough`/`omittedLinks`, caps ≤6 steps / ≤1 KiB and a `chainOmitted` reason, keeps the inherited label, and the canonical merge ignores inherited bodies; tests pin inertness and `--no-inherit` |

## 9. Non-goals and explicit refusals

- No UI/web app, no graph canvas: p2o's surfaces remain the terminal, the board/tool reads, the briefs and the report.
- No model-authored graph writes: no tool adds a node or edge, including `leads_to`; chain order is host-derived from plan rows.
- No graph- or candidate-derived authority: no projected row or synthesized candidate can satisfy readiness, a goal proof, a
  case rating or its verdict, a coverage cell or completion.
- Inherited chain steps are context only: F-lite copies a prior run's executed chain into the inherited finding body for
  reading; it is never merged into the current canonical chain, never a readiness input, and never counted as this run's
  execution.
- No raw SQL or generic graph query tool; the bounded reads in §3.5–§3.6 are the whole surface.
- No new tool, board verb, graph action or query parameter in v1; no raised declaration ceiling without the owner's measured
  re-pin.
- No auto-draft and no auto-dispatch: synthesis only proposes; `plan:true` writes plan todos and a task draft, and dispatching
  remains a separate owner/planner call (unchanged from P24/A).
- No schema bump, no bundle/checkpoint format change, no in-place schema migration; only the derived rows replay.
- No change to the evidence ladder, case rating rules, coverage derivations or readiness rules in this plan.
- No live run without a fresh owner instruction under C1; no provider drift; no push; no commit without a fresh instruction.

## 10. Records

| Tranche | Date | Commit / run | Commands and results | Not done / next |
|---|---|---|---|---|
| P24/A | 2026-10-30 | `df57acd` | `CHAIN_LINK_REQUIRED` dispatch order, multi-path `chainPlan`, prompt sentence; new `chain-dispatch.test.ts`; suite 1,497 passed / 13 skipped, 0 failed; surface 35/35/0; declarations planner 45,049 / worker 40,935 / validation 40,124 / reporting 6,282 | Phase B |
| P24/B | 2026-10-30 | `aad1622` | schema 8 and the exploration projection (nodes/edges/anchors), pure `deriveExploration` + delta, `rebuildExploration`, read-only `legacy.ts`; differential test; 1,000-record fixture 1,001 nodes / 1,500 edges | Phase C |
| P24/C | 2026-10-31 | `f3409b9` | read model (`overview`, `frontier`, `lineage`, `page`), `board=graph`, `p2o_graph action=lineage`, round-brief section, worker ancestry; suite 1,527 passed / 13 skipped; declarations planner 45,471 / 45,500, worker 41,213 / 41,400, validation 40,402 / 40,500 | Phase D |
| P24/D | 2026-10-31 | `770bfb8` | round digests, inherited overlay, report graph section; suite 1,553 passed / 13 skipped; detect_changes 15 files / 254 symbols / 237 affected, risk critical (additive hub edits), no partial/truncated | Phase E |
| P24/E | 2026-10-31 | `52c5ac8` | exploit ancestry, planner frontier line, report case→graph pointer, completion/debt pointers; suite 173 files passed / 5 skipped (178), 1,558 passed / 13 skipped (1,571), 0 failed; surface 35/35/0, 23 planner actions; declarations unchanged; `validate_library.py` PASS 336; detect_changes 18 files / 54 symbols / 17 flows, no partial/truncated | P24/F not run; P25 plan |
| P24/F | — | — | Live C3/C4 never ran (no fresh authorization). Carried to P25 Phase 5; the P24 mechanisms it would have measured are re-scoped with the P25 observables (§7) | Phase 5 |
| P25 plan | 2026-10-31 | docs record (this file) | Owner chose tracks A+B+C, auto-repair on writable open, phase order C→A→B, a plan review before code, and (same review) the F-lite addition; `plan:true` is the only synthesis write; code before measurement; this file replaces the P24 plan (P24 recoverable at `git show 52c5ac8:planning_update.md`); Phase 1 then implemented in the working tree | Phase 1 commit; Phase 2 |
| P25/1 | 2026-10-31 | working tree (commit awaits owner instruction) | §3.2/§3.3 landed: `leads_to` relation derived from recorded chain steps and re-derived per chain group on a revision, `EXPLORATION_GRAPH_VERSION = 2`, `graphVersion/stale/derivedRebuilds/deferred/chainOrderTruncated` health, writable-open derived-row replay (read-only open never writes), snapshot carries `graphVersion`/`chainOrderTruncated`; tsc clean; full suite 174 files passed / 5 skipped (179), 1,568 passed / 13 skipped (1,581), 0 failed (new `exploration-version.test.ts` 4 tests, `exploration-graph.test.ts` +7); build/check:build clean; surface 35/35/0, 10 verbs, 23 planner actions, declarations unchanged (planner 45,471 / worker 41,213 / validation 40,402 / reporting 6,282); `validate_library.py` PASS 336; `git diff --check` clean (owner `AGENTS.md` excluded); GitNexus detect_changes 10 files / 173 symbols / 21 flows, risk critical from additive hub edits, no partial/truncated; docs KNOWLEDGE/ARCHITECTURE/PLANNER_ENGINE updated | commit on fresh instruction; Phase 2 |
| P25/2 | — | — | — | planned |
| P25/3 | — | — | — | planned |
| P25/4 | — | — | — | planned |
| P25/5 | — | — | — | planned (fresh authorization) |

## 11. Owner decisions recorded (2026-10-31)

1. **Workstreams A+B+C.** After the deep ARTEX comparison the owner chose (A) chain visibility plus a canonical
   `AttackChain` read, (B) graph-derived successor synthesis, and (C) host-derived chain-order relations. Phase order in §4 is
   dependency order, not a priority drop: C is the relation the other two read.
2. **Authority boundary for synthesis.** A read call may return candidates and reasons; **plan rows are written only when the
   planner explicitly calls `plan:true`** (the current `chainPlan` contract). No auto-draft, no host-created plan row without a
   call, no model-authored graph write.
3. **Code before measurement.** P25 code lands first; the live C3/C4 runs follow on a fresh authorization with the P25
   observables (§7). P24/F is not re-run as a P24 commit.
4. **Plan file.** The owner instructed that this plan replace the current plan of record; this file is that replacement, with
   the P24 recovery path recorded at the top.
5. **Carried owner decisions.** Practice model `opencode-go/deepseek-v4.1-flash` only (a usage limit is a stop-and-wait, not a
   provider change); no commit and no push without a fresh instruction; each phase's commit waits for that instruction; live
   runs start only under the C1 validity clause (host `https://ise.uit.edu.vn/` only, default ladder minus `availability-loss`,
   the prohibitions and volume limits) and a fresh instruction; no AI attribution; repository identity
   `Nhom 03 <nguyentrongnhan06cm@gmail.com>`.
6. **Review before code (2026-10-31).** The owner reviews this plan before Phase 1 starts; the review may change the track set,
   phase order or scope, so no P25 code lands on the strength of the plan alone. Confirmed on the same day: auto-repair on a
   writable open (§3.3), phase order C→A→B (§4), and that a read call writes nothing (§3.5).
7. **F-lite added (2026-10-31).** After the plan review the owner added one bounded workstream to Phase 2: a prior run's
   executed chain summary travels into the inherited finding body, so a chain survives a run boundary as labelled context
   (§3.4.1). It stays context only: no merge into the current canonical chain, no readiness/proof/rating/completion input, and
   no source-store write.

## 12. Evidence and anchors

- **ARTEX deep dive (2026-10-31, commit `e6ec569`):** no chain entity (`attack_chain|attackchain|exploit_chain|killchain|
  kill_chain|attack_path` = 0 hits in Go/TS/Markdown); node/edge model `db/schema.sql:170-281`; edge table and relations
  `db/schema.sql:248-257`; direction convention `agent/coldgraph.go:11-14`; `add_intent` parent rule `agent/tools.go:1037-1046`,
  `:1078`, `:1083-1086`; edge writers `agent/tools.go:1347,1467,1183`; `db/finding_traffic.go:375-379`;
  `db/findings.go:438-441`; `db/digest.go:140-145`; per-round projection `agent/tools.go:354-552`, prompt injection
  `agent/planner.go:382`; serial-chain prompt `agent/planner.go:333`; in-memory todo `agent/planner.go:106-117`; cold graph
  `agent/coldgraph.go:66`, `:105-132`; compaction `agent/compaction.go:513-548`; lineage CTE `db/exploration.go:1032-1085`;
  finding endpoint `server/server.go:2221-2252`; host next hop `server/findings_groups.go:92-159`, `db/findings.go:374-441`;
  watermark `server/scheduler.go:150-181`; unordered `LIMIT 5000` `db/exploration.go:986`; cross-task edge
  `db/exploration_sources.go:161-183`.
- **P24/C2 evidence:** `run-11badbea-c08b-4d45-be7e-9b891a66064c` and `run-38e983c0-3853-4992-adda-fd0d73a4f868` (reports under
  `~/tmp/p2o-live-c2d/` and `~/tmp/p2o-live-c2/`); 2 plan chains / 2 links, 0 accepted cases, successor-before-link defect
  measured in run 2. Details stay in the P24 plan (`git show 52c5ac8:planning_update.md` §1).
- **p2o code anchors:** exploration projection `src/exploration-graph.ts:23` (version), `:27` (relations), `:212` (origin body),
  `:631` (frontier), `:688` (lineage), `:798` (overview render); store `src/state/store.ts:809` (health), `:846` (rebuild),
  `:939` (page); schema `src/state/schema.ts:118-130` (no CHECK on `rel`), `:170-281` (P24 tables); board names
  `src/board-verbs.ts:39`; board handler `extensions/p2o/index.ts:3183-3202`; lineage action `:3613`; broker dispatch
  `src/broker.ts:517`; worker graphRead host callback `:4560`; `chainPlan` `extensions/p2o/index.ts:543`, `:550`;
  `p2o_graph_plan` `:3709`, plan composition `:3732`; `chainJoin` `src/chain-view.ts:57`; `chainBoard` `src/chain-board.ts:77`;
  `chainBriefFor` `src/chain-brief.ts:48`; `chainObligations` `src/obligations.ts`; `projectCaseChains`
  `src/case-chain-view.ts:99`; `CaseChain` `src/case-types.ts:33-39`; plan chain fields/validation `src/planning.ts:78-110`;
  `CASE_EFFECTS` `src/cvss.ts:38`; incomplete effects table `src/effects.ts`; worker brief `src/prompts.ts`; report
  `src/report-export.ts`; round brief `src/round-brief.ts`; completion `src/completion.ts`; debt `src/debt.ts`; F-lite
  inheritance trim/2 KiB body `src/state/inherit.ts` and the `collectInheritedGraph` collector in `extensions/p2o/index.ts`
  (P24/D).
- **Plan-time gates:** HEAD `52c5ac8`; tsc clean; full suite 173 passed / 5 skipped (178), 1,558 passed / 13 skipped (1,571),
  0 failed; `npm run build` + `check:build` green; surface 35/35/0, 10 tool verbs, 23 planner actions, 0 contradictions;
  declarations planner 45,471 / 45,500, worker 41,213 / 41,400, validation 40,402 / 40,500, reporting 6,282 / 6,500;
  `validate_library.py` PASS 336; GitNexus index refreshed at that commit (19,098 nodes / 85,270 edges when last measured).
- **Owner files:** `AGENTS.md`, `pi-p2o-defense-vi.pptx`, `.transcribe_tmp/` are untracked/staged by the owner only, never by a
  phase commit.

## 13. Runbook (build, gates, measurement)

1. **Build under test:** copy the changed source files into `~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o` after every code
   change; the consent dialog prints the runtime digest — confirm it changed and record it.
2. **Gates before each commit:** `npx tsc --noEmit`; `npx vitest run` (alone, to avoid the known time-axis flake); `npm run
   build`; `npm run check:build`; `node scripts/audit-surface.mjs --json`; `python3 scripts/validate_library.py`;
   `git diff --check` (only changed files); GitNexus `impact` pre-edit and `detect_changes --scope all` pre-commit (refresh the
   index when stale). No gate may be weakened.
3. **C3 start (Phase 5 only, on a fresh owner instruction):** `/p2o --target https://ise.uit.edu.vn/ --mode exploit --goal
   "<chain-native objective: one recorded chain step whose successor is dispatched only after its link exists, and whose brief
   names the chain position>" --avoid "No destructive or availability-impacting action" --avoid "No persistence, no
   anti-forensics, no evasion beyond minimal proof" --avoid "No bulk user-data access or exfiltration; minimal proof only"
   --avoid "No credential theft beyond an owner-designated test account" --avoid "No lateral movement off ise.uit.edu.vn"
   --workers 2 --target-ops 2 --round-steps 30 --export`; confirm the consent dialog (scope, ladder, mode, digest, model) and
   verify the status line says `(opencode-go) deepseek-v4.1-flash`. **C4** repeats the same command after C3 with
   `--refer-workspace latest` added; the `--no-inherit` control repeats it without inherited rows.
4. **During the run:** watch for the dispatch-order refusal, the successor brief's `CHAIN`/`NEXT LINK`/`CHAIN ORDER` lines, the
   round-brief chain line, `board=graph` chain blocks, `leads_to` edges in `p2o_state`, and synthesis candidates by source; stop
   with `/p2o stop` at budget, at the first out-of-scope temptation, or when the chain evidence is complete; never let the model
   drift to another provider.
5. **After the run:** freeze the report, fill §10 and the matrix/HISTORY on a fresh instruction, run the §7 queries, and
   compare against the expected observations. Record absence as a finding; do not claim an effect the receipt does not show.
