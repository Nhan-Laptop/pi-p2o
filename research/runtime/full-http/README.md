# Full HTTP/network transport acceptance

Baseline: `0d9900c31e1789d02d753b5bfcc4854de77e1d16`.

The operator explicitly selected full HTTP/body/auth/session support, raw network/tool downloads, any address class and one run-level approval. Assessment HTTP scope remains the exact confirmed origin. This decision supersedes the old GET/HEAD/public-IPv4-only transport; historical planning/study/acceptance artifacts are not rewritten.

Implemented: arbitrary valid HTTP method tokens, bounded UTF-8 bodies via stdin, validated custom/auth headers, per-hop origin checks, no implicit write retries, actor-local named cookie sessions, private/internal/IPv6 address acceptance, host-gateway alias, networked scratch and the labelled `p2o_net` tool. Cancelling a networked command removes the shared executor and background processes. Read-only source, unprivileged execution, no raw-packet capabilities/host Docker, budgets, deadlines, report/state integrity and cleanup remain.

**Important boundary:** scoped HTTP enforces URL origin; arbitrary shell/network commands have unrestricted bridge egress, not an origin firewall. Human confirmation and prompts state this plainly. Assessment traffic remains limited by agent policy to the confirmed target; repositories are auxiliary egress. Use external network confinement/disposable infrastructure when stronger boundaries are needed. Supplied credentials may reach the configured model/Pi transcript and local Docker inspection; redaction is best effort, not a secrecy guarantee.

Source checks: typecheck/build/import pass; **147 Vitest passes, seven opt-in skips**; **143 Python tests ran successfully, one skipped**. A stale workflow-prerequisite wording check was corrected and the complete Python suite rerun successfully. Docker/inert native suite: **six passes**, including real POST bytes, cookies, in-scope redirect hops, a denied alternate origin, host-published fixture egress, brokered shared scratch and cleanup. Visible real Herdr/inert provider: **one pass**. Session/framing tests cover informational responses, body-header spoofing, actor/principal separation, explicit-cookie overrides, Path/Secure/expiry/deletion, reset/disabled sessions, bounded storage and malformed requests rejected before spend.

Only controlled local fixtures and scripted providers were used. No external assessment, live model agent, paid benchmark, automatic provider fallback or actual third-party tool download was run. Package installation updates this extension, not target tooling. These receipts establish tested transport mechanics, not vulnerability-finding quality, browser-equivalent cookie semantics, injection immunity, complete raw response retention or immunity to container escapes. Installed results/hashes are recorded in `acceptance.json` after release verification.

Full interface and limitations: [HTTP transport](../../../docs/HTTP_TRANSPORT.md).
