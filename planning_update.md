# Skill and testing capability enhancement plan

**Status: implemented and runtime-verified; benchmark evidence is partial and explicitly non-conclusive.**

The release is implemented on `3d254fe` (pushed and reinstalled with Pi). The clean real-agent benchmark was
user-stopped after 18/72 valid runs; those results are retained as mechanism and runtime evidence only, not as a
quality comparison or effectiveness claim. Earlier campaigns remain marked confounded by generated-bytecode
leakage. See `research/runtime/skill-upgrade/clean-study-combined-summary.json` and the full local report under
`tmp/skill-upgrade/clean-study/REPORT.md`.

This roadmap follows the skill-library comparison and the completed 0.3.0 delegation baseline.
The old delegation plan was removed; its history remains in Git. This roadmap does not change user settings
or authorize testing external targets.

## 1. Goal and success criteria

Improve practical assessment quality without replacing the existing evidence-first research methods:

1. Make skills, their references and required handoff instructions accessible to both lead and workers.
2. Separate what a skill can analyze from what the runtime can execute.
3. Add a small, carefully selected set of concrete web-testing playbooks.
4. Preserve reproducible evidence, candidate closure and untested scope.
5. Measure improvements with real Pi agents on controlled fixtures, not only unit tests.

**Selection rule:** adopt the best-fitting ideas from the inspected Strix checkout, not its whole corpus.
“Best-fitting” means relevant, concrete, bounded and compatible with our evidence policy. It does **not** mean
proven more effective: live benchmarks decide which additions remain. The implemented release retains the
three web playbooks and FastAPI overlay because they pass catalog/provenance validation and were exercised in
controlled local runs; no broad security-effectiveness claim is made from the partial benchmark.

## 2. Verified baseline and gaps

| Area | Current implementation | Gap |
|---|---|---|
| Library | 17 technique `SKILL.md` files and 10 reference documents | Few application-specific testing procedures |
| Worker loading | Selected main documents inlined, up to three skills; 24 × 1024-character slice per document | Linked references, `HANDOFFS.md` and evidence documents cannot be retrieved through P2O tools |
| Lead access | Ordinary host tools blocked while an assessment is active | Lead also needs a safe library-reading interface |
| Runtime | Offline shell; read-only source copy for directory targets; exact-origin public-IPv4 GET/HEAD for URL targets | No authenticated HTTP, request bodies, managed browser or OAST integration |
| Source copy | `.git`, symlinks and special files omitted | History-based methods need explicit unavailable-prerequisite handling |
| Records | Append-only notes, coverage, observations, open items, reports and lifecycle records | No owner-generated record IDs, structured evidence receipts or candidate revision model |
| Validation | Strict research-document schema, provenance/link checks and no fenced examples | New playbooks/recipes need a distinct validation policy, not blanket relaxation |
| Cleanup | Control directory removed on finish | Evidence must be exported safely before deletion if it is to remain reproducible |
| Worker failure | The observed quota failure ended without a report | A benchmark must not wait indefinitely or score provider failure as a negative finding |

Sources: [extension](extensions/p2o/index.ts), [broker](src/broker.ts), [records](src/records.ts),
[prompts](src/prompts.ts), [library validator](scripts/validate_library.py), [research method](research/METHOD.md).

Preserve the existing owner/broker architecture, worker scope restrictions, focus and nesting caps, and verified
cleanup. Same-user processes are outside the isolation guarantee. Do not infer completion from Herdr `idle`.

## 3. Curated Strix references

Use the following **six primary references**, each for one specific improvement. Read the relevant sections
again during implementation and record the source revision/hash. Rewrite the guidance for P2O; do not ship a
runtime dependency on `my_references/`.

