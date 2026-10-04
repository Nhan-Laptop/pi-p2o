# Scoped first-use verification

These controller APIs are available for first-use integration; they do **not** enable new network authority or automatically wire the UI/composition.

## Supported classes

- **Scoped HTTP/HTTPS read-only differential:** a concrete, collector-evidence-bound reproduced claim, plus exact owner-approved baseline, negative control and reproduction requests. Same approved origin/path, account, GET/HEAD, explicit distinguishable predictions; no body, caller headers or redirects. Literal loopback is not required. External URLs must already be inside the run **and** broker allowlist (including CIDRs, exclusions, account, action, expiry and caps).
- **Demonstrated static source property:** preserved redacted UTF-8 file bytes, hash, line range, exact excerpt, evidence ID and separate explicit security hypothesis. Only the literal cited property can be `supported-static`; a lexical suspicion, task question or model agreement is not a confirmed vulnerability.

## Controller integration

1. After producer evidence admission, supply `candidate` (`FindingRecord`, baseline evidence IDs, `requiresTargetReset:false`) and `vault` to `synthesizeFirstUseVerification`. Missing candidate/policy fails closed. Retain `leg.candidate`'s exact evidence IDs in reporting; do not substitute nearby packet receipts.
2. Supply `verificationPolicy = createScopedVerificationPolicy(run, actualBrokerScope, clock)` and its producer `policyContext`. This is an in-process controller capability, not serializable worker JSON. Synthesis authenticates claim/controls, exact operation-input receipts and source/input/configuration scope.
3. Issue a **separate verifier-role grant bound to the live verifier attempt**, without widening targets/accounts/actions/caps. Recreate the capability from that actual verifier broker scope and pass it to `createFirstUseReplayEnvironment`. Its scope digest must match collector and transport receipts. Do not persist/reconstruct a policy by copying its fields.
4. Run the approved verifier baseline first. `leg.replay` carries the exact baseline tool input. Environment preparation requires the authenticated verifier baseline receipt and exact recipe digest. Every replay request uses the existing `http.request` broker, with active grant/account checks, DNS pinning/rechecks, TLS certificate/hostname verification and normal shared budgets. Redirect cap is zero; no credentials can be invented, copied into worker input, or escalated.
5. For source, use `sourcePropertyClaim` and `reviewSourceCandidate`. The source collector must preserve raw redacted bytes as `text/plain`, with `metadata.claimDigest` and `metadata.sourceClaim = {path,fileHash,startLine,endLine,excerpt,hypothesis}`. Aggregate `source.analyze` scan JSON alone is insufficient. The API returns an authenticated review, not a vulnerability confirmation.

## Bundled `/p2o --target` wiring (read-only differential)

The bundled first-use HTTP path now performs this contract end to end without synthesizing a finding before execution:

1. At exact plan approval the controller derives the verification program from the owner-approved checks alone
   (`deriveFirstUseVerificationPlan`) and pre-authorizes the exact verifier task as a **deferred** owner-grant
   task with a narrowed verifier-role grant. `control/verification-synthesis.json` records the derivation phase
   `candidate-evidence-required`; no finding plan, verification plan or check is created and no task is admitted.
2. Only inside the producing attempt's durable `packet.admit` acceptance does the controller re-derive the
   program, select the exact per-claim receipts with `selectReceiptBoundProducerCandidate` (one claim-bound
   baseline observation, one passing negative control, one passing reproduction; distinct, same attempt/scope/
   operation-input digest) and re-validate them with `synthesizeFirstUseVerification` against the producing
   attempt's actual broker scope. The decision is recorded in `control/verification/admission.json`.
3. On success the verifier task is admitted in the SAME run and launched by the normal supervisor, with its
   provider turns charged to the protected verifier phase ledger (never borrowed from the worker phase). On any
   refusal or admission failure the run completes without a verifier attempt, the record states the reason and
   nothing is promoted.
4. The verifier worker performs one owner-approved baseline observation and calls `p2o_verify`; the verifier
   `p2o_verify` tool exists only for the verifier-role tool policy. Promotion/rejection still comes from the
   controller replay in `createFirstUseReplayEnvironment` with `targetReset:false`.

This wiring does not extend to: checkpoint-restored runs, source-only runs (no finding), plans without exactly
one distinguishable control/reproduction pair, or worker packets that were never admitted through the bridge.

## Outcomes and limits

Passing baseline/control plus the exclusive violation prediction permits `independently-validated`. Only the safe prediction yields `rejected`. Conflicting/neither predictions, failed controls, expiry, tampered evidence or denied scope yield `unresolved`/returned-for-evidence, preserving the denominator and verifier receipts.

Verifier attempt, task environment and replay session identities are recorded separately. `independentSession:true` is **not** a clean target/reset claim: `targetReset:false`. Read-only controls establish an observable baseline, not reconstruction. Reset-dependent/stateful claims are refused; no target reset implementation is supplied.

No speculative mutation, authentication attempts, arbitrary payload/command execution, credential escalation, impact confirmation or post-exploitation is supported. EXTERNAL-shaped `.test` fixtures in tests are controlled responses/loopback routing, **not live third-party scans**. HTTPS response-fixture tests establish decision semantics, not successful live TLS qualification.
