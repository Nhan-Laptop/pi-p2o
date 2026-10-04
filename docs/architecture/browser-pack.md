# Browser pack (`browser.session` / `browser.act`)

A real JS-capable headless browser bound to the deterministic broker: raw CDP over a Node `WebSocket`
(no Playwright/Puppeteer, no new dependency), the host's pinned Chrome, per-navigation **and**
per-request scope enforcement, a mandatory egress proxy, evidence capture, and an attempt-bound lifetime.

## Capabilities

| capability | actions | input | output |
|---|---|---|---|
| `browser.session` | `open` / `close` / `status` | `action`, `browserId?`, `url?`, `accountId?` | `browser-session` evidence |
| `browser.act` | `navigate`, `snapshot`, `click`, `fill`, `type`, `press`, `select`, `extract_text`, `extract_html`, `screenshot`, `back`, `tabs` | `browserId`, `action`, `url?`, `ref?`, `text?`, `value?`, `key?` | `browser-action` evidence |

The worker-visible handle is called `browserId` (not `sessionId`) on purpose: the evidence redactor treats
any field whose **key** contains `session` as a credential (`src/tools/redaction.ts` `sensitiveKey`) and
would replace the handle with `[REDACTED]`, making a session unusable from the redacted observation. The
opaque handle is not a secret, but the pack never asks the redactor to weaken that heuristic.

`browser.session open` navigates to the approved URL, so it is authorized like any other target request.
Opening is not charged to the per-session action budget; every `browser.act` call is.

## Isolation honesty: `host-browser`, never "container"

The browser process runs on the host kernel. `src/tools/sandbox.ts` therefore adds an explicit isolation
mode, `host-browser`, with its own acknowledgement
(`host-browser-not-container-isolated`), an owner approval and an expiry, plus the pinned Chrome identity:

```
isolation: "host-browser:not-container-isolated:chrome-153.0.8010.52:scope-enforced-at-cdp-and-egress-proxy"
```

* `createDefaultRegistry()` does **not** provision `browser.session`/`browser.act`; a run must pass
  `{ browser: true }` to include the pack.
* **Application wiring (opt-in, owner-configured).** `createApplication` enables the pack only when the owner
  document asks for it (`packs.browser: true`) **and** the sandbox is the acknowledged host boundary:
  `{ "sandbox": { "mode": "host-browser", "acknowledgement": "host-browser-not-container-isolated",
  "approvedBy": "...", "expiresAt": "...", "egress": "loopback-only", "profileRoot": "...", "identity": {...} },
  "packs": { "browser": true } }`. Nothing is enabled by default: without `packs.browser` the registry does not
  provision `browser.*`, and an owner grant for `browser.session` is refused (`CAPABILITY_DENIED`) rather than
  silently creating a session the composition could not release.
* The composition creates one browser pack **per attempt** and hands the *same instance* to that attempt's
  broker and to the runtime's release hooks; `application.packInstancesFor(attemptId)` exposes it for operators
  and tests. It grants nothing: every dispatch still passes the broker's policy check.
* **Attempt-liveness fence.** `browser.session open` and every `browser.act` are refused unless the durable
  attempt is live, its controller-private runtime handle exists, and its runtime session lease is still open. A
  settled, released or foreign attempt can never open a session or drive a stale one (`close` stays allowed:
  tearing a session down can only reduce leaks).
* **Runtime release.** On completion, verified stop, cancellation, deadline, quarantine and crash recovery the
  runtime asks the registered `browser-pack` releaser. The durable session-lease receipt names the releaser with
  the killed-session count and the surviving count, and concurrent releases of one attempt are serialized, so
  the recorded verdict belongs to the call that actually killed the session.
* The pack only dispatches on a `createHostBrowserSandbox({ browser: {...} })` boundary. A `local-fixture`
  or `container` sandbox refuses the capability at dispatch (`UNAVAILABLE`) even when the registry
  provisions it.
* `doctor()` adds a `browser-pack` check and fails closed unless the sandbox is `host-browser`, the
  acknowledgement is exact and the pinned identity re-hashes from disk at preflight.
* Descriptor declarations are exact-matched against the installed adapter: isolation, actions, side
  effects, input/output schema digests, version and implementation digest. A descriptor that claims
  `local-fixture` isolation, hides `explicit-mutation`, widens the action set, adds an invented side
  effect or replaces any schema/identity is refused by `new CapabilityRegistry(...)`.

Defence in depth, in order:

