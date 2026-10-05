# Live end-to-end verification (2026-10-05)

**Revision verified:** `ca3db6a`, working tree clean, pushed to `origin/main`. Both live runs below were executed on it:
the acceptance run in §1 and the fault-injection run in §2. The same acceptance bar was also met on the
earlier revisions `8c601b0` and `0b70d72` (one promoted finding each).

**Evidence classes** — do not conflate them:

- **[L] live** — real pinned `pi` worker processes, real provider calls through the controller-owned gateway, real
  Docker pack, real broker/evidence/vault/reporting. Executed by the parent, not reported by a worker.
- **[I] offline tests** — includes fixtures/injected runtimes and real Pi/Docker checks without paid provider calls.
- **[D] documented non-claim** — the repository explicitly does not claim it.

**Scope of this document.** It records the *runtime/harness* end-to-end proof. It is not the human first-use
`/p2o` flow (that flow requires interactive owner consent; its handoff is in §6) and it is not a completeness
claim about any target.

---

## 1. Acceptance run — real workers, real provider, independent verification

```sh
npm run demo:live        # examples/live-lab/run.mjs --require-live --keep
```

**Result: exit 0 — the acceptance bar was met, with BOTH findings independently validated.** Run
`live-lab-muuse1vj`, directory `examples/live-lab/.runs/ll-qC2Jfr/`.

| Receipt | Observed | Class |
|---|---|---|
| Run state | `completed`, terminal, `assessmentStatus: incomplete` (bounded plan, not a completeness claim) | L |
| Requested vs observed runtime | requested `deepseek/deepseek-flash/low`; observed `deepseek/deepseek-flash/low`, `matchesRequest: true` on every attested exchange | L |
| Gateway | `exchanges: 26`, `forwarded: 26`, `denied: 0`; real credential held by the controller gateway only | L |
| Per-turn spend | `174 784 tokens` / `$0.072007` committed; per-turn ceiling 3 072 tokens with headroom below the provider 8 192 limit | L |
| Accepted packets | surface map H1, IDOR H2, export H2, verifier H2 | L |
| Tool receipts | 55 recorded receipts across 5 worker sessions; source inspection uses the offline container, HTTP requests use the controller-side scoped broker | L |
| Verified findings | `finding-idor-client-tenant-parameter` **and** `finding-export-missing-authorization`, both `independently-validated` / `independently-observed`, each with a distinct verifier attempt | L |
| Coverage | `tested: 2` (both `reviewer-validated`, each with source + baseline + negative-control + reproduction evidence), `untested: 1`, `ruled-out/blocked: 0` | L |
| Honest negatives | one verifier pass still `returned-for-evidence` (`replay-blocked: fetch failed`) and is recorded as such instead of being promoted; only the passes that reproduced were promoted | L |
| Explicit gap | anonymous reachability of the export route retained as `untested` because every approved account is credential-tier; no task was admitted for it | L |
| Scope enforcement | approved loopback origins `[127.0.0.1:43519, 127.0.0.1:38217]`, both observed, **`escapes: 0`** | L |
| Credential leak audit | provider credential ABSENT and lab session tokens ABSENT across 170 run artifacts | L |

The validated finding is the point of the whole architecture: a worker proposed a hypothesis, the supervisor
admitted it against an owner-approved scope, the broker collected evidence under a bound grant, the packet gate
accepted the handoff, and a **separate verifier attempt** replayed the claim in a **fresh lab instance** under the
controller-issued scoped verification policy before the finding was promoted to `independently-validated`. The
second finding was *not* promoted, and the gap stayed visible.

### What fixed this run

**This revision (`ca3db6a`) is the one verified end-to-end.** Four defects were fixed along the way: the first two
in `9fbeafb`/`8c601b0` below, the last two in `52f1a56`/`ca3db6a` (items 3 and 4).

1. The evidence broker refused every collection with `broker-input` because the sandbox configuration digest folded
   in a run-scoped lifecycle marker while the owner-approved digest did not. The digest now attests the approved
   configuration only (`src/tools/container.ts`), and lifecycle ownership remains attested by runtime/guardian
   receipts and container labels.
