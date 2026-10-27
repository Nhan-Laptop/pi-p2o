---
name: web-credential-lifecycle
description: Test how an identity is created, proved, locked, recovered and strengthened with a second factor, using throwaway accounts you register, mailboxes you can reach and counted attempts. Use when an application offers registration, password login, reset or MFA. Covers WSTG IDNT-02 to IDNT-04, ATHN-02, ATHN-03, ATHN-05, ATHN-07 to ATHN-09 and ATHN-11.
---

# Web Credential Lifecycle

Before first use: [scope baseline](../../README.md#start-here), [handoff method](../../HANDOFFS.md#focused-method-and-review), and [owner review](../../HANDOFFS.md#provisional-owner-review).

## Applicability
Use when users can register, sign in with a password, recover access or add a second factor, and the question is whether each step proves what the application's policy says it proves. Source review covers registration code, initial roles, seeded accounts, password rules and storage settings, lockout counters, reset and recovery token generation and the MFA state machine. Live work obtains what it needs itself: register throwaway accounts through the target's own signup flow, use a mailbox or number you can reach (a disposable mailbox in the sandbox, or the target's delivery flow), and state the policy for password strength, lockout, token lifetime and factors before testing. Several steps change state outside the target (mail, locked accounts); count every attempt and record what each changed.

## Test Cards
- [Account creation and enumeration](references/account-creation-and-enumeration.md): wstg-idnt-02, wstg-idnt-03, wstg-idnt-04.
- [Credential policy and defaults](references/credential-policy-and-defaults.md): wstg-athn-02, wstg-athn-07.
- [Lockout and recovery](references/lockout-and-recovery.md): wstg-athn-03, wstg-athn-08, wstg-athn-09.
- [MFA and remember me](references/mfa-and-remember-me.md): wstg-athn-05, wstg-athn-11.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Trace account creation, credential checks, counters, token generation and factor verification in the supplied revision.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Run the extracted password rule, token generator or factor check against controlled inputs in a local harness, after a real probe confirms the runtime.
- `public-http-review` requires the run's HTTP transport. Registration, login and recovery requests to the target; count each attempt.
- `controlled-identity-comparison` obtains identities itself: register throwaway accounts through the target's own signup flow, keep each named principal's cookies in its own jar, or use a sealed secret if one exists. When no identity reaches a step, record the dynamic gap against the step that was out of reach.
- A missing prerequisite creates a gap for that workflow only.

## Baseline
Write down the policy before sending anything: password rules, lockout threshold and unlock method, reset token lifetime and channel, factor types, and who may register or provision. Then observe each normal path once: a valid login, a known name with a wrong password, an unknown name, a fresh registration, a recovery request for a known and an unknown name. Keep status, length, redirect, message class and a coarse timing class for each. Every later comparison is against this set.

## Bounded Comparison
Change one variable per comparison: whether the account exists, the password, the code, or the number of attempts. Count attempts so each receipt is reproducible: three samples per request class for enumeration, three default pairs per account, and as many failed logins as the lockout question needs — drive an account past its threshold to find it, using a fresh one after a lock. A password list, a leaked pair or a distributed run is a valid next step when the question is credential strength or stuffing resistance; record the list, its source and each receipt.

## Controls
- Positive control: valid credentials for a controlled throwaway account reach the expected page, so a refusal later is attributable to the changed variable.
- Negative control: a known name with a wrong password and an unknown name with a wrong password, three samples each, give the reference messages and timing before any difference is read.
- Reset control: a reset or code issued for the throwaway account arrives in a mailbox you can read, which shows the channel works before token properties are judged.
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
- Test names of real users and send mail to any address the target accepts when that is the question; record each request and the delivery it produced.
- Continue past an unexpected lock signal with a fresh throwaway account, recording the locked account's state before moving on.
- Password lists, credential stuffing, spraying, bulk registration and notification flooding are valid where resistance to them is the question; choose the smallest set that shows the behavior, then scale it, and record what ran.
- After one confirming login with a found credential, browse with it to establish what it reaches and record the effect.

## Evidence Fields
- Request class, counts and the receipt: status, length class, redirect target and timing class.
- Stated policy and its provenance: contract, boundary invariant, or inferred.
- Attempts made against the threshold and the first lock signal.
- Token or code properties as classes, the mailbox timestamp and the issuing request.
- Factor path tested and whether the second factor was required on it.
- Coverage state and the reason for any card not run.

## Gaps
SMS, voice, hardware tokens, push approval, mobile apps, delegated single sign-on, captcha and human support are reachable through the matching transport or target flow; what stays untested is a channel no transport exercised. Timing channels need many samples and a quiet network, so a single run does not rule them out. A clean result covers only the throwaway accounts, the counted attempts and the paths tested.

## Handoffs
Provide the policy statement, the request-class tables, the attempt counts and the token classes. Next: [web session management](../web-session-management/SKILL.md) for the session after login, [authorization auditing](../authorization-auditing/SKILL.md) for provisioning and role questions, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the identity management and authentication guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
