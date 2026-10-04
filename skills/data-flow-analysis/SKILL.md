---
name: data-flow-analysis
description: Trace attacker influence through wrappers, indirect dispatch, persistent state, and asynchronous consumers. Use to distinguish a sensitive sink candidate from a feasible security-boundary violation.
---

# Attacker-Controlled Data-Flow Analysis

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Bidirectional, representation-aware influence tracing.

## When to Use
A sensitive operation or an untrusted input is known, but the connection, sanitization guarantees, or reachability is unclear.

## Goal
Can this actor influence the exact value consumed by a sensitive operation under feasible execution conditions?

## Workflow
Source/sink selection → use-def chain → transformations and indirect edges → gate constraints → runtime path → boundary conclusion.

1. Define the source's actor and controllable fields, and the sink's security semantics. Include file metadata, shared memory, stored configuration, reflected selectors, and job payloads—not just request parameters.
2. Trace forward from the source and backward from the sink. Record copies, aliases, output parameters, templates, casts, normalization, storage, and later reads.
3. At every edge, write `input representation → transformation → output representation → guarantee`. Include generated startup/runtime conversions and effective encoding. For failure/progress signals, record producer result, receiving type, conversion, decision branch and exit-state dependency: failure must remain distinguishable from valid data. A size bound, normalizer and encoder have different guarantees.
4. Recover indirect edges through object identifiers, dispatch registrations, dependency adapters, serializers, and asynchronous queues. Preserve object identity and field provenance across boundaries.
5. Maintain a path-constraint sheet: actor, state prerequisites, permissions, branch conditions, runtime version, and required sequencing. Separate data dependence from feasibility. Reduce only the unresolved relation; retain full input-to-slice gates instead of starting whole-process symbolic execution.
6. Use a benign distinguishable marker to observe the value before and after critical transformations. Confirm the deployed consumer receives that value; classify unresolved edges explicitly.

## Research Heuristics
- Summarize functions that write destination arguments, not only return values. [B070](../../research/evidence.md#b070)
- Framework object dispatch can connect a request setter to a later callback without a direct call edge. [B070](../../research/evidence.md#b070)
- Stored configuration may bypass guards placed only on immediate input. [B006](../../research/evidence.md#b006)
- Successful parsing can preserve extra original bytes on one branch and remove them on another. [B001](../../research/evidence.md#b001)
- A sensitive-looking argument may already be constrained by binary-to-fixed-format conversion; prove the final alphabet instead of assuming injection. [B056](../../research/evidence.md#b056)

## Tools
- IDE references / decompiler cross-references → assemble manual source/sink paths → for small candidate slices.
- angr Reaching Definitions → recover register/stack/memory use-def dependencies → for architecture-supported binaries where symbolic execution is too costly; supply call summaries and manually validate reported paths.
- Triton taint/concolic analysis → track influence along a concrete trace → when callbacks or computed branches defeat static use-def analysis; only observed paths are covered.
- Z3 or slice-bounded angr/Triton → check extracted bitvector constraints or a narrow path condition → after identifying input gates and relevant state; use [reduced-model validation](references/reduced-models.md), not process-entry exploration by default.
- CodeQL/Joern → query source or graph-level flows → when supported representations and framework models exist; an analysis option mentioned by B070, not a claimed implementation used there.
- Debugger or Frida hooks → log input/output fields and consumer calls → when static analysis cannot resolve state or dispatch.
- Burp/browser network traces → tie an actual request to its handler → when an apparent path may be gated by transport or application state.

These options are optional; confirm availability and supported version before relying on one.

## Validation
A positive result needs actor control, every intermediate edge, feasible gates, and a witnessed sensitive consumption or equivalent evidence. A dependency graph alone is a triage lead. Test a safe baseline and a boundary-changing marker; avoid interpreting a timeout as an effect. Reject candidates whose generated values, type checks, or authorization stop attacker influence.

## Common Failure Modes
Symbolic path explosion, architecture incompatibility, missing output-parameter summaries, false positives from dependence without feasibility, and missed callbacks were observed in B070. Uncontrollable filenames and unmet worker scheduling gates rejected candidates in B063. A domain-specific sanitizer does not protect a different sink context (B068).

## Fix / Mitigation
Derived guidance: use typed values and structured APIs; validate the final consumed representation; bind stored values to the same policy as immediate ones. Keep untrusted data out of dynamic execution or privileged object selection.

## Handoffs
**Flow Analysis → Hypothesis Validation:** provide the annotated chain, controllable subset, gate sheet, exact sink context, sanitizer guarantees, missing edges, and contrasting observations. Next: [dynamic analysis](../dynamic-analysis/SKILL.md) or [parser differentials](../parser-differential-auditing/SKILL.md).

## Evidence
Merged manual source/sink tracing (B068, B063), use-def automation (B070), cross-service normalization (B001), stored-input bypass (B006), and a disconfirmed injection candidate (B056).

The reduced symbolic/taint tooling is a supplemental `ctf-rev` adaptation, not a claim that the cited articles used those configurations. [Tooling provenance](../../research/TOOLING.md) records this boundary.

Implicit startup/runtime conversion edges additionally draw on [O004](../../research/orange/evidence.md#o004); a configuration-specific mapping predicts possible conversions but still requires actual input-to-consumer evidence.

For indexed records, changing stored contents does not establish changed consumed meaning: trace extraction, lookup/equality predicates and actual retrieval. Treat any unproven storage/index obstruction as a conditional question, not a generalized mechanism. [O016](../../research/orange/evidence.md#o016).

[O027](../../research/orange/evidence.md#o027) motivates failure-marker meaning through conversion; a timeout alone cannot establish its loss or service-wide exhaustion.
