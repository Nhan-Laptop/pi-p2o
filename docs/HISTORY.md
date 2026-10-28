# History and decisions

A dated record, not the current specification. Current behaviour lives in the code and in
[ARCHITECTURE](ARCHITECTURE.md), [PLANNER_ENGINE](PLANNER_ENGINE.md), [EVIDENCE](EVIDENCE.md), [KNOWLEDGE](KNOWLEDGE.md)
and [USAGE](USAGE.md). This page keeps the milestones and the owner decisions that shaped them, so a later reader can see
why a rule exists without re-reading a design diary.

The full design record that preceded this page (2,326 lines, Parts I–XI and appendices) is still in git and is **not**
maintained any more:

```sh
git show f5015fd:planning_update.md                  # the design record as it stood at the autonomy pass
git show f5015fd:docs/VERIFICATION_LOG.md            # per-milestone receipts (counts, commits)
git show f5015fd:docs/P5_1_PATCH_PROPOSAL.md         # P5.1 measurement defects and proposed patches
```

Every number below was true when recorded. None of them replaces a current run: `npm test` is the only live verdict.

## Milestones

| When | Milestone | Recorded evidence then |
|---|---|---|
| 2026-10-10 | K0–K7 knowledge workspace: SQLite store (schema 7), asset/fact graph, work admission and plan board, canonical cases and host-derived coverage, indexed knowledge heads, acceptance matrix | full suite 357 pass / 12 skip, Python 143, Docker opt-in 5 pass; commits `7e204c3`, `007ee58` |
| 2026-10-10 | W0–W6a operator control: `hold`/`release`/`stop-worker`, runtime digest, deterministic report, search, usage display | shipped in `b7cfa6f`, `41e8157` |
| 2026-10-10 | Tool-guidance experiment (16 paid runs): per-tool guidance raised cost ≈+73% with no measured quality gain → removed; `p2o.toolGuidance` retired | paid benchmarks stopped 2026-10-11 |
| 2026-10-11 | S0–S6 prompt, skill and WSTG work: the prompt carries policy not tool manuals; the WSTG map covers 108 tests | `4bd7674`, `656843d`; suite 558 / Python 155 |
| 2026-10-11 | P0–P7 workflow and OWASP-shaped report v2: finish preflight, automatic report, case rating, access ladder | `be959d5` |
| 2026-10-22 | P13 chain/lineage: typed `gained`/`needs` capabilities, chain view, plan-board chain steps | `4368fa3`; 665 pass / 82 files |
| 2026-10-24 | Owner decision: no command allowance and no finish gate. The broker counts target operations and refuses none; per-rung caps on tool input were removed too | no behaviour left to renew or exhaust |
| 2026-10-26 | P5.1 measured the unattended gate: stall accounting counted non-rounds and reset per resume; fixed to admitted rounds only, one fact per round, streak counter | `run-615f7a9a` passed 6/6 criteria (69.8 min, $1.57) |
| 2026-10-27 | P8 truth pass: capability text describes the instrument that actually runs; retired claims are pinned by test | test-pinned in `tests/minimal/truth.test.ts` |
| 2026-10-27 | P9 Option B/C: graph-related ceilings became a setting (`graphCapacity`), queue identity, executor cap, proof-only goal settle | full suite 1,069 pass / 124 files |
| 2026-10-27 | P11/A11 autonomy pass: one start consent covers the run; browser and self-provisioned identity are instrument facts; the skill library's third-party guardrail doctrine was removed | commit `f5015fd`, pushed to `main` |
| 2026-10-27 | Dedupe/merge pass: three authoring pairs became identity-selected `p2o_task_author` / `p2o_case_author` / `p2o_plan_author` (no `id` creates, `id`+`revision` revises); tool declarations 95.7 kB → 79.9 kB (−16.5%, planner loadout −24.1%); duplicated prompt rules, tool self-repeats and skill-library scaffolding removed; size budgets and the skill ceiling pinned by test again; five skills stopped describing an off-sandbox lab that does not exist | 34 registered tools (32 on the model surface + 2 hidden), planner 21, worker 19, validation 18, reporter 6; full gate recorded with the change |
| 2026-10-28 | P18/A9–A13 long-horizon loop: each round opens in a fresh Pi session with a deterministic ≤8 KiB briefing instead of growing one transcript; per-round budget (40 steps / 900 s, wrap-up with a closing loadout, classified stop rather than a failure); single-mode demand floor (one `wait` refusal, at most two settlement nudges); per-round base/escalation model and thinking routing; ledger-only round facts and operator visibility; operator stop settles the in-flight round and drains worker reports inside fixed bounds. The manual loop mode was removed (a start without a worker backend is refused), while the campaign itself stays uncapped. Measurement protocol shipped ready-not-run | full suite 1,185 passed / 13 skipped / 133 files; real-Pi round-session smoke green; P18 bench never run (D52) |
| 2026-10-28 | R0 of the R1 program (containment/correctness): the host-side citation fetch became a bounded fetcher (15 s, 4 MiB, ≤5 redirects, text/json/xml only, loopback/link-local/private/CGNAT/metadata refused per hop); graph export counts and returns relations whose either endpoint is on the page; coverage's asset identities are scope-filtered; `refs` refuses >10 at write and in the Pi schema; `assetCount` counts current heads, not retained revisions; stale "uncapped fetch" prose was corrected in prompts, descriptions and docs | full suite 1,215 passed / 13 skipped / 142 files; tsc, build and `check:build` green; no live run; committed as `1d79ec9` (19 files, owner files excluded) (R0/D-R1-4) |
| 2026-10-28 | R1 of the R1 program (graph as working memory): `p2o_graph action=query`/`summary` became bounded SQL reads over current heads (kind/key-prefix/label/attribute/statement filters, sequence cursor, 24 KiB response bound and an 8 KiB summary bound that drops rows honestly); `view` gained a derived asset dossier (facts, hypothesis counts, relations, claims with stale/demonstrated, cases, coverage cells incl. explicit `noCell`, tasks, gaps, omission counters, 24 KiB); a claim's assets are now host-stamped from the executing task's work identity (model input refused); workers may record `open` hypotheses and `basis=inferred` relations (host-stamped `unverified` + producer role) which become gateable `GRAPH_UNREVIEWED` debt the owner settles by superseding; the worker slice, the report and the round brief carry the graph (identity-resolved asset lines, an asset inventory section, and a bounded round delta) — none of it is evidence, and no authority or schema changed | full suite 140 passed / 5 skipped / 145 files, 1,237 passed / 13 skipped tests, 0 fail; tsc/build/`check:build` green; declaration budget green; R1 is uncommitted working-tree work, no live run (R1/D-R1-1, D-R1-3, D-R1-12) |

