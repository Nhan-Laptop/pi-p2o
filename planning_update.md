# P22 — A chain-aware exploitation layer: readiness that can branch, briefs that name the link, and an attack path the report shows (plan of record, 2026-10-30)

Status: **A1 and A2 committed in `7e5a0c3`; A3 committed in `548e716`; A4 committed in `d272786`; the A5 defects
measured on the owner's first two live runs are fixed — A5-fix-1..3 in `cc1e9aa` and A5-fix-4 in `7910e10`; the A5
assess-mode chain measurement on the current build is still owner-run (§13).** This file replaces the P21 plan of record by owner
instruction (2026-10-30). That plan, and the decisions D-P21-* that shaped it, are preserved at
`git show 5763d46:planning_update.md`; its delivered rows remain in [docs/HISTORY.md](docs/HISTORY.md) and
[docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md). Where those pages cite `planning_update.md` §4/A, §4/B, §4/D, §R0, §R1,
Part III/IV or an appendix, they describe that revision of the file, not this one.

Basis for this plan:

- p2o at commit `5763d46`, where P21 A+B+C are delivered (161 test files / 1,434 tests / 13 skipped, 0 fail), and the P22/A1+A2
  commit `7e5a0c3` (+1 source module, 3 test files touched, +16 tests, full suite 162 files / 1,450 tests);
- the ARTEX 0.3.15 snapshot at `my_references/ARTEX` (upstream commit `e6ec569`, AGPL-3.0, read-only, gitignored) and the
  1,364-line analysis `my_references/ARTEX/ARTEX_AGENTIC_CORE.vi.md` (gitignored);
- the owner's question of 2026-10-30 — ARTEX exposes an asset/vulns graph and "take attack chain từng phần"; does p2o's
  exploitation optimize the chain built on its graph the same way? — and the owner's decision to take this plan's option A
  (a chain-aware exploitation layer);
- the owner's live-run authorization for `https://ise.uit.edu.vn/`, assess mode first, run and confirmed from the owner's own
  TUI (A5). The owner's first live run has since been measured (P21 build, exploit mode — §10 A5) and its three defects are
  fixed; the assess-mode chain measurement on this plan's build is still outstanding.

**Measurement stance.** §0 is a code-and-test measurement, not a target measurement. One live run has been read since
(`run-1b201c1a-…`, 2026-10-30, §10 A5), but it ran the P21 build in exploit mode: it measured the P21 pipeline and the
receipt/storage defects below, not this plan's chain layer, so its numbers are recorded as a baseline and as defect evidence,
never as A1–A4 effectiveness. The P21 run (`run-42c447d6-…`, 2026-10-29) measured evidence, policy and breadth behaviour and
is not reused here either.

## 0. What the analysis measured

| Measure | Value (2026-10-30) |
|---|---|
| Chain representations in p2o | 4: plan-board rows (`chainOf`/`step`, `src/planning.ts:21-37`), the claim capability join (`src/chain-view.ts`), the case chain (`src/case-types.ts:21-40`), and the derived access ladder (`src/ladder.ts`) |
| Readiness inputs | plan frontier + claim heads only (`src/chain-board.ts:72`); case chains and accepted findings never enter |
| Readiness provider scope | claims cited by **earlier rows of the same chain**, then the step's own `claimRefs` (P22/A1, `src/chain-board.ts:84-100`); only a confirmed+tested claim links and the earlier row wins |
| Exploit brief (A17.3+A2) | per-claim fields plus, since A2, `CHAIN`/`CHAIN PATH`/`NEXT LINK` when a chain owns the task; measured base block 749 chars, rendered bound 1,200; brief bound 2,850 |
| Plan-row vocabulary | 19 fields, none for the effect or rung a link is after (`src/planning.ts:21-37`) |
| Case chain | a rating record: `CaseFinding.chain` validated at write (`src/case-types.ts:21-40,95`), read only by the ladder and the report (`src/ladder.ts:129-145`, `src/report-export.ts:198-200`) |
| Report attack path | the ladder renders **the deepest chain only** (`src/report-export.ts:439-474`); other recorded chains appear only as remaining-work debt |
| Chain authoring guidance | `CHAIN OR WALL` and the frontier lines only (`src/prompts.ts:181,189,191`); no authoring tactic and no effect target |
| Baseline gates | tsc clean; `npm run build` + `check:build` green; surface audit 35 registered / 35 model-visible / 0 hidden / 10 board verbs, 0 contradictions, planner 44,705/45,500, worker 40,935/41,400, validation 40,124/40,500 |
| A1+A2 landed delta | 11 files, +335/−4: `src/chain-brief.ts` (79 lines, new), the chain-board/brief/obligations changes, `tests/minimal/chain-brief.test.ts` (8 tests), +6 tests across three touched files, and the matrix/PLANNER_ENGINE/ARCHITECTURE rows; 162 files / 1,450 tests / 13 skipped, 0 fail |

**What the run could not tell us.** No p2o run has yet been measured while the chain-aware brief exists, and no run has ever
been measured on graph work that branches a new chain from an already demonstrated primitive. A5 is the measurement that
closes that gap; until it lands, every statement here is a mechanism claim a hermetic test can hold.

## 1. How to read this plan

- **A seam** is a place where the host already owns the facts a worker needs (a plan chain, a demonstrated claim, a rated case
  chain) but hands the worker a fragment and asks it to rebuild the rest.
- **Derived** means computed on read from records the run owns (plan rows, claim heads, accepted cases) and never stored as a
  second edge store or evidence; **host-recorded** keeps its P21 meaning (a fact stamped at write or execution time).
- A **link** is one ordered chain step: the claim it stands on, the typed capabilities it consumes, the capability it hands on,
  and (A4) the effect class it is after. A chain is a list of links plus the objective that names what the last one is for.
