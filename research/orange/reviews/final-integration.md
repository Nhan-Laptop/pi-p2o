# Final Orange integration: independent advisory review

## Verdict

**Retain the current 96-row curation and all 51 effective accepted candidates.** They are narrow refinements or merged support within 14 existing owners, not 51 new procedures. I found no additional candidate that needs rejection, no required new skill/tool, and no adopted exploit or challenge-solution sequence. The seven editorial overrides materially improve the evidence and ownership boundaries.

Two follow-ups remain: **finish the final receipt-to-artifact binding** (F1), and optionally clarify the state skill's validation text for its newly adopted publication-policy question (F2). This is advisory editorial approval, **not a reviewer-issued test PASS, independent source/result reproduction, or declaration that the parent task is complete**.

## Exact scope and checkpoint

- Workspace: `/home/nhanlaptop/project/pi-p2o`; reviewer pane `w2Z:p34`. The observed runtime environment identified `openai-codex-account-3` / `gpt-6.1-sol`; no runtime setting was changed.
- Opening checkpoint: **2026-09-30T12:10:16Z**. Final reviewed-byte checkpoint: **2026-09-30T12:33:55.250988Z**.
- Read the complete current **O001–O096 extraction packets**, including evidence, workflows, tools, handoff proposals, candidates, limitations and exclusions; read all **96 curation decisions** and compare all **51 selections after overrides** with their current operational destinations.
- Read **all 17 `skills/*/SKILL.md` documents and all 10 owned references**; README, HANDOFFS and `templates/handoff.json`; Orange METHOD, BASELINE and WORKER; taxonomy and supplemental-tooling boundaries; both renderers, the library validator and both test modules. Inspected the current catalog and ledger qualifications/selection sections, and locally indexed inventory, corpus, delegation, runtime and quotation-receipt records.
- **O088–O096 are present and covered here**, not missing: O088/O089 remain context; O090–O096 remain excluded. The earlier `later-wave.md` checkpoint is historical, not this review's coverage limit. O084 is the amended packet.
- No fetching, browser/source reopening, target interaction, source-artifact execution, tool installation, project-script execution or test replay. Read-only JSON/text/hash accounting below is not a replay of the validators. Only this report is written by this review.

The parent continued producing documentation/runtime/check receipts during the review. I re-read the updated METHOD, Orange validator/renderer and Orange tests, and read the arriving final receipts rather than carrying an opening-state verdict forward. Curation remained unchanged. Opening hashes were `2c30f4010d33ebe3e617c720178f6becc85feb58bb5e6bf0cc4c7873c98bc1f2` for curation, `0578a82eb16c639fc1590361d070d3cdc4f181c99b14ac28d1078cdd9c758d3c` for METHOD, and `029a704628138f9b653a1be054b45598d783d93433a33ae20f137ed27d6d738d` for `scripts/orange_research.py`; final hashes appear below. This is a local byte checkpoint, not an atomic filesystem snapshot or Git diff.

### Local accounting, not external verification

- Inventory/curation cover exactly the ordered 96 IDs; no packet ID/assigned-URL mismatch.
- Dispositions reconcile to **29 included, 20 context, 46 excluded, 1 duplicate, 0 unavailable**.
- Exactly **51 zero-based selections across 29 rows**, **7 overrides**, **14 effective owners**. Every selected effective guidance/evidence string appears exactly once in its current ledger section.
- All 96 corpus extraction hashes match the current packets. All **276 packet quotation strings** match their stored receipt hashes, with no mismatches; the manifest records **273 exact and 3 whitespace-only matches**.
- The aggregate quotation receipt equals the three browser batches after substitution of the two separate full-publication receipts. The raw O002/O033 batch entries intentionally retain historical `linked-publication-pending` states; their separate publication receipts resolve those states in the aggregate. They are not unresolved final wording checks.
- Stored launch metadata has **96 distinct child-session identities**, all recording the requested provider/model/`max` tuple. This is receipt inspection, not reinspection of the original session transcripts or a new launch.

