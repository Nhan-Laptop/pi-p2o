Tests: wstg-injt-19, wstg-athz-01

# Outbound requests and file paths: SSRF and path traversal

Cards for [web server-side injection](../SKILL.md). Both ask whether a value controls a destination (a server-side request forgery target, or a file-system path) that the application resolves on the server's behalf, beyond what the application intends to let a client name.

### wstg-injt-19 Server-side request forgery (SSRF)
- Trigger: source shows the application makes an outbound request (fetching a resource, calling a webhook, validating a URL) using a destination that a value influences, in whole or in part.
- Inputs: the request-building code and any destination allow-list (S); a sandbox-owned listener reachable only within the assessment's own network, if the workflow and scope allow it (N).
- Steps: in source, confirm whether the destination is checked against an allow-list of expected hosts before the request is made, and whether that check runs before or after any redirect the application itself might follow. If a bounded, scope-approved outbound check is available, point the destination at a listener you own inside the sandbox network and confirm only that a connection arrived, recording nothing about what else that listener could reach.
- Conclude: confirmed when the application reaches a destination outside its stated allow-list, shown either by a source-confirmed missing or bypassable check, or by a receipted connection to your own sandbox-owned listener. Reaching an internal address you do not own (such as a cloud metadata endpoint or an internal admin service), or reading the content of an internal response, stays an open_proof_gap for exploitability-assessment; do not pursue it from this card.
- Evidence: the source location of the allow-list check (or its absence); the listener receipt showing only that a connection arrived, with no content read from it.
- Record: cell for wstg-injt-19; `methodFamily` `sandbox-network-review` when the listener path was used.
- Stop: only a destination you own may be used to confirm reachability; never point the application at a third-party host, an internal address you do not control, or an address meant to probe infrastructure beyond this one check.
- Not a finding when: source confirms a destination allow-list that runs after any redirect, or no outbound request is actually made for the tested input.

### wstg-athz-01 Path traversal and local file inclusion
- Trigger: source shows a value selects or composes a file-system path that the application reads, writes or includes (path traversal, or local file inclusion when the result is then executed or templated).
- Inputs: the path-building code (S); the baseline request (H) when a live path exists.
- Steps: in source, confirm whether the resolved path is checked to stay within an intended base directory before use, and whether the check runs before or after path normalization (resolving `../` and similar directory-traversal segments). If a live path exists, pair an inert value naming a file already known to exist within the intended area with one boundary-class marker that uses a directory-traversal segment staying inside that same known area, and compare whether the application's response shows it read a different file than the inert control named.
- Conclude: confirmed when the marker causes the application to read, write or include a file outside the intended base directory that the inert control does not reach, or when source shows the containment check is missing or runs before normalization in a way that a traversal segment could bypass. Reading a specific sensitive file is not needed to confirm; showing the resolution escapes the intended area is enough.
- Evidence: the two requests and receipts, naming only files already known within the intended area; the source location of the containment check when available.
- Record: cell for wstg-athz-01.
- Stop: use only files already known to exist within an area the task is authorized to read; never target a path outside the application's own intended area or a path guessed to hold secrets.
- Not a finding when: source confirms containment is checked after normalization, or the live comparison shows no difference from the inert control.
