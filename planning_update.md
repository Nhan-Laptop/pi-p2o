# planning_update.md — the prompt/skill surface sent to a delegated worker

Status: **planning only. No code changed in this pass.** Written 2026-10-21. Supersedes the previous (uncommitted)
"simplifying p2o's operator and tool surface" pass: its D1 (dashboard removal), S2 (merge worker-management tools) and S1
(retire bespoke list+detail commands) are implemented and green; S3 (`--mode` preset flag) was not started and is carried
over unchanged below. That pass's own ARTEX/Strix architecture citations (`git show b3789cd:planning_update.md`) are reused
here, not re-derived.

**The prompt that started this pass:** the project is confusing in how it builds the prompt/skill package it sends to a
delegated agent. Re-examine that specific surface — the system instructions, the first-turn brief, and the skill-delivery
mechanism — against how ARTEX and Strix do it, and propose what to change.

## Carried over from the last pass (uncommitted, still true)

S3 (`--mode solo|team|team-isolated` preset flag) is still open; nothing here changes its status. D1/S1/S2 are implemented
and `npm test` is green except the pre-existing `test_provenance_record_matches_review_snapshot` Python failure (unrelated,
documented in memory).

---

## 0. Method

No new reference reading was needed: the ARTEX/Strix prompt-and-skill architecture (§1.1 delegation, §1.2 constraints,
§2 Strix skills/prefix layout) is already documented with file:line citations in the superseded study
(`git show b3789cd:planning_update.md`). This pass re-reads p2o's own prompt-assembly code — `src/prompts.ts`,
`src/roles.ts`, `src/skills.ts`, the `spawnWorkerLocked`/`prepareMethod` path in `extensions/p2o/index.ts`,
`docs/SKILL_RUNTIME.md` — and compares it line-for-line against those citations. Two measurements below are new and use
the same no-model-call method as the superseded study's U3/U7 ("measure first"): a small script imports the real,
built `workerBrief` (`dist/src/prompts.js`) and compares its output for two synthetic sibling workers; nothing was run
against a target, a model or a paid provider.

---

## 1. How ARTEX and Strix hand a delegate its prompt and its skill

Reused verbatim from the superseded study (not re-derived):

| | What a delegate's prompt is built from | How many knobs choose its "method" |
|---|---|---|
| **ARTEX** | No skill system at all. Operator constraints are injected into *every* Planner and Worker system prompt, self-contained, framed above all heuristics (`constraints.go`). A resumed worker does **not** get re-sent the global overview — a bug the core doc calls out (`worker.go:488,508-511`) | 0 — there is nothing to select |
| **Strix** | `create_agent(skills≤5)`; the model picks from `<available_skills>` itself. Prompt layout is **shared prefix → requested skills → scope**, with a cache breakpoint placed so sibling agents sharing the same skill selection share a cached prefix (`prompt.py:161`, SP:519-527). A post-hoc check flags any carried skill with no matching coverage row (`report/coverage.py:230`) | 1 (`skills`) |
| **p2o (today)** | `workerInstructions` (static, already reordered so siblings share ~95%+ of it — U3, already shipped) + `workerBrief` (per-spawn: identity, focus, scope, inherited context, **given skills**, operator constraints, task) | 3 (`skills[]` + `workflow` + `methodReason`), described below |

p2o's worker *system* prompt already matches Strix's intent (push skill text once, share what can be shared — that was
U3). This pass is about what U3 **didn't** touch: the brief, and the three-knob method-selection surface sitting on top
of the one-knob thing Strix does.

---

## 2. Three findings, each with file:line evidence

### Finding A — the brief puts the one thing that could be shared last, and the one thing that never can be shared first

`workerBrief` (`src/prompts.ts:110-138`) opens with `[p2o worker ${ticket.workerId} · role ... · depth ... · run ...]`
and `You are ${ticket.workerId}; ...` — both unique per worker — then focus/scope/limits/context (also unique), and only
*then*, conditionally, the `== Given skills ==` block, which is **identical** for every worker who got the same role
default or the same explicit skill selection. Strix does the opposite on purpose: shared prefix, then skills, then the
part that varies (SP:519-527, `prompt.py:161`), specifically so sibling agents given the same skill can share a cached
prefix. p2o's own `workerInstructions` was already reordered the same way for exactly this reason (U3, shipped
2026-10-21) — the brief was not.

