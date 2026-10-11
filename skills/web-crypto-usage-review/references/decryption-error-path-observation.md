Tests: wstg-cryp-02

# Decryption error-path observation

Card for [web crypto usage review](../SKILL.md). It asks only whether the application's own response distinguishes a structurally invalid decrypted value from a validly structured one, which is a prerequisite condition for a deeper attack this card does not perform.

### wstg-cryp-02 Distinguishable decryption failure
- Trigger: source shows the application decrypts a value the client holds and could alter, using a block-cipher mode that pads the plaintext.
- Inputs: a value the controlled principal legitimately holds (A); the decryption and error-handling code (S).
- Steps: in source, confirm whether the decrypted value's integrity is checked by an authenticated mode or a separate signature before its padding is removed, and whether the error path the application takes on an invalid value is distinguishable (a different message, status or response time) from the path for a validly padded but otherwise meaningless value. If a live comparison is appropriate, resend the baseline value once unchanged and once with a single byte altered, and compare the two responses only for whether they are distinguishable, not for what either reveals about the key.
- Conclude: confirmed as a structural finding when source shows no integrity check before padding removal and the two live responses are distinguishable. Demonstrating that this distinguishability is enough to actually decrypt or forge content, which needs many repeated requests, is a separate, harder question that stays an open_proof_gap here.
- Evidence: the source location of the integrity check (or its absence) and the padding-removal path; the two requests and receipts when a live comparison was used.
- Record: cell for wstg-cryp-02; `execution: blocked` with the missing authorization named if a live comparison beyond this single pair is not approved.
- Stop: at most one altered-byte comparison per decryption site; never repeat the comparison enough times to actually recover or forge content, and never target another principal's value.
- Not a finding when: source confirms an authenticated mode or a separate signature check runs before padding removal, or the two live responses are indistinguishable.
