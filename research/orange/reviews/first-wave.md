# Orange first-wave cross-packet editorial review

## Scope and evidence standard

Local-file review of `BASELINE.md`, `WORKER.md`, root `README.md` and `HANDOFFS.md`, all 17 current skills and six owned references, `curation.json`, baseline hashes, and the complete O001–O023 extraction packets. At the single optional-packet check, **2026-09-30T09:37:23Z**, O024–O026 were present and were also read. O027–O032 were not present at that check; they are outside this review. No waiting or polling was performed.

No source pages were opened or re-extracted; no source code, targets, repository scripts, or tests were executed. Read-only JSON checks found matching packet filenames/source IDs/inventory URLs, defined cited evidence IDs, existing skill owner names, derived handoff classifications, and quotations within the worker length limit. The packets report their quotations as verified; this review does **not** independently reverify their original text or reproduce author results.

Candidate indexes below are **zero-based**, matching `candidate_additions` and `accepted_candidates`.

- **K — retain:** a distinct, bounded refinement, sometimes requiring the stated rewrite or owner change. Already-incorporated guidance is not an instruction to add it again.
- **M — merge/support only:** retain useful provenance or a narrow example under the named existing contract; **reject a separate operational addition** for that candidate.
- **R — reject:** no operational addition, because of duplication, insufficient distinct method evidence, or baseline overlap. Rejection is not a finding that the author's observation is false.

These are recommendations, not changes to curation, adoption receipts, vulnerability verification, or overall research-completion evidence.

## Editorial verdict

Prioritize **authority roles, selected contexts/receivers, cache equivalence, effective implementation bindings, and phase-specific guards**. These change what a researcher must decide or record. Do not expand the library merely with more versions of “trace the flow,” “check prerequisites,” “use a baseline,” “a crash is not execution,” or “verify deployment.” Those decisions already exist.

The current Orange-specific references are generally generic and appropriately avoid payloads and writeup sequences. Their strongest contributions are shared-field semantic roles, re-entry/continuation, diagnostic side effects, and implicit conversion edges. Preserve those as owned decision artifacts rather than copying their entire ledgers into neighboring skills.

### Current-file issues

1. **Missing provenance destination:** `research/orange/evidence.md` was absent at inspection, yet eight skills, both new references, and `HANDOFFS.md` already link to its O001/O004/O005/O008 anchors. The source packets exist, but the operational links do not currently resolve. This is a provenance/linkage issue for the orchestrator to resolve before treating the update as publishable; this reviewer has not generated the ledger.
2. **Hash-supported scope, not a reconstructed diff:** the workspace has no Git repository. Against `baseline-hashes.json`, the changed skills are attack surface, authorization, source auditing, data flow, parser differentials, dispatch, dynamic analysis, and remediation; `HANDOFFS.md` also changed. The other nine skills, four pre-existing references, root README, and STAR Labs corpus match their baseline hashes. `interaction-audits.md` and `semantic-boundaries.md` are additional reference paths outside that baseline set. Hashes establish changed files, not every historical line change.
3. **Curation stops at O008:** the inspected `curation.json` contains O001–O008 decisions only. The later recommendations below are not existing acceptance decisions. In particular, its blanket acceptance of O001[1], O004[2], and O005[3] should not mean three additional standalone procedures: their useful scope belongs in already-owned contracts.
4. The baseline's earlier renderer/validator/test results are historical receipts, not checks performed on this current update. The unchanged README's STAR Labs counts must not be presented as Orange coverage or combined with companion publications as independent method-source counts.

## Candidate-index recommendations

