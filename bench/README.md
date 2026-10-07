# Skill benchmark fixtures and opt-in runner

This directory holds the **Phase 5** real-runtime benchmark from
[`planning_update.md`](../planning_update.md): synthetic vulnerable/fixed fixtures, evaluator truth
that the assessed agent never sees, and the opt-in runner that compares three library/runtime arms
with a real Pi lead driving the **real P2O sandbox**.

Nothing here runs as part of `npm test`. `npm test` still typechecks, builds and runs the hermetic
unit/verification suites only; live model traffic requires an explicit `--live` flag.

## Layout

```
bench/
  README.md                 this file
  fixtures/<name>/
    vulnerable/             agent-visible synthetic source (vulnerable revision)
    fixed/                  agent-visible synthetic source (fixed revision)
    expected/truth.json     evaluator-only expected findings, clean surfaces and gaps
  lib/plan.mjs              hermetic fixture discovery, arm preparation, hashing, randomized plan
  lib/score.mjs             bounded deterministic lexical scoring + secret redaction
  .arms/                    prepared baseline checkout (gitignored)
  .work/                    run workspaces and arm B package (gitignored)
  results/                  machine receipts: plans, verifications, per-run JSON, exports and summaries (gitignored)
```

**Evaluator truth isolation:** `expected/` is a sibling of `vulnerable/` and `fixed/`, never inside
them. `lib/plan.mjs` refuses to copy a tree whose relative path contains `expected` or `truth`, and
`tests/minimal/benchmark.test.ts` asserts that no source variant contains evaluator files. The runner
copies exactly one variant into a run workspace and passes that directory as `/p2o --target`.

**Neutral objectives:** the objective is frozen in `expected/truth.json`; the runner accepts no
caller-supplied prompt. `assertNeutralObjective()` rejects objectives that contain an expected
finding id, a distinctive solution marker extracted from evaluator truth (paths, identifiers,
hyphenated mechanism ids) or a mechanism term such as `idor`, `xss`, `bypass`, `unescaped` or
`catch-all`. The objective is a bounded task statement, not a hint sheet.

## Fixtures

| Fixture | Vulnerable revision | Fixed revision | Executable probe |
|---|---|---|---|
| `route-inventory` | `/admin` mounted without an identity dependency; `/{path:path}` catch-all returns the shell with 200; `parse_api_key` reads but never verifies; OpenAPI lists external origins and spec-only routes | operator dependency on `/admin`; unknown paths answer 404; legacy route verifies identity and ownership; spec matches code | source review only (FastAPI is not installed offline) |
| `object-authorization` | tenant check without owner binding; export accepts any tenant; `FIELD_POLICY` owner rule not enforced | owner/admin binding, own-tenant export, field policy enforced | `python3 probe.py` over controlled principals/objects |
| `output-context` | `render_search_html` emits the inert marker raw in an HTML text context | `html.escape` in the same context | `python3 probe.py` compares each context |
| `fastapi-parity` | `Depends(parse_bearer)` on the admin router and `/api/v2/export`; mounted `/internal` app inherits nothing | verifying dependencies plus mounted-app middleware | `python3 probe.py` over a path/actor matrix |

Probes use only the Python standard library, an inert non-executable marker, and synthetic
principals/objects. Route inventory stays a source-review fixture by design: a test double is not
evidence that a production transport works, so the fixture records the missing runtime baseline as a
gap instead of simulating a server.

`expected/truth.json` is a `p2o-bench-truth/1` document with, per variant:

- `expected_findings[]` — `id`, `severity`, `supported_proof` (`source_trace`, `offline_reproduction`,
  `live_reproduction`, `browser_execution`) and term `match_groups`;
- `expected_clean[]` — surfaces that are correct in that revision (false-positive bait);
- `required_gaps[]` — gaps an honest report must state;
- `forbidden_claims[]` — claims that are false in that revision (for example demonstrated XSS or a
  blanket framework weakness).

## Arms

| Arm | Runtime | Skills | Start flags |
|---|---|---|---|
| **A** | baseline revision `4321f2b` | original 17 techniques, no catalog sidecar, no durable export | **none** (the revision predates `--export`) |
| **B** | improved runtime (skill/capability/evidence/candidate APIs) | the same original 17 techniques | `--export` when the resolved package supports it |
| **C** | improved runtime | 17 techniques + `web-route-input-inventory`, `web-object-authorization`, `web-output-context` + `fastapi-security-parity` overlay | `--export` when the resolved package supports it |

