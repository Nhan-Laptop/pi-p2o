# Principal-object matrix

Operational detail for [web object authorization](../SKILL.md). Build the matrix before choosing tests, and keep every cell traceable to a controlled fixture.

## Matrix axes

Rows are principals: anonymous, ordinary user, delegated role, administrator, service account, and restricted process. Columns are objects or fields grouped by type and ownership. Cells hold the intended action rights for read, create, update, delete, export, and delegated action. Record the intended policy source for each cell, such as a role table, a tenant rule, or a documented administrative capability. A cell with no stated intention is a policy gap and belongs in the handoff rather than in an invented expectation.

## Tenant, batch, and export variants

Treat tenancy as an axis of the object, not as a property of the principal. Add columns for mixed-tenant rollups, shared workspaces, and delegated administration. Batch and bulk handlers often validate a wrapper request and then act on a list; add a row for a request that mixes owned and foreign identifiers and record per-element outcomes. Export, report, and backup endpoints frequently assemble data through a separate code path from the interactive view, so they need their own column instead of inheriting the single-object expectation.

## Background and asynchronous consumers

Jobs, queues, webhooks, and scheduled tasks re-read objects after the request that created them has ended. Add a row for each consumer and record whether it re-establishes the acting principal or trusts identifiers stored earlier. A background consumer that acts on an object without re-checking ownership is a separate reachable path even when the request-time handler is correct. Channel operations such as subscriptions, notifications, and streamed events follow the same rule: the check at handshake does not cover per-message object selection.

## Field and representation coverage

A single object can carry nested metadata, computed fields, or related entities whose policy differs from the parent. Split the column for each field class that has its own rule, and test create and update paths independently from read paths. When the same resource is accepted through several representations, such as a scalar and an array, a nested object and a flat form, or two content types, treat each representation as a separate cell and verify that the policy operands are the effective identity fields rather than a convenience copy.

## Local reproduction

When a policy function can be isolated, write a small harness that constructs controlled objects and calls the function with each principal. Assert the decision and the effect it guards, not only the return value, and keep every fixture creation and teardown in the ledger. A direct function call proves the decision logic on that path; it does not prove the route invokes it, so a later live or integration check is still required for the reachable path.

## Reading the result

A denial attributed to a named policy location is stronger evidence than any specific response code. A success on a foreign object is only an authorization candidate until the protected effect is observed and the object is confirmed to be outside the intended policy. When a cell cannot be exercised, record the environment and capability that were missing; do not collapse it into a pass.

Adapted from the reviewed object-authorization method, excluding automatic parameter-discovery tooling, cache and timing bypass recipes, header-spoofing guidance, bulk identifier harvesting, and post-exploitation chaining. See [skill provenance](../../../research/SKILL_PROVENANCE.md).