These checks bind local records and selections. They do not independently verify public wording, tool use, architecture, technical outcomes or fixes. The parent performed the independent public-source wording checks; this reviewer did not.

## Findings and precise follow-ups

### F1 — Final verification receipt is present, but artifact binding is still empty

**Priority: medium for release/closure claims; not grounds to reject the editorial integration.**

`research/orange/checks.txt` and `research/orange/verification.json` were absent at the earlier receipt probes, then arrived during review. Both were read in full. The stored parent log records the render/freshness/validation commands, **82 tests / OK**, syntax compilation and an orchestration-adapter import check; the JSON records seven zero exit codes. The inspected test modules contain 45 library and 37 Orange test definitions, consistent with that recorded total. `native-skills.json` separately records 17 unique local skills, zero diagnostics and 17 prompt entries with defaults disabled. None was rerun here.

At the final checkpoint, however, **`verification.json` still contains `"artifact_hashes": {}`**, despite METHOD advertising final receipts and artifact hashes. The command receipt is a useful parent-reported run, but it does not yet bind that run to a final enumerated artifact set. Its recorded check time also precedes this report's creation.

**Required before claiming fully bound final verification:** populate an explicit path/hash manifest for the final reviewed inputs, operational guidance, outputs, code/tests and relevant receipts; distinguish files covered by the recorded run from subsequent additions or changes. Avoid a self-hash cycle. If any validation-relevant content changes, refresh the affected receipts. Do not label this reviewer as having independently run or passed those gates, and do not use the historical 43-test baseline as a substitute. The hashes in this report establish my checkpoint only; they do not repair the parent's empty verification field.

### F2 — State publication question is adopted, but validation remains stale-reference-centric

**Priority: low; optional clarity improvement.**

O037[0]'s corrected owner and workflow step 2 in `skills/state-and-lifetime-auditing/SKILL.md` properly model coherent object/companion-policy publication without declaring a race. Its existing Validation paragraph still begins by requiring a stale reference, destruction/state invalidation and subsequent use. Those are appropriate lifetime gates, but do not directly explain validation of an incompletely initialized policy companion. A reader could incorrectly force the new question into UAF evidence or assume the workflow text alone establishes a finding.

**Suggested append to Validation, leaving lifetime requirements intact:**

> For publication or companion-policy questions, corroborate the object and required-state identities, the visibility/validity transition, the consumer's missing-state decision, and the relevant transaction or synchronization boundary. Keep unknown policy or ordering evidence unresolved. Route intended policy to authorization review; require feasible ordering and state observations before assigning a race classification.

No packet change, new race method or stronger source claim is justified. The existing Evidence paragraph and shared handoff classification rules already preserve this boundary, so this is not a blocking semantic defect.

### F3 — Structural gates are useful, not semantic acceptance proof

**Classification: verification limit, not a newly discovered failing gate.**

Static inspection found meaningful mutation coverage for missing/duplicate records, requested and observed runtime, receipt origin/hash/mode, invalid indexes and overrides, effective-owner citations, qualification rendering, links, unsafe patterns and stale output. The renderer retains qualifications, separates linked quotation origin, and labels every worker handoff proposal unadopted. The library validator covers references as well as main skills.

Nevertheless, two workflow objects do not prove two distinct supported methods; a valid evidence ID does not prove its paraphrase; `explicit` does not prove a documented tool run; one owner citation does not prove every selected refinement is implemented; pattern filters cannot recognize every natural-language solution sequence. Native discovery does not test optional analysis integrations. Preserve the manual editorial gate and these narrower descriptions even after recorded structural checks succeed.

## All 51 selected candidates: packet-to-guidance comparison

