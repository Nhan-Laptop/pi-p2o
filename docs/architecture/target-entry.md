# Target entry — the `/p2o --target` workflow

This document describes the product behaviour of the target workflow behind the single `/p2o` command:
`prepare` → model-authored plan → explicit owner approval → target acquisition → owner-gated materialization →
delegation to the existing supervisor. Implementation lives in `src/application/entry/**`; the frozen interface
contract is `src/interface/target-entry.ts`, with additive optional foreground proposal-only methods.

## 1. What `/p2o --target <T>` accepts

One target per invocation. The interface classifies the argv shape without touching the filesystem or the
network (`src/interface/targets.ts`); the entry workflow then resolves it offline, **never widening what the
user typed**.

| argv shape | kind | resolution | default technique |
|---|---|---|---|
| existing local directory (`./repo`, `/abs/path`) | `local-dir` | canonical absolute path (the final component must not be a symlink) | `source.analyze` (static review) |
| `https://github.com/<owner>/<repo>` | `github-repo` | canonical repository-root URL; a subpath or query is refused instead of silently cloning the root | `source.analyze` (static review of the cloned revision) |
| absolute `http(s)://host/...` URL | `http-url` | normalized URL (`normalizeWebTarget`); credentials, dot segments and ambiguous escapes are refused | `http.request` (bounded reconnaissance, read action only) |

A bare domain/IP without a scheme, `git://`, `ssh://`, `file://` and `git@…` are refused by the interface.
`--target` **never authorizes anything**: the owner-approved run document is the only scope source. A target
that is not in the owner document's approved target list fails with `TARGET_DENIED`.

## 2. Evidence before authority

`prepare` is the only pre-approval step. It performs **zero target requests** (no clone, no fetch, no worker)
and reports that as `targetRequests: 0`:

* `local-dir` — metadata resolution plus, for an executable (non `--plan-only`) preparation, a **bounded
  read-only content fingerprint** (relative-path manifest digest). Nothing is copied and nothing is executed.
  When the owner document pins a content digest, the fingerprint must match it.
* `github-repo` — URL validation only; the resolved commit does not exist yet and is reported as such.
* `http-url` — URL normalization and exact owner-scope matching only; no request is issued.

`--plan-only` reads no target content at all: it pins the canonical identity and the scope, prints the plan
and its `planId`, and starts nothing. The approved scope then does not pin file hashes — this is stated in the
preparation warnings. `/p2o approve <planId>` is the executable path for such a plan: it repeats the review,
acquires the target and delegates, but only after the confirmation dialog.

The human reviews the target, mode, `scopeDigest`, action allowlist, effective spend, concurrency and the
plan. Only `ctx.ui.confirm` in `src/interface/command.ts` mints an `EntryHumanApproval` with
`channel: 'human-command'`, and only for the exact `scopeDigest`/`planDigest` shown.

## 3. Mode, actions and technique routing

* `mode` is the owner document's mode, never inferred from prose. An `http-url` target additionally requires
  an assessment-mode owner document unless it is a loopback origin covered by an explicit fixture-mode owner
  grant; a non-loopback HTTP(S) target in fixture mode is refused.
* The action allowlist is exactly the routed capability: `source.analyze` for local/repo, `http.request` for
  HTTP(S). The owner must grant the matching verb (`analyze`/`read`); the entry workflow never adds an action.
* Skill routing is technique-first and depth only **narrows** the skill list (`quick` < `standard` < `deep`):
  `source-code-auditing`, `data-flow-analysis`, `attack-surface-mapping`, `compiler-invariant-auditing` /
  `sandbox-boundary-analysis` for source; `attack-surface-mapping`, `authorization-auditing` for HTTP.
* No mode word (`assessment`, `pentest`, …) grants exploitation or post-exploitation authority. Mutating HTTP
  methods and exploit actions are outside this workflow; only the owner-approved observation path may request
  anything, under the broker policy.

## 4. Planning and approval

