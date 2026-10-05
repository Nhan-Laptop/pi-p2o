# Live end-to-end verification (2026-10-05)

**Revision verified:** `8c601b0` ("Bind replay policy centrally and validate live packet field types"), working tree
clean, pushed to `origin/main`. All receipts below were produced by that exact revision.

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

**Result: exit 0 — the acceptance bar was met.** Run `live-lab-muuqoqd1`, directory
`examples/live-lab/.runs/ll-XqJPYB/`.

| Receipt | Observed | Class |
|---|---|---|
| Run state | `completed`, terminal, `assessmentStatus: incomplete` (bounded plan, not a completeness claim) | L |
| Requested vs observed runtime | requested `deepseek/deepseek-flash/low`; observed `deepseek/deepseek-flash/low`, `matchesRequest: true` on every attested exchange | L |
| Gateway | `exchanges: 20`, `forwarded: 20`, `denied: 0`; real credential held by the controller gateway only | L |
| Per-turn spend | `130 570 tokens` / `$0.06328` committed, `overshoot: 0`, per-turn admission + charge + release | L |
| Accepted packets | 4 — `task-surface-map/H1/unresolved`, `task-hyp-idor/H2/supported`, `task-hyp-export/H2/supported`, `task-verify-replay/H2/unresolved` | L |
| Tool receipts | 49 recorded receipts; source inspection uses the offline container, HTTP requests use the controller-side scoped broker | L |
| Verified finding | `finding-idor-client-tenant-parameter` = **`independently-validated`**, classification `independently-observed`, verifier `p2o-supervisor.verifier.944d9536-…` | L |
| Coverage | `tested: 2` (both `reviewer-validated`, each with source + baseline + negative-control + reproduction evidence), `untested: 1`, `ruled-out/blocked: 0` | L |
| Honest negative | `finding-export-missing-authorization` stayed `unresolved` — its replay was blocked (`replay-blocked: fetch failed`) and the report says so instead of promoting it | L |
| Explicit gap | anonymous reachability of the export route retained as `untested` because every approved account is credential-tier; no task was admitted for it | L |
| Scope enforcement | approved loopback origins `[127.0.0.1:43519, 127.0.0.1:38217]`, both observed, **`escapes: 0`** | L |
| Credential leak audit | provider credential ABSENT and lab session tokens ABSENT across 170 run artifacts | L |

The validated finding is the point of the whole architecture: a worker proposed a hypothesis, the supervisor
admitted it against an owner-approved scope, the broker collected evidence under a bound grant, the packet gate
accepted the handoff, and a **separate verifier attempt** replayed the claim in a **fresh lab instance** under the
controller-issued scoped verification policy before the finding was promoted to `independently-validated`. The
second finding was *not* promoted, and the gap stayed visible.

### What fixed this run

Two defects blocked this bar in earlier live runs and were fixed in `9fbeafb` and `8c601b0`:

1. The evidence broker refused every collection with `broker-input` because the sandbox configuration digest folded
   in a run-scoped lifecycle marker while the owner-approved digest did not. The digest now attests the approved
   configuration only (`src/tools/container.ts`), and lifecycle ownership remains attested by runtime/guardian
   receipts and container labels.
2. The verifier refused every replay with `verification-policy` because only the built-in replay factory minted the
   controller policy; a harness-supplied `replayEnvironment` override bypassed it. The controller now binds the
   policy for **any** replay environment and refuses a conflicting one by name
   (`bindControllerVerificationPolicy`, `replay-policy-conflict`).

Packet admission also stopped rejecting live packets on optional-field type drift: the authoring crib now carries
schema-derived per-field types and the bridge refuses drift at authoring time with the exact JSON pointer.

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

1. **Model authoring variance (P1).** Earlier runs lost packets to schema type drift
   (`$/details/composition/representationChanges: Expected an array`) and to a mis-stated H1 peer-authority
   evidence kind. The crib/gate fix addresses the observed cases, but a small model at `thinking: low` still
   occasionally authors a packet the gates reject; that is returned as `returned-for-evidence` and retried, not
   hidden. Whether higher thinking improves first-attempt yield has not been measured.
2. **Harness-only verification of the policy seam (P2).** The controller-bound replay policy is proven live in the
   harness path; the human first-use flow constructs its replay environment through the same seam, but its own
   live run has not been repeated in this session.
3. **Blocked second replay (P1).** The export finding remained unresolved because its replay failed to fetch.
   Its coverage record in the captured report incorrectly described an independent replay; producer-tested
   coverage must not be confused with a verified finding. The original artifact is retained unchanged.
4. **Installed-copy build step (P2, packaging).** A git-installed copy needs an explicit build after update.
   `/p2o` refuses before consent with `BUNDLED_RUNTIME_MISSING` naming the missing paths.
5. **Existing owner-state provenance (observation only).** Existing consent records reference temporary test
   directories. This session did not establish who created them and did not reuse, modify or delete them.
   The committed packaging tests use isolated HOME/storage roots.
6. The previous page-bounded refusal-history issue was fixed before the tested revision; the latest
   independent review closes it. It is not an outstanding defect of `8c601b0`.

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
