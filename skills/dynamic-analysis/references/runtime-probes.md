# Minimal runtime probes

Read with [dynamic analysis](../SKILL.md). Investigate one unresolved contract on the artifact in a recovery-capable lab. Networking stays disabled unless the declared experiment needs a network path, and then it runs through the sandbox network tool. Instrumentation observes behavior; it does not authorize bypasses or establish unmodified-target impact.

## Observation contract

Record artifact/input hashes, runtime/configuration, the actual process/module, one question, two contrasting predictions, and the expected event. First collect an uninstrumented benign baseline: exit status, stdout/stderr, environment, and accepted input behavior. Fix the same variables for the observed run. A stopped process, missed breakpoint, or timeout is an unresolved observation—not a safety result.

## Select the least invasive observer

| Tool or probe → purpose → when | Caveat |
|---|---|
| Logs, crash dumps, or syscall/transport traces → locate the actual consumer and boundary → when the event is already externally observable | Logs may omit state; packet framing and partial reads need independent decoding |
| GDB/LLDB/WinDbg/x64dbg conditional breakpoint → capture arguments/state at an artifact-derived site → when the relevant branch or handler is known | Software breakpoints change code bytes; match current module and relocated address |
| Debugger watchpoint → identify the first read/write of a field → when stepping an entire loop would add noise | Hardware slots are limited; size/alignment and read/write support depend on platform; debugger fallbacks can alter timing |
| Debugger command file or optional libdebug → replay the same observation and bounded input → when manual sessions differ | Check supported platform/ABI/API; bound waits, memory reads, trace size, and child-process cleanup |
| Minimal Frida Interceptor hook → record entry/exit values with current symbols/addresses → when scriptable call observation is simpler | Pin ABI and buffer lifetime; modifications form a separate configuration, not an accepted result |
| Narrow Frida Stalker/block coverage → identify one indirect transition → when call targets remain unknown | Whole-process tracing can dominate runtime and change scheduling |

For GDB, `info files`, `info threads`, and `bt` establish module/thread/stack context; `info registers` and a bounded `x/<count>bx <observed-address>` inspect the actual decision state. Substitute only artifact-derived addresses and finite counts. On another debugger use equivalent commands, not GDB syntax by assumption. Avoid automated structure decoding until pointer width, layout, ownership, and bounds are corroborated.

## Runtime-only boundaries

For dynamically resolved calls, observe the resolution result and record resolved name/address, module base, call site, and actual arguments. Following that pointer may answer the question without reversing a name-hash routine. Address values and mappings must be refreshed when the process or artifact changes.

For decoded, generated, or translated code, observe the write-to-execute or guest/host handoff. Record the producing state, byte range, protections, mapping identity, and instruction pointer; distinguish translator execution from the guest operation. A memory dump is evidence of those bytes at that time, not automatically a runnable image. Any reconstruction needs original/derived hashes and behavior comparisons on the same benign inputs.

## Reproducibility gate

Save input, probe sites, selected values, expected/actual events, stdout/stderr, tool/options, elapsed limits, and all observer changes. Compare intermediate state and one relevant boundary or different valid path; a single matching output does not validate an entire model. Repeat without hooks, or with a less invasive observer, when feasible. If policy changes are necessary for a diagnostic build, report only that counterfactual scope and do not hide the change.

Two non-discriminating probes trigger the [start-here evidence switch](../../../README.md#start-here): move to instructions, a more precise observation site, or a smaller format/state model rather than repeating broader tracing after a timeout returned nothing. Return the observed contract, rejected assumptions, and remaining uncertainty through [H2](../../../HANDOFFS.md#h2--static-analysis--dynamic-analysis).

These are library-owned generic observation patterns, adapted from the technique themes credited in [supplemental provenance](../../../research/TOOLING.md); no external skill guide or helper is needed.
