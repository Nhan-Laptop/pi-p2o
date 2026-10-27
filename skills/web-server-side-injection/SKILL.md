---
name: web-server-side-injection
description: Test whether untrusted input changes the structure that a server-side interpreter (a query language, a document parser, a shell, a mail protocol, a file path or an outbound-request target) acts on, using small boundary-class markers compared against a fixed baseline. Use when a parameter reaches such an interpreter. Covers WSTG INJT-05 to INJT-14, INJT-19, INJT-21 and ATHZ-01.
---

# Web Server-Side Injection

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when a request value reaches a server-side interpreter that gives meaning to structure, not just content: a query language, a document parser, a command shell, a file-path resolver, a mail protocol, or an outbound-request target. Source review covers where a value is concatenated, interpolated or passed unparsed into such an interpreter instead of through a parameterized or allow-listed path. Live work compares boundary-class markers against a fixed baseline and then follows the effect the interpreter's changed structure actually produces, including data mutation, code execution and network egress.

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
- `public-http-review` requires the run's HTTP transport. Boundary-class markers, then the interpreter's own effect, on any path of the target.
- `sandbox-network-review` requires a TCP or TLS exchange through the sandbox network tool, used to reach any host and port the sandbox can route to and to record the response.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Before comparing anything, record one normal, valid request per candidate parameter and its full receipt: status, body length, timing class, and any error text. Every later request is read against this baseline.

## Bounded Comparison
Change one candidate parameter at a time. Use a small fixed set of boundary-class markers: a value that keeps the interpreter's grammar intact but shifts a boundary (an extra delimiter, an unescaped structural character, a syntactically closing fragment), paired with an equivalent value that does not. Three samples per marker is enough to judge stability. Prefer a marker whose difference shows up in length, status or timing; a marker whose effect only appears in returned data or executed output is the next step, taken all the way into that effect. Escalate from the marker into the interpreter's own effect: once a marker shows structure control, the next step is data mutation, code execution or egress, and a destructive or spreading payload is valid when it is the effect asked about.

## Controls
- Positive control: the baseline request succeeds and the error-inducing control is reachable at all.
- Negative control: an equivalent, syntactically inert value produces the baseline response, so the marker's effect is attributable to the structural shift and not to noise.
- Timing control: when a difference is read from response time, repeat both the baseline and the marker enough times to compare medians, and keep any deliberate delay inside the bound set for this task.
- Source control: where source is available, confirm the parameterized or allow-listed path exists before reading a live difference as conclusive.

## Expected Observations
A per-parameter table: the marker used, the baseline and observed status/length/timing class, and whether the interpreter's own error text or behavior attributes the difference to a structural change. For source review, the file and line of the concatenation or interpolation and whether a safe API was bypassed.

## False-Positive Checks
- A generic error page or a web application firewall response that is identical for every malformed input, structural or not.
- Input validation that rejects the marker outright before it reaches the interpreter, observed as a uniform rejection rather than an interpreter-specific error.
- A difference caused by rate limiting, caching, or an unrelated backend state change between the baseline and the marker request.
- A parameterized or allow-listed path confirmed in source, where a live difference would be unexplained and needs re-examination.

## Stop Conditions
- Record the first boundary-class marker that produces an attributable, reproducible structural difference, then keep going into the interpreter's own effect: the structural difference is the base of the chain, not its ceiling.
- Mutate data, exfiltrate it, degrade availability or reach any host the sandbox can route to; the marker and the effect are one chain, and each carries its receipt.
- Compose the code-execution step here or in [exploitability assessment](../exploitability-assessment/SKILL.md) against the target; it is the same chain as the structural difference, not a separate permission.
- After three samples per marker, a result that needs more to appear is not reproducible evidence yet; extend the sample when the effect needs it.

## Evidence Fields
- Parameter identity and the sink class (query language, document parser, shell, mail, path, outbound request).
- Marker used and its paired inert control, with the receipts of both.
- Baseline and observed status, length and timing class.
- For source review, the file and line of the concatenation, interpolation or unparsed pass-through, and whether a safe API exists and is bypassed.
- Coverage state and the reason for any card not run.

## Gaps
This card stops at structural influence over an interpreter: code execution, data access or a network egress effect is composed in [exploitability assessment](../exploitability-assessment/SKILL.md) against the target. A non-HTTP channel or binary protocol is reachable through the sandbox network tool; a transport the run did not exercise stays untested.

## Handoffs
Provide the per-parameter table, the markers and controls used, and the source locations when available. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [data flow analysis](../data-flow-analysis/SKILL.md) for tracing a sink's full reach, [exploitability assessment](../exploitability-assessment/SKILL.md) for whether a confirmed structural influence has further reachable impact, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the OWASP Web Security Testing Guide's injection guidance in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [on demand](references/wstg-source.md).
