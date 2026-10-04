// Root Vitest project for the pi-p2o TypeScript suites.
//
// Discovery contract:
//   * Vitest owns every `*.test.ts` file under the listed suite directories.
//   * Node's built-in `node:test` files (`*.node.ts`) keep their own compiled
//     runners (`tests/tools/run.mjs`, `tests/interface/run.mjs`,
//     `tests/runtime/run.mjs`) and are deliberately not collected here.
//   * `tests/runtime/**/*.test.ts` and `tests/orchestrator/**/*.test.ts` are
//     `node:test` files despite their names, so they are excluded;
//     `npm run test:runtime` runs runtime + sessions; `npm run test:orchestrator`
//     runs the orchestrator tests.
//   * `tests/evidence/*.node.ts` and `tests/reporting/report.node.ts` are a
//     `node:test` suite run by `tests/evidence/run.mjs`
//     (`npm run test:evidence`).
//
// `tests/store/vitest.config.ts` remains valid for library-only checkouts that
// invoke vitest with an externally provisioned entry point; this file is the
// superset used from the repository root.
import type { UserConfig } from 'vitest/config';

export default {
  cacheDir: 'node_modules/.vite/p2o',
  test: {
    include: [
      'tests/contracts/**/*.test.ts',
      'tests/planner/**/*.test.ts',
      'tests/store/**/*.test.ts',
      'tests/orchestrator/**/*.test.ts',
      'tests/reporting/**/*.test.ts',
      'tests/evidence/**/*.test.ts',
      'tests/policy/**/*.test.ts',
      'tests/tools/**/*.test.ts',
      'tests/interface/**/*.test.ts',
      'tests/command/**/*.test.ts',
      'tests/entry/**/*.test.ts',
      'tests/runtime/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/*.node.ts',
      'tests/orchestrator/**/*.test.ts',
      'tests/runtime/**/*.test.ts',
    ],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 10_000,
  },
} satisfies UserConfig;
