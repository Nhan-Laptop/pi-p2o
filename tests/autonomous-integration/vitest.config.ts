import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/autonomous-integration/*.test.ts'], fileParallelism: false, testTimeout: 90000 } });
