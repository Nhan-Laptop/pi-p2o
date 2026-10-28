# Run knowledge: graph, heads, skills and research

Reading knowledge never grants a tool, network route, identity or filesystem capability: the run's blanket authorization
grants the instrument, and knowledge only helps decide what to do with it. Target execution stays in the host-managed
sandbox.

## Asset / fact graph (K3)

The graph is the run's knowledge — not scope authorization, not a verified finding, not a second task store. It lives in the
same SQLite store as everything else; there is no graph database and no second writer.

- **Identity:** the scope hash is identity version + target + sha256 of the confirmed source snapshot; an asset id is
  `hash(scope, kind, key)` (24 hex) and a revision is `<entityId>-rN`. Keys are exact bytes — paths, URLs, case and IPv6 are
  never normalized. The same content does not create a revision; a different producer keeps its own observation.
- **Provenance** (actor/task/role/depth) is stamped by the host registry, never claimed by a batch. Every fact/hypothesis is
  `unverified: true`; several producers are not independent evidence. An observed/configuration fact needs a same-run receipt;
  missing, foreign or imported ids are refused.
- **Pinning:** `expectedRevision`, `assetRevision`, `fromRevision`/`toRevision` and `supersedes` are checked before commit; a
  stale write rolls back the whole batch and makes dependent claims stale. History and counterevidence are kept.
- **Who writes what:** the planner records hypotheses and relations, a worker records assets, facts and anchors, the reporter
  reads only. A worker brief carries a bounded slice (matching asset, latest facts, open leads/gaps, ready chain steps) labelled
  background, never a finding. The host counts each worker's write-back and shows `NO_GRAPH_WRITE` in `p2o_workers`, the
  report and the preflight as an advisory — not a review or finish condition.
- `p2o_graph {action:"chain"}` is a read-only join over claims: `ready` (an open step whose `needs` are all gained by a
  confirmed+tested claim), `unmet` (naming the missing capability kind), `legacy` (free-text edges that match nothing) and
  `frontier` (shortest primitive-to-claim path). Planner-only, writes nothing, grants nothing.
- Limits: pages of 20 (≤100), results ≤24 KiB, batch ≤128 rows (≤128 KiB, ≤8 KiB/row, ≤10 anchors/asset). A run's base caps
  are 5,000 asset revisions, 10,000 assertions, 2,000 relations, 20,000 anchors and 40,000 provenance rows, multiplied by
  `graphCapacity` (settings 1–4, default 2). Reaching a cap says `capacity reached`; nothing is pruned automatically.

## Knowledge heads and context packets (K6)

Schema 7 adds `knowledge_heads` (a rebuildable index of task/plan/case/legacy-cell/candidate/gap/phase/report/evidence heads)
and `knowledge_links` connecting the ids it keeps. No model turn, no retry, no dispatch: a packet is request-local
navigation, and reading it changes no authority.

- A **packet** carries run/role/task, the sequence barrier, exact counts, shown/omitted ids, changes, attention, rotating
  gap/review pages and relevance rows, bounded to 20 KiB (planner, worker, reporter; 16 KiB for a human digest). A new
  request replaces the old packet; it never edits the system prompt or tools.
- The planner-only `backlog` appears only when something is waiting: unplanned assets, derived cells not yet run, and WSTG
  suggestions. It has a total and at most five ids per section — no score, no task, no dispatch; the planner still decides,
  including `blocked`.
- The **delivery cursor** advances only on a successfully committed assistant `message_end` (not `agent_start`) and records
  a consumed packet in one transaction; a stale, forged, aborted or revoked acknowledgement does not advance it. An
  acknowledgement is a delivery receipt, not a review.
- Read paths: `/p2o heads [domain|all] [cursor] [limit] [status]`, `/p2o show <domain> <id>`, `/p2o digest`, `/p2o search`
  and `p2o_state` (`heads`/`search`). Domains: task, goal, todo, decision, case, coverage-plan, coverage-cell (legacy stored
  cells only; derived cells are read through `p2o_board board=coverage`), candidate, gap, phase, report, evidence, reference.
  Search is a 2–80 character case-insensitive substring over committed record text, returning ≤20 redacted pointers, never
  evidence. The planner gets 400 reads, a worker 160 of its 200 knowledge/coordination calls. `/p2o status` still reads the
  ledger directly, not the heads.

## Skills, research and duties

- Catalog ids are not host paths: every component is opened relative to a held directory FD without following symlinks, and
  only registered documents are reachable. `p2o_skill_list` pages 8 playbooks/overlays at a time; `p2o_skill_read` follows
  `nextOffset` and covers skills, references, recipes, scripts, `shared:scope`, `shared:handoffs` and `shared:wstg-map`.
  `materialize: true` copies a registered skill script into the caller's own scratch and returns path/hash/size (hash
  mismatch or denied write fails closed).
