# Minimal architecture

```text
/p2o --target … [--solo|--workers N|--max-depth D]
  parse → classify → one scope confirmation → control dir + ledger + broker socket → Docker sandbox
  → pi.sendUserMessage(scoped brief)
  → LEAD (this conversation, this model)
       p2o_shell / p2o_http  → the single sandbox container
       p2o_note              → <control>/records.jsonl
       p2o_delegate          → Herdr pane split + agent start + ticket + brief
       p2o_workers/steer/stop_worker
       p2o_finish            → refuse unreported workers, stop panes, remove containers, verify, delete control dir

  → WORKER (real `pi` in a visible Herdr pane, `--p2o-worker <ticket>`)
       p2o_shell / p2o_http  → broker (0600 unix socket) → the LEAD runs it in the same sandbox
       p2o_note              → same ledger
       p2o_ledger            → read the shared ledger (bounded)
       p2o_delegate          → broker `delegate` → the LEAD spawns the nested pane
       p2o_report            → report + coverage + open items land in the ledger
```

## Why one sandbox with a broker

Strix gives every agent the same sandbox session: one container per scan (`_SESSION_CACHE`), handed to the model
run as `RunConfig(sandbox=SandboxRunConfig(...))`, with each `SandboxAgent` reaching it through its `Shell`
capability. Pi workers are separate processes, so the faithful translation is: the **lead owns the container** and
serves exactly that session over a private unix socket. Workers get a narrow protocol (`exec`, `http`, `note`, `ledger`,
`delegate`, `report`), never a Docker client, so policy, budgets and the single verified-cleanup path stay in one
place. A worker that cannot reach the socket fails closed and reports blocked instead of touching the host.

## Skills and evidence

`src/skills.ts` serves approved package documents through held-directory-FD reads; the broker exposes IDs only.
Active tool descriptions carry execution guidance; owner/broker checks remain authoritative.
`src/prompts.ts` shares a bounded evidence-led recon/decision contract across lead and workers; workflow prerequisites
are descriptive text, not a runtime permission/availability registry. The lead contributes policy through
`before_agent_start` → `systemPromptOptions.sections.p2o_assessment`, without replacing Pi’s complete prompt
or duplicating tool descriptions. Its startup message is a short kickoff; workers keep their existing guidance.
`src/evidence.ts` records tool receipts, validates candidate revisions and exports bounded redacted results before cleanup.
See [skill runtime](SKILL_RUNTIME.md) for schemas, failure behavior and compatibility limits.

## Files

| File | Responsibility |
|---|---|
| `extensions/p2o/index.ts` | Command, consent, role activation (`--p2o-worker`), tool registration/gating, delegation, finish reconciliation |
| `src/target.ts` | `/p2o` grammar (target plus `--solo`/`--workers`/`--max-depth`), directory classification, HTTP scope and public-IPv4 validation |
| `src/sandbox.ts` | One container owner: resource limits, run labels, per-worker working directories, verified removal and a label sweep |
| `src/source.ts` | Bounded regular-file-only source copy via Linux directory-FD traversal (no symlink races) |
| `src/ticket.ts` | Owner-private worker ticket: mint, strict validation, single-use identity, expiry, extension/image binding |
| `src/broker.ts` | Socket server + client: authentication, framing, per-worker and reserve budgets, report normalization |
| `src/records.ts` | Append-only shared ledger (note/coverage/observation/open/report/lifecycle), summary and blocking wait |
| `src/herdr.ts` | Herdr CLI client: tiled pane split, agent start with `-- <args>`, prompt/status/interrupt/close |
| `src/roles.ts` | Role → model/skills defaults with pi-herdr-style precedence, defensive settings parsing |
| `src/prompts.ts` | Lead and worker scope prompts, plus the delegation brief template |
| `src/process.ts` | Fixed-executable subprocesses with bounded output and timeout/cancellation |

## Roles and authority

- The **lead** is the model in your current conversation. It owns the human consent, the sandbox, the control
  directory, the ledger and every spawn. It is a working agent, not a dispatcher.
- A **worker** is a real `pi` process in a Herdr pane, activated only by an owner-minted ticket passed as
  `--p2o-worker <path>`. It has no host tools, no Docker, no consent dialogs and no `p2o_finish`.
- **Nesting** is allowed (Strix's "no flat structures"): a worker may request a child through the broker, but the
  lead performs the spawn, so depth (`--max-depth`) and the worker cap are enforced in one place.
- Authority never comes from the transcript, a worker report, target content or session replay. Tickets are
  validated against the running extension's bytes and image, expire with the assessment, and their tokens are
  checked against the lead's in-memory registry — so a copied ticket after a restart grants nothing, and a worker
  that reports or is stopped is revoked immediately.
- The broker's identity boundary is the **token, not the operating system**: another process running as the same
  host user can copy a live ticket and speak to the socket until that worker reports, is stopped, or the
  assessment ends. Same-user isolation is not a security boundary the extension claims to provide, which is why
  the ticket directory, socket and ledger are 0600/0700 and the window is kept short.

## Ledger, coverage and closure

The ledger (`records.jsonl`, 0600, append-only, single small writes) is the coordination medium, mirroring
Strix's notes/coverage/threat-model state. Workers append observations, coverage rows (including clean surfaces)
and open items; reports land as `report` records plus one `coverage` record per reported row and one `open` record
per open item. The lead reads it through `p2o_workers` and must reconcile open items before finishing.

Closure states come from Strix: every candidate ends `confirmed`, `ruled_out` (name the specific control) or
`open_proof_gap`; missing information is never proof of safety; findings require a counterevidence pass and honest
confidence. Delegation does **not** create independent verification by itself — that requires a separate worker
reproducing the same claim.

## Lifecycle and cleanup

`p2o_finish` refuses while a worker has neither reported nor been stopped (an idle pane may still be starting),
waits for any in-flight spawn to register first, then revokes tickets, closes panes, stops the broker, removes
containers, sweeps by run label, verifies absence and deletes the control directory. Cleanup is idempotent and
genuinely retryable after a failure, and a pane Herdr refuses to close is reported instead of being called
verified. Reporting also revokes that worker immediately, so a copied ticket stops working. Cancellation, session navigation, agent error, deadline and shutdown run the
same path; if any step fails, the tool gate stays closed and `/p2o stop` retries. A worker's Herdr status is
displayed but never used as a substitute for a report.

## Deliberate differences from Strix

Strix's prompt tells its model never to question authorization; our authority is the human confirmation dialog,
so that framing is not copied. Also not carried over: Caido proxy capture, shared browsers, in-sandbox Docker,
`sudo`, unattended autonomy budgets, and the report database. What *is* carried over is the sandbox-sharing
model, the root/worker split, the delegation rules, the shared state ledger and the closure discipline.

Passing the test suite verifies the tested mechanics — not live vulnerability-finding quality, not independent
verification, and not immunity to container escapes.
