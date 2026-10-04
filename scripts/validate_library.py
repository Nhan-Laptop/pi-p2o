#!/usr/bin/env python3
"""Offline editorial/structural checks, not vulnerability or exploit verification."""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit

from render_research import load_json, notes_by_id, render_outputs, skill_source_map, synchronize
from orange_research import validate as validate_orange

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_SECTIONS = (
    "Technique", "When to Use", "Goal", "Workflow", "Research Heuristics", "Tools",
    "Validation", "Common Failure Modes", "Fix / Mitigation", "Handoffs", "Evidence",
)
LINK = re.compile(r"\[[^\n]*?\]\(([^\s)]+)\)")
RECIPE_PATTERNS = {
    "encoded byte payload": re.compile(r"(?:\\x[0-9a-fA-F]{2}){3,}"),
    "target-specific address/offset": re.compile(r"\b0x[0-9a-fA-F]{3,}\b"),
    "CVE-specific skill content": re.compile(r"CVE[-_]\d{4}[-_]\d+", re.I),
    "source-specific endpoint": re.compile(r"https?://(?:\d{1,3}\.){3}\d{1,3}"),
    "executable recipe fence": re.compile(r"^```", re.M),
    "operational reverse-shell command": re.compile(r"(?:/dev/tcp/|nc\s+.*\s-e\s|bash\s+-i\b)"),
    "external CTF skill/helper dependency": re.compile(r"(?:/skill:ctf-rev\b|(?:^|[/\\])ctf-rev[/\\]|\.revtools[/\\])", re.M),
}


