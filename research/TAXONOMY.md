# Taxonomy and Deduplication Decisions

## Unit of knowledge

A skill owns one **research question, decision artifact, and validation gate**, not a product, CVE, tool, exploitation primitive, or article. Equivalent procedures are merged across web applications, firmware, drivers, hypervisors, and language engines. Source-specific facts and caveats stay in the evidence ledger.

## Boundaries that prevent duplication

| Boundary | First skill owns | Neighbor owns |
|---|---|---|
| Recon / source audit | Reachable interface and actor map | Candidate slices and invariant hypotheses |
| Source / data flow | Audit strategy and wrapper discovery | Proof of input influence and feasible gates |
| Binary / dynamic | Architecture, load map, inferred contract | Runtime test of a particular uncertainty |
| Patch / remediation | What changed and why; artifact applicability | Complete repair, regression scope, rollout |
| Parser / memory | Meaning differs between representations/consumers | Arithmetic, capacity, initialization, access validity |
| State / race | Ownership and transition invariants | Feasible ordering that invalidates an assumption |
| Memory / impact | First invalid access and constrained primitive | Supported boundary consequence and capability gaps |
| Authorization / sandbox | Identity and actor–action–object policy | Independent confinement layers and broker capability |
| Dispatch / parser | Data selects behavior, inherited/nested callbacks | Data interpretation and canonicalization disagreement |
| Compiler / memory | Facts/guards across phases and side effects | Resulting native access and consequence constraints |

Shared prerequisite checks are intentional. Repeated investigation logic is not copied into each skill; handoff links move the artifact to its owner.

## Normalization examples

- Source-to-sink manual review, output-argument use-def analysis, stored configuration, and indirect object dispatch are one **data-flow** method (B068, B070, B001, B006, B063).
- URL authority, decoded deep links, protocol length packing, ordered filename filters, and font metadata validate/consume discrepancies share **parser differentials** (B048, B058, B009, B068, B069).
- Final close, deferred transaction destruction, parent/child callbacks, table replacement, and RCU discipline share **state/lifetime** invariants (B021, B043, B067, B079, B003).
- Numeric range, effect-chain shape, lazy-reparse identity, and internal exception state share **compiler phase** validity (B061, B055, B008, B057).
- Restricted renderer IPC, OS job/desktop restrictions, application seccomp, local browser-control services, and container LSM policy share **sandbox boundary** composition (B027, B022, B023, B072, B045).
- Allocator/cache characterization, constrained writes, timing, padding, and failed stronger impacts inform **memory safety / impact assessment**, not a heap-spray or exploit-development skill (B046, B004, B040, B026, B065).

## Explicit merge/exclusion decisions

- **B038 → B037:** the short hosted/enterprise reflection story adds no distinct method. The detailed article supplies stronger scope and impact limitations; headline equivalence is not accepted as equal evidence.
- **B044:** teardown/datasheet component identification is contextual, not validated vulnerability methodology. B014 supplies the actual acquisition, reconstruction, debugging failures, and binary audit; no teardown skill is created.
- **B018/B026:** short author reports supply limited harness-fidelity and failed-impact heuristics, not full reproducible campaigns. Their weaker evidence level is explicit.
- Event/anniversary/promotional posts and CTF/challenge solutions are indexed but excluded from this research corpus. They are not converted into challenge walkthroughs.
- Published shellcode, gadget chains, replacement-object layouts, payloads, credentials, target URLs/ports for reproduction, and attachment code are excluded—even where an article is otherwise retained.

## Coverage versus number of skills

All 65 retained method sources feed the 17 technique owners. Multiple-source convergence matters more than adding a skill for each source. The source/skill mappings and exact section locators are machine-checked; the semantic merge judgments are manually reviewed. See [METHOD.md](METHOD.md), [catalog.md](catalog.md), and [evidence.md](evidence.md).
