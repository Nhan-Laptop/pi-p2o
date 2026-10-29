# P21 — From a measured run to red-team research depth: host-recorded evidence, findings that can land, and breadth that keeps going (plan of record, 2026-10-29)

Status: **planned, nothing implemented yet.** This file replaces the P19/P20 plan of record by owner instruction (2026-10-29).
That plan, and the decisions D-P19-* / D-P20-* that shaped it, are preserved at `git show 2e22b5c:planning_update.md`; its
delivered rows remain in [docs/HISTORY.md](docs/HISTORY.md) and [docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md). Where
those pages cite `planning_update.md` §4/A, §4/B, §4/D, §R0, §R1, Part III/IV or an appendix, they describe that revision of the
file, not this one.

Basis for this plan:

- the live run `run-42c447d6-cb8a-4c65-85a7-6f4036014ef6` (2026-10-29 14:35–15:29 UTC, 54 minutes), durable store under
  `~/tmp/cmp/.p2o-state/run-42c447d6-cb8a-4c65-85a7-6f4036014ef6` and report under
  `~/tmp/cmp/.p2o-reports/report-run-42c447d6-cb8a-4c65-85a7-6f4036014ef6-final`;
- the reference implementation ARTEX 0.3.15 at `~/tmp/ARTEX` (commit `e6ec569`, AGPL-3.0, read-only);
- p2o at commit `2e22b5c`.

The run is a measurement, not a benchmark: it says what the machinery did in one hour against one host, not how effective
pentesting is. Every claim below is a mechanism claim that a hermetic test can hold.

## 0. What the run measured

| Measure | Value |
|---|---|
| Wall time / planner rounds / tasks | 54 min / 7 / 7 (1 recon, 4 discovery, 2 validation) |
| Target receipts | 98 (net 55, shell 25, http 15, capture 3) |
| Graph | 87 assets (51 route, 32 endpoint, 3 service, 1 host), 197 assertions (168 observed, 24 hypothesis, 5 inferred), 93 anchors, **0 relations** |
| Claims / cases / accepted findings | 13 / 2 / **0** (1 pending, 1 disputed; 13/13 "not replayable") |
| Coverage | 1 plan (revision 1), 19 cells: 9 tested/open_gap, 10 planned/unreviewed |
| Debt at finish | 48 obligations: GOAL_OPEN 2, SCOPE_UNPLANNED_ASSET 68, CELL_NOT_RUN 19, GAP_UNTRIAGED 45, WSTG_UNPLANNED 71, TASK_UNMAPPED 1 |
| Model usage | 243 messages, 8.66 M tokens, $0.38 |

Two validation workers **did reproduce** both confirmed claims from their own receipts (report texts `VALIDATION RESULT:
REPRODUCED`; open items `7b7a626d`, `7f01c8af`, `d084614f`) and still ended with no independent claim, no covered cell and no
accepted finding. That gap between what the run observed and what the ledger could record is what this plan closes.

## 1. How to read this plan

- **A seam** is a place where the host could observe or derive a fact but today asks the model to assert it instead; an
  unasserted item becomes a silent zero.
- **Host-recorded** means the host stamps a fact at write or execution time (receipts, payload hashes, containment, policy
  provenance); **derived** means computed on read and never stored as evidence.
- Each package (A, B, C) is a set of tranches with their own tests and acceptance rows; the order is A → B → C
  (D-P21-3). A tranche is not "done" until its matrix rows, HISTORY row and measured gates land with it.

## 2. Diagnosis — six seams

### 2.1 S1 — Evidence: replay is a model memory, so 13/13 claims are not replayable

A receipt is a bounded, redacted excerpt (`RECEIPT_INPUT_BYTES` 2000, stdout 16 KiB, stderr 4 KiB; `src/evidence.ts:67-96`).
The replayable unit is a separate artifact the model must store itself with `p2o_lab` (`src/lab.ts`), and a claim is replayable
only when it names both `payloadRef` and `environmentRef` (`src/claims.ts:91-94`). In the run, 3 claims stored a payload and
**0 created an environment** — for HTTP-only claims the docker-compose-style environment recipe has no meaning — so every claim
reported "not replayable" and no validation could be byte-exact.

### 2.2 S2 — Validation: the write-back cannot be expressed, and the host picks the wrong claim

Validation workers tried six times to record the reproduction and were refused by bookkeeping:

- `independentEvidenceRef` must also be listed in `evidenceRefs`; the refusal says "needs a cited receipt from a different
  worker" even when the real missing piece is the citation (`src/evidence.ts:161-163`).
