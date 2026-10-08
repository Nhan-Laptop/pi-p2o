---
name: parser-differential-auditing
description: Find trust failures caused by inconsistent parsing, canonicalization, framing, encoding, or validation across layers. Use when the validated representation may differ from the consumed one.
---

# Parser-Differential Auditing

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Validate-versus-consume semantic comparison.

## When to Use
Data crosses parsers, runtimes, protocols, templates, URL authorities, storage, or execution contexts. For byte-capacity errors alone, use [memory-safety auditing](../memory-safety-auditing/SKILL.md).

## Goal
Do producer, validator, policy checker, and final consumer agree on the meaning and extent of this input?

## Workflow
Representation map → parser rules → semantic discrepancy hypothesis → paired observations → policy consequence → canonical enforcement.

1. Identify every representation and parser, including runtime/library versions. Record field widths, byte order, signedness, encoding, delimiters, length interpretation, trailing bytes, empty values, and error behavior.
2. Mark where authorization, sanitization, and structural validation occur. State what each check guarantees and which representation it checks.
3. Compare canonical versus original values, decoded versus raw URLs, declared versus actual lengths, data versus command arguments, and initial versus later parsing passes. Include post-encoding rewrites, generated startup/runtime conversions, persistence and restoration; record a shared field's semantic role on each pass, not only its bytes.
4. Form one discrepancy hypothesis. Use small boundary-class comparisons around a width/range, missing delimiter, normalization choice, or empty/error state—not a copied target payload.
5. Observe each layer's parsed fields and final operation in an isolated setup. Distinguish network framing, application parsing, and execution semantics; preserve connection boundaries and rejection paths.
6. Show whether the discrepancy changes an authorization decision, object selection, buffer access, or execution context. Parser disagreement without a security consequence remains a correctness finding.

For transformation-order, shared-field and re-entry questions, use the owned [semantic-boundary guide](references/semantic-boundaries.md). For indexed reuse and key/consumer equivalence, use [cache selection](references/cache-selection.md).

## Research Heuristics
- Accepted structured content can retain surrounding original text that a later shell consumer interprets. [B001](../../research/evidence.md#b001)
- Narrow length packing can behave differently across runtime versions; empty parsed fields may enter exceptional policy branches. [B009](../../research/evidence.md#b009)
- Two validators can undo one another; inspect transformation order and final value, not the presence of a sanitization call. [B068](../../research/evidence.md#b068)
- Browser restrictions, server authority parsing, URL construction, redirects, and fallback transports are independent layers. [B058](../../research/evidence.md#b058), [B072](../../research/evidence.md#b072), [B048](../../research/evidence.md#b048)
- A format checker and its consumer may interpret the same count differently or return success too early. [B069](../../research/evidence.md#b069)

## Tools
- Small local runtime tests → measure actual cast/pack/parser behavior → when documentation or modern defaults differ from the deployed runtime.
- Debugger/Frida → inspect parsed fields and preserved originals → when canonicalization or branch behavior is uncertain.
- Wireshark → compare application assumptions with real framing/connections → when transport behavior matters.
- Intercepting proxy and controlled callback endpoint → observe permitted destinations and request metadata → when auditing outbound requests; DNS callbacks alone do not prove response access or code execution.
- Library documentation plus source/disassembly → compare normative rules with implementation → when validating delimiter, length, or escaping contracts.

## Validation
Record input class and each layer's interpretation, a safe baseline, the final consumer, and the violated policy. Reproduce with the real runtime/library; reject discrepancies arising only from a substituted parser. A response error can be an oracle but not proof of arbitrary data access. B009's suggested empty-destination authorization explanations are partly hypothetical; do not inherit them as verified implementation details.

## Common Failure Modes
Testing only the default representation; equating encoding with context safety; assuming a browser can transmit arbitrary protocol bytes; treating one TLS/header check as destination confinement; missing additional type/count consumption. B072, B058, B069, and B056 supply concrete rejection or incompleteness examples.

## Fix / Mitigation
Derived guidance: parse once into typed canonical values; validate and consume the same result; fail closed on malformed/empty ambiguous states; avoid shell/source construction; validate outbound destinations across redirects and constrain egress. Escape for the final output context, not an earlier parser.

## Focused Method
Carry exact representations, parser identities, controlled comparisons and rejected assumptions into the next question. A discrepancy needs an observed consequence; unavailable framing or transport remains a gap, not a reason to broaden scope. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review).

## Handoffs
**Parser Comparison → Root Cause:** provide parser/runtime identities, representation table, contrasting interpreted values, policy consequence, and rejected alternatives. **Root Cause → Remediation:** specify the authoritative representation and every consumer needing the same contract. Next: [remediation](../remediation/SKILL.md).

## Evidence
B001, B009, B068, B069, B058, B072, B048, B050, B051, B056, B059, and B017 merge into one semantic-consistency skill rather than separate URL, HTTP, font, and RPC recipes.

Additional relationship, implicit-conversion and post-construction lessons come from [O001](../../research/orange/evidence.md#o001), [O004](../../research/orange/evidence.md#o004), and [O005](../../research/orange/evidence.md#o005). These are author-reported methods, not target replications.

[O009](../../research/orange/evidence.md#o009) contributes cache-selection equivalence within a declared context; [O012](../../research/orange/evidence.md#o012) adds selected context and metadata-policy agreement between layers.