`node scripts/benchmark-skills.mjs prepare` materializes arm A with `git archive` into
`bench/.arms/baseline-4321f2b` (no `npm install` needed; module resolution walks to the repo
`node_modules`). Arm B is prepared automatically into `bench/.work/arm-b` from the working tree:
`src/`, `extensions/`, the 17 skill directories, and a **filtered catalog sidecar**.

The arm B filter is schema-tolerant (`catalogDocuments()` accepts the legacy document array and the
new id-keyed dictionary, plus `path`/`file`/`document` aliases). It retains:

- every document whose path lives under a kept skill directory (SKILL.md, references, recipes,
  rulesets, evidence docs);
- every document whose id is the skill name or starts with `skill-name:` (reference/recipe ids);
- all shared and evidence-ledger documents (`shared:*`, `evidence:*`), copied with their files;
- any extra document referenced from a kept skill's `skill.json` sidecar dictionary.

Playbook/overlay documents are excluded from arm B. A test asserts the retained catalog parses, has
exactly 17 skills, keeps the Semgrep recipe and evidence sections, and that every retained document
exists on disk.

`--arm-a-path`, `--arm-b-path`, `--arm-c-path` (or `--extension-path` with exactly one `--arm`)
override any arm with an explicitly selected package or extension path. `--start-flag <flag>` adds or
replaces start flags, and `--no-export` suppresses the export flag (arm A never receives it). Every
arm record keeps the extension SHA-256, package hash, skill list and effective start flags, so an
installed package build can be pinned without editing the repository.

## Fixed budget, random order, repetitions

- **Repetitions:** 3 per arm × fixture × variant by default (`--reps`); the default campaign is
  **4 fixtures × 2 variants × 3 arms × 3 reps = 72 runs**.
- **Random order:** all runs are shuffled once with a seeded PRNG. The seed is printed, stored in the
  plan receipt and copied into every run receipt (`--seed 7`; `--seed random` picks one).
- **Fixed per-run budgets:**
  - wall clock 25 minutes (`--max-minutes`);
  - assistant turns 60 (`--max-turns`) — enforced from `turn_end` counters;
  - target commands 120 (`--max-target-commands`) — enforced from `p2o_shell`/`p2o_http` counters;
  - provider cost ceiling $3 (`--max-cost-usd`) when the provider reports cost; cost availability is
    recorded per run, and the turn/command budgets bound runs when it is not.
  The runner aborts on any limit and records `timeout`, `turn_budget`, `command_budget` or
  `cost_budget` instead of scoring it as a security negative. The extension's own 30-minute deadline
  stays above the default wall budget.
- **Suite cost control:** the per-run cap is the lever for an agreed total ceiling. The first 72-run
  campaign used `--max-cost-usd 0.13` because `72 × $0.13 = $9.36 < $10`; the default $3/run cap
  would allow a $216 worst case and could not honor a $10 suite budget. The cap did not bind (all 72
  runs finished normally; actual total $1.5736). Every suite plan and summary records
  `costControl: {perRunCapUsd, runCount, plannedWorstCaseUsd, note}`, and each receipt keeps the
  actual `usage.cost`; the cap is never silently raised during a run.
- **No implicit fallback:** provider failures, protocol errors and transport failures are separate
  outcomes (`provider_error`, `transport_error`, `no_assessment`) and are excluded from
  recall/precision aggregates; the suite summary lists `invalidRuns`, `providerFailures`,
  `budgetOutcomes` and `costAvailableRuns`.
