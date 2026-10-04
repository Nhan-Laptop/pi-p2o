---
name: deserialization-and-dispatch-auditing
description: Audit data that selects methods, types, callbacks, templates, or serialized object behavior. Use for reflective APIs, prototype inheritance, nested deserializers, converters, and data-to-code boundaries.
---

# Deserialization-and-Dispatch Auditing

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Behavior selection as a trust boundary.

## When to Use
Untrusted data chooses a callable, type, property chain, converter, evaluated template, or reconstructed object. This includes seemingly harmless file or metadata operations with implicit behavioral effects.

## Goal
Can input select behavior outside the explicitly intended contract, including inherited or nested behavior?

## Workflow
Selector/type source → reachable object graph → behavioral hooks → validation scope → safe observable callback → contract repair.

1. Locate explicit deserializers, reflective calls, dynamic property traversal, code generation, and conversions. Include callbacks, magic methods, setters, constructors, accessors, and format-dependent implicit decoding.
2. Define the expected closed set of selectable behaviors. Trace selector/type provenance, receiver identity, execution privilege, and argument binding.
3. Enumerate inherited/private methods and nested properties, not only exported root members. Check primitive types before invoking attacker-influenced object methods; coercion itself can execute behavior.
4. Follow allowlisted types through inheritance, reconstruction callbacks, and secondary deserializers. An approved outer type or byte-array shape is not a transitive safety guarantee.
5. Compare immediate/stored inputs, archive/file wrappers, adapters, and alternative consumers. Include metadata and I/O paths that decode implicitly; pin the actual runtime rather than inheriting historical behavior. Inspect error-response writes to selectors and whether later dispatch continues after an intended terminal failure. Record environmental prerequisites and authentication separately.
6. Validate with benign callback instrumentation or a controlled data observation. Include convention-selected, default, returned-receiver and preparation-phase behavior using the owned [framework-resolution guide](references/framework-routing.md). Show unintended behavior selection without constructing a code-execution gadget chain or stealing secrets.

## Research Heuristics
- Removing only a root prototype leaves nested objects/functions' inherited behavior relevant. [B041](../../research/evidence.md#b041)
- Reflection exposes methods beyond the intended API; default-argument methods remain callable candidates. [B037](../../research/evidence.md#b037)
- Privileged code should not resolve expected local values through mutable global/prototype lookup. [B007](../../research/evidence.md#b007)
- Converters and allowlisted classes can hide a second deserialization phase. [B049](../../research/evidence.md#b049)
- Shared data retrieval may feed an unpatched alternate deserializer. [B066](../../research/evidence.md#b066)

## Tools
- IDE/decompiler call hierarchy, including dnSpy Analyze for supported .NET assemblies → enumerate callers, inheritance, and callbacks → when nested behavior is not obvious.
- A local language console with introspection → inspect method arity, visibility, and source locations → when testing a copied authorized object model, not production secrets.
- Debugger/Frida with harmless callback markers → confirm selected behavior and privilege context → when conversions or property access have implicit side effects.
- Dependency manifest and serializer documentation → identify installed reconstruction behavior → when reachability depends on runtime/library versions; catalogued possibilities are not proof of installed exposure.

## Validation
Require the controllable selector/type, receiving object, unintended behavior, execution context, and every prerequisite. Use a negative control for an intended allowed member. Stop if unexpected sensitive data appears; report only redacted boundary evidence. An exception, known gadget catalogue, or dangerous serializer name alone does not establish a feasible path.

## Common Failure Modes
Outer-type allowlisting ignores callbacks (B049); root-only prototype repair is incomplete (B041); transport mitigation hides an unrepaired serializer (B049); disabled optional services prevent reproduction (B066). A theoretical method or secret-dependent path is not demonstrated execution (B037).

## Fix / Mitigation
Source patterns include own-property dispatch checks (B041), lexical locals, primitive-type validation, and data captured as closure parameters rather than evaluated source (B007). Derived guidance: use inert schemas, fixed operation registries, transitive type restrictions, and least-privileged execution. Authenticating a sender does not make arbitrary object reconstruction safe.

## Handoffs
**Dispatch Audit → Validation/Remediation:** provide the selector/type model, object/inheritance graph, privilege, callbacks/secondary consumers, benign observation, constraints, and allowlist coverage. Next: [remediation](../remediation/SKILL.md), or [sandbox boundaries](../sandbox-boundary-analysis/SKILL.md) when a restricted execution environment is claimed.

## Evidence
B037, B041, B007, B049, B066, B068, B063, B009, and B017 support behavioral-boundary analysis; serializer gadgets and original exploitation steps are intentionally absent.

[O001](../../research/orange/evidence.md#o001) reinforces dependency-bounded reconstruction assessment; [O005](../../research/orange/evidence.md#o005) adds error-path selector mutation and continuation review. No source gadget or exploit procedure is imported.

Convention-selected receivers, unmatched-input delegation, preparation hooks and returned-data interpretation additionally draw on [O015](../../research/orange/evidence.md#o015), [O021](../../research/orange/evidence.md#o021), [O022](../../research/orange/evidence.md#o022), and [O024](../../research/orange/evidence.md#o024). Their receiver/phase models are not copied invocation sequences.
