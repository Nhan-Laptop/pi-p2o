# P17 proposal — exploitation capability: the prompt and skill pass

Status: **proposal, nothing here is implemented.** This file replaces the retired archive pointer. The previous 2,326-line
design record (Parts I–XI) is still in git at `f5015fd` and its milestones are summarised in
[docs/HISTORY.md](docs/HISTORY.md); it is not the current specification and this proposal does not revive it.

Owner request (2026-10-27): *"enhance the capabilities of exploit of model — prompt (provide for agent), skills as powerful
as possible to exploit; research ARTEX and the internet; find what in the current prompt/skills restricts the agent from
getting high/critical bugs (RCE, LPE, …); rewrite planning_update.md."* This document is that research plus the resulting
plan. The working tree already carries the 2026-10-27 dedupe/tool-merge pass; this proposal builds on it and changes
nothing in it.

Scope: **prompt and skill text first, the small engine seams those texts depend on second, measurement third.** It adds
no permission, target tool, role, budget or finish gate. Two engine seams are proposed where the text would otherwise
promise something the instrument cannot do: an interactive foothold (§5 D40) and a runtime-truth guard (§5 D41).

---

## 1. What this revision answers

### 1.1 The substrate is no longer the binding constraint

The earlier access-ladder revision (P7) found six binding constraints: no session, no interactive execution, no identity
channel, no ingress, a chain tax, and semantics that suppressed depth. All six were then implemented: the `session`
executor and `p2o_session`, PTY `send`/`read`, `--identity` with host-injected secrets, `--callback` / `--lab-network`
ingress, chain-in-session successors, the `boundary_invariant` policy basis, the installed browser, and the 2026-10-27
tool-surface cleanup. A measured probe of the pinned image (§2.4) confirms the sandbox itself is a full Kali-class root
container with gcc, gdb/ptrace, nmap, nuclei, ffuf, sqlmap, Python/Node, egress, package installs and Chromium.

A run can therefore hold a foothold, keep a shell, act as a provisioned principal and drive a browser without asking for
consent. What a run still rarely does is **exploit**.

### 1.2 The only measured campaign is an assessment, not an exploitation

The P5.1 measured run (`run-615f7a9a`, 69.8 min, $1.57):

| Measurement | Value |
| --- | --- |
| Tasks | 20 created/dispatched: 3 recon, 12 discovery, 5 validation |
| Tasks with `purpose=exploitation` or `chaining` | **0** |
| Goals whose proof was a typed capability | **0** |
| Worker target operations | 217, all exit 0 |
| Accepted cases | 1 (Low: zone-wide cookie name collision) |
| The run's own recorded exclusions | "read-only risk limit", "operator credential required", "exploitation outside an HTTP evidence contract" |

The "read-only risk limit" existed nowhere in the code even then; it was the model's own risk appetite written into an
undefined field. The substrate has improved since, but the instruction surface has not: the prompts teach a reviewer's
discipline far more explicitly than an operator's objective. The owner's question — *what in the prompt and skills caps
the ceiling?* — has a concrete answer in §3: **two hard seams, ten soft seams, six missing methods.**

### 1.3 The claim this revision makes

> The remaining gap between pi-p2o and a high/critical-finding workflow is mostly **instructional and handoff quality** —
> not permission, tooling, time or model capability — and it can be narrowed by demanding an effect, defining exhaustion,
> carrying exploit context into the worker brief, un-taxing the severity model, and giving the library a post-exploitation
> method. Measurement, not assertion, decides whether it narrowed.

This is narrower than "better prompts find more bugs". §2 separates measured evidence from mechanistic reasoning;
Appendix C lists what this proposal explicitly does not claim.

---

## 2. Research

### 2.1 ARTEX v0.3.15 (local snapshot, `my_references/ARTEX/`)

ARTEX is the closest peer: an autonomous pentest system whose prompts are explicitly exploitation-shaped. Half of its
doctrine was already ported in P5 — `src/prompts.ts:162-166` is annotated "translated from ARTEX `agent/planner.go:304-331`"
(depth over breadth, mechanism routes, chain-or-wall), and `src/finish-preflight.ts:56-74` host-enforces what ARTEX only
asks in prose (`PRIMITIVE_UNCHAINED`, `ROUTE_MONOCULTURE`, `HIGH_WITHOUT_INDEPENDENCE`, `NEGATIVE_MAY_BE_BLOCKED`,
`LEAD_UNTRIAGED`). The **worker** half is not ported.

| ARTEX mechanism | Quote (translated) | Why it raises high/critical yield | pi-p2o landing |
| --- | --- | --- | --- |
| Bypass exhaustion before "dead" | "First obstruction — a filtered payload, a 404, an injection with no echo — does not mean the path is closed. Change the encoding, the method, the parameter, the path; walk the reasonable means of this direction before judging it a dead end." `agent/worker.go:234`, `agent/promptcatalog.go:38` | A filtered payload is one sample of a family. One sample closing upload/SSTI/command-injection/deserialization is the single largest loss of RCE-class findings. | `src/prompts.ts:226` defines a wall but never exhaustion → **A17.1** |
| Independent re-trigger | "When you think you found it, switch to skeptic and trigger it again through a *different path or independent command*, not by restating the same evidence." `agent/promptcatalog.go:40` | A second transport kills reflection-as-execution and edge-cache artifacts before they become rated findings, and forces the effect to be stable enough to rate. | `src/prompts.ts:257` argues against the finding but never re-triggers → **A17.1** |
| Self-deception list | "Version/fingerprint→CVE match, 'the parameter looks injectable', external advisories or changelog/diff inference are not confirmed vulnerabilities; never use a CVE lookup or patch-version comparison in place of an actual trigger." `agent/worker.go:240` | Names the three common false positives at the moment of claiming. | host-side rule exists (`tool-guidelines.ts:28`); claim-time prose missing → **A17.1** |
| High-value surface families | "Input parsing/encoding and charset boundaries, file upload, (de)serialization, built-in routes and pre-auth reachable surface, error leakage, cache (poisoning/race), race conditions, type confusion (scalar vs array), mass assignment." `agent/promptcatalog.go:45` | Route selection wins criticals; a planner asked only for "surfaces" rediscovers IDOR and reflection while pre-auth routes, deserialization and race stay unopened. | planner heuristics name direction, not families → **A17.2** |
| Spill every adjacent lead | "If you glimpse a lead outside this intent — a path leaked by an error, a link to another asset, a suspected second exploit chain — write it into a fact and hand it to the planner. Better one extra report than swallowing it." `agent/worker.go:336` | SSRF→internal and credential→lateral pivots are noticed inside a worker context and die there if only the planner is asked to infer them. | "one intent" line at `src/prompts.ts:232` has no over-report imperative → **A17.1** |
| Trace before re-planning | "Read the worker trace to see how far it actually got; the basis is the real progress in the trace, not the state alone." `agent/planner.go:327` | An interrupted discovery is usually near a breakthrough; treating state as a verdict either duplicates or abandons a live path. | `src/prompts.ts:171` distinguishes states but not "read the position first" → **A17.2** |
| Negative observation ≠ verdict, one recheck | "A negative is a worker's observation, not a conclusion; a missing-evidence or single-probe negative counts as not-yet-explored. Recheck the same negative direction at most once." `agent/planner.go:312`, `agent/tools.go:1357` | Premature `ruled_out` removes a live surface from the denominator. | preflight catches only the 401/403/429 variant after the fact; no write-time rule → **A17.1/A17.2** |
| Retry admission test | "Re-dispatch only when a *materially new mechanism* exists — a new fact, asset, parameter or clearly different construction — and say how it differs from last time." `agent/planner.go:326` | Converts "retry" into a falsifiable statement about what changed, separating persistence from busy-spin. | `src/prompts.ts:135` bans the act without the admission test → **A17.2** |
| Explicit effect objective | The solo agent prompt is one imperative: "recon → attack surface → deep exploitation → verification → wrap-up; you are your own planner and your own auditor." `agent/promptcatalog.go:33` | The one measured prompt-wording effect in the literature (§2.2: 0.26→0.72) is exactly this: an explicit exploit instruction, not a permission. | worker prompt says "assessment"; the duty line is one line → **A17.1** |
| Report bar in prose | `agent/worker.go:240` (same list as above) | Prose is read at claim time; a host rule is read only on refusal. | **A17.1** |

