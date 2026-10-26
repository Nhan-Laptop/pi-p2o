/**
 * planning_update.md P7.0 (A7.10): the sentences the model is told about its own instrument.
 *
 * Capability text used to be written per surface and drifted from the code: the `p2o_http` description promised per-hop
 * origin scoping the implementation had removed, `p2o_net` said raw sockets were unavailable while the container runs as
 * root with the Docker default capability set (NET_RAW included), the consent and report text claimed more capability than
 * that set grants and a credential channel the host does not provide, and the report claimed the tool never left the
 * authorized target. Each fact below is stated once and composed into every model-facing surface.
 *
 * `tests/minimal/truth.test.ts` pins both the presence of the truth on the three surfaces and the absence of the retired
 * claims across `src`, `extensions`, `docs` and `skills`, so a later edit fails loudly instead of re-introducing a ceiling.
 */

/** What execution inside the one container is, exactly. */
export const SANDBOX_TRUTH = 'The sandbox runs as root on a writable root filesystem with the Docker default capability set (so raw sockets work), shares the host kernel, and has no pids/memory/cpu limit; no host path is mounted and the Docker socket is never exposed.';

/** What network reachability is, exactly, and the one thing that is missing unless ingress was configured. */
export const NETWORK_TRUTH = 'Sandbox network egress is unrestricted (bridge networking): public, private, link-local and cloud-metadata addresses and host-published services are reachable, loopback is container-local, and opaque commands are not origin-filtered. There is no inbound path by default, so a target cannot connect back to the sandbox; only when the operator started the run with `--lab-network` (A7.8) does the sandbox join that operator network and a target on it can reach a session listener, and even then no host port is published and there is no tunnel or pivot.';

/** What an HTTP request is allowed to be. */
export const HTTP_TRUTH = 'p2o_http accepts any http(s) URL, any redirect hop, any method and any header or body: the authorized target is a starting label, not an egress boundary.';

/** The credential channel: one operator-declared identity file, substituted host-side, redacted best-effort, audited by id. */
export const CREDENTIAL_TRUTH = 'There is no ambient host credential channel: credentials exist only when the operator names one identity file at start, and only its ids, kinds, labels and scopes reach a model. A ${P2O_SECRET:<id>} placeholder is substituted host-side after the command policy allows the operation; retained receipts, artifacts, reports and exports redact exact value bytes on a best-effort basis, and every substitution is audited by id, never by value. A worker with target access can still print or forward a value it made the host substitute, and a value written out literally is model-authored, so treat a named principal as exposed to everything that command reaches.';

/**
 * The `risk` field in one sentence. It is a grouping label the planner and worker already use as a join key
 * (`src/tasks.ts`); it was never defined, and a measured run filled the vacuum with a self-imposed "read-only risk limit".
 */
export const RISK_LABEL_TRUTH = 'surface and risk are short grouping labels (for example authz, injection, exec, lpe, pivot), not a risk appetite, a severity, a ceiling or an instruction to stay read-only; the objective, the recorded allow/deny constraints, the engagement mode and the command policy bound this run.';
