# B4 evidence and remaining integration limits

Only runtime source/tests were edited. No commit.

Implemented: attempt session registry, bounded callback waits, durable release receipts/events, terminal-path calls, controller-identity leases, stale-owner sweep callbacks, and structural BrowserPack adapter.

IMPORTANT: this is not a verified end-to-end no-orphan implementation. Application composition is not changed: it must register the actual pack instances. BrowserPack adapter delegates releaseAttempt/close but has no restart sweep implementation; a fresh browser registry cannot recover prior in-memory sessions through releaseAttempt. The container sandbox has no attempt release callback wired here. assertOpen is an opt-in fence; the existing packs do not consult it through this change. Concurrent release calls are not serialized. These gaps remain and acceptance is incomplete despite passing tests.

## Focused tests — raw output

```
✔ a completed attempt releases its pack session; release is idempotent and the sealed lease refuses a second attempt (3023.29751ms)
✔ a verified stop, a cancellation and a controller shutdown each release the attempt's session (676.357941ms)
✔ deadline expiry releases the attempt's session under the enforced deadline (7166.560831ms)
✔ a quarantined attempt and a restarted controller both release the attempt's session (603.201841ms)
✔ the restart sweep kills a dead owner's session, respects a live owner, and reports an unsweepable lease (667.615211ms)
✔ the restart sweep fails closed when owner liveness cannot be determined (75.798347ms)
✔ an unreleased, failing or hanging release is reported durably without hiding verified termination (705.528695ms)
✔ a stale session is refused by a second attempt while the second attempt keeps its own lease (382.549073ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

## Final consecutive run — raw output

Command each time: `P2O_TEST_PI_BINARY=$PWD/node_modules/.bin/pi node tests/runtime/run.mjs`.

```
run  tests pass fail cancelled duration_ms exit
1    46     46   0    0         60415.274455 0 (wall 63s)
2    46     46   0    0         60925.742963 0 (wall 64s)
3    46     46   0    0         56415.086841 0 (wall 59s)
4    46     46   0    0         58766.00175  0 (wall 61s)
5    46     46   0    0         56150.695408 0 (wall 59s)
6    46     46   0    0         56606.596148 0 (wall 59s)
7    46     46   0    0         51886.018879 0 (wall 54s)
8    46     46   0    0         45447.858057 0 (wall 47s)
9    46     46   0    0         45267.667165 0 (wall 47s)
10   46     46   0    0         45108.111448 0 (wall 47s)
11   46     46   0    0         46339.842179 0 (wall 48s)
12   46     46   0    0         45494.947506 0 (wall 47s)
13   46     46   0    0         45264.652507 0 (wall 46s)
14   46     46   0    0         45470.493676 0 (wall 47s)
15   46     46   0    0         45939.804858 0 (wall 48s)
```

Earlier runs were not uniformly green: one earlier 45-test loop had a backwards-wall-clock termination verification failure; an earlier 46-test loop had run 7 report 33 pass, 5 fail, 2 cancelled and reach the 900-second runner cap. Host-load attribution was suspected but NOT established. Passing later loops does not erase these observations.

## Other commands — observed output

```
tsc exit 0
ℹ tests 59
ℹ pass 59
ℹ fail 0
ℹ duration_ms 7586.736472
ℹ tests 14
ℹ pass 14
ℹ fail 0
ℹ duration_ms 14923.386768
```

The latter two summaries are orchestrator and end-to-end respectively. They preceded the final fail-closed sweep change. The final sweep change was typechecked and covered by the final runtime loop. End-to-end ran in a scratch copy excluding examples/live-lab/.runs: the original-tree command failed with ERR_FS_CP_SOCKET while copying a live-lab socket. Earlier scratch end-to-end runs also showed intermittent failed-versus-exited process-report assertions. No definitive baseline attribution was established.
