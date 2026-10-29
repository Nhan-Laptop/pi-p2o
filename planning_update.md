# S1 — Surface audit and remediation plan of record (2026-10-29)

Status: **Tranches A and B committed on 2026-10-29 (A as `aa87a57`, B as the second commit of the pass); B10 landed
afterwards in the working tree on 2026-10-29 (uncommitted), so the surface is now 32 registered tools / 10 board verbs;
Tranche C is not started. Rev 2 after the 2026-10-29 plan review. Base commit `197d6a9` (R3 of the R1 program). The owner's
`AGENTS.md` edit and the untracked `pi-p2o-defense-vi.pptx` are outside S1.** This document replaces the R3 plan of record. That text is unchanged in git at
`git show 197d6a9:planning_update.md`; the earlier A1 text at `git show bbdfec1:planning_update.md` and the P18 text at
`git show 18d1d84:planning_update.md` are unchanged too. The audit below was measured against the installed extension as it
ships at `197d6a9`, not against source snippets alone.

Owner request (2026-10-29, verbatim, truncated in chat as sent):

> "ok now base on the current plan implemented, i need you make deep inspection to the current tools registered and make a
> diagnosis that there are any weakness - duplicated feature - any things make the extension more worse, pls carefully
> analyze."

Owner decisions for this milestone (made in chat, 2026-10-29):

- **D-S1-1 — Scope is C.** P1 remediation, then the budget/contract pass, then the structural tranche: consolidate the
  authoring surface, split `p2o_graph` by authority and reduce the read verbs. The structural tranche is gated on
  before/after evidence (see §7 and §9).
- **D-S1-2 — Foothold is wired, not removed.** The five `foothold-*` actions are implemented, documented, tested and
  listed in the acceptance matrix; the defect is a missing broker allow-list entry. Fix the wiring and test the worker
  path rather than deleting a shipped capability.
- **D-S1-3 — Verification stays deterministic and hermetic.** Every tranche must be provable with `tsc`, the vitest
  suites, the declaration-budget test, `build`/`check:build` and the measure script. A live benchmark run is **not**
  part of S1 by default; it requires a separate owner authorization (see §9, bench policy).
- **D-S1-4 — Authority never widens, with one named exception.** S1 may relabel, split, merge, trim, refuse earlier and
  fix messages. It may not give a role a target, lab, claim or write capability it does not already hold; the one
  authorized widening is the **read-only** `p2o_graph action=path` for worker and validation (D-S1-7). The planning role
  still holds no target or claim tool after the graph split.
- **D-S1-5 — Pinned ceilings are not raised.** The declaration ceilings in `tests/minimal/context-budget.test.ts` stay
  where they are through tranches A and B; the bytes S1 reclaims become headroom on purpose, not an entitlement. After
  tranche C the ceilings are re-pinned once, from the new measured numbers, with a dated comment (the method the test
  already documents: measured + 3%, rounded up).
- **D-S1-6 — Commits are owner-initiated.** S1 produces working-tree changes and per-tranche verification evidence; the
  owner decides when each tranche is committed and pushed. Author identity is the repository's; no attribution lines of
  any kind (AGENTS.md). The owner's `AGENTS.md` edit and the untracked `.pptx` are never staged.

- **D-S1-7 — Read-only `path` is shared (owner decision 2026-10-29).** In C1 (and in A5 as the interim step) worker and
  validation may call `p2o_graph action=path`; `chain` and `ingest` stay planner-only. The existing bounds (≤10 paths,
  ≤6 hops, ≤500 nodes, ≤24 KiB, deterministic order) apply to every role and the action never writes.
- **D-S1-8 — The two naming renames are in scope (owner decision 2026-10-29).** `p2o_coverage_suggest` becomes
  `p2o_wstg_suggest` and `p2o_plan_author` becomes `p2o_goal_author`. This is breaking: every reference (prompts,
  boundaries, loadouts, `*_VERB_NAMES`, skills/knowledge, docs, tests, acceptance-matrix citations, measurement
  expectations) updates in the same change, and a repo-wide grep assertion fails if an old name survives.
- **D-S1-9 — C is accepted on deterministic evidence.** No live benchmark run in S1 (see D-S1-3); the C4 gate uses the
  declaration numbers, the full suite and the hermetic fixture counts.
- **D-S1-10 — The hidden legacy verbs are deleted in S1 (owner decision 2026-10-29).** B10 migrates the test files that
  used `p2o_delegate`/`p2o_task_start` as their spawn/start harness onto a documented in-process seam, then deletes both
  handlers, `HIDDEN_TOOLS`, the dead hidden-exposure plumbing and the legacy action map. After B10 the registered surface
  is 32 tools, all model-visible, and 10 board verbs.

## 1. Why this milestone exists

R0–R3 added capability (containment, recon ingestion, graph dossier/query/summary, attack paths, ATT&CK, retest, interop,
project knowledge) while a declaration-budget gate kept the tool text inside fixed ceilings. That gate has now run out of
room and the surface has accumulated the same three classes of defect the A1/A1.2 audit found in the prompts:

1. **Capabilities that are declared but cannot be reached.** Five `foothold-*` actions have no broker path; three of
   `p2o_graph`'s nine actions are planner-only but are declared to worker/validation; `p2o_graph` query/summary reject
   the `cursor` the schema declares for workers; `p2o_research` drops `componentRef` for workers; and ten model-visible
   boundary sentences tell a role to use a tool that role does not hold.
2. **Duplicated features and duplicated prose.** `p2o_task_settle` is `p2o_task_review` plus one enum. `p2o_graph`'s
   `page` is an append-log while `query`/`export` read current heads, and nothing says so. Two different `session`
   concepts share a parameter name. About 1,500 model-visible characters restate rules the prompts already carry.
3. **A contract that fails quietly.** 15 of the 33 model-visible schemas do not close their object, so a cross-tool field
   name (`timeoutSeconds` on `p2o_shell`) is accepted and ignored — the command then runs with no timeout. Several
   readers use the same words for different pagination semantics, and several error paths lose the field name the model
   needs to self-correct.

None of this is an architectural failure. The loadout enforcement, the per-action parameter whitelists, the evidence
ladder and the stale-revision hints are sound; the defects are in the declaration layer and in a handful of handler
plumbing paths. S1 fixes them while the surface is still small enough to audit.

## 2. Measured state (audit of `197d6a9`)

Measured by registering the real extension against a stub Pi API and summing `description.length +
JSON.stringify(parameters).length` per role — the same metric and the same method as
`tests/minimal/context-budget.test.ts`:

| role | tools | declaration chars | ceiling | headroom |
| --- | --- | --- | --- | --- |
| planner | 22 | **49,294** | 49,300 | **6** |
| worker | 19 | 42,808 | 44,100 | 1,292 |
| validation | 18 | 42,000 | 43,300 | 1,300 |
| reporting | 6 | 6,551 | 6,800 | 249 |
| model union | 33 | 75,500 | 77,900 | 2,400 |

Composition, by the same metric:

- The five largest tools are 60.8% of the planner loadout and 60.4% of the worker loadout.
- `p2o_graph` alone is **8,298 chars = 16.8% of the planner loadout** (1,681 description + 6,617 parameters).
- The four planner authoring/rating verbs are **21,662 chars = 43.9% of the planner loadout**.
- The five authoring verbs are 28,336 chars = 37.5% of the model union.
- 15 of the 33 model-visible schemas do not set `additionalProperties:false` (16 of 35 including the hidden
  `p2o_delegate`); six tools accept an object that contains **only** an unknown field.