2. The verifier refused every replay with `verification-policy` because only the built-in replay factory minted the
   controller policy; a harness-supplied `replayEnvironment` override bypassed it. The controller now binds the
   policy for **any** replay environment and refuses a conflicting one by name
   (`bindControllerVerificationPolicy`, `replay-policy-conflict`).

Two further defects were found by testing the *live* path after those fixes and were fixed in `52f1a56` and
`ca3db6a`:

3. **A receipt/observation ordering race could wedge a run forever (P0, fixed in `52f1a56`).** The finalize
   path admitted the controller receipt first and sampled the observation clock afterwards; the store requires
   `receipt.collectedAt >= observation.observedAt`, so a single millisecond tick between the two calls refused
   the only reconciliation that could settle an already-`reconciling` attempt. Observed live: run stuck `active`,
   task stuck `reconciling`, `orchestrator.finalize-rejected {code: reconciliation-receipt}`. The fix samples one
   instant and uses it for both sides at every call site; the store check is unchanged. Regression:
   `tests/orchestrator/finalize-ordering.test.ts` with a ticking clock.
4. **A truncated worker turn could consume an attempt (fixed in `ca3db6a`).** Acceptance run `ll-SOs5Zy` lost
   both mapping attempts to a single 8 192-token completion, the provider maximum, before `p2o_packet` was
   called; the run then terminalized honestly with zero packets. The harness now provisions a 3 072-token
   per-turn ceiling with headroom, states the truncation failure mode in the worker crib, and bounds attempts
   at 3. No gate, scope or USD ceiling changed.
---

## 2. Fault-injected billing-stop proof (with a controller restart)

```sh
P2O_LIVE_FAULT=refuse-broker P2O_LIVE_RESTART_ON=first-refusal npm run demo:live
```