**Measured** (2026-10-21, `dist/` build, no model call, synthetic two-worker brief with one shared skill, same method
the superseded study's U3 used): with today's field order, two sibling briefs share **14 of ~4,940 characters (0.3%)**
— the match breaks inside the worker-ID literal on line 1. Rebuilding the same brief with the skills block moved first
and the per-worker identity/focus/scope/context/constraints/task moved to the end (mirroring `workerInstructions`'
U3 reorder exactly) raises the shared prefix to **4,146 of ~4,940 characters (84%)** in that synthetic case — the entire
skill body, which is often the largest single piece of brief text once a worker has a real multi-KB `SKILL.md`.
*Caveat, stated the same way U3 stated its own:* this is a character count, not a token-cache guarantee; whether it saves
anything depends on provider-side caching behavior and sibling timing, neither measured nor measurable without a paid run.

### Finding B — the lead's `workflow` choice is computed, validated, hash-pinned... and never reaches the worker

`p2o_task`/`p2o_delegate` accept an optional `workflow` ID that must belong to one of the task's selected skills
(`extensions/p2o/index.ts:887-890`); `prepareMethod` (`:880-891`) resolves it to `{id, description, prerequisites,
skillId}` and stores it on the task's `method` (`src/tasks.ts:13`); a stale re-send is rejected (`TASK_METHOD_STALE`,
`:450`). `docs/SKILL_RUNTIME.md:13-14` documents that this ID is *validated* against the assigned skills — it says
nothing about delivery, because there is none. `spawnWorkerLocked` builds `skillDocs` from the skill's raw `SKILL.md`
text only (`:452-463`) and calls `workerBrief({ ..., skills: skillDocs, ... })` (`:512`) — `workerBrief`'s signature
(`src/prompts.ts:110`) has no `workflow` parameter. The catalog entry the lead actually read before choosing — e.g.
attack-surface-mapping's `offline-reproduction` workflow: *"Bounded offline execution; check target runtime/dependencies
with a real probe first"* plus its named prerequisite (`skills/catalog.json`) — is real, specific guidance the lead
validated and paid a hash-staleness check to pin, and the worker executing under it never sees it. This is the same
shape of gap the superseded study already found and fixed once (U1: the stored objective wasn't reaching workers
either) — here it is the workflow, not the objective.

### Finding C — three knobs for one concept, where Strix has one and ARTEX has none

`skills[]` (≤3, `MAX_SKILLS` in `src/roles.ts:30`, already schema-capped at the tool level so the `.slice` in
`resolveRole:139` is unreachable defensive code, not a real truncation path — checked, not a finding) +
`workflow` (optional, must belong to a selected skill) + `methodReason` (free text, stored but — see Finding B's
sibling question below — also never shown to the worker) is three knobs where Strix's `create_agent` has exactly one
(`skills≤5`) and ARTEX has zero (no skill system at all). Some of this is justified — `workflow` lets one skill name
several different applications (attack-surface-mapping alone has three: `source-review`, `offline-reproduction`,
`public-http-review`) which Strix's flat skill list cannot express — but right now that justification is theoretical,
because Finding B means the distinction never reaches the agent meant to act on it. `methodReason` has the same
question mark: it is stored as an audit trail (visible to the owner via `p2o_task view`) and may be intentionally
owner-only, same as a `p2o_plan` decision's `reason` field — that one is a weaker claim than Finding B's and is not
proposed as a change here, only asked below.

---

## 3. Proposals

Ranking = value ÷ (cost × risk), same convention as the superseded study. Every item states what it would **not** do.

### Tier A — small, deterministic, low risk

**P1. Carry the selected workflow's description/prerequisites into the worker's brief.**
*Evidence:* Finding B.
*Change:* add an optional `workflow?: { id: string; description: string; prerequisites?: string[] }` parameter to
`workerBrief` (`src/prompts.ts:110`); render it as a fixed block next to `== Given skills ==` (e.g. `WORKFLOW: <id> —
<description>` plus a `Prerequisites:` line when present). Pass `method.workflow` through at the one call site that
already has `method` in scope (`extensions/p2o/index.ts:512`, same object `prepareMethod` returned at `:449`).
*Not:* does not add a new owner-facing parameter — `workflow` is already accepted and validated today; this only
delivers what is already computed. Does not touch `methodReason` (see the open question below).
*Effort XS. Risk:* brief-hash churn only — byte-identical output when no `workflow` was selected (the common case
today), same contract U1's constraints block used. *Tests:* `recon.test.ts:68-95` (`briefHash` pins) needs a new case
with a workflow set; existing no-workflow cases stay byte-identical and should not need re-pinning.

