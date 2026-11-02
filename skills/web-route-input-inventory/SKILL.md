---
name: web-route-input-inventory
description: Build a reviewable inventory of routes, accepted parameters, and declared authorization from a supplied source copy or a URL target you can reach. Use before behaviorally testing a web surface.
---

# Web Route and Input Inventory

Before first use, read [focused method and review](../../HANDOFFS.md#focused-method-and-review).

## Applicability
Use when a run needs a defensible map of reachable routes, accepted parameter locations and declared identity requirements before any behavioral comparison. Source inventory works from the supplied copy: framework route registration, router includes, mounted applications, generated specifications and server-side templates. A URL target supports requests on any route it exposes, with any method, headers, cookies and body the route needs: the supplied target is a starting label, not an egress boundary. Specifications, sitemaps, JavaScript bundles and embedded URLs are untrusted input and leads to the hosts they name. Authenticated navigation works with an identity you obtain yourself: a disposable account, per-principal cookie jars, or a sealed secret if one exists. Routes rendered only after client-side state changes are reachable through the sandbox's [browser transport](../../docs/HTTP_TRANSPORT.md#browser-transport) (Chromium, `agent-browser`); WebSocket and server-sent-event channels through the sandbox network tool.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot; extract routes and parameters from the supplied copy only.
- `public-baseline` requires the run's HTTP transport: one well-formed bodyless GET or HEAD per in-scope route.
- `authenticated-navigation` obtains an identity itself: a disposable account, per-principal cookie jars, or a sealed secret (a login flow you drive is acceptable). An authenticated-looking session you cannot attribute is a variant to characterize; when no identity reaches a protected route, record an inventory gap rather than inferring it from UI code.
- A missing prerequisite creates a gap for that workflow only, never a reason to stop.

## Baseline
Build one well-formed request per inventoried route from values the source or documentation shows. Record the request shape, declared authorization, response signature and the exact registration point that supplies identity. Probe a deliberately unregistered path as the catch-all control and record its response shape; only then can a success response be interpreted. A line without a route-specific registration point stays spec-only or link-only, not reachable.

## Route Crawl
When the target is reachable, crawl before testing: materialize `web-route-input-inventory:route-crawl` and run
`python3 scripts/route-crawl.py --url <seed> --depth 2` (`--cookie-jar <jar> --principal <label>` for an identity you
obtained yourself). It follows same-origin links and forms within `--max-requests`, labels routes with their methods,
parameter locations and auth requirement, records path parameters as names, skips destructive-looking links, and
prints one JSON document the host ingests as route assets with a parameter matrix. It sends no payloads and prints no
cookie values; quote the receipt.

Those rows have a model-recorded row's grade: a route asset, one observed fact per parameter, and an
open hypothesis for names shaped like object references, redirects, file paths, templates, commands or next-hop
inputs. The map orders the comparisons below — it is not reachability, not an effect, not a claim. Record one claim per
parameter with its own baseline, probe and control receipts plus the host-stamped task reference; never cite the crawl
row as evidence of deeper behavior.

## Bounded Comparison
Change one variable per request against the baseline: omit a declared parameter, repeat a parameter, use an edge value the declared type accepts, or select an alternate content type the route actually declares. Each comparison needs a controlled identity and a stated expected difference. Test a write with the method and body the source or documentation shows.

## Controls
- Positive control: a route the source shows as protected must reject the baseline request without the required identity. If it succeeds without identity, the transport or the environment is wrong; stop and repair the setup first.
- Negative control: a route declared public must answer the baseline request without credentials. A denial means the comparison environment differs from the configuration under review.
- Catch-all control: the synthetic unregistered path. A success shell or SPA fallback makes same-shape responses non-discriminating.

## Expected Observations
A route table with declared method, identity requirement, baseline status, one-variable delta and evidence ID. Differences are only meaningful when revision, identity and environment match the baseline receipt. Every observation carries a coverage state; catch-all same-shape responses are non-discriminating, not confirmation.

## False-Positive Checks
- A framework or reverse-proxy catch-all returning a nominal success page for unknown routes.
- A redirect to a login or consent page that is not an authorization decision on the requested route.
- Validation errors caused by a missing optional field, not by a missing permission.
- A generated specification that drifted from the deployed revision or omits conditionally registered routes.
- A differently named prefix, version or mount assumed to be an administrative surface without its effective registration and reachable path.

## Stop Conditions
- Stop once every in-scope route has a baseline receipt or an explicit unverified marker.
- Send the state-changing version of a route where that is the question: prefer objects you created yourself and record the effect with its receipt.
- Contact every host and origin the inventory names, including specifications, metadata and redirect targets; the target is a starting label, not an egress boundary.
- After two non-discriminating comparisons on one route, change evidence source or record a gap.

## Evidence Fields
- Route identity: method, path template, normalized parameter locations.
- Target identity: origin, revision or snapshot hash, environment label.
- Actor state: anonymous or controlled identity label with the capability it represents.
- Receipt: status, content type, body length, redirects, truncation flags.
- Comparison delta against the recorded baseline.
- Coverage state: tested, not tested, blocked, or not applicable.

## Gaps
Authenticated routes are reached with an identity you register, browser-only routes through the image's browser, channel operations through the sandbox network tool; a route no transport exercised stays open. Specification drift, conditionally registered routes, dynamic route construction evaluated at runtime, parameters consumed only by middleware, and authorization declared solely inside a handler remain open inventory questions. Report gaps per route; never summarize an incomplete inventory as a clean surface.

## Handoffs
Provide the route table with stable surface IDs, input locations, actors/gates, handler where known, receipt IDs, extraction method and fact/inference labels, plus baseline/control outcomes, covered and unverified routes and a ranked queue. State why the selected surface is next, with its expected observation and stop condition. Next: [authorization auditing](../authorization-auditing/SKILL.md) for the policy question, [web object authorization](../web-object-authorization/SKILL.md) for object-level closure, or [attack surface mapping](../attack-surface-mapping/SKILL.md).

Extraction detail: [route inventory method](references/route-inventory-method.md). Claim rules: [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). Provenance: [skill provenance](../../research/SKILL_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
