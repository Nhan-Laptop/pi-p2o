# Attack-chain capability — status and the next layer (plan of record, 2026-11-02)

## 0. Executive summary

Both prior planning documents are now closed by code, not just by proposal. `planning_update.md`'s own P25 plan
(G1–G7: derive and read one canonical attack chain) shipped as `95eae50`/`07480f4`/`076ae6c`/`2639d7f`/`6b17cad`.
`planning_update_version_2.md`'s eight substrate workstreams (F1–F8: the data feeding those chains) shipped as
`ffff2a5`/`4db457b`+`a4ed37c`/`10231c0`/`97b3081`+`10cafe8`/`af20cbd`/`d5717a9`/`eb47571` — every one tagged to its
workstream id in the commit message. §1 records this compactly; full acceptance detail (test counts, declaration
sizes, `detect_changes` stats) for each commit already lives in `docs/HISTORY.md` and is not re-copied here.

This document retires `planning_update_version_2.md` (its substance is folded into §1 below; the file itself is
deleted after this write, since it was never committed and losing it silently would be a real loss) and extends the
comparison one layer up: **the skills/prompts layer that tells an agent what to look for and how to chain it — never
compared against ARTEX by either prior document.** Both of those were data-model comparisons; neither cites a single
`skills/*.md` file or ARTEX's prompt catalog.

The headline result reframes the question. pi-p2o's skills already cover, ahead of ARTEX, every one of the eight
vulnerability classes the closed capability taxonomy can't type (IDOR, race conditions, JWT algorithm confusion,
XXE, SSRF-only pivots, CSRF, crypto weaknesses, business-logic flaws) — each has its own dedicated skill with real
method; ARTEX's prompt catalog names none of them. **Detection guidance is not the bottleneck.** The bottleneck is
narrower: a finding an agent already found and wrote up correctly still can't automatically *join a chain* unless
its free text happens to classify into one of the 15 existing capability kinds (`af20cbd`'s bridge). Separately, one
categorical gap is confirmed absent at *every* layer checked this session — skills, extractors, and ARTEX itself:
IaC/cloud-config and container-image coverage. §3–§4 turn both into scoped proposals, pending owner choice like
every workstream before them.

## 1. Status: the 2026-10-31 plans, now closed

| Item | Closed by | Outcome |
|---|---|---|
| G1–G7 — chain order not derivable from the graph | `95eae50`, `07480f4`, `076ae6c`, `2639d7f`, `6b17cad` (P25/1–4) | canonical `AttackChain` (`src/attack-chain.ts`), `leads_to` relation, graph-derived successor synthesis, chain survives a run boundary (F-lite) |
| F3 — untyped severity on auto-ingested leads | `ffff2a5` (W-A) | typed severity/CVE/CWE signal (`SeverityHint`), used as a chain-ranking tie-break |
| F4 — silent truncation inside synthesis | `4db457b`, `a4ed37c` (W-B) | `walk.truncated` rolled up into a synthesis-level health summary; surfaced in candidate `why` text |
| F5 — fixed reachability ceiling | `10231c0` (W-C) | `pathCeilings(graphCapacity)` — base 6/500, scales to 10/1000 on engagement opt-in, no longer a bare literal |
| F6 — SBOM/lockfile breadth | `97b3081` (W-D, Option A only) | poetry.lock/Pipfile.lock/composer.lock added to `packages.ts` |
| F6 — SPA route discovery (static bundles) | `10cafe8` (W-E) | `http-response.ts` auto-fetches and mines same-origin script bundles |
| F7 — positional overflow drop | `d5717a9` (W-G) | extraction cap now tail-drops by severity, not scan position |
| F8 — evidence-ladder rigor | `eb47571` (W-H) | cited evidence cross-checked against claimed reach before crediting impact |
| F1 — closed taxonomy vs. free-text findings | `af20cbd` (W-F) | `classifyLegacyKind()` bridges free text into one of 15 kinds for chain-*matching* only, when exactly one kind matches — **partial**: `CAPABILITY_KINDS` itself is unchanged; see H1 below |

**Still open from 2026-10-31, unchanged:** F6's IaC/cloud-config/container/SAST half (W-D's Option B was never
built) — flagged then as "the single biggest scope item," confirmed still fully absent this session at every layer
checked. Carried forward as H2/W-J below.

