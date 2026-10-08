# P2O enhancement plan: tool guidance and evidence-led reconnaissance

**Status: implemented, pushed, reinstalled and verified with local/inert runtime acceptance.**

Implemented: capability subsystem removal, descriptive prerequisite migration, shared recon/decision guidance,
aligned handoffs/skills/templates and regression fixtures. Verification is local and model-inert: no external
assessment or paid agent run is authorized or implied. Results, installed implementation revision and scope limitations are recorded in
`research/runtime/recon-upgrade/README.md` and its acceptance receipts. Autonomous quality comparisons and paid
agent tests were not performed; the local URL fixture remains conditional/deferred without relaxing scope.

This plan replaces the previous roadmap. It covers removal of the redundant capability subsystem and improvement of reconnaissance, investigation selection, worker handoffs and verification. It does not authorize external-target testing, new transports, credentials, package installation or paid agent runs.

## 1. Goals

1. Use Pi's active tool descriptions and schemas as the model-facing tool contract instead of a separate `p2o_capabilities` tool and capability table.
2. Make reconnaissance produce a useful, evidence-linked surface inventory and ranked investigation queue.
3. Base the next task on observed surfaces, trust boundaries and unresolved questions rather than generic scanning or exhaustive enumeration claims.
4. Preserve owner/broker enforcement, isolated workers, bounded execution, candidate closure, evidence exports and verified cleanup.
5. Verify shipped behavior after **commit → push → Pi reinstall**, not only with tests against the development checkout.

Success means simpler instructions and reviewable investigation decisions. It does not mean broader permissions or demonstrated improvement in vulnerability detection without adequate comparative evidence.

## 2. Basis: Pi session and Strix references

### Pi session observation

The supplied session export is:

`tmp/pi-session-2026-10-08T01-56-20-472Z_01a11939-cb76-7128-be85-9c9da4515a68.html`

Its active tools already describe execution constraints: `p2o_shell` is offline sandbox execution with bounded timeout/output; `p2o_http` is same-origin GET/HEAD without credentials or redirects. The assessment prompt also includes a long capability snapshot. Remove that duplicate mechanism, but retain concise target-specific scope instructions.

Tool guidance is not a functional availability check: a tool description cannot establish that Semgrep or a dependency exists inside the sandbox. Such questions still need a bounded, relevant execution through `p2o_shell`.

### Strix references

The inspected local Strix checkout is reference material only; do not commit `my_references/` or introduce it as a runtime dependency.

| Reference | Observed approach | P2O adaptation |
|---|---|---|
| `my_references/strix/strix/agents/prompts/system_prompt.jinja`, “MANDATORY INITIAL PHASES” | Black-box surface/technology mapping; white-box architecture, handlers, data flows and access-control understanding before targeted investigation | Separate URL and source recon instructions; require evidence-linked mapping relevant to a particular investigation |
| Same file, “ROOT AGENT ROLE” and “WHEN TO CREATE NEW AGENTS” | Root coordinates; specialized tasks emerge as new surfaces or candidates appear | Delegate reactively with one objective, known facts, owned coverage and stop conditions; retain P2O's working-lead role |
| Same file, coverage/threat-model guidance | Shared context, coverage and open items support subsequent work | Use P2O's existing ledger and worker reports to preserve actors, boundaries, surface inventory and unresolved questions |
| Same file, vulnerability workflow | Discovery → separate validation → reporting | Preserve independent validation requirements; do not equate a worker report with verified proof |
| `my_references/strix/strix/skills/scan_modes/quick.md` | Rapid orientation followed by high-impact targets rather than exhaustive discovery | Bound recon by scope and budget; select the next task by evidence and likely impact |

In the inspected Strix instructions, the phase transition is model judgment, not a quantified software-enforced mapping threshold. There is also tension between comprehensive initial mapping and quick mode's limited orientation. P2O should adopt useful handoffs, not claims that the entire target has been mapped.

