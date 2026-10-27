---
name: credential-and-pivot
description: Take a credential from "it exists" to "here is every door it opens", verifying it with the smallest act, reading the privilege it carries from the system's own data, and pivoting through each further door that privilege reaches.
---

# Credential and Pivot

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).
This skill ships no script: credential work is where automation multiplies a single use into an unbounded one, so every
use is deliberate and written down.

## Entry conditions

1. A confirmed claim shows a credential is reachable by the primitive under test — a readable configuration file, a
   memory disclosure, a log line, a database row, a token in a URL or cookie, a metadata document.
2. You know **which principal** the credential belongs to and which service accepts it.
3. The credential may be used against every system it authenticates to that the sandbox can reach; a host it opens is a
   door to walk through, not a boundary to report.
4. The exposure itself is already recorded: where it was found, how it was read, and the scope of the read.

## Gates

**Gate E — exposure.** Establish that the credential is *usable*, not merely present: the right format, not expired, and
not a placeholder from a template or an example file. *Pass:* format, issuer and expiry stated from the material itself.
*Fail:* a placeholder is not a credential; report the exposure of the file and keep looking down the same path.

**Gate V — one small verification.** Verify with the smallest act that answers "does this principal work here": a read of
the principal's own identity (whoami endpoint, `SELECT current_user`, token introspection), on the system that accepts it,
once. *Pass:* the identity returned, recorded with its timestamp. *Fail:* the refusal and the system's own lockout
behaviour are results; a lockout experiment is a separate, recorded experiment, not a guess between attempts.

**Gate M — privilege map.** From the verified identity, read the policy that applies to it: role, group, tenant, scopes,
allowed verbs — and the resources each one reaches. *Pass:* the map comes from the system's own authorization data, not
from the credential's name or the application's marketing page. *Fail:* an assumption about privilege is not a map; read
the policy before using the credential for anything.

**Gate P — pivot through the doors.** Use the credential for the operations the map allows, following it from the first
system into each further door it opens, and observe every result from the far side. *Pass:* each effect is in the
target's own data or log, and the unauthenticated or lower-privileged principal could not have produced it. The pivot
runs until the map is covered, not until the first host does.

## Completion definition

- the credential's location (path, table, field, log line), with the exposure evidence and its time;
- the principal it belongs to, and how that was verified, not assumed;
- the privilege map with its source;
- every operation performed, its target, its result, and the observation that proves it — including each further door
  the credential opened beyond the first system;
- the reach it ends at: the furthest system, resource or privilege the credential genuinely reached, with the doors it
  left unopened and why;
- redaction: no secret value in the case narrative, the report, or the payload; quote a prefix or hash instead.

Not finished: a credential listed as "found" with no verification; a session created and never used (an unused session is
exposure, not access); a pivot that stopped at the first door the map names while the map still names reachable ones; a
secret pasted into a payload that is stored verbatim.

## The wall

The wall is the far side of the pivot: the point where the privilege map genuinely ends.

- **Verification refused or locked.** Record the refusal and the system's lockout behaviour; decide once whether a
  deliberate lockout experiment answers a real question, and if it does, run it with the effect recorded.
- **Privilege map narrower than expected.** A credential that authenticates but may do nothing interesting is a real,
  reportable result: authentication without authorization.
- **The credential opens a system nobody named.** Walk through it: the door is part of the privilege's reach, and the
  system it opens joins the map and the report.
- **Secret material you cannot redact from stored artifacts.** Keep the value out of the artifact; reference the
  location, and have the lead decide how it is handled; a stored credential outlives the assessment.
- **Rotation during the run.** The credential dies mid-test; that is a fact about the client's response, worth
  recording — then continue from whatever access survives.

A credential is a key, not an invitation. The result this skill produces is every door it opens, named exactly — and the
wall is the furthest point the map genuinely reaches, stated with the same precision as the doors along the way.
