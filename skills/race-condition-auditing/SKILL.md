---
name: race-condition-auditing
description: Audit double-fetch, lock-drop, TOCTOU, and shared-state interleavings using explicit event schedules and bounded runtime evidence. Use when a checked value or object can change before use.
---

# Race-Condition Auditing

Before first use, read [focused method and review](../../HANDOFFS.md#focused-method-and-review).

## Technique
Invariant-focused interleaving analysis.

## When to Use
An operation reads mutable user/shared memory more than once, blocks while holding logical assumptions, or races with allocation, teardown, reservation, or completion.

## Goal
What feasible event ordering changes checked state before its use, and does that ordering cross a security boundary?

## Workflow
Mutable state inventory → synchronization map → invariant → event-order hypothesis → observed schedule → impact and fix.

1. List actors, shared fields, ownership, and operations. Mark each read, write, publication, reservation, invalidation, and final use.
2. Expand wait helpers, macros, callbacks, and page-fault paths. A lexical lock span may contain an implicit unlock/relock; sleeping changes the state that must be revalidated.
3. State the coupled invariant, e.g. `appendable implies a valid tail entry` or `a reserved slot has one owner`. Identify precisely which event can invalidate it.
4. Write an abstract two-actor schedule with prerequisites and synchronization edges. Include error cleanup and partial progress; concurrent execution can expose a purely sequential failure path.
5. Observe a bounded lab reproduction with event/state markers. Controlled synchronization is preferable to an unexplained timing loop. Record attempts, observed invalid states, barrier failures, and collateral faults.
6. Re-run without artificial scheduling or policy changes where feasible. Classify an instrumented possible schedule separately from reproducibility under the actual actor's capabilities.

## Research Heuristics
- Waiting can release a lock and resume with stale decisions even when simultaneous mutation is serialized. [B002](../../research/evidence.md#b002)
- Rechecking growth state after reacquiring locks can matter more than the first check. [B024](../../research/evidence.md#b024)
- A supposedly output-only user buffer can later supply pointers or metadata to privileged consumers. [B022](../../research/evidence.md#b022)
- Permission check time and operation time must agree on object identity and authorization context. [B045](../../research/evidence.md#b045)
- Lock contention, kernel features, hardware, and namespace policy can invalidate an initially demonstrated path. [B003](../../research/evidence.md#b003)

## Tools
- Source/disassembly expansion → expose hidden lock and wait behavior → when helpers obscure synchronization.
- Debugger event logging, watchpoints, and thread traces → observe state/order changes → when testing a concrete schedule; run the diagnostic build as an in-sandbox lab recipe (environment build plus verification) or as ordinary sandbox commands, and record a refused attach as the specific blocked fact.
- KASAN plus allocation/free context → identify the first invalid access → when memory safety is affected; kernel KASAN needs a specially built kernel that the sandbox's shared host kernel cannot provide, so record that specific refusal as the blocked fact.
- Kernel tracing/kprobes in a permitted diagnostic build → measure blocking and warning costs → when reproduction latency is unexplained; report all changes and do not treat instrumentation as an available attacker capability. The sandbox container is root but shares the host kernel, cannot load modules and has no host kernel-tracing privilege; record that specific refusal as the blocked fact rather than assuming a lab outside the sandbox.

## Validation
Require the violated invariant and feasible ordering, not just a crash rate. Validate every actor's access and configuration. Compare serial and concurrent negative controls. Report successes/attempts, latency distribution, and stability after the observation; debugger-induced timing and suppressed diagnostics can change both reachability and reliability.

## Common Failure Modes
Assuming a lock is never dropped (B002); treating an instrumented precise edit as the same primitive as a wider real write (B022); interpreting warning/logging delay as race failure (B024); depending on fault-stalling mechanisms unavailable in the actual container (B045). Correctness races with no established security impact remain such (B064).

## Fix / Mitigation
B002 and B024 motivate revalidation/consistent state after waits; B026 illustrates shared-memory double-fetch risk. Derived guidance: copy untrusted values once into trusted storage, use that snapshot consistently, reserve resources before publication, and restore coupled fields on every failure path. Do not rely on sleeps, timing, or volatile qualifiers as synchronization.

## Handoffs
**Race Audit → Root Cause/Impact:** provide actor capabilities, invariant, event schedule, lock/wait map, state trace, reproduction denominator, observer effects, and first invalid operation. Route byte consequences to [memory safety](../memory-safety-auditing/SKILL.md), capabilities to [exploitability assessment](../exploitability-assessment/SKILL.md). For a stated usage ceiling (wstg-busl-05), use [usage limit bypass](references/usage-limit-bypass.md).

## Evidence
B002, B003, B022, B024, B026, B043, B045, and B064 merge wait/drop, double-fetch, authorization-time, and reservation races. Schedules here are abstract research artifacts, not article-specific trigger sequences; [On demand upstream text](references/wstg-source.md).
