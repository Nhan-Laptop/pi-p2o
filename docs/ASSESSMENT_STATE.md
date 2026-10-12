# Focused assessment state

The Planner works from bounded **questions** and attributed **reviews**, not from chat memory. Only the human
confirmation and the live owner establish authority; disk state, summaries and worker text cannot restore it.

## Question → observation → review

- `p2o_task` (owner only) creates a bounded question: surface, risk, role, contrasting predictions, evidence IDs,
  prerequisite revisions, method and stop condition. Missing prerequisites create a **blocked** task.
- Actions: `create`, `revise` (needs current `revision`), `list`, `start` (solo), `dispatch`, `review`, `close`,
  `block`, `cancel`, plus `match` ([work admission](WORK_ADMISSION.md)). Use `list {id}` for one task in full.
- A running worker packet must be reported first. Review is an attributed decision, **not proof**; closing a task and
  closing a candidate are separate. A validation task names `validationOf` and the reviewed predecessor revision.
- Dispatch pins accepted support; revised support makes dependents stale. Surface/risk keys cannot overlap between
  ordinary tasks (explicit validation may overlap), but aliases still need Planner judgment.
- Workers propose via `p2o_request_subtask`; they cannot create, review or dispatch tasks.
- Skill IDs and workflow membership are validated; hashes identify package documents, not tool availability or proof.

## Reading state in bounded pieces

- Ledger scans cover the run's own file: ≤64 MiB, 100,000 records, 16 KiB/row. Damage, duplicates and broken chains
  produce explicit incompleteness; mutations never fall back to a display tail.
- `p2o_ledger {cursor:0}` starts a complete traversal (follow `nextCursor`, ≤100 rows/48 KiB per page); `id` returns one
  full record. `total`/`complete`/`truncated` distinguish state from presentation.
- `p2o_workers {cursor}` returns a change page with exact coverage/open totals. Quiet work can be *suspected* stalled,
  never proven failed by a clock.
- Worker budgets: 200 knowledge/coordination calls (knowledge stops at 160, 40 reserved for notes/candidates/report).
  Command counters are separate and are not a spend ceiling. Provider/model/thinking are compared locally against the
  request; a known mismatch blocks investigation; no provider fallback.
- A request-local objective capsule refreshes the current question after context rebuild; it is data, not policy.

## Reports and retention

- Independent support must match the validator's **latest** conclusion and receipt; withdrawal invalidates it.
- Full worker reports are redacted field-wise (≤128 KiB), stored as hashed parts and committed by a manifest; missing
  or corrupt parts are explicit, failed persistence is never acknowledged.
- After in-flight work stops, finalization freezes a bounded projection. `--export` keeps the full valid ledger in
  `.p2o-reports/` (0700/0600, ≤16 MiB, best-effort redaction: review before sharing); without it, temporary records are deleted.

Inert tests establish these mechanics, not security effectiveness, deduplication, prompt-injection immunity or cost.
