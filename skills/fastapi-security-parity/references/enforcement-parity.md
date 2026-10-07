# Enforcement parity notes

Applied detail for [FastAPI security parity](../SKILL.md). Each check ends with either a confirmed effective control, a named gap, or an open proof question.

## Resolve the application graph

Start at the application factory and walk outward. Record each `include_router` call with its prefix, tags, and dependencies, then each route decorator with its own dependencies and `include_in_schema` value. Identify mounts for static files, administrative interfaces, metrics, and documentation, and note where middleware is added relative to the mounts. The effective route and the effective dependency list at the handler are the only ones that matter; a declaration that is overridden by a later registration or prefix is not the control that runs.

## Dependency path record

For each route under review, write the path from the application object to the handler and list, in execution order, every dependency, middleware, and outer gateway decision that can reject the request. Distinguish dependencies that parse identity from those that verify it, and record the operand each one uses. A dependency that returns a decoded claim without checking its signature is an identity parser; the verification must be shown elsewhere or the route is unprotected. When a dependency is attached at the router level, confirm that later route additions inherit it rather than assuming the convention holds.

## Mounted applications

A mounted sub-application is a separate application object with its own middleware stack. Confirm for each mount whether the parent authentication middleware, session middleware, exception handlers, and permission dependencies run for requests inside the mount, and record the evidence rather than the layout. Also check path handling around the mount boundary: a prefix that is stripped, normalized, or redirected can change the effective path seen by the mounted application and by any proxy rule.

## Identity and session behavior

Trace how the bearer token, cookie, or session value becomes the acting principal. Confirm signature verification, issuer and audience checks, request binding, expiry, and the point at which the principal is attached to the request state. For cookie-based flows, check origin and CSRF handling separately from authentication. A successful parse that leaves the principal unverified, or a session that survives a privilege change, is a candidate rather than a proven bypass until the protected effect is reached.

## Asynchronous and channel consumers

List background tasks, queue consumers, webhooks, and scheduled jobs that act on stored identifiers. For each, record whether the consumer re-establishes the acting principal and re-checks ownership at execution time, and whether the same policy function as the request-time path is used. For WebSocket and streaming endpoints, verify per-message authorization and channel binding after the handshake, not only the handshake itself.

## Configuration the finding depends on

State the network boundary, proxy behavior, and middleware configuration that the observation assumes. A header-trust control is only valid inside the boundary that strips client-supplied values; a host check only matters when absolute URLs are generated from the request. Record the configuration source, and mark any deployment where it could differ as unverified.

## Recording parity

Produce one row per effective route with the identity requirement, the enforcing path, the mounted/middleware context, the evidence identifier, and the coverage state. An uncovered route with no protected effect is still a parity gap worth reporting; an uncovered route with a protected effect is a candidate that needs the standard authorization evidence. Neither is a blanket statement about the framework.

Adapted from the reviewed framework playbook, excluding its bypass catalogue, outbound-request probing, payload sets, and version-advisory blanket claims. See [skill provenance](../../../research/SKILL_PROVENANCE.md).
