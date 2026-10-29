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
 */
const DECLARATION_CEILINGS = { planner: 49_300, worker: 44_100, validation: 43_300, reporter: 6_800, model: 77_900 };

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
