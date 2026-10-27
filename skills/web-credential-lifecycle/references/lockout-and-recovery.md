Tests: wstg-athn-03, wstg-athn-08, wstg-athn-09

# Lockout and recovery

Cards for [web credential lifecycle](../SKILL.md). They change state outside the target (locks, mail). Register a throwaway account, read a mailbox you can reach, and record each attempt.

### wstg-athn-03 Lockout and unlock
- Trigger: a login with a failed-attempt policy.
- Inputs: a throwaway account you register and are willing to lock; the documented threshold and unlock method.
- Steps: send failed logins up to one below the documented threshold, then a valid login to see whether the counter resets. Cross the threshold and note the signal (message, status, delay, challenge). Check that a valid login is refused while locked and compare the response for an unknown name. Examine the unlock path (timer, mailed link, questions) against the recovery cards. With no documented threshold send twenty failures as the first sample, then keep going until a throttle appears or the question is answered.
- Conclude: report when no limit applies within the count, when the limit keys on a request header the server trusts, or when unlock is weaker than login.
- Evidence: attempt counts, the signals, and the receipts showing the lock and the unlock.
- Record: cell for wstg-athn-03 with a policy key such as policy:account-lockout.
- Stop (M2): throwaway account first; twenty failures is the first sample, and spraying or distributed runs are valid when resistance to them is the question.
- Not a finding when: another control (delay, proof of work, step-up challenge) holds under the same measurement.

### wstg-athn-08 Security questions
- Trigger: a recovery or step-up flow that asks questions.
- Inputs: the recovery flow and a throwaway account (H, A).
- Steps: list the questions offered, pre-set or user-written, and judge how guessable or discoverable each answer is. Send a few wrong answers and watch for a counter or lock. Check whether the question shown per account reveals that the account exists. Try real answers, leaked answers or a list when the question needs them, recording each.
- Conclude: report pre-set questions with discoverable answers or small answer spaces, user-written questions accepted without limits, missing attempt limits, and questions used as the only recovery factor.
- Evidence: the question list, attempt counts and signals.
- Record: cell for wstg-athn-08 with a policy key such as policy:recovery-factors.
- Stop (M1): five wrong answers is the first sample; extend the series, or try a list, when the question needs it.
- Not a finding when: the question is only an extra factor beside a stronger one.

### wstg-athn-09 Password change and reset
- Trigger: a password reset or change function.
- Inputs: a throwaway account and a mailbox or number you can reach (A, H); the reset code (S).
- Steps: map the mechanisms (mailed link, code, questions, support). Request several resets and judge the token as a class: length, character set, lifetime, single use, binding to the account, and whether a newer token ends the older one. Check whether the link host comes from a request header, whether the page leaks the token by referrer, whether the response reveals account existence, and whether a reset ends other sessions. For a change, check that the current password and re-authentication are required for identifier changes, and that policy applies. In source, read the generator and the checks.
- Conclude: a guessable, reusable, long-lived or unbound token, or a link built from an attacker-controlled header, is a finding. Compare reset strength with login strength.
- Evidence: token properties by class, never values; receipts and mailbox timestamps.
- Record: cell for wstg-athn-09 with a policy key such as policy:password-reset.
- Stop (M2): reset mail goes to a mailbox you can read; compare a handful of issued tokens, then guess token structure when the question needs it.
- Not a finding when: the token is long, random, single use and short lived.
