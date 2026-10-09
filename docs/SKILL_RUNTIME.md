# Skills, tool guidance and evidence

P2O keeps target execution inside its owner-managed sandbox. Reading knowledge does not grant another tool,
network route, session identity or filesystem capability.

## Knowledge

Both lead and worker have `p2o_skill_list {query?, offset?}`, `p2o_skill_read {id, offset?}`.
Listing is paginated (eight skills), supports keyword search, and surfaces application playbooks/overlays before general techniques; read results contain `nextOffset` when another page is required. The
catalog's document IDs include main skills, owned references, recipe/rule documents, `shared:scope`,
`shared:handoffs`, and approved evidence-ledger sections. Relative links are rewritten to `p2o-skill:` IDs.
Hashes identify original package document bytes, not target evidence; read text may have rewritten links.
The first page of each assigned skill is inlined with explicit continuation instructions.

`skills/catalog.json` separates technique/playbook/overlay and lists descriptive workflow prerequisites.
`p2o_delegate` can validate a workflow ID against assigned skills, but does not infer tool availability or grant
permissions from those descriptions. Verify only prerequisites relevant to a selected task. Overlay assignments
still count against the three-skill limit.

Delegation accepts optional `thinking` alongside `model`. Thinking precedence is per-spawn override, role setting, then the lead's current level. A qualified `provider/model` is passed to worker Pi as separate `--provider` and `--model` arguments, and startup records capture the actual model and thinking level. No provider fallback is automatic.

Catalog IDs are not host paths. Every package-file component is opened relative to a held Linux directory FD
with no symlink following; only registered documents are reachable. Knowledge calls have separate bounded
budgets (400 lead reads, 200 worker knowledge/coordination calls, with knowledge stopping at 160 used to reserve 40 coordination calls), not the target command reserve. The registry
is instantiated per assessment; document pages retain consistent bytes/hashes during that run.

## Tool guidance and reconnaissance

The lead receives assessment policy in one structured `p2o_assessment` section: role, confirmed scope,
recon/decision strategy, delegation, evidence safeguards and cleanup. Tool tutorials, argument spelling and
pagination instructions are not repeated there. Startup sends only a short kickoff instead of a second policy
copy. The section is replaced, not appended, and removed when no assessment is active; finalization cannot
reactivate target work. Pi’s other prompt sections and active tool declarations are left intact.
Delegated Pi is a strategic Planner; only solo investigates. Worker instructions and briefs describe the current transport; approved methodology remains content, not authority. Enforced reporting loadouts cannot execute target tools or record candidates; workers propose subtasks, not nested dispatch. See [Engine contract](PLANNER_ENGINE.md).

Pi exposes active tool descriptions and schemas. They describe enforced limits, not installed binaries.
For a selected task needing an unknown tool, make a bounded functional check and cite its receipt. Needed user-space tools can be downloaded/installed into sandbox scratch through `p2o_net`; no host/root installation or universal startup probes. The base image may lack Semgrep.
Keep metrics/version checks disabled and local rules only; Semgrep's `--validate` fetches remote meta-lints.
If timeout/cancellation stops an executor, that assignment cannot restart it automatically; report gaps. Default shared mode may affect peers; isolated mode does not remove their executors.

The owner/broker enforce lifecycle, tickets, budgets and scoped HTTP URL origins. HTTP supports bodies, auth headers, cookies and bounded redirects. Opaque shell/network commands have unrestricted bridge egress, not origin enforcement; managed browser/proxy/OAST transports are not provided. Offline parsing is not browser proof; source is not deployment proof. See [HTTP/network boundaries](HTTP_TRANSPORT.md).

