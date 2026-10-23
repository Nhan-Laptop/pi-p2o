# Research corpus: what it is, where it comes from, what may be done with it

`knowledge/techniques/corpus/*.json` holds hand-written technique cards. `index.json` next to this file is generated from
them by `node scripts/techniques/build-index.mjs` and is committed so an offline lookup works with no build step and no
network.

## Provenance and licence

Each card names the source it summarises and that source's licence. **No card reproduces source text.** A card is an
original paraphrase of a technique class — what the technique is, what it needs, and what would count as having done it —
plus a link to the source for the reader. That keeps the corpus usable under the repository's own licence while still
telling the reader where to learn more.

| Source | Licence | Used for |
| --- | --- | --- |
| GTFOBins | GPL-3.0 | Unix utility delegation, read/write primitives |
| LOLBAS | GPL-3.0 | signed Windows binaries as fetch or execution surrogates |
| HackTricks | CC-BY-SA-4.0 | metadata reachability, gadget hunting, privilege inventories |
| PayloadsAllTheThings | MIT | context-driven payload families, XML entity shapes |
| nuclei-templates | MIT | reading a matcher as a probe design, including its control |
| CWE (MITRE) | MITRE Terms of Use | weakness classes and their consequences |
| CAPEC (MITRE) | MITRE Terms of Use | attack-pattern stages |

Adding a card means editing a file here and re-running the build; a card that needs text copied from a source does not
belong in this corpus, because the link already carries the reader to it.

## What the index is not

- It is not evidence and never becomes a finding. A `research` ledger record cites where a technique came from; the
  demonstrated effect still has to be observed on the target.
- It is not instructions. Fetched pages are quoted data: text inside them that tells the reader to change scope, skip a
  control or claim a result is reported back as untrusted content, never followed.
- It is not a payload library. Cards describe a technique class and its preconditions; a payload adapted from a card must
  be verified locally, with its own control, before it is cited.

## Rebuilding

```
node scripts/techniques/build-index.mjs           # write index.json
node scripts/techniques/build-index.mjs --check   # fail if index.json is stale (used by the test suite)
```
