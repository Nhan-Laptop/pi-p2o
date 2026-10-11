Tests: wstg-clnt-04, wstg-clnt-05, wstg-clnt-06, wstg-clnt-15

# Client-side navigation and resource sinks

Cards for [web browser trust controls](../SKILL.md), the client-side counterparts of [web server-side injection](../../web-server-side-injection/SKILL.md). All three ask whether client-side script reads an untrusted value straight into a sink that chooses where the browser navigates, what style applies, or what resource loads, without constraining it to a safe set of destinations first. Evidence stops at the source trace; demonstrating what a browser would then do with it needs a browser oracle this library does not provide.

### wstg-clnt-04 Client-side navigation target
- Trigger: source shows client-side script reads a value from the URL, a message, or another client-controlled source and assigns it to something that changes the page's location or opens a new one.
- Inputs: the script source (S); the page loaded with a harmless marker in the suspected source, observed without a live browser transport when one is not separately authorized (offline rendering only).
- Steps: trace the value from its source to the navigation sink and read whether it is checked against an allow-list of the application's own destinations, a same-origin check, or a recognized safe scheme, before being used. Where a local, non-interactive render is available, confirm the value reaches the sink unchanged with a harmless marker; this is `offline_reproduction`, not proof of what a real browser does when a user actually follows it.
- Conclude: confirmed as a structural finding when the value reaches the navigation sink with no destination check, cited to the source line. A check against the application's own destinations or a recognized safe scheme rules this out.
- Evidence: the source trace from entry to sink; the local render result when used, labeled with its proof level.
- Record: cell for wstg-clnt-04 with proof level `static_trace` or `offline_reproduction`, never higher without a separately authorized browser transport.
- Stop: use only a harmless marker that stays inert if followed; never a destination that would itself be reachable or harmful if a renderer actually navigated to it.
- Not a finding when: source confirms a destination allow-list or same-origin check before the sink.

### wstg-clnt-05 Style value sink
- Trigger: source shows a client-controlled value is assigned to a style property or inserted into a style rule.
- Inputs: the script source (S); a local render with a harmless marker, when available (offline only).
- Steps: trace the value from its source to the style sink and read whether it is constrained to a safe set of property names and value shapes before assignment, or whether it can set an arbitrary property or value. Where a local render is available, confirm the marker reaches the sink unchanged.
- Conclude: confirmed as a structural finding when an arbitrary property or value can reach the sink, cited to the source line.
- Evidence: the source trace; the local render result when used, labeled with its proof level.
- Record: cell for wstg-clnt-05 with proof level `static_trace` or `offline_reproduction`.
- Stop: use only a harmless marker; never a value crafted to exfiltrate data through a real rendering engine, which this card cannot observe anyway without a browser oracle.
- Not a finding when: source confirms the value is constrained to a safe property and value set.

### wstg-clnt-06 Client-side resource reference sink
- Trigger: source shows a client-controlled value selects the source address of a resource the page loads (an embedded frame, a script, an image, a background request initiated by client code).
- Inputs: the script source (S); a local render with a harmless marker, when available (offline only).
- Steps: trace the value from its source to the resource-reference sink and read whether it is checked against an allow-list of expected hosts or paths before being used. Where a local render is available, confirm the marker reaches the sink unchanged.
- Conclude: confirmed as a structural finding when no host or path check exists before the sink, cited to the source line.
- Evidence: the source trace; the local render result when used, labeled with its proof level.
- Record: cell for wstg-clnt-06 with proof level `static_trace` or `offline_reproduction`.
- Stop: use only a reference to a destination you own or a harmless marker; never one aimed at a third party.
- Not a finding when: source confirms a host or path allow-list before the sink.

### wstg-clnt-15 Client-side template evaluation
- Trigger: source shows client-side script renders a value through a client-side template engine (one that evaluates expressions inside the rendered text, not just substitutes plain variables).
- Inputs: the template-rendering source (S); a local render with a harmless marker, when available (offline only).
- Steps: trace the value from its source to the point where it enters the template engine and read whether it is rendered as plain text (escaped, no expression evaluation) or as template source that the engine parses for expressions. Where a local render is available, confirm whether a harmless, self-contained expression marker is evaluated or shown as literal text.
- Conclude: confirmed as a structural finding when the value is parsed as template source rather than rendered as plain text, cited to the source line, and the local render (when used) shows the marker evaluated rather than literal.
- Evidence: the source trace; the local render result when used, labeled with its proof level.
- Record: cell for wstg-clnt-15 with proof level `static_trace` or `offline_reproduction`.
- Stop: use only a marker whose evaluated result is recognizable and harmless; never pursue script execution beyond confirming the expression was evaluated.
- Not a finding when: the value is always rendered as plain text, never parsed as template source.
