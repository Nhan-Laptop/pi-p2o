import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const build = await fs.mkdtemp(path.join(os.tmpdir(), "pi-p2o-runtime-build-"));
try {
  const compilerArgs = ["-p", path.join(root, "tests/runtime/tsconfig.json"), "--outDir", build];
  if (process.env.NODE_TYPES_ROOT) compilerArgs.push("--typeRoots", process.env.NODE_TYPES_ROOT);
  const compiler = spawnSync(process.env.TSC ?? "tsc", compilerArgs, { stdio: "inherit" });
  if (compiler.status !== 0) process.exitCode = compiler.status ?? 1;
  else {
    // [T12] The spend ledger (`src/policy`) is imported directly by the runtime tests, so the build root
    // needs one module marker covering it: the per-directory markers copied below do not cover `src/policy`.
    await fs.writeFile(path.join(build, "package.json"), '{"type":"module"}\n');
    for (const file of ["src/runtime/package.json", "tests/runtime/package.json"]) await fs.copyFile(path.join(root, file), path.join(build, file));
    await fs.cp(path.join(root, "tests/runtime/fixtures"), path.join(build, "tests/runtime/fixtures"), { recursive: true });
    await fs.chmod(path.join(build, "tests/runtime/fixtures/fake-pi.mjs"), 0o700);
    // Two files, one suite: the managed-runtime suite and the B4 pack-lifetime suite (session release on
    // every termination path, idempotency, fencing and restart sweep). `P2O_TEST_RUNTIME_SUITE` narrows the
    // run to one of them for iteration; the default is the whole suite.
    const suites = ["runtime", "sessions", "registry"];
    const selected = process.env.P2O_TEST_RUNTIME_SUITE;
    if (selected && !suites.includes(selected)) throw new Error(`Unknown runtime suite: ${selected}`);
    const names = selected ? [selected] : suites;
    console.log(`Runtime node:test suites: ${names.join(", ")}`);
    const files = names.map((name) => path.join(build, "tests/runtime", `${name}.test.js`));
    const pattern = process.env.P2O_TEST_RUNTIME_PATTERN;
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files], {
      // Runtime budgets are derived from a measured cold start and scale with host load, so the file cap
      // must exceed the largest legal sum of bounded waits; every individual wait is deadline-bounded.
      stdio: "inherit", env: { ...process.env, P2O_TEST_SOURCE_ROOT: root }, timeout: 900_000,
    });
    process.exitCode = result.status ?? 1;
  }
} finally { await fs.rm(build, { recursive: true, force: true }); }
