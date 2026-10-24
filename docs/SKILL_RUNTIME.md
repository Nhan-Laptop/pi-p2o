# Skills, tool guidance and evidence

Reading knowledge never grants a tool, network route, identity or filesystem capability. Target execution stays in the
owner-managed sandbox.

## Knowledge tools

- Lead and worker both have `p2o_skill_list {query?, offset?}` (8 per page, keyword search, playbooks and overlays first)
  and `p2o_skill_read {id, offset?}` (follow `nextOffset`). Document IDs cover skills, their references, recipes, scripts,
  `shared:scope`, `shared:handoffs`, `shared:wstg-map` and approved evidence sections; relative links become `p2o-skill:` IDs.
- `p2o_skill_read {id, materialize: true}` copies a registered skill script (`skills/<skill>/scripts/*.py`) into the
  caller's own scratch at `<work>/skills/<id>.py` and returns `{path, sha256, bytes}`. It reads the package bytes,
  never a host path, and the sandbox re-reads what it wrote: a hash mismatch or a denied write fails closed instead of
  reporting an artifact. Anything that is not a registered script is read as a document instead.
- Catalog IDs are not host paths: every component is opened relative to a held directory FD without following symlinks,
  and only registered documents are reachable. Hashes identify package bytes, not target evidence.
- `skills/catalog.json` separates technique / playbook / overlay and lists descriptive workflow prerequisites;
  `p2o_delegate` validates a workflow ID against the assigned skills (max 3, overlays count) but never infers tools.
