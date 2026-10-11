---
name: web-credential-lifecycle
description: Test how an identity is created, proved, locked, recovered and strengthened with a second factor, using throwaway accounts, operator-controlled mailboxes and counted attempts. Use when an application offers registration, password login, reset or MFA. Covers WSTG IDNT-02 to IDNT-04, ATHN-02, ATHN-03, ATHN-05, ATHN-07 to ATHN-09 and ATHN-11.
---

# Web Credential Lifecycle

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when users can register, sign in with a password, recover access or add a second factor, and the question is whether each step proves what the application's policy says it proves. Source review covers registration and provisioning code, initial roles, seeded accounts, password rules and storage settings, lockout counters, reset and recovery token generation and the MFA state machine. Live work needs operator-supplied throwaway accounts, a mailbox or number the operator controls, and a stated policy for password strength, lockout, token lifetime and factors. Several steps change state outside the target (mail, locked accounts), so this playbook counts every attempt and stops early.

## Test Cards
- [Account creation and enumeration](references/account-creation-and-enumeration.md): wstg-idnt-02, wstg-idnt-03, wstg-idnt-04.
- [Credential policy and defaults](references/credential-policy-and-defaults.md): wstg-athn-02, wstg-athn-07.
- [Lockout and recovery](references/lockout-and-recovery.md): wstg-athn-03, wstg-athn-08, wstg-athn-09.
- [MFA and remember me](references/mfa-and-remember-me.md): wstg-athn-05, wstg-athn-11.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Trace account creation, credential checks, counters, token generation and factor verification in the supplied revision.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Run the extracted password rule, token generator or factor check against controlled inputs in a local harness, after a real probe confirms the runtime.
- `public-http-review` requires authorized same-origin requests through the scoped HTTP client. Anonymous registration, login and recovery requests on the confirmed origin, counted in advance.
- `controlled-identity-comparison` requires operator-supplied credentials attributable to throwaway principals, used only inside the confirmed origin. Without them keep the candidate at a static trace and record the dynamic gap.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Write down the policy before sending anything: password rules, lockout threshold and unlock method, reset token lifetime and channel, factor types, and who may register or provision. Then observe each normal path once: a valid login, a known name with a wrong password, an unknown name, a fresh registration, a recovery request for a known and an unknown name. Keep status, length, redirect, message class and a coarse timing class for each. Every later comparison is against this set.

## Bounded Comparison
Change one variable per comparison: whether the account exists, the password, the code, or the number of attempts. Fix attempt counts in advance: three samples per request class for enumeration, at most three default pairs per account, fewer failed logins than the documented lockout threshold except on a throwaway account the operator agreed to lock, at most twenty failures when no threshold is documented. Never use a password list, a leaked pair or a distributed run.

## Controls
- Positive control: valid credentials for a controlled throwaway account reach the expected page, so a refusal later is attributable to the changed variable.
- Negative control: a known name with a wrong password and an unknown name with a wrong password, three samples each, give the reference messages and timing before any difference is read.
- Reset control: a reset or code issued for the throwaway account arrives in the operator's mailbox, which shows the channel works before token properties are judged.
- Counter control: one valid login between failures shows whether the failure counter resets.

## Expected Observations
A request-class table (message, status, length, redirect, timing class, headers) for enumeration; attempt counts against the threshold with the first signal of a lock; token properties as classes (length, character set, lifetime, single use, binding, effect of a newer token) without values; for each factor path the receipts before and after the factor step; for source review the file and rule that set each policy.

## False-Positive Checks
- Identical messages that still differ in status, length or redirect, and different timing caused by caching or network jitter.
- A source-address limit or captcha mistaken for an account lockout.
- A documented default that is disabled, expired or forced to change at first login.
- A registration that must report a taken name by design, with rate limiting in place.
- A remember-me token that is random, revocable on the server and tied to a device.
- A recovery step that is only an extra factor beside a stronger one.

## Stop Conditions
- Stop if an account or mailbox is not controlled for the assessment; never test names of real users or send mail to addresses the operator does not control.
- Stop at the first unexpected lock signal on an account that was not meant to be locked, and at the counts fixed in advance.
- Stop before password lists, credential stuffing, spraying, bulk registration or push-notification flooding.
- Stop after one confirming login with a found credential; do not browse with it.

## Evidence Fields
- Request class, counts and the receipt: status, length class, redirect target and timing class.
- Stated policy and its provenance: contract, boundary invariant, or inferred.
- Attempts made against the threshold and the first lock signal.
- Token or code properties as classes, the mailbox timestamp and the issuing request.
- Factor path tested and whether the second factor was required on it.
- Coverage state and the reason for any card not run.

## Gaps
SMS and voice channels, hardware tokens, push approval, mobile applications, delegated single sign-on, captcha services and human support procedures stay unverified. Timing channels need many samples and a quiet network, so a single run does not rule them out. A clean result covers only the throwaway accounts, the counted attempts and the paths tested.

## Handoffs
Provide the policy statement, the request-class tables, the attempt counts and the token classes. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web session management](../web-session-management/SKILL.md) for the session after login, [authorization auditing](../authorization-auditing/SKILL.md) for provisioning and role questions, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the identity management and authentication guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
