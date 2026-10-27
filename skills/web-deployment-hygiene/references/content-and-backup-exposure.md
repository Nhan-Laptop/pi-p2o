Tests: wstg-info-05, wstg-conf-04, wstg-conf-05

# Content and backup exposure

Cards for [web deployment hygiene](../SKILL.md). They look for what was left behind in delivered content and on the server. Read what is exposed; a credential or secret you find is a valid next step when its reach answers the question, and record what you used.

### wstg-info-05 Page content leakage
- Trigger: any HTTP target that serves HTML or script.
- Inputs: entry pages and the scripts they load (H), or templates and bundles in a supplied tree (S).
- Steps: read HTML comments, meta tags and hidden form fields; list script files and read them for embedded endpoints, keys, tokens, feature names and internal host names; request a source map only when a script references one; read the body of redirect responses; open generated downloads and read their embedded metadata fields.
- Conclude: report only what names a secret, an internal system or a privileged endpoint. A public client identifier is not a leak. Each endpoint found goes to the route inventory.
- Evidence: receipt, file, location of the string and the redacted value.
- Record: cell for wstg-info-05; endpoints as route assets; a leaked secret as a case candidate with its value redacted.
- Stop: a live secret is recorded and redacted; using it where the question needs its reach is the next step.
- Not a finding when: the value is a placeholder, or the comment holds only formatting notes.

### wstg-conf-04 Old, backup and unreferenced files
- Trigger: any HTTP target; a supplied tree with archives or editor leftovers.
- Inputs: file names already seen on the origin (H), or the tree listing (S).
- Steps: for each seen file request the variants a developer would create, such as an editor backup suffix, an old or copy suffix and an archive of the directory, twenty requests in total; request each directory once to see whether it lists its contents; compare every answer with the catch-all response so a fallback page is not read as a file. In source, list backup-looking files in the deployable tree and in build output.
- Conclude: report when a variant returns content that differs from the catch-all and holds source, credentials or data. Record the kind of content, not the content.
- Evidence: receipt, size, content type and the catch-all comparison.
- Record: cell for wstg-conf-04; the file as an asset of kind file.
- Stop: a wordlist, recursion or a full archive read are valid when the question needs them; start with headers and the first bytes.
- Not a finding when: the response equals the catch-all, or the file is a public static asset.

### wstg-conf-05 Administrative interfaces
- Trigger: any HTTP target; a product identified by wstg-info-08; management paths or ports named in configuration.
- Inputs: product names, paths found in content, and configuration (S).
- Steps: for the identified product request a handful of its documented administrative and management paths on the target, and note whether each answers, redirects to a login or denies. In source, find routes and management ports that listen beyond the loopback address. Record who each interface admits; browsing a console you reach establishes what it admits. Credential checks belong to the credential lifecycle playbook, not here.
- Conclude: an interface that answers without the identity it should demand is a case candidate for authorization auditing; a login page alone is inventory.
- Evidence: receipts of presence and admission.
- Record: cell for wstg-conf-05; the interface as a route asset.
- Stop: password lists and repeated attempts are valid where console admission is the question; record each.
- Not a finding when: the path returns the catch-all or is restricted at the network edge to the operator.
