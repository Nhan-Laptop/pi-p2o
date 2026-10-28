# Research Handoff Contracts

Shared by all skills. A handoff is an evidence packet, not a claim of completion. Use only authorized artifacts and test designs; cite your own reproduction rather than copying someone else's exploit verbatim. A consumer rejects a packet missing its required fields and returns a specific unanswered question.

## Common envelope

Every packet includes:

- **Scope:** authorization, target/artifact hashes, revision/build/runtime, configuration, actor/privileges, intended boundary, isolation/recovery constraints.
- **Question:** one falsifiable unresolved question; expected observation if true and if false.
- **Evidence:** file/symbol/section references, trace or test artifact paths and hashes, collection method, timestamps, original versus modified environment. For analyzer output, include tool/version/options, requested versus recovered functions/ranges, truncation, errors, and unresolved coverage; exit status alone is insufficient.
- **Classification:** independently observed fact, static inference, source-author report, hypothesis, defensive recommendation, or unresolved. Never silently upgrade a classification.
- **Limits:** negative controls, failed assumptions, reproduction denominator, untested versions/routes, observer effects, residual risks.
- **Next action:** a bounded next step — an observation, a review, or the next step of the chain with the inputs it needs — and its stop condition; never a vague request to “exploit it”.

Use [templates/handoff.json](templates/handoff.json) as a recording scaffold. A consumer must fill missing information, not interpret empty arrays as proof.

### Runtime evidence envelope