**Disposition for every selection below: keep in its current owner, with the listed qualification; merge-support is intentional rather than claimed novelty.** Indexes are zero-based. Owner shorthand: **surface** = attack-surface-mapping; **source** = source-code-auditing; **binary** = binary-auditing; **flow** = data-flow-analysis; **dynamic** = dynamic-analysis; **parser** = parser-differential-auditing; **auth** = authorization-auditing; **dispatch** = deserialization-and-dispatch-auditing; **patch** = patch-diff-analysis; **memory** = memory-safety-auditing; **state** = state-and-lifetime-auditing; **sandbox** = sandbox-boundary-analysis; **impact** = exploitability-assessment; **repair** = remediation.

The named guide is its existing owner's `references/*.md`; otherwise the destination is the named skill's Workflow/Validation/Evidence text. An accepted index is not an instruction to adopt the packet's other candidates, tools or handoffs.

| Source / indexes and evidence | Effective owner / current destination | Integration judgment and indispensable boundary |
|---|---|---|
| O001: 0/E1; 2/E3; 3/E4–E5 | 0 parser / semantic-boundaries; 2 source / interaction-audits; 3 dynamic / failure text | Preserve structure after later rewrites, security-check output/state effects, and detector blind spots. No catalogue-to-exposure inference or undocumented detector run. |
| O004: 0/E1; 1/E1,E3; 2/E1–E3; 3/E4–E5 | 0 flow / edge ledger; 1 parser / semantic-boundaries; 2 dynamic / conversion predictions; 3 repair / migration and shipped ownership | Mapping/configuration is prediction, not observed consumption. Candidate 2 is shared observation support, not another procedure; entry/type/downstream compatibility and distributed builds remain necessary. |
| O005: 0/E1–E2; 1/E2–E3; 2/E2,E4; 3/E4–E5 | 0 source / interaction-audits; 1 parser / semantic-boundaries; 2 dispatch / failure selectors and framework-routing; 3 repair / equivalent consumers | Shared meaning, re-entry, terminal error and equivalent-caller contracts are distinct questions. E3 is a reproduced specification, not independently observed inherited state. Candidate 3 supports the existing regression matrix. |
| O008: 0/E1–E2; 1/E3; 2/E4–E5 | 0 surface / intermediary-trust; 1 auth / legitimate identities; 2 repair / active enforcement | Effective peer authority, legitimate operations per consumer, and shipped versus enabled policy remain separate. No relay/coercion procedure or universal identity prohibition. |
| O009: 0/E1–E2; 1/E3–E4; 2/E5 | 0 parser / cache-selection; 1 source / interaction-audits; 2 auth / semantic operands | Declared-context reuse is not byte-identical output forever. Record/key/hash/equality is an application contract, not intrinsically binary. Repeated operands motivate review, not a proven missing check or measured collision result. |
| O011: 1/E2–E3; 2/E2–E3 | 1 source / exceptional exits; 2 dynamic / observation-signals | Rejection progress and stage-correlated observations do not establish completion. Merge candidate 2 into the shared observer contract; no recovery/extraction oracle. |
| O012: 0/E2–E4; 1/E1–E2; 2/E2,E4–E5; 3/E3–E4 | 0 surface / intermediary-trust; 1 source / interaction-audits; 2 parser / context ledger; 3 auth / separate gates | Map actual revision-dependent responsibilities, admission, metadata, represented identity and action permission. Compatibility and a reachable internal interface are not authority or a demonstrated defect. |
| O014: 3/E4–E5 | patch / scoped rejection evidence | Transfer a published negative conclusion only with its actual guard and comparable revision. Missing guard is an applicability question, not positive reachability; adjacent diff context is not a local run. |
| O015: 2/E4 | dispatch / framework-routing | Unmatched/default delegation belongs in the selectable-set model. Advertised help and an ordinary negative review do not close it; no command sequence. |
| O016: 0/E1; 1/E2–E3 | 0 flow / retrieval predicates and cache-selection cross-link; 1 impact / producer emission constraints | The override correctly makes storage/index obstruction conditional and derived: E1 alone does not establish it. Changed bytes are not consumed meaning. Effective emission order/configuration is feasibility evidence, not trigger order or a transferable layout. |
| O017: 0/E1; 1/E2 | source / interaction-audits | Feature exceptions and runtime replacements are integration contracts. Do not inherit builtin guarantees, treat diagnostics as execution proof, or add another tooling procedure. |
| O018: 0/E1–E2; 1/E3 | 0 binary / provisional correspondence; 1 memory / paired sizing/emission | Registration/upstream similarity bounds a slice but needs shipped-instruction corroboration. Capacity must cover actual emission; extra classes and benign regression controls are derived, not source-performed tests. The brief fuzzing pivot is not adopted. |
| O019: 1/E2–E4 | dynamic / observation-signals | Consumer documentation can select a signal. Non-crash timing is not automatically benign: ceilings, controls and isolation are derived safeguards; amplification and stronger-capability inference remain excluded. |
| O020: 0/E1–E2 | source / interaction-audits | Custom preservation/pass-through callbacks need their own guarantees. Mature-library/default behavior and an explicitly recommended policy checker are not integration or enforcement proof. |
| O021: 0/E1,E4; 2/E1,E4 | 0 dispatch / framework-routing; 2 sandbox / phase guards | Preparation hooks and phase-specific guards require actual dependencies, identity and independent gates. Correct owner is dispatch, not compiler-invariant auditing; a separate objdump illustration does not prove service reachability. |
| O022: 0/E1–E3; 1/E3,E5 | 0 dispatch / framework-routing; 1 auth / effective action | The override replaces the source's broad type slogan with actual receiver, visibility and eligibility questions. Root admission is not final action permission; inherited/returned candidates need their own gates. |
| O024: 2/E3–E4 | dispatch / framework-routing | An allowed result's later interpretation is another consumer contract. Preserve return provenance and independent checks, not an operation chain. |
| O027: 1/E2–E3 | flow / failure-result conversion | Producer type, receiving type, conversion and branch/exit meaning form one contract. Unsigned includes zero; a timeout proves neither marker loss nor service-wide exhaustion. |
| O028: 0/E1,E3 | impact / mediated requests | Field control, method/framing/encoding, destination and handshake limits constrain the capability. Reachability is not arbitrary message control or a network-to-execution sequence. |
| O029: 1/E4 | source / argument-role guarantees | Protected values do not imply protected structural arguments. Do not generalize local administrative inspection to unauthenticated reachability or claim source/deployment correspondence. |
| O033: 3/E3–E5 | repair / provisional-owner route in HANDOFFS | Correct derived route is dynamic observation to authorized owner/responder review, without confirmed-impact prerequisite. Minimize/redact provenance; attribution and initial access stay unknown. No wider access, compromise sequence or repair closure. |
| O034: 1/E2 | dynamic / observation-signals | Raw/display comparison distinguishes presentation from producer behavior. The guessed storage/queue/worker architecture is not observed ownership; full processing order remains unresolved. |
| O035: 0/E1–E2 | dynamic / observation-signals | Worker selection, state initialization/progression and prior history constrain a fresh-instance model. Request/connection identity is not state identity; no prediction or recovery workaround is imported. |
| O037: 0/E1–E2 | state / Workflow step 2 and Evidence | The override correctly prioritizes publication/policy transitions. Missing-state policy belongs to authorization; race classification needs ordering/state evidence. F2 suggests a clearer matching validation paragraph. |
| O048: 0/E2,E4–E5 | surface / auxiliary inventory | Authorized deployment metadata can prioritize entries. Printable names do not establish completeness, source recovery, handler/gate or deployed revision; no metadata-to-injection sequence. |
| O049: 1/E2 | dynamic / observation-signals | Persistent failed-run effects require explicitly permitted, verified baseline recovery. Session scope is not component-wide failure; account/cookie steps and reflection workaround are not adopted. |
| O051: 0/E1,E3; 2/E4 | dynamic / observation-signals | Diagnostics provide a partial stage model; a late absent result admits creation, removal, latency and visibility alternatives. Tentative cleanup is not a demonstrated race; no selector enumeration or access optimization. |
| O055: 0/E1–E2 | dynamic / observation-signals | Delivered metadata and body are separate evidence. Preserve delivery/error alternatives; neither appearance nor a guessed restriction proves complete stage ordering or confinement. |
| O078: 2/E3 | binary / component identity | Enumeration position is not component identity. No shellcode, loader walk, compatibility-repair recipe, named tracing tool or production-vulnerability claim is imported. |