| ID | Reference | Best-fitting technique to adopt | Adaptation / exclusion |
|---|---|---|---|
| R1 | [Counterevidence](my_references/strix/strix/skills/analysis/counterevidence.md) | Named-control closure, negative controls, explicit proof gaps | Preserve uncertainty; structured fields are not proof that a claim is true |
| R2 | [IDOR](my_references/strix/strix/skills/vulnerabilities/idor.md) | Principal–object–action matrix; tenant, batch, export and background-job variants | Use controlled identities/objects; one proven transport is sufficient, others are variant coverage |
| R3 | [XSS](my_references/strix/strix/skills/vulnerabilities/xss.md) | Source → sink → output context; distinguish reflection from execution | Use harmless local execution markers; exclude credential collection, persistence and post-exploitation guidance |
| R4 | [API specification testing](my_references/strix/strix/skills/custom/api_spec_testing.md) | Specification-guided route/parameter inventory | Adopt inventory and baseline comparisons only; reject its assumption that spec-provided URLs authorize traffic and its automatic probing of write-method siblings |
| R5 | [FastAPI](my_references/strix/strix/skills/frameworks/fastapi.md) | Dependency, router, middleware and mounted-app enforcement parity | Verify actual dependency code and installed versions; do not treat `Depends` versus `Security` alone as proof of a flaw |
| R6 | [Semgrep](my_references/strix/strix/skills/tooling/semgrep.md) | Explicit config, bounded scan scope, machine-readable output and failure recovery | Use pinned local rules, no registry fetch; prove tool/rules availability in the actual sandbox |

Supporting architecture references, not additional skill imports:
- [Strix loader](my_references/strix/strix/skills/__init__.py): metadata discovery, ambiguity handling, overrides.
- [On-demand loading](my_references/strix/strix/tools/load_skill/tool.py): retrieve guidance when needed.
- [Prompt assembly](my_references/strix/strix/agents/prompt.py): shared instructions versus task-specific skills.

**Defer:** cloud/AD playbooks, broad enumeration suites, blanket scanner bundles, OAuth/GraphQL runtime suites
and extra framework overlays until a target and capability justify them. Tools such as AST scanners and secret
scanners can work offline; network tools may also support local labs. Selection is based on demonstrated runtime
compatibility, not on tool names. Trivy database availability is unverified, not assumed absent.

Provenance records must identify what was adapted, what was rejected, upstream revision, review date and license
considerations. Preserve attribution where required. The existing blog evidence chain must not be rewritten to
pretend that new playbooks came from those historical sources.

## 4. Architecture decisions

### 4.1 Keep discovery compatible

Keep `skills/<name>/SKILL.md` and the existing `name`/`description` frontmatter. Add a versioned
`skills/catalog.json` sidecar for kind, optional references, workflow prerequisites, tool recipes and provenance.
This avoids breaking the current strict frontmatter parser and native Pi skill discovery.

Start with kinds `technique`, `playbook`, `overlay`. Recipes are supporting documents, not automatically loaded
skills. Keep the existing three-document assignment cap: an overlay consumes one slot. A separate overlay cap
is unnecessary until benchmarks show that it is needed.

### 4.2 Use workflow-level prerequisites

Do not declare a whole authorization skill unusable because authenticated HTTP is unavailable. Distinguish:
- Source review: needs a source copy, not a running service.
- Offline unit reproduction: needs a suitable runtime and fixture dependencies.
- Authenticated live comparison: needs consented identities and an authenticated HTTP capability.

Represent alternatives explicitly (`allOf` / `anyOf`) per workflow. Unknown requirement IDs fail catalog
validation. Missing prerequisites produce a relevant gap only when that workflow is selected, not a flood of
open items for every hypothetical feature mentioned in a skill.

### 4.3 Separate permission, availability and applicability

A capability snapshot contains:
- Policy permission: what the human-approved run allows.
- Runtime availability: supported/unavailable/unknown, with reason and probe evidence.
- Target applicability: directory versus URL and relevant environment facts.

Prefer positive capability IDs (`source.snapshot`, `source.history`, `shell.offline`, `http.same-origin.get`,
`http.authenticated`, `browser.execution`, `lab.local-http`) and separate numeric limits. Do not encode negative
properties as required capabilities. Tool presence is not proof that its rules, database or runtime work.

## 5. Phase 0 — freeze the baseline and test design

**Priority:** prerequisite. **Deliverable:** baseline manifest and benchmark specification.

