/**
 * planning_update.md P7.0 (A7.10): the sentences the model is told about its own instrument.
 *
 * Capability text used to be written per surface and drifted from the code: the `p2o_http` description promised per-hop
 * origin scoping the implementation had removed, `p2o_net` said raw sockets were unavailable while the container runs as
 * root with the Docker default capability set (NET_RAW included), the consent and report text claimed more capability than
 * that set grants and a credential channel the host does not provide, and the report claimed the tool never left the
 * authorized target. Each fact below is stated once and composed into the surfaces that carry it: the planner/worker system
 * prompts and the input schemas. The execution tool descriptions (`p2o_shell`/`p2o_net`/`p2o_http`) do not repeat a fact the
 * worker prompt already states (A1 dedupe, owner decision 2026-10-28); only `SANDBOX_TRUTH` stays there because no worker
 * prompt states it.
 *
 * `tests/minimal/truth.test.ts` pins both the presence of each fact on the prompt and schema surfaces, the absence of the
 * duplicates on the execution tool descriptions, and the absence of the retired claims across `src`, `extensions`, `docs` and
 * `skills`, so a later edit fails loudly instead of re-introducing a ceiling.
 */

/** What execution inside the one container is, exactly. */
export const SANDBOX_TRUTH = 'The sandbox runs as root on a writable root filesystem with the Docker default capability set (so raw sockets work), shares the host kernel, and has no pids/memory/cpu limit; no host path is mounted and the Docker socket is never exposed.';

/** What network reachability is, exactly, and the one thing that is missing unless ingress was configured. */
export const NETWORK_TRUTH = 'Sandbox network egress is unrestricted (bridge networking): public, private, link-local and cloud-metadata addresses and host-published services are reachable, loopback is container-local, and opaque commands are not origin-filtered. There is no inbound path by default, so a target cannot connect back to the sandbox; only when the operator started the run with `--lab-network` (A7.8) does the sandbox join that operator network and a target on it can reach a session listener, and even then no host port is published and there is no tunnel or pivot.';

/** What an HTTP request is allowed to be. */
export const HTTP_TRUTH = 'p2o_http accepts any http(s) URL, any redirect hop, any method and any header or body: the authorized target is a starting label, not an egress boundary.';

/**
 * planning_update.md P11/A11: the one fact that was never written down. The operator confirms ownership and the engagement
 * mode once, at start; a measured run then treated a POST, an internal host and a missing account as three separate
 * permissions it had to ask a human for. There is no per-action consent to obtain: those are ordinary work items.
 */
export const AUTHORIZATION_TRUTH = 'Authorization is blanket for the whole run: the operator confirmed target ownership and the engagement mode before it started, so there is no per-action consent to obtain and a round must never end by asking a human for one — any method, any body, any host the sandbox can route to, and any account, identity or software the work needs are ordinary work items. The operator can still narrow the run with recorded constraints and the sandbox remains the only blast radius; a missing credential, account or browser is something you provision yourself, and the only wall is a tool or host that actually refuses, or an approach that is exhausted.';

/**
 * planning_update.md P11/A11: the browser was called missing for so long that the report said so. The image ships one, so the
 * claim was a text bug: the transport is a sandbox command like any other, in the same receipt and capture path.
 */
export const BROWSER_TRUTH = 'A headless Chromium (150) and the agent-browser CLI are already installed in the sandbox image at /usr/bin/chromium and on PATH, configured through AGENT_BROWSER_EXECUTABLE_PATH and its default arguments, so no install step exists: drive it as an ordinary sandbox command (agent-browser --session <name> open <url>, then snapshot, get, find, click, fill, press, eval, screenshot or pdf), and use its cookies, storage, set headers, network route/requests/har, auth vault, --state and --session-name persistence, console, errors, trace and record commands to keep a principal or page across steps. A browser-only effect is testable to live_reproduction by the same command, receipt, artifact and cleanup path as anything else the sandbox runs.';

/** The credential channel: one operator-declared identity file, substituted host-side, redacted best-effort, audited by id. */
export const CREDENTIAL_TRUTH = 'There is no ambient host credential channel: credentials exist only when the operator names one identity file at start, and only its ids, kinds, labels and scopes reach a model. A ${P2O_SECRET:<id>} placeholder is substituted host-side after the command policy allows the operation; retained receipts, artifacts, reports and exports redact exact value bytes on a best-effort basis, and every substitution is audited by id, never by value. A worker with target access can still print or forward a value it made the host substitute, and a value written out literally is model-authored, so treat a named principal as exposed to everything that command reaches. The sealed channel is the operator\'s convenience, not a ceiling: an identity the work needs that the operator did not seal is one you create yourself — register on the target, keep the cookies in a named principal cookie jar or in an agent-browser profile/state — and a self-provisioned principal is a controlled identity you dispose of at the end, never a missing prerequisite.';

/**
 * The `risk` field in one sentence. It is a grouping label the planner and worker already use as a join key
 * (`src/tasks.ts`); it was never defined, and a measured run filled the vacuum with a self-imposed "read-only risk limit".
 */
export const RISK_LABEL_TRUTH = 'surface and risk are short grouping labels (for example authz, injection, exec, lpe, pivot), not a risk appetite, a severity, a ceiling or an instruction to stay read-only; the objective, the recorded allow/deny constraints, the engagement mode and the command policy bound this run.';
