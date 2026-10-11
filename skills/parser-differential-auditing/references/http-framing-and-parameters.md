Tests: wstg-injt-04, wstg-injt-15

# Repeated parameters and response header injection

Read with [parser differential auditing](../SKILL.md). Both cards compare how two layers read the same request or build the same response; neither needs a payload beyond a harmless marker, and neither tries to desynchronize a shared connection.

## wstg-injt-04 Repeated parameter handling

Trigger: a request can carry the same parameter name more than once, in the query string, a form body, or across the query and the body together.

Steps: send one request with a parameter name repeated twice, holding two distinct marker values, once in the query string and once in the body if both exist. Observe which value the application actually used for each role the parameter plays (validation, routing, logging, a downstream call). If a reverse proxy, load balancer or web application firewall sits in front of the application, send the same pair through it and compare its choice with the origin's choice; a difference between the two layers is the finding, not either choice alone. Repeat with an empty duplicate and with the pair in reversed order to see whether position, not name, decides.

Conclude: confirmed when the two layers (edge and origin, or two components, such as a validating gateway and the handler that acts on the value) resolve the same repeated name to different values, and that difference lets a value bypass a check performed by the other layer. A single component that consistently picks one value (first, last, or concatenated) and is read consistently by every consumer is not a finding by itself.

Evidence: the request sent, the value each component or log line shows it used, and which role of the parameter each choice affected.

Record: cell for wstg-injt-04; `methodFamily` `public-http-review`; the resolution rule as an observed fact per component.

Stop: one well-formed request per candidate parameter; no large repeat counts and no attempt to exhaust a parser's limits.

Not a finding when: only one component ever reads the parameter, or every component is confirmed to apply the same resolution rule.

## wstg-injt-15 Reflected header values

Trigger: a value you control (a parameter, a path segment, a cookie) is placed into a response header, most often a redirect target, a content-disposition filename, or an echoed custom header.

Steps: identify which response header carries the controlled value and submit a value containing a line-break character pair as a harmless marker (for example a value ending in a recognizable token after an embedded CR and LF). Compare the raw response: does the marker stay inside the single header's value, or does it start a new header line or an early body? Test this once directly against the origin and, if the service sits behind a proxy or CDN, once through it, since the two layers may encode or reject the sequence differently.

Conclude: confirmed only when the raw response shows a second header line or the start of a body that the application did not intend to send, attributable to the submitted value, with a receipt of the exact bytes returned. A value that comes back unchanged inside its original header, or one that the server rejects outright, rules this out for that sink.

Evidence: the request, the exact response bytes around the reflected header, and whether the test ran against the origin or through an intermediary.

Record: cell for wstg-injt-15; `methodFamily` `public-http-review`; the sink (which header, which source) as the limitation when ruled out.

Stop: one marker per sink; never escalate to a payload aimed at a specific client or cache; stop at the first confirmed line break and record it rather than exploring further effects.

Not a finding when: the framework's HTTP library rejects control characters in header values before the application code runs, which you can confirm by trying the same marker against the library's known-safe header-setting call in source.