- Each package row below is a tranche with its own tests and a row in §10's verification table. A tranche is not "done" until
  its matrix rows (F-P22-*), HISTORY row and measured gates land with it (D-P22-9).
- Nothing in this plan moves authority. Derived chain facts never satisfy a claim, case, coverage cell or goal; they only make
  the work the records already describe visible to the model that must act on it (D-P22-2).

## 2. Diagnosis — six seams

### 2.1 S1 — An accepted finding is an endpoint, not a new starting point

Accepted cases feed counters, priority and goal proof, and nothing else: `summarizeSituation` counts accepted findings and
scores their assets (`src/situation.ts:123,141`), `src/priority.ts:35` gives an asset with an accepted finding +10 (a suggestion
the lead may override), `src/goal-proof.ts:42` accepts a case as a goal proof. The three planning readers take only `plans`,
`claims` and `tasks`
(`chainObligations` signature, `src/obligations.ts:63`; `chainBoard`, `src/chain-board.ts:72`; `chainJoin`, `src/chain-view.ts`).
So the run can rate a chain, print it in the report, and then plan as if that chain did not exist: no chain view names it, no
successor obligation is derived from it, and the planner re-derives the same fact from raw claims at best. The case chain is a
rating record with typed links already on disk; it is simply not projected into the planning read side.

### 2.2 S2 — A chain link cannot stand on a demonstrated claim it cites itself

Readiness looks for each declared need only among claims cited by **earlier rows of the same chain**
(`src/chain-board.ts:84-94`): `earlier.flatMap(other => other.claimRefs…)`. A row that cites a demonstrated provider in its own
`claimRefs` still waits forever, and `chainPlan` writes every row with only its own claim cited
(`extensions/p2o/index.ts:531-541`), so the shape cannot even be produced by the host draft. The consequence is that attack
paths cannot branch: once a primitive is demonstrated, a second chain (or a second branch of the same attack tree) that starts
from that primitive is unrepresentable, and the planner's only legal move is to extend the original chain. ARTEX's equivalent
(a finding that spawns a new intent) is a fresh exploration node (`db/exploration.go:1136-1180`); p2o has the demonstrated claim
and the citation vocabulary, but its readiness rule refuses to look at them.

### 2.3 S3 — The exploit brief hands over a primitive, not a link

A17.3's block carries the cited claims, the surface facts, the controls, the needs frontier, the handles, the expected
observation and the stop condition (`src/prompts.ts:315-330,380-401`; built in `extensions/p2o/index.ts:1489-1522`). What it
cannot say is *where in a chain this attempt sits*: which link is being taken, what the earlier links already demonstrated,
what the next link consumes, or what to feed it. The worker is expected to rebuild that path from the graph slice, so "take
the chain in parts" is prompt discipline rather than a handoff. Measured base block: 749 characters; the row that names the
link is missing while 451 characters of the 1,200-char bound sit unused.

### 2.4 S4 — A plan row cannot state the effect it is after, and no effect ↔ capability bridge exists

`CaseEffect` is the vocabulary a case chain rates (`src/cvss.ts:38`) and the ladder turns it into a rung
(`src/ladder.ts:30-32`: crossing effects, impact effects). It exists only on case chain steps (`src/case-types.ts:95`). Plan
rows have no effect target at all (`src/planning.ts:21-37`), and no rule translates a typed capability (`CAPABILITY_KINDS`,
`src/capabilities.ts:10-13`) into an effect class, so a plan chain cannot say "this link is after code execution" and the report
cannot say which effect a planned (unrated) link is climbing toward. The planner prompt states the chain-or-wall obligation
(`src/prompts.ts:189,191`) but teaches no authoring tactic: when to extend a chain, when to branch a new `chainOf`, how to
choose `needs`, or that a row may name its target effect.

### 2.5 S5 — The attack path is a by-product of a rated finding, not a report section

The report has two chain surfaces and both are lossy. A finding's chain prints its steps and demonstrated effect
(`src/report-export.ts:198-200`), and the ladder prints exactly one chain — `chainViews[0]`, the deepest one
(`src/report-export.ts:439-474`) — so a run that recorded three chains reports one ladder path and loses the other two to the
remaining-work section. Plan-board chains (open work, not yet rated) appear only as obligations: `chainLines` caps the plan page
at 10 (`src/chain-board.ts:125`), and the graph path read is bounded to 6 hops (`src/state/graph-tool.ts`, `path.maxDepth`).
An operator reading the report cannot see the attack path the run was actually taking, only the deepest rated fragment of it.

### 2.6 S6 — No measured live run of chain-aware behaviour

P21's runs measured evidence capture, policy and breadth; none measured the chain-aware machinery on a live target, and no run
has been measured since the chain-aware brief exists. There is no data on which reader the planner actually uses, whether it
branches chains or keeps extending one, where a ready link is left undispatched, or which of the seams above the run hits
first. The owner authorized one assess-mode run of `https://ise.uit.edu.vn/` for exactly this measurement; without it, A1–A4
are designed from the code and not from the machinery under load.

## 3. What ARTEX does that this plan borrows (and what it does not)

