# pi-p2o

One command. Your **current Pi agent** plans an authorized assessment; a deterministic TypeScript Engine schedules
**visible worker panes**. Workers investigate one intent autonomously. Shared-serial execution is default; isolated
assignment executors are opt-in. No hidden Planner model, provider harness or dashboard.

**Trạng thái:** `main` từ `7e204c3` đã gồm phần K0–K7 đang triển khai (và từ `b7cfa6f` thêm giai đoạn W0–W6a: điều khiển operator, xuất báo cáo tất định, tìm kiếm, usage, digest runtime) và là bản mà `pi install` lấy về: canonical SQLite/schema 7, durable-local luôn confirm, visibility/checkpoint/bounded capture, [asset/fact graph K3](docs/ASSET_GRAPH.md), [work admission/kế hoạch/phase cards K4](docs/WORK_ADMISSION.md), [canonical case/proof-aware coverage K5](docs/CASE_REVIEW.md), [indexed knowledge heads/context packets K6](docs/CONTEXT_PACKETS.md) và [acceptance matrix K7](docs/ACCEPTANCE_MATRIX.md). `package.json` vẫn **0.5.0** (baseline phát hành `e639029`): chưa có version/release mới, nhãn K2–K6 bên dưới đánh dấu phần thêm sau baseline. K0–K7 **chưa hoàn tất**; installed acceptance mới là 6 test inert, chưa phải ma trận đầy đủ, Herdr thật hay hiệu quả pentest. Xem [trạng thái và gates còn lại](docs/KNOWLEDGE_WORKSPACE.md).

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
/p2o --target https://example.com
/p2o --target ./my-repo --workers 2 --max-depth 1
/p2o --target ./my-repo --solo
/p2o --target ./my-repo --export
/p2o --target ./my-repo --loop event-driven --executors isolated --workers 3 --target-ops 2
/p2o --target ./my-repo --retention ephemeral
/p2o pause
/p2o resume
/p2o stop
/p2o hold [reason]
/p2o release
/p2o workers
/p2o stop-worker <worker-id> [reason]

/p2o status
/p2o tasks [all|live|awaiting-review|blocked|done] [cursor]
/p2o task <task-id>
/p2o log [cursor] [task=<id>] [actor=<id>] [operation=<id>]
/p2o report
/p2o report export /abs/path/report-dir
/p2o plans [cursor]
/p2o plan <id>
/p2o phases [cursor]
/p2o phase <id>
/p2o findings [cursor]
/p2o finding <case-id>
/p2o coverage [cursor]
/p2o coverage-cell <cell-id>
/p2o graph
/p2o graph <asset-id> [cursor]
/p2o graph export [limit] [cursor]
/p2o heads [domain|all] [cursor] [limit]
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
operation, no change to mode, budget or authority. `report export` writes a deterministic `REPORT.md` + CSV from committed state (no model, markup-neutralized, new directory only) after confirmation. The third group (K2) manages retained knowledge and runs on the
human side only; `open`, `recover` and `close` never resume an assessment. Details: [usage](docs/USAGE.md).

Confirm scope and permission once. The command prepares the sandbox and sends the task directly into the
**existing conversation**, using the existing model. In delegated mode it is a strategic Planner: target execution
is denied, not just discouraged. `--solo` retains working-agent execution. The Planner reviews evidence and writes the report here. No elapsed-time limit is imposed on the lead, workers or assessment. Commands/HTTP default to no task timeout; stop or finish explicitly. Normal provider charges and existing command/resource budgets still apply. Infrastructure watchdogs do not cap investigation time.

