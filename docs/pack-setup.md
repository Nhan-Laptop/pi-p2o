# Consented TOOL PACK setup

This is an opt-in application API, **not yet wired into first-use**. No tool engine, runtime,
container/browser/proxy leaf implementation or default grant was changed.

## Human flow

1. Obtain existing owner scope consent (`OnboardingReady`). Default rights remain read/static;
   repository scripts and state changes retain their independent opt-ins.
2. `prepareCommandPacks` (`src/interface/onboarding.ts`) displays each required pack with its
   description and trust bounds; Cancel / Block means no checks, setup or grants. Required packs
   default to `static`. A caller requesting other packs must provide them explicitly.
3. `ensurePackConsent` confirms exact scope, packs, allowed policy actions, request/call ceilings,
   absolute deadline and digest of operator-reviewed pinned boundary configuration. Mutation
   requires existing owner state-change consent. Public-source review permits static only.
4. `checkPackReadiness` performs actual shipped sandbox + registry `doctor` checks. Consent alone
   **never means ready**. The checked configuration and report are exported only on success.
5. Missing optional packs are `blocked`, with `requiresUpdatedPlanApproval: true`. Removing a pack
   is a changed coverage/plan decision: produce and approve an updated plan; never silently
   substitute static observations for browser/proxy/fuzz results.
6. `materializePackGrant` produces bounded grant *material*, not a runnable policy or plan approval.
   Integration must bind separately approved target/account/task/attempt IDs, method/path scope,
   durable request counters and lifecycle leases. No target requests or assessment models run here.

## API contract for integration

Import the readiness APIs/types from `src/application/pack-readiness/index.ts` and consent APIs
from `src/application/onboarding/index.ts`. `PackBoundaryConfiguration` is supervisor-authored
DATA, never settings loaded from a target, repository config, model output or environment selector.
Use `packConfigurationDigest(configuration)` when forming a `PackSelection`.
Pass the matching `boundaryConfiguration` to `ensurePackConsent`; it verifies the digest and
displays the full pinned settings/boundary data in the confirmation dialog, not only an opaque hash.
No callbacks, runner injection, lifecycle objects or approved source selectors are allowed in data.
Pass a controller preflight lifecycle separately when using a container, and supervisor-owned durable
budgets for operational boundaries. Source acquisition/snapshot and runtime composition remain
integration responsibilities; use immutable qualified snapshots, not a mutable checkout.

Consent documents are atomic 0600 files under the existing safe private onboarding storage root,
outside cwd/target. They bind OS owner, exact owner scope and authorization, configuration pins,
actions, budgets, deadline and human acknowledgements. Equal/narrow reuse is permitted, including
headless reuse. Expansion, different pins, different scope/authorization or expired consent requires
new UI; headless returns `unsupported`. Narrow reuse preserves the wider saved receipt and issues
only narrowed invocation bounds. Loaded JSON is validated data, not executable config.

Issued consent and checked readiness are process-local authenticated objects. Serialized/cloned
objects cannot bypass the checks. Readiness has a 60-second materialization window. Runtime must
still reverify pins/preflight at execution, preserve the exact qualified boundary configuration and
apply the consent deadline/budgets. Never treat an old readiness file as live qualification.
`assertPackConsent` rejects expired receipts. UI consent is a self-attestation, not legal ownership proof.

## Pack trust bounds

- **static**: `source.analyze`; read/analyze only; no repository imports or scripts. Operational
  static analysis uses the qualified dedicated container; trusted-local is an explicitly acknowledged
  inert/trusted fixture boundary, not a production fallback.
- **browser**: `browser.session` / `browser.act`; pinned installed Chrome on the **host**.
  Acknowledgement is exactly `host-browser-not-container-isolated`; no container-isolation claim.
  No `--no-sandbox`, arbitrary eval, host profile or credentials. Known operator-installed Chrome
  paths only; both launcher/executable hashes and version are checked by the existing adapter.
