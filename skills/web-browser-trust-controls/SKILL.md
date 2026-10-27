---
name: web-browser-trust-controls
description: Test what a server declares to a browser about cross-origin trust (CORS, framing, content policy, request-origin checks) and what client-side code does with untrusted input in a URL, style, resource reference, message or storage slot, mostly by reading headers and static script, then by building the browser-side chain that declared policy permits on the target. Use when a response carries cross-origin headers or client-side script handles untrusted values. Covers WSTG SESS-05, CONF-12 and CLNT-04 to CLNT-07, CLNT-09 to CLNT-15.
---

# Web Browser Trust Controls

Before first use: [scope baseline](../../README.md#start-here), [handoff method](../../HANDOFFS.md#focused-method-and-review), and [owner review](../../HANDOFFS.md#provisional-owner-review).

## Applicability
Use when a response declares a cross-origin or framing policy to the browser (CORS headers, framing headers, a content security policy), when a state-changing request's origin should be checked server-side (CSRF, a WebSocket handshake), or when client-side script reads an untrusted value into a sink that a browser would act on (a redirect target, a style value, a resource reference, a cross-document message, browser-held storage, a new-tab link). A declared server-side policy or check is confirmed directly, by reading the header or by a request that exercises the check. What a browser then does with that policy is executable in this run through the sandbox image's Chromium and `agent-browser` ([browser transport](../../docs/HTTP_TRANSPORT.md#browser-transport)); a browser-side effect observed there is `live_reproduction`, and `static_trace` and `offline_reproduction` remain valid where that is all the question needs.

## Test Cards
- [Cross-origin and framing policy](references/cross-origin-and-framing-policy.md): wstg-conf-12, wstg-clnt-07, wstg-clnt-09, wstg-clnt-13.
- [Request-origin enforcement](references/request-origin-enforcement.md): wstg-sess-05, wstg-clnt-10.
- [Client-side navigation and resource sinks](references/client-side-navigation-and-resource-sinks.md): wstg-clnt-04, wstg-clnt-05, wstg-clnt-06, wstg-clnt-15.
- [Messaging, storage and outbound links](references/messaging-storage-and-outbound-links.md): wstg-clnt-11, wstg-clnt-12, wstg-clnt-14.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Read client-side script for how it handles untrusted values, and server code for origin and policy checks.
- `offline-reproduction` requires execution in your own sandbox scratch. Render a local copy of a page or script, or drive the image's Chromium through `agent-browser` in a named session kept in your scratch; render a parsing or sink question locally and record `live_reproduction` when the browser observed the effect.
- `public-http-review` requires the run's HTTP transport. Read declared headers and exercise a server-side origin check with request headers you control; the image's Chromium observes what a browser then does with the response.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Record the declared policy headers (CORS, framing, content security policy) on a small representative set of routes, and the server's handling of a state-changing request sent with and without the origin indicator a browser would normally attach. For client-side sinks, record the untrusted value's source and the exact sink it reaches in the script, from source.

## Bounded Comparison
Change one declared value at a time: the request's origin indicator, one CORS or framing header's presence, one client-side value's content, driving it through the image's Chromium when the downstream effect needs a browser. Compare the server's response or the script's branch taken against the baseline.

## Controls
- Positive control: a request from the application's own origin, or with the application's own declared value, succeeds, proving the harness and the route work.
- Negative control: a request with a missing or mismatched origin indicator, or a value the policy should reject, is refused, showing the check runs at all before a subtler variant is tried.
- Declaration control: where a policy is read from a header, confirm it is the enforced header and not a report-only or deprecated variant with no enforcement effect.

## Expected Observations
The declared headers per route; the server's accept/reject decision for each origin-indicator comparison; for client-side sinks, the source-to-sink trace with the exact line of the sink call; whether a browser-level claim is backed by `static_trace`, `offline_reproduction`, or `live_reproduction` observed through the image's browser, stated explicitly either way.

## False-Positive Checks
- A report-only policy header, mistaken for an enforced one.
- A wildcard or permissive header on a response that carries no sensitive data, which is lower exposure than the same header on a sensitive response.
- A sink that receives an untrusted value but only after it passes through a library function that neutralizes it for that sink, confirmed in source.
- A framing or origin header stripped or added by an intermediary rather than by the application itself.

## Stop Conditions
- Build the cross-origin page or clickjacking frame and load it through the image's browser in a named session; the effect observed there is the working chain behind the declared policy.
- Send the state-changing request to the route under test: state-changing requests are in scope, so prefer objects you created yourself and record the effect with its receipt.
- Record the first confirmed gap between declared policy and server enforcement per card, then carry the chain to what the gap permits.
- Read or write another principal's browser-held storage or message traffic where that is the question, using cookies and named sessions you self-provision; record what it reached.

## Evidence Fields
- Route and the declared policy header values observed.
- Origin-indicator comparison requests and their receipts.
- For client-side sinks, the source location of the untrusted value's entry and the exact sink line.
- Proof level stated explicitly: `static_trace`, `offline_reproduction`, or `live_reproduction` when the image's browser observed the effect.
- Coverage state and the reason for any card not run.

## Gaps
Whether a declared policy actually stops a browser from doing the thing it is meant to prevent is executable here: drive a page under the declared policy through the image's Chromium and record the browser's reaction. What stays untested is a browser implementation the run did not exercise, and script loaded only at runtime that no session reached.

## Handoffs
Provide the declared policy per route, the origin-comparison receipts, the source-to-sink traces, and the proof level for each. Next: [web output context](../web-output-context/SKILL.md) when a sink's encoding context (not just its trust boundary) is the open question, [web deployment hygiene](../web-deployment-hygiene/SKILL.md) for header hygiene unrelated to cross-origin trust, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the client-side and cross-origin guidance of the OWASP Web Security Testing Guide in this library's evidence terms, adding declared-policy reading and source structure on top of live-browser exploitation walkthroughs; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
