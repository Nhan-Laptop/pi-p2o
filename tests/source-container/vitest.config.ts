import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/source-container/**/*.test.ts'], environment: 'node', pool: 'forks', maxWorkers: 1, minWorkers: 1, testTimeout: 60_000, hookTimeout: 60_000 } });