Effective owner totals reconcile to 51: surface 3, source 9, binary 2, flow 3, dynamic 10, parser 5, auth 4, dispatch 5, patch 1, memory 1, state 1, sandbox 1, impact 2, repair 4. Compiler invariants, fuzzing and race auditing remain valid baseline owners, without forced Orange additions.

## Attribution, filtering and handoff conclusions

### Source identity and secondary origins

- **O002:** the retained packet quotations originate in the followed Phrack full publication, not the small Orange announcement. Its archive/publication receipts are separate. Merging it into O001 avoids treating companions as independent corroboration; no operational O002 citation is needed.
- **O033:** the ledger explicitly credits the directly linked DEVCORE English publication. Its body and receipt must not be attributed to the Orange wrapper.
- Preserve secondary/report status for O005/E3's reproduced specification, O019/E5's deployment-owner assessment, and O026/E5's commenter correction. O026 is context, not a source for a universal resolver law. O045's approximate routine labels depend on an unvisited third-party reference and remain contextual, not verified reconstruction.

### Tools and derived recommendations

The current policy appropriately distinguishes **source-named** from **source-operated** and **locally validated**. O004's mapping lookup and O020's policy checker are recommendations/predictions; O001's detector discussion is a coverage caution; O021's objdump belongs to a separate illustration. O014's diff, O016's debugger names and O048's curl/strings names rely on surrounding passages or listings, not the short quotation alone. Packet attribution of those purposes remains a worker/source-context assertion, not something this local review reverified on the web. O049's reflection appears in a workaround; neutral metadata inspection is derived safe-use guidance, not an author-validated benign practice. O078's tracer is unnamed. Documentation consultation is reference evidence, not an installed tool or runtime result.

