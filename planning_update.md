# Attack-chain capability — status and the next layer (plan of record, 2026-11-02)

## 0. Executive summary

Two prior layers of this comparison are now closed by code or by audit, not just by proposal: the data model
(G1–G7/F1–F8) and the skills/prompts layer (H1–H3/W-I/W-J/W-K). §1 compacts both into a status record; full
narrative detail for each lives in `git log -- planning_update.md` and the commits cited there.

This document goes one layer deeper: **the execution layer — the sandbox and broker an agent's tool calls actually
run inside — compared against ARTEX's `guard`/worker model and Strix's own tool/sandbox model** (the same container
image p2o's sandbox reuses: `src/sandbox.ts:13` pulls `ghcr.io/usestrix/strix-sandbox` directly, so this is a
same-image comparison of orchestration choices, not a different-container comparison).

**Headline result: the layer this project cares most about — the vuln/chain graph itself — is already the most
rigorous of the three systems**, ahead of both ARTEX's narrative Postgres graph and Strix's plain-JSON notes store
(§2.2). **The one real weakness was a sharp, specific, fixable gap in the execution layer** that actively worked
against chaining rather than merely limiting it: a command timeout tore down the entire sandbox rather than just the
command (destroying exactly the listener state a chain depends on) — **fixed this session, W-L, §1 H4**. Two other
findings that looked like gaps turned out, on investigation, not to be ones. Target-operation concurrency defaults
to 1 — serialized — which looked like it didn't back `src/prompts.ts`'s own breadth doctrine (§1 H3, closed earlier
this session on a different layer: the *prompt text* is adequate); the plumbing check this needed before any fix
found it isn't an unexamined default but **Q26**, a dated, tested, acceptance-gated owner decision requiring
explicit operator consent to raise it — **closed this session, W-M, §1 H5**, with only the prompt text clarified so
it stops promising execution capacity it can't back by default. A third, smaller finding (a tight 64 KB response
cap, prefix-truncated silently) looked like it risked quiet evidence loss on verbose tool output — **closed this
session, W-N, §1 H6**: the original framing was substantially overstated (a much larger, already-disclosed
retained-artifact mechanism already exists one layer up); two small real gaps were found and fixed instead. A
fourth is a gap shared by all three systems — no real multi-host pivot tooling anywhere — framed as an opportunity
to leapfrog both comparison systems, not a catch-up — still open as H7. §4 covers that one remaining item, pending
owner choice like every workstream before it.

## 1. Status: prior layers, now closed

