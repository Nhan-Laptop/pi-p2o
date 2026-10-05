# Independent E2E diagnostic — pi-p2o extension vs authorized CTF archive "Ancient Bookshelf"

- **Date:** 2026-10-05 (session `01a109a6-f2e6-7344-9e94-60910f045620`)
- **Phase:** diagnostic only — no project code edits, no target requests, no platform submission,
  no consent artifact fabricated, no unrelated targets, no secrets inspected or printed.
- **Parent runtime actually used:** `pi` 1.0.0, provider `deepseek`, model `deepseek-flash`,
  thinking `max` (matches the user's selection; no failover occurred; probe 3 control call returned
  `P2O-MODEL-OK` from the provider on the first attempt).
- **Input under test:** authorized CTF archive `tmp/e81e13fc-5978-4a06-a24c-c4cee7c11ad8.zip`
  (sha256 `362e499c34b8c0850e4764061a103644ed3c6fb5ba73038f36e0b4bf62446681`).
- **Tested code identity:** repo `/home/nhanlaptop/project/pi-p2o` @ `d6b2f99` (git clean).
  `dist/` in the repo was rebuilt at `2026-10-04 21:20:57`, **after** the newest source mtime
  (`src/application/first-use.ts` 20:47, `src/interface/command.ts` 20:38), so the repo build is
  current. A second copy is installed as a user package:
  `~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o` (same commit; `diff -rq` shows only `dist/` and
  `examples/live-lab/.runs/` differ — the installed copy has **no `dist/` and no `node_modules/`**).
  The agent session itself loaded the **installed copy** (its skills resolve there).

## 1. What was exercised (real user-facing entrypoint, not unit suites)

| # | Command (exact) | Observed result | State classification |
|---|---|---|---|
| P1 | `pi -e . --model deepseek-flash --provider deepseek --thinking max -p "/p2o"` | 14 × `Tool "p2o_*" conflicts with …/project/pi-p2o/extensions/p2o/index.ts`; git copy fails to load | tool/process failure |
| P3 | `pi -p "Reply with exactly: P2O-MODEL-OK"` | `P2O-MODEL-OK` | provider path healthy, no failover |
| P4 | `pi --tools p2o_status -p "…TOOLREG-OK"` (installed copy) | `TOOLREG-OK` — extension registers, tool exists | registration receipt PASS |
| P5 | `pi -p "/help"` (unknown command control) | model answered the text — unknown slash commands are sent to the model | platform behavior |
| P2b | `pi -p "/p2o"` (installed copy) | **0 bytes stdout, exit 0** — command dispatched, output swallowed in text print mode | usability defect (F5) |
| P6 | `pi --mode json -p "/p2o"` | `message_start/message_end` with `customType:"p2o_result"` help text | command + receipt observable |
| P7b | `pi --no-extensions -e /abs/repo --tools p2o_status -p "…REPOCOPY-OK"` | `REPOCOPY-OK` — repo copy loads cleanly with `-ne` | workaround verified |
| P8b | `pi --no-extensions -e /abs/repo --mode json -p "/p2o --target .../challenge --plan-only --profile conservative"` | `p2o_error ONBOARDING_UI_UNSUPPORTED: First-use /p2o owner consent requires human select/input/confirm dialogs. This host has no supported UI; nothing was configured, planned or launched.` **`~/.p2o/onboarding/` unchanged (no new file)** | designed human boundary; fail-closed PASS |
| P9 | `pi --no-extensions -e /abs/repo --mode json -p "/p2o status assessment-717f931f-…"` | `ENTRY_RUN_UNKNOWN: no admitted bundled run with this identity; no fake backend/report` | fail-closed PASS, no fabricated report |
| P10 | `pi -e /abs/repo --mode json -p "/p2o"` (no `-ne`) | 14 conflicts, **exit 1, 0 `p2o_result` events** — README-documented path is fatal here | blocker F1 |
| P11 | `npm run demo:live` (`examples/live-lab/run.mjs --require-live --keep`), real `deepseek/deepseek-flash` | all preconditions PASS; real run admitted; **first brokered call `source.analyze TIMEOUT: Tool deadline exceeded` (17.39 s)** then every call `CANCELLED: Operation cancelled` while turns kept being charged. Durable state at stop: run `active`, `task-surface-map` failed/`returned-for-evidence`, 3 dependent tasks queued, 2 failed attempts, 14 evidence records (12 runtime + 2 log packets classified `hypothesis`), **0 findings, 0 coverage cells**; 24 turns / $0.048256 | live-plane blocker F4 |

