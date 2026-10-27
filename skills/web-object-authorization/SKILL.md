---
name: web-object-authorization
description: Test whether a principal can reach an object, field, tenant, or delegated action outside the intended policy, using a source policy matrix and controlled local reproduction before any live comparison. Use for application-level authorization review.
---

# Web Object Authorization

Before first use: [scope baseline](../../README.md#start-here), [handoff method](../../HANDOFFS.md#focused-method-and-review), and [owner review](../../HANDOFFS.md#provisional-owner-review).

## Applicability
Use when an action selects a specific object, field, tenant, or delegated role, and the question is whether the effective policy binds that selection to the acting principal. Source review covers handler-level ownership checks, list and export filters, serializer field policy, nested-object policy, batch handlers, and asynchronous consumers. Offline reproduction covers policy functions that can be exercised against controlled objects with a local runtime. A live two-account comparison over authenticated requests is available with two principals you register yourself. A third identity or transport widens variant coverage; one reachable unauthorized protected effect is enough to establish the policy question.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Trace the effective decision and its operands in the supplied revision.
- `offline-reproduction` requires bounded offline sandbox execution, with the local runtime and required dependencies functionally checked through a bounded offline run. Exercise an extracted policy function against controlled objects in a local harness.
- `controlled-identity-comparison` obtains identities itself: register at least two disposable principals through the target's own signup flow, or use sealed secrets if they exist. An unauthenticated request or a session you cannot attribute is a variant to characterize; keep the candidate at a static trace only until the comparison runs.
- A framework permit or scope annotation is a review lead, not proof that the effective action is authorized; confirm the code path that runs.

## Baseline
Establish two expected outcomes with controlled objects: the owner acting on its own object must succeed through the normal endpoint or policy function, and the same actor on a controlled foreign object, tenant or field must be denied by a specific policy location. Record where the decision runs relative to object retrieval and the protected effect, and keep identifiers and identities in the ledger for later comparisons.

Intended-policy provenance comes first: name the contract, documented role or ownership rule, or policy location that makes the expectation true; a convention or sibling operation is a hypothesis, not provenance. Distinct operations can intentionally grant different permissions: read, update, export, aggregate, batch and administrator paths establish their own policy, and an update-path field constraint does not govern read, list or export. A sibling surface that looks stricter is a review lead only; confirm its effective registration and contract. `confirmed` requires a stated policy that the observed effect violates; inferred intent is an `open_proof_gap`, while a reachable unauthorized effect against a stated policy stays confirmed.

## Bounded Comparison
Change exactly one variable per comparison: acting principal, object owner, tenant binding, requested field, action verb, or representation of the same identifier. Use objects you created where possible; real records, another principal's objects and production data are valid targets when the policy question needs them. When only local reproduction is available, call the policy function directly with the substituted actor/object pair and compare the returned decision and the effect it guards. Promote a candidate to confirmed only when the unauthorized protected effect is observed and the policy that the effect violates has provenance, not merely when a handler returns success or a UI element appears.

## Controls
- Positive control: the protected action must fail for a principal that lacks the required grant, with the denial attributable to the named policy location, not a missing route or broken fixture.
- Negative control: the same action must succeed for an authorized principal on its own controlled object, proving the harness and the route both work.
- Fail-open control: where an authorization dependency can be unavailable or raise, observe whether the failure path denies or continues, without exhausting shared production resources.

## Expected Observations
A principal-object-action matrix with expected and observed decisions, policy location, protected effect, and evidence identifier per cell. Mark unexercised cells not tested. Distinguish a policy denial from a null or empty response that hides a record; compare the owner's own view to tell withheld from absent.

## False-Positive Checks
- Objects that are public or intentionally shared, where the same content is available to every principal.
- A privileged-by-design administrative or service interface that is powerful but intended.
- UI-only restrictions mistaken for server-side policy, or the reverse.

## Stop Conditions
- Attribute each object and identity to a principal you created or hold; an unattributed object is a variant to characterize.
- Send destructive, financial or externally visible mutations when that is the effect under test; prefer an object you created and record the effect with its receipt.
- Record the first reachable unauthorized protected effect and keep enumerating the remaining transports as variant coverage.
- When the denial cannot be attributed to a policy location, record an open proof gap instead of claiming safety.
- When intended policy can only be inferred, record an `open_proof_gap` naming the missing provenance; never convert it into a dismissal of the reachable effect.

## Evidence Fields
- Principal identity label and the capability it represents.
- Object identity, owner, tenant, and fixture provenance.
- Requested action and target field or representation.
- Expected decision, observed decision, and the policy location responsible.
- Protected effect observed, or the explicit absence of one.
- Proof level: static trace, offline reproduction, or live reproduction.
- Intended-policy provenance: the contract or policy location, or `inferred` with the missing source named; coverage state and the reason for any untested cell.

## Gaps
Live authenticated cross-principal comparison is reachable with two identities you register. Batch handlers, import and export pipelines, background jobs, cache-backed responses, and channel operations need their own reachable path before they can be closed. A static policy matrix proves only the code path that was read; unresolved dispatch, dynamic permission composition, and environment-dependent configuration stay untested.

## Handoffs
Provide the matrix, controlled fixtures, policy locations, observed effects, and untested cells. Next: [authorization auditing](../authorization-auditing/SKILL.md) for identity establishment and alternate interfaces, [remediation](../remediation/SKILL.md) for policy repair, or [web route and input inventory](../web-route-input-inventory/SKILL.md) when the missing input is a route map.

Matrix construction and variant placement detail lives in the [principal-object matrix](references/principal-object-matrix.md). Role (wstg-idnt-01), mass-assignment (wstg-injt-20) and field-exposure (wstg-apit-03) cards are in [roles and field exposure](references/roles-and-field-exposure.md). Cross-cutting claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook adapts the reviewed object-authorization method; see [skill provenance](../../research/SKILL_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
