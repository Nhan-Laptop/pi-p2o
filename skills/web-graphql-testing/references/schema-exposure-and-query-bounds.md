Tests: wstg-apit-99

# Schema exposure and query bounds

Card for [web GraphQL testing](../SKILL.md). It groups four small, independent checks about the query layer itself, none of which needs more than a few bounded requests.

### wstg-apit-99 GraphQL configuration surface
- Trigger: an endpoint accepts GraphQL queries.
- Inputs: the baseline minimal query (H); the server's schema and bound configuration (S).
- Steps: (1) send a standard introspection query and record whether the schema, including fields not referenced by the application's own known interface, is returned; (2) request the standard paths of common development or exploration interfaces for this GraphQL server and record whether any responds without its own authentication; (3) send a query nested one level deeper than any documented or default depth limit and record whether it is rejected before the depth bound; (4) send a batch of operations a handful more than any documented limit, and a query with slightly more aliased repetitions of one field than default, and record whether either is accepted. In source, read the configuration for introspection, the development interface, and depth/complexity/batch limits.
- Conclude: report introspection returning fields beyond the application's own known interface on a non-development deployment; a development interface reachable without its own authentication; and a depth, batch or alias check accepted past its documented or default limit. Each is independent; report only the ones actually observed or confirmed in source.
- Evidence: the introspection response's field list (names only); the development-interface probe's receipt; each bound check's query and receipt, with the margin used.
- Record: cell for wstg-apit-99.
- Stop: use the smallest margin needed to show a bound is missing; never a query sized to actually exhaust server resources, and never continue past confirming reachability of a development interface.
- Not a finding when: introspection is disabled or limited to the application's own known interface, no development interface responds without authentication, and every bound check is rejected at or before its limit.