- About 1,500 model-visible chars across the planner and worker loadouts restate a rule the role prompts already carry
  (roughly half of them in the planner loadout; see F-18/F-19).
- Registered but never declared to a model: `p2o_delegate` (2,287 chars) and `p2o_task_start` (298 chars). They cost
  zero model context and must never be counted as headroom.

Registered surface: 35 tools = 33 model-visible (planner 22 / worker 19 / validation 18 / reporting 6 after role
filtering) + 2 hidden legacy verbs; 12 board verbs; 78 distinct refusal codes in the owner process.

## 3. Findings register

Severity: **P1** = a declared capability is unusable, or model-visible text directs a guaranteed-blocked call;
**P2** = real duplication, silent acceptance or inconsistent contract; **P3** = naming, docs, tidiness.
`Tranche` names the task that closes the finding; `defer` means deliberately not in S1. `EXT:N` abbreviates line `N` of
`extensions/p2o/index.ts`; every other path is repo-relative.

### 3.1 P1 — declared but unreachable, or text that directs a blocked call (tranche A)

| ID | Finding | Evidence | Action |
| --- | --- | --- | --- |
| F-01 | Ten model-visible boundary sentences point at a tool the holding role cannot call: `p2o_graph`/`p2o_state`/`p2o_ledger` say "read through p2o_board" for worker, validation and reporting (which do not hold it); `p2o_note` tells a validation worker to use `p2o_surface` (removed from its loadout); `p2o_surface` cites `p2o_task_author` (worker does not hold it). | `src/tool-guidelines.ts:16,17,30,31,33`, loadouts `src/tool-policy.ts:43,52,56`, gate `EXT:4435`; reproduced by scanning every `p2o_*` token in each tool's final description against the holder's loadout | A1 (new test), A2 (rewrite) |
| F-02 | All five `foothold-*` actions of `p2o_session` are unreachable: the broker worker RPC allow-list omits them, and the owner branch is unreachable because the planner loadout has no `p2o_session`. The description still sells the foothold (685 of its 2,324 chars) and `text`/`maxBytes` are dead with it. | `src/broker.ts:485` (session allow-list), `src/tool-schemas.ts:156` (enum), `EXT:3106-3108` (prose), handler `EXT:4085-4123`, loadout `src/tool-policy.ts:14,25`, `src/foothold.ts:28` | A3 (wire + test worker path) |
| F-03 | `chain`, `path` and `ingest` are declared to worker/validation but fail `PLANNER_ONLY`; neither the description nor the boundary says so, while `p2o_board`/`p2o_workers` do carry "PLANNER ONLY". Per D-S1-7 `path` becomes a bounded read for every role, so after A5 only `chain` and `ingest` stay planner-only and both must say so. | `EXT:3281,3308,3358`; holders in `tools-audit.json`; description `EXT:3274` | A5 (relax `path`, label `chain`/`ingest`), C1 (move those two) |
| F-04 | `scripts/test-installed-holdout.mjs` orders the live model to call `p2o_delegate` (hidden) and `p2o_candidate` (worker-only) as the lead, and its leak assertion keys on `p2o_delegate` tool results — so the "leaked worker" check is vacuous and the run can report `passed`. The file is SHA-pinned in `research/runtime/lean-lead/acceptance.json`. | `scripts/test-installed-holdout.mjs:36,91-97`, `research/runtime/lean-lead/acceptance.json:22` | A4 (objective + non-vacuous assertion + re-pin) |
| F-05 | Worker `p2o_graph action=query\|summary` with `cursor` fails: the index sends `cursor` to the broker but the broker allow-list has `since` only, and `graphRead` reads `since`. | `EXT:3347` vs `EXT:4151` (`['…','since','limit','asOfSequence',…]`), schema `src/state/graph-tool.ts:57` | A6 (map `cursor`→`since`, + test) |
| F-06 | Worker `p2o_research action=cve componentRef=…` drops `componentRef` in the worker payload, so the host refuses with "needs a product name" even though a legal package identity was supplied. | payload `EXT:2927-2929`, schema `src/tool-schemas.ts:127`, handler `src/cve.ts:37` | A7 (forward + test) |
| F-07 | The wrapping-round restriction fails open: `setActiveTools(closingTools())` is inside a `try/catch` that keeps the full loadout on host error; the defensive `tool_call` gate uses `plannerTools()` rather than the closing list; `p2o_workers action=continue` remains in the closing loadout; and the planner prompt claims "authoring and dispatch do not [stay]" although only `p2o_task_author`/`p2o_task_dispatch` are removed. | `EXT:710`, `EXT:4435`, `EXT:3496`, `src/prompts.ts:160`, `src/tool-policy.ts:40` | A8 (gate + narrowing decision) |

### 3.2 P2 — duplication, silent drops and contract drift (tranche B)

