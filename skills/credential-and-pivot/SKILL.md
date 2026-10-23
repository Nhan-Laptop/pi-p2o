---
name: credential-and-pivot
description: Take a credential you are authorized to find from "it exists" to "it opens exactly this door", verifying it with one bounded act, mapping the privilege it carries, and stopping at the scope boundary instead of walking through every door it opens.
---

# Credential and Pivot

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).
This skill deliberately ships no script: the dangerous part of credential work is automation, and a harness that uses a
credential for you is a harness that pivots without a decision. One credential, one authorized use, written down.

## Entry conditions

1. A confirmed claim shows a credential is reachable by the primitive under test — a readable configuration file, a
   memory disclosure, a log line, a database row, a token in a URL or cookie, a metadata document.
2. You know **which principal** the credential belongs to and which service accepts it.
3. The engagement names the systems the credential may be used against. A credential that authenticates to a system
   outside that list is a finding about exposure, not a licence to log in.
4. The exposure itself is already recorded: where it was found, how it was read, and the scope of the read.

## Gates

**Gate E — exposure.** Establish that the credential is *usable*, not merely present: the right format, not expired, and
not a placeholder from a template or an example file. *Pass:* format, issuer and expiry stated from the material itself.
*Fail:* a placeholder is not a credential; report the exposure of the file, not a credential effect.

**Gate V — one bounded verification.** Verify with the smallest act that answers "does this principal work here": a
read of the principal's own identity (whoami endpoint, `SELECT current_user`, token introspection), on the authorized
system, once. *Pass:* the identity returned, recorded with timestamp. *Fail:* stop, and record the refusal — a lockout
caused by guessing destroys access for everyone.

**Gate M — privilege map.** From the verified identity, read the policy that applies to it: role, group, tenant,
scopes, allowed verbs. *Pass:* the map comes from the system's own authorization data, not from the credential's name or
the application's marketing page. *Fail:* an assumption about privilege is not a pivot.

**Gate P — bounded pivot.** Use the credential for one operation that the map says it may perform, on a system the
engagement names, and observe the result from the far side. *Pass:* the operation's effect is in the target's own data
or log, and it is an effect the unauthenticated or lower-privileged principal could not produce. *Stop after that
operation* and report; do not use the credential for a second, unrelated action because it happens to be available.

## Completion definition

- the credential's location (path, table, field, log line), with the exposure evidence and its time;
- the principal it belongs to, and how that was verified once, not assumed;
- the privilege map with its source;
- the single operation performed, its target, its result, and the observation that proves it;
- what you did **not** do: every door the credential opens that the engagement did not name;
- redaction: no secret value in the case narrative, the report, or the payload; quote a prefix or hash instead.

Not finished: a credential listed as "found" with no verification; a session created and never used (an unused session
is exposure, not access); a pivot performed to "see what else works"; a secret pasted into a payload that is stored
verbatim.

## The wall

- **Verification refused or locked.** Record the lockout, stop, and report the exposure. Guessing past a lock is how a
  credentialed assessment turns into an incident.
- **Privilege map narrower than expected.** A credential that authenticates but may do nothing interesting is a real,
  reportable result: authentication without authorization.
- **The named systems do not include the one that would be interesting.** Report the boundary. Escalating beyond it is a
  scope change that only the owner can authorize.
- **Secret material you cannot redact from stored artifacts.** Do not store the payload. Reference the location, and
  have the lead decide how the artifact is handled; a stored credential outlives the assessment.
- **Rotation during the engagement.** The credential dies mid-test; that is a fact about the client's response, worth
  recording, not a reason to hunt for another one.

A credential is a key, not an invitation. The result this skill produces is the door it opens, named exactly — and
the wall is every door in the map that the engagement did not authorize you to open.
