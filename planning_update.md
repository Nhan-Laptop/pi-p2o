# planning_update.md — Reachable tool surface for a delegated (and solo) p2o worker during an active assessment

Status: this file started as analysis only; **a follow-up pass (D.1/D.2 below) then implemented the docs-accuracy fix recommended in (E), editing the `## Tools` bullets of the 5 skills named in (D).** No code, test, image, or catalog/schema file was changed — only `## Tools` bullet text in 5 `SKILL.md` files, verified against `scripts/validate_library.py`, `tests/test_library.py` and the relevant vitest suites (all still pass; see D.2). This file is a fresh document and supersedes the previous `planning_update.md` (an operator-UI dashboard proposal; that work was already implemented and committed separately — see `e7f6cbc`, `39bf178`, `dffcb96` in `git log`). This pass answers a different question: *which tools named in the 17 audited skills' "Tools" sections are actually reachable while an assessment is running*, for both a delegated worker and the lead (solo or Planner).

Method and limits:
- Read-only. No `scripts/setup-sandbox-tools.sh` run, no image built/pulled, no sandbox started, no live Herdr session. Where a live check would change a conclusion, it is named as a follow-up below, not assumed.
- Every "no caller" / "not used" claim below was confirmed by reading and grepping the cited files directly (not by a bare GitNexus zero), per `AGENTS.md`.
- Base-image contents (what binaries `ghcr.io/usestrix/strix-sandbox@sha256:f690…` ships beyond what the repo's own scripts document) were **not** inspected — doing so means pulling the image, which these guardrails forbid. Every "Bucket 1" call below is therefore a plausible guess, not a confirmed fact, and is flagged as such.

---

## A. The blocked-channel chain, lead vs. worker, with file:line

**The owner's reading is correct: the contradiction is real.** Every execution-capable path the skills assume collapses to the same four tools, in the same one kind of container, for both roles.

1. **Only four tools can ever touch a target or run a command at all:** `p2o_shell`, `p2o_net`, `p2o_http`, `p2o_capture` — `TARGET_TOOLS` (`src/tool-policy.ts:2`). Nothing else in `OWNER_TOOLS`/`WORKER_TOOLS` (`:3-4`) executes anything; the rest read/write the shared ledger.
2. **Who holds those four tools depends on delegation, not on role:**
   - Solo lead (`delegated=false`): `ownerTools(false)` only drops `DELEGATION_TOOLS` (`:7-8`) — it **keeps** `TARGET_TOOLS`. The solo lead has the full four-tool exec surface.
   - Delegated lead (`delegated=true`): `ownerTools(true)` **drops** `TARGET_TOOLS` (`:8`) — the moment delegation is active, the lead itself loses all exec tools and must delegate every target action to a worker.
   - Non-reporting worker: gets `TARGET_TOOLS` through `WORKER_TOOLS` (`:4,9`).
   - Reporting worker: `workerTools('reporting')` strips `TARGET_TOOLS` and `p2o_candidate` (`:9`); `reportingOperationDenied` (`:10`) blocks `exec/net/http/capture/candidate/delegate/graph_record` outright. A reporting worker has **zero** exec surface.
   - **Answer to the guardrails' solo-vs-delegated question: there is no asymmetry in the channel itself.** A solo lead and a non-reporting worker get exactly the same four tool names, and — confirmed below — the exact same container. Delegation does not open a wider door for the lead; if anything it closes the lead's own door and hands the only door to whichever worker is holding it.
3. **All four tools execute in the one and only container shape, for whoever holds them:** `IMAGE` (`src/sandbox.ts:10`) is a single pinned `sha256:` digest; `LIMITS` (`:11-17`) applies `--read-only` rootfs, `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root `--user 65532:65532`, `--pids-limit 512`, `--memory 2g`, `--cpus 2`, and writable space only at `--tmpfs /tmp`/`--tmpfs /work`. **No `--cap-add` of any kind appears anywhere in `src/sandbox.ts`** — confirmed by grep, zero hits. There is exactly one sandbox factory (`extensions/p2o/index.ts:1570-1583`); it is called once per worker and once for a solo lead, with the same `SandboxOptions` shape — mechanically the same container, just a different holder.
4. **The activation gate that enforces all of this is a full replace, not an allow-list add:** `ctx.setActiveTools(toolNames)` "Set[s] the active tools by name" (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1264-1267`) — it replaces the model's entire declared toolset. At run start the owner's toolset becomes exactly `ownerTools(delegationAvailable)` (`extensions/p2o/index.ts:1696`); a spawned worker's becomes exactly `workerTools(ticket.role)` (`:330-331`). Anything not in those two functions' output — host tools, `codemode`, the browser, other extensions, **and any other registered Pi tool, named or not** — is simply absent from what the model can call, for the whole life of the run. With no active run, every `p2o_*` name is stripped too (`:1723`), and a replayed call to one is refused outright (`:1729`). This matches README.md:122-124 ("Host tools, `codemode`, the browser, other extensions, `!` shell and the worker's own Docker access are blocked while an assessment is active. A worker reaches the target **only** through the lead's broker socket; if the lead stops, workers fail closed.") — but it is enforced by this one mechanism, not by naming each blocked thing separately in code.
5. **A concrete, previously undocumented instance of (4):** `skills/attack-surface-mapping/SKILL.md` lists `pi-web-access` as a usable tool ("retrieve an approved public reference page... when the local library and offline sources are insufficient"). `pi-web-access` (`fetch_content`/`get_search_content`/`web_search`, per `research/METHOD.md:11`) is a general Pi-platform research tool, not a `p2o_*` tool — and it is **not** a member of `ownerTools()` or `workerTools()` (`src/tool-policy.ts:3-4`). Because `setActiveTools` fully replaces the toolset at run start, `pi-web-access` is deactivated the instant an assessment begins, for lead and worker alike, exactly like `codemode` and the browser — the skill names a tool that cannot be called during the very assessment the skill is written for.