- **Teardown (per-run label, concurrency-safe):** every P2O container carries a
  `pi-p2o.run=<runId>` label. The runner derives its own runId in priority order from the finish
  export payload, the export filename, or the P2O assessment brief ("... Run <runId>. Deadline
  ..."), then queries only `docker container ls --filter label=pi-p2o.run=<runId>`. Those
  containers are the authoritative `leakedContainers`; a non-empty result makes the run invalid and
  the suite exit code non-zero. Global `pi-p2o=minimal` snapshots are still taken but are recorded as
  `globalNewContainers` (informational only): containers appearing during the run may belong to
  another benchmark or a concurrent holdout and never invalidate this run. `checks.runId`,
  `checks.runIdSource` and `checks.cleanupVerification` (`own-label-clean`, `own-label-leak` or
  `unverified`) record how cleanup was established. The suite summary separates the authoritative
  `leakedContainers` from informational `globalNewContainers`.

## Real Pi, real sandbox, local-only target

A live run spawns the actual `pi` binary in RPC mode:

```
pi --no-extensions -e <arm extension path> -e <run objective wrapper> --no-skills \
   --no-prompt-templates --no-themes --no-context-files --no-approve --no-session \
   --mode rpc --model deepseek/deepseek-flash --thinking off
```

The runner answers the extension's "Start authorized assessment?" confirmation mechanically and
sends exactly one prompt: `/p2o --target ./target [--solo | --workers N] [<arm start flags>]`.

**Objective delivery (no follow-up runs).** The fixture objective is appended to the system prompt
by a generated wrapper extension loaded **immediately after the tested arm**, for all arms A/B/C
identically. The wrapper's `before_agent_start` handler appends `BENCHMARK OBJECTIVE (frozen fixture
task, identical for every arm)` plus the objective only while the system prompt already contains the
P2O scope text. Pi evaluates `before_agent_start` handlers in extension load order and chains
`systemPrompt`, so the P2O owner hook runs first; if it did not, the wrapper appends nothing. The
wrapper registers no tools, commands, flags, providers or messages and creates no agent run. The
runner never sends a follow-up prompt, so no benchmark instruction can be queued after `p2o_finish`,
after cleanup, or outside the sandbox. Wrapper source and SHA-256 are recorded per run
(`objectiveWrapper`), and the suite summary lists all wrapper hashes. `bench/lib/objective.mjs`
exports the generator and a plain-JS handler mirror so the future holdout runner reuses the same
wrapper. Hermetic tests cover the generated source invariants, the absence of any follow-up RPC
command, and real-Pi ordering (P2O hook first, objective only in scope).

The lead runs inside the **real P2O Docker sandbox** (pinned image digest, no network, read-only
`/target`); delegation is off by default and available with `--delegation` where Herdr can spawn
visible panes. `--workers` is capped at 6, matching the runtime's own `MAX_WORKERS`.

Default model: `deepseek/deepseek-flash`; override with `--model <provider/id>`. The runner makes no
provider assumptions and performs no automatic cross-provider fallback. Fixtures are directory
targets, so `p2o_http` is not used — loopback URLs are deliberately rejected by the transport.

## Export, candidate and proof references

The improved runtime records runtime receipts and candidate closures. `p2o_finish` returns
`details.exportPath` pointing at `<run cwd>/.p2o-reports/<runId>-<uuid>.json` (version 2 payload with
`manifest` and the run's `records`). Before the run workspace is deleted, the runner:

1. reads the path only when it resolves to a regular file **inside the run workspace** (traversal,
   outside paths, directories and files over 16 MiB are refused);
2. copies the redacted export next to the receipt as `<suite>.<idx>-<runId>.export.json`;
3. parses it with `exportDataFrom()` to extract candidate closures, proof levels, `evidenceRefs` and
   `negativeControls` evidence IDs.

`scoreRun()` then reports candidate/proof coverage: `proofLevels`, candidate call/record/export
counts, and `evidenceReproducibility` — the fraction of candidate evidence refs that resolve to
observed same-run evidence IDs (from `p2o_shell`/`p2o_http` result details or the export). Export
failures are recorded per run in the receipt (`export.error`) and listed in the suite summary.

## Scoring

`lib/score.mjs` is a deterministic **lexical** scorer (`scorer: "lexical-v2"`); it is a
reproducibility aid, not ground truth. For every run it reports:

- `recall` / `precision` over expected findings, forbidden claims and clean-surface false positives;
- `proofAccuracy` — the claimed evidence stage (source trace, offline reproduction, live
  reproduction, browser execution) against the supported stage, including a check that an
  `offline_reproduction`/`live_reproduction` claim has a matching observed probe/command;
- `gapHonesty` — required gaps actually stated;
- `evidenceReproducibility` and proof-level counts from candidate/proof references;
- `scope` — worker delegations, turns, target commands, `p2o_skill_read`/`p2o_skill_list` calls,
  `p2o_candidate` calls and rejected calls, evidence IDs and record-store counters;
- `validity` — finish observed, "Container removal verified" present, no leaked containers, no
  provider/protocol failure and no budget breach.

**What counts as a claim.** Every arm is scored on the final report written after `p2o_finish` (plus
the finish coverage summary); progress messages are never claims. For B/C the runtime-validated
candidates are added, with the durable export taking priority: the scorer uses the export candidate
set (latest revision per candidate id), then successful tool-result candidate records, and excludes
rejected `p2o_candidate` calls entirely. This fixes the first pilot, where six rejected calls
inflated the candidate and evidence counts and a progress message was scored as a claim.

**Context-aware checks.** Forbidden claims and clean-surface false positives require all of their
terms to co-occur in the same sentence/table cell (with a bounded ±240-character window fallback),
are exempt when negated in the same clause, and clean controls are exempt when the segment also
contains a strong clean marker ("clean", "correctly encoded", "negative control", "ruled out", …).
A clean surface is a false positive only when a confirmed candidate claims it or a segment asserts a
positive finding about it. Evidence IDs from tool text are normalized (`Evidence ID:` prefix
stripped), lowercased, and de-duplicated before linking against candidate `evidenceRefs` and
`negativeControls`.

**Recorded limitations.** Every score carries `limitations: SCORER_LIMITATIONS` — lexical term
matching rather than semantic judgment; heuristic segment/window checks; candidate closure only as
good as the runtime-validated records; proof-level words not independently verified; no independent
validation of probe output or worker claims. These are reported rather than tuned away.

Raw redacted `claimText`/`evidenceText` and the original messages are stored (bounded) next to every
receipt so a human can re-score with `score <receipt.json>`. Aggregates report distributions (n, mean,
median, min, max) only; no significance claims are made. `evidenceReproducibility` is `null` for runs
with no candidate records (for example arm A), and the aggregate skips those values instead of
inventing a result.

**Memory bounds:** the RPC record store keeps at most `MAX_RECORDS` (20 000) records or 32 MiB of raw
log, whichever comes first, and preserves exact counters (turns, target commands, settle, errors,
evidence IDs, finish details) independently. Claim text is capped at 256 KiB, evidence text at
512 KiB, stderr at 200 KiB, and dialogs/notifications at 200 entries. Over-limit runs set
`logTruncated`/`evidenceTextTruncated` in the receipt.

**Guidance prompt.** Every frozen objective ends with "Consult the skill guidance available in this
runtime before testing, and record which guidance you used." The wording is capability-neutral: it
names no tool, so it is honest for arm A (where only the inlined technique documents exist) and
encourages B/C to use the on-demand library without hiding what A does not have.

Coordination note: the runtime is under concurrent development. The runner records the structured
APIs opportunistically (`p2o_skill_list{offset?}`, `p2o_skill_read{id,offset?}`,
`p2o_capabilities{probe?}`, `p2o_candidate{...}`, target-command evidence IDs, `p2o_finish`
`details.exportPath`) but requires none of them — arm A does not have them, and scored claims come
from the transcript that every arm produces. An invalid workflow sidecar is the runtime's concern to
fix; the planner only reports arm availability rather than working around it.

## Commands

```sh
# Hermetic: fixture hashes + probe expectations (host python3, no model, no network)
node scripts/benchmark-skills.mjs verify