Do not copy Strix's broader scanning, authenticated crawling, installation, external research or agent-spawning assumptions into P2O permissions.

## 3. Invariants

- The owner and broker enforce authorization; prompts and tool descriptions are not security boundaries.
- Directory targets use read-only source snapshots and offline scratch execution. URL targets remain exact-origin public GET/HEAD under existing enforcement.
- No authenticated HTTP, request bodies, browser transport, OAST, network scanning or parallel race testing is added by this plan.
- Target content and worker outputs remain untrusted data, never instructions.
- Missing information or unavailable execution stays an explicit gap, never a clean result.
- Evidence receipts preserve observations; candidate records remain attributed claims requiring review.
- Independent validation requires separate-worker evidence, not repeated self-assertion.
- Keep deadlines, command budgets, nesting/focus limits, broker ownership, cancellation and cleanup verification.
- Historical exports and benchmark receipts are immutable evidence of their original runtime. Do not rewrite them to hide removed features.

## 4. Phase 1 — remove the capability subsystem

### Deliverable

No active `p2o_capabilities` tool, broker operation, capability snapshot or capability-ID dependency remains in the runtime/library contract.

### Implementation scope

1. Remove tool registration and owner/worker tool-list entries in `extensions/p2o/index.ts`.
2. Remove the broker knowledge operation for capabilities in `src/broker.ts`.
3. Remove capability snapshot state, prompt blocks, initialization, worker synchronization and export metadata from newly generated assessments.
4. Remove `src/capabilities.ts` and capability-specific `src/probes.ts` after migrating all imports and callers.
5. Remove capability-derived workflow warnings from delegation. Retain skill and workflow existence validation if workflow IDs remain useful.
6. Replace catalog `allOf`/`anyOf` capability-ID requirements with concise descriptive prerequisites, where necessary. Update skill sidecars, catalog readers and Python validators together. Avoid a renamed replacement capability registry.
7. Preserve candidate `execution` states. Replace capability-ID validation of a blocked candidate's `requirement` with a bounded descriptive reason, including the actual scope restriction, missing tool or failed prerequisite. Keep `blocked` candidates in `open_proof_gap`.
8. Remove capability-specific benchmark counters and assertions from current scoring, acceptance scripts and tests. Historical results may still contain those fields and must remain readable.
9. Update README, runtime/usage/architecture documentation, handoffs and recipes to remove active references to the removed tool.

### Replacement guidance

- Put tool-specific constraints in registered descriptions and parameter schemas.
- Keep target-specific scope and lifecycle rules in owner/worker instructions.
- State explicitly that installed binaries are not guaranteed by tool availability.
- When a selected task needs an unknown binary, use a bounded offline functional check through `p2o_shell`; record its receipt and relevant failure. Do not run universal startup probes.
- Preserve safe local scanner controls: no registry configuration, metrics/version network checks or automatic installation.
- Executor-stop behavior must continue to reject further target operations even without a capability snapshot.

### Gate

Active registrations and broker dispatch expose no capability operation. Owner and worker prompts contain no capability table. Invalid operations are rejected. Candidate evidence/provenance validation and executor-stop behavior still pass. Historical artifacts are unchanged.

## 5. Phase 2 — define the reconnaissance handoff

### Deliverable

One reusable recon contract shared by lead instructions, recon-worker briefs, attack-surface guidance and handoffs. Use existing ledger/report tools; do not add a new recon-status tool unless later evidence proves it necessary.

### Required outputs

Each surface entry should identify:

- Surface ID and component/route/interface.
- Entry point and accepted input representation.
- Observed actor or principal; inferred identity must be labeled.
- Authentication/authorization gate and handler location, if observable.
- Relevant trust boundary, sensitive consumer or data flow.
- Same-run evidence IDs and extraction method.
- Observation versus inference versus hypothesis.
- Mapping limitations, deployment uncertainty and remaining questions.
- Suggested investigation, rationale and prerequisites.

The handoff also summarizes target identity, available context, covered areas and untested scope. Do not fabricate version, deployment exposure, handlers or policy from names alone.

