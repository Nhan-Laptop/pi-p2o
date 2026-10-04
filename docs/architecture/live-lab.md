# Live vertical slice (`examples/live-lab`, `tests/live`)

This slice answers one question: **does the live path work end to end with a real model, and what exactly does
it prove?** It runs the real composition — controller-owned credential gateway → real pinned `pi` worker →
brokered tools → evidence vault → independent verifier → qualified report — against an intentionally
vulnerable loopback lab, and it refuses to pretend when a live precondition is missing.

```
node examples/live-lab/run.mjs [--require-live] [--keep]
node tests/live/run.mjs [--require-live]
node examples/live-lab/lab-server.mjs 0        # manual poke at the vulnerable target
```

## What is real, and what is a fixture

| Component | Status |
|---|---|
| Model | **Real.** `deepseek/deepseek-flash` through `https://api.deepseek.com` (`openai-completions`), requested at thinking level `low`. |
| Credential | **Real**, resolved at runtime by `pi auth print-api-key --provider deepseek`, held only by the controller gateway process, never written, logged, printed or handed to a worker. |
| Worker | **Real** pinned `pi` 1.0.0 launched by the managed headless runtime, `--no-builtin-tools`, only the digest-pinned bridge extension tools. |
| Tool policy | **Real owner policy**: per-task grant templates, per-target request/byte/concurrency limits, `127.0.0.0/8` only, GET/HEAD read-only, credential-tier accounts whose session tokens the broker injects at dispatch. |
| Execution sandbox | **Real pinned pack** (`containers/pack.lock.json`): docker 28.5.2+dfsg4, digest-pinned image, content-addressed rootfs layer pin, pinned seccomp profile, non-root read-only container with `--network=none`. |
| Evidence + verifier + report | **Real**: collector-attested receipts, `trust: collector`, independent replay in a fresh lab instance, qualified report. |
| Target | **Fixture.** `examples/live-lab/lab-server.mjs` is a seeded, dependency-free loopback app with two intentional access-control defects. It is not a real product and not hostile code. |

## The lab target

`lab-server.mjs` seeds two tenants (`alpha`, `beta`), two accounts (`acct-guest` member of alpha,
`acct-admin` admin of beta), two items (`i-100` alpha, `i-200` beta) and two seeded defects:

* **[LAB-VULN-1] cross-tenant read (IDOR)** — `GET /api/v1/items/:id` authorizes on the *client-supplied*
  `tenant` query parameter against the item record, never against the authenticated session's tenant. The
  alpha member reads the beta item by asserting `tenant=beta`.
* **[LAB-VULN-2] missing authorization on export** — `GET /api/v1/export?item=:id` is documented as
  admin-only own-tenant export but performs no role check and no tenant check, so a plain member receives any
  tenant's secret value. The same build ships a guarded sibling, `GET /api/v1/export/secure?item=:id`, which
  does enforce admin-only own-tenant access; that sibling is the export finding's negative control and makes
  the unguarded route the outlier rather than a blanket "everything is permitted" build.

Both routes require a live session; `POST /api/v1/session` is the owner-side login for the seeded fixture
accounts and is not part of the assessed surface. The lab is loopback-only, read-only, deterministic and has
no external dependencies.

## The owner document

`scenario.ts` is the owner's document (not a fixture): `mode: "authorized-assessment"`, a `container`
sandbox built from the pack lock, the loopback origins as targets, the approved accounts, four tasks, the
exact observation inputs a worker may select (health, own-tenant reads, baseline, negative control,
reproduction, source slices, and one probe against an unapproved destination that must be denied before any
traffic), the bounds (`maxTokens: 400000`, `maxCostUsd: 1`, run deadline, task deadlines, `maxAttempts: 2`),
two findings, two independent-replay recipes and three coverage cells (two tested, one explicitly untested:
anonymous reachability).

Tasks: `task-surface-map` (H1 mapping) → `task-hyp-idor` + `task-hyp-export` (two independent H2 hypotheses)
→ `task-verify-replay` (verifier task that calls `p2o_verify` for both findings and then writes its own H2
packet). The verifier's replays run against a fresh lab instance on the reserved environment-B port, created
by the controller, health-qualified and receipt-backed (`cleanEnvironment`, termination confirmed).

Workers can only select an approved `observationId`; inputs, kinds, classifications, expectations and test
outcomes are controller-derived. The worker never supplies an input, an expectation or an outcome.

## The pinned worker bridge extension

`bridge-extension.js` is the live-lab workstream's pinned variant of
`examples/local-assessment/bridge-extension.js` (which stays read-only). It adds three tools to the
`p2o_context`/`p2o_broker`/`p2o_packet` baseline:

* `p2o_authoring` — returns the exact H1/H2 handoff-packet skeleton, with every controller-derived envelope
  field *echoed from `p2o_context`* and the substantive fields left to the model. It is a shape crib, not
  authority: the supervisor's gate still validates the whole packet against the receipts.
* `p2o_verify` — the verifier task's only way to ask the controller for an owner-approved replay. The recipe,
  environment, budget and reviewer identity come from the owner plan, never from the payload.