Interactive TUI uses the current Pi session as the visible orchestrator. The command asks for native
model/context consent, calls offline `planContext`, emits a receipt, and triggers one current-session turn.
`p2o_orchestrate propose` decodes the native tool draft with host-derived provenance and calls `proposePlan`;
that method uses the **same** owner-envelope validation, execution proposal ledger and digest seal as
`plan`. It cannot reach `start`/`approve`, mint human authority or perform target acquisition.
`/p2o approve <planId>` remains the sole entry admission path. Missing proposal wiring fails explicitly.
`--headless` selects the previous nested author, required for bounded financial caps; RPC is legacy by
default and opts in with `--foreground`. Interaction flavor is not a new `RuntimeKind`: workers remain
supervisor-owned, sandboxed and independently attested. See [foreground control plane](interface.md#native-foreground-orchestration).

`plan` calls the injected Pi/planner runtime author — a model seam, not a template. Fixture-authored plans are
refused in production (`ENTRY_PLAN_AUTHOR_REQUIRED`), so a hardcoded lab menu can never masquerade as target
planning. The author may only produce:

* an **owner-menu packet** (`PlanProposal`) selecting observations that already exist in the owner document's
  check menu for this target; an observation the owner did not approve is refused
  (`ENTRY_PLAN_REJECTED`), or
* a **generated-request packet** (`PlanRequestProposal`) authoring new concrete `http.request` inputs that are
  validated against the controller-derived owner envelope (target, account, action, method, URL, caps,
  exclusions).

The plan is sealed by a digest over the preparation, steps and exact packet. `plan` stores it in the private
entry control root (0600 files, re-derived on read) and returns `{ planId, digest, steps }`.
`readPlan(planId)` supports cross-session `/p2o approve <planId>`.

## 5. After approval: acquisition, materialization, delegation

`start`/`approve` verify the approval channel and both digests, check the plan has not been admitted before
(once-only `markAdmitted` with an exclusive create), re-run the composed backend's read-only preflight, and only
then acquire the target:

* **local-dir** — a read-only snapshot into the private workspace: version-control metadata, dependency/build/
  cache directories, secret-like files and every symlink or unsafe path name are excluded; per-file/byte/count
  bounds apply (narrowed by the owner run's byte budget); files are 0400 and directories 0500; a changed tree
  since preparation is refused (`SCOPE_DIGEST_MISMATCH`).
* **github-repo** — a bounded clone with an exact argv (`clone --depth 1 --single-branch --no-tags
  --no-recurse-submodules`, empty hook/template/config paths, `--` before the URL) and an allowlisted
  environment (`GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, private `HOME`/`XDG_CONFIG_HOME`, no
  credential helper, HTTPS-only protocol). The resolved commit is recorded; an owner-pinned revision or content
  digest that does not match is refused. Nothing inside the clone is installed, built or executed.
* **http-url** — no acquisition and no entry-issued request; the normalized URL identity is recorded.

The approved packet is then completed through the existing planner/generated-request ledger: the owner
approval document is read from its owner-only path and verified by the ledger (`approve`), the existing
`materializePlan`/`materializeRequestPlan` gate produces checks and grants, and a composition-owned callback
registers them. The document itself is either owner-authored or, for an interactive confirmation, created
once by `createOwnerApprovalPort` from the consumed controller-issued capability bound to the sealed
proposal; the ledger re-derives the digest, and a different existing document is never overwritten.
The entry workflow never widens, edits or weakens the owner document or its bindings.

The owner gate runs *before* acquisition (`EntryPlanExecution.authorize`), so an expired, foreign, mutated
or unapproved proposal is refused before any clone or target request.

For `local-dir`/`github-repo` acquisitions the composition also binds the worker's source inputs: every
relative `source.analyze` path must exist in the acquired view, and the owner-configured sandbox input root
must fingerprint to the same content digest (and match any pinned revision). Otherwise the run is refused with
`ENTRY_SOURCE_UNBOUND`. The acquired view is not substituted as the sandbox root, because that would change
the owner-pinned sandbox `configurationDigest` and the evidence collector would then reject broker receipts
(`broker-input`); the view is provenance/read-only evidence and the worker root is proven content-identical
to it. The durable `<control>/entry-registrations/plan-<id>.json` receipt records the binding.

Finally the run is delegated to the existing composed backend (`preflight` then `start`), which admits the
owner-approved run and launches its owners. The reported state is the observed backend state — launch is not
acceptance.

`resume` re-checks the stored scope digest, the authorization/deadline window and (for local targets) the
content fingerprint before delegating to the backend's `resume`; conversation replay never restores a worker
environment. `stop` is deliberately not implemented by the entry port, so `/p2o stop` keeps the legacy
verified-termination path.

## 6. Failure codes

| code | meaning |
|---|---|
| `TARGET_NOT_FOUND`, `TARGET_NOT_DIRECTORY`, `TARGET_DENIED`, `TARGET_TOO_LARGE` | target resolution, owner-scope or bound refusal |
| `REPO_CLONE_FAILED` | bounded clone failed; output is redacted and bounded |
| `SCOPE_DIGEST_MISMATCH` | preparation, approval, pinned digest/revision or changed target does not match |
| `PLAN_NOT_FOUND`, `ALREADY_APPROVED` | unknown plan; once-only admission |
| `ENTRY_PLAN_AUTHOR_REQUIRED` | no model-authored plan seam (or a fixture author in production) |
| `ENTRY_PLAN_INVALID`, `ENTRY_PLAN_REJECTED` | malformed model output, or a packet outside the owner menu/envelope |
| `ENTRY_GENERATED_REQUESTS_UNSUPPORTED`, `ENTRY_OWNER_MENU_UNSUPPORTED` | the composition cannot execute that plan flavour |
| `ENTRY_UNSUPPORTED_CAPABILITY` | the owner grant lacks the routed action |
| `ENTRY_INTEGRATION_REQUIRED` | the owner run document or a required seam is missing |
| `ENTRY_RUN_UNKNOWN`, `ENTRY_DELEGATION_BLOCKED`, `ENTRY_DELEGATION_FAILED`, `ENTRY_PLAN_CORRUPT` | resume/read/delegation refusals; nothing is faked |
| `ENTRY_HUMAN_APPROVAL_REQUIRED`, `ENTRY_APPROVAL_CONFLICT`, `ENTRY_APPROVAL_WINDOW` | no confirmation capability and no owner document; an existing different owner artifact would be overwritten; the owner window/deadline has ended |
| `ENTRY_SOURCE_UNBOUND` | the acquired local/repository view cannot be bound to the worker's source inputs (divergent root, missing relative path, container boundary) |

## 7. Composition surface (wired)

`createApplicationEntryPort(options)` (exported from `src/application/index.ts`) builds the port from the
owner-approved run document plus explicit seams:

* `backend` + `manifestPath` + `mode` — the existing composed backend and its owner run document.
* `planAuthor` — the real model author. `createPiModelPlanAuthor` (`src/application/entry/pi-author.ts`)
  performs one bounded completion on the host Pi session model (the extension binds `ctx.modelRegistry`) or
  on an inert `pi-ai` provider fixture in tests; it asks the model for a bounded **selection** or a set of
  **generated requests**, never for authority. Absent ⇒ `plan` fails with `ENTRY_PLAN_AUTHOR_REQUIRED`.
* `buildOwnerMenuProposal` — the composition-owned expansion of a model selection into a full
  `PlanProposal` built from owner data (scope, targets, accounts, budgets, coverage). A composition that
  supplies no builder refuses the selection flavour with `ENTRY_OWNER_MENU_UNSUPPORTED`.
* `generated` / `ownerMenu` — `{ ledger, ownerDocumentPath, register, … }`, where `ownerDocumentPath` may be
  a function of the sealed proposal digest (the composition derives
  `<approvals>/request-approval-<digest>.json` / `<approvals>/plan-approval-<digest>.json`). `register` maps
  the materialized `checks`/`grants` into the run's observation menu and validates each one against the
  task's owner policy grant; owner-menu checks *narrow* the menu to the plan selection, generated checks are
  *additive* inside the owner envelope.
* `ownerObservations`, `requestEnvelope`, `workspaceRoot`, `cwd`, bounds/clock/id overrides. The composition
  fills all of these from the validated owner document; operator overrides live in
  `ApplicationOverrides.entry` (`workspaceRoot`, `manifestPath`, `approvalDirectory`, `planAuthor`, bounds,
  clock/newId, git binary/command runner, observer).

Two composition notes:

* The **owner-menu flavour requires an owner `planner` document**, because the composition creates its
  `PlanLedger` (the owner batch-approval gate) from it. Without one, `available.ownerMenu` is false, the author
  is told so, and an owner-menu selection is refused with `ENTRY_PLAN_INVALID` while generated requests stay
  available inside the controller-derived owner envelope.
* The registration callback runs *before* the delegated admission (that is when the entry workflow plans), so
  its receipt is a controller-root record under `<roots.control>/entry-registrations/`; a durable
  `entry.plan-registered` event is added when the run already exists.

`createP2OBackend` (the default composition factory) now attaches the port as `ControlBackend.entry`:
it derives `entrySeams` from the validated owner document (`src/application/composition.ts`), materializes
or verifies the owner run manifest (`ensureOwnerRunManifest`), resolves the model author from the host
session / `entry.planAuthor` / `P2O_PLAN_AUTHOR_MODULE`, and only accepts targets that appear in
`run.authorization.targets`. Approval documents are read from the owner approval directory by
`createOwnerDirectoryAuthority`, and an interactive `/p2o` confirmation may create exactly one document per
sealed proposal through `createOwnerApprovalPort` (atomic, 0600, never overwriting a different document); the
existing owner gate still performs every binding, window and canonical-digest check.
Plan registrations are recorded under `<roots.control>/entry-registrations/` before admission (with a durable
`entry.plan-registered` event when the run already exists), so a registered check can be audited even though
registration precedes the run's admission.


## 8. Non-claims

* No live-target, model or provider behaviour is proven by this module's tests; they run entirely offline with
  an inert loopback fixture, an inert runtime adapter and recorded git invocations.
* The read-only snapshot and clone are hygiene and provenance measures, not a sandbox or isolation claim.
* A local target's owner-pinned `revision` label is not independently verifiable; the enforced identity is the
  content digest.
* The workflow grants no authority: every action still passes the existing policy/broker/budget gates, and the
  owner run document remains the only scope and authorization source.
* Registered plan checks live in the composition instance that admitted them. A process restart does not
  silently re-register them: the entry plan and the request-plan ledger are durable, but resuming a run that
  executed a registered generated check fails closed (`unapproved-observation`) rather than widening the menu.
* The derived run manifest under `<roots.control>/entry/run-manifest.json` follows the owner document; an
  operator-pinned `entry.manifestPath` is only ever verified, never written.

## 9. Running the entry suite

```sh
npx vitest run --config tests/entry/vitest.config.ts   # entry-only suite (offline, inert fixtures)
npx vitest run tests/entry/unified-command.integration.test.ts   # /p2o command → default composition →
                                                         # target entry → inert model provider fixture →
                                                         # human approval → real supervisor/broker → report
npm run test:vitest                                     # root suite incl. tests/entry/**
npm run typecheck                                       # includes src/application/entry and tests/entry
npm run build && npm run check:build
```

`unified-command.integration.test.ts` needs the built composition (`dist/src/runtime/guardian.js`), because
the real headless runtime spawns its guardian by path; it compiles `tsconfig.build.json` itself when the
artifact is missing. Everything else in that file is the production path: the real `/p2o` command, the real
`createP2OBackend`, the real `RequestPlanLedger`/`materializeRequestPlan` gate, an owner-authored approval
document, the real supervisor, the real broker and a loopback fixture. Model authoring is bound to an inert
`pi-ai` provider fixture, so the suite makes no provider call and costs nothing.
