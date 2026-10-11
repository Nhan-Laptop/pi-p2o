Tests: wstg-injt-07, wstg-injt-09

# Document parsers: XML injection and XPath injection

Cards for [web server-side injection](../SKILL.md). Both ask whether a value escapes the data position it was meant to fill inside a parsed document (XML, or another markup format with the same structure/data distinction), without needing the parser to fetch or expose anything beyond that question.

### wstg-injt-07 XML injection
- Trigger: a request body or field is parsed as XML or a similar markup format (not just rendered as text) before the application reads a value out of it.
- Inputs: the baseline request (H); the parser configuration and the schema or expected shape (S).
- Steps: pair an inert value with one boundary-class marker that would close the current data position and open a new structural node if the parser treated it unparsed (an XML-reserved character used exactly where the schema expects plain text); compare the parsed result the application reports (an echoed field, a validation error, a status) against the baseline. Separately, in source only, check whether the parser is configured to resolve external entities (XXE) or parameter entities beyond the document's own content; do not attempt to exercise that path live, since confirming external-entity resolution needs an out-of-band channel this task may not have authorization to use.
- Conclude: confirmed when the structural marker changes what the application reports as parsed, in a way the inert control does not. A parser configuration that leaves external entity resolution enabled, found only in source, is recorded as an open_proof_gap unless the task's scope separately authorizes an out-of-band channel to confirm it live.
- Evidence: the two requests and receipts; the parser configuration line when available, naming whether external entities are disabled.
- Record: cell for wstg-injt-07; `execution: blocked` with the missing out-of-band authorization named when the live path is not confirmed.
- Stop: no attempt to reach a resource outside the document itself without separate, explicit scope for an out-of-band channel; never construct a working external-entity payload.
- Not a finding when: the parser rejects the marker as malformed input identically to the inert control, or source shows external entity resolution is disabled.

### wstg-injt-09 XPath injection
- Trigger: a value selects a node or attribute inside a parsed XML document through an XPath expression.
- Inputs: the baseline request (H); the XPath-building code (S).
- Steps: pair an inert value with one boundary-class marker that would close the current path step and add a predicate condition if inserted unparsed (an XPath-reserved character used where the expression expects a plain value); compare the selected result against the baseline. In source, confirm whether the expression is built by string assembly or by a parameterized XPath API.
- Conclude: confirmed when the marker changes the selected result in a way the inert control does not, and source, when available, shows unparameterized assembly.
- Evidence: the two requests and receipts; the source line of the XPath construction when available.
- Record: cell for wstg-injt-09.
- Stop: one comparison is enough to confirm; no attempt to enumerate the document's full contents.
- Not a finding when: the result is identical for both values, or a parameterized XPath API is confirmed in source.
