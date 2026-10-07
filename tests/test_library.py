"""Offline mutation tests for the knowledge library's quality gates."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import render_research as renderer
import validate_library as checker

FIXTURE_DIRECTORIES = ("skills", "research", "templates", "scripts", "docs")
FIXTURE_ROOT_DOCUMENTS = ("README.md", "HANDOFFS.md")
FIXTURE_SKIP_PARTS = frozenset({"node_modules", "dist", ".git", "tmp", "my_references", "results"})
FIXTURE_MAX_BYTES = 512 * 1024


def copy_fixture(source_root: Path, destination_root: Path) -> None:
    """Copy the library plus local targets linked from its validated root documents.

    Link validation stays enabled in temporary copies: README and HANDOFFS targets exist
    in the copy instead of being skipped as broken. Heavy or unrelated trees (dependencies,
    builds, the untracked review snapshot, benchmark outputs) are not copied, and files
    beyond the size budget are left out rather than silently accepted as broken links.
    """
    for folder in FIXTURE_DIRECTORIES:
        source = source_root / folder
        if source.is_dir():
            shutil.copytree(source, destination_root / folder, ignore=shutil.ignore_patterns("__pycache__"))
    queue = [source_root / name for name in FIXTURE_ROOT_DOCUMENTS]
    seen: set[Path] = set()
    while queue:
        source = queue.pop()
        try:
            relative = source.relative_to(source_root)
        except ValueError:
            continue
        if relative in seen or any(part in FIXTURE_SKIP_PARTS for part in relative.parts):
            continue
        seen.add(relative)
        if not source.is_file() or source.stat().st_size > FIXTURE_MAX_BYTES:
            continue
        destination = destination_root / relative
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        if source.suffix != ".md":
            continue
        for target in checker.LINK.findall(source.read_text(encoding="utf-8")):
            parts = urlsplit(target)
            if parts.scheme or not parts.path:
                continue
            candidate = (source.parent / unquote(parts.path)).resolve()
            if candidate.is_file() and candidate.is_relative_to(source_root.resolve()):
                queue.append(candidate)


class FormatTests(unittest.TestCase):
    def test_current_skill_frontmatter(self):
        for path in (ROOT / "skills").glob("*/SKILL.md"):
            with self.subTest(skill=path.parent.name):
                fields, _ = checker.frontmatter(path.read_text())
                self.assertEqual(fields["name"], path.parent.name)

    def test_missing_frontmatter(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            checker.frontmatter("# Just a heading")

    def test_unterminated_frontmatter(self):
        with self.assertRaisesRegex(ValueError, "unterminated"):
            checker.frontmatter("---\nname: sample")

    def test_duplicate_frontmatter_field(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            checker.frontmatter("---\nname: sample\nname: sample\ndescription: A sufficiently detailed description\n---")

    def test_name_format(self):
        with self.assertRaisesRegex(ValueError, "invalid skill name"):
            checker.frontmatter("---\nname: Bad_Name\ndescription: A sufficiently detailed description\n---")

    def test_yaml_plain_scalar_contract(self):
        with self.assertRaisesRegex(ValueError, "plain YAML"):
            checker.frontmatter("---\nname: sample\ndescription: Invalid: unquoted scalar mapping\n---")

    def test_json_browser_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text(json.dumps({"result": json.dumps({"count": 3})}))
            self.assertEqual(renderer.load_json(path), {"count": 3})


class LibraryGateTests(unittest.TestCase):
    def copied_root(self, directory):
        root = Path(directory)
        copy_fixture(ROOT, root)
        return root

    def assert_rejected(self, mutate, message):
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            mutate(root)
            errors = checker.validate(root)
            self.assertTrue(errors, "Corrupted fixture was accepted")
            self.assertTrue(any(message in error for error in errors), errors)

    @staticmethod
    def edit_skill(root, transform):
        path = root / "skills/attack-surface-mapping/SKILL.md"
        path.write_text(transform(path.read_text()))

    @staticmethod
    def edit_json(root, relative, transform):
        path = root / relative
        data = json.loads(path.read_text())
        transform(data)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def test_current_library(self):
        self.assertEqual(checker.validate(ROOT), [])

    def test_renderer_current_and_deterministic(self):
        corpus = renderer.load_json(ROOT / "research/corpus.json")
        first = renderer.render_outputs(ROOT, renderer.synchronize(ROOT, corpus))
        self.assertEqual(first, renderer.render_outputs(ROOT, renderer.synchronize(ROOT, corpus)))
        for path, expected in first.items():
            self.assertEqual(path.read_text(), expected)

    def test_name_directory_mismatch(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s.replace("name: attack-surface-mapping", "name: wrong-name")), "name/directory mismatch")

    def test_missing_required_goal(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s.replace("## Goal", "## Aim")), "missing/empty Goal")

    def test_tools_require_purpose_and_when(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s.replace("→ attribute local listeners", "attribute local listeners")), "tools lack purpose/when")

    def test_granular_heuristic_citations(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s.replace("[B081](../../research/evidence.md#b081)", "B081")), "heuristics lack granular")

    def test_broken_local_link(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + "\n[missing](../not-a-skill/SKILL.md)\n"), "broken local link")

    def test_broken_reference_link(self):
        def mutate(root):
            path = root / "skills/binary-auditing/references/native-slices.md"
            path.write_text(path.read_text() + "\n[missing](not-a-reference.md)\n")
        self.assert_rejected(mutate, "broken local link")

    def test_no_recipe_in_reference(self):
        def mutate(root):
            path = root / "skills/binary-auditing/references/native-slices.md"
            path.write_text(path.read_text() + "\n```python\nprint('benign fixture')\n```\n")
        self.assert_rejected(mutate, "recipe fence")

    def test_duplicate_reference_paragraph(self):
        def mutate(root):
            skill = (root / "skills/binary-auditing/SKILL.md").read_text()
            paragraph = checker.sections(checker.frontmatter(skill)[1])["Validation"]
            path = root / "skills/data-flow-analysis/references/reduced-models.md"
            path.write_text(path.read_text() + "\n" + paragraph + "\n")
        self.assert_rejected(mutate, "duplicate paragraph")

    def test_no_external_tooling_helper(self):
        def mutate(root):
            path = root / "skills/binary-auditing/references/native-slices.md"
            path.write_text(path.read_text() + "\nUse bash .revtools/triage.sh first.\n")
        self.assert_rejected(mutate, "external CTF skill/helper dependency")

    def test_reference_link_cannot_escape_library(self):
        def mutate(root):
            path = root / "skills/dynamic-analysis/references/runtime-probes.md"
            path.write_text(path.read_text() + "\n[escape](../../../../outside.md)\n")
        self.assert_rejected(mutate, "link escapes library")

    def test_broken_source_anchor(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + "\n[source](https://starlabs.sg/blog/2020/04-adventures-in-hypervisor-oracle-virtualbox-research/#missing-anchor)\n"), "unobserved source anchor")

    def test_link_cannot_escape_library(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + "\n[escape](../../../outside.md)\n"), "link escapes library")

    def test_no_cve_specific_skill(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + "\nSynthetic identifier CVE-2099-12345.\n"), "CVE-specific")

    def test_no_encoded_byte_payload(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + r"\nSynthetic bytes \x41\x42\x43"), "encoded byte payload")

    def test_no_executable_fence(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + "\n```python\nprint('benign fixture')\n```\n"), "recipe fence")

    def test_unknown_source(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + "\nB999\n"), "unknown source")

    def test_excluded_source_cannot_be_evidence(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + "\nB010\n"), "excluded/duplicate counted")

    def test_no_unfinished_skill(self):
        self.assert_rejected(lambda root: self.edit_skill(root, lambda s: s + "\nTODO: fill in method\n"), "unfinished placeholder")

    def test_duplicate_paragraph(self):
        def mutate(root):
            text = (root / "skills/binary-auditing/SKILL.md").read_text()
            paragraph = checker.sections(checker.frontmatter(text)[1])["Validation"]
            self.edit_skill(root, lambda s: s + "\n" + paragraph + "\n")
        self.assert_rejected(mutate, "duplicate paragraph")

    def test_duplicate_extractions(self):
        self.assert_rejected(lambda root: self.edit_json(root, "research/extractions.json", lambda rows: rows.append(rows[0])), "Duplicate source extractions")

    def test_unobserved_locator(self):
        self.assert_rejected(lambda root: self.edit_json(root, "research/extractions.json", lambda rows: rows[0].update(sections=["Missing observed section"])), "unobserved section locator")

    def test_limitations_required(self):
        self.assert_rejected(lambda root: self.edit_json(root, "research/extractions.json", lambda rows: rows[0].update(limitations="")), "missing limitations")

    def test_composition_scaffold_fields(self):
        self.assert_rejected(lambda root: self.edit_json(root, "templates/handoff.json", lambda c: c["contract_specific_fields"].pop("representation_ledger")), "composed pipeline scaffold incomplete")

    def test_failed_http_receipt(self):
        self.assert_rejected(lambda root: self.edit_json(root, "research/corpus.json", lambda c: c["entries"][0]["retrieval"].update(http_status=404)), "failed article retrieval")

    def test_missing_hash_receipt(self):
        self.assert_rejected(lambda root: self.edit_json(root, "research/corpus.json", lambda c: c["entries"][0]["retrieval"].update(response_html_sha256="invalid")), "incomplete retrieval provenance")

    def test_statistics_not_trusted(self):
        self.assert_rejected(lambda root: self.edit_json(root, "research/corpus.json", lambda c: c["statistics"].update(skills=99)), "statistics disagree")

    def test_unreviewed_recursive_edge(self):
        self.assert_rejected(lambda root: self.edit_json(root, "research/corpus.json", lambda c: c["internal_link_review"][0].update(action="unreviewed")), "unreviewed internal blog edge")

    def test_missing_recursive_edge(self):
        self.assert_rejected(lambda root: self.edit_json(root, "research/corpus.json", lambda c: c["internal_link_review"].pop()), "recursive link review coverage")

    def test_unresolved_stale_link(self):
        def mutate(root):
            def change(c):
                edge = next(e for e in c["internal_link_review"] if e["action"].startswith("stale-link"))
                edge["recovered_url"] = "https://starlabs.sg/blog/wrong/"
            self.edit_json(root, "research/corpus.json", change)
        self.assert_rejected(mutate, "stale source link unresolved")

    def test_duplicate_requires_retained_canonical(self):
        def mutate(root):
            self.edit_json(root, "research/corpus.json", lambda c: next(e for e in c["entries"] if e["disposition"] == "duplicate").update(canonical_source="B010"))
        self.assert_rejected(mutate, "duplicate has no retained")

    def test_scaffold_requires_uncertainty_and_fields(self):
        self.assert_rejected(lambda root: self.edit_json(root, "templates/handoff.json", lambda c: c.pop("negative_controls")), "handoff scaffold incomplete")

    def test_stale_generated_output(self):
        self.assert_rejected(lambda root: (root / "research/evidence.md").write_text("stale\n"), "stale generated artifact")

    def test_raw_collection_artifacts_not_deliverables(self):
        self.assert_rejected(lambda root: (root / "research/discovery.json").write_text("{}"), "temporary browser collection")

    def test_renderer_check_cli_fails_stale_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            (root / "research/catalog.md").write_text("stale\n")
            result = subprocess.run([sys.executable, str(root / "scripts/render_research.py"), "--check"], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn("stale generated artifacts", result.stdout)

    def test_validator_cli_success(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/validate_library.py")], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("17 skills", result.stdout)

    def test_phase_context_scaffold_fields(self):
        self.assert_rejected(lambda root: self.edit_json(root, "templates/handoff.json", lambda c: c["contract_specific_fields"].pop("dispatch_phase_model")), "composed pipeline scaffold incomplete")


class SkillProfileTests(unittest.TestCase):
    """New non-blog profiles plus the unchanged technique profile."""

    NON_BLOG_SKILLS = {
        "web-route-input-inventory": "playbook",
        "web-object-authorization": "playbook",
        "web-output-context": "playbook",
        "fastapi-security-parity": "overlay",
    }
    REVIEW_FILES = {
        "R1": "strix/skills/analysis/counterevidence.md",
        "R2": "strix/skills/vulnerabilities/idor.md",
        "R3": "strix/skills/vulnerabilities/xss.md",
        "R4": "strix/skills/custom/api_spec_testing.md",
        "R5": "strix/skills/frameworks/fastapi.md",
        "R6": "strix/skills/tooling/semgrep.md",
        "A1": "strix/skills/__init__.py",
        "A2": "strix/tools/load_skill/tool.py",
        "A3": "strix/agents/prompt.py",
    }

    def copied_root(self, directory):
        root = Path(directory)
        copy_fixture(ROOT, root)
        return root

    @staticmethod
    def edit_skill(root, skill, transform):
        path = root / f"skills/{skill}/SKILL.md"
        path.write_text(transform(path.read_text()))

    @staticmethod
    def edit_document(root, relative, transform):
        path = root / relative
        path.write_text(transform(path.read_text()))

    @staticmethod
    def edit_sidecar(root, skill, transform):
        path = root / f"skills/{skill}/skill.json"
        data = json.loads(path.read_text())
        transform(data)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def write_catalog(self, root, transform=None, kinds=None):
        """Build a runtime catalog ({version, skills, documents}) from the current skills."""
        entries = []
        for path in sorted((root / "skills").glob("*/SKILL.md")):
            name = path.parent.name
            fields, _ = checker.frontmatter(path.read_text())
            sidecar_path = root / f"skills/{name}/skill.json"
            sidecar = json.loads(sidecar_path.read_text()) if sidecar_path.exists() else None
            kind = (kinds or {}).get(name, (sidecar or {}).get("kind", "technique"))
            workflows = (sidecar or {}).get("workflows") or [
                {"id": "source-review", "description": "Review the supplied source without claiming runtime proof", "allOf": ["source.snapshot"]},
                {"id": "offline-reproduction", "description": "Bounded offline probe that verifies required runtimes first", "allOf": ["shell.offline"], "anyOf": ["tool.python"]},
            ]
            entries.append({"name": name, "description": fields["description"], "kind": kind, "document": name, "workflows": workflows})
        documents = []
        for path in sorted((root / "skills").rglob("*.md")):
            relative = path.relative_to(root / "skills").as_posix()
            owner, rest = relative.split("/", 1)
            identifier = owner if rest == "SKILL.md" else f"{owner}:{Path(rest).stem}"
            documents.append({"id": identifier, "path": f"skills/{relative}"})
        documents.append({"id": "source-code-auditing:offline-python-semgrep-rules", "path": "skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml"})
        documents.append({"id": "shared:handoffs", "path": "HANDOFFS.md"})
        documents.append({"id": "shared:scope", "path": "README.md", "section": "start-here"})
        documents.append({"id": "shared:skill-provenance", "path": "research/SKILL_PROVENANCE.md"})
        documents.append({"id": "shared:license-notice", "path": "research/licenses/README.md"})
        documents.append({"id": "shared:apache-2.0", "path": "research/licenses/apache-2.0.md"})
        catalog = {"version": 1, "skills": entries, "documents": documents}
        if transform:
            transform(catalog)
        (root / "skills/catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")

    @staticmethod
    def edit_catalog(root, transform):
        path = root / "skills/catalog.json"
        catalog = json.loads(path.read_text())
        transform(catalog)
        path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")

    def reject(self, mutate, message):
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            mutate(root)
            errors = checker.validate(root)
            self.assertTrue(errors, "Corrupted fixture was accepted")
            self.assertTrue(any(message in error for error in errors), errors)

    def reject_catalog(self, mutate, message):
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            self.write_catalog(root)
            self.assertEqual(checker.validate(root), [])
            mutate(root)
            errors = checker.validate(root)
            self.assertTrue(any(message in error for error in errors), errors)

    def test_current_profiles_resolve(self):
        errors = []
        metadata = checker.load_skill_metadata(ROOT, errors)
        self.assertEqual(errors, [])
        for name, kind in self.NON_BLOG_SKILLS.items():
            self.assertEqual(metadata[name]["kind"], kind)
        self.assertEqual(metadata.get("attack-surface-mapping", {}).get("kind", "technique"), "technique")

    def test_non_blog_skills_own_no_blog_sources(self):
        mapping = renderer.skill_source_map(ROOT)
        for name in self.NON_BLOG_SKILLS:
            self.assertEqual(mapping[name], [])
        self.assertEqual(len(renderer.blog_owner_map(ROOT)), 17)

    def test_provenance_record_matches_review_snapshot(self):
        snapshot = ROOT / "my_references/strix"
        if not snapshot.is_dir():
            self.skipTest("review snapshot is not present")
        data = json.loads((ROOT / "research/SKILL_PROVENANCE.json").read_text())
        for reference in data["references"]:
            path = snapshot / self.REVIEW_FILES[reference["id"]]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), reference["sha256"], reference["id"])
        upstream = data["upstream"]
        self.assertEqual(hashlib.sha256((snapshot / "LICENSE").read_bytes()).hexdigest(), upstream["license_sha256"])
        self.assertEqual(hashlib.sha256((snapshot / "pyproject.toml").read_bytes()).hexdigest(), upstream["version_metadata_sha256"])

    def test_provenance_document_carries_recorded_hashes(self):
        data = json.loads((ROOT / "research/SKILL_PROVENANCE.json").read_text())
        document = (ROOT / "research/SKILL_PROVENANCE.md").read_text()
        for reference in data["references"]:
            self.assertIn(reference["sha256"], document)
        self.assertIn(data["upstream"]["revision"], document)
        self.assertIn(data["upstream"]["license"], document)

    def test_provenance_document_has_adapted_and_excluded(self):
        data = json.loads((ROOT / "research/SKILL_PROVENANCE.json").read_text())
        for reference in data["references"]:
            self.assertTrue(reference["excluded"], reference["id"])
            if reference["id"].startswith("R"):
                self.assertTrue(reference["adapted"], reference["id"])
            else:
                self.assertEqual(reference["adapted"], [], reference["id"])

    def test_provenance_document_omitting_hash_rejected(self):
        def mutate(root):
            path = root / "research/SKILL_PROVENANCE.md"
            path.write_text(path.read_text().replace("3e729859564e68859eb588862d3c20a1fd65d88b49418b3e0e18f34eebae1d2d", "0" * 64))
        self.reject(mutate, "provenance document omits hash for R1")

    def test_provenance_invalid_hash_rejected(self):
        def mutate(root):
            path = root / "research/SKILL_PROVENANCE.json"
            data = json.loads(path.read_text())
            data["references"][0]["sha256"] = "not-a-hash"
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        self.reject(mutate, "invalid hash")

    def test_technique_canvas_is_preserved(self):
        errors = []
        metadata = checker.load_skill_metadata(ROOT, errors)
        self.assertEqual(errors, [])
        paths = sorted((ROOT / "skills").glob("*/SKILL.md"))
        techniques = [path for path in paths if metadata.get(path.parent.name, {}).get("kind", "technique") == "technique"]
        self.assertEqual(len(techniques), 17)
        self.assertEqual(len(renderer.blog_owner_map(ROOT)), 17)

    def test_playbook_missing_section_rejected(self):
        self.reject(lambda root: self.edit_skill(root, "web-route-input-inventory", lambda s: s.replace("## Stop Conditions", "## Stop Rules")), "missing/empty Stop Conditions")

    def test_playbook_requires_negative_control(self):
        self.reject(lambda root: self.edit_skill(root, "web-object-authorization", lambda s: s.replace("- Negative control:", "- Matching case:")), "controls lack a negative control")

    def test_playbook_cites_no_blog_source(self):
        self.reject(lambda root: self.edit_skill(root, "web-output-context", lambda s: s + "\nB010\n"), "non-blog skill cites blog source")

    def test_playbook_reference_cites_no_blog_source(self):
        def mutate(root):
            path = root / "skills/web-output-context/references/source-sink-context.md"
            path.write_text(path.read_text() + "\nB010\n")
        self.reject(mutate, "non-blog skill cites blog source")

    def test_playbook_rejects_recipe_fence(self):
        self.reject(lambda root: self.edit_skill(root, "web-output-context", lambda s: s + "\n```python\nprint('synthetic')\n```\n"), "recipe fence")

    def test_playbook_without_sidecar_uses_catalog_profile(self):
        """The integrated runtime catalog is self-sufficient for the profile it declares."""
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            (root / "skills/web-output-context/skill.json").unlink()
            self.assertEqual(checker.validate(root), [])

    def test_non_blog_skill_without_provenance_rejected(self):
        def mutate(root):
            (root / "skills/web-output-context/skill.json").unlink()
            path = root / "research/SKILL_PROVENANCE.json"
            data = json.loads(path.read_text())
            for reference in data["references"]:
                reference["used_by"] = [name for name in reference["used_by"] if name != "web-output-context"]
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        self.reject(mutate, "missing provenance coverage")

    def test_unknown_skill_kind_rejected(self):
        self.reject(lambda root: self.edit_sidecar(root, "web-output-context", lambda d: d.update(kind="tooling")), "invalid skill kind")

    def test_unknown_metadata_field_rejected(self):
        self.reject(lambda root: self.edit_sidecar(root, "web-output-context", lambda d: d.update(extra="synthetic")), "unknown metadata field")

    def test_unknown_capability_rejected(self):
        def mutate(root):
            def change(data):
                workflow = next(item for item in data["workflows"] if item["id"] == "public-baseline")
                workflow["allOf"] = ["http.upload"]
            self.edit_sidecar(root, "web-route-input-inventory", change)
        self.reject(mutate, "unknown capability")

    def test_missing_reference_rejected(self):
        self.reject(lambda root: self.edit_sidecar(root, "web-route-input-inventory", lambda d: d.update(references=["references/missing.md"])), "missing reference")

    def test_undocumented_workflow_rejected(self):
        def mutate(root):
            def sidecar(data):
                next(item for item in data["workflows"] if item["id"] == "source-review")["id"] = "renamed-workflow"
            def catalog(data):
                entry = next(item for item in data["skills"] if item["name"] == "web-object-authorization")
                next(item for item in entry["workflows"] if item["id"] == "source-review")["id"] = "renamed-workflow"
            self.edit_sidecar(root, "web-object-authorization", sidecar)
            self.edit_catalog(root, catalog)
        self.reject(mutate, "undocumented workflow renamed-workflow")

    def test_unknown_provenance_reference_rejected(self):
        self.reject(lambda root: self.edit_sidecar(root, "web-output-context", lambda d: d.update(provenance_refs=["R99"])), "unknown provenance reference R99")

    def test_overlay_missing_gaps_rejected(self):
        self.reject(lambda root: self.edit_skill(root, "fastapi-security-parity", lambda s: s.replace("## Gaps", "## Deferred")), "missing/empty Gaps")

    def test_recipe_requires_local_ruleset(self):
        self.reject(lambda root: self.edit_document(root, "skills/source-code-auditing/recipes/offline-python-semgrep.md", lambda s: s.replace("[p2o-python-offline.yaml](semgrep-rules/p2o-python-offline.yaml)", "p2o-python-offline.yaml")), "recipe does not link a local ruleset")

    def test_recipe_requires_metrics_off(self):
        self.reject(lambda root: self.edit_document(root, "skills/source-code-auditing/recipes/offline-python-semgrep.md", lambda s: s.replace("--metrics=off", "--metrics=on")), "recipe missing --metrics=off")

    def test_recipe_rejects_registry_config(self):
        self.reject(lambda root: self.edit_document(root, "skills/source-code-auditing/recipes/offline-python-semgrep.md", lambda s: s + "\nUse --config p/default when the local file is unavailable.\n"), "recipe uses a registry configuration")

    def test_ruleset_rejects_network_reference(self):
        def mutate(root):
            path = root / "skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml"
            path.write_text(path.read_text() + "# see https://semgrep.dev/rules\n")
        self.reject(mutate, "prohibited network reference in ruleset")

    def test_ruleset_requires_original_ids(self):
        def mutate(root):
            path = root / "skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml"
            path.write_text(path.read_text().replace("id: p2o-python-pickle-deserialization", "id: semgrep.python.audit.pickle"))
        self.reject(mutate, "invalid rule id")

    def test_ruleset_rejects_duplicate_ids(self):
        def mutate(root):
            path = root / "skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml"
            path.write_text(path.read_text().replace("id: p2o-python-pickle-deserialization", "id: p2o-python-subprocess-shell-true"))
        self.reject(mutate, "duplicate rule id")

    def test_recipe_and_ruleset_current(self):
        recipe = ROOT / "skills/source-code-auditing/recipes/offline-python-semgrep.md"
        ruleset = ROOT / "skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml"
        text = recipe.read_text()
        errors = []
        provenance = checker.validate_provenance(ROOT, errors)
        self.assertEqual(errors, [])
        checker.validate_recipe(recipe, ROOT, text, checker.sections(text), provenance, errors)
        self.assertEqual(errors, [])
        errors = []
        checker.validate_ruleset(ruleset, ROOT, errors)
        self.assertEqual(errors, [])

    def test_recipe_requires_declared_provenance(self):
        self.reject(lambda root: self.edit_document(root, "skills/source-code-auditing/recipes/offline-python-semgrep.md", lambda s: s.replace("Adapted from reference R6, the reviewed Semgrep CLI guidance", "Adapted from the reviewed Semgrep CLI guidance")), "provenance section lacks a reference id")

    def test_catalog_fixture_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            self.write_catalog(root)
            self.assertEqual(checker.validate(root), [])

    def test_catalog_technique_kind_is_not_tolerated(self):
        """The final runtime catalog must carry the reviewed kind, not the generator default."""
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            self.write_catalog(root, kinds={name: "technique" for name in self.NON_BLOG_SKILLS})
            errors = checker.validate(root)
            self.assertTrue(any("disagrees with staging metadata" in error for error in errors), errors)

    def test_catalog_unknown_capability_rejected(self):
        def mutate(root):
            def change(catalog):
                entry = next(item for item in catalog["skills"] if item["name"] == "web-route-input-inventory")
                next(item for item in entry["workflows"] if item["id"] == "public-baseline")["allOf"] = ["http.upload"]
            self.edit_catalog(root, change)
        self.reject_catalog(mutate, "unknown capability")

    def test_catalog_kind_disagreement_rejected(self):
        def mutate(root):
            def change(catalog):
                next(item for item in catalog["skills"] if item["name"] == "web-route-input-inventory")["kind"] = "overlay"
            self.edit_catalog(root, change)
        self.reject_catalog(mutate, "disagrees")

    def test_catalog_workflows_must_match_staging(self):
        def mutate(root):
            def change(catalog):
                entry = next(item for item in catalog["skills"] if item["name"] == "web-output-context")
                entry["workflows"] = [{"id": "renamed-workflow", "description": "A synthetic rename that no longer matches the authored playbook", "allOf": ["source.snapshot"]}]
            self.edit_catalog(root, change)
        self.reject_catalog(mutate, "workflows differ from staging metadata")

    def test_catalog_capability_drift_rejected(self):
        """A runtime workflow cannot weaken browser proof into local HTTP."""
        def mutate(root):
            def change(catalog):
                entry = next(item for item in catalog["skills"] if item["name"] == "web-output-context")
                next(item for item in entry["workflows"] if item["id"] == "browser-execution-proof")["allOf"] = ["lab.local-http"]
            self.edit_catalog(root, change)
        self.reject_catalog(mutate, "workflows differ from staging metadata")

    def test_catalog_description_must_match_frontmatter(self):
        def mutate(root):
            def change(catalog):
                next(item for item in catalog["skills"] if item["name"] == "web-object-authorization")["description"] = "A synthetic description that does not match the retained frontmatter."
            self.edit_catalog(root, change)
        self.reject_catalog(mutate, "catalog description differs from frontmatter")

    def test_catalog_missing_reference_document_rejected(self):
        def mutate(root):
            def change(catalog):
                catalog["documents"] = [item for item in catalog["documents"] if item["id"] != "web-route-input-inventory:route-inventory-method"]
            self.edit_catalog(root, change)
        self.reject_catalog(mutate, "missing reference document")

    def test_catalog_bad_document_id_rejected(self):
        def mutate(root):
            def change(catalog):
                next(item for item in catalog["documents"] if item["id"] == "web-output-context:source-sink-context")["id"] = "web-output-context:wrong-name"
            self.edit_catalog(root, change)
        self.reject_catalog(mutate, "does not match")

    def test_catalog_bad_shared_prefix_rejected(self):
        def mutate(root):
            def change(catalog):
                next(item for item in catalog["documents"] if item["id"] == "shared:handoffs")["id"] = "handoffs"
            self.edit_catalog(root, change)
        self.reject_catalog(mutate, "shared/evidence prefix")

    def test_catalog_can_replace_sidecars(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            self.write_catalog(root)
            for sidecar in (root / "skills").glob("*/skill.json"):
                sidecar.unlink()
            self.assertEqual(checker.validate(root), [])

    def test_capability_ids_match_runtime_source(self):
        source = ROOT / "src/capabilities.ts"
        if not source.is_file():
            self.skipTest("runtime capability source is not present")
        match = re.search(r"CAPABILITY_IDS\s*=\s*\[(.*?)\]", source.read_text(encoding="utf-8"), re.S)
        self.assertIsNotNone(match)
        runtime = set(re.findall(r"'([a-z0-9.-]+)'", match.group(1)))
        self.assertEqual(runtime, set(checker.STATIC_CAPABILITIES))
        self.assertEqual(runtime, set(checker.runtime_capabilities(ROOT)))

    @staticmethod
    def workflows(root, name):
        return {workflow["id"]: workflow for workflow in json.loads((root / f"skills/{name}/skill.json").read_text())["workflows"]}

    def test_workflow_semantics_match_the_proof_class(self):
        browser = self.workflows(ROOT, "web-output-context")["browser-execution-proof"]
        self.assertEqual(browser["allOf"], ["browser.execution"])
        self.assertNotIn("anyOf", browser)
        self.assertNotIn("lab.local-http", json.dumps(browser))
        navigation = self.workflows(ROOT, "web-route-input-inventory")["authenticated-navigation"]
        self.assertEqual(navigation["allOf"], ["http.authenticated"])
        self.assertNotIn("browser.execution", json.dumps(navigation))
        comparison = self.workflows(ROOT, "web-object-authorization")["controlled-identity-comparison"]
        self.assertEqual(comparison["allOf"], ["http.authenticated"])
        self.assertNotIn("lab.local-http", json.dumps(comparison))

    def test_runtime_catalog_integrates_new_skills(self):
        catalog = json.loads((ROOT / "skills/catalog.json").read_text())
        entries = {entry["name"]: entry for entry in catalog["skills"]}
        documents = {document["id"]: document["path"] for document in catalog["documents"]}
        for name in self.NON_BLOG_SKILLS:
            sidecar = json.loads((ROOT / f"skills/{name}/skill.json").read_text())
            self.assertEqual(entries[name]["kind"], sidecar["kind"], name)
            self.assertEqual(checker.workflow_requirements(entries[name]["workflows"]),
                             checker.workflow_requirements(sidecar["workflows"]), name)
            self.assertEqual(entries[name]["document"], name)
        self.assertEqual(documents["source-code-auditing:offline-python-semgrep"], "skills/source-code-auditing/recipes/offline-python-semgrep.md")
        self.assertEqual(documents["source-code-auditing:offline-python-semgrep-rules"], "skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml")
        self.assertEqual(documents["shared:skill-provenance"], "research/SKILL_PROVENANCE.md")
        self.assertEqual(documents["shared:license-notice"], "research/licenses/README.md")
        self.assertEqual(documents["shared:apache-2.0"], "research/licenses/apache-2.0.md")

    def test_claim_provenance_guidance_present(self):
        reference_path = "skills/source-code-auditing/references/claim-provenance.md"
        reference = (ROOT / reference_path).read_text(encoding="utf-8").lower()
        for phrase in ("intended-policy provenance", "distinct operations", "field constraint", "sibling surfaces", "provenance", "reachability", "open_proof_gap", "confirmed"):
            self.assertIn(phrase, reference)
        playbook = (ROOT / "skills/web-object-authorization/SKILL.md").read_text(encoding="utf-8").lower()
        for phrase in ("intended-policy provenance comes first", "intentionally grant different permissions", "update-path field constraint", "sibling surface", "open_proof_gap", "stays confirmed"):
            self.assertIn(phrase, playbook)
        overlay = (ROOT / "skills/fastapi-security-parity/SKILL.md").read_text(encoding="utf-8").lower()
        self.assertIn("sibling enforcement differences as hypotheses", overlay)
        self.assertIn("open_proof_gap", overlay)
        route = (ROOT / "skills/web-route-input-inventory/SKILL.md").read_text(encoding="utf-8").lower()
        self.assertIn("administrative surface without its effective registration", route)
        for name in ("skills/web-route-input-inventory/SKILL.md", "skills/web-object-authorization/SKILL.md",
                     "skills/web-output-context/SKILL.md", "skills/fastapi-security-parity/SKILL.md"):
            self.assertIn("claim-provenance.md", (ROOT / name).read_text(encoding="utf-8"), name)
        catalog = json.loads((ROOT / "skills/catalog.json").read_text(encoding="utf-8"))
        documents = {document["id"]: document["path"] for document in catalog["documents"]}
        self.assertEqual(documents["source-code-auditing:claim-provenance"], reference_path)

    def test_browser_guidance_distinguishes_managed_interface(self):
        document = (ROOT / "skills/web-output-context/SKILL.md").read_text(encoding="utf-8").lower()
        self.assertIn("managed `browser.execution` interface", document)
        self.assertIn("does not establish that no browser binary exists", document)
        self.assertIn("offline_reproduction", document)
        self.assertIn("not live execution", document)
        sidecar = json.loads((ROOT / "skills/web-output-context/skill.json").read_text(encoding="utf-8"))
        workflow = next(item for item in sidecar["workflows"] if item["id"] == "browser-execution-proof")
        self.assertEqual(workflow["allOf"], ["browser.execution"])
        self.assertIn("offline reproduction", workflow["description"])
        catalog = json.loads((ROOT / "skills/catalog.json").read_text(encoding="utf-8"))
        entry = next(item for item in catalog["skills"] if item["name"] == "web-output-context")
        runtime = next(item for item in entry["workflows"] if item["id"] == "browser-execution-proof")
        self.assertEqual(runtime["description"], workflow["description"])

    def test_new_docs_avoid_benchmark_specifics(self):
        documents = [
            ROOT / "skills/source-code-auditing/references/claim-provenance.md",
            ROOT / "skills/web-route-input-inventory/SKILL.md",
            ROOT / "skills/web-object-authorization/SKILL.md",
            ROOT / "skills/web-output-context/SKILL.md",
            ROOT / "skills/fastapi-security-parity/SKILL.md",
        ]
        forbidden = ("can_export_orders", "operator-digest", "render_diagnostics", "o-1001", "api.storefront.invalid", "bench/fixtures", "chromium")
        for document in documents:
            text = document.read_text(encoding="utf-8").lower()
            for token in forbidden:
                self.assertNotIn(token, text, document.name)

    def test_vendored_license_copy_matches_recorded_hash(self):
        data = json.loads((ROOT / "research/SKILL_PROVENANCE.json").read_text())
        copy = ROOT / data["upstream"]["license_copy"]
        self.assertTrue(copy.is_file())
        self.assertEqual(hashlib.sha256(copy.read_bytes()).hexdigest(), data["upstream"]["license_sha256"])
        self.assertTrue((ROOT / data["upstream"]["license_notice"]).is_file())

    def test_license_copy_mutation_rejected(self):
        def mutate(root):
            path = root / "research/licenses/apache-2.0.md"
            path.write_text(path.read_text() + "\nsynthetic modification\n")
        self.reject(mutate, "license copy hash differs")

    VULNERABLE_FIXTURE = '''\
import pickle
import subprocess
import yaml
import requests


def handler(request):
    subprocess.run(request.args.get("cmd"), shell=True)
    pickle.loads(request.data)
    yaml.load(request.data)
    eval(request.args.get("expr"))
    requests.get(request.args.get("url"))
'''
    FIXED_FIXTURE = '''\
import subprocess
import yaml
import requests


def handler(payload):
    subprocess.run(["true"], shell=False)
    yaml.load(payload, Loader=yaml.SafeLoader)
    requests.get("https://example.invalid/", timeout=5)
'''
    EXPECTED_RULES = (
        "p2o-python-subprocess-shell-true",
        "p2o-python-pickle-deserialization",
        "p2o-python-yaml-load-unsafe",
        "p2o-python-dynamic-code-evaluation",
        "p2o-python-http-request-without-timeout",
    )

    @unittest.skipUnless(os.environ.get("P2O_TEST_SEMGREP") == "1", "opt-in Semgrep runtime test")
    def test_ruleset_runs_on_synthetic_samples(self):
        """Opt-in vulnerable/fixed check; the default suite stays hermetic."""
        binary = shutil.which("semgrep")
        if not binary:
            self.skipTest("semgrep is not installed")
        ruleset = ROOT / "skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml"
        with tempfile.TemporaryDirectory() as directory:
            sample = Path(directory) / "sample"
            sample.mkdir()
            (sample / "vulnerable.py").write_text(self.VULNERABLE_FIXTURE)
            (sample / "fixed.py").write_text(self.FIXED_FIXTURE)
            report = Path(directory) / "semgrep.json"
            result = subprocess.run(
                [binary, "scan", "--config", str(ruleset), "--metrics=off", "--json", "--output", str(report),
                 "--quiet", "--jobs", "1", "--timeout", "20", "--max-memory", "512", "--no-git-ignore", str(sample)],
                capture_output=True, text=True, timeout=300, check=False,
            )
            self.assertTrue(report.is_file(), result.stdout + result.stderr)
            data = json.loads(report.read_text())
            self.assertEqual(data.get("errors"), [], data.get("errors"))
            found = {}
            for finding in data.get("results", []):
                rule = finding["check_id"].rsplit(".", 1)[-1]
                found.setdefault(rule, []).append(Path(finding["path"]).name)
            for rule in self.EXPECTED_RULES:
                self.assertIn(rule, found, sorted(found))
                self.assertEqual(set(found[rule]), {"vulnerable.py"}, rule)

    def test_non_blog_skill_does_not_change_blog_statistics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.copied_root(directory)
            skill = root / "skills/synthetic-playbook"
            skill.mkdir()
            (skill / "SKILL.md").write_text("---\nname: synthetic-playbook\ndescription: A synthetic non-blog skill used to test the renderer statistics.\n---\n\n# Synthetic\n")
            corpus = renderer.synchronize(root, renderer.load_json(root / "research/corpus.json"))
            self.assertEqual(corpus["statistics"]["skills"], 17)
            owners = {owner for entry in corpus["entries"] for owner in entry["skills"]}
            self.assertNotIn("synthetic-playbook", owners)


if __name__ == "__main__":
    unittest.main()
