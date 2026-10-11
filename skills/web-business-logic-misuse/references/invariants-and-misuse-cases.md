Tests: wstg-busl-01, wstg-busl-02, wstg-busl-03

# Invariants and misuse cases

Cards for [web business logic misuse](../SKILL.md). All three ask whether a server-side check exists at all for a value whose validity or writability the business, not just its type, defines; a client-side-only rule is the typical failure these cards look for.

### wstg-busl-01 Server-side business validation
- Trigger: a value has a business-defined valid range or form beyond its basic type (a quantity, a status, a relationship between two fields) stated in documentation, a comment, or consistently enforced by the visible interface.
- Inputs: the baseline request (H, A); the validation code (S).
- Steps: name the business rule and its source. Send the same request with the value changed to one the interface would never offer but that still matches the field's basic type (an out-of-range quantity, an inconsistent combination of two related fields), bypassing the interface rather than fighting it. Compare the server's acceptance against the baseline.
- Conclude: confirmed when the server accepts a value the stated rule forbids. In source, confirm whether the check exists only in client-rendered code or also runs server-side on every path that reaches the protected effect.
- Evidence: the rule and its source; the two requests and receipts; the source location of the check when available.
- Record: cell for wstg-busl-01 with a policy key naming the rule.
- Stop: use fixture data; one accepted violation per rule is enough.
- Not a finding when: the server rejects the out-of-range value, or the rule is confirmed enforced on every reachable path in source.

### wstg-busl-02 Hidden or guessable field control
- Trigger: a request carries a field not exposed by the normal interface (a hidden form field, a flag the interface never shows, a value that increments predictably) and documentation or a comment confirms it has a business meaning beyond display.
- Inputs: the baseline request (H, A); the field-handling code (S).
- Steps: name the field's intended meaning and who should be able to set it. Resend the baseline request with that field added or changed to a value outside what the interface would offer, and compare the server's handling against the baseline.
- Conclude: confirmed when the server honors the field's changed value for an effect the acting principal should not control, with the rule named. A field that is read but has no effect on the outcome is not a finding.
- Evidence: the field, its baseline and changed value, the two receipts, and the source location of where it is consumed when available.
- Record: cell for wstg-busl-02.
- Stop: fixture data only; confirming the field has an effect is enough, no further escalation.
- Not a finding when: the field has no effect on the outcome, or the server re-derives its own value regardless of what was sent.

### wstg-busl-03 Integrity of component-handled data
- Trigger: a value flows into a component that documentation or a comment says should restrict who may read, write or remove it (a log, a derived record, an audit entry), beyond the request that originated it.
- Inputs: a controlled principal with and without the stated authority (A); the component's handling code (S).
- Steps: name the component and its stated access rule. With the principal who should not have the authority, attempt to insert, change or remove the value that rule protects, through whichever path reaches that component, and compare against an attempt by the principal who should have it.
- Conclude: confirmed when the unauthorized principal's attempt succeeds where the rule says it should not, with the rule named. This is a special case of object or field authorization; when the question is purely "which principal may act on this object", prefer [web object authorization](../../web-object-authorization/SKILL.md) instead.
- Evidence: the component, the rule and its source, and the two principals' receipts.
- Record: cell for wstg-busl-03.
- Stop: fixture components and fixture data only; never a production log or audit trail.
- Not a finding when: the unauthorized attempt is rejected, or the component's stated rule cannot be named from any source.