| Item | Closed by | Outcome |
|---|---|---|
| G1–G7 — chain order not derivable from the graph | `95eae50`, `07480f4`, `076ae6c`, `2639d7f`, `6b17cad` (P25/1–4) | canonical `AttackChain` (`src/attack-chain.ts`), `leads_to` relation, graph-derived successor synthesis, chain survives a run boundary (F-lite) |
| F3 — untyped severity on auto-ingested leads | `ffff2a5` (W-A) | typed severity/CVE/CWE signal (`SeverityHint`), used as a chain-ranking tie-break |
| F4 — silent truncation inside synthesis | `4db457b`, `a4ed37c` (W-B) | `walk.truncated` rolled up into a synthesis-level health summary |
| F5 — fixed reachability ceiling | `10231c0` (W-C) | `pathCeilings(graphCapacity)` scales with engagement opt-in, no longer a bare literal |
| F6 — SBOM/lockfile breadth | `97b3081` (W-D, Option A) | poetry.lock/Pipfile.lock/composer.lock added to `packages.ts` |
| F6 — SPA route discovery (static bundles) | `10cafe8` (W-E) | `http-response.ts` auto-fetches and mines same-origin script bundles |
| F7 — positional overflow drop | `d5717a9` (W-G) | extraction cap tail-drops by severity, not scan position |
| F8 — evidence-ladder rigor | `eb47571` (W-H) | cited evidence cross-checked against claimed reach before crediting impact |
| F1 — closed taxonomy vs. free-text findings | `af20cbd` (W-F) | `classifyLegacyKind()` bridges free text for chain-*matching* only — partial; see H1 |
| H1 — skills find what the taxonomy can't type, but 5 of 8 named classes couldn't chain-join | `9002e02` (W-I) | `data.write` added to `CAPABILITY_KINDS`, symmetric with `data.read`; wired into `effects.ts`/`research.ts`/`routes.ts`/`capabilities.ts`/`docs/EVIDENCE.md`; 5 files/45 tests. Race conditions and business-logic flaws stay visibility-only by design (Option C) — no safe single-kind mapping exists for them |
| H2 — IaC/cloud-config/container coverage absent at every layer (skills, extractors, ARTEX) | `2662d2d` (W-J, extractor half) | `src/extract/checkov.ts` shipped, registered between `nuclei`/`httpx`, 23/23 tests. Skill half deferred — blocked by the skill library's closed provenance corpora (neither covers IaC/cloud-config); needs new source research first, not scoped |
| H3 — possible gap in ARTEX-style parallel-breadth prompt doctrine | audit only, no commit (W-K) | `src/prompts.ts` already has three breadth rules, one already ARTEX-derived from an earlier phase — not a gap *on the prompt-text layer*. See H5 below: a different layer initially looked unbacked by default, closed on investigation as a deliberate, tested owner decision (Q26), not a gap |
| H4 — a command timeout destroyed the whole sandbox, not just the command | `1087260` code, `83b5761` this doc (W-L, Option A) | `sandbox.ts` `exec()` **and its twin, `captureScratch()`**, both restructured: a genuine Docker-CLI-call failure still fails closed (whole-sandbox teardown, unknown-state default); a clean in-container `timeout --signal=KILL` (exit 124/137) now only fails that one operation — sandbox, PTY and any other backgrounded work stay up. `captureScratch()` needed a second, separate try/catch split (not just a moved boundary) since its docker call and its response parsing — denial-frame check, hash, scratch-snapshot build — used to share one catch; the existing denial-frame exemption is unchanged. Existing `exec` test renamed for accuracy (it covers the CLI-failure path, not this one); new tests added for both methods' clean-timeout path. `npx vitest run tests/minimal/sandbox.test.ts`: 14/14 (up from 12); `npm run test:sandbox` under real Docker: 13/13 across all 5 files, re-run after each method. `detect_changes` flagged `risk: critical`/876-982 affected processes — traced to the generic test-helper name `driver` colliding with ≥3 unrelated same-named local fixtures elsewhere in the test suite (confirmed: the touched `driver()` is unexported/module-private to `sandbox.test.ts`; every sampled "affected flow" cited only the collided name, repeated nonsensically within one flow, never `exec`/`captureScratch`/`Sandbox`) — same artifact class as the checkov/nuclei CRITICAL reading earlier this session, not a real new risk from this change |
| H6 — this document's own earlier claim that verbose tool output is silently lost past a 64 KB cap | `d77ab2e` (W-N, scope reduced) | The original framing (`broker.ts:22,650-662`) was substantially wrong: it missed that `executeWithReceipt`/`OutputCapture` (`extensions/p2o/index.ts`, `src/process.ts`) already cap the *visible* preview at 48 KiB — under the 64 KB wire cap, which rarely binds — and already retain the full output as a host-side artifact up to `artifactCaptureKiB`, **1 MiB by default, not 64 KB**, with the tool result already naming the artifact and saying so when truncated. Not silent; disclosed at 16× the cap this document originally described. Building W-N's original "auto-route overflow to scratch" would have mostly duplicated a bigger, already-working mechanism, so it's dropped. Two real small gaps found and fixed instead: `output()`'s per-artifact pointer named `/p2o artifact <id>` — a real command (`src/ui/workspace.ts`), but a human-typed slash command no LLM tool-loop can invoke, owner or worker alike — now names the `p2o_artifact` tool; `p2o_shell`/`p2o_net`'s tool descriptions never mentioned the retained-artifact safety net up front, only after a truncation — now both do, in 55/74 added chars respectively (fits every role's declaration-budget ceiling: `p2o_shell`/`p2o_net` aren't even in `PLANNER_TOOLS`, and worker/validation/model stayed under budget). Along the way, found `tests/minimal/context-budget.test.ts`/`surface-audit.test.ts` already failing on a clean checkout — planner's declaration budget is over its pinned ceiling by 59 chars, unrelated to this change (confirmed via `git stash`) — not fixed here, out of scope; flagged to the owner separately |
| H5 — default concurrency doesn't back the prompt's own breadth doctrine | investigated + prompt clarified 2026-11-02, **not yet committed** (W-M, scope reduced after owner choice) | The plumbing check this row's original framing called for found H5 isn't an unexamined default: it's **Q26** (2026-10-27, `b082634`, P10/TR-H09), a dated, tested, acceptance-gated owner decision (`docs/ACCEPTANCE_MATRIX.md` F-P10-1) — the shared executor stays strictly serial unless the operator explicitly types `--target-ops N` at launch. `src/target.ts:176-183` parses that flag once; it's baked into `ExecutorPool`'s `readonly maxOperations` at run start (`extensions/p2o/index.ts:4505-4506,4623`) with no mid-run adjustment path anywhere in the codebase. The ledger deliberately records raising it as an *operator* action, never an agent one (`index.ts:4610-4612`), and the planner is barred from every target/lab/claim tool for the same authority reason stated and tested throughout this codebase (`src/tool-policy.ts`'s `PLANNER_TOOLS`, `docs/ACCEPTANCE_MATRIX.md`'s repeated "Authority không đổi" lines). Building the original Option B (lead/dispatch layer auto-requests concurrency) would mean the planner reaching into exactly the control Q26 built to require explicit, audited human consent — a materially bigger and more sensitive change than "wire the dispatch layer" implied. Presented to the owner as a 3-way fork (close only / close + prompt clarify / revisit Q26 itself); **chose close + prompt clarify**. Fixed: `src/prompts.ts`'s existing `EXECUTOR AND QUEUE` text (in `plannerInstructions`) now states explicitly that the cap is fixed for the run and pursuing mechanism-family breadth needs a human to relaunch with it, not a request from the agent — closes the "prompt promises what execution can't back" gap without touching Q26 or planner authority. `mcp__gitnexus__impact` on `plannerInstructions` before editing (risk LOW, epistemic exact, 1 direct caller, 0 affected processes); `npx tsc --noEmit` clean; `npx vitest run` on `dispatch-discipline`/`authority`/`benchmark`/`broker`/`duties`/`identity-runtime`/`phase-f`: 120/120 passed — only the pre-existing, unrelated `context-budget.test.ts`/`surface-audit.test.ts` planner-budget failure remains, same 45559/45500 reading as before this edit, confirming zero effect from it; `detect_changes`: 1 file/1 symbol/0 affected processes, risk low |

