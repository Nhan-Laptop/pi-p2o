# Attack-chain, evidence and security — audit findings and the next plan (plan of record v2, 2026-11-02)

This revision replaces the 2026-11-02 plan of record in full. It is audit-derived: four read-only review passes
(chain/evidence integrity, discovery/exploitation breadth, ARTEX comparison, p2o's own security) plus the lead's own
re-read of every decisive code path. **No code has been changed, no test has been run for this revision, and nothing
here is committed.** Every proposal is an option for the owner to choose between, in the same discipline as v1: the
document records findings and choices, not decisions the agent can take on its own.

Continuity: the v1 narrative (prior layers H1–H8, workstreams W-A–W-O, the execution-layer comparison, the pivot
decision record) is superseded but not destroyed — the committed v1 is recoverable with `git log -- planning_update.md`
and `git show 6a2ccf5:planning_update.md`; the uncommitted v1 additions (§2.3 delegation/steering, invariant **H8**,
proposal **W-P**) are carried forward into §4 and §6.4 here. A byte-copy of the pre-replacement working tree is at
`/tmp/planning_update.pre-v2.20261102-181542.md` (outside the repository).

Confidence labels used throughout: **C** — confirmed by direct code read (by the lead or by an audit pass and then
spot-checked by the lead); **I** — inferred from code structure but not proven by a run; **U** — unknown, needs a live
measurement. Claims about ARTEX are source-snapshot claims only: the snapshot has no run transcripts, so no ARTEX
capability here is a measured result.

## 0. Executive summary

1. **The chain model is still p2o's strongest asset, and it is not what needs the most work.** v1's conclusion holds:
   the typed capability graph, the readiness board, the rating ceiling at demonstrated depth and the deterministic
   report are ahead of what ARTEX and Strix do. What the audit found is that the model's *inputs and exits* are weaker
   than its structure: the rating reads a model-chosen effect, the ladder headline counts unaccepted cases, and the
   dispatch gate has a second entry path that skips it.
2. **p2o's measured exploitation output is thin.** Across the recorded live runs, no run has yet produced an accepted
   case with an executed chain step in exploit mode; the latest measured runs are 0 accepted / 0 executed chain effects
   (§1.3). The one clean-looking bench data point is from a campaign the repo itself declares contaminated. This is a
   capability-honesty problem first, and only then an engine problem.
3. **One HIGH security finding breaks the host boundary.** The host-side citation fetcher checks a resolved address and
   then fetches by hostname (fresh resolution), and the same pattern repeats per redirect — a DNS-rebinding SSRF that can
   read cloud metadata or local admin services from the operator's host, reachable automatically from target HTML through
   the bundle auto-fetch path (§4.1, P2O-01). **Closed by W-Q (committed `5e86666`, 2026-11-02, §5.1): the connection is
   now pinned to the address the destination check admitted, every redirect re-pins, and four hermetic tests pin the
   property.**
4. **Authority and secret handling have lifetime/edge-path gaps.** A worker that reports "with hold" keeps full target
   authority until a successor brief arrives (P2O-02); validation's `open`-only session rule is bypassed by
   session-bound shell/PTY (P2O-03); a sealed secret can leak through the error text of a substituted URL (P2O-04); the
   pivot's reverse relay accepts any lab-network peer (P2O-05).
5. **Discovery is model-authored, not engine-driven.** Extractors are pure parsers of retained bytes; there is no crawl,
   parameter discovery, wordlist, HAR module or traffic index. That is why only three vulnerability classes are
   end-to-end reachable today — path traversal/LFI, object/field authorization, and browser XSS/CSRF/CORS — while
   blind/out-of-band classes are operator-gated by default (§4.3).
6. **The report's headline numbers can over-state.** The rating's effect class is free model input bounded by itself;
   the four non-`AV` reach metrics are used verbatim; `crossed` is awarded from a free-text `scope`; the ladder takes the
   maximum over all cases and all steps, accepted or not (§4.2, F1–F4). These are cheap, contained fixes and should
   precede any capability work.
7. **Recommended order:** security cluster first (W-Q, then W-R/W-S/W-T), then the rating/ladder/chain truth cluster
   (W-U/W-V/W-W), then a hermetic measurement baseline plus the still-deferred live chain-effect run (W-X), then traffic
   evidence (W-Y), then discovery mechanics (W-Z), then retest independence and pivot-in-chain (W-AA/W-AB). Rationale and
   dependencies in §7.
8. **What would change this plan:** an owner decision to prioritize exploitation throughput over evidence quality, or a
   live/paid measurement authorization that makes W-X concrete; both are explicit questions in §9.

## 1. Evidence base and confidence

### 1.1 The four audits (read-only, no target traffic, no files modified)

| Pass | Scope | Main output |
|---|---|---|
| Chain/evidence integrity | `src/attack-chain.ts`, `chain-view.ts`, `chain-board.ts`, `ladder.ts`, `claims.ts`, `cases.ts`, `case-types.ts`, `cvss.ts`, `effects.ts`, `obligations.ts`, `report-export.ts`, `finish-preflight.ts`, `completion.ts`, prompts chain text | 15 findings F1–F15, 10 strengths to protect, 15 untested gaps (§4.2) |
| Discovery/exploitation breadth | extractors, `wstg-map.ts`, `cve.ts`, `research.ts`, `coverage.ts`, skills/catalog, bench fixtures/protocol | capability matrix by vuln class; only 3 classes end-to-end; discovery-mechanics and blind-proof gaps (§4.3) |
| ARTEX comparison | `my_references/ARTEX` Go source (`agent/`, `db/schema.sql`, `traffic/`, `intercept/`, `guard/`, `enrich/`, `report/`, `skills/`) against p2o source | what to copy and what not to; ARTEX's own proof/scope weaknesses (§4.4) |
| p2o security | broker/authority, hidden surfaces (`tunnel.ts`, `foothold.ts`, `research-fetch.ts`, `policy.ts`), secret handling, evidence/report integrity | 10 findings P2O-01–P2O-10 with 13 explicit false alarms (§4.1) |

### 1.2 What the lead re-verified personally (C)

Re-read and confirmed: the research-fetch check-then-fetch structure and per-redirect repeat; the held-report wiring
(`broker.ts:577-604` + `prepareCommand` refusing only stopped/reporting, plus `assertNotHeld` being the *operator* hold,
`index.ts:1444`); foothold-send using raw text while auditing the substituted text; the rating path (`cvss.ts:81-91`,
`cases.ts:244-251`), the ladder's max-over-everything derivation, `rate()` not checking currentness, `chainLinkGap`'s
per-claim matching, the held-continuation dispatch bypass, the `executedSlugs` merge, plan-step `gained` without
`isDemonstrated`, the M4 discharge rule, the report chain-row truncation, the `blocked` wall rule, extractor purity, and
the bench `ab-rows.json` aggregates. Findings carried from an audit without a second lead read are labelled
"audit-C"; inferred consequences are labelled **I**.

### 1.3 Measured facts used by this document

- **Live runs (from `docs/ACCEPTANCE_MATRIX.md`, the repo's own records):**
  `run-06fde84d` — 1 h 46 min, 6 rounds, 335 records / 1,072 events, 74 worker target operations, 6 tasks, 9 worker
  claims, coverage plan closed 8/8 cells, 67 unplanned assets, 45 open gaps, 4 cases pending, **0 accepted, 0 chain
  rows**, report debt `PRIMITIVE_UNCHAINED 4` + `RESEARCH_DEBT 52` + `GRAPH_UNREVIEWED 1`.
  `run-38e983c0` — chain activation reached (link authored from a demonstrated primitive, successor dispatched 30 ms
  later), **0 executed effects**, blocked by provider usage limit.
  `run-11badbea` — 9 rounds, 377 records / 1,288 events, 2 plan chains / 2 links, **0 accepted cases, 0 executed
  effects**, goal settled blocked.
  `run-51d84fce` — evaluated the stale-ctx crash fixed by `7910e10` (4 rounds, resume then provider 402); not a chain
  measurement.
  A separate `run-615f7a9a` is recorded as one accepted Low finding (audit-reported; not re-verified by the lead).
- **Bench (contaminated; `bench/README.md` §"Historical contamination caveat"):** 32 runs from 2026-10-10
  (`bench/results/w-phase-20261010/ab-rows.json`, lead-aggregated): arm A (baseline revision) n=16, mean recall 0.67,
  precision 0.60, 11 false positives, 2 overclaims; arm C (improved runtime + playbooks) n=16, mean recall 0.73,
  precision 0.65, 9 false positives, 1 overclaim. Costs ≈ $0.66 vs $1.13 per 16 runs. **Not quality evidence**: the
  repo records a `.pyc` leak of the `fixed` variant in those campaigns, and P18's clean 24-run protocol is
  "ready, not run".
- **Surface economics (audited this session):** 38 skills, 21 technique-corpus documents, 8 extractors, 12 asset kinds /
  16 relation kinds, 35 model-visible tools (23 planner / 20 worker / 19 validation / 6 reporting), 10 board verbs,
  0 contradictions. Declaration ceilings are nearly saturated: planner 45,577/45,600, worker 42,932/43,000, validation
  42,121/42,200, reporting 6,300/6,500; planner prompt 17,084/17,600 (recorded measurement).
- **WSTG map (audit-reported):** 108 tests mapped, 102 discovery / 2 test / 4 out-of-scope; 82 owner rows name a
  reference card.

### 1.4 Limits

No live target traffic, no paid model call and no Docker run were made for this revision. ARTEX has no measured result
at all in its snapshot. The live-run numbers above are the repo's historical measurements, not a fresh experiment; they
are cited as the only recorded evidence of chain-layer behaviour, not as a benchmark. The security findings are static
review; P2O-01 can be demonstrated hermetically with a lookup/fetch disagreement test, but a live rebinding PoC needs a
DNS the reviewer controls.

## 2. What is already working — do not break

1. **Host-derived state.** Coverage cells, chain readiness, independence, completion obligations and the report are
   derived from committed records on every read; a model cannot write a cell or a rung. Keep this invariant when adding
   anything in this document.
2. **Receipts are the evidence ceiling, and replay units are host-captured at the dispatch seam** (`src/replay.ts:1-25`):
   request-side bytes and the environment fingerprint are recorded before substitution; a claim that cites a receipt
   cannot cite another run's.
3. **The rating is capped by demonstrated depth.** `demonstratedThrough` requires a claim ref on every step up to depth,
   `rate()` re-checks each is confirmed+tested (`cases.ts:245-246`), and severity cannot exceed the chain impact's
   severity (`cases.ts:249-251`). The gap is the effect class used inside that cap (F1), not the cap itself.
4. **One demonstrated definition, one slug vocabulary.** `isDemonstrated` lives in `claims.ts` with a test that greps
   for re-spelled literals; plan/task/case/chain citation resolve through the same slug across superseded record ids.
5. **The report never calls a plan link executed.** The executed set comes only from accepted + rating-current cases;
   plan-only links print "not executed — plan record only" (`report-export.ts:501-556`).
6. **Chain synthesis and briefs are bounded and deterministic**: caps with honest `OMITTED`/footer counters, byte-bounded
   rendering, and a successor brief that names CHAIN / CHAIN PATH / NEXT LINK.
7. **The evidence ladder's hard boundary:** scanner output and CVE leads are never claims; a lead cannot confirm a claim;
   `ruled_out` needs a control; a second negative needs new evidence or a different mechanism.
8. **Execution surface is wide and honest**: root sandbox with raw sockets, unfiltered egress, headless Chromium +
   `agent-browser` in the image, session/foothold/pivot, and a `truth.ts` layer that states each capability exactly once.
   Do not narrow these to make a gate easier.

## 3. Findings inventory

### 3.1 Security findings (P2O-01 … P2O-10)

| ID | Finding | Severity | Conf. | Evidence | Workstream |
|---|---|---|---|---|---|
| P2O-01 | Host-side citation fetch is DNS-rebindable: the address check and the fetch are separate resolutions, repeated per redirect; reachable by every worker via `p2o_research action=fetch` and automatically from target HTML via `autoFetchBundles` | **HIGH** | C | `src/research-fetch.ts:124-137` (check), `:198-208` (fetch by hostname), `:213-217` (redirect loop); `extensions/p2o/index.ts:3507-3509,1584-1610` | W-Q |
| P2O-02 | A report-with-hold leaves full target authority: the worker's phase stays active and only `stopped`/`reporting` are refused, so it can keep opening sessions, running commands and driving the pivot while the lead believes it stopped | MEDIUM | C | `src/broker.ts:577-604`; `prepareCommand` at `:624-635`; `assertNotHeld` is the operator hold (`extensions/p2o/index.ts:1444-1446`); held branch at `:4233-4240` | W-R |
| P2O-03 | Validation's `open`-only session rule is bypassed by adjacent session-bound paths: only the `session` action is role-gated; broker accepts a held session for exec/PTY/capture without a role check | MEDIUM | audit-C | `extensions/p2o/index.ts:4789-4795`; `src/broker.ts:445-511` | W-R |
| P2O-04 | A sealed secret leaks through the error text of a substituted URL/header/body: events are redacted but the thrown error is rethrown raw, and the DNS error names the hostname that contains the value | MEDIUM | C | `extensions/p2o/index.ts:2782,2854-2871`; `src/target.ts:281`; `src/broker.ts:665` | W-S |
| P2O-05 | The reverse relay accepts any lab-network peer: no handshake, first SOCKS request is paired with the first idle reverse connection, and the "connected" health marker is any connection — a rogue peer can MITM the pivot or forge health/close | MEDIUM | C/I | `src/tunnel.ts:217-238` (accept), `:118-129` (idle queue), `:148-204` (pairing), `:287-316` (target relay); tests script a cooperative transport only | W-T |
| P2O-06 | Shared-executor filesystem isolation is convention only: root + writable rootfs, no pids/mem/cpu limit; workers can read/tamper each other's scratch, payloads and pre-capture evidence | MEDIUM | C, known | `src/sandbox.ts:14-19`; `src/executors.ts:96-98`; `src/broker.ts:457`; `tests/minimal/docker.test.ts:146-150` pins the behaviour | (knowingly accepted; no workstream) |
| P2O-07 | Foothold-send audits a secret use it never performs: it sends the raw text while the dispatch seam expands/audits the placeholder — false provenance and broken auth if a placeholder is used | LOW | C | `extensions/p2o/index.ts:2530-2534` vs `:2780-2791` | W-S |
| P2O-08 | Foothold transcript previews and research bodies skip the identity redaction that normal dispatch applies | LOW | audit-C | `extensions/p2o/index.ts:2547-2569,2973-2985`; normal path `:2834-2841` | W-S |
| P2O-09 | Session actions bypass admission accounting/readiness: `deps.session` is called without `prepareCommand`/`spend`, so session exec, foothold sends, listen and tunnel setup are absent from `commandsUsed`/`totalUsed` and skip `board.assertReady` | LOW | audit-C | `src/broker.ts:484-497` vs `:624-634` | W-R |
| P2O-10 | The seed fork-bomb regexes are a host CPU amplifier: eight patterns recompiled per command; ~112 ms for a 32 KB adversarial command blocks the owner event loop | LOW | audit-C | `src/policy.ts:41,97` | W-T (small) |

**Status (2026-11-02):** P2O-01 is **closed** by W-Q (committed `5e86666`). W-R closes P2O-02/P2O-03/P2O-09, W-S
closes P2O-04/P2O-07/P2O-08 and W-T closes P2O-05 (all three committed 2026-11-02, §5.1). P2O-06 stays knowingly accepted; P2O-10 remains a small open proposal.

**Explicitly checked and not broken** (do not "fix" these): tunnel/stop command construction has no model-text shell
path (`tunnel.ts:335-354` — token 8–32 lowercase alnum, integer port, host-generated container name, base64 relay);
kill/stop use validated decimal PIDs and fixed markers; path traversal is closed by `O_NOFOLLOW` component pinning and
regex-checked artifact ids; report/CSV/Markdown injection is neutralized; broker ticket/session binding is sound
(32-hex random, 0700/0600 control dir and socket, `heldSession` equality, `delegate` hard-fails, `owner()` gates on
every owner tool — no model-reachable owner path found); the normal secret path (substitute after policy, POSIX quote,
reject CR/LF headers, redact exact values in results and retained bytes) is correct; cookie jars are
origin/principal/session-keyed and bounded; target HTTP pins the resolved IP with `--resolve`, unlike the research
fetcher; open egress, root/writable rootfs and default serial execution are deliberate (`sandbox.ts:14-19`).

### 3.2 Chain / evidence integrity findings (F1 … F17)

**Rating and ladder (the numbers a reader trusts):**

| ID | Finding | Severity | Conf. | Evidence |
|---|---|---|---|---|
| F1 | The rating's `effect` is free model input: it is checked only against `CASE_EFFECTS`, then `chainImpact` scores it directly and `rate()` bounds severity only by that chosen effect. A read claim plus `effect:'code-execution'` can rate critical. `effects.ts`'s derivation table exists but is deliberately not read by ratings | **HIGH** | C | `src/case-types.ts:95`; `src/cvss.ts:81-91`; `src/cases.ts:249-251`; `src/effects.ts:9-10,22-44` |
| F2 | Reach metrics are self-attested at the rating: `chainImpact` copies `AC/AT/PR/UI` verbatim, and `reachEvidenceConsistency` (the W-H check) is only consulted for the ladder's `impact` rung, never by `rate()`. A rating can assert `PR:N/UI:N/AC:L/AT:N` with no evidence and raise its own score; the check also classifies any `shell` receipt as a foothold operation, so a sandbox shell can make `AV:L` look consistent | **HIGH** | C | `src/cvss.ts:85-87`; `src/ladder.ts:73-90,107-113` |
| F3 | The ladder's headline "furthest demonstrated rung" counts unaccepted cases and unexecuted steps: `deriveLadder` builds a chain view for every case with no `accepted` filter, computes a rung for every step regardless of `demonstratedThrough`, and takes the max | **HIGH** | C | `src/ladder.ts:150-187`; `src/report-export.ts:443-456,472-476` |
| F4 | `crossed` is self-awarded through free text: a demonstrated claim whose `gained` entry has any non-empty `scope` gets the rung; no asset/tenant/boundary record is consulted | **HIGH** | C | `src/ladder.ts:65-66,98`; `src/capabilities.ts:16-17,123` |
| F11 | `readyToRate` is a badge, not a gate: `rate()` checks only revision equality and not-withdrawn, so a stale or pending case can be rated and then reads `ratingCurrent: true` by revision | MEDIUM | C | `src/cases.ts:138-140,238-240`; `src/finish-preflight.ts:164` |
| F13 | `blocked` attempts need no discriminating wall: only a 10-character `requirement`, no receipt status/control/dedup, so a 500 or a syntax error can be recorded as a wall and quoted by the ladder as fact | MEDIUM | C | `src/evidence.ts:415-437`; `src/ladder.ts:129-131` |

**Chain linking, dispatch and projection:**

| ID | Finding | Severity | Conf. | Evidence |
|---|---|---|---|---|
| F5 | The held-continuation dispatch path bypasses `CHAIN_LINK_REQUIRED`: the check lives only in `p2o_task_dispatch`; `continueHeldWorker` validates ticket/role/runtime/claim ownership and enqueues without calling `chainLinkGap` | **HIGH** | C | `extensions/p2o/index.ts:3266-3270` vs `:1389-1420` |
| F6 | The link gate is per-claim, not per-step: any open `todo` on the chain whose `claimRefs` slug-match any cited claim licenses the dispatch; the row's `step` is never compared with the successor's position, so one `open` predecessor licenses every later successor | MEDIUM-HIGH | C | `src/chain-view.ts:196-215` |
| F7 | Executed depth merges by slug set, not position: every plan step whose `claimId` is in the executed slug set reads "executed", so two steps citing the same claim both inflate the executed count | MEDIUM | C | `src/attack-chain.ts:215-223` |
| F8 | The M4 obligation is discharged by declaration: any `todo` whose `needs` match the primitive's gains removes `PRIMITIVE_UNCHAINED`, ignoring status, chain membership and whether it ever ran | MEDIUM | C | `src/obligations.ts:55-56,83-84`; consumers `src/completion.ts:85`, `src/finish-preflight.ts:133`, `src/debt.ts:194` |
| F9 | A plan chain displays `gained` from an undemonstrated claim head, while the chain board correctly refuses to let that claim provide — the same claim is decoration in one read and provider in another | MEDIUM | C | `src/attack-chain.ts:138-146` vs `src/chain-board.ts:79-86` |
| F16 | `planChainSteps` uses only `claimRefs[0]`, so a step citing multiple claims loses every link after the first in the canonical projection | MEDIUM | C | `src/attack-chain.ts:138` |
| F17 | Two readiness truths: `chainJoin` pools every demonstrated claim globally and reports a frontier/path that can mix chains, while `chainBoard` is per-chain and plan-row-based | MEDIUM | C | `src/chain-view.ts:61-160` vs `src/chain-board.ts:77-140`; `src/chain-brief.ts:1-20` |
| F10 | The M2 create-time obligation is keyed on a free-text surface string (exact lowercased equality), so a query-string alias evades it and two distinct surfaces sharing a string false-refuse | MEDIUM | audit-C | `src/obligations.ts:47-48,96-105`; `src/tasks.ts:328` |
| F12 | The report's canonical chain block silently truncates at 6 chains: `attackChainReportRows` drops the set's total/omitted fields, and the report prints "N chain(s) shown" with no denominator | MEDIUM | C | `src/attack-chain.ts:22,267,366-381`; `src/report-export.ts:584-587` |
| F14 | Finding identity is model-controllable: the fingerprint hashes model-authored `policyKey`/`rootCauseKey` and asset keys, so a later run can collide with or dodge a remediated identity | LOW-MED | audit-C | `src/finding-fingerprint.ts:40-46`; no consumer yet |
| F15 | Cross-host progression has no chain representation: a case step has no asset/host/environment field, the pivot records no claim or link, and two steps on two hosts are indistinguishable from two on one | LOW | C | `src/case-types.ts:33`; `src/tunnel.ts`, `src/foothold.ts` (no chain/ladder/completion coverage) |

### 3.3 Capability gaps vs ARTEX (breadth)

| Dimension | p2o today | ARTEX mechanism | Verdict |
|---|---|---|---|
| End-to-end vuln classes | **3**: path traversal/LFI, object/field authorization, browser XSS/CSRF/CORS. Everything else is model-crafted, partial, or blocked on blind proof | Same classes are also agent-crafted; no class-level automation either | p2o equal-to-ahead on proof discipline; behind on discovery volume |
| Discovery mechanics | Extractors are pure parsers of retained bytes ("no network, no shell, no eval, no target traffic"); no crawl, parameter discovery, wordlist/ffuf, JS harvest, HAR import | `api-recon` harvest skills (`harvest_static.py`, `spider_mpa.py`, `runtime_harvest.js`, `preload.js`) + enrichment pool (dnsx + HTTP probe through the recording proxy with cooldown dedupe) | **ARTEX ahead** |
| Traffic capture/index | Receipts (16 KiB visual / 4 KiB stderr) + 1 MiB capture artifacts; nothing searchable; `agent-browser` can emit HAR but no HAR extractor/verb exists | Embedded go-mitmproxy recording every exchange to a file tree + SQLite index (`url_template`, body FTS, `traffic_search/get/blob`) + finding-traffic binding with roles and `evidence_version` | **ARTEX ahead** |
| Blind / out-of-band proof | No inbound path by default; foothold/listen need `--lab-network`; SSRF→metadata, blind SQLi, blind XXE default to `open_proof_gap` | Same default restriction (proxy/RoE-gated); no managed pivot tool | ARTEX similar; p2o ahead once ingress exists (managed reverse-SOCKS5 pivot) |
| Scanner/lead economics | nuclei/checkov hits and CVE leads can never become claims; each needs a fresh worker reproduction; validation is a second worker cycle | One `report_finding` call converts a hit to a finding (with its own weak proof gate) | **ARTEX faster**, p2o stricter |
| Coverage unit | Asset × question × method family × actor × tenant; no parameter/field/variant dimension | No typed coverage denominator | p2o ahead on derivation, behind on field-level accounting |
| Concurrency/economics | Default target-ops = 1 (Q26, operator consent to raise); single planner writer; 40 steps/900 s rounds | 3 worker goroutines by default, DB-mediated claiming; planner runs independently | **ARTEX ahead** |
| Retest | Owner note (`still_reproducible`/`fixed`/`cannot_confirm`), same-run evidence, no run of its own | Separate retester agent, frozen "what to reproduce" packet, verdicts, auto-status on `fixed` | **ARTEX ahead** on mechanism; p2o stricter on attribution |
| Credentials/secrets | Operator-sealed identity file substituted host-side, audited by id, self-provisioned principals supported; spraying/brute/stuffing prohibited | No credential store; agent may use credentials but no sealed channel; LLM command judge allows hydra/medusa/sqlmap `--dump` | p2o ahead on handling; narrower on default-cred/reuse entry paths |

### 3.4 ARTEX: copy three mechanisms, not the philosophy

Copy: (1) frozen, hashed, role-labelled traffic evidence with version pinning (`db/schema.sql:1146-1174`;
`findings.evidence_version`); (2) retest as an executed role against a frozen packet (`db/finding_retests.go:74-110`,
`agent/retester.go:4-15`) while keeping p2o's owner review gate; (3) deterministic enrichment/harvest through a
recording proxy, worker-owned.

Do not copy: `report_finding` with optional evidence and an unconditional `state='confirmed'`
(`agent/tools.go:1212-1215`; `db/finding_traffic.go:342-411`); free-text severity; `prove_goal` that accepts any node and
auto-completes; the removed RoE scope mechanism with DB-configurable intercept rules as the only gate
(`guard/guard.go:1-7`); a report that ships `false_positive` findings (`server/server.go:3841-3858`); a retester that
self-certifies `fixed` and flips status.

## 4. New invariants (proposed; none implemented)

These are the invariants this revision asks the owner to adopt. H1–H8 are v1's (H1–H7 closed; H8 open, carried below).
Each is written as a rule the code can enforce, with the finding it closes.

9. **H9 — a host-side fetch connects to the address it vetted.** No check-then-fetch by hostname, and every redirect hop
   re-pins. Closes P2O-01 (W-Q).
10. **H10 — a reported worker holds no target authority until a successor brief activates the hold.** Reporting is an
    authority boundary, not a status label; session-bound execution follows the same rule. Closes P2O-02/P2O-03/P2O-09
    (W-R).
11. **H11 — a sealed value never crosses a tool/model boundary outside the substituted bytes.** Errors, previews,
    transcripts and artifact bodies go through the same redaction as results. Closes P2O-04/P2O-07/P2O-08 (W-S).
12. **H12 — a rating's effect is derived from a demonstrated capability or explicitly flagged unverified, and reach
    metrics raise the score only with evidence behind them.** Closes F1/F2 (W-U).
13. **H13 — the ladder headline counts only accepted cases and executed steps, and a boundary rung needs a boundary
    record.** Closes F3/F4 (W-V).
14. **H14 — chain-link admission is positional and single-pathed.** One gate covers every dispatch path (including held
    continuation); the admitted row's step must be the next step; plan-chain projections and obligations read only
    demonstrated evidence. Closes F5/F6/F7/F8/F9/F16/F17/F12/F13/F11 (W-W).
15. **H15 — the pivot's reverse relay is authenticated.** A peer is accepted only after proving it holds the tunnel
    token; the health/close markers name that peer. Closes P2O-05 (W-T).
16. **H16 — a cross-host step carries the boundary it crossed.** A chain step records the foothold/pivot identity it
    used, and the ladder/report can show multi-host depth. Closes F15 (W-AB).

## 5. Proposed workstreams (options, not picks)

Same discipline as v1: options are offered with trade-offs; a recommendation is a reading order, not a decision. Every
workstream requires `impact()` before any edit and `detect_changes --scope all` before any commit, and none is
implemented without a separate "do it".

### 5.1 Security cluster

**W-Q — Close the host-side fetch rebinding (P2O-01).**
- *Option A — pin the vetted address into the connection:* resolve once, keep the addresses, connect to one of them while
  preserving Host/SNI (undici `Agent` with a custom `lookup`, or `node:http` with a pinned lookup), and re-pin on every
  redirect. The only option that closes the issue at the network layer. **Effort M; risk M** (a TLS/SNI or proxy
  regression would break citation fetches).
- *Option B — same-origin redirects only and refuse cross-origin:* cheap, but rebinding on the *first* resolution still
  passes, because the attacker controls the target's own hostname. **Effort S; risk low; closes weakly.**
- *Option C — turn the citation fetch into a sandbox operation:* no host-side network at all; costs the "never target
  pages" hygiene and adds a dependency on the sandbox. **Effort M/L; risk M.**
- *Recommendation:* A, with a hermetic test that makes `lookup` return a public address at the check and a private one
  at the connect (the existing `lookupHost` injection seam makes this testable without DNS).
- *Acceptance:* a test proves the request connects only to the vetted address for a hostname that answers differently on
  a second lookup, for both the first hop and a redirect; the citation fetch's existing timeout/size/type bounds are
  unchanged.
- **DONE (committed `5e86666`, 2026-11-02; owner instruction "do the first W-Q", Option A).**
  `src/research-fetch.ts`: `vettedAddresses()` returns the admitted `{address, family}` rows; `pinLookup()` is a
  `node:net` `LookupFunction` answering only those rows (both callback shapes); the new `pinnedFetchResponse()` /
  `pinnedRequest()` production transport (Node `http`/`https`, still dependency-free) pins the socket lookup, keeps the
  URL authority as the `Host` header and the hostname as TLS `servername`, tries the resolver's addresses in order and
  never re-resolves; every redirect hop re-vets and re-pins; unread redirect/non-text bodies are released. The injected
  `fetchImpl` seam now receives the vetted `addresses` in its init (test-only) so the tests can assert the pin. Global
  `fetch` is gone from the production path; timeout, byte cap, redirect cap, refusal list and refusal messages are
  unchanged. Tests: +4 in `research-fetch-containment.test.ts` (one resolution per hop handed to the transport; a private
  answer on redirect hop two refused before the transport, two lookups / one call; `pinLookup` both shapes; the
  production transport reaches a local server for the never-resolving reserved host `pinned.invalid`). Verification: tsc
  clean; build/`check:build` OK; targeted research/ingest 46/46; full suite alone 177 files / 5 skipped (182), 1,655
  passed / 13 skipped (1,668), 0 fail; surface audit 35/35/0/10/23, 0 contradictions; `detect_changes --scope all` 3
  files / 56 symbols / 0 processes / risk low; GitNexus index refreshed before `impact` (which read `UNKNOWN`/0 because
  `extensions/p2o/index.ts` is skipped as a >512 KB file — real callers confirmed by text search). Known limits: HTTP/1.1
  transport, no `Accept-Encoding` sent (no compressed body requested or decoded), proxy env vars ignored, as the previous
  global-`fetch` default did.

**W-R — Make reporting an authority boundary (P2O-02, P2O-03, P2O-09).**
- *Option A — refuse target work while held-but-not-activated:* `prepareCommand` (and the session-bound exec/PTY/capture
  path) refuses when `reported && holdBrief && !holdActive`; `holdActive` is set only when the successor brief is
  delivered; session-bound ops also require the worker's own role check (validation cannot exec/PTY through a session);
  session target ops route through `prepareCommand` so accounting and `assertReady` apply. **Effort S/M; risk low.**
- *Option B — end the worker at report and require a fresh ticket for a successor:* simplest authority model, but
  removes the same-conversation reuse that the hold exists for, and breaks the P10/A7.5 design. **Effort S; risk M.**
- *Option C — prompt-only:* add "do not start work while held" text and a report field; no enforcement mechanism, the
  exact gap the audit found. **Effort S; risk high for what it claims.**
- *Recommendation:* A.
- *Acceptance:* an exec/session attempt made after a held report and before the successor brief is refused and receipted
  as a refusal, not as a target operation; the same attempt after the brief succeeds; validation-role exec/PTY through a
  session is refused; session exec increments `commandsUsed` and runs `assertReady`.
- **Implemented (2026-11-02, Option A; committed 2026-11-02):** `authorityRefusal()` in `src/broker.ts` refuses
  with `WORKER_HELD` whenever `reported && !holdActive` — the held-but-idle window — and is applied at the top of
  `prepareCommand` (so exec/net/http/PTY/capture/environment recipe commands all inherit it), to `environment`
  create/verify, and to every session action except the read-only `list`/`snapshot`. `holdActive` is set only by
  `consumeHeldContinuation`, so the successor run on the same ticket, pane and session regains authority. The
  `validation` role is refused with `VALIDATION_SESSION` for every session action except `open` (the broker reuses
  `validationMayUseSession` from the tool policy, so the role rule no longer depends on the loadout) and for
  session-bound exec/net/PTY/capture. An `environment` recipe command that would run through a session the ticket holds
  is refused on the same rule (it is session-bound execution reached through the lab tool, not a second exemption). Session actions that run a command on the target (`exec`, `upload`, `download`,
  `listen`, `foothold-open`, `foothold-identify`, `foothold-send`, `tunnel-open`) now route through `prepareCommand`, so
  `board.assertReady`, revocation and `commandsUsed`/`totalUsed` apply exactly as for `p2o_shell`;
  `open`/`list`/`snapshot`/`close`/`foothold-read`/`foothold-close`/`tunnel-list`/`tunnel-close` stay uncounted (same
  reasoning as container provisioning), and a held worker cannot close the session it is holding. Tests:
  `tests/minimal/broker.test.ts` +3 — held refusal across thirteen call shapes with the target seams untouched and the
  counter unchanged, restore after the brief, validation `open`-only plus session-bound role refusal, and session target
  actions counted/readiness-checked while lifecycle reads stay free.

**W-S — Close the secret-path edges (P2O-04, P2O-07, P2O-08).**
- *Option A — centralize redaction at the dispatch seam and the broker boundary:* every thrown error passes
  `secretText`/`redactSecretBytes`; foothold-send sends `dispatch.text` (substituted) and audits what it actually sends;
  foothold previews and research bodies apply the identity redaction. **Effort S; risk low.**
- *Option B — remove the leak sources instead:* generic resolution errors without a hostname; refuse placeholders on
  foothold actions. Cheaper but narrower. **Effort S; risk low.**
- *Option C — A+B:* both, with a test per path. **Effort S+; risk low.**
- *Recommendation:* C — the paths are few and each is testable.
- *Acceptance:* an error raised after a substituted URL/header/body leaks no sealed value byte; a foothold-send
  containing a placeholder either sends the substituted bytes and audits that, or is refused; a transcript/research body
  containing a sealed value is redacted before it reaches the model or an artifact.
- **Implemented (2026-11-02, Options A+B; committed 2026-11-02):** `footholdSendFor` now sends `dispatch.text`, i.e.
  the bytes the dispatch seam substituted and audited (the raw placeholder text never reaches the peer, and the recorded
  byte count/use audit describe the same bytes). `executeWithReceipt`'s catch redacts the thrown error message through
  `secretText`/`redact` before the progress line, the ledger events, the failed-operation receipt and the rethrow — it
  mutates the `Error` so `code`-based retention checks still see the original failure, and the broker's `errText`
  therefore carries only redacted text to a worker. The foothold transcript preview, the identity observation (a
  transcript slice; the parsed user/uid fields still describe the raw bytes) and `artifactError` go through `secretText`,
  and research fetch bodies are redacted at all three model-visible points: the inline `body`, the retained
  `research-fetch` artifact bytes (`redactSecretBytes`) and the cited-page `fetched[].body`; the injection scan still
  reads the raw body, and `sha256`/`bytes` still describe the remote object. As a source removal, `Tunnel.open`'s
  unhealthy error no longer quotes the target-written foothold transcript: it names that peer bytes exist and points at
  the redacted `foothold-read` preview (the session relay log in that message is host-written). Tests:
  `identity-runtime.test.ts` +1 (a
  thrown DNS-style error naming the substituted value is redacted in the tool error and the ledger; the
  `InertSandbox.failHttpMessage` test seam makes it hermetic), `session.test.ts` +1 (a foothold-send placeholder becomes
  the quoted value the peer receives and the audit names; the echoed value is redacted in the transcript preview and in
  the identity observation while the parsed whoami/id fields stay), and
  `research.test.ts` +1 (an echoed value is redacted inline, in the retained artifact and in the cited-page flow).
  Known limit: exact-value matching only — a value the origin transforms, or one split across the 8 KiB inline slice
  boundary, can still appear; artifact reads additionally apply the store's generic credential pattern.

**W-T — Authenticate the pivot reverse relay (P2O-05).**
- *Option A — token handshake:* the target relay's first line is the tunnel token (passed in argv, not in a log), the
  session relay compares it before pairing, and the health/close marker names the authenticated peer. **Effort S/M; risk
  low** (the relay is host-authored and already carries a token).
- *Option B — bind the listener to the expected peer address:* fragile behind Docker NAT and across reconnect; not
  recommended alone.
- *Option C — HMAC the destination per connection:* strongest, most moving parts. **Effort M; risk M.**
- *Recommendation:* A; optionally C later if the lab network is ever shared with untrusted peers.
- *Acceptance:* a rogue lab-network peer that connects without the token is closed before any destination line is sent
  and cannot mark the tunnel healthy; a cooperative peer still passes the existing tunnel tests.
- **Implemented (2026-11-02, Option A; committed 2026-11-02):** the session relay (`TUNNEL_SOCKS_SCRIPT`) now takes
  the tunnel token as its fourth argv and authenticates each reverse peer before pairing: a peer must open with
  `P2O <token>\n` within 256 bytes and 5 s, a mismatch is closed and logged as `reverse peer refused`, and the
  `target relay connected` health line — the one `awaitDialBack` greps — is written only after a successful handshake.
  The target relay (`TUNNEL_TARGET_SCRIPT`) takes the token as its third argv and sends the handshake line before it reads
  a SOCKS request, so a rogue peer can neither be paired with a SOCKS5 request nor forge health/close. Both host-built
  commands pass the token; the token stays host-generated (`/^[a-z0-9]{8,32}$/`, 16 KiB relay budget unchanged). Tests:
  `tests/minimal/tunnel.test.ts` +1 — a rogue connection without the token is refused and closed (observed from connect
  time, which matters: the refusal is fast), the token does not appear in the relay log, and a cooperative SOCKS5
  CONNECT still works afterwards on the same authenticated relay; the existing real-Python loopback and scripted
  state-machine tests pass with the token in argv. Known limit, stated rather than hidden: the token is visible in
  argv on the obtained host (the same trust boundary as the vetted container name and the pushed relay — the obtained
  host is trusted relative to other lab peers), and a peer that holds the token still gets the one paired connection the
  one-peer contract allows. Option C (per-connection HMAC) stays available if the lab network is ever shared with
  untrusted peers.

### 5.2 Integrity cluster (the numbers the report prints)

**W-U — Make the rating's effect and reach evidence-backed (F1, F2; supports H12).**
- *Option A — refuse an effect not derived from the executed claim:* use `effects.ts`'s table and refuse a mismatch.
  Cheapest, but a legitimate composed effect would be refused. **Effort S; risk M (false refusals).**
- *Option B — accept + flag:* keep the rating, record provenance `EFFECT_DERIVED_MISMATCH` (mirroring `INFERRED_POLICY`),
  require `limitations`, and run `reachEvidenceConsistency` in `rate()` so the score is capped when the cited receipts
  contradict the claimed reach; store a `REACH_UNVERIFIED` flag when the non-`AV` metrics are not evidenced. **Effort
  S/M; risk low.**
- *Option C — require a second, effect-specific claim:* most rigorous, most pressure on workers and rounds. **Effort M;
  risk M.**
- *Recommendation:* B now, A/C later if reports still over-claim; B is the smallest change that removes the free-raise.
- *Acceptance:* a rating whose effect is not supported by any cited claim's typed gains carries
  `EFFECT_DERIVED_MISMATCH` and limitations, and its printed severity says it is unverified; a rating whose cited
  receipts contradict the reach is capped with the inconsistent reach named; hermetic tests pin both directions.

**W-V — Make the ladder print only demonstrated depth (F3, F4; supports H13).**
- *Option A — filter and separate:* build the chain view only from accepted cases, compute rungs only for steps up to
  `demonstratedThrough`, print a separate "intended, not reached" table, and require a boundary record for `crossed`
  (session/environment/tenant record or explicit evidence) instead of free-text `scope`. **Effort S; risk low.**
- *Option B — keep the rows but add an `executed` column and exclude unexecuted rows from `furthest`; keep `crossed` as
  is but label it self-declared. **Effort S; risk low; leaves the headline partly soft.**
- *Option C — A+B:* filter, add the column, and rename the rung to `crossed (self-declared)` until a boundary record
  exists. **Effort S+; risk low.**
- *Recommendation:* C.
- *Acceptance:* an unaccepted case or a step beyond `demonstratedThrough` cannot raise the furthest rung; a claim with a
  free-text `scope` and no boundary record prints as self-declared, not as demonstrated; the walls still quote records.

**W-W — Make chain admission single-pathed and projections honest (F5, F6, F7, F8, F9, F11, F12, F13, F16, F17; supports
H14).** This is the largest cluster but every piece is small; split it if the owner prefers.
- *Option A — one host gate + truth in projections:* move the link check into the board transition/reserve path so
  `p2o_task_dispatch` and `continueHeldWorker` share it; require the open row's `step` to be the next step after the last
  demonstrated one; merge executed steps by `(claimRef, order)`; display `gained` only when the claim is demonstrated;
  discharge `PRIMITIVE_UNCHAINED` only by a `done` todo in the same chain; make `rate()` respect `readyToRate` (or
  record why not); print the chain denominator; require a `blocked` wall to cite a receipt whose status looks blocked or
  a distinct second mechanism. **Effort M; risk M** (touches dispatch and obligations).
- *Option B — enforce the gate, defer projection cosmetics:* do the gate, the executed merge and the obligation rule; leave
  F9/F11/F12/F13 to a later pass. **Effort S/M; risk low.**
- *Option C — prompt/report-only:* clarify the prompt and improve report labels without enforcement. **Effort S; risk
  high for what it claims.**
- *Recommendation:* B first (the enforcement half), then A's projection half in the same or next tranche.
- *Acceptance:* every dispatch path refuses an unlinked successor (a test for held continuation, one for a stale open
  predecessor row); duplicate-slug steps do not both read executed; a `needs`-matching `cancelled`/`done` todo does not
  discharge the obligation; a stale case cannot be rated without the flag; the report prints a chain denominator; a
  `blocked` claim without a discriminating wall is flagged.

### 5.3 Capability cluster

**W-X — Measurement: establish a real baseline before capability work (finding W1).**
- *Option A — run the P18 24-run protocol:* the repo's own ready-not-run clean protocol (2 fixtures × 2 variants × 2 arms
  × 3 reps, pinned model/thinking, cost cap, Herdr worker backend). The only option that produces comparable quality
  data; needs owner authorization, a push/install build, and money. **Effort L; risk: cost/time and another confounded
  campaign if the pinned settings drift.**
- *Option B — mini campaign:* 8 runs (1 fixture × 2 variants × 2 arms × 2 reps) as a regression signal. **Effort M;
  risk low.**
- *Option C — hermetic chain drills:* replay a recorded transcript/ledger through the projections and dispatch gates to
  pin readiness → link → dispatch → rating behaviour without a model. **Effort S; risk low; cannot measure model
  quality.**
- *Recommendation:* C immediately (it protects W-U/W-V/W-W), B next, A only on a fresh owner instruction — and note that
  an exploit-mode live run with an accepted chain effect is still the missing evidence for the chain layer itself (v1's
  P25 Phase 5 remains deferred under the C1 validity clause).
- *Acceptance:* C: a table-driven test that a recorded-run fixture reaches the same chain state/dispatch refusals;
  B: a suite summary with per-arm recall/precision/FP/overclaim and an explicit validity flag per run.

**W-Y — Evidence materiality: traffic snapshots bound to cases (finding W3; ARTEX mechanism 1; supports H12/H16).**
- *Option A — HAR-first:* add a HAR importer (from `agent-browser network ... har` and, later, a per-run recording
  proxy) plus a searchable artifact index; extend the case rating with ordered `trafficRefs[{role, position,
  snapshotRef}]` over host-frozen req/resp heads+bodies with hashes, and an `evidenceVersion` that the report prints.
  **Effort M; risk M** (secrets in bodies — reuse the redaction path; storage growth).
- *Option B — full recording proxy:* closest to ARTEX; largest lift and a new always-on capture surface. **Effort L;
  risk M.**
- *Option C — evidence pack only:* export the receipts/artifacts/HAR a finding cites into the report directory, no new
  schema. **Effort S; risk low; doesn't give versioning or role ordering.**
- *Recommendation:* A (HAR-first), because it reuses the browser and receipt paths and does not require changing the
  sandbox's `--proxy ''` stance; B only if a real engagement needs non-browser capture.
- *Acceptance:* a case can cite an ordered, role-labelled snapshot; the report shows the evidence version and refuses a
  report written against an older snapshot; a secret in a captured body is redacted before the artifact is stored.

**W-Z — Discovery mechanics (findings S1, S3, S4, S5; ARTEX mechanism 2).**
- *Option A — authenticated crawl + parameter map:* a skill script that crawls same-origin links/forms to depth 2 under
  a named principal, writes route assets, and records a parameter matrix as asset attributes + per-parameter claims.
  **Effort S; risk low; shallow but real.**
- *Option B — port the api-recon harvest:* browser runtime harvesting (spider MPA, runtime JS, preload stubs) as a p2o
  skill. **Effort M; risk M** (stub semantics; never submit real credentials).
- *Option C — proof-side package:* in-band oracle pack (timing/diff/target-side state) for blind classes, plus an
  owner-triaged scanner hypothesis auto-seeding a *validation* task without promoting it to a claim. **Effort S/M; risk
  low.**
- *Recommendation:* C first (improves proof without new capture), A second, B when a browser-heavy target appears.
  Do not adopt ARTEX's non-AI enrichment as a host-side process — if added, make it worker-owned.
- *Acceptance:* a blind probe with a timing/diff oracle can be recorded as tested (not as a wall) with its receipts;
  a crawl produces route assets and a parameter matrix with attribution; validation seeding preserves the
  lead-boundary (no auto-claim).

**W-AA — Retest independence (finding W4/S8; ARTEX mechanism 2).**
- *Option A — a retester role:* a separate session that receives a frozen packet (case revision, claim, payload ref,
  environment fingerprint), replays the stored payload under the same fingerprint, writes verdict + receipts, and
  **keeps p2o's owner review gate** (no auto-status). **Effort M; risk M** (false "fixed").
- *Option B — strengthen the owner retest:* require a different worker's receipt for `fixed`/`still_reproducible`.
  **Effort S/M; risk low.**
- *Option C — keep as is + print the retest state in the report.* **Effort S; risk low.**
- *Recommendation:* B now, A when the validation role is next touched.
- *Acceptance:* a `fixed` verdict without an independent replay is refused or flagged; the report prints retest
  provenance (owner note vs independent replay).

**W-AB — Cross-host depth in the chain (finding F15; supports H16).**
- *Option A — first-class boundary:* add a step-boundary reference (foothold/pivot/session identity) derived from the
  tunnel/foothold lifecycle records, show it in the attack path and let the ladder credit a reach that crossed a
  boundary. **Effort M; risk M** (chain schema change).
- *Option B — minimal:* record the boundary ref in the plan row/step and render one report line; no ladder change.
  **Effort S; risk low.**
- *Option C — defer until W-X produces a real multi-host run.* **Effort 0.**
- *Recommendation:* B now, A when a live multi-host run exists to test against.

### 5.4 Inherited open item: W-P (H8, carried from v1, unchanged)

**H8** — a worker's own `request_subtask` proposal can be resolved by `p2o_workers continue`/`steer` into the same live
worker, with no code or test boundary forcing the fresh-dispatch path; `continuationRefusal()` does not distinguish
"resume an exhausted lease" from "answer this worker's own proposal". This remains **open** and independent of the
audit: v1's W-P options stand — *A:* refuse continue/steer while that worker has an open unaccepted proposal (closes it,
contains it); *B:* prompt-only clarification (cheap, advisory); *C:* a combined accept-and-dispatch action (closes it
structurally, adds surface). v1's reading order — A, then B as fallback, C only if the owner wants the unrepresentable
state — is unchanged. `impact()` on `continuationRefusal()` remains a prerequisite before any edit.

