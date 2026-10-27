Tests: wstg-conf-06, wstg-conf-07, wstg-conf-14, wstg-athn-06

# Response headers, methods and cache

Cards for [web deployment hygiene](../SKILL.md). They read policy that the server declares to clients. A browser's reaction to a header is observable through the image's Chromium; what this card proves directly is the declaration.

### wstg-conf-06 HTTP methods
- Trigger: any HTTP target.
- Inputs: the baseline set and the OPTIONS answer; a path that tolerates a write if a write method is exercised (M1).
- Steps: request OPTIONS on the root and on one API route and read Allow; request a real protected path with HEAD and with an unlisted method and compare with the login redirect it gives for GET; check whether the framework honors a method-override header or parameter; use TRACE only to see whether the request is echoed. Exercise PUT or DELETE on a path you created where possible, or the path under test.
- Conclude: report a method that bypasses an access decision, or a write method accepted on a path that should be read-only. An Allow list longer than needed is an observation.
- Evidence: receipt per request with the method and its status compared with GET.
- Record: cell for wstg-conf-06; the access rule as the policy key when one is stated.
- Stop: CONNECT and proxy use are valid when the question needs them, with the receipt; write methods are in scope.
- Not a finding when: an edge layer answers differently from the origin, or Allow lists methods the route does not serve.

### wstg-conf-07 Strict transport security
- Trigger: https origin.
- Inputs: HTTPS responses of the baseline set and the plain-HTTP port.
- Steps: read the HSTS header on HTML and non-HTML responses; compare max-age with the reference the operator names (default one year) and note includeSubDomains and preload; request the plain-HTTP port and see whether it redirects to the same host over HTTPS and whether the header wrongly appears on plain HTTP; check an error response and a redirect response for the header.
- Conclude: a missing or short value on an HTTPS origin that sets a session cookie is a low finding. The preload flag counts only if the other preload conditions hold. A header sent over plain HTTP is ignored by browsers; keep it as a note.
- Evidence: the header value per response and the redirect chain.
- Record: cell for wstg-conf-07 on the origin asset.
- Stop: a downgrade attempt is a valid next step; record the redirect and the receipt.
- Not a finding when: a CDN sets it, or the origin is plain HTTP by design.

### wstg-conf-14 Other security headers
- Trigger: any HTTP target.
- Inputs: baseline responses by class.
- Steps: on HTML responses read the content-type protection, referrer, permissions, cross-origin isolation and framing headers, and judge the value, not the presence; flag duplicated or conflicting copies, deprecated headers and permissive wildcards; confirm the header also arrives on error pages and redirects; where a policy is also set in a meta tag, note which one is authoritative. Test whether a connection header can strip a security header, on a path that tolerates it (M1).
- Conclude: report a header as weak when its value allows the behavior it exists to prevent and the response carries sensitive content. Presence on one class and absence on another is an observation.
- Evidence: a header table per route class.
- Record: cell for wstg-conf-14; the browser flag marks an effect to observe through the image's Chromium.
- Stop: read first; the stripping check and any header-modifying check are valid, recorded with receipts.
- Not a finding when: the header is irrelevant to the content type, or its modern replacement is present.

### wstg-athn-06 Browser cache directives
- Trigger: a session token feature and pages with sensitive data after login.
- Inputs: authenticated responses captured under a controlled identity (A), or the source that sets cache headers (S).
- Steps: for responses after login that hold sensitive data read Cache-Control, Pragma and Expires; compare with the logout response and with a public asset that may be cached; in source find where cache directives are set for authenticated routes.
- Conclude: report sensitive responses that permit storage by browser or shared caches. History and back-button behavior needs a browser, so it stays a gap.
- Evidence: header values per response and the response class.
- Record: cell for wstg-athn-06 with the browser limit noted.
- Stop: another principal's cached content is a valid target when the cache question needs it; record the receipt.
- Not a finding when: the response holds public data, or a private-only directive is present.
