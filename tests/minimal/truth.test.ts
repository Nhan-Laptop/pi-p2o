import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { plannerInstructions, workerBrief, workerInstructions, type PlannerPromptFacts } from '../../src/prompts.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { candidateParameters, noteParameters, reportParameters, taskDraftSchema } from '../../src/tool-schemas.js';
import { AUTHORIZATION_TRUTH, BROWSER_TRUTH, CREDENTIAL_TRUTH, HTTP_TRUTH, NETWORK_TRUTH, RISK_LABEL_TRUTH, SANDBOX_TRUTH } from '../../src/truth.js';
import { createFakePi, EXTENSION_PATH } from './helpers/fake-pi.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P7.0 (A7.10) — "Semantics truth pass".
 *
 * The extension's capability text is a behavioural input: the measured run invented a read-only risk limit out of an
 * undefined field, and the shipped strings undersold what the sandbox can do (origin scoping, "no raw sockets", a
 * non-root user) while claiming a credential channel the host does not provide. This suite pins the replacement:
 *
 *  1. the system prompts and the input schemas compose the same fact module (`src/truth.ts`), and the execution tool
 *     descriptions do not repeat a fact a prompt already states (A1 dedupe, owner decision 2026-10-28),
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
  // P11/A11: the two capabilities the measured run called missing were in the image all along. Retiring the sentences keeps a
  // later edit from re-introducing the wall that made the planner stop and ask a human for a POST, a host and an account.
  'There is no browser',
  'no browser oracle',
  'operator-supplied identities',
  'proof stops at offline reproduction',
  'requires operator-supplied credentials',
  // P8.2 truth half: the citation fetch is host-side under Part XI. The stale P14.8 comment claimed it ran inside the
  // caller's own sandbox, and the worker loadout line called it capped; both statements were false. R0/D-R1-4 later bounded
  // the host-side fetcher (15 s, 4 MiB, ≤5 redirects), which is a fetch bound, not the retired sandbox-cap claim.
  "runs inside the caller's own sandbox",
  'capped citation fetch',
  // A17.9 runtime truth: the measured container is root on a writable rootfs with Docker's default 14-capability set.
  // These are the claims the stale runtime tests and setup text carried; they must not return to shipped prose.
  'read-only root filesystem',
  'non-root container',
  'capabilities dropped',
  // P18/A9/D47: a round is a bounded work package now, so no shipped sentence may claim the loop runs without a round budget
  // or has a spendable round allowance; the campaign is the only unbounded scope.
  'no round budget',
  'round allowance exhausted',
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
  delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, phase: 'active', executorMode: 'shared', ...overrides,
});
const ticket = (role: string) => ({ workerId: 'worker-1', role, depth: 1, parentWorkerId: null, target: { kind: 'directory', label: '/fixture' }, executorMode: 'shared' } as never);