- **proxy**: `proxy.session` / `proxy.history`; host loopback passthrough capture/repeat. No MITM,
  trust-store install or HTTPS body decryption. Non-loopback scope needs the existing acknowledged
  host-browser boundary; trusted-local fixtures stay loopback-only. Port 0 is the shipped pack's
  ephemeral listener configuration, not a model-specified public listener.
- **differential**: `fuzz.differential`; explicitly selected privileged/trusted owner modules ONLY.
  Existing `local-fixtures-only-not-hostile-code-isolation` acknowledgement and
  `trustedOwnerModules: true` are mandatory. The entire input snapshot/module dependency graph must
  be reviewed/trusted owner-supplied code, never acquired untrusted repository JS. Imports run in
  the controller with its privileges; synchronous code cannot be reliably preempted. Readiness does
  not import modules. Integration must not attach this boundary to an untrusted repository snapshot.
- **template**: `fuzz.template`; declared bounded HTTP mutations via existing policy/budget gates,
  not arbitrary JS or an external coverage-guided engine. Mutation rights are separately gated.

## Readiness observations and bounded probes

Checking readiness does not install or repair anything. Filesystem checks inspect disjoint existing
roots and owner-private output permissions. Docker diagnostics issue only fixed `version` and
`image inspect` argv (5-second/output bounds). Exact image digest/local ID and RootFS layer pins
are required; invalid/missing pins fail before engine execution. Existing container `preflight`
then verifies exact client/server release, image/base/layers/pack identities, seccomp digest,
non-root/no-new-privileges/offline/read-only resource constraints and termination evidence.
It creates and removes bounded offline probe containers; this documented exception is covered by
preflight consent. No pulls or builds. Give the probe its own durable controller lifecycle lease.

Seccomp is a bounded regular non-symlink file checked against its pin. Existing Chrome identity
verification hashes files and runs pinned `--version`. Additional Chrome sandbox probing uses a
throwaway private profile and fixed headless `chrome://sandbox/` dump, with background networking
blocked, target resolution disabled and dead loopback proxy; 8 seconds/128 KiB limits and process-group
cleanup. Root users are refused. Namespace and Seccomp-BPF must report Yes; unknown output fails
closed (no bypass/fallback). Loopback proxy readiness briefly binds and closes port 0, with no
outbound request or retained listener. Checks may thus create bounded local resources **after consent**.

Failures classify Docker daemon, permissions, missing image, layer drift, engine, seccomp, Chrome
identity, user sandbox, proxy config and other qualification refusals. No missing capability is faked.

## Operator help versus automatic preparation

`planOperatorSetup` returns display-only descriptions and `{executable, argv}` command DATA.
Never evaluate these as shell text. Docker permission/daemon issues require operator intervention;
Docker access is privileged. Missing images/builds/downloads/upgrades/new pins require **separate
parent approval** and fresh qualification. No auto-repin, paid calls or model/download/build fallback.

The sole shipped local recipe is `create-private-browser-profile-root`: fixed `/usr/bin/mkdir`
argv `[-m, 700, --, <home>/.p2o/browser-profiles]`. Its safe private parent must already exist.
No caller path/argv/code is accepted; no shell, sudo, chmod, recursive/global changes or CA install.
`prepareLocalPackAction` requires issued pack consent **and explicit UI confirmation for that one
action**, refuses headless use, does not modify existing destinations, and verifies owner-only output.
The adapter reruns actual checks afterward. Cancelling preparation does not mint ready/grant material;
previously confirmed pack consent remains saved. Preparation cannot override missing qualifications.

## Offline verification

`npm run typecheck`

`npx vitest run --config tests/pack-readiness/vitest.config.ts`

These are contract/offline checks: Docker refusals are mocked; actual filesystem checks, loopback bind
and fixed local mkdir are exercised. No live Chrome/Docker success, paid models, downloads or image
builds were authorized or claimed. Existing onboarding/command contracts remain separately runnable.
