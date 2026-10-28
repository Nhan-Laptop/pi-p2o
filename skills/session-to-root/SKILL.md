---
name: session-to-root
description: Take a demonstrated shell or in-band command execution to a root observation of the compromised workload — enumeration discipline, the path menu from sudo to the container boundary, the receipt that backs a root claim, and the honest wall when the boundary holds.
---

# Session to Root

Before first use, read [focused method and review](../../HANDOFFS.md#focused-method-and-review).
It starts after [web injection to execution](../web-injection-to-exec/SKILL.md) or [exploit design](../exploit-design/SKILL.md) produced a command the target ran, and ends at a root observation of that workload or the check that refused it.

## Entry conditions

1. A claim is confirmed, its execution is tested on the recorded revision, and the effect is a command the target ran, with the receipt and the control that did not run it.
2. You observed the identity the foothold runs as, from the target side, and recorded it. A guessed service user is not an identity.
3. A transport can carry further commands: in-band requests through the exploited service by default, a listener only when the operator joined a lab network.
4. Root means root of the compromised workload — its container, its namespace, the account its service runs as. The sandbox is already root on a writable file system with default capabilities; that root proves nothing about the target. Host-kernel compromise and container escape are out of scope.

This procedure ships no script: each step is a command aimed at the foothold already held, and a script that guessed it would be a payload, not a procedure.

## Gates

Run them in order; each has a pass condition you can point at and a refusal you accept.

**Gate I — identity.** Run one command that answers who you are on the target and record its output: user and group ids, supplementary groups, host name, container marker, working directory. *Pass:* the receipt names an identity and a boundary — an application user in a container, a service account, a shell reached as the web daemon. *Fail:* the response came from a page you can also make the target echo; that is reflection with a shell-shaped body, not identity.

**Gate E — enumerate from the system's own data.** Walk the whole path menu once; one refusal closes one entry, never the menu:

- **sudo.** Readable rules for your identity, whether a password is required, the version.
- **SUID and capabilities.** Files carrying a set-uid bit or elevated file capabilities you can execute or overwrite.
- **Writable configuration.** Files root reads or executes that you can write: service definitions, startup scripts, configuration a privileged process loads.
- **Services.** Root-run daemons with a control surface you can reach: a local socket, a loopback port, an agent.
- **Scheduled work.** Cron, timers and queue workers whose scripts or payloads you can write.
- **Container boundary.** Sockets, host paths, environment and metadata credentials visible inside the workload; an escape is out of scope and untested here.
- **Another identity.** Credentials, keys and environment that grant a different principal; [credential and pivot](../credential-and-pivot/SKILL.md) uses them.

For each entry record what would be written or executed, who controls it, and the check that would refuse it. *Pass:* every entry visited or marked not applicable with the fact, and one names a concrete crossing operation. *Fail:* "nothing obvious" after one command is not enumeration; the menu is the denominator.

**Gate X — cross with the smallest reversible operation.** Execute the one operation that reaches root, choose the variant that changes the least, and read the effect from the system's own answer: a new command reporting uid 0, a file only root can read, a root-owned path that now holds your bytes. *Pass:* the crossing is observed from the far side, twice, through a repeatable command. *Fail:* the refusal is the result: quote the permission error, password prompt, immutable flag or policy layer, and name the menu entry it closes.

**Gate R — corroborate the root observation, do not restate it.** A `whoami` or `id` line is text, and text that arrived through the same injection that produced it can be forged by that injection. Root is proven when a root-only operation succeeds and its side effect is observed independently of the payload: reading a file your former identity was refused, writing where only root writes, starting a service your former identity could not start. A kernel or package version below a fixed release is a hypothesis about the host, not a root observation. *Pass:* the identity output and the root-only artifact agree, and a second, different command re-observes the same identity. *Fail:* you have a string that says root and no capability only root has; record an unverified observation, not a claim.

## Transport

- **In-band (default).** One request per command through the exploited service, with the receipt discipline of any target operation, and the only transport when the operator configured no ingress. Keep commands short; store long transcripts in scratch before quoting.
- **Reverse shell into the lab listener.** Only with an operator lab network: the target connects out to the recorded address, and the listener logs what arrives without answering — one shell's first output, not a terminal. No host port, and it dies with its session container.
- **Callback or session PTY.** An operator callback proves reach, not root; a session PTY drives your own container, never the target.

## Completion definition

A finished escalation step contains all of these and nothing invented:

- the foothold's identity receipt and the boundary it sits behind;
- the path menu with each entry visited or not applicable, and the check that closed it;
- the crossing operation and receipt, and the root-only artifact with path, hash or content and timestamp;
- the second, different observation of the same identity, or why no second transport exists;
- the boundary the root crossed — workload, not host kernel — with the container or namespace fact that shows it;
- cleanup: every process, file, account, service change or schedule entry the attempt created, removed with a receipt or named as a limitation;
- the rungs not reached and the checks that stopped them.

Not finished: a prompt glyph, a matching advisory, a banner, an error message, or a shell that only echoes. Do not add persistence — no account, key, unit, cron entry or service — to make a rung easier to show; the one-off crossing is the proof, and a durable change to the target is damage, not evidence. Do not clear, edit or rotate logs, and do not disable a control to pass a gate. If a step cannot avoid changing state, say what changed in the same report.

## The wall

A wall is a named check, not a verdict:

- **The privilege boundary holds.** Sudo asks for a secret you do not have, no set-uid file is both usable and writable, the configuration is root-owned and not writable, and no scheduled job resolves through you. Report the boundary, the checks that held and the depth reached.
- **The container is the boundary.** Root inside the workload's namespace is the ceiling. Kernel exploitation, namespace or capability escape and container breakout are out of scope, untested, and never inferred from the workload's root.
- **No ingress.** A reverse shell needs the operator's lab network; without it, in-band execution is the transport, and a silent listener is the configured shape, not a target failure.
- **Output exceeds the visible cap.** A long enumeration is truncated; the cap is a fact about the run, not the target. Keep the command narrow, or write its output to scratch and quote it.
- **The next step needs another identity.** Hand the foothold and boundary to chaining rather than guessing a credential.

The menu, its read and its crossing are in [privilege escalation paths](references/privilege-escalation-paths.md).