## 6. Priority, effort and recommended sequence

| Workstream | Closes | Effort | Risk | Unlocks |
|---|---|---|---|---|
| W-Q host-fetch rebinding | P2O-01 (**HIGH**, host boundary) | M | M | host safety for every later feature — **DONE (committed `5e86666`; §5.1)** |
| W-R authority after report | P2O-02/03/09 (MEDIUM/LOW) | S/M | Low | an authority model the report can claim — **DONE (committed 2026-11-02; §5.1)** |
| W-S secret-path closure | P2O-04/07/08 (MEDIUM/LOW) | S | Low | the sealed-value guarantee actually holds — **DONE (committed 2026-11-02; §5.1)** |
| W-T pivot relay auth | P2O-05 (MEDIUM) | S/M | Low | the pivot can be relied on in a shared lab — **DONE (committed 2026-11-02; §5.1)** |
| W-U rating effect/reach | F1/F2 (**HIGH**) | S/M | Low | a rating whose number means what it prints |
| W-V ladder truth | F3/F4 (**HIGH**) | S | Low | the headline depth stops over-stating |
| W-W chain admission/projection | F5 (**HIGH**) + F6–F17 | M | M | the chain layer's own guarantees become real |
| W-X measurement | W1 (capability credibility) | S (C) / M (B) / L (A) | Low/M | a baseline to judge everything else |
| W-Y traffic evidence | W3 (evidence materiality) | M | M | report evidence that survives time |
| W-Z discovery mechanics | S1/S3/S4/S5 (breadth) | S–M | Low/M | more than 3 end-to-end classes |
| W-AA retest independence | W4/S8 | S/M | Low | remediation claims with a second pair of eyes |
| W-AB cross-host chain | F15 | S (B) | Low | pivot depth recordable as chain depth |
| W-P (H8, inherited) | H8 | S–M | Low | steering discipline matches ARTEX's split |

