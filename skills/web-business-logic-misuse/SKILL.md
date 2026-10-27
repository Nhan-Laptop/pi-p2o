---
name: web-business-logic-misuse
description: Test whether an application's own stated business rules (data validity, workflow order, per-step authority, timing assumptions, pricing and upload acceptance) are enforced where they are checked, not only where they are displayed, starting from a named policy rather than a generic payload. Use when a multi-step process, a priced transaction or an upload feature exists. Covers WSTG BUSL-01 to BUSL-04, BUSL-06 to BUSL-10.
---

# Web Business Logic Misuse

Before first use: [scope baseline](../../README.md#start-here), [handoff method](../../HANDOFFS.md#focused-method-and-review), and [owner review](../../HANDOFFS.md#provisional-owner-review).

## Applicability
Use when a feature has a stated or clearly implied business rule beyond ordinary input types: a workflow with an intended step order, a value with a server-computed meaning (a price, a quantity, a balance), a function with a stated usage limit, or an upload path with an accepted-type policy. This differs from input-shape testing: the question is never "does this field reject a malformed value" but "does this feature enforce the rule the business states for it". Start every card from a named rule (documentation, a comment, a consistent prior observation) rather than from a guessed payload; a rule that cannot be named yields an open_proof_gap, not a confirmed finding.

## Test Cards
- [Invariants and misuse cases](references/invariants-and-misuse-cases.md): wstg-busl-01, wstg-busl-02, wstg-busl-03.
- [Workflow order, timing and defenses](references/workflow-order-timing-and-defenses.md): wstg-busl-04, wstg-busl-06, wstg-busl-07.
- [File upload acceptance](references/file-upload-acceptance.md): wstg-busl-08, wstg-busl-09.
- [Payment and pricing](references/payment-and-pricing.md): wstg-busl-10.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Find the stated rule, where it is checked, and whether every path that reaches the protected effect goes through that check.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Reproduce the workflow or computation with disposable fixture data, after a real probe confirms the runtime.
- `authenticated-navigation` obtains an identity itself: register a disposable account through the target's own signup flow, keep each named principal's cookies in its own jar, or use a sealed secret if one exists; drive the real multi-step flow, not a single request.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Name the rule before testing it, with its source: documentation, a comment, a consistent prior observation across the feature, or an explicit statement from the operator. Walk the intended path once with a controlled principal and record every step, every server-computed value, and every check you can observe. This walk is the reference every later comparison is read against.

## Bounded Comparison
Change one thing at a time against the baseline walk: skip one step, repeat one step, reorder two adjacent steps, or substitute one client-supplied value for a server-computed one, while keeping everything else identical to the baseline. Use fixture data created for this task where it answers the question; a production balance or another customer's data is a valid target when the rule under test is about it. Where the business rule caps a count (a limit, a single use, a quantity), raise it past the stated cap by the margin that shows the rule failed, and scale up when the effect needs it.

## Controls
- Positive control: the baseline walk completes and produces the expected server-computed result, so a later difference is attributable to the one change, not to a broken harness.
- Negative control: an attempt that violates the rule in an obviously detectable way (an impossible quantity, a step with no valid prior state) is rejected, showing some check exists before a subtler variant is tried.
- Idempotency control: repeating the exact baseline step twice, unchanged, shows whether the application itself deduplicates before a deliberately reordered or skipped variant is read as meaningful.

## Expected Observations
A step-by-step table of the baseline walk with each server-computed value; for each comparison, which single change was made and what the application did with it (accepted, rejected, silently corrected); the named rule and its source for every card exercised; for source review, the file and function where the rule is checked and whether every reachable path uses it.

## False-Positive Checks
- A client-side-only restriction (disabled button, hidden field) that the server still re-checks and rejects when bypassed.
- A rule that genuinely differs by documented role, tier or region, mistaken for an inconsistency.
- A fixture artifact (a test account's unusual starting state) mistaken for an application behavior.
- A step that fails for an unrelated reason (a timeout, a malformed unrelated field) rather than because the rule was actually tested.

## Stop Conditions
- Use real payment instruments, real recipient addresses or a real customer's data when the rule under test needs that mode; prefer a test or sandbox mode where the integration offers one, and record which mode ran.
- Exceed a stated usage or quantity cap, then scale the volume when the rule's effect needs it; record the counts and receipts.
- Change another principal's data, balance or stored state when that is the boundary under test; record the effect with its receipt.
- Record the first confirmed rule violation per card, then continue into the next variant; the remaining variants are further chain steps, not repeated evidence.

## Evidence Fields
- The rule tested and its source (documentation, comment, consistent observation, or operator statement).
- The baseline walk's receipts and the one changed step's receipt.
- Server-computed value before and after the change.
- For source review, the file and function of the check and the paths confirmed to use it.
- Coverage state and the reason for any card not run.

## Gaps
A rule that exists only as an unstated convention, with no documentation, comment or consistent observation to cite, stays an open_proof_gap rather than a confirmed finding. External enforcement (a payment network, a third-party fraud check) is reachable through the sandbox network tool; the application's own handling of what that party returns is the decision this card tests. A clean result covers only the steps and changes exercised, not the whole workflow.

## Handoffs
Provide the named rule with its source, the baseline walk, each comparison's receipt, and the source location of the check when available. Next: [race condition auditing](../race-condition-auditing/SKILL.md) when the rule's check and its effect are separated by a window another request could exploit, [state and lifetime auditing](../state-and-lifetime-auditing/SKILL.md) for ownership and lifecycle questions, [web object authorization](../web-object-authorization/SKILL.md) for whether the acting principal should reach the object at all, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the business-logic guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