| Packet | Recommendation, owner, and evidence rationale |
|---|---|
| [O001](../extractions/O001.json) | **K[0] → parser-differential-auditing:** post-construction rewrites can invalidate structural extents/types; E1 supports this distinct question, already represented in the semantic-boundary guide. **R[1] → deserialization-and-dispatch-auditing:** E2 is useful dependency-bounded catalogue context, but installed types, callbacks and catalogue-versus-exposure gates already exist. **K[2] → source-code-auditing:** E3 adds the specific ordering question of diagnostic output/state preceding commitment of another protection. **K[3] → dynamic-analysis:** E4–E5 justify inspecting detector coverage at logical subobject boundaries inside enclosing allocations; retain that specific limitation, not another general “silence is not safety” paragraph. |
| [O002](../extractions/O002.json) | **R[0–3] as independent additions; canonical collection source O001.** Preserve English/Phrack companion provenance and its own E1–E4 locators. E1/E2/E4 overlap O001's diagnostic, structural-rewrite and detector observations. E3's implicit metadata decoder is historical context for the existing dispatch inventory, not a new independent method or evidence of current behavior. Recommend the duplicate disposition already selected by curation, rather than the worker's `included` disposition. |
| [O003](../extractions/O003.json) | **No candidates; retain context.** E1–E3 describe preparation and practice gaps, not discriminating research observations or transferable tool performance. |
| [O004](../extractions/O004.json) | **K[0] → data-flow-analysis:** compiler-generated startup/runtime conversions are hidden influence edges (E1). **K[1] → parser-differential-auditing:** escaping/conversion order can change final structure (E1,E3); merge with O001[0] in the existing ledger, not a parallel encoding recipe. **M[2] → dynamic-analysis / existing semantic-boundary tool table:** retain configuration-specific mapping as a prediction option, not a separate validation workflow or proof of a tool run (E1–E3). **K[3] → remediation:** entry/type/downstream migration and separate distributor/build responsibility are the useful specifics (E4–E5), already incorporated. |
| [O005](../extractions/O005.json) | **K[0] → source-code-auditing:** choose writer/reader relationships with conflicting mutation rights/meanings (E1–E2). **K[1] → parser-differential-auditing:** roles and provenance per pass, including possible re-entry (E2–E3); the specification excerpt motivates a question, not observed inherited state. **K[2] → deserialization-and-dispatch-auditing:** error-response writes can change later behavior selection if the intended terminal state is not terminal (E2,E4). **M[3] → remediation:** fold terminal-error and equivalent-caller properties into the existing regression matrix (E4–E5); “one blocked path is not repair” is already baseline advice. |
| [O006](../extractions/O006.json) | **No candidates; retain context.** E1–E2 are fragments of one patch-assumption reflection. Do not import the linked advisory's mechanism or current applicability. |
| [O007](../extractions/O007.json) | **No candidates; retain context.** E1–E5 are useful architectural trends, not a primary observation/probe/validation record. Do not count the survey as independent confirmation of the more concrete interaction or authority findings. |
| [O008](../extractions/O008.json) | **K[0] → attack-surface-mapping:** effective peer authority inherited from installation/membership belongs in the architecture map (E1–E2). **K[1] → authorization-auditing:** legitimate identity classes differ by consumer, so an identity prohibition is not portable without accepted-operation controls (E3). **K[2] → remediation:** shipped code and activated enforcement are separate states, with compatibility/rollout provenance (E4–E5). All three are already incorporated; do not re-add them. |
| [O009](../extractions/O009.json) | **K[0] → parser-differential-auditing:** cache-key equivalence must preserve downstream response-selection meaning within an explicitly declared context (E1–E2). **K[1], reassign binary-auditing → source-code-auditing:** record/key/extraction/hash/equality relationships are an application contract, not an intrinsically binary technique (E3–E4). Merge its interaction selection into the existing source reference; binary auditing supplies reconstruction only when source is unavailable. **K[2] → authorization-auditing:** map composite comparison operands to independent identity fields; a repeated operand suggests missing coverage but does not prove intended semantics or reachable bypass (E5). |
| [O010](../extractions/O010.json) | **No candidates; retain excluded/pointer-only.** E1 identifies a cross-post announcement, not an inspected technical body. The label does not establish another in-corpus duplicate. |
| [O011](../extractions/O011.json) | **M[0] → existing data-flow-analysis and O012 authority model:** backward identity-establishment tracing adds useful provenance, not a new bidirectional-flow procedure (E1). **K[1] → source-code-auditing:** distinguish exceptional early and later rejection paths by their observable processing progress (E2–E3); this is a source-selection question, not a cryptographic recovery procedure. **M[2] → dynamic-analysis:** attach the stage-to-observation corroboration requirement to the existing H2 contract (E2–E3), rather than duplicate experiment design. **M[3] → exploitability-assessment:** retain protected-input acquisition as a missing capability edge (E4–E5); existing capability-gap rules already own it. |
| [O012](../extractions/O012.json) | **K[0] → attack-surface-mapping:** distinguish caller, intermediary credential/admission, trusted metadata writer, and reconstructed downstream client (E2–E4). **K[1] → source-code-auditing:** same-named compatibility components may have changed responsibilities and trust contracts; compare actual roles across revisions (E1–E2). **K[2] → parser-differential-auditing:** record selected context and metadata meaning at each layer (E2,E4–E5). **K[3] → authorization-auditing:** intermediary authentication, client reconstruction, and client action authority are independent contracts (E3–E4). These are related but different owner questions, not four copies of architecture advice. |
| [O013](../extractions/O013.json) | **No candidates; retain excluded/teaser.** E1–E3 report a lab recreation and unknown-environment difficulty but delegate methods to uninspected media. It cannot support a web-to-binary handoff recipe. |
| [O014](../extractions/O014.json) | **R[0]:** artifact age/provenance/build equivalence already belong to acquisition/binary and common-envelope gates; E1's public indexing is not authorization. **M[1] → parser-differential-auditing:** corroborates the front-gate/consumer distinction retained from O012 (E2). **R[2]:** missing environmental prerequisites already belong to impact assessment (E3). **K[3] → patch-diff-analysis:** scope published negative evidence to the actual rejection guard and dependency revision (E4–E5). Keep absence of a static guard as a question, never positive reachability evidence. |
| [O015](../extractions/O015.json) | **M[0] → attack-surface-mapping:** built-in help is an explicit inventory source, not exhaustive dispatch or a new source/binary routing taxonomy (E1–E2,E4). **R[1]:** bounded, hypothesis-led handler selection and retained negative coverage already exist in binary auditing (E3–E4). **K[2] → deserialization-and-dispatch-auditing:** explicitly include unmatched-input/default-delegation behavior independently of advertised operations (E4). **M[3] → remediation:** manual versus bulk cohorts are useful deployment-inventory detail (E5), not a separate rollout procedure. |
| [O016](../extractions/O016.json) | **K[0], reassign source-code-auditing → data-flow-analysis, with narrower wording:** ask whether changing stored contents satisfies independent index/key/retrieval predicates before claiming consumer-visible control. E1 establishes a hash-table consumer, but does not itself quote the separate predicate failure; retain a conditional derived review question, not a proven general mechanism. Relate it to O009's record/key contract. **K[1] → exploitability-assessment:** include effective producer input-emission order as a configuration-dependent feasibility constraint (E2–E3); this is layout/representation applicability, not an exploit trigger sequence. |
| [O017](../extractions/O017.json) | **M[0] → source-code-auditing / O020[0]:** a feature-specific relaxation changes the normal contract (E1); merge the exception-review lens. **K[1] → source-code-auditing:** resolve the effective replacement implementation/parser before inheriting a familiar builtin's semantics (E2). **R[2]:** optional-feature and format compatibility preconditions are already baseline impact gates (E3,E5). **M[3] → dynamic-analysis:** preserve explicit `dmesg` attribution and fault-only scope (E4), but the existing least-invasive log/crash observation route needs no duplicate step. |
| [O018](../extractions/O018.json) | **K[0] → binary-auditing:** provisional upstream-source correspondence plus registration tables can bound a symbol-poor handler slice, with local modifications and confidence recorded (E1–E2). **K[1] → memory-safety-auditing:** sizing/emission branch agreement is the distinct capacity question (E3); keep any “already-transformed input” class as a derived test class unless separately evidenced. **M[2] → exploitability-assessment, with state/lifetime input:** framework reclamation boundaries corroborate existing allocation/lifetime constraints (E4); no heap-control recipe. **R[3]:** E5 only reports starting to fuzz, without engine/harness/corpus/reset/coverage/reproducibility evidence. It does not establish a bounded static-reconstruction workflow or a new fuzzing-navigation method. |
| [O019](../extractions/O019.json) | **M[0] → patch-diff-analysis:** failed newer-deployment reproduction reopens applicability, but comparable old/new artifacts are already required (E1). **K[1] → dynamic-analysis, explicitly defensive:** use documented consumer semantics to choose a non-crash observation; timing must have a safe work ceiling and confounder controls (E2–E4). The author's work-amplifying example is not itself a harmless test. **M[2] → exploitability-assessment:** preserve deployment-owner attribution and residual-access uncertainty (E5); existing capability-gap/isolation assessment owns this. |
| [O020](../extractions/O020.json) | **K[0] → source-code-auditing:** compare custom pass-through/preservation callbacks against the library's default guarantee (E1–E2), together with O017's feature exceptions. Do not infer upstream correctness from project maturity. **M[1] → parser-differential-auditing:** use inert-classification versus final structural meaning as evidence for the existing semantic-role ledger (E2–E3), not another HTML-specific workflow. **M[2] → sandbox-boundary-analysis:** insertion, execution policy and remaining capabilities already have separate gates (E4–E5); retain the explicit policy-checker recommendation and its non-enforcement limitation. |
| [O021](../extractions/O021.json) | **K[0], reassign source-code-auditing → deserialization-and-dispatch-auditing:** user-influenced preparation hooks can select behavior before ordinary execution (E1,E4); source auditing merely selects the slice. **M[1] → dynamic-analysis:** phase-specific dependency/class-loading differences refine the existing original-versus-modified configuration packet, not a new retry workflow (E3). **K[2] → sandbox-boundary-analysis:** bind each guard to its actual processing phase and preserve independent authorization/isolation gates (E1,E4). Do not create a compiler-invariant addition solely because compilation occurs. |
| [O022](../extractions/O022.json) | **K[0] → deserialization-and-dispatch-auditing:** framework naming conventions, inherited members, and returned receivers determine the effective callable set (E1–E3). **K[1] → authorization-auditing:** evaluate the effective receiver/action after traversal, not the entry prefix alone, retaining independent action checks (E3,E5). **M[2] → exploitability-assessment:** distinguish reachability, result observability and protected effect under the existing evidence ladder (E4–E5). No returned-object invocation sequence belongs in the skill. |
| [O023](../extractions/O023.json) | **No candidates; retain excluded/solution sequence.** E1 supports only a challenge-specific lifetime caveat. No generic race or transient-state addition is justified without a distinct method and feasible-schedule evidence. |
| [O024](../extractions/O024.json), optional | **M[0] → parser-differential-auditing:** another layered guard/consumer example for O012/O005, not a new canonicalization step (E1). **M[1] → dynamic-analysis:** a later missing-identity failure distinguishes progress from completion under existing handler-observation gates (E2). **K[2] → deserialization-and-dispatch-auditing:** an allowed operation's controlled return can become input to a second interpreter; record return provenance and that consumer's independent checks (E3–E4), without copying the operation chain. **R[3]:** semantic policy versus lexical blacklist is already baseline guidance (E1,E5). |
| [O025](../extractions/O025.json), optional | **R[0–2]; recommend excluded from operational method corpus.** Regex grammar inspection, console/application preprocessing disagreement, and remaining policy restrictions (E1–E4) are supported observations but do not provide a distinct approach beyond this worked solution and the existing parser/dynamic/sandbox contracts. Preserve the filtering record and explicit analyzer mention; no solution sequence or new candidate is needed. This differs from O001's broader retrospective, which supplies distinct structural-rewrite and protection-order questions. |
| [O026](../extractions/O026.json), optional | **R[0]:** dependency/feature/input applicability is already baseline (E1–E2). **R[1]:** narrow behavioral corroboration is already baseline, and E3's “confirm the vulnerability” wording must not make a callback prove the full boundary or impact. **M[2] → deserialization-and-dispatch-auditing:** retain resolver/type-representation failure as scoped context, with E5 attributed to the quoted commenter, not independently established runtime law. **R[3]:** inspecting tool modules before reimplementation is generic engineering advice, not a distinct source-audit decision (E4). The packet may remain an evidence-only included account of dependency and failure analysis; no separate operational addition is recommended. |