The owned guides present purpose, selection condition and evidence/limit for optional observers. Existing `ctf-rev` adaptations remain credited separately; no external helper dependency or required installation is introduced. Do not promote historical tool examples into contemporary compatibility or performance claims.

### Baseline overlap and filtering

The curation deliberately avoids adding separate procedures for already-owned dependency applicability, backward tracing, bounded binary anchors, limited capabilities, repair completeness, observer silence and conventional runtime metadata. Context decisions for O026, O030, O038, O041, O043, O045–O047, O050, O054, O057, O071, O073–O074, O084 and O088–O089 are consistent with that policy. O038 has one demonstrated prerequisite problem, not a reliable second protocol-classification method. O046's second-team anecdote does not justify required agent escalation. O096's abandoned strings inspection establishes neither root cause nor safety.

Personal/promotional/pointer/slides entries and solve sequences remain excluded after inspecting their packet bodies, not because of titles. Reusable narrow observations within otherwise solution-oriented retained packets are not an excuse to import their omitted mechanics. All 67 non-included rows have no accepted indexes; their audit visibility is not operational adoption.

### Question-directed handoffs

The common envelope requires authorization/artifact identity, one falsifiable question and contrasting predictions, classified provenance, controls/unknowns, bounded next action and stop condition. H1 admits explicitly inferred entries only with a reachability question; H2 requires a safe distinguishing experiment and known-good baseline; H3 requires faithful reproducible seed/state evidence; H4 allows explicitly bounded static-only assessment but forbids impact promotion; H5 separates invariant repair from sample blocking; H6 separates source, shipped code, activation, compatibility and deployed enforcement.

