Tests: wstg-idnt-01, wstg-injt-20, wstg-apit-03

# Roles, field exposure and bulk assignment

Cards for [web object authorization](../SKILL.md). They extend the principal-object matrix to three related questions: what roles exist and how coarse they are, whether a write accepts fields it should not, and whether a response returns fields it should not. All three compare what the policy states against what is observed; none infers policy from naming alone.

### wstg-idnt-01 Role inventory and switching
- Trigger: more than one role, or a visible role or permission selector.
- Inputs: documentation or source naming the roles (S); two controlled principals of different roles (A).
- Steps: list each role and the permissions it is meant to hold, from documentation, a role table in source, or consistent comments. For the lower role, request the actions the higher role performs through the same endpoints the matrix already uses, and note whether a role can be set or implied by request data rather than by the stored principal. Judge granularity: a role bundling unrelated powers together is a design observation, not by itself a finding.
- Conclude: report when a role reaches an action or object outside its documented permissions, or when the active role is taken from client-supplied data instead of the stored principal. A bundled role matching its own documentation is not a finding.
- Evidence: the role table, the source or comment that states it, and the comparison receipts.
- Record: cell for wstg-idnt-01 with `methodFamily` `controlled-identity-comparison`; the role table as facts.
- Stop: only the controlled principals already in use for this task; no new role creation beyond what account provisioning already covers.
- Not a finding when: the broader role is an intended administrative capability stated in the documentation.

### wstg-injt-20 Mass assignment on writes
- Trigger: a write request (create or update) that is built by binding a request body to a stored object.
- Inputs: the object's declared writable fields from source or from a prior read (S, H); a controlled principal for the write (A).
- Steps: take a normal write request and add one field at a time that the object has but the form or documented contract does not expose (an identifier, a role or privilege flag, an ownership or price field, a status flag). Send each addition separately and compare the stored result or the next read against the baseline. In source, find the binding call and whether it allow-lists fields explicitly or binds everything by default.
- Conclude: confirmed when an added field changes stored state outside the documented contract and the policy that should have blocked it is named. A binder that explicitly allow-lists only the intended fields, verified in source, rules this out for that object.
- Evidence: the request sent, the field added, the before and after read, and the source line of the binder when available.
- Record: cell for wstg-injt-20 on the object asset; one cell per field added.
- Stop: fields of your own controlled objects only; never a field that triggers payment, deletion or a send-to-third-party effect without separate approval.
- Not a finding when: the field is accepted but has no effect, or the write is rejected by an explicit allow list.

### wstg-apit-03 Field-level exposure in responses
- Trigger: an API response that is built by serializing a stored object, directly or through a generic endpoint.
- Inputs: the response for a low-privilege and a higher-privilege controlled principal reading the same object (A); the object's declared internal fields (S).
- Steps: request the same object as both principals and diff the field sets, including nested and list responses. Note fields with no UI purpose: hashes, internal identifiers, infrastructure details, other principals' data. Check whether the same filtering is applied to list, search and export variants of the endpoint, and whether an error or debug response repeats the leak. In source, find whether field selection happens on the server or is left to the client.
- Conclude: confirmed when a field outside the object's documented exposure appears in a response to a principal not entitled to it, with the policy named. A field present for every principal equally, including the object's own owner, is in scope only if it should never leave the server at all.
- Evidence: the two response bodies (field names only, values redacted), the endpoint variants compared, and the source line of the serializer when available.
- Record: cell for wstg-apit-03 on the object asset; the exposed field as the observed fact.
- Stop: read-only comparisons; no scraping of other principals' real data, only your own controlled objects.
- Not a finding when: the field is intentionally public, or client-side filtering is backed by an equivalent server-side check that was verified, not assumed.
