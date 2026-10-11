Tests: wstg-busl-04, wstg-busl-06, wstg-busl-07

# Workflow order, timing and defenses

Cards for [web business logic misuse](../SKILL.md). The first two ask whether a multi-step process enforces its intended order and timing; the third is not a test of its own but a reading of what the other cards already observed about how the application reacts to being tested.

### wstg-busl-04 Timing-dependent process assumptions
- Trigger: documentation or a comment states that a process depends on elapsed time (a window to complete a step, a required delay between two steps, an expiry) in a way that affects a business outcome, not only a session timeout already covered by [web session management](../../web-session-management/SKILL.md).
- Inputs: the baseline walk of the process (A); the timing rule's source (S or documentation).
- Steps: name the timing rule. Walk the baseline once within the stated window, then repeat the walk holding one step open past the stated window before submitting it (or, if the rule caps how soon two steps may repeat, repeat them faster than the stated minimum), and compare the outcome.
- Conclude: confirmed when the application accepts a step outside the stated timing rule in a way that changes a business outcome (a price, an allocation, an access grant) from what it would have been on time.
- Evidence: the rule and its source; the baseline and the timing-violating walk, with timestamps.
- Record: cell for wstg-busl-04.
- Stop: one violating walk per rule is enough; no repeated automated timing sweeps against a shared resource.
- Not a finding when: the outcome is the same regardless of timing, or the server re-evaluates the time-dependent value at the point of use rather than trusting an earlier step.

### wstg-busl-06 Workflow step order and completeness
- Trigger: documentation, a comment, or the interface's own navigation implies a required order or a required set of steps for a multi-step process.
- Inputs: the baseline walk (A); the step-sequencing code (S).
- Steps: name the intended order. Walk the process again skipping one intermediate step, or requesting the steps in a different order, while keeping every other step identical to the baseline, and compare whether the final outcome still occurs and whether it matches what the full baseline order produced.
- Conclude: confirmed when the outcome of the skipped or reordered walk matches or exceeds the full baseline outcome, showing the server does not actually require the order it implies. In source, confirm whether each step checks that its stated predecessor was actually completed, or only that the overall request is well-formed.
- Evidence: the intended order and its source; the baseline and the altered walk, with receipts for each step; the source location of the step-completion check when available.
- Record: cell for wstg-busl-06.
- Stop: one altered walk per workflow is enough; never carry a resulting benefit into further use.
- Not a finding when: the altered walk is rejected, or produces a strictly worse outcome than the full baseline.

### wstg-busl-07 Observed defenses against the cards above
- Trigger: always, after running one or more of the other cards of this skill or a related business-logic card elsewhere in this library.
- Inputs: the receipts already collected while running those cards.
- Steps: read back through those receipts for anything that looks like a defensive reaction rather than an ordinary accept or reject: a changed response shape, a delay, a step-up challenge, a logout, or a visible display of attacker-controlled text inside a part of the interface meant for trusted content. Note whether the reaction appeared for every violating attempt or only some.
- Conclude: this card does not produce its own violation; it records whether application-level defenses exist and are consistent, as context for the rules above, and separately flags any case where attacker-controlled text appeared somewhere a user would read it as trusted, as its own observation for a client-side output-handling skill to pick up.
- Evidence: the reactions observed, cross-referenced to the receipts of the cards that produced them.
- Record: a note attached to the cells already created by the other cards, not a new standalone cell unless a distinct observation (such as the trusted-content issue) was found.
- Stop: no new requests beyond what the other cards already sent.
- Not a finding when: no additional observation beyond what the other cards already recorded.
