Tests: wstg-idnt-02, wstg-idnt-03, wstg-idnt-04

# Account creation and enumeration

Cards for [web credential lifecycle](../SKILL.md). They cover how an identity comes into existence and whether the application reveals which identities exist. Accounts created here are self-registered throwaways; a mailbox you can read in the sandbox, or the target's own delivery flow, is enough to complete registration and recovery.

### wstg-idnt-02 Registration
- Trigger: a registration feature.
- Inputs: the registration route, a mailbox you can read, the stated identity requirement (S, H, A).
- Steps: record who may register, what proves identity (nothing, mailbox access, human vetting), whether one person can register again under name variations (case, dots, plus tags), whether the form or request lets the registrant choose a role or permission, and whether a pending account can already act. Register throwaway accounts, one per variation, as many as the question needs. In source, trace the code that grants the initial role.
- Conclude: report when the proof achieved is weaker than the stated requirement, a role can be chosen by the registrant, or a duplicate identity is accepted against the policy. Without a stated requirement the result is an open_proof_gap.
- Evidence: receipts of the registration and confirmation steps, the role granted and the policy statement.
- Record: cell for wstg-idnt-02 with a policy key such as policy:registration-identity-proof.
- Stop (M2): register the accounts the question needs and record each; bulk registration is valid where resistance to it is the question.
- Not a finding when: the product is open self-service by design and says so.

### wstg-idnt-03 Account provisioning
- Trigger: administrative or delegated account creation or removal.
- Inputs: two controlled accounts of different roles (A), or the provisioning code (S).
- Steps: list which roles can create or remove accounts and of which type. From the lower-privileged controlled account try to create an account of the same and of a higher role through the normal route. Check what vetting a removal needs. Compare what a creator can grant with what the creator holds.
- Conclude: a role that provisions above its own level, or provisioning without the required authorization, is a finding and an authorization candidate.
- Evidence: receipts of each attempt and the role matrix.
- Record: cell for wstg-idnt-03; the matrix as facts; hand case candidates to authorization auditing.
- Stop (M2): created accounts are throwaway and removed through the same route afterwards when it exists.
- Not a finding when: the escalation is documented administrator delegation.

### wstg-idnt-04 Account enumeration
- Trigger: login, registration or recovery.
- Inputs: one known identifier and one that is certainly unknown (H).
- Steps: for login (with a wrong password), registration and recovery send the known and the unknown identifier three times each and compare message text, status, body length, redirect target, headers and a coarse timing class. Look at URL parameters and page titles that encode the outcome. Compare the username policy for predictable structure such as sequences or personal names.
- Conclude: report when any observable separates the two classes reproducibly, and name the channel. Claim a timing channel only when the medians of the repeated samples separate clearly.
- Evidence: the comparison table by request class.
- Record: cell for wstg-idnt-04 on each feature; the channel as the limitation.
- Stop (M0): nine requests per feature is the first sample; test real user names, bulk lists or enumeration sweeps when the question needs them, recording each attempt.
- Not a finding when: the product must tell a registrant that a name is taken, and rate limiting is in place.
