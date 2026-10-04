# Source Evidence Ledger

**All observations below paraphrase what the source reports.** They are not independent exploit replications or current-vulnerability claims.
Exact section links locate method evidence. Defensive synthesis is explicitly inferred; limitations accompany every retained source. No original payloads, scripts, attachments, or paragraphs are copied.

65 retained sources support 17 merged skills. Source IDs resolve through [catalog.md](catalog.md) and [corpus.json](corpus.json).

## B001

**Source:** [Dirty Cert: Cisco Smart Software Manager's Silently Patched RCE](https://starlabs.sg/blog/2026/09-dirty-cert-cisco-smart-software-managers-silently-patched-rce/)
**Research type:** Cross-service source audit and silent-patch comparison
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [The Sink that Never Should’ve Been](https://starlabs.sg/blog/2026/09-dirty-cert-cisco-smart-software-managers-silently-patched-rce/#the-sink-that-never-shouldve-been); [Uneven Processing](https://starlabs.sg/blog/2026/09-dirty-cert-cisco-smart-software-managers-silently-patched-rce/#uneven-processing); [Silent Patches](https://starlabs.sg/blog/2026/09-dirty-cert-cisco-smart-software-managers-silently-patched-rce/#silent-patches)

**Method observations (source-reported):**
- The researcher worked backward from shell-based certificate validation through upstream validators and service boundaries.
- Different branches preserved original text or reserialized parsed content; successful certificate parsing did not establish safety for a later shell consumer.
- A later release replaced the shell sink with library parsing and the previous test no longer produced the reported effect.

**Limits / failed assumptions:** One inaccessible candidate was not validated; a search of the tested files and one failed reproduction do not establish comprehensive variant coverage.
**Defensive synthesis (inferred):** Remove unnecessary shell interpretation, consume canonical parsed values, and test every equivalent validation branch.
**Technique owners:** [data-flow-analysis](../skills/data-flow-analysis/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [remediation](../skills/remediation/SKILL.md), [source-code-auditing](../skills/source-code-auditing/SKILL.md)

## B002

**Source:** [How I Found a $113,337 AF_ALG Linux Local Privilege Escalation Before Copy Fail](https://starlabs.sg/blog/2026/09-how-i-found-a-113337-af_alg-linux-local-privilege-escalation-before-copy-fail/)
**Research type:** Unprivileged Linux interface and shared-state race audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Linux Kernel Attack Surface](https://starlabs.sg/blog/2026/09-how-i-found-a-113337-af_alg-linux-local-privilege-escalation-before-copy-fail/#linux-kernel-attack-surface); [When Two Threads Call sendmsg() Concurrently](https://starlabs.sg/blog/2026/09-how-i-found-a-113337-af_alg-linux-local-privilege-escalation-before-copy-fail/#when-two-threads-call-sendmsg-concurrently); [How the Bug Was Fixed](https://starlabs.sg/blog/2026/09-how-i-found-a-113337-af_alg-linux-local-privilege-escalation-before-copy-fail/#how-the-bug-was-fixed)

**Method observations (source-reported):**
- Unprivileged socket reachability motivated subsystem selection before auditing internals.
- A wait helper released and reacquired the socket lock; serialized writers could therefore resume under changed coupled state.
- Concurrent progress plus an error path invalidated the relationship between an append-state flag and the tail's valid-entry count; KASAN exposed the resulting invalid access.

**Limits / failed assumptions:** The article's subsequent memory layout and impact depend on its kernel and configuration; a sanitizer crash alone is not privilege escalation.
**Defensive synthesis (inferred):** Revalidate after waits and preserve coupled state on every partial-progress and failure path.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [race-condition-auditing](../skills/race-condition-auditing/SKILL.md)

## B003

**Source:** [When AI Makes 0-Days Feel Like N-Days](https://starlabs.sg/blog/2026/07-when-ai-makes-0-days-feel-like-n-days/)
**Research type:** AI-assisted Linux lifetime research with manual validation
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [AI usage](https://starlabs.sg/blog/2026/07-when-ai-makes-0-days-feel-like-n-days/#ai-usage); [The bug](https://starlabs.sg/blog/2026/07-when-ai-makes-0-days-feel-like-n-days/#the-bug); [Extra requirements](https://starlabs.sg/blog/2026/07-when-ai-makes-0-days-feel-like-n-days/#extra-requirements); [Other bugs found](https://starlabs.sg/blog/2026/07-when-ai-makes-0-days-feel-like-n-days/#other-bugs-found)

**Method observations (source-reported):**
- AI accelerated candidate and test development, while manual reasoning checked ownership and actual reachability.
- The audit compared RCU-protected access with immediate freeing and final-reference ownership.
- Namespace, configuration, locking, hardware, and policy constraints changed applicability; secondary faults appeared after the intended effect.

**Limits / failed assumptions:** The reported repeated successes concern a particular machine; thermal explanations and suggested alternative optimizations were speculative. The competition machine was not demonstrated.
**Defensive synthesis (inferred):** Treat AI output as hypotheses, verify reader/reclaimer compatibility, and assess stability after the first observed effect.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [race-condition-auditing](../skills/race-condition-auditing/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B004

**Source:** [Old Bug, Harder Rules : Exploiting CVE-2023-36802 Without the Usual Shortcuts](https://starlabs.sg/blog/2026/06-old-bug-harder-rules-exploiting-cve-2023-36802-without-the-usual-shortcuts/)
**Research type:** Constrained Windows primitive reassessment
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Patch Diff](https://starlabs.sg/blog/2026/06-old-bug-harder-rules-exploiting-cve-2023-36802-without-the-usual-shortcuts/#patch-diff); [Bug Analysis](https://starlabs.sg/blog/2026/06-old-bug-harder-rules-exploiting-cve-2023-36802-without-the-usual-shortcuts/#bug-analysis); [Current Primitives](https://starlabs.sg/blog/2026/06-old-bug-harder-rules-exploiting-cve-2023-36802-without-the-usual-shortcuts/#current-primitives); [Corrupting Flink](https://starlabs.sg/blog/2026/06-old-bug-harder-rules-exploiting-cve-2023-36802-without-the-usual-shortcuts/#corrupting-flink)

**Method observations (source-reported):**
- Patch and constructor/dispatch review reconstructed concrete object types before evaluating unsafe casts.
- The researcher separated disclosure, decrement, and a fixed-value write instead of immediately calling them arbitrary read/write.
- Debugger stepping and allocator inspection revealed cleanup side effects and uncontrolled neighboring state that made a candidate write unreliable.

**Limits / failed assumptions:** Further capability development was tested in a particular allocator/version context; the reusable finding is precise constraint characterization, not the published construction.
**Defensive synthesis (inferred):** Validate type discriminants and include cleanup and collateral changes in primitive assessment.
**Technique owners:** [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md)

## B005

**Source:** [Old Wine in a New Bottle: A Decade-Old lxd-Group Root, Re-Armed](https://starlabs.sg/blog/2026/06-old-wine-in-a-new-bottle-a-decade-old-lxd-group-root-re-armed/)
**Research type:** Deployment-default and intended-capability assessment
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [A group that means root](https://starlabs.sg/blog/2026/06-old-wine-in-a-new-bottle-a-decade-old-lxd-group-root-re-armed/#a-group-that-means-root); [What changed underneath everyone](https://starlabs.sg/blog/2026/06-old-wine-in-a-new-bottle-a-decade-old-lxd-group-root-re-armed/#what-changed-underneath-everyone); [We checked every LTS from 18.04 to 26.04](https://starlabs.sg/blog/2026/06-old-wine-in-a-new-bottle-a-decade-old-lxd-group-root-re-armed/#we-checked-every-lts-from-1804-to-2604); [Disclosure](https://starlabs.sg/blog/2026/06-old-wine-in-a-new-bottle-a-decade-old-lxd-group-root-re-armed/#disclosure)

**Method observations (source-reported):**
- Offline image inspection compared default membership, installed packages, snap seeds, and activation units.
- Absence of an initially installed daemon did not imply absence of an activatable privileged capability.
- The service's group authority was documented as root-equivalent by design; the claim concerned default composition and operator expectations, not a code-level authentication flaw.

**Limits / failed assumptions:** Server/cloud image findings are not established for Desktop. Runtime boundary results were reported for four releases, not every image inspected; the vendor disputed the security-boundary classification.
**Defensive synthesis (inferred):** Audit effective administrative membership and activation, distinguish intentional capability from bypass, and inspect daemon-induced hardening changes.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [authorization-auditing](../skills/authorization-auditing/SKILL.md), [remediation](../skills/remediation/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md)

## B006

**Source:** [Race Against The Patch: The Evolution of Four Exploit Chains in LiteLLM](https://starlabs.sg/blog/2026/05-race-against-the-patch-the-evolution-of-four-exploit-chains-in-litellm/)
**Research type:** Longitudinal middleware source/patch and capability-composition audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [The Attack Scenario: Rules of Engagement](https://starlabs.sg/blog/2026/05-race-against-the-patch-the-evolution-of-four-exploit-chains-in-litellm/#the-attack-scenario-rules-of-engagement); [Target Version 1.83.7 / The Patch’s Blind Spot](https://starlabs.sg/blog/2026/05-race-against-the-patch-the-evolution-of-four-exploit-chains-in-litellm/#target-version-1837--the-patchs-blind-spot); [Target Version 1.83.14 / Your Own Spear](https://starlabs.sg/blog/2026/05-race-against-the-patch-the-evolution-of-four-exploit-chains-in-litellm/#target-version-18314--your-own-spear); [Conclusion](https://starlabs.sg/blog/2026/05-race-against-the-patch-the-evolution-of-four-exploit-chains-in-litellm/#conclusion)

**Method observations (source-reported):**
- The accepted actor and default configuration were clarified before evaluating candidate applicability.
- Authentication dependency failures, nested metadata, and create/update authorization differed across equivalent paths.
- Immediate-input restrictions did not cover stored values later interpreted as secret references.
- Merged source changes were checked against actual distributed artifacts; human threat modeling and validation remained necessary despite AI assistance.

**Limits / failed assumptions:** Some candidates required non-default settings and were outside the chosen scenario. Attribution of patch speed to other reports or hardening activity was speculative.
**Defensive synthesis (inferred):** Fail closed, authorize fields across representations, constrain stored interpretation, and verify shipped fix contents.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [authorization-auditing](../skills/authorization-auditing/SKILL.md), [data-flow-analysis](../skills/data-flow-analysis/SKILL.md), [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md), [remediation](../skills/remediation/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md), [source-code-auditing](../skills/source-code-auditing/SKILL.md)

## B007

**Source:** [Three Bugs Walk Into a PDF: Prototype Pollution, Served Cold](https://starlabs.sg/blog/2026/04-three-bugs-walk-into-a-pdf-prototype-pollution-served-cold/)
**Research type:** Privileged scripting patch and behavioral-dispatch analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [How Adobe’s Fixes Gave It Away](https://starlabs.sg/blog/2026/04-three-bugs-walk-into-a-pdf-prototype-pollution-served-cold/#how-adobes-fixes-gave-it-away); [Three Polluted Primitives, One Pure Chain](https://starlabs.sg/blog/2026/04-three-bugs-walk-into-a-pdf-prototype-pollution-served-cold/#three-polluted-primitives-one-pure-chain); [Conclusion](https://starlabs.sg/blog/2026/04-three-bugs-walk-into-a-pdf-prototype-pollution-served-cold/#conclusion)

**Method observations (source-reported):**
- Successive releases changed global/prototype lookup to lexical-local binding in privileged scripting code.
- A data-to-source construction was replaced with closure-bound runtime values; other changes enforced primitive string types before method processing.
- Reverse engineering of a sample corroborated patch-derived hypotheses about elevated scripting and file access.

**Limits / failed assumptions:** The mapping of some patches to advisory identifiers was uncertain. Broader code execution and patch-prioritization explanations were not fully demonstrated; no specific diff/debug tool was named.
**Defensive synthesis (inferred):** Audit inherited property and coercion behavior in privileged code; prefer locals, inert data, and fixed behavior selection.
**Technique owners:** [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md)

## B008

**Source:** [CHECK Removed, Context Confused, Checkmate Achieved](https://starlabs.sg/blog/2026/04-check-removed-context-confused-checkmate-achieved/)
**Research type:** Parser-identity and cross-tier runtime analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Reversing the Patch](https://starlabs.sg/blog/2026/04-check-removed-context-confused-checkmate-achieved/#reversing-the-patch); [Understanding Class Member Reparsing](https://starlabs.sg/blog/2026/04-check-removed-context-confused-checkmate-achieved/#understanding-class-member-reparsing); [Can we Checkmate without a CHECK?](https://starlabs.sg/blog/2026/04-check-removed-context-confused-checkmate-achieved/#can-we-checkmate-without-a-check)

**Method observations (source-reported):**
- The patch added classifications and counter/scope handling that exposed an identity-ordering assumption across lazy reparsing.
- Runtime metadata and function identity were compared rather than relying only on source interpretation.
- Release assertions stopped an identity mismatch; the researchers disabled checks for further counterfactual exploration, and additional errors complicated interpretation.

**Limits / failed assumptions:** The page mixes original-release barriers with later modified-build exploration. It does not justify treating assertion-disabled consequences as equivalent unmodified-product exploitability. Follow-on errors remained unexplained; broader sandbox bypass was proposed, not demonstrated.
**Defensive synthesis (inferred):** Preserve identity ordering and coupled metadata across phases; retain assertions and distinguish original from reconstructed builds.
**Technique owners:** [compiler-invariant-auditing](../skills/compiler-invariant-auditing/SKILL.md), [dynamic-analysis](../skills/dynamic-analysis/SKILL.md)

## B009

**Source:** [Pickling the Mailbox: A Deep Dive into CVE-2025-20393](https://starlabs.sg/blog/2026/02-pickling-the-mailbox-a-deep-dive-into-cve-2025-20393/)
**Research type:** Firmware patch-led serialization and runtime-version analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Patch Diffing: Finding the Needle](https://starlabs.sg/blog/2026/02-pickling-the-mailbox-a-deep-dive-into-cve-2025-20393/#patch-diffing-finding-the-needle); [Background: EUQ RPC Protocol](https://starlabs.sg/blog/2026/02-pickling-the-mailbox-a-deep-dive-into-cve-2025-20393/#background-euq-rpc-protocol); [Vulnerability Analysis](https://starlabs.sg/blog/2026/02-pickling-the-mailbox-a-deep-dive-into-cve-2025-20393/#vulnerability-analysis); [Conclusion](https://starlabs.sg/blog/2026/02-pickling-the-mailbox-a-deep-dive-into-cve-2025-20393/#conclusion)

**Method observations (source-reported):**
- New length validation directed investigation to the width and semantics of packed protocol fields.
- The article illustrates different packing behavior between its legacy runtime and a modern runtime; sender length and receiver framing can consequently disagree.
- A reported downstream unsafe deserializer made the representation discrepancy security-relevant.

**Limits / failed assumptions:** Some explanations for accepting an empty destination are explicitly presented as alternative hypothetical implementations. Exact authorization behavior and historical runtime semantics are not independently reproduced by this library; timeout is not success evidence.
**Defensive synthesis (inferred):** Validate representable lengths and exact framing, reject ambiguous empty authorization fields, and replace unsafe object decoding.
**Technique owners:** [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md)

## B014

**Source:** [Breaking Into a Brother (MFC-J1010DW): Three Security Flaws in a Seemingly Innocent Printer](https://starlabs.sg/blog/2025/11-breaking-into-a-brother-mfc-j1010dw-three-security-flaws-in-a-seemingly-innocent-printer/)
**Research type:** Hardware-assisted firmware reconstruction and binary audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Part 1: Acquiring the firmware](https://starlabs.sg/blog/2025/11-breaking-into-a-brother-mfc-j1010dw-three-security-flaws-in-a-seemingly-innocent-printer/#part-1-acquiring-the-firmware); [Hardware Watchdog Timer](https://starlabs.sg/blog/2025/11-breaking-into-a-brother-mfc-j1010dw-three-security-flaws-in-a-seemingly-innocent-printer/#hardware-watchdog-timer); [Finding the Memory Map](https://starlabs.sg/blog/2025/11-breaking-into-a-brother-mfc-j1010dw-three-security-flaws-in-a-seemingly-innocent-printer/#finding-the-memory-map); [Part 4: Finding the Vulnerability](https://starlabs.sg/blog/2025/11-breaking-into-a-brother-mfc-j1010dw-three-security-flaws-in-a-seemingly-innocent-printer/#part-4-finding-the-vulnerability)

**Method observations (source-reported):**
- Electrical levels, flash acquisition, segmented compression, load addresses, and architecture were established before useful disassembly.
- ImHex, a format model, zlib, and IDA supported container and memory-map reconstruction.
- Unsafe header parsing and authentication/update surfaces were audited in decompiled code; a physical-device observation corroborated the reported effect.
- Normal hardware halting triggered watchdog reboots, limiting debugging.

**Limits / failed assumptions:** Some board and RAM identifications were inferred or approximate; suggested watchdog changes were not demonstrated. No emulator validation was reported.
**Defensive synthesis (inferred):** Validate complete parser bounds, authenticate management/update operations, and keep hardware/emulator assumptions separate.
**Technique owners:** [binary-auditing](../skills/binary-auditing/SKILL.md)

## B017

**Source:** [Lost in Translation: Apache Vulnerabilities That Don't Count (Literally)](https://starlabs.sg/blog/2025/09-lost-in-translation-apache-vulnerabilities-that-dont-count-literally/)
**Research type:** Backend destination and external-tool argument audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Technical Details (1)](https://starlabs.sg/blog/2025/09-lost-in-translation-apache-vulnerabilities-that-dont-count-literally/#technical-details); [Technical Details (2)](https://starlabs.sg/blog/2025/09-lost-in-translation-apache-vulnerabilities-that-dont-count-literally/#technical-details-1); [Suggested Mitigations](https://starlabs.sg/blog/2025/09-lost-in-translation-apache-vulnerabilities-that-dont-count-literally/#suggested-mitigations); [Remediation Advice](https://starlabs.sg/blog/2025/09-lost-in-translation-apache-vulnerabilities-that-dont-count-literally/#remediation-advice)

**Method observations (source-reported):**
- Outbound request behavior and response-decoding differences supplied an oracle without returning the full response body.
- Another audit followed input through argument conversion, option parsing, configuration loading, and evaluation.
- The article reports fixes without advisory identifiers, illustrating that reporting labels are not evidence of technical safety.

**Limits / failed assumptions:** The internal-service consequence assumes an available particular backend; a converter-source attribution was qualified. Specific shipped patch behavior is not shown.
**Defensive synthesis (inferred):** Constrain final outbound destinations and tool options; rotate established exposed secrets and verify fixes beyond report labels.
**Technique owners:** [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [remediation](../skills/remediation/SKILL.md)

## B018

**Source:** [Fuzzing a Printer: Pre-auth RCE in a Network IoT Device](https://starlabs.sg/blog/2025/09-fuzzing-a-printer-pre-auth-rce-in-a-network-iot-device/)
**Research type:** Brief emulated-protocol fuzzing report
**Evidence level:** brief-author-report; reported runtime results not independently reproduced.
**Locators:** [The harness](https://starlabs.sg/blog/2025/09-fuzzing-a-printer-pre-auth-rce-in-a-network-iot-device/#the-harness); [The bug](https://starlabs.sg/blog/2025/09-fuzzing-a-printer-pre-auth-rce-in-a-network-iot-device/#the-bug)

**Method observations (source-reported):**
- A QEMU-based firmware environment with a hooked network stack exposed listeners to AFL++.
- The reported crash from an unchecked length-prefixed copy reproduced on physical hardware, supplying a stronger reachability check than emulator-only results.

**Limits / failed assumptions:** This is a short report without a complete harness, coverage data, patch, or campaign details; no quantitative effectiveness or universal mitigation claim is supported.
**Defensive synthesis (inferred):** Validate harness fidelity and hardware reachability; bound copy lengths at their consumers.
**Technique owners:** [fuzzing](../skills/fuzzing/SKILL.md)

## B021

**Source:** [My `Blind Date` with CVE-2025-29824](https://starlabs.sg/blog/2025/07-my-blind-date-with-cve-2025-29824/)
**Research type:** Windows lifecycle patch comparison
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Patch Analysis - Before vs. After](https://starlabs.sg/blog/2025/07-my-blind-date-with-cve-2025-29824/#patch-analysis---before-vs-after); [Cleanup VS Close](https://starlabs.sg/blog/2025/07-my-blind-date-with-cve-2025-29824/#cleanup-vs-close); [Variant Analysis](https://starlabs.sg/blog/2025/07-my-blind-date-with-cve-2025-29824/#variant-analysis)

**Method observations (source-reported):**
- The patch relocated release from user-handle cleanup to final file-object close, changing the lifetime relation with pending I/O.
- Dispatch paths and crash stacks linked outstanding accesses to premature release.
- Variant review inventoried other released or modified fields rather than assuming every changed field was another bug.

**Limits / failed assumptions:** The page does not establish a symbol-free workflow or name a specific diff tool; a crash is not controlled execution and the broad fix conclusion is the author's lifecycle interpretation.
**Defensive synthesis (inferred):** Release shared request state only at the correct final-lifetime event and regression-test outstanding-I/O paths.
**Technique owners:** [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md), [remediation](../skills/remediation/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B022

**Source:** [Fooling the Sandbox: A Chrome-atic Escape](https://starlabs.sg/blog/2025/07-fooling-the-sandbox-a-chrome-atic-escape/)
**Research type:** Windows double-fetch and layered sandbox-context analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [The Hunt Begins: Finding the Trigger for CVE-2024-30088](https://starlabs.sg/blog/2025/07-fooling-the-sandbox-a-chrome-atic-escape/#the-hunt-begins-finding-the-trigger-for-cve-2024-30088); [The Eureka Moment: Understanding the Race](https://starlabs.sg/blog/2025/07-fooling-the-sandbox-a-chrome-atic-escape/#the-eureka-moment-understanding-the-race); [Roadblock #1: The Integrity Police](https://starlabs.sg/blog/2025/07-fooling-the-sandbox-a-chrome-atic-escape/#roadblock-1-the-integrity-police); [Roadblock #2: The Job Object Prison](https://starlabs.sg/blog/2025/07-fooling-the-sandbox-a-chrome-atic-escape/#roadblock-2-the-job-object-prison)

**Method observations (source-reported):**
- Call-chain reversing tracked mutable user memory written and later reused by kernel consumers.
- A public higher-integrity reproduction did not establish the same access from an untrusted renderer.
- A real write's broader footprint corrupted adjacent fields; precise debugger edits did not model that primitive.
- Job restrictions and desktop/session visibility remained distinct from elevated identity.

**Limits / failed assumptions:** Analysis used a historical OS build. Debugger/security-policy modifications are diagnostic experiments, not unmodified-context proof; no patch-diff procedure is established on the page.
**Defensive synthesis (inferred):** Snapshot untrusted data and evaluate each active confinement layer and the complete write footprint.
**Technique owners:** [dynamic-analysis](../skills/dynamic-analysis/SKILL.md), [race-condition-auditing](../skills/race-condition-auditing/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md)

## B023

**Source:** [Solo: A Pixel 6 Pro Story (When one bug is all you need)](https://starlabs.sg/blog/2025/06-solo-a-pixel-6-pro-story-when-one-bug-is-all-you-need/)
**Research type:** GPU/OS portability and mitigation reassessment
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [What is CONFIG_HARDENED_USERCOPY?](https://starlabs.sg/blog/2025/06-solo-a-pixel-6-pro-story-when-one-bug-is-all-you-need/#what-is-config_hardened_usercopy); [Command Stream Frontend](https://starlabs.sg/blog/2025/06-solo-a-pixel-6-pro-story-when-one-bug-is-all-you-need/#command-stream-frontend); [From Physical to Virtual: Converting Our Primitive](https://starlabs.sg/blog/2025/06-solo-a-pixel-6-pro-story-when-one-bug-is-all-you-need/#from-physical-to-virtual-converting-our-primitive); [Bypassing Android’s App Sandbox](https://starlabs.sg/blog/2025/06-solo-a-pixel-6-pro-story-when-one-bug-is-all-you-need/#bypassing-androids-app-sandbox)

**Method observations (source-reported):**
- Compiled feature differences changed API availability; unsupported operations did not imply the related defect was absent.
- Hardening checks and deferred RCU reclamation invalidated assumptions carried over from another device.
- Allocation behavior was measured across runs/reboots, and application confinement was checked separately from kernel privilege.

**Limits / failed assumptions:** Placement was not guaranteed and some explanations for address variation were speculative. Results concern the author's device/build, not all GPUs or Android contexts.
**Defensive synthesis (inferred):** Revalidate feature, allocator, lifetime, and policy contracts whenever changing target hardware or build.
**Technique owners:** [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B024

**Source:** [Gone in 5 Seconds: How WARN_ON Stole 10 Minutes](https://starlabs.sg/blog/2025/05-gone-in-5-seconds-how-warn_on-stole-10-minutes/)
**Research type:** GPU race root-cause and diagnostic-cost investigation
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Backing pages](https://starlabs.sg/blog/2025/05-gone-in-5-seconds-how-warn_on-stole-10-minutes/#backing-pages); [‘Fix’ delay](https://starlabs.sg/blog/2025/05-gone-in-5-seconds-how-warn_on-stole-10-minutes/#fix-delay); [Bug Fix](https://starlabs.sg/blog/2025/05-gone-in-5-seconds-how-warn_on-stole-10-minutes/#bug-fix)

**Method observations (source-reported):**
- A race invalidated a growth-size assumption across locking and state changes.
- Repeated warning/stack logging dominated elapsed time; inspecting kernel logs distinguished diagnostic overhead from an unsuccessful hypothesis.
- The shown patch rechecked state after locking and moved dependent size calculations.

**Limits / failed assumptions:** A diagnostic kernel module that suppressed warnings altered the environment and cannot be treated as an unprivileged capability or as remediation.
**Defensive synthesis (inferred):** Recompute dependent state after reacquiring synchronization and measure observer/diagnostic costs explicitly.
**Technique owners:** [dynamic-analysis](../skills/dynamic-analysis/SKILL.md), [race-condition-auditing](../skills/race-condition-auditing/SKILL.md)

## B026

**Source:** [Lessons From Pwn2Own Berlin 2025: Building a Hypervisor Escape](https://starlabs.sg/blog/2025/05-lessons-from-pwn2own-berlin-2025-building-a-hypervisor-escape/)
**Research type:** Brief hypervisor selection and failed-hypothesis retrospective
**Evidence level:** brief-author-report; reported runtime results not independently reproduced.
**Locators:** [Target selection](https://starlabs.sg/blog/2025/05-lessons-from-pwn2own-berlin-2025-building-a-hypervisor-escape/#target-selection); [The primitive](https://starlabs.sg/blog/2025/05-lessons-from-pwn2own-berlin-2025-building-a-hypervisor-escape/#the-primitive); [What didn’t work](https://starlabs.sg/blog/2025/05-lessons-from-pwn2own-berlin-2025-building-a-hypervisor-escape/#what-didnt-work)

**Method observations (source-reported):**
- Surface selection prioritized attacker-input density and the researchers' understanding of fuzzing attention.
- The reported DMA consumer read a checked mutable field again before use.
- An earlier overflow hypothesis failed because the production layout placed the change in unused padding.

**Limits / failed assumptions:** The hypervisor and detailed test artifacts are not identified; this is qualitative author-reported evidence, not an independently reproducible full study.
**Defensive synthesis (inferred):** Validate checked/used shared-memory identity and production consequence before investing in stronger impact hypotheses.
**Technique owners:** [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md), [race-condition-auditing](../skills/race-condition-auditing/SKILL.md)

## B027

**Source:** [Breaking Out of Restricted Mode: XSS to RCE in Visual Studio Code](https://starlabs.sg/blog/2025/05-breaking-out-of-restricted-mode-xss-to-rce-in-visual-studio-code/)
**Research type:** Desktop rendering and privileged IPC boundary audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Vulnerability Details](https://starlabs.sg/blog/2025/05-breaking-out-of-restricted-mode-xss-to-rce-in-visual-studio-code/#vulnerability-details); [Escalating to RCE](https://starlabs.sg/blog/2025/05-breaking-out-of-restricted-mode-xss-to-rce-in-visual-studio-code/#escalating-to-rce); [Suggested Mitigations](https://starlabs.sg/blog/2025/05-breaking-out-of-restricted-mode-xss-to-rce-in-visual-studio-code/#suggested-mitigations); [Timeline](https://starlabs.sg/blog/2025/05-breaking-out-of-restricted-mode-xss-to-rce-in-visual-studio-code/#timeline)

**Method observations (source-reported):**
- Source tracing followed untrusted formatted output into DOM insertion and compared rendering/trust branches.
- Resource admission, active-content execution, privileged IPC, and filesystem confinement were distinct policies.
- The report's later vendor timeline added an extensive user-interaction prerequisite to stronger impact.

**Limits / failed assumptions:** Some mitigations are recommendations, not shown deployed fixes. Windows/macOS testing does not establish Linux equivalence, and the later interaction caveat must accompany the original impact claim.
**Defensive synthesis (inferred):** Use contextual safe rendering and consumer-side IPC confinement; test every trust/rendering mode and required interaction.
**Technique owners:** [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md)

## B028

**Source:** [CimFS: Crashing in memory, Finding SYSTEM (Kernel Edition)](https://starlabs.sg/blog/2025/03-cimfs-crashing-in-memory-finding-system-kernel-edition/)
**Research type:** Undocumented driver surface, constrained fuzzing, and crash triage
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Auth Bypass](https://starlabs.sg/blog/2025/03-cimfs-crashing-in-memory-finding-system-kernel-edition/#auth-bypass); [Mount Operation](https://starlabs.sg/blog/2025/03-cimfs-crashing-in-memory-finding-system-kernel-edition/#mount-operation); [Attack Plan](https://starlabs.sg/blog/2025/03-cimfs-crashing-in-memory-finding-system-kernel-edition/#attack-plan); [Fuzz Results](https://starlabs.sg/blog/2025/03-cimfs-crashing-in-memory-finding-system-kernel-edition/#fuzz-results); [Bug Analysis](https://starlabs.sg/blog/2025/03-cimfs-crashing-in-memory-finding-system-kernel-edition/#bug-analysis); [Introduction](https://starlabs.sg/blog/2025/03-cimfs-crashing-in-memory-finding-system-kernel-edition/#introduction)

**Method observations (source-reported):**
- Root-object ACLs did not enforce equivalent policy on descendant opens handled by the same driver.
- A documented companion library supplied interface contracts and feature-rich valid corpus generation.
- Successful setup filtered mutations for inner operations; shallow crashes limited further exploration.
- The eventual mitigation restricted low-privilege exposure rather than repairing every underlying parser defect.

**Limits / failed assumptions:** The coarse gate is not coverage proof and can exclude setup bugs. Remaining administrator-to-kernel behavior was not treated by the vendor as the same security boundary.
**Defensive synthesis (inferred):** Verify every object-opening route, keep separate outer/inner campaigns, and distinguish access mitigation from root-cause repair.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [authorization-auditing](../skills/authorization-auditing/SKILL.md), [binary-auditing](../skills/binary-auditing/SKILL.md), [fuzzing](../skills/fuzzing/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md)

## B030

**Source:** [Mali-cious Intent: Exploiting GPU Vulnerabilities (CVE-2022-22706 / CVE-2021-39793)](https://starlabs.sg/blog/2025/02-mali-cious-intent-exploiting-gpu-vulnerabilities-cve-2022-22706-/-cve-2021-39793/)
**Research type:** GPU page-permission and OS-policy audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Root Cause Analysis](https://starlabs.sg/blog/2025/02-mali-cious-intent-exploiting-gpu-vulnerabilities-cve-2022-22706-/-cve-2021-39793/#root-cause-analysis); [Exploitation Primitive](https://starlabs.sg/blog/2025/02-mali-cious-intent-exploiting-gpu-vulnerabilities-cve-2022-22706-/-cve-2021-39793/#exploitation-primitive); [Escalating to Root via init Hijacking](https://starlabs.sg/blog/2025/02-mali-cious-intent-exploiting-gpu-vulnerabilities-cve-2022-22706-/-cve-2021-39793/#escalating-to-root-via-init-hijacking)

**Method observations (source-reported):**
- The patch related requested CPU/GPU write authority to write-authorized page pinning.
- Permission queries and denial observations separated file access, device access, execution, and domain-transition policy.
- The reported changes affected cached in-memory pages rather than durable file contents.

**Limits / failed assumptions:** The prose's both-flags description conflicts with the shown either-flag bitwise test; the library uses the invariant, not that prose formula. Broader file-permission descriptions were partly qualified.
**Defensive synthesis (inferred):** Keep pinning, mapping, and consumer permission contracts aligned and distinguish page-cache effects from persistent storage effects.
**Technique owners:** [authorization-auditing](../skills/authorization-auditing/SKILL.md), [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md)

## B031

**Source:** [CVE-2024-26230: Windows Telephony Service - It's Got Some Call-ing Issues (Elevation of Privilege)](https://starlabs.sg/blog/2025/01-cve-2024-26230-windows-telephony-service-its-got-some-call-ing-issues-elevation-of-privilege/)
**Research type:** RPC dispatch, dangling-context, and input-size-limit analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Description of Vulnerability](https://starlabs.sg/blog/2025/01-cve-2024-26230-windows-telephony-service-its-got-some-call-ing-issues-elevation-of-privilege/#description-of-vulnerability); [Interface Definition Language (IDL)](https://starlabs.sg/blog/2025/01-cve-2024-26230-windows-telephony-service-its-got-some-call-ing-issues-elevation-of-privilege/#interface-definition-language-idl); [ClientRequest](https://starlabs.sg/blog/2025/01-cve-2024-26230-windows-telephony-service-its-got-some-call-ing-issues-elevation-of-privilege/#clientrequest); [Detection Guidance](https://starlabs.sg/blog/2025/01-cve-2024-26230-windows-telephony-service-its-got-some-call-ing-issues-elevation-of-privilege/#detection-guidance)

**Method observations (source-reported):**
- Interface definitions and a dispatch table connected service methods to retained context and freed objects.
- Registry permissions established which inputs could control service allocations.
- A related patch changed termination and allocation arithmetic, but an external registry-value size ceiling prevented the theoretical oversized input from being created.

**Limits / failed assumptions:** The theoretical arithmetic path was not reproduced. A mitigation blocking one attempted control-flow technique did not establish general safety.
**Defensive synthesis (inferred):** Revoke stale context references, check complete arithmetic/termination, and validate input ceilings before promoting a hypothesis.
**Technique owners:** [binary-auditing](../skills/binary-auditing/SKILL.md), [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B034

**Source:** [All I Want for Christmas is a CVE-2024-30085 Exploit](https://starlabs.sg/blog/2024/12-all-i-want-for-christmas-is-a-cve-2024-30085-exploit/)
**Research type:** Nested-format and fixed-buffer patch analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Vulnerability Analysis and Patch](https://starlabs.sg/blog/2024/12-all-i-want-for-christmas-is-a-cve-2024-30085-exploit/#vulnerability-analysis-and-patch); [Reparse Point Structure](https://starlabs.sg/blog/2024/12-all-i-want-for-christmas-is-a-cve-2024-30085-exploit/#reparse-point-structure); [Obtaining a Kernel Pointer Leak](https://starlabs.sg/blog/2024/12-all-i-want-for-christmas-is-a-cve-2024-30085-exploit/#obtaining-a-kernel-pointer-leak); [Arbitrary Read](https://starlabs.sg/blog/2024/12-all-i-want-for-christmas-is-a-cve-2024-30085-exploit/#arbitrary-read)

**Method observations (source-reported):**
- Structural checks on counts, checksums, and types did not bound a later copy into a fixed allocation.
- Decompilation comparison identified the added destination-capacity check.
- Runtime observation distinguished editing an object's data from freeing and replacing its allocation.

**Limits / failed assumptions:** The published allocator-dependent construction does not establish deterministic placement; only the parser/consumer mismatch and observed lifecycle constraints are retained.
**Defensive synthesis (inferred):** Check every consumer's capacity independently and verify allocation identity across apparent updates.
**Technique owners:** [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md)

## B035

**Source:** [Behind the Scenes: Understanding CVE-2022-24547](https://starlabs.sg/blog/2024/12-behind-the-scenes-understanding-cve-2022-24547/)
**Research type:** Cross-session COM and filesystem-policy analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Description of Vulnerability](https://starlabs.sg/blog/2024/12-behind-the-scenes-understanding-cve-2022-24547/#description-of-vulnerability); [Exploitation](https://starlabs.sg/blog/2024/12-behind-the-scenes-understanding-cve-2022-24547/#exploitation); [Exploit Conditions](https://starlabs.sg/blog/2024/12-behind-the-scenes-understanding-cve-2022-24547/#exploit-conditions); [Conclusion](https://starlabs.sg/blog/2024/12-behind-the-scenes-understanding-cve-2022-24547/#conclusion)

**Method observations (source-reported):**
- COM interface/control-flow review traced operations into permissive directory creation and path resolution.
- Cross-session applicability required another active user on the same system.
- A stronger modification hypothesis failed because required resource-file access was administrator-only; the author explicitly did not complete the escalation.

**Limits / failed assumptions:** Reported filesystem behavior is not proof of successful privilege escalation; preserve the author's unsuccessful outcome despite the headline impact.
**Defensive synthesis (inferred):** Validate path/object identity and permissions at privileged file operations, including symlinks and cross-session contexts.
**Technique owners:** [authorization-auditing](../skills/authorization-auditing/SKILL.md), [exploitability-assessment](../skills/exploitability-assessment/SKILL.md)

## B037

**Source:** [Send()-ing Myself Belated Christmas Gifts - GitHub.com's Environment Variables & GHES Shell](https://starlabs.sg/blog/2024/05-send-ing-myself-belated-christmas-gifts-github.coms-environment-variables-ghes-shell/)
**Research type:** Ruby reflection audit and impact-boundary discovery
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Discovering the Vulnerability](https://starlabs.sg/blog/2024/05-send-ing-myself-belated-christmas-gifts-github.coms-environment-variables-ghes-shell/#discovering-the-vulnerability); [In Search of Impact](https://starlabs.sg/blog/2024/05-send-ing-myself-belated-christmas-gifts-github.coms-environment-variables-ghes-shell/#in-search-of-impact); [Triaging Candidate Methods](https://starlabs.sg/blog/2024/05-send-ing-myself-belated-christmas-gifts-github.coms-environment-variables-ghes-shell/#triaging-candidate-methods); [The Actual Impact](https://starlabs.sg/blog/2024/05-send-ing-myself-belated-christmas-gifts-github.coms-environment-variables-ghes-shell/#the-actual-impact); [Suggested Mitigations](https://starlabs.sg/blog/2024/05-send-ing-myself-belated-christmas-gifts-github.coms-environment-variables-ghes-shell/#suggested-mitigations)

**Method observations (source-reported):**
- The researcher traced an unvalidated reflective selector and used local introspection of arity, visibility, and source locations to prioritize methods.
- Default-argument methods remained relevant after filtering; inherited/private behavior exceeded the intended API.
- Unexpected sensitive disclosure invalidated an initially low-impact assumption and testing stopped; subprocess environment inheritance amplified exposure.

**Limits / failed assumptions:** Production testing in the source is not recommended here. Further hosted-service execution was hypothetical, and enterprise-specific execution paths were not equivalent to the demonstrated hosted disclosure.
**Defensive synthesis (inferred):** Use a fixed method registry, minimize subprocess environments, stop unexpected disclosure, and rotate established exposed secrets.
**Technique owners:** [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [remediation](../skills/remediation/SKILL.md), [source-code-auditing](../skills/source-code-auditing/SKILL.md)

## B039

**Source:** [Route to Safety: Navigating Router Pitfalls](https://starlabs.sg/blog/2024/03-route-to-safety-navigating-router-pitfalls/)
**Research type:** Router surface survey and defensive source/binary synthesis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Attack Surface](https://starlabs.sg/blog/2024/03-route-to-safety-navigating-router-pitfalls/#attack-surface); [Other Services](https://starlabs.sg/blog/2024/03-route-to-safety-navigating-router-pitfalls/#other-services); [Poor Configurations](https://starlabs.sg/blog/2024/03-route-to-safety-navigating-router-pitfalls/#poor-configurations); [Conclusion](https://starlabs.sg/blog/2024/03-route-to-safety-navigating-router-pitfalls/#conclusion)

**Method observations (source-reported):**
- The survey looked beyond admin panels to service listeners, execution identity, default configuration, and untrusted fields consumed by privileged code.
- Structured process execution removed shell interpretation in a described fix.
- Shared product code and upstream libraries created horizontal and vertical patch-propagation obligations.

**Limits / failed assumptions:** Examples span different historical products and configurations; the survey does not establish identical exposure or fixes in every router.
**Defensive synthesis (inferred):** Reduce exposed privileged services, avoid shell construction, and inventory all affected downstream products and dependency versions.
**Technique owners:** [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md), [remediation](../skills/remediation/SKILL.md)

## B040

**Source:** [Exploitation of a kernel pool overflow from a restrictive chunk size (CVE-2021-31969)](https://starlabs.sg/blog/2023/11-exploitation-of-a-kernel-pool-overflow-from-a-restrictive-chunk-size-cve-2021-31969/)
**Research type:** Restricted Windows allocator/primitive and stability assessment
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Bug Analysis](https://starlabs.sg/blog/2023/11-exploitation-of-a-kernel-pool-overflow-from-a-restrictive-chunk-size-cve-2021-31969/#bug-analysis); [Improving Primitive](https://starlabs.sg/blog/2023/11-exploitation-of-a-kernel-pool-overflow-from-a-restrictive-chunk-size-cve-2021-31969/#improving-primitive); [Restrictions](https://starlabs.sg/blog/2023/11-exploitation-of-a-kernel-pool-overflow-from-a-restrictive-chunk-size-cve-2021-31969/#restrictions); [Exploit Success Rate](https://starlabs.sg/blog/2023/11-exploitation-of-a-kernel-pool-overflow-from-a-restrictive-chunk-size-cve-2021-31969/#exploit-success-rate); [Post Exploitation](https://starlabs.sg/blog/2023/11-exploitation-of-a-kernel-pool-overflow-from-a-restrictive-chunk-size-cve-2021-31969/#post-exploitation)

**Method observations (source-reported):**
- The researcher separated input/retrieval limits from the fixed allocation and complete arithmetic expression.
- Allocator size-class/segregation and single-opportunity behavior constrained plausible adjacency.
- Repeated attempts and later cleanup faults showed that obtaining an initial effect did not imply stable success.

**Limits / failed assumptions:** Reported low reliability and collateral corruption are environment-dependent; the skill does not retain the original neighboring objects or construction.
**Defensive synthesis (inferred):** Validate minimum/maximum sizes and assess post-effect cleanup; allocator hardening is not a bounds fix.
**Technique owners:** [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md)

## B041

**Source:** [Analysis of NodeBB Account Takeover Vulnerability (CVE-2022-46164)](https://starlabs.sg/blog/2023/09-analysis-of-nodebb-account-takeover-vulnerability-cve-2022-46164/)
**Research type:** Stateful API dispatch and incomplete-patch audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Vulnerability Details](https://starlabs.sg/blog/2023/09-analysis-of-nodebb-account-takeover-vulnerability-cve-2022-46164/#vulnerability-details); [Patch Analysis](https://starlabs.sg/blog/2023/09-analysis-of-nodebb-account-takeover-vulnerability-cve-2022-46164/#patch-analysis); [v2.6.1](https://starlabs.sg/blog/2023/09-analysis-of-nodebb-account-takeover-vulnerability-cve-2022-46164/#v261); [v2.8.1](https://starlabs.sg/blog/2023/09-analysis-of-nodebb-account-takeover-vulnerability-cve-2022-46164/#v281); [Detection Guidance:](https://starlabs.sg/blog/2023/09-analysis-of-nodebb-account-takeover-vulnerability-cve-2022-46164/#detection-guidance)

**Method observations (source-reported):**
- The audit compared REST and stateful Socket.IO operations and traced recursive property selection into mutable connection identity.
- Removing only the root prototype left inherited behavior in nested objects/functions; a later own-property check addressed the selector contract.
- Detection review identified transport logging gaps and encoding-sensitive keyword matching.

**Limits / failed assumptions:** Different impacts had different database prerequisites. Default activity timestamps and partial logs are proposed detection signals, not proof of historical exploitation.
**Defensive synthesis (inferred):** Use explicit own-member dispatch and stable authenticated identity; validate telemetry across WebSocket and long-polling transports.
**Technique owners:** [authorization-auditing](../skills/authorization-auditing/SKILL.md), [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md), [remediation](../skills/remediation/SKILL.md)

## B042

**Source:** [\[P2O Vancouver 2023\] SharePoint Pre-Auth RCE chain (CVE-2023–29357 & CVE-2023–24955)](https://starlabs.sg/blog/2023/09-p2o-vancouver-2023-sharepoint-pre-auth-rce-chain-cve-202329357-cve-202324955/)
**Research type:** Application authentication and generated-code trust-boundary audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Brief](https://starlabs.sg/blog/2023/09-p2o-vancouver-2023-sharepoint-pre-auth-rce-chain-cve-202329357-cve-202324955/#brief); [Affected products/Tested version](https://starlabs.sg/blog/2023/09-p2o-vancouver-2023-sharepoint-pre-auth-rce-chain-cve-202329357-cve-202324955/#affected-productstested-version); [Vulnerability #1: SharePoint Application Authentication Bypass](https://starlabs.sg/blog/2023/09-p2o-vancouver-2023-sharepoint-pre-auth-rce-chain-cve-202329357-cve-202324955/#vulnerability-1-sharepoint-application-authentication-bypass); [Vulnerability #2: Code Injection in DynamicProxyGenerator.GenerateProxyAssembly()](https://starlabs.sg/blog/2023/09-p2o-vancouver-2023-sharepoint-pre-auth-rce-chain-cve-202329357-cve-202324955/#vulnerability-2-code-injection-in-dynamicproxygeneratorgenerateproxyassembly)

**Method observations (source-reported):**
- Configuration/module review separated eligibility, token parsing, signature, issuer, request binding, and application membership.
- Writable metadata was traced through code generation and type instantiation; API callability was not equivalent to write permission or execution capability.
- An assumed local administrative account was not necessarily a site member; provisioning differences changed feature availability.

**Limits / failed assumptions:** The article supplies a tested patch baseline but not a general before/after diff method or comprehensive remediation verification. Capability composition depends on specific membership and permissions.
**Defensive synthesis (inferred):** Authenticate every identity claim and validate metadata at code-generating consumers; keep composition prerequisites explicit.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [authorization-auditing](../skills/authorization-auditing/SKILL.md)

## B043

**Source:** [nftables Adventures: Bug Hunting and N-day Exploitation (CVE-2023-31248)](https://starlabs.sg/blog/2023/09-nftables-adventures-bug-hunting-and-n-day-exploitation-cve-2023-31248/)
**Research type:** Transaction generation, asynchronous lifetime, and N-day analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Genmask System](https://starlabs.sg/blog/2023/09-nftables-adventures-bug-hunting-and-n-day-exploitation-cve-2023-31248/#genmask-system); [Control Plane, Transaction System and Transaction Worker](https://starlabs.sg/blog/2023/09-nftables-adventures-bug-hunting-and-n-day-exploitation-cve-2023-31248/#control-plane-transaction-system-and-transaction-worker); [nftables Dormant State Chain Hook Deactivation Bug](https://starlabs.sg/blog/2023/09-nftables-adventures-bug-hunting-and-n-day-exploitation-cve-2023-31248/#nftables-dormant-state-chain-hook-deactivation-bug); [Vulnerability Analysis](https://starlabs.sg/blog/2023/09-nftables-adventures-bug-hunting-and-n-day-exploitation-cve-2023-31248/#vulnerability-analysis); [Patch Analysis (1)](https://starlabs.sg/blog/2023/09-nftables-adventures-bug-hunting-and-n-day-exploitation-cve-2023-31248/#patch-analysis); [Patch Analysis (2)](https://starlabs.sg/blog/2023/09-nftables-adventures-bug-hunting-and-n-day-exploitation-cve-2023-31248/#patch-analysis-1)

**Method observations (source-reported):**
- The researcher modeled current/next generation, commit/abort, logical unlink, and deferred destruction separately.
- Equivalent lookup paths differed in generation validity checks, while control-plane and worker timing could leave stale relationships.
- An earlier inconsistent-state warning could not reach useful frees; the author rejected that stronger impact hypothesis.

**Limits / failed assumptions:** Warning-only and stale-reference findings are distinct. Published exploitation details are version-dependent and excluded from the library.
**Defensive synthesis (inferred):** Apply state-validity checks consistently to every lookup and restore ownership invariants during abort and deferred teardown.
**Technique owners:** [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [race-condition-auditing](../skills/race-condition-auditing/SKILL.md), [remediation](../skills/remediation/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B045

**Source:** [A new method for container escape using file-based DirtyCred](https://starlabs.sg/blog/2023/07-a-new-method-for-container-escape-using-file-based-dirtycred/)
**Research type:** File-identity/lifetime and container-policy assessment
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [The vulnerability](https://starlabs.sg/blog/2023/07-a-new-method-for-container-escape-using-file-based-dirtycred/#the-vulnerability); [Code analysis](https://starlabs.sg/blog/2023/07-a-new-method-for-container-escape-using-file-based-dirtycred/#code-analysis); [Testing against actual containers](https://starlabs.sg/blog/2023/07-a-new-method-for-container-escape-using-file-based-dirtycred/#testing-against-actual-containers); [Standard Docker container](https://starlabs.sg/blog/2023/07-a-new-method-for-container-escape-using-file-based-dirtycred/#standard-docker-container)

**Method observations (source-reported):**
- Source and runtime reference observations compared authorization time with later file-operation dispatch.
- Blocking/fault instrumentation had privilege and configuration prerequisites that were absent in some actual contexts.
- A standard container's AppArmor policy denied the stronger boundary outcome, whereas other tested configurations differed.

**Limits / failed assumptions:** The analyzed source revision and runtime test kernel were different and explicitly identified. Neither container-local root nor a permissive test establishes universal container escape.
**Defensive synthesis (inferred):** Keep references and authorization context stable across blocking work and evaluate actual LSM/container policy.
**Technique owners:** [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [race-condition-auditing](../skills/race-condition-auditing/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md)

## B046

**Source:** [prctl anon_vma_name: An Amusing Linux Kernel Heap Spray](https://starlabs.sg/blog/2023/07-prctl-anon_vma_name-an-amusing-linux-kernel-heap-spray/)
**Research type:** Allocator/input/lifetime characterization of an interface
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [What is prctl?](https://starlabs.sg/blog/2023/07-prctl-anon_vma_name-an-amusing-linux-kernel-heap-spray/#what-is-prctl); [Conclusion](https://starlabs.sg/blog/2023/07-prctl-anon_vma_name-an-amusing-linux-kernel-heap-spray/#conclusion)

**Method observations (source-reported):**
- Allocation flags, configuration enablement, input alphabet/termination, and refcount-to-free paths determined the object's constraints.
- Repeated identical names could reuse an existing object rather than cause independent allocations.
- Terminated textual output constrained what could be observed.

**Limits / failed assumptions:** Process-death lifetime and distribution-default enablement were qualified assumptions; explicit privilege requirements were not fully established. The original allocation recipe is excluded.
**Defensive synthesis (inferred):** Measure actual allocation and lifetime effects; do not infer object counts from action counts or absence of data from truncated output.
**Technique owners:** [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md)

## B047

**Source:** [Breaking the Code - Exploiting and Examining CVE-2023-1829 in cls_tcindex Classifier Vulnerability](https://starlabs.sg/blog/2023/06-breaking-the-code-exploiting-and-examining-cve-2023-1829-in-cls_tcindex-classifier-vulnerability/)
**Research type:** Classifier branch/lifetime and allocator-failure analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Vulnerability Analysis](https://starlabs.sg/blog/2023/06-breaking-the-code-exploiting-and-examining-cve-2023-1829-in-cls_tcindex-classifier-vulnerability/#vulnerability-analysis); [How to solve the unstable problem when reclaiming UAF’s chunk](https://starlabs.sg/blog/2023/06-breaking-the-code-exploiting-and-examining-cve-2023-1829-in-cls_tcindex-classifier-vulnerability/#how-to-solve-the-unstable-problem-when-reclaiming-uafs-chunk); [Patch Analysis](https://starlabs.sg/blog/2023/06-breaking-the-code-exploiting-and-examining-cve-2023-1829-in-cls_tcindex-classifier-vulnerability/#patch-analysis)

**Method observations (source-reported):**
- Comparing sibling classifier branches exposed different deactivation/unlink behavior before deferred destruction.
- Format validation did not establish lifecycle safety.
- Allocator inspection with libslub helped explain repeated failed reuse attempts; the patch removed the affected component/build entry.

**Limits / failed assumptions:** A prose branch description conflicts with the displayed code. The generalized method does not adopt that attribution; allocator-dependent failure is not proof the lifetime defect is absent.
**Defensive synthesis (inferred):** Corroborate branch semantics with code, revoke reachability before deferred frees, and distinguish component removal from a repaired implementation.
**Technique owners:** [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B048

**Source:** [The Old, The New and The Bypass - One-click/Open-redirect to own Samsung S22 at Pwn2Own 2022](https://starlabs.sg/blog/2023/06-the-old-the-new-and-the-bypass-one-click/open-redirect-to-own-samsung-s22-at-pwn2own-2022/)
**Research type:** WebView navigation, intent dispatch, and patch-bypass audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [The “Old” Bug](https://starlabs.sg/blog/2023/06-the-old-the-new-and-the-bypass-one-click/open-redirect-to-own-samsung-s22-at-pwn2own-2022/#the-old-bug); [The “New” Bug](https://starlabs.sg/blog/2023/06-the-old-the-new-and-the-bypass-one-click/open-redirect-to-own-samsung-s22-at-pwn2own-2022/#the-new-bug); [The “Bypass”](https://starlabs.sg/blog/2023/06-the-old-the-new-and-the-bypass-one-click/open-redirect-to-own-samsung-s22-at-pwn2own-2022/#the-bypass); [Steps to Reproduction](https://starlabs.sg/blog/2023/06-the-old-the-new-and-the-bypass-one-click/open-redirect-to-own-samsung-s22-at-pwn2own-2022/#steps-to-reproduction)

**Method observations (source-reported):**
- Deobfuscation/control-flow review traced URL policy through WebView callbacks, superclass delegation, and privileged internal handlers.
- One binding's origin check blocked a candidate while another handler had different policy.
- Decoded validation and original-value navigation disagreed; repeated hot-fix review found incomplete coverage.

**Limits / failed assumptions:** The reusable finding is inconsistent canonical/dispatch policy, not the article's exact links or installation sequence. Historical server-side changes do not imply present exposure.
**Defensive synthesis (inferred):** Validate and navigate the same canonical URL and authorize privileged intent behavior on every path.
**Technique owners:** [authorization-auditing](../skills/authorization-auditing/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md)

## B049

**Source:** [Microsoft Exchange Powershell Remoting Deserialization leading to RCE (CVE-2023-21707)](https://starlabs.sg/blog/2023/04-microsoft-exchange-powershell-remoting-deserialization-leading-to-rce-cve-2023-21707/)
**Research type:** Nested type conversion/deserialization and patch-variant analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Introduction](https://starlabs.sg/blog/2023/04-microsoft-exchange-powershell-remoting-deserialization-leading-to-rce-cve-2023-21707/#introduction); [The new variant](https://starlabs.sg/blog/2023/04-microsoft-exchange-powershell-remoting-deserialization-leading-to-rce-cve-2023-21707/#the-new-variant); [Payload delivery](https://starlabs.sg/blog/2023/04-microsoft-exchange-powershell-remoting-deserialization-leading-to-rce-cve-2023-21707/#payload-delivery)

**Method observations (source-reported):**
- Conversion behavior included constructors, setters, parsing, and custom converters rather than inert value casts.
- An allowed outer type inherited callbacks containing a second deserialization boundary.
- An earlier delivery-path patch did not establish repair of the underlying deserializer.

**Limits / failed assumptions:** The reported applicability required a particular authentication method and was not viable as the described internet-facing scenario. No complete later remediation verification is shown.
**Defensive synthesis (inferred):** Audit type restrictions transitively through callbacks and nested decoders; verify transport and root-cause fixes separately.
**Technique owners:** [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md), [remediation](../skills/remediation/SKILL.md)

## B050

**Source:** [CS-Cart PDF Plugin Unauthenticated Command Injection](https://starlabs.sg/blog/2023/03-cs-cart-pdf-plugin-unauthenticated-command-injection/)
**Research type:** Derived-path and external-process argument source audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Product Background](https://starlabs.sg/blog/2023/03-cs-cart-pdf-plugin-unauthenticated-command-injection/#product-background); [Decription of the Vulnerability](https://starlabs.sg/blog/2023/03-cs-cart-pdf-plugin-unauthenticated-command-injection/#decription-of-the-vulnerability); [Recommendations](https://starlabs.sg/blog/2023/03-cs-cart-pdf-plugin-unauthenticated-command-injection/#recommendations)

**Method observations (source-reported):**
- Untrusted identifiers flowed into paths, writes, command construction, and process execution.
- Derived filenames, not only original parameters, required argument safety.
- The shown fix escaped command arguments, while path-confinement validation remained a separate concern.

**Limits / failed assumptions:** The affected optional conversion component was not equivalent to every installation of the base product; hosted and self-hosted remediation differed.
**Defensive synthesis (inferred):** Use structured process APIs and independently validate path containment and every option/argument contract.
**Technique owners:** [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md)

## B051

**Source:** [Microsoft Azure Account Takeover via DOM-based XSS in Cosmos DB Explorer](https://starlabs.sg/blog/2023/02-microsoft-azure-account-takeover-via-dom-based-xss-in-cosmos-db-explorer/)
**Research type:** Message-origin and DOM-sink source audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Incorrect Origin Check](https://starlabs.sg/blog/2023/02-microsoft-azure-account-takeover-via-dom-based-xss-in-cosmos-db-explorer/#incorrect-origin-check); [DOM-based XSS](https://starlabs.sg/blog/2023/02-microsoft-azure-account-takeover-via-dom-based-xss-in-cosmos-db-explorer/#dom-based-xss); [Recommendations](https://starlabs.sg/blog/2023/02-microsoft-azure-account-takeover-via-dom-based-xss-in-cosmos-db-explorer/#recommendations)

**Method observations (source-reported):**
- Origin allowlisting used regex characters with broader meaning than intended host syntax.
- Message-shape and field-presence checks did not guarantee HTML safety at the DOM sink.
- CSP and authenticated-user interaction affected the reported security consequence.

**Limits / failed assumptions:** The reported identity consequence required an authenticated session and interaction; it is not a universal unauthenticated takeover claim.
**Defensive synthesis (inferred):** Use exact parsed origin comparison and contextual rendering; test sender trust, branch reachability, and CSP together.
**Technique owners:** [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md)

## B053

**Source:** [Gotta KEP-tcha 'Em All - Bypassing Anti-Debugging methods in KEPServerEX](https://starlabs.sg/blog/2023/02-gotta-kep-tcha-em-all-bypassing-anti-debugging-methods-in-kepserverex/)
**Research type:** Instrumentation-environment diagnosis and snapshot-harness failure
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Anti-debuger and anti attach](https://starlabs.sg/blog/2023/02-gotta-kep-tcha-em-all-bypassing-anti-debugging-methods-in-kepserverex/#anti-debuger-and-anti-attach); [Checking of file signature](https://starlabs.sg/blog/2023/02-gotta-kep-tcha-em-all-bypassing-anti-debugging-methods-in-kepserverex/#checking-of-file-signature); [Hiding the Debugger](https://starlabs.sg/blog/2023/02-gotta-kep-tcha-em-all-bypassing-anti-debugging-methods-in-kepserverex/#hiding-the-debugger); [Bonus](https://starlabs.sg/blog/2023/02-gotta-kep-tcha-em-all-bypassing-anti-debugging-methods-in-kepserverex/#bonus)

**Method observations (source-reported):**
- Crash dumps and Procmon distinguished debugger detection, file-signature rejection, and hidden-thread breakpoint failures.
- Each environmental obstacle needed separate explanation; an initial local patch did not solve all failures.
- The snapshot-fuzzing input failed to preserve sequential partial network reads.

**Limits / failed assumptions:** The published anti-debug patch code is not included or prescribed. Modified binaries are diagnostic artifacts and must not establish unmodified-target security claims.
**Defensive synthesis (inferred):** Maintain an instrumentation change ledger, verify normal behavior afterward, and preserve real receive/framing semantics in harnesses.
**Technique owners:** [dynamic-analysis](../skills/dynamic-analysis/SKILL.md), [fuzzing](../skills/fuzzing/SKILL.md)

## B054

**Source:** [Dissecting the Vulnerabilities - A Comprehensive Teardown of acmailer's N-Days](https://starlabs.sg/blog/2023/02-dissecting-the-vulnerabilities-a-comprehensive-teardown-of-acmailers-n-days/)
**Research type:** Source N-day, setup/deprecated-feature, and patch review
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Root Cause Analysis of CVE-2021-20617:](https://starlabs.sg/blog/2023/02-dissecting-the-vulnerabilities-a-comprehensive-teardown-of-acmailers-n-days/#root-cause-analysis-of-cve-2021-20617); [Patch Analysis for CVE-2021-20617:](https://starlabs.sg/blog/2023/02-dissecting-the-vulnerabilities-a-comprehensive-teardown-of-acmailers-n-days/#patch-analysis-for-cve-2021-20617); [Suggested Mitigations for CVE-2021-20617:](https://starlabs.sg/blog/2023/02-dissecting-the-vulnerabilities-a-comprehensive-teardown-of-acmailers-n-days/#suggested-mitigations-for-cve-2021-20617); [Detection Guidance for CVE-2021-20617:](https://starlabs.sg/blog/2023/02-dissecting-the-vulnerabilities-a-comprehensive-teardown-of-acmailers-n-days/#detection-guidance-for-cve-2021-20617)

**Method observations (source-reported):**
- The audit traced request input into external commands and setup-related file writes.
- Patch review distinguished a sufficient narrow escaping/check combination from a robust API redesign.
- Deprecated/setup functionality removal and post-install access-log review were defensive lessons; character encoding complicated testing.

**Limits / failed assumptions:** Automated reproduction scripts and their success messages are not carried into this library. Runtime and encoding details remain target-specific prerequisites.
**Defensive synthesis (inferred):** Remove setup/deprecated surfaces automatically and prefer non-shell APIs over layered ad hoc quote filtering.
**Technique owners:** [remediation](../skills/remediation/SKILL.md)

## B055

**Source:** [Deconstructing and Exploiting CVE-2020-6418](https://starlabs.sg/blog/2022/12-deconstructing-and-exploiting-cve-2020-6418/)
**Research type:** JIT effect-inference patch reconstruction and graph comparison
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Background](https://starlabs.sg/blog/2022/12-deconstructing-and-exploiting-cve-2020-6418/#background); [Root Cause Analysis](https://starlabs.sg/blog/2022/12-deconstructing-and-exploiting-cve-2020-6418/#root-cause-analysis); [Exploitation](https://starlabs.sg/blog/2022/12-deconstructing-and-exploiting-cve-2020-6418/#exploitation)

**Method observations (source-reported):**
- Patch inspection identified a special-case effect handler that failed to invalidate map/shape reliability despite possible side effects.
- Turbolizer graph comparisons showed guard differences between reconstructed-vulnerable and corrected behavior.
- Runtime GC and optimization changed observed object/layout assumptions, complicating tests.

**Limits / failed assumptions:** The author recreated an old defect in a newer revision; this does not prove that the unmodified newer release was vulnerable. Some explanations for additional guards were tentative.
**Defensive synthesis (inferred):** Use conservative effect invalidation when alias/escape analysis is insufficient and validate emitted guards and runtime transitions.
**Technique owners:** [compiler-invariant-auditing](../skills/compiler-invariant-auditing/SKILL.md)

## B056

**Source:** [The Last Breath of Our Netgear RAX30 Bugs - A Tragic Tale before Pwn2Own Toronto 2022](https://starlabs.sg/blog/2022/12-the-last-breath-of-our-netgear-rax30-bugs-a-tragic-tale-before-pwn2own-toronto-2022/)
**Research type:** Firmware listener/input and horizontal patch audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [DHCP command injection](https://starlabs.sg/blog/2022/12-the-last-breath-of-our-netgear-rax30-bugs-a-tragic-tale-before-pwn2own-toronto-2022/#dhcp-command-injection); [Patch analysis for DHCP command injection](https://starlabs.sg/blog/2022/12-the-last-breath-of-our-netgear-rax30-bugs-a-tragic-tale-before-pwn2own-toronto-2022/#patch-analysis-for-dhcp-command-injection); [WAN exploitation chain](https://starlabs.sg/blog/2022/12-the-last-breath-of-our-netgear-rax30-bugs-a-tragic-tale-before-pwn2own-toronto-2022/#wan-exploitation-chain); [Patch analysis WAN bugs](https://starlabs.sg/blog/2022/12-the-last-breath-of-our-netgear-rax30-bugs-a-tragic-tale-before-pwn2own-toronto-2022/#patch-analysis-wan-bugs)

**Method observations (source-reported):**
- Firmware extraction, listener/traffic review, and source-to-execution tracing found surfaces outside the admin panel.
- A candidate argument was safely constrained by conversion from binary bytes to fixed-format text, rejecting an overbroad injection assumption.
- Shell-to-structured execution changes, TLS settings, and alternate update paths were examined together.

**Limits / failed assumptions:** A time-manipulation idea failed and some update-timing outcomes were speculative. The article's credentials and published chain are excluded.
**Defensive synthesis (inferred):** Prove final input alphabets, verify TLS/update authenticity, and inspect all sibling products and downstream parsers.
**Technique owners:** [data-flow-analysis](../skills/data-flow-analysis/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [remediation](../skills/remediation/SKILL.md)

## B057

**Source:** [TheHole New World - how a small leak will sink a great browser (CVE-2021-38003)](https://starlabs.sg/blog/2022/12-thehole-new-world-how-a-small-leak-will-sink-a-great-browser-cve-2021-38003/)
**Research type:** Exception-state invariant and runtime-mitigation analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Deep Dive into the Vulnerability](https://starlabs.sg/blog/2022/12-thehole-new-world-how-a-small-leak-will-sink-a-great-browser-cve-2021-38003/#deep-dive-into-the-vulnerability); [Proof-of-Concept Analysis](https://starlabs.sg/blog/2022/12-thehole-new-world-how-a-small-leak-will-sink-a-great-browser-cve-2021-38003/#proof-of-concept-analysis); [The patch](https://starlabs.sg/blog/2022/12-thehole-new-world-how-a-small-leak-will-sink-a-great-browser-cve-2021-38003/#the-patch)

**Method observations (source-reported):**
- An exceptional return lacked initialized pending-exception state, exposing an internal sentinel to ordinary language processing.
- Patch review covered both exception-state validation and a later container-key guard.
- A memory region's apparent executable/writable metadata did not override separate protection-key enforcement.

**Limits / failed assumptions:** The demonstrated browser run used a disabled sandbox; renderer execution is not an independently demonstrated sandbox escape. Other ways to expose a sentinel remain possibilities.
**Defensive synthesis (inferred):** Maintain exceptional-return state invariants and keep internal sentinels unobservable; validate every mitigation layer.
**Technique owners:** [compiler-invariant-auditing](../skills/compiler-invariant-auditing/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md)

## B058

**Source:** [Multiple Vulnerabilities in Proxmox VE & Proxmox Mail Gateway](https://starlabs.sg/blog/2022/12-multiple-vulnerabilities-in-proxmox-ve-proxmox-mail-gateway/)
**Research type:** Deployed-code location, alternate-format, and backend-policy audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Locating the source code](https://starlabs.sg/blog/2022/12-multiple-vulnerabilities-in-proxmox-ve-proxmox-mail-gateway/#locating-the-source-code); [Setting up debug environment](https://starlabs.sg/blog/2022/12-multiple-vulnerabilities-in-proxmox-ve-proxmox-mail-gateway/#setting-up-debug-environment); [Bug 0x01: Post-auth XSS in API inspector](https://starlabs.sg/blog/2022/12-multiple-vulnerabilities-in-proxmox-ve-proxmox-mail-gateway/#bug-0x01-post-auth-xss-in-api-inspector); [Bug 0x03: Post-auth SSRF + LFI + Privilege Escalation](https://starlabs.sg/blog/2022/12-multiple-vulnerabilities-in-proxmox-ve-proxmox-mail-gateway/#bug-0x03-post-auth-ssrf--lfi--privilege-escalation)

**Method observations (source-reported):**
- Listener-to-process-to-module mapping found deployed source, and the debugger matched the target language runtime.
- An alternate response formatter introduced an output-context difference missed by default JSON-only testing.
- Destination checks and constructed URLs disagreed; a response influenced file access, whose actual service identity constrained readable data.
- Backup permissions exposed a secret unavailable through the original protected file.

**Limits / failed assumptions:** The stronger consequence required existing backup state and relevant roles; browser newline behavior was not uniform across tested implementations.
**Defensive synthesis (inferred):** Audit response representations, final destinations, file-consumer identity, and backup permissions independently.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [authorization-auditing](../skills/authorization-auditing/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [remediation](../skills/remediation/SKILL.md)

## B059

**Source:** [Microsoft SharePoint Server Post-Authentication Server-Side Request Forgery vulnerability](https://starlabs.sg/blog/2022/10-microsoft-sharepoint-server-post-authentication-server-side-request-forgery-vulnerability/)
**Research type:** Authenticated outbound-request source audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Overview](https://starlabs.sg/blog/2022/10-microsoft-sharepoint-server-post-authentication-server-side-request-forgery-vulnerability/#overview); [Description of the Vulnerability](https://starlabs.sg/blog/2022/10-microsoft-sharepoint-server-post-authentication-server-side-request-forgery-vulnerability/#description-of-the-vulnerability); [Attack Conditions & Constraints](https://starlabs.sg/blog/2022/10-microsoft-sharepoint-server-post-authentication-server-side-request-forgery-vulnerability/#attack-conditions--constraints)

**Method observations (source-reported):**
- Required-header checks did not constrain user-controlled outbound destinations, methods, or bodies.
- A controlled callback demonstrated request reachability; response visibility depended on status handling.
- The article reports a fix without satisfying the criteria used for an advisory identifier.

**Limits / failed assumptions:** Authentication and site access were prerequisites. Internal-network scanning was discussed rather than demonstrated, and XML validation is not established by the page.
**Defensive synthesis (inferred):** Constrain parsed destinations across redirects and egress; do not use advisory status as proof of safety.
**Technique owners:** [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [remediation](../skills/remediation/SKILL.md)

## B060

**Source:** [Apple CoreText - An Unexpected Journey to Learn about Failure](https://starlabs.sg/blog/2022/09-apple-coretext-an-unexpected-journey-to-learn-about-failure/)
**Research type:** Coverage-led binary reconstruction and failed-hypothesis research
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [1. Attack Surface](https://starlabs.sg/blog/2022/09-apple-coretext-an-unexpected-journey-to-learn-about-failure/#1-attack-surface); [1 Oct 2021](https://starlabs.sg/blog/2022/09-apple-coretext-an-unexpected-journey-to-learn-about-failure/#1-oct-2021); [20 Oct 2021](https://starlabs.sg/blog/2022/09-apple-coretext-an-unexpected-journey-to-learn-about-failure/#20-oct-2021); [26 Oct 2021](https://starlabs.sg/blog/2022/09-apple-coretext-an-unexpected-journey-to-learn-about-failure/#26-oct-2021); [2. Details of Vulnerability](https://starlabs.sg/blog/2022/09-apple-coretext-an-unexpected-journey-to-learn-about-failure/#2-details-of-vulnerability)

**Method observations (source-reported):**
- Added checks were initially uninterpretable without undocumented structures; LLDB and targeted coverage guided reconstruction.
- Text-language and format-feature choices changed which shaping code executed.
- A text-only fuzzing campaign found no bug but supplied useful coverage; keeping the structural font input fixed left important dimensions unexplored.
- Documentation and an open-source analogous implementation helped refine hypotheses.

**Limits / failed assumptions:** Absence of fuzzing findings was not evidence of safety. The long exploitation experiments are not reproduced; only investigation, coverage, and assumption lessons are retained.
**Defensive synthesis (inferred):** Alternate documentation, coverage, and code review; mutate the dimensions relevant to the invariant and preserve failed approaches.
**Technique owners:** [dynamic-analysis](../skills/dynamic-analysis/SKILL.md), [fuzzing](../skills/fuzzing/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md)

## B061

**Source:** [Step-by-Step Walkthrough of CVE-2022-32792 - WebKit B3ReduceStrength Out-of-Bounds Write](https://starlabs.sg/blog/2022/09-step-by-step-walkthrough-of-cve-2022-32792-webkit-b3reducestrength-out-of-bounds-write/)
**Research type:** JIT numeric-range transfer and representation analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Code Understanding](https://starlabs.sg/blog/2022/09-step-by-step-walkthrough-of-cve-2022-32792-webkit-b3reducestrength-out-of-bounds-write/#code-understanding); [Patch Analysis](https://starlabs.sg/blog/2022/09-step-by-step-walkthrough-of-cve-2022-32792-webkit-b3reducestrength-out-of-bounds-write/#patch-analysis); [Proof-Of-Concept](https://starlabs.sg/blog/2022/09-step-by-step-walkthrough-of-cve-2022-32792-webkit-b3reducestrength-out-of-bounds-write/#proof-of-concept); [OOB Read Crash :D](https://starlabs.sg/blog/2022/09-step-by-step-walkthrough-of-cve-2022-32792-webkit-b3reducestrength-out-of-bounds-write/#oob-read-crash-d)

**Method observations (source-reported):**
- Reference searches localized a range-analysis helper and its consumers to a compiler phase.
- Standalone cast experiments and patch review examined interval soundness across sign extension.
- IR/dump/log comparison connected actual representation, inferred bounds, and optimization decisions.
- Unknown/Phi facts and unexpected Double representation blocked initial hypotheses.

**Limits / failed assumptions:** Diagnostic shell functions did not prove browser usability; some representation explanations remained tentative. The skill retains no source-language trigger or primitive construction.
**Defensive synthesis (inferred):** Keep transfer functions sound, use conservative unknown states, and test ranges and representations across phase boundaries.
**Technique owners:** [compiler-invariant-auditing](../skills/compiler-invariant-auditing/SKILL.md)

## B062

**Source:** [Exploiting WebKit JSPropertyNameEnumerator Out-of-Bounds Read (CVE-2021-1789)](https://starlabs.sg/blog/2022/08-exploiting-webkit-jspropertynameenumerator-out-of-bounds-read-cve-2021-1789/)
**Research type:** Enumeration snapshot and state-changing callback analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [For…in loop](https://starlabs.sg/blog/2022/08-exploiting-webkit-jspropertynameenumerator-out-of-bounds-read-cve-2021-1789/#forin-loop); [The Vulnerability](https://starlabs.sg/blog/2022/08-exploiting-webkit-jspropertynameenumerator-out-of-bounds-read-cve-2021-1789/#the-vulnerability); [WebKit Garbage Collector](https://starlabs.sg/blog/2022/08-exploiting-webkit-jspropertynameenumerator-out-of-bounds-read-cve-2021-1789/#webkit-garbage-collector)

**Method observations (source-reported):**
- Bytecode/slow-fast path review traced cached enumeration state into direct reads.
- Potentially state-changing callbacks occurred between collecting counts and constructing the enumerator, without the necessary count revalidation.
- Garbage-collector state and conservative scanning constrained runtime object assumptions.

**Limits / failed assumptions:** The article pins an old engine revision and does not establish a patch-diff workflow; historical behavior is not current exposure.
**Defensive synthesis (inferred):** Revalidate cached bounds/identity after callbacks and understand collector lifetime before interpreting object observations.
**Technique owners:** [compiler-invariant-auditing](../skills/compiler-invariant-auditing/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B063

**Source:** [Gitlab Project Import RCE Analysis (CVE-2022-2185)](https://starlabs.sg/blog/2022/07-gitlab-project-import-rce-analysis-cve-2022-2185/)
**Research type:** Asynchronous import-pipeline patch and controllability audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [ENVIRONMENT SETUP & DEBUGGING](https://starlabs.sg/blog/2022/07-gitlab-project-import-rce-analysis-cve-2022-2185/#environment-setup--debugging); [CVE-2022-2185 ANALYSIS](https://starlabs.sg/blog/2022/07-gitlab-project-import-rce-analysis-cve-2022-2185/#cve-2022-2185-analysis)

**Method observations (source-reported):**
- A matching development environment and worker debugging connected incoming data to transformation and project creation.
- Patch review and caller enumeration led through sanitizing and key-conversion pipeline stages.
- Request history and isolated unit tests made investigation cheaper than repeated full-service runs.
- Generated filenames and unmet scheduling gates rejected initially promising candidates.

**Limits / failed assumptions:** The development kit differed from product validation, and some checks were disabled for debugging. Intermittent workers/breakpoints and crashes limited observation; these changes cannot prove production reachability.
**Defensive synthesis (inferred):** Compare allowlisting and type normalization across pipeline stages and corroborate every control/scheduling prerequisite.
**Technique owners:** [data-flow-analysis](../skills/data-flow-analysis/SKILL.md), [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [source-code-auditing](../skills/source-code-auditing/SKILL.md)

## B064

**Source:** [io_uring - new code, new bugs, and a new exploit technique](https://starlabs.sg/blog/2022/06-io_uring-new-code-new-bugs-and-a-new-exploit-technique/)
**Research type:** Recent-feature selection arithmetic and reservation-race audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Provided buffers](https://starlabs.sg/blog/2022/06-io_uring-new-code-new-bugs-and-a-new-exploit-technique/#provided-buffers); [io_uring bug hunting](https://starlabs.sg/blog/2022/06-io_uring-new-code-new-bugs-and-a-new-exploit-technique/#io_uring-bug-hunting); [Conclusion](https://starlabs.sg/blog/2022/06-io_uring-new-code-new-bugs-and-a-new-exploit-technique/#conclusion)

**Method observations (source-reported):**
- N-day understanding directed review toward recent buffer-selection changes.
- Index-to-page arithmetic was checked against concrete buffer boundaries.
- Selection versus completion timing allowed concurrent requests to share a buffer; masking still bounded the index.

**Limits / failed assumptions:** The author demonstrated corrupted reads but did not determine security impact and did not fully understand the maintainer's fix. The library makes no stronger memory-corruption claim.
**Defensive synthesis (inferred):** Reserve before publication/dispatch and distinguish data races from proven security effects; verify fix semantics rather than relying on its existence.
**Technique owners:** [race-condition-auditing](../skills/race-condition-auditing/SKILL.md), [source-code-auditing](../skills/source-code-auditing/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B065

**Source:** [Trying To Exploit A Windows Kernel Arbitrary Read Vulnerability](https://starlabs.sg/blog/2022/06-trying-to-exploit-a-windows-kernel-arbitrary-read-vulnerability/)
**Research type:** Unfinished kernel-disclosure impact and failed-assumption study
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Exploitation](https://starlabs.sg/blog/2022/06-trying-to-exploit-a-windows-kernel-arbitrary-read-vulnerability/#exploitation); [Trying to achieve LPE](https://starlabs.sg/blog/2022/06-trying-to-exploit-a-windows-kernel-arbitrary-read-vulnerability/#trying-to-achieve-lpe); [What is missing ?](https://starlabs.sg/blog/2022/06-trying-to-exploit-a-windows-kernel-arbitrary-read-vulnerability/#what-is-missing-)

**Method observations (source-reported):**
- Debugger paths, object-model references, and structure inspection tested whether a read primitive reached desired data.
- A file-associated object was not equivalent to direct file-content access; newer address-space placement invalidated an older assumption.
- Transient data, concurrency, and missing key material prevented the completed escalation hypothesis.

**Limits / failed assumptions:** The author explicitly did not complete an exploit and was uncertain about the assigned advisory identifier. Cross-address-space and key-acquisition possibilities were hypotheses, not demonstrated capabilities.
**Defensive synthesis (inferred):** Separate disclosure from escalation and record exact address-space, lifetime, and missing-capability constraints.
**Technique owners:** [exploitability-assessment](../skills/exploitability-assessment/SKILL.md)

## B066

**Source:** [New Wine in Old Bottle - Microsoft Sharepoint Post-Auth Deserialization RCE (CVE-2022-29108)](https://starlabs.sg/blog/2022/05-new-wine-in-old-bottle-microsoft-sharepoint-post-auth-deserialization-rce-cve-2022-29108/)
**Research type:** Shared-consumer deserialization variant and environment audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Environment Setup](https://starlabs.sg/blog/2022/05-new-wine-in-old-bottle-microsoft-sharepoint-post-auth-deserialization-rce-cve-2022-29108/#environment-setup); [Analysis](https://starlabs.sg/blog/2022/05-new-wine-in-old-bottle-microsoft-sharepoint-post-auth-deserialization-rce-cve-2022-29108/#analysis)

**Method observations (source-reported):**
- A prior binder restriction motivated caller searches for every consumer of shared binary-state retrieval.
- dnSpy Analyze exposed an alternate deserialization path not protected by the original change.
- Default disabled/absent services prevented initial reproduction; feature setup was a necessary gate.

**Limits / failed assumptions:** The author's setup observations were qualified; no comprehensive post-fix validation is shown and default reachability must not be assumed.
**Defensive synthesis (inferred):** Review all consumers and inherited callbacks of shared data, and separate environment failure from patch effectiveness.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md), [remediation](../skills/remediation/SKILL.md), [source-code-auditing](../skills/source-code-auditing/SKILL.md)

## B067

**Source:** [The Cat Escaped from the Chrome Sandbox](https://starlabs.sg/blog/2022/01-the-cat-escaped-from-the-chrome-sandbox/)
**Research type:** Privileged IPC state and nested-resource lifetime audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [A short glance at the Vulnerability](https://starlabs.sg/blog/2022/01-the-cat-escaped-from-the-chrome-sandbox/#a-short-glance-at-the-vulnerability); [Use-After-Free](https://starlabs.sg/blog/2022/01-the-cat-escaped-from-the-chrome-sandbox/#use-after-free); [Fullchain Exploit](https://starlabs.sg/blog/2022/01-the-cat-escaped-from-the-chrome-sandbox/#fullchain-exploit)

**Method observations (source-reported):**
- Transaction state and asynchronous callbacks were traced across browser services.
- A parent weak reference did not establish lifetime of a child object retained by a raw pointer.
- Browser-side state checks mattered even when renderer-side checks existed; later changes considered legitimate repeated requests and locally caused aborts.

**Limits / failed assumptions:** The demonstration needed manually generated/enabled bindings and fixed-address assumptions; stronger alternative primitives were possibilities, not universal guarantees.
**Defensive synthesis (inferred):** Validate state at the privileged consumer, hold child-resource lifetime correctly, and track transition provenance before blaming an IPC peer.
**Technique owners:** [remediation](../skills/remediation/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B068

**Source:** [Diving into Open-source LMS Codebases](https://starlabs.sg/blog/2021/11-diving-into-open-source-lms-codebases/)
**Research type:** Convention-aware source/sink review of large web codebases
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [The Approach](https://starlabs.sg/blog/2021/11-diving-into-open-source-lms-codebases/#the-approach); [Moodle](https://starlabs.sg/blog/2021/11-diving-into-open-source-lms-codebases/#moodle); [Chamilo - Cross Site Request Forgery (CSRF) leading to Remote Code Execution](https://starlabs.sg/blog/2021/11-diving-into-open-source-lms-codebases/#chamilo---cross-site-request-forgery-csrf-leading-to-remote-code-execution); [Moodle - Reflected XSS (CVE-2021-43558)](https://starlabs.sg/blog/2021/11-diving-into-open-source-lms-codebases/#moodle---reflected-xss-cve-2021-43558)

**Method observations (source-reported):**
- The audit learned framework input wrappers and ran complementary source-to-sink and sink-to-source sweeps.
- Raw input modes and output-context-specific escaping differed from generic sanitization.
- Configured replacement rules could undo earlier filename sanitization; control of those settings and separate root-directory execution policy remained gates. File operations could implicitly select format handlers and downstream object behavior.
- Role-specific storage and session prerequisites constrained capability composition.

**Limits / failed assumptions:** Implicit deserialization depends on the actual PHP/runtime/library version, not every modern file API. The original payloads, user manipulation, and published chains are not retained.
**Defensive synthesis (inferred):** Use typed/contextual contracts and test final composed transformations, not the number of sanitizer calls.
**Technique owners:** [authorization-auditing](../skills/authorization-auditing/SKILL.md), [data-flow-analysis](../skills/data-flow-analysis/SKILL.md), [deserialization-and-dispatch-auditing](../skills/deserialization-and-dispatch-auditing/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [remediation](../skills/remediation/SKILL.md), [source-code-auditing](../skills/source-code-auditing/SKILL.md)

## B069

**Source:** [Analysis of CVE-2021-1758 (CoreText Out-Of-Bounds Read)](https://starlabs.sg/blog/2021/09-analysis-of-cve-2021-1758-coretext-out-of-bounds-read/)
**Research type:** Coverage-guided binary parser and validation-consumption analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Understanding the Target](https://starlabs.sg/blog/2021/09-analysis-of-cve-2021-1758-coretext-out-of-bounds-read/#understanding-the-target); [Harness](https://starlabs.sg/blog/2021/09-analysis-of-cve-2021-1758-coretext-out-of-bounds-read/#harness); [Coverage](https://starlabs.sg/blog/2021/09-analysis-of-cve-2021-1758-coretext-out-of-bounds-read/#coverage); [Vulnerability](https://starlabs.sg/blog/2021/09-analysis-of-cve-2021-1758-coretext-out-of-bounds-read/#vulnerability); [POC](https://starlabs.sg/blog/2021/09-analysis-of-cve-2021-1758-coretext-out-of-bounds-read/#poc)

**Method observations (source-reported):**
- A small API harness, TinyInst coverage, and Lighthouse directed inspection to reachable parser paths.
- Exception breakpoints and documentation/disassembly comparison explained rejected inputs and byte/count interpretation.
- Early validation success and a later consumer's different metadata interpretation left an unchecked resource-name read; GuardMalloc corroborated an invalid access.

**Limits / failed assumptions:** GuardMalloc has blind spots. The reported fault establishes out-of-bounds reading, not independently demonstrated information disclosure or execution; performance comparisons were limited.
**Defensive synthesis (inferred):** Successful validation must cover every later span under identical field semantics; use coverage to interpret both acceptance and rejection.
**Technique owners:** [dynamic-analysis](../skills/dynamic-analysis/SKILL.md), [fuzzing](../skills/fuzzing/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md)

## B070

**Source:** [Identifying Bugs in Router Firmware at Scale with Taint Analysis](https://starlabs.sg/blog/2021/08-identifying-bugs-in-router-firmware-at-scale-with-taint-analysis/)
**Research type:** Architecture-aware binary taint automation and manual triage
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Existing Tools](https://starlabs.sg/blog/2021/08-identifying-bugs-in-router-firmware-at-scale-with-taint-analysis/#existing-tools); [Using angr symbolic execution](https://starlabs.sg/blog/2021/08-identifying-bugs-in-router-firmware-at-scale-with-taint-analysis/#using-angr-symbolic-execution); [Using angr’s Reaching Definition analysis](https://starlabs.sg/blog/2021/08-identifying-bugs-in-router-firmware-at-scale-with-taint-analysis/#using-angrs-reaching-definition-analysis); [DLink DIR-X1560](https://starlabs.sg/blog/2021/08-identifying-bugs-in-router-firmware-at-scale-with-taint-analysis/#dlink-dir-x1560); [Remarks](https://starlabs.sg/blog/2021/08-identifying-bugs-in-router-firmware-at-scale-with-taint-analysis/#remarks)

**Method observations (source-reported):**
- Architecture support ruled out initial tools; symbolic path explosion and memory cost failed the intended speed goal.
- Reaching Definitions and output-argument summaries converted influence questions into use-def graph traversal.
- Indirect object dispatch required manual reconstruction across abstraction layers; automated reports had substantial false positives.
- Fix review found that an alternate hardcoded credential had merely been replaced with another configuration-backed credential.

**Limits / failed assumptions:** Measured timings and hit rates belong to this custom tool/corpus, not universal benchmark claims. Graph dependence is candidate evidence, not path feasibility.
**Defensive synthesis (inferred):** Choose analysis for the required question and architecture, model indirect/output edges, manually validate feasibility, and test semantic fix variants.
**Technique owners:** [binary-auditing](../skills/binary-auditing/SKILL.md), [data-flow-analysis](../skills/data-flow-analysis/SKILL.md), [remediation](../skills/remediation/SKILL.md)

## B071

**Source:** [Simple Vulnerability Regression Monitoring with V8Harvest](https://starlabs.sg/blog/2021/06-simple-vulnerability-regression-monitoring-with-v8harvest/)
**Research type:** Regression-test provenance and release-gap monitoring
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Introduction](https://starlabs.sg/blog/2021/06-simple-vulnerability-regression-monitoring-with-v8harvest/#introduction); [How It Work](https://starlabs.sg/blog/2021/06-simple-vulnerability-regression-monitoring-with-v8harvest/#how-it-work)

**Method observations (source-reported):**
- Regression-test paths were associated with git history, issue references, review links, and commit order.
- Upstream fixes and downstream stable releases did not always arrive together.

**Limits / failed assumptions:** Public test availability does not prove a current downstream product is vulnerable; the article's regression snippets are not copied into this library.
**Defensive synthesis (inferred):** Use test history to identify invariants and verify the fix in actual downstream artifacts rather than operationalizing a release gap.
**Technique owners:** [compiler-invariant-auditing](../skills/compiler-invariant-auditing/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md)

## B072

**Source:** [You Talking To Me?](https://starlabs.sg/blog/2021/04-you-talking-to-me/)
**Research type:** Browser automation origin/transport differential analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Potential arbitrary file read via Chrome DevTools Protocol](https://starlabs.sg/blog/2021/04-you-talking-to-me/#potential-arbitrary-file-read-via-chrome-devtools-protocol); [Reinforced REST APIs](https://starlabs.sg/blog/2021/04-you-talking-to-me/#reinforced-rest-apis); [Splitting the body](https://starlabs.sg/blog/2021/04-you-talking-to-me/#splitting-the-body); [Takeaway](https://starlabs.sg/blog/2021/04-you-talking-to-me/#takeaway)

**Method observations (source-reported):**
- Control interfaces differed in Host, Origin, method, content-type, session, and local-listener policy.
- Documentation/source checks and actual browser constraints rejected some proposed cross-origin paths.
- Application logs and packet traces showed unexpected connection/framing behavior that static protocol assumptions missed.

**Limits / failed assumptions:** Historical browser implementations differed and one transport bug was fixed in a named old release. Browser content cannot be assumed to transmit arbitrary raw TCP bytes.
**Defensive synthesis (inferred):** Treat local control planes as privileged boundaries; validate origins/authority before processing and verify framing on every connection.
**Technique owners:** [dynamic-analysis](../skills/dynamic-analysis/SKILL.md), [parser-differential-auditing](../skills/parser-differential-auditing/SKILL.md), [sandbox-boundary-analysis](../skills/sandbox-boundary-analysis/SKILL.md)

## B073

**Source:** [Chrome 1-Day Hunting - Uncovering and Exploiting CVE-2020-15999](https://starlabs.sg/blog/2021/01-chrome-1-day-hunting-uncovering-and-exploiting-cve-2020-15999/)
**Research type:** Dependency-parser arithmetic and controllability assessment
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Vulnerability details](https://starlabs.sg/blog/2021/01-chrome-1-day-hunting-uncovering-and-exploiting-cve-2020-15999/#vulnerability-details); [Heap layout reliability](https://starlabs.sg/blog/2021/01-chrome-1-day-hunting-uncovering-and-exploiting-cve-2020-15999/#heap-layout-reliability); [Overflow content limitations](https://starlabs.sg/blog/2021/01-chrome-1-day-hunting-uncovering-and-exploiting-cve-2020-15999/#overflow-content-limitations); [Possible solutions](https://starlabs.sg/blog/2021/01-chrome-1-day-hunting-uncovering-and-exploiting-cve-2020-15999/#possible-solutions)

**Method observations (source-reported):**
- Component scoping localized a browser-adjacent defect to a font/image dependency rather than the browser core.
- Integer representations and image preprocessing affected buffer dimensions and controllable output bytes.
- Nondeterministic allocation could fault unrelated components, and a proposed alternative isolation strategy was not tested.

**Limits / failed assumptions:** The page does not establish a patch-diff narrowing workflow; layout and content constraints are specific to its historical environment.
**Defensive synthesis (inferred):** Audit complete decoded dimensions and transformations, and do not infer controlled consequences from unrelated crashes.
**Technique owners:** [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md)

## B074

**Source:** [Instrumenting Adobe Reader with Frida](https://starlabs.sg/blog/2020/11-instrumenting-adobe-reader-with-frida/)
**Research type:** Dynamic instrumentation methods tutorial
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Function Hooking](https://starlabs.sg/blog/2020/11-instrumenting-adobe-reader-with-frida/#function-hooking); [Memory Allocation and Parameter Manipulation](https://starlabs.sg/blog/2020/11-instrumenting-adobe-reader-with-frida/#memory-allocation-and-parameter-manipulation); [Cross Process Messaging and A Practical Example](https://starlabs.sg/blog/2020/11-instrumenting-adobe-reader-with-frida/#cross-process-messaging-and-a-practical-example); [Function Tracing and Frida Stalker](https://starlabs.sg/blog/2020/11-instrumenting-adobe-reader-with-frida/#function-tracing-and-frida-stalker)

**Method observations (source-reported):**
- Entry/exit hooks and decoded argument metadata revealed runtime contracts.
- Injected buffers needed retained script references to remain alive; encoding and pointer width were part of correct observation.
- Scoped Stalker tracing captured useful nested calls while limiting overhead.

**Limits / failed assumptions:** Offsets and example APIs are tied to an old application/tool version. This skill uses the technique and directs current API/version resolution, not the original scripts.
**Defensive synthesis (inferred):** Bound instrumentation reads, maintain observer-owned buffer lifetime, and trace only the unresolved question.
**Technique owners:** [dynamic-analysis](../skills/dynamic-analysis/SKILL.md)

## B075

**Source:** [Analysis & Exploitation of a Recent TP-Link Archer A7 Vulnerability](https://starlabs.sg/blog/2020/10-analysis-exploitation-of-a-recent-tp-link-archer-a7-vulnerability/)
**Research type:** Firmware binary comparison and on-device debugging
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Good ol Strings](https://starlabs.sg/blog/2020/10-analysis-exploitation-of-a-recent-tp-link-archer-a7-vulnerability/#good-ol-strings); [Finding the system() Call](https://starlabs.sg/blog/2020/10-analysis-exploitation-of-a-recent-tp-link-archer-a7-vulnerability/#finding-the-system-call); [Setup GDB server](https://starlabs.sg/blog/2020/10-analysis-exploitation-of-a-recent-tp-link-archer-a7-vulnerability/#setup-gdb-server); [Packet Under The Microscope](https://starlabs.sg/blog/2020/10-analysis-exploitation-of-a-recent-tp-link-archer-a7-vulnerability/#packet-under-the-microscope); [Calculating The Checksum](https://starlabs.sg/blog/2020/10-analysis-exploitation-of-a-recent-tp-link-archer-a7-vulnerability/#calculating-the-checksum)

**Method observations (source-reported):**
- Binary comparison and diagnostic-string references narrowed changes; not every low-similarity match was a function.
- Architecture/endianness-matched gdbserver and logs checked checksum, length, acceptance, and sink argument paths on the device.
- Related models shared many binaries but were not assumed wholly identical.

**Limits / failed assumptions:** The wording about system calls refers to a shell-execution function in context, not arbitrary kernel syscall exposure. The exact packet and command recipe is excluded.
**Defensive synthesis (inferred):** Corroborate binary-diff candidates with real controllability and apply structured execution/input contracts across shared product code.
**Technique owners:** [binary-auditing](../skills/binary-auditing/SKILL.md), [dynamic-analysis](../skills/dynamic-analysis/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md)

## B076

**Source:** [Pwn2Own 2020: Oracle VirtualBox Escape](https://starlabs.sg/blog/2020/09-pwn2own-2020-oracle-virtualbox-escape/)
**Research type:** Emulated-device range and reallocation-initialization audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [E1000 Out-Of-Bounds Read Vulnerability](https://starlabs.sg/blog/2020/09-pwn2own-2020-oracle-virtualbox-escape/#e1000-out-of-bounds-read-vulnerability); [OHCI Controller Uninitialized Variable](https://starlabs.sg/blog/2020/09-pwn2own-2020-oracle-virtualbox-escape/#ohci-controller-uninitialized-variable)

**Method observations (source-reported):**
- Several local range checks did not establish the full checksum span stayed within packet capacity.
- Reallocation left fields uninitialized before later asynchronous dispatch dereferenced them.

**Limits / failed assumptions:** No particular audit/debug tool is named in the page. The published disclosure/execution construction and neighboring layout are not retained.
**Defensive synthesis (inferred):** Check complete accessed ranges and initialize every newly exposed field before publishing asynchronous work.
**Technique owners:** [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md)

## B077

**Source:** [This Font is not Your Type](https://starlabs.sg/blog/2020/09-this-font-is-not-your-type/)
**Research type:** Binary font-argument-count validation audit
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [The Root Cause](https://starlabs.sg/blog/2020/09-this-font-is-not-your-type/#the-root-cause); [Conclusion](https://starlabs.sg/blog/2020/09-this-font-is-not-your-type/#conclusion)

**Method observations (source-reported):**
- Disassembly and format tools compared the full required operand-count expression with a partial multiplication-only check.
- Debugger observations connected attacker-derived counts with accesses beyond the stack-buffer extent.

**Limits / failed assumptions:** The demonstrated parser fault and historical fix do not establish every font-path impact or current exposure; no object-lifetime defect is shown.
**Defensive synthesis (inferred):** Validate the complete arithmetic expression, including omitted additive terms, before consuming operands.
**Technique owners:** [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md)

## B078

**Source:** [ASUSWRT URL Processing Stack Buffer Overflow](https://starlabs.sg/blog/2020/08-asuswrt-url-processing-stack-buffer-overflow/)
**Research type:** Firmware patch comparison and debugger-environment diagnosis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Bin-Diffing](https://starlabs.sg/blog/2020/08-asuswrt-url-processing-stack-buffer-overflow/#bin-diffing); [Debugging In GDB](https://starlabs.sg/blog/2020/08-asuswrt-url-processing-stack-buffer-overflow/#debugging-in-gdb); [Fixing SIGILL](https://starlabs.sg/blog/2020/08-asuswrt-url-processing-stack-buffer-overflow/#fixing-sigill); [Conclusion](https://starlabs.sg/blog/2020/08-asuswrt-url-processing-stack-buffer-overflow/#conclusion)

**Method observations (source-reported):**
- Firmware extraction and binary diffing isolated length validation in URL processing.
- Architecture-matched debugging corroborated overwritten memory and input transformations.
- An expected unsupported-instruction probe caused a debugger startup obstacle rather than an application security bug.

**Limits / failed assumptions:** Diagnostic environment changes must be logged and do not establish equivalent security behavior in production. The original control-flow and gadget steps are omitted.
**Defensive synthesis (inferred):** Bound processing before writing to fixed buffers and distinguish target flaws from tool/library startup behavior.
**Technique owners:** [binary-auditing](../skills/binary-auditing/SKILL.md), [dynamic-analysis](../skills/dynamic-analysis/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md), [patch-diff-analysis](../skills/patch-diff-analysis/SKILL.md)

## B079

**Source:** [Oracle VirtualBox VHWA Use-After-Free Privilege Escalation Vulnerability](https://starlabs.sg/blog/2020/06-oracle-virtualbox-vhwa-use-after-free-privilege-escalation-vulnerability/)
**Research type:** Debug-build reachability and shared-reference lifetime investigation
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Getting an infoleak](https://starlabs.sg/blog/2020/06-oracle-virtualbox-vhwa-use-after-free-privilege-escalation-vulnerability/#getting-an-infoleak); [DLL infoleak](https://starlabs.sg/blog/2020/06-oracle-virtualbox-vhwa-use-after-free-privilege-escalation-vulnerability/#dll-infoleak)

**Method observations (source-reported):**
- A non-hardened symbolized build and debugger traces made the command handler observable.
- A registry/table retained a reference after another ownership path replaced and freed the object.
- Inlining/macros made a decompiler useful; invalid traversal and corrupted metadata caused collateral host failures.

**Limits / failed assumptions:** Debug-build visibility is not proof that release hardening permits the same instrumentation. The memory layouts and original construction are excluded; stable cleanup was not established.
**Defensive synthesis (inferred):** Revoke all table/borrower references when replacing owned resources and verify correspondence with optimized binaries.
**Technique owners:** [binary-auditing](../skills/binary-auditing/SKILL.md), [exploitability-assessment](../skills/exploitability-assessment/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B080

**Source:** [TianFu Cup 2019: Adobe Reader Exploitation](https://starlabs.sg/blog/2020/04-tianfu-cup-2019-adobe-reader-exploitation/)
**Research type:** Allocator provenance and observation-constraint analysis
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [Vulnerability](https://starlabs.sg/blog/2020/04-tianfu-cup-2019-adobe-reader-exploitation/#vulnerability)

**Method observations (source-reported):**
- Debugger heap and address-region queries distinguished freed heap storage from other allocation mechanisms.
- Freed bytes could persist, while incomplete field knowledge and mitigation constraints limited interpretation.

**Limits / failed assumptions:** The article does not demonstrate the reentrancy methodology its vulnerability class might suggest; this library retains only observed allocation/provenance reasoning, not the published exploitation construction.
**Defensive synthesis (inferred):** Use allocation history and valid lifetime evidence, not residual bytes alone, when interpreting a stale-memory observation.
**Technique owners:** [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md), [state-and-lifetime-auditing](../skills/state-and-lifetime-auditing/SKILL.md)

## B081

**Source:** [Adventures in Hypervisor: Oracle VirtualBox Research](https://starlabs.sg/blog/2020/04-adventures-in-hypervisor-oracle-virtualbox-research/)
**Research type:** Hypervisor source-surface discovery and harness construction
**Evidence level:** method-sections-inspected; reported runtime results not independently reproduced.
**Locators:** [RT_UNTRUSTED_VOLATILE_GUEST Keyword](https://starlabs.sg/blog/2020/04-adventures-in-hypervisor-oracle-virtualbox-research/#rt_untrusted_volatile_guest-keyword); [Guest’s Physical Memory Read/Write Handlers](https://starlabs.sg/blog/2020/04-adventures-in-hypervisor-oracle-virtualbox-research/#guests-physical-memory-readwrite-handlers); [Dumb Fuzzing](https://starlabs.sg/blog/2020/04-adventures-in-hypervisor-oracle-virtualbox-research/#dumb-fuzzing); [Coverage Guided Fuzzing](https://starlabs.sg/blog/2020/04-adventures-in-hypervisor-oracle-virtualbox-research/#coverage-guided-fuzzing)

**Method observations (source-reported):**
- Untrusted/shared-data annotations, device registrations, and guest-memory transfer helpers selected high-yield source slices.
- Transfer direction and size determined whether a host operation could overwrite or disclose memory.
- Recorded valid device inputs, input-boundary substitution, per-iteration reset, and coverage-guided execution made a complex device consumer fuzzable.

**Limits / failed assumptions:** Custom non-hardened builds and substituted inputs change the environment; later fixed-address and allocation recipes are not generalized or retained.
**Defensive synthesis (inferred):** Validate host/guest transfer bounds and snapshot semantics, and prove harness/reset equivalence before accepting a finding.
**Technique owners:** [attack-surface-mapping](../skills/attack-surface-mapping/SKILL.md), [fuzzing](../skills/fuzzing/SKILL.md), [memory-safety-auditing](../skills/memory-safety-auditing/SKILL.md)