**Still deferred, unchanged:** P25 Phase 5 (live C3/C4 measurement) never ran — it needs a fresh owner instruction
under the C1 validity clause regardless of anything in this document. See §6 for the carried authorization detail
and runbook pointer.

Full per-commit acceptance detail (test counts, surface/declaration sizes, `detect_changes` stats) for everything in
this table: `docs/HISTORY.md`, `docs/ACCEPTANCE_MATRIX.md`, and `git show <hash>`. Not duplicated here.

## 2. New reference model: skills/prompts vs. ARTEX's prompt catalog (2026-11-02)

### 2.1 Vulnerability-class / gap coverage

| Item | pi-p2o | ARTEX |
|---|---|---|
| IDOR | dedicated `skills/web-object-authorization/SKILL.md` (principal/object/tenant/field access, baseline, bounded comparison, controls) | absent |
| Race conditions | dedicated `skills/race-condition-auditing/SKILL.md` (TOCTOU/double-fetch/lock-drop) | one bare word in a non-exhaustive recon checklist (`promptcatalog.go:45`), no method |
| JWT algorithm confusion | `skills/web-token-and-federation/SKILL.md:27` — change declared algorithm/signature bytes/claim, observe acceptance | absent |
| XXE | named explicitly, `skills/web-injection-to-exec/SKILL.md:3` | absent |
| SSRF-only pivots | dedicated `skills/ssrf-to-internal/SKILL.md` + probe script | absent (no written methodology) |
| CSRF | routed explicitly to `skills/web-browser-trust-controls/SKILL.md` | absent |
| Crypto weaknesses | dedicated `skills/web-crypto-usage-review/SKILL.md`, WSTG-mapped | absent |
| Business-logic flaws | dedicated `skills/web-business-logic-misuse/SKILL.md` | absent (no dedicated text) |
| SAST (tool ingestion) | no extractor ingests third-party SAST output | zero SAST/taint hits repo-wide (confirmed 2026-10-31) — **parity-neither** |
| SAST (manual-equivalent depth) | `skills/source-code-auditing`, `skills/data-flow-analysis`, and `attack-surface-mapping`'s explicit recon→static-analysis handoff | no equivalent — **p2o ahead** |
| IaC/cloud-config | zero hits anywhere; `web-deployment-hygiene` is explicitly HTTP-visible-only, not Terraform/CloudFormation/K8s | no evidence of coverage — **parity-gap, open both sides** |
| Container-image | zero hits | zero hits — **parity-neither** |
| SPA route discovery (live) | `skills/web-route-input-inventory/SKILL.md:11,28` drives a live browser to render client-side routes — reaches fully-dynamic/XHR SPAs the static-bundle extractor fix (`10cafe8`) cannot | absent |

### 2.2 Chain-pursuit doctrine: enforced vs. narrative

