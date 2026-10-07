---
name: web-object-authorization
description: Test whether a principal can reach an object, field, tenant, or delegated action outside the intended policy, using a source policy matrix and controlled local reproduction before any live comparison. Use for application-level authorization review.
---

# Web Object Authorization

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when an action selects a specific object, field, tenant, or delegated role, and the question is whether the effective policy binds that selection to the acting principal. Source review covers handler-level ownership checks, list and export filters, serializer field policy, nested-object policy, batch handlers, and asynchronous consumers. Offline reproduction covers policy functions that can be exercised against controlled objects with a local runtime. Deferred while the corresponding capability is absent: a live two-account HTTP comparison over authenticated requests. A second transport is optional variant coverage; one reachable unauthorized protected effect is enough to establish the policy question.

## Workflow Prerequisites
- `source-review` requires `source.snapshot`. Trace the effective decision and its operands in the supplied revision.
- `offline-reproduction` requires `shell.offline`, with the local runtime reported as `tool.python` after a bounded probe. Exercise an extracted policy function against controlled objects in a local harness.
- `controlled-identity-comparison` requires `http.authenticated`. Local HTTP without a controlled authenticated identity does not satisfy this workflow; without the capability, keep the candidate at a static trace and record the dynamic gap explicitly.
- A framework permit or scope annotation is a review lead, not proof that the effective action is authorized; confirm the code path that runs.

## Baseline
Establish two expected outcomes with controlled objects. The owner acting on its own object must succeed through the normal endpoint or policy function. The same actor requesting the same action on a controlled foreign object, tenant, or field must be denied by a specific policy location. Record where the decision runs relative to object retrieval and the protected effect, and keep the object identifiers and identities in the ledger so every later comparison uses the same fixtures.

## Bounded Comparison
Change exactly one variable per comparison: acting principal, object owner, tenant binding, requested field, action verb, or representation of the same identifier. Use only controlled objects created for the assessment; never survey real customer records to find a target. When only local reproduction is available, call the policy function directly with the substituted actor/object pair and compare the returned decision and the effect it guards. Promote a candidate to confirmed only when the unauthorized protected effect is observed, not merely when a handler returns success or a UI element appears.

## Controls
- Positive control: the protected action must fail for a principal that lacks the required grant, with the denial attributable to the named policy location rather than to a missing route or a broken fixture.
- Negative control: the same action must succeed for an authorized principal on its own controlled object, proving the harness and the route both work.
- Fail-open control: where an authorization dependency can be unavailable or raise, observe whether the failure path denies or continues, without exhausting shared production resources.
- Representation control: top-level and nested forms of the same field or object must obey the same policy; a difference is a variant observation, not a second finding by itself.

## Expected Observations
A principal-object-action matrix with the expected decision, the observed decision, the policy location, the protected effect, and the evidence identifier for each cell. Mark cells that could not be exercised in the current environment as not tested. Distinguish a policy denial from a null or empty response that simply hides a record; compare against the owner's own view to establish whether the data was withheld rather than absent.

## False-Positive Checks
- Objects that are public or intentionally shared, where the same content is available to every principal.
- Soft-private records whose content is already exposed through another documented surface.
- Empty arrays or null responses that indicate silent enforcement rather than successful access.
- Idempotent metadata lookups that reveal no protected content or state.
- A privileged-by-design administrative or service interface that is powerful but intended.
- UI-only restrictions mistaken for server-side policy, or the reverse.
- A fixture object that turned out to be owned by the acting principal.

## Stop Conditions
- Stop when the objects or identities are not controlled for the assessment.
- Stop before any destructive, financial, or externally visible mutation that a separate scope has not approved.
- Stop after the first reachable unauthorized protected effect and record the remaining transports as variant coverage rather than duplicating the same evidence.
- Stop when the denial cannot be attributed to a policy location; record an open proof gap instead of claiming safety.

## Evidence Fields
- Principal identity label and the capability it represents.
- Object identity, owner, tenant, and fixture provenance.
- Requested action and target field or representation.
- Expected decision, observed decision, and the policy location responsible.
- Protected effect observed, or the explicit absence of one.
- Proof level: static trace, offline reproduction, or live reproduction.
- Coverage state and the reason for any untested cell.

## Gaps
Live authenticated cross-principal comparison remains unverified without the approved transport and controlled identities. Batch handlers, import and export pipelines, background jobs, cache-backed responses, and channel operations need their own reachable path before they can be closed. A static policy matrix proves only the code path that was read; unresolved dispatch, dynamic permission composition, and environment-dependent configuration stay open.

## Handoffs
Provide the matrix, controlled fixtures, policy locations, observed effects, and untested cells. Next: [authorization auditing](../authorization-auditing/SKILL.md) for identity establishment and alternate interfaces, [remediation](../remediation/SKILL.md) for policy repair, or [web route and input inventory](../web-route-input-inventory/SKILL.md) when the missing input is a route map.

Matrix construction and variant placement detail lives in the [principal-object matrix](references/principal-object-matrix.md). This playbook adapts the reviewed object-authorization method; see [skill provenance](../../research/SKILL_PROVENANCE.md).
