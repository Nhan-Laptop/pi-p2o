# Minimal architecture

```text
/p2o --target …
  parse → classify → one scope confirmation → Docker sandbox
  → pi.sendUserMessage(scoped task)
  → existing Pi session/model
       p2o_shell → docker exec (network none, read-only source)
       p2o_http  → validated same-origin URL → pinned public IPv4 → fixed curl container
       p2o_finish → verified Docker removal → report in the same transcript
```

No nested model calls, agent spawns, supervisor, SQLite, evidence vault, model gateway, plan sealing,
profiles, polling or dashboard. Pi owns conversation, model selection, tool progress and usage accounting.
Only the extension knows Docker ownership; only the human command starts an assessment.

Files:
- `extensions/p2o/index.ts`: command, confirmation, direct task handoff, tool gate and lifecycle cleanup.
- `src/target.ts`: minimal grammar, local directory classification and HTTP scope/address checks.
- `src/sandbox.ts`: resource-limited container ownership, command serialization and verified removal.
- `src/process.ts`: fixed Docker subprocess, bounded output and timeout/cancellation.
- `src/source.ts`: bounded regular-file-only source copying using Linux directory-FD traversal.

The pinned image is a tools distribution, not an AI runtime. It is inspected before execution and never selected
by the model. Local context is captured once and required to use a Unix Docker socket. Source is copied after confirmation (regular files only, no symlinks/special files), then mounted
read-only. Linux directory-FD traversal with no-follow opens prevents symlink races from reading outside the selected root. No host shell executes target/model commands.

Tool-call hooks and execution-time phase checks both enforce the active session. Tools are model-only,
so nested/codemode calls cannot reach them. Non-p2o tools and `!` host shell are blocked while active.
A finish keeps the gate until the final agent settlement to prevent sibling tool calls escaping confinement.
Cancellation, navigation, deadline and shutdown remove owned container names and query the daemon to
verify absence. Removal failure keeps ownership and the gate so `/p2o stop` can retry. History is not authority.

HTTP addresses are revalidated on every request and pinned with curl `--resolve`; proxy use is disabled,
redirects are not followed, and credentials/mutating methods are unavailable. Only the exact origin is in
scope. Reserved/private IPv4 and all IPv6 are rejected in this first version. DNS resolution is host-side
metadata; the HTTP target request itself runs in a fixed-command networking container.

The removed implementation is available in Git history before 0.2. Research skills and their evidence corpus
remain separate from runtime features. Passing tests verifies the tested mechanics, not live vulnerability
finding quality, independent verification or immunity to container escapes.