During P2O assessments, cite host-generated receipt IDs rather than inventing artifact identifiers. Use
`p2o_ledger` with a record ID to inspect a worker's bounded observation. Record closure separately from execution
state and proof level through `p2o_candidate`: source traces, offline reproductions and live reproductions are
not interchangeable. State intended-policy provenance (`explicit_contract`, `boundary_invariant`, or `inferred`);
an inferred policy remains an open proof gap. Revisions name the superseded candidate ID, and evidence-backed
closure may resolve named open-item IDs without erasing their history. Independence is defined in the [evidence
contract](docs/EVIDENCE.md#cases-claim--case--finding): a different worker's matching reproduction with its own receipt,
never metadata.

Retention is confirmed at start: `durable-local` (default) keeps the redacted ledger and artifacts under
`.p2o-state/<run-id>` after cleanup, `ephemeral` removes them, and `--export` additionally writes bounded redacted
receipts and hashes under `.p2o-reports/`. Redaction is best effort; review before sharing.

### Focused method and review

Select the role from the current question: recon for unclear entry/actor/gate, discovery for a concrete hypothesis, validation for another worker’s reproduction, reporting for synthesis, general for bounded support. The current Pi is always the Planner: it has no target, lab or claim tools, so it creates and dispatches intents instead of investigating. Workers are the only executors and the only claim/note/surface authors. Reporting workers are read-only second readers: they synthesize existing evidence and cannot execute target commands, change a verdict or record a candidate. Each role's prompt states that rule in one line and the role loadout enforces it; a planner round that ends with an open goal and no open intent is recorded as a `planner.stalled` report fact rather than passing silently. No universal stage order or full-target map is required.

Record the question, contrasting observations, source/actor/control provenance, known unknowns, selected skill/workflow and package hash, expected evidence, smallest missing prerequisite and stop condition. Adapted extraction/probe scripts need their own provenance; one sample is not a parameter contract. Install the tooling the question needs into your own scratch; stop only repeated unchanged failures.

During P2O, only the planner’s host-side task board accepts task packets and reserves assignments. Worker text is an observation/request, not acceptance. Queued prerequisites may name an existing task before review, with an optional revision. Dispatch pins the reviewed revision backed by same-run receipts; revised support invalidates dependent commands. Workers propose subtasks; only the planner accepts and dispatches them. Exact surface/risk reservations are not semantic deduplication. Independent validation explicitly names its reviewed predecessor and accepted revision. Document hashes identify methodology, not target evidence or binary availability.

Review the validator’s **current** conclusion and receipt, including withdrawal and controls. A reported/closed coordination task does not close a security candidate; reporting creates no proof. Missing actor, control or provenance returns the smallest unanswered question. A URL, authenticated or browser method is not a gap: the target is a starting label, any host the sandbox routes to is reachable, any method/header/body is accepted, the image carries the browser transport, and a principal is provisioned by the worker itself when the operator did not seal one. Only a tool or host that actually refuses remains a gap.

When a question is one of the OWASP WSTG tests, name it by its lower-case test ID (for example `wstg-athz-04`) as the question key of the task, and use the skill workflow id as the method family, so the same test on the same asset in the same context is recognised as the same work. The [WSTG test map](docs/WSTG_MAP.md#wstg-map-table) shows which tests the shipped skills cover by name (D) or only through general techniques (T), which they do not cover (N), and which are outside this tool's scope (O). A map entry is library knowledge, not a result: the host derives the coverage cell for a test from reviewed work — the reviewed task, its worker claim and the current accepted case — and a task whose work identity names no asset is an unmapped gap, never a cell (the model has no cell verb); its evidence is recorded as for any other question.

### Provisional owner review

If an authorized investigation finds unexpected artifacts suggesting a pre-existing incident, stop expanding access and notify the authorized owner/responder. Use the common envelope with minimized, redacted diagnostic/artifact references, collection time/method and integrity provenance, explicit attribution/initial-access unknowns, permitted preservation and containment scope. Do not use credentials or test wider access to resolve attribution.

**Gate:** an authorized recipient and a traceable observation suffice for provisional review; no confirmed-impact prerequisite is invented. Conversely, suspicious artifacts and symptom-based containment do not establish root cause, H5 repair closure or deployment verification. Return missing authorization/provenance. This derived dynamic-observation → owner/remediation route draws on [O033](research/orange/evidence.md#o033); it is not the source's compromise sequence.

## H1 — Recon → Static Analysis

**Producer:** attack-surface mapping. **Consumer:** source/binary auditing.

Required additions: interface table with registration/handler locations; lowest reachable actor; gate results; process identity; input formats and benign accepted operations; architecture/load map if known; unresolved routes/features. For distributed services, include peer topology, identity origin, installation-derived membership and evidence of effective authority—not merely nominal group names.

Required recon inventory: stable surface ID, entry and accepted input, observed actor, gate/handler if known, sensitive consumer or trust boundary, same-run receipt IDs and extraction method, fact/inference/hypothesis label, unknowns and covered/untested scope. For URL targets the confirmed origin is the starting label, not a boundary: send any method, headers, cookies or body, reach any host and port the sandbox can route to (private, link-local and cloud-metadata addresses included), and drive the installed browser when the effect lives in a page. The operator's authorization and recorded constraints bound the work; no origin filter does. Source declarations do not establish deployed exposure. Record the observed features that decide which tests are worth planning (login, session token, upload and the other words of the trigger column in the [WSTG test map](docs/WSTG_MAP.md#wstg-map-table)) as an asset attribute named feature or as an observed fact, so the planner can choose tests from the map instead of guessing.

Rank a bounded next-task queue by reachable influence, sensitive effect, boundary ambiguity, evidence strength, information gain and remaining budget. Record why the selected surface/risk is next, the expected observation, owned coverage and stop condition. Correct the actor/boundary model when observations contradict assumptions.

**Acceptance gate:** at least one prioritized entry has evidence of its actual gate/handler, or is explicitly marked inferred with a proposed reachability check. Root-object access cannot stand in for descendant routes. UI behavior cannot stand in for backend policy.

**Return condition:** missing actor/configuration, unclear artifact provenance, or no reason for prioritization. Return the smallest missing surface question. Unclear gates return to mapping; concrete boundary concerns proceed to discovery; plausible candidates need separate validation; blocked proof stays open. New surfaces feed back into recon, and unproductive branches stop with gaps recorded. Do not wait to map everything or claim whole-target completeness.

## H2 — Static Analysis → Dynamic Analysis

**Producer:** source/binary/data-flow/patch/invariant audit. **Consumer:** dynamic analysis.

Required additions: minimal slice; invariant; controllable fields/guarantees; state/permission constraints; unknown value/branch/lifetime; contrasting predictions; observation points and allowed instrumentation. For composition add representation/role/context changes, writers/readers, encoding, re-entry and terminal-state evidence. Include actual receiver/phase/guard, result/error conversions, cache key/consumer predicates, producer/delivery/display stages, worker/history/reset and transient-result latency where relevant; explicitly label inferred edges.

**Acceptance gate:** the experiment distinguishes hypotheses, reaches a known-good baseline, and can be run safely in the declared lab. A grep hit or alarming API name is not sufficient.

**Return condition:** both predictions produce the same observable result, the path's prerequisites are unknown, or only a modified build is available without disclosure. Return a narrower experiment design.

## H3 — Fuzzing → Manual Audit

**Producer:** fuzzing. **Consumer:** binary, memory, state/lifetime, or parser audit.

Required additions: seed lineage and hashes; minimized local input/operation-sequence artifact; initialization/reset state; harness versus real-target comparison; build/instrumentation; coverage and rejection-path evidence; sanitizer/crash logs; first invalid operation; allocation/free or transition context; repetitions and deduplication rationale.

**Acceptance gate:** the same invariant/fault reproduces from a saved seed under documented state, and the harness itself is not the sole failing component. Original and triage-modified runs remain separate.

**Return condition:** only a crash address, unexplained timeout, state leakage, or unrealistic framing. Return for harness repair or reproduction. A fault that reproduces from a saved seed is not returned for a coverage check: its minimized input and crash record are the input to the impact step, which H4.5 carries.

## H4 — Bug Discovery → Exploitability Assessment

**Producer:** any root-cause skill. **Consumer:** exploitability assessment and, if needed, sandbox-boundary analysis.

Required additions: invariant and earliest violation; constrained primitive (direction, width, controllability, repetition, address-space/lifetime); actor and feature/permission gates; actual mitigations; damage/recovery; evidence classification and missing capabilities. Mediated operations include fixed/controlled fields, framing/encoding, destination and protocol-state limits; layout claims include effective producer emission order/configuration and the trigger sequence relied on.

**Acceptance gate:** evidence supports a reachable violation or explicitly bounds the analysis as static-only. The consumer may assess a hypothesis but must not present it as demonstrated impact. Capability-graph edges each need preconditions and evidence; a composed chain additionally states its ordered steps, the claim that ran each step, and the last step actually executed.

**Return condition:** blanket arbitrary-read/write label, a crash equated with execution, missing address-space context, or debug/security bypass hidden in the setup. Return for constraint characterization. Build the chain as far as the authorized target allows, and record where it stopped instead of leaving the link unexercised without saying so.

## H4.5 — Primitive → Effect

**Producer:** exploitability assessment, exploit design, or any root-cause skill holding a constrained primitive. **Consumer:** exploit design, chaining, or the sequence that carries the primitive to its effect.

Required additions: the primitive in one sentence with a verb, an object, an actor and a condition; the stored payload and its hash; the environment fingerprint it ran in; the negative control; the rung reached (reproduce, control, escalate, prove); the effect class the work aims at; the `gained`/`needs` edge; and the observation surface that would show the next rung. A version, banner or advisory match is a lead, not a primitive.

**Acceptance gate:** a same-run receipt for the attempt and a control that did not produce the effect, with the depth stated as observed rather than planned. A crash is not control of execution; a read in one address space is not access in another.

**Return condition:** the missing ingredient — an address, a key, an identifier, a second primitive, a build or a listener — named as a `needs` edge, or the check that refused the next rung. Return the constraint, never a request to “exploit it” and never a rung the sequence has not passed.

## H4.6 — Foothold → Root or Internal Reach

**Producer:** session to root or internal pivot. **Consumer:** credential and pivot, chaining, or the report.

Required additions: the foothold’s identity receipt (user, groups, host, container marker) and the boundary it sits behind; the transport used, and every transport unavailable with the fact that made it so; the path menu or destination table with the check that closed each entry; for root, the root-only artifact that corroborates the identity plus a second observation through a different command; for internal reach, which side made each request and the arrival record when the request was blind; the cleanup of everything the attempt created; and the boundary the root did not cross.

**Acceptance gate:** root is corroborated by an operation only that identity can perform and re-observed through a different command or transport; internal reach is a request the compromised host performed, not one the sandbox performed. A `whoami`-style string alone, a prompt glyph, or a sandbox-side request is not the observation.

**Return condition:** the boundary holds (the checks that refused are the result), no ingress exists (the environment fact), or the next step needs persistence or a destructive change (out of scope). Return the boundary and the depth reached; do not escalate the claim to host root and do not add persistence to make a rung easier to show.

## H5 — Root Cause → Remediation / Defensive Engineering

**Producer:** root-cause and impact assessment. **Consumer:** remediation.

Required additions: target-independent invariant; authoritative trusted enforcement point; all affected consumers and semantic variants; narrow justified impact; emergency exposure mitigation; accepted controls; rejected/bounded cases; role/feature/state/runtime matrix; proposed regression properties; source versus shipped-artifact gap; logging/redaction needs. Representation changes require entry/type/downstream compatibility coverage; identity restrictions require legitimate-peer controls at each consumer.

**Acceptance gate:** tests would distinguish root-cause repair from blocking one sample and would preserve normal behavior. Access restriction and unresolved underlying bugs are separately classified.

**Return condition:** trigger-only blacklist, no equivalent-path review, unverified shipped package, or no normal controls. Return the missing invariant/variant/deployment question.

## H6 — Engineering → Verification / Operations

Required additions: source change, actual package/build hashes, test receipts, deployment inventory, shipped-code versus active-enforcement evidence, compatibility-driven defaults and rollout/activation requirements, listener/membership changes, detection transport coverage, compatibility tradeoffs, secret-rotation scope if exposure is established, and residual risks.

**Acceptance gate:** deployed artifacts contain the assessed fix; accepted controls still work; forbidden classes are rejected/contained under original policy. Classify the result as **repaired**, **exposure mitigated**, **partially repaired**, or **unverified**. No closure based solely on an advisory, timeout, or source merge.