The added role, representation, receiver/phase/guard, cache, failure-result, observation-stage, worker/reset, publication-policy and mediated-request fields are relevant-contract options, not a mandatory pipeline. Empty scaffold fields establish nothing. Source-only packets cannot satisfy runtime acceptance gates by listing those fields. Unadopted worker proposals—especially O033's original impact producer and O037's race recipient—do not override current owned routing. Provisional incident reporting needs an authorized recipient and traceable minimized observation, not completed exploitation; it does not satisfy H5/H6 closure.

## Checkpoint hashes

SHA-256 groups hash a deterministic UTF-8 manifest: one `sha256` + two spaces + repository-relative POSIX path + LF per file, sorted lexicographically by path, with no header. Group membership is explicit below. The overall group is their union; it excludes this not-yet-written report and all unlisted files. These receipts prove local file identity only.

| Group | Files | Manifest SHA-256 |
|---|---:|---|
| `research/orange/extractions/O001.json` through `O096.json` | 96 | `3bd297ac773b83fe43a89da6e0a5567d1676cb78c28cf43978c92c292835a1e1` |
| `skills/*/SKILL.md` | 17 | `0a85c624b2799152ce21bcd8befc206af56c049caaac13eb44a3d7ba760df61a` |
| `skills/*/references/*.md` | 10 | `24ac22dee5bde60f77f87fe5192b60f91b83ee1e885502ba684250904101cca5` |
| Contracts/method listed below | 8 | `5fcfef168aac20b0b8cc8b797878bfd76776ba1f1c3fa5492ef7d22e8f3f05ea` |
| Curation/outputs listed below | 5 | `e5346f9515cf9231f78841e4c8a55db85859df8f6e6992646a60bc474d47f761` |
| Code/tests listed below | 5 | `ac3bcd81ec317abe8bd94bca8bff109e216fc2b3d323bbbf44265c2f015687d6` |
| Stored provenance listed below | 14 | `6aab0b52f6ce3408455573602a6c3b667f2ec7bc524ee5c075880bc14a74f326` |
| Union | 155 | `9af126e8ae3346a6695d2a3dacec5bcfca070cb2bb9ef6260f5f42f358381e70` |

- **Contracts/method:** `README.md`, `HANDOFFS.md`, `templates/handoff.json`, `research/TAXONOMY.md`, `research/TOOLING.md`, and Orange `METHOD.md`, `BASELINE.md`, `WORKER.md`.
- **Curation/outputs:** Orange `inventory.json`, `curation.json`, `corpus.json`, `catalog.md`, `evidence.md`.
- **Code/tests:** `scripts/render_research.py`, `scripts/orange_research.py`, `scripts/validate_library.py`, `tests/test_library.py`, `tests/test_orange.py`.
- **Stored provenance:** Orange `source-metadata.json`, `quote-verification.json`, `quote-verification-browser-1.json`, `quote-verification-browser-2.json`, `quote-verification-browser-3.json`, `quote-verification-publication-o002.json`, `quote-verification-publication-o033.json`, `delegations.json`, `worker-runtime-receipts.json`, `native-skills.json`, `baseline-hashes.json`, `baseline-review-receipt.json`, `checks.txt`, `verification.json`.

Selected individual file hashes at the final checkpoint:

