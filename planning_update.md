# A1 update — tool-call argument failures: measured, folded, and traced

Status: **A1 landed in `00092d4` ("Cut tool-call refusals and repeated prompt facts (A1)"); the whole-surface audit pass
A1.2 described in §1.6 and §4.7 is implemented in the working tree on top of it (uncommitted), verification green.** This
file replaces the P18 text; that text is unchanged in git at `git show 18d1d84:planning_update.md`, and the P18 loop
implementation itself landed in `18d1d84`. Like P17/P18, this document is the plan of record and does not reopen prior
decisions D32–D48.

The two passes change **input boundaries** only: what the tool schemas accept, what the host folds, defaults or truncates
before storing, and what a refusal says. A worker still holds the same authority after a corrected call that it held
before it.

---

## 0. Owner request and scope

Owner request (2026-10-28, verbatim):

> "make a deeply comprehensive inspect - fix that in the tools - helper registered usually errors whenever agents use-
> call it (you can take a look at pi-session-…html to see one of the errors), I wanna you analyze why and after that help
> me patch. My opinion is maybe base on the guide tools are not clear. You should inpect the logic of each tool if you
> modify something belong to them, absolutely you should take a ref for the revalent case study, ARTEX, STRIX AI, or
> internet. ok let's do it."

Scope, as agreed in chat:

1. Measure the real failures from the existing Pi session JSONL corpus, not from opinion.
2. Diagnose each mechanical failure class to its root cause (schema boundary, guide text, host validation, storage cap).
3. Patch the mechanical classes, referencing ARTEX/Strix/industry practice for the design.
4. Leave policy/semantic refusals alone unless the evidence says the gate is misfiring.
5. No commit, no push, no AI attribution; the diff stays owner-reviewed (AGENTS.md).

Owner follow-up decisions (2026-10-28, chat):

- Accept-and-normalize for `p2o_graph record`; keep Pi strict where the field is identity.
- Prose caps: option **A1** (raise the declared bound, clamp at the stored bound, return a `truncated:` warning) for
  `p2o_candidate`, `p2o_report`, `p2o_note`, `p2o_finish`, `p2o_surface`.
- Keep Pi strict for the two residual graph shapes (asset missing `kind`/`key`; row not an object).
- No `head`→`heads` alias; no upstream Pi patch in this pass.
- Follow-up (2026-10-28, chat): **commit A1 first, then extend the audit to the whole model tool surface** — all 32 names
  in `MODEL_TOOLS`, not only the classes listed in §8. That scope is §1.6/§4.7/§8; it changed no tool beyond the
  admission defaults and guide text recorded there.

The earlier A1 sub-pass (truth-fact dedupe on execution tool descriptions, English start dialog) is part of the committed
`00092d4` batch and is not re-described here.

---

## 1. Evidence (measured, not asserted)

### 1.1 Corpus

Source: `~/.pi/agent/sessions/--home-nhanlaptop-tmp-cmp--/*.jsonl` (Pi session JSONL, one `toolResult` event per call).

| Metric | Value |
| --- | --- |
| Session files | 240 |
| Tool calls | 9,223 |
| Failing tool results | 1,207 |
| Total error text | 883,440 bytes (863 KiB) |
| Of which Pi argument-validator echoes (`Validation failed … Received arguments: <whole payload>`) | 803 KiB |
| Sessions on the current model surface (≥ 2026-10-28) | 11 |
| Sessions without a retired verb (the comparable surface audited in §1.6) | 210 (30 of the 240 still call a retired verb) |

The echo is the dominant cost: one rejected `p2o_report` call cost ~9 KiB of context, and a rejected graph batch
~7 KiB, all of it a copy of what the model just sent.

### 1.2 Failure volume by tool (all sessions, bytes of error text)

| Tool | Fails | Error bytes | Note |
| --- | --- | --- | --- |
| `p2o_candidate` | 298 | 239 KiB | 66 are argument-schema refusals, dominated by prose caps |
| `p2o_graph` | 104 | 216 KiB | 29 argument-schema + 37 secret guard + semantic |
| `p2o_report` | 14 | 124 KiB | 12 argument-schema; huge payload echo |
| `p2o_task_create` | 115 | 65 KiB | retired verb (pre-Oct-27 surface) |
| `p2o_note` | 33 | 55 KiB | text cap and missing `text` |
| `p2o_task` / `p2o_coverage` / `p2o_case` / `p2o_plan_*` | 212 / 119 / 45 / 77 | 52 / 29 / 17 / 29 KiB | retired verbs |
| `p2o_surface` | 5 | 6 KiB | component/entryPoint caps |
| `p2o_finish` | 6 | 13 KiB | `partial` cap |
| `p2o_state` | 7 | 0.7 KiB | **6 host-shape errors** + 1 action typo |

Recent 11 sessions (current surface): `p2o_graph` 15 fails / 85.8 KiB (12 schema + 3 secret), `p2o_task_author` 6,
`p2o_plan_author` 4, `p2o_report` 2, `p2o_net` 1. No other tool had a mechanical failure in this window.