1. **Broker dispatch** — capability grant, action, target, account, budget, sandbox isolation.
2. **CDP `Fetch` interception** (every `http(s)` request, including each redirect hop and every
   subresource): `policy.authorize` for the exact URL/method/action/account, then DNS resolution with
   `policy.authorizeAddress` + `sandbox.assertEgress` per resolved address. Denied requests are failed with
   `Fetch.failRequest BlockedByClient` **before** they leave the host. Code running in the page cannot
   widen scope: it can only cause requests, and every request is re-authorized.
3. **Mandatory loopback egress proxy** — Chrome is launched with
   `--proxy-server=http://127.0.0.1:<port>` and `--proxy-bypass-list=<-loopback>`, so pages, subresources,
   websocket upgrades and Chrome's own background services must traverse the proxy. It applies the same
   policy check, answers 403 for non-scope destinations **without dialing**, and connects only to an
   address it resolved and the policy authorized (this is what makes connect-time DNS rebinding
   impossible rather than merely detected). `ws`/`wss` handshakes are enforced here because Chrome's Fetch
   domain does not intercept them.
4. **DNS pinning** — the first answer set per hostname is pinned for the session; a changed answer is
   refused with `DNS_CHANGED` before any request is continued.
5. **Launch flags** — `--headless=new`, `--remote-debugging-port=0` (loopback), a fresh
   `--user-data-dir` under the acknowledged profile root, extensions/component-updater/sync/translate/
   background-networking/QUIC/WebRTC-non-proxied-UDP disabled, downloads denied, `Browser.getVersion`
   product cross-checked against the pin. No host profile, no host `HOME`, no host credentials.
6. **Credentials** — only `anonymous` approved accounts are accepted; the broker's credential provider is
   never injected into a page, so a browser session cannot borrow the supervisor's secrets.

## Evidence

Each call returns the broker artifact (the single redacted JSON observation) and a receipt; a screenshot is
an additional bounded PNG in the same private artifact root, referenced by digest inside the observation
(`redacted: false` is stated explicitly — pixels are not text-redacted).

* Session evidence: status, session id, origin, url, title, pinned Chrome version/product/binary digest,
  action+request budget counters, isolation string and limits. **No host path, pid, debug port or proxy
  port ever reaches the worker.**
* Action evidence: url/title, DOM digest (+ truncation flag), accessibility snapshot digest + bounded text
  and `@eN` refs, text/html extraction, screenshot `{ path, sha256, bytes, mediaType }`, tab list, and a
  bounded network log (method, url, resource type, allowed/blocked, reason, status, bytes, ms, redirects,
  target id).
* The network log only ever contains entries created by the gate (the decision point); CDP telemetry only
  updates an existing entry, so an undecided race can never be misread as allowed traffic.
* Session request counts are charged to the existing `TargetBudget` by the egress proxy (the only egress
  path), so receipts carry the same `budgets`/`targets` shape as every other capability. Blocked
  out-of-scope attempts and Chrome's own background chatter are never charged to the target.

## Lifetime

* A session is bound to `{ runId, taskId, attemptId, grantId }`; every call re-validates ownership, the
  grant's activity and the session deadline. Another attempt acting on the handle fails `IDENTITY_DENIED`
  (live session or tombstone).
* `browser.session close` performs a verified stop: CDP close, proxy close, SIGTERM → SIGKILL **to the whole
  browser process group** (Chrome's renderer/utility children can outlive a lone SIGTERM and recreate
  profile files after cleanup), then profile removal with retries. It leaves a tombstone that can only
  answer `status` for the owning attempt.
* `BrowserPack.releaseAttempt(context)` is the attempt-release hook (also exposed through
  `ToolBrokerOptions.browser`, so a runtime/composition that owns the pack can call it when an attempt is
  released). The shipped composition drives it from the runtime's terminal paths (see *Application wiring*);
  tests call it directly and verify the pid is gone, the profile is removed and the handle is unusable.
* A 1 s watchdog kills sessions whose TTL or grant/authorization deadline passed (`deadline` /
  `grant-revoked`).
* One module-level `process.once('exit')` hook SIGKILLs every live browser on graceful controller exit; a
  stale profile from an ungraceful exit is recovered on the next pack construction by a pid-file sweep that
  only kills a pid whose `/proc/<pid>/cmdline` still names that exact profile (never a recycled or foreign
  process).
* Residual limit: a `SIGKILL` of the controller leaves an orphan browser until that next-run sweep, and the
  loopback proxy is unauthenticated for its short lifetime (a pinned Chrome launcher cannot be given proxy
  credentials on the command line); it exists only for its session and enforces exactly the session's
  scope and budgets.

## Files

