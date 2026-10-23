# Sink ladders by interpreter

For each class: the marker that proves you are in the interpreter, the context escapes that usually work, and the
shortest route to a file observation and then a command. Everything here assumes an authorized target and a payload
you can store.

## SQL

- Marker: `' AND 1=2--` versus `' AND 1=1--` (engine-specific comment), or a sleep only on one branch.
- Escape: string literal, then `UNION` with matching column count and types, then stacked queries if the driver allows.
- File observation: read a known file through the engine's file primitive, or write one to a path the engine can reach.
  MySQL `INTO OUTFILE`, PostgreSQL `COPY ... FROM PROGRAM`, MSSQL `xp_cmdshell`, SQLite `readfile()`/`writefile()`.
- Command: only where the engine itself shells out. Prove the shell's side effect, not the query's response.
- Refusals to expect: least-privilege database user, disabled `FILE` privilege, disabled stacked queries, WAF on quotes.

## Shell

- Marker: `; echo MARKER`, `$(echo MARKER)`, backticks — pick the one whose output lands where you predicted.
- Escape: argument boundary (space, quote, newline), then new argument, then new command.
- Observation: a file the process creates under a path you can read back, or a callback.
- Command: already there at gate M; the interesting step is privilege — which user runs it, and is that user interesting.

## Template and expression languages

- Marker: `{{7*7}}`, `${7*7}`, `#{7*7}`, `<%= 7*7 %>` — send all and read which one evaluates.
- Escape: the engine's own object graph. A method call on a reachable object is control; a full sandbox escape is a
  separate, larger claim.
- Observation: computed value in the response, then a file read through the object graph, then a process call.
- Refusals: sandboxed engines, whitelisted methods, output escaping that erases the evaluated result.

## Deserialization

- Marker: a benign object that changes a field in the response, not a gadget chain.
- Escape: type confusion, magic method on a serializable class, then a gadget that reaches a file or process call.
- Observation: a side effect of a magic method — a file written on destruct, a connection made on wakeup.
- Command: only with a gadget chain you can explain class by class; "ysoserial with all gadgets" is a scanner result.

## Path and file handling

- Marker: a path that exists versus one that does not, with the same suffix.
- Escape: `..`, absolute path, encoded separators, null byte, alternate separator on Windows.
- Observation: read a file whose content you can verify by hash; write a file and read it back through a different route.
- Command: only if a write target is executed (cron, include, plugin, template cache, startup script).

## XML and parsers

- Marker: an external entity that resolves to a value you can see.
- Escape: entity expansion, parameter entities, `file://`, `http://` to a listener you own.
- Observation: file content in the response, or the callback arrival.
- Refusals: DTDs disabled, external entities off, hardened parser defaults.

## Blind cases

When nothing returns, the marker must be a side effect elsewhere: timing with a distribution, a callback, a record that
appears for another user, a cache entry that changes the next response, an error rate that moves. Each of these needs a
control run, and a timing claim needs at least five controls before you quote a number.
