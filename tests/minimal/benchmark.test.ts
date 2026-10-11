import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// @ts-ignore - the benchmark harness is plain JavaScript, outside the TypeScript build.
import { BoundedRecords, MAX_RECORDS, RUN_ID_PATTERN, deriveRunId, hasAssessmentStarted, exportDataFrom, main, modelSelection, parseArgs, piModelArgs, p2oStartFlags, readExportFile, runContainerQueryArgs } from '../../scripts/benchmark-skills.mjs';
// @ts-ignore - the benchmark harness is plain JavaScript, outside the TypeScript build.
import { buildPlan, catalogDocuments, copyVariant, discoverFixtures, hashTree, isSharedDocument, mulberry32, objectiveProblems, parseSeed, resolveArms, shuffle, solutionMarkers, supportsStartFlag, ORIGINAL_SKILLS, PLAYBOOK_SET } from '../../bench/lib/plan.mjs';
// @ts-ignore - the benchmark harness is plain JavaScript, outside the TypeScript build.
import { SCORER_LIMITATIONS, authoritativeCandidates, extractTranscript, normalizeEvidenceId, redactSecrets, scoreRun, summarizeScores } from '../../bench/lib/score.mjs';
// @ts-ignore - the benchmark harness is plain JavaScript, outside the TypeScript build.
import { OBJECTIVE_MARKER, SCOPE_MARKER, applyObjectiveHook, objectiveExtensionSource } from '../../bench/lib/objective.mjs';
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

  it('copies exactly the source manifest, excluding real bytecode with an answer-path leak', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-bytecode-'));
    const source = join(root, 'vulnerable');
    const destination = join(root, 'target');
    const answerPath = '/bench/fixtures/object-authorization/fixed/policy.py';
    try {
      await mkdir(join(source, '__pycache__'), { recursive: true });
      await mkdir(join(source, 'nested', '.cache'), { recursive: true });
      await mkdir(join(source, '.git'), { recursive: true });
      await mkdir(join(source, 'expected'), { recursive: true });
      await writeFile(join(source, 'policy.py'), 'allowed = False\n');
      await writeFile(join(source, 'nested', 'helper.py'), 'value = 1\n');
      const pyc = join(source, '__pycache__', 'policy.cpython-313.pyc');
      const compiled = spawnSync('python3', ['-c', 'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], dfile=sys.argv[3], doraise=True)',
        join(source, 'policy.py'), pyc, answerPath], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      expect(compiled.status, compiled.stderr).toBe(0);
      expect((await readFile(pyc)).includes(Buffer.from(answerPath))).toBe(true);
      for (const file of ['orphan.pyc', 'orphan.pyo', '.answer', '.git/config', 'nested/.cache/answer.json', 'expected/truth.json']) {
        await writeFile(join(source, file), answerPath);
      }
      const original = await hashTree(source);
      const copied = await copyVariant(source, destination);
      expect(copied.hash).toBe(original.hash);
      expect(copied.files).toEqual(original.files);
      expect(copied.files.map((file: any) => file.path).sort()).toEqual(['nested/helper.py', 'policy.py']);
      // Do not use hashTree for this walk: it must expose any accidentally copied hidden/cache file.
      const actual: { path: string; sha256: string; bytes: number }[] = [];
      async function walk(directory: string, prefix = '') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = prefix + entry.name;
          if (entry.isDirectory()) await walk(join(directory, entry.name), path + '/');
          else {
            expect(entry.isFile()).toBe(true);
            const bytes = await readFile(join(directory, entry.name));
            expect(bytes.includes(Buffer.from(answerPath))).toBe(false);
            actual.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
          }
        }
      }
      await walk(destination);
      expect(actual.sort((a, b) => a.path.localeCompare(b.path)))
        .toEqual([...copied.files].sort((a: any, b: any) => a.path.localeCompare(b.path)));
      expect(existsSync(join(destination, '__pycache__'))).toBe(false);
      expect(existsSync(join(destination, '.git'))).toBe(false);
      expect(existsSync(join(destination, 'nested', '.cache'))).toBe(false);
      expect((await readFile(pyc)).includes(Buffer.from(answerPath))).toBe(true); // original preserved
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform !== 'win32').each(['file', 'directory', 'root'])('rejects %s symlinks instead of copying or hashing them', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-symlink-'));
    try {
      const source = join(root, 'source');
      const outside = join(root, 'outside');
      await mkdir(source); await mkdir(outside);
      await writeFile(join(outside, 'answer.py'), 'fixed_answer = True\n');
      let selected = source;
      if (kind === 'root') {
        selected = join(root, 'linked-root');
        await symlink(source, selected);
      } else await symlink(kind === 'file' ? join(outside, 'answer.py') : outside, join(source, 'link'));
      await expect(hashTree(selected)).rejects.toThrow(/symlink/i);
      await expect(copyVariant(selected, join(root, 'target'))).rejects.toThrow(/symlink/i);
      expect(existsSync(join(root, 'target'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform !== 'win32')('rejects a special file before copying or reading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-fifo-'));
    try {
      const source = join(root, 'source'); await mkdir(source);
      expect(spawnSync('mkfifo', [join(source, 'pipe')]).status).toBe(0);
      await expect(hashTree(source)).rejects.toThrow(/special file/i);
      await expect(copyVariant(source, join(root, 'target'))).rejects.toThrow(/special file/i);
      expect(existsSync(join(root, 'target'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses overlapping destinations without deleting source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-overlap-'));
    try {
      const source = join(root, 'source'); await mkdir(source);
      await writeFile(join(source, 'code.py'), 'original = True\n');
      for (const destination of [root, source, join(source, 'target'), join(source, '..hidden-copy')]) {
        await expect(copyVariant(source, destination)).rejects.toThrow(/overlap/);
      }
      expect(await readFile(join(source, 'code.py'), 'utf8')).toBe('original = True\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('verify runs in a clean copy with bytecode writing disabled, without changing fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-verify-'));
    const inherited = process.env.PYTHONDONTWRITEBYTECODE;
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const fixture = join(root, 'bench', 'fixtures', 'snapshot-inputs');
      await mkdir(join(fixture, 'expected'), { recursive: true });
      const entry = { expected_findings: [], expected_clean: [], required_gaps: [], forbidden_claims: [] };
      await writeFile(join(fixture, 'expected', 'truth.json'), JSON.stringify({
        schema: 'p2o-bench-truth/1', fixture: 'snapshot-inputs', evaluator_only: true,
        objective: 'Review the supplied synthetic application source and report coverage and any findings with evidence.',
        variants: { vulnerable: entry, fixed: entry },
        probe: { command: 'python3 probe.py', expected_exit: { vulnerable: 0, fixed: 0 } },
      }));
      for (const variant of ['vulnerable', 'fixed']) {
        const source = join(fixture, variant); await mkdir(source);
        await writeFile(join(source, 'policy.py'), 'value = 1\n');
        await writeFile(join(source, 'probe.py'), `import os, pathlib\nassert os.environ['PYTHONDONTWRITEBYTECODE'] == '1'\nassert pathlib.Path.cwd() != pathlib.Path(${JSON.stringify(source)})\nimport policy\nassert policy.value == 1\nassert not list(pathlib.Path('.').rglob('*.pyc'))\n`);
      }
      process.env.PYTHONDONTWRITEBYTECODE = '0'; // verify must override an unsafe inherited setting
      expect(await main(['verify', '--repo', root, '--results', join(root, 'results')])).toBe(0);
      for (const variant of ['vulnerable', 'fixed']) {
        expect((await readdir(join(fixture, variant))).sort()).toEqual(['policy.py', 'probe.py']);
      }
    } finally {
      if (inherited === undefined) delete process.env.PYTHONDONTWRITEBYTECODE;
      else process.env.PYTHONDONTWRITEBYTECODE = inherited;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('runs each executable fixture probe with the expected outcome', async () => {
    const fixtures = await discoverFixtures(repo);
    for (const fixture of fixtures) {
      const probe = fixture.truth.probe;
      if (!probe) continue;
      for (const variant of ['vulnerable', 'fixed'] as const) {
        const workspace = await mkdtemp(join(tmpdir(), 'p2o-bench-probe-'));
        try {
          const target = join(workspace, 'target');
          await copyVariant(join(fixture.dir, variant), target);
          const result = spawnSync(probe.command.split(' ')[0], probe.command.split(' ').slice(1), {
            cwd: target, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          });
          expect(result.status, `${fixture.name}/${variant}: ${result.stderr}`).toBe(probe.expected_exit[variant]);
          for (const needle of probe.expected_failing_cells?.[variant] ?? []) expect(result.stdout).toContain(needle);
          for (const needle of probe.expected_failing_paths?.[variant] ?? []) expect(result.stdout).toContain(needle);
          for (const needle of probe.expected_contexts?.[variant] ?? []) expect(result.stdout).toContain(needle);
        } finally { await rm(workspace, { recursive: true, force: true }); }
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

  it('pins the requested model, provider and xhigh in Pi argv and plan receipts', async () => {
    const selection = ['--model', 'gpt-6.1-sol', '--provider', 'openai-codex-account-3', '--thinking', 'xhigh'];
    const options = parseArgs(['plan', ...selection]);
    expect(modelSelection(options)).toEqual({ model: 'gpt-6.1-sol', provider: 'openai-codex-account-3', thinking: 'xhigh' });
    expect(piModelArgs(options)).toEqual(selection);
    expect(piModelArgs(parseArgs(['plan']))).toEqual(['--model', 'deepseek/deepseek-flash', '--thinking', 'off']);
    expect(() => parseArgs(['plan', '--provider'])).toThrow(/provider/);
    expect(() => parseArgs(['plan', '--provider='])).toThrow(/provider/);
    expect(() => parseArgs(['plan', '--model'])).toThrow(/model/);
    expect(() => parseArgs(['plan', '--thinking', 'typo'])).toThrow(/thinking/);
    const root = await mkdtemp(join(tmpdir(), 'p2o-bench-provider-'));
    try {
      expect(await main(['plan', '--arm', 'C', '--fixture', 'route-inventory', '--reps', '1', '--seed', '7', '--results', root, ...selection])).toBe(0);
      const file = (await readdir(root)).find(name => name.startsWith('plan-'))!;
      const plan = JSON.parse(await readFile(join(root, file), 'utf8'));
      expect(modelSelection(plan)).toEqual(modelSelection(options));
      expect(plan.runCount).toBe(2);
      const source = await readFile(join(repo, 'scripts/benchmark-skills.mjs'), 'utf8');
      expect(source).toContain("'--mode', 'rpc', ...piModelArgs(options)");
      expect(source).toContain('...modelSelection(options), maxMinutes:');
      expect(source).toContain('config: { ...modelSelection(options), ...planBudgets(options)');
    } finally { await rm(root, { recursive: true, force: true }); }
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
      // Arm C is the whole working-tree library, so it grows with every playbook added after the original benchmark (the WSTG playbooks); B stays the original 17.
      const catalogNames = (JSON.parse(await readFile(join(repo, 'skills', 'catalog.json'), 'utf8')).skills as Array<{ name: string }>).map(skill => skill.name).sort();
      expect([...arms.C.skills].sort()).toEqual(catalogNames);
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
        toolResult('p2o_finish', 'Container removal verified. Coverage: order read; Open items: live comparison not tested.'),
        assistantText('Final report: finding order-ownership (offline reproduction, local probe): carol can read order o-1001 in the same tenant because ownership is not checked in can_read_order. Gap: no live authenticated two-account HTTP comparison was possible.'),
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

// Bounded synthetic equivalent of the first installed pilot
// (tmp/skill-upgrade/installed-pilot run C r1: object-authorization/vulnerable). The report text
// and export shape mirror the real run; the arrays are trimmed to keep the test hermetic.
describe('scorer pilot regression', () => {
  const EV1 = '58f3fb23-120b-48d4-9184-f532887c6378';
  const EV2 = 'f882ef9f-a224-498c-aae2-6ae82349cba0';
  const EV3 = '6fd51333-dda2-4c30-bafa-0466937de73e';

  function pilotExport() {
    const evidenceRefs = [EV1, EV2];
    const negativeControls = [EV3];
    return {
      candidates: [
        { candidate: 'bola-read-same-tenant', surface: 'orders.get_order / policy.can_read_order', risk: "Object-level authorization failure: a tenant member can read another user's order (BOLA/IDOR), exposing PII fields shipping_address and total_cents", closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs, negativeControls },
        { candidate: 'bola-write-same-tenant', surface: 'orders.update_order_field / policy.can_update_field', risk: "Object-level authorization failure: a tenant member can modify another user's order, including shipping_address", closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs, negativeControls },
        { candidate: 'cross-tenant-export-param', surface: 'orders.export_orders / policy.can_export_orders', risk: "Tenant isolation bypass: any authenticated caller can export another tenant's orders by naming that tenant", closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs, negativeControls },
      ],
      evidenceIds: [EV1, EV2, EV3],
    };
  }

  const finalReport = [
    '# P2O Assessment Final Report',
    '## Summary',
    'Three object-level authorization (BOLA/IDOR) flaws are confirmed by offline reproduction.',
    '## Findings',
    '### F1 - Same-tenant read (PII disclosure) | Confirmed | offline_reproduction',
    "- Impact: Carol (t-a) reads Alice's o-1001, receiving shipping_address + total_cents.",
    '- Reproduction: python3 probe.py -> same-tenant-foreign-read expected=deny observed=allow FAIL (ev 58f3...). Independent verify prints the full order dict (ev f882...).',
    '- Control expected: order["owner"] == principal_id; policy.py returns only principal["tenant"] == order["tenant"].',
    '### F2 - Same-tenant write | Confirmed | offline_reproduction',
    "- Impact: Carol updates Alice's shipping_address; FIELD_POLICY declares shipping_address: owner but can_update_field returns True.",
    '### F3 - Cross-tenant export | Confirmed | offline_reproduction',
    '- Impact: Alice (t-a) exports t-b, receiving Bob row; can_export_orders only checks the tenant exists.',
    '## Coverage',
    '| AuthN boundary + cross-tenant controls | auth bypass | clean (ev 6fd5...: anonymous / unknown / cross-tenant / non-admin-total all DENY) |',
    '| Injection / deserialization / file / network sinks | RCE, SSRF | clean (grep-based, ev 65f5...) |',
    '## Not covered / could not verify',
    '- HTTP/web, browser, local-lab, OAST: all unavailable per capability snapshot - no live request reproduction possible.',
    '- Live exploitability is not established; this is a synthetic fixture.',
  ].join('\n');

  function pilotMessages() {
    const messages: any[] = [];
    messages.push(assistantText('I will assume the export route is unprotected and probe it.'));
    for (let round = 0; round < 3; round += 1) {
      messages.push({ role: 'assistant', content: [1, 2, 3].map(n => ({ type: 'toolCall', name: 'p2o_candidate', arguments: { candidate: `c-${n}`, closure: 'confirmed' } })) });
      for (let n = 1; n <= 3; n += 1) messages.push(toolResult('p2o_candidate', round === 2 ? JSON.stringify({ id: `rec-${n}`, version: 2, kind: 'candidate' }) : `Error: Unknown same-run evidence ID: control ${n}`));
    }
    messages.push(assistantTool('p2o_shell', { command: 'cd /target && python3 probe.py' }));
    messages.push(toolResult('p2o_shell', [
      'CELL same-tenant-foreign-read expected=deny observed=allow FAIL :: carol reads alice order o-1001',
      'CELL export-other-tenant expected=deny observed=allow FAIL :: alice exports t-b',
      'CELL update-foreign-shipping expected=deny observed=allow FAIL :: carol updates alice shipping_address',
      `Evidence ID: ${EV1}`,
      `Evidence ID: ${EV1}`,
      `Evidence ID: ${EV2}`,
      `Evidence ID: ${EV3}`,
    ].join('\n')));
    messages.push(toolResult('p2o_finish', 'Evidence export: out/.p2o-reports/x.json\nContainer removal verified.'));
    messages.push(assistantText(finalReport));
    return messages;
  }

  function pilotRecords() {
    const records: any[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (let n = 1; n <= 3; n += 1) {
        records.push({ type: 'tool_execution_end', toolName: 'p2o_candidate', isError: round !== 2, result: round === 2 ? { details: { id: `rec-${n}`, data: {} } } : {} });
      }
    }
    records.push({ type: 'tool_execution_end', toolName: 'p2o_shell', isError: false, result: { details: { evidenceId: EV1 } } });
    records.push({ type: 'tool_execution_end', toolName: 'p2o_finish', isError: false, result: { details: { exportPath: 'x/.p2o-reports/x.json' } } });
    records.push({ type: 'agent_settled' });
    return records;
  }

  it('removes the pilot false positives and prefers the export candidate set', async () => {
    const truth = JSON.parse(await readFile(join(fixturePath('object-authorization'), 'expected', 'truth.json'), 'utf8'));
    const extraction = extractTranscript({ messages: pilotMessages(), records: pilotRecords(), stats: { cost: 0.01 } });
    const score = scoreRun({ truth, variant: 'vulnerable', extraction, checks: {}, exportData: pilotExport() });
    expect(score.forbidden.map((item: any) => item.matched)).toEqual([false, false]);
    expect(score.clean.every((item: any) => item.false_positive === false)).toBe(true);
    expect(score.counts.falsePositives).toBe(0);
    expect(score.metrics.recall).toBe(1);
    expect(score.metrics.precision).toBe(1);
    expect(score.metrics.proofAccuracy).toBe(1);
    expect(score.findings.find((finding: any) => finding.id === 'order-ownership').claimed_proof).toBe('offline_reproduction');
    expect(score.findings.find((finding: any) => finding.id === 'export-tenant-scope').claimed_proof).toBe('offline_reproduction');
    expect(score.scope.candidatesSource).toBe('export');
    expect(score.counts.candidatesUsed).toBe(3);
    expect(score.scope.candidateCalls).toBe(9);
    expect(score.scope.candidateCallsRejected).toBe(6);
    expect(score.counts.evidenceRefs).toBe(9);
    expect(score.counts.evidenceRefsLinked).toBe(9);
    expect(score.metrics.evidenceReproducibility).toBe(1);
    expect(score.scope.proofLevels).toEqual({ offline_reproduction: 3 });
    expect(score.validity.runValid).toBe(true);
    expect(score.limitations).toEqual(SCORER_LIMITATIONS);
    expect(score.scorer).toBe('lexical-v2');
  });

  it('uses only the final report for an arm without a durable export', async () => {
    const truth = JSON.parse(await readFile(join(fixturePath('object-authorization'), 'expected', 'truth.json'), 'utf8'));
    const extraction = extractTranscript({
      messages: [
        assistantText('I will assume the export route is unprotected and may be vulnerable; planning to confirm it.'),
        toolResult('p2o_finish', 'Container removal verified.'),
        assistantText('# Final report\nNo confirmed findings in this revision; the tested policy surfaces denied foreign access.'),
      ],
      records: [{ type: 'agent_settled' }],
    });
    const score = scoreRun({ truth, variant: 'vulnerable', extraction, checks: {} });
    expect(score.findings.every((finding: any) => !finding.claimed)).toBe(true);
    expect(score.counts.falsePositives).toBe(0);
    expect(score.metrics.evidenceReproducibility).toBeNull();
    expect(score.scope.candidatesSource).toBe('none');
  });

  it('normalizes Evidence ID prefixes and de-duplicates identifiers', () => {
    expect(normalizeEvidenceId('Evidence ID: 58F3FB23-120B-48D4-9184-F532887C6378')).toBe('58f3fb23-120b-48d4-9184-f532887c6378');
    expect(normalizeEvidenceId('ev:abc-123')).toBe('abc-123');
    const extraction = extractTranscript({
      messages: [toolResult('p2o_shell', `Evidence ID: ${EV1}\nEvidence ID: ${EV1}`), toolResult('p2o_finish', 'Container removal verified.')],
      records: [{ type: 'agent_settled' }],
    });
    expect(extraction.evidenceIds).toEqual([EV1]);
  });

  it('prefers export candidates over successful call records', () => {
    const recordCandidate = { candidate: 'record-one', closure: 'open_proof_gap', evidenceRefs: [] };
    const exportCandidate = { candidate: 'export-one', closure: 'confirmed', evidenceRefs: ['ev-1'] };
    const authoritative = authoritativeCandidates({ candidateDetails: [recordCandidate] }, { candidates: [exportCandidate] });
    expect(authoritative.source).toBe('export');
    expect(authoritative.candidates.map((candidate: any) => candidate.candidate)).toEqual(['export-one']);
    const fallback = authoritativeCandidates({ candidateDetails: [recordCandidate] }, null);
    expect(fallback.source).toBe('records');
    expect(fallback.candidates.map((candidate: any) => candidate.candidate)).toEqual(['record-one']);
  });
});

describe('per-run container cleanup detection', () => {
  it('recognizes modern policy sections, opaque wrappers and legacy briefs without requiring the old kickoff dump', () => {
    const policy = 'P2O ASSESSMENT — lead. Run run-policy. Deadline 2030.';
    const section = { role: 'system', sections: { p2o_assessment: `<p2o_assessment>\n${policy}\n</p2o_assessment>` } };
    expect(hasAssessmentStarted([section, { role: 'user', content: 'Begin the confirmed assessment now.' }])).toBe(true);
    expect(deriveRunId({ messages: [section] })).toEqual({ runId: 'run-policy', source: 'policy-section' });
    expect(hasAssessmentStarted([{ role: 'system', content: `BASE\n${policy}` }])).toBe(true);
    expect(deriveRunId({ messages: [{ role: 'system', content: `BASE\n${policy}` }] })).toEqual({ runId: 'run-policy', source: 'system-prompt' });
    expect(hasAssessmentStarted([{ role: 'user', content: policy }])).toBe(true);
    expect(hasAssessmentStarted([{ role: 'user', content: 'Begin the confirmed assessment now.' }])).toBe(false);
    expect(hasAssessmentStarted([{ role: 'toolResult', content: policy }, { role: 'assistant', content: policy }])).toBe(false);
    expect(hasAssessmentStarted([{ role: 'system', sections: { p2o_assessment: 'P2O FINALIZATION — not active' } }])).toBe(false);
    expect(deriveRunId({ messages: [{ role: 'toolResult', content: policy }] }).runId).toBeNull();
    expect(deriveRunId({ messages: [section], exportData: { runId: 'run-export' } }).source).toBe('export');
  });

  it('derives the run id from the export payload, export filename or P2O brief', () => {
    expect(deriveRunId({ exportData: { runId: 'run-muxr4ct0-idbxyo' } })).toEqual({ runId: 'run-muxr4ct0-idbxyo', source: 'export' });
    expect(deriveRunId({ exportPath: '/x/.p2o-reports/run-muxr4ct0-idbxyo-d7056b9e-7057-422e-ac27-b49efa4d4f6f.json' }))
      .toEqual({ runId: 'run-muxr4ct0-idbxyo', source: 'export-filename' });
    expect(deriveRunId({ messages: [{ role: 'user', content: 'Authorized target (untrusted metadata): "/x". Run run-muxr4ct0-idbxyo. Deadline 2026-01-01T00:00:00.000Z.' }] }))
      .toEqual({ runId: 'run-muxr4ct0-idbxyo', source: 'brief' });
    expect(deriveRunId({ exportData: { runId: 'not a valid id!' }, messages: [] })).toEqual({ runId: null, source: 'unknown' });
    expect(deriveRunId({ exportData: { runId: 'run-export-wins' }, messages: [{ role: 'user', content: 'Run run-brief-loses. ' }] })).toEqual({ runId: 'run-export-wins', source: 'export' });
  });

  it('queries only the run label and rejects invalid ids', () => {
    expect(runContainerQueryArgs('run-muxr4ct0-idbxyo')).toContain('label=pi-p2o.run=run-muxr4ct0-idbxyo');
    expect(runContainerQueryArgs('run-muxr4ct0-idbxyo')[0]).toBe('container');
    expect(() => runContainerQueryArgs('bad id; rm -rf /')).toThrow(/invalid run id/);
    expect(() => runContainerQueryArgs('')).toThrow(/invalid run id/);
    expect(RUN_ID_PATTERN.test('run-muxr4ct0-idbxyo')).toBe(true);
  });

  it('keeps global container snapshots informational and fails only on own-label leaks', async () => {
    const truth = JSON.parse(await readFile(join(fixturePath('object-authorization'), 'expected', 'truth.json'), 'utf8'));
    const extraction = extractTranscript({
      messages: [toolResult('p2o_finish', 'Container removal verified.'), assistantText('Final report: no confirmed findings.')],
      records: [{ type: 'agent_settled' }],
    });
    const clean = scoreRun({ truth, variant: 'fixed', extraction, checks: { globalNewContainers: ['some-concurrent-holdout-container'] } });
    expect(clean.validity.runValid).toBe(true);
    const leaked = scoreRun({ truth, variant: 'fixed', extraction, checks: { leakedContainers: ['p2o-own-leftover'] } });
    expect(leaked.validity.runValid).toBe(false);
  });

  it('runner detects leaks by its own label and keeps global snapshots informational', async () => {
    const runner = await readFile(join(repo, 'scripts/benchmark-skills.mjs'), 'utf8');
    expect(runner).toContain('label=pi-p2o.run=');
    expect(runner).toContain('globalNewContainers');
    expect(runner).toContain('cleanupVerification');
  });
});

describe('objective wrapper (no follow-up runs)', () => {
  const objective = 'Review the synthetic target and report findings. Consult the skill guidance available in this runtime before testing, and record which guidance you used.';

  it('never uses a follow-up RPC command to deliver the objective', async () => {
    const runner = await readFile(join(repo, 'scripts', 'benchmark-skills.mjs'), 'utf8');
    expect(runner).not.toMatch(/\bfollow_up\b/);
    expect(runner).not.toMatch(/\bfollowUp\b/);
    expect(runner).toContain('objectiveExtensionSource');
    expect(runner).toContain('p2o-benchmark-objective.ts');
  });

  it('generates a text-only wrapper with the P2O scope guard', () => {
    const source = objectiveExtensionSource(objective);
    expect(source).toContain('before_agent_start');
    expect(source).toContain(SCOPE_MARKER);
    expect(source).toContain(OBJECTIVE_MARKER);
    expect(source).toContain(JSON.stringify(objective));
    for (const forbidden of ['registerTool', 'registerCommand', 'registerFlag', 'registerProvider', 'sendUserMessage', 'appendEntry', 'setActiveTools', 'follow_up', 'followUp']) {
      expect(source).not.toContain(forbidden);
    }
    expect(applyObjectiveHook('a plain prompt', objective)).toBeUndefined();
    const injected = applyObjectiveHook(`lead text\n\n${SCOPE_MARKER} text`, objective);
    expect(injected?.systemPrompt).toContain(OBJECTIVE_MARKER);
    expect(applyObjectiveHook(injected!.systemPrompt, objective)).toBeUndefined();
  });

  it('appends the objective after the P2O hook in a real Pi process, and only while in scope', async () => {
    const active = await orderingProbe(true);
    expect(active.systemPrompt).toContain(SCOPE_MARKER);
    expect(active.systemPrompt).toContain(OBJECTIVE_MARKER);
    expect(active.systemPrompt.indexOf(SCOPE_MARKER)).toBeLessThan(active.systemPrompt.indexOf(OBJECTIVE_MARKER));
    const inactive = await orderingProbe(false);
    expect(inactive.systemPrompt).not.toContain(OBJECTIVE_MARKER);
  }, 60_000);

  it('places the objective after the real P2O scope hook and cleans up without a follow-up run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-objective-owner-'));
    const capture = join(root, 'system-prompt.jsonl');
    const wrapperPath = join(root, 'wrapper.ts');
    const capturePath = join(root, 'capture.ts');
    await mkdir(join(root, 'repo'));
    await writeFile(join(root, 'repo', 'code.txt'), 'authorized inert source');
    const sandboxLog = join(root, 'sandbox.jsonl');
    await writeFile(wrapperPath, objectiveExtensionSource(objective));
    await writeFile(capturePath, `// @ts-nocheck
import { appendFileSync } from 'node:fs';
export default function (pi) {
  pi.on('before_agent_start', event => {
    appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ systemPrompt: event.systemPrompt }) + '\\n');
  });
}
`);
    const env = {
      ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      P2O_TEST_CONTROL_ROOT: join(root, 'control'), P2O_TEST_SANDBOX_LOG: sandboxLog,
      P2O_TEST_FAKE_HERDR: '1', P2O_TEST_CWD: root, P2O_TEST_PI_BINARY: join(repo, 'node_modules', '.bin', 'pi'),
      P2O_TEST_WORKER_EXT: join(repo, 'tests', 'minimal', 'fixtures', 'worker.ts'),
    } as NodeJS.ProcessEnv;
    const child = spawn(join(repo, 'node_modules', '.bin', 'pi'), ['--no-extensions',
      '-e', join(repo, 'tests', 'minimal', 'fixtures', 'owner.ts'), '-e', wrapperPath, '-e', capturePath,
      '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--no-session', '--no-approve',
      '--mode', 'rpc', '--provider', 'p2o-inert', '--model', 'current-agent', '--thinking', 'off'],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let sequence = 0;
    const pending = new Map<string, (value: any) => void>();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      buffer += text;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === 'response' && record.id && pending.has(record.id)) { pending.get(record.id)!(record); pending.delete(record.id); }
          if (record.type === 'extension_ui_request' && record.method === 'confirm') {
            child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, confirmed: true })}\n`);
          }
        } catch { /* ignore non-JSON noise */ }
      }
    });
    const request = (type: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolvePromise, reject) => {
      const id = `owner-probe-${++sequence}`;
      pending.set(id, resolvePromise);
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`probe timeout ${type}: ${stderr}`)); } }, 20_000);
    });
    try {
      await request('get_state');
      await request('prompt', { message: '/p2o --target ./repo' });
      for (let waited = 0; waited < 150 && !existsSync(capture); waited += 1) await delay(100);
      expect(existsSync(capture), `capture missing; stderr: ${stderr}`).toBe(true);
      const first = JSON.parse((await readFile(capture, 'utf8')).split('\n').filter(Boolean)[0]);
      expect(first.systemPrompt).toContain(SCOPE_MARKER);
      expect(first.systemPrompt).toContain(OBJECTIVE_MARKER);
      expect(first.systemPrompt.indexOf(SCOPE_MARKER)).toBeLessThan(first.systemPrompt.indexOf(OBJECTIVE_MARKER));
      // No follow-up prompt: the only user message is the /p2o command itself.
      const messages = (await request('get_messages')).data?.messages ?? [];
      const userMessages = messages.filter((message: any) => message.role === 'user').map((message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((block: any) => block.text ?? '').join(''));
      expect(userMessages.some((text: string) => text.includes('BENCHMARK OBJECTIVE'))).toBe(false);
      // Orderly shutdown must still verify teardown. InertSandbox journals stop+sweep.
      child.stdin.end();
      await Promise.race([new Promise<void>(resolvePromise => child.once('close', () => resolvePromise())), delay(10_000)]);
      const journal = existsSync(sandboxLog) ? (await readFile(sandboxLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      expect(journal.some((entry: any) => entry.op === 'sweep')).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  async function orderingProbe(scopeActive: boolean): Promise<{ systemPrompt: string }> {
    const root = await mkdtemp(join(tmpdir(), 'p2o-objective-probe-'));
    const capture = join(root, 'system-prompt.jsonl');
    const providerPath = join(root, 'provider.ts');
    const scopePath = join(root, 'scope.ts');
    const wrapperPath = join(root, 'wrapper.ts');
    const capturePath = join(root, 'capture.ts');
    // A local, inert provider: the ordering probe only needs hooks to fire, not a real completion.
    await writeFile(providerPath, `// @ts-nocheck
export default function (pi) {
  pi.registerProvider('bench-inert', {
    baseUrl: 'http://127.0.0.1:1/never', apiKey: 'bench-inert', api: 'openai-completions',
    models: [{ id: 'inert', name: 'inert', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
    streamSimple() { throw new Error('bench-inert stream must not be called'); },
  });
}
`);
    await writeFile(scopePath, scopeActive
      ? `// @ts-nocheck
export default function (pi) {
  pi.on('before_agent_start', event => {
    const current = typeof event?.systemPrompt === 'string' ? event.systemPrompt : '';
    if (current.includes('P2O ASSESSMENT')) return undefined;
    return { systemPrompt: current + '\\n\\nP2O ASSESSMENT - synthetic scope for the wrapper ordering probe.' };
  });
}
`
      : '// @ts-nocheck\nexport default function () {}\n');
    await writeFile(wrapperPath, objectiveExtensionSource(objective));
    await writeFile(capturePath, `// @ts-nocheck
import { appendFileSync } from 'node:fs';
export default function (pi) {
  pi.on('before_agent_start', event => {
    appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ systemPrompt: event.systemPrompt }) + '\\n');
  });
}
`);
    const child = spawn(join(repo, 'node_modules', '.bin', 'pi'), ['--no-extensions',
      '-e', providerPath, '-e', scopePath, '-e', wrapperPath, '-e', capturePath,
      '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--no-session',
      '--mode', 'rpc', '--provider', 'bench-inert', '--model', 'inert', '--thinking', 'off'],
    { cwd: root, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let sequence = 0;
    const pending = new Map<string, (value: any) => void>();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      buffer += text;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === 'response' && record.id && pending.has(record.id)) { pending.get(record.id)!(record); pending.delete(record.id); }
        } catch { /* ignore non-JSON noise */ }
      }
    });
    const request = (type: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolvePromise, reject) => {
      const id = `probe-${++sequence}`;
      pending.set(id, resolvePromise);
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`probe timeout ${type}: ${stderr}`)); } }, 15_000);
    });
    try {
      await request('get_state');
      await request('prompt', { message: 'wrapper ordering probe' });
      for (let waited = 0; waited < 150 && !existsSync(capture); waited += 1) await delay(100);
      expect(existsSync(capture), `capture missing; stderr: ${stderr}`).toBe(true);
      const first = (await readFile(capture, 'utf8')).split('\n').filter(Boolean)[0];
      return JSON.parse(first);
    } finally {
      child.stdin.end();
      await Promise.race([new Promise<void>(resolvePromise => child.once('close', () => resolvePromise())), delay(5000)]);
      child.kill('SIGTERM');
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
});
