# Pivot transport and network facts

A pivot is a request performed by the compromised host, observed where the operator can see it. This card compares the
transports that exist today and lists the facts to write down before the first probe. The procedure is [internal
pivot](../SKILL.md).

## Transports

| Transport | Who starts it | What it observes | What it cannot do | Available when |
| --- | --- | --- | --- | --- |
| In-band request through the exploited service | The target, using the service's own mechanism | The service's response body, status, timing, or an artifact the target stores for later | Carry anything the service cannot shape; keep a session open | Always. It is the default and the only one with no ingress |
| Reverse shell into the lab listener | The target connects out to the run's listener | Arrival, source address, and the first bytes the shell writes | Return input: the listener records and does not answer, so it is a capture surface, not a terminal | Only when the operator started the run with `--lab-network` |
| Operator callback destination | The target connects out to a destination the operator recorded | Arrival at the operator's own infrastructure, with source address and timestamp | Return a payload into the target | When the operator recorded a callback |
| Session shell | The run's own sandbox container | The sandbox's files, processes and PTY, on the operator side | Touch the target: it is the operator's container | When the run uses session executors |
| Direct request from the sandbox | The assessment sandbox | Only what the sandbox can reach, and the sandbox's view of the destination | Prove the target can reach anything | Always, and it is not a pivot |

The first row and the last row are easy to confuse. A sandbox request to a private address is an ordinary network
operation; a request the exploited service performs is a fact about the target's network. Keep them in separate columns of
your notes and in separate sentences of the report.

## Network facts to write down

- **Sandbox reach:** unrestricted egress, including private, link-local and cloud-metadata ranges. This is the operator's
  position and it is wider than most targets' reach.
- **Target reach:** whatever the target's own resolver, routes, proxy configuration, network policy and identity allow.
  It is observed only by a request the target performs.
- **Ingress:** none by default. A lab network gives the run one listener inside its session container, no published host
  port, and nothing that answers on the target's behalf. There is no tunnel, forward or proxy subsystem.
- **The listener's lifetime:** it belongs to the session container and is removed with it. A listener started in one
  session is not reachable from another.
- **What an arrival proves:** that a request left the target and reached that address, with the source the target used.
  It does not prove what the destination returned, what the target did with the answer, or that the destination is
  internal to the target's network.

## Reading a blind result

- **Arrival, expected source:** reach, plus the target's network position. Record the address, port and time.
- **No arrival, egress test passes:** the destination is not reachable from that host, or the request was not made. Say
  which of the two you can distinguish, and how.
- **No arrival, egress test also fails:** egress is filtered or unavailable. That is an environment fact; it is not
  evidence about the destination and it is not a clean negative.
- **Arrival from an unexpected source:** something else on the network answered or forwarded the request. Record the
  source and treat the reach as belonging to that source until proven otherwise.

## Destinations worth naming first

Services the target's own configuration points at, the resolver names it uses, loopback and admin ports on its own host,
link-local metadata addresses, and the socket and service files visible inside the workload. A destination with a quoted
source is a pivot; a destination from a guessed range is a scan, and the report must call it one.
