---
name: compiler-invariant-auditing
description: Audit optimizer assumptions, effect chains, numeric ranges, parser identities, exception sentinels, and cross-tier metadata. Use for compilers, JITs, language runtimes, or staged reprocessing systems.
---

# Compiler-Invariant Auditing

Before first use: [scope baseline](../../README.md#start-here), [handoff method](../../HANDOFFS.md#focused-method-and-review), and [owner review](../../HANDOFFS.md#provisional-owner-review).

## Technique
Cross-phase assumption validity checking.

## When to Use
A staged system infers facts, caches identity/shape, reparses input, or specializes operations across compilation/execution tiers.

## Goal
Does an assumption remain sound after every side effect, representation conversion, reparse, and tier transition that precedes its use?

## Workflow
Affected phase → inferred fact → invalidators → representation/identity model → intermediate-state comparison → real execution → conservative repair.

1. Locate the phase and fact consumers before studying downstream memory effects. Record runtime revision, build options, architecture, and triggering tier/feature requirements.
2. State the inference contract: range contains every possible result; shape is valid after effects; identity maps survive reparsing; exceptional returns establish exception state; metadata and execution context agree.
3. Enumerate invalidators: callbacks, coercion, accessors, mutable aliases, implicit scopes, lazy compilation, code flushing, unsupported operations, and tier changes.
4. Compare conservative defaults with special cases. If an operation cannot be proven non-writing, preserving a reliable shape/range assumption requires evidence, not optimistic classification.
5. Inspect IR/bytecode/state before and after relevant phases and on fixed versus reconstructed-vulnerable revisions. Verify actual numeric representation and guard insertion/removal.
6. Compare semantics under ordinary execution and the relevant optimized/reparsed mode using safe results. A diagnostic shell intrinsic or assertion-disabled experiment must be separately labeled from browser/product reachability.

## Research Heuristics
- A special-case effect handler can bypass conservative invalidation. [B055](../../research/evidence.md#b055)
- Signed extension and representation changes can invalidate inferred ranges; unsupported operations may correctly force an unknown range. [B061](../../research/evidence.md#b061)
- Reparse identity requires stable ordering including implicit scopes, not merely matching source text. [B008](../../research/evidence.md#b008)
- Cached enumeration counts need revalidation after state-changing callbacks. [B062](../../research/evidence.md#b062)
- Exceptional paths must initialize pending-exception state before returning internal sentinels. [B057](../../research/evidence.md#b057)

## Tools
- Turbolizer → compare effect chains and guard placement → for compatible V8 graph dumps around a suspected optimizer assumption.
- Compiler IR/bytecode/disassembly dumps → correlate phase decisions with representation and emitted operations → when the source hypothesis depends on specialization.
- Engine shells such as d8/jsc → make controlled local semantic comparisons → when runtime diagnostics are needed; shell-only functions do not prove application reachability.
- LLDB/GDB plus bounded diagnostic logging → inspect metadata, phase entry, and actual values → when IR alone leaves a state transition unresolved.
- Small standalone arithmetic models → test range-transfer soundness → before interpreting a complex JIT experiment.

## Validation
Require a documented assumption, reachable invalidator, consumer using stale/unsound information, and corresponding observable discrepancy or guarded failure. Check fixed versus old behavior and emitted guards. Preserve release assertions: a default-build abort proves the barrier exists, not the consequences imagined after removing it. Do not claim current-release exposure from a patch reversion.

## Common Failure Modes
Profiling chooses a different numeric representation; unknown/Phi facts prevent the hypothesized optimization (B061); GC relocates observed objects (B055); release assertions block subsequent effects (B008); RWX metadata does not override other memory protections (B057). Unexplained representation differences remain hypotheses.

## Fix / Mitigation
Source lessons include conservative effect invalidation (B055), sound transfer functions (B061), identity consistency (B008), and exception-state checks (B057). Derived guidance: test callback invalidation, phase/tier transitions, range boundaries, unsupported operations, and metadata coupling; retain conservative fallback when analysis is incomplete.

## Handoffs
**Compiler Audit → Validation:** deliver phase, invariant, IR/state snapshots, invalidator, guards, representation, required modes, and original/modified-build distinction. **Root Cause → Remediation:** deliver regression properties across phases, not a single language snippet. Next: [remediation](../remediation/SKILL.md).

## Evidence
B055, B061, B008, B062, B057, and B071 merge effect, range, identity, cached-state, sentinel, and regression-history methods into one cross-phase skill.