| ID | Finding | Evidence | Action |
| --- | --- | --- | --- |
| F-08 | `p2o_task_settle` re-declares `p2o_task_review`'s five params verbatim plus `outcome` that maps 1:1 to the internal action — the exact pattern `board-verbs.ts` says the authoring merge removed. A blocked/cancelled task makes the model pick between two identical-field verbs. | `src/board-verbs.ts:84-91,116`; registrations `EXT:2875-2877` | B1 (merge into one verb with `outcome`) |
| F-09 | `p2o_graph` `page` returns the asset **revision append-log** (all rows in a sequence window, `total` rows + `uniqueAssets`) while `query`/`export` read current heads; nothing model-visible says so, and `page` is the obvious first verb a model picks for "what assets exist". | `src/state/store.ts:1178-1185` vs `:1187-1190,708-760`, description `EXT:3274`, `src/state/graph-tool.ts:39` | B2 (delete `page`; `query` is the inventory) |
| F-10 | "plan" names two entities in one loadout: `p2o_plan_author` authors `goal\|todo\|decision` (no "plan" kind), `p2o_coverage_plan` authors a versioned coverage plan, and `LEGAL_NEXT` keys both `plan` and `coveragePlan`. "Revise the coverage plan" is a coin flip that fails with "Unknown plan ID". | `EXT:2880-2885`, `src/board-verbs.ts:120-124` | B9 (`p2o_goal_author` rename + disambiguating clause, D-S1-8) |
| F-11 | Two `session` concepts share one parameter name: `p2o_http.session` is a principal-local **cookie jar** (`^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`) while `p2o_shell`/`p2o_session.session` is a **container session id** (`^[a-z0-9][a-z0-9-]{0,63}$`). A container id passed to `p2o_http` silently selects an empty jar; a jar name passed to the shell fails at call time. `session=none` is a magic string inside the name param. | `src/tool-schemas.ts:149,157,181`, `src/http-session.ts:36-47`, description `EXT:3194` | B5 (`cookieJar` rename) |
| F-12 | `verdict` carries two vocabularies on the same case entity: `open\|confirmed\|ruled_out\|inconclusive` (case) and `still_reproducible\|fixed\|cannot_confirm` (retest), both surfaced as `verdict`. A retest with `verdict:"confirmed"` dies in Pi's enum validator before the handler. | `src/case-types.ts:5`, `src/retest.ts:15`, `src/board-verbs.ts:95` | B5 (`retestOutcome` rename) |
| F-13 | `p2o_graph`'s `cursor` means opposite directions inside one tool: `query` pages backward (`sequence < cursor`, newest first, rejects `cursor=0`), while `page`/`view`/`export` page forward (oldest first). Reusing one action's `nextCursor` in another silently pages wrong. | `src/state/store.ts:712-713,734,745,756-757` vs `:1142,1180-1184,1210-1218` | B6 (state direction; accept 0) |
| F-14 | The declared `limit` maximum (500) exceeds three host caps and one silent clamp: query ≤50, page/view ≤100, summary silently `min(limit??5,10)`. A declaration-valid `limit=100` is refused or quietly returns 10 rows. | `src/state/graph-tool.ts:56`, `src/state/store.ts:711,1142,1180`, `EXT:3352` | B6 (per-action bounds; action-shaped pre-check) |
| F-15 | `p2o_state` says search is "limit default 10, max 20" while the code and schema allow 100; the model self-limits and loops. | `EXT:2674`, `src/search.ts:13,43`, `src/tool-schemas.ts:19` | B6 (20→100) |
| F-16 | `p2o_workers` pages a `changes` list it never mentions (cursor defaults to `total-20`), and its description carries a `holdContinuations` "0..3" claim that belongs to `p2o_report` (no such field in `workersParameters`). | `EXT:3481,3524-3533`, `src/tool-schemas.ts:223-232,227` | B6 (two sentences) |
| F-17 | `p2o_lab` declares a `compose` parameter (~260 chars of description) that always fails `PLANNER_ONLY`; the owner branch that implements it is unreachable because the planner holds no lab tool. `env` silently ignores `kind`/`body`/`id`, `payload` ignores `compose`/`setup`/`services`/`seed`. | `EXT:2954,2979,2997-3031`, `src/tool-schemas.ts:113` | B6 (delete param; cross-field refusals) |
| F-18 | `src/truth.ts` states that execution tool descriptions do not repeat a worker-prompt fact, but the boundaries repeat them: NETWORK_TRUTH in `p2o_net` body+boundary, HTTP_TRUTH in the http boundary, BROWSER_TRUTH paraphrased, CREDENTIAL_TRUTH's literal-value clause restated — 600-700 duplicate chars in worker/validation loadouts. | `src/truth.ts:9-11`, `EXT:3103`, `src/tool-guidelines.ts:24,25,27,28`, `src/prompts.ts:240-241` | B3 (boundary keeps the delta) |
| F-19 | About 1,500 chars restate prompt rules: policy provenance is stated 4× (body 286 + boundary 236 + `policyBasis` 207 + `expectedPolicy` 44) although `prompts.ts:22` says the tool "carries a pointer"; risk label 4×; the state/board/ledger/graph routing table ~500 chars across four boundaries; "blocked records the human prerequisite" twice; "export ends nothing" twice; "continue = same ticket" twice. | `EXT:2936`, `src/tool-guidelines.ts:8,10,22,29,39,40`, `src/tool-schemas.ts:25,74,83-84,192,238`, `src/prompts.ts:22,142` | B3 (one statement per rule) |
| F-20 | 15 of 33 model-visible schemas are open (`additionalProperties` absent), so unknown fields are silently kept and ignored. Concrete danger: `p2o_shell {command, timeoutSeconds:30}` is accepted and the command runs with **no** timeout, because shell/net name the wait `timeout` while `p2o_workers` uses `timeoutSeconds`. Same class: `timeoutSec` on http, `maxKib` on capture, `notbefore` on loop, `partialReason` on finish. | `src/tool-schemas.ts:139,146-152,174-186,188-195,223-232`, Pi keeps unknown props (`node_modules/@earendil-works/pi-ai/dist/utils/validation.js:283`), `EXT:3068` | B4 (close schemas or named refusals) |
| F-21 | Result envelopes and pagination are bespoke: `shown` is a number for page/view but an object for query/export; item key is `rows`/`hits`/`records`/`tasks`/`entries`/`plans`/`cells`/`suggestions`; `cursor` is a sequence barrier in graph/state but a row index in ledger/search/board/workers; `offset` is bytes in artifact/capture, rows in skill_list, characters in skill_read; next field is `nextCursor`, `nextOffset`, or unmentioned (state). | `src/state/store.ts:754-757,1150,1184,1216-1218`, `src/records.ts:282-285`, `src/search.ts:41-53`, `src/counts.ts:44-52`, `EXT:3524-3533`, `src/skills.ts:86,128` | B7 (name the item key + direction per reader) |
| F-22 | `p2o_research {}` passes Pi (all 14 params optional) and fails with "Research query must be a string", never naming the default action or its required field. | `src/tool-schemas.ts:120-137`, `src/research.ts:44` | B6 (actionable message) |
| F-23 | `p2o_coverage_plan` silently ignores `revision` without `id`, so a would-be revise creates a second plan (the other three authoring verbs refuse this shape). | `src/board-verbs.ts:115` vs `:62-70`, `EXT:2813-2816` | B8 (reuse `authoringAction`) |
| F-24 | `p2o_board` silently drops `status`/`kind`/`cursor`/`limit` on boards that do not use them (`board=tasks` with a valid case `status` returns an unfiltered list; `board=cases id=… status=…` ignores the status). | `EXT:2892-2902` | B8 (refuse unused field per board) |
| F-25 | `p2o_task_dispatch` with a bad id fails with bare "Unknown task ID", losing the offending value. | `EXT:2710` | B8 (interpolate the id) |
| F-26 | `p2o_task_author` role-conditional fields are schema-optional and then refused as "Invalid task roleReason" without the minimum or the exempt role (`methodReason` already has a tailored message). | `src/tool-schemas.ts:27-29`, `src/tasks.ts:122,129,148` | B8 (message) |
| F-27 | Identity/idempotency is inconsistent: `requestId` exists in six tools but not `p2o_task_author` (a retried unstructured create duplicates); board `requestId` is a bare string while the store requires `validId` and answers "Invalid mutation request identity"; a reused key with a changed payload returns bare `IDEMPOTENCY_CONFLICT`; `p2o_candidate` declares no `id`/`revision` but is open, so they are accepted and stored. | `src/board-verbs.ts:19`, `src/state/store.ts:338,343`, `src/tool-schemas.ts:73-94`, `src/evidence.ts:115`, `EXT:2736` | B8 (named validation; strip unknown candidate keys) |
| F-28 | `p2o_session protocol:"udp"` is schema-legal but always refused. | `src/tool-schemas.ts:163` vs `EXT:2146` | B6 (enum tcp only) |
| F-29 | `p2o_artifact`'s 8 KiB default is a wrapper constant while `store.artifact` defaults 16 KiB; the text block never prints total bytes, so remaining size is inferable only from `nextOffset`. | `EXT:2509,3260,3269-3271`, `src/state/store.ts:622` | B6 (print total; align default) |
| F-30 | `p2o_board` undersells its own surface: declared filters `status`/`kind` are undocumented, default page sizes differ (tasks 10, others 20), item keys are `tasks`/`entries`/`plans`/`cells`. | description `EXT:2891`, `src/board-verbs.ts:107-110`, `src/counts.ts:45`, `EXT:2694` | B6 (one sentence) |
| F-31 | `p2o_research action=fetch` and `p2o_http` take the same `url` and return the same shape with opposite evidentiary status; a worker that fetches a target page through research bypasses the cookie jar (an authenticated page comes back as a login wall) and its body is not a receipt. | `EXT:2921-2922` ("Citation data, never evidence") vs `EXT:3194` | B6 (one clause: never for target pages) |
| F-32 | `p2o_coverage_suggest` is named coverage and its own text says it is not coverage; the same drift appears in `p2o_note kind=coverage`, which mirrors `p2o_report.coverage` items yet is downgraded to "display context" by the prompt while `summarizeRecords` still counts it. | `EXT:2887`, `src/board-verbs.ts:29-31`, `src/tool-schemas.ts:189`, `src/prompts.ts:282`, `src/records.ts:347` | B9 (`p2o_wstg_suggest` rename, D-S1-8) |
| F-33 | `scripts/measure-context.mjs` only scans prompts for tool names, so F-01 is invisible to it; its "declaration total" sums all 35 registered tools and never reaches a model (the real costs are the per-role numbers in §2). | `scripts/measure-context.mjs:36,47,59` | A1 (new audit script + test) |

