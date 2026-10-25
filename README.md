# pi-p2o

One command. Your **current Pi agent** plans an authorized assessment; a deterministic TypeScript Engine schedules
**visible worker panes**. Workers investigate one intent autonomously. Shared-serial execution is default; isolated
assignment executors are opt-in. No hidden Planner model, provider harness or dashboard.

**Trạng thái:** `main` từ `5fab024` gồm P13–P15 và giai đoạn planner A–F: capability có kiểu (15 loại) ghép được,
payload byte-exact lưu trong control dir riêng, environment là recipe cục bộ, research tuyển chọn và hash, severity CVSS 4.0
tính từ đúng bước đã chứng minh, replay độc lập theo sha256 payload + fingerprint môi trường. **Không còn ngân sách lệnh
và không còn cổng finish**: hoàn tất được suy ra (`GOAL_UNSETTLED` / `GOAL_UNPROVEN` / `PRIMITIVE_UNCHAINED` / `CHAIN_READY`),
`p2o_finish {export:true}` chỉ ghi báo cáo và kết thúc không gì cả. Chain sống trên plan board (`chainOf`/`step`/`claimRefs`/`needs`),
frontier obligation được thi hành lúc tạo task, hai vòng im lặng liên tiếp mà vẫn còn nghĩa vụ thì wake kèm tên nghĩa vụ chứ không pause (P16.2), brief worker mang slice graph và host đếm write-back (`NO_GRAPH_WRITE` chỉ là advisory), route diversity hiện trên situation/report (`ROUTE_MONOCULTURE` advisory) và ruled-out trùng bị chặn một lần re-check, revisit
theo điều kiện, và một worker còn sống được nối lại tuỳ ý trên cùng ticket. Đó là bản mà `pi install` lấy về: canonical SQLite/schema 7, durable-local luôn confirm, visibility/checkpoint/bounded capture, [asset/fact graph K3](docs/ASSET_GRAPH.md), [work admission/kế hoạch/phase cards K4](docs/WORK_ADMISSION.md), [canonical case/proof-aware coverage K5](docs/CASE_REVIEW.md), [indexed knowledge heads/context packets K6](docs/CONTEXT_PACKETS.md) và [acceptance matrix K7](docs/ACCEPTANCE_MATRIX.md). `package.json` vẫn **0.5.0** (baseline phát hành `e639029`): chưa có version/release mới, nhãn K2–K6 bên dưới đánh dấu phần thêm sau baseline. K0–K7 **chưa hoàn tất**; installed acceptance mới là 6 test inert, chưa phải ma trận đầy đủ, Herdr thật hay hiệu quả pentest. Xem [trạng thái và gates còn lại](docs/KNOWLEDGE_WORKSPACE.md).

## Install

```sh
pi install https://github.com/Nhan-Laptop/pi-p2o
```

Tested with Pi 1.1.0, the pinned development dependency; the installed checks (`7e204c3` for K2–K7, `41e8157` for W0–W6a) ran on a managed Pi 1.1.0. Pi 1.0.0 passed the earlier 357-test inert suite and the 0.5.0 installed acceptance, but the current full inert suite and the installed checks were **not** re-run on 1.0.0 (peer dependencies stay `*`). You also need a configured model, a Linux host (`/proc/self/fd` containment), and a running local Linux Docker daemon. Install the sandbox tools image once:

```sh
docker pull ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331
```

No extension build or JSON configuration is needed. Use `/reload` after installing/updating, and stop any active assessment first. Load only one copy:
`pi` for the installed package, or `pi --no-extensions -e "$PWD"` for development.

`pi update` does nothing when `PI_OFFLINE=1` is set, yet still prints "Updated". Unset `PI_OFFLINE` for that one command, then check the revision (`git -C ~/.pi/agent/git/github.com/Nhan-Laptop/pi-p2o rev-parse HEAD`) rather than trusting the message.

## Use

