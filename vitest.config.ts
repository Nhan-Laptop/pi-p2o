import type { UserConfig } from 'vitest/config';
export default {
  test: { include: ['tests/minimal/**/*.test.ts'], environment: 'node', pool: 'forks', maxWorkers: 2, minWorkers: 1, testTimeout: 10_000 },
} satisfies UserConfig;
