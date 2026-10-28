---
name: source-code-auditing
description: Plan a high-yield audit of a large source tree using framework conventions, dual source/sink sweeps, invariant hypotheses, and variant searches. Use after reachable interfaces are mapped.
---

# Source-Code Auditing

Before first use, read [focused method and review](../../HANDOFFS.md#focused-method-and-review).

## Technique
Convention-aware audit slicing.

## When to Use
Source is available but exhaustive file-by-file review is impractical. This skill selects and prioritizes slices; [data-flow analysis](../data-flow-analysis/SKILL.md) proves individual paths.

## Goal
Which departures from the target's intended validation, ownership, or authorization conventions deserve investigation?

## Workflow
Baseline → learn conventions → complementary sweeps → invariant hypotheses → focused validation → variant review.

1. Reconcile the repository revision with deployed artifacts; inspect dependency/runtime versions and optional modules. Stand up an isolated instance with a known-good operation.
2. Read representative entry handlers and framework helpers. Identify input wrappers, type tags, route middleware, permission helpers, object factories, cleanup routines, and asynchronous job dispatch. For modular pipelines, map shared-field writers/readers, assumed semantic roles and mutation rights before selecting an interaction slice.
3. Sweep **source → sink** and **sink → source**, including wrappers, indirect calls and stored data. Classify sensitive arguments as inert value, structural selection, behavior selector or validated typed object; read each helper's role-specific guarantee. Value protection does not automatically cover structure, and a familiar abstraction proves neither safety nor defect.
4. Contrast sibling paths: raw/validated type, create/update, commit/abort and immediate/deferred processing. Review diagnostics, partial output, exceptions and continuation as state-changing paths. Compare exceptional early and later rejections for externally visible progress; response differences need stage corroboration and do not prove completion.
5. Record `observation | expected invariant | counterexample hypothesis | necessary gates | disconfirming observation | next experiment`. Rank by actor reachability and boundary consequence, not alarming function names alone.
6. After one root cause is established, search for the same semantic pattern across callers, representations, dependency adapters, and shared product code. Keep a record of slices deliberately excluded and why.

Use [interaction-centered review](references/interaction-audits.md) when contracts between participants—not a single input helper—are the unresolved question.

## Research Heuristics
- Learn custom parameter APIs before choosing search patterns; a helper name does not establish what its sanitization mode guarantees. [B068](../../research/evidence.md#b068)
- Newly introduced selection/state mechanisms are productive audit slices; inspect reserve versus complete semantics. [B064](../../research/evidence.md#b064)
- Generic reflection, broad exception fallbacks, and nested mutable metadata are high-value review points. [B037](../../research/evidence.md#b037), [B006](../../research/evidence.md#b006)
- Equal-looking paths can use different normalizers or authorization dependencies. Compare entire pipelines, not one check. [B001](../../research/evidence.md#b001), [B063](../../research/evidence.md#b063)

## Tools
- `rg '<input_or_sink_wrapper>' <source-root>` → build a convention-specific candidate set → after reading the helper implementation.
- An IDE's find-references/call hierarchy → resolve actual callers, overrides, and data retrieval consumers → when grep cannot represent dispatch or inheritance.
- `git log -- <subsystem>` and `git diff <old> <new> -- <subsystem>` → identify semantic churn → when ranking recent feature or security changes.
- Language debugger/isolated unit tests → inspect arguments and branch gates cheaply → when a whole-service run is slow or a pipeline hypothesis is unresolved.

## Validation
Sample both search directions against known normal paths to detect missing wrappers. Trace at least one candidate through every gate and compare a benign negative control. Reject a bug hypothesis if input is uncontrollable, the sink is unreachable, or the invariant is preserved; retain the reasoning rather than deleting the failed investigation.

## Common Failure Modes
Over-filtering hides custom wrappers; under-filtering produces unactionable candidates. A filename may be generated rather than attacker-controlled. A development kit may reject operations accepted by the product; bypassing its validation creates only a modified-environment result. [B068](../../research/evidence.md#b068), [B063](../../research/evidence.md#b063)

## Fix / Mitigation
Derived guidance: centralize typed input and authorization contracts, remove unsafe dynamic dispatch, and review every caller of shared helpers. Regression tests should assert the invariant across sibling paths, not merely reject one sample.

## Focused Method
Hand off the minimal controllable-input → gate → consumer slice, its competing predictions and missing edge. Prefer one targeted observation over another broad sweep; revise the question when a gate assumption fails.

## Handoffs
**Static Analysis → Dynamic Analysis:** deliver revision, minimal call/data-flow slice, exact unresolved gate or value, expected observations on both hypothesis outcomes, and proposed instrumentation points. No handoff based solely on a grep hit. **Static Analysis → Fuzzing:** when a reachable processing unit has too many input combinations for manual tests, hand off its harness and reset contract to [fuzzing](../fuzzing/SKILL.md); a crash-free campaign is coverage, not safety. Next: [dynamic analysis](../dynamic-analysis/SKILL.md).

## Evidence
Claim validation against intended policy is in [claim provenance](references/claim-provenance.md).
The audit-selection method merges B068, B064, B063, B037, B006, B001, and B066. Detailed field/trace validation belongs to the specialized skills rather than another whole-codebase sweep.

Shared-state interactions and security-check side effects also draw on [O005](../../research/orange/evidence.md#o005) and [O001](../../research/orange/evidence.md#o001), with handoffs derived for this library rather than attributed to the authors.

[O011](../../research/orange/evidence.md#o011) contributes failure-path progress questions; [O029](../../research/orange/evidence.md#o029) adds abstraction argument-role coverage. Both motivate review, not recovery or injection procedures.
