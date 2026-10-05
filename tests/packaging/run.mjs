#!/usr/bin/env node
/** MODEL-INERT packaging suite: git-install layout, worker-pi precedence and real Pi CLI load/dispatch. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ...process.env };
for (const key of ['P2O_APP_CONFIG', 'P2O_CONTROL_MODULE', 'P2O_PLAN_AUTHOR_MODULE', 'P2O_PI_BINARY', 'P2O_RUNTIME_DIST']) delete env[key];
console.log('PACKAGING (MODEL-INERT): installed-layout prerequisites, worker-pi precedence, real Pi CLI extension load + /p2o dispatch. No model/provider call, no consent artifact, no target request.');
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/packaging/vitest.config.ts', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit', timeout: 600_000 });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