## Concrete, generic owned refinements

The following are proposed formulations, not edits. Cross-links should move the question to its owner rather than recreate the workflow in every skill.

### 1. Architecture and front-to-back authority

**Owners:** attack-surface-mapping for topology/roles; authorization-auditing for identity binding and action policy. **Evidence:** O012[0,3]:E2–E4; O008[0,1]:E1–E3.

Extend the interface row with **external actor, intermediary execution identity, admission mechanism, trusted-metadata writer, reconstructed client identity, and final policy consumer**. Record whether client-supplied metadata is removed, replaced, validated or merely forwarded. That last field is a derived review requirement, not a reported universal implementation behavior. Authenticate the intermediary and authorize the represented client as separate questions. Effective peer rights and legitimate peer operations must be evidenced for each consumer; internal network placement or a valid service credential proves neither client identity nor action authority.

### 2. Semantic/canonicalization boundaries and context

**Owner:** parser-differential-auditing; data-flow-analysis owns upstream influence edges. **Evidence:** O001[0]:E1; O004[0,1]:E1,E3; O005[1]:E2–E3; O012[2]:E2,E4–E5.

Add **selected context, field role, effective runtime conversion, original/canonical value, check guarantee, later writer and re-entry state** to the already-owned ledger. Ask whether a transformation or context change preserves the guarantee at consumption, even when bytes are unchanged. Data flow records hidden startup/library edges; parser review compares meanings. A repair need not unrealistically impose one global parser across independent components, but must preserve one authoritative semantic contract through all later transformations.

