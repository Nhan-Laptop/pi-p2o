# HTTP, network and browser transport

The start dialog is the run's blanket authorization: it confirms ownership and the engagement mode once, so write methods,
bodies, authentication, private/internal destinations and sandbox tooling need no further per-action consent. Declining
starts nothing. There is no automatic retry, provider fallback or scope renewal.

## Two boundaries

- **`p2o_http`** accepts any http(s) URL, follows redirects (default 3, at most 20) to any host, resolves the name afresh and
  pins the destination IP. Private, loopback, link-local and IPv6 addresses are reachable; the target is a label, not a
  boundary.
- **`p2o_shell` / `p2o_net`** share a bridge-networked container. Commands are **not** origin-filtered and there is no egress
  firewall; `p2o_net` only labels network commands. Use a disposable lab and external controls for stronger confinement.

Both keep a read-only `/target`, writable `/work/<workerId>` scratch, root with Docker's default capability set (raw sockets
and SYN scans work), and no Docker socket, host path or provider credential. User-space tools can be installed into scratch.
Commands default to no timeout; an explicit timeout or cancellation removes the executor (shared mode: peers lose it too;
isolated: peers are untouched). Container facts: [ARCHITECTURE](ARCHITECTURE.md).

## Request

```json
{"url":"/login","method":"POST","headers":{"Content-Type":"application/json"},"body":"{\"user\":\"self-provisioned\"}","session":"alice","followRedirects":true,"maxRedirects":3}
```

- Credentials are whatever the work needs: the operator may seal an identity file, and a worker may provision its own
  disposable principal (register on the target, keep the cookies in a named jar). Standard and custom method tokens (TRACE,
  PROPFIND…) are accepted; CONNECT tunnelling belongs to the network tool; framing headers belong to curl.
- Limits: body 48 KiB (stdin), 20 headers / 16 KiB total / 8 KiB per value, URL 8,192 characters, captured output 48 KiB,
  64 KiB broker frame. Optional per-hop `timeout` and `connectTimeout`; omitted or 0 means no extension deadline.
- Curl never follows redirects itself: the host checks each hop, resolves the name afresh and pins the destination IP for
  that request. A redirect that cannot be followed (unsupported scheme, hop limit, resolution failure) returns the response
  seen so far with `redirectStopped`. 307/308 keep method and body; 303 and a POST 301/302 become GET. Transport failures
  are not replayed.

## Sessions and principal jars

`session` names an **actor-local** cookie jar (default `default`; `none` disables; `resetSession` clears first). An explicit
`Cookie` header overrides the jar; `Authorization` is never persisted. Jars are keyed by `[principal, session, origin]`,
honor Path/Secure/expiry, and are capped (64 jars, 64 cookies/jar, 8 KiB). A `principal` is a caller-declared jar name, not a
credential and not a proof that the principal is authenticated; two principals keep separate jars even under the same
`session` name. Jars are cleared at cleanup and never exported. A DOM-driven flow belongs to the browser transport, not to a
cookie jar.

## Browser transport

The pinned image ships Chromium 150 at `/usr/bin/chromium` and the `agent-browser` 0.26.0 CLI on PATH (Node 24.18, npm
11.16), preconfigured through `AGENT_BROWSER_EXECUTABLE_PATH`, headless-capable as root with no install step. Drive it as an
ordinary sandbox command through `p2o_shell`/`p2o_net`, with the same receipt, capture and cleanup path as any other command:

```sh
agent-browser --session <name> open <url>      # then snapshot / get / find / click / fill / press / wait
agent-browser --session <name> eval '<js>' | screenshot out.png | pdf out.pdf
agent-browser --session <name> cookies | storage | set headers … | network route|requests|har
agent-browser --session <name> auth vault … | --state <file> | console | trace | record | batch
```

A browser-only effect therefore reaches `live_reproduction`; a profile/`--state` file is also a place to keep a
self-provisioned principal whose cookies would otherwise be lost.

## Identity channel

`--identity /absolute/identity.json` is one operator-provided file:

```json
{"secrets":[{"id":"admin-password","kind":"password","value":"…","label":"lab admin","scope":"admin.example"}]}
```

`id` matches `[a-z0-9][a-z0-9-]{0,63}`; `kind` is one of password, token, api-key, cookie, private-key, basic-auth, header,
other; `label`/`scope` are ≤200 characters; at most 256 secrets and 64 KiB per file. A malformed file is refused at start,
never guessed.

The host seals a copy plus sha256 in the control directory (never mounted, never exported). Models see ids, kinds, labels and
scopes through `p2o_secret` only — never a value; a worker ticket carries a count. The host substitutes `${P2O_SECRET:<id>}`
at execution time, only after the command policy allows the operation: shell-quoted for shell/net, raw for a PTY `send`,
request-side for HTTP. Every use is audited by id, receipts omit request header/body values, and retained output is redacted
best-effort — a worker can print or encode a value and the container sees the resolved command line. Sealing is the
operator's convenience, not a ceiling: a worker that needs a principal the operator did not seal registers a disposable one
and keeps its cookies in a named jar or an `agent-browser` profile/state. A self-provisioned principal is controlled and
disposed of, never a missing prerequisite.

## Ingress

Inbound traffic is operator-provided and never published by the host. `--callback <http(s)-URL>` records one out-of-band
destination the target is expected to reach (a beacon/collector the operator runs): a recorded fact, not a listener.
`--lab-network <name>` attaches the sandbox to an operator-created docker network so `p2o_session action=listen {port}` can
catch target traffic from inside the session container (`<container>:<port>`, tcp only, at most four per session). No
`docker publish`/`-p` is ever used and no tunnel or pivot is provided. Behind NAT, with no lab network and no reachable
collaborator, inbound is simply unavailable: a blind exploit is then proven by its side effect/timing (or not at all), and
the report says which path existed.

## Privacy

`localhost` means the container. To reach a host lab service, bind it to a reachable interface and confirm
`http://host.docker.internal:<port>`. Credentials and responses can reach the model provider and Pi transcripts, and header
values are visible to the local Docker daemon during a request. Receipts omit request header/body values and keep bounded,
best-effort-redacted output. Review transcripts and exports before sharing.
