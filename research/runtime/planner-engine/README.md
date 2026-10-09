# Planner/Engine 0.5.0 — qualified source acceptance

**Source snapshot captured before commit/install.** The source checks below remain baseline-specific;
installed mechanics acceptance is recorded separately in `installed.json`. Baseline:
`6f02060f22109df4ff360956adffc5213ad857a0`. Historical artifacts are unchanged.
See [runtime contract](../../../docs/PLANNER_ENGINE.md) and [phase status](../../../planning_update.md).

Verified on this source tree:

- Typecheck, build/import, library/provenance/Python checks: pass.
- Vitest: **179 passed, 9 opt-in skips**; Python: **143 run, 1 skipped, OK**.
- Opt-in source Docker/native suite: **8 passed** (no external assessment or paid model).
- Genuine Pi/child-Pi inert-provider tests: idle semantic wake, settlement continuation, pending human follow-up
  priority, scoped prompt/loadout preservation and obsolete semantic-prompt input veto. Automatic rounds are
  exactly one in event cases and zero in the human-priority case. No periodic model polling.
- Logical capacity: 30 successive fresh assignments at concurrency 3, unique identities/tickets, no allowance reset;
  operator capacity above six and policy failures. More than 100 terminal tasks coexist with a 100-live-task cap;
  reopening cannot bypass it. Unreviewed dependencies wait, reserve pins accepted revisions, stale commands fail.
- Real isolated Docker fixture: B returns while A's long command is active; cancelling A leaves B usable; run-scoped
  cleanup verifies every owned executor. Shared-serial remains default. Long shell/HTTP and optional timeout
  regressions preserve the existing explicit-lifetime and transport contract.

The initial custom `sendMessage(triggerTurn)` idle adapter failed real-Pi testing because it bypassed
`before_agent_start` and lost scope instructions. The corrected normal semantic-prompt pipeline passes. An idle
wake is one labeled extension-origin user-role prompt plus a typed custom entry, not human scope authorization.

GitNexus required a full force/no-parse-cache rebuild to correct an incremental UID misassociation with untrusted
ARTEX files. Graph analysis is supplemented by direct lifecycle/callback review; missing/capped graph processes
are not an all-clear. Change analysis includes new implementation files through a temporary Git index, not the
operator's real staging index. It does not certify absence of security flaws.

Limits of the source snapshot: no remote/provider stop/billing guarantee or real Herdr redesign acceptance;
installed byte comparison and mechanics are recorded separately, not inferred from source tests. No
assessment effectiveness, cost reduction, labeled security benchmark or ARTEX superiority. P5 incremental
indexes/checkpoints/structured todo/warm-session reuse remain unimplemented. No reference code was executed,
imported as a dependency or packaged. Existing unrelated stopped containers were identified and left untouched;
cleanup claims are only for the fixture-owned run labels.

`acceptance.json` preserves the pre-publication source checks/hashes; documentation hashes can differ after
publication. It is not semantic proof or deployed artifact equivalence.

## Installed publication

Runtime commit: `4d21f267c780562e2a07fb5cefe76d8cd746dab2`; plan commit: `6732fda`.
`pi install https://github.com/Nhan-Laptop/pi-p2o` completed with one existing package declaration and version 0.5.0.
The earlier `pi update` success message did not move the checkout; the clean registered checkout was fast-forwarded
and the requested `pi install` was then run explicitly. Actual revisions/hashes and tests, not CLI wording, verify installation.

Installed extension: **6 passing checks** — normal/quota cross-process workers, idle/boundary/human-priority
Planner rounds and real Docker solo isolation/cleanup. 32 selected runtime/document hashes matched source at the
tested runtime revision. Publication changes only documentation and receipts, not executable runtime or tests.
`installed.json` retains compact fixture results and hash manifests; full inert receipts remain local, not private
reference content. These do not establish live assessment quality, remote abort/billing guarantees or ARTEX superiority.

Fresh Pi sessions load the update. Older sessions must explicitly stop any active assessment before `/reload`;
no old tickets/session state restore authority. Shared/manual remains default; event-driven/isolated requires consent.
