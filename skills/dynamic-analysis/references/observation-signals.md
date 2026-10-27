# Observation signals, comparability and missing results

Use with [dynamic analysis](../SKILL.md) and the [runtime-probe contract](runtime-probes.md). This guide combines source-reported observations with explicitly derived safe experiments; it does not import recovery or extraction procedures.

## Choose a discriminating, bounded signal

Write `internal hypothesis | predicted observable | observation point | alternative explanation | work/time ceiling | recovery requirement`. If both hypotheses predict the same output, the observer cannot distinguish them. A changed diagnostic may suggest a later validation/binding stage, but does not prove selected behavior, consumer completion, identity, or authority. Compare with the applicable protocol/runtime contract; keep inferred stages and rejection-pattern models partial until corroborated. [O011](../../../research/orange/evidence.md#o011), [O051](../../../research/orange/evidence.md#o051).

When direct output is absent, consult documented consumer semantics before choosing another observer. Prefer ordinary benign effects in an isolated fixture you control. Non-crash does not mean non-disruptive: indirect timing needs matched load/network controls, bounded repetitions and an explicit workload/time ceiling. Abort uncontrolled work growth; never import a source's amplification example. These safeguards are derived, not author-reported controls. [O019](../../../research/orange/evidence.md#o019).

## Identify which stage produced the observation

Record `producer behavior | delivered metadata | delivered body | displayed content | collection provenance`. Apparent success metadata does not prove content delivery; an empty display does not prove the producer returned nothing. Compare raw and rendered artifacts at the minimum needed and retain viewer, delivery and error-path explanations until a distinction resolves them. Do not infer a full processing order from appearance or promote a guessed deferred-worker architecture into observed ownership. [O034](../../../research/orange/evidence.md#o034), [O055](../../../research/orange/evidence.md#o055).

An absent late result can mean failed creation, removal, observer latency or limited visibility. Where the run can, correlate creation, removal and observation under the original configuration. Otherwise keep the negative inconclusive; do not assert cleanup occurred or optimize access to outrun it. A speculative cleanup explanation is not a demonstrated lifecycle defect or race. [O051](../../../research/orange/evidence.md#o051).

## Establish comparable state

Identify the state owner, initialization/reset contract, worker selection and relevant prior history. Request/connection identity is not worker or state identity. A fresh-instance model cannot silently describe a reused or different worker. Unknown history remains a prerequisite gap. [O035](../../../research/orange/evidence.md#o035).

Record persistent side effects of failed observations. Before comparing again, verify that the recovery restored the known-good baseline; otherwise mark the runs non-comparable. Distinguish session/object effects from component-wide failure. When ownership, recovery or reset equivalence is unknown, record the run as non-comparable instead of copying account-recreation or configuration-changing workarounds. [O049](../../../research/orange/evidence.md#o049).

## Tool → purpose → when

| Option | Evidence and limit |
|---|---|
| Existing structured logs and bounded branch/value observation → correlate diagnostic class with actual stage → when response-only inference is ambiguous | Changed errors alone are not a success oracle; minimize sensitive context |
| Raw-artifact inspection plus viewer comparison → separate delivery from display → when rendering hides the alleged result | Preserve provenance; redact credentials and records you do not own |
| Worker/state instrumentation → identify owner, history and reset → when repetitions or models disagree | Instrumentation can change routing/timing; preserve original and modified runs |
| API/protocol references plus a small local fixture → predict a non-crash observable → when consumer output is unavailable | Match the deployed contract and bound work; an illustration is not integrated-path evidence |

Options are derived, not new required installations or validated integrations.

## Handoff or stop

Return the original/common [H2 envelope](../../../HANDOFFS.md#h2--static-analysis--dynamic-analysis), observation-stage and state-owner ledgers, contrasting predictions, actual observations, rejected explanations, observer changes and one remaining question. Unknown ownership/reset goes to [state analysis](../../state-and-lifetime-auditing/SKILL.md); unknown selected behavior goes to [dispatch](../../deserialization-and-dispatch-auditing/SKILL.md); a confirmed constrained effect goes to [impact assessment](../../exploitability-assessment/SKILL.md). Identical predictions, unrecovered state or missing consumer evidence require a narrower question, not repeated broader tracing.
