# Lean lead prompt — verification

## Scope

This is a lead-only prompt simplification. Active tool descriptions and parameter schemas remain Pi's tool contract. The lead policy contains no tool names, call examples, pagination instructions or field-spelling tutorials. It retains confirmed scope, untrusted-data rules, recon/next-task judgment, delegation, intended-policy provenance, closure, independent validation, counterevidence, coverage and verified cleanup.

The owner contributes one structured `p2o_assessment` section through `systemPromptOptions`. It does not replace Pi's whole system prompt or modify other sections/tools. A short kickoff replaces the duplicated full user-message instruction dump. Repeated hooks replace the section; finish/stop/replay tests ensure active authority is not retained or reactivated.

Worker instructions and briefs remain byte-identical to `8f6db40` for fixed URL and directory fixtures, including their tool guidance. Runtime authorization and evidence validation are unchanged; prompt text is not a security boundary.

## Pre-shipping checks

- Full suite: 118 TypeScript tests passed, six opt-in skips; 141 Python tests ran successfully, one opt-in skip.
- Docker suite: five tests passed, including real-Pi/inert-provider integration, real offline/non-root/read-only sandbox behavior, broker isolation, cancellation and cleanup.
- Real Herdr: one visible-pane lifecycle test passed with an inert provider.
- Actual provider-facing context checks: one structured lead policy, no tool tutorials in it, descriptions and candidate schemas still present, short kickoff without duplicate policy, evidence/decision/candidate records and terminal quota handling.
- Real Pi objective-wrapper ordering remains valid with structured-section injection; no queued follow-up or new live benchmark is used.

For fixed facts, the URL lead policy shrank from 7,557 to 4,647 characters and the source policy from 7,440 to 4,567. These are character counts, not token savings or quality results; the additional duplicate startup policy was removed altogether.

An initial native assertion counted the section's XML tag (`p2o_assessment`) as a tool name. The assertion now extracts the section body before checking tool tutorials; actual provider-facing checks and reruns passed.

## Installed acceptance

Pending commit → push → Pi reinstall, revision/hash matching and installed-path native/Docker tests. Acceptance evidence will record the installed implementation revision.

## Limits

All model traffic is scripted/inert, not paid providers or evidence of autonomous security quality. No external targets, new assessment transports, credentials, sandbox-tool installation or fresh comparative benchmark were used. Historical sessions and prior acceptance artifacts were not rewritten. Reload/restart Pi (preferably a new session) to use the installed prompt changes; old transcript messages remain historical.
