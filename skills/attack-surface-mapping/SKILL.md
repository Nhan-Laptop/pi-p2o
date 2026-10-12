---
name: attack-surface-mapping
description: Map an unfamiliar application's, service's, firmware's, kernel's, or hypervisor's reachable interfaces and trust boundaries. Use before choosing code to audit or designing a harness.
---

# Attack-Surface Mapping

Before first use, read the [scope baseline](../../README.md#start-here), the [skill router](../../README.md#skill-router) for the full catalog this inventory can route into, and [handoff contracts](../../HANDOFFS.md).

## Technique
Reachability-first interface inventory.

## When to Use
The target is unfamiliar, large, partially documented, or accessible through several interfaces. Work only within an explicitly authorized target and disposable test environment.

## Goal
Which attacker-controlled operations reach security-sensitive code, with what identity, configuration, and prerequisites?

## Workflow
Architecture → actor/capability model → interface registration → access checks → handler map → ranked audit queue.

1. Record artifact hashes, deployed version, enabled features, process/service tree, architecture, and intended security boundary. For distributed services, include peer relationships, installation-derived membership, effective authority and activation state. Do not equate installed package names with available capabilities.
2. Enumerate listeners, routes, dispatch tables, registrations, format loaders and shared-data consumers, mapping actual handlers and identity. Include authorized deployment metadata, diagnostic references and auxiliary development entries. Names are candidates: record extraction provenance/completeness and deployment correspondence before confirming actor, handler or gate.
3. Build a row per interface: `entry | input representation | lowest reachable actor | gate | handler | downstream privilege | evidence | unknowns`. For an intermediary, distinguish execution identity, admission credential, metadata writer, reconstructed client and final policy consumer.
4. Compare nominal access policy with every naming/dispatch route: root versus descendant object, ordinary API versus alternate transport, UI path versus direct backend call.
5. Exercise a harmless valid operation as the least-privileged relevant actor. Distinguish an interface existing, a handle opening, a request being accepted, and the sensitive handler executing.
6. Prioritize dense untrusted-input processing, unusual but unprivileged interfaces, new features, asynchronous state, and privileged consumers. History is a ranking signal, not proof of a current bug.

For composed-service identity questions, use [intermediary trust](references/intermediary-trust.md) to separate admission, metadata origin, represented client and final authority. For Host and forwarded-host trust (wstg-injt-17), use [host header trust](references/host-header-trust.md).

## Research Heuristics
- Follow registration helpers and untrusted/shared-data annotations rather than reading a subsystem alphabetically. [B081](../../research/evidence.md#b081)
- A restrictive parent object's ACL does not prove equivalent enforcement on descendant opens. [B028](../../research/evidence.md#b028)
- A default group, activation socket, or installer can expose root-equivalent capabilities even when the daemon is absent initially. [B005](../../research/evidence.md#b005)
- Confirm namespace, capability, kernel-feature, hardware, and default-configuration requirements early. [B002](../../research/evidence.md#b002), [B003](../../research/evidence.md#b003), [B006](../../research/evidence.md#b006)

## Tools
- `ss -lntup` → attribute local listeners to processes → when mapping a permitted live service; unavailable process information remains an unknown.
- `rg '<registration_symbol>' <source-root>` → enumerate registered callbacks → when framework/device initialization is available.
- Browser developer tools or an intercepting proxy → connect normal UI actions to transport and route → when discovering undocumented application paths.
- IDA/Ghidra/objdump/kuna → recover dispatch tables and companion-library contracts → when source or interface documentation is incomplete.
- libguestfs → inspect groups, package state, and activation units offline → when evaluating appliance/cloud-image defaults without boot-time mutation.
- pi-web-access → retrieve an approved public reference page when the local library and offline sources are insufficient → when the research question needs a current public source and the target itself must not be contacted.


## Focused Method
Give each extracted surface a stable ID and provenance. Distinguish registration, inferred reachability and an observed consumer. Select one next question; stop unchanged extraction when it adds no information. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review).

## Validation
A surface row is **confirmed** only with the tested actor, gate outcome, and handler observation; otherwise label it inferred or unresolved. Recheck on the deployed/default configuration, not just a debug build. A privileged diagnostic path cannot establish unprivileged reachability. Preserve denied operations as negative controls.

## Common Failure Modes
Assuming a default user is an application member; overlooking optional features; trusting UI-only restrictions; assuming no installed daemon means no activation path; treating source availability as exposure. These failed assumptions appear in [B042](../../research/evidence.md#b042), [B066](../../research/evidence.md#b066), and [B005](../../research/evidence.md#b005).

## Fix / Mitigation
Derived engineering guidance: enforce policy at the consuming boundary across all entry routes; reduce unnecessary listeners/features; restrict activation and privileged group membership. Access restriction can mitigate exposure without repairing underlying parsing bugs—track these as different outcomes.

## Handoffs
**Recon → Static Analysis:** provide a bounded inventory with surface IDs, entry/input, observed actor, gate/handler, sensitive consumer, receipt IDs and extraction method; distinguish fact, inference and hypothesis. Include context, covered/untested scope and a ranked next-task queue. Explain the selected surface/risk using reachable influence, boundary uncertainty, evidence strength, information gain and budget, with expected observation and stop condition. Correct identity assumptions when contradicted; new surfaces return to recon. No whole-target completeness claim is implied. Include the versioned interface table, confirmed lowest-privilege paths, handler locations, sample benign operations, and unresolved gates. Reject the handoff if the actor or tested configuration is unspecified. Route the queue by what it points to, not only by target kind: source available → [source auditing](../source-code-auditing/SKILL.md); source unavailable or compiled-only → [binary auditing](../binary-auditing/SKILL.md); an access-check mismatch from step 4 is itself the finding → [authorization auditing](../authorization-auditing/SKILL.md) directly; the surface is a kernel, hypervisor, or sandbox boundary rather than application code atop one → [sandbox boundaries](../sandbox-boundary-analysis/SKILL.md); the target is confirmed to be a web application → [web route and input inventory](../web-route-input-inventory/SKILL.md), which branches further by identity, authorization, injection, output and crypto concerns. None of these is the final word on its surface; a worker holding only this skill should check the [skill router](../../README.md#skill-router) before concluding no owner skill exists for an unusual finding.

## Evidence
Merged interface-registration, driver-access, socket-API, deployment-default, and middleware-scope methods from B081, B028, B002, B003, B005, B006, and B058. See the linked evidence ledger for historical scope and source limitations; this skill does not assert current target vulnerability.

Distributed peer authority and consumer-specific gate coverage additionally draw on [O008](../../research/orange/evidence.md#o008). A corrected entrance gate is not proof that the same trust assumption is repaired elsewhere.

[O012](../../research/orange/evidence.md#o012) contributes separate intermediary/client trust roles and revision-dependent architectural responsibilities. The owned guide records their generic contract, not a source request chain.

[O048](../../research/orange/evidence.md#o048) adds metadata-led auxiliary inventory, not a metadata-acquisition or test-page exploitation sequence; [On demand upstream text](references/wstg-source.md).