### 3. Framework routing and returned behavior

**Owner:** deserialization-and-dispatch-auditing; authorization-auditing owns effective-action permissions. **Evidence:** O022[0,1]:E1–E3,E5; O015[2]:E4; O024[2]:E3–E4.

Record **resolution convention, actual receiver type, eligible inherited members, returned receiver/value, default/fallback behavior, next consumer, and independent action checks**. The closed selectable set must cover downstream receivers and reinterpretation, not only registered root entries. An allowed entry or first operation is not a transitive behavior or authority guarantee. Stop at the next unresolved receiver/check; do not turn this model into a traversal sequence.

### 4. Cache selection, record identity, and consumed influence

**Owners:** parser-differential-auditing for key/consumer meaning; source-code-auditing for callback-contract selection; authorization-auditing for identity binding; data-flow-analysis for storage-to-retrieval influence. **Evidence:** O009[0–2]:E1–E5; O016[0]:E1.

Within a declared shareable cache context, **equal keys must not merge distinct downstream response-selection meanings**. Record duplicate-field policies and all context dimensions relevant to the actual consumer. Actor/tenant, route, policy, vary dimensions and state are proposed context questions, not extra measured findings from O009. Do not require byte-identical responses regardless of time or dynamic state, or infer that every dimension must literally appear in every cache key.