## B. Why the optional offline tool image does not close the gap

This is a timing/authority argument, not just "it exists, so it's fine":

- `docs/SKILL_RUNTIME.md:31-42` is explicit that the mechanism is **"Explicit operator setup (not an agent tool)"** (`:33`). The only thing the build script actually adds is Semgrep, installed as `root` at image-build time into `/opt/p2o-semgrep` (`scripts/setup-sandbox-tools.sh:10-14`) — a step that is only possible *before* the container exists, because the running container's rootfs is `--read-only` and its user is non-root (`src/sandbox.ts:11-17`). There is no way to repeat that step once a container is up.
- The resulting image ID must be chosen at Pi startup (`pi --p2o-image sha256:<id>`, `SKILL_RUNTIME.md:37`), before `/p2o --target ...` ever runs. There is no tool, command, or code path anywhere in `extensions/p2o/index.ts` that accepts a new image ID, rebuilds, or swaps the running container's image mid-run — confirmed by grep: `--p2o-image` and `setup-sandbox-tools` do not appear in `extensions/p2o/index.ts` at all.
- Consequently a worker who discovers mid-task that a skill's chosen tool isn't present has **no recourse at all**: it cannot ask for the tool to be added (no tool exists to ask with), and the one documented fix requires an operator decision made before the run that spawned that worker even started. This is strictly worse than "docs are late" — it is a capability that, once a run is active, no one inside the run (lead or worker) can invoke, by design.
- Separately, and more fundamentally: even a perfectly-timed custom image would **not** help most of the tools audited below, because their blocker is not "not installed" but `--cap-drop ALL` (no `ptrace`, no raw sockets), `--read-only` rootfs (no package-manager writes to `/usr` regardless of root), no display, no init system, or the wrong/no OS/kernel entirely. No image choice changes any of those. Semgrep is the one tool in this repo's own documentation that a pre-run image genuinely fixes; as it happens, **none of the 17 audited skills actually name Semgrep in their "Tools" sections** (confirmed by the discovery pass below), so the one mitigation that works isn't even aimed at the tools these skills promise.

## C. Per-tool reachability, across all 17 skills' "Tools" sections

