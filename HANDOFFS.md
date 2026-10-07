# Research Handoff Contracts

Shared by all skills. A handoff is an evidence packet, not a claim of completion. Use only authorized artifacts and benign test designs; do not copy a source exploit sequence. A consumer rejects a packet missing its required fields and returns a specific unanswered question.

## Common envelope

Every packet includes:

- **Scope:** authorization, target/artifact hashes, revision/build/runtime, configuration, actor/privileges, intended boundary, isolation/recovery constraints.
- **Question:** one falsifiable unresolved question; expected observation if true and if false.
- **Evidence:** file/symbol/section references, trace or test artifact paths and hashes, collection method, timestamps, original versus modified environment. For analyzer output, include tool/version/options, requested versus recovered functions/ranges, truncation, errors, and unresolved coverage; exit status alone is insufficient.
- **Classification:** independently observed fact, static inference, source-author report, hypothesis, defensive recommendation, or unresolved. Never silently upgrade a classification.
- **Limits:** negative controls, failed assumptions, reproduction denominator, untested versions/routes, observer effects, residual risks.
- **Next action:** a bounded observation or review and its stop condition; no vague request to “exploit it”.

Use [templates/handoff.json](templates/handoff.json) as a recording scaffold. A consumer must fill missing information, not interpret empty arrays as proof.

### Runtime evidence envelope

During P2O assessments, cite owner-generated receipt IDs rather than inventing artifact identifiers. Use
`p2o_ledger` with a record ID to inspect a worker's bounded observation. Record closure separately from execution
state and proof level through `p2o_candidate`: source traces, offline reproductions and live reproductions are
not interchangeable. State intended-policy provenance (`explicit_contract`, `boundary_invariant`, or `inferred`);
an inferred policy remains an open proof gap. Revisions name the superseded candidate ID, and evidence-backed
closure may resolve named open-item IDs without erasing their history. Independent validation needs a different
worker's matching reproduction and its receipt; metadata alone does not prove the claim.

Choose `--export` before assessment to retain bounded redacted receipts and hashes after cleanup. Without export,
temporary scratch and the ledger are removed. Redaction is best effort; review before sharing.

### Provisional owner review

If an authorized investigation finds unexpected artifacts suggesting a pre-existing incident, stop expanding access and notify the authorized owner/responder. Use the common envelope with minimized, redacted diagnostic/artifact references, collection time/method and integrity provenance, explicit attribution/initial-access unknowns, permitted preservation and containment scope. Do not use credentials or test wider access to resolve attribution.

