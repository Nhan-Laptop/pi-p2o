---
name: patch-diff-analysis
description: Turn source or binary changes and regression tests into invariant hypotheses, validate N-day applicability, and assess fix coverage. Use for sparse advisories, variant hunting, and release-gap analysis.
---

# Patch-Diff Analysis

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Semantic change-to-invariant reconstruction.

## When to Use
A security update, changed regression test, or incomplete advisory identifies a region but not its cause. Analysis is for authorized research and remediation inside the approved scope, not deployment of an exploit outside it.

## Goal
What assumption changed, why did the old assumption fail, and is the correction present and sufficient in the actual artifact?

## Workflow
Comparable baselines → changed behavior → implied invariant → callers and variants → controlled comparison → shipped-fix assessment.

1. Record old/new revisions, dependencies, runtime versions, compiler options, and actual package hashes. Align architectures and distinguish source commits from shipped builds.
2. Start with change statistics and regression-test history; separate semantic changes from refactoring. For binaries, match functions and diagnostic references, then decompile only relevant old/new slices with the same tool/options. Record missing coverage on either side rather than interpreting absent output as deleted code.
3. Translate each change into a question: why this bound, lifetime transition, type restriction, scope identity, or authorization gate? Examine the old implementation and callers before claiming a defect.
4. Audit adjacent paths implementing the same invariant: nested dispatch, alternate lookup, inherited callback, sibling service or stored/immediate input. Scope published rejection evidence to its actual guard and dependency revision; absence of that guard elsewhere is an applicability question, not positive reachability evidence.
5. Compare safe observations on old/new artifacts: branch outcomes, object lifetime, intermediate representations, and rejected input classes. Maintain one-variable-at-a-time baselines.
6. Locate the fix in downstream releases and shared products. Distinguish root-cause repair, access restriction, and regression-test publication; each has a different coverage claim.

## Research Heuristics
- Release and upstream-fix timelines can diverge; track artifact contents, not just an advisory/version label. [B071](../../research/evidence.md#b071), [B006](../../research/evidence.md#b006)
- Moving a release from cleanup to final close signals a lifetime-contract change. [B021](../../research/evidence.md#b021)
- Root-level hardening may leave inherited/nested paths open; inspect all consumers. [B041](../../research/evidence.md#b041), [B066](../../research/evidence.md#b066)
- No changed parser code does not mean no mitigation: a driver can be made inaccessible instead. [B028](../../research/evidence.md#b028)
- Added length checks require the deployed runtime's packing/casting behavior, not a modern runtime's assumed semantics. [B009](../../research/evidence.md#b009)

## Tools
- `git diff --stat <old> <new>` / `git diff <old> <new> -- <path>` → isolate changes and inspect callers → with comparable source revisions.
- `git log -1 -- <regression-test>` → associate a test with its change history → when regression files identify the relevant invariant.
- BinDiff/Diaphora → prioritize changed binary functions → when source is unavailable; corroborate with strings, references, and runtime observations.
- Scoped Kuna CLI or IDA/Ghidra decompilation → compare recovered guards and call contracts → after matching binary slices; apply the same [coverage and deadline gates](../binary-auditing/references/native-slices.md) to each revision.
- Debugger and isolated regression harness → compare states and guards → when the diff's security meaning is not self-evident.

## Validation
Confirm the patch exists in the tested binary/package and the exact old behavior is reachable. Prefer an unmodified old/new comparison. A deliberately reverted patch or disabled check is a reconstruction experiment, **not** evidence that a current release is vulnerable. Rejection of one sample does not prove variant completeness; report tested input classes and untested callers.

## Common Failure Modes
Source merge mistaken for shipped fix (B006); first advertised fixed version insufficient (B041); removed delivery route mistaken for deserializer repair (B049); added check misunderstood without structure/runtime context (B060, B009). Patch-to-advisory attribution can be uncertain (B007); preserve that uncertainty.

## Fix / Mitigation
Derived guidance: write invariant-level regression tests; audit equivalent paths; propagate fixes horizontally across shared products and vertically from upstream dependencies. Track deployment separately from code review.

## Handoffs
**Patch Analysis → Audit/Validation:** provide comparable artifacts, semantic deltas, invariant hypotheses, affected callers, old/new predictions, reconstruction modifications, and release evidence. **Patch Validation → Remediation:** provide tested coverage and residual paths. Next: [remediation](../remediation/SKILL.md).

## Evidence
B021, B041, B049, B066, B071, B006, B009, B007, B028, B039, B060, B075, and B078 contribute distinct diffing or fix-scope lessons; their technical details are normalized, not reproduced.

Symmetric, bounded decompilation is also a supplemental `ctf-rev` tooling adaptation; [provenance](../../research/TOOLING.md) distinguishes it from the original corpus.

Revision-scoped rejection reasoning additionally draws on [O014](../../research/orange/evidence.md#o014). Historical exceptions do not establish current applicability or a complete old/new behavioral comparison.
