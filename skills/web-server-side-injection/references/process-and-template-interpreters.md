Tests: wstg-injt-08, wstg-injt-11, wstg-injt-12

# Process and template interpreters: SSI injection, code injection and OS command injection

Cards for [web server-side injection](../SKILL.md). All three ask whether a value reaches an interpreter that treats part of its input as instructions rather than data: a Server-Side Includes (SSI) pre-processor, a dynamically evaluated code or template expression, or the operating-system command launcher. Evidence here stops at an observable, harmless side effect; never at running an attacker-chosen command or program.

### wstg-injt-08 SSI injection
- Trigger: source shows served content is assembled by a Server-Side Includes (SSI) pre-processing step that can interpret embedded directives, and a value reaches that content before it is served.
- Inputs: the baseline request (H); the pre-processor configuration and the templates it reads (S).
- Steps: in source, confirm whether the pre-processor is enabled for the paths the value reaches and whether directive syntax in user input is escaped before being written into processed content. Live, pair an inert value with one marker that uses the pre-processor's own directive-opening syntax (read from its documentation, not guessed) and compare the rendered output's structure, not its content, against the baseline.
- Conclude: confirmed when the rendered output shows the directive was interpreted (a structural change attributable to the marker) rather than echoed as literal text, and the inert control is echoed unchanged. A pre-processor disabled for the reached path, confirmed in source, rules this out.
- Evidence: the two requests and receipts; the configuration line when available.
- Record: cell for wstg-injt-08.
- Stop: use only a directive that reveals interpretation through output structure, never one that invokes a program or reads a file; one confirmed instance is enough.
- Not a finding when: the pre-processor is not enabled for the reached path, or output escaping is confirmed in source.

### wstg-injt-11 Code injection
- Trigger: source shows a value reaches a language construct that evaluates a string as code or as a server-side template expression (code injection, including server-side template injection), rather than treating it as a literal.
- Inputs: the evaluation site in source (S); the baseline request (H) when a live path exists.
- Steps: in source, confirm the exact construct and whether the value is sanitized, type-constrained or allow-listed before reaching it. If a live path exists, pair an inert value with one marker that is a harmless, self-contained expression recognizable only by its evaluated result (for example an arithmetic expression whose result differs from its literal text) and compare the rendered output.
- Conclude: confirmed when the evaluated result appears in the output rather than the literal marker text, attributable to the construct identified in source. Treat this as a structural-influence finding; whether it extends to running an arbitrary program is a separate, harder question that belongs to exploitability-assessment and stays an open_proof_gap here.
- Evidence: the source location of the construct; the two requests and receipts when a live path was used.
- Record: cell for wstg-injt-11.
- Stop: the expression used must have no effect beyond producing a recognizable, self-contained result; never one that reads, writes, deletes or launches anything.
- Not a finding when: source shows the value is constrained to a type or allow-list before reaching the construct.

### wstg-injt-12 OS command injection
- Trigger: source shows a value reaches a call that launches an external operating-system process, as an argument, an environment value, or part of a constructed command line.
- Inputs: the launch site in source (S); the baseline request (H) when a live path exists.
- Steps: in source, confirm whether the call uses a fixed program path with an argument array (safer) or builds a single string that a shell re-interprets (riskier), and whether the value is validated against an allow-list of expected forms. If a live path exists, pair an inert value with one marker that is a harmless argument-boundary character (recognized by the launcher's own documented argument-separation rules, not a specific command) and compare only whether the launched process's argument count or exit status changed, never its output content.
- Conclude: confirmed when the argument-boundary marker changes the process's observable argument handling in a way the inert control does not, attributable to the construction method identified in source. Confirming that an attacker-chosen program or command actually runs is a separate, harder question for exploitability-assessment and stays an open_proof_gap here.
- Evidence: the source location and construction method; the two requests and receipts when a live path was used, limited to exit status and argument count.
- Record: cell for wstg-injt-12.
- Stop: never launch, name or reference a specific external program or command in a request; the marker tests argument boundaries only, and any live test must run inside the sandbox scratch of this task's own executor, never against a shared or production resource.
- Not a finding when: source confirms a fixed program with an argument array and an allow-list check, or no live path exists to observe a difference.
