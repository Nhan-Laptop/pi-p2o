import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { MODEL_TOOLS, PLANNER_TOOLS, REPORTER_TOOLS, VALIDATION_TOOLS, WORKER_TOOLS } from '../../src/tool-policy.js';
import { createFakePi, EXTENSION_PATH } from './helpers/fake-pi.js';

/**
 * Tool-declaration context budget.
 *
 * 2026-10-27: a content pass found the tool surface had grown to 37 registered verbs whose declared text (description plus
 * parameters schema) was 91,207 chars for the model-visible set, and the planner alone carried 63,240. The three
 * create/revise authoring pairs were merged into one verb each (identity picks the action), tool boundaries stopped
 * repeating each other, and the loadout dropped to 34 registered / 32 model-visible. To keep the next growth on purpose
 * rather than ambient, this suite pins the size each role's declaration payload must fit.
 *
 * Method: register the extension into the fake Pi, then for each role hold-out sum `description.length` plus
 * `JSON.stringify(parameters).length` over the tool names that role actually receives. Registered descriptions include
 * their boundary lines (withBoundaries), so this is the text the model sees, not the raw authoring string. Names are
 * excluded: they are one word each and already pinned by name in authority.test.ts. Hidden legacy verbs are excluded
 * for the same reason the model never sees them.
 *
 * Measured 2026-10-27 after the merge: planner 47,820; worker 42,751; validation 41,945; reporter 6,599; model 75,586.
 * The ceilings below are those numbers +3%, rounded up. Raise one only on purpose, with a dated comment here saying
 * which tool grew and why — a silent creep past these numbers is the failure this test exists to catch.
 *
 * 2026-10-28 (A1 dedupe): the three execution tool descriptions stopped repeating capability facts the prompts already
 * state, which removes 3,845 chars from the worker and validation declarations (and from the model union). The ceilings
 * stay put: the freed bytes are deliberate headroom, not an entitlement for the surface to grow by.
 *
 * 2026-10-29 (S1/C5 re-pin, D-S1-5): tranche C changed what the model is handed — the graph verb was split by authority
 * (shared reads; a worker/validation batch writer; a planner one-row review; a planner `chain`/`ingest` coordination
 * verb), taking the surface from 32 to 35 registered tools and the planner from 21 to 23, then every read was bounded
 * and the four authoring/rating verbs shared one `entry` key while the capability triple lost its duplicated field prose.
 * Measured after C: planner 44,134; worker 40,124; validation 39,313; reporter 6,282; model 73,363. Every ceiling below
 * is that measurement +3%, rounded up to the next hundred — the same method as before, so this pass lowers every number
 * instead of raising one. A later raise still needs a dated comment here naming the tool that grew and why.
 *
 * 2026-10-29 (P19/C+E): p2o_goal_author's declaration gained the measurable-proof/unreachable sentence and the wall-as-
 * progress sentence; measured planner 44,348 (still under the unchanged ceiling), worker/validation/reporter unchanged.
 *
 * 2026-10-30 (P22/A4): the plan-entry schema gained one optional `effect` field (a chain link's target class, validated against
 * the closed case-effect list); measured planner 45,049 — still under the unchanged 45,500 ceiling with 451 chars of headroom,
 * worker/validation/reporter unchanged. No ceiling is raised for it, and the field's prose lives once in the schema.
 *
 * 2026-11-01 (W-A/F3): p2o_candidate gained an optional `severityHint` object (cve/cwe/cvss/authWeakened) so a worker can cite
 * a severity signal for chain-ranking's tie-break. Even the bare field (no description, no constraints) costs more than the
 * worker ceiling's remaining headroom, so trimming prose cannot absorb it; measured worker 41,648, validation 40,837 (both
 * roles hold p2o_candidate), model 75,946 (the deduped union still carries the one new field once). Raised to 41,700 /
 * 40,900 / 76,000 (rounded up to the next hundred) — a deliberate, dated exception, not drift.
 *
 * 2026-11-02 (W-O/H7): p2o_session gained the managed reverse-SOCKS5 pivot paragraph (tunnel-open/list/close). It is a
 * governed target operation whose whole contract — lab-network gate, identified foothold, host-authored relay, python3 on
 * the obtained host, one pivot per session — has to be in the declaration because the model cannot start it without that
 * text; measured after W-O: planner 45,559; worker 42,914; validation 42,103; reporter 6,282; model 77,277. The same
 * measurement corrected a stale pin: the planner was already 59 over 45,500 before W-O, and its +88 since the 2026-11-01
 * measurement is real capability text — W-I's `data.write` kind, which every capability enum in a declaration has to list
 * (65 chars), and W-C's higher path-walk bounds in p2o_graph (maxDepth 6→10, maxNodes 500→1000, 23 chars); the worker's
 * +178 before W-O split into the same two (49) plus W-N's retained-artifact sentence on p2o_shell/p2o_net (129). Every
 * ceiling is re-pinned to the measured value rounded up to the next hundred: planner 45,600, worker 43,000, validation
 * 42,200, model 77,300. Reporting stays 6,500 (measured 6,282; it holds no p2o_session). Deliberate and dated, not drift —
 * the next raise needs the same treatment, and the freed headroom is not an entitlement for ambient growth.
 */
const DECLARATION_CEILINGS = { planner: 45_600, worker: 43_000, validation: 42_200, reporter: 6_500, model: 77_300 };

function declarationChars(tools: Map<string, any>, names: readonly string[]): number {
  let total = 0;
  for (const name of names) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is declared in the role loadout but was not registered`);
    total += String(tool.description ?? '').length + JSON.stringify(tool.parameters ?? {}).length;
  }
  return total;
}

const registrations = () => {
  const pi = createFakePi();
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH } as never);
  return pi.tools;
};

describe('model-facing tool declaration budget', () => {
  it('registers exactly the model-visible loadout entries', () => {
    const tools = registrations();
    for (const name of MODEL_TOOLS) expect(tools.has(name), `${name} must be registered`).toBe(true);
    for (const role of [PLANNER_TOOLS, WORKER_TOOLS, VALIDATION_TOOLS, REPORTER_TOOLS]) {
      for (const name of role) expect(MODEL_TOOLS, `${name} must be model-visible`).toContain(name);
    }
    // S1/B10: registration is exactly the model surface; the hidden legacy verbs are no longer registered.
    for (const name of tools.keys()) expect(MODEL_TOOLS, name).toContain(name);
  });

  it('keeps each role payload and the whole model surface inside the recorded declaration budget', () => {
    const tools = registrations();
    const measured = {
      planner: declarationChars(tools, PLANNER_TOOLS),
      worker: declarationChars(tools, WORKER_TOOLS),
      validation: declarationChars(tools, VALIDATION_TOOLS),
      reporter: declarationChars(tools, REPORTER_TOOLS),
      model: declarationChars(tools, MODEL_TOOLS),
    };
    for (const [key, ceiling] of Object.entries(DECLARATION_CEILINGS) as Array<[keyof typeof measured, number]>) {
      expect(measured[key], `${key} tool declarations exceeded their recorded budget`).toBeLessThanOrEqual(ceiling);
    }
    // The planner is the largest holder and the one that had to shed the most; a merge that reintroduces per-role copies of a
    // shared boundary would show up here first.
    expect(measured.planner).toBeLessThan(measured.model);
    expect(measured.model).toBeGreaterThanOrEqual(measured.worker);
  });
});
