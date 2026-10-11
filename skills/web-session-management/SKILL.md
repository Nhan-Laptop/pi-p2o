---
name: web-session-management
description: Test the life cycle of a session token, from issuance, strength and cookie attributes through fixation, exposure, replay, logout, timeout and concurrent use, using controlled accounts and bounded samples. Use when an application keeps login state in a cookie or bearer token. Covers WSTG SESS-01 to SESS-04, SESS-06 to SESS-09 and SESS-11.
---

# Web Session Management

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when a request is tied to a login by a session token (cookie, header or hidden field) and the question is whether that token is issued, protected, bound to a login, replaced and ended the way the application's own policy and basic session hygiene require. Source review covers the session library settings, token generation, regeneration at login and privilege change, invalidation at logout and the lifetime settings. Controlled-account requests cover what the live origin actually does. Stateless signed tokens (JWT) and federated login belong to a different playbook, and CSRF to the browser-trust playbook. A token is a bearer credential: replaying your own token from a second client context proves nothing by itself, and the finding is always about how the token is issued, exposed, kept alive or ended.

## Test Cards
- [Token issuance and attributes](references/token-issuance-and-attributes.md): wstg-sess-01, wstg-sess-02, wstg-sess-04.
- [Fixation and hijack](references/fixation-and-hijack.md): wstg-sess-03, wstg-sess-08, wstg-sess-09.
- [Logout, timeout and concurrency](references/logout-timeout-concurrency.md): wstg-sess-06, wstg-sess-07, wstg-sess-11.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Trace how the token is generated, stored, regenerated, invalidated and expired in the supplied revision.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Analyze a bounded sample of issued tokens or exercise the session library with controlled objects in a local harness, after a real probe confirms the runtime.
- `public-http-review` requires authorized same-origin requests through the scoped HTTP client. Anonymous retrieval of the pre-login token and its attributes on the confirmed origin.
- `controlled-identity-comparison` requires operator-supplied credentials attributable to controlled principals, used only inside the confirmed origin. Without attributable credentials keep the candidate at a static trace and record the dynamic gap.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Establish what a healthy session looks like before testing it. Inventory every state carrier (cookies, headers, hidden fields, URL parts) with its name, location and attributes, never its value. With one controlled account record the sequence anonymous request, login, authenticated request, logout, authenticated request again, and keep the receipt of each. Use named HTTP sessions so each context has its own jar. State the expected policy with provenance: a documented timeout or concurrency rule, or a boundary invariant such as a new identifier after login.

## Bounded Comparison
Change one variable per comparison: the token carried, the transport, the point in the flow, or the time waited. Waits are bounded and chosen in advance; a timeout longer than the bound becomes a gap and a source reading, never a longer wait. Samples for strength analysis are at most thirty fresh sessions, drawn with the jar reset between them. Use only tokens of your own controlled accounts, and never record a token value; keep a short label and its length.

## Controls
- Positive control: a request with the current valid token reaches a protected route, which proves the route and the harness work before any denial is interpreted.
- Negative control: the same request with no token, and with a deliberately invalid one, is refused in the same way each time.
- Time control: repeat a baseline request after the wait with a fresh login to separate token expiry from an unrelated outage.
- Attribution control: two controlled accounts, so an observed access is attributed to the replayed token and not to the other account.

## Expected Observations
A token inventory with attributes and lengths; a pre-login and post-login comparison that records only whether the identifier changed; replay results before and after logout and after the measured wait; for source review, the file and setting that govern generation, regeneration and lifetime. A statistical sample that shows no pattern is bounded evidence, never proof of strength: record it as ruled out for that sample only.

## False-Positive Checks
- A cookie that is not a session token, such as a preference or a tracking value.
- An identifier that is renewed by a different cookie than the one inspected.
- A stateless token whose server-side invalidation is expected to be impossible by design.
- A logout that clears the cookie in the browser sense while the server also rejects the old value, which is healthy.
- A timeout that is enforced by a gateway the origin cannot reveal, observed through the replay result only.
- Differences caused by a load balancer that sends the two contexts to different nodes.

## Stop Conditions
- Stop if the account, token or object is not controlled for the assessment.
- Stop before brute-forcing identifiers, capturing traffic of other users, or waiting beyond the bound set in advance.
- Stop before any change of the account that is not reversible by the same account, such as a password change.
- Stop after the first reachable replay of an invalidated token and record the other transports as variants rather than repeating the evidence.

## Evidence Fields
- Token carrier, name, location, attribute list and length class; never the value.
- Flow position of each receipt and the identity label of the context that sent it.
- Pre-login versus post-login identifier equality, as a yes or no.
- Replay outcome with status and the protected effect observed or its absence.
- Measured wait, the bound set in advance and the policy it was compared with, with provenance.
- Coverage state and the reason for any card not run.

## Gaps
Tokens held in browser storage, browser-side cookie defaults, single sign-off across providers, long idle or absolute timeouts, distributed session stores that differ per node, and sessions carried over WebSocket stay unverified without the matching transport or source. A clean result covers the controlled accounts and the flow positions tested.

## Handoffs
Provide the token inventory, the sequence receipts, the replay results and the policy used for each comparison. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web deployment hygiene](../web-deployment-hygiene/SKILL.md) for the transport and header side, [authorization auditing](../authorization-auditing/SKILL.md) for what an accepted token may do, or [remediation](../remediation/SKILL.md) for session fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the session management guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
