# Orange research update: pre-extraction review

Reviewed before dispatching article workers: all 17 `skills/*/SKILL.md` files, all four existing owned reference guides, README, HANDOFFS, the renderer, validator and mutation suite. This library selects the next unresolved question rather than following a fixed exploit pipeline. Existing quality gates pass: renderer freshness, validator, and 43 tests (2026-09-30).

The [harness read receipt](baseline-review-receipt.json) confirms full, non-truncated reads of all 21 existing skill/reference files before the first article worker. Reconstructed read-output text hashes match the [pre-edit hashes](baseline-hashes.json); session bodies are not retained in this corpus.

## Ownership and merge plan

| Existing owner | Existing contract | Evidence to look for, not presumed findings |
|---|---|---|
| Attack surface | Actor/gate/handler inventory | Architecture-first reachability, overlooked intermediary interfaces and capability exposure |
| Source auditing | Convention-aware source/sink slices | Framework routing, exceptions to normal validation, corpus and sibling-pattern selection |
| Binary auditing | Bounded, format-first contracts | Source-unavailable fallback, acquisition/decompilation limits, not exploit details |
| Patch diffing | Changed assumption and shipped fix | Semantic comparison, alternate-path repair and historical-version limits |
| Data flow | Actor-controlled value at the consumer | Representation changes, stored inputs, indirect edges and explicit feasibility gates |
| Dynamic analysis | Falsifiable minimal observation | Instrumentation, negative controls, tool selection and failed-observation recovery |
| Fuzzing | Faithful harness and oracle | Differential semantic oracles, valid seeds, state/reset and minimization |
| Parser differentials | Validated versus consumed meaning | Encoding, URL/path, protocol, phase/order, cache-key or namespace disagreement |
| State/lifetime | Ownership plus transitions | Cached or shared state validity, cancellation and delayed consumers |
| Races | Feasible interleaving | Checked state changing before use, demonstrated schedules rather than timing guesses |
| Memory safety | Representation-to-access bounds | First invalid operation, machine/runtime widths and input constraints |
| Authorization | Actor–action–object policy | Identity origin/binding, alternate interfaces, delegated authority and defaults |
| Dispatch | Data selecting behavior | Routing metadata, dynamic invocation, coercion and implicit interpreter/serializer boundaries |
| Compiler invariants | Cross-phase assumptions | Only if an article really supports phase/inference invalidation |
| Sandbox boundaries | Layered capabilities | Confused deputies and broker policy, remaining restrictions |
| Impact assessment | Constrained capabilities | Preconditions, missing edges, scope, failed hypotheses and minimal harmless evidence |
| Remediation | Invariant repair and rollout | Variant regressions, trusted enforcement, disclosure and artifact verification |

## Collection contract

Starting reference: <https://blog.orange.tw/articles/> including every pagination page. Inventory the actual complete index; one isolated pi-herdr worker owns each distinct article URL, including pages later excluded. The overview has a separate inventory worker. Requested worker runtime: `openai-codex-account-3/gpt-6.1-sol:max` (the supported provider/model/thinking shorthand). Workers only create their own extraction records; the orchestrator owns all merges and skill changes.

Each extraction must retain source identity, observed section/paragraph locators, small method-only quotations, paraphrased problem-solving decisions, tools with purposes and conditions, failed assumptions and evidence limits. Suggested handoffs are derived library contracts unless the article explicitly states them. CTF solutions, payloads, executable exploit instructions, endpoint strings, credentials and product-specific constants are excluded from operational guides. Promotional/slides-only, autobiographical, duplicate-translation and inaccessible sources receive explicit dispositions, never invented methods.

Orange evidence stays separately identifiable from the existing 81-entry STAR Labs manifest and the `ctf-rev` tooling provenance. No source-author result is treated as a locally replicated vulnerability. Operational additions are generic and library-owned within `skills/`, with links back to source evidence and handoff gates.
