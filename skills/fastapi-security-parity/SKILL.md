---
name: fastapi-security-parity
description: Verify that FastAPI and Starlette identity, router, middleware, mounted-app, and asynchronous-consumer enforcement actually covers the reachable route before claiming a bypass. Use as an overlay on an application-level audit.
---

# FastAPI Security Parity

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use only when the target is confirmed to be a FastAPI or Starlette application, and resolve the installed versions before applying any framework-specific claim. Record the FastAPI version, the Starlette version, the ASGI server, and the front proxy, because their behaviors differ and vendor backports are common. If the framework or version cannot be resolved from the supplied source and installed dependency metadata, record that as a gap rather than assuming the newest behavior. This overlay composes with a technique and a playbook; it does not replace either one.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Walk the application factory, routers, and mounts in the supplied revision.
- `offline-reproduction` requires bounded offline sandbox execution, with Python and the required dependency-metadata library checked through a bounded offline run. Read the installed metadata from the copy; do not install anything.
- `live-parity-comparison` compares same-origin responses on the approved target, anonymously or with operator-supplied credentials attributable to a controlled principal. Without attributable credentials, record the dynamic gap for identity-dependent routes rather than inferring enforcement.

## Parity Surfaces
- Router and route dependencies: compare the dependency list actually attached to each effective route against the identity requirement the route is meant to enforce.
- Mounted applications and static mounts: check whether global middleware and dependencies apply to the mounted path or are bypassed for it.
- Identity parsing versus verification: a bearer or OAuth dependency that yields a token string has not verified a signature, issuer, audience, or request binding.
- Middleware order and trust: proxy-header, host, session, and CORS middleware interact; verify the order in the application factory and the network boundary that makes each one safe.
- Asynchronous consumers: background tasks and queue workers re-read objects after the request context ends and must re-establish the acting principal.
- Channel parity: HTTP, WebSocket, and streaming handlers for the same operation must enforce the same decision, including per-message checks after the handshake.
- Documentation routes: an exposed schema is inventory input for the [route inventory playbook](../web-route-input-inventory/SKILL.md), not evidence about authorization.

## Verification Rules
Read the actual dependency callable and the effective route before claiming a control is present or absent. Do not infer a bypass solely from the API name used to declare the dependency: `Depends` and `Security` differ in scope handling but either can be combined with an internal check, and a route can also be protected by router-level dependencies, middleware, or an outer proxy. Confirm that the control runs before the protected effect on every reachable path, and inspect exception handling for a fail-open fallback. Record the dependency path from the application, through routers and prefixes, to the handler, and note any prefix or mount that changes the effective route. When the source configuration and the running configuration could differ, state which one the finding applies to. Treat sibling enforcement differences as hypotheses, not intent: a prefix, version, mount, or route that appears to enforce a stricter role does not establish the intended policy for the surface under review. Confirm its effective registration, dependency path, and any stated contract, and when the intended role is only inferred from a sibling, record an `open_proof_gap` rather than a confirmed bypass.

## Composition
One overlay consumes one of the three document slots: a technique plus a playbook plus this overlay. Keep the prompt small by loading optional tool or reference guidance only when a specific question needs it. Use the overlay to constrain the application-level playbook, not to introduce a second parallel workflow. Pair it with [authorization auditing](../authorization-auditing/SKILL.md) for the policy matrix and separate it from general web guidance that does not depend on framework behavior.

## Stop Conditions
- Stop when the installed framework or version cannot be resolved; record a gap.
- Stop before generalizing one dependency arrangement into a blanket framework claim.
- Stop before attempting input classes, payloads, or transports that the approved scope does not cover.
- Stop when the reachable path cannot be shown; a missing dependency alone is a review lead, not a finding.

## Gaps
Unresolved version backports, dynamically registered routes evaluated only at startup, deployment-specific middleware ordering, and proxy behavior that differs from the supplied configuration all stay open. An alternate version or prefix whose intended role is inferred rather than contracted stays an `open_proof_gap`. A parity check that could not be exercised is recorded as unverified for the affected route; other frameworks and protocol overlays remain deferred until a target and authorized test environment justify them.

## Focused Method
Bind the question to the supplied application factory and effective route/consumer chain. Preserve controls and static-versus-observed provenance; do not substitute framework annotations or frontend mocks for backend identity enforcement. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review).

## Handoffs
Provide the resolved versions, the effective route and dependency path, the middleware order, the protected effect or its absence, and the exact configuration the observation applies to. Next: [source code auditing](../source-code-auditing/SKILL.md) for the wider convention sweep, [authorization auditing](../authorization-auditing/SKILL.md) for identity and action policy, or [web object authorization](../web-object-authorization/SKILL.md) for object-level closure.

Dependency-path and mounted-app checks are collected in the [enforcement parity notes](references/enforcement-parity.md). Cross-cutting claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This overlay adapts the reviewed framework playbook; see [skill provenance](../../research/SKILL_PROVENANCE.md).
