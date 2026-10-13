# planning_update.md — `--refer-workspace`: reading prior runs in the same workspace as context

Status: **planning only. No code changed.** This supersedes the previous `planning_update.md` (the sandbox tool-reachability
analysis; that work is committed as `115681e`). Stop-condition check done first: nothing below asks a prior run's
records to count as same-run evidence, or asks for a prior run's authority (ticket/sandbox/cookie/budget/socket) to
come back — every same-run check in `src/tasks.ts`/`cases.ts`/`planning.ts`/`coverage.ts`/`evidence.ts` keeps
rejecting a foreign `runId` exactly as today. So this does not hit the "Stop if" clause; the plan proceeds.

Method: every claim below was read from the file at the cited line, not assumed from the skill/doc prose. Where
GitNexus coverage of `src/*.ts` was in doubt, the claim was confirmed by `grep` instead (named per AGENTS.md).

---

## A. Current state: what each existing reader can show, and what it cannot pass to a new run

### A.1 The command-parsing location named in the task is not quite where the flag goes

The task's "Where" said command parsing is in `extensions/p2o/index.ts`. Partly true: the **usage string**
(`:72`), the **`/p2o open|recover|reconcile|close` sub-command handler** (`:1328-1420`, dispatched through
`parseWorkspaceCommand` from `src/ui/workspace.ts`), and the **run-start confirm/create block** (`:1530-1712`) all
live there. But the actual **`--target ... --solo --workers --loop --executors --target-ops --retention --export
--goal` tokenizer** is `parseCommand()` in `src/target.ts:15-70` (confirmed by `grep -n "function parseCommand"
src/target.ts`; `index.ts:9` just imports it). `--refer-workspace` is a start-option flag, so it is added in
`src/target.ts`, not in `extensions/p2o/index.ts`'s own parsing code — `index.ts` only consumes the already-parsed
`command.options` object (first read at `:1536` `classifyTarget`, then `:1539-1550`).

### A.2 `/p2o open <run-id>` — the only existing "read a prior run" path, and why it cannot run alongside a new run

- `historical` (`index.ts:221`) is a **single optional slot** — one prior run can be open for interactive reading at
  a time, never several. `openHistorical()` (`:228-235`) calls `AssessmentStore.open(root, runId, {readOnly:true,
  maxBytes})` (the same static opener `AssessmentStore.create`'s sibling, `src/state/store.ts:118`) and
  `bindAssessmentStore()` (`src/state/adapter.ts:30-44`) so the normal `readLedger`/report code can read it.
- It is **mutually exclusive with an active run by construction**: `index.ts:1333` — `if (run || opening) throw
  Error('Stop the active assessment before opening/recovering/reconciling historical knowledge')`. A new run
  starting also calls `closeHistorical()` itself (`:1557`), right before creating its own store.
- `bindRecordBackend` (`src/state/registry.ts:16,18`) is a `Map<string, RecordBackend>` keyed by file path, so
  **multiple simultaneous bindings are structurally possible** — but `recordsPathOf()` (`index.ts:224-227`) only
  ever resolves `run.store` or `historical.store`, so a third bound store would not be reachable through any
  existing command anyway. Conclusion: reusing `historical`/`openHistorical` for `--refer-workspace` is the wrong
  fit — it is built for one human-driven read when nothing is running, not an automatic multi-run read while a new
  run is active. The new feature needs its own, separate, **transient** open→read→close path (B.2).
- What `/p2o open` already shows once opened (`:1418-1422`, `:1445-1448`): `report.counts.unreviewedTasks`,
  `.open`, `.candidates`, `.uniqueAcceptedFindings`, `.staleCases`, `.staleCoverageCells` — this is
  `reportProjection()`'s `counts` object (`src/report.ts:110-112`), the exact shape `--refer-workspace`'s gap report
  should reuse (D), not reinvent.

### A.3 `/p2o export|import` — the exact "prior material, never same-run evidence" precedent to copy

- `index.ts:1386-1399`. Import (`:1388-1397`): confirm dialog literally says *"Bytes are preserved as immutable
  artifacts in THIS run plus one provenance note. Imported bytes are never same-run evidence, and no scope, ticket,
  worker, cookie, budget, request queue or execution authority is restored."* (`:1390`). `docs/STATE_STORE.md:58`
  states the same rule for the underlying mechanism. This is precisely the guardrail's required behavior for
  `--refer-workspace`, already shipped for the bundle-file case — B.2 proposes the same shape (artifact + one
  provenance/lifecycle record in the new run) for the **live-sibling-run** case instead of a portable bundle file.

### A.4 `report-export.ts` — a deterministic, reusable file, but not an automatic cross-run feed

- `src/report-export.ts:240-354` `renderReport()` writes `REPORT.md`, `cases.csv`, `coverage.csv`,
  `findings.json/.csv`, `report-manifest.json` from **one run's own `LedgerIndex`** — it takes an index, not a
  workspace. Nothing reads another run's report files today (`grep -rn "report-manifest" extensions/p2o/index.ts`
  → 0 hits). `coverage.csv` already has `cell_id, asset_id, question_key, policy_key, actor_context, tenant_context,
  method_family, execution, assessment, currentness` per row (`:343-344`) — in principle enough to cross-reference
  without opening the old SQLite file at all, but this file is **only written if the run reaches finish/stop with
  `--export`, or `autoReport` on** (`index.ts:1554` footer text); an ephemeral run with neither has no file. The
  live SQLite store (A.2) is always present for a `durable-local` run and is the one source `--refer-workspace` can
  depend on existing; report files are an optional convenience, not relied on by B.

