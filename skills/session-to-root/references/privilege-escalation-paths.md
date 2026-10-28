# Privilege escalation paths

Read the menu from the foothold, in this order, and record the check that closes each entry. A path is a hypothesis until
the system itself shows the crossing; the skill in [session to root](../SKILL.md) is the procedure, and this card is the
menu with the read that finds each path and the crossing that proves it.

## The menu

| Path | Read on the foothold | The crossing | What closes it |
| --- | --- | --- | --- |
| sudo policy | The rules for your identity, the fields that allow a command, the sudo version, and whether a password is asked | One allowed command that a root-run editor, pager, interpreter or file tool executes without a secret | A password prompt you cannot answer, no matching rule, or a version whose behaviour does not match the rule |
| SUID and SGID files | Every file with a set-uid or set-gid bit that your identity may execute, and whether any is writable | The binary's own root-side effect: a shell it drops, a file it writes as root, an argument or environment it trusts | No such file, a binary that only runs fixed code, or a mount option that ignores the bits |
| File capabilities | The capability set on binaries your identity can run, and the file each capability would let you reach | A binary holding exactly the capability a target file needs, used on that file | No capability, or a capability whose scope does not reach a file you want |
| Writable configuration | Which files root reads or executes that your identity can write: service definitions, startup scripts, library paths, application configuration | The privileged process reloads, restarts or re-reads and takes your bytes as its own | Root-owned and not writable, a read-only mount, or a signature or verification step that runs first |
| Services | Processes and their users, listening sockets and their permissions, admin endpoints bound to loopback | An unauthenticated control socket, an admin endpoint on loopback, or a management agent that acts as root | Authentication you do not hold, or a socket owned by a user that is not yours |
| Scheduled work | Cron files and directories, timers, queue definitions and the scripts they run | A job that executes a script, payload or environment you can write | A root-owned script, an immutable unit, or a job that runs somewhere your write does not reach |
| Container boundary | Mounts, socket files, environment values, metadata credentials and the process's namespace view | Out of scope: a namespace or capability escape and a host-kernel exploit are untested in this product | The boundary itself, recorded as a fact: root inside the workload is the ceiling here |
| Another identity | Keys, credential files, configuration secrets and environment values that belong to a privileged principal | Verify it once and read what it opens; the crossing is the privileged operation, not the file read | Nothing usable, an expired secret, or a principal whose own sessions are all that the material reaches |

Each entry is cheap to close and expensive to skip. A menu with six entries marked not applicable and one real path beats
one attempt that failed and a conclusion.

## What a root observation needs

1. **An identity receipt from the target side.** One command whose full output names the user, the groups and the host,
   with the transport that carried it. A prompt glyph is not a receipt.
2. **A root-only capability.** Something the former identity could not do and the current one can: read a root-owned file,
   write where only root writes, signal a root process, or start a unit. The artifact is the proof, the identity string is
   the label.
3. **A second, different observation.** A different command through a different transport, or the same capability reached
   by a different operation. One line of output is one sample.
4. **The boundary sentence.** Say which boundary the root crossed: the workload's container, the workload's namespace, or
   the host account the service runs as. Say when it did not cross the host kernel and did not leave the container.

## What is not on this menu

Persistence — an account, an authorised key, a unit, a cron entry or a modified service — is not a proof of anything and
damages the target; the one-off crossing is the evidence. Log clearing or editing, control disabling, and anti-forensic
work are out of scope for this library, and no gate here rewards them. Kernel exploitation, container escape and denial of
service are not tested and are never inferred from the workload's own root.

## Recording the result

For each path: the read that found it, the crossing operation, the artifact that shows the effect, and the check that
closed it. For the finished step: the one path that worked, the two observations that agree, the cleanup of everything the
attempt created, and the rungs not reached with the reason. A closed menu with a named boundary is a complete result; a
root string with no root-only artifact is not.