```text
/p2o --target ./my-repo
/p2o --target "./directory with spaces"
/p2o --resume run-1f0c9a2e-8d5b-4c1a-9f3e-2b7d6a4c8e10
/p2o --target https://example.com
/p2o --target ./my-repo --workers 2 --max-depth 1
/p2o --target ./my-repo --export
/p2o --target ./my-repo --loop event-driven --executors isolated --workers 3 --target-ops 2
/p2o --target ./my-repo --retention ephemeral
/p2o --target https://example.com --goal "Can tenant A read tenant B invoices?"
/p2o --target ./my-repo --refer-workspace latest
/p2o --target ./my-repo --origin https://staging.example.com
/p2o pause
/p2o resume
/p2o stop
/p2o hold [reason]
/p2o release
/p2o workers
/p2o stop-worker <worker-id> [reason]

/p2o status
/p2o log [cursor] [task=<id>] [actor=<id>] [operation=<id>]
/p2o report
/p2o report export /abs/path/report-dir
/p2o graph
/p2o graph <asset-id> [cursor]
/p2o graph export [limit] [cursor]
/p2o heads [domain|all] [cursor] [limit] [status]
/p2o show <domain> <id>
/p2o digest
/p2o search <text> [cursor=N]

/p2o checkpoint [reason]
/p2o checkpoints [checkpoint-id]
/p2o artifact <artifact-id> [byte-offset]
/p2o open <run-id>
/p2o recover <run-id>
/p2o reconcile <run-id> [reason]
/p2o close
/p2o export /abs/path/bundle
/p2o import /abs/path/bundle
```

The first group starts or controls a run: `hold` refuses new target commands and worker launches without ending the run (running commands finish; reporting and `stop` stay open), `release` lifts it after confirmation, and `stop-worker` withdraws one worker; none of these has a model-callable equivalent. The second group (`status` … `search`, `workers`) is read-only: no model call, no target
operation, no change to mode or authority. `report export` writes a deterministic `REPORT.md` + CSV/JSON from committed state (no model, markup-neutralized, new directory only) after confirmation; the same report is also written automatically at the end of a durable-local run to `.p2o-reports/report-<run-id>/` (`p2o.autoReport`). The third group (K2) manages retained knowledge and runs on the
human side only; `open`, `recover` and `close` never resume an assessment. Details: [usage](docs/USAGE.md).

`--goal "text"` (optional, 1–600 characters) records what you want established, in your own words. It is shown in the confirmation and given to the lead as quoted operator data, with a request to turn it into goals with acceptance criteria. It neither widens nor narrows the objective, is not checked by code, and is not kept across a restart as lead-prompt text; it is recorded in the run ledger and printed in REPORT.md. Without it the lead prompt is unchanged.

`--avoid "text"` (optional, repeatable up to 5 times, 1–300 characters each) states something workers should stay away from, for example `--avoid "No payment flows"`. It is shown in the confirmation, added to every worker brief as a quoted `OPERATOR CONSTRAINTS` block, recorded in the run ledger and printed in REPORT.md. It is guidance to the model, not enforcement: the target label, container, ticket and broker remain the only boundary. Without it worker briefs are unchanged.

`--origin <http(s)-URL>` (optional, exactly once, pairs only with a directory `--target`) confirms a source snapshot and one deployed origin together as a **hybrid** target, sharing one graph/report. Neither half widens the other: the sandbox still only exposes the bounded read-only source copy at `/target`, while `p2o_http` may reach any http(s) host. Workers are told explicitly that source and origin are two evidence sources for one system, not one proof — a source finding is not deployed reachability until a live probe shows it, and a live anomaly is not a source root cause until traced to code. Without it, targets are classified exactly as before.

`--refer-workspace [latest|all|<run-id>,...]` (optional) lets a new run point at up to 20 prior durable-local runs on the same target (same path for a directory, same origin for a URL, same path **and** origin for a hybrid target) and tags them as context only in one lifecycle record — never same-run evidence, no restored ticket/worker authority, same principle as `/p2o export|import`. Read back through `p2o_state {action:'heads', domain:'reference'}` or `/p2o digest`; it is never pushed into the lead or worker prompt. Without it, behavior is unchanged. Details: [usage](docs/USAGE.md).

`--resume <run-id>` (Part XI S8) reopens one **durable-local** run from `<cwd>/.p2o-state`: same `runId`, same
committed records, a fresh sandbox and a fresh set of workers. No earlier ticket, operation, worker or session authority
is restored; work that was running is recorded as an interruption boundary and stays interrupted until it is explicitly
re-dispatched. The stored source snapshot and profile decide what continues, and the source must still match. Read-only
inspection stays available through `/p2o state <run-id>`.
Confirm once. The command prepares the sandbox and sends the task directly into the **existing conversation**,
using the existing model and every tool. When a worker backend is available the lead delegates; otherwise it does
the work itself. The lead reviews evidence and writes the report here. No elapsed-time or command limit is imposed
on the lead, workers or assessment. Commands/HTTP default to no task timeout; stop or finish explicitly. Normal provider charges still apply; no command, token or elapsed-time allowance is imposed on the lead, workers or the assessment. Infrastructure watchdogs do not cap investigation time.