**Gate:** an authorized recipient and a traceable observation suffice for provisional review; no confirmed-impact prerequisite is invented. Conversely, suspicious artifacts and symptom-based containment do not establish root cause, H5 repair closure or deployment verification. Return missing authorization/provenance. This derived dynamic-observation → owner/remediation route draws on [O033](research/orange/evidence.md#o033); it is not the source's compromise sequence.

## H1 — Recon → Static Analysis

**Producer:** attack-surface mapping. **Consumer:** source/binary auditing.

Required additions: interface table with registration/handler locations; lowest reachable actor; gate results; process identity; input formats and benign accepted operations; architecture/load map if known; unresolved routes/features. For distributed services, include peer topology, identity origin, installation-derived membership and evidence of effective authority—not merely nominal group names.

**Acceptance gate:** at least one prioritized entry has evidence of its actual gate/handler, or is explicitly marked inferred with a proposed reachability check. Root-object access cannot stand in for descendant routes. UI behavior cannot stand in for backend policy.

**Return condition:** missing actor/configuration, unclear artifact provenance, or no reason for prioritization. Return the smallest missing surface question.

## H2 — Static Analysis → Dynamic Analysis

**Producer:** source/binary/data-flow/patch/invariant audit. **Consumer:** dynamic analysis.

Required additions: minimal slice; invariant; controllable fields/guarantees; state/permission constraints; unknown value/branch/lifetime; contrasting predictions; observation points and allowed instrumentation. For composition add representation/role/context changes, writers/readers, encoding, re-entry and terminal-state evidence. Include actual receiver/phase/guard, result/error conversions, cache key/consumer predicates, producer/delivery/display stages, worker/history/reset and transient-result latency where relevant; explicitly label inferred edges.

**Acceptance gate:** the experiment distinguishes hypotheses, reaches a known-good baseline, and can be run safely in the declared lab. A grep hit or alarming API name is not sufficient.

**Return condition:** both predictions produce the same observable result, the path's prerequisites are unknown, or only a modified build is available without disclosure. Return a narrower experiment design.

## H3 — Fuzzing → Manual Audit

**Producer:** fuzzing. **Consumer:** binary, memory, state/lifetime, or parser audit.

Required additions: seed lineage and hashes; minimized local input/operation-sequence artifact; initialization/reset state; harness versus real-target comparison; build/instrumentation; coverage and rejection-path evidence; sanitizer/crash logs; first invalid operation; allocation/free or transition context; repetitions and deduplication rationale.

**Acceptance gate:** the same invariant/fault reproduces from a saved seed under documented state, and the harness itself is not the sole failing component. Original and triage-modified runs remain separate.

**Return condition:** only a crash address, unexplained timeout, state leakage, or unrealistic framing. Return for harness repair, reproduction, or a targeted coverage check—not immediate impact development.

## H4 — Bug Discovery → Exploitability Assessment

**Producer:** any root-cause skill. **Consumer:** exploitability assessment and, if needed, sandbox-boundary analysis.

Required additions: invariant and earliest violation; constrained primitive (direction, width, controllability, repetition, address-space/lifetime); actor and feature/permission gates; actual mitigations; damage/recovery; evidence classification and missing capabilities. Mediated operations include fixed/controlled fields, framing/encoding, destination and protocol-state limits; layout claims include effective producer emission order/configuration, not trigger order.

**Acceptance gate:** evidence supports a reachable violation or explicitly bounds the analysis as static-only. The consumer may assess a hypothesis but must not present it as demonstrated impact. Capability-graph edges each need preconditions and evidence.

**Return condition:** blanket arbitrary-read/write label, a crash equated with execution, missing address-space context, or debug/security bypass hidden in the setup. Return for constraint characterization. Do not construct gadget/replacement-object chains.

## H5 — Root Cause → Remediation / Defensive Engineering

**Producer:** root-cause and impact assessment. **Consumer:** remediation.

Required additions: target-independent invariant; authoritative trusted enforcement point; all affected consumers and semantic variants; narrow justified impact; emergency exposure mitigation; accepted controls; rejected/bounded cases; role/feature/state/runtime matrix; proposed regression properties; source versus shipped-artifact gap; logging/redaction needs. Representation changes require entry/type/downstream compatibility coverage; identity restrictions require legitimate-peer controls at each consumer.

**Acceptance gate:** tests would distinguish root-cause repair from blocking one sample and would preserve normal behavior. Access restriction and unresolved underlying bugs are separately classified.

**Return condition:** trigger-only blacklist, no equivalent-path review, unverified shipped package, or no normal controls. Return the missing invariant/variant/deployment question.

## H6 — Engineering → Verification / Operations

Required additions: source change, actual package/build hashes, test receipts, deployment inventory, shipped-code versus active-enforcement evidence, compatibility-driven defaults and rollout/activation requirements, listener/membership changes, detection transport coverage, compatibility tradeoffs, secret-rotation scope if exposure is established, and residual risks.

**Acceptance gate:** deployed artifacts contain the assessed fix; accepted controls still work; forbidden classes are rejected/contained under original policy. Classify the result as **repaired**, **exposure mitigated**, **partially repaired**, or **unverified**. No closure based solely on an advisory, timeout, or source merge.

## Supplemental handoff provenance

The representation/phase, peer-authority and activation fields above adapt generic lessons from [O001](research/orange/evidence.md#o001), [O004](research/orange/evidence.md#o004), [O005](research/orange/evidence.md#o005), and [O008](research/orange/evidence.md#o008). These contracts are library synthesis, not claims that the authors used agents, these skill names or independently validated handoff packets.

Intermediary/client roles, cache contracts, phase guards, constrained requests, result meaning, observer comparability and coherent publication also derive from [O009](research/orange/evidence.md#o009), [O012](research/orange/evidence.md#o012), [O016](research/orange/evidence.md#o016), [O021](research/orange/evidence.md#o021), [O027](research/orange/evidence.md#o027), [O028](research/orange/evidence.md#o028), [O034](research/orange/evidence.md#o034), [O035](research/orange/evidence.md#o035), [O037](research/orange/evidence.md#o037), [O049](research/orange/evidence.md#o049), [O051](research/orange/evidence.md#o051), and [O055](research/orange/evidence.md#o055). Apply only fields relevant to the unanswered question; do not force a source through a fixed skill pipeline.
