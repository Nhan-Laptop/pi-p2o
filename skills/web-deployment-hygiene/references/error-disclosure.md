Tests: wstg-errh-01

# Error disclosure

Card for [web deployment hygiene](../SKILL.md). It compares the error output of the stack against the stock error of its web server.

### wstg-errh-01 Error output
- Trigger: any HTTP target.
- Inputs: the baseline set and a few controlled malformed requests; the handlers for unhandled errors in a supplied tree (S).
- Steps: cause a small fixed set of errors: an unregistered path, a disallowed method, a malformed query value, a type mismatch in one parameter, a modest over-long value and an invalid body for the declared content type. Compare each response with the stock server error and with the application's own error shape, and note stack traces, file paths, query text, framework names and internal host names. In source read how unhandled errors are rendered and how verbose the configuration is.
- Conclude: error output that exposes code locations, queries, secrets or internal topology is a finding. Consistent generic output across the whole set rules the disclosure out for that set only.
- Evidence: receipt per error and the disclosed element, redacted.
- Record: cell for wstg-errh-01, with the boundary invariant that errors do not expose internals to clients.
- Stop: ten requests is the first sample; fuzzing and requests that can crash the service are valid next steps, with their receipts.
- Not a finding when: verbose output appears only for a debug header the application exposes to a client.
