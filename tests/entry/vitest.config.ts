// Entry-suite Vitest config: entry-only run (`npx vitest run --config tests/entry/vitest.config.ts`). The
// root vitest project also includes `tests/entry/**/*.test.ts`, so `npm run test:vitest` covers this suite.
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vitest/config';

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite/p2o-entry', import.meta.url)),
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 30_000,
  },
} satisfies UserConfig;