Every broker call fails its sandbox bring-up `UNAVAILABLE` (a tool-plane refusal, refunded by the reservation
release but still counted by the supervisor's non-refundable streak), and the controller restarts as soon as the
first refusal is observed, so the replacement must re-derive the streak from the durable ledger.

**Result: exit 2 (bar unmet by design — no work can progress), with the breaker receipt:** run `ll-DHsR4L`.

```
[live] controller restarted after 6665 ms; the replacement inherits the durable control record and must re-derive the refusal streak
[live] FAULT PROOF halt observed after 3 provider charges; no further provider turn is expected
[live] FAULT PROOF state=failed halts=1 refusals=3 releases=5 providerCharges=3 chargesAtHalt=3 haltedBilling=true
```

The bounded run recorded exactly 3 gateway provider charges, a no-progress halt and a terminal failed run.
The gateway recorded no additional charge between the observed halt and run cleanup. The log also records a
controller handover before the halt; it does not establish that handover occurred before the second refusal.
This is evidence for this run, not a guarantee about future provider billing or every restart interleaving.
The bounded run recorded a controller restart at 4 402 ms, a no-progress halt after 2 gateway provider charges,
`refusals=3` re-derived by the replacement controller, a **terminal `failed` run**, and
`haltedBilling=true`: no provider charge occurred after the halt.

```
[live] controller restarted after 4402 ms; the replacement inherits the durable control record and must re-derive the refusal streak
[live] FAULT PROOF halt observed after 2 provider charges; no further provider turn is expected
[live] FAULT PROOF state=failed halts=1 refusals=3 releases=0 providerCharges=2 chargesAtHalt=2 haltedBilling=true
```

This is evidence for this run, not a guarantee about every restart interleaving. The earlier revision
`52f1a56` also reached a terminal state on this fault profile; before that fix the same profile could wedge the
run `active` (see “What fixed this run”).

---

## 3. Offline verification by revision

`npm test` (typecheck → build → import checks → extension package → contracts/store/reporting → tools → evidence →
interface + integration → credentials → budget → orchestrator → runtime → real-worker → sandbox → end-to-end →
Python) passed on the tree committed as `9fbeafb`, after its pre-dispatch-refund regression was updated.
The focused suites were rerun for `8c601b0`: `typecheck` clean, `test:e2e` 19/19 and `test:live-lab` 13/13.
Evidence tests also passed during the policy-seam review. This is not a claim that the entire aggregate was
rerun at `8c601b0`. **[I]**

---

## 4. Non-claims

- Containers share the host kernel; this is **not** hostile-code isolation. **[D]**
- `assessmentStatus: incomplete` is correct and intentional: coverage is bounded to the declared plan. **[L]**
- The live lab is a harness (`examples/live-lab`), not the human first-use `/p2o` flow; the harness supplies its
  own owner document, it does not mint owner consent. **[L]**
- No platform submission or external assessment target was contacted: assessed origins were loopback. Real
  model-provider API traffic was external and charged as recorded above. **[L]**
- Two findings appeared in this run; only one is promoted. A passing run is not a claim that every claim in a
  target is true or false. **[L]**

---

## 5. Residual weaknesses (prioritized)

1. **Model authoring variance (P1, mitigated).** The harness now provisions headroom below the provider
   completion ceiling and instructs early packet submission (`ca3db6a`), and the crib/gates reject drift with
   exact pointers; a single over-long turn can still be truncated, and a packet the gates reject is returned as
   `returned-for-evidence` rather than hidden. Raising the harness thinking level is untested.
2. **Harness-only verification of the policy seam (P2).** The controller-bound replay policy is proven live in the
   harness path; the human first-use flow constructs its replay environment through the same seam, but its own
   live run has not been repeated in this session.
3. **Flaky local-assessment assertion (P2).** `test:e2e` “local assessment chain” failed once with task
   lifecycle `failed` instead of `exited` and passed on rerun with no source change. The observation is timing
   dependent and needs stabilization rather than being accepted as noise.
4. **Installed-copy build step (P2, packaging).** A git-installed copy needs an explicit build after update.
   `/p2o` refuses before consent with `BUNDLED_RUNTIME_MISSING` naming the missing paths.
5. **Existing owner-state provenance (observation only).** Existing consent records reference temporary test
   directories. This session did not establish who created them and did not reuse, modify or delete them.
   The committed packaging tests use isolated HOME/storage roots.
6. The previous page-bounded refusal-history issue was fixed before the tested revision; the latest
6. The page-bounded refusal-history derivation was fixed before these live runs; the independent review closes
   it. It is not an outstanding defect of the tested revision.

---

## 6. Human first-use `/p2o` handoff (the CTF target)

The first-use flow is gated on human consent dialogs by design; an agent cannot and must not mint that consent.
The supplied CTF has **not** been solved through the extension. Bundled first use currently supports
read/static assessment, not the state-changing workflow needed to prove the challenge end-to-end.
For an interactive, read-only assessment of its source (no service startup required):

```sh
cd /home/nhanlaptop/project/pi-p2o
pi --no-extensions -e /home/nhanlaptop/project/pi-p2o --model deepseek-flash --provider deepseek --thinking max

# In the Pi TUI, review the scope and sealed plan yourself:
/p2o --target /home/nhanlaptop/project/pi-p2o/tmp/p2o-e2e-ancient-bookshelf/challenge --plan-only --profile conservative
/p2o approve <planId>
```

The earlier `python3 app.py` startup smoke returned HTTP 200 when requested over loopback, but the supplied
launcher binds `0.0.0.0:8000`. It was therefore not a loopback-only listener; the process has been stopped.
Do not use that launcher unmodified for an isolated local deployment.

The consent dialog is where the authorization basis, permitted actions, budget and deadline are chosen by the
owner; the plan digest is reviewed separately. `/p2o status`, `/p2o report <runId>` and `/p2o stop <runId>` then
read the durable run. A flagged target, an unbuilt install or a missing model selection refuses before execution —
the extension never falls back to a fixture or to a wider scope.