**Still deferred, unchanged:** P25 Phase 5 (live C3/C4 measurement) — needs a fresh owner instruction under the C1
validity clause regardless of anything in this document. See §7.

Full narrative detail for every row above — options considered, verification runs, what was and wasn't pursued and
why: `git log -- planning_update.md` (this file's pre-2026-11-02-afternoon revisions), `docs/HISTORY.md`,
`docs/ACCEPTANCE_MATRIX.md`, and `git show <hash>` for each commit. Not duplicated here.

## 2. New layer: the execution model vs. ARTEX's `guard` model and Strix's own sandbox (2026-11-02)

### 2.1 Execution-dimension comparison

| Dimension | p2o | ARTEX | Strix |
|---|---|---|---|
| Backgrounded listener survives across tool calls | **Yes** — one container lives for the sandbox's life, every `exec` is a fresh `docker exec` into it (`sandbox.ts:100,172`) | Yes — PTY family + background-process manager, run-scoped, cleaned up at run end | Yes — named session reuse observed directly in real run logs |
| Interactive multi-turn session | Yes — singleton named PTY (`sandbox.ts:329-406`) | Yes — `shell_open/send/read/close/list` | Yes — named browser session observed; shell not directly confirmed |
| Durable cross-run lead/knowledge store | **Yes, most structured of the three** — typed capability graph, chain-debt tracking, `leads_to` relations | Yes — Postgres intents/facts/findings, resumes by transcript id, but narrative/free-text | Yes, loosest — plain `notes.json`/`todos.json`, free-text notes agents leave each other |
| Timeout behavior | **No default timeout; an explicit one that expires tears down the whole sandbox**, not just the command (`sandbox.ts:171-181`) | Mostly unlimited by default; exhaustion produces a distinct `exhausted` state, no destructive teardown | Budget enforcement via `budget_stopped`/`reserve_stopped` flags; parent auto-resumes on a wait-timeout rather than hanging |
| Default concurrency | **1 — serialized** unless an operator passes `--target-ops` (`sandbox.ts:64-76`) | 3 real concurrent worker goroutines by default | Agent-driven — the LLM itself calls `create_agent` to spawn parallel children |
| Network egress | Deliberately wide open by design — no SSRF guard, private/loopback/metadata addresses all allowed (`target.ts:270-282`) | Not blocked per-request; broad reach requires redeploying the whole container in host-network mode | `NET_ADMIN`/`NET_RAW` capability grant (raw sockets, interface control); observed scope restriction was prompt-only, not technical |
| Multi-host pivoting | **None** — no SOCKS/tunnel helper; must hand-build via `exec` | **None** — "pivoting" is redeploying the container, not a tool | Not confirmed either way |
| Response/output size cap | **64 KB hard wire-frame cap, silent prefix-truncation** (`broker.ts:22,650-662`) | 50 MiB task-output cap | Not measured |
| Cross-worker filesystem isolation | Convention only — shared session, `/work/<workerId>` by agreement, not enforcement (`broker.ts:18-19,457`) | Convention only — one fs namespace, one netns, one root user for all workers in a task | Not firmly established |
| Hard-coded safety floor (code, not prompt) | Size/image caps only; no found equivalent of a catastrophic-command denylist | `rm -rf /`/fork-bomb/`mkfs`/`dd` denylist survives even a permission-bypass flag; everything else is a DB-driven allow/deny list over a *fixed* tool set (custom/MCP tools bypass it; `task_scope` doesn't gate raw `Bash`) | No code-level restriction observed in the one real run inspected — pure Docker-capability grant plus prompt discipline |

### 2.2 What this confirms is already working — do not change

- **The chain/graph reasoning layer is p2o's strongest asset of the three systems compared this session or last.**
  This directly validates treating the vuln graph as the central problem: ARTEX's doctrine is narrative Postgres
  rows, Strix's is plain JSON notes between agents, p2o's is a typed, tested capability taxonomy with chain-debt
  tracking (H1/W-I this session; the chain/leads_to work before it). The gaps below are all in the *execution*
  layer underneath that graph, not the graph itself.
- **Network egress openness is a deliberate strength, not an oversight.** A tool whose job is finding SSRF cannot
  do so behind an SSRF guard. p2o's per-request openness is also more flexible than ARTEX's redeploy-the-container
  approach to the same goal.
- **Session persistence (listener survives across calls, singleton interactive PTY) is already comparable to both
  systems.** The timeout-teardown interaction (§1 H4, fixed this session) is what used to undermine this strength
  in practice — the capability itself was always sound.
- **Convention-only filesystem isolation between co-resident workers is a three-way-shared shortcut**, not a p2o-
  specific competitive disadvantage. Worth knowing about; not something this document proposes fixing alone.

## 3. New invariants

Still-open invariants only — H4, H5 and H6 are done (§1).

4. **H7 — no system compared this session has real multi-host pivot tooling. A genuine advance opportunity, not a
   catch-up — the same framing H2 used for IaC/cloud-config.** ARTEX's answer to reaching an internal host is
   redeploying the whole container in host-network mode; p2o and ARTEX both require an agent to hand-build a
   tunnel via raw `exec` (`ssh -D`, chisel, etc.) with no lifecycle or credential support; Strix wasn't confirmed
   either way. Building this would put p2o ahead of both systems on a dimension that matters directly for
   chaining past a single host.

## 4. Design proposals

Options are offered for the owner to choose between, not as a recommended default — same discipline as every
workstream before this one. A recommended reading order and a pick within each workstream's options are stated
below per the owner's request this round; neither is implemented without a separate "do it."

**W-L — done; see §1 H4.** Option A shipped for both `exec()` and its twin `captureScratch()`: scope the kill to
the timed-out operation only, leaving the sandbox and any other backgrounded process alive.

**W-M — done; see §1 H5.** The plumbing check this workstream flagged as a prerequisite found that Options A and B
above would both override **Q26** (2026-10-27, `b082634`, P10/TR-H09) — a dated, tested, acceptance-gated owner
decision that the shared executor stays strictly serial unless the *operator* explicitly types `--target-ops N`,
audited as such. Option B specifically would mean the planner reaching into a target-adjacent control it's
deliberately barred from everywhere else in this codebase. Presented to the owner as a revised 3-way fork (close
only / close + clarify the prompt / revisit Q26 itself); chose close + clarify. Option C survives, narrowed: one
clause added to `src/prompts.ts`'s existing `EXECUTOR AND QUEUE` text states the cap is fixed for the run and that
pursuing breadth needs a human to relaunch with it, not a request from the agent.

**W-N — done; see §1 H6.** Investigation found the premise wrong before any of Options A/B/C were built: the
64 KB wire cap this section used to describe is not where output actually gets lost. `executeWithReceipt`
(`extensions/p2o/index.ts`) already caps the visible preview at 48 KiB and separately retains the full output as a
host-side artifact up to 1 MiB by default, disclosing the artifact ID and any truncation in the tool result text —
so evidence was not silently lost, only under-advertised in two small spots, both now fixed: `output()`'s
per-artifact pointer named a human-only slash command no LLM can invoke, now names the real `p2o_artifact` tool;
`p2o_shell`/`p2o_net`'s descriptions didn't mention the 1 MiB retained-artifact net up front, now both do.

**W-O — Build real multi-host pivot tooling (addresses H7).**
- *Option A — a tunnel broker op:* a new `broker.tunnel`-style operation (SOCKS5 or direct port-forward) giving a
  worker a routable path to a newly-discovered internal host, with real lifecycle (open/list/close) rather than a
  hand-rolled background `exec`. The only option that actually closes H7; also the biggest lift of the four.
- *Option B — a documented recipe instead of new code:* a skill-level methodology formalizing the manual
  `ssh -D`/chisel-via-exec pattern ARTEX's own agents already use ad hoc, with no new broker surface. Cheaper, but
  leaves the same "hand-build it every time" friction this document flagged as a three-way-shared gap.
- *Option C — defer:* do nothing this round; revisit only if a real engagement is actually blocked by the absence
  of pivoting. Reactive rather than proactive, same caution this document has used for every "biggest lift" item
  (W-D's Option B, then W-J) before it.
- **Recommended sequencing, not a pick within the options:** lowest priority of the four despite the highest
  ceiling — it is the only one of the four that is a new build rather than a contained fix, same reasoning this
  document has applied to every large-scope item before it.

**W-L, W-N and W-M are done. What's left is W-O alone.** It's a real new build and stands on its own regardless of
the other three.

## 5. Priority and effort, for the owner's call (not a decision)

W-L, W-N and W-M all shipped this session (§1 H4, H6, H5) and are no longer open decisions. With three of the four
workstreams closed, a priority table no longer has anything to compare — **W-O (multi-host pivot tooling, H7)** is
the only item left: highest ceiling of the four (the one gap shared by all three systems compared, a real advance
rather than a catch-up) but also the highest effort (a new build, not a contained fix), same reasoning §4 already
gives it.

## 6. Non-goals this round

- No code changes beyond what §1 already records as closed this session (W-L, W-N, W-M). The one item still in
  §4 (W-O) stays proposal-only, pending owner review, same discipline as every workstream closed before it.
- No re-run or re-measurement of anything live; no Phase-5-style campaign proposed here.
- Does not re-litigate H1–H6/W-I/W-J/W-K/W-L/W-M/W-N — those are closed status facts now living in §1, not open
  proposals.
- Does not restart or re-authorize P25 Phase 5 (live C3/C4 measurement) — stays deferred pending its own fresh
  owner instruction, independent of anything chosen from §4.
- Does not revisit **Q26** itself (the 2026-10-27 decision that shared stays serial by default) — the owner was
  offered that as an explicit option for H5 and declined it in favor of closing H5 with the prompt text clarified
  instead; Q26's default and its explicit-operator-consent audit behavior are both unchanged.
- Does not touch `src/sandbox.ts`'s choice to reuse Strix's published container image — the proposals above are
  all about p2o's own orchestration layer on top of that image, not the image itself.

## 7. Carried operational facts (unchanged; full detail in this file's pre-2026-11-02 git history)

- **Practice model:** `opencode-go/deepseek-v4.1-flash` only; a usage limit is a stop-and-wait, not a provider
  change. Never the owner's codex proxy providers.
- **Commit/push discipline:** no commit and no push without a fresh instruction; each phase's commit waits for its
  own instruction; no AI attribution; repository identity `Nhom 03 <nguyentrongnhan06cm@gmail.com>`.
- **Owner files never staged:** `AGENTS.md`, `pi-p2o-defense-vi.pptx`, `.transcribe_tmp/`.
- **Live-run authorization (P25 Phase 5, still deferred):** the only target this project has ever authorized for a
  live run is `https://ise.uit.edu.vn/`, under the C1 validity clause (default ladder minus `availability-loss`),
  and only on a **fresh** owner instruction each time — prior authorization does not carry over, and no other host
  is authorized under any phrasing. The last recorded runbook used these exact `--avoid` prohibitions: no
  destructive or availability-impacting action; no persistence, no anti-forensics, no evasion beyond minimal proof;
  no bulk user-data access or exfiltration — minimal proof only; no credential theft beyond an owner-designated test
  account; no lateral movement off `ise.uit.edu.vn`. Full command template, worker/round-step counts, and the C3/C4
  observable checklist: this file's git history (`git log -- planning_update.md`), section "13. Runbook," as of the
  2026-10-31 revision.

## 8. Records

- **This session's basis for §1:** git log (commit hashes cited there); the pre-2026-11-02-afternoon revision of
  this file (recoverable via `git log -- planning_update.md`), which carried the full H1–H3/W-I/W-J/W-K narrative
  this update compacts.
- **This session's basis for the H4/W-L row added after this document's initial 2026-11-02 revision:**
  `src/sandbox.ts` `exec()` edit and `tests/minimal/sandbox.test.ts` additions (both uncommitted at the time of
  this row); `npx vitest run tests/minimal/sandbox.test.ts` (13/13, up from 12) plus the broader related suite
  (38 passed, 10 skipped pending `P2O_TEST_DOCKER=1`); `npm run test:sandbox` under real Docker (13/13 across all
  5 files, including the two-worker broker and real-Pi delegation integration tests); `mcp__gitnexus__impact` on
  `exec` (risk `UNKNOWN`, confirmed by text-search of its DI-indirected real callers in `broker.ts`/
  `extensions/p2o/index.ts` rather than treated as an all-clear); `mcp__gitnexus__detect_changes` on the
  working-tree diff (3 files, 16 symbols, 0 affected processes, risk low).
- **This session's basis for extending the same H4/W-L row to `captureScratch()`:** direct read of
  `sandbox.ts`'s `captureScratch()` (confirmed the identical shared-catch pattern); `mcp__gitnexus__impact` on
  `captureScratch` (risk `UNKNOWN`, confirmed by text-search of its 3 real call sites in
  `extensions/p2o/index.ts:2454,3554,4737-4738`, none keyed to the old message text or to `isStopped` becoming
  true); a new `tests/minimal/sandbox.test.ts` case reusing the existing `execTimeout()` mock toggle (both
  methods dispatch through the same mocked `docker exec` branch); `npx vitest run tests/minimal/sandbox.test.ts`
  (14/14); `npm run test:sandbox` re-run under real Docker after this second edit (13/13, including the scratch-
  specific `artifacts-docker.test.ts` cases covering cap/denial/redaction, unaffected); `mcp__gitnexus__detect_changes`
  (`--scope all` and `--scope compare --base-ref main`, index refreshed first) both read `risk: critical`, 876–982
  affected processes — investigated rather than waived per this file's own standing discipline, and traced to a
  name collision: `grep -rn "\bdriver\b"` found ≥3 unrelated local test-fixture functions and one unrelated SARIF
  data field all named `driver`; the one actually touched (`sandbox.test.ts`'s) is unexported and module-private;
  every sampled "affected flow" in both `detect_changes` runs cited only the collided name — repeated 6–10 times
  within a single flow trace, never `exec`/`captureScratch`/`Sandbox` — the same artifact class already caught
  once this session (checkov/nuclei's shared `extract()` dispatch position inflating an unrelated risk reading).
- **This session's basis for the H6/W-N row:** the original H6 framing (`src/broker.ts:22` `MAX_LINE_BYTES`,
  lines 650-662 `boundedResponse()`) was re-checked against the actual call path and found incomplete — direct
  reads of `extensions/p2o/index.ts`'s `executeWithReceipt` (starts ~line 2689, the shared chokepoint for
  exec/net/http/capture/pty-read) and its `OutputCapture`/`ingestArtifact` plumbing, `src/process.ts`'s
  `OUTPUT_LIMIT = 48 * 1024`, and `src/roles.ts`'s `DEFAULT_ARTIFACT_CAPTURE_KIB = 1024` (clamped [1024, 8192]);
  confirmed the 48 KiB preview cap and 1 MiB retained-artifact cap both already apply before the 64 KB wire cap
  ever binds, and that `output()` (`extensions/p2o/index.ts` ~line 296) already discloses truncation and the
  retained artifact's ID in the tool-result text read by the calling LLM. Two real gaps fixed: `output()`'s
  `/p2o artifact <id>` pointer (a human-typed slash command per `src/ui/workspace.ts:79,195`, unreachable from any
  LLM tool-calling loop) renamed to the real `p2o_artifact` tool; `p2o_shell`/`p2o_net` descriptions
  (`extensions/p2o/index.ts:3598-3599`) now mention the 1 MiB retained-artifact net up front. Verified safe:
  `output()` is unexported/module-private with 9 real call sites, none depending on the removed text; `npx tsc
  --noEmit` clean; `npx vitest run tests/minimal/truth.test.ts tests/minimal/workflow-policy.test.ts` (19/19);
  full `tests/minimal` sweep run; `mcp__gitnexus__detect_changes` (index refreshed first): 1 file, 2 symbols,
  2 affected processes, risk medium — a real, correctly-scoped signal, not a collision artifact this time.
  Separately found, not fixed (out of scope, pre-existing): `tests/minimal/context-budget.test.ts` and
  `tests/minimal/surface-audit.test.ts` already fail on a clean checkout — the `planner` role's pinned
  declaration-budget ceiling (45,500 chars) is exceeded by 59 chars; confirmed pre-existing and unrelated to this
  change via `git stash` + re-run against the clean committed state.
- **This session's basis for the H5/W-M row:** `grep -rn "target-ops\|targetOps\|target_ops"` across `src/`
  and `extensions/` traced the full path — `src/target.ts:176-183` (CLI parse), `extensions/p2o/index.ts:4505-
  4506,4567,4610-4612,4623` (run-start resolution, ledger record, `ExecutorPool` construction), `src/executors.ts:22`
  (`readonly maxOperations`, confirmed immutable post-construction, no mid-run adjustment exists) — then
  `git log --all -S"Q26" -- '*.md'` and `git show b082634` to find the decision's origin: "P10 implements Option
  C. The scheduler half lifts the shared executor's serial queue only on an explicit --target-ops N" (2026-10-27),
  cross-checked against `docs/ACCEPTANCE_MATRIX.md`'s F-P10-1 row (tests: `sandbox.test.ts`/`workspace-runtime.test.ts`,
  marked "Covered (R)") and its repeated "Authority không đổi: planner vẫn không có tool target/lab/claim" lines.
  Found this changed what Option B could mean, surfaced to the owner via `AskUserQuestion` with a revised 3-way
  fork before writing any code; owner chose close + prompt-clarify. `mcp__gitnexus__context`/`impact` on
  `plannerInstructions` required a full `analyze --force --no-parse-cache --index-only` first (an incremental
  `--index-only` left `src/*.ts` Function nodes unresolvable again — the same gap recorded elsewhere in this
  project's memory, recurring after an incremental rather than a forced reindex); impact then read risk LOW,
  epistemic exact, 1 direct caller, 0 affected processes. `npx tsc --noEmit` clean; `npx vitest run` on
  `dispatch-discipline.test.ts` plus `authority`/`benchmark`/`broker`/`duties`/`identity-runtime`/`phase-f.test.ts`:
  120/120 passed, 1 skipped (unrelated, pre-existing); the only failures anywhere in this sweep were the
  already-known `context-budget.test.ts`/`surface-audit.test.ts` planner-budget overage, unchanged at 45559/45500
  both before and after this edit — confirms it measures tool declarations, not `plannerInstructions`' prompt text,
  so this edit cannot be its cause. `mcp__gitnexus__detect_changes --scope all`: 1 file, 1 symbol, 0 affected
  processes, risk low.
- **This session's basis for §2–§5:** direct reads of `src/sandbox.ts` (440 lines) and `src/broker.ts` (796
  lines); three parallel forked analyses — p2o's own sandbox/broker internals and its tool-surface wiring; ARTEX's
  `guard`/`agent` model read against `~/artex/ARTEX` real source plus this repo's own prior ARTEX research
  (`tmp/artex-design-report.md`, `tmp/artex-notes.md`, `tmp/research/artex-mechanisms.md`,
  `tmp/p2o-research/artex-offense.md`), itself source-verified rather than trusted blind; Strix's tool/sandbox
  model read from real local run artifacts (`~/nhanlaptop/strix_runs/*/{run.json,strix.log,.state/*.json}`) plus
  this repo's own `research/SKILL_PROVENANCE.md`/`.json` plus live web research, since no full Strix source
  checkout exists locally.
- **Earlier evidence this document does not re-copy:** the ARTEX chain-order deep dive (`e6ec569`), the skills vs.
  ARTEX prompt-catalog comparison (`agent/promptcatalog.go`'s `pentestDefaultTmpl`, `agent/planner.go:333`,
  `agent/worker.go`), P24/A–E commit history, and the full P25/1–4 acceptance record — all in `docs/HISTORY.md`,
  `docs/ACCEPTANCE_MATRIX.md`, `git show <hash>` for each commit named in §1, and `git log -- planning_update.md`
  for the pre-2026-11-02-afternoon revision's full H1–H3 narrative.