* `p2o_packet` additionally refuses a packet whose identity fields do not echo the controller attempt context
  or whose evidence references were not actually minted by `p2o_broker`/`p2o_verify` in this session.

This is deliberate: a packet-format guide and immediate feedback are what make a real model's first packet
admissible, and the gate (`src/contracts/gates.ts`) remains the only authority that decides acceptance.

## What the run proves

For one successful run the harness prints (and writes to `report.json`, `report.md` and `live-summary.json`):

* **Gateway attestation** — one attested exchange per provider turn with the *observed* provider, model and
  wire-level thinking value, `matchesRequest`, the upstream path/status and the per-turn spend outcome. The
  requested selection must equal the observed selection for the turn to be accepted.
* **Per-turn spend settlements** from the durable model-spend ledger (per turn: input/output tokens,
  micro-USD, basis `provider-usage` or `assumed-worst-case`), plus run-level committed/overshoot totals.
* **Worker tool receipts** — one collector receipt per brokered observation, with tool identity, evidence
  kind, classification, collector role, environment and controller-evaluated test outcome.
* **Verifier outcome** — the controller's `verifier.outcome` line and the report's finding states
  (`independently-validated`, `reproduced`, `unresolved`, `rejected`, …).
* **Coverage** — tested / ruled-out / untested cells, including the explicitly untested anonymous cell.
* **Scope** — the approved origins, every origin actually contacted, and the escape count (must be 0).
* **Leak audit** — `auditArtifactsForSecrets` over the whole run directory (control dirs, worker sessions,
  workspaces, vault, artifacts, receipts, gateway attestations) for the real provider credential and for the
  lab session tokens; both must be absent.

## Honest limits (what is *not* proven)

* **Loopback target only.** The slice says nothing about assessing a remote or third-party system, and nothing
  about egress control to non-loopback destinations.
* **The container pack shares the host kernel.** It is a qualified, pinned, offline execution boundary for
  capability execution, not hostile-code isolation; the shared-kernel limitation is unchanged here.
* **The worker process runs under the managed runtime on the host.** The `pi` process is launch-configured,
  not containerized; only brokered capabilities execute inside the pinned pack.
* **Two of six handoff contracts** (H1, H2) are supported by the authoring crib. H3–H6 gates exist but this
  slice does not exercise them.
* **The clean replay environment is a fresh instance of the same build on the same host**, not a different
  machine or a restored VM snapshot.
* **Spend caps are worst-case reservations with observed-usage settlement.** An admitted turn may overshoot
  its hold when the provider reports more usage than was reserved; overshoot is recorded in the ledger and the
  harness fails the run if committed spend exceeds the declared cap.
* **One run is one run.** A model that produces an unadmissible packet costs a bounded retry (`maxAttempts`)
  and can end the run without the acceptance bar being met; that is reported honestly as exit code 2 rather
  than retried silently.
* **The lab's defects are seeded.** The findings are real about the lab target; they do not generalize to any
  other build, and the report's limitations say so per finding.

## Live prerequisites and failure behaviour

The runner checks, in order: the pinned docker engine release, the pinned offline pack image (by content
identity, never a tag), the locked seccomp digest, the pinned `pi` package version, TCP reachability of
`api.deepseek.com:443`, and the provider credential through `pi auth print-api-key`.

* Any missing precondition → `SKIP …` and **exit 0** (nothing is faked, no fallback is selected).
* The same with `--require-live` → **exit 1**.
* Preconditions present and the run did not meet the acceptance bar (not terminal, no accepted packet, no
  reviewed finding, no `independently-validated` finding, any scope escape, a failed leak audit, or a budget
  overrun) → **exit 2** with the reasons printed.

## Cost

One full run is bounded by `maxTokens: 400000` and `maxCostUsd: 1.00`. The pinned price for
`deepseek/deepseek-flash` is the vendor's **peak, cache-miss** rate — `$0.30`/M input, `$1.20`/M output — so
a run can never be bounded by the cheaper off-peak window (`src/policy/budget.ts`,
`https://api-docs.deepseek.com/quick_start/pricing`). With thinking level `low` and the provisioned
`maxTokens: 8192` per turn, a typical four-task run settles well below that cap; the exact per-turn numbers
are printed from the durable ledger.

## Files

| Path | Role |
|---|---|
| `examples/live-lab/lab-server.mjs` | the intentionally vulnerable loopback target (also the hashed source snapshot) |
| `examples/live-lab/scenario.ts` | the owner document builder (scope, checks, findings, coverage, recipes) |
| `examples/live-lab/main.ts` | harness core: lab instances, container sandbox identity, gateway wiring, evidence collection, leak audit |
| `examples/live-lab/run.mjs` | live precondition checks + compile + run + raw evidence print |
| `examples/live-lab/bridge-extension.js` | pinned worker tool surface (digest-approved per task) |
| `examples/live-lab/replay-environment.ts` | fresh-instance clean replay provider for the verifier |
| `examples/live-lab/pack.ts` | container sandbox options read from `containers/pack.lock.json` |
| `tests/live/live-lab.test.ts` | offline tests: lab defects, owner document validity, price gate, leak audit, extension surface |