For indexed records, record **record → extracted key → bucket selection → equality operands → consumed identity/value**, with validity/state checks where relevant. Hash/bucket agreement is not full identity equality. A repeated comparison is a review lead until intended independent fields and collision/cache-state prerequisites are established. Changed stored bytes do not automatically change retrieved meaning; independent lookup predicates must be checked.

Use state-and-lifetime auditing only when record validity/reuse across transitions is the missing question. Use race auditing only with evidence for an interleaving. A cache is not automatically a compiler invariant or race defect.

### 5. Protection ordering and rejected-operation disclosures

**Owner:** source-code-auditing; dispatch owns mutated selectors; dynamic analysis corroborates stage observations. **Evidence:** O001[2]:E3; O005[2]:E2,E4; O011[1]:E2–E3.

For a security check or failure, record **when protection becomes effective, diagnostic/state side effects, intended terminal transition, actual continuation, and externally visible progress**. Two denied operations may disclose different protected processing stages. A changed response does not identify that stage without corroboration and does not imply handler completion or usable identity. Keep this as contract/failure-path review, not a recovery oracle recipe.

### 6. Effective implementation and integration exceptions

**Owner:** source-code-auditing. **Evidence:** O012[1]:E1–E2; O017[1]:E2; O020[0]:E1–E2; O017[0]:E1.

Before inheriting an API's expected guarantee, resolve the **actual wrapper/replacement/override and its revision-specific responsibility**. Compare a customization's accepted classes and guarantees with the ordinary library path. Same names, mature dependencies and a strict default branch do not establish equivalent contracts in compatibility or preservation paths. This extends convention-aware slice selection; it does not mandate upstream auditing or rank every override as defective.

