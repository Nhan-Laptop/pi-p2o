# Interaction-centered source review

Read with [source-code auditing](../SKILL.md) after reachability is mapped. [O005](../../../research/orange/evidence.md#o005) supports auditing relationships between individually reasonable components; [O001](../../../research/orange/evidence.md#o001) adds a caution about security mechanisms changing output/state before another protection is established.

## Select a relationship, not an alarming function

Start with one actor-reachable operation and its processing participants. Choose a shared field, representation, or policy decision with multiple writers/readers. Record each component's intended meaning, mutation rights, phase, and assumptions about previous checks. Prioritize a disagreement that could change resource selection, authority, behavior, or a memory-access contract. A large module count or dangerous API name is not enough.

Build a small interaction slice: entry → field writers → validation/decision → later readers → final operation. Compare ordinary and failure paths, including diagnostics, fallback responses, partial results, and re-entry. Read the surrounding framework contracts and current implementation before declaring an omission; a check may be elsewhere, or a return may not stop the pipeline.

## Keep a decision ledger

For each candidate write `question | expected contract | observed departure | reachable prerequisites | explanation to disprove | next observation | stop condition`. Examples of generic questions are whether a shared field preserves its semantic role, whether a reported error is terminal, and whether diagnostic output occurs before a protection is committed. These are questions to investigate, not guaranteed defect classes or sample exploit instructions.

Resolve the effective implementation before inheriting a familiar API's guarantee. Compatibility components can change responsibilities across revisions despite stable names. Inspect wrappers, replacements and customization/preservation callbacks against the ordinary contract; project maturity and a strict default path do not establish equivalent behavior. [O012](../../../research/orange/evidence.md#o012), [O017](../../../research/orange/evidence.md#o017), [O020](../../../research/orange/evidence.md#o020).

For table-managed decisions, map record, extracted key, hash and equality callbacks together instead of assuming a generic container enforces application identity. Use [cache-contract comparison](../../parser-differential-auditing/references/cache-selection.md) for the consumer's semantic question. [O009](../../../research/orange/evidence.md#o009).

After a blocked hypothesis, identify the blocking contract. Switch to the relevant source or a narrow runtime observation only if it can distinguish explanations. Do not erase denied paths, speculate that an undocumented phase exists, or expand to a whole-codebase sweep simply because one relationship was inconclusive.

## Tool selection

| Tool → purpose → when | Evidence returned |
|---|---|
| Symbol/field reference search and IDE hierarchy → enumerate actual writers/readers and adapters → after choosing an artifact-derived field | References with phase, receiver and unresolved indirect edges |
| Source and framework/specification review → reconcile documented terminal/re-entry behavior with implementation → when ordering is a hypothesis | Contract versus implementation distinction; reproduced specifications remain secondary evidence |
| Local debugger or focused unit tests → inspect one state/output transition → when source cannot resolve diagnostics or continuation | Original-build baseline, before/after state, probe sites and observer changes |
| Diff and equivalent-caller search → determine whether a repair changes the contract or blocks one entry → after a cause is understood | Semantic change, alternate callers, normal controls and remaining scope |

These are derived tool options. O005's demonstration utilities are not imported as generic research commands, and no source tool is claimed to have been run by this library.

## Route the missing evidence

- Unknown field meaning or transformation → [parser differentials](../../parser-differential-auditing/SKILL.md), with writer/reader roles, representation and phase/re-entry map.
- Unknown runtime value or terminal transition → [dynamic analysis](../../dynamic-analysis/SKILL.md), with paired predictions, known-good baseline and a bounded observation point.
- A field changes the selected operation or callback → [dispatch auditing](../../deserialization-and-dispatch-auditing/SKILL.md), with selector origin, mutation rights, normal/failure consumers and intended allowed behavior.
- A correction suppresses only one path → [remediation](../../remediation/SKILL.md), with the underlying invariant, sibling consumers and regression properties.

Reject a handoff consisting only of a grep hit or a published severity claim. Preserve failed assumptions and classify source-author outcomes separately from actual artifact observations. Once the selected relationship is corroborated or disproved, move to its next unresolved question; this does not establish whole-target safety.
