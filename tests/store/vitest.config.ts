// Optional external tooling supports this library-only checkout without editing the root package.
export default {
  cacheDir: 'tests/store/.vite-cache',
  resolve: process.env.P2O_VITEST_ENTRY ? { alias: { vitest: process.env.P2O_VITEST_ENTRY } } : {},
  test: {
    include: ['tests/contracts/**/*.test.ts', 'tests/store/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 10_000,
  },
};