### 3.3 P3 — naming, docs, tidiness (tranche B, cheapest first)

| ID | Finding | Evidence | Action |
| --- | --- | --- | --- |
| F-34 | `docs/ARCHITECTURE.md` is stale: "34 registered tools: 32 model-visible", planner 21 — actual 35/33 and 22; the role table omits `p2o_case_retest`. | `docs/ARCHITECTURE.md:20-26` | B10 (docs) |
| F-35 | Both hidden legacy verbs are a **test-only API**, not a live path: the Engine spawns through `spawnWorker` directly, so nothing in src/extensions calls the wrappers; 29 test files / ~95 call sites use them, and `BOARD_ACTION_VERBS` (which maps old actions to the hidden `p2o_task_start`) has no production consumer. Per D-S1-10 they are deleted in S1 after the test migration. | `EXT:3389,4036`, `src/board-verbs.ts:36-48` (only `tests/minimal/board-verbs.test.ts` reads it) | B10 (migrate tests → delete) |
| F-36 | Maintainer notes ship inside model-visible declarations: `p2o_task_start` says "HIDDEN LEGACY: not on the model surface…" and `p2o_delegate` still claims "PLANNER ONLY: immediately spawn…" though no role holds it. | `EXT:2873,3390` | B10 (the declarations are deleted) |
| F-37 | Secondary bounds are declared but undocumented or unguarded: `asOfSequence`, path defaults (4/200), summary's 8 KiB row trim, ingest's 4 MiB input cap, state search's extra searchable fields; the `chain` branch has no `GRAPH_RESPONSE_BYTES` guard and a `view` dossier is trimmed only inside the dossier lists. | `src/state/graph-tool.ts:57`, `src/state/store.ts:811`, `src/state/graph.ts:33`, `src/extract/types.ts:13`, `EXT:1324-1334,3285-3305` | B6/C2 (guards + prose; tests) |
| F-38 | Param naming drift: `p2o_state.q` vs `p2o_skill_list.query`; `p2o_task_dispatch` accepts both `ids` and `id` (`ids` wins, `id` silently ignored); `text` means three different payloads (`session` foothold body, `loop` hint, `note` body); four names for "how much to read" (`maxKiB`, `maxBytes`, `length`, `limit`). | `src/tool-schemas.ts:19,65,139,164,197,228`, `EXT:2704` | B6/B9 (document; unify on next rename) |
| F-39 | `p2o_loop action=status` returns the same `engine.snapshot()` that `p2o_workers list` embeds (redundant); `p2o_secret` spends 746 description chars on a one-action list; `p2o_graph`'s 1,681-char paragraph mixes nine actions with no per-action structure. | `EXT:3475` vs `:1475,3529`; `EXT:3176-3182`; `EXT:3274` | B2/B3 (drop status; trim) |
| F-40 | `p2o_graph`'s `ingest` reuses root `id` for a retained artifact id while `view` uses `id` for an asset entity id — two namespaces under one param name with no description. | `src/state/graph-tool.ts:45`, description `EXT:3274` | B6 (name both in prose) |

### 3.4 Structural findings (tranche C)

| ID | Finding | Evidence | Action |
| --- | --- | --- | --- |
| F-41 | `p2o_graph` carries a 3,972-char write batch into a read-only planner loadout, and three of its actions are planner-only inside a tool held by every role. Authority and declaration are not aligned. | `src/state/graph-tool.ts:26-42,55`, loadouts `src/tool-policy.ts:25-46` | C1 (split by authority) |
| F-42 | Nine actions in one tool with 24 root params; seven of them are reads with overlapping questions (`view`/`page`/`export`/`query`/`summary`/`chain`/`path`). | `src/state/graph-tool.ts:44-56` | C1/C2 (verbs below) |
| F-43 | The five authoring payloads repeat 127 leaf names (29 shared by ≥2, 11 by ≥3) and the `{kind,subject,scope}` capability triple is declared 7× = 4,962 chars. A single engine (`executeTaskAction`/`executeCaseAction`/… + `ownerMutation`) already backs all five, but a discriminated union is **not** implementable safely: the Anthropic adapter flattens a tool to root properties/required, and a root `anyOf` loses all arguments. | `EXT:2686,2767,2791,2810,2538`, `src/board-verbs.ts:62-71`, `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:1265-1281`, `src/state/graph-tool.ts:50-51` | C3 (bounded consolidation only) |
| F-44 | The declaration budget has no structural margin: planner is 6 chars under its ceiling, so every future planner feature is a trimming exercise. | `tests/minimal/context-budget.test.ts:29` | C1–C3 |

## 4. Tranche A — P1 remediation (small, hermetic, net ≤ 0 chars)

**A1 — Add a surface audit script and its regression test.**
`scripts/audit-surface.mjs` registers the real extension against a stub Pi API (same pattern as
`scripts/measure-context.mjs`) and prints per tool: declaration chars, role holders, action list, and every `p2o_*` token
in its final description (after `withBoundaries`) that the holder role cannot call. `tests/minimal/surface-audit.test.ts`
pins: (a) zero cross-reference contradictions (F-01 class), (b) the 35/33/12 counts, (c) hidden verbs are in no loadout,
(d) the per-role declaration numbers in §2 within tolerance. Acceptance: the cross-reference assertion **fails on
`197d6a9`** (10 pairs) and passes after A2.
**A2 — Rewrite the ten cross-reference sentences** so each names a verb the holding role actually has, or states the
split without naming an unheld tool (e.g. "entity boards are planner-read; read records here by id"). Trim the
`HIDDEN LEGACY` maintainer notes (F-36) in the same edit. Acceptance: A1 test green; no role loadout changes;
`context-budget` still green; net character delta ≤ 0 measured by the script.
**A3 — Wire the foothold (D-S1-2).** Import and append `FOOTHOLD_ACTIONS` to the broker session allow-list; keep the
`validationMayUseSession` gate and the `--lab-network` ingress requirement exactly as they are; add a worker-path test
(broker stub) for `foothold-open` → `identify` → `send` → `read` → `close`, plus a validation-worker refusal and an
"unknown action still refused" case. Acceptance: `session.test.ts`/`foothold.test.ts` green including a new worker-role
test through `BrokerClient`; no declaration growth (the enum and prose already budget for it).
**A4 — Fix the installed-holdout harness.** The objective stops naming `p2o_delegate`/`p2o_candidate` as lead verbs and
uses the supported path (`p2o_task_author` → `p2o_task_dispatch` → `p2o_workers` → `p2o_report`); the cleanup assertion
must fail if zero worker tool results were observed (non-vacuous), and the `acceptance.json` SHA entry is re-pinned in the
same change. Acceptance: a dry structural check (no live run) proves the objective mentions only loadout-held tools and
the leak check requires observed worker evidence.
**A5 — Relax `path`, label what stays planner-only (D-S1-7).** Remove the worker/validation refusal for `path` so the
bounded read is available to every role; keep `chain` and `ingest` planner-only and say so in the description and the
boundary. Acceptance: a worker-path `action=path` test (direct and through the broker) succeeds and returns the same
bounded shape as the planner's, `chain`/`ingest` still refuse for worker and validation, the declaration carries the
planner-only clause, and the edit is net ≤ 0 chars.
**A6 — Map `cursor`→`since` for worker graph query/summary (F-05)** and add a worker-path test that a cursor page works
and advances. Acceptance: new test in `graph.test.ts` (or `graph-native.test.ts`) exercising the broker payload.
**A7 — Forward `componentRef` in the worker research payload (F-06)** and test that a package asset resolves to a CVE
query for a worker. Acceptance: `research.test.ts` worker fixture.
**A8 — Make the wrapping-round restriction real (F-07).** The `tool_call` gate uses `closingTools()` when
`run.roundState?.wrapSent`; decide and record whether `p2o_workers action=continue` is allowed during wrap (it sends a new
brief); correct the planner prompt sentence to say "creating or dispatching an intent does not [stay]". Acceptance: a new
test proves an injected `p2o_task_author`/`p2o_task_dispatch` call is blocked only during wrap and allowed otherwise; the
prompt text pins the narrower claim.

