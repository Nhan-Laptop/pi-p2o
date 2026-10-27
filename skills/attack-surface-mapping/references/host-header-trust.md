Tests: wstg-injt-17

# Host header trust

Read with [attack surface mapping](../SKILL.md); it extends [intermediary trust](intermediary-trust.md) to one specific metadata field: the virtual-host selector a client supplies in the Host header, and the forwarded-host headers an intermediary adds.

Trigger: more than one virtual host answers on the reachable target, or source shows the application reading the Host header (or a forwarded-host header) to build a link, pick a tenant, or make a routing or cache-key decision, rather than using it only to select the listening virtual host.

Steps: send one well-formed request with the usual Host value and record every place its value resurfaces: a generated absolute link, a password-reset or similar token link, a cache key, a tenant or locale selection, a security check that compares it against an allow list. Then send one request where only the Host header (or, separately, only a forwarded-host header if the application is documented to read one) carries a different value naming a host you control or any host the sandbox can reach, and compare the same observables. If a reverse proxy or CDN sits in front of the origin, run the comparison once through it and once, if reachable, directly against the origin, since the two may validate the header differently.

Conclude: confirmed when a value taken from the Host or a forwarded-host header reaches a sensitive sink (a link a user could later follow, a cache key shared across requesters, a routing or tenant decision) without being checked against an allow list of the application's own hosts, and the effect is observed in the actual response or a receipted side effect, not inferred from the header being read. A value that is logged but never reaches a sink is an observation, not a finding.

Evidence: the two requests compared, the sink each affected, and whether an allow-list check ran before the value was used.

Record: cell for wstg-injt-17 on the affected sink's asset; `methodFamily` `public-http-review`.

Stop: use a host value you control or any host the sandbox can reach; a generated link that points outside the supplied target is the evidence, and a shared cache is observable by requesting it twice as two identities you hold.

Not a finding when: the value is validated against a server-side allow list before any sink uses it, or the only effect is a routing decision made before the application ever sees the header.
