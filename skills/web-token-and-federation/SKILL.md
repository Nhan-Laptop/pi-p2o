---
name: web-token-and-federation
description: Test whether a self-describing bearer token (a signed structured token) and an authorization-delegation flow actually bind the claims they carry and the identity they represent, by reading structure, verifying signature enforcement and checking redirect and parameter handling. Use when login state is a signed token rather than an opaque server-side session, or when a third party issues access on the application's behalf. Covers WSTG SESS-10 and ATHZ-05.
---

# Web Token and Federation

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when the application accepts a signed, structured bearer token as proof of identity or session state, or delegates authorization to or from another party through a standard authorization-delegation flow. This is distinct from [web session management](../web-session-management/SKILL.md), which covers opaque server-held session identifiers. Source review covers signature verification, algorithm handling and claim validation code, and the delegation flow's redirect and state handling. Live work is limited to the application's own endpoint and your own controlled client registration; it never targets a third-party identity provider's infrastructure.

## Test Cards
- [Signed token verification](references/signed-token-verification.md): wstg-sess-10.
- [Delegated authorization flow](references/delegated-authorization-flow.md): wstg-athz-05.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Trace signature verification, algorithm selection and claim checks, or the delegation flow's redirect and state handling, in the supplied revision.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Decode and re-encode a token you hold using a local library, after a real probe confirms the runtime.
- `controlled-identity-comparison` requires operator-supplied credentials attributable to controlled principals, used only inside the confirmed origin. A token you cannot attribute to a controlled principal does not satisfy this workflow.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Obtain one valid token or one completed delegation flow for a controlled principal and record its structure (which fields it carries, which algorithm it declares) without altering its meaning. Every later comparison changes exactly one structural property against this baseline and is sent back to the same endpoint that issued or accepted it.

## Bounded Comparison
For a token: change one declared property at a time (the signature algorithm it claims, the signature bytes, one claim value) while keeping the rest of the token's structure intact, and observe whether the application's acceptance decision changes. For a delegation flow: change one parameter of the flow (the declared return destination, the state value, the client identifier) while keeping the rest of the flow intact, and observe the behavior at the application's own endpoint only.

## Controls
- Positive control: the unmodified baseline token or flow is accepted, proving the harness and the route work before a modified version is interpreted.
- Negative control: a token with an arbitrary, unrelated signature, or a flow missing its required parameter entirely, is rejected, proving the application does check something.
- Attribution control: use only tokens and client registrations you hold for a controlled principal; never a token observed from, or a flow involving, another user.

## Expected Observations
For a token: which structural change was accepted or rejected, and under what claimed algorithm. For a delegation flow: whether the application's own endpoint enforces an exact match on the return destination and consumes a single-use, request-bound state value. For source review of either: the file and function performing verification, and whether it is actually called on the path that accepts the credential.

## False-Positive Checks
- A token accepted by a library's decode-only function during debugging or logging, which is never the function that gates access.
- A delegation parameter that is informational display text and does not influence what the application's endpoint ultimately grants.
- A rejection caused by an unrelated expiry or clock-skew setting rather than by the structural property being tested.
- A third-party identity provider's own behavior, which is out of scope; only the application's acceptance of what the provider returns is in scope.

## Stop Conditions
- Stop before targeting any infrastructure, account or endpoint that is not the application under assessment or a controlled client registration on it.
- Stop before reusing a modified token or flow result to access another principal's data; confirming acceptance of the modification is the finding, not what it could then reach.
- Stop after the first confirmed acceptance of an unverified or altered structural property; route further reach to [authorization auditing](../authorization-auditing/SKILL.md) rather than deepening this card.
- Stop if the token or client registration is not attributable to a principal controlled for this assessment.

## Evidence Fields
- Token or flow identity and the controlled principal it belongs to.
- The single structural property changed and the request/response receipt for both the baseline and the changed version.
- For source review, the file and function performing verification and whether it runs on the accepting path.
- Coverage state and the reason for any card not run.

## Gaps
A third-party identity provider's own enforcement, a hardware-bound or platform-managed token store, and any flow this task's scope does not name as a controlled client registration stay unverified. A clean result covers only the structural properties compared, not the token format or flow in general.

## Handoffs
Provide the baseline and each comparison's receipt, the structural property changed, and the source location of the verification function when available. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web session management](../web-session-management/SKILL.md) when the token is layered over an invalidation question, [authorization auditing](../authorization-auditing/SKILL.md) for what an accepted token or flow result may then do, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the token and authorization-delegation guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
