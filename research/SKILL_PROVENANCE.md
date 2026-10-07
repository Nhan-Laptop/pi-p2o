# Skill provenance for the application playbooks, framework overlay, and offline recipe

## Scope and review boundary

This record covers the non-blog additions created on **2026-10-07**: the [web route and input inventory](../skills/web-route-input-inventory/SKILL.md), [web object authorization](../skills/web-object-authorization/SKILL.md), and [web output context](../skills/web-output-context/SKILL.md) playbooks, the [FastAPI security parity](../skills/fastapi-security-parity/SKILL.md) overlay, and the [offline Semgrep recipe](../skills/source-code-auditing/recipes/offline-python-semgrep.md) with its [original local ruleset](../skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml).

The reviewed upstream snapshot is **usestrix/strix**, distribution `strix-agent`, revision **1.7.0** as recorded in the snapshot's package metadata; the snapshot carries no git commit identifier, so the package version is the stated revision. It is licensed **Apache-2.0**; the license text hash is recorded below. Review happened on a local snapshot and no upstream runtime was executed. This is provenance only: the additions are independent, rewritten guidance for this library, and there is no runtime, packaged, or network dependency on the snapshot. Adapted material is credited by document title and content hash, not by external file path.

## Upstream identity

| Item | Value | SHA-256 |
|---|---|---|
| Revision | strix-agent 1.7.0 | package metadata `8b4b6f1c0b4531a4cbc72b1f04877432d1fad2547f07a5b19c244aee4083c2b2` |
| License | Apache-2.0 | `7db9697134251e314bd8d39257fe170c98b3e2ad9b2ed67e97acaf9613e7b9e3` |
| Vendored license copy | [research/licenses/apache-2.0.md](licenses/apache-2.0.md) with [notice](licenses/README.md) | byte-identical to the recorded license hash |

The machine-readable form of this table is [SKILL_PROVENANCE.json](SKILL_PROVENANCE.json). The coverage checks recompute these hashes when the review snapshot is present; when it is absent, only the recorded structure is checked and the snapshot hashes remain unreproduced.

## Primary references

| Ref | Document | SHA-256 | Used by |
|---|---|---|---|
| R1 | Counterevidence and Closure Discipline | `3e729859564e68859eb588862d3c20a1fd65d88b49418b3e0e18f34eebae1d2d` | three playbooks |
| R2 | IDOR, object-level authorization failures | `2b97ead5254ab3e3fec92c3edafcd3eb619e59264c9f743c844bdadfcc1d0659` | web-object-authorization |
| R3 | XSS, reflected stored and DOM-based vectors | `3eba51fd17b527eccaad21a9f1a07aa638ffd61d85f573c49360229e068bcc97` | web-output-context |
| R4 | API specification testing | `bc16c8b64d35cae9b3aa703f32d40f33e280617f1c0cdf8c05358fec98dd09bf` | web-route-input-inventory |
| R5 | FastAPI security testing playbook | `4d1ee5916a2f8d145afe47a329c630196ca9d9a86e19af85c877d83366db9aa4` | fastapi-security-parity |
| R6 | Semgrep CLI playbook | `1de60189a3ff5d920ab7842659003349e06c061270c840768da6d35796870554` | source-code-auditing recipe |

### R1 — closure discipline

**Adapted:** named-control closure, the open-proof-gap state, explicit positive and negative controls, and evidence-stage limits carried into the three playbooks. **Excluded:** Strix runtime tool calls, its record schema, orchestration instructions, and any suggestion that a schema-complete record proves a finding.

### R2 — object authorization

**Adapted:** the principal-object-action matrix; tenant, batch, export, background-job, and channel variants as separate cells; one reachable unauthorized protected effect as sufficient. **Excluded:** automatic parameter-discovery tooling, bulk identifier harvesting, cache/timing/redirect/parser bypass recipes, header-spoofing guidance, and post-exploitation chaining.

### R3 — output context

**Adapted:** source to sink to exact output-context classification, reflection versus execution as separate evidence stages, and encoding judged against the consuming parser. **Excluded:** payload catalogs and polyglots, CSP and sanitizer bypass operations, credential or session collection, persistence, and post-exploitation guidance. Execution claims require a controlled runtime oracle and use inert markers only.

### R4 — route inventory

**Adapted:** method, path, parameter, and declared-authorization inventory; the valid-request baseline; and coverage tracking. **Excluded:** the assumption that specification-provided base addresses authorize traffic, automatic probing of undocumented write-method siblings, and active fuzzing.

### R5 — FastAPI parity

**Adapted:** router, mounted-application, middleware, asynchronous-consumer, and channel enforcement parity; dependency parsing versus verification; and installed-version preconditions. **Excluded:** its bypass catalogue, outbound-request probing, payload sets, and version-advisory blanket claims. The overlay never infers a bypass from an API name alone.

### R6 — Semgrep recipe

**Adapted:** explicit local configuration, bounded scope, metrics off, machine-readable output, conservative jobs/timeout/memory settings, and failure recovery. **Excluded:** registry packs, automatic config defaults, telemetry, the broader command catalogue, and every network-dependent step. The ruleset shipped with the recipe is original to this library; no upstream rule text was copied.

## Architecture references

| Ref | Document | SHA-256 |
|---|---|---|
| A1 | Strix skill loader package | `d7b4d8678dc67cebf9bef76b0ad53d9c77ce4c55a74c4439e6f70d1d853b14f3` |
| A2 | On-demand skill loading tool | `1cbcaff9968972f60ede8a3d137df8984a71d1cc2b28014b4224fa27fd8f31d5` |
| A3 | Shared versus task-specific prompt assembly | `d70343408e042018ba34380c6235e32a882c2b4a14e34a6f3752eb5cefd95122` |

These three were read for architecture context only. No content was adapted from them, and the retrieval and prompt-composition features they describe are implemented separately in the P2O runtime, not in the skill library.

## License considerations

Apache-2.0 permits adaptation and redistribution with attribution. This private repository remains UNLICENSED, so attribution is documented here rather than applied as a repository-wide license change. The exact upstream license text is vendored at [research/licenses/apache-2.0.md](licenses/apache-2.0.md) beside its [notice](licenses/README.md), and the vendored copy is hash-checked even when the untracked review snapshot is absent. No upstream source code, rule file, payload, or NOTICE file was copied. The original P2O ruleset is authored for this library and carries no upstream rule identifiers.

## Tool and recipe verification limits

The recipe's ruleset was validated locally with Semgrep 1.179.0 outside the library content and against synthetic inputs kept out of the shipped skill tree. `semgrep scan --validate --config <ruleset> --metrics=off` reported five rules and zero configuration errors. `semgrep scan --config <ruleset> --metrics=off --json --output <report> --quiet --jobs 1 --timeout 20 --max-memory 512 --no-git-ignore <sample>` produced five candidate findings on a vulnerable fixture and none on a fixed fixture. That probe establishes syntax and candidate orientation only. It is **not** a measurement of the production sandbox image, and the recipe therefore requires an in-sandbox probe with retained output before a scan is trusted. No target, service, credential, or external origin was contacted during this review.

## Maintenance

Adding a playbook, overlay, or recipe means adding its sidecar metadata, extending this record with a new hash row and adapted/excluded lists, and updating the validation profiles. The opt-in `P2O_TEST_SEMGREP=1` case in `tests/test_library.py` reproduces the local vulnerable/fixed ruleset probe; it stays out of the default offline suite. Historical blog provenance is unchanged by these additions: the blog corpus, its source IDs, and its technique owners are the original 17 techniques, and no playbook claims blog evidence.
