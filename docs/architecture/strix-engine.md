# Strix engine notes → what pi-p2o adopts

References: [`usestrix/strix` at d218c29](https://github.com/usestrix/strix/tree/d218c29ed1b8a41208ba3a6700c3776854467721).
The cached checkout at `99c0711` is 19 commits older; the current coordinator, runner, hooks and session
files were byte-compared with that cache, while changed finish behavior was read from the current source.
These are source-inspection findings, not a runtime benchmark or a claim of feature parity.

## How a Strix scan runs

| Mechanism | Where | Transfer to pi-p2o |
|---|---|---|
| Target-typed entry (`strix --target <url\|repo\|ip\|openapi\|postman>`, instruction separate from scope) | `strix/interface/cli_args.py`, `strix/core/inputs.py` | Adopt: a target-driven **plan proposal**, then owner batch approval → run manifest. |
| Root agent orchestrates only; never touches the target | `strix/skills/coordination/root_agent.md` | Already ours: the supervisor is deterministic; the LLM only proposes. |
| Shared run-scoped **threat model** (`save_threat_model` / `get_threat_model` / `amend_threat_model`; normalized target key; size caps; attributed append-only addenda) | `strix/tools/threat_model/tools.py`, `root_agent.md` | Adopt (planner WS): one document every worker reads and may amend, so findings reconcile. |
| Per-agent **todo** list (priority/status, mirrored to `todos.json`) | `strix/tools/todo/tools.py` | Adopt in bounded form: proposal tasks carry priority/status; no free-form agent todo store. |
| Shared **coverage** entries (`record_coverage` / `update_coverage` / `list_coverage`, `needs_follow_up` reconciled before `finish_scan`) | `strix/tools/coverage/tools.py`, `strix/report/coverage.py` | Adopt: proposal approval materializes coverage cells; finish requires every open cell resolved or reported as untested. |
| Dynamic subagents mid-run (`agents_graph`) | `strix/tools/agents_graph/tools.py` | Already ours: `p2o_subtask` + supervisor admission (owner-granted). |
| Analysis skills: `counterevidence`, `severity_calibration`, `fix_verification`, `hypothesis` (property-based differential testing) | `strix/skills/analysis/*`, `strix/skills/tooling/hypothesis.md` | Adopt: falsification requirement per hypothesis; severity calibration; local differential fuzzing pack. |
| Skill taxonomy: `scan_modes/`, `reconnaissance/`, `frameworks/{django,fastapi,nestjs,nextjs}`, `technologies/`, `protocols/{graphql,oauth}`, `vulnerabilities/*`, `tooling/*` | `strix/skills/**` | Adopt structure for new method skills; keep our question-routed library. |

## How Strix actually touches a target

| Mechanism | Where | Transfer to pi-p2o |
|---|---|---|
| Shell + Python tools inside the run's Docker sandbox | `strix/tools/shell`, `strix/skills/tooling/python.md` | Not adopted: our workers get an allowlisted capability broker, never a host shell. |
| Browser via **agent-browser CLI over CDP** (no Playwright/Puppeteer), accessibility snapshot with `@eN` refs, click/fill/screenshot/multi-session, `http_proxy` env wiring | `strix/skills/tooling/agent_browser.md`, `strix/tools/agent_browser/` | Adopt mechanism (CDP + snapshot/refs) as a **broker-bound capability** with scope enforcement and evidence capture; host Chrome is already present. |
| Proxy = **Caido** (host-side API: `list_requests`, `view_request`, `repeat_request`, `list_sitemap`, `view_sitemap_entry`, `scope_rules`), bootstrapped per run | `strix/tools/proxy/*`, `strix/runtime/caido_*` | Adopt the surface shape (list/view/repeat/sitemap/scope) with our own loopback capture proxy; no third-party daemon in the trust path. |
| Scan tools pre-installed in the sandbox image (nmap, sqlmap, ffuf, nuclei, katana, httpx, subfinder, naabu, hurl, semgrep) | `strix/skills/tooling/*`, `containers/` | Adopt contract: pinned lab image + runner capabilities; no runtime installs during an assessment. |
| `web_search`, `view_image` | `strix/tools/*` | Out of scope for the target plane; model/documentation egress stays separate. |
| Findings pipeline: dedupe, SARIF, pricing/usage, coverage | `strix/report/*` | Retain separate receipt validation, finding verification and coverage; model agreement alone is not proof. |

## Deliberate non-transfers

- Prompt-only scope enforcement and root/worker tool symmetry — we enforce at dispatch **and** connection.
- Unrestricted fan-out — caps, depth, per-target concurrency and leases stay.
- A free shell inside the sandbox as the universal escape hatch — every capability is brokered and budgeted.
- "Report completed" as proof of finding — classification, verification and coverage remain separate states.

## Workstream mapping

1. **Live vertical slice** — local lab target + owner scenario + real model, proving the live path
   (gateway → real `pi` worker → brokered tools → evidence → verifier → report) end to end.
2. **Planner** — target-driven plan proposal (tasks + observations + skills + caps), owner batch approval,
   shared threat model with attributed amendments, coverage reconciliation.
3. **Packs** — browser (CDP, scope-enforced, evidence-capturing), proxy/interception (capture + repeat),
   fuzzing (in-process differential + pinned external-tool lab image), VM boundary as a documented
   non-claim until a runtime exists.

## Autonomous-run design decisions

- **Budget:** Strix [hooks](https://github.com/usestrix/strix/blob/d218c29ed1b8a41208ba3a6700c3776854467721/strix/core/hooks.py) use accumulated spend and reserve-stop behavior and acknowledge in-flight overshoot. Here the provider wire completion limit must match pre-dispatch reservation, including reasoning, with protected verifier/report pools and a partial outcome on exhaustion.
- **Restart:** Strix [runner](https://github.com/usestrix/strix/blob/d218c29ed1b8a41208ba3a6700c3776854467721/strix/core/runner.py) restores coordinator/session state and [report state](https://github.com/usestrix/strix/blob/d218c29ed1b8a41208ba3a6700c3776854467721/strix/report/state.py) restores costs. Here restoration must additionally prove the approved source identity and old resource termination before granting fresh sessions; spent counters must not reset.
- **Verification:** HTTP/source references in [reporting](https://github.com/usestrix/strix/blob/d218c29ed1b8a41208ba3a6700c3776854467721/strix/tools/reporting/tool.py) inform presentation, not proof. External replay must use the existing scope-enforcing broker; source claims require preserved bytes, exact spans and separate runtime hypotheses.
- **Packs:** adapt the target-driven tool workflow, not unrestricted shell access. Setup plans are fixed, reviewed actions requiring human consent; qualification does not silently install or re-pin software.

These decisions are acceptance requirements. Module tests do not prove the first-use command wires every module, and inert-model qualification is not a live assessment.
