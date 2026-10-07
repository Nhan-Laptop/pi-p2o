# Source and sink context map

Detailed mapping guidance for [web output context](../SKILL.md). The product of this method is a chain record, not a payload.

## Classify the source

Name where the value enters and what the producer guarantees. Request parameters, headers, cookies, path segments, stored records written by another feature, imported files, and channel messages are all sources with different trust and freshness. Record whether the value is decoded, normalized, truncated, or concatenated before it reaches the sink. A value that passes through a serialization boundary is a new representation; compare the bytes on both sides rather than assuming the representation survived.

## Classify the sink and its context

At the sink, name the parser that will consume the bytes and the exact position they occupy: HTML text, a quoted attribute, an unquoted attribute, a URL component, a script string, a style declaration, a document metadata field, or a client-side DOM property. Context decides which characters are dangerous and which encoding is correct. Two sinks that look similar in source may feed different parsers, and one value may reach several sinks through different paths; each path gets its own chain record.

## Trace the transformations

List every encode, decode, escape, sanitize, or template step in order. Mark which steps are applied by the framework automatically and which by application code, and confirm the effective configuration on the tested path. The dangerous arrangements are a missing step, a step applied in the wrong context, a decode after an encode, and a sanitizer whose result is later re-interpreted by a different parser. When a step cannot be confirmed from source, the chain is incomplete and the candidate stays open.

## Reflection versus execution

Reflection is an observation about the response bytes. Compare the reflected bytes with the exact context: correctly encoded output is a verified non-issue for that path; incorrectly encoded output is a candidate with a named missing control. Execution requires a controlled runtime oracle that produced the document and observed the marker being interpreted as code. A simulated consumer, a parser library call, or an automated report is not a browser oracle and cannot supply that observation.

## Inert markers

Choose a marker that has no executable meaning in any plausible context and is unique enough to locate in the rendered bytes. Record the marker in the ledger so the same fixture can be re-rendered after a configuration change. Never use a marker that collects credentials, contacts a remote origin, persists state, or changes the document in a way that outlives the check.

## Handoff readiness

A chain record is ready for another owner when it names the source, every transformation, the sink and context, the rendered artifact hash, the observation stage, the named control or its absence, and the precise reason any execution step was not reached. If the sink context is unknown, hand off the open mapping question rather than a conclusion.

Adapted from the reviewed output-context method, excluding payload catalogs, bypass recipes, credential or session collection, persistence, phishing, and post-exploitation guidance. See [skill provenance](../../../research/SKILL_PROVENANCE.md).