**Recommended sequence (a reading order, not a pick):**

1. **W-Q** — the only host-boundary break; fix before any engagement or feature. Then **W-R + W-S + W-T** — same
   fixture class (authority/lifetime/edge paths), small, test-heavy.
2. **W-U + W-V** — the report's numbers become trustworthy before more reports are produced.
3. **W-W** — enforcement first (held path, positional link, executed merge, obligation rule), projection half second.
4. **W-X option C** (hermetic chain drills) alongside step 3 so the fixes land under a repeatable test; then decide on
   B/A with a fresh owner instruction.
5. **W-Y (A) + W-Z (C, then A)** — evidence materiality and proof-side breadth.
6. **W-AA (B), W-AB (B)** — small follow-ups; **W-P** whenever the owner wants the H8 gap closed.
7. W-T optional second half (HMAC) and W-Y option B only if a real engagement needs them.

Two deliberate sequencing choices: security before capability (the host boundary is not an assessment feature), and
integrity before measurement (a benchmark run would otherwise measure a chain layer whose rating can over-claim). If the
owner prefers throughput over evidence quality, steps 4–6 can move ahead of 2–3, but W-Q/W-R/W-S should still go first.

## 7. Non-goals this round

- No code change, no test run, no commit, no push. This document is the proposal; each workstream is implemented only on
  a separate instruction and its own pre-edit `impact()`/pre-commit `detect_changes` pass.