| ARTEX mechanism | Where | What p2o adopts |
|---|---|---|
| An attack chain is a **projection over a dependency DAG**, not a stored path: an exploration node with 5 edge kinds (`spawns`, `derived_from`, `yields`, `proves`, `covers`); a "finding" is one node kind; the UI's chain is an ancestor traversal | `db/schema.sql:184,248,256`, `db/exploration.go:1027-1071,1136-1180`, `db/finding_traffic.go:366-388` | A2/A3/A4: p2o keeps its three chain records (plan board, claim join, case chain) as the store and derives the *projections* the model reads: ordered path + next link in the brief, accepted-case chains in the planning read, and the whole attack path in the report |
| Chain staging is prompt discipline plus a per-task todo list plus event-driven replan: dispatch one prerequisite step at a time, mark it completed, let the next wake pick the successor | `agent/planner.go:333,142,206-210,303-331` | Nothing new to copy: p2o already enforces M1/M2/M4 (readiness derived from rows, create-time refusal, debt). A4 adds the authoring text the model still lacks; no scheduler change |
| A finding binds the recorded traffic that proves it and the goal it serves | `db/finding_traffic.go:366-388` | Not adopted: p2o's claim closure + accepted case + evidence ladder is stronger; a finding stays a claim closure plus a rated case (D-P22-4) |
| Depth over breadth, route diversity and anti-stall floors keep the loop moving | `agent/planner.go:303,330,331` | Already adopted in P20/P21 (prompt lines exist); A5 measures whether they fire on a chain-bearing run |
| The asset graph is six typed asset tables with no finding kind; the "vulns graph" is a UI projection over findings | `db/schema.sql:42-44` | p2o does not add a finding/vuln asset kind or an edge table: a finding is not an asset (non-goal, §8) |

Two things p2o must not copy: prompt-only chain staging without host enforcement (p2o keeps the board-derived readiness and the
create-time refusals), and a second attack-path store next to the records that already carry it.

## 4. Decisions

- **D-P22-1 — Scope (owner, 2026-10-30).** One package, A (a chain-aware exploitation layer), in five tranches: A1 cross-chain
  supply, A2 chain-aware exploit brief, A3 accepted-case chain projection, A4 attack-path report + chain authoring, A5 live-run
  measurement and defect closure. The alternative packages (B: chain as a first-class stored record; C: live-run-first) were
  rejected: B would duplicate the plan board and the case chain, and C would measure a brief that does not name the link yet.