- the host then looks for the *latest* claim by that author citing the receipt (`src/evidence.ts:165-166`, `.at(-1)`); when one
  author cites the same receipt from two claims (the OpenAPI claim `b64350ae` and the admin-API claim `d3f20083` both cited
  `8c41e41e`), the wrong claim is compared and surface/risk mismatch refuses a correct replay.
- `resolves` takes open-item IDs; passing a claim ID answers "Unknown open-item ID" with no legal next step.
- the same actor may not validate its own claim, and the host requires an independent path to be recorded as a peer claim or a
  reviewed validation task; the peer-claim field exists, but the run's workers could not reach it.

Open items: `7f01c8af` (six refusals), `d084614f` (three attempts, named legal next), `7b7a626d` (reproduced but unrecorded).
Result: two reviewed validation tasks with own receipts and **no claim**, so the host keeps their cells "planned/unreviewed"
(`src/coverage.ts:93`) and case independence never completes.

### 2.3 S3 — Graph: containment is a model assertion, so the graph has no edges

The asset graph stores 87 assets, 197 assertions and 93 anchors but `relations` only through the model-submitted
`p2o_graph_record` batch (`src/state/graph.ts:39`, `src/state/graph-tool.ts:33`). No worker asserted an edge, so the run's graph
is flat: 0 relations, `Chain: none recorded`, and the chain/attack-map machinery has nothing to walk. ARTEX never has this
state: containment is a typed parent column (`root_domain`/`domain`/`ip`/`url`/`method`, `db/schema.sql:40-91`) and exploration
edges are side effects of the write verbs, not a separate action (`agent/tools.go:1032-1088`, `db/finding_traffic.go:375-379`).

### 2.4 S4 — Policy: a confirmed claim has nowhere to land

`src/cases.ts:114` refuses a confirmed case unless a cited demonstrated claim has `policyBasis != inferred`. Both confirmed
claims in the run are `inferred` (no documented anti-automation requirement; public API docs may be intended), so case 2 stays
pending with `confirmed-verdict-lacks-current-tested-claim`, and the planner's own decision row `907b5b37` names the wall: a
confirmed case needs a tested claim with a non-inferred policy basis. The rating path already allows an inferred-basis case at
demonstrated depth with the `INFERRED_POLICY` flag (`src/cases.ts:226-238`), but a case that cannot be accepted can never be
rated. A black-box read-only run with no operator policy therefore cannot produce a finding, and goal 1 (`every cell terminal`)
is blocked by construction: cell terminal needs an accepted finding, which needs policy, which needs the operator who is not in
the loop.

### 2.5 S5 — Planning: discovery never returns to the denominator

The coverage plan was created once (revision 1, 14:35) and never revised, although `p2o_coverage_plan` supports `revise` and
discovery recorded 87 assets. 68 assets sit outside every plan (`SCOPE_UNPLANNED_ASSET`), 71 applicable WSTG tests were never
planned (`WSTG_UNPLANNED`), 45 gaps stayed untriaged, and only two question families were ever asked (Strapi public-role gate;
NextAuth/auth boundary). Rounds 4–5 were judged quiet ("no tested cell, candidate closure, asset or chain depth",
`src/engine.ts:238-241,321-330`) while those 68 assets and 71 tests were known; round 6 demand named 52 debts and the lead
finished at round 7 with 48 obligations. Research breadth is not a model-capability problem here: the host already knows the
unplanned work and the brief does not put it in front of the planner as work.

### 2.6 S6 — Loop and claim quality: no settlement, and a negative claim without a control

- **No settlement step.** The run finished with 48 named obligations and 158 planning signals. ARTEX forces a wrap-up turn that
  writes back identified-but-unwritten results before a stop (`agent/wrapup.go:94-100`) and separates `exhausted` from `done`;
  p2o's finish records the incomplete outcome honestly but leaves the identified work unwritten.
- **No claim-quality discriminator.** The "no throttle" claim sent identifier-less bodies, which hit NextAuth's
  missing-credential short-circuit rather than the backend verification path; validation replayed the same payload and
  "reproduced" the void path. Only a later task with an identifier+password payload exposed it, and case 1 was disputed at r2.
  `negativeControls` was empty. Nothing in admission, the validation brief or review asked "does this payload exercise the
  claimed mechanism?".
- **Throughput.** 7 tasks in 54 minutes, two concurrent at most; model cost is not the limit ($0.38) and the round budget is
  not the limit. The limit is that a single question family takes 12–25 minutes and the loop does not fan out.

