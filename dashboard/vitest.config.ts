import type { UserConfig } from 'vitest/config';

/** Pure layout/filter/formatting logic only: the dashboard tests never touch the filesystem or a browser. */
export default {
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
} satisfies UserConfig;