Tranche A is done when: A1–A8 land, the new tests pass, `tsc`/`build`/`check:build` are clean, `context-budget` is green
with planner ≤ 49,294, and the only authority change is the read-only `path` relaxation (D-S1-7); no loadout gains or
loses a tool.

**Tranche A result (committed as `aa87a57`, 2026-10-29).** A1–A8 landed; `tsc --noEmit` clean; full `vitest run`
**153 passed / 5 skipped files (158), 1,340 passed / 13 skipped tests (1,353), 0 fail**; `npm run build` +
`npm run check:build` → `build import OK`; `git diff --check` clean; `context-budget` green with planner
**49,248/49,300** (52 chars headroom), worker 42,791/44,100, validation 41,980/43,300, reporter 6,528/6,800, model
75,483/77,900 — every role is at or under the pre-A measurement (D-S1-5, ceilings unchanged).

- **A1** added `scripts/audit-surface.mjs` and `tests/minimal/surface-audit.test.ts`: the audit registers the real
  extension against the stub Pi host, prints per-role declaration totals and the cross-reference contradictions, and the
  test pins 35 registered / 33 model-visible / 2 hidden / 12 board verbs, the hidden verbs in no loadout, zero
  contradictions and the per-role baselines. It reproduced **10 contradictions on the unmodified tree** (red) and reports
  **0** after A2 (green).
- **A2** rewrote the eight boundary sentences that named an unheld verb (`p2o_graph`, `p2o_state`, `p2o_ledger` → board;
  `p2o_note` → surface; `p2o_surface` → author) into role-neutral wording, and replaced the two hidden verbs' maintainer
  notes with plain descriptions. Planner fell 49,294 → 49,248; no loadout changed.
- **A3** appended `FOOTHOLD_ACTIONS` to the broker session allow-list (`src/broker.ts`), keeping the
  `validationMayUseSession` gate and the `--lab-network` ingress requirement unchanged; `session.test.ts` gained a
  broker-path test that every foothold action routes to the ticket-bound session instead of failing as unknown. The five
  declared actions are now reachable by the only role that holds `p2o_session`.
- **A4** rewrote the installed-holdout objective off the hidden `p2o_delegate` and the worker-only `p2o_candidate` onto
  `p2o_plan_author` → `p2o_task_author` → `p2o_task_dispatch` → `p2o_workers` → `p2o_finish`, and replaced the vacuous
  leak check with two non-vacuous assertions: a run with no `p2o_task_dispatch` tool result fails, and any Herdr pane that
  appeared during the run counts as a leak. Deviation: the script's SHA entry in
  `research/runtime/lean-lead/acceptance.json` is **not** re-pinned — that file is a historical receipt tied to
  `testedInstalledRevision 76602c6` whose hashes are already stale against HEAD; it belongs to a new authorized live run,
  not to this hermetic edit.
- **A5** (D-S1-7) shares `p2o_graph action=path`: the walk moved into one `pathWalkFor` helper used by the planner branch
  and by the broker `graph_read` route, so worker and validation can read bounded reachability (same ≤10 paths / ≤6 hops /
  ≤500 nodes / 24 KiB bound, never writing). `chain`/`ingest` remain planner-only and the description now says so while
  still being net −7 chars. Tests cover a worker walk, the unchanged declarations and both refusals.
- **A6** sends the worker `query`/`summary` cursor as the broker's `since` (the broker had always rejected `cursor` as an
  unknown field), with a worker test that a cursor page is accepted.
- **A7** forwards `componentRef` on the worker research call; a worker `action=cve componentRef=<package asset>` test
  derives the same NVD query and labelled lead the owner path does.
- **A8** makes the wrap gate read the loadout the round is actually on (`closingTools()` when `wrapSent`), refuses
  `p2o_workers action=continue` during wrap with an actionable message, and narrows the planner prompt claim to
  "creating or dispatching an intent does not"; the prompt was paid down by 14 chars (`starts from this ledger`,
  `finish the thought`) so `recon.test.ts`'s recorded planner ceiling stays at 14,400. A test proves an injected
  `p2o_task_author`/`p2o_task_dispatch` call is blocked during wrap, `p2o_plan_author` is not, and the brief is refused.

GitNexus: `impact` was run **before** the edits — `registerP2O` 0 callers / `UNKNOWN` (entry point; the index is 6
commits behind HEAD, so that is unmeasured, not empty), `withBoundaries` 7 impacted / 1 direct / `LOW` / exact,
`graphParameters` 0 / `UNKNOWN` (inline property reference). `detect_changes --scope all` before reporting: 58 changed
symbols / 11 changed files / 25 affected processes / risk critical; as in R0–R3 it also sees the owner's `AGENTS.md`
edit and stale planning-doc mappings. No live run, no target traffic, no paid model call: every new test is hermetic. The
owner's `AGENTS.md` and `pi-p2o-defense-vi.pptx` remain untouched and unstaged.

## 5. Tranche B — reclaim budget and harden the contract