| Path | SHA-256 |
|---|---|
| `README.md` | `56f78b0fae9626279debeb1c4bc1b587f915c073ff330515b14cb1afbd5fba7b` |
| `HANDOFFS.md` | `08752890f592fbd0e13de316de308393bbe3515ce7d7bbf1df235ebc97041fa7` |
| `templates/handoff.json` | `db544ec7f0e780398a3d2dfce1fd4e051a2bbe267ba8381daea72b63c5500470` |
| `research/orange/METHOD.md` | `85d684c114ade6b04c6feb4cf36e06b1bfe621048845e689c15c27a52a9ed199` |
| `research/orange/inventory.json` | `f6c691cb16b5d252b68042585a932992cb6e5e956ca6d3cdc49ba79705cf36b6` |
| `research/orange/curation.json` | `2c30f4010d33ebe3e617c720178f6becc85feb58bb5e6bf0cc4c7873c98bc1f2` |
| `research/orange/corpus.json` | `9507232cc594584b1f6abd3feb6a891b793b27403458b24fb14638ea9d523f29` |
| `research/orange/catalog.md` | `6af5c9fc2120c6d8ddf11c9bfb6323aa95e586ee7a83d4dfb3f6fe74b5bbdd67` |
| `research/orange/evidence.md` | `5665261623564d8b90de853cc42f45b6af639932bf63cebd9d466fb7f8f846ae` |
| `scripts/render_research.py` | `2b70b835776766cc61efba902b7ad724d7e4b81b69f23f7fb7aeeebfd579eaa2` |
| `scripts/orange_research.py` | `ce266889b53330d32f0e891d75e0fb05b7a8ebe062cc5396aa85bb5084025326` |
| `scripts/validate_library.py` | `cc806f9d0f8ad31e84547c7ecc525c363f3ba4c48317db6780620d7822762f81` |
| `tests/test_library.py` | `eea12513245d709112be6e77f24a2158747b65eb7e007ac78a11cdb8487bd359` |
| `tests/test_orange.py` | `805e93a4b1e001e0f7135e13e31b4f84c62e1d5e21d1cf0cc2cfb76356a4a589` |
| `research/orange/quote-verification.json` | `de88d03d023c3cf2b7e8a9fbc5ab4b0f8ca552e1896ecec55c77ec799af5c153` |
| `research/orange/quote-verification-publication-o002.json` | `069b8fe024742cbee428a3b63747f75f379fb4036177e27507f027935b82a4f1` |
| `research/orange/quote-verification-publication-o033.json` | `47eda49d421348c8b45b851730266400779b7af5f3db637919b5d09fc75735c8` |
| `research/orange/worker-runtime-receipts.json` | `7e49f7425222d3e2f42f7354f778452872aedb9b2409dc6e5c21b739c7437893` |
| `research/orange/native-skills.json` | `04ca9fb734da2dde2ad01426b3f9245d356aea28f294f5ad1b21aa85476e8f98` |
| `research/orange/checks.txt` | `da30ae064eb7d1f34f34fcf7243867d850da5c5628c410e81cc812e64ed54436` |
| `research/orange/verification.json` | `1f935bcc3625a3bcdbc8be11b5b9228d82261de7d523c4a1733a1962c3b28eb0` |
| `research/orange/extractions/O084.json` | `f6047fe261b5859fc361fd0f5440fddb7dd8dd605f89ebf7b18035327058a214` |

## Limits and parent handoff

This review compares the current local editorial artifacts, not live original article bodies, image pixels, attachments, optional-tool help/API compatibility or target behavior. Parent source wording receipts and command logs remain their respective evidence classes. No source-author vulnerability, impact, current deployment, attribution, repair or performance result is independently established here. No complete historical-site crawl or fresh STAR Labs source audit is claimed.

The scope and hashes are checkpoint-specific. Later files/edits, including a completed verification manifest or adoption of F2, require their own binding and affected quality receipts; do not silently attach this approval to changed guidance. Only `research/orange/reviews/final-integration.md` was written by this review. Notify `w2Z:p2` after saving with the scope, F1/F2 and these evidence limits. That notification is **progress**, not parent-task completion.

## Post-review cleanup addendum

