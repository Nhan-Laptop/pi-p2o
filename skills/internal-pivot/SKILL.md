---
name: internal-pivot
description: Carry a foothold into internal reach — an in-band request the compromised host makes, a reverse shell into the operator's lab listener, a recorded callback — and state the network facts instead of assuming them.
---

# Internal Pivot

Before first use, read [focused method and review](../../HANDOFFS.md#focused-method-and-review).
This procedure starts with a command or request the target side actually performed, and ends at reach you can name: a destination only the compromised host addresses, observed from that host's side, or the environment fact that closed it. Identity on the foothold is [session to root](../session-to-root/SKILL.md)'s Gate I; using a credential is [credential and pivot](../credential-and-pivot/SKILL.md).

## Entry conditions

1. A tested claim for an effect on the target side — a command the service ran, a request it made — with its receipt and control.
2. The foothold's identity and network position recorded: address, interface, resolver, proxy configuration, container or host.
3. A destination worth reaching: a service name from the target's own configuration, an internal address the target's stack resolves, a metadata endpoint, or a peer named in a response or error.
4. A transport (below). No lab network means no listener; in-band requests and a recorded callback remain available.

This procedure ships no script: the request shape is the compromised service's, not a fixed CLI, and a script that guessed one would send traffic the target never intended.

## Gates

**Gate F — state the network facts before touching a destination.**

- The assessment sandbox has unrestricted egress and can route to private, link-local and metadata addresses. That is the operator's position. A request the sandbox makes is not a request the target made, and it proves only the sandbox's reach.
- The target's reach is its own: its resolver, routes, proxy, identity and network policy. Only a request the target performed says anything about the target's network.
- There is no inbound path by default. A listener exists only when the operator started the run with `--lab-network`; it binds inside the run's session container, no host port is published, and it dies with that container. There is no tunnel, forward or proxy subsystem in this product, so do not promise one.

Record the four facts — sandbox reach, target reach, configured ingress, transport used — before the first probe.

**Gate N — name the destination from the target's own data.** Read the service's configuration, environment, resolver answers and error strings, and prefer a name or address the target already uses over a range you guessed. *Pass:* the destination has a source — a config line, a response, a resolver answer — and you can quote it. *Fail:* a sweep of an address range you invented is a scan, not a pivot, and its results belong to a scope question before they belong to a finding.

**Gate I — make the request in-band.** Send it through the compromised service with the mechanism that works, and read the answer where the service returns it or through a second-order artifact the target stored. One destination at a time, with the same request to a known-closed destination as the control. *Pass:* body, status or timing differs between open and closed destinations in a way the control does not reproduce. *Fail:* the request cannot be shaped through that service; say which part of the shape was impossible.

**Gate L — listener and callback.** When the request is blind, aim it at the listener the run recorded (lab network only) or at the callback destination the operator recorded. The observation is the arrival itself: source address, path, timestamp, client identity. The lab listener logs bytes and never answers, so it proves reach and captures a first payload; it is not an interactive session, and a missing arrival is an environment fact, not a clean negative. *Pass:* the arrival record, with a source address that belongs to the target's network position. *Fail:* no arrival and no other observation; record the blind attempt and what would have made it visible.

**Gate S — reverse shell, only when it answers a question one-shot commands cannot.** With a lab network, let the target connect out to the recorded listener and capture the first output. Keep it to one attempt, close the process once the output is captured, and record that the transport is write-only here: an arriving shell's output can be observed, its input cannot be typed into today. Use it for an identity receipt or one command's output, not for an interactive escalation. *Pass:* the first bytes are the shell's own output, from the target's address. *Fail:* the connection never arrives; return to in-band.

**Gate R — bound the reach.** Enumerate only the destinations the target's own data named, plus the small set a pivot needs to be useful — the services the target talks to. Record open and closed with a control for each, and stop when the question is answered. Record every destination the run touched so the report can state the breadth; an unbounded sweep is a scope change, not a measurement.

## Completion definition

- the destination table: address or name, port, what answered, which side made the request, timestamp, and the source that named it;
- the transport used and why the others were unavailable or unnecessary, including whether a lab network existed;
- the Gate F network facts, each with the observation behind it, sandbox and target kept separate;
- for a blind request, the arrival record with its source address, or the absence and what it does not prove;
- cleanup: listeners, background processes and files created on the target side, closed with a receipt or named as a limitation;
- the reach not established and the fact that closed it.

Not finished: a scan of a range with no source, a callback that never arrived read as isolation, a command run in the sandbox described as a pivot, or a tunnel that does not exist.

## The wall

A wall is a named check, not a verdict:

- **No ingress and no lab network.** The sandbox cannot receive; the only observations are an in-band response, a second-order artifact, or the operator's recorded callback destination. Write the environment fact and the transport you used instead of concluding the target is isolated.
- **Target egress is filtered.** A callback that never arrives is a fact about egress. Combine it with an in-band probe before saying anything about the destination.
- **The internal service trusts the target's identity, not yours.** The reach is a property of the host's credential; name the principal and take the credential step to [credential and pivot](../credential-and-pivot/SKILL.md) rather than borrowing it silently.
- **The artifact is larger than the visible cap.** A directory listing, a scan or a service body is truncated in the receipt. Keep the request narrow or store the output and quote the lines, and never read truncation as absence.
- **The next hop needs a transport this product does not have.** No tunnel, no forward, no proxy: each destination is a request someone makes. Hand the destination and the evidence to the next procedure instead of inventing a path.

The transport comparison and the network facts to write down are in [pivot transport](references/pivot-transport.md).
