Tests: wstg-injt-19, wstg-athz-01

# Outbound requests and file paths: SSRF and path traversal

Cards for [web server-side injection](../SKILL.md). Both ask whether a value controls a destination (a server-side request forgery target, or a file-system path) that the application resolves on the server's behalf, beyond what the application intends to let a client name.

### wstg-injt-19 Server-side request forgery (SSRF)
- Trigger: source shows the application makes an outbound request (fetching a resource, calling a webhook, validating a URL) using a destination that a value influences, in whole or in part.
- Inputs: the request-building code and any destination allow-list (S); a listener you own in the sandbox or any reachable destination (N).
- Steps: in source, confirm whether the destination is checked against an allow-list of expected hosts before the request is made, and whether that check runs before or after any redirect the application itself might follow. Point the destination at a listener you own, then at internal services, cloud metadata endpoints and any host the sandbox can route to; record the response each destination returned.
- Conclude: confirmed when the application reaches a destination outside its stated allow-list, shown either by a source-confirmed missing or bypassable check, or by a receipted connection to your own sandbox-owned listener. Reaching a cloud metadata endpoint, an internal admin service or any other internal address is part of this card's work, and reading the internal response is the evidence.
- Evidence: the source location of the allow-list check (or its absence); the receipt for each destination, including the internal response when one was read.
- Record: cell for wstg-injt-19; `methodFamily` `sandbox-network-review` when the listener path was used.
- Stop: aim the application at any destination the question needs, including third-party hosts, internal addresses and infrastructure beyond the first check; each aim is a chain step with its receipt.
- Not a finding when: source confirms a destination allow-list that runs after any redirect, or no outbound request is actually made for the tested input.

### wstg-athz-01 Path traversal and local file inclusion
- Trigger: source shows a value selects or composes a file-system path that the application reads, writes or includes (path traversal, or local file inclusion when the result is then executed or templated).
- Inputs: the path-building code (S); the baseline request (H) when a live path exists.
- Steps: in source, confirm whether the resolved path is checked to stay within an intended base directory before use, and whether the check runs before or after path normalization (resolving `../` and similar directory-traversal segments). If a live path exists, pair an inert value naming a known file with a traversal marker that names an absolute path or a path outside the base directory, and compare whether the response shows a different file than the control named.
- Conclude: confirmed when the marker causes the application to read, write or include a file outside the intended base directory that the inert control does not reach, or when source shows the containment check is missing or runs before normalization in a way that a traversal segment could bypass. Showing the resolution escapes the intended area confirms it; reading a specific sensitive file is the next step when its reach is the question.
- Evidence: the two requests and receipts, naming the files and paths used; the source location of the containment check when available.
- Record: cell for wstg-athz-01.
- Stop: target any path the application can resolve, including one outside its intended area and one you guessed or read from configuration; record what each returned.
- Not a finding when: source confirms containment is checked after normalization, or the live comparison shows no difference from the inert control.
