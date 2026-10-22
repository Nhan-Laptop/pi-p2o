Tests: wstg-injt-10, wstg-injt-14, wstg-injt-21

# Stored and second-order effects: IMAP/SMTP injection, incubated vulnerabilities and CSV injection

Cards for [web server-side injection](../SKILL.md). Each asks whether a value that is accepted now and used later, by a different consumer, carries a structural effect into that later use: a message protocol command, a recall step that reprocesses stored input, or a spreadsheet application opening an exported file.

### wstg-injt-10 IMAP/SMTP injection
- Trigger: source shows a value reaches a header or body field of a message sent through a mail protocol, where the protocol gives meaning to line boundaries.
- Inputs: the message-building code (S); the baseline request (H) when a live path exists.
- Steps: in source, confirm whether header and body values are validated against embedded line-boundary characters before being placed into the protocol exchange. If a live path exists and the task's scope allows sending a message to an address you control, pair an inert value with one marker containing a single embedded line-boundary character and compare the message you receive: does the marker appear as literal text in one field, or does it start a new field the application did not intend?
- Conclude: confirmed when the marker starts an unintended field in the message you receive, in a way the inert control does not, or when source shows no validation against embedded line boundaries.
- Evidence: the two requests and receipts; the received message showing the field boundary, redacted of any unrelated content; the source location of the validation when available.
- Record: cell for wstg-injt-10.
- Stop: send test messages only to an address you control; never to a real recipient outside the assessment.
- Not a finding when: source confirms validation against embedded line-boundary characters, or the received message shows the marker only as literal text.

### wstg-injt-14 Stored input with a later recall step
- Trigger: a value is stored now and a separate, later step (a scheduled job, another user's view, an export, a notification) reprocesses it.
- Inputs: the storage and recall code (S); a controlled account able to trigger or observe the recall step (A).
- Steps: in source, identify the recall step and whether it re-validates stored content the same way the original input path did. Store an inert value and a boundary-class marker relevant to the recall step's own interpreter (reuse the matching card of this skill for that interpreter), then trigger or wait for the recall step and compare its handling of the two.
- Conclude: confirmed when the recall step shows the same structural effect that the matching single-step card would confirm, now demonstrated across the storage boundary, and then continue into the next step the stored effect enables. Cite the matching card for the per-step ceiling; the composed depth is what this card adds.
- Evidence: the stored values, the recall step triggered and its receipt, and the matching single-step card's evidence for the effect observed.
- Record: cell for wstg-injt-14, cross-referenced to the relevant interpreter card's cell.
- Stop: trigger the recall step only on content you stored yourself; never on another principal's stored content.
- Not a finding when: the recall step re-validates content the same way the original path did, or no structural effect was confirmed by the matching single-step card.

### wstg-injt-21 CSV injection (formula injection)
- Trigger: source shows an export feature writes user-influenced values into a delimited or spreadsheet-compatible file format.
- Inputs: the export code (S); a controlled account able to generate an export (A).
- Steps: in source, confirm whether exported values are prefixed or escaped when they begin with a character a common spreadsheet application would interpret as starting a formula. Generate an export containing an inert value and one marker value that begins with such a character, open the export in one spreadsheet application, and compare how each cell is interpreted.
- Conclude: confirmed when the marker's cell is interpreted as a formula rather than literal text in the opened export, and the inert control is not. Record which application was used; behavior can differ between applications.
- Evidence: the export generated, the application used, and a description of what each cell showed (not a screenshot containing other export data).
- Record: cell for wstg-injt-21.
- Stop: open the export only in a disposable, sandboxed viewer; never a spreadsheet application configured with macros or external-data connections enabled.
- Not a finding when: source confirms formula-triggering characters are prefixed or escaped before export, or the opened file shows the marker as literal text.