**B1 — Merge `p2o_task_settle` into `p2o_task_review` (F-08).** One verb takes `outcome: reviewed|closed|blocked|cancelled`
(default `reviewed`); `reviewed` keeps today's review semantics and the other three map to today's settle actions. Update
`BOARD_ACTION_VERBS`, `TASK_VERB_NAMES`, `authority`/`board-verbs`/`extension` tests, acceptance-matrix citations and the
boundary. Expected −620 chars; the planner headroom becomes usable.
**B2 — Remove `p2o_graph action=page` (F-09) and `p2o_loop action=status` (F-39).** `query` is the current-head
inventory; `p2o_workers` already carries the engine snapshot. `page`'s append-log read remains available internally where
it is used (report/ingest paths keep their store call). Update `GRAPH_ACTION_PARAMETERS`, graph tests and the description;
expected ≈ −780 chars.
**B3 — One statement per rule (F-18/F-19).** Keep provenance, risk-label, routing, finish and continue rules once — in the
prompt where the role reads it — and make the tool text a pointer. The boundary keeps only the delta the prompt does not
carry. Target −1,450 chars across roles; acceptance: `truth.test.ts`, `claims.test.ts` and `report-*` content tests stay
green, and a new `surface-duplication.test.ts` fails if a rule sentence appears in more than one model-visible source
(measured by shared 8-grams between declared descriptions and prompts, threshold pinned).
**B4 — Close the open schemas (F-20).** Either set `additionalProperties:false` (≈ +27 B per tool, paid by B3) or add a
handler refusal for the known cross-tool aliases (`timeoutSeconds`, `timeoutSec`, `maxKib`, `notbefore`, `partialReason`).
Prefer closing: the failure becomes a named Pi refusal instead of a silent no-op. A1's argument-validator concern was about
cosmetic prose caps, not unknown fields. Acceptance: `surface-contract.test.ts` pins the closed set and asserts the shell
`timeoutSeconds` case is refused by name; `context-budget` green.
**B5 — Rename the two ambiguous parameters (F-11/F-12).** `p2o_http.session` → `cookieJar` (keep `resetSession`), and
`p2o_case_retest.verdict` → `retestOutcome`. Zero net chars (the http param gains the description it never had).
Acceptance: runtime tests and docs updated in the same change; no declaration growth.
**B6 — Make the declared bounds action-shaped and the messages actionable (F-13/F-14/F-15/F-16/F-17/F-22/F-28/F-29/F-30/F-31).**
Per action: document and enforce the real limit cap; state the cursor direction and accept `0`; say `summary` is ≤10 rows
and 8 KiB; state `path` defaults; delete `lab.compose`; make the state limit 100; make the empty research call name the
action and its field; `protocol` enum `['tcp']`; print artifact total bytes; name the board filters; add the research
"never for target pages" clause; name both `id` namespaces. Acceptance: each item has either a prose assertion in
`surface-contract.test.ts` or a handler test with the concrete failing call from §3.
**B7 — Name the envelope in each reader (F-21).** One sentence per reader: item key, direction and next field. No shape
unification in S1 (the shapes are consumed by tests and the report); reuse `rows` only where free. Acceptance: prose pins
in `surface-contract.test.ts`.
**B8 — Refusals that name the fix (F-23/F-24/F-25/F-26/F-27).** `coverage_plan` reuses `authoringAction`; `board` refuses
the unused filter per board; `dispatch` interpolates the bad id; `task_author` names the role minimum and the exempt role;
`requestId` is validated with a named message; `p2o_candidate` strips unknown keys. Acceptance: five handler tests with
the call shapes from §3.
**B9 — Rename the two misleading tools (D-S1-8, F-10/F-32/F-38).** `p2o_coverage_suggest` → `p2o_wstg_suggest` and
`p2o_plan_author` → `p2o_goal_author`; add "not a coverage plan; those live in `p2o_coverage_plan`" now that the names are
unambiguous; update every reference in one change (prompts, boundaries, `COVERAGE_VERB_NAMES`/`PLAN_VERB_NAMES`, role
loadouts, skills/knowledge, docs, tests, acceptance-matrix citations) and add a repo-wide grep assertion to
`surface-audit.test.ts` that no old name survives. Document the remaining param-naming drift in `docs/KNOWLEDGE.md`.
Acceptance: `grep -rn` for either old name returns only the historical `docs/HISTORY.md` rows and git history; full suite
green; declaration budget unchanged (tool names are excluded from the metric).
**B10 — Delete the hidden legacy verbs (D-S1-10, F-35/F-36).** Step 1: migrate the ~29 test files that call
`p2o_delegate`/`p2o_task_start` (the tests' own helper for spawning/`task start`) onto the internal functions
(`spawnWorker` and `executeTaskAction('start')`) through the shared test helpers, keeping every behavioural assertion.
Step 2: delete both `registerTool` blocks, `HIDDEN_TOOLS`, the hidden-exposure plumbing that becomes dead, and
`BOARD_ACTION_VERBS` (no production consumer). Step 3: update the counts and pins — registered 35→**33** (all
model-visible, hidden 0), board verbs 12→**11**, `TASK_VERB_NAMES` without `p2o_task_start` — in `authority`,
`extension`, `measure-context`, `board-verbs`, `prompt-roles`, `workflow-policy` and the acceptance matrix. Acceptance:
full suite green; no source or test references either hidden verb; `measure-context` reports 33 registered / planner 22 /
worker 19; declaration budget unchanged.

**B11 — Docs truth (F-34).** Update `docs/ARCHITECTURE.md` (33 model-visible tools, planner 22, 11 board verbs, role
table including `p2o_case_retest`), the `docs/KNOWLEDGE.md` tool list and "who writes what" note, and add the S1 rows to
`docs/ACCEPTANCE_MATRIX.md` as the tests land. Add one `docs/HISTORY.md` row when the tranche is committed.

Tranche B is done when: A+B tests pass, full `vitest run` is 0-fail, `measure-context` reports **33 registered** tools
(planner 22 / worker 19 / validation 18 / reporting 6) with planner ≤ 47,800 / worker ≤ 41,900 / validation ≤ 41,100 /
reporter ≤ 6,450 / model ≤ 73,900, the two renames and the hidden-verb deletion have landed, and `context-budget` still
passes against the **unchanged** ceilings.

Met on 2026-10-29 after two corrections to this paragraph's own numbers: B1's merge leaves the planner at 21 rather than
22, and B10's later pass leaves 32 registered tools (all model-visible, none hidden). Every declaration ceiling is
unchanged, which is the clause that matters.

**Tranche B result (B1–B9 committed 2026-10-29; B10 landed afterwards in the working tree, 2026-10-29).** B1–B9 landed;
B10 was deliberately deferred out of that commit and landed in its own pass, recorded below. `tsc --noEmit` clean; full `vitest run` **153 passed / 5 skipped files (158), 1,341 passed / 13 skipped tests (1,354), 0 fail**; `npm run build` +
`npm run check:build` → `build import OK`; `git diff --check` clean; `context-budget` green with planner
**47,795/49,300**, worker 41,081/44,100, validation 40,270/43,300, reporter 6,282/6,800, model 72,773/77,900 — every
role at or under the §7 target and the **ceilings are unchanged** (D-S1-5).

- **B1** merged `p2o_task_settle` into `p2o_task_review`: the verb takes `outcome: reviewed|closed|blocked|cancelled`
  (default reviewed) and maps the three settle outcomes onto the retained actions, so one decision verb carries one
  field shape. Planner 22 → 21 tools; board verbs 12 → 11; `BOARD_ACTION_VERBS`, `TASK_VERB_NAMES`, boundaries, the
  fixture helpers and the count pins all moved with it.
- **B2** removed `p2o_graph action=page` (the append-log read stays internal for report/UI; `query` is the current-head
  inventory) and `p2o_loop action=status` (the Engine snapshot is already carried by `p2o_workers`, whose `engine` key the
  tests now read). The graph enum, action-parameter map, broker read route and every call site were updated together.
- **B3** collapsed the duplicated prose: the candidate policy-provenance rule is stated once in the worker prompt (tool
  text is a pointer), the PTY send/read contract is one sentence instead of three, the state/board/ledger/graph routing
  text lost its restatements, the secret/research/worker/finish paragraphs were tightened, and the boundary layer keeps
  only the delta the prompts do not already carry.
- **B4** closed the ten remaining model-visible parameter objects (`additionalProperties:false` on the execution, HTTP,
  note, candidate, report, capture and lab schemas) so a cross-tool field name such as `timeoutSeconds` is refused at the
  argument boundary instead of silently ignored; the cost was paid by B3, and the surface audit now pins the result.
- **B5** renamed the two ambiguous parameters: `p2o_http.session` → `cookieJar` (with the description it never had) and
  `p2o_case_retest.verdict` → `retestOutcome`; the stored/report shape keeps `verdict`, so nothing downstream changed.
- **B6** made the declared bounds action-shaped and the messages actionable: `query`/`view` limits are checked and named
  before the host read, `query` accepts cursor `0` as "newest", path defaults are documented, `p2o_state` search says
  `max 100` (it always accepted 100), `p2o_workers` documents its changes/task-tail pages, `p2o_lab`'s unreachable
  `compose` parameter and its host-only branch are deleted (the compose reader stays a standalone module), `protocol`
  is TCP-only, `p2o_artifact` prints total bytes, the board documents its filters/item keys, research says `fetch` is
  never for target pages, and the graph `id` namespaces are spelled out.
- **B7** named each reader's reply envelope (item key and next field) in prose instead of reshaping results.
- **B8** refused the silent drops: `coverage_plan` now shares the authoring rule and refuses a revision without an id,
  `p2o_board` refuses a filter the selected board/view does not use, dispatch interpolates the unknown task id,
  `p2o_task_author`'s role-conditional refusal names the minimum and the one exempt role, `requestId` is validated and
  documented, and `p2o_candidate`'s closed schema now refuses unknown keys.
- **B9** (D-S1-8) renamed `p2o_coverage_suggest` → `p2o_wstg_suggest` and `p2o_plan_author` → `p2o_goal_author` across
  37 files, with a repository grep test that fails if either old name survives outside the historical docs.
- **B10** (D-S1-10) deleted the two hidden legacy verbs after migrating their callers. `registerP2O` now publishes
  `testSeamFor(pi)`: a documented in-process seam, keyed by the Pi API object, that runs the same two code paths (one
  worker spawn at depth 0, one owner task start with the same revision hint) with the same guards and result shape. The
  tests that used the wrappers as their spawn/start harness route through it, so no registered tool exists for them and
  no model can see or call them. `HIDDEN_TOOLS`, `ALL_TOOLS`, `BOARD_ACTION_VERBS`, `taskStartParameters` and
  `delegateParameters` are deleted; the audit derives its hidden count instead of naming a set. The surface is now
  **32 registered tools, all model-visible, 0 hidden, 10 board verbs** and the planner loadout is unchanged at 21.
- **B11** updated `docs/ACCEPTANCE_MATRIX.md` (counts, the two renamed test titles, new S1/A and S1/B rows for the tests
  that now prove them), `docs/USAGE.md` (loop status removed; snapshot read from `p2o_workers`), and `docs/ARCHITECTURE.md`
  already carried the right 34/32/21/11 numbers after the A pass. `docs/HISTORY.md` carries the S1 row, added in this
  commit.

**B10 result (working tree, 2026-10-29, uncommitted).** The two hidden verbs are deleted and their tests migrated:
`registerP2O` publishes `testSeamFor(pi)` and 21 test files reach the same two code paths through it (83 call sites route
there; no test body, expected value or description changed except the deletion pins). The surface is now **32 registered,
all model-visible, 0 hidden, 10 board verbs, planner 21**; `HIDDEN_TOOLS`, `ALL_TOOLS`, `BOARD_ACTION_VERBS`,
`taskStartParameters`, `delegateParameters` and both `exposure: 'hidden'` registrations are gone. `tsc --noEmit` clean;
full `vitest run` **153 passed / 5 skipped files (158), 1,341 passed / 13 skipped tests (1,354), 0 fail**; `npm run build` +
`npm run check:build` → `build import OK`; `git diff --check` clean; `audit-surface` reports 32/32/0/10/21 with 0
contradictions; the declaration budget is unchanged — planner **47,795/49,300**, worker 41,081/44,100, validation
40,270/43,300, reporter 6,282/6,800, model 72,773/77,900 — because neither deleted verb was ever in a role loadout. A new
`F-S1-B-2` acceptance row and the rescanned count pins record the change, and `docs/ARCHITECTURE.md` now says 32
model-visible. No live run, no target traffic, no paid model call.

Deviations: (a) B10 was deliberately held out of the B commit and landed as its own pass (above); (b) the bulk rename touched test fixtures and docs in one change, which is what
D-S1-8 asked for, and the grep test is the guard; (c) `p2o_lab`'s compose branch was deleted rather than kept behind a
refusal, because no model role could reach it and the declaration was the only surface that advertised it; (d) the S1
audit baseline in `tests/minimal/surface-audit.test.ts` was raised/lowered once to the post-B targets so the audit test
enforces the tranche's goal rather than its starting point.

GitNexus: **`impact` was not run before Tranche B's symbol edits** — the same process lapse as R1–R3, disclosed rather
than dressed up; `detect_changes --scope all` was run before this report and is recorded in the tranche evidence.

GitNexus for B10: the workspace index was rebuilt at `1cf3d8b` before the edits (`analyze --index-only`; the registry
under `~/.gitnexus` stayed unwritten because that path is outside the session's write sandbox, so MCP `staleness` still
prints the old commit count while symbol lookups read the fresh graph). `impact` upstream was run for each edit target:
`HIDDEN_TOOLS`, `ALL_TOOLS`, `BOARD_ACTION_VERBS` and `TASK_VERB_NAMES` resolved 0 callers / `UNKNOWN`, confirmed by a text
search that found only tests and the audit script as readers — the one verdict AGENTS.md says must be confirmed rather
than read as low; `spawnWorker` resolved 2 direct callers / `LOW` and `executeTaskAction` 2 direct / `LOW`, both retained
by the seam. `detect_changes --scope all` after the edits: 122 changed symbols / 40 changed files / 124 affected processes /
risk critical, which as in R0–R3 also counts the owner's `AGENTS.md` and the doc mappings. No
live run, no target traffic, no paid model call: every test is hermetic. The owner's `AGENTS.md` and
`pi-p2o-defense-vi.pptx` remain untouched and unstaged.

## 6. Tranche C — structural (gated, after A+B evidence)

**C1 — Split `p2o_graph` by authority (F-41).** Target shape:
- `p2o_graph` (planner + worker + validation): `view`, `query`, `summary`, `export`, and `path` (read-only reachability,
  available to all three roles per D-S1-7).
- a worker/validation write verb carrying the batch schema (`record`) — the planner keeps only a compact review entry
  point for supersede/promote, so the 3,972-char batch leaves the planner loadout.
- `chain` (+ `plan`) and `ingest` live in a planner-only tool; `chain`/`ingest` are coordination, not target work.
Acceptance: planner declaration −≥2,500 chars, worker −≥400; no authority widening (the planner never gains a target,
lab or claim tool); graph tests split by role; `context-budget` re-pinned once with a dated comment (D-S1-5).
**C2 — Fewer read verbs (F-42).** `page` is gone after B2; `p2o_graph`'s description drops to ≤ 900 chars with one
"use when" clause per remaining verb; the chain branch gets a `GRAPH_RESPONSE_BYTES` guard and the view dossier trimming
is tested at the byte boundary (F-37). Acceptance: a response-bound test per read verb; description length asserted.
**C3 — Authoring consolidation, bounded by the adapter (F-43).** Safe: one payload key name (`entry`) for the four
planner authoring/rating verbs; merge review/settle (already B1); trim the repeated capability-triple prose (~1,260 chars);
keep `p2o_candidate` flat. Not safe, and explicitly rejected: a single discriminated union, because the Anthropic adapter
flattens a tool to root properties/required and a root `anyOf` loses all arguments — the plan records this as a decision,
not a missing idea.
**C4 — Before/after evidence and the gate.** Deterministic evidence is mandatory: declaration chars per role, tool counts,
`measure-context` output, full suite counts, and the fixture counts the bench harness uses (tasks created, workers
spawned, rounds) from the hermetic fixtures. A live bench run is optional and only with owner authorization per
`bench/README.md` (explicit `--live`, pinned provider/model/thinking; the historical contamination caveat still applies).
Acceptance for merging C1–C3: every deterministic metric is unchanged or better, no test is weakened, and the owner
reviews the before/after table.
**C5 — Re-pin and record.** After C, update `context-budget.test.ts` ceilings once (measured + 3%, dated comment naming
what moved), `docs/ARCHITECTURE.md`/`docs/KNOWLEDGE.md`, `docs/ACCEPTANCE_MATRIX.md` (new F-S1 rows), and add one
`docs/HISTORY.md` row when the tranche is committed. The R3 row and the R3 plan remain in git history.

## 7. Budget arithmetic

| point | planner | worker | validation | reporter | model |
| --- | --- | --- | --- | --- | --- |
| measured at `197d6a9` | 49,294 | 42,808 | 42,000 | 6,551 | 75,500 |
| after A (measured 2026-10-29) | 49,248 | 42,791 | 41,980 | 6,528 | 75,483 |
| after B (measured 2026-10-29) | 47,795 | 41,081 | 40,270 | 6,282 | 72,773 |
| after C (target) | ≤ 45,300 | ≤ 41,500 | ≤ 40,700 | ≤ 6,450 | ≤ 71,500 |
| ceiling (unchanged until C) | 49,300 | 44,100 | 43,300 | 6,800 | 77,900 |

The ceilings are not raised in A or B: the reclaimed bytes are headroom (D-S1-5). C re-pins them once from measurement.
B10 removed only registrations that no role loadout ever held, so no declaration number in this table moved; what changed
is the registered count (34 → 32, all model-visible) and the board-verb count (11 → 10).

## 8. Verification and workflow protocol

Per task and per tranche, in this order:

1. `npx tsc --noEmit`.
2. Focused vitest for the touched area plus the invariants:
   `tests/minimal/context-budget.test.ts`, `truth.test.ts`, `claims.test.ts`, `acceptance-matrix.test.ts`,
   `authority.test.ts`, `board-verbs.test.ts`, `extension.test.ts`, `measure-context.test.ts`, and the graph/session/research
   suites for the task.
3. `node scripts/measure-context.mjs --source` and `node scripts/audit-surface.mjs` (added by A1); record both outputs.
4. `npm run build && npm run check:build`.
5. `git diff --check -- src extensions tests docs planning_update.md`.
6. Full `npx vitest run`; record files/tests passed/skipped/failed in the tranche evidence.
7. **GitNexus before editing (mandatory, learned from the R1–R3 lapse):** run `impact` upstream for every symbol about to
   change — `registerP2O` tool closures for graph/task/verb factories, `graphParameters`/`GRAPH_ACTION_PARAMETERS`,
   `GRAPH_ACTIONS`, the broker `case 'session'`/`graph_read` handlers, `tool-policy` exports,
   `withBoundaries`/`TOOL_BOUNDARIES`, and the `prompts.ts` exports. Report callers/processes/risk in the tranche notes;
   treat `risk: UNKNOWN` as unresolved, not as low. Before each commit, `detect_changes --scope all`.
8. Commits only on owner instruction, with the repository identity and no attribution lines; never stage `AGENTS.md` or
   the untracked `.pptx`. Nothing is pushed without an explicit request.

## 9. Invariants that must not change

- The evidence ladder: receipts, claims, cases are the only path to a finding. A graph row, dossier, path, technique id,
  retest note, project-knowledge row or `p2o_state`/`p2o_ledger` read is background, never evidence.
- Loadout enforcement is the authority model. S1 may narrow or relabel; it may not widen, **except** the read-only
  `p2o_graph action=path` sharing recorded in D-S1-7. The planner never gains target, lab or claim tools; a validation
  worker never gains `p2o_surface`.
- The graph stays bounded: every new read has a byte/row cap, capacity overflow is reported, never silently dropped.
- Hidden legacy verbs stay off the model surface until their test migration is done; no second delegation path appears.
- No new settings; caps are constants. No network in tests, no paid model calls, no live target traffic.
- Foothold wiring keeps `--lab-network` as the ingress gate: no host port, no tunnel, no pivot.
- `tests/minimal/context-budget.test.ts` ceilings stay unchanged through A and B; any raise is a separate owner decision.
- No AI attribution in commits/PRs; author identity is the repository's.

## 10. Risks and non-goals

Risks: (a) the Anthropic adapter flattening constraint blocks any root-`anyOf` merge — C3 is deliberately bounded and the
rejected option is recorded; (b) test churn — ~10 files in B and ~8 in C, and `acceptance-matrix.test.ts` validates every
cited `file.test.ts :: title` exactly, so renames must update the matrix in the same change; (c) budget transients while
tasks land out of order — each task must leave the budget test green, so net-negative tasks land before positive ones;
(d) the graph split is the one change that can alter role behaviour — it is gated on the deterministic before/after table
and owner review; (e) renaming tool/param names may break muscle memory in prompts/skills — every rename updates prompts,
boundaries, docs and tests in one commit.

Non-goals for S1: no new offensive capability, no new evidence rule, no change to the report/export schema, no live
benchmark run, no attempt to unify result shapes beyond naming them, no second delegation path, and no authority change
beyond the read-only `path` decision (D-S1-7).

## 11. Review answers (2026-10-29)

The four plan-review questions were asked in chat and answered by the owner; they are decisions now, not open questions.

- **Q1 — Is read-only `p2o_graph action=path` shared with worker/validation?** **Yes.** It stays a bounded, never-writing
  read; `chain`/`ingest` remain planner-only (D-S1-7). Implemented in A5 as the interim step and kept by the C1 split.
- **Q2 — Are the two breaking renames in scope?** **Yes, both**, in tranche B: `p2o_coverage_suggest`→`p2o_wstg_suggest`
  and `p2o_plan_author`→`p2o_goal_author`, with every reference and the acceptance matrix updated in the same change
  (D-S1-8, B9).
- **Q3 — Is a live benchmark authorized for the C gate?** **No.** C is accepted on the deterministic evidence in §6/C4
  (declaration numbers, full suite, hermetic fixture counts); a live run would need a separate explicit authorization
  (D-S1-9).
- **Q4 — When are `p2o_delegate`/`p2o_task_start` deleted?** **In S1.** B10 migrates the ~29 test files to the internal
  functions, then deletes both handlers, `HIDDEN_TOOLS`, the dead hidden-exposure plumbing and the legacy action map; the
  surface becomes 33 model-visible tools and 11 board verbs (D-S1-10).

Nothing in §12 changes; the audit evidence and its reproduction method stay as recorded.

## 12. Appendix — how the audit numbers were produced

The audit registered the real extension against a stub Pi API (the same pattern as `scripts/measure-context.mjs`) and
dumped, for all 35 tools: name, exposure, full description, full parameter schema, declaration chars by the budget
metric, action enum, role holders and the policy loadouts. Two temporary analysis scripts also walked the nested schemas
(leaf-name overlap, field-description bytes) and ran `Value.Check` per schema for the empty-object and unknown-field
cases. The artifacts live under `node_modules/.cache/p2o/` (`tools-audit.json`, `measure.json`) and are not committed;
A1 turns the durable part into `scripts/audit-surface.mjs`. Three read-only cross-checks were run independently against
source (authority/dead surface, feature overlap, prose drift and pagination), and a fourth covered schema/handler contract
drift; every finding above cites the code line or the measured artifact that proves it. Nothing in this file was inferred
from memory; where a claim is unverified it is labelled as such in the finding.
