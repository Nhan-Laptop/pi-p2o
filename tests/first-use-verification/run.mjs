#!/usr/bin/env node
/** MODEL-INERT first-use verification suite runner. No paid/live provider, no repo script, no image pull. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ...process.env };
for (const key of ['P2O_CONTROL_MODULE', 'P2O_APP_CONFIG', 'P2O_PLAN_AUTHOR_MODULE']) delete env[key];
console.log('FIRST-USE VERIFICATION (MODEL-INERT): real registerP2O/bundled backend/native Pi API/worker/broker/Docker + real verifier replay. NOT live AI/provider or a hostile-code claim.');
// The pinned compiled guardian/receipt extension must be current. No install, image pull/build or re-pin.
for (const args of [
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/first-use-verification/vitest.config.ts', ...process.argv.slice(2)],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', timeout: 900000 });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
