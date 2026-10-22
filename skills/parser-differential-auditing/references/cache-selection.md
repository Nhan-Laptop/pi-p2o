# Cache selection and record identity

Read with [parser-differential auditing](../SKILL.md) when a cached/indexed decision may disagree with the consumer's interpretation. [O009](../../../research/orange/evidence.md#o009) supplies reported cache-key/parser and record/equality observations. This is a generic contract audit, not cache-poisoning, collision-generation or authentication-bypass instructions.

## Declare the reuse context

Identify the cache owner, entry producer, lookup consumer, selection key, parser rules, freshness/state, and the context in which reuse is intended. Actor/tenant, route, policy, variation dimensions and processing state are **review questions**, not requirements that every cache key literally contain every dimension. State which consumer semantics are allowed to be shared.

Within that declared context, key equivalence must not merge distinct downstream response-selection meanings. Compare repeated-field policy and canonicalization at lookup and consumption; reviewing either parser alone misses their composition. Do not require byte-identical responses across time or dynamic state, or call a difference a security flaw before demonstrating a policy consequence. [O009](../../../research/orange/evidence.md#o009).

## Reconstruct the application contract

Trace `record → extracted key → bucket selection → equality operands → consumed identity/value`. Review application-provided extraction, hashing and comparison callbacks together. A generic container does not know the application's identity contract; bucket agreement is not full record identity. Include validity/freshness checks where they affect intended reuse.

For composite identity comparisons, map each operand to an independent semantic field. A repeated operand is a reason to investigate intended coverage, not proof of an omitted check: an optimization, prior gate, unreachable state or different identity model may explain it. Existing-entry, state and comparison-path prerequisites remain part of reachability.

If storage changes, ask whether lookup and retrieval predicates still select the modified record and whether the final consumer uses the changed value. Changed bytes alone do not prove changed meaning. This is a derived influence-check question, supported by the record/key model and the narrower table-consumer observation in [O016](../../../research/orange/evidence.md#o016); do not assume an independently stored index or particular obstruction without artifact evidence.

## Tools and observations

| Tool → purpose → when | Gate |
|---|---|
| Source/callback reference review → map extraction, hashing, equality and consumer semantics → when application-specific callbacks are available | Record actual operands, meanings and prior checks rather than reconstructing intent from one suspicious comparison |
| Scoped decompiler plus instruction checks → recover the same map → when source is unavailable | Follow [binary slice coverage](../../binary-auditing/references/native-slices.md); missing recovery is unresolved |
| Local unit harness or bounded debugger trace → compare benign lookup and consumer interpretations → when one equivalence/state assumption remains unknown | Pin parser/runtime, declared context and original cache state; no attack traffic or collision search |
| Configuration/deployment inspection → establish partition/freshness and activation policy → when the selection contract varies by deployment | Nominal settings are not observed enforcement or current-release evidence |

Retain one accepted control, an inert contrasting class, interpretations at both layers, and the actual consumer decision. A parser difference, hash equality or cache entry alone establishes no protected effect. The source's reported probabilistic paths and impact remain historical author claims, not a measured success rate here.

## Handoff by the unresolved contract

- Unknown callback meaning → [source auditing](../../source-code-auditing/SKILL.md), or bounded binary reconstruction if necessary.
- Unknown storage-to-retrieval influence → [data flow](../../data-flow-analysis/SKILL.md), with index/key predicates, changed subset, consumer and gate evidence.
- Unknown identity/equality policy → [authorization](../../authorization-auditing/SKILL.md), with semantic operands, intended binding and remaining checks.
- Unknown validity across transitions → [state/lifetime](../../state-and-lifetime-auditing/SKILL.md); a cache is not automatically a race or compiler defect.
- Confirmed semantic violation → [remediation](../../remediation/SKILL.md), with the declared reuse invariant, equivalent consumers, normal controls and tested versus unresolved context.

A consumer returns undeclared context, hash equality without identity evidence, or a claimed effect without its policy consumer. Handoffs and controls are derived for this library; pass the built sequence onward with the evidence behind each step.
