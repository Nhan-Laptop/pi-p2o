# Offline Python candidate scan with a local Semgrep ruleset

Bounded candidate generation for [source-code auditing](../SKILL.md). This recipe never confirms a vulnerability; every hit requires a manual source-to-sink trace with reachability and control evidence.

## Purpose
Run one pinned, original local rule file against a copied Python source tree in the offline sandbox and collect machine-readable candidate locations. The tool and the ruleset are the only moving parts; no registry pack, no network fetch, no update or version check, and no automatic fix traversal. A finding is a place to start reading, not a result.

## Prerequisites
- The `semgrep` binary exists in the sandbox and its task-specific shell check has recorded a bounded run. Before relying on it, perform that check under the offline environment on tiny owned fixtures: `SEMGREP_ENABLE_VERSION_CHECK=0 SEMGREP_SEND_METRICS=off semgrep --version` and one local scan of the fixture directory with this ruleset. A version string alone is not proof that the rules install and execute; the scan result is.
- Do not use the validate stage (`--validate`) offline, even with both environment variables and `--disable-version-check`: it can fetch remote meta-lint rules, hang until the shell budget expires, and stop the sandbox. The local positive/negative fixture scan below is the gate.
- Every semgrep invocation sets `SEMGREP_ENABLE_VERSION_CHECK=0` and `SEMGREP_SEND_METRICS=off` and passes `--disable-version-check`. `--metrics=off` alone does not prevent the version check from attempting the network.
- The owner transfers the immutable ruleset from this skill into worker scratch under a fixed path. Host rules are not automatically mounted, and a worker must not supply an arbitrary host source path.
- Use bounded offline sandbox execution. Networking stays disabled; a missing tool or ruleset becomes a precise prerequisite gap rather than a registry download.
- Source input is the read-only copy with its revision or snapshot hash recorded, and the output directory exists in scratch.

## Input
- Source root: the read-only copy, for example `/target`.
- Ruleset: the reviewed local file materialized at `/work/rules/p2o-python-offline.yaml`.
- Fixture check: an owned directory in scratch, for example `/work/fixture-check`, with one positive file exercising every shipped rule kind and one negative file with the safe equivalent. It is assessment plumbing, never target source, and never report it as target evidence.
- Output: `/work/out/semgrep.json`, a fresh path that does not overwrite earlier receipts.
- Scope is the explicit source root only. Do not pass a parent directory, a home directory, or a path assembled from untrusted input.

## Invocation
Gate the ruleset on a local positive/negative fixture scan, then scan the target. Every invocation sets the offline environment, disables the version check explicitly, and wraps the engine in a shell timeout so a hung process cannot consume the whole shell budget. Never use the `--validate` stage offline and never gate on a version string or a command name.

Fixture check first, on the owned fixtures only:

```
SEMGREP_ENABLE_VERSION_CHECK=0 SEMGREP_SEND_METRICS=off timeout 45 semgrep scan --config /work/rules/p2o-python-offline.yaml --metrics=off --disable-version-check --json --output /work/out/fixture-check.json --quiet --jobs 1 --timeout 20 --max-memory 256 --no-git-ignore /work/fixture-check
```

Pass the gate only when the fixture-check JSON has an empty `errors` array, every `p2o-` rule id appears on the positive fixture, and no rule fires on the negative fixture. A parse failure, a timeout, a missing rule, or a negative-fixture hit means the ruleset or the engine is not usable in this sandbox; record the prerequisite gap instead of scanning the target.

Then the target scan:

```
SEMGREP_ENABLE_VERSION_CHECK=0 SEMGREP_SEND_METRICS=off timeout 45 semgrep scan --config /work/rules/p2o-python-offline.yaml --metrics=off --disable-version-check --json --output /work/out/semgrep.json --quiet --jobs 1 --timeout 20 --max-memory 256 --no-git-ignore /target
```

Keep `--jobs 1`, `--timeout 20`, and `--max-memory 256` as the conservative defaults for the shared 512 MiB sandbox; raise them only after a bounded run shows headroom. `--no-git-ignore` makes the scanned set depend on the explicit source root rather than on an ambient git state. Never replace `--config` with a registry name, a ruleset URL, or an automatic default, and never drop the environment variables or `--disable-version-check` to work around a slow run.

## Exit Codes
The JSON report is authoritative. `--error` is deliberately not used, so exit status does not encode the finding count. Record the raw exit status alongside the report and interpret it only together with the report: a report with an empty `errors` array and the expected `results` key means the scan completed, while a missing report or a populated `errors` array means the run failed or was partial. A shell `timeout` exit (124) is a bounded stop, not a scan result: keep any partial report, mark the coverage partial, and report a gap. When the transport also stops the sandbox, the run is blocked; finish rather than retry. Never infer findings from a nonzero status, and never treat a failed scan as clean coverage.

## Output
The report is Semgrep JSON with `results`, `errors`, `paths`, and version metadata. Extract per hit: the rule identifier (local configs may prefix it with a directory-derived namespace, so match the original rule id as a suffix), file path, line range, and the matched snippet. Record the report SHA-256 and the source snapshot hash, keep the raw JSON in scratch, and summarize only the bounded candidate list. Each candidate moves into the coverage ledger with a state of open until it is traced.

## Error Recovery
- Ruleset parse or fixture-check failure: inspect the YAML locally, correct the copy, and rerun the fixture check. Do not substitute a downloaded ruleset, and do not fall back to the validate stage.
- A first run that is too slow: narrow the source root and keep the same ruleset before changing engine settings.
- Timeouts: reduce the scanned scope or lower `--jobs`, then rerun one bounded command and record the changed parameters.
- A shell timeout that stops the sandbox: the transport tears the sandbox down and later commands return no active sandbox. Do not retry target commands or the scan. Keep the partial output, record a blocked lifecycle result and an execution gap, state that the recipe result is unproven rather than clean, and finish the assessment.
- Missing binary or ruleset: record the prerequisite gap and stop; do not attempt installation or a registry fetch.
- Engine errors: keep the partial report, mark the coverage partial, and re-run with one variable changed at a time.

## Manual Validation
For each candidate, read the matched call in context and trace the value to its origin. Confirm attacker influence, the reachable path, and whether a control applies on that path before the effect. A pattern match without a trace is a non-finding. Record the named control when the candidate is ruled out, and an explicit proof gap when it cannot be resolved; then hand the traced candidate to the appropriate technique owner.

## Provenance
Adapted from reference R6, the reviewed Semgrep CLI guidance, keeping explicit configuration, bounded scope, machine-readable output, and failure recovery, and rejecting registry fetching, telemetry defaults, its broader command catalogue, and its ruleset-validation step as an offline gate. That step can fetch remote meta-lint rules and time out in the sandbox even with the offline environment and `--disable-version-check` set, so the recipe validates syntax and function with an owned positive/negative fixture scan instead. The ruleset in [p2o-python-offline.yaml](semgrep-rules/p2o-python-offline.yaml) is original to this library, candidate-oriented, and deliberately small. See [skill provenance](../../../research/SKILL_PROVENANCE.md).

## Handoffs
Send each traced candidate to [source code auditing](../SKILL.md) for the convention sweep, [data flow analysis](../../data-flow-analysis/SKILL.md) for unresolved influence, [deserialization and dispatch auditing](../../deserialization-and-dispatch-auditing/SKILL.md) for parser-selected behavior, or [web object authorization](../../web-object-authorization/SKILL.md) when the candidate is an unbound object reference. Include the report hash, source revision, ruleset hash, and the candidate's coverage state.
