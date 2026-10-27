---
name: binary-auditing
description: Route native executables, managed bundles, and firmware to the right analysis layer. Recover memory maps and interface contracts with bounded code slices when source, symbols, or format documentation is missing.
---

# Binary Auditing

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Evidence-led reconstruction of binary contracts.

## When to Use
An executable, driver, appliance image, or firmware dump is the available artifact. Acquire and test copies of the artifact; preserve originals.

## Goal
What code and data implement the reachable interface, and which reconstructed types or state assumptions still need runtime confirmation?

## Workflow
Artifact provenance → format/architecture → load map → entry/dispatch recovery → minimal type model → runtime corroboration.

1. Preserve originals, record acquisition method and hashes, and inventory once. Reuse verified extractions; bound untrusted parsers and keep target execution isolated.
2. Establish format/runtime, architecture, endianness, pointer width, load addresses, and dependencies. Analyze managed application code rather than its native launcher; raw images need a justified memory map. Use [format routing](references/format-routing.md) only for the observed shape.
3. Choose one useful anchor: an input consumer, diagnostic reference, dispatch registration, comparison, or live instruction pointer. Imports and companion libraries can expose handlers; startup metadata alone does not identify application logic.
4. Recover the smallest relevant slice with an installed tool; batch related functions instead of repeatedly loading the image. Follow [bounded native analysis](references/native-slices.md); missing tools call for a fallback, not an unplanned installation.
5. Infer counts, discriminants, ownership, and layout from use sites. Compare provisional upstream correspondence and registration tables with the shipped instructions; record modifications and confidence. Check widths, signedness, wraparound, aliases and calling conventions. Component enumeration position is not identity: corroborate the actual selected component. Generated types and boundaries remain hypotheses.
6. When static output conflicts with execution, check live bytes, image base, instruction alignment, and runtime-generated code. Apply the [start-here two-attempt rule](../../README.md#start-here) rather than merely increasing the timeout.
7. Corroborate a benign handler and selected fields dynamically. Save hash/tool/options, requested versus recovered coverage, failures, and unresolved fields; retain hardware/emulator/debug/production distinctions.

## Research Heuristics
- Companion libraries can reveal an undocumented driver contract without recovering the entire storage format. [B028](../../research/evidence.md#b028)
- Memory-map and compression reconstruction must precede meaningful cross-reference analysis of raw firmware. [B014](../../research/evidence.md#b014)
- Similarity tools may report changed strings as well as functions; combine diffs with caller references. [B075](../../research/evidence.md#b075)
- Model callback/object-dispatch tables and interface definitions together, rather than assuming all callable behavior is documented. [B031](../../research/evidence.md#b031), [B070](../../research/evidence.md#b070)

## Tools
- `file`, `readelf`, `nm`, `strings`, and range-bounded `objdump` → classify artifacts and locate/disassemble a relevant anchor → before or instead of native decompilation; match architecture and format.
- binwalk → identify embedded/compressed components → when triaging firmware copies; review extraction output rather than executing bundled files.
- ImHex plus a small declarative format model → test segment/offset hypotheses → when a container lacks documentation.
- IDA/Ghidra → recover call graphs, dispatch tables, and typed accesses → after setting the correct load map.
- Optional Kuna CLI → recover a selected native function or small related batch without a GUI → when installed and format-supported; use [slice templates and coverage gates](references/native-slices.md).
- `ilspycmd`, `jadx`, or version-compatible `xdis`/`pydisasm` → inspect application IL/bytecode rather than a launcher → when runtime metadata justifies the [managed/script route](references/format-routing.md).
- Architecture-matched GDB/gdbserver or WinDbg/LLDB → corroborate reconstructed fields and control flow → when a static interpretation remains uncertain.
- flashrom/OpenOCD → obtain permitted flash/runtime observations → on lab hardware you control, after validating electrical levels and recovery options.

## Validation
Require corroboration for every important type/address: another use site, valid sample, documentation, or runtime observation. Check returned slice coverage and errors, not exit status alone; absent output and timeouts remain unresolved. Reuse outputs only while artifact, tool/options, and configuration match. Firmware reachability requires device evidence beyond emulator-only faults; a debug-access failure is not a vulnerability.

## Common Failure Modes
Wrong endianness or base yields plausible but false code; optimized macros hide operations; debug attach may trigger hardening; hardware halts may trigger watchdog resets. [B014](../../research/evidence.md#b014), [B079](../../research/evidence.md#b079), [B078](../../research/evidence.md#b078). Reconstruct narrowly instead of spending the entire budget documenting a complex format.

## Fix / Mitigation
Derived guidance: document interface contracts, validate firmware authenticity and rollback policy, apply bounds at consumers, and restrict unnecessary debug interfaces. Diagnostic builds should remain separate from deployed security policy.

## Handoffs
**Binary Reconstruction → Audit:** deliver hashes, architecture/load map, entry-to-handler references, inferred structures with confidence, sample accepted inputs, and runtime discrepancies. Route unresolved values to [dynamic analysis](../dynamic-analysis/SKILL.md), semantic input paths to [data-flow analysis](../data-flow-analysis/SKILL.md).

## Evidence
B014, B028, B031, B070, B075, B078, and B079 support this reconstruction method; the teardown entry B044 is catalog context, not retained bug evidence.

Format routing, bounded-tool selection, and retry rules are supplemental adaptations from the user's `ctf-rev` methodology, not new STAR Labs evidence. See [provenance and verification limits](../../research/TOOLING.md).

[O018](../../research/orange/evidence.md#o018) adds provisional upstream/handler correspondence; [O078](../../research/orange/evidence.md#o078) separates component identity from enumeration order. No source binary, loader or repair recipe is imported.