Added **2026-10-01T14:38:08.827479Z** under explicit user cleanup instruction, after the advisory review above. It supersedes the earlier checkpoint **only** for the files listed below; every substantive finding stands.

**Removed — six unreferenced files (~198 KB) with zero inbound links from docs, scripts, tests or receipts:**

- `scripts/orange_quote_bridge.py` — self-declared temporary loopback bridge; `METHOD.md` already recorded it as stopped after collection.
- `research/orange/index-browser.json`, `index-page-1.json`, `index-page-2.json` — raw browser envelopes superseded by `inventory.json` (40 + 40 + 16 rows, markers, forward chain, boundary dates).
- `research/orange/source-metadata-browser.json` — raw metadata pass; strict subset of `source-metadata.json`, which keeps O030's failed observation as `prior_observation` plus `retry_receipt` and `title`.
- `research/orange/overview-worker.md` — human twin of `overview-worker.json`, which remains the input consumed by `orchestrate_orange.mjs`.
- `scripts/__pycache__/`, `tests/__pycache__/` — build artifacts (already `.gitignore`-covered).

**Edited:**

- `research/orange/verification.json` — the empty `"artifact_hashes": {}` field is **deleted rather than populated**. This resolves F1 by withdrawing the claim, not by binding hashes: no artifact-level hash manifest exists for this project, and the receipt records command outcomes, exit codes, statistics and word counts only. The `unit_and_mutation_tests`, statistics and native-discovery fields remain.
- `research/orange/METHOD.md` — line 74 no longer claims "artifact hashes"; the review sentence now also links this third review and states the full O001–O096 checkpoint.
- `research/AUDIT.md` — the `verification.json` row is relabelled from "artifact snapshot" to "final receipt".

**Cleanup verification (run after the changes; every command exited 0):** `py_compile scripts/*.py tests/*.py`; `render_research.py --check`; `orange_research.py --check`; `orange_research.py --validate`; `validate_library.py`; `orchestrate_orange.mjs --check-runtime`; `unittest discover -s tests` → **82 tests OK**. No packet, curation, skill or reference byte was touched.

**Updated checkpoint** (same manifest recipe as above):

| Group | Files | Manifest SHA-256 |
|---|---:|---|
| Contracts/method | 8 | `8f3440835c481c415e4c295b67d2c901aef2e45956108cdb9a45837723e3ae41` |
| Stored provenance | 14 | `f1b655576fc180385c9702c95aeaad4a8db5d5bb3bba1a9fbe54e63512543804` |
| Union | 155 | `5c62107429f4f4c67d6844be411ab76824213a0fef09b146c1f84151545ad8d4` |

Unchanged from the main table: packets `3bd297ac…`, main skills `0a85c624…`, owned references `24ac22de…`, curation/outputs `e5346f95…`, code/tests `ac3bcd81…`. The `METHOD.md` and `verification.json` rows of the main table are superseded by:

| Path | SHA-256 |
|---|---|
| `research/orange/reviews/final-integration.md` | *(this file; its pre-addendum hash was `3d11fcfdbcb78b9461741cb20b4e30c0be0a366d7ba0cc5df4bc482a171bd379`)* |
| `research/orange/METHOD.md` | `3edac2ed23b9075b97c76bdc5a645c3806d08a673b7fa666b71c71e943548817` |
| `research/orange/verification.json` | `66e817d04a39f975a1f21b34cea297ff7dea95c83a01cbbc1423f9f1428e7864` |
| `research/AUDIT.md` | `544e9eb3035b8bf6605092ab00cc3d6026359b522b3e44ee4644d6a4a1aa5d64` |

Conclusions on the 51 selections, attribution boundaries and handoff gates are unaffected. F2 (optional state-skill validation wording) remains open; it is a suggestion, not a defect. The `README.md` (STAR Labs counts) hash is unchanged at `56f78b0fae9626279debeb1c4bc1b587f915c073ff330515b14cb1afbd5fba7b`.
