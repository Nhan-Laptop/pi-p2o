/**
 * Exact `plan.steps` from the stored live first-use qualification run (real pinned worker process, real
 * DeepSeek `deepseek-flash` planner call at thinking `max`). Copied verbatim; no credentials, provider request
 * bodies, usage records or target responses are included.
 *
 * `tests/command/plan-bound.test.ts` re-reads the stored artifact whenever it is still present and fails when
 * this copy drifts, so the regression stays tied to real planner output rather than a hand-written
 * approximation. The live steps are 176..225 characters: they were inside the author validator's bound and
 * outside the human-command bound before the bound was unified.
 */
export const LIVE_DEEPSEEK_FLASH_MAX_PLAN = {
  artifact: '/tmp/p2o-qualification-live/url-attempt2/home/.p2o/runs/assessment-6a21bac7-ce64-42c8-9976-45dfb73e2f30/control/entry/entry-control/plans/plan-6235ca73-93a7-4132-971d-ab5ca0f9eb6a.json',
  evidenceClass: 'live-real-provider-model-calls-deepseek-flash-max-no-independent-verification',
  planId: 'plan-6235ca73-93a7-4132-971d-ab5ca0f9eb6a',
  planDigest: '41f984baefe6de5c34aa0c4a3003679166b998fe3e6e23aa77ff152a14a96836',
  selection: { provider: 'deepseek', model: 'deepseek-flash', thinking: 'max' },
  stepChars: [203, 176, 214, 211, 186, 225],
  steps: [
    'Confirm the owner-approved origin and single path prefix from the locator http://127.0.0.1:43521/exact, and verify only the anonymous account plus the read action and http.request capability are in play.',
    'Issue one non-mutating GET to the approved locator itself, treating the path exactly as given and adding no query, fragment, sub-path, header override or alternate destination.',
    'Record the observed status, response headers and body shape as an independently-observed baseline for the /exact endpoint, noting server banner, caching, redirect and error-handling signals without probing further.',
    'Map the reachable attack surface strictly from what the response itself discloses (declared paths, content types, framework hints) and mark anything not confirmed by a response as unverified rather than assumed.',
    'Audit authorization behavior only to the extent the anonymous read exposes it: check whether the endpoint returns content, denies access, or leaks internals to an unauthenticated caller.',
    'Report the single endpoint observation with its evidence, keep all findings inside the approved origin and path prefix, and close out without exploitation, mutation, credential use or any request to an unapproved destination.',
  ],
};