**What not to copy.** ARTEX has no blanket authority: its boundary is a human approval queue plus model self-check of
prose constraints (`agent/worker.go:235`, `agent/constraints.go:38`). Its deny seeds block legitimate proof steps —
creating a high-privilege account (an LPE proof), editing service configuration (persistence validation), any
`DELETE/PUT/PATCH` on real records (`intercept/prompt.go:79-83`). Its finding schema treats evidence as optional, and its
self-check is prose, not enforcement. pi-p2o is stronger on all four and stays that way: port the *wording*, never the
ASK culture or the deny list.

### 2.2 Internet evidence (2023–2026)

Full URLs in Appendix D. Evidence strength is marked; nothing here is presented as a measured effect of *this* plan.

| Source | Finding | Number | Strength |
| --- | --- | --- | --- |
| CyberGym (2025) | Real-world PoC reproduction across 188 OSS projects; best agent+model combination reproduces | 11.9% of 1,507 vulnerabilities; 15 new zero-days found | measured, primary |
| Naptime / Big Sleep (Google Project Zero, 2024) | Harness redesign (code browser, Python, ASan debugger, auto-verification, multi-trajectory sampling) improved CyberSecEval2 | up to **20×**; buffer-overflow success 0.05→1.00 | measured, primary |
| Naptime prompt sentence (same) | One explicit exploit-intent sentence ("find a vulnerability and exploit it to make the program output …") | 0.26 → **0.72** | measured, small n — the only measured prompt-wording effect found |
| AXE (2026) | Grey-box metadata (CWE class + file:line) in the task contract vs black-box | 30% vs ~10% on CVE-Bench (3×); single-agent grey-box still 1.75× | measured |
| AutoPenBench (EMNLP 2025) | Autonomous milestone completion vs human-assisted | 21% vs 64% (33 tasks) | measured |
| XBOW HackerOne (2025–2026) | Production submissions and triage over 90 days | 1,060 submissions → 130 resolved, 303 triaged, 208 duplicates, 209 informative; 54 critical + 242 high | observed, vendor |
| XBOW Alloy (2025) | Model routing + architecture: thousands of short-lived narrow agents, persistent coordinator, deterministic validation | alloy 68.8% vs 57.5% best single; hard cap near 80 iterations because restarts beat accumulated false assumptions | observed, vendor |
| XBOW 48-step chain (2026) | Blind SSRF escalated through image parsing, VRT files, one-pixel PNG to file exfiltration | 48 autonomous steps | observed, vendor |
| DARPA AIxCC final (2025) | Engineering the cyber-reasoning system between rounds | synthetic vulns found 37%→86%, patched 25%→68%; 18 real vulns; ~$152/task | measured, primary |
| Anthropic cyber ranges (2025) | Simulated Equifax-like intrusion; 5 of 9 networks still needed a custom toolkit | Sonnet 4.5: 2/5 trials (Sonnet 3.5: 0/5) | measured, small n |
| Refusal study (Jones et al., 2026) | Frontier models on offensive web tasks | 6 of 8 near-zero refusal | measured — safety refusal is **not** the binding constraint |
| Context Rot (Chroma, 2025) | Performance degrades with input length across 18 models; distractors compound | monotone degradation | measured |
| Decoupling recon/exploitation (2026) | Separates exploit execution from recon: 70 web testbeds, 50 aligned vulns, 5 agents; accurate context vs autonomous recon | functional success up to **90.0%**; autonomous recall ≈ **50.0%**, dominated by failure to parse telemetry | measured |
| Agentic architecture study (2026) | 20 interactive targets, 600 runs, 5 architectures: detection-any 58.0%, *validated* 49.8%; independent multi-agent best 64.2%; whitebox 67.0% vs blackbox 32.7%; web 74.3% vs binary 25.3%; non-monotonic cost-quality | as listed | measured |
| Big Sleep seeded variant analysis (2024) | Patch-diff-seeded search found an exploitable SQLite stack underflow that AFL missed in 150 CPU-hours | 1 real exploitable bug | measured, one case |
| Anthropic Agent Skills (2025) | Progressive disclosure: name+description preloaded, body on demand, bundled files only when needed | design guidance | industry |

### 2.3 What the evidence says — and does not

1. **Proof, not detection, is the bottleneck.** PoC-required benchmarks score 12–20% while production systems with
   validators, restarts and grey-box context scale. pi-p2o is already proof-shaped; the lesson is not to loosen the claim
   bar but to stop letting proof-shaped discipline *prevent attempts*.
2. **Context beats autonomy.** The 90%-vs-50% decomposition, AXE's 3× and Naptime's single sentence point at the same
   seam: a worker given a precise, grey-box-shaped question performs far better than one asked to rediscover it.
   pi-p2o's brief carries prose and graph slices but no exploit contract (**A17.3**).
3. **Architecture matters as much as the model.** Short-lived narrow agents + persistent coordinator + programmatic
   validation is the best-evidenced shape; pi-p2o already matches it (fresh workers, durable plan board, host-derived
   validation). What it lacks is a *restart policy that varies the mechanism* rather than extending a stuck thread
   (**A17.2**).
4. **Exhaustion before closure is the worker-level doctrine.** ARTEX states it; benchmark failure analyses repeat it
   (misinterpreted semantics and unmet preconditions, not proof of absence); XBOW's iteration cap exists because restarts
   beat accumulated false assumptions. pi-p2o defines a wall without defining exhaustion (**A17.1**).
5. **Verification gates are not measurably costly — but attempt gates are.** No study measures the recall cost of
   verification gates in pentest agents (flagged unverified). Mechanistic reasoning plus the ARTEX comparison support one
   rule: gate the *claim*, not the *attempt*. pi-p2o currently mixes them: closure vocabulary leaked into the procedures
   and the severity cap reaches back to attempts (**A17.4**).
6. **Target class matters.** Web 74.3% vs binary 25.3% validated detection in one 600-run study. This phase targets
   web/API and target-side host escalation whose foothold runs over HTTP or a reverse shell; binary exploitation is a
   later phase.
7. **Safety wording is not the cap.** Refusals are near-zero for most frontier models on web tasks; the caps are
   structural. This proposal edits meaning and ordering, not "be less careful" wording.

### 2.4 The instrument, measured

A read-only probe of the pinned image (`ghcr.io/usestrix/strix-sandbox@sha256:f6906c…`, `src/sandbox.ts:13`) under the
exact `src/sandbox.ts:17-19` limits, 2026-10-27 (Docker 28.5.2), plus a code audit of the harness. This matters because a
prompt may only promise what the instrument does.

