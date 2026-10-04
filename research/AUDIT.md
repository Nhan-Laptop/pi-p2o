# Completion Audit

This audit concerns the research-library deliverable, not replication of source exploits or present target safety.

## Requirement-by-requirement evidence

| Mission requirement | Current authoritative evidence | Verification |
|---|---|---|
| Start from the blog and recursively inspect relevant research | [Corpus](corpus.json): 81 screened, 67 inspected, seven internal edges reviewed | Matching HTTP/identity receipts; current section anchors; three stale URLs recovered; two code archives deliberately excluded |
| Identify research type and preserve concrete methods | [Extractions](extractions.json), [ledger](evidence.md): 65 method sources | Source section locators, specific observations, failures/limits, and defensive inference for every retained source |
| Build technique taxonomy rather than one skill per post | [Taxonomy](TAXONOMY.md), [router](../README.md#skill-router) | 17 question/decision owners; 65 retained sources mapped; shorter duplicate merged; contextual/excluded entries explicit |
| Include all requested technique fields | `skills/*/SKILL.md` | Technique, When to Use, Goal, Workflow, Research Heuristics, Tools, Validation, Common Failure Modes, Fix / Mitigation, plus Handoffs/Evidence |
| Tool → purpose → when mapping | Every skill's Tools section | Each tool bullet includes purpose and selection condition; historic offsets/APIs not copied |
| Preserve validation and failure reasoning | Every skill and source entry | Negative controls, original/modified distinctions, missing capabilities, disputed/unfinished impacts, partial fixes retained |
| Abstract chaining and privilege boundaries | Impact, authorization, sandbox, state/race skills | Capability/precondition and invariant models; no target trigger sequences or constructions |
| Explicit modular handoffs | [Contracts](../HANDOFFS.md), [scaffold](../templates/handoff.json), every skill | H1–H5 required directions, H6 rollout, producer/consumer, artifacts, acceptance/return gates |
| Defensive lessons and remediation | Fix/Mitigation sections, [remediation skill](../skills/remediation/SKILL.md) | Root-cause repair versus access mitigation, variant tests, shipped artifacts, logging, hardening and residual scope |
| Deduplicate and remove incidental specifics | Skills and [merge decisions](TAXONOMY.md#explicit-mergeexclusion-decisions) | Cross-domain consolidation; no per-CVE filenames, original scripts, addresses, code/payload paragraphs, or target endpoints in skills |
| Reusable skill artifacts | 17 directories with `SKILL.md`; README usage and links | Frontmatter, directory/name matching, bounded reading size, source links, and offline checks |

## Initial library verification receipts

Recorded command output: [checks.txt](checks.txt).

| Check | Result | Scope |
|---|---|---|
| `python3 scripts/render_research.py --check` | PASS | Corpus/ledger/catalog freshness and deterministic derivation |
| `python3 scripts/validate_library.py` | PASS | 17 skills, 81 entries, 65 method sources; fields, citations/anchors, links, provenance/mapping, handoffs, duplicate paragraphs, and recipe rules |
| `python3 -m unittest discover -s tests -v` | PASS — 38 tests | Positive checks and deliberately corrupted fixtures; duplicate content, missing fields, unsafe recipe patterns, invalid provenance, stale outputs, and unresolved links rejected |
| Native installed Pi `loadSkills` / `formatSkillsForPrompt` | PASS | All 17 skill directories discovered, unique names, zero diagnostics, 17 prompt entries, correct file locations |

The mutation suite initially exposed a duplicate-paragraph checker that skipped content attached to headings; that checker was corrected and the same negative fixture now fails acceptance as intended. Initial skill documents were approximately 600–710 words; the supplemental update below remains within a focused reading budget. Source authors' runtime results were never counted as independently reproduced target tests.

## Supplemental tooling update — 2026-09-30

The user requested reusable reverse-engineering improvements inspired by `ctf-rev`, with all operational guidance inside this library and no writeup/solution-specific material. [TOOLING.md](TOOLING.md) records the distinct methodology provenance; no external skill path or helper is required and the original corpus/source mapping is unchanged.

- Updated five existing skills: binary, dynamic, data-flow, memory-safety, and patch-diff analysis.
- Added four library-owned references: [format routing](../skills/binary-auditing/references/format-routing.md), [native slices](../skills/binary-auditing/references/native-slices.md), [runtime probes](../skills/dynamic-analysis/references/runtime-probes.md), and [reduced models](../skills/data-flow-analysis/references/reduced-models.md). They describe tool choice, bounded workflows, validation and failure gates—not challenges, input constants, success branches, or exploit construction.
- At that pre-Orange checkpoint, all 17 main skills were 614–790 words; each focused reference was below 650 words and loaded only for the corresponding question.
- Extended link, reading-budget, duplicate-content, and no-recipe checks to **every skill Markdown file**, including references. Five new mutation tests reject broken/escaping reference links, duplicated reference prose, recipe fences, and external CTF helper dependencies.
- At that checkpoint: render freshness and library validator PASS; **43 unit/mutation tests PASS**; native Pi loader discovered 17 unique skills with zero diagnostics and 17 prompt entries.
- Benign static binutils smoke test PASS on a hashed copy of the system `true` executable, without running it. Kuna is absent, so its optional CLI patterns were not runtime-tested; other optional tools are guidance, not executed integrations.

Historical commands/results: [tooling-checks.txt](tooling-checks.txt). No mandatory tool installation, copied solution, challenge flag, target bypass, or new vulnerability/benchmark claim was introduced.

## Per-technique acceptance review

Each row was reviewed for all six mission gates: generalizable, actionable, non-duplicative, evidence-backed, abstracted, and defensively complete. Transfer probes are hypothetical new-target applications, not new vulnerability claims. Distinct artifact ownership follows [TAXONOMY.md](TAXONOMY.md); every row has its own workflow, rejection criteria, and Fix/Mitigation section.

| Technique | Retained method sources | Transfer probe / actionable artifact |
|---|---:|---|
| Attack surface | 9 | New storage gateway: map least-privileged interface gates and consuming identities |
| Source auditing | 7 | New job service: learn wrappers and rank invariant-bearing code slices |
| Binary auditing | 7 | New appliance: establish load map and confidence-tagged dispatch/type contracts |
| Patch diffing | 13 | New runtime update: infer the changed invariant and verify actual package applicability |
| Data flow | 6 | New importer: prove field influence through storage, adapters, and deferred consumers |
| Dynamic analysis | 10 | New callback service: discriminate two state hypotheses with a minimal observation |
| Fuzzing | 6 | New archive parser: prove valid-state/reset fidelity and preserve minimized fault evidence |
| Parser differentials | 12 | New protocol bridge: compare validated and consumed representations before claiming impact |
| State/lifetime | 11 | New transaction worker: ledger owners, borrowers, logical removal, and final destruction |
| Race auditing | 8 | New shared queue: identify lock-drop/recheck gaps with explicit feasible event ordering |
| Memory safety | 15 | New media decoder: model complete allocation/access arithmetic and constrained consequences |
| Authorization | 10 | New tenant service: compare identity, action, object, field, and failure-state policy |
| Deserialization/dispatch | 9 | New plugin API: bound selector/type behavior through inherited and nested callbacks |
| Compiler invariants | 6 | New staged interpreter: identify fact invalidators and compare phase/tier guards |
| Sandbox boundaries | 11 | New plugin host: inspect broker decisions and remaining independent confinement layers |
| Exploitability assessment | 16 | New disclosure finding: bound primitive, address-space/lifetime scope, and missing capabilities |
| Remediation | 18 | New shared-library fix: verify equivalent consumers, normal controls, shipped artifacts, and telemetry |

## Manual editorial review

- Each skill owns a concrete question, artifact, and gate; overlap is routed through links rather than duplicated procedures.
- Source-specific facts remain in provenance, not operational recipes. Examples are generic invariants or read-only local-inspection commands.
- B008 assertion removal, B009 hypothetical authorization explanations, B030/B047 prose/code discrepancies, B035/B065 unfinished escalation, B064 uncertain impact/fix understanding, B057 disabled sandbox, B027 later interaction caveat, and B037 unexpected disclosure are not silently upgraded.
- Short B018/B026 reports are weaker method evidence; B038 is not independent confirmation; B044 is not bug proof.
- Source text and attachments are untrusted. No target exploits, exploit-code archives, credentials, shellcode, or copied source paragraphs are retained.

## Orange workflow update — 2026-09-30

| User requirement | Authoritative artifact and gate |
|---|---|
| Review existing skills first | [Pre-extraction ownership review](orange/BASELINE.md); pre-edit hashes distinguish the original 17 skills/four references from additions |
| Use the supplied archive fully | [Inventory](orange/inventory.json): three observed pages, 40/40/16 entries, 96 unique assigned URLs; not a title-only sample |
| Spawn one pi-herdr agent per blog | [Delegations](orange/delegations.json) and [dispatcher](../scripts/orchestrate_orange.mjs): 96 distinct article workers/panes, requested runtime, completion/output timestamps and preserved-before-close records |
| Filter, collect and combine all results | [Curation](orange/curation.json), [catalog](orange/catalog.md), [evidence](orange/evidence.md): every URL decided; 29 retained, 20 context, 46 excluded, one companion merged; 51 adopted/merged refinements |
| Preserve workflows and tool selection | Fourteen existing owners and six new question-specific references; implicit conversions, semantic/intermediary/cache/dispatch contracts, bounded observations and comparable-state gates |
| Explain when/what to hand off | [Handoffs](../HANDOFFS.md) and [scaffold](../templates/handoff.json): question-directed packets, receiver/context/phase, negative controls, prerequisites, observer effects and return gates; provisional owner route is distinct from repair closure |
| Keep changes generic, not solutions | Manual editorial/source review plus whole-skill/reference recipe/dependency checks; no product/challenge skills, copied solve sequence, executable chain or exploit integration |
| Audit source evidence independently | [Quotation receipts](orange/quote-verification.json): all 276 strings bound by hashes, 273 exact and three whitespace-only matches; separate Phrack/DEVCORE origins; O030 retry resolved |
| Verify the final library, not old receipts | [Current checks](orange/checks.txt), [final receipt](orange/verification.json): freshness, full validator/mutation suite, bounded document sizes and native Pi discovery with defaults disabled |

The original STAR Labs corpus and the four earlier tooling guides stay separately identifiable. Reviewers were advisory and did not reopen sources or run repository tests; their checkpoints did not cover the entire final packet set. The orchestrator reviewed the remaining packets and governs adoption. Candidate/owner overrides retain original evidence without rewriting workers' reports; the rendered ledger exposes qualification notes and treats worker handoffs as unadopted proposals. See [Orange methodology](orange/METHOD.md) for collection, reconciliation and verification scope.

Current main skills remain below 900 words; all ten optional references remain below 650. Native Pi still discovers 17 unique local skills with zero diagnostics and 17 prompt entries. These library checks and public-source wording receipts do not independently validate source-author vulnerabilities, vendor fixes, optional tool integrations, deployment policy or performance.

## Verification limits

Automated checks establish current artifact structure, linkage, provenance consistency, mappings, freshness, and selected no-recipe rules. Human source and taxonomy review supplies the semantic checks. Neither establishes current product vulnerability, exploit portability, completeness of a vendor's fix, or independent reproduction of the authors' runtime results.
