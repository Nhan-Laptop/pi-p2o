import { defineConfig } from 'vitest/config';
// Packaging regressions: real filesystem fixtures plus a real Pi CLI extension load/dispatch check.
// No provider/model call, no consent artifact and no target request is made by any case.
export default defineConfig({
  test: { include: ['tests/packaging/**/*.test.ts'], fileParallelism: false, pool: 'forks', maxWorkers: 1, testTimeout: 180_000, hookTimeout: 60_000 },
});
