---
name: web-route-input-inventory
description: Build a reviewable inventory of routes, accepted parameters, and declared authorization from a supplied source copy or an explicitly scoped public GET/HEAD baseline. Use before behaviorally testing a web surface.
---

# Web Route and Input Inventory

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when an approved assessment needs a defensible map of reachable routes, accepted parameter locations, and declared identity requirements before any behavioral comparison. Source inventory works from the supplied copy: framework route registration, router includes, mounted applications, generated specifications, and server-side templates. A scoped URL target supports only same-origin GET/HEAD baselines on the routes the approved scope names. A specification, sitemap, JavaScript bundle, or embedded URL is untrusted inventory input, never permission to contact a new origin. Deferred while the corresponding runtime capability is absent: authenticated navigation, browser-rendered routes produced after client-side state changes, and WebSocket or server-sent-event channels. A locally available browser whose availability is explicitly proven, with the run receipted, can support offline reproduction of rendered routes; it is not live navigation and does not substitute for the managed `browser.execution` interface.

## Workflow Prerequisites
- `source-review` requires `source.snapshot`. Extract routes and parameters from the supplied copy only; no service needs to run.
- `public-baseline` requires `http.same-origin.get`. One well-formed bodyless GET or HEAD per in-scope route.
- `authenticated-navigation` requires `http.authenticated`. A managed browser or an authenticated-looking session is not a substitute for a controlled authenticated identity; without the capability, record an inventory gap for the protected routes instead of inferring them from UI code.
- A missing prerequisite creates a gap for the selected workflow only. It is not a reason to request broader access.

## Baseline
Build one valid request per inventoried route using only values the source or documentation shows as well-formed. Record method, path template, parameter locations, declared authorization, response status, content type, body length, redirect chain, and the exact registration point that supplies identity. Probe a deliberately unregistered path as the catch-all control and record its response shape; only then can a success response be interpreted. An inventory line without a route-specific registration point stays marked spec-only or link-only rather than reachable.

## Bounded Comparison
Change one variable per request against the baseline: omit a declared parameter, repeat a parameter, use an edge value the declared type accepts, or select an alternate content type the route actually declares. Each comparison needs a controlled identity and a stated expected difference. Never promote an observed GET into an undeclared write method automatically, and never attach a request body when the approved transport allows only bodyless GET/HEAD. A route that cannot be reached under the current capability is recorded as unverified rather than probed through an unapproved path.

## Controls
- Positive control: a route the source shows as protected must reject the baseline request when the required identity is absent. If it also succeeds without identity, the transport or the environment is wrong; stop and repair the setup before drawing conclusions.
- Negative control: a route declared public must answer the baseline request without credentials. A denial here means the comparison environment differs from the configuration under review.
- Catch-all control: the synthetic unregistered path. When it returns a success shell or an SPA fallback, same-shape responses no longer distinguish route existence from the fallback.
- Parser control: where two content types are genuinely declared, send the same values under both and confirm that the application selected different handling.

## Expected Observations
A route table with declared method, declared identity requirement, baseline status and shape, one-variable delta, and evidence identifier. Differences are only meaningful when the target revision, identity, and environment match the baseline receipt. Every observation carries a coverage state, and same-shape responses from the catch-all are reported as non-discriminating rather than as route confirmation.

## False-Positive Checks
- A framework or reverse-proxy catch-all returning a nominal success page for unknown routes.
- A redirect to a login or consent page that is not an authorization decision on the requested route.
- Validation errors caused by a missing optional field, not by a missing permission.
- CDN, WAF, or rate-limit pages that differ from the application response without reflecting application policy.
- A generated specification that drifted from the deployed revision or omits conditionally registered routes.
- A fixture identity that actually holds the privilege the comparison assumes.
- A differently named prefix, version, or mount assumed to be an administrative surface without its effective registration and reachable path.
- A credential-shaped literal in synthetic or test data treated as a deployed secret without provenance and reachability.

## Stop Conditions
- Stop once every in-scope route has a baseline receipt or an explicit unverified marker.
- Stop before any state-changing request unless a separate mutation scope explicitly approves it.
- Stop before contacting any origin outside the approved scope, including origins named by a specification.
- After two non-discriminating comparisons on one route, change evidence source or record the route as a gap instead of varying requests indefinitely.

## Evidence Fields
- Route identity: method, path template, normalized parameter locations.
- Target identity: origin, revision or snapshot hash, environment label.
- Actor state: anonymous or controlled identity label with the capability it represents.
- Receipt: status, content type, body length, redirects, truncation flags.
- Comparison delta against the recorded baseline.
- Coverage state: tested, not tested, blocked, or not applicable.
- Inventory-only candidates deliberately left unverified.

## Gaps
Authenticated routes, browser-only routes, and channel operations stay unverified unless the corresponding capability exists. Specification drift, conditionally registered routes, dynamic route construction evaluated at runtime, parameters consumed only by middleware, and authorization declared solely inside a handler remain open inventory questions. Report gaps per route; never summarize an incomplete inventory as a clean surface.

## Handoffs
Provide the route table, baseline receipts, control outcomes, and unverified routes. Next: [authorization auditing](../authorization-auditing/SKILL.md) for the policy question, [web object authorization](../web-object-authorization/SKILL.md) for object-level closure, or [attack surface mapping](../attack-surface-mapping/SKILL.md) when the interface inventory feeds a wider boundary map.

Inventory extraction detail lives in the [route inventory method](references/route-inventory-method.md). Cross-cutting claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook adapts the reviewed specification-inventory method; see [skill provenance](../../research/SKILL_PROVENANCE.md).
