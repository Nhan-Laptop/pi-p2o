# VM boundary: a precise non-claim

**There is no VM runtime in pi-p2o, and this document does not claim one.** It records exactly what
isolation exists today, what a VM boundary would have to provide, and the explicit refusal path when a
task requires executing untrusted binaries. Nothing here is a qualification result for a runtime that
does not exist; the only live qualifications are the ones recorded in `containers/QUALIFICATION.md` and
`docs/architecture/browser-pack.md`.

## What isolation we actually have

| boundary (code) | what runs there | actual containment | what it is **not** |
|---|---|---|---|
| `local-fixture` (`createLocalFixtureSandbox`) | trusted broker code, and owner-supplied local modules imported by `fuzz.differential` | broker capability/policy gate before dispatch; immutable trusted input snapshot with containment/symlink/identity checks; explicit owner acknowledgement `local-fixtures-only-not-hostile-code-isolation` | not process isolation. Modules run **in the controller process on the host kernel**  (`codeExecution: 'trusted-local-modules'`); hostile code is refused, not contained |
| `dedicated-offline-container` (optional, `createContainerSandbox`) | the pinned, identity-verified offline worker; `native.inspect` header/string inspection | image identity chain (digest + layer content addresses + base descent + in-image hashes) verified **before** start; `--network=none`; `--read-only`; `--user=65532:65532`; `--cap-drop=ALL`; `no-new-privileges`; pinned seccomp (errno; no socket/mount/namespace/ptrace/BPF/module-loading syscalls); pids/memory/cpu/nofile/core ceilings; tmpfs scratch; no Docker socket | **not** hostile-code isolation. Containers share the host kernel; the adapter requires the acknowledgement `containers-share-host-kernel-not-hostile-code-isolation` and `dedicatedLab: true`, and `containers/QUALIFICATION.md` states it is "not a general hostile binary runner" |
| `host-browser` (optional, `createHostBrowserSandbox`) | pinned host Chrome with a throwaway profile and no host profile/HOME | policy at dispatch; per-request/per-navigation authorization at the CDP `Fetch` layer; DNS pinning; mandatory loopback egress proxy that fails requests before dialing; process-group kill and profile removal; attempt-bound lifetime | a host process on the host kernel, explicitly **not** container isolation (`host-browser-not-container-isolated`) |
| loopback capture proxy (proxy pack) | owner-approved HTTP capture/repeat | loopback-only listener, connection-time scope gate, bounded store | no TLS interception (`passthrough-no-mitm`) and not a trust boundary on its own |
| external fuzzer/scanner runner (`fuzz/external-tool.ts`) | nothing today | contract verifies a pinned lab-image identity before `run()`; an absent runner refuses | **not implemented**: no installs, no runner, no image built by this repository |
| tool broker (all capabilities) | the only path from a worker to any effect | capability grant, action, target/account scope, DNS/address checks, budgets, private digest-addressed artifacts, redaction, `observation-not-verified-finding` classification | not a sandbox: it constrains *what* the broker does, not what a process could do if one were spawned outside it |

Observed container evidence (from `node tests/sandbox/run.mjs --allow-missing`, 35/35 checks): the
kernel-reported constraints are `uid=65532 gid=65532 pid1=true root=ro inputs=ro write-denied=root,inputs
scratch=rw seccomp=2 filters=… no-new-privs=1 caps=0000000000000000 net-sockets=denied pids=32
memory=268435456 cpu=… cgroup=v2`. That is real containment for a **verified trusted worker**, not a
VM.

## What a VM boundary would require (none of it exists here)

A task that needs to execute an untrusted binary — an arbitrary target ELF, a hostile parser, a
coverage-guided fuzzer target, a kernel-level exploit — needs a real boundary. The minimum contract:

1. **Runtime.** A hypervisor-backed runtime (KVM/cloud-hypervisor/Firecracker/QEMU/WHPX/…) with a stable,
   scriptable launch path and a unique per-run machine identity. The controller must never fall back to
   in-process, host-kernel or shared-kernel execution when the runtime is unavailable.
