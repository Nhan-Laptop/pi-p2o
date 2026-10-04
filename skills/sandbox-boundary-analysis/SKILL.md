---
name: sandbox-boundary-analysis
description: Model browser, desktop-app, container, and OS confinement as layered capabilities and broker contracts. Use to assess privileged IPC, trusted rendering, policy composition, and claimed sandbox escapes.
---

# Sandbox-Boundary Analysis

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Layered capability and broker-contract modeling.

## When to Use
Untrusted content executes inside a renderer, plugin, container, interpreter, or restricted OS process and interacts with a more privileged service.

## Goal
Which exact boundary permits a forbidden capability, and which independent confinement layers still apply afterward?

## Workflow
Starting actor → active confinement layers → broker interfaces → trusted decisions → cross-boundary observation → remaining restrictions.

1. Record the actual starting context: UID/token, integrity, namespaces/capabilities, seccomp/LSM, job restrictions, desktop/session, origin, CSP, trust mode, and feature settings as applicable.
2. Map broker/control interfaces and their access policy. Include local automation listeners, custom resource protocols, IPC file APIs, dynamic-code services, and stateful asynchronous requests.
3. Trace which side validates origin, type, path, request state, and resource lifetime. A renderer-side check cannot protect a broker from a compromised renderer.
4. Evaluate policies compositionally: loading versus execution; authentication versus path confinement; identity versus syscall/job restrictions; local binding versus browser reachability. Bind each guard to its actual initialization, parsing, compilation, reconstruction or execution phase, dependencies and identity. A runtime guard does not establish containment in an earlier phase.
5. Validate one harmless forbidden capability at a time and preserve denied controls. Observe process/desktop/session separately from creation or privilege.
6. State only the demonstrated boundary and remaining restrictions. Do not equate renderer execution, kernel access, or container-local root with full host compromise.

## Research Heuristics
- Browser-side lifecycle validation is necessary even when renderer code enforces the protocol normally. [B067](../../research/evidence.md#b067)
- Restricted/trusted rendering flags may not reach every DOM or IPC path. [B027](../../research/evidence.md#b027)
- Elevation can leave job, desktop, integrity, seccomp, or LSM constraints intact. [B022](../../research/evidence.md#b022), [B023](../../research/evidence.md#b023), [B045](../../research/evidence.md#b045)
- Localhost control services are exposed to a distinct web-origin threat model; inspect Host, Origin, framing, and every transport. [B072](../../research/evidence.md#b072)
- Privileged group membership may intentionally delegate host-level authority rather than violate a sandbox contract. [B005](../../research/evidence.md#b005)

## Tools
- OS token/descriptor and policy inspectors → establish active privilege/confinement → when UID or application labels do not explain behavior.
- System Informer / process and session inspection → distinguish creation from visibility and policy denial → when desktop or job constraints are relevant.
- Browser developer tools, IPC source review, and protocol documentation → map renderer-to-broker contracts → when privileged webview/control operations are reachable.
- Debugger and controlled application traces → corroborate boundary decisions and callback lifetimes → when source checks may execute on the wrong side.
- Wireshark and syscall traces → verify local-control protocol and cross-process paths → when logs hide transport or policy enforcement.

## Validation
Record each policy layer before/after the observed effect. Test the real restricted context and unmodified build. Generated bindings, disabled sandbox flags, root diagnostic modules, or broad policy removal change the claim; preserve them prominently. Verify user interaction and non-default setting prerequisites. A private laboratory demo is not portable evidence across versions or platforms.

## Common Failure Modes
Importing a medium-privilege test into an untrusted context (B022); assuming root clears AppArmor (B045); manual bindings/fixed addresses hiding real interface prerequisites (B067); sandbox-disabled demonstrations mistaken for escapes (B057); ignoring later user-interaction caveats (B027).

## Fix / Mitigation
Derived guidance: enforce validation in the privileged consumer, constrain broker operations and paths, separate content from capability, minimize exposed control interfaces, and retain independent confinement layers. Use process isolation rather than treating string denylists or removed language builtins as a complete interpreter sandbox (B006).

## Handoffs
**Boundary Analysis → Impact:** provide starting context, policy-layer table, interface contract, crossed boundary, remaining denials, interaction/settings, and modification ledger. Next: [exploitability assessment](../exploitability-assessment/SKILL.md); unknown identity policies go to [authorization auditing](../authorization-auditing/SKILL.md).

## Evidence
B067, B027, B022, B023, B045, B072, B005, B006, B030, B048, and B057 provide broker, runtime, OS, and container-policy distinctions; no escape chain is provided.

[O021](../../research/orange/evidence.md#o021) contributes phase-specific guard coverage. Preserve independent actor/permission and confinement layers; preparation behavior alone is neither a complete escape nor an optimizer-invariant finding. See [framework phases](../deserialization-and-dispatch-auditing/references/framework-routing.md).
