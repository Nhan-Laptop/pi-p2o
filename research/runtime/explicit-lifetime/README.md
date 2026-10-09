# Explicit assessment lifetime acceptance

Baseline: `58eb8e980eb12258bad9956d5de0c15b50da406f`. The operator reviewed a read-only dry run and then explicitly approved implementation.

## Changes

- Removed the assessment's 30-minute timer/deadline and the worker's inherited absolute expiry. Owner/task gates now depend on active live-run identity, not elapsed time. No synthetic far-future/Infinity timestamp is used.
- V2 worker tickets explicitly declare `lifetime: "until-stopped"`; malformed/implicit/legacy lifetime formats are rejected, not renewed. Extension/image identity, private storage/socket and owner-minted in-memory token registration still apply. A file or restored transcript cannot start/reconstruct authority.
- Shell/network tasks default to `timeout: 0` (omitted also means no duration limit). Optional positive safe-integer seconds have no 60/300-second ceiling. Unbounded execution bypasses GNU timeout and explicitly disables the Docker CLI's task timer; infrastructure defaults remain finite.
- HTTP defaults to no extension-imposed per-hop task deadline. `timeout` and `connectTimeout` are optional probe choices; curl/OS/DNS/provider errors and connection defaults may still apply. Broker task waits explicitly disable their RPC duration timer, including queue/execution waiting. Control/authentication/creation/cleanup watchdogs remain.
- Manual stop, finish, worker withdrawal, report, session exit/error and verified cleanup remain. Worker socket loss revokes that identity and aborts all its in-flight commands, including copied-ticket connections. Cancellation reaps the relevant executor/children; shell cancellation or an opt-in shell timeout removes the shared container, which can interrupt peers. Pending DNS waits are abortable; late results cannot launch a request after cancellation.
- Command-count/coordination/resource/output/retention limits, exact-origin HTTP, the disclosed unrestricted opaque-network egress, scope confirmation, independent evidence review and runtime-profile enforcement are unchanged. There is no automatic continuation/retry/failover/new model-turn timer.

## Verification

- Typecheck, build/import and full `npm test`: **152 Vitest passes / eight opt-in skips**; **143 Python tests ran successfully / one skipped**; render, provenance/library/orange checks passed.
- Real Docker plus inert native suite: **seven passes**. A local shell command slept **65 seconds**, exceeding the old 30-second default/CLI watchdog and 60-second shell ceiling, then returned successfully. A host-published fixture replied after **22 seconds**, exceeding the old HTTP hop limit. An explicitly selected one-second HTTP timeout still failed without replay; the shell remained active; cleanup absence was verified.
- Real visible Herdr with inert scripted provider: **one pass**. No live/paid model agent or external assessment was started.
- Regression coverage includes an injected one-year owner-clock jump, late worker activation/tasks, no 30-minute timer, explicit-v2 lifetime validation, stopped-run/ticket replay denial, null subprocess task timers versus preserved infrastructure watchdogs, RPC task waits exceeding a short coordination timeout, cancellation/revocation and DNS cancellation with late-result suppression. This establishes tested mechanics, not indefinite-duration stress testing or semantic security.
- Initial failures were stale fixture expectations for elapsed expiry, old prompt hashes and executor ceiling metadata; updated fixtures and deliberate current-policy hashes passed the complete suite. Historical acceptance/studies were not rewritten or resumed.

Installed revision/hash/package/normal-quota-Docker receipts are recorded in `acceptance.json` after release verification. No user secrets, raw transcript or private reference snapshots are published.

## Remaining limits

No elapsed deadline is not unlimited command count, resources, model context, provider availability or money. A settled lead can remain idle; no mechanism forces new model turns. Use `/p2o stop` or finish rather than leaving a paid/networked run open. Hard-killing Pi/losing Docker can leave containers/panes; cleanup failures remain explicit. Reload ends the old run; old in-memory assessments do not gain this policy by changing files on disk. End old work and `/reload` the installed extension. See [usage](../../../docs/USAGE.md) and [transport boundaries](../../../docs/HTTP_TRANSPORT.md).
