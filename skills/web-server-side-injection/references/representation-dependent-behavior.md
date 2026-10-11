Tests: wstg-injt-13

# Format string injection

Card for [web server-side injection](../SKILL.md). It asks whether a value is passed as the format-string argument of a formatting or logging call rather than as one of its substituted arguments; this is a narrow structural question, not a memory-safety assessment (route confirmed byte-level consequences to memory-safety-auditing).

### wstg-injt-13 Format string injection
- Trigger: source shows a value reaches a formatting or logging call where it could occupy the template-string position instead of a substituted-argument position, in a language whose formatting functions give conversion meaning to specific characters in that position.
- Inputs: the call site in source (S); the baseline request (H) when a live path exists.
- Steps: in source, confirm which argument position the value fills. If it fills the template position, that alone is the finding; a value filling a substituted-argument position is not in scope for this card regardless of its content. When a live path exists and the position is uncertain from source alone, pair an inert value with one marker containing a single harmless conversion character the language's formatting function documents as display-only (such as one that would echo a literal percent sign or brace), and compare whether the output shows the literal marker or a conversion artifact.
- Conclude: confirmed when source places the value in the template position, or when the live comparison shows a conversion artifact that the inert control does not produce. Whether this leads beyond a display artifact to memory disclosure or a crash is a separate question for memory-safety-auditing and stays an open_proof_gap here.
- Evidence: the source location and argument position; the two requests and receipts when a live path was used.
- Record: cell for wstg-injt-13.
- Stop: use only a single documented display-only conversion character; never a repeated or width-specifying sequence, and never pursue a crash or memory read.
- Not a finding when: source confirms the value only ever fills a substituted-argument position.