# Hermetic: materialize arm A from revision 4321f2b (git archive; no commit, no push)
node scripts/benchmark-skills.mjs prepare

# Hermetic: randomized plan receipt under bench/results/ (shows arm skills and start flags)
node scripts/benchmark-skills.mjs plan --seed 7

# Opt-in live pilot: one arm, one fixture, one repetition (real model traffic)
node scripts/benchmark-skills.mjs plan  --arm C --fixture object-authorization --reps 1
node scripts/benchmark-skills.mjs run   --arm C --fixture object-authorization --reps 1 --live

# Full campaign after the baseline is prepared (72 runs with defaults)
node scripts/benchmark-skills.mjs run --live

# Tighter cost control when the provider does not report cost
node scripts/benchmark-skills.mjs run --live --max-turns 40 --max-target-commands 80

# Re-score a stored run (uses the preserved export when present)
node scripts/benchmark-skills.mjs score bench/results/suite-....3-C-object-authorization-vulnerable-r1.json
```

## Safety and privacy

- `run` refuses to start without `--live`; there is no automatic model call.
- The script never reads `pi auth` output, `auth.json`, bearer tokens or any credential file, and
  never writes environment values into receipts. Transcript text is passed through
  `redactSecrets()` before storage.
- Objectives come only from the frozen evaluator manifest and are validated for solution leakage; no
  arbitrary caller prompt or target-derived prompt is accepted.
- Targets are synthetic fixtures copied from `bench/fixtures/`; no external, production or
  user-supplied target is accepted.
- Provider API traffic is expected during a live run (send prompts, receive completions). Target
  traffic stays inside the approved local fixture and the extension's own sandbox.
