# Reduced models and solver gates

Use only when [data-flow analysis](../SKILL.md) has located the consumed fields, relevant condition, and feasible input-to-slice gates. The question is whether a specific representation, bound, or branch invariant holds—not how to synthesize an exploit. Preserve original artifacts and keep runtime observations authorized and isolated.

## Select a mechanism

| Tool → purpose → when | Evidence boundary |
|---|---|
| A small concrete arithmetic/state model → evaluate the extracted relation cheaply → when its operations and state are already known | Preserve machine widths and byte order; unbounded host integers are not machine integers |
| Z3 bitvectors → check explicit width/signedness/wraparound constraints → for a small arithmetic or branch invariant | A model is only as complete as its constraints; specify signed versus unsigned comparison/division/shifts |
| Triton taint or concolic execution → track consumed-byte influence and constraints along execution → when a concrete trace can narrow indirect flow | Only traced/represented paths are covered; unsupported instructions or environment behavior remain gaps |
| Slice-bounded angr/Triton symbolic execution → explore a small relevant path condition → after validating slice entry state and dependencies | Starting after initialization does not prove its state is attainable; retain upstream gate evidence |

## Construct and challenge the model

1. State the invariant and contrasting expected results. Pin byte widths, signedness, extension/truncation, endianness, loop-carried state, aliasing, and input length/normalization. Do not assume independent SIMD lanes or variables just because decompiled expressions look separate.
2. Include only influence justified by the trace/use-def chain, without deleting constraints needed to reach the slice. Supply validated summaries for calls and output parameters; list omitted syscalls, callbacks, and external state explicitly.
3. Prefer direct concrete evaluation before solver work. For symbolic work, record tool version/options and explicit time, path, loop, memory, and candidate budgets. Use solver expressions for symbolic branching, not host-language `if` on symbolic truth values.
4. If a lookup/permutation stalls solving, evaluate a demonstrably bounded local relation. Retain all feasible alternatives within the budget for later checks; if capped, mark the result incomplete rather than selecting the first convenient value. A cryptographic/VM loop is a reason to recover a smaller relation, not launch unbounded process-entry exploration.
5. Check intermediate values against instructions or controlled observations. Exercise zero, boundary, truncation/wraparound, and a different valid path as applicable. Re-encode any proposed counterexample and confirm the original input path actually produces its modeled state; analysis hooks or patched guards are not acceptance evidence.
6. Return the narrowest supported conclusion and the failed assumptions. `sat` proposes a model to check; `unsat` excludes only the encoded scope; timeout, `unknown`, missing dependencies, or exhausted candidates exclude nothing beyond the recorded attempt. For C-level undefined behavior, distinguish mathematical and machine observations rather than claiming the solver represents arbitrary execution.

## Handoff and reuse

Deliver the relation, input/gate assumptions, concrete checks, solver scope and outcome, state summaries, modification ledger, and unresolved paths. Cache only with matching artifact hashes, runtime/configuration, and tool/options. Two non-discriminating attempts trigger the [start-here evidence switch](../../../README.md#start-here) toward instructions, a concrete runtime checkpoint, or format recovery—not another interpreter or a larger timeout.

A solver result is neither proof of target reachability nor a security-impact label. Hand off observed input-to-state evidence to [dynamic analysis](../../dynamic-analysis/SKILL.md) and access consequences to [memory safety](../../memory-safety-auditing/SKILL.md).

Adapted from the user's `ctf-rev` reduced-model guidance; see [supplemental provenance and limits](../../../research/TOOLING.md).