ARTEX's chain-pursuit guidance is richer than the 2026-10-31 research credited it with — that research sampled only
`agent/planner.go:333`'s one TodoWrite line. The fuller read of `agent/promptcatalog.go`'s `pentestDefaultTmpl`
(lines 36–64) found a real six-point doctrine: breadth before depth (run 2–3 mechanically-different routes in
parallel, don't tunnel-vision); one blocked payload is never "exhausted" — vary encoding/method/parameter first;
don't reopen a blocked route without a materially new mechanism; re-verify adversarially via an independent path
before calling anything confirmed; don't give up — cycle back to the route portfolio; and an explicit line naming
cross-codebase/cross-interface chaining as the single agent's core strength.

pi-p2o's structural equivalents in `src/prompts.ts` are substantively similar — chain is its own task type with
refusal codes (`CHAIN_LINK_REQUIRED`, "CHAIN OR WALL"), a near-identical retry rule ("a wall is a refusal or an
exhausted family, never one failed payload: enumerate variants... before retrying"), and an adversarial-recheck rule
("recheck it once by another mechanism") backed by the evidence-ladder machinery §2 of the now-deleted
`planning_update_version_2.md` already showed ahead of ARTEX. **The difference is enforcement, not content:**
ARTEX's entire doctrine is unenforceable prose in one hardcoded Go string; p2o's chain/retry/recheck rules are
host-enforced (dispatch refusal, typed wall states), not just stated. One possible gap, low confidence: no found
p2o prompt text mirrors ARTEX's explicit "parallel breadth across mechanically-different surfaces" instruction —
p2o's lead/worker parallel-dispatch architecture may already produce this structurally; unconfirmed. See H3/W-K.

## 3. New invariants

1. **H1 — skills find what the taxonomy can't type, but still can't chain it. Refined 2026-11-02 (investigation for
   W-I): the gap is narrower and less uniform than first scoped.** `LEGACY_KIND_WORDS` (`src/capabilities.ts`)
   already classifies 3 of F1's 8 named classes by name today: `\bidor\b` → `data.read`, `\bssrf\b` → `net.egress`,
   `\bjwt\b` (generic) → `cred.session` — IDOR and SSRF work because the vulnerability name and its effect are
   nearly tautological. The remaining five split unevenly: **XXE** is usually already bridgeable if the finding
   text names its real effect (file disclosure, SSRF) rather than just "XXE". **CSRF** has a plausible but unbuilt
   safe mapping — its mechanism is arguably `auth.bypass` by nature (acting as another user without a valid
   authorization check), but the existing `auth.bypass` pattern is worded around missing authentication, not forged
   requests, so it doesn't fire without a new, narrow pattern. **Race conditions, crypto weaknesses and
   business-logic flaws have no safe mapping at all**: their actual effect varies per instance (a race condition's
   effect might be a duplicated transaction or a corrupted balance — not `file.read`/`cred.secret`/anything else in
   the 15-kind vocabulary), so a bare category-label keyword would guess one kind and silently mischain a real
   fraction of findings — the exact false-positive-join risk Option B was already flagged with. These three need
   either a genuinely new kind (Option A) or to stay visibility-only (Option C); a blanket Option B pass across all
   five does not hold up. **Implemented 2026-11-02 (W-I/Option A, working tree, uncommitted):** added `data.write` to
   `CAPABILITY_KINDS` — the symmetric write-side counterpart of the existing `data.read` (itself added for IDOR),
   covering IDOR-write, mass assignment and parameter tampering, mapped to the existing `integrity-write` effect
   (no new `CaseEffect` needed). Deliberately does *not* add kinds literally named after race conditions or business
   logic — those remain Option C (visibility-only) per H1's own finding that their effect varies too much per
   instance for a safe single mapping. Real value independent of any `needs` match: `src/obligations.ts:81` already
   filters chain-debt tracking (`PRIMITIVE_UNCHAINED`) to typed capabilities only, so this alone makes such findings
   visible to debt-tracking for the first time, regardless of whether anything downstream lists `data.write` as a
   `needs`.
2. **H2 — IaC/cloud-config/container-image coverage is absent at every layer checked.** Not just the extractor
   registry (confirmed unchanged, F6): the skill layer has nothing either (`web-deployment-hygiene` is HTTP-only),
   and ARTEX has nothing. This is the one item in this whole document that is a genuine, unclaimed advance over both
   systems rather than a catch-up — and, per the 2026-10-31 effort table, still the largest single lift here.
   **Partially closed 2026-11-02 (W-J, working tree, uncommitted): the extractor half of the gap is closed** —
   `src/extract/checkov.ts` now ingests checkov's declared-configuration findings the same evidence-ladder way
   `nuclei.ts` ingests scanner findings (open hypotheses, never a claim). **The skill half stays open, not by choice
   of scope but by a hard constraint found this session: the skill-library validator
   (`scripts/validate_library.py`) requires every candidate skill kind to cite a real, already-vetted external
   source from one of two closed provenance corpora, and neither covers IaC/cloud-config.** Owner deferred the
   skill rather than manufacture a citation or force-fit it elsewhere; see W-J for the options and why each was or
   wasn't taken.
3. **H3 — CLOSED by audit, 2026-11-02 (W-K/Option A): not a gap.** `src/prompts.ts:186`'s `DEPTH OVER BREADTH` line
   is a documented, deliberate adaptation of ARTEX itself (`// A6.4 (translated from ARTEX agent/planner.go:304-331)`)
   from a prior phase — a different ARTEX file than the `promptcatalog.go` pentest template §2.2 compared against,
   and not in conflict with it: ARTEX's pentest-template doctrine is about not over-committing to one *unproven*
   lead among several; p2o's rule is about not abandoning an already-*proven* primitive for a new, unproven asset.
   p2o additionally has `prompts.ts:190` MECHANISM FAMILIES (keep 2–3 vulnerability-mechanism families open; forced
   to diversify once one exhausts) and `prompts.ts:187` BREADTH BEFORE IDLE (a round with unplanned assets,
   uncovered WSTG questions or untriaged gaps must advance one, not stall) — three structured breadth rules where
   the 2026-11-02 comparison expected zero. The host-enforced half (`prompts.ts:192-193`, "refuses a breadth task
   that ignores a ready step or unconsumed primitive") matches the already-confirmed `CHAIN_LINK_REQUIRED` refusal
   (`extensions/p2o/index.ts:3188`). No prompt change follows from this; see W-K.

## 4. Design proposals

Options are offered for the owner to choose between, not as a recommended default — trade-offs only, same
discipline as the now-closed W-A–W-H.

**W-I — Make found-but-untyped findings chain-joinable (addressed H1). DONE, 2026-11-02, working tree (uncommitted).**
- *Option A — done, narrowed by investigation:* rather than a kind named after a vulnerability class (which the
  pre-implementation check found would need wiring across `effects.ts`/`research.ts`/`routes.ts` per kind regardless
  of naming), added exactly one new kind, `data.write`, chosen for taxonomic symmetry with the already-existing
  `data.read` rather than for any single vulnerability name. Wired into every real consumer found by text search
  (GitNexus's own `impact` call returned `risk: UNKNOWN`/0 callers for the closed-enum const, as expected for a
  `Record<CapabilityKind,...>`-style consumer — confirmed safe by reading each one directly): `effects.ts`'s
  `DERIVED_EFFECTS` (tsc-enforced exhaustiveness) → `integrity-write`; `research.ts`'s `TRANSITION_SKILLS`
  (test-enforced exhaustiveness, `research.test.ts:85`, that a first grep for `CapabilityKind` missed entirely since
  it's typed as generic `Record<string,string>`) → `web-object-authorization`; `routes.ts`'s `PLAUSIBLE` (no test,
  added for consistency) → `business-logic`; `capabilities.ts`'s `classifyLegacyKind` gained one narrow pattern
  (`mass assignment|parameter tampering`, deliberately not a bare "business logic" trigger — see H1); `docs/
  EVIDENCE.md`'s kind list. `ladder.ts`/`wstg-map.ts`, named in the original proposal, turned out not to key off
  `CapabilityKind` at all — confirmed by text search, not assumed.
- *Option B — not pursued:* superseded by Option A's outcome; the keyword-table-only path was the weaker option per
  H1's own finding (effect-heterogeneity risk) for everything except the one pattern Option A already added.
- *Option C — not needed for `data.write`'s covered cases:* race conditions and business-logic flaws without a
  `mass assignment`/`parameter tampering` phrasing remain visibility-only by default (no round-brief surfacing was
  built this round; `classifyLegacyKind` already returns `undefined` for them, which is the safe, intended outcome).
- **Verification:** `npx tsc --noEmit` clean; targeted `vitest run` on `capabilities.test.ts` (new: a decline test
  for naming both the read-side and write-side keyword together), `effects.test.ts`, `research.test.ts`,
  `chain-view.test.ts`, `completion.test.ts` — 5 files, 45 tests, 0 failures. GitNexus `detect_changes({scope:
  'staged'})` after a required index refresh (it was stale, producing a 23K-line unusable dump before the refresh —
  not a signal about this change): 7 changed symbols, exactly the ones touched, `risk: low`, `affected_count: 0`, no
  `partial`/`truncated`.

**W-J — Close the IaC/cloud-config/container gap (addresses H2; W-D's Option B, now confirmed open at every layer).
PARTIALLY DONE, 2026-11-02 — extractor shipped (working tree, uncommitted); skill deferred, blocked on provenance.**
- *Option A — extractor half done, the taxonomy half turned out unnecessary:* built `src/extract/checkov.ts`,
  scoped to checkov's real JSON output (`results.failed_checks[]`: `check_id`, `check_name`, `check_result.result`,
  `file_path`, `resource`, optional `guideline` — confirmed against checkov's actual schema via WebSearch before
  writing any code, not assumed from memory, per the Prior-art discipline). One `config`-kind asset per declared
  resource (deduped by resource identity), one open hypothesis per failed check phrased "declared-configuration
  signal, not a demonstrated effect" (the same evidence-ladder convention `nuclei.ts` uses for scanner matches),
  the remediation `guideline` URL carried on `impact` when a row has one, no `SeverityHint` (checkov offers no
  CVE/CWE/CVSS — left absent, not invented). No new capability kind needed: `extract/types.ts`'s own design already
  settles this (scanner/config output is attributed-but-unverified, the same grade as any model-recorded row, so it
  can never become a capability directly) — confirmed before writing the extractor, not after. Registered in
  `EXTRACTORS` between `nuclei` and `httpx`; a signature-collision check plus the passing test suite confirm it
  cannot shadow `openapi`/`nmap`/`nuclei`/`packages` detection of their own fixtures.
- *Option A's predicted con, confirmed real:* "no skill yet tells an agent how to use a misconfiguration finding
  once ingested" was scored as a known con before the skill was attempted. It held — see below.
- *Option B — attempted, found blocked, not actually "cheapest" as first scored:* `scripts/validate_library.py`
  (run against the real repo by `tests/test_library.py`, part of `npm test`'s research-library stage) requires a
  `technique`-kind skill to cite 3 or more entries from a closed 81-post starlabs.sg blog corpus
  (`research/corpus.json`), and a `playbook`/`overlay`-kind skill to cite an already-credited entry in
  `SKILL_PROVENANCE.json`/`WSTG_PROVENANCE.json`; `procedure` is the wrong shape entirely (capability-chaining
  ladders, count pinned to exactly 8 by design). Neither corpus covers IaC/cloud-config. A same-ceiling workaround
  — folding IaC cards into `web-deployment-hygiene` instead of a new skill, reusing its existing WSTG grounding —
  was also checked and rejected: that file is at 7,890 of its 8,000-character ceiling, so it needs real trimming,
  not a free append, and the new content would carry no WSTG id like the rest of that file. Owner chose to defer
  rather than manufacture a citation, force an ill-fitting kind, or trim WSTG-pinned content under time pressure.
- *Option C — not pursued:* the original con ("largest lift... first static/config source class") stands, and now
  compounds with the skill-provenance finding — bundling the skill into the same workstream would not have avoided
  the block above.
- **Verification (extractor only):** `npx tsc --noEmit` clean. `vitest run tests/minimal/extract.test.ts` — 23/23
  (2 new: dedup/skip/warning behavior on malformed and suppressed rows, and remediation-guidance/no-invented-
  severity). GitNexus `impact("checkov", direction: upstream)` read `risk: CRITICAL`/546 impacted in isolation;
  compared directly against `impact("nuclei", ...)` on the same direction as a same-shape baseline, which reports
  the identical 546/CRITICAL profile for already-shipped code — the number reflects every extractor's shared
  position on the widely-called `extract()` dispatch path, not a defect introduced here.
- **Follow-up, not scoped now:** legitimately unblocking the skill needs real new source research (CIS Benchmarks,
  checkov's own rule catalog, or similar) registered into one of the two provenance corpora first — a separate,
  larger task than writing one `SKILL.md`.

**W-K — Confirm or close the parallel-breadth doctrine question (addressed H3). CLOSED, 2026-11-02, audit only —
no code or prompt change.**
- *Option A — done:* audited the lead's actual prompt/dispatch guidance (`src/prompts.ts`) instead of assuming.
  Found three existing breadth rules (`DEPTH OVER BREADTH`, `MECHANISM FAMILIES`, `BREADTH BEFORE IDLE`; see H3),
  one of them already a documented adaptation of ARTEX's own `agent/planner.go:304-331` from an earlier phase
  (`A6.4`) — a different ARTEX file than the one §2.2's comparison read. Result: the question is answered, not
  left open; no capability change needed.
- *Option B — moot:* porting ARTEX's `promptcatalog.go` wording in verbatim would have duplicated/contradicted the
  already-existing, already-ARTEX-derived `DEPTH OVER BREADTH` tie-break. Not done, and should not be done without
  a specific new gap to justify spending the tight prompt-length budget.
- *Option C — superseded:* the audit itself resolved the question; there is nothing left to wait on.

## 5. Priority and effort, for the owner's call (not a decision)

| Workstream | Addresses | Impact | Relative effort | Sequencing |
|---|---|---|---|---|
| W-K parallel-breadth audit | H3 | **DONE, 2026-11-02** — audit only, no code/prompt change; p2o already has three breadth rules, no gap found | Low (Option A) | Closed — see §3 H3 / §4 |
| W-I taxonomy/chain-join fix | H1 | **DONE, 2026-11-02** — `data.write` kind added, wired, tested; see §3 H1 / §4 | Low (narrowed from Medium by investigation) | Closed |
| W-J IaC/cloud/container | H2 | **PARTIALLY DONE, 2026-11-02** — extractor shipped and tested; skill blocked on the skill-library's closed provenance corpora, deferred by owner choice; see §3 H2 / §4 | Highest (skill half, if ever unblocked) | Extractor closed; skill needs new corpus research first — not scoped here |

## 6. Non-goals this round

- No code changes or commits in this document — proposals only, pending owner review, same discipline as every
  workstream closed in §1.
- No re-run or re-measurement of anything live; no Phase-5-style campaign proposed here.
- Supersedes and retires `planning_update_version_2.md` (2026-10-31) — its F1–F8 substance is folded into §1 above
  (all closed except F6's IaC/cloud half, carried forward as H2/W-J); the file is deleted after this write.
- Does not re-litigate anything already closed in §1 — those are status facts, not proposals.
- Does not restart or re-authorize P25 Phase 5 (live C3/C4 measurement) — it stays deferred pending its own fresh
  owner instruction, independent of whether W-I/W-J/W-K are chosen.

## 7. Carried operational facts (unchanged; full detail in this file's pre-2026-11-02 git history)

- **Practice model:** `opencode-go/deepseek-v4.1-flash` only; a usage limit is a stop-and-wait, not a provider
  change. Never the owner's codex proxy providers.
- **Commit/push discipline:** no commit and no push without a fresh instruction; each phase's commit waits for its
  own instruction; no AI attribution; repository identity `Nhom 03 <nguyentrongnhan06cm@gmail.com>`.
- **Owner files never staged:** `AGENTS.md`, `pi-p2o-defense-vi.pptx`, `.transcribe_tmp/`.
- **Live-run authorization (P25 Phase 5, still deferred):** the only target this project has ever authorized for a
  live run is `https://ise.uit.edu.vn/`, under the C1 validity clause (default ladder minus `availability-loss`),
  and only on a **fresh** owner instruction each time — prior authorization does not carry over, and no other host
  is authorized under any phrasing. The last recorded runbook used these exact `--avoid` prohibitions: no
  destructive or availability-impacting action; no persistence, no anti-forensics, no evasion beyond minimal proof;
  no bulk user-data access or exfiltration — minimal proof only; no credential theft beyond an owner-designated test
  account; no lateral movement off `ise.uit.edu.vn`. Full command template, worker/round-step counts, and the C3/C4
  observable checklist: this file's git history (`git log -- planning_update.md`), section "13. Runbook," as of the
  2026-10-31 revision.

## 8. Records

- **This session's basis:** git log (commit hashes cited in §1); direct reads of `src/capabilities.ts`,
  `src/attack-chain.ts`, `src/state/store.ts`, `src/extract/index.ts`, `src/extract/openapi.ts`; a forked analysis
  reading all `skills/*/SKILL.md` (38 files) and `src/prompts.ts` against `~/artex/ARTEX` @ `e6ec569`'s
  `agent/promptcatalog.go` (`pentestDefaultTmpl`), `agent/planner.go:333`, and `agent/worker.go` in full.
- **Superseded and folded in here:** the pre-2026-11-02 revision of this file (P25 plan of record, 2026-10-31 —
  recoverable via `git log -- planning_update.md`) and `planning_update_version_2.md` (2026-10-31, substrate gap
  analysis — never committed, folded into §1/§2 above, deleted immediately after this write).
- **Earlier evidence this document does not re-copy:** the ARTEX chain-order deep dive (`e6ec569`), P24/A–E commit
  history, and the full P25/1–4 acceptance record — all in `docs/HISTORY.md`, `docs/ACCEPTANCE_MATRIX.md`, and
  `git show <hash>` for each commit named in §1.
