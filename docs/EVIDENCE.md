# Evidence, claims, cases and the report

Knowledge never grants authority: the run's blanket authorization grants the instrument, and a receipt or a case changes
neither scope nor permission. This page covers what counts as evidence, how it becomes a claim and a case, how coverage is
derived, and what the report may say.

## Receipts are the evidence ceiling

Every target command or HTTP request gets a host-generated receipt: actor, target, timing, command, status, bounded
best-effort-redacted output, truncation and an output hash. A receipt proves what the tool returned, not that the
interpretation is right.

- The receipt is bounded: input excerpt ≤2,000 B, stdout ≤16 KiB, stderr ≤4 KiB, before redaction. Cite the receipt; keep a
  longer observation in a capture artifact and cite both.
- Partial output is labelled partial; a capture prefix precedes the 48 KiB display cap, and `p2o_capture` writes scratch
  files into retained, redacted artifacts by FD/single-link/UTF-8 checks (never a host path).
- Redaction is best-effort. The container sees the resolved command line and a worker can print or encode a value, so review
  receipts and exports before sharing.

## Claims

`p2o_candidate` is a worker-only, attributed claim; the host stamps `data.taskRef` from the assignment so a validation can
anchor to the task that produced it. A planner call is refused with `WORKER_ONLY` and a legal next.

- `closure` = `confirmed` | `ruled_out` | `open_proof_gap`; `execution` = `tested` | `not_tested` | `blocked` |
  `not_applicable`; `proof` = `static_trace` | `offline_reproduction` | `live_reproduction`.
- `evidenceRefs` and `negativeControls` are same-run receipt IDs. `limitations` is required; a `ruled_out` claim needs a real
  control; a `blocked` claim needs a `requirement` naming the tool or host that actually refused, or the exhausted approach —
  never a missing binary, dependency, credential or browser.
- `policyBasis` = `explicit_contract` | `boundary_invariant` | `inferred`, with `expectedPolicy` naming the rule and its
  source. Untested inference stays `open_proof_gap`; an effect that establishes the boundary itself (unauthenticated code
  execution, a cross-principal read with no credential, attacker-URL reach into metadata or a private network, an
  unprivileged root-owned write, or a crossing observed with only the attacker's own credential) is `boundary_invariant`.
  A sibling route, a placeholder credential or a CVE advisory alone is a hypothesis, and a functional effect reached
  through a CVE-seeded hypothesis is confirmed by the trigger, never by the advisory.
- `gained` / `needs` are the typed capability edge: `{kind, subject?, scope?}` over the closed kinds in
  `src/capabilities.ts` (net.egress, http.request, auth.bypass, cred.session, cred.secret, file.read, file.write, exec.code,
  db.query, deserialize, cloud.role, host.shell, dns.resolve, admin.ui, data.read). A claim without them can be true, but
  nothing downstream can join it. Free-text `provides`/`requires` from older runs is displayed as legacy and matches nothing.
- `supersedes` names the record it replaces; `resolves` names open items; `independentEvidenceRef` points at another worker's
  receipt plus its matching tested claim — withdrawn support is rejected and the planner still judges semantics.
- `replayable` is derived (a `payloadRef` **and** a matching `environmentRef`), never stored; a claim with only one half is
  labelled "not replayable" instead of implying reproduction.

## Replayable lab artifacts

`p2o_lab` keeps what actually ran, in the run-private control directory (never exported):

- `payload` stores the exact request/script/command bytes (≤48 KiB) with sha256; `payload materialize:true` copies them into
  the caller's own scratch at `payload/<id>` and returns path/hash/size instead of the body.
- `env` records a recipe (setup commands, background services with a port or healthcheck, seed) under a name and returns a
  fingerprint. `compose:true` derives it from the target's own `docker-compose.yml|compose.yaml`, under a closed filter:
  `privileged`, `cap_add`, `devices`, host network/pid/ipc, host bind mounts, `build:`, `restart` and a foreign image are
  refused by name, and one refusal means no recipe at all. Everything the filter does not translate is refused the same way.
- `verify` runs the recipe in the caller's own sandbox (one ordinary receipt per command, per-service health, same
  fingerprint for a second worker); an id created in another sandbox must be registered locally with the same recipe first.
  `destroy` stops those processes. Nothing here is a privilege boundary: the sandbox has no Docker daemon or socket.

## Cases: claim → case → finding

1. A worker claim is attributed evidence, not a finding. `confirmed` on a claim only means "claimed confirmed — pending
   review".