| Verified capability | Result | Evidence |
| --- | --- | --- |
| Compile/run exploits | gcc 15.2 yes; objdump/readelf/nm/objcopy yes; g++/make/clang/rustc, ASan, AFL++, pwntools, radare2/ghidra, metasploit, strace/socat/ssh/tcpdump installable in scratch | probe |
| Debugging | gdb 17.2; attach to a live child works (`ptrace_scope=0`, seccomp allows ptrace); strace installs and works | probe |
| Recon tooling present | nmap 7.99, nuclei 3.11, ffuf, sqlmap 1.10.6, httpx, subfinder, nc/ncat, Python 3.13 + pip, Node; Chromium 150 + agent-browser 0.26 | probe |
| Network | unrestricted egress including private/link-local/metadata and `host.docker.internal`; bind ports; reverse shell out; `nohup` services | probe |
| Container posture | uid 0, writable rootfs, `/target` read-only, `/work` writable, 14 default caps, not privileged, shared host kernel; **no** nested Docker/podman, no `unshare`, no ASLR disable | probe |
| Foothold transport | session mode gives a persistent container + PTY (16 KiB/send, ≤120 s); in-sandbox TCP listener works on an operator `--lab-network` (≤4/session, binds 0.0.0.0, **logs bytes and never answers**); no published host port; no built-in tunnel/pivot | probe + `extensions/p2o/index.ts:1436-1490`, `src/sandbox.ts:335-393` |
| Hard limits | 48 KiB visible command output (`src/process.ts:3`); 48 KiB HTTP body (`src/target.ts:284`); 48 KiB payload (`src/lab.ts:16`); 48 KiB upload (`extensions/p2o/index.ts:1408`); 64 KiB scratch write (`src/scratch.ts:143`); 32 KiB command (`src/sandbox.ts:160`); capture 8 KiB preview / ≤8 MiB read / 1 MiB stored (`src/sandbox.ts:213`, `src/roles.ts:105`); no timeout by default (`src/target.ts:279-282`), and an opt-in timeout that fires retires the sandbox (`src/sandbox.ts:171-181`) | code |
| Run limits | quiet rounds 2 (advisory, `src/engine.ts:35,212`); pause only at 3 stalls + gateable debt (`src/engine.ts:273`); no command budget (`src/broker.ts:608-612`); no finish gate (`src/finish-preflight.ts:14-28`), though queued intents refuse a final finish (`extensions/p2o/index.ts:2718`); `MAX_SKILLS` 3; no token ceiling | code |
| Target model | `directory \| url \| hybrid` only (`src/target.ts:12`). There is no first-class host/SSH target kind: a target-side shell is reached **in-band through the exploited service**, or out-of-band into the run's lab listener | code |

Two consequences the plan must respect:

- **LPE is demonstrable only through a foothold.** In-band command execution through the exploited service (the typical
  web RCE) already runs commands on the target side, so host enumeration and a privilege escalation attempt are
  expressible there. A reverse shell is the higher-throughput path and needs the operator lab network, because the
  listener does not answer today. Root observed this way is root inside the compromised workload, not proof of host-kernel
  compromise — the report must say which boundary was crossed. Container escape and kernel exploitation of the host are
  out of scope and untested.
- **Runtime truth is currently unguarded.** `tests/minimal/docker.test.ts:10-20` and
  `tests/minimal/docker-extension.test.ts:76-78` still assert `uid 65532` and `CapEff 0`, while the runtime is root with
  14 caps; nine `skipIf(P2O_TEST_DOCKER !== '1')` gates keep the default suite blind to that drift.
  `scripts/setup-sandbox-tools.sh`'s usage text still describes the container as "read-only and non-root"; those two
  statements are false against `src/sandbox.ts:14-19`. Fixing them is **A17.9**, not an optional cleanup.

---

## 3. Constraint census 2.0 — what restricts the ceiling now

Legend: **HARD** = enforced by code and will refuse; **SOFT** = prose the model obeys; **ABSENT** = mechanism or method
missing; **KEEP** = honesty/authority invariant to preserve.

### 3.1 The two hard seams

| # | Where | Current | Why it caps HIGH/CRITICAL | Proposal |
| --- | --- | --- | --- | --- |
| H1 | `src/cases.ts:219`, `docs/EVIDENCE.md:83`; pinned by `tests/minimal/case-rating.test.ts:59`, `tests/minimal/ladder.test.ts:166`, matrix row F-P3-3 | "A case resting on an inferred policy basis cannot be rated above medium" — a hard `Error` when any claim ref is `policyBasis=inferred` | The most common real HIGH, a credentialed cross-tenant/object authorization bypass, usually has no documented policy to cite, so it lands on `inferred` and is capped at Medium even when the crossing was observed and repeated. The rating ceiling becomes the run's ambition. | **A17.4 / D35**: scope the cap to cases whose effect was not observed/tested; a tested+observed crossing on inferred provenance is ratable at demonstrated depth with a visible `INFERRED_POLICY` flag and a required limitation. Rating above demonstrated depth is still refused. |
| H2 | `src/prompts.ts:20` (EVIDENCE_TAIL) | "Sibling route differences, placeholder credentials and CVE leads are hypotheses, not policy: keep them `policyBasis=inferred` and `open_proof_gap` until the contract is established" | This sentence forces the state H1 punishes. In black-box work the sibling route or second principal *is* the cheapest real evidence, and for a patch-diff lead the effect is the contract. | **A17.4**: keep the anti-rumour bar (a version match is never proof) but name the exceptions: a crossing observed with only the attacker's own credential is `boundary_invariant`; a functional effect reached through a CVE-seeded hypothesis is confirmed by the trigger, not by the advisory. |

### 3.2 The soft seams (prose that ends exploitation early)

| # | Where | Current | Why it caps yield | Proposal |
| --- | --- | --- | --- | --- |
| S1 | `src/prompts.ts:226` | "Only a tool or host that actually refuses, or an approach you exhausted, is a wall" | Defines a wall, never defines *exhausted*; the cheapest reading is "one payload failed". | **A17.1**: enumerate the bypass classes that make an approach exhausted (encoding/wrapper, method, parameter location, path/route alias, identity context, alternate sink) and say one sample is not a family. |
| S2 | `src/prompts.ts:242` | purpose=exploitation line ends "…and stop at the wall you did not cross" | Primes closure at the moment depth matters. | Delete the trailing clause; keep "take the primitive to the effect class the goal names". |
| S3 | `src/prompts.ts:253` | "take the next step only when this step's actual output is its input and your duty covers that purpose; otherwise report the link" | Turns every two-step escalation into a handoff that needs review and a new dispatch. | Reword: continue when the duty covers the effect class; report only the step outside the duty. |
| S4 | `src/prompts.ts:159-160` | "Validation runs as a separate worker… Only that closure counts as confirmed." | Reads as: an executed RCE is unconfirmed until a second worker replays it, so the planner serialises every rung behind a validation round. The host does not require this: a worker's confirmed+tested claim is accepted at review; independent validation is the `independentCurrent` rating flag (`docs/EVIDENCE.md:73-78`). | **A17.5**: state the actual rule — review confirms; independent validation earns the badge; a replay is not a precondition for the next rung. |
| S5 | `src/prompts.ts:83` | An exploitation/chaining intent needs a plan goal whose proof is "a capability or an accepted case" | An accepted case is downstream of the exploitation it gates; the sentence steers the planner to a downstream artifact. | **A17.2**: allow and teach `proof: capability` from a reviewed confirmed+tested claim, with acceptance criteria named at goal creation. |
| S6 | `src/prompts.ts:155` | "Use a worker join only for a bounded join you are about to act on in this turn" + manual mode default | After dispatch the campaign idles until a human types; depth is bounded by human attention. | **A17.2**: allow one bounded review join per round in manual mode (no polling, no budget change), or auto-wake on a committed report for review only. |
| S7 | `src/prompts.ts:257` + `src/finish-preflight.ts:65-72` | "argue the strongest case against it"; a ruled-out negative resting on 401/403/429 is flagged at finish | Argument without re-triggering; the wrong negative is caught only after the run. | **A17.1**: independent re-trigger before claiming; negative observations are observations, one recheck per direction. |
| S8 | `src/roles.ts:46-56,85-93`; every catalog workflow | Defaults are static-first (`mapping → attack-surface-mapping`, `discovery → source-code-auditing`, `validation → []`, `reporting → []`), and each skill's first workflow is `source-review` | A URL run's default method is reading, and the validation worker — the one that must reproduce an effect — gets no method at all. | **A17.6**: kind- and needs-conditional defaults; validation gets the ladder of the claim's `needs`; workflow order follows target kind. |
| S9 | Exploit procedures | `skills/exploit-design/SKILL.md:3` ("…and stopping at the first rung you cannot observe"), `:69` ("An exploit step usually ends at a wall rather than at code execution"), `skills/web-injection-to-exec/SKILL.md:74` ("Every injection rung has a cheaper true result… Take it."), `skills/memory-safety-auditing/SKILL.md:3` ("without developing an exploit"), `skills/state-and-lifetime-auditing/SKILL.md:52` ("does not authorize parallel or race testing"), `skills/ssrf-to-internal/references/reachability-targets.md:26` ("never use the credential without its own authorization") | The library's own exploit procedures set a failure base rate, and one passage forbids the method that turns a metadata read into a cloud-role escalation. | **A17.6**: rewrite as "reach what the ladder reaches" with the same honesty gates. |
| S10 | `HANDOFFS.md:74-92` | H3 return condition: "…targeted coverage check—not immediate impact development"; H4 stops at "assess"; no crash→effect or foothold→root contract | Names the crash→impact and shell→root transitions and routes them away; no handoff contract carries a primitive into an exploitation task. | **A17.6**: rewrite H3; add H4.5 (primitive→effect) and H4.6 (foothold→LPE/pivot). |

