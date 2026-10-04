"""Offline mutation tests for the knowledge library's quality gates."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import render_research as renderer
import validate_library as checker


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
        for folder in ("skills", "research", "templates", "scripts"):
            shutil.copytree(ROOT / folder, root / folder, ignore=shutil.ignore_patterns("__pycache__"))
        for name in ("README.md", "HANDOFFS.md"):
            shutil.copy2(ROOT / name, root / name)
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


if __name__ == "__main__":
    unittest.main()
