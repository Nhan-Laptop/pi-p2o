Tests: wstg-conf-12, wstg-clnt-07, wstg-clnt-09, wstg-clnt-13

# Cross-origin and framing policy

Cards for [web browser trust controls](../SKILL.md). All four read a declared header and judge it against what the response actually carries; none needs a real browser to render anything.

### wstg-conf-12 Content security policy
- Trigger: any confirmed origin serving HTML.
- Inputs: the baseline response set (H); the policy source if generated from configuration (S).
- Steps: read the enforced policy header (not a report-only variant) on each baseline route and record its directives. Note any directive that allows inline script or style without a nonce or hash, any directive using a broad wildcard source, and whether the policy is delivered consistently across every route that carries sensitive content.
- Conclude: report a policy that allows inline script or style without a nonce or hash on a route that also reflects any untrusted value, and a wildcard source on a route carrying sensitive content. A strict policy with nonce- or hash-based script control and no inline allowance is not a finding.
- Evidence: the header value per route and the directive judged weak.
- Record: cell for wstg-conf-12.
- Stop: read the declared policy first, then construct the bypass that policy permits against an origin the task authorizes; the construction never runs against a real third party.
- Not a finding when: the response carries no sensitive content and no reflected value, or the policy is report-only and not relied upon as the sole control.

### wstg-clnt-07 Cross-origin resource sharing
- Trigger: a response carries a CORS header, or source shows a route configured to answer cross-origin requests.
- Inputs: the baseline response and one request carrying a different origin indicator (H); the CORS configuration (S).
- Steps: send one request with the application's own origin indicator and one with an unrelated origin indicator, to the same route, and compare the CORS headers returned for each. Check whether the allowed-origin value is a wildcard, echoes back whatever origin was sent, or is a fixed allow-list, and whether a credentials-allowing header appears alongside a wildcard or echoed value.
- Conclude: confirmed when the route echoes an arbitrary origin back as allowed and also allows credentials, or uses a wildcard allowed-origin on a response carrying sensitive data. A fixed allow-list of origins that does not echo an arbitrary value is not a finding.
- Evidence: the two requests and their response headers.
- Record: cell for wstg-clnt-07.
- Stop: two requests per route establish the policy; then build the cross-origin read the policy allows from an origin the task authorizes and you control, and never from an actual third-party page.
- Not a finding when: the allowed-origin value is a fixed list and does not echo an arbitrary sent value, or the response carries no sensitive data.

### wstg-clnt-09 Framing policy
- Trigger: any confirmed origin serving HTML meant to be viewed directly by a user (not an API response).
- Inputs: the baseline response set (H).
- Steps: read the framing-control header (or the frame-ancestors directive of the content security policy) on each baseline route, and note whether it is present, what it allows, and whether it is delivered consistently across every route, including error and redirect pages.
- Conclude: report a route carrying a sensitive action (not just sensitive display) with no framing control at all, or one that allows framing from any origin. A route that allows framing from the application's own other pages only, by design, is not a finding.
- Evidence: the header or directive value per route.
- Record: cell for wstg-clnt-09.
- Stop: read only; this card does not construct a framing page.
- Not a finding when: every sensitive route carries a framing control that denies or restricts to the application's own origin.

### wstg-clnt-13 Script-loadable response exposure
- Trigger: source shows a script-loadable response (one fetched through a script-tag-style load rather than a fetch call that honors CORS) carries data that differs by the requester's authenticated session.
- Inputs: the response fetched as an authenticated and as an anonymous requester, compared for structure (A, H); the response's declared content type and whether it is valid, directly executable script syntax on its own (S).
- Steps: compare the authenticated and anonymous versions of the response for any difference in content, and read in source whether the response's syntax would execute meaningfully if loaded as a script by another page, independent of its declared content type, and whether a session-identifying cookie would be attached to that cross-site load given its SameSite setting.
- Conclude: confirmed when the response differs by session, is valid executable syntax on its own, and the cookie that would select the content is sent on a cross-site script-tag-style load. All three must hold; any one being false rules this out.
- Evidence: the two response bodies (structure only, sensitive values redacted), the syntax judgment, and the cookie's SameSite setting.
- Record: cell for wstg-clnt-13.
- Stop: read and compare only; no page is constructed to actually perform the cross-site load.
- Not a finding when: the response is not valid executable syntax on its own, or the identifying cookie has a SameSite setting that would not attach it to such a load.
