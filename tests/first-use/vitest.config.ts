import { defineConfig } from 'vitest/config';
// Real-command mechanics with real local Pi/Docker, explicit inert loopback model. Never a live-provider claim.
export default defineConfig({ test: { include: ['tests/first-use/**/*.test.ts'], fileParallelism: false, pool: 'forks', maxWorkers: 1, testTimeout: 90000, hookTimeout: 30000 } });
