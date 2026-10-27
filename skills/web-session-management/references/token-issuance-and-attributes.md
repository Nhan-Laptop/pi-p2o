Tests: wstg-sess-01, wstg-sess-02, wstg-sess-04

# Token issuance and attributes

Cards for [web session management](../SKILL.md). They look at how the token is made, labelled and carried. Record names, attributes and lengths only; a token value never goes into a note, a receipt label or a case.

### wstg-sess-01 Token strength and structure
- Trigger: a session token feature (cookie, header or hidden field).
- Inputs: up to thirty fresh sessions of one controlled account, and one session of a second account when it exists (H, A); the token generator in a supplied tree (S).
- Steps: list every state carrier and what it holds. Draw the samples with the jar reset between them and compare them offline: constant segments, counters, timestamps, usernames, encodings that decode to readable fields, and the spread of each character position. Change one decodable client-side field of your own cookie at a time and see whether the server accepts the change. In source, find the generator and the random source it uses.
- Conclude: a pattern (sequence, time base, repetition) or a client-side field that the server trusts is a finding. No pattern in a small sample is bounded evidence; for strength, rely on source showing a cryptographic random source, and compare length with the stated policy floor.
- Evidence: carrier inventory, sample size, the observed pattern in words and, for source, the generator location.
- Record: cell for wstg-sess-01 on the login asset; ruled_out_bounded only for the sampled population.
- Stop: thirty samples is the first sample; guess another user's token, or scale the sample, when the strength question needs it, recording each attempt.
- Not a finding when: the field is a preference or tracking cookie, or the framework token comes from a cryptographic generator.

### wstg-sess-02 Cookie attributes
- Trigger: a session token delivered as a cookie.
- Inputs: the pre-login and post-login Set-Cookie headers (H, A); the framework session settings (S).
- Steps: for each session or authentication cookie record Secure, HttpOnly, SameSite, Domain, Path, lifetime and any name prefix that binds the cookie to the host. Compare the cookie issued before login with the one issued after. Note a Domain wider than the host, a persistent lifetime on a session identifier, and SameSite set to none without Secure.
- Conclude: report a missing Secure attribute when the origin is also reachable over plain HTTP or lacks transport pinning, a missing HttpOnly when script injection is a stated or found risk, and a Domain that shares the cookie with sibling hosts that are not trusted. State the exposure with each.
- Evidence: the attribute list per cookie name and the receipt of the response that set it.
- Record: cell for wstg-sess-02 per cookie name; methodFamily public-http-review for the pre-login part.
- Stop: read only.
- Not a finding when: the cookie is not an identifier, or the attribute is enforced by a gateway and visible there.

### wstg-sess-04 Exposure of the token in transit, URLs and caches
- Trigger: a session token feature.
- Inputs: the login sequence under a controlled identity (A); links, redirects and forms of the authenticated area (H); the transport and cache settings (S).
- Steps: record how the token travels: cookie, header, form field or URL part. Request the plain-HTTP port with the cookie to see whether the session is accepted there. Look for tokens in redirect targets, links, error pages and requests to other origins that would carry a referrer. Read the cache directives on responses that set or return a token. In source find places where the token is logged or put in a URL.
- Conclude: a token accepted over plain HTTP, present in a URL, sent to another origin or stored by a shared cache is a finding. Name the channel.
- Evidence: receipts of the two transports, the URL or header where the token appeared (value redacted), the cache headers.
- Record: cell for wstg-sess-04; the exposure channel as an observed fact.
- Stop: send the token to any host and port the sandbox can reach; a token that travels outside the target is the exposure being tested.
- Not a finding when: the token appears only in a response body marked as non-cacheable that is delivered to its owner.