def frontmatter(text: str) -> tuple[dict, str]:
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("missing YAML frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise ValueError("unterminated YAML frontmatter") from error
    fields = {}
    for line in lines[1:end]:
        match = re.fullmatch(r"([a-z-]+): (.+)", line)
        if not match or match[1] in fields:
            raise ValueError("invalid/duplicate scalar frontmatter field")
        fields[match[1]] = match[2]
    if set(fields) != {"name", "description"}:
        raise ValueError("expected name and description")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", fields["name"]) or len(fields["name"]) > 64:
        raise ValueError("invalid skill name")
    if not 20 <= len(fields["description"]) <= 1024 or ": " in fields["description"]:
        raise ValueError("description must be a valid nonempty plain YAML scalar")
    return fields, "\n".join(lines[end + 1:])


def sections(body: str) -> dict[str, str]:
    matches = list(re.finditer(r"^## (.+)$", body, re.M))
    return {
        match[1]: body[match.end():matches[i + 1].start() if i + 1 < len(matches) else len(body)].strip()
        for i, match in enumerate(matches)
    }


def slug(text: str) -> str:
    text = re.sub(r"[`*_]", "", text).lower()
    return re.sub(r"[^\w -]", "", text).replace(" ", "-")


def markdown_anchors(text: str) -> set[str]:
    return {slug(match[1]) for match in re.finditer(r"^#{1,6} (.+)$", text, re.M)}


def validate_links(path: Path, root: Path, entries: dict) -> list[str]:
    errors = []
    for target in LINK.findall(path.read_text(encoding="utf-8")):
        parts = urlsplit(target)
        if parts.scheme in {"http", "https"}:
            base = target.split("#", 1)[0]
            if base in entries and parts.fragment:
                anchors = {s["anchor"] for s in entries[base]["observed_sections"]}
                if unquote(parts.fragment) not in anchors:
                    errors.append(f"{path.relative_to(root)}: unobserved source anchor {target}")
            continue
        if parts.scheme:
            errors.append(f"{path.relative_to(root)}: unsupported link scheme {target}")
            continue
        destination = (path.parent / unquote(parts.path)).resolve() if parts.path else path.resolve()
        if not destination.is_relative_to(root.resolve()):
            errors.append(f"{path.relative_to(root)}: link escapes library {target}")
        elif not destination.is_file():
            errors.append(f"{path.relative_to(root)}: broken local link {target}")
        elif parts.fragment and destination.suffix == ".md":
            anchors = markdown_anchors(destination.read_text(encoding="utf-8"))
            if unquote(parts.fragment) not in anchors:
                errors.append(f"{path.relative_to(root)}: broken local anchor {target}")
    return errors


def validate(root: Path) -> list[str]:
    errors = []
    try:
        corpus = load_json(root / "research/corpus.json")
        notes = notes_by_id(root)
        entries = corpus["entries"]
        by_id = {entry["id"]: entry for entry in entries}
        by_url = {entry["url"]: entry for entry in entries}
        if len(by_id) != len(entries) or len(by_url) != len(entries):
            errors.append("duplicate source ID or URL")
        orange_metadata = load_json(root / "research/orange/source-metadata.json")
        by_url.update({e["url"]: {**e, "observed_sections": e.get("observed_sections", [])} for e in orange_metadata["entries"]})
        if corpus.get("schema_version") != 1:
            errors.append("unsupported corpus schema")
        included = {e["id"] for e in entries if e["disposition"] == "included"}
        if included != set(notes):
            errors.append("retained sources/extractions differ")
        for entry in entries:
            source = entry["id"]
            if not re.fullmatch(r"B\d{3}", source) or not entry["title"] or not entry["research_type"] or not entry["reason"]:
                errors.append(f"{source}: incomplete corpus identity/type/reason")
            if not entry["url"].startswith("https://starlabs.sg/blog/"):
                errors.append(f"{source}: out-of-scope source URL")
            if entry["disposition"] not in {"included", "duplicate", "context", "excluded"}:
                errors.append(f"{source}: invalid disposition")
            retrieval = entry["retrieval"]
            if entry["disposition"] != "excluded":
                if not retrieval or retrieval.get("http_status") != 200 or retrieval.get("final_url") != entry["url"]:
                    errors.append(f"{source}: missing or failed article retrieval")
                elif not re.fullmatch(r"[0-9a-f]{64}", retrieval.get("response_html_sha256", "")) or retrieval.get("response_html_bytes", 0) <= 0 or not retrieval.get("at"):
                    errors.append(f"{source}: incomplete retrieval provenance")
            elif retrieval or entry["skills"]:
                errors.append(f"{source}: excluded entry treated as method evidence")
            if entry["disposition"] == "duplicate" and entry.get("canonical_source") not in included:
                errors.append(f"{source}: duplicate has no retained canonical source")
            if source not in included:
                continue
            note = notes[source]
            if not entry["skills"]:
                errors.append(f"{source}: source without skill owner")
            for key in ("research_type", "limitations", "defensive_inference"):
                if not isinstance(note.get(key), str) or len(note[key]) < 20:
                    errors.append(f"{source}: missing {key}")
            if not isinstance(note.get("observations"), list) or len(note["observations"]) < 2 or any(len(o) < 30 for o in note["observations"]):
                errors.append(f"{source}: inadequate method observations")
            observed = {section["text"] for section in entry["observed_sections"]}
            if not note.get("sections") or set(note["sections"]) - observed:
                errors.append(f"{source}: unobserved section locator")
        for edge in corpus["internal_link_review"]:
            if edge["from"] not in by_id:
                errors.append("internal edge has unknown origin")
            if edge["action"] == "code-attachment-excluded-not-downloaded":
                if not edge["url"].endswith(".zip"):
                    errors.append("excluded code edge is not a code archive")
            elif edge["action"] == "indexed-page-reviewed":
                if edge.get("to") not in by_id or by_id[edge["to"]]["url"] != edge["url"]:
                    errors.append("internal edge destination mismatch")
            elif edge["action"] == "stale-link-recovered-from-index-and-search":
                if edge.get("http_status") != 404 or edge.get("to") not in included or edge.get("recovered_url") != by_id[edge["to"]]["url"]:
                    errors.append("stale source link unresolved")
            else:
                errors.append("unreviewed internal blog edge")
        actual_edges = {(e["id"], url) for e in entries for url in e.get("blog_links", [])}
        reviewed_edges = {(e["from"], e["url"]) for e in corpus["internal_link_review"]}
        if actual_edges != reviewed_edges:
            errors.append("recursive link review coverage differs")
        errors.extend(validate_orange(root))

        paths = sorted((root / "skills").glob("*/SKILL.md"))
        skill_documents = sorted((root / "skills").rglob("*.md"))
        if not paths:
            errors.append("no skills")
        paragraphs = {}
        technique_names = set()
        mapping = skill_source_map(root)
        for path in paths:
            label = str(path.relative_to(root))
            text = path.read_text(encoding="utf-8")
            try:
                fields, body = frontmatter(text)
            except ValueError as error:
                errors.append(f"{label}: {error}")
                continue
            if fields["name"] != path.parent.name:
                errors.append(f"{label}: name/directory mismatch")
            parts = sections(body)
            for section in REQUIRED_SECTIONS:
                if len(parts.get(section, "")) < 30:
                    errors.append(f"{label}: missing/empty {section}")
            if body.count("## Technique") != 1:
                errors.append(f"{label}: not one focused technique")
            technique = parts.get("Technique", "")
            if technique in technique_names:
                errors.append(f"{label}: duplicate technique")
            technique_names.add(technique)
            workflow = parts.get("Workflow", "")
            if "→" not in workflow or len(re.findall(r"^\d+\. ", workflow, re.M)) < 4:
                errors.append(f"{label}: workflow lacks sequence/steps")
            tools = [line for line in parts.get("Tools", "").splitlines() if line.startswith("- ")]
            if len(tools) < 2 or any(line.count("→") != 2 for line in tools):
                errors.append(f"{label}: tools lack purpose/when mapping")
            heuristics = [line for line in parts.get("Research Heuristics", "").splitlines() if line.startswith("- ")]
            if len(heuristics) < 3 or any(not re.search(r"\[B\d{3}\]\(.*evidence\.md#b\d{3}\)", line) for line in heuristics):
                errors.append(f"{label}: heuristics lack granular source citations")
            ids = set(mapping[path.parent.name])
            if ids - set(by_id):
                errors.append(f"{label}: unknown source citation")
            if len(ids & included) < 3:
                errors.append(f"{label}: insufficient independent method sources")
            if any(by_id[i]["disposition"] in {"excluded", "duplicate"} for i in ids & set(by_id)):
                errors.append(f"{label}: excluded/duplicate counted as evidence")
        for path in skill_documents:
            label = str(path.relative_to(root))
            text = path.read_text(encoding="utf-8")
            body = text
            if path in paths:
                try:
                    _, body = frontmatter(text)
                except ValueError:
                    continue
            for rule, pattern in RECIPE_PATTERNS.items():
                if pattern.search(text):
                    errors.append(f"{label}: prohibited {rule}")
            if re.search(r"\b(?:TODO|TBD|FIXME)\b", text):
                errors.append(f"{label}: unfinished placeholder")
            if len(text.split()) > 1500:
                errors.append(f"{label}: document exceeds focused reading budget")
            content = re.sub(r"^#{1,6} .*$", "", body, flags=re.M)
            for paragraph in re.split(r"\n\s*\n", content):
                normalized = " ".join(paragraph.split())
                if len(normalized.split()) < 18:
                    continue
                if normalized in paragraphs:
                    errors.append(f"{label}: duplicate paragraph with {paragraphs[normalized]}")
                paragraphs[normalized] = label
        counts = Counter(e["disposition"] for e in entries)
        expected_stats = {
            "index_entries": len(entries), "inspected_pages": sum(bool(e["retrieval"]) for e in entries),
            "included_sources": counts["included"], "duplicate_pages": counts["duplicate"],
            "context_pages": counts["context"], "excluded_entries": counts["excluded"], "skills": len(paths),
        }
        if corpus["statistics"] != expected_stats:
            errors.append("corpus statistics disagree with current artifacts")
        synced = synchronize(root, corpus)
        for path, expected in render_outputs(root, synced).items():
            if not path.exists() or path.read_text(encoding="utf-8") != expected:
                errors.append(f"stale generated artifact {path.relative_to(root)}")
        handoffs = (root / "HANDOFFS.md").read_text(encoding="utf-8")
        for number in range(1, 6):
            if not re.search(rf"^## H{number} — .+ → .+$", handoffs, re.M):
                errors.append(f"missing required handoff H{number}")
        if handoffs.count("**Acceptance gate:**") < 6 or handoffs.count("**Return condition:**") < 5:
            errors.append("handoffs lack acceptance/rejection gates")
        scaffold = load_json(root / "templates/handoff.json")
        if scaffold.get("classification") != "unresolved" or not {"scope", "question", "predictions", "evidence", "modifications", "negative_controls", "failed_assumptions", "reproduction", "untested_scope", "contract_specific_fields", "next_action", "stop_condition"} <= set(scaffold):
            errors.append("handoff scaffold incomplete or falsely completed")
        pipeline_fields = {"peer_trust_model", "representation_ledger", "phase_and_reentry_edges", "effective_encoding_configuration", "logical_vs_allocation_bounds", "legitimate_peer_controls", "enforcement_state",
                           "intermediary_role_map", "dispatch_phase_model", "cache_selection_contract", "result_and_failure_contract", "observation_stage_ledger", "worker_and_state_history", "failure_reset_contract", "publication_policy_state", "mediated_request_contract", "producer_emission_constraints", "provisional_owner_review"}
        if not pipeline_fields <= set(scaffold.get("contract_specific_fields", {})):
            errors.append("composed pipeline scaffold incomplete")
        for document in [root / "README.md", root / "HANDOFFS.md", *sorted((root / "research").rglob("*.md")), *skill_documents]:
            errors.extend(validate_links(document, root, by_url))
        for name in ("discovery.json", "index-browser.json", "source-metadata.json", "coretext-navigation.json", "additional-headings.json"):
            if (root / "research" / name).exists():
                errors.append(f"temporary browser collection artifact retained: {name}")
    except (OSError, KeyError, TypeError, ValueError) as error:
        errors.append(f"invalid/missing library data: {error}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    errors = validate(args.root.resolve())
    if errors:
        for error in errors:
            print("FAIL: " + error)
        return 1
    corpus = load_json(args.root / "research/corpus.json")
    stats = corpus["statistics"]
    print(f"PASS: {stats['skills']} skills; {stats['index_entries']} catalog entries; {stats['included_sources']} evidence sources; format, links, provenance, mapping, handoffs, freshness, and recipe checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
