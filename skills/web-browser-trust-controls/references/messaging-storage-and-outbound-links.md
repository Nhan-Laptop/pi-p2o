Tests: wstg-clnt-11, wstg-clnt-12, wstg-clnt-14

# Messaging, storage and outbound links

Cards for [web browser trust controls](../SKILL.md). All three read client-side source and static page markup for a declared or missing boundary, without needing a live browser to render anything.

### wstg-clnt-11 Cross-document message handling
- Trigger: source shows the page listens for cross-document messages.
- Inputs: the listener source (S).
- Steps: read the listener and check two things: whether it validates the message's declared origin against an exact expected value (not a wildcard, a substring check, or no check at all) before acting on the message, and whether the message's content is treated as untrusted data through the same validation any other external input would get, rather than being trusted because it arrived through this channel.
- Conclude: confirmed as a structural finding when the listener acts on a message without an exact-origin check, or treats the message content as already trusted. Cite the source location.
- Evidence: the listener's source location and the two checks read from it.
- Record: cell for wstg-clnt-11 with proof level `static_trace`.
- Stop: source reading only; this card does not send cross-document messages to a live page.
- Not a finding when: the listener checks the origin exactly and validates the content like any other external input.

### wstg-clnt-12 Browser-held storage content
- Trigger: source shows the page writes to a browser-side storage mechanism (not a cookie, which the session cards cover).
- Inputs: the storage-writing source (S); a static read of what the application's own code writes, when a local render is available (offline only).
- Steps: read what the application writes into the storage mechanism and whether any of it is a credential, a long-lived authentication token, or other data the application elsewhere treats as sensitive. Separately, check whether any value later read back out of that storage is used in a sink without the validation an equivalent externally-supplied value would get.
- Conclude: confirmed as a structural finding when a value the application treats as sensitive elsewhere is written into this storage, or when a value read back from it reaches a sink without validation. Cite the source locations for both the write and, if applicable, the unvalidated read.
- Evidence: the source locations of the write and any unvalidated read.
- Record: cell for wstg-clnt-12 with proof level `static_trace` or `offline_reproduction`.
- Stop: source and local render reading only; never read another user's actual browser storage.
- Not a finding when: nothing sensitive is written, and values read back are validated like external input before use.

### wstg-clnt-14 New-tab link isolation
- Trigger: static markup or source shows a link or dynamically created navigation opens in a new browsing context, to a destination not fully controlled by the application itself.
- Inputs: the markup or the source that constructs the link (S).
- Steps: for each such link, read whether the isolation attribute that prevents the new context from gaining a reference back to the opening page is present, and whether it is present consistently across every place such a link is constructed, including ones built dynamically rather than written directly in markup.
- Conclude: confirmed as a structural finding when a link to a not-fully-controlled destination lacks the isolation attribute, cited to its source or markup location.
- Evidence: the location of each such link and whether the attribute is present.
- Record: cell for wstg-clnt-14 with proof level `static_trace`.
- Stop: source and markup reading only.
- Not a finding when: the isolation attribute is present on every such link, or every destination is fully controlled by the application itself.
