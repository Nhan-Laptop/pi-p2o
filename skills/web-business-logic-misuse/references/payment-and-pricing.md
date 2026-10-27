Tests: wstg-busl-10

# Payment and pricing

Card for [web business logic misuse](../SKILL.md). It asks whether a priced transaction's server actually recomputes the values that decide what is charged, rather than trusting a client-supplied echo of them. Prefer the integration's own test or sandbox mode when it exists; a live charge or a real payment instrument is reachable when the pricing question needs that mode, and either way record which mode ran.

### wstg-busl-10 Server-side recomputation of transaction values
- Trigger: a checkout, subscription or similar flow computes a monetary amount from a quantity, a unit price, a currency, or a discount, and a payment integration exists.
- Inputs: a baseline transaction completed in whichever mode the integration offers (A); the amount-computation code (S).
- Steps: name which values the client's requests carry during the flow (quantity, item identifier, currency, a discount code) and which the server is supposed to compute itself (unit price, final amount). Walk the baseline once. Then, one change at a time: resend an intermediate step with the quantity or currency changed to a value still valid in form but different from the baseline; if the flow passes through a value-bearing step more than once, resend an earlier step's value at a later point in the same flow; if discount codes exist, name their stated structure and try values consistent with that structure that were never issued to this session, recording each attempt. Compare the final charged amount in test/sandbox mode against what the baseline's quantity, currency and codes would correctly produce.
- Conclude: confirmed when the final amount reflects a client-supplied value the server should have recomputed itself, or when a discount code never issued to the session is accepted, shown against the correctly computed baseline amount. In source, confirm whether the amount is recomputed server-side at the step that actually authorizes payment, or only validated for form.
- Evidence: the rule for which values are client-supplied versus server-computed; the baseline and each changed step's receipt with the mode named; the source location of the recomputation when available.
- Record: cell for wstg-busl-10 with a policy key naming the pricing rule.
- Stop: choose the mode the pricing question needs — test or sandbox when it exists, live when the rule appears only there — and record the mode, the charge and the receipt. A discount code belonging to another party is valid when the rule binds it, and an automated sweep is a next step when the question needs scale.
- Not a finding when: the integration has no test or sandbox mode, so the live mode is used and recorded as such; or source confirms the amount is recomputed at the authorizing step regardless of what the client sent.
