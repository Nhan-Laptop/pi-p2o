# R1 update — graph as working memory, recon-to-exploitability, attack paths (A+B+C)

Status: **approved 2026-10-28; R0 committed as `1d79ec9`; R1 implemented and verified in the working tree
(2026-10-28), awaiting owner review before R2.** The owner approved the A+B+C program and chose to start with R0; the
remaining phases are implemented only after each phase's verification and owner review. This document is the plan of
record and replaces the A1 text; that text is unchanged in git at `git show bbdfec1:planning_update.md` (and the P18 text
at `git show 18d1d84:planning_update.md`). Baseline: HEAD `bbdfec1` ("Audit the whole tool surface and default conservative
omissions (A1.2)"); R0 is now the committed head `1d79ec9` and the R1 changes are uncommitted working-tree files listed in
§R1 and §9. The owner's `AGENTS.md` edit and untracked `pi-p2o-defense-vi.pptx` are not part of these milestones and are
not touched.

Owner request (2026-10-28, verbatim):

> "ok now I need you make a deeply analyze, inspect the current extension's assets/ vulns graph, from that find any
> weakness either or anythings to enhance to project pentes's capabilities of pentesting - exploit - research red team.
> You should take a ref at ARTEX, the revalent knowledge in the internet, after that combine then to compare with our tech
> so that can improve - enhance project. let's do it"

Owner decisions for this milestone (made in chat, 2026-10-28):

- Scope: **A + B + C** (full program), staged so each phase is shippable and reviewable on its own.
- Implementation: **approved; start with R0** (containment/correctness), then R1, R2, R3, R4.
- D-R1-3: **hypothesis + `basis=inferred` relations** (workers may write both; observed relations stay planner/owner).
- D-R1-4: **bounded host fetcher** (not sandbox execution).
- D-R1-5: **auto-ingest on capture + `p2o_graph action=ingest`**, no new tool.
- D-R1-8: **project-level DB with auto-merge** (not a read-only pack); safeguards described in R3.9.
- D-R1-9: **SARIF + STIX both in R3**.
- D-R1-10: **offline CI bench + live run only with authorization and a cost cap**; the owner supplied the live target
  `https://hcmussh.edu.vn/` and a **USD 2** cap, gated on the owner's authorization for that host.

---

## 0. Scope and non-goals

**Goal.** Turn the revisioned asset/fact graph from a passive knowledge store into the working memory of the
recon→discovery→exploit→validate→report loop, and add the missing offensive-analysis layers: deterministic recon
ingestion, component/CVE/exploitability joins, bounded attack-path queries, a red-team technique crosswalk, a retest
lifecycle, and machine-readable interop. Preserve the evidence ladder, role authority and sandbox containment that make
the project stronger than the reference tools.

**Non-goals, this milestone:**

- No weakening of the evidence ladder: a scanner result, a CVE lead, an extracted fact or a hypothesis is never a claim,
  a case or a finding by itself.
- No change to the sandbox containment (no pivot, tunnel, C2, OAST listener, AD attack execution, credential harvesting
  beyond the existing sealed-literal path). Internal-network depth is a separate owner decision.
- No live benchmark run until the owner confirms authorization for the target host; the approved live target and cap are
  recorded in D-R1-10 (`https://hcmussh.edu.vn/`, USD 2).
- No cross-run evidence reuse: a project-DB asset/finding is suggested context only, never same-run evidence for a case
  or cell.
- No changes to `AGENTS.md`, `pi-p2o-defense-vi.pptx`, or any owner file.
- No unrelated refactor: every changed line must trace to a phase below.

**Why the full program and not just quick wins.** The references and the public state of the art agree that the ceiling is
not retrieval quality but planning/commitment and the absence of a durable, checkable state that a planner can act on
(ARTEX dual graph + intent frontier; Strix's validator-first reports; the 2026 PentestGPT comparison where a memory layer
improved neither system because the agents never committed a hypothesis to a concrete test). We already have the checkable
evidence ledger; what is missing is the graph-side state and the offensive analysis on top of it.

---

## 1. Verified baseline

### 1.1 What the graph is today

Five SQLite tables in the run store: `assets`, `assertions`, `relations`, `anchors`, `graph_provenance`
(`src/state/store.ts:768-863`). Identity and versioning:

| Row | Current shape |
| --- | --- |
| asset | 12 kinds; exact NFC `key` ≤500 (no URL/path/method normalization, `src/state/graph.ts:5,114-124`); label; attributes ≤16×500; anchors ≤10; evidenceRefs; `asset-<sha(scope,kind,key)[:24]>`; revision `rN`; content hash decides whether a write is a new revision |
| assertion | one table for facts (`observed|inferred|contract|configuration`) and hypotheses (`open|supported|refuted|inconclusive`, impact, counterevidenceRefs); host-stamped `unverified:true`; content-addressed `assertion-<24hex>` |
| relation | 16 kinds; `fromId/toId` + revisions; `basis observed|inferred`; `status active|withdrawn`; host-stamped provenance |
| anchor | 7 kinds (path, symbol, url, header, config, commit, artifact); attaches to an **asset only** |
| provenance | actor/task/role/depth/revision; host-owned producer; repeated identical writes add an observation, not a revision |

Limits (`src/state/graph.ts:13-31`): 5,000 asset revisions / 10,000 assertions / 2,000 relations / 20,000 anchors,
multiplied by `graphCapacity` 1–4; 128 rows and 128 KiB per batch; 7 KiB per row enforced (`store.ts:789`); 24 KiB per
read response; `page`/`export` return assets only; `export` ≤500 rows, `page` ≤100. Staleness is a read-time flag
(assertion subject revision, relation endpoint revision, case pins, coverage pins) and is never stored.

### 1.2 What the rest of the loop already is

- Claims: `src/evidence.ts` candidate records with typed `closure`/`execution`/`proof`, typed capabilities
  (`src/capabilities.ts`), payload/environment replay, independent validation, `ruled_out` one-recheck rule. Claims
  carry `surface`/`risk` text and an optional host-stamped `taskRef`; **no asset field** (`src/evidence.ts:18-44,87-168`).
- Cases: `src/case-types.ts` with `assetRefs` (≤10, pinned), `claimRefs`, `hypothesis {id,revision}`, contradictions,
  remediation/retest task, rating (CVSS 3.1 from owner vector; CVSS 4.0 impact from demonstrated depth), review state.
- Chain: `src/chain-view.ts` joins typed `gained`/`needs` into ready/unmet/frontier; `chain` action can draft a task.
- Coverage: host-derived cells from reviewed task work + claims + cases + pinned asset (`src/coverage.ts:103-127`); WSTG
  108-test map; L0–L3; unmapped tasks are gaps.
- Policy/sandbox: `/target` read-only, no ingress by default, `--lab-network` opt-in, sealed secrets, effect classes,
  deterministic report with manifest hashes.
- Report: `REPORT.md`, `cases.csv`, `coverage.csv`, `findings.json/csv`, `wstg-checklist.csv`. `report-export.ts` imports
  no store/graph module and prints raw `asset-…` ids (verified: imports at `src/report-export.ts:1-20`, asset lines at
  `:179`, `:288`).

### 1.3 Measured weaknesses from the A1/A1.2 audit

- `p2o_graph` was the **top failure source**: 104 failures / 216 KiB of error text across the audited sessions; 29
  argument-schema + 37 secret-guard + semantic. In the 11 current-surface sessions: 15 failures / 85.8 KiB
  (`planning_update.md` at `bbdfec1` §1.2).
- The reference session the owner pointed at made 5 `p2o_graph` calls; 4 were refused (row-level `evidenceRefs`, two
  `requestId` misplacements, a cookie **name** refused as a secret), and the remaining call was refused with
  "Workers record assets, facts and anchors; hypotheses and relations are owner review work" — i.e. the model tried to
  use the graph as working memory and the role boundary refused it (§1.3).
- A1 fixed the mechanical classes; A1.2 fixed 21 conservative defaults. Neither changed the fact that the graph is
  **manual, hard to query, and disconnected from the finding ledger**.

### 1.4 Independent audit findings accepted into this plan

A read-only code audit of the graph/pentest loop (2026-10-28) confirmed and added to the analysis:

| ID | Finding | Evidence |
| --- | --- | --- |
| W1 | Asset graph and claim/case ledger are two disconnected stores; claims carry no asset ref and the chain join runs on claims alone | `src/evidence.ts:18-44`; `chain-view.ts:126-139` |
| W2 | The report cannot see the graph: no asset inventory, no resolved identities, no facts/relations/attack-path section | `src/report-export.ts:1-20,179,288` |
| W3 | `graphExport`/`page` select relations only when **both** endpoints are on the page (`from_id IN … AND to_id IN …`), count the same subset, and give no edge cursor; cross-page edges are unreachable from the page | `src/state/store.ts:930-955` |
| W4 | `assetEntityIds()` has no `WHERE scope=?` although every other reader filters scope; it feeds `discoveredUnplannedAssets` | `store.ts:730-733`; `coverage.ts:155` |
| W5 | `refs()` error says "at most 10" but never checks length; the tool schema has no `maxItems` | `src/state/graph.ts:137-141`; `graph-tool.ts:6` |
| W6 | An assertion revision can retain the old entity id while the statement no longer hashes to it; re-recording the new statement without `supersedes` creates a second entity | `store.ts:829-834,846` |
| W7 | Hypotheses are write-mostly: no model-facing query, no summary, no consumer in the loop | `docs/KNOWLEDGE.md:20`; `graph-slice.ts:28-40` |
| W8 | Relations are invisible to workers; no transitive/path query; `alias_of` has no consumer | `graph-slice.ts:28-40`; `graph.ts:212` |
| W9 | Anchors attach to assets only; a fact/hypothesis cannot be pinned to `file:line`/symbol | `graph.ts:50`; `store.ts:807-808` |
| W10 | Research fetch runs in the owner process with no allowlist and **no response cap**; `cve.ts` still has a stale "only hosts a CVE fetch may reach" comment contradicted below it | `extensions/p2o/index.ts:2098-2104`; `src/cve.ts:12-14,39-44`; `src/tool-schemas.ts:123` |
| W11 | Lead lifecycle is thin: no task id on `tasked`, no dedupe, no version-range match against the asset's recorded version, no EPSS/KEV | `extensions/p2o/index.ts:2138-2151`; `src/cve.ts:15,119-146` |
| W12 | Derived coverage cells have no stored history (`revision:1`, fingerprint id), so "tested at sequence N" needs ledger replay | `coverage.ts:151` |
| W13 | Manual graph authoring remains expensive even after A1/A1.2 | §1.3 above |
| W14 | No effectiveness measurement; bench protocol is "ready but NOT run"; historical campaigns contaminated | `bench/README.md:11-22`; `docs/ACCEPTANCE_MATRIX.md:376` |
| W15 | Worker write enforcement is in the broker; the planner still holds `p2o_graph` and can author hypotheses/relations; `tool-policy.ts:22` still says "follows in A2" | `extensions/p2o/index.ts:3806`; `tool-policy.ts:18-24` |

Additional ergonomics confirmed by measurement: the tool surface is 32 model-visible tools with strict declaration
budgets (planner 48,245/49,300; worker 41,120/44,100; validation 40,312/43,300; reporter 6,786/6,800; model
74,451/77,900 — the reporter has **14 characters** of headroom). Any new declaration text must fit or be traded out;
internal changes (report fields, storage, export) are free of this budget.

---

## 2. Comparison and prior art

### 2.1 Reference behaviour (local snapshots)

| Dimension | ARTEX | Strix | pi-p2o today |
| --- | --- | --- | --- |
| Asset model | 6 types, natural-key dedupe, containment derived at read time, no `asset_edges` | threat model + report state; no real asset graph | **12 kinds, revisioned, 16 relations, anchors, provenance** (richest) |
| Exploration model | `goal/intent/fact/finding/hint/digest` nodes + `spawns/derived_from/yields/proves/covers` edges + `exploration_anchors` | 35-field finding record + coverage ledger + per-agent todos | task/plan board + claim ledger + coverage cells; **no finding/claim in graph** |
| Evidence | traffic role `baseline|proof|verification|supporting`, but evidence optional, severity free text, no CVSS | PoC required, counterevidence required, closure 3 states | **typed receipt→claim→case, independence replay, CVSS host-computed, report hash** (strongest) |
| Planning | intent frontier, dispatch-zero legal only with a reason, anti-repeat prompt, shared todolist, one serial chain step per wake | LLM root + specialists, cost budget, tool-gated finish | planner-first tasks/plans + chain readiness + completion obligations |
| Graph query | `list_assets` DSL, `list_untested_assets`, `node_detail`, cross-worker trace search | coverage/notes/report-state tools | page/view/export/chain only; no search/filter/aggregate |
| Attack path | edges exist, **nothing computes a path** | none | chain join on capabilities, no relation traversal |
| Retest | retester agent with `reproduced|fixed|inconclusive`, evidence version pin | dedupe/re-run | in-run `remediation.retestTask` only |
| Interop | markdown/report/UI | SARIF + markdown + CVSS | `findings.json/csv` proprietary; no SARIF/STIX/ATT&CK |
| Measurement | no in-tree harness | XBEN 104 challenges (vendor-reported) | none; docs say UNVERIFIED |

Sources: `my_references/ARTEX/db/schema.sql:170-258`, `db/exploration.go:1136-1181`, `agent/planner.go:298-345`,
`db/finding_retests.go:183-186`, `agent/tools.go:1219-1233` (finding evidence optional), `report/report.go:46-90` (no CVSS);
`my_references/strix/report/state.py:69-114`, `tools/reporting/tool.py:1009-1105`, `report/sarif.py:1127-1135`,
`tools/coverage/tools.py:40-48`, `benchmarks/README.md:20-45`. ARTEX snapshot is a community mirror; upstream is 404, so
it is used as a design reference, not as a claims source.

### 2.2 Industry patterns that shape this plan

- Dual graph + anchors (global asset identity separate from per-engagement exploration, joined by an anchor table) —
  ARTEX; matches our asset graph + ledger, missing only the join.
- Edge semantics in the schema: BloodHound splits traversable vs informational edges; ATT&CK models `targets`
  (attack-pattern → asset). A path query is only trustworthy if traversal is a property of the edge kind, not of a prompt.
- CVSS as a stored vector, computed score; EPSS/KEV as separate decaying exploitability signals; standard IDs (CWE, CVE,
  CPE, ATT&CK, WSTG) as join keys instead of new taxonomies.
- Candidate claims vs findings: a validator or programmatic proof turns a candidate into a finding; ARTEX/Strix both
  converge there, and neither publishes a typed claim→evidence→verdict ledger — our design space.
- Planning, not memory, is the ceiling (2026 PentestGPT comparison: a coverage-memory layer helped neither system; agents
  held evidence and never committed to a test). That argues for explicit hypothesis objects with prerequisites, which is
  what R1/R3 add.
- Skill/capability split: capabilities stay typed and policy-gated; skills stay prose and reference them by ID.

URLs: [XBOW](https://xbow.com/blog/top-1-how-xbow-did-it), [BloodHound traversable edges](https://bloodhound.specterops.io/resources/edges/traversable-edges),
[ATT&CK relationship types](https://mitre-attack.github.io/attack-data-model/schemas/relationship-types/),
[CVSS v4](https://www.first.org/cvss/v4.0/specification-document), [EPSS](https://www.first.org/epss/),
[Cybench](https://arxiv.org/abs/2408.08926), [AutoPenBench](https://arxiv.org/abs/2410.03225),
[PentAGI memory](https://pentagi.com/docs/concepts/memory/), [Anthropic tool guidance](https://www.anthropic.com/research/writing-tools-for-agents).

### 2.3 What we deliberately do not copy

- ARTEX: free-text severity, optional evidence, `confirmed` for `inferred` facts, coverage as "asset has a fact" proxy.
- Strix: one Kali container per scan with NET_ADMIN; LLM-judge dedupe as the primary gate (we keep deterministic keys +
  owner review; an LLM judge would add a non-reproducible decision to the evidence path).
- Industry: no unbounded graph traversal, no LLM-only path scoring, no silent heuristics in the report.

---

## 3. Design decisions for owner approval

Each decision lists the alternatives considered. **Recommended** is what the plan assumes; the owner may change any of
them before implementation starts.

| ID | Decision | Options and trade-offs | Recommendation |
| --- | --- | --- | --- |
| D-R1-1 | Where findings live | (a) **Derived projection** of the existing claim/case ledger onto asset reads; no new table | (b) new persisted `finding` rows (duplicates the ledger, needs its own staleness) | (c) hybrid (persist only accepted cases) | **(a)**: one source of truth, no migration, staleness already computed; the dossier is bounded and can be recomputed on read |
| D-R1-2 | Extraction identity normalization | (a) extractor canonicalizes URL/route/package keys deterministically at parse time and records the raw value in an anchor/attribute | (b) keep exact-bytes identity and let the model submit normalized keys | (c) add a normalization pass over the whole graph | **(a)**, scoped to extractor-produced assets only; documented deviation from the graph's no-implicit-normalization rule; raw value retained for audit |
| D-R1-3 | Worker graph writes | (a) hypotheses only; relations remain planner/owner | (b) keep owner-only | (c) hypotheses + `basis=inferred` relations; observed relations stay planner/owner | **(c) chosen by the owner**: workers gain working memory; inferred relations are review debt and path queries flag `basis=inferred`; observed relations remain curated |
| D-R1-4 | Research fetch containment | (a) bounded host fetcher (timeout 15 s, 4 MiB body, ≤5 redirects, resolve DNS and deny loopback/link-local/cloud-metadata even after redirects, text/json/xml content types) | (b) move the fetch into the sandbox executor and return a bounded preview + artifact | (c) keep unbounded host fetch and only document it | **(a) chosen**: fixes the SSRF/host-memory hole without reversing the Part XI "any http(s) source" decision; (b) remains a later owner decision |
| D-R1-5 | Ingestion trigger | (a) automatic extraction when a recognized capture/artifact is stored, plus `p2o_graph action=ingest` for manual retry | (b) explicit tool call only | (c) new `p2o_ingest` tool | **(a) chosen**: no new model-visible tool (declaration budget), recognized types only, bounded, provenance `extractor` |
| D-R1-6 | Exploitability enrichment | (a) NVD (existing) + CISA KEV + FIRST EPSS, cached with `retrievedAt`/sha256, offline fallback = unknown | (b) NVD only | (c) add exploit-db/Metasploit lookups | **(a)**: public, deterministic, provenance-friendly; (c) is scraping/licence/availability risk and is not needed to rank |
| D-R1-7 | ATT&CK scope | (a) curated subset 40–60 techniques for infra/AD/cloud + WSTG→ATT&CK crosswalk, pinned version | (b) full matrix | (c) none | **(a)**: useful for red-team reporting, maintainable; full matrix is taxonomy work without a measured use |
| D-R1-8 | Cross-run knowledge | (a) read-only knowledge pack per workspace (asset keys + finding fingerprints + status), imported as `reference` context only | (b) project-level DB with auto-merge | (c) none | **(b) chosen by the owner**: retest/recurrence across runs; safeguards in R3.9 — tenant/scope isolation, append-only provenance, `suggested` rows only, no same-run evidence |
| D-R1-9 | Interop | (a) SARIF now, STIX later | (b) both now | (c) SARIF only | **(b) chosen**: SARIF 2.1.0 and STIX 2.1 both in R3 |
| D-R1-10 | Live benchmark | (a) offline fixture bench in CI; live runs only with authorization and a budget cap | (b) run live by default | (c) no benchmark | **(a) chosen with the owner-supplied live target `https://hcmussh.edu.vn/` and USD 2 cap**; the live run is gated on the owner's authorization for that host and is never part of CI |
| D-R1-11 | Traversable-edge representation | (a) a code constant mapping relation kind → traversable/informational, exposed on read | (b) stored flag per relation row | **(a)**: no migration; semantics stay reviewable in one file; stored flags drift |
| D-R1-12 | Graph query implementation | (a) bounded prefix/label/attribute SQL queries first; FTS5 only if measurements show the need | (b) add FTS5 now | **(a)**: no schema migration in R1; SQLite JSON1 is enough for ≤5,000 assets; FTS is a later measured optimization |

All other decisions (existing evidence rules, role authority, limits, no settings by default) stay as recorded in the
A1 and P18 decisions; this plan does not reopen them.

---

## 4. Phases

Each phase is independently shippable, gated by the verification table in §5, and ends with an owner review point.
Phases are ordered by dependency: R0 correctness and containment, R1 graph-as-state, R2 recon/inventory/exploitability,
R3 attack paths/technique/retest/interop, R4 measurement. If the owner wants a smaller first bite, **R0 + R1** is the
quick-win slice.

### R0 — Correctness and containment (S/M, one pass)

**Goal.** Fix the defects that would otherwise be baked into the new layers, and close the host-side research-fetch hole.

1. **Research/CVE fetch containment (D-R1-4).**
   - Replace `fetchPage` (`extensions/p2o/index.ts:2098-2104`) with a bounded fetcher (`src/research-fetch.ts`): resolve
     the hostname and check **every** returned address on every hop (including each redirect target) before the request;
     deny loopback, link-local, private, CGNAT, multicast, reserved, documentation, NAT64/6to4 and cloud-metadata addresses;
     timeout; response byte cap (4 MiB) with truncation marker; redirect cap; content-type allowlist for research text;
     retain a bounded body on the record and the existing artifact path for larger text.
   - Fix the stale comment at `src/cve.ts:12-14` and the tool description text (`src/tool-schemas.ts:123`), and update
     the containment sentence in `src/prompts.ts:129` to say exactly what is true after the change.
   - Tests: metadata/loopback/link-local refused; redirect to a denied host refused; oversized body truncated with a
     marker; timeout; normal NVD fetch still works (mocked); no unbounded body in memory.
2. **Graph export relation accounting (W3).**
   - Count and expose relations whose **either** endpoint is in the selected set, with `countScope` and
     `omittedByKind.relations` accurate; add `omittedRelationEndpoints` or a follow-up cursor so a caller can discover an
     edge to an asset outside the page. Keep the 24 KiB response bound and the existing rollback on overflow.
   - Alternative if the response grows: a dedicated relation page cursor (edge sequence) instead of widening the asset
     page. The plan allows either; choose at implementation time based on the measured response size.
   - Tests: edge with one endpoint on the page is counted/found; cross-page edge is reported honestly; truncation marker;
     response ≤24 KiB.
3. **`assetEntityIds()` scope predicate (W4).** Add `WHERE scope=?` to the identity query (`store.ts:730-733`). Test with
   a store containing a stale-scope asset row (sealed bundle path) that must not inflate `discoveredUnplannedAssets`.
4. **`refs()` length cap (W5).** Reject >10 on write with the message the code already prints; add `maxItems: 10` to
   `evidenceRefs`/`counterevidenceRefs` in the record schema; reads stay lenient for legacy rows. Tests: 11 ids refused
   with a one-line message; 10 accepted; legacy row with more still readable.
5. **Small contract drifts.** `tool-policy.ts:22` stale A2 sentence; `assetCount` doc/behaviour mismatch
   (`store.ts:661-662`); assertion id drift (W6) documented as intentional entity-id retention with a test pinning the
   current behaviour (do **not** re-hash/migrate in R0).

**Acceptance R0.** All new tests green; full suite green; `tsc` clean; no schema migration; no authority change; the
research/CVE containment test proves the host cannot be steered to loopback/metadata and cannot allocate an unbounded
body from a model-chosen URL.

**Verified 2026-10-28 (working tree).** `tsc --noEmit` clean; focused suites green (`research-fetch-containment` 7,
`research` 11, `truth` 8, `graph` 24, `graph-record-shape` 5, `recon` 15, `acceptance-matrix` 3); full `vitest run`
**137 passed / 5 skipped files (142), 1,215 passed / 13 skipped tests (1,228), 0 fail**; `npm run build` +
`npm run check:build` → `build import OK`; `git diff --check` clean; `detect_changes --scope all` reviewed (87 changed
symbols / 18 files / 40 processes, risk critical because it also sees the owner's `AGENTS.md` edit and a stale
`planning_update.md` mapping — index is 2 commits behind HEAD and cannot be rebuilt under the sandbox EROFS, so the
staleness is reported, not hidden). Python gates untouched by R0 and not rerun.

**Delivered (working tree, 2026-10-28).**

- `src/research-fetch.ts` (new): `fetchBounded` with `isBlockedAddress`/`isTextContentType`, 15 s timeout raced against
  the transport, 4 MiB cap, ≤5 redirects, per-hop destination check, truncation marker. `fetchPage` delegates to it.
  Description/prompt/`docs/KNOWLEDGE.md` now state the bounds; the stale `cve.ts` "only hosts" comment is gone.
- `graphExport`/`page` relations are selected by **either** endpoint, `countScope.relations` says so, and the warning
  explains that a cross-page edge is in JSON but not in Mermaid; counts/omittedByKind use the same predicate.
- `assetEntityIds()` filters by `scope`; `refs()` refuses >10 on write and the Pi schema declares `maxItems: 10`; the
  assertion entity-id retention is documented as intentional; the stale `tool-policy` A2 sentence is corrected.
- `assetCount()` now counts current same-scope asset **heads** (`count(DISTINCT entity_id)`), which is what the M6 progress
  counter and `graphSummary().assets` mean; it used to count retained revisions, so an update was reported as a new asset.
  The R0 test pins the two-revision and new-identity cases.
- Tests: `tests/minimal/research-fetch-containment.test.ts` (7); `research.test.ts` updated to mock the bounded fetcher and
  adds the cap-marker case; `truth.test.ts` pins the bounded fetch description; `graph.test.ts` adds cross-page relation,
  refs-cap, foreign-scope identity and asset-head-counter cases; `graph-record-shape.test.ts` pins the schema cap; the
  acceptance matrix gained an R0 evidence section, and the P8/P9 rows now record that R0 superseded the "uncapped" premise.
- **Deviation, accepted:** the fetch checks each hop's addresses but does not pin the IP for the request (global fetch
  resolves again), so a DNS-rebinding host remains a residual risk for a **citation** URL; the target path stays in the
  sandbox, and the recommendation to pin or move the fetch into the sandbox is recorded as a residual risk in §6.

### R1 — Graph as working memory (M, one to two passes)

**Goal.** One bounded read answers "what do we know and what is confirmed on this asset?", the graph becomes queryable by
planner/worker, and a worker can record its hypothesis without waiting for the owner.

1. **Asset dossier (`src/graph-dossier.ts`, new; read-only projection).** The graph `view` result gains derived sections
   for one asset, computed from the ledger + graph on read, never stored:
   - accepted/current cases (id, revision, severity, reviewStatus, currentness, rating current?);
   - claims touching the asset (id, closure, execution, proof, demonstrated?, capabilities, taskRef, currentness);
   - coverage cells (questionKey, execution, assessment, currentness), plus "no cell" as an explicit gap;
   - tasks that touched it (id, status, question);
   - hypotheses (open/supported/refuted counts + ≤5 open statements) and immediate relations (≤20) — a short version is
     also added to the worker slice (R1.5);
   - open gaps/leads; each section carries an omission counter and the response stays ≤24 KiB.
   - Wiring: handler in `extensions/p2o/index.ts` (owner path around `:2985-3043`, worker path around `:3819`); the store
     remains graph-only, so the dossier cannot become a second source of truth.
   - Tests: fixture with asset + fact + hypothesis + claim + accepted case + coverage cell; dossier returns all sections;
     stale pins shown as stale; truncation counter; secret-bearing strings redacted; deterministic ordering.
2. **Claim asset stamping (D-R1-1).** The host derives the claim's `assetRefs` from the executing task's `work.assetRefs`
   (pinned via the store) and stamps them on the candidate record (`src/evidence.ts` candidate path,
   `extensions/p2o/index.ts` call site). The model never supplies asset ids on a claim; legacy claims stay asset-less;
   cases keep deriving from task refs. Tests: host-stamped refs present and pinned; a model-supplied ref is ignored or
   refused; a claim with no task ref is legal but has no asset; stale claim refs appear in the dossier as stale.
3. **Graph query and summary actions (D-R1-12).**
   - `p2o_graph action=query`: bounded filters `kind`, `keyPrefix`, `labelContains`, `attributeKey`+`attributeValue`,
     `assertionKind`, `statementContains`; returns ≤20 rows + `counts` + `nextCursor`; keyPrefix requires a kind; no
     unbounded scan; same redaction as reads.
   - `p2o_graph action=summary`: since-sequence delta for the planner — new/changed assets, assets with no claim, assets
     with no coverage cell, open hypotheses, accepted findings by asset, chain frontier counts; ≤8 KiB, both a compact
     text block and machine rows.
   - No change to `p2o_state` knowledge domains in R1 (the graph query lives where the data is; this avoids coupling the
     record index to the graph store). Revisit only if measurements show the planner still cannot find things.
   - Tests: query matches kind/prefix/label/attribute/statement; empty result; cursor; limit cap; secret shape refused;
     summary counts match fixtures; response bounds.
4. **Worker hypotheses and inferred relations (D-R1-3).** The worker may write `hypotheses` and relations with
   `basis=inferred` only; relations with `basis=observed` stay planner/owner-only because a path query treats observed
   edges as fact. A worker row is host-stamped `unverified:true` with producer role, appears in the dossier and summary,
   and creates a review debt the owner can settle by superseding it with `supported|refuted|inconclusive`. Keep the
   existing broker check with a message that names what a worker *can* write. Tests: worker hypothesis accepted; worker
   inferred relation accepted; worker observed relation still refused (message names planner/owner); owner writes
   unchanged; supersede review path; a hypothesis/relation cannot satisfy a claim/case obligation.
5. **Worker graph slice (W7/W8).** `src/graph-slice.ts` adds immediate relations (≤20) and open hypotheses (≤5), plus a
   one-line "accepted findings on this asset" count from the dossier; total slice ≤8 KiB. Tests: relations/hypotheses
   present; cap/omission counters; no claim/case evidence leaks into the worker context.
6. **Report resolves assets (W2).** Pass a bounded `assetBrief(ids)` from the extension into the report projection; the
   report prints `kind key label (asset-id@rN, stale?)` for every finding asset and coverage cell, and adds an "Asset
   inventory" section (top N with kinds/keys/labels and counts, omission line). No facts dump (size). Tests: identity
   resolved, stale marked, unavailable id marked, secret/redaction, report size bound, manifest hash changes.
7. **Round brief delta (E2).** `round-brief.ts`/`situation.ts` add a short graph-delta section (new/changed assets,
   assets without claims, accepted findings by asset top N, open hypotheses) sourced from the store, within the existing
   brief caps. Tests: section present when data exists; omitted when empty; cap enforcement.

**Acceptance R1.** A single `view` answers the asset question; `query`/`summary` are bounded and useful; a worker can
record a hypothesis and an owner can review it; the report no longer prints unresolved ids; declaration budgets still
pass (any description text must fit; the reporter's 14-character headroom means no new `p2o_report` declaration text).

**Verified 2026-10-28 (working tree).** `tsc --noEmit` clean; focused suites green (`graph`, `graph-dossier` 4,
`claim-asset-stamp` 4, `debt` 12, `phase-i` 9, `workspace-runtime` 41, `report-assets` 6, the report suites,
`round-brief` 8, `round-session` 12, `context-budget`, `recon`, `truth` 8, `acceptance-matrix`); full `vitest run`
**140 passed / 5 skipped files (145), 1,237 passed / 13 skipped tests (1,250), 0 fail** (R0 baseline: 142 files /
1,228 tests); `npm run build` +
`npm run check:build` → `build import OK`; `git diff --check -- src extensions tests docs planning_update.md` clean;
declaration and prompt-ceiling tests green (measured planner 49,297/49,300, worker 42,172/44,100, validation
41,364/43,300, reporter 6,786/6,800, model 75,503/77,900 — the planner has **3 characters** of headroom after the
`p2o_graph` description was compressed to fit `query`/`summary`, so no further model-facing text may grow without a
trade); GitNexus `impact` on the report renderer reports risk **CRITICAL** with the comparable shared axes LOW — a hub
read path reached by 48 processes — and the R1 change there is an optional section behind a context field covered by both
renderings in the report suites; `detect_changes` was reviewed before reporting with the stale-index caveat in §5.1. No
live run and no target traffic: every R1 test is hermetic.

**Delivered (working tree, 2026-10-28).**

- **R1.1 asset dossier** — `src/graph-dossier.ts` (new) defines the bounded projection (facts, hypothesis counts/rows,
  relations, claims with `stale`/`demonstrated`, cases, coverage cells including an explicit `noCell`, tasks, `gaps`,
  omission counters, redacted text lines, deterministic order, default limits 10/5/20/10/10/10/10); the extension composes
  it in `graphViewFor` from `store.assetView` plus the ledger projections the rest of the loop already reads and trims
  lists until the encoded response is ≤24 KiB (`GRAPH_RESPONSE_BYTES`), counting what it omitted. The store stays
  graph-only, so the dossier is a derived read and never a second source of truth.
- **R1.2 claim asset stamping (D-R1-1)** — the host derives a claim's pinned assets from the executing task's
  `work.assetRefs` (`claimAssetRefsFromWork` in `src/evidence.ts`), stamps them on the candidate `data.assetRefs` (≤10,
  revision kept) and refuses or drops anything the model supplied: `p2o_candidate` has no asset field, the owner tool
  refuses a smuggled `assetRefs`, and `candidate()` deletes it from the stored input. `src/claims.ts` gained
  `claimAssetRefs(claim)` and `proof`/`taskRef` on `ClaimFields` for consumers; legacy claims stay asset-less.
- **R1.3 query and summary (D-R1-12)** — `store.graphQuery(filters, {cursor, limit})` is SQL over current heads with
  parameterised `kind`, `keyPrefix` (kind-required), `labelContains`, `attributeKey`+`attributeValue`, `assertionKind` and
  `statementContains`, a sequence cursor, true totals, `omitted`/`truncated`/`nextCursor`, and a 1..50 row window
  (default 20); `boundedQueryPage` trims the encoded response to the existing 24 KiB `GRAPH_RESPONSE_BYTES` bound.
  `store.graphChanges(since, limit)` returns new/changed assets and the open-hypothesis frontier; the extension's
  `graphSummaryFor` composes counts (assets, new/changed, without claim/cell, open hypotheses, inferred relations,
  accepted findings, chain ready/unchained) plus ≤10 rows per list and enforces an explicit **8 KiB**
  `GRAPH_SUMMARY_BYTES` bound by dropping machine rows tail-first and stating `omittedRows` while the counts stay true.
  Both verbs are owner and worker reads, and the tool description names them inside the unchanged declaration budget.
- **R1.4 worker hypotheses and inferred relations (D-R1-3)** — the broker gate now accepts an **open** hypothesis and a
  relation with `basis=inferred`, and refuses any other hypothesis status (the owner settles by superseding) and any
  `basis=observed` relation (planner/owner work). The store stamps `producerRole` on both and `unverified:true` on a
  non-owner row; `store.unreviewedGraph()` returns the current worker rows and `src/debt.ts` adds one gateable debt kind
  `GRAPH_UNREVIEWED` (≤20 named hypotheses plus one aggregated inferred-relation item), so an unreviewed worker row is
  visible research debt the owner can discharge by superseding it — never a claim, case or finding. `docs/KNOWLEDGE.md`
  states the worker write role.
- **R1.5 worker slice** — `src/graph-slice.ts` carries ≤20 immediate relations (filtered to the selected assets), ≤5 open
  hypotheses and one "accepted findings on these assets: N (reviewed cases, not evidence)" line inside its 8 KiB cap; the
  extension supplies them from the graph snapshot and the case views.
- **R1.6 report resolves assets (W2)** — the extension computes `store.assetBrief(ids)` for the ids an accepted case or a
  coverage cell cites plus `store.assetInventory(20)` (both new store reads) and passes them as optional context. The
  report prints `kind key "label" (asset-id@rN[, stale; current rM])`, says `(unresolved in the current graph scope)` for
  an id the scope cannot resolve, resolves the coverage table's asset column the same way, and adds a bounded
  `## Asset inventory` section (current-scope total, newest ≤20 rows, omission line, explicit "not a test, not a finding")
  before the coverage section. With no resolution map the renderer keeps the old raw-id output byte for byte, so
  historical and draft exports are unchanged and the existing report tests do not move.
- **R1.7 round-brief delta (E2)** — the existing `delta` section gains the graph's movement since the previous round opened
  (the owner run now records the store sequence at each round opening): new/changed counts, assets with no claim, ≤3 new
  asset kind/key rows with a `(+N)` total, accepted findings on the busiest ≤3 assets, and ≤2 open hypotheses, all inside
  the section's 640-byte cap. A run without a graph delta prints nothing about it instead of claiming zero movement, and
  the D46 section list and omission order are unchanged.
- **Tests.** New `tests/minimal/claim-asset-stamp.test.ts` (4), `graph-dossier.test.ts` (4) and `report-assets.test.ts`
  (6); additions to `graph.test.ts` (query/cursor/limits, changes delta), `debt.test.ts` (`GRAPH_UNREVIEWED`),
  `phase-i.test.ts` (slice), `workspace-runtime.test.ts` (worker hypothesis/inferred relation, owner and worker
  query+summary, dossier in `view`, dense-summary 8 KiB bound), `round-brief.test.ts` (present/absent/cap) and
  `round-session.test.ts` (round 2 carries the graph delta). The acceptance matrix gained an R1 evidence section; §5.3
  records the actual files.
- **Deviations, recorded.** (1) The query row window is 1..50 (default 20) rather than a hard 20, with the 24 KiB
  response bound as the real ceiling; the summary has its own 8 KiB bound. (2) Review debt is a new **gateable** debt kind
  (`GRAPH_UNREVIEWED`), so an unreviewed worker hypothesis adds a `RESEARCH_DEBT` obligation the owner settles by
  superseding it; the plan named the debt but not its kind. (3) The round delta rides the existing `delta` section instead
  of adding a new section, so the D46 list and omission order are untouched. (4) Report asset resolution is contextual
  (absent map = old rendering), which preserves R0's report bytes and historical exports. (5) The `p2o_graph` declaration
  description was compressed to fit the two verbs and the new root filters; the declaration ceilings were not raised.



### R2 — Recon ingestion, inventory, exploitability (M/L, two to three passes)

**Goal.** Stop paying the model to hand-author the graph: recognized scanner/source artifacts populate assets/facts/
components deterministically, and component versions join CVE/EPSS/KEV.

1. **Extraction framework.** `src/extract/` pure, deterministic parsers with a registry:
   `parse(artifactId, bytes, contentType) -> {assets, facts, components, hypotheses, warnings, omitted}`. Bounds: input
   ≤4 MiB per artifact, ≤200 assets / ≤1,000 facts / ≤200 components per ingest, 7 KiB per row; no network, no shell, no
   eval; malformed input returns a warning, never throws into the model call.
2. **Parsers (first set).**
   - nmap XML: host/IP, ports, service names/product/version, OS hints; facts with receipt/artifact evidence.
   - httpx JSON/JSONL: URL, status, title, tech, TLS/headers; dedupe per host; cap.
   - nuclei JSONL: `matched-at`, template id, severity, classification (CVE/CWE); **recorded as an open hypothesis with
     the receipt/artifact as evidence, never as a claim/case**. This is the evidence-ladder boundary.
   - HTTP response: security-relevant headers, forms/links (≤50), JS API path regexes (≤50), cookies by **name**;
     endpoint/route assets with extractor-normalized keys (D-R1-2) and raw values in attributes/anchors.
   - OpenAPI/Swagger JSON: routes/methods, parameters, auth schemes; bounded.
   - Package manifests: `package-lock.json`, `pnpm-lock.yaml`, `requirements.txt` (best effort), `go.mod`, `Cargo.lock`,
     `Gemfile.lock`, `pom.xml`; package assets with `name/version/ecosystem` attributes.
3. **Ingestion path (D-R1-5).** Automatic extraction on a recognized capture/artifact, plus
   `p2o_graph action=ingest {artifactId}` for manual retry. Rows are written by a host `extractor` producer (new role in
   the producer whitelist, depth 0), carry evidenceRefs/artifactId, and are `unverified:true`. No claims, no cases.
   Dedupe uses the graph's content-hash rule; identical re-ingest only adds an observation. Re-ingest after a new
   artifact revision creates new assertions, not duplicates. Tests: capture→rows, dedupe, provenance role, capacity guard,
   omit counters.
4. **Component inventory.** `package` assets validate `name`, `version`, `ecosystem`, optional `cpe`; a
   `components` query mode returns component → asset → version; `summary` reports components without a CVE query. Tests:
   invalid version/ecosystem refused; duplicate package/version merges; inventory query.
5. **CVE/exploitability join (D-R1-6).**
   - Derive the NVD query from a component (product/vendor/version); create a lead with `assetRefs` + version and
     dedupe on `(cve, version, source.sha256)`; record `taskId` on `tasked` so the lead has a work link; version-range
     match against the recorded version is a labelled **suggestion**, never proof.
   - Add KEV + EPSS enrichment: public JSON/API, cached per run with `retrievedAt`/sha256, offline fallback = `unknown`
     (never fabricated). Expose on the component/lead and in the report.
   - `p2o_research action=cve` accepts an optional `componentRef` (asset id) and fills the query from the inventory;
     manual fields still work.
   - Tests: mocked NVD/KEV/EPSS responses, dedupe, offline fallback, suggestion label, no network in tests.
6. **Exploitability surfacing.** Report findings gain `exploitability {kev, epss, source, retrievedAt}` when a CVE is
   known; the board/report sorts/annotates by KEV then EPSS but never changes severity. Tests: KEV/EPSS shown, missing =
   unknown, severity untouched.
7. **Backlog.** `summary` reports per-asset "discovered but unplanned" and "components unqueried"; the planner can use it
   to author work. No automatic task creation. Tests: counts match fixtures.

**Acceptance R2.** A captured nmap/httpx/nuclei/lockfile artifact produces graph rows without model authoring; a component
gets a CVE lead with KEV/EPSS; the report shows inventory and exploitability; all bounds and no-network tests pass; the
evidence ladder is unchanged (nuclei → hypothesis, CVE → lead).

### R3 — Attack paths, red-team technique map, retest, interop (L, two to three passes)

**Goal.** Answer the question a red team actually asks — "from this entry point, what can I reach, through which edges,
and what is the missing capability?" — and make findings survive across a retest and integrate with trackers.

1. **Traversable-edge semantics (D-R1-11).** `src/path-view.ts` (new) holds the one constant:
   traversable / informational / conditional per relation kind, with a comment per kind. Expose the classification on
   read rows (`traversable: true|false`) without schema change. Tests: each of the 16 kinds classified once; unknown kind
   rejected by the existing validator; classification stable.
2. **Path query.** `p2o_graph action=path {fromId, toId?, toKind?, effect?, maxDepth≤6, maxNodes≤500, kinds?}`:
   recursive CTE over active, non-stale relations; deterministic ordering; returns ≤10 shortest paths, ≤6 hops each, with
   asset briefs, relation kind/basis, evidence refs, stale/withdrawn flags, and a `truncated`/`noPath`/`cycle` marker.
   If `effect` (a capability such as `data.read`, `db.query`, `host.shell`) is given, annotate which hop supplies it from
   demonstrated claims/cases and which is missing (the "missing hop"). Response ≤24 KiB; no unbounded traversal.
   Tests: linear chain, cycle, stale edge excluded/flagged, withdrawn edge, depth cap, node cap, effect satisfied by a
   demonstrated claim, missing capability reported, deterministic order.
3. **Chain/path integration.** `chain` accepts `assetRefs` (already validated) and annotates each ready step with the
   asset it starts from; `path` reuses `chainJoin` for capability labels. Tests: ready step linked to asset; unmet need
   shown as missing hop; no claim re-evaluation.
4. **ATT&CK crosswalk (D-R1-7).** New `src/attack-map.ts` + `docs/ATTACK_MAP.md`: curated 40–60 techniques for
   infra/AD/cloud, a WSTG→ATT&CK crosswalk, pinned version and source URL. Cases' finding gains `techniques` (≤5,
   validated against the map) and the report/cases.csv show the IDs; no tool-declaration growth (field is internal to
   `p2o_case_author`? if it must be model-writable, it costs schema text — prefer deriving from `policyKey`/`wstg` and
   exposing the mapping in the report first, then decide). Tests: unknown technique refused; mapping covers the shipped
   WSTG keys; report renders IDs.
5. **Retest lifecycle.** New owner/planner case action `retest` with verdict
   `still_reproducible|fixed|cannot_confirm`, `caseRef` + pinned revision, evidenceRefs (required except
   `cannot_confirm`), one write per case revision, only accepted-current case; report shows retest status and the retest
   evidence. Cross-run retest links resolve through the project DB (D-R1-8) but the verdict's evidence must be same-run.
   Tests: transitions, second write refused, stale case refused, evidence requirement, report rendering.
6. **Stable finding fingerprint.** `findingId = sha256(scope, policyKey, rootCauseKey, sorted asset kind/key)[:32]`,
   derived and printed in `findings.json`/SARIF; used for cross-run dedupe suggestions. Tests: same finding across
   revisions yields the same id; different asset/root cause differs; no secret in the hash input (asset keys are
   non-secret by the graph rule).
7. **SARIF 2.1.0 export (D-R1-9).** `p2o_finish`/export adds `findings.sarif`: rules keyed by `policyKey`, locations from
   anchors (url/path/header), properties CVSS/CWE/WSTG/ATT&CK/findingId, fingerprints stable. Validate structurally in
   tests (required keys, version, results non-empty, deterministic order); add to manifest hashes. No new dependency.
8. **STIX 2.1 (D-R1-9, chosen).** Findings as `vulnerability` SDO + `relationship` to asset `identity` and ATT&CK
   `attack-pattern`; deterministic ordering and manifest hash; opt-in export flag, never the default report bundle.
9. **Project-level knowledge DB with auto-merge (D-R1-8).** A project-scoped SQLite store (one per workspace/project,
   not per run) keyed by tenant + target identity, containing asset kind/key identity, finding fingerprints/status and
   retest links. Writes are host-only, append-only with provenance (runId, retrievedAt, source scope); imported rows
   surface as `suggested` context in the planner and in the report as prior knowledge, never as graph facts and never as
   same-run evidence for a claim or cell. Merge rules: exact identity + scope match; conflicts keep both and are surfaced
   for review; a changed target scope marks rows stale rather than deleting. Concurrency: single-writer actor + WAL, the
   same pattern as the run store. Tests: round-trip, tenant/scope isolation, import cannot satisfy a claim/cell, conflict
   surfaced, retest links by findingId, stale scope.

**Acceptance R3.** A path query from an entry asset to an effect returns a bounded, evidence-annotated path with the
missing hop; traversable-edge semantics are in code and tested; cases/report carry ATT&CK IDs; a retest verdict is
recorded and rendered; SARIF validates structurally; cross-run context cannot become same-run evidence.

### R4 — Measurement (L, gated)

**Goal.** Make capability claims checkable.

1. **Offline fixture benchmark** (`bench/graph/`, `npm run check:bench-graph`): deterministic dataset of receipts/
   artifacts (nmap/httpx/nuclei/openapi/lockfile) with expected extraction, dossier, query, path and report assertions;
   runs in CI with no network and no provider tokens; measures parser precision/recall, dedupe, path correctness,
   report resolution. This is the regression gate for R1–R3.
2. **Live benchmark (D-R1-10).** Owner-approved live target `https://hcmussh.edu.vn/` with a hard **USD 2** budget cap,
   plus optional labeled lab targets; run only after the owner confirms authorization for the host and only from the
   sandbox with the normal scope declaration; metrics: candidate claim precision/recall, accepted-case precision,
   coverage, chain completion, tokens/cost. Results recorded in `docs/BENCH_RESULTS.md` (not committed without owner
   consent) and used to rank future work. If authorization is not confirmed, the live run is skipped and the offline
   bench remains the gate.
3. **Baseline after R2, final after R3.** Record the offline bench and (if authorized) one live baseline; never present a
   mechanical completion as effectiveness.

**Acceptance R4.** Offline bench is green in CI and deterministic; live bench exists but is off by default and requires
an explicit flag + cap; results are reproducible from the recorded manifest.

---

## 5. Verification

### 5.1 Gates (must pass at the end of every phase)

| Gate | Baseline today (`bbdfec1`) | Requirement |
| --- | --- | --- |
| `./node_modules/.bin/tsc --noEmit` | clean | clean |
| Focused suites for the phase | — | green, with new tests listed in §5.3 |
| `./node_modules/.bin/vitest run` (full) | 136 files passed / 5 skipped (141), 1,203 tests passed / 13 skipped | green, no unexplained skips; count grows with the phase |
| `npm run build` + `npm run check:build` | `build import OK` | OK |
| Declaration budgets (`tests/minimal/context-budget.test.ts`) | planner 48,245/49,300; worker 41,120/44,100; validation 40,312/43,300; reporter 6,786/6,800; model 74,451/77,900 | inside every ceiling; the reporter has 14 chars of headroom, so no `p2o_report` declaration growth without a trade or an owner-approved ceiling change |
| `git diff --check -- src extensions tests docs` | clean | clean |
| GitNexus | index one commit behind HEAD (sandbox EROFS on `~/.gitnexus/registry.json`); `detect_changes` usable | run `impact` before editing a symbol and `detect_changes` before any commit; report `partial`/`truncated`/UNKNOWN honestly; note index staleness |
| Python gates | 159 run: 157 pass, 1 skipped, 1 pre-existing hash failure for gitignored `my_references/strix` | unchanged; do not "fix" the pre-existing failure |
| Owner files | `AGENTS.md` dirty, `pi-p2o-defense-vi.pptx` untracked | never staged, never touched |

**R0 result (working tree, 2026-10-28).** `tsc --noEmit` clean; full `vitest run` **137 passed / 5 skipped files (142),
1,215 passed / 13 skipped tests (1,228), 0 fail**; `npm run build` + `npm run check:build` → `build import OK`;
`git diff --check -- src extensions tests docs planning_update.md` clean; declaration and prompt-ceiling tests
(`context-budget`, `recon`) green inside that full run. GitNexus: `impact` ran before the symbol edits that needed it
(`graphExport` LOW, `assetEntityIds` LOW/exact, `fetchPage` **CRITICAL** — 2 direct callers / 7 impacted / 5 processes,
`refs` **HIGH** — 4 direct, all bounded additions reviewed); `assetCount` returned UNKNOWN (0 resolved callers) and a
text search confirmed the one production caller in the round-progress read. `detect_changes --scope all`: 87 changed
symbols / 18 files / 40 processes, risk **critical**, and it includes the owner's `AGENTS.md` edit plus the plan's own
stale P18 section mapping; the index is 2 commits behind HEAD (GitNexus reindex blocked by the sandbox EROFS on
`~/.gitnexus/registry.json`), so reach is reported as a signal, not as behavioural proof. Python gates were not needed by
R0 and were not rerun; the owner's `AGENTS.md` edit and untracked `pi-p2o-defense-vi.pptx` remain untouched and unstaged.

**R1 result (working tree, 2026-10-28).** `tsc --noEmit` clean; full `vitest run` **140 passed / 5 skipped files
(145), 1,237 passed / 13 skipped tests (1,250), 0 fail**; `npm run build` + `npm run check:build` → `build import OK`;
`git diff --check -- src extensions tests docs planning_update.md` clean; `context-budget` and `recon` prompt ceilings
green. GitNexus: `impact` on `renderReport` reports risk **CRITICAL** (shared axes LOW; 1 direct caller, 48 processes
reached) — the edit behind it is an optional report section, and both the resolved and unresolved renderings are pinned;
the index is 3 commits behind HEAD (GitNexus reindex blocked by the sandbox EROFS on `~/.gitnexus/registry.json`), so
reach is a signal, not behavioural proof. `detect_changes --scope all` was reviewed before reporting: 294 changed symbols
/ 23 files / 377 affected / risk critical, and like R0 it also sees the owner's `AGENTS.md` edit and this plan's own
stale section mappings. No live run, no
target traffic, no paid model call: every R1 test is hermetic (extension + real SQLite store + Unix broker + inert
sandbox). The owner's `AGENTS.md` edit and untracked `pi-p2o-defense-vi.pptx` remain untouched and unstaged.

### 5.2 Invariants that must not change

- A scanner output, extracted fact, CVE lead, dossier row or hypothesis is **not** evidence for a claim/case; only a
  receipt + demonstrated claim can satisfy the ladder.
- A project-DB row is `suggested` context only; it can never satisfy a same-run claim or coverage cell.
- Role authority changes only by D-R1-3; no other tool gains target or review power.
- The graph stays bounded: every new read has a byte/row cap and every new write is within the existing batch/row
  limits; capacity overflow is reported, never silently dropped.
- A graph read (dossier, summary, query result, round-brief delta, report inventory) is background, never evidence: no
  read can satisfy a claim, case or coverage cell, and a worker hypothesis or inferred relation stays `unverified` until
  the owner supersedes it.
- No new settings by default; caps are constants (P9 decision).
- No network in tests; no paid provider calls in CI; no attribution lines in commits (AGENTS.md).

### 5.3 New test files (planned)

| Phase | Files |
| --- | --- |
| R0 | `tests/minimal/research-fetch-containment.test.ts` (new, 7 tests), plus focused additions to `graph.test.ts` (cross-page relation, refs cap, foreign-scope identities, asset-head counter), `graph-record-shape.test.ts` (schema `maxItems: 10`), `truth.test.ts` (bounded fetch description), `research.test.ts` (cap marker under the mocked bounded fetcher) |
| R1 | `tests/minimal/claim-asset-stamp.test.ts` (new, 4), `graph-dossier.test.ts` (new, 4), `report-assets.test.ts` (new, 6); additions to `graph.test.ts` (query filters/cursor/limits, `graphChanges` delta), `debt.test.ts` (`GRAPH_UNREVIEWED`), `phase-i.test.ts` (slice relations/hypotheses/findings count), `workspace-runtime.test.ts` (worker hypothesis + inferred relation, owner/worker `query`+`summary`, dossier in `view`, dense-summary 8 KiB bound), `round-brief.test.ts` (graph delta present/absent/cap), `round-session.test.ts` (round 2 carries the delta). The planned `graph-query`/`graph-summary`/`worker-hypothesis`/`report-asset-resolution` files were folded into the existing suites so each area keeps one fixture |
| R2 | `tests/minimal/extract-nmap.test.ts`, `extract-http.test.ts`, `extract-openapi.test.ts`, `extract-packages.test.ts`, `ingest-dedupe.test.ts`, `component-inventory.test.ts`, `cve-enrich.test.ts`, fixtures under `tests/minimal/fixtures/extract/` |
| R3 | `tests/minimal/graph-path.test.ts`, `path-semantics.test.ts`, `attack-map.test.ts`, `case-retest.test.ts`, `finding-fingerprint.test.ts`, `report-sarif.test.ts`, `report-stix.test.ts`, `project-knowledge-db.test.ts` |
| R4 | `bench/graph/*` + `tests/minimal/bench-graph.test.ts` |

### 5.4 Verification honesty

The A1/A1.2 passes proved mechanism, not offensive effectiveness. This milestone must keep that distinction: the offline
bench proves parser/path/report correctness; only an authorized live run can speak to detection quality, and its result
is labelled as such. No claim in this plan depends on a benchmark that has not run.

---

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Scope creep: A+B+C is large | phase gates; each phase shippable; R0+R1 is a valid stopping point; C is split into C1–C4 |
| Extractor becomes an attack surface (target-controlled bytes) | pure parsers, strict bounds, no eval/shell/network, fuzz-style malformed fixtures, artifact bytes only |
| Graph pollution from auto-ingest | producer role + `unverified:true` + evidence refs; no claims/cases; dedupe by content hash; capacity guard; review debt |
| Worker rows become backlog rather than review (R1.4) | an open worker hypothesis and an inferred relation are stamped `unverified` with their producer role, an observed relation or a settled status is still refused, and every unreviewed row becomes a gateable `GRAPH_UNREVIEWED` debt the owner settles by superseding it |
| The new graph reads make an export or a brief too large | each read has its own byte cap (24 KiB graph response, 8 KiB summary, 8 KiB worker slice, 640-byte delta section) and the report's resolution context is optional, so a missing map keeps the old bytes; the declaration-budget test gates the model-facing text |
| Path query blow-up | hard depth/node/response caps, deterministic order, explicit truncation, no query without an anchor |
| Taxonomy maintenance (ATT&CK/WSTG) | curated subset, pinned version, one map file, tests pin coverage of shipped WSTG keys |
| Cross-run contamination | project DB is tenant/scope-keyed, append-only, `suggested`-only import; cannot satisfy claims/cells; owner review for retest links |
| Research-fetch change breaks Part XI expectations | keep "any http(s)" for public sources; only deny loopback/link-local/metadata and add caps; document in the tool description; D-R1-4 |
| Residual DNS rebinding on the citation fetch | R0 checks every hop's addresses but does not pin the IP global fetch finally connects to; the target path is unaffected (sandbox), and a later phase can pin the address or move the citation fetch into the sandbox. Accepted R0 deviation, recorded in the R0 block and the tool description |
| Declaration budget exhaustion (reporter 14 chars) | internal fields only where possible; any new model-facing field requires a trade; budget test is the gate |
| Stale GitNexus index | run `impact`/`detect_changes` anyway, report staleness, never treat UNKNOWN as low risk |
| Owner-file/attribution violation | explicit checklist in §5.1; no commit/push without owner request |

---

## 7. Files map (expected)

New: `src/graph-dossier.ts`, `src/extract/{index,nmap,http,openapi,packages,nuclei}.ts`, `src/attack-map.ts`,
`src/path-view.ts`, `src/finding-fingerprint.ts`, `src/project-knowledge-db.ts`, `docs/ATTACK_MAP.md`, `bench/graph/*`;
R0 already added `src/research-fetch.ts`.
R1 delivered: new `src/graph-dossier.ts` and the three test files above; touched `src/state/store.ts`
(`graphQuery`/`graphChanges`/`assetBrief`/`assetInventory`/`unreviewedGraph`, `producerRole`/`unverified` stamps),
`src/state/graph-tool.ts` (query/summary verbs and root filters), `src/state/graph.ts` (`GRAPH_SUMMARY_BYTES`),
`src/claims.ts`, `src/evidence.ts` (claim asset stamp), `src/debt.ts` (`GRAPH_UNREVIEWED`), `src/graph-slice.ts`,
`src/report.ts`, `src/report-export.ts` (asset resolution, inventory), `src/round-brief.ts` (graph delta),
`extensions/p2o/index.ts` (handlers, worker gate, report context, round-delta read), `docs/KNOWLEDGE.md`,
`docs/ACCEPTANCE_MATRIX.md`, `docs/HISTORY.md`.

Touched: `src/state/store.ts` (query/summary/path/dossier reads, scope filter, relation accounting), `src/state/graph.ts`
(refs cap, relation classification exposure, identity retention note), `src/state/graph-tool.ts` (actions/params),
`src/graph-slice.ts`, `src/round-brief.ts`, `src/situation.ts`, `src/evidence.ts` (claim asset stamp), `src/case-types.ts`
/`src/cases.ts` (techniques, retest, fingerprint), `src/report-export.ts`/`src/report.ts` (asset resolution, inventory,
exploitability, SARIF, ATT&CK), `src/cve.ts` (+`src/cve-enrich.ts` new), `extensions/p2o/index.ts` (handlers, worker
hypothesis gate, ingest, fetch), `src/prompts.ts` (containment wording), `src/tool-schemas.ts` (only if a model-facing
field is unavoidable), `src/tool-policy.ts` (stale note), `docs/KNOWLEDGE.md`, `docs/EVIDENCE.md`, `docs/ARCHITECTURE.md`,
`planning_update.md`.

Not touched: owner files, `src/truth.ts` semantics, role loadouts beyond D-R1-3, sandbox/containment settings.

---

## 8. Sequence and owner gates

| Gate | Deliverable | Owner decision needed |
| --- | --- | --- |
| G0 | This plan approved (or amended) | D-R1-1…D-R1-12 |
| G1 | R0 implemented + verified (delivered 2026-10-28 in the working tree, awaiting owner review) | none if the plan is approved; research-fetch wording reviewed |
| G2 | R1 implemented + verified | D-R1-3 (hypothesis write) exercised in the delivered UX |
| G3 | R2 implemented + verified | D-R1-6 sources and D-R1-5 ingestion behaviour reviewed |
| G4 | R3 implemented + verified | D-R1-7 map reviewed; D-R1-8 project DB reviewed; SARIF + STIX verification |
| G5 | R4 offline bench green; live run optional | explicit authorization + budget cap for any live run |

Sequencing for the quick-win slice if the owner wants to stop early: **G1 + G2**, then reassess. The full program is
expected to touch the graph, extraction, CVE, reporting and test surfaces for several passes; each phase starts only
after the previous phase's verification and the owner's review.

---

## 9. Recovery and provenance

- Plan of record for A1/A1.2 (replaced by this file): `git show bbdfec1:planning_update.md`; P18 text:
  `git show 18d1d84:planning_update.md`.
- A1 commit: `00092d4` ("Cut tool-call refusals and repeated prompt facts (A1)"); A1.2 commit: `bbdfec1` ("Audit the whole
  tool surface and default conservative omissions (A1.2)"). Nothing pushed.
- The planning pass wrote this plan only. The **R0 pass** (2026-10-28) then changed, in the working tree and without a
  commit: `src/research-fetch.ts` (new), `extensions/p2o/index.ts` (`fetchPage` delegates, research result fields),
  `src/state/store.ts` (export relation predicate/countScope, `assetEntityIds` scope, `assetCount` heads, assertion
  retention note), `src/state/graph.ts` + `graph-tool.ts` (`refs` cap), `src/cve.ts`, `src/prompts.ts`,
  `src/tool-schemas.ts`, `src/tool-policy.ts`, `docs/KNOWLEDGE.md`, `docs/HISTORY.md`, `docs/ACCEPTANCE_MATRIX.md`,
  `planning_update.md`, and the R0 tests listed in §5.3. No schema migration, no authority change, no settings added;
  no commit, push or attribution is made or implied (AGENTS.md).
- **R0 was committed** on 2026-10-28 as `1d79ec9` ("Bound the host research fetch and fix graph export accounting
  (R0)"): 19 files, the owner's `AGENTS.md` edit and the untracked `pi-p2o-defense-vi.pptx` excluded, no attribution line.
  Nothing was pushed.
- The **R1 pass** (2026-10-28) then changed, in the working tree and **without a commit**: `src/graph-dossier.ts` (new),
  `src/state/store.ts`, `src/state/graph-tool.ts`, `src/state/graph.ts`, `src/claims.ts`, `src/evidence.ts`, `src/debt.ts`,
  `src/graph-slice.ts`, `src/report.ts`, `src/report-export.ts`, `src/round-brief.ts`, `extensions/p2o/index.ts`,
  `docs/KNOWLEDGE.md`, `docs/ACCEPTANCE_MATRIX.md`, `docs/HISTORY.md`, and the R1 tests in §5.3. No schema migration (store
  schema stays 7), no authority change, no new settings; the only model-facing text added is the two `p2o_graph` verbs and
  their root filters, inside the unchanged declaration budgets. Nothing pushed; no live run and no target traffic.
- R0 verification is the §5.1 result block: tsc clean, full suite 1,215 passed / 13 skipped (1,228), build/`check:build`
  green, `git diff --check` clean, GitNexus impact/detect_changes reviewed with the stale-index caveat. The live benchmark
  was **not** run and no target traffic was generated: R0 only mocks the bounded fetcher and uses inert stores.
- Evidence for the analysis: local code reads (paths/lines above), `planning_update.md` at `bbdfec1` §1.2–1.6, the
  read-only audit of 2026-10-28, and the reference snapshots in `my_references/ARTEX` and `my_references/strix`; external
  URLs are cited in §2.2. Where a claim is a judgement (e.g. "ATT&CK subset is enough"), it is labelled as a decision, not
  a measurement.
- Owner decisions A+B+C, plan approval and the six policy answers (D-R1-3/4/5/8/9/10) were made in chat on 2026-10-28 and
  are recorded at the top of this file. The live target and USD 2 cap come from the owner; authorization for that host
  is still required before any live run.
