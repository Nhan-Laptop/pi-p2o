# Qualified offline execution pack

This is an optional dedicated-lab container adapter, **not a claim of hostile-code isolation**. Containers share a host kernel. Binary execution/tracing/fuzzing and a live-JS browser are intentionally not provided. `native.inspect` performs bounded read-only ELF/PE/Wasm header/string inspection and requires an explicit native capability and lab qualification.

No Docker socket is mounted into a worker. The credential-owning supervisor may use a pinned Docker client/daemon to create an offline, non-root, read-only, capability-dropped, resource-limited container. `seccomp.json` defaults to errno and permits no socket, mount, namespace, ptrace, BPF or module-loading syscalls. A pinned-pack preflight verifies socket denial with a **loopback-only** listen probe, input/root read-only mount flags, uid, exact Node/worker/source identity, and verified container removal. If the profile/engine/pack is incompatible, execution fails closed rather than loosening restrictions. It is not a general hostile binary runner.

## Observed qualification result

Real-engine qualification on this host (`node tests/sandbox/run.mjs --receipt /tmp/p2o-sandbox-receipt.json`), not a fixture run:

| Item | Observed value |
| --- | --- |
| Engine (client = server) | `28.5.2+dfsg4` (`/usr/bin/docker`) |
| Pinned pack image (`image.pin`) | `sha256:d25927898c87979ef769fb4353e48bf2d2b7ea610e556a981b4196a529915533` (`p2o-offline-pack:22.14.0`) |
| Content pin (`image.rootfsLayers`) | 12 layer diff ids; reported `rootfs=8a2098c912bc0dbce1f9cc8f2024e0ea5ca23d9e416e74d9fa48c7397e2b6437` |
| Digest-pinned base | `node@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de`, local id `sha256:854cb78ac3ed2e215515e3ed78bf40a955bde16fc74114051a1850e509f602e6`, 5 layers |
| `tests/sandbox/run.mjs` live | **35/35 PASS**, exit 0, 7.1 s, receipt `/tmp/p2o-sandbox-receipt.json` |
| `tests/sandbox/run.mjs --static` | **9/9 PASS**, exit 0 (lock/file integrity, no engine needed) |
| `containers/prepare.mjs --verify` | **9/9 PASS**, exit 0 (no build, no pull) |
| Image pulls during the live run | none (`docker events` recorded no `image pull` across 43 events) |

Real-engine evidence captured by that run: a real container created from the pinned image with `network=none`, `readonly=true`, `user=65532:65532`, `pids=32`, `memory=268435456`, `capdrop=["ALL"]`, `no-new-privileges`, pinned seccomp, `log-driver=none`, one read-only bind mount (`<inputRoot> -> /inputs:ro`), tmpfs `/tmp` + `/outputs`; kernel-reported `uid/gid=65532`, `seccomp=2`, `no-new-privs=1`, `caps=0000000000000000`, `net-sockets=denied`, `cgroup=v2` limits; cancellation aborted a live container and proved removal plus absence; no `p2o-*` container leaked.

## How image identity is computed and compared

Identity is a chain, and every link is a hard gate that runs **before** any container starts. Nothing is inferred from a tag or a mutable name; nothing is ever pulled.

