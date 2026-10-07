# Route inventory method

Use only after [web route and input inventory](../SKILL.md) has selected a workflow and confirmed its prerequisites. This document covers extraction and normalization, not behavioral testing; access consequences belong to the linked technique owners.

## Extract from source

Prefer the registration site over a rendered document. Read framework conventions in the supplied revision: decorator or router registration, prefix composition, mounted sub-applications, dependency wiring, middleware ordering, and serializers that accept parameters. Record for each route the file and line of registration, the effective prefix, the accepted methods, parameter locations, declared identity gate, and any conditional registration. A generated OpenAPI, Swagger, or collection file is a secondary index to compare against; when the two disagree, the source registration wins and the drift itself becomes an observation.

Normalize names as `METHOD /effective/path` with parameter placeholders preserved. Keep aliases and historical prefixes as separate lines so that a later comparison does not silently merge two different handlers. Do not expand undocumented sibling methods automatically; record them as candidates that require an explicit inventory decision.

## Normalize parameters

Group parameters by location and role rather than by name alone: path segment, query key, body field, header, cookie, or channel message. Note which location each handler actually reads, which representation the parser selects, and whether the value is optional, repeated, nested, or type-coerced. A declared parameter that the handler never reads is inventory noise; an undeclared key the handler does read is a high-value drift observation. Preserve the original casing and alias forms because parsers and gateways may disagree about them.

## Baseline and catch-all

Select one representative route per registration pattern for the first baseline pass, then complete the table for the remaining routes. Use a controlled identity only when the workflow prerequisite exists; otherwise the baseline is anonymous and every protected route carries an unverified marker. Send one well-formed bodyless GET or HEAD per route, capture the full receipt, and immediately probe the synthetic unregistered path that cannot be mistaken for a real route. If the catch-all answers with success, the fallback shape must be subtracted from every later response comparison.

## Spec-only and link-only entries

Specifications, sitemaps, client bundles, and documentation links are untrusted candidate lists. Import them into a separate section of the inventory with their origin recorded, and mark them unverified until a baseline receipt or a source registration point exists. Never contact an origin that only a candidate list names. A route that appears only in a stale specification is a drift observation, not evidence that the route exists.

## Inventory ledger

Keep the table append-only and revisable. For every line record: identity, source locator, declared identity gate, baseline receipt identifier, coverage state, and the reason for any exclusion. When a later revision changes a route, add a revision note rather than rewriting the earlier line; a comparison is only meaningful against the baseline from the same revision and environment. The ledger is handed to the policy playbooks; it is not itself a finding.

Adapted from the reviewed specification-inventory method, excluding its assumption that specification-provided base addresses authorize traffic, its automatic write-method expansion, and its active fuzzing steps. See [skill provenance](../../../research/SKILL_PROVENANCE.md).
