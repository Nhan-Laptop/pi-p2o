---
name: dynamic-analysis
description: Design minimal debugger or instrumentation experiments to resolve a static hypothesis. Use for uncertain dataflow, object lifetimes, execution paths, representation changes, or environment-dependent failures.
---

# Dynamic Analysis

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Question-directed runtime observation.

## When to Use
Static analysis leaves a specific unknown: actual type/value, handler reachability, state transition, destructor timing, path selection, or execution-policy failure.

## Goal
Which runtime observation will confirm or refute the hypothesis while minimizing changes to target behavior?

## Workflow
Unresolved question → contrasting predictions → minimal observation → matched baseline → experiment → explanation and next question.

1. Define one question and contrasting predicted outcomes. Record an uninstrumented benign baseline and one minimally changed comparison input; the [probe contract](references/runtime-probes.md) lists the required fields.
2. Verify artifact identity, actual target process/module, runtime, symbols, privileges, and feature settings. Resolve current module addresses; a file offset is not a live breakpoint address, and an unrelated worker is not the intended consumer.
3. Begin with logs, crash dumps, conditional breakpoints, watchpoints, and entry/exit arguments instead of stepping every iteration. Observe dynamically resolved pointers and their module/call site rather than reconstructing an API-name hash by default.
4. Preserve ABI, field width, encoding, thread identity, and buffer lifetime when decoding or instrumenting values. Observe effective conversion settings and values on both sides of a suspected boundary; mapping tables are predictions, not consumer observations. Bound reads and logging; do not turn an observation hook into a new memory-safety defect.
5. Capture branch/state/value evidence, timestamps, and stack context. For runtime-generated code, observe the write-to-execute or guest/host transition; save live bytes, mappings, protections, and producing state. A dump is not automatically a runnable or equivalent image.
6. Keep a modification ledger: separate results from original, debug, emulator, and deliberately altered builds, and repeat with a less invasive observer where feasible (see the [probe contract](references/runtime-probes.md)).

Time-box each probe and keep an observation/result/remaining-question ledger. Two inconclusive attempts trigger a different evidence source, per the [start-here rule](../../README.md#start-here).

Use the owned [runtime probe guide](references/runtime-probes.md) for breakpoint/script/live-code contracts and [observation signals](references/observation-signals.md) for diagnostic inference, delivery/display evidence, transient negatives and comparable worker/reset state.

## Research Heuristics
- Dynamic argument metadata and short call traces can reveal undocumented API contracts. [B074](../../research/evidence.md#b074)
- Coverage can direct manual reconstruction even when fuzzing finds no crash. [B060](../../research/evidence.md#b060), [B069](../../research/evidence.md#b069)
- A debugger attach crash, signature rejection, and breakpoint-triggered failure may be separate environmental obstacles. [B053](../../research/evidence.md#b053)
- Diagnose denied access and process/session visibility independently; an invisible process is not necessarily an unsuccessful operation. [B022](../../research/evidence.md#b022)

## Tools
- GDB/LLDB/WinDbg or x64dbg → inspect registers, fields, exceptions, conditional breakpoints, and watchpoints → when a concrete state/lifetime question remains; software breakpoints alter bytes, hardware ones are limited and detectable.
- Debugger command scripts or optional libdebug → repeat identical bounded input/breakpoint/value observations → when manual sessions drift; check platform/version support and isolate execution.
- Frida Interceptor → inspect bounded entry/exit values and argument contracts → when hooks are easier than interactive stepping; resolve symbols/offsets for the current version and consult current APIs.
- Frida Stalker → trace selected calls/blocks within a narrow window → when indirect control flow is unknown; avoid tracing the whole process by default.
- Procmon / user-mode crash dumps → explain startup/attach failures → when interactive debugging is prevented or changes behavior.
- Wireshark or syscall tracing → corroborate transport and process boundaries → when application logs hide framing, connection, or ownership details.
- TinyInst/litecov with Lighthouse → correlate executed blocks to static code → when selecting paths for manual audit.

## Validation
Use independent observations where possible: decoded arguments plus consumer behavior, application logs plus packet traces, or allocation/free stacks plus stale access. Timeout, missed breakpoint, or lack of a crash proves neither safety nor success. An assertion-disabled or patched-security-policy run only answers a counterfactual question; it does not establish unmodified-target impact.

## Common Failure Modes
Dangling instrumentation buffers (B074); invalid old offsets; altered scheduling; broad tracing overhead; partial network reads (B053); exceptional startup SIGILL expected by a library (B078); warnings dominating elapsed time (B024). Measure and explain observer effects instead of silently disabling them.

Detector silence can miss logical boundaries inside a larger allocation or composed processing path. Retain the unresolved producer–consumer assumption and investigate that boundary; do not treat missing diagnostics as preservation of the contract. [O001](../../research/orange/evidence.md#o001).

## Fix / Mitigation
Derived guidance: add structured diagnostics at state and authorization boundaries; retain security assertions and memory sanitizers. Instrumentation-only changes are not fixes. Turn the confirmed invariant into a regression test rather than shipping a diagnostic bypass.

## Handoffs
**Static → Dynamic:** require the question, call slice, contrasting predictions, probes, and modification budget. **Dynamic → Root Cause:** return original/modified artifact identities, recorded observations, rejected assumptions, uncertainty, and the narrowest remaining question. Next: the appropriate invariant skill or [exploitability assessment](../exploitability-assessment/SKILL.md).

## Evidence
B074, B053, B060, B069, B072, B075, B078, B024, B022, and B008 demonstrate these observation techniques and limitations. Generic experiment-design rules are derived synthesis.

Scripted probes, resolved-pointer observations, and live-code capture also adapt the user's `ctf-rev` guidance; [supplemental provenance](../../research/TOOLING.md) separates these tool options from the blog evidence.

[O004](../../research/orange/evidence.md#o004) adds configuration-specific conversion predictions; [O001](../../research/orange/evidence.md#o001) adds diagnostic-side-effect and detector-coverage cautions. Source reports and catalogued possibilities do not establish a local result.