1. Record project revision, selected source hashes, Pi version, sandbox digest and explicit role/model settings.
2. Run existing type/build/library tests; record outcomes, not assumed historical passes.
3. Inspect the installed versus development skill root and all exact tool-set assertions in existing tests.
4. Probe relevant tools inside the same unprivileged, offline, resource-limited sandbox configuration. A
   `--version` check is insufficient: run one tiny local input with a local ruleset and retain its output.
5. Validate the challenge archive in `tmp`; hash originals and create a fresh benchmark copy. Do not expose
   old diagnostic notes, expected findings or previous solutions to the agent.
6. Freeze scoring rules, limits and fixtures before running comparison arms.
7. Reproduce terminal provider failure mechanically. Before live comparisons, ensure an errored worker reports
   a blocked lifecycle result without another model call, or the harness explicitly withdraws it and marks the
   run invalid. Do not silently switch providers or treat a failure as clean coverage.

**Gate:** baseline recorded; no real-target traffic; selected tools tested; benchmark budget and provider fixed.

## 6. Phase 1 — safe on-demand skill access

**Priority:** P0. **Files:** new `src/skills.ts`; extension, broker, prompts and related tests.

1. Extract discovery/loading into one registry used by initial inlining and on-demand reads.
2. Add `p2o_skill_list` and `p2o_skill_read` to both role tool sets and lifecycle gates.
3. Use opaque catalog document IDs, never caller-supplied host paths. Register:
   - Main skills and their owned references.
   - Approved sections of `HANDOFFS.md` and the scope baseline.
   - Bounded, approved evidence-ledger sections when explicitly requested.
4. Serve worker requests through the authenticated owner broker. Both roles use the same resolver.
5. Reject traversal, absolute paths, unregistered documents, symlinks and special files. Open validated regular
   files without following links; keep containment checks safe against replacement races, not just string checks.
6. Return document ID, content hash, bounded text and continuation metadata. Keep UTF-8/JSON responses within the
   broker framing limit; do not silently truncate an instruction in the middle of a section.
7. Keep the selected main document inlined; rewrite packaged relative links into retrievable document IDs.
8. Limit catalog/read sizes and call volume separately from target command budgets. Knowledge reads must not
   consume the reserve intended for target validation and reporting.

**Tests:** owner and real-Pi worker read the same document/hash; references and handoffs accessible; traversal,
symlink and stale-ticket denial; multibyte limits; missing package asset; inactive/finished gates; no host paths
in newly generated result metadata (audit document bodies separately for existing paths).

**Gate:** all existing main skills and ten references are retrievable, with required handoff links resolved;
no arbitrary host read capability is introduced.

## 7. Phase 2 — capability-aware planning

**Priority:** P0. **Files:** new `src/capabilities.ts`, catalog, broker, prompts and tests.

1. Define and version the capability snapshot described in §4.3.
2. Derive policy facts from actual target/transport settings; attach tool probe results from Phase 0.
3. Add `p2o_capabilities` for both roles and a concise snapshot to the owner/worker instructions. Keep authority
   owner-side; a worker cannot advertise itself a new permission.
4. Populate workflow prerequisites for the existing techniques, distinguishing analysis from execution.
5. Report selected-workflow mismatches at delegation and in the brief. Permit useful source review even when
   dynamic testing is blocked. No automatic broader network access, installation or credential lookup.
6. Show unresolved capability gaps in final coverage. Check policy at execution time regardless of metadata.

**Tests:** directory/URL split; offline runtime known/unknown/unavailable; alternative prerequisites; capability
lookup through broker; missing capability cannot be turned into a tested result merely by worker assertion.

**Gate:** an agent can explain what it can review, what it can reproduce, and why another workflow is blocked.

## 8. Phase 3 — evidence and coverage contracts

**Priority:** P1, before playbooks because they depend on the contract. **Reference:** R1.

1. Add owner-generated immutable record IDs and a versioned evidence schema. Record tool execution receipts:
   command/request identity, run/actor, target identity, timestamps, exit/status, bounded output and truncation.
   Preserve sandbox-side artifact hashes where export is supported; a hash alone is not retained evidence.
