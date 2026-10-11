# Provenance of the guidance adapted from the OWASP Web Security Testing Guide

## Scope and review boundary

This record covers the web testing playbooks and reference cards that restate guidance from the OWASP Web Security Testing Guide (WSTG). It is separate from [SKILL_PROVENANCE.md](SKILL_PROVENANCE.md), which records the Strix-derived playbooks under their own Apache-2.0 license; the two upstreams have different licenses, so each keeps its own record and its own license copy.

The guide is primarily a reference, not a dependency: guidance was rewritten for this library's evidence policy, and the test identifiers (for example `WSTG-SESS-03`) mostly serve only as references. Since 2026-10-11, `my_references/wstg/` also ships read-only and each owning skill links its own tests' unmodified upstream pages on demand through `references/wstg-source.md` (never inlined into a SKILL.md, never a substitute for a card's method) — see "On-demand upstream links" below; no image or tool tutorial is shipped, and this project's own code never depends on the guide at runtime. Nothing here is legal advice or a decision about whether a restatement is an adaptation under the license; that question is left to the repository owner.

## Upstream identity

| Item | Value | SHA-256 |
|---|---|---|
| Revision | OWASP/wstg `28553f878d48358767892916d53e59a9d664811c` (master head, read 2026-10-11) | not applicable |
| License | CC-BY-SA-4.0 | `9312b09a6848f26c6046652238ddd6b32ea2124847faed48854c375c5194238d` |
| Vendored license copy | [research/licenses/cc-by-sa-4.0.md](licenses/cc-by-sa-4.0.md) with [notice](licenses/wstg-notice.md) | byte-identical to the recorded license hash |

The machine-readable form is [WSTG_PROVENANCE.json](WSTG_PROVENANCE.json). `scripts/validate_library.py` re-checks the structure, the vendored license hash and the credit of every skill that cites a reference; the Python tests recompute the chapter digests when the untracked review copy under `my_references/wstg` is present.

## On-demand upstream links

Separately from the Credits column above (which records which skill's *card prose* was adapted from reading a chapter), every WSTG test with an owner in [src/wstg-map.ts](../src/wstg-map.ts) now has a one-line link from its owner's `references/wstg-source.md` to that test's own unmodified upstream page — generated mechanically from the owner table, by exact title match against the review copy, not by re-reading or re-adapting the chapter. A skill can carry this link without appearing in a chapter's Credits (its owned tests happened to land in that chapter without its card prose being adapted from it); the reverse does not happen. Catalog documents outside `skills/` use the `wstg-source:` id prefix (`scripts/validate_library.py`); `skills/catalog.json` is the authoritative list.

**Caveat every `wstg-source.md` card points here instead of repeating:** a skill's other cards already state the method, conclusion rule and false-positive checks for each test. Open an upstream link only when a card leaves a real question unanswered — it is the unmodified guide page, not this library's bounded-comparison method, and it can describe concrete payloads, tool-specific steps or exploitation walkthroughs that the card deliberately leaves out. Treat it as background reading, never as a substitute for a card's controls, stop conditions or evidence fields, and never as license to exceed this library's no-payload, no-destructive-action policy.

## How a chapter digest is computed

A reference names one WSTG chapter directory. Its digest is the SHA-256 of the text made of one line per Markdown page below that directory, sorted by relative path, each line being the relative path, a tab, the SHA-256 of that page's bytes, and a newline. The recorded page count is the number of those lines. Images are not part of the digest.

## References

Each reference is one chapter of the guide. The digest covers every Markdown page of the chapter at the recorded revision, so a chapter that gains or loses a page changes it.

| Ref | Chapter | Pages | Digest (SHA-256) | Credits |
|---|---|---|---|---|
| W1 | OWASP WSTG 4.1 Information Gathering (`4-Web_Application_Security_Testing/01-Information_Gathering`) | 12 | `cbb562ef580e5c6c84b12a32987b65c7caea09bb32da423df259b6e0f5a78086` | web-deployment-hygiene |
| W2 | OWASP WSTG 4.2 Configuration and Deployment Management (`4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management`) | 16 | `324f6bef84f35d96e0d547b7638373afeab205c392afe2e637bf2f94a214c382` | web-deployment-hygiene, web-browser-trust-controls |
| W3 | OWASP WSTG 4.3 Identity Management (`4-Web_Application_Security_Testing/03-Identity_Management`) | 6 | `e408e14ad8677459f87a0b968d60f1b0c44939100da44b88cebf8ab113e85a71` | web-credential-lifecycle, web-object-authorization |
| W4 | OWASP WSTG 4.4 Authentication (`4-Web_Application_Security_Testing/04-Authentication`) | 12 | `10bbd5a4375020fcd5629d617d1567d07016c93fecaf21adf65ecf8eb3cdeb3a` | web-deployment-hygiene, web-credential-lifecycle |
| W5 | OWASP WSTG 4.5 Authorization (`4-Web_Application_Security_Testing/05-Authorization`) | 8 | `29b831e7993f9a92dadaf31e5c5399db464ad182d9b6af68324d88c84cc37ac4` | web-token-and-federation |
| W6 | OWASP WSTG 4.6 Session Management (`4-Web_Application_Security_Testing/06-Session_Management`) | 12 | `25ae311e57b421bfc63530acbe317fa3c6eafdda1abfd6f59313b322f4da9cb9` | web-session-management, web-token-and-federation, web-browser-trust-controls |
| W7 | OWASP WSTG 4.7 Injection (`4-Web_Application_Security_Testing/07-Injection`) | 34 | `9cbe5730ba7588c9a7442767c35bd000082726a909ad1274ca6e10da7f73f333` | web-object-authorization, parser-differential-auditing, attack-surface-mapping, web-server-side-injection |
| W8 | OWASP WSTG 4.8 Error Handling (`4-Web_Application_Security_Testing/08-Error_Handling`) | 3 | `3f9770f79245fb2e7cfb5fe3d0170cbc8cf83b8765456223123c5a046d9adc12` | web-deployment-hygiene |
| W9 | OWASP WSTG 4.9 Weak Cryptography (`4-Web_Application_Security_Testing/09-Weak_Cryptography`) | 5 | `7477e961e357fca3d502a812620043174a4afa238f17f3dab94d6a871153398d` | web-deployment-hygiene, web-crypto-usage-review |
| W10 | OWASP WSTG 4.10 Business Logic (`4-Web_Application_Security_Testing/10-Business_Logic`) | 12 | `10eff04633a553ff3fc6e963b33864fdffca8cd89be8abf1582df1aa037270e2` | race-condition-auditing, web-business-logic-misuse |
| W11 | OWASP WSTG 4.11 Client-side (`4-Web_Application_Security_Testing/11-Client-side`) | 17 | `b8c41706446ec85b4c1019f1e65de05e78aa03cef72b76ce89114a62a0576218` | web-browser-trust-controls |
| W12 | OWASP WSTG 4.12 API Testing (`4-Web_Application_Security_Testing/12-API_Testing`) | 7 | `210da5fa161edf0a52746af34a9bc56dc976268cb1b0cd28d5c3f8fc9d290813` | web-object-authorization, web-graphql-testing |
| W14 | OWASP WSTG 5 Reporting (`5-Reporting`) | 3 | `959b6fd4f3322cd99d84e6be9a8d9c0fab359ab553b1e37493777c528ba34d1b` | remediation |

### W1 — 4.1 Information Gathering

**Adapted:** Fingerprint, metafile, page-content and framework identification restated as bounded comparisons against a fixed baseline response set. **Excluded:** Search-engine reconnaissance and DNS or virtual-host enumeration (outside the confirmed origin), tool tutorials, screenshots and sample output.

### W2 — 4.2 Configuration and Deployment Management

**Adapted:** Platform configuration, backup-file, administrative-interface, HTTP-method, HSTS, security-header and feature-flag checks restated with controls, source-review counterparts and stop conditions; Content security policy header review restated as a directive-weakness check against the baseline route set. **Excluded:** Network-infrastructure, cloud-storage and subdomain-takeover tests (other origins), cloud command lines, wordlist enumeration and tool tutorials; Bypass-technique catalogs and JSONP-callback exploitation walkthroughs.

### W3 — 4.3 Identity Management

**Adapted:** Registration, provisioning and account-enumeration checks restated with throwaway accounts, fixed sample counts and stop conditions; Role-inventory and role-switching checks restated as a comparison between documented permissions and observed reach. **Excluded:** Screenshots of third-party products and tool tutorials.

### W4 — 4.4 Authentication

**Adapted:** Browser-cache directive review restated for sensitive authenticated responses; Default-credential, password-rule, lockout, security-question, reset, remember-me and MFA checks restated with counted attempts, operator-controlled mailboxes and stop conditions. **Excluded:** Credential-guessing procedures and tool tutorials; those are handled by cards with their own safeguards; Password lists, credential-stuffing and spraying procedures, and tool tutorials.

### W5 — 4.5 Authorization

**Adapted:** Delegated authorization flow checks restated as application-side enforcement of destination matching and one-time value consumption, using a controlled client registration. **Excluded:** Credential-leakage-channel catalogs and identity-provider-specific exploitation walkthroughs.

### W6 — 4.6 Session Management

**Adapted:** Token strength, cookie attribute, fixation, exposure, replay, logout, timeout and concurrency checks restated as bounded comparisons with controls, named HTTP sessions and stop conditions; Structured bearer token acceptance checks restated as bounded structural-property changes against a baseline, without the signing key; Cross-site request forgery and request-origin checks restated as a request-bound-token comparison and a SameSite reading, without constructing a live cross-site submission. **Excluded:** Token-prediction tooling and brute-force procedures, forced-cookie attack walkthroughs, tool tutorials, screenshots and sample traffic; Library-specific vulnerability catalogs and tool tutorials; Proof-of-concept HTML form catalogs.

### W7 — 4.7 Injection

**Adapted:** Mass-assignment field-addition checks restated as a one-field-at-a-time comparison against a declared or source-confirmed field allow list; HTTP parameter pollution and response-header injection checks restated as a bounded one-marker comparison between layers, with no connection-desynchronization content; Host and forwarded-host trust checks restated as a one-variable comparison against sinks the application itself reaches, with no cache-poisoning or exploitation walkthrough; Query-language, document-parser, process/template-interpreter, format-call, outbound-request, path-resolution and stored/second-order injection checks restated as bounded, harmless boundary-class comparisons with an inert control, stopping at structural influence rather than exploitation. **Excluded:** Framework-specific binder walkthroughs and payload catalogs; Payload catalogs, intermediary-specific exploitation walkthroughs and tool tutorials; Payload catalogs and intermediary-specific exploitation walkthroughs; Payload catalogs, exploitation walkthroughs, filter-bypass encodings, and any content demonstrating code execution, data exfiltration or denial of service.

### W8 — 4.8 Error Handling

**Adapted:** Error-output comparison against the stock server error with a small fixed set of malformed requests. **Excluded:** Fuzzing and crash-inducing inputs, and product-specific error catalogs.

### W9 — 4.9 Weak Cryptography

**Adapted:** TLS configuration facts and clear-channel checks restated around the handshake tools the sandbox provides; Weak-primitive and decryption-error-path checks restated as a source-reading checklist against a fixed weakness list, and a single distinguishability comparison that stops short of key recovery. **Excluded:** Exploit demonstrations of protocol attacks, scanner tutorials and long vulnerability catalogs; Exploit scripts for recovering key material through repeated oracle queries.

### W10 — 4.10 Business Logic

**Adapted:** Usage-ceiling bypass restated as sequential replay and step re-entry checked first, with the existing two-actor schedule method applied only if the sequential path is sound; Business-logic validation, hidden-field, component-integrity, timing, workflow-order, defense-observation, upload-type-boundary, upload-processing and transaction-recomputation checks restated as named-rule comparisons with inert fixture data, deferring any executable or exploit-demonstrating content to other skills as an open proof gap. **Excluded:** Payment-specific and provider-specific exploitation walkthroughs; Payload catalogs, web-shell and archive-exploitation walkthroughs, and PCI-specific compliance checklists.

### W11 — 4.11 Client-side

**Adapted:** CORS, framing, script-loadable-response, WebSocket-origin, client-side sink, messaging, storage and new-tab isolation checks restated as source-to-sink tracing and declared-header comparison, stopping at offline reproduction without a managed browser transport; Client-side template-evaluation checks restated as a plain-text-versus-template-source source trace, stopping at expression evaluation rather than script execution. **Excluded:** DOM-based proof-of-concept payload catalogs and browser-exploitation walkthroughs.

### W12 — 4.12 API Testing

**Adapted:** Field-level response-exposure checks restated as a principal-pair diff of serialized fields, extended to list, search and export variants; GraphQL schema-exposure, development-interface and depth/complexity/batch-bound checks restated as a handful of bounded requests, routing field-authorization and resolver-injection questions to the skills that already own them. **Excluded:** GraphQL introspection tooling and client-bundle scraping tutorials; Denial-of-service query construction and resource-exhaustion walkthroughs.

### W14 — 5 Reporting

**Adapted:** Risk-rating scale and reporting-structure guidance restated as a fixed five-level criteria document bound to existing verdict and review-status gates, never substituting for them. **Excluded:** Report templates, version-control tables, executive-summary boilerplate, and CVSS mapping guidance.