- `skills/catalog.json` separates technique, playbook and overlay, and lists descriptive workflow prerequisites; a draft's
  `workflow` is validated against the skills it assigns (loadout max 3, overlays count), never used to infer tools. When
  `skills` is omitted, `PURPOSE_SKILLS` in `src/roles.ts` picks a default set from the work purpose, and a second axis lets
  target kind and consumed capabilities pick the family member (a URL run maps with `web-deployment-hygiene` and discovers
  with `web-route-input-inventory`; URL refinement/retest get no method default, because both are source-tree methods). An
  empty purpose list is a decision, not a gap: validation and reporting ship none by default (reproduction must not
  discover, synthesis must not author fixes), so the role default applies only when no purpose is supplied at all. A
  validation task that names the claim's `needs` gets that claim's ladder instead (D37): replaying the method is
  reproduction, not discovery. The
  3-skill cap is recorded rather than silent: a capped task stores the delivered set and writes the dropped ids as a
  lifecycle fact, and `p2o_coverage_suggest` returns the map's related skills next to the owner and card. Nine purposes each
  carry a duty line the worker reads.
- `p2o_research {query}` looks a technique up in the committed corpus (`knowledge/techniques/`) and returns cited entries with
  licence and sha256; `web:false` never touches the network. `action=fetch` retrieves any http(s) URL host-side and returns
  the full body with status, content type, size and sha256 plus a `research` record — never evidence (Part XI: no allowlist,
  no response cap). `action=cve` makes the host fetch NVD/CVE pages and writes a `lead` record (`untriaged`, then
  `tasked`/`ruled_out` by triage). A lead is a pointer: a claim citing one stays `inferred`/`open_proof_gap` and cannot be
  confirmed. Research is not a target operation and is never a finding.
- A bounded tool probe replaces assuming an unknown tool: cite its receipt, install userspace tooling into scratch through
  `p2o_net`. The browser is not an unknown tool — the image ships Chromium and the `agent-browser` CLI (see
  [HTTP transport](HTTP_TRANSPORT.md)).

## Optional offline tool image

The default image can lack Semgrep and several userspace analysis tools. This is explicit operator setup, never an agent
step:

```sh
bash scripts/setup-sandbox-tools.sh --build
pi --p2o-image sha256:<64-hex image id the build printed>
```

The build always pins Semgrep 1.179.0; `--with=<tool1,tool2,…>` adds tools from a fixed list at build time. Nothing is
built or pulled automatically, mutable tags are rejected, and the confirmation names the image that worker tickets bind.
The running container is otherwise unchanged: `--with` is operator convenience, not a capability gate, and an agent
can still install tooling into scratch at run time. It only pre-installs tools that were already reachable through
the sandbox.

| `--with` name | Install | Purpose |
|---|---|---|
| `angr` | pip `angr==10.0.3` in `/opt/p2o-angr` | symbolic execution and binary analysis library |
| `z3` | pip `z3-solver==5.1.0.0` in `/opt/p2o-z3` | SMT solver library and `z3` CLI |
| `binwalk` | pip `binwalk==2.1.0` in `/opt/p2o-binwalk` | firmware and image signature scanning |
| `mitmproxy` | pip `mitmproxy==12.2.3` in `/opt/p2o-mitmproxy` | intercepting proxy (`mitmdump`) for lab traffic |
| `unicorn` | pip `unicorn==2.1.4` in `/opt/p2o-unicorn` | CPU-emulation library for small emulation probes |
| `pwntools` | pip `pwntools==4.15.0` in `/opt/p2o-pwntools` | binary/CTF scaffolding: ELF/ROP helpers and tube I/O |
| `strace` | apt package `strace` | syscall tracing for runtime differentials |
| `socat` | apt package `socat` | ad-hoc relays and listeners for a lab peer |
| `ssh` | apt package `openssh-client` | `ssh`/`scp`/`sftp` client for a lab peer |
| `afl++` | apt package `afl++` | coverage-guided fuzzing (`afl-fuzz`) |
| `radare2` | apt package `radare2` | binary inspection and disassembly (`r2`, `rabin2`) |
| `tcpdump` | apt package `tcpdump` | packet capture on the container's interfaces |
| `java` | apt package `default-jre-headless` | Java runtime for JVM-based tooling |

Python tools are exact-pinned in their own venv. The apt tools are installed by package name: the base image is Kali
rolling, ships no package lists, and publishes no stable version to pin, so the build records the resolved `dpkg`
versions in `/opt/p2o-apt/versions.txt` and the printed immutable image ID is the pin.
