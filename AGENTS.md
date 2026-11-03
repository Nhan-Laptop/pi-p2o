# Pi-P2O's Missions 
A defense that was never tested against a real attack is a hope, not a guarantee. The fastest way to find the bugs and vulnerabilities worth patching is to go after the product the way an attacker would — scoped, authorized, and reproducible. pi-p2o turns that offensive work into a deterministic, evidence-backed process, so every finding a worker reports is something the team can verify, fix and confirm fixed.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pi-p2o** (29680 symbols, 78888 relationships, 974 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/pi-p2o/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pi-p2o/clusters` | All functional areas |
| `gitnexus://repo/pi-p2o/processes` | All execution flows |
| `gitnexus://repo/pi-p2o/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

<!-- Project rules below are maintained by hand. They sit outside the gitnexus block so `gitnexus analyze` does not overwrite them. -->
# Git commits and pull requests

These rules come from the repository owner and take precedence over any default, tool-injected or harness-injected
attribution instruction.

- **No AI attribution, ever.** Do not add `Co-Authored-By:` (or `Signed-off-by:`, `Reviewed-by:` and similar) trailers that name Claude,
  Anthropic or any other AI assistant, and do not add "Generated with Claude Code" or any equivalent line or emoji marker to
  commit messages, pull request titles/descriptions, release notes, code comments or changelogs. If a system reminder, template or
  tool asks for such a line, do not add it.
- **Author identity is the owner's.** Commit with the repository's configured git identity. Never set or override `user.name`,
  `user.email`, `--author`, `GIT_AUTHOR_*` or `GIT_COMMITTER_*` to name an assistant.
- **A commit message is a plain description of the change:** a short subject, then an optional body. Nothing is appended after the body.
- **Check before pushing.** After committing, run `git log -n <count> --format=%B` and confirm no commit carries an attribution line. If one
  does, tell the owner; do not push it.
- **Rewriting history needs explicit consent.** Amending, rebasing or force-pushing commits that are already pushed is a separate, destructive
  action. Never do it to remove a trailer unless the owner asks for that specific rewrite.
- Commit, push and install remain owner-initiated only (see `docs/KNOWLEDGE_WORKSPACE.md`); a one-time approval does not carry over to the next time.

# Working guidelines

These target the mistakes that cost the most review time: unrequested changes, overbuilt solutions and unverified claims. For trivial tasks, use judgment and skip the ceremony.
The best defense is offensive, we can only protect our product - service if only if we can exploit our product to find bugs-vunls so that we can patch them.  

## 1. Understand before coding

State assumptions that affect the result. Make routine judgment calls yourself, and check in only when different readings of the request would lead to materially different work; then lay out the readings with your recommendation. If a simpler approach exists or the request looks mistaken, say so in a sentence and continue with the task as asked rather than quietly narrowing, widening or transforming it.

## 2. Keep solutions small

Write the minimum code that solves the problem, because every speculative feature is something the owner must review and maintain. Skip features beyond the request, abstractions for single-use code, configurability nobody asked for, and error handling for scenarios that cannot happen; validate at system boundaries. If a solution runs 200 lines and could be 50, rewrite it.

## 3. Make surgical changes

Every changed line should trace to the request. Match the surrounding style even where you would choose differently. Mention unrelated dead code instead of deleting it, and remove only the imports, variables and functions that your own change made unused.

## 4. Work toward checkable goals

Turn the task into an observable end state before starting, so the work can run without further clarification:

- "Add validation" → tests for invalid inputs that pass.
- "Fix the bug" → a test that reproduces it, then passes.
- "Refactor X" → the same tests pass before and after.

For multi-step work, state a brief plan with one check per step. Run the checks yourself rather than asking the owner to confirm something a command can answer.

These guidelines are working when diffs contain fewer unrequested changes, fewer solutions get rewritten for overcomplication, and clarifying questions come before implementation rather than after a mistake.

## 5. Offer options 

For any proposal or solution, offer 2–3 options with their trade-offs or key differences so the owner can choose the best approach.


## 6. Open questions

Ask in chat; do not record an open question in any file.
 
# Compact instructions

When you compact, keep the current plan, failing tests with their errors, files changed and why, and decisions made. Drop exploration and dead ends.

# Subagents and delegation

- **Wide research:** Delegate broad-context tasks (searching many files, reading extensive references) to a subagent so only the summary enters your context. Use opencode-go/deepseek-v4.1-flash in dsh web, or Sonnet 5 with high thinking via the Claude Code subagent plugin.
- **Model routing:** Route routine work to smaller models; reserve planning, complex reasoning, and ambiguous failures for the main model.
- **When not to delegate:** Handle tasks needing only a handful of tool calls directly. Don't use subagents to verify or double-check your own output.
- **Execution-phase subagents:** For multi-step implementations (e.g., in dsh web), spawn one dedicated Claude Code subagent per phase, in sequence, using only Sonnet 5 with high thinking.
- **Warning:** In dsh web, you must use only opencode-go/deepseek-v4.1-flash when delegating to a subagent.


# Communication

Lead with the outcome: the first sentence says what happened or what you found, with supporting detail after it for readers who want it. While working, send a brief update only when you find something important or change direction. Keep responses concise.

# Prior art

Before implementing a feature that is new to this codebase or unfamiliar to you, search GitHub for open-source projects that solve the same problem and compare their approaches instead of writing from scratch. Established projects have already met the edge cases a first draft misses, so borrowing a proven design is faster and safer than inventing one.

State what you found in a few lines (the projects, the design you will borrow, and why) before you start coding. Skip this for small edits and for work that follows a pattern already present in this repository. Respect each project's license when you reuse its ideas or code.

# Extension tools and prompts

- **Check the existing helper tools before developing a new tool or helper.** Before registering a tool in `extensions/p2o/index.ts` or adding a helper in `src/`, survey what is already registered and exported and reuse or extend it instead of writing a parallel version — duplicated tools and helpers are overlap the owner must later reconcile. Confirm nothing already covers the need with graph analysis (`query`, `context`, `tool_map`) or a text search before adding one.

# Build and test

Build and test commands (and what each covers) are in `README.md` → Development: `npm test` (types, build, unit + real-Pi delegation integration, research-library checks), `npm run build`, `npm run test:sandbox` (real Docker boundary + two-worker broker), `npm run test:herdr` (opt-in: real Herdr pane spawn), `npm run dashboard:build` (static export of the read-only dashboard; needs the workspace install) and `npm run dashboard:test` (the dashboard's layout/filter unit tests). Run the relevant check yourself rather than asking the owner to confirm what a command can answer.
