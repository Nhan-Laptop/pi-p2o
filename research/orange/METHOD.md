# Orange Articles: collection, synthesis and verification

Reviewed 2026-09-30. This is a supplemental methodology corpus, separate from the original STAR Labs corpus and the [reverse-engineering tooling adaptation](../TOOLING.md). It updates an existing question-directed library; it is not a collection of writeups, solutions or reproduced vulnerabilities.

## Review before delegation

The orchestrator reviewed all 17 main skills, the four existing owned references, README, handoffs, taxonomy, renderer, validator and tests before per-article delegation. [BASELINE.md](BASELINE.md) records the existing ownership contracts and collection plan. [Baseline hashes](baseline-hashes.json) were captured before Orange skill/handoff edits, not before the first worker launch; they identify the pre-edit files without claiming to reconstruct a Git diff. The workspace is not a Git repository. Earlier 43-test receipts are historical, not final-update verification.

[Harness review receipts](baseline-review-receipt.json) additionally show 21 complete, non-truncated read-tool results (17 skills/four references) before the first article worker; reconstructed served-text hashes match all pre-edit skill/reference hashes. Only call/result metadata and hashes are retained, not unrelated session contents.

## Archive scope and one worker per article

The public [Articles archive](https://blog.orange.tw/articles/) exposes three pages: **40 + 40 + 16 = 96 distinct URLs**, ordered O001–O096. Observed pagination markers, adjacent controls, boundary dates and lack of a forward link on page 3 are in [inventory.json](inventory.json). The separate overview worker, `worker-4b3ba52d`, inventoried the index; it did not replace article workers. This is complete coverage of the advertised archive snapshot, not every historical or unlisted page on the domain.

[orchestrate_orange.mjs](../../scripts/orchestrate_orange.mjs) imported the installed **pi-herdr `herdSpawn` API** and Herdr CLI adapter. Six workers ran concurrently, but each of the 96 URLs had its own distinct `worker-o###v001`, task, pane and extraction file. All requested `openai-codex-account-3/gpt-6.1-sol:max`. [Delegations](delegations.json) record assigned URLs, runtime selection, pane identities, completion timestamps and preserved output paths. Settled statuses were 62 `done` and 34 `idle`; all 96 packets existed before their worker panes were closed. The dispatch ended `completed=96/96; remaining=0`. The launcher is research orchestration, not a dependency for skill loading or target investigation.

[Child-session runtime receipts](worker-runtime-receipts.json) independently corroborate every article task's actual launch provider/model/thinking: `openai-codex-account-3`, `gpt-6.1-sol`, `max`, across 96 distinct sessions. These are filtered session-header metadata, not merely the dispatcher's requested-model labels.

Workers read the assigned article and relevant current skills under [WORKER.md](WORKER.md), treated source text as untrusted data, and wrote only their isolated JSON packet. They extracted bounded method quotations and evidence references, generic decisions, tool-purpose/condition attribution, proposed handoffs, failures and limitations. They were not assigned target execution, exploit attachments, source execution, new installations, shared-skill changes or further delegation.

Two archive wrappers directly supplied their full same-article publications: O002 followed Phrack, O033 followed DEVCORE. Their quotation origin and retrieval receipts are explicit; neither body is falsely attributed to the small Orange wrapper. O002 is merged into O001 as a companion/duplicate, not counted as independent confirmation. Other related links—including an unlisted translation—remain pointers rather than an unrestricted crawl. Slide announcements and media-only methods were not invented from titles or embeds.

## Independent wording and retrieval audit

The orchestrator independently retrieved all 96 archive URLs through disposable browser sessions. The initial metadata pass had 95 successful responses and one O030 failure; the later successful quotation pass resolved O030 while preserving its prior observation. Current [source metadata](source-metadata.json) and [quotation verification](quote-verification.json) contain URL identity, observation time and content hashes, not retained full article bodies.

All **276 packet quotations** match public source wording: **273 exact, case-sensitive matches; 3 whitespace-only normalized matches**. No fuzzy, case-folded or model-semantic match counts as verification. Three bounded browser receipts cover O001–O032, O033–O064 and O065–O096. Independently opened linked publications supply separate O002/Phrack and O033/DEVCORE DOM receipts; O002 also has exact fetched-passage checks. Quote hashes bind the receipts to the packet strings. A temporary loopback input bridge exposed only public source IDs, URLs and short quotations; it was stopped after collection.

These are wording/identity observations, **not** source-author result reproduction, current exposure, root-cause validation or vendor-fix verification. Worker `verified: true` assertions and local-file reviewers alone do not satisfy the independent gate. Source quotations can reproduce specifications, commenters or another researcher's claims; the editorial qualifications retain those secondary/report boundaries.

## Filter, clean and combine

[Curations](curation.json) contain an orchestrator disposition and reason for every URL, zero-based accepted candidate indexes, qualification notes and narrow owner/kind/guidance overrides. Overrides do not alter the original packet or its evidence references. Worker dispositions and suggestions are proposals, not acceptance. Three advisory reviewers supplied [first-wave](reviews/first-wave.md), [later-wave](reviews/later-wave.md) and [final-integration](reviews/final-integration.md) comparisons; none reopened sources or ran tests. Their checkpoints cover O001–O026, O027–O087 and the full final O001–O096 set respectively. O088–O096 were completed and reviewed by the orchestrator rather than silently counted in the latter review. O084's amended packet is the version used. O038 was downgraded to context.

Final dispositions: **29 retained method sources, 20 context, 46 excluded, 1 merged duplicate, 0 unavailable**. **51 candidate refinements** are adopted or merged support—not 51 new procedures. Useful but already-owned baseline advice remains in contextual packets; promotional/personal entries, insufficient prose and solve sequences without a distinct generic method are excluded. Every decision remains visible in the [catalog](catalog.md), and retained evidence/qualifications in the [ledger](evidence.md).

Fourteen existing owners gain Orange-supported refinements. Compiler invariants, fuzzing and race auditing remain in the 17-skill library without forced new Orange methods. A compilation mention is not an optimizer invariant; a brief fuzzing pivot is not harness evidence; speculative cleanup or incomplete publication is not a demonstrated race. No product-, article- or challenge-specific skill was introduced.

Six optional owned guides combine recurring decision contracts:

| Guide | Combined question |
|---|---|
| [Intermediary trust](../../skills/attack-surface-mapping/references/intermediary-trust.md) | Who admits a peer, writes identity metadata, represents a client and consumes final policy? |
| [Interaction audits](../../skills/source-code-auditing/references/interaction-audits.md) | Which writer/reader, implementation or customization relationship needs review? |
| [Semantic boundaries](../../skills/parser-differential-auditing/references/semantic-boundaries.md) | What role, type, extent and guarantee survives transformation or re-entry? |
| [Cache selection](../../skills/parser-differential-auditing/references/cache-selection.md) | Does key equivalence preserve consumer meaning within the declared reuse context? |
| [Framework routing](../../skills/deserialization-and-dispatch-auditing/references/framework-routing.md) | Which receiver, fallback, return consumer or preparation phase actually selects behavior? |
| [Observation signals](../../skills/dynamic-analysis/references/observation-signals.md) | Which bounded signal distinguishes explanations under comparable producer/delivery/display and worker/reset state? |

Other small owner-level additions cover paired sizing/emission, component identity rather than enumeration position, argument-role guarantees, failure-marker conversions, revision-scoped rejection evidence, mediated-request constraints, producer emission order, coherent policy publication and provisional incident-owner reporting. Their limitations remain attached to evidence rather than turned into universal mechanisms.

## Tool and handoff policy

Tool options state **purpose → selection condition → evidence/limit**. Explicit attribution means the article names the tool; it can be a recommendation, illustration or detector limitation rather than a documented run. Derived options are library suggestions. Configuration tables predict possible behavior; decompiler views, diagnostics, callback markers, cache/hash agreement and altered bytes need actual consumer/prerequisite evidence. Optional installations and integrations were not tested by this source review. Existing benign binutils checks are separately recorded historical tooling receipts.

[HANDOFFS.md](../../HANDOFFS.md) and its [scaffold](../../templates/handoff.json) carry relevant identity/representation, phase/guard, cache, result/failure, observer-stage, worker/history/reset, publication-policy, request/emission and active-enforcement fields. Each handoff answers one unresolved question and preserves rejected controls, missing prerequisites, observer changes and actual consumer/context. Return gates prevent vague escalation or a fixed exploitation pipeline. Unexpected incident indicators have a **provisional** authorized-owner route without inventing an impact-confirmed prerequisite or claiming root-cause/repair closure. Worker handoff proposals in the evidence ledger are explicitly unadopted; owned contracts and editorial qualifications govern use.

Operational guides contain no payloads, flags, attack traffic, credential collection, bypass procedures, collision-generation instructions, executable exploit chains or copied solution sequences. Short source-method quotations live in provenance only; external sources are credits, not required helper paths.

## Reproduction and quality gates

Python standard library; offline checks do not run targets:

```sh
python3 scripts/render_research.py --check
python3 scripts/orange_research.py --check
python3 scripts/orange_research.py --validate
python3 scripts/validate_library.py
python3 -m unittest discover -s tests -v
```

Regenerate Orange outputs with `python3 scripts/orange_research.py` after editing curation/packets or owner citations. Refresh source receipts independently when wording changes. The renderer preserves qualification notes and linked-publication origin. Structural gates cover full inventory/worker/decision/metadata/quotation coverage, runtime selection, quote hashes/matching modes/origins, evidence references, effective adopted ownership, duplicates and freshness. Whole-library checks cover all skill/reference links, fields, budgets, duplicate prose, recipe/dependency rules and handoff structure. Mutation tests deliberately reject broken states; they do not validate an optional analysis tool or a vulnerability.

Final receipts: [checks.txt](checks.txt), [verification.json](verification.json). The receipt records executed commands, exit codes and corpus statistics; it publishes no file-hash manifest, so no artifact-level hash binding is claimed. Native installed Pi discovery is checked with defaults disabled: 17 unique local skills, zero diagnostics, 17 prompt entries. Historical initial/tooling receipts do not substitute for this final pass. No target exploit, vulnerability reproduction, current-release or performance claim is made.