- **D-P22-2 — Authority does not move.** No tool, loadout, role or board-verb change; the planner still holds no target/claim
  tool, the worker is still the only claim author, no role holds a cell writer, review is still not proof. Every new chain fact
  is derived on read (or host-stamped, as A2's brief facts are) and can never satisfy a claim, case, cell or goal.
- **D-P22-3 — Readiness extends by citation, never by inference.** A step may be ready on a demonstrated claim it cites in its
  own `claimRefs` when no earlier row supplies that need; earlier-row providers keep precedence and the closest provider is the
  one recorded in `satisfiedBy`. Nothing is deduced from capability names, surface text or the claim join: an un-cited
  provider never makes a step ready, and no step is dispatched automatically.
- **D-P22-4 — One chain truth.** The plan board plus the claim heads remain the only readiness inputs; the case chain remains a
  rating record and is projected into the planning read side read-only (A3). No second edge table, no stored path, no new
  record kind.
- **D-P22-5 — Effect target is a goal, never a rating.** A plan row may name the effect class it is after (A4); a derived
  capability→effect label may be printed beside a link. Both are labelled derived/target and never touch `src/ladder.ts`
  scoring, case acceptance, the depth ladder or goal proof: only an executed case chain step still establishes an effect.
- **D-P22-6 — The report shows the whole attack path, bounded.** All recorded chains (plan and case) render in one bounded
  attack-path section with omission counts; a plan-only link is labelled "not executed", and no sentence implies evidence for
  it. The ladder's deepest-chain rendering stays for the rung; it stops being the only view.
- **D-P22-7 — Live measurement (owner, 2026-10-30).** `https://ise.uit.edu.vn/` is authorized for one assess-mode run; the
  owner starts and confirms it from their own TUI. Proposed budget: workers 2, target-ops 2, round-steps 30; provider cost is
  the owner's. Assess mode stays read-only: no exploitation intent, no target state change. Exploit-mode chain testing is done
  on the owner's local lab afterwards, and any defect the live run exposes lands as a named fix with a hermetic test.
- **D-P22-8 — Commit, push and paid runs stay owner-initiated.** A2 sits uncommitted until the owner says otherwise; the plan
  file itself is written now on the owner's request. No push without a fresh owner instruction (inherits D-P21-7).
- **D-P22-9 — Documentation truth and measured budgets.** Each landed tranche carries its F-P22-* acceptance-matrix rows, its
  HISTORY row and the USAGE/ARCHITECTURE text in the same change; every added prompt or brief line is paid for inside a
  measured ceiling or the ceiling is re-pinned from a fresh measurement (inherits D-P21-8/D-P21-9).
- **D-P22-10 — The P21 plan is retired.** This file is the only plan of record; the P21 revision stays recoverable at
  `5763d46` and in the HISTORY/matrix rows that describe it.

## 5. Package A — chain-aware exploitation

Goal: make the chain the run already holds the thing the model is briefed on, can extend, and the operator can read — without
moving an authority or storing a second path.

### A1 — A chain link may stand on the claim it cites

- **Where:** `src/chain-board.ts` (provider derivation in `chainBoard`), `src/obligations.ts` (ready step + provider surfaced
  to the dispatch refusal), `src/situation.ts` and `src/round-brief.ts` read the board unchanged, tests `chain-board.test.ts`,
  `obligations.test.ts`, `chain-brief.test.ts`.
- **What:** for each declared need, find the provider in this order: (1) earlier rows of the same chain that cite a
  demonstrated claim gaining it (today's rule), then (2) the row's own `claimRefs`. `satisfiedBy` records the closest provider
  found; `waitingOn` keeps only needs nothing demonstrated gains. The M1 doc comment changes with the rule: a chain step may
  branch from any demonstrated claim it cites, so a new `chainOf` can start from an existing primitive. A2's brief matcher
  reads `satisfiedBy`, so it picks the new provider up without a change.
- **Non-goals:** provider discovery by capability or surface alone (the citation is the lineage); auto-creating a row; letting a
  step stand on its own *open* claim (only demonstrated claims count, unchanged).
- **Tests:** a root step with needs that cites an external demonstrated provider is `ready` and `satisfiedBy` names it; the same
  step citing an open claim stays `waiting`; an earlier-row provider wins over a self-cited one; `chainObligations` returns the
  ready step with that provider; every existing chain-board test stays green.
- **Acceptance:** a `p2o_plan` todo row that starts a new `chainOf`, declares a need and cites the demonstrated provider (plus
  the open claim it is to prove) is `ready` and the dispatch refusal names that provider; the host draft (`chainPlan`) keeps its
  current row shape, so branching is an explicit authoring decision, never an automatic rewrite.
- **Status:** landed in `7e5a0c3`, committed together with A2 (D-P22-8). Gate: `npx tsc --noEmit` clean; focused tests 39/39
  over the four touched files; full suite 162 files / 1,450 passed / 13 skipped, 0 fail (+6 tests over the A2 baseline);
  `npm run build` + `check:build` green; surface audit unchanged (35/35/0/10, declarations unchanged). GitNexus impact reported
  `chainBoard` as CRITICAL (29 impacted symbols, 59 processes) and the change was reviewed as additive: every input without a
  self-cited demonstrated provider keeps its previous result, and the earlier-row provider still wins when both exist.

### A2 — Chain-aware exploit brief (implemented in the working tree)

- **Where:** `src/chain-brief.ts` (new pure module), `src/prompts.ts` (`ExploitBriefFacts.chain`, `exploitBriefBlock`),
  `extensions/p2o/index.ts` (`exploitBriefFacts`), tests `tests/minimal/chain-brief.test.ts`,
  `tests/minimal/brief-context.test.ts`.
- **What:** for an exploitation/chaining ticket the exploit block gains the link it is:
  - `CHAIN: <id> step n/total (state)`;
  - `CHAIN PATH:` a window of one link either side of this attempt, each `n. title (state)`, the attempt marked
    `(this attempt)`, clipped ends shown as `…`, whole line bounded;
  - `NEXT LINK:` the nearest recorded successor and the typed capabilities it consumes, or an explicit "this is the last
    recorded step".
  The step is identified strongest-first: a plan row whose `taskIds` lists the task; a ready step whose satisfying providers the
  task cites; the step whose claim the task cites. Evidence spanning several chains returns nothing rather than guessing.
  Rendered only when a chain owns the task, so every other brief is byte-identical.
- **Bounds:** block stays ≤1,200 chars (base 749), exploit brief ≤2,850, chain path window ≤180 chars and every title clipped;
  ambiguity, absent facts and clipped ends are stated, never invented.
- **Tests:** 8 chain-brief tests (provider match, `taskIds` precedence, claim fallback, cross-chain ambiguity returns nothing,
  no-chain returns nothing, long-chain window and clipping, whitespace collapse, lowest-ready-link preference) and 2 brief
  render/absence/bound tests; focused files 19/19, full suite green.
- **Status:** landed in `7e5a0c3`, committed with A1 (D-P22-8). Gate: `npx tsc --noEmit` clean; full suite 162 files /
  1,444 passed / 13 skipped, 0 fail at that point; `npm run build` + `check:build` green; surface audit unchanged (35/35/0/10,
  declarations unchanged because no tool schema moved).

### A3 — Project an accepted case's chain into the planning read side (read-only)

- **Where:** new pure module `src/case-chain-view.ts`; caller `extensions/p2o/index.ts` where it builds the round brief
  (`buildRoundBrief`, `src/round-brief.ts:125-151,567-601`); rendered as a bounded `Case chains (derived)` sub-block of the
  existing `ready` section (its 1,024-byte cap is re-measured from the rendered text). Inputs: `caseViews` (`src/cases.ts:102`)
  and `claimHeadClaims`.
- **What:** for accepted, confirmed cases with a recorded `chain`, derive a bounded projection: objective, `demonstratedThrough`
  of the chain, one line per executed link (order, claim slug, effect, gained/needs), and the capabilities the executed links
  handed on that no later executed link consumes. The brief renders it labelled "derived from case <id> r<n> — a rating record,
  not a plan": the planner sees that the chain is already rated and which capability is left hanging, so it can author the
  successor row (or wall it) instead of re-planning the same links. A3 writes nothing; the plans it implies are authored through
  the existing verbs.
- **Non-goals:** no auto-created plan row, task or case; no successor task draft (that is `p2o_graph_plan action=chain`'s job
  from the claim frontier, unchanged); the case chain does not become a readiness input (D-P22-4).
- **Tests:** executed-only links projected and `demonstratedThrough` respected; an unaccepted case excluded (or labelled, if a
  pending row is useful) and never read as a finding; projection bounded/deduped/ordered; round brief inside its 8 KiB bound and
  the section cap re-measured; a derived case line satisfies no goal, claim or coverage cell.

### A4 — Attack-path report and a chain authoring tactic

- **Where:** `src/report-export.ts` (a new bounded attack-path section beside the ladder, `~439-474`), `src/planning.ts`
  (`PlanDraft.effect`, validator), `src/work-tool.ts` / `src/tool-schemas.ts` (plan schema description), `src/prompts.ts`
  (planner chain-authoring tactic), a new table in `src/effects.ts` (or `src/cvss.ts`) for the derived label.
- **What:**
  1. **Effect target on a chain row:** `PlanDraft.effect?: CaseEffect`, accepted only on a row that carries `chainOf`/`step`,
     described as the class this link is after; it never gates readiness, completion or rating.
  2. **Derived capability→effect label:** an explicit, incomplete table from typed capability kinds to effect classes
     (`data.read|db.query|file.read` → confidentiality-read; `file.write` → integrity-write; `exec.code|host.shell|deserialize`
     → code-execution; `auth.bypass` → authentication-bypass; `cred.session` and `cred.secret` map to nothing because possession
     of a session or a secret is not a demonstrated bypass; the transport kinds map to nothing). The label is printed as "derived
     suggestion, not a rating" and is never input to the ladder, a case rating or goal proof.
  3. **Attack path in the report:** one bounded section listing every recorded plan chain (state, per-link claim, needs,
     providers, target effect when recorded, derived effect label) and every accepted case chain (demonstrated-through, effects),
     with explicit omission counts; a plan-only link says "not executed". The ladder keeps its deepest-chain rendering for the
     rung, so the report stops losing other chains.
  4. **Authoring tactic:** a planner line beside the chain rules: a link names its position, the claim it stands on, the typed
     needs it consumes and optionally its target effect; extend the chain when the new link consumes the previous output, start a
     new `chainOf` when it reuses a demonstrated claim it cites, and never write a link whose needs nothing demonstrated can gain.
- **Non-goals:** no finding/vuln asset kind; no change to the depth ladder, rating ceiling or case acceptance; no new store or
  tool; no re-pin of a prompt ceiling without a fresh measurement.
- **Tests:** effect accepted on a chain row and refused on a non-chain row or an unknown class; the capability→effect table
  pinned case by case and the ladder/rating tests unchanged by it; a report with ≥2 plan chains and ≥1 case chain shows every
  path with omission counts, a plan-only link marked not executed, and no evidence wording; prompt-text pin and a re-measured
  planner ceiling (currently 16,700).

### A5 — Live measurement and defect closure

- **Where:** the owner-run TUI session described in §13; the ledger and exported report under the run's cwd; fixes land in the
  module the measurement names, each with a hermetic test.
- **What:** run assess mode against `https://ise.uit.edu.vn/` with the proposed budget (§13) under the owner's own confirmation,
  then read the committed state and report: whether chain rows were authored at all, whether A2's `CHAIN`/`NEXT LINK` lines appear
  in exploitation/chaining briefs, which links were ready but undispatched, where the planner stalled or repeated a question,
  and which seam (§2) the run actually hit. Every defect becomes a named entry (`A5-fix-1`, …) with the fix and its test; every
  fix is re-gated with the same commands as A1–A4.
- **Non-goals:** no exploit-mode run against the target; no scope widening; no benchmark or effectiveness claim; the run is one
  measurement on one host, and it says what the machinery did, not what p2o can do.
- **Acceptance:** a written measurement (run id, cwd, budget, chain/readiness counts, brief-usage evidence, defect list) and at
  least one defect fixed with a hermetic test before the tranche closes. If the run produces no chain-bearing activity at all,
  that is the finding: the defect is in what the run was asked to do, and it is recorded as one.

## 6. Sequence and gates

Order: A2 (landed in the working tree) → A1 → A3 → A4 → A5. A1 and A3 are independent and may land in either order; A4 depends
on A1 (branching rows) and A3 (case chain rows) for its report inputs; A5 starts once A1/A3/A4 are in, and its fixes re-enter
the sequence where the measurement points.

Every tranche:

1. `npx tsc --noEmit`, the targeted vitest files, then the full hermetic suite (`npx vitest run`);
2. `npm run build` and `npm run check:build`; `node scripts/audit-surface.mjs` (registered/model-visible/hidden/board counts and
   contradictions must not move; declarations may not rise past their baselines — if a tool schema changes, re-pin from a fresh
   measurement);
3. `python3 scripts/validate_library.py` when documents change; prompt/brief ceilings re-measured wherever teaching text moves;
4. `git diff --check`, GitNexus `detect_changes --scope all` before any commit, `git status` audited (never stage the owner's
   `AGENTS.md` edit or `pi-p2o-defense-vi.pptx`);
5. docs rows in the same change: `docs/ACCEPTANCE_MATRIX.md` F-P22-*, `docs/HISTORY.md` row, USAGE/ARCHITECTURE text where the
   model-facing behavior changed;
6. commit and push only on a fresh owner instruction, with the repository identity and no attribution lines.

A1 and A2 landed as one phase commit, `7e5a0c3`; their matrix rows, HISTORY row and plan rows are the record.

## 7. Acceptance bars (mechanism, not pentest effectiveness)

- **A1:** a plan chain can branch from a demonstrated primitive: the new root link cites it, the board calls it ready and names
  the provider, and the dispatch refusal names the same provider; no readiness appears without a citation.
- **A2:** an exploitation/chaining worker's brief names its chain link, the ordered window around it and the next link's typed
  needs; a task whose chain cannot be identified gets no chain lines instead of a guessed one; the exploit block and the whole
  brief stay inside their recorded bounds.
- **A3:** an accepted case's chain appears in the round brief as a bounded derived projection with its demonstrated-through depth
  and the capability left hanging; no plan/task/case is written by the projection, and the line satisfies nothing.
- **A4:** a report over ≥2 chains shows every recorded attack path with omission counts, plan-only links marked not executed,
  and a derived effect label that never changes a rung, rating or case verdict; a plan row's target effect survives a revision.
- **A5:** one assess-mode live run is written down with its run id and measurements, and at least one measured defect lands with
  a hermetic test; if the run shows no chain activity, that absence is the recorded finding.
- Never a claim about real-world effectiveness: assess mode demonstrates no effect, and the report still says an assessment is
  not a safety statement.

## 8. Non-goals and refusals

- No authority, loadout, tool-count or board-verb change; no planner target/claim tool; no cell writer; review is not proof.
- No finding/vuln asset kind and no second attack-path store: findings stay claim closures plus accepted cases.
- No automatic plan/task/case writing from a chain projection; no auto-dispatch; no readiness deduced from names or surfaces.
- No lowering of the depth ladder, rating ceiling or evidence ladder; a derived effect label and a plan target effect satisfy
  nothing.
- No exploit-mode run against the live target in this plan; the exploit chain is measured on the owner's local lab.
- No schema mutation of existing records (additive optional fields only), no export-redaction change, no MITM or traffic
  interception.

## 9. Risks

- **Readiness becomes too permissive.** Mitigation: the citation is mandatory, only demonstrated claims count, earlier-row
  providers keep precedence, and a test pins that an un-cited or open claim never makes a step ready.
- **A projected case chain is read as evidence.** Mitigation: the brief line is labelled derived and the projection never
  appears in the ladder, a goal proof or a case rating; tests assert it satisfies nothing.
- **A derived effect label becomes a rating.** Mitigation: explicit incomplete table, labelled suggestion, ladder and rating
  tests pinned unchanged; A4's non-goal list names it.
- **The report attack path grows without bound.** Mitigation: per-chain step cap, chain cap with omission counts, and a measured
  bound in the report size test; the section drops rows rather than the whole report.
- **Prompt and brief ceilings.** Mitigation: measure every tranche and re-pin only from a fresh measurement; a deleted line pays
  for an added one where possible (inherits D-P21-9).
- **The live run measures the wrong thing.** Mitigation: A5 names the evidence it needs before the run (chain rows, brief lines,
  readiness/dispatch history) and records an empty result as a finding instead of inventing a success.
- **A2 is uncommitted while A1 edits the same readiness path.** Mitigation: A1's change is additive in `chainBoard`; A2's
  matcher reads `satisfiedBy`, so the two are tested together before either is committed; the owner's commit instruction can take
  them as one phase.

## 10. Verification record (to be filled as tranches land)

| Tranche | Date | Commit | Commands and results | Not done / next |
|---|---|---|---|---|
| A1 | 2026-10-30 | `7e5a0c3` | `npx tsc --noEmit` clean; focused `chain-board` 13/13, `obligations` 6/6, `chain-brief` 9/9, `brief-context` 11/11; consumer files `round-brief`/`situation`/`debt`/`finish-preflight`/`completion`/`chain-plan`/`dispatch-discipline`/`research-breadth`/`chain-view` 95/95; full suite 162 passed / 5 skipped files (167), 1,450 passed / 13 skipped tests (1,463), 0 fail; `npm run build` + `check:build` green; surface audit 35/35/0/10, declarations unchanged; GitNexus impact on `chainBoard` CRITICAL (29 symbols, 59 processes) reviewed as additive; new tests: branch chain ready from a primitive another chain demonstrated, `satisfiedBy` names it, earlier-row precedence holds, non-demonstrated citation stays waiting, obligations/dispatch refusal and brief matcher pick the branch up | A3 next; matrix row F-P22-A1 and HISTORY row landed with the commit |
| A2 | 2026-10-30 | `7e5a0c3` | A2 landed in the same phase commit and passed the same gate; `chain-brief.test.ts` 8 tests cover the three identities, ambiguity, window bounds and whitespace; `brief-context.test.ts` 2 tests cover render placement, absence and the 1,200/2,850 bounds; `git diff --check` clean for the change (the owner's pre-existing `AGENTS.md` edit carries trailing whitespace and is never staged) | A1 in the same commit; matrix row F-P22-A2 and HISTORY row landed with it |
| A3 | 2026-10-30 | `548e716` | `npx tsc --noEmit` clean; focused `case-chain-view` 9/9 (executed-only/`demonstratedThrough`, reasoned-only, eligibility gates, claim record-id→slug, leftover join, dedupe, legacy prose, 2-chain bound, deep-chain window), `round-brief` 17/17 (+4: render/label, unknown-not-zero, derived line changes no goal/completion/readiness fact, bounds with omitted/left-hanging lines), `round-session` 13/13 (wiring assertion: the real brief says the projection is empty, not unsupplied), `acceptance-matrix`+`docs-truth` 24/24; `npm run build` + `check:build` green; full suite 163 passed / 5 skipped files (168), 1,463 passed / 13 skipped tests (1,476), 0 fail (+1 file, +13 tests); surface audit 35 registered / 35 model-visible / 0 hidden / 10 board verbs with 0 contradictions and declarations unchanged; `validate_library.py` PASS 336 documents; `git diff --check` clean for the change (owner's `AGENTS.md` edit only); GitNexus impact on `buildRoundBrief` LOW (1 direct caller), `detect_changes --scope all` 9 files / 33 symbols / 10 processes `risk_level: high` on the round-brief hub reviewed as additive, no `partial`/`truncated`; cap re-measured: `ready` 1,024 → 2,560 B (two full chains render 1,745 B), brief total still ≤8 KiB | A4 next (attack-path report, `PlanDraft.effect`, planner chain-authoring tactic + re-pinned planner ceiling); matrix row F-P22-A3 and HISTORY row landed with this record commit |
| A4 | 2026-10-30 | `d272786` | `npx tsc --noEmit` clean; focused `effects` 2/2 (every `CapabilityKind` pinned, dedupe/canonical order, legacy prose joins nothing), `attack-path` 6/6 (chainless report renders nothing, plan link state/providers/target effect/derived/not-executed, case-chain depth and written-but-not-executed tail, stale rating listed but never joined, chain/link caps counted, export integration over 2 plan chains + 1 case chain), `planning` 10/10 (+2: effect accepted only on a chain row and only from the closed list with `EFFECT_TARGET_UNCHAINED` otherwise; target survives a revision and never makes the step ready), `recon` 21/21 (+1 authoring-tactic pin), `context-budget` 2/2, `acceptance-matrix`+`docs-truth` 7/7; `npm run build` + `check:build` green; full suite 165 passed / 5 skipped files (170), 1,474 passed / 13 skipped tests (1,487), 0 fail (+2 files, +11 tests); surface audit 35 registered / 35 model-visible / 0 hidden / 10 board verbs with 0 contradictions, declarations planner 45,049/45,500 (+344: the optional `effect` field and its description), worker 40,935/41,400 and validation 40,124/40,500 unchanged; planner prompt re-measured 16,193 → 16,573 inside the unchanged 16,700 ceiling (127 chars headroom); `validate_library.py` PASS 336 documents; `git diff --check` clean for the change (owner's `AGENTS.md` edit only); GitNexus impact pre-edit: `validatePlanDraft` CRITICAL (planning hub), `renderReport` HIGH, `plannerInstructions` LOW, all reviewed as additive optional-field/render-text changes, `detect_changes --scope all` 14 files / 77 symbols / 16 processes `risk_level: critical` on `renderReport` reviewed as additive, no `partial`/`truncated` (the three new files are untracked, so the git-diff reach signal does not include them; tsc/build/tests cover them) | A5 next (owner-run TUI measurement, §13); matrix row F-P22-A4 and this HISTORY row landed with this record commit |
| A5 | 2026-10-30 | `cc1e9aa` | Owner-run TUI measurement, first run read: `run-1b201c1a-ba04-4dd5-8aca-e0ed302c2904` (cwd `~/tmp/cmp`, target `https://ise.uit.edu.vn/`, event-driven/isolated, 3 workers, target-ops 2, heartbeat 600 s, quota 1024 MiB, capture 1024 KiB, mode exploit, manifest runtime digest `67236dfffad4` = commit `7e5a0c3^` — before A1/A2, so this is a P21 baseline, not the chain measurement). Two rounds and one reconciled resume produced 51 worker target operations, 53 artifacts, 2 worker claims, 0 accepted cases, 1 case awaiting review, 14 tasks (6 dispatched, 12 cancelled), 46 coverage cells (4 tested, 42 blocked, 12 stale), 16 open gaps; both stops (seq 244 and 641) were labelled `storage-failed` — a misclassification. Receipts rebuilt from the run: 17,244 B (net) and 16,930 B (shell) against the 16,384 B row bound, so `Record is too large` was thrown after a successful return and the retention path closed the run; the store was healthy (checkpoint 477 KB then 1.3 MB committed afterwards). Three defects fixed in this commit: (A5-fix-1) the receipt is bounded as a whole row, with stdout then stderr then input shrunk (command text last) and `truncated` set; (A5-fix-2) the row refusal is coded `ERR_RECORD_TOO_LARGE`, `storageFailure` no longer closes authority for it, and the cause is persisted as `retentionError`; (A5-fix-3) `p2o_graph action=query` returns the retained revision id a review resolves (review was refused in both rounds, 6 hypotheses carried `GRAPH_UNREVIEWED`). The chain layer was not measured: 0 chain rows authored, 0 ready steps, no A2 `CHAIN`/`NEXT LINK` lines (the build predates them); chaining happened only through 6 intents citing the 2 claims in `work.claimRefs`, and 2 ready intents (`task-24c05d80`, `task-65c62255`) queued behind validation with executors 2/2 and were cancelled at the stop. `npx tsc --noEmit` clean; focused `evidence-row-bound` 3/3, `graph-review-id` 2/2, `workspace-runtime` 56/56 across the touched consumer files; red/green proven by reverting the four source files (the new tests fail, then pass); full suite 167 passed / 5 skipped files (172), 1,481 passed / 13 skipped tests (1,494), 0 fail (+2 files, +7 tests); `npm run build` + `check:build` green; surface audit 35 registered / 35 model-visible / 0 hidden / 10 board verbs with 0 contradictions, declarations unchanged (planner 45,049/45,500, worker 40,935/41,400, validation 40,124/40,500); `validate_library.py` PASS 336 documents; `git diff --check` clean for the change (owner's `AGENTS.md` edit only); GitNexus pre-edit impact `appendRecord` CRITICAL (111 symbols, 84 processes) and `storageFailure` CRITICAL (157, 99) reviewed as a classification-only change, `EvidenceStore.receipt` UNKNOWN confirmed by text search (`executeWithReceipt`, `recordCandidate`); `detect_changes --scope all` before the commit: 6 files / 75 symbols, `risk_level: critical` on the append/receipt hub reviewed as additive (the two new test files are untracked, so the git-diff reach signal does not include them; tsc/build/tests cover them). The run also deviated from §11.2 (exploit mode instead of assess first). The owner's second live run (`run-51d84fce-b16f-4a68-8e14-e9170cebd455`, cwd `~/tmp/p2o-live-a5`, assess mode, 2 workers, target-ops 2, quota 1024 MiB, runtime digest `b590bdff…` = the A5-fix-1..3 build) ran 25 minutes and 4 rounds: 249 records / 879 events / 54 receipts / 4 claims, and no retention failure — fix-1..3 held. It then died at round 4 with an uncaught stale-context rejection 0.33 s after `planner.round-start` (no `planner.round-session` row for round 4, so `ctx.newSession` was in flight): the engine's coalescing tick called `wakeIdle()`, the host idle read threw, `kick()` routed it to `pause()`, and the pause notice read the same invalidated context again. Fixed as A5-fix-4 (`7910e10`): `wakeIdle()` treats an unreadable host surface as a transition and skips that wake (the next kick or the replacement's `session_start` re-reads it) instead of pausing the campaign; the pause notice goes through the P19/H guarded UI read. Two tests hold the invalidation window open (the scheduler skips and still wakes after recovery; a pause through a fresh command context does not throw) and fail without the fix. This run also authored no chain row (0 `chainOf`), so it is not the chain measurement either. `npx tsc --noEmit` clean; focused `engine` and `round-session` new tests pass; full suite 167 passed / 5 skipped files (172), 1,483 passed / 13 skipped tests (1,496), 0 fail (+2 tests, none deleted or skipped); `npm run build` + `check:build` green; surface audit 35 registered / 35 model-visible / 0 hidden / 10 board verbs with 0 contradictions, declarations unchanged (planner 45,049/45,500, worker 40,935/41,400, validation 40,124/40,500); `validate_library.py` PASS 336 documents; `git diff --check` clean for the change (owner's `AGENTS.md` edit only); GitNexus impact pre-edit `wakeIdle` HIGH (exact, 1 direct caller), `kick` HIGH and `pause` CRITICAL (both lower-bound, 4 dropped receiver call sites each) reviewed as guard-only, `detect_changes --scope all` 8 files / 21 symbols / 20 processes (stale index; includes the owner's `AGENTS.md`), no `partial`/`truncated` | A5 measurement is still open: owner-run assess-mode run on the current build per §13, then record the chain-layer numbers (chain rows authored, A2 lines present in briefs, ready links left undispatched, repeated questions) and close the row. Matrix rows F-P22-A5-fix-1..4 and these HISTORY rows landed with this record commit |

## 11. Owner decisions recorded (answered in chat, 2026-10-30)

1. **Scope:** option A — a chain-aware exploitation layer (A1–A5); options B (chain as a stored record) and C (live-run-first)
   were not taken. A2 was implemented ahead of the plan because it was additive and needed no target.
2. **Live run:** `https://ise.uit.edu.vn/` is authorized; the owner runs it from their own TUI and confirms the single consent
   dialog; assess mode first, read-only; proposed budget workers 2 / target-ops 2 / round-steps 30; provider cost is
   the owner's. Exploit-mode chain testing stays on the local lab.
3. **Commit and push:** owner-initiated only. A2 stays uncommitted until the owner decides how to phase it with A1.
4. **Plan of record:** this file replaces P21; the P21 revision stays recoverable at `5763d46`.
5. **Analysis basis:** the owner's question about ARTEX's asset/vulns graph and "take attack chain từng phần" is answered by
   §2 and §3; the plan targets the chain handoff, the branching readiness rule and the report, not a new graph.

## 12. Evidence and reproduction

- **Baseline:** `git log -1` = `5763d46` (P21/C doc record). Baseline suite at that commit: 161 passed / 5 skipped files (166),
  1,434 passed / 13 skipped tests (1,447), 0 fail; P21's delivered gate numbers are in §10 of the revision at `5763d46`.
- **A1+A2 commit:** `7e5a0c3` — 11 files, +335/−4: the new `src/chain-brief.ts` and its tests, the `chainBoard` provider rule,
  the brief block, and the matrix/PLANNER_ENGINE/ARCHITECTURE rows. The `AGENTS.md` change in `git status` is the owner's edit
  and is not part of it.
- **ARTEX snapshot:** `my_references/ARTEX` (0.3.15, upstream commit `e6ec569`, AGPL-3.0, gitignored). §3 reads
  `db/schema.sql`, `db/exploration.go`, `db/finding_traffic.go`, `agent/planner.go`, `agent/worker.go`, `agent/tools.go` and
  `agent/promptcatalog.go`; the longer analysis is `my_references/ARTEX/ARTEX_AGENTIC_CORE.vi.md` (1,364 lines).
- **Live run:** one owner-run baseline read (§10 A5): `run-1b201c1a-ba04-4dd5-8aca-e0ed302c2904`, P21 build, exploit mode,
  measured for defects (three fixed). Its two stored reports are `-final` (asOf 245) and `-final-2` (asOf 642); the store and
  artifacts are under `~/tmp/cmp/.p2o-state` and `~/tmp/cmp/.p2o-reports`. A second owner-run read
  (`run-51d84fce-b16f-4a68-8e14-e9170cebd455`, assess mode, the A5-fix-1..3 build) ran 25 minutes and 4 rounds and measured
  A5-fix-4; its store is under `~/tmp/p2o-live-a5/.p2o-state`. Both reads authored no chain row, so the assess-mode chain
  measurement is still outstanding; the runbook and the evidence it will read are in §13. The P21 run
  `run-42c447d6-cb8a-4c65-85a7-6f4036014ef6` is evidence for the P21 plan only, not for this one.
- **Previous plans:** `git show 2e22b5c:planning_update.md` (P19/P20) and `git show 5763d46:planning_update.md` (P21).

## 13. Appendix — live-run runbook (A5)

Run from a scratch cwd so the durable store and the report do not land in the repository:

```bash
mkdir -p /tmp/p2o-live/ise-uit && cd /tmp/p2o-live/ise-uit
~/.pi/agent/bin/pi --no-extensions -e /home/nhanlaptop/project/pi-p2o
```

In the TUI (the owner confirms the consent dialog; the agent does not confirm it on the owner's behalf):

```text
/p2o --target https://ise.uit.edu.vn/ --mode assess --goal "Map the external attack surface of ise.uit.edu.vn: reachable services, exposed routes, authentication boundaries and exposure gaps, each with recorded evidence" --workers 2 --target-ops 2 --round-steps 30 --export
```

While it runs: `/p2o status`, `/p2o digest`, `/p2o report`; `/p2o pause` then `/p2o stop` stops scheduling and cleanly ends the
run. A5 reads, in this order: `.p2o-state/<runId>/assessment.sqlite` (records, graph, plan rows, claims, cases, events),
`.p2o-reports/report-<runId>/` and `-final/REPORT.md`, and the run id the owner reports. The measurement targets S1–S6 and A1–
A4 specifically: chain rows authored, A2 lines present in exploitation/chaining briefs, ready links left undispatched, repeated
questions, and which chain representation the planner actually used.