describe('P7.0 truth pass', () => {
  it('states each instrument fact once in the fact module', () => {
    for (const [name, fact] of Object.entries({ SANDBOX_TRUTH, NETWORK_TRUTH, HTTP_TRUTH, CREDENTIAL_TRUTH, RISK_LABEL_TRUTH, AUTHORIZATION_TRUTH, BROWSER_TRUTH })) {
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
    expect(AUTHORIZATION_TRUTH).toContain('blanket');
    expect(AUTHORIZATION_TRUTH).toContain('no per-action consent');
    expect(BROWSER_TRUTH).toContain('agent-browser');
    expect(BROWSER_TRUTH).toContain('/usr/bin/chromium');
    expect(BROWSER_TRUTH).toContain('no install step');
    expect(CREDENTIAL_TRUTH).toContain('self-provisioned');
  });

  it('keeps the execution tool descriptions free of facts the prompts already state (A1)', () => {
    const tools = registrations();
    const shell = tools.get('p2o_shell')!.description as string;
    const net = tools.get('p2o_net')!.description as string;
    const http = tools.get('p2o_http')!.description as string;
    // A1: SANDBOX_TRUTH is the one fact no worker prompt states, so the shell keeps it.
    expect(shell).toContain(SANDBOX_TRUTH);
    // The worker prompt carries these facts once. Repeating them on the tool descriptions made one worker context read the
    // same capability text up to three times, so the execution tools no longer compose them.
    for (const fact of [NETWORK_TRUTH, BROWSER_TRUTH]) {
      expect(shell, 'p2o_shell must not repeat a prompt fact').not.toContain(fact);
      expect(net, 'p2o_net must not repeat a prompt fact').not.toContain(fact);
    }
    for (const fact of [HTTP_TRUTH, CREDENTIAL_TRUTH]) expect(http, 'p2o_http must not repeat a prompt fact').not.toContain(fact);
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
    // P11/A11 + A17.0: blanket authorization is a fact on every surface. The full constant is composed into the planner; the
    // worker prompt and the brief carry the operative short form instead (the verbose constant was one of three copies inside
    // one worker context before the A17.0 pay-down), so this pin checks the behaviour, not the identity of a constant.
    expect(planner).toContain(AUTHORIZATION_TRUTH);
    expect(planner).toContain(BROWSER_TRUTH);
    const worker = workerInstructions(ticket('recon'));
    expect(worker).toContain(CREDENTIAL_TRUTH);
    expect(worker).toContain('Authorization is blanket for the whole run: no per-action consent exists');
    expect(worker).toContain(BROWSER_TRUTH);
    expect(worker).toContain('there is no per-action consent to request');
    expect(worker).not.toContain('operator-supplied');
    // The brief a worker actually receives restates the authorization and refuses to describe the label as a boundary.
    const brief = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't' });
    expect(brief).toContain('AUTHORIZATION: blanket for the whole run');
    expect(brief).toContain('starting label, not a boundary');
    expect(brief).toContain('no command, elapsed-time or per-action-permission ceiling');
    expect(TOOL_BOUNDARIES.p2o_http.join(' ')).toContain('starting label');
    expect(TOOL_BOUNDARIES.p2o_http.join(' ')).not.toContain('origin');
  });

  it('states the citation fetch as R0 keeps it: host-side, bounded, and never the caller\'s own sandbox (R0/D-R1-4)', () => {
    const research = registrations().get('p2o_research')!.description as string;
    const worker = workerInstructions(ticket('recon'));
    // R0/D-R1-4: the target is a label, not an egress boundary; the citation fetch is host-side but bounded (15 s timeout,
    // 4 MiB body cap, ≤5 redirects, public destinations only). The retired-claims test above pins the old false statements.
    expect(research).toContain('host-side');
    expect(research.toLowerCase()).toContain('15 s');
    expect(research.toLowerCase()).toContain('4 mib');
    expect(research.toLowerCase()).toContain('redirect');
    expect(research.toLowerCase()).not.toContain('no size cap');
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
      // P11/A11: the report describes the browser transport that ran instead of the old "there is no browser" ceiling.
      expect(report).toContain('Chromium');
      expect(report).toContain('agent-browser');
      expect(report).not.toContain('There is no browser');
      expect(report).toContain('bounded by the depth a chain actually demonstrated');
      expect(report).not.toContain('third-party origins');
      expect(report).not.toContain('not computed from exploit evidence');
    });
  });
});

describe('P11/A11 autonomy facts', () => {
  it('states blanket authorization, the installed browser and a self-provisioned identity in the prompts (not again on the tool descriptions)', () => {
    const planner = plannerInstructions(plannerFacts());
    const worker = workerInstructions(ticket('recon'));
    const brief = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't' });
    const shell = registrations().get('p2o_shell')!.description as string;
    // A17.0/A1: the planner holds the full truth text; the worker prompt and the brief hold the operative short form, and the
    // execution tool descriptions no longer repeat either (the worker context used to read the same fact up to three times).
    expect(planner).toContain(AUTHORIZATION_TRUTH);
    for (const [name, text] of [['worker', worker], ['brief', brief]] as const) {
      expect(text.toLowerCase(), name).toContain('blanket for the whole run');
      // A wall is a refusal, never a capability the sandbox already has.
      expect(text.toLowerCase(), name).not.toContain('ask the operator for permission');
    }
    expect(worker).toContain(BROWSER_TRUTH);
    expect(shell).not.toContain(BROWSER_TRUTH);
    expect(CREDENTIAL_TRUTH).toContain('self-provisioned');
    // The measured run's three questions are answered as work items, not as prerequisites a human must grant.
    expect(worker).toContain('missing credential, account or browser');
    expect(brief).toContain('no command, elapsed-time or per-action-permission ceiling');
  });
});
