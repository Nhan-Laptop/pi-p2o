Tests: wstg-athz-05

# Delegated authorization flow

Card for [web token and federation](../SKILL.md). The flow is three checks the application's own endpoint should make: it only hands the result to the destination it declared in advance, it only accepts a one-time, request-bound marker back, and it only grants what the flow it actually started should produce. All testing here stays on the application's own endpoint and your own controlled client registration; it never contacts the identity provider as a target.

### wstg-athz-05 Application-side enforcement of the delegation flow
- Trigger: the application delegates authorization to or accepts delegated authorization from another party through a standard redirect-based flow, using a client registration you control.
- Inputs: a completed baseline flow for a controlled principal (A); the application's flow-handling code (S).
- Steps: in source, confirm which flow variant is used and whether it is the variant recommended for that type of client (a public client without a stored secret, or a confidential client that holds one), and whether a one-time proof value tied to the specific request is required and checked. Live, one change at a time against your own controlled client registration: (1) resend the completion step with the one-time state or proof value from a separate, earlier flow instead of the current one; (2) resend with the declared return destination changed to another address your own client registration is also allowed to use, if more than one is registered, to see whether the match is exact or merely a prefix or pattern; (3) resend the completion step a second time with the same one-time value already used once.
- Conclude: confirmed when the application's endpoint accepts a reused one-time value, accepts a return destination beyond an exact registered match, or completes the flow a second time with an already-used value. In source, confirm whether the destination comparison is exact-string and whether the one-time value is invalidated immediately after first use.
- Evidence: the baseline flow's receipts; each of the three changes and their receipts; the source location of the destination comparison and the one-time-value invalidation.
- Record: cell for wstg-athz-05 on the flow's client-registration asset.
- Stop: use only a client registration created for this assessment; never attempt to register a destination outside what the task's scope approved, and never contact the identity provider's own infrastructure as a target.
- Not a finding when: every change is rejected, or source confirms exact-match destination comparison and immediate one-time-value invalidation.
