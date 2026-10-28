#!/usr/bin/env python3
"""Offline editorial/structural checks, not vulnerability or exploit verification."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit

from render_research import blog_owner_map, load_json, notes_by_id, render_outputs, skill_source_map, synchronize
from orange_research import validate as validate_orange

try:
    import yaml
except ImportError:  # pragma: no cover - optional structural ruleset parsing
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
TECHNIQUE_SECTIONS = (
    "Technique", "When to Use", "Goal", "Workflow", "Research Heuristics", "Tools",
    "Validation", "Common Failure Modes", "Fix / Mitigation", "Handoffs", "Evidence",
)
REQUIRED_SECTIONS = TECHNIQUE_SECTIONS
PLAYBOOK_SECTIONS = (
    "Applicability", "Workflow Prerequisites", "Baseline", "Bounded Comparison", "Controls",
    "Expected Observations", "False-Positive Checks", "Stop Conditions", "Evidence Fields",
    "Gaps", "Handoffs",
)
OVERLAY_SECTIONS = (
    "Applicability", "Workflow Prerequisites", "Parity Surfaces", "Verification Rules", "Composition",
    "Stop Conditions", "Handoffs", "Gaps",
)
RECIPE_SECTIONS = (
    "Purpose", "Prerequisites", "Input", "Invocation", "Exit Codes", "Output", "Error Recovery",
    "Manual Validation", "Provenance", "Handoffs",
)
SKILL_KINDS = frozenset({"technique", "playbook", "overlay", "procedure"})
# planning_update.md P14.6: an exploit skill ships a procedure — the conditions it may start under, the gates it climbs,
# what finishes it, and the wall that ends it — plus the scripts that are the point. It is deliberately not surveyed
# research (no evidence anchors, no provenance record): its authority is the plan and the tooling, not a source library.
PROCEDURE_SECTIONS = ("Entry conditions", "Gates", "Completion definition", "The wall")
METADATA_FIELDS = frozenset({"schema_version", "kind", "name", "references", "workflows", "workflow_prerequisites", "provenance_refs", "recipes"})
CATALOG_FIELDS = frozenset({"version", "skills", "documents"})
CATALOG_SKILL_FIELDS = frozenset({"name", "description", "kind", "document", "workflows"})
CATALOG_DOCUMENT_FIELDS = frozenset({"id", "path", "section"})
WORKFLOW_FIELDS = frozenset({"id", "description", "prerequisites", "steps", "observe", "wall"})
# A workflow may carry the recipe that turns its prerequisite list into procedure: ordered steps, the surfaces that
# count as an observation, and the conditions that end the attempt. They are additive, so the workflows written before
# the recipe shape stay valid; when present they are held to the same length and description bounds as prerequisites.
RECIPE_FIELDS = (("steps", 2, 12), ("observe", 1, 12), ("wall", 0, 12))
DOCUMENT_ID = re.compile(r"[a-z0-9][a-z0-9:.-]{0,159}")
PROVENANCE_FIELDS = (
    "project", "distribution", "revision", "revision_basis", "snapshot_retrieved_at", "reviewed_at",
    "license", "license_sha256", "license_copy", "license_notice", "version_metadata_sha256", "usage_boundary", "attribution",
)
WSTG_UPSTREAM_FIELDS = (
    "project", "distribution", "revision", "revision_basis", "snapshot_retrieved_at", "reviewed_at",
    "license", "license_sha256", "license_copy", "license_notice", "usage_boundary", "attribution",
)
WSTG_REFERENCE_FIELDS = frozenset({"id", "document", "source_dir", "pages", "sha256", "license", "adapted", "excluded", "used_by"})
REQUIRED_RECIPE_FLAGS = (
    "--config", "--metrics=off", "--json", "--jobs", "--timeout", "--disable-version-check",
    "SEMGREP_ENABLE_VERSION_CHECK=0", "SEMGREP_SEND_METRICS=off",
)
REGISTRY_CONFIG = (re.compile(r"\bp/default\b"), re.compile(r"--config[= ]+auto\b"), re.compile(r"registry\.semgrep\.dev"))
HASH = re.compile(r"[0-9a-f]{64}")
BLOG_SOURCE = re.compile(r"\bB\d{3}\b")
SIBLING_SKILL_LINK = re.compile(r"\]\(\.\./[a-z0-9-]+/SKILL\.md\)")
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
RECIPE_DOC_PATTERNS = {rule: pattern for rule, pattern in RECIPE_PATTERNS.items() if rule != "executable recipe fence"}


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


def read_json_object(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    return data


def validate_workflows(label: str, workflows, errors: list[str]) -> None:
    if not isinstance(workflows, list) or not workflows:
        errors.append(f"{label}: workflow prerequisites missing")
        return
    seen = set()
    for workflow in workflows:
        if not isinstance(workflow, dict) or set(workflow) - WORKFLOW_FIELDS:
            errors.append(f"{label}: invalid workflow entry")
            continue
        identifier = workflow.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", identifier):
            errors.append(f"{label}: invalid workflow id")
        elif identifier in seen:
            errors.append(f"{label}: duplicate workflow {identifier}")
        else:
            seen.add(identifier)
        if not isinstance(workflow.get("description"), str) or len(workflow["description"]) < 20:
            errors.append(f"{label}: workflow {identifier} lacks a description")
        values = workflow.get("prerequisites", [])
        if (not isinstance(values, list) or len(values) > 10
                or any(not isinstance(value, str) or len(value.strip()) < 10 or len(value) > 500 for value in values)):
            errors.append(f"{label}: invalid descriptive prerequisites for {identifier}")
        for key, low, high in RECIPE_FIELDS:
            recipe = workflow.get(key)
            if recipe is None:
                continue
            if (not isinstance(recipe, list) or not low <= len(recipe) <= high
                    or any(not isinstance(value, str) or len(value.strip()) < 10 or len(value) > 500 for value in recipe)):
                errors.append(f"{label}: invalid {key} recipe for {identifier}")


def metadata_list(metadata: dict, key: str) -> list:
    value = metadata.get(key, [])
    return value if isinstance(value, list) else []


def workflow_requirements(workflows) -> dict:
    """Normalize workflow ids to their requirement tuples so catalog drift is detectable."""
    return {
        workflow.get("id"): (
            tuple(sorted(workflow.get("prerequisites", []))),
            tuple(workflow.get("steps", [])),
            tuple(workflow.get("observe", [])),
            tuple(workflow.get("wall", [])),
        )
        for workflow in workflows if isinstance(workflow, dict)
    }


def validate_skill_metadata(base: Path, label: str, data: dict, errors: list[str]) -> None:
    """Validate the staging sidecar carried by a non-technique skill."""
    if set(data) - METADATA_FIELDS:
        errors.append(f"{label}: unknown metadata field")
    if data.get("schema_version") != 1:
        errors.append(f"{label}: unsupported metadata schema")
    kind = data.get("kind")
    if kind not in SKILL_KINDS:
        errors.append(f"{label}: invalid skill kind")
    references = data.get("references", [])
    if not isinstance(references, list):
        errors.append(f"{label}: invalid references")
        references = []
    if kind in {"playbook", "overlay"} and not references:
        errors.append(f"{label}: missing references")
    for reference in references:
        if not isinstance(reference, str) or not reference.endswith(".md") or reference.startswith("/") or ".." in Path(reference).parts:
            errors.append(f"{label}: invalid reference {reference}")
            continue
        if not (base / reference).is_file():
            errors.append(f"{label}: missing reference {reference}")
    if "workflows" in data:
        validate_workflows(label, data["workflows"], errors)
    elif kind in {"playbook", "overlay"}:
        errors.append(f"{label}: workflow prerequisites missing")
    provenance = data.get("provenance_refs", [])
    if not isinstance(provenance, list) or any(not isinstance(reference, str) for reference in provenance):
        errors.append(f"{label}: invalid provenance references")
    elif kind in {"playbook", "overlay"} and not provenance:
        errors.append(f"{label}: missing provenance references")
    recipes = data.get("recipes", [])
    if not isinstance(recipes, list) or any(not isinstance(recipe, str) for recipe in recipes):
        errors.append(f"{label}: invalid recipes")


def validate_runtime_skill(label: str, entry: dict, errors: list[str]) -> None:
    """Validate one skill entry of the runtime catalog ({version, skills, documents})."""
    if set(entry) - CATALOG_SKILL_FIELDS:
        errors.append(f"{label}: unknown catalog skill field")
    name = entry.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        errors.append(f"{label}: invalid skill name")
    if not isinstance(entry.get("description"), str) or len(entry["description"]) < 20:
        errors.append(f"{label}: invalid skill description")
    if entry.get("kind") not in SKILL_KINDS:
        errors.append(f"{label}: invalid skill kind")
    if entry.get("document") != name:
        errors.append(f"{label}: document must equal the skill name")
    if not isinstance(entry.get("workflows"), list) or not entry.get("workflows"):
        errors.append(f"{label}: workflow prerequisites missing")
    else:
        validate_workflows(label, entry["workflows"], errors)


def validate_runtime_document(root: Path, label: str, document: dict, errors: list[str]) -> None:
    """Validate one document registry entry and its id/path convention."""
    if set(document) - CATALOG_DOCUMENT_FIELDS:
        errors.append(f"{label}: unknown catalog document field")
    identifier = document.get("id")
    path = document.get("path")
    if not isinstance(identifier, str) or not DOCUMENT_ID.fullmatch(identifier):
        errors.append(f"{label}: invalid document id")
        return
    if not isinstance(path, str) or not path.endswith((".md", ".yaml", ".yml", ".json", ".py")):
        errors.append(f"{label}: invalid document path for {identifier}")
        return
    target = (root / path).resolve()
    if not target.is_relative_to(root.resolve()) or not target.is_file():
        errors.append(f"{label}: missing document {path}")
        return
    if path.startswith("skills/"):
        relative = path[len("skills/"):]
        owner = relative.split("/", 1)[0]
        if identifier == owner and relative == f"{owner}/SKILL.md":
            pass
        elif not identifier.startswith(f"{owner}:"):
            errors.append(f"{label}: document id {identifier} does not match {path}")
        elif re.fullmatch(rf"{re.escape(owner)}/(?:references/[^/]+\.md|scripts/[A-Za-z0-9][A-Za-z0-9._-]{{0,80}}\.py)", relative):
            if identifier.split(":", 1)[1] != Path(relative).stem:
                errors.append(f"{label}: document id {identifier} does not match {path}")
            if "/scripts/" in relative and target.stat().st_size > 16 * 1024:
                errors.append(f"{label}: registered script {path} exceeds the harness size budget")
    elif not identifier.startswith(("shared:", "evidence:", "wstg-source:")):
        errors.append(f"{label}: document {identifier} outside the skill library needs a shared/evidence/wstg-source prefix")
    if path.startswith("my_references/") and not path.startswith("my_references/wstg/"):
        errors.append(f"{label}: only my_references/wstg/ may be a catalog document path")
    if "section" in document:
        section = document["section"]
        if not isinstance(section, str) or not section or not path.endswith(".md"):
            errors.append(f"{label}: invalid document section for {identifier}")
        elif section not in markdown_anchors(target.read_text(encoding="utf-8")):
            errors.append(f"{label}: missing document section {section} for {identifier}")


def load_skill_metadata(root: Path, errors: list[str]) -> dict[str, dict]:
    """Resolve profiles from staging sidecars and the runtime catalog ({version, skills, documents}).

    The staging sidecar carries the author's non-default kind and provenance references; the runtime
    catalog owns document IDs, workflows, and the reachable entry points. A catalog kind that differs
    from staging is only an error when it is an explicit non-default choice.
    """
    metadata: dict[str, dict] = {}
    sidecars: dict[str, dict] = {}
    known_skills = {path.parent.name for path in (root / "skills").glob("*/SKILL.md")}
    for path in sorted((root / "skills").glob("*/skill.json")):
        name = path.parent.name
        label = str(path.relative_to(root))
        try:
            data = read_json_object(path)
        except (OSError, TypeError, ValueError) as error:
            errors.append(f"{label}: invalid metadata ({error})")
            continue
        validate_skill_metadata(path.parent, str(path.relative_to(root)), data, errors)
        sidecars[name] = data
    catalog_path = root / "skills/catalog.json"
    catalog: dict[str, dict] = {}
    catalog_documents: dict[str, str] = {}
    if catalog_path.exists():
        label = str(catalog_path.relative_to(root))
        try:
            data = read_json_object(catalog_path)
        except (OSError, TypeError, ValueError) as error:
            errors.append(f"{label}: invalid catalog ({error})")
            data = None
        if data is not None:
            if set(data) - CATALOG_FIELDS:
                errors.append(f"{label}: unknown catalog field")
            if data.get("version") != 1:
                errors.append(f"{label}: unsupported catalog version")
            entries = data.get("skills", [])
            if not isinstance(entries, list):
                errors.append(f"{label}: catalog skills missing")
                entries = []
            for entry in entries:
                if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
                    errors.append(f"{label}: invalid skill entry")
                    continue
                name = entry["name"]
                if name in catalog:
                    errors.append(f"{label}: duplicate skill entry {name}")
                    continue
                validate_runtime_skill(f"{label}:{name}", entry, errors)
                catalog[name] = entry
            documents = data.get("documents", [])
            if not isinstance(documents, list):
                errors.append(f"{label}: catalog documents missing")
                documents = []
            for document in documents:
                if not isinstance(document, dict) or not isinstance(document.get("id"), str):
                    errors.append(f"{label}: invalid document entry")
                    continue
                identifier = document["id"]
                if identifier in catalog_documents:
                    errors.append(f"{label}: duplicate document {identifier}")
                    continue
                validate_runtime_document(root, label, document, errors)
                if isinstance(document.get("path"), str):
                    catalog_documents[identifier] = document["path"]
            for name in catalog:
                if name not in known_skills:
                    errors.append(f"{label}: unknown skill {name}")
                elif catalog[name].get("document") != name:
                    errors.append(f"{label}: {name} document must equal its name")
            for name in known_skills:
                if f"skills/{name}/SKILL.md" not in catalog_documents.values():
                    errors.append(f"{label}: missing skill document skills/{name}/SKILL.md")
            for path in sorted((root / "skills").glob("*/references/*.md")):
                if path.relative_to(root).as_posix() not in catalog_documents.values():
                    errors.append(f"{label}: missing reference document {path.relative_to(root)}")
    for name, sidecar in sidecars.items():
        entry = catalog.get(name)
        if entry is None:
            if catalog_path.exists():
                errors.append(f"skills/catalog.json: missing skill entry {name}")
            metadata[name] = {
                "kind": sidecar.get("kind", "technique"), "references": metadata_list(sidecar, "references"),
                "workflows": metadata_list(sidecar, "workflows"), "provenance_refs": metadata_list(sidecar, "provenance_refs"),
            }
            continue
        if entry.get("kind") != sidecar.get("kind"):
            errors.append(f"skills/catalog.json: {name} kind {entry.get('kind')} disagrees with staging metadata {sidecar.get('kind')} (correct the runtime entry and keep the sidecar in sync)")
            continue
        staged_workflows = metadata_list(sidecar, "workflows")
        runtime_workflows = metadata_list(entry, "workflows")
        if workflow_requirements(staged_workflows) != workflow_requirements(runtime_workflows):
            errors.append(f"skills/catalog.json: {name} workflows differ from staging metadata")
        metadata[name] = {
            "kind": entry.get("kind", "technique"), "references": metadata_list(sidecar, "references"),
            "workflows": runtime_workflows, "provenance_refs": metadata_list(sidecar, "provenance_refs"),
        }
    for name, entry in catalog.items():
        if name in metadata:
            continue
        prefix = f"skills/{name}/"
        references = sorted(path[len(prefix):] for path in catalog_documents.values()
                            if path.startswith(f"{prefix}references/") and path.endswith(".md"))
        metadata[name] = {
            "kind": entry.get("kind", "technique"), "references": references,
            "workflows": metadata_list(entry, "workflows"), "provenance_refs": [],
            "description": entry.get("description"),
        }
    for name, sidecar in sidecars.items():
        if name in metadata:
            metadata[name].setdefault("description", (catalog.get(name) or {}).get("description"))
    return metadata


def check_provenance(label: str, name: str, metadata: dict, provenance: dict[str, set[str]], errors: list[str]) -> None:
    references = metadata_list(metadata, "provenance_refs")
    if references:
        for reference in references:
            if reference not in provenance:
                errors.append(f"{label}: unknown provenance reference {reference}")
            elif name not in provenance[reference]:
                errors.append(f"{label}: {reference} does not credit {name}")
    elif not any(name in used_by for used_by in provenance.values()):
        errors.append(f"{label}: missing provenance coverage for {name}")


def validate_provenance(root: Path, errors: list[str]) -> dict[str, set[str]]:
    path = root / "research/SKILL_PROVENANCE.json"
    label = str(path.relative_to(root))
    provenance: dict[str, set[str]] = {}
    try:
        data = read_json_object(path)
    except (OSError, TypeError, ValueError) as error:
        errors.append(f"{label}: invalid provenance ({error})")
        return provenance
    document_path = root / "research/SKILL_PROVENANCE.md"
    document = document_path.read_text(encoding="utf-8") if document_path.is_file() else ""
    if not document:
        errors.append("research/SKILL_PROVENANCE.md: missing provenance document")
    if data.get("schema_version") != 1:
        errors.append(f"{label}: unsupported provenance schema")
    upstream = data.get("upstream")
    if not isinstance(upstream, dict) or not set(PROVENANCE_FIELDS) <= set(upstream):
        errors.append(f"{label}: incomplete upstream identity")
        upstream = {}
    else:
        for key in ("license_sha256", "version_metadata_sha256"):
            if not HASH.fullmatch(str(upstream.get(key, ""))):
                errors.append(f"{label}: invalid {key}")
        for key in ("project", "distribution", "revision", "license", "reviewed_at", "usage_boundary", "attribution", "license_copy", "license_notice"):
            if not isinstance(upstream.get(key), str) or not upstream[key]:
                errors.append(f"{label}: missing upstream {key}")
        for key in ("license", "revision"):
            value = upstream.get(key)
            if value and value not in document:
                errors.append(f"{label}: provenance document omits upstream {key}")
        copy_name = upstream.get("license_copy")
        if isinstance(copy_name, str) and copy_name:
            copy_path = (root / copy_name).resolve()
            if not copy_path.is_relative_to(root.resolve()) or not copy_path.is_file():
                errors.append(f"{label}: missing license copy {copy_name}")
            elif hashlib.sha256(copy_path.read_bytes()).hexdigest() != upstream.get("license_sha256"):
                errors.append(f"{label}: license copy hash differs from the recorded upstream license")
        notice_name = upstream.get("license_notice")
        if isinstance(notice_name, str) and notice_name and not (root / notice_name).resolve().is_file():
            errors.append(f"{label}: missing license notice {notice_name}")
    references = data.get("references")
    if not isinstance(references, list) or not 5 <= len(references) <= 20:
        errors.append(f"{label}: expected 5-20 reviewed references")
        return provenance
    for reference in references:
        if not isinstance(reference, dict):
            errors.append(f"{label}: invalid reference entry")
            continue
        identifier = reference.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[RA]\d{1,2}", identifier):
            errors.append(f"{label}: invalid reference id")
            continue
        if identifier in provenance:
            errors.append(f"{label}: duplicate reference {identifier}")
            continue
        required = {"id", "role", "document", "sha256", "license", "adapted", "excluded", "used_by"}
        if set(reference) - required or required - set(reference):
            errors.append(f"{label}: {identifier} incomplete reference entry")
            continue
        if reference.get("role") not in {"primary", "architecture"}:
            errors.append(f"{label}: {identifier} invalid role")
        if not isinstance(reference.get("document"), str) or not reference["document"]:
            errors.append(f"{label}: {identifier} missing document title")
        if not HASH.fullmatch(str(reference.get("sha256", ""))):
            errors.append(f"{label}: {identifier} invalid hash")
        elif reference["sha256"] not in document:
            errors.append(f"{label}: provenance document omits hash for {identifier}")
        if upstream and reference.get("license") != upstream.get("license"):
            errors.append(f"{label}: {identifier} license differs from upstream")
        adapted = reference.get("adapted")
        excluded = reference.get("excluded")
        used_by = reference.get("used_by")
        if not isinstance(adapted, list) or any(not isinstance(item, str) or len(item) < 20 for item in adapted):
            errors.append(f"{label}: {identifier} invalid adapted list")
        elif identifier.startswith("R") and not adapted:
            errors.append(f"{label}: {identifier} primary reference has no adaptation")
        if not isinstance(excluded, list) or not excluded or any(not isinstance(item, str) or len(item) < 20 for item in excluded):
            errors.append(f"{label}: {identifier} invalid excluded list")
        if not isinstance(used_by, list) or any(not isinstance(item, str) for item in used_by):
            errors.append(f"{label}: {identifier} invalid used_by list")
            used_by = []
        provenance[identifier] = set(used_by)
    return provenance


def tree_digest(directory: Path) -> tuple[str, int]:
    """Digest of one upstream chapter: SHA-256 over sorted "relative path TAB page SHA-256" lines of every Markdown page below it, and the page count."""
    lines = [f"{page.relative_to(directory).as_posix()}\t{hashlib.sha256(page.read_bytes()).hexdigest()}\n" for page in sorted(directory.rglob("*.md"))]
    return hashlib.sha256("".join(lines).encode()).hexdigest(), len(lines)


def validate_wstg_provenance(root: Path, errors: list[str]) -> dict[str, set[str]]:
    """Record of the second reviewed upstream (OWASP WSTG, CC-BY-SA-4.0). It lives in its own file so each upstream keeps its own license; credit rules match the first record."""
    path = root / "research/WSTG_PROVENANCE.json"
    label = "research/WSTG_PROVENANCE.json"
    provenance: dict[str, set[str]] = {}
    if not path.exists():
        return provenance
    try:
        data = read_json_object(path)
    except (OSError, TypeError, ValueError) as error:
        errors.append(f"{label}: invalid provenance ({error})")
        return provenance
    document_path = root / "research/WSTG_PROVENANCE.md"
    document = document_path.read_text(encoding="utf-8") if document_path.is_file() else ""
    if not document:
        errors.append("research/WSTG_PROVENANCE.md: missing provenance document")
    if data.get("schema_version") != 1:
        errors.append(f"{label}: unsupported provenance schema")
    upstream = data.get("upstream")
    if not isinstance(upstream, dict) or not set(WSTG_UPSTREAM_FIELDS) <= set(upstream):
        errors.append(f"{label}: incomplete upstream identity")
        upstream = {}
    else:
        for key in WSTG_UPSTREAM_FIELDS:
            if not isinstance(upstream.get(key), str) or not upstream[key]:
                errors.append(f"{label}: missing upstream {key}")
        if not HASH.fullmatch(str(upstream.get("license_sha256", ""))):
            errors.append(f"{label}: invalid license_sha256")
        if not re.fullmatch(r"[0-9a-f]{40}", str(upstream.get("revision", ""))):
            errors.append(f"{label}: revision must be a full commit id")
        for key in ("license", "revision"):
            value = upstream.get(key)
            if value and value not in document:
                errors.append(f"{label}: provenance document omits upstream {key}")
        copy_name = upstream.get("license_copy")
        if isinstance(copy_name, str) and copy_name:
            copy_path = (root / copy_name).resolve()
            if not copy_path.is_relative_to(root.resolve()) or not copy_path.is_file():
                errors.append(f"{label}: missing license copy {copy_name}")
            elif hashlib.sha256(copy_path.read_bytes()).hexdigest() != upstream.get("license_sha256"):
                errors.append(f"{label}: license copy hash differs from the recorded upstream license")
        notice_name = upstream.get("license_notice")
        if isinstance(notice_name, str) and notice_name and not (root / notice_name).resolve().is_file():
            errors.append(f"{label}: missing license notice {notice_name}")
    references = data.get("references")
    if not isinstance(references, list) or len(references) > 20:
        errors.append(f"{label}: expected at most 20 reviewed references")
        return provenance
    for reference in references:
        if not isinstance(reference, dict):
            errors.append(f"{label}: invalid reference entry")
            continue
        identifier = reference.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"W\d{1,2}", identifier):
            errors.append(f"{label}: invalid reference id")
            continue
        if identifier in provenance:
            errors.append(f"{label}: duplicate reference {identifier}")
            continue
        if set(reference) != WSTG_REFERENCE_FIELDS:
            errors.append(f"{label}: {identifier} incomplete reference entry")
            continue
        if not isinstance(reference.get("document"), str) or not reference["document"]:
            errors.append(f"{label}: {identifier} missing document title")
        source_dir = reference.get("source_dir")
        if not isinstance(source_dir, str) or not source_dir or source_dir.startswith("/") or "\\" in source_dir or ".." in Path(source_dir).parts:
            errors.append(f"{label}: {identifier} invalid source directory")
        if not isinstance(reference.get("pages"), int) or isinstance(reference.get("pages"), bool) or reference["pages"] < 1:
            errors.append(f"{label}: {identifier} invalid page count")
        if not HASH.fullmatch(str(reference.get("sha256", ""))):
            errors.append(f"{label}: {identifier} invalid hash")
        elif reference["sha256"] not in document:
            errors.append(f"{label}: provenance document omits hash for {identifier}")
        if upstream and reference.get("license") != upstream.get("license"):
            errors.append(f"{label}: {identifier} license differs from upstream")
        for field in ("adapted", "excluded"):
            items = reference.get(field)
            if not isinstance(items, list) or not items or any(not isinstance(item, str) or len(item) < 20 for item in items):
                errors.append(f"{label}: {identifier} invalid {field} list")
        used_by = reference.get("used_by")
        if not isinstance(used_by, list) or not used_by or any(not isinstance(item, str) for item in used_by):
            errors.append(f"{label}: {identifier} invalid used_by list")
            used_by = []
        for name in used_by:
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or not (root / "skills" / name / "SKILL.md").is_file():
                errors.append(f"{label}: {identifier} credits unknown skill {name}")
        provenance[identifier] = set(used_by)
    return provenance


def validate_playbook(path: Path, root: Path, body: str, parts: dict, metadata: dict, provenance: dict, errors: list[str]) -> None:
    label = str(path.relative_to(root))
    name = path.parent.name
    for section in PLAYBOOK_SECTIONS:
        if len(parts.get(section, "")) < 30:
            errors.append(f"{label}: missing/empty {section}")
    controls = parts.get("Controls", "")
    if not re.search(r"positive control", controls, re.I):
        errors.append(f"{label}: controls lack a positive control")
    if not re.search(r"negative control", controls, re.I):
        errors.append(f"{label}: controls lack a negative control")
    stops = [line for line in parts.get("Stop Conditions", "").splitlines() if line.startswith("- ")]
    if len(stops) < 2:
        errors.append(f"{label}: stop conditions lack bounded rules")
    fields = [line for line in parts.get("Evidence Fields", "").splitlines() if line.startswith("- ")]
    if len(fields) < 3:
        errors.append(f"{label}: evidence fields lack named observations")
    if not re.search(r"not tested|untested|unverified|gap|deferred", parts.get("Gaps", ""), re.I):
        errors.append(f"{label}: gaps do not record untested scope")
    prerequisites = parts.get("Workflow Prerequisites", "").lower().replace("-", " ")
    workflows = metadata.get("workflows")
    for workflow in workflows if isinstance(workflows, list) else []:
        identifier = workflow.get("id", "") if isinstance(workflow, dict) else ""
        if identifier and identifier.lower().replace("-", " ") not in prerequisites:
            errors.append(f"{label}: undocumented workflow {identifier}")
    for reference in metadata_list(metadata, "references"):
        if f"]({reference})" not in body:
            errors.append(f"{label}: unlinked reference {reference}")
    if not SIBLING_SKILL_LINK.search(body):
        errors.append(f"{label}: missing technique/playbook handoff link")
    check_provenance(label, name, metadata, provenance, errors)


def validate_overlay(path: Path, root: Path, body: str, parts: dict, metadata: dict, provenance: dict, errors: list[str]) -> None:
    label = str(path.relative_to(root))
    name = path.parent.name
    for section in OVERLAY_SECTIONS:
        if len(parts.get(section, "")) < 30:
            errors.append(f"{label}: missing/empty {section}")
    if not re.search(r"version", parts.get("Applicability", ""), re.I):
        errors.append(f"{label}: applicability lacks version resolution")
    if not re.search(r"infer", parts.get("Verification Rules", ""), re.I):
        errors.append(f"{label}: verification rules do not reject inference from API names")
    composition = parts.get("Composition", "")
    if "slot" not in composition.lower() or not re.search(r"technique", composition, re.I) or not re.search(r"playbook", composition, re.I):
        errors.append(f"{label}: composition lacks the shared slot limit")
    if not re.search(r"not tested|untested|unverified|gap|deferred", parts.get("Gaps", ""), re.I):
        errors.append(f"{label}: gaps do not record untested scope")
    if len(SIBLING_SKILL_LINK.findall(body)) < 2:
        errors.append(f"{label}: overlay must link a technique and a playbook")
    prerequisites = parts.get("Workflow Prerequisites", "").lower().replace("-", " ")
    workflows = metadata.get("workflows")
    for workflow in workflows if isinstance(workflows, list) else []:
        identifier = workflow.get("id", "") if isinstance(workflow, dict) else ""
        if identifier and identifier.lower().replace("-", " ") not in prerequisites:
            errors.append(f"{label}: undocumented workflow {identifier}")
    for reference in metadata_list(metadata, "references"):
        if f"]({reference})" not in body:
            errors.append(f"{label}: unlinked reference {reference}")
    check_provenance(label, name, metadata, provenance, errors)


def validate_procedure(path: Path, root: Path, body: str, parts: dict, errors: list[str]) -> None:
    """A procedure skill climbs four named gates in order and says where it stops."""
    label = str(path.relative_to(root))
    name = path.parent.name
    for section in PROCEDURE_SECTIONS:
        if len(parts.get(section, "")) < 30:
            errors.append(f"{label}: missing/empty {section}")
    positions = [body.find(f"## {section}") for section in PROCEDURE_SECTIONS]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        errors.append(f"{label}: procedure sections are out of order")
    if not re.search(r"\bwall\b", parts.get("The wall", ""), re.I):
        errors.append(f"{label}: the wall does not say where the attempt stops")
    scripts = sorted((path.parent / "scripts").glob("*.py"))
    for script in scripts:
        source = script.read_text(encoding="utf-8")
        if len(source.encode("utf-8")) > 16 * 1024:
            errors.append(f"{label}: {script.name} exceeds the harness size budget")
        if not re.search(r"--(?:target|binary|payload)", source) or "refused" not in source:
            errors.append(f"{label}: {script.name} does not take an explicit target and refuse without one")
    # The message was always "neither a script nor the reason it has none", but only the script branch was enforced.
    # A procedure whose steps are shaped by the target cannot hand the worker a bounded CLI; it must say so in its body
    # so the absence is a recorded decision rather than an omission (planning_update.md A17.6).
    if not scripts and "credential" not in name and not re.search(r"\bships no script\b", body, re.I):
        errors.append(f"{label}: procedure ships neither a script nor the reason it has none")


def validate_ruleset(path: Path, root: Path, errors: list[str]) -> None:
    label = str(path.relative_to(root))
    text = path.read_text(encoding="utf-8")
    if len(text.split()) > 500:
        errors.append(f"{label}: ruleset exceeds the focused size budget")
    for rule, pattern in (("blog source", BLOG_SOURCE), ("network reference", re.compile(r"https?://")),
                          ("encoded byte payload", RECIPE_PATTERNS["encoded byte payload"]),
                          ("CVE identifier", RECIPE_PATTERNS["CVE-specific skill content"]),
                          ("literal IP endpoint", RECIPE_PATTERNS["source-specific endpoint"])):
        if pattern.search(text):
            errors.append(f"{label}: prohibited {rule} in ruleset")
    if yaml is None:
        return
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as error:
        errors.append(f"{label}: invalid YAML ({error})")
        return
    rules = data.get("rules") if isinstance(data, dict) else None
    if not isinstance(rules, list) or not 2 <= len(rules) <= 8:
        errors.append(f"{label}: expected 2-8 original rules")
        return
    identifiers = []
    for rule in rules:
        if not isinstance(rule, dict):
            errors.append(f"{label}: invalid rule entry")
            continue
        identifier = rule.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"p2o-[a-z0-9]+(?:-[a-z0-9]+)*", identifier):
            errors.append(f"{label}: invalid rule id")
            continue
        identifiers.append(identifier)
        if "python" not in rule.get("languages", []):
            errors.append(f"{label}: {identifier} lacks the python language")
        if rule.get("severity") not in {"INFO", "WARNING", "ERROR"}:
            errors.append(f"{label}: {identifier} has an invalid severity")
        if not isinstance(rule.get("message"), str) or len(rule["message"]) < 40:
            errors.append(f"{label}: {identifier} message lacks the candidate boundary")
        if not (rule.get("pattern") or rule.get("patterns") or rule.get("pattern-either")):
            errors.append(f"{label}: {identifier} lacks a pattern")
        metadata = rule.get("metadata")
        if (not isinstance(metadata, dict) or metadata.get("source") != "local-original"
                or metadata.get("confidence") != "LOW" or metadata.get("category") != "p2o-local-candidate"):
            errors.append(f"{label}: {identifier} lacks original candidate metadata")
    if len(set(identifiers)) != len(identifiers):
        errors.append(f"{label}: duplicate rule id")


def validate_recipe(path: Path, root: Path, text: str, parts: dict, provenance: dict[str, set[str]], errors: list[str]) -> None:
    label = str(path.relative_to(root))
    for section in RECIPE_SECTIONS:
        if len(parts.get(section, "")) < 30:
            errors.append(f"{label}: missing/empty {section}")
    if BLOG_SOURCE.search(text):
        errors.append(f"{label}: recipe cites blog source")
    references = set(re.findall(r"\bR\d{1,2}\b", parts.get("Provenance", "")))
    if not references:
        errors.append(f"{label}: provenance section lacks a reference id")
    for reference in sorted(references):
        if reference not in provenance:
            errors.append(f"{label}: unknown provenance reference {reference}")
        elif label not in provenance[reference]:
            errors.append(f"{label}: {reference} does not credit this recipe")
    if "```" not in text:
        errors.append(f"{label}: recipe lacks a fenced invocation example")
    for flag in REQUIRED_RECIPE_FLAGS:
        if flag not in text:
            errors.append(f"{label}: recipe missing {flag}")
    if "--max-memory 256" not in text:
        errors.append(f"{label}: recipe must bound memory at 256 MiB for the shared sandbox")
    if "--max-memory 512" in text:
        errors.append(f"{label}: recipe exceeds the shared sandbox memory budget")
    if "timeout 45 semgrep" not in text:
        errors.append(f"{label}: recipe lacks the bounded shell timeout wrapper")
    if "do not retry target commands" not in text.lower():
        errors.append(f"{label}: recipe lacks the sandbox-stop no-retry rule")
    if "scan --validate" in text:
        errors.append(f"{label}: recipe must not use the validate stage offline")
    if "positive/negative fixture" not in text.lower():
        errors.append(f"{label}: recipe lacks the local positive/negative fixture gate")
    if "remote meta-lint" not in text.lower():
        errors.append(f"{label}: recipe lacks the validate remote-dependency caution")
    if "--version" not in parts.get("Prerequisites", ""):
        errors.append(f"{label}: prerequisites lack a tool probe")
    if "network" not in (parts.get("Prerequisites", "") + parts.get("Input", "")).lower():
        errors.append(f"{label}: recipe does not state its offline boundary")
    if not re.search(r"not|never|candidate", parts.get("Purpose", ""), re.I):
        errors.append(f"{label}: purpose lacks the non-confirmation boundary")
    for pattern in REGISTRY_CONFIG:
        if pattern.search(text):
            errors.append(f"{label}: recipe uses a registry configuration")
    rulesets = []
    for target in LINK.findall(text):
        destination = urlsplit(target)
        if destination.scheme:
            errors.append(f"{label}: recipe links an external resource")
            continue
        local = (path.parent / unquote(destination.path)).resolve()
        if local.suffix.lower() in {".yaml", ".yml"}:
            rulesets.append(local)
    if not rulesets:
        errors.append(f"{label}: recipe does not link a local ruleset")
    for ruleset in rulesets:
        if not ruleset.is_relative_to((root / "skills").resolve()):
            errors.append(f"{label}: ruleset outside the skill library")
        elif not ruleset.is_file():
            errors.append(f"{label}: missing ruleset {ruleset.name}")
        else:
            validate_ruleset(ruleset, root, errors)


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

        metadata = load_skill_metadata(root, errors)
        provenance = validate_provenance(root, errors)
        provenance.update(validate_wstg_provenance(root, errors))
        paths = sorted((root / "skills").glob("*/SKILL.md"))
        skill_documents = sorted((root / "skills").rglob("*.md"))
        recipe_documents = set((root / "skills").glob("*/recipes/**/*.md"))
        if not paths:
            errors.append("no skills")
        paragraphs = {}
        technique_names = set()
        mapping = skill_source_map(root)
        for path in paths:
            label = str(path.relative_to(root))
            name = path.parent.name
            text = path.read_text(encoding="utf-8")
            try:
                fields, body = frontmatter(text)
            except ValueError as error:
                errors.append(f"{label}: {error}")
                continue
            if fields["name"] != name:
                errors.append(f"{label}: name/directory mismatch")
            parts = sections(body)
            skill_metadata = metadata.get(name)
            if skill_metadata is None:
                kind = "technique"
            elif skill_metadata.get("kind") in SKILL_KINDS:
                kind = skill_metadata["kind"]
            else:
                continue
            if skill_metadata and skill_metadata.get("description") and skill_metadata["description"] != fields["description"]:
                errors.append(f"{label}: catalog description differs from frontmatter")
            if kind == "technique":
                for section in TECHNIQUE_SECTIONS:
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
                ids = set(mapping[name])
                if ids - set(by_id):
                    errors.append(f"{label}: unknown source citation")
                if len(ids & included) < 3:
                    errors.append(f"{label}: insufficient independent method sources")
                if any(by_id[i]["disposition"] in {"excluded", "duplicate"} for i in ids & set(by_id)):
                    errors.append(f"{label}: excluded/duplicate counted as evidence")
            elif kind == "procedure":
                validate_procedure(path, root, body, parts, errors)
            else:
                if kind == "playbook":
                    validate_playbook(path, root, body, parts, skill_metadata, provenance, errors)
                else:
                    validate_overlay(path, root, body, parts, skill_metadata, provenance, errors)
        for path in sorted(recipe_documents):
            label = str(path.relative_to(root))
            text = path.read_text(encoding="utf-8")
            validate_recipe(path, root, text, sections(text), provenance, errors)
        for path in skill_documents:
            label = str(path.relative_to(root))
            text = path.read_text(encoding="utf-8")
            body = text
            if path in paths:
                try:
                    _, body = frontmatter(text)
                except ValueError:
                    continue
            owner = path.relative_to(root / "skills").parts[0]
            kind = "recipe" if path in recipe_documents else metadata.get(owner, {}).get("kind", "technique")
            if kind != "technique" and BLOG_SOURCE.search(text):
                errors.append(f"{label}: non-blog skill cites blog source")
            patterns = RECIPE_DOC_PATTERNS if path in recipe_documents else RECIPE_PATTERNS
            for rule, pattern in patterns.items():
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
        owners = blog_owner_map(root)
        counts = Counter(e["disposition"] for e in entries)
        expected_stats = {
            "index_entries": len(entries), "inspected_pages": sum(bool(e["retrieval"]) for e in entries),
            "included_sources": counts["included"], "duplicate_pages": counts["duplicate"],
            "context_pages": counts["context"], "excluded_entries": counts["excluded"], "skills": len(owners),
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
        coordination = scaffold.get("coordination", {})
        if coordination.get("lead_reviewed") is not False or coordination.get("outcome") != "unknown" or not {"task_id", "task_revision", "parent_task_id", "validation_of", "role", "role_reason", "selected_method", "accepted_prerequisite_revisions", "missing_prerequisites", "known_unknowns", "expected_evidence_output", "review_receipt_ids"} <= set(coordination):
            errors.append("handoff coordination scaffold incomplete or falsely accepted")
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
    # planning_update.md A17.6: report both numbers, because 17 counts technique skills that own blog evidence while the
    # catalog also carries the procedures and playbooks a worker can be assigned. A procedure may not cite blog sources,
    # so the first number cannot grow with a procedure (D37) and the second is the library's real size.
    catalog = load_json(args.root / "skills/catalog.json")
    print(f"PASS: {len(catalog.get('skills', []))} skills ({stats['skills']} technique owners); {len(catalog.get('documents', []))} registered documents; {stats['index_entries']} catalog entries; {stats['included_sources']} evidence sources; format, links, provenance, mapping, handoffs, freshness, and recipe checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