Target intake was safe and static-only: zip listed before extraction (2 files, no absolute/traversal
paths), extracted into `tmp/p2o-e2e-ancient-bookshelf/challenge/`, originals hashed
(`app.py` `9349f95e…`, `README.md` `ceec6945…`). The extension itself made **zero** requests to the
target in every probe above.

## 2. Target scope (static read only — not an extension-verified finding)

`README.md`: "Ancient Bookshelf", flag format `APS{...}`, source provided. `app.py` is a stdlib
`ThreadingHTTPServer` (port 8000) with routes `/`, `/shelf?q=`, `/submit` (POST), `/notes`,
`/review?id=`, `/collect?message=`, `/collected`, `/truth`. Static observations (hypothesis only,
never exercised): `page_notes` renders `row['body']` unescaped inside `<div class="note">…</div>`
(stored-XSS sink); `emulate_teacher()` gates on `<script` + `sealed-book` + `dataset.secret` +
(`fetch(`|`location`|`image()`), then inserts `FLAG` into `collected`; `/collected` returns it.
**No request was sent to this application.** The extension produced no plan, no task, no packet and
no evidence for it — nothing below is an accepted evidence item or a verified finding about the
target.

## 3. Findings, prioritized

### F1 (blocker, observed) — the documented dev/load path is fatal when the package is also installed
`README.md` offers `pi -e .` from the repo root. On this machine the package is also installed as a
user package at `~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o`, so two copies register the same 14
`p2o_*` tools. P10: 14 conflicts, **exit 1**, and no `/p2o` result at all. P1: same with a relative
`-e .`. This is the very first thing a user hits:
`pi` in the repo → installed copy only (no conflict, but see F2); `pi -e .` per README → fatal.
Workaround verified in P7b/P8b: `--no-extensions -e <abs repo>`.

### F2 (blocker, mechanically verified) — the installed copy cannot reach prepare()
In the installed checkout, `node_modules/.bin/pi`, `dist/src/runtime/guardian.js` and
`dist/src/runtime/pi-receipts.js` are **missing**, while `containers/pack.lock.json` is present, so
`packageRoot` resolves to the checkout (`src/application/first-use.ts:40`) and the prepare-time
`synthesize()` path (`:118`, called at `:176`) executes
`realpathSync(join(packageRoot, 'node_modules/.bin/pi'))` → **ENOENT** (reproduced directly). The
launch paths additionally need `dist/src/runtime/guardian.js` (`:336`, `:493`). A plain `pi` run
(installed copy) therefore fails at preparation, i.e. after a human consents but before any plan can
be reviewed. `dist/` is git-ignored and not in the package `files` list, so a git install can never
be self-sufficient for managed workers.

### F3 (designed boundary, observed, not a defect) — human consent gate
The headless user-facing command stops at `ONBOARDING_UI_UNSUPPORTED` (`src/application/onboarding/service.ts:22`),
writes nothing, and never reaches the target. This is correct fail-closed behavior and the point at
which this diagnostic legitimately stops. No consent artifact was created (verified by directory
timestamps).

### F4 (blocker, observed live, runtime plane) — cold-start tool call exceeds the deadline and the attempt collapses
`npm run demo:live` with the real provider: preconditions all PASS, gateway attested
`observation: "live"`, `requested {provider: deepseek, model: deepseek-flash, thinking: low}` and
charged turns (`input=… output=… micros=…`). The first brokered call failed:

```
entry.broker-refused source.analyze TIMEOUT: Tool deadline exceeded
bridge-error broker.execute:TIMEOUT after 17390ms: TIMEOUT: source.analyze failed: Tool deadline exceeded
entry.broker-refused http.request CANCELLED: Operation cancelled        (×N, then ~30 ms fast-fails)
```

Code-level cause: every docker CLI invocation is capped at 15000 ms
(`src/tools/container.ts:141`) and the tool descriptor deadline is also 15000 ms
(`src/tools/registry.ts:150`), while the sandbox's own container-start allowance is 30000 ms
(`examples/live-lab/scenario.ts:555`). The first call must cold-start the container and complete the
operation inside the same 15 s; observed 17.39 s. On timeout the execution controller is aborted
(`src/tools/broker.ts:151`), so all later calls in that attempt report `CANCELLED` instead of the
causal `TIMEOUT`, and the supervisor retries a fresh attempt (`039add5d…`) that repeats the same
cold start. Meanwhile the real model keeps producing turns and being charged with 100 % of its tool
calls refused — no no-progress/circuit-breaker state stops the spend. Acceptance requires
≥1 accepted packet, a reviewed finding and an independently validated finding, so this run cannot
meet the live bar.

Durable-state addendum (read directly from `state/p2o.sqlite`, read-only):

- `runs`: `live-lab-muukozn3` = `active` (never terminalized); `findings` = 0; `coverage` = 0 rows.
- `tasks`: `task-surface-map` `failed`/`returned-for-evidence`; `task-hyp-idor`, `task-hyp-export`,
  `task-verify-replay` all `queued`/`draft`. `task_dependencies` shows the three depend on
  `task-surface-map`, so not starting them is correct fail-closed gating — but the run then never
  reaches a terminal state and stays `active` until the declared deadline.
- `attempts`: two, both `failed` (sequence 1 and 2) for the same task.
- `evidence`: 14 records — 12 `runtime` observations and 2 worker packets classified `hypothesis`;
  no collected target observation. `results`: one, decision `returned-for-evidence`, packet `unresolved`.
- Refused calls still consume the task tool-call budget: `broker.execute:task-budget-exhausted` fired
  after the cascade, so the task was killed by a budget exhausted on calls that never collected
  anything. This is why the task failed with no observation at all.
- The run was stopped by this diagnostic after ~9.5 minutes of zero progress (no container remained,
  no workers running); the harness never reached its own verdict.

### F5 (usability, observed) — `/p2o` output invisible in text print mode
`pi -p "/p2o"` → 0 bytes and exit 0 (P2b), while `--mode json` shows the `p2o_result` message (P6).
Any naive headless smoke check of the user-facing command will look like "silently does nothing".
Receipts require `--mode json`.

### F6 (context, observation only) — existing runs also never reached admission
`~/.p2o/runs/assessment-717f931f…` and `assessment-e644d575…` contain consent inputs,
`autonomous-budget.json` and a controller lease, but no admitted store; `/p2o status` returns
`ENTRY_RUN_UNKNOWN` (P9). Consistent with F2/F3, but not used as evidence for any conclusion above.

### What is verified good
Registration of the extension (P4), dispatch and receipts of `/p2o` (P6), the `-ne -e` load path
(P7b), fail-closed consent (P8b), fail-closed status with no fabricated report (P9), repository
`dist/` freshness, and the fact that preparation/planning made no target request.

## 4. First failing boundary

- **Agent/headless:** `ONBOARDING_UI_UNSUPPORTED` at the human consent dialog — by design; correct.
- **Human interactive (plain `pi`, installed copy):** `realpathSync(packageRoot/node_modules/.bin/pi)`
  → `ENOENT` in `synthesize()` during prepare, before the plan can be reviewed.
- **Runtime plane even with a correct repo copy:** first cold-start tool call TIMEOUT (17.39 s vs
  15 s caps) → cascading `CANCELLED` → retry attempts with real spend and no accepted packet.

## 5. Smallest fix + regression (recommended, in priority order)

