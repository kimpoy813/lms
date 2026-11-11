import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globalSetup: ['./tests/setup/global.js'],
    setupFiles: ['./tests/setup/env.js'],
    // All files share one PostgreSQL database, so run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
