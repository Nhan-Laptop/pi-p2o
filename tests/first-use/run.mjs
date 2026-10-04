#!/usr/bin/env node
/** MODEL-INERT mechanical suite only. No paid/live provider, production fallback or public GitHub smoke. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ...process.env };
for (const key of ['P2O_CONTROL_MODULE', 'P2O_APP_CONFIG', 'P2O_PLAN_AUTHOR_MODULE']) delete env[key];
console.log('FIRST-USE MODEL-INERT mechanics: real registerP2O/bundled backend/native Pi API/worker/broker/Docker. NOT live AI/provider/GitHub or independent-verifier qualification.');
// The pinned compiled guardian/receipt extension must be current. No package install, image pull/build or re-pin.
for (const args of [['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/first-use/vitest.config.ts', ...process.argv.slice(2)]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', timeout: 300000 });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
