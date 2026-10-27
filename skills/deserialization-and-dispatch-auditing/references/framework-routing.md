# Framework resolution and phase-specific behavior

Use with [dispatch auditing](../SKILL.md) when input selects behavior through conventions, returned objects, fallback handling, or preparation hooks. Supported generic observations are recorded in [O015](../../../research/orange/evidence.md#o015), [O021](../../../research/orange/evidence.md#o021), [O022](../../../research/orange/evidence.md#o022), and [O024](../../../research/orange/evidence.md#o024). The library records their routes and object chains for orientation; you still build and run your own against the target.

## Model the effective selectable set

Inventory explicit registrations **and** naming conventions, eligibility/visibility rules, actual receiver types, eligible inherited members, defaults, and unmatched-input delegation. Built-in help is an inventory source, not exhaustive dispatch evidence. A root allowlist or advertised operation does not necessarily constrain the eventual receiver and action.

Follow one relevant receiver/value transition far enough to identify the next consumer and independent checks. A permitted operation can return data that another interpreter treats as behavior. Record the return's provenance and expected inert-data contract; do not turn the resulting graph into an invocation sequence. Determine real type relationships rather than adopting broad language slogans or assuming every inherited method is eligible.

## Associate a guard with its phase

Record `phase | input-controlled selector | hook/adapter | available dependencies | execution identity | guard | evidence`. Initialization, conversion, parsing, compilation, reconstruction and ordinary execution can have different callback or dependency environments. A guard active during ordinary execution does not prove containment during earlier preparation. A standalone demonstration cannot substitute for the integrated application's dependency and policy state. [O021](../../../research/orange/evidence.md#o021).

Likewise, trace failure-response writes to selectors and actual continuation. An error intended to terminate processing may leave changed metadata available to later dispatch; this is a question about terminal-state and behavior-selection contracts, not proof that every error path is exploitable. [O005](../../../research/orange/evidence.md#o005).

## Tool selection and bounded corroboration

| Tool → purpose → when | Limit |
|---|---|
| Framework documentation plus source/call hierarchy → determine resolution rules and eligible receivers → before assuming URL or selector names map directly to functions | Documentation, advertised help and actual implementation can differ |
| Local introspection/decompiler → inspect actual receiver types, inheritance, hook arity and defaults → when runtime metadata is necessary | Match the installed runtime and artifact; visibility is not actor reachability |
| Debugger or harmless callback marker → record selected behavior, phase and identity → when static dispatch or implicit conversion remains uncertain | Do not disable guards or use a gadget catalogue as acceptance evidence |
| Dependency and policy inspection → establish which hooks and checks exist in each phase → when a standalone result differs from integration | Missing dependencies leave the integration check unproven; record the gap |

Choose an intended allowed operation as a control. Compare receiver/phase/check evidence rather than success codes alone. A theoretical callable path, inaccessible return, error response, or surviving action check supports only its recorded scope. Stop unexpected sensitive disclosure and retain the failed observation.

## Question-directed handoffs

- Unknown selected receiver or prerequisite → [source](../../source-code-auditing/SKILL.md) / [data flow](../../data-flow-analysis/SKILL.md), with the smallest resolution slice and actual eligibility rules.
- Entry admission versus effective action permission → [authorization](../../authorization-auditing/SKILL.md), with receiver/action, policy expectations, independent gates and denied controls.
- Preparation behavior outside a claimed runtime guard → [sandbox analysis](../../sandbox-boundary-analysis/SKILL.md), with phase/guard coverage, dependency configuration, execution identity and remaining confinement layers.
- Confirmed unexpected behavior → [impact assessment](../../exploitability-assessment/SKILL.md), with its constrained capability, the links you actually built and the prerequisites still missing.

Reject packets missing the receiver, phase, actual guard, or classification of inferred edges. Request [compiler-invariant analysis](../../compiler-invariant-auditing/SKILL.md) only if an inferred fact, reachable invalidator and unsound consumer are identified—not merely because compilation is involved. Handoffs and observer choices here are derived library contracts; source outcomes remain author reports.
