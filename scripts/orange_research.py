#!/usr/bin/env python3
"""Offline Orange corpus rendering and editorial gates; no network or target execution."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = re.compile(r"\bO\d{3}\b")
DISPOSITIONS = {"included", "context", "excluded", "duplicate", "unavailable"}
KINDS = {"workflow", "heuristic", "tool", "validation", "failure", "handoff", "remediation"}
REQUIRED = {"schema_version", "source_id", "url", "observed_title", "retrieved_at", "retrieval", "disposition", "reason", "canonical_source", "evidence", "workflow", "tools", "handoffs", "limitations", "candidate_additions", "related_article_urls", "excluded_material", "worker_notes"}
UNSAFE = re.compile(r"(?:CVE[-_]\d{4}[-_]\d+|\b0x[0-9a-fA-F]{3,}\b|(?:\\x[0-9a-fA-F]{2}){3,}|/dev/tcp/|^```)", re.M | re.I)


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]").replace("|", "\\|").replace("\n", " ")


def inventory(root: Path) -> dict:
    return load(root / "research/orange/inventory.json")


def packets(root: Path, index: dict) -> dict:
    return {entry["id"]: load(root / f"research/orange/extractions/{entry['id']}.json") for entry in index["entries"]}


def skill_map(root: Path) -> dict[str, list[str]]:
    mapping = {}
    for directory in sorted((root / "skills").iterdir()):
        if not (directory / "SKILL.md").is_file():
            continue
        mapping[directory.name] = sorted({source for p in directory.rglob("*.md") for source in SOURCE_ID.findall(p.read_text(encoding="utf-8"))})
    return mapping


def effective_candidate(report: dict, decision: dict, number: int) -> dict:
    candidate = dict(report["candidate_additions"][number])
    override = decision.get("candidate_overrides", {}).get(str(number), {})
    return {**candidate, **override}


def render_outputs(root: Path) -> dict[Path, str]:
    index = inventory(root)
    reports = packets(root, index)
    decisions = {d["source_id"]: d for d in load(root / "research/orange/curation.json")["entries"]}
    metadata = {e["id"]: e for e in load(root / "research/orange/source-metadata.json")["entries"]}
    delegation = {e["source_id"]: e for e in load(root / "research/orange/delegations.json")["entries"]}
    verification = {e["source_id"]: e for e in load(root / "research/orange/quote-verification.json")["entries"]}
    mapping = skill_map(root)
    entries = []
    for row in index["entries"]:
        source = row["id"]
        report, decision = reports[source], decisions[source]
        entry = {**row, "disposition": decision["disposition"], "reason": decision["reason"],
                 "canonical_source": decision.get("canonical_source"), "skills": sorted(s for s, ids in mapping.items() if source in ids),
                 "accepted_candidates": decision["accepted_candidates"], "review_notes": decision.get("review_notes", ""),
                 "retrieval": metadata[source], "worker": delegation[source]["agent_name"],
                 "extraction_sha256": hashlib.sha256((root / f"research/orange/extractions/{source}.json").read_bytes()).hexdigest(),
                 "candidate_overrides": decision.get("candidate_overrides", {}),
                 "quote_publication_url": verification[source]["publication_url"]}
        entries.append(entry)
    counts = Counter(e["disposition"] for e in entries)
    stats = {"index_entries": len(entries), "article_workers": len(delegation), "read_articles": sum(p["retrieval"]["outcome"] == "read" for p in reports.values()),
             "retained_method_sources": counts["included"], "context_sources": counts["context"], "excluded_sources": counts["excluded"],
             "duplicate_sources": counts["duplicate"], "unavailable_sources": counts["unavailable"],
             "updated_skill_owners": sum(bool(ids) for ids in mapping.values())}
    corpus = {"schema_version": 1, "index_url": index["index_url"], "retrieved_at": index["retrieved_at"], "pagination": index["pagination"],
              "source_boundary": "All entries in the three-page Orange Articles archive; one pi-herdr worker per article. Related links are pointers, not an unrestricted crawl.",
              "evidence_boundary": "Public source methodology and exact quotations checked; author vulnerability outcomes not independently reproduced. Handoff contracts are derived library synthesis.",
              "statistics": stats, "entries": entries}
    catalog = ["# Orange Articles Catalog", "", "Every archive URL was delegated separately, including excluded and contextual sources. Dispositions are relevance/evidence decisions, not safety judgments.", "",
               f"{len(entries)} archive entries; {stats['article_workers']} dedicated article workers; {counts['included']} retained method sources; {counts['context']} contextual, {counts['excluded']} excluded, {counts['duplicate']} merged duplicate. Pagination and exact URLs: [inventory.json](inventory.json).", "",
               "| ID | Article | Decision | Reason | Generic skill owners |", "|---|---|---|---|---|"]
    ledger = ["# Orange Method Evidence", "", "Method observations are source-author reports, not target replications. Small source quotations establish provenance only. Workflow paraphrases and proposed handoffs do not establish vulnerability or current exposure.", "",
              "The orchestrator's accepted candidates, editorial qualifications and operational citations govern inclusion. Unselected candidates and worker handoff proposals remain auditable but are not adopted procedures. Explicit tool attribution means source-named, not necessarily source-operated or locally tested.", "",
              "Independent wording/source checks: [quote-verification.json](quote-verification.json). All article packets, including contextual/excluded and duplicate entries, remain in the [catalog](catalog.md).", ""]
    for entry in entries:
        source = entry["id"]
        report = reports[source]
        owners = ", ".join(f"[{s}](../../skills/{s}/SKILL.md)" for s in entry["skills"]) or "—"
        catalog.append(f"| {source} | [{text(entry['title'])}]({entry['url']}) | {entry['disposition']} | {text(entry['reason'])} | {owners} |")
        if entry["disposition"] != "included":
            continue
        ledger.extend([f"## {source}", "", f"**Article:** [{text(entry['title'])}]({entry['url']})", f"**Worker:** `{entry['worker']}`; [packet](extractions/{source}.json).",
                       f"**Orchestrator decision:** {entry['reason']}"])
        if entry["quote_publication_url"] != entry["url"]:
            ledger.append(f"**Quotation origin:** [directly linked full publication]({entry['quote_publication_url']}); the Orange article is its archive wrapper, not the quoted body.")
        if entry["review_notes"]:
            ledger.append(f"**Editorial qualifications:** {entry['review_notes']}")
        ledger.extend(["", "**Method evidence (short source quotations):**"])
        for quote in report["evidence"]:
            ledger.append(f"- **{quote['id']}** — {text(quote['locator'])}: “{text(quote['quote'])}”")
        ledger.extend(["", "**Adopted or merged generic refinements (paraphrased, not necessarily novel):**"])
        for number in entry["accepted_candidates"]:
            candidate = effective_candidate(report, decisions[source], number)
            ledger.append(f"- `{candidate['owner']}` / {candidate['kind']}: {candidate['guidance']} (evidence {', '.join(candidate['evidence'])}).")
        if report["tools"]:
            ledger.extend(["", "**Tool attribution:**"])
            for tool in report["tools"]:
                ledger.append(f"- {tool['tool']} → {tool['purpose']} → {tool['when']}; **{tool['attribution']}** attribution.")
        if report["handoffs"]:
            ledger.extend(["", "**Proposed handoffs (derived, not author-agent claims):**"])
            for handoff in report["handoffs"]:
                ledger.append(f"- `{handoff['producer']}` → `{handoff['consumer']}` when {handoff['when']}. Packet: {', '.join(handoff['packet'])}. Gate: {handoff['acceptance_gate']}. This is an unadopted worker proposal; use the [owned contracts](../../HANDOFFS.md) and editorial qualifications.")
        ledger.extend(["", "**Limits:**", *[f"- {limit}" for limit in report["limitations"]], "", f"**Operational owners:** {owners}", ""])
    catalog.extend(["", "[Method and audit](METHOD.md) · [Evidence](evidence.md) · [Machine-readable corpus](corpus.json)", ""])
    return {root / "research/orange/corpus.json": encoded(corpus), root / "research/orange/catalog.md": "\n".join(catalog), root / "research/orange/evidence.md": "\n".join(ledger)}


def validate(root: Path, *, freshness=True) -> list[str]:
    errors = []
    try:
        index = inventory(root)
        rows = index["entries"]
        by_id = {e["id"]: e for e in rows}
        if len(by_id) != len(rows) or len({e["url"] for e in rows}) != len(rows):
            errors.append("Orange duplicate inventory ID/URL")
        pagination = index["pagination"]
        if len(rows) != sum(pagination["entry_counts"]) or pagination["markers_observed"] != [f"Page {i} of 3" for i in range(1, 4)] or pagination["page_3"].find("no forward link") < 0:
            errors.append("Orange pagination coverage differs")
        if [e["id"] for e in rows] != [f"O{i:03}" for i in range(1, len(rows)+1)]:
            errors.append("Orange inventory ordering/ID coverage differs")
        if any(not e["url"].startswith("https://blog.orange.tw/posts/") for e in rows):
            errors.append("Orange out-of-scope article URL")
        reports = packets(root, index)
        metadata_rows = load(root / "research/orange/source-metadata.json")["entries"]
        metadata = {e["id"]: e for e in metadata_rows}
        decisions_rows = load(root / "research/orange/curation.json")["entries"]
        decisions = {e["source_id"]: e for e in decisions_rows}
        delegation_rows = load(root / "research/orange/delegations.json")["entries"]
        delegation = {e["source_id"]: e for e in delegation_rows}
        quotes_rows = load(root / "research/orange/quote-verification.json")["entries"]
        quotes = {e["source_id"]: e for e in quotes_rows}
        runtime_rows = load(root / "research/orange/worker-runtime-receipts.json")["entries"]
        runtime = {e["source_id"]: e for e in runtime_rows}
        for label, records, keyed in [("metadata", metadata_rows, metadata), ("curation", decisions_rows, decisions), ("delegation", delegation_rows, delegation), ("quote verification", quotes_rows, quotes), ("runtime", runtime_rows, runtime)]:
            if len(records) != len(keyed) or set(keyed) != set(by_id):
                errors.append(f"Orange {label} coverage differs")
        if len({e["agent_name"] for e in delegation_rows}) != len(rows):
            errors.append("Orange one-worker-per-article identity differs")
        if len({e.get("session", {}).get("id") for e in runtime_rows}) != len(rows):
            errors.append("Orange one-worker-per-article session identity differs")
        mapping = skill_map(root)
        owners = set(mapping)
        cited = {s for ids in mapping.values() for s in ids}
        if cited - set(by_id):
            errors.append("Orange unknown operational source ID")
        for source, row in by_id.items():
            report, decision, meta, worker, verified = reports[source], decisions[source], metadata[source], delegation[source], quotes[source]
            if not REQUIRED <= set(report) or report["schema_version"] != 1 or report["source_id"] != source or report["url"] != row["url"]:
                errors.append(f"{source}: Orange incomplete/mismatched packet")
                continue
            if worker["url"] != row["url"] or worker["status"] != "completed" or worker["model"] != "openai-codex-account-3/gpt-6.1-sol:max" or not worker.get("pane_id") or not worker.get("completed_at"):
                errors.append(f"{source}: Orange delegation incomplete")
            observed = runtime[source]
            if observed.get("agent_name") != worker["agent_name"] or not observed.get("session", {}).get("id") or observed.get("model", {}).get("provider") != "openai-codex-account-3" or observed.get("model", {}).get("modelId") != "gpt-6.1-sol" or observed.get("thinking", {}).get("thinkingLevel") != "max":
                errors.append(f"{source}: Orange observed worker runtime mismatch")
            if meta["url"] != row["url"] or not meta.get("retrieved_at"):
                errors.append(f"{source}: Orange metadata identity missing")
            disposition = decision["disposition"]
            if disposition not in DISPOSITIONS or len(decision["reason"]) < 20 or not isinstance(decision["accepted_candidates"], list):
                errors.append(f"{source}: Orange invalid curation decision")
            if not report["limitations"] or not report["retrieved_at"] or len(report["reason"]) < 20:
                errors.append(f"{source}: Orange missing scope limits")
            evidence = {q["id"]: q for q in report["evidence"]}
            checked = {q["id"]: q for q in verified["quotes"]}
            if len(evidence) != len(report["evidence"]) or len(checked) != len(verified["quotes"]) or set(evidence) != set(checked) or len(evidence) > 5:
                errors.append(f"{source}: Orange evidence coverage differs")
            if verified.get("url") != row["url"] or verified.get("final_url") != row["url"] or verified.get("http_status") != 200 or not verified.get("retrieved_at") or not re.fullmatch(r"[0-9a-f]{64}", verified.get("article_text_sha256", "")):
                errors.append(f"{source}: Orange independent source receipt invalid")
            origin = verified.get("publication_url")
            if origin != report["retrieval"]["final_url"]:
                errors.append(f"{source}: Orange quotation origin mismatch")
            if origin != row["url"]:
                publication = verified.get("publication_verification", {})
                if publication.get("source_id") != source or publication.get("publication_url") != origin or not publication.get("retrieved_at") or not publication.get("tool") or not re.fullmatch(r"[0-9a-f]{64}", publication.get("rendered_body_sha256", "")) or publication.get("quotes") != verified["quotes"]:
                    errors.append(f"{source}: Orange linked-publication receipt invalid")
            for number, quote in evidence.items():
                if not re.fullmatch(r"E[1-9]\d*", number) or not 1 <= len(quote["quote"]) <= 180 or len(quote["locator"]) < 5 or quote["verified"] is not True:
                    errors.append(f"{source}: Orange invalid method quotation")
                if checked.get(number, {}).get("matched") is not True or checked.get(number, {}).get("quote_sha256") != hashlib.sha256(quote["quote"].encode()).hexdigest():
                    errors.append(f"{source}: Orange quote not independently verified")
                if checked.get(number, {}).get("match_mode") not in {"exact", "whitespace-normalized"}:
                    errors.append(f"{source}: Orange unsupported quote matching mode")
            for field in ("workflow", "tools", "handoffs", "candidate_additions"):
                for item in report[field]:
                    if not isinstance(item.get("evidence"), list) or not item["evidence"] or set(item["evidence"]) - set(evidence):
                        errors.append(f"{source}: Orange unknown/missing evidence reference")
            for tool in report["tools"]:
                if tool["attribution"] not in {"explicit", "derived"} or not all(tool.get(k) for k in ("tool", "purpose", "when")):
                    errors.append(f"{source}: Orange invalid tool attribution")
            for handoff in report["handoffs"]:
                if handoff["producer"] not in owners or handoff["consumer"] not in owners or handoff["classification"] != "derived" or not handoff["packet"] or not handoff["acceptance_gate"]:
                    errors.append(f"{source}: Orange invalid derived handoff")
            for candidate in report["candidate_additions"]:
                if candidate["owner"] not in owners or candidate["kind"] not in KINDS or len(candidate["guidance"]) < 20 or UNSAFE.search(candidate["guidance"]):
                    errors.append(f"{source}: Orange unsafe/unowned candidate guidance")
            overrides = decision.get("candidate_overrides", {})
            if not isinstance(overrides, dict) or any(not k.isdigit() or int(k) >= len(report["candidate_additions"]) or not isinstance(v, dict) or set(v) - {"owner", "kind", "guidance"} for k, v in overrides.items()):
                errors.append(f"{source}: Orange invalid candidate override")
            accepted = decision["accepted_candidates"]
            if len(set(accepted)) != len(accepted) or any(not isinstance(n, int) or isinstance(n, bool) or n < 0 or n >= len(report["candidate_additions"]) for n in accepted):
                errors.append(f"{source}: Orange accepted candidate index invalid")
            else:
                for number in accepted:
                    candidate = effective_candidate(report, decision, number)
                    if candidate["owner"] not in owners or candidate["kind"] not in KINDS or len(candidate["guidance"]) < 20 or UNSAFE.search(candidate["guidance"]):
                        errors.append(f"{source}: Orange unsafe/unowned adopted guidance")
                    elif source not in mapping[candidate["owner"]]:
                        errors.append(f"{source}: Orange adopted candidate lacks owner citation")
            if disposition == "included":
                if report["retrieval"]["outcome"] != "read" or not evidence or len(report["workflow"]) < 2 or not accepted or source not in cited:
                    errors.append(f"{source}: Orange retained source lacks supported operational contribution")
                if meta.get("http_status") != 200 or meta.get("final_url") != row["url"] or not re.fullmatch(r"[0-9a-f]{64}", meta.get("response_html_sha256", "")) or meta.get("response_html_bytes", 0) <= 0:
                    errors.append(f"{source}: Orange retained source retrieval failed")
            elif accepted or source in cited:
                errors.append(f"{source}: Orange excluded/context/duplicate counted as operational evidence")
            if disposition == "duplicate":
                canonical = decision.get("canonical_source")
                if canonical == source or canonical not in decisions or decisions[canonical]["disposition"] != "included":
                    errors.append(f"{source}: Orange duplicate canonical source not retained")
        if freshness and not errors:
            for path, expected in render_outputs(root).items():
                if not path.exists() or path.read_text(encoding="utf-8") != expected:
                    errors.append(f"Orange stale generated artifact {path.relative_to(root)}")
    except (OSError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
        errors.append(f"Orange invalid/missing corpus data: {error}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    if args.validate:
        errors = validate(ROOT)
    else:
        try:
            errors = []
            for path, expected in render_outputs(ROOT).items():
                if args.check:
                    if not path.exists() or path.read_text(encoding="utf-8") != expected:
                        errors.append(f"Orange stale generated artifact {path.relative_to(ROOT)}")
                else:
                    path.write_text(expected, encoding="utf-8")
        except (OSError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            errors = [f"Orange invalid/missing corpus data: {error}"]
    if errors:
        print("\n".join("FAIL: " + e for e in errors))
        return 1
    print("PASS: Orange corpus " + ("validation" if args.validate else "freshness" if args.check else "render"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