2. Separate candidate closure (`confirmed`, `ruled_out`, `open_proof_gap`) from coverage execution state
   (`tested`, `not_tested`, `blocked`, `not_applicable`). Existing `clean` means only no issue found in the
   recorded tested slice; it must not imply universal safety.
3. Link candidates to evidence IDs, named controls, negative controls, proof level and limitations. Distinguish
   static trace, offline reproduction and live reproduction. An independent-validation claim requires another
   worker's actual reproduction receipt, not merely another worker's opinion.
4. Validate evidence existence and same-run association at the broker. Schema completeness cannot establish
   truth. Reject contradictory or malformed records with actionable errors rather than silently relabelling
   findings. Retain conflicting revisions and attribution; never collapse them using an undefined “strictest”.
5. Add explicit candidate revisions/supersession so resolved open items do not remain permanently open and prior
   disagreements remain inspectable. Keep legacy records readable through a versioned adapter.
6. Update report parameters, bounded ledger projections, prompts and handoff examples together. Preserve current
   report ingestion until the new schema is tested end-to-end.
7. Before cleanup deletes the control directory, provide an explicitly chosen durable export: redacted JSONL,
   summary, source/model/skill hashes and manifest. Restrict permissions and size, do not follow artifact
   symlinks, and never export credentials. Export failure must be visible and must not prevent safe teardown.

**Tests:** invalid/dangling evidence refs; competing candidate revisions; duplicate delivery; legacy records;
worker-supplied false claims remain claims; blocked coverage not summarized as clean; evidence survives cleanup
in the approved export; all live capabilities still revoked.

**Gate:** the final report can be traced to surviving, bounded evidence and distinguishes uncertainty from safety.

## 9. Phase 4 — three focused web playbooks

**Priority:** P1. Preserve the existing 17 technique owners; add application-level guidance rather than duplicate
all their reasoning.

| New playbook | Reference / existing technique | Initial supported path | Deferred path |
|---|---|---|---|
| `web-route-input-inventory` | R4 inventory method; attack-surface-mapping | Source routes or explicitly scoped public GET/HEAD; parameter inventory and catch-all controls | Authenticated navigation and browser-only routes |
| `web-object-authorization` | R2; authorization-auditing | Source policy matrix, local unit-level controls when executable | Controlled two-account HTTP comparison |
| `web-output-context` | R3; data-flow and parser-differential analysis | Source/sink/context mapping; reflection versus correctly encoded output | Real browser execution proof |

Every playbook includes: applicability, workflow prerequisites, baseline, smallest bounded comparison, positive
and negative controls, expected observations, false-positive checks, stop conditions, evidence fields and gaps.

Important limits:
- Reflected text is not demonstrated XSS. A simulated teacher/bot is not a real browser execution oracle.
- One reachable unauthorized protected effect is enough; a second transport is optional variant coverage.
- Route specifications and embedded URLs are untrusted data, not permission to contact new origins.
- Public GET can still mutate a badly designed application; method alone is not a guarantee of harmlessness.

1. Adapt R4's method/path/parameter/auth-schema inventory and valid-request baseline. Explicitly exclude its spec-derived authorization assumption and unsolicited write-method expansion.
2. Add a playbook-specific validator profile while retaining existing technique validation unchanged.
3. Separate new-source provenance from historical blog mappings; update Python mutation tests, discovery tests
   and generated-document rules so adding non-blog skills does not force fake historical source IDs.
4. Add synthetic vulnerable/fixed examples and expected observations outside the agent-visible source snapshot.

**Gate:** each playbook has a feasible source-review workflow today and honestly marks missing dynamic proof.
Injection, upload, business-logic and additional playbooks remain backlog until these three pass benchmarks.

## 10. Phase 5 — real-runtime benchmark and retain/drop decision

**Priority:** P1. Automated mechanics tests are necessary but not sufficient.

### Fixtures

