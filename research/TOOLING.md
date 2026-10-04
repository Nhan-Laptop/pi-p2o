# Supplemental reverse-engineering tooling

## Source and evidence boundary

At the user's request, the library incorporates reusable analysis improvements from the locally installed **pi-ctf-solver `ctf-rev`** skill, reviewed **2026-09-30**. These are methodology/tool-selection adaptations, not additions to the STAR Labs article corpus or independently measured performance results. The original 81-entry / 65-method-source corpus, citations, and dispositions remain unchanged.

The reviewed skill and its method guides are credited below by document title and content hash, **not external file paths**. This is provenance only: researchers should use the library-owned guides linked in the next section. No copied challenge constants, solve scripts, flag instructions, checker bypasses, or benchmark claims were imported.

| Reviewed document | SHA-256 at review | Relevant sections |
|---|---|---|
| Reverse engineering: shortest verified route | `ee1737acdb978df93552252a19e3d3705957bf12063b1b704339478d571e084e` | First useful turn; Route by observed shape; Native fast path; Reduce, solve, verify |
| Static analysis: select a useful slice | `05f1c0447dd30eac3ec5afe1e420ae97844a713b04ab4b2bdb715dc07afabe01` | Optional headless decompiler; Binutils fallback; Choose the anchor; Model boundaries |
| Dynamic analysis | `c1d53072f69016d8b9bac6f010dc08cb6019e0e2fcfc17142765d17711a8bcc9` | Baseline and containment; Breakpoints and watchpoints; Scripted debugging; Runtime-generated code; Dynamic API resolution |
| Managed and script targets | `1519a722ad40729816df8e607fad7eb7eff702871ba22a8deee5ef840fcce878` | Python bytecode and bundles; .NET and Unity; Other containers and languages |
| Symbolic execution and constraint solving | `a9278e52b4d36fcab2606b8e02793250c4f07769de090a18b5dbe2ef7917c69f` | Solver configuration; Choose the right mechanism; Taint analysis; Path explosion; Verification |
| Unpacking | `dc172f21283cb9429c5236bb5d9c5de1084c908a344a33cbad7a5deaf7c972e3` | Runtime-code observations and dump verification; no bypass operations retained |

## Adaptation ownership

| Existing skill | Improvement | Focused reference |
|---|---|---|
| [Binary auditing](../skills/binary-auditing/SKILL.md) | Format-first application routing, one useful anchor, optional Kuna batches, per-target coverage gates, cached outputs | [Native slices](../skills/binary-auditing/references/native-slices.md), [format routing](../skills/binary-auditing/references/format-routing.md) |
| [Dynamic analysis](../skills/dynamic-analysis/SKILL.md) | Uninstrumented baseline, debugger scripts/libdebug, conditional/watchpoint selection, resolved pointers, live-code evidence | [Runtime probes](../skills/dynamic-analysis/references/runtime-probes.md) |
| [Data flow](../skills/data-flow-analysis/SKILL.md) | Triton taint/concolic observations, narrow angr paths, explicit solver and entry-state scope | [Reduced models](../skills/data-flow-analysis/references/reduced-models.md) |
| [Memory safety](../skills/memory-safety-auditing/SKILL.md) | Z3 bitvectors, exact arithmetic/loop/SIMD semantics, original-path counterexample checks | Reuses reduced models rather than duplicating solver guidance |
| [Patch diffing](../skills/patch-diff-analysis/SKILL.md) | Same tool/options and matched bounded coverage on both revisions | Reuses native-slice gates rather than treating partial output as a semantic delta |

The research handoff carries tool/options and requested-versus-returned scope. Two uninformative probes prompt a change of evidence source; this is an efficiency heuristic, not a mandatory cap on a justified investigation. Deadline examples are initial budgets, not universal time guarantees.

## Tool verification limits

Kuna was **not installed in this environment** at review. Its CLI patterns are adapted from the inspected `ctf-rev` guidance and must be checked against an installed version's help; no Kuna runtime or benchmark result is claimed. Optional libdebug, ILSpy, jadx, xdis, angr, Triton, and Z3 integrations are selection guidance, not executed integrations or mandatory dependencies. No tools were installed, and no target was run or exploited for this update.

The installed binutils fallback and repository quality gates are checked separately; [tooling checks](tooling-checks.txt) records the exact commands/results. Those receipts establish the selected benign static fallback and artifact consistency—not the performance or correctness of absent tools, current product vulnerabilities, or a complete binary audit.
