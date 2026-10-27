---
name: memory-safety-auditing
description: Audit numeric representations, buffer ranges, initialization, allocator/lifetime constraints, and crash provenance. Use to distinguish structural validity from safe memory access without developing an exploit.
---

# Memory-Safety Auditing

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Representation-to-access invariant checking.

## When to Use
Native code handles untrusted lengths, offsets, indices, nested structures, copies, page mappings, or asynchronously consumed pointers.

## Goal
Does every access stay within the correct live, initialized object after all arithmetic and transformations?

## Workflow
Input representation → arithmetic/type model → allocation and ownership → access bounds → observed first violation → consequence constraints.

1. Write down bit widths, signedness, endianness, units, and conversions. Distinguish bytes, elements, pages, encoded lengths, terminators, and headers.
2. Model the complete allocation/access expression: addition, multiplication, underflow, truncation, alignment and capacity. Pair sizing and emission passes: compare input-class predicates, units and emitted extents, requiring the estimate to cover actual output. Check both bounds; preserve loop-carried state and determine whether SIMD lanes share it.
3. For an access of length `n` at offset `o` in capacity `c`, require `o <= c` and `n <= c - o` after validating representations; avoid overflow-prone `o + n` checks. This formula is derived defensive synthesis, not copied patch code.
4. Verify each consumer independently. Passing checksum/type/container validation does not prove a later copy or index fits. Include zero-length, early-success, partial-initialization, and error paths.
5. Identify the actual allocator/cache, lifetime, page mapping, and object extent in the tested configuration. Catalog user-reachable allocation families by shared allocation domain, size, controlled fields, input alphabet, lifetime, and cleanup behavior; compatibility remains a hypothesis requiring observation. Observe the first invalid access, not merely the final crash.
6. Classify read/write direction, width, controllable subset, transformations, repetition, and neighboring damage. Characterize the allocator so a replacement layout can be built: construct it against the target, run it, and record the layout and the furthest effect observed rather than stopping at the description.

## Research Heuristics
- A complete required argument count can include terms omitted by a superficially plausible multiplication check. [B077](../../research/evidence.md#b077)
- Structured input validation and fixed destination bounds are distinct contracts. [B034](../../research/evidence.md#b034)
- Reallocation may add uninitialized fields later read asynchronously. [B076](../../research/evidence.md#b076)
- Read/write API names do not describe host-memory direction; trace the actual source and destination. [B081](../../research/evidence.md#b081)
- Input termination and allocation arithmetic may be separately patched; external input-size ceilings can make a suspected overflow unreachable. [B031](../../research/evidence.md#b031)
- A user-facing action may reuse an identical-value object instead of allocating; verify feature flags, allocator accounting, input alphabet, and reference-counted lifetime. [B046](../../research/evidence.md#b046)

## Tools
- Disassembler/decompiler plus format documentation → reconstruct actual widths and access expressions → when source types or layouts are uncertain; `readelf`/`objdump`/`nm`/`strings` run fine in a p2o sandbox, but an interactive decompiler (IDA/Ghidra GUI) needs a separate environment with a display.
- KASAN/Page Heap/GuardMalloc → expose first invalid accesses → for supported lab builds; coverage and sanitizer blind spots remain explicit; that lab build is necessarily outside the sandbox (Page Heap is Windows-only, GuardMalloc macOS-only, KASAN needs a specially built kernel).
- WinDbg `!pool`/heap inspection or libslub → identify allocator classes and allocation history → when adjacency/lifetime assumptions affect assessment; both need live process attach, which a p2o sandbox blocks — use a separate lab environment.
- Small concrete models or optional Z3 bitvectors → compare intended bounds with exact width/signedness/wraparound semantics → for a reduced arithmetic relation, using [model and counterexample checks](../data-flow-analysis/references/reduced-models.md) before runtime tests.
- Debugger watchpoints and allocation/free stacks → distinguish overwrite, replacement, and stale reuse → when a final crash hides the earlier cause; needs live process attach, which a p2o sandbox blocks — use a separate lab environment.

## Validation
Correlate the failing instruction with the input-derived expression, live object size, and allocation/free history. Use minimal lab observations and valid negative controls. Reject a hypothesis if a preceding size/type check, unreachable input ceiling, or allocator separation prevents the proposed access. Debug builds and heap instrumentation alter layout; production-equivalent consequences require separate evidence.

## Common Failure Modes
Overflow lands only in padding (B026); single-shot size-class constraints and collateral damage limit reliability (B040); image preprocessing changes controllable bytes (B073); object updates replace allocations (B034); guard tooling can miss classes of overruns (B069). A read fault is not automatically information disclosure or code execution.

## Fix / Mitigation
Source lessons include complete count validation (B077), destination-copy bounds (B034), and proper termination/overflow checks (B031). Derived guidance: use checked arithmetic, initialize newly allocated fields, preserve mapping/permission invariants, and adopt safer interfaces. Mitigations such as allocator separation and CFI reduce possibilities but do not repair invalid access.

## Handoffs
**Crash → Root Cause:** deliver minimized input class/sequence, first invalid instruction, arithmetic model, allocation history, valid negative control, and build identity. **Bug → Impact:** deliver the constrained primitive and collateral effects, not a blanket arbitrary-read/write label. Next: [exploitability assessment](../exploitability-assessment/SKILL.md).

## Evidence
B031, B034, B040, B046, B069, B073, B076, B077, B078, B080, B081, B028, B004, and B030 support representation, initialization, allocator, permission, and consequence lessons.

Reduced-model checks and state-coupling cautions additionally adapt `ctf-rev`; see [supplemental tooling provenance](../../research/TOOLING.md). Solver output alone is not reachability or impact evidence.

[O018](../../research/orange/evidence.md#o018) contributes the paired sizing/emission question; additional test classes and safe controls are derived, not author-performed regressions.
