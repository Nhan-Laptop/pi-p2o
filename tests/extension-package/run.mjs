#!/usr/bin/env node
// Load shipped source without workspace dependencies, using Pi's actual extension loader.
// No model calls, package installs, target traffic, or global settings changes.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Override to test the installed host as well as the repository's pinned worker SDK.
const hostRoot = process.env.P2O_TEST_HOST_ROOT
  ? resolve(process.env.P2O_TEST_HOST_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..');
const host = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'));
const root = await mkdtemp(join(tmpdir(), 'p2o-clean-extension-'));
try {
  for (const name of ['package.json', 'src', 'extensions']) {
    await cp(join(repo, name), join(root, name), { recursive: true });
  }
  // The test must not accidentally resolve a physical host-provided dependency.
  const cleanRequire = createRequire(join(root, 'package.json'));
  for (const specifier of ['typebox', 'typebox/schema', '@earendil-works/pi-ai']) {
    assert.throws(() => cleanRequire.resolve(specifier), { code: 'MODULE_NOT_FOUND' },
      `Clean package must not inherit ${specifier} from an ancestor node_modules`);
  }
  const { loadExtensions } = await import(pathToFileURL(join(hostRoot, 'dist/core/extensions/loader.js')).href);
  const result = await loadExtensions([join(root, 'extensions/p2o/index.ts')], root);
  assert.deepEqual(result.errors, [], 'Source package must load using only the Pi host module aliases');
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.ok(extension.commands.has('p2o'), 'Unified /p2o command must be registered');
  assert.ok(extension.tools.has('p2o_status'), 'Control-plane tools must be registered');
  console.log(`CLEAN_EXTENSION_LOAD_OK Pi ${host.version}: /p2o and p2o_status registered without node_modules`);
} finally {
  await rm(root, { recursive: true, force: true });
}
