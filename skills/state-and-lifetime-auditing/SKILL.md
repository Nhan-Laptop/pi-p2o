---
name: state-and-lifetime-auditing
description: Audit ownership, reference counts, transaction phases, asynchronous callbacks, and lifecycle transitions. Use when objects remain discoverable after teardown or operations can observe inconsistent state.
---

# State-and-Lifetime Auditing

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Technique
Ownership graphs plus transition invariants.

## When to Use
The subsystem has shared objects, deferred work, nested resources, handles, rollback, completion, or separate logical removal and physical destruction.

## Goal
Can a reference or operation survive the object's valid lifetime or a transition that makes its state unusable?

## Workflow
Object graph → state machine → acquisition/release ledger → transition paths → stale-reference hypothesis → observed lifecycle → invariant repair.

1. Draw owners, borrowers, registries, containers, handles, callbacks, and workers. Distinguish parent liveness from child-resource liveness.
2. Enumerate states and allowed operations: publication, reservation, commit, rollback, cancellation, logical deletion, unlink, final close and destruction. Include companion state required for policy decisions: when each becomes visible/valid, the missing-state rule, and transaction/synchronization boundaries. Incomplete publication first raises a transition/policy question; race classification needs feasible ordering evidence.
3. Track reference acquisitions/releases and pointer invalidation on normal, failure, duplicate, and abort paths. Record the synchronization/lifetime mechanism for each edge.
4. Compare equivalent lookups and operations: name versus identifier, current versus next generation, perfect versus imperfect branch, reserve versus complete. State validity must be checked by every consumer.
5. Test safe sequences and injected failures in a lab. Observe when objects stop being discoverable versus when their storage is reclaimed; do not assume asynchronous work has completed.
6. Describe the earliest invariant violation, subsequent reachable use, and any protective barrier. Separate a warning-producing state inconsistency from a demonstrably stale dereference.

## Research Heuristics
- Parent weak references do not prove nested resources remain valid across callbacks. [B067](../../research/evidence.md#b067)
- Last user handle cleanup can precede final object-reference close and outstanding-I/O completion. [B021](../../research/evidence.md#b021)
- Transaction abort and asynchronous destruction can overlap; generation/lookup validity is a separate contract from object existence. [B043](../../research/evidence.md#b043)
- Buffer selection deferred until completion can give simultaneous operations the same supposedly reserved buffer. [B064](../../research/evidence.md#b064)
- RCU-protected readers require a compatible reclamation discipline, not merely a nominal lock elsewhere. [B003](../../research/evidence.md#b003), [B047](../../research/evidence.md#b047)

## Tools
- Source/call-graph review → enumerate ownership and cleanup edges → before attempting a lifetime reproduction.
- WinDbg/GDB/LLDB breakpoints and allocation/free stacks → observe lifetime transitions → when static ownership is ambiguous; all three need live process attach, which a p2o sandbox blocks — use a separate authorized lab environment.
- KASAN/Page Heap/GuardMalloc → identify stale accesses and nearby allocation history → when supported by the lab build; that lab build is necessarily outside the sandbox (Page Heap is Windows-only, GuardMalloc macOS-only, KASAN needs a specially built kernel).
- Small operation-sequence tests → exercise commit/abort, repeat, cancel, and final-close cases → when byte mutation alone cannot cover state transitions.

## Validation
Confirm the stale reference's identity, the invalidating transition, actual destruction or state invalidation, and subsequent use. A surviving reference with valid lifetime protection is not a UAF. A warning blocked before free is not a confirmed memory-corruption primitive. After instrumented proof, test the original lifecycle and actor constraints.

## Common Failure Modes
Assuming commit means immediate destruction; counting user handles instead of all references; missing callback-owned pointers; assuming allocator reuse immediately after an RCU release. B043 found a warning-only path blocked before useful frees; B064 demonstrated corrupted reads but left security impact unresolved; B023 observed deferred reclamation constraints.

## Fix / Mitigation
Source-supported patterns include delaying release to final close (B021), state-validity checks at alternate lookups (B043), and browser-side request-state checks (B067). Derived guidance: pair ownership changes atomically, revoke registries/borrowers before destruction, hold appropriate references across callbacks, and make rollback restore the same invariant as commit. Do not terminate a peer for a locally caused transition without tracking provenance.

## Focused Method
Preserve state generation, event order, failed assumptions and the smallest next observation. Report partial publication separately from stale use; a timing hypothesis does not authorize parallel or race testing. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review).

## Handoffs
**Lifetime Audit → Race Audit:** provide the object graph, transition ledger, synchronization gaps, and proposed event ordering. **Discovery → Impact:** provide confirmed invalidated reference, use type, barriers, actor/configuration, and reproduction evidence. Next: [race auditing](../race-condition-auditing/SKILL.md) or [exploitability assessment](../exploitability-assessment/SKILL.md).

## Evidence
B021, B031, B043, B064, B067, B003, B047, B062, B079, and B080 contribute lifecycle and observer constraints; no replacement-object or UAF exploitation recipe is retained.

[O037](../../research/orange/evidence.md#o037) motivates coherent publication of object and required policy state. Intended missing-state policy belongs to authorization review; no source timing schedule or race result is independently verified here.
