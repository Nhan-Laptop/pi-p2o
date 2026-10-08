# Lean lead prompt — verification

## Scope

This is a lead-only prompt simplification. Active tool descriptions and parameter schemas remain Pi's tool contract. The lead policy contains no tool names, call examples, pagination instructions or field-spelling tutorials. It retains confirmed scope, untrusted-data rules, recon/next-task judgment, delegation, intended-policy provenance, closure, independent validation, counterevidence, coverage and verified cleanup.

The owner contributes one structured `p2o_assessment` section through `systemPromptOptions`. It does not replace Pi's whole system prompt or modify other sections/tools. A short kickoff replaces the duplicated full user-message instruction dump. Repeated hooks replace the section; finish/stop/replay tests ensure active authority is not retained or reactivated.

Worker instructions and briefs remain byte-identical to `8f6db40` for fixed URL and directory fixtures, including their tool guidance. Runtime authorization and evidence validation are unchanged; prompt text is not a security boundary.

## Pre-shipping checks

- Full suite: 119 TypeScript tests passed, six opt-in skips; 141 Python tests ran successfully, one opt-in skip.
- Docker suite: five tests passed, including real-Pi/inert-provider integration, real offline/non-root/read-only sandbox behavior, broker isolation, cancellation and cleanup.
- Real Herdr: one visible-pane lifecycle test passed with an inert provider.
- Actual provider-facing context checks: one structured lead policy, no tool tutorials in it, descriptions and candidate schemas still present, short kickoff without duplicate policy, evidence/decision/candidate records and terminal quota handling.
- Real Pi objective-wrapper ordering remains valid with structured-section injection; no queued follow-up or new live benchmark is used.

For fixed facts, the URL lead policy shrank from 7,557 to 4,647 characters and the source policy from 7,440 to 4,567. These are character counts, not token savings or quality results; the additional duplicate startup policy was removed altogether.

An initial native assertion counted the section's XML tag (`p2o_assessment`) as a tool name. The assertion now extracts the section body before checking tool tutorials; actual provider-facing checks and reruns passed.

## Installed acceptance

Core implementation `b355eb862768ce6f2966ac77ef445de710734285` and harness compatibility update `76602c6` were committed, pushed and installed with Pi before acceptance. The harness now recognizes structured/opaque system policy metadata and historical user briefs, instead of requiring the old startup dump; cleanup run IDs still prefer exported evidence. Three installed-path real-Pi tests passed again at `76602c6`: normal worker, terminal quota worker and real Docker owner. The native provider asserted policy/tool separation against the actual model context, and the transcript retained the structured section and short kickoff. Extension identity in exports matched the installed file; the runtime module hashes matched the committed checkout.

See `acceptance.json` and the two `installed-native-*.json` fixtures. The fixtures publish their observed lead policy and kickoff along with bounded mechanical evidence; they are not a live-agent quality study. Final publication changes verification documentation/receipts only, not the tested runtime.

## Limits

All model traffic is scripted/inert, not paid providers or evidence of autonomous security quality. No external targets, new assessment transports, credentials, sandbox-tool installation or fresh comparative benchmark were used. Historical sessions and prior acceptance artifacts were not rewritten. Reload/restart Pi (preferably a new session) to use the installed prompt changes; old transcript messages remain historical.