### 7. Preparation phases and policy coverage

**Owners:** deserialization-and-dispatch-auditing for preparation hooks; sandbox-boundary-analysis for phase-specific enforcement. **Evidence:** O021[0,2]:E1,E4; O021:E3 for dependency scope.

Record **phase, actor-controlled selector, available dependencies, hook, execution identity and guard coverage**. Parsing/compilation may invoke behavior; a runtime guard cannot establish containment in an earlier phase. Integrated phase dependencies must match the assessed environment. This is not an optimizer-inference finding: compiler-invariant-auditing should receive a packet only when an inferred fact, invalidator and stale/unsound consumer are actually identified.

### 8. Two-pass capacity contracts

**Owner:** memory-safety-auditing. **Evidence:** O018[1]:E3.

Compare **sizer and emitter input classification, branch predicates, units, emitted extent and allocated capacity** as one relation. Require the estimate to cover actual emission for the relevant input classes. Parser auditing receives semantic disagreement only when that is the unresolved question; memory auditing owns the first invalid access. No emitter sample or allocator arrangement is needed in the generic guide.

### 9. Historical negative evidence and emission-order limits

**Owners:** patch-diff-analysis for guard applicability; exploitability-assessment for deployment-dependent feasibility. **Evidence:** O014[3]:E4–E5; O016[1]:E2–E3; O019[0]:E1 as supporting context.

Attach a failed observation to **artifact/dependency revision, actual rejection guard, configuration and untested alternatives**. A guard absent in another revision proposes an applicability question, not demonstrated behavior. Include effective input-emission order when it affects a layout-dependent claim, while preserving dispatch and feature prerequisites. Do not transfer conclusions solely from similar-looking configuration or turn this ordering field into an attack sequence.

### 10. Observation options and detector coverage

**Owner:** dynamic-analysis. **Evidence:** O001[3]:E4–E5; O004[2]:E1–E3; O019[1]:E2–E4.

When choosing an observer, record its **semantic/physical boundary coverage and perturbation limits**. A mapping table predicts possible conversion; a detector may miss logical extents within a larger allocation; neither resolves actual consumer behavior. For indirect timing observations, prefer benign ordinary effects, impose an explicit work/time ceiling, and check matched load/network conditions and repetitions. Abort observations with uncontrolled work growth. These controls are defensive synthesis; the source's amplification example is not imported.

### 11. Upstream-assisted reconstruction

**Owner:** binary-auditing. **Evidence:** O018[0]:E1–E2.

Use recognizable upstream code and registration tables as **provisional anchors**, recording correspondence confidence, local modifications, requested/recovered handler coverage and shipped-artifact identity. Corroborate consequential differences against the actual binary or a bounded observation. Upstream similarity is neither implementation identity nor interface reachability.

### 12. Repair coverage and active enforcement

**Owner:** remediation; authorization supplies legitimate consumer identities. **Evidence:** O004[3]:E4–E5; O008[2]:E4–E5; O005[3]:E4–E5 and O015[3]:E5 as supporting scope.

Keep the existing repair matrix, with distinct columns for **entry/type/downstream representation migration, build/distributor ownership, shipped code, activated policy, accepted peer operations, and residual deployment cohorts**. Terminal-error tests must assert preserved safe state/termination, not just rejection of one sample. Manual-cohort status is evidence for deployment scope, not a new remediation pipeline. No closure based on package presence, a historical default or a vendor completion statement alone.

## Derived handoff gates and cross-domain ownership

All inspected handoffs are labeled `derived`, which is correct. Their controls, packet fields, budgets and acceptance tests are library contracts—not evidence that the authors used these skills, safe controls, or agents. Do not append every packet's handoff as a new global H-number.

