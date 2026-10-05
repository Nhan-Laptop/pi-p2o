#!/usr/bin/env node
// Exact reviewer repros, offline: inert runtimes and loopback gateway only; no installation/provider calls.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compilerPath, nodeTypeRoots, repoRoot } from '../end-to-end/compile.mjs';

const build = await mkdtemp('/tmp/p2o-review-repros-');
try {
  const source = join(build, 'source'), out = join(build, 'out');
  await mkdir(source);
  for (const dir of ['src', 'tests/orchestrator', 'tests/real-worker']) {
    await cp(join(repoRoot, dir), join(source, dir), { recursive: true });
  }
  await symlink(join(repoRoot, 'node_modules'), join(source, 'node_modules'), 'dir');
  const entries = ['tests/orchestrator/no-progress.test.ts', 'tests/orchestrator/packet-authoring.test.ts', 'tests/real-worker/spend-gate.test.ts'];
  const compile = spawnSync(compilerPath(), [
    '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler', '--strict',
    '--noUnusedLocals', '--noUnusedParameters', '--skipLibCheck', '--types', 'node',
    '--typeRoots', nodeTypeRoots(), '--rootDir', source, '--outDir', out,
    ...entries.map(path => join(source, path)),
  ], { cwd: source, stdio: 'inherit' });
  if (compile.status !== 0) process.exitCode = compile.status ?? 1;
  else {
    await writeFile(join(out, 'package.json'), '{"type":"module"}\n');
    const result = spawnSync(process.execPath, [
      '--test', '--test-concurrency=1', '--test-name-pattern=review repro:|actual wire admission is mandatory|informational measured input above JSON estimate|controller authoring clock|durable rejected submissions|authenticated malformed|identical retries|concurrent schema|valid gate acceptance',
      ...entries.map(path => join(out, path.replace(/\.ts$/, '.js'))),
    ], { cwd: out, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
} finally { await rm(build, { recursive: true, force: true }); }
