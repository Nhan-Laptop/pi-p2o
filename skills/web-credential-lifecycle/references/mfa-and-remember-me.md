Tests: wstg-athn-05, wstg-athn-11

# MFA and remember me

Cards for [web credential lifecycle](../SKILL.md). They test the strongest and the most convenient ways back into an account. Use a throwaway account whose factor you control.

### wstg-athn-05 Remember me
- Trigger: a remember-me or saved-login option.
- Inputs: a controlled account, a login with the option on and off, and the code that issues the token (S).
- Steps: log in with the option and compare the extra token with the normal session: lifetime, attributes, whether it carries the username or an encoded password, and whether its value looks guessable. After the normal session has ended, use only the long-lived token from a fresh context. Check that logout and a password change retire it. In source, read how it is generated, stored and revoked.
- Conclude: a persistent token that holds credentials, is predictable, survives logout or a password change, or lacks the attributes of the session cookie is a finding.
- Evidence: the token class and lifetime, and the replay receipts.
- Record: cell for wstg-athn-05; link it to the session cards.
- Stop (M1): own account first; use another principal's token when the question needs it, and never record a value.
- Not a finding when: the token is random, revocable on the server and tied to a device.

### wstg-athn-11 Multi-factor authentication
- Trigger: MFA enrolment or verification.
- Inputs: a throwaway account with the factor under your control (A); the flow (S).
- Steps: identify the factor types and every place that authenticates: login, sensitive actions, MFA management, recovery, alternative channels and API routes. For each, check whether the second factor can be skipped (a direct request to the post-factor page, a parameter, another route, remembered-device state), whether the code is bound to the session and single use, how many wrong codes are allowed, whether enrolment and removal need re-authentication, whether recovery codes are long and limited, and whether an MFA reset is as strong as the factor.
- Conclude: report any path that reaches the authenticated state without the factor, unlimited code attempts, reusable codes, or a recovery route weaker than the factor.
- Evidence: per path, the receipts before and after the factor step, with attempt counts and signals.
- Record: cell for wstg-athn-11, one per path class.
- Stop (M2): five wrong codes is the first sample; push-notification flooding and code enumeration are valid where resistance to them is the question.
- Not a finding when: the bypass needs a prior valid factor that the threat model excludes.