**Implemented 2026-10-21, uncommitted.** Added `workflow?: { id, description, prerequisites? }` to `workerBrief`'s input
(`src/prompts.ts:114`), rendered inside the existing skills-conditional block right after `== End of given skills ==`:
`WORKFLOW: <id> — <description>` plus an optional `Prerequisites: <joined>` line, present only when `workflow` is set.
`spawnWorkerLocked` now passes `workflow: method.workflow` (`extensions/p2o/index.ts:512`), the same `method` object
`prepareMethod` already returned at `:449` — no new computation, only delivery of what was already there. Verified by
direct call (not just inspection): a brief built without `workflow` is unchanged byte-for-byte from before this change;
one built with `workflow` renders the new block correctly. `methodReason` is untouched, per *Not* above.
No deviation from the plan above.

**P2. Split the `KNOWLEDGE` prompt constant into one sentence per topic.**
*Evidence:* `src/prompts.ts:5` currently packs four unrelated topics into one unlabeled paragraph: catalog-read
mechanics (`p2o_skill_list`/`p2o_skill_read`, pagination, linked IDs), what a document hash identifies (package text,
not target evidence), how to read a tool's own description (execution limits, not installed binaries), and sandbox
tool-install policy (install in scratch, record the receipt, never treat an install as target evidence). Strix's system
prompt is organized by topic with its own headings (SP:3-11, 92-128); ARTEX's constraints doc requires the same
("constraints must be self-contained", `constraints.go`). p2o's text is accurate but reads as one run-on idea where it
is actually four.
*Change:* break `KNOWLEDGE` into four short, separately-readable sentences (no wording changes beyond what splitting
requires); keep it one constant, concatenated the same way, so the rendered character count is unchanged or smaller.
*Not:* no content change, no new guidance, no tool-list change.
*Effort XS. Risk:* none functional — pure text reflow. *Tests:* instruction-hash pins in `recon.test.ts` /
`workflow-policy.test.ts` move on purpose, same as every prior text-only change in this family (U2, U3 step 2).

**Implemented 2026-10-21, uncommitted.** Split into `KNOWLEDGE_CATALOG`/`KNOWLEDGE_HASHES`/
`KNOWLEDGE_TOOL_DESCRIPTIONS`/`KNOWLEDGE_SANDBOX_INSTALL` (`src/prompts.ts:5-9`), one topic each, composed back into
the single `KNOWLEDGE` constant with `.join(' ')`. **Deviation from the plan's own risk note:** the four sentences
concatenate to the exact original string (verified by direct string comparison against the pre-edit text), so this
needed **no** instruction-hash re-pin at all — better than the "moves on purpose" outcome anticipated above. Full
`npm test` confirms: `recon.test.ts`/`workflow-policy.test.ts`/`extension.test.ts` (the three suites touching
`workerInstructions`/`workerBrief` hashes) pass unchanged. No deviation in content, only in the predicted test impact.

### Tier B — moderate, measure-first (mirrors the superseded study's U3/U7 pattern)

**P3. Reorder `workerBrief` so same-skill siblings can share a prefix, the way `workerInstructions` already does.**
*Evidence:* Finding A. *Step 1 measured (2026-10-21, no model call):* today's order shares 14 of ~4,940 characters
(0.3%) between two synthetic same-skill siblings; moving the skills block to the front and the per-worker
identity/focus/scope/context/constraints/task to the end (same shape as `workerInstructions`' own U3 reorder) raises
that to 4,146 of ~4,940 (84%) in the same synthetic case.
*Step 2 (only if it pays):* apply the reorder to `src/prompts.ts`'s real `workerBrief`. The per-worker identity line
moves to the end, same place U3 put it in `workerInstructions`; the brief still opens with *something* static (a fixed
label line) so the first bytes match across every brief regardless of skill, and the skills block (when present) comes
right after it so same-skill siblings match further still.
*Not:* any claim of dollars or tokens saved — that needs a paid run, out of bounds here, exactly the caveat Finding A
already states. Does not change what information the worker receives, only where in the text it sits.
*Effort S. Risk:* brief-hash churn in `recon.test.ts`/`workflow-policy.test.ts` (expected and re-pinned on purpose, same
as U3 step 2); a worker reading its own brief top-to-bottom now sees skills before its own focus/task, which is a
real readability tradeoff against the caching gain — flag this explicitly to the owner rather than deciding it here.
*Decision needed before Step 2:* is the readability tradeoff (skills-before-task reading order) worth the measured
cache-prefix gain? Recommend doing P1 first regardless — it is needed either way and does not interact with ordering.

### Tier C — owner decision, no code without it

**P4. Is a separate `workflow` knob worth keeping, now that P1 would make it reach the worker?**
*Evidence:* Finding C. Strix expresses "which application of this skill" with nothing beyond its flat skill list (a
different skill per variant, or none); ARTEX has no skill system to compare. p2o's `workflow` is the only one of the
three knobs with no ARTEX/Strix precedent, and until P1 ships it has been provably inert (Finding B).
*Options, not decided here:*
1. Ship P1, then watch real runs for whether the lead sets a non-empty `workflow` often enough to justify the extra
   validation path (`TASK_METHOD_STALE`, the `WORKFLOW_UNKNOWN` checks) it costs.
2. If it is rarely used even after P1, fold each skill's workflow variants into its own `SKILL.md` text (the lead
   reads which variant applies the same way it reads everything else in the catalog) and drop the structured
   `workflow` field, `TASK_METHOD_STALE`, and the `WORKFLOW_UNKNOWN` checks.