2. `p2o_case_author` (planner) pins the exact claim, asset/task/hypothesis revisions, evidence, report,
   contradictions and limitations.
3. Only a case that is `accepted` + `confirmed` + canonical (no `duplicateOf`) + `currentness=current` counts as a unique
   accepted-current finding. That still does not mean the assessment is done or the target is safe.

Review rules: create is always `pending`, a missing remediation is recorded as `unplanned` with a truthful reason, and
`accepted|disputed|withdrawn` need a revision with the expected revision number. No case is accepted with an open
contradiction. `confirmed` needs a tested claim with a non-inferred policy basis; `ruled_out` needs a current ruled-out claim
plus a concrete control. If a validator withdraws, the case and report go stale. A duplicate is decided by
`policyKey` + `rootCauseKey`, never by title, CWE or severity, and a duplicate does not raise the unique finding count.
`implemented` remediation is not "fixed": `accepted` needs a reviewed retest task with evidence.

**Independence** needs a *different* worker's matching reproduction: its own demonstrated claim cites the receipt, on the
same surface and risk. If the author's claim names a payload or environment, the second claim must run the same payload
sha256 and the same recipe fingerprint (host-stamped values, not prose). A mismatch, an uncited receipt or withdrawn support
is named in the case's reason; the case can still be rated, but `independentCurrent` stays false. A host-created validation
task (one per confirmed+tested claim of a worker, after its discovery task is reviewed) is how the independent worker gets
that work; the task declares the exact method dispatch will resolve from the same role, purpose and `work.needs`, because a
declared/recomputed mismatch is refused at spawn; if no worker backend exists the task is created visibly `blocked` with
`missingPrerequisites`.

**Rating** (`p2o_case_rate`) records a separate note bound to the case revision: `severity` (critical…informational), a
required `basis`, optional `cvssVector` (the host computes CVSS 3.1 in `src/cvss.ts`), CWE and references, and up to five
reproduction steps `{ref, role, note?}` with roles baseline/proof/verification/supporting as labels only. A `critical`/`high` rating is refused when
it rests on an inferred-basis claim that was never tested and observed (`confirmed` + `tested` + a non-static proof). When
every inferred-basis claim was tested and observed, the rating is allowed at demonstrated depth, records the
`INFERRED_POLICY` provenance flag
and needs a `limitations` entry naming what the inference rests on; it still cannot exceed what the chain demonstrated. A
revised case makes the old rating `STALE_RATING` (reported, not fatal).

**Chain** (`chain` inside the rating) records the exploitation chain the run built: 1–8 ordered steps, each citing a
same-run claim, with typed `gained`/`needs` edges. Steps up to `demonstratedThrough` must be confirmed+tested; the step at
`demonstratedThrough` must name its `effect` (`confidentiality-read`, `integrity-write`, `availability-loss`,
`authentication-bypass`, `code-execution`, `cross-tenant-read`, `sandbox-escape`), which the host maps to CVSS 4.0 impact
(`src/cvss4.ts`). A step without `reach` is scored at the worst case, so missing evidence can only lower the score. Rating
above what was demonstrated is refused with the vector and score; a chain with no executed step or no `effect` cannot be
rated at informational.

## Coverage: two axes, host-derived

Coverage has an execution axis (`unplanned | planned | running | attempted | tested | blocked | not_applicable`) and an
assessment axis (`unreviewed | confirmed_claim | ruled_out_bounded | open_gap | accepted | stale`). The host derives each
cell from a reviewed task with a work identity, the worker claim stamped with that task, the accepted case and the pinned
asset revision — every read re-derives it, nothing is written by a model.

| Reviewed task head | execution | assessment |
|---|---|---|
| proposed / reserved / running / reported | `planned` | `unreviewed` |
| blocked / cancelled / expired (no verdict) | `blocked` | `open_gap` |
| satisfied + evidence + accepted-current case citing it | `tested` | `accepted` |
| satisfied + evidence + confirmed claim | `tested` | `confirmed_claim` |
| satisfied + evidence + ruled-out claim with a real negative control | `tested` | `ruled_out_bounded` |
| satisfied + evidence + still-open claim | `tested` | `open_gap` |
| satisfied + evidence, no claim/case verdict | `planned` | `unreviewed` |