- `p2o_delegate` takes `role`, `skills`, optional `model` and `thinking` (per-spawn → role setting → lead's level). A
  qualified `provider/model` is passed as separate `--provider`/`--model`; no provider fallback.
- When `skills` is omitted, `PURPOSE_SKILLS` in `src/roles.ts` picks the default set from the work purpose (`work.purpose`,
  else derived from the role): mapping → `attack-surface-mapping`, discovery/refinement → `source-code-auditing`,
  retest → `remediation`, exploitation/chaining → `exploit-design`, investigation/validation/reporting → none (the legacy
  general delegate keeps its empty default). P15 adds a second axis: `purposeSkills(purpose, {kind, needs})` lets the target
  kind and the capabilities a step consumes pick the member of the family — a URL run maps with `web-deployment-hygiene` and
  discovers with `web-route-input-inventory`, an exploitation step adds the ladder its `work.needs` names, and no context
  keeps the base table. Validation and reporting ship no default on purpose: reproduction must not discover, and synthesis
  must not author fixes, so `exploitability-assessment`/`remediation` stay reachable only by explicit request. An explicit
  `skills` list or an operator `roles.<role>.skills` setting still wins, an empty purpose list falls back to the role
  default, and `role` keeps choosing the model. `tests/minimal/roles.test.ts` checks every id against `skills/catalog.json`.
- Nine purposes (`WORK_PURPOSES`) each carry a duty, the failure they prevent and the output that counts as finished; every
  worker reads its duty line, keyed by purpose and derived from the role only when the lead supplied no structured work.
  `exploitation` takes a confirmed primitive to a demonstrated effect (payload, environment, observation — or the exact
  wall) and `chaining` composes two demonstrated primitives into an effect neither reaches alone. The `exploit` role exists
  to dispatch that work; like every role it selects a model and a starting skill set and grants no scope.
- `p2o_research {query, web?, limit?}` looks a technique up in the committed corpus at `knowledge/techniques/` and
  returns cited entries (title, kind, prerequisites, tags, source, licence, sha256). With `web: false` it never touches
  the network. By default it also fetches the top hits' **own** source URLs inside the caller's sandbox — the query cannot
  name a destination — and returns a bounded quoted excerpt with the hash of the page it read, recorded as a `research`
  ledger record (`source`, `url`, `license`, `sha256`, `bytes`, `fetchedAt`, injection signals). Research is never
  evidence and never a finding; a page that instructs the reader is reported as untrusted text and changes no state.
  Research is not a target command: a lookup carries no command and no separate counter.
- Budgets: 400 lead reads; 200 worker knowledge/coordination calls (knowledge stops at 160). These are not command reserves.

## Prompt and recon

- The lead gets one structured `p2o_assessment` section (role, scope, recon strategy, delegation, evidence rules,
  cleanup) — policy, not tool manuals; Pi supplies tool descriptions. It is replaced, never appended, and removed when no
  run is active. A delegated Pi is a strategic Planner; only solo investigates.
- Recon records a bounded surface inventory (inputs, actors, gates, boundaries, Evidence IDs, extraction method,
  labelled unknowns). Pick the next surface by reachable influence, sensitive effect, boundary uncertainty, evidence,
  information gain and cost, and note why. Unclear gates go back to mapping, plausible candidates to a *separate*
  validator, blocked proof stays open. Shared contract: [HANDOFFS](../HANDOFFS.md#h1--recon--static-analysis).
- An unknown tool: run a bounded functional check and cite its receipt; user-space tools can be installed into scratch
  through `p2o_net`. For Semgrep, keep metrics off and use local rules (`--validate` fetches remote meta-lints).

## Optional offline tool image

The default pinned base can lack Semgrep and several userspace analysis tools. Explicit operator setup (not an agent tool):

```sh
bash scripts/setup-sandbox-tools.sh --build
pi --p2o-image sha256:<64-hex-image-id>     # use the immutable ID the build printed
```

The build always pins Semgrep 1.179.0. An optional `--with=<tool1,tool2,...>` adds more tools from a fixed, pinned
list — `angr` (10.0.3), `z3` (z3-solver 5.1.0.0), `binwalk` (2.1.0), `mitmproxy` (12.2.3), `unicorn` (2.1.4) — e.g.
`bash scripts/setup-sandbox-tools.sh --build --with=angr,z3,binwalk,mitmproxy,unicorn`. Each is installed into its own venv
as root at build time only; every resolved dependency set lands in that venv's own `requirements.resolved.txt`
(not a bit-for-bit reproducibility claim). The running container is unchanged by `--with` — still `--read-only`,
`--cap-drop ALL`, non-root — so this only pre-installs tools that were already reachable at runtime via `p2o_shell`/
`p2o_net` (what this repo's own tool-reachability analysis calls Bucket 2); it does not reopen `ptrace`, raw
sockets, a display, or root, and so cannot make a Bucket-3 tool (a live debugger, a kernel sanitizer, a GUI
decompiler) reachable — see `planning_update.md` for that distinction and for Bucket-3 substitutes that do work
inside this sandbox. Resulting binaries on `PATH`: `semgrep`, and with `--with`, `angr`/`angr-python3`,
`z3`/`z3-python3`, `binwalk`, `mitmdump`, `unicorn-python3`. Nothing is built or pulled automatically; mutable tags are rejected, and
the confirmation names the image that is passed into worker tickets.

## Evidence and candidates

Every target command or request gets an owner-generated evidence ID; its receipt stores actor, target, timing, command,
status, bounded redacted output, truncation and an output hash. A receipt proves what the tool returned, not that the
interpretation is right.

`p2o_candidate` records an attributed claim:

- `candidate` slug, `surface`, `risk`; `closure` = `confirmed` | `ruled_out` | `open_proof_gap`; `execution` =
  `tested` | `not_tested` | `blocked` | `not_applicable`; `proof` = `static_trace` | `offline_reproduction` | `live_reproduction`.
- `evidenceRefs` / `negativeControls`: same-run receipt IDs. `limitations` required; `control` required for `ruled_out`;
  `requirement` required for `blocked`.
- `policyBasis` = `explicit_contract` | `boundary_invariant` | `inferred`, with `expectedPolicy` naming rule and source.
  Inferred policy must stay `open_proof_gap`, even when a sibling looks safe.
- `gained` / `needs`: the capability edge. `gained` is what this primitive hands to a later step (an address-space
  write, a chosen call target, a token, a state transition); `needs` is what it still needs first. Both are typed,
  `{kind, subject?, scope?}` over the closed `CAPABILITY_KINDS`, and `subject`/`scope` only have to agree when both sides
  name one. A claim without them can still be true, but nothing downstream can consume it. A pre-P14 record's free-text
  `provides`/`requires` is still read and displayed, marks the claim legacy, and satisfies no typed need.
- `payloadRef`: the payload artifact from `p2o_lab` that actually ran (kind `request` | `script` | `command`, ≤32 KiB,
  stored verbatim in the run-private control directory and never exported). It requires `tested` execution. The report
  derives `replayable` from it — the flag is never stored — so a claim without one is labelled "not replayable" instead
  of implying a second worker could reproduce it.
- `supersedes` (latest record ID), `resolves` (open items), `independentEvidenceRef` (another worker's receipt plus its
  matching runtime-tested candidate at the latest revision; withdrawn support is rejected, the lead still judges semantics).
- `payloadRef`: the payload artifact from `p2o_lab` that actually ran — a request, script or command of at most 32 KiB,
  stored verbatim in the run-private control directory and never exported. It requires `tested` execution.
- `environmentRef`: the environment recipe it was demonstrated in (`p2o_lab action=env`). A recipe is setup commands,
  background services with a port or healthcheck, and seed commands, run as local processes in the caller's own sandbox —
  the sandbox has no Docker daemon and gets no socket, so no part of an environment is a privilege boundary. The fingerprint
  is the sha256 of the normalized recipe: the same recipe is the same environment (re-registering it is idempotent), a
  changed one is the next revision, and `verify` reports per-service health under that fingerprint, so two workers reproduce
  the same environment while each keeps its own processes.
- `p2o_lab action=env compose=true` derives the recipe from the target's own `docker-compose.yml|compose.yaml` in the
  read-only mount. That file is target-controlled input, so a closed allowlist runs first: `privileged`, `cap_add`,
  `devices`, `network_mode`/`pid`/`ipc` `host`, `restart`, host bind mounts, `build:` and an `image:` other than the
  assessment image are refused **by name**, and one refusal means no recipe at all rather than a stripped one. Everything
  else the filter does not translate is refused the same way, so a feature it failed to notice cannot widen the environment.
- `replayable` is derived (`payloadRef` **and** a matching `environmentRef`), never stored; a claim that has only one of the
  two is labelled "not replayable" rather than implying a second worker can reproduce it.

Blocked execution cannot close runtime proof. Legacy notes and reports stay readable as attributed text; their `clean`
outcome only summarizes the tested slice. `p2o_ledger {id}` returns one full bounded record so agents cite instead of rerun.
Skill selection never enables tools. Cases, coverage and graph: [CASE_REVIEW](CASE_REVIEW.md), [ASSET_GRAPH](ASSET_GRAPH.md).

## Persistence and failures

`--export` (chosen before the run) writes an exclusive 0600 JSON export under `.p2o-reports/` before cleanup, with
source/skill/image/extension hashes and ledger records (never tickets or auth files). Redaction is best effort: review
before sharing. Without `--export` the ledger is deleted at cleanup; an export error never blocks teardown.

A worker that settles without `p2o_report` yields a blocked report with no extra model call. If its broker is lost,
the lead must withdraw it with `p2o_workers` (action: 'stop'); idle Herdr states never prove completion. Linux is required (FD-relative
containment). Real-provider evaluation: `bench/README.md`; unit tests do not establish assessment quality.
