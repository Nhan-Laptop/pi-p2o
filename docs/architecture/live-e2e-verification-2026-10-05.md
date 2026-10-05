# Live end-to-end verification (2026-10-05)

**Revision verified:** `8c601b0` ("Bind replay policy centrally and validate live packet field types"), working tree
clean, pushed to `origin/main`. All receipts below were produced by that exact revision.

**Evidence classes** — do not conflate them:

- **[L] live** — real pinned `pi` worker processes, real provider calls through the controller-owned gateway, real
  Docker pack, real broker/evidence/vault/reporting. Executed by the parent, not reported by a worker.
- **[I] inert** — the offline suites (`npm test` aggregate, fixture/injected runtimes).
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
| Tool receipts | 49 broker receipts (real `source.analyze` + `http.request` through the container pack) | L |
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

`haltedBilling=true` is the claim under test: exactly 3 provider charges occurred, the attempt was halted at the
third durable refusal, the owned runtime was stopped, and **no provider turn was charged after the halt**. Because
the restart happened before the second refusal, the streak that produced the halt was necessarily reconstructed
from durable `budget.released`/`budget.consumed` records, not from process memory.

---

## 3. Offline aggregate on the same revision

`npm test` (typecheck → build → import checks → extension package → contracts/store/reporting → tools → evidence →
interface + integration → credentials → budget → orchestrator → runtime → real-worker → sandbox → end-to-end →
Python) passed at `9fbeafb`; the failing end-to-end assertion that run exposed (a pre-dispatch refusal is now
refunded exactly once) was corrected to assert the new contract, and the suites touched by `8c601b0` were re-run:
`typecheck` clean, `test:e2e` 19/19, `test:live-lab` 13/13, `test:evidence`, `test:orchestrator` green. **[I]**

---

## 4. Non-claims

- Containers share the host kernel; this is **not** hostile-code isolation. **[D]**
- `assessmentStatus: incomplete` is correct and intentional: coverage is bounded to the declared plan. **[L]**
- The live lab is a harness (`examples/live-lab`), not the human first-use `/p2o` flow; the harness supplies its
  own owner document, it does not mint owner consent. **[L]**
- No platform submission, no external target, no third-party system was touched: every target origin is
  `127.0.0.1`. **[L]**
- Two findings appeared in this run; only one is promoted. A passing run is not a claim that every claim in a
  target is true or false. **[L]**

---

## 5. Residual weaknesses (prioritized)

1. **Model authoring variance (P1).** Earlier runs lost packets to schema type drift
   (`$/details/composition/representationChanges: Expected an array`) and to a mis-stated H1 peer-authority
   evidence kind. The crib/gate fix addresses the observed cases, but a small model at `thinking: low` still
   occasionally authors a packet the gates reject; that is returned as `returned-for-evidence` and retried, not
   hidden. Raising the harness thinking level or strengthening gate guidance would raise first-attempt yield.
2. **Harness-only verification of the policy seam (P2).** The controller-bound replay policy is proven live in the
   harness path; the human first-use flow constructs its replay environment through the same seam, but its own
   live run has not been repeated in this session.
3. **Refusal-streak derivation is page-bounded (P3).** The durable re-derivation scans the event ledger in pages;
   a run with an extremely large event count could under-count on restart. Controller-internal, bounded, recorded
   in the F4 review.
4. **Installed-copy build step (P2, packaging).** A git-installed copy has neither `dist/` nor `node_modules/`;
   `/p2o` now refuses before consent with `BUNDLED_RUNTIME_MISSING` naming the exact paths, and the documented fix
   is to build the checkout. It is an explicit requirement, not automatic.
5. **Owner-consent store hygiene (P3).** Two consent records under `~/.p2o/onboarding/` reference temporary
   `pi-tmp/p2o-installed-behavior-*/app` directories created while verifying the installed-copy path
   (one of them granted `repositoryScripts`/`stateChanges`). The committed tests isolate `HOME`/storage root; these
   two are manual-verification leftovers in the owner's real store and should be reviewed by the owner.

---

## 6. Human first-use `/p2o` handoff (the CTF target)

The first-use flow is gated on human consent dialogs by design; an agent cannot and must not mint that consent.
To run the authorized local CTF with the extension:

```sh
# 1. start the challenge locally (loopback only)
cd /home/nhanlaptop/project/pi-p2o/tmp/p2o-e2e-ancient-bookshelf/challenge && python3 app.py

# 2. in an interactive Pi session, load the current checkout explicitly (never both copies at once)
cd /home/nhanlaptop/project/pi-p2o
pi --no-extensions -e /home/nhanlaptop/project/pi-p2o --model deepseek-flash --provider deepseek --thinking max

# 3. first-use owner flow: one consent dialog, then review the sealed plan
/p2o --target http://127.0.0.1:8000 --plan-only --profile conservative
/p2o approve <planId>
```

The consent dialog is where the authorization basis, permitted actions, budget and deadline are chosen by the
owner; the plan digest is reviewed separately. `/p2o status`, `/p2o report <runId>` and `/p2o stop <runId>` then
read the durable run. A flagged target, an unbuilt install or a missing model selection refuses before execution —
the extension never falls back to a fixture or to a wider scope.