Precedence is accepted > confirmed_claim > ruled_out_bounded > open_gap. Currentness flags (`superseded-claim`,
`stale-case`, `stale-asset`, `superseded-task`, `stale-target`) only downgrade; nothing self-upgrades. A task that ended
without a verdict leaves `blocked/open_gap` — never `tested` — and a legacy stored cell that recorded a verdict is read as
`attempted` and reported as `INTERRUPTED_CELL`. A task with no asset is an `unmapped` gap on the board, in report counts
(`unmappedTasks`, `unmappedCoverageTasks`) and as an `UNMAPPED_TASK` advisory. A plan with no derived cell cannot be
reviewed, and 100% cells is never "clean": blocked, untested, stale, not-applicable and unmapped are not clean.
`blocked`/`untested`/`stale` never count as evidence of absence. Plans written before the projection carry stored cells and
are read-only legacy; cell identity is target revision + asset revision + question/policy key + actor/tenant + method family.

## The report

A `durable-local` run writes a deterministic report at cleanup (finish, `/p2o stop`, shutdown, session change, storage
failure) to `<cwd>/.p2o-reports/report-<run-id>-final/`; a manual mid-run `/p2o report export [absolute-dir]` writes to
`report-<run-id>/` by default, from committed state, with no model call and no target access. Same sequence means same bytes.
The directory is new (never overwritten) and files are 0700/0600: it may contain redacted target data and can sit inside the
project, so review it and do not commit it. `p2o.autoReport` disables the automatic report.

Files: `REPORT.md`, `cases.csv`, `coverage.csv`, `report-manifest.json` (per-file hashes, `asOfSequence`, runtime digest),
plus v2 sections and `findings.json` / `findings.csv` / `wstg-checklist.csv` when there are cases or WSTG cells. Target- and
model-authored text is neutralized (no links, HTML or fences; CSV formulas blocked). Order: "not a safety guarantee" →
provenance → coverage and gaps before cases → accepted-current cases → other cases → worker claims → tasks/handoffs →
limits. An empty run says "no accepted-current case", never "0 vulnerabilities". Severity is assigned by the planner through
case rating; the host computes CVSS from the vector and prints CWE, remediation, WSTG, proof level, receipt author,
redacted reproduction steps and the chain in order with each step's effect, demonstrated impact and stopping point.

**Completion is derived** (`src/completion.ts`): `complete` only when every goal is reviewed/closed with proof still holding
(or settled `blocked` with its unreachable statement), no confirmed+tested claim is unconsumed and no chain step is ready
without a live task. Remaining obligations carry codes (`GOAL_UNSETTLED`, `GOAL_UNPROVEN`, `PRIMITIVE_UNCHAINED`,
`CHAIN_READY`, `RESEARCH_DEBT`) and ids, and are printed in `## REMAINING WORK` with the finish preflight. `RESEARCH_DEBT`
counts gateable debt only: planning signal (unplanned assets, cells not yet run, WSTG suggestions, unrecorded mappings) is
reported but is not owed work. A goal settled `blocked` prints as **settled with debt** in the brief, the report and
`completionLine` instead of disappearing, and leaves the open set. The preflight (`src/finish-preflight.ts`) is report
material, not a gate:
obligation codes such as `UNREVIEWED_TASK`, `UNREVIEWED_CLAIM`, `PENDING_CASE`, `STALE_CASE`, `STALE_CELL`,
`NO_COVERAGE_PLAN`, `NONTERMINAL_CELLS`, `UNRATED_ACCEPTED_CASE`, and advisories such as `STALE_RATING`,
`ORPHAN_TASK`, `UNPLANNED_ASSETS`, `UNMAPPED_TASK`, `WSTG_APPLICABLE_UNPLANNED`, `FOREIGN_EVIDENCE`,
`HIGH_WITHOUT_INDEPENDENCE`, `INTERRUPTED_CELL`, `NO_GOAL_RECORDED`, `ADMISSION_REFUSALS`, `ROUTE_MONOCULTURE`,
`NEGATIVE_MAY_BE_BLOCKED`. `p2o_finish {export:true}` writes a report and ends nothing; `p2o_finish` without export is the
human's terminal report and refuses while a worker has not reported.

Provenance carries the authority lines (planner/worker target operations, tasks, claims, validation tasks, stalled rounds,
wakes, campaign partial stops, human resumes, stall escalations) and the mode/role matrix, so which policy produced the run
is readable from the report rather than console history. An `exploit` run also prints `## Access ladder` derived from
reviewed claims (observed → executed → controlled → crossed → impact); `assess` mode prints one line instead.

Limits: 100 live cases, 10 live coverage plans, lists of 20 (≤100, results ≤24 KiB), rows ≤16 KiB, knowledge reads 400
(planner) / 160–200 (worker). No TTL and no automatic retry. A mechanics test proves the mechanism, not the quality of a
finding.
