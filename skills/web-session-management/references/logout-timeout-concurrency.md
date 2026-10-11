Tests: wstg-sess-06, wstg-sess-07, wstg-sess-11

# Logout, timeout and concurrent sessions

Cards for [web session management](../SKILL.md). Waits are chosen in advance and bounded; anything longer is read from configuration and recorded as a gap.

### wstg-sess-06 Logout
- Trigger: a login flow with a logout function.
- Inputs: one controlled account; the logout route; workflow controlled-identity-comparison.
- Steps: keep the token T. Check that every authenticated page offers a way out (inspect the markup). Log out and note how the response treats the cookie. Replay T on a login-only route in a fresh context. Repeat after a logout that the application performs on its own, such as a timeout redirect.
- Conclude: confirmed when T still reaches a protected route after logout, with the positive control (T worked before) and the negative control (no token is refused). Ruled out when T is refused and the cookie is cleared. Basis: a boundary invariant, logout ends the server-side session.
- Evidence: receipts before logout, the logout response and the replay.
- Record: cell for wstg-sess-06; policy key such as policy:session-invalidation-on-logout.
- Stop: only your own account.
- Not a finding when: the token is stateless by design and the application states a short lifetime for it.

### wstg-sess-07 Session timeout
- Trigger: a session token feature.
- Inputs: one controlled account; the documented idle and absolute limits, or the session settings (S).
- Steps: read the configured idle and absolute lifetimes and any renewal on activity. Probe with a replay of an idle session after increasing waits up to the bound set in advance, with a fresh login as the control for each wait. Check that background polling does not extend the session without limit.
- Conclude: a missing absolute lifetime, an idle limit longer than the stated policy, or a session that survives past its configured limit is a finding. A wait that reaches the bound without a result is a gap, and the source reading stands in.
- Evidence: the setting and its file, the wait times used and the replay status for each.
- Record: cell for wstg-sess-07; open_gap when the policy is unstated.
- Stop: the bound set before the run; no repeated keep-alive loops.
- Not a finding when: a sensitive area enforces a shorter limit than the general one, and the general one is documented.

### wstg-sess-11 Concurrent sessions
- Trigger: login for accounts with sensitive data or an administrative area.
- Inputs: one controlled account logged in from two named sessions; the stated concurrency policy.
- Steps: log in from the first context, then from the second. Check whether both stay valid, whether the older one is ended or warned, and what logout in one context does to the other. Compare with the stated policy for that role.
- Conclude: report only against a stated policy or for an administrative role where unlimited parallel sessions contradict the documentation. Without a policy it is an observation and an open_proof_gap.
- Evidence: receipts from both contexts after each step.
- Record: cell for wstg-sess-11; policy key such as policy:concurrent-sessions.
- Stop: two sessions of one controlled account; no account lockout attempts.
- Not a finding when: the application intends multiple devices and says so.
