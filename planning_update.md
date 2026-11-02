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
(§2.2). **The real weaknesses were two sharp, specific, fixable gaps in the execution layer**, both of which
actively worked against chaining rather than merely limiting it: a command timeout tore down the entire sandbox
rather than just the command (destroying exactly the listener state a chain depends on) — **fixed this session,
W-L, §1 H4** — and target-operation concurrency defaults to 1 — serialized — which doesn't back `src/prompts.ts`'s
own breadth doctrine (§1 H3, closed earlier this session on a different layer: the *prompt text* is adequate; this
session's new finding is that the *execution capacity* to follow it isn't on by default) — **still open as H5**. A
third, smaller finding (a tight 64 KB response cap, prefix-truncated silently) looked like it risked quiet evidence
loss on verbose tool output — investigated this session, **W-N, §1 H6, closed**: the original framing was
substantially overstated (a much larger, already-disclosed retained-artifact mechanism already exists one layer up);
two small real gaps were found and fixed instead. A fourth is a gap shared by all three systems — no real multi-host
pivot tooling anywhere — framed as an opportunity to leapfrog both comparison systems, not a catch-up — still open as
H7. §4 turns the two still-open items (H5, H7) into scoped proposals with a recommended reading order, pending owner
choice like every workstream before them.

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
| H3 — possible gap in ARTEX-style parallel-breadth prompt doctrine | audit only, no commit (W-K) | `src/prompts.ts` already has three breadth rules, one already ARTEX-derived from an earlier phase — not a gap *on the prompt-text layer*. See H5 below: this session's execution-layer analysis found a *different* layer where the doctrine isn't backed |
| H4 — a command timeout destroyed the whole sandbox, not just the command | `1087260` code, `83b5761` this doc (W-L, Option A) | `sandbox.ts` `exec()` **and its twin, `captureScratch()`**, both restructured: a genuine Docker-CLI-call failure still fails closed (whole-sandbox teardown, unknown-state default); a clean in-container `timeout --signal=KILL` (exit 124/137) now only fails that one operation — sandbox, PTY and any other backgrounded work stay up. `captureScratch()` needed a second, separate try/catch split (not just a moved boundary) since its docker call and its response parsing — denial-frame check, hash, scratch-snapshot build — used to share one catch; the existing denial-frame exemption is unchanged. Existing `exec` test renamed for accuracy (it covers the CLI-failure path, not this one); new tests added for both methods' clean-timeout path. `npx vitest run tests/minimal/sandbox.test.ts`: 14/14 (up from 12); `npm run test:sandbox` under real Docker: 13/13 across all 5 files, re-run after each method. `detect_changes` flagged `risk: critical`/876-982 affected processes — traced to the generic test-helper name `driver` colliding with ≥3 unrelated same-named local fixtures elsewhere in the test suite (confirmed: the touched `driver()` is unexported/module-private to `sandbox.test.ts`; every sampled "affected flow" cited only the collided name, repeated nonsensically within one flow, never `exec`/`captureScratch`/`Sandbox`) — same artifact class as the checkov/nuclei CRITICAL reading earlier this session, not a real new risk from this change |
| H6 — this document's own earlier claim that verbose tool output is silently lost past a 64 KB cap | investigated 2026-11-02, **not yet committed** (W-N, scope reduced) | The original framing (`broker.ts:22,650-662`) was substantially wrong: it missed that `executeWithReceipt`/`OutputCapture` (`extensions/p2o/index.ts`, `src/process.ts`) already cap the *visible* preview at 48 KiB — under the 64 KB wire cap, which rarely binds — and already retain the full output as a host-side artifact up to `artifactCaptureKiB`, **1 MiB by default, not 64 KB**, with the tool result already naming the artifact and saying so when truncated. Not silent; disclosed at 16× the cap this document originally described. Building W-N's original "auto-route overflow to scratch" would have mostly duplicated a bigger, already-working mechanism, so it's dropped. Two real small gaps found and fixed instead: `output()`'s per-artifact pointer named `/p2o artifact <id>` — a real command (`src/ui/workspace.ts`), but a human-typed slash command no LLM tool-loop can invoke, owner or worker alike — now names the `p2o_artifact` tool; `p2o_shell`/`p2o_net`'s tool descriptions never mentioned the retained-artifact safety net up front, only after a truncation — now both do, in 55/74 added chars respectively (fits every role's declaration-budget ceiling: `p2o_shell`/`p2o_net` aren't even in `PLANNER_TOOLS`, and worker/validation/model stayed under budget). Along the way, found `tests/minimal/context-budget.test.ts`/`surface-audit.test.ts` already failing on a clean checkout — planner's declaration budget is over its pinned ceiling by 59 chars, unrelated to this change (confirmed via `git stash`) — not fixed here, out of scope; flagged to the owner separately |

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

