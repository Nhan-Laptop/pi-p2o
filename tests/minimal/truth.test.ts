import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { plannerInstructions, workerInstructions, type PlannerPromptFacts } from '../../src/prompts.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { candidateParameters, noteParameters, reportParameters, taskDraftSchema } from '../../src/tool-schemas.js';
import { CREDENTIAL_TRUTH, HTTP_TRUTH, NETWORK_TRUTH, RISK_LABEL_TRUTH, SANDBOX_TRUTH } from '../../src/truth.js';
import { createFakePi, EXTENSION_PATH } from './helpers/fake-pi.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P7.0 (A7.10) — "Semantics truth pass".
 *
 * The extension's capability text is a behavioural input: the measured run invented a read-only risk limit out of an
 * undefined field, and the shipped strings undersold what the sandbox can do (origin scoping, "no raw sockets", a
 * non-root user) while claiming a credential channel the host does not provide. This suite pins the replacement:
 *
 *  1. every model-facing surface composes the same fact module (`src/truth.ts`),
 *  2. the retired claims are gone from `src`, `extensions`, `docs` and `skills`, so an edit cannot quietly restore them,
 *  3. `risk` is defined where the model is asked to write it,
 *  4. the exported report describes the instrument that actually ran.
 *
 * Hermetic: no sandbox starts, no model is called and no target is touched.
 */
const ROOT = resolve(EXTENSION_PATH, '../../..');
const RETIRED = [
  'all capabilities',
  'full capabilities',
  'no raw sockets',
  'non-root user',
  'origin-scoped',
  'every hop is checked',
  'third-party origins',
  'not computed from exploit',
  'must match the confirmed origin',
  'redirects stop before contacting other origins',
  'Credentials must be operator-supplied',
  'Supplied credentials and returned data',
  // P8.2 truth half: the citation fetch is host-side and uncapped under Part XI. The stale P14.8 comment claimed it ran
  // inside the caller's own sandbox, and the worker loadout line called it capped; both statements were false.
  "runs inside the caller's own sandbox",
  'capped citation fetch',
];
const TEXT_FILE = /\.(?:ts|md|json)$/;
async function shippedText(directory: string): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true })) {
    const path = join(ROOT, directory, entry.name);
    if (entry.isDirectory()) { out.push(...await shippedText(join(directory, entry.name))); continue; }
    if (!TEXT_FILE.test(entry.name)) continue;
    out.push({ file: path, text: await readFile(path, 'utf8') });
  }
  return out;
}
const registrations = () => {
  const pi = createFakePi();
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH } as never);
  return pi.tools;
};
const plannerFacts = (overrides: Partial<PlannerPromptFacts> = {}): PlannerPromptFacts => ({
  runId: 'run-truth', targetLabel: '/fixture', targetKind: 'directory', sourceSkipped: 0,
  delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, phase: 'active', loopMode: 'manual', executorMode: 'shared', ...overrides,
});
const ticket = (role: string) => ({ workerId: 'worker-1', role, depth: 1, parentWorkerId: null, target: { kind: 'directory', label: '/fixture' }, executorMode: 'shared' } as never);

