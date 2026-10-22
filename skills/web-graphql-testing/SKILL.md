---
name: web-graphql-testing
description: Test a GraphQL endpoint's own configuration surface, separate from the field-level authorization and parameter-injection questions that belong to other skills, covering schema exposure, a reachable debug interface, and query depth, complexity and batch bounds. Use when an endpoint accepts GraphQL queries. Covers WSTG APIT-99.
---

# Web GraphQL Testing

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when an endpoint accepts GraphQL queries. This skill owns only what is specific to GraphQL as a query layer: schema self-description, a reachable development interface, and the bounds a server places on query shape. Field-level access control (can this principal read or write this field) belongs to [web object authorization](../web-object-authorization/SKILL.md); a resolver argument reaching an injection-prone sink belongs to [web server-side injection](../web-server-side-injection/SKILL.md); output-encoding questions belong to [web output context](../web-output-context/SKILL.md). This card hands off to those rather than re-testing their questions through GraphQL syntax.

## Test Cards
- [Schema exposure and query bounds](references/schema-exposure-and-query-bounds.md): wstg-apit-99.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Read the server's introspection, depth/complexity and batching configuration.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Reproduce the schema configuration against a local, disposable copy of the server, after a real probe confirms the runtime.
- `public-http-review` requires authorized same-origin requests through the scoped HTTP client. A small, fixed set of bounded queries against the confirmed origin; never a query sized to exhaust server resources.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Confirm the endpoint accepts GraphQL by sending one minimal, well-formed query for a field the operator or documentation names as public, and record the response shape.

## Bounded Comparison
Each check below is independent and uses at most a handful of requests; none needs to be repeated or escalated once it has an answer.

## Controls
- Positive control: the baseline minimal query succeeds, proving the endpoint and harness work.
- Negative control: a deliberately malformed query is rejected with an error, showing the server parses and validates before any configuration question is read.
- Bound control: a query whose depth or complexity is just over any documented limit is rejected, confirmed before concluding a limit is absent rather than merely untested at that size.

## Expected Observations
Whether the introspection query is answered and in what detail; whether a development or exploration interface responds; whether a query nested one level beyond a documented or default depth limit, a batch of a handful more operations than any documented limit, or a query requesting a slightly higher alias count than default is accepted or rejected.

## False-Positive Checks
- Introspection enabled only in a development deployment that is not the one in scope.
- A development interface that requires its own separate authentication, observed as a login prompt rather than direct access.
- A bound that rejects at a slightly different threshold than documented, which is a hygiene note, not a missing-bound finding.

## Stop Conditions
- Stop at the first query that exceeds a bound by the smallest margin needed to show the bound is missing or too high; never scale a query up to actually exhaust resources.
- The field-level authorization or injection test this endpoint's schema points to belongs to the owning skill: plan it there and run it there rather than running it from this card.
- Stop before accessing a reachable development interface beyond confirming it responds.

## Evidence Fields
- The baseline query and response shape.
- Introspection and development-interface reachability, each with its receipt.
- The depth, complexity and batch-size checks with their receipts and the margin used.
- Coverage state and the reason for any check not run.

## Gaps
Whether an exposed schema or a missing bound is then exploited through a field-level authorization gap or an injection-prone resolver argument is answered by the skills this card hands off to, not by this one. A production deployment's actual resource limits under real load are unverified without a load test this task is not authorized to run.

## Handoffs
Provide the introspection and development-interface findings, the bound checks and their receipts, and a list of fields worth a field-level authorization pass. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web object authorization](../web-object-authorization/SKILL.md) for field-level access control, [web server-side injection](../web-server-side-injection/SKILL.md) for a resolver argument reaching an interpreter, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the GraphQL-specific guidance of the OWASP Web Security Testing Guide in this library's evidence terms, routing its injection and authorization sections to the skills that already own those questions; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
