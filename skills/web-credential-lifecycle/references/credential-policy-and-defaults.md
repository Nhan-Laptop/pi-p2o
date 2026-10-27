Tests: wstg-athn-02, wstg-athn-07

# Credential policy and defaults

Cards for [web credential lifecycle](../SKILL.md). Counts are recorded so each receipt is reproducible; resistance to guessing is judged from the policy, the lockout evidence and any list actually run.

### wstg-athn-02 Default credentials
- Trigger: a login on an identified product or device, or an application that generates initial passwords.
- Inputs: product and version from the fingerprint card, the vendor's documentation of built-in accounts, the account-creation flow (H, A).
- Steps: for the identified product read the documented built-in accounts and initial passwords and try each documented pair, three times per account in the first pass. For applications that issue initial passwords, create a few throwaway accounts together and compare the generated passwords for patterns. Use organization-specific patterns, a wordlist or a leaked list where the question needs them. In source, search for seeded accounts and fixed passwords.
- Conclude: a working documented default, a seeded fixed password or a predictable generated one is a finding. A refused default is recorded as tested, with the count and date.
- Evidence: the documentation source for each pair (not the pair itself), attempt counts and statuses, the source file of any seed.
- Record: cell for wstg-athn-02; the account as an asset of kind identity.
- Stop (M2): three attempts per account is the first pass; continue with a list on a fresh account after a lock, and after a confirming login use the credential to establish what it reaches.
- Not a finding when: the account is disabled, or the application forces a change at first login.

### wstg-athn-07 Password rules and resistance
- Trigger: password login or a password change form.
- Inputs: the documented policy and a throwaway account (A).
- Steps: record the allowed and forbidden characters, length limits, complexity, history and change-rate rules. On the throwaway account try a small fixed set of changes: too short, one character class, the username, the previous password, a very long value, edge characters. Send the same changes without the browser-side check to see whether the server enforces them. In source, read the rule and the storage settings.
- Conclude: report when the server accepts what the stated policy forbids, or when the policy allows trivially guessable passwords without compensating controls such as lockout or throttling.
- Evidence: a table of accepted and rejected inputs with status and message class.
- Record: cell for wstg-athn-07 with a policy key such as policy:password-strength.
- Stop (M1): the throwaway account first; continue the series on a fresh account after a lock signal.
- Not a finding when: the control lives in a documented identity provider.