1. **F2 — make the runtime prerequisites resolvable, and fail with a named code.**
   *Smallest change:* wrap the `packageRoot` runtime-path resolution in an explicit check that
   raises `BUNDLED_RUNTIME_MISSING` naming the missing paths (`dist/src/runtime/guardian.js`,
   `dist/src/runtime/pi-receipts.js`) and resolve the worker binary from the host `pi` install (or an
   owner-controlled override) instead of `packageRoot/node_modules/.bin/pi`.
   *Packaging:* build on install or ship `dist/` for git installs.
   *Regression:* copy the package tree without `dist/`+`node_modules/` and assert the documented code
   and message (not `ENOENT`) from `prepare()`; and a positive test that `runtimePaths`/`piBinary`
   resolve in both source and dist layouts.
2. **F4 — decouple container cold start from the tool deadline, and stop dead attempts.**
   *Smallest change:* give sandbox bring-up its own budget (container `startupTimeoutMs` 30 s) and
   start the tool deadline only after the sandbox is ready; once an attempt produces N consecutive
   `TIMEOUT`/`CANCELLED` refusals with zero collected receipts, terminate the attempt and stop
   charging turns; and when a required dependency has failed, terminalize the run as failed/partial
   instead of leaving it `active` until the declared deadline.
   *Regression:* a live-lab assertion that the first `source.analyze` on a cold sandbox succeeds; a test
   that N consecutive tool-plane refusals halt the attempt and provider spend; and a test that a failed
   dependency produces a terminal run state, not a permanently `active` one.
3. **F1 — document and test the single-copy rule.**
   *Smallest change:* README note that `-e .` and an installed copy are mutually exclusive, and
   `--no-extensions -e <abs>` is the dev invocation.
   *Regression:* a CLI smoke test that starts `pi` with the extension and asserts `/p2o` is
   dispatchable without any tool-conflict error.
4. **F5 — emit headless receipts.** Consider printing `p2o_result`/`p2o_error` in text print mode
   (or documenting `--mode json` as the headless capture mode).

## 6. Handoff — exact human command (nothing was pre-consented)

```
cd /home/nhanlaptop/project/pi-p2o
pi --no-extensions -e /home/nhanlaptop/project/pi-p2o --model deepseek-flash --provider deepseek --thinking max
# in the TUI (the consent dialog decides the authorization basis; do not use an automated basis):
/p2o --target /home/nhanlaptop/project/pi-p2o/tmp/p2o-e2e-ancient-bookshelf/challenge --plan-only --profile conservative
# review the sealed plan + digest, then:
/p2o approve <planId>
```

Note: with the **installed** copy (plain `pi`, no `-ne -e`) the run will fail at prepare per F2 even
after the human consents; the command above uses the current repo copy with its fresh `dist/`.

## 7. State and safety

No target request, no platform call, no submission, no repo edit, no owner-consent artifact, no
global configuration change. Two runtime effects were produced by running the real slice: real
provider spend on `deepseek/deepseek-flash` (24 charged turns, $0.048256, logged in
`logs/live-lab.out`) and the run root `examples/live-lab/.runs/ll-iAoq4d/` (kept with `--keep`; run
left `active` because the supervisor never terminalized it). The harness was stopped by this
diagnostic after ~9.5 minutes of zero progress; no containers or worker processes were left running
(verified with `docker ps` and `pgrep`). Existing `~/.p2o` state was read and left unchanged.

## 8. Artifact index

- Report (this file): `docs/architecture/e2e-diagnostic-ancient-bookshelf-2026-10-05.md`
- Challenge workspace: `tmp/p2o-e2e-ancient-bookshelf/challenge/` (`SCOPE.md`, `app.py`, `README.md`)
- Logs/receipts: `tmp/p2o-e2e-ancient-bookshelf/logs/` (`probe2b_p2o_help.*`, `probe3_model.*`,
  `probe6_json.*`, `probe8b_target.*`, `probe9_status.*`, `probe10_conflict.*`, `live-lab.out`)
- Live run artifacts: `examples/live-lab/.runs/ll-iAoq4d/` (run manifest, durable store, receipts,
  worker session, vault)
- Handoff/progress: `tmp/p2o-e2e-ancient-bookshelf/Diagnostic-Progress.md`
