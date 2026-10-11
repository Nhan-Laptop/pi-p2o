---
name: web-crypto-usage-review
description: Review how an application uses cryptographic primitives, primarily by reading source for known-weak algorithms, parameter misuse and client-side-decryptable state, with a live check limited to reading the application's own error behavior rather than breaking any encryption. Use when source shows encryption, hashing or client-held encrypted state. Covers WSTG CRYP-02 and CRYP-04.
---

# Web Crypto Usage Review

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when source shows the application selects or configures a cryptographic primitive (an encryption, hashing or random-generation call), or decrypts state that the client holds and could have altered. This skill reads what was chosen and how it is used; it does not attempt to break a well-chosen primitive, and it never performs a live attack that depends on sending many crafted values to extract key material. A live check is limited to reading how the application's own error path behaves on malformed input it already decrypts.

## Test Cards
- [Primitive and parameter review](references/primitive-and-parameter-review.md): wstg-cryp-04.
- [Decryption error-path observation](references/decryption-error-path-observation.md): wstg-cryp-02.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Find every cryptographic call, the algorithm and parameters it uses, and where client-held encrypted state is decrypted.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Exercise an extracted cryptographic call or decryption path against fixture values in a local harness, after a real probe confirms the runtime.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
List every place source selects a cryptographic primitive or decrypts client-held state, with the algorithm, key or IV source, and mode named for each. This list is the subject of every card; no live request is needed to build it.

## Bounded Comparison
For primitive selection, the only comparison is against a fixed list of algorithms and modes known to be weak or misused, read in source; no live request is involved. For decryption error-path observation, change exactly one byte of a value the client already legitimately holds and compare the application's response to the baseline's valid value, never a value crafted to recover key material through repetition.

## Controls
- Positive control: the baseline valid value is accepted and produces the expected result, before any altered value is interpreted.
- Negative control: a value that is not valid ciphertext at all (clearly malformed, not just one byte changed) is rejected, showing some check exists before a subtler one-byte change is tried.
- Source control: a primitive flagged by the fixed list is confirmed by reading the actual call and its parameters, not by the function or variable name alone.

## Expected Observations
The list of cryptographic calls and decryption sites with their algorithm, mode, and key/IV source; for the error-path card, the baseline and one-byte-altered value's responses, compared only for whether the error is distinguishable, not for what it reveals about the key.

## False-Positive Checks
- An algorithm name appearing in a comment, a dependency's own internal code, or dead code never reached by the application.
- A primitive used only for a non-sensitive purpose (a cache key, a non-secret checksum) where the listed weakness does not apply to that use.
- A single ambiguous error response that could be explained by a cause unrelated to padding, without a second, independent comparison.

## Stop Conditions
- Stop after listing the primitives found in source; do not attempt to demonstrate that a weak primitive is practically breakable.
- Stop after one one-byte-altered comparison per decryption site; never repeat the comparison enough times to actually recover or forge content.
- Stop before sending any value crafted to extract key material, decrypt another principal's data, or forge content for further use.

## Evidence Fields
- The cryptographic call's source location, algorithm, mode and key/IV source.
- Which fixed-list weakness applies, if any, cited to the specific call rather than inferred from a name.
- For the error-path card, the baseline and altered value's receipts and whether the responses are distinguishable.
- Coverage state and the reason for any card not run.

## Gaps
Whether a flagged weak primitive is practically exploitable against this deployment (key size, usage volume, attacker position) is a separate, harder question this card does not answer; it stays an open_proof_gap pointing at the specific weakness found. Compiled or vendored cryptographic code without available source stays unverified by this skill.

## Handoffs
Provide the primitive list with source locations and flagged weaknesses, and the error-path comparison when run. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web deployment hygiene](../web-deployment-hygiene/SKILL.md) for transport-level TLS questions, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the weak-cryptography guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
