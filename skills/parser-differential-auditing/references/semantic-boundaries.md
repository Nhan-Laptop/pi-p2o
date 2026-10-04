# Semantic boundaries and transformation order

Use with [parser-differential auditing](../SKILL.md) when components agree on bytes but may disagree on a field's role, structure, or validity. The methods below adapt [O001](../../../research/orange/evidence.md#o001), [O004](../../../research/orange/evidence.md#o004), and [O005](../../../research/orange/evidence.md#o005). They are generic research decisions, not the source articles' exploit procedures.

## Build a role-and-representation ledger

For each participant and processing pass, record `actor-controlled origin | field | semantic role | writer | reader | representation | transformation | check | final operation | evidence`. A shared string can mean a resource name to one component and a routing instruction to another. Stable bytes do not imply stable authority or meaning. Identify who is allowed to change the field and which decision depends on it.

Extend the ledger beyond visible application calls. Generated startup code, runtime libraries, adapters, persistence, metadata extraction and later decoding may change the value. Preserve logical lengths, field boundaries and types as well as character content. Correct construction of a structured record is not a promise that later rewrites preserve its structure. [O001](../../../research/orange/evidence.md#o001), [O004](../../../research/orange/evidence.md#o004), [O005](../../../research/orange/evidence.md#o005).

## Challenge order, not just individual checks

Write the real sequence of escaping, conversion, storage, restoration and consumption. Ask what guarantee survives each edge. A transform after validation can invalidate the alphabet or structure an earlier check protected; the presence of both checks does not establish that their composition is sound. Determine the effective runtime encoding and conversion API rather than inferring it from a console setting. [O004](../../../research/orange/evidence.md#o004).

A phase-order objection needs a transition model: normal processing, failure continuation, internal re-entry, and inherited state. On re-entry, record whether identity, route metadata, validated fields and authorization decisions are recomputed, copied, or reused. Do not assume a value written late cannot influence an earlier phase that runs again. Error paths also require proof that the intended terminal state is actually terminal. [O005](../../../research/orange/evidence.md#o005).

## Choose one discriminating observation

| Tool → purpose → when | Required limit |
|---|---|
| Source references plus a phase/state diagram → identify writers, readers and re-entry → when participant meaning or timing is unclear | A static edge is a hypothesis until its prerequisites are established |
| Runtime encoding diagnostics and configuration-specific mapping tables → predict possible conversions → when an implicit narrowing edge is suspected | The optional mapping lookup discussed in O004 is evidence for possible mappings, not an executed test or universal configuration |
| A local unit harness or debugger → compare a benign marker before and after one boundary → when a specific transformation remains unresolved | Preserve actual runtime/configuration; substitute parsers cannot establish target semantics |
| Intercepting proxy plus application traces → correlate accepted request, routing and final consumer → when transport hides the processing stages | Avoid proxy normalization as an unreported observer effect; a response code is not consumer-state evidence |

Use one known-good input and one harmless comparison class, changing a single representation or processing-state dimension. Observe both interpretations and the actual policy/operation. Record error and empty-state behavior without copying an article's trigger. Stop if sensitive material appears. A conversion table, an exception, or disagreement alone establishes neither reachability nor security impact.

## Handoff gate

Send the ledger, phase/re-entry diagram, controllable subset, configuration, check guarantees, paired observations, normal controls and unresolved edges to [dynamic analysis](../../dynamic-analysis/SKILL.md) if values or ordering remain uncertain. After a witnessed discrepancy, hand the specific changed policy decision to [authorization](../../authorization-auditing/SKILL.md), or the changed behavior selector to [dispatch auditing](../../deserialization-and-dispatch-auditing/SKILL.md).

The consumer rejects a packet without an actual consumer, contrasting predictions, or classification of static versus observed edges. A repair packet identifies an authoritative typed representation, all later writers/consumers, equivalent failure paths, and compatibility controls. Handoffs are library-derived contracts; the source authors are not claimed to have used this library.
