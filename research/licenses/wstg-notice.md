# Vendored upstream license notice: OWASP Web Security Testing Guide

This notice accompanies the license text of the second reviewed upstream, the OWASP Web Security Testing Guide, which informs the web testing playbooks added after the Strix-derived set described in [README.md](README.md).

| Item | Value |
|---|---|
| Upstream project | OWASP/wstg (OWASP Web Security Testing Guide) |
| Revision | `28553f878d48358767892916d53e59a9d664811c`, the head of the master branch when the guide was read on 2026-10-11 |
| License | CC-BY-SA-4.0 (Attribution-ShareAlike 4.0 International) |
| License file SHA-256 | `9312b09a6848f26c6046652238ddd6b32ea2124847faed48854c375c5194238d` |
| Verbatim copy | [cc-by-sa-4.0.md](cc-by-sa-4.0.md) |
| Reviewed | 2026-10-11 |

## Why this copy exists

The guide is a reference, not a dependency. The testing playbooks that cite it restate its guidance in this library's own words: a test is reduced to its trigger, inputs, bounded steps, controls, conclusion rules, evidence and stop conditions, and every tool tutorial, payload, screenshot and long worked example is left out. No page, image or code sample of the guide is shipped. Test identifiers (for example `WSTG-SESS-03`) and page titles are used only as references, so that a reader can find the original.

Because the guide is licensed under a share-alike license, attribution is kept conservatively: the exact license text is retained beside the provenance record, and [WSTG_PROVENANCE.md](../WSTG_PROVENANCE.md) names every reviewed chapter with a digest of the pages used, what was adapted and what was rejected. Whether any restated guidance counts as an adaptation that carries the share-alike condition is not decided here; it is an open question for the repository owner and not legal advice.

This is attribution only. The repository's own licensing status is unchanged, and there is no runtime, packaged or network dependency on the guide or on the review copy.

## Verification

The copy is byte-identical to the guide's `LICENSE` at the recorded revision. Its SHA-256 must equal the value recorded in [WSTG_PROVENANCE.json](../WSTG_PROVENANCE.json); `scripts/validate_library.py` and the Python test suite re-check the vendored copy even when the untracked review copy is absent.
