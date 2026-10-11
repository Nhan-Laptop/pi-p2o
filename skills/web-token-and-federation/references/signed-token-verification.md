Tests: wstg-sess-10

# Signed token verification

Card for [web token and federation](../SKILL.md). A structured bearer token is three readable parts: a declared algorithm and type, a set of claims, and a signature meant to bind the first two together. Every step below changes one declared property and asks whether the application still accepts the result; none of it needs the real signing key.

### wstg-sess-10 Structured bearer token acceptance
- Trigger: the application accepts a structured, self-describing bearer token (one whose parts a client can read without the signing key) as proof of identity or session state.
- Inputs: one valid token for a controlled principal (A); the verification code (S).
- Steps: read the token's declared parts without altering them and record what it claims, never its secret material. Then, one change at a time: (1) re-declare the algorithm as the no-signature option the format allows, with the signature portion removed, and resend; (2) change one claim value while keeping the original signature unchanged, and resend; (3) if the format allows a caller-supplied verification key or key reference inside the token itself, point that reference at a value you control and resend with a matching signature; (4) if a public-key algorithm is declared, resend the same token body with a shared-secret algorithm. Compare each against the baseline's acceptance.
- Conclude: confirmed when any of the four changes is accepted by the route that gates access, which shows the application does not actually verify what it should. Separately, in source, confirm whether verification is called with an explicit, fixed expected algorithm rather than one read from the token itself, and whether a decode-only function (one that does not check the signature) is ever used on the accepting path.
- Evidence: the baseline token's declared parts; each of the four requests and their receipts; the source location of the verification call and the expected-algorithm handling.
- Record: cell for wstg-sess-10 on the login or token-issuance asset.
- Stop: use only your own controlled principal's token; never hold or guess another principal's secret key material, and stop after the first confirmed acceptance of an unverified change.
- Not a finding when: every change is rejected, or source confirms a fixed, explicit expected algorithm is enforced regardless of what the token declares.
