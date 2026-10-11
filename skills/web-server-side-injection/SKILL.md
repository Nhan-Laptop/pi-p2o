---
name: web-server-side-injection
description: Test whether untrusted input changes the structure that a server-side interpreter (a query language, a document parser, a shell, a mail protocol, a file path or an outbound-request target) acts on, using small boundary-class markers compared against a fixed baseline. Use when a parameter reaches such an interpreter. Covers WSTG INJT-05 to INJT-14, INJT-19, INJT-21 and ATHZ-01.
---

# Web Server-Side Injection

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when a request value reaches a server-side interpreter that gives meaning to structure, not just content: a query language, a document parser, a command shell, a file-path resolver, a mail protocol, or an outbound-request target. Source review covers where a value is concatenated, interpolated or passed unparsed into such an interpreter instead of through a parameterized or allow-listed path. Live work compares a small set of boundary-class markers against a fixed baseline, never a destructive payload. The question is always whether the interpreter's structure changed, not whether a specific exploit succeeds.

## Test Cards
- [Query languages: SQL/NoSQL and LDAP injection](references/query-languages.md): wstg-injt-05, wstg-injt-06.
- [Document parsers: XML and XPath injection](references/document-parsers.md): wstg-injt-07, wstg-injt-09.
- [Process and template interpreters: SSI, code and OS command injection](references/process-and-template-interpreters.md): wstg-injt-08, wstg-injt-11, wstg-injt-12.
- [Format string injection](references/representation-dependent-behavior.md): wstg-injt-13.
- [Outbound requests and paths: SSRF and path traversal](references/outbound-requests-and-paths.md): wstg-injt-19, wstg-athz-01.
- [Stored and second-order effects: IMAP/SMTP and CSV injection](references/stored-and-second-order-effects.md): wstg-injt-10, wstg-injt-14, wstg-injt-21.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Find where a value reaches an interpreter and whether a parameterized or allow-listed path is used.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Reproduce the interpreter and the suspected sink with a local, disposable copy of its data, after a real probe confirms the runtime.
- `public-http-review` requires authorized same-origin requests through the scoped HTTP client on the confirmed origin. Boundary-class markers only, on a path the scope allows for this task.
- `sandbox-network-review` requires a bounded TCP or TLS exchange with a confirmed host and port through the sandbox network tool, used only to confirm reachability of a destination you own.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Before comparing anything, record one normal, valid request per candidate parameter and its full receipt: status, body length, timing class, and any error text. Every later request is read against this baseline, never against assumption.

## Bounded Comparison
Change one candidate parameter at a time. Use a small fixed set of boundary-class markers: a value that keeps the interpreter's grammar intact but shifts a boundary (an extra delimiter, an unescaped structural character, a syntactically closing fragment), paired with an equivalent value that does not. Three samples per marker is enough to judge stability. Prefer a marker that produces an observable but harmless difference (a changed length, status or timing class) over one that would need the interpreter to actually execute or return data. Escalate only within the same bounded set; do not expand toward reading, writing or deleting data, and never use a destructive or spreading payload.

## Controls
- Positive control: the baseline request succeeds and the error-inducing control is reachable at all.
- Negative control: an equivalent, syntactically inert value produces the baseline response, so the marker's effect is attributable to the structural shift and not to noise.
- Timing control: when a difference is read from response time, repeat both the baseline and the marker enough times to compare medians, and keep any deliberate delay inside the bound set for this task.
- Source control: where source is available, confirm the parameterized or allow-listed path exists (or does not) before reading a live difference as conclusive.

## Expected Observations
A per-parameter table: the marker used, the baseline and observed status/length/timing class, and whether the interpreter's own error text or behavior attributes the difference to a structural change. For source review, the file and line of the concatenation or interpolation and whether a safe API was bypassed.

## False-Positive Checks
- A generic error page or a web application firewall response that is identical for every malformed input, structural or not.
- Input validation that rejects the marker outright before it reaches the interpreter, observed as a uniform rejection rather than an interpreter-specific error.
- A difference caused by rate limiting, caching, or an unrelated backend state change between the baseline and the marker request.
- A parameterized or allow-listed path confirmed in source, where a live difference would be unexplained and needs re-examination.

## Stop Conditions
- Stop at the first boundary-class marker that produces an attributable, reproducible structural difference; record it and move to the next candidate parameter rather than deepening the same one.
- Stop before any marker that would read, write or delete data, change recipient or destination state, or reach a host outside the confirmed origin.
- Stop before any marker whose purpose is to demonstrate code execution, data exfiltration or denial of service; that is outside this card's evidence ceiling and becomes an open_proof_gap citing exploitability-assessment instead.
- Stop after three samples per marker; a result that needs more to appear is not reproducible evidence yet.

## Evidence Fields
- Parameter identity and the sink class (query language, document parser, shell, mail, path, outbound request).
- Marker used and its paired inert control, with the receipts of both.
- Baseline and observed status, length and timing class.
- For source review, the file and line of the concatenation, interpolation or unparsed pass-through, and whether a safe API exists and is bypassed.
- Coverage state and the reason for any card not run.

## Gaps
Confirmed structural influence over an interpreter is not the same as demonstrated code execution, data access or a network egress effect; those stay open_proof_gap and route to exploitability-assessment with an explicit missing-capability note, never a confirmed closure here. Interpreters reachable only through a transport this library does not provide (a binary protocol, a non-HTTP channel) remain unverified.

## Handoffs
Provide the per-parameter table, the markers and controls used, and the source locations when available. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [data flow analysis](../data-flow-analysis/SKILL.md) for tracing a sink's full reach, [exploitability assessment](../exploitability-assessment/SKILL.md) for whether a confirmed structural influence has further reachable impact, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the injection-testing guidance of the OWASP Web Security Testing Guide in this library's evidence terms, replacing payload catalogs and exploitation walkthroughs with bounded, harmless comparisons; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [on demand](references/wstg-source.md).