### 3.3 Missing methods and missing transport (ABSENT)

| # | Gap | Consequence | Proposal |
| --- | --- | --- | --- |
| M1 | No post-exploitation / local privilege escalation procedure among the 35 skills; "privilege escalation" appears once, inside fix guidance (`skills/exploitability-assessment/SKILL.md:49`) | RCE→root, the rung the owner names, has no method: no enumeration discipline, no path menu (sudo/misconfig/SUID/services/cron/container boundary), no proof rules for a root observation | **A17.6**: new procedure `session-to-root` + reference card |
| M2 | No internal-pivot procedure; `credential-and-pivot` covers identity, not network path; tunnel/listener guidance exists only in tool descriptions and one SSRF sentence | An RCE'd host that reaches an internal-only service has no method for an in-band request, a reverse-shell listener (lab network), or a forward | **A17.6**: new procedure `internal-pivot` + reference card |
| M3 | No N-day weaponization procedure; `patch-diff-analysis` stops at applicability analysis, `exploit-design` assumes an already-confirmed primitive | Patch-diff→trigger is the cheapest critical route in the corpus (Big Sleep's measured win) and the one the CVE-lead machinery points at | **A17.6**: new procedure `n-day-to-effect` + reference card, honest that version ≠ proof |
| M4 | Worker brief has no exploit-context contract: `workerBrief` carries focus/task/context/graph slice/skills, nothing structured about build, mitigations, primitive or handles | The 90%-vs-50% evidence says this is the largest fixable yield loss | **A17.3**: generated `EXPLOIT CONTEXT` block for exploitation/chaining purposes |
| M5 | Foothold transport is not taught: an in-band RCE (commands executed through the exploited service) is the default path when no ingress exists; a reverse shell needs the operator lab network because the listener logs bytes and never answers (`extensions/p2o/index.ts:1436-1490`); session-mode PTY exists but only in `--executors session` | Workers prove a one-shot effect and stop; the shell/LPE rung is described as unreachable even when the lab network was provided | **A17.8**: teach both transports in `session-to-root`/`internal-pivot`; add `send`/`read` on the accepted listener connection so a foothold can be driven; state the no-ingress wall precisely |
| M6 | Exploit-tooling output discipline is not taught: 48 KiB visible output, 48 KiB HTTP body/upload/payload, 64 KiB scratch write, 32 KiB command; `p2o_capture` reads up to 1 MiB | gdb/fuzz/nmap/msf transcripts truncate, so an exploit attempt looks like a failed one; the cap is mistaken for a target fact | **A17.6/A17.9**: teach "tee to scratch, cite a `p2o_capture` artifact" as the default for exploit tooling; record the caps in the capability matrix |

### 3.4 What is not the bottleneck (do not re-fix)

Time, tokens, turns: no elapsed-time/token/spend ceiling; commands default `timeout=0`. Sandbox: root, writable rootfs,
default caps, compilers/debugger/recon tooling, installs, egress, browser, listeners, reverse shells (measured §2.4).
Egress and identity: `p2o_http` accepts any URL/method/header/body; opaque commands are not origin-filtered; sealed
secrets and self-provisioned principals. Ingress: `--callback` / `--lab-network`. Sessions/PTY: `session` executor.
Tool surface: 34 registered / 32 model-visible / planner 21 / worker 19 / validation 18 / reporter 6 after the dedupe
pass. Authority: blanket one-time consent; no per-action ask. None of these need changing in P17, and prompts must not
undersell them again ("no shell", "no browser", "read-only" were already retired once — `tests/minimal/truth.test.ts`).

### 3.5 Attention cost and duplication (paid for by A17.0)

| Rule | Copies |
| --- | --- |
| Policy provenance / `boundary_invariant` | `src/prompts.ts:20`, `:174`; `src/tool-guidelines.ts:28`; `extensions/p2o/index.ts:2171`; `src/tool-schemas.ts:72`; `docs/EVIDENCE.md:30-33`; `skills/web-object-authorization/SKILL.md:22,25,44,45` |
| Independence / validation | `src/prompts.ts:159-160`, `:175`; `docs/EVIDENCE.md:68-78`; `HANDOFFS.md:38-40` |
| "One intent, write back, report, stop" | `src/prompts.ts:234`, `:258`; `src/tool-guidelines.ts:37` |
| `AUTHORIZATION_TRUTH` | `src/prompts.ts:216` (tool line) and `:271` (worker brief) |
| "Before first use: scope baseline / handoff / owner review" | 35 × in `skills/*/SKILL.md` |
| "record a refused attach as the specific blocked fact" | 5 × across the memory/race/state skills |

A17.0 removes or consolidates these so new lines are net-neutral to the prompt ceilings (`tests/minimal/recon.test.ts`
`PROMPT_CEILINGS`: planner 14,200 / worker 13,200 / validation 13,500 / brief 1,650 / reporter 2,600; current: planner
13,436 / worker 12,725 / validation 13,064 / reporter 2,311).

---

## 4. Invariants for an exploitation-capability pass

Each is stated so a test can fail on it.

1. **Authority is unchanged.** The planner still holds no target, lab or claim tool; a worker is the only claim author;
   the target is a label, not an egress boundary; one start consent covers the run; no per-action consent; no new
   permission.
2. **Honesty is unchanged.** A claim still needs same-run receipts and closure; a finding still needs an accepted,
   current case; severity is still bounded by demonstrated depth; a version/CVE/banner match is never proof; the report
   still states what it did not establish.
3. **Only attempts get cheaper; claims do not.** Every relaxation removes an obstacle to *trying* and leaves an
   observation requirement in front of *claiming*.
4. **The prompt budget is paid, not raised.** Every added line is offset by removing duplication or a stale clause. A
   ceiling moves only with a dated comment in the test saying which capability grew and why.
5. **The skill ceiling holds.** Every `SKILL.md` stays ≤8,000 chars in every kind; catalog ids, links, provenance and
   test-library guards stay green; the third-party guardrail doctrine stays out.
6. **Runtime claims are true.** Prompts and skills promise only what §2.4 measured. Unverified behaviour is described as
   unverified, never as blocked or absent; the two stale runtime assertions are fixed, not inherited.
7. **No finish gate, no allowance, no new budget** (owner decision 2026-10-24): a run always finishes with an honest
   report. The one admission refusal this pass adds (D32: no task before the impact goal) names the artifact to create,
   so it cannot trap a run; everything else surfaces as a planner demand or a preflight advisory.
8. **LPE is bounded by what a foothold proves.** A root observation through a target-side shell is root of that workload;
   the report names the boundary crossed. Container escape and host-kernel exploitation are out of scope.
9. **Measurement is separate and owner-authorized.** Hermetic tests decide correctness; only a clean, owner-authorized,
   cost-capped campaign decides penetration effectiveness, and the pass ships as "effectiveness UNVERIFIED" until then.

---

## 5. Decisions (D32–D43, proposed; defaults recommended)

| ID | Decision | Recommended form | Why |
| --- | --- | --- | --- |
| D32 | **Impact-first plan shape.** In the default `exploit` mode the host refuses admission of any worker task until the plan board holds a non-cancelled goal whose proof is a capability or an accepted case; the first plan round authors that goal (with its acceptance criteria) before the first dispatch, and the refusal names `p2o_plan_author` and the legal next step. The existing `EXPLOIT_MODE_NEEDS_IMPACT_GOAL` refusal is extended from exploitation/chaining intents to every target-executing intent. An advisory (`IMPACT_UNATTEMPTED`) still reports a run whose impact goal exists but whose progress never becomes an exploitation/chaining task. This is an **admission** refusal, not a finish gate: a run still finishes with an honest report (owner decision 2026-10-24 preserved for finishing). | Admission refusal + prompt demand | Owner decision 2026-10-27 (A3 chose the stricter option); a capability goal needs no evidence to be authored, so the refusal cannot deadlock a run |
| D33 | **Worker exploitation stance** (conditional block for `purpose ∈ {exploitation, chaining}`): objective is an observable effect; a wall requires a host refusal *or* the recorded bypass classes; one failed sample is not a family; re-trigger independently before claiming; the self-deception list; negative = observation, one recheck; spill adjacent leads. | Prompt block, paid by dedupe | ARTEX worker doctrine; the measured exploit-intent effect; no token-budget change |
| D34 | **Grey-box handoff contract.** Exploitation/chaining briefs carry a generated `EXPLOIT CONTEXT`: primitive sentence (hypothesis/CWE + claim ref), target revision/build/mitigation facts, known controls and limitations, the `needs` frontier from typed capabilities, available session/secret/ingress handles, expected observation and stop condition. Chain successors carry verbatim payload bytes and response detail, not summaries. | Engine seam + planner fields | 90%-vs-50% decomposition; AXE 3× |
| D35 | **Severity follows demonstrated effect; policy basis is provenance.** Scope the `inferred` ceiling to cases that did not observe and test an effect. A tested+observed crossing rated on inferred provenance is allowed at demonstrated depth, printed with an `INFERRED_POLICY` provenance flag and a required limitation; a rating above demonstrated depth is still refused. Teach the `boundary_invariant` examples that actually occur (the attacker's own identity across a principal/tenant boundary; metadata/private-network reach from an attacker-influenced URL; unauthenticated code execution). | Scoped code change + docs + tests | H1/H2; keeps the anti-rumour bar |
| D36 | **Confirmation ≠ independence.** Review confirms a claim; a second worker's replay earns `independentCurrent`; neither is a precondition for the next rung. The planner prompt states this and stops serialising rungs behind validation. | Prompt + docs; no host change | Host already works this way; the prose overstates it |
| D37 | **Skill ladder.** Add three procedures (`session-to-root`, `internal-pivot`, `n-day-to-effect`) with one reference card each; rewrite the 12 closure/contradiction passages in §3.2/§3.3; make defaults target-kind and `needs` aware; rewrite H3 and add H4.5/H4.6 to `HANDOFFS.md`. | 35 → 38 skills, all ≤8,000 chars | M1–M3; ARTEX/CVE-lead evidence |
| D38 | **Restart policy.** When a worker exhausts or stalls a mechanism, the planner dispatches a *fresh* worker with a *different* mechanism (new task, or `continue` with a materially different brief) instead of extending the same thread; the retry admission test and "read the trace position first" are stated. | Prompt + reuse of preflight | XBOW restarts; Context Rot |
| D39 | **Refusal framing and description craft.** A host-policy refusal says "platform policy, not target defense; this class is refused — do not re-encode or retry an equivalent". Environment refusals state the fact without inviting retries. `p2o_lab` says run the smallest probe and store the bytes in the same step. `p2o_state`/`p2o_board`/`p2o_graph` gain "don't re-list what you know; aggregate writes". The planner gains one surface-family line. A test asserts payload classes (SQLi, command injection, SSTI, deserialization, upload, SSRF, traversal, LFI) are never policy-denied. | Descriptions + planner line + test | ARTEX anti-bypass framing; description craft |
| D40 | **Persistent interactive foothold (owner decision 2026-10-27).** One accepted connection per session, kept for the session's lifetime: it is interactive `send`/`read` with **no artificial per-send size or per-command idle cap**, the shell survives steps and worker reports (session-owned; a successor continues it through hold/chain-in-session), and attaching requires an **identity confirmation through the shell** (`whoami`/`id`) recorded before any further operation. Interaction is uncapped; what enters the model context is a bounded preview plus a `p2o_capture` artifact for the full transcript. Lab-network only, no host port, no tunnel/pivot subsystem. In-band execution remains the default transport when no ingress exists. | Engine seam + skills | M5; owner decision (A5: one connection, no limits, confirm `whoami`, keep the shell) |
| D41 | **Runtime truth and drift guard.** Record the §2.4 matrix in docs; fix `scripts/setup-sandbox-tools.sh` usage text; correct `tests/minimal/docker.test.ts:10-20` and `docker-extension.test.ts:76-78` to the measured posture (root, 14 caps, uid 0) so the opt-in Docker suite asserts reality, and add one non-Docker assertion on the sandbox flags so drift is visible without Docker; publish the prompt-safe / forbidden claim lists. | Docs + tests + script text | Stale assertions were already hiding drift |
| D42 | **Optional operator toolchain image.** Extend `scripts/setup-sandbox-tools.sh --with` with an offensive set (pwntools, strace, socat, ssh client, AFL++, radare2, tcpdump, java) as an operator convenience; the agent still installs into scratch when needed. Not required for the plan. | Operator step, documented | D's ranked gap 3; Anthro ranges 5/9 needed a custom toolkit |
| D43 | **Measurement protocol.** Two hermetic fixtures (web exploit ladder; credentialed cross-tenant bypass) with evaluator truth, plus an A/B campaign (current prompts/skills vs P17) — 2 fixtures × 2 variants × 2 arms × 3 reps = 24 runs, fixed per-run budgets, seeded randomized order. Criteria: ≥2 rungs executed on the ladder fixture, ≥1 accepted-current high/critical per vulnerable fixture, zero false claims, attempt records present, no leftover containers. | Fixtures + protocol; run only with owner authorization and a cost cap | Existing `bench/` machinery; no effectiveness claim until run |

---

## 6. Workstreams

Each workstream names the decision, the exact seams, the hermetic gate and the measured criterion it feeds.

### A17.0 — Pay the prompt budget (no behaviour change)

- Consolidate policy-provenance prose to one canonical place (the evidence section of `src/prompts.ts`) and have the
  others point at it: `src/tool-guidelines.ts:28`, `extensions/p2o/index.ts:2171`, `src/tool-schemas.ts:72`; same for the
  independence rule. Remove the duplicated `AUTHORIZATION_TRUTH` in `workerBrief`, the repeated "one intent" line, and the
  35 identical skill preambles (one canonical line pointing at `HANDOFFS.md#focused-method-and-review`).
- **Gate:** full `npx vitest run tests/minimal` (prompt-pin tests updated only where the canonical text moved),
  `npm run check:library`, no ceiling changes.
- **Measured:** none; this is budget.

### A17.1 — Worker exploitation stance (D33)

- `src/prompts.ts` worker body: add the conditional exploitation block (only when the ticket purpose is exploitation or
  chaining, so the static prefix for every other worker is unchanged): effect objective; exhaustion definition;
  independent re-trigger; the three self-deception patterns; negative-as-observation with one recheck; spill adjacent
  leads; cite a `p2o_capture` artifact when the observation is larger than the visible cap.
- `src/tool-guidelines.ts`: mirror the re-trigger/self-deception rule on `p2o_candidate` (claim time) and the
  "propose, never spawn — and over-report adjacent leads" imperative on `p2o_request_subtask`.
- `src/duties.ts`: exploitation/chaining duty lines gain "a wall is a refusal or an exhausted family, never a first
  failure".
- **Gate:** new pins in `tests/minimal/prompt-roles.test.ts`; `tests/minimal/recon.test.ts` ceilings (worker headroom
  ≤475 chars, paid by A17.0); `tests/minimal/dispatch-discipline.test.ts` unchanged.
- **Measured:** attempts recorded per primitive; rung 1 completed.

### A17.2 — Planner demand, mechanism diversity, restart (D32, D38)

- `src/prompts.ts` planner body: one bounded surface-family line (pre-auth routes, upload→exec, deserialization, parser
  differential, race, type confusion, mass assignment); "read the interrupted worker's ledger position before re-planning";
  the retry admission test next to the existing anti-spin line; "dispatch a different mechanism, not a longer thread";
  impact-goal demand and the `capability` proof option.
- Admission (D32): extend `EXPLOIT_MODE_NEEDS_IMPACT_GOAL` from exploitation/chaining intents to every target-executing
  intent in `exploit` mode; refusal names `p2o_plan_author`, the acceptance criteria and the legal next step; the planner
  first-action line becomes author-the-goal-then-dispatch. Assess mode is unchanged.
- `src/finish-preflight.ts`: one advisory `IMPACT_UNATTEMPTED` — an `exploit` run whose plan holds a capability-proof goal
  and where no exploitation/chaining task was ever admitted (reusing `NO_GOAL_RECORDED`/`PRIMITIVE_UNCHAINED` where they
  already fire; advisory only, finish stays gate-free).
- Manual mode: one bounded review join per round (no polling), documented in the prompt.
- **Gate:** `tests/minimal/prompt-roles.test.ts` + `dispatch-discipline.test.ts` pins; `tests/minimal/review-integrity.test.ts`
  for the advisory; `tests/minimal/acceptance-matrix.test.ts` after matrix rows are added.
- **Measured:** exploitation/chaining task count; mechanism-family diversity.

### A17.3 — Grey-box handoff contract (D34)

- `src/prompts.ts` `workerBrief`: add the `EXPLOIT CONTEXT` block for exploitation/chaining tickets: primitive sentence
  (from the claim's `gained`/`needs` and the task's `work.claimRefs`), target facts from the graph slice (revision,
  build, mitigations; labelled inference), known controls/limitations, the `needs` frontier, handles (`session`,
  `p2o_secret` ids, ingress path), expected observation, stop condition. Absent fields say "not recorded", never a guess.
- `src/tool-schemas.ts` task draft: the planner supplies the primitive sentence and expected observation; the host
  validates length only (no new required field that would raise admission refusals).
- Chain successors carry verbatim payload ids/bytes and response excerpts, not summaries (`p2o_task_dispatch` path).
- **Gate:** new `tests/minimal/brief-context.test.ts` (block present/absent by purpose; brief ceiling ≤1,650; no
  fabricated facts on an empty graph); `tests/minimal/extension.test.ts` dispatch path.
- **Measured:** first-attempt rung success.

### A17.4 — Severity and policy semantics (D35)

- `src/cases.ts`: scope the inferred ceiling to cases whose claims have no tested observation
  (`closure === 'open_proof_gap' || execution !== 'tested' || proof === 'static_trace'`); a tested+observed effect rated
  on inferred provenance records and prints an `INFERRED_POLICY` provenance flag, requires a non-empty `limitations`, and
  is still refused above demonstrated depth. Update the docstring at `:198`.
- `docs/EVIDENCE.md`: restate the rule and the `boundary_invariant` examples that occur; rewrite `src/prompts.ts:20` (H2);
  point `src/tool-guidelines.ts:28` and `src/tool-schemas.ts:72` at the canonical text.
- `docs/ACCEPTANCE_MATRIX.md` row F-P3-3 gains the scoped wording and the new test title.
- **Gate:** update `tests/minimal/case-rating.test.ts:59` (the cap still binds a static/untested claim) and
  `tests/minimal/ladder.test.ts:166`; add one test that a tested+observed cross-tenant effect on inferred provenance rates
  high with the flag and a limitation; `tests/minimal/extension.test.ts` report provenance line.
- **Measured:** high/critical accepted-current count; false-claim rate stays 0.

### A17.5 — Confirmation vs independence (D36)

- `src/prompts.ts:159-160` rewrite; `docs/EVIDENCE.md` already states the host rule — reference it. Keep the validation
  task and the badge.
- **Gate:** `tests/minimal/prompt-roles.test.ts` pin update; a test that the planner prompt no longer states validation as
  the confirmation gate for the next rung.
- **Measured:** rounds per rung from the ledger.

### A17.6 — Skill ladder (D37)

- New procedures (each ≤8,000 chars, frontmatter, first-use line, honest completion definition):
  - `session-to-root` — post-exploitation and privilege escalation from a demonstrated shell/in-band execution to a root
    observation *of the compromised workload*: enumeration discipline; path menu (sudo/SUID/misconfiguration/services/
    cron/container boundary); proof rules for a root observation; in-band vs reverse-shell transport; the wall; cleanup;
    no destructive persistence and no "stay quiet" instruction.
  - `internal-pivot` — from a foothold to internal reach: in-band requests from the compromised host, reverse shell into the
    operator lab listener, the callback path, and the honest wall when no ingress exists; how to state the network facts.
  - `n-day-to-effect` — patch-diff/CVE lead to a triggered effect: applicability test, trigger construction, version≠proof
    rule, effect observation.
- Reference cards: `privilege-escalation-paths.md`, `pivot-transport.md`, `n-day-applicability.md`.
- Rewrites in §3.2 S9 and `HANDOFFS.md` H3 + new H4.5/H4.6; `skills/exploit-design/SKILL.md` description and "The wall"
  section; delete `skills/web-injection-to-exec/SKILL.md:74`; `memory-safety-auditing` description;
  `state-and-lifetime-auditing:52`; `ssrf-to-internal` reference; `web-token-and-federation:27`;
  `web-server-side-injection:32,53`; `exploitability-assessment:46`; `deserialization-and-dispatch-auditing:43`;
  `web-object-authorization:3`; `web-crypto-usage-review:53`; `binary-auditing:27` stale link.
- Defaults (`src/roles.ts`): `exploitation` = `exploit-design` + ladder from `needs` (already) + `session-to-root` when
  `needs` includes `host.shell`; `chaining` likewise; `validation` gets the ladder of the claim it reproduces.
- Catalog: 35 → 38 skills, version bump; provenance entries for each new skill (`research/SKILL_PROVENANCE.md` and the
  library test's per-skill checks); WSTG map untouched (these are procedures, not WSTG tests).
- **Gate:** `npm run check:library` (35 → 38 skills; its printed `17` is technique owners with blog evidence, which a
  procedure cannot change), `tests/minimal/knowledge.test.ts` counts,
  `tests/minimal/wstg-skills.test.ts` ceiling + link guards, `tests/test_library.py`; no orphan cards; ≤8,000 chars.
- **Measured:** rungs 2–3; LPE rung proven through the foothold.

### A17.7 — Refusal framing and description craft (D39)

- `extensions/p2o/index.ts` policy-refusal path (`:1284` region): platform-policy wording, no "different approach" that
  invites evasion; environment refusals moved to the tail (`:2337`, `:2405`); `p2o_lab` ordering
  (`src/tool-guidelines.ts:18`); batching/no-relist lines on `p2o_state`/`p2o_board`/`p2o_graph`.
- Test: a policy test that a synthetic payload set across classes never produces a deny rule (seeds are self-destruction
  only); `tests/minimal/truth.test.ts` still passes (no retired phrase reintroduced).
- **Gate:** `tests/minimal/workflow-policy.test.ts`, `authority.test.ts`, `truth.test.ts`; description budget
  `tests/minimal/context-budget.test.ts` unchanged ceilings.
- **Measured:** none; friction and budget.

### A17.8 — Interactive foothold (D40)

- `extensions/p2o/index.ts` listener implementation (`:1436-1490`): one persistent foothold connection per session,
  interactive `send`/`read` with no artificial per-send size or idle cap (the operator may still configure one), kept for
  the session's lifetime across steps and worker reports, attaching only after a recorded identity confirmation through
  the shell (`whoami`/`id`); full transcript to a `p2o_capture` artifact, bounded preview to the model. Audited as
  session operations, lab-network only, never a host port. `p2o_session` documents the action; `session-to-root` and
  `internal-pivot` teach the three transports (in-band, listener shell, session PTY) and their walls.
- Inert tests for the socket state machine; real end-to-end remains an opt-in Docker test (and needs a lab peer).
- **Gate:** `tests/minimal/session.test.ts` extension; fake-backed listener state test; description pins.
- **Measured:** reverse-shell foothold rung (ladder fixture); internal-reach rung.

### A17.9 — Runtime truth and drift guard (D41)

- Docs: §2.4 matrix distilled into `docs/ARCHITECTURE.md` (sandbox facts) and `docs/USAGE.md` (operator-visible limits),
  with the prompt-safe and forbidden claim lists.
- Fix `scripts/setup-sandbox-tools.sh` usage text ("read-only and non-root" → root with default caps).
- Fix `tests/minimal/docker.test.ts:10-20` and `tests/minimal/docker-extension.test.ts:76-78` to the measured posture
  (uid 0, 14 caps); add a non-Docker assertion over the `LIMITS`/`docker create` argv so drift is visible in the default
  suite; keep the Docker suite opt-in.
- **Gate:** full suite; the new argv test; docs parity. `tests/minimal/truth.test.ts` retired-phrase scan unaffected.
- **Measured:** none.

### A17.10 — Operator toolchain image (D42, owner decision 2026-10-27)

- Extend `scripts/setup-sandbox-tools.sh --with` with `pwntools`, `strace`, `socat`, `ssh`, `afl++`, `radare2`,
  `tcpdump`, `java` (pinned, same build-time-only rule); document in `docs/KNOWLEDGE.md` and list each tool's purpose.
  The running container stays as it is; the agent can still install into scratch, so this is an operator convenience, not
  a capability gate.
- **Gate:** `tests/minimal/knowledge.test.ts` / library checks for the documented list; script shellcheck-style review.
- **Measured:** none.

### A17.11 — Measurement (D43)

- Bench fixtures: `bench/fixtures/exploit-ladder/` (entry bug → command execution marker → foothold → local escalation →
  inert root marker; `expected/truth.json` with rungs, gaps and forbidden claims) and `bench/fixtures/tenant-bypass/`
  (credentialed cross-tenant read; exercises the D35 severity path). Both hermetic, synthetic, local-only.
- `bench/lib/plan.mjs`: fixture discovery + arms (A = current prompts/skills, B = P17); scoring extended with "rungs
  reached" and "accepted-current high/critical" counters, keeping the existing false-claim detection.
- Protocol (ready, **not run**): 2 fixtures × 2 variants × 2 arms × 3 reps = 24 runs; wall 25 min, turns 60, target
  commands 120, cost cap set by the owner; seeded shuffle; no implicit fallback; cleanup by run label. Owner decision
  2026-10-27 (A6): no paid campaign in this phase; the fixtures and protocol ship, the measured gate is deferred and the
  pass reports effectiveness UNVERIFIED.
- **Gate (hermetic):** `tests/minimal/benchmark.test.ts` (fixture isolation, no truth in the visible tree, objective
  neutrality) + scoring unit tests. **Measured (owner-run):** D43's criteria; a failed gate does not pass on an honest
  wall.
- **Measured:** all.

---

## 7. Phases

Ordering: pay the budget, then runtime truth, then worker doctrine, then planner demand, then the handoff seam, then
semantics, then the library, then descriptions, then the foothold, then measurement. Every phase is additive and
independently gated; no phase requires the paid campaign.

| Phase | Scope | Hermetic gate | Measured criterion |
| --- | --- | --- | --- |
| P17.0 | A17.0 budget pay-down | full vitest; prompt pins updated only where canonical text moves; ceilings unchanged | — |
| P17.1 | A17.9 runtime truth (first: no prompt may lie) | docs parity; fixed Docker assertions; new argv test; full suite | — |
| P17.2 | A17.1 worker stance | prompt pins; worker ceiling | attempts recorded; rung 1 |
| P17.3 | A17.2 planner demand + restart + advisory | prompt/preflight tests; manual-join test | exploitation task count; mechanism diversity |
| P17.4 | A17.3 grey-box brief | new brief-context suite; brief ceiling | first-attempt rung success |
| P17.5 | A17.4 severity semantics | case-rating + ladder revised; provenance-flag test; matrix row | accepted-current high/critical; false claims 0 |
| P17.6 | A17.5 confirmation wording | prompt pins | rounds per rung |
| P17.7 | A17.8 interactive foothold (engine) | socket state tests; session tests; description pins | reverse-shell rung |
| P17.8 | A17.6 skill ladder | check:library (20 skills); knowledge/wstg-skills/py tests; ceilings | rungs 2–3; LPE rung |
| P17.9 | A17.7 descriptions/refusals | policy/authority/truth/context-budget tests | — |
| P17.10 | A17.10 optional toolchain | library/knowledge checks | — |
| P17.11 | A17.11 fixtures + protocol | benchmark/scoring tests | the 24-run campaign (owner) |

Every phase's gate also includes: `npm run typecheck`, `npm run build`, `npm run check:build`, full `npx vitest run`,
`npm run check:library`, `git diff --check`, and the GitNexus `detect-changes --scope all` pass before any commit.

---

## 8. Migrations and compatibility

| Surface | Change | Compatibility |
| --- | --- | --- |
| Prompt text | planner/worker conditional blocks, dedupe consolidation | Text only; `tests/minimal/recon.test.ts` ceilings unchanged unless a dated comment raises one; the worker static prefix is unchanged for non-exploit purposes, so cache/parity pins survive |
| Admission | `exploit` mode refuses a target-executing intent until a capability/accepted-case goal exists (extends the existing exploitation-only rule) | Existing runs are unaffected (policy is read at admission); the refusal names `p2o_plan_author` and the legal next step; assess mode unchanged |
| Worker brief | new `EXPLOIT CONTEXT` block only for exploitation/chaining tickets | Additive; brief ceiling 1,650 stays; older records say "not recorded" |
| Case rating | inferred ceiling scoped to untested effects; `INFERRED_POLICY` provenance flag in the report projection | Existing ratings unchanged; a rating above demonstrated depth is still refused; `STALE_RATING` semantics unchanged |
| Preflight | one new advisory (`IMPACT_UNATTEMPTED`) | Advisory only, no refusal; readers ignore unknown codes |
| Skills | 35 → 38 skills + 3 reference cards; rewrites in 12 files | Catalog version bump; provenance entries; ≤8,000 chars held; no WSTG-map change |
| Runtime | listener `send`/`read` (lab-network only, bounded) | Additive action; no host port; no tunnel/pivot subsystem; existing sessions unaffected |
| Tests/docs | corrected Docker posture assertions; new argv drift test; capability matrix; ACCEPTANCE_MATRIX rows | Docker suite stays opt-in; the drift test runs by default |
| Bench | 2 fixtures + arm/scoring extensions | Existing fixtures untouched; truth isolation rules unchanged |
| Records | no new record kind, no schema migration | `policyBasis` vocabulary unchanged |

---

## 9. Risks, non-goals, metrics

### 9.1 Risks

| Risk | Mitigation |
| --- | --- |
| Over-claiming: "try harder" turns into severity inflation | D35 keeps the demonstrated-depth bound and requires limitations; false-claim rate is a hard campaign criterion and must stay 0 |
| Prompt bloat | A17.0 pays every line; ceilings pinned; one dated comment per ceiling change |
| Skill bloat | Per-skill ceiling, progressive disclosure (description selected, body inlined only when selected, 3-skill cap), cards linked not inlined |
| Model-specific results | Campaign pins provider/model/thinking; the pass ships "UNVERIFIED" until the run |
| Benchmark contamination | Fresh synthetic fixtures with inert markers, evaluator truth isolated, one manifest for hashing and copying (existing rule after the historical contamination caveat) |
| New foothold surface widens blast radius | Listener and foothold stay lab-network only, one connection per session, bounded preview + capture artifact (interaction itself uncapped per A5), every operation audited as a session row, no host port, removed with the container |
| Admission refusal stalls a run before the first dispatch | The goal needs no evidence and the refusal names the legal next step; one test proves a run with a goal dispatches, and the advisory (not a refusal) covers a goal that never becomes work |
| Stale runtime assertions mask future drift | A17.9 fixes them and adds a default-suite argv assertion |
| The campaign is never authorized, so the pass is unmeasured | Every phase is independently valuable; P17.11 leaves fixtures and protocol ready; the report says UNVERIFIED, never "improved" |
| Changing a rule the owner decided deliberately | D35 keeps the demonstrated-depth bound, D32 keeps the no-finish-gate decision, §4 lists what must not move; open questions are in Appendix A |

### 9.2 Non-goals

- No new permission, scope, role, loadout, budget, allowance or finish gate; no change to authorization texts.
- No destructive, persistence, evasion, anti-forensic or real-target campaign work.
- No container escape, no host-kernel exploitation, no nested Docker (impossible in this image anyway), no ASLR disabling
  (measured EPERM).
- No first-class host/SSH target kind in this phase; target-side footholds are in-band or a reverse shell into the lab
  listener. (Appendix A Q7.)
- No binary exploitation improvement; no model/provider change; no fine-tuning.
- No benchmark claim without the measured run; no new record kind or DB migration.

### 9.3 Metrics to add (reported, never scored as a gate)

| Metric | Source |
| --- | --- |
| Exploitation/chaining tasks per run; mechanism families per primitive | task purpose + `ROUTE_MONOCULTURE` |
| Rungs executed per demonstrated primitive | derived chain view |
| Attempts recorded before a wall | graph facts/notes + claim limitations |
| High/critical accepted-current findings, and how many carry `INFERRED_POLICY` | case ratings |
| False-claim rate (untriggered/version-only claims) | campaign scoring + review |
| Rounds per rung; target operations per rung | ledger timestamps |
| Footholds driven vs one-shot effects | session/listener facts |
| Cost per validated finding (campaign only) | provider usage receipts |

---

## Appendix A — owner decisions (recorded 2026-10-27)

All eight questions were answered by the owner before implementation. The two deviations from the recommended default are
recorded as such and are binding for the phases below.

| # | Question | Owner decision | Effect on the plan |
| --- | --- | --- | --- |
| A1 | Inferred-policy severity cap | **Scope + provenance flag** (recommended) | D35 / A17.4 as written: cap only when the effect is not tested+observed; `INFERRED_POLICY` flag + required limitation |
| A2 | New skills | **3 procedures + 3 cards** (recommended) | D37 / A17.6 as written; 35 → 38 skills, ≤8,000 chars each |
| A3 | How impact is demanded | **Refuse admission when no impact goal exists** (stricter than recommended) | D32 rewritten: every target-executing intent in `exploit` mode is refused until a capability/accepted-case goal exists; the first planner round authors it before dispatch; finishing stays gate-free |
| A4 | Restart policy | **Prompt guidance + existing preflight codes** (recommended) | D38 / A17.2 as written; no new engine limit |
| A5 | Foothold shell | **One persistent connection per session, no per-send/idle limits, visible `whoami` confirmation, keep the shell** (custom) | D40 / A17.8 rewritten: session-owned persistent interactive shell, uncapped interaction, bounded model preview + capture artifact, identity confirmation before use, lab-network only |
| A6 | Paid campaign | **No paid run in this phase** | A17.11 ships fixtures + protocol only; every phase stays hermetic-gated; the pass reports effectiveness UNVERIFIED |
| A7 | Target class | **Web/API + target-side host escalation** (recommended) | D37 targets as written; binary and host/SSH target are later phases |
| A8 | Runtime image | **Extend `--with` offensive set when needed** | A17.10 delivers the `--with` list as an operator step (not a capability gate) |

## Appendix B — how to re-verify this proposal

```sh
npx vitest run tests/minimal/context-budget.test.ts   # declaration budget
npx vitest run tests/minimal/recon.test.ts            # prompt ceilings + hashes
npx vitest run tests/minimal/case-rating.test.ts tests/minimal/ladder.test.ts
npm run check:library                                 # skills/catalog/provenance/links
npx vitest run                                        # full hermetic gate
```

Measured gate (owner-authorized, not run by this proposal): `node scripts/benchmark-skills.mjs prepare`, then the fixture
campaign per `bench/README.md` with a pinned model/thinking, cost cap and seeded order; read rungs and accepted-current
high/critical from the ledger, never from the narrative.

## Appendix C — what this proposal does not claim

- It does not claim ARTEX finds more bugs than pi-p2o; it claims ARTEX has worker-level mechanisms pi-p2o lacks, and the
  comparison is a mechanism floor, not a scoreboard.
- It does not claim the prompt changes will raise yield by a number. The one measured prompt-wording effect found
  (0.26→0.72) is a single small study; everything else in §2.2 is harness/architecture effect, and this plan's campaign is
  unrun.
- It does not claim verification gates cost recall; no study measures that and the audit's claim is mechanistic. The
  proposal only separates attempt gates from claim gates.
- It does not claim binary, Windows/AD, cloud-takeover or real-target effectiveness; those are out of scope or a later
  phase, and prompts will not pretend otherwise.
- It does not claim a target-side root is host root: the report must name the boundary the shell actually crossed; container
  escape and host-kernel exploitation are out of scope and unproven.
- It does not claim "more findings means better pentesting": a true wall, an honest Medium and a blocked report remain
  valid outcomes; the change is that they must come after the reasonable paths were walked, not before.

## Appendix D — sources

- CyberGym — https://arxiv.org/abs/2506.02548
- Naptime — https://projectzero.google/2024/06/project-naptime.html ; Big Sleep —
  https://projectzero.google/2024/10/big-sleep.html
- AXE — https://arxiv.org/abs/2602.14345
- AutoPenBench — https://aclanthology.org/2025.emnlp-industry.114/
- XBOW 1,060 attacks — https://xbow.com/blog/we-ran-1060-autonomous-attacks ; alloy — https://xbow.com/blog/alloy-agents ;
  HackerOne #1 — https://xbow.com/blog/top-1-how-xbow-did-it
- DARPA AIxCC — https://www.darpa.mil/news/2025/aixcc-results
- Anthropic cyber ranges — https://www.anthropic.com/research/cyber-toolkits-update
- Refusal study — https://arxiv.org/abs/2606.02644
- Context Rot — https://www.trychroma.com/research/context-rot
- Decoupling recon/exploitation — https://arxiv.org/abs/2606.25332
- Agentic architectures for offensive security — https://arxiv.org/abs/2604.18718
- Anthropic Agent Skills — https://www.anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills
- ARTEX — https://github.com/Autumn-27/ARTEX (local snapshot `my_references/ARTEX/`, v0.3.15)
- Runtime matrix — read-only probe of the pinned image + source audit, 2026-10-27 (see §2.4; no target was touched)