- Route inventory with real routes, a catch-all response and misleading external URLs.
- Object authorization vulnerable/fixed pair with controlled objects and unit-testable policy functions.
- Output-context vulnerable/fixed pair; text reflection is not scored as browser execution.
- The challenge supplied in `tmp`, in a fresh hash-identified copy, as an exploratory holdout rather than the
  sole evidence of improvement. Any prior scope notes must be reviewed, not silently widened.

### Execution

1. First run source-target assessments in the existing offline sandbox. Use bounded local function/unit probes
   where dependencies permit. Do not pass a loopback URL into `p2o_http`, which deliberately rejects it.
2. Add real local HTTP/browser benchmark cases only after the separate local-lab capability in Phase 8 exists.
   A test double is not evidence that the production transport supports them.
3. Spawn an actual Pi lead and at least one visible P2O worker through the extension on the holdout challenge.
   Record delegated skill reads, brokered commands, reports, final evidence export and verified pane/container
   cleanup. Do not use an unrelated solver as a substitute for testing this extension.
4. Keep a small opt-in runner (`scripts/benchmark-skills.mjs`) out of `npm test`; record real model/provider,
   thinking level, package/skill hashes, budgets and every failure. Use explicit model settings, not hardcoded
   assumptions about provider availability. No automatic cross-provider fallback.
5. Compare **A:** baseline; **B:** access/capabilities/evidence with the same 17 skills; **C:** B plus playbooks.
   Use separate pinned builds/configurations so contract enforcement is not selectively disabled in production.
   Freeze fixture truth before any arm; randomize arm order and use at least three runs per fixture/arm for
   an initial pilot, then report distributions and raw outcomes, not unsupported significance claims.
6. Keep evaluator truth and old solutions outside the agent's mounted source and working context. Provider API
   traffic is expected; target traffic must remain confined to the approved local test environment.

### Score and release gate

Measure candidate precision/recall, fixed-fixture false positives, proof-level accuracy, gap honesty, evidence
reproducibility, worker settlement/cleanup, target commands, wall time and token/cost usage when available.
Provider outages are reported separately, not counted as security negatives or dropped silently.

Pre-register minimum gates: no scope escape; no false execution/independent-verification claim; no blocked test
reported as clean; verified teardown for every completed run. Keep a playbook only if repeated runs show useful
coverage/evidence improvement without unacceptable false positives or cost. Publish negative results too.

**Gate:** retained artifacts and a human-readable report demonstrate real agent behavior. `npm test` alone cannot
close this phase, and a CTF flag alone does not establish general pentesting quality.

## 11. Phase 6 — one framework overlay

**Priority:** P2. **Reference:** R5.

1. Add `fastapi-security-parity` as a catalog overlay with version and applicability checks.
2. Cover router/route dependency enforcement, mounted applications, identity parsing versus verification,
   asynchronous consumers and channel parity. Check actual source; never infer a bypass solely from API names.
3. Compose within the existing three-slot limit: technique + playbook + overlay. Load optional tool/reference
   guidance on demand rather than expanding every worker prompt.
4. Benchmark against a vulnerable/fixed FastAPI fixture before adding Django, Next.js, NestJS or protocol overlays.
5. Keep GraphQL/OAuth dynamic workflows deferred until their required transport/session capabilities exist.

**Gate:** measurable gain on the framework fixture, no incorrect blanket framework claims, bounded prompt growth.

## 12. Phase 7 — bounded recipes and offline rules

**Priority:** P2. **Reference:** R6.

1. Start with one Semgrep recipe, not a multi-scanner bundle. Specify purpose, prerequisites, exact local input,
   bounded runtime/memory, exit-code interpretation, output, error recovery and manual validation of hits.
2. Register `skills/<owner>/recipes/*.md` in the same safe catalog. Allow fenced operational examples only under
   a dedicated recipe validator; keep no-fence research-method rules unchanged. Include provenance and licenses.
3. Vendor a small pinned ruleset and test it on vulnerable/fixed samples. Provide a safe owner-managed transfer
   of immutable catalog assets into worker scratch (or bounded text materialization), since host rules are not
   automatically mounted into the sandbox. Never accept arbitrary host source paths for this transfer.
4. Test with networking disabled, matching production UID and resource limits; use conservative worker counts
   and memory settings rather than copying Strix's command defaults.