1. **Pinned reference.** `image` must be `name@sha256:<64 hex>` or a local image ID `sha256:<64 hex>`. Tags and bare names are rejected as `INVALID_INPUT` at construction. `docker image inspect` is the only image query (never `docker images`, so `<none>` repository/tag rows and the DisplaySize/created-at strings cannot influence identity).
2. **Daemon identity.** In local-image-ID mode the reported `Id` must equal the pin; in repo-digest mode `RepoDigests` must contain the pin. `Id` is the config digest.
3. **Content pin (mandatory).** `imageRootfsLayers` (from `pack.lock.json` `image.rootfsLayers`) must equal the image's `RootFS.Layers`, compared as `digest(layers)`. Those are content addresses of the uncompressed layer tars, so a rebuilt or forged image cannot satisfy them by copying labels, tags or config fields. Without this pin `preflight` refuses with `IDENTITY_DENIED`.
4. **Base descent (mandatory).** The `org.pi-p2o.base.image` label must be a digest-pinned reference that resolves **locally** (`image inspect` never pulls); its image ID must equal `baseImageId` (`base.localBaseImageId`) when supplied, its platform must match, and the pack's leading layers must equal that base image's layers. An unresolvable base or a broken descent is `IDENTITY_DENIED`, not a warning.
5. **Declared runtime config.** `Config.User === '65532:65532'`, `Config.WorkingDir === '/outputs'`, `Env` contains `P2O_OFFLINE_PACK=1`, and labels `pack.version=1.0.0`, `node.version=22.14.0`, `worker.sha256`, `source.sha256` must match the pinned values.
6. **In-image bytes.** Inside the container the pack re-hashes its own `/opt/p2o/offline-worker.mjs`, `/opt/p2o/tools/source.js` and its `process.execPath` (Node) and reports them in `pack-identity`; the adapter compares them to the pinned worker/source hashes, and the live runner compares the Node hash to `base.nodeBinarySha256`.

`prepare.mjs --verify` re-checks the same chain against the local engine from outside the container (plus `base.rootfsLayers` and lock self-consistency) without building or pulling anything.

### What `docker images` output can and cannot do

* The adapter never parses `docker images`. `<none>` repository/tag rows, `<none>` digest columns and the implausible `Created` values (`1970-01-01T00:00:00Z` from `SOURCE_DATE_EPOCH=0`, shown as "56 years ago") carry no identity weight.
* Those rows are still real images on this host. `p2o-offline-pack:determinism`, `:determinism2` and two untagged `<none>` images carry **byte-identical pack labels** (same worker/source/base claims) yet **four different layer lists**; a fifth untagged image (`85210831…`, 11 layers) carries no identity labels at all but is still runnable as `P2O_OFFLINE_PACK=1`, `USER 65532:65532`, `WORKDIR /outputs`. Any of them could be re-tagged as `p2o-offline-pack:22.14.0` at any time. That is exactly why identity is pinned by ID plus layer content, and why a name/tag/label-only check would be unsafe.
* The pack image exposes **no build history** (`docker image inspect` has no `History` key; `Comment: buildkit.dockerfile.v0`), so `docker history` cannot corroborate the Dockerfile build on this daemon. Provenance therefore rests on the content pins, the labels, the in-image hashes and the base descent — not on history.
* Rebuilds are **not bit-reproducible**: BuildKit rewrites layer mtimes, so the same inputs produce new layer content addresses. `prepare.mjs --check` now fails on layer drift instead of reporting "content equivalent"; re-qualification is an explicit act that records a new pin.

## Reproducible preparation (operator-owned; not auto-installation)

1. Use an existing approved Node **22.14.0** base image referenced by its real `name@sha256:<64 hex>` digest. The Dockerfile has no default tag/digest and refuses another Node release. Supply your verified digest; this repository does not invent a digest or pull an image during assessment.
2. Compile the owned code with a pinned TypeScript **5.2.2** compiler (or qualify another exact compiler and preserve its receipt):
   ```sh
   tsc --target ES2022 --module ES2022 --moduleResolution Bundler --strict --skipLibCheck \
     --esModuleInterop --types node --rootDir src --outDir containers/build \
     src/policy/*.ts src/tools/*.ts
   ```
   Use your provisioned Node types; no package installer is run by the broker. Put `{"type":"module"}` in `containers/build/package.json` (generated build metadata, not the root package).
3. Build in a dedicated lab with `containers/` as the context and the pinned base present locally:
   ```sh
   node containers/prepare.mjs            # add --allow-pull only to fetch the exact pinned digest
   ```
   `prepare.mjs` compiles, hashes the exact bytes, builds with `--no-cache --pull=false`, verifies labels, `/opt/p2o` bytes and the Node release, records `image.rootfsLayers`, `base.rootfsLayers`, `base.localBaseImageId` and the compiler identity in `pack.lock.json` (lockVersion 2), and prints `--verify`-able values. It never builds from untrusted target Dockerfiles and the assessment adapter never builds or pulls.
