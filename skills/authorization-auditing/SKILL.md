---
name: authorization-auditing
description: Audit identity establishment, object/field authorization, alternate interfaces, failure behavior, and privilege-bearing defaults. Use when authenticated input or connection state controls privileged actions.
---

# Authorization Auditing

Before first use, read [focused method and review](../../HANDOFFS.md#focused-method-and-review).

## Technique
Actor–action–object policy differential.

## When to Use
Requests, IPC, handles, stored metadata, or deployment defaults select identities or protected actions. Authentication, authorization, and intended administrative capabilities must be assessed separately.

## Goal
Can an actor perform an action on an object or field outside the intended policy, through any supported representation or failure state?

## Workflow
Policy model → identity establishment → action/object matrix → equivalent routes → controlled role comparison → boundary consequence.

1. State the intended boundary and actors. Separate unauthenticated, ordinary user, delegated role, administrator, service, and restricted process; UID alone is insufficient.
2. Trace identity validation: signature, issuer, audience, request binding, session association, and connection-state mutability. Separate intermediary admission from represented-client identity and that client's action authority. Parsing or recognizing a claim is not authenticating it.
3. Build `actor × action × object/field × route/state` expectations. Include create/update, nested metadata, naming variants, alternate transports and asynchronous consumers. Map composite-check operands to independent identity fields; a repeated operand is a review lead, not proof of an omitted check. After framework traversal, evaluate the effective receiver/action and any independent permission gate.
4. Identify where authorization executes and whether all consumers use it. Examine exception fallbacks, dependency unavailability, cached identity, expired state, and retry paths.
5. Compare one-variable role/ownership/representation changes on controlled objects. Observe the backend decision and actual result, not UI visibility or HTTP success alone.
6. Classify policy bypass versus deliberate root-equivalent capability versus insecure default composition. Record configuration, activation, and membership requirements independently.

## Research Heuristics
- Mutable connection identity can change later permission checks even if the original session was valid. [B041](../../research/evidence.md#b041)
- Field-level permissions must hold for both top-level and nested representations and create/update paths. [B006](../../research/evidence.md#b006)
- Parent-object permissions may not propagate to every name accepted by the same handler. [B028](../../research/evidence.md#b028)
- Authentication-module eligibility, token verification, and application membership are separate gates. [B042](../../research/evidence.md#b042)
- Package absence, ordinary-looking group names, and policy labels can conceal intended powerful authority. [B005](../../research/evidence.md#b005)

## Tools
- Source/decompiler references → enumerate permission gates and identity consumers → before designing role tests.
- Intercepting proxy or Socket.IO-capable test client → compare equivalent operations and stateful transports → on controlled lab accounts only.
- Security-descriptor/token inspectors and policy queries → identify effective identity, ACLs, capabilities, integrity, or confinement → when nominal roles do not explain denial.
- libguestfs and service-unit inspection → inspect offline membership and activation authority → when testing image defaults without changing them.
- Structured application audit logs → correlate decision, actor, and object → when assessing detection visibility; transport coverage must be checked.

## Validation
Require expected policy, actual actor, backend decision, protected effect, and a denied-control case. Test dependency failures without exhausting shared production resources. Verify default versus optional features, current cache state, and role membership. A privileged-by-design interface is not an authentication bug merely because it grants powerful operations.

## Common Failure Modes
Trusting UI restrictions; conflating authentication with object authorization; assuming a local account belongs to the application (B042); assuming a published first patch is complete (B041); allowing failures to fall back to a privileged identity (B006). Cross-session file creation without a demonstrated escalation remains a limited result (B035).

## Fix / Mitigation
Derived guidance: fail closed, bind identity immutably to authenticated context, centralize per-action/object/field checks, and reject unexpected inherited dispatch. Before moving an identity restriction between consumers, document legitimate identity classes and accepted peer operations; the trusted requirement may differ. Use bounded authentication dependency work and explicit administrative membership. For filesystem operations, avoid re-resolving attacker-modifiable paths after policy checks; handle symlink/object identity safely.

## Focused Method
Record intended-policy provenance and a controlled actor/object matrix. A sibling route is not the contract. Keep unavailable authenticated comparisons explicit; accept source observations only as source observations.

## Handoffs
**Authorization Audit → Impact/Remediation:** provide the policy matrix, actor and state, bypassed gate, observed protected effect, rejected controls, default/optional scope, and equivalent paths. Next: [sandbox boundaries](../sandbox-boundary-analysis/SKILL.md) for layered confinement or [remediation](../remediation/SKILL.md) for policy repair.

## Evidence
B041, B006, B028, B042, B005, B058, B035, B030, B048, and B068 supply identity, field, naming, deployment, filesystem, and policy-layer distinctions.

[O008](../../research/orange/evidence.md#o008) supports consumer-specific identity requirements and compatibility-aware repair. Its outcomes remain historical author reports, not a current-deployment assessment.

[O009](../../research/orange/evidence.md#o009) adds semantic operand coverage; [O012](../../research/orange/evidence.md#o012) separates intermediary and client contracts; [O022](../../research/orange/evidence.md#o022) distinguishes entry admission from effective receiver/action authority; [On demand upstream text](references/wstg-source.md).
