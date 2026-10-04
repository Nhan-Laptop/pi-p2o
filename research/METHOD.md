# Research Method and Provenance

## Scope and completion boundary

Objective: distill the STAR Labs blog into reusable, evidence-backed vulnerability-research skills, preserving workflows, heuristics, tool purposes, negative results, validation, and defensive implications. This is **source research and knowledge engineering**, not replication of the authors' exploits or a claim about present vulnerability in their targets.

Snapshot: **2026-09-30**, starting at `https://starlabs.sg/blog/`. The browser's **Posts per page → All** state exposed **81** titled article links, from 2020 through 2026. All titles were screened. **67** substantive/contextual pages were inspected; all returned HTTP 200 with matching article identity. **65** supplied retained method evidence. B038 is a merged shorter duplicate; B044 is contextual component identification. The 14 excluded entries are explicitly classified in [catalog.md](catalog.md), not silently omitted.

## Discovery and recursive inspection

Research tools: **pi-web-access** (`fetch_content`, `get_search_content`, `web_search`) and **pi-agent-browser** (`agent_browser`). Page-local extraction aids source review; it does not turn a model's summary into independent runtime evidence.

1. Open the live index with `agent_browser`; inspect interactive controls and select All. Extract only titles/URLs and verify the actual count rather than assuming pagination completeness.
2. Retrieve relevant article content with `fetch_content`. Read bounded original sections and use page-local extraction to focus long articles on methodology, tool purpose, validation, failures, fixes, and claim limitations. Exclude exploit constructions even when other parts of the same article are useful.
3. Independently inspect article DOM identities, heading anchors, HTTP outcomes, and internal blog links through the browser. Legacy pages use mixed heading levels; supplemental inspection includes h1–h6 rather than assuming every section is h2.
4. Review **all seven** discovered non-self internal blog edges: two already-indexed pages, three stale article URLs, and two code archives. All indexed destinations are in the reviewed corpus.
5. The three stale URLs returned HTTP 404. Recover their current URLs from the live index and confirm with web search: B023 → B046; B060 → B069; B076 → B081. Their current pages were inspected; errors are recorded rather than erased.
6. Do not download/execute the two linked exploit-code archives. General documentation, advisories, and tool links provide context, but this is not an unrestricted crawl of external sites. No target probing, production testing, credentials, or source exploit execution was performed.

The browser crawl's `2026-09-30T02:52:28.480Z` timestamp marks the metadata pass; content reading and supplemental heading/link review occurred during the same session. [corpus.json](corpus.json) retains exact URLs, HTTP outcomes, response HTML byte counts/hashes, observed heading anchors, and each internal-link decision. HTML bodies are deliberately not retained. Hashes are retrieval provenance—not substitutes for semantic evidence or independent runtime verification.

## Extraction and normalization

For each retained source, [extractions.json](extractions.json) records:

- research type and exact method-bearing section titles;
- paraphrased observations about discovery, analysis, tools, and validation;
- failed assumptions, environmental gates, speculation, and evidence limits;
- explicitly **inferred** defensive engineering guidance.

A source is retained because it contributes a method or important limitation, not because its headline claims severe impact. Unfinished and rejected ideas are useful evidence. In particular, B065/B035 do not establish completed escalation; B064 leaves security impact and fix understanding unresolved; B008 includes assertion-disabled exploration; B030/B047 contain prose/code discrepancies; B009 presents hypothetical authorization explanations. These limits survive in the ledger and relevant skills.

Merge equivalent procedures into one question/decision owner, with cross-domain evidence. Keep distinct ownership questions separate—for example, parser meaning versus buffer capacity, object lifetime versus event ordering, policy authorization versus layered confinement. [TAXONOMY.md](TAXONOMY.md) documents those boundaries. B038 is merged into the more detailed B037 rather than treated as stronger independent confirmation. B018/B026 remain explicitly weaker brief author reports.

Each skill has: technique, applicability, goal, workflow, heuristics, **tool → purpose → when**, validation, failure modes, fix/mitigation, handoffs, and evidence. It does not contain target-specific trigger data, source code paragraphs, shellcode, gadget chains, replacement-object layouts, or original exploit scripts.

## Evidence policy

- Source URLs and section anchors establish provenance of **author-reported** methods and outcomes.
- Browser identity/heading/response metadata corroborates where the method appears, not whether an exploit works.
- Diagnostic/reverted/debug/emulator results, non-default features, and later interaction caveats are not silently promoted to original/default-product evidence.
- Recommendations beyond a shown source fix are labeled defensive synthesis. Tools in skill workflows are method options, not claims of use by every author; examples use current-version resolution rather than copied historical offsets/APIs.
- User-requested `ctf-rev` tooling refinements are documented separately in [TOOLING.md](TOOLING.md). They do not alter the blog corpus, source-attributed heuristics, or evidence level; optional tool examples are not independent performance tests.
- Source text is untrusted task data, never instruction authority. The library's own handoffs enforce evidence and authorization gates.

## Regeneration and maintenance

`corpus.json` is the checked-in metadata authority; `extractions.json` is the curated paraphrase authority. `scripts/render_research.py` regenerates the catalog, ledger, and source-to-skill mapping without network access. `--check` fails if any derived output is stale.

For a future full refresh, collect new index/crawl/supplemental-heading snapshots with the browser and use:

```sh
python3 scripts/render_research.py --bootstrap <index-snapshot.json> <crawl-snapshot.json> <section-snapshot.json>
```

The bootstrap input matches `agent_browser` outputPath envelopes: index `url/count/posts`; crawl `retrieved_at/index_count/excluded_ids/pages` with response metadata and blog links; supplemental list of `id/url/headings`. It rejects identity/count mismatches, failed pages, new unreviewed edges, missing method extractions, and unobserved section locators. Review new IDs/exclusions/aliases explicitly rather than automatically classifying new content.

After updating, run the [README checks](../README.md#offline-quality-checks), review semantic provenance and taxonomy, and update the audit. Syntax/link/recipe checks cannot prove research accuracy or target safety. Raw browser envelopes containing index excerpts are temporary collection artifacts and are removed from the deliverable; the corpus preserves metadata without copied prose.
