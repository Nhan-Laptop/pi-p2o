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
- **Who writes what:** the planner records hypotheses, settled hypotheses and observed relations; a worker records assets, facts,
  anchors, open hypotheses and `basis=inferred` relations (host-stamped `unverified:true` with its producer role — that row is
  review debt the owner settles by superseding with supported/refuted/inconclusive); the host `extractor` producer writes only
  what a bounded parse of a retained artifact yields (see **Extraction** below); the reporter reads only. An owner retest is a note record (`data.caseRetest`), and the project knowledge database is written only by an owner-requested export. A worker brief carries a bounded slice (matching asset, latest facts, open leads/gaps, ready chain steps) labelled
  background, never a finding. The host counts each worker's write-back and shows `NO_GRAPH_WRITE` in `p2o_workers`, the
  report and the preflight as an advisory — not a review or finish condition.
- `p2o_graph {action:"chain"}` is a read-only join over claims: `ready` (an open step whose `needs` are all gained by a
  confirmed+tested claim), `unmet` (naming the missing capability kind), `legacy` (free-text edges that match nothing) and
  `frontier` (shortest primitive-to-claim path). Planner-only, writes nothing, grants nothing.
- `p2o_graph {action:"query"}` answers "which current rows match" with bounded filters (`kind`, `keyPrefix` requiring a
  kind, `labelContains`, `attributeKey`+`attributeValue`, `assertionKind`, `statementContains`); it is SQL over current
  heads with a sequence cursor, true totals and `omitted`/`nextCursor`, and its encoded response is trimmed to ≤24 KiB.
  `action:"summary"` answers "what moved and what is missing" (new/changed assets, assets with no claim or coverage cell,
  open hypotheses, inferred relations, accepted findings by asset, chain frontier) with ≤10 rows per list and its own
  8 KiB bound; when a dense graph overflows it drops machine rows and reports `omittedRows` while the counts stay true.
- `view` also returns a **derived dossier** for the one asset (facts, hypothesis counts and open rows, relations, claims
  with stale/demonstrated, cases, coverage cells with `noCell`, tasks, gaps) capped at 24 KiB with omission counters. A
  dossier, summary, query row or brief delta is background: none of them can satisfy a claim, case or coverage cell.
- **Extraction (R2):** `src/extract/` holds pure parsers for nmap XML, httpx JSON/JSONL, nuclei JSONL, a raw HTTP response,
  OpenAPI/Swagger and the common package manifests (npm/pnpm locks, requirements pins, go.mod, Cargo.lock, Gemfile.lock,
  pom.xml); each ingest is bounded to 4 MiB of input, 200 assets / 1,000 facts / 200 components, 7 KiB per row and 2,000
  records, and malformed bytes produce a warning rather than an error into the model call. Parsers normalize identity
  deterministically (URL/route/package key) while the raw value stays in an anchor or attribute — a scoped exception to the
  exact-bytes rule above, recorded as D-R1-2. A nuclei match becomes an **open hypothesis**, never a fact, claim or case.
- **Ingest path (R2):** a recognized capture artifact of a `shell`/`capture`/`http` receipt is extracted automatically (best
  effort, ≤50 per run, stdout stream only), and `p2o_graph {action:"ingest", id:"artifact-…"}` retries it by hand. Rows are
  written by the host `extractor` producer (depth 0) with the artifact's receipt as `evidenceRefs`; an ingest without a
  same-run receipt is refused. The artifact is recorded as an anchor row on the first ingested asset, so the same bytes
  produce one asset and only add observation lineage on re-ingest. Extracted rows are `unverified` background and do not
  enter the owner's `GRAPH_UNREVIEWED` queue.
