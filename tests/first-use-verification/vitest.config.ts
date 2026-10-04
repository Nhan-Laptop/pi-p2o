import { defineConfig } from 'vitest/config';

// Real-command mechanics with real local Pi/Docker and an explicit inert loopback model. Never a live claim.
export default defineConfig({
  test: {
    include: ['tests/first-use-verification/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 240000,
    hookTimeout: 60000,
  },
});
