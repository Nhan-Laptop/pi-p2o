---
name: ssrf-to-internal
description: Take a server-side fetch from "the target made a request" to "the target read an internal service", mapping the reachable network, the parsers that disagree about the URL, and the metadata endpoints that hold credentials.
---

# SSRF to Internal Reachability

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).
What the target can reach is the question. A range the box routes to is a destination to test, and its response is
the evidence.

## Entry conditions

1. A confirmed claim shows the value controls the destination of a request the **target** performs — not a request your
   client performs. The proof is a callback that arrived, or a fetched resource whose content changed with the URL.
2. You know what constrains the URL: scheme allowlist, host allowlist, port allowlist, redirect policy, DNS resolution
   order, and whether the response body comes back to you.
3. A listener you control is reachable from the target, or the response body is readable — one of the two, or this is a
   blind fetch and needs a different observation.
4. Target and origin are reachable, and a stored payload and environment exist.

## Gates

**Gate B — blind or reflected.** Establish which one you have before mapping anything. Reflected: the fetched body
comes back. Blind: only the callback proves the fetch. *Pass:* you can name which one, and the observation surface that
corresponds to it. *Fail:* an error message that mentions the host is not a fetch.

**Gate R — reachability.** Walk outward from the target, one destination at a time: loopback ports, the target's own
hostnames, link-local metadata, private ranges the target routes to. For each, record what answered: status, length,
error string, timing, or callback. *Pass:* at least one destination that your own client cannot reach answers through
the target. *Fail:* everything answers identically — you may be looking at a cached error page; vary the path.

**Gate P — parser differential.** If an allowlist exists, test whether the validator and the fetcher read the URL the
same way: userinfo, encoded separators, trailing dot, decimal or octal IP forms, IPv6 brackets, redirect to a forbidden
host, DNS name that resolves differently between check and fetch. *Pass:* one input passes the check and reaches a
destination the check meant to forbid, demonstrated by the fetch. *Fail:* the allowlist holds; say which normalization
saved it.

**Gate D — data.** Read something that only the internal destination holds: a metadata credential document, an admin
page, an internal API listing, a file through `file://` if the scheme is allowed. *Pass:* the content is in your
observation and identifies the service. *Fail:* reachability without data is still a real effect; report it as such.

## Completion definition

- the stored payload for each probe that ran, and the callback log or response diff that shows the fetch;
- the reachability table: destination, what answered, through which input, at what time;
- the parser differential, if one was found, as validator-versus-fetcher in one line each;
- the strongest data read, quoted with its source service;
- for anything not reached, whether it was refused by a check or simply absent.

Not finished: a port list from a scanner you did not run through the target, "internal network access" inferred from an
error string, a metadata endpoint fetched by your own client instead of the target's.

## The wall

- **No callback and no reflected body.** You cannot see the fetch. Hand the blind-fetch capability to chaining; do not
  infer reachability from timing on a single request.
- **Scheme locked to https.** `file://`, `gopher://` and `dict://` are gone; reachability still works if a host
  allowlist is the only control.
- **DNS pinning between check and fetch.** The differential disappears; record it, because it tells the next worker
  which class of bypass is already closed.
- **Egress filtering that permits only the allowlisted host.** Reachability is then a question about that host's own
  proxy behaviour, not about the network.
- **Metadata credentials that expire before use.** Reading them is the effect; using them is the next step, and
  [credential and pivot](../credential-and-pivot/SKILL.md) takes it from there.

Reachability is a fact about the network. Record which hop you proved: the wall is the hop that did not answer, and
the report carries it as readily as a success.
