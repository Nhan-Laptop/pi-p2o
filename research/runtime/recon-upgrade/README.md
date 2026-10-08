# Tool guidance and reconnaissance upgrade — verification

## Changes

Removed the active capability tool, broker operation, snapshot/export fields, fixed-probe modules and capability-ID registry. Catalog workflows now carry descriptive prerequisites. Blocked candidates require a bounded reason and stay open; evidence, policy provenance, revisions and independent-worker requirements remain enforced.

Lead and worker instructions share bounded source/URL recon guidance, evidence-linked inventories, assumption correction and qualitative next-task selection. Handoffs, templates and web playbooks use that same contract. Actual owner/broker scope, command budgets, timeout/cancellation and cleanup remain authoritative.

Historical `research/runtime/skill-upgrade/` artifacts are unchanged. Removed tool names still appear in historical artifacts, the migration plan and negative regression assertions; they are not active registrations.

## Verification before shipping

- Full suite: 115 TypeScript tests passed, six opt-in skips; 141 Python tests ran successfully, one opt-in skip.
- Docker suite: five tests passed (actual non-root/read-only/offline behavior, cancellation, broker scratch isolation, real Pi with scripted providers, cleanup).
- Real Herdr: one visible-pane lifecycle test passed with an inert provider.
- Optional explicitly selected immutable Semgrep image: one test passed; five vulnerable candidates, zero fixed matches and no scanner errors. No image build, installation or network access was performed during this upgrade.
- Library/provenance/freshness validators and package dry-run passed. Package exclusions cover reference checkout, scratch targets and private session exports.
- Recon regression exercises an owned inert source app with routes, a tenant guard and an asynchronous service consumer; records corrected identity assumptions, next-task rationale, same-run evidence and a missing-tool gap. The source copy retains hashes and no deployment/history is invented.

One initial Docker test failed because a global before/after container snapshot counted an unrelated concurrent fixture. The test now verifies only its own assessment run label, and fails on Docker inspection errors instead of turning them into an empty result. The Docker suite passed after this correction.

## Installed acceptance

Implementation commit `6a89e5573691ff002008f8faa0b4efa2e1af803f` was committed, pushed and installed with Pi before acceptance. Installed-path tests passed: three real-Pi tests (normal cross-process worker, terminal quota worker and real Docker owner). The installed library validator also passed. All runtime module, extension, catalog, handoff and template hashes matched the committed checkout; the removed modules are absent.

`P2O_TEST_INSTALLED_EXTENSION` makes the real-Pi owner/worker fixtures import the installed package, rather than silently retesting the development module. It preserves installed extension identity for worker tickets and exported manifests. Native exports retain worker knowledge reads, evidence-linked inventory/decision notes, an open candidate, reports and cleanup. Neither export has capability metadata. See `acceptance.json` and the two `installed-native-*.json` receipts. Final publication changes only plan/verification artifacts; runtime hashes remain those tested here.

## Limits

These tests verify enforcement, prompt/tool delivery, catalog loading, cross-process ledger handoffs and scripted recon/decision/candidate plumbing. Inert providers are mechanical fixtures, not live agents or evidence of improved autonomous security reasoning. No paid agent runs, external requests or new transports were used. No fresh comparative benchmark was restarted.

A local URL recon fixture is deferred: public-target IPv4 restrictions must not be relaxed to create a test convenience. Existing URL scope/SSRF tests and source-versus-URL instruction regressions cover the current contract, not autonomous URL recon quality. Historical partial/contaminated benchmarks do not establish comparative effectiveness.