### A.5 The deterministic part that makes cross-run matching nearly free, already built for same-run staleness

- `src/state/graph.ts:37`: `assetEntityId = (scope, kind, key) => 'asset-' + sha(scope + '\0' + kind + '\0' + key).slice(0,24)`.
  **Pure function — no `runId`, no randomness.**
- `scope` is `store.graphScope()` (`src/state/store.ts:622-623`): `scopeOf(graphCanonical({identityVersion:
  GRAPH_IDENTITY_VERSION, targetKind, targetIdentity, sourceSnapshotSha256}))` — a pure function of the **manifest**,
  also with no `runId`.
- `sourceSnapshotSha256` (directory targets) is sealed once per run at `store.sealSource()` (`:156-167`), called at
  `index.ts:1702`, **after** sandbox start — i.e. after the confirm dialog, not at `classifyTarget` time (A.1 timing
  note carries into B.3). `targetIdentity = sha256Hex(targetLabel(target))` (`index.ts:1561`), and
  `targetLabel()` (`src/target.ts:224`) is `target.path` for a directory, **`target.url` (the full URL, not just
  `target.origin`)** for a web target.
- Coverage-cell `fingerprint` (`src/state/store.ts:376`) is `sha(graphCanonical({targetRevision, assetRef,
  questionKey, policyKey, actorContext, tenantContext, methodFamily}))` where `targetRevision === graphScope()`.
  Also no `runId`.

**Consequence:** if two different runs (old and new) target the exact same directory with an **identical**
`sourceSnapshotSha256`, or the exact same URL string, their `graphScope()` values are byte-identical, so an asset or
coverage cell independently (re)discovered in the new run for the same real-world `kind`+`key`/question collapses
to the **same `asset-*`/fingerprint id** the old run used — in a *different* SQLite file (different run, different
database), with no new matching code required. If the source hash (directory) or the exact URL (web) differs even
by one byte, `graphScope()` differs, every old fingerprint becomes foreign, and "stale" falls out for free — this
is the mechanism B.3/C use to answer "how is staleness shown" without inventing a parallel one.