- No live target traffic and no paid model call. The C1-authorized host and its prohibitions keep v1's rule: only a
  fresh owner instruction authorizes a live run; prior authorization does not carry over.
- No re-litigation of closed workstreams H1–H7/W-A–W-O; they are recorded in git and `docs/HISTORY.md`.
- No change to Q26 (serial default) — the audit confirmed the default is a dated owner decision, not an oversight;
  changing it is an owner call, not part of this plan.
- No change to the shared-executor isolation shortcut (P2O-06) without an explicit owner decision: it is a known,
  documented trade-off, not a bug introduced here.
- No new always-on capture surface: W-Y option A (HAR import + case binding) is the proposed path; a recording proxy is
  option B and needs its own decision.
- No re-authoring of the v1 pivot design: W-T/W-AB only harden and record it.

## 8. Open decisions for the owner

1. **Scope of this round:** security-only (W-Q–W-T), security + report integrity (W-Q–W-W), or the full list? The
   recommendation is security + integrity, then measurement.
2. **W-Q option:** A (pin the vetted address; recommended), B (same-origin redirects only; weak), or C (move the
   citation fetch into the sandbox; no host network)? **Decided 2026-11-02: A, implemented and committed (`5e86666`).**
3. **W-R option:** A (refuse target work while held-but-not-activated; recommended) or B (end the worker at report and
   retire the hold mechanism; simpler authority, loses same-conversation reuse)? **Decided 2026-11-02: A, implemented —
   together with W-S option C and W-T option A — in the owner-approved security batch (committed 2026-11-02).**
