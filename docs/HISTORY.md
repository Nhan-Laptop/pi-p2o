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

## Decisions that outlive their phase

- **One consent, blanket authorization.** The start confirmation covers ownership and the engagement mode once. There is
  no per-action consent; `blocked` means the approaches are exhausted, never that a permission was not granted.
- **The target is a label, not an egress boundary.** HTTP may reach any host the sandbox can route to, shell/network
  commands are not origin-filtered, and the citation fetch is host-side, uncapped, with no allowlist (Part XI).
- **The browser and identity channels are instrument, not permission.** The pinned image ships Chromium and the
  `agent-browser` CLI; `--identity` is operator convenience, and a worker provisions a disposable principal when it needs one.
- **No command, token, time or round allowance.** Only two quietly unproductive rounds, an operator decision or an operator
  stop end a run; usage is recorded for the report and never refused.
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
