#!/usr/bin/env python3
"""Render metadata-only corpus and paraphrased evidence; never fetch or execute sources."""
from __future__ import annotations

import argparse
import copy
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = re.compile(r"\bB\d{3}\b")
EXCLUDED = {
    "B010": "Anniversary/news; no distinct validated research method.",
    "B011": "Year-in-review/news; not primary method evidence.",
    "B012": "Challenge promotion; outside the research-article corpus.",
    "B013": "Challenge rules; not vulnerability-research methodology.",
    "B015": "CTF solution; excluded rather than converted into a walkthrough.",
    "B016": "CTF solution; excluded rather than converted into a walkthrough.",
    "B019": "Challenge update announcement; not method evidence.",
    "B020": "Challenge promotion; not method evidence.",
    "B025": "Event/badge challenges; peripheral to the research-method corpus.",
    "B029": "Challenge writeup; excluded rather than converted into a walkthrough.",
    "B032": "Anniversary/news; no distinct validated research method.",
    "B033": "Challenge announcement; not primary method evidence.",
    "B036": "Event/badge material; peripheral to the research-method corpus.",
    "B052": "CNA announcement; reporting status is not research-method evidence.",
}
ALIASES = {
    "https://starlabs.sg/blog/2023/07-prctl-anon_vma_name-an-amusing-heap-spray/": "B046",
    "https://starlabs.sg/blog/2021/09-analysis-of-cve-2021-1758/": "B069",
    "https://starlabs.sg/blog/adventures-in-hypervisor-oracle-virtualbox-research/": "B081",
}


