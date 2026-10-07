# Vendored upstream license notice

This directory preserves the license text of the reviewed upstream snapshot used to adapt the application playbooks, framework overlay, and offline Semgrep recipe.

| Item | Value |
|---|---|
| Upstream project | usestrix/strix |
| Distribution | strix-agent |
| Revision | 1.7.0 from the snapshot package metadata; the snapshot carries no git commit identifier |
| License | Apache-2.0 |
| License file SHA-256 | `7db9697134251e314bd8d39257fe170c98b3e2ad9b2ed67e97acaf9613e7b9e3` |
| Verbatim copy | [apache-2.0.md](apache-2.0.md) |
| Reviewed | 2026-10-07 |

## Why this copy exists

The adapted guidance is an independent paraphrase, not a copy of upstream text, code, rules, or payloads. Apache-2.0 requires attribution when material is adapted, so attribution is preserved conservatively here even though the adaptations are paraphrases: the exact license text is retained beside the provenance record, and [SKILL_PROVENANCE.md](../SKILL_PROVENANCE.md) identifies every reviewed document by title and content hash together with what was adapted and what was rejected.

This is attribution only. The repository's own licensing status is unchanged, no upstream source file or NOTICE file was copied, and there is no runtime, packaged, or network dependency on the review snapshot. The [provenance record](../SKILL_PROVENANCE.md) remains the authority for which guidance was adapted or excluded.

## Verification

The copy is byte-identical to the reviewed snapshot's `LICENSE`. Its SHA-256 must equal the value recorded in [SKILL_PROVENANCE.json](../SKILL_PROVENANCE.json); `scripts/validate_library.py` and the Python test suite re-check the vendored copy even when the untracked review snapshot is absent.
