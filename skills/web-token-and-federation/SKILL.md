---
name: web-token-and-federation
description: Test whether a self-describing bearer token (a signed structured token) and an authorization-delegation flow actually bind the claims they carry and the identity they represent, by reading structure, verifying signature enforcement and checking redirect and parameter handling. Use when login state is a signed token rather than an opaque server-side session, or when a third party issues access on the application's behalf. Covers WSTG SESS-10 and ATHZ-05.
---

# Web Token and Federation

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when the application accepts a signed, structured bearer token as proof of identity or session state, or delegates authorization to or from another party through a standard authorization-delegation flow. This is distinct from [web session management](../web-session-management/SKILL.md), which covers opaque server-held session identifiers. Source review covers signature verification, algorithm handling and claim validation code, and the delegation flow's redirect and state handling. Live work covers the application's own endpoints and any host or redirect the flow reaches, including a third-party identity provider's infrastructure, which the sandbox can reach: the supplied target is a starting label, not an egress boundary.

## Test Cards
- [Signed token verification](references/signed-token-verification.md): wstg-sess-10.
- [Delegated authorization flow](references/delegated-authorization-flow.md): wstg-athz-05.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Trace signature verification, algorithm selection and claim checks, or the delegation flow's redirect and state handling, in the supplied revision.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Decode and re-encode a token you hold using a local library, after a real probe confirms the runtime.
- `controlled-identity-comparison` requires an identity you obtain yourself for each principal: register a disposable account through the target's own signup flow, keep each named principal's cookies in its own jar, or use a sealed secret if one exists. A token you cannot attribute is a variant to characterize, not a blocker.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Obtain one valid token or one completed delegation flow for a controlled principal and record its structure (which fields it carries, which algorithm it declares) without altering its meaning. Every later comparison changes exactly one structural property against this baseline and is sent back to the same endpoint that issued or accepted it.

## Bounded Comparison
For a token: change one declared property at a time (the signature algorithm it claims, the signature bytes, one claim value) while keeping the rest of the token's structure intact, and observe whether the application's acceptance decision changes. For a delegation flow: change one parameter of the flow (the declared return destination, the state value, the client identifier) while keeping the rest of the flow intact, and observe the behavior at the application's own endpoint only.

## Controls
- Positive control: the unmodified baseline token or flow is accepted, proving the harness and the route work before a modified version is interpreted.
- Negative control: a token with an arbitrary, unrelated signature, or a flow missing its required parameter entirely, is rejected, proving the application does check something.
- Attribution control: attribute each token and client registration to a named principal you self-provision; a token observed from another principal, or a flow that involves one, is a valid variant when the question is what it reaches.

## Expected Observations
For a token: which structural change was accepted or rejected, and under what claimed algorithm. For a delegation flow: whether the application's own endpoint enforces an exact match on the return destination and consumes a single-use, request-bound state value. For source review of either: the file and function performing verification, and whether it is actually called on the path that accepts the credential.

## False-Positive Checks
- A token accepted by a library's decode-only function during debugging or logging, which is never the function that gates access.
- A delegation parameter that is informational display text and does not influence what the application's endpoint ultimately grants.
- A rejection caused by an unrelated expiry or clock-skew setting rather than by the structural property being tested.
- A third-party identity provider's own behavior is its own system; this skill tests the application's acceptance of what the provider returns.

## Stop Conditions
- Follow the flow's redirects and parameters to any infrastructure, account or endpoint they name, including a third-party identity provider the sandbox can reach; the effect observed there is evidence.
- Reuse a modified token or flow result to access another principal's data; confirming acceptance of the modification is one step, and what it then reaches is the next.
- Record the first confirmed acceptance of an unverified or altered structural property and carry the chain from there; hand the composition to [authorization auditing](../authorization-auditing/SKILL.md), which joins it to the object decision and reports the depth reached.
- Attribute each token and client registration to a principal you self-provision; an unattributed token is a variant to characterize.

## Evidence Fields
- Token or flow identity and the principal it represents.
- The single structural property changed and the request/response receipt for both the baseline and the changed version.
- For source review, the file and function performing verification and whether it runs on the accepting path.
- Coverage state and the reason for any card not run.

## Gaps
A third-party identity provider's own enforcement is reachable through the sandbox network tool. What stays untested is a hardware-bound or platform-managed token store the run cannot drive, and a flow no transport exercised. A clean result covers only the structural properties compared, not the token format or flow in general.

## Handoffs
Provide the baseline and each comparison's receipt, the structural property changed, and the source location of the verification function when available. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web session management](../web-session-management/SKILL.md) when the token is layered over an invalidation question, [authorization auditing](../authorization-auditing/SKILL.md) for what an accepted token or flow result may then do, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the token and authorization-delegation guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
