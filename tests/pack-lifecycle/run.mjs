import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, cp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const build = await mkdtemp(path.join(tmpdir(), 'p2o-pack-lifecycle-build-'));
try {
  const compiler = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tests/pack-lifecycle/tsconfig.json'), '--outDir', build], { cwd: root, stdio: 'inherit' });
  if (compiler.status !== 0) process.exitCode = compiler.status ?? 1;
  else {
    await writeFile(path.join(build, 'package.json'), '{"type":"module"}\n');
    await cp(path.join(root, 'tests/runtime/fixtures'), path.join(build, 'tests/runtime/fixtures'), { recursive: true });
    await chmod(path.join(build, 'tests/runtime/fixtures/fake-pi.mjs'), 0o700);
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', path.join(build, 'tests/pack-lifecycle/lifecycle.test.js')], { cwd: build, stdio: 'inherit', env: process.env, timeout: 120_000 });
    process.exitCode = result.status ?? 1;
  }
} finally { await rm(build, { recursive: true, force: true }); }