4. Keep the pinned base image on the host: the pack's base descent is verified against the locally resolved digest, and a pruned base is a fail-closed `IDENTITY_DENIED` (not a silent fallback). Re-pull exactly `node@sha256:745403…` (or re-run `prepare.mjs`) if it is removed.
5. Configure `createContainerSandbox` with the local resulting `image` ID, `imageRootfsLayers` (lock `image.rootfsLayers`), `baseImageId` (lock `base.localBaseImageId`), exact client/server `engineVersion`, SHA-256 of `offline-worker.mjs`, emitted `source.js` and `seccomp.json`, and the absolute seccomp path. Qualification includes named approver, expiry, explicit shared-kernel-risk acknowledgement and optional `nativeEnabled`.
6. Input/output roots must be disjoint, canonical, free of symlinks. Input is a trusted immutable snapshot; uid 65532 must be able to read it for native inspection. The host output root is owner-only. Container-generated scratch outputs use a private bounded tmpfs, not a shared run output mount; broker artifact publication goes to the per-attempt private host output tree. No home, credentials, device or socket mounts.
7. Call `doctor({ registry, sandbox, budgets, required })` before starting any worker. Operational broker mode requires a synchronous, transactionally persisted `BudgetJournal` behind the supervisor's writer fence, preserving totals/rates and unknown active leases on restart. Missing engine/daemon, digest/image mismatch, pin/label mismatch, permissions, profile, durable counters, unverified cleanup or qualification expiry is a blocking failure. There is **no silent local-fixture fallback**. Fixture mode must be explicitly selected/acknowledged and is limited to inert local inputs plus loopback HTTP.
8. Re-check a locked pack without rebuilding, and re-qualify (live) before operational use:
   ```sh
   node containers/prepare.mjs --verify             # lock vs local engine: no build, no pull
   node tests/sandbox/run.mjs --static              # lock/file integrity only, no engine needed
   node tests/sandbox/run.mjs --receipt /tmp/p2o-sandbox-receipt.json   # real-engine live smoke
   ```
   Remove superseded pack images after re-qualification (`docker rmi <old id>`) so stale `<none>` pack builds cannot be confused with the pin; never treat a tag, a `<none>` row or a label set as the identity.

## Honest limits of this qualification

* **Shared kernel.** Docker namespaces/seccomp/read-only root are a lab boundary, not hostile-code isolation; the pack never executes target binaries, and a VM-backed deployment must supply its own separately qualified boundary.
* **Trust root.** `pack.lock.json` and the engine/daemon are trusted. An operator who re-runs prepare and adopts a new pin (or hand-edits the lock) is performing re-qualification; the adapter cannot detect a forged pack that a holder of write access deliberately re-pins. The content pins are what make an *accidental* or *copied* wrong image impossible to accept.
* **`build/policy/*.js`** are covered by the whole-image layer pin but not by an individual label. With `imageRootfsLayers` present every in-image byte is bound; if a caller omits the pin the adapter refuses to run rather than trusting labels alone.
* **No build provenance** in the image (no `History`), and rebuilds produce different content addresses — reproducibility is asserted per-pin, not per-recipe.
* **Not hostile-code isolation:** a hostile binary runner, tracing/fuzzing and a live JS browser remain out of scope; `native.inspect` is bounded read-only header/string inspection only.
* **Test wiring:** the inert-runner identity/refusal regression tests live in `tests/tools/container.node.ts` and run under `npm run test:tools`; the real-engine harness (`tests/sandbox/run.mjs`) is not listed in `package.json` (owned outside this workstream) and must be invoked explicitly, as shown above.

Target egress is outside the offline pack and always uses the supervisor-owned scope/DNS/IP/account/rate-limited HTTP broker. Model/documentation egress is a separate runtime responsibility and must not be exposed as a target-policy bypass. A worker running on the host with arbitrary imports/Bash can bypass a broker; the runtime must disable those tools and independently enforce its worker boundary. A VM-backed deployment must supply a separately qualified VM boundary; this repository does not advertise an unimplemented VM runtime.

The Dockerfile/security profile are reproducible inputs, not an executed-container attestation. The live smoke above was executed on this host; it must be re-executed by the operator on the deployment host before operational use. No privileged software installation or host networking mutation is needed or performed by these modules.
