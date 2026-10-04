# Orange Method Evidence

Method observations are source-author reports, not target replications. Small source quotations establish provenance only. Workflow paraphrases and proposed handoffs do not establish vulnerability or current exposure.

The orchestrator's accepted candidates, editorial qualifications and operational citations govern inclusion. Unselected candidates and worker handoff proposals remain auditable but are not adopted procedures. Explicit tool attribution means source-named, not necessarily source-operated or locally tested.

Independent wording/source checks: [quote-verification.json](quote-verification.json). All article packets, including contextual/excluded and duplicate entries, remain in the [catalog](catalog.md).

## O001

**Article:** [(繁中) The Art of PHP — My CTF Journey and Untold Stories!](https://blog.orange.tw/posts/2025-08-the-art-of-php-ch/)
**Worker:** `worker-o001v001`; [packet](extractions/O001.json).
**Orchestrator decision:** Retain post-construction transformations, security-check side effects and detector-coverage limits; omit challenge solutions and exploit construction.
**Editorial qualifications:** Reject candidate 1 as a separate addition: dependency-bounded catalogue review already exists. Catalogue discussion is not exposure or a tool run.

**Method evidence (short source quotations):**
- **E1** — 2.1 - The “Serialize-Then-Replace” Pattern; opening paragraph beginning 在記憶中，我最早是從: “它巧妙利用了應用程式對字串的額外操作：打破既有的序列化格式、使內容跳脫出原有的語意，並在最終被當成一個全新的物件！”
- **E2** — 2.3 - The “Holy Grail” of Deserialization Attacks; opening paragraph beginning 雖然前面提了不少反序列化漏洞: “雖然前面提了不少反序列化漏洞，但這些問題究竟能造成多大危害，最終仍取決於環境中存在哪些類別。即使已經有著像是 PHPGGC 這樣的專案，持續在收錄、並完善更多的 POP 鏈”
- **E3** — 1.2 - When Security Features Make You Less Secure; paragraph beginning 當然！Philippe Dourassov, after the first illustrative code block: “然而這段警告也恰巧違背了「Response Header 前不能有任何輸出」的這個假設”
- **E4** — 5.2 - From CTF to Real World!; paragraph beginning 儘管 d90pwn 沒能在時間內解出這道題目, describing the empty-field disagreement: “Nginx 會產生一個內容為空的 PATH_INFO，而負責接收的 PHP-FPM 又始終假設該變數不能為空。”
- **E5** — 5.2 - From CTF to Real World!; paragraph beginning 綜觀整個 PHP 安全史, discussing fuzzing and detector limitations: “PHP 所分配的連續記憶體區塊更是大大提高了像是 ASAN 這類工具的檢測難度”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `parser-differential-auditing` / workflow: Include post-encoding replacements and later restoration passes in the representation map. Check whether declared lengths, field boundaries and types still match the consumed structure after every transformation; prior structural encoding is not a transitive safety guarantee. (evidence E1).
- `source-code-auditing` / heuristic: Review security-limit error paths as producers of output and state changes. Check whether warnings, partial results or exceptions occur before a downstream protection is committed, and whether its ordering invariant survives those side effects. (evidence E3).
- `dynamic-analysis` / failure: When a detector is quiet, retain independently suspicious producer–consumer contracts. Document the detector's allocation and object-boundary coverage, then resolve the specific consumer assumption through source review or a bounded benign observation; absence of a finding is not evidence that the contract is safe. (evidence E4, E5).

**Tool attribution:**
- PHPGGC → Explicitly cited as a catalogue collecting and maintaining dependency-specific deserialization behavior. This records the project's stated purpose, not an author run, selected entry or constructed chain. → Context: assessing why reconstruction consequences depend on the available classes. Catalogue coverage does not establish installed or reachable behavior.; **explicit** attribution.
- ASAN → Explicitly discussed as a memory-error detector whose effectiveness can be limited by the allocation layout. The article supplies a detection caveat, not a documented sanitizer experiment. → Context: evaluating diagnostic coverage for a defect crossing component assumptions within contiguous allocated memory; no run configuration or negative-result receipt is provided.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `data-flow-analysis` → `parser-differential-auditing` when A value is structurally encoded and subsequently rewritten before a later parser consumes it, leaving preservation of structure or meaning unresolved.. Packet: scope, authorization and artifact/runtime identity, one falsifiable structural-preservation question, actor control and feasible gate constraints, representation chain, including persistence and later consumption, transformation guarantees and structural invariants, evidence references, collection metadata and original-versus-modified environment, contrasting benign interpretations, negative controls and untested paths, fact-versus-inference classification and next bounded review with stop condition. Gate: Identify the actual consumer and each intervening transformation. Provide contrasting interpretations or explicitly mark the discrepancy as static-only with a safe validation question. The presence of an encoder or sanitizer alone is not accepted as preservation evidence.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `dynamic-analysis` → `memory-safety-auditing` when A producer–consumer anomaly raises a native access question that generic detector coverage does not resolve.. Packet: scope, authorization and original/instrumented artifact identities, minimal producer–consumer slice and field contract, one unresolved access invariant and contrasting predictions, benign baseline and bounded observation receipts with collection metadata, first suspected or observed invalid operation, with confidence classification, logical object extent versus enclosing allocation extent, or explicit unknowns, detector coverage, layout changes and other observer limitations, negative controls, remaining constraints and next bounded review with stop condition. Gate: Require an identified field contract and a specific suspected or observed consumer operation, clearly separating static hypotheses from observations. A response anomaly or absence of a sanitizer finding alone cannot establish an invalid access or security impact.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical retrospective combining firsthand commentary and third-party discoveries, not a controlled research log. All vulnerability, bypass and repair results remain author reports; only the article and quotations were independently inspected.
- The representation example requires an additional post-encoding transformation and later reconstruction. Transfer to another system requires evidence of actor influence, transformation behavior and the real consumer; these examples do not establish such a path elsewhere.
- The warning/output interaction depends on diagnostic rendering and response/output-buffer configuration. The article provides an illustrative ordering failure, not a configuration matrix or current-deployment validation.
- Available reconstruction behavior is dependency-specific. PHPGGC is cited, not shown being run; ASAN appears as a detection limitation without tool version, build settings or coverage receipts. The historical producer–consumer and allocator example cannot be generalized to every integration or current release.

**Operational owners:** [deserialization-and-dispatch-auditing](../../skills/deserialization-and-dispatch-auditing/SKILL.md), [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md), [parser-differential-auditing](../../skills/parser-differential-auditing/SKILL.md), [source-code-auditing](../../skills/source-code-auditing/SKILL.md)

## O004

**Article:** [WorstFit: Unveiling Hidden Transformers in Windows ANSI!](https://blog.orange.tw/posts/2025-01-worstfit-unveiling-hidden-transformers-in-windows-ansi/)
**Worker:** `worker-o004v001`; [packet](extractions/O004.json).
**Orchestrator decision:** Retain implicit runtime conversions, transformation order, configuration-specific predictions and end-to-end representation/build ownership.
**Editorial qualifications:** Candidate 2 is merged support for the owned observation/semantic guide, not another procedure. Explicit mapping lookup was not operated; predictions require actual consumer evidence.

**Method evidence (short source quotations):**
- **E1** — Decoding the Windows Encodings / The Dual Era of Encoding; paragraph beginning 'This happens because, during compilation', following the argument/environment demonstration.: “This happens because, during compilation, the compiler inserts several functions and links the CRT DLLs for you, which internally rely on ANSI Windows APIs.”
- **E2** — It was the Worst of Fit – The novel attack surface on Windows / 🔥 Filename Smuggling; opening paragraph, sentence identifying the mapping lookup tool.: “You can check the affected characters and Code Pages on our Best-fit Mapping Grepper tool!”
- **E3** — It was the Worst of Fit – The novel attack surface on Windows / 🔥 Argument Splitting; paragraph beginning 'However, all of this escaping happens'.: “However, all of this escaping happens before the Best-Fit feature comes into play.”
- **E4** — The Dusk–or Dawn–of the WorstFit / 🧐 Who is responsible for that?; paragraph beginning 'To make things even more confusing'.: “some projects only provide source code, leaving the prebuilt executable files distributed to be handled by third-party volunteers across the Internet.”
- **E5** — The Dusk–or Dawn–of the WorstFit / 😖 It’s really hard to fix it!; first paragraph, sentence describing the limits of an entry-point-only change.: “However, resolving this problem isn’t that as simple as just replacing the main() with its wide-character counterpart.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `data-flow-analysis` / heuristic: Include compiler-generated startup and runtime-library conversions as representation edges, even when application source contains no explicit conversion call. Keep unresolved edges separate from proven actor influence. (evidence E1).
- `parser-differential-auditing` / workflow: Record escaping as a position in the transformation sequence, not an unconditional safety guarantee. Ask whether a later representation change can introduce structural meaning before the final parser consumes the value. (evidence E1, E3).
- `dynamic-analysis` / validation: Use configuration-specific mapping evidence to formulate contrasting predictions, then require a benign baseline and consumer-value evidence. A lookup table predicts a conversion class but does not prove reachability or impact. (evidence E1, E2, E3).
- `remediation` / remediation: For representation migration, review entry handling, variable types, downstream parsing and remaining conversions as one contract. Track source ownership separately from build distribution, and require compatibility and shipped-artifact evidence before closing the repair. (evidence E4, E5).

**Tool attribution:**
- Best-fit Mapping Grepper → Inspect character conversion mappings and their code-page applicability. → A suspected narrowing conversion needs configuration-specific mapping evidence.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `data-flow-analysis` → `dynamic-analysis` when A representation trace includes a possible implicit conversion after validation, but the exact value received by the consumer is unresolved.. Packet: Common scope, artifact identity, question, evidence classification, limits and stop condition, Actor-controllable subset and feasible gates, Representation chain including generated startup and runtime edges, Validation and escaping positions with their stated guarantees, Effective encoding configuration and mapping hypothesis, Contrasting predictions, benign baseline, observation points and modification budget. Gate: The proposed bounded observation must distinguish preservation from reinterpretation at the actual consumer. Mapping-table entries alone do not establish reachability, security impact or a locally verified result.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `parser-differential-auditing` → `remediation` when The root cause is disagreement between the representation validated earlier and the representation consumed after conversion.. Packet: Common scope, evidence classification and unresolved limits, Target-independent semantic invariant and authoritative consumer, All conversion, entry-handling, string-type and parsing variants, Normal-behavior controls and configuration-dependent regression properties, Source-to-distributed-build ownership and artifact-verification gap, Compatibility tradeoffs and residual narrowing paths. Gate: The repair must preserve the invariant through the whole consumer path, not merely rename an entry point or block one sample. Shipped-artifact verification and compatibility coverage must remain explicit unresolved gates until evidence exists.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- All vulnerability, demonstration and vendor-response results remain author reports. Only article text and quotation identity were independently checked; no binaries, APIs or targets were exercised.
- Conversion depends on the effective code page and actual API/runtime path. The article distinguishes the application/system code page from the console code page; a console setting is not evidence of the relevant configuration.
- The article labels initial filename examples as bugs rather than demonstrated vulnerabilities, describes one environment-routing example as hypothetical, and calls a later configuration-dependent inclusion scenario rare. A representation discrepancy alone does not establish a reachable security consequence.
- Runtime-version and distributor differences matter: the article contrasts historical filesystem behavior, narrow versus wide startup paths, and independently built executables. Its publication-era affected/fixed statuses were not checked against current releases.
- The proposed wide-character migration requires downstream type and parsing changes. The article also warns that its system-wide encoding alternative was a beta option with uncertain side effects; neither an entry-point change nor a configuration toggle is verified here as a universal repair.

**Operational owners:** [data-flow-analysis](../../skills/data-flow-analysis/SKILL.md), [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md), [parser-differential-auditing](../../skills/parser-differential-auditing/SKILL.md), [remediation](../../skills/remediation/SKILL.md)

## O005

**Article:** [Confusion Attacks: Exploiting Hidden Semantic Ambiguity in Apache HTTP Server!](https://blog.orange.tw/posts/2024-08-confusion-attacks-en/)
**Worker:** `worker-o005v001`; [packet](extractions/O005.json).
**Orchestrator decision:** Retain interaction selection, field semantics, re-entry questions, error-path selector writes and equivalent-caller regression coverage.
**Editorial qualifications:** Candidate 3 supports the existing remediation matrix. E3 is a specification excerpt reproduced in the article, not independent evidence of another implementation's inherited state.

**Method evidence (short source quotations):**
- **E1** — A Whole New Attack — Confusion Attack: opening paragraph, first sentence: “focusing on the “relationships” and “interactions” among these modules”
- **E2** — A Whole New Attack — Confusion Attack: opening paragraph, sentence beginning 'Furthermore': “if the definitions or semantics of the fields are not precise enough, causing ambiguities in how modules understand the same fields”
- **E3** — ⚔️ Primitive 3-2. Invoke Arbitrary Handlers: specification block quotation following the phase-order obstacle and reference to local request reprocessing: “This indicates to the server that it should reprocess the request using the path specified.”
- **E4** — ✔️ 3-1-1. Overwrite Handler to Disclose PHP Source Code: paragraph after the process diagram, beginning 'Because ModSecurity': “the internal HTTP lifecycle that should have stopped continued.”
- **E5** — ✔️ 3-1-1. Overwrite Handler to Disclose PHP Source Code: paragraph discussing the earlier request-parser correction and the remaining error-handling root cause: “the same behavior can still be successfully reproduced if another code path”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `source-code-auditing` / heuristic: In modular pipelines, prioritize shared mutable fields with multiple writers and readers. Record each participant's assumed meaning, mutation rights and processing phase, then select a slice where those contracts may conflict. (evidence E1, E2).
- `parser-differential-auditing` / workflow: Track a field's semantic role and origin per processing pass, not only its bytes. Before relying on a phase-order argument, review documented internal re-entry and fields inherited by the new context; compare the checked meaning with the later consumed meaning. (evidence E2, E3).
- `deserialization-and-dispatch-auditing` / failure: Treat error handling as a possible writer of behavior-selection metadata. Check whether a terminal failure actually stops processing or leaves later dispatch consuming state overwritten for an error response; keep normal and failure-path contracts distinct. (evidence E2, E4).
- `remediation` / validation: A blocked entry path is not invariant repair. Review other callers reaching the same failure contract and require regression properties for safe termination and preserved normal behavior across affected consumers; retain unresolved variant and deployment scope. (evidence E4, E5).

**Proposed handoffs (derived, not author-agent claims):**
- `source-code-auditing` → `parser-differential-auditing` when A shared field has potentially incompatible meanings across participants or processing passes.. Packet: scope, question, evidence, classification, limits, next_action_and_stop_condition, field_writer_reader_and_semantic_role_table, value_origin_and_transformations, phase_order_and_reentry_edges, checked_versus_consumed_meaning, contrasting_predictions_and_normal_control. Gate: At least one field has source-linked writers, readers, ordering and a falsifiable semantic-disagreement hypothesis. Unknown reachability and re-entry edges remain explicitly unresolved; source-author reports are not promoted to independent observations.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `deserialization-and-dispatch-auditing` → `remediation` when An error path changes behavior-selection metadata while processing that should terminate can continue.. Packet: scope, question, evidence, classification, limits, next_action_and_stop_condition, selector_provenance_and_fallback_contract, terminal_error_and_continuation_edges, affected_consumers_and_equivalent_failure_paths, normal_controls_and_regression_properties, source_vs_shipped_fix_gap. Gate: Identify the terminal-state invariant, metadata mutation, affected consumers and normal controls. Regression properties must distinguish safe termination and invariant repair from suppressing one input; missing consumer or deployment evidence returns a specific unresolved question.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- Only the public article and its DOM were inspected. All vulnerability, reproduction and fix results remain source-author reports; no target requests, exploit execution or attachment downloads were performed.
- The report concerns historical Apache HTTP Server behavior. Reachability and consequences depend on loaded modules, backend integration, configuration scope, operating-system distribution and access policy; it does not establish current-release exposure.
- The article narrows its broad filesystem-access discussion when default directory policy still denies access. Name resolution, authorization and available behavior remain separate capability gates, not evidence of unrestricted access.
- E3 is a specification excerpt reproduced within the article, not an independently retrieved standard. The surrounding source review motivates re-entry analysis, but copied-field provenance and timing must be established for each actual implementation.
- The failure-path example credits earlier third-party research, and the article reports a correction of one path without removal of the underlying error-handling problem. Other outcomes are redacted pending resolution; no present-day complete-fix or stronger-impact claim is inferred.

**Operational owners:** [deserialization-and-dispatch-auditing](../../skills/deserialization-and-dispatch-auditing/SKILL.md), [parser-differential-auditing](../../skills/parser-differential-auditing/SKILL.md), [remediation](../../skills/remediation/SKILL.md), [source-code-auditing](../../skills/source-code-auditing/SKILL.md)

## O008

**Article:** [A New Attack Surface on MS Exchange Part 4 - ProxyRelay!](https://blog.orange.tw/posts/2022-10-proxyrelay-a-new-attack-surface-on-ms-exchange-part-4/)
**Worker:** `worker-o008v001`; [packet](extractions/O008.json).
**Orchestrator decision:** Retain effective peer authority, consumer-specific legitimate identities and shipped-code versus active-enforcement verification.
**Editorial qualifications:** Historical rollout and later default changes remain separate; relay/coercion and unimplemented stronger-impact proposals are omitted.

**Method evidence (short source quotations):**
- **E1** — Idea — paragraph describing installation-time group membership and inherited rights, final clause.: “all objects in this Active Directory group have that Token-Serialization right by default.”
- **E2** — Vulnerabilities — opening paragraph, sentence contrasting an attack surface with a single bug.: “Since it’s an entire attack surface instead of a single bug, this idea could be applied to different contexts, causing different vulnerabilities.”
- **E3** — Round 2 - Relay to Exchange BackEnd — opening paragraph, explanation of why the earlier mitigation cannot simply transfer to the next consumer.: “mitigating Backend would be more challenging because it’s a regular operation”
- **E4** — Patching DCOM — opening paragraph, compatibility/default-hardening sentence.: “due to compatibility, the hardening on the server-side is disabled by default.”
- **E5** — Timeline — Apr 27, 2022 entry, vendor reply distinguishing the code change from its activation.: “the CU contain the code change, but it needs to be activated manually or with a script.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `attack-surface-mapping` / heuristic: For distributed services, include installation-derived membership and effective peer authority in each interface row. Review the same trust assumption across consumers; a corrected entrance gate does not establish policy coverage elsewhere. (evidence E1, E2).
- `authorization-auditing` / remediation: Before reusing an identity-based restriction at another consumer, document which identity classes are legitimate there. Require a consumer-specific trust invariant and accepted-operation controls rather than applying a blanket identity prohibition. (evidence E3).
- `remediation` / validation: Maintain separate evidence for a shipped repair and active enforcement. Record compatibility-driven defaults, activation requirements, and rollout phase; classify missing activation evidence as unverified even when the package contains the change. (evidence E4, E5).

**Proposed handoffs (derived, not author-agent claims):**
- `attack-surface-mapping` → `authorization-auditing` when A distributed interface map suggests inherited peer authority, but the relationship between identity establishment and consumer permissions is unresolved.. Packet: authorization scope, artifact revision, and configuration, one falsifiable identity or permission question, interface, actor, gate, and consumer map, default membership and effective-rights provenance, legitimate peer operations and expected policy, evidence references and fact versus author-report classification, unknown routes, failed assumptions, and next bounded review. Gate: At least one prioritized interface has gate and authority evidence or is explicitly labeled inferred. Nominal membership must not substitute for effective permission evidence, and the consumer must distinguish normal peer authority from a policy violation.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `authorization-auditing` → `remediation` when A proposed identity restriction is context-specific or hardening depends on activation and compatibility decisions.. Packet: scope, artifact revision, and enforcement question, target-independent trust invariant and authoritative consumer, consumer and legitimate-identity matrix, equivalent contexts and proposed accepted/rejected regression properties, shipped-code, activation, and rollout evidence, compatibility tradeoffs and impact limits, evidence classification, residual unknowns, and bounded verification request. Gate: The proposed repair preserves documented legitimate operations and covers the consumer-specific trust requirement. Shipped code and enabled enforcement have separate evidence; absent activation evidence remains unverified rather than repaired.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- Findings and vendor communications are author reports concerning historical Exchange, Windows, and directory configurations; no vulnerability or fix was independently reproduced.
- The reported surface depends on peer topology, inherited service-account privileges, authentication support, reachable consumers, and enabled configuration. It does not establish equivalent exposure in every deployment or current release.
- The author explicitly states that the stronger backend management-shell exploit chain was not implemented. That proposal must not be promoted to demonstrated code execution.
- The DCOM section retains pre-enforcement prose followed by a postscript reporting a later default change. Its deployment-status statements belong to historical rollout phases, not a verified present-day status.
- The backend patch's broad effectiveness is the author's claim. The retained evidence establishes a deployment-state lesson, not independently confirmed coverage of all variants.
- No exploit code, attachments, demonstrations, third-party slide evidence, or targets were executed or tested. Only the assigned public article was inspected; related URLs were recorded without following them.

**Operational owners:** [attack-surface-mapping](../../skills/attack-surface-mapping/SKILL.md), [authorization-auditing](../../skills/authorization-auditing/SKILL.md), [remediation](../../skills/remediation/SKILL.md)

## O009

**Article:** [Let's Dance in the Cache - Destabilizing Hash Table on Microsoft IIS!](https://blog.orange.tw/posts/2022-08-lets-dance-in-the-cache-destabilizing-hash-table-on-microsoft-iis/)
**Worker:** `worker-o009v001`; [packet](extractions/O009.json).
**Orchestrator decision:** Retain declared-context cache equivalence, connected record/key/callback contracts and semantic operand coverage.
**Editorial qualifications:** Record callbacks are an application contract, not intrinsically binary. Repeated comparison is a review lead; state/collision prerequisites and probabilistic author reports are not measured here.

**Method evidence (short source quotations):**
- **E1** — 2. IIS Cache Poisoning Attack — second prose paragraph, opening sentence: “Output Caching uses a bad Query String parser that only takes the first occurrence as the Cache-Key when Query String keys are duplicated.”
- **E2** — 2. IIS Cache Poisoning Attack — same second paragraph, sentence beginning 'The backend concatenates': “The backend concatenates the value of all repeated keys together, which leads to an inconsistency between parser behaviors.”
- **E3** — 3. IIS Authentication Bypass — second prose paragraph, sentence beginning 'An application can define': “An application can define its own Table-Related functions, such as the Hash Function, the Key Extracting Function, or the Key Comparing Function.”
- **E4** — 3. IIS Authentication Bypass — same second paragraph, final sentence: “So, under this context, we cares more about the relationship between the records, the keys, and the functions.”
- **E5** — 3. IIS Authentication Bypass — paragraph beginning 'As the logic compares several parts': “As the logic compares several parts to make the decision, it’s weird why IIS compares the username twice.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `parser-differential-auditing` / validation: Within a declared cache context, require key-equivalent requests to preserve equivalent downstream response-selection semantics. Record repeated-field policy at both layers rather than declaring either parser unsafe in isolation. (evidence E1, E2).
- `source-code-auditing` / heuristic: Audit customization callbacks together with their record/key mappings. Check whether extraction, hashing and equality express the same application identity instead of assuming the shared container enforces application-specific correctness. (evidence E3, E4).
- `authorization-auditing` / heuristic: For composite identity checks, map each operand to a required semantic field. Repeated operand comparisons are a prompt to investigate an omitted independent field, not proof of a policy failure; retain intended semantics as a hypothesis until corroborated. (evidence E5).

**Proposed handoffs (derived, not author-agent claims):**
- `binary-auditing` → `authorization-auditing` when Recovered cache callbacks leave uncertainty about whether record equality preserves the intended identity binding.. Packet: Common scope, question, evidence, classification, limits and next-action envelope, Record-to-key-to-hash-to-equality map with observed versus inferred relationships, Comparison operands mapped to semantic fields and the intended identity-binding invariant, Relevant decision branch, cached-state prerequisites and unresolved reachability, without trigger inputs, Contrasting predictions for a bounded, benign corroboration design. Gate: Each compared operand must be tied to a semantic field, and the packet must distinguish a suspected missing binding from a legitimate optimization. Author reports, reconstructed intent and independent observations remain separately classified; duplicate comparisons alone do not prove a policy failure.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `parser-differential-auditing` → `remediation` when A cache-key/consumer interpretation discrepancy has been characterized and an invariant-level repair question remains.. Packet: Common scope, question, evidence, classification, limits and next-action envelope, Cache-selection and consumer representation table, including repeated-field policies, Declared cache context and the proposed key-equivalence invariant, Authoritative interpretation, affected consumers and unresolved semantic variants, Accepted controls, contrasting interpretation classes and proposed regression properties, Policy-consequence evidence limits and source-versus-shipped-fix status. Gate: The proposed property must preserve accepted behavior while preventing key equivalence from merging distinct downstream response-selection meanings. A parser discrepancy without a supported consequence is not promoted to a security finding, and a proposed regression is not treated as a verified deployed repair.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- The author explicitly delegates most details to slides. Those slides and demonstration videos were not consulted, so acquisition, instrumentation and complete experiment coverage are not established here.
- The parser discrepancy is an author report about IIS Output Caching and ASP.NET; generality across parser versions, runtime configurations and other cache contexts is unverified.
- The authentication report requires an existing cached record and a hash collision reaching application-specific equality logic. The article notes uncertainty about existing cache keys and probabilistic success; a defective comparison alone does not establish practical reachability or current impact.
- The availability section reports a failure of periodic stale-record cleanup, but this brief provides no reusable bounded complexity-measurement workflow. No load-generation or mitigation-defeat guidance is extracted.
- The author reports Microsoft patched the issues in July 2022, but this article does not explain the shipped repair. No independent reproduction, current-release testing or deployed-fix verification was performed; all reported results remain author reports. Handoff gates and regression properties are defensive synthesis.

**Operational owners:** [authorization-auditing](../../skills/authorization-auditing/SKILL.md), [parser-differential-auditing](../../skills/parser-differential-auditing/SKILL.md), [source-code-auditing](../../skills/source-code-auditing/SKILL.md)

## O011

**Article:** [A New Attack Surface on MS Exchange Part 2 - ProxyOracle!](https://blog.orange.tw/posts/2021-08-proxyoracle-a-new-attack-surface-on-ms-exchange-part-2/)
**Worker:** `worker-o011v001`; [packet](extractions/O011.json).
**Orchestrator decision:** Retain exceptional-versus-later rejection progress as a source-review question, with stage-correlated safe observation support.
**Editorial qualifications:** Merge candidate 2 into the observation-signals contract. Reject separate additions for backward tracing and protected-input capability gaps already in the baseline. No recovery oracle or extraction procedure is adopted.

**Method evidence (short source quotations):**
- **E1** — Where is ProxyOracle — second prose paragraph, opening two sentences about identity synchronization and earlier credential processing: “We now know how the Frontend and Backend synchronize the User Identity. The next is to explain how the Frontend knows who you are and processes your credentials.”
- **E2** — CVE-2021-31196 - The Padding Oracle — opening paragraph, clause describing the exception-driven immediate return: “In the cookie decryption, Exchange uses an exception to catch the Padding Error, and because of the exception, the program returned immediately”
- **E3** — CVE-2021-31196 - The Padding Oracle — prose paragraph immediately after the response-difference diagram: “With the difference, we now have an Oracle to identify whether the decryption process is successful or not.”
- **E4** — The Exploit — opening paragraph, question identifying the missing input-acquisition capability: “BUT, how can we get the client cookies?”
- **E5** — XSS to Steal Client Cookies — final prose paragraph, first sentence identifying the browser access restriction: “But here comes another question: all the sensitive cookies are protected by the HttpOnly flag, which makes us unable to access the cookies by JavaScript.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `source-code-auditing` / heuristic: Audit exception-driven early exits alongside ordinary rejection paths. Two rejected operations can expose different processing progress even when neither completes the intended action; trace the externally observable consequence of each exit. (evidence E2, E3).
- `dynamic-analysis` / validation: For suspected processing-stage disclosure, define contrasting stage predictions and correlate each with observable rejection behavior using benign controls in an authorized isolated lab. A response difference without internal corroboration is a hypothesis, not a completed validation. (evidence E2, E3).

**Proposed handoffs (derived, not author-agent claims):**
- `source-code-auditing` → `dynamic-analysis` when An exceptional return and a later rejection appear to expose different processing stages, but the external-to-internal correspondence remains unverified.. Packet: authorized_scope_and_artifact_identity, minimal_stage_and_failure_flow, actor_control_and_input_gates, question_and_contrasting_predictions, external_outcome_and_internal_observation_points, known_good_baseline_and_negative_controls, allowed_changes_stop_condition_and_failed_assumptions, evidence_collection_provenance_and_source_report_vs_local_observation. Gate: Require distinguishable predictions and a benign baseline in an authorized isolated lab. Do not equate an external difference with a particular internal stage without corroboration; retain author-report classification until independently observed.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `data-flow-analysis` → `exploitability-assessment` when A useful primitive depends on access to protected input whose acquisition or browser-policy feasibility is unresolved.. Packet: authorized_scope_artifact_identity_actor_and_configuration, constrained_primitive_and_required_input, input_ownership_access_policy_and_feasibility_gates, capability_edges_with_preconditions_and_evidence_provenance, blocked_or_unresolved_edges_and_failed_assumptions, question_contrasting_predictions_and_bounded_next_observation, source_report_vs_local_observation_and_untested_scope. Gate: Every capability edge must have supporting evidence or be explicitly unresolved. Client-context execution does not establish access to protected data, and the author's later composition is not independent impact verification.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical 2021 Exchange/FBA account. Architecture, vulnerabilities, and reported results were read, not independently reproduced or checked against a current deployment.
- The author reports a recovery limitation for the initial ciphertext block because initialization state is separately protected. The reported compensation relies on predictable plaintext and encoding details; those target-specific assumptions and calculations are not generalized.
- Useful decryption feedback alone does not establish access to another user's protected input. The article explicitly encounters a script-read restriction; its subsequent bypass and composition are deliberately omitted.
- The article does not supply a controlled reliability denominator or negative-control study. Its source-based mapping of response behavior to internal stages has not been independently replicated here; the derived validation handoff is an evidence requirement, not an author-used procedure.
- No patch implementation, shipped-fix verification, or regression matrix is presented. The preceding architecture article was only recorded as a pointer, and the demonstration video was not played.

**Operational owners:** [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md), [source-code-auditing](../../skills/source-code-auditing/SKILL.md)

## O012

**Article:** [A New Attack Surface on MS Exchange Part 1 - ProxyLogon!](https://blog.orange.tw/posts/2021-08-proxylogon-a-new-attack-surface-on-ms-exchange-part-1/)
**Worker:** `worker-o012v001`; [packet](extractions/O012.json).
**Orchestrator decision:** Retain intermediary/client authority roles, revision-dependent component responsibilities and selected-context/metadata agreement.
**Editorial qualifications:** Admission credential, represented-client binding and action policy are distinct. Compatibility debt and listener presence are not proof of a defect or authority.

**Method evidence (short source quotations):**
- **E1** — CVE-2021-26855 - Pre-auth SSRF — final root-cause paragraph, sentence about component names across versions: “It might have different functions in different versions even with the same component under the same name.”
- **E2** — The CAS architecture — final prose paragraph before Frontend Proxy Module, sentence describing request forwarding: “The Proxy Module picks up the HTTP request from the client side and adds some internal settings, then forwards the request to the Backend.”
- **E3** — Frontend Proxy Section — paragraph explaining the added authentication credential, second sentence: “This header is designed to prevent anonymous users from accessing the Backend directly.”
- **E4** — Backend Rehydration Module — paragraph beginning After passing the check, identity-restoration clause: “will restore the login identity used in the Frontend”
- **E5** — The attack surface — blockquoted research question following the proxy-architecture introduction: “Could I use a single HTTP request to access different contexts in Frontend and Backend respectively to cause some confusion?”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `attack-surface-mapping` / heuristic: Prioritize early request intermediaries that add trusted metadata before business logic. Map the external caller, intermediary admission credential, metadata writer and reconstructed downstream client as separate trust roles. (evidence E2, E3, E4).
- `source-code-auditing` / heuristic: When compatibility spans architectural revisions, compare the actual responsibility and trust contract of same-named components. Prioritize adapters that preserve older routing or identity assumptions, without treating compatibility debt as proof of a defect. (evidence E1, E2).
- `parser-differential-auditing` / workflow: Extend the representation map with the context selected at each processing layer and the metadata policy that context applies. Ask whether admission and consumption agree on context and meaning; require benign paired observations before asserting a security consequence. (evidence E2, E4, E5).
- `authorization-auditing` / validation: Separate authentication of an intermediary from reconstruction of a client identity and authorization of that client's action. A valid intermediary credential or a reachable internal interface does not independently establish the latter two contracts. (evidence E3, E4).

**Proposed handoffs (derived, not author-agent claims):**
- `attack-surface-mapping` → `source-code-auditing` when The interface map identifies a compatibility branch or intermediary whose historical role may differ from its current name.. Packet: authorization and artifact/revision/configuration scope, entry-to-handler and intermediary-to-consumer map, lowest relevant actor and admission gates, metadata producers, reconstructed identity and downstream privilege, compatibility roles with references and confidence labels, one unresolved trust-contract question, contrasting predictions and a bounded review stop condition. Gate: At least one prioritized route has handler/gate evidence or an explicit inferred label with a proposed harmless check. Component names and historical vulnerability reports alone do not establish current reachability or a faulty contract.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `source-code-auditing` → `parser-differential-auditing` when A source slice leaves unresolved whether admission and consumption select different request contexts or apply different metadata meanings.. Packet: authorization, revision and runtime/configuration scope, minimal forwarding and consumer slice with source locations, context-selection and representation table for each layer, metadata origin, forwarding policy and consumer interpretation, one discrepancy hypothesis and contrasting predictions, known-good benign control, observation points and rejection conditions, author-report versus local-evidence classification and remaining unknowns. Gate: The packet identifies both contexts and their policy checks, or explicitly marks the missing interpretation. Any proposed isolated observation must distinguish agreement from disagreement using benign controls; neither a copied request nor a generic proxy label is sufficient evidence.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- The reported Exchange architecture and compatibility behavior are historical author descriptions, not evidence of exposure or equivalent behavior on a current installation. No target was tested.
- The apparent direct accessibility of an internal listener is qualified by the article's subsequent authenticated-intermediary and identity-restoration permission checks. Listener reachability alone does not establish authority to act as a client.
- Compatibility debt is the author's root-cause explanation; this extraction did not independently compare component roles across releases or verify deployment prerequisites.
- All vulnerability effects and patch claims remain author reports. The article does not supply a semantic fix comparison or a complete regression matrix, and neither was independently verified.
- The architecture and context question support audit selection, not a documented controlled validation protocol. Proposed controls, acceptance gates and handoffs are library-derived and were not performed or attributed to the author.

**Operational owners:** [attack-surface-mapping](../../skills/attack-surface-mapping/SKILL.md), [authorization-auditing](../../skills/authorization-auditing/SKILL.md), [parser-differential-auditing](../../skills/parser-differential-auditing/SKILL.md), [source-code-auditing](../../skills/source-code-auditing/SKILL.md)

## O014

**Article:** [How I Hacked Facebook Again! Unauthenticated RCE on MobileIron MDM](https://blog.orange.tw/posts/2020-09-how-i-hacked-facebook-again-mobileiron-mdm-rce/)
**Worker:** `worker-o014v001`; [packet](extractions/O014.json).
**Orchestrator decision:** Retain revision-scoped negative evidence: identify the actual rejection guard before transferring a published failure conclusion.
**Editorial qualifications:** Other candidates repeat existing provenance, intermediary and capability gates. The explicit diff context is adjacent to E5, not a claimed local tool run; absent guard is not positive reachability.

**Method evidence (short source quotations):**
- **E1** — Where to Start; opening paragraph, final sentence about the discovered analysis package's indexing.: “The file is just sitting on a listable WebRoot and indexed by Google Search.”
- **E2** — Finding Vulnerabilities; paragraph beginning 'MobileIron relied on Apache Rewrite Rules', immediately after the displayed access rules.: “MobileIron relied on Apache Rewrite Rules to block all the access to Web Service. It’s in the front of a reverse-proxy architecture, and the backend is a Java-based web server.”
- **E3** — Attacking Facebook; paragraph beginning 'Everything is ready', final sentence describing the unavailable outbound prerequisite.: “But now, we can’t even make an outbound connection, not to mention others.”
- **E4** — Attacking Facebook; paragraph beginning 'A question quickly came up in my mind', immediately after the cited paper's failure observation.: “Although it failed with exceptions, there must have been something special so that the author write this down.”
- **E5** — Attacking Facebook; paragraph beginning 'Our target is running with a very old Groovy', preceding the displayed source-revision comparison using diff.: “Our target is running with a very old Groovy, so we are guessing that the readResolve() constrain might not have been applied to the code base yet!”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `patch-diff-analysis` / heuristic: Do not inherit a published exception as universal negative evidence. Identify its rejection guard, compare only the relevant implementation across comparable dependency revisions, and keep static applicability inference separate from benign runtime confirmation. (evidence E4, E5).

**Tool attribution:**
- diff → Compare a narrow implementation slice across dependency revisions to investigate whether a rejection guard is present. → A published failure may depend on mitigation added after the installed revision; use comparable, authorized source artifacts before changing an applicability claim.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `attack-surface-mapping` → `parser-differential-auditing` when An upstream access gate and downstream consumer interpret the same input independently, leaving enforcement equivalence unresolved.. Packet: authorization, artifact provenance, revisions and configuration, actor, interface, gate and downstream-handler map, representation and interpretation ledger for each layer, one discrepancy hypothesis with contrasting predictions, evidence origin, failed assumptions and unresolved coverage, benign baseline, negative controls, bounded next observation and stop condition. Gate: Require identified policy-checking and consuming layers, explicit runtime identities, and a falsifiable semantic-agreement question. An upstream denial alone cannot establish downstream enforcement; inferred reachability must remain labeled until safely corroborated.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `exploitability-assessment` → `patch-diff-analysis` when A capability hypothesis loses an environmental prerequisite and a published rejection may be specific to a different dependency revision.. Packet: authorization, artifact identities, dependency revisions and configuration, root-cause hypothesis and bounded capability contract, failed prerequisite, negative evidence and its provenance, published rejection behavior and suspected guard, comparable revision slices and one guard-applicability question, static versus observed classification, benign validation predictions and stop condition. Gate: Require the failed prerequisite, provenance-tagged comparable revisions, and an explicit guard-applicability question. Missing static guard code is only an applicability hypothesis, not proof of reachable behavior or stronger impact.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- The author used an older developer testing package, not an established equivalent of every deployed build. The article reports its later removal; public indexing is neither authorization nor artifact-integrity evidence.
- Runtime/library compatibility and outbound-policy constraints are author reports tied to historical configurations. They were not measured here and cannot be generalized to current releases or other deployments.
- Failure of a connection-dependent hypothesis does not establish repair of the underlying behavior or exhaustive non-exploitability. This extraction retains the constraint, not an alternate exploit route.
- The source-revision comparison is narrow and does not establish all callers, package contents or runtime reachability. Static absence of a guard needs separate safe applicability evidence.
- The article reports vendor fixes and uses static-file modification metadata as a coarse patch-status indicator. No shipped package or installed repair was verified here; advisory publication and header metadata are not deployment proof.
- All vulnerability, execution and bounty outcomes remain source-author reports. This work only read the article and verified quotations; it did not obtain research packages, run exploit code or test any target.

**Operational owners:** [patch-diff-analysis](../../skills/patch-diff-analysis/SKILL.md)

## O015

**Article:** [你用它上網，我用它進你內網! 中華電信數據機遠端代碼執行漏洞](https://blog.orange.tw/posts/2019-11-HiNet-GPON-Modem-RCE/)
**Worker:** `worker-o015v001`; [packet](extractions/O015.json).
**Orchestrator decision:** Retain unmatched-input/default-delegation behavior as a separate selection contract beyond advertised operations.
**Editorial qualifications:** Help inventory, bounded handler selection and residual rollout cohorts reinforce existing contracts without new procedures. No command execution sequence is retained.

**Method evidence (short source quotations):**
- **E1** — 漏洞挖掘 — opening paragraph introducing analysis modes by source, executable and API-documentation availability: “軟體漏洞的挖掘，根據原始碼、執行檔以及 API 文件的有無可依序分為:”
- **E2** — 黑箱測試 — paragraph beginning 「其中，可以透過」, advertised-function enumeration clause: “其中，可以透過 HELP 指令列出所有功能”
- **E3** — 從灰箱進化成白箱 — opening paragraph, function-based implementation hypothesis: “從功能面來看，感覺會存在命令注入相關的漏洞，因此先以功能實作為出發點開始挖掘!”
- **E4** — 從灰箱進化成白箱 — paragraph beginning 「研究了一段時間」, unsuccessful review followed by attention to unmatched commands: “研究了一段時間，並沒有發現到什麼嚴重漏洞 :( 不過我們注意到，當所有指命都匹配失敗時，”
- **E5** — 通報時程 — list item reporting remaining manual updates and delayed publication, following the reported firmware-update completion item: “廠商回覆部分用戶需派員更新, 延後公開時間”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `deserialization-and-dispatch-auditing` / workflow: Include unmatched-input and default-delegation branches in the behavior-selection model. Review their validation and privilege contracts independently of advertised operations; a negative ordinary-path review does not close them. (evidence E4).

**Tool attribution:**
- Interface-native HELP facility → List advertised functions to seed an operation and handler-review inventory. → During authorized black-box interface mapping when built-in help is available; the resulting list is not proof of exhaustive dispatch coverage.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `attack-surface-mapping` → `binary-auditing` when A permitted implementation artifact becomes available and the remaining question concerns how a prioritized interface operation is implemented.. Packet: Authorization, artifact provenance, revision and configuration, One unresolved implementation question and evidence classification, Actor, interface gates and advertised-operation inventory, Source, binary and interface-documentation availability, Function-semantic hypothesis and prioritized handler anchors, Negative findings, coverage gaps and bounded next-review stop condition. Gate: Identify the permitted artifact and one evidence-backed operation to prioritize. Actor, configuration and gates must be explicit or marked unknown; an advertised function name is not proof of its implementation or reachability.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `binary-auditing` → `deserialization-and-dispatch-auditing` when Ordinary handler analysis is unrevealing and recovered control flow identifies a distinct unmatched-input behavior-selection path.. Packet: Scope, artifact identity and original-versus-modified environment, Unresolved behavior-selection question, Ordinary and fallback branch references with reconstruction confidence, Selector provenance, gating, validation and downstream consumer model, Actor, privilege and feature prerequisites, Negative review results and unresolved coverage, Contrasting benign observation proposal and stop conditions. Gate: Require evidence for an alternate selection edge, not merely absence of an ordinary-path finding. Preserve static-inference status and unknown reachability; the receiving skill must not promote a reconstructed branch into demonstrated impact.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- Execution, exposure and affected-population claims remain author reports, not independent verification. The population estimate covered only devices online at observation time, and the complete affected-device inventory was unavailable; no scanning or target testing was performed here.
- The author's increased implementation visibility involved access to their own device. Such local management access does not establish reachability through the originally exposed interface; the access-acquisition sequence is intentionally omitted.
- The unsuccessful ordinary-handler review has no supplied coverage denominator or benign differential-validation protocol. Recovered pseudocode is described as assembly-based reconstruction, not independently checked source or proof that all other handlers were safe.
- The chronology records reported completion followed by remaining manual updates. It does not supply patch diffs, deployed-artifact receipts or independent confirmation of complete fix coverage.

**Operational owners:** [deserialization-and-dispatch-auditing](../../skills/deserialization-and-dispatch-auditing/SKILL.md)

## O016

**Article:** [An analysis and thought about recently PHP-FPM RCE (CVE-2019-11043)](https://blog.orange.tw/posts/2019-10-an-analysis-and-thought-about-recently/)
**Worker:** `worker-o016v001`; [packet](extractions/O016.json).
**Orchestrator decision:** Retain conditional storage-to-retrieval influence review and configuration-dependent producer emission-order feasibility.
**Editorial qualifications:** E1 names a table-managed consumer but alone does not quote the independent-metadata obstruction. Before/after views do not establish consumer acceptance. Debugger names are observed in adjacent console listings; crash-based detection is excluded.

**Method evidence (short source quotations):**
- **E1** — The exploitation / B. From CGI environment overwritten to Remote Code Execution: paragraph beginning 'However, although we can overwrite the environment data', sentence explaining the source-review finding.: “After checking the source, we found the problem is PHP-FPM uses a hash table to manage environments.”
- **E2** — Write a working exploit / A. The Nginx obstacle: numbered item 2, 'The PHP dispatcher', prose immediately following the two configuration examples.: “Although the meaning looks like the same, the exploitation is absolutely different!”
- **E3** — Write a working exploit / A. The Nginx obstacle: numbered item 4, 'The PATH_INFO sequential problem', paragraph immediately following the installed-configuration excerpt.: “As you can see, the PATH_INFO are defined before the QUERY_STRING, so the original exploit doesn’t cover that.”
- **E4** — Write a working exploit / B. Vulnerability verification problem: introductory sentence before the first memory-view image; quotation stops before the source-line reference.: “This is the memory view before the environment variable is written”
- **E5** — Write a working exploit / B. Vulnerability verification problem: sentence after the debugger bucket excerpt and immediately before the second memory-view image.: “This is the memory view after the environment variable is written.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `data-flow-analysis` / heuristic: For indexed mutable records, ask whether changed contents satisfy extraction, lookup/equality and retrieval predicates before claiming changed consumer meaning. Keep an unproven storage/index obstruction as a conditional derived question, related to the record/key contract, not a general proven mechanism. (evidence E1).
- `exploitability-assessment` / validation: Treat input emission order as an explicit feasibility parameter alongside dispatch and prerequisite gates. Compare configuration variants semantically, retain uncovered cases, and do not transfer layout-dependent conclusions merely because configuration snippets look equivalent. (evidence E2, E3).

**Tool attribution:**
- GDB with PEDA, observed as gdb-peda console transcripts → Inspect runtime structure fields and compare before/after memory state. → When source reasoning leaves the actual layout or mutation effect uncertain; the article displays debugger observations around its memory-view comparison.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `source-code-auditing` → `dynamic-analysis` when Source review identifies separate storage and lookup conditions, but the actual runtime state transition remains unknown.. Packet: authorization, artifact revision, build, runtime, configuration and actor, one falsifiable storage-versus-consumer question, minimal source and consumer slice with independent lookup predicates, contrasting predictions and a benign known-good control, bounded before/after observation points and permitted instrumentation changes, evidence references, collection method, timestamp and report-versus-observation classification, failed assumptions, untested scope, next bounded action and stop condition. Gate: The proposed observation must distinguish the hypotheses safely in the declared lab. A storage change alone cannot be accepted as evidence that the consumer recognized the changed state; author-only evidence remains labeled as such.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `dynamic-analysis` → `exploitability-assessment` when A state change is reported or observed, but its consumer-visible capability or configuration applicability is unresolved.. Packet: authorization, actor, artifact identity, runtime and exact configuration, original-versus-instrumented environment and observation provenance, constrained change contract: direction, width, controllable subset and scope, consumer lookup requirements and separately supported semantic effects, dispatch and input-order prerequisites, failed assumptions and uncovered variants, negative evidence, collateral effects and remaining uncertainty, narrow impact question, bounded next review and stop condition. Gate: Reject any packet equating changed bytes or a crash with arbitrary control or execution. Each claimed consumer effect and deployment dependency needs evidence; static inference and source-author reports must not become independently demonstrated impact.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical PHP-FPM/Nginx analysis. Applicability depends on feature support, dispatch semantics, file-existence gates and parameter ordering; the article is not evidence about current releases or arbitrary deployments.
- Debugger views, successful effects and local improvements are author reports, not independently reproduced results. No source code was executed, exploit attachments downloaded or targets tested.
- The article's final reliability improvement is described as working locally while further reliability work remained ongoing. It supplies no measured success/attempt denominator or production-equivalent guarantee.
- The article suggests crash-based detection, which is neither a harmless observation nor a specific proof of the reported root cause. That procedure is excluded, not promoted into a validation oracle.
- No shipped fix or regression suite is analyzed. Configuration-based exposure restrictions must not be mistaken for proof that the underlying memory invariant was repaired.

**Operational owners:** [data-flow-analysis](../../skills/data-flow-analysis/SKILL.md), [exploitability-assessment](../../skills/exploitability-assessment/SKILL.md), [parser-differential-auditing](../../skills/parser-differential-auditing/SKILL.md)

## O017

**Article:** [Attacking SSL VPN - Part 3: The Golden Pulse Secure SSL VPN RCE Chain, with Twitter as Case Study!](https://blog.orange.tw/posts/2019-09-attacking-ssl-vpn-part-3-golden-pulse-secure-rce-chain/)
**Worker:** `worker-o017v001`; [packet](extractions/O017.json).
**Orchestrator decision:** Retain effective wrapper/replacement semantics and fold feature-specific validation exceptions into integration-contract review.
**Editorial qualifications:** Compatibility/feature gates and fault-only logs already exist. dmesg is a source-named diagnostic option, not proof of execution or a new required tool.

**Method evidence (short source quotations):**
- **E1** — CVE-2019-11510: Pre-auth Arbitrary File Reading — second paragraph, opening sentence: “In order to handle the static resources, Pulse Secure created a new IF-CONDITION to widen the originally strict path validation.”
- **E2** — CVE-2019-11539: Post-auth(admin) Command Injection — sixth paragraph, sentence describing the replacement module's parser: “It implements its own command line parser and re-implements the I/O redirections in Perl.”
- **E3** — CVE-2019-11539: Post-auth(admin) Command Injection — ninth paragraph, final sentence reporting a format-compatibility obstacle: “However, it seems impossible to write a polyglot file in both PCAP and Perl format.”
- **E4** — CVE-2019-11542: Post-auth(admin) Stack Buffer Overflow — third paragraph, diagnostic instruction before the fault log: “And you can observed the segment fault from dmesg”
- **E5** — CVE-2019-11538: Post-auth(user) Arbitrary File Reading via NFS — first paragraph, second sentence: “It appears only if the admin configures the NFS sharing for the VPN users.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `source-code-auditing` / heuristic: Prioritize feature-specific exceptions to otherwise strict validation. State which acceptance rule the exception broadens and whether later resource selection still obeys the baseline invariant. (evidence E1).
- `source-code-auditing` / workflow: Resolve runtime replacements of familiar operations before classifying a sink. Audit the replacement parser and transformation contract rather than inheriting the builtin's behavior. (evidence E2).

**Tool attribution:**
- dmesg → Read kernel diagnostic messages to corroborate a reported native process fault. → A crash needs a diagnostic record in an authorized isolated environment; the record establishes a fault, not stronger impact.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `source-code-auditing` → `dynamic-analysis` when A feature exception or replacement runtime operation leaves one validation or consumption behavior unresolved.. Packet: Authorization, isolation, artifact revision, runtime, configuration and actor, One unresolved question with contrasting predictions, Evidence locations, collection method and source-report versus observed classification, Minimal validation-to-consumer slice and effective wrapper contract, Benign baseline, negative control and exact observation points, Allowed modification budget, failed assumptions, coverage limits and stop condition. Gate: The artifact and necessary feature state are known, and the proposed harmless observation distinguishes invariant preservation from violation. A familiar API name or the existence of a permissive branch alone is insufficient.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `dynamic-analysis` → `exploitability-assessment` when A fault or partial capability is being interpreted as broader security impact.. Packet: Authorization, artifact identity, runtime, configuration, actor and intended boundary, Unresolved impact question and evidence classification, Invariant, earliest violating operation and diagnostic context, Observed capability constraints, feature and permission prerequisites, and actual mitigations, Producer/consumer compatibility assumptions and failed observations, Original versus modified environment, collateral effects, cleanup and missing capabilities, Narrow next observation, limits and stop condition. Gate: Require evidence of a reachable violation or label the assessment explicitly source-report/static-only. A diagnostic fault is not execution proof; optional-feature and format constraints must remain in the impact statement.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- The findings concern historical appliance builds and embedded runtimes. The custom parser's behavior and feature-specific validation exceptions were not checked on current releases or alternate implementations.
- The remote-sharing findings explicitly require an administrator-enabled feature and do not apply to default configurations; actor and feature prerequisites cannot be dropped.
- The author reports both an unavailable utility feature and a failed output-format compatibility attempt. These bound particular hypotheses in that environment, not every possible consequence of the underlying defect.
- Kernel fault diagnostics support reported crashes only. All compromise results, customer-case outcomes, fixes and mitigation claims remain author reports; no source code, attachment, target or shipped fix was executed or independently validated.

**Operational owners:** [source-code-auditing](../../skills/source-code-auditing/SKILL.md)

## O018

**Article:** [Attacking SSL VPN - Part 2: Breaking the Fortigate SSL VPN](https://blog.orange.tw/posts/2019-08-attacking-ssl-vpn-part-2-breaking-the-fortigate-ssl-vpn/)
**Worker:** `worker-o018v001`; [packet](extractions/O018.json).
**Orchestrator decision:** Retain provisional upstream/registration anchors and paired sizing/emission capacity contracts.
**Editorial qualifications:** Deferred reclamation supports baseline impact constraints only. Reject candidate 3: the short fuzzing pivot has no engine, harness, corpus/reset, coverage or reproducibility evidence.

**Method evidence (short source quotations):**
- **E1** — Web daemon, second paragraph, final sentence on mapping upstream source: “We can map the source code of apache to speed up our analysis.”
- **E2** — Web daemon, third paragraph, final sentence on the handler table: “We can find a table specifying the handlers and dig into them!”
- **E3** — CVE-2018-13381: Pre-auth heap overflow, paragraph between the sizing pseudocode and encoding pseudocode: “However, there is an inconsistency between length calculation and encoding process. The encode part does not handle that much.”
- **E4** — Exploitation / CVE-2018-13381 / Apache additional memory management., sole paragraph, first two sentences: “The memory won’t be free() until the connection ends. We cannot arrange the heap in a single connection.”
- **E5** — Get the shell, second paragraph beginning 'Due to the problems mentioned above', final clause describing the switch to fuzzing: “and we started to fuzz the server, trying to get something useful.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `binary-auditing` / heuristic: For a symbol-poor monolithic image containing recognizable upstream components, combine provisional source correspondence with handler-registration tables to bound review. Record local modifications and unresolved correspondence rather than importing the upstream contract wholesale. (evidence E1, E2).
- `memory-safety-auditing` / validation: Audit sizing and emission as one paired contract: compare input-class predicates, units and emitted extents, and require estimated capacity to cover actual output. Extra input classes and benign controls are derived test questions, not source-performed regressions. (evidence E3).

**Proposed handoffs (derived, not author-agent claims):**
- `binary-auditing` → `dynamic-analysis` when Upstream-source resemblance and a registration table suggest a handler contract, but implementation correspondence or reachability remains uncertain.. Packet: authorized_scope_and_artifact_identity, actor_configuration_and_interface_gate, handler_registration_and_bounded_code_slice, upstream_reference_and_confidence_tagged_correspondence, unresolved_contract_question_and_contrasting_predictions, benign_baseline_and_observation_points, allowed_observer_changes_and_coverage_limits. Gate: Require a specific handler reference and a falsifiable contract question. Upstream similarity alone is not implementation proof; inferred reachability must remain labeled inferred until a safe observation resolves it.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `memory-safety-auditing` → `exploitability-assessment` when Sizing and emission disagree, but framework allocation lifetime constrains the supported consequence.. Packet: authorized_scope_actor_build_and_configuration, sizing_emission_relation_and_capacity_invariant, earliest_invalid_access_or_explicit_static_only_status, constrained_primitive_and_input_transformations, allocation_domain_and_connection_scoped_reclamation, interference_cleanup_and_collateral_effects, source_report_vs_independent_observation, failed_assumptions_reproduction_counts_and_missing_capabilities. Gate: Accept only a bounded primitive or explicitly static hypothesis. Retained allocations and failed control assumptions must remain visible; neither a final crash nor a failed impact attempt establishes arbitrary control or non-exploitability.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical 2019 report about Fortigate SSL VPN. Its affected-build assumptions and upgrade recommendations are not evidence about current releases, configurations, or deployed repairs.
- The authors describe a modified upstream server in a large symbol-poor binary. Upstream source is an analysis aid, not a substitute for confirming the shipped implementation; detailed correspondence validation and reconstruction-tool settings are not supplied.
- The abandoned direct-impact attempt reportedly faced restricted byte control, shared allocations across connections and libraries, background activity, deferred reclamation, and allocator separation. These constrain that attempt; they do not repair the defect or prove every impact hypothesis impossible.
- The fuzzing account names no engine and documents no corpus, harness equivalence, initialization/reset contract, coverage, minimization process, or reproduction denominator. No such details are inferred here.
- Crash observations, stronger consequences, retry/recovery claims, and fix coverage remain source-author reports. Only article text was independently checked; no target was tested, exploit attachment retrieved, demonstration played, or shipped patch examined.

**Operational owners:** [binary-auditing](../../skills/binary-auditing/SKILL.md), [memory-safety-auditing](../../skills/memory-safety-auditing/SKILL.md)

## O019

**Article:** [Attacking SSL VPN - Part 1: PreAuth RCE on Palo Alto GlobalProtect, with Uber as Case Study!](https://blog.orange.tw/posts/2019-07-attacking-ssl-vpn-part-1-preauth-rce-on-palo-alto/)
**Worker:** `worker-o019v001`; [packet](extractions/O019.json).
**Orchestrator decision:** Retain documented-consumer semantics as an observation-selection clue, explicitly bounded against disruptive non-crash timing.
**Editorial qualifications:** Safe ceilings, matched controls and confounder checks are defensive synthesis; the source amplification example is not a benign test. E5 is a quoted deployment-owner assessment, not independent isolation proof.

**Method evidence (short source quotations):**
- **E1** — The story — paragraph beginning 'About the vulnerability', final sentence after the failed newer-release reproduction report: “So we began to suspect if this is a known vulnerability.”
- **E2** — How to verify the bug — first paragraph, final sentence following the no-output and crash-avoidance discussion: “In order to avoid crashes, we need to find a way to verify the vulnerability elegantly!”
- **E3** — How to verify the bug — second paragraph, opening clause containing the 'snprintf manual' link: “By reading the snprintf manual”
- **E4** — How to verify the bug — second paragraph, final sentence before the timing examples: “We observe the response time of large repeat number to verify this vulnerability!”
- **E5** — The case study — quoted deployment-owner response, second paragraph, clause explaining the infrastructure-access limitation: “this would not have been able to access any of our internal infrastructure or core services.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `dynamic-analysis` / validation: When direct output is absent, use documented consumer semantics to design a benign observable rather than default to a crash. For timing-based observations, require an isolated lab, explicit workload limits, matched baselines and confounder checks; do not equate a delay with a stronger capability or with safe testing. (evidence E2, E3, E4).

**Tool attribution:**
- snprintf manual (API documentation) → Understand documented consumer semantics to identify an observable alternative to crash-based confirmation. → The suspected behavior has no direct output and the investigation needs a less disruptive observation design.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `dynamic-analysis` → `patch-diff-analysis` when Behavior differs across deployments and the outstanding question is historical applicability or an undisclosed fix, rather than stronger impact.. Packet: Authorization, actor, isolation and recovery scope, Original and comparison artifact/build identities, configurations and provenance, Falsifiable changed-behavior question and contrasting predictions, Observed difference, known-good baseline, failed attempts and unmatched variables, Disclosure and vendor-statement provenance, separately classified as reports, Untested scope, next bounded review question and stop condition. Gate: Identify comparable artifacts and configurations, or explicitly return the missing identity/configuration question. A failed attempt or a vendor statement is not proof of the changed invariant or a shipped fix; preserve that distinction before any patch conclusion.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `dynamic-analysis` → `exploitability-assessment` when A limited observation supports further investigation, but the primitive and downstream deployment boundaries remain unresolved.. Packet: Authorization, actor, artifact/configuration identity and original-versus-modified environment, Observation question, benign baseline, contrasting predictions and evidence provenance, Observed effect, workload limits, controls, repetitions and unresolved confounders, Constrained capability claim, missing capabilities and collateral effects, Deployment isolation and reachable-resource claims with owner-report versus observed labels, Negative evidence, uncertainty, next harmless question and stop condition. Gate: A timing difference alone does not establish execution or cross-boundary access. Require a constrained primitive or an explicit hypothesis-only classification; each downstream capability edge needs prerequisites and evidence. Owner-reported isolation remains reported unless corroborated.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- All vulnerability, reproduction, historical fix and case-study outcomes remain author or quoted deployment-owner reports; this extraction performed no target testing or independent replication.
- The failed newer-deployment attempt is not a controlled old/new artifact comparison. The article does not supply a semantic patch diff proving which change caused the behavioral difference.
- The affected-release claims and the vendor's internally-fixed response are historical statements, not verification of present releases or deployed artifact contents.
- Avoiding a crash does not make a work-amplifying timing observation harmless. The published examples do not establish a repetition denominator, matched load/network controls or a generally safe workload budget.
- The quoted infrastructure-access limitation is the deployment owner's assessment. It bounds the reported case study, but does not independently demonstrate every possible downstream route or absence of other local impact.

**Operational owners:** [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md)

## O020

**Article:** [A Wormable XSS on HackMD!](https://blog.orange.tw/posts/2019-03-a-wormable-xss-on-hackmd/)
**Worker:** `worker-o020v001`; [packet](extractions/O020.json).
**Orchestrator decision:** Retain customization/pass-through callbacks as distinct integration guarantees instead of assuming mature-library or default-path safety.
**Editorial qualifications:** Inert-content classification and remaining execution policies merge into existing semantic/sandbox gates without another workflow. Policy checker recommendation is not an author run or runtime enforcement evidence.

**Method evidence (short source quotations):**
- **E1** — 漏洞成因 — paragraph beginning 因此把焦點放到函示庫的使用上: “因此把焦點放到函示庫的使用上，再安全的函示庫碰到不安全的用法也會無用武之地”
- **E2** — 漏洞成因 — paragraph beginning 為了提供開發者可以自由的客製化過濾的處理, explaining the comment-preserving callback: “開發者判斷了如果是註解的標籤便直接回傳原始的 HTML 內容”
- **E3** — 漏洞成因 — paragraph beginning 可以想像開發者原本的用意, questioning the comment-content trust assumption: “既然它這麼相信註解中的內容，那我們來看一下是否可以從註解標籤中去汙染 DOM 的渲染!”
- **E4** — 繞過 CSP 政策 — opening paragraph contrasting insertion with the independent execution restriction: “但事情不是憨人想的那麼簡單，為了防止未知的 XSS 攻擊，HackMD 使用了 CSP(Content Security Policy) 去阻擋未授權的 JavaScript 代碼執行!”
- **E5** — 繞過 CSP 政策 — closing P.S. paragraph recommending a policy-checking tool: “可以使用 Google 所提供的 CSP Evaluator 來檢測!”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `source-code-auditing` / heuristic: When an application customizes a security library, review pass-through callbacks and preservation exceptions as distinct contracts. Record how each override changes default guarantees before prioritizing an upstream-library defect hypothesis. (evidence E1, E2).

**Tool attribution:**
- CSP Evaluator → Review whether a browser content-security policy has problematic configuration. → The article recommends it to readers uncertain about policy correctness; it does not report the author running it. Treat findings as review leads, not enforcement proof.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `source-code-auditing` → `parser-differential-auditing` when An application-defined filtering exception preserves content as inert, while the final consumer's interpretation remains unresolved.. Packet: authorized_scope_and_artifact_revision, falsifiable_interpretation_question, default_library_contract_and_application_override, preserved_content_class_and_representation_map, final_consumer_and_intended_invariant, contrasting_benign_predictions, evidence_locations_and_collection_method, source_report_classification_and_limits, bounded_next_observation_and_stop_condition. Gate: Identify both the exception and final consumer, and give distinguishable interpretation predictions. A preservation branch alone must not be classified as a demonstrated policy violation.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `sandbox-boundary-analysis` → `exploitability-assessment` when A content-structure defect is being considered for stronger impact, but an independent execution policy remains relevant.. Packet: authorized_scope_artifact_revision_and_configuration, starting_actor_and_execution_context, falsifiable_impact_question, structure_effect_and_evidence_classification, active_policy_and_enforcement_layer_table, loading_versus_execution_guarantees, remaining_denials_and_interaction_requirements, evidence_locations_collection_method_and_limits, missing_capabilities_and_bounded_next_observation. Gate: Separate structural acceptance from executable capability, retain the actual policy and unknowns, and distinguish author reports or static findings from independently observed impact. A policy-linter finding cannot satisfy the execution gate.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- The explanation is historical and explicitly uses CodiMD 1.2.1. Current HackMD/CodiMD behavior, dependency versions and deployed policies were not checked.
- The library-maturity assessment rests on documentation and public project signals, not a proof of library correctness. Prioritizing integration review does not establish that the dependency is defect-free.
- All vulnerability, execution and collaborative-editing results remain author reports. No source code, payload, attachment, demonstration video or target test was executed by this extraction.
- The wormable characterization is conditional; this extraction provides no independent propagation, reliability or affected-user evidence.
- The author says the latest CodiMD release was fixed and links a pull request. Neither the fix diff nor shipped/deployed artifacts were inspected, so repair and rollout are unverified here.

**Operational owners:** [source-code-auditing](../../skills/source-code-auditing/SKILL.md)

## O021

**Article:** [Hacking Jenkins Part 2 - Abusing Meta Programming for Unauthenticated RCE!](https://blog.orange.tw/posts/2019-02-abusing-meta-programming-for-unauthenticated-rce/)
**Worker:** `worker-o021v001`; [packet](extractions/O021.json).
**Orchestrator decision:** Retain preparation-phase behavior selection and phase-specific guard coverage with integration dependencies and independent gates.
**Editorial qualifications:** Dependency failures support existing configuration comparison. objdump is from a separate benign illustration, not service reachability proof. No optimizer-invariant claim is made merely because compilation occurs.

**Method evidence (short source quotations):**
- **E1** — How to Exploit? (How-to-Exploit), opening paragraph asking about compilation/parsing side effects: “Compiling(or parsing) is a hard work with lots of tough things and hidden features. So, the idea is, is there any side effect we can leverage?”
- **E2** — How to Exploit? (How-to-Exploit), paragraph after the compile-time calculation illustration and immediately before the objdump disassembly listing: “From the assembly language of compiled binary, we can make sure the result is calculated at compile-time, not run-time!”
- **E3** — First Attempt (First-Attempt), root-cause paragraph beginning 'With a little bit digging, we found the root cause.': “As a result, the problem become lack of corresponding library in classPath during compile-time.”
- **E4** — Epilogue (Epilogue), opening paragraph contrasting the sandbox's runtime coverage with compile-time behavior: “Although there is a built-in Groovy Sandbox(Script Security Plugin) on Jenkins to protect the Pipeline, it’s useless because the vulnerability is in compile-time, not in run-time!”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `deserialization-and-dispatch-auditing` / heuristic: Do not classify validation, parsing or compilation as inert merely because ordinary program execution is absent. Enumerate the processing phases and user-influenced preparation hooks, then state a falsifiable side-effect invariant. (evidence E1, E4).
- `sandbox-boundary-analysis` / validation: Make the policy-layer table phase-aware: an execution-time guard is not evidence that preparation-time behavior is constrained. Require phase-specific enforcement evidence and preserve all remaining authorization and isolation restrictions. (evidence E1, E4).

**Tool attribution:**
- objdump → Inspect generated instructions to distinguish a compilation-time computed value from runtime computation. → A benign compilation illustration needs phase attribution; its disassembly does not establish service reachability or security-policy coverage.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `source-code-auditing` → `dynamic-analysis` when An allegedly inert validation path has an unresolved preparation-phase effect or a standalone/integrated behavior mismatch.. Packet: Authorized artifact, runtime, configuration, actor and isolation scope, Minimal validation-to-preparation source slice and proposed phase invariant, Phase-specific dependencies and original versus modified environment differences, One unresolved question with contrasting benign predictions, Observation points, instrumentation budget and stop condition, Evidence provenance, failed assumptions and untested scope. Gate: The benign observation must distinguish the predicted phases under a documented baseline; a configuration change cannot silently substitute for the original environment. Reject a packet that contains only an alarming API name or an unexplained dependency error.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `source-code-auditing` → `sandbox-boundary-analysis` when The source slice suggests behavior occurs before the phase covered by the advertised execution guard.. Packet: Authorized revision, actor, reachable interface and policy context, Processing-phase map and guard locations, Behavioral hook evidence with author-report versus local-observation classification, Claimed and demonstrated capabilities, including remaining gates, Benign boundary-check question, denied control and stop condition, Configuration prerequisites, modification ledger and uncertainty. Gate: Identify the exact phase and enforcement location before assessing coverage. The consumer may analyze a source-only hypothesis but must not promote it to a demonstrated sandbox escape or unauthenticated impact.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical 2019 Jenkins/Groovy account. Vulnerability and impact statements remain author reports; no code execution, target interaction, present-release check or shipped-fix verification was performed.
- The first standalone result failed in the integrated service because a compile-time library dependency was unavailable. An administrator-controlled configuration change would alter the evaluated claim and cannot establish default-environment portability.
- The explicit objdump usage belongs to a C++ compile-time calculation illustration, not a verification of the service's behavioral reachability.
- Compile-time versus runtime coverage does not by itself establish unauthenticated reachability. Permission requirements and the separately linked routing issue remain distinct, unverified prerequisites; this packet retains no chain to overcome them.

**Operational owners:** [deserialization-and-dispatch-auditing](../../skills/deserialization-and-dispatch-auditing/SKILL.md), [sandbox-boundary-analysis](../../skills/sandbox-boundary-analysis/SKILL.md)

## O022

**Article:** [Hacking Jenkins Part 1 - Play with Dynamic Routing](https://blog.orange.tw/posts/2019-01-hacking-jenkins-part-1-play-with-dynamic-routing/)
**Worker:** `worker-o022v001`; [packet](extractions/O022.json).
**Orchestrator decision:** Retain framework conventions, eligible inherited/returned receivers and effective action permission independently of entry admission.
**Editorial qualifications:** Do not adopt E2's overbroad Java type slogan. Preserve no-result observations, independent action checks and unresolved actor/plugin/version gates; no traversal sequence is copied.

**Method evidence (short source quotations):**
- **E1** — Vulnerability Analysis — opening paragraph introducing naming-convention URL resolution.: “In order to provide developers more flexibilities, Jenkins uses a naming convention to resolve the URL and invoke the method dynamically.”
- **E2** — 1. Everything is the Subclass of java.lang.Object — opening paragraph, first sentence.: “In Java, everything is a subclass of java.lang.Object.”
- **E3** — 2. Whitelist Bypass — paragraph immediately after the prefix-list code block; substring of its first sentence.: “if you can find a cross reference from the white-list entrance jump to other objects, you can still bypass this URL prefix check!”
- **E4** — 2. Whitelist Bypass — paragraph after the example method sequence, first sentence reporting unsuccessful result retrieval.: “This execution chain seems smooth, but sadly, it can not retrieve the result.”
- **E5** — How to Exploit? — paragraph about configurable objects; sentence explaining repeated permission checks before sensitive actions.: “Most developers will check the permission before the dangerous action again.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `deserialization-and-dispatch-auditing` / heuristic: For convention-based dispatch, determine actual receiver types, eligibility/visibility rules, inherited members and returned receivers. Compare the intended selectable set with effective behavior; broad language slogans and root entry registration do not establish complete exposure. (evidence E1, E2, E3).
- `authorization-auditing` / workflow: Evaluate an entry allowlist against the effective action/object after receiver traversal. Distinguish admission policy from independent action-level permission checks, and retain intact downstream checks as explicit capability constraints. (evidence E3, E5).

**Proposed handoffs (derived, not author-agent claims):**
- `deserialization-and-dispatch-auditing` → `authorization-auditing` when Convention-based selection can reach receivers beyond those suggested by the entry allowlist, but effective action-level authority remains unresolved.. Packet: Scope, artifact revision, runtime/configuration, actor and intended boundary, Selection convention, receiver-reference model and inherited-member coverage, Entry admission policy versus effective action/object permission checks, Source-report and static-inference labels for every proposed transition, Failed paths, untested alternatives and remaining policy question, Benign contrasting observation design and stop condition. Gate: The effective receiver/action and its relevant gates are identified or explicitly marked unresolved. Entry admission alone is not accepted as evidence of protected-action authority; no source object chain is transferred.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `authorization-auditing` → `exploitability-assessment` when A reported entry-policy failure exists, while result observability or a downstream permission check limits stronger impact claims.. Packet: Scope, actor, configuration and revision-dependent prerequisites, Narrow violated policy and independently enforced downstream checks, Reachability, result observability and protected effect recorded separately, Author-reported versus independently observed evidence classification, Failed observations, missing capabilities and collateral state changes, Next harmless observation, contrasting predictions and stop condition. Gate: Each claimed capability has evidence and prerequisites; inaccessible results and surviving permission gates remain explicit limits. Source-only evidence remains an author report, not demonstrated local impact.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- The author explicitly scoped a partial, high-impact review to Jenkins core, its routing framework and suggested plugins; this is not an exhaustive application or extension audit.
- The review and disclosure concern historical 2018 behavior, published in 2019. Anonymous-readable and authenticated configurations differ; optional modules and actor privileges affect reachability. No current installation was assessed.
- One illustrated traversal did not return the desired result, and the author also reports that setter invocation was unavailable. Neither a theoretical invocation nor this failed observation establishes a general impact or safety conclusion.
- The author reports that many sensitive actions enforce their own permissions. A separate stronger claim required a known credential identifier whose acquisition was not established; missing prerequisites are not assumed satisfied.
- The TODO section reports that an added user-object permission check invalidated the original access route after Jenkins 2.138. The reported fix also changed routing protections in both application and framework; no shipped artifact or repair completeness was verified here.
- All vulnerability outcomes remain author reports. Extraction used read-only article retrieval and DOM quote checks only; no code execution, attachment retrieval, target requests or independent reproduction occurred.

**Operational owners:** [authorization-auditing](../../skills/authorization-auditing/SKILL.md), [deserialization-and-dispatch-auditing](../../skills/deserialization-and-dispatch-auditing/SKILL.md)

## O024

**Article:** [How I Chained 4 Bugs (Features?) into RCE on Amazon Collaboration System](https://blog.orange.tw/posts/2018-08-how-i-chained-4-bugs-features-into-rce-on-amazon/)
**Worker:** `worker-o024v001`; [packet](extractions/O024.json).
**Orchestrator decision:** Retain allowed-result provenance and later interpretation as a distinct behavior-consumer contract.
**Editorial qualifications:** Other proposals support existing normalization, handler-observation and semantic-policy gates. No operation chain, missing-identity escalation or lexical bypass is adopted.

**Method evidence (short source quotations):**
- **E1** — Introduction before Foreword, paragraph beginning 'It’s hard to write a well-designed parser.', final sentence: “Therefore, if there is any inconsistency between the filter and the called method, the security mechanism can be easily bypassed!”
- **E2** — 1. Path normalization bug leads to ACL bypass, explanatory paragraph immediately after the paired response example: “It’s because the servlet logic is unable to obtain a valid user principle”
- **E3** — 3. Double evaluation leads to EL injection, paragraph beginning 'To make things worse,' before the call-stack description: “To make things worse, if the previous one returns a string, and the string looks like an EL. Seam framework will invoke again!”
- **E4** — 3. Double evaluation leads to EL injection, paragraph beginning 'Why we choose this?', explanation of return-value provenance: “returns a string that we can control from query string!”
- **E5** — 4. EL blacklist bypass leads to RCE, paragraph beginning 'With a little bit studying,', description of the blacklist mechanism: “we found the blacklist is just a simple string matching”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `deserialization-and-dispatch-auditing` / workflow: Review the complete lifecycle of an allowed operation's result. Record whether an actor-controlled return value remains inert data or becomes input to another interpreter, and enumerate that consumer's independent checks. (evidence E3, E4).

**Proposed handoffs (derived, not author-agent claims):**
- `parser-differential-auditing` → `dynamic-analysis` when Guard and downstream routing interpretations may disagree, but the observed failure does not establish consumer identity or completion.. Packet: authorized scope, artifact identity and runtime configuration, one unresolved question and contrasting predictions, guard-versus-consumer representation and rule table, policy decision and handler observation points, benign baseline and rejection controls, identity/state prerequisites and failure paths, source reports, inferred edges and failed assumptions, bounded next observation and stop condition. Gate: The packet identifies both interpretation sites and a harmless observation that distinguishes routing from required identity/state. Response behavior alone is not accepted as successful sensitive consumption; original and modified environments must remain separate.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `data-flow-analysis` → `deserialization-and-dispatch-auditing` when An initially constrained operation may return actor-controlled data to a later interpreter.. Packet: authorized scope, artifact identity and configuration, question and expected versus unintended behavior, source-to-return-value flow and controllable subset, return type, transformations and later consumer, initial and later selection/validation guarantees, actor, identity and state gates, evidence classification and unresolved edges, benign observation plan, limits and stop condition. Gate: The consumer requires a documented return-value origin and later interpretation site, with each edge observed or explicitly marked inferred. Initial selection restrictions are not treated as a transitive guarantee, and no executable gadget chain is required or accepted.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical public case study. Vulnerability, execution and mitigation outcomes are author reports; no target interaction, exploit execution, attachment retrieval or independent reproduction was performed.
- The reported missing-identity exception limits the first observation: changed rejection behavior did not establish successful authenticated handler completion.
- Interpretation differences depend on the actual application filter, container, framework and configuration. The article's broad default-exposure claim is not generalized to all deployments.
- Later expression interpretation was not initially sufficient for system-level execution; additional interpreter restrictions remained. Those restrictions and their reported defeat were not independently tested.
- The maintenance reply assessed impact using a prior file-upload prerequisite, while the investigation described a different return-value influence model. Prerequisites must be established from the actual flow, not inherited from that correspondence.
- The fix sections report server isolation, lack of an upstream repair because of lifecycle limits, and a downstream framework override. No patch diff, shipped artifact, deployment state or regression coverage was independently reviewed.

**Operational owners:** [deserialization-and-dispatch-auditing](../../skills/deserialization-and-dispatch-auditing/SKILL.md)

## O027

**Article:** [PHP CVE-2018-5711 - Hanging Websites by a Harmful GIF](https://blog.orange.tw/posts/2018-01-php-cve-2018-5711-hanging-websites-by/)
**Worker:** `worker-o027v001`; [packet](extractions/O027.json).
**Orchestrator decision:** Retain failure/progress marker meaning across receiving-type conversion and the decision/termination dependency.
**Editorial qualifications:** Wrapper resolution and bounded loop observation already exist. Unsigned does not mean always positive; zero is representable. Timeout alone proves neither root cause nor service-wide exhaustion.

**Method evidence (short source quotations):**
- **E1** — Vulnerability Details, second prose paragraph (article paragraph 5), wrapper discussion: “Function GetCode is just a wrapper, and GetCode_ do the real stuff.”
- **E2** — Vulnerability Details, fifth prose paragraph (article paragraph 8), opening sentence of the type-conversion explanation: “The bug relied on the type conversion from int to unsigned char.”
- **E3** — Vulnerability Details, fifth prose paragraph (article paragraph 8), clause explaining why the expected termination update is not reached: “But it will never be executed because the definition of count is unsigned char,”
- **E4** — Vulnerability Details, sixth prose paragraph (article paragraph 9), final fragment of the reported consequence sentence: “an infinite loop and exhausted the server resource.”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `data-flow-analysis` / heuristic: Treat failure markers as a representation contract: record the producer's return type, receiving type, implicit conversion and branch interpretation, then ask whether each failure remains distinguishable from valid data at the consumer. (evidence E2, E3).

**Proposed handoffs (derived, not author-agent claims):**
- `data-flow-analysis` → `dynamic-analysis` when A failure result may change meaning before a loop-exit guard, and concrete value, branch or progress behavior remains unresolved.. Packet: Authorization, isolated artifact identity, revision, runtime and feature configuration, Minimal producer-to-conversion-to-guard slice and relevant loop-exit state, Callee failure contract, receiving representation and expected post-conversion meaning, One unresolved value or branch and contrasting predictions for preserved versus lost failure semantics, Observation points, known-good control, resource ceiling, stop condition and recovery constraints, Source-report versus local-observation classification, failed assumptions and untested application reachability. Gate: Accept only a safely bounded lab design that can distinguish the conversion and exit-state hypotheses while retaining a known-good control. A timeout alone cannot establish the conversion defect or service-wide exhaustion; missing application gates remain unresolved.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is article and embedded-source inspection only. The author's nontermination and resource-exhaustion results were not independently reproduced; no code, demonstration input or target was executed.
- The explanation calls the unsigned receiving value always positive, although zero is representable. The supported inference is loss of a negative failure result, not that every possible value defeats termination.
- The application-impact claim assumes untrusted uploads reach the affected decoder. The article supplies no application-level gate map, worker-limit measurements, recovery behavior or denominator supporting whole-service exhaustion.
- The affected-release list is historical and is not proof for current releases, all builds or all configurations. Linked source and advisory references were not inspected, and no shipped-fix or semantic patch comparison was performed.
- No named investigation tool has a stated reusable purpose outside the omitted demonstration. The article does not report a fuzzing campaign, instrumentation method, failed experiments or a regression-validation procedure. The handoff and proposed bounded validation are library-derived, not author usage.

**Operational owners:** [data-flow-analysis](../../skills/data-flow-analysis/SKILL.md)

## O028

**Article:** [How I Chained 4 vulnerabilities on GitHub Enterprise, From SSRF Execution Chain to RCE!](https://blog.orange.tw/posts/2017-07-how-i-chained-4-vulnerabilities-on/)
**Worker:** `worker-o028v001`; [packet](extractions/O028.json).
**Orchestrator decision:** Retain mediated-request control, framing/encoding and handshake limits as a constrained capability contract.
**Editorial qualifications:** Adapter slices and benign console options support baseline methods only. Do not combine request, internal service and reconstruction observations into an execution sequence.

**Method evidence (short source quotations):**
- **E1** — First Bug - Harmless SSRF: standalone paragraph immediately following the request-limitations list: “The only thing we can control is Path part.”
- **E2** — Second Bug - SSRF in Internal Graphite: opening paragraph posing the next investigation question: “We have a SSRF now, with lots of limitations. What can I do? My next idea is - Is there any Intranet services we can leverage?”
- **E3** — Third Bug - CR-LF Injection in Python: first item of the numbered protocol-smuggling limitations list: “Protocols with handshakes like SSH, MySQL and SSL will fail”
- **E4** — Fourth Bug - Unsafe Deserialization: first two sentences of the source-review paragraph about stored application objects: “While reviewing the source. I am curious about why GitHub can store Ruby Objects in Memcached.”
- **E5** — Fourth Bug - Unsafe Deserialization: paragraph caption immediately preceding the console transcript: “Unsafe Marshal in Rails Console”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `exploitability-assessment` / heuristic: For a server-mediated request, inventory field-level influence, request-method restrictions, framing/encoding constraints and required handshake state separately. Reachability alone does not establish general message control. (evidence E1, E3).

**Tool attribution:**
- Rails console → The captioned console transcript inspects the cache wrapper and contrasts ordinary retrieval with raw retrieval, exposing an implicit object-representation conversion. Only this inspection purpose is retained, not its unsafe execution demonstration. → Source review raises a question about how an adapter stores and retrieves application objects; the safe library adaptation is an isolated authorized model with benign values.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `attack-surface-mapping` → `source-code-auditing` when A constrained reachable interface leaves the downstream adapter's guarantees unresolved.. Packet: authorization, artifact revision, runtime and configuration, actor, processing identity, interface and handler/gate references, controllable fields, preserved restrictions and reachability evidence, downstream component/source provenance and inferred edges, one falsifiable contract question and contrasting expectations, evidence classification, negative results, untested scope and bounded next review with stop condition. Gate: A prioritized boundary has a documented handler/gate or is explicitly inferred, and its control restrictions and smallest unresolved contract question are stated. Author-reported reachability is not promoted to independently confirmed exposure.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `source-code-auditing` → `deserialization-and-dispatch-auditing` when Adapter review suggests that shared storage may reconstruct objects implicitly during retrieval.. Packet: authorization, artifact/runtime/dependency revisions and configuration, writer-storage-reader slice with source references and inferred edges, input/stored/consumed representations and adapter transformations, writer trust, reader identity and reconstruction context, one unresolved behavior-selection question with contrasting predictions, benign baseline and proposed distinguishing observation, classification, controls, failed assumptions, untested scope and stop condition. Gate: The packet locates the suspected representation conversion and its prerequisites, labels unobserved gates, and proposes a harmless distinguishing observation. Rich-object storage or a serializer name alone does not establish unintended behavior.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- All vulnerability, execution and fix outcomes are author reports from a historical appliance study; no target, exploit or current release was tested.
- The request restrictions and byte-encoding constraints depend on the historical client/runtime and configuration. The author expressly reports handshake-dependent protocols as incompatible; general protocol control is not established.
- The retrospective investigation does not supply an exhaustive internal-service inventory, reproducibility denominator or systematic negative-control logs.
- The console transcript includes unsafe execution material. Its retained inspection purpose does not endorse that demonstration or independently establish feasible behavior selection.
- The reported fix combines request-address filtering, route confinement and network filtering. The article alone does not verify complete underlying invariant repair, equivalent-path coverage or active enforcement in a current shipped artifact.

**Operational owners:** [exploitability-assessment](../../skills/exploitability-assessment/SKILL.md)

## O029

**Article:** [GitHub Enterprise SQL Injection](https://blog.orange.tw/posts/2017-01-bug-bounty-github-enterprise-sql-injection/)
**Worker:** `worker-o029v001`; [packet](extractions/O029.json).
**Orchestrator decision:** Retain role-specific abstraction guarantees: protected values do not automatically establish protection of structural arguments.
**Editorial qualifications:** Source recovery and caller/feature gates support existing methods. Local administrative inspection is not unauthenticated API reachability; recovered-source correspondence remains unresolved.

**Method evidence (short source quotations):**
- **E1** — Environment — opening port-scanning paragraph; following service-identification discussion provides architecture context.: “The beginning of everything is Port Scanning. After using our good friend - Nmap”
- **E2** — Environment — paragraph immediately after the third-party source-recovery shortcut and before the disassembler screenshots.: “But to be a hacker. We can’t just use it without knowing how it works. So, let’s open IDA Pro!”
- **E3** — Code Analysis — opening paragraph before the source-language inventory.: “After de-obfuscated all the code. Finally, we can start our code reviewing process.”
- **E4** — Vulnerability — ORM-misuse paragraph following the model-level source excerpt.: “But there are so many misuse of ActiveRecord may cause SQL Injection.”
- **E5** — Vulnerability — paragraph introducing caller tracing; the following caller discussion and credential-prerequisite paragraph supply influence and gate context.: “OK, let’s trace up!”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `source-code-auditing` / heuristic: Distinguish abstraction APIs that bind data from APIs that accept query structure. Inspect each argument's actual safety contract rather than treating use of the abstraction as universal protection. (evidence E4).

**Tool attribution:**
- Nmap → Discover exposed network listeners to orient the interface inventory. → At the beginning of an explicitly authorized environment survey; subsequent service and handler attribution remains a separate question.; **explicit** attribution.
- IDA Pro → Inspect the native source-obscuring helper to understand the recovery mechanism rather than blindly adopting an external shortcut. → Readable application source is blocked by a companion runtime helper whose behavior is not yet understood.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `binary-auditing` → `source-code-auditing` when A source-visibility obstacle has been characterized sufficiently to make application code available for review.. Packet: Authorized artifact provenance, revision, runtime and configuration, Blocking mechanism and bounded helper contract with confidence labels, Original versus recovered source provenance, coverage and discrepancies, Service-to-source mapping and unresolved audit question, Evidence collection method, claim classification and scope limits, Next bounded review and stop condition. Gate: Recovered code is tied to the declared artifact, and recovery assumptions and unsupported regions remain explicit. Successful recovery is not itself a security finding.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `source-code-auditing` → `data-flow-analysis` when An abstraction call appears to accept unconstrained structure, but actor influence and path feasibility remain unresolved.. Packet: Actor, authorized scope, artifact provenance and configuration, Minimal external-field, caller and consumer slice with evidence locations, Representation changes and argument-level safety guarantees, Feature and permission constraints, evidenced edges and missing edges, Claim classification, failed assumptions and scope limits, Disconfirming observation, next bounded question and stop condition. Gate: Each flow edge and prerequisite is evidenced or explicitly unresolved. A framework label or suspicious method name alone does not prove a reachable violation.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical GitHub Enterprise appliance investigation with administrative access for local inspection; source access does not establish the remote API actor's privileges.
- The article describes a scoped-credential prerequisite, but not a complete least-privileged actor or authorization matrix. No unauthenticated reachability is inferred.
- Source recovery, data-flow feasibility and vulnerability-response observations remain author reports; this extraction did not execute recovery code or reproduce target behavior.
- The disclosure timeline reports vendor validation and a fixed release, but supplies no repair implementation, shipped-artifact comparison or regression coverage. Current-version applicability is unverified.

**Operational owners:** [source-code-auditing](../../skills/source-code-auditing/SKILL.md)

## O033

**Article:** [How I Hacked Facebook, and Found Someone's Backdoor Script](https://blog.orange.tw/posts/2016-04-bug-bounty-how-i-hacked-facebook-and-found-someones-backdoor-script/)
**Worker:** `worker-o033v001`; [packet](extractions/O033.json).
**Orchestrator decision:** Retain provisional owner reporting of unexpected artifacts with minimized redacted provenance and explicit attribution/access unknowns.
**Quotation origin:** [directly linked full publication](https://devco.re/blog/2016/04/21/how-I-hacked-facebook-and-found-someones-backdoor-script-eng-ver/); the Orange article is its archive wrapper, not the quoted body.
**Editorial qualifications:** Evidence is from the directly linked DEVCORE English publication, not the small Orange wrapper. The adopted route is dynamic observation to provisional owner/remediation review, not the worker's impact-complete route or a compromise sequence.

**Method evidence (short source quotations):**
- **E1** — Directly linked English article, Foreword: paragraph beginning 'Of course, Bug Bounty is nothing about firing random attacks without restrictions.': “By comparing your findings with the permitted actions set forth by Bug Bounty, the overlapping part will be the part worth trying.”
- **E2** — Directly linked English article, Vulnerability Discovery: paragraph beginning 'Actually, from black-box testing'.: “Actually, from black-box testing, I didn’t find any possible vulnerabilities, and I had to try white-box testing.”
- **E3** — Directly linked English article, Was There Something Strange?: paragraph beginning 'I followed the PHP paths in error messages'.: “I followed the PHP paths in error messages and ended up with discovering suspicious WEBSHELL files left by previous “visitors”.”
- **E4** — Directly linked English article, Epilogue: paragraph beginning 'After adequate proofs had been collected'.: “Other than vulnerability details accompanying logs, screenshots and timelines were also submitted xD”
- **E5** — Directly linked English article, Epilogue: paragraph contrasting the earlier and later periods of suspicious activity, sentence beginning 'As for the identities'.: “As for the identities of these two hackers, were they the same person? Your guess is as good as mine. :P”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `remediation` / handoff: Unexpected incident indicators warrant provisional authorized owner/responder review: stop expanding access, preserve only permitted minimized redacted observations with collection time and integrity provenance, and keep attribution, initial access and wider-access hypotheses unresolved. Containment is not root-cause repair closure. (evidence E3, E4, E5).

**Proposed handoffs (derived, not author-agent claims):**
- `attack-surface-mapping` → `source-code-auditing` when Permitted external observations are inconclusive and a lawfully available artifact offers a different evidence source.. Packet: Authorization, permitted interfaces, actor, configuration and intended boundary, Reachability and gate observations, including negative or inconclusive outcomes and their coverage limits, Source provenance, revision and known correspondence or mismatch with the deployed artifact, One unresolved question, proposed invariant and contrasting observations, Bounded review plan, validation limits and stop condition. Gate: The interface is within scope and evidenced or explicitly marked inferred; artifact provenance and deployment uncertainty are disclosed. The question is falsifiable, and an unmatched historical source finding is not promoted to a deployed vulnerability.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `exploitability-assessment` → `remediation` when Evidence collection reveals unexpected artifacts suggesting a pre-existing incident that requires authorized owner review.. Packet: Authorization, artifact scope, environment modifications and intended reporting recipient, Minimal diagnostic-to-artifact evidence with collection method, timestamps and source-report classification, Redacted logs, screenshots and timeline separating observed events from attribution hypotheses, Narrow impact statement, uncertain access implications and untested scope, Preservation and escalation requirements, bounded next question and stop condition. Gate: The packet separates artifact observations from identity and wider-access hypotheses, excludes secrets, and names an authorized responder. It does not require credential use, persistence or expanded target access to substantiate the report.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical 2016 author report about a particular appliance deployment, not independently reproduced or current-release vulnerability evidence.
- The author obtained earlier source versions from several resources and describes repairing recovered code. Exact provenance, recovery-tool identity and equivalence to the deployed artifact are not established in the article.
- The unsuccessful black-box pass has no reproducibility denominator or exhaustive coverage account; it does not show that external testing cannot reveal defects.
- Suspicious files and activity are reported from logs and application artifacts. The author leaves actor identity and the initial access mechanism unresolved; inferred usefulness of exposed credentials on other services is not demonstrated access.
- Vendor patching and completion of an owner forensics investigation are reported, but shipped fix artifacts, invariant-level regression results and independent forensic verification are not supplied.
- Method evidence comes from the archive's directly linked English article on DEVCORE. The translation, external advisory, image contents and exploit attachments were not independently inspected.

**Operational owners:** [remediation](../../skills/remediation/SKILL.md)

## O034

**Article:** [Uber 遠端代碼執行- Uber.com Remote Code Execution via Flask Jinja2 Template Injection](https://blog.orange.tw/posts/2016-04-bug-bounty-uber-ubercom-remote-code_7/)
**Worker:** `worker-o034v001`; [packet](extractions/O034.json).
**Orchestrator decision:** Retain raw-versus-displayed artifact comparison and preserve producer/delivery/viewer alternatives when output appears empty.
**Editorial qualifications:** Backward tracing and deferred consumption support baseline flow only. The source explicitly guesses its storage/queue/worker architecture; those edges are not adopted as observed facts.

**Method evidence (short source quotations):**
- **E1** — Unsectioned article body: article.post.h-entry descendant paragraph 7 (1-based), beginning '往前追查原因才發現進入點', following the account-change notification discussion and before the first code example.: “往前追查原因才發現進入點”
- **E2** — Unsectioned article body: article.post.h-entry descendant paragraph 20 (1-based), explaining apparently empty displayed output and inspection of the original message.: “會顯示是空的是因為被 HTML < > 包起來了，檢視原始信件就可以看到了XD”
- **E3** — Unsectioned article body: article.post.h-entry descendant paragraph 21 (1-based), beginning '額外一提的是在引用模組中', introducing the proposed architecture after a dependency observation.: “因此可以猜測網站大致架構應該是：”
- **E4** — Unsectioned article body: article.post.h-entry descendant paragraph 23 (1-based), the proposed asynchronous-work explanation between the storage and later-consumer paragraphs.: “不過為了寄送簡訊以及信件等耗時的工作，使用 Asynchronous Task 機制交給後方的 Worker”
- **E5** — Unsectioned article body: article.post.h-entry descendant paragraph 24 (1-based), beginning '而當 Worker 再從', describing the hypothesized later read and template construction before the closing personal reflection.: “而當 Worker 再從資料庫抓出姓名產生模板時使用串接的方式直接將模板產生”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `dynamic-analysis` / failure: An apparently empty rendered artifact may conceal content at the display layer. Compare preserved raw and displayed representations before concluding that the producer returned nothing, and record the viewer's suppression separately from the producer's behavior. (evidence E2).

**Proposed handoffs (derived, not author-agent claims):**
- `data-flow-analysis` → `dynamic-analysis` when Backward tracing suggests a stored value is consumed later, but storage, queue and data-to-interpreter edges remain inferred.. Packet: Scope, artifact/runtime identity and source-author-report versus local-observation classification, One falsifiable missing-edge question with contrasting predicted observations, Actor-controlled field, earlier writer and proposed storage/job/consumer chain, Observed versus inferred edges and unknown transformations or construction semantics, Raw and displayed artifact provenance, collection timing and viewer effects, Permitted minimal observation, known-good control and stop conditions, Failed assumptions, untested configurations and remaining restrictions. Gate: Require explicit provenance and uncertainty for every edge, distinct outcomes for the unresolved question, and a feasible benign observation in an authorized environment. A dependency name or newly visible raw output cannot alone establish process ownership, a complete consumer path or confinement escape. Source-only packets remain hypotheses, not reproduced findings.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- The author explicitly guesses the storage/task/worker architecture from a dependency observation. No consumer source, storage trace or worker trace was independently obtained; those edges remain inferred.
- This is a historical 2016 report. Limited template evaluation and broader remote execution remain author reports; the actual sandbox implementation/configuration, process privileges, denied capabilities and present-day affected scope were not established.
- Exact DOM matches verify the article's wording, not its technical claims. Embedded screenshots were not independently analyzed as execution traces, and no target interaction or reproduction was performed.
- The post does not document a shipped fix, rollout verification or regression/control matrix. BurpSuite is mentioned only through a linked paper's author affiliation; Celery and Jinja2 are application components, not evidence of author-used research tools with stated purposes.

**Operational owners:** [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md)

## O035

**Article:** [HITCON CTF 2015 Quals & Final 心得備份](https://blog.orange.tw/posts/2016-01-hitcon-ctf-2015-quals-final/)
**Worker:** `worker-o035v001`; [packet](extractions/O035.json).
**Orchestrator decision:** Retain state-owner, worker-selection and prior-history prerequisites of fresh-instance models and repeated observations.
**Editorial qualifications:** Dependency representation review and upstream acceptance merge into baseline contracts. Connection identity is not state identity; no prediction or recovery procedure is adopted.

**Method evidence (short source quotations):**
- **E1** — 3. 300 Giraffe’s Coffee (16 隊解) — paragraph beginning 有些人會使用現成的工具來解; article paragraph 25: “有些人會使用現成的工具來解，但會發現失敗，無法準確的預測 PRNG 是因為當 PHP 在 Apache 下時是使用 prefork 的方式去執行”
- **E2** — 3. 300 Giraffe’s Coffee (16 隊解) — same tool-failure paragraph, explanation of state history and worker selection; article paragraph 25: “因此無法確定當前的 process PRNG 中 STATE 的狀態是否為第一次，以及每次連線上的 process 也不一定相同所以 STATE 狀態更無法預測 (現成工具只會算 seed 後的第一次來比對)”
- **E3** — 4. 400 lalala (2 隊解) — paragraph beginning 然後本題使用, final source-inspection clause; article paragraph 35: “後來去研究了一下 libcurl 的原始碼，發現是因為寫得有點問題才不能使用 NULL Byte”
- **E4** — 4. 400 lalala (2 隊解) — standalone paragraph reporting upstream acceptance, before the commit link; article paragraph 36: “所以送了一個 commit 過去還被接受了…XD”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `dynamic-analysis` / failure: Before trusting a state-dependent tool, check whether its fresh-instance assumption matches worker reuse, worker selection and prior operation history. Record state initialization and progression separately from request or connection identity. (evidence E1, E2).

**Proposed handoffs (derived, not author-agent claims):**
- `state-and-lifetime-auditing` → `dynamic-analysis` when A state model assumes fresh initialization while the serving architecture may reuse or select different stateful workers.. Packet: Artifact, runtime and serving configuration, State owner and worker-selection evidence, Initialization, reset and advancement assumptions, Known and unknown prior operation history, Contrasting fresh-state and reused-state predictions, Benign observation points, controls and stopping condition. Gate: The observation must distinguish worker selection from state progression. Unknown worker/history identity remains explicit; transport continuity alone is not accepted as independent proof of state identity.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `source-code-auditing` → `remediation` when Source review attributes a representation limitation to a dependency implementation and an upstream change is reported accepted.. Packet: Dependency revision and focused implementation slice, Consumer-required representation and intermediary constraint, Proposed preservation invariant, Author-reported diagnosis and upstream acceptance, Missing release/build identity and benign regression evidence. Gate: Preserve diagnosis and acceptance as source-author reports until corroborated. Repair closure requires the actual shipped artifact and controls demonstrating representation preservation, not source acceptance alone.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical competition designer's account, not an independently reproduced vulnerability investigation; all results remain author reports.
- The proposed state-handling adjustment is not accompanied by worker/state traces, repetition counts or model-validation data. Connection-to-worker association is configuration-specific, not a universal guarantee.
- The dependency diagnosis lacks an implementation slice and benign compatibility controls in the article. Its linked commit was not retrieved or independently reviewed.
- Upstream acceptance is reported, while the later claim about newer-library behavior is tentative. No exact shipped artifact, deployment identity or current-release verification is supplied.

**Operational owners:** [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md)

## O037

**Article:** [AIS3 Final CTF Web Writeup (Race Condition & one-byte off SQL Injection)](https://blog.orange.tw/posts/2015-09-ais3-final-ctf-web-writeup-race/)
**Worker:** `worker-o037v001`; [packet](extractions/O037.json).
**Orchestrator decision:** Retain coherent publication of object and companion policy state as a transition/policy question before assigning race classification.
**Editorial qualifications:** Post-encoding formatting/truncation reinforces the owned semantic ledger without another solution-derived procedure. No schedule, timing result or backend policy was independently reproduced.

**Method evidence (short source quotations):**
- **E1** — 漏洞一 Race Condition — second paragraph, opening clause about incomplete registration state: “但是只要在註冊中，帳號尚未被新增進 locks 表時”
- **E2** — 漏洞一 Race Condition — concluding paragraph describing the guard outcome: “登入檢查是否被鎖住的限制就可以繞過了！”
- **E3** — 漏洞二 one-byte off SQL Injection — paragraph beginning 漏洞發生在, clause explaining display-purpose truncation: “當 note 的標題太長為了畫面美觀會進行截斷的動作”
- **E4** — 漏洞二 one-byte off SQL Injection — following paragraph, opening clause explaining the escaping defense: “這時候因為對 SQL Injection 防護是使用 escape 的方式防護”
- **E5** — 漏洞二 one-byte off SQL Injection — paragraph beginning 導致原本的防護被繞過, after the transformed-value examples: “導致原本的防護被繞過，使得原本被括起來後面的單引號被 escape 原本的 SQL 語句就變成字串了”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `state-and-lifetime-auditing` / heuristic: Model object publication together with companion state needed for policy decisions. Record visibility, validity, missing-state behavior and transaction/synchronization boundaries; incomplete publication first raises a transition/policy question, while race classification additionally requires feasible ordering and state evidence. (evidence E1, E2).

**Proposed handoffs (derived, not author-agent claims):**
- `source-code-auditing` → `race-condition-auditing` when A creation path publishes an object separately from the policy state required by another reader, leaving the intermediate-state semantics unresolved.. Packet: Authorized artifact, revision, runtime/configuration and actor scope, One publication/initialization invariant and contrasting predictions, Minimal creation and policy-reader slice with source references, Missing companion-state behavior and relevant gates, Visibility, transaction and synchronization boundaries, with unknowns marked, Evidence provenance separating source-author reports, static inference and observations, Normal controls, failed assumptions, untested scope and bounded next observation with stop condition. Gate: Require identified writers/readers and a specific intermediate-state invariant. A static schedule may be accepted as a hypothesis, but the reported guard failure cannot become independently verified race evidence without feasible ordering and observed state transitions; return missing visibility or default-policy semantics.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `data-flow-analysis` → `parser-differential-auditing` when A value is changed after context-specific encoding, and the final parser may consume a representation whose original guarantee no longer holds.. Packet: Authorized artifact, revision, runtime/configuration and controllable subset, One guarantee-preservation question and contrasting consumer interpretations, Source-to-consumer slice, prerequisites and unresolved edges, Ordered transformations with their purposes and representation changes, Encoding guarantees, length units and later mutation boundaries, Final consumer context and ordinary accepted controls, Observed versus inferred values, source-report classification, limits and bounded next review with stop condition. Gate: Require a specific guarantee that later mutation may invalidate and an identified final consumer. Return a packet missing transformation order, consumer context or feasible gates; historical author reports alone do not establish current parser behavior.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is an educational CTF writeup from 2015, not evidence of a current production vulnerability or a general runtime default.
- The guard failure, changed parsing and challenge outcomes are author reports. No source execution, target interaction or independent reproduction was performed.
- The race discussion does not provide state traces, attempt counts, measured timing or a transaction/isolation analysis; publication visibility and practical scheduling remain unresolved.
- The prose illustrates the transformation order but does not establish a complete parser/configuration matrix, paired benign controls or a repaired implementation. No remediation result is claimed.
- An additional file-inclusion section appears beyond the two mechanisms named in the title. Its target-specific restrictions and exploit composition are omitted rather than promoted to a separate operational method.
- The retained lessons overlap existing publication and transformation-order guidance. Candidate additions are narrow review prompts, not claims of novelty or final library acceptance.

**Operational owners:** [state-and-lifetime-auditing](../../skills/state-and-lifetime-auditing/SKILL.md)

## O048

**Article:** [Pw3ed CTF LeaderBoard - Git Misconfiguration & SQL Injection](https://blog.orange.tw/posts/2014-03-pwned-ctf-leaderboard-git/)
**Worker:** `worker-o048v001`; [packet](extractions/O048.json).
**Orchestrator decision:** Retain authorized deployment-metadata and auxiliary-entry inventory with completeness/provenance and actual consumer-gate limits.
**Editorial qualifications:** Printable names are not complete source or deployed handlers; private-versus-removed origin is speculative. Tool names are in E4's containing paragraph. No metadata-to-injection sequence is retained.

**Method evidence (short source quotations):**
- **E1** — Unheaded article body, paragraph 8, beginning with the assessment of exposed development error logs.: “看到這樣子的內容暴露在網路上，可以想像整個網站的防護應該不是很完整的，因此我們繼續來深入看看”
- **E2** — Unheaded article body, paragraph 15, explaining deployment of version-control working copies and metadata exposure.: “許多開發者會將 Git, SVN 或者 CVS clone(checkout) 到正式上線的網站上，這時如果未將權限設置好，攻擊者可以透過這些版本控管軟體所留下的資訊，取得敏感資訊。”
- **E3** — Unheaded article body, paragraph 19, beginning '從 config 可以看到'; the author qualifies why the upstream repository could not be accessed.: “似乎那個 repo 是 private 的或者已經移除”
- **E4** — Unheaded article body, paragraph 20, beginning '從 index 可以取得網站目錄結構'; curl and strings are named later in this same paragraph.: “從 index 可以取得網站目錄結構”
- **E5** — Unheaded article body, paragraph 22, beginning '從目錄結構已經可以發現些有趣的東西了'; retained clause concerns a development test page.: “接著再依照剛剛的目錄結構對現有檔案做一次觀察，發現了開發者留下的測試頁面”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `attack-surface-mapping` / workflow: Include development and deployment artifacts in the interface inventory, not only ordinary navigation. Metadata-derived auxiliary entries remain candidates until their actor, handler, and gates are established. (evidence E2, E4, E5).

**Tool attribution:**
- curl → The author names it for obtaining repository metadata used in the directory inventory; the request and command are not retained. → Only when artifact acquisition is explicitly authorized and within the agreed scope; this extraction performed no target acquisition.; **explicit** attribution.
- strings → Extract printable filename clues from repository metadata as an initial directory-inventory aid. → When examining an authorized metadata artifact; completeness and correspondence with deployed files remain separate questions.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `attack-surface-mapping` → `source-code-auditing` when A metadata-derived auxiliary-entry candidate is prioritized and authorized matching source becomes available.. Packet: authorization scope and artifact identity, actor, configuration, and intended boundary, metadata provenance and inventory extraction method, upstream-source availability and unresolved cause, candidate entry with confirmed versus inferred status, handler and access-gate evidence or explicit unknowns, source-to-deployment revision correspondence, one unresolved question and contrasting expectations, limitations, bounded next review, and stop condition. Gate: Require authorized source correspondence and either entry/gate evidence or an explicitly inferred candidate with a bounded validation question. Return missing provenance or handler questions; directory names and an inaccessible upstream repository do not constitute source recovery or reachability proof.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical CTF leaderboard incident. All vulnerability, access, and disclosure outcomes remain author reports; only article text and quotation identity were checked here.
- The upstream repository was unavailable to the author. Private versus removed is explicitly speculative, not a verified explanation.
- The printable-text inventory method establishes neither completeness nor deployed revision correspondence. The article does not supply a systematic handler/gate inventory or source-audit record.
- The initial inference from diagnostic exposure to weak overall protection is a prioritization heuristic, not a whole-site security finding or a controlled comparison.
- The article states that the vulnerabilities were fixed but supplies no assessed patch, deployment receipt, or regression coverage. Remediation is therefore unverified by this extraction.

**Operational owners:** [attack-surface-mapping](../../skills/attack-surface-mapping/SKILL.md)

## O049

**Article:** [Volga CTF 2014 Web 400 write up](https://blog.orange.tw/posts/2014-03-volgactf-2014-web-400-write-up/)
**Worker:** `worker-o049v001`; [packet](extractions/O049.json).
**Orchestrator decision:** Retain persistent failure side effects and explicitly permitted recovery/reset equivalence before comparing later observations.
**Editorial qualifications:** Other proposals reinforce baseline flow/impact/dispatch. No account/cookie recovery steps are imported. Reflection appears in a workaround; neutral inert metadata inspection is derived, not author-validated safe usage.

**Method evidence (short source quotations):**
- **E1** — Article body, p element 8: request-interception paragraph before the captured-request image; no body subheadings.: “使用 Tamper Data 對我們送出的資訊進行截取:”
- **E2** — Article body, p element 15: recovery paragraph immediately after the reported loss of functionality.: “任何功能都無法操作，只能把 Cookie 清空再註冊一個帳號嘗試，之後的步驟都是這樣，只要一個地方出錯就要重新註冊一個帳號重來一次XD”
- **E3** — Article body, p element 17: parenthetical format limitation in the error-information discussion.: “（但是只限定於 html, xml 格式，不然再處理時會出錯一樣無法看到檔案內容）”
- **E4** — Article body, p element 28: environment-mismatch clause following the linked paper's approach.: “但是伺服器上的環境似乎跟 Paper 不太相同，所以不能直接使用上面的攻擊代碼，必須小改一下!”
- **E5** — Article body, p element 29: method fragment about inspecting other known global variables after an assumed context was unavailable.: “對其他已知的全域變數用 Relfection API 想辦法”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `dynamic-analysis` / failure: Record persistent failure side effects and required reset state; restore a known-good baseline before comparing later observations. (evidence E2).

**Tool attribution:**
- Tamper Data → Intercept outgoing client information to inspect the submitted representation. → When interface behavior alone does not reveal what the client sends.; **explicit** attribution.
- Java Reflection API → Inspect known ambient runtime objects while investigating a missing context assumed by a reference. → When the observed runtime's available objects differ from the reference environment.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `data-flow-analysis` → `dynamic-analysis` when The submitted representation is observed, but downstream format requirements or failure-state persistence remain unresolved.. Packet: authorized scope and artifact/runtime identity, single unresolved consumer question, actor-controlled field and submitted representation, known and inferred consumer edges, candidate format requirements and contrasting predictions, observed failure side effects and recovery requirements, known-good baseline and isolation/stop conditions, evidence provenance, classification and remaining limits. Gate: Require a recoverable benign baseline and an observation that distinguishes the stated hypotheses. Source-author reports may seed the question but cannot substitute for current consumer observations.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `dynamic-analysis` → `exploitability-assessment` when An observed consumer restriction or missing runtime prerequisite changes the scope of a proposed capability.. Packet: scope, actor and original/modified environment identity, narrow observed capability and evidence classification, accepted/rejected format evidence, runtime prerequisites and differences from reference assumptions, collateral state effects and recovery constraints, negative evidence, missing capabilities and next bounded question. Gate: Keep resource reachability, successful content consumption and stronger impact separate. Each claimed capability needs evidence and stated prerequisites; an error or historical reference alone does not demonstrate unrestricted impact.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a 2014 CTF account. Runtime details, behavior and results are author reports, not independently reproduced findings or evidence about current deployments.
- The stated HTML/XML restriction was inferred from processing behavior; the article does not establish a comprehensive accepted-format grammar or complete consumer-policy analysis.
- The author reports unusable functionality followed by cookie/account recovery. The exact persistence mechanism and account-versus-service-wide failure scope are not established.
- The reference-context mismatch is described tentatively, without a complete runtime/configuration inventory or controlled comparison. Its eventual challenge-specific workaround is not retained.
- Tamper Data and Java Reflection API are explicitly named historical tools, not required installations or claims of present-day compatibility. E5 preserves the source's spelling 'Relfection'.
- The article supplies no remediation or deployed-fix validation. Derived baseline and handoff gates are library synthesis, not author-reported experimental controls.

**Operational owners:** [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md)

## O051

**Article:** [Olympic CTF 2014 CURLing 400 write up](https://blog.orange.tw/posts/2014-02-olympic-ctf-2014-curling-400-write-up/)
**Worker:** `worker-o051v001`; [packet](extractions/O051.json).
**Orchestrator decision:** Retain provisional diagnostic-stage models and latency/removal ambiguity of absent transient results.
**Editorial qualifications:** Cleanup is tentative, not a verified mechanism or race. Receiver conventions support hypotheses only. No selector enumeration, hidden-data oracle or access optimization to outrun cleanup is adopted.

**Method evidence (short source quotations):**
- **E1** — Article body, paragraph beginning '哦，會發現錯誤訊息變了' (documentation search); observed DOM paragraph 8.: “Google 搜尋一下 JSON RPC 的標準”
- **E2** — Article body, paragraph beginning '會發現錯誤訊息又變了。' (bounded versus blind guessing); observed DOM paragraph 11.: “有範圍的猜測會比盲目的亂猜好太多”
- **E3** — Article body, paragraph beginning '錯誤訊息又變了！' (information inferred from a diagnostic); observed DOM paragraph 15.: “不過從這次的錯誤訊息中可以得到資訊”
- **E4** — Article body, paragraph beginning '不過因為 server 的設定' (tentative periodic-cleanup explanation); observed DOM paragraph 29.: “所以如果手速不夠快會一直以為自己沒有寫成功”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `dynamic-analysis` / heuristic: Treat successive diagnostics as a provisional input-contract model. Compare them with relevant standards, record the inferred validation or binding stage, and retain the next unresolved question instead of equating a changed error with successful execution. (evidence E1, E3).
- `dynamic-analysis` / validation: Before interpreting an absent transient result as operation failure, account for observation latency and possible cleanup. Preserve evidence of creation, removal, and observation ordering where available; otherwise classify the late negative result as inconclusive rather than disproving the operation. (evidence E4).

**Tool attribution:**
- Google → Locate the stated request-format standard instead of continuing to guess the format. → A changed diagnostic suggests a recognizable documented request protocol.; **explicit** attribution.

**Proposed handoffs (derived, not author-agent claims):**
- `dynamic-analysis` → `deserialization-and-dispatch-auditing` when Diagnostics suggest input-selected behavior, but the receiving object, argument contract, and intended selectable set remain unresolved.. Packet: authorized artifact/runtime/configuration and actor scope, one unresolved dispatch-contract question and contrasting predictions, diagnostic observations with provenance and author-report versus independently observed classification, candidate-selection rationale and supporting runtime or protocol documentation, receiving-object and argument-binding model with inferred edges marked, known permitted-operation control, unknown gates, and a bounded benign validation proposal. Gate: The consumer can separate documented conventions and diagnostic inferences from confirmed dispatch. Missing receiver, actor, or binding evidence remains an explicit question; a changed error is not accepted as proof of unintended execution.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical, challenge-specific configuration, not evidence of current software behavior. All target behavior and outcomes remain source-author reports; no target requests or local reproduction were performed.
- Several diagnostics and outcomes appear in screenshots. Extraction used the surrounding prose; screenshot contents and detailed error contracts were not independently decoded or verified.
- The author presents periodic cleanup as a tentative configuration explanation. Its mechanism and timing were not independently measured, so the retained lesson concerns observation ambiguity rather than an established lifecycle defect or race.
- Runtime conventions provide candidate hypotheses, not proof of callable reachability, authorization, or impact. The article does not supply systematic negative controls or comprehensive interface coverage.
- No remediation or shipped-fix evidence is provided. Proposed validation and handoff gates are library synthesis, not claims that the author followed those contracts.

**Operational owners:** [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md)

## O055

**Article:** [Yahoo Bug Bounty Part 1 - 台灣 Yahoo Blog 任意檔案下載漏洞](https://blog.orange.tw/posts/2013-11-yahoo-bug-bounty-part-1-yahoo-blog/)
**Worker:** `worker-o055v001`; [packet](extractions/O055.json).
**Orchestrator decision:** Retain metadata-versus-delivered-body evidence and competing error/delivery explanations under the shared observation-stage contract.
**Editorial qualifications:** Source reconciliation and confinement uncertainty support baseline methods. Output appearance alone does not establish full stage order or a specific active restriction.

**Method evidence (short source quotations):**
- **E1** — 正文開始 — paragraph beginning 不過實際下載後 (DOM paragraph 31): “不過實際下載後，內容是空的，大致可以先猜想一下程式邏輯檔名部分先取得，最後再組裝路徑去讀取（或者發生某些錯誤）”
- **E2** — 正文開始 — paragraph containing 配合前面幾個測試 (DOM paragraph 34): “配合前面幾個測試，大致可以猜想程式的邏輯”
- **E3** — 正文開始 — source-inspection introduction beginning 最後就是讀 PHP 的 Source Code (DOM paragraph 45): “最後就是讀 PHP 的 Source Code，來看一下程式邏輯到底是怎麼寫的？”
- **E4** — 正文開始 — restriction hypothesis paragraph beginning 大致先猜想有 (DOM paragraph 27): “大致先猜想有 open_basedir 之類的限制”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `dynamic-analysis` / heuristic: Record response metadata and delivered content as separate observations. A discrepancy can suggest stage ordering, but preserve an error-path explanation until an independent observation distinguishes it. (evidence E1, E2).

**Proposed handoffs (derived, not author-agent claims):**
- `dynamic-analysis` → `data-flow-analysis` when Response metadata and content suggest different processing stages, but the value reaching the consumer is unresolved.. Packet: authorization, actor and artifact/configuration identity, one falsifiable processing-stage question, baseline and contrasting metadata/content observations, proposed transformations with observed versus inferred edges, alternative error explanation and failed assumptions, available authorized source references and collection provenance, bounded next review question and stop condition. Gate: The observations must distinguish at least two explanations, preserve a normal comparison, and identify the missing consumer edge. Metadata alone is not accepted as proof of successful content access.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.
- `data-flow-analysis` → `exploitability-assessment` when A consumption model is supported, but the scope imposed by runtime or storage boundaries is still uncertain.. Packet: authorization, actor and original artifact identity, minimal annotated input-to-consumer slice and invariant, observed capability separated from source-author reports, successful, failed and ambiguous outcome classes, confirmed restrictions separated from configuration hypotheses, missing capabilities and untested scope, next harmless observation, redaction needs and stop condition. Gate: Require evidence of the consumer and its reachable input, or explicitly accept a static-only hypothesis. Do not upgrade a limited observation or conjectured restriction to unrestricted access or a verified containment boundary.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This is a historical November 2013 account of the retiring Yahoo Blog backup service; it establishes no present-day product or configuration behavior.
- The open_basedir explanation begins as a guess from differing outcomes; the article does not provide independently verified effective configuration or a complete accessible-resource inventory.
- The metadata/body discrepancy also admits an error explanation. The displayed observations alone do not prove the complete processing order or successful content retrieval.
- Source inspection, cross-account consequences and completed repair remain author reports. No target requests, exploit reproduction, attachments, or shipped-fix verification were performed for this extraction.

**Operational owners:** [dynamic-analysis](../../skills/dynamic-analysis/SKILL.md)

## O078

**Article:** [Download_Exec shellcode fix & for Windows 7](https://blog.orange.tw/posts/2011-04-downloadexec-shellcode-fix-for-windows/)
**Worker:** `worker-o078v001`; [packet](extractions/O078.json).
**Orchestrator decision:** Retain component identity versus dependency-enumeration position as a generic reconstruction uncertainty check.
**Editorial qualifications:** Size/field-range observations reinforce existing representation rules. No shellcode, loader walk, compatibility repair or production vulnerability claim is imported; tracing tool is unnamed.

**Method evidence (short source quotations):**
- **E1** — Unheaded article prose, paragraph 5: length-dependent failure investigation, beginning '首先是發現當網址長度'. Paragraph counts use article .content p outside highlighted code.: “實際去追蹤後發現出錯點位於decode shellcode中發生問題”
- **E2** — Unheaded article prose, paragraph 7: explanation of the dynamically patched offset field, beginning 'cl放的是要被解碼shellcode的offset偏移量'.: “cl放的是要被解碼shellcode的offset偏移量，會被程式動態patch”
- **E3** — Unheaded article prose, paragraph 16: dependency-load-order explanation, immediately after the cross-runtime success/failure comparison and before the reference links.: “前先載入kernelbase.dll，所以造成ImageBase取錯”

**Adopted or merged generic refinements (paraphrased, not necessarily novel):**
- `binary-auditing` / failure: A stable enumeration position is not proof of component identity. Record dependency-order assumptions separately from address-selection evidence and carry environment-specific uncertainty forward. (evidence E3).

**Proposed handoffs (derived, not author-agent claims):**
- `source-code-auditing` → `dynamic-analysis` when A size-sensitive failure suggests that a dynamically written length or offset may exceed its representation, but the consumed value is not independently observed.. Packet: authorized scope, artifact revision, runtime and isolation constraints, one falsifiable representation-width question, minimal writer-to-consumer slice with logical range and storage width, source-report evidence and separately labeled static inferences, contrasting predictions and a precise observation point, benign known-good control, permitted observer changes and stop condition, failed assumptions, untested ranges and remaining questions. Gate: Require a benign representation-only experiment proposal that distinguishes the width hypothesis from an unrelated failure, preserves a known-good control and discloses observer changes. Reject any proposal dependent on executing the published download/execute program. This packet is a derived library contract, not an experiment performed by the author or this worker.. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.

**Limits:**
- This historical compatibility note does not establish a product vulnerability, actor-controlled security boundary or present-day exploitability.
- The tracing and dependency-order diagnoses remain author reports. No named tracing tool, trace artifact, reproduction count or complete architecture/configuration matrix accompanies the prose.
- The reported Windows-version differences were not independently verified and do not establish behavior of current loaders or other runtimes.
- No independent benign regression matrix or original-versus-modified artifact validation was performed here. The source listing was not executed, and linked articles, forums and exploit attachments were not opened or downloaded.

**Operational owners:** [binary-auditing](../../skills/binary-auditing/SKILL.md)