| Missing question | Producer → consumer | Minimum derived acceptance gate / return condition |
|---|---|---|
| Who grants authority across the intermediary? | attack-surface-mapping → authorization-auditing | Topology/actor row, separate intermediary admission and represented-client binding, metadata provenance, legitimate-operation expectations, actual policy consumer and confidence labels. Return missing identity origin or effective rights; a listener or credential alone is insufficient. O012:E2–E4; O008:E1–E3. |
| Does routing/context preserve checked meaning? | source-code-auditing or data-flow-analysis → parser-differential-auditing | Actual check and consumer, representations plus selected contexts/roles, writer/re-entry map, feasible gates and contrasting interpretations. Static unknowns are allowed when labeled; do not require runtime proof just to request static review. O005:E2–E3; O012:E5. |
| Does receiver traversal imply action authority? | deserialization-and-dispatch-auditing → authorization-auditing | Effective receiver/action and gates, permitted behavior set, independent action policy and remaining checks. Return theoretical invocation without receiver/gate evidence. No object-chain transfer. O022:E1–E3,E5. |
| Can a cached selection be reused for this consumer? | parser-differential-auditing or source-code-auditing → authorization-auditing / remediation | Declared shareable context, key/consumer interpretations, identity/equality operands, cache-state prerequisites, normal controls and supported consequence or explicit static-only status. Return hash equality alone, undeclared context, or alleged impact lacking a policy consumer. O009:E1–E5. |
| Is changed storage actually consumed? | source/binary audit → data-flow-analysis or dynamic-analysis | Storage and retrieval slice, actor-controlled subset, index/key predicates, effective emission order/configuration, before/after consumer predictions. Return changed bytes without lookup/consumer evidence. O016:E1–E5. |
| Does preparation cross the claimed guard? | source/dispatch audit → sandbox-boundary-analysis | Phase and hook, dependency environment, guard locations, execution identity, reachability and remaining policy layers. Return “compile-time” as a complete escape claim or a standalone demonstration substituted for integration evidence. O021:E1–E4. |
| Does a web-facing input reach a native capacity/lifetime defect? | source/binary/data-flow audit → memory-safety-auditing, then bounded impact assessment if needed | Preserve the original actor/route/configuration gates, actual consumer and representations, sizing/emission relation or suspected first invalid operation, allocation/object scope and observed-versus-inferred labels. Native fault evidence does not establish missing web gates or stronger authority. O018:E1–E4; O001:E4–E5. |

These gates refine H1/H2/H4/H5/H6 rather than create a fixed front-to-back pipeline. Choose the consumer by the unresolved question. Do not let a blanket source report satisfy a positive local-observation gate, and do not reject a well-labeled static hypothesis merely because no target was run.

## Correctness, tool attribution, and provenance cautions

### Companion publications and secondary evidence

- **O001/O002 are one methodological source family.** O001:E3 ↔ O002:E1 share warning/protection ordering; O001:E1 ↔ O002:E2 share post-construction structural rewriting; O001:E5 ↔ O002:E4 share detector/allocation limits. These packet-level correspondences support editorial deduplication, not an independent full translation comparison.
- **O002 quotes belong to Phrack**, not the short assigned Orange English page. Preserve assigned URL, followed full-publication link, fetched Phrack destination, response ID and section locators separately. Local `source-metadata.json` identifies the Orange page as a successful small HTML response at its Orange URL; that receipt/hash is not a Phrack body receipt. Do not describe link-following as an observed HTTP redirect or transfer the landing-page hash to the quotations. Retain the legacy and descriptive Phrack link spellings as observed pointers, without asserting unverified alias identity.
- O002:E3 adds a companion quotation but not an independent finding. Its historical implicit-decoding limitation must travel with any contextual mention, including the packet's reported interpreter behavior change.
- O005:E3 is a reproduced specification excerpt; O019:E5 is a quoted deployment-owner statement; O026:E5 is a quoted commenter's correction. Preserve these distinct origins. Neither `verified: true` nor an exact quote makes their underlying implementation or isolation claim independently verified.
- O004, O021 and O022 report cross-post/translation pointers. A pointer alone is not another inspected source or independent corroboration. O010's pointer-only exclusion is therefore consistent with retaining O002's expressly inspected companion as duplicate provenance, not technical evidence from the landing page.

### Explicit is not synonymous with used or validated

