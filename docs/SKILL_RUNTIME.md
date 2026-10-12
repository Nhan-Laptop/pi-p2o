# Skills, tool guidance and evidence

Reading knowledge never grants a tool, network route, identity or filesystem capability. Target execution stays in the
owner-managed sandbox.

## Knowledge tools

- Lead and worker both have `p2o_skill_list {query?, offset?}` (8 per page, keyword search, playbooks and overlays first)
  and `p2o_skill_read {id, offset?}` (follow `nextOffset`). Document IDs cover skills, their references, recipes,
  `shared:scope`, `shared:handoffs`, `shared:wstg-map` and approved evidence sections; relative links become `p2o-skill:` IDs.
- Catalog IDs are not host paths: every component is opened relative to a held directory FD without following symlinks,
  and only registered documents are reachable. Hashes identify package bytes, not target evidence.
- `skills/catalog.json` separates technique / playbook / overlay and lists descriptive workflow prerequisites;
  `p2o_delegate` validates a workflow ID against the assigned skills (max 3, overlays count) but never infers tools.
- `p2o_delegate` takes `role`, `skills`, optional `model` and `thinking` (per-spawn → role setting → lead's level). A
  qualified `provider/model` is passed as separate `--provider`/`--model`; no provider fallback.
- Budgets: 400 lead reads; 200 worker knowledge/coordination calls (knowledge stops at 160). These are not command reserves.

## Prompt and recon

- The lead gets one structured `p2o_assessment` section (role, scope, recon strategy, delegation, evidence rules,
  cleanup) — policy, not tool manuals; Pi supplies tool descriptions. It is replaced, never appended, and removed when no
  run is active. A delegated Pi is a strategic Planner; only solo investigates.
- Recon records a bounded surface inventory (inputs, actors, gates, boundaries, Evidence IDs, extraction method,
  labelled unknowns). Pick the next surface by reachable influence, sensitive effect, boundary uncertainty, evidence,
  information gain and budget, and note why. Unclear gates go back to mapping, plausible candidates to a *separate*
  validator, blocked proof stays open. Shared contract: [HANDOFFS](../HANDOFFS.md#h1--recon--static-analysis).
- An unknown tool: run a bounded functional check and cite its receipt; user-space tools can be installed into scratch
  through `p2o_net`. For Semgrep, keep metrics off and use local rules (`--validate` fetches remote meta-lints).

## Optional offline tool image

The default pinned base can lack Semgrep. Explicit operator setup (not an agent tool):

```sh
bash scripts/setup-sandbox-tools.sh --build
pi --p2o-image sha256:<64-hex-image-id>     # use the immutable ID the build printed
```

The build pins Semgrep 1.179.0 and records resolved dependencies in `/opt/p2o-semgrep/requirements.resolved.txt`
(not a bit-for-bit reproducibility claim). Nothing is built or pulled automatically; mutable tags are rejected, and the
confirmation names the image that is passed into worker tickets.

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
- `supersedes` (latest record ID), `resolves` (open items), `independentEvidenceRef` (another worker's receipt plus its
  matching runtime-tested candidate at the latest revision; withdrawn support is rejected, the lead still judges semantics).

Blocked execution cannot close runtime proof. Legacy notes and reports stay readable as attributed text; their `clean`
outcome only summarizes the tested slice. `p2o_ledger {id}` returns one full bounded record so agents cite instead of rerun.
Skill selection never enables tools. Cases, coverage and graph: [CASE_REVIEW](CASE_REVIEW.md), [ASSET_GRAPH](ASSET_GRAPH.md).

## Persistence and failures

`--export` (chosen before the run) writes an exclusive 0600 JSON export under `.p2o-reports/` before cleanup, with
source/skill/image/extension hashes and ledger records (never tickets or auth files). Redaction is best effort: review
before sharing. Without `--export` the ledger is deleted at cleanup; an export error never blocks teardown.

A worker that settles without `p2o_report` yields a blocked report with no extra model call. If its broker is lost,
the lead must withdraw it with `p2o_stop_worker`; idle Herdr states never prove completion. Linux is required (FD-relative
containment). Real-provider evaluation: `bench/README.md`; unit tests do not establish assessment quality.