`src/tools/browser-identity.ts` (pin + re-verify), `browser-cdp.ts` (CDP/WebSocket transport),
`browser-gate.ts` (policy+DNS gate and bounded network log), `browser-proxy.ts` (mandatory egress proxy),
`browser-session.ts` (launch, lifetime, actions, evidence). `browser.ts` keeps the older static
`web.observe` helper, which is unrelated and unchanged.

## Verification (raw output)

### Browser pack suite — `node tests/browser/run.mjs`

```
✔ real browser renders JS: snapshot -> fill -> click changes the DOM, screenshot is digested, only in-scope traffic is allowed (4817.245811ms)
✔ cross-origin navigation, non-http navigation and a cross-origin redirect hop are refused before egress (4168.09362ms)
✔ non-scope subresources and websocket upgrades are blocked at the gate before leaving the host (4439.822317ms)
✔ session action budget, per-session request budget and the target budget all fail closed (8515.456639ms)
✔ sessions are attempt-bound: another attempt can never reuse a live or a released session (4342.123905ms)
✔ attempt release kills the browser, removes the private profile and leaves no session behind (4421.710737ms)
✔ the grant deadline kills the session and the tombstone refuses further actions (8329.806134ms)
✔ DNS rebinding at connect time is refused after the session pinned its address (3253.549073ms)
✔ credential-owning accounts are refused for browser sessions; only anonymous approved accounts are used (762.861224ms)
✔ doctor and the dispatcher fail closed without the acknowledged host-browser pack, and identity drift is refused (703.463703ms)
✔ capability descriptor tampering is refused: isolation, actions, side effects, schemas, identity and limits (347.115206ms)
✔ launch hygiene: private throwaway profile, no host profile, no debug port or host path in environment or evidence (4149.476302ms)
✔ session limit and unknown/stale session ids are refused without side effects (4127.186215ms)
✔ sandbox acknowledgement and isolation claims are explicit (248.655702ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 53987.530014
```

### Raw observation from a real run (local JS fixture, two loopback origins)

Session evidence (worker-visible; note the absence of any host path/pid/port):

```json
{
  "kind": "browser-session",
  "status": "open",
  "browserId": "bs-e151668972f344c698bba67e",
  "origin": "http://127.0.0.1:45419",
  "url": "http://127.0.0.1:45419/app",
  "title": "JS Fixture",
  "chrome": {
    "version": "153.0.8010.52",
    "product": "Chrome/153.0.8010.52",
    "binarySha256": "0ba9d6c54dbc1a46dfaa5f95d5975bc9b963030c8647880f5b6a537f8af7d2e8",
    "identityDigest": "72e34ff7c9afd26299f35d97af45aff0f0d2388bfa42138549b580c3034651bb"
  },
  "budget": { "actions": 0, "actionsMax": 64, "requests": 2, "requestsMax": 64 },
  "isolation": "host-browser:not-container-isolated:chrome-153.0.8010.52:scope-enforced-at-cdp-and-egress-proxy"
}
```

The fixture page creates its content and a form with JS; snapshot → fill → click:

```
@e1 [RootWebArea] "JS Fixture"
@e2 [StaticText] "rendered-by-js"
@e4 [textbox] "Name"
@e5 [button] "Say hi"

{"before":"cfcaaa5e18e63c4457a661760404e90ce99f704eb566f813303be48ee9a8f2ab",
 "afterFill":"4e81a6bdaee92a30474fc8b024f1e8827a57cb9cfa0cdc544bd67ea29c3fbd22","fillChanged":"yes",
 "afterClick":"074e2f1eecf04148c9dea63ce2569618fb19b4d58f4faa091b3a47e6a73c8fcf","clickChanged":"yes",
 "text":"clicked:p2o\n\nrendered-by-js\n\nSay hi",
 "screenshot":{"path":"browser-run/browser-task/attempt-a/000007-c24a342c4a6daa90e79474057ee2e7f08149852d8d120de2dcb0133809d0d038.png",
   "sha256":"c24a342c4a6daa90e79474057ee2e7f08149852d8d120de2dcb0133809d0d038","bytes":8434,"mediaType":"image/png"}}
```

The out-of-scope origin never received anything; the blocked entries are the page's XHR/image plus Chrome's
own background services, all failed before egress:

```json
[
  { "seq": 15, "method": "GET", "url": "http://127.0.0.1:45529/xhr",       "resourceType": "XHR",     "decision": "blocked", "reason": "TARGET_DENIED" },
  { "seq": 17, "method": "GET", "url": "https://127.0.0.1:45529/",        "resourceType": "CONNECT", "decision": "blocked", "reason": "TARGET_DENIED" },
  { "seq": 18, "method": "GET", "url": "http://127.0.0.1:45529/pixel.png","resourceType": "Image",   "decision": "blocked", "reason": "TARGET_DENIED" },
  { "seq": 3,  "method": "GET", "url": "https://www.gstatic.com/",         "resourceType": "CONNECT", "decision": "blocked", "reason": "TARGET_DENIED" }
]
{"inScopeHits":["/app","/favicon.ico"],"outsideHits":[]}
```

Receipt (evidence-collector contract; `targets`/`budgets`/`isolation` are broker-owned):

```json
{
  "tool": { "id": "browser.act", "version": "1.0.0", "implementationDigest": "ac3ca7d25b0d2a30859a5475289b78d18bbe57d9742b4a5cdc8383e8e040e813" },
  "outcome": "collected",
  "targets": ["fixture-target"],
  "budgets": { "fixture-target": { "requests": 2, "bytes": 2683, "active": 0, "windowRequests": 0 } },
  "artifacts": [{ "path": "browser-run/browser-task/attempt-a/000008-53f2c1c71ab19494ef6daf06dd70362a9229eb1e908ee76db6b0f47e667b161a.json", "sha256": "53f2c1c71ab19494ef6daf06dd70362a9229eb1e908ee76db6b0f47e667b161a", "bytes": 4199, "mediaType": "application/json", "redacted": true }],
  "isolation": "host-browser:not-container-isolated:chrome-153.0.8010.52:scope-enforced-at-cdp-and-egress-proxy",
  "classification": "observation-not-verified-finding"
}
```

### Existing suites

```
$ npx tsc --noEmit -p tsconfig.json  → clean (no diagnostics)

$ node tests/tools/run.mjs        → ℹ tests 56  ℹ pass 56  ℹ fail 0
$ node tests/orchestrator/run.mjs → ℹ tests 59  ℹ pass 59  ℹ fail 0
$ node tests/interface/run.mjs    → ℹ tests 51  ℹ pass 51  ℹ fail 0 + JITI: PASS (14 tools/commands)
$ node tests/browser/run.mjs      → ℹ tests 14  ℹ pass 14  ℹ fail 0
$ node tests/end-to-end/run.mjs   → ℹ tests 14  ℹ pass 14  ℹ fail 0
```

The end-to-end run was executed from a copy of the tree without `examples/live-lab/.runs/`: while the
concurrent L1 workstream is running, that directory holds a live unix socket and `tests/end-to-end/
compile.mjs` copies `examples/` recursively, so the in-place runner aborts with `ERR_FS_CP_SOCKET`. Under
the same load, two timing-sensitive end-to-end assertions ("two concurrent in-flight approved requests",
"live lease during the probe") intermittently failed with load average ~11 and passed 14/14 on an idle
machine; nothing in this pack is on that path.

## What is real vs. inert

* **Real**: CDP over the host Chrome, JS execution, accessibility snapshots with working `@eN` refs,
  clicks/fills/keys that change the DOM, PNG screenshots with verified digests, per-request policy
  enforcement at the CDP layer, a mandatory egress proxy that blocks before dialing (including `wss` and
  Chrome background services), DNS pinning, target-budget charging, attempt-bound lifetime with verified
  process kill and profile removal, pinned-identity verification, and fail-closed `doctor`/descriptor checks.
* **Inert / stubbed**: nothing in the enforcement path. The tests use two loopback fixture origins rather
  than a remote target, and Chrome's own TLS trust store is used (no MITM proxy), so HTTPS/wss are enforced
  at origin/CONNECT granularity with per-request URL enforcement from the Fetch layer.

## Known limits

* `captureScreenshot` is capped at 2 MiB per shot; larger captures fail `OUTPUT_LIMIT` rather than
  truncating silently.
* Interrupted navigation caused by a blocked redirect leaves Chrome's error page as the current document
  (the session remains usable; re-navigate to continue).
* The browser pack does not inject broker-held credentials or handle downloads/uploads; only anonymous
  approved accounts are accepted.
* The egress proxy is loopback-only and unauthenticated for its session lifetime (see above).
* Application reachability is opt-in and attempt-bound: without `packs.browser` on the acknowledged host
  boundary, `browser.*` is refused by the composition even when an owner grant names the capability, and a
  session can only exist while its attempt is live with an open runtime session lease.
* WebRTC enforcement is launch-flag only (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`); the
  suite has no WebRTC test, so TCP-based WebRTC paths are untested.