def load_json(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    # agent-browser outputPath saves its result envelope, not only the JSON value.
    if isinstance(data, dict) and isinstance(data.get("result"), str):
        return json.loads(data["result"])
    return data


def notes_by_id(root: Path) -> dict:
    notes = load_json(root / "research/extractions.json")
    result = {note["source"]: note for note in notes}
    if len(result) != len(notes):
        raise ValueError("Duplicate source extractions")
    return result


def skill_source_map(root: Path) -> dict:
    return {
        path.parent.name: sorted(set(SOURCE_ID.findall(path.read_text(encoding="utf-8"))))
        for path in sorted((root / "skills").glob("*/SKILL.md"))
    }


def bootstrap(root: Path, snapshots: list[Path]) -> dict:
    index, crawl, supplemental = map(load_json, snapshots)
    posts = index["posts"]
    if len(posts) != index["count"] or crawl["index_count"] != len(posts):
        raise ValueError("Index/crawl counts disagree")
    if set(crawl["excluded_ids"]) != set(EXCLUDED):
        raise ValueError("Review newly excluded entries explicitly")
    pages = {page["id"]: copy.deepcopy(page) for page in crawl["pages"]}
    for page in supplemental:
        original = pages[page["id"]]
        if page["url"] != original["final_url"]:
            raise ValueError("Supplemental section index is from a different URL")
        original["headings"] = page["headings"]
    notes = notes_by_id(root)
    entries = []
    for number, post in enumerate(posts, 1):
        source = f"B{number:03d}"
        entry = {"id": source, "title": post["title"], "url": post["url"]}
        if source in EXCLUDED:
            entry.update(disposition="excluded", research_type="Event/news/challenge material",
                         reason=EXCLUDED[source], skills=[], retrieval=None, observed_sections=[])
        else:
            page = pages[source]
            if page.get("http_status") != 200 or not page.get("title"):
                raise ValueError(f"Unverified page {source}")
            if page["requested_url"] != post["url"] or page["title"] != post["title"]:
                raise ValueError(f"Index/page identity mismatch: {source}")
            entry["retrieval"] = {
                "at": crawl["retrieved_at"], "http_status": page["http_status"],
                "final_url": page["final_url"], "response_html_bytes": page["html_bytes"],
                "response_html_sha256": page["html_sha256"],
            }
            entry["observed_sections"] = [h for h in page["headings"] if h.get("anchor")]
            entry["blog_links"] = page["blog_links"]
            if source == "B038":
                entry.update(disposition="duplicate", research_type="Brief reflection/impact overview",
                             reason="Merged into B037's more detailed method and scope evidence.",
                             canonical_source="B037", skills=[])
            elif source == "B044":
                entry.update(disposition="context", research_type="Hardware component teardown",
                             reason="Datasheet/component identification only; no validated bug method. B014 supplies substantive reconstruction evidence.",
                             skills=[])
            else:
                if source not in notes:
                    raise ValueError(f"Missing extraction {source}")
                entry.update(disposition="included", research_type=notes[source]["research_type"],
                             reason="Method observations retained and merged into technique owners; exploitation details excluded.",
                             evidence_level="brief-author-report" if source in {"B018", "B026"} else "method-sections-inspected",
                             skills=[])
        entries.append(entry)
    known = {entry["url"]: entry["id"] for entry in entries}
    edges = []
    for entry in entries:
        for url in entry.get("blog_links", []):
            edge = {"from": entry["id"], "url": url}
            if url in known:
                edge.update(action="indexed-page-reviewed", to=known[url])
            elif url in ALIASES:
                edge.update(action="stale-link-recovered-from-index-and-search", http_status=404,
                            to=ALIASES[url], recovered_url=entries[int(ALIASES[url][1:]) - 1]["url"])
            elif url.endswith(".zip"):
                edge.update(action="code-attachment-excluded-not-downloaded")
            else:
                raise ValueError(f"Unreviewed recursive blog edge: {edge}")
            edges.append(edge)
    return synchronize(root, {
        "schema_version": 1, "index_url": index["url"], "retrieved_at": crawl["retrieved_at"],
        "source_boundary": "Public STAR Labs blog index and relevant linked research articles; no source exploit attachments executed or retained.",
        "evidence_boundary": "Source content and methods inspected; author runtime outcomes are not independently reproduced.",
        "entries": entries, "internal_link_review": edges,
    })


def synchronize(root: Path, corpus: dict) -> dict:
    corpus = copy.deepcopy(corpus)
    notes = notes_by_id(root)
    mapping = skill_source_map(root)
    known = {entry["id"] for entry in corpus["entries"]}
    if set(notes) != {entry["id"] for entry in corpus["entries"] if entry["disposition"] == "included"}:
        raise ValueError("Retained corpus and extraction sets differ")
    for skill, ids in mapping.items():
        if set(ids) - known:
            raise ValueError(f"Unknown source IDs in {skill}")
    for entry in corpus["entries"]:
        if entry["disposition"] != "included":
            continue
        note = notes[entry["id"]]
        available = {section["text"] for section in entry["observed_sections"]}
        missing = set(note["sections"]) - available
        if missing:
            raise ValueError(f"Unobserved section locator {entry['id']}: {sorted(missing)}")
        entry["research_type"] = note["research_type"]
        entry["skills"] = sorted(skill for skill, ids in mapping.items() if entry["id"] in ids)
        if not entry["skills"]:
            raise ValueError(f"Retained source has no technique owner: {entry['id']}")
    counts = Counter(entry["disposition"] for entry in corpus["entries"])
    corpus["statistics"] = {
        "index_entries": len(corpus["entries"]), "inspected_pages": sum(bool(e["retrieval"]) for e in corpus["entries"]),
        "included_sources": counts["included"], "duplicate_pages": counts["duplicate"],
        "context_pages": counts["context"], "excluded_entries": counts["excluded"], "skills": len(mapping),
    }
    return corpus


def markdown_text(text: str) -> str:
    return text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]").replace("|", "\\|")


def skill_link(skill: str, prefix: str = "../") -> str:
    return f"[{skill}]({prefix}skills/{skill}/SKILL.md)"


