# HTTP and sandbox networking

The start dialog authorizes write methods, authentication, bodies, private/internal destinations and sandbox tooling
for the run; declining starts nothing. There is no automatic retry, provider fallback or scope renewal.

## Two boundaries

- **`p2o_http`** checks the exact confirmed origin (scheme, host, port) before every request and redirect, resolves the
  name afresh and pins the IP. Private, loopback, link-local and IPv6 addresses are allowed when the origin was confirmed.
- **`p2o_shell` / `p2o_net`** share a bridge-networked container. Commands are **not origin-filtered** and there is no
  egress firewall: the model must keep traffic to the confirmed target; target data and downloaded text cannot widen
  scope. Use a disposable lab and external controls for stronger confinement. `p2o_net` only labels network commands.

Both keep a read-only `/target`, writable scratch, UID 65532, dropped capabilities, and no Docker socket, host home or
provider credentials. User-space tools may be installed into scratch (no root, no raw sockets: TCP connect scans work,
SYN scans may not). Commands default to no task timeout; an explicit timeout or cancellation removes the executor
(shared mode: peers lose it too; isolated mode: peers are untouched).

## Request

```json
{"url":"/login","method":"POST","headers":{"Content-Type":"application/json"},"body":"{\"user\":\"operator-provided\"}","session":"alice","followRedirects":true,"maxRedirects":3}
```

- Use only operator-supplied credentials. Standard and custom method tokens (TRACE, PROPFIND…) are accepted; CONNECT
  tunnelling belongs to the network tool. Framing headers are owned by curl.
- Limits: body 32 KiB (via stdin), 20 headers/8 KiB, URL 4096 chars, 5 redirects, transfer 8 MiB, captured output 48 KiB,
  64 KiB broker frame. Optional `timeout` (per hop) and `connectTimeout` in seconds; omitted/0 = no extension deadline.
- Curl never follows redirects: the owner checks each hop. A blocked redirect returns the response already seen with
  `redirectStopped`. 307/308 keep method and body; 303 and POST 301/302 become GET. Transport failures are not replayed.

## Sessions

`session` names an **actor-local** cookie jar (default `default`; use `alice`/`bob` for principals; `none` disables;
`resetSession` clears first). An explicit `Cookie` header overrides the jar; `Authorization` is never persisted. Jars are
origin-bound, honor Path/Secure/expiry, and are capped (64 jars, 64 cookies/jar, 8 KiB). This is bounded HTTP state, not
a browser, and not proof that a principal is authenticated. Jars are cleared at cleanup and never exported.

## Local services and privacy

`localhost` means the container. To reach a host lab service, bind it to a reachable interface and confirm
`http://host.docker.internal:<port>`. Credentials and responses can reach the model provider and Pi transcripts, and
header values are visible to the local Docker daemon during a request. Receipts omit request header/body values and keep
bounded, best-effort-redacted output. Review transcripts and exports before sharing.
