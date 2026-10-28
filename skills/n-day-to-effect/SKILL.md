---
name: n-day-to-effect
description: Take a patch diff or an advisory lead to a triggered effect — test applicability against the installed artifact, build the trigger from the change, and never count a version match as proof.
---

# N-day to Effect

Before first use, read [focused method and review](../../HANDOFFS.md#focused-method-and-review).
The lead may come from [patch diff analysis](../patch-diff-analysis/SKILL.md) or from an advisory identifier the run records. This procedure decides whether the installed thing is affected, builds the trigger, and records the claim a worker can defend.

## Entry conditions

1. A lead with an identity: a changed revision or patch, an advisory identifier, a regression test, or a component fingerprint plus a plausible affected range. A lead is untriaged; it is not a claim and it is not a finding.
2. A reachable surface where the component processes input the run can influence, named with the request, file or field that carries it.
3. The installed artifact's identity as the target presents it: package version and build, file hash, image digest, or the shipped source if it exists. A version string alone is a hypothesis about the artifact, not the artifact.
4. A lab or the target itself where a trigger can run without destroying the evidence.

This procedure ships no script: the trigger's shape comes from the patched function and the target's own surface, and a fixed CLI would replay one construction as if it were the class.

## Gates

**Gate A — applicability is about code, not about versions.** Read the change: which function, which check, which input reaches it. Find that slice in the installed artifact — source if the run has it, the shipped file or a bounded disassembly if not — and establish whether the correction is present. *Pass:* a named code slice in the installed artifact that lacks the check, plus the route that reaches it, with the hash or build that anchors the artifact. *Fail:* a version string, banner, changelog, package name or advisory range matches. That is a lead to keep testing, and it stays a lead.

**Gate T — build the trigger from the change.** Construct the smallest input that exercises the missing check, and write down the predicted difference before sending. Keep the control: the same request with the trigger removed, and where possible the same request against a build that has the correction. *Pass:* trigger and control differ in the predicted, attributable way, twice. *Fail:* the difference is a generic error page, a rate limit, or a timing drift the control also shows.

**Gate E — observe the effect from the target's side.** Read it through something the trigger does not control: a crash whose address or signal moves with the input, a file or record created, a response only the vulnerable path produces, a callback that arrives. A server error, a stack trace or an exception is a symptom; it is not the effect until it moves with your input and not with the control. *Pass:* the artifact and the depth are recorded — crash, read, write, execution — with timestamp and environment fingerprint. *Fail:* you have a lead and a request; that is not an effect to dress up.

**Gate D — depth, then claim.** State the deepest rung the trigger reached, and no more. Bring the trigger again through a different send or path before confirming. Record the claim as a worker would:

- before the trigger: `closure` is `open_proof_gap`, `execution` is `not_tested` or `blocked` (only when a named tool or host actually refused), `proof` is `static_trace`, and the lead is cited;
- after a tested, observed effect: `closure` is `confirmed`, `execution` is `tested`, `proof` is `live_reproduction` (or `offline_reproduction` in a lab), with same-run receipts and the negative control;
- `policyBasis` follows what the effect established, not what the advisory said: unauthenticated code execution or a crossing made with only the attacker's own credential is `boundary_invariant`; a documented contract the target violates is `explicit_contract`; an inferred policy stays `inferred` and carries the limitation the rating needs.

A version match never becomes `confirmed`, and the advisory is never the receipt.

## Completion definition

- the lead's identity and where it came from (patch, advisory identifier, regression test);
- the installed artifact's identity — hash, build or version as observed — and what could not be observed;
- the comparison: the slice read, the correction present or absent, and the tool or route used to read it;
- the stored trigger with its hash, and the control that did not trigger;
- the effect artifact, its depth, timestamp and environment fingerprint;
- the claim fields recorded as above, including what was not tested and the variants left open;
- cleanup of files, accounts or state the trigger created.

Not finished: "the version is vulnerable", a public proof of concept run without reading the change, a crash equated with execution, or a lead promoted to confirmed because the advisory is authoritative.

## The wall

A wall is a named check, not a verdict:

- **The correction cannot be located in the installed artifact.** A stripped bundle, a bundled dependency or a missing image leaves applicability unanswered. Say which artifact would answer it — a build with symbols, the shipped source, an image digest — and stop; a version match is not a substitute.
- **The installed artifact is not the affected one.** Record the comparison and close the lead as not applicable, with the check that showed it.
- **The trigger needs a precondition the run cannot build.** A tenant, a stored object, a window or a configuration the target does not expose: name the missing ingredient and hand it on as a `needs` edge.
- **The only available proof of concept is someone else's.** Do not run an untrusted exploit against the target and do not paste one into a payload store; build the trigger from the change and cite your own reproduction.
- **The smallest demonstrating effect is already destructive.** Stop before the effect that damages the target; report the depth reached, the trigger that produced it, and why the next step was not taken.

Applicability evidence, trigger construction and the claim table are in [n-day applicability](references/n-day-applicability.md).