def render_outputs(root: Path, corpus: dict) -> dict[Path, str]:
    notes = notes_by_id(root)
    stats = corpus["statistics"]
    catalog = [
        "# Corpus Catalog", "", "Metadata-only inventory; dispositions are scope decisions, not safety judgments.",
        f"Snapshot: {corpus['retrieved_at']}. {stats['index_entries']} screened entries; {stats['inspected_pages']} inspected pages; {stats['included_sources']} retained method sources.",
        "", "| ID | Source | Disposition | Research type / reason | Technique owners |", "|---|---|---|---|---|",
    ]
    evidence = [
        "# Source Evidence Ledger", "", "**All observations below paraphrase what the source reports.** They are not independent exploit replications or current-vulnerability claims.",
        "Exact section links locate method evidence. Defensive synthesis is explicitly inferred; limitations accompany every retained source. No original payloads, scripts, attachments, or paragraphs are copied.",
        "", f"{stats['included_sources']} retained sources support {stats['skills']} merged skills. Source IDs resolve through [catalog.md](catalog.md) and [corpus.json](corpus.json).", "",
    ]
    for entry in corpus["entries"]:
        source = entry["id"]
        title = markdown_text(entry["title"])
        link = f"[{title}]({entry['url']})"
        reason = entry["research_type"] if entry["disposition"] == "included" else entry["reason"]
        destinations = ", ".join(skill_link(skill) for skill in entry["skills"]) or "—"
        if entry["disposition"] == "duplicate":
            destinations = f"Merged into [{entry['canonical_source']}](evidence.md#{entry['canonical_source'].lower()})"
        catalog.append(f"| {source} | {link} | {entry['disposition']} | {markdown_text(reason)} | {destinations} |")
        if entry["disposition"] != "included":
            continue
        note = notes[source]
        locators = []
        for requested in note["sections"]:
            matches = [s for s in entry["observed_sections"] if s["text"] == requested]
            for number, section in enumerate(matches, 1):
                label = requested if len(matches) == 1 else f"{requested} ({number})"
                locators.append(f"[{markdown_text(label)}]({entry['url']}#{section['anchor']})")
        evidence.extend([
            f"## {source}", "", f"**Source:** {link}",
            f"**Research type:** {note['research_type']}",
            f"**Evidence level:** {entry['evidence_level']}; reported runtime results not independently reproduced.",
            "**Locators:** " + "; ".join(locators), "", "**Method observations (source-reported):**",
            *[f"- {observation}" for observation in note["observations"]], "",
            f"**Limits / failed assumptions:** {note['limitations']}",
            f"**Defensive synthesis (inferred):** {note['defensive_inference']}",
            "**Technique owners:** " + ", ".join(skill_link(skill) for skill in entry["skills"]), "",
        ])
    catalog.extend(["", "Reasons and merge boundaries: [METHOD.md](METHOD.md), [TAXONOMY.md](TAXONOMY.md).", ""])
    return {
        root / "research/corpus.json": json.dumps(corpus, ensure_ascii=False, indent=2) + "\n",
        root / "research/catalog.md": "\n".join(catalog),
        root / "research/evidence.md": "\n".join(evidence),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check without writing; nonzero on stale output")
    parser.add_argument("--bootstrap", nargs=3, metavar=("INDEX", "CRAWL", "SECTIONS"), type=Path,
                        help="Initialize metadata from agent-browser discovery/crawl/section snapshots")
    args = parser.parse_args()
    if args.check and args.bootstrap:
        parser.error("--check cannot bootstrap")
    try:
        corpus = bootstrap(ROOT, args.bootstrap) if args.bootstrap else synchronize(ROOT, load_json(ROOT / "research/corpus.json"))
        stale = []
        for path, expected in render_outputs(ROOT, corpus).items():
            if args.check:
                if not path.exists() or path.read_text(encoding="utf-8") != expected:
                    stale.append(str(path.relative_to(ROOT)))
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(expected, encoding="utf-8")
        if stale:
            print("FAIL: stale generated artifacts: " + ", ".join(stale))
            return 1
        print("PASS: research render is current" if args.check else "Rendered corpus, catalog, and evidence ledger")
        return 0
    except (OSError, KeyError, TypeError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
