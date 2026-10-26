# HTTP and sandbox networking

The start dialog authorizes write methods, authentication, bodies, private/internal destinations and sandbox tooling
for the run; declining starts nothing. There is no automatic retry, provider fallback or scope renewal.

## Two boundaries

- **`p2o_http`** accepts any http(s) URL, follows up to five redirects to any host, resolves the name afresh and pins
  the IP. Private, loopback, link-local and IPv6 addresses are reachable; the target is a label, not a boundary.
- **`p2o_shell` / `p2o_net`** share a bridge-networked container. Commands are **not origin-filtered** and there is no
  egress firewall. Use a disposable lab and external controls for stronger confinement. `p2o_net` only labels network commands.

Both keep a read-only `/target`, writable scratch, root with the Docker default capability set (NET_RAW included, so raw
sockets and SYN scans work), and no Docker socket, host home or provider credentials. User-space tools may be installed into
scratch. Commands default to no task timeout; an explicit timeout or cancellation removes the executor
(shared mode: peers lose it too; isolated mode: peers are untouched).

## Request

```json
{"url":"/login","method":"POST","headers":{"Content-Type":"application/json"},"body":"{\"user\":\"operator-provided\"}","session":"alice","followRedirects":true,"maxRedirects":3}
```

- Use only operator-supplied credentials. Standard and custom method tokens (TRACE, PROPFIND…) are accepted; CONNECT
  tunnelling belongs to the network tool. Framing headers are owned by curl.
- Limits: body 32 KiB (via stdin), 20 headers/8 KiB, URL 4096 chars, 5 redirects, transfer 8 MiB, captured output 48 KiB,
  64 KiB broker frame. Optional `timeout` (per hop) and `connectTimeout` in seconds; omitted/0 = no extension deadline.
- Curl never follows redirects: the host checks each hop. A blocked redirect returns the response already seen with
  `redirectStopped`. 307/308 keep method and body; 303 and POST 301/302 become GET. Transport failures are not replayed.

## Sessions

`session` names an **actor-local** cookie jar (default `default`; use `alice`/`bob` for principals; `none` disables;
`resetSession` clears first). An explicit `Cookie` header overrides the jar; `Authorization` is never persisted. Jars are
origin-bound, honor Path/Secure/expiry, and are capped (64 jars, 64 cookies/jar, 8 KiB). This is bounded HTTP state, not
a browser, and not proof that a principal is authenticated. Jars are cleared at cleanup and never exported.

A request may also carry a `principal` (default `default`): it is a caller-declared jar name, not a credential and not
validated against the sealed identity. The jar key is `[principal, session, origin]`, so the same `session` name under
two principals keeps two separate jars and a principal switch cannot silently reuse another identity's cookies; naming
a principal does not prove that principal is authenticated. Identity (`--identity`, see [Usage](USAGE.md)) supplies
values only through `${P2O_SECRET:<id>}` placeholders in the url, a header or the body, substituted after the command
policy allows the request. Receipts omit request header/body values, substituted values are redacted from retained output
best-effort, and the audit record names the secret id, never the value.

## Local services and privacy

`localhost` means the container. To reach a host lab service, bind it to a reachable interface and confirm
`http://host.docker.internal:<port>`. Credentials and responses can reach the model provider and Pi transcripts, and
header values are visible to the local Docker daemon during a request. Receipts omit request header/body values and keep
bounded, best-effort-redacted output. Review transcripts and exports before sharing.

## Ingress

Inbound traffic is operator-provided and never published by the host. `--callback <http(s)-URL>` records one
out-of-band destination the target is expected to reach (a beacon/collector the operator runs); it is a recorded fact,
not a listener. `--lab-network <name>` attaches the sandbox to an operator-created docker network so the operator can
place a collaborator there and `p2o_session action=listen {port}` can catch target traffic from inside the session
container. No `docker publish`/`-p` is ever used and no tunnel or pivot is provided. Behind NAT, with no lab network and
no reachable collaborator, inbound is simply unavailable: a blind exploit is then proven by its side effect/timing (or
not proven at all), and the report says which path existed.
