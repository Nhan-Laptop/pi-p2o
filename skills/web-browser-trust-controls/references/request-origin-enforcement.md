Tests: wstg-sess-05, wstg-clnt-10

# Request-origin enforcement

Cards for [web browser trust controls](../SKILL.md). Both ask whether a server-side check actually gates a state-changing or persistent-connection request on something a browser cannot be made to forge from another site, rather than only on a value a browser attaches automatically to every request regardless of origin.

### wstg-sess-05 Cross-site request forgery
- Trigger: a request changes state (creates, updates or deletes something, or changes account settings) and is authenticated only by a cookie or header a browser attaches automatically.
- Inputs: a controlled principal's baseline state-changing request (A); the request's required fields and the session cookie's SameSite setting (H, S).
- Steps: read the session cookie's SameSite setting from the baseline response. Resend the baseline request with any request-bound token the application includes removed, and separately with an unrelated-but-valid value substituted for it, and compare acceptance against the baseline. Check whether the application accepts the same request when sent with only the fields a browser would attach without any page-specific token (plain cookie, default headers).
- Conclude: confirmed when the state-changing request is accepted with the request-bound token missing or replaced by an unrelated value, or when no such token exists and the cookie's SameSite setting would still let a browser attach it from another site for this request's method. Not a finding when a request-bound token is correctly validated, or when the cookie's SameSite setting would prevent the browser from attaching it to a cross-site request of this method in the first place.
- Evidence: the baseline and the two altered requests with receipts; the cookie's SameSite setting.
- Record: cell for wstg-sess-05; `methodFamily` `controlled-identity-comparison`.
- Stop: use only your own controlled principal's state; never a request that affects another principal's data. The forged request is submitted from an origin the task authorizes and that you control, never from a real third party's page.
- Not a finding when: the token is validated correctly, or the cookie's SameSite setting blocks the relevant cross-site attachment for this request's method.

### wstg-clnt-10 WebSocket origin and transport parity
- Trigger: source or network observation shows the application uses a WebSocket connection for authenticated or state-changing communication.
- Inputs: the handshake request and response for a controlled principal (A); the handshake-origin-checking code (S).
- Steps: read whether the server validates the handshake's origin indicator before completing the connection, from source or by resending the handshake with an altered origin indicator and comparing acceptance. For the messages the connection carries, identify whether the same authorization and validation rules already confirmed for the equivalent ordinary request channel also apply here, or whether this channel skips a check the other channel enforces.
- Conclude: confirmed when the handshake completes despite a mismatched origin indicator, or when a message over this channel bypasses a check that the equivalent ordinary request channel enforces, named specifically.
- Evidence: the handshake comparison receipts; the specific check shown to differ between channels.
- Record: cell for wstg-clnt-10.
- Stop: one handshake comparison and a comparison against already-confirmed channel parity is enough; no flooding of the connection.
- Not a finding when: the origin check is confirmed, and every message-level check already holds across both channels.