Discovery: each of the 17 files' "Tools" section (and body, where no heading existed) was read and every named external tool extracted verbatim. Classification below applies the guardrails' three buckets, with the correction that **the deciding factor is root / dropped capability / display / hardware / wrong OS or kernel — not "preinstalled or not."** Two capability facts matter most and are confirmed from `src/sandbox.ts:11-17` plus the absence of any `--cap-add` in that file:
- **`--cap-drop ALL` blocks `ptrace`** (Docker's default seccomp profile denies the `ptrace` syscall unless `CAP_SYS_PTRACE` is present; nothing re-adds it here) → every debugger/DBI/strace-family tool below is blocked by this alone, independent of root.
- **`--cap-drop ALL` also blocks raw sockets** (`CAP_NET_RAW`) → live packet capture and any raw-socket technique is blocked the same way.
- **`--read-only` rootfs blocks any package-manager install to `/usr`/`/opt`/`/etc`, even as root** (there is no root inside anyway) — Bucket 2 is therefore limited to what installs entirely under `/tmp` or `/work`: `pip install --user`, a language's own user-local package manager, or a statically-linked binary fetched and `chmod +x`'d.

### Bucket 1 — plausibly already in the pinned base image (unconfirmed; the image was not pulled)

| Tool | Cited in |
|---|---|
| `git` | patch-diff-analysis, source-code-auditing |
| `strings` | patch-diff-analysis, binary-auditing |
| `rg` (ripgrep) | source-code-auditing, attack-surface-mapping |
| `grep` | source-code-auditing |
| `file`, `readelf`, `nm`, `objdump` | binary-auditing (also `objdump` in attack-surface-mapping, patch-diff-analysis) |
| `ss` | attack-surface-mapping |
| local language console (python3/node REPL) | deserialization-and-dispatch-auditing |
| OS token/descriptor inspectors (`id`, `capsh`, reading your **own** `/proc/self/status`) | sandbox-boundary-analysis, authorization-auditing |
| IPC source review (reading source, no binary) | sandbox-boundary-analysis |
| small local runtime tests / isolated unit tests (the target's own language runtime) | parser-differential-auditing, source-code-auditing |

**13 distinct tools/techniques.** The self-state items (OS token inspectors, IPC source review) are reachable precisely *because* they only ever inspect the sandbox's own, already-dropped privilege set — no capability is needed to read your own confinement.

### Bucket 2 — installable at runtime without root, entirely under `/tmp` or `/work`

| Tool | Cited in | Install path |
|---|---|---|
| `angr` | data-flow-analysis | `pip install --user angr` |
| `Triton`* | data-flow-analysis | `pip install --user triton`; *live-tracing submode may want more than this — flagged, not asserted |
| `Z3` | data-flow-analysis, memory-safety-auditing | `pip install --user z3-solver` |
| `CodeQL` | data-flow-analysis | fetch the CLI release archive into `/work` |
| `Joern` | data-flow-analysis | fetch the release archive into `/work` (needs a JVM) |
| `d8`, `jsc` | compiler-invariant-auditing | fetch a static engine-shell build into `/work` |
| `binwalk` | binary-auditing | `pip install --user binwalk` |
| `ilspycmd` | binary-auditing | `dotnet tool install -g` installs under `$HOME` (= `/tmp` here) — needs a .NET SDK present/installable first |
| `jadx`, `xdis`, `pydisasm` | binary-auditing | `jadx` release archive into `/work`; `xdis`/`pydisasm` via `pip --user` |
| Socket.IO-capable test client | authorization-auditing | `pip install --user python-socketio` / `npm install socket.io-client` into `/work` |
| CLI-only intercepting proxy (e.g. `mitmdump`, not Burp) | data-flow-analysis, authorization-auditing, parser-differential-auditing, sandbox-boundary-analysis | `pip install --user mitmproxy` |
| `Kuna CLI`† | binary-auditing, attack-surface-mapping, patch-diff-analysis | — |
| `AFL`/`AFL++`* | fuzzing | needs a working C/C++ toolchain already present or installable; **ptrace is not actually required** (AFL's fork-server design avoids it) — the real cost is the toolchain, not a capability |
| `QEMU` (user-mode)* | fuzzing | fetch a static `qemu-*-static` binary into `/work`; no ptrace needed for TCG-based user-mode translation |
| sanitizer (ASan/UBSan as a compile flag)* | fuzzing | a compile-time flag, not a capability — same toolchain caveat as AFL |

**15 distinct tools/techniques**, three marked `*` as genuinely uncertain (toolchain availability unconfirmed — named as a follow-up, not asserted) and one marked `†`:
`†Kuna CLI` is the **one skill mention in the whole corpus that already self-flags its own uncertainty** — all three citing skills phrase it as "Optional Kuna CLI... when installed and format-supported." No setup path for it exists anywhere in this repo (unlike Semgrep's documented `scripts/setup-sandbox-tools.sh`), so "when installed" currently has no way to become true. Treat it as **not actually reachable today**, despite being honestly worded.

### Bucket 3 — not reachable mid-run by lead or worker, period (root / dropped capability / display / hardware / wrong OS or kernel)

| Tool | Cited in | Why |
|---|---|---|
| debugger (generic) | exploitability-assessment, deserialization-and-dispatch-auditing, parser-differential-auditing, sandbox-boundary-analysis, race-condition-auditing, memory-safety-auditing, state-and-lifetime-auditing | ptrace blocked |
| GDB, `gdbserver` | compiler-invariant-auditing, dynamic-analysis, fuzzing, binary-auditing, state-and-lifetime-auditing | ptrace blocked |
| LLDB | compiler-invariant-auditing, dynamic-analysis, fuzzing, binary-auditing, state-and-lifetime-auditing | ptrace blocked |
| WinDbg | memory-safety-auditing, dynamic-analysis, fuzzing, binary-auditing, state-and-lifetime-auditing | wrong OS — container is Linux |
| `x64dbg` | dynamic-analysis | wrong OS + GUI |
| `libdebug` | dynamic-analysis | ptrace blocked |
| Frida (Interceptor/Stalker) | data-flow-analysis, deserialization-and-dispatch-auditing, dynamic-analysis, parser-differential-auditing | ptrace/`process_vm` attach blocked |
| Procmon | dynamic-analysis | wrong OS + GUI |
| user-mode crash dumps | dynamic-analysis | needs root-level OS crash-dump config, plus a (blocked) debugger to read them |
| Wireshark | dynamic-analysis, parser-differential-auditing, sandbox-boundary-analysis | GUI, no display; live capture also needs `CAP_NET_RAW` (dropped) |
| syscall tracing (strace/eBPF) | dynamic-analysis, sandbox-boundary-analysis | ptrace or `CAP_BPF`/`CAP_SYS_ADMIN` (dropped) |
| TinyInst, `litecov` | dynamic-analysis, fuzzing | OS debug-API–based DBI, same family as ptrace |
| Lighthouse | dynamic-analysis | IDA/Binary Ninja plugin — GUI |
| Jackalope, AFL-Frida | fuzzing | Frida/DBI-based — ptrace blocked |
| Page Heap | memory-safety-auditing, fuzzing, state-and-lifetime-auditing | wrong OS (Windows-only feature) |
| GuardMalloc | memory-safety-auditing, fuzzing, state-and-lifetime-auditing | wrong OS (macOS-only) |
| KASAN | memory-safety-auditing, fuzzing, race-condition-auditing, state-and-lifetime-auditing | needs a KASAN-built **kernel** — impossible from inside any container |
| `libslub` | memory-safety-auditing | GDB plugin — inherits GDB's block |
| kprobes | race-condition-auditing | kernel tracing/module privilege (`CAP_SYS_ADMIN`+root), and the skill text itself says "a permitted diagnostic build" |
| IDA | patch-diff-analysis, attack-surface-mapping, binary-auditing | GUI, no display (named without a headless qualifier) |
| Ghidra | patch-diff-analysis, attack-surface-mapping, binary-auditing | GUI, no display (named without a headless qualifier) |
| ImHex | binary-auditing | GUI (Qt hex editor) |
| BinDiff, Diaphora | patch-diff-analysis | depend on an IDA/Ghidra GUI backend |
| dnSpy | deserialization-and-dispatch-auditing | wrong OS + GUI |
| Burp (GUI half of "intercepting proxy") | data-flow-analysis, authorization-auditing, parser-differential-auditing, sandbox-boundary-analysis | GUI, no display |
| browser / browser developer tools | data-flow-analysis, attack-surface-mapping, sandbox-boundary-analysis | no display, **and** explicitly named as a blocked channel (README.md:122) regardless of sandbox |
| `libguestfs` | attack-surface-mapping, authorization-auditing | needs loop/NBD mount, `CAP_SYS_ADMIN`-equivalent (dropped) |
| service-unit inspection (`systemctl`/`journalctl`) | authorization-auditing | no init system/systemd runs in this minimal container at all |
| System Informer | sandbox-boundary-analysis | wrong OS + GUI |
| Turbolizer | compiler-invariant-auditing | browser-based visualizer, no display |
| `flashrom`, OpenOCD | binary-auditing | raw hardware (flash programmer / JTAG-SWD adapter); the skill text itself scopes this to "owned lab hardware" |

**36 distinct tools.** Not bucketed at all (it isn't a sandbox-binary question): **`pi-web-access`**, named in attack-surface-mapping — see A.5. It is blocked by the tool-activation gate, not by the container.

## D. Skills left with zero Bucket 1/2 tools once Bucket 3 is excluded

Four skills' "Tools" sections are, in their entirety, unreachable during a real run — every named tool is Bucket 3:

- **dynamic-analysis** — all 13 named tools (GDB/LLDB/WinDbg/x64dbg/libdebug/Frida/Procmon/crash-dumps/Wireshark/syscall-tracing/TinyInst/litecov/Lighthouse).
- **race-condition-auditing** — all 3 named tools (KASAN/kprobes/debugger).
- **state-and-lifetime-auditing** — all 6 named tools (WinDbg/GDB/LLDB/debugger/KASAN/Page Heap/GuardMalloc).
- **exploitability-assessment** — its only *named* external tool is "debugger"; everything else in its Tools section is a technique description (policy/token inspection, timing logs, boundary tests), not an installable/runnable tool.

One more, with a caveat:

- **memory-safety-auditing** — technically has one Bucket 2 tool (`Z3`), but `Z3` is an auxiliary arithmetic-modeling aid, not this skill's core workflow. The skill's actual named workflow tools — KASAN, Page Heap, GuardMalloc, WinDbg, `libslub`, debugger watchpoints — are 100% Bucket 3. Effectively zero for the skill's stated purpose.

That is **5 of 17 (29%)** of the audited skills whose "Tools" section currently promises a workflow that cannot run inside a real delegated assessment today, with no pre-run image fix available (per B).

The remaining 12 skills each keep at least one genuinely reachable Bucket 1/2 tool, though several (memory-safety-auditing aside) still carry a Bucket-3-heavy tail — notably **binary-auditing**, which is the best-designed of the 17: it explicitly ranks `file`/`readelf`/`nm`/`strings`/`objdump` **"before or instead of native decompilation"**, i.e. it already assumes its GUI tools might be unavailable and gives a reachable fallback first. No other audited skill does this.

## D.1 Correction found while implementing the fix below

Re-reading the 5 skills' actual `## Tools` bullets (not just the earlier tool-name extraction) found that the "zero reachable" claim in (D) was too strong for 3 of them, because the earlier pass excluded generic-technique bullets (no named binary) from the bucket count even where they are themselves Bucket-1-reachable — the same kind of bullet counted toward Bucket 1 elsewhere in (C) (e.g. "IPC source review", "small local runtime tests"). Corrected status:

- **dynamic-analysis** — confirmed, all 7 bullets are Bucket 3. The only one of the 5 that is actually 100% unreachable.
- **race-condition-auditing** — bullet 1 ("Source/disassembly expansion") is Bucket 1 (reading code, no capability needed); bullets 2–4 (debugger/KASAN/kprobes) are Bucket 3. 3 of 4 blocked, not 4 of 4.
- **state-and-lifetime-auditing** — bullet 1 ("Source/call-graph review") and bullet 4 ("Small operation-sequence tests") are Bucket 1; bullets 2–3 (WinDbg/GDB/LLDB, KASAN/Page Heap/GuardMalloc) are Bucket 3. 2 of 4 blocked, not 4 of 4 (the original count of "6 named tools" also miscounted the file's actual 4 bullets).
- **exploitability-assessment** — only bullet 1 ("Debugger allocation/layout...") is Bucket 3; bullets 2–4 (policy/token inspection, timing logs, isolated boundary tests) are already Bucket 1/2 techniques, not Bucket 3. 1 of 4 blocked, not the whole section.
- **memory-safety-auditing** — bullet 1 ("Disassembler/decompiler") is mixed (static disassembly tools reachable, an interactive GUI decompiler is not); bullet 4 (Z3) is Bucket 2, as already noted; bullets 2–3 and 5 (KASAN/Page Heap/GuardMalloc, WinDbg/libslub, debugger watchpoints) are Bucket 3.

Net correction: only **dynamic-analysis** is genuinely a 100%-blocked Tools section. The other 4 each already have at least one reachable bullet; what they lack is a *labeled* distinction between the reachable technique bullets and the debugger/kernel-sanitizer bullets that cannot run in this sandbox. That labeling gap — not a wholesale missing workflow — is what the fix below closes.

## D.2 Fix implemented in this pass

Edited the `## Tools` bullets of the 5 skills above (only — the remaining 12 skills' Bucket-3 rows in (C) are not yet touched; see the follow-up note at the end of this section) to state plainly, in the existing `tool → purpose → when` bullet format (no new arrows added, so `scripts/validate_library.py`'s 2-arrow-per-bullet check still passes), that the blocked tool needs a separate, non-sandboxed authorized lab environment, naming the concrete reason (live-process-attach/`ptrace`, wrong OS, or a kernel feature no container can provide) — modeled on `binary-auditing`'s existing `flashrom`/OpenOCD wording. `dynamic-analysis` additionally got one short lead sentence under the `## Tools` heading (its whole section is blocked, so a per-bullet repeat would have been redundant seven times over).

Verified after editing: `python3 scripts/validate_library.py` → `PASS: 17 skills; ...` (unchanged pass); `python3 -m pytest tests/test_library.py` → 117 passed, 1 skipped; `npx vitest run tests/minimal/wstg-skills.test.ts tests/minimal/roles.test.ts tests/minimal/extension.test.ts` → 34 passed; `node .gitnexus/run.cjs detect-changes --scope all --repo .` → 7 files changed, risk level low, 0 affected processes.

**Not done in this pass, left as a follow-up:** applying the same per-bullet wording to the Bucket-3 rows inside the other 12 skills (the ones that already keep at least one reachable tool, per the original (D) text) — e.g. the GUI/IDA/Ghidra mentions in `patch-diff-analysis`, `attack-surface-mapping`, `binary-auditing`, the Burp/Wireshark mentions in `data-flow-analysis`/`authorization-auditing`/`sandbox-boundary-analysis`/`parser-differential-auditing`, and so on. Those are read-fine-as-is today (none of them claims a skill is 100% runnable when it isn't), so leaving them unedited does not misrepresent any skill's workflow the way the 5 "zero-reachable" skills did; extending the same wording there is optional polish, not a correctness fix, and is why it was left out of this bounded pass rather than done unasked across all 17 files.

## D.3 Implemented: pre-installing Bucket-2 tools into the offline image (operator-chosen)

`scripts/setup-sandbox-tools.sh` now takes an optional `--with=<tool1,tool2,...>` after `--build`, adding any of a
fixed, pinned list — `angr` 10.0.3, `z3` (`z3-solver` 5.1.0.0), `binwalk` 2.1.0, `mitmproxy` 12.2.3, `unicorn` 2.1.4
— each into its own venv, installed as root at build time only, exactly like the existing Semgrep block (own
`requirements.resolved.txt`, `chmod -R a+rX`, binary symlinked into `/usr/local/bin`). Default behavior (`--build`
with no `--with`) is unchanged: still Semgrep only, verified by counting generated `RUN` lines before/after.

This converts these 5 tools from Bucket 2 (installable at runtime, but costing time/egress and leaving no
owner-visible record that it happened) to effectively Bucket 1 for whoever builds and selects this image — **it does
not touch the running container's `LIMITS`** (still `--read-only`, `--cap-drop ALL`, non-root `65532:65532`), so it
cannot do anything for Bucket 3; see D.1 above, this is a strictly Bucket-2-only mechanism, same timing/authority
limits as B (operator decision, before `pi` starts, immutable for the run's lifetime).

Why these 5 and not the other 10 Bucket-2 entries in (C): `angr`/`z3`/`binwalk`/`mitmproxy` were already the
lightest, purely-pip-installable, no-extra-runtime (JVM/.NET SDK/compiler) entries in the Bucket-2 table; `unicorn`
was added for D.4 below. `CodeQL`/`Joern` (need a JVM + large release archives) and `ilspycmd` (needs a .NET SDK)
were deliberately left out of the registry — heavier, slower to validate here, and not requested; adding them is a
mechanical follow-up (same pattern, different `RUN` line) if wanted.

**Verified:** `bash -n` + `shellcheck` clean; a stubbed `docker` confirmed the generated Dockerfile is syntactically
correct for `--build` alone (1 `RUN` line, unchanged) and for `--with=angr,z3,binwalk,mitmproxy,unicorn` (6 `RUN`
lines, correct order, `USER root` ... `USER 65532:65532` unchanged); each package's actual pip install + resulting
console-script names were checked directly in a throwaway venv (not the sandbox image) before being written into
the script — `angr` ships `angr`/`angr-mcp` scripts (library-first tool, used via `import angr`), `z3-solver` ships
a `z3` binary, `binwalk` ships `binwalk`, `mitmproxy` ships `mitmdump`/`mitmproxy`/`mitmweb` (only `mitmdump` is
symlinked — the CLI-only, non-interactive one). **Not done:** an actual `docker build` against the real
`strix-sandbox` base image (would require pulling it; the Dockerfile mechanics being added are identical in shape
to the already-proven Semgrep block, so this is a reasonable, named gap rather than an assumed pass). `python3
scripts/validate_library.py`, `pytest tests/test_library.py` and `node .gitnexus/run.cjs detect-changes --scope
all` all stayed green after these edits (risk: low, 0 affected processes — `.sh` files aren't graph symbols, so
GitNexus only reported the `docs/SKILL_RUNTIME.md` prose section changing).

## D.4 Bucket 3: is there an optimization or a similar substitute?

Only for the capability-blocked rows (`ptrace`, raw sockets, user-space heap sanitizers). Nothing substitutes for a
kernel-only feature, missing OS, raw hardware, or a deliberately policy-blocked channel — those need the separate
lab environment named in the skill-file edits above, full stop. Where a substitute *does* exist, it works by doing
the equivalent job through a path `--cap-drop ALL` / `--read-only` / non-root does not touch, not by reopening the
capability:

| Blocked (Bucket 3) | Substitute reachable in this sandbox | Why it works here | Caveat |
|---|---|---|---|
| GDB/LLDB/WinDbg/x64dbg/libdebug, Frida Interceptor/Stalker, TinyInst/litecov, Jackalope, AFL-Frida | **Emulation instead of live attach**: Unicorn Engine (now in `--with`) or angr's own concrete-execution mode. The emulator *is* the executing process — breakpoints/hooks/memory-watch are emulator callbacks, not `ptrace`/`process_vm_*` calls into a separate process. | `--cap-drop ALL` blocks attaching to *another* process; it does not block a userspace CPU emulator running as your own process. | Not bit-identical to native execution — library/syscall emulation gaps exist. Verified: `unicorn==2.1.4` installs and imports cleanly here (pure-Python wheel, no compiler). **Tried and rejected:** `qiling` (full OS-emulation framework built on Unicorn) — its `pillow` dependency failed to build from source in this environment (no `libjpeg` headers), so it was **not** added to `--with`; the actual sandbox base image's Python/library versions were not inspected, so this could differ there, but it is not assumed to work without re-checking against that image specifically. |
| strace/eBPF syscall tracing, Procmon, Wireshark (live capture) | **`LD_PRELOAD` interposition** on libc wrappers (`open`/`read`/`write`/`connect`/`send`/`recv`) in a process you spawn yourself, logging to a file in `/work`. | This is normal dynamic-linker behavior on your *own* child process, not attaching to someone else's — no `ptrace`, no `CAP_NET_RAW` needed. | Only catches calls that go through libc; a statically linked binary or one calling `syscall()` directly bypasses it. Not implemented here (no shim written/shipped); this is a named technique, not a shipped tool. |
| KASAN/Page Heap/GuardMalloc, WinDbg `!pool`/libslub (for userspace heap bugs on an already-built binary) | **A userspace guard-page allocator via `LD_PRELOAD`** (e.g. AFL++'s `libdislocator.so`), or recompiling with ASan/UBSan when source is available (already Bucket 2, no change needed). | Guard pages + `SIGSEGV` on overrun is implemented entirely with `mmap`/`mprotect` in userspace; no kernel feature, no root. | `libdislocator` is a C source file from AFL++, not a pip package — building it needs a C toolchain in the image and was **not** added to `--with` in this pass (toolchain availability in the base image is unconfirmed, same caveat as the `*`-marked fuzzing entries in Bucket 2 of section C). True KASAN (kernel-space bugs) has **no** substitute — it instruments the kernel itself, which no container changes. |
| IDA, Ghidra (listed in the 17 skills without a headless qualifier), and by extension BinDiff/Diaphora | **Correction, not just a substitute**: both tools ship an official headless/batch mode — Ghidra's `analyzeHeadless`, IDA's `idat`/`idat64` batch mode — that needs **no display at all**. The skills audited in (C) name these tools generically, which is why they were bucketed as GUI-blocked; that bucketing is right for interactive use and wrong for headless use. | Headless decompilation never opens a window; the actual blocker is acquiring the binary itself (Ghidra is free + JVM-only; IDA is commercial and needs a license), not the sandbox's lack of a display. | Not verified against this repo's sandbox: whether a JVM is present/installable for Ghidra headless, and whether IDA's license terms permit running `idat` inside this container at all, are both open — named as follow-ups, not assumed. This also means the Bucket-3 table in (C) should arguably split "IDA/Ghidra interactive" from "IDA/Ghidra headless" in a future pass; not done here to keep this addendum bounded. |
| Turbolizer (browser-based V8 pipeline view) | `d8 --trace-turbo`'s own raw text/JSON output, read directly. | `d8` itself is already Bucket 2 (static engine-shell binary); Turbolizer is only a renderer for output `d8` already produces headlessly. | None — this one already works today with no new tool. |
| ImHex (GUI hex editor) | `xxd`/`hexdump` plus manual struct-aware parsing (Python `struct`). | Pure text-mode tools, no display. | Loses ImHex's pattern-language visualization; fine for the byte-level questions these skills actually ask. |
| `libguestfs` (needs loop/NBD mount or a VM appliance) | Format-specific userspace parsers that read the image's bytes directly without mounting (e.g. `unsquashfs`, `7z`, or a Python filesystem-forensics library). | Parses the on-disk structure directly; never asks the kernel to mount anything. | Narrower than `libguestfs` — covers one filesystem/archive format at a time, not "mount anything and browse it." |
| `systemctl`/`journalctl` (no init system running here) | Read the relevant unit files and the application's actual log destination (file or stdout capture) directly as source/text. | No running service manager is needed to read static config or already-written log text. | Loses live service *state* (active/failed/restart-count) — only static config and historical logs are recoverable this way. |
| `flashrom`/OpenOCD (raw hardware), kprobes/true KASAN (kernel-only), the browser/browser dev tools (policy-blocked, not capability-blocked per README:122) | **None.** | Hardware and kernel-internals cases are physically outside what any container can do; the browser is an intentional access-control boundary (a worker must not reach the operator's real browser), so "optimizing around it" would be undoing a deliberate security decision, not closing a technical gap. | Leave these as-is; the skill text for `flashrom`/OpenOCD already says so correctly. |

None of this row set was implemented as shipped tooling beyond `unicorn` (added to `--with` in D.3) — the
`LD_PRELOAD` shim and `libdislocator` build are named as viable techniques/follow-ups, not delivered here, to keep
this pass to what was verified rather than what seems plausible.

## E. Docs-accuracy problem, or a workflow gap worth designing?

**Mostly a docs-accuracy problem, with one narrow design-worth-considering exception.**

- For the 5 skills in (D), and for most of the Bucket-3 list in (C): the blocker is `ptrace`/raw-socket capability, no display, no init system, the wrong OS, or a kernel feature — none of which any pre-run image, mid-run tool-add step, or other p2o-side mechanism can fix, because they are properties of *this specific sandbox model* (read-only rootfs, dropped capabilities, headless, Linux-only, one pinned kernel underneath). Reopening any of them means adding back the exact capabilities (`SYS_PTRACE`, `NET_RAW`, a GUI/display, root) that `src/sandbox.ts` deliberately drops to keep this "container isolation, not VM isolation" (README.md:155) — a security-posture change, not a tooling gap. **Recommendation: fix the docs.** Each of the 5 skills in (D), and every Bucket-3 row in (C) elsewhere, should say plainly that the named tool needs a separate, non-sandboxed authorized environment (a real lab machine, VM, or hardware rig) and is not available inside a p2o run — the way `flashrom`/OpenOCD's own skill text already (correctly) scopes itself to "owned lab hardware." Tests already pin skill "Tools" text in places (per the WSTG/skill-catalog conventions used elsewhere in this repo); updating the wording is a docs change, not a code or sandbox change.
- The one place a real workflow gap exists is the **timing/authority gap in B**, not a capability gap: Semgrep's offline image is a genuine, working mitigation that simply cannot be invoked by anyone once a run has started — and the `pi-web-access` finding (A.5) shows the activation gate can silently drop a tool a skill names, with no error, no warning, and no owner-visible signal that it happened. A **worker-requestable, lead-approved mid-run tool-add step** (worker asks, lead approves, lead's broker rebuilds/respins that worker's container from an operator-pre-approved image list, or installs a Bucket-2-eligible package into that worker's own `/work`) would close this specific gap for the handful of tools that are genuinely just "not pre-installed" rather than structurally blocked (Semgrep-like cases, and the Bucket-2 install-at-runtime tools that already work today but cost time/egress with no owner visibility that it happened). I recommend this as worth a separate design pass — it is **not** designed or implemented here, per guardrails.

---

## Appendix — evidence index

- `README.md:100-124` (tool table, solo-mode tool removal, blocked-channel statement), `:138-140` (scratch-install guidance), `:151,155` (network egress / container-not-VM limits).
- `src/tool-policy.ts:2-10` (`TARGET_TOOLS`, `OWNER_TOOLS`, `WORKER_TOOLS`, `DELEGATION_TOOLS`, `ownerTools`, `workerTools`, `reportingOperationDenied`).
- `src/sandbox.ts:10-17` (`IMAGE`, `LIMITS`); confirmed by grep: no `--cap-add` anywhere in the file.
- `extensions/p2o/index.ts:330-331,594,767,1570-1583,1696,1723,1729` (sandbox factory wiring; `setActiveTools` calls at worker spawn, run start, run end, and no-run/replay state).
- `docs/SKILL_RUNTIME.md:28,31-42` (scratch-install guidance; optional offline tool image, "Explicit operator setup (not an agent tool)").
- `scripts/setup-sandbox-tools.sh:1-18` (the build script: Semgrep only, root-at-build-time, never at runtime).
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1257-1267` (`getActiveTools`/`setActiveTools` semantics: full replace).
- `research/METHOD.md:11` (`pi-web-access` tool names).
- 17 skill files read in full: `skills/{patch-diff-analysis,exploitability-assessment,data-flow-analysis,deserialization-and-dispatch-auditing,compiler-invariant-auditing,remediation,memory-safety-auditing,dynamic-analysis,fuzzing,source-code-auditing,parser-differential-auditing,sandbox-boundary-analysis,race-condition-auditing,attack-surface-mapping,authorization-auditing,binary-auditing,state-and-lifetime-auditing}/SKILL.md`.
- Not inspected (named as follow-ups, not assumed): base-image contents of `ghcr.io/usestrix/strix-sandbox@sha256:f690…` (would require pulling the image); whether a C/C++ toolchain is present for the `*`-marked fuzzing-bucket-2 calls; Triton's live-tracing submode; a real Herdr/TUI session to watch `pi.setActiveTools` actually drop `pi-web-access` at run start.
