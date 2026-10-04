# pi-p2o: from a skill library to an executable assessment system

**Status:** architecture proposal, not implemented. **Research date:** 2026-10-02.

## Recommendation

Keep the current portable skill library. Add a **Pi-native orchestration extension**, a **durable supervisor**, **sandbox-bound tool adapters**, and **evidence/verification gates** around it.

Borrow **coordination semantics from Strix** and **Pi worker-launch mechanics from pi-ctf-solver**. Do not import either project's weaker assumptions about scope, isolation, completion, or verification.

This enables a path toward end-to-end **authorized assessments**: scope → discovery → prioritized hypotheses → bounded testing → independent validation → reporting → remediation/retest. It does not mean every target or test class becomes supported immediately, nor that a clean report proves complete coverage.

**Recommended first operational scope: web/API assessments, with optional source-assisted analysis.** Existing binary/fuzzing skills remain available, but their specialized runtimes should be later capability packs rather than mandatory MVP dependencies.

## Research provenance

One dedicated agent investigated each reference:

| Reference | Agent | Source snapshot | Detailed report |
|---|---|---|---|
| Strix | `worker-1fde8103` | `007ed1a94e7dbf7b096c81e5b0354533ce94e0db` | not retained (provenance commit pinned above) |
| Local pi-ctf-solver | `worker-b120fdfa` | `4bee9faa1d64c823a764c6ecc37b66905e08a32b` | not retained (provenance commit pinned above) |

Both agents verified harness selection of `openai-codex-account-3 / gpt-6.1-sol / max`. Their reports distinguish source inspection from runtime/security verification. Neither ran pentests, scans, challenge solving, or reference-project tests.

**Dispatch correction:** the successful `herd_spawn` calls were issued sequentially. The installed pi-herdr adapter calls `herdr agent prompt ... --wait`, so it waits for settled work; the earlier chat statement that these workers were concurrently running was incorrect. Future independent calls must be submitted together, or launched through an owned nonblocking runtime. There was one successful research agent per reference; the two initial default-runtime attempts failed.

The parent inspected pi-p2o's README, handoff contracts/template, representative skills, research dispatcher, and library validator. This proposal synthesizes those inspections and the two agent reports; it is not an implementation or a full security audit of any repository.

## 1. What exists today

The current project is primarily a **knowledge and evidence layer**:

- [17 technique-oriented skills](../../README.md#skill-router), selected by the current unresolved question.
- [H1–H6 handoff contracts](../../HANDOFFS.md) with scope, classification, evidence, limits, acceptance gates, and return conditions.
- A [handoff recording scaffold](../../templates/handoff.json), not an executable per-contract acceptance engine.
- Source provenance, curated research, and Python editorial/structural tests.
- A real but narrowly scoped research dispatcher: [`scripts/orchestrate_orange.mjs`](../../scripts/orchestrate_orange.mjs).

The dispatcher is worth preserving as experience: it has bounded concurrency, one source per worker, saved delegation records, identity-matched output checks, and refuses to silently duplicate incomplete assignments. However, it is hard-wired to the Orange corpus/model, imports installed pi-herdr internals through `jiti`, and is not a reusable assessment runtime. It does not provide target policy, tool provisioning, general task dependencies, sandboxing, or vulnerability verification.

**Main gap:** skills describe how to investigate; they do not provision tools, grant capabilities, schedule agents, enforce scope, or validate engagement outcomes. Adding another large prompt or more skills will not close that gap.

## 2. How the reference architectures actually work

| Dimension | Strix | pi-ctf-solver | Transfer to pi-p2o |
|---|---|---|---|
| Core technology | Python 3.12+, OpenAI Agents SDK, `asyncio`, Pydantic/Jinja, SQLite, Docker | Node 22+, TypeScript ESM Pi extension, TypeBox, child processes, Herdr CLI | Prefer a TypeScript Pi extension; avoid a second LLM runtime initially |
| Worker unit | Dynamically created specialist agent with task/skills | One logical challenge job; optional sequential replacement | One bounded hypothesis/question and its input revision |
| Delegation | `create_agent` → child factory → `asyncio.create_task`; children can spawn descendants | Route to direct Herdr, returned spawn-call plan, or managed headless Pi | One scheduler with explicit runtime capabilities and bounded fan-out |
| Communication | Coordinator graph, mailboxes, wake events, shared state tools | Mostly task prompts and filesystem artifacts; not a general conversation graph | Typed messages, evidence references, accepted handoffs, acknowledgments |
| Execution tools | Typed SDK function tools; sandbox shell/filesystem; proxy/browser/MCP integrations | Pi tool sets and explicitly loaded skills; optional web extension | Tool registry plus sandbox-bound adapters and policy checks |
| Isolation | One shared Docker sandbox/workspace per run, not one per agent | Logical workspaces/private headless HOME, but same-user host execution; no sandbox | Private task workspaces and enforceable runtime boundaries |
| Persistence | Agent SQLite histories, coordinator/state snapshots, report artifacts | Files and optional same-session handoff; scheduler mostly in memory | Durable run/task/attempt state, reconciliation, immutable evidence receipts |
| Completion | Explicit lifecycle tools; structured reports and coverage | Process exit, artifact presence/freshness, optional separate reproducer | Keep lifecycle, packet acceptance, and finding verification separate |

### Strix: most useful mechanisms

Its current agent engine is **OpenAI Agents SDK**, not a generic claim about an unspecified agent framework. The main source path is:

`run_strix_scan → build_strix_agent → create_agent → spawn_child_agent → run_agent_loop`.

The custom `AgentCoordinator` owns identities, parent/child relationships, statuses, messages, and wakeups. The SDK owns the inner model/tool loop. Each agent has a separate conversation session, but agents share the run configuration and sandbox.

Reuse conceptually:

1. Explicit finish/wait/stop/failure states and parent notifications.
2. Completion packets linked to actual stored report IDs, not just a worker's prose.
3. Separate notes, hypotheses/threat models, findings, and coverage.
4. Coverage distinguishing agent assertions from runtime-observed facts and untested gaps.
5. Bounded recovery and conditional session resume.

Do not copy unchanged: broad root/worker tool symmetry, shared writable source mounts, prompt-only target enforcement, unrestricted fan-out, or treating complete report fields as independently verified findings. Its report validation is not a mandatory independent reproduction gate.

Source anchors: [runner](https://github.com/usestrix/strix/blob/007ed1a94e7dbf7b096c81e5b0354533ce94e0db/strix/core/runner.py), [coordinator](https://github.com/usestrix/strix/blob/007ed1a94e7dbf7b096c81e5b0354533ce94e0db/strix/core/agents.py), [delegation tools](https://github.com/usestrix/strix/blob/007ed1a94e7dbf7b096c81e5b0354533ce94e0db/strix/tools/agents_graph/tools.py), [coverage](https://github.com/usestrix/strix/blob/007ed1a94e7dbf7b096c81e5b0354533ce94e0db/strix/report/coverage.py).

### pi-ctf-solver: most useful mechanisms

Its extension separates task/workspace preparation from delegation:

`ctf_solve / ctf_local → prepared task list → delegate → runtime adapter`.

Three routes have different guarantees:

- **Direct Herdr:** opens panes, starts agents, and delivers tasks. Initial layout changes are serialized; starts and prompts are concurrent. Return means launch, not completed research.
- **Spawn-call plan:** returns calls for the parent to issue. It does not own the workers' lifecycle.
- **Managed headless:** spawns Pi processes, bounds concurrency, collects logs/results, and can enforce explicit phase deadlines and controlled replacement.

The important lesson is **ownership**: a component cannot promise cancellation, hard deadlines, resume, or live observation for workers it does not control. Managed features cannot be inferred from a returned spawn plan.

Reuse conceptually: explicit task directories, runtime configuration, fresh-run identity, bounded launch queues, checkpoint/replace sequencing, parent-owned sensitive operations, and versioned lifecycle events. Do not copy flag-file-based success, inconsistent freshness rules, unbounded log accumulation, or logical workspace separation described as a sandbox. Its stronger reproducer script is separate from normal delegation.

Primary paths in `/home/nhanlaptop/project/pi-ctf-solver/`: `extensions/ctfctl/index.ts`, `delegate.ts`, `workspace.ts`, `local.ts`, `handoff.ts`, `dashboard.ts`, and `scripts/verify-reproducer.sh`. The detailed report provides exact symbols and qualifications.

## 3. Proposed architecture

```text
User / Pi command / future CI entry
              |
     Scope and run configuration
              |
    Planner / orchestrator agent
    (suggests tasks, does not grant itself authority)
              |
    Deterministic supervisor + policy engine
      | scheduling / leases / budgets / cancellation
      | durable events / accepted packet dependencies
      |
      +-- runtime adapter: managed headless Pi
      +-- runtime adapter: owned Herdr Pi
      +-- optional plan-only adapter: explicitly unmanaged
              |
     Workers with task-specific skills and capabilities
       surface mapping | static review | bounded testing
              |
     Tool broker -> isolated execution environments
       filesystem | HTTP/proxy | browser | analysis tools
              |
     Evidence store -> independent validation -> findings
              |
       Coverage + qualified report + optional retest
```

**The LLM proposes; deterministic code enforces.** Scheduling, action authorization, capability grants, artifact acceptance transitions, and durable publication must not depend solely on the model remembering instructions.

### A. Run manifest and machine-readable handoffs

Promote the existing envelope into versioned schemas and validators. Add:

- `runId`, `taskId`, `attemptId`, parent/dependency IDs, producer/consumer identity.
- Authorization reference, expiry, approved target identities and exclusions; a target list is not proof of permission.
- Input artifact hashes/revisions and environment/configuration identity.
- Question, contrasting predictions, requested skill set, allowed actions, stop conditions.
- Total deadline, per-task budgets, target-wide request limits, concurrency limits.
- Requested and observed provider/model/thinking, tool versions, and runtime capabilities.
- Evidence IDs, classifications, negative controls, failed assumptions, untested scope.
- Handoff gate decision, reviewer identity, reasons, and accepted output digest.

Validate contract-specific requirements, not just JSON shape. For example, H2 needs distinguishable predictions and a baseline; H6 needs shipped/deployed enforcement receipts. Allow explicitly static-only and unresolved outcomes. H1–H6 are composable edges, **not a mandatory linear pipeline**.

### B. Bounded task graph, not one agent per skill

A useful work unit is `(question, surface, actor, input revision)`. One worker may load several relevant skills. Launch independent questions in parallel; wait for accepted evidence when a task genuinely depends on another.

Use a global concurrency limit, maximum task count/depth, per-target traffic budget, and an ownership lease per task attempt. State-changing tests sharing accounts or fixtures may need serialization even when read-only review can run concurrently. Workers request additional tasks; the supervisor admits or rejects them.

Make `start()` return a handle promptly and separate it from `wait()`. Distinguish `prompt-delivered`, `working-observed`, and `result-accepted`. Serialize Herdr layout mutation, not the entire research operation. Test that two ready tasks actually overlap in execution.

### C. Runtime ownership and recoverability

Define an adapter contract around `preflight / start / observe / checkpoint / stop / resume / collect` and advertise capabilities such as `ownsLifecycle`, `canHardStop`, `canResume`, `streamsEvents`, and `attestsRuntime`.

Start with an owned **headless Pi process adapter**; add visible Herdr workers on the same task contracts. A plan-only adapter must not claim equivalent management or isolation. Avoid depending on private installed pi-herdr modules.

Persist state in SQLite transactions, with a durable event/outbox table and exportable redacted JSONL receipts. Use separate attempt IDs, idempotent result admission, bounded streaming logs, heartbeats, and parent-restart reconciliation. After a crash, an unknown worker must be reconciled, not assumed successful or duplicated.

Use one absolute job deadline across preparation, execution, checkpoint, and replacement. Reserve reporting time. Cancellation stops new scheduling, terminates owned execution, checks termination, flushes receipts, and releases leases. Resume checks scope validity and artifact identity; a replayed conversation is not a restored browser/process environment.

### D. Tool provisioning and enforced scope

Add a capability registry describing tool identity/version, installation or image source, input/output schema, supported platforms, side effects, timeout/output limits, and evidence collector. A `doctor`/preflight action reports missing capabilities before a worker starts. Pin runtime images/tool versions; do not ask agents to install arbitrary latest tools during an engagement.

Suggested first packs:

| Pack | Purpose | Boundary |
|---|---|---|
| Source analysis | Search, AST/static analysis, dependency review, redacted secret indicators | Read-only input checkout; isolated generated outputs |
| Web/API | Browser observation, schema/route mapping, HTTP/proxy evidence and bounded differential tests | Approved destinations/accounts/actions; rate limits and isolated sessions |
| Service inventory | Identify explicitly scoped reachable services | Target-wide request limits and approved protocols |
| Native/lab, later | Binary inspection, tracing, fuzzing and crash reproduction | Dedicated lab images/VMs, resources and recovery policy |

The broker must enforce scope at dispatch and at network connection time, including redirects and DNS changes. Documentation/model-provider traffic and target traffic have different policies. A proxy visibility filter or URL check alone cannot constrain arbitrary shell networking.

All worker execution/filesystem tools must bind to the worker's sandbox. Never leave unrestricted host Bash available beside a nominally restricted HTTP tool. Use read-only trusted inputs, private writable task outputs, no host home/credential mounts or Docker socket, resource limits, and default-denied network access. Model credentials should remain behind a credential-owning boundary rather than in task artifacts. Container/VM choice depends on the threat model; containers alone do not establish hostile-code isolation.

### E. Verification and coverage as first-class state

Maintain separate state machines:

- **Process:** queued / starting / running / waiting / exited / failed / timed-out / cancelled.
- **Packet:** draft / ready / schema-valid / accepted / returned-for-evidence.
- **Finding:** candidate / supported-static / reproduced / independently-validated / rejected / unresolved.

An exit code, new file, model consensus, or second agent's approval is not sufficient verification. Preserve collected receipts outside worker write authority, record tool/configuration/input identities, and validate references and controls. For reproducible lab findings, have a separate verifier replay the smallest authorized check in a clean environment; for static-only claims, preserve that classification instead of inventing a replay.

Store coverage per surface/actor/test question: tested, ruled out with evidence, blocked, untested, not applicable with reason. Reports must include unresolved gaps and execution failures. A completed engagement may honestly be incomplete; it must not be labelled comprehensive without evidence.

### F. Role separation

- **Orchestrator:** plans, dispatches, reads accepted summaries, requests review; no default target-execution capability.
- **Specialist worker:** investigates one bounded question using selected existing skills.
- **Verifier:** checks evidence and, when explicitly allowed, independently reproduces a result; cannot silently widen scope.
- **Reporter:** renders accepted facts, limits, coverage, and remediation guidance; does not convert hypotheses into confirmed findings.

Implement these as capability profiles, not just names or prompt text. Target pages and worker messages remain untrusted data. Prefer accepted handoff packets and evidence references over copying an entire parent conversation into every child.

## 4. Suggested project organization and stack

Illustrative new paths; none of these runtime modules has been implemented:

```text
skills/                       # keep the existing portable methods
HANDOFFS.md                   # keep the human-readable contracts
templates/                    # examples / recording scaffolds
extensions/p2o/index.ts        # Pi tools/commands; thin entry point
src/contracts/                # run/task/evidence/handoff schemas
src/orchestrator/             # admission, queue, dependencies, budgets
src/runtime/                  # headless, Herdr, explicit plan-only adapters
src/policy/                   # scope/capability decisions
src/tools/                    # sandbox-bound capability adapters
src/evidence/                 # receipts, artifact admission, verification
src/reporting/                # findings, coverage, Markdown/JSON/SARIF
src/store/                    # durable state/events/migrations
containers/                   # pinned optional execution packs
tests/runtime/                # inert fake workers and lifecycle tests
tests/fixtures/               # deterministic local assessment fixtures
docs/architecture/            # this proposal and reference reports
```

Use **TypeScript/Node + Pi extension APIs + runtime JSON-schema validation + SQLite + containers/VM adapters where required**. TypeBox is a natural schema option because the existing CTF extension uses it; actually run validators rather than relying on TypeScript types. Select a maintained SQLite driver after confirming the supported Node range.

Pi already provides model/provider sessions and tools. Do not initially add OpenAI Agents SDK, LangGraph, Redis, Kubernetes, or a second LLM loop merely because another project uses agent graphs. Add distributed infrastructure only if measured multi-host requirements justify it. Read the installed Pi API documentation and examples before implementation, and pin supported Pi/Herdr versions with contract tests.

## 5. Phased upgrade with acceptance criteria

| Phase | Deliverable | Acceptance gate |
|---|---|---|
| 0 — Executable contracts | Schemas, run manifest, H1–H6 validators, explicit runtime capability model | Missing scope/evidence and false completion are rejected; static/unresolved packets remain representable |
| 1 — Managed research MVP | Pi extension, headless workers, durable scheduler, evidence store, read-only fixture workflow | Two independent tasks overlap; restart/timeout/cancel work; stale results and duplicate writers are rejected |
| 2 — Authorized web/API lab | Sandbox/tool broker, browser/HTTP adapters, rate limits, verifier, coverage report | Known-positive, known-negative, and inconclusive fixtures are classified correctly; scope-escape attempts are blocked |
| 3 — Operational usability | Herdr adapter, optional dashboard, checkpoint/replacement, remediation/retest records | Same contract across runtimes; effective runtime receipts; failures/gaps visible; approvals and stop controls work |
| 4 — Additional domains | Native/fuzzing/cloud or other explicitly selected packs | Each pack supplies prerequisites, scope rules, isolation and deterministic verification fixtures before being advertised |

Do not put a dashboard ahead of lifecycle and evidence correctness. Do not start every one of the 17 skills as an agent. Do not promise generic “complete pentesting” before domain coverage and tool/runtime support are measured.

**First useful vertical slice:** an explicitly scoped local web/API fixture, a mapping worker, two independent hypothesis workers, one verifier, and a report that accurately includes both accepted findings and untested/blocked questions. This exercises the missing architecture without depending on live external targets.

## 6. Checks and limits of this work

- Detailed reference reports were copied into this directory and SHA-256 checked against the agents' originals.
- No executable project code, skill, template, or existing research artifact was changed. Only architecture documentation was added.
- Parent ran the existing offline command `PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate_library.py`.
- It reported an existing failure: `skills/attack-surface-mapping/SKILL.md: tools lack purpose/when mapping`. The `pi-web-access` bullet lacks the required `tool → purpose → when` format. This was left unchanged because the task was architecture research, not a library edit.
- The current working directory is not a Git repository, so Git diff/clean-state evidence is unavailable for pi-p2o. The CTF reference agent recorded its reference checkout as having no tracked changes.
- No reference test suites, model-quality benchmarks, security-boundary tests, pentests, target requests, installations, or runtime implementation were performed.

**Bottom line:** retain pi-p2o's research methods and stricter evidence discipline; make them executable through a small Pi-native control plane with real runtime ownership, constrained tools, and independent acceptance gates.