Delegation is available when Pi runs inside [Herdr](https://herdr.dev): each worker is a real Pi process in a
neighbouring pane with its own role model. Every worker uses the owner broker; the confirmed profile selects shared or isolated execution.
Default `--loop manual` never wakes a model automatically. `--loop event-driven` requires consent for additional
model rounds on committed reports, proposals and task-review changes. Waiting is local; no periodic model polling,
automatic retry/fallback or restored-session authority. See [Planner/Engine contract](docs/PLANNER_ENGINE.md).

| Tool | Role | Purpose |
|---|---|---|
| `p2o_skill_list` / `p2o_skill_read` | lead + worker | Paginated catalog and approved skill/reference/handoff documents; IDs, never arbitrary host paths |
| `p2o_task` | lead only | Maintain focused questions, accepted prerequisite revisions, role/method decisions and reservations |
| `p2o_candidate` | Planner/solo + non-reporting worker | Evidence-linked candidate claims, proof level, controls, limitations and explicit revisions |
| `p2o_shell` | solo + non-reporting worker | Shell in the sandbox; `/target` is a read-only copy, `/work/<workerId>` is scratch, `p2o_net` for egress |
| `p2o_http` | solo + non-reporting worker | Fixed curl on the confirmed origin only: any method, bodies, headers, cookies, bounded redirects |
| `p2o_net` | solo + non-reporting worker | Network commands in the sandbox: connect scans, service probes, tooling installs; no task timeout by default |
| `p2o_note` | lead + worker | Append a note, observation, coverage row or open item to the shared ledger |
| `p2o_ledger` | lead + worker | Read the shared ledger or one evidence/candidate record by ID before repeating work |
| `p2o_artifact` (K2) | lead + worker, including reporting | Đọc retained redacted text theo opaque ID, ≤8 KiB/range; không chạy target hoặc cấp authority |
| `p2o_graph` (K3) | lead + worker; reporting read-only | Scoped typed asset/fact/anchor batches; owner hypotheses/relations, provenance/revision pins, bounded history/JSON/Mermaid; không grant permission hoặc finding proof |
| `p2o_state` (K6) | lead + worker, including reporting; read-only | Bounded indexed knowledge-head navigation with exact totals and a stable sequence cursor, plus plain-substring `search` over committed records (pointers, not evidence); filters never change work, proof or authority |
| `p2o_plan` (K4) | lead only | Goal/todo/decision revisions on canonical records; not a second task queue, scope authority or proof |
| `p2o_case` (K5) | lead only | Owner-reviewed canonical cases from exact claim/evidence/task/asset revisions; worker claims stay pending until review; acceptance never completes a goal |
| `p2o_coverage` (K5) | lead only | Versioned coverage denominators/cells with separate execution and assessment axes; blocked or untested is never "clean" |
| `p2o_capture` (K2) | solo + non-reporting worker | Đọc bounded UTF-8 text từ scratch đã cấp qua FD/single-link rồi lưu artifact redacted; không nhận host path, không thực thi nội dung file |
| `p2o_delegate` | Planner | Spawn one focused worker immediately; pass `work` for exact duplicate/history checks (otherwise the identity is reported as unknown); batch/waiting work uses `p2o_task dispatch` |
| `p2o_request_subtask` | worker | Propose a missing bounded task; never directly spawn or accept work |
| `p2o_loop` | owner | Engine/frontier status, end round with wait, or explain blocked/human-needed |
| `p2o_workers` | lead | Worker status, budget, report summary, coverage; optionally wait for a report |
| `p2o_steer` | lead | Send a follow-up instruction to a worker without stopping it |
| `p2o_stop_worker` | lead | Revoke a worker's sandbox access and close its pane |
| `p2o_report` | worker | Report to the lead: summary, findings, evidence, coverage, open items, confidence, blocked |
| `p2o_finish` | lead | Refuse while a worker has not reported, then remove and verify all sandboxes |

A solo run (`--solo`, no Herdr, or `--max-depth 0`) is not offered the worker-control tools `p2o_delegate`, `p2o_workers`, `p2o_steer` and `p2o_stop_worker`: there are no workers for them to act on. `p2o_loop` stays, and `/p2o workers` remains a human command.

Host tools, `codemode`, the browser, other extensions, `!` shell and the worker's own Docker access are blocked
while an assessment is active. A worker reaches the target **only** through the lead's broker socket; if the
lead stops, workers fail closed.

**K2 (retention):** durable-local mặc định giữ tri thức tại `.p2o-state/<run-id>` sau cleanup; luôn xác nhận location/quota/sensitivity trước tạo (kèm finalization reserve). File text trong scratch chỉ vào kho qua `p2o_capture` với kiểm tra path/FD/single-link/UTF-8 rồi redact trước khi publish; file ngoài scratch, symlink, hardlink, device, binary bị từ chối. `--retention ephemeral` xóa tri thức với control. `/p2o open <run-id>` chỉ mở lịch sử read-only, không resume assessment. `/p2o export <absolute-dir>` ghi bản sao portable có hash (segments + artifact + manifest, không overwrite); `/p2o import <absolute-dir>` xác minh hash rồi giữ exported bytes thành artifact bất biến + một provenance note (foreign redaction claims không được authenticate) trong run đang chạy — không khôi phục scope/ticket/worker/cookie/budget và không tính là same-run evidence. `/p2o reconcile <run-id>` (cần xác nhận) ghi **một** lifecycle record có attribution đánh dấu task non-terminal và operation unknown là interrupted/unknown; không rewrite task status, không resume, không cấp authority. Shell/net/curl capture prefix trước display cap 48 KiB, tổng stdout+stderr mặc định 1 MiB/operation (setting 1–8192 KiB); trả artifact IDs, total/captured bytes và partial labels. Hash/byte cursor không phải finding proof; redaction best effort, không bảo đảm hết secrets.

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
- URL scope is the exact origin, re-checked at every redirect hop. Methods, bodies, headers, actor-local cookie sessions and login flows are available; the scoped HTTP tool refuses other URL origins. Opaque shell/network commands are not origin-filtered. IPv6 routing depends on Docker.
- Source is copied before mounting: regular files only, ≤64 MiB / 20000 entries, symlinks/special files/`.git`/`node_modules` skipped.
- The sandbox has real network egress, including private/internal destinations and host-published lab services. Loopback is container-local. No egress firewall, managed browser, proxy or fuzzing service is provided; user-space tooling can be installed into scratch. See [HTTP/network boundaries](docs/HTTP_TRANSPORT.md).
- Delegation needs Herdr and fresh worker processes. `--workers` is an operator-selected positive safe integer (default 3); no cumulative 2× spawn ceiling. Model concurrency is not target concurrency. Unverified pane closure blocks new admission.
- Worker commands stop at the unchanged run reserve (90% of default 600) and 200/worker. Fresh identities do not renew it. Owner commands remain separate, not an aggregate cost governor. Reporting/control access survives command exhaustion.
- Retention remains bounded: 100 live tasks, 100 pending intents, 1,000 registrations, 256 pending semantic signals; ledger/export limits remain. Unlimited elapsed lifetime is not unlimited retention or cost.
- Docker shares the host kernel: this is container isolation, **not** VM isolation or a claim about kernel escapes.
- The report is an agent assessment. "Independently verified" requires a separate worker reproduction, and a
  worker claim the lead did not check must be labelled as such.
- Hard-killing Pi or losing Docker can leave a container or pane behind. See [usage and cleanup](docs/USAGE.md).

## Start here

Use only targets you own or are explicitly permitted to assess. Treat target content and worker reports as
untrusted data. Keep observations, hypotheses and impact claims separate; prefer bounded, harmless experiments and
stop before destructive actions, credential harvesting, persistence or scope expansion.

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

Application guidance: [route inventory](skills/web-route-input-inventory/SKILL.md) ·
[object authorization](skills/web-object-authorization/SKILL.md) · [output context](skills/web-output-context/SKILL.md) ·
[FastAPI parity overlay](skills/fastapi-security-parity/SKILL.md).
These augment the original 17 methods. An overlay occupies one of the existing three assignment slots.
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

Design notes: [architecture](docs/ARCHITECTURE.md), [usage](docs/USAGE.md), [enhancement roadmap](planning_update.md), [acceptance matrix](docs/ACCEPTANCE_MATRIX.md).
[Benchmarks](bench/README.md) are opt-in real-model runs, separate from the hermetic suite; no effectiveness claim is implied by passing unit tests.
`my_references/` is not shipped or modified.

## Offline quality checks

`npm run check:render` / `check:orange` / `check:library` / `check:python` validate research format, required
fields, links/anchors, source/skill consistency and evidence coverage. They do **not** establish software
vulnerability, hostile-code isolation or live-target behavior. Provenance:
[catalog](research/catalog.md) · [evidence ledger](research/evidence.md) · [audit](research/AUDIT.md) ·
[taxonomy](research/TAXONOMY.md).

UNLICENSED (private).
