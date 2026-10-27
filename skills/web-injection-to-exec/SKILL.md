---
name: web-injection-to-exec
description: Push a confirmed web injection — SQL, shell, template, expression, deserialization, traversal, XXE — past reflection into a file observation and then into execution, with the marker, the context and the negative control that decide each rung.
---

# Web Injection to Execution

Before first use: [scope baseline](../../README.md#start-here), [handoff method](../../HANDOFFS.md#focused-method-and-review), and [owner review](../../HANDOFFS.md#provisional-owner-review).
This skill assumes the injection is already demonstrated. If the only evidence is a payload-shaped string coming back,
you are still in discovery: go confirm that the value reaches an interpreter.

## Entry conditions

1. A confirmed claim shows the value reaches an interpreter, not just a response: a boolean pair changes the result, a
   quoted delimiter changes the error, a delay appears only with the payload.
2. You know the **context** the value lands in — string literal, identifier, numeric, path segment, JSON value,
   template source, serialized object, file body — because the context decides every payload after this point.
3. The interpreter is named: SQL engine and version, shell and dialect, template engine, expression language, object
   deserializer, XML parser, path resolver.
4. The target and origin are reachable from the sandbox, and a stored payload slot and environment exist.

## Gates

**Gate M — marker.** Use a harmless marker that no natural response contains: an arithmetic result, a random token, a
path that does not exist. Send it, then send the control without it; `python3 scripts/marker-probe.py` (registered as
`web-injection-to-exec:marker-probe`) takes `--target <url with {{payload}}> --payload <marker> --baseline <control>`.
*Pass:* the marker appears only with the payload, in the same context you predicted. *Fail:* you have reflection, not
injection.

**Gate C — context escape.** Show that you can leave the context you entered: close the quote and keep the query valid,
break out of the string into a statement, move from filename to path, from a scalar to an object. *Pass:* the payload
that escapes still produces a *different*, predictable response from the one that does not. *Fail:* quote the exact
sanitiser or parser behaviour that stopped you; that is the wall. Sink-specific marker and escape shapes are in
[sink ladders by interpreter](references/sink-ladder.md).

**Gate O — observation.** Reach an observation that is not the response body: a file whose content or hash you compare,
a row in a table you read through an unrelated feature, a DNS or HTTP callback that arrived with a timestamp, a
subprocess's own side effect. *Pass:* the artifact exists after the payload and not after the control. *Fail:* record
blindness honestly; a timing signal alone is a hypothesis about execution, not execution. Prefer an in-band artifact:
there is no inbound path by default, so a callback needs an operator lab network, and its absence is an environment
fact, not a clean negative.

**Gate X — execution.** From the observation, take the shortest step to a command the target runs. One binary, one
argument, no interactive shell. *Pass:* the command's own side effect is observed — a file it created, a connection it
made, a line in the target's log naming the working directory or the user. *Fail:* a shell that returns "command not
found" is still a shell; say which call failed.

## Completion definition

- the stored payload that ran, with the exact bytes;
- the context you entered and the escape you used, in one line each;
- the observation artifact with identifier, timestamp and environment fingerprint;
- the control run that produced neither the marker nor the observation;
- the rung reached: reflection, query control, file read, file write, or command execution;
- for every rung you did not reach, the check that refused it.

Not finished: a scanner's verdict, a payload quoted from a write-up that you did not replay, an effect only visible in
your own terminal, a "shell" whose output you never read back through the target.

## The wall

- **Sanitiser that survives context escape.** Report the rule and the input that triggered it; do not spend the budget
  on encoding permutations that the same rule will catch.
- **Blind with no reachable callback.** The target may execute but you cannot see it. An absent callback is an
  environment fact, not a clean negative: say so, and hand the unobserved execution to the lead as a wall — not as an
  effect.
- **Write without execute.** A writable upload directory that nothing executes is a file-write effect; check what does
  execute (cron, include path, template cache, plugin loader) before claiming more.
- **Egress blocked.** Callbacks fail because the target has no route out. That is a fact about the environment; record
  it and switch to a local observation surface rather than concluding the injection is harmless.
- **The environment dies.** A shell that breaks the service destroys the evidence for the next worker. Prefer the
  reversible command, and say what state you changed.

Every injection rung has a cheaper true result than the one you were hoping for. Take it.