Still-open invariants only — H4 and H6 are done (§1).

4. **H5 — default concurrency doesn't back the prompt's own breadth doctrine. Different layer than H3, not a
   contradiction of it.** H3 (closed, audit-only) confirmed `src/prompts.ts` already instructs an agent to keep
   2–3 mechanism-different routes open (`MECHANISM FAMILIES`, `BREADTH BEFORE IDLE`) — that finding stands
   unchanged. This session's execution-layer analysis found the *sandbox* defaults `enqueueTarget`'s concurrency to
   1 (`sandbox.ts:64-76`): every target operation runs strictly one at a time unless an operator explicitly raises
   it with `--target-ops`. The prompt asks for parallel breadth; the default execution capacity to act on that
   request isn't there without an explicit opt-in. ARTEX backs its own (unenforceable-prose) breadth doctrine with
   3 real concurrent worker goroutines by default — more execution capacity behind weaker instruction than p2o
   currently has behind stronger instruction.

5. **H7 — no system compared this session has real multi-host pivot tooling. A genuine advance opportunity, not a
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

**W-M — Back the breadth doctrine with real default concurrency (addresses H5).**
- *Option A — raise the default:* bump `enqueueTarget`'s default concurrency from 1 to 2–3, matching the
  "mechanism families" count the prompt already asks for. Simplest, but a blanket default change risks surprising
  resource/cost usage on ordinary single-target work that never asked for breadth.
- *Option B — contextual:* have the lead/dispatch layer request higher concurrency automatically when a round's
  plan actually names 2+ mechanism-different routes, leaving the serialized default alone otherwise. Keeps the
  safe default for simple cases while backing the doctrine when the plan calls for it.
- *Option C — prompt-only:* tell the agent explicitly that pursuing breadth requires requesting concurrency.
  Cheapest, but — again — prose promising what the execution layer doesn't back by default.
- **Recommended: Option B, but flagged lower-confidence than W-L's pick.** This session's research didn't trace
  how or where `--target-ops` is currently set (operator-only today, as far as confirmed) — wiring the dispatch
  layer to request it automatically needs that plumbing investigated first, which this round didn't scope.

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

**W-L and W-N are done. Overall recommended reading/working order for what's left: W-M, then W-O separately.** W-M
needs a short plumbing check before its own recommendation can be acted on with confidence; W-O is a real new build
and stands on its own regardless of the other two.

## 5. Priority and effort, for the owner's call (not a decision)

W-L and W-N both shipped this session (§1 H4, H6) and are no longer open decisions, so both are dropped from this
table.

| Workstream | Addresses | Impact | Relative effort | Sequencing |
|---|---|---|---|---|
| W-M concurrency vs. breadth doctrine | H5 | Backs an existing prompt doctrine with real execution capacity | Medium (Option B; needs a plumbing check first) | Recommended first of what's left |
| W-O multi-host pivot tooling | H7 | Highest ceiling — the one gap shared by all three systems; a real advance, not a catch-up | Highest (new build) | Recommended last, stands alone |

## 6. Non-goals this round

- No code changes or commits in this document — proposals only, pending owner review, same discipline as every
  workstream closed before this one.
- No re-run or re-measurement of anything live; no Phase-5-style campaign proposed here.
- Does not re-litigate H1–H4/H6/W-I/W-J/W-K/W-L/W-N — those are closed status facts now living in §1, not open
  proposals.
- Does not restart or re-authorize P25 Phase 5 (live C3/C4 measurement) — stays deferred pending its own fresh
  owner instruction, independent of anything chosen from §4.
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
