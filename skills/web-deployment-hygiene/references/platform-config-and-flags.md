Tests: wstg-conf-02, wstg-conf-09, wstg-conf-15

# Platform configuration and flags

Cards for [web deployment hygiene](../SKILL.md). Configuration files are read-only evidence here; a live effect on the platform is confirmed through the origin, not by editing the supplied tree.

### wstg-conf-02 Platform configuration
- Trigger: configuration in the supplied tree, or an identified platform on the origin.
- Inputs: server, framework, container and serverless configuration (S); the baseline responses (H).
- Steps: in source check that debug or development mode is off, sample and scaffold files are absent, default accounts and example applications are removed, unused modules are not loaded, the framework's production settings are set, and logs avoid secrets and personal data. On the origin look for visible effects: stack traces, debug toolbars, default pages and verbose errors.
- Conclude: the declared setting is the source of a finding; on the origin a visible effect is evidence of the setting. Use a boundary invariant for debug mode in production.
- Evidence: file and key of each setting, and the receipt of any visible effect.
- Record: cell for wstg-conf-02 per configuration unit; a config asset per file with the setting as a configuration fact.
- Stop: read first; a request that tries to trigger the debug feature is a valid next step, recorded with its receipt.
- Not a finding when: the setting belongs to a development profile that the deployment never selects.

### wstg-conf-09 File and secret permissions
- Trigger: container or deployment manifests, or listings with modes, in the supplied tree.
- Inputs: build instructions, manifests and listings (S). The permissions of the live host are reached through the sandbox shell when the deployment is reachable.
- Steps: look for world-writable or world-readable modes on configuration, keys and data directories; containers that run as root, keep a writable root filesystem or mount secrets with broad modes; manifests without the user, group and read-only settings the platform offers; secrets kept in images, environment files or build artifacts instead of a secret store.
- Conclude: a broad mode on a file that holds a secret or that the service executes is a finding; a mode at the platform's documented minimum is not.
- Evidence: path, mode, owner and the instruction or manifest field that sets it.
- Record: cell for wstg-conf-09 from source review, or from a live permission read when the deployment is reachable; asset kind config or file.
- Stop: a secret value is read where the permission question needs its reach; record where it lives and what it opens, and redact the value itself in notes.
- Not a finding when: a copied snapshot lost its original modes; a conclusion drawn from that snapshot alone is a gap.

### wstg-conf-15 Feature flags
- Trigger: bundles or configuration that mention flags, toggles or kill-switches for security behavior.
- Inputs: bundles and flag configuration (S); flag endpoints seen in responses (H).
- Steps: list flags that gate authentication, authorization, rate limits, fraud or risk checks; find where each value is evaluated and whether the server enforces the same rule when a client-held value changes; replay one request with a client-held flag value altered and compare; read what the source does when the flag service is unreachable.
- Conclude: report when changing a client-held value changes server enforcement; a flag that only hides a control is not a control. A fail-open default on a security flag is a candidate, with its source line.
- Evidence: the flag, where it is held, the two receipts compared and the source line of the default.
- Record: cell for wstg-conf-15; the flag as a configuration fact.
- Stop: change client-held values and touch the flag service where the question needs it; record each with its receipt.
- Not a finding when: the server rejects the altered value, or the flag is cosmetic.
