#!/usr/bin/env node
// [T8/S3] Pinned identity of the project worker CLI.
//
// The real-worker harness must not accept a wrapper that merely prints "0.85.1": the resolved worker binary
// is the installed `@earendil-works/pi-coding-agent` package's own `bin.pi` file, and its content hash is
// pinned here. `verifyPiCli` resolves the binary, finds the package that owns it, and checks package name,
// version, the package's declared bin entry and the exact CLI bytes.
//
// Single source of truth: `tests/real-worker/run.mjs` and `tests/real-worker/real-worker.test.ts` both
// import this module, so the pin cannot drift between the runner and the test.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
export const PI_VERSION = '0.85.1';
/** SHA-256 of `dist/bundle/cli.js` in the installed pinned package. */
export const PI_CLI_SHA256 = 'e6d7fcf36a239cf3746e67ddf4222081ac01a601b85a3ee688bdfe9c161d754c';

function fail(message) {
  throw new Error(`pinned worker identity check failed: ${message}`);
}

/**
 * Resolve and verify the installed pinned worker CLI.
 * @param {string} piBinary absolute path of the worker binary (usually `node_modules/.bin/pi`)
 * @returns {{ cliPath: string, packageRoot: string, version: string, sha256: string }}
 */
export function verifyPiCli(piBinary) {
  let cliPath;
  try { cliPath = realpathSync(piBinary); }
  catch { fail(`worker binary ${piBinary} could not be resolved`); }
  // Walk up from the resolved CLI to the package.json that declares the pinned package name.
  let packageRoot = dirname(cliPath);
  let manifest;
  for (;;) {
    const candidate = join(packageRoot, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed && parsed.name === PI_PACKAGE) { manifest = parsed; break; }
    } catch { /* keep walking while inside the install tree */ }
    if (packageRoot === dirname(packageRoot) || relative(packageRoot, cliPath).startsWith('..')) fail(`resolved CLI ${cliPath} is not inside an installed ${PI_PACKAGE} package`);
    packageRoot = dirname(packageRoot);
  }
  if (manifest.version !== PI_VERSION) fail(`${PI_PACKAGE} is version ${String(manifest.version)}, expected ${PI_VERSION}`);
  const declared = manifest.bin && typeof manifest.bin === 'object' ? manifest.bin.pi : undefined;
  if (typeof declared !== 'string') fail(`${PI_PACKAGE} declares no \`bin.pi\` entry`);
  const declaredPath = realpathSync(join(packageRoot, declared));
  if (declaredPath !== cliPath) fail(`${piBinary} resolves to ${cliPath}, not the package's own bin.pi (${declaredPath})`);
  const sha256 = createHash('sha256').update(readFileSync(cliPath)).digest('hex');
  if (sha256 !== PI_CLI_SHA256) fail(`CLI content hash ${sha256} does not match the pinned ${PI_CLI_SHA256}`);
  return { cliPath, packageRoot, version: PI_VERSION, sha256 };
}
