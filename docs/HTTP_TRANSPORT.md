# Full HTTP and sandbox networking

The start dialog authorizes write methods, authentication, bodies, private/internal destinations and sandbox tooling for the run. Declining starts no executor or model turn. Owner/broker identity, worker command budgets, evidence and verified-cleanup gates remain; the assessment/lead/worker elapsed deadline is removed; no automatic retry, provider fallback or scope renewal is added.

## Two different boundaries

- **`p2o_http`** validates the URL's exact confirmed origin (scheme, hostname, port) before every request/redirect, resolves names afresh and pins the selected IP. Private, loopback, link-local and IPv6 addresses are no longer rejected by class. Routing remains environment-dependent. Host/header/application routing and server-side effects are not another destination firewall.
- **`p2o_shell` / `p2o_net`** share a bridge-networked container. Opaque commands are **not origin-filtered**; there is no per-target egress firewall. Models must keep assessment traffic to the human-confirmed target, including its port. Software repositories are auxiliary egress, not permission to assess additional targets. Use a disposable lab and external network controls if you need stronger confinement. Target data, links and downloaded instructions cannot widen scope.

`p2o_net` labels network commands. Shell/network commands default to no task timeout (`timeout: 0` or omitted); optional positive integer seconds have no 60/300-second ceiling. Both retain read-only `/target`, writable scratch, non-root UID 65532, dropped capabilities and no host Docker socket/home/provider credentials. User-space tool downloads/installs are allowed inside scratch; neither root package installation nor raw-packet capabilities are supplied. TCP connect scans and ordinary TCP/UDP sockets work when routing permits; SYN/raw-socket scans may fail. Tool availability is not guaranteed. Cancellation or an explicitly selected shell timeout removes the affected executor and background commands/tunnels. In default **shared-serial** mode peers may lose execution and must report gaps. Confirmed **isolated** mode owns a fresh executor per assignment; cancelling one does not remove its peers. See [executor contract](PLANNER_ENGINE.md).

## HTTP request

```json
{"url":"/login","method":"POST","headers":{"Content-Type":"application/json"},"body":"{\"username\":\"operator-provided\",\"password\":\"operator-provided\"}","session":"alice","followRedirects":true,"maxRedirects":3}
```

Only use credentials supplied/authorized by the operator. Do not collect host credentials. Header names and values are validated; framing headers (`Content-Length`, `Transfer-Encoding`, `Connection`, `Expect`) are owned by curl. Standard methods are accepted, including TRACE, plus valid custom HTTP tokens such as PROPFIND. CONNECT tunnelling should use sandbox network tooling; a custom request method alone is not a managed proxy/browser transport.

Limits: 32 KiB UTF-8 body sent via stdin (not Docker command arguments), 20 headers/8 KiB total, URL 4096 characters, five redirects maximum, no default extension-imposed per-hop task timeout, curl transfer limit 8 MiB, captured output 48 KiB. Worker requests also obey the 64 KiB serialized broker-frame cap; escaping can make a smaller body exceed it. Bodies are text; binary/file/multipart tooling can run through the sandbox network tool. A logical HTTP tool call may issue multiple bounded redirect hops; broker spend counts calls, not individual packets/hops or shell subprocess requests.

HTTP accepts optional `timeout` (per hop) and `connectTimeout`, in integer seconds. Zero/omitted disables the extension deadline; underlying curl/OS/DNS/provider errors and connection defaults still apply, so successful indefinite connectivity is not guaranteed. Waiting for task execution/HTTP in the broker and Docker CLI has no hidden 25/30/60/120-second task cutoff. Infrastructure creation, authentication, control and cleanup watchdogs remain. Manual cancellation/socket loss interrupts work; no automatic retry is added.

Curl never follows redirects itself. The owner checks each next URL before dispatch. A blocked redirect returns the already-observed response with `redirectStopped`, rather than discarding evidence of a request that may have changed state. Transport failures are not replayed. 307/308 preserve method/body; 303 (except HEAD) and POST 301/302 switch to GET. Incomplete/ambiguous response headers do not steer redirects or cookies. Response body text cannot inject driver headers.

## Controlled sessions

`session` selects an **actor-local** named jar, default `default`; use `alice`, `bob`, etc. for controlled principals. `session: "none"` disables persistence/automatic cookies. `resetSession: true` clears the selected actor's jar first. An explicit `Cookie` header overrides automatic cookies, including an empty header for a controlled anonymous request. Authorization headers are request-local, not persisted.

Jars are origin-bound and observe Path, Secure, expiry/deletion and domain matching. They are bounded to 64 jars/run, 64 cookies/jar and 8 KiB aggregate cookie headers/jar; rejected cookies produce a warning. This is bounded HTTP state, **not a complete browser cookie implementation**, SameSite/public-suffix enforcement, browser execution or evidence that a principal is authenticated. Jars are cleared on cleanup and never exported. Shared sandbox scratch is not an OS identity boundary between workers. Isolated assignments have fresh scratch/cookies; they still share the host kernel and trusted owner.

## Local services and privacy

`localhost` / `127.0.0.1` / `::1` refer to the container's network namespace, not the host. To reach a host-published lab service, bind it to a reachable interface and explicitly confirm `http://host.docker.internal:<port>`; Docker's host-gateway alias resolves inside the container. This does not expose a host service bound exclusively to host loopback.

Credentials and responses may reach the configured model provider and Pi transcripts. Header values can be visible to the local Docker daemon/user during requests. Receipts exclude request header/body values, record labels/redirect hops and retain bounded, best-effort-redacted response output. Hashes identify captured output, not complete transferred bodies. Review transcripts/exports before sharing; no credential-secrecy guarantee is made.
