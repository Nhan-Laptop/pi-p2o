Tests: wstg-injt-05, wstg-injt-06

# Query languages: SQL/NoSQL injection and LDAP injection

Cards for [web server-side injection](../SKILL.md). Both ask the same question of a different interpreter (a SQL or NoSQL database query, or an LDAP directory filter): does a value change the structure of a query instead of staying inside a single compared field?

### wstg-injt-05 SQL and NoSQL injection
- Trigger: a parameter's value feeds a lookup, filter or authentication check against a SQL or NoSQL data store, directly or through an object-relational mapping (ORM) layer.
- Inputs: the baseline request for that parameter (H); the query-building code (S).
- Steps: pair a syntactically inert value with one boundary-class marker that would close or extend a quoted or delimited segment of the query if the value were inserted unparsed (a single quote or equivalent delimiter the target's query language uses), and send both. Compare status, length and the application's own error text. If the two are indistinguishable, try a second marker that shifts a numeric or boolean comparison instead of a string boundary, still paired with an inert control. In source, confirm whether the query is built with a parameterized API (prepared statement, query builder) or with string concatenation, and whether an ORM's safe interface was bypassed with a raw query.
- Conclude: confirmed when the marker and its inert control produce a reproducible, attributable difference (a database-specific error, a result-shape change, or a stable timing shift under the timing control) and source, when available, shows unparameterized assembly. A uniform rejection or a generic error for both the marker and unrelated malformed input is not evidence.
- Evidence: the two requests, their receipts, and the source line of the query construction when available.
- Record: cell for wstg-injt-05 on the parameter's route asset.
- Stop: no multi-step escalation, no value that would modify or return data; one structural difference is enough to confirm and move on.
- Not a finding when: source confirms a parameterized path, or the backend rejects the marker identically to any malformed input.

### wstg-injt-06 LDAP injection
- Trigger: a parameter's value feeds a lookup or filter sent to an LDAP directory service, directly or through an authentication check against it.
- Inputs: the baseline request (H); the filter-building code (S).
- Steps: pair an inert value with one boundary-class marker that would unbalance an LDAP filter's parenthesized grouping if inserted unparsed, and compare the result set size or the authentication outcome against the baseline. In source, confirm whether filter components are escaped (LDAP-reserved characters such as the filter's special characters) before assembly.
- Conclude: confirmed when the marker changes the result set or authentication outcome in a way the inert control does not, and source, when available, shows unescaped assembly.
- Evidence: the two requests and receipts; the escaping function's source line when available.
- Record: cell for wstg-injt-06.
- Stop: enumerate directory contents only as far as the chain needs to show what the injected structure reaches; the listing is not the goal, the next reachable effect is.
- Not a finding when: the result is identical for both values, or escaping is confirmed in source.