- **Inventory and CVE join (R2):** a `package` asset requires `name`/`version`/`ecosystem` and the canonical key
  `ecosystem:name@version` (duplicate versions merge; an unversioned package is refused; optional CPE 2.3). `query
  {kind:"package"}` returns the inventory with attributes, `summary` counts components without a CVE query, and
  `p2o_research {action:"cve", componentRef:"asset-…"}` derives the NVD query from the ecosystem's naming convention. A lead
  may carry `versionMatch` (`in-range`/`out-of-range`/`unparsed` — a labelled suggestion, never proof) and
  `exploitability {kev, epss, percentile, retrievedAt, …}` joined by CVE id from CISA KEV and FIRST EPSS with cached
  provenance; when a feed cannot be read the value is `unknown`, never `false` or `0`. `## LEADS` prints both and orders
  KEV-listed first, then EPSS, while the published severity is never re-rated.
- **Reachability (R3):** every relation kind carries one role — traversable, conditional (traversed but marked) or
  informational (`variant_of`/`anchors`/`derived_from`, never walked) — exposed as `traversable`/`conditional` on read rows
  and pinned by test. `p2o_graph {action:"path", fromId, toId?, toKind?, effect?, maxDepth≤6, maxNodes≤500, kinds?}` walks
  current relation heads breadth-first (≤10 paths, deterministic order, `noPath`/`cycle`/`truncated` markers, withdrawn and
  stale edges counted but never walked, ≤24 KiB). `effect` is a capability from the one vocabulary: the host reports which
  hop a demonstrated claim (with host-stamped assets) supplies, or the last hop when nothing does. A `chain` frontier step
  also names its `startingAsset`, resolved from the deepest provider's host-stamped asset refs.
- **Technique crosswalk (R3):** `src/attack-map.ts` maps 104 in-scope WSTG tests to a curated, pinned subset of MITRE
  ATT&CK Enterprise (v18.1); `docs/ATTACK_MAP.md` is the readable table and the tests keep both equal. ATT&CK ids are
  **derived** from the WSTG keys a case already carries (no model-writable field) and printed in the case section,
  `findings.json`/`findings.csv` and SARIF/STIX properties. A mapping is a judgement about behaviour, not a detection claim.
- **Finding identity, retest and interop (R3):** `findingId = sha256(scope, policyKey, rootCauseKey, sorted asset
  kind/key)[:32]` is host-derived and stable across revisions, ratings and evidence; it appears in `findings.json`, the CSV
  and SARIF `partialFingerprints`. An owner retest is its own note (`data.caseRetest`) against one accepted case revision
  with verdict `still_reproducible`/`fixed`/`cannot_confirm` (the first two need same-run evidence, the last may cite none);
  it never changes the verdict, review status or pinned cells. SARIF 2.1.0 (`findings.sarif`) ships with every v2 report;
  the STIX 2.1 bundle (`findings.stix.json`) is opt-in with `/p2o report export … --stix` and both are manifest-hashed.
- **Project knowledge (R3):** an opt-in project-scoped SQLite history (`.p2o-project-knowledge.sqlite` for
  `/p2o report export … --project-knowledge`), keyed by tenant + target, append-only with run provenance, synced by
  finding id and asset kind/key. It is **suggested context only**: printed as prior knowledge and written as
  `prior-knowledge.json`, never a graph fact, never a receipt, and never enough to confirm a claim, a case or a coverage
  cell; a conflict keeps both rows and a moved target marks the old rows stale instead of deleting them.
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
  licence and sha256; `web:false` never touches the network. `action=fetch` retrieves any http(s) URL host-side under a bounded
  citation fetcher (15 s timeout, 4 MiB body cap, ≤5 redirects, loopback/link-local/private/metadata destinations refused) and
  returns the possibly truncated body with status, content type, size and sha256 plus a `research` record — never evidence
  (Part XI: no allowlist; R0/D-R1-4 adds the bounds). `action=cve` makes the host fetch NVD/CVE pages and writes a `lead` record
  (`untriaged`, then `tasked`/`ruled_out` by triage). A lead is a pointer: a claim citing one stays `inferred`/`open_proof_gap`
  and cannot be confirmed. Research is not a target operation and is never a finding.
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
