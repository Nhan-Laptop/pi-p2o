Tests: wstg-sess-03, wstg-sess-08, wstg-sess-09

# Fixation, session puzzling and hijack

Cards for [web session management](../SKILL.md). Use two controlled accounts, one acting as victim and one as attacker, and named HTTP sessions so their jars never mix.

### wstg-sess-03 Session fixation
- Trigger: a token is issued before login and a login flow exists.
- Inputs: one controlled account; the login route; workflow controlled-identity-comparison.
- Steps: take the pre-login token T0 in the session named pre. Log in while sending T0. Compare the token after login T1 with T0. Call a login-only route with T0 from a fresh context. Repeat with a token that the application accepts from a URL part or form field, if it accepts one. Repeat after a privilege change such as a role switch.
- Conclude: confirmed when T1 equals T0 or T0 works after login, with the positive control (T1 reaches the route) and the negative control (T0 is refused before login). Ruled out when T1 differs, T0 is refused, and both have receipts. Basis: a boundary invariant, an identifier must change when the privilege level changes.
- Evidence: receipt ids of the four requests, cookie names and attributes; no values.
- Record: cell for wstg-sess-03 on the login asset, actor label of the account.
- Stop: no token of anyone else, and no request to another origin.
- Not a finding when: the application is stateless and signed (hand over to the token playbook), or a proxy reassigns the cookie.

### wstg-sess-08 Session puzzling
- Trigger: flows that store identity or progress in the session before the user is authenticated, such as registration, recovery or multi-step forms.
- Inputs: the source of those flows (S) or two controlled accounts and the entry points (A).
- Steps: list the session variables each entry point writes and each protected route reads. Look for a variable that means different things in two flows, or a protected check that only tests that a variable is present. Then, with your own accounts, start a flow as the attacker account (for example the first step of a recovery) and request a login-only route; compare with the same request without the first step.
- Conclude: confirmed when a state-setting entry point lets a protected function run without the login it should demand, shown with the positive and negative control. A check that tests only presence of a key is a source finding.
- Evidence: the variable names, the writing and reading locations, and the two receipts.
- Record: cell for wstg-sess-08; the shared variable as a fact with its two meanings.
- Stop: only your own accounts; no state change beyond the steps already needed to start the flow.
- Not a finding when: the variable is namespaced per flow or cleared when the flow ends.

### wstg-sess-09 Session hijack exposure
- Trigger: a session cookie and a plain-HTTP port or a missing transport pin.
- Inputs: the victim account's session and a second context with its own jar; the cookie attributes from the attributes card.
- Steps: establish whether the token can travel in clear: missing Secure, no transport pin, the app answering on plain HTTP. Send the victim token as an explicit cookie header from the second context to the plain-HTTP port and to the HTTPS origin, and note what each accepts. Compare with the same request carrying no token.
- Conclude: report the exposure when the token is accepted over plain HTTP or can be sent there by a browser; replay itself is expected of a bearer token and is not the finding. Add a binding to a client attribute only as a hardening note.
- Evidence: receipts of the three requests and the attribute list.
- Record: cell for wstg-sess-09 with the exposure in the limitations.
- Stop: only your own accounts; no capture of third-party traffic.
- Not a finding when: the plain-HTTP port redirects before accepting the cookie and the cookie carries the Secure attribute.
