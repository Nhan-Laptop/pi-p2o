import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-ignore - the benchmark harness is plain JavaScript, outside the TypeScript build.
import { BoundedRecords, MAX_RECORDS, main, parseArgs, p2oStartFlags, readExportFile, exportDataFrom } from '../../scripts/benchmark-skills.mjs';
// @ts-ignore - the benchmark harness is plain JavaScript, outside the TypeScript build.
import { buildPlan, catalogDocuments, copyVariant, discoverFixtures, isSharedDocument, mulberry32, objectiveProblems, parseSeed, resolveArms, shuffle, solutionMarkers, supportsStartFlag, ORIGINAL_SKILLS, PLAYBOOK_SET } from '../../bench/lib/plan.mjs';
// @ts-ignore - the benchmark harness is plain JavaScript, outside the TypeScript build.
import { extractTranscript, redactSecrets, scoreRun, summarizeScores } from '../../bench/lib/score.mjs';
import { IMAGE } from '../../src/sandbox.js';

const repo = resolve(import.meta.dirname, '../..');
const fixturePath = (name: string) => join(repo, 'bench', 'fixtures', name);

function assistantText(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function assistantTool(name: string, args: Record<string, unknown>) {
  return { role: 'assistant', content: [{ type: 'toolCall', name, arguments: args }] };
}
function toolResult(toolName: string, text: string) {
  return { role: 'toolResult', toolName, content: [{ type: 'text', text }] };
}

/**
 * Hermetic verification for the opt-in skill benchmark. No model call, no network, no Docker by
 * default: these tests prove the fixtures, evaluator truth, plan randomization and scorer behave
 * before any live run is attempted.
 */
describe('benchmark fixtures', () => {
  it('ships valid vulnerable/fixed pairs with evaluator truth outside the agent source', async () => {
    const fixtures = await discoverFixtures(repo);
    expect(fixtures.map((fixture: any) => fixture.name).sort()).toEqual(['fastapi-parity', 'object-authorization', 'output-context', 'route-inventory']);
    for (const fixture of fixtures) {
      expect(fixture.truth.schema).toBe('p2o-bench-truth/1');
      expect(fixture.truth.evaluator_only).toBe(true);
      expect(fixture.objective.length).toBeGreaterThan(40);
      expect(existsSync(join(fixture.dir, 'expected', 'truth.json'))).toBe(true);
      for (const variant of ['vulnerable', 'fixed'] as const) {
        const tree = fixture.variants[variant];
        expect(tree.files.length).toBeGreaterThan(0);
        for (const file of tree.files) {
          expect(file.path).not.toContain('expected');
          expect(file.path.toLowerCase()).not.toContain('truth');
        }
      }
      const vulnerable = fixture.truth.variants.vulnerable;
      const fixed = fixture.truth.variants.fixed;
      expect(Array.isArray(vulnerable.expected_findings)).toBe(true);
      expect(Array.isArray(fixed.expected_findings)).toBe(true);
      expect(Array.isArray(vulnerable.required_gaps)).toBe(true);
      expect(Array.isArray(fixed.required_gaps)).toBe(true);
      if (fixture.name === 'route-inventory') {
        expect(vulnerable.expected_findings.length).toBeGreaterThan(0);
        expect(fixed.expected_findings.length).toBe(0);
      } else {
        expect(vulnerable.expected_findings.length).toBeGreaterThan(0);
        expect(fixed.expected_findings.length).toBe(0);
      }
    }
  });

  it('copies only the selected source variant and refuses an evaluator truth directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-copy-'));
    try {
      const fixture = (await discoverFixtures(repo)).find((entry: any) => entry.name === 'object-authorization')!;
      const destination = join(root, 'target');
      const tree = await copyVariant(join(fixture.dir, 'vulnerable'), destination);
      expect(existsSync(join(destination, 'probe.py'))).toBe(true);
      expect(existsSync(join(destination, 'policy.py'))).toBe(true);
      expect(existsSync(join(destination, 'expected'))).toBe(false);
      expect(tree.files.some((file: any) => file.path.includes('expected'))).toBe(false);
      await expect(copyVariant(join(fixture.dir, 'expected'), join(root, 'nope'))).rejects.toThrow(/truth/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('runs each executable fixture probe with the expected outcome', async () => {
    const fixtures = await discoverFixtures(repo);
    for (const fixture of fixtures) {
      const probe = fixture.truth.probe;
      if (!probe) continue;
      for (const variant of ['vulnerable', 'fixed'] as const) {
        const result = spawnSync(probe.command.split(' ')[0], probe.command.split(' ').slice(1), {
          cwd: join(fixture.dir, variant), encoding: 'utf8', timeout: 30_000,
        });
        expect(result.status, `${fixture.name}/${variant}: ${result.stderr}`).toBe(probe.expected_exit[variant]);
        for (const needle of probe.expected_failing_cells?.[variant] ?? []) expect(result.stdout).toContain(needle);
        for (const needle of probe.expected_failing_paths?.[variant] ?? []) expect(result.stdout).toContain(needle);
        for (const needle of probe.expected_contexts?.[variant] ?? []) expect(result.stdout).toContain(needle);
      }
    }
  }, 60_000);

  it.skipIf(process.env.P2O_BENCH_DOCKER !== '1')('runs the object-authorization probe inside the pinned P2O sandbox image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-docker-'));
    try {
      const fixture = (await discoverFixtures(repo)).find((entry: any) => entry.name === 'object-authorization')!;
      const target = join(root, 'target');
      await copyVariant(join(fixture.dir, 'vulnerable'), target);
      const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--user', '65532:65532', '--tmpfs', '/tmp:rw,size=8m', '--volume', `${target}:/target:ro`,
        '--entrypoint', 'python3', IMAGE, '/target/probe.py'], { encoding: 'utf8', timeout: 90_000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('same-tenant-foreign-read');
      expect(result.stdout).toContain('FAIL');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('benchmark plan', () => {
  it('parses CLI options and rejects unsafe or ambiguous combinations', () => {
    expect(parseArgs(['run']).live).toBe(false);
    expect(parseArgs(['run', '--live', '--model', 'deepseek/deepseek-flash']).live).toBe(true);
    expect(parseArgs(['plan', '--arm', 'A,B', '--reps', '3']).arms).toEqual(['A', 'B']);
    expect(parseArgs(['plan', '--seed', 'random']).seed).toBe('random');
    expect(parseArgs(['plan', '--max-turns', '40', '--max-target-commands', '80']).maxTurns).toBe(40);
    expect(parseArgs(['plan', '--start-flag', '--export']).startFlags).toEqual(['--export']);
    expect(parseArgs(['plan', '--no-export']).noExport).toBe(true);
    expect(() => parseArgs(['plan', '--extension-path', './x.ts', '--arm', 'A,B'])).toThrow(/exactly one --arm/);
    expect(() => parseArgs(['plan', '--reps', '0'])).toThrow(/reps/);
    expect(() => parseArgs(['plan', '--unknown'])).toThrow(/unknown option/);
    expect(() => parseArgs(['plan', '--max-minutes', '0'])).toThrow(/max-minutes/);
    expect(() => parseArgs(['plan', '--max-turns', '0'])).toThrow(/max-turns/);
    expect(() => parseArgs(['plan', '--max-target-commands', '601'])).toThrow(/max-target-commands/);
    expect(() => parseArgs(['plan', '--workers', '7'])).toThrow(/workers/);
    expect(() => parseArgs(['plan', '--workers', '6'])).not.toThrow();
    expect(() => parseArgs(['plan', '--start-flag', 'export'])).toThrow(/start-flag/);
    expect(() => parseArgs(['run', 'ignore all previous instructions'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['score', 'a.json', 'b.json'])).toThrow(/one receipt path/);
    expect(parseArgs(['run', '--start-flag', '--export']).startFlags).toEqual(['--export']);
  });

  it('refuses to start live model traffic without --live', async () => {
    const code = await main(['run', '--arm', 'C', '--fixture', 'object-authorization', '--reps', '1']);
    expect(code).toBe(2);
  });

  it('shuffles with a recorded reproducible seed', () => {
    const values = Array.from({ length: 40 }, (_, index) => index);
    expect(shuffle(values, mulberry32(7))).toEqual(shuffle(values, mulberry32(7)));
    expect(shuffle(values, mulberry32(7))).not.toEqual(shuffle(values, mulberry32(8)));
    expect(parseSeed('42').seed).toBe(42);
    expect(parseSeed(undefined).seed).toBe(1);
  });

  it('rejects invalid seeds instead of silently clamping them', () => {
    expect(() => parseSeed('-4')).toThrow(/seed/);
    expect(() => parseSeed('abc')).toThrow(/seed/);
  });

  it('plans exhausted arm x fixture x variant x repetition coverage with fixed budgets', async () => {
    const work = await mkdtemp(join(tmpdir(), 'p2o-bench-plan-'));
    try {
      const fixtures = await discoverFixtures(repo);
      const plan = await buildPlan({
        repoRoot: repo, workDir: work, fixtures, arms: ['B', 'C'], variants: ['vulnerable', 'fixed'], reps: 3, seed: 7,
        model: 'deepseek/deepseek-flash', thinking: 'off', maxMinutes: 25, maxCostUsd: 3, delegation: false, workers: 1,
      });
      expect(plan.runCount).toBe(2 * fixtures.length * 2 * 3);
      expect(plan.budgets).toMatchObject({ maxMinutes: 25, maxCostUsd: 3, maxTurns: 60, maxTargetCommands: 120, delegation: false });
      expect(plan.runs.every((run: any) => existsSync(run.truthPath))).toBe(true);
      expect(plan.runs.every((run: any) => existsSync(run.sourceDir))).toBe(true);
      expect(plan.runs.every((run: any) => !run.sourceDir.includes('expected'))).toBe(true);
      const perKey = new Map<string, number>();
      for (const run of plan.runs) perKey.set(`${run.arm}/${run.fixture}/${run.variant}`, (perKey.get(`${run.arm}/${run.fixture}/${run.variant}`) ?? 0) + 1);
      expect([...perKey.values()]).toEqual(Array(2 * fixtures.length * 2).fill(3));
      const sameSeedA = await buildPlan({ repoRoot: repo, workDir: work, fixtures, arms: ['C'], variants: ['vulnerable'], reps: 2, seed: 7 });
      const sameSeedB = await buildPlan({ repoRoot: repo, workDir: work, fixtures, arms: ['C'], variants: ['vulnerable'], reps: 2, seed: 7 });
      expect(sameSeedA.runs.map((run: any) => run.runId)).toEqual(sameSeedB.runs.map((run: any) => run.runId));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not serialize ambient environment values into a plan receipt', async () => {
    const sentinel = 'sentinel-value-not-a-secret';
    process.env.P2O_BENCH_TEST_SENTINEL = sentinel;
    const work = await mkdtemp(join(tmpdir(), 'p2o-bench-env-'));
    try {
      const fixtures = (await discoverFixtures(repo)).filter((fixture: any) => fixture.name === 'object-authorization');
      const plan = await buildPlan({ repoRoot: repo, workDir: work, fixtures, arms: ['C'], variants: ['vulnerable'], reps: 1, seed: 1 });
      expect(JSON.stringify(plan)).not.toContain(sentinel);
    } finally {
      delete process.env.P2O_BENCH_TEST_SENTINEL;
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('resolves arm C with the playbooks and arm B with exactly the original skills', async () => {
    const work = await mkdtemp(join(tmpdir(), 'p2o-bench-arms-'));
    try {
      const arms = await resolveArms(repo, { workDir: work, prepare: true, only: ['B', 'C'] });
      expect(arms.C.skills).toEqual(expect.arrayContaining([...ORIGINAL_SKILLS, ...PLAYBOOK_SET]));
      expect(arms.C.skills).toHaveLength(ORIGINAL_SKILLS.length + PLAYBOOK_SET.length);
      expect(arms.B.skills).toEqual([...ORIGINAL_SKILLS].sort());
      expect(arms.B.hashes.extensionSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(arms.B.hashes.packageHash).toMatch(/^[0-9a-f]{64}$/);
      expect(arms.B.playbooks).toEqual([]);
      // Durable-export start flag: never on the baseline, present when the package supports it.
      expect(arms.B.startFlags).toContain('--export');
      expect(arms.C.startFlags).toContain('--export');
      expect(p2oStartFlags(arms.B, { noExport: true })).toEqual([]);
      expect(p2oStartFlags(arms.B, { startFlags: ['--custom'] })).toEqual(['--custom']);
      const catalog = JSON.parse(await readFile(join(arms.B.packageRoot, 'skills', 'catalog.json'), 'utf8'));
      expect(catalog.version).toBe(1);
      expect(catalog.skills).toHaveLength(ORIGINAL_SKILLS.length);
      expect(catalog.skills.some((skill: any) => PLAYBOOK_SET.includes(skill.name))).toBe(false);
      const ids = catalog.documents.map((document: any) => document.id);
      expect(ids.some((id: string) => id.startsWith('evidence:'))).toBe(true);
      expect(ids).toContain('source-code-auditing:offline-python-semgrep');
      expect(ids).toContain('source-code-auditing:offline-python-semgrep-rules');
      expect(ids).not.toContain('web-object-authorization');
      for (const document of catalog.documents) {
        expect(existsSync(join(arms.B.packageRoot, document.path)), document.path).toBe(true);
      }
      if (existsSync(join(repo, 'bench', '.arms', 'baseline-4321f2b', 'extensions', 'p2o', 'index.ts'))) {
        const baseline = await resolveArms(repo, { workDir: work, prepare: false, only: ['A'] });
        expect(baseline.A.startFlags).toEqual([]);
        expect(supportsStartFlag(baseline.A.packageRoot, baseline.A.extensionPath, '--export')).toBe(false);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not read credential stores or print environment values from the harness sources', async () => {
    const sources = await Promise.all([
      readFile(join(repo, 'scripts/benchmark-skills.mjs'), 'utf8'),
      readFile(join(repo, 'bench/lib/plan.mjs'), 'utf8'),
      readFile(join(repo, 'bench/lib/score.mjs'), 'utf8'),
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(/auth\.json|print-api-key|print-bearer|credentials\.json|\.pi\/agent\/auth/);
      expect(source).not.toMatch(/JSON\.stringify\(\s*process\.env\b/);
      expect(source).not.toMatch(/console\.(log|error)\([^)]*process\.env/);
    }
    expect(redactSecrets('api key sk-abcdefghijklmnopqrstuvwxyz012345 stays')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(redactSecrets('password=hunter2hunter2')).not.toContain('hunter2hunter2');
  });
});

describe('benchmark scorer', () => {
  it('scores a supported offline finding with its gap and no overclaim', async () => {
    const truth = JSON.parse(await readFile(join(fixturePath('object-authorization'), 'expected', 'truth.json'), 'utf8'));
    const extraction = extractTranscript({
      messages: [
        assistantTool('p2o_shell', { command: 'cd /target && python3 probe.py' }),
        toolResult('p2o_shell', 'CELL same-tenant-foreign-read expected=deny observed=allow FAIL :: carol reads alice order o-1001'),
        assistantText('Finding order-ownership (offline reproduction, local probe): carol can read order o-1001 in the same tenant because ownership is not checked in can_read_order. Gap: no live authenticated two-account HTTP comparison was possible.'),
        toolResult('p2o_finish', 'Container removal verified. Coverage: order read; Open items: live comparison not tested.'),
        assistantText('Final report: order-ownership reproduced offline; live authenticated comparison was not performed.'),
      ],
      stats: { cost: 0.12, tokens: { total: 1200 }, assistantMessages: 2 },
      records: [{ type: 'agent_settled' }],
    });
    const score = scoreRun({ truth, variant: 'vulnerable', extraction, checks: {} });
    const finding = score.findings.find((entry: any) => entry.id === 'order-ownership')!;
    expect(finding.claimed).toBe(true);
    expect(finding.supported).toBe(true);
    expect(finding.overclaim).toBe(false);
    expect(score.metrics.recall).toBeGreaterThan(0);
    expect(score.metrics.proofAccuracy).toBeGreaterThan(0);
    expect(score.metrics.gapHonesty).toBe(1);
    expect(score.validity.runValid).toBe(true);
    expect(score.validity.cleanupVerified).toBe(true);
  });

  it('flags a live-reproduction overclaim when only an offline probe ran', async () => {
    const truth = JSON.parse(await readFile(join(fixturePath('object-authorization'), 'expected', 'truth.json'), 'utf8'));
    const extraction = extractTranscript({
      messages: [
        toolResult('p2o_shell', 'CELL same-tenant-foreign-read expected=deny observed=allow FAIL'),
        assistantText('Finding order-ownership confirmed: carol can read order o-1001 and ownership is not checked. Live reproduction against the running service reproduced it.'),
        toolResult('p2o_finish', 'Container removal verified.'),
      ],
      records: [{ type: 'agent_settled' }],
    });
    const score = scoreRun({ truth, variant: 'vulnerable', extraction, checks: {} });
    expect(score.counts.overclaims).toBeGreaterThan(0);
    expect(score.metrics.proofAccuracy).toBeLessThan(1);
  });

  it('counts a forbidden browser-execution claim as a false positive', async () => {
    const truth = JSON.parse(await readFile(join(fixturePath('output-context'), 'expected', 'truth.json'), 'utf8'));
    const extraction = extractTranscript({
      messages: [
        assistantText('Finding search-html-raw-reflection: raw unescaped HTML text context. XSS confirmed and executed in a browser.'),
        toolResult('p2o_finish', 'Container removal verified.'),
      ],
      records: [{ type: 'agent_settled' }],
    });
    const score = scoreRun({ truth, variant: 'vulnerable', extraction, checks: {} });
    expect(score.counts.falsePositives).toBeGreaterThan(0);
    expect(score.counts.overclaims).toBeGreaterThan(0);
  });

  it('treats a fixed-fixture vulnerability claim as a false positive and marks an unfinished run invalid', async () => {
    const truth = JSON.parse(await readFile(join(fixturePath('object-authorization'), 'expected', 'truth.json'), 'utf8'));
    const extraction = extractTranscript({
      messages: [
        assistantText('Finding: carol can still read o-1001 and the ownership check is denied but bypassed; confirmed vulnerable.'),
      ],
      records: [],
    });
    const score = scoreRun({ truth, variant: 'fixed', extraction, checks: {} });
    expect(score.counts.falsePositives).toBeGreaterThan(0);
    expect(score.validity.finishSeen).toBe(false);
    expect(score.validity.runValid).toBe(false);
  });

  it('aggregates per-arm distributions without significance claims', async () => {
    const summary = summarizeScores([
      { arm: 'B', outcome: 'finished', metrics: { recall: 1, precision: 1, proofAccuracy: 1, gapHonesty: 1, evidenceReproducibility: 1 }, counts: { falsePositives: 0, overclaims: 0 }, scope: { targetCommands: 4, turns: 5 }, validity: { runValid: true }, wallMs: 1000, costUsd: 0.1, usage: { costAvailable: true } },
      { arm: 'B', outcome: 'turn_budget', metrics: { recall: 0, precision: 0.5, proofAccuracy: 0.5, gapHonesty: 0, evidenceReproducibility: 0 }, counts: { falsePositives: 1, overclaims: 1 }, scope: { targetCommands: 8, turns: 12 }, validity: { runValid: false }, wallMs: 2000, costUsd: null, usage: { costAvailable: false } },
    ]);
    expect(summary).toHaveLength(1);
    expect(summary[0].runs).toBe(2);
    expect(summary[0].valid).toBe(1);
    expect(summary[0].recall.median).toBe(0.5);
    expect(summary[0].outcomes['turn_budget']).toBe(1);
    expect(summary[0].costAvailableRuns).toBe(1);
  });
});

describe('benchmark safety refinements', () => {
  it('keeps every objective neutral: no solution markers or mechanism terms', async () => {
    const fixtures = await discoverFixtures(repo);
    for (const fixture of fixtures) {
      expect(objectiveProblems(fixture.objective, fixture.truth), fixture.name).toEqual([]);
      expect(solutionMarkers(fixture.truth).length).toBeGreaterThan(0);
    }
    const fixture = fixtures.find((entry: any) => entry.name === 'route-inventory')!;
    const marker = solutionMarkers(fixture.truth).find((value: string) => value.includes('/admin'))!;
    expect(objectiveProblems(`Report the ${marker} finding and the bypass to it`, fixture.truth).length).toBeGreaterThan(0);
    expect(objectiveProblems('Look for catch-all behaviour in the routing definition', fixture.truth).length).toBeGreaterThan(0);
  });

  it('normalizes legacy arrays and new dictionaries in the catalog sidecar', () => {
    expect(catalogDocuments({ documents: [{ id: 'a', path: 'skills/a/SKILL.md' }] })).toEqual([{ id: 'a', path: 'skills/a/SKILL.md' }]);
    expect(catalogDocuments({ documents: { a: { file: 'skills/a/SKILL.md' }, b: 'skills/b/SKILL.md' } })).toEqual([
      { id: 'a', path: 'skills/a/SKILL.md' },
      { id: 'b', path: 'skills/b/SKILL.md' },
    ]);
    expect(catalogDocuments({ documents: [{ id: 'a', path: 'skills/a/SKILL.md', section: 'start' }] })[0].section).toBe('start');
    expect(isSharedDocument('evidence:b001')).toBe(true);
    expect(isSharedDocument('shared:handoffs')).toBe(true);
    expect(isSharedDocument('web-output-context')).toBe(false);
  });

  it('bounds raw RPC memory while keeping exact counters and tool details', () => {
    const store = new BoundedRecords({ maxRecords: 10, maxBytes: 1_000_000 });
    for (let index = 0; index < 50; index += 1) store.push({ type: index % 5 === 0 ? 'turn_end' : 'message_end', message: { role: 'assistant' } });
    store.push({ type: 'agent_settled' });
    store.push({ type: 'tool_execution_start', toolName: 'p2o_shell' });
    store.push({ type: 'tool_execution_start', toolName: 'p2o_http' });
    store.push({ type: 'extension_error', error: 'boom' });
    store.push({ type: 'tool_execution_end', toolName: 'p2o_finish', result: { details: { exportPath: '/workspace/.p2o-reports/x.json', evidenceId: 'abc-123' } } });
    expect(MAX_RECORDS).toBeGreaterThan(1000);
    expect(store.stored.length).toBeLessThanOrEqual(10);
    expect(store.summary.recordsSeen).toBe(55);
    expect(store.summary.recordsDropped).toBeGreaterThan(0);
    expect(store.summary.logTruncated).toBe(true);
    expect(store.summary.turns).toBe(10);
    expect(store.summary.targetCommands).toBe(2);
    expect(store.summary.settled).toBe(true);
    expect(store.summary.extensionErrors).toHaveLength(1);
    expect(store.summary.evidenceIds).toContain('abc-123');
    expect(store.summary.toolDetails.some((entry: any) => entry.toolName === 'p2o_finish')).toBe(true);
    const extraction = extractTranscript({ messages: [], records: store.stored, recordSummary: store.summary });
    expect(extraction.settled).toBe(true);
    expect(extraction.finishDetails?.exportPath).toBe('/workspace/.p2o-reports/x.json');
    expect(extraction.counts.targetCommands).toBe(2);
    expect(extraction.counts.turns).toBe(10);
    expect(extraction.evidenceIds).toContain('abc-123');
    expect(extraction.extensionErrors).toHaveLength(1);
  });

  it('reads the finish export only from inside the run workspace, with size and file checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-export-'));
    try {
      const workspace = join(root, 'ws');
      await mkdir(join(workspace, '.p2o-reports'), { recursive: true });
      const file = join(workspace, '.p2o-reports', 'run-1.json');
      await writeFile(file, JSON.stringify({ version: 2, records: [] }));
      const captured = await readExportFile({ exportPath: file, workspaceDir: workspace });
      expect(captured.bytes).toBeGreaterThan(0);
      expect(captured.sha256).toMatch(/^[0-9a-f]{64}$/);
      const outside = join(root, 'outside.json');
      await writeFile(outside, '{}');
      await expect(readExportFile({ exportPath: outside, workspaceDir: workspace })).rejects.toThrow(/outside/);
      await expect(readExportFile({ exportPath: join(workspace, '.p2o-reports'), workspaceDir: workspace })).rejects.toThrow(/regular file/);
      await expect(readExportFile({ exportPath: file, workspaceDir: workspace, maxBytes: 1 })).rejects.toThrow(/exceeds/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scores candidate and proof references from the durable export', async () => {
    const truth = JSON.parse(await readFile(join(fixturePath('object-authorization'), 'expected', 'truth.json'), 'utf8'));
    const exportData = exportDataFrom({
      version: 2, runId: 'r1', records: [
        { id: 'ev-1', kind: 'evidence', text: 'probe output' },
        { id: 'c-1', kind: 'candidate', data: { candidate: 'order-ownership', closure: 'confirmed', proof: 'offline_reproduction', evidenceRefs: ['ev-1'], negativeControls: ['ev-missing'] } },
      ],
    });
    expect(exportData.candidates).toHaveLength(1);
    expect(exportData.evidenceIds).toEqual(['ev-1']);
    const extraction = extractTranscript({
      messages: [
        assistantText('Finding order-ownership: carol can read order o-1001 in the same tenant; ownership is not checked (offline reproduction). Gap: no live authenticated comparison was possible.'),
        toolResult('p2o_finish', 'Container removal verified.'),
      ],
      records: [{ type: 'agent_settled' }],
    });
    const score = scoreRun({ truth, variant: 'vulnerable', extraction, checks: {}, exportData });
    expect(score.counts.evidenceRefs).toBe(2);
    expect(score.counts.evidenceRefsLinked).toBe(1);
    expect(score.metrics.evidenceReproducibility).toBe(0.5);
    expect(score.scope.proofLevels.offline_reproduction).toBe(1);
    expect(score.scope.exportEvidence).toBe(1);
    expect(score.validity.runValid).toBe(true);
  });
});