### URL reconnaissance

Within existing authorized GET/HEAD behavior:

- Inspect the initial response, headers and permitted same-origin links.
- Map visible routes, forms, input names, referenced scripts and API hints using bounded retrieval and offline analysis.
- Treat technology/version fingerprints and JavaScript route hints as hypotheses until supported.
- Record prohibited or inaccessible authentication-dependent flows as gaps.
- Do not enumerate other origins, scan ports, follow unauthorized redirects or submit forms.

### Source reconnaissance

- Map repository structure, framework registration, entry points and handlers.
- Trace selected inputs to access checks and sensitive consumers.
- Identify relevant authentication, authorization, serialization, output and asynchronous boundaries.
- Inspect dependency declarations without assuming deployed versions or fetching packages.
- State source-copy exclusions, including absent Git history and omitted dependencies.
- Use benign bounded offline checks where useful; source presence alone does not establish live exposure.

### Gate

An unfamiliar target produces a reviewable surface inventory with evidence and unknowns before focused discovery, unless the user already supplied a sufficiently specific question. No requirement to “map everything” or invent completeness.

## 6. Phase 3 — evidence-led next-task selection

### Deliverable

A concise decision routine in lead instructions and handoffs, using existing `p2o_note`, `p2o_ledger`, `p2o_workers` and delegation tools.

### Decision sequence

1. Read scope, available target context and existing coverage before duplicating recon.
2. Establish a working actor/trust-boundary model; label assumptions and update it when evidence contradicts them.
3. Select a surface with enough context for a specific security question.
4. Prioritize by reachable attacker influence, sensitive effect, boundary ambiguity, evidence strength, expected information gain and remaining budget. These are qualitative reasons, not a fake numerical risk score.
5. Record the decision: selected surface/risk, supporting evidence, uncertainty, expected observation and why this task is next.
6. Perform one focused discovery task locally or delegate when specialization, parallel coverage or independence materially helps.
7. A plausible candidate goes to separate validation when feasible. Report unavailable validation as a proof gap.
8. A validated finding proceeds to reporting with reviewed evidence and counterevidence. New surfaces feed back into the inventory.

### Transition rules

| Observation | Next action |
|---|---|
| Entry point or gate is unclear | Focused mapping task |
| Concrete boundary concern with a traceable surface | Discovery task |
| Plausible candidate lacks decisive evidence | Bounded validation task |
| Separate worker reproduces the effect | Review evidence, then reporting |
| Specific effective control is demonstrated | Record ruled-out candidate and relevant coverage |
| Scope restriction, missing dependency or deployment uncertainty blocks proof | Record open proof gap; investigate another feasible surface |
| Recon repeatedly produces no new relevant information | Stop that branch; summarize its coverage and limitations |

Recon and discovery may overlap across different surfaces. Transition on a particular surface does not certify whole-target coverage or authorize a new kind of request.

### Gate

The next task can be traced to prior observations. No duplicate surface+risk assignment. Worker briefs include objective, known facts, evidence IDs, owned coverage, success criteria and stop conditions.

## 7. Phase 4 — prompt, skill and handoff alignment

- Update `src/prompts.ts` to remove capability duplication and explain the recon/decision loop compactly.
- Update recon-role defaults/briefs without turning every assessment into mandatory worker spawning.
- Align `HANDOFFS.md`, handoff templates, attack-surface mapping and the web route-inventory playbook.
- Preserve general techniques and provenance; avoid broad corpus rewrites unrelated to this change.
- Keep policy inference explicit: differing sibling routes do not establish intended authorization policy.
- Require reports to distinguish reviewed, tested, ruled out, blocked and untested surfaces.
- Keep lead evidence review and separate-worker validation distinct from Strix's orchestration-only root role.

**Gate:** instructions agree across owner, worker, skill and handoff documents; no contradictory capability calls or exhaustive-mapping claims remain.

## 8. Phase 5 — regression and installed-runtime verification

