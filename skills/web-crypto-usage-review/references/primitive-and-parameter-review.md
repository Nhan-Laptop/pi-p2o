Tests: wstg-cryp-04

# Primitive and parameter review

Card for [web crypto usage review](../SKILL.md). It is a source-reading checklist, not a live test: every conclusion cites the actual call and its parameters, never an algorithm name alone.

### wstg-cryp-04 Weak or misused primitives
- Trigger: source contains a call to an encryption, hashing, signing or random-value function.
- Inputs: the cryptographic call sites in source (S).
- Steps: list every such call with its algorithm name, mode where applicable, and the source of its key, initialization vector, salt or nonce (a fixed literal, a per-operation random value, a counter, a hash of predictable data). Compare each against a fixed list of known-weak choices: a hash function not suited for password storage, a stream or block cipher considered broken for new use, a block-cipher mode that does not authenticate or that reuses a fixed initialization vector, a non-cryptographic random source used where unpredictability matters, and a fixed or hard-coded key or seed.
- Conclude: confirmed when a call's actual algorithm, mode or key/IV source matches one of the listed weaknesses, cited to the source line. A matching function or variable name whose actual algorithm argument is not weak is not a finding.
- Evidence: the source location, the algorithm and parameters read from the call, and which listed weakness applies.
- Record: cell for wstg-cryp-04 per distinct call site or per shared utility function.
- Stop: source reading only; no attempt to demonstrate practical breakability.
- Not a finding when: the call's actual parameters do not match any listed weakness, or the primitive is used only for a purpose the listed weakness does not apply to.