*Not proposing either option now* — this needs usage evidence this planning pass does not have (no paid runs, no
telemetry), exactly the same posture the superseded study took on U7 and U9.
*Also open, smaller:* should `methodReason` reach the worker's brief the same way `workflow` would under P1, or is it
deliberately owner-only audit trail (like a `p2o_plan` decision's `reason`)? Not proposed either way — flagging it so
the owner can fold an answer into the P1 decision rather than treat it as a second, separate change later.

### Reviewed, nothing proposed

**Recon instructions sent to the lead even when delegation is enabled.** `ownerInstructions` includes
`reconInstructions(facts.targetKind, false)` unconditionally (`src/prompts.ts:67`), even though a delegating lead never
executes recon itself. Considered as a possible fifth finding; not proposed, because the same text plausibly doubles as
the rubric the lead uses to judge whether a worker's recon is adequate ("Unclear entry/gate → focused mapping..." reads
as a review heuristic, not only an instruction to act) — cutting it needs a judgment call about what the lead actually
uses it for, which this pass did not test. Flagging it for the owner rather than guessing.

**`p2o_skill_list`/`p2o_skill_read` granted to workers whose skill is already pushed.** Checked: both tools also serve
`shared:handoffs`/`shared:scope`/`shared:wstg-map` documents (`docs/SKILL_RUNTIME.md:8-10`) that have nothing to do with
the worker's own assigned skill, and the tool description already says a role's default skill is "a starting point, not
a ceiling" (`extensions/p2o/index.ts:1025`) — so the pull path is doing real, distinct work, not just duplicating the
push. No change proposed.

---

## 4. Order

| Step | Items | Gate before the next step |
|---|---|---|
| 1 | P1, P2 | None — both are deterministic, additive-only when the owner doesn't opt into a workflow, and independent of each other |
| 2 | P3 step 1 | Already measured above; step 2 needs the owner's read on the readability-vs-cache tradeoff before it is applied |
| 3 | P4 | Owner decision; needs P1 shipped first to generate the usage signal the decision depends on |

Standing constraints honored: commit/push/install stay owner-initiated; no attribution lines; GitNexus `impact`/
`detect-changes` before any edit (not run in this planning-only pass — run it for `workerBrief` and `prepareMethod`
when P1/P3 are actually implemented); no paid or live runs; no reference code executed.

## Appendix — where the evidence came from

- `src/prompts.ts:5` (`KNOWLEDGE`), `:89-108` (`workerInstructions`), `:110-138` (`workerBrief`).
- `extensions/p2o/index.ts:446-463` (`resolveRole`/skill-doc assembly in `spawnWorkerLocked`), `:512` (the `workerBrief`
  call site with no `workflow` passed), `:880-891` (`prepareMethod`).
- `src/tasks.ts:13` (`TaskMethod`, including the `workflow` field that never leaves the owner side).
- `src/roles.ts:17-23` (`ROLE_DEFAULTS`), `:30` (`MAX_SKILLS`), `:134-146` (`resolveRole`).
- `src/skills.ts` (`SkillLibrary.load/list/read`, full file).
- `src/tool-policy.ts:3-4` (`p2o_skill_list`/`p2o_skill_read` on both `OWNER_TOOLS` and `WORKER_TOOLS`).
- `skills/catalog.json` (attack-surface-mapping's three workflows, used as the Finding B example).
- `docs/SKILL_RUNTIME.md:8-17` (documented knowledge-tool and workflow-validation behavior).
- `tests/minimal/recon.test.ts:68-95` (`briefHash`/instruction-hash pins that P1/P2/P3 would touch),
  `tests/minimal/workflow-policy.test.ts:59`.
- Prior study for ARTEX/Strix architecture and the U3 precedent this pass extends: `git show b3789cd:planning_update.md`
  §1.2, §2, Tier A item U3.