### Automated checks

- Typecheck, build/import and full TypeScript/Python suites.
- Catalog, provenance, links and generated-document freshness checks.
- Owner/worker active tool lists and broker unknown-operation rejection.
- Tool guidance and concise scope instructions available in actual Pi sessions.
- Blocked candidate reasons, evidence references, policy provenance and revision validation.
- Shell timeout/cancellation, stopped executor behavior, scope enforcement and cleanup.
- Benchmark compatibility: new runs omit capability counters; old receipts remain interpretable.
- Package dry-run excludes `my_references/`, scratch targets and private session exports.

### Controlled recon fixtures

Use inert local fixtures with evaluator truth outside target snapshots:

1. Source app with several routes, an access gate and a separate asynchronous consumer.
2. Incomplete source snapshot with deployment/history uncertainty.
3. Local URL fixture, only if it can run through an explicitly authorized isolated test mechanism without weakening public-target enforcement.
4. Missing optional scanner binary: no installation; relevant gap recorded through ordinary shell evidence.
5. Recon result that contradicts an initial identity/boundary assumption and requires a corrected next-task decision.

Check inventory accuracy, evidence links, unsupported assertions, decision rationale, duplicated work, preserved gaps and cleanup. Do not score lexical mention of a vulnerability as successful discovery.

### Shipping sequence

1. Review changes and run local gates.
2. Commit and push the approved implementation.
3. Run `pi install https://github.com/Nhan-Laptop/pi-p2o`.
4. Verify the installed revision and hashes against the pushed tree.
5. Exercise the installed extension in real Pi: tool discovery, recon handoff, next-task selection, candidate recording and cleanup; include a visible worker when authorized.
6. Save bounded, sanitized acceptance evidence and document failures honestly.

Live/paid runs require fresh explicit authorization. If authorized, every newly spawned live agent must use:

```sh
pi --model gpt-6.1-sol --provider openai-codex-account-3 --thinking xhigh
```

Do not automatically restart the earlier benchmark. It was finalized by user request after 18/72 clean completed runs. Earlier bytecode-confounded campaigns and this partial dataset cannot establish comparative effectiveness of the proposed changes.

## 9. Non-goals

- New authenticated, browser, OAST, network-scanning or state-changing transports.
- Replacing enforcement with tool descriptions.
- Automatic dependency installation or provider fallback.
- Copying Strix's entire corpus, aggressive testing assumptions or agent proliferation.
- A new mandatory capability registry, universal tool probe or phase-status API.
- Rewriting historical receipts or claiming universal target safety.
- A fresh paid benchmark without permission.

## 10. Acceptance checklist

- [x] Remove the capability tool, broker operation, snapshot, fixed probe subsystem and capability-ID coupling.
- [x] Retain concise tool guidance and target-specific scope/lifecycle instructions.
- [x] Preserve evidence, policy provenance, blocked-state semantics and enforcement behavior.
- [x] Define and align evidence-linked recon inventories and worker handoffs.
- [x] Explain and mechanically exercise evidence-led next-task selection and feedback into recon (not autonomous model quality).
- [x] Preserve independent validation, coverage reconciliation and verified cleanup.
- [x] Pass automated regression, library and package gates.
- [x] Commit → push → reinstall with Pi; verify installed identity.
- [x] Verify installed runtime behavior with authorized local/inert tests and bounded receipts (not paid agents).
- [x] Document actual verification scope, unresolved gaps and benchmark limitations.

## 11. Suggested implementation order

1. Remove capability dependencies end-to-end, including catalog/candidate migration and tests.
2. Align tool descriptions, owner/worker scope guidance and recipes.
3. Add the recon handoff and qualitative decision routine.
4. Align skills, templates, documentation and controlled fixtures.
5. Run regression gates; review the diff.
6. Commit, push and reinstall; perform authorized installed-runtime acceptance.

Implement these as reviewable increments. Do not mix transport expansion or broad skill-library changes into this release.