**Caveat this creates for the design:** the guardrail asks for "same **origin**" matching for web targets, which is
broader than `targetIdentity`'s exact-URL hash. Eligibility (B.1, coarse: which runs are even offered) must compare
`target.origin` separately from the exact-match fingerprint reuse above (A.5), because two runs on
`https://x/app` and `https://x/api` share an origin but will never share a `graphScope()`/fingerprint — for that
pair, cross-run comparison can only work at the **coarse** level (B.4: offer the prior run's own summary as leads,
not per-cell alignment), never at the free, fingerprint-identical level.

### A.6 Reference designs actually checked (not just cited)

- `my_references/ARTEX/db/exploration_sources.go:317-323`: `ActivityTraceSearchAllWithSources` explicitly tags
  results from a related ("source") task with `markInheritedActivities(acts, source.Task.TaskID)` — comment: *"the
  local owner is excluded only from the current exploration; inherited traces are immutable historical context."*
  Independent precedent for "tag every inherited item with its origin, never merge it unmarked."
- `my_references/ARTEX/db/task_archives_restore.go:695`: *"An archived run cannot resume its former result
  callback."* Independent precedent for "no authority returns," matching `docs/KNOWLEDGE_WORKSPACE.md:12`.
- Neither reference repo has a "read a sibling run as context while a new one is active" feature to copy
  mechanically; both only confirm the **principle** (tag + no authority), not a mechanism to port.

---

## B. Proposed `--refer-workspace` behavior

### B.1 Argument syntax

Add to `StartOptions` (`src/target.ts:10`) and the token loop (`:24-67`):

```
--refer-workspace [latest|all|<run-id>[,<run-id>...]]
```

- Bare `--refer-workspace` (no value, or value `latest`): the single most recent **eligible** prior run (by
  directory mtime under `.p2o-state`) for this target.
- `--refer-workspace all`: every eligible prior run, capped (B.2) — not literally unbounded.
- `--refer-workspace <run-id>[,<run-id>]`: an explicit, named list (≤10 ids, same shape as other id lists in this
  codebase, e.g. `evidenceRefs` caps). An id that does not exist, is not `durable-local`, or fails eligibility (B.3)
  is reported in the confirm text as excluded, not silently dropped and not an error that blocks the ones that do
  qualify.
- Omitted entirely: today's behavior, byte-for-byte (this is additive, default off).

Usage string update, `index.ts:72`: append `[--refer-workspace latest|all|<run-id>,...]` after `--retention`.

### B.2 Mechanism: transient read, one new same-run record — not a long-lived second store

