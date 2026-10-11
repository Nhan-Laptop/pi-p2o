---
name: web-browser-trust-controls
description: Test what a server declares to a browser about cross-origin trust (CORS, framing, content policy, request-origin checks) and what client-side code does with untrusted input in a URL, style, resource reference, message or storage slot, mostly by reading headers and static script, never by running a live exploit in a real browser. Use when a response carries cross-origin headers or client-side script handles untrusted values. Covers WSTG SESS-05, CONF-12 and CLNT-04 to CLNT-07, CLNT-09 to CLNT-14.
---

# Web Browser Trust Controls

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when a response declares a cross-origin or framing policy to the browser (CORS headers, framing headers, a content security policy), when a state-changing request's origin should be checked server-side (CSRF, a WebSocket handshake), or when client-side script reads an untrusted value into a sink that a browser would act on (a redirect target, a style value, a resource reference, a cross-document message, browser-held storage, a new-tab link). Two evidence ceilings apply throughout: a declared server-side policy or check is confirmed directly, by reading the header or by a same-origin request that exercises the check; what a browser would then do with that policy needs a browser oracle this library does not provide, so it stays `offline_reproduction` at most, never `live_reproduction`, unless a separately authorized browser transport exists for this task.

## Test Cards
- [Cross-origin and framing policy](references/cross-origin-and-framing-policy.md): wstg-conf-12, wstg-clnt-07, wstg-clnt-09, wstg-clnt-13.
- [Request-origin enforcement](references/request-origin-enforcement.md): wstg-sess-05, wstg-clnt-10.
- [Client-side navigation and resource sinks](references/client-side-navigation-and-resource-sinks.md): wstg-clnt-04, wstg-clnt-05, wstg-clnt-06, wstg-clnt-15.
- [Messaging, storage and outbound links](references/messaging-storage-and-outbound-links.md): wstg-clnt-11, wstg-clnt-12, wstg-clnt-14.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Read client-side script for how it handles untrusted values, and server code for origin and policy checks.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Render a local, static copy of a page or script to confirm a parsing or sink question that does not need live interactivity, after a real probe confirms the runtime.
- `public-http-review` requires authorized same-origin requests through the scoped HTTP client. Read declared headers and exercise a server-side origin check with request headers you control; this cannot observe what a browser does with the response.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Record the declared policy headers (CORS, framing, content security policy) on a small representative set of routes, and the server's handling of a state-changing request sent with and without the origin indicator a browser would normally attach. For client-side sinks, record the untrusted value's source and the exact sink it reaches in the script, from source.

## Bounded Comparison
Change one declared value at a time: the request's origin indicator, one CORS or framing header's presence, one client-side value's content in a way that stays within the single sink it already reaches (never one that would need a browser to prove downstream effect). Compare the server's response or the script's branch taken against the baseline.

## Controls
- Positive control: a request from the application's own origin, or with the application's own declared value, succeeds, proving the harness and the route work.
- Negative control: a request with a missing or mismatched origin indicator, or a value the policy should reject, is refused, showing the check runs at all before a subtler variant is tried.
- Declaration control: where a policy is read from a header, confirm it is the enforced header and not a report-only or deprecated variant with no enforcement effect.

## Expected Observations
The declared headers per route; the server's accept/reject decision for each origin-indicator comparison; for client-side sinks, the source-to-sink trace with the exact line of the sink call; whether a browser-level claim is backed only by `offline_reproduction` or by a separately authorized `live_reproduction` transport, stated explicitly either way.

## False-Positive Checks
- A report-only policy header, mistaken for an enforced one.
- A wildcard or permissive header on a response that carries no sensitive data, which is lower exposure than the same header on a sensitive response.
- A sink that receives an untrusted value but only after it passes through a library function that neutralizes it for that sink, confirmed in source.
- A framing or origin header stripped or added by an intermediary rather than by the application itself.

## Stop Conditions
- Stop before constructing a working cross-origin page, a real clickjacking frame, or any artifact meant to be loaded by a real victim browser; this card confirms server-declared policy and client-side source structure, not a live browser exploit chain.
- Stop before sending a state-changing request to a route this task's scope does not separately authorize for mutation.
- Stop after the first confirmed gap between declared policy and server enforcement per card.
- Stop before reading or writing another principal's browser-held storage or message traffic.

## Evidence Fields
- Route and the declared policy header values observed.
- Origin-indicator comparison requests and their receipts.
- For client-side sinks, the source location of the untrusted value's entry and the exact sink line.
- Proof level stated explicitly: `static_trace`, `offline_reproduction`, or `live_reproduction` only when a separately authorized browser transport was used.
- Coverage state and the reason for any card not run.

## Gaps
Whether a declared policy actually stops a real browser from doing the thing it is meant to prevent is unverified without a separately authorized browser transport; this playbook's live ceiling is the server's own declared policy and enforcement, not the browser's reaction to it. Script loaded dynamically at runtime, and behavior that differs across browser implementations, stay unverified by source review alone.

## Handoffs
Provide the declared policy per route, the origin-comparison receipts, the source-to-sink traces, and the proof level for each. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web output context](../web-output-context/SKILL.md) when a sink's encoding context (not just its trust boundary) is the open question, [web deployment hygiene](../web-deployment-hygiene/SKILL.md) for header hygiene unrelated to cross-origin trust, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the client-side and cross-origin guidance of the OWASP Web Security Testing Guide in this library's evidence terms, replacing live-browser exploitation walkthroughs with declared-policy reading and source structure; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
