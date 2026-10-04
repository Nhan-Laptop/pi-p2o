import type { UserConfig } from 'vitest/config';
export default { test: { include: ['tests/pack-readiness/**/*.test.ts', 'tests/onboarding/**/*.test.ts'], environment: 'node', pool: 'forks', maxWorkers: 2, minWorkers: 1, testTimeout: 15000 } } satisfies UserConfig;
