# Proxy / interception pack (`proxy.session` / `proxy.history`)

Capture and replay of target HTTP(S) traffic, bound to the same deterministic broker as every other tool: a
loopback capture proxy that authorizes each connection with the existing policy before a socket exists, a
bounded redacted capture store, a policy-re-authorized `repeat`, and an attempt-bound lifetime. The surface
shape follows Strix's Caido tools (`list` / `view` / `repeat` / `sitemap` / `scope_rules`); the trust path is
ours — no third-party daemon, no MITM by default, and no traffic that the policy did not authorize.

It composes with the B1 browser pack: a browser session's mandatory egress proxy **is** the capture listener
when the proxy pack is installed, so page traffic lands in the same `proxy.history`.

## Capabilities

| capability | actions | input | output |
|---|---|---|---|
| `proxy.session` | `start` / `stop` / `status` | `action`, `proxyId?`, `accountId?`, `origins?`, `maxRequests?`, `maxBytes?`, `ttlMs?` | `proxy-session` evidence |
| `proxy.history` | `list`, `view`, `repeat`, `sitemap`, `scope_rules` | `action`, `proxyId`, `requestId?`, `method?`, `url?`, `headers?`, `body?`, `maxResponseBytes?`, `limit?`, `page?`, `filter?`, `query?` | `proxy-history` evidence |

The worker-visible handle is `proxyId` — never a key containing `session`, because the evidence redactor
(`src/tools/redaction.ts` `sensitiveKey`) treats such keys as credentials and would replace the handle with
`[REDACTED]`. The capture listener's port is controller-side only (`ProxyPack.inspect`); a worker reaches
captured traffic through `proxy.history` and re-issues it through `repeat`, never by dialing the proxy itself.

