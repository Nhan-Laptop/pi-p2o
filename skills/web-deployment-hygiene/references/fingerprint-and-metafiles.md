Tests: wstg-info-02, wstg-info-03, wstg-info-08

# Fingerprint and metafiles

Cards for [web deployment hygiene](../SKILL.md). They record what the deployment says about itself and send no attack payload. Every identity string is a lead, because a proxy or an operator can change it.

### wstg-info-02 Web server identity
- Trigger: any confirmed origin; run first, because later cards use the answer.
- Inputs: the baseline response set (H), or the server and proxy configuration (S). No identity needed.
- Steps: read the Server header and its relatives on each baseline response; compare the stock 404 with the error from one malformed request line; note which layer answers each. In source, read the setting that controls the signature string.
- Conclude: report product and version as an observation with its receipt. It becomes a finding only when it names an exact outdated release that the operator chose not to publish; otherwise it is context for the next task.
- Evidence: receipts of the compared responses and the strings seen.
- Record: cell for wstg-info-02 on the origin asset; product and version as an observed fact with low or medium confidence.
- Stop: the baseline plus one malformed request; no scanner profile.
- Not a finding when: the string is a CDN or generic value, was edited, or names a product without a version.

### wstg-info-03 Metafiles
- Trigger: any confirmed origin.
- Inputs: the origin (H), or the document root of a supplied tree (S).
- Steps: request robots.txt, the sitemap it names, security.txt at the root and under the well-known path, and humans.txt; read META tags on the landing page. List Disallow entries and sitemap locations as candidate paths without requesting them yet. In source, compare the files shipped with what the server exposes.
- Conclude: a metafile is a finding only if it names paths or details that expose something sensitive, such as an administrative path, a backup or an internal host. Candidate paths go to the inventory as spec-only lines.
- Evidence: one receipt per file; the candidate list with the file each path came from.
- Record: cell for wstg-info-03; candidate paths as assets, unverified until requested.
- Stop: the four fixed files plus sitemaps they name; never contact another origin.
- Not a finding when: the file is empty, is the catch-all page, or lists only public paths.

### wstg-info-08 Framework identity
- Trigger: any confirmed origin; use after wstg-info-02.
- Inputs: baseline responses and the landing page (H), or dependency manifests and templates (S).
- Steps: collect hints from headers such as X-Powered-By, framework-specific cookie names, generator comments, asset paths, file extensions and the stock error page. In source, read the manifest and lock file for names and exact versions.
- Conclude: agree at least two independent hints before naming a framework; take the version from source or an unedited asset, never from a guess. A named framework selects which later skills apply.
- Evidence: the hints with their receipts, and which of them agree.
- Record: cell for wstg-info-08; framework and version as an observed fact (from source: a contract fact).
- Stop: no probing for framework files by wordlist; every file you request must come from a hint.
- Not a finding when: the hint comes from a template copied between projects or from a CDN asset.
