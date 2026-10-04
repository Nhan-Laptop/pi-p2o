import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilerPath, nodeTypeRoots, repoRoot } from '../end-to-end/compile.mjs';
const build = await mkdtemp(join(tmpdir(), 'p2o-model-budget-'));
try {
  const compile = spawnSync(compilerPath(), ['--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler', '--strict', '--noUnusedLocals', '--noUnusedParameters', '--skipLibCheck', '--types', 'node', '--typeRoots', nodeTypeRoots(), '--rootDir', repoRoot, '--outDir', build, join(repoRoot, 'tests/model-budget/model-budget.node.ts')], { cwd: repoRoot, stdio: 'inherit' });
  if (compile.status !== 0) throw new Error('Model budget slice compilation failed');
  await writeFile(join(build, 'package.json'), '{"type":"module"}\n');
  const result = spawnSync(process.execPath, ['--test', join(build, 'tests/model-budget/model-budget.node.js')], { stdio: 'inherit', timeout: 120_000 });
  process.exitCode = result.status ?? 1;
} finally { await rm(build, { recursive: true, force: true }); }
