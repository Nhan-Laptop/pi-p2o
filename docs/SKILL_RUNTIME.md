# Skills, capabilities and evidence

P2O keeps target execution inside its owner-managed sandbox. Reading knowledge does not grant another tool,
network route, session identity or filesystem capability.

## Knowledge

Both lead and worker have `p2o_skill_list {offset?}`, `p2o_skill_read {id, offset?}` and `p2o_capabilities`.
Listing is paginated (eight skills); read results contain `nextOffset` when another page is required. The
catalog's document IDs include main skills, owned references, recipe/rule documents, `shared:scope`,
`shared:handoffs`, and approved evidence-ledger sections. Relative links are rewritten to `p2o-skill:` IDs.
Hashes identify original package document bytes, not target evidence; read text may have rewritten links.
The first page of each assigned skill is inlined with explicit continuation instructions.

`skills/catalog.json` separates technique/playbook/overlay and lists workflow-level `allOf`/`anyOf`
prerequisites. `p2o_delegate` optionally accepts a `workflow` shared by its selected skills. Missing prerequisites
are returned in `capabilityWarnings`, included in the brief and recorded as open items. Do not select a blocked
dynamic workflow if source review is sufficient. No selected workflow means no automatic gap for every possible
technique mentioned by the skill. Overlay assignments still count against the three-skill limit.

Catalog IDs are not host paths. Every package-file component is opened relative to a held Linux directory FD
with no symlink following; only registered documents are reachable. Knowledge calls have separate bounded
budgets (400 lead reads, 200 worker knowledge/coordination calls), not the target command reserve. The registry
is instantiated per assessment; document pages retain consistent bytes/hashes during that run.

## Capabilities

`p2o_capabilities {}` reports policy permission, target applicability, runtime availability and limits.
An unknown runtime is neither supported nor forbidden. Optional `probe: "python" | "semgrep"` runs a fixed,
bounded offline functional check once per run and attaches its evidence ID. These probes never download or
install software. The Semgrep check requires an actual finding on a tiny synthetic input, not just `--version`.
The original pinned image may lack Semgrep; unavailable is an honest outcome, not a successful scan.

Authenticated requests, bodies, browser execution, managed local labs, OAST and parallel-request harnesses
remain unsupported. An offline renderer or simulated bot cannot prove execution in a real browser. Source
snapshots exclude `.git`; tool/rules/database availability is independent of source availability.

## Evidence and candidates

Each target command/request receives an owner-generated evidence ID. Receipts store run/actor/target identity,
start/end times, command/request, exit/status information, bounded redacted output, truncation and an output hash.
A receipt proves what the tool returned, not that the agent's interpretation is true. A hash is not a replacement
for a retained artifact.

`p2o_candidate` records a claim with these fields:

- `candidate`: stable lowercase slug; `surface`, `risk`.
- `closure`: `confirmed`, `ruled_out`, `open_proof_gap`.
- `execution`: `tested`, `not_tested`, `blocked`, `not_applicable`.
- `proof`: `static_trace`, `offline_reproduction`, `live_reproduction`.
- `evidenceRefs`, `negativeControls`: same-run command receipt IDs.
- `limitations`: required; `control`: required for `ruled_out`.
- `requirement`: known capability ID required for `blocked`.
- `supersedes`: latest candidate record ID for revisions; contradictory branches are rejected, not silently merged.
- `resolves`: open-item IDs closed by this evidence-backed candidate, keeping the original history.
- `independentEvidenceRef`: requires another worker's receipt and a matching runtime-tested candidate recorded
  by that worker. The lead must still inspect semantics; metadata is not an independent truth oracle.

Blocked execution cannot establish closed runtime proof. Unknown evidence IDs and malformed transitions are
rejected with actionable errors. Legacy notes/reports remain accepted as attributed text; their `clean` outcome
is only a summary of the stated tested slice, never proof of universal safety. New records use version 2 and IDs;
old records without them remain readable. The ledger shows IDs so workers can cite observations without rerunning
work. Projections are bounded; this is not an unbounded artifact store.

## Persistence and failures

Choose `/p2o --target ./source --export` before the assessment. Its confirmation explains retention. Before
cleanup, an exclusive 0600 JSON export is written under cwd `.p2o-reports/` (0700); no arbitrary export path or
artifact-symlink traversal is accepted. It includes source snapshot hashes, loaded document hashes, lead model,
image/extension identity, capabilities and ledger records. Worker role/model selections remain in lifecycle
records. It never copies tickets or authentication files. **Redaction is best effort: review before sharing.**
Without `--export`, cleanup removes the ledger. Export errors are reported; teardown still proceeds. A missing
ledger cannot become a success-looking empty export on retry.

At final worker settlement, a missing `p2o_report` produces a blocked report without a new model request.
Automatic continuations are allowed to finish first. If the broker is lost or the process is killed, the lead
must explicitly withdraw it using `p2o_stop_worker`; idle/unknown Herdr states never prove completion. Benchmark
runs have an additional deadline and mark provider/transport failures separately from security negatives.

See the opt-in runner in `bench/README.md` for real-provider evaluation. Unit tests do not establish assessment
quality or platform independence; this implementation requires a Linux host for FD-relative containment.
