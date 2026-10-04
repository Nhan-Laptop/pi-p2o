"""Synthetic mutation fixtures for Orange editorial gates; not article/target replications."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import orange_research as orange


class OrangeGateTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        base = root / "research/orange"
        (base / "extractions").mkdir(parents=True)
        owner = "source-code-auditing"
        skill = root / f"skills/{owner}/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("# Synthetic skill fixture\nGeneric contract review. O001\n")
        rows = [{"id": f"O{i:03}", "title": f"Synthetic article {i}", "url": f"https://blog.orange.tw/posts/synthetic-{i}/", "date": "2000-01-01", "year": "2000", "index_page": "https://blog.orange.tw/articles/"} for i in range(1, 4)]
        index = {"schema_version": 1, "index_url": "https://blog.orange.tw/articles/", "retrieved_at": "2000-01-01T00:00:00Z", "pagination": {"entry_counts": [1, 1, 1], "markers_observed": [f"Page {i} of 3" for i in range(1, 4)], "page_3": "Only previous control; no forward link"}, "entries": rows}
        metadata, curation, delegation, checks, runtimes = [], [], [], [], []
        for i, row in enumerate(rows):
            source = row["id"]
            evidence = [{"id": "E1", "locator": "Synthetic method paragraph one", "quote": "Compare the producer contract with the consumer contract.", "verified": True}, {"id": "E2", "locator": "Synthetic method paragraph two", "quote": "Keep a normal baseline and contrasting observations.", "verified": True}]
            included = i == 0
            disposition = "included" if included else "context" if i == 1 else "excluded"
            packet = {"schema_version": 1, "source_id": source, "url": row["url"], "observed_title": row["title"], "retrieved_at": index["retrieved_at"],
                      "retrieval": {"tool": "synthetic fixture", "response_id": "fixture", "final_url": row["url"], "outcome": "read", "quote_verification": "Synthetic structural test, not a web-source receipt."},
                      "disposition": disposition, "reason": "Synthetic documented relevance decision for mutation tests.", "canonical_source": None,
                      "evidence": evidence, "workflow": [{"decision": "Compare the specific producer and consumer invariant.", "evidence": ["E1"]}, {"decision": "Design contrasting observations against a normal baseline.", "evidence": ["E2"]}],
                      "tools": [], "handoffs": [], "limitations": ["This is synthetic data and not independent article or runtime evidence."],
                      "candidate_additions": [{"owner": owner, "kind": "workflow", "guidance": "Compare producer and consumer contracts using a normal control and a bounded observation.", "evidence": ["E1", "E2"]}] if included else [],
                      "related_article_urls": [], "excluded_material": ["No executable or target-specific content."], "worker_notes": "Fixture only."}
            self.dump(base / f"extractions/{source}.json", packet)
            metadata.append({"id": source, "url": row["url"], "retrieved_at": index["retrieved_at"], "http_status": 200, "final_url": row["url"], "response_html_sha256": "a"*64, "response_html_bytes": 100})
            curation.append({"source_id": source, "disposition": disposition, "reason": packet["reason"], "canonical_source": None, "accepted_candidates": [0] if included else [], "review_notes": "Synthetic reviewer decision."})
            delegation.append({"source_id": source, "url": row["url"], "agent_name": f"worker-{source.lower()}v001", "model": "openai-codex-account-3/gpt-6.1-sol:max", "status": "completed", "pane_id": f"fixture:{i}", "completed_at": index["retrieved_at"]})
            checks.append({"source_id": source, "url": row["url"], "final_url": row["url"], "publication_url": row["url"], "http_status": 200,
                           "retrieved_at": index["retrieved_at"], "article_text_sha256": "b"*64,
                           "quotes": [{"id": q["id"], "matched": True, "match_mode": "exact", "quote_sha256": hashlib.sha256(q["quote"].encode()).hexdigest()} for q in evidence]})
            runtimes.append({"source_id": source, "agent_name": delegation[-1]["agent_name"], "session": {"id": f"fixture-session-{source}"},
                             "model": {"provider": "openai-codex-account-3", "modelId": "gpt-6.1-sol"}, "thinking": {"thinkingLevel": "max"}})
        for name, value in [("inventory.json", index), ("source-metadata.json", {"entries": metadata}), ("curation.json", {"entries": curation}), ("delegations.json", {"entries": delegation}), ("quote-verification.json", {"entries": checks}), ("worker-runtime-receipts.json", {"entries": runtimes})]:
            self.dump(base / name, value)
        for path, rendered in orange.render_outputs(root).items():
            path.write_text(rendered)
        return root

    @staticmethod
    def dump(path, value):
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+"\n")

    @staticmethod
    def edit(root, name, change):
        path = root / f"research/orange/{name}"
        value = json.loads(path.read_text())
        change(value)
        OrangeGateTests.dump(path, value)

    def reject(self, mutate, message):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            mutate(root)
            errors = orange.validate(root)
            self.assertTrue(any(message in e for e in errors), errors)

    def test_synthetic_fixture_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(orange.validate(self.fixture(directory)), [])

    def test_missing_article_packet_rejected(self):
        self.reject(lambda r: (r / "research/orange/extractions/O002.json").unlink(), "invalid/missing corpus data")

    def test_missing_pagination_page_rejected(self):
        self.reject(lambda r: self.edit(r, "inventory.json", lambda x: x["pagination"]["markers_observed"].pop()), "pagination coverage differs")

    def test_duplicate_worker_identity_rejected(self):
        self.reject(lambda r: self.edit(r, "delegations.json", lambda x: x["entries"][1].update(agent_name=x["entries"][0]["agent_name"])), "one-worker-per-article")

    def test_incomplete_worker_rejected(self):
        self.reject(lambda r: self.edit(r, "delegations.json", lambda x: x["entries"][0].update(status="starting")), "delegation incomplete")

    def test_wrong_requested_runtime_rejected(self):
        self.reject(lambda r: self.edit(r, "delegations.json", lambda x: x["entries"][0].update(model="unrequested-model")), "delegation incomplete")

    def test_quote_match_failure_rejected(self):
        self.reject(lambda r: self.edit(r, "quote-verification.json", lambda x: x["entries"][0]["quotes"][0].update(matched=False)), "quote not independently verified")

    def test_quote_hash_mismatch_rejected(self):
        self.reject(lambda r: self.edit(r, "quote-verification.json", lambda x: x["entries"][0]["quotes"][0].update(quote_sha256="invalid")), "quote not independently verified")

    def test_unknown_claim_evidence_rejected(self):
        self.reject(lambda r: self.edit(r, "extractions/O001.json", lambda x: x["workflow"][0].update(evidence=["E99"])), "unknown/missing evidence")

    def test_excessive_quote_rejected(self):
        self.reject(lambda r: self.edit(r, "extractions/O001.json", lambda x: x["evidence"][0].update(quote="a"*181)), "invalid method quotation")

    def test_wrong_tool_attribution_rejected(self):
        self.reject(lambda r: self.edit(r, "extractions/O001.json", lambda x: x["tools"].append({"tool":"Synthetic observer", "purpose":"Inspect a bounded local state", "when":"The selected contract remains unknown", "attribution":"author-agent", "evidence":["E1"]})), "invalid tool attribution")

    def test_unowned_candidate_rejected(self):
        self.reject(lambda r: self.edit(r, "extractions/O001.json", lambda x: x["candidate_additions"][0].update(owner="missing-skill")), "unsafe/unowned candidate")

    def test_target_specific_candidate_rejected(self):
        self.reject(lambda r: self.edit(r, "extractions/O001.json", lambda x: x["candidate_additions"][0].update(guidance="Synthetic prohibited candidate uses address 0xdeadbeef.")), "unsafe/unowned candidate")

    def test_unaccepted_source_citation_rejected(self):
        def mutate(root):
            path = root / "skills/source-code-auditing/SKILL.md"
            path.write_text(path.read_text()+"\nO002\n")
        self.reject(mutate, "counted as operational evidence")

    def test_invalid_accepted_index_rejected(self):
        self.reject(lambda r: self.edit(r, "curation.json", lambda x: x["entries"][0].update(accepted_candidates=[99])), "accepted candidate index invalid")

    def test_duplicate_requires_retained_canonical(self):
        self.reject(lambda r: self.edit(r, "curation.json", lambda x: x["entries"][2].update(disposition="duplicate", canonical_source="O002")), "canonical source not retained")

    def test_retained_source_needs_retrieval_receipt(self):
        self.reject(lambda r: self.edit(r, "source-metadata.json", lambda x: x["entries"][0].update(response_html_sha256="bad")), "retained source retrieval failed")

    def test_renderer_detects_stale_output(self):
        self.reject(lambda r: (r / "research/orange/evidence.md").write_text("stale\n"), "stale generated artifact")

    def test_renderer_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            self.assertEqual(orange.render_outputs(root), orange.render_outputs(root))

    def test_candidate_override_is_rendered_without_packet_rewrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            packet_path = root / "research/orange/extractions/O001.json"
            original = packet_path.read_bytes()
            guidance = "Editorial refinement: distinguish actual consumer state from an inferred producer guarantee."
            self.edit(root, "curation.json", lambda x: x["entries"][0].update(candidate_overrides={"0": {"kind": "validation", "guidance": guidance}}))
            outputs = orange.render_outputs(root)
            self.assertIn(guidance, outputs[root / "research/orange/evidence.md"])
            self.assertEqual(packet_path.read_bytes(), original)
            for path, rendered in outputs.items():
                path.write_text(rendered)
            self.assertEqual(orange.validate(root), [])

    def test_override_cannot_change_evidence(self):
        self.reject(lambda r: self.edit(r, "curation.json", lambda x: x["entries"][0].update(candidate_overrides={"0": {"evidence": ["E99"]}})), "invalid candidate override")

    def test_override_index_must_exist(self):
        self.reject(lambda r: self.edit(r, "curation.json", lambda x: x["entries"][0].update(candidate_overrides={"99": {"guidance": "A synthetic invalid index cannot create an additional evidence-backed candidate."}})), "invalid candidate override")

    def test_override_owner_must_exist(self):
        self.reject(lambda r: self.edit(r, "curation.json", lambda x: x["entries"][0].update(candidate_overrides={"0": {"owner": "missing-owner"}})), "unsafe/unowned adopted guidance")

    def test_override_cannot_add_recipe(self):
        self.reject(lambda r: self.edit(r, "curation.json", lambda x: x["entries"][0].update(candidate_overrides={"0": {"guidance": "A synthetic prohibited candidate includes address 0xdeadbeef."}})), "unsafe/unowned adopted guidance")

    def test_override_owner_requires_operational_citation(self):
        def mutate(root):
            path = root / "skills/binary-auditing/SKILL.md"
            path.parent.mkdir()
            path.write_text("# Synthetic alternate owner\nNo Orange source citation here.\n")
            self.edit(root, "curation.json", lambda x: x["entries"][0].update(candidate_overrides={"0": {"owner": "binary-auditing"}}))
        self.reject(mutate, "adopted candidate lacks owner citation")

    def test_original_owner_requires_operational_citation(self):
        self.reject(lambda r: (r / "skills/source-code-auditing/SKILL.md").write_text("# Synthetic owner without its adopted source citation\n"), "adopted candidate lacks owner citation")

    def test_quote_receipt_identity_required(self):
        self.reject(lambda r: self.edit(r, "quote-verification.json", lambda x: x["entries"][0].update(url=x["entries"][1]["url"])), "independent source receipt invalid")

    def test_failed_independent_retrieval_rejected(self):
        self.reject(lambda r: self.edit(r, "quote-verification.json", lambda x: x["entries"][0].update(http_status=404)), "independent source receipt invalid")

    def test_independent_text_hash_required(self):
        self.reject(lambda r: self.edit(r, "quote-verification.json", lambda x: x["entries"][0].update(article_text_sha256="bad")), "independent source receipt invalid")

    def test_nonexact_matching_mode_rejected(self):
        self.reject(lambda r: self.edit(r, "quote-verification.json", lambda x: x["entries"][0]["quotes"][0].update(match_mode="fuzzy")), "unsupported quote matching mode")

    def test_duplicate_quote_receipt_rejected(self):
        self.reject(lambda r: self.edit(r, "quote-verification.json", lambda x: x["entries"][0]["quotes"].append(dict(x["entries"][0]["quotes"][0]))), "evidence coverage differs")

    def test_quote_origin_mismatch_rejected(self):
        self.reject(lambda r: self.edit(r, "quote-verification.json", lambda x: x["entries"][0].update(publication_url="https://example.invalid/unobserved-publication/")), "quotation origin mismatch")

    def test_linked_publication_requires_its_own_receipt(self):
        def mutate(root):
            url = "https://example.invalid/synthetic-direct-publication/"
            self.edit(root, "extractions/O001.json", lambda x: x["retrieval"].update(final_url=url))
            self.edit(root, "quote-verification.json", lambda x: x["entries"][0].update(publication_url=url))
        self.reject(mutate, "linked-publication receipt invalid")

    def test_valid_linked_publication_is_explicitly_attributed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            url = "https://example.invalid/synthetic-direct-publication/"
            self.edit(root, "extractions/O001.json", lambda x: x["retrieval"].update(final_url=url))
            def update_checks(value):
                entry = value["entries"][0]
                entry["publication_url"] = url
                entry["publication_verification"] = {"source_id": "O001", "publication_url": url, "retrieved_at": entry["retrieved_at"], "rendered_body_sha256": "c"*64, "tool": "synthetic structural fixture, not a public-source receipt", "quotes": entry["quotes"]}
            self.edit(root, "quote-verification.json", update_checks)
            outputs = orange.render_outputs(root)
            self.assertIn("**Quotation origin:**", outputs[root / "research/orange/evidence.md"])
            self.assertIn(url, outputs[root / "research/orange/evidence.md"])
            for path, rendered in outputs.items():
                path.write_text(rendered)
            self.assertEqual(orange.validate(root), [])

    def test_editorial_qualifications_survive_rendering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            self.assertIn("**Editorial qualifications:** Synthetic reviewer decision.", orange.render_outputs(root)[root / "research/orange/evidence.md"])

    def test_wrong_observed_runtime_rejected(self):
        self.reject(lambda r: self.edit(r, "worker-runtime-receipts.json", lambda x: x["entries"][0]["model"].update(modelId="different-model")), "observed worker runtime mismatch")

    def test_duplicate_child_session_rejected(self):
        self.reject(lambda r: self.edit(r, "worker-runtime-receipts.json", lambda x: x["entries"][1].update(session=x["entries"][0]["session"])), "one-worker-per-article session identity")


if __name__ == "__main__":
    unittest.main()
