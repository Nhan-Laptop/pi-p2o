# Format-first routing

Route by observed headers, metadata, and execution evidence—not by extension or a favorite decompiler. Identify containers, application payloads, assets, and native/managed boundaries once; reuse valid extractions. Parse copies in an isolated, resource-bounded environment. Extraction and decompilation themselves process untrusted data. Every row is optional: prefer an installed tool, treat installation as a separate decision, and substitute a supported fallback.

| Observed shape | Tool → purpose → when | Validation / next boundary |
|---|---|---|
| Ordinary native ELF/PE/Mach-O | Installed Kuna or IDA/Ghidra → recover a relevant native slice → after architecture/load mapping; binutils is the fallback | Check critical operations against instructions or runtime; use [native slice gates](native-slices.md) |
| CPython bytecode | Version-compatible `xdis`/`pydisasm` → inspect code objects and instructions → after checking magic/originating version | Header length and opcode semantics vary; partial source from a decompiler is not an authoritative reconstruction |
| PyInstaller bundle | Optional `pyinstxtractor-ng` → extract application bytecode and assets → when bundle metadata supports that format | Analyze the application, not the bootloader; preserve extraction lineage and version constraints |
| CLR/.NET assembly | Optional `ilspycmd` → inspect managed types/IL → when CLR metadata is present | `ilspycmd -l c <assembly>` lists classes; `ilspycmd -t <Namespace.Type> <assembly>` narrows analysis. Follow P/Invoke or mixed-mode boundaries separately |
| DEX/APK or supported JVM class archive | Optional `jadx` → inspect supported application bytecode/resources → after identifying DEX or Java class content | Native libraries are separate targets; obfuscation and reconstructed source need instruction/behavior checks |
| Electron/JavaScript archive | A matching archive reader/source formatter → expose the application path → when container metadata supports it | Inspect source as data; extraction does not justify executing the loader |
| Packed or runtime-only native code | GDB/LLDB/WinDbg/x64dbg → observe the transition into decoded/executable bytes → when actual loader behavior supports packing | Preserve dump ranges, protections, loader state, and original input; a dump alone is not a valid executable |
| Firmware or raw image | binwalk, ImHex, architecture documentation → identify segments and establish mapping → when normal executable headers are absent | High entropy may be compression or encryption; keep guessed memory regions explicit |
| Flattened/custom-VM code | A scoped debugger trace plus a small state model → recover a reachable dispatcher/handler contract → when the input dependency reaches that code | Recover one relevant transition before generalizing the VM; do not wait for whole-program deobfuscation |

For Go/Rust, use available runtime metadata, library signatures, demangling, and diagnostic references to locate application code. Respect pointer/length strings; not all useful text is NUL-terminated. Nuitka, native extensions, and Unity IL2CPP are native boundaries, not ordinary Python bytecode or IL; IL2CPP reconstruction needs the corresponding metadata and native image.

When rows overlap, follow dependencies: extract before auditing payloads; observe unpacking before modeling packed handlers. A runtime mismatch, parser rejection, or missing dependency is an analysis limitation—not evidence of a security flaw. Never force a raw loader merely to silence an unsupported-format error.

Avoid using execution as a format detector. Importing a Python module, loading a managed assembly, or replacing only a loader's final `exec` can still execute earlier initialization. Any necessary runtime observation belongs in an isolated [dynamic-analysis](../../dynamic-analysis/SKILL.md) experiment with an unmodified baseline.

This routing is a [supplemental adaptation](../../../research/TOOLING.md), not a new product-specific skill or a claim of independent bug reproduction.
