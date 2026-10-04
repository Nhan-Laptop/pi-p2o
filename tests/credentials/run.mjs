#!/usr/bin/env node
// Offline T2 credential-handling suite.
//
// Compiles only the owned slice (src/runtime, src/policy/targets.ts, src/application/authority.ts,
// src/interface/supervisor-backend.ts and this directory) and runs it with node:test.
// No installation and no external network: every fixture server binds 127.0.0.1 and no non-loopback
// host is contacted. Missing tooling, a compile failure or a test failure all exit nonzero.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const build = await fs.mkdtemp(path.join(os.tmpdir(), "pi-p2o-credentials-build-"));
try {
  const compiler = process.env.TSC ?? path.join(root, "node_modules/typescript/bin/tsc");
  const compilerArgs = ["-p", path.join(root, "tests/credentials/tsconfig.json"), "--outDir", build];
  if (process.env.NODE_TYPES_ROOT) compilerArgs.push("--typeRoots", process.env.NODE_TYPES_ROOT);
  const result = /\.(?:js|cjs|mjs)$/.test(compiler)
    ? spawnSync(process.execPath, [compiler, ...compilerArgs], { stdio: "inherit" })
    : spawnSync(compiler, compilerArgs, { stdio: "inherit" });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    // The build root is an ESM package so every emitted slice resolves as a module.
    await fs.writeFile(path.join(build, "package.json"), '{"type":"module"}\n');
    await fs.copyFile(path.join(root, "src/runtime/package.json"), path.join(build, "src/runtime/package.json"));
    await fs.copyFile(path.join(root, "tests/credentials/package.json"), path.join(build, "tests/credentials/package.json"));
    const tests = (await fs.readdir(path.join(build, "tests/credentials"))).filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join(build, "tests/credentials", name));
    const test = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], { stdio: "inherit", timeout: 300_000 });
    process.exitCode = result.status === 0 ? (test.status ?? 1) : (result.status ?? 1);
  }
} finally {
  await fs.rm(build, { recursive: true, force: true });
}
