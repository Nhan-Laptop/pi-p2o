Tests: wstg-busl-05

# Usage limit bypass

Read with [race condition auditing](../SKILL.md). A capped call-count limit is a coupled invariant like any other (`remaining uses > 0 implies the action is permitted`), so the same mutable-state inventory and schedule method apply; this card only names where the invariant usually lives and how to check it without concurrency when a single sequential path already breaks it.

Trigger: a feature states or implies a per-principal or per-object usage ceiling (a single redemption, a limited number of attempts, a capped action count, a one-time grant) and the limit is enforced by application state rather than only by a payment or external provider.

Steps: identify where the remaining-use count is read, decremented and checked, and whether the check and the decrement happen in the same operation or are separated by another request, a redirect, a retry path or an asynchronous step. First test the purely sequential path: use the action once as intended, then repeat the exact same request (replay) and a request that re-enters an earlier step of a multi-step flow (back-navigation equivalent) to see whether either grants the benefit again without a fresh count. Only if the sequential path is sound, move to the concurrent schedule from the main technique: fire the bounded two-actor schedule at the decision point so both requests read the count before either writes it back.

Conclude: confirmed when the benefit is granted more times than the stated or implied limit, with the schedule (sequential replay, step re-entry, or concurrent interleaving) that produced it and the invariant it broke. A limit enforced only by a client-side state that the server also re-checks is not a finding; one re-checked by the server alone and bypassed by either path above is.

Evidence: the read/decrement/check locations if visible, the schedule used, and the before/after count or benefit state.

Record: cell for wstg-busl-05; `methodFamily` is `source-review` or `offline-reproduction` depending on which path confirmed it; the invariant as the policy basis.

Stop: at most a few repetitions beyond the stated limit, enough to show the pattern; stop immediately once the excess benefit is confirmed and never carry a gained benefit (a redemption, a credit) into further use.

Not a finding when: the external provider (a payment network, a one-time code issuer) is the actual enforcer and the application only reflects its answer, or the count is re-read and re-checked atomically at the point of use.
