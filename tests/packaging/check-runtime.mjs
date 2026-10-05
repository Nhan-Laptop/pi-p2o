#!/usr/bin/env node
/**
 * Doctor: can this pi-p2o tree run bundled first-use?
 *
 * Read-only. No install, build, image pull, model call, consent artifact or target request. Run it after
 * `npm install --include=dev && npm run build` in a git/local copy: Pi installs git sources with
 * `npm install --omit=dev --legacy-peer-deps`, so the compiled runtime is not present until you build it.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const compiled = new URL('../../dist/src/application/onboarding/runtime-prerequisites.js', import.meta.url);
const compiledPath = fileURLToPath(compiled);
if (!existsSync(compiledPath)) {
  console.error(`BUNDLED_RUNTIME_MISSING: the compiled runtime checker is missing: ${compiledPath}`);
  console.error('Fix: run `npm install --include=dev` then `npm run build` in this package and retry.');
  process.exit(1);
}

const { inspectBundledRuntime } = await import(compiled.href);
const inspected = inspectBundledRuntime();
if (!inspected.ok) {
  console.error(`${inspected.code}: ${inspected.message}`);
  for (const missing of inspected.missing) console.error(`  missing: ${missing}`);
  process.exit(1);
}
const { plan } = inspected;
console.log(`runtime OK: ${plan.packageRoot}`);
console.log(`  worker pi: ${plan.piBinary} (${plan.piBinarySource})`);
console.log(`  guardian:  ${plan.guardianPath} (${plan.guardianPathSource})`);
console.log(`  receipts:  ${plan.receiptExtensionPath} (${plan.guardianPathSource})`);
console.log(`  lock:      ${plan.containerLockPath}`);
console.log(`  seccomp:   ${plan.seccompPath}`);
console.log(`  bridge:    ${plan.bridgeExtensionPath}`);
