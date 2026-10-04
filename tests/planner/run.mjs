#!/usr/bin/env node
// Planner acceptance runner (workstream P2). Runs the planner vitest suite through the provisioned toolchain:
// no installs, no network, no credentials. Exits nonzero when any planner contract, composition-wiring or
// report coverage-gate regression fails.
//
//   node tests/planner/run.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vitest = [join(repo, 'node_modules', 'vitest', 'vitest.mjs'), join(repo, 'node_modules', '.bin', 'vitest')].find(existsSync);
if (!vitest) {
  console.error('PLANNER: FAIL — vitest is not provisioned; this runner installs nothing');
  process.exit(1);
}
const result = spawnSync(process.execPath, [vitest, 'run', 'tests/planner'], { cwd: repo, stdio: 'inherit', timeout: 900_000 });
process.exitCode = result.status ?? 1;