Delegation is available when Pi runs inside [Herdr](https://herdr.dev): each worker is a real Pi process in a
neighbouring pane with its own role model. Every worker uses the owner broker; the confirmed profile selects shared or isolated execution.
Default `--loop manual` never wakes a model automatically. `--loop event-driven` requires consent for additional
model rounds on committed reports, proposals and task-review changes. Waiting is local; no periodic model polling,
automatic retry/fallback or restored-session authority. See [Planner/Engine contract](docs/PLANNER_ENGINE.md).

| Tool | Role | Purpose |
|---|---|---|
| `p2o_skill_list` / `p2o_skill_read` | lead + worker | Paginated catalog and approved skill/reference/handoff documents; IDs, never arbitrary host paths; `materialize` copies a registered script into the caller's own scratch |
| `p2o_research` | lead + worker | Cited technique lookup from the committed corpus; `action=fetch` retrieves any http(s) URL host-side and returns the full body with status, content type, byte count and sha256, plus a provenance `research` record — never evidence; `action=cve` names a product/version and the host fetches NVD/CVE pages (the suggested hosts are advice, not an allowlist), writing `lead` records with URL+`retrievedAt`+sha256; `action=triage` marks a lead `tasked`/`ruled_out`. A lead is never a finding and a claim citing one cannot be confirmed |
| `p2o_task` | lead only | Maintain focused questions, accepted prerequisite revisions, role/method decisions and reservations. A validation/retest task must cite the claim it reproduces (`work.claimRefs`) or the predecessor task it revisits; investigation and refinement must cite a claim, a pinned asset revision or a prior task |
| `p2o_candidate` | lead + worker | Evidence-linked candidate claims, proof level, controls, limitations and explicit revisions |
| `p2o_lab` (P14.2/P14.3) | lead + worker | Replayable artifacts. `payload` keeps the exact request/script/command (≤32 KiB) verbatim in the run-private control directory with its sha256; `env` records a recipe (setup commands, background services with a port or healthcheck, seed) under a name slug and returns a fingerprint, deriving it from the target `docker-compose.yml` on request and refusing `privileged`, `cap_add`, `devices`, host network/pid/ipc, host mounts, `build`, `restart` and a foreign image by name; `verify` runs the recipe in the caller's own sandbox (one ordinary receipt per command, per-service health, same fingerprint for a second worker); `destroy` stops those processes. A candidate citing `payloadRef` **and** a matching `environmentRef` derives `replayable`; nothing is stored on the claim |
| `p2o_shell` | lead + worker | Shell in the sandbox; `/target` is a read-only copy, `/work/<workerId>` is scratch, `p2o_net` for egress |
| `p2o_http` | lead + worker | curl for any http(s) URL the sandbox can reach: any method, bodies, headers, cookies, bounded redirects |
| `p2o_net` | lead + worker | Network commands in the sandbox: connect scans, service probes, tooling installs; no task timeout by default |
| `p2o_note` | lead + worker | Append a note, observation, coverage row or open item to the shared ledger |
| `p2o_surface` | lead + worker | Append one recon surface-inventory entry (component + entryPoint) with a non-blocking duplicate hint; detail stays in `p2o_note` |
| `p2o_ledger` | lead + worker | Read the shared ledger or one evidence/candidate record by ID before repeating work |
| `p2o_artifact` (K2) | lead + worker | Đọc retained redacted text theo opaque ID, ≤8 KiB/range; không chạy target hoặc cấp authority |
| `p2o_graph` (K3) | lead + worker | Scoped typed asset/fact/anchor batches; owner hypotheses/relations, provenance/revision pins, bounded history/JSON/Mermaid; owner-only `chain` joins each claim's typed `gained`/`needs` capabilities into ready/unmet steps with depth and the frontier count, and `plan:true` writes one linked todo per step (`chainOf`, `step`, `claimRefs`, `needs`) returning `chainOf` plus a `research` hint for each blocked link; không grant permission hoặc finding proof |
| `p2o_state` (K6) | lead + worker; read-only | Bounded indexed knowledge-head navigation with exact totals and a stable sequence cursor, plus plain-substring `search` over committed records (pointers, not evidence); filters never change work, proof or authority |
| `p2o_plan` (K4) | lead only | Goal/todo/decision revisions on canonical records; a chain step is a todo carrying `chainOf`, `step` (1-based, no maximum), the claims it stands on (`claimRefs`), the capabilities it needs (`needs`) and an optional `environmentRef`; `list` returns each chain's readiness line (`chain <id> 2/4 · next: step 3 (ready) · waiting on: http.request (internal-api)`); not a second task queue, scope authority or proof |
| `p2o_case` (K5) | lead only | Owner-reviewed canonical cases from exact claim/evidence/task/asset revisions; worker claims stay pending until review; `rate` accepts the chain claim's record ID or its slug; acceptance never completes a goal |
| `p2o_coverage` (K5) | lead only | Versioned coverage denominators/cells with separate execution and assessment axes; blocked or untested is never "clean" |
| `p2o_capture` (K2) | lead + worker | Đọc bounded UTF-8 text từ scratch đã cấp qua FD/single-link rồi lưu artifact redacted; không nhận host path, không thực thi nội dung file |
| `p2o_delegate` | lead | Spawn one focused worker immediately; pass `work` for exact duplicate/history checks (otherwise the identity is reported as unknown); batch/waiting work uses `p2o_task dispatch` |
| `p2o_request_subtask` | worker | Propose a missing bounded task; never directly spawn or accept work |
| `p2o_loop` | owner | Engine/frontier status, end round with wait, or explain blocked/human-needed; `wait` with `reason:"block-decay"|"cooldown-expiry"` plus a future `notBefore` (≤24 h) records one decision and schedules exactly one revisit for that condition (`REVISIT_DUPLICATE` refuses a second pending one) |
| `p2o_workers` | lead | action "list" (default): worker status, report summary, coverage, optionally wait for a report; action "steer": follow-up instruction without stopping; action "continue": one more brief on the same ticket, reusing the worker's conversation (refused only when the ticket is retired: `WORKER_CLOSED`); action "stop": revoke sandbox access and close the pane |
| `p2o_report` | worker | Report to the lead: summary, findings, evidence, coverage, open items, confidence, blocked |
| `p2o_finish` | lead | Report or end. Without `export` it is the human's terminal report: refuses while a worker has not reported, then removes and verifies all sandboxes. `{export:true}` writes `REPORT.md`/CSV to a fresh directory and **ends nothing**; both paths print the derived completion state and the `REMAINING WORK` section |

Every lead holds the worker-control tools even without a worker backend; `p2o_delegate` then refuses to launch and the lead does the work itself. `--max-depth 0` disables admission without changing the loadout. `/p2o workers` remains a human command.

Host tools, `codemode`, the browser, other extensions, `!` shell and the worker's own Docker access are blocked
while an assessment is active. A worker reaches the target **only** through the lead's broker socket; if the
lead stops, workers fail closed.

**K2 (retention):** durable-local mặc định giữ tri thức tại `.p2o-state/<run-id>` sau cleanup; luôn xác nhận location/quota/sensitivity trước tạo (kèm finalization reserve). File text trong scratch chỉ vào kho qua `p2o_capture` với kiểm tra path/FD/single-link/UTF-8 rồi redact trước khi publish; file ngoài scratch, symlink, hardlink, device, binary bị từ chối. `--retention ephemeral` xóa tri thức với control. `/p2o open <run-id>` chỉ mở lịch sử read-only, không resume assessment. `/p2o export <absolute-dir>` ghi bản sao portable có hash (segments + artifact + manifest, không overwrite); `/p2o import <absolute-dir>` xác minh hash rồi giữ exported bytes thành artifact bất biến + một provenance note (foreign redaction claims không được authenticate) trong run đang chạy — không khôi phục scope/ticket/worker/cookie/authority và không tính là same-run evidence. `/p2o reconcile <run-id>` (cần xác nhận) ghi **một** lifecycle record có attribution đánh dấu task non-terminal và operation unknown là interrupted/unknown; không rewrite task status, không resume, không cấp authority. Shell/net/curl capture prefix trước display cap 48 KiB, tổng stdout+stderr mặc định 1 MiB/operation (setting 1–8192 KiB); trả artifact IDs, total/captured bytes và partial labels. Hash/byte cursor không phải finding proof; redaction best effort, không bảo đảm hết secrets.

With `--export`, cleanup additionally saves bounded redacted receipts and source/skill hashes in `.p2o-reports/` (0700; files 0600); this legacy export is not the portable bundle (`/p2o export <absolute-dir>` writes that, human only). Review before sharing. The 0.5.0 baseline removed its temporary ledger without export; current `main` follows the confirmed retention instead.
Terminal worker failures deliver a blocked report without another model call; no provider fallback is automatic.

See [focused assessment state](docs/ASSESSMENT_STATE.md) for complete-ledger cursors, task/handoff review, current validation, progress and bounded report retention. Automatic planning is explicit opt-in; automatic retry is not introduced.
`/p2o status` also shows worker liveness (`QUIET` is a local observation, not a timeout), the runtime closure digest (entry file plus `src/**`), the Planner's context usage and model usage per role as Pi reports it — display only: no cap, retry or limit is ever derived from it, and unreported messages are counted as unknown, not estimated.

## Recon and next-task selection

The lead’s prompt contains assessment policy, not tool manuals; Pi supplies the active descriptions and schemas.
Startup uses a short kickoff instead of duplicating those instructions. Worker guidance now describes the networked transport.
Pi tool descriptions explain execution limits; they do not guarantee installed binaries. Check only prerequisites
needed for the chosen task through bounded sandbox execution; a tool the image lacks is installed into your own
scratch with a receipt, and universal startup probes are never run.
Recon records surfaces, inputs, actors/gates, Evidence IDs and unknowns. The lead records why a particular
surface/risk is next, then maps unclear gates, investigates concrete concerns and seeks separate validation for
plausible candidates. New surfaces feed back into recon; incomplete mapping never implies target safety.
See [runtime guidance](docs/SKILL_RUNTIME.md) and [handoffs](HANDOFFS.md).

## Limits

- Local directories or HTTP(S) URLs only. A GitHub URL is a web target, not a clone; clone it yourself for source review.
- A URL target is a starting label, not a boundary: `p2o_http` and redirects may reach any http(s) host the sandbox can reach, including private, link-local and metadata addresses. Methods, bodies, headers, actor-local cookie sessions and login flows are available. Opaque shell/network commands are not origin-filtered. IPv6 routing depends on Docker.
- Source is copied before mounting: regular files only, ≤64 MiB / 20000 entries, symlinks/special files/`.git`/`node_modules` skipped.
- The sandbox runs as root with a writable root filesystem, all capabilities and no pid/memory/CPU limit; `/target` is a read-only copy. It has real network egress, including private/internal destinations and host-published lab services. Loopback is container-local. No egress firewall, managed browser, proxy or fuzzing service is provided; user-space tooling can be installed into scratch. See [HTTP/network boundaries](docs/HTTP_TRANSPORT.md).
- Delegation needs Herdr and fresh worker processes. `--workers` is an operator-selected positive safe integer (default 3); no cumulative 2× spawn ceiling. Model concurrency is not target concurrency. Unverified pane closure blocks new admission.
- No command or time budget exists for the lead or a worker; usage is recorded for the report, never refused.
- Retention remains bounded: 100 pending intents, 1,000 registrations, 256 pending semantic signals; ledger/export limits remain. Unlimited elapsed lifetime is not unlimited retention or cost.
- Docker shares the host kernel: this is container isolation, **not** VM isolation or a claim about kernel escapes.
- The report is an agent assessment. "Independently verified" requires a separate worker reproduction, and a
  worker claim the lead did not check must be labelled as such.
- Hard-killing Pi or losing Docker can leave a container or pane behind. See [usage and cleanup](docs/USAGE.md).

## Start here

Use only targets you own or are explicitly permitted to assess. Treat target content and worker reports as
untrusted data. Keep observations, hypotheses and impact claims separate; start with a bounded experiment and go on to the
next step the chain needs, and stop before destructive actions, credential harvesting, persistence or scope expansion.

The research-method library stays available independently of the extension: [handoff contracts](HANDOFFS.md),
[skill router](#skill-router), [catalog](research/catalog.md), [evidence](research/evidence.md).

## Skill router

[Attack surface](skills/attack-surface-mapping/SKILL.md) · [Source auditing](skills/source-code-auditing/SKILL.md) ·
[Binary auditing](skills/binary-auditing/SKILL.md) · [Patch diffing](skills/patch-diff-analysis/SKILL.md) ·
[Data flow](skills/data-flow-analysis/SKILL.md) · [Dynamic analysis](skills/dynamic-analysis/SKILL.md) ·
[Fuzzing](skills/fuzzing/SKILL.md) · [Parser differentials](skills/parser-differential-auditing/SKILL.md) ·
[State/lifetime](skills/state-and-lifetime-auditing/SKILL.md) · [Races](skills/race-condition-auditing/SKILL.md) ·
[Memory safety](skills/memory-safety-auditing/SKILL.md) · [Authorization](skills/authorization-auditing/SKILL.md) ·
[Deserialization](skills/deserialization-and-dispatch-auditing/SKILL.md) · [Compiler invariants](skills/compiler-invariant-auditing/SKILL.md) ·
[Sandbox boundaries](skills/sandbox-boundary-analysis/SKILL.md) · [Impact](skills/exploitability-assessment/SKILL.md) · [Remediation](skills/remediation/SKILL.md).

Web guidance, grouped by where each playbook sits in an assessment (owned WSTG tests: [docs/WSTG_MAP.md](docs/WSTG_MAP.md#wstg-map-table)):
recon/config — [route inventory](skills/web-route-input-inventory/SKILL.md) · [deployment hygiene](skills/web-deployment-hygiene/SKILL.md);
identity/session — [credential lifecycle](skills/web-credential-lifecycle/SKILL.md) · [session management](skills/web-session-management/SKILL.md) · [tokens and federation](skills/web-token-and-federation/SKILL.md);
authorization/logic — [object authorization](skills/web-object-authorization/SKILL.md) · [business logic](skills/web-business-logic-misuse/SKILL.md);
injection/output — [server-side injection](skills/web-server-side-injection/SKILL.md) · [output context](skills/web-output-context/SKILL.md) · [browser trust controls](skills/web-browser-trust-controls/SKILL.md);
crypto/API — [crypto usage](skills/web-crypto-usage-review/SKILL.md) · [GraphQL](skills/web-graphql-testing/SKILL.md) · [FastAPI parity overlay](skills/fastapi-security-parity/SKILL.md).
These augment the original 17 methods; each playbook's own Handoffs section links the others it hands off to or receives from. An overlay occupies one of the existing three assignment slots.
[Provenance and exclusions](research/SKILL_PROVENANCE.md) document the selected Strix references.
[Offline Semgrep recipe](skills/source-code-auditing/recipes/offline-python-semgrep.md) requires a successful tool probe;
tool presence and usable dependencies must never be assumed from the image name. An [explicit tool-image setup](docs/SKILL_RUNTIME.md#optional-offline-tool-image) can add pinned Semgrep to the image; the sandbox itself can also fetch tooling at run time, which is receipted when it happens.

## Development

```sh
npm ci
npm test                  # types, build, unit + real-Pi delegation integration, research-library checks
npm run test:sandbox      # real Docker boundary + two-worker broker, no external target/model requests
npm run test:herdr        # opt-in: real Herdr pane spawn (opens and closes a pane in your session)
pi --no-extensions -e "$PWD"
```

The same inert real-Pi/Docker tests can target an installed copy instead of the source tree (no model, no external target):
`P2O_TEST_DOCKER=1 P2O_TEST_INSTALLED_EXTENSION=<installed-checkout>/extensions/p2o/index.ts npx vitest run tests/minimal/native.test.ts tests/minimal/planner-native.test.ts tests/minimal/docker-extension.test.ts`.
A passing run proves the installed mechanics only, not assessment quality.

Design notes: [architecture](docs/ARCHITECTURE.md), [usage](docs/USAGE.md), [Strix/ARTEX comparison and proposals](planning_update.md), [acceptance matrix](docs/ACCEPTANCE_MATRIX.md), [OWASP WSTG map](docs/WSTG_MAP.md).
[Benchmarks](bench/README.md) are opt-in real-model runs, separate from the hermetic suite; no effectiveness claim is implied by passing unit tests.
`my_references/` is not shipped or modified, except `my_references/wstg/` (the unmodified OWASP WSTG snapshot, pinned and hashed in [research/WSTG_PROVENANCE.md](research/WSTG_PROVENANCE.md)), which ships read-only as on-demand upstream text linked from each owning skill's `references/wstg-source.md`.

## Offline quality checks

`npm run check:render` / `check:orange` / `check:library` / `check:python` validate research format, required
fields, links/anchors, source/skill consistency and evidence coverage. They do **not** establish software
vulnerability, hostile-code isolation or live-target behavior. Provenance:
[catalog](research/catalog.md) · [evidence ledger](research/evidence.md) · [audit](research/AUDIT.md) ·
[taxonomy](research/TAXONOMY.md).

UNLICENSED (private).
