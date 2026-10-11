Tests: wstg-busl-08, wstg-busl-09

# File upload acceptance

Cards for [web business logic misuse](../SKILL.md). Both ask whether the upload path actually enforces the type policy it is meant to, using only harmless, inert fixture files whose content has no effect beyond being readable. Whether a stored file can be executed, or whether extraction logic has unsafe effects on paths and links, is a structural question for the skills these cards hand off to; it is not answered by uploading anything with real payload content.

### wstg-busl-08 Accepted type boundary
- Trigger: documentation, a comment, or the interface's own restrictions imply which file types an upload feature accepts and which it rejects.
- Inputs: the baseline accepted upload (A); the type-checking code (S).
- Steps: name the accepted-type policy and its source. Prepare a small set of harmless fixture files whose content is inert (plain text or a minimal valid file of an allowed format) but whose declared extension, declared content type, or internal format signature individually disagrees with the others, one disagreement per file. Upload each and compare acceptance and the type the application records against the baseline. In source, confirm whether the check reads the file's actual content signature or only a client-supplied extension or content-type header.
- Conclude: confirmed when a file whose true format does not match the accepted policy is accepted because only an easily spoofed signal (extension or declared content type) was checked, with the rule and the check's basis named from source. Whether an accepted file can then be made to execute is a separate, harder question that stays an open_proof_gap here and routes to [sandbox boundary analysis](../../sandbox-boundary-analysis/SKILL.md) or [deserialization and dispatch auditing](../../deserialization-and-dispatch-auditing/SKILL.md) depending on how it would be processed.
- Evidence: the policy and its source; each fixture file's declared versus true format and the acceptance result; the source location of the check and what it inspects.
- Record: cell for wstg-busl-08.
- Stop: every fixture file's content must be inert; never upload a file whose content is designed to run, decompress unusually, or affect anything beyond being stored and read back.
- Not a finding when: the check is confirmed in source to inspect the actual content signature rather than a client-supplied label.

### wstg-busl-09 Processing of accepted content
- Trigger: an upload is accepted and then processed by the application beyond storing and serving it back unchanged (resized, converted, scanned, extracted, indexed, or rendered into another format).
- Inputs: the processing code and its configuration (S); a controlled upload of an inert fixture file in the accepted format (A), only for formats where processing has no side effect beyond producing an output file you also control.
- Steps: in source, read what the processing step does and identify three structural questions, answering each from source rather than by constructing a working case: whether archive extraction writes to a location derived from unvalidated entry names, whether any symbolic or similar reference inside a processed format is followed outside the extraction target, and whether the processing step enforces an output size or resource bound. Where the task's scope separately and explicitly authorizes it, confirm only the bound question live, with a fixture file whose declared size is large but whose actual content is tiny and inert, observing only whether the application enforces a limit before fully processing it.
- Conclude: confirmed when source shows an unvalidated entry name reaches a write location outside the intended extraction target, when a followed reference is confirmed in source to escape that target, or when no resource bound is enforced and the live bound check (if run) shows unconstrained processing. Record each as a structural finding citing the source location; do not construct a case that actually achieves an out-of-bounds write or read to prove it further, since that is a deeper reachability question for [sandbox boundary analysis](../../sandbox-boundary-analysis/SKILL.md).
- Evidence: the source locations for entry-name handling, reference-following, and bound enforcement; the live receipt only for the bound check when scope authorized it.
- Record: cell for wstg-busl-09; `execution: blocked` with the missing authorization named for any structural question not confirmed live.
- Stop: never upload or construct a file designed to write outside an intended location, follow a reference outside it, or exhaust resources; the bound check, if run at all, uses a small inert file and stops at the first sign the limit is missing.
- Not a finding when: source confirms entry names are validated against the extraction target, no reference is followed outside it, and a resource bound is enforced before full processing.
