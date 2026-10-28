# N-day applicability and trigger construction

An advisory or a patch says what changed somewhere. This card separates what each kind of evidence proves, then builds
the trigger from the change rather than from the advisory. The procedure is [n-day to effect](../SKILL.md).

## What each kind of evidence proves

| Evidence | Proves | Does not prove |
| --- | --- | --- |
| Banner or version string | The service identifies itself as something | Which code is installed, whether the correction is present, or that the version was built from that source |
| Package metadata and changelog | What a distributor intended to ship | That the installed file matches, that the affected path is enabled, or that the input reaches it |
| File hash and build id | Exactly which artifact is installed | Whether the vulnerable function is present, reachable or configured on |
| Source at the changed function | The correction's presence or absence in that build | That a deployed surface reaches the function, or that the input is controllable |
| Disassembly around the check | The comparison a stripped build actually performs | Which input drives it, or that the path is reachable in this configuration |
| Installed configuration and routes | Which components are enabled and reachable | That the trigger works: a reachable path is still a hypothesis until it is exercised |
| A trigger with a control | The effect, at the depth observed | Any effect beyond that depth, or applicability to another build or variant |

A version match is a lead. A hash plus a missing check plus a route is applicability. Only a trigger with a control is an
effect.

## Building the trigger

1. **Name the slice.** The function, the check and the input that reaches it. If the change is a bounds test, the trigger
   is the length that violates it; if it is a type or dispatch check, the trigger is the selector that bypasses it; if it
   is an authorization gate, the trigger is the principal and object pair the gate was meant to refuse.
2. **Predict before sending.** Write down the response, crash signature or artifact you expect with the trigger and with
   the control. A trigger whose predicted difference you did not state cannot be interpreted after the fact.
3. **Shrink to the smallest input.** Remove fields until removing one more stops the effect; that field is the primitive.
   Keep the bytes that ran, with their hash.
4. **Control it twice.** The same request without the trigger, and where possible the same request against a build with the
   correction. A difference that survives both is worth reading.
5. **Observe away from the payload.** A crash whose signal or fault address moves with the input, a file or record that now
   exists, a response the safe path cannot produce, or an arrival at a destination the target reached.
6. **State the depth.** Crash, read, write or execution. Severity and rating follow the observed depth, never the advisory's
   wording.

## Claim fields at each stage

| Stage | `closure` | `execution` | `proof` | `policyBasis` | What must be attached |
| --- | --- | --- | --- | --- | --- |
| Lead only | `open_proof_gap` | `not_tested` | `static_trace` | `inferred` | The lead identifier, the artifact identity, the missing observation |
| Cannot reach the surface | `open_proof_gap` | `blocked` | `static_trace` | `inferred` | The tool or host that actually refused, named; a missing dependency is not a refusal |
| Trigger exercises the path but the effect is ambiguous | `open_proof_gap` | `tested` | `live_reproduction` | `inferred` | The receipts, the ambiguous observation, and the specific next observation |
| Effect observed, controlled and repeated | `confirmed` | `tested` | `live_reproduction` | `explicit_contract` or `boundary_invariant` | Same-run receipts, the control, the effect artifact, the depth |
| Effect observed, policy inferred | `confirmed` | `tested` | `live_reproduction` | `inferred` | The above plus the limitation the rating will carry |

A claim confirmed from a triggered effect is confirmed by the trigger. The advisory can supply the lead, the identifier and
the hypothesis; it can never be the receipt, and a version match can never be the effect.

## What to keep

The lead's identifier and source, the artifact identity with hash or build, the slice and the tool that read it, the
trigger bytes and hash, the control bytes, the effect artifact with timestamp and environment fingerprint, the depth, and
the list of variants and builds that were not tested. The next worker needs those to differ from you without repeating
your exploration.
