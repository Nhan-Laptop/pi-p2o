# Where credentials hide, and what each kind proves

Read this to choose the reachable class and to know what the exposure actually is. The gate is in `SKILL.md`; this page
is the inventory.

| Source | Typical location | What finding it supports |
| --- | --- | --- |
| Application config | `.env`, `config.yaml`, secrets in container env | configuration exposure; usability needs the string, not the key name |
| Framework debug output | stack traces, `/actuator/env`, Django debug pages | information disclosure that includes secrets |
| Log files | request logs with `Authorization`, query strings with tokens | logging of secrets, a long-lived exposure |
| Backups and exports | database dumps, `tar.gz` under the web root | exposure of historical credentials; check expiry |
| Memory disclosure | heap dump, uninitialised buffer, core file | the strongest read effect; proves presence in memory |
| Database rows | user table columns, session tables, API key tables | credential storage practice, hashing, reversibility |
| Browser storage | cookies, `localStorage`, IndexedDB | session exposure; check flags and lifetime |
| Cloud metadata | instance profile credentials | cloud-side effect; scope is the role, not the instance |
| CI and repository | `.git/config` with a token, committed `.pem` | supply-chain exposure; rotation status matters |
| Default and documented | admin/admin in a fixture, README example | only a finding if it works on a deployed system |

## Format before claim

- JWT: decode the header and payload (base64url, no verification needed to read claims), check `iss`, `exp`, `aud`,
  `scope`. A token whose `exp` is in the past is not a usable credential.
- Cloud keys: check the access key ID shape and whether the secret is a template placeholder (`xxxx`, `CHANGEME`).
- Passwords: a hash is not a password. State whether it is a hash, and whether the system accepts pass-the-hash.
- API keys: prefix and length identify the vendor; usability is decided by the vendor's own introspection call.

## What each class proves in a report

| Class | Honest claim |
| --- | --- |
| Secret readable by an unauthenticated user | exposure of a credential; usability is a separate, verified step |
| Secret readable by a low-privileged user | privilege boundary violation in storage |
| Credential verified, no useful privilege | authentication without authorization |
| Credential verified with privilege, operations the map allows | access at that privilege, on the systems it reaches |
| Credential verified and pivoted through every door the map opens | the privilege's reach, with each system and operation recorded |

## Redaction

Quote a prefix of four characters plus a hash, or the location plus the length. Never the value. If a payload store
would keep the secret verbatim, do not create the payload: reference the path and let the lead decide.
