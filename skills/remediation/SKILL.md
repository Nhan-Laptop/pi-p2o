---
name: remediation
description: Convert a verified vulnerability invariant into root-cause fixes, variant regression tests, deployment checks, detection, and hardening. Use after discovery or when reviewing a vendor's proposed patch.
---

# Remediation and Defensive Verification

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Invariant repair with explicit coverage and residual risk.

## When to Use
A root cause is known, a mitigation is proposed, or a patch must be assessed for sufficiency across equivalent paths and deployed artifacts.

## Goal
Does the fix enforce the correct contract at every consumer, and what exposure remains after rollout?

## Workflow
Root cause → authoritative enforcement point → repair → variant tests → shipped-artifact verification → detection and residual-risk record.

1. Express the violated invariant without a CVE trigger: identity is authenticated before use; a child reference remains valid; validation and consumption agree; every access fits; reservation is exclusive.
2. Select the enforcement point at the trusted consumer. Fix representation, ownership, authorization, or unsafe API design rather than adding a blacklist for one observed input. A representation migration must cover entry handling, variable types, downstream parsing and remaining converters—not only one entry-point signature.
3. Review all semantic variants: alternate route/lookup, nested property, derived/inherited type, callback, abort/cleanup, create/update, stored/immediate data, error continuation/re-entry, shared product, and upstream dependency.
4. Build a regression matrix with accepted controls and rejected/contained cases. Include role/configuration, boundary classes, normal/error/duplicate state transitions, and original-build behavior. Tests must distinguish mitigation from root-cause repair.
5. Verify source **and shipped artifacts**, then verify active enforcement separately. Record release/build/package hashes, deployment status, compatibility-driven defaults, activation requirements, and any remaining privileged reachability. A package containing hardening does not prove that the intended policy is enabled.
6. Add scoped detection at entry, decision, and consumer boundaries. Verify coverage for stateful/alternate transports; redact sensitive payloads, correlate actor/object/time, and avoid logging secrets.
7. State residual risk, untested variants, compatibility tradeoffs, and emergency hardening separately from the completed repair.

## Research Heuristics
- Native parsing/crypto APIs or structured process arguments can eliminate a shell boundary instead of filtering metacharacters. [B001](../../research/evidence.md#b001), [B039](../../research/evidence.md#b039), [B056](../../research/evidence.md#b056)
- Root-only prototype fixes and transport-only serializer fixes can leave variants. [B041](../../research/evidence.md#b041), [B049](../../research/evidence.md#b049), [B066](../../research/evidence.md#b066)
- Replacing a hardcoded alternate credential with a configurable backup credential may preserve the same bypass. [B070](../../research/evidence.md#b070)
- Backup permissions and inherited subprocess environments can expose secrets even when original storage is restricted. [B058](../../research/evidence.md#b058), [B037](../../research/evidence.md#b037)
- Setup/deprecated features left reachable after installation are ongoing attack surface. [B054](../../research/evidence.md#b054)

## Tools
- Source/binary diff and call-site search → verify repair and equivalent paths → when reviewing a proposed patch.
- Regression/unit/integration tests → assert invariant-preserving normal and failure behavior → before accepting a fix.
- Artifact/package and service-unit inspection → verify shipped fix and activation exposure → during rollout and configuration hardening.
- Application/IPC/network telemetry → observe forbidden decisions and abnormal state/crash patterns → after checking transport coverage and redaction.

## Validation
Require an invariant-level explanation, passing accepted controls, rejected/contained counterexample classes, reviewed variants, and verified deployed artifacts. Re-run relevant behavior under original policy; diagnostic bypasses invalidate fix claims. Distinguish **repaired**, **exposure mitigated**, **partially repaired**, and **unverified**. A timeout or one rejected payload is not closure.

## Common Failure Modes
A source fix is missing from the distributed package (B006); one lookup ignores state checked by another (B043); duplicated sanitizers reverse each other (B068); fixes fail to propagate across product/upstream versions (B039); HTTP access logging misses WebSocket activity and encodings (B041). A CVE assignment, score, or absence is not technical validation (B017, B059).

## Fix / Mitigation
Apply the invariant-specific fix: checked arithmetic and complete bounds; consistent snapshot parsing; correct final-release ownership; consumer-side state/authorization checks; own-property/fixed dispatch; inert serialization; fail-closed dependency behavior. Supplement with least privilege, restricted activation/listeners, non-executable uploads, network segmentation, bounded work, and secret rotation when exposure is established. Rate limiting, CSP, CFI, allocator separation, and access restriction are defense in depth, not interchangeable root-cause repairs.

## Focused Method
Consume reviewed current claims with their controls and gaps. Invalidate proposals relying on withdrawn validation; separate proposed repair, shipped artifact and active enforcement. Formatting or a fix recommendation is not independent reproduction. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review).

## Handoffs
Name a risk level from the [risk rating criteria](references/risk-rating-criteria.md) when reporting an accepted case; it never substitutes for the case's own verdict or review status.

**Root Cause → Engineering:** provide invariant, authoritative enforcement point, all consumers/variants, impact limits, normal controls, regression matrix, and emergency mitigations. **Engineering → Verification/Operations:** provide actual build IDs, test receipts, rollout scope, detection coverage, compatibility changes, and residual reachability. Return to [patch analysis](../patch-diff-analysis/SKILL.md) if artifact contents disagree.

Unexpected incident indicators take the [provisional owner-review route](../../HANDOFFS.md#provisional-owner-review) instead of assuming root cause or completed impact. [O033](../../research/orange/evidence.md#o033) motivates minimized, redacted observations with attribution/access unknowns; containment is not repair closure.

## Evidence
B001, B039, B041, B043, B049, B066, B070, B058, B037, B054, B068, B006, B017, B059, B021, B067, and B005 support root-cause repair, incomplete-fix, rollout, and telemetry lessons. General regression and hardening prescriptions are derived synthesis.

[O004](../../research/orange/evidence.md#o004) adds end-to-end representation migration and distributor ownership; [O005](../../research/orange/evidence.md#o005) adds terminal-error and equivalent-caller regression scope; [O008](../../research/orange/evidence.md#o008) separates shipped repair from activated enforcement. These refine generic contracts rather than reproduce the source solutions.