## 3. What ARTEX does that this plan borrows (and what it does not)

| ARTEX mechanism | Where | What p2o adopts |
|---|---|---|
| Recording transport: every Bash/WebFetch exchange captured, bodies hashed and addressable, index rows only in the model | `agent/worker.go:204-224,437-453`, `traffic/traffic.go:85-87`, `evidence/store.go:43-116` | A1: the host records the admitted request/command on the executor and stamps its hash on the receipt; the model never stores the replay by hand |
| Admit cheap, confirm separately: finding binds real exchanges (baseline/proof/verification/supporting), then reporter + retester with version guard | `db/schema.sql:1146-1174`, `db/finding_traffic.go:366-379`, `agent/retester.go:9-12` | A2: claim admission derives replay from receipts; validation records a reproduction in one field; B keeps the policy gate separate from proof |
| Containment derived from typed keys, no asset edge table; edges are side effects of verbs | `db/schema.sql:40-91`, `agent/tools.go:1032-1088,1347,1183` | A3: host derives containment edges from anchors at write time; asserted relations remain an optional second layer |
| Never-idle: hard floor (emit ≥1 intent when nothing is open or running), heartbeat, `exhausted ≠ done`, per-task todo survives wakes | `agent/planner.go:457-461,108-117,433,462`, `engine.go:1135-1145` | C1/C3/C4: the brief names unplanned work, quiet cannot be declared while it exists, settlement writes dispositions before finish |
| Wrap-up/settlement turn forces write-back before a stop | `agent/wrapup.go:94-100`, `engine_timeout.go:14-21` | C4: settlement packet, without loosening completion |
| Per-unit transcript + resume, boot recovery `running→open` | `agent/worker.go:500-514`, `db/exploration.go:312` | Not adopted in P21 (p2o's round-session model and durable ledger already cover restart); revisit only if a later measurement shows lost work |
| Skills as a small catalog + on-demand body | `norma/skill/skill.go:94-97,133-160` | Not adopted; p2o's catalog and WSTG map are already stronger |
| Credentials | `assets.auth JSONB[]`, `tools_insert.go:183-188` | Nothing to copy: p2o's `p2o_secret` is ahead; C5 only fixes the run's own ladder |

Two things p2o must not copy: ARTEX-style admission without a verifiable receipt (p2o keeps the evidence ladder) and a global
MITM proxy (p2o's executor boundary is its sandbox; A1 records what the tool already received).

## 4. Decisions

- **D-P21-1 — Scope.** Three packages, A (host-recorded evidence and derived containment), B (operator policy baseline),
  C (research breadth and never-idle), in that order (owner, 2026-10-29).
- **D-P21-2 — Authority does not move.** No tool, loadout or role change: planner still has no target/claim tool, worker is
  still the only claim author, no role holds a cell writer, review is still not proof. Every new fact is host-recorded at write
  time or derived on read, and a derived or host-stamped fact can never satisfy a claim, case, cell or goal.
- **D-P21-3 — Sequence.** A → B → C. A2 depends on A1; A3 is independent and may land first; B tranches are additive; C starts
  only after A and B are measured.
- **D-P21-4 — Evidence stance (owner chose B2).** The shortcut "accept a confirmed case on an inferred policy basis" (B1) is
  **rejected** for this plan. A finding still needs recorded policy: `explicit_contract`, `boundary_invariant`, or the new
  `operator_contract` backed by a run-start policy artifact. Inferred-basis confirmed claims stay recorded observations and are
  ratable at demonstrated depth under the existing `INFERRED_POLICY` rule only once accepted through policy; nothing in the
  depth ladder, evidence ladder or rating ceiling is lowered.
- **D-P21-5 — Replay capture is private and byte-exact.** The host stores the replay unit in the run's private control directory
  (0600, not exported, removed with the run — the existing `p2o_lab` contract); the ledger keeps only the reference and hash.
  A request that contains a substituted operator secret keeps the placeholder, never the value.
- **D-P21-6 — Credential ladder bounds (owner-approved).** Allowed in-run: public artifacts (JS bundles, source maps, publicly
  served config) for committed endpoints/secrets; exactly one attempt with the product's documented default-credential set,
  named and recorded; self-provisioned registration/tenant when a registration path exists; operator-sealed secrets via
  `p2o_secret`. Prohibited: brute force, spraying, stuffing, reset abuse, lockout attempts. Operator constraints stay absolute.
  Assess mode stays read-only.
- **D-P21-7 — No live or paid run in this phase; no commit or push without a fresh owner instruction.** All tests hermetic with
  inert executors; no target traffic.
- **D-P21-8 — Documentation truth.** Each tranche lands its `docs/ACCEPTANCE_MATRIX.md` rows (F-P21-*), `docs/HISTORY.md` row and
  the USAGE/ARCHITECTURE text in the same change that makes the statement true; no current doc names an unimplemented verb
  (inherits D-P20-7).
- **D-P21-9 — Prompt and brief budgets are measured, never raised blindly.** Every added teaching line is paid for inside a
  measured ceiling, or the ceiling is re-pinned from a fresh measurement with the method `tests/minimal/context-budget.test.ts`
  records. Declaration baselines may fall, never rise casually.
- **D-P21-10 — Derived containment is structural, not evidential.** A derived relation records what an anchor already says
  (host contains path; path prefix contains endpoint), is labelled `derived` with its rule and actor, and is read-only truth about
  structure. Asserted relations stay the model's layer; on conflict the asserted row wins. Neither satisfies anything.
- **D-P21-11 — The old plan is retired.** This file is the only plan of record; the previous revision stays recoverable at
  `2e22b5c` and in the HISTORY/matrix rows that describe it.

## 5. Package A — host-recorded evidence and derived containment

Goal: remove the three silent zeros measured in §2 — 13/13 claims not replayable, 0 recorded validation closures, 0 relation
edges — without widening a single authority.

### A1 — Record the replay unit on the executor

- **Where:** receipt creation in `src/evidence.ts` (`receipt()`), the exec/HTTP receipt path in `extensions/p2o/index.ts`
  (~2331–2404), the broker operations `exec`/`net` (`src/broker.ts:445-468`) and `http` (`:521-534`), and the existing
  `PayloadStore` (`src/lab.ts`).
- **What:** after an admitted target operation runs, the host derives a canonical replay unit and stores it with
  `PayloadStore.put`: for `p2o_http` the method, final URL, request headers (with operator-secret placeholders intact), body
  bytes and cookie header as sent; for `p2o_net`/`p2o_shell` the command text actually admitted plus workdir/session. A unit
  larger than the payload bound (48 KiB) is not stored; the receipt records `replay: {captured:false, reason, bytes}` so the
  gap is visible instead of silent.
- **Stamp:** the receipt's `data` gains `replay {payloadRef, sha256, kind, bytes, environmentFingerprint}`. The environment
  fingerprint is host-derived from the runtime image identity and executor mode, so a network claim no longer needs a
  docker-compose recipe; `p2o_lab action=env` stays for service/seed setups and, when a claim names one, it wins.
- **Non-goals:** no MITM proxy, no response-body capture beyond what the tool already returned, no new tool, no new authority.
- **Tests:** each target tool's receipt carries a replay reference; a >48 KiB unit fails closed with a named reason; the
  fingerprint is stable within a run and changes with the runtime identity; an export never contains payload bytes.

### A2 — Claim replay inheritance and a validation write-back that cannot be refused

- **Claim:** `candidate()` (`src/evidence.ts:113-190`) stamps `payloadSha256`/`environmentFingerprint` from the cited receipts'
  replay stamps when the caller did not name `p2o_lab` artifacts; explicit references keep precedence and must match the host
  stamp. `isReplayable` (`src/claims.ts:91-94`) then becomes true with no model bookkeeping, and the report's replay column
  prints the host-derived reference instead of "not replayable".
- **Validation write-back:** new optional `reproduces` on `p2o_candidate` (candidate record id or slug; any worker, intended for
  the validation role). The host resolves the claim, requires a different actor, matches surface/risk against **that** claim
  (fixing the `.at(-1)` latest-claim bug at `src/evidence.ts:165-166`), requires the replaying claim's own tested receipts and a
  matching host payload sha, and records the resolved claim id plus the author receipt internally. This replaces the three-step
  ref field dance that failed six times in the run.
- **Messages:** the three refusals become actionable: name the required evidence refs, list the legal ids (the claim's receipt
  ids), say which receipt is the author's and which are the replayer's, and offer `reproduces` as the legal next step.
- **Legacy:** the `independentEvidenceRef` path keeps working unchanged; the new field is additive.
- **Acceptance:** a validation worker that replayed an http/net claim records one independent claim with its own receipts and
  `reproduces`, and `caseViews().independentCurrent` turns true for the case that cites it.
- **Tests:** accepted replay claim; same-actor refused; wrong surface refused with a message naming the claim; two claims by one
  author citing one receipt no longer cross-match; coverage sees the validation claim on the validation task.

### A3 — Derive containment from anchors at write time

- **Where:** the graph write callback (`extensions/p2o/index.ts:4266`) and the graph batch validation
  (`src/state/graph.ts:200-245`), reading the anchor rows written with each asset (`src/state/schema.ts` `anchors`).
- **What:** when assets and anchors are written, the host derives the edges the anchors already state: host asset ← URL/path
  anchor of a route; path-prefix route ← endpoint; artifact anchor → asset; header anchor → endpoint. Stored as `relations` rows
  with kind `contains` or `anchors`, body `{derived:true, via:'anchor', rule}`, actor host/extractor, and no evidence
  requirement; model-submitted relations keep their current shape and win on conflict.
- **Read side:** `p2o_graph path`, the chain/attack map and the brief's chain counts read derived and asserted rows with the
  derived ones labelled. Derived rows are structural only (D-P21-10).
- **Non-goals:** no guessed edges from names or version strings; nothing that an anchor does not directly state; no
  auto-satisfaction.
- **Tests:** every anchored endpoint is reachable from its host through a derived path; no edge without an anchor; an asserted
  relation overrides a derived one; export marks derived rows; the graph views count them without claiming evidence.

### A4 — A negative observation needs a discriminating control

- **Claim admission:** when `closure=confirmed`, `execution=tested` and `negativeControls` is empty while the claim is a
  negative class (throttle, enumeration, uniform error, no-session/cookie absence), record an `admissionWarnings` entry
  "negative claim without a discriminating control" and surface it in case review, the validation brief and the report. A
  warning, not a refusal: the evidence ladder does not change.
- **Validation draft:** `src/validation.ts:validationDraft` gains the original claim's record id and slug, surface/risk, cited
  receipt ids, replay payload reference and hash, a materialize hint (`p2o_lab` read/id), and the mechanism question — "does the
  replay exercise the claimed mechanism, or a short-circuit before it?" — so the replay is semantic, not only byte-identical.
- **Tests:** the no-throttle claim class shows the warning; the validation draft carries the refs and hash; the draft stays
  inside its byte bound.

### A5 — Read surfaces that make the new facts visible

- **Situation line** (`src/situation.ts`): replayable claims, derived edges, validation-current count and unmet needs, all
  bounded names-only counters.
- **Report** (`src/report-export.ts`): the claims table prints the host replay reference; derived relations are labelled where
  chains or paths are shown.
- **Tests:** situation/report render inside their caps with the new counters, and neither says a derived fact is evidence.

## 6. Package B — operator policy baseline: findings that can land

Goal: a black-box run can produce an accepted finding **without** weakening the evidence ladder, by recording intended policy
up front and letting a claim cite it (owner chose B2, not the inferred-acceptance shortcut).

### B1 — Run-start policy artifact

- **Where:** `src/target.ts` start-option parser, `src/campaign.ts` campaign frame, the start preview and the report provenance.
- **What:** `--policy <absolute-path>` (bounded JSON or text, hashed, never shown to models whole) or
  `--policy standard:OWASP-ASVS-L2|standard:OWASP-WSTG|standard:OWASP-Top10` (a named standard, not a blanket permission). The
  campaign frame records `{kind, id, sha256, standard?, bytes}`; the start preview and the report print the source; a run
  without `--policy` behaves exactly as today.
- **Tests:** parse and refuse duplicates/unknown standards; campaign records the hash; no-policy behavior unchanged; the policy
  body never enters a prompt beyond a bounded excerpt.

### B2 — Claim provenance `operator_contract`

- **Where:** `POLICY_BASES` (`src/evidence.ts:17`), `candidate()` validation, the candidate schema description
  (`src/tool-schemas.ts:83`).
- **What:** new basis `operator_contract`, valid only when the claim names `policyRef` (the run's policy artifact id) and the run
  has that policy; a claim under it stays at demonstrated depth and may cite a standard test id in `expectedPolicy`.
  `inferred` rules are untouched; a CVE lead stays `inferred`; no basis makes a claim tested.
- **Teaching:** one worker/planner line naming the policy source and how to cite it; `p2o_wstg_suggest` rows already name test
  ids, so `standard:OWASP-WSTG` maps to the same vocabulary.
- **Tests:** admitted with policyRef; refused without it with a legal next; inferred behavior unchanged; policyRef cannot hide a
  static trace.

### B3 — Acceptance, rating and goal proof

- **Case acceptance** (`src/cases.ts:114`): a confirmed case is acceptable when a cited demonstrated claim has
  `explicit_contract`, `boundary_invariant` or `operator_contract` (with a current policyRef); `inferred` stays refused, so the
  run's two claims would still be observations, not findings, unless the operator supplied policy.
- **Report:** case and finding provenance print the policy source and mark the `INFERRED_POLICY` flag only where the existing
  rating rule applies.
- **Goal proof:** the host hints (and the planner prompt states) that a coverage-plan proof needs a route to a terminal cell
  under the run's policy; with no policy the measurable proof is mapping, so the run cannot author a goal that is blocked by
  construction.
- **Tests:** accepted with operator policy; refused for inferred; goal-proof hint rendered; rating depth unchanged.

## 7. Package C — research breadth, question queue and never-idle

Goal: a run does not finish while known, feasible questions remain, and it plans them without a human wake-up.

### C1 — The brief names the unplanned work

- **Where:** `src/situation.ts` snapshot and the round brief renderer, `src/engine.ts` demand text.
- **What:** the snapshot gains `unplannedAssets` (count + up to three kind/path/feature samples), `wstgUnplanned` (count + three
  test ids), `unmetNeeds` (capability kinds + the claims that need them) and `untriagedGaps` (count + samples). The planner
  prompt says: when any of them is non-zero, the round's work is to revise the coverage plan, plan the question, or record the
  exclusion.
- **Tests:** bounded samples; brief cap measured; a zero-intent round with these counters is recorded as a stall (host already
  records stalled rounds).

### C2 — Per-asset question queue (suggestions, never cells)

- **Where:** `p2o_wstg_suggest` (planner-only read) and the `WSTG_MAP`/asset `feature` attribute.
- **What:** the host derives candidate questions from an asset's recorded `feature` values and the WSTG map (feature → test ids),
  with asset id, test id, one-line expected observation and the plan that would cover it. The planner promotes a question by
  creating a task whose `questionKey` is the test id (the convention P20/D already teaches); cells stay host-derived.
- **Tests:** queue bounded and deduped; a suggestion never satisfies anything; question keys are valid `questionKey` values.

### C3 — Coverage-plan revision and honest quiet

- **Where:** `p2o_coverage_plan` revise path (exists), `src/engine.ts` quiet judgement and demand line, planner prompt.
- **What:** when discovery adds assets the plan does not cover, the demand line names the revision owed and the brief samples the
  assets; the quiet judgement counts new assets/features/questions as progress so "quiet" cannot be declared while 68 unplanned
  assets exist. The plan stays the operator-facing denominator; revision never widens authority.
- **Tests:** quiet false with unplanned assets; demand names the revision; a revision keeps old cells' derivation stable.

### C4 — Settlement before finish

- **Where:** `src/finish-preflight.ts`, the closing loadout, the report's remaining-work section.
- **What:** when obligations remain, the preflight emits a settlement packet naming each debt kind and the disposition required:
  plan a task, record out-of-scope, or defer with a revisit condition and debt refs. The existing incomplete outcome and debt
  rules do not change — this only makes the identified work visible and actionable before the lead stops.
- **Tests:** the packet names the run's kinds; a decision row discharges a kind; finish still reports incomplete; no completion
  loosening.

### C5 — Credential ladder (owner-approved bounds)

- **Where:** worker prompt/shared recording document, planner capability-needs line; no tool change.
- **What:** state the allowed ladder (public JS bundles/source maps/config for committed endpoints or secrets; one named
  default-credential attempt; self-provisioned registration/tenant when a registration path exists; operator-sealed secrets via
  `p2o_secret`), the prohibited moves (brute force, spraying, stuffing, reset abuse, lockout attempts), and the fallback: when
  none works, record the capability need (`needs: cred.secret`) with the acquisition paths tried so C1 can plan the next feasible
  route.
- **Tests:** prompt-text pins for the ladder and the prohibitions; the needs shape unchanged; ceilings re-measured.

### C6 — Chain queue and dispatch batching

- **Where:** situation/brief chain counters (exist), planner dispatch guidance.
- **What:** render the chain frontier (ready/waiting) together with unmet needs so a demonstrated primitive either advances or
  becomes a named capability task; allow and encourage dispatching several independent tasks per round (the host already accepts
  `p2o_task_dispatch` up to 25) instead of one question per round.
- **Tests:** both counters render; a batch dispatch is admitted; no scheduler change beyond guidance.

## 8. Sequence and gates

Order: A1 → A2 → A3 → A4 → A5, then B1 → B2 → B3, then C1 → C2 → C3 → C4 → C5 → C6. A3 may land before A2; B may start once
A1/A2 are measured; C starts only after A and B.

Every tranche:

1. `npx tsc --noEmit`, the targeted vitest files, then the full hermetic suite (`npx vitest run`);
2. `npm run build` and `npm run check:build`; `node scripts/audit-surface.mjs` (registered/model-visible/hidden/board counts and
   contradictions must not move, declarations may not rise past their baselines);
3. `python3 scripts/validate_library.py` when documents change; prompt/brief ceilings re-measured wherever teaching text moves;
4. `git diff --check`, `detect_changes --scope all` before any commit, `git status` audited (never stage the owner's `AGENTS.md`
   edit or `pi-p2o-defense-vi.pptx`);
5. docs rows in the same change: `docs/ACCEPTANCE_MATRIX.md` F-P21-*, `docs/HISTORY.md` row, USAGE/ARCHITECTURE text where the
   model-facing behavior changed;
6. commit and push only on a fresh owner instruction, with the repository identity and no attribution lines.

## 9. Acceptance bars (mechanism, not pentest effectiveness)

- **A:** a tested claim from an http/net operation is replayable with **zero** model `p2o_lab` calls; a validation worker records
  its reproduction with one field and the case's independence becomes current; every anchored endpoint has a derived
  containment path and asserted rows still override; derived facts satisfy nothing.
- **B:** with `--policy`, a confirmed tested claim under `operator_contract` produces an accepted current case and a rating at
  demonstrated depth; without `--policy` the same claim stays refused exactly as today; goal-proof hints stop an
  unprovable-by-construction goal.
- **C:** the brief names unplanned assets, unplanned WSTG tests and unmet needs; quiet cannot be declared while they exist; a
  settlement packet names each debt kind before finish; the credential ladder is bounded by text and pinned by a test.
- Never a claim about real-world effectiveness: no live run in this phase, and the report still says an assessment is not a
  safety statement.

## 10. Non-goals and refusals

- No authority, loadout or tool-count change; no planner target/claim tool; no cell writer; review is not proof.
- No acceptance of inferred-policy confirmed cases (B1 rejected); no lowering of the depth ladder, rating ceiling or evidence
  ladder; no "derived edge proves reach".
- No MITM proxy or traffic interception; the executor records what the tool already received.
- No credential vault or brute-force path; C5 is bounded text plus the existing sealed-secret mechanism.
- No schema mutation of existing rows (additive columns/tables only), no change to export redaction.
- No live or paid run; no benchmark claim.

## 11. Risks

- **Payload capture holds credentials by design.** Mitigation: the private control directory only (0600), never exported,
  removed with the run; receipts and exports keep only the reference/hash; an operator-secret placeholder is stored, never the
  substituted value.
- **Derived edges read as claims.** Mitigation: labelled rows, D-P21-10, tests that graph projections satisfy no claim, case,
  cell or goal.
- **A standard name as a rubber stamp.** Mitigation: the policy artifact is hashed and shown in the report, a standard maps to
  named tests, and `operator_contract` still requires a demonstrated claim at demonstrated depth.
- **Prompt/brief ceilings.** Mitigation: measure every tranche and re-pin only from a fresh measurement; the model union may
  fall, never rise casually.
- **`reproduces` overlapping the legacy field.** Mitigation: one path per attempt, tests pin both, the legacy field stays.
- **Batching raising worker concurrency.** Mitigation: dispatch guidance only; worker and target-operation caps do not move in
  this plan.

## 12. Verification record (to be filled as tranches land)

| Tranche | Date | Commit | Commands and results | Not done / next |
|---|---|---|---|---|
| A1 | 2026-10-29 | `e91e449` | `npx tsc --noEmit` clean; full suite 159 passed / 5 skipped files (164), 1,412 passed / 13 skipped tests (1,425), 0 fail; `npm run build` and `check:build` green; surface audit 35 registered / 35 model-visible / 0 hidden / 10 board verbs, 0 contradictions, planner 44,570/45,500; `git diff --check` clean; GitNexus `detect_changes --scope all` reach critical on the `executeWithReceipt` hub (265 changed symbols, 266 affected) reviewed as behavior-preserving; `replay-capture.test.ts` 9/9 | A2 unblocked (same commit) |
| A2 | 2026-10-29 | `e91e449` | A2 landed in the same phase commit and passed the same gate as A1; `replay-capture.test.ts :: accepts a reproduction with one field…` covers the accepted shape plus four refusals, the legacy no-cross-match fix and `independentReceiptCurrent` | A3 in the same commit |
| A3 | 2026-10-29 | `e91e449` | A3 in the same phase commit and gate; `derived-containment.test.ts` 4/4 green (derived hops, no anchor/no invented host, asserted wins and a revision pin makes the walk stale, export marks DERIVED and counts without evidence) | A4 in the same commit |
| A4 | 2026-10-29 | `e91e449` | A4 in the same phase commit and gate; `negative-control.test.ts` 4/4 green (warning vs quiet, draft within 1500/1000/1000, no-unit wording, report line) | A5 in the same commit |
| A5 | 2026-10-29 | `e91e449` | A5 in the same phase commit and gate; `replay-capture.test.ts :: prints the host replay reference…` green; `ACCEPTANCE_MATRIX` (F-P21-A1..A6), USAGE and ARCHITECTURE updated in the same commit; prompt and declaration ceilings untouched because no prompt text moved | Package B next |
| B1 | 2026-10-29 | `7980a4a` | `--policy <absolute-path|standard:NAME>` parsed once and refused when malformed; file loader bounded 256 KiB, regular file only, exact sha; campaign frame carries `{kind,id,sha256,bytes}` and the preview prints source + digest; body never in confirmation, prompt or report; no-policy run unchanged. `npx tsc --noEmit` clean; full suite 160 passed / 5 skipped files (165), 1,421 passed / 13 skipped tests (1,434), 0 fail (+1 file, +9 tests); build/`check:build` green; surface audit planner 44,705/45,500, worker 40,935/41,400, validation 40,124/40,500, 0 contradictions; `git diff --check` clean; GitNexus `detect_changes --scope all` 69 changed symbols, critical on the case/report hubs reviewed as behavior-preserving; campaign block bound raised 600→1000 with the measured rationale | B2/B3 in same commit |
| B2 | 2026-10-29 | `7980a4a` | `operator_contract` added to POLICY_BASES with `policyRef`; host resolves the id against the campaign frame at write time (`POLICY_UNRECORDED` with legal next when no artifact exists, `POLICY_REFERENCE_UNKNOWN` naming the recorded id on mismatch, refusal when `policyRef` arrives with another basis); `inferred` rules and the evidence ladder untouched; candidate declaration grew but every role stayed under its ceiling | B3 in same commit |
| B3 | 2026-10-29 | `7980a4a` | case acceptance accepts `operator_contract` only while its `policyRef` is the recorded artifact, refuses a stale `policyRef` and an inferred-basis claim; report prints `Operator policy:` in the campaign section and `Operator policy provenance:` beside the case; campaign block states the coverage-proof/mapping rule and the goal-author guidance repeats it | Package C next |
| C1–C6 | — | — | — | — |

## 13. Owner decisions recorded (answered in chat, 2026-10-29)

1. **Scope:** A + B + C.
2. **Evidence stance (B):** B2 — an operator policy baseline (`--policy file|standard`) with `policyBasis=operator_contract`;
   the inferred-acceptance shortcut is rejected.
3. **Sequence:** A → B → C.
4. **Credential ladder (C5):** allowed — public artifacts (JS/source maps/config) plus one documented default-credential
   attempt; no brute force/spray.
5. **This file replaces the P19/P20 plan of record**; the old content stays recoverable in git at `2e22b5c`.
6. Commit, push and any live run remain owner-initiated, one request at a time.

## 14. Evidence and reproduction

- **Run:** `run-42c447d6-cb8a-4c65-85a7-6f4036014ef6`; store `~/tmp/cmp/.p2o-state/<runId>/assessment.sqlite`; report
  `~/tmp/cmp/.p2o-reports/report-<runId>-final/REPORT.md` and `coverage.csv`. The numbers in §0 come from the SQLite tables
  (`records`, `assertions`, `assets`, `relations`, `anchors`, `events`) and the exported report; the refusal texts are open items
  `7f01c8af`, `d084614f`, `7b7a626d`; the policy wall is decision `907b5b37`.
- **ARTEX snapshot:** `~/tmp/ARTEX` at `e6ec569`; the comparison in §3 reads `db/schema.sql`, `agent/tools.go`,
  `db/finding_traffic.go`, `db/task_scope.go`, `agent/planner.go`, `agent/wrapup.go`, `agent/retester.go`,
  `traffic/traffic.go`, `evidence/store.go`.
- **Previous plan:** `git show 2e22b5c:planning_update.md` (P19/P20 plan of record plus the verification record and owner
  decisions D-P19-*, D-P20-*).