4. **W-U option:** B (accept + `EFFECT_DERIVED_MISMATCH`/reach cap; recommended) or A (refuse non-derived effects,
   stricter but may refuse legitimate composed chains)?
5. **W-W scope:** A (full cluster, one tranche) or B (enforcement first, projections second)?
6. **W-X:** is a live/paid measurement authorized in this round (A or B), or only hermetic drills (C) now?
7. **W-Y:** HAR-first (A, recommended) or is a recording proxy (B) acceptable as an always-on surface?
8. **W-P (H8):** v1's option A (gate continue/steer while a self-filed proposal is open; recommended), B (prompt-only),
   or C (combined accept-and-dispatch action)?

## 9. Records

### 9.1 Record of the superseded plan (v1, 2026-11-02)

v1's closed workstreams remain closed and are not re-litigated here: G1–G7 (`95eae50`…`6b17cad`), F3/W-A (`ffff2a5`),
F4/W-B (`4db457b`/`a4ed37c`), F5/W-C (`10231c0`), F6/W-D (`97b3081`), F6/W-E (`10cafe8`), F7/W-G (`d5717a9`), F8/W-H
(`eb47571`), F1/W-F (`af20cbd`), H1/W-I (`9002e02`), H2/W-J (`2662d2d`), H3/W-K (audit only), H4/W-L (`1087260`,
`83b5761`), H5/W-M (prompt clarification), H6/W-N (`d77ab2e`), H7/W-O (`504af3a`, the managed reverse-SOCKS5 pivot).
**H8 remains open** and is carried as W-P (§5.4). The pre-replacement working-tree copy, including the uncommitted
§2.3/H8/W-P edits this revision folds in, is at `/tmp/planning_update.pre-v2.20261102-181542.md`; the committed v1 is
`git show 6a2ccf5:planning_update.md`.