Two phases, split by what is knowable when (A.5's timing note):

**Phase 1 — eligibility, before the confirm dialog (`index.ts:1536`–`1552`, before `:1553`):**
1. `root = await stateRootFor(ctx)` (already computed at `:1541` as `selectedStateRoot`; reuse it, do not duplicate).
2. `readdir(root)` (bounded: newest 20 entries by mtime, matching the "not literally unbounded" note above — 20 is
   a starting number for F, not a claimed-correct one), skip anything without `assessment.sqlite`.
3. For each candidate (and only the explicitly named ones if `--refer-workspace <ids>` was given), open **read-only**
   just long enough to read `.manifest()`, then close immediately: `AssessmentStore.open(root, id,
   {readOnly:true, maxBytes:settings().storageQuotaMiB*1024*1024})` (same call `openHistorical` makes,
   `index.ts:230` — but without binding into `historical`, so it never touches the slot A.2 described).
4. Eligibility test: `manifest.targetKind === target.kind`, and for `url` targets
   `new URL(manifest.targetDisplay).origin === target.origin`; for `directory` targets `manifest.targetDisplay ===
   target.path` (same resolved path). This is the **coarse** test (A.5's origin caveat) — it does not yet know
   whether the match is "current" or "stale"; that needs `sourceSnapshotSha256`, which for a directory target does
   not exist yet at this point in startup (A.5).
5. Reject (not silently skip) a manifest this build cannot read (`!store.compatible`, same check `openHistorical`
   already makes, `index.ts:231`) — name it in the confirm text as "unreadable, schema N."

**Phase 2 — the actual digest, after the new store exists and (for directories) after `sealSource` runs:**
- URL targets: nothing is pending from `sealSource`, so this can run right after store creation (`index.ts:1567`,
  before the engine/broker are wired at `:1574` on).
- Directory targets: must run **after** `index.ts:1702` (`store.sealSource(...)`), because only then does
  `store.graphScope()` reflect the real, sealed `sourceSnapshotSha256` and the "current vs stale" verdict (A.5)
  becomes knowable. This is a deliberate split, not a bug: showing "which runs will be read" at confirm time (coarse,
  B.1) and showing "which of their cells are still current" only once source identity is sealed (fine, here).
- For each eligible run (now a short list, already confirmed by the human in B.4): open read-only again (same call
  as step 3, this time to actually read), compute:
  - `reportProjection(index, context).counts` (`src/report.ts:110-112`) — reused verbatim, not recomputed (A.2).
  - its coverage cells' `fingerprint`s compared against what the **new** run's `graphScope()` would produce for the
    same `assetRef`/`questionKey`/... tuple (A.5) — for an exact target match this is a direct set comparison; for
    an origin-only match (A.5 caveat) this step is skipped and only the run-level counts are offered.
  - close the store immediately.
- Write **one** new record in the new run's own store — not per prior run, one combined record — of a new kind
  (proposal: reuse `kind:'lifecycle'` with a `data.reference` payload, so no new record-kind enum is needed; C.2
  covers the alternative of a dedicated `kind:'reference'`), tagged with every source `runId` read (ARTEX-style
  tagging, A.6) and the text `'Prior-run context, never same-run evidence; re-verify before citing.'`. This record
  is what D's gap report and the Planner's `p2o_state` read (B.5) both point at.

Nothing here keeps an old run's store bound past its own read. No ticket, broker, socket, worker or budget object is
touched for a prior run at any point (unlike `run`/`current`, nothing resembling `OwnerRun` is ever constructed
for them).

### B.3 Matching rule (the guardrail's wording, made exact)

| Target kind | Eligibility (coarse, Phase 1) | Currency (fine, Phase 2) | Stale means |
|---|---|---|---|
| `url` | same `origin` (`manifest.targetDisplay`'s origin === `target.origin`) | same exact `targetIdentity` (full URL string, A.5) | different path/query on the same origin: offered, but only as run-level leads (B.4), no per-cell alignment |
| `directory` | same resolved `path` (`manifest.targetDisplay === target.path`) | same `sourceSnapshotSha256` (A.5, sealed after `:1702`) | hash differs: every old fingerprint is foreign (A.5) — shown as "same path, content changed since" |

### B.4 Confirmation step

The existing big confirm dialog (`index.ts:1553-1554`) gets one more paragraph, inserted after the retention
paragraph (same place the existing `--export`/report paragraphs are appended, `:1554`'s trailing template
segments), **naming every run that passed Phase 1 eligibility** (guardrail: "Name which runs will be read"):

> `Prior-run reference: N eligible run(s) under this workspace will be read as context — <run-id> (<when>, <counts
> summary>)[, ...]. Bytes/records stay in their own run; nothing is copied as evidence, no ticket/sandbox/cookie/
> budget/socket returns. [M run(s) requested but excluded: <id> (<reason>).]`

This reuses the same `ctx.ui.confirm(...)` call already there — one dialog, not a second prompt — consistent with
the guardrail "needs the same human confirmation as export and import" (which are also folded into this one
dialog's existing text, not separate dialogs).

### B.5 What the new run receives, and how the Planner reads it (no lead-prompt change)

- The lead prompt (`src/prompts.ts:50` `ownerInstructions`) stays untouched — it is tested to contain **no** `p2o_*`
  tool name (`tests/minimal/workflow-policy.test.ts:83`) and to stay under 5000 characters (`:86`). Nothing about
  `--refer-workspace` belongs there.
- Surfacing happens through the **existing** `p2o_state` tool, not a new one. `KNOWLEDGE_DOMAINS`
  (`src/context.ts:6`) is a plain tuple with **no pinning test** (`grep -rn "KNOWLEDGE_DOMAINS" tests/` → 0 hits) —
  adding one more value (e.g. `'reference'`) is a narrow, low-risk change, unlike adding a new tool: `ownerTools`'s
  length is pinned (`tests/minimal/workflow-policy.test.ts:101`, `toHaveLength(19)` for both delegated and solo), so
  a brand-new `p2o_reference` tool would need that pinned count updated everywhere it is asserted — avoidable by
  reusing `p2o_state`'s existing `heads`/`search` actions over the new domain.
- `src/tool-guidelines.ts`'s `TOOL_GUIDELINES.p2o_state` (`:15`) gets **one appended sentence** (guardrail: "put
  workflow advice in per-tool promptGuidelines, not in the lead prompt"), e.g.: *"If this run was started with
  --refer-workspace, list domain=reference once before repeating recon; every item there is a lead or coverage
  hint, never evidence — it needs its own same-run task and evidence to count."* Must stay ≤260 characters (pinned,
  `workflow-policy.test.ts:78`) and must not push the delegated-Planner/solo-owner aggregate guidance text over
  1200 characters or the worker aggregate over 800 (`:76-77`) — the appended sentence above is ~230 characters;
  headroom in the existing budget has to be checked against the current total at implementation time, not assumed.
- Workers never see this directly: `workerInstructions`/`workerBrief` (`src/prompts.ts:86-128`) are unchanged: the
  lead is the one who reads the reference record and turns anything relevant into a *fresh* task/brief context
  string for a worker (`workerBrief`'s existing `context` field, `:105,115-118`) — matching the "no authority
  carries over" rule and the existing comment that worker args (`index.ts:457-458`, the line the task's "Where"
  pointed at — actually worker-spawn args, not run-start args, per A.1's correction) never carry a second
  extension pack or special mode in.

---

## C. Evidence boundary

| Prior item | May become | Rule that enforces it (file:line) |
|---|---|---|
| Accepted-current case (not stale) | A **lead/hypothesis** for a brand-new case | `src/cases.ts:84-90` — every `claimRefs`/`independentEvidenceRefs`/`reportRefs`/contradiction/remediation evidence ref must resolve to `runId === this.runId`; a prior case's own refs cannot be cited at all, only its *existence* can prompt a new task |
| Case flagged stale by B.3 (source hash/URL changed) | A **weaker coverage hint only** ("this question was asked before, under different content") | Same as above, plus the cell/case's own `staleReasons` (`src/coverage.ts:32-33`, `src/cases.ts` currentness) already exist for the *same*-run case; the cross-run digest (B.2) copies this label forward explicitly rather than presenting a stale item as equal to a current one |
| Open gap / `open_proof_gap` candidate | A **lead** for a new task | `src/evidence.ts:66` — `candidate()` requires every `evidenceRefs`/`negativeControls` id to be same-run (`Unknown same-run evidence ID`); `src/tasks.ts:169` — task `evidenceIds` must be same-run (`Unknown same-run task evidence`) |
| Coverage cell, `execution:'tested'`, current | A **coverage hint** ("already probed; result X") — not a substitute for a new cell | `src/coverage.ts:46-52` — `assetRef`/`taskRefs`/`claimRefs`/`evidenceRefs`/`gapRefs` all re-validated same-run; `'tested'` requires same-run `evidenceRefs` + a same-run reviewed task, so a new cell cannot just copy the old verdict |
| Coverage cell, `execution:'blocked'` | A **coverage hint** with its recorded `requirement` carried as context | `src/coverage.ts:53` — blocked coverage must retain its own `open_gap`/`gapRefs`; the *reason* is useful forward, the closure is not |
| Coverage cell never recorded at all (D's "never reached") | A **coverage hint** flagging an unexplored cell — the strongest kind of lead, since nothing contradicts it yet | Nothing to violate — it is absence of a record, reported as `unknown`/`not covered`, never as "clean" (guardrail D) |
| Plan goal/todo/decision | A **lead** ("this was the stated next step") | `src/planning.ts:76-81` — `supportRefs` must resolve same-run; task/goal ids referenced must exist in the *current* frontier, so an old plan's own task ids are meaningless here and must not be copied in |
| Worker report / handoff narrative | **Context only**, never a claim | No direct enforcement needed — `TaskBoard.handoff()` (`docs/STATE_STORE.md:39`) is a same-run commit; an old report's text has no id that resolves in the new run at all |
| Raw imported bytes (if the operator separately used `/p2o import` instead) | **Nothing** — explicitly "never same-run evidence" already | `index.ts:1390` (A.3) |

Rule in one line, matching the guardrail: **every table row's enforcement is "unknown/foreign `runId`" rejected by
code that already exists**; `--refer-workspace` adds a reader and a label, never a bypass of any row above.

---

## D. Gap report (deterministic, produced at run start)

Written once, right after Phase 2 (B.2), as the body of the same `kind:'lifecycle'`/`reference` record, built from:

- **Covered** — per eligible run, `reportProjection().counts` (A.2/B.2) plus the cell fingerprints that matched
  the new run's would-be `graphScope()` (A.5): shown as `<fingerprint-equivalent question>: tested, <when>, <which
  prior run>`.
- **Left open** — prior `open_proof_gap` candidates and `blocked` cells, same shape, labelled with their recorded
  `requirement`/reason (C).
- **Never reached** — derived the same way `wstgAppendix` already derives its L0 list (`src/report-export.ts:156-
  182`: tests with no recorded cell) and the way `coverageViews` already derives `omittedCells`
  (`src/coverage.ts:35`) — reused, not reinvented: union, across every eligible run, of questions/tests with **no**
  recorded cell at all.
- **Stale** — any item whose owning run failed B.3's currency test; listed separately from "covered," never merged
  into it.
- **Unknown**, explicitly, when: no eligible prior run exists (first run on this target), the only eligible run(s)
  had `index.complete === false` (interrupted/partial reconciliation, `docs/STATE_STORE.md` migration rules), or a
  run was named by id but excluded for schema incompatibility (B.2 step 5). Per guardrail D, "unknown" is never
  rendered as "clean" or silently omitted — it is one more labelled bucket.

This record is read by the Planner through `p2o_state {action:'heads', domain:'reference'}` or `digest`
(`docs/CONTEXT_PACKETS.md:17-28`, the existing mechanism, no new one) — it is not pushed into any prompt.

---

## E. Phased roadmap

| Phase | Scope | Acceptance test(s) to add/change | Rollback |
|---|---|---|---|
| **E0** | `--refer-workspace` flag parsing only (`src/target.ts`), no behavior yet — always resolves to an empty eligible list | New: a `target.ts` parser test (flag accepted, value validated, rejected with other option combinations) | Revert the parser change; zero runtime behavior exists yet, so nothing else to unwind |
| **E1** | Phase 1 eligibility enumeration + confirm-text paragraph (B.1, B.4); still no Phase 2 read | Extend `tests/minimal/extension.test.ts`'s confirm-dialog assertions (it already asserts dialog text shape, per the earlier worker-briefing test pattern at `:267,278`) to cover the new paragraph; a fixture with 0/1/2 prior runs under a temp `.p2o-state` | Flag stays parseable but the confirm paragraph and enumeration are removed; B.2's Phase 2 never shipped, so no stored data format to migrate away from |
| **E2** | Phase 2 read + digest record (B.2) + evidence-boundary labelling (C) | New `tests/minimal/refer-workspace.test.ts`: two `AssessmentStore` fixtures (old + new) on the same `targetIdentity`/`sourceSnapshotSha256`, assert the digest record's fingerprints match via A.5's mechanism, assert a *changed* hash fixture produces zero matches and a "stale" label, assert the record's own refs never satisfy `tasks.ts:169`/`cases.ts:84` same-run checks (i.e. literally try to cite it and expect rejection) | Delete the digest-writing call; E1's enumeration/confirm text can stay (harmless without E2) or also be reverted together |
| **E3** | `KNOWLEDGE_DOMAINS` + `p2o_state` surfacing (B.5), `TOOL_GUIDELINES.p2o_state` sentence | `tests/minimal/workflow-policy.test.ts`'s existing budget assertions (`:76-78`) must still pass with the new sentence counted in; add a `context.test.ts` case for the new domain's head derivation; bump `POLICY_VERSION` (`src/tool-guidelines.ts:7`) and update whatever asserts the runtime closure digest, since it is "part of the runtime closure digest and is shown to the operator" per that file's own comment | Revert the guideline sentence and `POLICY_VERSION` bump; domain stays registered but unused is harmless, or revert it too |
| **E4** | Gap report content (D) built from `reportProjection`/`wstgAppendix`-style derivation | `tests/minimal/wstg-skills.test.ts`-style fixture extended with a synthetic "prior run" to check the four D buckets (covered/open/never-reached/unknown) render correctly, including the `index.complete===false` → `unknown` case | Revert D's derivation function only; E2's bare digest record (counts only, no bucketed gap report) can ship alone as a smaller final state if D is dropped |

**Tests this touches that are explicitly pinned and must still pass unmodified in intent (only their *numbers* may
need updates, never their *meaning*):** `docs/ACCEPTANCE_BASELINE.md` row *"Reload/tree/fork đọc checkpoint | Chỉ
historical state; không broker/ticket/container/network/model turn mới"* (still true: Phase 2 opens read-only and
closes, grants nothing) and *"Negative result reused | Chỉ cùng tested context/method/version; không biến thành
global 'clean'"* (still true: B.3/C never let a stale or cross-context match claim cleanliness). `docs/WSTG_MAP.md`
is unaffected — it is test-key data, not per-run state. No change here touches `docs/ACCEPTANCE_MATRIX.md` row
identities, only adds new test files alongside them.

**Prompt-size effect:** `ownerInstructions()` — **zero** characters added, by design (B.5). `TOOL_GUIDELINES.p2o_state`
— one sentence, estimated +230 characters against the existing per-role aggregate ceilings (1200 Planner/solo, 800
worker; `p2o_state` is available to both roles per `docs/CONTEXT_PACKETS.md:27` budgets, so the sentence counts
against both ceilings, not just one). Worker prompts (`workerInstructions`/`workerBrief`) — zero, by design (B.5).

---

## F. Open decisions for the owner

1. **Default cap on Phase 1 enumeration** (B.2 step 2 proposed 20 newest runs) — is 20 the right bound, or should it
   be a setting like `storageQuotaMiB` is?
2. **`--refer-workspace all` ceiling** — how many eligible runs may Phase 2 actually *read* in one start (reading
   cost is bounded per run, but N runs multiply it); propose capping at 5 and naming the rest as "eligible but not
   read, re-run with an explicit id list" in the confirm text.
3. **Record shape for the digest** (B.2): reuse `kind:'lifecycle'` with a `data.reference` payload (zero schema
   change, consistent with how `/p2o reconcile` already appends a `kind:'lifecycle'` record per `docs/
   STATE_STORE.md:59`), or add a dedicated `kind:'reference'` to the record-kind union (clearer `index.byId.get(id)
   ?.kind` filtering in C's enforcement checks, at the cost of a wider schema/validator change, `src/validate.ts`).
   This plan assumes the former; the owner may prefer the latter for long-term clarity.
4. **Origin-level matches (A.5 caveat, B.3's `url` row)** — should these even be eligible by default, or only when
   explicitly named by run id (since no per-cell alignment is possible, the value is weaker and the "N eligible
   runs" confirm-text paragraph could get noisy on a workspace that has assessed many different paths on one app)?
5. **Directory timing split (B.2 Phase 2)** — is it acceptable that the exact stale/current verdict for a directory
   target is only known *after* sandbox start (post `:1702`), i.e. slightly after the human already confirmed the
   run, rather than before? The alternative (delaying the confirm dialog itself until after a throwaway source scan)
   would change today's confirm-then-start sequencing for every run, not just referencing ones — a much larger,
   probably unwanted, change.
6. **Should `--refer-workspace` imply anything about `--retention`?** E.g. does referencing only make sense for
   `durable-local` old runs (ephemeral ones are usually gone), and should an `ephemeral` *new* run even be allowed
   to use the flag, given its own knowledge will not be referenceable later either?

---

## Appendix — evidence index

- `src/target.ts:8-70` (`Target`, `StartOptions`, `parseCommand`), `:81-91` (`classifyTarget`), `:224` (`targetLabel`).
- `extensions/p2o/index.ts:72` (usage), `:221-241` (`historical`, `openHistorical`, `recordsPathOf`,
  `closeHistorical`), `:1328-1420` (workspace sub-command dispatch), `:1386-1399` (export/import confirm text),
  `:1530-1712` (run-start: target classify → confirm → store create → sandbox start/`sealSource` → active).
- `src/state/store.ts:29-35` (`StoreManifest`), `:95,118` (`create`/`open`), `:156-167` (`sealSource`), `:376`
  (coverage fingerprint), `:622-623` (`graphScope`), `:722,727` (asset upsert via `assetEntityId`).
- `src/state/graph.ts:37` (`assetEntityId`).
- `src/state/adapter.ts:30-44` (`bindAssessmentStore`), `src/state/registry.ts:16,18` (`bindRecordBackend`, keyed map).
- `src/report.ts:110-112` (`reportProjection` counts). `src/report-export.ts:156-182` (WSTG L0 derivation, reused
  for D), `:240-354` (`renderReport`).
- `src/tasks.ts:169,216`; `src/cases.ts:84-90`; `src/planning.ts:76-99`; `src/coverage.ts:46-53`;
  `src/evidence.ts:58-79` — all same-run `runId` enforcement cited in C.
- `src/prompts.ts:50-84` (`ownerInstructions`, no tool names, size-tested), `:86-103` (`workerInstructions`),
  `:105-128` (`workerBrief`).
- `src/tool-guidelines.ts:1-24` (`TOOL_GUIDELINES`, `POLICY_VERSION`, budget comment).
- `src/context.ts:6-7` (`KNOWLEDGE_DOMAINS`, unpinned by any test — confirmed via `grep -rn "KNOWLEDGE_DOMAINS"
  tests/`).
- `tests/minimal/workflow-policy.test.ts:67-101` (lead-prompt/guideline budgets, `ownerTools` length pin).
- `docs/KNOWLEDGE_WORKSPACE.md:7-13` (no-authority-carries-over rule, in the owner's own words).
- `docs/STATE_STORE.md:17-22,52-60`; `docs/CONTEXT_PACKETS.md:17-30`; `docs/ACCEPTANCE_BASELINE.md` (the two rows
  quoted in E).
- `my_references/ARTEX/db/exploration_sources.go:286-323`, `task_archives_restore.go:695` (A.6).
- Not inspected further (named as follow-ups, not assumed): `my_references/strix`'s own resume semantics beyond the
  grep hits in A.6 (strix's "resume" is session/conversation resume, a different axis than this plan's run-to-run
  knowledge reference, and was not needed to validate the two principles actually borrowed); exact current
  character total of the per-role `TOOL_GUIDELINES` aggregate (E's "+230 characters" is an estimate from the new
  sentence's own length, not a measured before/after against the live budget).
