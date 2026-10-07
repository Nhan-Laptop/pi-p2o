// Per-run neutral objective extension for the benchmark runner (and the future holdout runner).
//
// The live runner previously delivered the fixture objective with a queued follow-up message, which
// can arrive after the P2O run has already finished and cleaned up — the agent would then execute
// the benchmark task outside the sandbox. Instead we load a tiny extension after the tested P2O
// extension; its `before_agent_start` handler appends the frozen objective to the system prompt
// while (and only while) the P2O scope text is present. Pi evaluates handlers in extension load
// order and chains `systemPrompt`, so the P2O hook (loaded first) runs before this one.
//
// The wrapper registers no tools, commands, flags, providers or message injection, and creates no
// additional agent run; it only appends text to the system prompt for an already-running assessment.

export const OBJECTIVE_MARKER = 'BENCHMARK OBJECTIVE (frozen fixture task, identical for every arm)';
export const SCOPE_MARKER = 'P2O ASSESSMENT';

/** Generate the tiny, dependency-free extension source loaded with `-e` after the tested arm. */
export function objectiveExtensionSource(objective) {
  if (typeof objective !== 'string' || !objective.trim()) throw new Error('objective is required for the wrapper extension');
  return `// @ts-nocheck
// Generated per run by scripts/benchmark-skills.mjs. Neutral fixture objective only:
// no tools, commands, flags, providers, message injection or other runtime behavior.
const OBJECTIVE = ${JSON.stringify(objective)};
const MARKER = ${JSON.stringify(OBJECTIVE_MARKER)};
const SCOPE_MARKER = ${JSON.stringify(SCOPE_MARKER)};

export default function (pi) {
  pi.on('before_agent_start', event => {
    const current = typeof event?.systemPrompt === 'string' ? event.systemPrompt : '';
    if (!current.includes(SCOPE_MARKER)) return undefined;
    if (current.includes(MARKER)) return undefined;
    return { systemPrompt: current + '\\n\\n' + MARKER + '\\n' + OBJECTIVE };
  });
}
`;
}

/** Plain-JS mirror of the generated handler, used by the hermetic wrapper tests. */
export function applyObjectiveHook(systemPrompt, objective, { marker = OBJECTIVE_MARKER, scopeMarker = SCOPE_MARKER } = {}) {
  const current = typeof systemPrompt === 'string' ? systemPrompt : '';
  if (!current.includes(scopeMarker)) return undefined;
  if (current.includes(marker)) return undefined;
  return { systemPrompt: `${current}\n\n${marker}\n${objective}` };
}