Recon records a bounded surface inventory with inputs, actors, gates/handlers, boundaries, Evidence IDs,
extraction method and labeled unknowns. Choose the next task per surface by reachable influence, sensitive effect,
boundary uncertainty, evidence strength, information gain and remaining budget. Record the rationale in a note;
no whole-target mapping claim or numerical risk score is implied. Correct assumptions when observations disagree.
Unclear entries return to mapping; plausible candidates proceed to separate validation; blocked proof stays open.
See [handoffs](../HANDOFFS.md#h1--recon--static-analysis) for the shared contract.

## Optional offline tool image

The default pinned base can lack Semgrep. Explicit operator setup (not an agent tool) is available:

```sh
bash scripts/setup-sandbox-tools.sh --build
# Copy the immutable sha256:... ID printed by the build:
pi --p2o-image sha256:<64-hex-image-id>
```

Setup downloads packages while building, pins Semgrep 1.179.0, and records resolved dependencies inside
`/opt/p2o-semgrep/requirements.resolved.txt`. Transitive dependencies are resolved at build time; this is not
a claim of bit-for-bit rebuild reproducibility. The finished image ID pins the exact runtime. Assessment
execution remains unprivileged but the sandbox is now networked. No setup script or image pull occurs automatically; needed user-space tools may be installed into scratch with receipts.
The human confirmation names the selected immutable image; the same binding is passed into worker tickets.
Mutable tags are rejected. Default installations and model settings are unchanged.

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
- `policyBasis`: `explicit_contract`, `boundary_invariant`, or `inferred`; `expectedPolicy` names the rule and its provenance. Inferred policy must remain `open_proof_gap`, including when a sibling appears safe.
- `limitations`: required; `control`: required for `ruled_out`.
- `requirement`: bounded descriptive prerequisite/scope failure required for `blocked`.
- `supersedes`: latest candidate record ID for revisions; contradictory branches are rejected, not silently merged.
- `resolves`: open-item IDs closed by this evidence-backed candidate, keeping the original history.
- `independentEvidenceRef`: requires another worker's receipt and a matching runtime-tested candidate recorded
  by that worker at its latest relevant revision. Withdrawn support is rejected. The lead must still inspect semantics; metadata is not an independent truth oracle.

Blocked execution cannot establish closed runtime proof. Missing policy or observations remain open proof gaps; a blocked reason is an attributed claim, not automatically verified availability. Unknown evidence IDs and malformed transitions are
rejected with actionable errors. Legacy notes/reports remain accepted as attributed text; their `clean` outcome
is only a summary of the stated tested slice, never proof of universal safety. New records use version 2 and IDs;
old records without them remain readable. The ledger is available to both roles, with `p2o_ledger {id}` for one complete bounded record, so agents can cite observations without rerunning
work. Projections are bounded; this is not an unbounded artifact store.

Owner-only questions, accepted prerequisite revisions, role/method hashes, cursor deltas, request-local objective refresh and committed normalized reports are described in [assessment state](ASSESSMENT_STATE.md). Skill selection never enables tools. Shared coordination follows [focused method and review](../HANDOFFS.md#focused-method-and-review); the handoff scaffold is initially unresolved/unreviewed, not evidence acceptance.

## Persistence and failures

Choose `/p2o --target ./source --export` before the assessment. Its confirmation explains retention. Before
cleanup, an exclusive 0600 JSON export is written under cwd `.p2o-reports/` (0700); no arbitrary export path or
artifact-symlink traversal is accepted. It includes source snapshot hashes, loaded document hashes, lead model,
image/extension identity and ledger records. Worker role/model selections remain in lifecycle
records. It never copies tickets or authentication files. **Redaction is best effort: review before sharing.**
Without `--export`, cleanup removes the ledger. Export errors are reported; teardown still proceeds. A missing
ledger cannot become a success-looking empty export on retry.

At final worker settlement, a missing `p2o_report` produces a blocked report without a new model request.
Automatic continuations are allowed to finish first. If the broker is lost or the process is killed, the lead
must explicitly withdraw it using `p2o_stop_worker`; idle/unknown Herdr states never prove completion. Benchmark
runs have an additional deadline and mark provider/transport failures separately from security negatives.

See the opt-in runner in `bench/README.md` for real-provider evaluation. Unit tests do not establish assessment
quality or platform independence; this implementation requires a Linux host for FD-relative containment.
