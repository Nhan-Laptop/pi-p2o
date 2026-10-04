import type { UserConfig } from 'vitest/config';
/** Focused offline suite. Root discovery is owned by integration; no live/provider/target calls here. */
export default {
  cacheDir: 'node_modules/.vite/p2o-onboarding',
  test: { include: ['tests/onboarding/**/*.test.ts', 'tests/command/**/*.test.ts'],
    environment: 'node', pool: 'forks', maxWorkers: 2, minWorkers: 1, testTimeout: 10_000 },
} satisfies UserConfig;
