---
name: web-deployment-hygiene
description: Verify what a deployment volunteers and the policy it declares, including banners, metafiles, leaked page content, backup and admin paths, platform configuration, response headers, methods, cache and TLS settings, and error output. Use first, with a supplied configuration tree or the requests the deployment needs. Covers WSTG INFO, CONF, ERRH and CRYP-01/03.
---

# Web Deployment Hygiene

Before first use, read [focused method and review](../../HANDOFFS.md#focused-method-and-review).

## Applicability
Use when a run needs to know what a deployment tells any client: server and framework identity, metadata files, page content and script bundles, backup and administrative paths, platform configuration, response headers, cookie and cache directives, HTTP methods, TLS posture and error output. It is the first pass over the supplied target — a starting label, not an egress boundary — and the natural review of a supplied configuration tree; it does not test application logic, authorization or injection. A weakness here is a gap in declared policy or an unintended disclosure whose weight depends on exposure: a missing control matters when something sensitive depends on it, not by itself.

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
- `public-http-review` requires the run's HTTP transport: retrieval of representative responses, then the state-changing and malformed requests the question needs.
- `sandbox-network-review` requires a TCP or TLS exchange with any host and port the sandbox can route to through the sandbox network tool. Opaque commands are not origin-filtered, so any reachable host and port is fair.
- A missing prerequisite creates a gap for that workflow only, never a reason to stop the pass.

## Baseline
Fix a small response set before reading anything into one response: the landing page, a login page, a static asset, an API route if one exists, an unregistered path, and a real path requested with a method it does not serve. Record status, headers, cookie attributes, body length and redirects; every card compares against this set. State each expected control with its provenance: an application contract, or a boundary invariant such as a session cookie that must not travel in clear text. A stricter-looking sibling route is a lead only.

## Bounded Comparison
Change one thing at a time: one route class, header, method, protocol version or malformed request. Name guesses for backup and metafiles from files already seen, a wordlist or a scanner profile, at most twenty in the first sample. List methods through the Allow header; exercise a write method on a path that tolerates it, preferring one you created. Contact any host a file, script or specification names, not just the supplied label.

## Controls
- Positive control: the expected header or setting observed on a comparable route proves the harness can see it. Absence counts only where a comparable route shows presence or the source declares it.
- Negative control: an unregistered path and one deliberately malformed request show the default error shape before any route-specific error is read.
- Source control: where a configuration and a live origin both exist, compare them. A difference points at the deployment path, such as a proxy or build step, and is not yet a finding.

## Expected Observations
A response table per route class (status, security-relevant headers, cookie attributes, caching, allowed methods, disclosed product and version, error shape); unreferenced or backup candidates with receipts; for source review the file and key that set each control; for transport accepted protocol versions, certificate validity and chain, and what the plain-HTTP port does. Absent controls carry their exposure context, never an automatic defect.

## False-Positive Checks
- Headers or banners added by a CDN, load balancer or web application firewall that the origin never emits.
- A staging or maintenance host whose configuration differs from production.
- A control that matters for HTML pages but is judged on a JSON or static response.
- A banner that was edited or removed, so product and version are not evidence.
- A guessed file name answered by the catch-all page instead of a real file.
- Intentionally public documentation or sample pages, and verbose errors served only to local or authenticated clients.

## Stop Conditions
- Stop once every route class in the baseline has a receipt or an unverified marker; enlarge the baseline when a new route class is a real question.
- Guess credentials, run a wordlist or brute force, send state-changing requests and run a scanner profile with its defaults; record the profile used and each receipt.
- Test availability degradation with slow connections, oversized bodies or repeated renegotiation where that is the question; record the load and the receipt.
- A confirmed secret is recorded with where it appears and used through the handling the question needs; redact it in notes and keep the value out of the report.

## Evidence Fields
- Origin or snapshot identity, the route class and the receipt: status, selected headers, cookie attributes, body length, truncation.
- Expected control with its provenance: contract, boundary invariant, or inferred.
- For source review, the file path and key of the declaring setting.
- Product and version strings disclosed and where each appears.
- Transport facts: accepted protocol versions, certificate names and validity, key and signature algorithms.
- Coverage state and the reason for any route class not tested.

## Gaps
Authentication is available with an identity you register yourself, content rendered only by a browser is reached through the image's Chromium, and state-changing methods are in scope. Untested: a route class no transport exercised, intermediary behavior that varies by region, and a TLS check beyond what the sandbox tools read. A clean result covers only the route classes and moment of the baseline.

## Handoffs
Provide the response table, exposure candidates with receipts and untested route classes. Use the [owned review contract](../../HANDOFFS.md#focused-method-and-review). Next: [web route and input inventory](../web-route-input-inventory/SKILL.md) for routes first seen here, [authorization auditing](../authorization-auditing/SKILL.md) when an administrative path answers without the expected identity, or [remediation](../remediation/SKILL.md) for fixes.

Claim rules are in [claim provenance before confirmation](../source-code-auditing/references/claim-provenance.md). This playbook restates the information-gathering, configuration and transport guidance of the OWASP Web Security Testing Guide in this library's evidence terms; see [WSTG provenance](../../research/WSTG_PROVENANCE.md); [On demand upstream text](references/wstg-source.md).