| Source/tool | What may honestly be retained |
|---|---|
| O001 PHPGGC; O001/O002 ASAN | Explicit catalogue/detector discussion, not demonstrated author runs or tool configurations. Catalogue possibilities do not establish installed/reachable behavior; detector difficulty has no local receipt. |
| O004 Best-fit Mapping Grepper | Explicit recommendation/lookup purpose; the worker did not operate it. Predictions require the effective API/runtime encoding, not a console setting. |
| O014 `diff`; O016 GDB/PEDA; O021 `objdump` | Workers report adjacent listings/prompts, while their short E-quotes do not themselves name all tools. Preserve the adjacent-listing locator/verification context in future evidence rendering rather than claiming the quotations alone prove tool attribution. `objdump` concerns a separate C++ illustration, not the service's preparation-phase reachability. |
| O015 built-in help; O017 `dmesg` | Explicit enumeration/diagnostic purposes; an advertised listing is incomplete dispatch evidence, and a fault record is fault evidence only. A suggested diagnostic is not automatically a documented run. |
| O019 API manual | Explicitly consulted documentation used to reason about an observable; not empirical validation of the deployed consumer or of safe workload. |
| O020 CSP Evaluator | Explicit recommendation, not reported author use or runtime policy enforcement. |
| O025 regex101 | Explicit author use, with unknown engine/dialect/flags and path equivalence. Exclusion of the solution does not require relabeling this bibliographic observation as derived. |
| O026 ysoserial | Explicit source-reported use/source inspection, but operational gadget/protocol procedures remain excluded. Do not promote it to a required generic observation tool or interpret one network side effect as the full vulnerability. |

The tool options in `interaction-audits.md` and `semantic-boundaries.md` are correctly labeled derived. Preserve this distinction when merging later packets; named demonstration utilities need not become skill-tool entries. Empty tool lists in O005/O008/O018/O022 are defensible, not evidence gaps to fill by inference.

### Specific support and historical limits

- **O022:E2 is an overbroad Java slogan.** Do not adopt “everything is a subclass” as a library fact. Determine actual receiver types, inherited members and framework eligibility rules; primitive and other type categories cannot be inferred from that sentence.
- **O016:E1 supports investigation of a table-managed consumer**, not, by itself, the particular independently stored metadata obstruction. Its retained candidate should be a conditional question. E4–E5 support before/after observation, not complete consumer acceptance.
- **O018:E5 is thin fuzzing evidence.** The packet's workflow language about bounded static reconstruction is not established by that quotation. Preserve the brief author pivot and stated missing campaign details; do not invent a harness, engine, coverage oracle, minimization or budget.
- **O019's non-crash timing method can still be disruptive.** Safe ceilings, matched controls and confounder checks are derived safeguards, not observed author practice. Avoid importing work-amplifying probes as a benign default.
- **O008's disabled/default hardening prose and later postscript belong to different rollout phases.** Likewise package delivery and manual activation differ. Do not describe old defaults as present-day defaults or the unimplemented stronger backend proposal as demonstrated impact.
- Carry O004's effective encoding/API/build-distributor constraints; O005's module/configuration/directory-policy limits; O009's cache context, existing-record/collision reachability and probabilistic limitation; O016's dispatch/input-order prerequisites; O017's administrator-enabled feature limits; O018's framework reclamation/allocator separation; O021's integration dependencies; and O022's actor/plugin/version gates with their evidence. None establishes current-release exposure.
- O025 and O023 should not acquire operational additions simply by replacing challenge names with generic nouns. Conversely, a retained article may contribute evidence while all its candidates are rejected as baseline overlap. Source disposition and candidate novelty are different decisions.

## Orchestrator action priorities

1. Resolve the missing Orange evidence destinations and companion/secondary provenance before relying on operational citations.
2. Preserve and consolidate the already-added semantic, interaction, conversion and activation refinements; do not append duplicate baseline advice.
3. Review O012/O022/O009 first for the new authority, routing and cache decisions; then the phase-aware O021/O024 behavior boundaries.
4. Make the stated owner changes for O009[1], O016[0] and O021[0]. Keep source selection, influence proof, semantic comparison, behavior selection and policy consequence distinct.
5. Retain the narrower sizing/emission, revision-scoped negative evidence, effective implementation and upstream-correspondence refinements. Reject the unsupported fuzzing expansion and solution-derived generic restatements.

No skills, extraction packets, scripts or curation were changed by this review.
