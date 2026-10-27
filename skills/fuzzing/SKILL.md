---
name: fuzzing
description: Build and validate stateful, format-aware fuzzing harnesses, choose meaningful corpora and oracles, and hand crashes to manual audit. Use for parsers, protocol handlers, emulated devices, or complex storage formats.
---

# Fuzzing

Before first use: [scope baseline](../../README.md#start-here), [handoff method](../../HANDOFFS.md#focused-method-and-review), and [owner review](../../HANDOFFS.md#provisional-owner-review).

## Technique
Harness-validity-first exploration.

## When to Use
A reachable parser or stateful consumer has too many input combinations for manual tests. Fuzz reachable targets in isolation, with recovery and resource limits recorded.

## Goal
Can a faithful harness explore relevant states and produce reproducible evidence of an invariant violation?

## Workflow
Consumer boundary → valid seed and state → harness equivalence → guided mutation → oracle → minimize/deduplicate → manual root cause.

1. Select a processing unit, not merely a function name. Record required initialization, accepted input framing, dependent resources, and reset semantics.
2. Capture/generate valid samples through real APIs. Include semantically diverse features, nested structures, and combinations; byte entropy alone is not corpus quality.
3. Validate a dry run reaches the intended consumer. Compare harness and real execution before investing in mutations; preserve partial reads, callbacks, and asynchronous work.
4. Reset every iteration's relevant state and prove repeated seeds have stable behavior/coverage. Bound runtime, memory, logs, and queued work.
5. Mutate the dimensions controlling the chosen path. Preserve outer format gates when investigating inner parsing, but retain a separate campaign for those gates: rejecting all setup failures can hide bugs there.
6. Choose an oracle: sanitizer/guard fault, violated state invariant, differential result, or abnormal resource growth. Coverage growth is not a vulnerability oracle.
7. Save original seed, mutation, operation sequence, reset state, crash/logs, build identity, and reproduction count. Minimize while preserving the same root cause; cluster by violated invariant and allocation/free context, not stack address alone.

## Research Heuristics
- Replacing an input-transfer boundary can make a device consumer file-driven; validate that the replacement does not remove real races or validation. [B081](../../research/evidence.md#b081)
- Valid setup can act as a coarse inner-parser gate; feature-rich samples reach combinations simple corpora miss. [B028](../../research/evidence.md#b028)
- Coverage-producing text mutations may aid reverse engineering while missing font-structure defects. [B060](../../research/evidence.md#b060)
- Emulator findings require real-device confirmation before claiming hardware reachability. [B018](../../research/evidence.md#b018)

## Tools
- AFL/AFL++ → coverage-guided mutation and corpus exploration → when a faithful repeatable harness can expose inputs and coverage.
- QEMU → run architecture-specific firmware/protocol consumers → when native execution is unavailable; model required environment and validate on hardware.
- Jackalope / AFL-Frida → instrument binary coverage → when source recompilation is impractical; choose based on measured stability for this target.
- Page Heap, GuardMalloc, or KASAN → make otherwise latent memory violations observable → when that allocator/platform is supported; keep production-equivalence tests separate.
- WinDbg/LLDB/GDB and coverage visualization → preserve fault state and guide manual analysis → when crashes are duplicated, shallow, or absent.

These options are optional; confirm availability, platform support and measured stability before relying on one.

## Validation
Prove valid seeds reach intended states, stable reset, faithful framing, and repeatable fault/invariant behavior. Report executions, coverage, unique root causes, and reproduction counts separately. A crash in the harness or only with an unrealistic input transfer is not target proof. A crash-free campaign establishes only tested coverage, not absence of vulnerabilities.

## Common Failure Modes
Shallow crashes block deeper exploration (B028); mutating only one input dimension misses the relevant format (B060); dropping sequential network reads invalidates a snapshot harness (B053). Preserve known crashes in a regression queue; any local triage patch must be logged and later validated against the original artifact.

## Fix / Mitigation
Derived guidance: add format-aware boundary and feature-interaction regression tests; repair root causes rather than suppressing crashes; keep fuzzing initialization/reset contracts reviewed as production code evolves.

## Handoffs
**Fuzzing → Manual Audit:** require seed lineage, minimized input/sequence, coverage, original reset state, build/configuration, sanitizer report, and allocation/free or state trace. Reject a handoff consisting only of a crash address. Next: [memory safety](../memory-safety-auditing/SKILL.md) or [state/lifetime auditing](../state-and-lifetime-auditing/SKILL.md).

## Evidence
Merged harness construction (B081, B028), coverage-led exploration (B060, B069), framing failure (B053), and emulator-to-hardware validation (B018). B018 is a short author report, not a fully documented campaign.
