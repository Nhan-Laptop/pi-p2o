# Offline Python candidate scan with a local Semgrep ruleset

Bounded candidate generation for [source-code auditing](../SKILL.md). This recipe never confirms a vulnerability; every hit requires a manual source-to-sink trace with reachability and control evidence.

## Purpose
Run one pinned, original local rule file against a copied Python source tree in the offline sandbox and collect machine-readable candidate locations. The tool and the ruleset are the only moving parts; no registry pack, no network fetch, and no automatic fix traversal. A finding is a place to start reading, not a result.

## Prerequisites
- The `semgrep` binary exists in the sandbox. Probe it before relying on it: record `semgrep --version` and one run against a tiny local input with this ruleset, and retain the raw output. A version string alone is not proof that the rules install and execute.
- The owner transfers the immutable ruleset from this skill into worker scratch under a fixed path. Host rules are not automatically mounted, and a worker must not supply an arbitrary host source path.
- Workflow capability `shell.offline`. Networking stays disabled; a missing tool or ruleset becomes a precise capability gap rather than a registry download.
- Source input is the read-only copy with its revision or snapshot hash recorded, and the output directory exists in scratch.

## Input
- Source root: the read-only copy, for example `/target`.
- Ruleset: the reviewed local file materialized at `/work/rules/p2o-python-offline.yaml`.
- Output: `/work/out/semgrep.json`, a fresh path that does not overwrite earlier receipts.
- Scope is the explicit source root only. Do not pass a parent directory, a home directory, or a path assembled from untrusted input.

## Invocation
Validate the ruleset first, then scan. Both commands keep metrics off and write nothing to the network.

```
semgrep scan --validate --config /work/rules/p2o-python-offline.yaml --metrics=off
```

```
semgrep scan --config /work/rules/p2o-python-offline.yaml --metrics=off --json --output /work/out/semgrep.json --quiet --jobs 1 --timeout 20 --max-memory 512 --no-git-ignore /target
```

Keep `--jobs 1` and `--max-memory 512` as the conservative defaults for a shared sandbox; raise them only after a bounded run shows headroom. `--no-git-ignore` makes the scanned set depend on the explicit source root rather than on an ambient git state. Never replace `--config` with a registry name, a ruleset URL, or an automatic default.

## Exit Codes
The JSON report is authoritative. `--error` is deliberately not used, so exit status does not encode the finding count. Record the raw exit status alongside the report and interpret it only together with the report: a report with an empty `errors` array and the expected `results` key means the scan completed, while a missing report or a populated `errors` array means the run failed or was partial. Never infer findings from a nonzero status, and never treat a failed scan as clean coverage.

## Output
The report is Semgrep JSON with `results`, `errors`, `paths`, and version metadata. Extract per hit: the rule identifier (local configs may prefix it with a directory-derived namespace, so match the original rule id as a suffix), file path, line range, and the matched snippet. Record the report SHA-256 and the source snapshot hash, keep the raw JSON in scratch, and summarize only the bounded candidate list. Each candidate moves into the coverage ledger with a state of open until it is traced.

## Error Recovery
- Ruleset parse or validate error: inspect the YAML locally, correct the copy, and rerun. Do not substitute a downloaded ruleset.
- A first run that is too slow: narrow the source root and keep the same ruleset before changing engine settings.
- Timeouts: reduce the scanned scope or lower `--jobs`, then rerun one bounded command and record the changed parameters.
- Missing binary or ruleset: record the capability gap and stop; do not attempt installation or a registry fetch.
- Engine errors: keep the partial report, mark the coverage partial, and re-run with one variable changed at a time.

## Manual Validation
For each candidate, read the matched call in context and trace the value to its origin. Confirm attacker influence, the reachable path, and whether a control applies on that path before the effect. A pattern match without a trace is a non-finding. Record the named control when the candidate is ruled out, and an explicit proof gap when it cannot be resolved; then hand the traced candidate to the appropriate technique owner.

## Provenance
Adapted from reference R6, the reviewed Semgrep CLI guidance, keeping explicit configuration, bounded scope, machine-readable output, and failure recovery, and rejecting registry fetching, telemetry defaults, and its broader command catalogue. The ruleset in [p2o-python-offline.yaml](semgrep-rules/p2o-python-offline.yaml) is original to this library, candidate-oriented, and deliberately small. See [skill provenance](../../../research/SKILL_PROVENANCE.md).

## Handoffs
Send each traced candidate to [source code auditing](../SKILL.md) for the convention sweep, [data flow analysis](../../data-flow-analysis/SKILL.md) for unresolved influence, [deserialization and dispatch auditing](../../deserialization-and-dispatch-auditing/SKILL.md) for parser-selected behavior, or [web object authorization](../../web-object-authorization/SKILL.md) when the candidate is an unbound object reference. Include the report hash, source revision, ruleset hash, and the candidate's coverage state.
