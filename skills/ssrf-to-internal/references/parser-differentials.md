# When the validator and the fetcher disagree

An SSRF control is a parser plus a policy. The bypass lives where the parser that validates and the parser that fetches
read the same bytes differently — or where the fetch performs a second resolution the check never saw.

## Check these pairs

| Differential | Shape | Why it works |
| --- | --- | --- |
| Userinfo | `http://allowed.example@169.254.169.254/` | validator reads the authority up to `@` as the host, fetcher uses what follows |
| Fragment | `http://allowed.example#@169.254.169.254/` | fragment stripped in one parser only |
| Encoded separators | `%2f`, `%5c`, `%00` in the path or host | decoding order differs between check and connect |
| Numeric hosts | `http://2130706433/`, `http://0177.0.0.1/`, `http://0x7f.1/` | inet_aton accepts forms the allowlist regex does not model |
| Trailing dot | `http://allowed.example./` | suffix match on `.example` and DNS treats the dot as root |
| IPv6 forms | `http://[::ffff:127.0.0.1]/`, `http://[0:0:0:0:0:ffff:7f00:1]/` | text normalization again |
| Redirect | allowlisted URL that 302s to a forbidden host | policy enforced on the first hop only |
| DNS rebinding | domain you control resolves allowed then internal | check-time resolution differs from connect-time |
| Case and IDN | `http://ALLOWED.EXAMPLE/`, punycode equivalents | case-insensitive suffix checks and punycode folding |
| Scheme confusion | `http://allowed.example\\@internal/` | backslash treated as separator by some clients |

## Probing order

1. Read the validator's actual rule if the source is available; do not brute-force a regex you can read.
2. Send the canonical forbidden destination and confirm it is refused. That is your control.
3. Change exactly one property per attempt, so the result is attributable.
4. Confirm the fetch happened from the target's side — callback, reflected body, or a target-specific error.

## Common non-bypasses

- A host allowlist that resolves names, compares IPs, then connects to the resolved IP.
- Redirects followed only to URLs that pass the same policy.
- A proxy that rejects non-http schemes before any parser sees the URL.
- A network policy where 169.254.0.0/16 has no route and `file://` is disabled.

Recording a non-bypass is useful: it tells the next worker which class is closed instead of re-testing it.
