---
name: web-output-context
description: Map untrusted sources to output sinks and their exact encoding contexts, and distinguish safe reflection from demonstrated execution using harmless local markers. Use for output-encoding and script-context review.
---

# Web Output Context

Before first use: [scope baseline](../../README.md#start-here), [handoff method](../../HANDOFFS.md#focused-method-and-review), and [owner review](../../HANDOFFS.md#provisional-owner-review).

## Applicability
Use when user-influenced data reaches a browser, document, template, or script sink and the unresolved question is whether the exact output context is encoded for that parser. Source review covers template rendering, serializers, client-side sink calls, URL construction, DOM updates, and document generators. Offline reproduction covers templates, renderers, and sanitizers that can run against a local fixture. Real browser execution proof is available through the sandbox image's Chromium and `agent-browser` CLI ([browser transport](../../docs/HTTP_TRANSPORT.md#browser-transport)), and a browser-side effect observed there is `live_reproduction`. A reflected string is a candidate context observation; a browser observation promotes it to demonstrated execution.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot. Trace each source through every transformation to the sink and name the context at the sink.
- `offline-reproduction` requires bounded offline sandbox execution, with the renderer and its required dependencies functionally checked through a bounded offline run. Render a local fixture with the extracted template or sanitizer configuration.
- `browser-execution-proof` is executable in this run through the image's Chromium and `agent-browser` ([browser transport](../../docs/HTTP_TRANSPORT.md#browser-transport)). A browser-side effect observed there is `live_reproduction`; a local render or simulated consumer is `offline_reproduction`, never presented as live.
- A sanitizer name or framework default is not a control until the actual call, arguments, configuration, and context are confirmed.

## Baseline
For one source, record the complete chain: where the value enters, every decode or encode step, the sink, and the exact output context such as HTML text, a quoted attribute, a URL, a script string, a style rule, or a document format. Render the value through the real path where a local runtime exists and capture the produced bytes. The baseline uses an inert text marker that carries no executable meaning, so any observation about execution can be attributed to the sink rather than to the marker itself.

## Bounded Comparison
Change one variable per render: the context selected by the sink, the encoding step on the path, the sanitizer configuration, or the transform order. Use a matched inert control string that would stay clearly inert even if it were misinterpreted, so that comparing two encodings does not introduce a live payload. Reflection in the response body is compared byte-for-byte with the sink context that produced it. Only a controlled runtime observation that the marker was interpreted as code moves the finding beyond a candidate.

## Controls
- Positive control: a sink in a local fixture that is known to treat its input as markup must show the observable difference when the encoding step is removed. This proves the harness can detect the class before the real target is assessed.
- Negative control: correctly encoded output must keep the marker as inert text in the same context. A difference here means the fixture or the encoding assumption is wrong.
- Sanitizer control: where a sanitizer is used, verify the exact version and configuration actually loaded and exercised on the tested path; a strict configuration is not evidence about a permissive one.
- Execution control: no execution claim without an observation from a real browser or an equivalent controlled runtime oracle that ran the produced document.

## Expected Observations
A chain record per source with the transformation steps, the sink, the context, the rendered bytes hash, and the observation stage. Reflection with correct context encoding is reported as a verified non-issue for that path. Reflection into a context that was not encoded as expected is an open candidate with a named missing control. Execution is reported only when the controlled oracle observed the marker being interpreted, and the observation receipt identifies the browser or runtime, the document, and the environment.

## False-Positive Checks
- Correctly encoded output in the exact context, even when the original characters remain visible in a different form.
- Reflection in a JSON or plain-text response that no tested consumer parses as markup.
- A sink that accepts the value but is inert in that context, such as a text-only property or a non-executing comment position.
- An autoescaping template engine or serializer that is actually active on the tested path.
- A policy that blocks the relevant source, such as a nonce-based restriction or a strict sanitizer, verified from the delivered document rather than from configuration alone.
- The marker appearing only in a diagnostic or local build path that is not reachable in the deployed configuration.

## Stop Conditions
- Use the credential, session or personal data the sink question needs alongside the inert marker; the marker and the live effect are one chain, and each is recorded with its receipt.
- Continue from the confirmed sink context into the composed execution chain in [web injection to execution](../web-injection-to-exec/SKILL.md), which climbs the exec ladder against the target.
- A simulated consumer is not execution proof: drive the image's browser and record `live_reproduction` from it.
- When the chain cannot name the sink context, that is an open proof gap, not a clean result.

## Evidence Fields
- Source identity and entry point.
- Transformation chain with decode and encode steps in order.
- Sink identity, file location, and output context.
- Rendered artifact hash and the local fixture identity.
- Observation stage: static trace, offline reproduction (including a local renderer), or live reproduction through the sandbox image's browser.
- Named control or the explicit absence of one.
- Limitations and the exact reason any execution step was not reached.

## Gaps
Real browser execution proof is reachable through the sandbox image's Chromium, and client-side rendering after hydration and alternate render paths are exercised the same way. What stays untested is a render path no session reached, a document or email consumer the run did not drive, and sanitizer behavior under configurations not exercised. DOM sources that depend on runtime state and dynamically constructed sinks stay open candidates until a session drives them.

## Handoffs
Provide the chain records, context classification, rendered artifacts, controls, and execution gaps. Next: [data flow analysis](../data-flow-analysis/SKILL.md) for unresolved influence, [parser differential auditing](../parser-differential-auditing/SKILL.md) when two consumers parse the same bytes differently, or [remediation](../remediation/SKILL.md) for context-specific encoding repair.

Source-to-sink and context detail lives in the [source and sink context map](references/source-sink-context.md). Cross-cutting claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook adapts the reviewed output-context method; see [skill provenance](../../research/SKILL_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
