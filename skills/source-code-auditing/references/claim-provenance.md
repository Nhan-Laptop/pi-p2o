# Claim provenance before confirmation

Validation guideline for [source-code auditing](../SKILL.md), the application playbooks, and the framework overlay. It answers one question before a candidate is marked `confirmed`: is the rule the target is being judged against established, or only inferred?

## Intended-policy provenance

Name where the intended policy comes from. A contract, schema, documented role or ownership rule, an operator-confirmed requirement, or a named policy location in the reviewed revision is provenance. A convention that merely looks usual, a naming pattern, a sibling operation, or a model's expectation is not provenance; it is a hypothesis. Record the source of the expectation on the candidate itself. When the only support is inference, the honest closure state is `open_proof_gap`, not `confirmed` and not `ruled_out`.

## Distinct operations can differ by design

Read, create, update, delete, list, aggregate, and export are separate operations with separate policy decisions. A target may deliberately allow a tenant-wide export while restricting individual update fields, or expose an aggregate to a role that cannot read a single record. Do not project one operation's policy onto another without evidence that the same rule governs both. Field constraints follow the same rule: a constraint that applies to an update path, such as an owner-only or administrator-only field, is not automatically a read, list, or export constraint. Establish the policy for the specific operation and field before treating a difference as a missing control.

## Sibling surfaces are hypotheses

A route, version, prefix, mount, or handler that appears to enforce a stricter or different gate does not establish the intended policy for its sibling. Different operations may intentionally require different roles, and an alternate version may be a different application object with its own dependencies and registration. Verify the effective registration, the dependency path, and any stated contract for the surface under test. A sibling difference is a review lead; when it is the only argument for the expectation, it is an `open_proof_gap`.

## Marker provenance and reachability

A literal that looks like a credential, key, token, or personal identifier in a synthetic fixture, test data, example, or generated artifact is not a deployment-secret finding by itself. Before promoting it, establish provenance (where the value is produced and whether a deployed configuration actually consumes it) and reachability (which actor and path reach the effect, and what the effect is). The same rule applies to inert execution markers: they demonstrate that a harness works, not production impact, until a reachable consumer is shown.

## Closure without blanket dismissal

The provenance rule constrains confirmation, not investigation. A reachable unauthorized protected effect demonstrated against a stated policy is `confirmed`; do not downgrade it because provenance is inconvenient. When a reachable effect is plausible but the intent is only inferred, record `open_proof_gap` and name the missing provenance so another owner can resolve it. Never convert an unresolved intent question into a false-positive dismissal, and never close a candidate silently to tidy the worklist.

## Handoff fields

Include intended-policy provenance, the operation and field scope, sibling surfaces considered, marker provenance, reachability, and the requested proof stage. A handoff that says only that something looks unauthorized is not ready; a handoff that names the contract, the inferred gap, and the disconfirming observation is.

Original P2O validation guidance, not adapted from the reviewed upstream snapshot; see [skill provenance](../../../research/SKILL_PROVENANCE.md).
