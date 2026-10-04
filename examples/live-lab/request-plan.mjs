#!/usr/bin/env node
// Generated-request demo runner (local fixtures only; NO live model call, NO provider credential, NO docker).
//
// Compiles this owned slice with the already provisioned toolchain, runs the scripted-author -> validator ->
// owner-gate -> materialize -> broker demo against a loopback fixture, prints the raw evidence and removes the
// private build. Nothing is installed and no root package file is edited.
//
//   node examples/live-lab/request-plan.mjs
//
// Exit codes: 0 the demo met its acceptance bar; 1 the slice failed to build or run; 2 the demo ran but did
// not meet the bar. The lab-only scripted author and scripted owner approval are labeled in the output; this
// runner never approves any real target.
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSlice, repoRoot } from '../../tests/end-to-end/compile.mjs';

const build = await compileSlice({ entries: ['examples/live-lab/request-plan-main.ts'], label: 'p2o-request-plan' });
try {
  // The interface dispatch imports the pi peer packages; link the provisioned modules next to the build output.
  await symlink(join(repoRoot, 'node_modules'), join(build.out, 'node_modules'), 'dir');
  const main = await import(pathToFileURL(join(build.out, 'examples', 'live-lab', 'request-plan-main.js')).href);
  process.stdout.write('=== generated request demo (local fixtures; no live model, no live target) ===\n');
  const result = await main.runRequestPlanDemo({ log: (line) => process.stdout.write(`${line}\n`) });
  process.stdout.write(`${main.formatRequestPlanDemo(result)}\n`);
  process.exitCode = result.acceptance.ok ? 0 : 2;
  if (!result.acceptance.ok) process.stderr.write(`REQUEST PLAN DEMO DID NOT MEET THE BAR: ${result.acceptance.reasons.join(' | ')}\n`);
} catch (error) {
  process.stderr.write(`REQUEST PLAN DEMO FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await build.cleanup();
}