### 1.3 Reference session (the HTML the owner pointed at)

`pi-session-2026-10-28T08-16-05-239Z_…html`: 5 `p2o_graph` calls, **4 refused**.

| Call | Refusal | First pointer |
| --- | --- | --- |
| record batch | `evidenceRefs` on the asset row + `asset.unknown` | `/batch/assets/12/evidenceRefs: schema is false` |
| record batch | `requestId` inside `batch` | `/batch/requestId: schema is false` |
| record batch | `requestId` inside `batch` | same |
| record batch | cookie **name** refused as secret | `Asset key contains secret-bearing identity text` |

The remaining call failed semantically ("Workers record assets, facts and anchors; hypotheses and relations are owner
review work") and one `p2o_graph` call never reached the host ("owner broker connection closed"). Neither is a
tool-shape defect.

### 1.4 `p2o_graph` schema refusal decomposition (29 refusals, 210 KiB)

| Class | Count | Example pointer |
| --- | --- | --- |
| Row-level asset fields (`evidenceRefs`, `anchors`, `key/kind/label`) | 32 | `/batch/assets/N must not have additional properties` |
| `evidenceRefs` specifically on the row | 27 | `/batch/assets/N/evidenceRefs` |
| `requestId` placed inside `batch` | 6 | `/batch/requestId: schema is false` |
| Batch non-object / row non-object | 4 | `/batch: must be object`, `/batch/assets/N: must be object` |
| Unknown field inside the nested asset | 1 | `/batch/assets/12/asset/unknown` |
| Unknown field on a fact row (`confidence_note`) | 1 | `/batch/facts/2/confidence_note` |
| Relation endpoint typo | 3 | `/batch/relations/N/toId` |
| Invalid anchor kind | 1 | `must be equal to one of the allowed values` |
| `supersedes: ""` failing `minLength: 1` | 1 | `/batch/facts/0/supersedes` |
| Batch sent as a stringified JSON | 1 | `/batch: must be object` |

### 1.5 Prose-cap refusals (argument-schema counts)

| Tool.field | Over cap | Detail |
| --- | --- | --- |
| `p2o_candidate.risk` | 21 | cap 200 |
| `p2o_candidate.negativeControls` | 14 | missing the required array; A1.2 records `[]` (§4.7) |
| `p2o_candidate.limitations` | 11 | cap 1500 |
| `p2o_candidate.control` | 10 | cap 1000 |
| `p2o_candidate.gained[].subject` | 9 | cap 80 (**identity — kept strict**) |
| `p2o_candidate.needs[].subject` | 5 | cap 80 (**identity — kept strict**) |
| `p2o_candidate.note` | 4 | cap 300 |
| `p2o_candidate.surface` | 2 | cap 200 |
| `p2o_report.findings[]` | 3 | cap 1000 |
| `p2o_report.evidence[]` | 3 | cap 500 |
| `p2o_report.coverage[].surface` | 2 | cap 200 |
| `p2o_report.summary` | 1 | cap 4000 |
| `p2o_report.confidence` | 3 | missing required field; A1.2 records `low` (§4.7) |
| `p2o_note.text` | 14 | cap 2000 |
| `p2o_note.text` | 12 | missing required field (**content — kept strict**) |
| `p2o_note.risk` / `.surface` | 7 / 3 | caps 200 |
| `p2o_surface.entryPoint` / `.component` / `.text` | 4 / 1 / 1 | caps 200 / 200 / 1000 |
| `p2o_finish.partial` | 2 | cap 600 |

`p2o_state` had 6 real host-side shape errors across 5 different session days: the tool accepted `domain`/`status` in the
schema, forwarded them to the owner's search RPC, and `readKnowledge` then refused the unknown fields
("Knowledge search has an invalid shape or unknown fields"). One more case was a plain `action: "head"` typo.

### 1.6 Whole-surface audit (A1.2)

A1 fixed the classes its own evidence table named; it did not re-scan the rest of the surface. A1.2 re-ran the
classification over the 210 sessions that used only current tool names (30 older sessions still call a retired verb and are
excluded, so the denominator matches today's loadout).

| Metric | Value |
| --- | --- |
| Tool results | 6,482 |
| Failing tool results | 497 |
| Pi argument-validator refusals | 147 (626 KiB of echoed payload) |
| Host (non-Pi) refusals | 350 |

Every Pi refusal was classified against the current schemas (a class counts refusals, not sessions):

| Class | Refusals | Status |
| --- | --- | --- |
| Prose cap (candidate/note/surface/report/finish; boxed `command`/`length`/`refs`) | 71 | fixed in `00092d4` (§4.5) |
| Graph placement drift (`batch.requestId`, row-level asset fields, `supersedes:""`, unknown nested keys) | 24 | fixed in `00092d4` (§4.1) |
| Removed pre-P14 `provides` field | 1 | fixed in `00092d4` (the host names `gained`/`needs`) |
| Omission with one conservative reading (`negativeControls`, `closure`, `confidence`, `kind`, `expectedPolicy`) | 21 | fixed by A1.2 (§4.7) |
| Kept strict: required content and identity (`note.text`, capability `subject`/`scope`, graph row identity, `execution`/`policyBasis`, enum values, element types) | 30 | by design (D-A1-3, D-A1-10) |

The 350 host refusals are dominated by policy/business gates the descriptions already state: candidate semantics 225
(inferred-policy hypothesis 59, independence 61, `ruled_out` control 23, revision identity 16, runtime proof 9, unknown IDs
24, …), graph semantics 67 (37 are the old secret-wording cases already fixed by §4.2), HTTP 21 (14 DNS `EAI_AGAIN`, 5
old origin-scope refusals removed by Part XI, 2 executor transport), state 6 (old wording, fixed in `00092d4`), task/plan
author policy 10, shell/net/capture 13 (stale revisions, sandbox/executor limits), research 4 (old 6-term limit removed),
skill_read 2, report broker-closed 2. None of those is a schema/guide mismatch left unfixed; A1.2 only tightened the
message or description where the corpus showed the model repeatedly could not guess the rule (§4.7).

After A1.2 the residual Pi-refusal surface is the 30 kept-strict cases: identity, required content or enums whose silent
truncation/default would change what the record means (D-A1-3). Removing them would require changing the record's meaning,
which is not an input-boundary change.

---

## 2. Root causes

1. **The Pi schema was stricter than the stored shape, and the guide described no shape.** `registerTool` validates
   arguments with TypeBox/AJV before the handler runs, then throws with every pointer **plus the full received payload**.
   `p2o_graph` declared `additionalProperties: false` through the whole batch subtree while its description said only
   "record an atomic batch": a model that put `requestId` in the batch, or `evidenceRefs` on an asset row, lost the whole
   call and got its payload echoed. The guide, not the model's intent, was the missing piece (ARTEX/Strix documents cite
   an example shape in the tool description, not only a JSON schema).
2. **Security detection was implemented as a redaction side-effect.** The old identity check refused anything that
   `redact()` changed. `redact()` rewrites `cookie:`/`set-cookie:` text, so a legitimate cookie **name**
   (`cookie:hcmussh-visit-id`) and a quoted placeholder (`Set-Cookie: MoodleSession=<id>`) read as secrets. That is the
   wrong direction: the name and the attributes are evidence, only a concrete value is a secret.
3. **A tool accepted fields its RPC did not.** `p2o_state` exposed one parameter object for two actions; `domain`/
   `status` are valid for `heads` and invalid for `search`, but the schema could not say so, and the handler forwarded
   them anyway. The host error named neither the action nor the fix.
4. **Prose caps were enforced at the validator instead of at the writer.** A `risk` label of 201 characters, a long
   `limitations` paragraph or a `report.summary` over 4000 characters were refused before any host code saw them, even
   though every consumer only reads them. The model then paid for the echo and re-sent a shorter version.

Cause 1 mirrors the bug the repo already fixed for task drafts (P2 in `src/tasks.ts`: declared 2000, stored 200, warning
trace). Causes 2–4 are the same "boundary is in the wrong layer" error in three different places.

---

## 3. Prior art and design decision

| Source | Design borrowed |
| --- | --- |
| **ARTEX** (`my_references/ARTEX`, module `github.com/Autumn-27/artex`) | Tool handlers take `json.RawMessage` and decode leniently; unknown keys are not rejected with `DisallowUnknownFields`; a tool failure is a **tool result** (`actool.Errorf`) with advice, not a harness-level refusal. `agent/assembly.go:79` guards every tool call that way. |
| **Strix** (`my_references/strix`, https://github.com/usestrix/strix) | Flat function-signature parameters, long docstrings with `Args:` and examples, and structured `{"success": false, "error": "…"}` returns instead of exceptions (`notes/tools.py:345`). |
| **Stripe** (https://docs.stripe.com/api/idempotent_requests) | The idempotency key belongs on the request envelope, not inside the business payload. `batch.requestId` is the same mistake; we hoist it instead of refusing it. |
| **Anthropic** (https://www.anthropic.com/engineering/writing-tools-for-agents) | Tool descriptions need an exact example shape and honest limits; a refusal should tell the model what to do next. |
| **OpenAI function calling** (https://platform.openai.com/docs/guides/function-calling) | Strict mode is only useful when every emitted shape can be made strict; otherwise prioritize instructions + examples. |
| **MCP tools spec** (https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | Errors are part of the protocol; the model can only act on them if the text is actionable. |

Options considered for the graph record, with trade-offs:

| Option | What it does | Trade-off | Decision |
| --- | --- | --- | --- |
| **A. Accept-and-normalize + example** | Relax the nested schema, fold the drifted placement in one host normalizer, keep all semantic/security checks host-side, add one shape sentence to the description | Some wrong shapes now travel to the host; host validation must stay complete (it does: `validateGraphBatch`/`graphObject` run before mutation) | **chosen** |
| B. Relax only, no folding | Schema tolerates unknown keys; host rejects them with a good message | Saves the echo but still refuses a correct-in-spirit call | partially in A |
| C. Guide only | Better description, no code change | Cheapest, but the same two placements accounted for 38 of 29 refusals; a guide alone is not enough | no |
| D. Patch Pi's validator | Truncate the echoed payload in Pi | Fixes 803 KiB for every extension, but it is outside this repo and needs an upstream decision | no (owner deferred) |

For prose caps the owner chose **A1** over "raise the declared cap only" (still echoes on a truly long value) and
"reject host-side with a one-line error" (keeps strictness but refuses text every consumer could truncate).

---

## 4. What changed

Line references are the working tree of 2026-10-28; A1 is committed at `00092d4`, A1.2 (§4.7) is uncommitted.
Every item has a test.

### 4.1 `p2o_graph record` — tolerant schema, one host fold

- `src/state/graph-tool.ts`
  - The batch subtrees (asset row, nested asset, fact/hypothesis/relation rows, anchor, anchor list) no longer declare
    `additionalProperties: false`; the **root** parameter object stays closed (`action/batch/id/requestId/cursor/…`).
    A misplaced field now reaches the host instead of dying in Pi; a wrong type still fails the schema.
  - `supersedes` accepts `""` (the model's way of saying "no predecessor"); `asset` on a row is optional so a flat row
    is accepted.
  - `normalizeGraphRecord(batchInput, requestIdInput)` (line 116) is the one fold, called once per call before either role
    path:
    - hoists `batch.requestId` to the envelope (conflicting top-level + batch keys are refused; Stripe rule);
    - folds row-level `evidenceRefs`/`anchors`/`key`/`kind`/`label`/`attributes`/`expectedRevision` into `asset`,
      merging `evidenceRefs` and refusing a contradictory duplicate;
    - turns a flat row (`{kind,key,…}` with no `asset`) into `{asset:{…}}`;
    - drops `supersedes: ""`;
    - refuses an unknown batch/row field with **one line naming the fields that are allowed** (the ARTEX corrective
      error), never a payload echo.
  - `validateAsset`/`graphObject`/`validateGraphBatch` are unchanged in strength: unknown or producer-owned fields still
    fail before any state mutation, now with a one-line message.
- `extensions/p2o/index.ts` (line 3009): the record branch normalizes once and uses the same normalized batch/requestId for
  the worker broker path and the owner store path, so idempotent replay hashes the same canonical payload either way.
- Description (line 2986) gains one sentence: `Record: requestId is a sibling of batch (a batch.requestId is hoisted); an
  assets[] row is {asset:{kind,key,...},ref?} or the same asset fields directly on the row.` (+175 chars; the planner
  declaration budget test still passes).

### 4.2 Secret detection by credential shape, not by redaction side-effect

`src/state/graph.ts` (`identityText`, line 114; `secretMaterial`, line 104) now checks the **shape** of a value:

- refused: a concrete value after `Authorization`/`Proxy-Authorization` (with or without `Bearer`/`Basic`/`Digest`), a
  Cookie/`Set-Cookie` pair whose value is concrete, `api_key`/`access_token`/`refresh_token`/`password`/`secret`/`token`
  assignments, standalone `Bearer <token>`, URL userinfo, a sensitive query value, `sk-`/`ghp_`/`github_pat_`/PEM keys.
- accepted (they are evidence, not the secret): cookie **names** (`cookie:hcmussh-visit-id`), cookie attributes
  (`Path`, `Max-Age`, `Secure`, `HttpOnly`, `SameSite`), and a placeholder in the value position (`<uuid4>`, `<id>`,
  `[REDACTED]`, `$TOKEN`, `%s`, `xxx`, `*`, `…`, `redacted`, `none`, `null`, `n/a`).
- the refusal message says what to send instead: "contains a secret-bearing value; replace it with a placeholder (for
  example <uuid>) or use a non-secret operator label".
- Detection stays best effort and is documented as such (identities only; `safeText`/attribute redaction is a separate,
  unchanged path).

### 4.3 Host shape messages

`src/state/graph.ts` (`graphObject`, line 57) now names the offending keys and the allowed ones and keeps the
`producer/scope/authority are host-owned` clause pinned by the tests. This is what replaces the old
"invalid shape or unknown fields" with something a model can act on in one turn.

### 4.4 `p2o_state` action-field guidance

`extensions/p2o/index.ts` lines 2396–2397 reject the cross-action fields **before** the RPC:

- `action=search` + `domain`/`status` → "action=search takes q, cursor and limit only; domain/status filter
  action=heads…";
- `action=heads` + `q` → "action=heads takes domain, status, cursor and limit only; q is a substring search…".

The owner RPC (`readKnowledge`) is unchanged and still validates strictly; the model no longer reaches it with a shape
it cannot accept.

### 4.5 Cosmetic prose caps (A1)

Stored bound and declared (Pi) bound per field; declared = at least 4× stored, never below 2000 characters:

| Tool.field | Stored | Declared | Where stored |
| --- | --- | --- | --- |
| `p2o_candidate.surface` / `.risk` | 200 | 2000 | `EvidenceStore.candidate` |
| `p2o_candidate.limitations` | 1500 | 6000 | same |
| `p2o_candidate.control` | 1000 | 4000 | same |
| `p2o_candidate.note` | 300 | 2000 | same |
| `p2o_note.text` | 2000 | 8000 | tool boundary (owner path) |
| `p2o_note.surface` / `.risk` | 200 | 2000 | tool boundary |
| `p2o_surface.component` / `.entryPoint` | 200 | 2000 | tool boundary |
| `p2o_surface.text` | 1000 | 4000 | tool boundary |
| `p2o_report.summary` | 4000 | 16000 | `normalizeReport` |
| `p2o_report.findings[]` | 1000 | 4000 | same |
| `p2o_report.evidence[]` | 500 | 2000 | same |
| `p2o_report.coverage[].surface` / `.risk` | 200 | 2000 | same |
| `p2o_report.openItems[]` | 1000 | 4000 | same |
| `p2o_report.blocked` | 1000 | 4000 | same |
| `p2o_finish.partial` | 600 | 2400 | finish handler |
| `p2o_candidate.expectedPolicy` (A1.2) | 1000 | 4000 | `EvidenceStore.candidate` |

Mechanics:

- `src/validate.ts` (`PROSE_CAPS`, line 26; `clampProseInPlace`, line 34) is the one clamp helper. It truncates only a
  **length overflow** of a non-empty string; control characters, wrong types and empty values keep the hard refusal.
  Each cut returns `truncated:<field> (stored N of M characters)`.
- `src/evidence.ts` (line 90) clamps the candidate before `validateCandidate` and records the trace as
  `data.admissionWarnings` on the stored claim; the `p2o_candidate` result prints `Admission warnings: …`.
- `src/broker.ts` (`REPORT_PROSE_CAPS`, line 177; `reportProseWarnings`, line 180) is the single source of the report's
  stored bounds; `normalizeReport` uses those constants, and the worker tool reports every cut before sending.
  `p2o_note`, `p2o_surface` and `p2o_finish` clamp at the tool boundary and append the same warning line; the broker's
  `text()` helper still clamps defensively on the RPC path.
- Identity-shaped caps are **not** clamped: the candidate slug pattern, evidence/ref/lead/payload IDs (80), capability
  `subject`/`scope` (80/40), list sizes, and every enum still fail the schema as before. Truncating them would silently
  change what a record means.
- No storage migration: the ledger row bound (16 KiB) and the report/record shapes are unchanged; only a new-write value
  may be shorter than the caller sent, and the caller is told.

### 4.6 Tests added

| Test file | What it pins |
| --- | --- |
| `tests/minimal/graph-record-shape.test.ts` (new, 5 tests) | Drifted placements pass `Value.Check(graphParameters, …)`; `normalizeGraphRecord` folds them into a batch `validateGraphBatch` accepts; conflicting/unknown rows are refused with the allowed-field line; an unknown asset field still fails host-side |
| `tests/minimal/graph.test.ts:204` | Cookie names, `Set-Cookie` attributes and quoted placeholders are accepted as identities; concrete cookie/Authorization values are still refused; the secret-shaped prose ("a random bearer token") stays accepted |
| `tests/minimal/workspace-runtime.test.ts:123` | `p2o_state` search+domain/status and heads+q are refused with the action guidance; a plain search still works |
| `tests/minimal/workspace-runtime.test.ts:134` | Over-long note/surface prose is stored truncated and the tool result carries the warning; a note with no kind records `note` (A1.2) |
| `tests/minimal/prose-caps.test.ts` (new, 5 tests) | Declared caps ≥ max(4× stored, 2000); clamp leaves control/empty text for the hard refusal; Pi accepts over-long prose and still refuses identity overflow; candidate stores clamped values plus `admissionWarnings`, including the A1.2 `expectedPolicy` cut; every report cut is named and the stored report is bounded |
| `tests/minimal/tool-admission-defaults.test.ts` (new, 5 tests) | A1.2: a candidate with no `negativeControls`/`closure`, a report with no `confidence` and a note with no `kind` pass `Value.Check`; the store records `[]` and `open_proof_gap`; `normalizeReport` yields `low`; contradicting values and unknown kinds still fail; the graph identity message names the accepted `asset-<24 hex>` shape |

The prior graph pin at `tests/minimal/graph.test.ts:29` was updated for the deliberate change: the root stays closed,
the `batch` object no longer declares `additionalProperties: false` because `normalizeGraphRecord` folds the drift.

### 4.7 Whole-surface audit pass (A1.2): conservative defaults and guide text

The audit in §1.6 left 21 Pi refusals in one shape class: a field was required although its omission has exactly one
conservative reading. Pi refused the whole call (and echoed it) before the host could apply that reading. A1.2 moves the
decision to the host and records the value, so the stored record shape does not change:

| Field | Omitted means | Where the default is applied |
| --- | --- | --- |
| `p2o_candidate.negativeControls` | no negative control ran → `[]` | `EvidenceStore.candidate`, before `validateCandidate` |
| `p2o_candidate.closure` | the claim establishes nothing → `open_proof_gap` | same |
| `p2o_report.confidence` | the least confident honest reading → `low` (`normalizeReport` already did this) | `p2o_report` handler and `normalizeReport` |
| `p2o_note.kind` | the tool's namesake → `note` | `p2o_note` handler |

`p2o_candidate.expectedPolicy` (a prose argument; 1 refusal over 1000 characters) joins the A1 prose-cap table: declared
4000, stored 1000, `truncated:expectedPolicy` warning by the same §4.5 mechanics, and a hard refusal only for a value the
clamp had to skip (control text). Its stored 1000-character bound is unchanged.

A contradicting value still fails: `closure:"closed-ish"`, `negativeControls:"none"`, `confidence:"certain"`,
`kind:"guess"` and an unknown enum remain schema errors. Required content and identity stay strict (D-A1-3): a note with no
`text`, a candidate with no `execution`/`policyBasis`, a capability `subject` over 80 characters, and a graph relation with
no `toId` are still refused.

Guide text was added only where the corpus showed the model could not guess a host rule (same 210-session corpus):

- `p2o_candidate` description and `independentEvidenceRef` field: independence needs a receipt **another worker** authored
  and that worker's own demonstrated claim; citing your own receipt is not independence (61 host refusals).
- `p2o_candidate.supersedes` field: a revision takes the latest record ID and cannot change surface/risk (16 refusals).
- `p2o_candidate.control` field: required when `closure=ruled_out`, with the observation and where it ran (23 refusals).
- `p2o_graph` identity message: names the accepted `asset-<24 hex>` shape and where to copy an `entityId` from; `view`
  without an id says the same (13 refusals).
- `p2o_candidate` `payloadRef`/`environmentRef` refusals name `payload-<uuid>`/`env-<uuid>` and the `p2o_lab` action.

The declaration budget stays inside its pinned ceilings (`tests/minimal/context-budget.test.ts`): planner 48,245
(unchanged; the planner holds none of the changed tools), worker 41,120, validation 40,312, reporter 6,786, model 74,451
characters against 49,300 / 44,100 / 43,300 / 6,800 / 77,900. The reporter has the least room (14 characters) because it
holds exactly `p2o_report`; the next addition there needs a matching cut.

---

## 5. Decisions recorded

| ID | Decision |
| --- | --- |
| **D-A1-1** | `p2o_graph record` uses accept-and-normalize with one host fold; the root parameter object stays closed; security/semantic validation stays host-side before mutation. |
| **D-A1-2** | Prose caps use option A1 (declared bound high, stored bound clamped, `truncated:` warning) for `p2o_candidate`, `p2o_report`, `p2o_note`, `p2o_finish`, `p2o_surface`. |
| **D-A1-3** | Identity-shaped fields keep strict caps: candidate slug, IDs, capability subject/scope, list sizes, enums. No silent truncation of identity. |
| **D-A1-4** | The two residual graph shapes (asset missing `kind`/`key`, row not an object) stay Pi-strict: they are identity/shape errors, not placement drift. |
| **D-A1-5** | No `action:"head"` alias; the enum stays explicit. |
| **D-A1-6** | The upstream Pi validator echo (803 KiB) is not patched from this repo; it remains a candidate for a separate upstream change. |
| **D-A1-7** | Secret detection is by credential shape (cookie name/placeholder allowed, concrete value refused) and remains best effort; the message names the placeholder form. |
| **D-A1-8** | The A1 batch was committed on the owner's explicit request as `00092d4`; nothing was pushed, and the A1.2 batch below stays uncommitted until the owner asks. |
| **D-A1-9** | A1.2: an omitted field whose only conservative reading exists (`negativeControls`→`[]`, `closure`→`open_proof_gap`, `confidence`→`low`, `kind`→`note`) is admitted by the schema and defaulted **on the record** by the host; a contradicting value is still a schema error. |
| **D-A1-10** | A1.2: required content and identity stay Pi-strict (`note.text`, `execution`, `policyBasis`, capability `subject`/`scope`, graph row identity, enums). These 30 residual refusals are accepted as by-design; removing them would change what a record means. |
| **D-A1-11** | A1.2: guide text is added only to a field whose host rule the corpus shows the model cannot guess (independence, revision identity, `ruled_out` control, graph entity id, payload/environment ids); no prompt rule was duplicated into a description. |
| **D-A1-12** | A1.2: the declared prose rule applies to `p2o_candidate.expectedPolicy` too (declared 4000, stored 1000); its stored bound and the record shape are unchanged. |

---

## 6. Verification

Working tree, 2026-10-28. All commands from the project root. A1 is committed at `00092d4`; the A1.2 numbers below are
the working tree on top of it.

| Gate | Result |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | clean |
| `./node_modules/.bin/vitest run` (full) | **136 files passed / 5 skipped (141), 1,203 tests passed / 13 skipped** |
| Focused suites (`graph`, `graph-record-shape`, `prose-caps`, `tool-admission-defaults`, `workspace-runtime`, `truth`, `context-budget`, `workflow-policy`) | green; the declaration-budget test still passes after the A1.2 description/schema changes (see the budget numbers in §4.7) |
| `npm run build` + `npm run check:build` | `build import OK` |
| `git diff --check -- src extensions tests docs` | clean; the only whitespace report on the whole tree is the owner's uncommitted `AGENTS.md` edit, which this pass does not touch |
| GitNexus `detect_changes --scope all` | 8 files, 24 changed symbols, 23 affected processes, risk `critical`; no `partial`/`truncated`. The index is one commit behind HEAD (`analyze --index-only` could not write its registry under the sandbox: EROFS on `~/.gitnexus/registry.json`), so the change map is the working-tree diff, not a fresh graph; the touched hubs are `validateCandidate` (LOW, 1 caller) and `graphEntityId` (HIGH, 5 impacted: store, extension graph handler, UI), and both edits are message/default-only with call sites unchanged |
| Python gates (`npm run check:python`) | 159 tests run: 157 pass, 1 skipped, 1 pre-existing failure — `test_provenance_record_matches_review_snapshot` compares a hash for `my_references/strix`, which is gitignored local reference data (`git check-ignore` confirms) and differs from `research/SKILL_PROVENANCE.json`. Same failure before both passes; not caused by them. |
| Commit | A1: `00092d4` (owner-requested). A1.2: none yet; the working tree is the review artifact. |

What the tests prove: mechanism (real extension/store/broker paths with inert executors; real Pi RPC for the native graph
test), not penetration effectiveness. No paid provider call was made by this pass.

---

## 7. Limits and what this does not change

- **Echo reduction, not elimination.** The Pi echo is emitted by Pi's validator for *any* remaining schema refusal. A1 + A1.2
  remove the 96 + 21 refusals classified as mechanical in §1.6; the 30 kept-strict refusals (a missing `note.text`, a
  capability `subject` over 80 characters, a graph row without identity, a batch sent as a string, …) still echo. It does
  not change Pi itself (D-A1-6).
- **Defaults are conservative and visible on the record.** `[]`, `open_proof_gap`, `low` and `note` are written to the
  stored record, so a reader never sees an absent field that silently means something; no default ever widens authority.
- **Guide text is not a second prompt.** A1.2 added field-level sentences only for a host rule the corpus showed the model
  could not guess (independence, revision identity, `ruled_out` control, graph id shape, payload/environment ids), and no
  description repeats a prompt rule (D-A1-11).
- **Tolerance is bounded to placement.** No new accepted field carries meaning: `normalizeGraphRecord` only moves,
  merges or drops placement noise, and every field it emits is validated by the unchanged host validators. Producer,
  scope and authority remain host-owned.
- **Clamping is silent except for the warning.** A stored note/report/candidate body may be shorter than what the caller
  sent; the tool result says exactly which field was cut and to what length. Replay/idempotency is unaffected because the
  stored value is deterministic once clamped.
- **Secret detection stays heuristic.** It refuses shape-recognisable credentials; a secret that does not look like one
  can still be stored. This is unchanged in direction, narrower in false positives.
- **No authority change.** No tool, role, skill, effect class, finish gate or retention rule moved. `p2o_state` still
  cannot filter `search` by domain; it now says so.
- **No new settings.** Bounds are constants, matching the P9 "raise the constants, no settings" decision.

---

## 8. Remaining work (not started; candidates only)

1. **Pi upstream echo (626 KiB in 147 refusals, current-tooling corpus).** Options: truncate `Received arguments` in Pi's
   validator message, or return a compact per-pointer error only. Needs an upstream decision and a Pi dependency bump;
   owner deferred (D-A1-6).
2. **The 30 kept-strict refusals (D-A1-10).** `note.text` missing 12, capability `subject`/`scope` over cap 9, graph row
   identity 4, candidate `execution`/`policyBasis` 2, `negativeControls` element type 1, `p2o_state` action enum 1,
   `p2o_report.evidence` element type 1. If one of these ever becomes the dominant class, the fix is prompt wording that
   tells the model the field before the call, never silent truncation of identity.
3. **Semantic host refusals (350).** They are business gates, not shape errors. A1.2 added guide text to the three
   largest clusters the model kept hitting (independence 61, `ruled_out` control 23, revision identity 16); re-measure on
   the next corpus before adding more text, and prefer one field sentence over a long description.
4. **Old origin-scope HTTP refusals (5).** They come from pre-Part-XI records (`Out of scope: only <url> is allowed`);
   current `src` has no allowlist (grep-verified) and `research`/`http` are target-label tools. Re-measure after a fresh
   session before treating this as a live class.
5. **Effect measurement.** No benchmark run was made: the pass proves error classes and mechanisms, not token savings.
   A follow-up could measure Pi-echo bytes per 100 calls before/after on the same fixture suite (live runs spend provider
   tokens and were not authorized).
6. **Unknown-field folding for `data`/`other` on asset rows.** The message tells the model to use `asset.attributes`;
   folding them automatically would be a semantic guess (they may be real fields), so it stays a corrective refusal.
7. **Single-constant enum `p2o_secret action:"list"`.** No corpus refusal, so it was left strict rather than adding a
   speculative default; revisit only with evidence.
8. **Retired-verb sessions (30 files).** Excluded from every current-surface number above; re-measure only if those verbs
   return to the model surface.

---

## 9. Files touched

A1 (committed in `00092d4`):

| File | Change |
| --- | --- |
| `src/state/graph-tool.ts` | Tolerant batch subtrees, `supersedes:""`, optional row `asset`, `normalizeGraphRecord` + helpers |
| `src/state/graph.ts` | Shape-based `identityText`/`secretMaterial`; allowed-field `graphObject` message |
| `src/tool-schemas.ts` | Declared prose bounds raised (A1); one comment explaining the declared-vs-stored rule |
| `src/validate.ts` | `PROSE_CAPS` + `clampProseInPlace` (shared clamp) |
| `src/evidence.ts` | Candidate prose clamp before validation; `admissionWarnings` on the stored claim |
| `src/broker.ts` | `REPORT_PROSE_CAPS` used by `normalizeReport`; `reportProseWarnings` |
| `extensions/p2o/index.ts` | Record normalization + shape sentence; state action-field guidance; candidate/note/surface/report/finish warning wiring |
| `tests/minimal/graph.test.ts` | Graph pin updated; cookie/placeholder/secret-value acceptance cases |
| `tests/minimal/graph-record-shape.test.ts` (new) | Schema tolerance + fold + actionable refusals + host still strict |
| `tests/minimal/prose-caps.test.ts` (new) | Declared-vs-stored bounds, clamp semantics, candidate storage, report cuts |
| `tests/minimal/workspace-runtime.test.ts` | `p2o_state` guidance; note/surface truncation-with-warning runtime test |

A1.2 (working tree on top of `00092d4`):

| File | Change |
| --- | --- |
| `src/tool-schemas.ts` | `candidate.negativeControls`/`closure` and `report.confidence`/`note.kind` optional with conservative descriptions; `expectedPolicy` declared 4000; `independentEvidenceRef`/`supersedes`/`control` field sentences |
| `src/validate.ts` | `PROSE_CAPS.candidate.expectedPolicy` (stored 1000) |
| `src/evidence.ts` | Candidate defaults `[]` / `open_proof_gap` before validation; `expectedPolicy` over-bound hard refusal; payload/environment refusals name the accepted id shape |
| `src/state/graph.ts` | `graphEntityId` refusal names `asset-<24 hex>` and where to copy an `entityId` |
| `extensions/p2o/index.ts` | Candidate/report/note description sentences; note-kind and report-confidence handler defaults; graph `view` id message |
| `tests/minimal/tool-admission-defaults.test.ts` (new) | Schema admission of each default, stored default, contradicting values still refused, graph identity message |
| `tests/minimal/prose-caps.test.ts` | `expectedPolicy` declared/stored/warning case |
| `tests/minimal/workspace-runtime.test.ts` | A note with no kind records `note` through the real owner path |
| `planning_update.md` | This document (§1.6, §4.7, decisions D-A1-9…12, verification, remaining work) |

Not touched by either pass: `docs/ACCEPTANCE_MATRIX.md`, `src/truth.ts`, `tests/minimal/truth.test.ts`,
`tests/minimal/context-budget.test.ts`, `tests/minimal/fixtures/inert-provider.ts` (earlier A1 sub-pass, committed in
`00092d4`), and the owner files `AGENTS.md` and `pi-p2o-defense-vi.pptx` (dirty before this work began).

---

## 10. Recovery and provenance

- The P18 text this file replaces: `git show 18d1d84:planning_update.md`.
- P18 implementation commit: `18d1d84` ("Implement the P18 long-horizon loop upgrade") — untouched.
- A1 commit: `00092d4` ("Cut tool-call refusals and repeated prompt facts (A1)"), owner-requested; message carries no
  attribution line.
- Owner decisions for A1 are D-A1-1…D-A1-8 and for A1.2 D-A1-9…D-A1-12 above; they were made in chat, not inferred.
- A1.2 is uncommitted by design (owner reviews first); no commit, push or attribution happens without an owner request
  (AGENTS.md).