describe('P7.0 truth pass', () => {
  it('states each instrument fact once in the fact module', () => {
    for (const [name, fact] of Object.entries({ SANDBOX_TRUTH, NETWORK_TRUTH, HTTP_TRUTH, CREDENTIAL_TRUTH, RISK_LABEL_TRUTH })) {
      expect(fact.length, name).toBeGreaterThan(80);
      for (const retired of RETIRED) expect(fact.toLowerCase(), `${name} must not repeat a retired claim`).not.toContain(retired.toLowerCase());
    }
    expect(SANDBOX_TRUTH).toContain('Docker default capability set');
    expect(SANDBOX_TRUTH).toContain('raw sockets work');
    expect(NETWORK_TRUTH).toContain('unrestricted');
    expect(NETWORK_TRUTH).toContain('There is no inbound path by default');
    expect(NETWORK_TRUTH).toContain('--lab-network');
    expect(NETWORK_TRUTH).toContain('no host port is published');
    expect(HTTP_TRUTH).toContain('starting label');
    expect(CREDENTIAL_TRUTH).toContain('There is no ambient host credential channel');
    expect(CREDENTIAL_TRUTH).toContain('${P2O_SECRET:<id>}');
    expect(RISK_LABEL_TRUTH).toContain('not a risk appetite');
  });

  it('composes the truth into the registered execution tools', () => {
    const tools = registrations();
    const shell = tools.get('p2o_shell')!.description as string;
    const net = tools.get('p2o_net')!.description as string;
    const http = tools.get('p2o_http')!.description as string;
    expect(shell).toContain(SANDBOX_TRUTH);
    expect(shell).toContain(NETWORK_TRUTH);
    expect(net).toContain(NETWORK_TRUTH);
    expect(http).toContain(HTTP_TRUTH);
    expect(http).toContain(CREDENTIAL_TRUTH);
    expect(tools.get('p2o_http')!.label).toBe('HTTP request');
    for (const [name, description] of [['p2o_shell', shell], ['p2o_net', net], ['p2o_http', http]] as const) {
      for (const retired of RETIRED) expect(description.toLowerCase(), `${name} still says ${retired}`).not.toContain(retired.toLowerCase());
    }
  });

  it('gives the planner and worker the same facts, including the risk-label definition', () => {
    const planner = plannerInstructions(plannerFacts());
    expect(planner).toContain(SANDBOX_TRUTH);
    expect(planner).toContain(NETWORK_TRUTH);
    expect(planner).toContain(RISK_LABEL_TRUTH);
    expect(planner).not.toContain('full capabilities');
    const worker = workerInstructions(ticket('recon'));
    expect(worker).toContain(CREDENTIAL_TRUTH);
    expect(worker).not.toContain('operator-supplied');
    expect(TOOL_BOUNDARIES.p2o_http.join(' ')).toContain('starting label');
    expect(TOOL_BOUNDARIES.p2o_http.join(' ')).not.toContain('origin');
  });

  it('states the citation fetch as Part XI keeps it: host-side, uncapped, and never the caller\'s own sandbox (P8.2)', () => {
    const research = registrations().get('p2o_research')!.description as string;
    const worker = workerInstructions(ticket('recon'));
    // Part XI: the target is a label, not an egress boundary, and the citation fetch is host-side with no allowlist and no
    // response cap. The retired-claims test above pins the two false statements; this pins the true ones.
    expect(research).toContain('host-side');
    expect(research.toLowerCase()).toContain('no size cap');
    expect(worker).toContain('citation fetch returns quoted data, never target evidence');
  });

  it('defines the risk label on every schema that asks for it', () => {
    const schemas = { taskDraftSchema, candidateParameters, noteParameters, reportParameters } as never as Record<string, { properties: Record<string, any> }>;
    expect(schemas.taskDraftSchema.properties.risk.description).toBe(RISK_LABEL_TRUTH);
    for (const name of ['candidateParameters', 'noteParameters'] as const) {
      expect(schemas[name].properties.risk.description, name).toMatch(/not a severity|never read as a severity/);
    }
    const coverage = schemas.reportParameters.properties.coverage;
    expect(coverage.items.properties.risk.description).toMatch(/not a severity|not a limit/);
  });

  it('has retired every false claim from the shipped tree', async () => {
    const shipped = [...await shippedText('src'), ...await shippedText('extensions'), ...await shippedText('docs'), ...await shippedText('skills')];
    expect(shipped.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const { file, text } of shipped) {
      for (const retired of RETIRED) if (text.toLowerCase().includes(retired.toLowerCase())) hits.push(`${file}: ${retired}`);
    }
    expect(hits).toEqual([]);
  });

  it('describes the instrument it actually used in the exported report', async () => {
    await fixture(async h => {
      await populate(h);
      h.ctx.setConfirm(true);
      await h.command(`report export ${join(h.root, 'out')}`);
      const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
      expect(report).toContain('starting label, not a network boundary');
      expect(report).toContain('no host credential channel');
      expect(report).toContain('no inbound path');
      expect(report).toContain('bounded by the depth a chain actually demonstrated');
      expect(report).not.toContain('third-party origins');
      expect(report).not.toContain('not computed from exploit evidence');
    });
  });
});
