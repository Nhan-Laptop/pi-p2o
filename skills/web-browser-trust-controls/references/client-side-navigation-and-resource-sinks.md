Tests: wstg-clnt-04, wstg-clnt-05, wstg-clnt-06, wstg-clnt-15

# Client-side navigation and resource sinks

Cards for [web browser trust controls](../SKILL.md), the client-side counterparts of [web server-side injection](../../web-server-side-injection/SKILL.md). All four ask whether client-side script reads an untrusted value straight into a sink that chooses where the browser navigates, what style applies, or what resource loads, without constraining it to a safe set of destinations first. The source trace names the sink and its constraint; the sandbox image ships Chromium and the `agent-browser` CLI, so a session driven through the sandbox shell shows what a browser does with it, and that is `live_reproduction`.

### wstg-clnt-04 Client-side navigation target
- Trigger: source shows client-side script reads a value from the URL, a message, or another client-controlled source and assigns it to something that changes the page's location or opens a new one.
- Inputs: the script source (S); the page loaded with a marker in the suspected source, observed through the image's Chromium in a named session (or a local render).
- Steps: trace the value from its source to the navigation sink and read whether it is checked against an allow-list of the application's own destinations, a same-origin check, or a safe scheme before use. Confirm the value reaches the sink unchanged, then drive the page through the browser and record whether the navigation follows it; that observation is `live_reproduction`.
- Conclude: confirmed as a structural finding when the value reaches the navigation sink with no destination check, cited to the source line. A check against the application's own destinations or a recognized safe scheme rules this out.
- Evidence: the source trace from entry to sink; the local render when used, with its proof level.
- Record: cell for wstg-clnt-04 with proof level `static_trace`, `offline_reproduction`, or `live_reproduction` when the browser observed it.
- Stop: use a marker and a destination for whatever the question tests; a harmful destination is valid when the question is where the navigation goes, and the browser's reaction is recorded.
- Not a finding when: source confirms a destination allow-list or same-origin check before the sink.

### wstg-clnt-05 Style value sink
- Trigger: source shows a client-controlled value is assigned to a style property or inserted into a style rule.
- Inputs: the script source (S); a local render or an image browser session.
- Steps: trace the value from its source to the style sink and read whether it is constrained to a safe set of property names and value shapes before assignment, or can set an arbitrary property or value. Confirm the marker reaches the sink unchanged, then observe the rendered style through the browser.
- Conclude: confirmed as a structural finding when an arbitrary property or value can reach the sink, cited to the source line.
- Evidence: the source trace; the local render when used, with its proof level.
- Record: cell for wstg-clnt-05 with proof level `static_trace`, `offline_reproduction`, or `live_reproduction` when the browser observed it.
- Stop: use a marker or a crafted value for whatever the question tests; the browser observes the rendered style, so an exfiltration attempt is testable and recorded.
- Not a finding when: source confirms the value is constrained to a safe property and value set.

### wstg-clnt-06 Client-side resource reference sink
- Trigger: source shows a client-controlled value selects the source of a resource the page loads (an embedded frame, a script, an image, or a request client code starts).
- Inputs: the script source (S); a local render or an image browser session.
- Steps: trace the value from its source to the resource-reference sink and read whether it is checked against an allow-list of expected hosts or paths before use. Confirm the marker reaches the sink unchanged, then record which resource the browser loads.
- Conclude: confirmed as a structural finding when no host or path check exists before the sink, cited to the source line.
- Evidence: the source trace; the local render when used, with its proof level.
- Record: cell for wstg-clnt-06 with proof level `static_trace`, `offline_reproduction`, or `live_reproduction` when the browser loaded it.
- Stop: use a reference to a destination you own, a third party or a marker; the browser records what the page loads.
- Not a finding when: source confirms a host or path allow-list before the sink.

### wstg-clnt-15 Client-side template evaluation
- Trigger: source shows client-side script renders a value through a template engine (one that evaluates expressions inside the rendered text, not just substitutes plain variables).
- Inputs: the template-rendering source (S); a local render or an image browser session.
- Steps: trace the value from its source to where it enters the template engine and read whether it is rendered as plain text (escaped, no expression evaluation) or as template source the engine parses for expressions. Confirm whether a self-contained expression marker is evaluated or shown as literal text, then drive the page through the browser.
- Conclude: confirmed as a structural finding when the value is parsed as template source rather than rendered as plain text, cited to the source line, and the local render (when used) shows the marker evaluated rather than literal.
- Evidence: the source trace; the local render when used, with its proof level.
- Record: cell for wstg-clnt-15 with proof level `static_trace`, `offline_reproduction`, or `live_reproduction` when the browser evaluated it.
- Stop: use a marker whose evaluated result is recognizable; pursue script execution beyond the expression evaluation when the chain needs it, through the browser.
- Not a finding when: the value is always rendered as plain text, never parsed as template source.