2. **Image provenance.** Digest-pinned kernel and rootfs, with the pin re-verified from content (layer
   diff ids / dm-verity / signed metadata / vTPM measurement) on every start, not from a tag, name or
   label. No registry access at run time (`--pull=never` equivalent), no mutable base.
3. **Network policy.** Default-deny; the only egress route is the broker's proxy with per-request
   authorization and DNS pinning; no host loopback, unix sockets, metadata service, or container/VM
   daemon socket; websocket/QUIC/raw IP covered by the same gate.
4. **Storage.** Read-only root, per-run scratch that cannot escape the guest, exactly one verified
   read-only input mount, and a bounded digest-addressed export channel for artifacts.
5. **Resource ceilings.** CPU, memory, disk, pids and wall clock enforced **outside** the guest and
   observable inside; a hang must be killable and the kill proved (process/VM absence), not assumed.
6. **Evidence and lifecycle.** The runtime identity and image pin recorded in the receipt; boot and exit
   observed; artifacts bounded and digested; attempt-bound lifetime with a tombstone; crash recovery that
   reconciles or destroys the VM and never reuses it; no credential material in the guest.
7. **Qualification and fail-closed gates.** A new isolation mode (for example `microvm`) that is the
   *only* mode in which binary-executing capabilities declare themselves qualified; an explicit owner
   acknowledgement plus expiry (like the container and browser boundaries); a `doctor` check; and a
   preflight that re-hashes the runtime and image and refuses on drift.
8. **Documentation.** A published qualification receipt with the exercised attack surface and residual
   risks, including what the boundary still does not protect (host kernel, hypervisor, side channels,
   network position).

## The explicit refusal path today

When a task requires executing untrusted binaries, the system refuses rather than improvising:

* **`native.inspect`** requires a qualified dedicated lab; on `local-fixture` it throws
  `UNAVAILABLE` — *"Native tools require an explicitly qualified dedicated container/VM lab"* — and it
  is a bounded read-only header/string inspection, never execution.
* **`createContainerSandbox`** refuses to construct without
  `acknowledgement === 'containers-share-host-kernel-not-hostile-code-isolation'`, `dedicatedLab: true`
  and pinned image/lock/seccomp identities; an unresolvable base, missing layer pin or identity drift is
  `IDENTITY_DENIED`/`UNAVAILABLE`, never a relaxed run.
* **`fuzz.differential`** refuses any boundary without `codeExecution: 'trusted-local-modules'`
  (`UNAVAILABLE`), refuses network/package module specifiers (`TARGET_DENIED`), and is only qualified on
  `local-fixture`.
* **External coverage-guided tools** (ffuf/nuclei/sqlmap/…) have no runner: `runExternalTool` refuses with
  `UNAVAILABLE` before `run()` when the runner is absent, and refuses `IDENTITY_DENIED`/`EXPIRED` on any
  absent or mismatched pin (see `docs/architecture/fuzzing-pack.md`).
* **`doctor`** fails closed on the required boundaries it can see: a missing browser acknowledgement,
  missing trusted-input-only acknowledgement for in-process fuzzing/missing capability, missing durable
  budgets in operational mode, and missing image qualification.

Raw refusal examples (from the fuzz pack suite):

```
external runner absent -> UNAVAILABLE
differential module http:// -> TARGET_DENIED
differential input.url -> INVALID_INPUT
```

## Non-claims

* `container` never means VM and never means hostile-code isolation; the acknowledgement string says so.
* `host-browser` never means container isolation; the isolation string says so.
* `fuzz.differential` is not a sandbox: the controller imports the module process-internally.
* No VM runtime, no VM image, no hypervisor integration and no external fuzzer binary is implemented or
  installed by this repository. Any future claim must come with a qualification receipt, not with this
  document.

## What would change this document

A `microvm` isolation mode with a real runtime, a pinned/measured image, a default-deny network policy
routed only through the broker, external resource ceilings, attempt-bound lifecycle evidence, a
fail-closed `doctor` qualification, and a live qualification receipt recorded in this file. Until that
exists, binary-execution requests keep failing closed with the errors listed above.