`start` is authorized like any target request (the declared origins must be inside the grant's targets), and
every captured unit plus every repeat is re-authorized at connection time. `proxy.session` is provisioned by
`createDefaultRegistry()`; `browser.session`/`browser.act` remain opt-in (`{ browser: true }`).

### Application wiring (opt-in, owner-configured)

Because the capture capability *is* provisioned by the default registry, a grant alone must not be enough:
`createApplication` treats the pack as a pack like any other and gates it on the owner document and on the
attempt.

* `packs.proxy: true` is the opt-in. It is qualified under `local-fixture` (loopback-only capture) and under the
  acknowledged `host-browser` boundary; a `container` sandbox refuses the pack at configuration time.
* Without `packs.proxy`, the composition registers no capture-pack releaser **and** refuses `proxy.session` /
  `proxy.history` for every attempt (`CAPABILITY_DENIED`), even when the owner grant names the capability. That
  is deliberate: a capture session created by a broker-owned pack would have no registered releaser, so the
  runtime could not prove it had been killed.
* With the opt-in, the composition creates one capture pack per attempt, hands the *same instance* to the
  attempt's broker and to the runtime's release hooks (and to the browser pack of the same attempt as its
  `egressProxy`, so page traffic is captured), and registers the `proxy-pack` releaser with the pack's own
  `outstanding(scope)` probe.
* **Attempt-liveness fence:** `proxy.session start` and every `proxy.history` action are refused unless the
  durable attempt is live, its controller-private runtime handle exists, and its runtime session lease is still
  open. `proxy.session stop` stays allowed (cleanup can only reduce leaks).
* **Runtime release:** on every terminal path the runtime asks the `proxy-pack` releaser; the durable receipt
  names it with the killed-session count and the surviving count, and concurrent releases of one attempt are
  serialized so the recorded verdict is the one that killed the listener.

## Trust path

Defence in depth, in order:

1. **Broker dispatch** — capability grant, action, target, account, budget, sandbox isolation. The pack's
   `authorizeTarget` resolves the session's own origin (or the exact repeat URL/method) so the broker's
   pre-dispatch authorization already pins the account and the scope.
2. **Connection-time gate** (`src/tools/proxy/gate.ts`) — for every request and every `CONNECT`:
   `policy.authorize` for the canonical URL (target, path prefix, exclusion, method → action, account,
   account expiry), then DNS resolution with `policy.authorizeAddress` + `sandbox.assertEgress` per resolved
   address, then the per-session request/byte budget. Denied units are refused with no upstream socket; a
   changed DNS answer is `DNS_CHANGED` before the tunnel or request is continued. Literal addresses are
   recorded as their own pin so `scope_rules` shows the exact endpoint set. `repeat` reserves the
   `TargetBudget` before any socket exists and pins the peer (`remoteAddress`/`remotePort`) at connect time.
3. **One egress implementation** — the listener is `startEgressProxy` (`src/tools/browser-proxy.ts`), the
   same loopback proxy B1 already uses and tests, plus an optional `capture` sink. The pack only adds the
   gate and the sink: there is no second proxy implementation to drift from the enforced one.
4. **Anonymous accounts only** — the capture gate refuses `credential` accounts. A passthrough proxy cannot
   inject broker-held credentials, so it never pretends to; browser-held page credentials are the page's own
   business and every request is still re-authorized.

## Capture: HTTP and HTTPS passthrough, no MITM

* **HTTP** (absolute-form or origin-form through a client's `http_proxy`): method, canonical URL, status,
  bounded request/response headers, request/response body digests, wire bytes per direction, body bytes,
  timing, redirects, target id and the pinned address. Body previews are bounded text (`PROXY_PREVIEW_CHARS`
  = 4096) for textual media types only; binary bytes are never previewed.
* **HTTPS/WSS**: `CONNECT` tunnels are captured at **tunnel granularity** — authority, decision, status,
  byte counts in both directions and timing. TLS is never intercepted, so tunnel bytes are opaque ciphertext
  and their digest covers the whole stream (CONNECT head plus tunnel bytes); it is not a body digest and the
  record kind is `connect`.
* **WebSocket upgrades**: captured as kind `websocket` at the frame-stream level, decision and bytes
  included.
* **Store bounds**: one immutable ring per session (512 records, oldest evicted with a counted drop),
  ≤ 24 headers per side, ≤ 256 chars per header value, ≤ 4096 chars per preview, ≤ 32 pinned hosts,
  ≤ 8 redirect hops. `list` is a newest-first bounded page (≤ 64 rows, ≤ 64 pages); `sitemap` aggregates
  ≤ 16 origins × ≤ 32 paths per session.
* **Secrets**: sensitive header names (`authorization`, `cookie`, `set-cookie`, `proxy-authorization`,
  `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-amz-security-token`, `x-session-token`) are replaced with
  `[REDACTED]` **in the store**, before the broker's redactor (a second pass that also scrubs echoed
  bearer/password/token patterns and any field whose key looks sensitive). Captured secrets are never
  replayed: `repeat` only accepts a bounded non-identity header allowlist.
* **Budgets**: each session has `maxRequests` (default 256, ≤ 4096) and `maxBytes` (default 32 MiB,
  ≤ 256 MiB). The request budget refuses before dialing (HTTP 403 with reason `BUDGET_EXCEEDED`, session
  `refused: "yes"`); the byte budget refuses the next unit and is reported in `scope_rules.budget`. Both are
  additional to the supervisor-owned `TargetBudget`, which is reserved and charged for every captured unit
  and every repeat exactly as for `http.request`.

### The MITM decision: not implemented, and why

A per-run CA would have to be installed into the pinned Chrome's throwaway profile (never the host store),
and the resulting plaintext would make every capture a credential-bearing artifact. B2 keeps the B1 trust
property instead: Chrome's TLS trust store is untouched, the CDP `Fetch` layer continues to authorize every
HTTPS request by full URL, and the capture pack records what it can see honestly. The exact limits:

* HTTPS request **URLs/methods** are not available from tunnel bytes; when the browser pack is the client,
  the browser gate's per-request decisions remain in `browser.act`/`browser.session` evidence, while
  `proxy.history` records the CONNECT unit (authority, bytes, timing, decision).
* HTTPS **bodies** are never captured, only ciphertext byte counts; a CONNECT record's digest is an opaque
  stream digest.
* `CONNECT` is authorized as its `https` origin with path `/`, so a target whose path prefixes do not include
  `/` can only be reached over plain HTTP capture; per-path HTTPS enforcement needs the CDP layer (browser
  packs) rather than a proxy tunnel. This mirrors the B1 egress proxy exactly.
* `repeat` over `https` performs the broker's own TLS connection with certificate verification and SNI; it is
  not a replay of captured ciphertext.

## `repeat` — re-issue with evidence

`repeat_request` (action `repeat`) re-issues a captured **allowed** record through the connection-time gate:
the target budget is reserved first, DNS is pinned, the peer is verified, and the response is captured as a
new `repeat` record whose `replayOf` names the original. A worker may modify what is safe to modify:

* method (any approved method), path and query on the **same origin** — a different host/origin/account is
  `TARGET_DENIED` before any socket;
* body (≤ 64 KiB, empty allowed);
* a bounded header allowlist (`accept`, `accept-language`, `content-type`, `if-match`, `if-none-match`,
  `idempotency-key`, `x-request-id`, `cache-control`, `pragma`). `host`, `cookie`, `authorization` and
  `proxy-*` headers are `ACCOUNT_DENIED`.

Cross-origin redirect hops are never followed, redirects are bounded by the descriptor limit, and a record
whose decision was `blocked` can never be replayed (`TARGET_DENIED`) — a refused request is not resurrected
by replay.

## Browser integration (additive)

The browser pack already launches Chrome with `--proxy-server=http://127.0.0.1:<port>` so that pages,
subresources, websocket upgrades and Chrome's background services must traverse a loopback proxy. B2 makes
that proxy interchangeable:

* `startEgressProxy` accepts an optional `capture` sink (`EgressObservation`: kind, method, url, decision,
  reason, status, bounded headers, digests, byte counts, timing, pinned address). Capture is strictly
  fire-and-forget — a sink error can never change an egress decision.
* `BrowserPackOptions.egressProxy?: EgressProxyFactory` lets an owner supply the listener. The default is the
  unchanged B1 proxy, so existing browser tests and any deployment without the capture pack behave exactly as
  before.
* `createToolBroker` hands a broker-owned browser pack the broker-owned proxy pack's factory. With no
  `proxy.session` started, the first browser egress use opens an **implicit** capture session for that attempt
  (browser traffic is captured without the worker needing `proxy.session`); an explicit session, when one is
  open, is preferred. The browser gate stays authoritative for browser scope and browser budgets; the capture
  session adds only its own request/byte budget in front of it and records what the browser gate authorized.
* `http_proxy`/`https_proxy` are not needed for Chrome (Chrome is pinned to `--proxy-server`, and
  `NO_PROXY=localhost,127.0.0.1` semantics are unnecessary because the pack's clients are the browser and the
  broker, never a shell). The capture proxy itself is loopback-only.

## Lifetime

* Every session is bound to `{ runId, taskId, attemptId }`; a handle used by another attempt fails
  `IDENTITY_DENIED` (live session or tombstone), and a released/expired session can only answer `status`.
* The deadline is `min(grant.expiresAt, authorization.expiresAt, now + ttlMs)`; a 1 s watchdog kills the
  session on `deadline` or `grant-revoked`, and any use re-validates ownership, expiry and grant activity.
* `ProxyPack.releaseAttempt(context)` is the attempt-release hook (identical shape to the browser pack); a
  module-level `process.once('exit')` hook closes every live listener on graceful controller exit.
* **No orphan listeners**: `stop` and release close the listener, destroy its sockets and clear it from the
  pack; the port is released (verified by `ECONNREFUSED` in the suite) and `inspect(proxyId)` returns
  `undefined`. A controller `SIGKILL` leaves no listener behind either — a listener is an OS socket owned by
  the dying process, unlike a browser process group, so no pid-file sweep is claimed (and the runtime's
  restart sweep will report a proxy-pack lease as unverifiable rather than pretending to have proved it).
* The runtime style is shared with B1: `ToolBrokerOptions.proxy?: ProxyPack` lets a runtime/composition own
  and drive the pack, and the pack exposes `releaseAttempt`, `outstanding(scope)`, `close()` and
  `sessions` — exactly the `AttemptSessionPack` shape `packSessionReleaser` (B4) drives.

## Evidence

Every call returns the broker artifact (the single redacted JSON observation) and a receipt. Session evidence
carries the pinned identity (mode `passthrough-no-mitm`, transport, `mitm: "none"`, the pack implementation
digest recomputed from the installed module bytes and a derived identity digest), declared origins,
request/byte budget counters, the sandbox isolation string and the limits list. History evidence carries
bounded entries, the detailed record, the repeat summary, the sitemap or explicit scope decisions. **No host
path, listener port, pid or profile root ever reaches the worker**, and the redactor never has to be weakened
because the pack stores redacted headers itself.

`list`/`view` for `capture-proxy` and `browser-egress` records come from one store, so a page's subresources
and a direct `http_proxy` capture are visible in one place, with `source` stating which path produced them.

## Files

`src/tools/proxy.ts` (worker surface: actions, input types, pack factory), `src/tools/proxy/store.ts`
(bounded redacted capture store, body digests, sitemap), `src/tools/proxy/gate.ts` (connection-time policy
gate and budgets), `src/tools/proxy/replay.ts` (pinned `repeat`), `src/tools/proxy/identity.ts` (pinned pack
identity), `src/tools/proxy/pack.ts` (sessions, lifetime, browser egress factory). Shared plumbing:
`src/policy/scope.ts`, `src/policy/types.ts`, `src/tools/types.ts`, `src/tools/registry.ts`,
`src/tools/broker.ts`. Additive browser-pack changes: `src/tools/browser-proxy.ts` (`EgressGate` interface,
capture sink, `EgressProxyFactory`), `src/tools/browser-session.ts` (`egressProxy` option). Tests:
`tests/proxy/run.mjs`, `tests/proxy/proxy.node.ts`, `tests/proxy/fixtures.ts`,
`tests/proxy/evidence.mjs` + `evidence.script.ts` (the raw evidence below).

## Verification (raw output)

### Proxy pack suite — `node tests/proxy/run.mjs`

```
✔ capture: in-scope traffic is recorded and non-scope traffic is refused before egress (59.330641ms)
✔ https passthrough: CONNECT tunnels are captured at tunnel granularity without MITM (19.67002ms)
✔ list/view/repeat round-trip: digests match, modifications cannot widen scope/host/account (36.795887ms)
✔ sitemap aggregates captured origins and paths; scope_rules reports explicit decisions (23.120038ms)
✔ session request budget exhaustion refuses before egress and is reported (27.683255ms)
✔ sessions are killed on attempt release and are unusable afterwards (16.305475ms)
✔ an explicit stop closes the listener and leaves a tombstone for the owning attempt (16.201023ms)
✔ the grant deadline kills the capture session and the tombstone refuses further reads (2019.818523ms)
✔ worker-visible evidence never contains a host path or an unredacted secret (44.835327ms)
✔ doctor qualifies capture sessions on the acknowledged boundaries and refuses container isolation (20.222412ms)
✔ capability descriptor tampering is refused: isolation, actions, side effects, schemas and identity (18.782687ms)
✔ browser page traffic is captured through the pack egress proxy (2358.314612ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6248.465478
```

The raw scenario output below was produced by `node tests/proxy/evidence.mjs` against two loopback fixtures
(an in-scope app and an out-of-scope origin). The six-line `limits` array is printed in full once and elided
as `… limits …` afterwards; everything else is verbatim.

#### `proxy.session start` (worker-visible evidence; no port, pid or host path)

```json
{
  "kind": "proxy-session",
  "status": "open",
  "proxyId": "px-b3c2b95759dd453e872d37c7",
  "mode": "passthrough-no-mitm",
  "origins": [
    "http://127.0.0.1:35831",
    "https://127.0.0.1:35831"
  ],
  "budget": { "requests": 0, "requestsMax": 256, "bytes": 0, "bytesMax": 33554432 },
  "identity": {
    "mode": "passthrough-no-mitm",
    "transport": "loopback-http-capture-proxy",
    "mitm": "none",
    "implementationDigest": "f49445a195efcf166558291b05c9bdb539f93c460706f8620be843c81dde8b63",
    "identityDigest": "e857fa16fb626a9d205b9292f7da59ea005f67c5b4a04b6ea0cb9f08c81cdb0a"
  },
  "isolation": "local-fixture:trusted-broker-only:no-hostile-code-isolation",
  "limits": [
    "Capture is passthrough: HTTP request/response metadata and body digests are recorded, HTTPS/wss are recorded at CONNECT granularity because TLS is never intercepted.",
    "No per-run CA and no MITM: captured HTTPS bodies are opaque ciphertext and the store records host, port, byte counts and timing only.",
    "Every captured unit is authorized at connection time by the same policy (canonicalization, target/path/exclusion, method/action, account, DNS pin, CIDR) before a socket is dialed.",
    "repeat re-issues one captured request through the same gate with the target budget reserved first; it can modify method/path/query/body but never host, origin, account or scope.",
    "Sessions are bound to one attempt, expire with the grant/authorization deadline, and are killed on release, deadline or owner failure; a stale capture session is never readable again.",
    "Only anonymous approved accounts: a capture proxy never injects broker-held credentials and never stores reusable header secrets."
  ],
  "released": "no"
}
```

#### 1. Two-origin fixture: allowed traffic captured, non-scope refused before egress

```
→ GET http://127.0.0.1:35831/app (through the capture proxy)
← HTTP 200 "<!doctype html><html><head><title>Proxy Fixture</title></head><body><div id=\"root\">rendered</div><script>\nfetch('http://"

→ GET http://127.0.0.1:41175/xhr (through the capture proxy)
← HTTP 403 ""

### out-of-scope origin hits (must be empty)
[]
```

```json
"entries": [
  {
    "seq": 2, "id": "rq-…", "at": "2026-10-03T02:46:38.2…Z", "source": "capture-proxy", "kind": "http",
    "method": "GET", "url": "http://127.0.0.1:41175/xhr", "host": "127.0.0.1:41175", "status": 403,
    "decision": "blocked", "reason": "TARGET_DENIED", "requestBytes": 81, "responseBytes": 0, "ms": 0,
    "targetId": "", "replayOf": "", "pinnedAddress": "", "truncated": "no"
  },
  {
    "seq": 1, "id": "rq-…", "at": "2026-10-03T02:46:38.2…Z", "source": "capture-proxy", "kind": "http",
    "method": "GET", "url": "http://127.0.0.1:35831/app", "host": "127.0.0.1:35831", "status": 200,
    "decision": "allowed", "reason": "response", "requestBytes": 163, "responseBytes": 182, "ms": 5,
    "requestDigest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "responseDigest": "e1da32583ef276aeb70e356dfcf77a461d47f14dbe0b8530f5dba91c7257108c",
    "targetId": "fixture-target", "replayOf": "", "pinnedAddress": "127.0.0.1", "truncated": "no"
  }
]
```

#### 1b. HTTPS passthrough: CONNECT tunnels captured without MITM

```
CONNECT 127.0.0.1:35831 → HTTP 200; tunneled body reached the fixture: true
CONNECT 127.0.0.1:41175 (out of scope) → HTTP 403
```

```json
{
  "seq": 3, "source": "capture-proxy", "kind": "connect", "method": "CONNECT",
  "url": "https://127.0.0.1:35831/", "host": "127.0.0.1:35831", "status": 200, "decision": "allowed",
  "reason": "response", "requestBytes": 121, "responseBytes": 131, "ms": 1,
  "requestDigest": "2024dd44ce0c1c0efc76ac9bd604d44a64766f4f074228f0179552f5056c1ca9",
  "responseDigest": "460cd0255f3263fbd22b1fa676ea70b3f93f0e021c97d8eca3692e8ebfe0fe20",
  "targetId": "fixture-target", "pinnedAddress": "127.0.0.1", "truncated": "no"
}
{
  "seq": 4, "source": "capture-proxy", "kind": "connect", "method": "CONNECT",
  "url": "https://127.0.0.1:41175/", "host": "127.0.0.1:41175", "status": 403, "decision": "blocked",
  "reason": "TARGET_DENIED", "requestBytes": 55, "responseBytes": 0, "ms": 0,
  "requestDigest": "c61429da2e2ea07d6b4e8abc6061d2bb55a2b95691694562012f70739f4344fd",
  "responseDigest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "targetId": "", "pinnedAddress": "", "truncated": "no"
}
```

#### 2. `list` / `view` / `repeat` round-trip with evidence digests

`view` returns bounded headers (already redacted in the store) and body-only digests:

```json
{
  "entry": {
    "seq": 1, "id": "rq-342fe32f2dac40189e66315f", "source": "capture-proxy", "kind": "http",
    "method": "GET", "url": "http://127.0.0.1:33817/app", "host": "127.0.0.1:33817", "status": 200,
    "decision": "allowed", "reason": "response", "requestBytes": 163, "responseBytes": 182, "ms": 7,
    "requestDigest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "responseDigest": "e1da32583ef276aeb70e356dfcf77a461d47f14dbe0b8530f5dba91c7257108c",
    "targetId": "fixture-target", "pinnedAddress": "127.0.0.1", "truncated": "no",
    "requestHeaders": {
      "host": "127.0.0.1:33817",
      "authorization": "[REDACTED]",
      "cookie": "[REDACTED]",
      "connection": "close"
    },
    "responseHeaders": { "content-type": "text/html", "date": "…", "connection": "close", "content-length": "182" },
    "requestBody": { "digest": "e3b0…2b855", "bytes": 0, "mediaType": "", "preview": "", "truncated": "no" },
    "responseBody": {
      "digest": "e1da32583ef276aeb70e356dfcf77a461d47f14dbe0b8530f5dba91c7257108c",
      "bytes": 182, "mediaType": "text/html",
      "preview": "<!doctype html><html><head><title>Proxy Fixture</title></head><body><div id=\"root\">rendered</div><script>\nfetch('http://127.0.0.1:39747/xhr').catch(() => {});\n</script></body></html>",
      "truncated": "no"
    },
    "dns": ["127.0.0.1"], "redirects": []
  }
}
```

`repeat` with a modified method/path/body inside the same origin:

```json
{
  "id": "rq-d878e8ccc65040a98edafae3",
  "url": "http://127.0.0.1:33817/echo",
  "method": "POST",
  "status": 200,
  "requestDigest": "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588",
  "responseDigest": "21b654497678f0d56bbc894b1d21b7fe6edecb8fa9a37a757454c40d62645ca5",
  "requestBytes": 17, "responseBytes": 48, "ms": 10,
  "pinnedAddress": "127.0.0.1", "dns": ["127.0.0.1"], "redirects": [],
  "truncated": "no", "replayOf": "rq-342fe32f2dac40189e66315f"
}
```

The new record is itself viewable (`source: "repeat"`, `replayOf` set, empty-body digest
`93a23971…` for `{"hello":"world"}`; the response preview contains `{"method":"POST","body":"{\"hello\":\"world\"}"}`).
Widening attempts are refused before egress:

```
refused: cross-origin repeat → TARGET_DENIED
refused: host header override → ACCOUNT_DENIED
refused: cookie header override → ACCOUNT_DENIED
refused: excluded path → TARGET_DENIED
```

#### 3. Sitemap aggregation and explicit scope decisions

```json
"sitemap": {
  "origins": [
    {
      "origin": "http://127.0.0.1:35831", "requests": 5, "allowed": 5, "blocked": 0,
      "paths": [
        { "path": "/json", "requests": 2, "methods": ["GET"], "lastStatus": 200, "decision": "allowed" },
        { "path": "/app", "requests": 1, "methods": ["GET"], "lastStatus": 200, "decision": "allowed" }
      ]
    },
    {
      "origin": "https://127.0.0.1:41175", "requests": 1, "allowed": 0, "blocked": 1,
      "paths": [ { "path": "/", "requests": 1, "methods": ["CONNECT"], "lastStatus": 403, "decision": "blocked" } ]
    }
  ]
}
"scope": {
  "allowed": [{ "targetId": "fixture-target", "origins": ["http://127.0.0.1:35831", "https://127.0.0.1:35831"],
    "pathPrefixes": ["/"], "methods": ["GET","HEAD","OPTIONS","POST","PUT","PATCH","DELETE"], "accounts": ["anonymous"] }],
  "excluded": [{ "origin": "http://127.0.0.1:35831", "pathPrefixes": ["/excluded"] }],
  "decisions": { "allowed": 6, "blocked": 2, "byReason": [{ "reason": "TARGET_DENIED", "count": 2 }] },
  "pinned": [{ "host": "127.0.0.1", "addresses": ["127.0.0.1"] }],
  "budget": { "requests": 6, "requestsMax": 256, "bytes": 1040, "bytesMax": 33554432 },
  "refused": "no"
}
```

#### 4. Budget exhaustion refuses before egress

```
→ GET http://127.0.0.1:35831/json (through the capture proxy)  ← HTTP 200
→ GET http://127.0.0.1:35831/json (through the capture proxy)  ← HTTP 200
→ GET http://127.0.0.1:35831/json (through the capture proxy)  ← HTTP 403
target hits for /json: 4
```

(`maxRequests: 2`; the third request is refused with no target hit — the fixture saw only the two allowed
requests from that session plus two from the sitemap scenario.)

```json
{
  "kind": "proxy-history", "action": "list", "status": "open", "total": 3, "shown": 3, "refused": "yes",
  "entries": [
    { "seq": 3, "status": 403, "decision": "blocked", "reason": "BUDGET_EXCEEDED", "url": "http://127.0.0.1:35831/json",
      "requestBytes": 82, "responseBytes": 0, "targetId": "", "truncated": "no" },
    { "seq": 2, "status": 200, "decision": "allowed", "reason": "response", "targetId": "fixture-target" },
    { "seq": 1, "status": 200, "decision": "allowed", "reason": "response", "targetId": "fixture-target" }
  ]
}
```

#### 5. Session killed on release and unusable afterwards

```
### release receipt
2

### proxy.session status after release
{ "kind": "proxy-session", "status": "closed", "proxyId": "px-347536c1e6b2444cb367dbb3",
  "mode": "passthrough-no-mitm", "budget": { "requests": 0, "requestsMax": 256, "bytes": 0, "bytesMax": 33554432 },
  … identity identical to start, isolation identical, …
  "released": "yes" }

refused: proxy.history on a released session → UNAVAILABLE
refused: another attempt reusing the handle → IDENTITY_DENIED
refused: loopback listener after release → ECONNREFUSED

### live sessions after release
0
```

#### 6. Browser page traffic through the pack egress proxy

From the browser-routed suite case (host Chrome, host-browser boundary): after `browser.session open` the
attempt's implicit capture session is discoverable through `proxy.session status` (no `proxyId`), and
`proxy.history list` shows `source: "browser-egress"` records for the page navigation (`/app`, allowed) and
the page's out-of-scope XHR (blocked, `TARGET_DENIED`) while the out-of-scope fixture received nothing:

```
✔ browser page traffic is captured through the pack egress proxy (2358.314612ms)
```

### Existing suites

```
$ npx tsc --noEmit -p tsconfig.json  → clean (no diagnostics)

$ node tests/tools/run.mjs        → ℹ tests 56  ℹ pass 56  ℹ fail 0
$ node tests/browser/run.mjs      → ℹ tests 14  ℹ pass 14  ℹ fail 0
$ node tests/orchestrator/run.mjs → ℹ tests 59  ℹ pass 59  ℹ fail 0
$ node tests/end-to-end/run.mjs   → ℹ tests 14  ℹ pass 14  ℹ fail 0   (from a copy without the live-lab socket; 3rd of 3 attempts)
$ node tests/proxy/run.mjs        → ℹ tests 12  ℹ pass 12  ℹ fail 0
$ node tests/evidence/run.mjs     → ℹ tests 54  ℹ pass 54  ℹ fail 0
$ node tests/interface/run.mjs    → ℹ tests 51  ℹ pass 51  ℹ fail 0
$ node tests/budget/run.mjs       → ℹ tests 37  ℹ pass 37  ℹ fail 0
$ node tests/sandbox/run.mjs --allow-missing → PASS live sandbox smoke: 35/35 checks passed
$ node tests/interface/integration.mjs → INTEGRATION: PASS (ok: true, failures: [])
```

**End-to-end honesty note.** `node tests/end-to-end/run.mjs` cannot run in place while the live-lab workstream
holds `examples/live-lab/.runs/lp-*/b.sock`: `tests/end-to-end/compile.mjs` copies `examples/` recursively and
aborts with `ERR_FS_CP_SOCKET` (the same finding the browser pack documented). Running from a copy of the tree
without `examples/live-lab/.runs/`, three final attempts gave 13/14, 13/14, 14/14 on the same tree; the only
failing test is the live headless chain (`local assessment chain`), whose failing attempt is `task-surface-map`
ending in runtime state `failed` with no exit record under load average 3–5. The same flake reproduces with the
B2 pack stubbed out of the tree, and the e2e grants only `source.analyze`/`http.request` to its workers, so no
proxy capability is dispatched on that path. Two full-chain runs (one in a copy, one in place before the
live-lab socket appeared) passed 14/14. This is the load/timing sensitivity the browser pack already recorded;
nothing in this pack is on that path.