5. A missing tool/database/ruleset becomes a precise capability gap. Do not assume `--offline-scan` guarantees
   an installed database, or that a failed registry download means the tool cannot run offline.
6. Treat scanner findings as candidates requiring trace and validation, not confirmed vulnerabilities.

**Gate:** recipe runs reproducibly on the actual pinned image and adds value without network access.

## 13. Phase 8 — separate runtime capability workstream

**Not enabled by writing skills.** Each item requires its own design/security review and explicit scope approval.

| Order | Capability | Required controls before release |
|---|---|---|
| 1 | Managed local lab | Fresh target copy; approved test process; internal-only network; no host ports or external egress; bounded resources; disposable state and verified cleanup |
| 2 | Authenticated HTTP | Explicit controlled identities and origins; broker-owned secrets; redacted receipts; session isolation; no credential exposure in prompts or worker tickets |
| 3 | Bodies and additional methods | Explicit operation/mutation scope; body limits; controlled objects; separate approval for destructive actions; redirect-hop policy |
| 4 | Browser execution | Dedicated managed browser context inside confinement; scoped navigation, subresources and WebSockets; harmless proof markers; no host profile |
| Later | OAST / concurrency | Owned callback endpoint or controlled local responder; explicit egress; request/concurrency caps; reset and cancellation semantics |

Keep the current strict transport as the default. A local lab is not permission to access arbitrary private IPs.
Broker clients may request approved operations but may not create capabilities or widen scope. Re-run affected
playbooks and benchmarks after each capability lands.

## 14. Implementation sequence, tests and release boundaries

| Milestone | Work | Acceptance evidence |
|---|---|---|
| M0 | Baseline + worker-failure handling | Reproducible manifests; terminal failure cannot leave benchmark waiting indefinitely |
| M1 / P0 | Skill registry/read tools + capability snapshot | Unit denial tests, real broker tests, real-Pi lead/worker retrieval |
| M2 / P1 | Evidence/closure/export + three playbooks | Schema/migration/mutation tests; safe cleanup with durable receipts |
| M3 / P1 | Real-agent benchmark | A/B/C results and visible-worker holdout, no success claim based only on npm tests |
| M4 / P2 | One framework overlay + one tool recipe | Vulnerable/fixed fixtures and incremental benchmark evidence |
| Separate | Local-lab/auth/browser capabilities | Security review and fresh transport/cleanup integration tests |

Suggested modules: `src/skills.ts`, `src/capabilities.ts`, `src/evidence.ts`. Integrate into existing broker,
records, prompts and tool gates rather than add a second coordinator. Add focused tests under `tests/minimal/`
and extend existing Python library mutation tests. New scripts and schemas must be included in package files
where needed. Test both installed and development loadouts and native Pi skill discovery.

Update `README.md`, `docs/USAGE.md`, `docs/ARCHITECTURE.md`, `research/TAXONOMY.md`, `research/AUDIT.md` and
handoff examples only when the corresponding feature is implemented. Version numbers are release decisions,
not evidence of completion. Existing public tool/record formats need explicit compatibility handling.

## 15. Completion checklist

- [ ] Baseline and selected reference review/provenance recorded.
- [ ] Lead and worker can read approved skills, references and handoffs without arbitrary host access.
- [ ] Capability permission/availability/applicability are distinct and accurate.
- [ ] Evidence IDs, proof levels, candidate revisions and durable redacted export work end-to-end.
- [ ] Three playbooks pass content, prerequisite and vulnerable/fixed tests.
- [ ] Real Pi lead and visible P2O worker tested on the fresh `tmp` challenge copy.
- [ ] Benchmark report includes failures, raw outcomes, costs where available and limitations.
- [ ] Optional overlay/recipe retained only after measured benefit.
- [ ] Existing confinement, worker revocation and verified cleanup still pass.
- [ ] No production target or user credential was used without separate authorization.

**Decision at the end:** keep the original research-method library as the foundation; retain only additions that
make the agent's tests more reproducible, its evidence stronger, or its unsupported-scope reporting more honest.