## Decisions that outlive their phase

- **One consent, blanket authorization.** The start confirmation covers ownership and the engagement mode once. There is
  no per-action consent; `blocked` means the approaches are exhausted, never that a permission was not granted.
- **The target is a label, not an egress boundary.** HTTP may reach any host the sandbox can route to, shell/network
  commands are not origin-filtered, and the citation fetch is host-side, with no allowlist. Amended by R0/D-R1-4: the
  citation fetch is still host-side and allowlist-free, but now bounded — 15 s, 4 MiB, ≤5 redirects, and
  loopback/link-local/private/metadata destinations refused — while the target itself stays unreachable only at the
  network layer the sandbox imposes, never by an allowlist.
- **The browser and identity channels are instrument, not permission.** The pinned image ships Chromium and the
  `agent-browser` CLI; `--identity` is operator convenience, and a worker provisions a disposable principal when it needs one.
- **No campaign allowance; the round is bounded.** Amended by P18/D47: there is still no campaign-wide command, token,
  time or round ceiling, and only two quietly unproductive rounds, an operator decision or an operator stop end a run; usage
  is recorded for the report and never refused. What is bounded is the round itself (40 steps or 900 s by default, wrapping
  once before the end): a hard stop is a classified round end, not a failure and not a campaign decision. The same pass
  removed the manual loop mode (P18/D48): a run that cannot delegate refuses to start instead of letting the planner take
  over target work, and the planner stand-in is the demand floor, not a manual turn.
- **One authoring verb per entity, selected by identity.** `p2o_task_author` / `p2o_case_author` / `p2o_plan_author` create
  with no `id` and revise with `id`+`revision`; a half identity is refused with the board read and the legal next verb, so
  the schema is declared once instead of once per half.
- **Authority is a loadout, not a prompt.** The planner holds no target, lab or claim tool; a worker is the only claim
  author; the reporter is a read-only second reader. Dispatch is the only path to target execution.
- **Coverage is host-derived from reviewed work.** No model-authored coverage cell exists; a task without an asset is an
  unmapped gap, never a clean cell.
- **Review is not proof, and mechanics tests are not effectiveness.** "Independently verified" needs a different worker's
  matching reproduction; no paid benchmark has been run for the current design, so pentest effectiveness stays UNVERIFIED.
- **Owner-initiated only.** Commit, push and install happen when the repository owner asks, one request at a time.
  `AGENTS.md` keeps the attribution rules.

## Documents retired by the concision pass

The following were merged into the current pages and removed from the tree; their text remains in git at `f5015fd`:

| Removed | Now in |
|---|---|
| `planning_update.md` (prose) | this page + the code; full record in git |
| `docs/WORK_ADMISSION.md` | [PLANNER_ENGINE](PLANNER_ENGINE.md) |
| `docs/CASE_REVIEW.md` | [EVIDENCE](EVIDENCE.md) |
| `docs/ASSET_GRAPH.md`, `docs/CONTEXT_PACKETS.md`, `docs/SKILL_RUNTIME.md` | [KNOWLEDGE](KNOWLEDGE.md) |
| `docs/STATE_STORE.md`, `docs/ASSESSMENT_STATE.md` | [ARCHITECTURE](ARCHITECTURE.md) and [USAGE](USAGE.md) |
| `docs/VERIFICATION_LOG.md`, `docs/P5_1_PATCH_PROPOSAL.md` | git only (`git show f5015fd:…`) |

Last full gate before that pass: `typecheck`, `build` and `check:build` clean; full suite 1,071 passed / 12 skipped /
6 skipped files / 124 files; Python 154 of 155 (one pre-existing provenance-hash mismatch in the local reference checkout);
WSTG map 108 tests; 37 registered tools (35 on the model surface plus 2 hidden legacy verbs).