### 9.2 Basis for §3.1 (security)

Four read-only passes over the working tree at `HEAD f60f934`; the lead re-read the research-fetch check/fetch split
(`src/research-fetch.ts`), the held-report path (`src/broker.ts` and `extensions/p2o/index.ts`), the secret substitution
and error seam, the foothold-send path, the tunnel relay, and the session/role gate. No Docker, no traffic, no DNS
experiment. P2O-01 is structurally confirmed; a hermetic proof needs a `lookupHost`/`fetchImpl` disagreement test
(the seam already exists), and a live rebinding PoC needs a controlled DNS.

### 9.3 Basis for §3.2 (integrity)

Direct reads by the lead of `attack-chain.ts`, `chain-board.ts`, `chain-view.ts`, `ladder.ts`, `cases.ts`,
`case-types.ts`, `cvss.ts`, `effects.ts`, `evidence.ts`, `obligations.ts`, `report-export.ts`, `chain-brief.ts` (all at
`HEAD f60f934`), plus the chain-integrity audit's inventory of 15 untested gaps (e.g. no test that an unaccepted case
cannot set the furthest rung, no test for the held-continuation bypass, no test that a `blocked` claim's receipt looks
like a wall). Tests named in the audit as covering only the cooperative direction: `case-chain.test.ts:37`,
`ladder.test.ts:19,63,85,117,176`, `chain-dispatch.test.ts:32,87`, `chain-economy.test.ts:130`.

