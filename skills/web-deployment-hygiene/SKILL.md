---
name: web-deployment-hygiene
description: Verify what a deployment volunteers and the policy it declares, including banners, metafiles, leaked page content, backup and admin paths, platform configuration, response headers, methods, cache and TLS settings, and error output. Use first, with few benign requests or a supplied configuration tree. Covers WSTG INFO, CONF, ERRH and CRYP-01/03.
---

# Web Deployment Hygiene

Before first use, read the [scope baseline](../../README.md#start-here) and [handoff contracts](../../HANDOFFS.md).

## Applicability
Use when an approved assessment needs to know what a deployment tells any client without being attacked: server and framework identity, metadata files, page content and script bundles, backup and administrative paths, platform configuration, response headers, cookie and cache directives, HTTP methods, TLS posture and error output. It is the low-impact first pass over the confirmed origin and the natural review of a supplied configuration tree. It does not test application logic, authorization or injection. A weakness here is a gap in declared policy or an unintended disclosure, and its weight depends on exposure: a missing control matters when something sensitive depends on it, not by itself.

## Test Cards
- [Fingerprint and metafiles](references/fingerprint-and-metafiles.md): wstg-info-02, wstg-info-03, wstg-info-08.
- [Content and backup exposure](references/content-and-backup-exposure.md): wstg-info-05, wstg-conf-04, wstg-conf-05.
- [Platform configuration and flags](references/platform-config-and-flags.md): wstg-conf-02, wstg-conf-09, wstg-conf-15.
- [Headers, methods and cache](references/response-headers-methods-cache.md): wstg-conf-06, wstg-conf-07, wstg-conf-14, wstg-athn-06.
- [Transport security](references/transport-security.md): wstg-cryp-01, wstg-cryp-03.
- [Error disclosure](references/error-disclosure.md): wstg-errh-01.

## Workflow Prerequisites
- `source-review` requires a supplied read-only source snapshot with configuration, descriptors, templates or client bundles. It shows what would be declared, not what is deployed.
- `offline-reproduction` requires bounded execution in your own sandbox scratch. Run the supplied configuration or bundle locally and read the headers, files and errors it produces, after a real probe confirms the runtime.
- `public-http-review` requires authorized same-origin requests through the scoped HTTP client on the confirmed origin: anonymous retrieval of representative responses, no payloads.
- `sandbox-network-review` requires a bounded TCP or TLS exchange with the confirmed host and port through the sandbox network tool. Opaque commands are not origin-filtered, so address only the confirmed target and port.
- A missing prerequisite creates a gap for that workflow only, not a reason to request broader access.

## Baseline
Fix a small response set before reading anything into one response: the landing page, a login or entry page, a static asset, an API route if one exists, an unregistered path, and a real path requested with a method it does not serve. Record status, headers, cookie attributes, body length and redirects. Every card compares against this set. State each expected control with its provenance: an application contract, or a boundary invariant that holds for any application, such as a session cookie that must not travel in clear text. A stricter-looking sibling route is a lead only.

## Bounded Comparison
Change one thing at a time: one route class, header, method, protocol version or malformed request. Name guesses for backup and metafiles come only from files already seen, at most twenty, never from a wordlist. List methods through the Allow header; exercise a write method only on a path the scope designates as disposable. Contact nothing outside the confirmed origin, including hosts that a file or script names.

## Controls
- Positive control: the expected header or setting observed on a comparable route proves the harness can see it. Absence counts only where a comparable route shows presence or the source declares it.
- Negative control: an unregistered path and one deliberately malformed request show the default error shape before any route-specific error is read.
- Source control: where a configuration and a live origin both exist, compare them. A difference points at the deployment path, such as a proxy or build step, and is not yet a finding.

## Expected Observations
A response table per route class (status, security-relevant headers, cookie attributes, caching, allowed methods, disclosed product and version strings, error shape); unreferenced or backup candidates with receipts; for source review, the file and key that set each control; for transport, accepted protocol versions, certificate validity and chain, and what the plain-HTTP port does. Absent controls are reported with their exposure context, never as automatic defects.

## False-Positive Checks
- Headers or banners added by a CDN, load balancer or web application firewall that the origin never emits.
- A staging or maintenance host whose configuration differs from production.
- A control that matters for HTML pages but is judged on a JSON or static response.
- A banner that was edited or removed, so product and version are not evidence.
- A guessed file name answered by the catch-all page instead of a real file.
- Intentionally public documentation or sample pages, and verbose errors served only to local or authenticated clients.

## Stop Conditions
- Stop once every route class in the baseline has a receipt or an unverified marker; do not enlarge the set to look thorough.
- Stop before any credential guess, wordlist, directory brute force, state-changing request, or scanner whose default profile does those things.
- Stop before checks that degrade availability: slow connections, oversized bodies, repeated renegotiation.
- Stop at the first confirmed secret: record where it appears, redact it in notes and read no further.

## Evidence Fields
- Origin or snapshot identity, the route class and the receipt: status, selected headers, cookie attributes, body length, truncation.
- Expected control with its provenance: contract, boundary invariant, or inferred.
- For source review, the file path and key of the declaring setting.
- Product and version strings disclosed and where each appears.
- Transport facts: accepted protocol versions, certificate names and validity, key and signature algorithms.
- Coverage state and the reason for any route class not tested.

## Gaps
Anything behind authentication, content rendered only by a browser, intermediary behavior that varies by region, and state-changing methods stay untested. A header's effect inside a browser is unverified without a browser oracle, and transport checks stop at what the sandbox tools can read. A clean result covers only the route classes and the moment of the baseline.

## Handoffs
Provide the response table, exposure candidates with receipts and untested route classes. Choose role/method from the unanswered question; record expected evidence and a branch stop condition. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web route and input inventory](../web-route-input-inventory/SKILL.md) for routes first seen here, [authorization auditing](../authorization-auditing/SKILL.md) when an administrative path answers without the expected identity, or [remediation](../remediation/SKILL.md) for configuration fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the information-gathering, configuration and transport guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