### 9.4 Basis for §3.3 (breadth) and §3.4 (ARTEX)

ARTEX snapshot at `my_references/ARTEX` (336 Go files) read against `agent/`, `db/schema.sql`, `traffic/`,
`intercept/`, `guard/`, `enrich/`, `report/`, `skills/`; prior study `ARTEX_AGENTIC_CORE.vi.md`. p2o breadth from
`src/extract/*`, `src/wstg-map.ts`, `src/cve.ts`, `src/research.ts`, `src/coverage.ts`, `skills/`, `knowledge/techniques/`,
and the recorded live runs in `docs/ACCEPTANCE_MATRIX.md`. ARTEX has no run transcript in the snapshot: every ARTEX
comparison is code-level, never measured, and should be cited as such.

### 9.5 Carried operational facts (unchanged from v1)

- **Practice model:** `opencode-go/deepseek-v4.1-flash` only; a usage limit is a stop-and-wait, not a provider change.
- **Commit/push discipline:** no commit, no push without a fresh instruction; no AI attribution; repository identity is
  the owner's; owner files (`AGENTS.md`, `pi-p2o-defense-vi.pptx`, `.transcribe_tmp/`) are never staged.
- **Live-run authorization (P25 Phase 5, still deferred):** only `https://ise.uit.edu.vn/` has ever been authorized, under
  the C1 validity clause (default ladder minus `availability-loss`), only on a fresh owner instruction each time; last
  recorded runbook prohibitions: no destructive/availability action, no persistence/anti-forensics/evasion beyond minimal
  proof, no bulk user-data access, no credential theft beyond an owner-designated test account, no lateral movement.
- **Measurement assets that already exist:** `bench/fixtures` (6 vulnerable/fixed pairs with evaluator truth),
  `scripts/benchmark-skills.mjs`, the P18 24-run protocol (`bench/README.md`, ready-not-run), and the live-run records
  in `docs/ACCEPTANCE_MATRIX.md`.
